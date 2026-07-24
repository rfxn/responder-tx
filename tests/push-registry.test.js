'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  allowedEndpoint, newRegistry, mockRes, sandbox,
} = require('./push-harness.js');

const FCM = 'https://fcm.googleapis.com/fcm/send/test-endpoint-';
const subBody = (n, extra = {}) => ({
  subscription: { endpoint: FCM + n, keys: { p256dh: 'pk' + n, auth: 'ak' + n } },
  prefs: { ffe: true }, lang: 'en', ...extra,
});

// one in-AO FFE feature for the default event AO (xmin -98, ymin 27.5, xmax -93.4, ymax 31)
const ffeFeature = (id, coords) => ({
  id,
  geometry: { type: 'Polygon', coordinates: [coords || [[-95.4, 29.7], [-95.2, 29.7], [-95.2, 29.9], [-95.4, 29.9], [-95.4, 29.7]]] },
  properties: { event: 'Flash Flood Warning', description: 'This is a FLASH FLOOD EMERGENCY for the area.', parameters: {} },
});

// route the DO's outbound fetches: NWS alerts, event.json, the mirror gauges snapshot,
// and push-service sends
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

/* ---------- endpoint allowlist ---------- */

test('allowlist accepts the known push-service hosts, https only', () => {
  assert.ok(allowedEndpoint('https://fcm.googleapis.com/fcm/send/abc'));
  assert.ok(allowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'));
  assert.ok(allowedEndpoint('https://ab12.notify.windows.com/w/?token=x'));
  assert.ok(allowedEndpoint('https://web.push.apple.com/QOr...'));
  assert.ok(allowedEndpoint('https://jmt17.google.com/fcm/send/abc'), 'Chromium FCM edge host');
  assert.ok(!allowedEndpoint('https://jmt17x.google.com/fcm/send/abc'), 'jmt pattern is digits-only');
  assert.ok(!allowedEndpoint('https://accounts.google.com/x'), 'google.com is not broadly allowed');
  assert.ok(!allowedEndpoint('http://fcm.googleapis.com/fcm/send/abc'), 'http rejected');
  assert.ok(!allowedEndpoint('https://evil.example.com/collect'), 'unknown host rejected');
  assert.ok(!allowedEndpoint('https://fcm.googleapis.com.evil.com/x'), 'suffix spoof rejected');
  assert.ok(!allowedEndpoint('not a url'));
});

/* ---------- subscribe validation ---------- */

test('subscribe stores an anonymous row and sanitizes P2 prefs (ffe + tier only)', async () => {
  const { reg, state } = newRegistry();
  mockNet({}); // confirmation send lands 201
  const out = await reg.doSubscribe(subBody(1, { prefs: { ffe: false, tier: 'moderate', bogus: 1 } }), '1.2.3.4', Date.now());
  assert.equal(out.ok, true);
  // JSON round-trip: the DO's objects come from another vm realm (prototype identity differs)
  assert.deepEqual(JSON.parse(JSON.stringify(out.prefs)), { ffe: false, tier: 'moderate', gauges: [] }, 'user choices honored, unknown keys stripped');
  const bogusTier = await reg.doSubscribe(subBody(2, { prefs: { tier: 'minor' } }), '1.2.3.4', Date.now());
  assert.deepEqual(JSON.parse(JSON.stringify(bogusTier.prefs)), { ffe: true, tier: null, gauges: [] }, 'invalid tier collapses to null');
  const rows = [...state._store.entries()].filter(([k]) => k.startsWith('sub:'));
  assert.equal(rows.length, 2);
  const row = rows.find(([k, v]) => v.endpoint === FCM + '1')[1];
  assert.equal(row.lang, 'en');
  assert.deepEqual(Object.keys(row).sort(), ['auth', 'created', 'endpoint', 'id', 'lang', 'p256dh', 'prefs', 'renewed'], 'no extra identity fields stored');
});

test('subscribe rejects non-allowlisted or missing endpoints with 400', async () => {
  const { reg } = newRegistry();
  const bad = await reg.doSubscribe({ subscription: { endpoint: 'https://evil.example.com/x' } }, '', Date.now());
  assert.equal(bad._status, 400);
  const none = await reg.doSubscribe({}, '', Date.now());
  assert.equal(none._status, 400);
});

test('subscribe is 503 when VAPID keys are not configured', async () => {
  const { reg } = newRegistry({ VAPID_PRIVATE_KEY: '' });
  const out = await reg.doSubscribe(subBody(1), '', Date.now());
  assert.equal(out._status, 503);
});

test('subscribe-family rate limit trips per IP within the window', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  mockNet({});
  for (let i = 0; i < 10; i++) {
    const out = await reg.doSubscribe(subBody(i), '9.9.9.9', now);
    assert.equal(out.ok, true, `call ${i} should pass`);
  }
  const eleventh = await reg.doSubscribe(subBody(99), '9.9.9.9', now);
  assert.equal(eleventh._status, 429);
  const otherIp = await reg.doSubscribe(subBody(100), '8.8.8.8', now);
  assert.equal(otherIp.ok, true, 'a different IP is not throttled');
});

/* ---------- unsubscribe / renew ---------- */

test('unsubscribe deletes the row for the presented endpoint', async () => {
  const { reg, state } = newRegistry();
  const now = Date.now();
  mockNet({});
  await reg.doSubscribe(subBody(1), '', now);
  const out = await reg.doUnsubscribe({ endpoint: FCM + '1' }, '', now);
  assert.equal(out.ok, true);
  assert.equal([...state._store.keys()].filter((k) => k.startsWith('sub:')).length, 0);
});

