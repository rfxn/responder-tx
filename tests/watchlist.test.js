'use strict';

/* Watchlist star (v0.99.83). Two things are load-bearing and both are behavioural, so every test
   below CALLS the renderer rather than reading its source: a starred row must lead its tab, and a
   starred item the tab cannot draw must never read as an all-clear. A filtered-away watch, a watch
   the data no longer carries and a watch whose source never answered are three different facts,
   and nothing on this path may evict a watch on a miss. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./harness.js');
const I18N = require('./i18n-load.js');

const APP = loadApp();
const SB = APP._sandbox;
const ST = APP.state;
const {
  WATCH_KEY, watchList, watchHas, watchToggle, watchDrop, watchFirst, watchAudit,
  watchStarHtml, watchNoticeHtml, roadsTabRows, roadsRowHtml, roadRowKey, roadId,
} = APP;

const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();

// the app runs in a vm realm, so its arrays carry a different Array.prototype than assert expects
const arr = (v) => Array.from(v);

function resetWatch() {
  ST.watch = null;
  SB.localStorage.removeItem(WATCH_KEY);
}

const stored = () => JSON.parse(SB.localStorage.getItem(WATCH_KEY) || 'null');

/* ---------- a recording DOM: the renderers below are executed against it ---------- */

// hidden: true keeps refreshRecoveryView/refreshBasinView from rendering lenses this file is not testing
function recEl(tag) {
  const el = {
    tag, kids: [], wired: [], starHandler: null,
    className: '', textContent: '', title: '', value: '', hidden: true,
    dataset: {}, style: {}, options: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild(c) { el.kids.push(c); return c; },
    append() {}, remove() {}, add() {},
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, getAttribute() { return ''; },
    closest() { return null; }, dispatchEvent() { return true; }, scrollIntoView() {},
    querySelector(sel) {
      if (String(sel) !== '.watch-star') return null;
      return { addEventListener(_e, fn) { el.starHandler = fn; } };
    },
    // a descendant search like the real one: renderGaugesTab puts the notice in a child node
    querySelectorAll(sel) {
      const s = String(sel);
      const attr = s === '.watch-star' ? 'data-watch-id'
        : s === '[data-watch-drop]' ? 'data-watch-drop'
          : s === '[data-watch-show]' ? 'data-watch-show' : null;
      if (!attr) return [];
      return [...markupOf(el).matchAll(new RegExp(`${attr}="([^"]*)"`, 'g'))].map((m) => ({
        dataset: {},
        getAttribute: () => m[1],
        addEventListener(_e, fn) { el.wired.push({ sel: s, value: m[1], fn }); },
      }));
    },
  };
  // writing innerHTML replaces the children, as it does in a browser: a re-render into the same
  // host must not leave the previous paint's cards behind for an assertion to read
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return html; },
    set(v) { html = String(v); el.kids.length = 0; },
  });
  return el;
}

const markupOf = (el) => String(el.innerHTML || '') + el.kids.map(markupOf).join('');

const CLICK = { stopPropagation() {} };

// run `fn` with document swapped for recording nodes; returns the hosts the tabs render into
function withDom(fn) {
  const nodes = new Map();
  const node = (sel) => {
    const s = String(sel);
    if (!nodes.has(s)) nodes.set(s, recEl('div'));
    return nodes.get(s);
  };
  const saved = { qs: SB.document.querySelector, ce: SB.document.createElement, t: SB.t, setInView: SB.setInView };
  const setInViewCalls = [];
  SB.document.querySelector = node;
  SB.document.createElement = (tag) => recEl(tag);
  SB.setInView = (on) => { setInViewCalls.push(on); ST.inView = on; };
  SB.t = (k) => (TEMPLATES[k] === undefined ? k : TEMPLATES[k]);
  try { return fn({ node, setInViewCalls }); } finally {
    SB.document.querySelector = saved.qs;
    SB.document.createElement = saved.ce;
    SB.setInView = saved.setInView;
    SB.t = saved.t;
  }
}

