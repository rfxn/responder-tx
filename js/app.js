'use strict';

const APP_VERSION = 'v0.75.9';

const CONFIG = {
  center: [29.75, -99.35],
  zoom: 8,
  // Hill Country + Uvalde/Nueces basins; widen if the event spreads
  // widened 7/16 PM: Nueces wave moving downstream + LCRA floodgate releases on the Colorado
  gaugeBbox: { xmin: -102.0, ymin: 28.0, xmax: -97.0, ymax: 31.1 },
  alertsUrl: 'https://api.weather.gov/alerts/active?area=TX',
  nwpsBase: 'https://api.water.noaa.gov/nwps/v1',
  fcstMaxUrl: 'https://maps.water.noaa.gov/server/rest/services/rfc/rfc_max_forecast/MapServer/0/query',
  usgsIvBase: 'https://waterservices.usgs.gov/nwis/iv/',
  refreshMs: 180000,
  maxZoneGeomFetches: 12,
  sparkHours: 48,
  staleMins: 360,
  // obs older than this = dead sensor; long enough for 1-6h rural reporters, short enough to catch frozen gauges (BTVT2 froze 60h at MAJOR)
  gaugeStaleHours: 12,
  smartHalfLifeMins: 360,
  agedCardMins: 1440,
  agedCardMinsByType: { info: 720, volunteer: 720 },
  agedLsrMins: 180,
  histDays: 7,
  lsrHours: 12,
  // hard live-map cap: a storm report older than this ages out of the live layer into lsrsAged, even if the window filter is wider
  lsrMaxHours: 24,
  lsrUrl: 'https://mesonet.agron.iastate.edu/geojson/lsr.geojson',
  // TxDOT DriveTexas HCRS live road conditions (CORS-open, no key). Layer 1 = line segments, 0 = points.
  hcrsLineUrl: 'https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/HCRS_CC/FeatureServer/1/query',
  hcrsPointUrl: 'https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/HCRS_CC/FeatureServer/0/query',
  rainviewerApi: 'https://api.rainviewer.com/public/weather-maps.json',
  mrms1hUrl: 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/q2-n1p-900913/{z}/{x}/{y}.png',
  mrms24hUrl: 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/q2-p24h-900913/{z}/{x}/{y}.png',
  // NWPS/NWM Analysis-and-Assimilation flood inundation extent (experimental, hourly). Layer 0
  // draws only at street scale (< ~1:400k, z≈11+). MODELED estimate, not observed — labelled as such.
  inunExportUrl: 'https://maps.water.noaa.gov/server/rest/services/nwm/ana_inundation_extent/MapServer/export?bboxSR=3857&imageSR=3857&size=256,256&dpi=96&layers=show:0&format=png32&transparent=true&f=image',
};

const CAT_RANK = { none: 0, action: 1, minor: 2, moderate: 3, major: 4 };
const LSR_FLOOD_RE = /FLOOD|HEAVY RAIN|DEBRIS|DAM |LANDSLIDE|RESCUE/i;
const ROAD_RE = /\b(?:FM|RM|RR|CR|SH|US|IH?|LOOP|HWY)[-\s]?\d+\b/gi;

const FLOOD_CATS = ['action', 'minor', 'moderate', 'major'];
const CAT_LABEL = { major: 'MAJOR flood', moderate: 'Moderate flood', minor: 'Minor flood', action: 'Near flood (action)', none: 'No flooding' };
// localized severity word for the public "Am I at risk?" modal; map popups/cards keep the English feed vocabulary
const catLabel = (cat) => t('cat.' + cat);
const CAT_SIZE = { major: 18, moderate: 15, minor: 12, action: 10, none: 8 };
const TYPE_GLYPH = { rescue: '🆘', evacuation: '🏃', medical: '⚕️', supplies: '📦', shelter: '🏠', animal: '🐾', wellness: '💬', volunteer: '🤝', equipment: '🛠️', road: '🚧', cutoff: '⛔', info: 'ℹ️' };
const LIFE_SAFETY_TYPES = ['rescue', 'evacuation', 'medical', 'cutoff'];

const PRIORITIES = ['critical', 'high', 'medium', 'low'];
const LS_KEY = 'respondertx.store.v1';

const state = {
  map: null,
  baseLayers: {},
  activeBase: null,
  layers: {},
  seedRequests: [],
  store: { added: [], overrides: {} },
  resources: null,
  alerts: [],
  gauges: [],
  fcstMax: [],
  usgsSites: [],
  lsrs: [],
  zoneGeomCache: new Map(),
  filters: { type: '', county: '', q: '', window: '', dist: '' },
  sort: 'smart',
  myPos: null,
  posLayer: null,
  lastSeen: 0,
  trendHist: {},
  knownEmergencyIds: new Set(),
  alertsLoadedOnce: false,
  sourceHealth: {},
  baseTitle: document.title,
  pendingLatLng: null,
  refreshAt: 0,
  hist: { lsrs: {}, alerts: {} },
  showAged: false,
  showAgedLsrs: false,
  showAlertHist: false,
  showNormalGauges: false,
  gaugeGroup: 'priority',
};

const PRI_WEIGHT = { critical: 8, high: 4, medium: 2, low: 1 };

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// coerce trusted-gov feed numbers before innerHTML — a non-numeric value falls back to an escaped string
const fmtNum = (v) => (Number.isFinite(+v) ? +v : esc(String(v)));
// esc() blocks attribute-breakout but not javascript:/data: schemes — gate hrefs to http(s)
const safeUrl = (u) => (/^https?:\/\//i.test(String(u)) ? String(u) : '#');
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// navigator.clipboard needs a secure context — LAN http:// serving does not have one
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy') ? resolve() : reject(new Error('copy failed')); }
    catch (e) { reject(e); }
    finally { ta.remove(); }
  });
}

