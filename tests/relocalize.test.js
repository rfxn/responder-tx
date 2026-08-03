'use strict';

/* A live language switch, and the marker labels that are baked at draw time.
 *
 * relocalizeDynamic() repaints the cards, the legend, the pills and the lens tag, so a responder
 * who switched English to Spanish mid-incident got Spanish panels beside English marker
 * aria-labels: the three marker layers bake esc(t(...)) into a divIcon when they draw, and nothing
 * re-ran them. Popups are lazily built and were always right; only the baked labels went stale.
 *
 * Every assertion here RUNS relocalizeDynamic() and reads the label a screen reader would now get.
 * The safety half matters as much: the three renderers redraw into an existing layer group and add
 * nothing to the map, so a language switch may never turn a layer on or reach the network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFullApp } = require('./harness.js');
const I18N = require('./i18n-load.js');

const app = loadFullApp();
const SB = app._sandbox;
const ST = app.state;

// the layer whose name is baked into each marker, and the i18n key that names it
const LAYER_KEY = {
  wildfire: 'layers.wildfire',
  riverSentry: 'layers.rsentry',
  tideStations: 'layers.tides',
};

/* relocalizeDynamic() repaints fifteen other surfaces that need a live DOM. They are stubbed by
   name so a rename fails loudly here rather than silently skipping the stub; the three marker
   renderers under test stay REAL. */
const QUIET = ['applyTheme', 'renderTiles', 'renderAlertList', 'renderForecastList', 'renderGaugesTab',
  'renderRequests', 'renderResources', 'renderCrossings', 'renderTides', 'renderSourceHealth',
  'renderMovedCues', 'pushRerender', 'renderLayerPills', 'renderDriveMode', 'syncViewsTrigger'];

const NOW = new Date().toISOString();
const SOURCES = [{ key: 'tfs', name: 'Texas A&M Forest Service', status: 'ok', captured: NOW, count: 1 }];
const FIRE = { id: 'tfs:X', src: 'tfs', scope: 'tx', name: 'Point', lat: 31.5, lon: -99.5,
  status: 'Active', acres: 10, contain: null, observed: NOW };
const TOWER = { site: 'Center Point', label: 'Tower 1', lat: 29.9, lon: -98.8 };
const TIDE = { id: '8771013', name: 'Eagle Point', ok: true, obs: 2.1, pred: 1.8, surge: 0.3, dir: 'up',
  t: '2026-08-03T12:00:00Z' };

/* The harness L answers every call with itself, so a divIcon and the marker holding it would be the
   same object and the label would be unreadable. This keeps what each renderer actually built. */
const SHAPES = ['marker', 'divIcon', 'circle', 'polygon'];
function recordingL() {
  const shape = (kind) => (...args) => {
    const o = { kind, args, opts: args[args.length - 1] || {} };
    o.bindPopup = (p) => { o.popup = p; return o; };
    o.addTo = () => o; o.on = () => o; o.setStyle = () => o; o.setLatLng = () => o;
    return o;
  };
  return new Proxy({}, {
    get(_t, prop) {
      if (SHAPES.includes(prop)) return shape(prop);
      return () => ({ bindPopup() { return this; }, addTo() { return this; }, on() { return this; } });
    },
  });
}

const group = () => {
  const drawn = [];
  return { drawn, clearLayers() { drawn.length = 0; }, addLayer(l) { drawn.push(l); } };
};

const iconHtml = (o) => (((o.opts.icon || {}).args || [{}])[0].html || '');
const attrOf = (o, name) => (iconHtml(o).match(new RegExp(`${name}="([^"]*)"`)) || [])[1];
const ariaLabels = (g) => g.drawn.filter((o) => o.kind === 'marker').map((o) => attrOf(o, 'aria-label'));

// the real table, not a fixture: the assertion is about the string a reader actually gets
const speak = (lang) => (k) => (I18N[lang][k] === undefined ? k : I18N[lang][k]);

/* Installs the three layer groups, a map that records what was added to it, fixtures for all three
   sources, and a fetch that logs instead of reaching out. Every mutation is undone by close(). */
