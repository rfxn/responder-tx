'use strict';

/* Cameras near a hazard (gauge popup, road popup, Feed river card) and the next camera along a
   road or river in the viewer. Every assertion here is on what the shipped functions return or
   paint when they run; the camera inventory is synthetic so distances and bearings are known. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadMapApp, loadApp } = require('./harness.js');
const I18N = require('./i18n-load.js');

const app = loadMapApp();
const SB = app._sandbox;
const { state } = app;

const MI_LAT = 69.09; // miles per degree of latitude, close enough to place cameras by distance
const HERE = [30.0, -97.0];
const north = (mi, from = HERE) => [from[0] + mi / MI_LAT, from[1]];
const east = (mi, from = HERE) => [from[0], from[1] + mi / (MI_LAT * Math.cos((from[0] * Math.PI) / 180))];
const GEN = '2026-10-02T17:31:10Z';
const hoursBefore = (h) => new Date(Date.parse(GEN) - h * 3600000).toISOString();

const live = (name, desc, [lat, lon]) => ({ name, description: desc, lat, lon,
  httpsurl: `https://s1.us-east-1.skyvdn.com/rtplive/${name}/playlist.m3u8` });
const its = (name, route, [lat, lon], dist = 'AUS') => ({ name, route, lat, lon, src: 'its', icd: name.replace(/\W/g, ''), dist });
const river = (camId, nwisId, [lat, lon], newest = hoursBefore(0.2)) => ({ camId, name: camId.replace(/_/g, ' '), nwisId, lat, lon, newest });

function withCams(cams, fn) {
  const saved = { cameras: state.cameras, camInvAt: state.camInvAt, camerasP: state.camerasP };
  state.cameras = Object.assign({ txdot: [], river: [] }, cams);
  state.camInvAt = GEN;
  state.camerasP = Promise.resolve(state.cameras);
  try { return fn(); } finally { Object.assign(state, saved); }
}

function withCopy(fn) {
  const prev = SB.t;
  SB.t = (k) => (I18N.en[k] !== undefined ? I18N.en[k] : k);
  try { return fn(); } finally { SB.t = prev; }
}

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const rowsOf = (html) => [...html.matchAll(/<button type="button" class="cams-near-row([^"]*)" data-i="(\d+)">[\s\S]*?aria-label="([^"]*)">([^<]*)<\/span>[\s\S]*?<span class="cnr-name">([^<]*)<\/span><span class="cnr-sub">([^<]*)<\/span>/g)]
  .map((m) => ({ off: m[1].includes('off'), i: Number(m[2]), kind: decode(m[3]), glyph: m[4], name: decode(m[5]), sub: decode(m[6]) }));
const ptsOf = (html) => (/data-pts="([^"]*)"/.exec(html) || [])[1];

/* a box shaped like the markup camsNearBtnHtml writes: what the delegated click handler works on */
function box(markup) {
  const list = { hidden: true, innerHTML: '' };
  const btnAttrs = new Map();
  const btn = { setAttribute: (k, v) => btnAttrs.set(k, v), attrs: btnAttrs };
  const classes = new Set(/class="([^"]*)"/.exec(markup)[1].split(' '));
  const pts = ptsOf(markup);
  const el = {
    list, btn, classList: { contains: (c) => classes.has(c) },
    getAttribute: (k) => (k === 'data-pts' ? pts : null),
    querySelector: (sel) => (sel === '.cams-near-list' ? list : sel === '.cams-near-btn' ? btn : null),
  };
  // what a tap on a node inside this box looks like to the document-level listener
  el.tap = (what, i) => ({ target: { closest: (sel) => (sel === '.cams-near' ? el
    : sel === '.cams-near-row' && what === 'row' ? { getAttribute: () => String(i) }
      : sel === '.cams-near-btn' && what === 'btn' ? btn : null) } });
  return el;
}

const settle = () => new Promise((r) => setImmediate(r));

/* ---------------- 5a: cameras near a hazard ---------------- */

