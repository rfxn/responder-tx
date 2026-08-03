'use strict';

/*
 * Non-invasive loader for the board's classic (non-module) browser scripts.
 *
 * The app ships js/*.js as plain <script> files that share one global scope in
 * the browser. Here we read those files verbatim (never edit them), concatenate
 * the ones whose pure functions we exercise, and run the combined source once in
 * a Node `vm` sandbox stocked with just enough mock browser globals for the
 * top-level declarations to evaluate. A small appended epilogue copies the
 * symbols under test onto the sandbox global so the tests can reach them.
 *
 * Only declarations run at load time (verified: these files have no top-level
 * executable statements), so DOM/Leaflet mocks stay minimal — the only load-time
 * browser touch is `document.title` in core.js's state object.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const JS_DIR = path.join(__dirname, '..', 'js');

function read(file) {
  return fs.readFileSync(path.join(JS_DIR, file), 'utf8');
}

// Minimal stand-ins. Anything a loaded function actually invokes in these tests
// is real; the rest exist only so top-level evaluation does not throw.
function makeElementStub() {
  const el = {
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    dataset: {},
    options: [],
    value: '',
    textContent: '',
    innerHTML: '',
    title: '',
    hidden: false,
    checked: false,
    disabled: false,
    appendChild() {}, append() {}, prepend() {}, remove() {}, add() {}, insertAdjacentHTML() {},
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return ''; }, removeAttribute() {}, hasAttribute() { return false; },
    querySelector() { return makeElementStub(); },
    querySelectorAll() { return []; },
    getElement() { return null; },
    dispatchEvent() { return true; },
    closest() { return null; },
    scrollIntoView() {}, focus() {}, blur() {}, click() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; },
  };
  return el;
}

function buildSandbox() {
  // load-time document listeners are kept, not dropped: the modal focus trap is one of them
  const docHandlers = new Map();
  const documentStub = {
    title: '',
    readyState: 'loading', // classic scripts evaluate before DOMContentLoaded; notes.js branches on this

    querySelector() { return makeElementStub(); },
    querySelectorAll() { return []; },
    createElement() { return makeElementStub(); },
    getElementById() { return makeElementStub(); },
    addEventListener(type, fn) {
      if (!docHandlers.has(type)) docHandlers.set(type, []);
      docHandlers.get(type).push(fn);
    },
    documentElement: {
      getAttribute() { return ''; },
      setAttribute() {},
      style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } },
    },
    body: makeElementStub(),
  };

  const makeStorage = () => {
    const cell = new Map();
    return {
      getItem(k) { return cell.has(k) ? cell.get(k) : null; },
      setItem(k, v) { cell.set(k, String(v)); },
      removeItem(k) { cell.delete(k); },
      clear() { cell.clear(); },
    };
  };

  // Leaflet stub — recursive so load-time chains (L.TileLayer.extend({...})) resolve too.
  const L = new Proxy(function () {}, {
    get(target, key) { return key === Symbol.toPrimitive ? () => 'L-stub' : L; },
    apply() { return L; },
    construct() { return L; },
  });

  const sandbox = {
    console,
    Math, Date, JSON, RegExp, Array, Object, String, Number, Boolean, Map, Set,
    parseInt, parseFloat, isNaN, isFinite,
    URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise,
    document: documentStub,
    window: {},
    // window.* is the sandbox itself (see below); js/bootfloor.js binds load/error here
    addEventListener() {}, removeEventListener() {},
    navigator: { clipboard: null, share: null, geolocation: null },
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    MutationObserver: function MutationObserver() {
      return { observe() {}, disconnect() {}, takeRecords() { return []; } };
    },
    location: { origin: 'https://example.test', pathname: '/', search: '' },
    getComputedStyle() { return { getPropertyValue() { return ''; } }; },
    CSS: { escape: (v) => String(v).replace(/(["'\\\]])/g, '\\$1') }, // reveal selectors are built with it
    Event: function Event(type) { this.type = type; },
    Option: function Option(text, value) { this.text = text; this.value = value; },
    fetch() { return Promise.reject(new Error('network disabled in tests')); },
    t(key) { return key; }, // i18n.js is not loaded; key-echo keeps t()-calling helpers exercisable
    getLang() { return 'en'; }, // same reason: i18n.js publishes it and map.js calls it at init
    L,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__docHandlers = docHandlers;
  // deferred through sandbox.setTimeout so a test that replaces the clock also owns the frame
  sandbox.requestAnimationFrame = (fn) => sandbox.setTimeout(fn, 0);
  sandbox.cancelAnimationFrame = (id) => sandbox.clearTimeout(id);
  return sandbox;
}

// Symbols exercised by the tests. Some are `const`/arrow (lexical, not on the
// global object), so the epilogue must name them explicitly to export them.
const EXPORTS = [
  'APP_VERSION', 'CONFIG', 'state', 'FLOOD_CATS', 'CAT_RANK', 'PRI_WEIGHT', 't',
  'AO_FULL_ID', 'assetUrl',
  'esc', 'fmtNum', 'safeUrl', 'telHref', 'ageMins', 'distMi', 'freshClass',
  'usgsBboxCost', 'usgsBboxTiles', 'usgsMergeSites', 'fetchUsgsIv',
  'USGS_BBOX_LIMIT', 'USGS_BBOX_BUDGET', 'USGS_BBOX_MAX_TILES',
  'modalCycleIndex', 'modalIsFocusableVisible',
  'toUSNG',
  'alertReach', 'alertSeverity', 'alertOpen', 'emergencyBannerMode', 'alertNearPoint',
  'alertEndsAt', 'alertEnded', 'alertVtecEnds', 'VTEC_NO_END', 'alertUntilText', 'histAlertEnd',
  'ALERT_SEV_RANK', 'ALERT_SEV_UNKNOWN', 'alertSevRank', 'alertSevCmp',
  'aoStates', 'alertAreaParts', 'alertAreaText', 'alertAreaLead',
  'geoBounds', 'mergeBounds', 'geoDistMi', 'geoInView', 'geomInScope', 'ptInScope',
  'alertGeom', 'alertAreaPlaces', 'alertDistPts', 'alertScope', 'alertScopeSrc',
  'alertNear', 'alertGroups', 'alertDistChip', 'ALERT_NEAR_MI', 'ALERT_NEAR_MI_ACUTE', 'alertNearMi',
  'HAZARD_EVENTS', 'HAZARD_EVENT_LIST', 'hazardAdmits', 'hazardClass', 'hazardRank', 'HAZARD_RANK_UNKNOWN',
  'alertTags', 'alertParam', 'alertHazCmp', 'urgencyRank', 'URGENCY_RANK',
  'alertVtecKey', 'alertDedupe', 'alertMotion', 'alertMotionText', 'alertMoves',
  'alertLifetimeMs', 'alertStaleAfterMs', 'alertFreshClass', 'ALERT_STALE_FLOOR_MS',
  'hazardStyleKey', 'hazardGlyph', 'hazardPolyStyle', 'alertActionKey', 'HAZARD_ACTION', 'LSR_HAZARD_RE',
  'hazardIsOrder', 'hazardGlance', 'alertAgency', 'alertAgencyText',
  'ORDER_EVENT_ACTION', 'ORDER_RESPONSE_ACTION',
  'nine11Alt', 'nine11Outages', 'NINE11_EVENT', 'alertCardDiv',
  'focusAlert', 'openInAlertsList', 'flashAlert', 'openAlertText', 'openInFeed', 'revealInList',
  'gaugeObsStale', 'gaugeObsCat', 'gaugeCat', 'gaugeForecastCat', 'gaugeRising', 'gaugeRecoveryState', 'riverOf',
  'splitGauges', 'gaugeState', 'gaugeStateCounts', 'gaugeHasReading', 'gaugeAll', 'GAUGE_STATES', 'GAUGE_DEGRADED',
  'NWPS_DEGRADED_CAT', 'defaultGaugeFilter', 'gaugeStateShown',
  'riverSlug', 'basinCrestTime', 'basinCorridor', 'basinRivers', 'basinWaveState',
  'recordContext', 'recordWatchGauges', 'RECORD_NEAR_FT', 'gaugeDegraded',
  'WATCH_KEY', 'WATCH_KINDS', 'watchAll', 'watchList', 'watchHas', 'watchToggle', 'watchDrop',
  'watchFirst', 'watchAudit', 'watchStarHtml', 'watchNoticeHtml', 'watchCountText',
  'watchUnknownIds', 'watchDropIds',
  'ROAD_COND', 'ROAD_COND_FALLBACK', 'roadCondType',
  'roadId', 'roadWatchId', 'roadMemory', 'updateRoadMemory', 'reopenedRoads', 'reopenIsFlood', 'ROADS_KEY', 'ROADS_KEY_LEGACY',
  'roadPointNear', 'roadSegMiles', 'roadSegParts', 'roadPopupHtml', 'arcgisHasMore', 'LWC_PAGE', 'LWC_MAX_PAGES',
  'fetchRoadClosures', 'fetchRoadClosuresLive', 'hydrateRoadsSnapshot', 'roadFeatures', 'ROAD_PAGE', 'ROAD_MAX_PAGES',
  'cardAged',
  'buildShareUrl', 'applyShareParams', 'linkOwnsView', 'LINK_VIEW_PARAMS',
  'smartScore', 'shortId', 'allRequests',
  'CALTOPO_EXPORT_URL', 'renderQr', 'caltopoStatusText',
  'mergeShelters', 'shelterDup', 'shelterKey',
  'resolveAoPresets', 'aoFullBounds', 'applyEventConfig', 'chipHealth',
  'camRegions', 'camRegionsAll', 'camRegionId', 'camRegionKey', 'CAM_REGION_OTHER', 'CAM_REGION_MAX_MI', 'CAM_REGION_ALL', 'regionLabel',
  'CAM_STATE_REGIONS', 'camOutsideId', 'inCamBbox',
  'camIsLive', 'CAM_NETS', 'CAM_STALE_MINS',
  'pushCardState', 'pushCardVisible', 'pushFollowPending', 'pushPendingHtml', 'pushFreshState', 'pushNormalizePrefs', 'pushKeysMatch', 'pushBootPlan', 'pushNearbyGauges', 'pushFixKey',
  'pushNormalizePlaces', 'pushScopeState', 'pushDelivers', 'pushPlacesHtml', 'pushRadiusLabel', 'pushPlaceLabel', 'PUSH_PLACE_KM', 'PUSH_MAX_PLACES',
  'pushEntryStateKey', 'pushWhereSummary', 'pushWhatSummary', 'pushGaugesSummary',
  'pushLocal', 'pushLocalSet', 'pushPrefs', 'pushDisable', 'pushFollowGauge',
  'wildfirePopupHtml', 'wildfireNoticeText', 'wildfireStale', 'wildfireContained', 'wildfireAgeH',
  'wildfireSource', 'WILDFIRE_STALE_H',
  'TIDE_NEUTRAL_FT', 'tideBand', 'tideQuiet', 'tideSplit', 'fetchTideMeta', 'tideStationLatLon',
  'renderTideStations', 'tidePopupHtml', 'paintTides', 'loadTides', 'fetchTides', 'focusTideStation',
];

// panels.js is in the loadApp bundle only — loadMapApp swaps it for map.js — so these must stay
// out of MAP_EXPORTS or the map bundle fails to resolve them
const PANEL_EXPORTS = ['quietState', 'feedCalmOk', 'quietGauges', 'xstatusAutoOn',
  'tickerItems', 'tickerAlertItems', 'tickerCap', 'TICKER_ACUTE_MAX', 'tickerUntil', 'driveItems',
  'renderNine11Notice', 'nine11NoticeHtml',
  'gaugeCardDiv', 'gaugeGlyphHtml', 'degradedGaugePool', 'degradedGaugeList', 'degradedStateCounts',
  'openInGaugesList', 'gaugeListUnfoldFor', 'DEG_GLYPH',
  'openShelterCount', 'unconfirmedShelterCount', 'curatedSheltersStale',
  'hotlineHtml', 'hotlinesOrdered', 'hotlineIsEmergency', 'shlNavHtml',
  'curatedShelterAgeH', 'SHELTER_CURATED_STALE_H', 'shelterOpen',
  'CROSSING_STATUS',
  'crestSourceCite', 'crestReconRows', 'crossingStale', 'crossingAgeH', 'CROSSING_STALE_H',
  'crossingList', 'heroCards', 'badgeText', 'BADGE_UNKNOWN', 'shlLiveUpdatedHtml',
  'roadsTabRows', 'roadsTxdotRows', 'roadsCuratedRows', 'roadsJurisdictionRows', 'roadsRowHtml', 'roadRowKey',
  'xstatusAgeD', 'XSTATUS_UNCONFIRMED_D',
  'renderTides', 'tideRowHtml', 'tideNameCell', 'tideSurgeColor', 'tideDirGlyph',
  'TIDE_BAND_COLOR', 'TIDES_QUIET_KEY'];

// map.js + playback.js add the playback frame-selection / archive-stamp math (pure, state-driven)
const MAP_EXPORTS = EXPORTS.concat(['VIEW_ROWS',
  'CAM_LEGACY_PARAMS', 'CAM_ROWS', 'CAM_SUBGROUPS', 'CAM_PILL_MAX',
  'initCamRegionRows', 'camTriState', 'camParentRows', 'camParentOn', 'camRegionHasCams',
  'layerRowKeys', 'layerRowOn', 'collectLayerState', 'applyLayerState', 'aoPickedId', 'aoSelectById',
  'offlineResultText', 'offlineSaveClean', 'offlineDepth', 'OFFLINE_DEPTHS', 'OFFLINE_DEPTH_DEFAULT',
  'pbLiveHideAll', 'pbFrameAt', 'pbFirstIdx', 'pbRadarStampAt', 'pbMrmsStampAt', 'pbBlocksLive', 'pbGaugeNoteKey', 'PB_LIVE_HIDE', 'iemRadarFrames', 'wxFcstDegraded', 'wxObsUnverified',
  'WILDFIRE_AREA_MIN_ACRES', 'fireAreaRadiusM', 'perimeterMatches',
  'pbSbw', 'pbSbwSev', 'pbSbwKey', 'pbSbwStore', 'pbSbwInAO', 'pbEmergencyKey', 'pbStoryRebuild', 'PB_SBW_FLOOD',
  'pbChunkUrl', 'pbDaysInWindow', 'pbMergeFrames', 'pbArchiveStart', 'pbArchiveStartIso', 'pbDayAt', 'pbChunkPending', 'pbChunkFailed',
  'PB_RANGES', 'pbArchiveDepthDays', 'pbRangeOverreaches', 'pbDepthLabel', 'pbBoundedView', 'pbKey']);

function buildBundle(files, exports) {
  const sources = files.map(read).join('\n;\n');
  const epilogue = `\n;globalThis.__RESPONDER = { ${exports.join(', ')} };\n`;
  const sandbox = buildSandbox();
  const context = vm.createContext(sandbox);
  vm.runInContext(sources + epilogue, context, { filename: 'responder-bundle.js' });
  const out = sandbox.__RESPONDER;
  out._sandbox = sandbox;
  return out;
}

let cached = null;

// Load the app's pure logic once and return the exported symbols.
// playback.js precedes sources.js/board.js as in index.html (their pb* calls are runtime-only).
function loadApp() {
  if (!cached) cached = buildBundle(['core.js', 'usng.js', 'playback.js', 'sources.js', 'cameras.js', 'panels.js', 'board.js'], EXPORTS.concat(PANEL_EXPORTS));
  return cached;
}

let mapCached = null;

// Same bundle plus map.js (declaration-only at load, like the rest).
function loadMapApp() {
  if (!mapCached) mapCached = buildBundle(['core.js', 'usng.js', 'map.js', 'playback.js', 'sources.js', 'cameras.js', 'board.js'], MAP_EXPORTS);
  return mapCached;
}

/* ---------- a wired map: initMap() actually run, so layer wiring is executed rather than grepped

   The v0.99.79 wildfire outage was invisible to 36 tests because every one of them matched the
   text of js/map.js. A commented-out `if (e.layer === state.layers.wildfire) fetchWildfire();`
   still matches that text. Running initMap() against these stubs registers the app's REAL event
   handlers, so firing `overlayadd` proves the wiring instead of describing it. Only the browser
   and Leaflet are stubbed here; every line of app logic in the path is the shipped one. */

