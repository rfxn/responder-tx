'use strict';

/* Four owner asks that had gone cold, pinned so they cannot go cold again.
 *
 *  1. A view the user sets survives a hard refresh: layers, framing, area chip, tab and filters.
 *     A shared link is an explicit intent and still wins for the load it opens, and a layer that
 *     no longer exists in a later release is dropped rather than throwing on the way in.
 *  2. The rising-to-major focus has a live call site. It shipped once, its caller was removed by a
 *     later rework, and nothing failed: the function sat orphaned with its CSS unreachable. The
 *     wiring test here is behavioural, not a grep for the definition.
 *  3. An offline save that fails, partly completes, or is evicted says so.
 *  4. The two deliberate-locate controls agree on one zoom.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, loadMapApp, loadWiredMap } = require('./harness.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const CSS = read('css/app.css');
const VIEW_KEY = 'respondertx.view';

/* ---------- 1. the kept view ---------- */

// a Leaflet-shaped double: enough map for applyLayerState/mapFrame to be exercised for real
function fakeMap(center, zoom) {
  const on = new Set();
  const fits = [];
  const views = [];
  return {
    _on: on,
    _fits: fits,
    _views: views,
    hasLayer: (l) => on.has(l),
    addLayer(l) { on.add(l); },
    removeLayer(l) { on.delete(l); },
    eachLayer(f) { on.forEach(f); },
    getCenter: () => ({ lat: center[0], lng: center[1] }),
    getZoom: () => zoom,
    setView(c, z) { views.push([c, z]); center = [c[0], c[1]]; zoom = z; return this; },
    fitBounds(b) { fits.push(b); return this; },
    getContainer: () => ({}),
    on() {}, once() {}, off() {},
  };
}

// stand in for a registered overlay: addTo(map) is how every real caller switches one on
const fakeLayer = (map) => ({ addTo(m) { (m || map).addLayer(this); return this; } });

function mapCtx() {
  const app = loadMapApp();
  const sb = app._sandbox;
  const map = fakeMap([30.0, -95.5], 9);
  Object.assign(app.state, {
    map, layers: {}, pb: null, lsBulk: false, viewReady: true,
    filters: {}, sort: 'smart', rainWindow: '1h', activeBase: 'streets', lsCamOpen: new Set(),
  });
  // the sheet rows are the vocabulary; give every one of them a layer so layerRowOn is truthful
  for (const k of app.layerRowKeys()) app.state.layers[k] = fakeLayer(map);
  app.state.layers.radar = fakeLayer(map);
  app.state.layers.fcstRadar = fakeLayer(map);
  sb.renderLayerPills = () => {}; // real ones reach for the sheet DOM and are not what is under test
  sb.layerSheetSync = () => {};
  sb.renderLayerSheet = () => {};
  sb.localStorage.removeItem(VIEW_KEY);
  patchActiveTab(sb);
  return { app, sb, map, state: app.state };
}

// the share/save builders read the active tab off the page; a real board always has one
let tabPatched = false;
function patchActiveTab(sb) {
  if (tabPatched) return;
  tabPatched = true;
  const raw = sb.document.querySelector.bind(sb.document);
  sb.document.querySelector = (sel) => (sel === '.tabs button.active'
    ? { dataset: { tab: 'tab-requests' } } : raw(sel));
}

const storedView = (sb) => JSON.parse(sb.localStorage.getItem(VIEW_KEY) || 'null');

/* Stands the AO pill control up the way initAoJump() does at boot, so aoSelectById / aoPickedId /
   buildShareUrl are exercised against a real aoCtl (a module-level `let`, unreachable from a test).
   Returns the restore for CONFIG, which the whole bundle shares. */
function withAoPills(app, presets) {
  const prev = app.CONFIG.aoPresets;
  app.CONFIG.aoPresets = presets;
  app._sandbox.initAoJump();
  return () => { app.CONFIG.aoPresets = prev; };
}

const AO_PILLS = [
  { id: 'houston', label: 'Houston', bounds: [[29.4, -95.8], [30.2, -94.9]] },
  { id: 'hillcountry', label: 'Hill Country', bounds: [[29.6, -99.6], [30.6, -98.0]] },
];

test('the saved layer set is re-applied on the next load, on and off alike', () => {
  const { app, map, state } = mapCtx();
  map.addLayer(state.layers.gauges);
  map.addLayer(state.layers.usgs);

  const snap = app.collectLayerState();
  assert.ok(snap.on.includes('gauges') && snap.on.includes('usgs'), 'the snapshot must name what is on');
  assert.ok(snap.known.includes('inundation'), 'the snapshot must also name what this build offers');

  // a reload starts from the shipped defaults, which here is nothing on
  map._on.clear();
  map.addLayer(state.layers.inundation); // and something the saved view had off
  assert.equal(app.applyLayerState(snap.on, snap.known), true);

  assert.equal(app.layerRowOn('gauges'), true, 'a layer the user had on must come back on');
  assert.equal(app.layerRowOn('usgs'), true);
  assert.equal(app.layerRowOn('inundation'), false, 'a layer the user had off must be switched back off');
});

