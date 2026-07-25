'use strict';

/* Cameras are grouped by Texas region, not by the company that owns the lens. The region set is
   event config (data/event.json aoPresets), the assignment is nearest-anchor, and the invariant
   that matters is that no camera is ever quietly lost: one that sits far from every anchor is
   named as outside the regions and counted, rather than folded into the nearest Texas row. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, loadMapApp } = require('./harness.js');

const { CONFIG, camRegions, camRegionsAll, camRegionId, camRegionKey,
  CAM_REGION_OTHER, CAM_REGION_MAX_MI, CAM_REGION_ALL, regionLabel,
  CAM_STATE_REGIONS, camOutsideId } = loadApp();
const mapApp = loadMapApp();
const { CAM_LEGACY_PARAMS, PB_LIVE_HIDE, pbLiveHideAll,
  CAM_ROWS, CAM_SUBGROUPS, initCamRegionRows, camTriState, camParentRows, camParentOn } = mapApp;

const EVENT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'event.json'), 'utf8'));

function withRegions(presets, fn) {
  const saved = CONFIG.aoPresets;
  CONFIG.aoPresets = presets;
  try { fn(); } finally { CONFIG.aoPresets = saved; }
}

const FIXTURE = [
  { id: 'houston', label: 'Houston', anchors: [[29.76, -95.37]], band: 'coast' },
  { id: 'elpaso', label: 'El Paso', anchors: [[31.76, -106.49]], band: 'west' },
];

test('camRegionId: a camera lands in the region whose anchor is nearest', () => {
  withRegions(FIXTURE, () => {
    const r = camRegions();
    assert.equal(camRegionId(29.80, -95.40, r), 'houston');
    assert.equal(camRegionId(31.70, -106.40, r), 'elpaso');
  });
});

test('camRegionId: longitude is scaled by latitude, so nearest means real distance', () => {
  // 1 degree of longitude is ~60 mi at this latitude, not 69; a naive degree metric mis-assigns
  withRegions([
    { id: 'a', label: 'A', anchors: [[31.0, -100.0]] },
    { id: 'b', label: 'B', anchors: [[31.9, -100.0]] },
  ], () => {
    const r = camRegions();
    assert.equal(camRegionId(31.05, -100.6, r), 'a', 'closer in true distance to A');
  });
});

test('camRegionId: a camera beyond the guard is named by its own state, never absorbed', () => {
  withRegions(FIXTURE, () => {
    const r = camRegions();
    // the real case this exists for: USGS river cams around Ruidoso NM, ~120 mi from El Paso
    assert.equal(camRegionId(33.34, -105.73, r), 'nm');
    assert.notEqual(camRegionId(33.34, -105.73, r), 'elpaso');
  });
});

test('camRegionId: the guard is a real distance, honoured on both sides of the line', () => {
  withRegions([{ id: 'a', label: 'A', anchors: [[31.0, -100.0]] }], () => {
    const r = camRegions();
    const inside = 31.0 + (CAM_REGION_MAX_MI - 10) / 69;
    const outside = 31.0 + (CAM_REGION_MAX_MI + 10) / 69;
    assert.equal(camRegionId(inside, -100.0, r), 'a');
    assert.equal(camRegionId(outside, -100.0, r), CAM_REGION_OTHER.id);
  });
});

test('camRegionId: no usable region still returns the residual bucket, never null', () => {
  withRegions([], () => {
    assert.equal(camRegionId(30.0, -97.0, camRegions()), CAM_REGION_OTHER.id);
  });
});

test('camRegionId: a camera with no coordinates is null, so the caller counts it separately', () => {
  withRegions(FIXTURE, () => {
    const r = camRegions();
    for (const bad of [[NaN, -95], [29.7, undefined], [null, null], ['29.7', '-95.4']]) {
      assert.equal(camRegionId(bad[0], bad[1], r), null, JSON.stringify(bad));
    }
  });
});

test('camRegions: config entries without an id, label or usable anchor are dropped', () => {
  withRegions([
    { id: 'ok', label: 'OK', anchors: [[30, -97]] },
    { label: 'no id', anchors: [[30, -97]] },
    { id: 'nolabel', anchors: [[30, -97]] },
    { id: 'noanchors', label: 'No anchors' },
    { id: 'badanchors', label: 'Bad anchors', anchors: [[30], ['x', -97]] },
    null,
  ], () => {
    assert.deepEqual(camRegions().map((p) => p.id), ['ok']);
  });
});

test('camRegionsAll: the residual bucket is always present and always last', () => {
  withRegions(FIXTURE, () => {
    const all = camRegionsAll();
    assert.equal(all.length, camRegions().length + CAM_STATE_REGIONS.length + 1);
    assert.equal(all[all.length - 1].id, CAM_REGION_OTHER.id,
      'the residual must stay last, so a camera in no named state is the final row, never a hidden one');
  });
});

/* ---------- out-of-state buckets ---------- */

