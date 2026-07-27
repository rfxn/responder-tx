'use strict';

const APP_VERSION = 'v0.99.59';

const CONFIG = {
  // event-neutral Texas-wide fallback; data/event.json is authoritative and overrides per-event
  center: [31.0, -99.0],
  zoom: 6,
  gaugeBbox: { xmin: -106.65, ymin: 25.83, xmax: -93.4, ymax: 36.5 },
  // sub-AO quick-jump presets from data/event.json; empty = only the Full AO pill renders
  aoPresets: null,
  // NOAA CO-OPS tide stations from data/event.json (coastal events only); empty = card hidden
  tideStations: [],
  alertsUrl: 'https://api.weather.gov/alerts/active?area=TX',
  nwpsBase: 'https://api.water.noaa.gov/nwps/v1',
  fcstMaxUrl: 'https://maps.water.noaa.gov/server/rest/services/rfc/rfc_max_forecast/MapServer/0/query',
  usgsIvBase: 'https://waterservices.usgs.gov/nwis/iv/',
  // the AO needs several bBox sub-requests, and USGS publishes on a 15-minute upstream cadence,
  // so the sweep skips polls it would only waste; still well inside the 15-minute fallback trigger
  usgsMinIntervalMs: 360000,
  // WaterServices answers a tight burst of sub-requests with transient 503s, so the sweep is
  // spread out and a missed tile gets one retry rather than flagging the whole sweep partial
  usgsTileStaggerMs: 120,
  usgsRetryMs: 1500,
  refreshMs: 180000,
  // alerts-only cadence while a moving storm-based warning is open in scope; see syncAcutePoll
  acuteRefreshMs: 60000,
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
  // prediction = storm-surge residual at the tide stations configured in data/event.json tideStations
  coopBase: 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter',
  // NOAA/NHC National Storm Surge Hazard Maps (SLOSH MOM): static planning product, always
  // available; cat 5 is the near worst-case envelope. Cached PNG8 XYZ tiles (CORS-open,
  // EPSG:3857, LOD 0-14). Legend text names Category 5, keep it in sync if surgeCat changes.
  surgeCat: 5,
  surgeUrl: (cat) => `https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/Storm_Surge_HazardMaps_Category${cat}_v3/MapServer/tile/{z}/{y}/{x}`,
};

// apply data/event.json onto CONFIG (pure re CONFIG; DOM name/subtitle handled by the caller)
function applyEventConfig(ev) {
  if (!ev || typeof ev !== 'object') return;
  if (Array.isArray(ev.center) && ev.center.length === 2 && ev.center.every(Number.isFinite)) CONFIG.center = ev.center;
  if (Number.isFinite(ev.zoom)) CONFIG.zoom = ev.zoom;
  const b = ev.gaugeBbox;
  if (b && [b.xmin, b.ymin, b.xmax, b.ymax].every(Number.isFinite)) CONFIG.gaugeBbox = b;
  if (Array.isArray(ev.aoPresets)) CONFIG.aoPresets = ev.aoPresets;
  if (Array.isArray(ev.tideStations)) {
    CONFIG.tideStations = ev.tideStations.filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string');
  }
  if (typeof ev.tropicalAutoEnable === 'boolean') CONFIG.tropicalAutoEnable = ev.tropicalAutoEnable;
}

function aoFullBounds() {
  const b = CONFIG.gaugeBbox;
  return [[b.ymin, b.xmin], [b.ymax, b.xmax]];
}

function aoBoundsOk(b) {
  return Array.isArray(b) && b.length === 2 &&
    b.every((c) => Array.isArray(c) && c.length === 2 && c.every(Number.isFinite));
}

// event-config regions name themselves; the built-in residual region takes its name from i18n
const regionLabel = (p, lang) => (p.i18nKey ? t(p.i18nKey)
  : ((lang === 'es' && typeof p.labelEs === 'string') ? p.labelEs : p.label));

// the Full AO pill is not an event-config region, so it carries a reserved id of its own
const AO_FULL_ID = 'full';

// [label, bounds, id] pill list: Full AO (always first, from CONFIG.gaugeBbox) + the Texas region
// AOs. The id is language-independent, so a saved or shared AO pick survives a language switch.
function resolveAoPresets(lang) {
  const evp = (Array.isArray(CONFIG.aoPresets) ? CONFIG.aoPresets : [])
    .filter((p) => p && typeof p.label === 'string' && aoBoundsOk(p.bounds))
    .map((p) => [regionLabel(p, lang), p.bounds, typeof p.id === 'string' ? p.id : '']);
  return [[t('ao.full'), aoFullBounds(), AO_FULL_ID]].concat(evp);
}

