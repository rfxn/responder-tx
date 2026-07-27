'use strict';

/*
 * The hazard line's actions. The owner tapped a Flood Warning in the scrolling line at the top of
 * the board and nothing happened: the alert items were built with an action that only clicked the
 * Alerts tab button, so the map never moved, no polygon was marked, and with three warnings open
 * there was nothing to say which one had been tapped. Every other item type in the same line
 * already framed the thing it named.
 *
 * What is pinned here is the shape of the line's contract rather than one item's wiring: every
 * item the line renders must do something specific with the thing it names, and the alert item and
 * the Alerts-tab card must reach the map through one shared path so they cannot drift apart again.
 * The coverage test is behavioural, not a grep, so an item type added later that ships as a bare
 * tab switch fails without anyone remembering to extend a list.
 *
 * tests/fixtures/alerts-tx-flood-warnings.json is the exact set the owner tapped: the three Texas
 * Flood Warnings active on api.weather.gov at capture time, verbatim, each with a real polygon and
 * its own VTEC ETN so all three survive the lifecycle collapse as three separate items.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./harness.js');

const ROOT = path.join(__dirname, '..');
const app = loadApp();
const SB = app._sandbox;
// TICKER_ACUTE_MAX is a lexical const, so it reaches the tests through the epilogue rather than the
// sandbox global the function declarations land on
const { alertSeverity, alertGeom, alertOpen, alertDedupe, alertVtecKey, hazardGlance, alertCardDiv,
  TICKER_ACUTE_MAX, state } = app;

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'alerts-tx-flood-warnings.json'), 'utf8'));

/* The capture is verbatim, so its declared ends are the ones the office wrote and will fall into the
   past. Only the clock fields are moved forward here; geometry, VTEC and area stay exactly as
   captured, because those are what every assertion below is actually about. */
const AHEAD = new Date(Date.now() + 6 * 3600e3).toISOString();
function live(f) {
  const c = JSON.parse(JSON.stringify(f));
  c._sev = alertSeverity(c.properties);
  if (c.properties.ends) c.properties.ends = AHEAD;
  if (c.properties.expires) c.properties.expires = AHEAD;
  return c;
}
const WARNINGS = FIX.floodWarnings.map(live);

// ---------- a sandbox where every focus primitive is observable ----------

function ctx({ tabsHit = [], rows = new Set() } = {}) {
  const rec = {
    fitBounds: [], setView: [], flash: [], text: [], feed: [], alertsList: [], reveal: [], phone: 0,
    tabs: tabsHit, renders: 0,
  };
  const saved = new Map();
  const stub = (k, v) => { if (!saved.has(k)) saved.set(k, SB[k]); SB[k] = v; };

  Object.assign(state, {
    alerts: [], lsrs: [], gauges: [], gaugesDegraded: [], trendHist: {}, records: {},
    seedRequests: [], store: { added: [], overrides: {}, archived: [] },
    zoneGeomCache: new Map(), gaugeMarkers: {}, inView: false, tickerActs: null,
    showAlertsFar: false, showNormalGauges: true, showDegradedGauges: true,
    map: {
      fitBounds(b, o) { rec.fitBounds.push({ b, o }); return this; },
      setView(c, z) { rec.setView.push({ c, z }); return this; },
      getZoom: () => 9, on() {}, once() {}, off() {}, hasLayer: () => false,
      addLayer() {}, removeLayer() {},
    },
  });

  // real bounds, tagged with the geometry they came from, so an assertion can tell one alert's
  // extent from another's — the exact thing the tapped item failed to convey
  stub('L', { geoJSON: (g) => ({ getBounds: () => ({ isValid: () => true, _geom: g }) }) });
  stub('flashAlert', (f) => rec.flash.push(f));
  stub('openAlertText', (f) => rec.text.push(f));
  stub('openInFeed', (id) => rec.feed.push(id));
  stub('revealMapOnPhone', () => { rec.phone += 1; });
  stub('revealInList', (tab, sel) => rec.reveal.push({ tab, sel }));
  stub('renderAlertList', () => { rec.renders += 1; });
  stub('focusGauges', () => {});
  stub('focusGauge', () => {});

  // a card that remembers its own click handler, so the Alerts-tab surface can actually be fired
  const savedCreate = SB.document.createElement;
  SB.document.createElement = () => {
    const clicks = [];
    return {
      style: {}, dataset: {}, className: '', innerHTML: '', textContent: '', value: '', hidden: false,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild() {}, append() {}, remove() {}, setAttribute() {}, getAttribute: () => '',
      addEventListener(type, fn) { if (type === 'click') clicks.push(fn); },
      removeEventListener() {}, querySelector: () => ({ addEventListener() {} }), querySelectorAll: () => [],
      scrollIntoView() {},
      __click() { for (const fn of clicks) fn({ stopPropagation() {} }); return clicks.length; },
    };
  };

  const inputs = new Map();
  const savedQs = SB.document.querySelector;
  SB.document.querySelector = (sel) => {
    const s = String(sel);
    const tab = /data-tab="([^"]+)"/.exec(s);
    if (tab) return { click: () => rec.tabs.push(tab[1]) };
    if (s.startsWith('#alert-list')) return rows.has(s) ? { scrollIntoView() {} } : null;
    if (!inputs.has(s)) inputs.set(s, { value: '', click() {}, scrollIntoView() {} });
    return inputs.get(s);
  };
  rec.input = (sel) => { if (!inputs.has(sel)) inputs.set(sel, { value: '', click() {}, scrollIntoView() {} }); return inputs.get(sel); };
  rec.restore = () => {
    for (const [k, v] of saved) SB[k] = v;
    SB.document.querySelector = savedQs;
    SB.document.createElement = savedCreate;
  };
  return rec;
}

