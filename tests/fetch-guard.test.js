'use strict';

/*
 * tests/fetch-guard.test.js — E1 for client fetches: a failed fetch must never become a
 * published value.
 *
 * The trap this exists for is ArcGIS's error convention. A rejected query does not arrive as a
 * 4xx; it arrives as HTTP 200 carrying {"error":{...}}. Verified live against the hurricane
 * service on 2026-07-27:
 *
 *   GET .../Active_Hurricanes_v1/FeatureServer/4/query?where=NOT_A_COLUMN%3D'x'&f=geojson
 *   -> HTTP 200
 *      {"error":{"code":400,"message":"","details":["'Invalid field: NOT_A_COLUMN' parameter is invalid"]}}
 *
 * res.ok admits that body, `.features` is undefined, and a `|| []` turns a query that failed into
 * "no active storms" with a green source chip. scripts/gen-roads-snapshot.py has guarded this on
 * the generator side since v0.99.5x; okJson/okList carry the same guard into the client.
 *
 * Three things are pinned here:
 *   1. the helpers reject an error body and still pass a genuine empty answer through;
 *   2. the live fetches mark their source healthy only on an answer they validated;
 *   3. a structural census, so a new fetch cannot ship without a guard or an explicit verdict.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./harness.js');

const app = loadApp();
const SB = app._sandbox;
const ST = app.state;

const JS = path.join(__dirname, '..', 'js');
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8');

// the real body the live probe returned, kept verbatim so the test fails if the shape stops matching
const ARCGIS_ERROR_BODY = {
  error: { code: 400, message: '', details: ["'Invalid field: NOT_A_COLUMN' parameter is invalid"] },
};
const EMPTY_FC = { type: 'FeatureCollection', features: [] };
const res200 = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

/* ================= okJson / okList ================= */

test('okJson rejects an ArcGIS error delivered inside HTTP 200', async () => {
  await assert.rejects(() => SB.okJson({ ok: true, status: 200, json: () => Promise.resolve(ARCGIS_ERROR_BODY) }, 'trop'),
    /upstream error body/, 'a 200 carrying {"error":...} is a failed fetch, not an answer');
});

test('okJson rejects transport failures and non-object bodies', async () => {
  await assert.rejects(() => SB.okJson({ ok: false, status: 503 }, 'x'), /HTTP 503/);
  await assert.rejects(() => SB.okJson(null, 'x'), /no response/);
  await assert.rejects(() => SB.okJson({ ok: true, status: 200, json: () => Promise.resolve(null) }, 'x'),
    /not a JSON object/);
  await assert.rejects(() => SB.okJson({ ok: true, status: 200, json: () => Promise.resolve('nope') }, 'x'),
    /not a JSON object/);
});

test('okJson passes a real answer through, including a bare array body', async () => {
  const fc = await SB.okJson({ ok: true, status: 200, json: () => Promise.resolve(EMPTY_FC) }, 'trop');
  assert.deepEqual(fc, EMPTY_FC, 'a genuine FeatureCollection must survive the guard untouched');
  // Nominatim answers with a top-level array, which must not read as an error envelope
  const arr = await SB.okJson({ ok: true, status: 200, json: () => Promise.resolve([{ lat: '30' }]) }, 'nom');
  assert.equal(arr.length, 1);
});

test('okList returns a genuine empty array rather than throwing on it', () => {
  const out = SB.okList(EMPTY_FC, 'features', 'trop');
  assert.deepEqual(out, [], 'an upstream that really holds nothing is a real zero and must pass');
  assert.equal(out.length, 0);
  // the distinction the whole release rests on: [] passes, absent throws
  assert.throws(() => SB.okList({ type: 'FeatureCollection' }, 'features', 'trop'), /'features' is not an array/);
  assert.throws(() => SB.okList(ARCGIS_ERROR_BODY, 'features', 'trop'), /'features' is not an array/);
  assert.throws(() => SB.okList({ features: {} }, 'features', 'trop'), /'features' is not an array/);
});

test('okList walks a dotted path and throws when any segment is missing', () => {
  assert.deepEqual(SB.okList({ value: { timeSeries: [] } }, 'value.timeSeries', 'usgs'), []);
  assert.deepEqual(SB.okList({ value: { timeSeries: [1, 2] } }, 'value.timeSeries', 'usgs'), [1, 2]);
  assert.throws(() => SB.okList({ value: {} }, 'value.timeSeries', 'usgs'), /not an array/);
  assert.throws(() => SB.okList({}, 'value.timeSeries', 'usgs'), /not an array/);
  assert.throws(() => SB.okList(null, 'value.timeSeries', 'usgs'), /not an array/);
});

