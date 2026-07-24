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
