'use strict';

/* The AO is Texas plus a 15 mi border buffer (owner decision 2026-09-28): Red River and Sabine
   gauges stay, deep Oklahoma / New Mexico / Arkansas / Louisiana gauges go. The client
   (js/core.js) and the pipeline (scripts/aoarea.py) each implement the rule, so both are run here
   against the shipped data/event.json and held to one set of verdicts. Every test calls code. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadFullApp } = require('./harness.js');

const ROOT = path.join(__dirname, '..');
const EVENT = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'event.json'), 'utf8'));
const POINTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ao-points.json'), 'utf8')).points;

const app = loadFullApp();
const { CONFIG, state, aoAreaParse, aoAreaContains, aoContains, aoGauges, applyEventConfig } = app;
const SB = app._sandbox;

const HOUSTON = [29.76, -95.37];
const SEILING = [36.15, -98.93];

// applyEventConfig writes several CONFIG keys; put every one back so test order never matters
async function withShippedAo(fn) {
  const saved = Object.assign({}, CONFIG);
  try { applyEventConfig(EVENT); return await fn(); } finally { Object.assign(CONFIG, saved); }
}

// swaps sandbox globals for the duration of fn, the way loadWiredMap().spyOn does
async function withStubs(stubs, fn) {
  const saved = {};
  for (const k of Object.keys(stubs)) { saved[k] = SB[k]; SB[k] = stubs[k]; }
  try { return await fn(); } finally { Object.assign(SB, saved); }
}

// a Leaflet that remembers where every point marker went, so "not drawn" is observable
function recordingL() {
  const placed = [];
  const chain = (ll) => {
    const o = { ll, bindPopup() { return o; }, on() { return o; }, addTo() { return o; } };
    return o;
  };
  const L = {
    divIcon: () => ({}),
    canvas: () => ({}),
    marker: (ll) => { placed.push(ll); return chain(ll); },
    circleMarker: (ll) => { placed.push(ll); return chain(ll); },
  };
  return { L, placed };
}
const layerRec = () => { const got = []; return { got, clearLayers() { got.length = 0; }, addLayer(l) { got.push(l); } }; };
const res200 = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

const nwpsGauge = (lid, lat, lon, cat) => ({
  lid, name: `${lid} river`, latitude: lat, longitude: lon,
  status: { observed: { primary: 5, primaryUnit: 'ft', floodCategory: cat, validTime: new Date().toISOString() },
    forecast: {} },
});

test('the shipped aoArea parses: a real outline with the 15 mi border buffer the owner chose', () => {
  const area = aoAreaParse(EVENT.aoArea);
  assert.ok(area, 'data/event.json aoArea must parse, or every consumer silently falls back to the rectangle');
  assert.equal(area.bufferMi, 15);
  assert.ok(area.polygon.length >= 100, `a Texas outline, not a sketch (${area.polygon.length} vertices)`);
  assert.ok(area.polygon.length <= 600, 'kept small enough to ship in event.json');
});

test('fixture verdicts: border-river gauges stay, deep out-of-state gauges and Mexico go', async () => {
  await withShippedAo(() => {
    for (const p of POINTS) assert.equal(aoContains(p.lat, p.lon), p.inAo, p.name);
  });
});

test('a malformed outline is rejected whole, and the AO falls back to the rectangle, never to nothing', async () => {
  const good = EVENT.aoArea.polygon;
  for (const [label, bad] of [
    ['absent', undefined], ['not an object', 'texas'], ['no polygon', { bufferMi: 15 }],
    ['two points', { bufferMi: 15, polygon: good.slice(0, 2) }],
    ['a NaN vertex', { bufferMi: 15, polygon: good.slice(0, 5).concat([[NaN, -99]]) }],
    ['lon/lat swapped', { bufferMi: 15, polygon: good.map(([a, b]) => [b, a]) }],
    ['negative buffer', { bufferMi: -1, polygon: good }],
    ['boolean buffer', { bufferMi: true, polygon: good }],
  ]) assert.equal(aoAreaParse(bad), null, label);

  const closed = aoAreaParse({ bufferMi: 0, polygon: [[30, -100], [31, -100], [31, -99], [30, -100]] });
  assert.equal(closed.polygon.length, 3, 'a closed ring drops its repeated first vertex');

  await withShippedAo(() => {
    const shipped = CONFIG.aoArea;
    applyEventConfig({ aoArea: { bufferMi: 15, polygon: good.slice(0, 2) } });
    assert.equal(CONFIG.aoArea, shipped, 'a malformed re-target does not replace a good outline');
    CONFIG.aoArea = null;
    assert.equal(aoContains(...SEILING), true, 'no outline: the gaugeBbox rectangle is the whole AO, as before');
    assert.equal(aoContains(...HOUSTON), true);
    assert.equal(aoContains(40, -98), false, 'and the rectangle still bounds it');
    assert.equal(aoContains(NaN, -98), false, 'a point with no coordinates cannot be placed');
  });
  assert.equal(aoAreaContains(null, ...SEILING), true, 'a null area imposes no clip of its own');
});

// run scripts/aoarea.py on the same points; the pipeline and the client must never disagree (E5)
const PY_VERDICTS = [
  'import json, sys',
  "sys.path.insert(0, 'scripts')",
  'import aoarea',
  "ev = json.load(open('data/event.json', encoding='utf-8'))",
  "b = ev['gaugeBbox']",
  "bbox = (b['xmin'], b['ymin'], b['xmax'], b['ymax'])",
  "area = aoarea.parse(ev['aoArea'])",
  'print(json.dumps([aoarea.in_scope(bbox, area, p[0], p[1]) for p in json.load(sys.stdin)]))',
].join('\n');

test('JS and Python agree on every point of a statewide grid and along the 15 mi line (E5)', async () => {
  const pts = POINTS.map((p) => [p.lat, p.lon]);
  for (let lat = 25.6; lat <= 36.8; lat += 0.2) {
    for (let lon = -106.9; lon <= -93.2; lon += 0.2) pts.push([+lat.toFixed(4), +lon.toFixed(4)]);
  }
  // straddle the buffer edge: every other vertex, pushed 13 to 17 mi along each axis
  EVENT.aoArea.polygon.forEach(([lat, lon], i) => {
    if (i % 2) return;
    const mi = 13 + (i % 5);
    const dLat = mi / 69, dLon = mi / (69 * Math.cos((lat * Math.PI) / 180));
    pts.push([lat + dLat, lon], [lat - dLat, lon], [lat, lon + dLon], [lat, lon - dLon]);
  });
  const js = await withShippedAo(() => pts.map(([lat, lon]) => aoContains(lat, lon)));
  const py = JSON.parse(execFileSync('python3', ['-c', PY_VERDICTS],
    { cwd: ROOT, input: JSON.stringify(pts), encoding: 'utf8', maxBuffer: 1 << 26 }));
  assert.equal(py.length, pts.length);
  const differ = pts.filter((p, i) => js[i] !== py[i]);
  assert.deepEqual(differ, [], 'client and pipeline disagree about these points');
  const inside = js.filter(Boolean).length;
  assert.ok(inside > 1000 && pts.length - inside > 1000, `both verdicts exercised (${inside} in, ${pts.length - inside} out)`);
});

test('live NWPS ingestion drops out-of-AO gauges before any list, count or marker sees them', async () => {
  const body = { gauges: [
    nwpsGauge('HOUT2', ...HOUSTON, 'minor'),
    nwpsGauge('INGA4', 33.551944, -94.041111, 'none'),
    nwpsGauge('SEIO2', ...SEILING, 'major'),
    nwpsGauge('CPDN5', 32.409275, -104.2149722, 'obs_not_current'),
    nwpsGauge('LPTL1', 31.972222, -94.006111, 'not_defined'),
  ] };
  const { L, placed } = recordingL();
  const prev = { gauges: state.gauges, deg: state.gaugesDegraded, layers: state.layers };
  state.layers = Object.assign({}, state.layers, { gauges: layerRec() });
  try {
    await withShippedAo(() => withStubs({
      L, fetch: () => res200(body), markHealthy() {}, renderGaugesTab() {}, renderForecastList() {},
      renderTiles() {}, renderMapLegend() {}, basinApplyHighlight() {},
    }, () => SB.fetchGauges()));
    assert.deepEqual([...state.gauges].map((g) => g.lid), ['HOUT2', 'INGA4']);
    assert.deepEqual([...state.gaugesDegraded].map((g) => g.lid), ['LPTL1'],
      'the degraded list is clipped too: the New Mexico gauge is gone, the Sabine one stays');
    assert.equal(state.layers.gauges.got.length, 3, 'three markers, all inside the AO');
    assert.ok(!placed.some(([lat]) => lat === SEILING[0]), 'the Oklahoma gauge is never drawn');
  } finally {
    state.gauges = prev.gauges; state.gaugesDegraded = prev.deg; state.layers = prev.layers;
  }
});

test('the cold-start snapshot and the offline cache are clipped the same way', async () => {
  const snap = { generated: '2026-09-28T12:00:00Z', gauges: [nwpsGauge('HOUT2', ...HOUSTON, 'minor'), nwpsGauge('SEIO2', ...SEILING, 'major')] };
  const prev = { gauges: state.gauges, deg: state.gaugesDegraded };
  const quiet = { recordTrends() {}, renderGauges() {}, renderGaugesTab() {}, renderForecastList() {}, renderTiles() {}, setFeedNote() {} };
  try {
    state.gauges = [];
    const ok = await withShippedAo(() => withStubs(Object.assign({ fetch: () => res200(snap) }, quiet), () => SB.hydrateGaugesSnapshot()));
    assert.equal(ok, true);
    assert.deepEqual([...state.gauges].map((g) => g.lid), ['HOUT2'], 'a pre-clip snapshot still cannot reach the board');

    state.gauges = [];
    SB.localStorage.setItem('respondertx.cache.v1', JSON.stringify({ ts: Date.now(), gauges: snap.gauges, gaugesDegraded: [] }));
    await withShippedAo(() => withStubs(Object.assign({ renderAlertList() {} }, quiet), () => SB.hydrateFromCache()));
    assert.deepEqual([...state.gauges].map((g) => g.lid), ['HOUT2'], 'a cache saved before the clip is clipped on the way back in');
    assert.deepEqual([...aoGauges(undefined)], [], 'a cache without a degraded set reads as none, not a crash');
  } finally {
    state.gauges = prev.gauges; state.gaugesDegraded = prev.deg;
    SB.localStorage.removeItem('respondertx.cache.v1');
  }
});

test('USGS sites, RFC forecast crests and low-water crossings outside the AO are not drawn', async () => {
  const prev = { layers: state.layers, usgs: state.usgsSites, fcst: state.fcstMax, gauges: state.gauges,
    at: state.usgsFetchedAt, stagger: CONFIG.usgsTileStaggerMs, retry: CONFIG.usgsRetryMs };
  state.layers = Object.assign({}, state.layers, { usgs: layerRec(), fcstMax: layerRec(), lwc: layerRec() });
  state.gauges = [];
  try {
    await withShippedAo(async () => {
      CONFIG.usgsTileStaggerMs = 0;
      CONFIG.usgsRetryMs = 0;
      state.usgsFetchedAt = 0;
      const site = (id, lat, lon) => ({
        sourceInfo: { siteCode: [{ value: id }], siteName: id, geoLocation: { geogLocation: { latitude: lat, longitude: lon } } },
        values: [{ value: [{ value: '4.2', dateTime: '2026-09-28T12:00:00Z' }] }],
      });
      let first = true;
      const usgsBody = () => {
        const ts = first ? [site('tx', ...HOUSTON), site('ok', ...SEILING)] : [];
        first = false;
        return { value: { timeSeries: ts } };
      };
      const { L } = recordingL();
      await withStubs({ L, fetch: () => res200(usgsBody()), markHealthy() {} }, () => SB.fetchUsgsIv());
      assert.deepEqual([...state.usgsSites].map((s) => s.site), ['tx'], 'the tiled USGS query box is a rectangle; the clip is not');

      const pt = (lid, lat, lon) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: { nws_lid: lid, nws_name: lid, max_value: 20, max_status: 'moderate', issued_time: '2026-09-28 12:00:00 UTC' } });
      const fc = { type: 'FeatureCollection', features: [pt('AAAT2', ...HOUSTON), pt('BBBT2', ...SEILING)] };
      await withStubs({ L, fetch: () => res200(fc), markHealthy() {} }, () => SB.fetchFcstMax());
      assert.deepEqual([...state.fcstMax].map((f) => f.properties.nws_lid), ['AAAT2']);
      assert.equal(state.layers.fcstMax.got.length, 1);

      const lwc = [HOUSTON, SEILING].map(([lat, lon]) => ({ geometry: { coordinates: [lon, lat] }, properties: {} }));
      await withStubs({ L }, () => SB.renderLwc(lwc));
      assert.equal(state.layers.lwc.got.length, 1, 'only the in-AO crossing is drawn');
    });
  } finally {
    state.layers = prev.layers; state.usgsSites = prev.usgs; state.fcstMax = prev.fcst; state.gauges = prev.gauges;
    state.usgsFetchedAt = prev.at; CONFIG.usgsTileStaggerMs = prev.stagger; CONFIG.usgsRetryMs = prev.retry;
  }
});

/* ---------- the region pills: tighter boxes, but together they still cover all of Texas ---------- */

