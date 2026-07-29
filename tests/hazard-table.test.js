'use strict';

/*
 * The hazard allowlist exists twice: js/sources.js HAZARD_EVENTS, which decides what the board
 * fetches and how it ranks it, and the scripts/gen-caltopo.py mirror, which decides what reaches
 * the KML/GeoRSS export. Same for the LSR type filter across js/core.js and the same generator.
 *
 * Two independent failures are guarded here, and both are silent by construction:
 *
 *   1. The two copies drift. Nothing at runtime compares them, so the board and its export would
 *      simply describe different hazard sets and each would look correct on its own.
 *   2. A string stops being real upstream. An unknown event= value returns HTTP 200 with zero
 *      features rather than an error, so a typo or a retired product name (NWS retired
 *      "Excessive Heat Warning" and "Wind Chill Warning" this way) publishes "no tornado warnings"
 *      instead of failing. That is the edict E1 shape: a failed match becoming a published zero.
 *
 * The catalogue half reads hazard-mirror.js PINNED_TYPES, not api.weather.gov: this suite is the
 * publish gate, and a flood publish may neither wait on an upstream nor lose the check to an
 * outage. `node tests/hazard-mirror.js --upstream` re-judges against the live catalogue and is how
 * PINNED_TYPES is refreshed. Every assertion below is preceded by a non-vacuity check, so an empty
 * table or an empty catalogue cannot satisfy a loop that never runs.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./harness.js');
const mirror = require('./hazard-mirror.js');

const ROOT = path.join(__dirname, '..');
const { HAZARD_EVENTS, HAZARD_EVENT_LIST, LSR_HAZARD_RE, hazardAdmits } = loadApp();

// the same implementation scripts/cycle-check.sh gates the release on, so a green suite and a green
// cycle-check cannot disagree about what was checked
const pythonMirror = () => mirror.pySide();

test('hazard table: the JS table and the gen-caltopo.py mirror are the same set, class and rank', () => {
  const js = mirror.jsSide();
  const py = pythonMirror();
  assert.ok(js.list.length >= mirror.MIN_TABLE,
    `non-vacuity: the JS hazard table is ${js.list.length} entries, so this comparison would prove nothing`);
  assert.ok(Object.keys(py.events).length >= mirror.MIN_TABLE,
    'non-vacuity: the Python mirror came back near-empty, so the comparison would prove nothing');

  assert.deepEqual(mirror.mirrorProblems(js, py), [],
    'js/sources.js and scripts/gen-caltopo.py describe different hazard sets');
  // and prove the comparison can see a difference at all
  const bent = { events: Object.assign({}, py.events, { 'Tornado Warning': ['standing', 18] }), lsr: py.lsr };
  assert.ok(mirror.mirrorProblems(js, bent).length > 0, 'the mirror comparison must fail on a real divergence');
});

test('hazard table: the local storm report filter is the same pattern on both sides', () => {
  const py = pythonMirror();
  assert.ok(LSR_HAZARD_RE.source.length > 40, 'non-vacuity: the JS LSR pattern is too short to be the real one');
  assert.equal(LSR_HAZARD_RE.source, py.lsr,
    'js/core.js LSR_HAZARD_RE and scripts/gen-caltopo.py LSR_HAZARD_RE are different patterns');
  // the ground truth this release exists to stop dropping
  for (const kept of ['TORNADO', 'FUNNEL CLOUD', 'HAIL', 'DUST STORM', 'SNOW SQUALL', 'FLASH FLOOD']) {
    assert.ok(LSR_HAZARD_RE.test(kept), `${kept} reports must reach the board`);
  }
  assert.ok(!LSR_HAZARD_RE.test('EXTREME HEAT'), 'the filter must still be a filter, not a passthrough');
});

/* The storm-based products this release adds, named individually rather than derived from the
   table, so a table that lost one of them fails here instead of quietly agreeing with itself. */
test('hazard table: the storm-based tier is admitted and the zone-product lookalikes are not', () => {
  for (const ev of ['Tornado Warning', 'Severe Thunderstorm Warning', 'Dust Storm Warning',
    'Snow Squall Warning', 'Extreme Wind Warning']) {
    assert.ok(hazardAdmits(ev), `${ev} is the point of this release and is not in the table`);
    assert.equal(HAZARD_EVENTS[ev].cls, 'acute', `${ev} must be acute to reach the glance surfaces`);
  }
  /* "Dust Storm Warning" is a WarnGen polygon product and "Blowing Dust Warning" is an NPW zone
     product; a /dust/i pattern cannot tell them apart, which is why the allowlist is exact strings. */
  for (const ev of ['Blowing Dust Warning', 'Blowing Dust Advisory', 'Dust Advisory', 'Tornado Watch',
    'Severe Thunderstorm Watch', 'Heat Advisory', 'Small Craft Advisory', 'Special Weather Statement']) {
    assert.ok(!hazardAdmits(ev), `${ev} is not in this release's scope and must not be admitted`);
  }
});

/* The fire family, named individually. "Fire Warning" is the load-bearing one: it is a CIV code
   under 47 CFR 11.31 like the other orders, written by a county and relayed down the NWS path the
   board already fetches, so its class is a claim about attribution and about never folding into a
   meteorological rank, not just about membership. The other three are conditions rather than
   directives and must stay off the glance surfaces. */
