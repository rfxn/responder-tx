'use strict';

/* tests/usgs-bbox.test.js — the USGS WaterServices bounding-box area cap.
 *
 * WaterServices rejects a bBox larger than 25 equator-equivalent square degrees
 * (width x height x cos of the latitude nearest the equator) with an HTTP 400. The
 * standing AO is 127 of those units, so the layer must be swept in tiles. The cap is
 * an upstream limit, not our code, so the guard that matters is the one that fails
 * here when a future AO change outgrows it again.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./harness.js');

const {
  usgsBboxCost, usgsBboxTiles, usgsMergeSites, fetchUsgsIv,
  USGS_BBOX_LIMIT, USGS_BBOX_BUDGET, USGS_BBOX_MAX_TILES, CONFIG, state, _sandbox: sandbox,
} = loadApp();

const ROOT = path.join(__dirname, '..');
const EVENT_BBOX = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/event.json'), 'utf8')).gaugeBbox;

/* ---------- the cap itself ---------- */

test('usgsBboxCost — equator-equivalent area, not raw degrees', () => {
  // 1x1 at the equator is one unit; the same box at 60N costs half, a degree of longitude
  // being half as wide there
  assert.equal(Math.round(usgsBboxCost({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 }) * 1e6) / 1e6, 1);
  assert.ok(Math.abs(usgsBboxCost({ xmin: 0, ymin: 60, xmax: 1, ymax: 61 }) - 0.5) < 0.001);
});

test('usgsBboxCost — the widest edge binds, including a box straddling the equator', () => {
  // northern box: the SOUTHERN edge is nearest the equator and is the expensive one
  const north = usgsBboxCost({ xmin: -100, ymin: 30, xmax: -99, ymax: 40 });
  assert.ok(Math.abs(north - 10 * Math.cos((30 * Math.PI) / 180)) < 1e-9);
  // southern box: mirrored, the NORTHERN edge binds
  assert.equal(
    Math.round(usgsBboxCost({ xmin: -100, ymin: -40, xmax: -99, ymax: -30 }) * 1e9),
    Math.round(north * 1e9),
  );
  // straddling: latitude 0 is inside the box, so no edge is the cheap answer
  assert.ok(Math.abs(usgsBboxCost({ xmin: -100, ymin: -5, xmax: -99, ymax: 5 }) - 10) < 1e-9);
});

test('usgsBboxCost — the pre-fix statewide query really was over the limit', () => {
  // the single-request bBox this replaced; USGS answered it with an HTTP 400
  assert.ok(usgsBboxCost(EVENT_BBOX) > USGS_BBOX_LIMIT * 4);
});

/* ---------- the shipping configuration ---------- */

test('every tile for the SHIPPED gaugeBbox is under the upstream cap', () => {
  const tiles = usgsBboxTiles(EVENT_BBOX);
  assert.ok(tiles.length > 0, 'configured bbox must yield tiles');
  for (const tl of tiles) {
    const cost = usgsBboxCost(tl);
    assert.ok(cost <= USGS_BBOX_BUDGET, `tile ${JSON.stringify(tl)} costs ${cost}, over budget ${USGS_BBOX_BUDGET}`);
    assert.ok(cost < USGS_BBOX_LIMIT, `tile ${JSON.stringify(tl)} costs ${cost}, at or over the upstream limit`);
  }
});

test('the SHIPPED gaugeBbox does not need an unreasonable number of requests', () => {
  // this is the loud half: an AO change that quietly demands 40 sub-requests fails here
  assert.ok(
    usgsBboxTiles(EVENT_BBOX).length <= USGS_BBOX_MAX_TILES,
    `configured gaugeBbox needs ${usgsBboxTiles(EVENT_BBOX).length} tiles, over the ${USGS_BBOX_MAX_TILES} ceiling`,
  );
});