test('every point on a Texas grid lies in at least one region pill (no uncovered ground)', () => {
  const texas = aoAreaParse({ bufferMi: 0, polygon: EVENT.aoArea.polygon });
  const inBox = (b, lat, lon) => lat >= b[0][0] && lat <= b[1][0] && lon >= b[0][1] && lon <= b[1][1];
  const gaps = [];
  let n = 0;
  for (let i = 0; i <= 107; i++) {
    for (let j = 0; j <= 132; j++) {
      const lat = +(25.84 + i * 0.1).toFixed(2), lon = +(-106.66 + j * 0.1).toFixed(2);
      if (!aoAreaContains(texas, lat, lon)) continue;
      n++;
      if (!EVENT.aoPresets.some((p) => inBox(p.bounds, lat, lon))) gaps.push([lat, lon]);
    }
  }
  assert.ok(n > 6000, `the grid actually covers Texas (${n} points)`);
  assert.deepEqual(gaps, [], 'Texas ground that no region pill frames');
});

test('every region pill keeps its anchors inside its own box with a margin', () => {
  for (const p of EVENT.aoPresets) {
    const [[s, w], [n, e]] = p.bounds;
    for (const [lat, lon] of p.anchors) {
      const margin = Math.min(lat - s, n - lat, lon - w, e - lon);
      assert.ok(margin >= 0.05, `${p.id}: anchor ${lat},${lon} sits ${margin.toFixed(2)} deg from its edge`);
    }
  }
});
