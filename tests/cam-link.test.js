'use strict';

/* Shareable camera links: the viewer's Copy link hands out the board's own view link plus
   ?cam=<net>.<token>, and opening that link restores the view, then opens the camera once.
   Every path here runs the shipped functions against a recording DOM; nothing reads source text. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadFullApp } = require('./harness.js');

const app = loadFullApp();
const sb = app._sandbox;
const { state, CONFIG, CAM_NETS, camRegionKey, camRegionsAll } = app;

const REGIONS = [
  { id: 'houston', label: 'Houston', anchors: [[29.76, -95.37]] },
  { id: 'dfw', label: 'DFW', anchors: [[32.78, -96.80]] },
  { id: 'austin', label: 'Austin', anchors: [[30.27, -97.74]] },
];

// Austin and Houston both publish a camera "102": the bare id cannot say which one a link meant
const CAMS = {
  river: [{ camId: 'TX_Guadalupe_at_Kerrville', name: 'Guadalupe River at Kerrville', nwisId: '08166200', lat: 30.05, lon: -99.14 }],
  txdot: [
    { name: 'HOU-IH45 @ Main St.', route: 'IH45', lat: 29.75, lon: -95.36, httpsurl: 'https://s1.example.test/live.m3u8' },
    { name: 'ABL-IH20 @ BI20 (Traffic Signal)', route: 'IH20', lat: 32.4, lon: -99.7, src: 'its', dist: 'ABL', icd: '123' },
  ],
  austin: [{ id: '102', name: 'LAMAR BLVD / 5TH ST', lat: 30.27, lon: -97.75 }],
  houston: [{ id: '102', name: '45 Gulf @ West Dallas', lat: 29.76, lon: -95.37 }],
  atxfloods: [{ id: 22, name: 'Cuernavaca Creek @ River Hills Rd.', lat: 30.3, lon: -97.9 }],
  elpbridge: [{ name: 'Paso del Norte Bridge (Santa Fe St.)', lat: 31.75, lon: -106.48, httpsurl: 'https://cams.example.test/elp.m3u8' }],
};
const HOUSTON_102 = CAMS.houston[0];

// a plain-text button: the DOM keeps textContent and innerHTML in step, and the copy confirmation restores via innerHTML
function textLinked(n, text) {
  let v = text;
  for (const k of ['textContent', 'innerHTML']) Object.defineProperty(n, k, { get: () => v, set: (x) => { v = String(x); }, configurable: true });
  return n;
}

function node(tag, extra) {
  const listeners = [];
  return Object.assign({
    tagName: tag, hidden: false, value: '', textContent: '', innerHTML: '', title: '', alt: '', src: '',
    dataset: {}, options: [], children: [], listeners, events: [],
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    add(opt) { this.options.push(opt); },
    addEventListener(type, fn, opts) { listeners.push({ type, fn, once: !!(opts && opts.once) }); },
    removeEventListener() {},
    dispatchEvent(e) { this.events.push(e.type); return true; },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
    focus() {},
  }, extra);
}

// only the selectors the shipped code is meant to reach answer; anything else is null and fails loudly
function makeDom({ gateUp = false, tab = 'tab-gauges' } = {}) {
  const refresh = node('BUTTON');
  const els = {
    '#flt-type': node('SELECT'), '#flt-county': node('SELECT'), '#flt-window': node('SELECT'),
    '#flt-dist': node('SELECT'), '#flt-q': node('INPUT'), '#flt-sort': node('SELECT'),
    '#flt-alert-sev': node('SELECT'), '#flt-alert-q': node('INPUT'),
    '#req-filters': node('DIV', { hidden: true }),
    '#summary-view': node('DIV', { hidden: true }),
    '#recovery-view': node('DIV', { hidden: true }),
    '#basin-view': node('DIV', { hidden: true }),
    '.tabs button.active': node('BUTTON', { dataset: { tab } }),
    '#cam-viewer': node('DIV', { hidden: true }),
    '#cam-title': node('STRONG'),
    '#cam-stage': node('DIV'),
    '#cam-meta': node('DIV', { querySelector: (sel) => (sel === '.cam-refresh' ? refresh : null) }),
    '#cam-note': node('DIV'),
    '#cam-link': textLinked(node('BUTTON'), '🔗 Copy link'),
    '#safety-modal': node('DIV', { hidden: !gateUp }),
    '#safety-ack': node('BUTTON'),
    '#op-toast': node('DIV', { hidden: true }),
    '#op-toast-text': node('SPAN'),
  };
  return {
    els,
    title: '',
    querySelector: (sel) => (Object.prototype.hasOwnProperty.call(els, sel) ? els[sel] : null),
    querySelectorAll: () => [],
    createElement: (tag) => node(String(tag).toUpperCase()),
    getElementById: (id) => els[`#${id}`] || null,
    addEventListener() {},
    documentElement: { getAttribute: (k) => (k === 'data-theme' ? 'dark' : null), setAttribute() {}, style: {} },
    body: node('BODY'),
  };
}

function fakeMap(center, zoom, on) {
  return {
    views: [],
    getCenter: () => ({ lat: center[0], lng: center[1] }),
    getZoom: () => zoom,
    hasLayer: (l) => on.has(l),
    setView(c, z) { this.views.push([c[0], c[1], z]); return this; },
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body });

/* One harness per test: the cached bundle is shared, so every global this swaps is put back.
   fetch answers the inventory from a deferred the test settles, and records every camera image request. */
