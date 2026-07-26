'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

const {
  alertReach, alertSeverity, alertOpen, emergencyBannerMode, gaugeObsStale, gaugeObsCat, gaugeCat, CONFIG,
  gaugeForecastCat, gaugeRising, gaugeRecoveryState, riverOf, recordContext, recordWatchGauges, RECORD_NEAR_FT, state,
  splitGauges, gaugeState, gaugeStateCounts, gaugeHasReading, GAUGE_STATES, GAUGE_DEGRADED, CAT_RANK,
  roadId, roadMemory, updateRoadMemory, reopenedRoads, ROADS_KEY, ROADS_KEY_LEGACY, _sandbox: sandbox,
} = loadApp();

/* ---------- alertReach: pull the specific river reach out of NWS prose ---------- */

test('alertReach — extracts reach and normalizes At/Of casing', () => {
  const p = {
    description:
      '...The National Weather Service has issued a Flood Warning for the ' +
      'following rivers in Texas... Devils River At Bakers Crossing 19N Of ' +
      'Comstock affecting Val Verde County. PRECAUTIONARY/PREPAREDNESS ACTIONS...',
  };
  assert.equal(alertReach(p), 'Devils River at Bakers Crossing 19N of Comstock');
});

test('alertReach — normalizes Nr and Near to lowercase "near"', () => {
  assert.equal(
    alertReach({ description: 'following rivers in Texas... Guadalupe River Nr Spring Branch affecting Comal County.' }),
    'Guadalupe River near Spring Branch',
  );
  assert.equal(
    alertReach({ description: 'the following rivers... Colorado River Near Columbus affecting Colorado County.' }),
    'Colorado River near Columbus',
  );
});

test('alertReach — collapses internal whitespace/newlines before matching', () => {
  const p = { description: 'rivers in Texas...\n   Nueces River At Cotulla\n  affecting La Salle County.' };
  assert.equal(alertReach(p), 'Nueces River at Cotulla');
});

test('alertReach — areal/county Flood Warning with no river reach returns empty', () => {
  assert.equal(alertReach({ description: 'Flood Warning for Bexar County. Turn around, dont drown.' }), '');
});

test('alertReach — missing description returns empty string, not throw', () => {
  assert.equal(alertReach({}), '');
  assert.equal(alertReach({ description: '' }), '');
});

/* ---------- alertSeverity: emergency / warning / watch / advisory ---------- */

test('alertSeverity — FLASH FLOOD EMERGENCY in description is "emergency"', () => {
  assert.equal(
    alertSeverity({ event: 'Flash Flood Warning', description: 'THIS IS A FLASH FLOOD EMERGENCY for Kerr County' }),
    'emergency',
  );
});

test('alertSeverity — CATASTROPHIC damage-threat parameter is "emergency"', () => {
  assert.equal(
    alertSeverity({ event: 'Flash Flood Warning', parameters: { flashFloodDamageThreat: ['CATASTROPHIC'] }, description: 'heavy rain' }),
    'emergency',
  );
});

test('alertSeverity — Warning/Watch/Advisory events classify by keyword', () => {
  assert.equal(alertSeverity({ event: 'Flood Warning', description: 'river rising' }), 'warning');
  assert.equal(alertSeverity({ event: 'Flood Watch', description: 'potential flooding' }), 'watch');
  assert.equal(alertSeverity({ event: 'Flood Advisory', description: 'minor ponding' }), 'advisory');
});

test('alertSeverity — no parameters object does not throw (defaults to advisory)', () => {
  assert.equal(alertSeverity({ event: 'Flood Advisory' }), 'advisory');
});

/* ---------- emergency banner: opening the board mid-emergency must surface it ---------- */

test('alertOpen — a future or missing expires is open, a past one is not', () => {
  const at = (min) => ({ properties: { expires: new Date(Date.now() + min * 60000).toISOString() } });
  assert.equal(alertOpen(at(60)), true);
  assert.equal(alertOpen(at(-60)), false);
  assert.equal(alertOpen({ properties: {} }), true);
});