test('camOutsideId: the state is read off the coordinates, never off a source list', () => {
  // the four boxes are disjoint, so a point resolves to exactly one of them
  assert.equal(camOutsideId(33.34, -105.73), 'nm', 'Ruidoso NM');
  assert.equal(camOutsideId(36.03, -94.91), 'ok', 'Illinois River near Moodys OK');
  assert.equal(camOutsideId(34.75, -92.29), 'ar', 'Little Rock AR');
  assert.equal(camOutsideId(30.45, -91.19), 'la', 'Baton Rouge LA');
  // nothing about a camera record but its position is consulted
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'core.js'), 'utf8');
  const fn = src.match(/function camOutsideId\(lat, lon\)[\s\S]*?\n\}/);
  assert.ok(fn, 'camOutsideId() not found');
  assert.ok(!/\bsrc\b|camId|httpsurl|nwisId/.test(fn[0]),
    'the bucket must come from the coordinates, so a new source inherits it without a list');
});

test('camOutsideId: the state boxes are disjoint, so no point is claimed by two buckets', () => {
  for (const a of CAM_STATE_REGIONS) {
    for (const b of CAM_STATE_REGIONS) {
      if (a.id === b.id) continue;
      const overlapLat = a.bbox[0][0] < b.bbox[1][0] && b.bbox[0][0] < a.bbox[1][0];
      const overlapLon = a.bbox[0][1] < b.bbox[1][1] && b.bbox[0][1] < a.bbox[1][1];
      assert.ok(!(overlapLat && overlapLon), `${a.id} and ${b.id} overlap, so a camera has two homes`);
    }
  }
});

test('a point in no state box keeps the residual, which stays reachable and never disappears', () => {
  // deep in Mexico: outside every Texas region and outside every state box
  assert.equal(camOutsideId(24.0, -101.0), CAM_REGION_OTHER.id);
  withRegions(FIXTURE, () => {
    assert.equal(camRegionId(24.0, -101.0, camRegions()), CAM_REGION_OTHER.id,
      'a camera no bucket names must still be counted, never filed under a state it is not in');
  });
  const ids = camRegionsAll().map((p) => p.id);
  assert.ok(ids.includes(CAM_REGION_OTHER.id), 'the residual row must survive the state split');
});

test('the state boxes never claim a camera the Texas regions already placed', () => {
  withRegions(EVENT.aoPresets, () => {
    const r = camRegions();
    // El Paso sits inside the New Mexico rectangle; the Texas guard runs first, so it stays Texas
    assert.equal(camRegionId(31.76, -106.49, r), 'elpaso');
    for (const [lat, lon, want] of [[29.76, -95.37, 'houston'], [32.78, -96.80, 'dfw'],
      [35.22, -101.83, 'panhandle'], [30.27, -97.74, 'austin']]) {
      assert.equal(camRegionId(lat, lon, r), want, `${want} camera was pulled out of state`);
    }
  });
});

