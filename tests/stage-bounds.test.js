'use strict';

/* An impossible stage is no reading, never a flood.

   NWPS published SEIO2 (North Canadian River near Seiling) at 10000030 ft and SGET2 (Clear Creek
   near Sanger) at 10000000 ft, both with floodCategory "major", between 2026-08-19 and 2026-09-03.
   Every guard in the tree stopped only the LOW sentinel (<= -999), so the board drew a major
   gauge and the crest summary published two ten-million-foot major crests. NWPS itself later
   rewrote those same observations to -9999. See INTERNAL-NOTES.md "Impossible gauge stages".

   Everything below CALLS the code: the client's own ingestion and marker/popup path, and every
   Python copy of stage_ok() against the client's stageOk() on one probe vector. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadFullApp } = require('./harness.js');

const ROOT = path.join(__dirname, '..');
const app = loadFullApp();
const SB = app._sandbox;
const ST = app.state;

const PY_COPIES = ['fetch-snapshot.py', 'gen-crest-summary.py', 'gen-history.py', 'gen-feeds.py',
  'gen-caltopo.py', 'gen-records.py'];

// numbers, the two NWPS sentinels, the archived junk, real reservoir elevations, and each edge
const PROBES = [10000030, 10000000, -9999, -999, -696.32, -300, -299.99, 0, -1.47, 3.41, 681,
  6200.4, 7745.27, 24999.99, 25000, 25000.01, 1e9];
// values JSON cannot carry, named so both languages build the same thing
const SPECIAL = ['nan', 'inf', '-inf', 'none', 'true', 'str'];
const jsSpecial = { nan: NaN, inf: Infinity, '-inf': -Infinity, none: null, true: true, str: '5' };

const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();

function nwps(lid, primary, floodCategory, extra = {}) {
  return {
    lid, name: `${lid} test river near Somewhere`, latitude: 30.1, longitude: -97.9,
    status: {
      observed: { primary, primaryUnit: 'ft', secondary: -999, secondaryUnit: 'kcfs', floodCategory, validTime: iso(20) },
      forecast: { primary: -999, primaryUnit: '', secondary: -999, secondaryUnit: '', floodCategory: 'fcst_not_current', validTime: '0001-01-01T00:00:00Z' },
      ...extra,
    },
  };
}

function pyVerdicts() {
  const src = [
    'import json, sys, importlib.util as u',
    'special = {"nan": float("nan"), "inf": float("inf"), "-inf": float("-inf"), "none": None, "true": True, "str": "5"}',
    'probes, names, root = json.loads(sys.argv[1]), json.loads(sys.argv[2]), sys.argv[3]',
    'out = {}',
    'for n in names:',
    '    s = u.spec_from_file_location("m", root + "/scripts/" + n); m = u.module_from_spec(s); s.loader.exec_module(m)',
    '    out[n] = [m.stage_ok(v) for v in probes] + [m.stage_ok(special[k]) for k in json.loads(sys.argv[4])]',
    'print(json.dumps(out))',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', src, JSON.stringify(PROBES), JSON.stringify(PY_COPIES), ROOT,
    JSON.stringify(SPECIAL)], { cwd: ROOT, encoding: 'utf8' }));
}

test('stageOk rejects both sentinels and the archived junk, and keeps real reservoir elevations', () => {
  const ok = (v) => SB.stageOk(v);
  for (const bad of [10000030, 10000000, -9999, -999, -696.32, 25000, NaN, Infinity, null, undefined, '5', true]) {
    assert.equal(ok(bad), false, `${String(bad)} is not a stage`);
  }
  for (const good of [0, -1.47, 3.41, 681, 6200.4, 7745.27, 24999.99]) assert.equal(ok(good), true, `${good} ft is a stage`);
});

test('every Python stage_ok() copy returns the client stageOk() verdict on the same probes', () => {
  const js = PROBES.map((v) => SB.stageOk(v)).concat(SPECIAL.map((k) => SB.stageOk(jsSpecial[k])));
  assert.ok(js.includes(true) && js.includes(false), 'non-vacuity: the probe vector must split both ways');
  const py = pyVerdicts();
  assert.deepEqual(Object.keys(py).sort(), PY_COPIES.slice().sort(), 'every generator copy was loaded');
  for (const n of PY_COPIES) assert.deepEqual(py[n], js, `scripts/${n} stage_ok() disagrees with js/core.js stageOk()`);
});

// the live NWPS path: fetchGauges -> splitGauges -> renderGauges markers -> popup, all shipped code
async function ingest(rows) {
  const saved = {};
  const stubs = ['fetch', 'renderGaugesTab', 'renderForecastList', 'renderTiles'];
  for (const k of stubs) saved[k] = SB[k];
  SB.fetch = async () => ({ ok: true, status: 200, json: async () => ({ gauges: rows }) });
  SB.renderGaugesTab = () => {};
  SB.renderForecastList = () => {};
  SB.renderTiles = () => {};
  const markers = [];
  const prevL = SB.L, prevLayers = ST.layers;
  SB.L = {
    divIcon: (o) => ({ html: o.html }),
    marker: (ll, o) => {
      const m = { ll, icon: o.icon, z: o.zIndexOffset, popupFn: null };
      m.bindPopup = (fn) => { m.popupFn = fn; return m; };
      return m;
    },
  };
  ST.layers = Object.assign({}, prevLayers, { gauges: { clearLayers() { markers.length = 0; }, addLayer(m) { markers.push(m); } } });
  try {
    await SB.fetchGauges();
  } finally {
    Object.assign(SB, saved);
    SB.L = prevL;
    ST.layers = prevLayers;
  }
  return markers;
}

test('REGRESSION · a 10000030 ft "major" from NWPS is drawn and listed as unreadable, not as major', async () => {
  const bogus = nwps('SEIO2', 10000030, 'major');
  const real = nwps('REALT2', 27.84, 'major');
  const lake = nwps('LAKET2', 681.2, 'no_flooding');
  const markers = await ingest([bogus, real, lake]);

  assert.deepEqual(Array.from(ST.gauges, (g) => g.lid).sort(), ['LAKET2', 'REALT2'],
    'the severity-bearing set every count and tile reads must not hold the unreadable gauge');
  assert.deepEqual(Array.from(ST.gaugesDegraded, (g) => g.lid), ['SEIO2'], 'it is kept, as degraded');
  assert.equal(SB.gaugeState(bogus), 'stale', 'no usable current reading');
  assert.equal(SB.gaugeCat(bogus), 'none', 'never a flood signal');
  assert.equal(SB.gaugeHasReading(bogus), false, 'no level is printed off it');
  assert.equal(SB.gaugeStateCounts().major, 1, 'the legend counts one major gauge, the real one');

  const byLid = (lid) => markers.find((m) => m.ll[0] === 30.1 && m.popupFn && m.popupFn().innerHTML.includes(`${lid} test river`));
  const mBogus = byLid('SEIO2');
  assert.ok(mBogus, 'the unreadable gauge is still on the map');
  assert.match(mBogus.icon.html, /deg-stale/);
  assert.doesNotMatch(mBogus.icon.html, /cat-major/);
  assert.notEqual(mBogus.z, 1000, 'no major z-boost');
  const popup = mBogus.popupFn().innerHTML;
  assert.doesNotMatch(popup, /10000030/, 'the impossible value is never printed');
  assert.match(popup, /gstate\.stale/);
  assert.doesNotMatch(popup, /cat\.major/);

  // the controls: a real major and a reservoir elevation still read as what they are
  assert.match(byLid('REALT2').icon.html, /cat-major/);
  assert.match(byLid('REALT2').popupFn().innerHTML, /27\.84/);
  assert.equal(SB.gaugeState(lake), 'none');
  assert.match(byLid('LAKET2').popupFn().innerHTML, /681\.2/);
});

test('the gauge card for an unreadable gauge states the degraded label and no level', () => {
  const bogus = nwps('SGET2', 10000000, 'major');
  const html = SB.gaugeCardDiv(bogus).innerHTML;
  assert.doesNotMatch(html, /10000000/);
  assert.match(html, /gstate\.stale/);
  assert.doesNotMatch(html, /catw\.major/);
});

test('the low sentinel paired with a severity is unreadable too, and a bogus forecast crest is no forecast', () => {
  assert.equal(SB.gaugeState(nwps('LOWT2', -999, 'major')), 'stale');
  assert.equal(app.gaugeDegraded(nwps('LOWT2', -999, 'major')), true);
  const fc = nwps('FCT2', 12.1, 'no_flooding', {
    forecast: { primary: 10000000, primaryUnit: 'ft', floodCategory: 'major', validTime: new Date(Date.now() + 6 * 3600000).toISOString() },
  });
  assert.equal(SB.gaugeForecastCat(fc), null);
  assert.equal(SB.gaugeRising(fc), false, 'no rising-to-major claim off an impossible crest');
});

test('the published display copy of the same row lands in the same client state as the raw row', () => {
  const raw = nwps('SEIO2', 10000030, 'major');
  const src = [
    'import json, sys, importlib.util as u',
    's = u.spec_from_file_location("fs", sys.argv[2] + "/scripts/fetch-snapshot.py"); m = u.module_from_spec(s); s.loader.exec_module(m)',
    'print(json.dumps(m.displayable(json.loads(sys.argv[1]))))',
  ].join('\n');
  const shown = JSON.parse(execFileSync('python3', ['-c', src, JSON.stringify(raw), ROOT], { cwd: ROOT, encoding: 'utf8' }));
  assert.equal(shown.status.observed.floodCategory, 'obs_not_current');
  assert.equal(SB.gaugeState(shown), SB.gaugeState(raw), 'snapshot cold start and live NWPS agree');
  assert.equal(SB.gaugeState(shown), 'stale');
});
