'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

// in-memory CacheStorage stand-in: name -> Map(key -> value). Enough surface for the
// activate-time cache bookkeeping and the archive routes (keys/open/delete, and per-cache
// keys/match/put/delete). Per-cache keys() yields {url} the way the real Cache API does.
function makeCaches(seed = {}) {
  const store = new Map(Object.entries(seed).map(([n, m]) => [n, new Map(Object.entries(m))]));
  const wrap = (name) => ({
    async keys() { return [...(store.get(name) || new Map()).keys()].map((url) => ({ url })); },
    async match(k) { return (store.get(name) || new Map()).get(String(k && k.url ? k.url : k)); },
    async put(k, v) {
      if (!store.has(name)) store.set(name, new Map());
      store.get(name).set(String(k && k.url ? k.url : k), v);
    },
    async delete(k) { return (store.get(name) || new Map()).delete(String(k && k.url ? k.url : k)); },
  });
  return {
    _store: store,
    async keys() { return [...store.keys()]; },
    async open(name) { if (!store.has(name)) store.set(name, new Map()); return wrap(name); },
    async delete(name) { return store.delete(name); },
  };
}

// minimal Response stand-in: only ok/clone/json/text are reached by the code under test
function mkRes(body, ok = true) {
  return { ok, url: '', clone() { return this; }, async json() { return body; }, async text() { return String(body); } };
}

