'use strict';

/*
 * tests/silent-failure.test.js — E1 applied to the client's OWN published state.
 *
 * tests/fetch-guard.test.js pins the parse side: a body we could not validate must not become a
 * value. This file pins what happens next, which is where the same defect kept reappearing in a
 * different shape:
 *
 *   - a failure that resolves instead of rejecting, so the degraded reporter never sees it;
 *   - a failure stored as {} or [], which is truthy/empty and therefore never retried;
 *   - a count rendered before its source answered, which reads as a measured zero;
 *   - a curated status shown past its confirmation window as if it were current.
 *
 * Every assertion here is about the distinction between "we checked and there is none" and "we
 * could not check", on the surface the reader actually sees.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, loadMapApp, loadHeaderStatus } = require('./harness.js');
const I18N = require('./i18n-load.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const app = loadApp();
const SB = app._sandbox;
const ST = app.state;

/* ================= loadSeeds: the failure has to reach refresh() ================= */

const SEED_BODIES = {
  'requests.json': { requests: [] },
  'resources.json': { shelters: [], hotlines: [], dataLinks: [] },
  'records.json': { records: { DRTT2: { record_ft: 40.5, record_date: '1998-10-18' } } },
  'crossings.json': { crossings: [] },
  'crossing-status.json': { crossings: [] },
  'shelters-live.json': { shelters: [], generated: new Date().toISOString() },
};

const SEED_STATE_KEYS = ['records', 'crossings', 'crossingsUnknown', 'crossStatus',
  'crossStatusUnknown', 'sheltersLive', 'sheltersUnknown', 'seedHash', 'seedsLoadedOnce', 'seedRequests', 'resources'];

function resetSeedState() {
  ST.records = null;
  ST.crossings = null; ST.crossingsUnknown = false;
  ST.crossStatus = null; ST.crossStatusUnknown = false;
  ST.sheltersLive = null; ST.sheltersUnknown = false;
  ST.seedHash = null; ST.seedsLoadedOnce = false;
}

// plan maps a data file to its answer: a body, an HTTP status, or 'reject' for a dead network
async function runSeeds(plan) {
  const stubs = ['markHealthy', 'renderRequests', 'renderResources', 'renderCrossings', 'renderCrossStatus', 'pbRefreshCurated'];
  const saved = {};
  for (const k of stubs.concat(['fetch', 'allRequests'])) saved[k] = SB[k];
  const healthy = [];
  for (const k of stubs) SB[k] = () => {};
  SB.markHealthy = (s) => healthy.push(s);
  SB.allRequests = () => [];
  SB.fetch = (url) => {
    const name = String(url).split('?')[0].split('/').pop();
    const answer = Object.prototype.hasOwnProperty.call(plan, name) ? plan[name] : SEED_BODIES[name];
    if (answer === 'reject') return Promise.reject(new Error(`network down: ${name}`));
    if (typeof answer === 'number') {
      return Promise.resolve({ ok: false, status: answer, json: () => Promise.reject(new Error('no body')) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer) });
  };
  try {
    const ok = await SB.loadSeeds();
    return { ok, healthy };
  } catch (err) {
    return { err, healthy };
  } finally {
    Object.assign(SB, saved);
  }
}

test('loadSeeds rejects on failure, so Promise.allSettled can name the board source degraded', async () => {
  const prev = {};
  for (const k of SEED_STATE_KEYS) prev[k] = ST[k];
  try {
    resetSeedState();
    const good = await runSeeds({});
    assert.equal(good.ok, true, 'non-vacuity: a healthy cycle still resolves true');
    assert.deepEqual(good.healthy, ['seeds'], 'and only a validated cycle marks the source healthy');

    resetSeedState();
    const bad = await runSeeds({ 'requests.json': 'reject' });
    assert.ok(bad.err instanceof Error, 'a failed seed fetch must reject, never resolve false');
    assert.match(String(bad.err.message), /requests/);
    assert.deepEqual(bad.healthy, [], 'and the board chip may not go green on it');

    // vm realm: the throw comes from okJson inside the bundle, so match the message, not the prototype
    const served = await runSeeds({ 'resources.json': 503 });
    assert.match(String(served.err && served.err.message), /HTTP 503/, 'an HTTP failure is a failure too');
  } finally { Object.assign(ST, prev); }
});