function rig(opts = {}) {
  const saved = {
    document: sb.document, fetch: sb.fetch, setTimeout: sb.setTimeout, navigator: sb.navigator,
    isSecureContext: sb.isSecureContext, openCamViewer: sb.openCamViewer, aoPresets: CONFIG.aoPresets,
    state: { ...state },
  };
  const dom = makeDom(opts);
  sb.document = dom;
  CONFIG.aoPresets = REGIONS;
  const inventory = deferred();
  const fetches = [];
  sb.fetch = (url, init) => {
    fetches.push(String(url));
    if (String(url).startsWith('data/cameras.json')) return inventory.promise;
    return opts.imageFetch ? opts.imageFetch(url, init) : new Promise(() => {}); // image still pending: "loading"
  };
  const timers = [];
  sb.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const opened = [];
  const realOpen = saved.openCamViewer;
  sb.openCamViewer = (c, kind) => { opened.push({ c, kind }); return realOpen(c, kind); };
  const layers = {};
  for (const r of camRegionsAll()) layers[camRegionKey(r.id)] = { id: r.id };
  Object.assign(state, {
    cameras: null, camerasP: null, pendingCam: null, camOpen: null, camGen: 0, camLayerList: null,
    layers, map: fakeMap([29.4832, -95.1123], 11, new Set([layers[camRegionKey('austin')]])),
    filters: { type: 'rescue', county: 'Harris', q: 'R-031', window: '360', dist: '25' },
    sort: 'age', rainWindow: '1h', activeBase: 'Dark', basinRiver: null,
  });
  const restore = () => {
    sb.document = saved.document; sb.fetch = saved.fetch; sb.setTimeout = saved.setTimeout;
    sb.navigator = saved.navigator; sb.isSecureContext = saved.isSecureContext;
    sb.openCamViewer = saved.openCamViewer; CONFIG.aoPresets = saved.aoPresets;
    for (const k of Object.keys(state)) if (!(k in saved.state)) delete state[k];
    Object.assign(state, saved.state);
  };
  return { dom, els: dom.els, inventory, fetches, timers, opened, layers, restore };
}

const settle = () => new Promise((r) => setImmediate(r));
const query = (url) => new URLSearchParams(new URL(url).search);

test('the link key names the network, so a bare id shared by two networks still finds one camera', () => {
  const r = rig();
  try {
    state.cameras = CAMS;
    assert.equal(sb.camLinkKey(HOUSTON_102, 'houston'), 'houston.102');
    assert.equal(sb.findCamByKey('houston.102').c, HOUSTON_102);
    assert.equal(sb.findCamByKey('austin.102').c, CAMS.austin[0]);
    // the legacy bare form still resolves, by the frozen precedence, which is why links now qualify it
    assert.equal(sb.findCamByKey('102').kind, 'austin');
    // every network round-trips: river by camId, id-less TxDOT / El Paso by name, the rest by id
    let n = 0;
    for (const [arr] of CAM_NETS) {
      for (const c of CAMS[arr] || []) {
        const hit = sb.findCamByKey(sb.camLinkKey(c, arr));
        assert.ok(hit, `${arr} camera did not resolve from its own key`);
        assert.equal(hit.c, c);
        assert.equal(hit.kind, arr);
        n += 1;
      }
    }
    assert.equal(n, 7);
    // links shared before the key existed keep opening the same camera
    assert.equal(sb.findCamByKey('TX_Guadalupe_at_Kerrville').c, CAMS.river[0]);
    assert.equal(sb.findCamByKey('HOU-IH45 @ Main St.').c, CAMS.txdot[0]);
    for (const junk of ['houston.999', 'nowhere.102', 'constructor.x', '__proto__.y', 'river.', '']) {
      assert.equal(sb.findCamByKey(junk), null, `${junk} must not resolve to anything`);
    }
  } finally { r.restore(); }
});

