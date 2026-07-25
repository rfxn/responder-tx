'use strict';

/* Gauges tab: the degraded set.
   v0.98.3 split the gauges NWPS reports without a usable severity (not_defined, obs_not_current,
   out_of_service) into state.gaugesDegraded so no count, chip or tile could ever read one as
   flooding. renderGaugesTab kept building every bucket from state.gauges alone, so those gauges
   were on the map and in the legend but could not be found in the list at all: 411 of 1018 sites
   at the statewide AO. The popup still offered "Open in gauges list" for them, which found no row,
   flipped the unrelated normal-gauges fold, and revealed nothing.
   These tests pin the reachability and, just as hard, the suppression it must not cost. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

const {
  state, gaugeDegraded, splitGauges, gaugeState, gaugeCat, gaugeObsCat, gaugeRising, gaugeStateCounts,
  recordContext, gaugeCardDiv, gaugeGlyphHtml, degradedGaugePool, degradedGaugeList, degradedStateCounts,
  openInGaugesList, gaugeListUnfoldFor, NWPS_DEGRADED_CAT, GAUGE_DEGRADED, DEG_GLYPH, _sandbox,
} = loadApp();

const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();

function gauge(lid, cat, o = {}) {
  return {
    lid,
    name: o.name || `Test River at ${lid}`,
    latitude: o.lat === undefined ? 30 : o.lat,
    longitude: o.lon === undefined ? -98 : o.lon,
    status: {
      observed: {
        floodCategory: cat,
        primary: o.primary === undefined ? 10.4 : o.primary,
        primaryUnit: 'ft',
        validTime: o.validTime === undefined ? iso(5) : o.validTime,
      },
      forecast: {
        floodCategory: o.fcat || 'no_flooding',
        primary: o.fprimary === undefined ? 0 : o.fprimary,
        primaryUnit: 'ft',
        validTime: o.fvalid || new Date(Date.now() + 86400000).toISOString(),
      },
    },
  };
}

function withState(patch, fn) {
  const keys = Object.keys(patch);
  const saved = {};
  for (const k of keys) saved[k] = state[k];
  Object.assign(state, patch);
  try { return fn(); } finally { Object.assign(state, saved); }
}

/* ---------- the predicate ---------- */

test('gaugeDegraded is exactly the NWPS degraded set, and is what splits the two lists', () => {
  for (const cat of Object.keys(NWPS_DEGRADED_CAT)) {
    assert.equal(gaugeDegraded(gauge('X', cat)), true, cat);
  }
  for (const cat of ['no_flooding', 'action', 'minor', 'moderate', 'major', 'low_threshold']) {
    assert.equal(gaugeDegraded(gauge('X', cat)), false, cat);
  }
  assert.equal(gaugeDegraded(null), false);
  assert.equal(gaugeDegraded({}), false);
  const split = splitGauges([gauge('A', 'major'), gauge('B', 'not_defined'), gauge('C', 'obs_not_current'), gauge('D', 'no_flooding')]);
  assert.deepEqual([...split.live.map((g) => g.lid)], ['A', 'D']); // the split arrays are built in the vm realm
  assert.deepEqual([...split.degraded.map((g) => g.lid)], ['B', 'C']);
});

/* ---------- reachable in the list ---------- */

test('every degraded gauge is reachable in the list, name-ordered, and none of them is in state.gauges', () => {
  const deg = [gauge('Z1', 'out_of_service', { name: 'Zebra Creek at Zed' }), gauge('A1', 'not_defined', { name: 'Alpha River at Ames' })];
  withState({ gauges: [gauge('L1', 'major')], gaugesDegraded: deg, inView: false }, () => {
    const list = degradedGaugeList();
    assert.deepEqual(list.map((g) => g.lid), ['A1', 'Z1'], 'all of them, ordered by name');
    for (const g of list) assert.ok(!state.gauges.includes(g), 'the severity set stays the severity set');
  });
});

test('the degraded fold honours the In view scope the severity buckets use', () => {
  const deg = [gauge('IN', 'not_defined', { lat: 30 }), gauge('OUT', 'not_defined', { lat: 40 })];
  const map = { getBounds: () => ({ contains: (ll) => ll[0] < 31 }) };
  withState({ gauges: [], gaugesDegraded: deg, inView: true, map }, () => {
    assert.deepEqual(degradedGaugePool().map((g) => g.lid), ['IN']);
  });
  withState({ gauges: [], gaugesDegraded: deg, inView: false, map }, () => {
    assert.deepEqual(degradedGaugePool().map((g) => g.lid), ['IN', 'OUT']);
  });
});

test('the fold counts split by degraded state and account for every row it shows', () => {
  const list = [
    gauge('A', 'not_defined'),
    gauge('B', 'not_defined'),
    gauge('C', 'obs_not_current', { validTime: iso(60 * 40) }),
    gauge('D', 'out_of_service', { primary: -999, validTime: '0001-01-01T00:00:00Z' }),
  ];
  const n = degradedStateCounts(list);
  assert.deepEqual({ ...n }, { nothresh: 2, stale: 1, oos: 1 });
  assert.equal(Object.values(n).reduce((a, b) => a + b, 0), list.length, 'no row is uncounted');
  assert.deepEqual([...Object.keys(n)].sort(), [...GAUGE_DEGRADED].sort());
});

