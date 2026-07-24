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
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', theme === 'dark' ? '#0D1B2A' : '#ffffff'); // browser chrome tracks --surface-1
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
    if (s) { s.textContent = n > 0 ? t('off.saved').replace('{n}', n) : t('off.none'); s.classList.remove('over'); }
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
    statusEl.textContent = t('off.cap').replace('{n}', jobs.length).replace('{m}', OFFLINE_TILE_CAP);
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
      statusEl.textContent = t('off.saving').replace('{n}', ++done).replace('{m}', jobs.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (saveBtn) saveBtn.disabled = false;
  const total = await refreshOfflineStatus();
  statusEl.textContent = t('off.savedfull').replace('{n}', total).replace('{m}', zooms.length);
}

async function clearOfflineCache() {
  try { await OfflineTiles.clear(); } catch (e) { /* ignore — nothing to clear */ }
  await refreshOfflineStatus();
  const s = $('#off-status');
  if (s) s.textContent = t('off.cleared');
}

function initOfflineControl() {
  if (!OfflineTiles.available()) return;
  const ctl = L.control({ position: 'topright' }); // added after the compass so it stacks directly below it
  ctl.onAdd = () => {
    const div = L.DomUtil.create('div', 'offline-ctl');
    div.innerHTML = `<div class="leaflet-bar ls-trigger"><a href="#" role="button" class="off-toggle" id="off-toggle" aria-expanded="false" title="${esc(t('off.toggle.title'))}" aria-label="${esc(t('off.toggle.aria'))}" data-i18n-title="off.toggle.title" data-i18n-aria="off.toggle.aria">⬇</a></div>` +
      '<div class="off-panel" id="off-panel" hidden>' +
      `<div class="off-panel-head" data-i18n="off.head">${esc(t('off.head'))}</div>` +
      `<button class="off-save" title="${esc(t('off.save.title'))}" data-i18n="off.save" data-i18n-title="off.save.title">${esc(t('off.save'))}</button>` +
      '<div class="off-status" id="off-status">…</div>' +
      `<div class="off-note" data-i18n="off.note">${esc(t('off.note'))}</div>` +
      `<button class="off-clear" id="off-clear" hidden data-i18n="off.clear">${esc(t('off.clear'))}</button>` +
      '</div>';
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    L.DomEvent.on(div.querySelector('#off-toggle'), 'click', (e) => {
      L.DomEvent.stop(e);
      const p = div.querySelector('#off-panel');
      p.hidden = !p.hidden;
      const tg = div.querySelector('#off-toggle');
      tg.classList.toggle('open', !p.hidden);
      tg.setAttribute('aria-expanded', String(!p.hidden));
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
  if (pbBlocksLive(state)) return; // playback: same read-only regime as the layer sheet
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

function mapLegendHtml() {
  return `<div class="lg-title">${esc(t('legend.gauges'))}</div>` +
    ['major', 'moderate', 'minor', 'action', 'none'].map((c) => {
      const s = Math.max(9, CAT_SIZE[c] - 3);
      return `<div><span class="sw gauge-icon cat-${c}" style="width:${s}px;height:${s}px"></span>${esc(catLabel(c))}</div>`;
    }).join('') +
    `<div><span class="sw" style="width:10px">▲</span>${esc(t('legend.rise'))}</div>` +
    `<div><span class="sw" style="width:10px;color:var(--good)">▼</span>${esc(t('legend.fall'))}</div>` +
    `<div><span class="sw fcst-ring cat-moderate" style="width:10px;height:10px"></span>${esc(t('legend.fcrest'))}</div>` +
    `<div class="lg-title" style="margin-top:6px">${esc(t('legend.roads'))}</div>` +
    ['Closure', 'Flooding', 'Damage'].map((k) => {
      const rc = ROAD_COND[k];
      return `<div><span class="sw sw-line" style="background:${rc.color}"></span>${esc(roadLabel(rc))}</div>`;
    }).join('') +
    `<div><span class="reopen-icon">✓</span>${esc(t('legend.reopen'))}</div>` +
    `<div class="lg-title" style="margin-top:6px">${esc(t('legend.reports'))}</div>` +
    `<div><span style="margin-right:6px">💧</span>${esc(t('legend.lsr'))}</div>` +
    `<div><span style="margin-right:6px">🆘</span>${esc(t('legend.glyph'))}</div>`;
}

function initMap() {
  // autoPan clear of the AO chip / layer-pill band at the map top — popups otherwise clip against the container edge
  L.Popup.mergeOptions({ autoPanPaddingTopLeft: L.point(8, 120) });
  state.map = L.map('map', { zoomControl: false }).setView(CONFIG.center, CONFIG.zoom);
  // collapse the attribution bar to a tap-to-open ⓘ — it otherwise crowds the legend on short screens; OSM/CARTO/TxDOT credits stay one tap away (ToS + source-citation intact)
  state.map.attributionControl.setPrefix(`<span class="attr-i" title="${esc(t('attr.title'))}">ⓘ</span>`);
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
  state.fcst = { runIso: null, hourLayers: [], metaFail: false, tileOk: false };
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
    if (e.layer === state.layers.tropical) { showTropicalLegend(); fetchTropical().catch(() => { $('#refresh-note').textContent = t('note.tropfail'); }); }
    if (e.layer === state.layers.surge) $('#surge-legend').hidden = false;
    if ([state.layers.camsTxdot, state.layers.camsRiver, state.layers.camsAustin, state.layers.camsFlood, state.layers.camsHouston, state.layers.camsArlington, state.layers.camsElpBridge, state.layers.camsHays].includes(e.layer)) loadCameras().catch(() => { $('#refresh-note').textContent = 'camera inventory unavailable'; });
    if (e.layer === state.layers.fcstRadar) fcstEnable();
    if (e.layer !== state.layers.radar) return;
    rtlSync();
    fetchRadarFrames().catch(() => { $('#rs-label').textContent = t('note.radarfail'); });
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
    state.legendEl = div; // relocalizeDynamic re-renders this on a live language switch
    div.innerHTML = mapLegendHtml();
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div); // scrolling the (now scrollable) expanded legend must not zoom the map
    L.DomEvent.on(div, 'click', () => div.classList.toggle('open')); // mobile: collapsed to title pill by default
    return div;
  };
  legend.addTo(state.map);

  // overlay legends: collapsed to their title pill by default at every size; tap toggles pill/expanded
  document.querySelectorAll('.ov-legend').forEach((lg) => {
    L.DomEvent.disableClickPropagation(lg);
    L.DomEvent.disableScrollPropagation(lg);
    lg.classList.remove('open');
    L.DomEvent.on(lg, 'click', (e) => {
      if (e.target.closest('#mrms-legend-chips')) return; // chips pick a window, not toggle
      lg.classList.toggle('open');
    });
  });
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
  initOfflineControl(); // after the compass so the ⬇ box stacks directly below it (owner ask 7/24)
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
      state.posMarker = L.marker(e.latlng, { icon: youIcon(), title: t('you.title'), zIndexOffset: 2000, interactive: false });
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
    $('#refresh-note').textContent = t('note.locfail');
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
    html: `<div class="my-pos-wrap"><div class="my-pos-ring"></div><div class="my-pos-ring d2"></div><div class="my-pos-core"></div><div class="my-pos-label">${esc(t('you.label'))}</div></div>`,
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
const CTL_ICON_COMPASS = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="13" r="7.4" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.65"/><polygon points="12 6.5 8.7 15.2 12 13.2 15.3 15.2" fill="#e5484d" stroke="#e5484d" stroke-width="0.5" stroke-linejoin="round"/><polygon points="12 19.9 8.7 15.2 12 17.2 15.3 15.2" fill="currentColor" opacity="0.7"/><text x="12" y="5.2" text-anchor="middle" font-size="7" font-weight="800" fill="currentColor">N</text></svg>';

/* ---------- AO quick-jump — pills along the map top edge, never another stacked box ---------- */

function initAoJump() {
  const AO_PRESETS = resolveAoPresets(getLang()); // event-config pills (data/event.json) or built-in fallback
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
      if (pbBlocksLive(state)) { pbLayersLockedNote(); return; } // playback owns layer state — same lock as the sheet
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
  const locked = pbBlocksLive(state); // playback swaps its own layers — sheet goes read-only
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
  if (pbBlocksLive(state)) return; // read-only while playback is engaged
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
  state.map.fitBounds(aoFullBounds());
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
  bar.hidden = !on || pbBlocksLive(state);
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
  if (pbBlocksLive(state)) return; // playback replays IEM archive radar — live frames must stay dark
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
  const obsKey = state.radar && state.radar.src === 'iem' ? 'leg.wx.obs.iem' : 'leg.wx.obs';
  $('#wx-legend-src').textContent = t(wxFcst ? (wxFcstDegraded(state.fcst) ? 'leg.wx.fcst.down' : 'leg.wx.fcst') : obsKey);
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
    setTimeout(() => { if (!img.isConnected) return; img.src = `${base}${sep}_rtry=${n + 1}`; }, 400 + n * 300);
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

// RainViewer-down fallback: synthesize a past-only frame set from the IEM NEXRAD composite archive
// (the same tiles playback replays). 10-min steps over ~2h, floored to 5-min buckets with a 10-min
// ingest lag so the newest stamp already serves tiles. No nowcast segment — honesty over projection.
const IEM_RADAR_STEP_MS = 600000;
const IEM_RADAR_FRAMES = 13;
function iemRadarFrames(nowMs) {
  const newest = Math.floor((nowMs - 600000) / 300000) * 300000;
  const frames = [];
  for (let i = IEM_RADAR_FRAMES - 1; i >= 0; i--) frames.push({ time: (newest - i * IEM_RADAR_STEP_MS) / 1000 });
  return frames;
}

async function fetchRadarFrames() {
  let d = null;
  try {
    const res = await fetch(CONFIG.rainviewerApi);
    if (!res.ok) throw new Error(`RainViewer HTTP ${res.status}`);
    d = await res.json();
    if (!((d.radar && d.radar.past) || []).length) throw new Error('no radar frames');
  } catch { d = null; } // primary down — fall back to the IEM archive frame set below
  const past = d ? d.radar.past : iemRadarFrames(Date.now());
  const cast = d ? (d.radar.nowcast || []) : [];
  const keepIdx = state.radar ? state.radar.idx : -1;
  const wasPlaying = state.rtl.playing;
  rtlStopPlay();
  state.radar = { src: d ? 'rainviewer' : 'iem', host: d ? d.host : '', frames: past.concat(cast), castStart: past.length, nowIdx: past.length - 1, idx: past.length - 1, frameLayers: [] };
  const r = state.radar;
  state.layers.radar.clearLayers();
  r.frameLayers = r.frames.map((f) => L.tileLayer(
    d ? `${r.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png` : PB_RADAR_URL(pbRadarStampAt(f.time * 1000)), {
      pane: 'radar', opacity: 0, maxNativeZoom: 7, maxZoom: 19, updateWhenIdle: false, className: 'rtl-xfade',
      attribution: d ? 'Radar: RainViewer' : 'Radar: NEXRAD via IEM',
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

// HRRR has no secondary source — degraded means the IEM run metadata is failing and no model tile has
// ever painted; the legend then says so instead of showing silently blank forecast frames
const wxFcstDegraded = (f) => !!(f && f.metaFail && !f.tileOk);

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
  l.on('tileload', () => { state.fcst.tileOk = true; });
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
    if (f) f.metaFail = !d || !d.model_init_utc;
    if (!f || !d || !d.model_init_utc || f.runIso === d.model_init_utc) return;
    const stale = f.runIso !== null;
    f.runIso = d.model_init_utc;
    if (stale) {
      f.hourLayers.forEach((l) => { if (l) l.setParams({ _run: f.runIso }); }); // vendor param busts each mounted hour's cache
      if (state.rtl.fut) fcstShow(state.rtl.hour); // repaint the visible hour onto the new run
    }
    if (state.rtl.fut) rtlUpdateLabel(rtlDomain());
  }).catch(() => {
    if (state.fcst) state.fcst.metaFail = true; // with no tile ever painted this flips the legend to "unavailable"
    if (state.rtl.fut) rtlUpdateLabel(rtlDomain());
  });
}
