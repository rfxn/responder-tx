'use strict';

/* Coastal water levels (NOAA CO-OPS): the quiet fold and the list-to-map focus.

   The fold is the part that can hurt. A station that could not be read and a station reporting
   observations with no prediction are both UNKNOWN, and folding either one away under a heading
   that says "steady" would publish a failed read as a reassuring value. Every assertion here runs
   the shipped renderer or predicate; none of them matches the text of a js file. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, loadMapApp, loadWiredMap, buildSandbox } = require('./harness.js');

// the harness t() echoes its key, so anything asserted on interpolated user text overrides it
const EN = require('./i18n-load.js').en;
const enT = (k) => (EN[k] === undefined ? k : EN[k]);
// arrays the shipped code builds live in the vm realm, so they are copied before deepEqual
const plain = (a) => Array.from(a, (x) => (Array.isArray(x) ? Array.from(x) : x));

const app = loadApp();
const { tideQuiet, tideBand, tideSplit, TIDE_NEUTRAL_FT, TIDE_BAND_COLOR, tideSurgeColor } = app;

const ROOT = path.join(__dirname, '..');

const row = (o) => Object.assign({
  id: '8770822', name: 'Texas Point', ok: true, obs: 2.4, pred: 2.2, surge: 0.2, dir: 'steady', t: '2026-08-03 09:30',
}, o);

/* ---------- the quiet rule ---------- */

test('quiet is the existing neutral band plus a steady trend, and nothing else', () => {
  assert.equal(TIDE_NEUTRAL_FT, 0.5, 'the fold must reuse the band the card already colours by');
  assert.equal(tideQuiet(row({ surge: 0 })), true);
  assert.equal(tideQuiet(row({ surge: 0.49 })), true);
  assert.equal(tideQuiet(row({ surge: -0.49 })), true);
  assert.equal(tideQuiet(row({ surge: 0.5 })), false, 'the moderate edge is not calm');
  assert.equal(tideQuiet(row({ surge: -0.5 })), false, 'the below-predicted edge is not calm');
  assert.equal(tideQuiet(row({ surge: 1.8 })), false);
  assert.equal(tideQuiet(row({ surge: 0.1, dir: 'up' })), false, 'rising inside the band is still moving');
  assert.equal(tideQuiet(row({ surge: 0.1, dir: 'down' })), false);
});

test('a station that could not be read is unknown, never quiet', () => {
  assert.equal(tideQuiet({ id: '1', name: 'Down', ok: false }), false);
  // the shape fetchTideStation returns on failure carries no surge at all, but a stale one must not save it either
  assert.equal(tideQuiet({ id: '1', name: 'Down', ok: false, surge: 0, dir: 'steady' }), false);
  assert.equal(tideBand({ id: '1', name: 'Down', ok: false, surge: 0 }), 'unknown');
});

test('a station with no prediction to subtract is unknown, never quiet', () => {
  assert.equal(tideQuiet(row({ surge: null, pred: null })), false, 'obs only is not a measured residual');
  assert.equal(tideQuiet(row({ surge: undefined })), false);
  assert.equal(tideQuiet(row({ surge: NaN })), false);
  assert.equal(tideBand(row({ surge: null })), 'unknown');
});

test('the split keeps every station: what is not quiet is shown', () => {
  const rows = [
    row({ id: 'a', surge: 2.1 }), row({ id: 'b', surge: 0.1 }), row({ id: 'c', ok: false }),
    row({ id: 'd', surge: null }), row({ id: 'e', surge: -0.2, dir: 'up' }), row({ id: 'f', surge: -0.05 }),
  ];
  const { loud, quiet } = tideSplit(rows);
  assert.deepEqual(plain(loud).map((r) => r.id), ['a', 'c', 'd', 'e']);
  assert.deepEqual(plain(quiet).map((r) => r.id), ['b', 'f']);
  assert.equal(loud.length + quiet.length, rows.length, 'the fold hides, it never drops');
  const empty = tideSplit(null);
  assert.deepEqual([plain(empty.loud), plain(empty.quiet)], [[], []]);
});

/* One band, two consumers: the colour the card paints and the set the fold hides are derived from
   the same threshold, so a change to one cannot silently disagree with the other. */
