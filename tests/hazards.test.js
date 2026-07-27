'use strict';

/*
 * Storm-based tier behaviour. Every fixture in here is a real archived NWS product pulled from
 * api.weather.gov, not an invented shape: the tag formats ("Up to .75", "80 MPH"), the VTEC
 * lifecycle and the 16-minute declared lifetime are all things the feed actually does, and an
 * invented fixture would have agreed with whatever the code happened to do.
 *
 * The organising fact these tests defend: a tornado warning is not a flood warning in a different
 * colour. It lives about 23 minutes against a flood warning's hours or days, it moves, and the
 * correct response is to shelter rather than to avoid a route.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./harness.js');

const {
  alertTags, alertMotion, alertMotionText, alertVtecKey, alertDedupe, alertLifetimeMs, alertStaleAfterMs, alertFreshClass,
  hazardClass, hazardRank, hazardStyleKey, hazardPolyStyle, alertActionKey, alertHazCmp, alertMoves,
  ALERT_STALE_FLOOR_MS, alertNearMi, ALERT_NEAR_MI_ACUTE, tickerCap, TICKER_ACUTE_MAX,
  tickerAlertItems, driveItems, alertSeverity, state,
} = loadApp();

const fixture = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

// KLMK.TO.W.0045: one tornado warning, eight archived messages, eight distinct ids, seven areaDescs
const LIFECYCLE = fixture('alerts-tornado-lifecycle.json').features;
const TORNADO_PDS = fixture('alert-tornado-pds.json');
const SEVERE_DESTRUCTIVE = fixture('alert-severe-destructive.json');

const withSev = (f) => Object.assign({}, f, { _sev: alertSeverity(f.properties) });

/* ---------- impact-based warning tags, in the formats the feed really uses ---------- */

test('alertTags — reads the damage threat, detection, hail and gust off a real archived product', () => {
  const tags = alertTags(TORNADO_PDS);
  assert.equal(tags.damageThreat, 'CONSIDERABLE');
  assert.equal(tags.detection, 'OBSERVED');
  assert.equal(tags.maxHailIn, 0.75, '"Up to .75" must parse as 0.75, prefix and leading-dot decimal included');
  assert.equal(tags.pds, true, 'a CONSIDERABLE tornado warning is a particularly dangerous situation');

  const svr = alertTags(SEVERE_DESTRUCTIVE);
  assert.equal(svr.damageThreat, 'DESTRUCTIVE');
  assert.equal(svr.maxWindGustMph, 80, '"80 MPH" carries its unit and must not parse as NaN');
  assert.equal(svr.pds, false, 'PDS is a tornado concept; a destructive severe warning is not one');
});

test('alertTags — 0.00 hail is a measured absence, not a missing reading', () => {
  const none = alertTags({ properties: { event: 'Tornado Warning', parameters: { maxHailSize: ['0.00'] } } });
  assert.equal(none.maxHailIn, 0, 'the office measured no hail and the card must be able to say so');
  const absent = alertTags({ properties: { event: 'Tornado Warning', parameters: {} } });
  assert.equal(absent.maxHailIn, null, 'no tag at all is a different fact from a zero');
});

test('alertTags — the PDS sentence in the description is authority even with no damage tag', () => {
  const f = { properties: { event: 'Tornado Warning', description: 'THIS IS A PARTICULARLY DANGEROUS SITUATION.', parameters: {} } };
  assert.equal(alertTags(f).pds, true);
});

/* ---------- storm motion: the bearing that would have sent a driver the wrong way ---------- */

test('alertMotion — DEG is the direction the storm comes FROM, so the reported heading is deg+180', () => {
  const m = alertMotion(TORNADO_PDS);
  assert.ok(m, 'a storm-based warning carries eventMotionDescription on every sample measured');
  // fixture reads ...291DEG...18KT..., and the product's own prose says moving east
  assert.equal(m.dir, 'E', 'rendering the raw bearing would point a driver back into the storm');
  assert.equal(m.mph, 21, '18 KT is 21 mph');
});