const ageMins = (iso) => (Date.now() - new Date(iso).getTime()) / 60000;
function freshClass(iso) {
  const m = ageMins(iso);
  return m < 60 ? 'fresh' : m < 180 ? 'recent' : m < CONFIG.staleMins ? 'aging' : 'stale';
}
function distMi(lat1, lon1, lat2, lon2) {
  const R = 3958.8, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  const a = Math.abs(mins);
  const span = a < 60 ? `${a}m` : a < 1440 ? `${Math.round(a / 60)}h` : `${Math.round(a / 1440)}d`;
  const rel = mins >= 0 ? `${span} ago` : `in ${span}`;
  const abs = d.toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `${rel} · ${abs} CT`;
}

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
    statusEl.textContent = `This area needs ${jobs.length} tiles (cap ${OFFLINE_TILE_CAP}) — zoom in, then save`;
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
  statusEl.textContent = `✓ ${total} tiles saved (${zooms.length} zoom levels) — available offline`;
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
    div.innerHTML = '<button class="off-toggle" id="off-toggle" title="Offline map — save this area to view with no signal">⬇</button>' +
      '<div class="off-panel" id="off-panel" hidden>' +
      '<div class="off-panel-head">Offline map</div>' +
      '<button class="off-save" title="Cache the current view + 2 deeper zooms for use with no signal">⬇ Save this area</button>' +
      '<div class="off-status" id="off-status">…</div>' +
      '<div class="off-note">Basemap only — live gauge/alert data still needs a connection.</div>' +
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
  // TxDOT DriveTexas live road conditions — flood-relevant F/Z/D only, first-class toggle (owner request), on by default
  state.layers.roadClosures = L.layerGroup().addTo(state.map);
  L.control.layers({
    'Dark (CARTO)': state.baseLayers.dark,
    'Light (CARTO)': state.baseLayers.light,
    'Streets (OSM)': state.baseLayers.streets,
  }, {
    'Place labels (boost)': state.layers.labelBoost,
    'Radar scrub (-1h → +30m)': state.layers.radar,
    'Rainfall 1h (MRMS)': state.layers.mrms1h,
    'Rainfall 24h (MRMS)': state.layers.mrms24h,
    'Flood inundation — NWM model (est.)': state.layers.inundation,
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
      '<div class="lg-title" style="margin-top:6px">Reports & notices</div>' +
      '<div><span style="margin-right:6px">💧</span>storm report (LSR)</div>' +
      '<div><span style="margin-right:6px">🆘</span>marker glyph = need type</div>';
    L.DomEvent.disableClickPropagation(div);
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

/* ---------- NWS alerts ---------- */

function alertSeverity(p) {
  const threat = (p.parameters && p.parameters.flashFloodDamageThreat || []).join(' ');
  if (/FLASH FLOOD EMERGENCY/i.test(p.description || '') || /CATASTROPHIC/i.test(threat)) return 'emergency';
  if (/Warning/i.test(p.event)) return 'warning';
  if (/Watch/i.test(p.event)) return 'watch';
  return 'advisory';
}

async function fetchAlerts() {
  const res = await fetch(CONFIG.alertsUrl, { headers: { Accept: 'application/geo+json' } });
  if (!res.ok) throw new Error(`NWS alerts HTTP ${res.status}`);
  const data = await res.json();
  const floods = (data.features || []).filter((f) => /flood/i.test(f.properties.event || ''));
  floods.forEach((f) => { f._sev = alertSeverity(f.properties); });
  const rank = { emergency: 0, warning: 1, watch: 2, advisory: 3 };
  floods.sort((a, b) => rank[a._sev] - rank[b._sev] || new Date(b.properties.sent || 0) - new Date(a.properties.sent || 0));
  const emergencies = floods.filter((f) => f._sev === 'emergency');
  const fresh = emergencies.filter((f) => !state.knownEmergencyIds.has(f.id));
  emergencies.forEach((f) => state.knownEmergencyIds.add(f.id));
  if (state.alertsLoadedOnce && fresh.length) showEmergencyBanner(fresh);
  if (!emergencies.length && !$('#emergency-banner').hidden) dismissEmergencyBanner(); // banner ages out with its alert
  state.alertsLoadedOnce = true;
  state.alerts = floods;
  markHealthy('alerts');
  recordAlertHist();
  renderAlertList();
  await renderAlertPolys();
  renderTiles();
}

async function zoneGeometry(zoneUrl) {
  if (state.zoneGeomCache.has(zoneUrl)) return state.zoneGeomCache.get(zoneUrl);
  try {
    const res = await fetch(zoneUrl, { headers: { Accept: 'application/geo+json' } });
    const gj = res.ok ? (await res.json()).geometry : null;
    state.zoneGeomCache.set(zoneUrl, gj);
    return gj;
  } catch { state.zoneGeomCache.set(zoneUrl, null); return null; }
}

async function renderAlertPolys() {
  state.layers.alerts.clearLayers();
  let zoneFetchBudget = CONFIG.maxZoneGeomFetches;
  // reverse severity order: least-severe drawn first, emergencies land on top
  for (const f of state.alerts.slice().reverse()) {
    // recency: never draw an alert the NWS no longer lists as open — expired drops off, open (expires in future, any age) stays
    if (new Date(f.properties.expires) < new Date()) continue;
    let geom = f.geometry;
    if (!geom && f._sev !== 'advisory' && zoneFetchBudget > 0) {
      const zones = f.properties.affectedZones || [];
      const geoms = [];
      for (const z of zones.slice(0, 3)) {
        if (zoneFetchBudget <= 0 && !state.zoneGeomCache.has(z)) break;
        if (!state.zoneGeomCache.has(z)) zoneFetchBudget--;
        const g = await zoneGeometry(z);
        if (g) geoms.push(g);
      }
      if (geoms.length === 1) geom = geoms[0];
      else if (geoms.length > 1) geom = { type: 'GeometryCollection', geometries: geoms };
    }
    if (!geom) continue;
    const layer = L.geoJSON({ type: 'Feature', geometry: geom }, {
      style: { className: `alert-poly sev-${f._sev}`, weight: f._sev === 'emergency' ? 2.5 : 1.5, fillOpacity: f._sev === 'emergency' ? 0.22 : 0.10, opacity: 0.9 },
    });
    layer.bindPopup(alertPopupHtml(f));
    state.layers.alerts.addLayer(layer);
  }
}

function showEmergencyBanner(freshAlerts) {
  const areas = freshAlerts.map((f) => f.properties.areaDesc).join(' | ');
  $('#banner-text').textContent = `⚠ NEW FLASH FLOOD EMERGENCY: ${areas}`;
  $('#emergency-banner').hidden = false;
  if (!document.title.startsWith('🔴')) document.title = `🔴 ${document.title}`;
}

function dismissEmergencyBanner() {
  $('#emergency-banner').hidden = true;
  document.title = document.title.replace(/^🔴 /, '');
}

function alertPopupHtml(f) {
  const p = f.properties;
  return `<div class="popup-title">${esc(p.event)}${f._sev === 'emergency' ? ' — <span style="color:var(--sev-emergency);font-weight:700">FLASH FLOOD EMERGENCY</span>' : ''}</div>` +
    `<div class="popup-meta">${esc(p.areaDesc || '')}</div>` +
    `<div class="popup-meta">Expires: ${esc(fmtWhen(p.expires))}</div>` +
    `<div class="popup-link"><a href="${esc(f.id)}" target="_blank" rel="noopener">Full alert text →</a></div>`;
}

// in area-of-operations? geometry bounds must intersect the gauge bbox (padded).
// zone alerts w/o geometry are kept in-AO (don't hide) — better a false include than a hidden warning.
function alertInAO(f) {
  const geom = f.geometry || (f.properties.affectedZones || []).map((z) => state.zoneGeomCache.get(z)).find(Boolean);
  if (!geom) return true;
  const b = CONFIG.gaugeBbox, pad = 0.3;
  try {
    const gb = L.geoJSON(geom).getBounds();
    return gb.getEast() >= b.xmin - pad && gb.getWest() <= b.xmax + pad
      && gb.getNorth() >= b.ymin - pad && gb.getSouth() <= b.ymax + pad;
  } catch { return true; }
}

function alertCardDiv(f) {
  const p = f.properties;
  const div = document.createElement('div');
  div.className = `card alert-card sev-${f._sev}`;
  div.innerHTML = `<div class="event">${esc(p.event)}${f._sev === 'emergency' ? '<span class="emergency-flag">EMERGENCY</span>' : ''}</div>` +
    `<div class="areas">${esc(p.areaDesc || '')}</div>` +
    `<div class="meta" style="margin-top:3px;font-size:11px;color:var(--ink-muted)">` +
    (p.sent ? `<span class="fresh-dot ${freshClass(p.sent)}"></span> sent ${esc(fmtWhen(p.sent))} · ` : '') +
    `until ${esc(fmtWhen(p.expires))} · <a href="${esc(f.id)}" target="_blank" rel="noopener" style="color:var(--accent)">text</a></div>`;
  div.addEventListener('click', () => {
    if (f.geometry) {
      const b = L.geoJSON(f.geometry).getBounds();
      if (b.isValid()) { state.map.fitBounds(b, { maxZoom: 10 }); return; }
    }
    const z = (f.properties.affectedZones || [])[0];
    const g = z && state.zoneGeomCache.get(z);
    if (g) {
      const b = L.geoJSON(g).getBounds();
      if (b.isValid()) { state.map.fitBounds(b, { maxZoom: 10 }); return; }
    }
    window.open(f.id, '_blank', 'noopener');
  });
  return div;
}

function renderAlertList() {
  const el = $('#alert-list');
  el.innerHTML = `<div class="section-title">${esc(t('sec.alerts'))}</div>`;
  const sevF = $('#flt-alert-sev').value, qF = $('#flt-alert-q').value.toLowerCase();
  const shown = state.alerts.filter((f) => (!sevF || f._sev === sevF)
    && (!qF || `${f.properties.event} ${f.properties.areaDesc}`.toLowerCase().includes(qF)));
  if (!shown.length) { el.innerHTML += `<div class="card">${esc(t('sec.alerts.empty'))}</div>`; return; }
  // AO-relevant alerts first; the rest fold into "elsewhere in TX" so a Big Bend FFW can't sit on top
  const inAO = shown.filter(alertInAO), elsewhere = shown.filter((f) => !alertInAO(f));
  for (const f of inAO) el.appendChild(alertCardDiv(f));
  if (elsewhere.length) {
    const btn = document.createElement('button');
    btn.className = 'aged-toggle';
    btn.textContent = `${state.showAlertsElsewhere ? '▾ hide' : '▸ show'} ${elsewhere.length} flood alert${elsewhere.length > 1 ? 's' : ''} elsewhere in TX`;
    btn.addEventListener('click', () => { state.showAlertsElsewhere = !state.showAlertsElsewhere; renderAlertList(); });
    el.appendChild(btn);
    if (state.showAlertsElsewhere) for (const f of elsewhere) el.appendChild(alertCardDiv(f));
  }
  const emergN = state.alerts.filter((f) => f._sev === 'emergency').length;
  const alertsBadge = $('#alerts-count');
  alertsBadge.textContent = emergN ? `⚠ ${emergN}` : state.alerts.length;
  alertsBadge.classList.toggle('sev', emergN > 0);
  renderAlertHistory(el);
}

function renderAlertHistory(el) {
  const liveIds = new Set(state.alerts.map((f) => f.id));
  const expired = Object.entries(state.hist.alerts)
    .filter(([id, a]) => !liveIds.has(id) || (a.expires && new Date(a.expires) < new Date()))
    .map(([, a]) => a)
    .sort((a, b) => new Date(b.t) - new Date(a.t));
  if (!expired.length) return;
  const btn = document.createElement('button');
  btn.className = 'aged-toggle';
  btn.textContent = `${state.showAlertHist ? '▾ hide' : '▸ show'} ${expired.length} expired alerts (kept ${CONFIG.histDays}d)`;
  btn.addEventListener('click', () => { state.showAlertHist = !state.showAlertHist; renderAlertList(); });
  el.appendChild(btn);
  if (!state.showAlertHist) return;
  for (const a of expired.slice(0, 50)) {
    const div = document.createElement('div');
    div.className = `card alert-card aged sev-${a.sev}`;
    div.innerHTML = `<div class="event">${esc(a.event)}</div><div class="areas">${esc(a.areaDesc || '')}</div>` +
      `<div class="meta" style="margin-top:3px;font-size:11px;color:var(--ink-muted)">sent ${esc(fmtWhen(a.t))} · expired ${esc(fmtWhen(a.expires))}</div>`;
    el.appendChild(div);
  }
}

/* ---------- NOAA NWPS gauges ---------- */

async function fetchGauges() {
  const b = CONFIG.gaugeBbox;
  const url = `${CONFIG.nwpsBase}/gauges?bbox.xmin=${b.xmin}&bbox.ymin=${b.ymin}&bbox.xmax=${b.xmax}&bbox.ymax=${b.ymax}&srid=EPSG_4326`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NWPS HTTP ${res.status}`);
  const data = await res.json();
  state.gauges = (data.gauges || []).filter((g) => {
    const c = g.status && g.status.observed && g.status.observed.floodCategory;
    return c && !['out_of_service', 'obs_not_current', 'not_defined'].includes(c);
  });
  markHealthy('gauges');
  state.snapshotAt = null; // live feed recovered — snapshot semantics no longer apply
  recordTrends();
  renderGauges();
  renderGaugesTab();
  renderForecastList();
  renderTiles();
}

// a sensor is stale/dead when its last observation is missing/unparseable or older than the
// recency cutoff — a frozen gauge keeps reporting a real floodCategory, so obs-age is the only tell
function gaugeObsStale(g) {
  const iso = g.status && g.status.observed && g.status.observed.validTime;
  if (!iso) return true;
  const m = ageMins(iso);
  return Number.isNaN(m) || m > CONFIG.gaugeStaleHours * 60;
}

// raw observed category — DISPLAY source of truth (popup/list/marker still show the frozen reading, badged stale)
function gaugeObsCat(g) {
  const c = g.status.observed.floodCategory;
  return FLOOD_CATS.includes(c) ? c : 'none';
}

// flood-signal gate: a stale sensor never counts as in-flood, so every count/threat/tile that keys
// off gaugeCat (KPI tile, threat strip, sitrep, ticker, drive mode) drops dead gauges automatically
function gaugeCat(g) {
  return gaugeObsStale(g) ? 'none' : gaugeObsCat(g);
}

const riverOf = (name) => String(name || '').split(/ (?:at|near|below|above) /)[0];

function gaugeForecastCat(g) {
  const c = g.status && g.status.forecast && g.status.forecast.floodCategory;
  return FLOOD_CATS.includes(c) ? c : null;
}

function gaugeRising(g) {
  if (gaugeObsStale(g)) return false; // no trustworthy baseline — keep dead gauges out of rising/record-watch
  const f = gaugeForecastCat(g);
  return f !== null && CAT_RANK[f] > CAT_RANK[gaugeCat(g)];
}

// crest-of-record context (data/records.json = NWPS historic crests). Honest by design:
// reports the forecast's margin to the all-time crest, never claims a break unless fcst ≥ record.
const RECORD_NEAR_FT = 5;
function recordContext(g) {
  const rec = state.records && state.records[g.lid];
  const f = g.status && g.status.forecast;
  if (!rec || !f || !(f.primary > 0) || !(rec.record_ft > 0)) return null;
  const margin = +(rec.record_ft - f.primary).toFixed(1); // >0 fcst below record, ≤0 at/above
  const year = (rec.record_date || '').slice(0, 4);
  return { recFt: rec.record_ft, year, margin, atOrAbove: margin <= 0, near: margin > 0 && margin <= RECORD_NEAR_FT };
}
// gauges whose forecast is within RECORD_NEAR_FT of (or above) their crest of record
function recordWatchGauges() {
  return state.gauges.filter((g) => {
    if (!gaugeRising(g)) return false;
    const rc = recordContext(g);
    return rc && (rc.atOrAbove || rc.near);
  });
}

/* observed trend: accumulated across refreshes in localStorage — no extra API calls */
const TREND_KEY = 'respondertx.trend.v1';
function recordTrends() {
  const hist = state.trendHist;
  const cutoff = Date.now() - 2 * 3600000;
  for (const g of state.gauges) {
    const o = g.status.observed;
    if (!(o.primary > -999) || !o.validTime) continue;
    const t = Date.parse(o.validTime);
    const arr = hist[g.lid] = (hist[g.lid] || []).filter((p) => p[0] >= cutoff);
    if (!arr.length || arr[arr.length - 1][0] < t) arr.push([t, o.primary]);
  }
  try { localStorage.setItem(TREND_KEY, JSON.stringify(hist)); } catch { /* quota — trend is best-effort */ }
}
function gaugeTrend(lid) {
  const arr = (state.trendHist[lid] || []).filter((p) => p[0] >= Date.now() - 75 * 60000);
  if (arr.length < 2) return null;
  const dtH = (arr[arr.length - 1][0] - arr[0][0]) / 3600000;
  if (dtH < 0.25) return null;
  const rate = (arr[arr.length - 1][1] - arr[0][1]) / dtH;
  return { rate, dir: rate > 0.2 ? 'up' : rate < -0.2 ? 'down' : 'steady' };
}

function renderGauges() {
  state.layers.gauges.clearLayers();
  state.gaugeMarkers = {};
  // ?hydro=<lid> deep link — open the full hydrograph once its gauge is loaded (once)
  if (state.pendingHydro) {
    const g = state.gauges.find((x) => x.lid === state.pendingHydro);
    if (g) { state.pendingHydro = null; openHydro(g); }
  }
  for (const g of state.gauges) {
    const stale = gaugeObsStale(g);
    const cat = gaugeCat(g);
    const rising = gaugeRising(g);
    const size = stale ? 11 : CAT_SIZE[cat];
    const trend = gaugeTrend(g.lid);
    const falling = cat !== 'none' && trend && trend.dir === 'down';
    // 32px hit area around the visual dot — 8-18px dots are untappable one-thumbed (UX audit #5)
    const icon = L.divIcon({
      className: '',
      html: `<div class="gauge-hit${cat === 'none' && !stale ? ' hit-none' : ''}">` +
        `<div class="gauge-icon ${stale ? 'stale' : `cat-${cat}`}" style="width:${size}px;height:${size}px"></div>` +
        (rising ? `<span class="rise-arrow cat-${gaugeForecastCat(g)}">▲</span>` : '') +
        (falling ? '<span class="fall-arrow">▼</span>' : '') + '</div>',
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
    const m = L.marker([g.latitude, g.longitude], { icon, zIndexOffset: cat === 'major' ? 1000 : rising ? 500 : 0 });
    m.bindPopup(() => gaugePopup(g), { minWidth: 290 });
    state.layers.gauges.addLayer(m);
    state.gaugeMarkers[g.lid] = m;
  }
}

function gaugePopup(g) {
  const o = g.status.observed;
  const stale = gaugeObsStale(g);
  const cat = gaugeObsCat(g);
  const el = document.createElement('div');
  const f = g.status.forecast;
  const fCat = gaugeForecastCat(g);
  const forecastLine = fCat
    ? `<div class="popup-meta">${gaugeRising(g) ? '▲ RISING — ' : ''}Forecast: ${fmtNum(f.primary)} ${esc(f.primaryUnit)} — <span class="cat-word" style="color:var(--cat-${fCat})">${esc(CAT_LABEL[fCat])}</span> @ ${esc(fmtWhen(f.validTime))}</div>`
    : '';
  const tr = gaugeTrend(g.lid);
  const trendLine = tr
    ? `<div class="popup-meta">Trend: ${tr.rate >= 0 ? '+' : ''}${tr.rate.toFixed(1)} ft/hr ${tr.dir === 'up' ? '↑' : tr.dir === 'down' ? '↓' : '→ steady'} (last ~hour)</div>`
    : '';
  el.innerHTML = `<div class="popup-title">${esc(g.name)}</div>` +
    `<div class="popup-meta"><span class="cat-word" style="color:var(--cat-${stale ? 'none' : cat})">${esc(CAT_LABEL[cat])}</span> · ${fmtNum(o.primary)} ${esc(o.primaryUnit)} @ ${esc(fmtWhen(o.validTime))}</div>` +
    (stale ? `<div class="popup-meta stale-note">⏱ STALE — no current data (last obs ${esc(fmtWhen(o.validTime))})</div>` : '') +
    trendLine +
    forecastLine +
    `<div class="popup-spark"><canvas width="270" height="80"></canvas><div class="spark-note">Loading ${CONFIG.sparkHours}h stage history…</div></div>` +
    `<button class="popup-expand" data-lid="${esc(g.lid)}">⤢ Full hydrograph (obs + forecast + record)</button>` +
    `<div class="popup-link"><a href="https://water.noaa.gov/gauges/${esc(g.lid)}" target="_blank" rel="noopener">NOAA gauge page (forecast) →</a></div>`;
  drawSparkline(g, el.querySelector('canvas'), el.querySelector('.spark-note'));
  el.querySelector('.popup-expand').addEventListener('click', () => openHydro(g));
  return el;
}

// full-screen hydrograph: observed history + forecast trace + flood-stage bands + crest-of-record line
async function openHydro(g) {
  $('#hydro-modal').hidden = false;
  $('#hydro-title').textContent = g.name;
  const note = $('#hydro-note');
  note.textContent = 'Loading observed + forecast…';
  try {
    const [detail, obs, fcst] = await Promise.all([
      gaugeJson(g.lid, 'detail', `${CONFIG.nwpsBase}/gauges/${g.lid}`),
      gaugeJson(g.lid, 'series', `${CONFIG.nwpsBase}/gauges/${g.lid}/stageflow/observed`),
      cachedJson(`${CONFIG.nwpsBase}/gauges/${g.lid}/stageflow/forecast`).catch(() => ({ data: [] })),
    ]);
    drawHydro(g, detail, obs.data || [], fcst.data || []);
  } catch { note.textContent = 'Hydrograph data unavailable right now.'; }
}

function drawHydro(g, detail, obsData, fcstData) {
  const now = Date.now();
  const back = now - 24 * 3600000; // 24h observed history
  const obs = obsData.filter((p) => new Date(p.validTime).getTime() >= back && p.primary > -999)
    .map((p) => ({ t: new Date(p.validTime).getTime(), v: p.primary }));
  const fcst = fcstData.filter((p) => p.primary > -999).map((p) => ({ t: new Date(p.validTime).getTime(), v: p.primary }));
  if (obs.length < 2 && fcst.length < 2) { $('#hydro-note').textContent = 'No recent stage data.'; return; }
  const cats = (detail.flood && detail.flood.categories) || {};
  const stages = FLOOD_CATS.map((c) => ({ c, v: cats[c] && cats[c].stage })).filter((s) => s.v > 0);
  const rec = state.records && state.records[g.lid];
  const allV = obs.concat(fcst).map((p) => p.v).concat(stages.map((s) => s.v)).concat(rec ? [rec.record_ft] : []);
  const allT = obs.concat(fcst).map((p) => p.t);
  const minV = Math.min(...allV), maxV = Math.max(...allV), padV = (maxV - minV) * 0.08 || 1;
  const minT = Math.min(...allT), maxT = Math.max(...allT);
  const cv = $('#hydro-canvas'), ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, mL = 46, mR = 16, mT = 16, mB = 34;
  const x = (t) => mL + ((t - minT) / (maxT - minT || 1)) * (W - mL - mR);
  const y = (v) => H - mB - ((v - (minV - padV)) / ((maxV + padV) - (minV - padV))) * (H - mT - mB);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = cssVar('--surface-1'); ctx.fillRect(0, 0, W, H);

  // flood-stage bands (translucent) + labels
  const bandTop = { major: maxV + padV, moderate: cats.major && cats.major.stage, minor: cats.moderate && cats.moderate.stage, action: cats.minor && cats.minor.stage };
  for (const s of stages) {
    const top = bandTop[s.c] || (maxV + padV);
    ctx.fillStyle = cssVar(`--cat-${s.c}`) + '22';
    ctx.fillRect(mL, y(top), W - mL - mR, y(s.v) - y(top));
    ctx.strokeStyle = cssVar(`--cat-${s.c}`); ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(mL, y(s.v)); ctx.lineTo(W - mR, y(s.v)); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = cssVar(`--cat-${s.c}`); ctx.font = '11px system-ui';
    ctx.fillText(`${s.c} ${s.v}ft`, mL + 4, y(s.v) - 3);
  }
  // record-of-crest line
  if (rec && rec.record_ft > 0) {
    ctx.strokeStyle = cssVar('--ink-1'); ctx.lineWidth = 1.5; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(mL, y(rec.record_ft)); ctx.lineTo(W - mR, y(rec.record_ft)); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = cssVar('--ink-1'); ctx.font = 'bold 11px system-ui';
    ctx.fillText(`⚑ crest of record ${rec.record_ft}ft (${(rec.record_date || '').slice(0, 4)})`, mL + 4, y(rec.record_ft) - 3);
  }
  // now marker
  if (now >= minT && now <= maxT) {
    ctx.strokeStyle = cssVar('--ink-muted'); ctx.lineWidth = 1; ctx.setLineDash([1, 3]);
    ctx.beginPath(); ctx.moveTo(x(now), mT); ctx.lineTo(x(now), H - mB); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = cssVar('--ink-muted'); ctx.font = '10px system-ui'; ctx.fillText('now', x(now) + 3, mT + 10);
  }
  // axes: y ticks + x day/hour ticks
  ctx.fillStyle = cssVar('--ink-2'); ctx.font = '10px system-ui'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) { const v = (minV - padV) + (i / 4) * ((maxV + padV) - (minV - padV)); ctx.fillText(v.toFixed(0), mL - 4, y(v) + 3); }
  ctx.textAlign = 'center';
  for (let i = 0; i <= 4; i++) { const t = minT + (i / 4) * (maxT - minT); ctx.fillText(new Date(t).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'numeric', day: 'numeric', hour: 'numeric' }), x(t), H - mB + 16); }
  ctx.textAlign = 'left';
  // observed (solid accent) + forecast (dashed purple)
  const drawTrace = (pts, color, dash) => {
    if (pts.length < 2) return; ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.lineJoin = ctx.lineCap = 'round'; ctx.setLineDash(dash);
    ctx.beginPath(); pts.forEach((p, i) => { i ? ctx.lineTo(x(p.t), y(p.v)) : ctx.moveTo(x(p.t), y(p.v)); }); ctx.stroke(); ctx.setLineDash([]);
  };
  drawTrace(obs, cssVar('--accent'), []);
  if (obs.length && fcst.length) fcst.unshift(obs[obs.length - 1]); // join obs→forecast
  drawTrace(fcst, cssVar('--cat-major'), [6, 4]);

  $('#hydro-legend').innerHTML =
    '<span class="hl"><i style="background:var(--accent)"></i>observed (24h)</span>' +
    '<span class="hl"><i style="background:var(--cat-major)"></i>forecast</span>' +
    (rec ? '<span class="hl"><i class="dashed"></i>crest of record</span>' : '') +
    '<span class="hl">shaded = flood-stage bands</span>';
  $('#hydro-note').innerHTML = `Observed + NWPS forecast · <a href="https://water.noaa.gov/gauges/${esc(g.lid)}" target="_blank" rel="noopener">NOAA gauge page →</a>`;
}

// 3-min TTL promise cache — popup close/reopen redraws instantly; failures evict so retry works
const sparkCache = new Map();
function cachedJson(url, ttlMs = 180000) {
  const hit = sparkCache.get(url);
  if (hit && Date.now() - hit.t < ttlMs) return hit.p;
  const p = fetch(url).then((r) => { if (!r.ok) throw new Error(`http ${r.status}`); return r.json(); });
  sparkCache.set(url, { t: Date.now(), p });
  p.catch(() => sparkCache.delete(url));
  return p;
}

// same-origin /api/gauge proxy (CF edge / server.py, both 3-min cached) first; direct NOAA on miss
function gaugeJson(lid, kind, directUrl) {
  return cachedJson(`api/gauge/${lid}/${kind}`).catch(() => cachedJson(directUrl));
}

async function drawSparkline(g, canvas, note) {
  try {
    const [detail, series] = await Promise.all([
      gaugeJson(g.lid, 'detail', `${CONFIG.nwpsBase}/gauges/${g.lid}`),
      gaugeJson(g.lid, 'series', `${CONFIG.nwpsBase}/gauges/${g.lid}/stageflow/observed`),
    ]);
    const cutoff = Date.now() - CONFIG.sparkHours * 3600000;
    let pts = (series.data || []).filter((p) => new Date(p.validTime).getTime() >= cutoff && p.primary > -999);
    if (pts.length < 2) { note.textContent = 'No recent stage history available.'; return; }
    const step = Math.max(1, Math.floor(pts.length / 220));
    pts = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);

    const cats = (detail.flood && detail.flood.categories) || {};
    const stages = FLOOD_CATS.map((c) => ({ c, v: cats[c] && cats[c].stage })).filter((s) => s.v > 0);
    const vals = pts.map((p) => p.primary).concat(stages.map((s) => s.v));
    const min = Math.min(...vals), max = Math.max(...vals);
    const pad = (max - min) * 0.1 || 1;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height, mL = 4, mR = 40, mT = 6, mB = 6;
    const x = (i) => mL + (i / (pts.length - 1)) * (W - mL - mR);
    const y = (v) => H - mB - ((v - (min - pad)) / ((max + pad) - (min - pad))) * (H - mT - mB);
    ctx.clearRect(0, 0, W, H);

    for (const s of stages) {
      ctx.strokeStyle = cssVar(`--cat-${s.c}`);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(mL, y(s.v)); ctx.lineTo(W - mR, y(s.v)); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = cssVar('--accent');
    ctx.lineWidth = 2;
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => { i ? ctx.lineTo(x(i), y(p.primary)) : ctx.moveTo(x(i), y(p.primary)); });
    ctx.stroke();

    const last = pts[pts.length - 1];
    ctx.fillStyle = cssVar('--accent');
    ctx.strokeStyle = cssVar('--surface-1');
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x(pts.length - 1), y(last.primary), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = cssVar('--ink-1');
    ctx.font = '11px system-ui';
    ctx.fillText(`${last.primary} ft`, W - mR + 4, y(last.primary) + 4);
    note.textContent = `Last ${CONFIG.sparkHours}h · dashed lines = action/minor/moderate/major stages`;
  } catch { note.textContent = 'Stage history unavailable.'; }
}

/* ---------- RFC forecast-max crests (5-day max stage per gauge) ---------- */

function inGaugeBbox(lat, lon) {
  const b = CONFIG.gaugeBbox;
  return lat >= b.ymin && lat <= b.ymax && lon >= b.xmin && lon <= b.xmax;
}

// issued_time is "YYYY-MM-DD HH:MM:SS UTC", not ISO
const fcstIssuedIso = (t) => String(t || '').replace(' ', 'T').replace(' UTC', 'Z');

async function fetchFcstMax() {
  const params = new URLSearchParams({
    where: "nws_lid LIKE '%T2' AND max_status NOT IN ('no_flooding','not_defined')",
    outFields: 'nws_lid,nws_name,max_value,max_status,issued_time',
    returnGeometry: 'true',
    f: 'geojson',
  });
  const res = await fetch(`${CONFIG.fcstMaxUrl}?${params}`);
  if (!res.ok) throw new Error(`RFC fcst HTTP ${res.status}`);
  const data = await res.json();
  // NWPS gauges already show their own forecast — keep only lids this board lacks
  const nwpsLids = new Set(state.gauges.map((g) => g.lid));
  state.fcstMax = (data.features || []).filter((f) => {
    const [lon, lat] = f.geometry.coordinates;
    return inGaugeBbox(lat, lon) && !nwpsLids.has(f.properties.nws_lid);
  });
  markHealthy('fcstMax');
  renderFcstMax();
}

function renderFcstMax() {
  state.layers.fcstMax.clearLayers();
  for (const f of state.fcstMax) {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const cat = FLOOD_CATS.includes(p.max_status) ? p.max_status : 'none';
    const size = CAT_SIZE[cat];
    const icon = L.divIcon({
      className: '',
      html: `<div class="gauge-hit"><div class="fcst-ring cat-${cat}" style="width:${size}px;height:${size}px"></div></div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
    const m = L.marker([lat, lon], { icon });
    m.bindPopup(`<div class="popup-title">${esc(p.nws_name)}</div>` +
      `<div class="popup-meta">Forecast max: ${fmtNum(p.max_value)} ft — <span class="cat-word" style="color:var(--cat-${cat})">${esc(CAT_LABEL[cat])}</span> (5-day)</div>` +
      `<div class="popup-meta">Issued ${esc(fmtWhen(fcstIssuedIso(p.issued_time)))}</div>` +
      `<div class="popup-link"><a href="https://water.noaa.gov/gauges/${esc(p.nws_lid)}" target="_blank" rel="noopener">NOAA gauge page →</a></div>`);
    state.layers.fcstMax.addLayer(m);
  }
}

/* ---------- USGS instantaneous values (raw stage — no flood-stage context) ---------- */

async function fetchUsgsIv() {
  const b = CONFIG.gaugeBbox;
  const url = `${CONFIG.usgsIvBase}?format=json&parameterCd=00065&modifiedSince=PT2H&bBox=${b.xmin},${b.ymin},${b.xmax},${b.ymax}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`USGS IV HTTP ${res.status}`);
  const data = await res.json();
  const sites = [];
  for (const ts of (data.value && data.value.timeSeries) || []) {
    const si = ts.sourceInfo;
    const vals = ts.values && ts.values[0] && ts.values[0].value;
    const last = vals && vals[vals.length - 1];
    if (!last) continue;
    const ft = parseFloat(last.value);
    if (!Number.isFinite(ft) || ft <= -999) continue;
    const loc = si.geoLocation.geogLocation;
    sites.push({ site: si.siteCode[0].value, name: si.siteName, lat: loc.latitude, lon: loc.longitude, ft, t: last.dateTime });
  }
  // NWPS gauges carry flood categories — keep USGS to the sites NWPS lacks
  state.usgsSites = sites.filter((s) => !state.gauges.some((g) => distMi(s.lat, s.lon, g.latitude, g.longitude) < 0.3));
  markHealthy('usgs');
  renderUsgsIv();
}

function renderUsgsIv() {
  state.layers.usgs.clearLayers();
  for (const s of state.usgsSites) {
    const icon = L.divIcon({ className: '', html: '<div class="usgs-dot"></div>', iconSize: [24, 24], iconAnchor: [12, 12] });
    const m = L.marker([s.lat, s.lon], { icon });
    // raw stage has no flood-stage thresholds here — never imply a category
    m.bindPopup(`<div class="popup-title">${esc(s.name)}</div>` +
      `<div class="popup-meta">Stage: ${s.ft} ft @ ${esc(fmtWhen(s.t))} — raw reading, no flood-stage context</div>` +
      `<div class="popup-link"><a href="https://waterdata.usgs.gov/monitoring-location/${esc(s.site)}" target="_blank" rel="noopener">USGS site page →</a></div>`);
    state.layers.usgs.addLayer(m);
  }
}

/* ---------- TxDOT DriveTexas live road conditions (closed / high-water / damage) ---------- */

const ROAD_ATTRIB = 'Road conditions: TxDOT DriveTexas (drivetexas.org)';
// F/Z/D only — the flood-relevant subset. Z=Closed and F=Flood are prominent reds, D=Damage a distinct amber.
const ROAD_COND = {
  Z: { label: 'Road CLOSED', color: '#e5342f' },
  F: { label: 'Flooded / high water', color: '#d81b8c' },
  D: { label: 'Road damage', color: '#e8912b' },
};
const ROAD_COND_FALLBACK = { label: 'Road condition', color: '#e8912b' };
const roadCondType = (p) => ROAD_COND[p && p.CNSTRNT_TYPE_CD] || ROAD_COND_FALLBACK;
const stripHtml = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
// active = ongoing: keep when COND_END_TS is missing/empty, drop when it is a past epoch-ms (cleared closure)
const roadCondActive = (f) => { const e = f.properties && f.properties.COND_END_TS; return !(e && e < Date.now()); };

function roadParams(outFields) {
  const b = CONFIG.gaugeBbox;
  return new URLSearchParams({
    where: "CNSTRNT_TYPE_CD IN ('F','Z','D')",
    geometry: `${b.xmin},${b.ymin},${b.xmax},${b.ymax}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outSR: '4326',
    outFields,
    f: 'geojson',
  });
}

