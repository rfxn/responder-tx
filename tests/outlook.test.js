'use strict';

/* The Feed's "On the horizon" card (data/outlook.json, written by the steward). Every test RUNS the
   shipped model, view, renderer or loader. The contract under test: a missing, invalid or expired
   file renders nothing at all, never a "no hazards expected" line. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');
const I18N = require('./i18n-load.js');
const FIX = require('./fixtures/outlook.json');

const app = loadApp();
const { state } = app;
const SB = app._sandbox;

const NOW = Date.parse('2026-11-23T23:30:00Z'); // 5:30 PM CT, inside the fixture's validity
const clone = (o) => JSON.parse(JSON.stringify(o));

function withCopy(fn, lang = 'en') {
  const prev = { t: SB.t, getLang: SB.getLang };
  SB.t = (k) => (I18N[lang] && k in I18N[lang] ? I18N[lang][k] : k);
  SB.getLang = () => lang;
  try { return fn(); } finally { SB.t = prev.t; SB.getLang = prev.getLang; }
}

function withState(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) saved[k] = state[k];
  Object.assign(state, patch);
  try { return fn(); } finally { Object.assign(state, saved); }
}

const html = (d, now = NOW) => withCopy(() => SB.outlookView(SB.outlookModel(d, now), now));
const items = (h) => [...h.matchAll(/data-hzn="([^"]+)"/g)].map((m) => m[1]);

// the fixture moved so its generated stamp is "now", for the paths that read the wall clock
function liveFixture() {
  const shift = Date.now() - Date.parse(FIX.generated);
  const move = (iso) => new Date(Date.parse(iso) + shift).toISOString();
  const d = clone(FIX);
  d.generated = move(d.generated);
  d.validUntil = move(d.validUntil);
  for (const it of d.items) {
    it.window.start = move(it.window.start);
    it.window.end = move(it.window.end);
    it.issued = move(it.issued);
  }
  return d;
}

test('the fixture renders a titled card, highest level first, three items and a way to the rest', () => {
  const h = html(FIX);
  assert.ok(h.includes(I18N.en['hzn.title']), 'the card has no title');
  assert.ok(h.includes(FIX.headline.en), 'the headline is missing');
  assert.deepEqual(items(h), ['spc-fire-d1', 'wpc-ero-d2', 'spc-d2-severe'],
    'elevated items lead, and within a level the earlier window comes first');
  assert.ok(h.includes('data-hzn-more'), 'a fourth item needs a way to reach it');
  assert.ok(h.includes(I18N.en['hzn.more'].replace('{n}', '1')));
  const all = withState({ outlookAll: true }, () => html(FIX));
  assert.deepEqual(items(all), ['spc-fire-d1', 'wpc-ero-d2', 'spc-d2-severe', 'ama-freeze']);
  assert.ok(all.includes(I18N.en['hzn.less']));
});

test('each item carries its level chip, window, body, source link and upstream issue time', () => {
  const h = html(FIX);
  const ero = h.slice(h.indexOf('data-hzn="wpc-ero-d2"'), h.indexOf('data-hzn="spc-d2-severe"'));
  assert.ok(ero.includes(`>${I18N.en['hzn.lvl.elevated']}<`), 'level chip missing');
  assert.ok(ero.includes('Slight risk of excessive rainfall, Southeast Texas'));
  assert.ok(ero.includes('Heavy rain could flood low-lying roads'));
  assert.ok(ero.includes('href="https://www.wpc.ncep.noaa.gov/qpf/excessive_rainfall_outlook_ero.php"'));
  assert.ok(ero.includes('target="_blank" rel="noopener"'));
  assert.ok(ero.includes('>NWS Weather Prediction Center<'));
  assert.ok(ero.includes('issued 2:39 PM CT'), 'the issue time is the upstream one, in CT');
  assert.ok(ero.includes('Nov 24, 6:00 AM CT to Nov 25, 6:00 AM CT'), 'a future window names both ends');
  const fire = h.slice(h.indexOf('data-hzn="spc-fire-d1"'), h.indexOf('data-hzn="wpc-ero-d2"'));
  assert.ok(fire.includes('now until 9:00 PM CT'), 'a window already open says so');
});

test('missing, malformed and expired outlooks render nothing at all', () => {
  const cases = {
    missing: null,
    notObject: 'outlook',
    noItems: Object.assign(clone(FIX), { items: undefined }),
    tooMany: Object.assign(clone(FIX), { items: Array(7).fill(FIX.items[0]) }),
    badGenerated: Object.assign(clone(FIX), { generated: 'yesterday' }),
    noValidUntil: Object.assign(clone(FIX), { validUntil: undefined }),
    empty: Object.assign(clone(FIX), { items: [] }),
  };
  for (const [name, d] of Object.entries(cases)) {
    assert.equal(html(d), '', `${name} must render nothing`);
  }
  assert.equal(html(FIX, Date.parse(FIX.validUntil) + 1), '', 'past validUntil the card is suppressed');
  assert.notEqual(html(FIX, Date.parse(FIX.validUntil) - 1), '', 'up to validUntil it still shows');
});

test('an item that breaks the contract is dropped, and a file left with none renders nothing', () => {
  const bad = (patch) => {
    const d = clone(FIX);
    d.items = [Object.assign(clone(FIX.items[1]), patch)];
    return html(d);
  };
  const dropped = {
    hostileLink: { source: { name: 'x', url: 'javascript:alert(1)' } },
    plainHttp: { source: { name: 'x', url: 'http://example.com/' } },
    noIssued: { issued: undefined },
    badKind: { kind: 'volcano' },
    badLevel: { level: 'extreme' },
    noSpanish: { title: { en: 'Only English' } },
    html: { body: { en: '<img src=x onerror=alert(1)>', es: 'x' } },
    emDash: { title: { en: 'Rain — heavy', es: 'Lluvia' } },
    tooLong: { body: { en: 'x'.repeat(281), es: 'x' } },
    backwards: { window: { start: '2026-11-25T12:00:00Z', end: '2026-11-24T12:00:00Z' } },
  };
  for (const [name, patch] of Object.entries(dropped)) assert.equal(bad(patch), '', `${name} must not render`);

  const mixed = clone(FIX);
  mixed.items[0].source.url = 'javascript:alert(1)';
  assert.deepEqual(items(html(mixed)), ['spc-fire-d1', 'wpc-ero-d2', 'ama-freeze'], 'the valid items still show');
});

test('an item whose window has closed is no longer on the horizon', () => {
  const after = Date.parse('2026-11-24T03:00:01Z');
  assert.ok(!items(html(FIX, after)).includes('spc-fire-d1'));
  assert.ok(items(html(FIX, after)).includes('wpc-ero-d2'));
});

test('nothing the card can render claims that no hazards are expected', () => {
  for (const lang of ['en', 'es']) {
    for (const k of Object.keys(I18N[lang]).filter((x) => x.startsWith('hzn.'))) {
      assert.ok(!/no hazards|nothing expected|ningún peligro|no se esperan/i.test(I18N[lang][k]), `${lang} ${k}`);
      assert.ok(!I18N[lang][k].includes('—'), `em-dash in ${lang} ${k}`);
    }
  }
});

test('in Spanish the card reads the es strings and the es chrome', () => {
  const h = withCopy(() => SB.outlookView(SB.outlookModel(FIX, NOW), NOW), 'es');
  assert.ok(h.includes(I18N.es['hzn.title']));
  assert.ok(h.includes(FIX.headline.es));
  assert.ok(h.includes('Riesgo leve de lluvia excesiva, sureste de Texas'));
  assert.ok(h.includes(`>${I18N.es['hzn.lvl.elevated']}<`));
  assert.ok(h.includes('emitido 2:39 PM CT'));
  assert.ok(!h.includes('Slight risk of excessive rainfall'), 'no English item text leaks into es');
});

function trackedEl() {
  const listeners = [];
  return { innerHTML: '', listeners, addEventListener(type, fn) { listeners.push([type, fn]); } };
}

test('renderFeedOutlook paints the card, wires one listener, and the toggle reveals the rest', () => {
  const el = trackedEl();
  const prevQS = SB.document.querySelector;
  SB.document.querySelector = (sel) => (sel === '#feed-outlook' ? el : prevQS(sel));
  try {
    withCopy(() => withState({ outlook: liveFixture(), outlookAll: false, pb: null }, () => {
      SB.renderFeedOutlook();
      assert.equal(items(el.innerHTML).length, 3);
      SB.renderFeedOutlook();
      assert.equal(el.listeners.length, 1, 'a repaint never stacks a second listener');
      el.listeners[0][1]({ target: { closest: (sel) => (sel === '[data-hzn-more]' ? {} : null) } });
      assert.equal(state.outlookAll, true);
      assert.equal(items(el.innerHTML).length, 4);
      state.outlook = null;
      SB.renderFeedOutlook();
      assert.equal(el.innerHTML, '', 'a payload that goes away takes the card with it');
    }));
  } finally { SB.document.querySelector = prevQS; }
});

test('loadOutlook: 404 is no card, a failed read keeps the last good copy, junk shows nothing', async () => {
  const el = trackedEl();
  const prevQS = SB.document.querySelector;
  const prevFetch = SB.fetch;
  const answer = { status: 200, body: liveFixture() };
  SB.document.querySelector = (sel) => (sel === '#feed-outlook' ? el : prevQS(sel));
  SB.fetch = async () => ({ ok: answer.status === 200, status: answer.status, json: async () => answer.body });
  const saved = { outlook: state.outlook, outlookAt: state.outlookAt, outlookAll: state.outlookAll };
  const prevT = SB.t;
  SB.t = (k) => (k in I18N.en ? I18N.en[k] : k);
  try {
    state.outlookAll = false;
    await SB.loadOutlook(true);
    assert.equal(items(el.innerHTML).length, 3);
    const good = state.outlook;
    answer.status = 503;
    await SB.loadOutlook(true);
    assert.equal(state.outlook, good, 'a failed refresh keeps what the reader already has');
    assert.equal(items(el.innerHTML).length, 3);
    answer.status = 404;
    await SB.loadOutlook(true);
    assert.equal(state.outlook, null);
    assert.equal(el.innerHTML, '', 'an unpublished outlook is a quiet absence');
    answer.status = 200; answer.body = { items: 'nope' };
    await SB.loadOutlook(true);
    assert.equal(el.innerHTML, '', 'an invalid file renders nothing');
  } finally {
    SB.t = prevT;
    SB.fetch = prevFetch;
    SB.document.querySelector = prevQS;
    Object.assign(state, saved);
  }
});

test('a file claiming validity more than 48 hours past its generation renders nothing (E4)', () => {
  const span = (h) => Object.assign(clone(FIX), { validUntil: new Date(Date.parse(FIX.generated) + h * 3600000).toISOString() });
  assert.notEqual(html(span(48)), '', 'exactly 48 hours is inside the bound');
  assert.equal(html(span(48.01)), '', 'past 48 hours the file is outside the contract');
  assert.equal(html(span(24 * 30)), '', 'a month-long validity would keep a stale outlook alive');
});
