'use strict';

/*
 * Web-push alert area (v0.99.38). Until this shipped, every area-wide notification was scoped to
 * the event AO, which is the whole state, so one Flash Flood Emergency reached every subscriber
 * in Texas regardless of distance. These tests pin the replacement: an explicit per-subscription
 * area (statewide, followed places, or unset), the unset default for a subscriber who shared no
 * location, the grandfathered statewide for rows written before the choice existed, and the
 * unchanged most-sensitive-wins merge with per-gauge follows.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  newRegistry, mockRes, sandbox, makeClientKeys, decryptPush,
  sanitizePrefs, sanitizePlaces, scopeOf, scopeCoversPoint, ffeReachesSub, alertReachesPlace,
  effectiveTierRank, kmBetween, pointInRings, kmToRings, PUSH_STRINGS, CAT_RANK, PLACE_KM,
} = require('./push-harness.js');

const MIN = 60 * 1000;
const FCM = 'https://fcm.googleapis.com/fcm/send/test-endpoint-';
const J = (x) => JSON.parse(JSON.stringify(x));

// the two ends of the state the old behavior collapsed into one notification list
const HOUSTON = { lat: 29.76, lon: -95.37 };
const EL_PASO = { lat: 31.76, lon: -106.49 };

const place = (p, km = 16) => ({ lat: p.lat, lon: p.lon, km });

const sub = (n, prefs, keys) => ({
  subscription: { endpoint: FCM + n, keys: keys || { p256dh: 'pk' + n, auth: 'ak' + n } },
  prefs, lang: 'en',
});

const gauge = (lid, cat, obsAgoMin, now, at, name) => ({
  lid,
  name: name || `${lid} test river`,
  latitude: at ? at.lat : undefined,
  longitude: at ? at.lon : undefined,
  status: {
    observed: {
      primary: 20.5, primaryUnit: 'ft', floodCategory: cat,
      validTime: new Date(now - obsAgoMin * MIN).toISOString(),
    },
  },
});

// a square FFE polygon of about 0.2 degrees around a point
const ffeAt = (id, p, half = 0.1, extra = {}) => ({
  id,
  geometry: {
    type: 'Polygon',
    coordinates: [[
      [p.lon - half, p.lat - half], [p.lon + half, p.lat - half],
      [p.lon + half, p.lat + half], [p.lon - half, p.lat + half], [p.lon - half, p.lat - half],
    ]],
  },
  properties: { event: 'Flash Flood Warning', description: 'This is a FLASH FLOOD EMERGENCY for the area.', parameters: {}, ...extra },
});

// statewide AO, as data/event.json has carried since the standing-regions reset
const STATE_BBOX = { xmin: -106.65, ymin: 25.83, xmax: -93.4, ymax: 36.5 };

function mockNet({ features = [], snapshot = null, zones = {}, pushStatus = 201, pushLog = [] } = {}) {
  sandbox.__fetchMock = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('api.weather.gov/alerts')) return mockRes(200, { features });
    if (u.includes('api.weather.gov/zones')) {
      const z = zones[u];
      return z ? mockRes(200, z) : mockRes(404, {});
    }
    if (u.includes('respondertx.org/data/event.json')) return mockRes(200, { gaugeBbox: STATE_BBOX });
    if (u.includes('respondertx.org/data/gauges-snapshot.json')) {
      return mockRes(200, snapshot || { generated: '', gauges: [] });
    }
    pushLog.push({ url: u, headers: (opts && opts.headers) || {}, body: (opts && opts.body) || null });
    return mockRes(typeof pushStatus === 'function' ? pushStatus(u) : pushStatus, {});
  };
  return pushLog;
}

/* ---------- prefs: the area choice and the stored points ---------- */

test('sanitizePrefs: an unstated or unknown area is never statewide', () => {
  assert.equal(sanitizePrefs({}).scope, 'none', 'a subscriber who chose nothing gets nothing area-wide');
  assert.equal(sanitizePrefs({ scope: 'texas' }).scope, 'none');
  assert.equal(sanitizePrefs({ scope: '' }).scope, 'none');
  assert.equal(sanitizePrefs(null).scope, 'none');
  assert.equal(sanitizePrefs({ scope: 'statewide' }).scope, 'statewide', 'statewide stays available, as a choice');
  assert.equal(sanitizePrefs({ scope: 'places' }).scope, 'places');
});

test('sanitizePlaces rounds to about a kilometer, dedups at that precision, and caps the radius set', () => {
  const out = J(sanitizePlaces([
    { lat: 30.267153, lon: -97.743057, km: 8 },
    { lat: 30.2669, lon: -97.7434, km: 40 },     // same rounded pair: dropped
    { lat: 29.76, lon: -95.37, km: 999 },        // radius outside the chip set: default
    { lat: 91, lon: -95, km: 8 },                // impossible latitude
    { lat: 'x', lon: -95, km: 8 },
    'garbage',
  ]));
  assert.deepEqual(out, [
    { lat: 30.27, lon: -97.74, km: 8 },
    { lat: 29.76, lon: -95.37, km: 16 },
  ]);
  for (const p of out) {
    assert.ok(PLACE_KM.includes(p.km), 'radius comes from the offered set');
    assert.deepEqual(Object.keys(p).sort(), ['km', 'lat', 'lon'], 'no label, no address, no accuracy trail');
  }
});