test('alertMotion — a product with no motion tag reports none rather than a default heading', () => {
  assert.equal(alertMotion({ properties: { parameters: {} } }), null);
  assert.equal(alertMotion({ properties: { parameters: { eventMotionDescription: ['garbage'] } } }), null);
});

/* ---------- VTEC identity: one warning, eight messages ---------- */

test('alertVtecKey — the lifecycle of one warning collapses to one row', () => {
  assert.equal(LIFECYCLE.length, 8, 'non-vacuity: the fixture must carry a real multi-message lifecycle');
  assert.equal(new Set(LIFECYCLE.map((f) => f.id)).size, 8,
    'non-vacuity: every message has its own id, which is why f.id is the wrong key');
  assert.ok(new Set(LIFECYCLE.map((f) => f.properties.areaDesc)).size > 1,
    'non-vacuity: the county list changes between messages, which is why (event, areaDesc) is the wrong key');

  assert.equal(new Set(LIFECYCLE.map(alertVtecKey)).size, 1, 'all eight messages are one warning');
  assert.equal(alertVtecKey(LIFECYCLE[0]), 'KLMK.TO.W.0045');

  const deduped = alertDedupe(LIFECYCLE);
  assert.equal(deduped.length, 1, 'the ticker, the glance rows and history must count warnings, not messages');
});

test('alertDedupe — keeps the message that runs latest, and an undated end outlives a dated one', () => {
  const mk = (etn, ends) => ({ id: `x${etn}${ends}`, properties: { event: 'Tornado Warning', ends, parameters: { VTEC: [`/O.CON.KFWD.TO.W.${etn}.000000T0000Z-260101T0100Z/`] } } });
  const early = mk('0001', '2026-01-01T00:30:00Z');
  const late = mk('0001', '2026-01-01T01:00:00Z');
  assert.equal(alertDedupe([early, late])[0], late);
  assert.equal(alertDedupe([late, early])[0], late, 'input order must not decide which message survives');

  const openEnded = { id: 'ue', properties: { event: 'Flood Warning', ends: null, parameters: { VTEC: ['/O.CON.KCRP.FL.W.0025.000000T0000Z-000000T0000Z/'] } } };
  const dated = { id: 'd', properties: { event: 'Flood Warning', ends: '2026-01-01T01:00:00Z', parameters: { VTEC: ['/O.CON.KCRP.FL.W.0025.000000T0000Z-260101T0100Z/'] } } };
  assert.equal(alertDedupe([openEnded, dated])[0], openEnded, 'until further notice outlives any dated end');
  assert.equal(alertDedupe([dated, openEnded])[0], openEnded);
});

test('alertVtecKey — two different warnings in the same county stay two rows', () => {
  const a = { id: 'a', properties: { event: 'Tornado Warning', areaDesc: 'Bexar, TX', parameters: { VTEC: ['/O.NEW.KEWX.TO.W.0011.000000T0000Z-260101T0100Z/'] } } };
  const b = { id: 'b', properties: { event: 'Tornado Warning', areaDesc: 'Bexar, TX', parameters: { VTEC: ['/O.NEW.KEWX.TO.W.0012.000000T0000Z-260101T0100Z/'] } } };
  assert.equal(alertDedupe([a, b]).length, 2, 'the ETN distinguishes two warnings a name-based key would merge');
});

test('alertVtecKey — a product with no VTEC falls back to its id rather than colliding on empty', () => {
  const a = { id: 'urn:a', properties: { event: 'Civil Emergency Message', parameters: {} } };
  const b = { id: 'urn:b', properties: { event: 'Civil Emergency Message', parameters: {} } };
  assert.equal(alertDedupe([a, b]).length, 2, 'two non-NWS products must not collapse into one');
});

/* ---------- aging on the product's own declared lifetime ---------- */