test('nearest first within 5 mi, each with its distance and compass direction from the hazard', () => {
  const near = live('TX_AUS_001', 'IH-35 @ Riverside', north(0.8));
  const mid = its('IH35 @ Oltorf', 'IH35', east(2.4));
  const far = live('TX_AUS_003', 'IH-35 @ Slaughter', north(-4.0));
  const out = live('TX_AUS_004', 'IH-35 @ Kyle', north(-12));
  withCams({ txdot: [out, far, mid, near] }, () => withCopy(() => {
    const res = SB.camsNear([HERE]);
    assert.deepEqual(Array.from(res.rows, (r) => r.c), [near, mid, far], 'nearest first, the one 12 mi out left off');
    assert.equal(res.total, 3);
    assert.equal(res.nearest, null, 'a list with cameras in range does not also offer a nearest-elsewhere row');
    const rows = rowsOf(SB.camsNearHtml(res));
    assert.deepEqual(rows.map((r) => r.sub), [
      '0.8 mi N · TxDOT · traffic cam', '2.4 mi E · TxDOT · traffic cam', '4.0 mi S · TxDOT · traffic cam']);
    assert.deepEqual(rows.map((r) => r.glyph), ['▶', '📷', '▶'], 'a stream reads as live video, an ITS snapshot as a still');
    assert.equal(rows[0].kind, 'Live video camera');
    assert.equal(rows[1].kind, 'Still photo camera');
    assert.equal(rows[0].name, 'IH-35 @ Riverside');
    assert.ok(SB.camsNearHtml(res).startsWith('<div class="cams-near-head">Within 5 mi, nearest first</div>'));
  }));
});

test('the 5 mi edge: just inside is listed, just outside is not, and the cap says how many more there are', () => {
  const inside = live('TX_IN', 'US 290 @ A', north(4.98));
  const outside = live('TX_OUT', 'US 290 @ B', north(5.03));
  assert.ok(SB.distMi(...HERE, inside.lat, inside.lon) < 5 && SB.distMi(...HERE, outside.lat, outside.lon) > 5, 'fixture straddles the edge');
  withCams({ txdot: [outside, inside] }, () => {
    const res = SB.camsNear([HERE]);
    assert.deepEqual(Array.from(res.rows, (r) => r.c.name), ['TX_IN']);
  });
  const many = Array.from({ length: 11 }, (_, i) => live(`TX_M${i}`, `SH 71 @ ${i}`, east(0.3 * (i + 1))));
  withCams({ txdot: many }, () => withCopy(() => {
    const res = SB.camsNear([HERE]);
    assert.equal(res.rows.length, 8);
    assert.equal(res.total, 11);
    assert.ok(SB.camsNearHtml(res).endsWith('<div class="cams-near-note">+3 more within 5 mi</div>'));
  }));
});

test('none in range says so plainly and offers the nearest camera, with how far and which way', () => {
  const lone = live('TX_FAR', 'US 281 @ Blanco', east(-12.3));
  withCams({ txdot: [lone] }, () => withCopy(() => {
    const res = SB.camsNear([HERE]);
    assert.equal(res.rows.length, 0);
    assert.equal(res.nearest.c, lone);
    const html = SB.camsNearHtml(res);
    assert.ok(html.startsWith('<div class="cams-near-note">No cameras within 5 mi.</div><div class="cams-near-head">Nearest camera</div>'), html);
    assert.deepEqual(rowsOf(html).map((r) => r.sub), ['12 mi W · TxDOT · traffic cam']);
  }));
  withCams({}, () => withCopy(() => {
    assert.equal(SB.camsNearHtml(SB.camsNear([HERE])), '<div class="cams-near-note">No cameras within 5 mi.</div>',
      'an empty inventory has no nearest camera to offer');
  }));
});

test('a camera the inventory saw stop is marked with the inventory date, never shown as current', () => {
  const stopped = river('TX_Test_Rv_at_A', '08100100', north(1), hoursBefore(26));
  const fresh = river('TX_Test_Rv_at_B', '08100200', north(2), hoursBefore(0.5));
  withCams({ river: [stopped, fresh] }, () => withCopy(() => {
    const rows = rowsOf(SB.camsNearHtml(SB.camsNear([HERE])));
    assert.equal(rows[0].off, true);
    assert.equal(rows[0].glyph, '⏱');
    assert.equal(rows[0].kind, 'no image as of Oct 2', 'a verdict from a hand-run inventory says when it was made');
    assert.ok(rows[0].sub.endsWith(' · no image as of Oct 2'), rows[0].sub);
    assert.equal(rows[1].off, false);
    assert.equal(rows[1].glyph, '📷');
  }));
  const prev = { t: SB.t, lang: SB.getLang };
  try {
    SB.t = (k) => (I18N.es[k] !== undefined ? I18N.es[k] : k);
    SB.getLang = () => 'es';
    withCams({ river: [stopped] }, () => assert.equal(SB.camOfflineText(), 'sin imagen al 2 oct'));
  } finally {
    SB.t = prev.t;
    SB.getLang = prev.lang;
  }
  // no inventory clock, no claim either way
  withCams({ river: [stopped] }, () => {
    state.camInvAt = null;
    assert.equal(SB.camOffline(stopped), false);
  });
});

