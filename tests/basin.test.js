'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

const { riverSlug, basinCrestTime, basinCorridor, basinRivers, basinWaveState, riverOf } = loadApp();

/* Fixtures are real data/gauges-snapshot.json rows (Sabine River corridor, TS Bertha,
   2026-07-24) with observed.validTime set to "now" so the stale gate reads them as live. */

const nowIso = () => new Date().toISOString();
const inH = (h) => new Date(Date.now() + h * 3600000).toISOString();

function gauge(lid, name, lat, lon, opts = {}) {
  return {
    lid, name, latitude: lat, longitude: lon,
    status: {
      observed: {
        primary: opts.obs != null ? opts.obs : 5, primaryUnit: 'ft',
        floodCategory: opts.obsCat || 'no_flooding',
        validTime: opts.obsTime || nowIso(),
      },
      forecast: opts.fcstTime
        ? { primary: opts.fcst != null ? opts.fcst : 10, primaryUnit: 'ft', floodCategory: opts.fcstCat || 'no_flooding', validTime: opts.fcstTime }
        : { primary: -999, primaryUnit: '', floodCategory: 'fcst_not_current', validTime: '0001-01-01T00:00:00Z' },
    },
  };
}

// Sabine corridor, upstream to downstream by real geography: CR 2082 -> Bon Wier -> Deweyville -> Orange
const sabine = () => [
  gauge('ORNT2', 'Sabine River at Orange', 30.097222, -93.721111, { obs: 1.38 }),
  gauge('BUKT2', 'Sabine River at CR 2082', 30.9694, -93.5719, { obs: 71.11 }),
  gauge('DWYT2', 'Sabine River at Deweyville', 30.303611, -93.743611, { obs: 19.25, fcst: 20.2, fcstTime: inH(30) }),
  gauge('BWRT2', 'Sabine River near Bon Wier', 30.746944, -93.608333, { obs: 16.63, fcst: 16.7, fcstTime: inH(4) }),
];

test('riverSlug — lowercased, url-safe, round-trippable through a query param', () => {
  assert.equal(riverSlug('Sabine River'), 'sabine-river');
  assert.equal(riverSlug('Colorado River (TX)'), 'colorado-river-tx');
  assert.equal(riverSlug('Tide Station (HGX)'), 'tide-station-hgx');
  assert.equal(riverSlug(''), '');
});

test('basinCrestTime — observed peak beats forecast; stale and no-forecast gauges yield null', () => {
  const g = sabine().find((x) => x.lid === 'BWRT2');
  const row = { lid: 'BWRT2', peak: 48.47, peak_time: '2026-07-24T18:23:00Z', stale: false };
  assert.equal(basinCrestTime(g, row), Date.parse('2026-07-24T18:23:00Z'));
  assert.equal(basinCrestTime(g, null), Date.parse(g.status.forecast.validTime));
  // NWPS "fcst_not_current" carries year 0001 — never a crest time
  assert.equal(basinCrestTime(sabine().find((x) => x.lid === 'ORNT2'), null), null);
  // stale sensor: its timing is not trustworthy, even with a crest row
  const stale = gauge('BWRT2', 'Sabine River near Bon Wier', 30.746944, -93.608333, { obsTime: '2026-07-01T00:00:00Z', fcstTime: inH(4) });
  assert.equal(basinCrestTime(stale, row), null);
  // a stale crest-summary row is skipped but a live forecast still counts
  assert.equal(basinCrestTime(g, { peak_time: '2026-07-24T18:23:00Z', stale: true }), Date.parse(g.status.forecast.validTime));
});

test('basinCorridor — crest timing orients the Sabine upstream to downstream (real corridor)', () => {
  const gs = sabine();
  const ct = {};
  for (const g of gs) { const t0 = basinCrestTime(g, null); if (t0 != null) ct[g.lid] = t0; }
  const { order, basis, mismatch } = basinCorridor(gs, ct);
  assert.equal(basis, 'crest'); // two timed points (Bon Wier before Deweyville) confirm direction
  assert.equal(mismatch, false);
  assert.deepEqual(order.map((g) => g.lid), ['BUKT2', 'BWRT2', 'DWYT2', 'ORNT2']);
});

test('basinCorridor — reversed crest timing flips the corridor direction', () => {
  const gs = sabine();
  const ct = { BWRT2: Date.now() + 30 * 3600000, DWYT2: Date.now() + 4 * 3600000 };
  const { order, basis } = basinCorridor(gs, ct);
  assert.equal(basis, 'crest');
  assert.deepEqual(order.map((g) => g.lid), ['ORNT2', 'DWYT2', 'BWRT2', 'BUKT2']);
});

test('basinCorridor — no crest timing: geographic order with the honest geo basis', () => {
  const gs = sabine().map((g) => Object.assign(g, { status: { observed: g.status.observed, forecast: { primary: -999, primaryUnit: '', floodCategory: 'fcst_not_current', validTime: '0001-01-01T00:00:00Z' } } }));
  const { order, basis, mismatch } = basinCorridor(gs, {});
  assert.equal(basis, 'geo');
  assert.equal(mismatch, false);
  // seaward estimate still reads the Sabine north-to-south
  assert.deepEqual(order.map((g) => g.lid), ['BUKT2', 'BWRT2', 'DWYT2', 'ORNT2']);
});

