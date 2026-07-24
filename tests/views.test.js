'use strict';

/* openView() router. The ?view= deep links used to be dispatched by synthesizing clicks on
   #drive-btn and #summary-btn, which tied two shipped links to two button ids: removing or
   relocating either button would have broken the link with nothing failing loudly. Routing now
   happens by name in js/panels.js and every caller goes through it. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSandbox } = require('./harness.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// evaluate the first-party scripts in index.html order, one script per tag, in one context
function loadContext() {
  const html = read('index.html');
  const files = [...html.matchAll(/<script src="(js\/[^"?]+)\?v=[^"]+"><\/script>/g)]
    .map((m) => m[1]).filter((f) => !f.startsWith('js/vendor/'));
  const sandbox = buildSandbox();
  const context = vm.createContext(sandbox);
  for (const f of files) vm.runInContext(read(f), context, { filename: f });
  return context;
}

// record which opener each route invokes, without letting the real one run
function withStubs(context, fn) {
  const calls = [];
  const saved = {};
  const names = ['enterDriveMode', 'openBasinView', 'openPlayback', 'openRecoveryView', 'openCrestSummary'];
  for (const n of names) {
    saved[n] = context[n];
    context[n] = (...args) => { calls.push([n, ...args]); };
  }
  try { fn(calls); } finally { for (const n of names) context[n] = saved[n]; }
  return calls;
}

const VIEW_SWITCH = /function openView\([\s\S]*?\n\}/;

function openViewSource() {
  const m = read('js/panels.js').match(VIEW_SWITCH);
  assert.ok(m, 'openView() not found in js/panels.js');
  return m[0];
}

test('openView routes every value buildShareUrl can emit', () => {
  const emitted = [...read('js/board.js').matchAll(/p\.set\('view',\s*'([a-z]+)'\)/g)].map((m) => m[1]);
  assert.ok(emitted.length >= 2, `expected buildShareUrl to emit view values, found ${emitted.length}`);

  const src = openViewSource();
  for (const name of new Set(emitted)) {
    assert.ok(src.includes(`case '${name}':`), `buildShareUrl emits view=${name} but openView has no case for it`);
  }
});

test('openView covers the documented route names, live included', () => {
  const src = openViewSource();
  for (const name of ['live', 'drive', 'basin', 'playback', 'recovery', 'summary']) {
    assert.ok(src.includes(`case '${name}':`), `openView is missing case '${name}'`);
  }
});

test("openView('drive') calls the drive opener without touching #drive-btn", () => {
  const context = loadContext();
  const calls = withStubs(context, () => { context.openView('drive'); });
  assert.deepEqual(calls, [['enterDriveMode']]);

  // the old dispatch synthesized clicks on two button ids; both must be gone from boot.js
  const boot = read('js/boot.js');
  assert.ok(!/\$\('#drive-btn'\)\.click\(\)/.test(boot), "js/boot.js still dispatches ?view=drive via $('#drive-btn').click()");
  assert.ok(!/\$\('#summary-btn'\)\.click\(\)/.test(boot), "js/boot.js still dispatches ?view=summary via $('#summary-btn').click()");
});

test('openView routes summary, recovery, and playback to their own openers', () => {
  const context = loadContext();
  assert.deepEqual(withStubs(context, () => { context.openView('summary'); }), [['openCrestSummary']]);
  assert.deepEqual(withStubs(context, () => { context.openView('recovery'); }), [['openRecoveryView']]);
  assert.deepEqual(withStubs(context, () => { context.openView('playback'); }), [['openPlayback']]);
});

test('unknown view name is a silent no-op', () => {
  const context = loadContext();
  for (const bad of ['nope', '', 'DRIVE', 'summary ', '__proto__', 'constructor', 'toString']) {
    const calls = withStubs(context, () => {
      assert.doesNotThrow(() => context.openView(bad), `openView(${JSON.stringify(bad)}) threw`);
    });
    assert.deepEqual(calls, [], `openView(${JSON.stringify(bad)}) opened something`);
  }
  // absent / non-string names must be inert too
  const calls = withStubs(context, () => {
    for (const bad of [undefined, null, 0, {}, []]) assert.doesNotThrow(() => context.openView(bad));
  });
  assert.deepEqual(calls, []);
});

test('?view=basin with a crafted river slug falls back to null', () => {
  const context = loadContext();
  const ok = withStubs(context, () => { context.openView('basin', { river: 'sabine-river' }); });
  assert.deepEqual(ok, [['openBasinView', 'sabine-river']]);

  for (const bad of ['"><script>', '../../etc/passwd', 'Sabine River', 'a'.repeat(61), '', undefined, null]) {
    const calls = withStubs(context, () => { context.openView('basin', { river: bad }); });
    assert.deepEqual(calls, [['openBasinView', null]], `slug ${JSON.stringify(bad)} was not rejected`);
  }
  // a missing opts object must behave like a missing slug, not throw
  assert.deepEqual(withStubs(context, () => { context.openView('basin'); }), [['openBasinView', null]]);
});

test("openView('live') opens nothing: the board is already the live view", () => {
  const context = loadContext();
  assert.deepEqual(withStubs(context, () => { context.openView('live'); }), []);
});

test('the active lens is never persisted into saveViewState', () => {
  // deliberate: restoring "Recovery" on a later boot would imply an all-clear the data does not support
  const board = read('js/board.js');
  const m = board.match(/function saveViewState\(\)[\s\S]*?\n\}/);
  assert.ok(m, 'saveViewState() not found in js/board.js');
  for (const token of ['view', 'recovery', 'basin', 'lens', 'drive', 'summary', 'playback']) {
    assert.ok(!new RegExp(`['"\`]${token}`, 'i').test(m[0]),
      `saveViewState() persists "${token}"; the active lens must not survive a reload`);
  }
});

/* Views sheet (v0.97.90). The lens picker replaced four Feed > More buttons, so the rows must
   name exactly the routes openView() understands, and every row must dispatch through openView()
   rather than re-introducing a click on a button id. Radio semantics live in closeLens(). */