test('alertLifetimeMs — a tornado warning ages on its own life, not on a flood-shaped constant', () => {
  // the archived product declares onset 18:29 and ends 18:45: a 16-minute life
  const life = alertLifetimeMs(TORNADO_PDS);
  assert.equal(life, 16 * 60000, 'non-vacuity: the fixture must declare the short life this test is about');

  const flood = {
    properties: { event: 'Flood Warning', onset: '2026-07-27T00:00:00Z', ends: '2026-07-30T00:00:00Z', sent: '2026-07-27T00:00:00Z', parameters: {} },
  };
  assert.equal(alertLifetimeMs(flood), 3 * 24 * 3600000);

  assert.ok(alertStaleAfterMs(flood) > alertStaleAfterMs(TORNADO_PDS),
    'a three-day flood warning must tolerate far more silence than a sixteen-minute tornado warning');
  assert.equal(alertStaleAfterMs(flood), 0.25 * 3 * 24 * 3600000, 'a quarter of the declared lifetime');
  assert.equal(alertStaleAfterMs(TORNADO_PDS), ALERT_STALE_FLOOR_MS,
    'a quarter of sixteen minutes is under the floor, and the floor is the conservative direction');
});

test('alertFreshClass — the same silence reads fresh on a flood warning and stale on a tornado warning', () => {
  const sent = '2026-07-27T00:00:00Z';
  const at = '2026-07-27T00:20:00Z'; // twenty minutes later
  const tornado = { properties: { event: 'Tornado Warning', sent, onset: sent, ends: '2026-07-27T00:23:00Z', parameters: {} } };
  const flood = { properties: { event: 'Flood Warning', sent, onset: sent, ends: '2026-07-30T00:00:00Z', parameters: {} } };
  assert.equal(alertFreshClass(tornado, at), 'stale', 'twenty minutes is most of a tornado warning');
  assert.equal(alertFreshClass(flood, at), 'fresh', 'twenty minutes is nothing on a three-day product');
});

test('alertStaleAfterMs — a product with no computable lifetime falls back to the floor', () => {
  assert.equal(alertStaleAfterMs({ properties: { parameters: {} } }), ALERT_STALE_FLOOR_MS);
  // an end before its onset is unreadable, not a negative lifetime
  const backwards = { properties: { onset: '2026-07-27T01:00:00Z', ends: '2026-07-27T00:00:00Z', parameters: {} } };
  assert.equal(alertStaleAfterMs(backwards), ALERT_STALE_FLOOR_MS);
});

/* ---------- class, rank and the ordering claims the design makes ---------- */

test('hazardRank — a tornado warning outranks a flash flood warning, and a tornado emergency outranks a flash flood emergency', () => {
  const tor = withSev({ properties: { event: 'Tornado Warning', parameters: {} } });
  const torEmerg = withSev({ properties: { event: 'Tornado Warning', parameters: { tornadoDamageThreat: ['CATASTROPHIC'] } } });
  const ffw = withSev({ properties: { event: 'Flash Flood Warning', parameters: {} } });
  const ffe = withSev({ properties: { event: 'Flash Flood Warning', description: 'THIS IS A FLASH FLOOD EMERGENCY', parameters: {} } });
  assert.equal(ffe._sev, 'emergency', 'non-vacuity: the flash flood emergency fixture must classify as one');

  assert.ok(hazardRank(tor) < hazardRank(ffw), 'the driver can decline to enter water; he cannot outdrive a tornado');
  assert.ok(hazardRank(ffe) < hazardRank(tor), 'observed catastrophic flooding outranks a radar-indicated tornado');
  assert.ok(hazardRank(torEmerg) < hazardRank(ffe), 'a tornado emergency is the worst thing the catalogue carries');
  assert.equal(hazardRank(torEmerg), 0);
});

test('hazardRank — impact tags promote within a product, and PDS sits above a plain tornado warning', () => {
  const plain = withSev({ properties: { event: 'Tornado Warning', parameters: {} } });
  assert.ok(hazardRank(withSev(TORNADO_PDS)) < hazardRank(plain));
  const svrPlain = withSev({ properties: { event: 'Severe Thunderstorm Warning', parameters: {} } });
  assert.ok(hazardRank(withSev(SEVERE_DESTRUCTIVE)) < hazardRank(svrPlain),
    'a destructive severe warning carries tornado-strength wind and must not sort with routine ones');
});

