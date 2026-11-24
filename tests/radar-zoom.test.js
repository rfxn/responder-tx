/* Radar on a zoom, a pan and a refresh. Every frame mounted on the map refetches its tiles on each
   view change, and RainViewer answers a per-IP burst with 429 for a minute, visible frame included:
   13 frames x a viewport of tiles on one zoom was enough to blank the radar it was meant to show.
   Everything here CALLS the shipped functions or fires the handlers initMap() registered. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadMapApp, loadWiredMap } = require('./harness.js');

// a Leaflet-shaped tile layer: opacity, the loading flag GridLayer keeps, and its event surface
function fakeLayer(url, opts) {
  const ev = new Map();
  const l = {
    _url: url, options: opts || {}, wmsParams: {}, opacity: (opts && opts.opacity) || 0, loading: true,
    setOpacity(o) { l.opacity = o; return l; },
    isLoading() { return l.loading; },
    on(e, fn) { if (!ev.has(e)) ev.set(e, []); ev.get(e).push(fn); return l; },
    off(e, fn) { ev.set(e, (ev.get(e) || []).filter((f) => f !== fn)); return l; },
    once(e, fn) { const w = (p) => { l.off(e, w); fn(p); }; return l.on(e, w); },
    fire(e, p) { (ev.get(e) || []).slice().forEach((f) => f(p)); },
    count(e) { return (ev.get(e) || []).length; },
  };
  return l;
}

// LayerGroup semantics the radar code relies on: idempotent add, safe remove, membership
function fakeGroup() {
  const set = new Set();
  const adds = [];
  return {
    set, adds,
    addLayer(l) { if (!set.has(l)) { set.add(l); adds.push(l); } return this; },
    removeLayer(l) { set.delete(l); return this; },
    hasLayer(l) { return set.has(l); },
    clearLayers() { set.clear(); return this; },
  };
}

// timers held, not run: a test fires 'load' or runs the fallback itself
function holdTimers(sb) {
  const timers = [];
  sb.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  sb.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; };
  return timers;
}

// a wired map with 13 observed frames and 4 model hours mounted, playhead at NOW
function wiredWithFrames({ fcstOn = true } = {}) {
  const w = loadWiredMap();
  const timers = holdTimers(w.sandbox);
  const radar = fakeGroup(), fcst = fakeGroup();
  w.layers.radar = radar;
  w.layers.fcstRadar = fcst;
  w.map.addLayer(radar);
  if (fcstOn) w.map.addLayer(fcst);
  const frames = Array.from({ length: 13 }, (_, i) => fakeLayer(`frame${i}`));
  frames.forEach((l) => radar.addLayer(l));
  const hours = [1, 2, 3, 4].map((h) => fakeLayer(`hour${h}`));
  hours.forEach((l) => fcst.addLayer(l));
  w.state.radar = { src: 'rainviewer', frames: frames.map((_, i) => ({ time: 1000 + i * 600 })), frameLayers: frames,
    idx: 12, nowIdx: 12, castStart: 13, tileOk: false, tileFail: false };
  w.state.fcst.hourLayers = hours;
  Object.assign(w.state.rtl, { idx: 12, fut: false, hour: 1, playing: false, timer: null, wantNow: false });
  return { w, radar, fcst, frames, hours, timers };
}

test('a zoom reloads only the frame on screen: hidden frames and model hours detach', () => {
  const { w, radar, fcst, frames } = wiredWithFrames();
  w.fire('zoomstart');
  assert.deepEqual([...radar.set], [frames[12]], 'only the visible frame may fetch tiles at the new zoom');
  assert.equal(fcst.set.size, 0, 'model hours at opacity 0 must not compete with it either');

  const p = wiredWithFrames();
  p.w.fire('movestart'); // a pan is the same burst at a smaller scale
  assert.deepEqual([...p.radar.set], [p.frames[12]]);
});

test('with the playhead in the model future, the shown hour is the one that stays', () => {
  const { w, radar, fcst, hours } = wiredWithFrames();
  Object.assign(w.state.rtl, { idx: 14, fut: true, hour: 2 });
  w.fire('zoomstart');
  assert.deepEqual([...fcst.set], [hours[1]], 'the visible model hour keeps loading');
  assert.equal(radar.set.size, 0, 'every observed frame is hidden while the model hour shows');
});

test('while playing, hidden frames re-mount after the visible frame paints, not before', () => {
  const { w, radar, fcst, frames, hours, timers } = wiredWithFrames();
  w.state.rtl.playing = true;
  w.fire('zoomstart');
  assert.deepEqual([...radar.set], [frames[12]], 'the visible frame loads first, alone');
  frames[12].fire('load');
  assert.equal(radar.set.size, 13, 'play steps every frame, so all of them re-mount once it painted');
  assert.deepEqual(hours.filter((h) => fcst.hasLayer(h)), hours, 'and the model hours around +1h');
  assert.ok(timers.some((t) => t.ms > 0), 'a fallback covers a visible frame that paints nothing');

  const s = wiredWithFrames();
  s.w.state.rtl.playing = true;
  s.w.fire('zoomstart');
  s.w.state.rtl.playing = false; // stopped before the frame painted
  s.frames[12].fire('load');
  s.timers.forEach((t) => t.fn());
  assert.deepEqual([...s.radar.set], [s.frames[12]], 'a stopped timeline does not re-mount anything');
});

test('a burst of pans while playing leaves one pending re-mount, and it runs once', () => {
  const { w, frames, timers } = wiredWithFrames();
  w.state.rtl.playing = true;
  const mounts = w.spyOn('rtlMountAll');
  for (let i = 0; i < 5; i++) w.fire('movestart');
  assert.equal(frames[12].count('load'), 1, 'each movestart replaces the pending re-mount instead of stacking one');
  assert.equal(timers.filter((t) => t.ms > 0 && !t.cleared).length, 1, 'and its fallback timer');
  frames[12].fire('load');
  timers.filter((t) => !t.cleared).forEach((t) => t.fn());
  assert.equal(mounts.length, 1, 'the hidden frames re-mount once');
  assert.equal(frames[12].count('load'), 0, 'and nothing is left listening');
});

test('a stopped timeline fetches a hidden frame when it is shown; stepping is opacity-only after', () => {
  const { w, radar, frames } = wiredWithFrames({ fcstOn: false });
  const sb = w.sandbox;
  w.fire('zoomstart');
  sb.rtlSet(5);
  assert.ok(radar.hasLayer(frames[5]), 'the frame the scrub shows is mounted at the current view');
  assert.equal(frames[5].opacity, w.app.RTL_RADAR_OPACITY);
  assert.equal(frames[12].opacity, 0);
  assert.equal(radar.set.size, 2, 'and only that one: the other eleven cost nothing until shown');

  sb.rtlTogglePlay();
  assert.equal(radar.set.size, 13, 'play mounts every frame up front so each has loaded by its turn');
  sb.rtlStopPlay();
  const adds = radar.adds.length;
  for (let i = 0; i < 13; i++) sb.rtlSet(i);
  assert.equal(radar.adds.length, adds, 'once mounted, stepping never re-mounts or refetches');
  assert.deepEqual(frames.map((l) => l.opacity).filter((o) => o > 0), [w.app.RTL_RADAR_OPACITY]);
});

/* ---------- refresh: the loaded bundle, its fetch and L swapped for recorders ---------- */

