'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

const {
  alertReach, alertSeverity, gaugeObsStale, gaugeObsCat, gaugeCat, CONFIG,
  gaugeForecastCat, gaugeRising, gaugeRecoveryState, riverOf, recordContext, recordWatchGauges, RECORD_NEAR_FT, state,
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