test('a stored layer that no longer exists is dropped without error', () => {
  const { app, map, state } = mapCtx();
  map.addLayer(state.layers.gauges);
  const known = app.layerRowKeys().concat(['stormSurgeV1', 'camsR_retiredregion']);
  const on = ['gauges', 'stormSurgeV1', 'camsR_retiredregion'];

  assert.doesNotThrow(() => app.applyLayerState(on, known), 'a retired layer key must not throw on restore');
  assert.equal(app.layerRowOn('gauges'), true, 'the layers that do still exist are restored');
  assert.equal(app.layerRowOn('stormSurgeV1'), null, 'the retired key names nothing and stays that way');
});

test('a layer added after the view was saved keeps its shipped default', () => {
  const { app, map, state } = mapCtx();
  // an older saved view: it never knew riverSentry, so it cannot be read as "the user turned it off"
  const known = app.layerRowKeys().filter((k) => k !== 'riverSentry');
  map.addLayer(state.layers.riverSentry); // stands in for a new default-on layer
  app.applyLayerState(['gauges'], known);
  assert.equal(app.layerRowOn('riverSentry'), true,
    'a layer the saved view never knew about must not be switched off by it');
});

test('playback never captures or overwrites the user layer set', () => {
  const { app, map, state } = mapCtx();
  map.addLayer(state.layers.gauges);
  state.pb = { live: false }; // engaged: the map is showing the archive's layers, not the user's
  assert.equal(app.pbBlocksLive(state), true);
  assert.equal(app.collectLayerState(), null, 'the archive picture must never be stored as a user choice');
  assert.equal(app.applyLayerState(['usgs'], app.layerRowKeys()), false, 'a stored set must not be applied over the archive');
  assert.equal(app.layerRowOn('usgs'), false, 'nothing was toggled');
});

test('a save while playback is engaged carries the last real layer set and framing forward', () => {
  const { app, sb, map, state } = mapCtx();
  map.addLayer(state.layers.gauges);
  map.addLayer(state.layers.usgs);
  sb.saveViewState();
  const live = storedView(sb);
  assert.ok(live.ly.includes('gauges') && live.ly.includes('usgs'), 'the live save must record what is on');
  assert.deepEqual([live.mlat, live.mlon, live.mz], [30, -95.5, 9], 'and where the reader left the map');

  // playback engaged: the map is now showing the archive's layers, at the archive's framing
  state.pb = { live: false };
  map._on.clear();
  map.addLayer(state.layers.inundation);
  map.setView([25.1, -80.2], 6);
  assert.equal(app.collectLayerState(), null, 'the archive picture is never a snapshot of the user view');

  sb.saveViewState();
  const during = storedView(sb);
  assert.deepEqual(during.ly.slice().sort(), live.ly.slice().sort(),
    "the archive's layer set must never be stored as the user's choice");
  assert.deepEqual(during.lyk.slice().sort(), live.lyk.slice().sort());
  assert.deepEqual([during.mlat, during.mlon, during.mz], [30, -95.5, 9],
    "and the archive's framing must not overwrite the framing the user left");
});

test('a link overrides the kept framing and layer set; a plain load restores it', () => {
  const { linkOwnsView } = loadApp();
  assert.equal(linkOwnsView(new URLSearchParams('')), false, 'a plain load restores the kept view');
  for (const q of ['?tab=gauges', '?ft=rescue', '?hydro=BTVT2', '?cam=abc']) {
    assert.equal(linkOwnsView(new URLSearchParams(q)), false,
      `${q} names one control or one record and must not cost the reader their kept view`);
  }
  for (const q of ['?mlat=30.1&mlon=-95.4&mz=11', '?usgs=1', '?camreg=all', '?ao=houston', '?rain=1h']) {
    assert.equal(linkOwnsView(new URLSearchParams(q)), true, `${q} is a shared framing and must win`);
  }

  // derived by running the builder, not by reading it: the params that appear only once the
  // overlays are on ARE the layer params, and every one has to make the kept view stand down
  const { app, sb, map, state } = mapCtx();
  const params = () => new URLSearchParams(new URL(sb.buildShareUrl()).search);
  const bare = params();
  for (const k of Object.keys(state.layers)) map.addLayer(state.layers[k]);
  const emitted = [...params().keys()].filter((k) => !bare.has(k));
  assert.ok(emitted.length >= 5, `expected buildShareUrl to emit layer params, found ${emitted.join(', ')}`);
  for (const k of emitted) {
    assert.ok(app.LINK_VIEW_PARAMS.includes(k),
      `buildShareUrl emits ?${k}= but the kept view does not stand down for it`);
  }
});