test('E1: an inventory that fails to load says unavailable, never "no cameras"', async () => {
  const saved = { fetch: SB.fetch, t: SB.t, cameras: state.cameras, camerasP: state.camerasP };
  try {
    state.cameras = null;
    state.camerasP = null;
    SB.fetch = () => Promise.reject(new Error('offline'));
    SB.t = (k) => (I18N.en[k] !== undefined ? I18N.en[k] : k);
    const b = box(SB.camsNearBtnHtml([HERE]));
    SB.camsNearClick(b.tap('btn'));
    assert.equal(b.list.hidden, false);
    assert.equal(b.btn.attrs.get('aria-expanded'), 'true');
    assert.equal(b.list.innerHTML, '<div class="cams-near-note">Loading cameras…</div>');
    await settle();
    assert.equal(b.list.innerHTML, `<div class="cams-near-note failed">${I18N.en['camnear.fail'].replace(/"/g, '&quot;')}</div>`);
    assert.ok(!b.list.innerHTML.includes('No cameras within'), 'a failed load must not read as an empty area');
  } finally {
    Object.assign(state, { cameras: saved.cameras, camerasP: saved.camerasP });
    SB.fetch = saved.fetch;
    SB.t = saved.t;
  }
});

test('a list that fails to build after the inventory loads says unavailable instead of loading forever', async () => {
  const saved = { near: SB.camsNear, t: SB.t };
  try {
    SB.camsNear = () => { throw new Error('bad row'); };
    SB.t = (k) => (I18N.en[k] !== undefined ? I18N.en[k] : k);
    await withCams({ txdot: [live('TX_X', 'IH-35 @ X', HERE)] }, async () => {
      const b = box(SB.camsNearBtnHtml([HERE]));
      SB.camsNearClick(b.tap('btn'));
      await settle();
      assert.ok(b.list.innerHTML.includes('class="cams-near-note failed"'), b.list.innerHTML);
    });
  } finally {
    SB.camsNear = saved.near;
    SB.t = saved.t;
  }
});

test('a tap opens the list from the inventory, and a row opens that camera in the viewer', async () => {
  const cam = live('TX_AUS_010', 'Loop 1 @ 35th', east(1.5));
  const saved = { fetch: SB.fetch, open: SB.openCamViewer, cameras: state.cameras, camerasP: state.camerasP, camLayerList: state.camLayerList };
  const opened = [];
  try {
    state.cameras = null;
    state.camerasP = null;
    state.camLayerList = null;
    SB.fetch = async (url) => {
      assert.ok(String(url).startsWith('data/cameras.json'));
      return { ok: true, status: 200, json: async () => ({ generated: GEN, txdot: [cam], river: [] }) };
    };
    SB.openCamViewer = (c, kind) => opened.push({ c, kind });
    const b = box(SB.camsNearBtnHtml([HERE]));
    SB.camsNearClick(b.tap('btn'));
    await settle();
    await settle();
    assert.equal(state.camInvAt, GEN, 'the inventory clock is kept for the offline test');
    assert.equal(rowsOf(b.list.innerHTML).length, 1);
    SB.camsNearClick(b.tap('row', 0));
    assert.equal(opened.length, 1);
    assert.equal(opened[0].c.name, 'TX_AUS_010');
    assert.equal(opened[0].kind, 'txdot');
    SB.camsNearClick(b.tap('btn'));
    assert.equal(b.list.hidden, true, 'a second tap folds the list away');
  } finally {
    Object.assign(state, { cameras: saved.cameras, camerasP: saved.camerasP, camLayerList: saved.camLayerList });
    SB.fetch = saved.fetch;
    SB.openCamViewer = saved.open;
  }
});

test('a long road closure is near every camera along it, not only the one by its midpoint', () => {
  const west = HERE, far = east(30);
  const coords = Array.from({ length: 40 }, (_, i) => [west[1] + ((far[1] - west[1]) * i) / 39, west[0]]);
  const geo = { type: 'LineString', coordinates: coords };
  const html = SB.roadPopupHtml({ condition: 'Flooding', route_name: 'US0290', description: 'High water' }, geo);
  const pts = SB.camsNearPts(ptsOf(html));
  assert.equal(pts.length, 12, 'a long line is sampled, not sent whole');
  assert.deepEqual(Array.from(pts[0]), [west[0], Number(west[1].toFixed(5))]);
  const atEnd = live('TX_END', 'US 290 @ End', north(0.5, far));
  withCams({ txdot: [atEnd] }, () => {
    const res = SB.camsNear(pts);
    assert.equal(res.rows.length, 1, 'a camera 30 mi from where the closure starts is still beside it');
    assert.ok(res.rows[0].d < 0.6, `measured from the nearest part of the closure, got ${res.rows[0].d}`);
  });
  const point = SB.roadPopupHtml({ condition: 'Closure', route_name: 'FM0150' }, { type: 'Point', coordinates: [HERE[1], HERE[0]] });
  assert.equal(ptsOf(point), `${HERE[0].toFixed(5)},${HERE[1].toFixed(5)}`, 'a point closure carries the control too');
  assert.equal(ptsOf(SB.roadPopupHtml({ condition: 'Closure' })), undefined, 'no geometry, no control rather than a guess');
});