test('the seeds slot in refresh() carries the board label, and boot still gets a verdict', () => {
  const boot = read('js/boot.js');
  const args = boot.slice(boot.indexOf('Promise.allSettled([') + 'Promise.allSettled(['.length);
  const entries = args.slice(0, args.indexOf('])')).split(', ');
  assert.equal(entries.length, 7, 'the refresh fan-out changed shape; re-check REFRESH_SOURCE_KEYS');
  assert.ok(entries[5].startsWith('loadSeeds('), `slot 5 is ${entries[5]}, not loadSeeds()`);

  const hdr = loadHeaderStatus();
  assert.equal(hdr.REFRESH_SOURCE_KEYS[5], 'health.board', 'slot 5 must name the label renderSourceHealth gives the seeds chip');
  assert.equal(hdr.REFRESH_SOURCE_KEYS.length, entries.length, 'one label per settled promise, in the same order');
  for (const lang of ['en', 'es']) assert.ok(I18N[lang]['health.board'], `${lang} missing health.board`);

  // boot paints the "serve over HTTP" card off the verdict, so it must convert the rejection itself
  assert.match(boot, /await loadSeeds\(\)\.then\(\(\) => true, \(\) => false\)/,
    'boot must take a verdict from loadSeeds without re-swallowing it for everyone else');
  assert.doesNotMatch(read('js/panels.js'), /\} catch \{ return false; \}/,
    'loadSeeds must not resolve a failure as a value again');
});

/* ================= records / crossing-status / shelters: {} is not "none" ================= */

test('a failed records fetch stays unknown and a later cycle repairs it', async () => {
  const prev = {};
  for (const k of SEED_STATE_KEYS) prev[k] = ST[k];
  try {
    resetSeedState();
    await runSeeds({ 'records.json': 503 });
    assert.equal(ST.records, null,
      'a failed fetch may not latch an empty record set: {} is truthy, so nothing would ever retry it');

    // the whole point: because it stayed null, the next cycle asks again
    await runSeeds({});
    assert.deepEqual(Object.keys(ST.records), ['DRTT2'], 'the retry must repair the crest-of-record context');

    const g = { lid: 'DRTT2', name: 'Guadalupe Rv at Comfort', status: { forecast: { primary: 41, validTime: new Date(Date.now() + 3600000).toISOString() }, observed: { primary: 20, validTime: new Date().toISOString() } } };
    const rc = app.recordContext(g);
    assert.ok(rc && rc.atOrAbove, 'and the crest-of-record flag is alive again, not dead for the session');
  } finally { Object.assign(ST, prev); }
});

test('a records file this deploy never shipped is a real answer, not a retry loop', async () => {
  const prev = {};
  for (const k of SEED_STATE_KEYS) prev[k] = ST[k];
  try {
    resetSeedState();
    await runSeeds({ 'records.json': 404 });
    assert.ok(ST.records, 'a 404 means this deploy carries no records, which is a measurement');
    assert.equal(Object.keys(ST.records).length, 0, 'an answered "none" is {}, which is truthy, so it is never re-fetched');
  } finally { Object.assign(ST, prev); }
});