test('hazardRank — an unrecognised product sorts last instead of ahead of everything', () => {
  const unknown = { properties: { event: 'Space Weather Nonsense', parameters: {} } };
  const worst = withSev({ properties: { event: 'Tornado Warning', parameters: { tornadoDamageThreat: ['CATASTROPHIC'] } } });
  assert.ok(hazardRank(unknown) > hazardRank(withSev({ properties: { event: 'Flood Advisory', parameters: {} } })),
    'an unknown severity once sorted above emergency; that must not come back through the hazard axis');
  assert.ok(alertHazCmp(worst, unknown) < 0);
  assert.equal(hazardClass(unknown), 'acute', 'unknown still shows: hiding a hazard the board cannot name is the worse error');
});

test('hazardClass — the storm tier is acute and the standing tier is not, so glance surfaces stay actionable', () => {
  for (const ev of ['Tornado Warning', 'Severe Thunderstorm Warning', 'Dust Storm Warning', 'Extreme Wind Warning']) {
    assert.equal(hazardClass({ properties: { event: ev, parameters: {} } }), 'acute', ev);
  }
  assert.equal(hazardClass({ properties: { event: 'Flood Advisory', parameters: {} } }), 'standing');
  assert.equal(hazardClass({ properties: { event: 'Flood Watch', parameters: {} } }), 'watch');
  assert.equal(hazardClass(withSev({ properties: { event: 'Flash Flood Statement', description: 'FLASH FLOOD EMERGENCY here', parameters: {} } })), 'acute',
    'an emergency is acute whichever product carried it');
});

test('alertNearMi — near is per class: an hour of storm travel for acute, containment for the rest', () => {
  assert.equal(alertNearMi('acute'), ALERT_NEAR_MI_ACUTE);
  assert.equal(alertNearMi('watch'), 0, 'a 20,000 sq mi watch box has no meaningful edge distance');
  assert.equal(alertNearMi('standing'), 0, 'a heat advisory 50 miles away is identical to one overhead');
});

/* ---------- per-hazard styling ---------- */

test('hazardPolyStyle — a storm-based warning draws as a dashed swath, a flood polygon as an area', () => {
  const tor = hazardPolyStyle(withSev({ properties: { event: 'Tornado Warning', parameters: {} } }));
  assert.match(tor.className, /haz-tornado/);
  assert.ok(tor.dashArray, 'the edge of a swath is the information');
  assert.equal(tor.fillOpacity, 0.06, 'a filled tornado polygon buries the gauge and road layers under it');

  const ffe = hazardPolyStyle(withSev({ properties: { event: 'Flash Flood Warning', description: 'FLASH FLOOD EMERGENCY', parameters: {} } }));
  assert.equal(ffe.dashArray, null);
  assert.equal(ffe.fillOpacity, 0.22);
  assert.equal(hazardStyleKey({ properties: { event: 'Tornado Warning' } }), 'tornado');
  assert.notEqual(hazardStyleKey({ properties: { event: 'Tornado Warning' } }), hazardStyleKey({ properties: { event: 'Flood Warning' } }),
    'if tornado and flood share a colour the exercise is pointless');
});

/* ---------- Drive Mode: the verb, not the noun ---------- */

test('alertActionKey — each hazard maps to the action a driver should take, and they differ', () => {
  const key = (ev, extra) => alertActionKey(withSev({ properties: Object.assign({ event: ev, parameters: {} }, extra || {}) }));
  assert.equal(key('Tornado Warning'), 'drive.act.shelter');
  assert.equal(key('Extreme Wind Warning'), 'drive.act.shelter');
  assert.equal(key('Dust Storm Warning'), 'drive.act.pulloff');
  assert.equal(key('Snow Squall Warning'), 'drive.act.notravel');
  assert.equal(key('Flash Flood Warning'), 'drive.act.nocross');
  assert.equal(key('Storm Surge Warning'), 'drive.act.highground');
  assert.equal(key('Flash Flood Warning', { description: 'FLASH FLOOD EMERGENCY' }), 'drive.act.highground',
    'an emergency escalates the verb past "do not cross"');

  assert.equal(alertActionKey(withSev(SEVERE_DESTRUCTIVE)), 'drive.act.shelter');
  assert.equal(key('Severe Thunderstorm Warning'), 'drive.act.inside',
    'reserving TAKE SHELTER for tornado and destructive severe is what keeps it meaning something');

  assert.notEqual(key('Tornado Warning'), key('Flash Flood Warning'),
    'the whole point: a tornado is answered by shelter and a flood by not driving into it');
  assert.equal(key('Heat Advisory'), null, 'a product with no ten-second driving action gets no row');
  assert.equal(key('Flood Watch'), null);
});