test('the views sheet rows name exactly the routes openView() handles', () => {
  const map = read('js/map.js');
  const m = map.match(/const VIEW_ROWS = \[([\s\S]*?)\];/);
  assert.ok(m, 'VIEW_ROWS table not found in js/map.js');
  const names = [...m[1].matchAll(/\[\s*'([a-z]+)'/g)].map((x) => x[1]);
  assert.deepEqual(names, ['live', 'drive', 'basin', 'playback', 'recovery', 'summary']);
  const src = openViewSource();
  for (const n of names) assert.ok(src.includes(`case '${n}':`), `views sheet offers '${n}' but openView has no case for it`);
});

test('the views sheet dispatches by route name, never by button id', () => {
  const map = read('js/map.js');
  const m = map.match(/function onViewsSheetClick\(e\)[\s\S]*?\n\}/);
  assert.ok(m, 'onViewsSheetClick() not found in js/map.js');
  assert.ok(/openView\(row\.dataset\.view\)/.test(m[0]), 'the row handler should call openView(row.dataset.view)');
  // the four Feed > More lens buttons are gone; nothing may resurrect them
  const html = read('index.html');
  const boot = read('js/boot.js');
  for (const id of ['summary-btn', 'recovery-btn', 'basin-btn', 'playback-btn']) {
    assert.ok(!html.includes(`id="${id}"`), `index.html still declares #${id}`);
    assert.ok(!boot.includes(`#${id}`), `js/boot.js still references #${id}`);
  }
});

test('every lens route closes the other lenses first (one lens at a time)', () => {
  const src = openViewSource();
  for (const [name, keep] of [['live', 'null'], ['drive', "'drive'"], ['basin', "'basin'"],
    ['playback', "'playback'"], ['recovery', "'recovery'"], ['summary', "'summary'"]]) {
    assert.ok(new RegExp(`case '${name}': closeLens\\(${keep.replace(/'/g, "'")}\\)`).test(src),
      `openView case '${name}' should call closeLens(${keep})`);
  }
  const panels = read('js/panels.js');
  const cl = panels.match(/function closeLens\(keep\)[\s\S]*?\n\}/);
  assert.ok(cl, 'closeLens() not found in js/panels.js');
  for (const sel of ['#drive-mode', '#summary-view', '#recovery-view', '#basin-view', '#playback-bar']) {
    assert.ok(cl[0].includes(sel), `closeLens() does not handle ${sel}`);
  }
});

test('closeLens tolerates a lens pane that is absent from the document', () => {
  const context = loadContext();
  // the vm document stub returns element stubs, so drive the null path explicitly
  const saved = context.document.querySelector;
  context.document.querySelector = () => null;
  try { assert.doesNotThrow(() => context.closeLens(null)); } finally { context.document.querySelector = saved; }
});

test('the Escape chain closes the views sheet', () => {
  const boot = read('js/boot.js');
  assert.ok(/if \(viewsSheetIsOpen\(\)\) \{ closeViewsSheet\(\); return; \}/.test(boot),
    'js/boot.js Escape handler should close the views sheet');
});

test('applyShareParams delegates view routing instead of dispatching inline', () => {
  const board = read('js/board.js');
  const m = board.match(/function applyShareParams\(q\)[\s\S]*?\n\}/);
  assert.ok(m, 'applyShareParams() not found in js/board.js');
  assert.ok(/openView\(q\.get\('view'\)/.test(m[0]), 'applyShareParams should route ?view= through openView()');
  assert.ok(!/openRecoveryView\(\)|openBasinView\(/.test(m[0]),
    'applyShareParams still opens a lens directly; the switch belongs in openView()');
});