async function fetchRoadClosures() {
  const lineFields = 'CNSTRNT_TYPE_CD,RTE_NM,RDWAY_NM,COND_DSCR,COND_LMT_FROM_DSCR,COND_LMT_TO_DSCR,COND_START_TS,COND_END_TS,CNSTRNT_DETOUR_FLAG,TRVL_DRCT_CD';
  const pointFields = 'CNSTRNT_TYPE_CD,RTE_NM,RDWAY_NM,COND_DSCR,LMT_FROM_DSCR,LMT_TO_DSCR,COND_START_TS,COND_END_TS,CNSTRNT_DETOUR_FLAG,TRVL_DRCT_CD';
  const getJson = async (url, what) => { const r = await fetch(url); if (!r.ok) throw new Error(`TxDOT ${what} HTTP ${r.status}`); return r.json(); };
  const [lineData, pointData] = await Promise.all([
    getJson(`${CONFIG.hcrsLineUrl}?${roadParams(lineFields)}`, 'lines'),
    getJson(`${CONFIG.hcrsPointUrl}?${roadParams(pointFields)}`, 'points'),
  ]);
  state.roadClosures = {
    lines: (lineData.features || []).filter(roadCondActive),
    points: (pointData.features || []).filter(roadCondActive),
  };
  markHealthy('roads');
  renderRoadClosures();
}

function roadPopupHtml(p) {
  const ct = roadCondType(p);
  const road = [p.RTE_NM, p.RDWAY_NM].map((s) => String(s || '').trim()).filter(Boolean).join(' · ') || 'Road';
  const from = p.COND_LMT_FROM_DSCR || p.LMT_FROM_DSCR || '';
  const to = p.COND_LMT_TO_DSCR || p.LMT_TO_DSCR || '';
  const dscr = stripHtml(p.COND_DSCR);
  const detour = ['Y', '1', 'TRUE'].includes(String(p.CNSTRNT_DETOUR_FLAG || '').toUpperCase());
  return `<div class="popup-title" style="color:${ct.color}">${esc(ct.label)}</div>` +
    `<div class="popup-meta"><strong>${esc(road)}</strong></div>` +
    ((from || to) ? `<div class="popup-meta">${esc(from)}${from && to ? ' → ' : ''}${esc(to)}</div>` : '') +
    (dscr ? `<div class="popup-meta">${esc(dscr)}</div>` : '') +
    (p.COND_START_TS ? `<div class="popup-meta">Since ${esc(fmtWhen(new Date(p.COND_START_TS).toISOString()))}</div>` : '') +
    (detour ? '<div class="popup-meta">Detour available</div>' : '') +
    `<div class="popup-meta" style="opacity:.7;margin-top:4px">${esc(ROAD_ATTRIB)} · live conditions, not a closure guarantee — verify before routing</div>`;
}

function renderRoadClosures() {
  const layer = state.layers.roadClosures;
  if (!layer) return;
  layer.clearLayers();
  const rc = state.roadClosures || { lines: [], points: [] };
  for (const f of rc.lines) {
    if (!f.geometry) continue;
    const ct = roadCondType(f.properties);
    const gj = L.geoJSON(f, { style: { color: ct.color, weight: 5, opacity: 0.9 }, attribution: ROAD_ATTRIB });
    gj.bindPopup(roadPopupHtml(f.properties));
    layer.addLayer(gj);
  }
  for (const f of rc.points) {
    const c = f.geometry && f.geometry.coordinates;
    if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    const ct = roadCondType(f.properties);
    const m = L.circleMarker([c[1], c[0]], { radius: 7, color: '#fff', weight: 1.5, fillColor: ct.color, fillOpacity: 0.95, attribution: ROAD_ATTRIB });
    m.bindPopup(roadPopupHtml(f.properties));
    layer.addLayer(m);
  }
}

/* ---------- IEM local storm reports (ground truth) ---------- */

async function fetchLsrs() {
  const hours = state.filters.window ? Math.max(2, Math.ceil(+state.filters.window / 60)) : CONFIG.lsrHours;
  const res = await fetch(`${CONFIG.lsrUrl}?hours=${hours}&states=TX`);
  if (!res.ok) throw new Error(`LSR HTTP ${res.status}`);
  const data = await res.json();
  state.lsrs = (data.features || [])
    .filter((f) => LSR_FLOOD_RE.test(f.properties.typetext || ''))
    .sort((a, b) => new Date(b.properties.valid) - new Date(a.properties.valid));
  markHealthy('lsrs');
  recordLsrHist();
  renderLsrs();
}

function highlightRoads(text) {
  return esc(text).replace(ROAD_RE, (m) => `<span class="road-chip">${m}</span>`);
}

function lsrPopupHtml(e) {
  return `<div class="popup-title">💧 ${esc(e.typetext)}${e.magnitude ? ` — ${esc(e.magnitude)} ${esc(e.unit || '')}` : ''}</div>` +
    `<div class="popup-meta">${esc(e.city)}, ${esc(e.county)} Co. · ${esc(e.source)} · ${esc(fmtWhen(e.t))}</div>` +
    (e.remark ? `<div style="margin-top:4px">${highlightRoads(e.remark)}</div>` : '') +
    `<div class="popup-link"><a href="https://maps.google.com/?q=${e.lat},${e.lon}" target="_blank" rel="noopener">navigate →</a> · USNG ${esc(toUSNG(e.lat, e.lon))}</div>`;
}

function lsrCardDiv(e, aged) {
  const div = document.createElement('div');
  div.className = `card lsr-card${aged ? ' aged' : ''}`;
  div.innerHTML = `<div class="head"><span>💧</span><span class="type-chip">${esc(e.typetext)}</span>` +
    `<span class="when"><span class="fresh-dot ${freshClass(e.t)}"></span> ${esc(fmtWhen(e.t))}</span></div>` +
    (e.remark ? `<div class="summary">${highlightRoads(e.remark)}</div>` : '') +
    `<div class="meta">📍 ${esc(e.city)}, ${esc(e.county)} Co. · via ${esc(e.source)}` +
    (state.myPos ? ` · ${distMi(state.myPos.lat, state.myPos.lng, e.lat, e.lon).toFixed(1)} mi` : '') + '</div>';
  div.addEventListener('click', () => state.map.setView([e.lat, e.lon], 12));
  return div;
}

function renderLsrs() {
  // live layer is hard-capped at lsrMaxHours regardless of a wider window filter — older reports route to lsrsAged (history), never delete
  const cutoff = Math.min(lsrFreshCutoffMins(), CONFIG.lsrMaxHours * 60);
  const live = state.lsrs.map((f) => {
    const [lon, lat] = f.geometry.coordinates;
    const p = f.properties;
    return { t: p.valid, lat, lon, typetext: p.typetext, magnitude: p.magnitude, unit: p.unit, city: p.city, county: p.county, source: p.source, remark: p.remark };
  });
  const liveKeys = new Set(live.map((e) => `${e.t}|${e.lat}|${e.lon}`));
  const fresh = live.filter((e) => ageMins(e.t) <= cutoff);
  // aged = timed-out live reports + persisted history the API window no longer returns
  const aged = live.filter((e) => ageMins(e.t) > cutoff)
    .concat(Object.entries(state.hist.lsrs).filter(([k]) => !liveKeys.has(k)).map(([, e]) => e))
    .sort((a, b) => new Date(b.t) - new Date(a.t));

  state.layers.lsrs.clearLayers();
  state.layers.lsrsAged.clearLayers();
  for (const e of fresh) {
    const icon = L.divIcon({ className: '', html: `<div class="lsr-icon ${freshClass(e.t)}">💧</div>`, iconSize: [22, 22] });
    state.layers.lsrs.addLayer(L.marker([e.lat, e.lon], { icon }).bindPopup(lsrPopupHtml(e)));
  }
  for (const e of aged) {
    const icon = L.divIcon({ className: '', html: '<div class="lsr-icon aged-icon">💧</div>', iconSize: [22, 22] });
    state.layers.lsrsAged.addLayer(L.marker([e.lat, e.lon], { icon }).bindPopup(lsrPopupHtml(e)));
  }

  const el = $('#lsr-list');
  el.innerHTML = '<div class="section-title">Ground truth — storm reports (spotter/official)</div>';
  if (!fresh.length) el.innerHTML += `<div class="card">No flood storm reports in TX in the last ${Math.round(cutoff / 60)}h.</div>`;
  const lsrCap = state.showAllLsrs ? 30 : 5;
  for (const e of fresh.slice(0, lsrCap)) el.appendChild(lsrCardDiv(e, false));
  if (fresh.length > 5) {
    const more = document.createElement('button');
    more.className = 'aged-toggle';
    more.textContent = state.showAllLsrs ? '▾ show fewer reports' : `▸ show ${Math.min(fresh.length, 30) - 5} more recent reports`;
    more.addEventListener('click', () => { state.showAllLsrs = !state.showAllLsrs; renderLsrs(); });
    el.appendChild(more);
  }
  if (aged.length) {
    const btn = document.createElement('button');
    btn.id = 'lsr-aged-toggle';
    btn.className = 'aged-toggle';
    btn.textContent = `${state.showAgedLsrs ? '▾ hide' : '▸ show'} ${aged.length} aged reports (>${Math.round(cutoff / 60)}h, kept ${CONFIG.histDays}d)`;
    btn.addEventListener('click', () => { state.showAgedLsrs = !state.showAgedLsrs; renderLsrs(); });
    el.appendChild(btn);
    if (state.showAgedLsrs) for (const e of aged.slice(0, 40)) el.appendChild(lsrCardDiv(e, true));
  }
  renderTicker();
}

function renderForecastList() {
  const el = $('#forecast-list');
  const rising = state.gauges
    .filter((g) => gaugeRising(g) && CAT_RANK[gaugeForecastCat(g)] >= CAT_RANK.minor)
    .sort((a, b) => CAT_RANK[gaugeForecastCat(b)] - CAT_RANK[gaugeForecastCat(a)]
      || new Date(a.status.forecast.validTime) - new Date(b.status.forecast.validTime));
  el.innerHTML = `<div class="section-title">${esc(t('sec.forecast'))}</div>`;
  if (!rising.length) { el.innerHTML += `<div class="card">${esc(t('sec.forecast.empty'))}</div>`; return; }
  for (const g of rising) {
    const fCat = gaugeForecastCat(g);
    const f = g.status.forecast;
    const div = document.createElement('div');
    div.className = 'card';
    div.style.borderLeftColor = `var(--cat-${fCat})`;
    div.innerHTML = `<div class="head"><span>▲</span><span class="type-chip">${esc(CAT_LABEL[gaugeCat(g)])} → <span style="color:var(--cat-${fCat})">${esc(CAT_LABEL[fCat])}</span></span>` +
      `<span class="when">crest ${esc(fmtWhen(f.validTime))}</span></div>` +
      `<div class="summary">${esc(g.name)} — forecast crest ${fmtNum(f.primary)} ${esc(f.primaryUnit)}</div>`;
    div.addEventListener('click', () => state.map.setView([g.latitude, g.longitude], 11));
    el.appendChild(div);
  }
}

/* ---------- gauges tab — bucketed by actionability ---------- */

function focusGauge(g) {
  state.map.setView([g.latitude, g.longitude], 11);
  const mk = state.gaugeMarkers && state.gaugeMarkers[g.lid];
  if (mk) mk.openPopup();
  // phone layout: the map is above the scrolled list — make the pan visible
  if (window.innerWidth <= 768) $('#map').scrollIntoView({ behavior: 'smooth' });
}

function gaugeGlyphHtml(g) {
  if (gaugeObsStale(g)) return '<span class="stale-glyph" title="stale — no current data">⏱</span>';
  if (gaugeRising(g)) return `<span style="color:var(--cat-${gaugeForecastCat(g)})">▲</span>`;
  const cat = gaugeCat(g);
  if (cat === 'none') return '<span style="color:var(--cat-none)">○</span>';
  if ((gaugeTrend(g.lid) || {}).dir === 'down') return '<span style="color:var(--good)">▼</span>';
  return `<span style="color:var(--cat-${cat})">●</span>`;
}

function gaugeCardDiv(g) {
  const stale = gaugeObsStale(g);
  const cat = gaugeObsCat(g);
  const o = g.status.observed;
  const tr = stale ? null : gaugeTrend(g.lid);
  const fCat = gaugeForecastCat(g);
  const f = g.status.forecast;
  const site = g.name.slice(riverOf(g.name).length).trim();
  const div = document.createElement('div');
  div.className = `card gauge-card${stale ? ' stale' : (cat === 'none' && !gaugeRising(g) ? ' aged' : '')}`;
  div.style.borderLeftColor = stale ? 'var(--cat-none)' : `var(--cat-${cat})`;
  const trendBit = tr ? ` ${tr.dir === 'up' ? '↑' : tr.dir === 'down' ? '↓' : '→'} ${tr.rate >= 0 ? '+' : ''}${tr.rate.toFixed(1)} ft/hr` : '';
  div.innerHTML = `<div class="head">${gaugeGlyphHtml(g)}<span class="g-name">${esc(g.name)}</span>` +
    `<span class="when"><a href="https://water.noaa.gov/gauges/${esc(g.lid)}" target="_blank" rel="noopener" style="color:var(--accent)">NWPS →</a></span></div>` +
    `<div class="meta">OBS ${fmtNum(o.primary)} ${esc(o.primaryUnit)} · <span class="cat-word" style="color:var(--cat-${stale ? 'none' : cat})">${cat === 'none' ? 'no flooding' : esc(cat)}</span>${trendBit}</div>` +
    (stale ? `<div class="meta stale-note">⏱ STALE — no current data (last obs ${esc(fmtWhen(o.validTime))})</div>` : '') +
    (fCat ? `<div class="meta">crest ${fmtNum(f.primary)} ${esc(f.primaryUnit)} · <span class="cat-word" style="color:var(--cat-${fCat})">${esc(fCat)}</span> · ${esc(fmtWhen(f.validTime))}</div>` : '') +
    recordLineHtml(g) +
    (site ? `<div class="meta">📍 ${esc(site)}</div>` : '');
  div.addEventListener('click', (ev) => { if (ev.target.closest('a')) return; focusGauge(g); });
  return div;
}