test('renew refreshes the TTL stamp and 404s for unknown endpoints', async () => {
  const { reg, state } = newRegistry();
  const t0 = Date.now() - 1000;
  mockNet({});
  await reg.doSubscribe(subBody(1), '', t0);
  const out = await reg.doRenew({ endpoint: FCM + '1' }, '', t0 + 500);
  assert.equal(out.ok, true);
  const row = [...state._store.entries()].find(([k]) => k.startsWith('sub:'))[1];
  assert.equal(row.renewed, t0 + 500);
  const missing = await reg.doRenew({ endpoint: FCM + 'nope' }, '', t0);
  assert.equal(missing._status, 404);
});

/* ---------- evaluator: FFE detection, AO filter, dedup by alert id ---------- */

test('evaluate sends one push per subscription for a new in-AO FFE, then dedups by id', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  mockNet({}); // confirmation sends drain here, before the pass under test
  await reg.doSubscribe(subBody(1), '', now);
  await reg.doSubscribe(subBody(2), '', now);
  const log = mockNet({ features: [ffeFeature('urn:oid:ffe-1')] });
  const first = await reg.doEvaluate(now);
  assert.equal(first.newFfe, 1);
  assert.equal(first.sent, 2, 'both subscribers pushed');
  assert.equal(first.queued, 0);
  const auth = log[0].headers.Authorization || '';
  assert.match(auth, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/, 'RFC 8292 vapid auth header');
  // same alert id on the next pass: no new notifications
  const log2 = mockNet({ features: [ffeFeature('urn:oid:ffe-1')] });
  const second = await reg.doEvaluate(now + 60000);
  assert.equal(second.newFfe, 0);
  assert.equal(log2.length, 0, 'no push traffic on a deduped pass');
  // a replacement product with a NEW id counts as new
  mockNet({ features: [ffeFeature('urn:oid:ffe-2')] });
  const third = await reg.doEvaluate(now + 120000);
  assert.equal(third.newFfe, 1);
});

test('evaluate ignores FFE products whose polygon is outside the AO and non-FFE products', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  mockNet({});
  await reg.doSubscribe(subBody(1), '', now);
  const outside = ffeFeature('urn:oid:far', [[-103.5, 31.5], [-103.4, 31.5], [-103.4, 31.6], [-103.5, 31.6], [-103.5, 31.5]]);
  const plainWarning = {
    id: 'urn:oid:ffw',
    geometry: { type: 'Polygon', coordinates: [[[-95.4, 29.7], [-95.2, 29.7], [-95.2, 29.9], [-95.4, 29.9], [-95.4, 29.7]]] },
    properties: { event: 'Flash Flood Warning', description: 'Ordinary warning text.', parameters: {} },
  };
  const log = mockNet({ features: [outside, plainWarning] });
  const out = await reg.doEvaluate(now);
  assert.equal(out.newFfe, 0);
  assert.equal(log.length, 0);
});

test('a 410 from the push service deletes the subscription row', async () => {
  const { reg, state } = newRegistry();
  const now = Date.now();
  mockNet({});
  await reg.doSubscribe(subBody(1), '', now);
  mockNet({ features: [ffeFeature('urn:oid:gone')], pushStatus: 410 });
  await reg.doEvaluate(now);
  assert.equal([...state._store.keys()].filter((k) => k.startsWith('sub:')).length, 0, 'row deleted on 410');
});

test('rows older than the 60-day TTL are pruned during evaluation', async () => {
  const { reg, state } = newRegistry();
  const now = Date.now();
  mockNet({});
  await reg.doSubscribe(subBody(1), '', now - 61 * 24 * 3600 * 1000);
  await reg.doSubscribe(subBody(2), '', now - 1000);
  mockNet({ features: [] });
  await reg.doEvaluate(now);
  const keys = [...state._store.keys()].filter((k) => k.startsWith('sub:'));
  assert.equal(keys.length, 1, 'expired row pruned, fresh row kept');
});

/* ---------- send queue: batch ceiling + alarm chaining ---------- */

test('sends drain in batches of 40 with an alarm chained for the remainder', async () => {
  const { reg, state } = newRegistry();
  const now = Date.now();
  mockNet({});
  for (let i = 0; i < 41; i++) await reg.doSubscribe(subBody(i), '', now);
  mockNet({ features: [ffeFeature('urn:oid:big')] });
  const out = await reg.doEvaluate(now);
  assert.equal(out.sent, 40, 'first invocation respects the subrequest ceiling');
  assert.equal(out.queued, 1);
  assert.ok(await state.storage.getAlarm(), 'alarm chained for the remainder');
  await reg.alarm();
  const q = await state.storage.get('sendq');
  assert.equal(q.length, 0, 'alarm pass drains the rest');
});

/* ---------- status / peek / testfire ---------- */

test('status exposes configured flag, lastEval, and the public VAPID key only', async () => {
  const { reg, env } = newRegistry();
  const out = await reg.doStatus(Date.now());
  assert.deepEqual(Object.keys(out).sort(), ['configured', 'lastEval', 'vapidKey']);
  assert.equal(out.configured, true);
  assert.equal(out.vapidKey, env.VAPID_PUBLIC_KEY);
});

test('testfire pushes to one named stored subscription and reports the service status', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  mockNet({});
  await reg.doSubscribe(subBody(1), '', now);
  await reg.doSubscribe(subBody(2), '', now);
  const log = mockNet({ pushStatus: 201 });
  const out = await reg.doTestfire({ endpoint: FCM + '1' }, now);
  assert.equal(out.fired, 1);
  assert.equal(out.results[0].status, 201);
  assert.equal(log.length, 1);
  assert.ok(log[0].url.endsWith('test-endpoint-1'));
  const missing = await reg.doTestfire({ endpoint: FCM + 'unknown' }, now);
  assert.equal(missing._status, 404);
});