test('every station the fold calls quiet is a station the card paints neutral, and no other', () => {
  for (let s = -3; s <= 3.0001; s += 0.05) {
    const surge = Math.round(s * 100) / 100;
    for (const dir of ['up', 'down', 'steady']) {
      const r = row({ surge, dir });
      const neutral = tideSurgeColor(r) === TIDE_BAND_COLOR.steady;
      assert.equal(tideQuiet(r), neutral && dir === 'steady', `surge ${surge} dir ${dir}`);
      if (tideQuiet(r)) assert.equal(tideSurgeColor(r), TIDE_BAND_COLOR.steady, `surge ${surge} folded but not painted neutral`);
    }
  }
  assert.equal(tideSurgeColor(row({ ok: false })), TIDE_BAND_COLOR.unknown);
  assert.equal(tideSurgeColor(row({ surge: null })), TIDE_BAND_COLOR.unknown);
});

/* ---------- the card, rendered ---------- */

// the whole page's scripts, in index.html order, in one context: i18n.js is loaded, so t() really
// interpolates and the assertions below read the strings a user would
function loadPage() {
  const shell = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const files = [...shell.matchAll(/<script src="(js\/[^"?]+)\?v=[^"]+"><\/script>/g)]
    .map((m) => m[1]).filter((f) => !f.startsWith('js/vendor/'));
  const sandbox = buildSandbox();
  const ctx = vm.createContext(sandbox);
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  return { ctx, sandbox };
}

function elStub() {
  const attrs = new Map();
  return {
    innerHTML: '', hidden: false, dataset: {}, style: {}, value: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    scrollIntoView() {}, focus() {}, closest() { return null },
  };
}

/* A DOM that answers only what renderTides actually put on the page. The fold control resolves to
   null unless this render emitted it, so a test cannot tap a button the card withheld. */
function mountCard(page, rows) {
  const body = elStub();
  const taps = { toggle: null, quiet: null, focus: {} };
  const toggle = elStub();
  toggle.addEventListener = (_e, fn) => { taps.toggle = fn; };
  const quiet = elStub();
  quiet.addEventListener = (_e, fn) => { taps.quiet = fn; };
  body.querySelectorAll = (sel) => {
    if (sel !== '.tide-focus') return [];
    return [...String(body.innerHTML).matchAll(/data-tide-id="([^"]+)"/g)].map(([, id]) => ({
      dataset: { tideId: id },
      addEventListener: (_e, fn) => { taps.focus[id] = fn; },
    }));
  };
  const doc = page.sandbox.document;
  doc.querySelector = (sel) => {
    if (sel === '#tides-body') return body;
    if (sel === '#tides-toggle') return toggle;
    if (sel === '#tides-quiet-toggle') return /id="tides-quiet-toggle"/.test(body.innerHTML) ? quiet : null;
    return null;
  };
  doc.getElementById = (id) => doc.querySelector(`#${id}`);
  doc.querySelectorAll = () => [];
  const CONFIG = vm.runInContext('CONFIG', page.ctx);
  const state = vm.runInContext('state', page.ctx);
  CONFIG.tideStations = rows.map((r) => ({ id: r.id, name: r.name }));
  state.tides = rows;
  state.tidesAt = Date.now();
  return { body, taps, state, CONFIG, render: () => page.ctx.renderTides() };
}

const META = (ids) => ({
  generated: '2026-08-03T15:50:13Z',
  source: { name: 'NOAA CO-OPS station metadata (MDAPI)', url: 'https://api.tidesandcurrents.noaa.gov/' },
  stations: Object.fromEntries(ids.map((id, i) => [id, { lat: 29 + i * 0.1, lon: -95 - i * 0.1, name: `S${id}` }])),
});

const CALM = [
  row({ id: 'q1', name: 'Calm One', surge: 0.1 }),
  row({ id: 'q2', name: 'Calm Two', surge: -0.2 }),
  row({ id: 'q3', name: 'Calm Three', surge: 0 }),
];