// the harness t() echoes its key, so an interpolated string substitutes nothing; these are the
// only keys these tests read a value out of
const TEMPLATES = {
  'watch.section': 'Watching ({n})',
  'watch.gauges.hidden': '{n} gauges you are watching are outside the current view.',
  'watch.gauges.absent': '{n} gauges you are watching are not in the gauge data right now: {ids}',
  'watch.gauges.unknown': '{n} gauges you are watching cannot be checked.',
  'watch.roads.absent': '{n} roads you are watching are not in the current closure list.',
  'watch.roads.unknown': '{n} roads you are watching cannot be checked.',
};

/* ---------- gauge fixtures ---------- */

function gauge(lid, cat, o = {}) {
  return {
    lid,
    name: o.name || `Test River at ${lid}`,
    latitude: o.lat === undefined ? 30.5 : o.lat,
    longitude: o.lon === undefined ? -98 : o.lon,
    status: {
      observed: {
        floodCategory: cat, primary: o.primary === undefined ? 10.4 : o.primary,
        primaryUnit: 'ft', validTime: iso(5),
      },
      forecast: {
        floodCategory: o.fcat || 'no_flooding', primary: o.fprimary === undefined ? 0 : o.fprimary,
        primaryUnit: 'ft', validTime: new Date(Date.now() + 86400000).toISOString(),
      },
    },
  };
}

const GAUGE_STATE_KEYS = ['gauges', 'gaugesDegraded', 'inView', 'gaugeGroup', 'showNormalGauges',
  'showDegradedGauges', 'map', 'records', 'trendHist', 'myPos'];

function renderGaugesWith(patch, fn) {
  const saved = {};
  for (const k of GAUGE_STATE_KEYS) saved[k] = ST[k];
  Object.assign(ST, {
    gauges: [], gaugesDegraded: [], inView: false, gaugeGroup: 'priority',
    showNormalGauges: false, showDegradedGauges: false, map: null, records: {}, trendHist: {}, myPos: null,
  }, patch);
  try {
    return withDom((dom) => {
      SB.renderGaugesTab();
      return fn(dom.node('#gauge-list'), dom);
    });
  } finally { Object.assign(ST, saved); }
}

// cards in render order, and the section titles that separate them
const cardLids = (host) => host.kids.filter((k) => k.dataset && k.dataset.lid).map((k) => k.dataset.lid);
const titles = (host) => host.kids.filter((k) => k.className === 'section-title').map((k) => k.textContent);

/* ---------- storage ---------- */

test('a star round-trips through localStorage under the declared key and shape', () => {
  resetWatch();
  assert.equal(watchHas('gauges', 'ABCT2'), false);
  assert.equal(watchToggle('gauges', 'ABCT2'), true, 'toggling an unwatched id turns it on');
  assert.equal(watchHas('gauges', 'ABCT2'), true);
  assert.deepEqual(stored(), { gauges: ['ABCT2'], roads: [] });

  watchToggle('roads', 'txdot:abc');
  assert.deepEqual(stored(), { gauges: ['ABCT2'], roads: ['txdot:abc'] });

  assert.equal(watchToggle('gauges', 'ABCT2'), false, 'toggling a watched id turns it off');
  assert.deepEqual(stored(), { gauges: [], roads: ['txdot:abc'] });

  // a fresh read of the same storage rebuilds the same set
  ST.watch = null;
  assert.deepEqual(arr(watchList('roads')), ['txdot:abc']);
  assert.deepEqual(arr(watchList('gauges')), []);
  resetWatch();
});

test('a junk or missing stored value reads as an empty watchlist rather than throwing', () => {
  for (const raw of ['', 'not json', '[]', '{"gauges":"ABCT2"}', '{"gauges":[1,2,null,""]}']) {
    ST.watch = null;
    SB.localStorage.setItem(WATCH_KEY, raw);
    assert.deepEqual(arr(watchList('gauges')), [], raw);
    assert.deepEqual(arr(watchList('roads')), [], raw);
  }
  resetWatch();
});

test('watchFirst lifts the watched rows and leaves both groups in the order it was given', () => {
  resetWatch();
  watchToggle('gauges', 'B');
  watchToggle('gauges', 'D');
  const rows = ['A', 'B', 'C', 'D', 'E'].map((id) => ({ id }));
  assert.deepEqual(arr(watchFirst(rows, 'gauges', (r) => r.id).map((r) => r.id)), ['B', 'D', 'A', 'C', 'E']);
  resetWatch();
});