test('hazard table: the fire family is admitted, and only the county directive is an order', () => {
  assert.equal(HAZARD_EVENTS['Fire Warning'].cls, 'order',
    'Fire Warning is a county-authored directive; any other class drops its author and its rank');
  assert.equal(HAZARD_EVENTS['Fire Warning'].rank, 4, 'an order ranks with the other orders');
  for (const [ev, cls, rank] of [['Red Flag Warning', 'standing', 17],
    ['Fire Weather Watch', 'watch', 14], ['Dense Smoke Advisory', 'standing', 18]]) {
    assert.ok(hazardAdmits(ev), `${ev} is fetched today and discarded; it belongs in the table`);
    assert.equal(HAZARD_EVENTS[ev].cls, cls, `${ev} is a condition, not an order`);
    assert.equal(HAZARD_EVENTS[ev].rank, rank);
    assert.ok(HAZARD_EVENTS[ev].rank > HAZARD_EVENTS['Evacuation Immediate'].rank,
      `${ev} must never outrank an evacuation order`);
  }
  // fire danger is a real catalogue string the board deliberately does not carry, so the four above
  // are a choice rather than everything the fire family offers
  assert.ok(!hazardAdmits('Extreme Fire Danger'), 'Extreme Fire Danger is out of scope by decision');
});

/* Heat stays out, by decision rather than by omission. Owner call (2026-07-27): heat is not the
   awareness this board is built for. The allowlist grows every time the board goes wider, and heat
   would arrive as an unremarkable member of a standing tier rather than as a choice someone made,
   so the rule is gated in cycle-check instead of written down somewhere that goes stale. */
test('hazard table: no heat product is admitted', () => {
  const heat = ['Heat Advisory', 'Extreme Heat Warning', 'Extreme Heat Watch', 'Excessive Heat Warning'];
  for (const ev of heat) assert.ok(!hazardAdmits(ev), `${ev} must not be admitted`);
  // non-vacuity, both directions: the pattern the release gate runs has to match every heat product
  // and none of the hazards the board carries, or a clean run proves nothing
  assert.ok(heat.every((ev) => mirror.HEAT_RE.test(ev)), 'the heat pattern must match a real heat product');
  assert.ok(HAZARD_EVENT_LIST.length >= mirror.MIN_TABLE, 'non-vacuity: the table read is not a truncated one');
  assert.deepEqual(HAZARD_EVENT_LIST.filter((ev) => mirror.HEAT_RE.test(ev)), [],
    'no product the board carries may be a heat product');
});

test('hazard table: the release gate fails when heat is added to either half of the mirror', () => {
  const js = mirror.jsSide();
  const py = pythonMirror();
  assert.deepEqual(mirror.mirrorProblems(js, py), [],
    'the live tables must be clean, or the mutation below proves nothing');
  const jsHeat = {
    ...js,
    list: [...js.list, 'Heat Advisory'],
    events: { ...js.events, 'Heat Advisory': { cls: 'standing', rank: 18 } },
  };
  const pyHeat = { ...py, events: { ...py.events, 'Heat Advisory': ['standing', 18] } };
  // the second case is heat reaching only the export, where the drift rule would also fire; matching
  // on the decision wording keeps this a test of the heat rule rather than of the drift rule
  for (const [label, a, b] of [['both halves', jsHeat, pyHeat], ['the export alone', js, pyHeat]]) {
    const problems = mirror.mirrorProblems(a, b);
    assert.ok(problems.some((p) => p.includes('excluded from this board by decision')),
      `heat added to ${label} must fail the gate, got ${JSON.stringify(problems)}`);
  }
});

/* Catalogue reality check, against hazard-mirror.js PINNED_TYPES. The publish gate runs this
   suite, so it reads the pinned copy rather than api.weather.gov: an outage there may not stop a
   flood publish, and skipping on outage was coverage that vanished exactly when upstream was
   flaky. `node tests/hazard-mirror.js --upstream` re-judges against the live catalogue. */
test('hazard table: every event string still exists in the NWS catalogue', async () => {
  const up = await mirror.fetchTypes();
  assert.ok(!up.bad, `the pinned catalogue read is not usable: ${up.bad}`);
  assert.ok(!up.skipped, `the pinned catalogue is always readable: ${up.skipped}`);
  assert.ok(up.types.length >= mirror.MIN_TYPES,
    `non-vacuity: the catalogue holds ${up.types.length} entries, which cannot be the real one`);
  assert.ok(up.types.includes('Tornado Warning'),
    'non-vacuity: the catalogue is missing a product that certainly exists');

  const missing = HAZARD_EVENT_LIST.filter((ev) => !up.types.includes(ev));
  assert.deepEqual(missing, [],
    'these event strings are not in the NWS catalogue; the board would silently publish zero of them');
  // a string that was never real must be seen as missing, or the check above proves nothing
  assert.ok(!up.types.includes('Tornado Warnign'), 'non-vacuity: a typo must not read as a real product');
});

test('hazard table: the gated catalogue read reaches no upstream', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('the publish gate must not reach api.weather.gov'); };
  try {
    const up = await mirror.fetchTypes();
    assert.ok(Array.isArray(up.types) && up.types.length >= mirror.MIN_TYPES,
      'the default read must answer from the fixture, with no transport involved');
    assert.equal(up.captured, mirror.PINNED_CAPTURED, 'the read must be the pinned catalogue, dated');
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* The generator has to agree with itself too: the exporter filters on the same table, so a product
   in the table that the exporter cannot name is an export that quietly omits a hazard class. */
test('hazard table: gen-caltopo.py filters alerts through the shared table, not a private pattern', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'gen-caltopo.py'), 'utf8');
  assert.match(src, /not in HAZARD_EVENTS/, 'the exporter must gate on the shared table');
  assert.doesNotMatch(src, /HAZARD_ALERT_RE/, 'the retired regex allowlist is still referenced');
  assert.doesNotMatch(src, /LSR_FLOOD_RE/, 'the retired flood-shaped LSR name is still referenced');
});