/* Leaflet layer factories must return DISTINGUISHABLE objects: the whole point of the overlay
   handlers is `e.layer === state.layers.x`, and the module-level L proxy answers every call with
   itself, so every layer would compare equal to every other one. */
const LAYER_FACTORIES = ['layerGroup', 'featureGroup', 'tileLayer', 'marker', 'circle', 'circleMarker',
  'polygon', 'polyline', 'rectangle', 'geoJSON', 'geoJson', 'markerClusterGroup', 'imageOverlay',
  'videoOverlay', 'divIcon', 'icon'];

function makeRecordingL(mapStub) {
  let seq = 0;
  const layer = (kind) => {
    const id = `${kind}#${++seq}`;
    const own = { __kind: kind, __id: id, options: {}, _layers: {},
      // real, so "ships off by default" is a question the map can answer
      addTo(target) { if (target && typeof target.addLayer === 'function') target.addLayer(self); return self; } };
    const self = new Proxy(own, {
      get(target, key) {
        if (key === Symbol.toPrimitive) return () => id;
        if (key === 'then' || key === 'constructor') return undefined; // never look like a thenable
        if (!(key in target)) target[key] = () => self;
        return target[key];
      },
      set(target, key, value) { target[key] = value; return true; },
    });
    return self;
  };
  const cache = {};
  const L = new Proxy(function () {}, {
    get(target, key) {
      if (key === Symbol.toPrimitive) return () => 'L-stub';
      if (key === 'map') return () => mapStub;
      if (LAYER_FACTORIES.includes(key)) {
        const factory = () => layer(key);
        if (key === 'tileLayer') { factory.wms = () => layer('wms'); factory.canvas = () => layer('tileCanvas'); }
        return factory;
      }
      if (!(key in cache)) cache[key] = L;
      return cache[key];
    },
    apply() { return L; },
    construct() { return L; },
  });
  return L;
}

