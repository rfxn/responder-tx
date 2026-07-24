'use strict';

/*
 * Web-push P3: per-gauge follows. Prefs sanitation + cap, the effective-threshold merge with the
 * AO-wide tier, the evaluator honoring per-gauge prefs (followed-at-major stays silent at
 * moderate; unfollowed gauges stay silent with the AO tier off), the renew self-lookup, the
 * pushsubscriptionchange resubscribe migration, and the prefs-filtered 'crossing' testfire kind.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  newRegistry, mockRes, sandbox, makeClientKeys, decryptPush,
  sanitizePrefs, effectiveTierRank, CAT_RANK,
} = require('./push-harness.js');

const MIN = 60 * 1000;
const FCM = 'https://fcm.googleapis.com/fcm/send/test-endpoint-';

const subBody = (n, extra = {}) => ({
  subscription: { endpoint: FCM + n, keys: { p256dh: 'pk' + n, auth: 'ak' + n } },
  prefs: { ffe: true }, lang: 'en', ...extra,
});

const gauge = (lid, cat, obsAgoMin, now, name) => ({
  lid,
  name: name || `${lid} test river`,
  status: {
    observed: {
      primary: 20.5, primaryUnit: 'ft', floodCategory: cat,
      validTime: new Date(now - obsAgoMin * MIN).toISOString(),
    },
  },
});

function mockNet({ features = [], snapshot = null, pushStatus = 201, pushLog = [] } = {}) {
  sandbox.__fetchMock = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('api.weather.gov')) return mockRes(200, { features });
    if (u.includes('respondertx.org/data/event.json')) {
      return mockRes(200, { gaugeBbox: { xmin: -98.0, ymin: 27.5, xmax: -93.4, ymax: 31.0 } });
    }
    if (u.includes('respondertx.org/data/gauges-snapshot.json')) {
      return mockRes(200, snapshot || { generated: '', gauges: [] });
    }
    pushLog.push({ url: u, headers: (opts && opts.headers) || {}, body: (opts && opts.body) || null });
    return mockRes(typeof pushStatus === 'function' ? pushStatus(u) : pushStatus, {});
  };
  return pushLog;
}

const J = (x) => JSON.parse(JSON.stringify(x)); // cross-realm deepEqual normalizer

/* ---------- prefs sanitation ---------- */

test('sanitizePrefs normalizes followed gauges: uppercase, dedup, invalid tier/lid dropped', () => {
  const out = J(sanitizePrefs({
    ffe: true, tier: 'moderate',
    gauges: [
      { lid: 'srrt2', tier: 'major' },
      { lid: 'SRRT2', tier: 'moderate' },      // dup of the first after uppercasing
      { lid: 'OK1', tier: 'minor' },           // invalid tier
      { lid: 'bad lid!', tier: 'major' },      // invalid lid shape
      { lid: 'CMKT2', tier: 'moderate' },
      'garbage',
    ],
  }));
  assert.deepEqual(out.gauges, [{ lid: 'SRRT2', tier: 'major' }, { lid: 'CMKT2', tier: 'moderate' }]);
  assert.equal(out.tier, 'moderate');
});

test('subscribe rejects more than 20 followed gauges with 400; exactly 20 is accepted', async () => {
  const { reg } = newRegistry();
  mockNet({});
  const many = (n) => Array.from({ length: n }, (_, i) => ({ lid: `G${i}LID`, tier: 'major' }));
  const over = await reg.doSubscribe(subBody('cap', { prefs: { gauges: many(21) } }), '', Date.now());
  assert.equal(over._status, 400);
  const atCap = await reg.doSubscribe(subBody('cap', { prefs: { gauges: many(20) } }), '', Date.now());
  assert.equal(atCap.ok, true);
  assert.equal(J(atCap.prefs).gauges.length, 20);
});

/* ---------- effective threshold: AO tier and per-gauge follows coexist ---------- */

test('effectiveTierRank: per-gauge only, AO only, and most-sensitive-wins coexistence', () => {
  const perOnly = { ffe: false, tier: null, gauges: [{ lid: 'A1LID', tier: 'major' }] };
  assert.equal(effectiveTierRank(perOnly, 'A1LID'), CAT_RANK.major);
  assert.equal(effectiveTierRank(perOnly, 'B2LID'), 0, 'unfollowed gauge unwatched with AO tier off');
  const aoOnly = { ffe: true, tier: 'moderate', gauges: [] };
  assert.equal(effectiveTierRank(aoOnly, 'ANY1'), CAT_RANK.moderate);
  const both = { ffe: true, tier: 'moderate', gauges: [{ lid: 'A1LID', tier: 'major' }] };
  assert.equal(effectiveTierRank(both, 'A1LID'), CAT_RANK.moderate, 'AO moderate is more sensitive than the major follow');
  const inverse = { ffe: true, tier: 'major', gauges: [{ lid: 'A1LID', tier: 'moderate' }] };
  assert.equal(effectiveTierRank(inverse, 'A1LID'), CAT_RANK.moderate, 'moderate follow is more sensitive than AO major');
  assert.equal(effectiveTierRank(inverse, 'B2LID'), CAT_RANK.major);
  assert.equal(effectiveTierRank(null, 'A1LID'), 0);
});

