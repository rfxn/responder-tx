'use strict';

/* The seven plain regions (owner, 2026-11-24): the map picker reads "All Texas" and then seven named
   regions in a fixed order, the camera sheet offers those seven plus one Neighboring states row, and
   every id the twelve-region set put into saved views and links still resolves. Everything here
   runs the shipped code against the shipped data/event.json. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, loadMapApp } = require('./harness.js');
const I18N = require('./i18n-load.js');

const EVENT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'event.json'), 'utf8'));
const IDS = ['gulfcoast', 'southtx', 'centraltx', 'northtx', 'easttx', 'westtx', 'panhandle'];

/* initAoJump() against a DOM that records what it builds, in the language asked for. Chips come
   in the order the picker shows them; `fn` runs while the stubs are in place, so a click can be fired. */
function picker(lang, fn = (p) => p) {
  const app = loadMapApp();
  const sb = app._sandbox;
  const made = [];
  const clicks = new Map();
  const node = (tag, cls) => {
    const el = { tag, className: cls, textContent: '', innerHTML: '', title: '', attrs: {},
      classList: { add() {}, remove() {}, contains: () => false },
      setAttribute(k, v) { el.attrs[k] = v; }, addEventListener() {}, contains: () => false };
    made.push(el);
    return el;
  };
  const fits = [];
  const saved = { L: sb.L, t: sb.t, getLang: sb.getLang, presets: app.CONFIG.aoPresets, map: app.state.map };
  sb.L = {
    DomUtil: { create: node },
    DomEvent: { on: (el, ev, fn) => clicks.set(el, fn), disableClickPropagation() {}, disableScrollPropagation() {} },
  };
  sb.t = (k) => (k in I18N[lang] ? I18N[lang][k] : k);
  sb.getLang = () => lang;
  app.CONFIG.aoPresets = EVENT.aoPresets;
  app.state.map = { getContainer: () => ({}), on() {}, fitBounds(b) { fits.push(b); } };
  try {
    sb.initAoJump();
    const chips = made.filter((e) => e.className === 'ao-chip');
    return fn({ chips, current: made.find((e) => e.className === 'ao-current'), click: (c) => clicks.get(c)(), fits });
  } finally {
    sb.L = saved.L; sb.t = saved.t; sb.getLang = saved.getLang;
    app.CONFIG.aoPresets = saved.presets; app.state.map = saved.map;
  }
}

test('the picker shows All Texas and then the seven regions, in order, in English', () => {
  const p = picker('en');
  assert.deepEqual(p.chips.map((c) => c.textContent), ['All Texas', 'Gulf Coast', 'South Texas', 'Central Texas',
    'North Texas', 'East Texas', 'West Texas', 'Panhandle']);
  assert.match(p.current.innerHTML, /All Texas/, 'the resting pick is All Texas');
});

test('the picker shows the same seven regions in Spanish', () => {
  const p = picker('es');
  assert.deepEqual(p.chips.map((c) => c.textContent), ['Todo Texas', 'Costa del Golfo', 'Sur de Texas',
    'Centro de Texas', 'Norte de Texas', 'Este de Texas', 'Oeste de Texas', 'Panhandle']);
});

test('no picker text says AO, in either language', () => {
  for (const lang of ['en', 'es']) {
    const p = picker(lang);
    for (const el of p.chips.concat([p.current])) {
      for (const txt of [el.textContent, el.innerHTML, el.title]) {
        assert.ok(!/\bAO\b/.test(txt), `${lang}: "${txt}" still reads as jargon`);
      }
    }
  }
});

test('tapping a region chip frames that region', () => {
  picker('en', (p) => {
    p.click(p.chips[1]);
    assert.deepEqual(p.fits, [EVENT.aoPresets[0].bounds], 'Gulf Coast frames its own box');
    p.click(p.chips[7]);
    assert.deepEqual(p.fits[1], EVENT.aoPresets[6].bounds, 'Panhandle frames its own box');
  });
});

test('every retired region id resolves to the region the owner merged it into', () => {
  const app = loadApp();
  const saved = app.CONFIG.aoPresets;
  app.CONFIG.aoPresets = EVENT.aoPresets;
  try {
    const want = { houston: 'gulfcoast', beaumont: 'gulfcoast', coastalbend: 'gulfcoast', rgv: 'southtx',
      sanantonio: 'southtx', austin: 'centraltx', centraltx: 'centraltx', dfw: 'northtx', easttx: 'easttx',
      westtx: 'westtx', elpaso: 'westtx', panhandle: 'panhandle' };
    for (const [old, now] of Object.entries(want)) assert.equal(app.regionIdNow(old), now, old);
    assert.equal(app.regionIdNow('all'), 'all', 'the statewide camera token is never an alias');
    assert.equal(app.regionIdNow('full'), 'full', 'nor is the All Texas pill id');
  } finally { app.CONFIG.aoPresets = saved; }
});

