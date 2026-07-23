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
  if (theme !== 'dark' && theme !== 'light') theme = 'light'; // invalid ?theme=/storage must never crash boot or persist
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('respondertx.theme', theme);
  $('#theme-toggle').innerHTML = theme === 'dark'
    ? `☀️ <span class="ctl-lbl">${esc(t('ctl.theme.light'))}</span>`
    : `🌙 <span class="ctl-lbl">${esc(t('ctl.theme.dark'))}</span>`;
  if (state.map) {
    // Streets base is theme-neutral: keep it in place, theme then only affects UI chrome
    if (state.activeBase !== 'streets' && state.activeBase !== theme && state.baseLayers[theme]) {
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

/* ---------- unified Rainfall overlay (v0.90) — one MRMS layer, window picked via legend chips ---------- */

const RAIN_WIN_KEY = 'respondertx.rainwin';
const bustSrc = (url) => url + '?_=' + Math.floor(Date.now() / 300000);

function updateMrmsLegend() {
  const on = state.map.hasLayer(state.layers.mrms);
  $('#mrms-legend').hidden = !on;
  if (!on) return;
  $('#mrms-legend-title').textContent = t('leg.rain.acc').replace('{w}', state.rainWindow);
  $('#mrms-legend-chips').innerHTML = CONFIG.mrmsWindows.map((w) =>
    `<button class="mrms-chip${w === state.rainWindow ? ' on' : ''}" data-win="${w}" aria-pressed="${w === state.rainWindow}">${w}</button>`).join('');
}

function setRainWindow(w) {
  if (!CONFIG.mrmsWindows.includes(w) || w === state.rainWindow) return;
  if (state.pb && !state.pb.live) return; // playback: same read-only regime as the layer sheet
  state.rainWindow = w;
  try { sessionStorage.setItem(RAIN_WIN_KEY, w); } catch { /* private mode — window choice is session-only anyway */ }
  state.layers.mrms.setUrl(bustSrc(CONFIG.mrmsUrl(w))); // same layer object — tiles swap in place, no re-add flicker
  updateMrmsLegend();
}

/* ---------- tropical-cyclone legend: a compact bottom-left key toggled with the NHC tracker layer ---------- */

function tropicalLegendHtml() {
  const wwRow = (k) => `<div><span class="sw sw-line" style="background:${TCWW_WW[k].color}"></span>${esc(t(TCWW_WW[k].key))}</div>`;
  return `<div class="lg-title">${esc(t('trop.leg.title'))}</div>` +
    `<div><span class="sw" style="width:12px;height:10px;background:${TROPICAL_CONE_FILL};opacity:.5;border-radius:2px"></span>${esc(t('trop.leg.cone'))}</div>` +
    `<div><span class="sw sw-line" style="background:${TROPICAL_TRACK}"></span>${esc(t('trop.leg.otrack'))}</div>` +
    `<div><span class="sw sw-line" style="background:${TROPICAL_TRACK}"></span>${esc(t('trop.leg.ftrack'))}</div>` +
    `<div class="lg-title" style="margin-top:6px">${esc(t('trop.leg.ww'))}</div>` +
    ['HWR', 'TWR', 'SSW', 'HWA', 'TWA', 'SSA'].map(wwRow).join('');
}

function showTropicalLegend() {
  if (!state.tropicalLegend) {
    const c = L.control({ position: 'bottomleft' });
    c.onAdd = () => {
      const div = L.DomUtil.create('div', 'map-legend trop-legend');
      div.innerHTML = tropicalLegendHtml(); // rebuilt on each add so a live language switch localizes it
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      L.DomEvent.on(div, 'click', () => div.classList.toggle('open'));
      return div;
    };
    state.tropicalLegend = c;
  }
  state.tropicalLegend.addTo(state.map);
}

function hideTropicalLegend() {
  if (state.tropicalLegend) state.tropicalLegend.remove();
}

/* ---------- map ---------- */

// flyOpenPopup latlng zoom marker — setView, then open once the flight fully settles;
// opening mid-flight breaks popup autoPan (the flight's later animation phases re-center over it)
function flyOpenPopup(latlng, zoom, marker) {
  state.map.setView(latlng, zoom);
  if (!marker) return;
  const busy = () => (state.map._panAnim && state.map._panAnim._inProgress) || state.map._animatingZoom;
  let idle = 0, tries = 0;
  (function tick() {
    idle = busy() ? 0 : idle + 1;
    if (idle >= 2 || ++tries > 50) { marker.openPopup(); return; }
    setTimeout(tick, 80);
  })();
}

// our own recenters/follow glides: flag the move so a zoom-changing recenter never self-exits follow.
// smooth=true glides to the newest fix at near-constant speed; a fresh fix retargets the in-flight pan,
// so consecutive ~1s fixes chain into continuous motion instead of jump-then-sit.
function progSetView(latlng, zoom, smooth) {
  // arm the zoomstart guard ONLY for a zoom-changing move — that is the only case that fires zoomstart.
  // a pure pan/glide leaves _progMove false so a user pinch/scroll-zoom mid-glide still exits follow.
  const zoomChanges = zoom != null && zoom !== state.map.getZoom();
  if (zoomChanges) {
    state._progMove = true;
    clearTimeout(state._progMoveT);
    state._progMoveT = setTimeout(() => { state._progMove = false; }, smooth ? 1600 : 700); // net if the move is a no-op and no moveend fires
  }
  if (smooth && !zoomChanges) {
    state.map.panTo(latlng, { animate: true, duration: 1.1, easeLinearity: 0.92 }); // glide slightly longer than the ~1s fix gap, near-linear so speed stays steady
  } else {
    state.map.setView(latlng, zoom == null ? state.map.getZoom() : zoom);
  }
}

function initMap() {
  // autoPan clear of the AO chip / layer-pill band at the map top — popups otherwise clip against the container edge
  L.Popup.mergeOptions({ autoPanPaddingTopLeft: L.point(8, 120) });
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
  // tropical pane: above alert polygons (400) and radar, below labels (450) and markers (600); interactive for popups
  state.map.createPane('tropical');
  state.map.getPane('tropical').style.zIndex = 440;
  // storm-surge risk pane: a raster hazard below radar (350), labels (450), and markers (600)
  state.map.createPane('surge');
  state.map.getPane('surge').style.zIndex = 340;
  state.map.getPane('surge').style.pointerEvents = 'none';
  state.layers.labelBoost = offlineTile(labelBoostUrl(), { pane: 'labels', attribution: attrib, maxZoom: 19 }).addTo(state.map);

  // all radar/rainfall layers are OFF by default (owner directive) — explicit enable via layer control
  // group of pre-loaded per-frame tile layers; playback crossfades opacity (no per-step tile reload)
  state.layers.radar = L.layerGroup();
  const savedWin = sessionStorage.getItem(RAIN_WIN_KEY);
  state.rainWindow = CONFIG.mrmsWindows.includes(savedWin) ? savedWin : '1h';
  state.layers.mrms = L.tileLayer(bustSrc(CONFIG.mrmsUrl(state.rainWindow)), { opacity: 0.55, attribution: 'Rainfall: MRMS via IEM' });
  // MODELED flood extent (not observed) — off by default (hazard layers explicit-enable, owner directive)
  state.layers.inundation = new ArcGISExportLayer(CONFIG.inunExportUrl, {
    opacity: 0.72, maxZoom: 19,
    attribution: 'Flood inundation: NWM analysis (experimental) &copy; NOAA/NWPS',
  });
  // NOAA/NHC storm-surge risk (SLOSH MOM near worst-case): off by default (hazard layers
  // explicit-enable); cached national raster, maxNativeZoom pins the top LOD, Leaflet upsamples past it
  state.layers.surge = L.tileLayer(CONFIG.surgeUrl(CONFIG.surgeCat), {
    pane: 'surge', opacity: 0.55, maxNativeZoom: 14, maxZoom: 19,
    attribution: 'Storm surge risk: NOAA/NHC National Storm Surge Hazard Maps (SLOSH MOM)',
  });
  state.layers.surge.on('tileerror', () => { if (!state.surgeErr) { state.surgeErr = true; $('#refresh-note').textContent = t('surge.unavailable'); } });
  state.layers.surge.on('load', () => { state.surgeErr = false; });
  // HRRR model future-cast — MODEL data (never observed); per-hour WMS layers mounted at opacity 0
  // like the observed-radar frames, so stepping is opacity-only (never a per-step fetch-gated fade)
  state.rtl = { idx: 0, fut: false, hour: 1, playing: false, timer: null, wantNow: false };
  state.fcst = { runIso: null, hourLayers: [] };
  state.layers.fcstRadar = L.layerGroup();
  state.inunBucket = Math.floor(Date.now() / 3600000);
  state.refreshRadar = () => {
    state.layers.mrms.setUrl(bustSrc(CONFIG.mrmsUrl(state.rainWindow)));
    if (state.map.hasLayer(state.layers.radar)) fetchRadarFrames().catch(() => { /* keep last frames */ });
    if (state.map.hasLayer(state.layers.fcstRadar)) fcstFetchRun();
    const bucket = Math.floor(Date.now() / 3600000); // inundation updates hourly — redraw only on the hour
    if (bucket !== state.inunBucket) {
      state.inunBucket = bucket;
      if (state.map.hasLayer(state.layers.inundation)) state.layers.inundation.redraw();
    }
  };
  state.map.on('overlayadd', (e) => {
    if (e.layer === state.layers.mrms) updateMrmsLegend();
    if (e.layer === state.layers.inundation) $('#inun-legend').hidden = false;
    if (e.layer === state.layers.lwc) fetchLwc();
    if (e.layer === state.layers.tropical) { showTropicalLegend(); fetchTropical().catch(() => { $('#refresh-note').textContent = 'tropical feed unavailable'; }); }
    if (e.layer === state.layers.surge) $('#surge-legend').hidden = false;
    if ([state.layers.camsTxdot, state.layers.camsRiver, state.layers.camsAustin, state.layers.camsFlood, state.layers.camsHouston, state.layers.camsArlington, state.layers.camsElpBridge, state.layers.camsHays].includes(e.layer)) loadCameras().catch(() => { $('#refresh-note').textContent = 'camera inventory unavailable'; });
    if (e.layer === state.layers.fcstRadar) fcstEnable();
    if (e.layer !== state.layers.radar) return;
    rtlSync();
    fetchRadarFrames().catch(() => { $('#rs-label').textContent = 'radar feed unavailable'; });
  });
  state.map.on('overlayremove', (e) => {
    if (e.layer === state.layers.mrms) updateMrmsLegend();
    if (e.layer === state.layers.inundation) $('#inun-legend').hidden = true;
    if (e.layer === state.layers.tropical) { hideTropicalLegend(); state.tropicalAutoDone = true; } // manual toggle-off stops auto-enable
    if (e.layer === state.layers.surge) $('#surge-legend').hidden = true;
    if (e.layer === state.layers.fcstRadar) fcstDisable();
    if (e.layer === state.layers.usgs) {
      if (state.usgsAutoOn && !state.usgsAutoRemoving) state.usgsFallbackDismissed = true; // user closed the auto fallback — don't re-offer until the feed recovers
      state.usgsAutoOn = false;
    }
    if (e.layer !== state.layers.radar) return;
    rtlSync();
    if (rtlDomain().total) rtlSet(state.rtl.idx); // forecast-only bar repaints in the shrunk domain
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
  // hasOwnProperty guard (theme-fix pattern): ?base=toString must not resolve via the prototype chain
  const knownBase = (b) => !!b && Object.prototype.hasOwnProperty.call(state.baseLayers, b);
  const wantBase = baseParam === 'osm' ? 'streets'
    : (knownBase(baseParam) ? baseParam : null) || localStorage.getItem('respondertx.base') || 'streets';
  state.activeBase = knownBase(wantBase) ? wantBase : 'streets';
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
  // recently-reopened roads (recovery ✓) — OFF by default, explicit opt-in nested under road closures; flood-scoped
  state.layers.roadReopen = L.layerGroup();
  // NOAA NHC active tropical cyclones (Esri Living Atlas): cone/track/positions/watches; OFF by default, lazy-loaded on first enable
  state.layers.tropical = L.layerGroup();
  // TxGIO low-water-crossing location inventory — OFF by default, lazy-loaded, canvas-rendered; LOCATIONS, not live status
  state.layers.lwc = L.layerGroup();
  // cameras — one independent sub-layer per source, all OFF by default, lazy-loaded, clustered;
  // plain group if the markercluster plugin failed to load
  const camGroup = () => (L.markerClusterGroup
    ? L.markerClusterGroup({ disableClusteringAtZoom: 12, maxClusterRadius: 46 })
    : L.layerGroup());
  state.layers.camsTxdot = camGroup();
  state.layers.camsRiver = camGroup();
  state.layers.camsAustin = camGroup();
  state.layers.camsFlood = camGroup();
  state.layers.camsHouston = camGroup();
  state.layers.camsArlington = camGroup();
  state.layers.camsElpBridge = camGroup();
  state.layers.camsHays = camGroup();
  L.control.layers({
    'Dark (CARTO)': state.baseLayers.dark,
    'Light (CARTO)': state.baseLayers.light,
    'Streets (OSM)': state.baseLayers.streets,
  }, {
    'Place labels (boost)': state.layers.labelBoost,
    'Radar & forecast': state.layers.radar,
    'Radar & forecast (HRRR)': state.layers.fcstRadar,
    'Rainfall (MRMS)': state.layers.mrms,
    'Flood inundation: NWM model (est.)': state.layers.inundation,
    'Tropical cyclone tracker (NHC)': state.layers.tropical,
    'Storm surge risk (NHC SLOSH)': state.layers.surge,
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
    'Road reopenings (recovering)': state.layers.roadReopen,
    'Low-water crossings (locations · not live status)': state.layers.lwc,
    'Cameras: TxDOT road (live/still)': state.layers.camsTxdot,
    'Cameras: USGS river/flood (stills)': state.layers.camsRiver,
    'Cameras: Austin city (stills)': state.layers.camsAustin,
    'Cameras: ATX Floods low-water crossings': state.layers.camsFlood,
    'Cameras: Houston TranStar (stills)': state.layers.camsHouston,
    'Cameras: Arlington city (stills)': state.layers.camsArlington,
    'Cameras: El Paso international bridges (live)': state.layers.camsElpBridge,
    'Cameras: Hays County flood (stills)': state.layers.camsHays,
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
      '<div><span class="reopen-icon">✓</span>road reopened (recovering)</div>' +
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

  const mrmsLg = $('#mrms-legend');
  L.DomEvent.disableClickPropagation(mrmsLg);
  L.DomEvent.disableScrollPropagation(mrmsLg);
  const wxLg = $('#wx-legend');
  L.DomEvent.disableClickPropagation(wxLg);
  L.DomEvent.disableScrollPropagation(wxLg);
  $('#mrms-legend-chips').addEventListener('click', (e) => {
    const b = e.target.closest('.mrms-chip');
    if (b) setRainWindow(b.dataset.win);
  });

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
      // transient re-center hint drawer, anchored to the right of ⌖; tapping it re-centers like ⌖ itself
      const drawer = L.DomUtil.create('span', 'recenter-drawer', a);
      drawer.setAttribute('role', 'button');
      drawer.setAttribute('data-i18n', 'map.recenter');
      drawer.textContent = t('map.recenter');
      drawer.hidden = true;
      L.DomEvent.on(drawer, 'click', (e) => { L.DomEvent.stop(e); recenterAndFollow(); });
      state.recenterDrawer = drawer;
      L.DomEvent.on(a, 'click', (e) => { L.DomEvent.stop(e); recenterAndFollow(); });
      return bar;
    },
  });
  state.map.addControl(new NavControl({ position: 'topleft' }));
  // the stock checkbox control is hidden (CSS) but stays on the map as the
  // overlay-event registry; this button in its old anchor spot opens the grouped sheet
  const sheetBtn = L.control({ position: 'topright' });
  sheetBtn.onAdd = () => {
    const div = L.DomUtil.create('div', 'leaflet-bar ls-trigger');
    // inline SVG, not emoji — desktop emoji fonts render 🗂 as a flat black box that clashes with the zoom bar
    div.innerHTML = `<a href="#" role="button" title="${esc(t('sheet.open'))}" aria-label="${esc(t('sheet.open'))}" data-i18n-title="sheet.open" data-i18n-aria="sheet.open">${CTL_ICON_LAYERS}</a>`;
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.on(div.firstChild, 'click', (e) => {
      L.DomEvent.stop(e);
      if (layerSheetIsOpen()) closeLayerSheet(); else openLayerSheet();
    });
    return div;
  };
  sheetBtn.addTo(state.map);
  // Share stays first-class — a map control right below the layers trigger (also still in ⋮)
  const shareCtl = L.control({ position: 'topright' });
  shareCtl.onAdd = () => {
    const div = L.DomUtil.create('div', 'leaflet-bar ls-trigger share-trigger');
    div.innerHTML = `<a href="#" role="button" title="${esc(t('ctl.share.title'))}" aria-label="${esc(t('ctl.share.aria'))}" data-i18n-title="ctl.share.title" data-i18n-aria="ctl.share.aria">${CTL_ICON_LINK}</a>`;
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.on(div.firstChild, 'click', (e) => {
      L.DomEvent.stop(e);
      shareView(div.firstChild);
    });
    return div;
  };
  shareCtl.addTo(state.map);
  // compass box under Share: static north-up rose by default; tap to rotate the rose to the device's live heading (progressive enhancement)
  const compassCtl = L.control({ position: 'topright' });
  compassCtl.onAdd = () => {
    const div = L.DomUtil.create('div', 'leaflet-bar ls-trigger compass-ctl');
    div.innerHTML = `<a href="#" role="button" title="${esc(t('ctl.compass.title'))}" aria-label="${esc(t('ctl.compass.aria'))}" data-i18n-title="ctl.compass.title" data-i18n-aria="ctl.compass.aria">${CTL_ICON_COMPASS}</a>`;
    L.DomEvent.disableClickPropagation(div);
    const a = div.firstChild;
    state.compassEl = div;
    state.compassRose = a.querySelector('svg');
    L.DomEvent.on(a, 'click', (e) => { L.DomEvent.stop(e); toggleCompassHeading(a); });
    return div;
  };
  compassCtl.onRemove = () => stopCompassHeading();
  compassCtl.addTo(state.map);
  initAoJump();
  initLayerPills();
  initLayerSheet();
  state.map.on('locationfound', (e) => {
    gpsWait(false);
    const deliberate = state.centerNextFix; // an explicit locate/recenter; watch ticks never set this
    state.myPos = e.latlng;
    state.driveFixAt = Date.now();
    if (!state.posLayer) {
      state.posAccuracy = L.circle(e.latlng, { radius: e.accuracy, weight: 1, color: cssVar('--accent') || '#3987e5', fillOpacity: 0.08 });
      state.posMarker = L.marker(e.latlng, { icon: youIcon(), title: 'Your location', zIndexOffset: 2000, interactive: false });
      state.posLayer = L.layerGroup([state.posAccuracy, state.posMarker]).addTo(state.map);
    } else {
      state.posAccuracy.setLatLng(e.latlng); state.posAccuracy.setRadius(e.accuracy);
      state.posMarker.setLatLng(e.latlng); // watch fixes move the marker in place without restarting its pulse
      if (deliberate) state.posMarker.setIcon(youIcon()); // fresh icon element restarts the finite pulse
    }
    // deliberate locate snaps to locateZoom once; while following we track the fix at the current zoom; otherwise the marker updates in place
    if (state.centerNextFix) { state.centerNextFix = false; progSetView(e.latlng, Math.max(state.map.getZoom(), CONFIG.locateZoom)); }
    else if (state.followMe) { progSetView(e.latlng, null, true); } // glide to the fix instead of snapping
    // marker + accuracy circle + glide update on every fix; the heavy re-rank throttles so ~1s fixes stay cheap
    const nowMs = Date.now();
    if (nowMs - state.driveRankAt >= CONFIG.driveLocateMs) {
      state.driveRankAt = nowMs;
      renderRequests();
      renderDriveMode(); // re-rank the glance list by the new fix
    }
    startLocTrack(); // opt-in tracker begins once the first fix lands; runs in the app and Drive Mode alike
  });
  state.map.on('locationerror', () => {
    gpsWait(false);
    $('#refresh-note').textContent = 'location unavailable (permission or no GPS)';
  });
  // dragstart fires ONLY on a genuine pointer drag (programmatic panTo never fires it), so exit follow
  // unconditionally; this is what lets the user grab the map mid-glide now that a glide is almost always in flight
  state.map.on('dragstart', () => { if (state.followMe) { state.followMe = false; flashRecenterHint(); } });
  // zoom (user pinch/scroll/dblclick) also exits, but our own setView-with-zoom fires zoomstart, hence the _progMove guard
  state.map.on('zoomstart', () => { if (state._progMove || !state.followMe) return; state.followMe = false; flashRecenterHint(); });
  state.map.on('moveend', () => { state._progMove = false; }); // clear the guard once our move settles

  const declutter = () => state.map.getContainer().classList.toggle('z-low', state.map.getZoom() < 9);
  state.map.on('zoomend', declutter);
  declutter();
}

// YOU marker: rings run a finite pulse (CSS iteration-count) then settle static; rebuilding the icon restarts it
function youIcon() {
  return L.divIcon({
    className: '',
    html: '<div class="my-pos-wrap"><div class="my-pos-ring"></div><div class="my-pos-ring d2"></div><div class="my-pos-core"></div><div class="my-pos-label">YOU</div></div>',
    iconSize: [48, 48], iconAnchor: [24, 24],
  });
}

// deliberate re-center: recenter on the freshest fix and re-engage nav-app follow (shared by ⌖ and the hint drawer)
function recenterAndFollow() {
  state.centerNextFix = true;
  state.followMe = true;
  if (window.gpsWait) window.gpsWait(true);
  if (state.myPos) progSetView(state.myPos, Math.max(state.map.getZoom(), CONFIG.locateZoom)); // instant feedback from the last fix
  state.map.locate({ enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 });
  retractRecenterHint(); // following again → hide any showing hint
}

// transient hint: slide the drawer out beside ⌖, flash a few times, then retract; one shot per manual exit-from-follow
function flashRecenterHint() {
  const d = state.recenterDrawer;
  if (!d || !state.myPos || state.followMe || state.recenterHintOn) return;
  state.recenterHintOn = true;
  d.hidden = false;
  void d.offsetWidth; // reflow in the collapsed state so the slide-out transition runs
  d.classList.add('open');
  clearTimeout(state.recenterHintT);
  state.recenterHintT = setTimeout(retractRecenterHint, 2600); // slide-out + 3 flashes, then retract
}

function retractRecenterHint() {
  const d = state.recenterDrawer;
  if (!d) return;
  clearTimeout(state.recenterHintT);
  state.recenterHintOn = false;
  if (!d.classList.contains('open')) { d.hidden = true; return; }
  d.classList.remove('open');
  const hide = () => { d.hidden = true; d.removeEventListener('transitionend', hide); };
  d.addEventListener('transitionend', hide);
  setTimeout(() => { if (!d.classList.contains('open')) d.hidden = true; }, 400); // fallback if transitionend never fires
}

/* ---------- live compass heading: tap the rose to rotate it to the device heading; static north-up otherwise ---------- */

function toggleCompassHeading(anchor) {
  if (state.compassLive) { stopCompassHeading(); return; }
  const DOE = window.DeviceOrientationEvent;
  if (typeof DOE === 'undefined') { compassNotice('ctl.compass.unavailable'); return; }
  if (typeof DOE.requestPermission === 'function') { // iOS 13+ requires a per-gesture permission grant
    DOE.requestPermission()
      .then((resp) => { if (resp === 'granted') startCompassHeading(anchor); else compassNotice('ctl.compass.denied'); })
      .catch(() => compassNotice('ctl.compass.denied'));
    return;
  }
  startCompassHeading(anchor);
}

function startCompassHeading(anchor) {
  const evName = ('ondeviceorientationabsolute' in window) ? 'deviceorientationabsolute' : 'deviceorientation';
  state.compassEvName = evName;
  state.compassAnchor = anchor;
  state.compassHandler = onCompassOrientation;
  state.compassLive = true;
  state.compassGotFix = false;
  state.compassHeading = 0;
  state.compassApplied = null;
  window.addEventListener(evName, onCompassOrientation, true);
  if (state.compassEl) L.DomUtil.addClass(state.compassEl, 'live');
  setCompassLabel(anchor, 'ctl.compass.live', 'ctl.compass.live');
  // desktop or no-signal: if no valid heading lands shortly, fall back to the static rose so the control never sits blank
  clearTimeout(state.compassProbeT);
  state.compassProbeT = setTimeout(() => { if (state.compassLive && !state.compassGotFix) { stopCompassHeading(); compassNotice('ctl.compass.unavailable'); } }, 1500);
}

function stopCompassHeading() {
  if (state.compassHandler && state.compassEvName) window.removeEventListener(state.compassEvName, state.compassHandler, true);
  clearTimeout(state.compassProbeT);
  if (state.compassRaf) { cancelAnimationFrame(state.compassRaf); state.compassRaf = 0; }
  state.compassLive = false;
  state.compassHandler = null;
  if (state.compassRose) state.compassRose.style.transform = ''; // back to the static north-up rose
  if (state.compassEl) L.DomUtil.removeClass(state.compassEl, 'live');
  if (state.compassAnchor) setCompassLabel(state.compassAnchor, 'ctl.compass.title', 'ctl.compass.aria');
}

function onCompassOrientation(e) {
  let heading;
  if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) heading = e.webkitCompassHeading; // iOS: degrees clockwise from magnetic north
  else if (e.alpha != null) heading = 360 - e.alpha; // alpha runs counter-clockwise, so a north-up rose needs 360 - alpha
  else return; // no usable reading (typical on desktop), leave the rose static
  heading = ((heading % 360) + 360) % 360;
  state.compassGotFix = true;
  if (state.compassApplied != null && angleGap(heading, state.compassApplied) < 1) return; // sub-degree jitter, skip the repaint
  state.compassHeading = heading;
  if (!state.compassRaf) state.compassRaf = requestAnimationFrame(applyCompassRotation);
}

function applyCompassRotation() {
  state.compassRaf = 0;
  if (!state.compassRose) return;
  state.compassApplied = state.compassHeading;
  state.compassRose.style.transform = `rotate(${-state.compassHeading}deg)`; // negate heading so the rose's N needle points to true north
}

function angleGap(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

function setCompassLabel(anchor, titleKey, ariaKey) {
  if (!anchor) return;
  anchor.setAttribute('data-i18n-title', titleKey);
  anchor.setAttribute('data-i18n-aria', ariaKey);
  anchor.title = t(titleKey);
  anchor.setAttribute('aria-label', t(ariaKey));
}

function compassNotice(key) {
  const note = $('#refresh-note');
  if (note) note.textContent = t(key);
}

/* ---------- map-control icons — stroke SVGs inherit the themed .leaflet-bar color ---------- */

const CTL_ICON_LAYERS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 12 12 17 22 12"/><polyline points="2 17 12 22 22 17"/></svg>';
const CTL_ICON_LINK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
// north-up compass rose: red north needle, muted south needle, "N" tick; the map is always north up
const CTL_ICON_COMPASS = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="13" r="8.4" fill="none" stroke="currentColor" stroke-width="1.3" opacity="0.5"/><polygon points="12 6 9.2 15 12 13.1 14.8 15" fill="#e5484d"/><polygon points="12 20 9.2 15 12 16.9 14.8 15" fill="currentColor" opacity="0.5"/><text x="12" y="4.6" text-anchor="middle" font-size="5.5" font-weight="700" fill="currentColor">N</text></svg>';

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
  const cur = L.DomUtil.create('button', 'ao-current', jump);
  cur.setAttribute('aria-haspopup', 'true');
  cur.setAttribute('aria-expanded', 'false');
  cur.title = t('ao.current.title');
  cur.setAttribute('data-i18n-title', 'ao.current.title');
  const row = L.DomUtil.create('div', 'ao-row', jump);
  let picked = AO_PRESETS[0];
  let idleT = 0;
  const label = (txt) => { cur.innerHTML = `◎ ${esc(txt)} <span class="ao-caret">▾</span>`; };
  const collapse = () => { jump.classList.remove('open'); cur.setAttribute('aria-expanded', 'false'); clearTimeout(idleT); };
  const armIdle = () => { clearTimeout(idleT); idleT = setTimeout(collapse, 6000); };
  const expand = () => { jump.classList.add('open'); cur.setAttribute('aria-expanded', 'true'); armIdle(); };
  label(picked[0]);
  L.DomEvent.on(cur, 'click', () => (jump.classList.contains('open') ? collapse() : expand()));
  for (const preset of AO_PRESETS) {
    const b = L.DomUtil.create('button', 'ao-chip', row);
    b.textContent = preset[0];
    b.title = t('ao.chip.title');
    b.setAttribute('data-i18n-title', 'ao.chip.title');
    L.DomEvent.on(b, 'click', () => {
      picked = preset;
      state.map.fitBounds(preset[1]);
      label(preset[0]);
      collapse(); // the map jump is the feedback — a lingering open row competes with it
    });
  }
  jump.addEventListener('pointermove', () => { if (jump.classList.contains('open')) armIdle(); });
  document.addEventListener('pointerdown', (e) => {
    if (jump.classList.contains('open') && !jump.contains(e.target)) collapse();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && jump.classList.contains('open')) collapse();
  });
  state.map.on('moveend', () => {
    label(L.latLngBounds(picked[1]).contains(state.map.getCenter()) ? picked[0] : t('ao.custom'));
  });
  L.DomEvent.disableClickPropagation(jump);
  L.DomEvent.disableScrollPropagation(jump);
}

/* ---------- active-layer pills — name each non-default overlay that is ON; hidden at rest ---------- */

const PILL_LAYERS = (CONFIG.wxUnified
  ? [['wx', 'layers.wx']]
  : [['radar', 'layers.radar'], ['fcstRadar', 'layers.fcstradar']]
).concat([
  ['tropical', 'layers.tropical'],
  ['surge', 'layers.surge'],
  ['mrms', 'layers.rain'],
  ['inundation', 'layers.inun'],
  ['usgs', 'layers.usgs'],
  ['lsrsAged', 'layers.lsrhist'],
  ['lwc', 'layers.lwc'],
  ['camsTxdot', 'layers.cams.txdot'],
  ['camsRiver', 'layers.cams.river'],
  ['camsAustin', 'layers.cams.austin'],
  ['camsFlood', 'layers.cams.flood'],
  ['camsHouston', 'layers.cams.houston'],
  ['camsArlington', 'layers.cams.arlington'],
  ['camsElpBridge', 'layers.cams.elpbridge'],
  ['camsHays', 'layers.cams.hays'],
  ['roadReopen', 'layers.reopen'],
]);

// membership test that understands the virtual merged 'wx' row (radar OR forecast); null = no such layer
function layerRowOn(k) {
  if (k === 'wx') return state.map.hasLayer(state.layers.radar) || state.map.hasLayer(state.layers.fcstRadar);
  const lyr = state.layers[k];
  return lyr ? state.map.hasLayer(lyr) : null;
}
function wxRemove() {
  [state.layers.radar, state.layers.fcstRadar].forEach((l) => { if (state.map.hasLayer(l)) state.map.removeLayer(l); });
}
// toggle the merged pair together; add radar first so forecast-enable sees it and holds the playhead at NOW
function wxToggle() {
  if (layerRowOn('wx')) { wxRemove(); return; }
  state.layers.radar.addTo(state.map);
  state.layers.fcstRadar.addTo(state.map);
}

function renderLayerPills() {
  const el = document.getElementById('layer-pills');
  if (!el) return;
  const on = PILL_LAYERS.filter(([k]) => layerRowOn(k) === true);
  if (!on.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = on.map(([k, key]) =>
    `<button class="layer-pill" data-layer="${k}" title="${esc(t('layers.off'))}">${esc(t(key))} <span class="lp-x">✕</span></button>`).join('') +
    `<button class="layer-pill lp-add" title="${esc(t('layers.more'))}">＋</button>`;
  el.querySelectorAll('.layer-pill[data-layer]').forEach((b) =>
    b.addEventListener('click', () => {
      if (state.pb && !state.pb.live) { pbLayersLockedNote(); return; } // playback owns layer state — same lock as the sheet
      if (b.dataset.layer === 'wx') { wxRemove(); return; } // merged pill drops both underlying layers
      state.map.removeLayer(state.layers[b.dataset.layer]);
    }));
  el.querySelector('.lp-add').addEventListener('click', openLayerSheet);
}

function initLayerPills() {
  const el = L.DomUtil.create('div', 'layer-pills', state.map.getContainer());
  el.id = 'layer-pills';
  el.hidden = true;
  L.DomEvent.disableClickPropagation(el);
  L.DomEvent.disableScrollPropagation(el);
  // the layers control fires these for programmatic adds too (?radar=1, auto-USGS fallback, deep links)
  state.map.on('overlayadd overlayremove', renderLayerPills);
}

/* ---------- grouped layer sheet — the user-facing picker; groups, plain names, subtext ----------
   Rows toggle via map.addLayer/removeLayer on control-registered layers, so the map still fires
   overlayadd/overlayremove — pills, MRMS legend, radar scrub, and camera/LWC lazy-loads keep working. */

// merged (wxUnified) collapses radar + forecast into one virtual 'wx' row; legacy keeps the two separate rows
const WX_RAIN_ROWS = CONFIG.wxUnified
  ? [['wx', '📡', 'layers.wx', 'sheet.s.wx', null, false]]
  : [
    ['radar', '📡', 'layers.radar', 'sheet.s.radar', null, false],
    ['fcstRadar', '🌦', 'layers.fcstradar', 'sheet.s.fcstradar', null, false],
  ];

// [layerKey, iconHtml, nameKey, subKey, provenanceBadge|null, onByDefault, child?, camSub?]
const SHEET_GROUPS = [
  ['sheet.g.base', [
    ['labelBoost', '🔤', 'layers.labels', 'sheet.s.labels', null, true],
  ]],
  ['sheet.g.water', [
    ['gauges', '<span class="gauge-icon cat-moderate"></span>', 'layers.gauges', 'sheet.s.gauges', null, true],
    ['usgs', '📈', 'layers.usgs', 'sheet.s.usgs', null, false],
    ['fcstMax', '<span class="fcst-ring cat-moderate"></span>', 'layers.fcst', 'sheet.s.fcst', null, true],
    ['inundation', '🌊', 'layers.inun', 'sheet.s.inun', null, false],
    ['crossings', '⛔', 'layers.crossings', 'sheet.s.crossings', 'curated', true],
    ['lwc', '📍', 'layers.crossall', 'sheet.s.crossall', 'official', false],
  ]],
  ['sheet.g.rain', WX_RAIN_ROWS.concat([
    ['mrms', '🌧', 'layers.rain', 'sheet.s.rain', null, false],
  ])],
  ['sheet.g.tropical', [
    ['tropical', '🌀', 'layers.tropical', 'sheet.s.tropical', 'official', false],
    ['surge', '🌊', 'layers.surge', 'sheet.s.surge', 'official', false],
  ]],
  ['sheet.g.roads', [
    ['roadClosures', '🚧', 'layers.roads', 'sheet.s.roads', 'official', true],
    ['roadReopen', '<span class="reopen-icon">✓</span>', 'layers.reopen', 'sheet.s.reopen', 'official', false, true],
  ]],
  ['sheet.g.cameras', [
    ['camsFlood', '📷', 'layers.cams.flood', 'sheet.s.cams.flood', 'official', false, true, 'flood'],
    ['camsHays', '📷', 'layers.cams.hays', 'sheet.s.cams.hays', 'official', false, true, 'flood'],
    ['camsRiver', '📷', 'layers.cams.river', 'sheet.s.cams.river', 'official', false, true, 'flood'],
    ['camsTxdot', '📷', 'layers.cams.txdot', 'sheet.s.cams.txdot', 'official', false, true, 'traffic'],
    ['camsHouston', '📷', 'layers.cams.houston', 'sheet.s.cams.houston', 'official', false, true, 'traffic'],
    ['camsAustin', '📷', 'layers.cams.austin', 'sheet.s.cams.austin', 'official', false, true, 'traffic'],
    ['camsArlington', '📷', 'layers.cams.arlington', 'sheet.s.cams.arlington', 'official', false, true, 'traffic'],
    ['camsElpBridge', '📷', 'layers.cams.elpbridge', 'sheet.s.cams.elpbridge', 'official', false, true, 'border'],
  ]],
  ['sheet.g.reports', [
    ['alerts', '⚠️', 'layers.alerts', 'sheet.s.alerts', 'official', true],
    ['lsrs', '💧', 'layers.lsr', 'sheet.s.lsr', 'official', true],
    ['lsrsAged', '🕓', 'layers.lsrhist', 'sheet.s.lsrhist', null, false],
    ['requests', '🆘', 'layers.notices', 'sheet.s.notices', 'curated', true],
    ['shelters', '🏠', 'layers.shelters', 'sheet.s.shelters', 'curated', true],
  ]],
];

// camera sub-groups (flood-first): each source row carries its sub key in tuple[7]
const CAM_SUBGROUPS = [
  ['flood', 'sheet.g.cams.flood'],
  ['traffic', 'sheet.g.cams.traffic'],
  ['border', 'sheet.g.cams.border'],
];

function layerSheetIsOpen() {
  const el = document.getElementById('layer-sheet');
  return !!el && !el.hidden;
}

// one toggle row; identical markup for flat groups and the indented camera children (child flag adds .ls-child)
function lsRowHtml(row, dis) {
  const [k, icon, nameKey, subKey, badge, , child] = row;
  const on = layerRowOn(k); // understands the virtual merged 'wx' row; null = no such layer
  if (on === null) return '';
  return `<button class="ls-row${on ? ' on' : ''}${child ? ' ls-child' : ''}" data-layer="${k}" role="switch" aria-checked="${on}"${dis}>` +
    `<span class="ls-icon">${icon}</span>` +
    `<span class="ls-txt"><span class="ls-name">${esc(t(nameKey))}${badge ? ' ' + srcBadge(badge, 'src-mini') : ''}</span>` +
    `<span class="ls-sub">${esc(t(subKey))}</span></span>` +
    '<span class="ls-knob" aria-hidden="true"></span></button>';
}

// cameras region: disclosure sub-headers per CAM_SUBGROUPS; a group renders open if opened OR any child is ON
function camSubgroupsHtml(rows, dis) {
  let out = '';
  for (const [sub, nameKey] of CAM_SUBGROUPS) {
    const kids = rows.filter((r) => r[7] === sub);
    if (!kids.length) continue;
    const onCount = kids.filter((r) => state.layers[r[0]] && state.map.hasLayer(state.layers[r[0]])).length;
    const open = state.lsCamOpen.has(sub) || onCount > 0;
    out += `<button class="ls-subhead" data-sub="${sub}" aria-expanded="${open}">` +
      '<span class="ls-sub-caret" aria-hidden="true">▸</span>' +
      `<span class="ls-sub-name">${esc(t(nameKey))}</span>` +
      (onCount ? `<span class="ls-sub-count">${esc(t('sheet.cams.non').replace('{n}', onCount))}</span>` : '') +
      '</button>' +
      `<div class="ls-subrows" data-sub="${sub}"${open ? '' : ' hidden'}>` +
      kids.map((r) => lsRowHtml(r, dis)).join('') +
      '</div>';
  }
  return out;
}

function renderLayerSheet() {
  const el = document.getElementById('layer-sheet');
  if (!el) return;
  el.querySelector('.ls-head strong').textContent = t('sheet.title');
  el.querySelector('.ls-close').title = t('risk.close');
  const locked = !!(state.pb && !state.pb.live); // playback swaps its own layers — sheet goes read-only
  const note = el.querySelector('.ls-note');
  note.hidden = !locked;
  if (locked) note.textContent = t('sheet.locked');
  const dis = locked ? ' disabled' : '';
  const seg = '<div class="ls-base" role="group">' + ['dark', 'light', 'streets'].map((b) =>
    `<button class="ls-base-btn${state.activeBase === b ? ' on' : ''}" data-base="${b}"${dis}>${esc(t(`sheet.base.${b}`))}</button>`).join('') + '</div>';
  let html = '';
  for (const [gKey, rows] of SHEET_GROUPS) {
    html += `<div class="ls-group">${esc(t(gKey))}</div>`;
    if (gKey === 'sheet.g.base') html += seg;
    if (gKey === 'sheet.g.cameras') { html += camSubgroupsHtml(rows, dis); continue; }
    for (const row of rows) html += lsRowHtml(row, dis);
  }
  html += `<div class="ls-group">${esc(t('sheet.g.history'))}</div>` +
    `<button class="ls-row ls-pbrow" data-act="playback"${dis}><span class="ls-icon">⏮</span>` +
    `<span class="ls-txt"><span class="ls-name">${esc(t('sheet.playback'))}</span><span class="ls-sub">${esc(t('sheet.s.playback'))}</span></span>` +
    '<span class="ls-knob ls-go" aria-hidden="true">›</span></button>' +
    `<button class="ls-reset"${dis} title="${esc(t('sheet.reset.title'))}">↺ ${esc(t('sheet.reset'))}</button>`;
  el.querySelector('.ls-body').innerHTML = html;
}

function layerSheetSync() { if (layerSheetIsOpen()) renderLayerSheet(); }

function openLayerSheet() {
  const el = document.getElementById('layer-sheet');
  if (!el) return;
  renderLayerSheet();
  const panel = el.querySelector('.ls-panel');
  if (window.innerWidth > 768) {
    // desktop: compact panel anchored where the stock control sat (map top-right)
    const r = document.getElementById('map').getBoundingClientRect();
    panel.style.top = `${Math.max(10, r.top + 10)}px`;
    panel.style.right = `${Math.max(10, window.innerWidth - r.right + 10)}px`;
  } else { panel.style.top = ''; panel.style.right = ''; }
  el.hidden = false;
}

function closeLayerSheet() {
  const el = document.getElementById('layer-sheet');
  if (el) el.hidden = true;
}

function onLayerSheetClick(e) {
  if (state.pb && !state.pb.live) return; // read-only while playback is engaged
  const baseBtn = e.target.closest('.ls-base-btn');
  if (baseBtn) {
    if (state.activeBase !== baseBtn.dataset.base) {
      Object.values(state.baseLayers).forEach((l) => state.map.removeLayer(l));
      state.baseLayers[baseBtn.dataset.base].addTo(state.map); // registered base — fires baselayerchange (theme/persist/sync)
    }
    return;
  }
  if (e.target.closest('.ls-reset')) { layerSheetReset(); return; }
  const sub = e.target.closest('.ls-subhead');
  if (sub) {
    const key = sub.dataset.sub;
    if (state.lsCamOpen.has(key)) state.lsCamOpen.delete(key);
    else state.lsCamOpen.add(key);
    renderLayerSheet();
    return;
  }
  const row = e.target.closest('.ls-row');
  if (!row) return;
  if (row.dataset.act === 'playback') { closeLayerSheet(); openPlayback(); return; }
  if (row.dataset.layer === 'wx') { wxToggle(); return; } // merged row toggles both underlying layers together
  const lyr = state.layers[row.dataset.layer];
  if (!lyr) return;
  if (state.map.hasLayer(lyr)) state.map.removeLayer(lyr);
  else lyr.addTo(state.map); // registered overlay — map fires overlayadd (lazy loads, legends, pills, sheet sync)
}

// default view: default overlays on, extras off, Streets base, Full AO framing (same bounds as the AO chip)
function layerSheetReset() {
  for (const [, rows] of SHEET_GROUPS) {
    for (const r of rows) {
      if (r[0] === 'wx') { if (!r[5] && layerRowOn('wx')) wxRemove(); continue; } // virtual merged row: off by default
      const lyr = state.layers[r[0]];
      if (!lyr) continue;
      const on = state.map.hasLayer(lyr);
      if (r[5] && !on) lyr.addTo(state.map);
      else if (!r[5] && on) state.map.removeLayer(lyr);
    }
  }
  if (state.activeBase !== 'streets') {
    Object.values(state.baseLayers).forEach((l) => state.map.removeLayer(l));
    state.baseLayers.streets.addTo(state.map);
  }
  state.lsCamOpen.clear(); // reset returns the camera sub-groups to all-collapsed
  state.map.fitBounds(AO_PRESETS[0][1]);
  renderLayerSheet();
}

function initLayerSheet() {
  const el = document.createElement('div');
  el.id = 'layer-sheet';
  el.hidden = true;
  el.innerHTML = '<div class="ls-backdrop"></div>' +
    '<div class="ls-panel" role="dialog" aria-modal="true"><div class="ls-grab"></div>' +
    '<div class="ls-head"><strong></strong><button class="ls-close">✕</button></div>' +
    '<div class="ls-note" hidden></div><div class="ls-body"></div></div>';
  document.body.appendChild(el);
  el.querySelector('.ls-backdrop').addEventListener('click', closeLayerSheet);
  el.querySelector('.ls-close').addEventListener('click', closeLayerSheet);
  el.querySelector('.ls-body').addEventListener('click', onLayerSheetClick);
  // phone: a downward swipe from the grab bar / header dismisses the bottom sheet
  const panel = el.querySelector('.ls-panel');
  let y0 = null;
  panel.addEventListener('touchstart', (e) => {
    y0 = e.target.closest('.ls-grab, .ls-head') ? e.touches[0].clientY : null;
  }, { passive: true });
  panel.addEventListener('touchend', (e) => {
    if (y0 !== null && e.changedTouches[0].clientY - y0 > 55) closeLayerSheet();
    y0 = null;
  }, { passive: true });
  state.map.on('overlayadd overlayremove baselayerchange', layerSheetSync);
  registerModal(el, { focusEl: '.ls-panel' }); // trap within the panel; #layer-sheet toggles hidden
}

/* ---------- unified radar timeline (v0.96) — observed RainViewer past | NOW | HRRR model future ----------
   One bar owns radar time: the past segment replays preloaded observed frames (opacity crossfade),
   the future segment steps preloaded per-hour HRRR layers by opacity (no per-step tile reload).
   Honesty contract: the future zone flips the bar to amber dashed + FORECAST MODEL badge; the +12h
   run-mixing cap stays; the whole bar hides during playback (the playback bar owns time there). */

const RTL_PAST_STEP_MS = 700;
const RTL_FCST_STEP_MS = 900; // model hours get a beat longer — an hour of weather per step
const RTL_RADAR_OPACITY = 0.75; // 0.6 washed out over the bright Streets base
const FCST_OPACITY = 0.7;
const FCST_WMS_PX = 256; // native 256px render; the .fcst-tiles blur already softens HRRR's ~3km cell edges

const fcstLayerName = (h) => `refd_${String(h * 60).padStart(4, '0')}`;

// past segment on = radar group with fetched frames; future segment on = HRRR layer enabled
function rtlDomain() {
  const pastN = state.map.hasLayer(state.layers.radar) && state.radar ? state.radar.frames.length : 0;
  const fN = state.map.hasLayer(state.layers.fcstRadar) ? CONFIG.hrrrMaxHours : 0;
  return { pastN, fN, nowIdx: pastN - 1, total: pastN + fN };
}

// re-derive the bar from layer state: visibility, slider domain, NOW divider + future-segment geometry
function rtlSync() {
  const bar = $('#radar-scrub'), rtl = state.rtl;
  const R = rtlDomain();
  const on = state.map.hasLayer(state.layers.radar) || state.map.hasLayer(state.layers.fcstRadar);
  bar.hidden = !on || !!(state.pb && !state.pb.live);
  $('#wx-legend').hidden = bar.hidden; // combined legend rides with the scrubber
  if (bar.hidden) { rtlStopPlay(); return; }
  $('#rs-slider').max = Math.max(R.total - 1, 0);
  if (!R.pastN && R.fN) { rtl.fut = true; rtl.hour = Math.min(rtl.hour || 1, R.fN); rtl.idx = R.nowIdx + rtl.hour; }
  else if (rtl.fut && R.fN) { rtl.hour = Math.min(rtl.hour || 1, R.fN); rtl.idx = R.nowIdx + rtl.hour; }
  else if (rtl.fut) { rtl.fut = false; rtl.idx = Math.max(R.nowIdx, 0); }
  else rtl.idx = Math.max(0, Math.min(rtl.idx, Math.max(R.total - 1, 0)));
  const divider = $('#rs-now'), futSeg = $('#rs-future');
  const frac = R.total > 1 ? (Math.max(R.nowIdx, 0) / (R.total - 1)) * 100 : 0;
  divider.hidden = !(R.pastN > 0 && R.fN > 0);
  if (!divider.hidden) divider.style.left = `${frac}%`;
  futSeg.hidden = !R.fN;
  if (R.fN) futSeg.style.left = R.pastN ? `${frac}%` : '0';
}

function rtlSet(i) {
  if (state.pb && !state.pb.live) return; // playback replays IEM archive radar — live frames must stay dark
  const R = rtlDomain();
  if (!R.total) return;
  const rtl = state.rtl, r = state.radar;
  rtl.idx = Math.max(0, Math.min(i, R.total - 1));
  rtl.fut = rtl.idx > R.nowIdx;
  if (rtl.fut) rtl.hour = rtl.idx - R.nowIdx;
  $('#rs-slider').value = rtl.idx;
  if (rtl.fut) {
    if (r) { r.idx = R.nowIdx; r.frameLayers.forEach((l) => l.setOpacity(0)); }
    fcstShow(rtl.hour);
  } else {
    fcstHide();
    if (r) {
      r.idx = rtl.idx;
      r.frameLayers.forEach((l, j) => l.setOpacity(j === rtl.idx ? RTL_RADAR_OPACITY : 0));
    }
  }
  rtlUpdateLabel(R);
}

function rtlUpdateLabel(R) {
  const rtl = state.rtl, label = $('#rs-label');
  // combined-legend source: observed until the RainViewer nowcast seam, forecast beyond (nowcast + HRRR)
  const wxFcst = !R.pastN || (state.radar && rtl.idx >= state.radar.castStart);
  $('#wx-legend-src').textContent = t(wxFcst ? 'leg.wx.fcst' : 'leg.wx.obs');
  $('#radar-scrub').classList.toggle('rs-future', rtl.fut);
  $('#rs-badge').hidden = !rtl.fut;
  if (rtl.fut) {
    const f = state.fcst;
    let txt = `+${rtl.hour}h`;
    if (f.runIso) {
      const valid = new Date(new Date(f.runIso).getTime() + rtl.hour * 3600000).toISOString();
      txt += ` · ${fmtCT(valid)}`;
      label.title = t('fcst.run').replace('{t}', fmtCT(f.runIso));
    } else label.title = '';
    label.textContent = txt;
    label.classList.add('projected');
    return;
  }
  label.title = '';
  const r = state.radar;
  if (!R.pastN || !r) { label.textContent = '…'; label.classList.remove('projected'); return; }
  const dMin = Math.round((r.frames[rtl.idx].time - r.frames[r.nowIdx].time) / 60);
  label.textContent = dMin === 0 ? 'now' : dMin < 0 ? `${dMin >= -110 ? dMin + 'm' : Math.round(dMin / 6) / 10 + 'h'}` : `+${dMin}m PROJECTED`;
  label.classList.toggle('projected', rtl.idx >= r.castStart);
}

function rtlStopPlay() {
  const rtl = state.rtl;
  if (rtl.timer) { clearTimeout(rtl.timer); rtl.timer = null; }
  rtl.playing = false;
  $('#rs-play').textContent = '▶';
}

// loops observed → NOW → forecast, then restarts; observed-only (or forecast-only) when one segment is off
function rtlTogglePlay() {
  const rtl = state.rtl;
  if (rtl.playing) { rtlStopPlay(); return; }
  if (!rtlDomain().total) return;
  rtl.playing = true;
  $('#rs-play').textContent = '⏸';
  const step = () => {
    const R = rtlDomain();
    if (!R.total) { rtlStopPlay(); return; }
    rtlSet((rtl.idx + 1) % R.total);
    rtl.timer = setTimeout(step, rtl.fut ? RTL_FCST_STEP_MS : RTL_PAST_STEP_MS);
  };
  rtl.timer = setTimeout(step, rtl.fut ? RTL_FCST_STEP_MS : RTL_PAST_STEP_MS);
}

// bounded per-tile reload so a tile dropped under the enable-time burst recovers instead of staying
// permanently blank; capped so genuinely-missing tiles never loop (RainViewer 200s no-data, 404s rare)
const TILE_RETRY_MAX = 3;
const tileRetries = new WeakMap();
function attachTileRetry(layer) {
  layer.on('tileerror', (e) => {
    const img = e.tile;
    if (!img || !img.src) return;
    const n = tileRetries.get(img) || 0;
    if (n >= TILE_RETRY_MAX) return;
    tileRetries.set(img, n + 1);
    const base = img.src.replace(/[?&]_rtry=\d+/, '').replace(/[?&]$/, '');
    const sep = base.includes('?') ? '&' : '?';
    setTimeout(() => { img.src = `${base}${sep}_rtry=${n + 1}`; }, 400 + n * 300);
  });
}

// mount the visible frame first (loads with uncontended bandwidth), then add the rest deferred once
// it paints (or a short fallback); end state is all-frames-mounted so stepping stays opacity-only
function radarMountFramesDeferred(r, primaryIdx) {
  const group = state.layers.radar, layers = r.frameLayers;
  const primary = layers[primaryIdx];
  if (primary) group.addLayer(primary);
  let mounted = false;
  const mountRest = () => {
    if (mounted) return;
    mounted = true;
    if (state.radar !== r) return; // a newer refresh superseded this frame set
    layers.forEach((l, j) => { if (j !== primaryIdx && !group.hasLayer(l)) group.addLayer(l); });
  };
  if (!primary) { mountRest(); return; }
  primary.once('load', mountRest);
  setTimeout(mountRest, 1200); // fallback when the visible frame paints no tiles (offscreen)
}

async function fetchRadarFrames() {
  const res = await fetch(CONFIG.rainviewerApi);
  if (!res.ok) throw new Error(`RainViewer HTTP ${res.status}`);
  const d = await res.json();
  const past = (d.radar && d.radar.past) || []; // full published history (~2h @ 10-min steps)
  const cast = (d.radar && d.radar.nowcast) || [];
  if (!past.length) throw new Error('no radar frames');
  const keepIdx = state.radar ? state.radar.idx : -1;
  const wasPlaying = state.rtl.playing;
  rtlStopPlay();
  state.radar = { host: d.host, frames: past.concat(cast), castStart: past.length, nowIdx: past.length - 1, idx: past.length - 1, frameLayers: [] };
  const r = state.radar;
  state.layers.radar.clearLayers();
  r.frameLayers = r.frames.map((f) => L.tileLayer(`${r.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`, {
    pane: 'radar', opacity: 0, maxNativeZoom: 7, maxZoom: 19, updateWhenIdle: false, className: 'rtl-xfade', attribution: 'Radar: RainViewer',
  }));
  r.frameLayers.forEach(attachTileRetry);
  const rf = parseInt(new URLSearchParams(location.search).get('rf'), 10); // debug/deep-link: initial frame index
  const primaryIdx = (state.rtl.wantNow || state.rtl.fut) ? r.nowIdx
    : keepIdx >= 0 && keepIdx < r.frames.length ? keepIdx
      : rf >= 0 && rf < r.frames.length ? rf : r.nowIdx;
  radarMountFramesDeferred(r, primaryIdx); // visible frame loads first; rest mount deferred (opacity-only after)
  rtlSync();
  if (state.rtl.wantNow) { state.rtl.wantNow = false; rtlSet(r.nowIdx); } // merged enable: land on NOW once observed frames arrive
  else if (state.rtl.fut) rtlSet(state.rtl.idx); // playhead in the model future; new frames only reshape the past segment
  else rtlSet(primaryIdx);
  if (wasPlaying) rtlTogglePlay();
}

/* per-hour HRRR layers — one WMS layer per forecast hour, mounted at opacity 0 like a radar frame;
   stepping is a pure opacity swap (never a per-step fetch-gated fade), so play never stalls */

const FCST_WIN_BEHIND = 1; // sliding preload window around the playhead; bounds the concurrent WMS load on mobile
const FCST_WIN_AHEAD = 3;  // lead enough at the play cadence that an hour paints before it is shown

// one supersampled, mobile-tuned HRRR hour layer (mirrors the observed-radar frame tuning), mounted at opacity 0
function fcstMakeHourLayer(h) {
  const l = L.tileLayer.wms(CONFIG.hrrrWmsUrl, {
    layers: fcstLayerName(h), format: 'image/png', transparent: true, version: '1.1.1',
    opacity: 0, pane: 'radar', maxNativeZoom: 7, maxZoom: 19, updateWhenIdle: false,
    className: 'fcst-tiles rtl-xfade',
    attribution: 'Forecast radar: NOAA HRRR model via <a href="https://mesonet.agron.iastate.edu/">IEM</a>',
  });
  l.wmsParams.width = l.wmsParams.height = FCST_WMS_PX; // render size (initialize() pins these to tileSize)
  if (state.fcst.runIso) l.wmsParams._run = state.fcst.runIso; // stay on the same run as its already-mounted siblings
  attachTileRetry(l);
  return l;
}

// mount the hours around the playhead (created once, then persist like radar frames); bounds the enable burst
function fcstEnsureWindow(h) {
  const lo = Math.max(1, h - FCST_WIN_BEHIND), hi = Math.min(CONFIG.hrrrMaxHours, h + FCST_WIN_AHEAD);
  for (let hr = lo; hr <= hi; hr++) {
    if (state.fcst.hourLayers[hr - 1]) continue;
    const l = fcstMakeHourLayer(hr);
    state.fcst.hourLayers[hr - 1] = l;
    state.layers.fcstRadar.addLayer(l);
  }
}

// show forecast hour h by opacity only (window-mounts nearby hours); never reloads the visible frame
function fcstShow(h) {
  h = Math.max(1, Math.min(h, CONFIG.hrrrMaxHours));
  fcstEnsureWindow(h);
  state.fcst.hourLayers.forEach((l, j) => { if (l) l.setOpacity(j === h - 1 ? FCST_OPACITY : 0); });
}

function fcstHide() {
  state.fcst.hourLayers.forEach((l) => { if (l) l.setOpacity(0); });
}

// merged enable: with observed radar present hold the playhead at NOW; forecast-only lands on +1h so the model shows at once
function fcstEnable() {
  fcstFetchRun();
  rtlSync();
  const R = rtlDomain();
  if (R.pastN) { state.rtl.fut = false; state.rtl.hour = 1; rtlSet(R.nowIdx); }
  else { state.rtl.wantNow = state.map.hasLayer(state.layers.radar); rtlSet(R.nowIdx + 1); }
}

function fcstDisable() {
  fcstHide();
  const wasFut = state.rtl.fut;
  state.rtl.fut = false;
  state.rtl.hour = 1; // contract: every re-enable starts at +1h (or NOW when radar is present)
  state.rtl.wantNow = false;
  rtlSync();
  const R = rtlDomain();
  if (!R.total) { rtlStopPlay(); return; }
  if (wasFut) rtlSet(R.nowIdx); // playhead falls back to NOW
}

// run stamp from IEM's per-layer metadata JSON; a new model run cache-busts every mounted hour's WMS tiles
function fcstFetchRun() {
  fetch(CONFIG.hrrrMetaUrl(60)).then((r) => (r.ok ? r.json() : null)).then((d) => {
    const f = state.fcst;
    if (!f || !d || !d.model_init_utc || f.runIso === d.model_init_utc) return;
    const stale = f.runIso !== null;
    f.runIso = d.model_init_utc;
    if (stale) {
      f.hourLayers.forEach((l) => { if (l) l.setParams({ _run: f.runIso }); }); // vendor param busts each mounted hour's cache
      if (state.rtl.fut) fcstShow(state.rtl.hour); // repaint the visible hour onto the new run
    }
    if (state.rtl.fut) rtlUpdateLabel(rtlDomain());
  }).catch(() => { /* metadata is decorative — the scrub still works with +Nh labels only */ });
}

/* ---------- historical playback (v0.82) — replay archived gauge frames over 3d/7d/14d ----------
   Honest by design: only layers with a real archive replay (gauges from data/history.json,
   radar from IEM archive tiles); alerts/roads/LSRs stay live and the bar says so. */

const PB_RADAR_URL = (stamp) => `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-${stamp}/{z}/{x}/{y}.png`;
// archived MRMS accumulations (probed 2026-07-18: mrms::p{1,24,48,72}h-YYYYMMDDHHMM serves tiles, hourly stamps only)
const PB_MRMS_URL = (w, stamp) => `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/mrms::p${parseInt(w, 10)}h-${stamp}/{z}/{x}/{y}.png`;
const PB_BASE_FRAME_MS = 500; // 1x is ~2 fps — slow enough to read the story (owner ask)
const PB_SPEEDS = [0.5, 1, 2, 4];
const PB_CAT_NAMES = ['none', 'action', 'minor', 'moderate', 'major'];
// prominence: playback-only marker scale — majors ≈ 2× the live size so threats-to-life read first
const PB_CAT_SIZE = { major: 32, moderate: 20, minor: 12, action: 10, none: 7 };
const PB_PULSE_FRAMES = 3;   // category-change ring decays over ~3 frames — visual only
const PB_LABEL_MAX = 5;
const PB_LABEL_MIN_ZOOM = 8;
const PB_ROAD_GLYPH = { Closure: '⛔', Flooding: '🌊', Damage: '⚠' };
const PB_FLOW_MAX = 3;
const PB_RIVER_SPLIT = / (?:at|near|below|above) /i;

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

/* time-integrity sweep (v0.93): every live overlay either replays from a real archive, re-renders
   as-of the frame from item timestamps, or hides — nothing live may impersonate the past. */
const PB_LIVE_HIDE = [
  ['shelters', 'layers.shelters'],
  ['camsTxdot', 'layers.cams.txdot'],
  ['camsRiver', 'layers.cams.river'],
  ['camsAustin', 'layers.cams.austin'],
  ['camsFlood', 'layers.cams.flood'],
  ['camsHouston', 'layers.cams.houston'],
  ['camsArlington', 'layers.cams.arlington'],
  ['camsElpBridge', 'layers.cams.elpbridge'],
  ['camsHays', 'layers.cams.hays'],
  ['usgs', 'layers.usgs'],
  ['fcstMax', 'layers.fcst'],
  ['fcstRadar', 'layers.fcstradar'],
  ['inundation', 'layers.inun'],
];
const PB_LSR_SHOW_MS = 3 * 3600000; // a storm report stays on the frame for 3h after its valid time
const PB_STORY_TYPES = { evacuation: ['playback.story.evac', 6], cutoff: ['playback.story.cutoff', 6], shelter: ['playback.story.shelter', 4], rescue: ['playback.story.rescue', 5] };

// wrap a live popup (element or html string) with the playback frame stamp
function pbCuratedPopup(content) {
  const wrap = document.createElement('div');
  if (typeof content === 'string') wrap.innerHTML = content;
  else wrap.appendChild(content);
  const meta = document.createElement('div');
  meta.className = 'popup-meta';
  meta.style.cssText = 'color:var(--sev-warning);font-weight:700';
  meta.textContent = `⏮ ${t('playback.pill')} · ${fmtCT(state.pbData.frames[state.pb.idx].t)}`;
  wrap.appendChild(meta);
  return wrap;
}

// device 7d LSR history + the live feed, deduped on the same key recordLsrHist uses
function pbLsrRecords() {
  const seen = new Map(Object.entries(state.hist.lsrs || {}));
  for (const f of state.lsrs || []) {
    if (!f.geometry || !Array.isArray(f.geometry.coordinates)) continue;
    const [lon, lat] = f.geometry.coordinates;
    const p = f.properties;
    seen.set(`${p.valid}|${lat}|${lon}`, {
      t: p.valid, lat, lon, typetext: p.typetext, magnitude: p.magnitude, unit: p.unit,
      city: p.city, county: p.county, source: p.source, remark: p.remark,
    });
  }
  return [...seen.values()];
}

// rebuilt at each engage from current curated data; markers toggle per frame (no re-create churn)
function pbBuildCurated() {
  state.layers.pbCurated = state.layers.pbCurated || L.layerGroup();
  state.layers.pbCurated.clearLayers();
  state.pbCuratedMarks = [];
  const add = (src, m, t0, t1) => {
    state.layers.pbCurated.addLayer(m);
    state.pbCuratedMarks.push({ src, m, t0, t1 });
  };
  for (const r of allRequests()) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon) || !r.ts) continue;
    const t0 = new Date(r.ts).getTime();
    if (!Number.isFinite(t0)) continue;
    const t1 = t0 + (CONFIG.agedCardMinsByType[r.type] || CONFIG.agedCardMins) * 60000;
    if (r.type === 'cutoff' && r.radiusMi > 0 && r.status !== 'resolved') {
      add('requests', L.circle([r.lat, r.lon], {
        radius: r.radiusMi * 1609.34, className: 'cutoff-circle', weight: 2, fillOpacity: 0.07,
      }).bindPopup(() => pbCuratedPopup(cutoffPopup(r))), t0, t1);
    }
    const icon = L.divIcon({
      className: '',
      html: `<div class="req-icon pri-${esc(r.priority)}${r.status === 'resolved' ? ' resolved' : ''}">${TYPE_GLYPH[r.type] || '📍'}</div>`,
      iconSize: [26, 26], iconAnchor: [4, 26],
    });
    add('requests', L.marker([r.lat, r.lon], { icon }).bindPopup(() => pbCuratedPopup(reqPopup(r))), t0, t1);
  }
  // crossing status is only known from its curator update forward — hidden before updated_at
  for (const c of state.crossings || []) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon) || !c.updated_at) continue;
    const t0 = new Date(c.updated_at).getTime();
    if (!Number.isFinite(t0)) continue;
    const st = CROSSING_STATUS[c.status] || CROSSING_STATUS.caution;
    const icon = L.divIcon({ className: '', html: `<div class="crossing-icon" style="border-color:${st.color};color:${st.color}">${st.glyph}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
    add('crossings', L.marker([c.lat, c.lon], { icon }).bindPopup(() => pbCuratedPopup(
      `<div class="popup-title" style="color:${st.color}">${st.glyph} ${st.label} · crossing</div><div>${esc(c.name)} ${srcBadge('curated')}</div>` +
      `<div class="popup-meta">${esc(c.reason || '')}</div><div class="popup-meta">Updated ${esc(fmtCT(c.updated_at))}</div>`)), t0, Infinity);
  }
  for (const e of pbLsrRecords()) {
    const t0 = new Date(e.t).getTime();
    if (!Number.isFinite(t0) || !Number.isFinite(e.lat) || !Number.isFinite(e.lon)) continue;
    const icon = L.divIcon({ className: '', html: '<div class="lsr-icon">💧</div>', iconSize: [22, 22] });
    add('lsr', L.marker([e.lat, e.lon], { icon }).bindPopup(() => pbCuratedPopup(lsrPopupHtml(e))), t0, t0 + PB_LSR_SHOW_MS);
  }
}

// deep-link engage (?playback=1&pbt=) can precede the seed/LSR fetches — rebuild as-of-frame data when they land
function pbRefreshCurated() {
  const pb = state.pb;
  if (!pb || pb.live || !state.pbData) return;
  pbBuildCurated();
  pbPaintCurated(state.pbData.frames[pb.idx]);
  pbBuildStory();
  pbUpdateCaption();
}

function pbPaintCurated(frame) {
  const pb = state.pb;
  if (!state.pbCuratedMarks || !pb) return;
  for (const x of state.pbCuratedMarks) {
    const el = x.m.getElement && x.m.getElement();
    if (!el) continue;
    const show = (pb.curatedOn || {})[x.src] && x.t0 <= frame._t && frame._t < x.t1;
    el.style.display = show ? '' : 'none';
  }
}

function pbMrmsStampAt(tMs) {
  const d = new Date(Math.floor(tMs / 3600000) * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}00`;
}
const pbMrmsStamp = () => pbMrmsStampAt(state.pbData.frames[state.pb.idx]._t);

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
  state.pbRoadsFromT = d.roadsFrom ? new Date(d.roadsFrom).getTime() : Infinity;
  // chapter marks: major-peak gauges from the crest summary, most significant first (best-effort)
  try {
    const cs = await fetch(`data/crest-summary.json?_=${Math.floor(Date.now() / 300000)}`).then((r) => (r.ok ? r.json() : null));
    state.pbCrests = (cs && cs.gauges) || [];
    state.pbChapters = state.pbCrests.filter((g) => g.peak_category === 'major').slice(0, 8);
  } catch { state.pbCrests = []; state.pbChapters = []; }
  state.pbRecordPct = {};
  for (const g of state.pbCrests) { if (g.record && g.record.peak_pct > 0) state.pbRecordPct[g.lid] = g.record.peak_pct; }
  pbBuildCrestFlows();
  return d;
}

