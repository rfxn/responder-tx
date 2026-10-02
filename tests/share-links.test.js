'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  newLinks, makeNamespace, shareFn, shortFn, redirectFor, importWorkerModule, normalizeQuery, codeFor, ipBucket,
  CODE_RE, Q_MAX, PROBE_MAX, MAX_ROWS, RATE_MAX, RATE_WINDOW_MS, HIT_WRITE_MS,
} = require('./share-harness.js');

const VIEW = 'mlat=29.4241&mlon=-98.4936&mz=11&tab=gauges&fq=R-031&usgs=1&base=Dark&theme=dark';
const T0 = Date.UTC(2026, 9, 2, 12);

const doReq = (action, body) => (body === undefined
  ? new Request(`https://do/${action}`, { method: 'GET' })
  : new Request(`https://do/${action}`, { method: 'POST', body: JSON.stringify(body), headers: { 'X-Client-IP': '203.0.113.9' } }));

/* ---------- the Durable Object ---------- */

// workerd refuses to start a module that exports a constant ("not of type 'function or ExportedHandler'")
test('the Worker module exports only what the runtime accepts: the DO class and a default handler', async () => {
  const mod = await importWorkerModule();
  assert.deepEqual(Object.keys(mod).sort(), ['ShareLinks', 'default']);
  assert.equal(typeof mod.ShareLinks, 'function');
  assert.equal(typeof mod.default.fetch, 'function');
  assert.equal((await mod.default.fetch(new Request('https://x/'))).status, 404, 'the Worker itself routes nothing');
});

