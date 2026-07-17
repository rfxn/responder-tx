'use strict';

const APP_VERSION = 'v0.35.0';

const CONFIG = {
  center: [29.75, -99.35],
  zoom: 8,
  // Hill Country + Uvalde/Nueces basins; widen if the event spreads
  // widened 7/16 PM: Nueces wave moving downstream + LCRA floodgate releases on the Colorado
  gaugeBbox: { xmin: -101.2, ymin: 28.0, xmax: -97.0, ymax: 31.1 },
  alertsUrl: 'https://api.weather.gov/alerts/active?area=TX',
  nwpsBase: 'https://api.water.noaa.gov/nwps/v1',
  fcstMaxUrl: 'https://maps.water.noaa.gov/server/rest/services/rfc/rfc_max_forecast/MapServer/0/query',
  usgsIvBase: 'https://waterservices.usgs.gov/nwis/iv/',
  refreshMs: 180000,
  maxZoneGeomFetches: 12,
  sparkHours: 48,
  staleMins: 360,
  smartHalfLifeMins: 360,
  agedCardMins: 1440,
  agedLsrMins: 180,
  histDays: 7,
  lsrHours: 12,
  lsrUrl: 'https://mesonet.agron.iastate.edu/geojson/lsr.geojson',
  rainviewerApi: 'https://api.rainviewer.com/public/weather-maps.json',
  mrms1hUrl: 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/q2-n1p-900913/{z}/{x}/{y}.png',
  mrms24hUrl: 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/q2-p24h-900913/{z}/{x}/{y}.png',
};

const CAT_RANK = { none: 0, action: 1, minor: 2, moderate: 3, major: 4 };
const LSR_FLOOD_RE = /FLOOD|HEAVY RAIN|DEBRIS|DAM |LANDSLIDE|RESCUE/i;
const ROAD_RE = /\b(?:FM|RM|RR|CR|SH|US|IH?|LOOP|HWY)[-\s]?\d+\b/gi;

const FLOOD_CATS = ['action', 'minor', 'moderate', 'major'];
const CAT_LABEL = { major: 'MAJOR flood', moderate: 'Moderate flood', minor: 'Minor flood', action: 'Near flood (action)', none: 'No flooding' };
const CAT_SIZE = { major: 18, moderate: 15, minor: 12, action: 10, none: 8 };
const TYPE_GLYPH = { rescue: '🆘', evacuation: '🏃', medical: '⚕️', supplies: '📦', shelter: '🏠', animal: '🐾', wellness: '💬', volunteer: '🤝', equipment: '🛠️', road: '🚧', cutoff: '⛔', info: 'ℹ️' };
const LIFE_SAFETY_TYPES = ['rescue', 'evacuation', 'medical', 'cutoff'];
const STATUSES = ['unverified', 'open', 'in-progress', 'resolved'];
const PRIORITIES = ['critical', 'high', 'medium', 'low'];
const LS_KEY = 'respondertx.store.v1';

const state = {
  map: null,
  baseLayers: {},
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
  filters: { type: '', status: '', county: '', q: '', window: '', dist: '' },
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
};

const PRI_WEIGHT = { critical: 8, high: 4, medium: 2, low: 1 };

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('respondertx.theme', theme);
  $('#theme-toggle').textContent = theme === 'dark' ? '☀️ Light' : '🌙 Dark';
  if (state.map) {
    Object.values(state.baseLayers).forEach((l) => state.map.removeLayer(l));
    state.baseLayers[theme].addTo(state.map);
  }
}

/* ---------- map ---------- */