/* The board is most often opened BECAUSE something is happening. A cold load carries no arrival to
   report, so an already-open emergency must still raise the banner and the title flag. */
test('emergencyBannerMode — a cold load with an emergency already open reads as active, not new', () => {
  assert.equal(emergencyBannerMode(2, 2, false), 'active');
  assert.equal(emergencyBannerMode(1, 0, false), 'active'); // seeded ids must not suppress the cold load
});

test('emergencyBannerMode — a quiet cold load raises nothing', () => {
  assert.equal(emergencyBannerMode(0, 0, false), null);
});

test('emergencyBannerMode — after the first load only newly arrived emergencies raise the banner', () => {
  assert.equal(emergencyBannerMode(2, 1, true), 'new');
  assert.equal(emergencyBannerMode(2, 0, true), null); // already seen, already banner-ed
  assert.equal(emergencyBannerMode(0, 0, true), null);
});

/* ---------- stale-sensor gating: a dead gauge must never count as in-flood ---------- */

const isoMinAgo = (min) => new Date(Date.now() - min * 60000).toISOString();
const gauge = (floodCategory, minAgo) => ({
  status: { observed: { floodCategory, validTime: minAgo == null ? undefined : isoMinAgo(minAgo) } },
});

test('gaugeObsStale — fresh observation is not stale', () => {
  assert.equal(gaugeObsStale(gauge('major', 30)), false);
});

test('gaugeObsStale — observation older than the stale cutoff is stale', () => {
  const overCutoffMin = CONFIG.gaugeStaleHours * 60 + 60;
  assert.equal(gaugeObsStale(gauge('major', overCutoffMin)), true);
});

test('gaugeObsStale — missing or unparseable validTime is treated as stale', () => {
  assert.equal(gaugeObsStale(gauge('major', null)), true);
  assert.equal(gaugeObsStale({ status: { observed: { floodCategory: 'major', validTime: 'not-a-date' } } }), true);
});

test('gaugeCat — a fresh gauge reports its observed flood category', () => {
  assert.equal(gaugeCat(gauge('major', 30)), 'major');
  assert.equal(gaugeCat(gauge('moderate', CONFIG.gaugeStaleHours * 60 - 60)), 'moderate');
});

test('gaugeCat — a STALE gauge is dropped to "none" even at MAJOR reading', () => {
  // honesty invariant: a frozen sensor stuck at MAJOR must not inflate flood counts
  assert.equal(gaugeCat(gauge('major', CONFIG.gaugeStaleHours * 60 + 120)), 'none');
  assert.equal(gaugeCat(gauge('major', null)), 'none');
});

test('gaugeObsCat — non-flood category coerces to "none"', () => {
  assert.equal(gaugeObsCat(gauge('no_flooding', 30)), 'none');
  assert.equal(gaugeObsCat(gauge('action', 30)), 'action');
});

/* ---------- degraded taxonomy: visible as degraded, never counted as severity ---------- */

// NWPS ships a disabled site exactly this way: no reading, and a year-0001 timestamp.
const DEAD_TIME = '0001-01-01T00:00:00Z';
const nwpsGauge = (floodCategory, minAgo) => ({
  lid: 'TEST1', name: 'Test River at Nowhere', latitude: 30, longitude: -98,
  status: { observed: { floodCategory, primary: minAgo == null ? -999 : 12.3, primaryUnit: 'ft', validTime: minAgo == null ? DEAD_TIME : isoMinAgo(minAgo) } },
});

