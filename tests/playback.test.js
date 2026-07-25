'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadMapApp } = require('./harness.js');

const {
  pbFrameAt, pbFirstIdx, pbRadarStampAt, pbMrmsStampAt, pbBlocksLive, pbGaugeNoteKey, PB_LIVE_HIDE, state,
  pbChunkUrl, pbDaysInWindow, pbMergeFrames, pbArchiveStart, pbArchiveStartIso, pbDayAt, pbChunkPending, pbChunkFailed,
  PB_RANGES, pbArchiveDepthDays, pbRangeOverreaches, pbDepthLabel, pbBoundedView, pbKey,
} = loadMapApp();

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

/* frame provenance: the board must never let a rebuilt or recovered frame read as one it
   captured live, the same way the roads note separates archived from reconstructed. */

test('pbGaugeNoteKey — a natively captured frame (no src) reads as the plain archive replay', () => {
  assert.equal(pbGaugeNoteKey(undefined), 'playback.note.replay');
  assert.equal(pbGaugeNoteKey(''), 'playback.note.replay');
});

test('pbGaugeNoteKey — usgs and nwps frames are labelled reconstructed, not captured', () => {
  assert.equal(pbGaugeNoteKey('usgs'), 'playback.note.gauges.recon');
  assert.equal(pbGaugeNoteKey('nwps'), 'playback.note.gauges.recon');
});

test('pbGaugeNoteKey — a frame recovered from our own archive says so, not "reconstructed"', () => {
  assert.equal(pbGaugeNoteKey('git'), 'playback.note.gauges.recov');
});

test('pbGaugeNoteKey — an unknown future src still degrades to reconstructed, never to captured', () => {
  assert.equal(pbGaugeNoteKey('ibwc'), 'playback.note.gauges.recon');
});

test('every gauge-provenance note key exists in both locales', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'i18n.js'), 'utf8');
  for (const key of ['playback.note.replay', 'playback.note.gauges.recon',
    'playback.note.gauges.recov', 'playback.note.thinned',
    'playback.note.loading', 'playback.note.chunkfail',
    'playback.chunk.loading', 'playback.chunk.failed']) {
    const hits = src.split(`'${key}':`).length - 1;
    assert.equal(hits, 2, `${key} must appear once in en and once in es, found ${hits}`);
  }
});

/* Chunked archive transport (v0.98.1). The record ships as an index plus one file per UTC day;
   only the days a window touches are fetched, and each splices into the sorted frame array as it
   lands. The honesty half is that an unloaded day must never render as bare track. */

const DAY = (d, t0, t1, h) => ({ d, t0, t1, h, n: 1 });
const DAYS = [
  DAY('2026-07-20', '2026-07-20T00:00:00Z', '2026-07-20T23:45:00Z', 'aaaa1111'),
  DAY('2026-07-21', '2026-07-21T00:00:00Z', '2026-07-21T23:45:00Z', 'bbbb2222'),
  DAY('2026-07-22', '2026-07-22T00:00:00Z', '2026-07-22T23:45:00Z', 'cccc3333'),
];

function seedChunked(loadedDays = [], failedDays = []) {
  state.pbData = {
    days: DAYS, frames: [], gaugeIndex: {},
    loaded: Object.fromEntries(loadedDays.map((d) => [d, true])),
    failed: Object.fromEntries(failedDays.map((d) => [d, true])),
    inflight: {},
  };
  state.pb = { live: true, idx: 0, days: 3, winLoT: Date.UTC(2026, 6, 20), hiT: Date.UTC(2026, 6, 22, 23, 45) };
}

test('pbChunkUrl carries the day content hash, so an immutable URL changes when the bytes do', () => {
  assert.equal(pbChunkUrl(DAYS[0]), 'history/day/2026-07-20.json?h=aaaa1111');
  assert.notEqual(pbChunkUrl(DAYS[0]), pbChunkUrl({ ...DAYS[0], h: 'zzzz9999' }));
});

test('pbChunkUrl omits the query when the index publishes no hash (never invents one)', () => {
  assert.equal(pbChunkUrl({ d: '2026-07-20' }), 'history/day/2026-07-20.json');
});

test('pbDaysInWindow returns intersecting days newest first, and never a day beyond the window', () => {
  const got = pbDaysInWindow(DAYS, Date.UTC(2026, 6, 21), Date.UTC(2026, 6, 21, 12));
  assert.deepEqual(got.map((d) => d.d), ['2026-07-21', '2026-07-20'],
    '2026-07-22 starts after the window ends and must not be fetched');
});