test('a plain load restores the stored framing and overlays; a link or the archive stands it down', () => {
  const stored = (app) => ({ mlat: 29.5, mlon: -98.4, mz: 12, ly: ['gauges'], lyk: app.layerRowKeys() });

  const plain = mapCtx();
  plain.sb.location.search = '';
  plain.map.addLayer(plain.state.layers.inundation); // something the stored view had off
  plain.sb.restoreViewFraming(stored(plain.app));
  assert.deepEqual([plain.map.getCenter().lat, plain.map.getCenter().lng, plain.map.getZoom()], [29.5, -98.4, 12]);
  assert.equal(plain.app.layerRowOn('gauges'), true, 'the stored overlay set comes back');
  assert.equal(plain.app.layerRowOn('inundation'), false, 'including what the reader had switched off');

  const linked = mapCtx();
  linked.sb.location.search = '?mlat=31.2&mlon=-97.1&mz=8';
  try {
    linked.sb.restoreViewFraming(stored(linked.app));
    assert.deepEqual(linked.map._views, [], 'a shared link is an explicit intent and must win over stored state');
    assert.equal(linked.app.layerRowOn('gauges'), false, 'a stored overlay set must not stack on top of a link');
  } finally { linked.sb.location.search = ''; }

  const archive = mapCtx();
  archive.state.pb = { live: false };
  archive.sb.restoreViewFraming(stored(archive.app));
  assert.deepEqual(archive.map._views, [], 'the archive must never be restored into');
  assert.equal(archive.app.layerRowOn('gauges'), false,
    'a stored layer set applied over playback would hide the live board behind archive layers');
});

test('a boot-time restore does not write back over the view it is restoring', () => {
  const { sb, state } = mapCtx();
  const armed = [];
  const clock = sb.setTimeout;
  sb.setTimeout = (f, ms) => { armed.push({ f, ms }); return armed.length; };
  try {
    state.viewReady = false;
    sb.scheduleViewSave();
    assert.deepEqual(armed, [], 'the write-back gate must stay shut until the boot restore has finished');

    state.viewReady = true;
    sb.scheduleViewSave();
    sb.scheduleViewSave();
    sb.scheduleViewSave();
    assert.equal(armed.length, 3, 'each call re-arms');
    assert.equal(sb.localStorage.getItem(VIEW_KEY), null, 'a burst of toggles must coalesce, not write three times');
    armed[armed.length - 1].f();
    assert.ok(storedView(sb), 'the coalesced timer must actually write the view');
  } finally { sb.setTimeout = clock; }
});

test('restoreViewState runs before the URL params are applied', () => {
  /* Source scan, deliberately: this is a statement-ordering fact inside js/boot.js's
     DOMContentLoaded init, which node cannot reach without standing up the whole page. */
  const boot = read('js/boot.js');
  const restoreAt = boot.indexOf('restoreViewState();');
  const shareAt = boot.indexOf('applyShareParams(new URLSearchParams(location.search))');
  const readyAt = boot.indexOf('state.viewReady = true;');
  assert.ok(restoreAt > 0 && shareAt > restoreAt, 'the saved view must be restored before URL params override it');
  assert.ok(readyAt > shareAt, 'the write-back gate must not open until the boot restore is finished');
});

test('a layer toggle or a pan schedules a save, so the kept view cannot go stale', () => {
  const w = loadWiredMap();
  const calls = w.spyOn('scheduleViewSave');
  w.fire('overlayadd', { layer: w.layers.gauges });
  assert.equal(calls.length, 1, 'switching an overlay on must schedule a save');
  w.fire('overlayremove', { layer: w.layers.gauges });
  assert.equal(calls.length, 2, 'switching one off must too');
  w.fire('moveend', {});
  assert.equal(calls.length, 3, 'and a pan, or the kept framing goes stale');
});

test('the area chip is named by a stable id in storage and in a shared link', () => {
  const { app, sb, map } = mapCtx();
  assert.equal(app.AO_FULL_ID, 'full', 'the Full AO pill carries a reserved, language-independent id');
  const restore = withAoPills(app, AO_PILLS);
  try {
    assert.equal(app.aoSelectById('hillcountry', false), true);
    assert.equal(sb.aoPickedId(), 'hillcountry', 'the pick is named by id, not by its translated label');
    assert.deepEqual(map._fits, [], 'a caller with framing of its own must not be re-fitted');
    assert.equal(app.aoSelectById('hillcountry', true), true);
    assert.deepEqual(map._fits, [AO_PILLS[1].bounds], 'a bare ?ao= has no framing to honour, so it fits');

    assert.equal(app.aoSelectById('a-region-since-dropped', false), false,
      'a region dropped from the event config must not throw on the way in');
    assert.equal(sb.aoPickedId(), 'hillcountry', 'and must not clear the pick either');

    assert.equal(new URL(sb.buildShareUrl()).searchParams.get('ao'), 'hillcountry');
    app.aoSelectById(app.AO_FULL_ID, false);
    assert.equal(new URL(sb.buildShareUrl()).searchParams.has('ao'), false,
      'Full AO is the resting pick, so a default link stays short');

    app.applyShareParams(new URLSearchParams('?ao=houston'));
    assert.equal(sb.aoPickedId(), 'houston', 'a shared link names the chip by the same id');
  } finally { restore(); }
});