test('splitGauges — the three NWPS degraded states leave state.gauges, everything else stays', () => {
  const { live, degraded } = splitGauges([
    nwpsGauge('major', 30), nwpsGauge('no_flooding', 30), nwpsGauge('action', 30),
    nwpsGauge('not_defined', 30), nwpsGauge('obs_not_current', null), nwpsGauge('out_of_service', null),
    { status: { observed: {} } }, // no category at all — not a gauge we can place anywhere
  ]);
  assert.deepEqual(Array.from(live, (g) => g.status.observed.floodCategory), ['major', 'no_flooding', 'action']);
  assert.deepEqual(Array.from(degraded, (g) => g.status.observed.floodCategory), ['not_defined', 'obs_not_current', 'out_of_service']);
});

test('gaugeState — precedence is out of service, then not current, then no thresholds', () => {
  assert.equal(gaugeState(nwpsGauge('out_of_service', null)), 'oos');
  assert.equal(gaugeState(nwpsGauge('obs_not_current', null)), 'stale');
  assert.equal(gaugeState(nwpsGauge('not_defined', 30)), 'nothresh');
  // a no-thresholds site whose reading also went stale reports the more urgent fact
  assert.equal(gaugeState(nwpsGauge('not_defined', CONFIG.gaugeStaleHours * 60 + 60)), 'stale');
});

test('gaugeState — our own 12h rule lands a frozen gauge in the same row as the NWPS flag', () => {
  assert.equal(gaugeState(gauge('no_flooding', CONFIG.gaugeStaleHours * 60 + 60)), 'stale');
  assert.equal(gaugeState(gauge('major', CONFIG.gaugeStaleHours * 60 + 60)), 'stale');
  assert.equal(gaugeState(gauge('none', 30)), 'none'); // fresh and quiet is not degraded
});

test('gaugeState — a healthy gauge still reports its chromatic severity', () => {
  for (const c of ['major', 'moderate', 'minor', 'action']) assert.equal(gaugeState(gauge(c, 30)), c);
  assert.equal(gaugeState(gauge('no_flooding', 30)), 'none');
});

/* This is the honesty invariant the release must not weaken: making a degraded gauge VISIBLE must
   never make it COUNTABLE. Every count, tile and threat chip keys off gaugeCat. */
test('REGRESSION — no degraded gauge can produce a flood-bearing gaugeCat', () => {
  for (const c of ['not_defined', 'obs_not_current', 'out_of_service']) {
    for (const minAgo of [5, 30, null, CONFIG.gaugeStaleHours * 60 + 60]) {
      const g = nwpsGauge(c, minAgo);
      assert.equal(CAT_RANK[gaugeCat(g)], 0, `${c} @ ${minAgo} produced ${gaugeCat(g)}`);
      assert.equal(gaugeRising(g), false, `${c} @ ${minAgo} claimed to be rising`);
    }
  }
});

test('REGRESSION — splitGauges keeps degraded gauges out of the severity-bearing set entirely', () => {
  const { live } = splitGauges([nwpsGauge('not_defined', 5), nwpsGauge('obs_not_current', 5), nwpsGauge('out_of_service', 5)]);
  assert.equal(live.length, 0);
});

test('gaugeStateCounts — every gauge lands in exactly one row and the rows total the board', () => {
  const prevLive = state.gauges, prevDeg = state.gaugesDegraded;
  const { live, degraded } = splitGauges([
    nwpsGauge('major', 30), nwpsGauge('no_flooding', 30),
    nwpsGauge('no_flooding', CONFIG.gaugeStaleHours * 60 + 60), // locally stale, counts as degraded
    nwpsGauge('not_defined', 30), nwpsGauge('obs_not_current', null), nwpsGauge('out_of_service', null),
  ]);
  state.gauges = live; state.gaugesDegraded = degraded;
  const n = gaugeStateCounts();
  assert.deepEqual(Object.keys(n).sort(), Array.from(GAUGE_STATES).sort());
  assert.equal(Object.values(n).reduce((a, b) => a + b, 0), 6);
  assert.equal(n.major, 1);
  assert.equal(n.none, 1); // the frozen no_flooding gauge is NOT counted here
  assert.equal(n.stale, 2); // it is counted here, alongside the NWPS obs_not_current one
  assert.equal(n.nothresh, 1);
  assert.equal(n.oos, 1);
  state.gauges = prevLive; state.gaugesDegraded = prevDeg;
});