/* ================= fetchTropical: the reported defect ================= */

// drive fetchTropical against a scripted per-sublayer responder
async function runTropical(bodyFor) {
  const saved = {};
  for (const k of ['fetch', 'markHealthy', 'opNotice', 'renderTropical']) saved[k] = SB[k];
  const healthy = [];
  const notices = [];
  let rendered = null;
  const group = { clearLayers() {}, addLayer() {} };
  const prevLayers = ST.layers;
  ST.layers = Object.assign({}, ST.layers, { tropical: group });
  SB.markHealthy = (s) => healthy.push(s);
  SB.opNotice = (m) => notices.push(m);
  SB.renderTropical = (d) => { rendered = d; };
  SB.fetch = (url) => {
    const n = +String(url).match(/FeatureServer\/(\d+)\/query/)[1];
    return res200(bodyFor(n));
  };
  try { await SB.fetchTropical(); } finally { Object.assign(SB, saved); ST.layers = prevLayers; }
  return { healthy, notices, rendered };
}

test('an ArcGIS error body on every tropical sublayer is a failure, never zero storms', async () => {
  const r = await runTropical(() => ARCGIS_ERROR_BODY);
  assert.deepEqual(r.healthy, [],
    'the source chip must not go green on a query that failed inside a 200');
  assert.equal(r.rendered, null, 'nothing may be drawn from an error body');
  assert.deepEqual(r.notices, ['note.tropfail'], 'and the operator is told the feed is unavailable');
});

test('a genuine empty tropical answer is a real zero and does mark the source healthy', async () => {
  const r = await runTropical(() => EMPTY_FC);
  assert.deepEqual(r.healthy, ['tropical'],
    'an upstream that answered "no active storms" is a measurement and must read as fresh');
  assert.ok(r.rendered, 'the empty state still renders');
  for (const k of ['cone', 'ftrack', 'otrack', 'ww', 'fpos', 'opos']) {
    assert.deepEqual(r.rendered[k], [], `${k} must be a real empty list, not null`);
  }
  assert.deepEqual(r.notices, [], 'a clean empty answer raises no failure notice');
});

test('a partly failed tropical fetch leaves the chip ageing instead of claiming fresh', async () => {
  // cone (4) errors inside a 200; every other sublayer answers honestly
  const r = await runTropical((n) => (n === 4 ? ARCGIS_ERROR_BODY : EMPTY_FC));
  assert.deepEqual(r.healthy, [],
    'one unvalidated sublayer means the source was not fully answered, so no green chip');
  assert.deepEqual(r.notices, ['note.troppartial'], 'the gap is stated rather than silently drawn');
  assert.ok(r.rendered, 'what did answer is still drawn');
  assert.equal(r.rendered.cone, null, 'the failed sublayer stays null, distinct from an empty one');
  assert.deepEqual(r.rendered.opos, [], 'and a sublayer that really is empty stays an empty list');
});

/* ================= the other live sources that mark health ================= */

// each entry: the fetch under test, the state it publishes, and the health key it may claim
const HEALTH_SOURCES = [
  {
    name: 'fetchAlerts', fn: 'fetchAlerts', health: 'alerts', key: 'alerts',
    empty: { type: 'FeatureCollection', features: [] },
    stubs: ['showEmergencyBanner', 'dismissEmergencyBanner', 'recordAlertHist', 'renderAlertList',
      'renderAlertPolys', 'renderTiles', 'maybeAutoTropical', 'syncAcutePoll'],
  },
  {
    name: 'fetchGauges', fn: 'fetchGauges', health: 'gauges', key: 'gauges',
    empty: { gauges: [] },
    stubs: ['recordTrends', 'renderGauges', 'renderGaugesTab', 'renderForecastList', 'renderTiles'],
  },
  {
    name: 'fetchLsrs', fn: 'fetchLsrs', health: 'lsrs', key: 'lsrs',
    empty: { type: 'FeatureCollection', features: [] },
    stubs: ['recordLsrHist', 'renderLsrs'],
  },
  {
    name: 'fetchFcstMax', fn: 'fetchFcstMax', health: 'fcstMax', key: 'fcstMax',
    empty: { type: 'FeatureCollection', features: [] },
    stubs: ['renderFcstMax'],
  },
];

