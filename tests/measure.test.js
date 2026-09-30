'use strict';

/* The #18 measure tool. These run the shipped inspector card, the map-tap and Escape handlers
   initPointInspector() registers, and the readout bar the tool builds; none read js/board.js. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWiredMap } = require('./harness.js');

const plain = (v) => JSON.parse(JSON.stringify(v)); // arrays built inside the vm fail a cross-realm deepEqual

// a DOM that keeps what the tool builds: the bar, its buttons, their listeners and state
function trackedEl(byId) {
  const kids = new Map();
  const on = new Map();
  const classes = new Set();
  let html = '';
  return {
    id: '', hidden: false, disabled: false, textContent: '',
    classes,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, f) => { const want = f === undefined ? !classes.has(c) : !!f; if (want) classes.add(c); else classes.delete(c); return want; },
    },
    set innerHTML(v) { html = v; kids.clear(); },
    get innerHTML() { return html; },
    querySelector(sel) { if (!kids.has(sel)) kids.set(sel, trackedEl(byId)); return kids.get(sel); },
    addEventListener(type, fn) { on.set(type, fn); },
    click() { const fn = on.get('click'); if (fn) fn({}); },
    appendChild(c) { if (c.id) byId.set(c.id, c); },
  };
}

function armed() {
  const w = loadWiredMap();
  const byId = new Map();
  const doc = w.sandbox.document;
  const mapEl = trackedEl(byId);
  byId.set('map', mapEl);
  doc.getElementById = (id) => byId.get(id) || null;
  doc.createElement = () => trackedEl(byId);
  doc.body = trackedEl(byId);
  // the card's risk read calls into panels.js, which this bundle does not load; it is not under test
  if (typeof w.sandbox.crossingList !== 'function') w.sandbox.crossingList = () => [];
  let closed = 0;
  w.map.closePopup = () => { closed++; return w.map; };
  w.sandbox.initPointInspector();
  const tap = (lat, lng) => w.fire('click', { latlng: { lat, lng } });
  const bar = () => byId.get('measure-bar');
  const read = () => bar().querySelector('.mb-read').textContent;
  return { w, byId, mapEl, tap, bar, read, closed: () => closed };
}

// Leaflet builds the inspector card from inspectContent(); a tap on its button starts the tool
function startFromCard(h, lat, lon) {
  const card = h.w.sandbox.inspectContent(lat, lon);
  assert.match(card.innerHTML, /inspect-measure/, 'the point card offers no way to start measuring');
  card.querySelector('.inspect-measure').click();
}

test('the point card starts a measurement anchored at the pressed point', () => {
  const h = armed();
  startFromCard(h, 30, -98);
  assert.equal(h.closed(), 1, 'the card stays open over the point the user now needs to tap past');
  assert.deepEqual(plain(h.w.state.measure.pts), [[30, -98]]);
  assert.ok(h.mapEl.classes.has('measure-armed'), 'no crosshair: the map gives no sign that a tap now measures');
  assert.equal(h.bar().hidden, false);
  assert.equal(h.read(), '📏 measure.hint');
  assert.equal(h.bar().querySelector('.mb-undo').disabled, true, 'nothing to undo with only the anchor');
});

test('each tap adds a leg; the bar gives the running total and the last leg\'s true bearing', () => {
  const h = armed();
  startFromCard(h, 30, -98);
  h.tap(31, -98); // one degree of latitude: 69.09 mi, due north; ten miles and over reads to a tenth
  assert.equal(h.read(), '📏 measure.total 69.1 risk.mi · N 000° measure.true');

  h.tap(31, -97); // then roughly 59 mi east
  const legs = /^📏 measure\.total ([\d.]+) risk\.mi · measure\.leg ([\d.]+) risk\.mi E (\d{3})° measure\.true$/.exec(h.read());
  assert.ok(legs, `unexpected readout: ${h.read()}`);
  const [, total, leg, deg] = legs;
  assert.ok(Math.abs(Number(leg) - 59.2) < 0.15, `the second leg reads ${leg} mi`);
  assert.ok(Math.abs(Number(total) - (69.093 + Number(leg))) < 0.1, `total ${total} is not the sum of the legs`);
  assert.ok(Number(deg) >= 89 && Number(deg) <= 90, `bearing east reads ${deg}°`);
});

test('a short distance reads in feet, where a mile figure would round everything to nothing', () => {
  const h = armed();
  startFromCard(h, 30, -98);
  h.tap(30.001, -98); // 0.001° of latitude is about 365 ft
  assert.equal(h.read(), '📏 measure.total 365 measure.ft · N 000° measure.true');
});

test('the bar and the map show every point: a dashed route through them and a dot on each', () => {
  const h = armed();
  const drawn = [];
  h.w.state.measureGroup = { clearLayers() { drawn.length = 0; }, addLayer(l) { drawn.push(l); } };
  h.w.sandbox.L = new Proxy({}, {
    get: (_t, kind) => (kind === 'DomEvent' ? { disableClickPropagation() {} } : (...args) => ({ kind, args })),
  });
  startFromCard(h, 30, -98);
  h.tap(31, -98);
  h.tap(31, -97);
  const line = drawn.filter((d) => d.kind === 'polyline');
  assert.equal(line.length, 1);
  assert.deepEqual(plain(line[0].args[0]), [[30, -98], [31, -98], [31, -97]]);
  assert.equal(line[0].args[1].interactive, false, 'the route must not swallow the next tap');
  assert.deepEqual(plain(drawn.filter((d) => d.kind === 'circleMarker').map((d) => d.args[0])), [[30, -98], [31, -98], [31, -97]]);
});

test('Undo drops the last point and Done stops listening to the map', () => {
  const h = armed();
  startFromCard(h, 30, -98);
  h.tap(31, -98);
  h.tap(31, -97);
  h.bar().querySelector('.mb-undo').click();
  assert.deepEqual(plain(h.w.state.measure.pts), [[30, -98], [31, -98]]);
  h.bar().querySelector('.mb-undo').click();
  assert.deepEqual(plain(h.w.state.measure.pts), [[30, -98]]);
  h.bar().querySelector('.mb-undo').click();
  assert.deepEqual(plain(h.w.state.measure.pts), [[30, -98]], 'Undo must never remove the anchor');

  h.bar().querySelector('.mb-done').click();
  assert.equal(h.w.state.measure, null);
  assert.equal(h.bar().hidden, true);
  assert.ok(!h.mapEl.classes.has('measure-armed'));
  h.tap(32, -98);
  assert.equal(h.w.state.measure, null, 'a tap after Done started measuring again');
});

test('Escape ends a measurement', () => {
  const h = armed();
  startFromCard(h, 30, -98);
  const keys = h.w.sandbox.__docHandlers.get('keydown') || [];
  keys.forEach((fn) => fn({ key: 'Escape' }));
  assert.equal(h.w.state.measure, null);
});

test('with the field-report form open, the map tap belongs to the form, not the measurement', () => {
  const h = armed();
  startFromCard(h, 30, -98);
  const raw = h.w.sandbox.document.querySelector;
  h.w.sandbox.document.querySelector = (sel) => (sel === '#new-request-form'
    ? { classList: { contains: (c) => c === 'open' } } : raw(sel));
  h.tap(31, -98);
  assert.deepEqual(plain(h.w.state.measure.pts), [[30, -98]]);
});

test('bearingDeg gives degrees true for the cardinal directions', () => {
  const { sandbox } = loadWiredMap();
  assert.equal(Math.round(sandbox.bearingDeg(30, -98, 31, -98)), 0);
  assert.equal(Math.round(sandbox.bearingDeg(0, 0, 0, 1)), 90);
  assert.equal(Math.round(sandbox.bearingDeg(31, -98, 30, -98)), 180);
  assert.equal(Math.round(sandbox.bearingDeg(0, 1, 0, 0)), 270);
});
