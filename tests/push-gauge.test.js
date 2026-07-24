'use strict';

/*
 * Web-push P2: gauge-tier evaluator (crossing / hysteresis / cooldown / hourly cap + digest),
 * HMAC nudge validation, confirmation push on subscribe, and the Worker's localized payloads.
 * Pure functions are driven directly; the DO integration runs through doSubscribe/doEvaluate
 * with mocked network and real client crypto (payloads decrypted with the harness receiver).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const {
  newRegistry, mockRes, sandbox, makeClientKeys, decryptPush,
  crossingStep, applyHourlyCap, gaugeRank, verifyNudgeSig, PUSH_STRINGS, CAT_RANK,
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

/* ---------- crossingStep: the honesty-critical dedup state machine ---------- */

test('crossingStep notifies on an upward crossing into the tier, once', () => {
  const tier = CAT_RANK.moderate;
  const t0 = 1000 * MIN;
  const first = crossingStep(3, tier, {}, t0);
  assert.equal(first.notify, true);
  assert.equal(first.st.lastCat, 3);
  const again = crossingStep(3, tier, first.st, t0 + 31 * MIN);
  assert.equal(again.notify, false, 'same rank never re-notifies, even past cooldown');
});

test('crossingStep below-tier ranks never notify and leave no armed state', () => {
  const out = crossingStep(2, CAT_RANK.moderate, {}, 0);
  assert.equal(out.notify, false);
  assert.equal(out.st.lastCat, 0);
});

test('crossingStep escalation moderate to major notifies again (a new, worse fact)', () => {
  const tier = CAT_RANK.moderate;
  const t0 = 1000 * MIN;
  const mod = crossingStep(3, tier, {}, t0);
  const maj = crossingStep(4, tier, mod.st, t0 + 45 * MIN);
  assert.equal(maj.notify, true);
  assert.equal(maj.st.lastCat, 4);
});

test('crossingStep cooldown defers without losing the crossing (30 min floor)', () => {
  const tier = CAT_RANK.moderate;
  const t0 = 1000 * MIN;
  const mod = crossingStep(3, tier, {}, t0);
  const tooSoon = crossingStep(4, tier, mod.st, t0 + 10 * MIN);
  assert.equal(tooSoon.notify, false, 'escalation inside the cooldown is deferred');
  assert.equal(tooSoon.st.lastCat, 3, 'state not advanced — the crossing is not lost');
  const later = crossingStep(4, tier, tooSoon.st, t0 + 31 * MIN);
  assert.equal(later.notify, true, 'deferred crossing fires once the cooldown expires');
});

test('crossingStep hysteresis: 2 consecutive below-tier evals re-arm, 1 does not', () => {
  const tier = CAT_RANK.moderate;
  const t0 = 1000 * MIN;
  let st = crossingStep(3, tier, {}, t0).st;
  st = crossingStep(2, tier, st, t0 + 15 * MIN).st;
  assert.equal(st.lastCat, 3, 'one dip keeps the notified state');
  const backUp = crossingStep(3, tier, st, t0 + 30 * MIN);
  assert.equal(backUp.notify, false, 'flap back up does not re-notify');
  st = crossingStep(2, tier, backUp.st, t0 + 45 * MIN).st;
  st = crossingStep(2, tier, st, t0 + 60 * MIN).st;
  assert.equal(st.lastCat, 0, 'sustained recession re-arms');
  const recross = crossingStep(3, tier, st, t0 + 90 * MIN);
  assert.equal(recross.notify, true, 'a genuine new crossing after recession notifies');
});

test('crossingStep: a flapping gauge produces one notification, not a stream', () => {
  const tier = CAT_RANK.moderate;
  let st = {};
  let sent = 0;
  const seq = [3, 2, 3, 2, 3, 3, 2, 3]; // minor/moderate oscillation every 10 min
  seq.forEach((rank, i) => {
    const out = crossingStep(rank, tier, st, 1000 * MIN + i * 10 * MIN);
    if (out.notify) sent += 1;
    st = out.st;
  });
  assert.equal(sent, 1);
});

