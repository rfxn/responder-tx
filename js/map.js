'use strict';

/* ---------- theme ---------- */

// boost variant tracks the surface under it: dark CARTO base gets light-on-dark labels, light/streets get dark-on-light
function labelBoostVariant() {
  return (state.activeBase || document.documentElement.getAttribute('data-theme')) === 'dark' ? 'dark' : 'light';
}
function labelBoostUrl() {
  return `https://{s}.basemaps.cartocdn.com/${labelBoostVariant()}_only_labels/{z}/{x}/{y}{r}.png`;
}
function syncLabelBoost() {
  state.layers.labelBoost.setUrl(labelBoostUrl());
  state.map.getPane('labels').classList.toggle('boost-dark', labelBoostVariant() === 'dark');
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('respondertx.theme', theme);
  $('#theme-toggle').innerHTML = theme === 'dark'
    ? `☀️ <span class="ctl-lbl">${esc(t('ctl.theme.light'))}</span>`
    : `🌙 <span class="ctl-lbl">${esc(t('ctl.theme.dark'))}</span>`;
  if (state.map) {
    // Streets base is theme-neutral: keep it in place, theme then only affects UI chrome
    if (state.activeBase !== 'streets' && state.activeBase !== theme) {
      Object.values(state.baseLayers).forEach((l) => state.map.removeLayer(l));
      state.baseLayers[theme].addTo(state.map);
      state.activeBase = theme;
    }
    syncLabelBoost();
  }
}

/* ---------- offline tiles (IndexedDB — works on plain LAN http, no Service Worker) ---------- */

// Basemap tiles only. Data (gauges/alerts) is never cached — staleness stays governed by the data-age bar.
const OFFLINE_TILE_CAP = 1500; // per-save ceiling — respects CARTO/OSM usage; over cap → user zooms in

const OfflineTiles = (() => {
  const DB = 'respondertx-offline', STORE = 'tiles';
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      let rq;
      try { rq = indexedDB.open(DB, 1); } catch (e) { reject(e); return; }
      rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(STORE)) rq.result.createObjectStore(STORE); };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
    return dbp;
  }
  const run = (mode, fn) => db().then((d) => new Promise((resolve, reject) => {
    const store = d.transaction(STORE, mode).objectStore(STORE);
    const rq = fn(store);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  }));
  return {
    available: () => typeof indexedDB !== 'undefined',
    get: (key) => run('readonly', (s) => s.get(key)).then((v) => v || null),
    has: (key) => run('readonly', (s) => s.count(key)).then((n) => n > 0),
    put: (key, blob) => run('readwrite', (s) => s.put(blob, key)),
    count: () => run('readonly', (s) => s.count()),
    clear: () => run('readwrite', (s) => s.clear()),
  };
})();

// Cache-first tile layer: serves a stored blob when present, else the network; the template
// string namespaces keys so each base (and each label variant via setUrl) has its own tiles.
const OfflineTileLayer = L.TileLayer.extend({
  initialize(url, options) {
    L.TileLayer.prototype.initialize.call(this, url, options);
    this.on('tileunload', (e) => {
      if (e.tile && e.tile._objurl) { URL.revokeObjectURL(e.tile._objurl); e.tile._objurl = null; }
    });
  },
  offlineKey(coords) { return `${this._url}|${coords.z}/${coords.x}/${coords.y}`; },
  createTile(coords, done) {
    const tile = document.createElement('img');
    tile.setAttribute('role', 'presentation');
    tile.alt = '';
    L.DomEvent.on(tile, 'load', L.Util.bind(this._tileOnLoad, this, done, tile));
    L.DomEvent.on(tile, 'error', L.Util.bind(this._tileOnError, this, done, tile));
    const netUrl = this.getTileUrl(coords);
    OfflineTiles.get(this.offlineKey(coords)).then((blob) => {
      if (blob) { tile._objurl = URL.createObjectURL(blob); tile.src = tile._objurl; }
      else { tile.src = netUrl; }
    }).catch(() => { tile.src = netUrl; });
    return tile;
  },
});

function offlineTile(url, opts) { return new OfflineTileLayer(url, opts); }

// getTileUrl() locks z to the layer's live zoom, so build save URLs directly to reach z+1
function offlineTileUrl(layer, c) {
  const subs = layer.options.subdomains || 'abc';
  return L.Util.template(layer._url, { s: subs[Math.abs(c.x + c.y) % subs.length], x: c.x, y: c.y, z: c.z, r: '' });
}

function activeOfflineLayers() {
  const out = [];
  state.map.eachLayer((l) => { if (l instanceof OfflineTileLayer) out.push(l); });
  return out;
}

function viewportTileCoords(z) {
  const b = state.map.getBounds();
  const nw = state.map.project(b.getNorthWest(), z).divideBy(256).floor();
  const se = state.map.project(b.getSouthEast(), z).divideBy(256).floor();
  const out = [];
  for (let x = nw.x; x <= se.x; x++) for (let y = nw.y; y <= se.y; y++) out.push({ x, y, z });
  return out;
}

function refreshOfflineStatus() {
  return OfflineTiles.count().then((n) => {
    const s = $('#off-status');
    if (s) { s.textContent = n > 0 ? `✓ ${n} tiles saved` : 'No tiles saved yet'; s.classList.remove('over'); }
    const clr = $('#off-clear');
    if (clr) clr.hidden = n === 0;
    const toggle = $('#off-toggle');
    if (toggle) toggle.classList.toggle('has-cache', n > 0); // subtle filled state when something is cached
    return n;
  }).catch(() => {});
}