test('create mints an 8-digit code and stores the normalized view with its timestamps', async () => {
  const { links, state } = newLinks();
  const out = await links.doCreate({ q: VIEW }, '203.0.113.9', T0);
  assert.match(out.code, CODE_RE);
  assert.equal(out.code, await codeFor(normalizeQuery(VIEW).q, 0), 'a free home code is used as-is');
  const row = state._store.get(`c:${out.code}`);
  assert.equal(row.q, 'base=Dark&fq=R-031&mlat=29.4241&mlon=-98.4936&mz=11&tab=gauges&theme=dark&usgs=1');
  assert.equal(row.created, T0);
  assert.equal(row.hit, null);
  assert.equal(state._store.get('meta').rows, 1);
  // and the same answer through the DO's own fetch routing
  const res = await links.fetch(doReq('create', { q: VIEW }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).code, out.code);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('the same view always gets the same code: reordered, re-encoded or ?-prefixed', async () => {
  const { links, state } = newLinks();
  const a = await links.doCreate({ q: VIEW }, '203.0.113.9', T0);
  const shuffled = VIEW.split('&').reverse().join('&');
  const b = await links.doCreate({ q: `?${shuffled}` }, '203.0.113.9', T0 + 1000);
  const c = await links.doCreate({ q: VIEW.replace('R-031', 'R%2D031') }, '198.51.100.7', T0 + 2000);
  assert.equal(b.code, a.code);
  assert.equal(c.code, a.code);
  assert.equal(b.created, undefined, 'a repeat share must not mint a second row');
  assert.equal(state._store.get('meta').rows, 1);
  assert.equal(state._store.get(`c:${a.code}`).created, T0, 'a repeat share keeps the first created stamp');
  const other = await links.doCreate({ q: `${VIEW}&radar=1` }, '203.0.113.9', T0);
  assert.notEqual(other.code, a.code);
  assert.equal(state._store.get('meta').rows, 2);
});

test('a code already held by another view re-probes deterministically, and both resolve', async () => {
  const { links, state } = newLinks();
  const q = normalizeQuery(VIEW).q;
  const home = await codeFor(q, 0);
  const next = await codeFor(q, 1);
  assert.notEqual(next, home);
  state._store.set(`c:${home}`, { q: 'mlat=1&mlon=2', created: 1, hit: null });
  state._store.set('meta', { rows: 1 });

  const first = await links.doCreate({ q: VIEW }, '203.0.113.9', T0);
  assert.equal(first.code, next, 'the collision moves the view to its next probe');
  const again = await links.doCreate({ q: VIEW }, '203.0.113.9', T0);
  assert.equal(again.code, next, 'and the repeat share walks the same sequence to the same row');
  assert.equal(state._store.get('meta').rows, 2);
  assert.equal((await links.doResolve(home, T0)).q, 'mlat=1&mlon=2', 'the earlier owner keeps its code');
  assert.equal((await links.doResolve(next, T0)).q, q);
});

test('a view whose whole probe sequence is taken is refused, never overwritten', async () => {
  const { links, state } = newLinks();
  const q = normalizeQuery(VIEW).q;
  for (let i = 0; i < PROBE_MAX; i++) state._store.set(`c:${await codeFor(q, i)}`, { q: `mz=${i}`, created: 1, hit: null });
  const out = await links.doCreate({ q: VIEW }, '203.0.113.9', T0);
  assert.equal(out._status, 503);
  assert.equal(state._store.get(`c:${await codeFor(q, 0)}`).q, 'mz=0');
});

test('only the keys the board emits are accepted; a team invite or a foreign param is a 400', async () => {
  const { links, state } = newLinks();
  const refused = [
    ['team=0b8c6a43-6d5e-4a1d-9f3e-2b7c1d9e8f10', 'param not allowed'], // capability URL, never shortened
    ['mlat=29&next=https://evil.example', 'param not allowed'],
    ['url=https://evil.example', 'param not allowed'],
    ['mlat=29&mlat=30', 'duplicate param'],
    ['fq=a%0Ab', 'bad value'],
    ['', 'empty query'],
    ['?', 'empty query'],
  ];
  for (const [q, why] of refused) {
    const out = await links.doCreate({ q }, '203.0.113.9', T0);
    assert.equal(out._status, 400, q);
    assert.equal(out.error, why, q);
  }
  for (const body of [{}, { q: 42 }, { q: ['mlat=1'] }, null]) {
    assert.equal((await links.doCreate(body, '203.0.113.9', T0))._status, 400, JSON.stringify(body));
  }
  const res = await links.fetch(doReq('create', { q: 'team=x' }));
  assert.equal(res.status, 400);
  assert.equal(state._store.size, 0, 'nothing refused was stored');
  // the camera deep link is a record key the board opens at boot, so it is shareable
  assert.match((await links.doCreate({ q: 'cam=TxDOT%20Houston%201' }, '203.0.113.9', T0)).code, CODE_RE);
});

test('the query is capped at Q_MAX characters', async () => {
  const { links } = newLinks();
  const at = `fq=${'a'.repeat(Q_MAX - 3)}`;
  assert.equal(at.length, Q_MAX);
  assert.match((await links.doCreate({ q: at }, '203.0.113.9', T0)).code, CODE_RE);
  const over = await links.doCreate({ q: `${at}b` }, '203.0.113.9', T0);
  assert.equal(over._status, 400);
  assert.equal(over.error, 'query too long');
  // a short raw query that re-encodes past the cap is refused too
  const grows = await links.doCreate({ q: `fq=${'~'.repeat(Q_MAX - 3)}` }, '203.0.113.9', T0);
  assert.equal(grows._status, 400);
});

test('new links are rate limited per IP (per /64 on IPv6); re-sharing a known view is not', async () => {
  const { links, state } = newLinks();
  const known = await links.doCreate({ q: VIEW }, '203.0.113.9', T0);
  for (let i = 1; i < RATE_MAX; i++) {
    assert.match((await links.doCreate({ q: `mz=${i}` }, '203.0.113.9', T0)).code, CODE_RE, `link ${i}`);
  }
  const limited = await links.doCreate({ q: 'mz=999' }, '203.0.113.9', T0);
  assert.equal(limited._status, 429);
  assert.equal((await links.doCreate({ q: VIEW }, '203.0.113.9', T0)).code, known.code, 'a known view still answers');
  assert.match((await links.doCreate({ q: 'mz=999' }, '198.51.100.7', T0)).code, CODE_RE, 'another IP is unaffected');
  assert.match((await links.doCreate({ q: 'mz=998' }, '203.0.113.9', T0 + RATE_WINDOW_MS + 1)).code, CODE_RE,
    'the window restarts');
  assert.ok(![...state._store.keys()].some((k) => k.includes('203.0.113.9')), 'no IP is ever stored');

  const v6 = newLinks().links;
  for (let i = 0; i < RATE_MAX; i++) await v6.doCreate({ q: `mz=${i}` }, `2001:db8:1:2::${i.toString(16)}`, T0);
  assert.equal((await v6.doCreate({ q: 'mz=999' }, '2001:db8:1:2:ffff::1', T0))._status, 429, 'same /64');
  assert.match((await v6.doCreate({ q: 'mz=999' }, '2001:db8:1:3::1', T0)).code, CODE_RE, 'next /64');
  assert.equal(ipBucket('2001:0db8:0001:0002:0000:0000:0000:0001'), '2001:db8:1:2::/64');
  assert.equal(ipBucket('::1'), '0:0:0:0::/64');
  assert.equal(ipBucket('203.0.113.9'), '203.0.113.9');
});

test('the row cap refuses new views but still answers known ones', async () => {
  const { links, state } = newLinks();
  const known = await links.doCreate({ q: VIEW }, '203.0.113.9', T0);
  state._store.set('meta', { rows: MAX_ROWS });
  assert.equal((await links.doCreate({ q: 'mz=3' }, '203.0.113.9', T0))._status, 503);
  assert.equal((await links.doCreate({ q: VIEW }, '203.0.113.9', T0)).code, known.code);
});

test('resolve returns the stored view and records the last hit at most hourly; a miss is a 404', async () => {
  const { links, state } = newLinks();
  const { code } = await links.doCreate({ q: VIEW }, '203.0.113.9', T0);
  const key = `c:${code}`;
  state._writes.length = 0;
  assert.equal((await links.doResolve(code, T0 + 5)).q, normalizeQuery(VIEW).q);
  assert.equal(state._store.get(key).hit, T0 + 5);
  await links.doResolve(code, T0 + 10);
  assert.equal(state._store.get(key).hit, T0 + 5, 'a burst of opens costs one write');
  assert.equal(state._writes.length, 1);
  await links.doResolve(code, T0 + 5 + HIT_WRITE_MS);
  assert.equal(state._store.get(key).hit, T0 + 5 + HIT_WRITE_MS);
  assert.equal(state._store.get(key).created, T0);

  const res = await links.fetch(doReq(`resolve?code=${code}`));
  assert.equal(res.status, 200);
  for (const miss of ['12345678', '01234567', '1234567', 'abcdefgh', '']) {
    const r = await links.fetch(doReq(`resolve?code=${miss}`));
    assert.equal(r.status, 404, miss);
  }
});

// a genuine collision found by search: two different views whose home code is the same
const TWIN_A = 'fq=5460';
const TWIN_B = 'fq=8879';
const TWIN_HOME = '59126209';

test('two real views sharing a home code: the second re-probes, in either order, even when racing', async () => {
  assert.equal(await codeFor(TWIN_A, 0), TWIN_HOME);
  assert.equal(await codeFor(TWIN_B, 0), TWIN_HOME);
  const { links, state } = newLinks();
  const a = await links.doCreate({ q: TWIN_A }, '203.0.113.9', T0);
  const b = await links.doCreate({ q: TWIN_B }, '203.0.113.9', T0);
  assert.equal(a.code, TWIN_HOME);
  assert.equal(b.code, await codeFor(TWIN_B, 1));
  assert.equal((await links.doCreate({ q: TWIN_B }, '203.0.113.9', T0)).code, b.code, 'B is stable on its probe');
  assert.equal((await links.doResolve(a.code, T0)).q, TWIN_A);
  assert.equal((await links.doResolve(b.code, T0)).q, TWIN_B);
  assert.equal(state._store.get('meta').rows, 2);

  const race = newLinks();
  const [ra, rb] = await Promise.all([
    race.links.doCreate({ q: TWIN_B }, '203.0.113.9', T0),
    race.links.doCreate({ q: TWIN_A }, '203.0.113.9', T0),
  ]);
  assert.notEqual(ra.code, rb.code, 'two racing views never end on one row');
  assert.equal((await race.links.doResolve(ra.code, T0)).q, TWIN_B);
  assert.equal((await race.links.doResolve(rb.code, T0)).q, TWIN_A);
  assert.equal(race.state._store.get('meta').rows, 2);
});

/* ---------- the Pages Functions in front of it ---------- */

const ctx = (url, init, env) => ({ request: new Request(url, init), env, params: {} });

test('POST /api/share returns {code, url} on the requesting origin and forwards the client IP', async () => {
  const { links } = newLinks();
  const SHARE = makeNamespace(links);
  const res = await shareFn.onRequestPost(ctx('https://respondertx.org/api/share', {
    method: 'POST', body: JSON.stringify({ q: VIEW }), headers: { 'CF-Connecting-IP': '198.51.100.7' },
  }, { SHARE }));
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.match(d.code, CODE_RE);
  assert.equal(d.url, `https://respondertx.org/s/${d.code}`);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(SHARE.names, ['links']);
  assert.equal(SHARE.calls[0].ip, '198.51.100.7');
  // a preview deploy hands out links on its own host
  const prev = await shareFn.onRequestPost(ctx('https://abc123.responder-tx.pages.dev/api/share', {
    method: 'POST', body: JSON.stringify({ q: VIEW }),
  }, { SHARE }));
  assert.equal((await prev.json()).url, `https://abc123.responder-tx.pages.dev/s/${d.code}`);
});

test('POST /api/share without the SHARE binding is a clean 503, so the client copies the long link', async () => {
  for (const env of [{}, undefined, { SHARE: null }]) {
    const res = await shareFn.onRequestPost(ctx('https://respondertx.org/api/share', { method: 'POST', body: JSON.stringify({ q: VIEW }) }, env));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal((await res.json()).error, 'share links not configured');
  }
});

test('POST /api/share passes a refusal through and caps the body', async () => {
  const { links } = newLinks();
  const SHARE = makeNamespace(links);
  const bad = await shareFn.onRequestPost(ctx('https://respondertx.org/api/share', { method: 'POST', body: JSON.stringify({ q: 'team=x' }) }, { SHARE }));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'param not allowed');
  const junk = await shareFn.onRequestPost(ctx('https://respondertx.org/api/share', { method: 'POST', body: 'not json' }, { SHARE }));
  assert.equal(junk.status, 400);
  const huge = await shareFn.onRequestPost(ctx('https://respondertx.org/api/share', { method: 'POST', body: JSON.stringify({ q: 'x'.repeat(5000) }) }, { SHARE }));
  assert.equal(huge.status, 413);
  const broken = { idFromName: () => 'id', get: () => ({ fetch: async () => { throw new Error('DO reset'); } }) };
  const down = await shareFn.onRequestPost(ctx('https://respondertx.org/api/share', { method: 'POST', body: JSON.stringify({ q: VIEW }) }, { SHARE: broken }));
  assert.equal(down.status, 503);
});

async function openShort(pathname, env) {
  const url = `https://respondertx.org${pathname}`;
  const code = pathname.replace(/^\/s\//, '');
  return shortFn.onRequestGet({ request: new Request(url), env, params: { code } });
}

test('GET /s/<code> is a 302 to the stored view on the same origin, cacheable', async () => {
  const { links } = newLinks();
  const SHARE = makeNamespace(links);
  const { code } = await links.doCreate({ q: VIEW }, '203.0.113.9', T0);
  const res = await openShort(`/s/${code}`, { SHARE });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), `https://respondertx.org/?${normalizeQuery(VIEW).q}`);
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=86400');
  const back = new URL(res.headers.get('Location'));
  assert.equal(back.origin, 'https://respondertx.org');
  assert.equal(back.pathname, '/');
  for (const [k, v] of new URLSearchParams(VIEW)) assert.equal(back.searchParams.get(k), v, k);
  assert.equal((await shortFn.onRequestHead({ request: new Request(`https://respondertx.org/s/${code}`, { method: 'HEAD' }), env: { SHARE }, params: { code } })).status, 302);
});

