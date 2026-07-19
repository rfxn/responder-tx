'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

const { toUSNG } = loadApp();

/*
 * Ground truth generated from the NGA-based python `mgrs` library (mgrs.MGRS
 * .toMGRS at 1 m precision) — the same reference the app claims to match to
 * ±1 m. Regenerate with:
 *   python3 -c "import mgrs; print(mgrs.MGRS().toMGRS(LAT,LON))"
 * Points span the TX operating bbox plus hemisphere/zone/band edges.
 */
const CASES = [
  { lat: 29.75, lon: -99.35, mgrs: '14RMT6615891135' }, // TX Hill Country (map center)
  { lat: 30.0, lon: -98.0, mgrs: '14RNU9645019206' },
  { lat: 28.5, lon: -97.5, mgrs: '14RPS4680653509' },
  { lat: 31.0, lon: -101.5, mgrs: '14RKV6129932285' },
  { lat: 29.3, lon: -100.8, mgrs: '14RLT2517342567' },
  { lat: 30.3, lon: -99.0, mgrs: '14RNU0000052028' }, // 100 km grid boundary (easting 00000)
  { lat: 29.9, lon: -99.2, mgrs: '14RMU8069107721' },
  { lat: 28.9, lon: -100.2, mgrs: '14RLS8300397498' },
  { lat: 31.05, lon: -102.0, mgrs: '14RKV1368939011' }, // zone 13/14 boundary meridian
  { lat: 28.05, lon: -97.05, mgrs: '14RPS9166104275' },
  { lat: 33.9425, lon: 18.4231, mgrs: '34SBC6183858772' }, // northern hemisphere, zone 34
  { lat: -33.9249, lon: 18.4241, mgrs: '34HBH6188143182' }, // SOUTHERN hemisphere (northing +10^7)
  { lat: 0.0, lon: 0.0, mgrs: '31NAA6602100000' }, // equator + prime meridian
  { lat: 51.4779, lon: -0.0015, mgrs: '30UYC0821307235' }, // Greenwich, zone 30/31 edge
  { lat: 40.7484, lon: -73.9857, mgrs: '18TWL8562811322' }, // New York
  { lat: 64.135, lon: -21.895, mgrs: '27WVM5643612363' }, // high-latitude band W
];

// "14RMT6615891135" -> { zone:'14', band:'R', col:'M', row:'T', e:66158, n:91135 }
function parseMgrs(s) {
  const m = /^(\d+)([A-Z])([A-Z])([A-Z])(\d{5})(\d{5})$/.exec(s);
  assert.ok(m, `unparseable mgrs fixture: ${s}`);
  return { zone: m[1], band: m[2], col: m[3], row: m[4], e: +m[5], n: +m[6] };
}
// "14R MT 66158 91135" -> same shape
function parseUsng(s) {
  const m = /^(\d+)([A-Z]) ([A-Z])([A-Z]) (\d{5}) (\d{5})$/.exec(s);
  assert.ok(m, `toUSNG produced malformed string: ${s}`);
  return { zone: m[1], band: m[2], col: m[3], row: m[4], e: +m[5], n: +m[6] };
}

for (const c of CASES) {
  test(`toUSNG(${c.lat}, ${c.lon}) matches python mgrs ${c.mgrs}`, () => {
    const got = parseUsng(toUSNG(c.lat, c.lon));
    const want = parseMgrs(c.mgrs);
    assert.equal(got.zone, want.zone, 'UTM zone');
    assert.equal(got.band, want.band, 'latitude band');
    assert.equal(got.col, want.col, '100 km column letter');
    assert.equal(got.row, want.row, '100 km row letter');
    // ±1 m: the app's documented accuracy vs. python mgrs.
    assert.ok(Math.abs(got.e - want.e) <= 1, `easting ${got.e} vs ${want.e}`);
    assert.ok(Math.abs(got.n - want.n) <= 1, `northing ${got.n} vs ${want.n}`);
  });
}

test('output shape is a valid USNG string (zone/band, 100km sq, 5+5 digits)', () => {
  assert.match(toUSNG(29.75, -99.35), /^\d{1,2}[C-X] [A-Z]{2} \d{5} \d{5}$/);
});