test('driveItems — a tornado warning over the truck is the first row, with a verb and above every crossing', () => {
  const poly = { type: 'Polygon', coordinates: [[[-98.6, 29.3], [-98.3, 29.3], [-98.3, 29.6], [-98.6, 29.6], [-98.6, 29.3]]] };
  const tornado = withSev({
    id: 'tor1',
    geometry: poly,
    properties: {
      event: 'Tornado Warning', areaDesc: 'Bexar, TX', sent: new Date().toISOString(),
      ends: new Date(Date.now() + 900000).toISOString(),
      geocode: { UGC: ['TXC029'] },
      parameters: { VTEC: ['/O.NEW.KEWX.TO.W.0011.000000T0000Z-260101T0100Z/'], eventMotionDescription: ['2026-07-27T00:46:00-00:00...storm...291DEG...18KT...29.4,-98.5'] },
    },
  });

  const saved = { alerts: state.alerts, crossings: state.crossings, gauges: state.gauges, myPos: state.myPos, cameras: state.cameras };
  try {
    state.alerts = [tornado];
    state.crossings = [{ name: 'Somewhere Crossing', status: 'closed', lat: 29.45, lon: -98.45 }];
    state.gauges = [];
    state.cameras = null;
    state.myPos = { lat: 29.45, lng: -98.45 }; // inside the polygon

    const items = driveItems();
    assert.ok(items.length >= 2, 'non-vacuity: both the alert row and the crossing must be in the list');
    const row = items[0];
    assert.equal(row.name, 'drive.act.shelter',
      'the surface built for the person in the truck must lead with the action, not the hazard name');
    assert.equal(row.glyph, '🌪');
    assert.equal(row.pin, true, 'a polygon you are standing inside is not a place you might drive to');
    assert.match(row.sub, /Tornado Warning/, 'the hazard name still rides along, under the verb');
    // the harness echoes i18n keys, so the rendered wording is asserted through the motion read itself
    assert.equal(alertMotion(tornado).dir, 'E', 'a driver needs to know which way it is coming');
    assert.equal(alertMotion(tornado).mph, 21);
    assert.ok(row.sub.includes(alertMotionText(tornado)), 'and the row has to carry that motion line');
    assert.ok(items.slice(1).some((i) => i.name === 'Somewhere Crossing'),
      'the closed crossing is still there, just no longer above the tornado');
  } finally { Object.assign(state, saved); }
});

test('driveItems — watches and standing conditions never reach Drive Mode', () => {
  const mk = (ev) => withSev({ id: ev, geometry: { type: 'Point', coordinates: [-98.4, 29.4] }, properties: { event: ev, areaDesc: 'Bexar, TX', sent: new Date().toISOString(), ends: new Date(Date.now() + 3600000).toISOString(), parameters: {} } });
  const saved = { alerts: state.alerts, crossings: state.crossings, gauges: state.gauges, myPos: state.myPos, cameras: state.cameras };
  try {
    state.alerts = [mk('Flood Watch'), mk('Flood Advisory'), mk('Wind Advisory')];
    state.crossings = []; state.gauges = []; state.cameras = null; state.myPos = null;
    assert.equal(state.alerts.length, 3, 'non-vacuity: three non-acute products go in');
    assert.equal(driveItems().length, 0, 'a heat-advisory-shaped row in a driving list is pure dilution');
  } finally { Object.assign(state, saved); }
});

/* ---------- ticker: admission and the cap ---------- */