test('pbDaysInWindow keeps a day the window only clips into (partial overlap is still needed)', () => {
  const got = pbDaysInWindow(DAYS, Date.UTC(2026, 6, 21, 23, 40), Date.UTC(2026, 6, 22, 1));
  assert.deepEqual(got.map((d) => d.d), ['2026-07-22', '2026-07-21', '2026-07-20']);
});

test('pbDaysInWindow also pulls the day just before the window, so its low edge has a frame', () => {
  // the window opens after 2026-07-21's last frame: without that day, scrubbing to the far left
  // resolves to nothing and the first minutes of the requested window read as dead track
  const got = pbDaysInWindow(DAYS, Date.UTC(2026, 6, 21, 23, 50), Date.UTC(2026, 6, 22, 1));
  assert.deepEqual(got.map((d) => d.d), ['2026-07-22', '2026-07-21']);
});

test('pbDaysInWindow on a monolith load (no day list) asks for nothing', () => {
  assert.equal(pbDaysInWindow([], 0, Date.now()).length, 0);
  assert.equal(pbDaysInWindow(undefined, 0, Date.now()).length, 0);
});

test('pbMergeFrames splices an older chunk in and leaves the array time-sorted', () => {
  seedChunked();
  state.pbData.frames = [{ t: '2026-07-22T00:00:00Z', _t: Date.UTC(2026, 6, 22) }];
  assert.equal(pbMergeFrames([{ t: '2026-07-20T00:00:00Z' }, { t: '2026-07-21T00:00:00Z' }]), true);
  assert.deepEqual(state.pbData.frames.map((f) => f.t),
    ['2026-07-20T00:00:00Z', '2026-07-21T00:00:00Z', '2026-07-22T00:00:00Z']);
  assert.ok(state.pbData.frames.every((f) => Number.isFinite(f._t)), 'every spliced frame needs its _t');
});

test('pbMergeFrames never double-inserts a timestamp already held', () => {
  seedChunked();
  state.pbData.frames = [{ t: '2026-07-22T00:00:00Z', _t: Date.UTC(2026, 6, 22) }];
  assert.equal(pbMergeFrames([{ t: '2026-07-22T00:00:00Z' }]), false);
  assert.equal(state.pbData.frames.length, 1);
});

test('pbMergeFrames drops malformed frames rather than seeding NaN times into the scrubber', () => {
  seedChunked();
  state.pbData.frames = [{ t: '2026-07-22T00:00:00Z', _t: Date.UTC(2026, 6, 22) }];
  assert.equal(pbMergeFrames([null, {}, { t: 'not-a-time' }]), false);
  assert.equal(state.pbData.frames.length, 1);
});

test('pbMergeFrames keeps the viewer on the same frame when older days land underneath it', () => {
  seedChunked();
  state.pbData.frames = [
    { t: '2026-07-22T00:00:00Z', _t: Date.UTC(2026, 6, 22) },
    { t: '2026-07-22T01:00:00Z', _t: Date.UTC(2026, 6, 22, 1) },
  ];
  state.pb.live = false;
  state.pb.idx = 1;
  state.pb.loT = Date.UTC(2026, 6, 20);
  pbMergeFrames([{ t: '2026-07-20T00:00:00Z' }, { t: '2026-07-21T00:00:00Z' }]);
  assert.equal(state.pbData.frames[state.pb.idx].t, '2026-07-22T01:00:00Z',
    'the index must follow the frame, not stay a stale offset into a longer array');
});

test('pbArchiveStart reads the index floor, not the earliest frame that happens to be loaded', () => {
  seedChunked(['2026-07-22']);
  state.pbData.frames = [{ t: '2026-07-22T00:00:00Z', _t: Date.UTC(2026, 6, 22) }];
  assert.equal(pbArchiveStartIso(), '2026-07-20T00:00:00Z');
  assert.equal(pbArchiveStart(), Date.UTC(2026, 6, 20));
});

test('pbArchiveStart falls back to the first frame when the load was the monolith', () => {
  state.pbData = { days: [], frames: [{ t: '2026-07-21T06:00:00Z', _t: Date.UTC(2026, 6, 21, 6) }], loaded: {}, failed: {}, inflight: {} };
  assert.equal(pbArchiveStartIso(), '2026-07-21T06:00:00Z');
});