function makeMapStub() {
  const handlers = new Map();
  const on = new Set();
  const latLng = { lat: 30, lng: -99 };
  const bounds = { getWest: () => -100, getEast: () => -98, getSouth: () => 29, getNorth: () => 31,
    getNorthWest: () => ({ lat: 31, lng: -100 }), getSouthEast: () => ({ lat: 29, lng: -98 }),
    getNorthEast: () => ({ lat: 31, lng: -98 }), getSouthWest: () => ({ lat: 29, lng: -100 }),
    contains: () => true, getCenter: () => latLng, pad() { return bounds; }, isValid: () => true };
  const point = (x, y) => ({ x, y, divideBy: () => point(x, y), floor: () => point(Math.floor(x), Math.floor(y)) });
  const map = {
    __handlers: handlers,
    on(events, fn) {
      String(events).split(/\s+/).filter(Boolean)
        .forEach((e) => { if (!handlers.has(e)) handlers.set(e, []); handlers.get(e).push(fn); });
      return map;
    },
    off() { return map; }, once(e, fn) { return map.on(e, fn); },
    __on: on,
    addLayer(l) { on.add(l); return map; },
    removeLayer(l) { on.delete(l); return map; },
    hasLayer(l) { return on.has(l); },
    eachLayer(fn) { on.forEach(fn); },
    addControl() { return map; }, removeControl() { return map; },
    setView() { return map; }, setZoom() { return map; }, getZoom() { return 10; }, getMinZoom() { return 5; },
    flyTo() { return map; }, panTo() { return map; }, fitBounds() { return map; }, stop() { return map; },
    getCenter() { return latLng; }, getBounds() { return bounds; }, getSize() { return { x: 900, y: 700 }; },
    createPane() { return { style: {} }; }, getPane() { return { style: {} }; },
    getContainer() { return makeElementStub(); }, invalidateSize() {}, whenReady() { return map; },
    locate() { return map; }, stopLocate() { return map; }, distance() { return 0; },
    latLngToContainerPoint() { return point(0, 0); }, containerPointToLatLng() { return latLng; },
    project() { return point(0, 0); }, unproject() { return latLng; },
    zoomControl: { setPosition() {} },
    attributionControl: { setPrefix() { return map.attributionControl; }, getContainer: makeElementStub,
      addAttribution() {}, removeAttribution() {} },
  };
  return { map, handlers };
}