test('watchAudit tells a filtered-away watch from one the data does not carry', () => {
  resetWatch();
  for (const id of ['SEEN', 'HIDDEN', 'GONE']) watchToggle('gauges', id);
  const a = watchAudit('gauges', ['SEEN', 'HIDDEN'], ['SEEN']);
  assert.deepEqual(arr(a.hidden), ['HIDDEN'], 'in the data but not drawn is a filtered-away watch');
  assert.deepEqual(arr(a.absent), ['GONE'], 'not in the data at all is a different fact');
  resetWatch();
});

/* ---------- the star markup ---------- */

test('the star is a real toggle: aria-pressed and the glyph both follow the stored state', () => {
  resetWatch();
  const off = watchStarHtml('gauges', 'ABCT2', 'Test River');
  assert.match(off, /aria-pressed="false"/);
  assert.match(off, /☆/);
  assert.ok(!off.includes('★'), 'an unwatched row must not wear the filled glyph');
  assert.match(off, /class="watch-star"/);
  assert.match(off, /data-watch-id="ABCT2"/);
  assert.match(off, /aria-label="[^"]+"/, 'the toggle needs a name of its own, not just a glyph');

  watchToggle('gauges', 'ABCT2');
  const on = watchStarHtml('gauges', 'ABCT2', 'Test River');
  assert.match(on, /aria-pressed="true"/);
  assert.match(on, /class="watch-star on"/);
  assert.match(on, /★/);
  resetWatch();
});