/* ---------- region camera layers: one Leaflet group per AO region, not per source ---------- */

const CAM_REGION_PREFIX = 'camsR_';
const camRegionKey = (id) => CAM_REGION_PREFIX + id;
// ?camreg=all is the statewide form: it keeps meaning every region if the region set later grows
const CAM_REGION_ALL = 'all';
const anchorOk = (a) => Array.isArray(a) && a.length === 2 && a.every(Number.isFinite);

// regions that can carry cameras: an id, a label, and at least one anchor to assign against
function camRegions() {
  return (Array.isArray(CONFIG.aoPresets) ? CONFIG.aoPresets : []).filter((p) =>
    p && typeof p.id === 'string' && typeof p.label === 'string' &&
    Array.isArray(p.anchors) && p.anchors.some(anchorOk));
}

/* The residual bucket. Nearest-anchor alone would fold a camera 145 mi into New Mexico onto the
   Panhandle row and call it Texas, which is a silent drop wearing a region's name. Anything beyond
   CAM_REGION_MAX_MI of every anchor is named as outside the regions instead, and counted. */
const CAM_REGION_OTHER = { id: 'other', i18nKey: 'cams.region.other', band: 'outstate' };
const CAM_REGION_MAX_MI = 100;
const MI_PER_DEG_LAT = 69;

/* One bucket per neighbouring state, so an operator working the Sabine, the Red River or the Rio
   Grande can open just the side they care about. The state is read off the camera's own
   coordinates, never off a source list, so a source added upstream inherits its bucket. These
   boxes are consulted only after the Texas guard above has already rejected the point, which is
   why they may overlap Texas at the El Paso notch without ever claiming a Texas camera. */
const CAM_STATE_REGIONS = [
  { id: 'nm', i18nKey: 'cams.region.nm', band: 'outstate', bbox: [[31.33, -109.05], [37.00, -103.00]] },
  { id: 'ok', i18nKey: 'cams.region.ok', band: 'outstate', bbox: [[33.62, -103.00], [37.00, -94.43]] },
  { id: 'ar', i18nKey: 'cams.region.ar', band: 'outstate', bbox: [[33.00, -94.43], [36.50, -89.64]] },
  { id: 'la', i18nKey: 'cams.region.la', band: 'outstate', bbox: [[28.92, -94.05], [33.00, -88.75]] },
];

const inCamBbox = (lat, lon, b) => lat >= b[0][0] && lat <= b[1][0] && lon >= b[0][1] && lon <= b[1][1];

// a point no Texas region claims: name the state it sits in, or keep it in the honest residual
function camOutsideId(lat, lon) {
  for (const s of CAM_STATE_REGIONS) if (inCamBbox(lat, lon, s.bbox)) return s.id;
  return CAM_REGION_OTHER.id;
}

// nearest anchor wins; the anchor set tiles Texas, so every in-state camera lands in exactly one
// region. Longitude is scaled by cos(lat) so the comparison is real distance, not degrees.
function camRegionId(lat, lon, regions) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const kx = Math.cos((lat * Math.PI) / 180);
  let best = null, bestD = Infinity;
  for (const p of regions) {
    for (const a of p.anchors) {
      if (!anchorOk(a)) continue;
      const dy = lat - a[0], dx = (lon - a[1]) * kx;
      const d = dy * dy + dx * dx;
      if (d < bestD) { bestD = d; best = p.id; }
    }
  }
  if (best === null) return camOutsideId(lat, lon); // no usable anchors: still reachable, never dropped
  return Math.sqrt(bestD) * MI_PER_DEG_LAT > CAM_REGION_MAX_MI ? camOutsideId(lat, lon) : best;
}

// the rows/layers cameras can land in: configured regions, the state buckets, then the residual
const camRegionsAll = () => camRegions().concat(CAM_STATE_REGIONS, [CAM_REGION_OTHER]);

