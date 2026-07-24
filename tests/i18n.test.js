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

/* Markup parity for the feed action rows. These controls shipped untranslated: the export,
   import, SITREP, filters, more, and new-notice buttons carried no data-i18n attribute at all,
   so a Spanish session still read them in English (v0.97.83 backfilled them). The check is
   positional rather than by id, so it keeps holding as later IA phases relocate these controls
   into a views sheet or a settings sheet. */
const FEED_ACTION_ROWS = /<div class="feed-actions"[^>]*>([\s\S]*?)<\/div>\s*(?=<div|<\/div>)/g;

function feedActionRows() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '');
  const rows = [...html.matchAll(FEED_ACTION_ROWS)].map((m) => m[1]);
  return rows;
}

test('i18n: every control in the feed action rows carries a data-i18n attribute', () => {
  const rows = feedActionRows();
  assert.ok(rows.length >= 2, `expected the feed-actions row and #more-menu, found ${rows.length}`);

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

test('i18n: feed and export control keys exist in both languages', () => {
  const keys = ['feed.new', 'feed.new.title', 'feed.sitrep', 'feed.sitrep.title',
    'feed.filters', 'feed.filters.n', 'feed.filters.title', 'feed.more', 'feed.more.title',
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
