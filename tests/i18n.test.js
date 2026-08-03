'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// i18n.js is a self-contained IIFE; a few browser globals let it evaluate in a vm.
function loadI18N() {
  const sandbox = {
    console, URLSearchParams,
    location: { search: '' },
    document: { documentElement: {}, querySelectorAll: () => [], title: '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { language: 'en' },
    window: {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'i18n.js'), 'utf8'), sandbox);
  return sandbox.window.I18N;
}

const I18N = loadI18N();

test('i18n: en and es key sets are identical (full parity)', () => {
  const en = Object.keys(I18N.en);
  const es = Object.keys(I18N.es);
  assert.deepEqual(en.filter((k) => !(k in I18N.es)), [], 'keys missing from es');
  assert.deepEqual(es.filter((k) => !(k in I18N.en)), [], 'keys missing from en');
});

test('i18n: no em-dash in any en or es string value', () => {
  for (const lang of ['en', 'es']) {
    const bad = Object.keys(I18N[lang]).filter((k) => String(I18N[lang][k]).includes('—'));
    assert.deepEqual(bad, [], `em-dash in ${lang} string values`);
  }
});

test('changelog.json: no em-dash in public line strings', () => {
  const cl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'changelog.json'), 'utf8'));
  const bad = cl.versions.filter((v) => String(v.line || '').includes('—')).map((v) => v.v);
  assert.deepEqual(bad, [], 'em-dash in changelog.json version line');
});

test('index.html: no em-dash in user-visible markup (comments excluded)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const visible = html.replace(/<!--[\s\S]*?-->/g, '');
  const lines = visible.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => l.includes('—'));
  assert.deepEqual(lines, [], 'em-dash in index.html non-comment lines');
});

/* Renderer-literal guard (N5 regression): asserts the SPECIFIC formerly-hardcoded English render
 * strings never reappear in js renderer source (comments stripped; i18n.js itself excluded), plus
 * two shape checks (CAT_LABEL const removed; CROSSING_STATUS/ROAD_COND maps hold i18n keys, not
 * label: strings). It is a precise denylist, NOT a general English detector: brand-new
 * untranslated strings outside this list are not caught. */
function strippedSource(file) {
  return fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, ''); // full-line comments only; inline comments after code are kept
}

/* The guarded set is DERIVED from what index.html loads, never listed: the v0.97.77 module split
 * created js/playback.js and js/cameras.js and both fell straight out of a hand-kept list, as
 * js/team.js had before them. "What index.html loads" is its own <script src="js/*.js"> tags plus,
 * transitively, the js/*.js those scripts inject at runtime (loadScript brings in notes.js on
 * ?notes and chat.js/master.js behind the LAN capability beacon; all three render UI a person
 * reads). js/vendor/* falls out of the tag pattern itself, since its paths carry a second slash,
 * and js/i18n.js is skipped because it IS the dictionary the guard compares against. */
