'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

const app = loadApp();
const { buildShareUrl, applyShareParams, state } = app;
const sb = app._sandbox;

/* buildShareUrl/applyShareParams read the DOM through $()/document at call time, so this
   file swaps the harness's throwaway document for one with PERSISTENT per-selector elements
   (a value set by applyShareParams must still be there when the test reads it back).
   node --test runs each file in its own process, so the swap cannot leak into other suites. */

function ctl(tagName) {
  return {
    tagName,
    value: '',
    options: [],
    dataset: {},
    hidden: true,
    events: [],
    add(opt) { this.options.push(opt); },
    dispatchEvent(e) { this.events.push(e.type); return true; },
    addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  };
}

function makeDom(activeTab) {
  const els = {
    '#flt-type': ctl('SELECT'),
    '#flt-county': ctl('SELECT'),
    '#flt-window': ctl('SELECT'),
    '#flt-dist': ctl('SELECT'),
    '#flt-q': ctl('INPUT'),
    '#flt-sort': ctl('SELECT'),
    '#flt-alert-sev': ctl('SELECT'),
    '#flt-alert-q': ctl('INPUT'),
    '#req-filters': ctl('DIV'),
    '#recovery-view': ctl('DIV'),
    '#basin-view': ctl('DIV'),
    '.tabs button.active': { dataset: { tab: activeTab } },
  };
  return {
    els,
    title: '',
    querySelector(sel) { return els[sel] || null; },
    querySelectorAll() { return []; },
    createElement() { return ctl('DIV'); },
    getElementById(id) { return els[`#${id}`] || null; },
    addEventListener() {},
    documentElement: {
      attrs: { 'data-theme': 'dark' },
      getAttribute(k) { return this.attrs[k]; },
      setAttribute(k, v) { this.attrs[k] = v; },
      style: {},
    },
    body: ctl('BODY'),
  };
}

function fakeMap(center, zoom, onLayers) {
  return {
    setViewCalls: [],
    getCenter() { return { lat: center[0], lng: center[1] }; },
    getZoom() { return zoom; },
    hasLayer(l) { return onLayers.has(l); },
    setView(latlng, z) { this.setViewCalls.push([latlng, z]); },
  };
}

// seed a full non-default view; returns the DOM so tests can inspect it
function seedState() {
  const dom = makeDom('tab-gauges');
  dom.els['#flt-alert-sev'].value = 'warning';
  dom.els['#flt-alert-q'].value = 'guadalupe';
  sb.document = dom;
  state.layers = { mrms: { id: 'mrms' }, radar: { id: 'radar' }, usgs: { id: 'usgs' }, camsRiver: { id: 'camr' } };
  state.map = fakeMap([29.4832, -95.1123], 9, new Set([state.layers.mrms, state.layers.radar, state.layers.usgs]));
  state.filters = { type: 'rescue', county: 'Kerr', q: 'R-031', window: '360', dist: '25' };
  state.sort = 'age';
  state.rainWindow = '24h';
  state.activeBase = 'Dark';
  return dom;
}

test('buildShareUrl — every non-default facet lands in the query, enumerated from the code', () => {
  seedState();
  const url = buildShareUrl();
  assert.ok(url.startsWith('https://example.test/?'), url);
  const q = new URLSearchParams(url.split('?')[1]);
  assert.equal(q.get('mlat'), '29.4832');
  assert.equal(q.get('mlon'), '-95.1123');
  assert.equal(q.get('mz'), '9');
  assert.equal(q.get('tab'), 'gauges');
  assert.equal(q.get('ft'), 'rescue');
  assert.equal(q.get('fc'), 'Kerr');
  assert.equal(q.get('fw'), '360');
  assert.equal(q.get('fd'), '25');
  assert.equal(q.get('fq'), 'R-031');
  assert.equal(q.get('fs'), 'age');
  assert.equal(q.get('as'), 'warning');
  assert.equal(q.get('aq'), 'guadalupe');
  assert.equal(q.get('rain'), '24h'); // rainfall window travels only while MRMS is on
  assert.equal(q.get('radar'), '1');
  assert.equal(q.get('usgs'), '1');
  assert.equal(q.get('camr'), null); // layer exists but is OFF: no param
  assert.equal(q.get('base'), 'Dark');
  assert.equal(q.get('theme'), 'dark');
});

test('buildShareUrl — a default view stays short (no tab/filter/sort/layer params)', () => {
  const dom = seedState();
  dom.els['.tabs button.active'].dataset.tab = 'tab-requests';
  dom.els['#flt-alert-sev'].value = '';
  dom.els['#flt-alert-q'].value = '';
  state.filters = { type: '', county: '', q: '', window: '', dist: '' };
  state.sort = 'smart';
  state.map = fakeMap([29.5, -95.1], 8, new Set());
  const q = new URLSearchParams(buildShareUrl().split('?')[1]);
  for (const k of ['tab', 'ft', 'fc', 'fw', 'fd', 'fq', 'fs', 'as', 'aq', 'rain', 'radar', 'usgs', 'camr', 'view', 'river']) {
    assert.equal(q.get(k), null, `unexpected param ${k}`);
  }
  assert.equal(q.get('mlat'), '29.5000');
  assert.equal(q.get('base'), 'Dark');
});