function initMap() {
  state.map = L.map('map', { zoomControl: true }).setView(CONFIG.center, CONFIG.zoom);
  const attrib = '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
  state.baseLayers.dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: attrib, maxZoom: 19 });
  state.baseLayers.light = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: attrib, maxZoom: 19 });

  const bustSrc = (url) => url + '?_=' + Math.floor(Date.now() / 300000);
  // all radar/rainfall layers are OFF by default (owner directive) — explicit enable via layer control
  // maxNativeZoom 7: RainViewer's free tiles serve placeholders above z7 — upscale instead
  state.layers.radar = L.tileLayer('', { opacity: 0.6, maxNativeZoom: 7, maxZoom: 19, attribution: 'Radar: RainViewer' });
  state.layers.mrms1h = L.tileLayer(bustSrc(CONFIG.mrms1hUrl), { opacity: 0.55, attribution: 'Rainfall: MRMS via IEM' });
  state.layers.mrms24h = L.tileLayer(bustSrc(CONFIG.mrms24hUrl), { opacity: 0.55, attribution: 'Rainfall: MRMS via IEM' });
  state.refreshRadar = () => {
    state.layers.mrms1h.setUrl(bustSrc(CONFIG.mrms1hUrl));
    state.layers.mrms24h.setUrl(bustSrc(CONFIG.mrms24hUrl));
    if (state.map.hasLayer(state.layers.radar)) fetchRadarFrames().catch(() => { /* keep last frames */ });
  };
  state.map.on('overlayadd', (e) => {
    if (e.layer !== state.layers.radar) return;
    $('#radar-scrub').hidden = false;
    fetchRadarFrames().catch(() => { $('#rs-label').textContent = 'radar feed unavailable'; });
  });
  state.map.on('overlayremove', (e) => {
    if (e.layer !== state.layers.radar) return;
    $('#radar-scrub').hidden = true;
    stopRadarPlay();
  });

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
  L.control.layers(null, {
    'Radar scrub (-1h → +30m)': state.layers.radar,
    'Rainfall 1h (MRMS)': state.layers.mrms1h,
    'Rainfall 24h (MRMS)': state.layers.mrms24h,
    'Flood alerts (NWS)': state.layers.alerts,
    'River gauges (NOAA)': state.layers.gauges,
    'Forecast crests (RFC max)': state.layers.fcstMax,
    'USGS gauges (raw stage)': state.layers.usgs,
    'Storm reports (LSR)': state.layers.lsrs,
    'Aged storm reports (history)': state.layers.lsrsAged,
    'Notices (curated + field)': state.layers.requests,
    'Shelters': state.layers.shelters,
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
      '<div class="lg-title" style="margin-top:6px">Reports & requests</div>' +
      '<div><span style="margin-right:6px">💧</span>storm report (LSR)</div>' +
      '<div><span style="margin-right:6px">🆘</span>marker glyph = need type</div>';
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.on(div, 'click', () => div.classList.toggle('open')); // mobile: collapsed to title pill by default
    return div;
  };
  legend.addTo(state.map);

  state.map.on('click', (e) => {
    if (!$('#new-request-form').classList.contains('open')) return;
    state.pendingLatLng = e.latlng;
    $('#f-latlon').value = `${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`;
  });

  const LocateControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const bar = L.DomUtil.create('div', 'leaflet-bar');
      const a = L.DomUtil.create('a', 'locate-btn', bar);
      a.href = '#'; a.title = 'My location'; a.textContent = '⌖';
      L.DomEvent.on(a, 'click', (e) => {
        L.DomEvent.stop(e);
        state.map.locate({ enableHighAccuracy: true, maximumAge: 30000 });
      });
      return bar;
    },
  });
  state.map.addControl(new LocateControl());
  state.map.on('locationfound', (e) => {
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
  });
  state.map.on('locationerror', () => { $('#refresh-note').textContent = 'location unavailable (permission or no GPS)'; });

  const declutter = () => state.map.getContainer().classList.toggle('z-low', state.map.getZoom() < 9);
  state.map.on('zoomend', declutter);
  declutter();
}

/* ---------- radar time-scrub (RainViewer: past ~1h + nowcast projection when published) ---------- */

async function fetchRadarFrames() {
  const res = await fetch(CONFIG.rainviewerApi);
  if (!res.ok) throw new Error(`RainViewer HTTP ${res.status}`);
  const d = await res.json();
  const past = (d.radar && d.radar.past || []).slice(-7);
  const cast = (d.radar && d.radar.nowcast) || [];
  if (!past.length) throw new Error('no radar frames');
  const keepIdx = state.radar ? state.radar.idx : -1;
  state.radar = { host: d.host, frames: past.concat(cast), castStart: past.length, nowIdx: past.length - 1, idx: past.length - 1, playing: false, timer: null };
  $('#rs-slider').max = state.radar.frames.length - 1;
  setRadarFrame(keepIdx >= 0 && keepIdx < state.radar.frames.length ? keepIdx : state.radar.nowIdx);
}

