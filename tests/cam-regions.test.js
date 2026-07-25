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
  CAM_REGION_OTHER, CAM_REGION_MAX_MI, regionLabel } = loadApp();
const mapApp = loadMapApp();
const { CAM_LEGACY_PARAMS, PB_LIVE_HIDE, pbLiveHideAll } = mapApp;

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

test('camRegionId: a camera beyond the guard is named outside the regions, never absorbed', () => {
  withRegions(FIXTURE, () => {
    const r = camRegions();
    // the real case this exists for: USGS river cams around Ruidoso NM, ~120 mi from El Paso
    assert.equal(camRegionId(33.34, -105.73, r), CAM_REGION_OTHER.id);
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
    assert.equal(all.length, camRegions().length + 1);
    assert.equal(all[all.length - 1].id, CAM_REGION_OTHER.id);
  });
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