async function saveViewportOffline() {
  const layers = activeOfflineLayers();
  const statusEl = $('#off-status');
  if (!layers.length || !statusEl) return;
  const z0 = state.map.getZoom();
  const maxZ = Math.min(...layers.map((l) => l.options.maxZoom || 19));
  // owner: expand offline depth — cache this zoom + up to two deeper for usable offline zoom-in
  const zooms = [z0, z0 + 1, z0 + 2].filter((z) => z <= maxZ);
  const jobs = [];
  for (const z of zooms) for (const c of viewportTileCoords(z)) for (const l of layers) jobs.push({ l, c });
  if (jobs.length > OFFLINE_TILE_CAP) {
    statusEl.textContent = `This area needs ${jobs.length} tiles (cap ${OFFLINE_TILE_CAP}); zoom in, then save`;
    statusEl.classList.add('over');
    return;
  }
  const saveBtn = document.querySelector('.off-save');
  if (saveBtn) saveBtn.disabled = true;
  statusEl.classList.remove('over');
  let done = 0;
  let idx = 0;
  const worker = async () => {
    while (idx < jobs.length) {
      const { l, c } = jobs[idx++];
      const key = l.offlineKey(c);
      try {
        if (!(await OfflineTiles.has(key))) {
          const r = await fetch(offlineTileUrl(l, c), { mode: 'cors' });
          if (r.ok) await OfflineTiles.put(key, await r.blob());
        }
      } catch (e) { /* skip unreachable/blocked tile — partial cache is still useful offline */ }
      statusEl.textContent = `Saving ${++done}/${jobs.length}…`;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (saveBtn) saveBtn.disabled = false;
  const total = await refreshOfflineStatus();
  statusEl.textContent = `✓ ${total} tiles saved (${zooms.length} zoom levels) · available offline`;
}

async function clearOfflineCache() {
  try { await OfflineTiles.clear(); } catch (e) { /* ignore — nothing to clear */ }
  await refreshOfflineStatus();
  const s = $('#off-status');
  if (s) s.textContent = 'Offline cache cleared';
}

function initOfflineControl() {
  if (!OfflineTiles.available()) return;
  const ctl = L.control({ position: 'bottomleft' });
  ctl.onAdd = () => {
    const div = L.DomUtil.create('div', 'offline-ctl');
    // subtle by default: a small ⬇ toggle; the panel (save/status/clear) expands only on tap
    div.innerHTML = '<button class="off-toggle" id="off-toggle" title="Offline map: save this area to view with no signal">⬇</button>' +
      '<div class="off-panel" id="off-panel" hidden>' +
      '<div class="off-panel-head">Offline map</div>' +
      '<button class="off-save" title="Cache the current view + 2 deeper zooms for use with no signal">⬇ Save this area</button>' +
      '<div class="off-status" id="off-status">…</div>' +
      '<div class="off-note">Basemap only; live gauge/alert data still needs a connection.</div>' +
      '<button class="off-clear" id="off-clear" hidden>Clear offline cache</button>' +
      '</div>';
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    L.DomEvent.on(div.querySelector('#off-toggle'), 'click', () => {
      const p = div.querySelector('#off-panel');
      p.hidden = !p.hidden;
      div.querySelector('#off-toggle').classList.toggle('open', !p.hidden);
    });
    L.DomEvent.on(div.querySelector('.off-save'), 'click', saveViewportOffline);
    L.DomEvent.on(div.querySelector('#off-clear'), 'click', clearOfflineCache);
    return div;
  };
  ctl.addTo(state.map);
  refreshOfflineStatus();
}

/* ---------- ArcGIS dynamic-export overlay (per-tile bbox) ---------- */

// Consumes an ArcGIS MapServer `export` endpoint as XYZ tiles: each tile's Web-Mercator
// bbox is appended per request. Used for the NWM inundation overlay (no esri-leaflet dep).
// Kept off the OfflineTileLayer path on purpose — this is live model DATA, never cached.
const ArcGISExportLayer = L.TileLayer.extend({
  getTileUrl(coords) {
    const b = this._tileCoordsToBounds(coords);
    const sw = L.CRS.EPSG3857.project(b.getSouthWest());
    const ne = L.CRS.EPSG3857.project(b.getNorthEast());
    const bbox = [sw.x, sw.y, ne.x, ne.y].join(',');
    return `${this._url}&bbox=${bbox}&_t=${Math.floor(Date.now() / 3600000)}`; // hourly cache-bust
  },
});

/* ---------- map ---------- */

function initMap() {
  state.map = L.map('map', { zoomControl: false }).setView(CONFIG.center, CONFIG.zoom);
  // collapse the attribution bar to a tap-to-open ⓘ — it otherwise crowds the legend on short screens; OSM/CARTO/TxDOT credits stay one tap away (ToS + source-citation intact)
  state.map.attributionControl.setPrefix('<span class="attr-i" title="Map & data sources">ⓘ</span>');
  const attrEl = state.map.attributionControl.getContainer();
  L.DomEvent.on(attrEl, 'click', (e) => { if (e.target.tagName === 'A') return; L.DomEvent.stop(e); attrEl.classList.toggle('attr-open'); });
  const attrib = '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
  state.baseLayers.dark = offlineTile('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: attrib, maxZoom: 19 });
  state.baseLayers.light = offlineTile('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: attrib, maxZoom: 19 });
  state.baseLayers.streets = offlineTile('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19 });

  // label boost pane: above radar (350) and alert polygons (400), below markers (600)
  state.map.createPane('labels');
  state.map.getPane('labels').style.zIndex = 450;
  state.map.getPane('labels').style.pointerEvents = 'none';
  // radar pane: control autoZIndex raises base layers above tilePane radar, so radar needs its own pane
  state.map.createPane('radar');
  state.map.getPane('radar').style.zIndex = 350;
  state.map.getPane('radar').style.pointerEvents = 'none';
  state.layers.labelBoost = offlineTile(labelBoostUrl(), { pane: 'labels', attribution: attrib, maxZoom: 19 }).addTo(state.map);

  const bustSrc = (url) => url + '?_=' + Math.floor(Date.now() / 300000);
  // all radar/rainfall layers are OFF by default (owner directive) — explicit enable via layer control
  // group of pre-loaded per-frame tile layers; playback crossfades opacity (no per-step tile reload)
  state.layers.radar = L.layerGroup();
  state.layers.mrms1h = L.tileLayer(bustSrc(CONFIG.mrms1hUrl), { opacity: 0.55, attribution: 'Rainfall: MRMS via IEM' });
  state.layers.mrms24h = L.tileLayer(bustSrc(CONFIG.mrms24hUrl), { opacity: 0.55, attribution: 'Rainfall: MRMS via IEM' });
  // MODELED flood extent (not observed) — off by default (hazard layers explicit-enable, owner directive)
  state.layers.inundation = new ArcGISExportLayer(CONFIG.inunExportUrl, {
    opacity: 0.72, maxZoom: 19,
    attribution: 'Flood inundation: NWM analysis (experimental) &copy; NOAA/NWPS',
  });
  state.inunBucket = Math.floor(Date.now() / 3600000);
  state.refreshRadar = () => {
    state.layers.mrms1h.setUrl(bustSrc(CONFIG.mrms1hUrl));
    state.layers.mrms24h.setUrl(bustSrc(CONFIG.mrms24hUrl));
    if (state.map.hasLayer(state.layers.radar)) fetchRadarFrames().catch(() => { /* keep last frames */ });
    const bucket = Math.floor(Date.now() / 3600000); // inundation updates hourly — redraw only on the hour
    if (bucket !== state.inunBucket) {
      state.inunBucket = bucket;
      if (state.map.hasLayer(state.layers.inundation)) state.layers.inundation.redraw();
    }
  };
  const updateMrmsLegend = () => {
    const on1 = state.map.hasLayer(state.layers.mrms1h), on24 = state.map.hasLayer(state.layers.mrms24h);
    $('#mrms-legend').hidden = !(on1 || on24);
    if (on1 || on24) $('#mrms-legend-title').textContent = `Rainfall accumulation ${on1 && on24 ? '1h + 24h' : on1 ? '1h' : '24h'} (MRMS)`;
  };
  state.map.on('overlayadd', (e) => {
    if (e.layer === state.layers.mrms1h || e.layer === state.layers.mrms24h) updateMrmsLegend();
    if (e.layer === state.layers.inundation) $('#inun-legend').hidden = false;
    if (e.layer === state.layers.lwc) fetchLwc();
    if (e.layer === state.layers.cameras) loadCameras().catch(() => { $('#refresh-note').textContent = 'camera inventory unavailable'; });
    if (e.layer !== state.layers.radar) return;
    $('#radar-scrub').hidden = false;
    fetchRadarFrames().catch(() => { $('#rs-label').textContent = 'radar feed unavailable'; });
  });
  state.map.on('overlayremove', (e) => {
    if (e.layer === state.layers.mrms1h || e.layer === state.layers.mrms24h) updateMrmsLegend();
    if (e.layer === state.layers.inundation) $('#inun-legend').hidden = true;
    if (e.layer !== state.layers.radar) return;
    $('#radar-scrub').hidden = true;
    stopRadarPlay();
  });

  state.map.on('baselayerchange', (e) => {
    state.activeBase = e.layer === state.baseLayers.streets ? 'streets'
      : e.layer === state.baseLayers.light ? 'light' : 'dark';
    localStorage.setItem('respondertx.base', state.activeBase);
    // picking a CARTO base re-syncs the UI theme; Streets leaves the theme untouched
    if (state.activeBase !== 'streets' && state.activeBase !== document.documentElement.getAttribute('data-theme')) applyTheme(state.activeBase);
    else syncLabelBoost();
  });
  // default base is Streets (owner directive); saved choice or ?base= overrides — layer control not built yet, set directly
  const baseParam = new URLSearchParams(location.search).get('base');
  const wantBase = baseParam === 'osm' ? 'streets'
    : (baseParam in state.baseLayers ? baseParam : null) || localStorage.getItem('respondertx.base') || 'streets';
  state.activeBase = wantBase in state.baseLayers ? wantBase : 'streets';
  state.baseLayers[state.activeBase].addTo(state.map);

  state.layers.alerts = L.layerGroup().addTo(state.map);
  state.layers.gauges = L.layerGroup().addTo(state.map);
  state.layers.fcstMax = L.layerGroup().addTo(state.map);
  // clustered — off by default; degrade to a plain group if the vendored plugin failed to load
  state.layers.usgs = L.markerClusterGroup
    ? L.markerClusterGroup({ disableClusteringAtZoom: 10, maxClusterRadius: 40 })
    : L.layerGroup();
  state.layers.lsrs = L.layerGroup().addTo(state.map);
  state.layers.lsrsAged = L.layerGroup(); // history layer — off by default, toggle in layer control
  state.layers.requests = L.layerGroup().addTo(state.map);
  state.layers.shelters = L.layerGroup().addTo(state.map);
  state.layers.crossings = L.layerGroup().addTo(state.map);
  // TDEM DriveTexas live road conditions — flood-relevant subset only, first-class toggle (owner request), on by default
  state.layers.roadClosures = L.layerGroup().addTo(state.map);
  // TxGIO low-water-crossing location inventory — OFF by default, lazy-loaded, canvas-rendered; LOCATIONS, not live status
  state.layers.lwc = L.layerGroup();
  // road & river cameras — OFF by default, lazy-loaded, clustered (~650 markers); plain group if the plugin failed
  state.layers.cameras = L.markerClusterGroup
    ? L.markerClusterGroup({ disableClusteringAtZoom: 12, maxClusterRadius: 46 })
    : L.layerGroup();
  L.control.layers({
    'Dark (CARTO)': state.baseLayers.dark,
    'Light (CARTO)': state.baseLayers.light,
    'Streets (OSM)': state.baseLayers.streets,
  }, {
    'Place labels (boost)': state.layers.labelBoost,
    'Radar scrub (-1h → +30m)': state.layers.radar,
    'Rainfall 1h (MRMS)': state.layers.mrms1h,
    'Rainfall 24h (MRMS)': state.layers.mrms24h,
    'Flood inundation: NWM model (est.)': state.layers.inundation,
    'Flood alerts (NWS)': state.layers.alerts,
    'River gauges (NOAA)': state.layers.gauges,
    'Forecast crests (RFC max)': state.layers.fcstMax,
    'USGS gauges (raw stage)': state.layers.usgs,
    'Storm reports (LSR)': state.layers.lsrs,
    'Aged storm reports (history)': state.layers.lsrsAged,
    'Notices (curated + field)': state.layers.requests,
    'Shelters': state.layers.shelters,
    'Low-water crossings': state.layers.crossings,
    'Road closures / high water (TxDOT)': state.layers.roadClosures,
    'Low-water crossings (locations · not live status)': state.layers.lwc,
    'Cameras: road & river (TxDOT/USGS)': state.layers.cameras,
  }, { collapsed: true }).addTo(state.map);

  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'map-legend');
    div.innerHTML = '<div class="lg-title">River gauge status</div>' +
      ['major', 'moderate', 'minor', 'action', 'none'].map((c) => {
        const s = Math.max(9, CAT_SIZE[c] - 3);
        return `<div><span class="sw gauge-icon cat-${c}" style="width:${s}px;height:${s}px"></span>${esc(CAT_LABEL[c])}</div>`;
      }).join('') +
      '<div><span class="sw" style="width:10px">▲</span>forecast to rise</div>' +
      '<div><span class="sw" style="width:10px;color:var(--good)">▼</span>observed falling</div>' +
      '<div><span class="sw fcst-ring cat-moderate" style="width:10px;height:10px"></span>forecast crest (RFC)</div>' +
      '<div class="lg-title" style="margin-top:6px">Roads (DriveTexas)</div>' +
      ['Closure', 'Flooding', 'Damage'].map((k) => {
        const rc = ROAD_COND[k];
        return `<div><span class="sw sw-line" style="background:${rc.color}"></span>${esc(rc.label)}</div>`;
      }).join('') +
      '<div class="lg-title" style="margin-top:6px">Reports & notices</div>' +
      '<div><span style="margin-right:6px">💧</span>storm report (LSR)</div>' +
      '<div><span style="margin-right:6px">🆘</span>marker glyph = need type</div>';
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div); // scrolling the (now scrollable) expanded legend must not zoom the map
    L.DomEvent.on(div, 'click', () => div.classList.toggle('open')); // mobile: collapsed to title pill by default
    return div;
  };
  legend.addTo(state.map);
  initOfflineControl();

  state.map.on('click', (e) => {
    if (!$('#new-request-form').classList.contains('open')) return;
    state.pendingLatLng = e.latlng;
    $('#f-latlon').value = `${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`;
  });

  // one bar for + / − / ⌖ — two stacked boxes read as clutter over the NW warning polygons
  const gpsWait = window.gpsWait = (on) => {
    const btn = document.querySelector('.locate-btn');
    if (btn) btn.classList.toggle('locating', on);
    const chip = $('#gps-wait');
    if (chip) chip.hidden = !on;
  };
  const NavControl = L.Control.Zoom.extend({
    onAdd(map) {
      const bar = L.Control.Zoom.prototype.onAdd.call(this, map);
      const a = L.DomUtil.create('a', 'locate-btn', bar);
      a.href = '#'; a.title = 'My location'; a.textContent = '⌖';
      L.DomEvent.on(a, 'click', (e) => {
        L.DomEvent.stop(e);
        gpsWait(true);
        map.locate({ enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 });
      });
      return bar;
    },
  });
  state.map.addControl(new NavControl({ position: 'topleft' }));
  initAoJump();
  state.map.on('locationfound', (e) => {
    gpsWait(false);
    state.myPos = e.latlng;
    if (state.posLayer) state.map.removeLayer(state.posLayer);
    state.posLayer = L.layerGroup([
      L.circle(e.latlng, { radius: e.accuracy, weight: 1, color: cssVar('--accent') || '#3987e5', fillOpacity: 0.08 }),
      L.marker(e.latlng, {
        icon: L.divIcon({
          className: '',
          html: '<div class="my-pos-wrap"><div class="my-pos-ring"></div><div class="my-pos-ring d2"></div><div class="my-pos-core"></div><div class="my-pos-label">YOU</div></div>',
          iconSize: [48, 48], iconAnchor: [24, 24],
        }),
        title: 'Your location', zIndexOffset: 2000, interactive: false,
      }),
    ]).addTo(state.map);
    state.map.setView(e.latlng, Math.max(state.map.getZoom(), 12));
    renderRequests();
    renderDriveMode(); // re-rank the glance list by the new fix
  });
  state.map.on('locationerror', () => {
    gpsWait(false);
    $('#refresh-note').textContent = 'location unavailable (permission or no GPS)';
  });

  const declutter = () => state.map.getContainer().classList.toggle('z-low', state.map.getZoom() < 9);
  state.map.on('zoomend', declutter);
  declutter();
}

/* ---------- AO quick-jump — pills along the map top edge, never another stacked box ---------- */

const AO_PRESETS = [
  ['Full AO', [[28.0, -102.0], [31.1, -97.0]]],
  ['Kerr/Guadalupe', [[29.85, -99.6], [30.2, -98.9]]],
  ['Uvalde/Frio-Nueces', [[28.9, -100.1], [29.6, -99.4]]],
  ['Val Verde/Pecos', [[29.3, -101.9], [30.35, -100.8]]],
  ['Sonora/Ozona', [[30.3, -101.4], [30.95, -100.3]]],
  ['Cibolo corridor', [[28.9, -98.4], [29.4, -97.9]]],
];

function initAoJump() {
  const jump = L.DomUtil.create('div', 'ao-jump', state.map.getContainer());
  const tog = L.DomUtil.create('button', 'ao-toggle', jump);
  tog.textContent = '🗺'; tog.title = 'Area quick-jump presets';
  L.DomEvent.on(tog, 'click', () => jump.classList.toggle('open'));
  for (const [label, bounds] of AO_PRESETS) {
    const b = L.DomUtil.create('button', 'ao-chip', jump);
    b.textContent = label;
    L.DomEvent.on(b, 'click', () => state.map.fitBounds(bounds));
  }
  L.DomEvent.disableClickPropagation(jump);
  L.DomEvent.disableScrollPropagation(jump);
}

/* ---------- radar time-scrub (RainViewer: past ~1h + nowcast projection when published) ---------- */

async function fetchRadarFrames() {
  const res = await fetch(CONFIG.rainviewerApi);
  if (!res.ok) throw new Error(`RainViewer HTTP ${res.status}`);
  const d = await res.json();
  const past = (d.radar && d.radar.past) || []; // full published history (~2h @ 10-min steps)
  const cast = (d.radar && d.radar.nowcast) || [];
  if (!past.length) throw new Error('no radar frames');
  const keepIdx = state.radar ? state.radar.idx : -1;
  const wasPlaying = state.radar && state.radar.playing;
  stopRadarPlay();
  state.radar = { host: d.host, frames: past.concat(cast), castStart: past.length, nowIdx: past.length - 1, idx: past.length - 1, playing: false, timer: null, frameLayers: [] };
  const r = state.radar;
  state.layers.radar.clearLayers();
  r.frameLayers = r.frames.map((f) => L.tileLayer(`${r.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, {
    pane: 'radar', opacity: 0, maxNativeZoom: 7, maxZoom: 19, updateWhenIdle: false, attribution: 'Radar: RainViewer',
  }));
  r.frameLayers.forEach((l) => state.layers.radar.addLayer(l)); // all mounted once — playback is opacity-only
  $('#rs-slider').max = r.frames.length - 1;
  const rf = parseInt(new URLSearchParams(location.search).get('rf'), 10); // debug/deep-link: initial frame index
  setRadarFrame(keepIdx >= 0 && keepIdx < r.frames.length ? keepIdx
    : rf >= 0 && rf < r.frames.length ? rf : r.nowIdx);
  if (wasPlaying) toggleRadarPlay();
}

function setRadarFrame(i) {
  const r = state.radar;
  if (!r || !r.frames.length) return;
  r.idx = Math.max(0, Math.min(i, r.frames.length - 1));
  r.frameLayers.forEach((l, j) => l.setOpacity(j === r.idx ? 0.75 : 0)); // 0.75: 0.6 washed out over the bright Streets base
  $('#rs-slider').value = r.idx;
  const dMin = Math.round((r.frames[r.idx].time - r.frames[r.nowIdx].time) / 60);
  const projected = r.idx >= r.castStart;
  const label = $('#rs-label');
  label.textContent = dMin === 0 ? 'now' : dMin < 0 ? `${dMin >= -110 ? dMin + 'm' : Math.round(dMin / 6) / 10 + 'h'}` : `+${dMin}m PROJECTED`;
  label.classList.toggle('projected', projected);
  if (r.castStart >= r.frames.length && dMin === 0) label.textContent = 'now · no future-cast in free feed';
}

function stopRadarPlay() {
  if (state.radar && state.radar.timer) { clearInterval(state.radar.timer); state.radar.timer = null; state.radar.playing = false; }
  $('#rs-play').textContent = '▶';
}

function toggleRadarPlay() {
  const r = state.radar;
  if (!r) return;
  if (r.playing) { stopRadarPlay(); return; }
  r.playing = true;
  $('#rs-play').textContent = '⏸';
  r.timer = setInterval(() => setRadarFrame((r.idx + 1) % r.frames.length), 700);
}

/* ---------- historical playback (v0.82) — replay archived gauge frames over 3d/7d/14d ----------
   Honest by design: only layers with a real archive replay (gauges from data/history.json,
   radar from IEM archive tiles); alerts/roads/LSRs stay live and the bar says so. */

const PB_RADAR_URL = (stamp) => `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-${stamp}/{z}/{x}/{y}.png`;
const PB_BASE_FRAME_MS = 500; // 1x is ~2 fps — slow enough to read the story (owner ask)
const PB_SPEEDS = [0.5, 1, 2, 4];
const PB_CAT_NAMES = ['none', 'action', 'minor', 'moderate', 'major'];

/* archived NWS storm-based warnings — OFFICIAL products via IEM sbw.geojson (CORS-open).
   Cached per 15-min bucket (LRU); each poly's polygon_begin/end governs per-frame visibility,
   so frames between fetches honestly reuse the cached set. */
const PB_SBW_URL = (iso) => `https://mesonet.agron.iastate.edu/geojson/sbw.geojson?ts=${encodeURIComponent(iso)}`;
const PB_SBW_BUCKET_MS = 900000;
const PB_SBW_LRU = 40;
const PB_SBW_FLOOD = ['FF', 'FA', 'FL'];
const pbSbw = { buckets: new Map(), inflight: new Map(), warnEvents: new Map(), renderKey: '', visibleN: null };

function pbSbwSev(p) {
  if (p.phenomena === 'SV' || p.phenomena === 'TO') return p.phenomena.toLowerCase();
  if (p.is_emergency) return 'emergency';
  return p.significance === 'Y' ? 'advisory' : 'warning';
}

function pbSbwInAO(geom) {
  const b = CONFIG.gaugeBbox, pad = 0.3;
  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); }
    else c.forEach(walk);
  };
  try { walk(geom.coordinates); } catch { return false; }
  return e >= b.xmin - pad && w <= b.xmax + pad && n >= b.ymin - pad && s <= b.ymax + pad;
}

const pbSbwKey = (p) => `${p.wfo}|${p.phenomena}|${p.significance}|${p.eventid}|${p.year}`;

function pbSbwStore(bucket, features) {
  const keep = [];
  for (const f of features) {
    const p = f.properties || {};
    const flood = PB_SBW_FLOOD.includes(p.phenomena);
    if (!flood && p.phenomena !== 'SV' && p.phenomena !== 'TO') continue;
    if (!f.geometry || !pbSbwInAO(f.geometry)) continue;
    f._b0 = new Date(p.polygon_begin || p.issue).getTime();
    f._b1 = new Date(p.polygon_end || p.expire).getTime();
    keep.push(f);
    if (flood) {
      const k = pbSbwKey(p);
      const ev = pbSbw.warnEvents.get(k) || { issue: Infinity, expire: -Infinity, ps: p.ps, wfo: p.wfo };
      ev.issue = Math.min(ev.issue, new Date(p.issue).getTime());
      ev.expire = Math.max(ev.expire, new Date(p.expire).getTime());
      pbSbw.warnEvents.set(k, ev);
    }
  }
  pbSbw.buckets.set(bucket, keep);
  while (pbSbw.buckets.size > PB_SBW_LRU) pbSbw.buckets.delete(pbSbw.buckets.keys().next().value);
  pbStoryRebuild();
  return keep;
}

function pbSbwFetch(bucket) {
  if (pbSbw.inflight.has(bucket)) return pbSbw.inflight.get(bucket);
  const iso = new Date(bucket).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const p = fetch(PB_SBW_URL(iso))
    .then((r) => { if (!r.ok) throw new Error(`sbw HTTP ${r.status}`); return r.json(); })
    .then((d) => pbSbwStore(bucket, d.features || []))
    .finally(() => pbSbw.inflight.delete(bucket));
  pbSbw.inflight.set(bucket, p);
  return p;
}

// dragging debounces to settle (never per-pixel); play fetches at most one bucket at a time
function pbSbwSchedule() {
  const pb = state.pb;
  if (!pb || pb.live) return;
  pbSbwRender(); // whatever cached polys cover this frame, immediately
  const bucket = Math.floor(state.pbData.frames[pb.idx]._t / PB_SBW_BUCKET_MS) * PB_SBW_BUCKET_MS;
  if (pbSbw.buckets.has(bucket)) {
    const v = pbSbw.buckets.get(bucket);
    pbSbw.buckets.delete(bucket); pbSbw.buckets.set(bucket, v); // LRU touch
    return;
  }
  clearTimeout(pb.sbwTimer);
  if (pb.playing && pbSbw.inflight.size) return; // stay polite to IEM at 2-8 fps
  pb.sbwTimer = setTimeout(() => {
    pbSbwFetch(bucket)
      .then(() => { if (state.pb && !state.pb.live) { pbSbwRender(); pbUpdateHud(); } })
      .catch(() => { /* archive fetch failed — warning polys simply absent for this bucket */ });
  }, pb.playing ? 0 : 250);
}

function pbSbwRender() {
  const pb = state.pb;
  if (!pb || pb.live || !state.layers.pbAlerts) return;
  const ft = state.pbData.frames[pb.idx]._t;
  const best = new Map(); // per warning: the cached copy from the bucket nearest the frame
  for (const [bk, feats] of pbSbw.buckets) {
    const d = Math.abs(bk - ft);
    for (const f of feats) {
      if (!(f._b0 <= ft && ft <= f._b1)) continue;
      const k = pbSbwKey(f.properties);
      const cur = best.get(k);
      if (!cur || d < cur.d) best.set(k, { f, d });
    }
  }
  pbSbw.visibleN = pbSbw.buckets.size ? best.size : null;
  const key = Array.from(best.keys()).sort().join(',');
  if (key === pbSbw.renderKey) return;
  pbSbw.renderKey = key;
  state.layers.pbAlerts.clearLayers();
  const order = { advisory: 0, sv: 1, to: 2, warning: 3, emergency: 4 }; // most severe drawn last, lands on top
  const feats = Array.from(best.values()).map((x) => x.f)
    .sort((a, b) => (order[pbSbwSev(a.properties)] || 0) - (order[pbSbwSev(b.properties)] || 0));
  for (const f of feats) {
    const sev = pbSbwSev(f.properties);
    const storm = sev === 'sv' || sev === 'to';
    const layer = L.geoJSON({ type: 'Feature', geometry: f.geometry }, {
      style: {
        className: `alert-poly pb-alert-poly sev-${sev}`,
        weight: sev === 'emergency' ? 2.5 : 1.5,
        fillOpacity: sev === 'emergency' ? 0.22 : storm ? 0.06 : 0.10,
        opacity: 0.9,
        dashArray: storm ? '6 4' : null,
      },
    });
    layer.bindPopup(() => pbSbwPopup(f.properties));
    state.layers.pbAlerts.addLayer(layer);
  }
}

function pbSbwPopup(p) {
  const sev = pbSbwSev(p);
  return `<div class="popup-title">${esc(p.ps || 'NWS warning')}${sev === 'emergency' ? ': <span style="color:var(--sev-emergency);font-weight:700">FLASH FLOOD EMERGENCY</span>' : ''}</div>` +
    `<div class="popup-meta">NWS ${esc(p.wfo || '')} · ${esc(fmtCT(p.polygon_begin || p.issue))} → ${esc(fmtCT(p.polygon_end || p.expire))}</div>` +
    `<div class="popup-meta">${srcBadge('official')} ${esc(t('playback.warnarchive'))}</div>` +
    `<div class="popup-meta" style="color:var(--sev-warning);font-weight:700">⏮ ${esc(t('playback.pill'))} · ${esc(fmtCT(state.pbData.frames[state.pb.idx].t))}</div>` +
    (p.href ? `<div class="popup-link"><a href="${safeUrl(p.href)}" target="_blank" rel="noopener">IEM product page →</a></div>` : '');
}

// frame code: 0..4 = none..major; negative = stale observation, encoded -(code+1)
function pbDecode(code) {
  const stale = code < 0;
  return { stale, cat: PB_CAT_NAMES[stale ? -code - 1 : code] || 'none' };
}

async function loadPlaybackData() {
  if (state.pbData) return state.pbData;
  const res = await fetch(`data/history.json?_=${Math.floor(Date.now() / 300000)}`);
  if (!res.ok) throw new Error(`history HTTP ${res.status}`);
  const d = await res.json();
  if (!Array.isArray(d.frames) || !d.frames.length) throw new Error('empty history');
  d.frames.forEach((f) => { f._t = new Date(f.t).getTime(); });
  state.pbData = d;
  // chapter marks: major-peak gauges from the crest summary, most significant first (best-effort)
  try {
    const cs = await fetch(`data/crest-summary.json?_=${Math.floor(Date.now() / 300000)}`).then((r) => (r.ok ? r.json() : null));
    state.pbCrests = (cs && cs.gauges) || [];
    state.pbChapters = state.pbCrests.filter((g) => g.peak_category === 'major').slice(0, 8);
  } catch { state.pbCrests = []; state.pbChapters = []; }
  return d;
}

/* story engine — gauge category transitions (frame diffs) + moderate/major crests (crest summary)
   + warning lifecycle (SBW cache) + road reopenings (this device's DriveTexas store), merged into
   one time-sorted caption track. Derived data only, nothing interpolated. */
function pbBuildStory() {
  const frames = state.pbData.frames, pb = state.pb;
  const ev = [];
  const first = pbFirstIdx();
  for (let i = first + 1; i < frames.length; i++) {
    const cur = frames[i], prev = frames[i - 1];
    for (const [lid, rec] of Object.entries(cur.gauges)) {
      const p = prev.gauges[lid];
      if (!p || rec[1] < 0 || p[1] < 0 || rec[1] === p[1]) continue; // stale obs: no honest transition
      const gi = state.pbData.gaugeIndex[lid];
      if (!gi) continue;
      const up = rec[1] > p[1];
      ev.push({
        t: cur._t, iso: cur.t, pri: rec[1],
        text: t(up ? 'playback.story.rise' : 'playback.story.fall')
          .replace('{name}', gi.name).replace('{cat}', catLabel(PB_CAT_NAMES[rec[1]])).replace('{v}', rec[0]),
      });
    }
  }
  for (const g of state.pbCrests || []) {
    if (g.stale || !['moderate', 'major'].includes(g.peak_category)) continue;
    const pt = new Date(g.peak_time).getTime();
    if (!(pt >= pb.loT && pt <= pb.hiT)) continue;
    let txt = t('playback.story.crest').replace('{name}', g.name).replace('{v}', g.peak);
    const r = g.record;
    if (r && r.record_ft > 0) {
      txt += t(r.exceeded ? 'playback.story.recordover' : 'playback.story.record')
        .replace('{p}', r.peak_pct).replace('{y}', String(r.record_date || '').slice(0, 4));
    }
    ev.push({ t: pt, iso: g.peak_time, pri: 6, text: txt });
  }
  try {
    for (const r of Object.values(roadMemory().reopened)) {
      const rt = new Date(r.reopenedAt).getTime();
      if (!(rt >= pb.loT && rt <= pb.hiT)) continue;
      ev.push({ t: rt, iso: r.reopenedAt, pri: 3, text: t('playback.story.reopen').replace('{road}', prettyRoute(r.route_name) || 'road') });
    }
  } catch { /* road memory unavailable — reopen captions simply absent */ }
  state.pbStoryBase = ev;
  pbStoryRebuild();
}

function pbStoryRebuild() {
  const pb = state.pb;
  if (!pb || !state.pbStoryBase) return;
  const ev = state.pbStoryBase.slice();
  for (const w of pbSbw.warnEvents.values()) {
    if (w.issue >= pb.loT && w.issue <= pb.hiT) {
      ev.push({ t: w.issue, iso: new Date(w.issue).toISOString(), pri: 5, text: t('playback.story.warnissued').replace('{ps}', w.ps || 'NWS warning').replace('{wfo}', w.wfo || 'AO') });
    }
    if (w.expire >= pb.loT && w.expire <= pb.hiT) {
      ev.push({ t: w.expire, iso: new Date(w.expire).toISOString(), pri: 2, text: t('playback.story.warnexpired').replace('{ps}', w.ps || 'NWS warning').replace('{wfo}', w.wfo || 'AO') });
    }
  }
  ev.sort((a, b) => a.t - b.t || a.pri - b.pri); // equal-time ties: highest significance last, wins nearest-past
  state.pbStory = ev;
  if (!pb.live) pbUpdateCaption(); // capKey change-detection keeps an unchanged caption from re-flashing
}

function pbUpdateCaption() {
  const pb = state.pb, el = $('#pb-caption');
  if (!el) return;
  if (!pb || pb.live || !state.pbStory) { el.hidden = true; return; }
  const ft = state.pbData.frames[pb.idx]._t;
  let ev = null;
  for (const e of state.pbStory) { if (e.t <= ft) ev = e; else break; }
  if (!ev) { el.hidden = true; return; }
  el.hidden = false;
  const key = `${ev.t}|${ev.text}`;
  if (key === pb.capKey) return;
  pb.capKey = key;
  el.textContent = `${fmtCT(ev.iso)}: ${ev.text}`;
  el.classList.remove('cap-in');
  void el.offsetWidth; // restart the entry transition
  el.classList.add('cap-in');
}

const pbShortName = (name) => { const m = String(name || '').split(/ (?:at|near|below|above) /); return (m[1] || m[0] || '').trim(); };

function pbTopMovers(k) {
  const pb = state.pb, frames = state.pbData.frames;
  if (pb.idx <= pbFirstIdx()) return [];
  const cur = frames[pb.idx], prev = frames[pb.idx - 1];
  const dtH = (cur._t - prev._t) / 3600000;
  if (dtH <= 0) return [];
  const out = [];
  for (const [lid, rec] of Object.entries(cur.gauges)) {
    const p = prev.gauges[lid];
    if (!p || rec[1] < 0 || p[1] < 0) continue;
    const rate = (rec[0] - p[0]) / dtH;
    if (Math.abs(rate) < 0.1) continue;
    const gi = state.pbData.gaugeIndex[lid];
    out.push({ name: pbShortName(gi && gi.name), rate });
  }
  out.sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate));
  return out.slice(0, k);
}