async function runSource(spec, body) {
  const saved = {};
  for (const k of ['fetch', 'markHealthy'].concat(spec.stubs)) saved[k] = SB[k];
  const healthy = [];
  SB.markHealthy = (s) => healthy.push(s);
  for (const k of spec.stubs) SB[k] = () => {};
  SB.fetch = () => res200(body);
  let threw = false;
  try { await SB[spec.fn](); } catch { threw = true; } finally { Object.assign(SB, saved); }
  return { healthy, threw };
}

for (const spec of HEALTH_SOURCES) {
  test(`${spec.name} treats an error-in-200 as a failure and does not mark the source healthy`, async () => {
    const prev = ST[spec.key];
    ST[spec.key] = ['sentinel']; // a previous good reading the failure must not silently replace
    const r = await runSource(spec, ARCGIS_ERROR_BODY);
    assert.equal(r.threw, true, 'the fetch must reject so refresh() reports the source degraded');
    assert.deepEqual(r.healthy, [], 'a body we could not validate may not stamp the chip fresh');
    assert.deepEqual(ST[spec.key], ['sentinel'],
      'and the last good reading must not be overwritten by a failure');
    ST[spec.key] = prev;
  });

  test(`${spec.name} still publishes a genuine empty answer and marks the source healthy`, async () => {
    const prev = ST[spec.key];
    ST[spec.key] = ['sentinel'];
    const r = await runSource(spec, spec.empty);
    assert.equal(r.threw, false, 'a real empty answer is a success');
    assert.deepEqual(r.healthy, [spec.health], 'and it is a measurement, so the chip goes green');
    // length, not deepEqual: arrays built inside the vm realm are not reference-equal to ours
    assert.equal(ST[spec.key].length, 0, 'a real zero replaces the previous reading');
    ST[spec.key] = prev;
  });
}

/* ================= the banned shape, as a class ================= */

/* `|| []` on a payload key is the exact move that turns a failed fetch into a published zero.
   Banning the shape across the client is what stops the defect returning somewhere new. */
// the receiver is either a bare name or the result of a call, as in `(await r.json()).features`
const BANNED = /(?:(\w+)|\))\.(features|elements|gauges|versions|predictions|timeSeries|messages|towers|frames|requests|crossings|shelters)\s*(?:\|\||\?\?)\s*\[\]/g;
// reading a default off our own state is not the defect; reading one off a parsed response is
const STATE_HOLDERS = new Set(['state', 'ST', 'T', 'N', 'chat', 'app', 'pbSbw', 'this']);

// m[1] undefined means the receiver was a call result, which is always a parsed body here
const bannedHits = (line) => [...line.matchAll(BANNED)].filter((m) => !(m[1] && STATE_HOLDERS.has(m[1])));

test('no client file substitutes an empty list for a missing payload key', () => {
  // non-vacuity, both directions: the shipped defect is caught, the legitimate forms are not
  assert.equal(bannedHits('return (await r.json()).features || [];').length, 1,
    'the ban must catch the exact shape this release removed');
  assert.equal(bannedHits('for (const e of (d.elements || []))').length, 1);
  assert.equal(bannedHits('const got = d.features ?? [];').length, 1);
  assert.equal(bannedHits("const got = okList(d, 'features', 'x');").length, 0,
    'the guarded form must be allowed');
  assert.equal(bannedHits('return (state.crossings || []).filter(f);').length, 0,
    'a default off our own state is not a published fetch failure');

  for (const f of fs.readdirSync(JS).filter((n) => n.endsWith('.js'))) {
    read(f).split('\n').forEach((line, i) => {
      assert.equal(bannedHits(line).length, 0,
        `${f}:${i + 1} substitutes [] for a payload key; use okList() so a failed fetch stays a failure`);
    });
  }
});

/* ================= structural census ================= */

/* A new fetch must not be able to ship without someone deciding what it does on failure. The
   counts below fail on any added or removed call site, and each site named must still carry the
   token that makes its verdict true. */
const CENSUS = {
  'board.js': 11, 'boot.js': 5, 'bootfloor.js': 0, 'cameras.js': 3, 'chat.js': 3, 'core.js': 0, 'i18n.js': 0,
  'map.js': 3, 'master.js': 1, 'notes.js': 4, 'panels.js': 9, 'playback.js': 4,
  'sources.js': 16, 'team.js': 2, 'usng.js': 0,
};

