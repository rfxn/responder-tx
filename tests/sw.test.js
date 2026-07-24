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
  const listeners = [];
  const sandbox = {
    self: { addEventListener(type) { listeners.push(type); }, location: { origin: 'https://respondertx.org' } },
    caches: {},
    URL,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\nvar __exports = { SW_VERSION, PRECACHE, PRECACHE_UNSTAMPED, CACHE_STATIC, CACHE_DATA, CACHE_PUSH, PUSH_FALLBACK, dataCacheKey };`, sandbox);
  sandbox.__exports.listeners = listeners;
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

test('every entry except the shell root and css-relative images carries the exact version stamp', () => {
  for (const url of sw.PRECACHE) {
    if (url === './' || sw.PRECACHE_UNSTAMPED.includes(url)) continue;
    assert.ok(url.endsWith(`?v=${sw.SW_VERSION}`), `unstamped precache entry: ${url}`);
  }
  for (const url of sw.PRECACHE_UNSTAMPED) {
    assert.ok(!url.includes('?'), `PRECACHE_UNSTAMPED entry carries a query: ${url}`);
  }
});

test('precache vendors Leaflet js, css, and its image assets', () => {
  assert.ok(sw.PRECACHE.includes(`js/vendor/leaflet.js?v=${sw.SW_VERSION}`));
  assert.ok(sw.PRECACHE.includes(`js/vendor/leaflet.css?v=${sw.SW_VERSION}`));
  for (const img of ['marker-icon.png', 'marker-icon-2x.png', 'marker-shadow.png', 'layers.png', 'layers-2x.png']) {
    assert.ok(sw.PRECACHE.includes(`js/vendor/images/${img}`), `leaflet image missing from precache: ${img}`);
  }
});

test('no unpkg (or any CDN leaflet) reference remains in index.html or sw.js', () => {
  for (const f of ['index.html', 'sw.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/unpkg\.com/i.test(src), `unpkg reference in ${f}`);
    assert.ok(!/https?:\/\/[^"' ]*leaflet/i.test(src), `cross-origin leaflet reference in ${f}`);
  }
});

test('dataCacheKey maps a cache-busted URL and its bare form to the same key', () => {
  const bare = sw.dataCacheKey('https://respondertx.org/data/gauges-snapshot.json');
  const busted = sw.dataCacheKey(`https://respondertx.org/data/gauges-snapshot.json?_=${Date.now()}`);
  assert.equal(busted, bare);
  assert.equal(bare, 'https://respondertx.org/data/gauges-snapshot.json');
  const rel = sw.dataCacheKey('data/changelog.json?_=123');
  assert.equal(rel, 'https://respondertx.org/data/changelog.json');
  assert.notEqual(sw.dataCacheKey('data/changelog.json?_=1'), sw.dataCacheKey('data/history.json?_=1'));
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

/* ---------- web push (P1 payload-free) ---------- */

test('push and notificationclick handlers are registered', () => {
  for (const type of ['push', 'notificationclick']) {
    assert.ok(sw.listeners.includes(type), `missing ${type} listener`);
  }
});

test('push fallback table has en/es parity, the WEA/911 line, and no em-dash', () => {
  assert.deepEqual(Object.keys(sw.PUSH_FALLBACK).sort(), ['en', 'es']);
  assert.deepEqual(Object.keys(sw.PUSH_FALLBACK.en).sort(), Object.keys(sw.PUSH_FALLBACK.es).sort());
  assert.ok(sw.PUSH_FALLBACK.en.body.includes('Not a WEA/911 service'));
  assert.ok(sw.PUSH_FALLBACK.es.body.includes('No sustituye a WEA ni al 911'));
  for (const lang of ['en', 'es']) {
    for (const k of Object.keys(sw.PUSH_FALLBACK[lang])) {
      const v = sw.PUSH_FALLBACK[lang][k];
      assert.ok(typeof v === 'string' && v.length, `${lang}.${k} empty`);
      assert.ok(!v.includes('—'), `em-dash in PUSH_FALLBACK.${lang}.${k}`);
    }
  }
});

test('the push-lang cache is version-independent and survives the activate cleanup', () => {
  assert.ok(!sw.CACHE_PUSH.includes(sw.SW_VERSION), 'CACHE_PUSH must not be version-keyed');
  assert.ok(sw.CACHE_PUSH.indexOf('respondertx-') === 0, 'CACHE_PUSH stays in the app namespace');
  const src = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.match(src, /n !== CACHE_STATIC && n !== CACHE_DATA && n !== CACHE_PUSH/, 'activate cleanup must exclude CACHE_PUSH');
});

test('every precached file exists in the repo', () => {
  for (const url of sw.PRECACHE) {
    if (url === './') continue;
    const file = url.split('?')[0];
    assert.ok(fs.existsSync(path.join(ROOT, file)), `precached file missing on disk: ${file}`);
  }
});

test('push handler prefers the payload language over the cached hint (P2)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.match(src, /data\.lang === 'es' \|\| data\.lang === 'en'/, 'payload lang wins when present');
  assert.match(src, /await pushLang\(\)/, 'cached hint still localizes payload-free fallbacks');
});