/* crest-flow detection (v0.91, illustrative): a crest translating between two gauges on the SAME
   river — consecutive moderate/major peaks (crest summary) ordered by peak time, sanity-gated on
   gap and distance. Drawn as a straight dashed line: honestly schematic, never traced geometry. */
function pbBuildCrestFlows() {
  state.pbFlows = [];
  const gi = state.pbData.gaugeIndex;
  const byRiver = {};
  for (const g of state.pbCrests || []) {
    if (g.stale || !['moderate', 'major'].includes(g.peak_category) || !gi[g.lid]) continue;
    const river = String(g.name || '').split(PB_RIVER_SPLIT)[0].trim();
    if (!river) continue;
    (byRiver[river] = byRiver[river] || []).push(g);
  }
  for (const list of Object.values(byRiver)) {
    list.sort((a, b) => new Date(a.peak_time) - new Date(b.peak_time));
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i], b = list[i + 1];
      const t0 = new Date(a.peak_time).getTime(), t1 = new Date(b.peak_time).getTime();
      const dtH = (t1 - t0) / 3600000;
      if (!(dtH >= 1 && dtH <= 96)) continue; // same-moment peaks or unrelated events: not a translation
      const A = gi[a.lid], B = gi[b.lid];
      const mi = distMi(A.lat, A.lon, B.lat, B.lon);
      if (mi < 3 || mi > 150) continue;
      state.pbFlows.push({
        key: `${a.lid}>${b.lid}`, t0, t1, a: A, b: B, line: null, lbl: null,
        rank: Math.max(CAT_RANK[a.peak_category] || 0, CAT_RANK[b.peak_category] || 0),
      });
    }
  }
}