function setRadarFrame(i) {
  const r = state.radar;
  if (!r || !r.frames.length) return;
  r.idx = Math.max(0, Math.min(i, r.frames.length - 1));
  state.layers.radar.setUrl(`${r.host}${r.frames[r.idx].path}/256/{z}/{x}/{y}/2/1_1.png`);
  $('#rs-slider').value = r.idx;
  const dMin = Math.round((r.frames[r.idx].time - r.frames[r.nowIdx].time) / 60);
  const projected = r.idx >= r.castStart;
  const label = $('#rs-label');
  label.textContent = dMin === 0 ? 'now' : dMin < 0 ? `${dMin}m` : `+${dMin}m PROJECTED`;
  label.classList.toggle('projected', projected);
  if (r.castStart >= r.frames.length && dMin === 0) label.textContent = 'now (projection unavailable)';
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
  floods.sort((a, b) => rank[a._sev] - rank[b._sev]);
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

function renderAlertList() {
  const el = $('#alert-list');
  el.innerHTML = '<div class="section-title">NWS flood alerts (statewide)</div>';
  const sevF = $('#flt-alert-sev').value, qF = $('#flt-alert-q').value.toLowerCase();
  const shown = state.alerts.filter((f) => (!sevF || f._sev === sevF)
    && (!qF || `${f.properties.event} ${f.properties.areaDesc}`.toLowerCase().includes(qF)));
  if (!shown.length) { el.innerHTML += '<div class="card">No alerts match.</div>'; return; }
  for (const f of shown) {
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
        if (b.isValid()) state.map.fitBounds(b, { maxZoom: 10 });
      }
    });
    el.appendChild(div);
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
  recordTrends();
  renderGauges();
  renderForecastList();
  renderTiles();
}

function gaugeCat(g) {
  const c = g.status.observed.floodCategory;
  return FLOOD_CATS.includes(c) ? c : 'none';
}

function gaugeForecastCat(g) {
  const c = g.status && g.status.forecast && g.status.forecast.floodCategory;
  return FLOOD_CATS.includes(c) ? c : null;
}