test('CONFIG.gaugeBbox default agrees with data/event.json', () => {
  // the built-in fallback ships too; it must clear the same cap
  for (const tl of usgsBboxTiles(CONFIG.gaugeBbox)) {
    assert.ok(usgsBboxCost(tl) <= USGS_BBOX_BUDGET);
  }
});

test('the budget leaves real margin under the measured limit', () => {
  assert.ok(USGS_BBOX_BUDGET < USGS_BBOX_LIMIT, 'budget must sit under the upstream limit');
  assert.ok(USGS_BBOX_LIMIT - USGS_BBOX_BUDGET >= 5, 'margin under the upstream limit is too thin');
});

/* ---------- an oversized configuration is caught, not shipped ---------- */

test('a deliberately oversized bbox still tiles under the cap', () => {
  // the whole lower 48 plus slack, roughly 4x the standing AO
  const huge = { xmin: -125, ymin: 24, xmax: -66, ymax: 50 };
  const tiles = usgsBboxTiles(huge);
  assert.ok(tiles.length > 8, 'a far larger AO must take more tiles, not larger ones');
  for (const tl of tiles) assert.ok(usgsBboxCost(tl) <= USGS_BBOX_BUDGET, 'oversized AO produced an over-budget tile');
});

test('an absurd bbox exceeds the tile ceiling so the guard can fail it', () => {
  // whole-globe: tiles stay legal, but the request count is the thing that must be refused
  const globe = { xmin: -180, ymin: -85, xmax: 180, ymax: 85 };
  const tiles = usgsBboxTiles(globe);
  for (const tl of tiles) assert.ok(usgsBboxCost(tl) <= USGS_BBOX_BUDGET);
  assert.ok(tiles.length > USGS_BBOX_MAX_TILES, 'the ceiling must be reachable, else it guards nothing');
});

test('tiles cover the bbox exactly, with no gap and no drift at the far edge', () => {
  const b = EVENT_BBOX;
  const tiles = usgsBboxTiles(b);
  assert.ok(Math.abs(Math.min(...tiles.map((t) => t.xmin)) - b.xmin) < 1e-4, 'west edge lost');
  assert.ok(Math.abs(Math.max(...tiles.map((t) => t.xmax)) - b.xmax) < 1e-4, 'east edge lost');
  assert.ok(Math.abs(Math.min(...tiles.map((t) => t.ymin)) - b.ymin) < 1e-4, 'south edge lost');
  assert.ok(Math.abs(Math.max(...tiles.map((t) => t.ymax)) - b.ymax) < 1e-4, 'north edge lost');
  const area = tiles.reduce((s, t) => s + (t.xmax - t.xmin) * (t.ymax - t.ymin), 0);
  assert.ok(Math.abs(area - (b.xmax - b.xmin) * (b.ymax - b.ymin)) < 1e-3, 'tiles do not sum to the bbox');
});

test('usgsBboxTiles — a degenerate or absent bbox yields nothing rather than a bad query', () => {
  assert.equal(usgsBboxTiles(null).length, 0);
  assert.equal(usgsBboxTiles({ xmin: -98, ymin: 29, xmax: -98, ymax: 30 }).length, 0, 'zero width');
  assert.equal(usgsBboxTiles({ xmin: -98, ymin: 29, xmax: NaN, ymax: 30 }).length, 0, 'non-finite edge');
});

/* ---------- merging sweeps ---------- */

test('usgsMergeSites — a site on a shared tile edge is not listed twice', () => {
  // WaterServices bBox edges are inclusive on BOTH sides, so adjacent tiles really do
  // both return a station sitting exactly on the boundary
  const edge = { site: '08168000', name: 'Comal Spgs', lat: 29.7, lon: -98.14, ft: 4.2, t: 'T1' };
  const merged = usgsMergeSites([
    [edge, { site: '111', name: 'A', lat: 30, lon: -97, ft: 1, t: 'T1' }],
    [edge, { site: '222', name: 'B', lat: 31, lon: -96, ft: 2, t: 'T1' }],
  ]);
  assert.equal(merged.length, 3);
  assert.equal(new Set(merged.map((s) => s.site)).size, 3);
});