test('the gauge popup carries the control at the gauge, and the Feed river and rising cards do too', () => {
  const g = {
    lid: 'COMT2', name: 'Guadalupe River at Comfort', latitude: 29.9688, longitude: -98.8939,
    status: {
      observed: { primary: 19.2, primaryUnit: 'ft', floodCategory: 'moderate', validTime: new Date(Date.now() - 600000).toISOString() },
      forecast: { primary: 24.0, primaryUnit: 'ft', floodCategory: 'major', validTime: new Date(Date.now() + 6 * 3600000).toISOString() },
    },
  };
  const saved = { camerasP: state.camerasP, fetch: SB.fetch };
  try {
    state.camerasP = new Promise(() => {});
    SB.fetch = () => new Promise(() => {});
    const el = SB.gaugePopup(g);
    assert.equal(ptsOf(el.innerHTML), '29.96880,-98.89390');
    assert.ok(el.innerHTML.indexOf('cams-near-btn') < el.innerHTML.indexOf('class="popup-link"'), 'above the NOAA link');
  } finally {
    Object.assign(state, { camerasP: saved.camerasP });
    SB.fetch = saved.fetch;
  }
  const base = {
    alerts: [], gauges: [g], gaugesDegraded: [], roadClosures: { lines: [], points: [] }, roadsUnknown: false,
    roadsFallbackAt: null, snapshotAt: null, alertsLoadedOnce: true, seedsLoadedOnce: false, sheltersUnknown: false,
    sourceHealth: { alerts: Date.now(), gauges: Date.now(), roads: Date.now() }, sourceFailed: {}, trendHist: {}, records: {}, pb: null,
  };
  // the Feed's situation view reads panels.js helpers, which only the page bundle carries
  const page = loadApp();
  const PSB = page._sandbox;
  const keep = { t: PSB.t };
  for (const k of Object.keys(base)) keep[k] = page.state[k];
  Object.assign(page.state, base);
  PSB.t = (k) => (I18N.en[k] !== undefined ? I18N.en[k] : k);
  try {
    const { html } = PSB.situationView(PSB.situationModel());
    const rows = [...html.matchAll(/<div class="sit-row">([\s\S]*?)<div class="cams-near-list" hidden><\/div><\/div><\/div>/g)].map((m) => m[1]);
    assert.equal(rows.length, 2, 'the river-in-flood card and the rising card each carry one');
    for (const r of rows) {
      assert.ok(r.startsWith('<button type="button" class="sit-card'), 'the camera button sits beside the card, not inside it');
      assert.ok(r.includes('aria-label="Cameras near Guadalupe River at Comfort"'), r);
      assert.equal(ptsOf(r), '29.96880,-98.89390');
    }
  } finally {
    PSB.t = keep.t;
    delete keep.t;
    Object.assign(page.state, keep);
  }
});

test('a Feed list the reader opened is opened again after the Feed repaints', async () => {
  const cam = live('TX_AUS_020', 'IH-35 @ 6th', north(0.4));
  const saved = { cameras: state.cameras, camerasP: state.camerasP };
  try {
    state.cameras = { txdot: [cam], river: [] };
    state.camerasP = Promise.resolve(state.cameras);
    const markup = SB.camsNearBtnHtml([HERE], 'X', true);
    const first = box(markup);
    SB.camsNearClick(first.tap('btn'));
    await settle();
    const repainted = box(markup);
    SB.camsNearReopen({ querySelectorAll: (sel) => (sel === '.cams-near.sit-cams' ? [repainted] : []) });
    await settle();
    assert.equal(repainted.list.hidden, false);
    assert.equal(rowsOf(repainted.list.innerHTML).length, 1);
    SB.camsNearClick(repainted.tap('btn'));
    const again = box(markup);
    SB.camsNearReopen({ querySelectorAll: () => [again] });
    assert.equal(again.list.hidden, true, 'one the reader closed stays closed');
  } finally {
    Object.assign(state, saved);
  }
});