test('sanitizePlaces keeps at most 5 points', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ lat: 30 + i, lon: -97, km: 16 }));
  assert.equal(sanitizePlaces(many).length, 5);
});

test('subscribe rejects more than 5 places with 400; exactly 5 is accepted', async () => {
  const { reg } = newRegistry();
  mockNet({});
  const many = (n) => Array.from({ length: n }, (_, i) => ({ lat: 30 + i, lon: -97, km: 16 }));
  const over = await reg.doSubscribe(sub('pcap', { scope: 'places', places: many(6) }), '', Date.now());
  assert.equal(over._status, 400);
  const atCap = await reg.doSubscribe(sub('pcap', { scope: 'places', places: many(5) }), '', Date.now());
  assert.equal(atCap.ok, true);
  assert.equal(J(atCap.prefs).places.length, 5);
});

/* ---------- the failure this release exists to end ---------- */

test('an El Paso subscriber is not notified for a Houston emergency; a statewide subscriber is', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  mockNet({});
  await reg.doSubscribe(sub('elp', { ffe: true, scope: 'places', places: [place(EL_PASO)] }), '', now);
  await reg.doSubscribe(sub('state', { ffe: true, scope: 'statewide' }), '', now);
  const log = mockNet({ features: [ffeAt('urn:oid:hou', HOUSTON)] });
  const out = await reg.doEvaluate(now);
  assert.equal(out.newFfe, 1, 'the emergency is still detected, and still in the AO');
  assert.equal(out.enqueued, 1, 'only the statewide subscriber is queued');
  assert.equal(log.length, 1);
  assert.match(String(log[0].url), /test-endpoint-state$/, 'the 750 mile away device stays quiet');
});

test('a place subscriber inside the polygon, and one within the radius of its edge, are both notified', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  mockNet({});
  // inside the polygon
  await reg.doSubscribe(sub('inside', { ffe: true, scope: 'places', places: [place(HOUSTON)] }), '', now);
  // about 15 km east of the polygon edge: inside a 16 km radius, outside an 8 km one
  await reg.doSubscribe(sub('near', { ffe: true, scope: 'places', places: [place({ lat: 29.76, lon: -95.11 }, 16)] }), '', now);
  await reg.doSubscribe(sub('near8', { ffe: true, scope: 'places', places: [place({ lat: 29.76, lon: -95.11 }, 8)] }), '', now);
  // a different metro entirely
  await reg.doSubscribe(sub('far', { ffe: true, scope: 'places', places: [place({ lat: 30.27, lon: -97.74 })] }), '', now);
  const log = mockNet({ features: [ffeAt('urn:oid:hou2', HOUSTON)] });
  const out = await reg.doEvaluate(now);
  assert.equal(out.enqueued, 2, 'the covered point and the one inside its radius');
  const hit = log.map((l) => String(l.url).replace(/^.*test-endpoint-/, '')).sort();
  assert.deepEqual(hit, ['inside', 'near']);
});

test('a place subscriber only gets gauge crossings inside the radius, statewide still gets all', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  mockNet({});
  await reg.doSubscribe(sub('gp', { ffe: false, tier: 'moderate', scope: 'places', places: [place(HOUSTON)] }), '', now);
  await reg.doSubscribe(sub('gs', { ffe: false, tier: 'moderate', scope: 'statewide' }), '', now);
  const log = mockNet({
    snapshot: {
      generated: 'g1',
      gauges: [
        gauge('HOUG1', 'moderate', 10, now, { lat: 29.8, lon: -95.4 }),   // 5 km from the place
        gauge('ELPG1', 'major', 10, now, EL_PASO),                        // 750 miles away
      ],
    },
  });
  const out = await reg.doEvaluate(now);
  assert.equal(out.crossings, 3, 'statewide takes both gauges, the place subscriber takes one');
  const hit = log.map((l) => String(l.url).replace(/^.*test-endpoint-/, ''));
  assert.equal(hit.filter((h) => h === 'gp').length, 1, 'the place subscriber hears about its own river only');
  assert.equal(hit.filter((h) => h === 'gs').length, 2);
});

test('a gauge with no coordinates never counts as near a place, and never blocks statewide', () => {
  const places = { scope: 'places', places: [place(HOUSTON)] };
  assert.equal(scopeCoversPoint(places, undefined, undefined), false);
  assert.equal(scopeCoversPoint(places, NaN, NaN), false);
  assert.equal(scopeCoversPoint({ scope: 'statewide' }, undefined, undefined), true);
});

/* ---------- the default for a subscriber who shared nothing ---------- */

test('a subscriber who shares no location gets no area-wide alerts, provably', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  mockNet({});
  // exactly what the card sends on a first tap: alert types on, no area chosen
  const out = await reg.doSubscribe(sub('fresh', { ffe: true, tier: 'moderate' }), '', now);
  assert.equal(J(out.prefs).scope, 'none');
  const ffeLog = mockNet({ features: [ffeAt('urn:oid:any', HOUSTON)] });
  const first = await reg.doEvaluate(now);
  assert.equal(first.newFfe, 1);
  assert.equal(first.enqueued, 0, 'no emergency push without an area');
  assert.equal(ffeLog.length, 0);
  const gLog = mockNet({ snapshot: { generated: 'g1', gauges: [gauge('ANYG1', 'major', 10, now, HOUSTON)] } });
  const second = await reg.doEvaluate(now + 10 * MIN);
  assert.equal(second.crossings, 0, 'no area-wide gauge push without an area');
  assert.equal(gLog.length, 0);
});