test('gaugeHasReading — the -999 at year 0001 shape is never printed as a level', () => {
  assert.equal(gaugeHasReading(nwpsGauge('out_of_service', null)), false);
  assert.equal(gaugeHasReading(nwpsGauge('obs_not_current', null)), false);
  assert.equal(gaugeHasReading(nwpsGauge('not_defined', 30)), true); // no thresholds, but a real level
  assert.equal(gaugeHasReading({ status: { observed: { primary: 4, validTime: 'not-a-date' } } }), false);
});

test('GAUGE_STATES — the legend list is the five severities plus the three degraded, in that order', () => {
  assert.deepEqual(Array.from(GAUGE_STATES), ['major', 'moderate', 'minor', 'action', 'none', 'nothresh', 'stale', 'oos']);
  assert.deepEqual(Array.from(GAUGE_DEGRADED), ['nothresh', 'stale', 'oos']);
});

/* ---------- forecast category, rising, river grouping ---------- */

// fixture shapes crib data/gauges-snapshot.json rows (status.observed/forecast with
// primary/primaryUnit/floodCategory/validTime; -999 and fcst_not_current are the real sentinels)
const isoInMin = (min) => new Date(Date.now() + min * 60000).toISOString();
const snapGauge = ({ lid = 'BSMT2', name = 'Blanco River at San Marcos', obsCat = 'minor', obsAgoMin = 30, fcstCat = 'moderate', fcstFt = 38.1, fcstInMin = 720 } = {}) => ({
  lid, name, latitude: 29.88, longitude: -97.93,
  status: {
    observed: { primary: 12.4, primaryUnit: 'ft', floodCategory: obsCat, validTime: isoInMin(-obsAgoMin) },
    forecast: { primary: fcstFt, primaryUnit: 'ft', floodCategory: fcstCat, validTime: isoInMin(fcstInMin) },
  },
});

test('gaugeForecastCat — a real flood category passes through', () => {
  assert.equal(gaugeForecastCat(snapGauge({ fcstCat: 'moderate' })), 'moderate');
  assert.equal(gaugeForecastCat(snapGauge({ fcstCat: 'action' })), 'action');
});

test('gaugeForecastCat — fcst_not_current (stale forecast sentinel) reads null, mirroring obs honesty', () => {
  // real no-forecast rows in gauges-snapshot.json carry floodCategory fcst_not_current + primary -999
  assert.equal(gaugeForecastCat(snapGauge({ fcstCat: 'fcst_not_current', fcstFt: -999 })), null);
});

test('gaugeForecastCat — no_flooding and missing forecast object read null, not "none"', () => {
  assert.equal(gaugeForecastCat(snapGauge({ fcstCat: 'no_flooding' })), null);
  assert.equal(gaugeForecastCat({ status: { observed: { floodCategory: 'minor' } } }), null);
  assert.equal(gaugeForecastCat({}), null);
});

test('gaugeRising — forecast category above fresh observed with a future crest is rising', () => {
  assert.equal(gaugeRising(snapGauge({ obsCat: 'minor', fcstCat: 'moderate', fcstInMin: 720 })), true);
});

test('gaugeRising — a stale sensor never reads rising, even with a valid future forecast', () => {
  const overCutoffMin = CONFIG.gaugeStaleHours * 60 + 60;
  assert.equal(gaugeRising(snapGauge({ obsAgoMin: overCutoffMin, obsCat: 'minor', fcstCat: 'major' })), false);
});

test('gaugeRising — a crest already past is not rising', () => {
  assert.equal(gaugeRising(snapGauge({ fcstCat: 'major', fcstInMin: -60 })), false);
});