test('the calm stations fold away by default, and the card says how many and why', () => {
  const page = loadPage();
  const rows = CALM.concat([row({ id: 'hot', name: 'Surging Bay', surge: 1.9, dir: 'up' })]);
  const card = mountCard(page, rows);
  card.state.tideMeta = META(rows.map((r) => r.id));
  card.render();

  assert.match(card.body.innerHTML, /Surging Bay/, 'a station worth reading is never folded');
  for (const name of ['Calm One', 'Calm Two', 'Calm Three']) {
    assert.ok(!card.body.innerHTML.includes(name), `${name} is calm and must fold away`);
  }
  assert.match(card.body.innerHTML, /3 stations steady within half a foot of the predicted tide/);
  assert.match(card.body.innerHTML, /aria-expanded="false"/);
});

test('the hidden count reads correctly at one', () => {
  const page = loadPage();
  const rows = [row({ id: 'q1', name: 'Calm One', surge: 0.1 }), row({ id: 'hot', name: 'Surging Bay', surge: 1.9, dir: 'up' })];
  const card = mountCard(page, rows);
  card.state.tideMeta = META(rows.map((r) => r.id));
  card.render();
  assert.match(card.body.innerHTML, /1 station steady within half a foot of the predicted tide/);
  assert.ok(!/1 stations steady/.test(card.body.innerHTML), 'a count of one must not read as a plural');
});

test('an unreadable station and a station with no prediction are never folded as calm', () => {
  const page = loadPage();
  const rows = CALM.concat([
    row({ id: 'dead', name: 'Silent Pass', ok: false }),
    row({ id: 'nopred', name: 'No Forecast Point', surge: null, pred: null }),
  ]);
  const card = mountCard(page, rows);
  card.state.tideMeta = META(rows.map((r) => r.id));
  card.render();

  assert.match(card.body.innerHTML, /Silent Pass/, 'a failed read is unknown, not calm');
  assert.match(card.body.innerHTML, /No Forecast Point/, 'no residual is known, so it cannot be called calm');
  assert.match(card.body.innerHTML, /unavailable/);
  assert.match(card.body.innerHTML, /obs only/);
  assert.match(card.body.innerHTML, /3 stations steady/, 'only the three genuinely calm ones are counted as hidden');
});

test('the live count is over every configured station, not the visible subset', () => {
  const page = loadPage();
  const rows = CALM.concat([row({ id: 'dead', name: 'Silent Pass', ok: false }), row({ id: 'hot', name: 'Surging Bay', surge: 1.9, dir: 'up' })]);
  const card = mountCard(page, rows);
  card.state.tideMeta = META(rows.map((r) => r.id));
  card.render();
  assert.match(card.body.innerHTML, /4 of 5 live/, 'the fold hides rows; it must not shrink the honesty line');
});

test('tapping the fold shows the calm stations and the choice survives the next render', () => {
  const page = loadPage();
  const rows = CALM.concat([row({ id: 'hot', name: 'Surging Bay', surge: 1.9, dir: 'up' })]);
  const card = mountCard(page, rows);
  card.state.tideMeta = META(rows.map((r) => r.id));
  card.render();
  assert.ok(card.taps.quiet, 'the fold registered no click handler');

  card.taps.quiet();
  assert.match(card.body.innerHTML, /Calm One/);
  assert.match(card.body.innerHTML, /aria-expanded="true"/);
  assert.equal(page.sandbox.localStorage.getItem('respondertx.tidesQuiet'), '1');

  card.render();
  assert.match(card.body.innerHTML, /Calm Two/, 'the shown state is persisted, not per render');

  card.taps.quiet();
  assert.ok(!card.body.innerHTML.includes('Calm Two'), 'a second tap folds them away again');
  assert.equal(page.sandbox.localStorage.getItem('respondertx.tidesQuiet'), '0');
});

/* ---------- the click focuses the map ---------- */

function focusRig(page, rows, meta) {
  const card = mountCard(page, rows);
  card.state.tideMeta = meta;
  const views = [];
  const added = [];
  const layer = { __name: 'tideStations', clearLayers() {}, addLayer(l) { added.push(l); }, addTo(m) { m.addLayer(layer); return layer; } };
  const on = new Set();
  card.state.layers = { tideStations: layer };
  card.state.map = {
    setView(ll, z) { views.push({ ll, z }); return this; },
    getZoom() { return 7; },
    hasLayer(l) { return on.has(l); },
    addLayer(l) { on.add(l); return this; },
    removeLayer(l) { on.delete(l); return this; },
  };
  const opened = [];
  page.sandbox.L = {
    divIcon: (o) => ({ __icon: o }),
    marker: (ll, opts) => {
      const m = { __ll: ll, opts, popup: null, bindPopup(p) { m.popup = p; return m; }, openPopup() { opened.push(m); return m; } };
      return m;
    },
  };
  card.render();
  return { card, views, added, opened, on, layer };
}