test('share round-trip — applyShareParams restores every field buildShareUrl encoded for it', () => {
  seedState();
  const q = new URLSearchParams(buildShareUrl().split('?')[1]);

  // fresh boot: blank controls, blank map
  const dom2 = makeDom('tab-requests');
  sb.document = dom2;
  state.map = fakeMap([31.0, -100.0], 6, new Set());
  applyShareParams(q);

  // JSON-flatten: setView args are arrays born in the vm realm (different Array prototype)
  assert.deepEqual(JSON.parse(JSON.stringify(state.map.setViewCalls)), [[[29.4832, -95.1123], 9]]);
  assert.equal(dom2.els['#flt-type'].value, 'rescue');
  assert.equal(dom2.els['#flt-county'].value, 'Kerr');
  assert.equal(dom2.els['#flt-window'].value, '360');
  assert.equal(dom2.els['#flt-dist'].value, '25');
  assert.equal(dom2.els['#flt-q'].value, 'R-031');
  assert.equal(dom2.els['#flt-sort'].value, 'age');
  assert.equal(dom2.els['#flt-alert-sev'].value, 'warning');
  assert.equal(dom2.els['#flt-alert-q'].value, 'guadalupe');
  // a missing SELECT option is added before setting (county list is rebuilt after boot)
  assert.ok(dom2.els['#flt-county'].options.some((o) => o.value === 'Kerr'), 'county Option was not added');
  // each control fired its own handler event so the real render path would run
  assert.ok(dom2.els['#flt-type'].events.includes('change'));
  assert.ok(dom2.els['#flt-q'].events.includes('input'));
  // a shared filtered view must be visible, not silent
  assert.equal(dom2.els['#req-filters'].hidden, false);
});

test('applyShareParams — empty query is a no-op: no setView, controls untouched, filters stay hidden', () => {
  const dom = makeDom('tab-requests');
  sb.document = dom;
  state.map = fakeMap([31.0, -100.0], 6, new Set());
  applyShareParams(new URLSearchParams(''));
  assert.deepEqual(state.map.setViewCalls, []);
  assert.equal(dom.els['#flt-type'].value, '');
  assert.equal(dom.els['#flt-type'].events.length, 0);
  assert.equal(dom.els['#req-filters'].hidden, true);
});

test('applyShareParams — mlat without a valid zoom still restores center at the current zoom', () => {
  const dom = makeDom('tab-requests');
  sb.document = dom;
  state.map = fakeMap([31.0, -100.0], 6, new Set());
  applyShareParams(new URLSearchParams('mlat=29.9&mlon=-97.9'));
  assert.deepEqual(JSON.parse(JSON.stringify(state.map.setViewCalls)), [[[29.9, -97.9], 6]]);
});


test('buildShareUrl — an open recovery view travels as view=recovery; closed emits nothing', () => {
  const dom = seedState();
  dom.els['#recovery-view'].hidden = false;
  assert.equal(new URLSearchParams(buildShareUrl().split('?')[1]).get('view'), 'recovery');
  dom.els['#recovery-view'].hidden = true;
  assert.equal(new URLSearchParams(buildShareUrl().split('?')[1]).get('view'), null);
});

test('buildShareUrl — an open basin view travels as view=basin plus its river slug', () => {
  const dom = seedState();
  dom.els['#basin-view'].hidden = false;
  state.basinRiver = 'sabine-river';
  let q = new URLSearchParams(buildShareUrl().split('?')[1]);
  assert.equal(q.get('view'), 'basin');
  assert.equal(q.get('river'), 'sabine-river');
  // no river selected yet: the view still travels, the river param stays off
  state.basinRiver = null;
  q = new URLSearchParams(buildShareUrl().split('?')[1]);
  assert.equal(q.get('view'), 'basin');
  assert.equal(q.get('river'), null);
  // closed: neither param
  dom.els['#basin-view'].hidden = true;
  q = new URLSearchParams(buildShareUrl().split('?')[1]);
  assert.equal(q.get('view'), null);
  assert.equal(q.get('river'), null);
});

test('share round-trip — applyShareParams reopens the basin view with the shared river', () => {
  const dom = seedState();
  dom.els['#basin-view'].hidden = false;
  state.basinRiver = 'sabine-river';
  const q = new URLSearchParams(buildShareUrl().split('?')[1]);
  sb.document = makeDom('tab-requests');
  state.map = fakeMap([31.0, -100.0], 6, new Set());
  const opened = [];
  sb.openBasinView = (slug) => { opened.push(slug); };
  applyShareParams(q);
  assert.deepEqual(opened, ['sabine-river']);
  // a crafted slug fails the allowlist and opens the default (most active) river instead
  applyShareParams(new URLSearchParams('view=basin&river=%22%3E%3Cscript%3E'));
  assert.deepEqual(opened, ['sabine-river', null]);
  // and a URL without view=basin never opens it
  applyShareParams(new URLSearchParams('mlat=29.9&mlon=-97.9'));
  assert.equal(opened.length, 2);
  delete sb.openBasinView;
  state.basinRiver = null;
});

test('share round-trip — applyShareParams reopens the recovery view from view=recovery', () => {
  const dom = seedState();
  dom.els['#recovery-view'].hidden = false;
  const q = new URLSearchParams(buildShareUrl().split('?')[1]);
  sb.document = makeDom('tab-requests');
  state.map = fakeMap([31.0, -100.0], 6, new Set());
  let opened = 0;
  sb.openRecoveryView = () => { opened += 1; };
  applyShareParams(q);
  assert.equal(opened, 1);
  // and a URL without the param never opens it
  applyShareParams(new URLSearchParams('mlat=29.9&mlon=-97.9'));
  assert.equal(opened, 1);
  delete sb.openRecoveryView;
});