test('every out-of-state camera the board ships lands in a named state bucket', () => {
  const cams = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cameras.json'), 'utf8'));
  withRegions(EVENT.aoPresets, () => {
    const r = camRegions();
    const counts = {};
    for (const p of camRegionsAll()) counts[p.id] = 0;
    for (const arr of Object.values(cams)) {
      if (!Array.isArray(arr)) continue;
      for (const c of arr) {
        const id = camRegionId(c.lat, c.lon, r);
        if (id !== null) counts[id]++;
      }
    }
    const outstate = CAM_STATE_REGIONS.reduce((a, sr) => a + counts[sr.id], 0);
    assert.ok(outstate > 0, 'the split must actually be carrying the out-of-state cameras');
    assert.equal(counts[CAM_REGION_OTHER.id], 0,
      'every out-of-state camera in the inventory should now be named by its state');
    // and the Texas rows are untouched by the split
    assert.ok(counts.houston > 100 && counts.dfw > 100, 'a Texas region lost cameras to a state box');
  });
});

test('the out-of-state buckets are addressable ids that cannot collide or shadow a region', () => {
  const cfgIds = EVENT.aoPresets.map((p) => p.id);
  for (const sr of CAM_STATE_REGIONS) {
    assert.notEqual(sr.id, CAM_REGION_ALL, 'a bucket id must never be the statewide token');
    assert.notEqual(sr.id, CAM_REGION_OTHER.id);
    assert.ok(!cfgIds.includes(sr.id), `${sr.id} collides with a configured region id`);
    assert.ok(/^[a-z]+$/.test(sr.id), 'ids travel in a URL, so keep them bare');
    assert.ok(sr.i18nKey && sr.band, `${sr.id} needs a name and a band or it renders as a bare id`);
    assert.ok(CAM_SUBGROUPS.some(([b]) => b === sr.band), `${sr.id} band is not a rendered group`);
  }
});

test('regionLabel: config regions name themselves, the residual takes its name from i18n', () => {
  assert.equal(regionLabel({ label: 'Houston', labelEs: 'Houston MX' }, 'en'), 'Houston');
  assert.equal(regionLabel({ label: 'Houston', labelEs: 'Houston MX' }, 'es'), 'Houston MX');
  assert.equal(regionLabel({ label: 'Houston' }, 'es'), 'Houston', 'falls back, never blank');
  assert.equal(regionLabel(CAM_REGION_OTHER, 'en'), 'cams.region.other', 'harness t() echoes the key');
});

test('camRegionKey: layer keys are namespaced so no region id can collide with a real layer', () => {
  assert.equal(camRegionKey('houston'), 'camsR_houston');
  assert.ok(camRegionKey(CAM_REGION_OTHER.id).startsWith('camsR_'));
});

/* ---------- the shipped region set ---------- */

test('data/event.json: every region carries an id, both labels, bounds and anchors', () => {
  assert.ok(EVENT.aoPresets.length >= 8, 'a statewide board needs a real region set');
  const ids = EVENT.aoPresets.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate region id');
  assert.ok(!ids.includes(CAM_REGION_OTHER.id), 'a config region may not shadow the residual bucket');
  assert.ok(!ids.includes(CAM_REGION_ALL), `a config region may not claim '${CAM_REGION_ALL}', the statewide ?camreg= token`);
  for (const p of EVENT.aoPresets) {
    assert.ok(p.id && typeof p.label === 'string' && p.label, `${p.id}: label`);
    assert.ok(typeof p.labelEs === 'string' && p.labelEs, `${p.id}: es label is mandatory`);
    assert.ok(Array.isArray(p.anchors) && p.anchors.length, `${p.id}: anchors`);
    assert.ok(Array.isArray(p.bounds) && p.bounds.length === 2, `${p.id}: bounds`);
    for (const a of p.anchors) {
      assert.ok(a[0] >= 25.0 && a[0] <= 37.0 && a[1] >= -107.5 && a[1] <= -93.0,
        `${p.id}: anchor ${JSON.stringify(a)} is outside Texas`);
      assert.ok(a[0] >= p.bounds[0][0] && a[0] <= p.bounds[1][0]
        && a[1] >= p.bounds[0][1] && a[1] <= p.bounds[1][1],
        `${p.id}: anchor ${JSON.stringify(a)} sits outside the region's own bounds`);
    }
  }
});

