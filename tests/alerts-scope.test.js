'use strict';

/* The Alerts tab used to test every alert against CONFIG.gaugeBbox, which the standing Texas AO
   made the whole state: the "elsewhere" fold could never fire and the tab had no proximity
   affordance at all, while quietState() asked for a statewide all-clear before it would say a
   local one. These pin the replacement: near leads, far folds, nothing is ever dropped, and the
   quiet line can only claim the area it actually read. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, loadWiredMap } = require('./harness.js');
const I18N = require('./i18n-load.js');

const {
  geoBounds, geoDistMi, geoInView, geomInScope, ptInScope, alertGeom, alertNearPoint,
  alertScope, alertScopeSrc, alertNear, alertGroups, alertDistChip, alertAreaPlaces, alertDistPts,
  ALERT_NEAR_MI, quietState, quietGauges, feedCalmOk, xstatusAutoOn, distMi, esc,
  state, _sandbox: sandbox,
} = loadApp();

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// a square alert footprint centred on a point, roughly 0.2 deg on a side
function boxAlert(id, lat, lon, sev = 'warning', sent = '2026-07-26T10:00:00Z') {
  return {
    id,
    _sev: sev,
    geometry: { type: 'Polygon', coordinates: [[[lon - 0.1, lat - 0.1], [lon + 0.1, lat - 0.1], [lon + 0.1, lat + 0.1], [lon - 0.1, lat + 0.1], [lon - 0.1, lat - 0.1]]] },
    properties: { event: 'Flood Warning', areaDesc: id, sent },
  };
}
const zoneAlert = (id, sev = 'warning') => ({ id, _sev: sev, geometry: null, properties: { event: 'Flood Warning', areaDesc: id, affectedZones: ['https://api.weather.gov/zones/county/TXC001'] } });

const AUSTIN = [30.27, -97.74];
const AUSTIN_POS = { lat: AUSTIN[0], lng: AUSTIN[1] };
const EL_PASO = [31.76, -106.49];
const ids = (rows) => rows.map((r) => r.f.id);
// sandbox values carry the vm realm's prototypes, so structural comparison goes through JSON
const plain = (v) => JSON.parse(JSON.stringify(v));

function withState(patch, fn) {
  const keys = Object.keys(patch);
  const saved = {};
  for (const k of keys) saved[k] = state[k];
  Object.assign(state, patch);
  try { return fn(); } finally { Object.assign(state, saved); }
}

/* The harness echoes translation keys back, so an assertion on rendered copy would match the key
   itself. These swap in the shipped table, so what is asserted is the sentence a reader sees. */