const pbMoverTxt = (m) => `${m.rate > 0 ? '▲' : '▼'} ${esc(m.name)} ${m.rate > 0 ? '+' : ''}${m.rate.toFixed(1)} ft/hr`;

function pbUpdateHud() {
  const pb = state.pb, el = $('#pb-hud');
  if (!el) return;
  if (!pb || pb.live) { el.hidden = true; $('#pb-hud-detail').hidden = true; return; }
  el.hidden = false;
  const frame = state.pbData.frames[pb.idx];
  const n = { major: 0, moderate: 0, minor: 0, action: 0 };
  for (const rec of Object.values(frame.gauges)) { if (rec[1] > 0) n[PB_CAT_NAMES[rec[1]]]++; }
  const mv = pbTopMovers(1)[0];
  el.innerHTML =
    `<span style="color:var(--cat-major)">MAJ ${n.major}</span> · ` +
    `<span style="color:var(--cat-moderate)">MOD ${n.moderate}</span> · ` +
    `<span style="color:var(--cat-minor)">MIN ${n.minor}</span> · ` +
    `<span>⚠ ${pbSbw.visibleN === null ? '–' : pbSbw.visibleN}</span>` +
    (mv ? ` · <span>${pbMoverTxt(mv)}</span>` : '');
}

function pbToggleHudDetail() {
  const pb = state.pb, d = $('#pb-hud-detail');
  if (!pb || pb.live) return;
  d.hidden = !d.hidden;
  if (d.hidden) return;
  const movers = pbTopMovers(3);
  const ft = state.pbData.frames[pb.idx]._t;
  const warns = [], seen = new Set();
  for (const feats of pbSbw.buckets.values()) {
    for (const f of feats) {
      if (!(f._b0 <= ft && ft <= f._b1)) continue;
      const k = pbSbwKey(f.properties);
      if (seen.has(k)) continue;
      seen.add(k);
      warns.push(`${f.properties.ps || 'NWS warning'} · ${f.properties.wfo || ''}`);
    }
  }
  d.innerHTML =
    `<div><strong>${esc(t('playback.hud.movers'))}</strong>: ${movers.length ? movers.map(pbMoverTxt).join(' · ') : esc(t('playback.hud.none'))}</div>` +
    `<div><strong>${esc(t('playback.hud.warns'))}</strong>: ${warns.length ? warns.map((w) => esc(w)).join(' · ') : esc(t('playback.hud.none'))}</div>`;
}

