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

/* Views control names its own state (v0.97.98). The lens picker shipped behind an unlabelled glyph
   as the fifth stacked box at map top-right, which made the field's most important surface less
   discoverable than the header button it replaced. The control now carries the active lens name and
   an exit segment, and the stack is back to three boxes. */

const mapSrc = () => read('js/map.js');

test('the map top-right stack is three boxes: layers, views, share', () => {
  const src = mapSrc();
  const topright = [...src.matchAll(/L\.control\(\{ position: 'topright' \}\)/g)].length;
  assert.equal(topright, 3,
    `map top-right should hold exactly 3 controls (layers, views, share), found ${topright}`);
  // neither capability was deleted to hit the number: the compass rides the nav bar, offline is a sheet section
  assert.ok(/L\.DomUtil\.create\('a', 'compass-btn', bar\)/.test(src),
    'the compass must join the + / - / locate nav bar, not disappear');
  const render = src.match(/function renderLayerSheet\(\)[\s\S]*?\n\}/);
  assert.ok(render && /offlineSheetHtml\(\)/.test(render[0]),
    'the offline tile save must render inside the layer sheet');
  assert.ok(!/initOfflineControl/.test(src), 'the standalone offline map control must be gone');
  assert.ok(!/compass-ctl/.test(src), 'the standalone compass control must be gone');
});

test('the offline save/clear actions stay reachable from the layer sheet body', () => {
  const src = mapSrc();
  const m = src.match(/function onLayerSheetClick\(e\)[\s\S]*?\n\}/);
  assert.ok(m, 'onLayerSheetClick() not found in js/map.js');
  assert.ok(/off-save"\]'\)\) \{ saveViewportOffline\(\)/.test(m[0]), 'the sheet must dispatch off-save');
  assert.ok(/off-clear"\]'\)\) \{ clearOfflineCache\(\)/.test(m[0]), 'the sheet must dispatch off-clear');
  // the body is rewritten wholesale on every render, so the async tile count has to be re-read
  const r = src.match(/function renderLayerSheet\(\)[\s\S]*?\n\}/);
  assert.ok(/refreshOfflineStatus\(\)/.test(r[0]), 'renderLayerSheet must refresh the offline tile count');
});

test('syncViewsTrigger names the active lens and reveals the way back to Live', () => {
  const src = mapSrc();
  const m = src.match(/function syncViewsTrigger\(\)[\s\S]*?\n\}/);
  assert.ok(m, 'syncViewsTrigger() not found in js/map.js');
  assert.ok(/activeViewName\(\)/.test(m[0]), 'the tag must be read from the panes, not a parallel state flag');
  assert.ok(/views\.tag\.\$\{name\}/.test(m[0]), 'the trigger must render the per-lens tag key');
  assert.ok(/back\.hidden = live/.test(m[0]), 'the exit segment shows only while a lens owns the board');
  // the exit segment is the dedicated way back to Live that openView('live') never had a control for
  assert.ok(/\.views-back'\), 'click', \(e\) => \{ L\.DomEvent\.stop\(e\); openView\('live'\)/.test(src),
    "the exit segment must call openView('live')");
});

test('i18n: every route openView handles has a short lens tag in both languages', () => {
  const i18n = require('./i18n-load.js');
  const m = mapSrc().match(/const VIEW_ROWS = \[([\s\S]*?)\];/);
  const names = [...m[1].matchAll(/\[\s*'([a-z]+)'/g)].map((x) => x[1]);
  for (const n of names) {
    for (const lang of ['en', 'es']) {
      const v = i18n[lang][`views.tag.${n}`];
      assert.ok(typeof v === 'string' && v.length, `${lang} missing views.tag.${n}`);
      assert.ok(v.length <= 12, `views.tag.${n} (${lang}) is ${v.length} chars; the control has room for 12`);
      assert.ok(!v.includes('—'), `em-dash in ${lang} views.tag.${n}`);
    }
    assert.notEqual(i18n.en[`views.tag.${n}`], i18n.es[`views.tag.${n}`], `views.tag.${n} was never translated`);
  }
  for (const k of ['views.exit', 'views.open.on']) {
    for (const lang of ['en', 'es']) assert.ok(i18n[lang][k], `${lang} missing ${k}`);
  }
  assert.ok(i18n.en['views.open.on'].includes('{v}') && i18n.es['views.open.on'].includes('{v}'),
    'views.open.on must keep the {v} placeholder in both languages');
});

test('the trigger re-syncs on every path that can change the active lens', () => {
  assert.ok(/if \(typeof syncViewsTrigger === 'function'\) syncViewsTrigger\(\);/
    .test(read('js/panels.js').match(/function openView\(name, opts\)[\s\S]*?\n\}/)[0]),
  'openView() must re-sync the trigger');
  const pb = read('js/playback.js');
  for (const fn of ['openPlayback', 'closePlayback']) {
    const m = pb.match(new RegExp(`function ${fn}\\(\\)[\\s\\S]*?\\n\\}`));
    assert.ok(m && /syncViewsTrigger\(\)/.test(m[0]), `${fn}() must re-sync the trigger`);
  }
  // a live language switch repaints every dynamic surface; the lens tag is one of them
  const boot = read('js/boot.js');
  const rl = boot.match(/function relocalizeDynamic\(\)[\s\S]*?\n\}/);
  assert.ok(rl && /syncViewsTrigger\(\)/.test(rl[0]), 'relocalizeDynamic() must re-sync the trigger');
});