test('data/event.json: no user-facing region label uses an em-dash', () => {
  for (const p of EVENT.aoPresets) {
    assert.ok(!p.label.includes('—'), `${p.id} en`);
    assert.ok(!p.labelEs.includes('—'), `${p.id} es`);
  }
});

test('the shipped regions place the Texas cities an operator would look for', () => {
  withRegions(EVENT.aoPresets, () => {
    const r = camRegions();
    const at = (lat, lon) => camRegionId(lat, lon, r);
    for (const [name, lat, lon] of [
      ['Houston', 29.760, -95.370], ['Dallas', 32.777, -96.797], ['Fort Worth', 32.755, -97.331],
      ['Austin', 30.267, -97.743], ['San Antonio', 29.424, -98.494], ['El Paso', 31.762, -106.485],
      ['Corpus Christi', 27.801, -97.396], ['Beaumont', 30.080, -94.127], ['Lubbock', 33.578, -101.855],
      ['Amarillo', 35.222, -101.831], ['Waco', 31.549, -97.147], ['Tyler', 32.351, -95.301],
      ['Brownsville', 25.902, -97.497], ['Midland', 31.997, -102.078], ['Laredo', 27.506, -99.507],
    ]) {
      assert.notEqual(at(lat, lon), CAM_REGION_OTHER.id, `${name} must fall inside a Texas region`);
    }
  });
});

/* ---------- URL contracts ---------- */

test('CAM_LEGACY_PARAMS: every retired per-source param still resolves to real regions', () => {
  const ids = new Set(EVENT.aoPresets.map((p) => p.id));
  // frozen: these are in shared links in the wild and may never be renamed or dropped
  for (const qk of ['cams', 'camr', 'cama', 'camf', 'camh', 'caml', 'came', 'camm']) {
    assert.ok(qk in CAM_LEGACY_PARAMS, `${qk} lost its mapping, so old links go dead`);
    const v = CAM_LEGACY_PARAMS[qk];
    if (v === '*') continue;
    assert.ok(Array.isArray(v) && v.length, `${qk} maps to nothing`);
    for (const id of v) assert.ok(ids.has(id), `${qk} names region '${id}' which does not exist`);
  }
});

test('CAM_LEGACY_PARAMS: the statewide sources map to every region, not just one', () => {
  assert.equal(CAM_LEGACY_PARAMS.cams, '*', 'TxDOT cameras are statewide');
  assert.equal(CAM_LEGACY_PARAMS.camr, '*', 'USGS river cameras are statewide');
});

test('js/boot.js reads camreg and still honours every legacy camera param', () => {
  const boot = fs.readFileSync(path.join(__dirname, '..', 'js', 'boot.js'), 'utf8');
  assert.match(boot, /shareQs\.get\('camreg'\)/, 'camreg is the new addressable form');
  assert.match(boot, /CAM_LEGACY_PARAMS/, 'legacy params must still be read on the way in');
});

/* ---------- parent toggles: one statewide, one per band ----------
   A parent reports its children rather than holding its own state, so three regions switched on
   individually must leave the statewide parent reading partial and not off. */