test('gaugeRising — forecast at or below the observed category is not rising', () => {
  assert.equal(gaugeRising(snapGauge({ obsCat: 'moderate', fcstCat: 'moderate' })), false);
  assert.equal(gaugeRising(snapGauge({ obsCat: 'moderate', fcstCat: 'action' })), false);
});

test('gaugeRising — no usable forecast category is not rising', () => {
  assert.equal(gaugeRising(snapGauge({ fcstCat: 'fcst_not_current', fcstFt: -999 })), false);
});

test('riverOf — first at/near/below/above separator yields the river group', () => {
  assert.equal(riverOf('Blanco River at San Marcos'), 'Blanco River');
  assert.equal(riverOf('Guadalupe River near Spring Branch'), 'Guadalupe River');
  assert.equal(riverOf('Peach Creek below Dilworth'), 'Peach Creek');
  assert.equal(riverOf('Blanco River above at Halifax Ranch near Kyle'), 'Blanco River');
});

test('riverOf — separators only match as whole lowercase words', () => {
  assert.equal(riverOf('Atascosa River at Whitsett'), 'Atascosa River'); // no mid-word "at" split
  assert.equal(riverOf('Williamson Creek At Manchaca Road'), 'Williamson Creek At Manchaca Road'); // capitalized At is not a separator
});

test('riverOf — no separator or nullish input degrades safely', () => {
  assert.equal(riverOf('Choupique Bayou'), 'Choupique Bayou');
  assert.equal(riverOf(null), '');
  assert.equal(riverOf(undefined), '');
});

/* ---------- crest-of-record context — honest margins, never a claimed break below the record ---------- */

const seedRecord = (lid, record_ft, record_date) => { state.records = { [lid]: { name: 'x', record_ft, record_date } }; };

test('recordContext — margin exactly 0 is atOrAbove, not near', () => {
  seedRecord('BSMT2', 43.1, '2015-05-24');
  const rc = recordContext(snapGauge({ fcstFt: 43.1 }));
  assert.equal(rc.margin, 0);
  assert.equal(rc.atOrAbove, true);
  assert.equal(rc.near, false);
  assert.equal(rc.recFt, 43.1);
  assert.equal(rc.year, '2015');
});

test('recordContext — forecast above the record is atOrAbove with a negative margin', () => {
  seedRecord('BSMT2', 43.1, '2015-05-24');
  const rc = recordContext(snapGauge({ fcstFt: 44.6 }));
  assert.equal(rc.margin, -1.5);
  assert.equal(rc.atOrAbove, true);
  assert.equal(rc.near, false);
});

test('recordContext — margin exactly RECORD_NEAR_FT is near, not atOrAbove', () => {
  seedRecord('BSMT2', 43.1, '2015-05-24');
  const rc = recordContext(snapGauge({ fcstFt: 43.1 - RECORD_NEAR_FT }));
  assert.equal(rc.margin, RECORD_NEAR_FT);
  assert.equal(rc.near, true);
  assert.equal(rc.atOrAbove, false);
});

test('recordContext — margin just past RECORD_NEAR_FT is neither near nor atOrAbove', () => {
  seedRecord('BSMT2', 43.1, '2015-05-24');
  const rc = recordContext(snapGauge({ fcstFt: 43.1 - RECORD_NEAR_FT - 0.1 }));
  assert.equal(rc.margin, 5.1);
  assert.equal(rc.near, false);
  assert.equal(rc.atOrAbove, false);
});

test('recordContext — missing record, missing forecast, or sentinel values return null', () => {
  state.records = {};
  assert.equal(recordContext(snapGauge()), null); // no record row for this lid
  seedRecord('BSMT2', 43.1, '2015-05-24');
  assert.equal(recordContext({ lid: 'BSMT2', status: { observed: {} } }), null); // no forecast object
  assert.equal(recordContext(snapGauge({ fcstFt: -999 })), null); // real snapshot no-forecast sentinel
  seedRecord('BSMT2', 0, '2015-05-24');
  assert.equal(recordContext(snapGauge()), null); // zero/absent record_ft
});

