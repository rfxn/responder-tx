'use strict';

/* Road closures from DriveTexas's own MapLarge condition table (2026-10-02). The ArcGIS layer the
   board read began answering "Token Required" inside HTTP 200, and drivetexas.org itself never
   called it: the site draws appgeo/conditionsLine. Every test here runs the shipped client
   against a captured answer from that table (tests/fixtures/drivetexas-conditions.json), with the
   clock pinned to the capture so its posted end times never age the fixture out. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { loadApp, loadRealLeaflet } = require('./harness.js');
const app = loadApp();
const SB = app._sandbox;
const ST = app.state;

const ROOT = path.join(__dirname, '..');
const FX = require('./fixtures/drivetexas-conditions.json');
const FX_UPDATED = FX.census.data.data.lastUpdated_Max[0];
const FX_NOW = FX_UPDATED + 5 * 60000;
const FX_ROWS = (() => {
  const d = FX.page.data.data;
  return d.OBJECTID.map((_, i) => Object.fromEntries(Object.keys(d).map((c) => [c, d[c][i]])));
})();
const fxRow = (route) => FX_ROWS.find((r) => r.RTENM === route);

const clone = (o) => JSON.parse(JSON.stringify(o));
const answer = (body, status) => Promise.resolve({ ok: (status || 200) === 200, status: status || 200, json: () => Promise.resolve(clone(body)) });
const request = (url) => JSON.parse(new URL(url).searchParams.get('request')).query;

const SNAPSHOT = {
  generated: new Date(FX_NOW - 40 * 60000).toISOString(),
  roads: [{ id: 1, cond: 'Flooding', route: 'FM0481', from: 'a', to: 'b', desc: 'Water over roadway.', start: '2026-10-02T09:00:00-05:00', end: null, v: [29.9, -98.4] }],
};

/* Run the shipped fetchRoadClosures with the clock at `now`. `script` answers each DriveTexas call
   by kind ('active' | 'rows' | 'census'); anything it leaves undefined gets the captured answer. */
async function runLive(script, opts) {
  const o = opts || {};
  const calls = [];
  const healthy = [];
  const notices = [];
  const saved = {};
  const STUBS = ['renderRoadClosures', 'renderRoadsTab', 'renderReopenedMap', 'renderReopenedRoads', 'renderTiles'];
  for (const k of ['fetch', 'markHealthy', 'opNotice'].concat(STUBS)) saved[k] = SB[k];
  for (const k of STUBS) SB[k] = () => {};
  SB.opNotice = (m) => notices.push(m);
  SB.markHealthy = (s) => healthy.push(s);
  SB.fetch = (url, init) => {
    const u = String(url);
    if (/roads-snapshot\.json/.test(u)) return answer(SNAPSHOT);
    let kind = null;
    if (u.startsWith(`${app.CONFIG.dtxMapLarge}/Remote/GetActiveTableID?shortTableId=appgeo%2FconditionsLine`)) kind = 'active';
    else if (u.startsWith(`${app.CONFIG.dtxMapLarge}/Api/ProcessDirect?request=`)) kind = request(u).groupby ? 'census' : 'rows';
    if (!kind) return Promise.reject(new Error(`unscripted fetch ${u}`));
    calls.push({ kind, url: u, init });
    const scripted = script ? script(kind, kind === 'active' ? null : request(u)) : undefined;
    if (scripted !== undefined) return scripted;
    return answer(kind === 'active' ? FX.activeTable : kind === 'rows' ? FX.page : FX.census);
  };
  const savedBox = app.CONFIG.gaugeBbox;
  if (o.bbox) app.CONFIG.gaugeBbox = o.bbox;
  const realNow = Date.now;
  Date.now = () => (o.now == null ? FX_NOW : o.now);
  if (!o.keepMemory) {
    ST.roadMemory = null;
    SB.localStorage.clear();
  }
  Object.assign(ST, { roadClosures: null, roadsFallbackAt: null, roadsUnknown: false, roadsPartial: false, sourceFailed: {} });
  let threw = null;
  try {
    await SB.fetchRoadClosures();
  } catch (e) {
    threw = e;
  } finally {
    Object.assign(SB, saved);
    app.CONFIG.gaugeBbox = savedBox;
    Date.now = realNow;
  }
  return { threw, healthy, notices, calls, lines: ST.roadClosures ? ST.roadClosures.lines : null, points: ST.roadClosures ? ST.roadClosures.points : null };
}

