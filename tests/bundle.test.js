'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSandbox } = require('./harness.js');

/* Cross-module load-order check. index.html ships classic scripts sharing one global scope;
   node --check is per-file syntax only, so nothing else fails when a script references an
   identifier a LATER-loaded file defines at top level. Here we evaluate every first-party
   script from index.html, in its exact tag order, script-by-script in one shared vm context
   (matching browser <script> semantics: per-tag TDZ and hoisting boundaries, which plain
   concatenation would blur), then assert the cross-module entry points boot.js and the
   inter-file seams rely on all resolved to functions. */

const ROOT = path.join(__dirname, '..');

function indexScriptOrder() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const files = [...html.matchAll(/<script src="(js\/[^"?]+)\?v=[^"]+"><\/script>/g)].map((m) => m[1]);
  return files.filter((f) => !f.startsWith('js/vendor/'));
}

// evaluate each file as its own script in one shared context, exactly like sequential <script> tags
function loadInOrder(files) {
  const sandbox = buildSandbox();
  const context = vm.createContext(sandbox);
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    vm.runInContext(src, context, { filename: f });
  }
  return context;
}

// the cross-module surface: what boot.js invokes plus the seams between the split files
// (map.js↔playback.js, sources.js↔cameras.js). All must exist once every script has loaded.
const ENTRY_POINTS = [
  // i18n.js
  'applyI18n', 'getLang', 'setLang', 't',
  // core.js
  'esc', 'registerModal', 'applyShareParams', 'resolveAoPresets',
  // map.js
  'initMap', 'applyTheme', 'openLayerSheet', 'closeLayerSheet', 'layerSheetIsOpen',
  'initViewsSheet', 'openViewsSheet', 'closeViewsSheet', 'viewsSheetIsOpen',
  'rtlTogglePlay', 'rtlStopPlay', 'rtlSet', 'setRainWindow', 'fetchRadarFrames',
  // playback.js (called from map.js, boot.js, panels.js, board.js, sources.js)
  'pbBlocksLive', 'openPlayback', 'togglePlayback', 'initPlaybackControls',
  'pbLayersLockedNote', 'pbRefreshCurated', 'pbRadarStampAt', 'pbMrmsStampAt',
  // sources.js
  'fetchAlerts', 'fetchGauges', 'fetchLsrs', 'fetchRoadClosures', 'fetchFcstMax',
  'fetchUsgsIv', 'fetchTropical', 'openAlertTextById', 'dismissEmergencyBanner', 'prettyRoute',
  // the three marker layers relocalizeDynamic() repaints on a live language switch
  'renderWildfire', 'renderRiverSentry', 'renderTideStations',
  // cameras.js (called from map.js, sources.js, boot.js, panels.js)
  'loadCameras', 'renderCameras', 'openCamViewer', 'closeCamViewer', 'camNetLabel', 'nearestRiverCam',
  // panels.js / board.js / boot.js
  'openView',
  'renderTiles', 'renderRequests', 'renderAlertList', 'loadSeeds', 'refresh',
  'restoreViewState', 'loadEventConfig', 'registerServiceWorker', 'initPushCard',
];

/* Every eager tag is bytes on the critical path of a one-bar first load, so the set is pinned
   exactly rather than by a floor: adding one has to be a deliberate edit here, and the lazy four
   cannot drift back onto the shell unnoticed. tests/lazy-assets.test.js owns the other half. */
const EAGER_SCRIPTS = [
  // ~1 KB and necessarily first: it is the only script an engine below the syntax floor can run
  'js/bootfloor.js',
  'js/vendor/leaflet.js',
  'js/vendor/leaflet.markercluster.js',
  'js/usng.js',
  'js/i18n.js',
  'js/core.js',
  'js/map.js',
  'js/playback.js',
  'js/sources.js',
  'js/cameras.js',
  'js/panels.js',
  'js/board.js',
  'js/boot.js',
];