const withCtx = (opts, fn) => { const c = ctx(opts); try { return fn(c); } finally { c.restore(); } };

// ---------- the fixture is the real thing, and non-vacuous ----------

test('the three captured Texas Flood Warnings are real, mappable and each its own hazard-line item', () => {
  assert.equal(WARNINGS.length, 3, 'the owner tapped three open Flood Warnings; a shrunken set makes every test below weaker');
  for (const f of WARNINGS) {
    assert.equal(f.properties.event, 'Flood Warning');
    assert.equal(f.geometry.type, 'Polygon', `${f.properties.areaDesc} lost its polygon`);
    assert.ok(f.geometry.coordinates[0].length >= 4, 'a polygon with no ring is not a real extent');
    assert.ok(alertGeom(f), 'alertGeom must resolve an extent, or the focus path has nothing to frame');
    assert.equal(alertOpen(f), true, 'an expired fixture would drop out of the line and pass vacuously');
    assert.equal(hazardGlance(f), true, 'a Flood Warning belongs on the glance line');
  }
  assert.equal(new Set(WARNINGS.map(alertVtecKey)).size, 3,
    'three distinct VTEC events, or the line would collapse them to one item and "which one" could not arise');
  assert.equal(alertDedupe(WARNINGS).length, 3);
});

// ---------- the reported bug ----------

test('tapping a Flood Warning in the hazard line frames that warning and flashes it', () => {
  withCtx({}, (c) => {
    state.alerts = WARNINGS;
    const items = SB.tickerAlertItems();
    assert.equal(items.length, 3, 'all three open warnings belong on the line');

    for (let i = 0; i < items.length; i += 1) {
      items[i].act();
      assert.equal(c.fitBounds.length, i + 1, 'the tap must move the map, not only switch tab');
      assert.equal(c.flash.length, i + 1, 'the tap must mark which hazard was tapped');
    }
    // and each tap framed ITS OWN warning: this is what "no indication of which one you tapped" means
    const framed = c.fitBounds.map((x) => x.b._geom);
    const flashed = c.flash.map((f) => f.geometry);
    for (let i = 0; i < 3; i += 1) {
      assert.deepEqual(framed[i], WARNINGS[i].geometry, `item ${i} framed another warning's extent`);
      assert.deepEqual(flashed[i], WARNINGS[i].geometry, `item ${i} flashed another warning`);
      assert.equal(c.fitBounds[i].o.maxZoom, 10, 'the framing must keep the card path’s zoom ceiling');
    }
    assert.equal(new Set(framed.map((g) => JSON.stringify(g))).size, 3,
      'three taps framed fewer than three distinct extents');
    assert.equal(c.text.length, 0, 'a mappable warning is framed, not opened as text');
  });
});