/* ---------- hourly cap + digest collapse ---------- */

test('applyHourlyCap sends all directly while under the 6/hour cap', () => {
  const out = applyHourlyCap(3, [], 0);
  assert.deepEqual([out.direct, out.digest, out.defer], [3, 0, 0]);
  assert.equal(out.stamps.length, 3);
});

test('applyHourlyCap collapses overflow into one digest inside the cap', () => {
  const out = applyHourlyCap(9, [], 1000);
  assert.deepEqual([out.direct, out.digest, out.defer], [5, 4, 0], '5 direct + 1 digest covering 4 = 6 sends');
  assert.equal(out.stamps.length, 6, 'digest counts against the cap');
});

test('applyHourlyCap defers (never drops) when the hour is already exhausted', () => {
  const now = 100 * MIN;
  const stamps = new Array(6).fill(now - 5 * MIN);
  const out = applyHourlyCap(2, stamps, now);
  assert.deepEqual([out.direct, out.digest, out.defer], [0, 0, 2]);
  assert.equal(out.stamps.length, 6, 'no new stamps for deferred sends');
});

test('applyHourlyCap window rolls: stamps older than an hour free the budget', () => {
  const now = 200 * MIN;
  const stamps = new Array(6).fill(now - 61 * MIN);
  const out = applyHourlyCap(2, stamps, now);
  assert.deepEqual([out.direct, out.digest, out.defer], [2, 0, 0]);
  assert.equal(out.stamps.length, 2, 'expired stamps pruned');
});

/* ---------- stale-sensor suppression ---------- */

test('gaugeRank ports the client stale rule: old or missing observations never rank', () => {
  const now = Date.now();
  assert.equal(gaugeRank(gauge('A', 'major', 30, now), now), 4, 'fresh major');
  assert.equal(gaugeRank(gauge('B', 'moderate', 11 * 60, now), now), 3, 'inside the 12h window');
  assert.equal(gaugeRank(gauge('C', 'major', 13 * 60, now), now), 0, 'stale sensor suppressed');
  assert.equal(gaugeRank({ lid: 'D', status: { observed: { floodCategory: 'major' } } }, now), 0, 'no validTime');
  assert.equal(gaugeRank(gauge('E', 'out_of_service', 5, now), now), 0, 'unknown category');
});

/* ---------- Worker string table: en/es parity, punctuation, framing ---------- */

test('worker push strings have en/es parity, the WEA/911 line, and no em-dash', () => {
  assert.deepEqual(Object.keys(PUSH_STRINGS).sort(), ['en', 'es']);
  assert.deepEqual(Object.keys(PUSH_STRINGS.en).sort(), Object.keys(PUSH_STRINGS.es).sort());
  for (const lang of ['en', 'es']) {
    for (const k of Object.keys(PUSH_STRINGS[lang])) {
      const v = PUSH_STRINGS[lang][k];
      assert.ok(v && v.length, `empty ${lang}.${k}`);
      assert.ok(!v.includes('—'), `em-dash in PUSH_STRINGS.${lang}.${k}`);
    }
    for (const k of ['gauge.body', 'gauge.body.notime', 'digest.body', 'ffe.body', 'confirm.body']) {
      const marker = lang === 'en' ? 'Not a WEA/911 service' : 'No sustituye a WEA ni al 911';
      assert.ok(PUSH_STRINGS[lang][k].includes(marker), `WEA/911 line missing from ${lang}.${k}`);
    }
  }
});

/* ---------- integration: subscribe confirmation push ---------- */

