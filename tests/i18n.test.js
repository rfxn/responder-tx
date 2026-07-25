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
const RENDER_FILES = ['core.js', 'map.js', 'sources.js', 'panels.js', 'board.js', 'boot.js'];

function strippedSource(file) {
  return fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, ''); // full-line comments only; inline comments after code are kept
}

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
    'push.toggle.on', 'push.toggle.off', 'push.err'];
  for (const k of keys) {
    assert.ok(typeof I18N.en[k] === 'string' && I18N.en[k].length, `en missing ${k}`);
    assert.ok(typeof I18N.es[k] === 'string' && I18N.es[k].length, `es missing ${k}`);
    assert.ok(!I18N.en[k].includes('—'), `em-dash in en ${k}`);
    assert.ok(!I18N.es[k].includes('—'), `em-dash in es ${k}`);
  }
  // the not-a-WEA/911 invariant must be present on the disclaimer in both languages
  assert.ok(/call 911/i.test(I18N.en['push.disclaimer']));
  assert.ok(/Wireless Emergency Alerts/.test(I18N.en['push.disclaimer']));
  assert.ok(/llame al 911/i.test(I18N.es['push.disclaimer']));
  assert.ok(/WEA/.test(I18N.es['push.disclaimer']));
});

test('i18n: offline-panel keys exist in both languages with placeholders intact', () => {
  const keys = ['off.toggle.title', 'off.toggle.aria', 'off.head', 'off.save', 'off.save.title',
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

/* Placement guard (v0.97.91). The export/import controls and the CalTopo box moved out of the
   Feed > More drawer into Resources > Data & interchange, and the drawer itself is gone. The
   listeners in js/boot.js keep the same element ids, so nothing would fail loudly if the markup
   drifted back; assert the containment instead. */
test('the interchange controls live in Resources, and Feed > More is gone', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');
  for (const gone of ['id="more-toggle"', 'id="more-menu"']) {
    assert.ok(!html.includes(gone), `index.html still declares ${gone}`);
  }
  const resources = html.slice(html.indexOf('id="tab-resources"'), html.indexOf('id="tab-team"'));
  assert.ok(resources.includes('id="interchange-body"'), '#interchange-body is not inside #tab-resources');
  for (const id of ['export-btn', 'export-geo-btn', 'caltopo-btn', 'aar-btn', 'import-file', 'caltopo-box']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `#${id} is not declared exactly once`);
    assert.ok(resources.includes(`id="${id}"`), `#${id} did not move into Resources`);
  }
  const boot = fs.readFileSync(path.join(__dirname, '..', 'js', 'boot.js'), 'utf8');
  assert.ok(!/#more-toggle|#more-menu/.test(boot), 'js/boot.js still wires the retired Feed > More drawer');
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'app.css'), 'utf8');
  assert.ok(!/#more-menu|#more-toggle/.test(css), 'css/app.css still styles the retired Feed > More drawer');
});

/* Settings sheet (v0.97.92). The header ⋮ became a labelled gear holding Display, Alerts,
   Actions and Help. The device-alerts card moved into it from Resources, so #push-body must be
   declared exactly once and in its new home, and the retired Team shortcut must be gone from
   markup, wiring and both languages. */
function indexHtml() {
  return fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
}

test('the settings sheet declares menu roles and holds the alerts card', () => {
  const html = indexHtml();
  const menu = html.slice(html.indexOf('<div id="hmore-menu"'), html.indexOf('<div class="refresh-meta">'));
  assert.ok(/<div id="hmore-menu" role="menu"/.test(html), '#hmore-menu is missing role="menu"');
  assert.ok(/id="hmore-btn"[^>]*aria-haspopup="true"/.test(html), '#hmore-btn lost aria-haspopup');
  // every button the menu owns directly is a menuitem; the alerts card's own buttons are not
  for (const id of ['theme-toggle', 'lang-toggle', 'share-btn', 'help-btn', 'whatsnew-btn', 'safety-btn']) {
    assert.ok(new RegExp(`id="${id}" role="menuitem"`).test(menu), `#${id} is not a role="menuitem" in the settings sheet`);
  }
  for (const g of ['set.g.display', 'set.g.alerts', 'set.g.actions', 'set.g.help']) {
    assert.ok(menu.includes(`data-i18n="${g}"`), `settings sheet is missing the ${g} heading`);
  }
  assert.equal((html.match(/id="push-body"/g) || []).length, 1, '#push-body is not declared exactly once');
  assert.ok(menu.includes('id="push-body"'), '#push-body did not move into the settings sheet');
  assert.ok(menu.includes('id="set-alerts"'), 'the Alerts group wrapper is missing');
  const resources = html.slice(html.indexOf('id="tab-resources"'), html.indexOf('id="tab-team"'));
  assert.ok(!resources.includes('id="push-body"'), '#push-body is still in Resources');
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

test('the Notify me entry point opens the settings sheet, not the Resources tab', () => {
  const board = fs.readFileSync(path.join(__dirname, '..', 'js', 'board.js'), 'utf8');
  const m = board.match(/function pushOpenManageFor\(lid\)[\s\S]*?\n\}/);
  assert.ok(m, 'pushOpenManageFor() not found in js/board.js');
  assert.ok(/openSettingsMenu\(\)/.test(m[0]), 'pushOpenManageFor should open the settings sheet');
  assert.ok(!/tab-resources/.test(m[0]), 'pushOpenManageFor still clicks the Resources tab');
  // the three resolvers of #push-body must all still find it in its new home
  for (const fn of ['renderPushCard', 'initPushCard']) {
    const f = board.match(new RegExp(`function ${fn}\\(\\)[\\s\\S]*?\\n\\}`));
    assert.ok(f, `${fn}() not found`);
    assert.ok(/\$\('#push-body'\)/.test(f[0]), `${fn}() no longer resolves #push-body`);
  }
  assert.ok(/async function pushBootSync\(\)/.test(board), 'pushBootSync() not found in js/board.js');
});

test('i18n: the settings sheet keys exist in both languages', () => {
  const keys = ['ctl.settings', 'ctl.settings.title', 'ctl.settings.aria',
    'set.g.display', 'set.g.alerts', 'set.g.actions', 'set.g.help', 'set.safety'];
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
