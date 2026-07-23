'use strict';

const APP_VERSION = 'v0.97.47';

const CONFIG = {
  center: [29.5, -95.1],
  zoom: 8,
  // Upper/mid Texas coast (Matagorda to Sabine, inland to Houston/Beaumont) for TS Bertha; data/event.json
  // overrides this per-event. Pivoted 2026-07-23 from the Hill Country box; revert both when the event clears
  gaugeBbox: { xmin: -98.0, ymin: 27.5, xmax: -93.4, ymax: 31.0 },
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
};

const CAT_RANK = { none: 0, action: 1, minor: 2, moderate: 3, major: 4 };
const LSR_FLOOD_RE = /FLOOD|HEAVY RAIN|DEBRIS|DAM |LANDSLIDE|RESCUE|TSTM WND|HIGH WIND|SURGE|WATERSPOUT|MARINE/i;
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

