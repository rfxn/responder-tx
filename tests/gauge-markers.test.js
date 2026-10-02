/* Gauge markers on the live map. In-flood and rising gauges were plain dots and a bare glyph that
   shared hue and scale with road closures and storm reports, so they were lost among them. Every
   test here runs the shipped renderer and reads back what it handed Leaflet. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadMapApp, loadFullApp } = require('./harness.js');

const app = loadMapApp();
const SB = app._sandbox;
const ST = app.state;

const at = (min) => new Date(Date.now() + min * 60000).toISOString();
const NO_FCST = { floodCategory: 'fcst_not_current', primary: -999, primaryUnit: '', validTime: '0001-01-01T00:00:00Z' };

let seq = 0;
function gauge(obsCat, fcstCat, obsAgeMin = 20) {
  seq += 1;
  return {
    lid: `TST${seq}`, name: `Test River at Site ${seq}`, latitude: 30 + seq / 100, longitude: -97,
    status: {
      observed: { floodCategory: obsCat, primary: 12.3, primaryUnit: 'ft', validTime: at(-obsAgeMin) },
      forecast: fcstCat ? { floodCategory: fcstCat, primary: 20.1, primaryUnit: 'ft', validTime: at(360) } : NO_FCST,
    },
  };
}

// renderGauges() against a recording L: one { html, z } per drawn marker, keyed by lid
function drawGauges(gauges, trendHist = {}) {
  const prev = { L: SB.L, layers: ST.layers, gauges: ST.gauges, deg: ST.gaugesDegraded, trend: ST.trendHist };
  const drawn = [];
  try {
    SB.L = {
      divIcon: (o) => ({ html: o.html }),
      marker: (ll, o) => { const m = { lat: ll[0], html: o.icon.html, z: o.zIndexOffset }; m.bindPopup = () => m; return m; },
    };
    ST.layers = Object.assign({}, prev.layers, {
      gauges: { clearLayers() { drawn.length = 0; }, addLayer(m) { drawn.push(m); } },
    });
    const split = SB.splitGauges(gauges);
    ST.gauges = split.live;
    ST.gaugesDegraded = split.degraded;
    ST.trendHist = trendHist;
    SB.renderGauges();
  } finally {
    SB.L = prev.L;
    ST.layers = prev.layers;
    ST.gauges = prev.gauges;
    ST.gaugesDegraded = prev.deg;
    ST.trendHist = prev.trend;
  }
  const out = {};
  for (const g of gauges) out[g.lid] = drawn.find((m) => m.lat === g.latitude);
  return out;
}

test('flood stage outranks ordinary overlays and stays under wildfire, road-flood and YOU', () => {
  const g = { major: gauge('major'), moderate: gauge('moderate'), minor: gauge('minor'), action: gauge('action'), none: gauge('no_flooding') };
  const m = drawGauges(Object.values(g));
  for (const cat of Object.keys(g)) {
    assert.ok(m[g[cat].lid], `the ${cat} gauge was not drawn`);
    assert.match(m[g[cat].lid].html, new RegExp(`class="gauge-icon cat-${cat}"`), `${cat} must carry its category class`);
  }
  const z = (cat) => m[g[cat].lid].z;
  assert.ok(z('major') > z('moderate') && z('moderate') > z('minor') && z('minor') > z('action') && z('action') > z('none'),
    `the ladder must follow severity: ${['major', 'moderate', 'minor', 'action', 'none'].map(z).join(' > ')}`);
  // overlay markers (storm reports, closures, notices, cameras) draw at the default 0
  assert.equal(z('none'), 0, 'a gauge with nothing to report must not be lifted over other layers');
  assert.ok(z('minor') >= 500, `a gauge in flood must clear the overlays in a full viewport, got ${z('minor')}`);
  assert.ok(z('action') < 500, 'action stage is not flood stage and must not be lifted with it');
  assert.ok(z('major') < 1100, 'wildfire and road-flood markers (1100) keep their place above every gauge');
});

test('in-flood markers are full gauge markers, never decluttered as no-flood clutter', () => {
  const minor = gauge('minor');
  const moderate = gauge('moderate');
  const none = gauge('no_flooding');
  const m = drawGauges([minor, moderate, none]);
  for (const g of [minor, moderate]) {
    assert.doesNotMatch(m[g.lid].html, /hit-none/, 'an in-flood gauge must never be hidden on a phone');
    assert.match(m[g.lid].html, /style="--dot:\d+px"/, 'the trend chips are anchored on the dot size');
  }
  assert.match(m[none.lid].html, /class="gauge-hit hit-none"/, 'the control: a quiet gauge stays declutterable');
});

test('a rising gauge carries a triangle chip in its forecast colour and ranks just under that category', () => {
  const floodNow = { moderate: gauge('moderate'), major: gauge('major'), minor: gauge('minor') };
  const toModerate = gauge('no_flooding', 'moderate');
  const toMajor = gauge('minor', 'major');
  const toMinor = gauge('action', 'minor');
  const m = drawGauges([floodNow.moderate, floodNow.major, floodNow.minor, toModerate, toMajor, toMinor]);

  const chip = m[toModerate.lid].html;
  assert.match(chip, /<span class="rise-arrow cat-moderate"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="[^"]+"\/><\/svg><\/span>/,
    'the chip is an outlined SVG triangle keyed to the forecast category, not a bare text glyph');
  assert.doesNotMatch(chip, /▲/);
  assert.match(chip, /class="gauge-hit rising"/, 'the hit carries .rising so state-scale declutter keeps its dot');
  assert.doesNotMatch(chip, /hit-none/, 'a gauge forecast into flood must not be hidden on a phone');
  assert.match(m[toMajor.lid].html, /rise-arrow cat-major/);
  assert.match(m[toMinor.lid].html, /rise-arrow cat-minor/);

  const z = (g) => m[g.lid].z;
  assert.ok(z(toModerate) > z(floodNow.minor) && z(toModerate) < z(floodNow.moderate),
    'heading to moderate outranks minor now and yields to moderate now');
  assert.ok(z(toMajor) > z(floodNow.moderate) && z(toMajor) < z(floodNow.major),
    'heading to major outranks moderate now and yields to major now');
  assert.ok(z(toMinor) < z(floodNow.minor) && z(toMinor) >= 500, 'heading to minor still clears the overlays');
});

test('a dead sensor gets neither a rise chip nor a lift, whatever its forecast says', () => {
  const dead = gauge('major', 'major', 13 * 60);
  const live = gauge('minor', 'major');
  const m = drawGauges([dead, live]);
  assert.match(m[dead.lid].html, /deg-stale/);
  assert.doesNotMatch(m[dead.lid].html, /rise-arrow|cat-major/);
  assert.equal(m[dead.lid].z, 0);
  assert.match(m[live.lid].html, /rise-arrow cat-major/, 'the control: a reporting gauge with the same forecast gets the chip');
});

test('a gauge in flood and observed falling gets the falling chip', () => {
  const g = gauge('moderate');
  const now = Date.now();
  const m = drawGauges([g], { [g.lid]: [[now - 70 * 60000, 14.2], [now - 15 * 60000, 13.1]] });
  assert.match(m[g.lid].html, /<span class="fall-arrow"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="[^"]+"\/><\/svg><\/span>/);
  assert.doesNotMatch(m[g.lid].html, /▼/);
  assert.doesNotMatch(drawGauges([g])[g.lid].html, /fall-arrow/, 'the control: no trend history, no chip');
});

test('the map legend and the glossary show the same trend chips the map draws', () => {
  const legend = SB.mapLegendHtml();
  assert.match(legend, /<span class="rise-arrow cat-moderate"><svg/);
  assert.match(legend, /<span class="fall-arrow"><svg/);
  assert.match(legend, /legend\.rise/);
  for (const cat of ['major', 'moderate', 'minor', 'action']) assert.match(legend, new RegExp(`sw gauge-icon cat-${cat}`));

  const SBF = loadFullApp()._sandbox;
  const body = { innerHTML: '' };
  const prevQs = SBF.document.querySelector;
  SBF.document.querySelector = (sel) => (sel === '#glossary-body' ? body : null);
  try { SBF.renderGlossary(); } finally { SBF.document.querySelector = prevQs; }
  assert.match(body.innerHTML, /<span class="gl-sw"><span class="rise-arrow cat-major"><svg/);
  assert.match(body.innerHTML, /<span class="gl-sw"><span class="fall-arrow"><svg/);
});

test('an open life-safety notice is drawn above every gauge; a routine or resolved one is not', () => {
  const full = loadFullApp(); // renderRequests reaches panels.js for its empty-list branch
  const FSB = full._sandbox;
  const FST = full.state;
  const ts = at(-10);
  const req = (id, type, status) => ({ id, ts, type, priority: 'critical', status, county: 'Harris', place: 'X', lat: 29.7, lon: -95.4, summary: 's' });
  const prev = { L: FSB.L, layers: FST.layers, seed: FST.seedRequests, aged: FST.showAged, store: FST.store };
  const drawn = [];
  try {
    FSB.L = {
      divIcon: (o) => ({ html: o.html }),
      circle: () => ({ bindPopup() { return this; } }),
      marker: (ll, o) => { const m = { html: o.icon.html, z: o.zIndexOffset }; m.bindPopup = () => m; return m; },
    };
    FST.layers = Object.assign({}, prev.layers, { requests: { clearLayers() { drawn.length = 0; }, addLayer(m) { drawn.push(m); } } });
    FST.seedRequests = [req('r1', 'rescue', 'open'), req('r2', 'supplies', 'open'), req('r3', 'medical', 'resolved')];
    FST.showAged = true; // a resolved notice is drawn only with the aged toggle on
    FST.store = { added: [], overrides: {}, archived: [] };
    FSB.renderRequests();
  } finally {
    FSB.L = prev.L;
    FST.layers = prev.layers;
    FST.seedRequests = prev.seed;
    FST.showAged = prev.aged;
    FST.store = prev.store;
  }
  assert.equal(drawn.length, 3, 'all three notices must reach the map, or the comparisons below are vacuous');
  const z = (glyph) => (drawn.find((m) => m.z !== undefined && m.html.includes(glyph)) || {}).z;
  const gaugeMax = Math.max(...Object.values(drawGauges([gauge('major'), gauge('minor', 'major')])).map((m) => m.z));
  assert.ok(z('🆘') > gaugeMax, `an open rescue (${z('🆘')}) must outrank the top gauge (${gaugeMax})`);
  assert.ok(z('🆘') < 2000, 'and stay under the YOU marker');
  assert.equal(z('📦'), 0, 'a routine notice keeps the default order');
  assert.equal(z('⚕️'), 0, 'a resolved notice is not an emergency surface');
});