// one honest line: at/above the crest of record, or N ft below it (with year)
function recordLineHtml(g) {
  const rc = recordContext(g);
  if (!rc) return '';
  if (rc.atOrAbove) {
    return `<div class="meta record-line at"><strong>⚑ AT/ABOVE CREST OF RECORD</strong> — record ${rc.recFt} ft (${esc(rc.year)}); forecast ${Math.abs(rc.margin)} ft over</div>`;
  }
  if (rc.near) {
    return `<div class="meta record-line near">⚑ approaching crest of record — record ${rc.recFt} ft (${esc(rc.year)}); forecast ${rc.margin} ft below</div>`;
  }
  return '';
}

// crest-wave tracker: on one river the forecast-crest time IS the wave's arrival order,
// so ordering a river's gauges by crest validTime shows the crest marching downstream.
// pure NWPS validTime data — no interpolation between gauges (would be fake precision).
function waveRivers() {
  const withCrest = state.gauges.filter((g) => {
    if (gaugeObsStale(g)) return false; // dead sensor — its crest wave is not trustworthy live data
    const f = g.status && g.status.forecast;
    return f && f.validTime && f.primary > 0 && CAT_RANK[gaugeForecastCat(g)] >= CAT_RANK.action;
  });
  const byRiver = {};
  for (const g of withCrest) (byRiver[riverOf(g.name)] = byRiver[riverOf(g.name)] || []).push(g);
  const crestT = (g) => new Date(g.status.forecast.validTime).getTime();
  return Object.keys(byRiver)
    .map((river) => [river, byRiver[river].sort((a, b) => crestT(a) - crestT(b))])
    .filter(([, gs]) => gs.length >= 2) // a "wave" needs ≥2 points on the same river
    .sort((a, b) => crestT(a[1][0]) - crestT(b[1][0]));
}

function renderWave() {
  const el = $('#wave-list');
  if (!el) return;
  const rivers = waveRivers();
  if (!rivers.length) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  // collapsed by default (owner: the gauge list, not the crest view, is what opens) — state persists
  const open = localStorage.getItem('respondertx.waveOpen') === '1';
  const now = Date.now();
  let body = '';
  for (const [river, gs] of rivers) {
    body += `<div class="wave-river">${esc(river)} <span class="wave-hint">crest arrival order →</span></div>`;
    for (const g of gs) {
      const f = g.status.forecast;
      const fCat = gaugeForecastCat(g);
      const past = new Date(f.validTime).getTime() < now;
      const site = g.name.slice(riverOf(g.name).length).trim() || g.name;
      body += `<button class="wave-row" data-lid="${esc(g.lid)}">` +
        `<span class="wave-dot" style="background:var(--cat-${fCat})"></span>` +
        `<span class="wave-site">${esc(site)}</span>` +
        `<span class="wave-stage" style="color:var(--cat-${fCat})">${fmtNum(f.primary)} ft ${esc(fCat)}</span>` +
        `<span class="wave-eta ${past ? 'past' : ''}">${past ? 'crested' : 'crest'} ${esc(fmtWhen(f.validTime))}</span></button>`;
    }
  }
  const nGauges = rivers.reduce((s, [, gs]) => s + gs.length, 0);
  el.innerHTML = `<button class="wave-toggle${open ? ' open' : ''}" id="wave-toggle">` +
    `<span>${esc(t('sec.wave'))}</span>` +
    `<span class="wave-count">${rivers.length} rivers · ${nGauges} pts ${open ? '▾' : '▸'}</span></button>` +
    `<div class="wave-body"${open ? '' : ' hidden'}>${body}</div>`;
  $('#wave-toggle').addEventListener('click', () => {
    const nowOpen = $('.wave-body').hasAttribute('hidden');
    $('.wave-body').hidden = !nowOpen;
    localStorage.setItem('respondertx.waveOpen', nowOpen ? '1' : '0');
    $('#wave-toggle').classList.toggle('open', nowOpen);
    $('.wave-count').textContent = `${rivers.length} rivers · ${nGauges} pts ${nowOpen ? '▾' : '▸'}`;
  });
  el.querySelectorAll('.wave-row').forEach((b) => b.addEventListener('click', () => {
    const g = state.gauges.find((x) => x.lid === b.dataset.lid);
    if (g) focusGauge(g);
  }));
}

/* ---------- Drive Mode: big-type nearest-hazards glance list ---------- */

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function bearing(fromLat, fromLon, toLat, toLon) {
  const toR = Math.PI / 180;
  const dLon = (toLon - fromLon) * toR;
  const y = Math.sin(dLon) * Math.cos(toLat * toR);
  const x = Math.cos(fromLat * toR) * Math.sin(toLat * toR) - Math.sin(fromLat * toR) * Math.cos(toLat * toR) * Math.cos(dLon);
  return COMPASS[Math.round((((Math.atan2(y, x) / toR) + 360) % 360) / 45) % 8];
}

// hazards a driver cares about: closed/caution crossings, life-safety + road/cutoff notices, major/rising gauges
function driveItems() {
  const items = [];
  for (const c of (state.crossings || [])) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
    const st = CROSSING_STATUS[c.status] || CROSSING_STATUS.caution;
    if (c.status === 'open') continue;
    items.push({ glyph: st.glyph, color: st.color, name: c.name, sub: `${st.label} crossing`, lat: c.lat, lon: c.lon, rank: c.status === 'closed' ? 0 : 2 });
  }
  for (const r of activeRequests().filter((x) => x.status !== 'resolved')) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    if (!LIFE_SAFETY_TYPES.includes(r.type) && r.type !== 'road') continue;
    items.push({ glyph: TYPE_GLYPH[r.type] || '📍', color: r.priority === 'critical' ? 'var(--sev-emergency)' : 'var(--sev-warning)', name: r.summary, sub: `${r.type} · ${r.place}`, lat: r.lat, lon: r.lon, rank: r.priority === 'critical' ? 0 : 1 });
  }
  for (const g of state.gauges.filter((x) => gaugeCat(x) === 'major' || (gaugeRising(x) && gaugeForecastCat(x) === 'major'))) {
    items.push({ glyph: '●', color: 'var(--cat-major)', name: g.name, sub: gaugeCat(g) === 'major' ? 'MAJOR flood now' : 'rising to MAJOR', lat: g.latitude, lon: g.longitude, rank: 1 });
  }
  const p = state.myPos;
  if (p) {
    for (const it of items) { it.dist = distMi(p.lat, p.lng, it.lat, it.lon); it.brng = bearing(p.lat, p.lng, it.lat, it.lon); }
    items.sort((a, b) => a.dist - b.dist);
  } else {
    items.sort((a, b) => a.rank - b.rank);
  }
  return items.slice(0, 14);
}

function renderDriveMode() {
  if ($('#drive-mode').hidden) return;
  const emerg = state.alerts.filter((a) => a._sev === 'emergency');
  const soonest = state.gauges
    .filter((g) => gaugeRising(g) && CAT_RANK[gaugeForecastCat(g)] >= CAT_RANK.moderate && new Date(g.status.forecast.validTime) > new Date())
    .sort((a, b) => new Date(a.status.forecast.validTime) - new Date(b.status.forecast.validTime))[0];
  $('#drive-threat').innerHTML =
    (emerg.length ? `<div class="dt-emerg">⚠ ${emerg.length} ${esc(t('drive.emerg'))} — ${esc(emerg.map((a) => a.properties.areaDesc).join('; '))}</div>` : '') +
    (soonest ? `<div class="dt-crest">${esc(t('drive.nextcrest'))} ${esc(riverOf(soonest.name))} ${esc(fmtWhen(soonest.status.forecast.validTime))}</div>` : '') +
    (state.myPos ? '' : `<div class="dt-nogps">${esc(t('drive.nogps'))}</div>`);
  const items = driveItems();
  $('#drive-list').innerHTML = items.length ? items.map((it) => {
    const distBit = it.dist != null ? `<span class="d-dist">${it.dist.toFixed(1)} ${esc(t('risk.mi'))} ${it.brng}</span>` : '';
    return `<button class="drive-row" data-lat="${it.lat}" data-lon="${it.lon}">` +
      `<span class="d-glyph" style="color:${it.color}">${it.glyph}</span>` +
      `<span class="d-body"><span class="d-name">${esc(it.name)}</span><span class="d-sub">${esc(it.sub)}</span></span>${distBit}</button>`;
  }).join('') : `<div class="dt-nogps">${esc(t('drive.nohaz'))}</div>`;
  $('#drive-list').querySelectorAll('.drive-row').forEach((b) => b.addEventListener('click', () => {
    $('#drive-mode').hidden = true;
    state.map.setView([+b.dataset.lat, +b.dataset.lon], 13);
  }));
}

function renderGaugesTab() {
  renderWave();
  const el = $('#gauge-list');
  if (!el) return;
  const inFlood = state.gauges.filter((g) => gaugeCat(g) !== 'none');
  const badge = $('#gauges-count');
  badge.textContent = inFlood.length;
  badge.classList.toggle('sev', inFlood.some((g) => gaugeCat(g) === 'major'));

  // double-listing precedence: rising wins, then falling, then in-flood
  const rising = state.gauges.filter(gaugeRising)
    .sort((a, b) => new Date(a.status.forecast.validTime) - new Date(b.status.forecast.validTime));
  const risingLids = new Set(rising.map((g) => g.lid));
  const inFloodOnly = inFlood.filter((g) => !risingLids.has(g.lid));
  const falling = inFloodOnly.filter((g) => (gaugeTrend(g.lid) || {}).dir === 'down');
  const fallingLids = new Set(falling.map((g) => g.lid));
  const holding = inFloodOnly.filter((g) => !fallingLids.has(g.lid))
    .sort((a, b) => CAT_RANK[gaugeCat(b)] - CAT_RANK[gaugeCat(a)] || b.status.observed.primary - a.status.observed.primary);
  const normal = state.gauges.filter((g) => gaugeCat(g) === 'none' && !risingLids.has(g.lid))
    .sort((a, b) => a.name.localeCompare(b.name));
  // gaugeCat maps stale sensors to 'none', so this bucket mixes truly-normal and dead gauges — count them apart for an honest label
  const normalStale = normal.filter(gaugeObsStale).length;

  el.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'filters group-toggle';
  for (const [key, label] of [['priority', t('sec.gauge.bypri')], ['river', t('sec.gauge.byriver')]]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.classList.toggle('on', state.gaugeGroup === key);
    b.addEventListener('click', () => { state.gaugeGroup = key; renderGaugesTab(); });
    bar.appendChild(b);
  }
  el.appendChild(bar);

  const section = (title, list) => {
    const t = document.createElement('div');
    t.className = 'section-title';
    t.textContent = title;
    el.appendChild(t);
    for (const g of list) el.appendChild(gaugeCardDiv(g));
  };
  if (state.gaugeGroup === 'river') {
    // NWPS gauge objects carry no county — group by river name derived from the site name
    const groups = new Map();
    for (const g of rising.concat(holding, falling)) {
      const r = riverOf(g.name);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(g);
    }
    for (const [river, list] of groups) section(`${river} (${list.length})`, list);
  } else {
    if (rising.length) section(`${t('sec.gauge.rising')} (${rising.length})`, rising);
    if (holding.length) section(`${t('sec.gauge.inflood')} (${holding.length})`, holding);
    if (falling.length) section(`${t('sec.gauge.falling')} (${falling.length})`, falling);
  }
  if (!rising.length && !holding.length && !falling.length) {
    const none = document.createElement('div');
    none.className = 'card';
    none.textContent = state.gauges.length ? t('sec.gauge.empty') : t('sec.gauge.noload');
    el.appendChild(none);
  }
  if (normal.length) {
    const btn = document.createElement('button');
    btn.className = 'aged-toggle';
    btn.textContent = normalStale
      ? `${state.showNormalGauges ? '▾ hide' : '▸ show'} ${normal.length} gauges — ${normal.length - normalStale} normal · ${normalStale} stale`
      : `${state.showNormalGauges ? '▾ hide' : '▸ show'} ${normal.length} gauges normal`;
    btn.addEventListener('click', () => { state.showNormalGauges = !state.showNormalGauges; renderGaugesTab(); });
    el.appendChild(btn);
    if (state.showNormalGauges) for (const g of normal) el.appendChild(gaugeCardDiv(g));
  }
}

/* ---------- aging & history — timed-out items suppress to toggleable layers, never delete ---------- */

const HIST_KEY = 'respondertx.hist.v1';
function loadHist() {
  try { state.hist = Object.assign({ lsrs: {}, alerts: {} }, JSON.parse(localStorage.getItem(HIST_KEY) || '{}')); }
  catch { state.hist = { lsrs: {}, alerts: {} }; }
}
function saveHist() {
  const cutoff = Date.now() - CONFIG.histDays * 86400000;
  for (const bucket of [state.hist.lsrs, state.hist.alerts]) {
    for (const k of Object.keys(bucket)) { if (new Date(bucket[k].t).getTime() < cutoff) delete bucket[k]; }
  }
  try { localStorage.setItem(HIST_KEY, JSON.stringify(state.hist)); } catch { /* quota — history is best-effort */ }
}
function recordLsrHist() {
  for (const f of state.lsrs) {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    state.hist.lsrs[`${p.valid}|${lat}|${lon}`] = {
      t: p.valid, lat, lon, typetext: p.typetext, magnitude: p.magnitude, unit: p.unit,
      city: p.city, county: p.county, source: p.source, remark: p.remark,
    };
  }
  saveHist();
}
function recordAlertHist() {
  for (const f of state.alerts) {
    const p = f.properties;
    state.hist.alerts[f.id] = { t: p.sent || p.effective || new Date().toISOString(), sev: f._sev, event: p.event, areaDesc: p.areaDesc, expires: p.expires };
  }
  saveHist();
}
// notices are alerts, not tickets: resolved (curator-set) suppresses immediately, everything else times out — nothing is immortal
const cardAged = (r) => r.status === 'resolved' || ageMins(r.ts) > (CONFIG.agedCardMinsByType[r.type] || CONFIG.agedCardMins);
const lsrFreshCutoffMins = () => (state.filters.window ? +state.filters.window : CONFIG.agedLsrMins);

/* ---------- assistance requests ---------- */

function loadStore() {
  try { state.store = Object.assign({ added: [], overrides: {}, archived: [] }, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); }
  catch { state.store = { added: [], overrides: {}, archived: [] }; }
}
function saveStore() { localStorage.setItem(LS_KEY, JSON.stringify(state.store)); }

function allRequests(includeArchived = false) {
  const merged = state.seedRequests.concat(state.store.added)
    .map((r) => Object.assign({}, r, state.store.overrides[r.id] || {}));
  return includeArchived ? merged : merged.filter((r) => !state.store.archived.includes(r.id));
}

// aged cards drop out of counts, strip, SITREP, and default views — still in exports and the aged toggle
function activeRequests() { return allRequests().filter((r) => !cardAged(r)); }

function smartScore(r) {
  return (PRI_WEIGHT[r.priority] || 1) * Math.pow(0.5, ageMins(r.ts) / CONFIG.smartHalfLifeMins);
}

function sortRequests(reqs) {
  const agedLast = (a, b) => cardAged(a) - cardAged(b);
  const resolvedLast = (a, b) => (a.status === 'resolved') - (b.status === 'resolved');
  const byTs = (a, b) => new Date(b.ts) - new Date(a.ts);
  return reqs.slice().sort((a, b) => agedLast(a, b) || resolvedLast(a, b) || (
    state.sort === 'newest' ? byTs(a, b)
      : state.sort === 'priority' ? (PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || byTs(a, b))
        : smartScore(b) - smartScore(a)));
}