test('a quote in an id or a name cannot break out of the star markup', () => {
  resetWatch();
  const html = watchStarHtml('roads', 'curated:a"b', 'FM "1"');
  assert.ok(!/data-watch-id="curated:a"b"/.test(html));
  assert.match(html, /data-watch-id="curated:a&quot;b"/);
  assert.ok(!html.includes('FM "1"'), 'the row name must be escaped inside the label attribute');
  resetWatch();
});

/* ---------- gauges: the pinned group ---------- */

const RISE_A = gauge('RISEA', 'no_flooding', { fcat: 'minor', fprimary: 12 });
const RISE_B = gauge('RISEB', 'no_flooding', { fcat: 'minor', fprimary: 11 });
const FLOOD_HI = gauge('FLDHI', 'major', { primary: 30 });
const FLOOD_LO = gauge('FLDLO', 'minor', { primary: 12 });
const NORMAL = gauge('NORM', 'no_flooding');

test('the gauges tab renders its buckets in the smart order when nothing is watched', () => {
  resetWatch();
  renderGaugesWith({ gauges: [FLOOD_LO, FLOOD_HI, RISE_A] }, (host) => {
    assert.deepEqual(cardLids(host), ['RISEA', 'FLDHI', 'FLDLO'],
      'rising first, then in-flood ranked by category and stage');
    assert.ok(!titles(host).some((s) => s.startsWith('Watching')), 'no watchlist section with nothing watched');
  });
});

test('a starred gauge leads the tab and drops out of the bucket it came from', () => {
  resetWatch();
  watchToggle('gauges', 'FLDLO');
  renderGaugesWith({ gauges: [FLOOD_LO, FLOOD_HI, RISE_A] }, (host) => {
    assert.deepEqual(cardLids(host), ['FLDLO', 'RISEA', 'FLDHI'],
      'the watched row leads; the rest keep the sort they already had');
    assert.equal(cardLids(host).filter((l) => l === 'FLDLO').length, 1, 'a pinned row must not also list in its bucket');
    assert.equal(titles(host)[0], 'Watching (1)');
  });
  resetWatch();
});

test('two starred gauges keep the smart order between themselves', () => {
  resetWatch();
  watchToggle('gauges', 'FLDLO');
  watchToggle('gauges', 'RISEB');
  renderGaugesWith({ gauges: [FLOOD_LO, FLOOD_HI, RISE_A, RISE_B] }, (host) => {
    const lids = cardLids(host);
    assert.deepEqual(lids.slice(0, 2), ['RISEB', 'FLDLO'],
      'inside the watched group, rising still outranks in-flood');
    assert.deepEqual(lids.slice(2), ['RISEA', 'FLDHI'], 'the unwatched group is untouched');
    assert.equal(titles(host)[0], 'Watching (2)');
  });
  resetWatch();
});

test('starring a normal gauge surfaces it without opening the fold it was hidden behind', () => {
  resetWatch();
  watchToggle('gauges', 'NORM');
  renderGaugesWith({ gauges: [FLOOD_HI, NORMAL], showNormalGauges: false }, (host) => {
    assert.deepEqual(cardLids(host), ['NORM', 'FLDHI']);
    assert.equal(ST.showNormalGauges, false, 'a pin must not silently flip a filter the user set');
  });
  resetWatch();
});

test('every gauge in flood being starred does not make the tab claim none are', () => {
  resetWatch();
  watchToggle('gauges', 'FLDHI');
  renderGaugesWith({ gauges: [FLOOD_HI] }, (host) => {
    const empties = host.kids.filter((k) => k.className === 'card' && k.textContent);
    assert.deepEqual(empties.map((k) => k.textContent), [],
      'the "no gauges in flood" card must not fire when the only flooding gauge is pinned');
    assert.deepEqual(cardLids(host), ['FLDHI']);
  });
  resetWatch();
});

test('tapping the star on a rendered card toggles storage and repaints', () => {
  resetWatch();
  renderGaugesWith({ gauges: [FLOOD_HI, FLOOD_LO] }, (host) => {
    const card = host.kids.find((k) => k.dataset.lid === 'FLDLO');
    assert.ok(card && typeof card.starHandler === 'function', 'the card must wire its own star');
    card.starHandler(CLICK);
    assert.deepEqual(arr(watchList('gauges')), ['FLDLO'], 'the tap wrote the watch');
    // the handler re-renders into the same host: the pinned row is now first
    assert.deepEqual(cardLids(host).slice(0, 1), ['FLDLO']);
    const again = host.kids.find((k) => k.dataset.lid === 'FLDLO');
    again.starHandler(CLICK);
    assert.deepEqual(arr(watchList('gauges')), [], 'a second tap unstars');
  });
  resetWatch();
});

/* ---------- gauges: the three honest answers ---------- */

test('a watched gauge the view filter hides is counted and offered a one-tap way back', () => {
  resetWatch();
  watchToggle('gauges', 'FLDLO');
  const inBox = ([lat]) => lat > 30.9;
  renderGaugesWith({
    gauges: [Object.assign({}, FLOOD_HI, { latitude: 31 }), Object.assign({}, FLOOD_LO, { latitude: 29 })],
    inView: true,
    map: { getBounds: () => ({ contains: inBox }) },
  }, (host, dom) => {
    const notes = host.kids.find((k) => k.className === 'watch-notes');
    assert.ok(notes, 'a watched gauge the filter hid must say so');
    assert.match(notes.innerHTML, /1 gauges you are watching are outside the current view/);
    assert.ok(!/not in the gauge data/.test(notes.innerHTML), 'a filtered gauge is not a missing one');
    assert.match(notes.innerHTML, /data-watch-show="gauges"/, 'the line needs a control that unhides them');

    const show = host.wired.find((w) => w.sel === '[data-watch-show]');
    assert.ok(show, 'the show control must be wired, not just drawn');
    show.fn(CLICK);
    assert.deepEqual(dom.setInViewCalls, [false], 'the one tap drops the scope that was hiding them');
  });
  resetWatch();
});

test('a watched gauge the data no longer carries says so by name, and stays watched', () => {
  resetWatch();
  watchToggle('gauges', 'RETIRED');
  renderGaugesWith({ gauges: [FLOOD_HI] }, (host) => {
    const notes = host.kids.find((k) => k.className === 'watch-notes');
    assert.ok(notes, 'the tab must account for a watched gauge it did not draw');
    assert.match(notes.innerHTML, /1 gauges you are watching are not in the gauge data right now: RETIRED/);
    assert.ok(!/outside the current view/.test(notes.innerHTML), 'absent is not the same fact as filtered');
    assert.match(notes.innerHTML, /data-watch-drop="gauges"/, 'unstarring stays available, and stays the user\'s call');
  });
  assert.deepEqual(arr(watchList('gauges')), ['RETIRED'], 'the render path must never evict a watch');
  resetWatch();
});

test('a gauge feed that never answered is reported as unmeasurable, not as a missing gauge', () => {
  resetWatch();
  watchToggle('gauges', 'FLDHI');
  renderGaugesWith({ gauges: [], gaugesDegraded: [] }, (host) => {
    const notes = host.kids.find((k) => k.className === 'watch-notes');
    assert.ok(notes, 'an unanswered feed must not silently drop the watchlist line');
    assert.match(notes.innerHTML, /1 gauges you are watching cannot be checked/);
    assert.ok(!/not in the gauge data/.test(notes.innerHTML),
      'a failed fetch must not be published as "this gauge is gone"');
    assert.ok(!/data-watch-drop/.test(notes.innerHTML),
      'nothing may offer to unstar an item whose source did not answer');
  });
  assert.deepEqual(arr(watchList('gauges')), ['FLDHI'], 'one empty payload must not evict a watch');

  // and the very next successful render finds it again
  renderGaugesWith({ gauges: [FLOOD_HI] }, (host) => {
    assert.deepEqual(cardLids(host), ['FLDHI']);
    assert.equal(host.kids.some((k) => k.className === 'watch-notes'), false);
  });
  resetWatch();
});

test('the drop control removes exactly the absent ids and nothing else', () => {
  resetWatch();
  watchToggle('gauges', 'FLDHI');
  watchToggle('gauges', 'RETIRED');
  renderGaugesWith({ gauges: [FLOOD_HI] }, (host) => {
    const drop = host.wired.find((w) => w.sel === '[data-watch-drop]');
    assert.ok(drop, 'the drop control must be wired');
    drop.fn(CLICK);
    assert.deepEqual(arr(watchList('gauges')), ['FLDHI'], 'the drawn watch survives; only the absent one goes');
  });
  resetWatch();
});

/* ---------- roads ---------- */

const txdotLine = (route, lat) => ({
  type: 'Feature',
  properties: { route_name: route, condition: 'Closure', from_limit: `${route} A`, to_limit: `${route} B`, start_time: iso(180) },
  geometry: { type: 'LineString', coordinates: [[-98, lat], [-97.99, lat + 0.01]] },
});

const ROADS_STATE_KEYS = ['crossings', 'crossStatus', 'roadClosures', 'myPos', 'roadsTabFp',
  'roadsFallbackAt', 'roadsUnknown', 'crossingsUnknown', 'crossStatusUnknown', 'roadsPartial', 'map'];

function setRoads(patch) {
  Object.assign(ST, {
    crossings: [], crossStatus: null, roadClosures: { lines: [], points: [] }, myPos: null,
    roadsTabFp: null, roadsFallbackAt: null, roadsUnknown: false, crossingsUnknown: false,
    crossStatusUnknown: false, roadsPartial: false, map: null,
  }, patch);
}

function renderRoadsWith(patch, fn) {
  const saved = {};
  for (const k of ROADS_STATE_KEYS) saved[k] = ST[k];
  setRoads(patch);
  try {
    return withDom((dom) => {
      SB.renderRoadsTab();
      return fn(dom.node('#crossings-body'), dom);
    });
  } finally { Object.assign(ST, saved); }
}

const ROADS_FIXTURE = {
  crossings: [{ id: 'x-one', name: 'Curated One', status: 'closed', lat: 30.1, lon: -97.8, updated_at: iso(60) }],
  crossStatus: { crossings: [{ id: '811', name: 'Jurisdiction One', status: 'closed', jurisdiction: 'MBF', lat: 30.4, lon: -98.1, changed: iso(600) }] },
  roadClosures: { lines: [txdotLine('FM0126', 30.5), txdotLine('IH0010', 30.6)], points: [] },
};

test('a road row carries the identity the closure archive already keys on', () => {
  resetWatch();
  setRoads(ROADS_FIXTURE);
  const rows = roadsTabRows();
  const tx = rows.find((r) => r.kind === 'txdot');
  assert.equal(tx.wid, roadRowKey('txdot', roadId({ route_name: 'FM0126', from_limit: 'FM0126 A', to_limit: 'FM0126 B' })),
    'the TxDOT watch key must be roadId (route + limits), not a second identity');
  assert.equal(rows.find((r) => r.kind === 'curated').wid, 'curated:x-one');
  assert.equal(rows.find((r) => r.kind === 'xstatus').wid, 'xstatus:811');
  assert.equal(new Set(rows.map((r) => r.wid)).size, rows.length, 'every row needs its own key');
  resetWatch();
});

test('a starred road leads the Roads list and the rest keep the distance sort', () => {
  resetWatch();
  setRoads(Object.assign({}, ROADS_FIXTURE, { myPos: { lat: 30.1, lng: -97.8 } }));
  const before = roadsTabRows().map((r) => r.wid);
  assert.equal(before[0], 'curated:x-one', 'nearest first before anything is watched');

  watchToggle('roads', 'xstatus:811');
  const after = roadsTabRows().map((r) => r.wid);
  assert.equal(after[0], 'xstatus:811', 'the watched row leads regardless of distance');
  assert.deepEqual(after.slice(1), before.filter((w) => w !== 'xstatus:811'),
    'the unwatched rows keep the exact order they had');
  resetWatch();
});

test('the Roads tab draws a star per row and the tap wires through to storage', () => {
  resetWatch();
  renderRoadsWith(ROADS_FIXTURE, (host) => {
    const ids = [...host.innerHTML.matchAll(/data-watch-id="([^"]*)"/g)].map((m) => m[1]);
    assert.equal(ids.length, 4, 'every hazard row gets its own star');
    assert.match(host.innerHTML, /class="watch-star" data-watch-kind="roads"/);

    const tap = host.wired.find((w) => w.sel === '.watch-star' && w.value === 'xstatus:811');
    assert.ok(tap, 'the star must be wired, not just drawn');
    tap.fn(CLICK);
    assert.deepEqual(arr(watchList('roads')), ['xstatus:811']);
    assert.match(host.innerHTML, /data-watch-id="xstatus:811" aria-pressed="true"/,
      'the repaint must show the row as watched');
    // and the repaint put it first
    const order = [...host.innerHTML.matchAll(/data-watch-id="([^"]*)"/g)].map((m) => m[1]);
    assert.equal(order[0], 'xstatus:811');
  });
  resetWatch();
});

test('a watched road absent from a healthy closure list is reported as absent, not as an all-clear', () => {
  resetWatch();
  watchToggle('roads', 'curated:reopened-one');
  renderRoadsWith(ROADS_FIXTURE, (host) => {
    assert.match(host.innerHTML, /1 roads you are watching are not in the current closure list/);
    assert.ok(!/cannot be checked/.test(host.innerHTML));
    assert.match(host.innerHTML, /data-watch-drop="roads"/);
  });
  assert.deepEqual(arr(watchList('roads')), ['curated:reopened-one'], 'being absent is not an unwatch');
  resetWatch();
});

test('with every road source down the empty list still accounts for the watchlist', () => {
  resetWatch();
  watchToggle('roads', 'txdot:whatever');
  renderRoadsWith({ roadsUnknown: true, crossingsUnknown: true, crossStatusUnknown: true }, (host) => {
    assert.match(host.innerHTML, /1 roads you are watching cannot be checked/,
      'an unanswered feed must not leave a watched road unaccounted for');
    assert.ok(!/not in the current closure list/.test(host.innerHTML),
      'a feed that did not answer cannot assert the road reopened');
    assert.ok(!/data-watch-drop/.test(host.innerHTML));
    assert.match(host.innerHTML, /rcv-none/, 'the existing unknown empty state still renders');
  });
  assert.deepEqual(arr(watchList('roads')), ['txdot:whatever']);
  resetWatch();
});

test('snapshot fallback cannot report a watched TxDOT road as gone', () => {
  resetWatch();
  watchToggle('roads', 'txdot:whatever');
  // the snapshot carries route + start but no limits, so roadId cannot rebuild a live row's key
  renderRoadsWith({
    roadsFallbackAt: Date.now() - 600000,
    roadClosures: {
      lines: [],
      points: [{
        _snapshot: true,
        properties: { condition: 'Closure', route_name: 'FM0126', description: '', start_time: iso(200), _snapshot: true, _snapshotAt: iso(10) },
        geometry: { type: 'Point', coordinates: [-98, 30.5] },
      }],
    },
  }, (host) => {
    assert.match(host.innerHTML, /1 roads you are watching cannot be checked/);
    assert.ok(!/not in the current closure list/.test(host.innerHTML));
  });
  resetWatch();
});

test('the Roads scroll guard still short-circuits an unchanged list, and never a changed watchlist', () => {
  resetWatch();
  renderRoadsWith(ROADS_FIXTURE, (host) => {
    const first = host.innerHTML;
    host.innerHTML = 'CLOBBERED';
    SB.renderRoadsTab();
    assert.equal(host.innerHTML, 'CLOBBERED', 'an unchanged list must not repaint and reset the scroll');

    watchToggle('roads', 'curated:x-one');
    SB.renderRoadsTab();
    assert.notEqual(host.innerHTML, 'CLOBBERED', 'a changed watchlist must repaint');
    assert.notEqual(host.innerHTML, first);
  });
  resetWatch();
});

/* ---------- the notice builder itself ---------- */

test('watchNoticeHtml renders nothing when every watched item is on screen', () => {
  resetWatch();
  watchToggle('gauges', 'A');
  assert.equal(watchNoticeHtml('gauges', watchAudit('gauges', ['A'], ['A']), {}), '');
  resetWatch();
});

/* ---------- i18n and accessibility contracts ---------- */

const WATCH_KEYS = ['watch.add', 'watch.remove', 'watch.section', 'watch.show', 'watch.drop',
  'watch.gauges.hidden', 'watch.gauges.absent', 'watch.gauges.unknown',
  'watch.roads.absent', 'watch.roads.unknown'];

test('every watchlist string exists in both languages, with its placeholders intact', () => {
  for (const k of WATCH_KEYS) {
    for (const lang of ['en', 'es']) {
      assert.equal(typeof I18N[lang][k], 'string', `${lang} is missing ${k}`);
      assert.ok(I18N[lang][k].length > 0, `${lang} ${k} is empty`);
      assert.ok(!I18N[lang][k].includes('—'), `em-dash in ${lang} ${k}`);
    }
    for (const token of ['{n}', '{ids}', '{name}']) {
      assert.equal(I18N.en[k].includes(token), I18N.es[k].includes(token),
        `${k} placeholder ${token} does not match across languages`);
    }
  }
});

test('the unknown strings deny the zero reading rather than implying one', () => {
  for (const lang of ['en', 'es']) {
    for (const k of ['watch.gauges.unknown', 'watch.roads.unknown']) {
      assert.match(I18N[lang][k], /\{n\}/, `${lang} ${k} must count what it cannot check`);
    }
  }
});

test('the star is a 44px target that does not grow every row, and stops moving on request', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'app.css'), 'utf8');
  const rule = css.match(/\n\.watch-star \{([^}]*)\}/);
  assert.ok(rule, '.watch-star has no rule in css/app.css');
  assert.match(rule[1], /min-height:\s*44px/, 'the star must meet the 44px tap floor');
  assert.match(rule[1], /min-width:\s*44px/);
  assert.match(rule[1], /position:\s*absolute/,
    'an in-flow 44px star would add ~27px to every row of a thousand-row list');
  // the rows it sits on reserve the width, so the target never lands on the text beside it
  assert.match(css, /\.card\.gauge-card, \.resource-item\.road-row \{[^}]*padding-right:\s*4\dpx/);
  const rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {\n  .brand .sub .live-dot'));
  assert.match(rm.slice(0, rm.indexOf('\n}')), /\.watch-star/,
    'the star transitions colour, so reduced motion must switch it off');
});