test('a NEW subscription gets one encrypted localized confirmation push; prefs updates do not', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  const client = makeClientKeys();
  const log = mockNet({});
  const body = {
    subscription: { endpoint: FCM + 'real', keys: { p256dh: client.p256dh, auth: client.auth } },
    prefs: { ffe: true, tier: 'moderate' }, lang: 'es',
  };
  const out = await reg.doSubscribe(body, '', now);
  assert.equal(out.ok, true);
  assert.equal(out.confirmed, true, 'confirmation delivered');
  assert.equal(log.length, 1, 'exactly one send');
  assert.equal(log[0].headers['Content-Encoding'], 'aes128gcm', 'confirmation is encrypted');
  const payload = JSON.parse(decryptPush(client, log[0].body).plaintext.toString());
  assert.equal(payload.t, 'confirm');
  assert.equal(payload.lang, 'es');
  assert.equal(payload.title, PUSH_STRINGS.es['confirm.title'], 'localized per the stored lang');
  assert.ok(payload.body.includes('No sustituye a WEA ni al 911'));
  // same endpoint again (a prefs change) — no second confirmation
  const log2 = mockNet({});
  const upd = await reg.doSubscribe({ ...body, prefs: { ffe: true, tier: 'major' } }, '', now + 1000);
  assert.equal(upd.ok, true);
  assert.equal(upd.confirmed, false);
  assert.equal(log2.length, 0, 'no push traffic on a prefs update');
});

/* ---------- integration: gauge pass through doEvaluate ---------- */

test('a tier subscriber gets an encrypted gauge payload with name, category, and deep link', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  const client = makeClientKeys();
  mockNet({});
  await reg.doSubscribe({
    subscription: { endpoint: FCM + 'g1', keys: { p256dh: client.p256dh, auth: client.auth } },
    prefs: { ffe: true, tier: 'moderate' }, lang: 'en',
  }, '', now);
  const snapshot = {
    generated: 'gen-1',
    gauges: [
      gauge('SRRT2', 'moderate', 20, now, 'San Antonio River at Runge'),
      gauge('CALM1', 'minor', 20, now),
      gauge('STAL1', 'major', 14 * 60, now), // stale sensor — must never notify
    ],
  };
  const log = mockNet({ snapshot });
  const out = await reg.doEvaluate(now);
  assert.equal(out.crossings, 1, 'only the fresh moderate crossing fires');
  assert.equal(out.sent, 1);
  assert.equal(log.length, 1);
  assert.equal(log[0].headers['Content-Encoding'], 'aes128gcm');
  const payload = JSON.parse(decryptPush(client, log[0].body).plaintext.toString());
  assert.equal(payload.t, 'gauge');
  assert.equal(payload.lid, 'SRRT2');
  assert.ok(payload.title.includes('San Antonio River at Runge'), 'gauge name in the title');
  assert.ok(payload.title.includes(PUSH_STRINGS.en['cat.moderate']), 'localized category in the title');
  assert.equal(payload.url, '/?hydro=SRRT2', 'deep link to the hydrograph modal');
  assert.equal(payload.tag, 'g-SRRT2');
  assert.ok(payload.body.includes('Not a WEA/911 service'));

  // same snapshot stamp → the pass is skipped entirely (nothing newly deployed)
  const log2 = mockNet({ snapshot });
  const second = await reg.doEvaluate(now + 5 * MIN);
  assert.equal(second.crossings, 0);
  assert.equal(log2.length, 0, 'no traffic on an unchanged generated stamp');

  // new stamp, same category → dedup holds (no re-notify)
  const log3 = mockNet({ snapshot: { ...snapshot, generated: 'gen-2' } });
  const third = await reg.doEvaluate(now + 40 * MIN);
  assert.equal(third.crossings, 0, 'no repeat for an unchanged category');
  assert.equal(log3.length, 0);
});

test('tier=major subscribers are not notified for a moderate crossing', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  mockNet({});
  await reg.doSubscribe(subBody('mj', { prefs: { ffe: false, tier: 'major' } }), '', now);
  const log = mockNet({ snapshot: { generated: 'gen-1', gauges: [gauge('MODG1', 'moderate', 10, now)] } });
  const out = await reg.doEvaluate(now);
  assert.equal(out.crossings, 0);
  assert.equal(log.length, 0);
});

