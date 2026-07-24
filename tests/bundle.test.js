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
  'rtlTogglePlay', 'rtlStopPlay', 'rtlSet', 'setRainWindow', 'fetchRadarFrames',
  // playback.js (called from map.js, boot.js, panels.js, board.js, sources.js)
  'pbBlocksLive', 'openPlayback', 'togglePlayback', 'initPlaybackControls',
  'pbLayersLockedNote', 'pbRefreshCurated', 'pbRadarStampAt', 'pbMrmsStampAt',
  // sources.js
  'fetchAlerts', 'fetchGauges', 'fetchLsrs', 'fetchRoadClosures', 'fetchFcstMax',
  'fetchUsgsIv', 'fetchTropical', 'openAlertTextById', 'dismissEmergencyBanner', 'prettyRoute',
  // cameras.js (called from map.js, sources.js, boot.js, panels.js)
  'loadCameras', 'renderCameras', 'openCamViewer', 'closeCamViewer', 'camNetLabel', 'nearestRiverCam',
  // panels.js / board.js / boot.js
  'renderTiles', 'renderRequests', 'renderAlertList', 'loadSeeds', 'refresh',
  'restoreViewState', 'loadEventConfig', 'registerServiceWorker', 'initPushCard',
];

test('index.html lists the expected first-party classic scripts in a sane order', () => {
  const files = indexScriptOrder();
  assert.ok(files.length >= 12, `expected >=12 first-party scripts, got ${files.length}`);
  for (const f of files) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} referenced by index.html but missing on disk`);
  assert.ok(files.indexOf('js/core.js') < files.indexOf('js/map.js'), 'core.js must load before map.js');
  assert.ok(files.indexOf('js/map.js') < files.indexOf('js/playback.js'), 'playback.js loads after map.js');
  assert.ok(files.indexOf('js/sources.js') < files.indexOf('js/cameras.js'), 'cameras.js loads after sources.js');
  assert.ok(!files.includes('js/chat.js') && !files.includes('js/master.js'), 'LAN-only clients must never be static tags');
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

// discriminating-power proof: the check must FAIL when load order breaks. map.js builds
// PILL_LAYERS from CONFIG at top level, so evaluating it before core.js throws ReferenceError.
test('mutation: loading map.js before core.js throws (the check catches order regressions)', () => {
  const files = indexScriptOrder();
  const mutated = files.slice();
  const ci = mutated.indexOf('js/core.js'), mi = mutated.indexOf('js/map.js');
  [mutated[ci], mutated[mi]] = [mutated[mi], mutated[ci]];
  assert.throws(() => loadInOrder(mutated), { name: 'ReferenceError' }); // vm realm: match by name, not host prototype
});