test('index.html loads exactly the expected script set, in a sane order', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const all = [...html.matchAll(/<script src="(js\/[^"?]+)\?v=[^"]+"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(all, EAGER_SCRIPTS, 'the eager script set changed; weigh the cold-load cost before pinning the new one');

  const files = indexScriptOrder();
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} referenced by index.html but missing on disk`);
  assert.ok(files.indexOf('js/core.js') < files.indexOf('js/map.js'), 'core.js must load before map.js');
  assert.ok(files.indexOf('js/map.js') < files.indexOf('js/playback.js'), 'playback.js loads after map.js');
  assert.ok(files.indexOf('js/sources.js') < files.indexOf('js/cameras.js'), 'cameras.js loads after sources.js');
  assert.ok(!files.includes('js/chat.js') && !files.includes('js/master.js'), 'LAN-only clients must never be static tags');
  // notes.js is stripped from the public artifact, so a static tag would 404 on every mirror load
  assert.ok(!files.includes('js/notes.js'), 'js/notes.js must be injected on ?notes/?note, not a static tag');
  // the on-demand four: heavy, and needed only behind a tap, a link, or the LAN build
  for (const lazy of ['js/team.js', 'js/vendor/hls.light.min.js', 'js/vendor/qrcode.min.js']) {
    assert.ok(!all.includes(lazy), `${lazy} is loaded eagerly again`);
  }
  assert.ok(!/<link[^>]+href="css\/team\.css/.test(html), 'css/team.css must load with the team client, not on every visit');
});

test('all scripts evaluate in index.html order with no load-time ReferenceError', () => {
  assert.doesNotThrow(() => loadInOrder(indexScriptOrder()));
});

test('every cross-module entry point resolves to a function after load', () => {
  const context = loadInOrder(indexScriptOrder());
  for (const name of ENTRY_POINTS) {
    // typeof via the context sees global lexical (const/let) bindings, not just object properties
    const kind = vm.runInContext(`typeof ${name}`, context);
    assert.equal(kind, 'function', `${name} is ${kind}, expected function`);
  }
});

/* Undeclared state keys are how three published-zero defects hid: the load-bearing fact was the
   INITIAL value of a key nothing declared, so nobody could see what it was until a reader found
   `undefined` and treated it as a measurement. Every key the client touches is declared in the one
   literal with the value that means "not answered yet". */
function declaredStateKeys() {
  const src = fs.readFileSync(path.join(ROOT, 'js/core.js'), 'utf8');
  const i = src.indexOf('const state = {');
  assert.ok(i >= 0, 'the state literal moved');
  const j = src.indexOf('\n};', i);
  return new Set([...src.slice(i, j).matchAll(/^ {2}([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]));
}

// a leading `.`, quote or backtick means it is a longer property path or an i18n key, not our state
const STATE_USE_RE = new RegExp("(?<![\\w.$'\"`])state\\.([A-Za-z_$][\\w$]*)", 'g');

test('every state key the client uses is declared in the one state literal', () => {
  const declared = declaredStateKeys();
  assert.ok(declared.size > 150, `only ${declared.size} keys declared; the literal lost its tail`);
  const undeclared = new Map();
  for (const f of fs.readdirSync(path.join(ROOT, 'js')).filter((n) => n.endsWith('.js'))) {
    for (const m of fs.readFileSync(path.join(ROOT, 'js', f), 'utf8').matchAll(STATE_USE_RE)) {
      if (!declared.has(m[1])) undeclared.set(m[1], f);
    }
  }
  assert.deepEqual([...undeclared], [],
    'declare the key in core.js with the value that means "not answered yet"; an ad hoc key hides its own initial value');

  // the runtime object must not grow one at load time either
  const context = loadInOrder(indexScriptOrder());
  const live = vm.runInContext('Object.keys(state)', context);
  assert.deepEqual(live.filter((k) => !declared.has(k)), [], 'a script added a state key while loading');
  assert.deepEqual([...declared].filter((k) => !live.includes(k)), [], 'a declared key never reached the loaded object');
});

// discriminating-power proof: the check must FAIL when load order breaks. map.js builds
// PILL_LAYERS from CONFIG at top level, so evaluating it before core.js throws ReferenceError.
test('mutation: loading map.js before core.js throws (the check catches order regressions)', () => {
  const files = indexScriptOrder();
  const mutated = files.slice();
  const ci = mutated.indexOf('js/core.js'), mi = mutated.indexOf('js/map.js');
  [mutated[ci], mutated[mi]] = [mutated[mi], mutated[ci]];
  assert.throws(() => loadInOrder(mutated), { name: 'ReferenceError' }); // vm realm: match by name, not host prototype
});