const SCRIPT_TAG_RE = /<script\s+src="js\/([^"/?]+\.js)/g;
// both runtime injection forms: boot.js's LAN-only loadScript and core.js's stamped loadAssetOnce
const INJECT_RE = /(?:loadScript|loadAssetOnce)\(\s*(?:assetUrl\(\s*)?[`'"]js\/([^`'"?]+\.js)/g;

function derivedRenderFiles(html, readSource) {
  const queue = [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(SCRIPT_TAG_RE)].map((m) => m[1]);
  const seen = new Set();
  const out = [];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    if (f !== 'i18n.js') out.push(f);
    // lazily-loaded vendor libraries reach the queue through INJECT_RE the same way our own
    // surfaces do; they are third-party minified source and carry none of our strings
    for (const m of readSource(f).matchAll(INJECT_RE)) { if (!m[1].startsWith('vendor/')) queue.push(m[1]); }
  }
  return out;
}

const RENDER_FILES = derivedRenderFiles(
  fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'), strippedSource);

test('renderer guard: the guarded set is derived from what index.html loads, not a fixed list', () => {
  const tags = [...indexHtml().matchAll(SCRIPT_TAG_RE)].map((m) => m[1]).filter((f) => f !== 'i18n.js');
  assert.deepEqual(tags.filter((f) => !RENDER_FILES.includes(f)), [], 'index.html loads a script the guard does not cover');
  for (const f of ['playback.js', 'cameras.js', 'team.js', 'notes.js', 'chat.js', 'master.js']) {
    assert.ok(RENDER_FILES.includes(f), `${f} renders UI but is not in the guarded set`);
  }
  assert.ok(!RENDER_FILES.includes('i18n.js'), 'the dictionary must not be guarded against itself');
  assert.deepEqual(RENDER_FILES.filter((f) => /leaflet|markercluster|hls|qrcode/.test(f)), [],
    'vendor source is third party and is not ours to translate');
  // derivation proof: a script tag and a runtime inject that exist nowhere in this file are picked up
  assert.deepEqual(
    derivedRenderFiles('<script src="js/core.js?v=1"></script><script src="js/brand-new-surface.js?v=1"></script>',
      (f) => (f === 'core.js' ? "loadScript(`js/injected-surface.js?v=${stamp}`);" : '')),
    ['core.js', 'brand-new-surface.js', 'injected-surface.js']);
});

test('renderer guard: formerly-hardcoded English literals stay routed through t()', () => {
  const denylist = [
    'no flooding', 'crest arrival order', "'crested'", 'LONG-TERM CLOSED',
    'MAJOR flood now', 'rising to MAJOR', 'STALE: no current data',
    'Forecast crest ', 'forecast crest ', 'verify before routing', 'crest of record',
    'aged · suppressed', 'stale · re-verify', 'CUT-OFF AREA (est.)', 'Detour available',
    "'▾ hide'", "'▸ show'", 'elsewhere in TX', 'River gauge status',
    'road reopened (recovering)', 'storm report (LSR)', 'marker glyph = need type',
    'Ground truth: storm reports', 'flood storm reports in TX',
    'isolation footprint', 'Radio reference: tap to copy', 'Link copied',
    'stage history', 'Full hydrograph', 'NOAA gauge page', 'USGS site page',
    'raw reading, no flood-stage context', 'feed unavailable',
  ];
  const hits = [];
  for (const f of RENDER_FILES) {
    const src = strippedSource(f);
    for (const term of denylist) if (src.includes(term)) hits.push(`${f}: ${term}`);
  }
  assert.deepEqual(hits, [], 'hardcoded renderer English literal reappeared (route it through t())');
});

/* Renderer guard for the degraded tooltip. refresh() concatenated a hardcoded English SOURCE_NAMES
 * array onto the localized note.degraded.detail, so a Spanish reader got "Estas fuentes no
 * respondieron en la ultima actualizacion: NWS alerts, NWPS gauges, ...". The names now come from
 * the Live feeds chip labels, which is also the list the chip taps through to. Order is the one
 * thing that can silently rot here: REFRESH_SOURCE_KEYS is indexed by Promise.allSettled position,
 * NOT the life-safety-first order renderSourceHealth() displays, so the arity is asserted too. */
test('renderer guard: the degraded tooltip names sources in both languages', () => {
  const boot = strippedSource('boot.js');
  const englishNames = ['NWS alerts', 'NWPS gauges', 'RFC forecast', 'USGS stage', 'storm reports', 'board data', 'TxDOT roads'];
  const hits = englishNames.filter((n) => boot.includes(n));
  assert.deepEqual(hits, [], 'hardcoded English source names are back in the degraded tooltip (use t(REFRESH_SOURCE_KEYS[i]))');
  assert.ok(!/SOURCE_NAMES/.test(boot), 'the SOURCE_NAMES English array must stay gone');

  const decl = boot.match(/const REFRESH_SOURCE_KEYS = \[([^\]]*)\];/);
  assert.ok(decl, 'REFRESH_SOURCE_KEYS not found in js/boot.js');
  const keys = [...decl[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const k of keys) {
    assert.ok(k in I18N.en && k in I18N.es, `${k} is not a key in both languages`);
  }

  // arity: one label per settled promise, or every failure past the short one is mislabeled
  const settled = boot.match(/Promise\.allSettled\(\[([\s\S]*?)\]\)/);
  assert.ok(settled, 'the refresh() Promise.allSettled call was not found');
  let depth = 0;
  let arity = 1;
  for (const ch of settled[1]) {
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) arity += 1;
  }
  assert.equal(keys.length, arity,
    'REFRESH_SOURCE_KEYS must have exactly one entry per settled source, in the same order');
});

test('renderer guard: enum label maps carry i18n keys, not English labels', () => {
  for (const f of RENDER_FILES) {
    const src = strippedSource(f);
    assert.ok(!/\bCAT_LABEL\b/.test(src), `${f}: CAT_LABEL map reintroduced (use catLabel()/catWord())`);
  }
  const panels = strippedSource('panels.js');
  const crossing = (panels.match(/const CROSSING_STATUS = \{[\s\S]*?\};/) || [''])[0];
  assert.ok(crossing.length, 'CROSSING_STATUS map missing from panels.js');
  assert.ok(!/label:/.test(crossing), 'CROSSING_STATUS holds label: strings (use key: xword.*)');
  const sources = strippedSource('sources.js');
  const road = (sources.match(/const ROAD_COND = \{[\s\S]*?\};/) || [''])[0];
  assert.ok(road.length, 'ROAD_COND map missing from sources.js');
  assert.ok(!/label:/.test(road), 'ROAD_COND holds label: strings (use key: road.cond.*)');
  assert.ok(/ROAD_COND_FALLBACK = \{ key:/.test(sources), 'ROAD_COND_FALLBACK must carry an i18n key');
});

test('i18n: device-alerts (push) keys exist in both languages, 911 framing intact', () => {
  const keys = ['push.title', 'push.sub', 'push.disclaimer', 'push.state.off', 'push.state.on',
    'push.state.blocked', 'push.state.unsupported', 'push.state.ios',
    'push.fix.blocked', 'push.fix.unsupported', 'push.fix.ios',
    'push.note', 'push.about', 'push.types.label', 'push.type.ffe', 'push.type.gauges',
    'push.opt.off', 'push.opt.on',
    'push.toggle.on', 'push.toggle.off', 'push.err',
    'push.state.silent', 'push.silent.types', 'push.unreachable'];
  for (const k of keys) {
    assert.ok(typeof I18N.en[k] === 'string' && I18N.en[k].length, `en missing ${k}`);
    assert.ok(typeof I18N.es[k] === 'string' && I18N.es[k].length, `es missing ${k}`);
    assert.ok(!I18N.en[k].includes('—'), `em-dash in en ${k}`);
    assert.ok(!I18N.es[k].includes('—'), `em-dash in es ${k}`);
    assert.notEqual(I18N.en[k], I18N.es[k], `${k} was never actually translated`);
  }
  // the not-a-WEA/911 invariant must be present on the disclaimer in both languages
  assert.ok(/call 911/i.test(I18N.en['push.disclaimer']));
  assert.ok(/Wireless Emergency Alerts/.test(I18N.en['push.disclaimer']));
  assert.ok(/llame al 911/i.test(I18N.es['push.disclaimer']));
  assert.ok(/WEA/.test(I18N.es['push.disclaimer']));
  // the disclaimer moved behind a disclosure in v0.99.6, so the always-visible line has to carry
  // the same three claims: best effort, not 911, not a WEA
  assert.ok(/911/.test(I18N.en['push.note']) && /911/.test(I18N.es['push.note']));
  assert.ok(/Wireless Emergency Alert/.test(I18N.en['push.note']));
  assert.ok(/WEA/.test(I18N.es['push.note']));
  assert.ok(/best effort/i.test(I18N.en['push.note']));
  assert.ok(/esfuerzo/i.test(I18N.es['push.note']));
  // blocked / unsupported / ios must stay tellable apart from each other and from a plain off
  const distinct = ['off', 'on', 'blocked', 'unsupported', 'ios'].map((s) => I18N.en[`push.state.${s}`]);
  assert.equal(new Set(distinct).size, distinct.length, 'two card states share a state string');
  for (const lang of ['en', 'es']) {
    const set = ['off', 'on', 'blocked', 'unsupported', 'ios'].map((s) => I18N[lang][`push.state.${s}`]);
    assert.equal(new Set(set).size, set.length, `${lang}: two card states share a state string`);
  }
  // the retired chip keys must be gone from BOTH languages, not just one
  for (const dead of ['push.chip.ffe', 'push.chip.major', 'push.chip.moderate', 'push.chips.label']) {
    assert.equal(I18N.en[dead], undefined, `en still carries the retired ${dead}`);
    assert.equal(I18N.es[dead], undefined, `es still carries the retired ${dead}`);
  }
});

test('i18n: offline keys exist in both languages with placeholders intact', () => {
  const keys = ['sheet.g.offline', 'off.save', 'off.save.title',
    'off.note', 'off.clear', 'off.cleared', 'off.none', 'off.saved', 'off.savedfull', 'off.saving', 'off.cap'];
  for (const k of keys) {
    assert.ok(typeof I18N.en[k] === 'string' && I18N.en[k].length, `en missing ${k}`);
    assert.ok(typeof I18N.es[k] === 'string' && I18N.es[k].length, `es missing ${k}`);
    assert.ok(!I18N.en[k].includes('—'), `em-dash in en ${k}`);
    assert.ok(!I18N.es[k].includes('—'), `em-dash in es ${k}`);
    for (const ph of I18N.en[k].match(/\{[a-z]+\}/g) || []) {
      assert.ok(I18N.es[k].includes(ph), `es ${k} missing placeholder ${ph}`);
    }
  }
});

/* Markup parity for the action rows. These controls shipped untranslated: the export,
   import, SITREP, filters, and new-notice buttons carried no data-i18n attribute at all,
   so a Spanish session still read them in English (v0.97.83 backfilled them). The check is
   positional rather than by id, so it keeps holding as later IA phases relocate these controls
   (v0.97.91 moved the export/import row out of Feed > More into Resources > Data & interchange).
   These rows contain no nested <div>, so the first </div> closes the row. */
const FEED_ACTION_ROWS = /<div class="feed-actions"[^>]*>([\s\S]*?)<\/div>/g;

function feedActionRows() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');
  const rows = [...html.matchAll(FEED_ACTION_ROWS)].map((m) => m[1]);
  return rows;
}

test('i18n: every control in the feed action rows carries a data-i18n attribute', () => {
  const rows = feedActionRows();
  assert.ok(rows.length >= 2, `expected the feed row and the interchange row, found ${rows.length}`);
  assert.ok(!rows.some((r) => /<div/.test(r)), 'a feed-actions row gained a nested <div>; the row extractor needs updating');

  const missing = [];
  for (const row of rows) {
    // buttons carry their own label; a <label> delegates to the text-bearing <span> inside it
    for (const tag of [...row.matchAll(/<(button|span)\b([^>]*)>/g)]) {
      const attrs = tag[2];
      if (/type="file"/.test(attrs)) continue;
      if (!/\bdata-i18n(=|-html=)/.test(attrs)) {
        missing.push(`<${tag[1]}${attrs.replace(/\s+/g, ' ')}>`.slice(0, 90));
      }
    }
  }
  assert.deepEqual(missing, [], 'untranslated control in a .feed-actions row (add data-i18n / data-i18n-title)');
});

/* Placement guard (v0.97.99, narrowed in v0.99.37). Export/import and the CalTopo live URL are one
   surface: Share and Export are the same verb at different fidelity, and no comparable product puts
   export in a content tab or a settings page. The RSS/ICS subscribe rows left for the Alerts group
   (tests/push-discovery.test.js) because subscribing is alert delivery, not export. The listeners in
   js/boot.js keep the same element ids, so nothing would fail loudly if the markup drifted. */
test('interchange lives in the Share surface, not in a content tab', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');
  for (const gone of ['id="more-toggle"', 'id="more-menu"']) {
    assert.ok(!html.includes(gone), `index.html still declares ${gone}`);
  }
  const sheet = html.slice(html.indexOf('<div id="share-sheet"'), html.indexOf('<div id="notes-flyout"'));
  assert.ok(sheet.length > 500, '#share-sheet was not found in index.html');
  for (const id of ['interchange-body', 'export-btn', 'export-geo-btn', 'caltopo-btn', 'aar-btn',
    'import-file', 'caltopo-box', 'caltopo-url', 'caltopo-copy', 'caltopo-qr',
    'share-url', 'share-copy', 'share-native', 'share-qr']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `#${id} is not declared exactly once`);
    assert.ok(sheet.includes(`id="${id}"`), `#${id} is not inside the Share surface`);
  }
  // nothing interchange-shaped may remain in a tab body
  const tabs = html.slice(html.indexOf('id="tab-requests"'), html.indexOf('</main>'));
  for (const id of ['interchange-body', 'export-btn', 'caltopo-box']) {
    assert.ok(!tabs.includes(`id="${id}"`), `#${id} is still inside a tab body`);
  }
  assert.ok(!tabs.includes('id="follow-body"'), '#follow-body is inside a tab body');
  // subscribe left the Resources renderer with it
  const panels = fs.readFileSync(path.join(__dirname, '..', 'js', 'panels.js'), 'utf8');
  assert.ok(!/res\.follow/.test(panels), 'renderResources() still emits the Follow / subscribe section');
  assert.ok(!/crests\.ics|feed\.xml/.test(panels), 'renderResources() still emits the RSS/ICS links');

  const boot = fs.readFileSync(path.join(__dirname, '..', 'js', 'boot.js'), 'utf8');
  assert.ok(!/#more-toggle|#more-menu/.test(boot), 'js/boot.js still wires the retired Feed > More drawer');
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'app.css'), 'utf8');
  assert.ok(!/#more-menu|#more-toggle/.test(css), 'css/app.css still styles the retired Feed > More drawer');
});

