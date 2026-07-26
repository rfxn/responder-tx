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
const { loadApp } = require('./harness.js');
const I18N = require('./i18n-load.js');

const {
  geoBounds, geoDistMi, geoInView, geomInScope, ptInScope, alertGeom, alertNearPoint,
  alertScope, alertScopeSrc, alertNear, alertGroups, alertDistChip, alertAreaPlaces, alertDistPts,
  ALERT_NEAR_MI, quietState, quietGauges, feedCalmOk, xstatusAutoOn, state, _sandbox: sandbox,
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
  const far = geoDistMi(geom, [[31.76, -106.49]]); // El Paso
  assert.ok(far > 400 && far < 700, `expected a few hundred miles, got ${far}`);
  // nearest of several points wins
  assert.equal(geoDistMi(geom, [[31.76, -106.49], AUSTIN]), 0);
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
  assert.equal(ptInScope(31.76, -106.49, { src: 'me', pts: [AUSTIN] }), false);
});

/* ---------- the scope itself: reuse only what the user already gave, never a fresh prompt ---------- */

test('alertScope — my position wins, then the alert area, then nothing at all', () => {
  sandbox.localStorage.clear();
  withState({ myPos: null, inView: false, map: null }, () => {
    assert.equal(alertScope(), null, 'with no fix and no alert area there is nothing to measure from');
    assert.equal(alertScopeSrc(null), 'all');
  });
  withState({ myPos: { lat: 30.27, lng: -97.74 }, inView: false, map: null }, () => {
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
  const src = read('js/sources.js');
  assert.ok(!/loadPlaces\(\)/.test(src.slice(src.indexOf('function alertAreaPlaces'), src.indexOf('function alertScope'))),
    'alertAreaPlaces must not reach into the saved my-places store');
  sandbox.localStorage.clear();
});

test('nothing in the scope path can raise a geolocation prompt', () => {
  const src = read('js/sources.js');
  const block = src.slice(src.indexOf('const ALERT_NEAR_MI'), src.indexOf('function alertCardDiv'));
  for (const bad of ['getCurrentPosition', 'watchPosition', '.locate(']) {
    assert.ok(!block.includes(bad), `the alert scope path calls ${bad}; it may only reuse a position already granted`);
  }
});

/* ---------- grouping: near leads, far folds, nothing is ever dropped ---------- */

test('a far alert folds below a near one when the board has a position', () => {
  const near = boxAlert('near', ...AUSTIN);
  const far = boxAlert('far', 31.76, -106.49); // El Paso, ~530 mi
  const { near: lead, far: rest } = alertGroups([far, near], { src: 'me', pts: [AUSTIN] });
  assert.deepEqual(ids(lead), ['near']);
  assert.deepEqual(ids(rest), ['far']);
});

test('with no position the list is complete, flat and ordered by severity then recency', () => {
  const a = boxAlert('advisory-close', ...AUSTIN, 'advisory', '2026-07-26T11:00:00Z');
  const w = boxAlert('warning-far', 31.76, -106.49, 'warning', '2026-07-26T09:00:00Z');
  const wNewer = boxAlert('warning-newer', 33.0, -101.0, 'warning', '2026-07-26T11:30:00Z');
  const { near, far } = alertGroups([a, w, wNewer], null);
  assert.deepEqual(ids(far), [], 'without a scope nothing may fold');
  assert.deepEqual(ids(near), ['warning-newer', 'warning-far', 'advisory-close']);
});

test('scoping never removes an alert: every input lands in exactly one group, in every scope', () => {
  const list = [
    boxAlert('a', ...AUSTIN), boxAlert('b', 31.76, -106.49), boxAlert('c', 29.42, -98.49),
    zoneAlert('d'), boxAlert('e', 33.0, -101.0, 'emergency'),
  ];
  const scopes = [null, { src: 'me', pts: [AUSTIN] }, { src: 'place', pts: [[29.42, -98.49], [31.76, -106.49]] },
    { src: 'inview', view: { s: 30.0, w: -98.0, n: 30.5, e: -97.5 } }];
  for (const sc of scopes) {
    const { near, far } = alertGroups(list, sc);
    const seen = ids(near).concat(ids(far)).sort();
    assert.deepEqual(seen, ['a', 'b', 'c', 'd', 'e'], `scope ${sc ? sc.src : 'all'} lost or duplicated an alert`);
  }
});

test('a flash-flood emergency never folds, however far away it is', () => {
  const emerg = boxAlert('emerg', 31.76, -106.49, 'emergency');
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
  const { near, far } = alertGroups([boxAlert('far', 31.76, -106.49), zone], scope);
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
  const list = [boxAlert('elpaso', 31.76, -106.49), boxAlert('amarillo', 35.22, -101.83), boxAlert('lubbock', 33.58, -101.86)];
  const { far } = alertGroups(list, scope);
  assert.deepEqual(ids(far), ['lubbock', 'amarillo', 'elpaso']);
});

test('the distance chip reads as approximate, because a bounding box under-reads a polygon', () => {
  assert.equal(alertDistChip(NaN), '', 'no origin means no chip, never a bare zero');
  assert.ok(alertDistChip(12.4), 'a measured alert must carry its distance');
  for (const lang of ['en', 'es']) {
    assert.ok(I18N[lang]['alert.dist'].startsWith('≈'), `${lang} alert.dist must not read as an exact distance`);
    assert.match(I18N[lang]['alert.dist'], /\{n\}/, `${lang} alert.dist must carry the distance placeholder`);
  }
  assert.match(read('js/sources.js'), /const alertDistChip = \(d\) => \(Number\.isFinite\(d\) \? t\('alert\.dist'\)/);
});

/* ---------- the renderer: the fold is a disclosure, not a filter ---------- */

test('renderAlertList folds the far group behind a toggle and never drops it from the list', () => {
  const src = read('js/sources.js');
  const fn = src.match(/function renderAlertList\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'renderAlertList() not found');
  assert.match(fn[0], /const \{ near, far \} = alertGroups\(/, 'the list must render from the grouped rows');
  assert.match(fn[0], /if \(state\.showAlertsFar\) for \(const r of far\) el\.appendChild\(alertCardDiv\(r\.f, r\.d\)\)/,
    'the folded alerts must still render as real cards when the toggle is open');
  assert.match(fn[0], /btn\.addEventListener\('click', \(\) => \{ state\.showAlertsFar = !state\.showAlertsFar/,
    'the fold must be a user-reversible toggle');
  assert.ok(!/\.filter\(alertInAO\)/.test(src), 'the statewide AO test is gone');
  assert.ok(!/function alertInAO/.test(src), 'alertInAO no longer scopes anything and must not linger');
  // the count next to the chip is the lead group, matching the Feed and Gauges chips
  assert.match(src, /function syncAlertInViewChip\(n\)[\s\S]*?\$\('#flt-alert-inview'\)/);
  assert.match(src, /syncAlertInViewChip\(near\.length\)/);
});

test('the Alerts tab carries the same In view control as the Feed and Gauges, on one shared scope', () => {
  const html = read('index.html').replace(/<!--[\s\S]*?-->/g, '');
  const tab = html.slice(html.indexOf('id="tab-alerts"'), html.indexOf('id="tab-gauges"'));
  assert.match(tab, /id="flt-alert-inview"/, 'the Alerts tab has no proximity control');
  assert.match(tab, /data-i18n-title="sync\.inview\.title"/, 'the control must carry a translated tooltip');
  const boot = read('js/boot.js');
  assert.match(boot, /\$\('#flt-alert-inview'\)\.addEventListener\('click', \(\) => setInView\(!state\.inView\)\)/,
    'the Alerts chip must drive the same shared scope, not a parallel one');
  const board = read('js/board.js');
  const setter = board.match(/function setInView\(on\)[\s\S]*?\n\}/);
  assert.match(setter[0], /renderAlertList\(\)/, 'toggling the scope must repaint the Alerts list');
  const sync = board.match(/function initInViewSync\(\)[\s\S]*?\n\}\n/);
  assert.match(sync[0], /renderAlertList\(\)/, 'panning with the chip on must repaint the Alerts list');
});

/* ---------- the header says what actually happens ---------- */

test('the section header names the scope in use, in both languages, and no longer claims an AO order', () => {
  for (const lang of ['en', 'es']) {
    for (const src of ['me', 'place', 'inview', 'all']) {
      assert.ok(I18N[lang][`sec.alerts.${src}`], `${lang} is missing sec.alerts.${src}`);
    }
    assert.equal(I18N[lang]['sec.alerts'], undefined, `${lang} still carries the retired flat header`);
    assert.match(I18N[lang]['sec.alerts.me'], /\{n\}/, `${lang} sec.alerts.me must state the radius it orders by`);
    assert.ok(!/\bAO\b/.test(I18N[lang]['sec.alerts.all']), `${lang} still describes an AO ordering`);
    assert.equal(I18N[lang]['alert.elsewhere'], undefined, `${lang} still carries the retired elsewhere fold`);
    for (const k of ['alert.far', 'alert.far1']) assert.ok(I18N[lang][k], `${lang} is missing ${k}`);
  }
  const src = read('js/sources.js');
  const fn = src.match(/function renderAlertList\(\)[\s\S]*?\n\}/)[0];
  assert.match(fn, /sec\.alerts\.\$\{alertScopeSrc\(scope\)\}/, 'the header must be derived from the scope actually applied');
  assert.match(fn, /\.replace\('\{n\}', String\(ALERT_NEAR_MI\)\)/, 'the stated radius must come from the constant that groups the rows');
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
  const flooding = gauge('FLOOD', 'major', 31.76, -106.49); // El Paso, far outside a 50 mi scope
  // statewide: one gauge in flood anywhere blocks the claim, because the claim is about Texas
  withHazards({ gauges: [gauge('QUIET', 'none', 30.3, -97.8), flooding] }, () => {
    assert.equal(alertScopeSrc(alertScope()), 'all');
    assert.equal(quietState(), false, 'an unscoped claim must answer for the whole state');
  });
  // scoped to a fix: the same evidence supports a claim about the 50 mi the board actually read
  withHazards({ gauges: [gauge('QUIET', 'none', 30.3, -97.8), flooding], myPos: { lat: 30.27, lng: -97.74 } }, () => {
    assert.equal(alertScopeSrc(alertScope()), 'me');
    assert.equal(quietState(), true);
    assert.deepEqual(quietGauges(alertScope()).map((g) => g.lid), ['QUIET'], 'the claim speaks only for the gauges it read');
  });
  // and a hazard inside that same scope still blocks it
  withHazards({ gauges: [gauge('FLOOD', 'major', 30.3, -97.8)], myPos: { lat: 30.27, lng: -97.74 } }, () => {
    assert.equal(quietState(), false, 'a gauge in flood inside the scope must block the local claim');
  });
});

test('an empty scope is not an all-clear: no gauge in range means no claim', () => {
  withHazards({ gauges: [gauge('FAR', 'none', 31.76, -106.49)], myPos: { lat: 30.27, lng: -97.74 } }, () => {
    assert.equal(quietGauges(alertScope()).length, 0);
    assert.equal(quietState(), false, 'silence in a radius holding no gauge is not evidence of quiet');
  });
});

test('an open alert or a road closure inside the scope blocks the quiet line; one outside it does not', () => {
  const pos = { lat: 30.27, lng: -97.74 };
  const roadLine = (lat, lon) => ({ geometry: { type: 'LineString', coordinates: [[lon, lat], [lon + 0.05, lat + 0.05]] }, properties: {} });
  withHazards({ myPos: pos, alerts: [boxAlert('near', 30.3, -97.8)] }, () => assert.equal(quietState(), false, 'an open alert in scope'));
  withHazards({ myPos: pos, alerts: [boxAlert('far', 31.76, -106.49)] }, () => assert.equal(quietState(), true, 'an alert 500 mi away is not this area'));
  withHazards({ myPos: pos, roadClosures: { lines: [roadLine(30.3, -97.8)] } }, () => assert.equal(quietState(), false, 'a closure in scope'));
  withHazards({ myPos: pos, roadClosures: { lines: [roadLine(31.76, -106.49)] } }, () => assert.equal(quietState(), true, 'a closure 500 mi away'));
  // a closure the board cannot place is never ruled out of the evidence
  withHazards({ myPos: pos, roadClosures: { lines: [{ properties: {} }] } }, () => assert.equal(quietState(), false, 'an unplaceable closure'));
});

test('the quiet wording names the same area the evidence came from, in both languages', () => {
  for (const lang of ['en', 'es']) {
    for (const src of ['me', 'place', 'inview', 'all']) {
      assert.ok(I18N[lang][`quiet.line.${src}`], `${lang} is missing quiet.line.${src}`);
    }
    assert.equal(I18N[lang]['quiet.line'], undefined, `${lang} still carries the retired unscoped quiet line`);
    assert.match(I18N[lang]['quiet.line.me'], /\{n\}/, `${lang} quiet.line.me must state the radius it checked`);
    assert.match(I18N[lang]['quiet.line.all'], /Texas/, `${lang} the unscoped claim must name the area it answers for`);
    assert.ok(!/\bAO\b|área de operaciones/.test(I18N[lang]['quiet.line.all']), `${lang} still names the retired AO`);
  }
  const strip = read('js/panels.js').match(/function renderThreatStrip\(\)[\s\S]*?\n\}/)[0];
  assert.match(strip, /quiet\.line\.\$\{alertScopeSrc\(scope\)\}/, 'the line must be keyed to the scope the evidence used');
  assert.match(strip, /quietGauges\(scope\)/, 'the reassurance counts must be the scoped ones the claim speaks for');
});

test('REGRESSION — an empty curated Feed still needs quiet hazard feeds board-wide', () => {
  withHazards({}, () => assert.equal(feedCalmOk(), true));
  withHazards({ alerts: [boxAlert('far', 31.76, -106.49)], myPos: { lat: 30.27, lng: -97.74 } }, () => {
    assert.equal(quietState(), true, 'the scoped claim holds');
    assert.equal(feedCalmOk(), false, 'the Feed treatment still refuses while any alert is open anywhere');
  });
});

/* ---------- jurisdiction crossing layer: default off, self-enabling on a confirmable change ---------- */

test('the jurisdiction crossing layer enables itself only when the feed carries a confirmable change', () => {
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
  assert.equal(xstatusAutoOn([]), false, 'no rows, no reason to draw');
  assert.equal(xstatusAutoOn([{ changed: ago(9) }, { changed: ago(378) }]), false,
    'every row past the unconfirmed window is a record-change stamp, not a live hazard');
  assert.equal(xstatusAutoOn([{ changed: ago(9) }, { changed: ago(0.5) }]), true);
  assert.equal(xstatusAutoOn([{ name: 'no stamp' }]), false, 'a row with no change time can never be confirmed');
  const panels = read('js/panels.js');
  assert.match(panels, /maybeAutoXstatus\(\);\n\}/, 'renderCrossStatus must offer the layer once the data warrants it');
  assert.match(panels, /if \(state\.xstatusAutoDone \|\| !state\.map \|\| !state\.layers\.crossStatus\) return;/);
  const map = read('js/map.js');
  assert.match(map, /if \(e\.layer === state\.layers\.crossStatus\) state\.xstatusAutoDone = true;/,
    'a deliberate toggle-off must not be re-opened by the next refresh');
  assert.match(map, /\['crossStatus', '🚨', 'layers\.xstatus', 'sheet\.s\.xstatus', 'official', false\]/,
    'the sheet default stays off; the auto-enable is the only path that turns it on');
});

/* ---------- the address check shares the one geometry helper ---------- */

test('alertNearPoint reads the shared bounds helper rather than a second Leaflet copy', () => {
  const f = boxAlert('a', ...AUSTIN);
  assert.equal(alertNearPoint(f, 30.27, -97.74), true);
  assert.equal(alertNearPoint(f, 31.76, -106.49), false);
  assert.equal(alertNearPoint(zoneAlert('z'), 30.27, -97.74), false, 'an unplaceable alert covers no point');
  const board = read('js/board.js');
  const fn = board.match(/function alertNearPoint\(f, lat, lon\)[\s\S]*?\n\}/)[0];
  assert.ok(!/L\.geoJSON/.test(fn), 'the point check must not keep its own Leaflet bounds copy');
  assert.match(fn, /geoBounds\(alertGeom\(f\)\)/);
});

test('ALERT_NEAR_MI is the single radius every scoped surface reads', () => {
  assert.equal(ALERT_NEAR_MI, 50);
  for (const f of ['js/sources.js', 'js/panels.js']) {
    const hits = (read(f).match(/\b50\s*;/g) || []);
    assert.ok(hits.length <= 1, `${f} may hold at most the one radius declaration`);
  }
});

test('a new GPS fix re-leads the alerts list and the all-clear line on that position', () => {
  const map = read('js/map.js');
  const fn = map.match(/state\.map\.on\('locationfound'[\s\S]*?\n  \}\);/);
  assert.ok(fn, "the locationfound handler was not found");
  assert.match(fn[0], /renderAlertList\(\)/, 'a fix must re-scope the Alerts tab, not wait for the next refresh');
  assert.match(fn[0], /renderThreatStrip\(\)/, 'a fix must re-scope the all-clear claim with it');
});