test('a reset returns the area chip to Full AO and re-frames on the full bounds', () => {
  const { app, sb, map } = mapCtx();
  const restore = withAoPills(app, AO_PILLS);
  try {
    app.aoSelectById('houston', false);
    map._fits.length = 0;
    sb.layerSheetReset();
    assert.equal(sb.aoPickedId(), app.AO_FULL_ID, 'reset must return the area chip to Full AO');
    assert.deepEqual(map._fits, [app.aoFullBounds()],
      'a reset that left a sub-AO framing would be undone by the kept view on the next load');
  } finally { restore(); }
});

/* ---------- 2. the rising-to-major focus ---------- */

// a gauge shaped as the NWPS feed delivers it, forecast above observed so gaugeRising() is true
function risingGauge(lid, name, lat, lon) {
  const ahead = new Date(Date.now() + 6 * 3600e3).toISOString();
  return {
    lid,
    name,
    latitude: lat,
    longitude: lon,
    status: {
      observed: { primary: 12, primaryUnit: 'ft', validTime: new Date().toISOString(), floodCategory: 'action' },
      forecast: { primary: 30, primaryUnit: 'ft', validTime: ahead, floodCategory: 'major' },
    },
  };
}

function tickerCtx() {
  const app = loadApp();
  const sb = app._sandbox;
  Object.assign(app.state, {
    alerts: [], lsrs: [], gauges: [], gaugesDegraded: [], trendHist: {}, records: {},
    seedRequests: [], store: { added: [], overrides: {}, archived: [] },
    map: fakeMap([30, -95.5], 9), gaugeMarkers: {}, inView: false, tickerActs: null,
  });
  return { app, sb, state: app.state };
}

test('the rising-to-major control has a live call site that focuses the rising gauges', () => {
  const { app, sb, state } = tickerCtx();
  state.gauges = [
    risingGauge('AAAT2', 'Guadalupe River at Comfort', 29.97, -98.9),
    risingGauge('BBBT2', 'Llano River near Junction', 30.49, -99.77),
  ];
  assert.equal(app.gaugeRising(state.gauges[0]), true, 'the fixture must actually be rising');

  // focusGauges is a global function declaration, so the ticker's closure resolves to this stub
  const calls = [];
  const real = sb.focusGauges;
  sb.focusGauges = (set, lead) => calls.push({ set, lead });
  try {
    const items = sb.tickerItems();
    const rise = items.filter((i) => typeof i.text === 'string' && i.text.startsWith('▲'));
    assert.equal(rise.length, 2, 'both rising gauges belong on the hazard line');

    rise[0].act();
    assert.equal(calls.length, 1, 'the rising item must call focusGauges, not leave it orphaned');
    assert.deepEqual(calls[0].set.map((g) => g.lid), ['AAAT2', 'BBBT2'],
      'the whole rising set is what is in question, so the whole set is marked');
    assert.equal(calls[0].lead.lid, 'AAAT2', 'the tapped gauge is the one the map frames and the list scrolls to');
  } finally { sb.focusGauges = real; }
});

test('the hazard line publishes its act closures for the delegated handler to read back by index', () => {
  /* renderTicker publishes the acts and boot.js's delegated handler reads them back by index; that
     indirection is what let the previous caller disappear unnoticed, so run both halves. */
  const { sb, state } = tickerCtx();
  state.gauges = [
    risingGauge('AAAT2', 'Guadalupe River at Comfort', 29.97, -98.9),
    risingGauge('BBBT2', 'Llano River near Junction', 30.49, -99.77),
  ];
  const calls = [];
  const real = sb.focusGauges;
  sb.focusGauges = (set, lead) => calls.push({ set, lead });
  try {
    sb.renderTicker();
    const items = sb.tickerItems();
    assert.ok(items.length, 'the fixture must put something on the hazard line');
    assert.equal(state.tickerActs.length, items.length,
      'index n of the rendered line has to be index n of the acts, or a tap dispatches the wrong item');

    const ti = items.findIndex((i) => typeof i.text === 'string' && i.text.startsWith('▲'));
    assert.notEqual(ti, -1, 'the rising item must be on the line');
    state.tickerActs[ti](); // exactly what boot.js does with +it.dataset.ti
    assert.equal(calls.length, 1, 'the published act must reach focusGauges rather than being a dead closure');
    assert.equal(calls[0].lead.lid, 'AAAT2');
  } finally { sb.focusGauges = real; }

  // the delegated read-back itself lives inside boot.js's DOMContentLoaded init: source scan
  assert.match(read('js/boot.js'), /const act = state\.tickerActs\[\+it\.dataset\.ti\];\s*\n\s*if \(act\) act\(\);/);
});

/* A DOM that answers only the selectors it was given a node for. A live stub for every selector is
   what let a missing element pass in v0.99.83, and focusGauges is entirely about which elements it
   found, so an unregistered gauge row or tab button has to come back null. */
