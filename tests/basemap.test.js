'use strict';

/* The basemap every hazard layer is read against. CARTO went key-only and every one of its tiles
   became an "API KEY REQUIRED" watermark, so these run the shipped initMap() and offline-save path
   and check what the map would actually fetch, never the text of js/map.js. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadWiredMap } = require('./harness.js');

const CANVAS = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
const canvasUrl = (svc) => `${CANVAS}/${svc}/MapServer/tile/{z}/{y}/{x}`;
const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const CARTO = 'https://{s}.basemaps.cartocdn.com/';

function tileLayers(w) {
  const out = Object.entries(w.state.baseLayers).map(([k, l]) => [`base.${k}`, l]);
  for (const [k, l] of Object.entries(w.layers)) if (l && typeof l._url === 'string') out.push([k, l]);
  return out;
}

// a tile store that answers like IndexedDB, key ranges included; `failRange` breaks only range reads
function fakeIdb(seed = {}, { failRange = false } = {}) {
  const rows = new Map(Object.entries(seed));
  const isRange = (k) => k !== null && typeof k === 'object';
  const matches = (key, q) => (isRange(q) ? key >= q.lo && key <= q.hi : key === q);
  const req = (run) => {
    const r = {};
    queueMicrotask(() => {
      try { r.result = run(); if (r.onsuccess) r.onsuccess(); } catch (e) { r.error = e; if (r.onerror) r.onerror(); }
    });
    return r;
  };
  const guard = (q) => { if (failRange && isRange(q)) throw new Error('range read failed'); };
  const store = {
    get: (k) => req(() => rows.get(k)),
    count: (q) => req(() => { guard(q); return q === undefined ? rows.size : [...rows.keys()].filter((k) => matches(k, q)).length; }),
    put: (v, k) => req(() => { rows.set(k, v); }),
    delete: (q) => req(() => { guard(q); for (const k of [...rows.keys()]) if (matches(k, q)) rows.delete(k); }),
    clear: () => req(() => rows.clear()),
  };
  const db = { objectStoreNames: { contains: () => true }, transaction: () => ({ objectStore: () => store }) };
  return {
    rows,
    indexedDB: { open: () => { const rq = { result: db }; queueMicrotask(() => { if (rq.onsuccess) rq.onsuccess(); }); return rq; } },
    IDBKeyRange: { bound: (lo, hi) => ({ lo, hi }) },
  };
}

function withStore(w, idb) {
  w.sandbox.indexedDB = idb.indexedDB;
  w.sandbox.IDBKeyRange = idb.IDBKeyRange;
  const status = { textContent: '', classList: { add() {}, remove() {}, toggle() {} }, hidden: false, disabled: false };
  const raw = w.sandbox.document.querySelector.bind(w.sandbox.document);
  w.sandbox.document.querySelector = (sel) => (sel === '#off-status' ? status : raw(sel));
  return status;
}

test('the dark and light basemaps are keyless Esri Canvas tiles, and no layer still reaches CARTO', () => {
  const w = loadWiredMap();
  const { dark, light, streets } = w.state.baseLayers;
  assert.equal(dark._url, canvasUrl('World_Dark_Gray_Base'));
  assert.equal(light._url, canvasUrl('World_Light_Gray_Base'));
  assert.equal(streets._url, OSM, 'Streets keeps OpenStreetMap');

  const layers = tileLayers(w);
  assert.ok(layers.length >= 4, `initMap() built only ${layers.length} tile layers; the check below would prove nothing`);
  for (const [name, l] of layers) {
    assert.ok(!/carto/i.test(l._url), `${name} still fetches ${l._url}`);
    assert.ok(!/carto/i.test(l.options.attribution || ''), `${name} still credits CARTO`);
  }
});

test('Canvas layers stop at the zoom Canvas really serves, still zoom to street level, and credit Esri', () => {
  const w = loadWiredMap();
  const canvas = [['dark', w.state.baseLayers.dark], ['light', w.state.baseLayers.light], ['labelBoost', w.layers.labelBoost]];
  for (const [name, l] of canvas) {
    assert.equal(l.options.maxNativeZoom, 16, `${name}: past z16 Canvas answers with a "Map data not yet available" tile`);
    assert.equal(l.options.maxZoom, name === 'labelBoost' ? 16 : 19, name === 'labelBoost'
      ? 'an upscaled place name balloons over the street labels, so the boost stops where its tiles do'
      : `${name}: the map must still zoom in past the native tiles`);
    assert.match(l.options.attribution, /Esri/, `${name} must credit the operator`);
    assert.match(l.options.attribution, /OpenStreetMap/, `${name}: Canvas is built on OSM data and credits it`);
    assert.ok(!l.options.attribution.includes('—'), `${name} attribution uses an em-dash`);
  }
});

test('the label boost follows the surface under it', () => {
  const w = loadWiredMap();
  const lb = w.layers.labelBoost;
  const pane = w.map.getPane('labels');
  assert.equal(w.map.hasLayer(lb), true, 'the label boost ships on');
  assert.equal(lb.options.pane, 'labels', 'the boost must sit in its own pane above radar and alert washes');

  w.fire('baselayerchange', { layer: w.state.baseLayers.dark });
  assert.equal(lb._url, canvasUrl('World_Dark_Gray_Reference'), 'the dark base needs light-on-dark labels');
  assert.equal(pane.classList.contains('boost-dark'), true);

  w.fire('baselayerchange', { layer: w.state.baseLayers.light });
  assert.equal(lb._url, canvasUrl('World_Light_Gray_Reference'));
  assert.equal(pane.classList.contains('boost-dark'), false);

  w.fire('baselayerchange', { layer: w.state.baseLayers.dark });
  w.fire('baselayerchange', { layer: w.state.baseLayers.streets });
  assert.equal(lb._url, canvasUrl('World_Light_Gray_Reference'), 'Streets is a light surface whatever the theme');
});

// runs the shipped save at depth 2 on a fresh map showing `base` at zoom `z`; one tile per zoom, x=3 y=5
async function saveAt(base, z) {
  const w = loadWiredMap();
  for (const l of Object.values(w.state.baseLayers)) w.map.removeLayer(l);
  w.state.baseLayers[base].addTo(w.map);
  w.map.getZoom = () => z;
  w.map.project = () => ({ divideBy: () => ({ floor: () => ({ x: 3, y: 5 }) }) });
  w.state.offDepth = 2;
  const idb = fakeIdb();
  const status = withStore(w, idb);
  const fetched = [];
  w.sandbox.fetch = async (u) => { fetched.push(u); return { ok: true, blob: async () => 'tile' }; };
  await w.sandbox.saveViewportOffline();
  return { fetched: fetched.sort(), keys: [...idb.rows.keys()].sort(), status: status.textContent };
}

test('an offline save past z16 stores the z16 tiles a Canvas layer draws, never the placeholders above it', async () => {
  const at17 = await saveAt('dark', 17);
  assert.deepEqual(at17.fetched, [`${CANVAS}/World_Dark_Gray_Base/MapServer/tile/16/5/3`],
    'z17 to z19 all draw from one z16 tile, fetched z/y/x; the label boost is not drawn there at all');
  assert.deepEqual(at17.keys, [`${canvasUrl('World_Dark_Gray_Base')}|16/3/5`],
    'stored under the key the layer reads back when it draws z17 to z19');
  assert.match(at17.status, /off\.savedfull/);

  const at15 = await saveAt('light', 15);
  assert.deepEqual(at15.fetched, [
    `${CANVAS}/World_Light_Gray_Base/MapServer/tile/15/5/3`, `${CANVAS}/World_Light_Gray_Base/MapServer/tile/16/5/3`,
    `${CANVAS}/World_Light_Gray_Reference/MapServer/tile/15/5/3`, `${CANVAS}/World_Light_Gray_Reference/MapServer/tile/16/5/3`,
  ]);
});

test('a label cap at z16 does not shrink what an offline save keeps of a base that goes deeper', async () => {
  const { fetched } = await saveAt('streets', 15);
  assert.deepEqual(fetched.filter((u) => u.startsWith('https://tile.openstreetmap.org/')), [
    'https://tile.openstreetmap.org/15/3/5.png', 'https://tile.openstreetmap.org/16/3/5.png', 'https://tile.openstreetmap.org/17/3/5.png',
  ], 'Streets draws native tiles at z17, so a save from z15 at depth 2 must keep them');
  assert.deepEqual(fetched.filter((u) => u.startsWith(CANVAS)), [
    `${CANVAS}/World_Light_Gray_Reference/MapServer/tile/15/5/3`, `${CANVAS}/World_Light_Gray_Reference/MapServer/tile/16/5/3`,
  ]);
});

test('tiles saved under the retired CARTO templates are dropped, and the drop is not reported as an eviction', async () => {
  const w = loadWiredMap();
  const idb = fakeIdb({
    [`${CARTO}dark_all/{z}/{x}/{y}{r}.png|9/1/2`]: 'unreachable',
    [`${CARTO}light_only_labels/{z}/{x}/{y}{r}.png|9/1/2`]: 'unreachable',
    [`${CARTO}light_only_labels/{z}/{x}/{y}{r}.png|10/2/4`]: 'unreachable',
    [`${OSM}|9/1/2`]: 'kept',
    [`${OSM}|10/2/4`]: 'kept',
  });
  const status = withStore(w, idb);
  w.sandbox.setOfflineLedger(5); // the last save counted the CARTO tiles too

  assert.equal(await w.sandbox.refreshOfflineStatus(), 2);
  assert.deepEqual([...idb.rows.keys()].sort(), [`${OSM}|10/2/4`, `${OSM}|9/1/2`], 'only tiles a layer can read back survive');
  assert.equal(w.sandbox.offlineLedger().n, 2, 'the ledger comes down with the purge');
  assert.match(status.textContent, /off\.saved/);
  assert.ok(!/off\.evicted/.test(status.textContent), 'the panel blamed the browser for tiles the app dropped');
});

test('a real eviction alongside the purge is still reported', async () => {
  const w = loadWiredMap();
  const idb = fakeIdb({ [`${CARTO}dark_all/{z}/{x}/{y}{r}.png|9/1/2`]: 'unreachable', [`${OSM}|9/1/2`]: 'kept' });
  const status = withStore(w, idb);
  w.sandbox.setOfflineLedger(3); // one OSM tile has gone missing since the save, beyond the CARTO one

  assert.equal(await w.sandbox.refreshOfflineStatus(), 1);
  assert.equal(w.sandbox.offlineLedger().n, 2, 'the purge subtracts what it removed; it must not reset the ledger');
  assert.match(status.textContent, /off\.evicted/);
});

test('a store that cannot run the cleanup still serves the basemap', async () => {
  const w = loadWiredMap();
  const idb = fakeIdb({ [`${CARTO}dark_all/{z}/{x}/{y}{r}.png|9/1/2`]: 'unreachable', [`${OSM}|9/1/2`]: 'kept' },
    { failRange: true });
  withStore(w, idb);

  assert.equal(await w.sandbox.refreshOfflineStatus(), 2, 'every tile waits on this handle, so the cleanup must not wedge it');
});