// CAM_ROWS is built from the event config at map init; membership is read through state.map, so a
// set of "on" layer keys stands in for the Leaflet map here
function withCamRows(onKeys, counts, fn) {
  const s = mapApp.state;
  const saved = { presets: mapApp.CONFIG.aoPresets, map: s.map, layers: s.layers, counts: s.camCounts };
  mapApp.CONFIG.aoPresets = EVENT.aoPresets;
  initCamRegionRows();
  const on = new Set(onKeys);
  s.layers = {};
  for (const r of CAM_ROWS) s.layers[r[0]] = r[0]; // truthy sentinel; hasLayer below matches on it
  s.map = { hasLayer: (l) => on.has(l) };
  s.camCounts = counts;
  try { return fn(); } finally {
    mapApp.CONFIG.aoPresets = saved.presets;
    s.map = saved.map;
    s.layers = saved.layers;
    s.camCounts = saved.counts;
  }
}

test('camTriState: on only when every child is on, mixed for any partial, off for none', () => {
  assert.equal(camTriState(0, 12), 'off');
  assert.equal(camTriState(1, 12), 'mixed');
  assert.equal(camTriState(11, 12), 'mixed');
  assert.equal(camTriState(12, 12), 'on');
  assert.equal(camTriState(0, 0), 'off', 'no children is off, never a vacuously-on parent');
});

// map.js lives in its own sandbox, so the row list and every array it returns come from that realm
const parentIds = (band) => [...camParentRows(band)].map((r) => r[8].id);
// the shipped set, read from the config file rather than a sandbox whose presets are not applied yet
const SHIPPED_IDS = EVENT.aoPresets.map((p) => p.id)
  .concat(CAM_STATE_REGIONS.map((s) => s.id), [CAM_REGION_OTHER.id]);

test('the statewide parent owns every camera region row, including the residual', () => {
  withCamRows([], null, () => {
    const ids = parentIds(null);
    assert.deepEqual(ids, SHIPPED_IDS);
    assert.ok(ids.includes(CAM_REGION_OTHER.id), 'the residual row must be covered by statewide too');
  });
});

test('a band parent owns exactly its own band, and the bands partition the regions', () => {
  withCamRows([], null, () => {
    const seen = [];
    for (const [band] of CAM_SUBGROUPS) {
      for (const r of camParentRows(band)) assert.equal(r[7], band, `${r[8].id} is in the wrong band`);
      seen.push(...parentIds(band));
    }
    assert.deepEqual(seen.slice().sort(), parentIds(null).sort(),
      'every region belongs to exactly one band parent');
    assert.equal(new Set(seen).size, seen.length, 'a region counted by two band parents');
  });
});

test('the statewide parent reads partial when only some regions were switched on by hand', () => {
  const three = ['houston', 'austin', 'dfw'].map(camRegionKey);
  withCamRows(three, null, () => {
    const rows = camParentRows(null);
    assert.equal(camParentOn(rows), 3);
    assert.equal(camTriState(camParentOn(rows), rows.length), 'mixed',
      'three regions on individually must not leave the statewide parent reading off');
  });
  withCamRows([], null, () => {
    const rows = camParentRows(null);
    assert.equal(camTriState(camParentOn(rows), rows.length), 'off');
  });
  withCamRows(SHIPPED_IDS.map(camRegionKey), null, () => {
    const rows = camParentRows(null);
    assert.equal(camTriState(camParentOn(rows), rows.length), 'on');
  });
});

test('a band parent reads on once its own regions are on, whatever the rest of the state is', () => {
  const coast = EVENT.aoPresets.filter((p) => p.band === 'coast').map((p) => camRegionKey(p.id));
  withCamRows(coast, null, () => {
    const kids = camParentRows('coast');
    assert.equal(camTriState(camParentOn(kids), kids.length), 'on');
    const all = camParentRows(null);
    assert.equal(camTriState(camParentOn(all), all.length), 'mixed', 'statewide is still only partial');
  });
});

test('a region with no cameras is not counted by the parent that would claim to cover it', () => {
  // camRegionHasCams drops the row from the sheet; a parent that still counted it could never
  // reach "on", and would toggle a layer the user was never shown
  const counts = {};
  for (const id of SHIPPED_IDS) counts[id] = id === 'houston' ? 0 : 5;
  withCamRows([], counts, () => {
    const ids = camParentRows(null).map((r) => r[8].id);
    assert.ok(!ids.includes('houston'), 'an empty region is still offered to the parent');
    assert.equal(ids.length, SHIPPED_IDS.length - 1);
    assert.ok(!camParentRows('coast').map((r) => r[8].id).includes('houston'));
  });
});