test('every lens entrance and exit goes through the openView router', () => {
  const boot = read('js/boot.js');
  assert.ok(/\$\('#drive-btn'\)\.addEventListener\('click', \(\) => openView\('drive'\)\)/.test(boot),
    "the header Drive button must route through openView('drive')");
  assert.ok(/\$\('#drive-exit'\)\.addEventListener\('click', \(\) => openView\('live'\)\)/.test(boot),
    "Drive Mode's exit must route through openView('live')");
  assert.ok(/\['#summary-exit', '#recovery-exit', '#basin-exit'\][\s\S]{0,90}openView\('live'\)/.test(boot),
    "the three docked lens exits must route through openView('live')");
});

test('the playback fast path and its deep link survive the control consolidation', () => {
  const html = read('index.html');
  assert.ok(html.includes('id="pb-pill"'), '#pb-pill must stay on the map as the playback fast path');
  const pb = read('js/playback.js');
  assert.ok(/\$\('#pb-pill'\)\.addEventListener\('click', togglePlayback\)/.test(pb), '#pb-pill must still toggle playback');
  assert.ok(/get\('playback'\) === '1'\) openPlayback\(\)/.test(read('js/boot.js')), '?playback=1 must still open playback');
});

/* ---------- crest provenance (v0.99.4) ---------- */
/* gen-crest-summary rebuilds the pre-archive window from the upstream USGS/NWPS record and stamps
   those rows with src. The lens printed one flat citation saying every stage was observed through
   this board's own snapshot archive, which was true when the file held four rows and false for 30
   of 47. v0.97.97 already drew this line for playback (playback.note.gauges.recon); the after-action
   artifact and the CalTopo export people carry into the field now draw it too. */

const { crestSourceCite, crestReconRows } = require('./harness.js').loadApp();
const I18N_TBL = require('./i18n-load.js');

const row = (lid, src) => (src ? { lid, peak_category: 'major', src } : { lid, peak_category: 'major' });

test('crestSourceCite — a file with no reconstructed rows keeps the plain observed citation', () => {
  assert.equal(crestSourceCite([row('A'), row('B')]), 'summary.source');
  assert.equal(crestReconRows([row('A'), row('B')]), 0);
});

test('crestSourceCite — one reconstructed row is enough to change the claim', () => {
  assert.equal(crestSourceCite([row('A'), row('B', 'usgs')]), 'summary.source.mixed');
  assert.equal(crestReconRows([row('A'), row('B', 'usgs')]), 1);
});

test('crestSourceCite — absent or empty input never claims an observed source it does not have', () => {
  assert.equal(crestSourceCite(null), 'summary.source');
  assert.equal(crestSourceCite(undefined), 'summary.source');
  assert.equal(crestReconRows(null), 0);
});

test('the mixed citation states both numbers, in both languages', () => {
  for (const lang of ['en', 'es']) {
    const s = I18N_TBL[lang]['summary.source.mixed'];
    assert.ok(s, `${lang} missing summary.source.mixed`);
    assert.ok(s.includes('{n}') && s.includes('{m}'), `${lang} summary.source.mixed lost a placeholder`);
    assert.ok(!s.includes('—'), `em-dash in ${lang} summary.source.mixed`);
  }
  assert.notEqual(I18N_TBL.en['summary.source.mixed'], I18N_TBL.es['summary.source.mixed']);
  for (const k of ['summary.recon', 'summary.recon.title']) {
    for (const lang of ['en', 'es']) assert.ok(I18N_TBL[lang][k], `${lang} missing ${k}`);
    assert.notEqual(I18N_TBL.en[k], I18N_TBL.es[k], `${k} was never actually translated`);
  }
});

test('every crest surface reads the citation helper, none of them the flat observed string', () => {
  const panels = fs.readFileSync(path.join(__dirname, '..', 'js', 'panels.js'), 'utf8');
  assert.equal((panels.match(/crestSourceCite\(/g) || []).length, 4,
    'the helper plus its three call sites: crest summary, recovery view, basin view');
  const decl = panels.slice(panels.indexOf('function crestSourceCite'), panels.indexOf('function crestRowHtml'));
  const elsewhere = panels.replace(decl, '');
  assert.ok(!/t\('summary\.source'\)/.test(elsewhere),
    "a crest surface still prints t('summary.source') directly instead of the helper");
  const rowFn = panels.match(/function crestRowHtml\(g\)[\s\S]*?\n\}/);
  assert.ok(rowFn, 'crestRowHtml() not found');
  assert.match(rowFn[0], /g\.src \?/, 'crestRowHtml must read g.src, which it never did');
  assert.match(rowFn[0], /t\('summary\.recon'\)/, 'a reconstructed row must carry its own badge');
});

test('the CalTopo export marks a reconstructed peak in its own title, notes and citation', () => {
  const gen = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'gen-caltopo.py'), 'utf8');
  const fn = gen.slice(gen.indexOf('def build_crests('), gen.indexOf('def alert_severity('));
  assert.match(fn, /recon = c\.get\("src"\)/, 'build_crests must read the src stamp');
  assert.match(fn, /RECONSTRUCTED peak/, 'the feature notes must say the peak was rebuilt');
  assert.match(fn, /\(reconstructed\)/, 'the feature title must say so too, for a field import');
  assert.match(fn, /reconstructed\)" /, 'the citation must not credit NOAA observation for a rebuilt peak');
});

test('data/crest-summary.json — the src stamp the UI now reads is really in the file', () => {
  const p = path.join(__dirname, '..', 'data', 'crest-summary.json');
  if (!fs.existsSync(p)) return; // absence-tolerant: older deploys shipped no crest summary
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const rows = d.gauges || [];
  for (const g of rows) {
    if ('src' in g) assert.ok(typeof g.src === 'string' && g.src.length, `${g.lid} has an empty src stamp`);
  }
  // the generator's own source field already told the truth; the UI is what was not reading it
  assert.match(String(d.source || ''), /reconstructed/i,
    'crest-summary.json no longer declares its reconstructed window');
});