function focusCtx() {
  const ctx = tickerCtx();
  const nodes = new Map();
  const node = (sel) => {
    const classes = new Set();
    const el = {
      sel, classes, scrolls: 0, clicks: 0, offsetWidth: 1, style: {},
      classList: {
        add: (c) => classes.add(c), remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c), toggle() {},
      },
      scrollIntoView() { el.scrolls++; }, click() { el.clicks++; },
      addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute: () => null,
    };
    nodes.set(sel, el);
    return el;
  };
  const raw = ctx.sb.document.querySelector.bind(ctx.sb.document);
  const owned = /^#gauge-list |^\.tabs button\[data-tab=/;
  ctx.sb.document.querySelector = (sel) => {
    if (nodes.has(sel)) return nodes.get(sel);
    if (owned.test(sel)) return null; // absent on the page, and the code must cope with that
    return raw(sel);
  };
  const armed = [];
  const clock = ctx.sb.setTimeout;
  ctx.sb.setTimeout = (f, ms) => { armed.push({ f, ms }); return armed.length; };
  // the downstream repaints are a separate surface; what is under test is which nodes were found
  const REPAINT = ['renderRequests', 'renderGaugesTab', 'renderAlertList'];
  const realPaint = REPAINT.map((n) => ctx.sb[n]);
  REPAINT.forEach((n) => { ctx.sb[n] = () => {}; });
  const marker = (lid) => {
    const el = node(`marker:${lid}`);
    ctx.state.gaugeMarkers[lid] = { getElement: () => el };
    return el;
  };
  const row = (lid) => node(`#gauge-list .gauge-card[data-lid="${lid}"]`);
  return { ...ctx, node, marker, row, armed, runTimers: () => { const q = armed.splice(0); q.forEach((x) => x.f()); },
    restore: () => {
      ctx.sb.document.querySelector = raw;
      ctx.sb.setTimeout = clock;
      REPAINT.forEach((n, i) => { ctx.sb[n] = realPaint[i]; });
    } };
}

test('focusGauges frames the tapped gauge, marks the whole set, and opens the Gauges tab', () => {
  const c = focusCtx();
  try {
    const gauges = [
      risingGauge('AAAT2', 'Guadalupe River at Comfort', 29.97, -98.9),
      risingGauge('BBBT2', 'Llano River near Junction', 30.49, -99.77),
    ];
    c.state.gauges = gauges;
    const markers = gauges.map((g) => c.marker(g.lid));
    const rows = gauges.map((g) => c.row(g.lid));
    const tab = c.node('.tabs button[data-tab="tab-gauges"]');

    c.sb.focusGauges(gauges, gauges[1]);

    // the point comes from the sandbox realm, so re-home it before comparing
    assert.deepEqual(c.state.map._views.map(([pt, z]) => [Array.from(pt), z]), [[[30.49, -99.77], 11]],
      'the tapped gauge is what the map frames, at a zoom that actually shows it');
    assert.equal(tab.clicks, 1, 'the set is pulled up in the Gauges tab');

    c.runTimers(); // the pulse and the scroll frame
    for (const m of markers) {
      assert.ok(m.classes.has('gauge-attn'), 'every gauge in the set gets the attention cue');
    }
    assert.equal(rows[1].scrolls, 1, 'the list scrolls to the gauge that was tapped');
    assert.equal(rows[0].scrolls, 0, 'and only to that one');
    for (const r of rows) assert.ok(r.classes.has('flash'), 'the rest of the set still flashes behind it');
  } finally { c.restore(); }
});

test('focusGauges drops the In view scope rather than focusing rows it would hide', () => {
  const c = focusCtx();
  try {
    const g = risingGauge('AAAT2', 'Guadalupe River at Comfort', 29.97, -98.9);
    c.state.gauges = [g];
    c.state.inView = true;
    c.marker('AAAT2');
    c.node('.tabs button[data-tab="tab-gauges"]');
    // no row registered: In view is hiding the very row the focus exists to surface
    c.sb.focusGauges([g], g);
    assert.equal(c.state.inView, false,
      'the In view scope must not hide the rows the focus exists to surface');
  } finally { c.restore(); }
});

test('focusGauges degrades rather than throwing when the gauge layer is off', () => {
  const c = focusCtx();
  try {
    const g = risingGauge('AAAT2', 'Guadalupe River at Comfort', 29.97, -98.9);
    c.state.gauges = [g];
    // no marker, no row, no tab button: nothing the focus wants is on the page
    assert.doesNotThrow(() => c.sb.focusGauges([g], g));
    assert.doesNotThrow(() => c.runTimers());
    assert.doesNotThrow(() => c.sb.focusGauges([], null), 'an empty set is a no-op, not a crash');
  } finally { c.restore(); }
});

