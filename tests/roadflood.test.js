/* Houston TranStar roadway flood warnings. Two claims this layer must never make: that a warning
   is a flooded or closed road (TranStar says only that the risk is high), and that a failed read
   is a day with no warnings. Every assertion here runs the shipped code. */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadMapApp, loadFullApp, loadWiredMap } = require('./harness.js');
const I18N = require('./i18n-load.js');

const mapApp = loadMapApp();
const MS = mapApp.state;
const MSB = mapApp._sandbox;

const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
const SRC = (over) => Object.assign({ key: 'transtar', name: 'Houston TranStar Roadway Flood Warning System',
  url: 'https://www.houstontranstar.org/about_transtar/about_rfws.aspx', status: 'ok',
  captured: hoursAgo(0.05), count: 1, skipped: 0 }, over);
const OBS = hoursAgo(0.25);
const WARN = { id: 'transtar:5353', sensor: 5353, name: 'Dickinson Bayou @ HWY 3', lat: 29.45688,
  lon: -95.04682, radiusMi: 0.5, observed: OBS, stageFt: 2.5, stageAt: OBS,
  bankFt: 3.5, shef: null, url: 'https://www.harriscountyfws.org/GageDetail/Index/5350?v=streamelevation' };
const payload = (warnings, src) => ({ generated: hoursAgo(0.05), sources: [SRC(src)],
  warnings: warnings || [WARN] });

// every case sets the whole payload it describes and puts the previous one back
function withData(doc, fn, unknown) {
  const prev = { d: MS.roadFlood, u: MS.roadFloodUnknown };
  MS.roadFlood = doc;
  MS.roadFloodUnknown = !!unknown;
  try { return fn(); } finally { MS.roadFlood = prev.d; MS.roadFloodUnknown = prev.u; }
}

// the harness t() echoes keys; this substitutes real templates where the number matters
function withT(table, fn) {
  const prev = MSB.t;
  MSB.t = (k) => (Object.prototype.hasOwnProperty.call(table, k) ? table[k] : k);
  try { return fn(); } finally { MSB.t = prev; }
}

/* The harness L is a proxy that answers every call with itself; this keeps what the renderer built,
   and invokes a lazily bound popup the way Leaflet does on the first click. */
function drawn(doc) {
  const prev = { layers: MS.layers, L: MSB.L, d: MS.roadFlood };
  const out = [];
  const shape = (kind) => (...args) => {
    const o = { kind, args, opts: args[args.length - 1] || {} };
    o.bindPopup = (p) => { o.popup = typeof p === 'function' ? p() : p; return o; };
    o.addTo = () => o; o.on = () => o;
    return o;
  };
  try {
    MSB.L = new Proxy({}, { get: (_t, prop) => (['circle', 'marker', 'divIcon'].includes(prop) ? shape(prop) : () => ({})) });
    MS.layers = Object.assign({}, MS.layers, { roadFlood: { clearLayers() { out.length = 0; }, addLayer(l) { out.push(l); } } });
    MS.roadFlood = doc;
    MSB.renderRoadFlood();
    return out;
  } finally { MS.layers = prev.layers; MSB.L = prev.L; MS.roadFlood = prev.d; }
}
const iconHtml = (o) => ((o.opts.icon || {}).args || [{}])[0].html || '';
const popupOf = (w, src) => drawn(payload([w], src)).find((o) => o.kind === 'marker').popup;

test('each warning draws its area as a circle at the stated radius, then a marker on top', () => {
  const out = drawn(payload());
  assert.deepEqual(out.map((o) => o.kind), ['circle', 'marker'],
    'the area must be added before the marker so the marker stays clickable');
  const [circle, marker] = out;
  assert.deepEqual(Array.from(circle.args[0]), [WARN.lat, WARN.lon]);
  assert.equal(mapApp.ROADFLOOD_M_PER_MI, 1609.34);
  assert.ok(Math.abs(circle.opts.radius - 0.5 * 1609.34) < 0.01, `radius ${circle.opts.radius} is not 0.5 mi in metres`);
  assert.equal(circle.opts.interactive, false, 'the area must never take a tap off a road or an alert under it');
  assert.equal(circle.opts.className, 'rflood-area');
  assert.ok(circle.opts.dashArray, 'the area must be styled unlike a solid alert polygon');
  assert.match(iconHtml(marker), /class="rflood-icon"/);
  assert.match(iconHtml(marker), /aria-label="layers\.rflood"/, 'the marker must name its layer for a screen reader');
  assert.ok(marker.opts.zIndexOffset > 1000, 'the marker must sit above every gauge marker');
});