test('tapping a station name frames that station, turns the layer on and opens its reading', () => {
  const page = loadPage();
  const rows = [row({ id: 'a', name: 'Alpha Pass', surge: 1.4, dir: 'up' }), row({ id: 'b', name: 'Bravo Point', surge: 0.9, dir: 'up' })];
  const meta = { stations: { a: { lat: 29.1, lon: -94.9 }, b: { lat: 26.5, lon: -97.2 } } };
  const rig = focusRig(page, rows, meta);

  assert.deepEqual(Object.keys(rig.card.taps.focus).sort(), ['a', 'b'], 'both names are real controls');
  assert.equal(rig.on.has(rig.layer), false, 'the coastal layer ships off');

  rig.card.taps.focus.b();
  assert.equal(rig.on.has(rig.layer), true, 'a tap turns the station layer on');
  assert.deepEqual(plain(rig.views.map((v) => Array.from(v.ll))), [[26.5, -97.2]], 'the map framed the station that was tapped');
  assert.ok(rig.views[0].z >= 11, `zoomed to ${rig.views[0].z}, too far out to read a station`);
  assert.equal(rig.opened.length, 1, 'the reading opens with it');
  assert.deepEqual(Array.from(rig.opened[0].__ll), [26.5, -97.2], 'the popup that opened belongs to the station tapped');

  rig.card.taps.focus.a();
  assert.deepEqual(plain(rig.views.map((v) => Array.from(v.ll))), [[26.5, -97.2], [29.1, -94.9]]);
  assert.deepEqual(Array.from(rig.opened[1].__ll), [29.1, -94.9]);
});

test('a station with no cached coordinate offers no control at all', () => {
  const page = loadPage();
  const rows = [row({ id: 'known', name: 'Mapped Pass', surge: 1.4, dir: 'up' }), row({ id: 'orphan', name: 'Unmapped Pass', surge: 1.2, dir: 'up' })];
  const rig = focusRig(page, rows, { stations: { known: { lat: 29.1, lon: -94.9 } } });

  assert.match(rig.card.body.innerHTML, /Unmapped Pass/, 'the reading is still published');
  assert.deepEqual(Object.keys(rig.card.taps.focus), ['known'], 'only the mapped station is tappable');
  assert.ok(!/data-tide-id="orphan"/.test(rig.card.body.innerHTML), 'no dead control for a station with no coordinate');
  assert.ok(!/<button[^>]*>Unmapped Pass/.test(rig.card.body.innerHTML), 'the unmapped name renders as plain text');
  assert.equal(page.ctx.focusTideStation('orphan'), false, 'and asking for it directly moves nothing');
  assert.equal(rig.views.length, 0);
});

test('with no coordinate cache at all, every station reads normally and none is tappable', () => {
  const page = loadPage();
  const rows = [row({ id: 'a', name: 'Alpha Pass', surge: 1.4, dir: 'up' }), row({ id: 'hot', name: 'Surging Bay', surge: 1.9, dir: 'up' })];
  const rig = focusRig(page, rows, null);
  assert.match(rig.card.body.innerHTML, /Alpha Pass/);
  assert.match(rig.card.body.innerHTML, /Surging Bay/);
  assert.deepEqual(Object.keys(rig.card.taps.focus), []);
  assert.ok(!/tide-focus/.test(rig.card.body.innerHTML));
  assert.equal(page.ctx.focusTideStation('a'), false);
});

/* ---------- the map layer ---------- */

const mapApp = loadMapApp();

