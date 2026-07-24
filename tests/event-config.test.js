'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadMapApp } = require('./harness.js');

const { CONFIG, applyEventConfig, aoFullBounds, resolveAoPresets, chipHealth,
  iemRadarFrames, wxFcstDegraded, pbRadarStampAt } = loadMapApp();

function deq(actual, expected, msg) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), msg);
}

// a non-Bertha fixture: a Hill-Country-shaped revert candidate event.json
const HILL_EVENT = {
  name: 'ResponderTX · Hill Country Drill',
  event: 'Hill Country Drill',
  start: '2026-07-10T00:00:00Z',
  center: [30.0, -99.2],
  zoom: 9,
  gaugeBbox: { xmin: -100.5, ymin: 29.2, xmax: -97.8, ymax: 30.9 },
  aoPresets: [{ id: 'kerr', label: 'Kerr · Guadalupe', bounds: [[29.85, -99.6], [30.2, -98.9]] }],
  tideStations: [],
  tropicalAutoEnable: false,
};

function withConfigSnapshot(fn) {
  const saved = JSON.parse(JSON.stringify({
    center: CONFIG.center, zoom: CONFIG.zoom, gaugeBbox: CONFIG.gaugeBbox,
    aoPresets: CONFIG.aoPresets, tideStations: CONFIG.tideStations,
    tropicalAutoEnable: CONFIG.tropicalAutoEnable,
  }));
  try { fn(); } finally { Object.assign(CONFIG, saved); }
}

test('applyEventConfig: every event field lands in CONFIG, consumers read config not literals', () => {
  withConfigSnapshot(() => {
    applyEventConfig(HILL_EVENT);
    deq(CONFIG.center, [30.0, -99.2]);
    assert.equal(CONFIG.zoom, 9);
    deq(CONFIG.gaugeBbox, HILL_EVENT.gaugeBbox);
    deq(aoFullBounds(), [[29.2, -100.5], [30.9, -97.8]], 'Full AO derives from the event bbox');
    const pills = resolveAoPresets('en');
    assert.equal(pills.length, 2);
    assert.equal(pills[1][0], 'Kerr · Guadalupe');
    deq(CONFIG.tideStations, [], 'inland event: no tide stations, coastal card stays hidden');
    assert.equal(CONFIG.tropicalAutoEnable, false, 'event config can pin the tropical auto-default off');
  });
});

test('applyEventConfig: coastal event tideStations pass through; malformed entries dropped', () => {
  withConfigSnapshot(() => {
    applyEventConfig({ tideStations: [
      { id: '8771450', name: 'Galveston Pier 21' },
      { id: 12345, name: 'bad id type' },
      { name: 'missing id' },
      null,
    ] });
    deq(CONFIG.tideStations, [{ id: '8771450', name: 'Galveston Pier 21' }]);
  });
});

test('applyEventConfig: absent or malformed fields keep the built-in neutral defaults', () => {
  withConfigSnapshot(() => {
    const before = JSON.stringify([CONFIG.center, CONFIG.zoom, CONFIG.gaugeBbox]);
    applyEventConfig({});
    applyEventConfig(null);
    applyEventConfig({ center: [1], zoom: 'x', gaugeBbox: { xmin: -98 }, tropicalAutoEnable: 'yes' });
    assert.equal(JSON.stringify([CONFIG.center, CONFIG.zoom, CONFIG.gaugeBbox]), before);
    assert.equal(CONFIG.tropicalAutoEnable, true, 'non-boolean override ignored');
  });
});

test('built-in CONFIG defaults are event-neutral (no Bertha coastal residue in code)', () => {
  // the no-event fallback must cover Texas, not the last event AO
  assert.ok(CONFIG.gaugeBbox.xmin < -106 && CONFIG.gaugeBbox.ymax > 36, 'Texas-wide fallback bbox');
  deq(CONFIG.tideStations, [], 'no built-in tide-station seed');
  assert.equal(resolveAoPresets('en').length, 1, 'no built-in sub-AO pills from a prior event');
});

test('chipHealth: fresh/aging/stale by age; never-loaded says no data instead of blank', () => {
  const now = 1000 * 60 * 100;
  assert.equal(chipHealth(now - 5 * 60000, now).cls, 'fresh');
  assert.equal(chipHealth(now - 5 * 60000, now).txt, ' 5m');
  assert.equal(chipHealth(now - 20 * 60000, now).cls, 'aging');
  assert.equal(chipHealth(now - 45 * 60000, now).cls, 'stale');
  const never = chipHealth(undefined, now);
  assert.equal(never.cls, 'stale');
  assert.equal(never.txt, ' · health.nodata'); // harness t() echoes the key
});

test('iemRadarFrames: past-only 10-min frames, 5-min bucket aligned, 10-min ingest lag', () => {
  const now = Date.parse('2026-07-24T19:47:33Z');
  const frames = iemRadarFrames(now);
  assert.equal(frames.length, 13);
  const newestMs = frames[frames.length - 1].time * 1000;
  assert.equal(newestMs, Date.parse('2026-07-24T19:35:00Z'), 'newest = floor(now-10min to 5-min bucket)');
  for (let i = 1; i < frames.length; i++) {
    assert.equal(frames[i].time - frames[i - 1].time, 600, '10-min spacing');
  }
  assert.equal(pbRadarStampAt(newestMs), '202607241935', 'stamps resolve to IEM archive tile ids');
  assert.ok(newestMs <= now - 600000, 'never asks IEM for a not-yet-ingested stamp');
});

test('wxFcstDegraded: degraded only when run metadata fails AND no model tile ever painted', () => {
  assert.equal(wxFcstDegraded(null), false);
  assert.equal(wxFcstDegraded({ metaFail: false, tileOk: false }), false);
  assert.equal(wxFcstDegraded({ metaFail: true, tileOk: true }), false, 'tiles painting = not degraded');
  assert.equal(wxFcstDegraded({ metaFail: true, tileOk: false }), true);
});