function stage() {
  const saved = { L: SB.L, t: SB.t, fetch: SB.fetch, opNotice: SB.opNotice, qs: SB.document.querySelector,
    layers: ST.layers, map: ST.map, wildfire: ST.wildfire, riverSentry: ST.riverSentry,
    tides: ST.tides, tideMeta: ST.tideMeta, tideMetaNoted: ST.tideMetaNoted,
    wildfireLoaded: ST._wildfireLoaded, rsentryLoaded: ST._rsentryLoaded };
  const groups = { wildfire: group(), riverSentry: group(), tideStations: group() };
  const onMap = new Set();
  const notices = [];
  const fetched = [];
  SB.L = recordingL();
  SB.opNotice = (m) => notices.push(m);
  SB.fetch = (u) => { fetched.push(String(u)); return Promise.reject(new Error('network disabled in tests')); };
  ST.layers = Object.assign({}, ST.layers, groups);
  ST.map = { hasLayer: (l) => onMap.has(l), addLayer(l) { onMap.add(l); return this; },
    removeLayer(l) { onMap.delete(l); return this; } };
  ST.wildfire = { generated: NOW, sources: SOURCES, fires: [FIRE], perimeters: [] };
  ST.riverSentry = { towers: [TOWER], sites: [{ site: TOWER.site, towers: 1 }] };
  ST.tides = [TIDE];
  ST.tideMeta = { stations: { [TIDE.id]: { lat: 29.48, lon: -94.92 } } };
  ST.tideMetaNoted = false;
  ST._wildfireLoaded = false;
  ST._rsentryLoaded = false;

  const draw = (lang) => {
    SB.t = speak(lang);
    SB.renderWildfire();
    SB.renderRiverSentry();
    SB.renderTideStations();
  };

  // runs the SHIPPED relocalizeDynamic() with only the unrelated surfaces stubbed out
  const switchTo = (lang, nodes) => {
    const held = {};
    const called = [];
    for (const n of QUIET) {
      if (typeof SB[n] !== 'function') throw new Error(`${n} is not a sandbox function; the stub list has drifted`);
      held[n] = SB[n];
      SB[n] = () => { called.push(n); };
    }
    const prevQs = SB.document.querySelector;
    if (nodes) SB.document.querySelector = (s) => (Object.prototype.hasOwnProperty.call(nodes, s) ? nodes[s] : null);
    SB.t = speak(lang);
    try { SB.relocalizeDynamic(); } finally {
      for (const n of QUIET) SB[n] = held[n];
      SB.document.querySelector = prevQs;
    }
    return called;
  };

  const close = () => {
    SB.L = saved.L; SB.t = saved.t; SB.fetch = saved.fetch; SB.opNotice = saved.opNotice;
    SB.document.querySelector = saved.qs;
    ST.layers = saved.layers; ST.map = saved.map;
    ST.wildfire = saved.wildfire; ST.riverSentry = saved.riverSentry;
    ST.tides = saved.tides; ST.tideMeta = saved.tideMeta; ST.tideMetaNoted = saved.tideMetaNoted;
    ST._wildfireLoaded = saved.wildfireLoaded; ST._rsentryLoaded = saved.rsentryLoaded;
  };

  return { groups, onMap, notices, fetched, draw, switchTo, close };
}

test('a live language switch repaints the marker labels baked into all three layers', () => {
  const s = stage();
  try {
    s.draw('en');
    for (const [layer, key] of Object.entries(LAYER_KEY)) {
      assert.deepEqual(ariaLabels(s.groups[layer]), [I18N.en[key]],
        `${layer} did not draw one marker labelled in English to begin with`);
    }

    s.switchTo('es');

    for (const [layer, key] of Object.entries(LAYER_KEY)) {
      assert.deepEqual(ariaLabels(s.groups[layer]), [I18N.es[key]],
        `a language switch left ${layer} markers labelled in the old language`);
      assert.notEqual(I18N.es[key], I18N.en[key], `${key} is identical in both languages; the check is vacuous`);
    }

    // the hover tooltip is baked from the same string on the two layers that use the layer name
    assert.equal(attrOf(s.groups.wildfire.drawn[0], 'title'), I18N.es['layers.wildfire']);
    assert.equal(attrOf(s.groups.riverSentry.drawn[0], 'title'), I18N.es['layers.rsentry']);
    // the tide marker's title is the station's own name and is not a translatable string
    assert.equal(attrOf(s.groups.tideStations.drawn[0], 'title'), TIDE.name);

    // switching back is the same repaint, not a one-way door
    s.switchTo('en');
    assert.deepEqual(ariaLabels(s.groups.wildfire), [I18N.en['layers.wildfire']]);
  } finally { s.close(); }
});