function drawTides(rows, meta) {
  const MS = mapApp.state;
  const MSB = mapApp._sandbox;
  const prev = { layers: MS.layers, L: MSB.L, t: MSB.t, tides: MS.tides, meta: MS.tideMeta, map: MS.map, noted: MS.tideMetaNoted };
  const drawn = [];
  const said = [];
  const layer = { clearLayers() { drawn.length = 0; }, addLayer(l) { drawn.push(l); } };
  try {
    MSB.L = {
      divIcon: (o) => ({ __icon: o }),
      marker: (ll, opts) => {
        const m = { kind: 'marker', ll, opts, popup: null, bindPopup(p) { m.popup = typeof p === 'function' ? p() : p; return m; } };
        return m;
      },
    };
    MSB.opNotice = (msg) => said.push(msg); // js/boot.js supplies this on the real page
    MSB.t = enT;
    MS.layers = Object.assign({}, MS.layers, { tideStations: layer });
    MS.map = { hasLayer: () => true };
    MS.tides = rows;
    MS.tideMeta = meta;
    MS.tideMetaNoted = false;
    MSB.renderTideStations();
    return { drawn, said, markers: mapApp.state.tideMarkers };
  } finally {
    Object.assign(MS, { layers: prev.layers, tides: prev.tides, tideMeta: prev.meta, map: prev.map, tideMetaNoted: prev.noted });
    MSB.L = prev.L;
    MSB.t = prev.t;
  }
}

test('the layer draws one marker per station that has a coordinate, and skips the rest', () => {
  const rows = [row({ id: 'a', name: 'Alpha' }), row({ id: 'b', name: 'Bravo' }), row({ id: 'no', name: 'Orphan' })];
  const out = drawTides(rows, { stations: { a: { lat: 29, lon: -95 }, b: { lat: 27, lon: -97 } } });
  assert.equal(out.drawn.length, 2);
  assert.deepEqual(plain(out.drawn.map((m) => Array.from(m.ll))), [[29, -95], [27, -97]]);
  assert.deepEqual(Object.keys(out.markers).sort(), ['a', 'b']);
  assert.equal(out.said.length, 0);
});

test('the popup carries the reading, the residual, the trend, the time and the CO-OPS citation', () => {
  const rows = [row({ id: 'a', name: 'Alpha Pass', obs: 3.42, surge: 1.6, dir: 'up', t: '2026-08-03 14:30' })];
  const popup = drawTides(rows, { stations: { a: { lat: 29, lon: -95 } } }).drawn[0].popup;
  assert.match(popup, /Alpha Pass/);
  assert.match(popup, /3\.42 ft/, 'the observed level');
  assert.match(popup, /\+1\.6 ft/, 'the surge residual, signed');
  assert.match(popup, /rising/, 'the trend direction');
  assert.match(popup, /as of 14:30 CT/, 'the as-of time');
  assert.match(popup, /tidesandcurrents\.noaa\.gov/, 'the operator of the station is credited with a live link');
  assert.match(popup, /NOAA CO-OPS/, 'the citation names the operator');
});

test('an unreadable station never gets a number in its popup', () => {
  const rows = [{ id: 'a', name: 'Silent Pass', ok: false }];
  const popup = drawTides(rows, { stations: { a: { lat: 29, lon: -95 } } }).drawn[0].popup;
  assert.match(popup, /Silent Pass/);
  assert.match(popup, /unavailable/);
  assert.ok(!/ ft/.test(popup), 'a failed read must not publish a level');
  assert.match(popup, /tidesandcurrents\.noaa\.gov/, 'the citation is not conditional on the reading');
});

test('a station reporting observations with no prediction says so instead of a residual', () => {
  const rows = [row({ id: 'a', name: 'Alpha Pass', surge: null, pred: null })];
  const popup = drawTides(rows, { stations: { a: { lat: 29, lon: -95 } } }).drawn[0].popup;
  assert.match(popup, /obs only/);
  for (const word of ['rising', 'falling', 'steady']) {
    assert.ok(!popup.includes(word), `no residual means no trend claim about one, saw "${word}"`);
  }
});

test('the marker band follows the reading, and an unreadable station is drawn as unknown', () => {
  const iconOf = (r) => drawTides([r], { stations: { [r.id]: { lat: 29, lon: -95 } } }).drawn[0].opts.icon.__icon.html;
  assert.match(iconOf(row({ id: 'a', surge: 2.0 })), /tide-major/);
  assert.match(iconOf(row({ id: 'a', surge: 0.7 })), /tide-moderate/);
  assert.match(iconOf(row({ id: 'a', surge: -0.9 })), /tide-below/);
  assert.match(iconOf(row({ id: 'a', surge: 0.1 })), /tide-steady/);
  assert.match(iconOf(row({ id: 'a', surge: null })), /tide-unknown/);
  assert.match(iconOf({ id: 'a', name: 'Down', ok: false }), /tide-unknown/);
});