test('recordContext — missing record_date yields an empty year, not a throw', () => {
  state.records = { BSMT2: { name: 'x', record_ft: 43.1 } };
  assert.equal(recordContext(snapGauge()).year, '');
});

test('recordWatchGauges — only RISING gauges within RECORD_NEAR_FT (or above) make the watch list', () => {
  const overCutoffMin = CONFIG.gaugeStaleHours * 60 + 60;
  const atRecord = snapGauge({ lid: 'GNLT2', fcstFt: 50.44 });
  const nearRecord = snapGauge({ lid: 'BSMT2', fcstFt: 40.0 });
  const farBelow = snapGauge({ lid: 'CUET2', fcstFt: 20.0 });
  const staleNearRecord = snapGauge({ lid: 'SEGT2', fcstFt: 36.0, obsAgoMin: overCutoffMin }); // margin 0.8 but sensor is dead
  const flatNearRecord = snapGauge({ lid: 'LLGT2', fcstFt: 41.0, obsCat: 'moderate', fcstCat: 'moderate' }); // margin 0.85 but not rising
  const noRecord = snapGauge({ lid: 'ZZZT2', fcstFt: 40.0 });
  state.records = {
    GNLT2: { record_ft: 50.44, record_date: '1998-10-19' },
    BSMT2: { record_ft: 43.1, record_date: '2015-05-24' },
    CUET2: { record_ft: 50.35, record_date: '1998-10-20' },
    SEGT2: { record_ft: 36.8, record_date: '1998-10-18' },
    LLGT2: { record_ft: 41.85, record_date: '1998-10-18' },
  };
  state.gauges = [atRecord, nearRecord, farBelow, staleNearRecord, flatNearRecord, noRecord];
  assert.deepEqual(recordWatchGauges().map((g) => g.lid).sort(), ['BSMT2', 'GNLT2']);
});


/* ---------- gaugeRecoveryState: the ?view=recovery receding-gauge predicate ---------- */

// crest-summary row fixtures crib real data/crest-summary.json rows (TS Bertha 2026-07-24):
// BWRT2 falling-from-crest, SRRT2 receded, plus synthetic still-rising / stale variants
const crestRow = ({ lid = 'SRRT2', peak = 34.78, peakAgoMin = 720, ongoing = false, stale = false } = {}) => ({
  lid, name: 'San Antonio River at SH 72 near Runge', peak,
  peak_time: isoInMin(-peakAgoMin), peak_category: 'moderate',
  last_in_flood: ongoing ? 'ongoing' : isoInMin(-peakAgoMin + 120), ongoing, stale,
});

// live snapshot row where observed primary/floodCategory are controllable (snapGauge pins primary 12.4)
const liveGauge = ({ obsFt = 12.71, obsCat = 'no_flooding', obsAgoMin = 30, fcstCat = 'fcst_not_current', fcstFt = -999, fcstInMin = 360 } = {}) => ({
  lid: 'SRRT2',
  status: {
    observed: { primary: obsFt, primaryUnit: 'ft', floodCategory: obsCat, validTime: isoInMin(-obsAgoMin) },
    forecast: { primary: fcstFt, primaryUnit: 'ft', floodCategory: fcstCat, validTime: isoInMin(fcstInMin) },
  },
});

test('gaugeRecoveryState — flooded during the event, now below flood stage, reads receded (real SRRT2 shape)', () => {
  assert.equal(gaugeRecoveryState(crestRow(), liveGauge(), null), 'receded');
});

test('gaugeRecoveryState — a closed in-flood window with no live gauge still reads receded (crest data stands)', () => {
  assert.equal(gaugeRecoveryState(crestRow(), null, null), 'receded');
});