test('an unreadable crossing-status feed is unknown, never "no jurisdiction reports a closure"', async () => {
  const prev = {};
  for (const k of SEED_STATE_KEYS) prev[k] = ST[k];
  try {
    resetSeedState();
    await runSeeds({ 'crossing-status.json': 'reject' });
    assert.equal(ST.crossStatusUnknown, true, 'a cold client with no last-good knows nothing about jurisdiction closures');
    assert.equal(ST.crossStatus, null);

    // last-good survives a later blip, and the blip is then not an unknown either
    await runSeeds({});
    assert.equal(ST.crossStatusUnknown, false);
    await runSeeds({ 'crossing-status.json': 503 });
    assert.ok(ST.crossStatus && Array.isArray(ST.crossStatus.crossings), 'a transient failure keeps the last good rows');
    assert.equal(ST.crossStatusUnknown, false, 'and holding last-good is not the same as knowing nothing');
  } finally { Object.assign(ST, prev); }
});

test('an unreadable live shelter feed says so instead of listing curated shelters alone', async () => {
  const prev = {};
  for (const k of SEED_STATE_KEYS) prev[k] = ST[k];
  try {
    resetSeedState();
    await runSeeds({ 'shelters-live.json': 'reject' });
    assert.equal(ST.sheltersUnknown, true);
    assert.match(app.shlLiveUpdatedHtml(), /shl\.live\.unknown/, 'the shelter block must carry the reason');

    await runSeeds({});
    assert.equal(ST.sheltersUnknown, false);
    assert.doesNotMatch(app.shlLiveUpdatedHtml(), /shl\.live\.unknown/, 'a feed that answered raises no unknown note');
  } finally { Object.assign(ST, prev); }
});

test('the Roads tab names the jurisdiction feed instead of reporting an empty area', () => {
  const prev = {};
  for (const k of SEED_STATE_KEYS.concat(['roadsUnknown', 'roadClosures', 'roadsTabFp', 'myPos'])) prev[k] = ST[k];
  const el = { innerHTML: '', querySelectorAll: () => [] };
  const badge = { textContent: '' };
  const prevQ = SB.document.querySelector;
  const render = () => {
    ST.roadsTabFp = null;
    SB.document.querySelector = (s) => (s === '#crossings-body' ? el : s === '#roads-count' ? badge : prevQ(s));
    try { SB.renderRoadsTab(); } finally { SB.document.querySelector = prevQ; }
  };
  try {
    ST.crossings = []; ST.crossingsUnknown = false; ST.roadsUnknown = false;
    ST.roadClosures = { lines: [], points: [] }; ST.crossStatus = null; ST.myPos = null;

    ST.crossStatusUnknown = true;
    render();
    assert.match(el.innerHTML, /roads\.jurunknown/, 'a feed that did not answer must not render as "none reported"');
    assert.equal(badge.textContent, '?', 'and the badge may not assert a zero it never checked');

    ST.crossStatusUnknown = false;
    render();
    assert.match(el.innerHTML, /roads\.none/, 'non-vacuity: with every feed read, "none" is the honest empty state');
    assert.equal(badge.textContent, '0', 'and a measured zero shows as zero');
  } finally { SB.document.querySelector = prevQ; Object.assign(ST, prev); }
});

test('the three unknown-state strings exist in both languages and deny the zero reading', () => {
  for (const k of ['roads.jurunknown', 'shl.live.unknown', 'hydro.fcstfail', 'leg.wx.obs.iem.blank', 'hero.xing.unconf']) {
    for (const lang of ['en', 'es']) {
      const s = I18N[lang][k];
      assert.ok(typeof s === 'string' && s.length, `${lang} is missing ${k}`);
      assert.ok(!s.includes('—'), `em-dash in ${lang} ${k}`);
    }
    assert.notEqual(I18N.en[k], I18N.es[k], `${k} was never actually translated`);
  }
  assert.match(I18N.en['roads.jurunknown'], /not a report that crossings are clear/i);
  assert.match(I18N.en['shl.live.unknown'], /not a report that no shelters are open/i);
  assert.ok(I18N.en['hero.xing.unconf'].includes('{n}'), 'the hero sub must carry its count placeholder');
});

/* ================= tab badges: an unchecked zero is not a zero ================= */