test('reduce-motion suppresses the attention animation but keeps the marker identifiable', () => {
  const at = CSS.indexOf('@media (prefers-reduced-motion: reduce) {\n  .brand .sub .live-dot');
  assert.notEqual(at, -1, 'the consolidated reduced-motion block was not found');
  const block = CSS.slice(at, CSS.indexOf('\n}', at));
  assert.ok(block.includes('.gauge-attn::after'),
    'the gauge attention cue loops three times and must stop for a reduce-motion device');
  assert.match(block, /\.gauge-attn::after,[\s\S]{0,400}?animation:\s*none/);
  // unlike the pings, this cue is the only thing marking the gauge, so it must not be hidden as well
  assert.ok(!/\.gauge-attn[^{]*\{[^}]*opacity:\s*0/.test(block),
    'hiding the cue under reduce motion would leave the marked gauges unmarked');
  const base = CSS.slice(CSS.indexOf('.gauge-attn::after {'));
  assert.match(base.slice(0, base.indexOf('}')), /animation: gaugeAttn/, 'the cue must still animate by default');
});

/* ---------- 3. an honest offline save ---------- */

test('an offline save failure surfaces a message instead of reading as complete', () => {
  const { offlineResultText } = loadMapApp();
  const base = { saved: 0, failed: 0, quota: false, jobs: 400, zooms: 3, total: 812 };

  const clean = offlineResultText({ ...base, saved: 400 });
  assert.match(clean, /off\.savedfull/, 'a clean save reports the usual line');

  const partial = offlineResultText({ ...base, saved: 300, failed: 100 });
  assert.match(partial, /off\.partial/, 'a partial save must not read as complete');
  assert.ok(!/off\.savedfull/.test(partial));

  const none = offlineResultText({ ...base, saved: 0, failed: 400 });
  assert.match(none, /off\.failed/, 'a save that fetched nothing must say so');
  assert.ok(!/off\.savedfull/.test(none) && !/off\.partial/.test(none));

  const quota = offlineResultText({ ...base, saved: 120, failed: 0, quota: true });
  assert.match(quota, /off\.quota/, 'a save stopped by full storage must name the reason');
  assert.ok(!/off\.savedfull/.test(quota), 'a quota stop is never a complete save');
});

test('only a clean save is treated as clean', () => {
  const { offlineSaveClean } = loadMapApp();
  assert.equal(offlineSaveClean({ saved: 400, failed: 0, quota: false }), true);
  assert.equal(offlineSaveClean({ saved: 399, failed: 1, quota: false }), false);
  assert.equal(offlineSaveClean({ saved: 0, failed: 0, quota: false }), false);
  assert.equal(offlineSaveClean({ saved: 400, failed: 0, quota: true }), false);
});

/* The save itself, run. Everything below drives the shipped saveViewportOffline /
   refreshOfflineStatus / clearOfflineCache against a tile store and a network that answer the way
   a browser's do. `IDB.mode` is flipped per test rather than rebuilt because OfflineTiles caches
   its database handle for the life of the bundle. */
const LEDGER_KEY = 'respondertx.offline';

const IDB = (() => {
  const rows = new Map();
  const self = { rows, mode: 'ok' };
  const req = (run) => {
    const r = {};
    queueMicrotask(() => {
      try {
        if (self.mode === 'dead') throw new Error('store unreadable');
        r.result = run();
        if (r.onsuccess) r.onsuccess();
      } catch (e) { r.error = e; if (r.onerror) r.onerror(); }
    });
    return r;
  };
  const store = {
    get: (k) => req(() => rows.get(k) || null),
    count: (k) => req(() => (k === undefined ? rows.size : (rows.has(k) ? 1 : 0))),
    put: (v, k) => req(() => {
      if (self.mode === 'full') { const e = new Error('no room'); e.name = 'QuotaExceededError'; throw e; }
      rows.set(k, v);
    }),
    clear: () => req(() => rows.clear()),
  };
  self.open = () => {
    const rq = {
      result: {
        objectStoreNames: { contains: () => true },
        transaction: () => ({ objectStore: () => store }),
      },
    };
    queueMicrotask(() => { if (rq.onsuccess) rq.onsuccess(); });
    return rq;
  };
  return self;
})();

// a node that records what the panel wrote to it, and only for the selectors we hand it
function panelNode(sel) {
  const classes = new Set();
  return { sel, classes, textContent: '', hidden: false, disabled: false, dataset: {},
    classList: {
      add: (c) => classes.add(c), remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c),
    } };
}

function offlineCtx({ span = 2 } = {}) {
  const c = mapCtx();
  c.sb.indexedDB = IDB;
  IDB.rows.clear();
  IDB.mode = 'ok';
  c.sb.localStorage.removeItem(LEDGER_KEY);
  c.state.offDepth = undefined;

  // one basemap tile layer on the map, and a viewport that resolves to span x span tiles per zoom
  const tile = { options: { maxZoom: 19 }, _url: 'https://tiles.test/{z}/{x}/{y}.png',
    offlineKey: (t) => `base|${t.z}/${t.x}/${t.y}` };
  c.map.addLayer(tile);
  c.map.getBounds = () => ({ getNorthWest: () => 'nw', getSouthEast: () => 'se' });
  c.map.project = (corner) => ({ divideBy: () => ({ floor: () => (corner === 'nw' ? { x: 0, y: 0 } : { x: span - 1, y: span - 1 }) }) });

  const nodes = new Map([['#off-status', panelNode('#off-status')], ['#off-clear', panelNode('#off-clear')],
    ['#off-est', panelNode('#off-est')], ['.off-save', panelNode('.off-save')]]);
  const raw = c.sb.document.querySelector.bind(c.sb.document);
  c.sb.document.querySelector = (sel) => (nodes.has(sel) ? nodes.get(sel) : raw(sel));

  const notices = [];
  c.sb.opNotice = (m) => notices.push(m); // js/boot.js supplies this on the real page
  const fetched = [];
  c.sb.fetch = async () => { fetched.push(1); return { ok: true, blob: async () => 'tilebytes' }; };

  return { ...c, tile, notices, fetched, nodes,
    node: (sel) => nodes.get(sel),
    ledger: () => JSON.parse(c.sb.localStorage.getItem(LEDGER_KEY) || 'null'),
    restore: () => { c.sb.document.querySelector = raw; delete c.sb.opNotice; } };
}