test('a tapped hazard lands the reader on its own card, not at the top of the Alerts tab', () => {
  withCtx({}, (c) => {
    state.alerts = WARNINGS;
    SB.tickerAlertItems()[1].act();
    assert.equal(c.reveal.length, 1, 'the hazard line must reveal the alert it named');
    assert.equal(c.reveal[0].tab, 'tab-alerts');
    assert.ok(c.reveal[0].sel.includes(WARNINGS[1].id),
      `the reveal must target the tapped alert; got ${c.reveal[0].sel}`);
    assert.ok(c.reveal[0].sel.startsWith('#alert-list .alert-card[data-alert-id='),
      'the reveal must address the card by the handle the card actually carries');
    assert.equal(c.phone, 1, 'a phone sheet covering the map must come down, or the framing is invisible');
  });
});

test('the card the hazard line reveals carries the handle the reveal addresses it by', () => {
  const div = alertCardDiv(WARNINGS[0], 12);
  assert.equal(div.dataset.alertId, WARNINGS[0].id,
    'without the handle on the card, the reveal selector matches nothing and the tap lands nowhere');
});

// ---------- the fallbacks that must survive ----------

test('a hazard with no extent to frame opens its readable text instead', () => {
  withCtx({}, (c) => {
    const bare = {
      id: 'urn:oid:no-geometry',
      geometry: null,
      properties: { event: 'Flood Warning', areaDesc: 'Kerr, TX', affectedZones: [], parameters: {}, ends: AHEAD },
    };
    bare._sev = alertSeverity(bare.properties);
    assert.equal(alertGeom(bare), null, 'the fixture must genuinely have no extent, or this passes vacuously');

    state.alerts = [bare];
    const items = SB.tickerAlertItems();
    assert.equal(items.length, 1);
    items[0].act();
    assert.equal(c.text.length, 1, 'no extent must open the alert text, never do nothing');
    assert.equal(c.text[0], bare);
    assert.equal(c.fitBounds.length, 0, 'nothing to frame, so nothing may be framed');
    assert.equal(c.flash.length, 0);
    assert.equal(c.reveal.length, 0, 'the modal is the landing; a list reveal behind it is not');
  });
});

test('an order whose extent is prose keeps its v0.99.57 unmapped state and opens its text', () => {
  const orders = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'alerts-orders.json'), 'utf8'));
  const unmapped = orders.real.concat(orders.shaped)
    .map((f) => Object.assign({}, f, { _sev: alertSeverity(f.properties) }))
    .find((f) => !f.geometry && !(f.properties.affectedZones || []).length);
  assert.ok(unmapped, 'the unmappable-order fixture is missing; the regression it guards is untested');

  // the badge the v0.99.57 card states, unchanged
  assert.match(alertCardDiv(unmapped, NaN).className, /alert-unmapped/);
  withCtx({}, (c) => {
    SB.focusAlert(unmapped, true);
    assert.equal(c.text.length, 1, 'an unmappable order must still open its words');
    assert.equal(c.fitBounds.length, 0, 'the board must never invent an extent it was not given');
  });
});

// ---------- one shared path ----------

test('the hazard line and the Alerts-tab card reach the map through the same focus path', () => {
  withCtx({}, (c) => {
    const saw = [];
    const real = SB.focusAlert;
    SB.focusAlert = (f, reveal) => { saw.push({ f, reveal }); };
    try {
      state.alerts = WARNINGS;
      SB.tickerAlertItems()[0].act();
      alertCardDiv(WARNINGS[0], 12).__click();
    } finally { SB.focusAlert = real; }

    assert.equal(saw.length, 2, 'both surfaces must route through focusAlert; one of them is doing its own thing');
    assert.equal(saw[0].f, WARNINGS[0], 'the hazard line must pass the alert it named');
    assert.equal(saw[1].f, WARNINGS[0], 'the card must pass its own alert');
    assert.equal(saw[0].reveal, true, 'the line starts nowhere near the list, so it reveals the card');
    assert.ok(!saw[1].reveal, 'the card is already on screen and must not scroll itself');
    // nothing was framed or flashed directly: with focusAlert stubbed out, neither caller has a
    // private route to the map, which is what makes the two surfaces impossible to drift apart
    assert.equal(c.fitBounds.length, 0, 'a caller resolved bounds on its own instead of through the shared path');
    assert.equal(c.flash.length, 0, 'a caller flashed on its own instead of through the shared path');
  });
});