function requestVisible(r) {
  const f = state.filters;
  if (f.type && r.type !== f.type) return false;
  if (f.county && r.county !== f.county) return false;
  if (f.window && ageMins(r.ts) > +f.window) return false;
  if (f.dist && state.myPos && Number.isFinite(r.lat)
      && distMi(state.myPos.lat, state.myPos.lng, r.lat, r.lon) > +f.dist) return false;
  if (f.q) {
    const hay = `${shortId(r.id)} ${r.summary} ${r.details} ${r.place} ${r.county}`.toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  return true;
}

function updateFiltersBadge() {
  const f = state.filters;
  const n = ['type', 'county', 'q', 'window', 'dist'].filter((k) => f[k]).length
    + (state.sort !== 'smart' ? 1 : 0) + (state.showAged ? 1 : 0);
  $('#filters-toggle').textContent = n ? `☰ Filters (${n})` : '☰ Filters';
  $('#filters-toggle').classList.toggle('on', n > 0 || !$('#req-filters').hidden);
}

// radio-speakable stable reference ("flag R-036"); local intakes hash to 3 base36 chars
function shortId(id) {
  const m = /^seed-0*(\d+)$/.exec(id);
  if (m) return `R-${m[1].padStart(3, '0')}`;
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `R-${(h % 46656).toString(36).toUpperCase().padStart(3, '0')}`;
}

// exact, complete radio-ID ("R-031" / "r031") flies the map to that card's pin and opens it.
// requires the full 3-char code so mid-typing "R-03" doesn't wobble to R-003 first.
function flyToRadioId(raw) {
  const m = /^r-?([0-9a-z]{3})$/i.exec(String(raw || '').trim());
  if (!m) return false;
  const want = `R-${m[1].toUpperCase()}`;
  const hit = allRequests().find((r) => shortId(r.id) === want);
  if (!hit || !Number.isFinite(hit.lat)) return false;
  state.map.setView([hit.lat, hit.lon], 12);
  const mk = state.reqMarkers[hit.id];
  if (mk) mk.openPopup();
  if (window.innerWidth <= 768) $('#map').scrollIntoView({ behavior: 'smooth' });
  return true;
}

function renderRequests() {
  updateFiltersBadge();
  const reqs = sortRequests(allRequests());
  const agedCount = reqs.filter(cardAged).length;
  const agedBtn = $('#flt-aged');
  agedBtn.textContent = `aged ${agedCount}`;
  agedBtn.classList.toggle('on', state.showAged);
  agedBtn.style.display = agedCount ? '' : 'none';
  const visible = reqs.filter((r) => (state.showAged || !cardAged(r)) && requestVisible(r));
  const el = $('#request-list');
  el.innerHTML = '';

  const counties = [...new Set(reqs.map((r) => r.county))].sort();
  const cSel = $('#flt-county');
  const cur = cSel.value;
  cSel.innerHTML = `<option value="">${esc(t('feed.allcounties'))}</option>` + counties.map((c) => `<option${c === cur ? ' selected' : ''}>${esc(c)}</option>`).join('');

  for (const r of visible) {
    const div = document.createElement('div');
    div.className = `card pri-${r.priority}${cardAged(r) ? ' aged' : ''}`;
    const src = r.source || {};
    const srcLink = src.url ? `<a href="${esc(safeUrl(src.url))}" target="_blank" rel="noopener">${esc(src.platform || 'source')}: ${esc(src.handle || src.url)}</a>` : esc(`${src.platform || ''} ${src.handle || ''}`.trim());
    const isNew = state.lastSeen && new Date(r.ts).getTime() > state.lastSeen;
    const needsReverify = r.status !== 'resolved' && ageMins(r.ts) > CONFIG.staleMins;
    const hasPos = Number.isFinite(r.lat) && Number.isFinite(r.lon);
    div.innerHTML =
      `<div class="head"><span>${TYPE_GLYPH[r.type] || '📍'}</span><span class="type-chip">${esc(r.type)} · ${esc(r.priority)}</span>` +
      `<span class="sid" title="Radio reference — tap to copy">${shortId(r.id)}</span>` +
      `<span class="when"><span class="fresh-dot ${freshClass(r.ts)}"></span> ${esc(fmtWhen(r.ts))}</span></div>` +
      `<div class="summary">${esc(r.summary)}</div>` +
      `<div class="meta">📍 ${esc(r.place)} (${esc(r.county)} Co.)${r.contact ? ` · ☎ ${esc(r.contact)}` : ''}` +
      (state.myPos && hasPos ? ` · ${distMi(state.myPos.lat, state.myPos.lng, r.lat, r.lon).toFixed(1)} mi` : '') + '</div>' +
      (r.details ? `<div class="meta" style="margin-top:3px">${esc(r.details)}</div>` : '') +
      `<div class="badges">${isNew ? '<span class="badge new-chip">NEW</span>' : ''}` +
      (r.status !== 'open' ? `<span class="badge status-${esc(r.status)}">${esc(r.status)}</span>` : '') +
      (cardAged(r) ? '<span class="badge aged-chip">aged — suppressed</span>' : (needsReverify ? '<span class="badge reverify">stale — re-verify</span>' : '')) +
      `<span class="badge">${srcLink}</span>` +
      (hasPos ? `<button class="badge act nav-act">navigate</button><button class="badge act copy-act">copy coords</button>` : '') +
      '</div>';
    div.addEventListener('click', (ev) => {
      if (ev.target.closest('a')) return;
      if (ev.target.classList.contains('sid')) {
        copyText(shortId(r.id)).then(() => { ev.target.textContent = 'copied ✓'; setTimeout(() => { ev.target.textContent = shortId(r.id); }, 1200); });
        return;
      }
      if (ev.target.classList.contains('nav-act')) { window.open(`https://maps.google.com/?q=${r.lat},${r.lon}`, '_blank', 'noopener'); return; }
      if (ev.target.classList.contains('copy-act')) {
        copyText(`${r.lat}, ${r.lon} · USNG ${toUSNG(r.lat, r.lon)}`).then(() => { ev.target.textContent = 'copied ✓'; setTimeout(() => { ev.target.textContent = 'copy coords'; }, 1500); });
        return;
      }
      if (hasPos) {
        state.map.setView([r.lat, r.lon], 12);
        const mk = state.reqMarkers[r.id];
        if (mk) mk.openPopup();
        document.querySelectorAll('.card.selected').forEach((c) => c.classList.remove('selected'));
        div.classList.add('selected');
        // phone layout: the map is above the scrolled list — make the pan visible
        if (window.innerWidth <= 768) $('#map').scrollIntoView({ behavior: 'smooth' });
      }
    });
    el.appendChild(div);
  }
  if (!visible.length) el.innerHTML = `<div class="card">${esc(t('feed.empty'))}</div>`;

  state.layers.requests.clearLayers();
  state.reqMarkers = {};
  for (const r of visible) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    const resolved = r.status === 'resolved';
    if (r.type === 'cutoff' && r.radiusMi > 0 && !resolved) {
      state.layers.requests.addLayer(L.circle([r.lat, r.lon], {
        radius: r.radiusMi * 1609.34, className: 'cutoff-circle', weight: 2, fillOpacity: 0.07,
      }).bindPopup(`<div class="popup-title">⛔ CUT-OFF AREA (est.)</div><div>${esc(r.summary)}</div><div class="popup-meta">~${r.radiusMi} mi isolation footprint — operator estimate</div>`));
    }
    const icon = L.divIcon({
      className: '',
      html: `<div class="req-icon pri-${esc(r.priority)}${resolved ? ' resolved' : ''}">${TYPE_GLYPH[r.type] || '📍'}</div>`,
      iconSize: [26, 26], iconAnchor: [4, 26],
    });
    const m = L.marker([r.lat, r.lon], { icon });
    m.bindPopup(`<div class="popup-title">${TYPE_GLYPH[r.type] || ''} ${esc(r.type.toUpperCase())} — ${esc(r.priority)}</div>` +
      `<div>${esc(r.summary)}</div>` +
      `<div class="popup-meta">${shortId(r.id)} · ${esc(r.place)} · ${esc(r.status)} · ${esc(fmtWhen(r.ts))}</div>` +
      `<div class="popup-meta">USNG ${esc(toUSNG(r.lat, r.lon))} · ${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}</div>` +
      (r.source && r.source.url ? `<div class="popup-link"><a href="${esc(r.source.url)}" target="_blank" rel="noopener">source →</a></div>` : ''));
    state.layers.requests.addLayer(m);
    state.reqMarkers[r.id] = m;
  }

  const open = reqs.filter((r) => !cardAged(r) && r.status !== 'resolved');
  $('#requests-count').textContent = open.length;
  renderTiles();
}

// Nominatim forward-geocode — shared by the curator intake form and the address risk-check.
// The address stays on-device: only this one geocode call leaves the browser; nothing is logged.
async function nominatimSearch(q) {
  const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`);
  const hits = await res.json();
  if (!hits.length) return null;
  return { lat: +hits[0].lat, lon: +hits[0].lon, label: hits[0].display_name || '' };
}

async function geocodePlace() {
  const place = $('#f-place').value.trim();
  if (!place) { $('#f-latlon').value = 'enter a place name first'; return; }
  const county = $('#f-county').value.trim();
  const q = `${place}${county ? `, ${county} County` : ''}, Texas`;
  $('#f-latlon').value = 'looking up…';
  try {
    const hit = await nominatimSearch(q);
    if (!hit) { $('#f-latlon').value = 'not found — click the map instead'; return; }
    state.pendingLatLng = L.latLng(hit.lat, hit.lon);
    $('#f-latlon').value = `${hit.lat.toFixed(4)}, ${hit.lon.toFixed(4)} (geocoded — verify)`;
    state.map.setView(state.pendingLatLng, 12);
  } catch { $('#f-latlon').value = 'lookup failed — click the map instead'; }
}

function submitRequest(ev) {
  ev.preventDefault();
  const ll = state.pendingLatLng;
  const r = {
    id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    ts: new Date().toISOString(),
    type: $('#f-type').value,
    priority: $('#f-priority').value,
    status: 'open',
    county: $('#f-county').value.trim() || 'Unknown',
    place: $('#f-place').value.trim(),
    lat: ll ? +ll.lat.toFixed(5) : NaN,
    lon: ll ? +ll.lng.toFixed(5) : NaN,
    radiusMi: parseFloat($('#f-radius').value) || null,
    summary: $('#f-summary').value.trim(),
    details: $('#f-details').value.trim(),
    source: { platform: $('#f-source').value, handle: $('#f-handle').value.trim(), url: $('#f-url').value.trim() },
    contact: $('#f-contact').value.trim(),
  };
  if (!r.summary || !r.place) { alert('Summary and place are required.'); return; }
  if (Number.isFinite(r.lat)) {
    const dup = allRequests().find((x) => x.status !== 'resolved' && x.type === r.type
      && Number.isFinite(x.lat) && distMi(x.lat, x.lon, r.lat, r.lon) < 3);
    if (dup) {
      const dist = distMi(dup.lat, dup.lon, r.lat, r.lon).toFixed(1);
      if (!confirm(`Possible duplicate — same type ${dist} mi away (${dup.status}):\n"${dup.summary.slice(0, 100)}"\n\nAdd anyway?`)) return;
    }
  }
  state.store.added.push(r);
  saveStore();
  ev.target.reset();
  state.pendingLatLng = null;
  $('#new-request-form').classList.remove('open');
  renderRequests();
}

/* ---------- "Am I at risk?" address check + saved my-places (client-only, no PII) ---------- */

const PLACES_KEY = 'respondertx.places';
const RISK_GAUGE_MI = 15; // nearest-gauge search radius
const RISK_NEAR_MI = 6;   // "within a few mi" for road/cutoff notices
const SEV_ORDER = ['emergency', 'warning', 'watch', 'advisory'];

function loadPlaces() {
  try { return JSON.parse(localStorage.getItem(PLACES_KEY)) || []; } catch { return []; }
}
function savePlaces(arr) {
  try { localStorage.setItem(PLACES_KEY, JSON.stringify(arr.slice(0, 12))); } catch { /* quota — saved places are best-effort */ }
}
function addPlace(p) {
  const arr = loadPlaces().filter((x) => distMi(x.lat, x.lon, p.lat, p.lon) > 0.2);
  arr.unshift(p);
  savePlaces(arr);
  renderSavedPlaces();
}
function removePlace(idx) {
  const arr = loadPlaces();
  arr.splice(idx, 1);
  savePlaces(arr);
  renderSavedPlaces();
}
function renderSavedPlaces() {
  const el = $('#risk-saved');
  const arr = loadPlaces();
  if (!arr.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="rs-title">${esc(t('risk.saved.title'))}</div>` +
    arr.map((p, i) => `<span class="rs-chip"><button class="rs-go" data-i="${i}">🏠 ${esc(p.label)}</button><button class="rs-x" data-i="${i}" title="${esc(t('risk.saved.remove'))}" aria-label="${esc(t('risk.saved.removearia'))}">✕</button></span>`).join('');
  el.querySelectorAll('.rs-go').forEach((b) => b.addEventListener('click', () => {
    const p = loadPlaces()[+b.dataset.i];
    if (p) { $('#risk-addr').value = p.label; runRiskCheck(p.lat, p.lon, p.label); }
  }));
  el.querySelectorAll('.rs-x').forEach((b) => b.addEventListener('click', () => removePlace(+b.dataset.i)));
}

function openRiskCheck() {
  $('#risk-modal').hidden = false;
  renderSavedPlaces();
  const inp = $('#risk-addr');
  inp.focus();
  inp.select();
}

function placeLabel(typed, hit) {
  const t = typed.trim();
  if (t.length <= 42) return t;
  return (hit.label || t).split(',').slice(0, 2).join(',').trim();
}

async function runRiskFromInput() {
  const raw = $('#risk-addr').value.trim();
  if (!raw) return;
  const out = $('#risk-result');
  out.innerHTML = `<div class="risk-card"><div class="risk-quiet">${esc(t('risk.looking'))}</div></div>`;
  // bias to the board's AO when no state is named; the query is never stored or transmitted beyond this geocode
  const q = /\b(tx|texas)\b/i.test(raw) ? raw : `${raw}, Texas`;
  try {
    const hit = await nominatimSearch(q);
    if (!hit) { out.innerHTML = `<div class="risk-card"><div class="risk-quiet">${esc(t('risk.notfound'))}</div></div>`; return; }
    runRiskCheck(hit.lat, hit.lon, placeLabel(raw, hit));
  } catch { out.innerHTML = `<div class="risk-card"><div class="risk-quiet">${esc(t('risk.lookupfail'))}</div></div>`; }
}

function dropRiskPin(lat, lon, label) {
  if (state.riskMarker) state.map.removeLayer(state.riskMarker);
  state.riskMarker = L.marker([lat, lon], {
    icon: L.divIcon({ className: '', html: `<div class="risk-pin"><div class="risk-pin-dot"></div><div class="risk-pin-label">${esc(t('risk.pinlabel'))}</div></div>`, iconSize: [40, 46], iconAnchor: [20, 40] }),
    title: label || t('risk.pintitle'), zIndexOffset: 2100,
  }).addTo(state.map);
  state.map.setView([lat, lon], 12);
}

function nearestGauges(lat, lon, maxMi, n) {
  return state.gauges
    .filter((g) => Number.isFinite(g.latitude) && Number.isFinite(g.longitude))
    .map((g) => ({ g, dist: distMi(lat, lon, g.latitude, g.longitude) }))
    .filter((x) => x.dist <= maxMi)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, n);
}
function nearestCrossing(lat, lon, maxMi) {
  return (state.crossings || [])
    .filter((c) => c.status !== 'open' && Number.isFinite(c.lat) && Number.isFinite(c.lon))
    .map((c) => ({ c, dist: distMi(lat, lon, c.lat, c.lon) }))
    .filter((x) => x.dist <= maxMi)
    .sort((a, b) => a.dist - b.dist)[0] || null;
}
function nearestNotice(lat, lon, maxMi) {
  return activeRequests()
    .filter((r) => r.status !== 'resolved' && (r.type === 'cutoff' || r.type === 'road')
      && Number.isFinite(r.lat) && Number.isFinite(r.lon))
    .map((r) => ({ r, dist: distMi(lat, lon, r.lat, r.lon) }))
    .filter((x) => x.dist <= maxMi)
    .sort((a, b) => a.dist - b.dist)[0] || null;
}
// point-in-bbox (with small pad) against the alert polygon/zone bounds — "contains or is near"
function alertNearPoint(f, lat, lon) {
  const geom = f.geometry || (f.properties.affectedZones || []).map((z) => state.zoneGeomCache.get(z)).find(Boolean);
  if (!geom) return false;
  try {
    const gb = L.geoJSON(geom).getBounds();
    const pad = 0.05;
    return lat >= gb.getSouth() - pad && lat <= gb.getNorth() + pad
      && lon >= gb.getWest() - pad && lon <= gb.getEast() + pad;
  } catch { return false; }
}

function riskGaugeLine(x) {
  const { g, dist } = x;
  const stale = gaugeObsStale(g);
  const cat = gaugeObsCat(g);
  const fCat = gaugeForecastCat(g);
  const f = g.status.forecast;
  const o = g.status.observed;
  const tr = stale ? null : gaugeTrend(g.lid);
  const trendBit = tr ? ` · ${tr.dir === 'up' ? '↑ rising' : tr.dir === 'down' ? '↓ falling' : '→ steady'} ${tr.rate >= 0 ? '+' : ''}${tr.rate.toFixed(1)} ft/hr` : '';
  const fcst = fCat
    ? `<div class="rg-fcst">${gaugeRising(g) ? '▲ ' : ''}Forecast crest ${fmtNum(f.primary)} ${esc(f.primaryUnit)} — <span style="color:var(--cat-${fCat})">${esc(catLabel(fCat))}</span> · ${esc(fmtWhen(f.validTime))}</div>`
    : '';
  return `<button class="risk-gauge" data-lid="${esc(g.lid)}">` +
    `<div class="rg-top"><span class="rg-name">${esc(g.name)}</span><span class="rg-dist">${dist.toFixed(1)} ${esc(t('risk.mi'))}</span></div>` +
    `<div class="rg-now">${esc(t('risk.now'))} ${fmtNum(o.primary)} ${esc(o.primaryUnit)} · <span style="color:var(--cat-${stale ? 'none' : cat})">${esc(catLabel(cat))}</span>${trendBit}</div>` +
    (stale ? `<div class="rg-now stale-note">⏱ STALE — no current data (last obs ${esc(fmtWhen(o.validTime))})</div>` : '') +
    fcst + '</button>';
}

// one derived line — never invents; each clause restates data already shown above.
// connectives localize; embedded feed data (event names, rivers) stays English.
function riskOverallRead(nearAlerts, gauges, xCross, nNotice) {
  const mi = t('risk.mi');
  const parts = [];
  if (nearAlerts.length) {
    const worst = nearAlerts.slice().sort((a, b) => SEV_ORDER.indexOf(a._sev) - SEV_ORDER.indexOf(b._sev))[0];
    parts.push(`${worst.properties.event}${worst._sev === 'emergency' ? ` — ${t('risk.read.emerg')}` : ''} ${t('risk.read.covers')}`);
  }
  if (gauges.length) {
    const { g, dist } = gauges[0];
    const nearStale = gaugeObsStale(g);
    let s = `${t('risk.read.nearest')} ${riverOf(g.name)} (${dist.toFixed(1)} ${mi}) ${t('risk.read.is')} ${catLabel(gaugeObsCat(g))}${nearStale ? ` (stale — last obs ${fmtWhen(g.status.observed.validTime).split(' · ')[0]})` : ''}`;
    if (gaugeRising(g)) s += ` ${t('risk.read.forecast')} ${catLabel(gaugeForecastCat(g))} ${fmtWhen(g.status.forecast.validTime)}`;
    parts.push(s);
  } else {
    parts.push(`${t('risk.read.nogauge')} ${RISK_GAUGE_MI} ${mi}`);
  }
  if (xCross) parts.push(`${t('risk.read.crosspre')} ${t('xword.' + xCross.c.status)} ${t('risk.read.crosspost')} ${xCross.dist.toFixed(1)} ${mi}`);
  if (nNotice) parts.push(`${t('risk.read.noticepre')} ${t('ntype.' + nNotice.r.type)} ${t('risk.read.noticepost')} ${nNotice.dist.toFixed(1)} ${mi}`);
  const line = parts.join('; ');
  return line.charAt(0).toUpperCase() + line.slice(1) + '.';
}