test('usgsMergeSites — empty sweeps contribute nothing and do not throw', () => {
  assert.equal(usgsMergeSites([]).length, 0);
  assert.equal(usgsMergeSites([[], []]).length, 0);
});

/* ---------- honest degradation across a tiled sweep ---------- */

// drive fetchUsgsIv against a scripted per-tile responder
function runSweep(responder) {
  const healthy = [];
  const realFetch = sandbox.fetch;
  const realMark = sandbox.markHealthy;
  const realStagger = CONFIG.usgsTileStaggerMs;
  const realRetry = CONFIG.usgsRetryMs;
  sandbox.markHealthy = (k) => healthy.push(k);
  sandbox.fetch = (url) => {
    const r = responder(url);
    if (r === null) return Promise.reject(new Error('tile down'));
    return Promise.resolve({ ok: true, json: () => Promise.resolve(r) });
  };
  state.usgsFetchedAt = 0;
  state.usgsPartial = false;
  state.usgsSites = [];
  state.gauges = [];
  state.layers.usgs = sandbox.L;
  CONFIG.usgsTileStaggerMs = 0; // real cadence is exercised against the live service, not here
  CONFIG.usgsRetryMs = 0;
  return fetchUsgsIv()
    .then(() => ({ healthy, err: null }), (err) => ({ healthy, err }))
    .then((out) => {
      sandbox.fetch = realFetch;
      sandbox.markHealthy = realMark;
      CONFIG.usgsTileStaggerMs = realStagger;
      CONFIG.usgsRetryMs = realRetry;
      return out;
    });
}

const bboxOf = (t) => `bBox=${t.xmin},${t.ymin},${t.xmax},${t.ymax}`;

const oneSite = (id, lat, lon) => ({
  value: {
    timeSeries: [{
      sourceInfo: { siteCode: [{ value: id }], siteName: `site ${id}`, geoLocation: { geogLocation: { latitude: lat, longitude: lon } } },
      values: [{ value: [{ value: '3.5', dateTime: '2026-07-26T15:00:00Z' }] }],
    }],
  },
});

test('a full sweep merges every tile and stamps the source healthy', async () => {
  let n = 0;
  const out = await runSweep(() => oneSite(`site-${n++}`, 30, -98));
  assert.equal(out.err, null);
  assert.equal(state.usgsPartial, false);
  assert.deepEqual(out.healthy, ['usgs'], 'a complete sweep marks usgs healthy');
  assert.equal(state.usgsSites.length, usgsBboxTiles(CONFIG.gaugeBbox).length, 'every tile contributed');
});

test('a transient tile failure is retried rather than reported as partial', async () => {
  const dead = new Set([bboxOf(usgsBboxTiles(CONFIG.gaugeBbox)[0])]);
  let n = 0;
  // the tile fails once, then answers: exactly the transient 503 seen from WaterServices
  const out = await runSweep((url) => {
    const hit = [...dead].find((bb) => url.includes(bb));
    if (hit) { dead.delete(hit); return null; }
    return oneSite(`site-${n++}`, 30, -98);
  });
  assert.equal(out.err, null);
  assert.equal(state.usgsPartial, false, 'a tile that recovers on retry is not a partial sweep');
  assert.deepEqual(out.healthy, ['usgs'], 'a recovered sweep is complete and stamps healthy');
});

test('a partial sweep keeps its data but is never stamped healthy', async () => {
  // this tile refuses on every attempt, retry included
  const dead = bboxOf(usgsBboxTiles(CONFIG.gaugeBbox)[0]);
  let n = 0;
  const out = await runSweep((url) => (url.includes(dead) ? null : oneSite(`site-${n++}`, 30, -98)));
  assert.equal(out.err, null, 'a single dead tile must not blank the layer');
  assert.equal(state.usgsPartial, true, 'a short sweep must be recorded as partial');
  assert.deepEqual(out.healthy, [], 'partial data must NOT refresh the freshness stamp');
  assert.ok(state.usgsSites.length > 0, 'the tiles that did answer are still usable');
});