function pbPaintFlows(frame) {
  if (!state.pbFlows || !state.layers.pbFlows) return;
  const act = state.pbFlows.filter((f) => f.t0 <= frame._t && frame._t <= f.t1)
    .sort((x, y) => y.rank - x.rank).slice(0, PB_FLOW_MAX);
  const key = act.map((f) => f.key).join(',');
  if (key === state.pbFlowKey) return;
  state.pbFlowKey = key;
  state.layers.pbFlows.clearLayers();
  for (const f of act) {
    if (!f.line) {
      f.line = L.polyline([[f.a.lat, f.a.lon], [f.b.lat, f.b.lon]], {
        className: 'pb-crest-line', color: cssVar('--cat-major') || '#e5342f',
        weight: 3, opacity: 0.85, dashArray: '10 8', interactive: false,
      });
      f.lbl = L.marker([(f.a.lat + f.b.lat) / 2, (f.a.lon + f.b.lon) / 2], {
        interactive: false, keyboard: false,
        icon: L.divIcon({ className: '', html: `<div class="pb-crest-lbl">▸ ${esc(t('playback.crestflow'))}</div>`, iconSize: [0, 0] }),
      });
    }
    state.layers.pbFlows.addLayer(f.line).addLayer(f.lbl);
  }
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
      if (!reopenIsFlood(r)) continue;
      const rt = new Date(r.reopenedAt).getTime();
      if (!(rt >= pb.loT && rt <= pb.hiT)) continue;
      ev.push({ t: rt, iso: r.reopenedAt, pri: 3, text: t('playback.story.reopen').replace('{road}', prettyRoute(r.route_name) || 'road') });
    }
  } catch { /* road memory unavailable — reopen captions simply absent */ }
  // closure-onset captions from the posted start times in the archived road index
  for (const r of Object.values(state.pbData.roadIndex || {})) {
    const st = new Date(r.start).getTime();
    if (!Number.isFinite(st) || st < pb.loT || st > pb.hiT) continue;
    const ct = ROAD_COND[r.cond] || ROAD_COND_FALLBACK;
    ev.push({
      t: st, iso: r.start, pri: 3,
      text: `${PB_ROAD_GLYPH[r.cond] || '🚧'} ${t('playback.story.road').replace('{road}', prettyRoute(r.route) || 'road').replace('{cond}', ct.label)}`,
    });
  }
  // critical-notice / cut-off / evacuation / shelter events from curated timestamps
  for (const r of allRequests()) {
    if (!r.ts) continue;
    const rt = new Date(r.ts).getTime();
    if (!Number.isFinite(rt) || rt < pb.loT || rt > pb.hiT) continue;
    const sig = PB_STORY_TYPES[r.type] || (r.priority === 'critical' ? ['playback.story.critical', 5] : null);
    if (!sig) continue;
    ev.push({
      t: rt, iso: r.ts, pri: sig[1],
      text: `${TYPE_GLYPH[r.type] || '🆘'} ${t(sig[0]).replace('{place}', r.place || r.county || '').replace('{type}', r.type)}`,
    });
  }
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
    (state.pbData.roadIndex ? ` · <span>⛔ ${(frame.roads || []).length}</span>` : '') +
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
  if (!state.pb) state.pb = { days: 3, idx: state.pbData.frames.length - 1, live: true, playing: false, raf: null, lastStep: 0, speed: 0.5, capKey: null };
  state.pb.speed = 0.5; // every entry resets to the readable default; a changed speed lasts only until close
  $('#playback-bar').hidden = false;
  $('#pb-speed').textContent = `${state.pb.speed}×`;
  pill.classList.add('open');
  document.body.classList.add('pb-bar-open');
  pbSheetMin();
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