test('a warning with no stated radius is still drawn, as a marker alone; one with no location is not', () => {
  const out = drawn(payload([Object.assign({}, WARN, { radiusMi: null }),
    Object.assign({}, WARN, { id: 'transtar:2', lat: null })]));
  assert.deepEqual(out.map((o) => o.kind), ['marker']);
  assert.deepEqual(drawn(payload([])), [], 'a genuine zero draws nothing');
});

test('a warning whose sensor stopped reporting is drawn aged, not dropped and not asserted as current', () => {
  const old = Object.assign({}, WARN, { observed: hoursAgo(mapApp.ROADFLOOD_STALE_H + 0.5) });
  const [circle, marker] = drawn(payload([old]));
  assert.equal(circle.opts.className, 'rflood-area aged');
  assert.match(iconHtml(marker), /class="rflood-icon unconfirmed"/);
  assert.equal(mapApp.roadFloodStale(WARN), false);
  assert.equal(mapApp.roadFloodStale(Object.assign({}, WARN, { observed: null })), true,
    'an undated warning cannot be asserted as current');
  assert.match(iconHtml(drawn(payload([Object.assign({}, WARN, { observed: null })]))[1]), /unconfirmed/);
});

test('the popup says high risk, never a confirmed flooded or closed road, and credits TranStar and HCFCD', () => {
  const html = popupOf(WARN);
  assert.match(html, /rfw\.risk/);
  assert.match(html, /rfw\.notconfirmed/);
  assert.match(html, /rfw\.credit/);
  assert.match(html, /Dickinson Bayou @ HWY 3/);
  for (const lang of ['en', 'es']) {
    assert.match(I18N[lang]['rfw.risk'], /high risk of roadway flooding|alto riesgo de inundación vial/i);
    assert.match(I18N[lang]['rfw.notconfirmed'], /does not confirm|no confirma/i);
    assert.match(I18N[lang]['rfw.credit'], /TranStar/);
    assert.match(I18N[lang]['rfw.credit'], /Harris County Flood Control District|Condado de Harris/);
    // the names never mention a closure at all; the descriptions only ever deny one
    for (const k of ['rfw.risk', 'layers.rflood', 'legend.rflood']) {
      assert.doesNotMatch(I18N[lang][k], /clos|cerrad|cierre/i, `${lang} ${k} must not speak of closures`);
    }
    for (const k of ['sheet.s.rflood', 'sheet.s.rflood.n', 'glossary.rflood']) {
      assert.match(I18N[lang][k], /not confirmed|not a report|no cierres|no son cierres|no un informe/i,
        `${lang} ${k} must say the warning is not a confirmed closure`);
    }
  }
});

test('the reading is compared with the top of bank, and a reading above bank says so plainly', () => {
  const T = { 'rfw.ft': '{n} ft', 'rfw.above': '{d} ft above bank ({b} ft)',
    'rfw.below': '{d} ft below bank ({b} ft)', 'rfw.atbank': 'at bank ({b} ft)' };
  withT(T, () => {
    const over = popupOf(Object.assign({}, WARN, { stageFt: 4.25, bankFt: 3.5 }));
    assert.match(over, /4\.25 ft · 0\.75 ft above bank \(3\.5 ft\)/);
    assert.match(over, /class="wf-v rfw-over"/, 'an above-bank reading must be set apart, not read as routine');
    const under = popupOf(WARN);
    assert.match(under, /2\.5 ft · 1 ft below bank \(3\.5 ft\)/);
    assert.doesNotMatch(under, /rfw-over/);
    assert.match(popupOf(Object.assign({}, WARN, { stageFt: 3.5 })), /3\.5 ft · at bank \(3\.5 ft\)/);
    // no bank stated: the reading alone, with no invented comparison
    const nobank = popupOf(Object.assign({}, WARN, { bankFt: null }));
    assert.match(nobank, /<dd class="wf-v">2\.5 ft<\/dd>/);
  });
  const staleOver = popupOf(Object.assign({}, WARN, { stageFt: 4.25, stageAt: hoursAgo(10) }));
  assert.match(staleOver, /class="wf-v rfw-over xg-stale"/,
    'a ten-hour-old above-bank reading must not read like a current one');
  const none = popupOf(Object.assign({}, WARN, { stageFt: null }));
  assert.match(none, /rfw\.k\.reading/, 'the reading row is drawn even when nothing was reported');
  assert.match(none, /wf\.unreported/, 'an unreported reading is named as such, never drawn as 0');
});

