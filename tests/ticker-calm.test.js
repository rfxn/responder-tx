'use strict';

/* The hazard line with nothing on it (owner, 2026-11-24). The rail used to hide when tickerItems()
   was empty, so on a quiet day it vanished and read as a removed feature. It now stays up with one
   muted, static line: a calm statement when the NWS alerts read answered recently, "checking" before
   the first answer, "could not be checked" once a round failed or the answer went stale (E1), and
   the On the horizon item that is next when the outlook carries an elevated or high one. With a
   hazard on the line the marquee is untouched. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, loadFullApp } = require('./harness.js');
const I18N = require('./i18n-load.js');

const app = loadApp();
const SB = app._sandbox;
const { state, CONFIG, alertSeverity } = app;

const NOW = Date.now();
const ISO = (ms) => new Date(ms).toISOString();
const ROUND = CONFIG.refreshMs;
const ANSWERED = NOW - 60e3;
// the oracle for the stamp: Central time, as every other clock on the board prints it
const CT = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
const CALM_EN = (ms) => `No tornado, severe thunderstorm, flood or tropical warnings in Texas · as of ${CT(ms)} CT`;
const CALM_ES = (ms) => `Sin avisos de tornado, tormenta eléctrica severa, inundación ni ciclón tropical en Texas · al ${CT(ms)} CT`;

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'alerts-tx-flood-warnings.json'), 'utf8'));
const AHEAD = ISO(NOW + 6 * 3600e3);
const WARNING = (() => {
  const c = JSON.parse(JSON.stringify(FIX.floodWarnings[0]));
  c._sev = alertSeverity(c.properties);
  if (c.properties.ends) c.properties.ends = AHEAD;
  if (c.properties.expires) c.properties.expires = AHEAD;
  return c;
})();

const item = (id, level, en, es, startH, endH) => ({
  id, kind: 'temperature', level, title: { en, es }, body: { en: `${en}.`, es: `${es}.` },
  window: { start: ISO(NOW + startH * 3600e3), end: ISO(NOW + endH * 3600e3) },
  source: { name: 'NWS Weather Prediction Center', url: 'https://www.wpc.ncep.noaa.gov/' }, issued: ISO(NOW - 3600e3),
});
const outlook = (items) => ({ generated: ISO(NOW - 3600e3), validUntil: ISO(NOW + 12 * 3600e3), author: 'steward',
  headline: { en: 'Freeze ahead', es: 'Helada' }, items });
const FREEZE = item('tfs-freeze-d2', 'elevated', 'Hard freeze forecast Wednesday in West Texas',
  'Se pronostica helada fuerte el miércoles en el oeste de Texas', 20, 44);
const FIRE_LOW = item('tfs-fire', 'low', 'Low fire potential in East Texas this week',
  'Bajo potencial de incendios en el este de Texas esta semana', -2, 100);

// the three nodes renderTicker writes, recording what it leaves behind
function tickerDom() {
  const mk = () => {
    const cls = new Set();
    return { hidden: true, innerHTML: '', classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c),
      contains: (c) => cls.has(c), toggle() {} }, getBoundingClientRect: () => ({ bottom: 40 }), cls };
  };
  return { '#ticker': mk(), '#ticker-track': mk(), '#ticker-rest': mk() };
}

/* answered: when the alerts source last answered (null = never); failed: this round's verdict;
   round: whether a refresh round has completed; bootAgo: how long the page has been up */