// Evaluate sw.js top-level in a vm with minimal SW globals; the epilogue
// exports the constants under test (same non-invasive pattern as harness.js).
function loadSw(caches = makeCaches(), fetchImpl = null) {
  const src = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const listeners = [];
  const sandbox = {
    self: {
      addEventListener(type) { listeners.push(type); },
      location: { origin: 'https://respondertx.org', href: 'https://respondertx.org/sw.js' },
      navigator: {},
    },
    caches,
    URL,
    fetch: fetchImpl || (async () => { throw new Error('offline'); }),
  };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\nvar __exports = { SW_VERSION, PRECACHE, PRECACHE_PATHS, PRECACHE_UNSTAMPED, LAZY_PATHS, CACHE_STATIC, CACHE_DATA, CACHE_PUSH, CACHE_HISTORY, PUSH_FALLBACK, dataCacheKey, adoptLegacyDataCache, historyDayOf, pruneHistoryChunks, historyIndexNetworkFirst, historyChunkCacheFirst, warmHistoryCache, HISTORY_INDEX_RE, HISTORY_DAY_RE, HISTORY_DAYS_KEPT, HISTORY_WARM_BYTES, HISTORY_WARM_MAX_DAYS, HISTORY_WARM_MAX_AGE_MS };`, sandbox);
  sandbox.__exports.listeners = listeners;
  sandbox.__exports.caches = caches;
  sandbox.__exports.self = sandbox.self;
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
  const sweep = src.match(/\.filter\(\(n\) => n\.indexOf\('respondertx-'\)[\s\S]*?\)\n/);
  assert.ok(sweep, 'activate cleanup sweep not found');
  for (const c of ['CACHE_STATIC', 'CACHE_DATA', 'CACHE_PUSH']) {
    assert.ok(sweep[0].includes(`n !== ${c}`), `activate cleanup must exclude ${c}`);
  }
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

/* ---------- playback archive cache (history/index.json + history/day/*.json) ---------- */

const SWLOC = 'https://respondertx.org/sw.js';
const IDX = 'https://respondertx.org/history/index.json';
const DAY = (d, h) => `https://respondertx.org/history/day/${d}.json?h=${h}`;

test('the playback archive lives outside /data/, so it needs its own route to be cached at all', () => {
  const src = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  // the /data/ route is the only thing that ever filled a cache, and history/ does not match it
  assert.ok(!'/history/index.json'.startsWith('/data/'));
  assert.ok(!'/history/day/2026-07-25.json'.startsWith('/data/'));
  assert.match(src, /HISTORY_INDEX_RE\.test\(url\.pathname\)[\s\S]{0,120}historyIndexNetworkFirst/);
  assert.match(src, /HISTORY_DAY_RE\.test\(url\.pathname\)[\s\S]{0,120}historyChunkCacheFirst/);
});

test('the archive cache is version-independent, distinct, and survives the activate cleanup', () => {
  assert.equal(sw.CACHE_HISTORY, 'respondertx-history');
  assert.ok(!sw.CACHE_HISTORY.includes(sw.SW_VERSION), 'a release must not empty the offline archive');
  assert.equal(sw.CACHE_HISTORY.indexOf('respondertx-'), 0);
  for (const other of [sw.CACHE_STATIC, sw.CACHE_DATA, sw.CACHE_PUSH]) assert.notEqual(sw.CACHE_HISTORY, other);
  const src = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.match(src, /n !== CACHE_PUSH && n !== CACHE_HISTORY/, 'activate cleanup must exclude CACHE_HISTORY');
  // the legacy carry-over reads respondertx-data-* only, so the new cache cannot disturb it
  assert.ok(sw.CACHE_HISTORY.indexOf(`${sw.CACHE_DATA}-`) !== 0);
});

test('only the two archive artifacts match the archive routes', () => {
  for (const p of ['/history/index.json', '/sub/history/index.json']) assert.ok(sw.HISTORY_INDEX_RE.test(p), p);
  for (const p of ['/history/day/2026-07-25.json', '/sub/history/day/2026-01-01.json']) assert.ok(sw.HISTORY_DAY_RE.test(p), p);
  for (const p of ['/data/history.json', '/history/day/index.json', '/history/index.jsonx', '/historyindex.json']) {
    assert.ok(!sw.HISTORY_INDEX_RE.test(p) && !sw.HISTORY_DAY_RE.test(p), `unexpected archive match: ${p}`);
  }
  assert.equal(sw.historyDayOf(DAY('2026-07-25', 'abc123')), '2026-07-25');
  assert.equal(sw.historyDayOf('https://respondertx.org/data/history.json'), '');
});

test('the index is network-first and keyed by bare path, so the cache-buster still matches offline', async () => {
  const caches = makeCaches();
  const online = loadSw(caches, async () => mkRes({ days: [{ d: '2026-07-25' }] }));
  await online.historyIndexNetworkFirst({ url: `${IDX}?_=12345` });
  assert.deepEqual([...caches._store.get('respondertx-history').keys()], [IDX], 'one copy, keyed bare');
  const offline = loadSw(caches);
  const hit = await offline.historyIndexNetworkFirst({ url: `${IDX}?_=99999` });
  assert.deepEqual(await hit.json(), { days: [{ d: '2026-07-25' }] }, 'a different buster must still hit');
});

test('a day chunk is cache-first on its whole hashed URL: a hit costs no request, a re-hash refetches', async () => {
  const caches = makeCaches();
  let calls = 0;
  const s = loadSw(caches, async (req) => { calls++; return mkRes({ frames: [{ t: req.url }] }); });
  await s.historyChunkCacheFirst({ url: DAY('2026-07-25', 'aaa') });
  assert.equal(calls, 1);
  await s.historyChunkCacheFirst({ url: DAY('2026-07-25', 'aaa') });
  assert.equal(calls, 1, 'the identical hashed URL must be served from cache');
  await s.historyChunkCacheFirst({ url: DAY('2026-07-25', 'bbb') });
  assert.equal(calls, 2, 'a re-hashed day is a different URL and must go to the network');
});

test('a day keeps exactly one cached copy however often it re-hashes', async () => {
  const caches = makeCaches();
  const s = loadSw(caches, async () => mkRes({ frames: [] }));
  for (const h of ['aaa', 'bbb', 'ccc']) await s.historyChunkCacheFirst({ url: DAY('2026-07-25', h) });
  await s.historyChunkCacheFirst({ url: DAY('2026-07-24', 'zzz') });
  assert.deepEqual([...caches._store.get('respondertx-history').keys()].sort(),
    [DAY('2026-07-24', 'zzz'), DAY('2026-07-25', 'ccc')].sort());
});

test('the cached day set is capped, oldest first, so a rolled-off day cannot linger forever', async () => {
  const caches = makeCaches();
  const s = loadSw(caches, async () => mkRes({ frames: [] }));
  const day = (n) => `2026-${String(Math.floor(n / 28) + 1).padStart(2, '0')}-${String((n % 28) + 1).padStart(2, '0')}`;
  for (let i = 0; i < sw.HISTORY_DAYS_KEPT + 3; i++) await s.historyChunkCacheFirst({ url: DAY(day(i), 'h') });
  const kept = [...caches._store.get('respondertx-history').keys()].map(s.historyDayOf).sort();
  assert.equal(kept.length, sw.HISTORY_DAYS_KEPT);
  assert.equal(kept[0], day(3), 'the three oldest days are the ones dropped');
});

test('offline, a chunk we never cached fails rather than serving another hash under its URL', async () => {
  const caches = makeCaches();
  const warm = loadSw(caches, async () => mkRes({ frames: [{ t: 'old' }] }));
  await warm.historyChunkCacheFirst({ url: DAY('2026-07-25', 'aaa') });
  const offline = loadSw(caches);
  await assert.rejects(offline.historyChunkCacheFirst({ url: DAY('2026-07-25', 'bbb') }),
    'a hashed URL must never answer with bytes that are not its own; playback labels the hole instead');
});

// a warm fixture: index days newest-last (the shape the generator publishes), sized in bytes
function warmSw(caches, idx, opts = {}) {
  const seen = [];
  const s = loadSw(caches, async (u) => {
    const url = String(u && u.url ? u.url : u);
    seen.push(url);
    if (opts.failDay && url.includes(opts.failDay)) return mkRes(null, false);
    return Object.assign(mkRes(url.includes('index.json') ? idx : { frames: [] }), { url: new URL(url, SWLOC).href });
  });
  s.seen = seen;
  s.chunks = () => seen.filter((u) => u.includes('/day/'));
  return s;
}

const warmIdx = (days, generated) => ({ generated: generated || new Date().toISOString(), days });

test('the warm takes the newest days first, inside the byte budget the index itself declares', async () => {
  const caches = makeCaches();
  const half = Math.ceil(sw.HISTORY_WARM_BYTES / 2);
  const s = warmSw(caches, warmIdx([
    { d: '2026-07-22', h: 'a', bytes: half }, { d: '2026-07-23', h: 'b', bytes: half },
    { d: '2026-07-24', h: 'c', bytes: half }, { d: '2026-07-25', h: 'd', bytes: half },
  ]));
  await s.warmHistoryCache();
  assert.deepEqual([...caches._store.get('respondertx-history').keys()].sort(),
    [IDX, DAY('2026-07-25', 'd'), DAY('2026-07-24', 'c')].sort(),
    'newest-first until the declared bytes run out');
});

test('the warm always takes the newest day, even when that one day exceeds the whole budget', async () => {
  const caches = makeCaches();
  const s = warmSw(caches, warmIdx([{ d: '2026-07-24', h: 'a', bytes: 10 }, { d: '2026-07-25', h: 'b', bytes: sw.HISTORY_WARM_BYTES * 4 }]));
  await s.warmHistoryCache();
  assert.deepEqual([...caches._store.get('respondertx-history').keys()].sort(), [IDX, DAY('2026-07-25', 'b')].sort());
});

test('the warm publishes no index it cannot back with the newest chunk', async () => {
  const caches = makeCaches();
  const s = warmSw(caches, warmIdx([{ d: '2026-07-25', h: 'c', bytes: 10 }]), { failDay: '2026-07-25' });
  await s.warmHistoryCache();
  assert.equal(caches._store.has('respondertx-history') && caches._store.get('respondertx-history').size, 0,
    'an index naming a chunk we do not hold reads offline as no archive at all');
});

test('the warm leaves a recent archive alone, so a busy release day is not a re-download per update', async () => {
  const caches = makeCaches({
    'respondertx-history': {
      [IDX]: mkRes(warmIdx([{ d: '2026-07-25', h: 'c', bytes: 10 }])),
      [DAY('2026-07-25', 'c')]: mkRes({ frames: [] }),
    },
  });
  const s = warmSw(caches, warmIdx([{ d: '2026-07-25', h: 'z', bytes: 10 }]));
  await s.warmHistoryCache();
  assert.deepEqual(s.seen, [], 'no request at all while the cached index is fresh and its day is held');
});

test('the warm tops up once the cached archive ages past the max age', async () => {
  const old = new Date(Date.now() - 24 * 3600000).toISOString();
  const caches = makeCaches({
    'respondertx-history': {
      [IDX]: mkRes(warmIdx([{ d: '2026-07-25', h: 'c', bytes: 10 }], old)),
      [DAY('2026-07-25', 'c')]: mkRes({ frames: [] }),
    },
  });
  const s = warmSw(caches, warmIdx([{ d: '2026-07-25', h: 'z', bytes: 10 }]));
  await s.warmHistoryCache();
  assert.deepEqual(s.chunks().map((u) => new URL(u, SWLOC).href), [DAY('2026-07-25', 'z')]);
  assert.deepEqual([...caches._store.get('respondertx-history').keys()].sort(), [IDX, DAY('2026-07-25', 'z')].sort(),
    'the superseded copy of the day is pruned, so the cache keeps one copy per day');
});

test('the warm is skipped on a save-data connection and never throws when the archive is absent', async () => {
  const saver = loadSw(makeCaches(), async () => { throw new Error('should not be called'); });
  saver.self.navigator.connection = { saveData: true };
  await assert.doesNotReject(saver.warmHistoryCache());
  assert.equal((saver.caches._store.get('respondertx-history') || new Map()).size, 0);
  const missing = loadSw(makeCaches(), async () => mkRes(null, false));
  await assert.doesNotReject(missing.warmHistoryCache(), 'a deploy without history/ must not break activation');
  const dead = loadSw(makeCaches());
  await assert.doesNotReject(dead.warmHistoryCache(), 'an offline activate must not break activation');
});

// the app shell and the precache are the same list stated twice, so assert it both ways
const indexStampedRefs = () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  return [...html.matchAll(/(?:src|href)="((?:js|css)\/[^"]+\?v=[^"]+)"/g)].map((m) => m[1]);
};