/* ---------- distinguishable from a gauge with a real reading ---------- */

test('a degraded card says its degraded state where a severity word would go, never a category', () => {
  const div = gaugeCardDiv(gauge('N1', 'not_defined', { primary: 12.3 }));
  assert.match(div.innerHTML, /deg-word/);
  assert.match(div.innerHTML, /gstate\.nothresh/, 'the state label stands in for the category word');
  assert.ok(!div.innerHTML.includes('cat.none'), 'a gauge with no thresholds must never read as normal');
  assert.match(div.innerHTML, /12\.3 ft/, 'the level is real and still shown');
  assert.match(div.innerHTML, /gstate\.nothresh\.note/, 'and the card says what the state means');
  assert.match(div.className, /\bdegraded\b/);
  assert.equal(div.dataset.gstate, 'nothresh');
  assert.equal(div.dataset.lid, 'N1');
});

test('a normal gauge is unaffected: it still reads as a category, with no degraded marks', () => {
  const div = gaugeCardDiv(gauge('OK', 'no_flooding', { primary: 3.2 }));
  assert.match(div.innerHTML, /cat\.none/);
  assert.ok(!div.innerHTML.includes('deg-word'));
  assert.ok(!/\bdegraded\b/.test(div.className));
  assert.equal(div.dataset.gstate, 'none');
});

test('an out-of-service gauge shows its state rather than a stage it is not reporting', () => {
  const div = gaugeCardDiv(gauge('OOS', 'out_of_service', { primary: -999, validTime: '0001-01-01T00:00:00Z' }));
  assert.match(div.innerHTML, /gstate\.oos/);
  assert.ok(!div.innerHTML.includes('-999'), 'the sentinel reading is never printed');
  assert.match(div.innerHTML, /gstate\.oos\.note/);
});

test('each degraded state gets its own glyph, and none of them is a severity dot', () => {
  const seen = new Set();
  for (const [cat, gs] of Object.entries(NWPS_DEGRADED_CAT)) {
    const html = gaugeGlyphHtml(gauge('G', cat, { validTime: gs === 'nothresh' ? iso(5) : iso(60 * 40) }));
    assert.match(html, /stale-glyph/, cat);
    assert.ok(html.includes(DEG_GLYPH[gaugeState(gauge('G', cat, { validTime: gs === 'nothresh' ? iso(5) : iso(60 * 40) }))]), cat);
    assert.ok(!html.includes('●') && !html.includes('▲') && !html.includes('○'), `${cat} must not borrow a severity glyph`);
    seen.add(html);
  }
  assert.equal(seen.size, Object.keys(NWPS_DEGRADED_CAT).length, 'the three states stay tellable apart');
});

/* ---------- the v0.98.3 guarantee, now that these gauges have a surface ---------- */

test('a degraded gauge can never carry a flood-bearing category, whatever NWPS put in the field', () => {
  for (const cat of Object.keys(NWPS_DEGRADED_CAT)) {
    const g = gauge('D', cat);
    assert.equal(gaugeCat(g), 'none');
    assert.equal(gaugeObsCat(g), 'none');
    assert.ok(GAUGE_DEGRADED.includes(gaugeState(g)));
  }
});

test('a degraded gauge never claims to be rising, even with a flood category in the forecast field', () => {
  const g = gauge('R', 'not_defined', { fcat: 'major', fprimary: 30, validTime: iso(2) });
  assert.equal(gaugeForecastCatIsFlood(g), true, 'fixture really does carry a flood forecast');
  assert.equal(gaugeRising(g), false);
  assert.ok(!gaugeCardDiv(g).innerHTML.includes('▲'));
});
function gaugeForecastCatIsFlood(g) {
  return ['action', 'minor', 'moderate', 'major'].includes(g.status.forecast.floodCategory);
}

test('a degraded gauge gets no crest-of-record line: its forecast is not current either', () => {
  withState({ records: { SGN: { record_ft: 4.58, record_date: '1979-07-27' } } }, () => {
    const deg = gauge('SGN', 'obs_not_current', { fprimary: 0.69, validTime: iso(60 * 40) });
    assert.equal(recordContext(deg), null);
    assert.ok(!gaugeCardDiv(deg).innerHTML.includes('record-line'));
    const live = gauge('SGN', 'no_flooding', { fprimary: 0.69 });
    assert.ok(recordContext(live), 'the same gauge with a usable observation still reports its margin');
  });
});

test('the degraded set stays out of the severity counts and inside the legend counts', () => {
  withState({ gauges: [gauge('F', 'major')], gaugesDegraded: [gauge('D1', 'not_defined'), gauge('D2', 'out_of_service')] }, () => {
    const n = gaugeStateCounts();
    assert.equal(n.major, 1);
    assert.equal(n.nothresh, 1);
    assert.equal(n.oos, 1);
    assert.equal(state.gauges.filter((g) => gaugeCat(g) !== 'none').length, 1, 'the tab badge counts one flooding gauge, not three');
  });
});