/* ---------- time integrity ---------- */

test('pbLiveHideAll covers every camera region layer, so none draws under a past frame', () => {
  // map.js lives in its own sandbox, so the region config has to be set on that bundle's CONFIG
  const saved = mapApp.CONFIG.aoPresets;
  mapApp.CONFIG.aoPresets = EVENT.aoPresets;
  try {
    const keys = pbLiveHideAll().map(([k]) => k);
    for (const p of mapApp.camRegionsAll()) {
      assert.ok(keys.includes(camRegionKey(p.id)),
        `${p.id} camera layer is not hidden during playback, so today's cameras impersonate the past`);
    }
    assert.equal(new Set(keys).size, keys.length, 'a duplicate would double-restore on go-live');
  } finally { mapApp.CONFIG.aoPresets = saved; }
});

test('pbLiveHideAll keeps the static entries the sweep already covered', () => {
  const keys = pbLiveHideAll().map(([k]) => k);
  for (const k of PB_LIVE_HIDE.map(([x]) => x)) assert.ok(keys.includes(k), `${k} dropped from the sweep`);
  assert.ok(keys.includes('shelters') && keys.includes('roadReopen'));
});

/* ---------- source liveness and attribution ---------- */
/* NIMS lists a camera from the day it is registered, so the board once shipped two that had never
   returned a single frame. The same gate now covers every still source that publishes a stamp. */

const ROOT_DIR = path.join(__dirname, '..');
const readFile = (f) => fs.readFileSync(path.join(ROOT_DIR, f), 'utf8');
const CAMS = JSON.parse(readFile('data/cameras.json'));
const MAX_AGE_D = Number(readFile('scripts/gen-cameras.py').match(/CAM_MAX_AGE_D = (\d+)/)[1]);

test('the ATX Floods low-water-crossing cams are on the board', () => {
  const rows = CAMS.atxfloods || [];
  assert.ok(rows.length >= 10, `ATX Floods inventory is ${rows.length}`);
  for (const c of rows) {
    assert.ok(/^[0-9]{1,8}$/.test(String(c.id)), `${c.id} would be rejected by the proxy validator`);
    assert.ok(Number.isFinite(c.lat) && Number.isFinite(c.lon), `${c.id} has no position`);
    assert.ok(c.name, `${c.id} has no name`);
  }
  assert.match(readFile('scripts/gen-cameras.py'), /def atxfloods_cams\(\)/, 'the poller is missing');
  assert.match(readFile('scripts/cycle-check.sh'), /"atxfloods": "id"/, 'cycle-check does not check the source');
});

test('every shipped ATX Floods camera has actually produced a recent image', () => {
  // the same gate as the river cams: a crossing with no frame ever, or none this month, is not
  // something an operator can look through and must not be offered as one
  const rows = CAMS.atxfloods || [];
  const noStamp = rows.filter((c) => !c.newest).map((c) => c.id);
  assert.deepEqual(noStamp, [], 'a camera that has never returned a frame is listed as available');
  const tooOld = rows
    .map((c) => [c.id, (Date.now() - Date.parse(c.newest)) / 86400000])
    .filter(([, d]) => !Number.isFinite(d) || d > MAX_AGE_D + 1); // +1d: the file is committed, not live
  assert.deepEqual(tooOld, [], 'a long-dead camera is still shipped');
});

test('the ATX Floods credit names the operator of the service, not just the City', () => {
  // the service is Beholder Technology, LLC; the cameras themselves report jurisdiction COA
  for (const s of [readFile('js/cameras.js').match(/const CAM_ATTRIB_ATX = '([^']+)'/)[1],
    CAMS.attribution.atxfloods]) {
    assert.match(s, /Beholder Technology/, 'the operator is not credited');
    assert.match(s, /City of Austin/, 'the camera owner is not credited');
    assert.ok(!s.includes('—'), 'em-dash in a user-facing credit');
  }
});