test('the wildfire marker attribution follows the language too', () => {
  const s = stage();
  try {
    s.draw('en');
    s.switchTo('es');
    const marker = s.groups.wildfire.drawn.find((o) => o.kind === 'marker');
    assert.match(marker.opts.attribution, new RegExp(I18N.es['layers.wildfire']),
      'the map attribution still names the layer in the old language');
  } finally { s.close(); }
});

/* The safety property. Each renderer early-returns without its layer or its data and only ever
   draws into a group it was handed, so calling all three on a language switch must not put a layer
   on the map behind the operator, and must not spend a request. */
test('a language switch leaves a layer that is off exactly as off, and fetches nothing', () => {
  const s = stage();
  try {
    s.draw('en'); // drawn into the groups, but nothing added to the map
    assert.equal(s.onMap.size, 0, 'the fixture must start with every layer off');

    s.switchTo('es');

    assert.equal(s.onMap.size, 0, 'a language switch added a layer to the map');
    for (const layer of Object.keys(LAYER_KEY)) {
      assert.equal(ST.map.hasLayer(s.groups[layer]), false, `${layer} was switched on by a language switch`);
    }
    assert.deepEqual(s.fetched, [], 'a language switch reached the network');
    assert.equal(ST._wildfireLoaded, false, 'a language switch must not consume the wildfire lazy-load latch');
    assert.equal(ST._rsentryLoaded, false, 'a language switch must not consume the river-sentry lazy-load latch');
    assert.deepEqual(s.notices, [], 'a language switch raised an operator notice');
  } finally { s.close(); }
});

test('a language switch on a board where nothing has loaded draws nothing and stays silent', () => {
  const s = stage();
  try {
    ST.wildfire = null;
    ST.riverSentry = null;
    ST.tides = null;

    assert.doesNotThrow(() => s.switchTo('es'), 'the renderers must tolerate a source that never answered');

    for (const layer of Object.keys(LAYER_KEY)) {
      assert.deepEqual(s.groups[layer].drawn, [], `${layer} drew a marker from no data`);
    }
    assert.deepEqual(s.fetched, []);
    assert.equal(s.onMap.size, 0);
  } finally { s.close(); }
});

/* Restored coverage. relocalizeDynamic() ends on markUnknownBadges() because a repaint that lands
   before a source has answered must not leave the shipped zero on screen reading as a measurement.
   renderTiles() calls it too, so it is stubbed above and this asserts relocalizeDynamic's own call. */
test('a live language switch re-asserts the unknown tab badges', () => {
  const s = stage();
  const prev = { alerts: ST.alertsLoadedOnce, seeds: ST.seedsLoadedOnce };
  try {
    const nodes = { '#alerts-count': { textContent: '0' }, '#requests-count': { textContent: '0' } };
    ST.alertsLoadedOnce = false;
    ST.seedsLoadedOnce = false;
    s.switchTo('es', nodes);
    assert.equal(nodes['#alerts-count'].textContent, '?',
      'a language switch republished a zero from a source that never answered');
    assert.equal(nodes['#requests-count'].textContent, '?');

    nodes['#alerts-count'].textContent = '0';
    ST.alertsLoadedOnce = true;
    s.switchTo('en', nodes);
    assert.equal(nodes['#alerts-count'].textContent, '0',
      'once alerts have loaded, a measured zero must survive a language switch');
  } finally { s.close(); Object.assign(ST, { alertsLoadedOnce: prev.alerts, seedsLoadedOnce: prev.seeds }); }
});

// the lens tag is localized text, so the docked-view trigger has to re-sync with everything else
test('a live language switch re-syncs the views trigger', () => {
  const s = stage();
  try {
    assert.ok(s.switchTo('es').includes('syncViewsTrigger'),
      'relocalizeDynamic() must re-sync the lens trigger');
  } finally { s.close(); }
});
