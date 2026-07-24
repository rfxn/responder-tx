'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

// in-memory CacheStorage stand-in: name -> Map(key -> value). Enough surface for the
// activate-time cache bookkeeping (keys/open/delete, and per-cache keys/match/put).
function makeCaches(seed = {}) {
  const store = new Map(Object.entries(seed).map(([n, m]) => [n, new Map(Object.entries(m))]));
  const wrap = (name) => ({
    async keys() { return [...(store.get(name) || new Map()).keys()]; },
    async match(k) { return (store.get(name) || new Map()).get(String(k)); },
    async put(k, v) {
      if (!store.has(name)) store.set(name, new Map());
      store.get(name).set(String(k), v);
    },
  });
  return {
    _store: store,
    async keys() { return [...store.keys()]; },
    async open(name) { if (!store.has(name)) store.set(name, new Map()); return wrap(name); },
    async delete(name) { return store.delete(name); },
  };
}

// Evaluate sw.js top-level in a vm with minimal SW globals; the epilogue
// exports the constants under test (same non-invasive pattern as harness.js).
function loadSw(caches = makeCaches()) {
  const src = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const listeners = [];
  const sandbox = {
    self: { addEventListener(type) { listeners.push(type); }, location: { origin: 'https://respondertx.org' } },
    caches,
    URL,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\nvar __exports = { SW_VERSION, PRECACHE, PRECACHE_UNSTAMPED, CACHE_STATIC, CACHE_DATA, CACHE_PUSH, PUSH_FALLBACK, dataCacheKey, adoptLegacyDataCache };`, sandbox);
  sandbox.__exports.listeners = listeners;
  sandbox.__exports.caches = caches;
  return sandbox.__exports;
}

const sw = loadSw();

test('SW_VERSION agrees with APP_VERSION in js/core.js', () => {
  const core = fs.readFileSync(path.join(ROOT, 'js', 'core.js'), 'utf8');
  const m = core.match(/APP_VERSION = 'v([^']+)'/);
  assert.ok(m, 'APP_VERSION not found in js/core.js');
  assert.equal(sw.SW_VERSION, m[1]);
});

test('the app shell is version-keyed and the data cache deliberately is not', () => {
  // /data/ is not versioned by app release, and the copies here ARE the offline fallback.
  // Version-keying emptied that fallback on every accepted update toast: on a 17-release day
  // a responder who lost signal after an update had nothing left to fall back to.
  assert.ok(sw.CACHE_STATIC.includes(sw.SW_VERSION), 'the shell must version so a release invalidates it');
  assert.ok(!sw.CACHE_DATA.includes(sw.SW_VERSION), 'CACHE_DATA must not be version-keyed');
  assert.equal(sw.CACHE_DATA, 'respondertx-data');
  assert.notEqual(sw.CACHE_STATIC, sw.CACHE_DATA);
});

test('the data cache survives the activate cleanup, like the push cache', () => {
  const src = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.match(src, /n !== CACHE_STATIC && n !== CACHE_DATA && n !== CACHE_PUSH/,
    'activate cleanup must exclude CACHE_DATA');
  assert.match(src, /await adoptLegacyDataCache\(names\);[\s\S]*?caches\.delete/,
    'the carry-over must run before the retired caches are deleted');
});

test('adoptLegacyDataCache carries the last-good data over from the retired per-version caches', async () => {
  const s = loadSw(makeCaches({
    'respondertx-static-0.97.87': { 'https://respondertx.org/js/core.js?v=0.97.87': 'shell' },
    'respondertx-data-0.97.86': { 'https://respondertx.org/data/gauges-snapshot.json': 'older' },
    'respondertx-data-0.97.87': {
      'https://respondertx.org/data/gauges-snapshot.json': 'newest',
      'https://respondertx.org/data/roads-snapshot.json': 'roads',
    },
    'respondertx-push': { '/push-lang': 'es' },
  }));
  await s.adoptLegacyDataCache(await s.caches.keys());
  const adopted = s.caches._store.get('respondertx-data');
  assert.deepEqual([...adopted.keys()].sort(), [
    'https://respondertx.org/data/gauges-snapshot.json',
    'https://respondertx.org/data/roads-snapshot.json',
  ]);
  assert.equal(adopted.get('https://respondertx.org/data/gauges-snapshot.json'), 'newest',
    'the newest retired cache wins where two hold the same file');
});

test('adoptLegacyDataCache never clobbers a data cache that already has content', async () => {
  const s = loadSw(makeCaches({
    'respondertx-data': { 'https://respondertx.org/data/gauges-snapshot.json': 'fresh' },
    'respondertx-data-0.97.87': { 'https://respondertx.org/data/gauges-snapshot.json': 'stale' },
  }));
  await s.adoptLegacyDataCache(await s.caches.keys());
  assert.equal(s.caches._store.get('respondertx-data').get('https://respondertx.org/data/gauges-snapshot.json'), 'fresh');
});

test('adoptLegacyDataCache is a silent no-op on a first install and never throws', async () => {
  const s = loadSw(makeCaches({ 'respondertx-push': { '/push-lang': 'en' } }));
  await assert.doesNotReject(s.adoptLegacyDataCache(await s.caches.keys()));
  assert.equal(s.caches._store.has('respondertx-data'), false, 'no empty cache is created for nothing');
  const broken = loadSw({ async keys() { return ['respondertx-data-1']; }, async open() { throw new Error('cache unavailable'); } });
  await assert.doesNotReject(broken.adoptLegacyDataCache(['respondertx-data-1']), 'a cache failure must not block activation');
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

test('push, notificationclick, and pushsubscriptionchange handlers are registered', () => {
  for (const type of ['push', 'notificationclick', 'pushsubscriptionchange']) {
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
  assert.ok(sw.CACHE_DATA.indexOf('respondertx-') === 0, 'CACHE_DATA stays in the app namespace');
  assert.notEqual(sw.CACHE_PUSH, sw.CACHE_DATA);
});

test('every precached file exists in the repo', () => {
  for (const url of sw.PRECACHE) {
    if (url === './') continue;
    const file = url.split('?')[0];
    assert.ok(fs.existsSync(path.join(ROOT, file)), `precached file missing on disk: ${file}`);
  }
});

test('a payload-free push still lands on a page that shows the alerts card', () => {
  const src = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.match(src, /data: \{ url: \(data && data\.url\) \|\| '\/\?push=1' \}/,
    'the payload-free fallback url must carry the flag, or the notification lands with no off switch');
});

test('push handler prefers the payload language over the cached hint (P2)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.match(src, /data\.lang === 'es' \|\| data\.lang === 'en'/, 'payload lang wins when present');
  assert.match(src, /await pushLang\(\)/, 'cached hint still localizes payload-free fallbacks');
});

test('pushsubscriptionchange re-subscribes and migrates prefs (P3 self-heal)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.match(src, /api\/push\/resubscribe/, 'migrates the server row via resubscribe');
  assert.match(src, /oldEndpoint/, 'presents the old endpoint as the credential');
  assert.match(src, /\/push-key/, 'mirrored VAPID key covers a missing oldSubscription');
  assert.match(src, /\/push-prefs/, 'mirrored prefs back the fresh-subscribe fallback');
  assert.match(src, /api\/push\/subscribe/, 'fresh subscribe fallback when the old row is gone');
});
