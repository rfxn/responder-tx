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
const { loadApp, loadMapApp } = require('./harness.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const MAP = read('js/map.js');
const BOARD = read('js/board.js');
const PANELS = read('js/panels.js');
const CORE = read('js/core.js');
const CSS = read('css/app.css');

const fn = (src, name) => {
  const m = src.match(new RegExp(`(async )?function ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name}() not found`);
  return m[0];
};

/* ---------- 1. the kept view ---------- */

// a Leaflet-shaped double: enough map for applyLayerState/mapFrame to be exercised for real
function fakeMap(center, zoom) {
  const on = new Set();
  return {
    _on: on,
    hasLayer: (l) => on.has(l),
    addLayer(l) { on.add(l); },
    removeLayer(l) { on.delete(l); },
    getCenter: () => ({ lat: center[0], lng: center[1] }),
    getZoom: () => zoom,
    setView(c, z) { center = [c[0], c[1]]; zoom = z; return this; },
    fitBounds() { return this; },
    on() {}, once() {}, off() {},
  };
}

// stand in for a registered overlay: addTo(map) is how every real caller switches one on
const fakeLayer = (map) => ({ addTo(m) { (m || map).addLayer(this); return this; } });

function mapCtx() {
  const app = loadMapApp();
  const sb = app._sandbox;
  const map = fakeMap([30.0, -95.5], 9);
  Object.assign(app.state, { map, layers: {}, pb: null, lsBulk: false, viewReady: true });
  // the sheet rows are the vocabulary; give every one of them a layer so layerRowOn is truthful
  for (const k of app.layerRowKeys()) app.state.layers[k] = fakeLayer(map);
  app.state.layers.radar = fakeLayer(map);
  app.state.layers.fcstRadar = fakeLayer(map);
  sb.renderLayerPills = () => {}; // real ones reach for the sheet DOM and are not what is under test
  sb.layerSheetSync = () => {};
  return { app, sb, map, state: app.state };
}

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

test('saveViewState carries the layer set, framing and area chip forward while playback is engaged', () => {
  const src = fn(BOARD, 'saveViewState');
  assert.match(src, /ls \? ls\.on : prev\.ly/, 'a null snapshot must fall back to the last real one');
  assert.match(src, /ls \? ls\.known : prev\.lyk/);
  assert.match(src, /frame \? frame\[0\] : prev\.mlat/, 'the framing must survive a playback-time save too');
  const frame = fn(BOARD, 'mapFrame');
  assert.match(frame, /pbBlocksLive\(state\)/, 'the archive framing is not the user framing');
});

test('a link overrides the kept framing and layer set; a plain load restores it', () => {
  const src = fn(BOARD, 'restoreViewFraming');
  assert.match(src, /linkOwnsView\(new URLSearchParams\(location\.search\)\)/,
    'a shared link is an explicit intent and must win over stored state');
  assert.match(src, /pbBlocksLive\(state\)/, 'the archive must never be restored into');

  const { linkOwnsView } = loadApp();
  assert.equal(linkOwnsView(new URLSearchParams('')), false, 'a plain load restores the kept view');
  for (const q of ['?tab=gauges', '?ft=rescue', '?hydro=BTVT2', '?cam=abc']) {
    assert.equal(linkOwnsView(new URLSearchParams(q)), false,
      `${q} names one control or one record and must not cost the reader their kept view`);
  }
  for (const q of ['?mlat=30.1&mlon=-95.4&mz=11', '?usgs=1', '?camreg=all', '?ao=houston', '?rain=1h']) {
    assert.equal(linkOwnsView(new URLSearchParams(q)), true, `${q} is a shared framing and must win`);
  }
  // every layer param a share link can emit has to be listed, or the link stacks on top of the kept set
  const emitted = [...fn(BOARD, 'buildShareUrl').matchAll(/\['([a-z]+)', '[A-Za-z]+'\]/g)].map((m) => m[1]);
  assert.ok(emitted.length >= 5, `expected buildShareUrl to emit layer params, found ${emitted.length}`);
  for (const k of emitted) {
    assert.ok(loadApp().LINK_VIEW_PARAMS.includes(k), `buildShareUrl emits ?${k}= but the kept view does not stand down for it`);
  }
});

test('restoreViewState runs before the URL params are applied, and only real taps write back', () => {
  const boot = read('js/boot.js');
  const restoreAt = boot.indexOf('restoreViewState();');
  const shareAt = boot.indexOf('applyShareParams(new URLSearchParams(location.search))');
  const readyAt = boot.indexOf('state.viewReady = true;');
  assert.ok(restoreAt > 0 && shareAt > restoreAt, 'the saved view must be restored before URL params override it');
  assert.ok(readyAt > shareAt, 'the write-back gate must not open until the boot restore is finished');
  assert.match(fn(BOARD, 'scheduleViewSave'), /if \(!state\.viewReady\) return;/,
    'a boot-time restore must not write back over what it is restoring');
});

test('the map publishes layer and framing changes to the view saver', () => {
  const src = fn(MAP, 'initLayerSheet');
  assert.match(src, /overlayadd overlayremove moveend[\s\S]{0,140}scheduleViewSave/,
    'a layer toggle or a pan must schedule a save, or the kept view goes stale');
});

test('the area chip is named by a stable id in storage and in a shared link', () => {
  assert.match(CORE, /const AO_FULL_ID = 'full';/);
  assert.match(fn(MAP, 'aoSelectById'), /aoCtl\.presets\.find\(\(x\) => x\[2\] === id\)/);
  assert.match(fn(MAP, 'aoSelectById'), /if \(!p\) return false;/, 'a region dropped from the config must not throw');
  assert.match(fn(BOARD, 'buildShareUrl'), /ao !== AO_FULL_ID\) p\.set\('ao', ao\)/);
  assert.match(fn(BOARD, 'applyShareParams'), /aoSelectById\(q\.get\('ao'\), !framed\)/);
});

test('a reset clears the kept view rather than being undone by it on the next load', () => {
  const src = fn(MAP, 'layerSheetReset');
  assert.match(src, /aoSelectById\(AO_FULL_ID, false\)/, 'reset must return the area chip to Full AO');
  // reset toggles real layers and re-frames the map, and both of those are what schedule the save
  assert.match(src, /fitBounds\(aoFullBounds\(\)\)/);
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
  sb.focusGauges = (set, lead) => calls.push({ set, lead });

  const items = sb.tickerItems();
  const rise = items.filter((i) => typeof i.text === 'string' && i.text.startsWith('▲'));
  assert.equal(rise.length, 2, 'both rising gauges belong on the hazard line');

  rise[0].act();
  assert.equal(calls.length, 1, 'the rising item must call focusGauges, not leave it orphaned');
  assert.deepEqual(calls[0].set.map((g) => g.lid), ['AAAT2', 'BBBT2'],
    'the whole rising set is what is in question, so the whole set is marked');
  assert.equal(calls[0].lead.lid, 'AAAT2', 'the tapped gauge is the one the map frames and the list scrolls to');
});

test('the hazard line dispatches the act closures it was rendered with', () => {
  // renderTicker publishes the acts and the delegated handler reads them back by index; that
  // indirection is what let the previous caller disappear unnoticed, so pin both halves
  assert.match(fn(PANELS, 'renderTicker'), /state\.tickerActs = items\.map\(\(i\) => i\.act\)/);
  assert.match(read('js/boot.js'), /const act = state\.tickerActs\[\+it\.dataset\.ti\];\s*\n\s*if \(act\) act\(\);/);
  // and the definition is not the only occurrence any more
  const sites = BOARD.concat(PANELS).match(/focusGauges\(/g) || [];
  assert.ok(sites.length >= 2, `focusGauges has ${sites.length} occurrence(s); it needs a caller as well as a definition`);
});

test('focusGauges frames the tapped gauge, marks the whole set, and opens the Gauges tab', () => {
  const src = fn(BOARD, 'focusGauges');
  assert.match(src, /function focusGauges\(gauges, lead\)/);
  assert.match(src, /setView\(leadPt \|\| pts\[0\], Math\.max\(state\.map\.getZoom\(\), 11\)/,
    'the tapped gauge is framed at a zoom that actually shows it');
  assert.match(src, /el\.classList\.add\('gauge-attn'\)/, 'every gauge in the set gets the attention cue');
  assert.match(src, /\.tabs button\[data-tab="tab-gauges"\]/, 'and the set is pulled up in the Gauges tab');
  assert.match(src, /setInView\(false\)/, 'the In view scope must not hide the rows the focus exists to surface');
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

test('only a clean save is treated as clean, and a failed one raises a toast', () => {
  const { offlineSaveClean } = loadMapApp();
  assert.equal(offlineSaveClean({ saved: 400, failed: 0, quota: false }), true);
  assert.equal(offlineSaveClean({ saved: 399, failed: 1, quota: false }), false);
  assert.equal(offlineSaveClean({ saved: 0, failed: 0, quota: false }), false);
  assert.equal(offlineSaveClean({ saved: 400, failed: 0, quota: true }), false);

  const src = fn(MAP, 'saveViewportOffline');
  assert.match(src, /if \(!clean && typeof opNotice === 'function'\) opNotice\(text\);/,
    'the panel scrolls out of sight, so a failed save has to reach the user another way');
  assert.match(src, /if \(!r\.ok\) failed\+\+;/, 'a non-OK response is a failure, not a silent skip');
  assert.match(src, /quota\/i\.test\(String\(e\.name \|\| e\)\)/, 'a full store is its own outcome');
  assert.match(src, /while \(idx < jobs\.length && !quota\)/, 'a full store stops the run rather than failing every remaining tile');
});

test('tiles the browser reclaimed are reported rather than assumed present', () => {
  const src = fn(MAP, 'refreshOfflineStatus');
  assert.match(src, /led && n < led\.n/, 'a count below the ledger is an eviction and must be stated');
  assert.match(src, /t\('off\.evicted'\)/);
  assert.match(src, /t\('off\.unavail'\)/, 'an unreadable store must not leave a stale saved count on screen');
  assert.match(fn(MAP, 'clearOfflineCache'), /setOfflineLedger\(0\)/,
    'a deliberate clear is not an eviction and must not warn about one');
});

test('the offline save is finer-grained without downloading more by default', () => {
  assert.match(MAP, /const OFFLINE_DEPTHS = \[0, 1, 2\];/);
  assert.match(MAP, /const OFFLINE_DEPTH_DEFAULT = 2;/, 'the shipped default must not grow: a bigger silent download is a regression');
  const sheet = fn(MAP, 'offlineSheetHtml');
  assert.match(sheet, /data-offz="\$\{z\}"/, 'the depth choice needs a control');
  assert.match(sheet, /id="off-est"/, 'the cost has to be stated before the download starts');
  assert.match(sheet, /role="status" aria-live="polite"/, 'the result line must be announced');
  assert.match(fn(MAP, 'onLayerSheetClick'), /setOfflineDepth\(parseInt\(offz\.dataset\.offz, 10\)\)/);
  assert.match(fn(MAP, 'refreshOfflineEstimate'), /t\('off\.est'\)/);
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

test('both deliberate-locate controls agree on one zoom, taken from one constant', () => {
  assert.match(CORE, /locateZoom: 14,/);
  const uses = MAP.match(/Math\.max\(state\.map\.getZoom\(\), CONFIG\.locateZoom\)/g) || [];
  assert.equal(uses.length, 2, 'the locate handler and the re-center control are the two sites, and both read the constant');
  // a literal here is how the two drifted apart before: geolocate snapped to 12, re-center to 14
  assert.ok(!/state\.centerNextFix[^\n]*getZoom\(\), 1[0-9]\)/.test(MAP),
    'a deliberate locate must not carry its own zoom literal');
  assert.match(fn(MAP, 'recenterAndFollow'), /CONFIG\.locateZoom/);
});