test('the popup states the observation age and marks it when the sensor has gone quiet', () => {
  assert.match(popupOf(WARN), /rfw\.k\.observed/);
  assert.doesNotMatch(popupOf(WARN), /rfw\.stale|rfw\.undated/);
  const old = popupOf(Object.assign({}, WARN, { observed: hoursAgo(5), stageAt: hoursAgo(5) }));
  withT({ 'rfw.stale': 'No sensor report in {h}h' }, () => {
    assert.match(popupOf(Object.assign({}, WARN, { observed: hoursAgo(5) })), /No sensor report in 5h/);
  });
  assert.match(old, /wf-tag is-stale/);
  assert.match(old, /xg-stale/, 'the age uses the board staleness treatment');
  assert.doesNotMatch(popupOf(WARN), /rfw\.k\.readat/, 'one stamp for warning and reading is stated once');
  const lagging = popupOf(Object.assign({}, WARN, { stageAt: hoursAgo(4) }));
  assert.match(lagging, /rfw\.k\.readat/, 'a reading older than the warning must carry its own time');
  assert.match(lagging, /<dd class="wf-v xg-stale">[^<]*<\/dd>\s*<dt class="wf-k">rfw\.k\.readat/,
    'a stale reading is marked stale beside the figure');
  const undated = popupOf(Object.assign({}, WARN, { observed: null, stageAt: null }));
  assert.match(undated, /rfw\.undated/);
  assert.match(undated, /wf\.unreported/, 'an unstated time is drawn as a gap');
});

test('the popup links the sensor page, falling back to the HCFCD system by name, and the TranStar description', () => {
  const html = popupOf(WARN);
  assert.ok(html.includes(`href="${WARN.url}"`), 'a stated sensor page must be linked');
  assert.match(html, /rfw\.link\.sensor/);
  assert.ok(html.includes('href="https://www.houstontranstar.org/about_transtar/about_rfws.aspx"'));
  for (const url of [null, '', 'javascript:alert(1)']) {
    const fb = popupOf(Object.assign({}, WARN, { url }));
    assert.ok(fb.includes('href="https://www.harriscountyfws.org/"'), `url ${url} must fall back to the HCFCD system`);
    // not every sensor is HCFCD's, so the fallback may not call itself this sensor's page
    assert.match(fb, /rfw\.link\.system/);
    assert.doesNotMatch(fb, /rfw\.link\.sensor/);
    assert.ok(!fb.includes('javascript:'), 'a non-http link must never be rendered');
  }
  assert.ok(popupOf(Object.assign({}, WARN, { name: '<img src=x onerror=1>' })).includes('&lt;img'),
    'the sensor name is upstream text and must be escaped');
});

test('a warning carried from an earlier read says so in its popup', () => {
  assert.match(popupOf(WARN, { status: 'carried', carriedFrom: hoursAgo(0.5) }), /rfw\.carried\.tag/);
  assert.doesNotMatch(popupOf(WARN), /rfw\.carried\.tag/);
});

/* ---------- E1: an unreadable or failed feed is never "no warnings" ---------- */

