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
    hidden: false,
    appendChild() {}, append() {}, remove() {}, add() {},
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return ''; },
    querySelector() { return makeElementStub(); },
    querySelectorAll() { return []; },
    getElement() { return null; },
    dispatchEvent() { return true; },
    closest() { return null; },
    scrollIntoView() {},
  };
  return el;
}

function buildSandbox() {
  const documentStub = {
    title: '',
    readyState: 'loading', // classic scripts evaluate before DOMContentLoaded; notes.js branches on this

    querySelector() { return makeElementStub(); },
    querySelectorAll() { return []; },
    createElement() { return makeElementStub(); },
    getElementById() { return makeElementStub(); },
    addEventListener() {},
    documentElement: { getAttribute() { return ''; }, setAttribute() {}, style: {} },
    body: makeElementStub(),
  };

  const storage = new Map();
  const localStorageStub = {
    getItem(k) { return storage.has(k) ? storage.get(k) : null; },
    setItem(k, v) { storage.set(k, String(v)); },
    removeItem(k) { storage.delete(k); },
    clear() { storage.clear(); },
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
    navigator: { clipboard: null, share: null, geolocation: null },
    localStorage: localStorageStub,
    location: { origin: 'https://example.test', pathname: '/', search: '' },
    getComputedStyle() { return { getPropertyValue() { return ''; } }; },
    CSS: { escape: (v) => String(v).replace(/(["'\\\]])/g, '\\$1') }, // reveal selectors are built with it
    Event: function Event(type) { this.type = type; },
    Option: function Option(text, value) { this.text = text; this.value = value; },
    fetch() { return Promise.reject(new Error('network disabled in tests')); },
    t(key) { return key; }, // i18n.js is not loaded; key-echo keeps t()-calling helpers exercisable
    L,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

// Symbols exercised by the tests. Some are `const`/arrow (lexical, not on the
// global object), so the epilogue must name them explicitly to export them.
const EXPORTS = [
  'CONFIG', 'state', 'FLOOD_CATS', 'CAT_RANK', 'PRI_WEIGHT',
  'esc', 'fmtNum', 'safeUrl', 'telHref', 'ageMins', 'distMi', 'freshClass',
  'modalCycleIndex', 'modalIsFocusableVisible',
  'toUSNG',
  'alertReach', 'alertSeverity', 'alertOpen', 'emergencyBannerMode',
  'gaugeObsStale', 'gaugeObsCat', 'gaugeCat', 'gaugeForecastCat', 'gaugeRising', 'gaugeRecoveryState', 'riverOf',
  'splitGauges', 'gaugeState', 'gaugeStateCounts', 'gaugeHasReading', 'gaugeAll', 'GAUGE_STATES', 'GAUGE_DEGRADED',
  'NWPS_DEGRADED_CAT', 'defaultGaugeFilter', 'gaugeStateShown',
  'riverSlug', 'basinCrestTime', 'basinCorridor', 'basinRivers', 'basinWaveState',
  'recordContext', 'recordWatchGauges', 'RECORD_NEAR_FT', 'gaugeDegraded',
  'cardAged',
  'buildShareUrl', 'applyShareParams',
  'smartScore', 'shortId', 'allRequests',
  'CALTOPO_EXPORT_URL', 'renderQr', 'caltopoStatusText',
  'mergeShelters', 'shelterDup', 'shelterKey',
  'resolveAoPresets', 'aoFullBounds', 'applyEventConfig', 'chipHealth',
  'camRegions', 'camRegionsAll', 'camRegionId', 'camRegionKey', 'CAM_REGION_OTHER', 'CAM_REGION_MAX_MI', 'CAM_REGION_ALL', 'regionLabel',
  'CAM_STATE_REGIONS', 'camOutsideId', 'inCamBbox',
  'camIsLive', 'CAM_NETS', 'CAM_STALE_MINS',
  'pushCardState', 'pushCardVisible', 'pushFollowPending', 'pushPendingHtml', 'pushFreshState', 'pushNormalizePrefs', 'pushKeysMatch', 'pushBootPlan', 'pushNearbyGauges', 'pushFixKey',
];

// panels.js is in the loadApp bundle only — loadMapApp swaps it for map.js — so these must stay
// out of MAP_EXPORTS or the map bundle fails to resolve them
const PANEL_EXPORTS = ['quietState', 'feedCalmOk',
  'gaugeCardDiv', 'gaugeGlyphHtml', 'degradedGaugePool', 'degradedGaugeList', 'degradedStateCounts',
  'openInGaugesList', 'gaugeListUnfoldFor', 'DEG_GLYPH',
  'openShelterCount', 'unconfirmedShelterCount', 'curatedSheltersStale',
  'hotlineHtml', 'hotlinesOrdered', 'hotlineIsEmergency', 'shlNavHtml',
  'curatedShelterAgeH', 'SHELTER_CURATED_STALE_H', 'shelterOpen',
  'crestSourceCite', 'crestReconRows', 'crossingStale', 'crossingAgeH', 'CROSSING_STALE_H'];

// map.js + playback.js add the playback frame-selection / archive-stamp math (pure, state-driven)
const MAP_EXPORTS = EXPORTS.concat(['CAM_LEGACY_PARAMS', 'CAM_ROWS', 'CAM_SUBGROUPS', 'CAM_PILL_MAX',
  'initCamRegionRows', 'camTriState', 'camParentRows', 'camParentOn', 'camRegionHasCams',
  'pbLiveHideAll', 'pbFrameAt', 'pbFirstIdx', 'pbRadarStampAt', 'pbMrmsStampAt', 'pbBlocksLive', 'pbGaugeNoteKey', 'PB_LIVE_HIDE', 'iemRadarFrames', 'wxFcstDegraded',
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

module.exports = { loadApp, loadMapApp, buildSandbox, loadHeaderStatus };
