'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

const { alertReach, alertSeverity, gaugeObsStale, gaugeObsCat, gaugeCat, CONFIG } = loadApp();

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