test('a clean save reports the whole store and raises no toast', async () => {
  const c = offlineCtx();
  try {
    await c.sb.saveViewportOffline();
    assert.equal(c.fetched.length, 12, 'three zoom levels of a 2x2 viewport');
    assert.equal(IDB.rows.size, 12, 'every fetched tile has to reach the store');
    assert.match(c.node('#off-status').textContent, /off\.savedfull/);
    assert.ok(!c.node('#off-status').classes.has('warn'));
    assert.deepEqual(c.notices, [], 'a clean save must not interrupt the reader');
    assert.equal(c.ledger().n, 12, 'the ledger is the only evidence a later eviction can be measured against');
  } finally { c.restore(); }
});

test('a save the network refused says so on the panel AND reaches the reader off it', async () => {
  const c = offlineCtx();
  try {
    c.sb.fetch = async () => ({ ok: false, blob: async () => 'x' }); // a non-OK response is a failure, not a silent skip
    await c.sb.saveViewportOffline();
    const status = c.node('#off-status');
    assert.match(status.textContent, /off\.failed/, 'a save that fetched nothing must say so');
    assert.ok(!/off\.savedfull/.test(status.textContent));
    assert.ok(status.classes.has('warn'));
    assert.deepEqual(c.notices, [status.textContent],
      'the sheet scrolls and the panel sits well down it, so a failed save has to reach the user another way');
    assert.equal(IDB.rows.size, 0);
  } finally { c.restore(); }
});

test('a partial save never reads as complete', async () => {
  const c = offlineCtx();
  try {
    let n = 0;
    c.sb.fetch = async () => { n++; return { ok: n % 2 === 0, blob: async () => 'tilebytes' }; };
    await c.sb.saveViewportOffline();
    assert.match(c.node('#off-status').textContent, /off\.partial/);
    assert.ok(!/off\.savedfull/.test(c.node('#off-status').textContent));
    assert.equal(c.notices.length, 1, 'a partial save is not clean, so it is announced');
  } finally { c.restore(); }
});

test('a full store stops the run rather than failing every remaining tile', async () => {
  const c = offlineCtx({ span: 6 }); // 108 jobs, so a stop is visible against the total
  try {
    IDB.mode = 'full';
    await c.sb.saveViewportOffline();
    assert.match(c.node('#off-status').textContent, /off\.quota/, 'a save stopped by full storage must name the reason');
    assert.ok(c.fetched.length < 108, `the run kept going to ${c.fetched.length} of 108 tiles after the store was full`);
    assert.equal(c.notices.length, 1);
  } finally { IDB.mode = 'ok'; c.restore(); }
});

test('an empty viewport is refused before anything is downloaded', async () => {
  const c = offlineCtx();
  try {
    c.map.removeLayer(c.tile); // no offline-capable basemap on the map
    await c.sb.saveViewportOffline();
    assert.match(c.node('#off-status').textContent, /off\.nolayer/);
    assert.deepEqual(c.fetched, []);
  } finally { c.restore(); }
});

test('tiles the browser reclaimed are reported rather than assumed present', async () => {
  const c = offlineCtx();
  try {
    IDB.rows.set('base|9/0/0', 'kept');
    IDB.rows.set('base|9/0/1', 'kept');
    c.sb.setOfflineLedger(400); // what the last save left behind
    await c.sb.refreshOfflineStatus();
    const status = c.node('#off-status');
    assert.match(status.textContent, /off\.evicted/, 'a count below the ledger is the only evidence the tiles are gone');
    assert.ok(status.classes.has('warn'));

    IDB.mode = 'dead';
    await c.sb.refreshOfflineStatus();
    assert.match(status.textContent, /off\.unavail/,
      'an unreadable store must not leave a stale saved count on screen');
    assert.ok(status.classes.has('warn'));
  } finally { IDB.mode = 'ok'; c.restore(); }
});

test('a deliberate clear is not an eviction and must not warn about one', async () => {
  const c = offlineCtx();
  try {
    IDB.rows.set('base|9/0/0', 'kept');
    c.sb.setOfflineLedger(400);
    await c.sb.clearOfflineCache();
    assert.equal(IDB.rows.size, 0);
    assert.equal(c.ledger().n, 0, 'the ledger has to come down with the store, or the next status call cries eviction');
    assert.match(c.node('#off-status').textContent, /off\.cleared/);
    assert.ok(!c.node('#off-status').classes.has('warn'));
  } finally { c.restore(); }
});