async function openPlayback() {
  const pill = $('#pb-pill');
  try { await loadPlaybackData(); } catch {
    pill.classList.add('pb-disabled');
    pill.title = t('playback.unavail');
    $('#refresh-note').textContent = t('playback.unavail');
    return;
  }
  if (!state.pb) state.pb = { days: 3, idx: state.pbData.frames.length - 1, live: true, playing: false, raf: null, lastStep: 0, speed: 1, capKey: null };
  $('#playback-bar').hidden = false;
  $('#pb-speed').textContent = `${state.pb.speed}×`;
  pill.classList.add('open');
  document.body.classList.add('pb-bar-open');
  setPlaybackRange(state.pb.days);
  const pbt = Date.parse(new URLSearchParams(location.search).get('pbt') || ''); // deep link: jump to a moment
  if (Number.isFinite(pbt) && !state.pbtApplied) {
    state.pbtApplied = true;
    setPlaybackFrame(pbFrameAt(pbt));
    updatePlaybackNote();
  }
}

function closePlayback() {
  if (!state.pb) return;
  playbackGoLive();
  $('#playback-bar').hidden = true;
  $('#pb-pill').classList.remove('open');
  document.body.classList.remove('pb-bar-open');
}

function togglePlayback() {
  if (state.pb && !$('#playback-bar').hidden) closePlayback();
  else openPlayback();
}