function withTicker(opts, fn) {
  const { lang = 'en', answered = ANSWERED, failed = false, round = true, bootAgo = 30e3,
    out = null, pb = null, hazards = [] } = opts;
  const dom = tickerDom();
  const saved = { qs: SB.document.querySelector, t: SB.t, getLang: SB.getLang, reveal: SB.revealInList,
    setTimeout: SB.setTimeout, clearTimeout: SB.clearTimeout, state: { ...state } };
  const timers = [];
  SB.setTimeout = (f, ms) => { timers.push({ f, ms }); return timers.length; };
  SB.clearTimeout = () => {};
  const reveals = [];
  const edges = [];
  const style = SB.document.documentElement.style;
  saved.setProperty = style.setProperty;
  style.setProperty = (k, v) => { if (k === '--hazline-bottom') edges.push(v); };
  SB.document.querySelector = (sel) => dom[sel] || saved.qs(sel);
  SB.t = (k) => (k in I18N[lang] ? I18N[lang][k] : k);
  SB.getLang = () => lang;
  SB.revealInList = (tab, sel) => reveals.push({ tab, sel });
  Object.assign(state, {
    alerts: hazards, lsrs: [], gauges: [], gaugesDegraded: [], trendHist: {}, records: {},
    seedRequests: [], store: { added: [], overrides: {}, archived: [] }, gaugeMarkers: {}, inView: false,
    tickerActs: null, tickerHash: '', pb,
    alertsLoadedOnce: answered !== null,
    sourceFailed: { alerts: failed },
    sourceHealth: answered === null ? {} : { alerts: answered },
    refreshAt: round ? NOW + ROUND : undefined,
    bootAt: NOW - bootAgo,
    outlook: out,
  });
  try {
    SB.renderTicker();
    const track = dom['#ticker-track'].innerHTML;
    const text = track.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
    return fn({ dom, track, text, reveals, edges, timers, acts: state.tickerActs });
  } finally {
    style.setProperty = saved.setProperty;
    SB.setTimeout = saved.setTimeout; SB.clearTimeout = saved.clearTimeout;
    SB.document.querySelector = saved.qs; SB.t = saved.t; SB.getLang = saved.getLang; SB.revealInList = saved.reveal;
    for (const k of Object.keys(state)) if (!(k in saved.state)) delete state[k];
    Object.assign(state, saved.state);
  }
}

test('alerts answered, nothing acute: the rail stays up with the calm statement and its time', () => {
  withTicker({}, ({ dom, text, track, acts, edges }) => {
    assert.equal(dom['#ticker'].hidden, false, 'a quiet day must not hide the rail');
    assert.deepEqual(edges, ['40px'], 'the banner anchor follows the calm rail, not the header');
    assert.ok(dom['#ticker'].cls.has('calm'));
    assert.equal(text, CALM_EN(ANSWERED), 'stamped with the time the alerts source answered');
    assert.ok(!/ticker-marquee|ticker-reel/.test(track), 'the calm line is static, never a scrolling reel');
    assert.equal(dom['#ticker-rest'].innerHTML, '', 'and there is no second copy for reduced motion');
    assert.deepEqual([...acts], [], 'with nothing next there is nothing to tap');
    assert.ok(!/<button/.test(track), 'a line that does nothing is not offered as a button');
  });
});

test('the same, in Spanish', () => {
  withTicker({ lang: 'es' }, ({ text }) => {
    assert.equal(text, CALM_ES(ANSWERED));
  });
});

test('every class the calm line names is one the hazard line would have carried', () => {
  // the statement is only true if a warning of each kind it names would have put an item on the line
  const { hazardGlance, HAZARD_EVENTS } = app;
  for (const ev of ['Tornado Warning', 'Severe Thunderstorm Warning', 'Flash Flood Warning', 'Flood Warning',
    'Coastal Flood Warning', 'Tropical Storm Warning', 'Hurricane Warning', 'Storm Surge Warning']) {
    assert.ok(HAZARD_EVENTS[ev], `${ev} is not admitted at all`);
    assert.equal(hazardGlance({ properties: { event: ev } }), true, `${ev} would not reach the line, so "no ${ev}" is unproven`);
  }
  // and it never claims the classes the line leaves out, which are often active on a calm day
  for (const ev of ['Freeze Warning', 'Red Flag Warning', 'Flood Advisory', 'High Wind Warning',
    'Winter Storm Warning', 'Ice Storm Warning', 'Blizzard Warning']) {
    assert.ok(!(HAZARD_EVENTS[ev] && hazardGlance({ properties: { event: ev } })), `${ev} would reach the line`);
  }
  for (const lang of ['en', 'es']) assert.ok(!/freeze|helada|red flag|advisor|winter|invern|ice|hielo/i.test(I18N[lang]['ticker.calm']));
  // an ice storm is a storm the line never carries, so the claim names the thunderstorm, never a bare storm
  assert.match(I18N.en['ticker.calm'], /severe thunderstorm/);
  assert.ok(!/severe storm/.test(I18N.en['ticker.calm']));
  assert.match(I18N.es['ticker.calm'], /tormenta eléctrica severa/);
});