const byRoute = (lines, route) => lines.find((f) => f.properties.route_name === route);
const countBy = (lines, f) => lines.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});

test('the captured DriveTexas condition table reaches the board as live closures', async () => {
  const r = await runLive();
  assert.equal(r.threw, null, r.threw && r.threw.message);
  assert.deepEqual(r.healthy, ['roads'], 'a validated, fresh answer is a live measurement');
  assert.equal(r.lines.length, 9, 'ten captured rows, one of them construction-coded');
  assert.deepEqual(countBy(r.lines, (f) => f.properties.condition), { Closure: 3, Flooding: 4, Damage: 2 });
  assert.equal(byRoute(r.lines, 'FM2990'), undefined, 'a closure coded for construction stays off a flood board');

  const active = r.calls.find((c) => c.kind === 'active');
  assert.equal(active.init && active.init.cache, 'no-store', 'the active table id must never come from a browser cache');
  const rows = r.calls.filter((c) => c.kind === 'rows').map((c) => request(c.url));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].table, FX.activeTable.table, 'rows are read from the versioned table, never the CDN-cached short name');
  assert.deepEqual(Array.from(rows[0].where[0].value).sort(), ['D', 'F', 'Z']);
  const census = r.calls.filter((c) => c.kind === 'census').map((c) => request(c.url));
  assert.equal(census.length, 1, 'one grouped read covers the code legend and the table stamp');
  assert.equal(census[0].table, FX.activeTable.table);
  assert.deepEqual(census[0].where, [], 'the legend is checked across the whole table, not only the codes asked for');
  assert.deepEqual(Array.from(census[0].groupby), ['CNSTRNTTYPECD'], 'one group per code, however many import stamps the table holds');
});