function runRiskCheck(lat, lon, label) {
  dropRiskPin(lat, lon, label);
  const gauges = nearestGauges(lat, lon, RISK_GAUGE_MI, 3);
  const nearAlerts = state.alerts.filter((f) => alertNearPoint(f, lat, lon));
  const xCross = nearestCrossing(lat, lon, 12);
  const nNotice = nearestNotice(lat, lon, RISK_NEAR_MI);
  const read = riskOverallRead(nearAlerts, gauges, xCross, nNotice);

  const mi = t('risk.mi');
  let html = '<div class="risk-card">';
  html += `<div class="risk-place"><span class="rp-pin">🏠</span><span class="rp-label">${esc(label)}</span>` +
    `<button class="rp-save" title="${esc(t('risk.save.title'))}">${esc(t('risk.save'))}</button></div>`;
  html += `<div class="risk-read">${esc(read)}</div>`;

  if (nearAlerts.length) {
    html += `<div class="risk-sec"><div class="risk-sec-t">${esc(nearAlerts.length > 1 ? t('risk.sec.alertsN') : t('risk.sec.alerts1'))}</div>`;
    for (const f of nearAlerts.slice(0, 3)) {
      html += `<div class="risk-alert sev-${f._sev}"><strong>${esc(f.properties.event)}</strong>` +
        `<div class="ra-area">${esc(f.properties.areaDesc || '')}</div>` +
        `<div class="ra-meta">${esc(t('risk.until'))} ${esc(fmtWhen(f.properties.expires))}</div></div>`;
    }
    html += '</div>';
  } else {
    html += `<div class="risk-sec"><div class="risk-quiet">${t('risk.noalert')}</div></div>`;
  }

  html += `<div class="risk-sec"><div class="risk-sec-t">${esc(t('risk.sec.gauges'))} ${RISK_GAUGE_MI} ${esc(mi)}</div>`;
  if (gauges.length) html += gauges.map(riskGaugeLine).join('');
  else html += `<div class="risk-quiet">${esc(t('risk.read.nogauge'))} ${RISK_GAUGE_MI} ${esc(mi)} — ${t('risk.nogauge')}</div>`;
  html += '</div>';

  html += `<div class="risk-sec"><div class="risk-sec-t">${t('risk.sec.roads')}</div>`;
  if (xCross) {
    const st = CROSSING_STATUS[xCross.c.status];
    html += `<div class="risk-road"><span style="color:${st.color}">${st.glyph} ${st.label}</span> — ${esc(xCross.c.name)} <span class="rr-dist">${xCross.dist.toFixed(1)} ${esc(mi)}</span></div>`;
  }
  if (nNotice) {
    html += `<div class="risk-road"><span>${TYPE_GLYPH[nNotice.r.type] || '🚧'} ${esc(nNotice.r.type)}</span> — ${esc(nNotice.r.summary.slice(0, 90))} <span class="rr-dist">${nNotice.dist.toFixed(1)} ${esc(mi)}</span></div>`;
  }
  if (!xCross && !nNotice) html += `<div class="risk-quiet">${esc(t('risk.noroad'))}</div>`;
  html += `<div class="risk-tip">${esc(t('risk.tip'))}</div>`;
  html += '</div>';

  html += '</div>';
  const out = $('#risk-result');
  out.innerHTML = html;
  out.querySelectorAll('.risk-gauge').forEach((b) => b.addEventListener('click', () => {
    const g = state.gauges.find((x) => x.lid === b.dataset.lid);
    if (g) { $('#risk-modal').hidden = true; focusGauge(g); }
  }));
  const saveBtn = out.querySelector('.rp-save');
  saveBtn.addEventListener('click', () => {
    addPlace({ label, lat: +lat.toFixed(5), lon: +lon.toFixed(5) });
    saveBtn.textContent = '★ Saved';
    saveBtn.disabled = true;
  });
}

function downloadBlob(text, mime, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');

function exportRequests() {
  downloadBlob(JSON.stringify({ exported: new Date().toISOString(), requests: allRequests(true) }, null, 2),
    'application/json', `responder-requests-${stamp()}.json`);
}

function exportGeoJSON() {
  const features = allRequests(true).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon)).map((r) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
    properties: {
      title: `${r.type.toUpperCase()} · ${r.priority} · ${r.status}`,
      description: `${r.summary}\n${r.place} (${r.county} Co.)\n${r.ts}${r.source && r.source.url ? '\n' + r.source.url : ''}`,
      type: r.type, priority: r.priority, status: r.status, ts: r.ts, id: r.id,
    },
  }));
  downloadBlob(JSON.stringify({ type: 'FeatureCollection', features }, null, 2),
    'application/geo+json', `responder-requests-${stamp()}.geojson`);
}

function importRequests(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const incoming = data.requests || [];
      const known = new Set(allRequests(true).map((r) => r.id));
      let added = 0, updated = 0;
      for (const r of incoming) {
        if (!r.id || !r.summary) continue;
        if (known.has(r.id)) {
          const cur = allRequests().find((x) => x.id === r.id);
          if (new Date(r.ts) >= new Date(cur.ts) && r.status !== cur.status) {
            state.store.overrides[r.id] = Object.assign({}, state.store.overrides[r.id], { status: r.status });
            updated++;
          }
        } else { state.store.added.push(r); added++; }
      }
      saveStore();
      renderRequests();
      alert(`Import: ${added} new, ${updated} status updates.`);
    } catch (e) { alert(`Import failed: ${e.message}`); }
  };
  reader.readAsText(file);
}

/* ---------- SITREP ---------- */

function buildSitrep() {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const emerg = state.alerts.filter((a) => a._sev === 'emergency');
  const warnings = state.alerts.filter((a) => a._sev === 'warning').length;
  const majors = state.gauges.filter((g) => gaugeCat(g) === 'major');
  const toMajor = state.gauges.filter((g) => gaugeRising(g) && gaugeForecastCat(g) === 'major');
  const reqs = activeRequests().filter((r) => r.status !== 'resolved');
  const crit = sortRequests(reqs.filter((r) => r.priority === 'critical'));
  const cutoffs = reqs.filter((r) => r.type === 'cutoff');
  const L = [];
  L.push(`RESPONDER TX SITREP — ${now} CT`);
  L.push(`THREAT: ${emerg.length} flash flood emergencies${emerg.length ? ` (${emerg.map((a) => a.properties.areaDesc).join(' | ')})` : ''}; ${warnings} flood warnings statewide`);
  L.push(`GAUGES: ${majors.length} at MAJOR, ${toMajor.length} forecast to reach major`);
  for (const g of majors) {
    const tr = gaugeTrend(g.lid);
    L.push(`  MAJOR ${g.name} — ${g.status.observed.primary} ft${tr ? ` (${tr.rate >= 0 ? '+' : ''}${tr.rate.toFixed(1)} ft/hr)` : ''}`);
  }
  for (const g of toMajor) {
    const rc = recordContext(g);
    const recBit = rc ? (rc.atOrAbove ? ` [⚑ ${Math.abs(rc.margin)} ft OVER ${rc.recFt} ft record ${rc.year}]` : rc.near ? ` [⚑ ${rc.margin} ft below ${rc.recFt} ft record ${rc.year}]` : '') : '';
    L.push(`  RISING ${g.name} — fcst crest ${g.status.forecast.primary} ft ${fmtWhen(g.status.forecast.validTime)}${recBit}`);
  }
  const falling = state.gauges.filter((g) => gaugeCat(g) !== 'none' && (gaugeTrend(g.lid) || {}).dir === 'down');
  if (falling.length) L.push(`RECOVERY: ${falling.length} in-flood gauges falling (${falling.map((g) => riverOf(g.name)).slice(0, 6).join('; ')})`);
  if (cutoffs.length) L.push(`CUT-OFF AREAS: ${cutoffs.map((r) => `${r.place} (${r.county} Co.)`).join('; ')}`);
  L.push(`ACTIVE CRITICAL (${crit.length}):`);
  for (const r of crit.slice(0, 10)) {
    const pos = Number.isFinite(r.lat) ? ` [USNG ${toUSNG(r.lat, r.lon)}]` : '';
    L.push(`  [${shortId(r.id)}] [${r.type.toUpperCase()}] ${r.summary} — ${r.place}, ${r.county} Co.${pos} (${fmtWhen(r.ts).split(' · ')[0]})`);
  }
  L.push(`ACTIVE NOTICES TOTAL: ${reqs.length} · board ${APP_VERSION}`);
  L.push('Not a dispatch product. Life-threatening emergencies: 911.');
  return L.join('\n');
}

function copySitrep(btn) {
  const text = buildSitrep();
  const copy = () => copyText(text).then(
    () => { btn.textContent = 'SITREP copied ✓'; setTimeout(() => { btn.textContent = '📋 SITREP'; }, 2000); },
    () => downloadBlob(text, 'text/plain', `sitrep-${stamp()}.txt`));
  if (navigator.share) navigator.share({ title: 'Responder TX SITREP', text }).catch(copy);
  else copy();
}

/* ---------- share view — one link reproduces map, tab, and filters ---------- */

function buildShareUrl() {
  const p = new URLSearchParams();
  const c = state.map.getCenter();
  p.set('mlat', c.lat.toFixed(4));
  p.set('mlon', c.lng.toFixed(4));
  p.set('mz', String(state.map.getZoom()));
  const active = document.querySelector('.tabs button.active');
  const tab = active ? active.dataset.tab.replace(/^tab-/, '') : 'requests';
  if (tab !== 'requests') p.set('tab', tab);
  const f = state.filters;
  if (f.type) p.set('ft', f.type);
  if (f.county) p.set('fc', f.county);
  if (f.window) p.set('fw', f.window);
  if (f.dist) p.set('fd', f.dist);
  if (f.q) p.set('fq', f.q);
  if (state.sort !== 'smart') p.set('fs', state.sort);
  if ($('#flt-alert-sev').value) p.set('as', $('#flt-alert-sev').value);
  if ($('#flt-alert-q').value) p.set('aq', $('#flt-alert-q').value);
  p.set('base', state.activeBase);
  p.set('theme', document.documentElement.getAttribute('data-theme'));
  return `${location.origin}${location.pathname}?${p}`;
}

function shareView(btn) {
  const url = buildShareUrl();
  const copy = () => copyText(url).then(
    () => { btn.textContent = '✓ Link copied'; setTimeout(() => { btn.textContent = '🔗 Share'; }, 2000); },
    () => prompt('Copy this link:', url));
  if (navigator.share) navigator.share({ url }).catch(copy);
  else copy();
}

// boot-time restore: set each control the way a user would, then let its own handler re-render
function applyShareParams(q) {
  const lat = parseFloat(q.get('mlat')), lon = parseFloat(q.get('mlon')), z = parseInt(q.get('mz'), 10);
  if (Number.isFinite(lat) && Number.isFinite(lon)) state.map.setView([lat, lon], Number.isFinite(z) ? z : state.map.getZoom());
  const apply = (sel, key, evt) => {
    const val = q.get(key);
    if (val === null || val === '') return false;
    const el = $(sel);
    // county options arrive with board data — park the shared value until renderRequests rebuilds the list
    if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === val)) el.add(new Option(val, val));
    el.value = val;
    el.dispatchEvent(new Event(evt));
    return true;
  };
  const feedFiltered = [['#flt-type', 'ft', 'change'], ['#flt-county', 'fc', 'change'], ['#flt-window', 'fw', 'change'],
    ['#flt-dist', 'fd', 'change'], ['#flt-q', 'fq', 'input'], ['#flt-sort', 'fs', 'change']]
    .map(([sel, key, evt]) => apply(sel, key, evt)).some(Boolean);
  if (feedFiltered) $('#req-filters').hidden = false; // a shared filtered view must be visible, not silent
  apply('#flt-alert-sev', 'as', 'change');
  apply('#flt-alert-q', 'aq', 'input');
}

// mobile bottom-sheet: the sidebar (feed/alerts/threat) slides between peek (map-full),
// half (default split), and full (covers the map for full scroll). Handle taps cycle states.
const SHEET_STATES = ['sheet-peek', 'sheet-half', 'sheet-full'];
function setSheet(stateCls) {
  const main = document.querySelector('main');
  main.classList.remove(...SHEET_STATES);
  main.classList.add(stateCls);
  localStorage.setItem('respondertx.sheet', stateCls);
  document.querySelectorAll('#sheet-handle button').forEach((b) => b.classList.toggle('on', b.dataset.sheet === stateCls));
  if (state.map) setTimeout(() => state.map.invalidateSize(), 260); // re-tile after the height transition
}
function initSheet() {
  const param = new URLSearchParams(location.search).get('sheet'); // ?sheet=peek|half|full deep link
  const wanted = param ? `sheet-${param}` : localStorage.getItem('respondertx.sheet');
  setSheet(SHEET_STATES.includes(wanted) ? wanted : 'sheet-half');
  document.querySelectorAll('#sheet-handle button').forEach((b) =>
    b.addEventListener('click', () => setSheet(b.dataset.sheet)));
}