const CAT_RANK = { none: 0, action: 1, minor: 2, moderate: 3, major: 4 };
/* Ground-truth report types the board carries. A confirmed tornado touchdown is the single
   highest-value observation the feed offers and the flood-shaped list dropped it. Mirrored in
   scripts/gen-caltopo.py and asserted equal by tests/hazard-table.test.js. */
const LSR_HAZARD_RE = /FLOOD|HEAVY RAIN|DEBRIS|DAM |LANDSLIDE|RESCUE|TSTM WND|HIGH WIND|SURGE|WATERSPOUT|MARINE|TORNADO|FUNNEL CLOUD|HAIL|WILDFIRE|DUST STORM|SNOW SQUALL/i;
// flood-relatedness of a road closure from its description; condition==='Flooding' is handled separately
const FLOOD_ROAD_RE = /flood|high\s*water|water\s*over|low\s*water|washed?\s*out|overtopp|inundat|swept/i;
const ROAD_RE = /\b(?:FM|RM|RR|CR|SH|US|IH?|LOOP|HWY)[-\s]?\d+\b/gi;

const FLOOD_CATS = ['action', 'minor', 'moderate', 'major'];
/* NWPS taxonomy: five chromatic severities, then three greyscale degraded states. One list, because
   a gauge the board cannot read is a fact about the river, not a footnote. */
const GAUGE_DEGRADED = ['nothresh', 'stale', 'oos'];
const GAUGE_STATES = ['major', 'moderate', 'minor', 'action', 'none'].concat(GAUGE_DEGRADED);
const NWPS_DEGRADED_CAT = { not_defined: 'nothresh', obs_not_current: 'stale', out_of_service: 'oos' };
const catLabel = (cat) => t('cat.' + cat);
const gaugeStateLabel = (s) => (GAUGE_DEGRADED.includes(s) ? t('gstate.' + s) : catLabel(s));
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
  recoveryCrest: null, // last crest-summary payload; the open recovery view re-renders from it as live data lands
  basinCrest: null, // crest-summary payload for the basin view; re-renders as live data lands
  basinRiver: null, // selected river slug in the basin view (share round-trip carries it)
  alerts: [],
  gauges: [],
  // degraded gauges NWPS reports without a usable severity. Kept out of state.gauges on purpose:
  // every count, threat chip and tile reads state.gauges, so a dead sensor can never reach one.
  gaugesDegraded: [],
  gaugeFilter: null, // legend filter set; null until loadGaugeFilter() runs
  fcstMax: [],
  usgsSites: [],
  usgsFetchedAt: 0,
  usgsPartial: false, // true when a tiled sweep came back short; blocks the healthy stamp
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
  showRecovery: false,
  roadMemory: null,
  roadsTabFp: null, // last Roads-tab render fingerprint; an unchanged list must not reset the scroll
  roadsFallbackAt: null, // snapshot `generated` epoch while the committed fallback is serving, else null
  roadsUnknown: false, // live feed failed AND no snapshot: the closure set is unknown, never "none"
  lwcPartial: false, // true when the crossing inventory hit the paging ceiling with records left
  showAlertHist: false,
  showAlertsFar: false, // the alerts outside the current proximity scope are folded, never dropped
  tickerExpiryTimer: null, // fires at the soonest acute end so a 23-minute warning is not asserted for 3 more
  acuteAlertTimer: null, // 60s alerts-only poll, armed only while an acute product is open in scope
  showNormalGauges: false,
  showDegradedGauges: false,
  gaugeGroup: 'priority',
  inView: false,
  lanIntake: false, // LAN server advertises POST /api/requests — intakes also share board-wide
  camGen: 0,
  tropicalAutoDone: false, // set once the tropical tracker has been auto-enabled or manually toggled off
  xstatusAutoDone: false, // same for the jurisdiction crossing layer, which enables itself only on a confirmable change
  tides: null, // coastal water-level rows (NOAA CO-OPS); null until first Resources-tab open, then per-station
  tidesAt: 0,
  tidesLoading: false,

  lsCamOpen: new Set(), // camera sub-groups expanded this session (ephemeral, not persisted)
  lsBulk: false, // a parent toggle is mid-flight: repaint once at the end, not once per child layer
  offDepth: null, // extra zoom levels an offline save covers; read from storage on first use
  viewReady: false, // boot restore and URL params are done: only now does a change mean the user made it
};