test('the tab badges ship "?" so a source that never answered cannot read as zero', () => {
  const html = read('index.html');
  const tabs = html.slice(html.indexOf('<div class="tabs">'), html.indexOf('</div>', html.indexOf('<div class="tabs">')));
  for (const id of ['requests-count', 'alerts-count', 'gauges-count', 'roads-count']) {
    assert.match(tabs, new RegExp(`id="${id}">\\?</span>`), `${id} still ships a literal count before any data`);
  }
});

test('badgeText tells an unchecked zero from a measured one, and never hides a real count', () => {
  const { badgeText, BADGE_UNKNOWN } = app;
  assert.equal(BADGE_UNKNOWN, '?', 'the unknown marker is the one the hero cards already use');
  assert.equal(badgeText(0, false), '?', 'a zero from a source that did not answer is unknown');
  assert.equal(badgeText(0, true), '0', 'a zero that was measured is a real zero and must show');
  assert.equal(badgeText(4, true), '4');
  assert.equal(badgeText(4, false), '4', 'a partial count is still information; it is only the zero that lies');
});

test('markUnknownBadges puts the badges written elsewhere back to unknown', () => {
  const nodes = { '#alerts-count': { textContent: '0' }, '#requests-count': { textContent: '0' } };
  const prevQ = SB.document.querySelector;
  const prev = { alertsLoadedOnce: ST.alertsLoadedOnce, seedsLoadedOnce: ST.seedsLoadedOnce };
  SB.document.querySelector = (s) => (nodes[s] || prevQ(s));
  try {
    ST.alertsLoadedOnce = false;
    ST.seedsLoadedOnce = false;
    SB.markUnknownBadges();
    assert.equal(nodes['#alerts-count'].textContent, '?', 'a failed NWS fetch must not leave the shipped zero on screen');
    assert.equal(nodes['#requests-count'].textContent, '?');

    nodes['#alerts-count'].textContent = '0';
    ST.alertsLoadedOnce = true;
    SB.markUnknownBadges();
    assert.equal(nodes['#alerts-count'].textContent, '0', 'once alerts have loaded, zero open alerts is a measurement');
  } finally { SB.document.querySelector = prevQ; Object.assign(ST, prev); }
});

test('the gauges badge is unknown until the gauge feed answers', () => {
  const panels = read('js/panels.js');
  const fn = panels.match(/function renderGaugesTab\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'renderGaugesTab() not found');
  assert.match(fn[0], /badge\.textContent = badgeText\(inFloodAll\.length, state\.gauges\.length > 0\)/,
    'an empty gauge list is an unreadable feed, not a river running normal');
  // renderTiles is the one call every refresh path ends in, so the re-assert rides it
  assert.match(panels.match(/function renderTiles\(\)[\s\S]*?\n\}/)[0], /markUnknownBadges\(\);/);
  assert.match(read('js/boot.js'), /markUnknownBadges\(\); \/\//, 'a language switch repaints the badges too');
});

/* ================= curated crossings: one predicate, every consumer ================= */

const xAgo = (h, over) => Object.assign({
  name: `X-${h}h`, status: 'closed', lat: 30.1, lon: -97.8, reason: 'water over road',
  updated_at: new Date(Date.now() - h * 3600000).toISOString(),
}, over || {});

function withCrossings(list, fn) {
  const prev = { crossings: ST.crossings, crossingsUnknown: ST.crossingsUnknown, myPos: ST.myPos, gauges: ST.gauges, alerts: ST.alerts, cameras: ST.cameras };
  ST.crossings = list;
  ST.crossingsUnknown = false;
  ST.myPos = null;
  ST.gauges = [];
  ST.alerts = [];
  ST.cameras = null;
  try { return fn(); } finally { Object.assign(ST, prev); }
}