test('the camera link carries the camera, the view, the filters and the layers the view link already keeps', () => {
  const r = rig();
  try {
    r.els['#flt-alert-sev'].value = 'warning';
    r.els['#flt-alert-q'].value = 'guadalupe';
    r.els['#summary-view'].hidden = false;
    const q = query(sb.buildShareUrl({ cam: { c: HOUSTON_102, kind: 'houston' } }));
    assert.equal(q.get('cam'), 'houston.102');
    assert.equal(q.get('mlat'), '29.4832');
    assert.equal(q.get('mlon'), '-95.1123');
    assert.equal(q.get('mz'), '11');
    assert.equal(q.get('tab'), 'gauges');
    assert.equal(q.get('view'), 'summary', 'the open lens travels with the camera');
    assert.equal(q.get('ft'), 'rescue');
    assert.equal(q.get('fc'), 'Harris');
    assert.equal(q.get('fq'), 'R-031');
    assert.equal(q.get('fw'), '360');
    assert.equal(q.get('fd'), '25');
    assert.equal(q.get('fs'), 'age');
    assert.equal(q.get('as'), 'warning');
    assert.equal(q.get('aq'), 'guadalupe');
    assert.equal(q.get('base'), 'Dark');
    assert.equal(q.get('theme'), 'dark');
    // the region that was on stays on, and the camera's own region joins it so its marker is there to return to
    assert.equal(q.get('camreg'), 'houston,austin');
    // the map's own share link is unchanged: no camera unless one is passed
    const plain = query(sb.buildShareUrl());
    assert.equal(plain.get('cam'), null);
    assert.equal(plain.get('camreg'), 'austin');
  } finally { r.restore(); }
});

test('a camera name ending in a period is never the last thing in the link, where chat apps trim it', () => {
  const r = rig();
  try {
    const url = sb.buildShareUrl({ cam: { c: CAMS.txdot[0], kind: 'txdot' } });
    const keys = [...query(url).keys()];
    assert.notEqual(keys[keys.length - 1], 'cam');
    assert.equal(query(url).get('cam'), 'txdot.HOU-IH45 @ Main St.');
  } finally { r.restore(); }
});

test('opening the link restores the shared view and then opens that camera, once, when the inventory lands', async () => {
  const r = rig();
  try {
    r.els['#summary-view'].hidden = false;
    const q = query(sb.buildShareUrl({ cam: { c: HOUSTON_102, kind: 'houston' } }));
    // a fresh board on another device
    const fresh = makeDom({ tab: 'tab-requests' });
    sb.document = fresh;
    state.map = fakeMap([31, -100], 6, new Set());
    const summaries = [];
    const savedSummary = sb.openCrestSummary;
    sb.openCrestSummary = () => { summaries.push(1); };
    try { sb.applyShareParams(q); } finally { sb.openCrestSummary = savedSummary; }
    assert.deepEqual(state.map.views, [[29.4832, -95.1123, 11]]);
    assert.equal(fresh.els['#flt-type'].value, 'rescue');
    assert.equal(fresh.els['#flt-q'].value, 'R-031');
    assert.equal(summaries.length, 1, 'the shared lens reopens');

    sb.openCamLink(q);
    assert.equal(state.pendingCam, 'houston.102', 'the URL parks the camera until the inventory is in');
    assert.ok(r.fetches.some((u) => u.startsWith('data/cameras.json')), 'the link fetches the inventory itself');
    assert.equal(fresh.els['#cam-viewer'].hidden, true, 'nothing opens before the camera is known');

    r.inventory.resolve(jsonRes(CAMS));
    await settle();
    assert.equal(r.opened.length, 1);
    assert.equal(r.opened[0].c, HOUSTON_102);
    assert.equal(r.opened[0].kind, 'houston');
    assert.equal(state.pendingCam, null);
    assert.equal(fresh.els['#cam-viewer'].hidden, false, 'the viewer pops');
    assert.ok(fresh.els['#cam-title'].textContent.includes('45 Gulf @ West Dallas'));
    assert.ok(r.fetches.includes('api/cam/houston/102'), 'and the still starts loading as if tapped');
    assert.ok(fresh.els['#cam-stage'].innerHTML.includes('cam.loading'));

    // a later inventory consumer must not reopen it
    sb.openPendingCam();
    await sb.loadCameras().then(sb.openPendingCam);
    assert.equal(r.opened.length, 1, 'the linked camera opens exactly once');
  } finally { r.restore(); }
});