test('a fully failed sweep throws so the feed reports degraded', async () => {
  const out = await runSweep(() => null);
  assert.ok(out.err, 'every tile failing must reject, not resolve empty');
  assert.match(String(out.err.message), /sub-requests failed/);
  assert.deepEqual(out.healthy, [], 'a dead sweep never marks healthy');
});

test('the sweep is throttled between polls instead of firing on every refresh', async () => {
  let calls = 0;
  const realFetch = sandbox.fetch;
  const realMark = sandbox.markHealthy;
  sandbox.markHealthy = () => {};
  sandbox.fetch = () => { calls++; return Promise.resolve({ ok: true, json: () => Promise.resolve(oneSite('s1', 30, -98)) }); };
  state.usgsFetchedAt = 0;
  state.gauges = [];
  state.layers.usgs = sandbox.L;
  const realStagger = CONFIG.usgsTileStaggerMs;
  const realRetry = CONFIG.usgsRetryMs;
  CONFIG.usgsTileStaggerMs = 0;
  CONFIG.usgsRetryMs = 0;
  const tiles = usgsBboxTiles(CONFIG.gaugeBbox).length;
  await fetchUsgsIv();
  assert.equal(calls, tiles, 'first sweep queries every tile');
  await fetchUsgsIv(); // immediately again, as the 3-minute poll loop would
  assert.equal(calls, tiles, 'a second poll inside the interval must not re-query');
  state.usgsFetchedAt = Date.now() - CONFIG.usgsMinIntervalMs - 1;
  await fetchUsgsIv();
  assert.equal(calls, tiles * 2, 'once the interval passes the sweep runs again');
  sandbox.fetch = realFetch;
  sandbox.markHealthy = realMark;
  CONFIG.usgsTileStaggerMs = realStagger;
  CONFIG.usgsRetryMs = realRetry;
});

test('the shipped burst controls are non-zero, so a tiled sweep is not fired all at once', () => {
  // WaterServices 503s a tight burst; zeroing these in production reinstates that
  assert.ok(CONFIG.usgsTileStaggerMs > 0, 'sub-requests must be staggered');
  assert.ok(CONFIG.usgsRetryMs > 0, 'a retried tile must back off first');
  const tiles = usgsBboxTiles(CONFIG.gaugeBbox).length;
  const spread = (tiles - 1) * CONFIG.usgsTileStaggerMs + CONFIG.usgsRetryMs;
  assert.ok(spread < CONFIG.refreshMs, 'a sweep must finish well inside one poll interval');
});

test('the throttle stays inside the window that triggers the USGS fallback', () => {
  // the fallback offers this layer when NWPS gauges pass 15 minutes stale, and the feed chip
  // turns from fresh at 10; the sweep interval has to beat both
  assert.ok(CONFIG.usgsMinIntervalMs <= 10 * 60000, 'sweep interval would let the feed chip go stale');
  assert.ok(CONFIG.usgsMinIntervalMs >= CONFIG.refreshMs, 'a throttle under one poll saves nothing');
});

/* ---------- the site-list path is a different query and stays untouched ---------- */

test('gen-history.py queries USGS by site list, so the bbox cap never applies to it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/gen-history.py'), 'utf8');
  assert.match(src, /monitoring_location_id=\{ids\}/, 'gen-history must query by explicit site list');
  // it does hold bboxes, as a retention filter over results; what it must never do is send one.
  // Both spellings: the legacy service took bBox, the OGC API it migrated to takes bbox.
  assert.ok(!/[?&]bBox=/.test(src), 'gen-history must not acquire a bBox query parameter');
  assert.ok(!/[?&]bbox=/.test(src), 'gen-history must not acquire an OGC bbox query parameter');
});