test('a coordinate cache that would not load says so rather than showing an empty coast', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b' })];
  const out = drawTides(rows, null);
  assert.equal(out.drawn.length, 0);
  assert.deepEqual(plain(out.said), [EN['note.tidemeta']], 'an empty layer with stations to draw is a failure, not a quiet coast');
});

/* ---------- the wiring ---------- */

test('the station layer is registered, ships off, and loads the readings when it is turned on', () => {
  const wired = loadWiredMap();
  const layer = wired.layers.tideStations;
  assert.ok(layer, 'initMap() registered no tideStations layer');
  assert.equal(wired.map.hasLayer(layer), false, 'a coastal-only layer must ship off');
  const calls = wired.spyOn('loadTides');
  wired.fire('overlayadd', { layer });
  assert.deepEqual(calls.names(), ['loadTides'], 'turning the layer on must fetch the readings');
});

test('the layer sheet and the pill row both name the coastal layer', () => {
  // both tables are lexical consts, so they are read out of the realm that declared them
  const flat = [].concat(...vm.runInContext('SHEET_GROUPS', mapApp._sandbox).map(([, rs]) => Array.from(rs)));
  const hit = Array.from(flat.find((r) => r[0] === 'tideStations') || []);
  assert.ok(hit.length, 'the coastal layer has no row in the layer sheet');
  assert.equal(hit[2], 'layers.tides');
  assert.equal(hit[3], 'sheet.s.tides');
  assert.equal(hit[4], 'official', 'NOAA operates these stations');
  assert.equal(hit[5], false, 'off by default');
  const pills = Array.from(vm.runInContext('PILL_LAYERS', mapApp._sandbox), (p) => Array.from(p));
  assert.ok(pills.some(([k, key]) => k === 'tideStations' && key === 'layers.tides'),
    'an active coastal layer must name itself in the pill row');
  assert.ok(mapApp.layerRowKeys().includes('tideStations'), 'a saved view must be able to restore it');
  assert.ok(app.LINK_VIEW_PARAMS.includes('tide'), 'a link carrying ?tide= must win over the kept layer set');
});

/* ---------- the coastal water hero card (v0.99.99) ----------

   The readings sit inside the shelters sheet, so during a landfall the board holds a measured
   surge nobody can find. The card is threat-gated so it costs nothing on a dry day, and every
   assertion below CALLS heroCards() rather than matching the text of panels.js. */

const APPSB = app._sandbox;
const HERO_T = {
  'hero.tide': 'Coastal water',
  'hero.tide.sub': 'stations above predicted tide',
  'hero.tide.worst': 'highest {name}, {ft} ft above predicted',
  'hero.unknown': 'source unavailable',
};

const openAlert = (event) => ({
  properties: { event, ends: new Date(Date.now() + 6 * 3600000).toISOString() },
});

// run the shipped heroCards() against a given alert set and tide payload, then put the state back
function tideCard(alerts, tides) {
  const st = app.state;
  const saved = { alerts: st.alerts, tides: st.tides, t: APPSB.t };
  try {
    st.alerts = alerts;
    st.tides = tides;
    APPSB.t = (k) => (k in HERO_T ? HERO_T[k] : k);
    return app.heroCards().find((c) => c.key === 'tide') || null;
  } finally { st.alerts = saved.alerts; st.tides = saved.tides; APPSB.t = saved.t; }
}

const SURGE_ROWS = [
  row({ id: '8770520', name: 'Rainbow Bridge', surge: 2.1, dir: 'up' }),
  row({ id: '8770475', name: 'Port Arthur', surge: 0.8, dir: 'up' }),
  row({ id: '8770822', name: 'Texas Point', surge: 0.1, dir: 'steady' }),
];