test('a followed gauge still alerts with no area chosen: the follow is the choice', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  mockNet({});
  await reg.doSubscribe(sub('fg', { ffe: true, tier: 'moderate', gauges: [{ lid: 'FOLL2', tier: 'major' }] }), '', now);
  const log = mockNet({
    snapshot: {
      generated: 'g1',
      gauges: [gauge('FOLL2', 'major', 10, now, EL_PASO), gauge('OTHR2', 'major', 10, now, HOUSTON)],
    },
  });
  const out = await reg.doEvaluate(now);
  assert.equal(out.crossings, 1, 'the followed gauge fires wherever it is; the unfollowed one does not');
  assert.equal(log.length, 1);
});

test('the confirmation push asks for an area when none was chosen, and does not when one was', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  const c1 = makeClientKeys();
  let log = mockNet({});
  await reg.doSubscribe(sub('c1', { ffe: true }, { p256dh: c1.p256dh, auth: c1.auth }), '', now);
  let payload = JSON.parse(decryptPush(c1, log[0].body).plaintext.toString());
  assert.equal(payload.body, PUSH_STRINGS.en['confirm.body.noarea']);
  assert.ok(payload.body.includes('Not a WEA/911 service'), 'the framing rides every payload');
  const c2 = makeClientKeys();
  log = mockNet({});
  await reg.doSubscribe(sub('c2', { ffe: true, scope: 'statewide' }, { p256dh: c2.p256dh, auth: c2.auth }), '', now);
  payload = JSON.parse(decryptPush(c2, log[0].body).plaintext.toString());
  assert.equal(payload.body, PUSH_STRINGS.en['confirm.body']);
});

/* ---------- rows written before the choice existed ---------- */

test('a subscription stored without an area keeps statewide delivery, and renew materializes it', async () => {
  const { reg, state } = newRegistry();
  const now = Date.now();
  mockNet({});
  await reg.doSubscribe(sub('legacy', { ffe: true, tier: 'moderate' }), '', now);
  // rewrite the row the way v0.99.37 stored it: prefs with no scope key at all
  const key = [...state._store.keys()].find((k) => k.startsWith('sub:'));
  const row = await state.storage.get(key);
  delete row.prefs.scope;
  delete row.prefs.places;
  await state.storage.put(key, row);
  assert.equal(scopeOf(row.prefs), 'statewide', 'grandfathered, not silently switched off');

  const log = mockNet({ features: [ffeAt('urn:oid:legacy', HOUSTON)] });
  const out = await reg.doEvaluate(now);
  assert.equal(out.enqueued, 1, 'an existing subscriber keeps the delivery they opted into');
  assert.equal(log.length, 1);

  mockNet({});
  const renewed = await reg.doRenew({ endpoint: FCM + 'legacy' }, '', now + MIN);
  assert.equal(J(renewed.prefs).scope, 'statewide', 'the card is told the same truth the evaluator uses');
  assert.equal(J((await state.storage.get(key)).prefs).scope, 'statewide', 'and the row now says it explicitly');
});

/* ---------- the area and the follows coexist, most sensitive wins ---------- */

test('effectiveTierRank: the area gates the area-wide tier only, never a per-gauge follow', () => {
  const both = { tier: 'major', gauges: [{ lid: 'A1LID', tier: 'moderate' }] };
  assert.equal(effectiveTierRank(both, 'A1LID', true), CAT_RANK.moderate, 'most sensitive of the two wins');
  assert.equal(effectiveTierRank(both, 'A1LID', false), CAT_RANK.moderate, 'out of area, the follow still stands');
  assert.equal(effectiveTierRank(both, 'B2LID', true), CAT_RANK.major, 'in area, the area-wide tier applies');
  assert.equal(effectiveTierRank(both, 'B2LID', false), 0, 'out of area, an unfollowed gauge is unwatched');
  assert.equal(effectiveTierRank({ tier: 'moderate' }, 'ANY1'), CAT_RANK.moderate, 'callers with no point to test still resolve');
});

test('a place subscriber following a distant gauge at major gets that one and nothing else near it', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  mockNet({});
  await reg.doSubscribe(sub('mix', {
    ffe: false, tier: 'moderate', scope: 'places', places: [place(HOUSTON)],
    gauges: [{ lid: 'FARG2', tier: 'major' }],
  }), '', now);
  const log = mockNet({
    snapshot: {
      generated: 'g1',
      gauges: [
        gauge('FARG2', 'moderate', 10, now, EL_PASO),                   // followed at major: silent at moderate
        gauge('NEARG', 'moderate', 10, now, { lat: 29.8, lon: -95.4 }), // in the place radius: the area tier fires
        gauge('OTHR2', 'major', 10, now, EL_PASO),                      // out of area, unfollowed: silent
      ],
    },
  });
  let out = await reg.doEvaluate(now);
  assert.equal(out.crossings, 1);
  assert.equal(log.length, 1);
  // the followed gauge reaching its own tier fires wherever it is
  const log2 = mockNet({
    snapshot: { generated: 'g2', gauges: [gauge('FARG2', 'major', 10, now, EL_PASO)] },
  });
  out = await reg.doEvaluate(now + 40 * MIN);
  assert.equal(out.crossings, 1);
  assert.equal(log2.length, 1);
});