test('gaugeRecoveryState — re-risen gauge (window closed but live back in flood) is NOT receded', () => {
  assert.equal(gaugeRecoveryState(crestRow(), liveGauge({ obsFt: 30.2, obsCat: 'minor' }), null), null);
});

test('gaugeRecoveryState — ongoing at crest with forecast below current category reads falling (real BWRT2 shape)', () => {
  const row = crestRow({ lid: 'BWRT2', peak: 48.47, peakAgoMin: 30, ongoing: true });
  const live = liveGauge({ obsFt: 48.47, obsCat: 'major', fcstCat: 'no_flooding', fcstFt: 16.7, fcstInMin: 300 });
  assert.equal(gaugeRecoveryState(row, live, null), 'falling');
});

test('gaugeRecoveryState — ongoing with an observed trend down reads falling', () => {
  const row = crestRow({ ongoing: true });
  const live = liveGauge({ obsFt: 33.9, obsCat: 'moderate' });
  assert.equal(gaugeRecoveryState(row, live, { rate: -0.8, dir: 'down' }), 'falling');
});

test('gaugeRecoveryState — ongoing and off-crest by at least 0.5 ft reads falling without a trend', () => {
  const row = crestRow({ ongoing: true, peak: 34.78, peakAgoMin: 240 });
  const live = liveGauge({ obsFt: 34.1, obsCat: 'moderate' });
  assert.equal(gaugeRecoveryState(row, live, null), 'falling');
});

test('gaugeRecoveryState — ongoing, holding at crest with no falling evidence is null (not "receding")', () => {
  const row = crestRow({ ongoing: true, peak: 34.78 });
  const live = liveGauge({ obsFt: 34.78, obsCat: 'moderate' });
  assert.equal(gaugeRecoveryState(row, live, null), null);
});

test('gaugeRecoveryState — still-rising gauge (forecast above current category) is never a recovery signal', () => {
  const row = crestRow({ ongoing: true });
  const live = liveGauge({ obsFt: 33.0, obsCat: 'minor', fcstCat: 'major', fcstFt: 40.2, fcstInMin: 600 });
  assert.equal(gaugeRecoveryState(row, live, { rate: 0.9, dir: 'up' }), null);
});

test('gaugeRecoveryState — stale crest row or stale live sensor is excluded (no honest current reading)', () => {
  assert.equal(gaugeRecoveryState(crestRow({ stale: true }), liveGauge(), null), null);
  const staleLive = liveGauge({ obsAgoMin: CONFIG.gaugeStaleHours * 60 + 60 });
  assert.equal(gaugeRecoveryState(crestRow({ ongoing: true }), staleLive, { rate: -1, dir: 'down' }), null);
});

test('gaugeRecoveryState — never-flooded gauges have no crest row: a missing row is null, not a throw', () => {
  assert.equal(gaugeRecoveryState(null, liveGauge(), null), null);
  assert.equal(gaugeRecoveryState(undefined, null, null), null);
});

/* ---------- road identity + reopened memory: only a segment leaving the feed is a reopening ---------- */

const roadFeature = ({
  route = 'FM0481',
  from = '1.0 Miles West of US0281 on FM0481',
  to = '3.0 Miles West of US0281 on FM0481',
  condition = 'Flooding',
  description = '- Water over roadway.',
} = {}) => ({
  properties: { route_name: route, from_limit: from, to_limit: to, condition, description },
  geometry: { type: 'LineString', coordinates: [[-98.5, 29.7], [-98.42, 29.74]] },
});

const otherRoad = () => roadFeature({
  route: 'SH0016',
  from: '2.0 Miles North of FM1283 on SH0016',
  to: '4.0 Miles North of FM1283 on SH0016',
  condition: 'Closure',
  description: '- Road closed.',
});

function resetRoadMemory() {
  state.roadMemory = null;
  sandbox.localStorage.clear();
}