test('crossingList hands every consumer the confirmation verdict with the row', () => {
  withCrossings([xAgo(1), xAgo(200), xAgo(0, { updated_at: null })], () => {
    const rows = app.crossingList();
    assert.equal(rows.length, 3, 'nothing is dropped: a stale closure is still real information');
    assert.deepEqual(rows.map((c) => c.stale), [false, true, true]);
    assert.equal(rows[0].staleNote, '', 'a confirmed closure carries no age chip');
    assert.match(rows[1].staleNote, /cross\.stale/, 'an aged one names its age');
    assert.match(rows[2].staleNote, /xstatus\.nocheck/, 'and one with no stamp says there is no confirmation time');
    assert.equal(rows[1].name, 'X-200h', 'the row itself survives the annotation');
  });
});

test('Drive Mode shows a stale closure without ranking it as a confirmed one', () => {
  const rows = withCrossings([xAgo(200), xAgo(1, { name: 'Fresh crossing' })], () => app.driveItems());
  const stale = rows.find((r) => r.name === 'X-200h');
  const fresh = rows.find((r) => r.name === 'Fresh crossing');
  assert.ok(stale, 'a closure the curator has not restamped is still shown to the driver');
  assert.match(stale.sub, /cross\.stale/, 'and the row says how old the report is');
  assert.notEqual(stale.rank, 0, 'but it must not sit at the top rank a current closure holds');
  assert.equal(fresh.rank, 0, 'non-vacuity: a confirmed closure still leads');
  assert.doesNotMatch(fresh.sub, /cross\.stale/);
});

