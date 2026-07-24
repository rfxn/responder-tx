'use strict';

const APP_VERSION = 'v0.97.73';

const CONFIG = {
  center: [29.5, -95.1],
  zoom: 8,
  // Upper/mid Texas coast (Matagorda to Sabine, inland to Houston/Beaumont) for TS Bertha; data/event.json
  // overrides this per-event. Pivoted 2026-07-23 from the Hill Country box; revert both when the event clears
  gaugeBbox: { xmin: -98.0, ymin: 27.5, xmax: -93.4, ymax: 31.0 },
  // sub-AO quick-jump presets; data/event.json aoPresets overrides per-event (null = built-in fallback)
  aoPresets: null,
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
  // NOAA NHC active tropical cyclones via Esri Living Atlas (CORS *, keyless, native GeoJSON). Sublayers are
  // global (all active storms); off-map storms simply do not draw. 0 fcst pos, 1 obs pos, 2 fcst track, 3 obs track, 4 error cone, 5 watches/warnings
  tropicalBase: 'https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/Active_Hurricanes_v1/FeatureServer',
  // default the tropical tracker layer ON when TX has an active tropical/hurricane warning or watch
  tropicalAutoEnable: true,
  rainviewerApi: 'https://api.rainviewer.com/public/weather-maps.json',
  // NOAA HRRR model reflectivity WMS (probed 2026-07-19): one layer per forecast minute (refd_0060…),
  // no TIME dim — layers always serve the latest run; run stamp via the per-layer metadata JSON
  hrrrWmsUrl: 'https://mesonet.agron.iastate.edu/cgi-bin/wms/hrrr/refd.cgi',
  hrrrMetaUrl: (min) => `https://mesonet.agron.iastate.edu/data/gis/images/4326/hrrr/refd_${String(min).padStart(4, '0')}.json`,
  // hourly layers ≤12h track the latest hourly run; beyond that IEM falls back to the older synoptic run — mixing runs in one scrub would lie
  hrrrMaxHours: 12,
  // merge the observed-radar + HRRR-forecast toggles into one "Radar & forecast" feature (one scrub, one legend)
  wxUnified: true,
  // IEM MRMS accumulation windows probed live 2026-07-18: these four serve tiles; 3h/6h/12h do not exist
  mrmsWindows: ['1h', '24h', '48h', '72h'],
  mrmsUrl: (w) => `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/q2-${w === '1h' ? 'n1p' : `p${w}`}-900913/{z}/{x}/{y}.png`,
  // NWPS/NWM Analysis-and-Assimilation flood inundation extent (experimental, hourly). Layer 0
  // draws only at street scale (< ~1:400k, z≈11+). MODELED estimate, not observed — labelled as such.
  inunExportUrl: 'https://maps.water.noaa.gov/server/rest/services/nwm/ana_inundation_extent/MapServer/export?bboxSR=3857&imageSR=3857&size=256,256&dpi=96&layers=show:0&format=png32&transparent=true&f=image',
  // NOAA CO-OPS Tides & Currents datagetter (CORS *, keyless). Observed water level vs same-timestamp
  // prediction = storm-surge residual at the coastal tide stations; upper/central TX coast seed in sources.js
  coopBase: 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter',
  // NOAA/NHC National Storm Surge Hazard Maps (SLOSH MOM): static planning product, always
  // available; cat 5 is the near worst-case envelope. Cached PNG8 XYZ tiles (CORS-open,
  // EPSG:3857, LOD 0-14). Legend text names Category 5, keep it in sync if surgeCat changes.
  surgeCat: 5,
  surgeUrl: (cat) => `https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/Storm_Surge_HazardMaps_Category${cat}_v3/MapServer/tile/{z}/{y}/{x}`,
};

// last-resort sub-AO pills when data/event.json carries no aoPresets (Hill Country, July 2026 event)
const AO_PRESET_FALLBACK = [
  ['Kerr/Guadalupe', [[29.85, -99.6], [30.2, -98.9]]],
  ['Uvalde/Frio-Nueces', [[28.9, -100.1], [29.6, -99.4]]],
  ['Val Verde/Pecos', [[29.3, -101.9], [30.35, -100.8]]],
  ['Sonora/Ozona', [[30.3, -101.4], [30.95, -100.3]]],
  ['Cibolo corridor', [[28.9, -98.4], [29.4, -97.9]]],
];

function aoFullBounds() {
  const b = CONFIG.gaugeBbox;
  return [[b.ymin, b.xmin], [b.ymax, b.xmax]];
}

function aoBoundsOk(b) {
  return Array.isArray(b) && b.length === 2 &&
    b.every((c) => Array.isArray(c) && c.length === 2 && c.every(Number.isFinite));
}