/* ---------- prefs round-trip through the registry ---------- */

test('places round-trip through subscribe and come back on renew, rounded and capped', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  mockNet({});
  const wanted = {
    ffe: true, tier: 'major', scope: 'places',
    gauges: [{ lid: 'SRRT2', tier: 'moderate' }],
    places: [{ lat: 29.761234, lon: -95.369876, km: 40 }, { lat: 30.27, lon: -97.74, km: 8 }],
  };
  const stored = await reg.doSubscribe(sub('rt', wanted), '', now);
  assert.deepEqual(J(stored.prefs), {
    ffe: true, tier: 'major', gauges: [{ lid: 'SRRT2', tier: 'moderate' }], scope: 'places',
    places: [{ lat: 29.76, lon: -95.37, km: 40 }, { lat: 30.27, lon: -97.74, km: 8 }],
  });
  const back = await reg.doRenew({ endpoint: FCM + 'rt' }, '', now + MIN);
  assert.deepEqual(J(back.prefs), J(stored.prefs), 'the registry hands back exactly what it holds');
  // and nothing else about the subscriber is kept alongside it
  const peek = await reg.doPeek(now);
  assert.equal(peek.scopes.places, 1);
  assert.equal(peek.places, 2);
});

test('dropping to statewide clears nothing but the area, and switching back needs new points', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  mockNet({});
  await reg.doSubscribe(sub('sw', { scope: 'places', places: [place(HOUSTON)], tier: 'major' }), '', now);
  const wide = await reg.doSubscribe(sub('sw', { scope: 'statewide', tier: 'major' }), '', now + 1000);
  assert.equal(J(wide.prefs).places.length, 0, 'the points are dropped when the card stops using them');
  assert.equal(J(wide.prefs).scope, 'statewide');
});

/* ---------- geometry ---------- */

test('alertReachesPlace: inside, within the radius, and beyond it', () => {
  const geo = { rings: ffeAt('x', HOUSTON).geometry.coordinates, bboxes: [], resolved: true };
  assert.equal(alertReachesPlace(geo, place(HOUSTON, 8)), true, 'the point is inside the polygon');
  assert.equal(alertReachesPlace(geo, place({ lat: 29.76, lon: -95.11 }, 16)), true, 'about 15 km out, 16 km radius');
  assert.equal(alertReachesPlace(geo, place({ lat: 29.76, lon: -95.11 }, 8)), false, 'same point, 8 km radius');
  assert.equal(alertReachesPlace(geo, place(EL_PASO, 40)), false);
});

test('an emergency that cannot be located reaches statewide subscribers but no place subscriber', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  mockNet({});
  await reg.doSubscribe(sub('nsw', { ffe: true, scope: 'statewide' }), '', now);
  await reg.doSubscribe(sub('npl', { ffe: true, scope: 'places', places: [place(HOUSTON)] }), '', now);
  const noGeom = {
    id: 'urn:oid:nogeo',
    geometry: null,
    properties: {
      event: 'Flash Flood Warning', description: 'This is a FLASH FLOOD EMERGENCY for the area.',
      parameters: {}, affectedZones: ['https://api.weather.gov/zones/county/TXC201'],
    },
  };
  const log = mockNet({ features: [noGeom] });
  const out = await reg.doEvaluate(now);
  assert.equal(out.newFfe, 1, 'still notified about, since FFE fails toward telling people');
  assert.equal(out.enqueued, 1);
  assert.equal(String(log[0].url).endsWith('nsw'), true, 'proximity is never claimed for an unlocated product');
});

test('a zone-resolved emergency reaches a place subscriber inside the zone bbox', async () => {
  const { reg } = newRegistry();
  const now = Date.now();
  mockNet({});
  await reg.doSubscribe(sub('zpl', { ffe: true, scope: 'places', places: [place(HOUSTON)] }), '', now);
  await reg.doSubscribe(sub('zfar', { ffe: true, scope: 'places', places: [place(EL_PASO)] }), '', now);
  const zoneUrl = 'https://api.weather.gov/zones/county/TXC201';
  const noGeom = {
    id: 'urn:oid:zone',
    geometry: null,
    properties: {
      event: 'Flash Flood Warning', description: 'This is a FLASH FLOOD EMERGENCY for the area.',
      parameters: {}, affectedZones: [zoneUrl],
    },
  };
  const log = mockNet({ features: [noGeom], zones: { [zoneUrl]: ffeAt('z', HOUSTON, 0.3) } });
  const out = await reg.doEvaluate(now);
  assert.equal(out.enqueued, 1);
  assert.equal(String(log[0].url).endsWith('zpl'), true);
});