/* ---------------- 5c: the next camera along a road or river ---------------- */

test('a TxDOT camera names its road from the route field or the text before "@"', () => {
  const road = (c) => { const r = SB.camRoad(c, 'txdot'); return r && r.label; };
  assert.equal(road({ description: 'IH-10 East @ Gregg' }), 'I-10');
  assert.equal(road({ description: 'IH 10 at Callaghan West' }), 'I-10');
  assert.equal(road({ route: 'I-10 Katy', name: 'IH-10ML @ Dairy Ashford', src: 'its' }), 'I-10');
  assert.equal(road({ description: 'IH35E @ Frankford South' }), 'I-35E', 'I-35E and I-35 are different roads');
  assert.equal(road({ description: 'US-90A @ Hiram Clarke' }), 'US 90A');
  assert.equal(road({ description: 'LP1604 @ Hausman Rd' }), 'Loop 1604');
  assert.equal(road({ description: 'CCTV_Loop 289 @ 4th' }), 'Loop 289');
  assert.equal(road({ route: 'unspecified', name: 'US259 @ SH64', src: 'its' }), 'US 259', 'an unnamed route falls back to the camera name');
  assert.equal(road({ route: 'West Sam Houston Parkway', src: 'its' }), 'Beltway 8');
  assert.equal(road({ route: 'BW8E', src: 'its' }), 'Beltway 8');
  assert.equal(road({ route: 'Hardy Toll Road', src: 'its' }), 'Hardy Toll Road');
  assert.equal(SB.camRoad({ name: 'PCMS-CCTV-913-0501', description: 'PCMS-CCTV-913-0501' }, 'txdot'), null, 'a portable sign camera has no road');
  assert.equal(SB.camRoad({ name: 'LAMAR BLVD / 5TH ST' }, 'austin'), null, 'only TxDOT rows are stepped by road');
  // a carriageway or loop-side suffix is the same road; a lettered interstate is not
  assert.equal(road({ description: 'IH10E' }), 'I-10');
  assert.equal(road({ description: 'US385N @ LP388 NE' }), 'US 385');
  assert.equal(road({ description: 'IH820WL @ Chapin' }), 'I-820');
  assert.equal(road({ description: 'IH35W @ Morningside' }), 'I-35W');
  assert.equal(road({ description: 'IH69E @ McCullough' }), 'I-69E');
});

// verbatim rows from data/cameras.json (2026-10-02): Lonestar names the loop side, ITS names the route
const FW_820 = [
  { name: 'TX_FTW_064', description: 'IH820NL @ US377', lat: 32.838944, lon: -97.263639, httpsurl: 'https://s69.us-east-1.skyvdn.com/rtplive/TX_FTW_064/playlist.m3u8' },
  { name: 'TX_FTW_063', description: 'IH820NL @ Haltom', lat: 32.83921, lon: -97.27709, httpsurl: 'https://s69.us-east-1.skyvdn.com/rtplive/TX_FTW_063/playlist.m3u8' },
  { name: 'TX_FTW_062', description: 'IH820NL @ Beach', lat: 32.839745, lon: -97.287154, httpsurl: 'https://s69.us-east-1.skyvdn.com/rtplive/TX_FTW_062/playlist.m3u8' },
  { name: 'IH820NL @ Beach (NTE)', route: 'IH-820', lat: 32.839395, lon: -97.291502, src: 'its', icd: 'IH820NL @ Beach (NTE)', dist: 'FTW' },
  { name: 'IH820NL @ Riverside (NTE)', route: 'IH-820', lat: 32.839061, lon: -97.299248, src: 'its', icd: 'IH820NL @ Riverside (NTE)', dist: 'FTW' },
  { name: 'TX_FTW_165', description: 'IH820NL @ Mark IV', lat: 32.839811, lon: -97.321562, httpsurl: 'https://s72.us-east-1.skyvdn.com/rtplive/TX_FTW_165/playlist.m3u8' },
  { name: 'IH820NL @ US377', route: 'IH-820', lat: 32.83982, lon: -97.261859, src: 'its', icd: 'IH820NL @ US377', dist: 'FTW' },
  { name: 'IH820NL @ Meadow Lakes (NTE)', route: 'IH-820', lat: 32.840181, lon: -97.246068, src: 'its', icd: 'IH820NL @ Meadow Lakes (NTE)', dist: 'FTW' },
  { name: 'TX_FTW_065', description: 'IH820NL @ Rufe Snow', lat: 32.840639, lon: -97.239139, httpsurl: 'https://s69.us-east-1.skyvdn.com/rtplive/TX_FTW_065/playlist.m3u8' },
];