test('alerts failed this round: the line says so, stamped with the last answer, and is never calm', () => {
  withTicker({ failed: true }, ({ dom, text }) => {
    assert.equal(dom['#ticker'].hidden, false);
    assert.equal(text, `Warnings could not be checked since ${CT(ANSWERED)} CT`);
    assert.ok(!/No tornado/.test(text), 'E1: a failed read must never read as no warnings');
  });
  withTicker({ failed: true, lang: 'es' }, ({ text }) => {
    assert.equal(text, `No se han podido comprobar los avisos desde las ${CT(ANSWERED)} CT`);
  });
});

test('an answer older than two rounds is not calm, even with no failure recorded', () => {
  // a hung fetch never rejects and refreshBusy holds every later round, so sourceFailed stays false
  const old = NOW - 2 * ROUND - 60e3;
  withTicker({ answered: old }, ({ text }) => {
    assert.equal(text, `Warnings could not be checked since ${CT(old)} CT`);
  });
  withTicker({ answered: NOW - 2 * ROUND + 60e3 }, ({ text }) => assert.match(text, /^No tornado/, 'inside two rounds it is still calm'));
});

test('a calm line arms its own expiry, so it ages out with no other repaint', () => {
  withTicker({}, ({ dom, timers }) => {
    const t = timers[timers.length - 1];
    assert.ok(t, 'no timer was armed for the calm line');
    assert.ok(Math.abs(t.ms - (ANSWERED + 2 * ROUND - NOW + 1000)) < 5000, `armed for ${t.ms} ms`);
    state.sourceHealth.alerts = NOW - 3 * ROUND; // a phone resumed after the round hung
    t.f();
    assert.match(dom['#ticker-track'].innerHTML, /Warnings could not be checked since/);
  });
});

test('cold load: before the first round finishes the line is checking, not failed', () => {
  withTicker({ answered: null, round: false }, ({ text, timers }) => {
    assert.equal(text, 'Checking warnings…');
    assert.ok(timers.length, 'checking also gives up on its own if the first round hangs');
  });
  withTicker({ answered: null, round: false, lang: 'es' }, ({ text }) => assert.equal(text, 'Comprobando avisos…'));
});

test('never answered after a round completed, or after two rounds since boot: could not be checked', () => {
  withTicker({ answered: null }, ({ text }) => assert.equal(text, 'Warnings could not be checked'));
  withTicker({ answered: null, round: false, bootAgo: 2 * ROUND + 60e3 }, ({ text }) => {
    assert.equal(text, 'Warnings could not be checked', 'a first round that hangs must not read as checking forever');
  });
  withTicker({ answered: null, lang: 'es' }, ({ text }) => assert.equal(text, 'No se pudieron comprobar los avisos'));
});

test('alerts answered and an elevated item on the horizon: it rides along and the tap opens its card', () => {
  withTicker({ out: outlook([FIRE_LOW, FREEZE]) }, ({ text, track, acts, reveals }) => {
    assert.equal(text, `${CALM_EN(ANSWERED)} · Next: Hard freeze forecast Wednesday in West Texas (On the horizon)`);
    assert.match(track, /<button type="button" class="ticker-item ticker-calm" data-ti="0">/);
    assert.equal(acts.length, 1);
    acts[0](); // exactly what boot.js does with +it.dataset.ti
    assert.deepEqual(reveals, [{ tab: 'tab-requests', sel: '#feed-outlook [data-hzn="tfs-freeze-d2"]' }],
      'the tap lands on the Feed tab (which raises a phone sheet) and scrolls to that card');
  });
  withTicker({ out: outlook([FIRE_LOW, FREEZE]), lang: 'es' }, ({ text }) => {
    assert.equal(text, `${CALM_ES(ANSWERED)} · Próximo: Se pronostica helada fuerte el miércoles en el oeste de Texas (En el horizonte)`);
  });
});