test('a mass crossing collapses into 5 direct sends plus one digest (6/hour cap)', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  const client = makeClientKeys();
  mockNet({});
  await reg.doSubscribe({
    subscription: { endpoint: FCM + 'cap', keys: { p256dh: client.p256dh, auth: client.auth } },
    prefs: { ffe: true, tier: 'moderate' }, lang: 'en',
  }, '', now);
  const gauges = [];
  for (let i = 0; i < 9; i++) gauges.push(gauge(`G${i}LID`, 'major', 10, now));
  const log = mockNet({ snapshot: { generated: 'gen-1', gauges } });
  const out = await reg.doEvaluate(now);
  assert.equal(out.crossings, 5);
  assert.equal(out.digests, 1);
  assert.equal(out.sent, 6, 'cap respected: 5 direct + 1 digest');
  const last = JSON.parse(decryptPush(client, log[log.length - 1].body).plaintext.toString());
  assert.equal(last.t, 'digest');
  assert.ok(last.title.includes('4'), 'digest counts the collapsed remainder');
});

/* ---------- nudge: HMAC + timestamp window ---------- */

const NUDGE_KEY = 'aa11bb22cc33dd44ee55ff66aa77bb88aa11bb22cc33dd44ee55ff66aa77bb88';
const sigFor = (body, key = NUDGE_KEY) => nodeCrypto.createHmac('sha256', key).update(body).digest('hex');

test('verifyNudgeSig accepts the openssl-style HMAC and rejects tampering', async () => {
  const subtle = nodeCrypto.webcrypto.subtle;
  const body = '{"ts":1753000000}';
  assert.equal(await verifyNudgeSig(subtle, NUDGE_KEY, body, sigFor(body)), true);
  assert.equal(await verifyNudgeSig(subtle, NUDGE_KEY, body, sigFor(body).toUpperCase()), true, 'hex case-insensitive');
  assert.equal(await verifyNudgeSig(subtle, NUDGE_KEY, body + ' ', sigFor(body)), false, 'body tamper');
  assert.equal(await verifyNudgeSig(subtle, NUDGE_KEY, body, sigFor(body, 'wrong-key')), false, 'wrong key');
  assert.equal(await verifyNudgeSig(subtle, NUDGE_KEY, body, 'garbage'), false);
  assert.equal(await verifyNudgeSig(subtle, NUDGE_KEY, body, ''), false);
});

test('doNudge runs an evaluation for a valid signed fresh nudge', async () => {
  const { reg } = newRegistry({ PUSH_NUDGE_KEY: NUDGE_KEY });
  const now = Date.now();
  mockNet({});
  const body = JSON.stringify({ ts: Math.floor(now / 1000) });
  const out = await reg.doNudge(body, sigFor(body), now);
  assert.equal(out.nudged, true);
  assert.equal(out.ok, true, 'evaluation ran');
});

test('doNudge rejects bad signatures, expired timestamps, and garbage bodies', async () => {
  const { reg } = newRegistry({ PUSH_NUDGE_KEY: NUDGE_KEY });
  const now = Date.now();
  mockNet({});
  const good = JSON.stringify({ ts: Math.floor(now / 1000) });
  assert.equal((await reg.doNudge(good, 'deadbeef', now))._status, 403, 'bad signature');
  const old = JSON.stringify({ ts: Math.floor(now / 1000) - 11 * 60 });
  assert.equal((await reg.doNudge(old, sigFor(old), now))._status, 403, 'outside the ±10 min window');
  const future = JSON.stringify({ ts: Math.floor(now / 1000) + 11 * 60 });
  assert.equal((await reg.doNudge(future, sigFor(future), now))._status, 403, 'future replay');
  const garbage = 'not json at all';
  assert.equal((await reg.doNudge(garbage, sigFor(garbage), now))._status, 403, 'signed garbage still fails the window');
  const noKey = newRegistry();
  assert.equal((await noKey.reg.doNudge(good, sigFor(good), now))._status, 503, 'no key configured');
});