test('ATX Floods routes through the same-origin proxy on both servers, id-validated', () => {
  const re = /api\.atxfloods\.com/;
  for (const f of ['functions/api/cam/[district]/[icd].js', 'server.py']) {
    assert.match(readFile(f), re, `${f} has no atxfloods route`);
    assert.ok(readFile(f).includes('[0-9]{1,8}'), `${f} atxfloods id pattern drifted from the generator`);
  }
  const genRe = readFile('scripts/gen-cameras.py').match(/ATX_ID_RE = re\.compile\(r'([^']+)'\)/)[1];
  assert.equal(genRe, '^[0-9]{1,8}$');
  // the browser never talks to the Beholder host: the proxy is the only path, so no CSP host is added
  for (const f of ['_headers']) {
    assert.ok(!/atxfloods/i.test(readFile(f)), `${f} allowlists api.atxfloods.com instead of proxying`);
  }
  assert.ok(!/atxfloods/i.test(readFile('server.py').match(/^CSP = \([\s\S]*?\)$/m)[0]),
    'the server CSP allowlists api.atxfloods.com instead of proxying');
  assert.ok(!/api\.atxfloods\.com/.test(readFile('js/cameras.js')),
    'the client reaches the Beholder host directly instead of the same-origin proxy');
});

test('the frozen camf link param still resolves', () => {
  // v0.99.0 froze these: an old shared link must keep opening the same cameras. camf maps to the
  // Austin region, not to the ATX Floods source, so a source coming or going leaves it intact.
  assert.deepEqual([...CAM_LEGACY_PARAMS.camf], ['austin']); // cross-realm array: copy before comparing
  for (const p of ['cams', 'camr', 'cama', 'camf', 'camh', 'caml', 'came', 'camm']) {
    assert.ok(CAM_LEGACY_PARAMS[p], `frozen link param ${p} was dropped`);
  }
});

test('every ATX Floods camera lands in the Austin region row', () => {
  withRegions(EVENT.aoPresets, () => {
    const r = camRegions();
    for (const c of CAMS.atxfloods || []) {
      assert.equal(camRegionId(c.lat, c.lon, r), 'austin', `${c.name} is not in the Austin row`);
    }
  });
});

test('every shipped river camera has actually produced an image', () => {
  const rows = CAMS.river || [];
  assert.ok(rows.length >= 20, `river inventory collapsed to ${rows.length}`);
  const noStamp = rows.filter((c) => !c.newest).map((c) => c.camId);
  assert.deepEqual(noStamp, [], 'a camera that has never returned a frame is listed as available');
  assert.equal(MAX_AGE_D, 30);
  const tooOld = rows
    .map((c) => [c.camId, (Date.now() - Date.parse(c.newest)) / 86400000])
    .filter(([, d]) => !Number.isFinite(d) || d > MAX_AGE_D + 1); // +1d: the file is committed, not live
  assert.deepEqual(tooOld, [], 'a long-dead camera is still shipped');
});

test('the two cameras that had never produced a frame are not in the inventory', () => {
  const ids = new Set((CAMS.river || []).map((c) => c.camId));
  for (const dead of ['TX_Ray_Roberts_Lake_near_Pilot_Point', 'TX_Trinity_Rvr_at_Hwy_287_nr_Cayuga_TX',
    'TX_New_Year_Ck_at_FM_1155_nr_Chappel_Hill']) {
    assert.ok(!ids.has(dead), `${dead} is back in the shipped inventory`);
  }
});