test('a retired id is claimed by exactly one region and never shadows a live one', () => {
  const live = new Set(EVENT.aoPresets.map((p) => p.id));
  const seen = new Set();
  for (const p of EVENT.aoPresets) {
    for (const a of p.aliases || []) {
      assert.ok(/^[a-z]+$/.test(a), `${a}: ids travel in a URL, so keep them bare`);
      assert.ok(!live.has(a), `${a} is both retired and live, so a link to it is ambiguous`);
      assert.ok(!seen.has(a), `${a} is claimed by two regions`);
      assert.ok(!['all', 'full', 'other'].includes(a), `${a} is a reserved token`);
      seen.add(a);
    }
  }
});

test('camera rows: a fixture inventory lands in its regions and the far camera in Neighboring states', () => {
  const app = loadApp();
  const sb = app._sandbox;
  const { state, CONFIG, camRegionKey, camRegionsAll } = app;
  const savedPresets = CONFIG.aoPresets;
  const saved = { cameras: state.cameras, camLayerList: state.camLayerList, layers: state.layers };
  const savedSync = sb.layerSheetSync;
  CONFIG.aoPresets = EVENT.aoPresets;
  const got = {};
  state.layers = {};
  for (const p of camRegionsAll()) {
    got[p.id] = [];
    state.layers[camRegionKey(p.id)] = { clearLayers() { got[p.id].length = 0; }, addLayers(m) { got[p.id].push(...m); } };
  }
  state.camLayerList = Object.values(state.layers);
  state.cameras = {
    txdot: [{ name: 'IH-45 @ Downtown', lat: 29.76, lon: -95.36 }, { name: 'IH-10 @ Beaumont', lat: 30.08, lon: -94.12 },
      { name: 'IH-35 @ Waco', lat: 31.55, lon: -97.14 }, { name: 'US-54 @ State Line', lat: 32.0, lon: -106.33 }],
    river: [{ camId: 'NM_Ruidoso', name: 'Rio Ruidoso at Ruidoso, NM', lat: 33.34, lon: -105.73 }],
  };
  sb.layerSheetSync = () => {};
  try {
    sb.renderCameras();
    assert.deepEqual({ ...state.camCounts }, { gulfcoast: 2, southtx: 0, centraltx: 1, northtx: 0, easttx: 0,
      westtx: 1, panhandle: 0, other: 1 });
    assert.equal(got.other.length, 1, 'the Ruidoso camera is drawn on the Neighboring states layer');
  } finally {
    CONFIG.aoPresets = savedPresets;
    Object.assign(state, saved);
    sb.layerSheetSync = savedSync;
  }
});

test('the camera sheet offers the seven regions and one Neighboring states row, in that order', () => {
  const mapApp = loadMapApp();
  const s = mapApp.state;
  const saved = { presets: mapApp.CONFIG.aoPresets, map: s.map, layers: s.layers, counts: s.camCounts };
  mapApp.CONFIG.aoPresets = EVENT.aoPresets;
  mapApp.initCamRegionRows();
  s.layers = {};
  for (const r of mapApp.CAM_ROWS) s.layers[r[0]] = r[0];
  s.map = { hasLayer: () => false };
  s.camCounts = null; // before the inventory lands every row shows
  try {
    const html = mapApp.camRowsHtml(mapApp.CAM_ROWS, '');
    const keys = [...html.matchAll(/data-layer="(camsR_[a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(keys, IDS.concat(['other']).map((id) => `camsR_${id}`));
    assert.ok(!/ls-subhead|data-camband/.test(html), 'no band headers: the eight rows are the whole list');
    assert.equal(mapApp.pillLabel('camsR_other', null), '📷 cams.region.other',
      'the Neighboring states pill is named, never a bare layer key');
  } finally {
    mapApp.CONFIG.aoPresets = saved.presets;
    s.map = saved.map; s.layers = saved.layers; s.camCounts = saved.counts;
  }
});

test('the residual reads Neighboring states in both languages', () => {
  assert.equal(I18N.en['cams.region.other'], 'Neighboring states');
  assert.equal(I18N.es['cams.region.other'], 'Estados vecinos');
  assert.equal(I18N.en['ao.full'], 'All Texas');
  assert.equal(I18N.es['ao.full'], 'Todo Texas');
});