test('the depth control states its cost, and a smaller depth really downloads less', async () => {
  const { OFFLINE_DEPTHS, OFFLINE_DEPTH_DEFAULT } = loadMapApp();
  assert.deepEqual(Array.from(OFFLINE_DEPTHS), [0, 1, 2]);
  assert.equal(OFFLINE_DEPTH_DEFAULT, 2, 'the shipped default must not grow: a bigger silent download is a regression');

  const c = offlineCtx();
  try {
    const html = c.sb.offlineSheetHtml();
    for (const z of [0, 1, 2]) assert.ok(html.includes(`data-offz="${z}"`), `the depth choice has no control for ${z}`);
    assert.ok(html.includes('class="off-depth-btn on" data-offz="2"'), 'the shipped default must be the one shown selected');
    assert.ok(html.includes('id="off-est"'), 'the cost has to be stated before the download starts');
    assert.ok(html.includes('role="status" aria-live="polite"'), 'the result line must be announced');

    c.sb.refreshOfflineEstimate();
    assert.match(c.node('#off-est').textContent, /off\.est/, 'the estimate line is left blank');

    // the sheet dispatches the depth buttons it just drew
    const click = (sel, dataset) => c.sb.onLayerSheetClick({ target: { closest: (s) => (s === sel ? { dataset } : null) } });
    click('[data-offz]', { offz: '0' });
    assert.equal(c.sb.offlineDepth(), 0, 'the depth button is drawn but never dispatched');
    await c.sb.saveViewportOffline();
    assert.equal(c.fetched.length, 4, 'depth 0 is one zoom level of the 2x2 viewport, not three');

    click('[data-act="off-clear"]', {});
    await new Promise((r) => setImmediate(r));
    assert.equal(IDB.rows.size, 0, 'the sheet must dispatch off-clear');
  } finally { c.restore(); }
});

test('i18n: every offline string the save can show exists in both languages', () => {
  const I18N = require('./i18n-load.js');
  for (const k of ['off.depth', 'off.depth.title', 'off.depth.0', 'off.depth.1', 'off.depth.2',
    'off.est', 'off.nolayer', 'off.partial', 'off.failed', 'off.quota', 'off.evicted', 'off.unavail']) {
    for (const lang of ['en', 'es']) {
      assert.ok(I18N[lang][k], `${lang} is missing ${k}`);
      assert.ok(!I18N[lang][k].includes('—'), `${lang} ${k} uses an em-dash`);
    }
  }
  // the placeholders the result lines are built from have to survive translation
  for (const lang of ['en', 'es']) {
    assert.match(I18N[lang]['off.partial'], /\{n\}[\s\S]*\{m\}[\s\S]*\{f\}/, `${lang} off.partial lost a placeholder`);
    assert.match(I18N[lang]['off.quota'], /\{n\}[\s\S]*\{m\}/, `${lang} off.quota lost a placeholder`);
    assert.match(I18N[lang]['off.evicted'], /\{n\}[\s\S]*\{m\}/, `${lang} off.evicted lost a placeholder`);
  }
});

/* ---------- 4. one deliberate-locate zoom ---------- */

test('both deliberate-locate controls land on the same zoom', () => {
  const { CONFIG } = loadMapApp();
  assert.equal(CONFIG.locateZoom, 14);

  // a literal is how the two drifted apart before: geolocate snapped to 12 and re-center to 14, so
  // ask each control what zoom it actually set rather than reading either of them
  const zoomsFrom = (drive) => {
    const w = loadWiredMap();
    const zooms = [];
    w.map.setView = (latlng, z) => { zooms.push(z); return w.map; };
    w.sandbox.startLocTrack = () => {}; // js/panels.js is not in the map bundle
    w.state.driveRankAt = Date.now();   // the heavy re-rank is throttled and is not what is under test
    drive(w);
    return zooms;
  };

  const located = zoomsFrom((w) => {
    w.state.centerNextFix = true; // the tap on the locate control that this fix answers
    w.fire('locationfound', { latlng: { lat: 30.2, lng: -97.7 }, accuracy: 15 });
  });
  const recentred = zoomsFrom((w) => {
    w.state.myPos = { lat: 30.2, lng: -97.7 };
    w.sandbox.recenterAndFollow();
  });

  assert.deepEqual(located, [CONFIG.locateZoom], 'a deliberate locate must snap to the shared constant');
  assert.deepEqual(recentred, [CONFIG.locateZoom], 'and the re-center control must land on the same one');
});

test('a watch fix does not steal the zoom from under the reader', () => {
  const w = loadWiredMap();
  const zooms = [];
  w.map.setView = (latlng, z) => { zooms.push(z); return w.map; };
  w.sandbox.startLocTrack = () => {};
  w.state.driveRankAt = Date.now();
  w.state.centerNextFix = false; // a background watch tick, not a tap
  w.state.followMe = false;
  w.fire('locationfound', { latlng: { lat: 30.2, lng: -97.7 }, accuracy: 15 });
  assert.deepEqual(zooms, [], 'only a deliberate locate re-frames the map');
});