const mapApp = loadMapApp();
const MSB = mapApp._sandbox;
const MST = mapApp.state;

function withRefresh(fn) {
  const saved = { radar: MST.radar, rtl: MST.rtl, map: MST.map, layers: MST.layers, fcst: MST.fcst, pb: MST.pb,
    L: MSB.L, fetch: MSB.fetch, st: MSB.setTimeout, ct: MSB.clearTimeout };
  const made = [];
  const wms = [];
  const tileLayer = (url, opts) => { const l = fakeLayer(url, opts); made.push(l); return l; };
  tileLayer.wms = (url, opts) => { const l = fakeLayer(url, opts); wms.push(l); return l; };
  MSB.L = { tileLayer };
  const radar = fakeGroup(), fcst = fakeGroup();
  MST.layers = Object.assign({}, MST.layers, { radar, fcstRadar: fcst });
  MST.map = { hasLayer: (l) => l === radar || l === fcst };
  MST.radar = null;
  MST.rtl = { idx: 0, fut: false, hour: 1, playing: false, timer: null, wantNow: false };
  MST.fcst = { runIso: null, hourLayers: [], metaFail: false, tileOk: false, tileFail: false };
  MST.pb = undefined;
  const timers = holdTimers(MSB);
  let past = [];
  MSB.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ host: 'https://rv', radar: { past, nowcast: [] } }) });
  const setPast = (paths) => { past = paths.map((p, i) => ({ time: 1000 + i * 600, path: `/${p}` })); };
  return Promise.resolve(fn({ made, wms, radar, fcst, timers, setPast }))
    .finally(() => Object.assign(MST, { radar: saved.radar, rtl: saved.rtl, map: saved.map, layers: saved.layers, fcst: saved.fcst, pb: saved.pb }))
    .finally(() => Object.assign(MSB, { L: saved.L, fetch: saved.fetch, setTimeout: saved.st, clearTimeout: saved.ct }));
}