test('both Share entry points open the one Share surface, and the export ids kept their handlers', () => {
  const boot = fs.readFileSync(path.join(__dirname, '..', 'js', 'boot.js'), 'utf8');
  const map = fs.readFileSync(path.join(__dirname, '..', 'js', 'map.js'), 'utf8');
  assert.ok(/\$\('#share-btn'\)\.addEventListener\('click', openShareSheet\)/.test(boot),
    'the settings sheet Share entry must open the Share surface');
  assert.ok(/openShareSheet\(\);/.test(map), 'the map Share control must open the Share surface');
  assert.ok(!/\bshareView\b/.test(boot + map), 'the old copy-on-tap shareView() must be gone');
  // relocating the markup must not have touched the interchange wiring
  for (const [sel, fn] of [['#export-btn', 'exportRequests'], ['#export-geo-btn', 'exportGeoJSON'],
    ['#caltopo-btn', 'toggleCaltopoBox'], ['#aar-btn', 'exportAAR']]) {
    assert.ok(boot.includes(`$('${sel}').addEventListener('click', ${fn})`), `${sel} lost its ${fn} handler`);
  }
  // the three interchange addresses are one table read by both the renderer and the copy wiring,
  // so a format cannot ship a visible row with a dead button or a button with no row
  const board = fs.readFileSync(path.join(__dirname, '..', 'js', 'board.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const table = board.match(/const FEED_URLS = \[[\s\S]*?\n\];/);
  assert.ok(table, 'js/board.js lost the FEED_URLS interchange table');
  assert.ok(/for \(const \[, btnSel, url\] of FEED_URLS\)/.test(boot),
    'js/boot.js must wire every FEED_URLS copy button, not one by name');
  for (const [slot, btn, url] of [['#caltopo-url', '#caltopo-copy', 'data/caltopo-export.json'],
    ['#kml-url', '#kml-copy', 'data/board-live.kml'], ['#georss-url', '#georss-copy', 'data/board-georss.xml']]) {
    assert.ok(table[0].includes(`'${slot}'`) && table[0].includes(`'${btn}'`),
      `FEED_URLS is missing the ${slot} row`);
    assert.ok(html.includes(`id="${slot.slice(1)}"`) && html.includes(`id="${btn.slice(1)}"`),
      `index.html is missing the ${slot} row markup`);
    assert.ok(board.includes(`https://respondertx.org/${url}`), `js/board.js lost the ${url} address`);
  }
  // the subscribe URL must be the NetworkLink wrapper: board.kml alone is a one-shot import
  assert.ok(/KML_LIVE_URL = 'https:\/\/respondertx\.org\/data\/board-live\.kml'/.test(board),
    'the KML row must offer the self-refreshing NetworkLink, not the payload KML');
});

/* Migration cue (v0.97.99). Moving a surface with no in-product pointer is the documented cause of
   "what happened to X" support threads. The cue must be dismissible, must not return after that, and
   must not join or impersonate the bottom toast lane the update/data channel owns. */
test('the migration cue is a dismissible in-place pointer, not a fifth toast', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.equal((html.match(/id="moved-cue"/g) || []).length, 1, '#moved-cue must be declared exactly once');
  const tabs = html.slice(html.indexOf('id="tab-requests"'), html.indexOf('id="tab-team"'));
  assert.ok(tabs.includes('id="moved-cue"'), 'the cue must sit where the moved control used to live');

  const panels = fs.readFileSync(path.join(__dirname, '..', 'js', 'panels.js'), 'utf8');
  const fn = panels.match(/function renderMovedCues\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'renderMovedCues() not found in js/panels.js');
  assert.match(fn[0], /MOVED_CUES\.filter\(\(\[key\]\) => !movedCueSeen\(key\)\)/,
    'the cue list must be filtered to the ones NOT yet dismissed');
  assert.ok(/moved-x/.test(fn[0]), 'the cue must carry its own dismiss control');
  assert.ok(/localStorage\.setItem\(`respondertx\.moved\./.test(panels), 'dismissal must persist');

  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'app.css'), 'utf8');
  const toastRule = css.match(/#update-toast, #sw-toast, #intake-toast, #op-toast \{[^}]*\}/);
  assert.ok(toastRule, 'the toast group rule was not found in css/app.css');
  assert.ok(!/moved-note/.test(toastRule[0]), 'the cue must not join the bottom toast lane');
  const movedRule = css.match(/\.moved-note \{[^}]*\}/);
  assert.ok(movedRule, '.moved-note styling not found');
  assert.ok(!/position: fixed/.test(movedRule[0]), 'the cue is in-place, never a floating toast');
  assert.ok(!/sev-warning|sev-emergency/.test(movedRule[0]), 'the cue must not wear data-warning colors');
  // the freshness slot is off limits: a layout note is not a statement about data currency
  assert.ok(!/refresh-note|setFeedNote/.test(panels.slice(panels.indexOf('const MOVED_CUES'), panels.indexOf('function renderResources'))),
    'the cue must never write the header freshness slot');
});

test('i18n: the Share surface and migration cue keys exist in both languages', () => {
  const keys = ['share.sheet.title', 'share.sheet.sub', 'share.g.view', 'share.copy', 'share.native',
    'share.native.title', 'share.qr', 'res.follow.sub', 'moved.exports', 'moved.go'];
  for (const k of keys) {
    for (const lang of ['en', 'es']) {
      assert.ok(typeof I18N[lang][k] === 'string' && I18N[lang][k].length, `${lang} missing ${k}`);
      assert.ok(!I18N[lang][k].includes('—'), `em-dash in ${lang} ${k}`);
    }
    assert.notEqual(I18N.en[k], I18N.es[k], `${k} was never actually translated`);
  }
});

/* Settings sheet (v0.97.92). The header ⋮ became a labelled gear holding Display, Alerts,
   Actions and Help. The device-alerts card moved into it from Resources, so #push-body must be
   declared exactly once and in its new home, and the retired Team shortcut must be gone from
   markup, wiring and both languages. */
function indexHtml() {
  return fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
}

/* v0.99.41 replaced role="menu"/"menuitem" here with a labelled disclosure group: the panel holds
   group headings and feature rows, so it could never satisfy the keyboard contract the menu roles
   promised. The container semantics are pinned in modal-a11y.test.js; what this guards is the
   panel's contents. The alert card left for #notify-sheet in the Notify me rework, so what the
   panel must still own is the one ROW that reaches it. */
test('the settings sheet owns every entry point and keeps one row to the notify sheet', () => {
  const html = indexHtml();
  const menu = html.slice(html.indexOf('<div id="hmore-menu"'), html.indexOf('<div class="refresh-meta">'));
  for (const id of ['shelters-btn', 'notify-btn', 'theme-toggle', 'lang-toggle', 'share-btn', 'help-btn', 'whatsnew-btn', 'safety-btn']) {
    assert.ok(new RegExp(`id="${id}"`).test(menu), `#${id} left the settings sheet`);
  }
  for (const g of ['set.g.public', 'set.g.display', 'set.g.actions', 'set.g.help']) {
    assert.ok(menu.includes(`data-i18n="${g}"`), `settings sheet is missing the ${g} heading`);
  }
  assert.equal((html.match(/id="push-body"/g) || []).length, 1, '#push-body is not declared exactly once');
  const sheet = html.slice(html.indexOf('<div id="notify-sheet"'), html.indexOf('<div id="share-sheet"'));
  assert.ok(sheet.includes('id="push-body"'), '#push-body did not move into the notify sheet');
  const tabs = html.slice(html.indexOf('id="tab-requests"'), html.indexOf('</main>'));
  assert.ok(!tabs.includes('id="push-body"'), '#push-body is back inside a tab body');
  // the row is a DIRECT child of the panel, which is what makes the panel close behind it
  // (js/boot.js: `#hmore-menu > button`). A nested control would leave the panel open over the sheet.
  assert.match(menu, /<div id="hmore-menu"[\s\S]*?\n\s*<button id="notify-btn"/,
    '#notify-btn must be a direct child button of #hmore-menu');
});

test('the Team shortcut is gone from markup, wiring, and both languages', () => {
  const html = indexHtml();
  assert.ok(!html.includes('id="team-btn"'), 'index.html still declares #team-btn');
  const boot = fs.readFileSync(path.join(__dirname, '..', 'js', 'boot.js'), 'utf8');
  assert.ok(!/#team-btn|openTeamEntry/.test(boot), 'js/boot.js still wires the Team shortcut');
  const team = fs.readFileSync(path.join(__dirname, '..', 'js', 'team.js'), 'utf8');
  assert.ok(!/openTeamEntry/.test(team), 'js/team.js still defines the now-unreachable openTeamEntry');
  for (const k of ['ctl.team', 'ctl.team.title', 'ctl.more.title', 'ctl.more.aria']) {
    for (const lang of ['en', 'es']) assert.ok(!(k in I18N[lang]), `${lang} still carries retired key ${k}`);
  }
});

/* The Notify me routing used to be asserted here as source text, including a loop checking that
   renderPushCard() and initPushCard() each CONTAIN the string $('#push-body'). It now lives in
   tests/push-discovery.test.js, which renders the card into a #push-body recorder and opens the
   sheet through pushOpenManageFor(), so the selector question answers itself. */

test('i18n: the settings sheet keys exist in both languages', () => {
  const keys = ['ctl.settings', 'ctl.settings.title', 'ctl.settings.aria',
    'set.g.display', 'set.g.actions', 'set.g.help', 'set.safety'];
  for (const k of keys) {
    for (const lang of ['en', 'es']) {
      assert.ok(typeof I18N[lang][k] === 'string' && I18N[lang][k].length, `${lang} missing ${k}`);
      assert.ok(!I18N[lang][k].includes('—'), `em-dash in ${lang} ${k}`);
    }
    assert.notEqual(I18N.en[k], I18N.es[k], `${k} was never actually translated`);
  }
});

test('i18n: feed and export control keys exist in both languages', () => {
  const keys = ['feed.new', 'feed.new.title', 'feed.sitrep', 'feed.sitrep.title',
    'feed.filters', 'feed.filters.n', 'feed.filters.title',
    'res.interchange', 'res.interchange.sub',
    'data.export.json', 'data.export.json.title', 'data.export.geo', 'data.export.geo.title',
    'data.export.aar', 'data.export.aar.title', 'data.import.json', 'data.import.json.title'];
  for (const k of keys) {
    assert.ok(typeof I18N.en[k] === 'string' && I18N.en[k].length, `en missing ${k}`);
    assert.ok(typeof I18N.es[k] === 'string' && I18N.es[k].length, `es missing ${k}`);
    assert.ok(!I18N.en[k].includes('—'), `em-dash in en ${k}`);
    assert.ok(!I18N.es[k].includes('—'), `em-dash in es ${k}`);
  }
  // the count variant must keep its placeholder in both languages
  for (const lang of ['en', 'es']) {
    assert.ok(I18N[lang]['feed.filters.n'].includes('{n}'), `${lang} feed.filters.n lost its {n} placeholder`);
  }
});

/* Views-sheet parity. The lens picker's rows are built in js/map.js, not in index.html, so the
   positional markup check above cannot see them. Read the VIEW_ROWS table out of the source and
   assert every key it names resolves in BOTH languages: a row whose label or subtitle key was
   never translated renders as a raw key string to a Spanish session. */
const VIEW_ROWS_RE = /const VIEW_ROWS = \[([\s\S]*?)\];/;

function viewRowKeys() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'map.js'), 'utf8');
  const m = src.match(VIEW_ROWS_RE);
  assert.ok(m, 'VIEW_ROWS table not found in js/map.js');
  const rows = [...m[1].matchAll(/\[\s*'([a-z]+)',\s*'[^']*',\s*'([^']+)',\s*'([^']+)'\s*\]/g)];
  assert.equal(rows.length, 6, `expected 6 view rows, parsed ${rows.length}`);
  return rows.map((r) => ({ name: r[1], labelKey: r[2], subKey: r[3] }));
}

test('i18n: every views-sheet row label and subtitle exists in both languages', () => {
  const rows = viewRowKeys();
  assert.deepEqual(rows.map((r) => r.name), ['live', 'drive', 'basin', 'playback', 'recovery', 'summary']);
  for (const { labelKey, subKey } of rows) {
    for (const k of [labelKey, subKey]) {
      for (const lang of ['en', 'es']) {
        assert.ok(typeof I18N[lang][k] === 'string' && I18N[lang][k].length, `${lang} missing ${k}`);
        assert.ok(!I18N[lang][k].includes('—'), `em-dash in ${lang} ${k}`);
      }
      assert.notEqual(I18N.en[k], I18N.es[k], `${k} was never actually translated`);
    }
  }
});

test('i18n: the views sheet chrome keys exist in both languages', () => {
  for (const k of ['views.open', 'views.title', 'views.live']) {
    for (const lang of ['en', 'es']) {
      assert.ok(typeof I18N[lang][k] === 'string' && I18N[lang][k].length, `${lang} missing ${k}`);
      assert.ok(!I18N[lang][k].includes('—'), `em-dash in ${lang} ${k}`);
    }
  }
  assert.notEqual(I18N.en['views.open'], I18N.es['views.open']);
});

/* Browser-dialog guard. alert/confirm/prompt paths shipped as English template literals: the
   clipboard fallback is routinely reached on the LAN board (http:// has no secure context, so
   navigator.clipboard is unavailable), and the LAN intake form and JSON import are operator
   surfaces. A Spanish session read all of them in English. */
const DIALOG_FILES = ['board.js', 'panels.js', 'team.js'];

test('renderer guard: no alert/confirm/prompt is called with a bare English literal', () => {
  const hits = [];
  for (const f of DIALOG_FILES) {
    const src = strippedSource(f);
    for (const m of src.matchAll(/\b(alert|confirm|prompt)\(\s*([`'"])/g)) {
      // a translated call opens with t(...) or tt(...), never with a string literal
      hits.push(`${f}: ${src.slice(m.index, m.index + 60).split('\n')[0]}`);
    }
  }
  assert.deepEqual(hits, [], 'browser dialog called with a hardcoded string (route it through t()/tt())');
});

test('i18n: the dialog and shelter-status keys exist in both languages with placeholders intact', () => {
  const keys = ['share.prompt', 'shl.approx', 'shl.st.unknown', 'intake.required', 'intake.dup',
    'import.done', 'import.failed', 'push.manage.pending'];
  for (const k of keys) {
    assert.ok(typeof I18N.en[k] === 'string' && I18N.en[k].length, `en missing ${k}`);
    assert.ok(typeof I18N.es[k] === 'string' && I18N.es[k].length, `es missing ${k}`);
    assert.notEqual(I18N.en[k], I18N.es[k], `${k} was never actually translated`);
    for (const ph of I18N.en[k].match(/\{[a-z]+\}/g) || []) {
      assert.ok(I18N.es[k].includes(ph), `es ${k} missing placeholder ${ph}`);
    }
  }
});

test('renderer guard: the formerly hardcoded dialog strings do not reappear', () => {
  const denylist = ['Summary and place are required', 'Possible duplicate: same type',
    "'Copy URL:'", "'Copy team link:'", 'Import: ${added}', 'Import failed: ${e.message}',
    'Location approximate; confirm before routing'];
  const hits = [];
  for (const f of DIALOG_FILES) {
    const src = strippedSource(f);
    for (const term of denylist) if (src.includes(term)) hits.push(`${f}: ${term}`);
  }
  assert.deepEqual(hits, [], 'hardcoded dialog English literal reappeared (route it through t()/tt())');
});

test('renderer guard: the filters badge label is not a hardcoded literal', () => {
  const board = strippedSource('board.js');
  assert.ok(!/'☰ Filters'|`☰ Filters/.test(board),
    'js/board.js rebuilds the filters label from an English literal (route it through t(\'feed.filters\'))');
  assert.ok(/t\('feed\.filters'\)/.test(board) && /t\('feed\.filters\.n'\)/.test(board),
    'updateFiltersBadge() should read both feed.filters and feed.filters.n');
});

/* Structural literal guard (v0.99.3). The denylist above could not see a NEW hardcoded string, and
 * that is how the life-safety cues shipped English-only: the flash-flood-emergency banner and all
 * four data-age-bar states. This guard is the opposite shape. It reads every string literal in the
 * derived renderer set and FAILS BY DEFAULT on the two forms those cues took, so a brand-new literal
 * of the same class is caught without anyone remembering to list it:
 *   A. a warning-glyph literal: an alarm the reader is meant to act on
 *   B. a run of two or more all-caps words: the board shouting in one language
 * It is a class detector, not an English detector: sentence-case prose still needs review.
 * Exemptions are token-shaped, never phrase-shaped. ACRONYMS clears organization, protocol and
 * product names (a caps run made only of those is a proper noun). EXEMPT_RUNS carries the few
 * machine and interop strings no reader is meant to translate, each named individually. */
const ACRONYMS = new Set(['NOAA', 'NHC', 'NWS', 'NWPS', 'NWM', 'MRMS', 'HRRR', 'NEXRAD', 'SLOSH', 'MOM',
  'USGS', 'HIVIS', 'IEM', 'FEMA', 'NSS', 'TXDOT', 'TXGIO', 'USNG', 'MGRS', 'GPS', 'HLS', 'S3',
  'HTTP', 'HTTPS', 'API', 'URL', 'JSON', 'CSV', 'IV', 'LSR', 'LID', 'ARC', 'QR', 'ICS', 'RSS']);
const EXEMPT_RUNS = new Map([
  ['RESPONDER TX SITREP', 'SITREP is a fixed-format interop text product, English by design'],
  ['CUT-OFF AREAS', 'SITREP section label'],
  ['ACTIVE CRITICAL', 'SITREP section label'],
  ['ACTIVE NOTICES TOTAL', 'SITREP section label'],
  ['NOT IN', 'ArcGIS/NWPS where= predicate sent upstream, never rendered'],
  ['NOT LIKE', 'ArcGIS/NWPS where= predicate sent upstream, never rendered'],
  ['IS NULL OR UPPER', 'ArcGIS/NWPS where= predicate sent upstream, never rendered'],
  ['RADAR INDICATED', 'CAP parameters.tornadoDetection value compared against upstream, never rendered'],
]);
const WARN_LITERAL = new RegExp('⚠[ \t]*[A-Za-zÀ-ɏ]');
const CAPS_RUN = /\b[A-Z][A-Z0-9]+(?:['’-][A-Z]+)?(?:[ ,:;.]+[A-Z][A-Z0-9]+(?:['’-][A-Z]+)?)+\b/g;

/* Reads the string literals out of JS source. Template interpolations collapse to a space, so
 * `${label} DATA ${n} MIN OLD` still reads as one caps run. Regex literals are skipped: an
 * unskipped /['"]/ would open a phantom string and silently swallow the rest of the file. */
const REGEX_LEAD = /[(,=:[!&|?{};+\-*%~^<>]$|\breturn$|\btypeof$|\bcase$/;
function stringLiterals(src) {
  const out = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1, buf = '';
      while (j < src.length) {
        if (src[j] === '\\') { buf += src[j + 1]; j += 2; continue; }
        if (src[j] === c) break;
        if (c === '`' && src[j] === '$' && src[j + 1] === '{') {
          let d = 1; j += 2;
          while (j < src.length && d > 0) { if (src[j] === '{') d++; else if (src[j] === '}') d--; j++; }
          buf += ' '; continue;
        }
        if (c !== '`' && src[j] === '\n') break;
        buf += src[j]; j++;
      }
      out.push(buf); i = j + 1; continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/') {
      const before = src.slice(0, i).replace(/\s+$/, '');
      if (before === '' || REGEX_LEAD.test(before)) {
        let j = i + 1, inClass = false;
        while (j < src.length) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          else if (src[j] === '/' && !inClass) break;
          else if (src[j] === '\n') break;
          j++;
        }
        i = j + 1; continue;
      }
    }
    i++;
  }
  return out;
}

function shoutingLiterals(readSource, files) {
  const hits = [];
  for (const f of files) {
    for (const s of stringLiterals(readSource(f))) {
      if (WARN_LITERAL.test(s)) hits.push(`${f}: warning-glyph literal ${JSON.stringify(s).slice(0, 90)}`);
      for (const run of s.match(CAPS_RUN) || []) {
        if (EXEMPT_RUNS.has(run)) continue;
        if (run.split(/[ ,:;.]+/).every((w) => ACRONYMS.has(w))) continue;
        hits.push(`${f}: all-caps literal "${run}" in ${JSON.stringify(s).slice(0, 90)}`);
      }
    }
  }
  return hits;
}

test('renderer guard: no warning-glyph or all-caps literal is hardcoded in a renderer', () => {
  assert.deepEqual(shoutingLiterals(strippedSource, RENDER_FILES), [],
    'a life-safety literal is hardcoded in a renderer (route it through t() with en + es)');
});

test('renderer guard: the structural detector actually fires on the v0.99.3 regressions', () => {
  const fixture = {
    'banner.js': "$('#banner-text').textContent = `⚠ NEW FLASH FLOOD EMERGENCY: ${areas}`;",
    'age.js': 'text = `⚠ ${label} DATA ${n} MIN OLD: refresh failing`;',
    'clean.js': "const a = 'Storm surge risk (NHC SLOSH)'; const b = t('age.old'); const c = /['\"]/;",
  };
  const hits = shoutingLiterals((f) => fixture[f], Object.keys(fixture));
  assert.equal(hits.filter((h) => h.startsWith('banner.js')).length, 2, 'the banner regression must fire on both rules');
  assert.equal(hits.filter((h) => h.startsWith('age.js')).length, 2, 'the data-age regression must fire on both rules');
  assert.deepEqual(hits.filter((h) => h.startsWith('clean.js')), [],
    'an acronym run, a t() call and a quote-bearing regex are not shouting');
});

/* 911-gate alignment. The footer ships hardcoded markup that applyI18n overwrites at boot, so a
 * divergence means the pre-boot and post-boot disclaimers make different promises. Both must be
 * the complete one, and both languages must name 911. */
test('index.html: the footer disclaimer fallback is exactly the en string it is replaced by', () => {
  const html = indexHtml();
  const m = html.match(/<span class="disc-short" data-i18n-html="disc\.short">([\s\S]*?)<\/span>/);
  assert.ok(m, '.disc-short fallback span not found in index.html');
  assert.equal(m[1], I18N.en['disc.short'], 'index.html fallback and i18n en disc.short have diverged');
  for (const lang of ['en', 'es']) assert.match(I18N[lang]['disc.short'], /911/, `${lang} disc.short lost the 911 line`);
});

/* Attribute guard. A title= or aria-label= with no data-i18n-* is a tooltip that only ever renders
 * in English; applyI18n cannot reach it. The banner dismiss control shipped that way. */
test('index.html: every title and aria-label is routed through i18n', () => {
  const html = indexHtml();
  const bad = [];
  for (const tag of html.matchAll(/<([a-z]+)\b([^>]*)>/g)) {
    if (tag[1] === 'link' || tag[1] === 'meta') continue; // document-head metadata, not UI chrome
    const attrs = tag[2];
    if (/\btitle="/.test(attrs) && !/\bdata-i18n-title=/.test(attrs)) bad.push(`title: <${tag[1]}${attrs}>`.slice(0, 100));
    if (/\baria-label="/.test(attrs) && !/\bdata-i18n-aria=/.test(attrs)) bad.push(`aria-label: <${tag[1]}${attrs}>`.slice(0, 100));
  }
  assert.deepEqual(bad, [], 'untranslated title/aria-label in index.html (add data-i18n-title / data-i18n-aria)');
});

/* The data-age bar has two behaviours a translation pass can silently break: the per-second tick
 * must keep short-circuiting on an unchanged signature, and the dismissal key must not carry a
 * localized token or switching language would un-dismiss the bar. */
test('the data-age bar localizes before the tick short-circuit, and its dismissal key stays language-free', () => {
  const boot = strippedSource('boot.js');
  const fn = boot.match(/function renderDataAgeBar\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'renderDataAgeBar() not found in js/boot.js');
  const body = fn[0];
  for (const k of ['age.lbl.gauges', 'age.lbl.alerts', 'age.snapshot', 'age.never', 'age.old', 'age.usgs']) {
    assert.ok(body.includes(`'${k}'`), `renderDataAgeBar() no longer reads ${k}`);
  }
  assert.match(body, /const key = `\$\{worst\.k\}\|\$\{cls\}`/,
    'the dismissal key must stay ${worst.k}|${cls}: a localized token in it un-dismisses the bar on a language switch');
  assert.match(body, /const sig = `\$\{key\}\|\$\{text\}`/, 'the tick signature must include the rendered text');
  const lastTextAssign = [...body.matchAll(/\btext = /g)].pop();
  assert.ok(lastTextAssign && body.indexOf('const sig =') > lastTextAssign.index,
    'text must be localized BEFORE the signature is compared, or the tick renders a stale language');
  assert.match(body, /if \(el\.dataset\.sig === sig\) return;/, 'the per-second tick lost its DOM short-circuit');
});

test('i18n: the life-safety cue keys exist in both languages with placeholders intact', () => {
  const keys = ['banner.ffe', 'banner.dismiss', 'banner.dismiss.aria', 'alert.flag.emerg',
    'age.lbl.gauges', 'age.lbl.alerts', 'age.snapshot', 'age.never', 'age.old', 'age.usgs',
    'age.dismiss', 'map.mylocation', 'changelog.err', 'ctl.version.title', 'intake.geocode.title',
    'flt.sort.title', 'flt.window.title', 'flt.dist.title', 'flt.aged.title'];
  for (const k of keys) {
    for (const lang of ['en', 'es']) {
      assert.ok(typeof I18N[lang][k] === 'string' && I18N[lang][k].length, `${lang} missing ${k}`);
      assert.ok(!I18N[lang][k].includes('—'), `em-dash in ${lang} ${k}`);
    }
    assert.notEqual(I18N.en[k], I18N.es[k], `${k} was never actually translated`);
    for (const ph of I18N.en[k].match(/\{[a-z]+\}/g) || []) {
      assert.ok(I18N.es[k].includes(ph), `es ${k} missing placeholder ${ph}`);
    }
  }
  // the alarm itself must survive translation: both languages say emergency, in caps
  assert.match(I18N.en['banner.ffe'], /FLASH FLOOD EMERGENCY/);
  assert.match(I18N.es['banner.ffe'], /EMERGENCIA DE INUNDACIÓN REPENTINA/);
});