test('kmBetween, pointInRings and kmToRings agree with known distances', () => {
  assert.ok(Math.abs(kmBetween(HOUSTON.lat, HOUSTON.lon, EL_PASO.lat, EL_PASO.lon) - 1088) < 20,
    'Houston to El Paso is about 1090 km');
  assert.equal(kmBetween(29.76, -95.37, 29.76, -95.37), 0);
  const rings = ffeAt('x', HOUSTON).geometry.coordinates;
  assert.equal(pointInRings(HOUSTON.lat, HOUSTON.lon, rings), true);
  assert.equal(pointInRings(EL_PASO.lat, EL_PASO.lon, rings), false);
  assert.ok(kmToRings(HOUSTON.lat, HOUSTON.lon + 0.2, rings) > 8, 'a tenth of a degree east of the edge');
  assert.ok(kmToRings(HOUSTON.lat, HOUSTON.lon + 0.2, rings) < 12);
});

/* ---------- the card: the choice, and what it says is stored ---------- */

const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./harness.js');
const I18N = require('./i18n-load.js');

const BOARD = fs.readFileSync(path.join(__dirname, '..', 'js', 'board.js'), 'utf8');
const { pushNormalizePrefs, pushNormalizePlaces, pushScopeState, pushPlacesHtml, pushRadiusLabel } = loadApp();
const SB = loadApp()._sandbox;

/* Renders the shipped renderPushCard() for a subscribed device with `prefs`, then hands the host to
   `body` so a pane can be tapped open. A regex over js/board.js cannot tell a drawn card from one
   that throws on first paint, so what the card claims about coverage is read off markup it emitted.
   The cleanup closes any pane left open, because pushSection is module state the file shares. */
function renderSubscribed(prefs, body) {
  const keep = { qs: SB.document.querySelector, notif: SB.Notification, pm: SB.PushManager,
    secure: SB.isSecureContext, sw: SB.navigator.serviceWorker, ua: SB.navigator.userAgent };
  SB.isSecureContext = true;
  SB.navigator.serviceWorker = {};
  SB.navigator.userAgent = 'Mozilla/5.0';
  SB.Notification = { permission: 'granted' };
  SB.PushManager = function PushManager() {};
  SB.localStorage.setItem('respondertx.push', JSON.stringify({ on: true, prefs }));
  const host = {
    innerHTML: '', firstChild: true, taps: {},
    querySelectorAll(sel) {
      if (sel !== '.push-sec[data-sec]') return [];
      return [...host.innerHTML.matchAll(/push-sec" data-sec="([a-z]+)"/g)].map(([, key]) => ({
        getAttribute: (a) => (a === 'data-sec' ? key : null),
        addEventListener: (ev, fn) => { if (ev === 'click') host.taps[key] = fn; },
      }));
    },
  };
  SB.document.querySelector = (s) => (s === '#push-body' ? host : null);
  try {
    SB.renderPushCard();
    if (body) body(host);
    return host;
  } finally {
    const open = host.innerHTML.match(/data-sec="([a-z]+)" aria-expanded="true"/);
    if (open) host.taps[open[1]]();
    SB.document.querySelector = keep.qs; SB.Notification = keep.notif;
    SB.isSecureContext = keep.secure; SB.navigator.serviceWorker = keep.sw; SB.navigator.userAgent = keep.ua;
    if (keep.pm === undefined) delete SB.PushManager; else SB.PushManager = keep.pm;
    SB.localStorage.removeItem('respondertx.push'); // the bundle is cached across tests in this file
  }
}

// a pane that was never drawn is the failure, not a TypeError on a missing handler
function openPane(host, key) {
  assert.ok(host.taps[key], `the card drew no ${key} row to open`);
  host.taps[key]();
}

test('the client prefs normalizer mirrors the registry: unstated area is none, points are rounded', () => {
  assert.equal(pushNormalizePrefs({ ffe: true }).scope, 'none');
  assert.equal(pushNormalizePrefs({ scope: 'nonsense' }).scope, 'none');
  assert.equal(pushNormalizePrefs({ scope: 'statewide' }).scope, 'statewide');
  assert.deepEqual(J(pushNormalizePlaces([
    { lat: 29.761234, lon: -95.369876, km: 8 },
    { lat: 29.7609, lon: -95.3701, km: 40 },   // same rounded pair
    { lat: 30.27, lon: -97.74, km: 3 },        // radius outside the chip set
  ])), [{ lat: 29.76, lon: -95.37, km: 8 }, { lat: 30.27, lon: -97.74, km: 16 }]);
  assert.equal(pushNormalizePlaces(Array.from({ length: 9 }, (_, i) => ({ lat: 30 + i, lon: -97 }))).length, 5);
});

/* Turning alerts off deletes the SERVER row. If the local record is wiped with it, the device's
   followed gauges and alert places are gone with no recovery path anywhere: pushEnable() restores
   from exactly this cache. Three of the four turn-off paths wrote a bare {on:false} and shipped
   that way (pushSetPrefs's no-subscription branch, pushDisable, and initPushCard's browser-truth
   reconciliation); only pushBootSync's revoked-permission branch was right. An off/on cycle lost
   everything, silently. */
test('every turn-off path keeps this device\'s prefs, so re-enabling restores them', () => {
  const offWrites = [...BOARD.matchAll(/pushLocalSet\(\{\s*on:\s*false[^}]*\}\)/g)].map((m) => m[0]);
  assert.ok(offWrites.length >= 4, `expected every turn-off path to be seen, found ${offWrites.length}`);
  for (const w of offWrites) {
    assert.match(w, /prefs:\s*pushPrefs\(\)/,
      `a turn-off path wipes this device's followed gauges and places: ${w}`);
  }
});