test('road memory — a Flooding→Damage re-code updates the remembered segment, it is not a reopening', () => {
  resetRoadMemory();
  const seg = roadFeature();
  const id = roadId(seg.properties);
  updateRoadMemory([seg]);
  assert.deepEqual(Object.keys(roadMemory().seen), [id]);

  updateRoadMemory([roadFeature({ condition: 'Damage', description: '- Roadway damage, travel with caution.' })]);
  assert.deepEqual(Object.keys(roadMemory().reopened), [], 'a condition re-code must never read as a reopening');
  assert.equal(roadMemory().seen[id].condition, 'Damage', 'the remembered segment must carry the new condition forward');
  assert.equal(roadMemory().seen[id].flood, true, 'a segment re-coded off Flooding stays flood recovery');
});

test('road memory — a segment that genuinely leaves the feed IS reported as reopened', () => {
  resetRoadMemory();
  const gone = roadFeature();
  const stays = otherRoad();
  updateRoadMemory([gone, stays]);
  updateRoadMemory([stays]);

  const reo = Object.values(roadMemory().reopened);
  assert.equal(reo.length, 1, 'exactly the departed segment must be reopened');
  assert.equal(reo[0].route_name, 'FM0481');
  assert.ok(reo[0].reopenedAt, 'a reopening must be stamped with when it cleared');
  assert.equal(roadMemory().seen[roadId(gone.properties)], undefined, 'a reopened segment leaves the closure list');
  assert.equal(reopenedRoads().fresh.length, 1, 'a just-cleared segment renders in the fresh recovery view');
});

test('road memory — a description-only edit is not a reopening', () => {
  resetRoadMemory();
  updateRoadMemory([roadFeature()]);
  updateRoadMemory([roadFeature({ description: '- Water over roadway. Second crossing impassable.' })]);
  assert.deepEqual(Object.keys(roadMemory().reopened), [], 'a description edit must never read as a reopening');
});

test('road memory — an empty or failed fetch is never diffed into reopenings', () => {
  resetRoadMemory();
  updateRoadMemory([roadFeature(), otherRoad()]);
  updateRoadMemory([]);
  assert.deepEqual(Object.keys(roadMemory().reopened), [], 'an empty response must not clear the board');
  assert.equal(Object.keys(roadMemory().seen).length, 2);
});

test('road memory — the stored v1 map cannot mass-mark reopenings on the first run after upgrade', () => {
  resetRoadMemory();
  const stamp = new Date().toISOString();
  const legacy = { seen: {}, reopened: {} };
  for (let i = 0; i < 25; i++) {
    legacy.seen[`v1id${i}`] = { id: `v1id${i}`, route_name: `FM000${i}`, condition: 'Flooding', flood: true, lastSeen: stamp, vertex: [29.7, -98.5] };
  }
  sandbox.localStorage.setItem(ROADS_KEY_LEGACY, JSON.stringify(legacy));

  assert.equal(ROADS_KEY, 'respondertx.roads.v2', 'the id-shape change must ride a storage-key bump');
  assert.equal(sandbox.localStorage.getItem(ROADS_KEY), null, 'the upgrade starts with no v2 memory');
  assert.deepEqual(Object.keys(roadMemory().seen), [], 'v1 entries must not seed the v2 memory');

  updateRoadMemory([roadFeature(), otherRoad()]);
  assert.deepEqual(Object.keys(roadMemory().reopened), [], 'the first fetch after upgrade must report no reopenings');
  assert.equal(reopenedRoads().fresh.length, 0, 'no green REOPENED row can appear from the changeover');
  assert.equal(sandbox.localStorage.getItem(ROADS_KEY_LEGACY), null, 'the stale v1 map must be cleared');
  assert.ok(sandbox.localStorage.getItem(ROADS_KEY), 'the v2 memory must persist for the next diff');
});