test('a surge warning brings up the coastal card and names the worst station', () => {
  const c = tideCard([openAlert('Storm Surge Warning')], SURGE_ROWS);
  assert.ok(c, 'a live surge warning must earn a hero slot');
  assert.equal(c.n, 2, 'the count is the stations at or above the moderate band, and only those');
  assert.equal(c.sub, 'highest Rainbow Bridge, 2.1 ft above predicted',
    'the card must name the station and its measured residual, not a category');
  assert.equal(c.tone, 'major', 'a station past the major band sets the tone');
  assert.equal(typeof c.act, 'function', 'the card must reach the surface holding the readings');
});

/* The card advertises a number that lives in one host. Sending the reader anywhere else is the
   defect this test exists for: the first cut opened the shelters sheet, which does not hold it. */
test('the card lands the reader on the host that holds the readings', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const bodies = [...html.matchAll(/<div class="tab-body" id="(tab-[a-z]+)"[^>]*>([\s\S]*?)<\/div>\s*(?=<div class="tab-body"|<\/)/g)];
  const owner = bodies.find(([, , inner]) => inner.includes('id="tides-body"'))
    || bodies.find((m) => m[0].includes('id="tides-body"'));
  assert.ok(owner, '#tides-body is not inside a tab body; the card has no tab to open');
  const tab = owner[1];
  const c = tideCard([openAlert('Storm Surge Warning')], SURGE_ROWS);
  const clicked = [];
  const savedDoc = APPSB.document;
  // heroCards() resolves `document` inside the vm realm, so the stub has to replace that one
  APPSB.document = {
    querySelector: (sel) => ({ click: () => clicked.push(sel) }),
    getElementById: () => null,
  };
  try { c.act(); } finally { APPSB.document = savedDoc; }
  assert.deepEqual(clicked, [`.tabs button[data-tab="${tab}"]`],
    `the card must open ${tab}, the tab that actually contains #tides-body`);
});

test('a coastal flood product counts as the threat, an inland tropical one does not', () => {
  for (const ev of ['Storm Surge Warning', 'Storm Surge Watch', 'Coastal Flood Warning',
    'Coastal Flood Watch', 'Coastal Flood Advisory']) {
    assert.ok(tideCard([openAlert(ev)], SURGE_ROWS), `${ev} names coastal water`);
  }
  for (const ev of ['Tropical Storm Warning', 'Hurricane Warning', 'Flood Watch', 'Wind Advisory']) {
    assert.equal(tideCard([openAlert(ev)], SURGE_ROWS), null,
      `${ev} reaches far inland, where there is no station and no surge to report`);
  }
});

test('with no coastal threat the card stays out of the row entirely', () => {
  assert.equal(tideCard([], SURGE_ROWS), null, 'a quiet coast earns no permanent zero beside five flood counts');
  const expired = { properties: { event: 'Storm Surge Warning', ends: new Date(Date.now() - 7200000).toISOString() } };
  assert.equal(tideCard([expired], SURGE_ROWS), null, 'an expired warning is not a live threat');
});

/* The E1 case: an unreadable feed must never render as flat water. */
test('nothing readable is an unknown coast, never a calm one', () => {
  for (const payload of [null, [], [{ id: '1', name: 'Down', ok: false }],
    [row({ surge: null })], [row({ surge: NaN })]]) {
    const c = tideCard([openAlert('Storm Surge Warning')], payload);
    assert.ok(c, 'the threat is live, so the card must still take its slot');
    assert.equal(c.n, null, 'an unreadable coast must show ? rather than 0');
    assert.equal(c.sub, 'source unavailable', 'and must say so instead of reporting flat water');
    assert.equal(c.tone, 'ok', 'an unknown coast must not paint itself as a measured emergency');
  }
});

test('a readable coast that is genuinely calm reports zero, which is a measurement', () => {
  const calm = [row({ surge: 0.1, dir: 'steady' }), row({ id: '2', name: 'Port Arthur', surge: -0.2 })];
  const c = tideCard([openAlert('Coastal Flood Warning')], calm);
  assert.equal(c.n, 0, 'stations that read fine and sit below the band are a real zero');
  assert.equal(c.sub, 'stations above predicted tide', 'a genuine zero is not the unknown line');
  assert.equal(c.tone, 'ok');
});

test('an unreadable station never dilutes the count of the ones that read', () => {
  const mixed = SURGE_ROWS.concat([{ id: '9', name: 'Offline', ok: false }, row({ id: '8', name: 'NoPred', surge: null })]);
  const c = tideCard([openAlert('Storm Surge Warning')], mixed);
  assert.equal(c.n, 2, 'the count is over stations that reported a residual');
  assert.equal(c.sub, 'highest Rainbow Bridge, 2.1 ft above predicted');
});