test('pushDisable leaves the followed gauges and places on the device', async () => {
  const app = loadApp();
  const ls = app._sandbox.localStorage;
  const seeded = {
    on: true,
    prefs: { ffe: true, tier: 'major', gauges: [{ lid: 'SRRT2', tier: 'major' }], scope: 'places', places: [{ lat: 29.76, lon: -95.37, km: 16 }] },
  };
  ls.setItem('respondertx.push', JSON.stringify(seeded));
  await app.pushDisable();
  const after = JSON.parse(ls.getItem('respondertx.push'));
  ls.removeItem('respondertx.push'); // the bundle is cached across tests in this file
  assert.equal(after.on, false, 'the device must really be off');
  assert.ok(after.prefs, 'turning off wiped the whole prefs record; pushEnable has nothing to restore');
  assert.deepEqual(J(after.prefs.gauges), [{ lid: 'SRRT2', tier: 'major' }], 'followed gauges were wiped');
  assert.deepEqual(J(after.prefs.places), [{ lat: 29.76, lon: -95.37, km: 16 }], 'alert places were wiped');
  assert.equal(after.prefs.scope, 'places');
  assert.equal(after.prefs.tier, 'major');
});

test('pushScopeState tells the card when area alerts cannot fire', () => {
  assert.equal(pushScopeState({ scope: 'statewide' }), 'ok');
  assert.equal(pushScopeState({ scope: 'places', places: [{ lat: 29.76, lon: -95.37, km: 16 }] }), 'ok');
  assert.equal(pushScopeState({ scope: 'places', places: [] }), 'empty');
  assert.equal(pushScopeState({ scope: 'none' }), 'unset');
  assert.equal(pushScopeState({}), 'unset');
  assert.equal(pushScopeState(null), 'unset');
});

/* Being subscribed and being reachable are different facts. A fresh subscribe defaults scope 'none'
   (pushNormalizePrefs), and the worker's ffeReachesSub and scopeCoversPoint both refuse anything but
   statewide or places, so the device receives silence. The card used to headline that in green as
   "Alerts ON for this device". A followed gauge fires on its own threshold regardless of the area,
   so it alone is enough to make the ON claim true. */
test('pushDelivers separates a subscription that can be reached from one that cannot', () => {
  const { pushDelivers, pushScopeState } = loadApp();
  // field-wise, not deepEqual: the harness returns cross-realm objects
  const d = (prefs) => { const r = pushDelivers(prefs, pushScopeState(prefs)); return [r.area, r.gauges, r.any]; };
  // the exact default a fresh subscribe writes: ffe on, but no area to apply it to
  assert.deepEqual(d({ ffe: true, tier: null, gauges: [], scope: 'none', places: [] }), [false, false, false]);
  assert.deepEqual(d({ ffe: true, scope: 'statewide' }), [true, false, true]);
  assert.deepEqual(d({ ffe: false, tier: 'major', scope: 'statewide' }), [true, false, true]);
  // a covering area with every type off delivers nothing
  assert.deepEqual(d({ ffe: false, tier: null, gauges: [], scope: 'statewide', places: [] }), [false, false, false]);
  // places chosen but empty is not coverage
  assert.deepEqual(d({ ffe: true, scope: 'places', places: [] }), [false, false, false]);
  // a followed gauge is independent of the area, and is enough on its own
  assert.deepEqual(d({ ffe: false, tier: null, gauges: [{ lid: 'SRRT2', tier: 'major' }], scope: 'none', places: [] }),
    [false, true, true]);
  assert.deepEqual(d(null), [false, false, false]);
});

test('the card never headlines a green ON over a subscription that can deliver nothing', () => {
  // every way to be subscribed and unreachable: no area, an empty places list, and every type off
  for (const prefs of [
    { ffe: true, tier: null, gauges: [], scope: 'none', places: [] },
    { ffe: true, tier: null, gauges: [], scope: 'places', places: [] },
    { ffe: false, tier: null, gauges: [], scope: 'statewide', places: [] },
  ]) {
    const html = renderSubscribed(prefs).innerHTML;
    assert.match(html, /<div class="push-status push-silent">push\.state\.silent<\/div>/,
      `${JSON.stringify(prefs)} wore the on tone over a device that receives silence`);
    assert.ok(!html.includes('push-status push-on'), 'the on tone must not be painted alongside it');
  }

  // and a subscription that really can deliver keeps the plain ON, by either route
  for (const prefs of [
    { ffe: true, scope: 'statewide' },
    { ffe: false, tier: null, gauges: [{ lid: 'SRRT2', tier: 'major' }], scope: 'none', places: [] },
  ]) {
    const html = renderSubscribed(prefs).innerHTML;
    assert.match(html, /<div class="push-status push-on">push\.state\.on<\/div>/,
      `${JSON.stringify(prefs)} can deliver and must say so`);
  }

  // a covering area with every type off is the silent case the scope note does not reach, and it
  // is stated where the types are chosen, not only in the headline
  renderSubscribed({ ffe: false, tier: null, gauges: [], scope: 'statewide', places: [] }, (host) => {
    openPane(host, 'what');
    assert.match(host.innerHTML, /<div class="push-fix">push\.silent\.types<\/div>/,
      'the What pane must say that nothing selected means nothing delivered');
  });
});