test('each DriveTexas column lands on the field the board already reads', async () => {
  const r = await runLive();
  const raw = fxRow('SL0323');
  const p = byRoute(r.lines, 'SL0323').properties;
  assert.equal(p.condition, 'Closure');
  assert.equal(p.from_limit, raw.CONDLMTFROMDSCR);
  assert.equal(p.to_limit, raw.CONDLMTTODSCR);
  assert.equal(p.description, raw.CONDDSCR);
  assert.equal(Date.parse(p.start_time), raw.CONDSTARTTS);
  assert.equal(Date.parse(p.end_time), raw.CONDENDTS);
  assert.equal(p.detour_flag, 1, 'DriveTexas spells the detour flag Y');
  assert.equal(byRoute(r.lines, 'FM0928').properties.detour_flag, 0);

  const sl = byRoute(r.lines, 'SL0323').geometry;
  assert.equal(sl.type, 'LineString');
  assert.deepEqual(Array.from(sl.coordinates[0]), raw.conditionsLine.match(/\(([-\d.]+) ([-\d.]+)/).slice(1).map(Number));
  const multi = byRoute(r.lines, 'FM2044').geometry;
  assert.equal(multi.type, 'MultiLineString');
  assert.equal(multi.coordinates.length, (fxRow('FM2044').conditionsLine.match(/\(/g) || []).length - 1,
    'every part of a disjoint closure is kept');
  assert.equal(SB.roadSegParts(multi), multi.coordinates.length);

  // the popup renders from these fields, live-labelled, with the markup and lead dash gone
  const html = SB.roadPopupHtml(byRoute(r.lines, 'SL0323').properties, sl);
  assert.match(html, /road\.cond\.closure/);
  assert.match(html, /SL 323/);
  assert.match(html, /road\.detour/);
  assert.match(html, /road\.live/);
  assert.ok(!/&lt;br|<br/.test(html) && /The roadway is closed due to damage/.test(html));
});

test('the live closures draw through the real Leaflet, one line layer each, with a popup', async () => {
  const r = await runLive();
  assert.equal(r.threw, null, r.threw && r.threw.message);
  const RealL = loadRealLeaflet();
  const group = RealL.layerGroup();
  const savedL = SB.L;
  const savedLayer = ST.layers.roadClosures;
  SB.L = RealL;
  ST.layers.roadClosures = group;
  try {
    SB.renderRoadClosures();
  } finally {
    SB.L = savedL;
    ST.layers.roadClosures = savedLayer;
  }
  const drawn = group.getLayers();
  assert.equal(drawn.length, 9, 'every live closure becomes a layer');
  assert.ok(drawn.every((g) => g.getLayers().length === 1 && g.getPopup()), 'each one a line with its popup');
  const multi = drawn.find((g) => /FM 2044/.test(g.getPopup().getContent()));
  assert.ok(multi && multi.getLayers()[0].getLatLngs().length > 1, 'a multi-part closure keeps its parts');
});

test('a flooded closure is still counted as flooding wherever the board counts it', async () => {
  const r = await runLive();
  const flood = Array.from(r.lines.filter((f) => app.roadIsFlood(f.properties)), (f) => f.properties.route_name).sort();
  assert.deepEqual(flood, ['FM0928', 'FM2044', 'IH0002', 'RM2768', 'US0090']);
  assert.equal(byRoute(r.lines, 'RM2768').properties.condition, 'Closure',
    'RM 2768 is coded Closure and is flooding by its own description');

  const m = SB.situationModel();
  assert.equal(m.src.roads, 'ok');
  assert.deepEqual({ ...m.roads }, { flood: 5, total: 9 }, 'the Feed and hero counts read the live set');
  const rows = app.roadsTabRows().filter((x) => x.kind === 'txdot');
  assert.equal(rows.length, 9);
  assert.ok(rows.every((x) => x.live === true && Number.isFinite(x.lat) && Number.isFinite(x.lon)));
  ST.roadClosures = null;
});

test('the AO keeps a closure whose line crosses it, and drops one that never touches it', async () => {
  const sa = { xmin: -98.8, ymin: 29.2, xmax: -98.3, ymax: 29.7 };
  const r = await runLive(null, { bbox: sa });
  assert.equal(r.threw, null);
  assert.deepEqual(Array.from(r.lines, (f) => f.properties.route_name), ['US0090']);

  const box = { xmin: -98.5, ymin: 29.5, xmax: -98, ymax: 30 };
  const line = (...pts) => ({ type: 'LineString', coordinates: pts });
  assert.equal(SB.roadLineInBox(line([-99, 29.75], [-97, 29.75]), box), true, 'crossing with no vertex inside');
  assert.equal(SB.roadLineInBox(line([-98.2, 29.7], [-97, 29.7]), box), true, 'one vertex inside');
  assert.equal(SB.roadLineInBox(line([-99, 29], [-99, 31]), box), false, 'parallel and outside');
  assert.equal(SB.roadLineInBox(line([-99, 29], [-97, 29.3]), box), false, 'diagonal that passes below the box');
  assert.equal(SB.roadLineInBox(line([-98.2, 29.7]), box), true, 'a one-vertex line inside');
  assert.equal(SB.roadLineInBox({ type: 'MultiLineString', coordinates: [[[-99, 29], [-99, 28]], [[-98.2, 31], [-98.2, 29]]] }, box), true,
    'any part of a multi-part line');
});

const EMPTY_PAGE = (() => {
  const body = clone(FX.page);
  for (const c of Object.keys(body.data.data)) body.data.data[c] = [];
  body.data.totals.Records = 0;
  return body;
})();

// the captured page with every closure line rewritten by `f`
const pageGeo = (f) => {
  const body = clone(FX.page);
  body.data.data.conditionsLine = body.data.data.conditionsLine.map(f);
  return body;
};
// the captured census with its condition codes rewritten by `f`
const censusCodes = (f) => {
  const body = clone(FX.census);
  body.data.data.CNSTRNTTYPECD = body.data.data.CNSTRNTTYPECD.map(f);
  return body;
};
// the captured page as the where filter returns it once Flooding rows stop matching
const PAGE_NO_FLOOD = (() => {
  const body = clone(FX.page);
  const keep = body.data.data.CNSTRNTTYPECD.map((c) => c !== 'F');
  for (const c of Object.keys(body.data.data)) body.data.data[c] = body.data.data[c].filter((_, i) => keep[i]);
  body.data.totals.Records = keep.filter(Boolean).length;
  return body;
})();
const Z_DIM = (g) => g.replace(/^(MULTI)?LINESTRING \(/, (m, multi) => `${multi || ''}LINESTRING Z (`);

/* E1: every way the source can fail must leave the board saying so. Each case falls back to the
   committed snapshot (its own older stamp), never marks the live source healthy, and rejects so the
   refresh loop lists roads among the degraded sources. */
const FAILURES = [
  ['the active table answers without a table', (k) => (k === 'active' ? answer({ success: false, errors: ['denied'] }) : undefined)],
  ['the active table is the CDN-cached short name', (k) => (k === 'active' ? answer({ success: true, table: 'appgeo/conditionsLine' }) : undefined)],
  ['the condition query is a server error', (k) => (k === 'rows' ? answer({}, 500) : undefined)],
  ['the condition query is refused', (k) => (k === 'rows' ? answer({ success: false, errors: ['bad query'], data: null }) : undefined)],
  ['the condition query answers the token error the ArcGIS layer now gives', (k) => (k === 'rows'
    ? answer({ error: { code: 499, message: 'Token Required', messageCode: 'GWM_0003', details: ['Token Required'] } }) : undefined)],
  ['a column the board reads is gone', (k) => {
    if (k !== 'rows') return undefined;
    const body = clone(FX.page);
    delete body.data.data.CONDDSCR;
    return answer(body);
  }],
  ['a column comes back shorter than the rest', (k) => {
    if (k !== 'rows') return undefined;
    const body = clone(FX.page);
    body.data.data.conditionsLine.pop();
    return answer(body);
  }],
  ['the network is down', (k) => (k === 'rows' ? Promise.reject(new TypeError('Failed to fetch')) : undefined)],
  ['every closure line arrives in a geometry format the board cannot read', (k) => (k === 'rows' ? answer(pageGeo(Z_DIM)) : undefined)],
  ['Flooding is re-coded to a code outside the legend', (k) => (k === 'census' ? answer(censusCodes((c) => (c === 'F' ? 'FL' : c)))
    : k === 'rows' ? answer(PAGE_NO_FLOOD) : undefined)],
  ['every condition code is re-coded, so no closure matches', (k) => (k === 'census' ? answer(censusCodes((c) => `${c}1`))
    : k === 'rows' ? answer(EMPTY_PAGE) : undefined)],
  ['a row carries no condition code', (k) => (k === 'census' ? answer(censusCodes((c, i) => (i === 0 ? null : c))) : undefined)],
  ['the census is cut short of the groups it reports', (k) => {
    if (k !== 'census') return undefined;
    const body = clone(FX.census);
    body.data.totals.Records += 1;
    return answer(body);
  }],
];

for (const [label, script] of FAILURES) {
  test(`E1 · ${label}: the snapshot is served as a snapshot and roads read degraded`, async () => {
    const r = await runLive(script);
    assert.ok(r.threw, 'fetchRoadClosures must reject');
    assert.deepEqual(r.healthy, [], 'the live source may not read healthy');
    assert.equal(r.lines.length, 0, 'no live line may be drawn from a failed read');
    assert.equal(r.points.length, 1, 'the committed snapshot is what the board shows');
    assert.equal(ST.roadsFallbackAt, Date.parse(SNAPSHOT.generated), 'and it ages on its own stamp');
    assert.equal(SB.situationModel().src.roads, 'snapshot');
    assert.deepEqual(Object.keys(app.roadMemory().seen), [], 'nothing reaches the reopened diff');
  });
}

test('E1 · a table whose import has stalled is not served as live', async () => {
  const stale = await runLive(null, { now: FX_UPDATED + (app.ROAD_STALE_MIN + 1) * 60000 });
  assert.ok(stale.threw, 'a set older than the stale window must reject');
  assert.deepEqual(stale.healthy, []);
  assert.equal(ST.roadsFallbackAt, Date.parse(SNAPSHOT.generated));

  const edge = await runLive(null, { now: FX_UPDATED + (app.ROAD_STALE_MIN - 1) * 60000 });
  assert.equal(edge.threw, null, 'inside the window it is still a live read');

  const unstamped = await runLive((k) => {
    if (k !== 'rows') return undefined;
    const body = clone(FX.page);
    body.data.data.lastUpdated = body.data.data.lastUpdated.map(() => null);
    return answer(body);
  });
  assert.ok(unstamped.threw, 'a set that cannot say when it was imported cannot vouch for itself');
});

test('E1 · a table stamped in the future is not served as live', async () => {
  const ahead = await runLive(null, { now: FX_UPDATED - (app.ROAD_FUTURE_MIN + 1) * 60000 });
  assert.ok(ahead.threw, 'an import stamp from the future cannot vouch for currency');
  assert.deepEqual(ahead.healthy, []);
  assert.equal(ST.roadsFallbackAt, Date.parse(SNAPSHOT.generated));

  const skew = await runLive(null, { now: FX_UPDATED - (app.ROAD_FUTURE_MIN - 1) * 60000 });
  assert.equal(skew.threw, null, 'a few minutes of clock skew is still a live read');

  const micros = await runLive((k) => {
    if (k !== 'rows') return undefined;
    const body = clone(FX.page);
    body.data.data.lastUpdated = body.data.data.lastUpdated.map((x) => x * 1000);
    return answer(body);
  });
  assert.ok(micros.threw, 'a stamp whose unit drifted reads as far future and is refused');
});

test('E1 · one closure whose line cannot be read makes the set partial, never a reopening', async () => {
  const clean = await runLive();
  const id = app.roadId(byRoute(clean.lines, 'SL0323').properties);
  assert.ok(app.roadMemory().seen[id], 'a complete read remembers the segment');

  const at = FX_ROWS.indexOf(fxRow('SL0323'));
  const r = await runLive((k) => (k === 'rows' ? answer(pageGeo((g, i) => (i === at ? 'POINT (-95.2687 32.395)' : g))) : undefined),
    { keepMemory: true });
  assert.equal(r.threw, null, 'the closures that did read are still live');
  assert.equal(r.lines.length, 8);
  assert.equal(byRoute(r.lines, 'SL0323'), undefined);
  assert.equal(ST.roadsPartial, true, 'a closure the board could not draw makes the set partial');
  assert.ok(r.notices.includes('road.partial'), 'and the board says so');
  assert.deepEqual(Object.keys(app.roadMemory().reopened), [], 'the unreadable closure is not reported reopened');
  assert.ok(app.roadMemory().seen[id], 'it is still remembered as closed');
});

test('a table that hands back the same rows for every page is partial, never complete', async () => {
  const r = await runLive((k) => {
    if (k !== 'rows') return undefined;
    const body = clone(FX.page);
    body.data.totals.Records = FX_ROWS.length * 3;
    return answer(body);
  });
  assert.equal(r.threw, null);
  assert.equal(r.calls.filter((c) => c.kind === 'rows').length, 2, 'a page that adds nothing new ends the read');
  assert.equal(ST.roadsPartial, true, 'the set is short of what the table reports holding');
  assert.equal(r.lines.length, 9, 'repeated rows are not drawn twice');
  assert.deepEqual(Object.keys(app.roadMemory().seen), [], 'a partial set never feeds the reopened diff');
});

test('a genuine statewide zero is a measurement, but only off a table that proves it is current', async () => {
  const zero = await runLive((k) => (k === 'rows' ? answer(EMPTY_PAGE) : undefined));
  assert.equal(zero.threw, null);
  assert.deepEqual(zero.healthy, ['roads'], 'an answered zero is a real zero');
  assert.equal(zero.lines.length, 0);
  assert.equal(zero.calls.filter((c) => c.kind === 'census').length, 1, 'with no rows the stamp is read off the table');
  assert.deepEqual({ ...SB.situationModel().roads }, { flood: 0, total: 0 });

  const staleZero = await runLive((k) => (k === 'rows' ? answer(EMPTY_PAGE) : undefined),
    { now: FX_UPDATED + (app.ROAD_STALE_MIN + 5) * 60000 });
  assert.ok(staleZero.threw, 'a stalled table answering zero would otherwise publish an all-clear');
  assert.equal(SB.situationModel().src.roads, 'snapshot');

  const blindZero = await runLive((k) => (k === 'rows' ? answer(EMPTY_PAGE)
    : k === 'census' ? answer({ success: false, errors: ['x'] }) : undefined));
  assert.ok(blindZero.threw, 'a zero whose currency cannot be read is not an all-clear');
});

/* The pipeline archives the same table for the snapshot fallback and the playback history. A live
   row and the snapshot row of the same closure must agree on what the board keys and shows. */
const PY_ROWS = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('g', 'scripts/gen-roads-snapshot.py')
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)
req = json.load(sys.stdin)
out = {'STALE_MIN': g.STALE_MIN, 'FUTURE_MIN': g.FUTURE_MIN, 'COND': g.COND, 'LEGEND': g.LEGEND, 'COLS': g.COLS, 'rows': [], 'boxes': []}
for r in req['rows']:
    try:
        out['rows'].append(g.road_record(r, g.DEFAULT_BBOX))
    except Exception as e:
        out['rows'].append({'error': repr(e)})
for seg, box in req['boxes']:
    out['boxes'].append(g.line_hits_box([[tuple(p) for p in seg]], (box['xmin'], box['ymin'], box['xmax'], box['ymax'])))
print(json.dumps(out))
`;

// one real closure row under each line the source could plausibly start sending
const MALFORMED = ['LINESTRING Z (-95.2687 32.395 0, -95.27 32.39 0)', 'MULTILINESTRING Z ((-95.2687 32.395 0, -95.27 32.39 0))',
  'POINT (-95.2687 32.395)', 'LINESTRING EMPTY', 'MULTILINESTRING ()', 'LINESTRING (-95.2687 32.395, -95.27)',
  'LINESTRING (-95.2687 NaN, -95.27 32.39)', 'LINESTRING (-95.2687 inf, -95.27 32.39)',
  'MULTILINESTRING ((-95.2687 32.395, -95.27 32.39), (-95.27 x))', '', null]
  .map((g) => Object.assign({}, fxRow('SL0323'), { conditionsLine: g }));

test('the pipeline and the client read the DriveTexas table identically', () => {
  const boxes = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 400; i++) {
    const seg = [[-100 + rnd() * 4, 28 + rnd() * 4], [-100 + rnd() * 4, 28 + rnd() * 4]];
    boxes.push([seg, { xmin: -99, ymin: 29, xmax: -97.5, ymax: 30.5 }]);
  }
  const py = JSON.parse(execFileSync('python3', ['-c', PY_ROWS],
    { cwd: ROOT, input: JSON.stringify({ rows: FX_ROWS.concat(MALFORMED), boxes }), encoding: 'utf8' }));

  assert.equal(py.STALE_MIN, app.ROAD_STALE_MIN, 'E5: one stale window, two copies');
  assert.equal(py.FUTURE_MIN, app.ROAD_FUTURE_MIN, 'E5: one clock-skew allowance');
  assert.deepEqual(Array.from(py.LEGEND), Array.from(app.ROAD_ML_LEGEND), 'E5: one full code legend');
  assert.ok(Object.keys(app.ROAD_ML_COND).every((c) => app.ROAD_ML_LEGEND.includes(c)), 'the closure codes are legend codes');
  assert.deepEqual(py.COND, { ...app.ROAD_ML_COND }, 'E5: one condition legend');
  assert.deepEqual(py.COLS, Array.from(app.ROAD_ML_COLS), 'E5: one column list');

  const js = boxes.map(([seg, box]) => SB.roadLineInBox({ type: 'LineString', coordinates: seg }, box));
  assert.deepEqual(js, py.boxes, 'the AO intersection test must give one verdict in both places');
  assert.ok(js.filter(Boolean).length > 50 && js.filter((x) => !x).length > 50, 'both verdicts exercised');

  assert.deepEqual(MALFORMED.map((r) => SB.roadFromMl(r)), MALFORMED.map(() => false),
    'an unreadable line is a failure the caller counts, not a row that was never a closure');
  FX_ROWS.concat(MALFORMED).forEach((raw, i) => {
    const live = SB.roadFromMl(raw);
    const snap = py.rows[i];
    if (live === false) {
      assert.ok(snap && snap.error, `${raw.RTENM} ${raw.conditionsLine}: unreadable to the client only`);
      return;
    }
    if (!live) { assert.equal(snap, null, `${raw.RTENM}: kept by one side only`); return; }
    assert.ok(snap && !snap.error, `${raw.RTENM}: ${snap && snap.error}`);
    const asSnap = { route_name: snap.route, from_limit: snap.from, to_limit: snap.to };
    assert.equal(app.roadId(live.properties), app.roadId(asSnap), `${raw.RTENM}: a star must survive a source transition`);
    assert.equal(live.properties.condition, snap.cond);
    assert.equal(Date.parse(live.properties.start_time), Date.parse(snap.start));
    assert.equal(Date.parse(live.properties.end_time), Date.parse(snap.end));
    const v = Array.from(SB.roadVertex(live.geometry), (x) => Math.round(x * 1e4) / 1e4);
    assert.deepEqual(v, snap.v, `${raw.RTENM}: the snapshot vertex is the live line's first vertex`);
  });
});