/* ---------- evaluator honors per-gauge prefs ---------- */

test('a gauge followed at major stays silent at moderate and fires at major, with the gauge name', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  const client = makeClientKeys();
  mockNet({});
  await reg.doSubscribe({
    subscription: { endpoint: FCM + 'pg', keys: { p256dh: client.p256dh, auth: client.auth } },
    prefs: { ffe: false, tier: null, gauges: [{ lid: 'SRRT2', tier: 'major' }] }, lang: 'en',
  }, '', now);
  // moderate crossing on the followed gauge: below its per-gauge tier — silent
  let log = mockNet({ snapshot: { generated: 'g1', gauges: [gauge('SRRT2', 'moderate', 10, now, 'San Antonio River at Runge')] } });
  let out = await reg.doEvaluate(now);
  assert.equal(out.crossings, 0, 'followed at major: moderate does not alert');
  assert.equal(log.length, 0);
  // major crossing elsewhere (unfollowed) with AO tier off — silent
  log = mockNet({ snapshot: { generated: 'g2', gauges: [gauge('OTHR2', 'major', 10, now)] } });
  out = await reg.doEvaluate(now + 5 * MIN);
  assert.equal(out.crossings, 0, 'unfollowed gauge silent even at major when the AO tier is off');
  assert.equal(log.length, 0);
  // major crossing on the followed gauge — fires with the gauge name and deep link
  log = mockNet({ snapshot: { generated: 'g3', gauges: [gauge('SRRT2', 'major', 10, now, 'San Antonio River at Runge')] } });
  out = await reg.doEvaluate(now + 10 * MIN);
  assert.equal(out.crossings, 1);
  assert.equal(log.length, 1);
  const payload = JSON.parse(decryptPush(client, log[0].body).plaintext.toString());
  assert.equal(payload.lid, 'SRRT2');
  assert.ok(payload.title.includes('San Antonio River at Runge'));
  assert.equal(payload.url, '/?hydro=SRRT2');
});

test('AO tier and per-gauge follows coexist in one evaluation pass', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  mockNet({});
  // AO-wide moderate + follows FARR2 at major: the AO tier covers BOTH gauges at moderate
  await reg.doSubscribe(subBody('co', {
    prefs: { ffe: false, tier: 'moderate', gauges: [{ lid: 'FARR2', tier: 'major' }] },
  }), '', now);
  const log = mockNet({
    snapshot: { generated: 'g1', gauges: [gauge('FARR2', 'moderate', 10, now), gauge('NEAR2', 'moderate', 10, now)] },
  });
  const out = await reg.doEvaluate(now);
  assert.equal(out.crossings, 2, 'AO moderate fires for the followed and the unfollowed gauge alike');
  assert.equal(log.length, 2);
});

test('unfollowing a gauge drops its armed dedup state', async () => {
  const { reg, state } = newRegistry();
  const now = Date.now();
  mockNet({});
  await reg.doSubscribe(subBody('uf', { prefs: { gauges: [{ lid: 'DROP2', tier: 'moderate' }] } }), '', now);
  mockNet({ snapshot: { generated: 'g1', gauges: [gauge('DROP2', 'moderate', 10, now)] } });
  await reg.doEvaluate(now);
  const id = [...state._store.keys()].find((k) => k.startsWith('ns:')).slice(3);
  assert.ok((await state.storage.get(`ns:${id}`)).g.DROP2, 'armed after the crossing');
  // prefs update removes the follow; the next pass clears the stale armed entry
  await reg.doSubscribe(subBody('uf', { prefs: { ffe: true, gauges: [{ lid: 'KEEP2', tier: 'moderate' }] } }), '', now + MIN);
  mockNet({ snapshot: { generated: 'g2', gauges: [gauge('DROP2', 'moderate', 10, now)] } });
  await reg.doEvaluate(now + 6 * MIN);
  const ns = await state.storage.get(`ns:${id}`);
  assert.ok(!ns.g.DROP2, 'unwatched armed state dropped');
});

/* ---------- renew self-lookup ---------- */

