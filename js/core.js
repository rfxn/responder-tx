'use strict';

const APP_VERSION = 'v0.97.36';

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
  // throttle window for the heavy hazard re-rank; a continuous watch feeds the marker + follow glide every fix
  driveLocateMs: 10000,
  // zoom a deliberate locate (⌖ / re-center / follow engage) snaps to, if not already closer
  locateZoom: 14,
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
  reopenedAgeHours: 12,
  lsrHours: 12,
  // hard live-map cap: a storm report older than this ages out of the live layer into lsrsAged, even if the window filter is wider
  lsrMaxHours: 24,
  lsrUrl: 'https://mesonet.agron.iastate.edu/geojson/lsr.geojson',
  // TDEM DriveTexas live road-hazard lines (CORS-open, no key). Full-word conditions, ISO-8601 timestamps.
  roadCondUrl: 'https://services5.arcgis.com/Rvw11bGpzJNE7apK/arcgis/rest/services/DriveTexas_API/FeatureServer/0/query',
  // TxGIO low-water-crossing location inventory (CORS-open, no key). Static locations, no live status.
  lwcUrl: 'https://feature.geographic.texas.gov/arcgis/rest/services/Basemap/Low_Water_Crossing/MapServer/0/query',
  rainviewerApi: 'https://api.rainviewer.com/public/weather-maps.json',
  // NOAA HRRR model reflectivity WMS (probed 2026-07-19): one layer per forecast minute (refd_0060…),
  // no TIME dim — layers always serve the latest run; run stamp via the per-layer metadata JSON
  hrrrWmsUrl: 'https://mesonet.agron.iastate.edu/cgi-bin/wms/hrrr/refd.cgi',
  hrrrMetaUrl: (min) => `https://mesonet.agron.iastate.edu/data/gis/images/4326/hrrr/refd_${String(min).padStart(4, '0')}.json`,
  // hourly layers ≤18h track the latest hourly run; beyond 18h IEM falls back to the older synoptic run — mixing runs in one scrub would lie
  hrrrMaxHours: 18,
  // IEM MRMS accumulation windows probed live 2026-07-18: these four serve tiles; 3h/6h/12h do not exist
  mrmsWindows: ['1h', '24h', '48h', '72h'],
  mrmsUrl: (w) => `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/q2-${w === '1h' ? 'n1p' : `p${w}`}-900913/{z}/{x}/{y}.png`,
  // NWPS/NWM Analysis-and-Assimilation flood inundation extent (experimental, hourly). Layer 0
  // draws only at street scale (< ~1:400k, z≈11+). MODELED estimate, not observed — labelled as such.
  inunExportUrl: 'https://maps.water.noaa.gov/server/rest/services/nwm/ana_inundation_extent/MapServer/export?bboxSR=3857&imageSR=3857&size=256,256&dpi=96&layers=show:0&format=png32&transparent=true&f=image',
};

const CAT_RANK = { none: 0, action: 1, minor: 2, moderate: 3, major: 4 };
const LSR_FLOOD_RE = /FLOOD|HEAVY RAIN|DEBRIS|DAM |LANDSLIDE|RESCUE/i;
// flood-relatedness of a road closure from its description; condition==='Flooding' is handled separately
const FLOOD_ROAD_RE = /flood|high\s*water|water\s*over|low\s*water|washed?\s*out|overtopp|inundat|swept/i;
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
  locWatch: false, // true while one continuous geolocation watch is registered (nav-app follow feed)
  driveFixAt: 0,
  driveRankAt: 0, // last heavy re-rank; the marker + glide still update on every fix
  centerNextFix: false, // deliberate locates center once; periodic ticks never move the map
  followMe: false, // nav-app follow: buttons engage it, a manual pan/zoom exits it
  _progMove: false, // true during our own setView so a follow-driven move never self-exits follow
  _progMoveT: null,
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
  showAgedReopened: false,
  roadMemory: null,
  showAlertHist: false,
  showNormalGauges: false,
  gaugeGroup: 'priority',
  inView: false,
  camGen: 0,
  lsCamOpen: new Set(), // camera sub-groups expanded this session (ephemeral, not persisted)
};

const PRI_WEIGHT = { critical: 8, high: 4, medium: 2, low: 1 };

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// coerce trusted-gov feed numbers before innerHTML — a non-numeric value falls back to an escaped string
const fmtNum = (v) => (Number.isFinite(+v) ? +v : esc(String(v)));
// esc() blocks attribute-breakout but not javascript:/data: schemes — gate hrefs to http(s)
const safeUrl = (u) => (/^https?:\/\//i.test(String(u)) ? String(u) : '#');
// compact citation label — bare domain for the source link, never the full raw URL
const hostOf = (u) => { try { return new URL(String(u)).hostname.replace(/^www\./, ''); } catch { return ''; } };
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// provenance badge: OFFICIAL = machine-fed authoritative feed, CURATED = operator-maintained
const srcBadge = (kind, extraCls) =>
  `<span class="badge src-${kind}${extraCls ? ` ${extraCls}` : ''}" title="${esc(t(`src.${kind}.title`))}">${esc(t(`src.${kind}`))}</span>`;

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

function inMapView(lat, lon) {
  return !!state.map && Number.isFinite(lat) && Number.isFinite(lon)
    && state.map.getBounds().contains([lat, lon]);
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
    if (!f.geometry || !Array.isArray(f.geometry.coordinates)) continue;
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