// persist the user's view (feed + alert filters, sort, aged toggle, active tab) across
// hard refreshes and app updates. URL share-params still win for their load (applied after).
const VIEW_KEY = 'respondertx.view';
function saveViewState() {
  try {
    const active = document.querySelector('.tabs button.active');
    localStorage.setItem(VIEW_KEY, JSON.stringify({
      ft: state.filters.type || '', fc: state.filters.county || '', fq: state.filters.q || '',
      fw: state.filters.window || '', fd: state.filters.dist || '', fs: state.sort,
      aged: state.showAged ? 1 : 0,
      as: $('#flt-alert-sev').value, aq: $('#flt-alert-q').value,
      tab: active ? active.dataset.tab : 'tab-requests',
    }));
  } catch { /* private-mode / quota — view persistence is best-effort */ }
}
function restoreViewState() {
  let v; try { v = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null'); } catch { v = null; }
  if (!v) return;
  state.filters.type = v.ft || ''; $('#flt-type').value = v.ft || '';
  state.filters.window = v.fw || ''; $('#flt-window').value = v.fw || '';
  state.filters.dist = v.fd || ''; $('#flt-dist').value = v.fd || '';
  state.filters.q = v.fq || ''; $('#flt-q').value = v.fq || '';
  state.sort = v.fs || 'smart'; $('#flt-sort').value = state.sort;
  state.showAged = !!v.aged;
  if (v.fc) { // county options arrive with board data — park the value so the select shows it
    const sel = $('#flt-county');
    if (![...sel.options].some((o) => o.value === v.fc)) sel.add(new Option(v.fc, v.fc));
    sel.value = v.fc; state.filters.county = v.fc;
  }
  $('#flt-alert-sev').value = v.as || '';
  $('#flt-alert-q').value = v.aq || '';
  if (v.ft || v.fc || v.fq || v.fw || v.fd || (v.fs && v.fs !== 'smart') || v.aged) $('#req-filters').hidden = false;
  if (v.tab && v.tab !== 'tab-requests' && /^[a-z-]+$/.test(v.tab)) {
    const btn = document.querySelector(`.tabs button[data-tab="${v.tab}"]`);
    if (btn) btn.click();
  }
}

function exportAAR() {
  const reqs = allRequests(true).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const count = (fn) => reqs.reduce((m, r) => { const k = fn(r); m[k] = (m[k] || 0) + 1; return m; }, {});
  const fmtCounts = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');
  const L = [];
  L.push(`# Responder TX — After-Action Export`);
  L.push(`Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT · board ${APP_VERSION}`);
  L.push('');
  L.push(`## Card statistics (${reqs.length} total)`);
  L.push(`- By status: ${fmtCounts(count((r) => r.status))}`);
  L.push(`- By type: ${fmtCounts(count((r) => r.type))}`);
  L.push(`- By county: ${fmtCounts(count((r) => r.county))}`);
  L.push('');
  L.push('## Chronological card log');
  for (const r of reqs) {
    const t = new Date(r.ts).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    L.push(`- **${t} CT** [${r.type}/${r.priority}/${r.status}] ${r.summary} — ${r.place} (${r.county} Co.)${r.source && r.source.url ? ` [src](${r.source.url})` : ''}`);
  }
  L.push('');
  L.push('## Situation snapshot at export');
  L.push('```');
  L.push(buildSitrep());
  L.push('```');
  downloadBlob(L.join('\n'), 'text/markdown', `responder-aar-${stamp()}.md`);
}

/* ---------- resources & monitors ---------- */

function renderResources() {
  const r = state.resources;
  if (!r) return;
  const el = $('#resources-body');
  el.innerHTML = `<div class="section-title">${esc(t('res.shelters'))}</div>` +
    r.shelters.map((s) => `<div class="resource-item"><strong>${esc(s.name)}</strong><div class="addr">${esc(s.address)} · ${esc(s.county)} Co. — ${esc(s.note)} <a href="${esc(safeUrl(s.source))}" target="_blank" rel="noopener">src</a></div></div>`).join('') +
    `<div class="section-title">${esc(t('res.hotlines'))}</div>` +
    r.hotlines.map((h) => `<div class="resource-item"><strong>${esc(h.value)}</strong> — ${esc(h.name)}<div class="addr">${esc(h.note)}</div></div>`).join('') +
    `<div class="section-title">${esc(t('res.data'))}</div>` +
    r.dataLinks.map((d) => `<div class="resource-item"><a href="${esc(safeUrl(d.url))}" target="_blank" rel="noopener">${esc(d.label)}</a></div>`).join('') +
    `<div class="section-title">${esc(t('res.follow'))}</div>` +
    `<div class="resource-item"><a href="feed.xml" target="_blank" rel="noopener">${esc(t('res.rss'))}</a> — ${esc(t('res.rss.note'))}</div>` +
    `<div class="resource-item"><a href="crests.ics" target="_blank" rel="noopener">${esc(t('res.ics'))}</a> — ${esc(t('res.ics.note'))}</div>`;

  state.layers.shelters.clearLayers();
  for (const s of r.shelters) {
    const icon = L.divIcon({ className: '', html: '<div class="shelter-icon">🏠</div>', iconSize: [24, 24] });
    const m = L.marker([s.lat, s.lon], { icon });
    m.bindPopup(`<div class="popup-title">🏠 ${esc(s.name)}</div><div class="popup-meta">${esc(s.address)}</div><div>${esc(s.note)}</div><div class="popup-meta">Location approximate — confirm before routing.</div>`);
    state.layers.shelters.addLayer(m);
  }
}

function monitorGroupHtml(g) {
  return `<div class="monitor-group"><div class="section-title">${esc(g.group)}</div>` +
    (g.note ? `<div class="resource-item" style="border-bottom:none;font-size:12px;color:var(--ink-2)">${esc(g.note)}</div>` : '') +
    g.links.map((l) => `<a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">↗ ${esc(l.label)}</a>`).join('') + '</div>';
}

function renderMonitors() {
  const el = $('#monitor-body');
  el.innerHTML = `<div class="section-title">${esc(t('mon.social'))}</div>` +
    state.resources.monitors.map(monitorGroupHtml).join('') +
    `<div class="section-title">${esc(t('mon.comms'))}</div>` +
    (state.resources.comms || []).map(monitorGroupHtml).join('') +
    `<div class="section-title">${esc(t('mon.workflow.head'))}</div>` +
    '<div class="resource-item">1. Sweep each search every 15–30 min. 2. For actionable posts, tap “＋ New notice”, click the map to drop the pin, paste the post URL as source. 3. Verify (cross-reference official channels or call back) before tasking. 4. Anything life-threatening → relay to 911/EOC immediately; this board does not dispatch.</div>';
}

/* ---------- threat-to-life strip ---------- */

function fitTo(latlngs) {
  if (latlngs.length) state.map.fitBounds(L.latLngBounds(latlngs).pad(0.25), { maxZoom: 10 });
}

function renderThreatStrip() {
  const el = $('#threat-strip');
  const reqs = activeRequests().filter((r) => r.status !== 'resolved');
  const emergencies = state.alerts.filter((a) => a._sev === 'emergency').length;
  const lifeReqs = reqs.filter((r) => r.priority === 'critical' && LIFE_SAFETY_TYPES.includes(r.type) && r.type !== 'cutoff');
  const cutoffs = reqs.filter((r) => r.type === 'cutoff');
  const roads = reqs.filter((r) => r.type === 'road');
  const majors = state.gauges.filter((g) => gaugeCat(g) === 'major');
  const toMajor = state.gauges.filter((g) => gaugeRising(g) && gaugeForecastCat(g) === 'major');
  const chips = [
    { n: emergencies, cls: 'emergency', label: t('threat.ffemerg'), glyph: '⚠', act: () => document.querySelector('.tabs button[data-tab="tab-alerts"]').click() },
    { n: lifeReqs.length, cls: 'emergency', label: t('threat.life'), glyph: '🆘', act: () => fitTo(lifeReqs.filter((r) => Number.isFinite(r.lat)).map((r) => [r.lat, r.lon])) },
    { n: cutoffs.length, cls: 'emergency', label: t('threat.cutoff'), glyph: '⛔', act: () => fitTo(cutoffs.filter((r) => Number.isFinite(r.lat)).map((r) => [r.lat, r.lon])) },
    { n: majors.length, cls: 'major', label: t('threat.major'), glyph: '●', act: () => fitTo(majors.map((g) => [g.latitude, g.longitude])) },
    { n: toMajor.length, cls: 'major', label: t('threat.tomajor'), glyph: '▲', act: () => fitTo(toMajor.map((g) => [g.latitude, g.longitude])) },
    (() => { const rw = recordWatchGauges(); return { n: rw.length, cls: rw.some((g) => recordContext(g).atOrAbove) ? 'emergency' : 'major', label: t('threat.record'), glyph: '⚑', act: () => { fitTo(rw.map((g) => [g.latitude, g.longitude])); document.querySelector('.tabs button[data-tab="tab-gauges"]').click(); } }; })(),
    { n: roads.length, cls: 'warn', label: t('threat.roads'), glyph: '🚧', act: () => fitTo(roads.filter((r) => Number.isFinite(r.lat)).map((r) => [r.lat, r.lon])) },
    {
      n: state.gauges.filter((g) => gaugeCat(g) !== 'none' && (gaugeTrend(g.lid) || {}).dir === 'down').length,
      cls: 'good', label: t('threat.falling'), glyph: '▼',
      act: () => fitTo(state.gauges.filter((g) => gaugeCat(g) !== 'none' && (gaugeTrend(g.lid) || {}).dir === 'down').map((g) => [g.latitude, g.longitude])),
    },
  ].filter((c) => c.n > 0);
  if (!chips.length) {
    el.innerHTML = state.alertsLoadedOnce
      ? `<div class="strip-ok"><span class="ok-line">${esc(t('threat.okline'))}</span><span class="ok-sub">${esc(t('threat.oksub'))}</span></div>`
      : '';
    return;
  }
  el.innerHTML = '';
  if (chips.some((c) => c.cls === 'emergency')) {
    const h = document.createElement('div');
    h.className = 'threat-head';
    h.textContent = t('threat.headline');
    el.appendChild(h);
  }
  const grid = document.createElement('div');
  grid.className = 'threat-grid';
  for (const c of chips) {
    const b = document.createElement('button');
    b.className = `stat-row ${c.cls}`;
    b.innerHTML = `<span class="glyph">${c.glyph}</span><span class="num">${c.n}</span><span class="lbl">${esc(c.label)}</span>`;
    b.addEventListener('click', c.act);
    grid.appendChild(b);
  }
  // the board knows crest timing and emergency clocks — surface them at glance level
  const soonest = state.gauges
    .filter((g) => gaugeRising(g) && CAT_RANK[gaugeForecastCat(g)] >= CAT_RANK.minor
      && new Date(g.status.forecast.validTime) > new Date()) // a crest already past is not "next"
    .sort((a, b) => new Date(a.status.forecast.validTime) - new Date(b.status.forecast.validTime))[0];
  if (soonest) {
    const b = document.createElement('button');
    b.className = 'stat-row major crest';
    const river = riverOf(soonest.name);
    b.innerHTML = `<span class="glyph">⏱</span><span class="num">${esc(fmtWhen(soonest.status.forecast.validTime).split(' · ')[0])}</span><span class="lbl">${esc(t('threat.nextcrest'))}</span><span class="riv">· ${esc(river.slice(0, 22))}</span>`;
    b.addEventListener('click', () => state.map.setView([soonest.latitude, soonest.longitude], 11));
    grid.appendChild(b);
  }
  el.appendChild(grid);
  const emergAlerts = state.alerts.filter((a) => a._sev === 'emergency');
  if (emergAlerts.length) {
    const row = document.createElement('div');
    row.className = 'ffe-row';
    const tag = document.createElement('span');
    tag.className = 'ffe-tag';
    tag.textContent = t('threat.ffemergtag');
    row.appendChild(tag);
    const goAlerts = () => document.querySelector('.tabs button[data-tab="tab-alerts"]').click();
    for (const a of emergAlerts) {
      const where = (a.properties.areaDesc || '?').split(';')[0].replace(/, TX$/, '');
      const until = new Date(a.properties.expires).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
      const b = document.createElement('button');
      b.className = 'ffe-chip';
      b.title = 'Open Alerts tab';
      b.innerHTML = `${esc(where)} <span class="until">→ ${esc(until)}</span>`;
      b.addEventListener('click', goAlerts);
      row.appendChild(b);
    }
    el.appendChild(row);
  }
}

/* ---------- actionable ticker — recency-biased glance line ---------- */

const relWhen = (iso) => fmtWhen(iso).split(' · ')[0];

// aging invariant: only active alerts, rising/in-flood gauges, fresh LSRs, and non-aged critical notices qualify
function tickerItems() {
  const emerg = [], rise = [], majors = [];
  const goAlerts = () => document.querySelector('.tabs button[data-tab="tab-alerts"]').click();
  for (const a of state.alerts.filter((x) => x._sev === 'emergency' && new Date(x.properties.expires) > new Date())) {
    const where = (a.properties.areaDesc || '?').split(';')[0].replace(/, TX$/, '');
    const until = new Date(a.properties.expires).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
    emerg.push({ text: `⚠ FF EMERGENCY ${where} — until ${until}`, color: 'var(--sev-emergency)', act: goAlerts });
  }
  const rising = state.gauges.filter((g) => gaugeRising(g) && CAT_RANK[gaugeForecastCat(g)] >= CAT_RANK.minor)
    .sort((a, b) => new Date(a.status.forecast.validTime) - new Date(b.status.forecast.validTime));
  for (const g of rising) {
    const fCat = gaugeForecastCat(g);
    rise.push({ text: `▲ ${riverOf(g.name)} → ${fCat.toUpperCase()} crest ${relWhen(g.status.forecast.validTime)}`, color: `var(--cat-${fCat})`, act: () => focusGauge(g) });
  }
  for (const g of state.gauges.filter((x) => gaugeCat(x) === 'major' && !gaugeRising(x))) {
    const tr = gaugeTrend(g.lid);
    const trendBit = tr ? ` ${tr.rate >= 0 ? '+' : ''}${tr.rate.toFixed(1)} ft/hr` : '';
    majors.push({ text: `● ${riverOf(g.name)} MAJOR ${fmtNum(g.status.observed.primary)} ft${trendBit}`, color: 'var(--cat-major)', act: () => focusGauge(g) });
  }
  const tail = [];
  const freshLsrs = state.lsrs.filter((f) => ageMins(f.properties.valid) <= lsrFreshCutoffMins()).slice(0, 2);
  for (const f of freshLsrs) {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    tail.push({ text: `💧 ${p.typetext} ${p.city} · ${relWhen(p.valid)}`, act: () => state.map.setView([lat, lon], 12) });
  }
  const crit = activeRequests().filter((r) => r.status !== 'resolved' && r.priority === 'critical')
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
  if (crit) {
    const head = crit.summary.length > 60 ? `${crit.summary.slice(0, 59)}…` : crit.summary;
    tail.push({
      text: `${TYPE_GLYPH[crit.type] || '📍'} ${head} · ${relWhen(crit.ts)}`,
      color: 'var(--sev-emergency)',
      act: () => {
        document.querySelector('.tabs button[data-tab="tab-requests"]').click();
        if (Number.isFinite(crit.lat)) state.map.setView([crit.lat, crit.lon], 12);
      },
    });
  }
  // ~12-item budget: emergencies, majors, and the ground-truth tail keep their slots; the rising block absorbs the trim
  const riseSlots = Math.max(0, 12 - tail.length - emerg.length - majors.length);
  return emerg.concat(rise.slice(0, riseSlots), majors, tail);
}

function renderTicker() {
  const el = $('#ticker');
  if (!el) return;
  const items = tickerItems();
  state.tickerActs = items.map((i) => i.act);
  if (!items.length) { el.hidden = true; state.tickerHash = ''; return; }
  el.hidden = false;
  const half = items.map((i, n) =>
    `<span class="ticker-item" data-ti="${n}"${i.color ? ` style="color:${i.color}"` : ''}>${esc(i.text)}</span><span class="ticker-sep">·</span>`).join('');
  if (half === state.tickerHash) return; // unchanged — don't restart the scroll animation
  state.tickerHash = half;
  $('#ticker-track').innerHTML = `<span class="ticker-half">${half}</span><span class="ticker-half">${half}</span>`;
}

/* ---------- tiles / header ---------- */

function renderTiles() {
  renderThreatStrip();
  renderTicker();
  renderDriveMode(); // no-op when Drive Mode is closed; keeps the glance list live on each refresh
  const emergencies = state.alerts.filter((a) => a._sev === 'emergency').length;
  const warnings = state.alerts.filter((a) => a._sev === 'warning').length;
  const inFlood = state.gauges.filter((g) => FLOOD_CATS.includes(gaugeCat(g)));
  const major = inFlood.filter((g) => gaugeCat(g) === 'major').length;
  const rising = state.gauges.filter(gaugeRising).length;
  const open = activeRequests().filter((r) => r.status !== 'resolved').length;
  const crit = activeRequests().filter((r) => r.status !== 'resolved' && r.priority === 'critical').length;
  const flag = document.title.startsWith('🔴') ? '🔴 ' : '';
  document.title = `${flag}${crit ? `(${crit}) ` : ''}${state.baseTitle}`;
  $('#tile-emergency .value').innerHTML = `<span class="dot" style="background:var(--sev-emergency)"></span>${emergencies}`;
  $('#tile-warnings .value').textContent = warnings;
  // never render a confident 0 when the feed has not loaded — a missing MAJOR is dangerous
  $('#tile-gauges .value').innerHTML = state.sourceHealth.gauges || state.gauges.length
    ? `${inFlood.length} <span class="unit">${major} major · ▲${rising}</span>`
    : '– <span class="unit">no data</span>';
  $('#tile-open .value').textContent = open;
}

// seeds are re-fetched every refresh so open clients pick up curated data updates
async function loadSeeds() {
  try {
    const bust = `?_=${Date.now()}`;
    const [reqs, res] = await Promise.all([
      fetch(`data/requests.json${bust}`).then((r) => r.json()),
      fetch(`data/resources.json${bust}`).then((r) => r.json()),
    ]);
    // crest-of-record context — absence-tolerant (older deploys shipped no records.json)
    if (!state.records) {
      state.records = (await fetch(`data/records.json${bust}`).then((r) => (r.ok ? r.json() : null)).catch(() => null) || {}).records || {};
    }
    // low-water crossings — absence-tolerant; refetched each cycle for status changes
    state.crossings = (await fetch(`data/crossings.json${bust}`).then((r) => (r.ok ? r.json() : null)).catch(() => null) || {}).crossings || [];
    markHealthy('seeds');
    const hash = JSON.stringify([reqs, res]);
    if (hash === state.seedHash) return true;  // unchanged — don't reset operator's scroll
    state.seedHash = hash;
    state.seedRequests = reqs.requests || [];
    state.resources = res;
    renderRequests();
    renderResources();
    renderCrossings();
    renderMonitors();
    return true;
  } catch { return false; }
}

const CROSSING_STALE_H = 12;
const CROSSING_STATUS = {
  closed: { color: 'var(--sev-emergency)', glyph: '⛔', label: 'CLOSED' },
  caution: { color: 'var(--cat-action)', glyph: '⚠', label: 'CAUTION' },
  longterm: { color: 'var(--ink-muted)', glyph: '⛔', label: 'LONG-TERM CLOSED' },
  open: { color: 'var(--good)', glyph: '✓', label: 'OPEN' },
};
function renderCrossings() {
  const layer = state.layers.crossings;
  if (layer) layer.clearLayers();
  const list = state.crossings || [];
  const el = $('#crossings-body');
  if (el) {
    el.innerHTML = list.length
      ? `<div class="section-title">${esc(t('cross.title'))}</div>` +
        list.map((c) => {
          const st = CROSSING_STATUS[c.status] || CROSSING_STATUS.caution;
          const staleH = c.updated_at ? (Date.now() - new Date(c.updated_at).getTime()) / 3600000 : Infinity;
          const stale = staleH > CROSSING_STALE_H ? ` · <span class="xg-stale">stale ${Math.round(staleH)}h — reverify</span>` : '';
          return `<div class="resource-item"><strong style="color:${st.color}">${st.glyph} ${st.label}</strong> — ${esc(c.name)}` +
            `<div class="addr">${esc(c.reason || '')} · updated ${esc(fmtWhen(c.updated_at))}${stale} <a href="${esc(c.source)}" target="_blank" rel="noopener">src</a></div></div>`;
        }).join('') +
        `<div class="resource-item" style="border:none"><a href="https://drivetexas.org/" target="_blank" rel="noopener">${esc(t('cross.drivetx'))}</a></div>`
      : '';
  }
  for (const c of list) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon) || !layer) continue;
    const st = CROSSING_STATUS[c.status] || CROSSING_STATUS.caution;
    const icon = L.divIcon({ className: '', html: `<div class="crossing-icon" style="border-color:${st.color};color:${st.color}">${st.glyph}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
    const m = L.marker([c.lat, c.lon], { icon });
    m.bindPopup(`<div class="popup-title" style="color:${st.color}">${st.glyph} ${st.label} — crossing</div><div>${esc(c.name)}</div>` +
      `<div class="popup-meta">${esc(c.reason || '')}</div>` +
      `<div class="popup-meta">Updated ${esc(fmtWhen(c.updated_at))} · verify before routing</div>` +
      (c.source ? `<div class="popup-link"><a href="${esc(c.source)}" target="_blank" rel="noopener">source →</a></div>` : ''));
    layer.addLayer(m);
  }
}

const CACHE_KEY = 'respondertx.cache.v1';
function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      ts: Date.now(),
      gauges: state.gauges,
      alertsSlim: state.alerts.map((f) => ({ id: f.id, _sev: f._sev, properties: { event: f.properties.event, areaDesc: f.properties.areaDesc, expires: f.properties.expires }, geometry: null })),
    }));
  } catch { /* quota exceeded — cache is best-effort */ }
}
function hydrateFromCache() {
  let c;
  try { c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { c = null; }
  if (!c) return false;
  if (!state.gauges.length && c.gauges) { state.gauges = c.gauges; renderGauges(); renderGaugesTab(); }
  if (!state.alerts.length && c.alertsSlim) { state.alerts = c.alertsSlim; renderAlertList(); }
  renderTiles();
  $('#refresh-note').textContent = `offline — cached as of ${fmtWhen(new Date(c.ts).toISOString())}`;
  return true;
}

// cold-start fallback: ops cycles publish a ≤15-min NWPS snapshot — fresh public visitors survive rate-limit windows
async function hydrateGaugesSnapshot() {
  if (state.gauges.length) return false;
  try {
    const d = await fetch(`data/gauges-snapshot.json?_=${Date.now()}`).then((r) => (r.ok ? r.json() : null));
    if (state.gauges.length) return false; // a live NWPS refresh resolved during the fetch — never revert fresh gauges to snapshot
    if (!d || !d.gauges || !d.gauges.length) return false;
    state.gauges = d.gauges.filter((g) => {
      const c = g.status && g.status.observed && g.status.observed.floodCategory;
      return c && !['out_of_service', 'obs_not_current', 'not_defined'].includes(c);
    });
    state.snapshotAt = new Date(d.generated).getTime();
    recordTrends();
    renderGauges();
    renderGaugesTab();
    renderForecastList();
    renderTiles();
    $('#refresh-note').textContent = `gauges from snapshot · ${fmtWhen(d.generated)}`;
    return true;
  } catch { return false; } // snapshot absent (old deploy) — nothing to hydrate
}

async function refresh() {
  $('#refresh-note').textContent = 'refreshing…';
  if (state.refreshRadar) state.refreshRadar();
  const gaugesP = fetchGauges();
  // fcstMax/usgs dedupe against state.gauges — run after the NWPS fetch settles either way
  const afterGauges = gaugesP.catch(() => { /* NWPS failure reported via gaugesP; dedupe uses last-known gauges */ });
  const results = await Promise.allSettled([fetchAlerts(), gaugesP, afterGauges.then(fetchFcstMax), afterGauges.then(fetchUsgsIv), fetchLsrs(), loadSeeds(), fetchRoadClosures()]);
  const SOURCE_NAMES = ['NWS alerts', 'NWPS gauges', 'RFC forecast', 'USGS stage', 'storm reports', 'board data', 'TxDOT roads'];
  const failed = results.filter((r) => r.status === 'rejected');
  const failedNames = results.map((r, i) => (r.status === 'rejected' ? SOURCE_NAMES[i] : null)).filter(Boolean).join(', ');
  state.refreshAt = Date.now() + CONFIG.refreshMs;
  if (failed.length && (!state.alerts.length || !state.gauges.length)) {
    const hydrated = hydrateFromCache();
    const snapped = await hydrateGaugesSnapshot();
    renderSourceHealth();
    if (!hydrated && !snapped) $('#refresh-note').textContent = `degraded: ${failedNames}`;
    return;
  }
  if (!failed.length) saveCache();
  renderSourceHealth();
  checkAppVersion();
  $('#refresh-note').textContent = failed.length
    ? `degraded: ${failedNames}`
    : `updated ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })} CT`;
}

function markHealthy(source) { state.sourceHealth[source] = Date.now(); }

function renderSourceHealth() {
  const el = $('#source-health');
  if (!el) return;
  const sources = [['alerts', 'NWS alerts'], ['gauges', 'NOAA gauges'], ['fcstMax', 'RFC forecast max'], ['usgs', 'USGS raw stage'], ['lsrs', 'Storm reports'], ['seeds', 'Board data'], ['roads', 'TxDOT roads']];
  el.innerHTML = '<div class="section-title">Data source health</div>' +
    '<div class="filters" style="margin-bottom:12px">' + sources.map(([k, label]) => {
      const t = state.sourceHealth[k];
      const age = t ? (Date.now() - t) / 60000 : Infinity;
      const cls = age < 10 ? 'fresh' : age < 30 ? 'aging' : 'stale';
      const when = t ? `${Math.round(age)}m ago` : 'never';
      return `<span class="badge"><span class="fresh-dot ${cls}"></span> ${esc(label)} · ${when}</span>`;
    }).join('') + '</div>';
}

// long-lived tabs run old code forever — tell them when a newer build shipped (never auto-reload mid-use)
async function checkAppVersion() {
  try {
    const d = await fetch(`data/changelog.json?_=${Date.now()}`).then((r) => (r.ok ? r.json() : null));
    const latest = d && d.versions && d.versions[0] && d.versions[0].v;
    if (latest && latest !== APP_VERSION) $('#update-chip').hidden = false;
  } catch { /* offline — no update signal */ }
}

function tickCountdown() {
  if (!state.refreshAt) return;
  const s = Math.max(0, Math.round((state.refreshAt - Date.now()) / 1000));
  $('#refresh-count').textContent = `next in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  renderDataAgeBar();
}

