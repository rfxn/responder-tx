'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadMapApp } = require('./harness.js');

const { pbFrameAt, pbFirstIdx, pbRadarStampAt, pbMrmsStampAt, state } = loadMapApp();

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
