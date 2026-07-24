'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadMapApp } = require('./harness.js');

const { pbFrameAt, pbFirstIdx, pbRadarStampAt, pbMrmsStampAt, pbBlocksLive, PB_LIVE_HIDE, state } = loadMapApp();

/* frame-selection math for historical playback: frames are as-of snapshots, so a scrub
   time must resolve to the latest frame at-or-before it, clamped inside the 3d/7d/14d
   window (loT). Stamp helpers turn a frame time into the IEM archive tile stamps. */

const HOUR = 3600000;
const T0 = Date.UTC(2026, 6, 21, 0, 0, 0);

function seedFrames(times, loT) {
  state.pbData = { frames: times.map((t) => ({ _t: t, t: new Date(t).toISOString() })) };
  state.pb = { loT };
}

test('pbFrameAt — a time exactly on a frame selects that frame (at-or-before, not strictly-before)', () => {
  seedFrames([T0, T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR], T0);
  assert.equal(pbFrameAt(T0 + 2 * HOUR), 2);
  assert.equal(pbFrameAt(T0), 0);
});

test('pbFrameAt — a time between frames floors to the earlier frame (never shows future data)', () => {
  seedFrames([T0, T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR], T0);
  assert.equal(pbFrameAt(T0 + 2 * HOUR + 30 * 60000), 2);
  assert.equal(pbFrameAt(T0 + 59 * 60000), 0);
});

test('pbFrameAt — a time past the last frame holds the last frame', () => {
  seedFrames([T0, T0 + HOUR, T0 + 2 * HOUR], T0);
  assert.equal(pbFrameAt(T0 + 10 * HOUR), 2);
});

test('pbFrameAt — a time before the window clamps to the first in-window frame', () => {
  // archive holds 14d of frames but the user picked a 3d window: loT sits mid-archive
  seedFrames([T0, T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR], T0 + 2 * HOUR);
  assert.equal(pbFrameAt(T0 - HOUR), 2);
  assert.equal(pbFrameAt(T0 + 1 * HOUR), 2); // in-archive but pre-window: still clamped
});

test('pbFirstIdx — window start at or before the first frame yields index 0', () => {
  seedFrames([T0, T0 + HOUR, T0 + 2 * HOUR], T0 - HOUR);
  assert.equal(pbFirstIdx(), 0);
  seedFrames([T0, T0 + HOUR, T0 + 2 * HOUR], T0);
  assert.equal(pbFirstIdx(), 0);
});

test('pbFirstIdx — window start between frames picks the first frame AT or after it', () => {
  seedFrames([T0, T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR], T0 + HOUR + 60000);
  assert.equal(pbFirstIdx(), 2);
  seedFrames([T0, T0 + HOUR, T0 + 2 * HOUR, T0 + 3 * HOUR], T0 + 2 * HOUR);
  assert.equal(pbFirstIdx(), 2); // exact boundary: >= keeps the boundary frame
});

test('pbFirstIdx — window start past every frame degrades to the last frame, not -1', () => {
  seedFrames([T0, T0 + HOUR, T0 + 2 * HOUR], T0 + 10 * HOUR);
  assert.equal(pbFirstIdx(), 2);
});

test('pbRadarStampAt — floors to the IEM 5-minute archive step in UTC', () => {
  assert.equal(pbRadarStampAt(Date.UTC(2026, 6, 24, 12, 7, 30)), '202607241205');
  assert.equal(pbRadarStampAt(Date.UTC(2026, 6, 24, 12, 5, 0)), '202607241205'); // exact step boundary
  assert.equal(pbRadarStampAt(Date.UTC(2026, 6, 25, 0, 2, 0)), '202607250000'); // day rollover
});

test('pbMrmsStampAt — floors to the hourly MRMS archive stamp (minutes always 00)', () => {
  assert.equal(pbMrmsStampAt(Date.UTC(2026, 6, 24, 12, 59, 59)), '202607241200');
  assert.equal(pbMrmsStampAt(Date.UTC(2026, 6, 24, 13, 0, 0)), '202607241300');
});

/* pbBlocksLive — the one predicate behind every "playback owns the map" lock (layer sheet,
   layer pills, rain-window chips, radar scrub, live-layer adds). */

test('pbBlocksLive — no playback session yet (state.pb null/undefined) never blocks', () => {
  assert.equal(pbBlocksLive({}), false);
  assert.equal(pbBlocksLive({ pb: null }), false);
});

test('pbBlocksLive — playback bar open but on LIVE does not block live layers', () => {
  assert.equal(pbBlocksLive({ pb: { live: true } }), false);
});

test('pbBlocksLive — engaged playback (historical frame showing) blocks live mutations', () => {
  assert.equal(pbBlocksLive({ pb: { live: false } }), true);
});

test('pbBlocksLive — returns a real boolean, never a truthy object (callers assign it to DOM state)', () => {
  assert.strictEqual(pbBlocksLive({ pb: { live: false } }), true);
  assert.strictEqual(pbBlocksLive({ pb: { live: true } }), false);
  assert.strictEqual(pbBlocksLive({}), false);
});

/* time-integrity: nothing live may impersonate the past. PB_LIVE_HIDE is the list playbackEngage
   strips and playbackGoLive restores; every opener that adds one of these back must first ask
   pbBlocksLive, or today's markers appear under the historical frame with a live citation. */

const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');

test('PB_LIVE_HIDE covers both layers the Recovery lens turns on', () => {
  const keys = PB_LIVE_HIDE.map(([k]) => k);
  assert.ok(keys.includes('shelters'), 'shelters must hide under a historical frame');
  assert.ok(keys.includes('roadReopen'), 'reopened roads were absent from the sweep entirely');
});

test('PB_LIVE_HIDE entries are [layerKey, i18nKey] pairs with no duplicates', () => {
  const keys = PB_LIVE_HIDE.map(([k]) => k);
  assert.equal(new Set(keys).size, keys.length, 'a duplicate key would double-restore on go-live');
  for (const entry of PB_LIVE_HIDE) {
    assert.equal(entry.length, 2, `malformed entry: ${JSON.stringify(entry)}`);
    assert.ok(entry[0] && typeof entry[0] === 'string', `bad layer key: ${JSON.stringify(entry)}`);
    assert.match(entry[1], /^layers\./, `the locked-layer note needs an i18n key: ${JSON.stringify(entry)}`);
  }
});

test('every PB_LIVE_HIDE layer key is a real state.layers key assigned in js/map.js', () => {
  const map = SRC('map.js');
  for (const [k] of PB_LIVE_HIDE) {
    assert.match(map, new RegExp(`state\\.layers(\\.${k}\\b|\\.cams\\.)`),
      `${k} is not a layer js/map.js creates, so hiding it is a no-op`);
  }
});

test('openRecoveryView refuses to add live layers while playback is engaged', () => {
  // the regression: engage playback, scrub back 3 days, open Recovery, and today's shelter
  // markers appeared under the PLAYBACK badge with popups citing the live FEMA/ARC feed
  const fn = SRC('panels.js').match(/async function openRecoveryView\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'openRecoveryView not found in js/panels.js');
  const guarded = fn[0].slice(0, fn[0].indexOf('addTo(state.map)'));
  assert.match(guarded, /pbBlocksLive\(state\)/, 'the live-layer adds must sit behind pbBlocksLive');
});