// playback collapses the phone bottom sheet so the map owns the screen; prior state restores on exit/NOW
function pbSheetMin() {
  if (window.innerWidth > 768 || typeof setSheet !== 'function') return;
  const main = document.querySelector('main');
  const cur = SHEET_STATES.find((s) => main.classList.contains(s));
  if (!cur || cur === 'sheet-peek') return;
  state.pbPrevSheet = cur;
  setSheet('sheet-peek');
}
function pbSheetRestore() {
  const prev = state.pbPrevSheet;
  state.pbPrevSheet = null;
  if (!prev || typeof setSheet !== 'function') return;
  // a manual resize during playback wins — only snap back if the pane is still where playback put it
  if (document.querySelector('main').classList.contains('sheet-peek')) setSheet(prev);
}

// window = chosen 3/7/14d; the slider track spans the full request, frames clip to the archive —
// the pre-archive gap renders hatched, never faked with empty frames
function setPlaybackRange(days) {
  const pb = state.pb, frames = state.pbData.frames;
  pb.days = days;
  pb.winLoT = Date.now() - days * 86400000;
  pb.loT = Math.max(pb.winLoT, frames[0]._t);
  pb.hiT = frames[frames.length - 1]._t;
  document.querySelectorAll('.pb-chip').forEach((b) => b.classList.toggle('on', +b.dataset.days === days));
  const sl = $('#pb-slider');
  sl.min = pb.winLoT;
  sl.max = pb.hiT;
  sl.step = 60000;
  renderPlaybackPreArchive();
  renderPlaybackTicks();
  pbBuildStory();
  if (pb.live) { sl.value = pb.hiT; updatePlaybackReadout(); } else setPlaybackFrame(pb.idx);
  updatePlaybackNote();
}