const byPath = (made, p) => made.find((l) => l._url.includes(`/${p}/`));

test('enable mounts the visible frame only, with zoom-time loading off', () => withRefresh(async ({ made, radar, setPast }) => {
  setPast(['a', 'b', 'c']);
  await MSB.fetchRadarFrames();
  assert.equal(made.length, 3);
  assert.deepEqual([...radar.set], [byPath(made, 'c')], 'NOW is mounted; past frames wait until shown');
  assert.equal(byPath(made, 'c').opacity, mapApp.RTL_RADAR_OPACITY);
  assert.ok(made.every((l) => l.options.updateWhenZooming === false),
    'a pinch or flyTo must not fetch every integer zoom it passes through');
}));

test('a refresh keeps the frame on screen until the new one paints, and reuses unchanged frames', () => withRefresh(async ({ made, radar, setPast }) => {
  setPast(['a', 'b', 'c']);
  await MSB.fetchRadarFrames();
  const c = byPath(made, 'c');
  c.loading = false;

  setPast(['b', 'c', 'd']); // ten minutes later: one new frame, the oldest ages out
  await MSB.fetchRadarFrames();
  assert.equal(made.length, 4, 'only the new frame is a new layer; b and c carry over');
  assert.equal(MST.radar.frameLayers[1], c);
  const d = byPath(made, 'd');
  assert.ok(radar.hasLayer(c) && c.opacity === mapApp.RTL_RADAR_OPACITY,
    'the old NOW frame stays painted while the new one loads: no blank on refresh');
  assert.ok(radar.hasLayer(d) && d.opacity === mapApp.RTL_RADAR_OPACITY);
  d.fire('load');
  assert.equal(c.opacity, 0, 'and steps back once the new frame painted');
  assert.equal(d.opacity, mapApp.RTL_RADAR_OPACITY);

  const adds = radar.adds.length;
  await MSB.fetchRadarFrames(); // same index: nothing new upstream
  assert.equal(made.length, 4, 'a refresh with no new frame builds nothing');
  assert.equal(radar.adds.length, adds, 'and mounts nothing');
  assert.equal(d.opacity, mapApp.RTL_RADAR_OPACITY);
}));