test('renew returns the stored prefs (endpoint possession is the credential); unknown endpoint 404s', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  mockNet({});
  await reg.doSubscribe(subBody('rl', { prefs: { tier: 'major', gauges: [{ lid: 'SRRT2', tier: 'moderate' }] } }), '', now);
  const out = await reg.doRenew({ endpoint: FCM + 'rl' }, '', now + MIN);
  assert.equal(out.ok, true);
  assert.deepEqual(J(out.prefs), { ffe: true, tier: 'major', gauges: [{ lid: 'SRRT2', tier: 'moderate' }] });
  const wrong = await reg.doRenew({ endpoint: FCM + 'someone-else' }, '', now);
  assert.equal(wrong._status, 404, 'a wrong endpoint learns nothing');
});

/* ---------- resubscribe (pushsubscriptionchange migration) ---------- */

test('resubscribe carries prefs, lang, created, and dedup state to the new endpoint', async () => {
  const { reg, state } = newRegistry();
  const now = Date.now();
  mockNet({});
  await reg.doSubscribe({
    subscription: { endpoint: FCM + 'old', keys: { p256dh: 'pkold', auth: 'akold' } },
    prefs: { ffe: false, tier: null, gauges: [{ lid: 'SRRT2', tier: 'major' }] }, lang: 'es',
  }, '', now - 5 * 24 * 3600 * 1000);
  // arm some dedup state so the migration has something to carry
  mockNet({ snapshot: { generated: 'g1', gauges: [gauge('SRRT2', 'major', 10, now)] } });
  await reg.doEvaluate(now);
  const log = mockNet({});
  const out = await reg.doResubscribe({
    oldEndpoint: FCM + 'old',
    subscription: { endpoint: FCM + 'new', keys: { p256dh: 'pknew', auth: 'aknew' } },
  }, '', now);
  assert.equal(out.ok, true);
  assert.deepEqual(J(out.prefs).gauges, [{ lid: 'SRRT2', tier: 'major' }], 'prefs survive rotation');
  assert.equal(log.length, 0, 'migration is silent: no confirmation push');
  const rows = [...state._store.entries()].filter(([k]) => k.startsWith('sub:'));
  assert.equal(rows.length, 1, 'old row replaced, not duplicated');
  const row = rows[0][1];
  assert.equal(row.endpoint, FCM + 'new');
  assert.equal(row.lang, 'es');
  assert.equal(row.created, now - 5 * 24 * 3600 * 1000, 'created stamp carried');
  assert.equal(row.p256dh, 'pknew', 'new browser keys stored');
  const ns = await state.storage.get(`ns:${row.id}`);
  assert.ok(ns && ns.g.SRRT2, 'dedup state migrated: no duplicate alert after rotation');
});

test('resubscribe validates: unknown old endpoint 404, bad new endpoint 400, unconfigured 503', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  mockNet({});
  const sub = { endpoint: FCM + 'n2', keys: {} };
  assert.equal((await reg.doResubscribe({ oldEndpoint: FCM + 'ghost', subscription: sub }, '', now))._status, 404);
  await reg.doSubscribe(subBody('o2'), '', now);
  assert.equal((await reg.doResubscribe({ oldEndpoint: FCM + 'o2', subscription: { endpoint: 'https://evil.example.com/x' } }, '', now))._status, 400);
  assert.equal((await reg.doResubscribe({ subscription: sub }, '', now))._status, 400, 'oldEndpoint required');
  const bare = newRegistry({ VAPID_PRIVATE_KEY: '' });
  assert.equal((await bare.reg.doResubscribe({ oldEndpoint: FCM + 'o2', subscription: sub }, '', now))._status, 503);
});

/* ---------- testfire kind 'crossing': the prefs filter, end to end ---------- */

test("testfire 'crossing' honors stored prefs: matching follows send, everyone else is skipped", async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  mockNet({});
  await reg.doSubscribe(subBody('follows', { prefs: { ffe: false, tier: null, gauges: [{ lid: 'SRRT2', tier: 'moderate' }] } }), '', now);
  await reg.doSubscribe(subBody('aooff', { prefs: { ffe: true, tier: null, gauges: [] } }), '', now);
  let log = mockNet({});
  const hit = await reg.doTestfire({ kind: 'crossing', lid: 'SRRT2', cat: 'moderate', name: 'San Antonio River at Runge' }, now);
  const statuses = J(hit.results.map((r) => r.status).sort());
  assert.deepEqual(statuses, [201, 'skipped'], 'only the follower gets the push');
  assert.equal(log.length, 1);
  // negative proof: a crossing on an unfollowed gauge below any AO tier reaches nobody
  log = mockNet({});
  const miss = await reg.doTestfire({ kind: 'crossing', lid: 'OTHR2', cat: 'moderate' }, now);
  assert.deepEqual(J(miss.results.map((r) => r.status)), ['skipped', 'skipped']);
  assert.equal(log.length, 0, 'no push traffic at all');
});