test('precache covers every stamped local script and stylesheet in index.html', () => {
  const refs = indexStampedRefs();
  assert.ok(refs.length >= 15, `expected stamped js/css refs in index.html, found ${refs.length}`);
  for (const ref of refs) {
    assert.ok(sw.PRECACHE.includes(ref), `index.html asset missing from precache: ${ref}`);
  }
});

test('the precache holds nothing beyond the shell index.html actually loads', () => {
  const refs = indexStampedRefs();
  // PRECACHE is built inside the vm realm, so compare as plain strings rather than deepEqual
  const extra = [...sw.PRECACHE]
    .filter((u) => /^(?:js|css)\//.test(u) && !sw.PRECACHE_UNSTAMPED.includes(u))
    .filter((u) => !refs.includes(u));
  assert.equal(extra.join(', '), '',
    'precached js/css the shell never loads: it costs every install and nothing renders it');
});

/* v0.99.43: the four heaviest optional assets install-cached for every visitor, including the
   ones who never open a camera, a QR, or a team. They are fetched on first use now, and
   stampedCacheFirst keeps them afterwards. */

test('the lazy assets are excluded from the install precache and exist on disk', () => {
  assert.ok(sw.LAZY_PATHS.length, 'LAZY_PATHS must name the on-demand set');
  for (const p of sw.LAZY_PATHS) {
    assert.ok(fs.existsSync(path.join(ROOT, p)), `lazy asset missing on disk: ${p}`);
    assert.ok(!sw.PRECACHE.some((u) => u.split('?')[0] === p), `lazy asset is still precached: ${p}`);
  }
  for (const p of ['css/team.css', 'js/team.js', 'js/vendor/hls.light.min.js', 'js/vendor/qrcode.min.js']) {
    assert.ok(sw.LAZY_PATHS.includes(p), `${p} must stay in the on-demand set`);
  }
});

test('re-listing a lazy path in PRECACHE_PATHS cannot put it back on the install path', () => {
  // discriminating power: the guard is the filter in sw.js, not the tidiness of the list above it
  const src = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.match(src, /PRECACHE_PATHS\s*\.filter\(\(p\) => LAZY_PATHS\.indexOf\(p\) < 0\)/,
    'PRECACHE must filter LAZY_PATHS out rather than trusting the list to stay correct');
  const both = [...sw.PRECACHE_PATHS].filter((p) => sw.LAZY_PATHS.includes(p));
  assert.equal([...sw.PRECACHE].filter((u) => both.includes(u.split('?')[0])).join(', '), '');
});

test('a lazy asset is still stamped, so one fetch caches it for every later open', () => {
  // stampedCacheFirst is keyed on the ?v= query; an unstamped lazy URL would refetch every time
  const core = fs.readFileSync(path.join(ROOT, 'js', 'core.js'), 'utf8');
  assert.match(core, /const assetUrl = \(path\) => `\$\{path\}\?v=\$\{APP_VERSION/,
    'lazy URLs must carry the release stamp or the service worker will not cache-first them');
  const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.match(swSrc, /if \(url\.searchParams\.has\('v'\)\) event\.respondWith\(stampedCacheFirst\(req\)\)/,
    'the stamped cache-first route is what makes a lazily fetched asset survive to the next open');
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