// window = chosen 3/7/14d clipped to the archive — never fake empty frames before the archive starts
function setPlaybackRange(days) {
  const pb = state.pb, frames = state.pbData.frames;
  pb.days = days;
  pb.loT = Math.max(Date.now() - days * 86400000, frames[0]._t);
  pb.hiT = frames[frames.length - 1]._t;
  document.querySelectorAll('.pb-chip').forEach((b) => b.classList.toggle('on', +b.dataset.days === days));
  const sl = $('#pb-slider');
  sl.min = pb.loT;
  sl.max = pb.hiT;
  sl.step = 60000;
  renderPlaybackTicks();
  pbBuildStory();
  if (pb.live) { sl.value = pb.hiT; updatePlaybackReadout(); } else setPlaybackFrame(pb.idx);
  updatePlaybackNote();
}

function pbFrameAt(tMs) {
  const frames = state.pbData.frames;
  let best = 0;
  for (let i = 0; i < frames.length; i++) { if (frames[i]._t <= tMs) best = i; else break; }
  return Math.max(best, pbFirstIdx());
}
function pbFirstIdx() {
  const frames = state.pbData.frames;
  for (let i = 0; i < frames.length; i++) { if (frames[i]._t >= state.pb.loT) return i; }
  return frames.length - 1;
}

