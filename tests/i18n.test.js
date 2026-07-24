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