test('the Fort Worth loop is one road whichever source names a camera, so Next means one direction', () => {
  withCams({ txdot: FW_820 }, () => withCopy(() => {
    for (const c of FW_820) assert.equal(SB.camRoad(c, 'txdot').label, 'I-820', c.description || c.name);
    const lonestarBeach = FW_820[2], itsBeach = FW_820[3];
    const a = SB.camNeighbours(lonestarBeach, 'txdot'), b = SB.camNeighbours(itsBeach, 'txdot');
    assert.ok([a.prev && a.prev.c, a.next && a.next.c].includes(itsBeach), 'the two Beach Street cameras sit side by side on one line');
    const west = (nb) => nb.next.c.lon < (nb === a ? lonestarBeach : itsBeach).lon;
    assert.equal(west(a), west(b), 'Next points the same way from both cameras at one interchange');
    const labels = [...SB.camNavHtml(a).matchAll(/>([^<]*)<\/button>/g)].map((m) => m[1]);
    assert.deepEqual(labels, ['‹ Previous on I-820 · 0.3 mi W', 'Next on I-820 · 0.6 mi E ›'], 'the road is never shown as "I-820NL"');
    const seq = [];
    for (let at = FW_820.find((c) => c.name === 'TX_FTW_165'), k = 0; at && k < FW_820.length; k++) {
      seq.push(at.lon);
      const nb = SB.camNeighbours(at, 'txdot');
      at = nb && nb.next && nb.next.c;
    }
    assert.equal(seq.length, FW_820.length, 'one walk from the west end reaches every camera on the north loop');
    assert.ok(seq.every((lon, i) => !i || lon >= seq[i - 1]), `ordered west to east: ${seq.join(', ')}`);
  }));
});

test('next and previous step along the road in order, with ends and the label the viewer shows', () => {
  const pts = [0, 1.2, 2.5, 4.0, 6.1].map((mi) => east(mi));
  const cams = pts.map((p, i) => live(`TX_SAT_${i}`, `IH-10 @ Exit ${i}`, p));
  const shuffled = [cams[3], cams[0], cams[4], cams[2], cams[1]];
  withCams({ txdot: shuffled }, () => withCopy(() => {
    const mid = SB.camNeighbours(cams[2], 'txdot');
    assert.equal(mid.label, 'I-10');
    assert.equal(mid.next.c, cams[3]);
    assert.equal(mid.prev.c, cams[1]);
    assert.equal(mid.next.where, '1.5 mi E');
    const html = SB.camNavHtml(mid);
    assert.ok(html.includes('>‹ Previous on I-10 · 1.3 mi W</button>'), html);
    assert.ok(html.includes('>Next on I-10 · 1.5 mi E ›</button>'), html);
    const west = SB.camNeighbours(cams[0], 'txdot');
    assert.equal(west.prev, null, 'the west end has nothing behind it');
    assert.equal(west.next.c, cams[1]);
    assert.ok(!SB.camNavHtml(west).includes('data-nav="prev"'));
    const eastEnd = SB.camNeighbours(cams[4], 'txdot');
    assert.equal(eastEnd.next, null);
    assert.equal(eastEnd.prev.c, cams[3]);
  }));
});

test('no road, a road with one camera, or a camera 20+ mi from the rest has no neighbour to offer', () => {
  const pcms = live('PCMS-CCTV-913-0501', 'PCMS-CCTV-913-0501', HERE);
  const lone = live('TX_LONE', 'SH 29 @ Main', north(1));
  const a = live('TX_A', 'US 281 @ A', HERE), b = live('TX_B', 'US 281 @ B', north(2));
  const remote = live('TX_C', 'US 281 @ C', north(40));
  withCams({ txdot: [pcms, lone, a, b, remote] }, () => {
    assert.equal(SB.camNeighbours(pcms, 'txdot'), null);
    assert.equal(SB.camNeighbours(lone, 'txdot'), null);
    assert.equal(SB.camNeighbours(remote, 'txdot'), null, 'the next camera 38 mi up the road is another stretch');
    assert.equal(SB.camNeighbours(b, 'txdot').next, null);
    assert.equal(SB.camNeighbours(b, 'txdot').prev.c, a);
    assert.equal(SB.camNavHtml(null), '');
  });
});