test('the layer sentence tells a genuine zero apart from every kind of failure', () => {
  const notice = (doc, unknown) => withData(doc, () => MSB.roadFloodNoticeText(), unknown);
  assert.equal(notice(payload([])), 'rfw.none', 'a fresh read with no warnings is a reportable absence');
  assert.equal(notice(payload([], { captured: hoursAgo(3) })), 'rfw.none.aged',
    'a feed that stopped updating cannot vouch for an all-clear');
  assert.equal(notice(payload([], { captured: null })), 'rfw.none.undated',
    'our own file stamp is rewritten every cycle, so it may never date an all-clear');
  assert.equal(notice(payload([], { status: 'failed', count: null })), 'rfw.unknown');
  assert.equal(notice(null, true), 'rfw.unknown', 'an unreadable file is unknown');
  assert.equal(notice(null), 'rfw.unknown', 'no payload is never an absence');
  assert.equal(notice(payload([WARN], { status: 'carried', carriedFrom: hoursAgo(0.5) })), 'rfw.carried');
  assert.equal(notice(payload([WARN], { status: 'mystery' })), 'rfw.unknown', 'an unknown status is not a read');
  assert.equal(notice(payload([WARN], { skipped: 2 })), 'rfw.skipped', 'an undrawn warning must be admitted');
  assert.equal(notice(payload([WARN])), '', 'the markers speak for themselves');
  for (const lang of ['en', 'es']) {
    assert.match(I18N[lang]['rfw.unknown'], /not a report|no es un informe/i);
    assert.match(I18N[lang]['rfw.none'], /\{t\}/, 'the empty sentence must state as of when');
    assert.match(I18N[lang]['rfw.none.aged'], /\{t\}/);
    assert.match(I18N[lang]['rfw.carried'], /\{t\}/);
    assert.match(I18N[lang]['rfw.none.undated'], /not a current all-clear|no confirma/i);
  }
});

test('the layer-sheet row counts warnings, and never reads a failure as a quiet day', () => {
  const sub = (doc, unknown) => withData(doc, () => withT({
    'sheet.s.rflood.n': '{n} at risk now', 'sheet.s.rflood.carried': '{n} from an earlier read',
    'sheet.s.rflood.mixed': '{n} now, {a} quiet', 'sheet.s.rflood.aged': '{a} quiet',
  }, () => MSB.roadFloodRowSub()), unknown);
  assert.equal(sub(payload([WARN, Object.assign({}, WARN, { id: 'transtar:2' })])), '2 at risk now');
  const quiet = Object.assign({}, WARN, { id: 'transtar:3', observed: hoursAgo(3) });
  assert.equal(sub(payload([WARN, quiet])), '1 now, 1 quiet', 'a warning whose sensor went quiet is not "now"');
  assert.equal(sub(payload([quiet])), '1 quiet');
  assert.equal(sub(payload([WARN], { status: 'carried', carriedFrom: hoursAgo(0.5) })), '1 from an earlier read');
  assert.equal(sub(payload([])), 'sheet.s.rflood', 'a zero falls back to the description rather than announcing a count');
  assert.equal(sub(payload([], { status: 'failed', count: null })), 'sheet.s.rflood.unknown');
  assert.equal(sub(null, true), 'sheet.s.rflood.unknown');
  assert.equal(sub(null), 'sheet.s.rflood', 'before the first read the row describes the layer');
});

// a scripted transport and a recording opNotice in front of the real fetchRoadFlood()
function driveFetch(o) {
  const saved = { d: MS.roadFlood, u: MS.roadFloodUnknown, l: MS._roadFloodLoaded, fp: MS._roadFloodFp,
    row: MS._roadFloodRow, map: MS.map,
    layers: MS.layers, fetch: MSB.fetch, opNotice: MSB.opNotice, L: MSB.L, sync: MSB.layerSheetSync };
  const group = o.layer || { clearLayers() { clears += 1; }, addLayer() {} };
  const said = [];
  const urls = [];
  let clears = 0;
  let syncs = 0;
  MSB.layerSheetSync = () => { syncs += 1; };
  MS.roadFlood = o.last || null;
  MS.roadFloodUnknown = false;
  MS._roadFloodLoaded = false;
  MS._roadFloodFp = null;
  MS._roadFloodRow = null;
  MS._roadFloodBusy = null;
  MS.layers = Object.assign({}, MS.layers, { roadFlood: group });
  MS.map = { hasLayer: (l) => !!o.onMap && l === group };
  MSB.fetch = (url) => { urls.push(String(url)); return o.transport(String(url)); };
  MSB.opNotice = (s) => said.push(s);
  return {
    said, urls,
    get clears() { return clears; },
    get syncs() { return syncs; },
    run: (opts) => MSB.fetchRoadFlood(opts),
    restore() {
      MS.roadFlood = saved.d; MS.roadFloodUnknown = saved.u; MS._roadFloodLoaded = saved.l; MS._roadFloodFp = saved.fp;
      MS._roadFloodRow = saved.row; MS._roadFloodBusy = null; MS.map = saved.map;
      MS.layers = saved.layers;
      MSB.fetch = saved.fetch; MSB.opNotice = saved.opNotice; MSB.L = saved.L; MSB.layerSheetSync = saved.sync;
    },
  };
}
const served = (body) => () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