// [label, bounds] pill list: Full AO (always first, from CONFIG.gaugeBbox) + event sub-AOs or fallback
function resolveAoPresets(lang) {
  const evp = (Array.isArray(CONFIG.aoPresets) ? CONFIG.aoPresets : [])
    .filter((p) => p && typeof p.label === 'string' && aoBoundsOk(p.bounds))
    .map((p) => [(lang === 'es' && typeof p.labelEs === 'string') ? p.labelEs : p.label, p.bounds]);
  return [[t('ao.full'), aoFullBounds()]].concat(evp.length ? evp : AO_PRESET_FALLBACK);
}

const CAT_RANK = { none: 0, action: 1, minor: 2, moderate: 3, major: 4 };
const LSR_FLOOD_RE = /FLOOD|HEAVY RAIN|DEBRIS|DAM |LANDSLIDE|RESCUE|TSTM WND|HIGH WIND|SURGE|WATERSPOUT|MARINE/i;
// flood-relatedness of a road closure from its description; condition==='Flooding' is handled separately
const FLOOD_ROAD_RE = /flood|high\s*water|water\s*over|low\s*water|washed?\s*out|overtopp|inundat|swept/i;
const ROAD_RE = /\b(?:FM|RM|RR|CR|SH|US|IH?|LOOP|HWY)[-\s]?\d+\b/gi;

const FLOOD_CATS = ['action', 'minor', 'moderate', 'major'];
const catLabel = (cat) => t('cat.' + cat);
// data-enum → localized label; unknown values fall back to the raw enum so nothing renders as a bare key
const enumLabel = (prefix, v) => { const k = prefix + v, s = t(k); return s === k ? String(v) : s; };
const ntypeLabel = (v) => enumLabel('ntype.', v);
const priLabel = (v) => enumLabel('pri.', v);
const nstatLabel = (v) => enumLabel('nstat.', v);
const catWord = (cat) => (cat === 'none' ? t('cat.none').toLowerCase() : t('catw.' + cat));
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
  sheltersLive: null, // data/shelters-live.json payload (FEMA NSS poller); null until first successful load
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
  posMarker: null, // persistent YOU marker; watch fixes move it in place, deliberate locates re-trigger its finite pulse
  posAccuracy: null, // persistent accuracy circle; moved in place on every fix
  recenterDrawer: null, // transient re-center hint anchored beside the ⌖ button
  recenterHintOn: false, // guard: one hint flash per manual exit-from-follow, never a loop
  recenterHintT: null,
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
  showMonitors: false,
  showRecovery: false,
  roadMemory: null,
  showAlertHist: false,
  showNormalGauges: false,
  gaugeGroup: 'priority',
  inView: false,
  camGen: 0,
  tropicalAutoDone: false, // set once the tropical tracker has been auto-enabled or manually toggled off
  tides: null, // coastal water-level rows (NOAA CO-OPS); null until first Resources-tab open, then per-station
  tidesAt: 0,
  tidesLoading: false,

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

/* ---------- screen wake lock: refcounted sentinel shared by team-sharing + Drive Mode ---------- */

// Held while any reason is active; released when the reason set empties. The spec auto-releases the
// sentinel on tab-hide, so keepAwakeResume() re-requests on return. No-op without Wake Lock support
// or a secure context (older iOS, plain-http LAN :8080), and a rejected request never throws.
const _wakeReasons = new Set();
let _wakeSentinel = null;
let _wakeAcquiring = false;

async function _wakeAcquire() {
  if (_wakeSentinel || _wakeAcquiring || !_wakeReasons.size || !('wakeLock' in navigator)) return;
  _wakeAcquiring = true;
  try {
    const s = await navigator.wakeLock.request('screen');
    if (!_wakeReasons.size) { s.release().catch(() => { /* every reason cleared mid-request; drop it */ }); return; }
    _wakeSentinel = s;
    s.addEventListener('release', () => { if (_wakeSentinel === s) _wakeSentinel = null; });
  } catch { /* rejected while hidden or not allowed; a later resume retries */ }
  finally { _wakeAcquiring = false; }
}

function _wakeRelease() {
  const s = _wakeSentinel;
  _wakeSentinel = null;
  if (s) s.release().catch(() => { /* already released by the UA */ });
}

function keepAwake(on, reason) {
  if (on) _wakeReasons.add(reason); else _wakeReasons.delete(reason);
  if (_wakeReasons.size) _wakeAcquire(); else _wakeRelease();
}