test('a failed read keeps the horizon line, still without a calm claim', () => {
  withTicker({ failed: true, out: outlook([FREEZE]) }, ({ text }) => {
    assert.equal(text, `Warnings could not be checked since ${CT(ANSWERED)} CT · Next: Hard freeze forecast Wednesday in West Texas (On the horizon)`);
  });
});

test('only elevated or high items are named; a low one, a stale outlook or playback add nothing', () => {
  withTicker({ out: outlook([FIRE_LOW]) }, ({ text, acts }) => {
    assert.ok(!/Next/.test(text), 'a low item is not what is next');
    assert.equal(acts.length, 0);
  });
  const stale = { ...outlook([FREEZE]), validUntil: ISO(NOW - 60e3) };
  withTicker({ out: stale }, ({ text }) => assert.ok(!/Next/.test(text), 'past validUntil the outlook says nothing'));
  withTicker({ out: outlook([FREEZE]), pb: { live: false } }, ({ text }) => {
    assert.ok(!/Next/.test(text), 'playback shows a past frame, so a forecast about now does not belong beside it');
  });
});

test('an acute warning puts the rail back on the marquee, unchanged, and the calm line comes back after', () => {
  withTicker({ hazards: [WARNING], out: outlook([FREEZE]) }, ({ dom, track, acts, edges }) => {
    assert.ok(!dom['#ticker'].cls.has('calm'));
    assert.deepEqual(edges, ['40px'], 'the marquee path publishes the anchor too');
    assert.match(track, /^<div class="ticker-marquee"><div class="ticker-reel" style="animation-duration:20s">/);
    assert.equal((track.match(/class="ticker-run"/g) || []).length, 2, 'the seamless loop is still two runs');
    assert.ok(!/ticker-calm|Next:/.test(track), 'no calm text rides on a live hazard');
    assert.match(dom['#ticker-rest'].innerHTML, /data-ti="0"/, 'the reduced-motion list is back');
    assert.equal(acts.length, 1);
    state.alerts = []; // the warning ends
    SB.renderTicker();
    assert.ok(dom['#ticker'].cls.has('calm'), 'and once it ends the calm line returns');
    assert.match(dom['#ticker-track'].innerHTML, /Next: Hard freeze/);
  });
});

/* E1 end to end: refresh() is where a failed source is recorded, and the ticker has to be repainted
   after that verdict, or a calm line written mid-round would outlive the failure it never saw. */
test('a refresh round whose alerts read fails leaves the line saying so', async () => {
  const full = loadFullApp();
  const sb = full._sandbox;
  const dom = tickerDom();
  const rawQs = sb.document.querySelector;
  sb.document.querySelector = (sel) => dom[sel] || rawQs(sel);
  const ok = () => Promise.resolve();
  for (const k of ['fetchGauges', 'fetchFcstMax', 'fetchUsgsIv', 'fetchLsrs', 'loadSeeds', 'fetchRoadClosures',
    'fetchRoadFlood', 'loadChanges', 'loadCadence', 'loadOutlook', 'hydrateGaugesSnapshot']) sb[k] = ok;
  for (const k of ['setFeedNote', 'setFeedNoteHealthy', 'renderFeedSituation', 'renderSourceHealth', 'checkAppVersion',
    'saveCache', 'loadTides']) sb[k] = () => {};
  sb.hydrateFromCache = () => false;
  sb.fetchAlerts = () => Promise.reject(new Error('NWS alerts: HTTP 503'));
  sb.t = (k) => (k in I18N.en ? I18N.en[k] : k);
  Object.assign(full.state, { alerts: [], lsrs: [], gauges: [], seedRequests: [], store: { added: [], overrides: {}, archived: [] },
    layers: {}, map: { hasLayer: () => false }, alertsLoadedOnce: true, sourceFailed: {},
    sourceHealth: { alerts: Date.now() - 600e3 }, refreshBusy: false, refreshQueued: false, tickerHash: '' });
  await sb.refresh();
  assert.equal(full.state.sourceFailed.alerts, true);
  assert.match(dom['#ticker-track'].innerHTML, /Warnings could not be checked since /,
    'the line still claimed calm after the round recorded the alerts failure');
});