test('the river bbox reaches the Panhandle and the Pecos headwaters that feed Texas', () => {
  const gen = readFile('scripts/gen-cameras.py');
  const box = gen.match(/CAM_RIVER_BBOX = \(([^)]+)\)/)[1].split(',').map((n) => Number(n.trim()));
  assert.equal(box.length, 4);
  assert.ok(box[3] >= 36.5, `north edge ${box[3]} still clips the Texas Panhandle`);
  const ids = new Set((CAMS.river || []).map((c) => c.camId));
  assert.ok(ids.has('TX_Canadian_Rv_nr_Amarillo'), 'the Canadian River at Amarillo is still clipped out');
});

test('Port Houston ships with a zero-byte guard and no invented berth coordinates', () => {
  const gen = readFile('scripts/gen-cameras.py');
  assert.match(gen, /PORTHOU_MIN_BYTES/, 'the empty-frame guard is missing');
  assert.match(gen, /porthou_still_live/, 'the liveness check is missing');
  const rows = CAMS.porthou || [];
  assert.ok(rows.length >= 10, `Port Houston inventory is ${rows.length}`);
  for (const c of rows) {
    assert.ok(/^[A-Za-z0-9_]{1,32}$/.test(c.id), `${c.id} would be rejected by the proxy validator`);
    assert.ok(Number.isFinite(c.lat) && Number.isFinite(c.lon), `${c.id} has no position`);
  }
  // every wharf cam on a terminal carries that terminal's position; no per-berth coordinate is invented
  const bct = new Set(rows.filter((c) => c.id.startsWith('bct_')).map((c) => `${c.lat},${c.lon}`));
  const bpt = new Set(rows.filter((c) => c.id.startsWith('bpt_')).map((c) => `${c.lat},${c.lon}`));
  assert.equal(bct.size, 1, 'Barbours Cut cams claim more position precision than the source publishes');
  assert.equal(bpt.size, 1, 'Bayport cams claim more position precision than the source publishes');
  // and the viewer note says the position is the terminal, in both languages
  const I18N_T = require('./i18n-load.js');
  for (const lang of ['en', 'es']) {
    assert.ok(I18N_T[lang]['cam.porthou.note'], `${lang} missing cam.porthou.note`);
    assert.ok(I18N_T[lang]['cam.channel'], `${lang} missing cam.channel`);
  }
  assert.match(I18N_T.en['cam.porthou.note'], /terminal not the berth/);
});

test('Port Houston routes through the same-origin proxy on both servers, id-validated', () => {
  const re = /porthou.*info\.porthouston\.com\/vtraffic\/gateimages/;
  assert.match(readFile('functions/api/cam/[district]/[icd].js'), re, 'the Pages Function has no porthou route');
  assert.match(readFile('server.py'), re, 'server.py has no porthou route');
  // the proxy is an allowlist, never an open image proxy: the id pattern must match the generator's
  const gen = readFile('scripts/gen-cameras.py');
  const genRe = gen.match(/PORTHOU_ID_RE = re\.compile\(r'([^']+)'\)/)[1];
  assert.equal(genRe, '^[A-Za-z0-9_]{1,32}$');
  for (const f of ['functions/api/cam/[district]/[icd].js', 'server.py']) {
    assert.ok(readFile(f).includes('[A-Za-z0-9_]{1,32}'), `${f} porthou id pattern drifted from the generator`);
  }
  assert.ok(!/porthouston/.test(readFile('_headers')),
    'Port Houston must stay same-origin through the proxy, never a new CSP host');
});

test('El Paso bridge cams are not grown while the City forbids reproduction', () => {
  const gen = readFile('scripts/gen-cameras.py');
  const table = gen.slice(gen.indexOf('ELP_BRIDGE_CAMS = ('), gen.indexOf('PORTHOU_HOST'));
  assert.ok(table.length > 100, 'the El Paso table was not found');
  assert.ok(!/bridgesantafe2/.test(table),
    'bridgesantafe2 is live but elpasotexas.gov/disclaimer forbids reproduction without written consent');
  assert.match(gen, /prior written consent of the CITY OF EL PASO/,
    'the reason that stream is deliberately absent must stay recorded next to the table');
});