test('the layer reads the committed same-origin file and draws it', async () => {
  const d = driveFetch({ transport: served(payload()) });
  try {
    await d.run();
    assert.equal(d.urls.length, 1);
    assert.match(d.urls[0], /^data\/transtar-flood\.json\?/, 'the browser must read the cycle file, never TranStar');
    assert.equal(MS.roadFloodUnknown, false);
    assert.equal(d.clears, 1, 'a good read must be drawn');
    assert.deepEqual(d.said, [], 'a day with warnings needs no sentence');
    assert.equal(d.syncs, 1, 'an open layer sheet must repaint the row count');
  } finally { d.restore(); }
});

test('an unreadable file or a payload missing its lists is unknown, and the reader is told so', async () => {
  const bodies = [{ sources: [SRC()] }, { warnings: [] }, { warnings: [], sources: [] }, null];
  for (const body of bodies) {
    const d = driveFetch({ transport: served(body) });
    try {
      await d.run();
      assert.equal(MS.roadFloodUnknown, true, `${JSON.stringify(body)} must read as unknown, not as clear roads`);
      assert.deepEqual(d.said, ['rfw.unknown']);
      assert.equal(MS._roadFloodLoaded, false, 'and must stay retryable');
      assert.equal(d.syncs, 1, 'the row must stop showing a count it can no longer vouch for');
    } finally { d.restore(); }
  }
  const http = driveFetch({ transport: () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }) });
  try {
    await http.run();
    assert.equal(MS.roadFloodUnknown, true);
    assert.deepEqual(http.said, ['rfw.unknown']);
  } finally { http.restore(); }
});

test('a failed read published by the cycle is loaded, drawn empty, and announced as unavailable', async () => {
  const d = driveFetch({ transport: served(payload([], { status: 'failed', count: null, captured: null })) });
  try {
    await d.run();
    assert.equal(MS.roadFloodUnknown, false, 'the file itself was read');
    assert.deepEqual(d.said, ['rfw.unknown'], 'a failed upstream read must never produce the no-warnings sentence');
  } finally { d.restore(); }
});

test('a refresh that fails keeps the last copy on the map and says only that the refresh failed', async () => {
  const last = payload();
  const d = driveFetch({ last, transport: () => Promise.reject(new Error('offline')) });
  try {
    await d.run();
    assert.equal(MS.roadFloodUnknown, false, 'a last-good copy is still a known answer');
    assert.equal(MS.roadFlood, last);
    assert.deepEqual(d.said, ['note.rfloodfail']);
  } finally { d.restore(); }
});

test('a quiet refresh re-reads every tick but redraws only when what is drawn would change', async () => {
  let body = payload();
  const d = driveFetch({ transport: () => served(body)() });
  try {
    await d.run({ quiet: true, force: true });
    await d.run({ quiet: true, force: true });
    assert.equal(d.urls.length, 2, 'every refresh tick must re-read the file');
    assert.equal(d.clears, 1, 'an unchanged read must not close a popup the reader has open');
    assert.deepEqual(d.said, [], 'a quiet refresh never raises a notice');
    body = payload([Object.assign({}, WARN, { stageFt: 3.9 })]);
    await d.run({ quiet: true, force: true });
    assert.equal(d.clears, 2, 'a changed reading must be redrawn');
    await d.run();
    assert.equal(d.urls.length, 3, 'a toggle-on after a refresh reuses the loaded copy');
    assert.equal(d.syncs, 1, 'the sheet repaints only when the row would read differently');
  } finally { d.restore(); }
});