test('basinCorridor — single-gauge river: basis single, no fabricated ordering', () => {
  const one = [gauge('FCTT2', 'Cibolo Creek near Falls City', 28.9902, -98.0253)];
  const { order, basis } = basinCorridor(one, {});
  assert.equal(basis, 'single');
  assert.deepEqual(order.map((g) => g.lid), ['FCTT2']);
});

test('basinCorridor — a disagreeing crest sequence (beyond 1h noise) raises the mismatch flag', () => {
  const gs = sabine();
  const H = 3600000;
  // timing claims Deweyville crests 10h before upstream Bon Wier — geometry disagrees
  const ct = { BUKT2: 1 * H, BWRT2: 20 * H, DWYT2: 10 * H, ORNT2: 30 * H };
  const { basis, mismatch } = basinCorridor(gs, ct);
  assert.equal(basis, 'crest');
  assert.equal(mismatch, true);
  // near-equal times (within 1h) are forecast noise, not a disagreement
  const flat = basinCorridor(gs, { BUKT2: 1000, BWRT2: 3000, DWYT2: 2000, ORNT2: 4000 });
  assert.equal(flat.mismatch, false);
});

test('basinWaveState — quiet-river forecast maxima are not a wave; real rises and peaks are', () => {
  const now = Date.now();
  // Guadalupe-style noise: forecast "crest" 12.1 vs 11.96 now, below flood — no fabricated wave
  const noise = gauge('GZBT2', 'Guadalupe River at Gonzales', 29.5, -97.45, { obs: 11.96, fcst: 12.1, fcstTime: inH(3) });
  assert.equal(basinWaveState(noise, null, now).wave, 'none');
  // Sabine Deweyville: a real 0.95 ft rise to the attenuated crest — the wave is coming
  const rise = gauge('DWYT2', 'Sabine River at Deweyville', 30.303611, -93.743611, { obs: 19.25, fcst: 20.2, fcstTime: inH(30) });
  assert.equal(basinWaveState(rise, null, now).wave, 'coming');
  // an at/above-action forecast is always material, rise or not
  const act = gauge('WHAT2', 'Colorado River (TX) at Wharton', 29.3, -96.1, { obs: 21.2, fcst: 21.1, fcstCat: 'action', fcstTime: inH(1) });
  assert.equal(basinWaveState(act, null, now).wave, 'coming');
  // an observed in-flood peak in the past: the wave has passed that point
  const row = { lid: 'BWRT2', peak: 48.47, peak_time: new Date(now - 3 * 3600000).toISOString(), stale: false };
  const passed = gauge('BWRT2', 'Sabine River near Bon Wier', 30.746944, -93.608333, { obs: 16.63, fcst: 16.7, fcstTime: inH(4) });
  assert.equal(basinWaveState(passed, row, now).wave, 'passed');
  // no crest signal at all
  assert.equal(basinWaveState(gauge('ORNT2', 'Sabine River at Orange', 30.097222, -93.721111), null, now).wave, 'none');
});

test('basinRivers — rivers with in-flood or rising gauges sort ahead of crested, then quiet', () => {
  const gs = [
    gauge('AAAT2', 'Quiet Creek at Nowhere', 30.0, -97.0),
    gauge('BBBT2', 'Busy River at Uptown', 30.5, -97.5, { obsCat: 'moderate', obs: 20 }),
    gauge('BBCT2', 'Busy River at Downtown', 30.2, -97.3),
    gauge('CCCT2', 'Crested Creek near Yesterday', 29.8, -96.9),
  ];
  const rivers = basinRivers(gs, { CCCT2: { lid: 'CCCT2', peak: 12.1, peak_time: '2026-07-24T18:23:00Z', stale: false } });
  assert.deepEqual(rivers.map((r) => r.river), ['Busy River', 'Crested Creek', 'Quiet Creek']);
  assert.equal(rivers[0].active, true);
  assert.equal(rivers[0].worst, 3); // moderate
  assert.equal(rivers[1].active, false);
  assert.equal(rivers[1].crested, true);
  assert.equal(rivers[2].active, false);
  assert.equal(rivers[2].crested, false);
  assert.equal(rivers[0].slug, 'busy-river');
});

test('basinRivers — a stale in-flood gauge does not make its river active (stale gate honesty)', () => {
  const gs = [gauge('DDDT2', 'Dead River at Frozen', 30.0, -97.0, { obsCat: 'major', obsTime: '2026-07-01T00:00:00Z' })];
  const rivers = basinRivers(gs, {});
  assert.equal(rivers[0].active, false);
  assert.equal(rivers[0].worst, 0);
});

test('basinRivers — tide station groups are flagged coastal, never dressed up as rivers', () => {
  const gs = [
    gauge('TXPT2', 'Tide Station (LCH) at Texas Point', 29.6894, -93.8419),
    gauge('SRST2', 'Tide Station (LCH) at Sabine Pass', 29.7284, -93.8701),
  ];
  const rivers = basinRivers(gs, {});
  assert.equal(rivers[0].coastal, true);
  assert.equal(riverOf('Tide Station (LCH) at Texas Point'), 'Tide Station (LCH)');
});
