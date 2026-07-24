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
  'esc', 'fmtNum', 'safeUrl', 'ageMins', 'distMi', 'freshClass',
  'modalCycleIndex', 'modalIsFocusableVisible',
  'toUSNG',
  'alertReach', 'alertSeverity',
  'gaugeObsStale', 'gaugeObsCat', 'gaugeCat', 'gaugeForecastCat', 'gaugeRising', 'gaugeRecoveryState', 'riverOf',
  'recordContext', 'recordWatchGauges', 'RECORD_NEAR_FT',
  'cardAged',
  'buildShareUrl', 'applyShareParams',
  'smartScore', 'shortId', 'allRequests',
  'CALTOPO_EXPORT_URL', 'renderCaltopoQr',
  'mergeShelters', 'shelterDup', 'shelterKey',
  'resolveAoPresets', 'aoFullBounds', 'applyEventConfig', 'chipHealth',
  'pushCardState', 'pushFreshState', 'pushNormalizePrefs', 'pushKeysMatch', 'pushBootPlan', 'pushNearbyGauges',
];

// map.js + playback.js add the playback frame-selection / archive-stamp math (pure, state-driven)
const MAP_EXPORTS = EXPORTS.concat(['pbFrameAt', 'pbFirstIdx', 'pbRadarStampAt', 'pbMrmsStampAt', 'pbBlocksLive', 'iemRadarFrames', 'wxFcstDegraded']);

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
  if (!cached) cached = buildBundle(['core.js', 'usng.js', 'playback.js', 'sources.js', 'cameras.js', 'board.js'], EXPORTS);
  return cached;
}

let mapCached = null;

// Same bundle plus map.js (declaration-only at load, like the rest).
function loadMapApp() {
  if (!mapCached) mapCached = buildBundle(['core.js', 'usng.js', 'map.js', 'playback.js', 'sources.js', 'cameras.js', 'board.js'], MAP_EXPORTS);
  return mapCached;
}

module.exports = { loadApp, loadMapApp, buildSandbox };