test('a moderate coast is warned, not majored', () => {
  const c = tideCard([openAlert('Storm Surge Warning')], [row({ name: 'Port Arthur', surge: 0.9 })]);
  assert.equal(c.tone, 'warn', 'below the major band the card must not borrow the major tone');
  assert.equal(c.n, 1);
});

/* ---------- the load that feeds it ---------- */

// runs fn with the auto-load path isolated: a station list configured and loadTides counted
function withAutoLoad(fn) {
  const st = app.state;
  const saved = { alerts: st.alerts, tides: st.tides, at: st.tidesAutoAt, loading: st.tidesLoading,
    stations: app.CONFIG.tideStations, load: APPSB.loadTides };
  const calls = [];
  app.CONFIG.tideStations = [{ id: '8770475', name: 'Port Arthur' }];
  APPSB.loadTides = () => { calls.push(1); return Promise.resolve(); }; // never sets state.tides
  st.tidesAutoAt = 0; st.tidesLoading = false; st.tides = null;
  try { return fn(st, calls); } finally {
    APPSB.loadTides = saved.load; app.CONFIG.tideStations = saved.stations;
    st.alerts = saved.alerts; st.tides = saved.tides; st.tidesAutoAt = saved.at; st.tidesLoading = saved.loading;
  }
}

test('the alerts poll loads the readings while a coastal product is live', () => {
  withAutoLoad((st, calls) => {
    st.alerts = [openAlert('Flood Watch')];
    APPSB.maybeAutoTides();
    assert.equal(calls.length, 0, 'no coastal product means no CO-OPS traffic at all');
    st.alerts = [openAlert('Storm Surge Warning')];
    APPSB.maybeAutoTides();
    assert.equal(calls.length, 1, 'a live surge warning must fetch the readings');
    APPSB.maybeAutoTides();
    assert.equal(calls.length, 1, 'and must not refetch on the very next poll');
    st.tidesAutoAt = Date.now() - 6 * 60000;
    APPSB.maybeAutoTides();
    assert.equal(calls.length, 2, 'but must refresh once the interval is up, so the card cannot go stale');
  });
});

/* Two CO-OPS requests per station, and a null payload is the shape a total outage leaves behind.
   Without the stamp-before-call the retry rides the alerts poll instead of the interval. */
test('a feed that answers nothing retries on the interval rather than on every poll', () => {
  withAutoLoad((st, calls) => {
    st.alerts = [openAlert('Storm Surge Warning')];
    for (let i = 0; i < 5; i++) APPSB.maybeAutoTides();
    assert.equal(calls.length, 1, 'a null payload must not turn every alerts poll into 60+ CO-OPS requests');
  });
});

test('an inland event with no stations configured never touches CO-OPS', () => {
  withAutoLoad((st, calls) => {
    app.CONFIG.tideStations = [];
    st.alerts = [openAlert('Storm Surge Warning')];
    APPSB.maybeAutoTides();
    assert.equal(calls.length, 0, 'no configured station means there is nothing to ask for');
  });
});

test('a fetch already in flight is not raced by the next poll', () => {
  withAutoLoad((st, calls) => {
    st.alerts = [openAlert('Storm Surge Warning')];
    st.tidesLoading = true;
    APPSB.maybeAutoTides();
    assert.equal(calls.length, 0, 'the in-flight guard must hold');
  });
});

test('both locales carry every key the card can render', () => {
  const ES = require('./i18n-load.js').es;
  for (const k of ['hero.tide', 'hero.tide.sub', 'hero.tide.worst']) {
    assert.ok(EN[k], `${k} missing from en`);
    assert.ok(ES[k], `${k} missing from es`);
    assert.equal(/[—]/.test(EN[k] + ES[k]), false, `${k} must not carry an em-dash`);
  }
  assert.ok(EN['hero.tide.worst'].includes('{name}') && EN['hero.tide.worst'].includes('{ft}'));
  assert.ok(ES['hero.tide.worst'].includes('{name}') && ES['hero.tide.worst'].includes('{ft}'));
});
