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
 * The upstream half needs a skip path, because an api.weather.gov outage must not fail an
 * unrelated commit. It skips only on a transport failure; a reachable endpoint that disagrees with
 * the table is a hard failure. Every assertion below is preceded by a non-vacuity check, so an
 * empty table or an empty upstream list cannot satisfy a loop that never runs.
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

/* Upstream reality check. Skips on a transport failure so an api.weather.gov outage cannot fail an
   unrelated commit; a reachable endpoint that does not list one of our strings is a hard failure. */
test('hazard table: every event string still exists upstream in /alerts/types', async (t) => {
  const up = await mirror.fetchTypes(15000);
  assert.ok(!up.bad, `the upstream catalogue read is not usable: ${up.bad}`);
  if (up.skipped) {
    t.skip(`api.weather.gov unreachable (${up.skipped}); upstream agreement not checked this run`);
    return;
  }
  assert.ok(up.types.length >= mirror.MIN_TYPES,
    `non-vacuity: /alerts/types returned ${up.types.length} entries, which cannot be the real catalogue`);
  assert.ok(up.types.includes('Tornado Warning'),
    'non-vacuity: the upstream list is missing a product that certainly exists');

  const missing = HAZARD_EVENT_LIST.filter((ev) => !up.types.includes(ev));
  assert.deepEqual(missing, [],
    'these event strings are not in the live NWS catalogue; the board would silently publish zero of them');
  // a string that was never real must be seen as missing, or the check above proves nothing
  assert.ok(!up.types.includes('Tornado Warnign'), 'non-vacuity: a typo must not read as a real product');
});

/* The generator has to agree with itself too: the exporter filters on the same table, so a product
   in the table that the exporter cannot name is an export that quietly omits a hazard class. */
test('hazard table: gen-caltopo.py filters alerts through the shared table, not a private pattern', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'gen-caltopo.py'), 'utf8');
  assert.match(src, /not in HAZARD_EVENTS/, 'the exporter must gate on the shared table');
  assert.doesNotMatch(src, /HAZARD_ALERT_RE/, 'the retired regex allowlist is still referenced');
  assert.doesNotMatch(src, /LSR_FLOOD_RE/, 'the retired flood-shaped LSR name is still referenced');
});