test('aging and suppression are untouched: a stale gauge in the severity set still reads stale, not degraded', () => {
  const g = gauge('S', 'major', { validTime: iso(60 * 40) });
  assert.equal(gaugeDegraded(g), false);
  assert.equal(gaugeCat(g), 'none', 'the stale gate still drops a frozen MAJOR out of the flood signal');
  const div = gaugeCardDiv(g);
  assert.match(div.className, /\bstale\b/);
  assert.ok(!/\bdegraded\b/.test(div.className));
  assert.match(div.innerHTML, /gauge\.stale/, 'the stale note is the one it keeps');
});

/* ---------- the popup affordance ---------- */

// swap in a DOM where the gauge row is genuinely absent, and record the side effects
function withReveal(present, fn) {
  const sb = _sandbox;
  const saved = { qs: sb.document.querySelector, render: sb.renderGaugesTab, reveal: sb.revealInList, setIn: sb.setInView };
  const calls = { render: 0, revealed: null, setInView: [] };
  sb.document.querySelector = (sel) => (present.some((p) => String(sel).includes(p)) ? { id: sel } : null);
  sb.renderGaugesTab = () => { calls.render += 1; };
  sb.revealInList = (tab, sel) => { calls.revealed = [tab, sel]; };
  sb.setInView = (on) => { calls.setInView.push(on); state.inView = on; };
  try { fn(calls); } finally {
    sb.document.querySelector = saved.qs;
    sb.renderGaugesTab = saved.render;
    sb.revealInList = saved.reveal;
    sb.setInView = saved.setIn;
  }
}

test('opening a degraded gauge in the list unfolds the degraded fold and leaves the normal fold alone', () => {
  withState({
    gauges: [gauge('L', 'no_flooding')], gaugesDegraded: [gauge('D', 'not_defined')],
    showNormalGauges: false, showDegradedGauges: false, inView: false,
  }, () => {
    withReveal([], (calls) => {
      openInGaugesList('D');
      assert.equal(state.showDegradedGauges, true);
      assert.equal(state.showNormalGauges, false, 'the fold the user never touched must not move');
      assert.equal(calls.render, 1);
      assert.deepEqual(calls.revealed, ['tab-gauges', '#gauge-list .gauge-card[data-lid="D"]']);
    });
  });
});

test('opening a normal-category gauge still unfolds the normal fold and leaves the degraded fold alone', () => {
  withState({
    gauges: [gauge('L', 'no_flooding')], gaugesDegraded: [gauge('D', 'not_defined')],
    showNormalGauges: false, showDegradedGauges: false, inView: false,
  }, () => {
    withReveal([], (calls) => {
      openInGaugesList('L');
      assert.equal(state.showNormalGauges, true);
      assert.equal(state.showDegradedGauges, false);
      assert.equal(calls.render, 1);
    });
  });
});

test('a gauge already on screen moves no filter at all', () => {
  withState({
    gauges: [gauge('F', 'major')], gaugesDegraded: [], showNormalGauges: false, showDegradedGauges: false, inView: false,
  }, () => {
    withReveal(['data-lid="F"'], (calls) => {
      openInGaugesList('F');
      assert.equal(calls.render, 0, 're-rendering the list under the user buys nothing here');
      assert.equal(state.showNormalGauges, false);
      assert.equal(state.showDegradedGauges, false);
      assert.deepEqual(calls.setInView, []);
    });
  });
});

test('In view is dropped only when it is the thing hiding a gauge the board actually has', () => {
  withState({
    gauges: [], gaugesDegraded: [gauge('D', 'not_defined')], showNormalGauges: false, showDegradedGauges: true, inView: true,
  }, () => {
    withReveal([], (calls) => {
      openInGaugesList('D');
      assert.deepEqual(calls.setInView, [false], 'the row the user tapped wins over the scope chip');
    });
  });
  withState({ gauges: [], gaugesDegraded: [], inView: true }, () => {
    withReveal([], (calls) => {
      openInGaugesList('GONE');
      assert.deepEqual(calls.setInView, [], 'a gauge the board does not have is no reason to change a filter');
    });
  });
});

test('unfolding for a set of gauges reports whether it changed anything, and renders at most once', () => {
  withState({
    gauges: [gauge('A', 'no_flooding'), gauge('B', 'no_flooding')],
    gaugesDegraded: [gauge('C', 'out_of_service')],
    showNormalGauges: false, showDegradedGauges: false,
  }, () => {
    withReveal([], (calls) => {
      assert.equal(gaugeListUnfoldFor(['A', 'B', 'C']), true);
      assert.equal(calls.render, 1, 'one re-render for the whole set, not one per gauge');
      assert.equal(state.showNormalGauges, true);
      assert.equal(state.showDegradedGauges, true);
      assert.equal(gaugeListUnfoldFor(['A', 'C']), false, 'nothing left to unfold, nothing to re-render');
      assert.equal(calls.render, 1);
    });
  });
});