test('a refresh under playback raises no live frame', () => withRefresh(async ({ made, setPast }) => {
  setPast(['a', 'b', 'c']);
  await MSB.fetchRadarFrames();
  byPath(made, 'c').loading = false;
  MST.pb = { live: false }; // engaged: playbackEngage zeroes every live frame
  MST.radar.frameLayers.forEach((l) => l.setOpacity(0));
  setPast(['b', 'c', 'd']);
  await MSB.fetchRadarFrames();
  assert.ok(made.length > 3 && made.every((l) => l.opacity === 0), 'nothing live may draw under the PLAYBACK badge');
}));

test('a detached model hour re-mounts when shown, the shown hour first', () => withRefresh(async ({ wms, fcst }) => {
  MST.fcst.hourLayers = [1, 2, 3, 4].map((h) => fakeLayer(`hour${h}`));
  MSB.fcstShow(2);
  assert.equal(fcst.adds[0], MST.fcst.hourLayers[1], 'the visible hour requests its tiles before its neighbours');
  assert.deepEqual(MST.fcst.hourLayers.map((l) => fcst.hasLayer(l)), [true, true, true, true, true]);
  assert.equal(wms.length, 1, 'only +5h was new');
  assert.equal(wms[0].options.updateWhenZooming, false);
  assert.deepEqual(MST.fcst.hourLayers.map((l) => l.opacity), [0, mapApp.FCST_OPACITY, 0, 0, 0]);
}));

test('the tile retry stays bounded', () => withRefresh(async ({ timers }) => {
  const layer = fakeLayer('x');
  MSB.attachTileRetry(layer);
  const img = { src: 'https://rv/t/1.png', isConnected: true };
  for (let i = 0; i < 6; i++) {
    layer.fire('tileerror', { tile: img });
    timers.splice(0).forEach((t) => t.fn());
  }
  assert.equal(img.src, 'https://rv/t/1.png?_rtry=3', 'three retries, then the tile is left alone');
}));

/* E1 on the radar: a RainViewer 429 or dead tile paints nothing, and an empty map under an
   "Observed" legend reads as clear sky. Same failure-AND-nothing-painted shape as the fallback. */
test('a RainViewer frame that errored and painted nothing says so, and clears once a tile loads', () => withRefresh(async ({ made, setPast }) => {
  const nodes = {};
  const node = (sel) => (nodes[sel] = nodes[sel] || { textContent: '', title: '', hidden: false, value: '', style: {},
    classList: { add() {}, remove() {}, toggle() {} } });
  const prevQ = MSB.document.querySelector;
  MSB.document.querySelector = node;
  try {
    setPast(['a', 'b', 'c']);
    await MSB.fetchRadarFrames();
    const [, b, c] = MST.radar.frameLayers;
    assert.equal(node('#wx-legend-src').textContent, 'leg.wx.obs', 'still loading is not a failure');

    c.fire('loading');
    c.fire('tileerror', {});
    assert.equal(node('#wx-legend-src').textContent, 'leg.wx.obs.blank',
      'a frame that errored and painted nothing must not read as observed clear sky');
    assert.equal(node('#rs-label').title, 'leg.wx.obs.blank', 'the stamp carries the reason too');

    c.fire('tileload', {});
    assert.equal(node('#wx-legend-src').textContent, 'leg.wx.obs', 'one painted tile clears the verdict');
    assert.equal(node('#rs-label').title, '');

    c.fire('loading'); // a zoom starts a new load cycle for the frame on screen
    c.fire('tileerror', {});
    assert.equal(node('#wx-legend-src').textContent, 'leg.wx.obs.blank', 'a later failed cycle is caught again');
    c.fire('tileload', {});

    b.fire('loading');
    b.fire('tileerror', {});
    assert.equal(node('#wx-legend-src').textContent, 'leg.wx.obs', 'a hidden frame failing says nothing about the map');
    MSB.rtlSet(1);
    assert.equal(node('#wx-legend-src').textContent, 'leg.wx.obs.blank', 'until the timeline shows it');
    assert.ok(made.length === 3);
  } finally { MSB.document.querySelector = prevQ; }
}));