function withCopy(lang, fn) {
  const prev = sandbox.t;
  sandbox.t = (k) => (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k;
  try { return fn(); } finally { sandbox.t = prev; }
}

/* A DOM that records rather than absorbs. Two deliberate refusals keep it from proving nothing:
   document.querySelector answers only selectors the test registered, and an element answers a
   child query only when its own markup carries that class. A mock that always answers is how a
   missing element passes. */
function makeNode() {
  const kids = [];
  const clicks = [];
  const node = {
    kids,
    style: {}, dataset: {}, options: [], className: '', textContent: '', innerHTML: '', value: '',
    title: '', hidden: false, checked: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { kids.push(c); return c; },
    append() {}, prepend() {}, remove() {}, insertAdjacentHTML() {},
    setAttribute() {}, getAttribute() { return ''; }, removeAttribute() {},
    addEventListener(type, fn) { if (type === 'click') clicks.push(fn); },
    removeEventListener() {}, dispatchEvent() { return true; },
    querySelector(sel) {
      const token = String(sel).replace(/^[.#]/, '');
      return node.innerHTML.includes(token) ? makeNode() : null;
    },
    querySelectorAll() { return []; },
    closest() { return null; }, scrollIntoView() {}, focus() {},
    click() { for (const fn of clicks) fn({ stopPropagation() {} }); return clicks.length; },
  };
  return node;
}

function withDom(selectors, fn) {
  const doc = sandbox.document;
  const savedQuery = doc.querySelector;
  const savedCreate = doc.createElement;
  const nodes = new Map(selectors.map((s) => [s, makeNode()]));
  const missed = [];
  doc.querySelector = (sel) => {
    const s = String(sel);
    if (nodes.has(s)) return nodes.get(s);
    missed.push(s);
    return null;
  };
  doc.createElement = () => makeNode();
  try { return fn({ node: (s) => nodes.get(s), missed }); } finally {
    doc.querySelector = savedQuery;
    doc.createElement = savedCreate;
  }
}

const ALERT_LIST_SELECTORS = ['#alert-list', '#flt-alert-sev', '#flt-alert-q', '#flt-alert-inview', '#alerts-count'];
const cardIds = (listNode) => listNode.kids.filter((k) => String(k.className).includes('alert-card'))
  .map((k) => k.dataset.alertId);

/* ---------- geoBounds: the scope math runs without Leaflet, so it is testable and map-free ---------- */

test('geoBounds — walks polygons, multi-geometry and collections; empty input is null', () => {
  assert.deepEqual(plain(geoBounds({ type: 'Polygon', coordinates: [[[-97, 30], [-96, 30], [-96, 31], [-97, 31], [-97, 30]]] })),
    { n: 31, s: 30, e: -96, w: -97 });
  assert.deepEqual(plain(geoBounds({ type: 'Point', coordinates: [-97.74, 30.27] })), { n: 30.27, s: 30.27, e: -97.74, w: -97.74 });
  assert.deepEqual(plain(geoBounds({
    type: 'MultiPolygon',
    coordinates: [[[[-97, 30], [-96, 30], [-96, 31], [-97, 30]]], [[[-95, 29], [-94, 29], [-94, 30], [-95, 29]]]],
  })), { n: 31, s: 29, e: -94, w: -97 });
  assert.deepEqual(plain(geoBounds({
    type: 'GeometryCollection',
    geometries: [{ type: 'Point', coordinates: [-97, 30] }, { type: 'Point', coordinates: [-95, 32] }],
  })), { n: 32, s: 30, e: -95, w: -97 });
  assert.equal(geoBounds(null), null);
  assert.equal(geoBounds({ type: 'Polygon', coordinates: [] }), null);
  assert.equal(geoBounds({ type: 'GeometryCollection', geometries: [] }), null);
});

test('geoDistMi — zero inside the footprint, real miles outside, NaN with nothing to measure', () => {
  const geom = boxAlert('a', ...AUSTIN).geometry;
  assert.equal(geoDistMi(geom, [AUSTIN]), 0);
  const far = geoDistMi(geom, [EL_PASO]);
  assert.ok(far > 400 && far < 700, `expected a few hundred miles, got ${far}`);
  // nearest of several points wins
  assert.equal(geoDistMi(geom, [EL_PASO, AUSTIN]), 0);
  assert.ok(Number.isNaN(geoDistMi(null, [AUSTIN])), 'no footprint is not a distance');
  assert.ok(Number.isNaN(geoDistMi(geom, null)), 'no origin is not a distance');
  assert.ok(Number.isNaN(geoDistMi(geom, [])), 'an empty origin list is not a distance');
});

test('geoInView / geomInScope — an unscoped or unplaceable item is never ruled out', () => {
  const geom = boxAlert('a', ...AUSTIN).geometry;
  assert.equal(geoInView(geom, { s: 30, w: -98, n: 31, e: -97 }), true);
  assert.equal(geoInView(geom, { s: 25, w: -100, n: 26, e: -99 }), false);
  assert.equal(geomInScope(geom, null), true, 'no scope means everything stays in the lead group');
  assert.equal(geomInScope(null, { src: 'me', pts: [AUSTIN] }), true, 'no footprint cannot be ruled out');
  assert.equal(ptInScope(NaN, NaN, { src: 'me', pts: [AUSTIN] }), true, 'a point with no coordinates cannot be ruled out');
  assert.equal(ptInScope(30.3, -97.7, { src: 'me', pts: [AUSTIN] }), true);
  assert.equal(ptInScope(...EL_PASO, { src: 'me', pts: [AUSTIN] }), false);
});

/* ---------- the scope itself: reuse only what the user already gave, never a fresh prompt ---------- */

test('alertScope — my position wins, then the alert area, then nothing at all', () => {
  sandbox.localStorage.clear();
  withState({ myPos: null, inView: false, map: null }, () => {
    assert.equal(alertScope(), null, 'with no fix and no alert area there is nothing to measure from');
    assert.equal(alertScopeSrc(null), 'all');
  });
  withState({ myPos: AUSTIN_POS, inView: false, map: null }, () => {
    const sc = alertScope();
    assert.equal(sc.src, 'me');
    assert.deepEqual(plain(sc.pts), [AUSTIN]);
  });
});

test('alertScope — the alert area is reused only when the user chose "places" for it', () => {
  sandbox.localStorage.clear();
  const put = (prefs) => sandbox.localStorage.setItem('respondertx.push', JSON.stringify({ prefs }));
  withState({ myPos: null, inView: false, map: null }, () => {
    put({ scope: 'places', places: [{ lat: 30.27, lon: -97.74, km: 16 }] });
    assert.deepEqual(plain(alertAreaPlaces()), [[30.27, -97.74]]);
    assert.equal(alertScope().src, 'place');
    // statewide is a push-delivery choice, not a point the user named: it must not become an origin
    put({ scope: 'statewide', places: [{ lat: 30.27, lon: -97.74, km: 16 }] });
    assert.deepEqual(plain(alertAreaPlaces()), []);
    assert.equal(alertScope(), null);
    put({ scope: 'none', places: [] });
    assert.deepEqual(plain(alertAreaPlaces()), []);
  });
  sandbox.localStorage.clear();
});

test('the saved my-places list is never read as an alert origin without an explicit copy', () => {
  sandbox.localStorage.clear();
  sandbox.localStorage.setItem('respondertx.places', JSON.stringify([{ lat: 29.42, lon: -98.49, label: 'home' }]));
  withState({ myPos: null, inView: false, map: null }, () => {
    assert.deepEqual(plain(alertAreaPlaces()), [], 'saved my-places were given for the address check, not for alert scoping');
    assert.deepEqual(plain(alertDistPts()), []);
    assert.equal(alertScope(), null);
  });
  sandbox.localStorage.clear();
});

test('nothing in the scope path can raise a geolocation prompt', () => {
  const prompts = [];
  const savedGeo = sandbox.navigator.geolocation;
  sandbox.navigator.geolocation = {
    getCurrentPosition() { prompts.push('navigator.geolocation.getCurrentPosition'); },
    watchPosition() { prompts.push('navigator.geolocation.watchPosition'); return 1; },
  };
  const viewMap = {
    locate() { prompts.push('map.locate'); return viewMap; },
    getBounds: () => ({ getSouthWest: () => ({ lat: 30.0, lng: -98.0 }), getNorthEast: () => ({ lat: 30.5, lng: -97.5 }) }),
  };
  const list = [boxAlert('near', ...AUSTIN), boxAlert('far', ...EL_PASO), zoneAlert('nogeom')];
  const scopes = [
    { myPos: null, inView: false, map: null },
    { myPos: AUSTIN_POS, inView: false, map: null },
    { myPos: null, inView: true, map: viewMap },
  ];
  try {
    for (const patch of scopes) {
      withState(Object.assign({ alerts: list, hist: { alerts: {} }, showAlertsFar: true, showAlertHist: false }, patch), () => {
        const scope = alertScope();
        alertScopeSrc(scope);
        alertDistPts();
        alertAreaPlaces();
        for (const f of list) { alertGeom(f); alertNear(f, scope); alertDistChip(geoDistMi(alertGeom(f), scope && scope.pts)); }
        alertGroups(list, scope, alertDistPts());
        withDom(ALERT_LIST_SELECTORS, () => sandbox.renderAlertList());
      });
    }
    assert.deepEqual(prompts, [],
      `the alert scope path raised ${prompts.join(', ')}; it may only reuse a position already granted`);
  } finally { sandbox.navigator.geolocation = savedGeo; }
});

/* ---------- grouping: near leads, far folds, nothing is ever dropped ---------- */

test('a far alert folds below a near one when the board has a position', () => {
  const near = boxAlert('near', ...AUSTIN);
  const far = boxAlert('far', ...EL_PASO); // ~530 mi
  const { near: lead, far: rest } = alertGroups([far, near], { src: 'me', pts: [AUSTIN] });
  assert.deepEqual(ids(lead), ['near']);
  assert.deepEqual(ids(rest), ['far']);
});

test('with no position the list is complete, flat and ordered by severity then recency', () => {
  const a = boxAlert('advisory-close', ...AUSTIN, 'advisory', '2026-07-26T11:00:00Z');
  const w = boxAlert('warning-far', ...EL_PASO, 'warning', '2026-07-26T09:00:00Z');
  const wNewer = boxAlert('warning-newer', 33.0, -101.0, 'warning', '2026-07-26T11:30:00Z');
  const { near, far } = alertGroups([a, w, wNewer], null);
  assert.deepEqual(ids(far), [], 'without a scope nothing may fold');
  assert.deepEqual(ids(near), ['warning-newer', 'warning-far', 'advisory-close']);
});

test('scoping never removes an alert: every input lands in exactly one group, in every scope', () => {
  const list = [
    boxAlert('a', ...AUSTIN), boxAlert('b', ...EL_PASO), boxAlert('c', 29.42, -98.49),
    zoneAlert('d'), boxAlert('e', 33.0, -101.0, 'emergency'),
  ];
  const scopes = [null, { src: 'me', pts: [AUSTIN] }, { src: 'place', pts: [[29.42, -98.49], EL_PASO] },
    { src: 'inview', view: { s: 30.0, w: -98.0, n: 30.5, e: -97.5 } }];
  for (const sc of scopes) {
    const { near, far } = alertGroups(list, sc);
    const seen = ids(near).concat(ids(far)).sort();
    assert.deepEqual(seen, ['a', 'b', 'c', 'd', 'e'], `scope ${sc ? sc.src : 'all'} lost or duplicated an alert`);
  }
});

test('a flash-flood emergency never folds, however far away it is', () => {
  const emerg = boxAlert('emerg', ...EL_PASO, 'emergency');
  const near = boxAlert('near', ...AUSTIN);
  const { near: lead, far: rest } = alertGroups([near, emerg], { src: 'me', pts: [AUSTIN] });
  assert.deepEqual(ids(lead), ['emerg', 'near'], 'the banner carries an emergency statewide; the list must agree');
  assert.deepEqual(ids(rest), []);
  assert.equal(alertNear(emerg, { src: 'inview', view: { s: 30, w: -98, n: 30.5, e: -97.5 } }), true);
});

test('an alert the board cannot place stays in the lead group rather than folding unmeasured', () => {
  const zone = zoneAlert('nogeom');
  const scope = { src: 'me', pts: [AUSTIN] };
  assert.equal(alertGeom(zone), null, 'no geometry and no cached zone polygon');
  assert.equal(alertNear(zone, scope), true);
  const { near, far } = alertGroups([boxAlert('far', ...EL_PASO), zone], scope);
  assert.ok(ids(near).includes('nogeom'));
  assert.deepEqual(ids(far), ['far']);
});

test('inside a group severity leads and distance breaks the tie', () => {
  const scope = { src: 'me', pts: [AUSTIN] };
  const closeWatch = boxAlert('watch-close', 30.3, -97.8, 'watch');
  const nearWarn = boxAlert('warn-near', 30.6, -97.9, 'warning');
  const nearerWarn = boxAlert('warn-nearer', 30.28, -97.75, 'warning');
  const { near } = alertGroups([closeWatch, nearWarn, nearerWarn], scope);
  assert.deepEqual(ids(near), ['warn-nearer', 'warn-near', 'watch-close']);
});

test('the folded group is ordered by distance, so the closest of the far ones reads first', () => {
  const scope = { src: 'me', pts: [AUSTIN] };
  const list = [boxAlert('elpaso', ...EL_PASO), boxAlert('amarillo', 35.22, -101.83), boxAlert('lubbock', 33.58, -101.86)];
  const { far } = alertGroups(list, scope);
  assert.deepEqual(ids(far), ['lubbock', 'amarillo', 'elpaso']);
});

test('the distance chip reads as approximate, because a bounding box under-reads a polygon', () => {
  assert.equal(alertDistChip(NaN), '', 'no origin means no chip, never a bare zero');
  for (const lang of ['en', 'es']) {
    assert.ok(I18N[lang]['alert.dist'].startsWith('≈'), `${lang} alert.dist must not read as an exact distance`);
    assert.match(I18N[lang]['alert.dist'], /\{n\}/, `${lang} alert.dist must carry the distance placeholder`);
    // the chip a reader sees, rendered: the approximate copy with the rounded distance in it
    assert.equal(withCopy(lang, () => alertDistChip(12.4)), I18N[lang]['alert.dist'].replace('{n}', '12'));
    assert.equal(withCopy(lang, () => alertDistChip(0.6)), I18N[lang]['alert.dist'].replace('{n}', '1'));
  }
});

/* ---------- the renderer: the fold is a disclosure, not a filter ---------- */

test('renderAlertList folds the far group behind a toggle and never drops it from the list', () => {
  const near = boxAlert('near', ...AUSTIN);
  const far = boxAlert('far', ...EL_PASO);
  withState({
    alerts: [near, far], hist: { alerts: {} }, myPos: AUSTIN_POS, inView: true, map: null,
    showAlertsFar: false, showAlertHist: false,
  }, () => withDom(ALERT_LIST_SELECTORS, (dom) => {
    sandbox.renderAlertList();
    const list = dom.node('#alert-list');
    assert.deepEqual(dom.missed, [], 'the render reached an element this test never registered, so it proved nothing about it');
    assert.deepEqual(cardIds(list), ['near'], 'the near group renders as cards');
    const chip = dom.node('#flt-alert-inview').textContent;
    assert.ok(chip.endsWith(' · 1'), `the chip must count the lead group; it reads "${chip}"`);
    assert.equal(Number(dom.node('#alerts-count').textContent), 2, 'the tab badge still counts every open alert');

    const toggle = list.kids.find((k) => k.className === 'aged-toggle');
    assert.ok(toggle, 'the far group must be offered behind a toggle, never dropped');

    list.kids.length = 0;
    assert.equal(toggle.click(), 1, 'the fold must be a user-reversible toggle');
    assert.equal(state.showAlertsFar, true);
    assert.deepEqual(cardIds(list).sort(), ['far', 'near'],
      'opening the fold must render the far alerts as real cards, not as a count');
    assert.equal(typeof sandbox.alertInAO, 'undefined', 'the retired statewide AO filter must not come back');
  }));
});

test('the Alerts tab carries the same In view control as the Feed and Gauges, on one shared scope', () => {
  // index.html is a shipped artifact the harness cannot execute, so the control's presence is read
  const html = read('index.html').replace(/<!--[\s\S]*?-->/g, '');
  const tab = html.slice(html.indexOf('id="tab-alerts"'), html.indexOf('id="tab-gauges"'));
  assert.match(tab, /id="flt-alert-inview"/, 'the Alerts tab has no proximity control');
  assert.match(tab, /data-i18n-title="sync\.inview\.title"/, 'the control must carry a translated tooltip');
  // the click binding lives inside boot(), which cannot run here (it awaits the config fetch and initMap)
  assert.match(read('js/boot.js'), /\$\('#flt-alert-inview'\)\.addEventListener\('click', \(\) => setInView\(!state\.inView\)\)/,
    'the Alerts chip must drive the same shared scope, not a parallel one');

  const painted = [];
  const saved = { alerts: sandbox.renderAlertList, reqs: sandbox.renderRequests, gauges: sandbox.renderGaugesTab, timeout: sandbox.setTimeout };
  sandbox.renderAlertList = () => painted.push('alerts');
  sandbox.renderRequests = () => painted.push('requests');
  sandbox.renderGaugesTab = () => painted.push('gauges');
  const debounced = [];
  sandbox.setTimeout = (fn) => { debounced.push(fn); return debounced.length; };
  try {
    withState({ inView: false }, () => {
      sandbox.setInView(true);
      assert.equal(state.inView, true);
      assert.ok(painted.includes('alerts'), 'toggling the scope must repaint the Alerts list');
    });

    painted.length = 0;
    const mapHandlers = new Map();
    sandbox.sessionStorage.setItem('respondertx.inview', '1');
    withState({ inView: false, map: { on(ev, fn) { mapHandlers.set(ev, fn); } } }, () => {
      sandbox.initInViewSync();
      assert.equal(state.inView, true, 'the chip state is restored from the shared session key');
      mapHandlers.get('moveend')();
      assert.equal(debounced.length, 1, 'a pan while the chip is on must schedule a repaint');
      debounced.pop()();
      assert.ok(painted.includes('alerts'), 'panning with the chip on must repaint the Alerts list');
    });
  } finally {
    sandbox.renderAlertList = saved.alerts;
    sandbox.renderRequests = saved.reqs;
    sandbox.renderGaugesTab = saved.gauges;
    sandbox.setTimeout = saved.timeout;
    sandbox.sessionStorage.clear();
  }
});

/* ---------- the header says what actually happens ---------- */

test('the section header names the scope in use, in both languages, and no longer claims an AO order', () => {
  for (const lang of ['en', 'es']) {
    for (const src of ['me', 'place', 'inview', 'all']) {
      assert.ok(I18N[lang][`sec.alerts.${src}`], `${lang} is missing sec.alerts.${src}`);
    }
    assert.equal(I18N[lang]['sec.alerts'], undefined, `${lang} still carries the retired flat header`);
    /* v0.99.56: "near" became a per-class rule (60 mi for a moving storm, containment for a watch or
       a standing advisory), so one radius in the heading would be a claim the grouping does not make. */
    assert.ok(!/\{n\}/.test(I18N[lang]['sec.alerts.me']),
      `${lang} sec.alerts.me must not claim a single radius now that near is per hazard class`);
    assert.ok(!/\bAO\b/.test(I18N[lang]['sec.alerts.all']), `${lang} still describes an AO ordering`);
    assert.equal(I18N[lang]['alert.elsewhere'], undefined, `${lang} still carries the retired elsewhere fold`);
    for (const k of ['alert.far', 'alert.far1']) assert.ok(I18N[lang][k], `${lang} is missing ${k}`);
  }

  sandbox.localStorage.clear();
  const viewMap = { getBounds: () => ({ getSouthWest: () => ({ lat: 30.0, lng: -98.0 }), getNorthEast: () => ({ lat: 30.5, lng: -97.5 }) }) };
  const cases = [
    ['all', { myPos: null, inView: false, map: null }],
    ['me', { myPos: AUSTIN_POS, inView: false, map: null }],
    ['inview', { myPos: AUSTIN_POS, inView: true, map: viewMap }],
  ];
  try {
    for (const lang of ['en', 'es']) {
      for (const [src, patch] of cases) {
        withState(Object.assign({ alerts: [boxAlert('a', ...AUSTIN)], hist: { alerts: {} }, showAlertsFar: false, showAlertHist: false }, patch), () => {
          withDom(ALERT_LIST_SELECTORS, (dom) => {
            withCopy(lang, () => sandbox.renderAlertList());
            const title = dom.node('#alert-list').innerHTML;
            assert.equal(title, `<div class="section-title">${esc(I18N[lang][`sec.alerts.${src}`])}</div>`,
              `${lang}: the header must be the scope actually applied, verbatim and unsubstituted`);
          });
        });
      }
    }
  } finally { sandbox.localStorage.clear(); }

  // the 'place' scope comes from the push prefs, so it needs the stored copy the user gave
  sandbox.localStorage.setItem('respondertx.push', JSON.stringify({ prefs: { scope: 'places', places: [{ lat: 30.27, lon: -97.74, km: 16 }] } }));
  try {
    withState({ alerts: [], hist: { alerts: {} }, myPos: null, inView: false, map: null, showAlertHist: false }, () => {
      withDom(ALERT_LIST_SELECTORS, (dom) => {
        withCopy('en', () => sandbox.renderAlertList());
        assert.equal(dom.node('#alert-list').innerHTML, `<div class="section-title">${esc(I18N.en['sec.alerts.place'])}</div>`);
      });
    });
  } finally { sandbox.localStorage.clear(); }
});

/* ---------- the quiet line can only claim the area it read ---------- */

const gauge = (lid, cat, lat, lon) => ({
  lid, name: `${lid} River`, latitude: lat, longitude: lon,
  status: { observed: { floodCategory: cat, primary: 4, validTime: new Date().toISOString() } },
});

function withHazards(patch, fn) {
  return withState(Object.assign({
    alerts: [], gauges: [gauge('QUIET', 'none', 30.3, -97.8)], roadClosures: { lines: [] },
    myPos: null, inView: false, map: null,
  }, patch), fn);
}

test('quietState cannot claim a local all-clear from statewide-only evidence', () => {
  const flooding = gauge('FLOOD', 'major', ...EL_PASO); // far outside a 50 mi scope
  // statewide: one gauge in flood anywhere blocks the claim, because the claim is about Texas
  withHazards({ gauges: [gauge('QUIET', 'none', 30.3, -97.8), flooding] }, () => {
    assert.equal(alertScopeSrc(alertScope()), 'all');
    assert.equal(quietState(), false, 'an unscoped claim must answer for the whole state');
  });
  // scoped to a fix: the same evidence supports a claim about the 50 mi the board actually read
  withHazards({ gauges: [gauge('QUIET', 'none', 30.3, -97.8), flooding], myPos: AUSTIN_POS }, () => {
    assert.equal(alertScopeSrc(alertScope()), 'me');
    assert.equal(quietState(), true);
    assert.deepEqual(quietGauges(alertScope()).map((g) => g.lid), ['QUIET'], 'the claim speaks only for the gauges it read');
  });
  // and a hazard inside that same scope still blocks it
  withHazards({ gauges: [gauge('FLOOD', 'major', 30.3, -97.8)], myPos: AUSTIN_POS }, () => {
    assert.equal(quietState(), false, 'a gauge in flood inside the scope must block the local claim');
  });
});

test('an empty scope is not an all-clear: no gauge in range means no claim', () => {
  withHazards({ gauges: [gauge('FAR', 'none', ...EL_PASO)], myPos: AUSTIN_POS }, () => {
    assert.equal(quietGauges(alertScope()).length, 0);
    assert.equal(quietState(), false, 'silence in a radius holding no gauge is not evidence of quiet');
  });
});

test('an open alert or a road closure inside the scope blocks the quiet line; one outside it does not', () => {
  const roadLine = (lat, lon) => ({ geometry: { type: 'LineString', coordinates: [[lon, lat], [lon + 0.05, lat + 0.05]] }, properties: {} });
  withHazards({ myPos: AUSTIN_POS, alerts: [boxAlert('near', 30.3, -97.8)] }, () => assert.equal(quietState(), false, 'an open alert in scope'));
  withHazards({ myPos: AUSTIN_POS, alerts: [boxAlert('far', ...EL_PASO)] }, () => assert.equal(quietState(), true, 'an alert 500 mi away is not this area'));
  withHazards({ myPos: AUSTIN_POS, roadClosures: { lines: [roadLine(30.3, -97.8)] } }, () => assert.equal(quietState(), false, 'a closure in scope'));
  withHazards({ myPos: AUSTIN_POS, roadClosures: { lines: [roadLine(...EL_PASO)] } }, () => assert.equal(quietState(), true, 'a closure 500 mi away'));
  // a closure the board cannot place is never ruled out of the evidence
  withHazards({ myPos: AUSTIN_POS, roadClosures: { lines: [{ properties: {} }] } }, () => assert.equal(quietState(), false, 'an unplaceable closure'));
});

// renders the strip and hands back what the reader would see in it
function quietStripHtml(lang, patch) {
  return withHazards(Object.assign({ alertsLoadedOnce: true, lsrs: [], roadsUnknown: false }, patch),
    () => withDom(['#threat-strip'], (dom) => {
      withCopy(lang, () => sandbox.renderThreatStrip());
      return dom.node('#threat-strip').innerHTML;
    }));
}

test('the quiet wording names the same area the evidence came from, in both languages', () => {
  for (const lang of ['en', 'es']) {
    for (const src of ['me', 'place', 'inview', 'all']) {
      assert.ok(I18N[lang][`quiet.line.${src}`], `${lang} is missing quiet.line.${src}`);
    }
    assert.equal(I18N[lang]['quiet.line'], undefined, `${lang} still carries the retired unscoped quiet line`);
    assert.match(I18N[lang]['quiet.line.me'], /\{n\}/, `${lang} quiet.line.me must state the radius it checked`);
    assert.match(I18N[lang]['quiet.line.all'], /Texas/, `${lang} the unscoped claim must name the area it answers for`);
    assert.ok(!/\bAO\b|área de operaciones/.test(I18N[lang]['quiet.line.all']), `${lang} still names the retired AO`);

    // two normal gauges, only one of them in range, so a scoped count reads differently from a board-wide one
    const twoGauges = [gauge('QUIET', 'none', 30.3, -97.8), gauge('FAR', 'none', ...EL_PASO)];
    const scoped = quietStripHtml(lang, { myPos: AUSTIN_POS, gauges: twoGauges });
    assert.ok(scoped.includes(esc(I18N[lang]['quiet.line.me'].replace('{n}', String(ALERT_NEAR_MI)))),
      `${lang}: the line must be keyed to the scope the evidence used, with the radius it read`);
    assert.ok(scoped.includes(esc(I18N[lang]['quiet.sub'].replace('{n}', '1').replace('{m}', '1'))),
      `${lang}: the counts must be the gauges the claim speaks for, not every gauge on the board`);

    const unscoped = quietStripHtml(lang, { myPos: null, gauges: twoGauges });
    assert.ok(unscoped.includes(esc(I18N[lang]['quiet.line.all'])),
      `${lang}: with no scope the claim must name the area it answers for`);
    assert.ok(unscoped.includes(esc(I18N[lang]['quiet.sub'].replace('{n}', '2').replace('{m}', '2'))),
      `${lang}: an unscoped claim answers for every gauge it read`);
  }
});

test('REGRESSION — an empty curated Feed still needs quiet hazard feeds board-wide', () => {
  withHazards({}, () => assert.equal(feedCalmOk(), true));
  withHazards({ alerts: [boxAlert('far', ...EL_PASO)], myPos: AUSTIN_POS }, () => {
    assert.equal(quietState(), true, 'the scoped claim holds');
    assert.equal(feedCalmOk(), false, 'the Feed treatment still refuses while any alert is open anywhere');
  });
});

/* ---------- jurisdiction crossing layer: default off, self-enabling on a confirmable change ---------- */

const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();

// a crossing layer that records whether anything asked the map to draw it
function crossLayerStub() {
  const layer = {
    adds: 0,
    clearLayers() {}, addLayer() {},
    addTo() { layer.adds += 1; return layer; },
  };
  return layer;
}

test('the jurisdiction crossing layer enables itself only when the feed carries a confirmable change', () => {
  assert.equal(xstatusAutoOn([]), false, 'no rows, no reason to draw');
  assert.equal(xstatusAutoOn([{ changed: ago(9) }, { changed: ago(378) }]), false,
    'every row past the unconfirmed window is a record-change stamp, not a live hazard');
  assert.equal(xstatusAutoOn([{ changed: ago(9) }, { changed: ago(0.5) }]), true);
  assert.equal(xstatusAutoOn([{ name: 'no stamp' }]), false, 'a row with no change time can never be confirmed');

  const fresh = { crossings: [{ name: 'Low crossing', lat: 30.3, lon: -97.8, status: 'closed', changed: ago(0.5) }] };
  const old = { crossings: [{ name: 'Low crossing', lat: 30.3, lon: -97.8, status: 'closed', changed: ago(378) }] };
  const mapOff = { hasLayer: () => false };
  const render = (patch) => {
    const layer = crossLayerStub();
    withState(Object.assign({ map: mapOff, layers: { crossStatus: layer }, xstatusAutoDone: false }, patch),
      () => sandbox.renderCrossStatus());
    return layer;
  };

  assert.equal(render({ crossStatus: fresh }).adds, 1, 'renderCrossStatus must offer the layer once the data warrants it');
  assert.equal(render({ crossStatus: old }).adds, 0, 'a record-change stamp alone must never open the layer');
  assert.equal(render({ crossStatus: fresh, xstatusAutoDone: true }).adds, 0,
    'a deliberate toggle-off must not be re-opened by the next refresh');
  assert.equal(render({ crossStatus: fresh, map: null }).adds, 0, 'no map, nothing to enable');
  assert.equal(render({ crossStatus: fresh, map: { hasLayer: () => true } }).adds, 0, 'already drawn: nothing to add');

  withState({ map: mapOff, layers: { crossStatus: crossLayerStub() }, crossStatus: fresh, xstatusAutoDone: false }, () => {
    sandbox.renderCrossStatus();
    assert.equal(state.xstatusAutoDone, true, 'the auto-enable fires once, not on every refresh');
  });
});

test('the crossing layer ships off, and a deliberate toggle-off is never re-opened', () => {
  const wired = loadWiredMap();
  const ll = (lat, lng) => ({ lat, lng });
  const bounds = {
    getWest: () => -100, getEast: () => -98, getSouth: () => 29, getNorth: () => 31,
    contains: () => true, isValid: () => true, pad() { return bounds; },
    getCenter: () => ll(30, -99), getNorthWest: () => ll(31, -100), getSouthEast: () => ll(29, -98),
    getNorthEast: () => ll(31, -98), getSouthWest: () => ll(29, -100),
  };
  wired.map.getBounds = () => bounds;
  wired.map.project = () => ({ x: 100, y: 100, divideBy() { return this; }, floor() { return this; } });

  wired.state.xstatusAutoDone = false;
  wired.fire('overlayremove', { layer: wired.layers.crossStatus });
  assert.equal(wired.state.xstatusAutoDone, true, 'turning the layer off must stop the auto-enable');
  wired.state.xstatusAutoDone = false;
  wired.fire('overlayremove', { layer: wired.layers.alerts });
  assert.equal(wired.state.xstatusAutoDone, false, 'an unrelated layer must not consume the auto-enable');

  // with every overlay reported on, the sheet's reset turns off exactly the rows that ship off
  const removed = [];
  wired.map.hasLayer = () => true;
  wired.map.removeLayer = (l) => { removed.push(l); return wired.map; };
  wired.sandbox.layerSheetReset();
  assert.ok(removed.includes(wired.layers.crossStatus), 'the sheet default for crossStatus must stay off');
  assert.ok(!removed.includes(wired.layers.alerts), 'an on-by-default row must survive the same reset');
});

/* ---------- the address check shares the one geometry helper ---------- */

test('alertNearPoint reads the shared bounds helper rather than a second Leaflet copy', () => {
  const f = boxAlert('a', ...AUSTIN);
  assert.equal(alertNearPoint(f, ...AUSTIN), true, 'a point inside the footprint is covered by it');
  assert.equal(alertNearPoint(f, ...EL_PASO), false, 'a point 500 mi away is not');
  assert.equal(alertNearPoint(zoneAlert('z'), ...AUSTIN), false, 'an unplaceable alert covers no point');

  const seen = [];
  const savedBounds = sandbox.geoBounds;
  const savedL = sandbox.L;
  sandbox.geoBounds = (g) => { seen.push(g); return savedBounds(g); };
  sandbox.L = new Proxy({}, { get(_t, k) { throw new Error(`alertNearPoint reached Leaflet: L.${String(k)}`); } });
  try {
    assert.equal(alertNearPoint(f, ...AUSTIN), true, 'the point check must run without Leaflet loaded at all');
    assert.equal(seen.length, 1, 'the point check must resolve its extent through the shared geoBounds helper');
  } finally { sandbox.geoBounds = savedBounds; sandbox.L = savedL; }
});

test('ALERT_NEAR_MI is the single radius every scoped surface reads', () => {
  assert.equal(ALERT_NEAR_MI, 50);
  const scope = { src: 'me', pts: [AUSTIN] };
  // probe the boundary the scope math actually applies, rather than reading the number back
  const northOf = (mi) => [AUSTIN[0] + mi / 69.0, AUSTIN[1]];
  const inside = northOf(ALERT_NEAR_MI - 2);
  const outside = northOf(ALERT_NEAR_MI + 2);
  assert.ok(distMi(...AUSTIN, ...inside) < ALERT_NEAR_MI, 'the probe must sit inside the radius it probes');
  assert.ok(distMi(...AUSTIN, ...outside) > ALERT_NEAR_MI, 'the probe must sit outside the radius it probes');
  assert.equal(ptInScope(...inside, scope), true, `a point ${ALERT_NEAR_MI - 2} mi out must be in scope`);
  assert.equal(ptInScope(...outside, scope), false,
    `a point ${ALERT_NEAR_MI + 2} mi out is past ALERT_NEAR_MI; the scope math is applying some other radius`);
  assert.equal(geomInScope({ type: 'Point', coordinates: [outside[1], outside[0]] }, scope), false,
    'geomInScope and ptInScope must apply the same radius');

  // and the all-clear line states that same radius, so the wording cannot drift from the math
  assert.ok(quietStripHtml('en', { myPos: AUSTIN_POS }).includes(esc(I18N.en['quiet.line.me'].replace('{n}', String(ALERT_NEAR_MI)))),
    'the quiet line must name the radius the scope math applies');
});

test('a new GPS fix re-leads the alerts list and the all-clear line on that position', () => {
  const wired = loadWiredMap();
  const painted = [];
  // renderThreatStrip and the two tab renderers live in panels.js, outside the map bundle
  for (const name of ['renderRequests', 'renderDriveMode', 'renderRoadsTab', 'renderAlertList', 'renderThreatStrip', 'startLocTrack']) {
    wired.sandbox[name] = () => { painted.push(name); };
  }
  wired.state.driveRankAt = 0;
  wired.fire('locationfound', { latlng: { lat: AUSTIN[0], lng: AUSTIN[1] }, accuracy: 30 });
  assert.deepEqual(wired.state.myPos, { lat: AUSTIN[0], lng: AUSTIN[1] }, 'the fix must become the board position');
  assert.ok(painted.includes('renderAlertList'), 'a fix must re-scope the Alerts tab, not wait for the next refresh');
  assert.ok(painted.includes('renderThreatStrip'), 'a fix must re-scope the all-clear claim with it');
});