const PRI_WEIGHT = { critical: 8, high: 4, medium: 2, low: 1 };

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// coerce trusted-gov feed numbers before innerHTML — a non-numeric value falls back to an escaped string
const fmtNum = (v) => (Number.isFinite(+v) ? +v : esc(String(v)));
// esc() blocks attribute-breakout but not javascript:/data: schemes — gate hrefs to http(s)
const safeUrl = (u) => (/^https?:\/\//i.test(String(u)) ? String(u) : '#');
// safeUrl covers no tel: scheme; curator values are rebuilt digit-wise, never interpolated. '' = render as text
const TEL_SHAPE = /^\+?[0-9(][0-9\s().-]*$/;
const telHref = (v) => {
  const raw = String(v ?? '').trim();
  if (!TEL_SHAPE.test(raw)) return '';
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length < 3 || digits.length > 15) return ''; // 3 = shortest US short code (911), 15 = E.164 ceiling
  return `tel:${raw.charAt(0) === '+' ? '+' : ''}${digits}`;
};
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
// feed-chip freshness: dot class + age text; a source that has never loaded says so instead of staying blank
function chipHealth(ts, now) {
  if (!ts) return { cls: 'stale', txt: ` · ${t('health.nodata')}` };
  const age = (now - ts) / 60000;
  return { cls: age < 10 ? 'fresh' : age < 30 ? 'aging' : 'stale', txt: ` ${Math.round(age)}m` };
}
// shared by bearing() and by the storm-motion read in sources.js, which loads before panels.js
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function distMi(lat1, lon1, lat2, lon2) {
  const R = 3958.8, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* USGS WaterServices rejects a bBox larger than 25 equator-equivalent square degrees:
   width x height x cos(latitude nearest the equator). Measured against the live service
   2026-07-26; the server's own 400 body states the same rule. See INTERNAL-NOTES.md. */
const USGS_BBOX_LIMIT = 25;
const USGS_BBOX_BUDGET = 18;
// more tiles than this means a misconfigured AO, not a wider board; cycle-check fails on it
const USGS_BBOX_MAX_TILES = 24;

function usgsBboxCost(b) {
  if (!b || ![b.xmin, b.ymin, b.xmax, b.ymax].every(Number.isFinite)) return Infinity;
  const w = Math.abs(b.xmax - b.xmin), h = Math.abs(b.ymax - b.ymin);
  // a degree of longitude is widest nearest the equator, so that edge binds the whole box
  const lat = b.ymin <= 0 && b.ymax >= 0 ? 0 : Math.min(Math.abs(b.ymin), Math.abs(b.ymax));
  return w * h * Math.cos((lat * Math.PI) / 180);
}

// split a bbox into the fewest near-square tiles that each stay under budget
function usgsBboxTiles(b, budget) {
  const cap = budget || USGS_BBOX_BUDGET;
  const cost = usgsBboxCost(b);
  if (!Number.isFinite(cost) || cost <= 0) return [];
  const x0 = Math.min(b.xmin, b.xmax), y0 = Math.min(b.ymin, b.ymax);
  const w = Math.abs(b.xmax - b.xmin), h = Math.abs(b.ymax - b.ymin);
  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  const base = Math.max(1, Math.ceil(cost / cap));
  // a split landing exactly on the budget can be tipped over it by the 5dp edge rounding below
  for (let need = base; need < base + 4; need++) {
    let best = null;
    for (let nx = 1; nx <= need; nx++) {
      const ny = Math.ceil(need / nx);
      const skew = Math.abs(w / nx - h / ny);
      const better = !best || nx * ny < best.nx * best.ny || (nx * ny === best.nx * best.ny && skew < best.skew);
      if (better) best = { nx, ny, skew };
    }
    const tiles = [];
    for (let i = 0; i < best.nx; i++) {
      for (let j = 0; j < best.ny; j++) {
        tiles.push({
          xmin: r5(x0 + (w * i) / best.nx), ymin: r5(y0 + (h * j) / best.ny),
          xmax: r5(x0 + (w * (i + 1)) / best.nx), ymax: r5(y0 + (h * (j + 1)) / best.ny),
        });
      }
    }
    if (tiles.every((tl) => usgsBboxCost(tl) <= cap)) return tiles;
  }
  return []; // unreachable in practice; an empty split makes fetchUsgsIv throw rather than guess
}

// overlapping tile edges can return the same site twice; first sweep to name it wins
function usgsMergeSites(lists) {
  const bySite = new Map();
  for (const list of lists) for (const s of list) if (!bySite.has(s.site)) bySite.set(s.site, s);
  return [...bySite.values()];
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

/* Legend filter. Degraded rows default ON, the deliberate inverse of the NWPS default: they hide
   theirs because 9.8% of 12,222 national gauges is map noise, ours is ~29% of ~290 in one AO and
   hiding a dead sensor is the failure the aging rules exist to prevent. */
const GAUGE_FILTER_KEY = 'respondertx.gaugeFilter.v1';
function defaultGaugeFilter() {
  const f = {};
  for (const s of GAUGE_STATES) f[s] = true;
  return f;
}
function loadGaugeFilter() {
  const f = defaultGaugeFilter();
  let saved;
  try { saved = JSON.parse(localStorage.getItem(GAUGE_FILTER_KEY) || 'null'); } catch { saved = null; }
  if (saved) for (const s of GAUGE_STATES) if (typeof saved[s] === 'boolean') f[s] = saved[s];
  state.gaugeFilter = f;
  return f;
}
function saveGaugeFilter() {
  try { localStorage.setItem(GAUGE_FILTER_KEY, JSON.stringify(state.gaugeFilter)); } catch { /* quota — the filter is best-effort */ }
}
const gaugeStateShown = (s) => !state.gaugeFilter || state.gaugeFilter[s] !== false;

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
    // endsAt is the hazard's end, always written (null = declared no end) so a stored row is readable without the VTEC
    state.hist.alerts[f.id] = { t: p.sent || p.effective || new Date().toISOString(), sev: f._sev, event: p.event, areaDesc: p.areaDesc, expires: p.expires, endsAt: alertEndsAt(f) };
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

/* ---------- on-demand assets ----------
   A one-bar visit should not pay for a surface it never opens, so the heavy optional libraries
   (hls.js, qrcode, the team client) load on first use instead of on every page load. Memoized by
   URL so concurrent callers share one request; a rejection drops the memo so the next tap retries.
   Stamped like every other asset, which is what lets the service worker cache it after one fetch. */

const assetUrl = (path) => `${path}?v=${APP_VERSION.replace(/^v/, '')}`;

const lazyAssets = Object.create(null);

function loadAssetOnce(url, kind) {
  if (lazyAssets[url]) return lazyAssets[url];
  const pending = new Promise((resolve, reject) => {
    const el = document.createElement(kind === 'css' ? 'link' : 'script');
    el.onload = () => resolve(url);
    el.onerror = () => reject(new Error(`asset failed to load: ${url}`));
    if (kind === 'css') { el.rel = 'stylesheet'; el.href = url; document.head.appendChild(el); }
    else { el.src = url; document.body.appendChild(el); }
  });
  lazyAssets[url] = pending.catch((err) => { delete lazyAssets[url]; throw err; });
  return lazyAssets[url];
}

const ensureQrcode = () => (typeof qrcode === 'function'
  ? Promise.resolve(true)
  : loadAssetOnce(assetUrl('js/vendor/qrcode.min.js')).then(() => typeof qrcode === 'function'));

/* Shared QR painter for the Share sheet, the CalTopo box, and the team invite. The library is
   lazy, so an offline first use has nothing to draw with: say that in the box rather than
   collapsing it, because a blank space reads as "this view has no QR" instead of "not loaded". */
function renderQrCode(host, url, margin) {
  if (!host || host.dataset.done) return;
  host.dataset.qrurl = url;
  const paint = () => {
    if (host.dataset.qrurl !== url) return; // the view moved on while the library was in flight
    try {
      const qr = qrcode(0, 'M'); // typeNumber 0 = auto-size for the URL length
      qr.addData(url);
      qr.make();
      host.innerHTML = qr.createSvgTag({ cellSize: 4, margin, scalable: true });
      host.dataset.done = '1';
    } catch { host.hidden = true; }
  };
  if (typeof qrcode === 'function') { paint(); return; }
  const failNote = () => {
    if (host.dataset.qrurl !== url) return;
    host.innerHTML = `<div class="qr-note">${esc(t('qr.fail'))}</div>`;
  };
  host.hidden = false;
  host.innerHTML = `<div class="qr-note">${esc(t('qr.loading'))}</div>`;
  ensureQrcode().then((ok) => { if (ok) paint(); else failNote(); }).catch(failNote);
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