function gaugeRising(g) {
  const f = gaugeForecastCat(g);
  return f !== null && CAT_RANK[f] > CAT_RANK[gaugeCat(g)];
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
  for (const g of state.gauges) {
    const cat = gaugeCat(g);
    const rising = gaugeRising(g);
    const size = CAT_SIZE[cat];
    const trend = gaugeTrend(g.lid);
    const falling = cat !== 'none' && trend && trend.dir === 'down';
    // 32px hit area around the visual dot — 8-18px dots are untappable one-thumbed (UX audit #5)
    const icon = L.divIcon({
      className: '',
      html: `<div class="gauge-hit${cat === 'none' ? ' hit-none' : ''}">` +
        `<div class="gauge-icon cat-${cat}" style="width:${size}px;height:${size}px"></div>` +
        (rising ? `<span class="rise-arrow cat-${gaugeForecastCat(g)}">▲</span>` : '') +
        (falling ? '<span class="fall-arrow">▼</span>' : '') + '</div>',
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
    const m = L.marker([g.latitude, g.longitude], { icon, zIndexOffset: cat === 'major' ? 1000 : rising ? 500 : 0 });
    m.bindPopup(() => gaugePopup(g), { minWidth: 290 });
    state.layers.gauges.addLayer(m);
  }
}

function gaugePopup(g) {
  const o = g.status.observed;
  const cat = gaugeCat(g);
  const el = document.createElement('div');
  const f = g.status.forecast;
  const fCat = gaugeForecastCat(g);
  const forecastLine = fCat
    ? `<div class="popup-meta">${gaugeRising(g) ? '▲ RISING — ' : ''}Forecast: ${f.primary} ${esc(f.primaryUnit)} — <span class="cat-word" style="color:var(--cat-${fCat})">${esc(CAT_LABEL[fCat])}</span> @ ${esc(fmtWhen(f.validTime))}</div>`
    : '';
  const tr = gaugeTrend(g.lid);
  const trendLine = tr
    ? `<div class="popup-meta">Trend: ${tr.rate >= 0 ? '+' : ''}${tr.rate.toFixed(1)} ft/hr ${tr.dir === 'up' ? '↑' : tr.dir === 'down' ? '↓' : '→ steady'} (last ~hour)</div>`
    : '';
  el.innerHTML = `<div class="popup-title">${esc(g.name)}</div>` +
    `<div class="popup-meta"><span class="cat-word" style="color:var(--cat-${cat})">${esc(CAT_LABEL[cat])}</span> · ${o.primary} ${esc(o.primaryUnit)} @ ${esc(fmtWhen(o.validTime))}</div>` +
    trendLine +
    forecastLine +
    `<div class="popup-spark"><canvas width="270" height="80"></canvas><div class="spark-note">Loading ${CONFIG.sparkHours}h stage history…</div></div>` +
    `<div class="popup-link"><a href="https://water.noaa.gov/gauges/${esc(g.lid)}" target="_blank" rel="noopener">NOAA gauge page (forecast) →</a></div>`;
  drawSparkline(g, el.querySelector('canvas'), el.querySelector('.spark-note'));
  return el;
}

async function drawSparkline(g, canvas, note) {
  try {
    const [detail, series] = await Promise.all([
      fetch(`${CONFIG.nwpsBase}/gauges/${g.lid}`).then((r) => r.json()),
      fetch(`${CONFIG.nwpsBase}/gauges/${g.lid}/stageflow/observed`).then((r) => r.json()),
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
      `<div class="popup-meta">Forecast max: ${p.max_value} ft — <span class="cat-word" style="color:var(--cat-${cat})">${esc(CAT_LABEL[cat])}</span> (5-day)</div>` +
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
  const cutoff = lsrFreshCutoffMins();
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
}

function renderForecastList() {
  const el = $('#forecast-list');
  const rising = state.gauges
    .filter((g) => gaugeRising(g) && CAT_RANK[gaugeForecastCat(g)] >= CAT_RANK.minor)
    .sort((a, b) => CAT_RANK[gaugeForecastCat(b)] - CAT_RANK[gaugeForecastCat(a)]
      || new Date(a.status.forecast.validTime) - new Date(b.status.forecast.validTime));
  el.innerHTML = '<div class="section-title">Forecast to flood — pre-position ahead of these crests</div>';
  if (!rising.length) { el.innerHTML += '<div class="card">No gauges currently forecast to rise into flood.</div>'; return; }
  for (const g of rising) {
    const fCat = gaugeForecastCat(g);
    const f = g.status.forecast;
    const div = document.createElement('div');
    div.className = 'card';
    div.style.borderLeftColor = `var(--cat-${fCat})`;
    div.innerHTML = `<div class="head"><span>▲</span><span class="type-chip">${esc(CAT_LABEL[gaugeCat(g)])} → <span style="color:var(--cat-${fCat})">${esc(CAT_LABEL[fCat])}</span></span>` +
      `<span class="when">crest ${esc(fmtWhen(f.validTime))}</span></div>` +
      `<div class="summary">${esc(g.name)} — forecast crest ${f.primary} ${esc(f.primaryUnit)}</div>`;
    div.addEventListener('click', () => state.map.setView([g.latitude, g.longitude], 11));
    el.appendChild(div);
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
// notices are alerts, not tickets: resolved (curator-set) suppresses immediately, everything else times out
const cardAged = (r) => r.status === 'resolved' || (r.status !== 'in-progress' && ageMins(r.ts) > CONFIG.agedCardMins);
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
    const hay = `${r.summary} ${r.details} ${r.place} ${r.county}`.toLowerCase();
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
  cSel.innerHTML = '<option value="">All counties</option>' + counties.map((c) => `<option${c === cur ? ' selected' : ''}>${esc(c)}</option>`).join('');

  for (const r of visible) {
    const div = document.createElement('div');
    div.className = `card pri-${r.priority}${cardAged(r) ? ' aged' : ''}`;
    const src = r.source || {};
    const srcLink = src.url ? `<a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.platform || 'source')}: ${esc(src.handle || src.url)}</a>` : esc(`${src.platform || ''} ${src.handle || ''}`.trim());
    const isNew = state.lastSeen && new Date(r.ts).getTime() > state.lastSeen;
    const needsReverify = r.status !== 'resolved' && ageMins(r.ts) > CONFIG.staleMins;
    const hasPos = Number.isFinite(r.lat) && Number.isFinite(r.lon);
    div.innerHTML =
      `<div class="head"><span>${TYPE_GLYPH[r.type] || '📍'}</span><span class="type-chip">${esc(r.type)} · ${esc(r.priority)}</span>` +
      `<span class="when"><span class="fresh-dot ${freshClass(r.ts)}"></span> ${esc(fmtWhen(r.ts))}</span></div>` +
      `<div class="summary">${esc(r.summary)}</div>` +
      `<div class="meta">📍 ${esc(r.place)} (${esc(r.county)} Co.)${r.contact ? ` · ☎ ${esc(r.contact)}` : ''}` +
      (state.myPos && hasPos ? ` · ${distMi(state.myPos.lat, state.myPos.lng, r.lat, r.lon).toFixed(1)} mi` : '') + '</div>' +
      (r.details ? `<div class="meta" style="margin-top:3px">${esc(r.details)}</div>` : '') +
      `<div class="badges">${isNew ? '<span class="badge new-chip">NEW</span>' : ''}` +
      `<span class="badge status-${esc(r.status)}">${esc(r.status)}</span>` +
      (cardAged(r) ? '<span class="badge aged-chip">aged — suppressed</span>' : (needsReverify ? '<span class="badge reverify">stale — re-verify</span>' : '')) +
      `<span class="badge">${srcLink}</span>` +
      (hasPos ? `<button class="badge act nav-act">navigate</button><button class="badge act copy-act">copy coords</button>` : '') +
      '</div>';
    div.addEventListener('click', (ev) => {
      if (ev.target.closest('a')) return;
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
  if (!visible.length) el.innerHTML = '<div class="card">No requests match the current filters.</div>';

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
      `<div class="popup-meta">${esc(r.place)} · ${esc(r.status)} · ${esc(fmtWhen(r.ts))}</div>` +
      `<div class="popup-meta">USNG ${esc(toUSNG(r.lat, r.lon))} · ${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}</div>` +
      (r.source && r.source.url ? `<div class="popup-link"><a href="${esc(r.source.url)}" target="_blank" rel="noopener">source →</a></div>` : ''));
    state.layers.requests.addLayer(m);
    state.reqMarkers[r.id] = m;
  }

  const open = reqs.filter((r) => !cardAged(r) && r.status !== 'resolved');
  $('#requests-count').textContent = open.length;
  renderTiles();
}

async function geocodePlace() {
  const place = $('#f-place').value.trim();
  if (!place) { $('#f-latlon').value = 'enter a place name first'; return; }
  const county = $('#f-county').value.trim();
  const q = `${place}${county ? `, ${county} County` : ''}, Texas`;
  $('#f-latlon').value = 'looking up…';
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`);
    const hits = await res.json();
    if (!hits.length) { $('#f-latlon').value = 'not found — click the map instead'; return; }
    state.pendingLatLng = L.latLng(+hits[0].lat, +hits[0].lon);
    $('#f-latlon').value = `${(+hits[0].lat).toFixed(4)}, ${(+hits[0].lon).toFixed(4)} (geocoded — verify)`;
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
  for (const g of toMajor) L.push(`  RISING ${g.name} — fcst crest ${g.status.forecast.primary} ft ${fmtWhen(g.status.forecast.validTime)}`);
  const falling = state.gauges.filter((g) => gaugeCat(g) !== 'none' && (gaugeTrend(g.lid) || {}).dir === 'down');
  if (falling.length) L.push(`RECOVERY: ${falling.length} in-flood gauges falling (${falling.map((g) => g.name.split(' at ')[0].split(' near ')[0]).slice(0, 6).join('; ')})`);
  if (cutoffs.length) L.push(`CUT-OFF AREAS: ${cutoffs.map((r) => `${r.place} (${r.county} Co.)`).join('; ')}`);
  L.push(`OPEN CRITICAL (${crit.length}):`);
  for (const r of crit.slice(0, 10)) {
    const pos = Number.isFinite(r.lat) ? ` [USNG ${toUSNG(r.lat, r.lon)}]` : '';
    L.push(`  [${r.type.toUpperCase()}] ${r.summary} — ${r.place}, ${r.county} Co.${pos} (${fmtWhen(r.ts).split(' · ')[0]})`);
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
  el.innerHTML = '<div class="section-title">Open shelters (from official statements)</div>' +
    r.shelters.map((s) => `<div class="resource-item"><strong>${esc(s.name)}</strong><div class="addr">${esc(s.address)} · ${esc(s.county)} Co. — ${esc(s.note)} <a href="${esc(s.source)}" target="_blank" rel="noopener">src</a></div></div>`).join('') +
    '<div class="section-title">Hotlines</div>' +
    r.hotlines.map((h) => `<div class="resource-item"><strong>${esc(h.value)}</strong> — ${esc(h.name)}<div class="addr">${esc(h.note)}</div></div>`).join('') +
    '<div class="section-title">Authoritative data & live coverage</div>' +
    r.dataLinks.map((d) => `<div class="resource-item"><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.label)}</a></div>`).join('');

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
    g.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">↗ ${esc(l.label)}</a>`).join('') + '</div>';
}

function renderMonitors() {
  const el = $('#monitor-body');
  el.innerHTML = '<div class="section-title">Live social searches — open in new tab, triage into the feed</div>' +
    state.resources.monitors.map(monitorGroupHtml).join('') +
    '<div class="section-title">Comms — scanner audio & community nets</div>' +
    (state.resources.comms || []).map(monitorGroupHtml).join('') +
    '<div class="section-title">Workflow</div>' +
    '<div class="resource-item">1. Sweep each search every 15–30 min. 2. For actionable posts, click “+ New request”, click the map to drop the pin, paste the post URL as source. 3. Verify (cross-reference official channels or call back) before tasking. 4. Anything life-threatening → relay to 911/EOC immediately; this board does not dispatch.</div>';
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
    { n: emergencies, cls: 'emergency', label: 'FF emergencies', glyph: '⚠', act: () => document.querySelector('.tabs button[data-tab="tab-alerts"]').click() },
    { n: lifeReqs.length, cls: 'emergency', label: 'critical life-safety', glyph: '🆘', act: () => fitTo(lifeReqs.filter((r) => Number.isFinite(r.lat)).map((r) => [r.lat, r.lon])) },
    { n: cutoffs.length, cls: 'emergency', label: 'cut-off areas', glyph: '⛔', act: () => fitTo(cutoffs.filter((r) => Number.isFinite(r.lat)).map((r) => [r.lat, r.lon])) },
    { n: majors.length, cls: 'major', label: 'MAJOR gauges', glyph: '●', act: () => fitTo(majors.map((g) => [g.latitude, g.longitude])) },
    { n: toMajor.length, cls: 'major', label: 'rising to major', glyph: '▲', act: () => fitTo(toMajor.map((g) => [g.latitude, g.longitude])) },
    { n: roads.length, cls: 'warn', label: 'roads blocked', glyph: '🚧', act: () => fitTo(roads.filter((r) => Number.isFinite(r.lat)).map((r) => [r.lat, r.lon])) },
    {
      n: state.gauges.filter((g) => gaugeCat(g) !== 'none' && (gaugeTrend(g.lid) || {}).dir === 'down').length,
      cls: 'good', label: 'falling (recovery)', glyph: '▼',
      act: () => fitTo(state.gauges.filter((g) => gaugeCat(g) !== 'none' && (gaugeTrend(g.lid) || {}).dir === 'down').map((g) => [g.latitude, g.longitude])),
    },
  ].filter((c) => c.n > 0);
  if (!chips.length) {
    el.innerHTML = state.alertsLoadedOnce
      ? '<span class="strip-label" style="color:var(--good)">✓ NO ACTIVE LIFE-SAFETY SIGNALS</span><span style="font-size:11px;color:var(--ink-2)">recovery posture — verify before re-entry; fraud watch active (Monitor tab)</span>'
      : '';
    return;
  }
  el.innerHTML = '<span class="strip-label">THREAT TO LIFE</span>';
  for (const c of chips) {
    const b = document.createElement('button');
    b.className = `threat-chip ${c.cls}`;
    b.innerHTML = `${c.glyph} <strong>${c.n}</strong> ${esc(c.label)}`;
    b.addEventListener('click', c.act);
    el.appendChild(b);
  }
}

/* ---------- tiles / header ---------- */

function renderTiles() {
  renderThreatStrip();
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
    markHealthy('seeds');
    const hash = JSON.stringify([reqs, res]);
    if (hash === state.seedHash) return true;  // unchanged — don't reset operator's scroll
    state.seedHash = hash;
    state.seedRequests = reqs.requests || [];
    state.resources = res;
    renderRequests();
    renderResources();
    renderMonitors();
    return true;
  } catch { return false; }
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
  if (!state.gauges.length && c.gauges) { state.gauges = c.gauges; renderGauges(); }
  if (!state.alerts.length && c.alertsSlim) { state.alerts = c.alertsSlim; renderAlertList(); }
  renderTiles();
  $('#refresh-note').textContent = `offline — cached as of ${fmtWhen(new Date(c.ts).toISOString())}`;
  return true;
}

async function refresh() {
  $('#refresh-note').textContent = 'refreshing…';
  if (state.refreshRadar) state.refreshRadar();
  const gaugesP = fetchGauges();
  // fcstMax/usgs dedupe against state.gauges — run after the NWPS fetch settles either way
  const afterGauges = gaugesP.catch(() => { /* NWPS failure reported via gaugesP; dedupe uses last-known gauges */ });
  const results = await Promise.allSettled([fetchAlerts(), gaugesP, afterGauges.then(fetchFcstMax), afterGauges.then(fetchUsgsIv), fetchLsrs(), loadSeeds()]);
  const failed = results.filter((r) => r.status === 'rejected');
  state.refreshAt = Date.now() + CONFIG.refreshMs;
  if (failed.length && (!state.alerts.length || !state.gauges.length)) {
    hydrateFromCache();
    return;
  }
  if (!failed.length) saveCache();
  renderSourceHealth();
  $('#refresh-note').textContent = failed.length
    ? `degraded: ${failed.map((f) => f.reason.message).join('; ')}`
    : `updated ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })} CT`;
}

function markHealthy(source) { state.sourceHealth[source] = Date.now(); }

function renderSourceHealth() {
  const el = $('#source-health');
  if (!el) return;
  const sources = [['alerts', 'NWS alerts'], ['gauges', 'NOAA gauges'], ['fcstMax', 'RFC forecast max'], ['usgs', 'USGS raw stage'], ['lsrs', 'Storm reports'], ['seeds', 'Board data']];
  el.innerHTML = '<div class="section-title">Data source health</div>' +
    '<div class="filters" style="margin-bottom:12px">' + sources.map(([k, label]) => {
      const t = state.sourceHealth[k];
      const age = t ? (Date.now() - t) / 60000 : Infinity;
      const cls = age < 10 ? 'fresh' : age < 30 ? 'aging' : 'stale';
      const when = t ? `${Math.round(age)}m ago` : 'never';
      return `<span class="badge"><span class="fresh-dot ${cls}"></span> ${esc(label)} · ${when}</span>`;
    }).join('') + '</div>';
}

function tickCountdown() {
  if (!state.refreshAt) return;
  const s = Math.max(0, Math.round((state.refreshAt - Date.now()) / 1000));
  $('#refresh-count').textContent = `next in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  renderDataAgeBar();
}

// stale data must never masquerade as live — full-width bar, not a muted corner note
function renderDataAgeBar() {
  const el = $('#data-age-bar');
  if (!state.alertsLoadedOnce && !state.gauges.length) { el.hidden = true; return; }
  const worst = ['gauges', 'alerts']
    .map((k) => ({ k, age: state.sourceHealth[k] ? (Date.now() - state.sourceHealth[k]) / 60000 : Infinity }))
    .sort((a, b) => b.age - a.age)[0];
  if (worst.age < 7.5) { el.hidden = true; return; }
  el.hidden = false;
  el.className = worst.age > 15 ? 'red' : 'amber';
  const label = worst.k === 'gauges' ? 'GAUGE' : 'ALERT';
  el.textContent = worst.age === Infinity
    ? `⚠ ${label} DATA NEVER LOADED — numbers on this board exclude it`
    : `⚠ ${label} DATA ${Math.round(worst.age)} MIN OLD — refresh failing; treat as stale`;
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
      const sub = document.querySelector('.brand .sub');
      sub.innerHTML = '<span class="live-dot"></span>';
      sub.appendChild(document.createTextNode(ev.subtitle));
    }
  } catch { /* keep built-in CONFIG defaults */ }
}

async function boot() {
  const themeParam = new URLSearchParams(location.search).get('theme');
  applyTheme(themeParam || localStorage.getItem('respondertx.theme') || 'dark');
  await loadEventConfig();
  initMap();
  applyTheme(document.documentElement.getAttribute('data-theme'));
  loadStore();
  loadHist();
  try { state.trendHist = JSON.parse(localStorage.getItem(TREND_KEY)) || {}; } catch { state.trendHist = {}; }

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab-body').forEach((t) => t.classList.toggle('active', t.id === b.dataset.tab));
  }));
  $('#theme-toggle').addEventListener('click', () =>
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
  $('#refresh-now').addEventListener('click', refresh);
  $('#toggle-form').addEventListener('click', () => $('#new-request-form').classList.toggle('open'));
  $('#f-geocode').addEventListener('click', geocodePlace);
  $('#new-request-form').addEventListener('submit', submitRequest);
  $('#export-btn').addEventListener('click', exportRequests);
  $('#export-geo-btn').addEventListener('click', exportGeoJSON);
  $('#sitrep-btn').addEventListener('click', (e) => copySitrep(e.target));
  $('#aar-btn').addEventListener('click', exportAAR);
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
  }));
  $('#flt-q').addEventListener('input', () => { state.filters.q = $('#flt-q').value; renderRequests(); });
  $('#flt-sort').addEventListener('change', () => { state.sort = $('#flt-sort').value; renderRequests(); });
  $('#flt-alert-sev').addEventListener('change', renderAlertList);
  $('#flt-alert-q').addEventListener('input', renderAlertList);
  $('#flt-window').addEventListener('change', () => {
    state.filters.window = $('#flt-window').value;
    renderRequests();
    fetchLsrs().catch(() => { /* transient — next poll retries */ });
  });
  $('#flt-dist').addEventListener('change', () => {
    state.filters.dist = $('#flt-dist').value;
    if (state.filters.dist && !state.myPos) state.map.locate({ enableHighAccuracy: true, maximumAge: 30000 });
    renderRequests();
  });

  $('#flt-aged').addEventListener('click', () => { state.showAged = !state.showAged; renderRequests(); });
  $('#req-filters').hidden = localStorage.getItem('respondertx.filtersOpen') !== '1';
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
  $('#changelog-close').addEventListener('click', () => { $('#changelog-modal').hidden = true; });
  $('#changelog-modal').addEventListener('click', (e) => { if (e.target.id === 'changelog-modal') $('#changelog-modal').hidden = true; });

  $('#rs-play').addEventListener('click', toggleRadarPlay);
  $('#rs-slider').addEventListener('input', () => { stopRadarPlay(); setRadarFrame(+$('#rs-slider').value); });
  if (new URLSearchParams(location.search).get('radar') === '1') state.layers.radar.addTo(state.map);

  $('#disclaimer').addEventListener('click', (e) => {
    if (e.target.id === 'app-version') return;
    if (window.innerWidth <= 768) $('#disclaimer').classList.toggle('open');
  });

  // ops chat is a LAN-only construct: UI code (js/chat.js) loads only when the
  // local backend answers — the public mirror ships neither the file nor a route
  fetch('/api/ping').then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (d && d.chat) {
      const s = document.createElement('script');
      s.src = 'js/chat.js';
      document.body.appendChild(s);
    }
  }).catch(() => { /* no LAN backend — chat stays absent */ });
  const rainParam = new URLSearchParams(location.search).get('rain');
  if (rainParam === '1h') state.layers.mrms1h.addTo(state.map);
  else if (rainParam === '24h') state.layers.mrms24h.addTo(state.map);

  const tabParam = new URLSearchParams(location.search).get('tab');
  if (tabParam) {
    const btn = document.querySelector(`.tabs button[data-tab="tab-${tabParam}"]`);
    if (btn) btn.click();
  }

  const ok = await loadSeeds();
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