test('neither caller re-implements the extent resolution the shared path owns', () => {
  const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const grab = (s, name) => {
    const m = s.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
    assert.ok(m, `${name}() not found`);
    return m[0];
  };
  const board = src('js/board.js');
  const card = grab(src('js/sources.js'), 'alertCardDiv');
  const line = grab(src('js/panels.js'), 'tickerAlertItems');
  for (const [where, body] of [['the Alerts-tab card', card], ['the hazard line', line]]) {
    assert.ok(/focusAlert\(/.test(body), `${where} no longer calls focusAlert`);
    assert.ok(!/L\.geoJSON/.test(body), `${where} resolves its own bounds again; that is how the two drifted`);
    assert.ok(!/fitBounds/.test(body), `${where} moves the map on its own again`);
    assert.ok(!/zoneGeomCache/.test(body), `${where} resolves its own zone fallback again`);
  }
  // and the shared path is the only place that decides, using the same predicate as the unmapped badge
  const focus = grab(board, 'focusAlert');
  assert.ok(/alertGeom\(/.test(focus), 'focusAlert must resolve the extent with alertGeom, the card badge’s predicate');
  assert.ok(/openAlertText\(/.test(focus), 'focusAlert lost the no-extent fallback');
});

// ---------- the class: no ticker item may be a bare tab switch ----------

/* Built behaviourally rather than as a grep so a type added later is covered without anyone
   remembering this file exists: render a line carrying every item type, fire each action with the
   focus primitives observable, and require each to have moved or marked something specific. */
function everyTypeState() {
  const ahead = new Date(Date.now() + 6 * 3600e3).toISOString();
  const rising = (lid, name, lat, lon) => ({
    lid, name, latitude: lat, longitude: lon,
    status: {
      observed: { primary: 12, primaryUnit: 'ft', validTime: new Date().toISOString(), floodCategory: 'action' },
      forecast: { primary: 30, primaryUnit: 'ft', validTime: ahead, floodCategory: 'major' },
    },
  });
  const major = (lid, name, lat, lon) => ({
    lid, name, latitude: lat, longitude: lon,
    status: {
      observed: { primary: 41, primaryUnit: 'ft', validTime: new Date().toISOString(), floodCategory: 'major' },
      forecast: {},
    },
  });
  return {
    alerts: [WARNINGS[0]],
    gauges: [rising('AAAT2', 'Guadalupe River at Comfort', 29.97, -98.9), major('CCCT2', 'San Marcos River at Luling', 29.68, -97.65)],
    lsrs: [{
      geometry: { type: 'Point', coordinates: [-98.5, 29.9] },
      properties: { typetext: 'FLASH FLOOD', city: 'Boerne', valid: new Date().toISOString() },
    }],
    seedRequests: [{
      id: 'req-critical-1', type: 'rescue', priority: 'critical', status: 'open',
      summary: 'Two adults on a roof at Ranch Road 337', ts: new Date().toISOString(), lat: 29.9, lon: -99.1,
    }],
  };
}

test('every item the hazard line renders acts on the thing it names', () => {
  withCtx({}, (c) => {
    Object.assign(state, everyTypeState());
    const gaugeCalls = [];
    const real = { focusGauges: SB.focusGauges, focusGauge: SB.focusGauge };
    SB.focusGauges = (set, lead) => gaugeCalls.push({ fn: 'focusGauges', set, lead });
    SB.focusGauge = (g) => gaugeCalls.push({ fn: 'focusGauge', g });
    try {
      const items = SB.tickerItems();
      // the line must genuinely be carrying every type, or the loop below proves nothing
      assert.ok(items.length >= 5, `the line rendered ${items.length} items; every type must be present`);
      assert.ok(items.length <= TICKER_ACUTE_MAX, 'the fixture must stay under the cap so no type is trimmed away');
      // startsWith, not text[0]: the storm-report and request glyphs are surrogate pairs
      for (const glyph of ['▲', '●', '💧', '🆘']) {
        assert.ok(items.some((i) => i.text.startsWith(glyph)),
          `no ${glyph} item on the line; that type is untested here`);
      }

      for (let i = 0; i < items.length; i += 1) {
        const before = {
          fit: c.fitBounds.length, view: c.setView.length, flash: c.flash.length, text: c.text.length,
          feed: c.feed.length, reveal: c.reveal.length, gauge: gaugeCalls.length,
          phone: c.phone, tabs: c.tabs.length,
        };
        items[i].act();
        const moved = c.fitBounds.length > before.fit || c.setView.length > before.view;
        const acted = moved || c.flash.length > before.flash || c.text.length > before.text
          || c.feed.length > before.feed || c.reveal.length > before.reveal
          || gaugeCalls.length > before.gauge;
        assert.ok(acted,
          `hazard-line item ${i} ("${items[i].text}") does nothing specific with what it names`
          + `${c.tabs.length > before.tabs ? '; it only switches tab, which is the bug this file exists for' : ''}`);
        // an item that moves the map behind a full-height phone sheet has moved nothing the user can see
        if (moved) {
          assert.ok(c.phone > before.phone,
            `hazard-line item ${i} ("${items[i].text}") moves the map without bringing the phone sheet down, so on a phone it reads as doing nothing`);
        }
      }
    } finally { Object.assign(SB, real); }

    // the two gauge types kept the focus they already had
    assert.deepEqual(gaugeCalls.map((x) => x.fn), ['focusGauges', 'focusGauge']);
    assert.equal(gaugeCalls[0].lead.lid, 'AAAT2', 'the rising item still frames the gauge that was tapped');
    assert.equal(gaugeCalls[1].g.lid, 'CCCT2');
    // the storm report and the critical request now land on their own subject
    assert.ok(c.setView.some((v) => v.c[0] === 29.9 && v.c[1] === -98.5), 'the storm report must fly to its own point');
    assert.deepEqual(c.feed, ['req-critical-1'], 'the critical request must land on its own card, not the top of the feed');
  });
});

/* The one deliberate exception, stated so it stays deliberate: the overflow item names a count and
   no single hazard, so the Alerts tab is the only honest destination it has. */
test('the overflow count is the only hazard-line item allowed to be a plain tab switch', () => {
  withCtx({}, (c) => {
    const many = Array.from({ length: TICKER_ACUTE_MAX + 3 }, (_, i) => ({ text: `item ${i}`, act: () => {} }));
    const capped = SB.tickerCap(many, true);
    assert.equal(capped.length, TICKER_ACUTE_MAX, 'the line must still cap to a pass under thirty seconds');
    const last = capped[capped.length - 1];
    assert.notEqual(last, many[TICKER_ACUTE_MAX - 1], 'the final slot must be the overflow item, not a trimmed hazard');
    last.act();
    assert.deepEqual(c.tabs, ['tab-alerts'], 'the overflow item opens the Alerts tab');
    assert.equal(c.fitBounds.length + c.setView.length + c.flash.length, 0,
      'the overflow item names no single hazard, so it must not pretend to frame one');
    // an uncapped line keeps every hazard and adds no tab-switch item at all
    assert.equal(SB.tickerCap(many.slice(0, 3), true).length, 3);
  });
});

// ---------- the reveal must not land on a list that is filtering the alert out ----------

test('revealing a hazard clears only the filters that are hiding it', () => {
  withCtx({}, (c) => {
    const sev = c.input('#flt-alert-sev'), q = c.input('#flt-alert-q');
    sev.value = 'extreme';
    q.value = 'llano';
    state.showAlertsFar = false;
    SB.openInAlertsList(WARNINGS[0]);
    assert.equal(sev.value, '', 'a severity filter hiding the tapped alert must be cleared');
    assert.equal(q.value, '', 'a search hiding the tapped alert must be cleared');
    assert.equal(state.showAlertsFar, true, 'the far fold must open, or the row is still not there');
    assert.equal(c.renders, 1, 'the list must be re-rendered once after the filters change');
    assert.equal(c.reveal.length, 1);
  });

  // and when the row is already on screen, nothing the user set is touched
  const sel = `#alert-list .alert-card[data-alert-id="${WARNINGS[0].id}"]`;
  withCtx({ rows: new Set([sel]) }, (c) => {
    const sev = c.input('#flt-alert-sev');
    sev.value = 'severe';
    state.showAlertsFar = false;
    SB.openInAlertsList(WARNINGS[0]);
    assert.equal(sev.value, 'severe', 'a filter that is not hiding the row must be left alone');
    assert.equal(state.showAlertsFar, false, 'the far fold must be left as the user set it');
    assert.equal(c.renders, 0, 'no filter changed, so no re-render');
    assert.equal(c.reveal.length, 1, 'the row is still revealed');
  });
});