/* Loads a private (never the cached) bundle, runs the real initMap(), and hands back the handlers
   the app registered. `fire('overlayadd', { layer: layers.wildfire })` then executes the shipped
   handler body. Each call is independent: initMap mutates state heavily. */
function loadWiredMap() {
  const app = buildBundle(['core.js', 'usng.js', 'map.js', 'playback.js', 'sources.js', 'cameras.js', 'board.js'], MAP_EXPORTS);
  const sandbox = app._sandbox;
  const { map, handlers } = makeMapStub();
  sandbox.L = makeRecordingL(map);
  sandbox.initMap();
  const fire = (event, payload) => {
    const list = handlers.get(event);
    if (!list || !list.length) throw new Error(`no '${event}' handler was registered by initMap()`);
    list.forEach((fn) => fn(payload));
    return list.length;
  };
  /* Replaces a sandbox global with a call recorder and returns the log. Only function
     DECLARATIONS are replaceable this way; a const arrow is lexical and cannot be reached. */
  const spyOn = (...names) => {
    const calls = [];
    for (const name of names) {
      if (typeof sandbox[name] !== 'function') throw new Error(`${name} is not a sandbox function; cannot spy on it`);
      sandbox[name] = (...args) => { calls.push({ name, args }); return Promise.resolve(); };
    }
    calls.names = () => calls.map((c) => c.name);
    return calls;
  };
  return { app, sandbox, state: app.state, layers: app.state.layers, map, handlers, fire, spyOn };
}