/* The gear row is unconditional markup, so it is present on a board with no push worker behind it.
   initPushCard() is the only thing that ever proves a backend exists, and it proves it by leaving
   #push-body empty when there is none. Opening the sheet must therefore repaint through
   pushRerender(), which paints only an already-admitted card; calling renderPushCard() directly
   would paint a switch that cannot subscribe onto a board that has no alert delivery at all. */
test('opening the notify sheet cannot paint a card the backend check never admitted', () => {
  const open = BOARD.match(/function openNotifySheet\(section\)[\s\S]*?\n\}/);
  assert.ok(open, 'openNotifySheet() not found');
  assert.match(open[0], /pushRerender\(\)/, 'the sheet must repaint through the admitted-card path');
  assert.ok(!/renderPushCard\(\)/.test(open[0]),
    'openNotifySheet calls renderPushCard directly; that paints a card on a board with no backend');
  const rerender = BOARD.match(/function pushRerender\(\)[\s\S]*?\n\}/)[0];
  assert.match(rerender, /host && host\.firstChild/, 'pushRerender lost the empty-host guard it exists for');
  // and the row into the sheet only ever appears from a render that got that far
  const syncCalls = [...BOARD.matchAll(/pushSyncEntries\(/g)];
  assert.equal(syncCalls.length, 3, 'the entry rows must be published from the render paths only (1 def + 2 calls)');
});

test('a status probe that fails is reported, not published as "no device alerts here"', () => {
  const init = BOARD.match(/async function initPushCard\(\)[\s\S]*?\n\}/)[0];
  // 503 is how this board says "not wired", and hiding for it stays deliberate
  assert.match(init, /r\.status !== 503/, 'a 503 must still hide the card, and only a 503');
  assert.match(init, /catch \{ return pushRenderUnreachable\(host\); \}/,
    'a transport failure must say so rather than rendering nothing');
  assert.match(init, /if \(!d \|\| !d\.configured \|\| !d\.vapidKey\) return;/,
    'an absent backend must still hide the card entirely');
  assert.match(BOARD, /function pushRenderUnreachable\(host\)[\s\S]*?push\.unreachable/,
    'the unreachable notice must actually render the unreachable string');
});

test('the card offers the area choice ahead of the alert types, and explains an area that cannot fire', () => {
  // the accordion replaced the flat chip rows, so the ordering is now which PANE comes first
  renderSubscribed({ ffe: true, scope: 'statewide' }, (host) => {
    const where = host.innerHTML.indexOf('data-sec="where"');
    const what = host.innerHTML.indexOf('data-sec="what"');
    assert.ok(where !== -1 && what !== -1 && where < what, 'where you want alerts comes before which alerts');

    openPane(host, 'where');
    const scopeCtl = host.innerHTML.indexOf('data-pref="scope:');
    assert.ok(scopeCtl > host.innerHTML.indexOf('data-sec="where"') && scopeCtl < host.innerHTML.indexOf('data-sec="what"'),
      'the area control must live inside the Where pane');
    for (const scope of ['statewide', 'places']) {
      assert.match(host.innerHTML, new RegExp(`data-pref="scope:${scope}"[^>]*>push\\.scope\\.${scope}<`),
        `${scope} must stay an explicit, reachable choice`);
    }
    assert.ok(!host.innerHTML.includes('data-pref="ffe:'),
      'the Flash Flood Emergency switch belongs to the What pane, not this one');

    openPane(host, 'what');   // single-open accordion: opening What closes Where behind it
    const ffe = host.innerHTML.indexOf('data-pref="ffe:');
    assert.ok(ffe > host.innerHTML.indexOf('data-sec="what"'),
      'the Flash Flood Emergency switch must live inside the What pane');
    assert.ok(!host.innerHTML.includes('data-pref="scope:'), 'the Where pane must have closed behind it');
  });

  // an area that covers nothing says so where the choice is made, once per unreachable scope
  for (const [scope, places] of [['none', []], ['places', []]]) {
    renderSubscribed({ ffe: true, scope, places }, (host) => {
      openPane(host, 'where');
      assert.match(host.innerHTML, new RegExp(`<div class="push-fix">push\\.scope\\.${pushScopeState({ scope, places })}<`),
        `a ${scope} area that covers nothing must say so on the card`);
    });
  }
  renderSubscribed({ ffe: true, scope: 'statewide' }, (host) => {
    openPane(host, 'where');
    assert.ok(!/push\.scope\.(unset|empty)/.test(host.innerHTML),
      'a covering area must not be told it covers nothing');
  });
});

test('the places editor states what is stored, every time it renders', () => {
  const html = pushPlacesHtml({ scope: 'places', places: [{ lat: 29.76, lon: -95.37, km: 16 }] });
  assert.match(html, /push\.places\.store/, 'the storage sentence is not optional');
  assert.match(html, /29\.76, -95\.37/, 'the row shows exactly the pair that is stored');
  assert.match(html, /push-p-radius/);
  assert.match(html, /push-p-remove/, 'each point is removable on its own');
  const empty = pushPlacesHtml({ scope: 'places', places: [] });
  assert.match(empty, /push\.places\.none/);
  assert.match(empty, /push\.places\.store/);
  assert.match(empty, /id="push-place-geo"/, 'the opt-in location control');
  assert.equal(pushRadiusLabel(8).startsWith('5 '), true);
  assert.equal(pushRadiusLabel(40).startsWith('25 '), true);
});