function keepAwakeResume() {
  if (document.visibilityState === 'visible') _wakeAcquire();
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

const shelterKey = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function shelterDup(a, b) {
  const ka = shelterKey(a.name), kb = shelterKey(b.name);
  if (ka && kb && (ka === kb || (ka.length >= 6 && kb.length >= 6 && (ka.includes(kb) || kb.includes(ka))))) return true;
  return Number.isFinite(a.lat) && Number.isFinite(a.lon) && Number.isFinite(b.lat) && Number.isFinite(b.lon)
    && distMi(a.lat, a.lon, b.lat, b.lon) < 0.3;
}

// live NSS entries win over curated duplicates (name match or <0.3 mi proximity); live first
function mergeShelters(curated, live) {
  const liveList = (Array.isArray(live) ? live : []).filter((s) => s && s.name);
  const kept = (Array.isArray(curated) ? curated : []).filter((c) => c && !liveList.some((s) => shelterDup(s, c)));
  return liveList.map((s) => Object.assign({ live: true }, s)).concat(kept);
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
  const rel = (mins >= 0 ? t('when.ago') : t('when.in')).replace('{s}', span);
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

/* ---------- modal a11y — one MutationObserver-driven focus-trap + inert background for every overlay.
   Overlays toggle via the `hidden` attribute; registerModal watches that and drives trap/inert/focus,
   so no bespoke open/close site is edited. This helper NEVER handles Escape — Escape stays centralized
   in boot.js so the 911 safety gate keeps its single close path (#safety-ack). ---------- */

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const modalStack = []; // {el, focusEl, opts} bottom→top; last is topmost
let savedTrigger = null; // element focused before the stack went empty→non-empty

// last element focused OUTSIDE any registered modal — the true restore target even when a modal
// (e.g. #sitrep-modal) moves focus into itself synchronously before its observer fires
let lastFocusOutsideModals = document.body;
document.addEventListener('focusin', (e) => {
  if (e.target && e.target.closest && !e.target.closest('[data-modal-registered]')) lastFocusOutsideModals = e.target;
}, true);

const modalIsFocusableVisible = (n) =>
  !!(n && (n.offsetWidth || n.offsetHeight || (n.getClientRects && n.getClientRects().length)));

function modalFocusables(scope) {
  return Array.from(scope.querySelectorAll(FOCUSABLE)).filter(modalIsFocusableVisible);
}

// wrap index for Tab/Shift-Tab within a modal; -1 when nothing focusable, 0 when a single focusable pins
function modalCycleIndex(count, current, shift) {
  if (count <= 0) return -1;
  if (count === 1) return 0;
  if (current < 0) return 0;
  if (shift) return current === 0 ? count - 1 : current - 1;
  return current === count - 1 ? 0 : current + 1;
}

// topmost open modal stays live; every other body child is inert (keyboard/pointer) + aria-hidden (SR)
function refreshInert() {
  const topEl = modalStack.length ? modalStack[modalStack.length - 1].el : null;
  for (const node of Array.from(document.body.children)) {
    if (node.tagName === 'SCRIPT') continue;
    if (topEl && node !== topEl) {
      node.setAttribute('inert', '');
      node.setAttribute('aria-hidden', 'true');
      node.dataset.modalInert = '1';
    } else if (node.dataset.modalInert) {
      node.removeAttribute('inert');
      node.removeAttribute('aria-hidden');
      delete node.dataset.modalInert;
    }
  }
}

function onModalShow(el, opts) {
  if (modalStack.some((m) => m.el === el)) return;
  const focusEl = opts.focusEl ? (el.querySelector(opts.focusEl) || el) : el;
  if (!modalStack.length) savedTrigger = el.contains(document.activeElement) ? lastFocusOutsideModals : document.activeElement;
  modalStack.push({ el, focusEl, opts });
  refreshInert();
  if (el.contains(document.activeElement)) return; // modal set its own focus (sitrep/risk) — don't fight it
  let target = opts.initialFocus ? el.querySelector(opts.initialFocus) : null;
  if (!target || !modalIsFocusableVisible(target)) target = modalFocusables(focusEl)[0];
  if (target && typeof target.focus === 'function') target.focus();
}

function onModalHide(el) {
  const i = modalStack.findIndex((m) => m.el === el);
  if (i === -1) return;
  modalStack.splice(i, 1);
  refreshInert();
  if (!modalStack.length) {
    if (savedTrigger && typeof savedTrigger.focus === 'function') savedTrigger.focus();
    else if (document.body.focus) document.body.focus();
    savedTrigger = null;
  } else {
    const top = modalStack[modalStack.length - 1];
    if (!top.el.contains(document.activeElement)) { const f = modalFocusables(top.focusEl)[0]; if (f) f.focus(); }
  }
}

// opts.initialFocus = selector to focus on open; opts.focusEl = sub-element to trap within (default el)
function registerModal(el, opts = {}) {
  if (!el || el.dataset.modalRegistered) return; // idempotent: build fns may re-run
  el.dataset.modalRegistered = '1';
  new MutationObserver(() => { if (el.hidden) onModalHide(el); else onModalShow(el, opts); })
    .observe(el, { attributes: true, attributeFilter: ['hidden'] });
  if (!el.hidden) onModalShow(el, opts); // registered while already open
}

// keep Tab within the topmost modal; deliberately Tab-only — Escape is owned by boot.js
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !modalStack.length) return;
  const top = modalStack[modalStack.length - 1];
  const f = modalFocusables(top.focusEl);
  if (!f.length) { e.preventDefault(); return; }
  const cur = top.focusEl.contains(document.activeElement) ? f.indexOf(document.activeElement) : -1;
  const next = modalCycleIndex(f.length, cur, e.shiftKey);
  if (next === cur && f.length > 1) return; // mid-list Tab — let the browser advance naturally
  e.preventDefault();
  f[next].focus();
}, true);