// the shape of the live I-635 inventory, where "IH635 @ Coit east" sits 9 mi south of the freeway
test('a camera placed far off the line its road neighbours draw is stepped over, not visited', () => {
  const line = Array.from({ length: 15 }, (_, mi) => live(`TX_L${mi}`, `IH-635 @ ${mi}`, east(mi)));
  const stray = live('TX_STRAY', 'IH-635 @ Coit east', north(-9, east(7.5)));
  withCams({ txdot: line.concat(stray) }, () => {
    assert.equal(SB.camNeighbours(line[7], 'txdot').next.c, line[8]);
    assert.equal(SB.camNeighbours(line[8], 'txdot').prev.c, line[7]);
    assert.equal(SB.camNeighbours(stray, 'txdot'), null);
  });
});

test('a full loop road closes on itself; a straight one never does', () => {
  const C = [29.42, -98.49];
  const ring = Array.from({ length: 12 }, (_, i) => {
    const a = (i * 2 * Math.PI) / 12;
    return live(`TX_R${i}`, `LP410 @ ${i}`, [C[0] + (Math.sin(a) * 8) / MI_LAT, C[1] + (Math.cos(a) * 8) / (MI_LAT * Math.cos((C[0] * Math.PI) / 180))]);
  });
  withCams({ txdot: ring.slice().reverse() }, () => {
    const seen = new Set();
    let at = ring[0];
    for (let k = 0; k < 12; k++) { seen.add(at); at = SB.camNeighbours(at, 'txdot').next.c; }
    assert.equal(seen.size, 12, 'twelve steps visit every camera once');
    assert.equal(at, ring[0], 'and come back round to the start');
  });
});

test('river cameras step downstream by USGS station number; a stopped one is skipped only on a fresh inventory', () => {
  // the inventory clock is set from now here, because freshness is a question about now
  const invAt = (agoH) => new Date(Date.now() - agoH * 3600000).toISOString();
  const cam = (camId, nwisId, ll, newestBeforeInvH, agoH) => ({ ...river(camId, nwisId, ll), newest: new Date(Date.parse(invAt(agoH)) - newestBeforeInvH * 3600000).toISOString() });
  const build = (agoH) => {
    const c = {
      dallas: cam('TX_Trinity_Rv_at_Dallas', '08057000', [32.775, -96.822], 0.2, agoH),
      rosser: cam('TX_Trinity_Rv_nr_Rosser', '08062500', [32.426, -96.463], 30, agoH),
      cayuga: cam('TX_Trinity_Rvr_at_Hwy_287_nr_Cayuga_TX', '08064570', [31.996, -95.992], 0.2, agoH),
      fork: cam('TX_E_Fk_Trinity_Rv_nr_Crandall', '08062000', [32.63, -96.47], 0.2, agoH),
      lake: cam('TX_Addicks_Reservoir_near_Addicks', '08073000', [29.79, -95.62], 0.2, agoH),
    };
    return c;
  };
  const fresh = build(3);
  withCams({ river: [fresh.cayuga, fresh.fork, fresh.dallas, fresh.rosser, fresh.lake] }, () => withCopy(() => {
    state.camInvAt = invAt(3);
    const nb = SB.camNeighbours(fresh.dallas, 'river');
    assert.equal(nb.label, 'Trinity River');
    assert.equal(nb.prev, null, 'Dallas is the furthest upstream camera on the Trinity');
    assert.equal(nb.next.c, fresh.cayuga, 'a 3 h old inventory saw Rosser stop a day before, so it is stepped over');
    assert.ok(SB.camNavHtml(nb).includes('>Downstream on Trinity River · 72 mi SE ›</button>'), SB.camNavHtml(nb));
    assert.equal(SB.camNeighbours(fresh.cayuga, 'river').prev.c, fresh.dallas);
    assert.ok(SB.camNavHtml(SB.camNeighbours(fresh.cayuga, 'river')).includes('‹ Upstream on Trinity River'));
    assert.equal(SB.camNeighbours(fresh.fork, 'river'), null, 'the East Fork is its own river');
    assert.equal(SB.camNeighbours(fresh.lake, 'river'), null, 'a reservoir is not stepped along');
    assert.equal(SB.camRiver({ camId: 'TX_San_Antonio_River_at_East_Nueva_St', nwisId: '89898989' }, 'river'), null,
      'a placeholder station number cannot order anything');
  }));
  const old = build(24 * 30);
  withCams({ river: [old.cayuga, old.dallas, old.rosser] }, () => withCopy(() => {
    state.camInvAt = invAt(24 * 30);
    const nb = SB.camNeighbours(old.dallas, 'river');
    assert.equal(nb.next.c, old.rosser, 'a month-old verdict does not hide a camera that may be back');
    const day = new Date(Date.parse(state.camInvAt)).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric' });
    assert.ok(SB.camNavHtml(nb).includes(`>Downstream on Trinity River · 32 mi SE · ⏱ no image as of ${day} ›</button>`), SB.camNavHtml(nb));
  }));
});