// when the live gauge feed dies, surface the fallback the board already holds — and stand it down on recovery
function autoUsgsFallback(on) {
  const lyr = state.layers.usgs;
  if (!lyr) return false;
  if (on && (state.usgsSites || []).length && !state.map.hasLayer(lyr)) {
    lyr.addTo(state.map);
    state.usgsAutoOn = true;
  } else if (!on && state.usgsAutoOn) {
    if (state.map.hasLayer(lyr)) state.map.removeLayer(lyr);
    state.usgsAutoOn = false;
  }
  return state.usgsAutoOn && state.map.hasLayer(lyr);
}

// stale data must never masquerade as live — full-width bar, not a muted corner note
function renderDataAgeBar() {
  const el = $('#data-age-bar');
  if (!state.alertsLoadedOnce && !state.gauges.length) { el.hidden = true; return; }
  const worst = ['gauges', 'alerts']
    .map((k) => ({ k, age: state.sourceHealth[k] ? (Date.now() - state.sourceHealth[k]) / 60000 : Infinity }))
    .sort((a, b) => b.age - a.age)[0];
  // boot grace: don't flash "NEVER LOADED" while the first fetch round is still in flight
  if (worst.age === Infinity && state.bootAt && Date.now() - state.bootAt < 25000) { el.hidden = true; return; }
  const gaugesAge = state.sourceHealth.gauges ? (Date.now() - state.sourceHealth.gauges) / 60000 : Infinity;
  const usgsOn = autoUsgsFallback(gaugesAge > 15);
  if (worst.age < 7.5) { el.hidden = true; return; }
  const label = worst.k === 'gauges' ? 'GAUGE' : 'ALERT';
  const usgsNote = usgsOn ? ' · USGS raw-stage fallback ON (no flood categories)' : '';
  let cls, text;
  if (worst.k === 'gauges' && state.snapshotAt) {
    const snapAge = Math.round((Date.now() - state.snapshotAt) / 60000);
    if (snapAge < 30) { el.hidden = true; return; } // owner: a fresh snapshot is a working state, not a warning
    cls = snapAge >= 60 ? 'red' : 'amber';
    text = `⚠ GAUGES FROM SNAPSHOT ${snapAge} MIN OLD — live NWPS feed failing${usgsNote}`;
  } else {
    cls = worst.age > 15 ? 'red' : 'amber';
    text = (worst.age === Infinity
      ? `⚠ ${label} DATA NEVER LOADED — numbers on this board exclude it`
      : `⚠ ${label} DATA ${Math.round(worst.age)} MIN OLD — refresh failing; treat as stale`) + (worst.k === 'gauges' ? usgsNote : '');
  }
  const key = `${worst.k}|${cls}`; // dismissal holds until the failing source or severity changes
  if (sessionStorage.getItem('respondertx.ageBarDismiss') === key) { el.hidden = true; return; }
  el.hidden = false;
  el.className = cls;
  el.dataset.key = key;
  el.innerHTML = `<span>${esc(text)}</span><button class="age-bar-x" title="Dismiss until this changes">✕</button>`;
}

/* ---------- in-app changelog ---------- */

async function openChangelog() {
  $('#changelog-modal').hidden = false;
  localStorage.setItem('respondertx.lastVersion', APP_VERSION);
  $('#app-version').classList.remove('has-new');
  const body = $('#changelog-body');
  if (body.dataset.loaded) return;
  try {
    const data = await fetch(`data/changelog.json?_=${Date.now()}`).then((r) => r.json());
    body.innerHTML = (data.versions || []).map((v) =>
      `<div class="chg-row"><span class="chg-v">${esc(v.v)}</span><span class="chg-line">${esc(v.line)}</span></div>`).join('');
    body.dataset.loaded = '1';
  } catch { body.textContent = 'Changelog unavailable.'; }
}

/* ---------- boot ---------- */

async function loadEventConfig() {
  try {
    const ev = await fetch('data/event.json').then((r) => r.json());
    if (Array.isArray(ev.center)) CONFIG.center = ev.center;
    if (ev.zoom) CONFIG.zoom = ev.zoom;
    if (ev.gaugeBbox) CONFIG.gaugeBbox = ev.gaugeBbox;
    if (ev.name) { document.querySelector('.brand h1').textContent = ev.name; state.baseTitle = ev.name; }
    if (ev.subtitle) {
      const st = document.querySelector('.brand .sub-text');
      if (st) {
        // a curator subtitle that differs from the default is their own words — don't localize it
        if (ev.subtitle !== I18N.en['brand.sub']) st.removeAttribute('data-i18n');
        st.textContent = ev.subtitle;
      }
    }
  } catch { /* keep built-in CONFIG defaults */ }
}

// re-render the localized dynamic surfaces after a live language switch (setLang already
// re-applied the static strings and document.lang)
function relocalizeDynamic() {
  applyTheme(document.documentElement.getAttribute('data-theme'));
  renderTiles();
  renderAlertList();
  renderForecastList();
  renderGaugesTab();
  renderRequests();
  if (state.resources) { renderResources(); renderMonitors(); }
  renderCrossings();
  renderSourceHealth();
}

async function boot() {
  const themeParam = new URLSearchParams(location.search).get('theme');
  applyTheme(themeParam || localStorage.getItem('respondertx.theme') || 'dark');
  await loadEventConfig();
  applyI18n(document);
  initMap();
  applyTheme(document.documentElement.getAttribute('data-theme'));
  loadStore();
  loadHist();
  try { state.trendHist = JSON.parse(localStorage.getItem(TREND_KEY)) || {}; } catch { state.trendHist = {}; }

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab-body').forEach((t) => t.classList.toggle('active', t.id === b.dataset.tab));
    if (state.viewReady) saveViewState(); // skip during boot restore/URL apply — only real user taps
    if (window.innerWidth <= 768 && document.querySelector('main').classList.contains('sheet-peek')) setSheet('sheet-half');
  }));
  initSheet();
  // device rotation reflows the map container — Leaflet needs invalidateSize or tiles stay grey
  let resizeT;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (state.map) state.map.invalidateSize(); }, 200);
  });
  // header tiles mirror the threat-strip act() targets — passive numbers are dead UI
  const goTab = (tab) => document.querySelector(`.tabs button[data-tab="${tab}"]`).click();
  for (const [id, tab] of [['#tile-emergency', 'tab-alerts'], ['#tile-warnings', 'tab-alerts'], ['#tile-gauges', 'tab-gauges'], ['#tile-open', 'tab-requests']]) {
    $(id).addEventListener('click', () => goTab(tab));
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goTab(tab); } });
  }
  $('#theme-toggle').addEventListener('click', () =>
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
  const updateLangToggle = () => { $('#lang-lbl').textContent = getLang() === 'es' ? 'EN' : 'ES'; };
  updateLangToggle();
  $('#lang-toggle').addEventListener('click', () => {
    setLang(getLang() === 'es' ? 'en' : 'es');
    updateLangToggle();
    relocalizeDynamic();
  });
  $('#refresh-now').addEventListener('click', refresh);
  $('#share-btn').addEventListener('click', (e) => shareView(e.target));
  const enterDrive = () => { $('#drive-mode').hidden = false; if (!state.myPos) { gpsWait(true); state.map.locate({ enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 }); } renderDriveMode(); };
  $('#drive-btn').addEventListener('click', enterDrive);
  // one-time discoverability nudge — Drive Mode is the field's best view but hides behind an icon
  if (!localStorage.getItem('respondertx.driveHintSeen')) {
    const dismissHint = () => { $('#drive-hint').hidden = true; localStorage.setItem('respondertx.driveHintSeen', '1'); };
    setTimeout(() => { if (!localStorage.getItem('respondertx.driveHintSeen')) $('#drive-hint').hidden = false; }, 3500);
    $('#drive-hint-go').addEventListener('click', () => { dismissHint(); enterDrive(); });
    $('#drive-hint-x').addEventListener('click', dismissHint);
  }
  $('#drive-exit').addEventListener('click', () => { $('#drive-mode').hidden = true; });
  // owner directive: "Am I at risk?" hidden by default — first-responder/public-info tool, not a
  // consumer address lookup. Code + modal stay intact; ?risk=1 reveals the button and opens the modal.
  const riskEnabled = new URLSearchParams(location.search).has('risk');
  if (!riskEnabled) $('#risk-btn').hidden = true;
  $('#risk-btn').addEventListener('click', openRiskCheck);
  $('#risk-close').addEventListener('click', () => { $('#risk-modal').hidden = true; });
  $('#risk-modal').addEventListener('click', (e) => { if (e.target.id === 'risk-modal') $('#risk-modal').hidden = true; });
  $('#risk-form').addEventListener('submit', (e) => { e.preventDefault(); runRiskFromInput(); });
  if (riskEnabled) { $('#risk-btn').hidden = false; openRiskCheck(); }
  $('#hydro-close').addEventListener('click', () => { $('#hydro-modal').hidden = true; });
  $('#hydro-modal').addEventListener('click', (e) => { if (e.target.id === 'hydro-modal') $('#hydro-modal').hidden = true; });
  $('#drive-loc').addEventListener('click', () => { gpsWait(true); state.map.locate({ enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 }); });
  $('#update-chip').addEventListener('click', () => location.reload());
  $('#data-age-bar').addEventListener('click', (e) => {
    if (!e.target.closest('.age-bar-x')) return;
    sessionStorage.setItem('respondertx.ageBarDismiss', $('#data-age-bar').dataset.key || '');
    $('#data-age-bar').hidden = true;
  });
  // one-time safety acknowledgment (persisted) — the footer 911 disclaimer stays regardless
  if (!localStorage.getItem('respondertx.safetyAck')) {
    $('#safety-modal').hidden = false;
    $('#safety-ack').addEventListener('click', () => {
      localStorage.setItem('respondertx.safetyAck', '1');
      $('#safety-modal').hidden = true;
    });
  }
  $('#toggle-form').addEventListener('click', () => {
    const open = $('#new-request-form').classList.toggle('open');
    // pin-drop needs the map on screen — phones scroll it into view when intake opens
    if (open && window.innerWidth <= 768) $('#map').scrollIntoView({ behavior: 'smooth' });
  });
  // owner: "New notice" intake suppressed by default; ?intake=1 reveals it (code + form kept intact)
  if (new URLSearchParams(location.search).has('intake')) $('#toggle-form').hidden = false;
  // radio-relayed coords arrive as text — typed "lat, lon" is a first-class pin source
  $('#f-latlon').addEventListener('change', () => {
    const raw = $('#f-latlon').value.trim();
    if (!raw) { state.pendingLatLng = null; return; }
    const m = raw.match(/(-?\d{1,2}(?:\.\d+)?)[,\s]+(-?\d{1,3}(?:\.\d+)?)/);
    const lat = m ? +m[1] : NaN, lng = m ? +m[2] : NaN;
    if (!m || !(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) {
      $('#f-latlon').value = 'unparsed — type decimal "lat, lon"';
      state.pendingLatLng = null;
      return;
    }
    state.pendingLatLng = L.latLng(lat, lng);
    $('#f-latlon').value = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    state.map.setView(state.pendingLatLng, Math.max(state.map.getZoom(), 11));
  });
  $('#f-geocode').addEventListener('click', geocodePlace);
  $('#new-request-form').addEventListener('submit', submitRequest);
  $('#export-btn').addEventListener('click', exportRequests);
  $('#export-geo-btn').addEventListener('click', exportGeoJSON);
  $('#sitrep-btn').addEventListener('click', (e) => copySitrep(e.target));
  $('#aar-btn').addEventListener('click', exportAAR);
  // ticker halves are duplicated markup — delegate clicks by item index instead of per-node listeners
  $('#ticker').addEventListener('click', (e) => {
    const it = e.target.closest('.ticker-item');
    if (!it || !state.tickerActs) return;
    const act = state.tickerActs[+it.dataset.ti];
    if (act) act();
  });
  $('#banner-dismiss').addEventListener('click', dismissEmergencyBanner);
  $('#banner-text').addEventListener('click', () => {
    dismissEmergencyBanner();
    document.querySelector('.tabs button[data-tab="tab-alerts"]').click();
  });
  $('#import-file').addEventListener('change', (e) => { if (e.target.files[0]) importRequests(e.target.files[0]); e.target.value = ''; });
  ['#flt-type', '#flt-county'].forEach((sel) => $(sel).addEventListener('change', () => {
    state.filters.type = $('#flt-type').value;
    state.filters.county = $('#flt-county').value;
    renderRequests();
    saveViewState();
  }));
  $('#flt-q').addEventListener('input', () => {
    state.filters.q = $('#flt-q').value;
    renderRequests();
    flyToRadioId(state.filters.q);
    saveViewState();
  });
  $('#flt-sort').addEventListener('change', () => { state.sort = $('#flt-sort').value; renderRequests(); saveViewState(); });
  $('#flt-alert-sev').addEventListener('change', () => { renderAlertList(); saveViewState(); });
  $('#flt-alert-q').addEventListener('input', () => { renderAlertList(); saveViewState(); });
  $('#flt-window').addEventListener('change', () => {
    state.filters.window = $('#flt-window').value;
    renderRequests();
    saveViewState();
    fetchLsrs().catch(() => { /* transient — next poll retries */ });
  });
  $('#flt-dist').addEventListener('change', () => {
    state.filters.dist = $('#flt-dist').value;
    if (state.filters.dist && !state.myPos) {
      gpsWait(true);
      state.map.locate({ enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 });
    }
    renderRequests();
    saveViewState();
  });

  $('#flt-aged').addEventListener('click', () => { state.showAged = !state.showAged; renderRequests(); saveViewState(); });
  $('#req-filters').hidden = localStorage.getItem('respondertx.filtersOpen') !== '1';
  $('#find-id').addEventListener('click', () => {
    $('#req-filters').hidden = false;
    const q = $('#flt-q');
    q.placeholder = 'Type a radio ID — R-031';
    q.focus();
    q.select();
  });
  $('#filters-toggle').addEventListener('click', () => {
    const open = $('#req-filters').hidden;
    $('#req-filters').hidden = !open;
    localStorage.setItem('respondertx.filtersOpen', open ? '1' : '0');
    updateFiltersBadge();
  });
  $('#more-toggle').addEventListener('click', () => {
    const menu = $('#more-menu');
    menu.hidden = !menu.hidden;
    $('#more-toggle').classList.toggle('on', !menu.hidden);
  });

  state.lastSeen = +localStorage.getItem('respondertx.lastSeen') || 0;
  localStorage.setItem('respondertx.lastSeen', String(Date.now()));
  $('#app-version').textContent = APP_VERSION;
  if (localStorage.getItem('respondertx.lastVersion') !== APP_VERSION) $('#app-version').classList.add('has-new');
  $('#app-version').addEventListener('click', openChangelog);
  $('#app-version').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChangelog(); } });
  $('#changelog-close').addEventListener('click', () => { $('#changelog-modal').hidden = true; });
  $('#changelog-modal').addEventListener('click', (e) => { if (e.target.id === 'changelog-modal') $('#changelog-modal').hidden = true; });
  // Escape closes the top-most open overlay
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const id of ['#risk-modal', '#hydro-modal', '#changelog-modal', '#drive-mode', '#safety-modal']) {
      const m = $(id);
      if (m && !m.hidden) { m.hidden = true; break; }
    }
  });

  $('#rs-play').addEventListener('click', toggleRadarPlay);
  $('#rs-slider').addEventListener('input', () => { stopRadarPlay(); setRadarFrame(+$('#rs-slider').value); });
  if (new URLSearchParams(location.search).get('radar') === '1') state.layers.radar.addTo(state.map);

  $('#disclaimer').addEventListener('click', (e) => {
    if (e.target.id === 'app-version') return;
    if (window.innerWidth <= 768) $('#disclaimer').classList.toggle('open');
  });

  // ops chat is a LAN-only construct: UI code (js/chat.js) loads only when the
  // local backend answers — the public mirror ships neither the file nor a route
  const markMirror = () => {
    $('#new-request-form .hint').textContent =
      'Read-only mirror: notices added here save to THIS DEVICE ONLY — they do not reach the ops session. Click the map to set the pin.';
  };
  fetch('/api/ping').then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (d && d.chat) {
      const s = document.createElement('script');
      s.src = 'js/chat.js';
      document.body.appendChild(s);
    } else markMirror();
  }).catch(markMirror);
  restoreViewState(); // saved view first, so any URL param below overrides it for this load

  const rainParam = new URLSearchParams(location.search).get('rain');
  if (rainParam === '1h') state.layers.mrms1h.addTo(state.map);
  else if (rainParam === '24h') state.layers.mrms24h.addTo(state.map);

  const tabParam = new URLSearchParams(location.search).get('tab');
  // guard the selector interpolation — a crafted ?tab= (e.g. %22%5D) would throw a DOMException and abort boot()
  if (tabParam && /^[a-z-]+$/.test(tabParam)) {
    const btn = document.querySelector(`.tabs button[data-tab="tab-${tabParam}"]`);
    if (btn) btn.click();
  }
  applyShareParams(new URLSearchParams(location.search)); // URL share-params win for this load
  state.viewReady = true;
  if (new URLSearchParams(location.search).get('view') === 'drive') $('#drive-btn').click();
  const hydroParam = new URLSearchParams(location.search).get('hydro');
  if (hydroParam) state.pendingHydro = hydroParam.toUpperCase();

  // paint snapshot gauges immediately — a slow/failing NWPS first-fetch must never leave a blank, scary board
  state.bootAt = Date.now();
  hydrateGaugesSnapshot();
  const ok = await loadSeeds();
  // a shared ?fq=R-031 link fires before seeds exist — re-fly once the cards are on the board
  if (ok) flyToRadioId(new URLSearchParams(location.search).get('fq'));
  if (!ok) {
    $('#request-list').innerHTML = '<div class="card">Failed to load seed data. Serve over HTTP (see README), not file://.</div>';
    state.resources = state.resources || { shelters: [], hotlines: [], monitors: [], comms: [], dataLinks: [] };
    renderResources();
    renderMonitors();
  }
  await refresh();
  // battery/data saver: don't poll while backgrounded; catch up the moment we're visible again
  setInterval(() => {
    if (document.visibilityState === 'hidden') { state.pendingRefresh = true; return; }
    refresh();
  }, CONFIG.refreshMs);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.pendingRefresh) {
      state.pendingRefresh = false;
      refresh();
    }
  });
  setInterval(tickCountdown, 1000);
}

document.addEventListener('DOMContentLoaded', boot);