test('tickerAlertItems — acute products enter, watches and standing conditions do not', () => {
  const mk = (ev, id) => withSev({ id, geometry: { type: 'Point', coordinates: [-98.4, 29.4] }, properties: { event: ev, areaDesc: 'Bexar, TX', ends: new Date(Date.now() + 900000).toISOString(), parameters: { VTEC: [`/O.NEW.KEWX.XX.W.00${id}.000000T0000Z-260101T0100Z/`] } } });
  const saved = state.alerts;
  try {
    state.alerts = [mk('Tornado Warning', '11'), mk('Flood Watch', '12'), mk('Flood Advisory', '13'), mk('Severe Thunderstorm Warning', '14')];
    const items = tickerAlertItems();
    assert.equal(items.length, 2, 'admit the standing tier and a summer afternoon is thirteen heat advisories and nothing actionable');
    assert.match(items[0].text, /Tornado Warning/, 'the worst hazard opens the line');
    assert.match(items[1].text, /Severe Thunderstorm Warning/);
  } finally { state.alerts = saved; }
});

test('tickerAlertItems — one warning that reissued eight times is one item', () => {
  const saved = state.alerts;
  try {
    // hold the archived lifecycle open so admission is about dedupe rather than expiry
    state.alerts = LIFECYCLE.map((f) => withSev({
      id: f.id,
      geometry: f.geometry,
      properties: Object.assign({}, f.properties, { ends: new Date(Date.now() + 900000).toISOString() }),
    }));
    assert.equal(state.alerts.length, 8, 'non-vacuity: eight messages go in');
    assert.equal(tickerAlertItems().length, 1, 'an outbreak must not become a reel of near-identical strings');
  } finally { state.alerts = saved; }
});

test('tickerCap — a full pass stays inside a glance when many acute alerts are open at once', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ text: `item ${i}` }));
  assert.ok(many.length > TICKER_ACUTE_MAX, 'non-vacuity: the input must actually exceed the cap');

  const capped = tickerCap(many, true);
  assert.equal(capped.length, TICKER_ACUTE_MAX, 'twenty items is a hundred-second loop and the driver gets about ten');
  assert.equal(capped[capped.length - 1].text, 'ticker.more', 'the overflow collapses into one item rather than vanishing');
  assert.equal(typeof capped[capped.length - 1].act, 'function', 'and that item has to open the full list');
  for (let i = 0; i < TICKER_ACUTE_MAX - 1; i++) {
    assert.equal(capped[i], many[i], 'the worst items keep their slots, in order');
  }

  assert.equal(tickerCap(many, false).length, 20, 'with no acute product open the line is not capped');
  const few = many.slice(0, 3);
  assert.equal(tickerCap(few, true), few, 'a short line is returned untouched');
});

/* ---------- the fast-poll gate ---------- */

test('alertMoves — the fast poll follows storm motion, so a standing flood warning never triggers it', () => {
  const now = new Date(Date.now() + 900000).toISOString();
  const tornado = withSev({ properties: { event: 'Tornado Warning', ends: now, parameters: { eventMotionDescription: ['2026-07-27T00:46:00-00:00...storm...291DEG...18KT...29.4,-98.5'] } } });
  const flood = withSev({ properties: { event: 'Flood Warning', ends: now, parameters: {} } });
  const watch = withSev({ properties: { event: 'Flood Watch', ends: now, parameters: { eventMotionDescription: ['2026-07-27T00:46:00-00:00...storm...291DEG...18KT...29.4,-98.5'] } } });
  assert.equal(alertMoves(tornado), true, 'measured live: motion is present on 100% of tornado and severe warnings');
  assert.equal(alertMoves(flood), false, 'and on 0% of flood warnings, which is what keeps a Texas summer off the fast path');
  assert.equal(alertMoves(watch), false, 'a watch is not acute whatever it carries');
  /* Currency is deliberately NOT folded into alertMoves: the call site composes alertOpen with it,
     so the structural guard in alert-lifetime.test.js can see that an ended warning cannot hold the
     board on a 60-second poll. This asserts the composition the call site actually uses. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'sources.js'), 'utf8');
  assert.match(src, /some\(\(f\) => alertOpen\(f\) && alertMoves\(f\) && alertNear\(f, scope\)\)/,
    'the fast-poll gate must route currency through the one predicate');
});