test('the client fetch census is unchanged, so no new call site slipped past this audit', () => {
  const seen = {};
  for (const f of fs.readdirSync(JS).filter((n) => n.endsWith('.js'))) {
    seen[f] = (read(f).match(/fetch\(/g) || []).length;
  }
  assert.deepEqual(seen, CENSUS,
    'a fetch was added or removed: audit it for E1 and add it to SITES below with a verdict');
});

// slice a function body out of its file, the way tests/roads-tab.test.js already does
function fnBody(file, decl, close) {
  const src = read(file);
  const i = src.indexOf(decl);
  assert.ok(i >= 0, `${file}: declaration not found: ${decl}`);
  const j = src.indexOf(close, i + decl.length);
  assert.ok(j > i, `${file}: end of ${decl} not found`);
  return src.slice(i, j);
}

const TOP = '\n}';
const NESTED = '\n  }';

/* Every call site that reads a parsed body. GUARDED sites validate shape before publishing;
   HONEST sites were left alone because failure is already distinguishable from a real zero, and
   the token named is the mechanism that makes that true. */
const SITES = [
  // ---- sources.js ----
  { f: 'sources.js', d: 'async function fetchAlerts()', c: TOP, v: 'GUARDED',
    req: ["okJson(res, 'NWS alerts')", "okList(data, 'features', 'NWS alerts')"] },
  { f: 'sources.js', d: 'async function zoneGeometry(', c: TOP, v: 'GUARDED',
    req: ["okJson(res, 'NWS zone')", 'no geometry'] },
  { f: 'sources.js', d: 'async function fetchGauges()', c: TOP, v: 'GUARDED',
    req: ["okJson(res, 'NWPS')", "okList(data, 'gauges', 'NWPS')"] },
  { f: 'sources.js', d: 'function cachedJson(', c: TOP, v: 'GUARDED', req: ["okJson(r, 'gauge json')"] },
  { f: 'sources.js', d: 'async function drawSparkline(', c: TOP, v: 'GUARDED',
    req: ["okList(series, 'data', 'gauge series')"] },
  { f: 'sources.js', d: 'async function fetchFcstMax()', c: TOP, v: 'GUARDED',
    req: ["okJson(res, 'RFC fcst')", "okList(data, 'features', 'RFC fcst')"] },
  { f: 'sources.js', d: 'async function fetchUsgsTile(', c: TOP, v: 'GUARDED',
    req: ["okJson(res, 'USGS IV')", "okList(data, 'value.timeSeries', 'USGS IV')"] },
  { f: 'sources.js', d: 'async function fetchRoadClosuresLive()', c: TOP, v: 'GUARDED',
    req: ["okJson(res, 'DriveTexas')", "okList(data, 'features', 'DriveTexas')"] },
  { f: 'sources.js', d: 'async function hydrateRoadsSnapshot()', c: TOP, v: 'HONEST',
    req: ['Array.isArray(d.roads)', 'state.roadsUnknown = true'] },
  { f: 'sources.js', d: 'async function fetchTropical()', c: TOP, v: 'GUARDED',
    req: ['okJson(r,', "okList(d, 'features'", 'subs.some((x) => x === null)', "opNotice(t('note.tropfail'))"] },
  { f: 'sources.js', d: 'async function fetchLwc()', c: TOP, v: 'GUARDED',
    req: ["okJson(r, 'TxGIO')", "okList(d, 'features', 'TxGIO')", "opNotice(t('note.lwcfail'))"] },
  { f: 'sources.js', d: 'async function fetchRiverSentry()', c: TOP, v: 'HONEST',
    req: ['Array.isArray(data.towers)', "opNotice(t('note.rsentryfail'))"] },
  { f: 'sources.js', d: 'async function fetchWildfire()', c: TOP, v: 'HONEST',
    req: ['Array.isArray(data.fires)', 'Array.isArray(data.sources)', 'state.wildfireUnknown =',
      'opNotice(', "t('note.wildfirefail')"] },
  { f: 'sources.js', d: 'function wildfireNoticeText()', c: TOP, v: 'HONEST',
    req: ['state.wildfireUnknown', "t('wf.unknown')"] },
  { f: 'sources.js', d: 'async function fetchLsrs()', c: TOP, v: 'GUARDED',
    req: ["okJson(res, 'LSR')", "okList(data, 'features', 'LSR')"] },
  { f: 'sources.js', d: 'async function fetchTideStation(', c: TOP, v: 'GUARDED',
    req: ["okJson(obsR, 'CO-OPS obs')", "okList(obs, 'data', 'CO-OPS obs')", 'ok: false'] },
  // a coordinate cache that would not load leaves state.tideMeta null: no station offers a focus
  // control, and the layer says so rather than drawing an empty coast
  { f: 'sources.js', d: 'async function fetchTideMeta()', c: TOP, v: 'HONEST',
    req: ['if (!res.ok) throw', "typeof data.stations !== 'object'", 'state.tideMeta = data'] },
  { f: 'sources.js', d: 'function renderTideStations()', c: TOP, v: 'HONEST',
    req: ['!Object.keys(state.tideMarkers).length', "opNotice(t('note.tidemeta'))"] },

  // ---- panels.js ----
  { f: 'panels.js', d: 'async function openCrestSummary()', c: TOP, v: 'GUARDED',
    req: ["okJson(r, 'crest summary')", 'Array.isArray(d.gauges)', "t('summary.none')"] },
  { f: 'panels.js', d: 'async function openRecoveryView(', c: TOP, v: 'GUARDED',
    req: ["okJson(r, 'crest summary')"] },
  { f: 'panels.js', d: 'function renderRecoveryBody(', c: TOP, v: 'GUARDED',
    req: ['const crestOk =', "t('recovery.counts.unknown')"] },
  { f: 'panels.js', d: 'async function openBasinView(', c: TOP, v: 'GUARDED',
    req: ["okJson(r, 'crest summary')"] },
  { f: 'panels.js', d: 'function renderBasinBody()', c: TOP, v: 'GUARDED',
    req: ['const crestOk =', "t('basin.counts.unknown')", "t('basin.crestunknown')"] },
  { f: 'panels.js', d: 'async function loadSeeds()', c: TOP, v: 'GUARDED',
    req: ["okJson(r, 'requests')", "okJson(r, 'resources')", "okList(reqs, 'requests', 'requests')",
      'state.crossingsUnknown'] },
  { f: 'panels.js', d: 'function renderRoadsTab()', c: TOP, v: 'GUARDED',
    req: ["'roads.xunknown'", "'roads.unknown'"] },

  // ---- playback.js ----
  { f: 'playback.js', d: 'function pbSbwFetch(', c: TOP, v: 'GUARDED',
    req: ["okJson(r, 'sbw')", "okList(d, 'features', 'sbw')"] },
  { f: 'playback.js', d: 'function pbFetchJson(', c: TOP, v: 'HONEST', req: ['if (!res.ok) throw'] },
  { f: 'playback.js', d: 'async function pbInitMonolith(', c: TOP, v: 'HONEST',
    req: ['Array.isArray(d.frames)', 'empty history'] },
  // the fourth crest-summary reader; the three in panels.js were already guarded and this one was not
  { f: 'playback.js', d: 'async function loadPlaybackData()', c: TOP, v: 'GUARDED',
    req: ["okJson(r, 'crest summary')"] },

  // ---- cameras.js ----
  { f: 'cameras.js', d: 'function loadCameras()', c: TOP, v: 'GUARDED',
    req: ["okJson(r, 'cameras')", 'CAM_NETS.some(([arr]) => Array.isArray(d[arr]))'] },
  { f: 'cameras.js', d: 'async function loadProxyStill(', c: TOP, v: 'HONEST',
    req: ['if (!res.ok) throw', "t('cam.nostamp')"] },
  { f: 'cameras.js', d: 'async function loadRiverStill(', c: TOP, v: 'HONEST',
    req: ['if (!res.ok) throw', 'no recent imagery'] },

  // ---- boot.js ----
  { f: 'boot.js', d: 'async function openChangelog()', c: TOP, v: 'GUARDED',
    req: ["okJson(r, 'changelog')", "okList(data, 'versions', 'changelog')"] },
  { f: 'boot.js', d: 'async function runHeaderSearch()', c: TOP, v: 'GUARDED',
    req: ["t('search.lookupfail')", "t('search.noresult')"] },
  { f: 'boot.js', d: 'async function hydrateGaugesSnapshot()', c: TOP, v: 'HONEST',
    req: ['!d.gauges.length'] },
  // the AO, map centre, USGS tiling box and tide stations all come from here, so a 200 carrying an
  // error body must not be applied as configuration
  { f: 'boot.js', d: 'async function loadEventConfig()', c: TOP, v: 'GUARDED',
    req: ["okJson(r, 'event config')"] },

  // ---- board.js ----
  { f: 'board.js', d: 'async function nominatimSearchN(', c: TOP, v: 'GUARDED',
    req: ["okJson(res, 'Nominatim')", 'Array.isArray(hits)'] },
  // not a fetch, but the same class: a parse that did not yield what we asked for is not a zero
  { f: 'board.js', d: 'function importRequests(', c: TOP, v: 'GUARDED',
    req: ["okList(data, 'requests', 'not a Responder export')", "t('import.failed')"] },

  // ---- LAN-only (deploy.sh strips these from the public mirror) ----
  { f: 'team.js', d: 'async function loadFacilities()', c: NESTED, v: 'GUARDED',
    req: ["okJson(r, 'Overpass')", "okList(d, 'elements', 'Overpass')", 'd.remark'] },
  { f: 'notes.js', d: 'async function loadNotes()', c: NESTED, v: 'GUARDED',
    req: ["okJson(r, 'notes')", "okList(pub, 'notes', 'notes')", 'if (!read'] },
  { f: 'chat.js', d: 'async function loadChat()', c: NESTED, v: 'GUARDED',
    req: ["okJson(r, 'chat outbox')", "okList(out, 'messages', 'chat outbox')", 'if (!read'] },
];

test('every audited call site still carries the guard its verdict claims', () => {
  assert.ok(SITES.length >= 38, 'the audit table must not shrink silently');
  for (const s of SITES) {
    const body = fnBody(s.f, s.d, s.c);
    for (const token of s.req) {
      assert.ok(body.includes(token),
        `${s.f} ${s.d} is registered ${s.v} but no longer contains ${JSON.stringify(token)}`);
    }
  }
});

test('a source is never marked healthy before the body it describes is validated', () => {
  // the health chip is a claim about the source, so every markHealthy must sit after the parse
  const seeds = fnBody('panels.js', 'async function loadSeeds()', TOP);
  assert.ok(seeds.indexOf("okList(reqs, 'requests', 'requests')") < seeds.indexOf("markHealthy('seeds')"),
    'loadSeeds must validate the payload before claiming the source is healthy');
  assert.ok(seeds.indexOf('state.resources = res') < seeds.indexOf("markHealthy('seeds')"),
    'and publish the validated values before the chip goes green');

  const trop = fnBody('sources.js', 'async function fetchTropical()', TOP);
  assert.ok(trop.indexOf('subs.some((x) => x === null)') < trop.indexOf("markHealthy('tropical')"),
    'fetchTropical must rule out an unvalidated sublayer before marking the source healthy');

  // every markHealthy in the client is accounted for; a new one must be reviewed against this rule
  const calls = [];
  for (const f of fs.readdirSync(JS).filter((n) => n.endsWith('.js'))) {
    for (const m of read(f).matchAll(/markHealthy\('([a-zA-Z]+)'\)/g)) calls.push(`${f}:${m[1]}`);
  }
  assert.deepEqual(calls.sort(), [
    'panels.js:seeds', 'sources.js:alerts', 'sources.js:fcstMax', 'sources.js:gauges',
    'sources.js:lsrs', 'sources.js:roads', 'sources.js:tropical', 'sources.js:usgs',
  ], 'a markHealthy call was added or removed: confirm it only fires on a validated body');
});

/* ================= the honesty strings this release added ================= */

test('the new unknown-state strings exist in both languages and refuse the zero reading', () => {
  const I18N = require('./i18n-load.js');
  const keys = ['note.troppartial', 'note.lwcfail', 'roads.xunknown', 'recovery.counts.unknown',
    'basin.counts.unknown', 'basin.crestunknown', 'search.lookupfail'];
  for (const k of keys) {
    for (const lang of ['en', 'es']) {
      const s = I18N[lang][k];
      assert.ok(typeof s === 'string' && s.length, `${lang} is missing ${k}`);
      assert.ok(!s.includes('—'), `em-dash in ${lang} ${k}`);
    }
    assert.notEqual(I18N.en[k], I18N.es[k], `${k} was never actually translated`);
  }
  // the point of each string is to deny the reading the zero state would have invited
  assert.match(I18N.en['note.lwcfail'], /not a report that crossings are clear/i);
  assert.match(I18N.en['basin.crestunknown'], /not a report that the reach is quiet/i);
  assert.match(I18N.en['roads.xunknown'], /not a report that crossings are clear/i);
  assert.match(I18N.en['search.lookupfail'], /not a "no match"/i);
});