test('an inventory already loaded before the URL is read still opens the camera, once', async () => {
  const r = rig();
  try {
    r.inventory.resolve(jsonRes(CAMS));
    await sb.loadCameras(); // a saved camera layer started the fetch before boot read ?cam=
    assert.ok(state.cameras);
    sb.openCamLink(new URLSearchParams('cam=austin.102'));
    await settle();
    assert.equal(r.opened.length, 1);
    assert.equal(r.opened[0].c, CAMS.austin[0]);
    assert.equal(r.fetches.filter((u) => u.startsWith('data/cameras.json')).length, 1, 'one inventory fetch, shared');
  } finally { r.restore(); }
});

test('a shared camera that no longer exists opens the view with a notice and never a blank viewer', async () => {
  const r = rig();
  try {
    sb.openCamLink(new URLSearchParams('mlat=29.7&mlon=-95.4&mz=12&cam=houston.4040'));
    r.inventory.resolve(jsonRes(CAMS));
    await settle();
    assert.equal(r.opened.length, 0);
    assert.equal(r.els['#cam-viewer'].hidden, true);
    assert.equal(r.els['#op-toast'].hidden, false, 'the notice shows');
    assert.equal(r.els['#op-toast-text'].textContent, 'note.camgone');
    assert.equal(state.pendingCam, null);
  } finally { r.restore(); }
});

test('an inventory that fails to load says so and leaves nothing pending to pop up later', async () => {
  const r = rig();
  try {
    sb.openCamLink(new URLSearchParams('cam=houston.102'));
    r.inventory.reject(new Error('offline'));
    await settle();
    assert.equal(r.opened.length, 0);
    assert.equal(r.els['#op-toast-text'].textContent, 'note.camfail');
    assert.equal(state.pendingCam, null, 'a later layer toggle must not surprise-open the camera');
  } finally { r.restore(); }
});

test('the 911 gate comes first: a linked camera waits for the acknowledgment, then opens once', async () => {
  const r = rig({ gateUp: true });
  try {
    sb.openCamLink(new URLSearchParams('cam=houston.102'));
    r.inventory.resolve(jsonRes(CAMS));
    await settle();
    assert.equal(r.opened.length, 0, 'the viewer would stack over #safety-modal');
    assert.equal(r.els['#cam-viewer'].hidden, true);
    const acks = r.els['#safety-ack'].listeners.filter((l) => l.type === 'click');
    assert.equal(acks.length, 1);
    assert.equal(acks[0].once, true, 'a later re-read of the notice must not reopen the camera');
    r.els['#safety-modal'].hidden = true; // boot's own ack handler closes the gate
    acks[0].fn();
    assert.equal(r.opened.length, 1);
    assert.equal(r.els['#cam-viewer'].hidden, false);
  } finally { r.restore(); }
});

test('a still opened from a link keeps the aging gate: an old capture reads STALE, not current', async () => {
  const captured = new Date(Date.now() - 2 * 3600 * 1000).toUTCString();
  const r = rig({
    imageFetch: async () => ({
      ok: true, status: 200,
      headers: { get: (h) => (h === 'X-Cam-Captured' ? captured : null) },
      blob: async () => new Blob(['jpeg']),
    }),
  });
  try {
    sb.openCamLink(new URLSearchParams('cam=houston.102'));
    r.inventory.resolve(jsonRes(CAMS));
    await settle();
    await settle();
    const meta = r.els['#cam-meta'].innerHTML;
    assert.match(meta, /cam-badge stale/);
    assert.match(meta, /cam\.stale\.note/);
    assert.doesNotMatch(meta, /cam-badge still/);
  } finally { r.restore(); }
});

test('Copy link copies the camera link through the one share-copy path, and confirms on the button', async () => {
  const r = rig();
  const written = [];
  sb.navigator = { clipboard: { writeText: async (s) => { written.push(s); } } };
  sb.isSecureContext = true;
  try {
    sb.openCamViewer(HOUSTON_102, 'houston');
    await sb.copyCamLink();
    await settle();
    assert.equal(written.length, 1);
    const q = query(written[0]);
    assert.equal(q.get('cam'), 'houston.102');
    assert.equal(q.get('mz'), '11');
    assert.equal(q.get('ft'), 'rescue');
    const btn = r.els['#cam-link'];
    // not shortened here (no ClipboardItem, not the public origin), and the button says so
    assert.equal(btn.textContent, 'share.copied.full');
    // a second tap inside the confirmation must not make "copied" the button's resting label
    sb.copyCamLink();
    await settle();
    const flashes = r.timers.filter((x) => x.ms === 2000);
    flashes[flashes.length - 1].fn();
    assert.equal(btn.textContent, '🔗 Copy link');

    sb.closeCamViewer();
    sb.copyCamLink();
    await settle();
    assert.equal(written.length, 2, 'a closed viewer has no camera to link');
  } finally { r.restore(); }
});