test('pbDayAt resolves a deep-linked moment to the day chunk that holds it', () => {
  seedChunked();
  assert.equal(pbDayAt(Date.UTC(2026, 6, 21, 12)).d, '2026-07-21');
  assert.equal(pbDayAt(Date.UTC(2026, 6, 19)), undefined);
});

test('the unloaded and failed day counts are scoped to the chosen window', () => {
  seedChunked(['2026-07-22'], ['2026-07-20']);
  assert.equal(pbChunkPending(), 1, 'only 2026-07-21 is still outstanding');
  assert.equal(pbChunkFailed(), 1);
  state.pb.winLoT = Date.UTC(2026, 6, 22); // narrow past the failed day
  assert.equal(pbChunkFailed(), 0, 'a day outside the window is not a hole in it');
  assert.equal(pbChunkPending(), 1, '2026-07-21 stays, it holds the frame at the window low edge');
});

test('the monolith fallback path reports no chunk gaps at all', () => {
  state.pbData = { days: [], frames: [], loaded: {}, failed: {}, inflight: {} };
  state.pb = { winLoT: 0, hiT: Date.now() };
  assert.equal(pbChunkPending(), 0);
  assert.equal(pbChunkFailed(), 0);
});

test('the chunk loader lives in js/playback.js, not a new script the shell would have to learn', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.match(SRC('playback.js'), /history\/index\.json/, 'the index URL belongs to playback.js');
  const tags = [...html.matchAll(/<script src="(js\/[^"?]+)\?v=/g)].map((m) => m[1]);
  assert.equal(new Set(tags).size, tags.length, 'duplicate script tag');
  for (const f of tags) {
    if (f.startsWith('js/vendor/')) continue;
    assert.ok(sw.includes(`'${f}'`), `${f} is in index.html but missing from the sw.js precache`);
  }
});

test('the hard fallback to the whole-record view survives in the source', () => {
  const src = SRC('playback.js');
  assert.match(src, /data\/history\.json/, 'an index 404 must still reach data/history.json');
  assert.match(src, /pbInitMonolith\(\)/);
});

/* The bounded compatibility view (v0.98.9). data/history.json now carries only the newest days.
   On that fallback the left edge of the track is a download boundary, not the board's birth, so
   the strings that name the archive's start must switch to the fallback wording. Getting this
   wrong tells a responder the river was never recorded when in fact it was. */
test('pbBoundedView only fires on a file that declares itself a recent window', () => {
  state.pbData = { days: [], frames: [], loaded: {}, failed: {}, inflight: {} };
  assert.equal(pbBoundedView(), null, 'a whole-record load is not a bounded view');
  state.pbData.view = { kind: 'something-else', days: 7 };
  assert.equal(pbBoundedView(), null, 'an unrecognised view kind must not be trusted');
  state.pbData.view = { kind: 'recent-window', days: 7, from: '2026-07-18T00:00:00Z' };
  assert.equal(pbBoundedView().days, 7);
});

test('pbKey swaps every archive-start string to the fallback wording, and only then', () => {
  const named = ['playback.note.start', 'playback.note.depth', 'playback.archnote',
    'playback.prearch', 'playback.chip.partial'];
  state.pbData = { days: [], frames: [], loaded: {}, failed: {}, inflight: {} };
  for (const k of named) assert.equal(pbKey(k), k, `${k} must not be rewritten on a whole record`);
  state.pbData.view = { kind: 'recent-window', days: 7, from: '2026-07-18T00:00:00Z' };
  for (const k of named) assert.equal(pbKey(k), `${k}.window`, `${k} needs a fallback variant`);
});

test('every fallback variant pbKey can produce exists in BOTH languages', () => {
  const I18N = require('./i18n-load.js');
  for (const k of ['playback.note.start', 'playback.note.depth', 'playback.archnote',
    'playback.prearch', 'playback.chip.partial']) {
    assert.ok(I18N.en[`${k}.window`], `en is missing ${k}.window`);
    assert.ok(I18N.es[`${k}.window`], `es is missing ${k}.window`);
    assert.ok(!I18N.es[`${k}.window`].includes('—') && !I18N.en[`${k}.window`].includes('—'),
      `em-dash in ${k}.window`);
  }
});

test('the fallback wording never claims the missing stretch was simply never recorded', () => {
  const I18N = require('./i18n-load.js');
  assert.doesNotMatch(I18N.en['playback.prearch.window'], /never|no recorded frames/i);
  assert.match(I18N.en['playback.note.depth.window'], /full archive/i,
    'the note must point at the record that does hold the rest');
});