/* A tick is quiet, but a reader looking at the layer must not watch it go blank, or go stale, with
   nothing said: a failed read and a genuine zero clear the map the same way. */
test('with the layer on, a quiet tick that turns a current answer into an unavailable one says so once', async () => {
  let body = payload();
  const d = driveFetch({ onMap: true, transport: () => served(body)() });
  try {
    await d.run({ quiet: true, force: true });
    assert.deepEqual(d.said, [], 'a healthy tick stays quiet');
    body = payload([], { status: 'failed', count: null, captured: null });
    await d.run({ quiet: true, force: true });
    assert.deepEqual(d.said, ['rfw.unknown'], 'the warnings vanished because the read failed, and the reader must hear it');
    await d.run({ quiet: true, force: true });
    assert.deepEqual(d.said, ['rfw.unknown'], 'the same state on the next tick is not news');
    body = payload([WARN], { status: 'carried', carriedFrom: hoursAgo(0.5) });
    await d.run({ quiet: true, force: true });
    assert.deepEqual(d.said, ['rfw.unknown', 'rfw.carried']);
    body = payload();
    await d.run({ quiet: true, force: true });
    assert.equal(d.said.length, 2, 'recovering to a current read needs no banner');
  } finally { d.restore(); }

  const off = driveFetch({ onMap: false, transport: served(payload([], { status: 'failed', count: null })) });
  try {
    MS.roadFlood = payload();
    await off.run({ quiet: true, force: true });
    assert.deepEqual(off.said, [], 'a layer nobody is looking at raises no toast; its row says it instead');
  } finally { off.restore(); }
});

test('a toggle-on while a tick is still reading answers from that read, not before it', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const d = driveFetch({ transport: () => gate.then(() => served(payload([], { captured: hoursAgo(0.05) }))()) });
  try {
    const tick = d.run({ quiet: true, force: true });
    const toggle = d.run();
    release();
    await Promise.all([tick, toggle]);
    assert.equal(d.urls.length, 1, 'the toggle must not start a second read of its own');
    assert.deepEqual(d.said, ['rfw.none'], 'the toggle must wait for the read rather than report it failed');
  } finally { d.restore(); }
});

test('a render failure is not reported as a source failure', async () => {
  const boom = { clearLayers() {}, addLayer() { throw new Error('render blew up'); } };
  const d = driveFetch({ transport: served(payload()), layer: boom });
  try {
    await d.run();
    assert.equal(MS.roadFloodUnknown, false);
    assert.deepEqual(d.said, ['note.rflooddraw']);
    assert.equal(MS._roadFloodLoaded, false, 'the layer must stay retryable');
  } finally { d.restore(); }
});

/* ---------- wiring: run initMap() and the shipped handlers ---------- */

test('turning the overlay on loads this layer, and no other overlay does', () => {
  const w = loadWiredMap();
  const calls = w.spyOn('fetchRoadFlood', 'fetchWildfire', 'fetchLwc', 'fetchRiverSentry');
  w.fire('overlayadd', { layer: w.layers.roadFlood });
  assert.deepEqual(calls.names(), ['fetchRoadFlood']);
  calls.length = 0;
  for (const other of ['wildfire', 'roadClosures', 'roadReopen', 'lwc']) w.fire('overlayadd', { layer: w.layers[other] });
  assert.ok(!calls.names().includes('fetchRoadFlood'), 'no other overlay may load this layer');
});