function renderPlaybackTicks() {
  const pb = state.pb;
  const el = $('#pb-ticks');
  el.innerHTML = '';
  for (const g of state.pbChapters || []) {
    const pt = new Date(g.peak_time).getTime();
    if (!(pt >= pb.loT && pt <= pb.hiT)) continue;
    const b = document.createElement('button');
    b.className = 'pb-tick';
    b.textContent = '▲';
    b.style.left = `${((pt - pb.loT) / (pb.hiT - pb.loT || 1)) * 100}%`;
    b.title = `${g.name} crest ${g.peak} ${g.unit || 'ft'}`;
    b.addEventListener('click', () => { stopPlaybackPlay(); setPlaybackFrame(pbFrameAt(pt)); });
    el.appendChild(b);
  }
}

// build once per session: one marker per archived gauge, mutated per frame (8 fps re-create would churn)
function pbEnsureMarkers() {
  if (state.pbMarkers) return;
  state.layers.pbGauges = state.layers.pbGauges || L.layerGroup();
  state.pbMarkers = {};
  for (const [lid, gi] of Object.entries(state.pbData.gaugeIndex)) {
    const icon = L.divIcon({
      className: '',
      html: '<div class="gauge-hit pb-ghit"><div class="gauge-icon cat-none" style="width:8px;height:8px"></div></div>',
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
    const m = L.marker([gi.lat, gi.lon], { icon });
    m.bindPopup(() => pbPopup(lid), { minWidth: 240 });
    state.layers.pbGauges.addLayer(m);
    state.pbMarkers[lid] = m;
  }
}

function pbPopup(lid) {
  const pb = state.pb;
  const frame = state.pbData.frames[pb.idx];
  const gi = state.pbData.gaugeIndex[lid];
  const rec = frame.gauges[lid];
  if (!rec) return '';
  const { stale, cat } = pbDecode(rec[1]);
  return `<div class="popup-title">${esc(gi.name)}</div>` +
    `<div class="popup-meta"><span class="cat-word" style="color:var(--cat-${stale ? 'none' : cat})">${esc(CAT_LABEL[cat])}</span> · ${fmtNum(rec[0])} ft</div>` +
    (stale ? `<div class="popup-meta stale-note">⏱ ${esc(t('playback.stale'))}</div>` : '') +
    `<div class="popup-meta" style="color:var(--sev-warning);font-weight:700">⏮ ${esc(t('playback.pill'))} · ${esc(fmtCT(frame.t))}</div>`;
}

function pbPaintMarkers(frame) {
  for (const [lid, m] of Object.entries(state.pbMarkers)) {
    const el = m.getElement();
    if (!el) continue;
    const rec = frame.gauges[lid];
    if (!rec) { el.style.display = 'none'; continue; }
    el.style.display = '';
    const { stale, cat } = pbDecode(rec[1]);
    const hit = el.firstChild;
    hit.className = `gauge-hit pb-ghit${cat === 'none' && !stale ? ' hit-none' : ''}`;
    const dot = hit.firstChild;
    dot.className = `gauge-icon ${stale ? 'stale' : `cat-${cat}`}`;
    const size = stale ? 11 : CAT_SIZE[cat];
    dot.style.width = `${size}px`;
    dot.style.height = `${size}px`;
    m.setZIndexOffset(cat === 'major' ? 1000 : 0);
  }
}

// engage: swap the live gauge + alert layers for archive layers, badge the view, archive the radar if it's on
function playbackEngage() {
  const pb = state.pb;
  if (!pb.live) return;
  pb.live = false;
  pbEnsureMarkers();
  pb.gaugesWereOn = state.map.hasLayer(state.layers.gauges);
  if (pb.gaugesWereOn) state.map.removeLayer(state.layers.gauges);
  state.layers.pbGauges.addTo(state.map);
  pb.alertsWereOn = state.map.hasLayer(state.layers.alerts);
  if (pb.alertsWereOn) state.map.removeLayer(state.layers.alerts);
  state.layers.pbAlerts = state.layers.pbAlerts || L.layerGroup();
  state.layers.pbAlerts.addTo(state.map);
  pbSbw.renderKey = '';
  pbSbw.visibleN = null;
  document.body.classList.toggle('pb-tween', pb.speed <= 1);
  document.body.classList.add('pb-on');
  $('#pb-badge').hidden = false;
  $('#pb-now').classList.add('armed');
  if (state.map.hasLayer(state.layers.radar)) {
    pb.radarWasIdx = state.radar ? state.radar.idx : -1;
    stopRadarPlay();
    if (state.radar) state.radar.frameLayers.forEach((l) => l.setOpacity(0));
    pb.radarLayer = L.tileLayer(PB_RADAR_URL(pbRadarStamp()), {
      pane: 'radar', opacity: 0.75, maxNativeZoom: 8, maxZoom: 19, attribution: 'Radar archive: IEM NEXRAD',
    }).addTo(state.map);
  }
  updatePlaybackNote();
}

// NOW: instant, total restore of the live picture
function playbackGoLive() {
  const pb = state.pb;
  if (!pb || pb.live) return;
  stopPlaybackPlay();
  pb.live = true;
  if (state.map.hasLayer(state.layers.pbGauges)) state.map.removeLayer(state.layers.pbGauges);
  if (pb.gaugesWereOn && !state.map.hasLayer(state.layers.gauges)) state.layers.gauges.addTo(state.map);
  // archived warning polys clear instantly — never linger over the live picture
  if (state.layers.pbAlerts) {
    state.layers.pbAlerts.clearLayers();
    if (state.map.hasLayer(state.layers.pbAlerts)) state.map.removeLayer(state.layers.pbAlerts);
  }
  if (pb.alertsWereOn && !state.map.hasLayer(state.layers.alerts)) state.layers.alerts.addTo(state.map);
  clearTimeout(pb.sbwTimer);
  pbSbw.renderKey = '';
  pbSbw.visibleN = null;
  if (pb.radarLayer) { state.map.removeLayer(pb.radarLayer); pb.radarLayer = null; }
  if (pb.radarWasIdx >= 0 && state.radar) setRadarFrame(pb.radarWasIdx);
  pb.radarWasIdx = -1;
  document.body.classList.remove('pb-on');
  document.body.classList.remove('pb-tween');
  $('#pb-badge').hidden = true;
  $('#pb-now').classList.remove('armed');
  $('#pb-caption').hidden = true;
  $('#pb-hud').hidden = true;
  $('#pb-hud-detail').hidden = true;
  pb.capKey = null;
  $('#pb-slider').value = pb.hiT;
  updatePlaybackReadout();
  updatePlaybackNote();
}

function pbRadarStamp() {
  const frame = state.pbData.frames[state.pb.idx];
  const d = new Date(Math.floor(frame._t / 300000) * 300000); // IEM archive is 5-min steps
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

function setPlaybackFrame(i) {
  const pb = state.pb, frames = state.pbData.frames;
  playbackEngage();
  pb.idx = Math.max(pbFirstIdx(), Math.min(i, frames.length - 1));
  const frame = frames[pb.idx];
  pbPaintMarkers(frame);
  if (pb.radarLayer) {
    const stamp = pbRadarStamp();
    if (stamp !== pb.radarStamp) { pb.radarStamp = stamp; pb.radarLayer.setUrl(PB_RADAR_URL(stamp)); }
  }
  $('#pb-slider').value = frame._t;
  updatePlaybackReadout();
  pbSbwSchedule();
  pbUpdateHud();
  pbUpdateCaption();
}

function updatePlaybackReadout() {
  const pb = state.pb;
  if (pb.live) {
    $('#pb-time').textContent = t('playback.live');
    $('#pb-time').classList.add('live');
    return;
  }
  const frame = state.pbData.frames[pb.idx];
  $('#pb-time').textContent = fmtCT(frame.t);
  $('#pb-time').classList.remove('live');
  $('#pb-badge-t').textContent = fmtCT(frame.t);
}

// truth line: which layers replay vs stay live, incl. the viewer's own 7d alert history at frame time
function updatePlaybackNote() {
  const pb = state.pb;
  let note = pb.live ? t('playback.note.idle')
    : `${t('playback.note.replay')}${t('playback.note.warn')}${pb.radarLayer ? t('playback.note.radar') : ''} · ${t('playback.note.live')}`;
  if (!pb.live) {
    const ft = state.pbData.frames[pb.idx]._t;
    const n = Object.values(state.hist.alerts || {}).filter((a) => {
      const s = new Date(a.t).getTime(), e = a.expires ? new Date(a.expires).getTime() : 0;
      return s <= ft && e >= ft;
    }).length;
    if (n) note += ` · ${t('playback.note.alerthist').replace('{n}', n)}`;
    if (state.pbData.frames[pbFirstIdx()]._t > Date.now() - pb.days * 86400000 + 60000) {
      note += ` · ${t('playback.note.start').replace('{t}', fmtCT(state.pbData.frames[0].t))}`;
    }
  }
  $('#pb-note').textContent = note;
}

function stopPlaybackPlay() {
  const pb = state.pb;
  if (!pb) return;
  pb.playing = false;
  if (pb.raf) { cancelAnimationFrame(pb.raf); pb.raf = null; }
  $('#pb-play').textContent = '▶';
}

function togglePlaybackPlay() {
  const pb = state.pb;
  if (!pb) return;
  if (pb.playing) { stopPlaybackPlay(); return; }
  if (pb.live || pb.idx >= state.pbData.frames.length - 1) setPlaybackFrame(pbFirstIdx()); // play from window start
  pb.playing = true;
  $('#pb-play').textContent = '⏸';
  pb.lastStep = 0;
  const step = (ts) => {
    if (!pb.playing) return;
    if (ts - pb.lastStep >= PB_BASE_FRAME_MS / pb.speed) {
      pb.lastStep = ts;
      if (pb.idx >= state.pbData.frames.length - 1) { stopPlaybackPlay(); updatePlaybackNote(); return; }
      setPlaybackFrame(pb.idx + 1);
      updatePlaybackNote();
    }
    pb.raf = requestAnimationFrame(step);
  };
  pb.raf = requestAnimationFrame(step);
}

function pbCycleSpeed() {
  const pb = state.pb;
  if (!pb) return;
  pb.speed = PB_SPEEDS[(PB_SPEEDS.indexOf(pb.speed) + 1) % PB_SPEEDS.length];
  $('#pb-speed').textContent = `${pb.speed}×`;
  // 0.5-1x: tween marker size/color between frames — visual transition only, readout stays the real frame time
  document.body.classList.toggle('pb-tween', pb.speed <= 1 && !pb.live);
}

function pbStepFrame(d) {
  const pb = state.pb;
  if (!pb) return;
  stopPlaybackPlay();
  setPlaybackFrame((pb.live ? state.pbData.frames.length - 1 : pb.idx) + d);
  updatePlaybackNote();
}

function initPlaybackControls() {
  $('#pb-pill').addEventListener('click', togglePlayback);
  $('#pb-play').addEventListener('click', togglePlaybackPlay);
  $('#pb-now').addEventListener('click', playbackGoLive);
  $('#pb-close').addEventListener('click', closePlayback);
  $('#pb-speed').addEventListener('click', pbCycleSpeed);
  $('#pb-back').addEventListener('click', () => pbStepFrame(-1));
  $('#pb-fwd').addEventListener('click', () => pbStepFrame(1));
  $('#pb-caption').addEventListener('click', stopPlaybackPlay); // tap the caption = pause
  $('#pb-hud').addEventListener('click', pbToggleHudDetail);
  $('#pb-slider').addEventListener('input', () => {
    stopPlaybackPlay();
    setPlaybackFrame(pbFrameAt(+$('#pb-slider').value));
    updatePlaybackNote();
  });
  document.querySelectorAll('.pb-chip').forEach((b) => b.addEventListener('click', () => {
    stopPlaybackPlay();
    setPlaybackRange(+b.dataset.days);
    updatePlaybackNote();
  }));
}