/* Header-status sandbox. The freshness-slot invariant is behavioral, not textual: a transient
   notice must not be able to leave the degraded chip, its tooltip or its role behind. That needs
   elements that actually record classList/attribute writes, which the minimal stub above does not,
   so this builds a small tracking DOM and loads boot.js (its only top-level statement is a
   DOMContentLoaded listener, a no-op here) alongside the files that raise transient notices. */
function makeTrackedElement(id) {
  const classes = new Set();
  const attrs = new Map();
  return {
    id,
    style: {}, dataset: {}, options: [], value: '', textContent: '', innerHTML: '', title: '', hidden: false,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : (on ? classes.add(c) : classes.delete(c))),
      contains: (c) => classes.has(c),
    },
    classes,
    attrs,
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    removeAttribute(k) { attrs.delete(k); },
    appendChild() {}, append() {}, remove() {}, add() {},
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    dispatchEvent() { return true; }, closest() { return null; }, scrollIntoView() {},
  };
}

function loadHeaderStatus() {
  const sandbox = buildSandbox();
  const nodes = new Map();
  sandbox.document.querySelector = (sel) => {
    if (!nodes.has(sel)) nodes.set(sel, makeTrackedElement(String(sel).replace(/^#/, '')));
    return nodes.get(sel);
  };
  // hold the timers: opNotice arms a 6s auto-dismiss, and a real one would keep the runner alive
  const timers = [];
  sandbox.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  sandbox.clearTimeout = () => {};
  sandbox.__timers = timers;
  const files = ['core.js', 'usng.js', 'map.js', 'playback.js', 'sources.js', 'cameras.js', 'board.js', 'boot.js'];
  const exports = ['state', 'setFeedNote', 'setFeedNoteHealthy', 'refreshNoteTitle', 'opNotice', 'compassNotice', 'REFRESH_SOURCE_KEYS'];
  const epilogue = `\n;globalThis.__HDR = { ${exports.join(', ')} };\n`;
  vm.runInContext(files.map(read).join('\n;\n') + epilogue, vm.createContext(sandbox), { filename: 'header-status.js' });
  return { ...sandbox.__HDR, node: (sel) => sandbox.document.querySelector(sel), timers, sandbox };
}

module.exports = { loadApp, loadMapApp, loadWiredMap, buildSandbox, loadHeaderStatus };
