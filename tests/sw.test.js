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
    async addAll(urls) { for (const u of urls) await this.put(u, mkRes('')); },
  });
  return {
    _store: store,
    async keys() { return [...store.keys()]; },
    async open(name) { if (!store.has(name)) store.set(name, new Map()); return wrap(name); },
    async delete(name) { return store.delete(name); },
    async match(k) { // CacheStorage.match: first hit across every cache, the way stampedCacheFirst reads it
      const key = String(k && k.url ? k.url : k);
      for (const m of store.values()) if (m.has(key)) return m.get(key);
      return undefined;
    },
  };
}

// minimal Response stand-in: only ok/clone/json/text are reached by the code under test
function mkRes(body, ok = true) {
  return { ok, url: '', clone() { return this; }, async json() { return body; }, async text() { return String(body); } };
}

/* Evaluate sw.js top-level in a vm with minimal SW globals; the epilogue exports the constants
   under test (same non-invasive pattern as harness.js). The listeners sw.js registers are KEPT,
   not just counted, so `fire()` below can run the shipped install/activate/fetch/push handlers
   instead of matching their text. Everything the worker reaches through `self` records what it
   was asked to do. */
function loadSw(caches = makeCaches(), fetchImpl = null) {
  const src = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const listeners = [];
  const handlers = new Map();
  const log = { notifications: [], skipWaiting: 0, claimed: 0, subscribes: [], opened: [], focused: [], fetches: [] };
  const sandbox = {
    self: {
      addEventListener(type, fn) {
        listeners.push(type);
        if (!handlers.has(type)) handlers.set(type, []);
        handlers.get(type).push(fn);
      },
      location: { origin: 'https://respondertx.org', href: 'https://respondertx.org/sw.js' },
      navigator: {},
      skipWaiting() { log.skipWaiting++; },
      clients: {
        async claim() { log.claimed++; },
        async matchAll() { return log.windows || []; },
        async openWindow(u) { log.opened.push(u); },
      },
      registration: {
        async showNotification(title, opts) { log.notifications.push({ title, opts }); },
        pushManager: {
          async subscribe(opts) {
            log.subscribes.push(opts);
            return { toJSON: () => ({ endpoint: 'https://push.test/rotated' }) };
          },
        },
      },
    },
    caches,
    URL,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    fetch: async (...args) => {
      log.fetches.push(args);
      return (fetchImpl || (async () => { throw new Error('offline'); }))(...args);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\nvar __exports = { SW_VERSION, PRECACHE, PRECACHE_PATHS, PRECACHE_UNSTAMPED, LAZY_PATHS, CACHE_STATIC, CACHE_DATA, CACHE_PUSH, CACHE_HISTORY, PUSH_FALLBACK, dataCacheKey, adoptLegacyDataCache, historyDayOf, pruneHistoryChunks, historyIndexNetworkFirst, historyChunkCacheFirst, warmHistoryCache, HISTORY_INDEX_RE, HISTORY_DAY_RE, HISTORY_DAYS_KEPT, HISTORY_WARM_MAX_BYTES, HISTORY_WARM_MAX_DAYS, HISTORY_WARM_MAX_AGE_MS, historyWarmBudget, historyDayBytes };`, sandbox);
  sandbox.__exports.listeners = listeners;
  sandbox.__exports.handlers = handlers;
  sandbox.__exports.log = log;
  sandbox.__exports.caches = caches;
  sandbox.__exports.self = sandbox.self;
  return sandbox.__exports;
}

/* Runs the handler sw.js really registered for `type` and settles whatever it passed to
   waitUntil/respondWith, so an assertion can be made about the outcome rather than the source. */
async function fire(s, type, event = {}) {
  const list = s.handlers.get(type) || [];
  assert.ok(list.length, `sw.js registered no '${type}' listener`);
  const waits = [];
  const ev = { ...event };
  ev.waitUntil = (p) => { waits.push(p); };
  ev.respondWith = (p) => { ev.responded = p; waits.push(p); };
  for (const fn of list) fn(ev);
  await Promise.all(waits.map((p) => Promise.resolve(p).catch((e) => e)));
  if (ev.responded) { try { ev.response = await ev.responded; } catch (e) { ev.error = e; } }
  await new Promise((r) => setImmediate(r)); // let a detached best-effort task (the archive warm) settle
  return ev;
}

const getEvent = (url, extra = {}) => ({ request: { method: 'GET', mode: 'cors', url, ...extra } });

const sw = loadSw();

test('SW_VERSION agrees with the APP_VERSION the client actually runs on', () => {
  const { APP_VERSION } = require('./harness.js').loadApp();
  assert.match(APP_VERSION, /^v\d+\.\d+\.\d+$/, 'APP_VERSION is not a version string');
  assert.equal(sw.SW_VERSION, APP_VERSION.replace(/^v/, ''));
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

test('a real activate keeps the four live caches, drops the retired ones, and claims the clients', async () => {
  const caches = makeCaches({
    [`respondertx-static-${sw.SW_VERSION}`]: { './': 'this shell' },
    'respondertx-static-0.90.0': { './': 'a retired shell' },
    'respondertx-data': { 'https://respondertx.org/data/gauges-snapshot.json': 'last good' },
    'respondertx-push': { '/push-lang': 'es' },
    'respondertx-history': { [IDX]: 'archive index' },
    'respondertx-data-0.90.0': { 'https://respondertx.org/data/roads-snapshot.json': 'retired copy' },
    'someone-elses-cache': { '/x': 'not ours' },
  });
  const s = loadSw(caches);
  await fire(s, 'activate');

  assert.deepEqual((await caches.keys()).sort(), [
    'respondertx-data', 'respondertx-history', 'respondertx-push',
    `respondertx-static-${sw.SW_VERSION}`, 'someone-elses-cache',
  ].sort(), 'the activate sweep took a cache the board needs, or left a retired one behind');
  assert.equal(caches._store.get('respondertx-data').get('https://respondertx.org/data/gauges-snapshot.json'),
    'last good', 'the offline data fallback must survive the release that installed this worker');
  assert.equal(caches._store.get('respondertx-push').get('/push-lang'), 'es');
  assert.equal(caches._store.get('respondertx-history').get(IDX), 'archive index');
  assert.equal(s.log.claimed, 1, 'the new worker must take control of the open tabs');
});

test('activate carries the retired data cache over BEFORE it deletes it', async () => {
  // ordering, not text: adoption running after the sweep would drop the last-good copies on the
  // floor exactly once, on the release that stopped wiping them
  const caches = makeCaches({
    'respondertx-data-0.97.87': { 'https://respondertx.org/data/gauges-snapshot.json': 'carried' },
  });
  const s = loadSw(caches);
  await fire(s, 'activate');
  assert.deepEqual((await caches.keys()).sort(), ['respondertx-data', 'respondertx-history'].sort(),
    'the retired per-version data cache must be gone and the adopted one in its place');
  assert.equal(caches._store.get('respondertx-data').get('https://respondertx.org/data/gauges-snapshot.json'),
    'carried', 'the carry-over ran after the delete, so the last-good data was lost');
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

/* The fetch listener is the whole offline story: every route below is reached only by firing the
   handler sw.js registered, so a deleted route, a reordered guard or a throw on first dispatch
   fails here instead of shipping green behind a regex. */

test('the fetch router sends each artifact to the cache that owns its lifetime', async () => {
  const caches = makeCaches();
  const s = loadSw(caches, async (req) => mkRes(`body of ${req.url}`));
  const store = (n) => [...(caches._store.get(n) || new Map()).keys()];

  const nav = await fire(s, 'fetch', getEvent('https://respondertx.org/', { mode: 'navigate' }));
  assert.ok(nav.responded, 'a navigation must be answered by the worker, or there is no offline shell');
  assert.deepEqual(store(`respondertx-static-${sw.SW_VERSION}`), ['./']);

  // the playback archive lives outside /data/, so the data route never saw it and it needs its own
  const idx = await fire(s, 'fetch', getEvent(`${IDX}?_=99`));
  assert.ok(idx.responded, 'history/index.json is unrouted, so offline playback has no index');
  assert.deepEqual(store('respondertx-history'), [IDX], 'the index is keyed bare so a new buster still hits');

  await fire(s, 'fetch', getEvent(DAY('2026-07-25', 'abc')));
  assert.deepEqual(store('respondertx-history').sort(), [IDX, DAY('2026-07-25', 'abc')].sort(),
    'a day chunk is keyed on its whole hashed URL');

  await fire(s, 'fetch', getEvent('https://respondertx.org/data/gauges-snapshot.json?_=1'));
  assert.deepEqual(store('respondertx-data'), ['https://respondertx.org/data/gauges-snapshot.json']);

  await fire(s, 'fetch', getEvent('https://respondertx.org/js/vendor/images/layers.png'));
  assert.ok(store(`respondertx-static-${sw.SW_VERSION}`).some((u) => u.includes('layers.png')),
    'leaflet asks for its images unstamped, so they need the vendor-images route');
});

test('the fetch router keeps its hands off everything it must not intercept', async () => {
  const s = loadSw(makeCaches(), async (req) => mkRes(`body of ${req.url}`));
  const untouched = [
    getEvent('https://respondertx.org/api/push/subscribe'),
    getEvent('https://respondertx.org/api/chat'),
    getEvent('https://api.water.noaa.gov/nwps/v1/gauges'),
    getEvent('https://tile.openstreetmap.org/8/1/2.png'),
    getEvent('https://respondertx.org/data/notes.json', { method: 'POST' }),
    getEvent('https://respondertx.org/robots.txt'),
    getEvent('https://respondertx.org/data/history.geojson'),
  ];
  for (const ev of untouched) {
    const fired = await fire(s, 'fetch', ev);
    assert.equal(fired.responded, undefined,
      `the worker answered ${ev.request.method} ${ev.request.url}; it must pass straight through`);
  }
  assert.deepEqual(s.log.fetches, [], 'passing through means issuing no request of our own');
});

test('a stamped asset is fetched once and served from cache on every later open', async () => {
  const { assetUrl, APP_VERSION } = require('./harness.js').loadApp();
  const url = `https://respondertx.org/${assetUrl('js/team.js')}`;
  assert.ok(url.includes(`?v=${APP_VERSION.replace(/^v/, '')}`), 'assetUrl must stamp the release onto a lazy path');

  const caches = makeCaches();
  let hits = 0;
  const s = loadSw(caches, async () => { hits++; return mkRes('team code'); });
  const first = await fire(s, 'fetch', getEvent(url));
  assert.ok(first.responded, 'a ?v= stamped asset is unrouted; a lazily fetched file would refetch every open');
  assert.equal(hits, 1);
  await fire(s, 'fetch', getEvent(url));
  assert.equal(hits, 1, 'the second open must be served from the cache the first fetch filled');
});

test('the archive cache is version-independent, distinct, and survives the activate cleanup', () => {
  assert.equal(sw.CACHE_HISTORY, 'respondertx-history');
  assert.ok(!sw.CACHE_HISTORY.includes(sw.SW_VERSION), 'a release must not empty the offline archive');
  assert.equal(sw.CACHE_HISTORY.indexOf('respondertx-'), 0);
  for (const other of [sw.CACHE_STATIC, sw.CACHE_DATA, sw.CACHE_PUSH]) assert.notEqual(sw.CACHE_HISTORY, other);
  // survival across the activate sweep is asserted by running it, above
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

// The two constants describe one bound and drifted apart silently once: a budget literal sized on
// day sizes the index had outgrown warmed two days of a declared eight. The budget is now read off
// the index, so growth cannot shrink the depth; only the storage ceiling can, and it says so.
test('the declared depth warms in full whenever the ceiling can hold it', async () => {
  const caches = makeCaches();
  const day = (n) => ({ d: `2026-07-${String(n).padStart(2, '0')}`, h: `h${n}`, bytes: 400000 });
  const days = [];
  for (let n = 10; n < 10 + sw.HISTORY_WARM_MAX_DAYS + 2; n++) days.push(day(n));
  const s = warmSw(caches, warmIdx(days));
  await s.warmHistoryCache();
  assert.equal(s.chunks().length, sw.HISTORY_WARM_MAX_DAYS,
    'a budget derived from the index delivers the depth the index declares');
});

test('the warm budget is derived from the index, never a literal that can outdate', () => {
  const days = [{ bytes: 100 }, { bytes: 200 }, { bytes: 300 }];
  assert.equal(sw.historyWarmBudget(days), 600, 'the declared sizes are the budget');
  assert.equal(sw.historyWarmBudget([{ bytes: sw.HISTORY_WARM_MAX_BYTES * 9 }]), sw.HISTORY_WARM_MAX_BYTES,
    'the ceiling is the only thing that may cap it');
  assert.equal(sw.historyDayBytes({ bytes: 0 }), sw.HISTORY_WARM_MAX_BYTES / sw.HISTORY_WARM_MAX_DAYS,
    'an unsized day is charged its even share, so a sizeless index still warms the declared depth');
});

test('the warm stops at the storage ceiling, so a field phone is never asked for more', async () => {
  const caches = makeCaches();
  const two = Math.ceil(sw.HISTORY_WARM_MAX_BYTES / 2);
  const s = warmSw(caches, warmIdx([
    { d: '2026-07-22', h: 'a', bytes: two }, { d: '2026-07-23', h: 'b', bytes: two },
    { d: '2026-07-24', h: 'c', bytes: two }, { d: '2026-07-25', h: 'd', bytes: two },
  ]));
  await s.warmHistoryCache();
  assert.deepEqual([...caches._store.get('respondertx-history').keys()].sort(),
    [IDX, DAY('2026-07-25', 'd'), DAY('2026-07-24', 'c')].sort(),
    'newest-first until the ceiling runs out');
});

test('the warm always takes the newest day, even when that one day exceeds the whole budget', async () => {
  const caches = makeCaches();
  const s = warmSw(caches, warmIdx([{ d: '2026-07-24', h: 'a', bytes: 10 }, { d: '2026-07-25', h: 'b', bytes: sw.HISTORY_WARM_MAX_BYTES * 4 }]));
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

/* What the install handler really writes. The previous version of this test filtered PRECACHE_PATHS
   by LAZY_PATHS and asserted the intersection was absent from PRECACHE, which could not fail while
   the two lists were disjoint. The install path is observable, so it is what gets asserted.
   Honest residual: deleting the LAZY_PATHS filter in sw.js is invisible until a lazy path is also
   listed in PRECACHE_PATHS; nothing here (or in a source match) can see it before that. */
test('install caches exactly PRECACHE, and no lazy asset reaches it', async () => {
  const caches = makeCaches();
  const s = loadSw(caches);
  await fire(s, 'install');
  const cached = [...(caches._store.get(s.CACHE_STATIC) || new Map()).keys()];
  assert.ok(cached.length > 10, 'the install handler cached almost nothing');
  assert.deepEqual(cached.sort(), [...s.PRECACHE].sort(), 'install wrote something other than PRECACHE');
  assert.ok(cached.includes(`css/app.css?v=${s.SW_VERSION}`), 'the shell stylesheet must install-cache');
  for (const p of s.LAZY_PATHS) {
    assert.ok(!cached.some((u) => u.split('?')[0] === p), `${p} reached the install cache`);
  }
});

test('every lazy path the client asks for carries the release stamp', () => {
  // stampedCacheFirst is keyed on the ?v= query; an unstamped lazy URL would refetch every time,
  // and the round trip is asserted end to end by the stamped-asset route test above
  const { assetUrl, APP_VERSION } = require('./harness.js').loadApp();
  for (const p of sw.LAZY_PATHS) {
    assert.equal(assetUrl(p), `${p}?v=${APP_VERSION.replace(/^v/, '')}`, `${p} would be requested unstamped`);
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

// a push event whose data behaves the way the browser's PushMessageData does
const pushEvent = (payload) => ({
  data: payload === undefined ? null : { json() { if (payload === 'BROKEN') throw new Error('not json'); return payload; } },
});

test('a payload-free push still shows exactly one notification, on a page that keeps its off switch', async () => {
  const s = loadSw();
  await fire(s, 'push', pushEvent(undefined));
  assert.equal(s.log.notifications.length, 1, 'a silent push costs the subscription; there must always be exactly one');
  const [n] = s.log.notifications;
  assert.equal(n.title, sw.PUSH_FALLBACK.en.title);
  assert.equal(n.opts.body, sw.PUSH_FALLBACK.en.body);
  assert.equal(n.opts.data.url, '/?push=1',
    'the flag is what keeps the alerts card, and its off switch, on the landing page');
  assert.equal(n.opts.tag, 'respondertx-push');
  assert.equal(n.opts.lang, 'en');
});

test('an unparseable payload is still one notification, not a throw and not a silent drop', async () => {
  const s = loadSw();
  await fire(s, 'push', pushEvent('BROKEN'));
  assert.equal(s.log.notifications.length, 1);
  assert.equal(s.log.notifications[0].title, sw.PUSH_FALLBACK.en.title);
});

test('the payload language wins over the cached hint, and the hint localizes payload-free pushes', async () => {
  const spanishHint = () => makeCaches({ 'respondertx-push': { '/push-lang': mkRes('es\n') } });

  const bare = loadSw(spanishHint());
  await fire(bare, 'push', pushEvent(undefined));
  assert.equal(bare.log.notifications[0].title, sw.PUSH_FALLBACK.es.title,
    'a payload-free push must be localized from the cached subscriber hint');

  const english = loadSw(spanishHint());
  await fire(english, 'push', pushEvent({ lang: 'en', title: 'Flash Flood Emergency · Blanco River' }));
  assert.equal(english.log.notifications[0].opts.lang, 'en',
    "the payload's own language matches the stored subscription pref and must win over the hint");
  assert.equal(english.log.notifications[0].title, 'Flash Flood Emergency · Blanco River');

  const junk = loadSw(spanishHint());
  await fire(junk, 'push', pushEvent({ lang: 'fr' }));
  assert.equal(junk.log.notifications[0].opts.lang, 'es', 'an unknown payload language falls back to the hint');
  assert.equal(junk.log.notifications[0].title, sw.PUSH_FALLBACK.es.title);
});

/* P3 self-heal: the push service rotated our endpoint. The subscription has to be rebuilt with the
   same server key and the server row migrated, or the subscriber goes quiet with nothing to show
   for it. Every branch below is reached by firing the shipped handler. */

const subChangeSw = (cacheSeed, fetchImpl) => loadSw(makeCaches({ 'respondertx-push': cacheSeed }), fetchImpl);
const posts = (s) => s.log.fetches.map(([url, opts]) => ({ url, body: JSON.parse(opts.body) }));

test('a rotated endpoint re-subscribes with the old key and migrates the server row', async () => {
  const s = subChangeSw({ '/push-lang': mkRes('es') }, async () => mkRes('ok'));
  await fire(s, 'pushsubscriptionchange', {
    oldSubscription: { endpoint: 'https://push.test/expired', options: { applicationServerKey: 'KEYBYTES' } },
  });
  // built in the vm realm, so compare fields rather than deepEqual against a host-realm literal
  assert.equal(s.log.subscribes.length, 1);
  assert.equal(s.log.subscribes[0].userVisibleOnly, true);
  assert.equal(s.log.subscribes[0].applicationServerKey, 'KEYBYTES',
    'the expiring subscription carries the server key; re-subscribing without it is rejected');
  const sent = posts(s);
  assert.equal(sent.length, 1, 'a successful migration must not also fresh-subscribe');
  assert.equal(sent[0].url, 'api/push/resubscribe');
  assert.equal(sent[0].body.oldEndpoint, 'https://push.test/expired', 'the old endpoint is the credential');
  assert.equal(sent[0].body.subscription.endpoint, 'https://push.test/rotated');
});

test('when the server row is gone the change falls back to a fresh subscribe with the mirrored prefs', async () => {
  const s = subChangeSw({ '/push-lang': mkRes('es'), '/push-prefs': mkRes('{"emergency":true,"radiusKm":40}') },
    async (url) => mkRes('gone', String(url).indexOf('resubscribe') < 0));
  await fire(s, 'pushsubscriptionchange', {
    oldSubscription: { endpoint: 'https://push.test/expired', options: { applicationServerKey: 'KEYBYTES' } },
  });
  const sent = posts(s);
  assert.deepEqual(sent.map((p) => p.url), ['api/push/resubscribe', 'api/push/subscribe']);
  assert.deepEqual(sent[1].body.prefs, { emergency: true, radiusKm: 40 },
    'the mirrored prefs are the only copy left; losing them silently downgrades what the subscriber gets');
  assert.equal(sent[1].body.lang, 'es');
});

test('a change with no old subscription re-subscribes from the mirrored VAPID key', async () => {
  const key = Buffer.from([1, 2, 3, 4]).toString('base64url');
  const s = subChangeSw({ '/push-key': mkRes(key) }, async () => mkRes('ok'));
  await fire(s, 'pushsubscriptionchange', {});
  assert.equal(s.log.subscribes.length, 1, 'the mirrored key must cover a missing oldSubscription');
  assert.deepEqual([...s.log.subscribes[0].applicationServerKey], [1, 2, 3, 4]);
  assert.equal(posts(s)[0].body.oldEndpoint, '', 'there is no old endpoint to present, and that is not an error');
});

test('with no key anywhere the change gives up quietly rather than subscribing to nothing', async () => {
  const s = subChangeSw({}, async () => mkRes('ok'));
  await fire(s, 'pushsubscriptionchange', {});
  assert.deepEqual(s.log.subscribes, []);
  assert.deepEqual(s.log.fetches, []);
});

/* 2026-07-30: the public board sat in an update-prompt loop on v0.99.73 while the origin served
   .74. Neither auto-rollover nor the "Updated · tap to reload" chip posted SKIP_WAITING, and a
   reload does not activate a waiting worker: the old one keeps control while a tab is open and
   serves its cached shell, so the tab re-booted the build it was trying to leave. The 10 minute
   ROLL_HOLD_MS guard turned the reload storm into a recurring prompt, and the comment on it blamed
   CDN lag, which is why it went unchased. */
/* The boot-side half of the handover, run rather than read: loadHeaderStatus() evaluates js/boot.js,
   so applyUpdateAndReload() and performRollover() are callable against a service-worker registration
   that records what it was told. */
function updateCtx(opts = {}) {
  const h = require('./harness.js').loadHeaderStatus();
  const sb = h.sandbox;
  const log = { posted: [], reloads: 0, replaced: 0 };
  sb.location.reload = () => { log.reloads++; };
  sb.location.replace = () => { log.replaced++; };
  sb.history = { replaceState() {} };
  sb.navigator.serviceWorker = { controller: opts.controlled === false ? null : {}, addEventListener() {} };
  h.state.swWaitingReg = opts.waiting === false ? null
    : { waiting: { postMessage: (m) => log.posted.push(m) } };
  return { h, sb, log };
}

test('applying an update posts the handover and only then reloads', () => {
  const { h, log } = updateCtx();
  h.sandbox.applyUpdateAndReload();
  assert.deepEqual(log.posted.map((m) => m.type), ['SKIP_WAITING'],
    'a reload does not activate a waiting worker; without this the tab re-boots the build it is leaving');
  assert.equal(log.reloads, 0, 'the reload waits for the new worker to take control');
  const armed = h.timers[h.timers.length - 1];
  assert.ok(armed && armed.ms >= 1000, 'a handover that never completes must not strand the reader');
  armed.fn();
  assert.equal(log.reloads, 1, 'the escape hatch must reload when the handover goes unanswered');
  armed.fn();
  assert.equal(log.reloads, 1, 'and it must not reload twice');
});

test('a first install and a worker-less tab reload straight away instead of waiting for a handover', () => {
  const first = updateCtx({ controlled: false });
  first.h.sandbox.applyUpdateAndReload();
  assert.deepEqual(first.log.posted, [], 'a first install has no controller and is not an update');
  assert.equal(first.log.reloads, 1);

  const none = updateCtx({ waiting: false });
  none.h.sandbox.applyUpdateAndReload();
  assert.deepEqual(none.log.posted, []);
  assert.equal(none.log.reloads, 1, 'with nothing waiting there is nothing to hand over, so reload');
});

test('the auto rollover applies the update through the handover, never a bare navigation', () => {
  const roll = (shareUrl) => {
    const { h, sb, log } = updateCtx();
    sb.rolloverBusy = () => ''; // the idle gate is its own question; this is what happens once idle
    sb.buildShareUrl = shareUrl;
    h.state.updateTarget = '0.99.99';
    const applied = [];
    sb.applyUpdateAndReload = (u) => applied.push(u);
    sb.performRollover();
    return { applied, log };
  };

  const ok = roll(() => 'https://respondertx.org/?mlat=30.1&mz=11');
  assert.deepEqual(ok.applied, ['/?mlat=30.1&mz=11'],
    'the rollover must hand over and carry the captured view; a bare navigation re-serves the old cached shell');
  assert.equal(ok.log.reloads + ok.log.replaced, 0, 'the handover, not the tab, decides when to reload');

  const broken = roll(() => { throw new Error('serializer failed'); });
  assert.deepEqual(broken.applied, [undefined],
    'a capture that failed still has to hand over, or the tab re-boots the build it is leaving');
});

test('the worker honours SKIP_WAITING, and ignores every other message', async () => {
  const s = loadSw();
  await fire(s, 'message', { data: { type: 'SKIP_WAITING' } });
  assert.equal(s.log.skipWaiting, 1, 'without this the handover is a no-op and the prompt loop returns');
  for (const data of [null, undefined, {}, { type: 'skip_waiting' }, 'SKIP_WAITING']) {
    await fire(s, 'message', { data });
  }
  assert.equal(s.log.skipWaiting, 1, 'only the exact message may take the worker over');
});

test('the update chip applies the update rather than reloading bare', () => {
  /* Source scan, deliberately: the chip handler is registered inside boot.js's DOMContentLoaded
     init, which is not reachable from node without standing up the whole page. */
  const boot = fs.readFileSync(path.join(ROOT, 'js', 'boot.js'), 'utf8');
  const chip = (boot.match(/#update-chip'\)\.addEventListener\('click',[^;]*/) || [''])[0];
  assert.match(chip, /applyUpdateAndReload\(/,
    'the chip says "tap to reload" and must actually apply the update');
  assert.doesNotMatch(chip, /location\.reload\(\)/, 'a bare reload leaves the old worker in control');
});