test('a position for alerts is taken fresh, on a tap, and never borrowed from another feature', () => {
  const hits = [...BOARD.matchAll(/getCurrentPosition/g)];
  const fn = BOARD.match(/function pushAddMyLocation\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'pushAddMyLocation() not found');
  assert.match(fn[0], /maximumAge: 0/, 'a cached fix from Drive Mode or team sharing must not be reused here');
  assert.ok(hits.length >= 1);
  // the alerts path never reads a position another feature captured
  const adders = BOARD.match(/function pushAddPlace\([\s\S]*?\n\}/)[0];
  assert.ok(!/state\.(pos|position|lastPos|myPos)/.test(adders + fn[0]),
    'alert places must come from an explicit fix or an explicit saved-place copy');
  // and nothing on the boot path can add one
  const sync = BOARD.match(/async function pushBootSync\(\)[\s\S]*?\n\}/)[0];
  assert.ok(!/getCurrentPosition|pushAddPlace/.test(sync), 'boot must never capture a location');
});

test('leaving the places area drops the points it stored, on the card and in the registry', async () => {
  const tap = BOARD.match(/function pushOptTap\(group, val\)[\s\S]*?\n\}/)[0];
  assert.match(tap, /if \(p\.scope !== 'places'\) p\.places = \[\];/,
    'switching to statewide or off must not leave coordinates behind');
  const { reg } = newRegistry();
  const now = Date.now();
  mockNet({});
  await reg.doSubscribe(sub('drop', { scope: 'places', places: [place(HOUSTON)] }), '', now);
  const wide = await reg.doSubscribe(sub('drop', { scope: 'statewide', places: [] }), '', now + 1000);
  assert.equal(J(wide.prefs).places.length, 0);
  const peek = await reg.doPeek(now);
  assert.equal(peek.places, 0, 'nothing kept beyond the choice that needed it');
});

test('a device whose stored area differs from its local cache is repainted, not left claiming the old one', () => {
  const sync = BOARD.match(/async function pushBootSync\(\)[\s\S]*?\n\}/)[0];
  assert.match(sync, /pushLocalSet\(\{ on: true, prefs: pushNormalizePrefs\(d\.prefs\) \}\);\s*\n\s*pushRerender\(\);/,
    'the server prefs the renew brings back must reach the card');
  const rerender = BOARD.match(/function pushRerender\(\)[\s\S]*?\n\}/);
  assert.ok(rerender, 'pushRerender() not found');
  assert.match(rerender[0], /host && host\.firstChild/,
    'a background sync must not paint a card the backend check has not admitted');
});

test('i18n: the area choice and the places editor are complete in both languages and dash-free', () => {
  const keys = ['push.type.scope', 'push.scope.statewide', 'push.scope.places', 'push.scope.unset',
    'push.scope.empty', 'push.places.title', 'push.places.none', 'push.places.add', 'push.places.saved',
    'push.places.store', 'push.places.limit', 'push.places.removearia', 'push.places.geoerr'];
  for (const k of keys) {
    for (const lang of ['en', 'es']) {
      assert.ok(typeof I18N[lang][k] === 'string' && I18N[lang][k].length, `${lang} missing ${k}`);
      assert.ok(!I18N[lang][k].includes('—'), `em-dash in ${lang} ${k}`);
    }
    assert.notEqual(I18N.en[k], I18N.es[k], `${k} was never actually translated`);
  }
  for (const lang of ['en', 'es']) {
    assert.match(I18N[lang]['push.places.store'], lang === 'en' ? /rounded/ : /redondead/,
      `${lang} must say the coordinates are rounded`);
  }
});

test('the worker string table keeps en/es parity on the new-subscriber confirmation', () => {
  assert.deepEqual(Object.keys(PUSH_STRINGS.en).sort(), Object.keys(PUSH_STRINGS.es).sort());
  for (const lang of ['en', 'es']) {
    const s = PUSH_STRINGS[lang]['confirm.body.noarea'];
    assert.ok(s && !s.includes('—'), `${lang} confirm.body.noarea missing or dashed`);
    assert.match(s, /911/, `${lang} confirm.body.noarea dropped the 911 carve-out`);
  }
});

test('ffeReachesSub is the whole area rule, in one place', () => {
  const geo = { rings: ffeAt('x', HOUSTON).geometry.coordinates, bboxes: [], resolved: true };
  assert.equal(ffeReachesSub({ scope: 'statewide' }, geo), true);
  assert.equal(ffeReachesSub({ scope: 'none' }, geo), false);
  assert.equal(ffeReachesSub({ scope: 'places', places: [] }, geo), false, 'places with no points reaches nobody');
  assert.equal(ffeReachesSub({ scope: 'places', places: [place(HOUSTON)] }, geo), true);
  assert.equal(ffeReachesSub({ scope: 'places', places: [place(EL_PASO)] }, geo), false);
  assert.equal(ffeReachesSub({}, geo), true, 'a pre-existing row keeps statewide');
});