/* Long-range modes (v0.98.2). The archive is about 20 days deep and the chips now reach 90.
   A range that exceeds the record must say so; showing an empty stretch of scrubber as though
   it were a quiet stretch of river is the one thing the board may never do. */

// archive floor N days back from now, so depth math is exercised against a real clock
function seedDepth(depthDays) {
  const t0 = Date.now() - depthDays * 86400000;
  state.pbData = {
    days: [{ d: '0000-00-00', t0: new Date(t0).toISOString(), t1: new Date().toISOString(), h: 'x', n: 1 }],
    frames: [{ t: new Date(t0).toISOString(), _t: t0 }], loaded: {}, failed: {}, inflight: {},
  };
  state.pb = { days: 3, live: true, idx: 0, winLoT: Date.now() - 3 * 86400000, hiT: Date.now() };
}

test('the range chips in index.html are exactly the ranges the code knows about', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const chips = [...html.matchAll(/class="pb-chip" data-days="(\d+)"/g)].map((m) => +m[1]);
  assert.deepEqual(chips, Array.from(PB_RANGES), 'a chip with no matching range, or a range with no chip, is unreachable UI');
  assert.ok(PB_RANGES.includes(30) && PB_RANGES.includes(90), 'the long-range modes are the point of this release');
});

test('a range inside the archive depth is not marked partial', () => {
  seedDepth(20);
  assert.equal(pbRangeOverreaches(3), false);
  assert.equal(pbRangeOverreaches(14), false);
});

test('a range deeper than the archive is marked partial, at every long range', () => {
  seedDepth(20);
  assert.equal(pbRangeOverreaches(30), true);
  assert.equal(pbRangeOverreaches(90), true);
});

test('a range equal to the archive depth is not marked partial (no false shortfall on the boundary)', () => {
  seedDepth(30);
  assert.equal(pbRangeOverreaches(30), false, 'floating-point drift must not invent a missing day');
  assert.equal(pbRangeOverreaches(90), true);
});

test('the depth label is a whole day count and never reads zero on a young archive', () => {
  seedDepth(20.6);
  assert.equal(pbDepthLabel(), 20, 'always floor: claiming 21 days from 20.6 overstates the record');
  seedDepth(0.2);
  assert.equal(pbDepthLabel(), 1, 'a few hours of archive must not print "0d recorded"');
});

test('archive depth is measured from the index floor, not from whichever chunk happens to be loaded', () => {
  seedDepth(20);
  state.pbData.frames = [{ t: new Date(Date.now() - 3600000).toISOString(), _t: Date.now() - 3600000 }];
  assert.ok(pbArchiveDepthDays() > 19, 'one loaded hour must not shrink the advertised depth to one hour');
  assert.equal(pbRangeOverreaches(14), false);
});

test('every long-range string exists in both locales', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'i18n.js'), 'utf8');
  for (const key of ['playback.note.depth', 'playback.chip.full', 'playback.chip.partial']) {
    assert.equal(src.split(`'${key}':`).length - 1, 2, `${key} must appear once in en and once in es`);
  }
});

test('the partial-range strings name both the request and the real depth', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'i18n.js'), 'utf8');
  for (const key of ['playback.note.depth', 'playback.chip.partial']) {
    for (const line of src.split('\n').filter((l) => l.includes(`'${key}':`))) {
      assert.ok(line.includes('{d}') && line.includes('{n}'),
        `${key} must carry both the requested range and the recorded depth: ${line.trim()}`);
    }
  }
});

test('a range that overreaches is stated in the note, not only in a hover title', () => {
  const fn = SRC('playback.js').match(/function updatePlaybackNote\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'updatePlaybackNote not found');
  assert.match(fn[0], /pbRangeOverreaches\(pb\.days\)/,
    'the shortfall must reach #pb-note; a title alone is invisible on a touch device');
  assert.match(fn[0], /playback\.note\.depth/);
});

test('the archive-birth flash is keyed per range, so a deeper claim is never waved through', () => {
  const fn = SRC('playback.js').match(/function pbFlashArchNote\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'pbFlashArchNote not found');
  assert.match(fn[0], /state\.pb\.days/, 'a single per-session flag would let 90d inherit 30d\'s flash');
});

test('no range chip is ever disabled: the archive grows and a dead chip cannot announce that', () => {
  const src = SRC('playback.js');
  assert.ok(!/\.pb-chip[^\n]*disabled/.test(src), 'chips must stay reachable, marked rather than dead');
  assert.match(src, /classList\.toggle\('part'/);
});