test('GET /s/<code> for an unknown or malformed code is a friendly, uncached 404 linking to the board', async () => {
  const { links } = newLinks();
  const SHARE = makeNamespace(links);
  for (const p of ['/s/12345678', '/s/abc', '/s/0123456', '/s/123456789']) {
    const res = await openShort(p, { SHARE });
    assert.equal(res.status, 404, p);
    assert.equal(res.headers.get('Cache-Control'), 'no-store', p);
    assert.match(res.headers.get('Content-Type'), /^text\/html/);
    assert.match(res.headers.get('Content-Security-Policy'), /default-src 'none'/);
    const html = await res.text();
    assert.match(html, /<a href="\/">Open the ResponderTX flood board<\/a>/);
    assert.match(html, /lang="es"/);
    assert.ok(!html.includes('—'), 'no em-dash in user-facing copy');
  }
  assert.equal(SHARE.calls.length, 1, 'a malformed code never reaches the DO');
});

test('GET /s/<code> without the binding, or with the DO down, is an uncached 503 page', async () => {
  for (const env of [{}, { SHARE: { idFromName: () => 'id', get: () => ({ fetch: async () => { throw new Error('reset'); } }) } }]) {
    const res = await openShort('/s/37401230', env);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.match(await res.text(), /Short links are unavailable right now/);
  }
});

test('/share<digits> is the same link as /s/<digits>', async () => {
  const { links } = newLinks();
  const SHARE = makeNamespace(links);
  const { code } = await links.doCreate({ q: VIEW }, '203.0.113.9', T0);
  const hop = redirectFor(`/share${code}`);
  assert.deepEqual(hop, { to: `/s/${code}`, status: 302 });
  const res = await openShort(hop.to, { SHARE });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), `https://respondertx.org/?${normalizeQuery(VIEW).q}`);
  assert.equal(redirectFor('/s/37401230'), null, 'the canonical form is not redirected again');
  assert.equal(redirectFor('/index.html'), null);
});