test('the layer ships off, has a sheet row under Roads with a live count, a pill, and travels in a link', () => {
  const w = loadWiredMap();
  const S = w.sandbox;
  assert.ok(S.layerRowKeys().includes('roadFlood'), 'the layer has no user-facing sheet row');
  assert.equal(S.layerRowOn('roadFlood'), false, 'a hazard layer must ship off');
  assert.ok(!S.collectLayerState().on.includes('roadFlood'));

  const body = { innerHTML: '', scrollTop: 0 };
  const sheet = { querySelector: (sel) => ({ '.ls-head strong': { textContent: '' }, '.ls-close': { title: '' },
    '.ls-note': { hidden: true, textContent: '' }, '.ls-body': body }[sel] || null) };
  const prevGet = S.document.getElementById;
  w.state.roadFlood = payload([WARN, Object.assign({}, WARN, { id: 'transtar:2' })]);
  try {
    S.document.getElementById = (id) => (id === 'layer-sheet' ? sheet : null);
    const prevT = S.t;
    S.t = (k) => (k === 'sheet.s.rflood.n' ? '{n} at risk now' : k);
    try { S.renderLayerSheet(); } finally { S.t = prevT; }
  } finally { S.document.getElementById = prevGet; }
  const at = body.innerHTML.indexOf('data-layer="roadFlood"');
  assert.ok(at > 0, 'the sheet renders no row for the layer');
  const row = body.innerHTML.slice(at, at + 500);
  assert.match(row, /aria-checked="false"/);
  assert.match(row, /rflood-icon/);
  assert.match(row, /src-official/);
  assert.match(row, /2 at risk now/, 'the row must state the live count');
  assert.match(body.innerHTML.slice(0, at).slice(-900), /sheet\.g\.roads/, 'the row belongs with the roads');

  const pills = Array.from(vm.runInContext('PILL_LAYERS', S), (p) => Array.from(p));
  assert.ok(pills.some(([k, key]) => k === 'roadFlood' && key === 'layers.rflood'),
    'an active layer must name itself in the pill row');
  w.layers.roadFlood.addTo(w.map);
  const prevQs = S.document.querySelector;
  try {
    S.document.querySelector = (sel) => ({ '#flt-alert-sev': { value: '' }, '#flt-alert-q': { value: '' } }[sel] || null);
    assert.match(S.buildShareUrl(), /[?&]rflood=1\b/, 'a shared link drops the layer');
    w.map.removeLayer(w.layers.roadFlood);
    assert.ok(!/[?&]rflood=/.test(S.buildShareUrl()));
  } finally { S.document.querySelector = prevQs; }
  assert.ok(w.app.LINK_VIEW_PARAMS.includes('rflood'), 'a link carrying ?rflood= must win over the kept layer set');
});

test('the layer is named in the legend and the glossary, and hides under playback', () => {
  const legend = MSB.mapLegendHtml();
  assert.ok(legend.includes('legend.rflood'));
  assert.match(legend, /rflood-icon/);
  const SB = loadFullApp()._sandbox;
  const glossary = { innerHTML: '' };
  const prev = SB.document.querySelector;
  SB.document.querySelector = (sel) => (sel === '#glossary-body' ? glossary : null);
  try { SB.renderGlossary(); } finally { SB.document.querySelector = prev; }
  assert.match(glossary.innerHTML, /glossary\.rflood/);
  assert.match(glossary.innerHTML, /rflood-icon/);
  const hidden = mapApp.pbLiveHideAll().find(([k]) => k === 'roadFlood');
  assert.ok(hidden, 'no warning archive is replayed, so the live layer would impersonate the past');
  assert.equal(hidden[1], 'layers.rflood');
});

test('every new string exists in both languages, is translated, and carries no em-dash', () => {
  const keys = Object.keys(I18N.en).filter((k) => /^(rfw\.|note\.rflood|sheet\.s\.rflood|glossary\.rflood|legend\.rflood|layers\.rflood)/.test(k));
  assert.ok(keys.length >= 36, `expected the full string set, saw ${keys.length}`);
  for (const k of keys) {
    for (const lang of ['en', 'es']) {
      assert.ok(I18N[lang][k], `${k} is missing or empty in ${lang}`);
      assert.ok(!I18N[lang][k].includes('—'), `em-dash in ${lang} ${k}`);
    }
  }
  for (const k of ['layers.rflood', 'rfw.risk', 'rfw.notconfirmed', 'rfw.unknown', 'sheet.s.rflood']) {
    assert.notEqual(I18N.en[k], I18N.es[k], `${k} was never actually translated`);
  }
  for (const lang of ['en', 'es']) {
    assert.match(I18N[lang]['about.data'], /TranStar/, 'the about page must name the new collected source');
  }
});