test('nearestCrossing hands the risk modal and the point inspector the same verdict', () => {
  withCrossings([xAgo(200)], () => {
    const hit = SB.nearestCrossing(30.1, -97.8, 12);
    assert.ok(hit, 'the nearest closure is still found');
    assert.equal(hit.c.stale, true, 'and it arrives marked, so neither surface can read it out as current');
    assert.match(hit.c.staleNote, /cross\.stale/);
  });
  withCrossings([xAgo(1)], () => {
    const hit = SB.nearestCrossing(30.1, -97.8, 12);
    assert.equal(hit.c.stale, false);
    assert.equal(hit.c.staleNote, '', 'non-vacuity: a fresh closure carries no qualifier');
  });
  // the three surfaces nearestCrossing feeds: the one-line read, the risk card, the map inspector
  const board = read('js/board.js');
  for (const site of [/parts\.push\(`\$\{t\('risk\.read\.crosspre'\)[^\n]*xCross\.c\.staleNote/,
    /class="risk-road"[\s\S]{0,220}?xCross\.c\.staleNote/,
    /class="inspect-line"><span style="color:\$\{st\.color\}[\s\S]{0,220}?xCross\.c\.staleNote/]) {
    assert.match(board, site, 'an xCross render site drops the confirmation qualifier');
  }
});

test('the crossings hero card counts only what the board can vouch for', () => {
  const card = (list) => withCrossings(list, () => app.heroCards().find((c) => c.key === 'xing'));
  const mixed = card([xAgo(1), xAgo(200), xAgo(300, { status: 'caution' }), xAgo(1, { status: 'open' })]);
  assert.equal(mixed.n, 1, 'two unconfirmed closures must not inflate the count beside Alerts and Gauges');
  assert.match(mixed.sub, /hero\.xing\.unconf/, 'and the card says how many it is not counting');

  const clean = card([xAgo(1), xAgo(2, { status: 'caution' })]);
  assert.equal(clean.n, 2);
  assert.equal(clean.sub, 'hero.xing.sub', 'non-vacuity: with nothing suppressed the card reads normally');

  const allStale = card([xAgo(200)]);
  assert.equal(allStale.n, 0, 'an all-stale file counts zero');
  assert.equal(allStale.tone, 'ok');
  assert.match(allStale.sub, /hero\.xing\.unconf/, 'but the zero is explained rather than left to read as clear');
});

/* Structural, because behaviour cannot prove the absence of a future consumer: state.crossings is
   written by loadSeeds and read by crossingList(), and nothing else may reach it un-annotated. */
test('every consumer of state.crossings goes through crossingList()', () => {
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const cut = (src, decl) => {
    const i = src.indexOf(decl);
    assert.ok(i >= 0, `declaration not found: ${decl}`);
    const j = src.indexOf('\n}', i);
    return src.slice(0, i) + src.slice(j);
  };
  // loadSeeds owns the write, crossingList owns the read, and playback paints an as-of-frame
  // historical view where each marker appears at its own updated_at under the frame's own caption
  const OWNERS = { 'panels.js': ['async function loadSeeds()', 'function crossingList()'], 'playback.js': ['function pbBuildCurated()'] };
  for (const f of fs.readdirSync(path.join(ROOT, 'js')).filter((n) => n.endsWith('.js'))) {
    let src = strip(read(`js/${f}`));
    assert.ok(/state\.crossings\b/.test(src) === Object.prototype.hasOwnProperty.call(OWNERS, f),
      `${f}: state.crossings is either owned here or read through crossingList(); update OWNERS deliberately`);
    for (const decl of (OWNERS[f] || [])) src = cut(src, decl);
    assert.doesNotMatch(src, /state\.crossings\b/,
      `${f} reads curated crossings directly; use crossingList(), which attaches the staleness verdict every consumer owes the reader`);
  }

  const panels = read('js/panels.js');
  for (const fn of ['function driveItems()', 'function heroCards()', 'function renderCrossings()', 'function roadsCuratedRows()']) {
    const body = panels.slice(panels.indexOf(fn), panels.indexOf('\n}', panels.indexOf(fn)));
    assert.ok(body.includes('crossingList()'), `${fn} must take its crossings from the annotated accessor`);
  }
  assert.match(read('js/board.js'), /function nearestCrossing\([\s\S]*?crossingList\(\)/);
});

/* ================= the hydrograph forecast trace ================= */

test('a forecast that did not answer is not drawn as an empty forecast', () => {
  const sources = read('js/sources.js');
  assert.doesNotMatch(sources, /catch\(\(\) => \(\{ data: \[\] \}\)\)/,
    'a failed forecast fetch must not become an empty series');
  const open = sources.slice(sources.indexOf('async function openHydro('), sources.indexOf('\n}', sources.indexOf('async function openHydro(')));
  assert.match(open, /stageflow\/forecast`\)\.catch\(\(\) => null\)/, 'null is the shape that stays distinguishable');
  assert.match(open, /drawHydro\(g, detail, obs\.data \|\| \[\], fcst\)/, 'and the verdict has to reach the renderer');

  const draw = sources.slice(sources.indexOf('function drawHydro('), sources.indexOf('\n}', sources.indexOf('function drawHydro(')));
  assert.match(draw, /const fcstFailed = !fcstRes/);
  assert.match(draw, /fcst\.length \? `<span class="hl"><i style="background:var\(--cat-major\)"><\/i>/,
    'the legend may only claim a forecast series when one was actually drawn');
  assert.match(draw, /fcstFailed \? `<span class="hl stale-note">\$\{esc\(t\('hydro\.fcstfail'\)\)\}/,
    'and it must name the failure rather than leave an empty chart under a full legend');
  // the sparkline is the path this mirrors; it must still hold the same shape
  assert.match(sources, /catch \{ note\.textContent = t\('spark\.unavail'\); \}/);
});

/* ================= radar: a computed timeline is not an observation ================= */

const mapApp = loadMapApp();
const MSB = mapApp._sandbox;
const MST = mapApp.state;

test('wxObsUnverified fires only when the fallback answered with nothing', () => {
  const { wxObsUnverified } = mapApp;
  assert.equal(wxObsUnverified(null), false);
  assert.equal(wxObsUnverified({ src: 'rainviewer', tileFail: true, tileOk: false }), false,
    'RainViewer publishes its own frame index; this is about the synthesized one');
  assert.equal(wxObsUnverified({ src: 'iem', tileFail: false, tileOk: false }), false,
    'still loading is not yet a failure; the legend must not flicker a warning on every enable');
  assert.equal(wxObsUnverified({ src: 'iem', tileFail: true, tileOk: false }), true,
    'tiles errored and none painted: the timeline is computed, unbacked, and must say so');
  assert.equal(wxObsUnverified({ src: 'iem', tileFail: true, tileOk: true }), false,
    'one painted tile makes it a real observation again, dropped frames aside');
});

function withRadarDom(fn) {
  const nodes = {};
  const node = (sel) => (nodes[sel] = nodes[sel] || {
    textContent: '', title: '', hidden: false, style: {},
    classList: { add() {}, remove() {}, toggle() {} },
  });
  const prevQ = MSB.document.querySelector;
  MSB.document.querySelector = (s) => node(s);
  try { return fn(node); } finally { MSB.document.querySelector = prevQ; }
}

test('the radar legend names the fallback that returned no imagery', () => {
  const prev = { radar: MST.radar, rtl: MST.rtl, map: MST.map, layers: MST.layers, fcst: MST.fcst };
  try {
    MST.map = { hasLayer: (l) => l === 'radar-group' };
    MST.layers = { radar: 'radar-group', fcstRadar: null };
    MST.rtl = { idx: 1, fut: false, hour: 1, playing: false };
    MST.fcst = { runIso: null, hourLayers: [], metaFail: false, tileOk: false };
    const frames = mapApp.iemRadarFrames(Date.now());
    const base = { src: 'iem', frames, castStart: frames.length, nowIdx: frames.length - 1, idx: 1, frameLayers: [] };

    withRadarDom((node) => {
      MST.radar = Object.assign({}, base, { tileFail: true, tileOk: false });
      MSB.rtlUpdateLabel(MSB.rtlDomain());
      assert.equal(node('#wx-legend-src').textContent, 'leg.wx.obs.iem.blank',
        'blank IEM tiles under a computed timeline must not read as observed clear sky');
      assert.equal(node('#rs-label').title, 'leg.wx.obs.iem.blank', 'the stamp itself carries the reason');

      MST.radar = Object.assign({}, base, { tileFail: true, tileOk: true });
      MSB.rtlUpdateLabel(MSB.rtlDomain());
      assert.equal(node('#wx-legend-src').textContent, 'leg.wx.obs.iem',
        'non-vacuity: a fallback that did paint is still the honest backup-source line');
      assert.equal(node('#rs-label').title, '');
    });
  } finally { Object.assign(MST, prev); }
});

test('the fallback frame set is watched, and only the fallback set', () => {
  const prev = { radar: MST.radar, rtl: MST.rtl, map: MST.map, layers: MST.layers };
  try {
    MST.map = { hasLayer: () => false };
    MST.layers = { radar: null, fcstRadar: null };
    MST.rtl = { idx: 0, fut: false, hour: 1, playing: false };
    const r = { src: 'iem', frames: [], frameLayers: [], tileOk: false, tileFail: false };
    MST.radar = r;
    const handlers = {};
    const layer = { on(ev, fn) { handlers[ev] = fn; } };
    withRadarDom(() => {
      MSB.watchRadarTiles(r, layer);
      assert.deepEqual(Object.keys(handlers).sort(), ['tileerror', 'tileload']);
      handlers.tileerror();
      assert.equal(r.tileFail, true, 'a 404 on a synthesized stamp is the failure signal');
      assert.equal(mapApp.wxObsUnverified(r), true);
      handlers.tileload();
      assert.equal(r.tileOk, true);
      assert.equal(mapApp.wxObsUnverified(r), false);
    });
    const fetchFrames = read('js/map.js');
    assert.match(fetchFrames, /if \(!d\) r\.frameLayers\.forEach\(\(l\) => watchRadarTiles\(r, l\)\)/,
      'only the synthesized frame set needs verifying; RainViewer states its own frame times');
  } finally { Object.assign(MST, prev); }
});