test('a same-named stream joins the chain only in the same HUC region and within reach of the last camera', () => {
  const a = river('TX_Cedar_Ck_at_A', '08062700', [32.30, -96.30]);
  const b = river('TX_Cedar_Ck_at_B', '08062900', [32.10, -96.10]);
  const farAway = river('TX_Cedar_Ck_at_C', '08150000', [30.20, -98.90]);
  const otherRegion = river('TX_Cedar_Ck_at_D', '07330000', [32.40, -96.40]);
  withCams({ river: [a, b, farAway, otherRegion] }, () => {
    assert.equal(SB.camNeighbours(a, 'river').next.c, b);
    assert.equal(SB.camNeighbours(b, 'river').next, null, 'a Cedar Creek 200 mi away in another basin is not downstream of this one');
    assert.equal(SB.camNeighbours(farAway, 'river'), null);
    assert.equal(SB.camNeighbours(otherRegion, 'river'), null, 'a station in HUC region 07 is never on an 08 stream');
  });
});

test('the viewer paints the road control when it opens a camera, and a tap steps to the neighbour', () => {
  const cams = [0, 1, 2].map((mi) => its(`IH20 @ ${mi}`, 'IH-20', east(mi), 'FTW'));
  const [plat, plon] = north(3);
  const lone = { name: 'PCMS-CCTV-1', description: 'PCMS-CCTV-1', lat: plat, lon: plon };
  const listeners = [];
  const focused = [];
  const sides = () => [...nav.innerHTML.matchAll(/data-nav="(prev|next)"/g)].map((m) => m[1]);
  const nav = { hidden: true, innerHTML: '',
    querySelectorAll: (sel) => (sel !== '.cam-nav-btn' ? [] : sides().map((side) => ({
      getAttribute: () => side, addEventListener: (type, fn) => listeners.push({ side, type, fn }) }))),
    querySelector: (sel) => {
      const want = /\.cam-nav-btn\.(prev|next)$/.exec(sel);
      const side = want ? sides().find((s) => s === want[1]) : sel === '.cam-nav-btn' ? sides()[0] : null;
      return side ? { focus: () => focused.push(side) } : null;
    } };
  const el = () => ({ hidden: false, innerHTML: '', textContent: '', querySelector: () => null, appendChild() {}, setAttribute() {}, removeAttribute() {} });
  const els = { '#cam-viewer': el(), '#cam-title': el(), '#cam-stage': el(), '#cam-meta': el(), '#cam-note': el(), '#cam-nav': nav };
  const saved = { qs: SB.document.querySelector, fetch: SB.fetch, open: SB.openCamViewer };
  try {
    SB.document.querySelector = (sel) => els[sel] || null;
    SB.fetch = () => new Promise(() => {});
    withCams({ txdot: cams.concat(lone) }, () => withCopy(() => {
      SB.openCamViewer(cams[1], 'txdot');
      assert.equal(nav.hidden, false);
      assert.ok(nav.innerHTML.includes('Previous on I-20 · 1.0 mi W') && nav.innerHTML.includes('Next on I-20 · 1.0 mi E'), nav.innerHTML);
      const opened = [];
      SB.openCamViewer = (c, kind) => opened.push({ c, kind });
      listeners.find((l) => l.side === 'next' && l.type === 'click').fn();
      assert.equal(opened[0].c, cams[2]);
      SB.openCamViewer = saved.open;
      // a real step: the buttons are rebuilt, and the keyboard lands on the one still there at the road's end
      const latest = (side) => listeners.filter((l) => l.side === side && l.type === 'click').pop().fn;
      focused.length = 0;
      SB.openCamViewer(cams[1], 'txdot');
      latest('next')();
      assert.ok(!nav.innerHTML.includes('data-nav="next"'), 'the east end has no Next');
      assert.deepEqual(focused, ['prev'], 'focus moves to Previous rather than dropping to the page');
      focused.length = 0;
      latest('prev')();
      assert.ok(nav.innerHTML.includes('data-nav="next"') && nav.innerHTML.includes('data-nav="prev"'));
      assert.deepEqual(focused, ['prev'], 'stepping back keeps focus on Previous');
      SB.openCamViewer(lone, 'txdot');
      assert.equal(nav.hidden, true, 'a camera with no road hides the control');
      assert.equal(nav.innerHTML, '');
    }));
  } finally {
    SB.document.querySelector = saved.qs;
    SB.fetch = saved.fetch;
    SB.openCamViewer = saved.open;
    state.camGen += 1;
  }
});