function renderPlaybackPreArchive() {
  const pb = state.pb, frames = state.pbData.frames;
  const el = $('#pb-prearch');
  const frac = (frames[0]._t - pb.winLoT) / (pb.hiT - pb.winLoT || 1);
  el.hidden = frac <= 0.004;
  el.style.width = `${Math.min(Math.max(frac, 0), 1) * 100}%`;
  if (!el.hidden) pbFlashArchNote();
}

// transient flash of the sheet's locked message — layer pills share the playback read-only regime
function pbLayersLockedNote() {
  const el = $('#pb-arch-note');
  if (!el) return;
  el.textContent = t('sheet.locked');
  el.hidden = false;
  clearTimeout(state.pbArchNoteTimer);
  state.pbArchNoteTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

// one prominent flash per session the first time a chosen range reaches before the archive's birth
function pbFlashArchNote() {
  if (state.pbArchNoted) return;
  state.pbArchNoted = true;
  const el = $('#pb-arch-note');
  el.textContent = t('playback.archnote').replace('{t}', fmtCT(state.pbData.frames[0].t));
  el.hidden = false;
  clearTimeout(state.pbArchNoteTimer);
  state.pbArchNoteTimer = setTimeout(() => { el.hidden = true; }, 3000);
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
    b.style.left = `${((pt - pb.winLoT) / (pb.hiT - pb.winLoT || 1)) * 100}%`;
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
      // children order is load-bearing: [0]=pulse ring, [1]=dot, [2]=callout label (pbPaintMarkers)
      html: '<div class="gauge-hit pb-ghit"><div class="pb-ring" hidden></div><div class="gauge-icon cat-none" style="width:8px;height:8px"></div><div class="pb-glabel" hidden></div></div>',
      iconSize: [40, 40],
      iconAnchor: [20, 20],
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
  const prev = state.pbPrevCodes || {};
  const pulse = state.pbPulse || (state.pbPulse = {});
  const next = {};
  for (const [lid, m] of Object.entries(state.pbMarkers)) {
    const el = m.getElement();
    if (!el) continue;
    const rec = frame.gauges[lid];
    if (!rec) { el.style.display = 'none'; delete pulse[lid]; continue; }
    el.style.display = '';
    next[lid] = rec[1];
    const { stale, cat } = pbDecode(rec[1]);
    const hit = el.firstChild;
    hit.className = `gauge-hit pb-ghit${cat === 'none' && !stale ? ' hit-none' : ''}`;
    const [ring, dot] = hit.children;
    dot.className = `gauge-icon ${stale ? 'stale' : `cat-${cat}`}`;
    const size = stale ? 11 : PB_CAT_SIZE[cat];
    dot.style.width = `${size}px`;
    dot.style.height = `${size}px`;
    // colored pulse ring on a category change this frame (stale codes carry no honest transition)
    if (lid in prev && prev[lid] !== rec[1] && prev[lid] >= 0 && rec[1] >= 0) pulse[lid] = PB_PULSE_FRAMES;
    if (pulse[lid] > 0) {
      pulse[lid]--;
      ring.hidden = false;
      ring.className = `pb-ring cat-${cat}`;
      ring.style.animation = 'none';
      void ring.offsetWidth; // restart the ring animation on consecutive changes
      ring.style.animation = '';
    } else { ring.hidden = true; delete pulse[lid]; }
    m.setZIndexOffset(cat === 'major' ? 1000 : cat === 'moderate' ? 500 : 0);
  }
  state.pbPrevCodes = next;
  pbUpdateLabels(frame);
}

/* top-5 significant-gauge callouts — always-visible name+stage labels, majors before moderates
   (threats-to-life first), then proximity to record, then stage; collision-nudged, hidden < z8 */
function pbUpdateLabels(frame) {
  const marks = state.pbMarkers;
  const placed = [];
  if (state.map.getZoom() >= PB_LABEL_MIN_ZOOM) {
    const cands = [];
    for (const [lid, rec] of Object.entries(frame.gauges)) {
      if (rec[1] < 2 || !marks[lid]) continue; // flooding gauges only (minor and up), never stale
      cands.push({ lid, code: rec[1], pct: (state.pbRecordPct || {})[lid] || 0, stage: rec[0] });
    }
    cands.sort((a, b) => b.code - a.code || b.pct - a.pct || b.stage - a.stage);
    for (const c of cands.slice(0, PB_LABEL_MAX)) {
      const el = marks[c.lid].getElement();
      if (!el) continue;
      const lbl = el.firstChild.children[2];
      const gi = state.pbData.gaugeIndex[c.lid];
      lbl.textContent = `${pbShortName(gi.name)} ${fmtNum(c.stage)} ft`;
      lbl.hidden = false;
      c.pt = state.map.latLngToContainerPoint(marks[c.lid].getLatLng());
      c.dy = 0;
      placed.push(c);
    }
  }
  const shown = new Set(placed.map((c) => c.lid));
  for (const lid of state.pbLabeled || []) {
    if (shown.has(lid)) continue;
    const el = marks[lid] && marks[lid].getElement();
    if (el) el.firstChild.children[2].hidden = true;
  }
  state.pbLabeled = shown;
  // collision nudge: sweep top-to-bottom, push an overlapping label below its neighbor
  placed.sort((a, b) => a.pt.y - b.pt.y);
  let last = null;
  for (const c of placed) {
    if (last && Math.abs(c.pt.x - last.pt.x) < 150 && c.pt.y - (last.pt.y + last.dy) < 18) {
      c.dy = last.pt.y + last.dy + 18 - c.pt.y;
    }
    marks[c.lid].getElement().firstChild.children[2].style.transform = c.dy ? `translate(-50%, ${c.dy}px)` : '';
    last = c;
  }
}

/* road-closure replay (v0.91) — archived/reconstructed DriveTexas records at their first vertex */
function pbEnsureRoadMarkers() {
  if (state.pbRoadMarkers || !state.pbData.roadIndex) return;
  state.layers.pbRoads = L.layerGroup();
  state.pbRoadMarkers = {};
  for (const [rid, r] of Object.entries(state.pbData.roadIndex)) {
    if (!Array.isArray(r.v) || r.v.length !== 2) continue;
    const icon = L.divIcon({
      className: '',
      html: `<div class="pb-road" style="border-color:${(ROAD_COND[r.cond] || ROAD_COND_FALLBACK).color}">${PB_ROAD_GLYPH[r.cond] || '🚧'}</div>`,
      iconSize: [22, 22], iconAnchor: [11, 11],
    });
    const m = L.marker(r.v, { icon });
    m.bindPopup(() => pbRoadPopup(rid), { minWidth: 220 });
    state.layers.pbRoads.addLayer(m);
    state.pbRoadMarkers[rid] = m;
  }
}

function pbRoadPopup(rid) {
  const r = state.pbData.roadIndex[rid];
  const frame = state.pbData.frames[state.pb.idx];
  const ct = ROAD_COND[r.cond] || ROAD_COND_FALLBACK;
  const arch = frame._t >= state.pbRoadsFromT;
  return `<div class="popup-title" style="color:${ct.color}">${PB_ROAD_GLYPH[r.cond] || '🚧'} ${esc(prettyRoute(r.route) || 'Road')} · ${esc(ct.label)}</div>` +
    `<div class="popup-meta">${esc(t('playback.road.window'))}: ${esc(fmtCT(r.start))} → ${r.end ? esc(fmtCT(r.end)) : esc(t('playback.road.noend'))}</div>` +
    `<div class="popup-meta">${srcBadge('official')} ${esc(t(arch ? 'playback.road.arch' : 'playback.road.recon'))}</div>` +
    `<div class="popup-meta" style="color:var(--sev-warning);font-weight:700">⏮ ${esc(t('playback.pill'))} · ${esc(fmtCT(frame.t))}</div>`;
}

function pbPaintRoads(frame) {
  if (!state.pbRoadMarkers) return;
  const active = new Set(frame.roads || []);
  for (const [rid, m] of Object.entries(state.pbRoadMarkers)) {
    const el = m.getElement();
    if (el) el.style.display = active.has(+rid) ? '' : 'none';
  }
}

/* archive tile cross-fade (v0.93.1) — two persistent A/B layers per archive source: a bucket
   change loads into the hidden layer, fades in on its 'load' event, then roles swap, so the
   visible layer never blanks mid-replay; unchanged buckets are skipped outright. */
const PB_FADE_FALLBACK_MS = 2500; // archive gap: fade anyway if 'load' never fires

function pbFaderCreate(urlFor, opts, opacity, stamp) {
  const fd = { urlFor, opacity, stamp, front: null, back: null, pending: null, wanted: false, loaded: false, backOn: false, timer: null, onIdle: null };
  const mk = (op) => {
    const lyr = L.tileLayer(urlFor(stamp), Object.assign({ opacity: op }, opts));
    lyr.on('load', () => { if (fd.back === lyr && fd.pending !== null) pbFaderLoaded(fd); });
    return lyr;
  };
  fd.front = mk(opacity).addTo(state.map);
  fd.back = mk(0);
  pbFaderTagXfade(fd.front);
  return fd;
}

function pbFaderTagXfade(lyr) {
  if (lyr._container) lyr._container.classList.add('pb-xfade'); // tile layers expose no public container accessor
}

function pbFaderLoad(fd, stamp) {
  fd.pending = stamp;
  fd.loaded = false;
  if (fd.backOn) { fd.back.setUrl(fd.urlFor(stamp)); return; }
  fd.back.setUrl(fd.urlFor(stamp), true); // noRedraw — the addTo below does the first fetch
  fd.back.addTo(state.map);
  fd.backOn = true;
  pbFaderTagXfade(fd.back);
}

function pbFaderLoaded(fd) {
  fd.loaded = true;
  clearTimeout(fd.timer);
  fd.timer = null;
  if (fd.wanted) pbFaderFade(fd);
}

function pbFaderFade(fd) {
  fd.front.setOpacity(0);
  fd.back.setOpacity(fd.opacity);
  const old = fd.front;
  fd.front = fd.back;
  fd.back = old;
  fd.stamp = fd.pending;
  fd.pending = null;
  fd.wanted = false;
  fd.loaded = false;
  clearTimeout(fd.timer);
  fd.timer = null;
  if (fd.onIdle) fd.onIdle();
}

// per-frame decision: 'skip' (bucket unchanged), 'pending' (already loading), 'fade' (preloaded), 'load'
function pbFaderSet(fd, stamp) {
  if (stamp === fd.stamp) { fd.wanted = false; return 'skip'; } // back onto the shown bucket — any pending demotes to prefetch
  if (stamp === fd.pending) {
    fd.wanted = true;
    if (fd.loaded) { pbFaderFade(fd); return 'fade'; }
    // prefetched bucket still loading — arm the same archive-gap fallback the 'load' path gets
    if (!fd.timer) fd.timer = setTimeout(() => { if (fd.pending === stamp && fd.wanted) pbFaderFade(fd); }, PB_FADE_FALLBACK_MS);
    return 'pending';
  }
  pbFaderLoad(fd, stamp);
  fd.wanted = true;
  clearTimeout(fd.timer);
  fd.timer = setTimeout(() => { if (fd.pending === stamp && fd.wanted) pbFaderFade(fd); }, PB_FADE_FALLBACK_MS);
  return 'load';
}

// while playing, warm the hidden buffer with the next frame's bucket as soon as a fade settles
function pbFaderPrefetchNext(fd, stampAt) {
  const pb = state.pb;
  if (!pb || pb.live || !pb.playing || pb.idx + 1 >= state.pbData.frames.length) return;
  const stamp = stampAt(state.pbData.frames[pb.idx + 1]._t);
  if (stamp !== fd.stamp && stamp !== fd.pending) pbFaderLoad(fd, stamp);
}

// scrub drags settle 250ms before a new bucket loads (SBW pattern); play applies instantly
function pbFaderSchedule(fd, key, stamp) {
  const pb = state.pb;
  clearTimeout(pb[key]);
  if (pb.playing || stamp === fd.stamp || stamp === fd.pending) { pbFaderSet(fd, stamp); return; }
  pb[key] = setTimeout(() => { if (state.pb && !state.pb.live) pbFaderSet(fd, stamp); }, 250);
}

function pbFaderDestroy(fd) {
  clearTimeout(fd.timer);
  fd.onIdle = null;
  state.map.removeLayer(fd.front);
  if (fd.backOn) state.map.removeLayer(fd.back);
}

// engage: swap the live gauge + alert layers for archive layers, badge the view, archive the radar if it's on
function playbackEngage() {
  const pb = state.pb;
  if (!pb.live) return;
  pb.live = false;
  pb.rtlWasIdx = state.rtl.idx; // captured before PB_LIVE_HIDE strips the forecast layer
  rtlStopPlay();
  pbSheetMin(); // re-engaging after NOW re-collapses the pane
  pbEnsureMarkers();
  pb.gaugesWereOn = state.map.hasLayer(state.layers.gauges);
  if (pb.gaugesWereOn) state.map.removeLayer(state.layers.gauges);
  state.layers.pbGauges.addTo(state.map);
  pb.alertsWereOn = state.map.hasLayer(state.layers.alerts);
  if (pb.alertsWereOn) state.map.removeLayer(state.layers.alerts);
  state.layers.pbAlerts = state.layers.pbAlerts || L.layerGroup();
  state.layers.pbAlerts.addTo(state.map);
  // roads replay only when the archive carries a roadIndex — otherwise live roads stay, note says live
  if (state.pbData.roadIndex) {
    pbEnsureRoadMarkers();
    pb.roadsWereOn = state.map.hasLayer(state.layers.roadClosures);
    if (pb.roadsWereOn) state.map.removeLayer(state.layers.roadClosures);
    state.layers.pbRoads.addTo(state.map);
  }
  state.layers.pbFlows = state.layers.pbFlows || L.layerGroup();
  state.layers.pbFlows.addTo(state.map);
  state.pbFlowKey = '';
  pbSbw.renderKey = '';
  pbSbw.visibleN = null;
  // time-integrity: timestamped curated/report layers re-render as-of the frame; live-only layers hide
  pb.liveOff = {};
  for (const k of ['requests', 'crossings', 'lsrs', 'lsrsAged'].concat(PB_LIVE_HIDE.map((x) => x[0]))) {
    pb.liveOff[k] = !!(state.layers[k] && state.map.hasLayer(state.layers[k]));
    if (pb.liveOff[k]) state.map.removeLayer(state.layers[k]);
  }
  pb.curatedOn = { requests: pb.liveOff.requests, crossings: pb.liveOff.crossings, lsr: pb.liveOff.lsrs || pb.liveOff.lsrsAged };
  pbBuildCurated();
  state.layers.pbCurated.addTo(state.map);
  document.body.classList.toggle('pb-tween', pb.speed <= 1);
  document.body.classList.add('pb-on');
  $('#pb-badge').hidden = false;
  $('#pb-now').classList.add('armed');
  rtlSync(); // the unified radar timeline hides — the playback bar owns time while engaged
  if (state.map.hasLayer(state.layers.radar)) {
    if (state.radar) state.radar.frameLayers.forEach((l) => l.setOpacity(0));
    pb.radarFader = pbFaderCreate(PB_RADAR_URL, {
      pane: 'radar', maxNativeZoom: 8, maxZoom: 19, attribution: 'Radar archive: IEM NEXRAD',
    }, 0.75, pbRadarStamp());
    pb.radarFader.onIdle = () => pbFaderPrefetchNext(pb.radarFader, pbRadarStampAt);
  }
  // rainfall replays from the IEM MRMS archive (hourly stamps) in the user's chosen window
  pb.mrmsWasOn = state.map.hasLayer(state.layers.mrms);
  if (pb.mrmsWasOn) {
    state.map.removeLayer(state.layers.mrms);
    pb.mrmsFader = pbFaderCreate((s) => PB_MRMS_URL(state.rainWindow, s), {
      attribution: 'Rainfall archive: MRMS via IEM',
    }, 0.55, pbMrmsStamp());
    pb.mrmsFader.onIdle = () => pbFaderPrefetchNext(pb.mrmsFader, pbMrmsStampAt);
  }
  updatePlaybackNote();
  layerSheetSync();
  renderTiles(); // threat strip gains its "LIVE below / replay on map" note
}

// NOW: instant, total restore of the live picture
function playbackGoLive() {
  const pb = state.pb;
  if (!pb) return;
  pbSheetRestore();
  if (pb.live) return;
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
  if (state.layers.pbRoads && state.map.hasLayer(state.layers.pbRoads)) state.map.removeLayer(state.layers.pbRoads);
  if (pb.roadsWereOn && !state.map.hasLayer(state.layers.roadClosures)) state.layers.roadClosures.addTo(state.map);
  if (state.layers.pbFlows) {
    state.layers.pbFlows.clearLayers();
    if (state.map.hasLayer(state.layers.pbFlows)) state.map.removeLayer(state.layers.pbFlows);
  }
  state.pbFlowKey = '';
  state.pbPrevCodes = null;
  state.pbPulse = null;
  clearTimeout(pb.sbwTimer);
  pbSbw.renderKey = '';
  pbSbw.visibleN = null;
  // drop the as-of-frame curated layer, restore every live layer exactly as it was
  if (state.layers.pbCurated) {
    state.layers.pbCurated.clearLayers();
    if (state.map.hasLayer(state.layers.pbCurated)) state.map.removeLayer(state.layers.pbCurated);
  }
  state.pbCuratedMarks = null;
  for (const k of Object.keys(pb.liveOff || {})) {
    if (pb.liveOff[k] && state.layers[k] && !state.map.hasLayer(state.layers[k])) state.layers[k].addTo(state.map);
  }
  pb.liveOff = {};
  clearTimeout(pb.radarSettle);
  clearTimeout(pb.mrmsSettle);
  if (pb.mrmsFader) { pbFaderDestroy(pb.mrmsFader); pb.mrmsFader = null; }
  if (pb.mrmsWasOn && !state.map.hasLayer(state.layers.mrms)) state.layers.mrms.addTo(state.map);
  pb.mrmsWasOn = false;
  if (pb.radarFader) { pbFaderDestroy(pb.radarFader); pb.radarFader = null; }
  rtlSync(); // unified radar timeline restores exactly as it was before engage
  if (pb.rtlWasIdx != null && rtlDomain().total) rtlSet(pb.rtlWasIdx);
  pb.rtlWasIdx = null;
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
  layerSheetSync();
  renderTiles();
}

function pbRadarStampAt(tMs) {
  const d = new Date(Math.floor(tMs / 300000) * 300000); // IEM archive is 5-min steps
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}
const pbRadarStamp = () => pbRadarStampAt(state.pbData.frames[state.pb.idx]._t);

function setPlaybackFrame(i) {
  const pb = state.pb, frames = state.pbData.frames;
  pb.idx = Math.max(pbFirstIdx(), Math.min(i, frames.length - 1)); // before engage — faders must stamp from the target frame, not the pre-jump idx
  playbackEngage();
  const frame = frames[pb.idx];
  pbPaintMarkers(frame);
  pbPaintRoads(frame);
  pbPaintFlows(frame);
  if (pb.radarFader) pbFaderSchedule(pb.radarFader, 'radarSettle', pbRadarStampAt(frame._t));
  if (pb.mrmsFader) pbFaderSchedule(pb.mrmsFader, 'mrmsSettle', pbMrmsStampAt(frame._t));
  pbPaintCurated(frame);
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

// truth line: which layers replay vs re-render as-of the frame vs hide, incl. the viewer's own 7d alert history
function updatePlaybackNote() {
  const pb = state.pb;
  const hasRoads = !pb.live && !!state.pbData.roadIndex;
  const roadsNote = hasRoads
    ? t(state.pbData.frames[pb.idx]._t >= state.pbRoadsFromT ? 'playback.note.roads.arch' : 'playback.note.roads.recon')
    : '';
  let note = pb.live ? t('playback.note.idle')
    : `${t('playback.note.replay')}${t('playback.note.warn')}${roadsNote}${pb.radarFader ? t('playback.note.radar') : ''}`;
  if (!pb.live) {
    if (pb.mrmsFader) {
      const hour = fmtCT(new Date(Math.floor(state.pbData.frames[pb.idx]._t / 3600000) * 3600000).toISOString());
      note += t('playback.note.rain').replace('{w}', state.rainWindow).replace('{t}', hour);
    }
    const filt = [];
    if (pb.curatedOn && pb.curatedOn.requests) filt.push(t('layers.notices'));
    if (pb.curatedOn && pb.curatedOn.crossings) filt.push(t('layers.crossings'));
    if (pb.curatedOn && pb.curatedOn.lsr) filt.push(t('layers.lsr'));
    if (filt.length) note += ` · ${t('playback.note.filtered').replace('{list}', filt.join(', '))}`;
    const hidden = PB_LIVE_HIDE.filter(([k]) => pb.liveOff && pb.liveOff[k]).map(([, key]) => t(key));
    if (hidden.length) note += ` · ${t('playback.note.hidden').replace('{list}', hidden.join(', '))}`;
    if (!hasRoads) note += ` · ${t('playback.note.live')}`;
  }
  if (!pb.live) {
    const ft = state.pbData.frames[pb.idx]._t;
    const n = Object.values(state.hist.alerts || {}).filter((a) => {
      const s = new Date(a.t).getTime(), e = a.expires ? new Date(a.expires).getTime() : 0;
      return s <= ft && e >= ft;
    }).length;
    if (n) note += ` · ${t('playback.note.alerthist').replace('{n}', n)}`;
    if (state.pbData.frames[pbFirstIdx()]._t > pb.winLoT + 60000) {
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
  // over-map controls must never leak taps into Leaflet (double-tap zoom, pinch) — same guard as AO chips/layer pills
  for (const sel of ['#playback-bar', '#pb-pill', '#pb-badge', '#radar-scrub']) {
    const el = $(sel);
    if (!el) continue;
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);
  }
  $('#pb-pill').addEventListener('click', togglePlayback);
  $('#pb-play').addEventListener('click', togglePlaybackPlay);
  $('#pb-now').addEventListener('click', playbackGoLive);
  $('#pb-close').addEventListener('click', closePlayback);
  $('#pb-speed').addEventListener('click', pbCycleSpeed);
  $('#pb-back').addEventListener('click', () => pbStepFrame(-1));
  $('#pb-fwd').addEventListener('click', () => pbStepFrame(1));
  $('#pb-caption').addEventListener('click', stopPlaybackPlay); // tap the caption = pause
  $('#pb-hud').addEventListener('click', pbToggleHudDetail);
  // callout labels hide below z8 and re-nudge on zoom — recompute against the current frame
  if (state.map) state.map.on('zoomend', () => { if (state.pb && !state.pb.live) pbUpdateLabels(state.pbData.frames[state.pb.idx]); });
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

