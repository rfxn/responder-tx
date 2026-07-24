'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

// Evaluate sw.js top-level in a vm with minimal SW globals; the epilogue
// exports the constants under test (same non-invasive pattern as harness.js).
function loadSw() {
  const src = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const sandbox = {
    self: { addEventListener() {}, location: { origin: 'https://respondertx.org' } },
    caches: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\nvar __exports = { SW_VERSION, PRECACHE, CACHE_STATIC, CACHE_DATA };`, sandbox);
  return sandbox.__exports;
}

const sw = loadSw();

test('SW_VERSION agrees with APP_VERSION in js/core.js', () => {
  const core = fs.readFileSync(path.join(ROOT, 'js', 'core.js'), 'utf8');
  const m = core.match(/APP_VERSION = 'v([^']+)'/);
  assert.ok(m, 'APP_VERSION not found in js/core.js');
  assert.equal(sw.SW_VERSION, m[1]);
});

test('cache names are keyed to the version', () => {
  assert.ok(sw.CACHE_STATIC.includes(sw.SW_VERSION));
  assert.ok(sw.CACHE_DATA.includes(sw.SW_VERSION));
  assert.notEqual(sw.CACHE_STATIC, sw.CACHE_DATA);
});

test('precache excludes the LAN-only clients the public mirror strips', () => {
  for (const url of sw.PRECACHE) {
    assert.ok(!url.includes('js/chat.js'), `js/chat.js in precache: ${url}`);
    assert.ok(!url.includes('js/master.js'), `js/master.js in precache: ${url}`);
  }
});

test('precache is same-origin relative and never touches /api/', () => {
  for (const url of sw.PRECACHE) {
    assert.ok(!/^https?:/i.test(url), `absolute URL in precache: ${url}`);
    assert.ok(!url.includes('/api/'), `/api/ URL in precache: ${url}`);
  }
});

test('every entry except the shell root carries the exact version stamp', () => {
  for (const url of sw.PRECACHE) {
    if (url === './') continue;
    assert.ok(url.endsWith(`?v=${sw.SW_VERSION}`), `unstamped precache entry: ${url}`);
  }
});

test('precache covers every stamped local script and stylesheet in index.html', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const refs = [];
  const re = /(?:src|href)="((?:js|css)\/[^"]+\?v=[^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) refs.push(m[1]);
  assert.ok(refs.length >= 15, `expected stamped js/css refs in index.html, found ${refs.length}`);
  for (const ref of refs) {
    assert.ok(sw.PRECACHE.includes(ref), `index.html asset missing from precache: ${ref}`);
  }
});

test('every precached file exists in the repo', () => {
  for (const url of sw.PRECACHE) {
    if (url === './') continue;
    const file = url.split('?')[0];
    assert.ok(fs.existsSync(path.join(ROOT, file)), `precached file missing on disk: ${file}`);
  }
});
