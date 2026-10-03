'use strict';

/* The Feed's "What changed" stream (data/changes.json, written by scripts/gen-changes.py). Every
   test here RUNS the shipped loader, model, view or renderer and asserts on what a reader would
   see or tap. The clock is fixed: the model takes `now`, so no fixture is bounded by the wall clock. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadMapApp } = require('./harness.js');
const I18N = require('./i18n-load.js');

const app = loadMapApp();
const { state, WCH_SHOWN } = app;
const SB = app._sandbox;

const NOW = Date.parse('2026-10-02T21:00:00Z'); // 4:00 PM CT
const iso = (msAgo) => new Date(NOW - msAgo).toISOString().replace(/\.\d{3}Z$/, 'Z');
const MIN = 60000;
const HOUR = 3600000;

function withState(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) saved[k] = state[k];
  Object.assign(state, patch);
  try { return fn(); } finally { Object.assign(state, saved); }
}

function withCopy(fn, lang = 'en') {
  const prev = SB.t;
  SB.t = (k) => (I18N[lang] && k in I18N[lang] ? I18N[lang][k] : (k in I18N.en ? I18N.en[k] : k));
  try { return fn(); } finally { SB.t = prev; }
}

function withStubs(stubs, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(stubs)) { saved[k] = SB[k]; SB[k] = v; }
  try { return fn(); } finally { Object.assign(SB, saved); }
}

const freshSources = (over) => {
  const base = {};
  for (const k of ['gauges', 'warnings', 'roads', 'crossings', 'roadrisk', 'shelters']) {
    base[k] = { src: k, at: iso(5 * MIN), since: iso(3 * 24 * HOUR) };
  }
  return Object.assign(base, over || {});
};

const payload = (events, over) => Object.assign({
  generated: iso(2 * MIN), retainDays: 7, since: iso(3 * 24 * HOUR), sources: freshSources(), events,
}, over || {});

const ev = (k, over) => Object.assign({ id: `${k}:${Math.random()}`, k, t: iso(30 * MIN), tk: 's', seen: iso(20 * MIN), src: 'x' }, over);

const EVENTS = {
  crest: ev('crest', { lid: 'CMFT2', name: 'Guadalupe River at Comfort', ft: 18.2, cat: 'moderate', lat: 29.97, lon: -98.9 }),
  crestUnc: ev('crest', { lid: 'BDAT2', name: 'Medina River at Bandera', ft: 21.4, cat: 'major', unc: true, lat: 29.72, lon: -99.07 }),
  enter: ev('flood', { lid: 'FCYT2', name: 'Atascosa River at Falls City', ft: 13.1, from: 'none', to: 'minor', lat: 28.98, lon: -98.02 }),
  up: ev('flood', { lid: 'FCYT2', name: 'Atascosa River at Falls City', ft: 17.6, from: 'minor', to: 'moderate', lat: 28.98, lon: -98.02 }),
  down: ev('flood', { lid: 'VICT2', name: 'Guadalupe River at Victoria', ft: 29.0, from: 'major', to: 'moderate', lat: 28.79, lon: -97.01 }),
  exit: ev('flood', { lid: 'ASHT2', name: 'Nueces River at Asherton', ft: 11.9, from: 'minor', to: 'none', after: iso(5 * HOUR), lat: 28.44, lon: -99.76 }),
  warnNew: ev('warn', { key: 'KEWX.FL.W.0052', act: 'new', ev: 'Flood Warning', sev: 'warning', areas: ['Victoria'], pt: 'Guadalupe River at Victoria', wfo: 'EWX' }),
  warnEmerg: ev('warn', { key: 'KFWD.FF.W.0092', act: 'new', ev: 'Flash Flood Warning', sev: 'emergency', areas: ['Tarrant', 'Dallas', 'Parker', 'Denton', 'Johnson'], more: 2, wfo: 'FWD' }),
  warnUp: ev('warn', { key: 'KFWD.FF.W.0091', act: 'up', ev: 'Flash Flood Warning', sev: 'emergency', areas: ['Tarrant'], wfo: 'FWD' }),
  warnAgain: ev('warn', { key: 'KHGX.FA.A.0006', act: 'new', again: true, ev: 'Flood Watch', sev: 'watch', areas: ['Harris'], wfo: 'HGX' }),
  warnExp: ev('warn', { key: 'KEWX.FA.Y.0001', act: 'end', how: 'exp', ev: 'Flood Warning', sev: 'warning', areas: ['Bexar'], wfo: 'EWX' }),
  warnCan: ev('warn', { key: 'KEWX.FF.W.0002', act: 'end', how: 'can', ev: 'Flash Flood Warning', sev: 'warning', areas: ['Kerr'] }),
  warnUpg: ev('warn', { key: 'KCRP.FA.A.0004', act: 'end', how: 'upg', ev: 'Flood Watch', sev: 'watch', areas: ['Nueces'], wfo: 'CRP' }),
  warnGone: ev('warn', { key: 'KSHV.FA.A.0007', act: 'end', how: 'gone', tk: 'd', ev: 'Flood Watch', sev: 'watch', areas: ['Bowie'], wfo: 'SHV', after: iso(90 * MIN) }),
  roadNew: ev('road', { key: 'US0090|a|b', act: 'new', route: 'US0090', cond: 'Flooding', near: '0.5 Miles West of FM1500 on US0090 at the low water crossing near the county line', lat: 29.4, lon: -99.1 }),
  roadEnd: ev('road', { key: 'FM1930|a|b', act: 'clear', how: 'end', route: 'FM1930', cond: 'Closure', lat: 27.69, lon: -98.07 }),
  roadGone: ev('road', { key: 'IH0002|a|b', act: 'clear', how: 'gone', tk: 'd', route: 'IH0002', cond: 'Flooding', after: iso(4 * HOUR), lat: 26.15, lon: -97.94 }),
  xingNew: ev('xing', { key: '2344', act: 'new', name: '1400 Blk Nature Heights Dr', status: 'closed', lat: 30.5, lon: -97.8 }),
  xingStatus: ev('xing', { key: '655', act: 'status', name: '1100 Blk Yett St.', status: 'caution', lat: 30.57, lon: -98.27 }),
  xingClear: ev('xing', { key: '773', act: 'clear', tk: 'd', name: '2600 Blk Commerce St', lat: 30.56, lon: -98.27 }),
  riskNew: ev('risk', { key: 'transtar:1074', act: 'new', tk: 'd', name: 'Walnut Creek @ Joseph Road', lat: 30.18, lon: -95.81 }),
  riskClear: ev('risk', { key: 'transtar:145', act: 'clear', tk: 'd', name: 'JF13-3', lat: 29.81, lon: -94.33 }),
  shelterNew: ev('shelter', { key: 's1', act: 'new', tk: 'd', name: 'Kerrville Civic Center', status: 'OPEN', lat: 30.05, lon: -99.14 }),
  shelterStatus: ev('shelter', { key: 's1', act: 'status', tk: 'd', name: 'Kerrville Civic Center', status: 'FULL', lat: 30.05, lon: -99.14 }),
  shelterClear: ev('shelter', { key: 's2', act: 'clear', tk: 'd', name: 'Comfort ISD Gym', lat: 29.97, lon: -98.9 }),
};

const rowsOf = (html) => [...html.matchAll(/<button type="button" class="wch-row([^"]*)" data-wch="(\d+)" style="[^"]*"(?: title="([^"]*)")?><span class="wch-time">([\s\S]*?)<\/span><span class="wch-text">([\s\S]*?)<\/span><span class="wch-meta">([\s\S]*?)<\/span><\/button>/g)]
  .map((m) => ({ cls: m[1], i: Number(m[2]), title: m[3] || '', time: decode(m[4]), text: decode(m[5]), meta: decode(m[6]) }));
const notes = (html) => [...html.matchAll(/<div class="sit-note([^"]*)">([\s\S]*?)<\/div>/g)].map((m) => ({ cls: m[1].trim(), text: decode(m[2]) }));
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function view(events, over, statePatch) {
  return withState(Object.assign({ changes: payload(events, over), changesUnknown: false, changesAll: false, changesKind: '', pb: null }, statePatch || {}),
    () => SB.whatChangedView(SB.whatChangedModel(NOW)));
}
const textFor = (e, lang = 'en') => withCopy(() => rowsOf(view([e]).html)[0], lang);
const toneOf = (e) => (view([e]).html.match(/--sit-tone:([^"]+)"/) || [])[1];

/* ---------------- sentences: every kind, both languages ---------------- */

test('gauge transitions read as sitrep lines with the stage and the NWS/USGS citation', () => {
  assert.equal(textFor(EVENTS.crest).text, '◆ Guadalupe River at Comfort crested, highest reading 18.2 ft',
    'a peak sampled once a cycle is a highest reading, never claimed as the exact crest');
  assert.equal(textFor(EVENTS.crest).meta, 'NWS/USGS gauges · moderate');
  assert.equal(textFor(EVENTS.crest).time, '3:30 PM', 'a source-timed event shows the bare CT clock');
  const unc = textFor(EVENTS.crestUnc);
  assert.equal(unc.text, '◆ Medina River at Bandera crested, highest reading 21.4 ft');
  assert.ok(unc.meta.includes('readings incomplete around the crest'), unc.meta);
  assert.ok(!textFor(EVENTS.crest).meta.includes('incomplete'), 'only the uncertain crest carries the caveat');
  assert.equal(textFor(EVENTS.enter).text, '▲ Atascosa River at Falls City entered minor flood stage at 13.1 ft');
  assert.equal(textFor(EVENTS.up).text, '▲ Atascosa River at Falls City rose to moderate flood stage at 17.6 ft');
  assert.equal(textFor(EVENTS.down).text, '▼ Guadalupe River at Victoria fell to moderate flood stage at 29 ft');
  const exit = textFor(EVENTS.exit);
  assert.equal(exit.text, '▼ Nueces River at Asherton fell below flood stage at 11.9 ft');
  assert.equal(exit.meta, 'NWS/USGS gauges · previous reading 11:00 AM', 'a reading gap names the bracket it happened in');
});

test('NWS products name the product, the place and the issuing office, and every lifecycle step has its own words', () => {
  assert.equal(textFor(EVENTS.warnNew).text, '⚠ Flood Warning issued for Guadalupe River at Victoria', 'the river point outranks the county list');
  assert.equal(textFor(EVENTS.warnNew).meta, 'NWS EWX');
  assert.equal(textFor(EVENTS.warnEmerg).text,
    '⚠ Flash Flood Warning issued as a FLASH FLOOD EMERGENCY for Tarrant, Dallas, Parker +4 more',
    'three areas are named and the rest counted, including the ones the generator already folded');
  assert.equal(textFor(EVENTS.warnUp).text, '⚠ Flash Flood Warning upgraded to a FLASH FLOOD EMERGENCY for Tarrant');
  assert.equal(textFor(EVENTS.warnAgain).text, '⚠ Flood Watch listed again for Harris');
  assert.equal(textFor(EVENTS.warnExp).text, '✓ Flood Warning expired for Bexar');
  assert.equal(textFor(EVENTS.warnCan).text, '✓ Flash Flood Warning cancelled for Kerr');
  assert.equal(textFor(EVENTS.warnCan).meta, 'NWS', 'no office named is plain NWS, never "NWS undefined"');
  assert.equal(textFor(EVENTS.warnUpg).text, '✓ Flood Watch for Nueces replaced by an upgraded product');
  const gone = textFor(EVENTS.warnGone);
  assert.equal(gone.text, '○ Flood Watch no longer listed by NWS for Bowie, no cancellation received',
    'an absence is not an end: no check mark and no claim that the product is over');
  assert.equal(toneOf(EVENTS.warnGone), 'var(--ink-muted)', 'a disappearance wears the neutral tone, not the good-news one');
  assert.equal(toneOf(EVENTS.warnCan), 'var(--good)', 'a real cancellation keeps the good-news tone');
  assert.equal(gone.time, 'as of 3:30 PM');
  assert.equal(gone.meta, 'NWS SHV · last listed 2:30 PM');
});

test('roads, crossings, TranStar risk and shelters each say what changed and who reported it', () => {
  const rn = textFor(EVENTS.roadNew);
  assert.equal(rn.text, '🌊 US 90: Flooded / high water');
  assert.ok(rn.meta.startsWith('TxDOT DriveTexas · 0.5 Miles West of FM1500'), rn.meta);
  assert.ok(rn.meta.endsWith('…') && rn.meta.length < 90, 'a long TxDOT limit is trimmed on a word');
  const re = textFor(EVENTS.roadEnd);
  assert.equal(re.text, '✓ FM 1930 cleared from the TxDOT closure list');
  assert.equal(re.meta, `TxDOT DriveTexas · posted end time · ${I18N.en['reopen.cleared']}`);
  const rg = textFor(EVENTS.roadGone);
  assert.equal(rg.time, 'as of 3:30 PM', 'a disappearance carries no source time and says so');
  assert.ok(rg.cls.includes('wch-det'));
  assert.equal(rg.title, I18N.en['wch.det.title']);
  assert.ok(rg.meta.endsWith('last listed 12:00 PM'), 'the gap before a source recovered stays visible');
  assert.equal(textFor(EVENTS.xingNew).text, '⛔ 1400 Blk Nature Heights Dr reported closed');
  assert.equal(textFor(EVENTS.xingNew).meta, 'ATX Floods');
  assert.equal(textFor(EVENTS.xingStatus).text, '⚠ 1100 Blk Yett St. now reported caution');
  assert.equal(textFor(EVENTS.xingClear).text, '✓ 2600 Blk Commerce St no longer on the closure list');
  const rk = textFor(EVENTS.riskNew);
  assert.equal(rk.text, '🌊 Roadway flooding risk flagged near Walnut Creek @ Joseph Road');
  assert.ok(!/clos/i.test(rk.text), 'a TranStar risk area is never worded as a closure');
  assert.equal(rk.meta, 'Houston TranStar');
  assert.equal(textFor(EVENTS.riskClear).text, '✓ Roadway flooding risk no longer flagged near JF13-3');
  assert.equal(textFor(EVENTS.shelterNew).text, '🏠 Shelter listed open: Kerrville Civic Center');
  assert.equal(textFor(EVENTS.shelterStatus).text, '🏠 Kerrville Civic Center shelter now full');
  assert.equal(textFor(EVENTS.shelterClear).text, '🏠 Comfort ISD Gym no longer listed as a shelter');
  assert.equal(textFor(EVENTS.shelterClear).meta, 'FEMA shelters');
});

test('every kind renders in Spanish with no key leaking through', () => {
  const all = Object.values(EVENTS);
  for (const lang of ['en', 'es']) {
    const html = withCopy(() => view(all).html, lang);
    assert.ok(!html.includes('wch.'), `${lang}: an untranslated wch.* key reached the page`);
    assert.equal(rowsOf(html).length, all.length > WCH_SHOWN ? WCH_SHOWN : all.length);
  }
  assert.equal(textFor(EVENTS.crest, 'es').text, '◆ Guadalupe River at Comfort alcanzó su cresta, lectura más alta 18.2 ft');
  assert.equal(textFor(EVENTS.warnGone, 'es').text, '○ Flood Watch ya no figura en la lista del NWS para Bowie, sin aviso de cancelación');
  assert.equal(textFor(EVENTS.warnNew, 'es').text, '⚠ Se emitió Flood Warning para Guadalupe River at Victoria');
  assert.equal(textFor(EVENTS.roadGone, 'es').time, 'al 3:30 PM');
  assert.equal(textFor(EVENTS.xingNew, 'es').text, '⛔ 1400 Blk Nature Heights Dr: estado cerrado');
  assert.equal(textFor(EVENTS.shelterNew, 'es').text, '🏠 Refugio en la lista (abierto): Kerrville Civic Center');
  const allEs = withCopy(() => view(all, null, { changesAll: true }).html, 'es');
  for (const r of rowsOf(allEs)) assert.ok(r.text.length > 4 && r.meta.length > 1, JSON.stringify(r));
});

/* ---------------- window, order, cap, scope ---------------- */

test('the default view is the last 24 hours by detection, newest first, capped, and the toggle opens the retained week', () => {
  const evs = [];
  for (let i = 0; i < 20; i++) evs.push(ev('crest', { id: `c${i}`, lid: `L${i}`, name: `Gauge ${i}`, ft: 10 + i, cat: 'minor', t: iso((i + 1) * 30 * MIN), seen: iso((i + 1) * 30 * MIN), lat: 29.5, lon: -98 }));
  evs.push(ev('crest', { id: 'old', lid: 'OLD', name: 'Old Gauge', ft: 30, cat: 'major', t: iso(3 * 24 * HOUR), seen: iso(3 * 24 * HOUR), lat: 29.5, lon: -98 }));
  // a source-dated change the pipeline saw only now still counts as recent
  evs.push(ev('road', { id: 'late', act: 'new', route: 'SH0016', cond: 'Closure', t: iso(30 * HOUR), seen: iso(10 * MIN), lat: 29.5, lon: -98 }));
  withCopy(() => {
    const m = withState({ changes: payload(evs.slice().reverse()), changesAll: false }, () => SB.whatChangedModel(NOW));
    assert.equal(m.recentN, 21, '20 recent crests plus the late-seen road');
    assert.equal(m.allN, 22);
    assert.equal(m.rows.length, WCH_SHOWN);
    assert.equal(m.rows[0].id, 'c0', 'newest event time first');
    const html = SB.whatChangedView(m).html;
    assert.ok(html.includes('Show all 22 from the last 7 days'), 'the toggle names how many the week holds');
    assert.ok(html.includes('Last 24 hours'));
    const open = withState({ changes: payload(evs), changesAll: true }, () => SB.whatChangedModel(NOW));
    assert.equal(open.rows.length, 22);
    assert.deepEqual(open.rows.slice(-2).map((e) => e.id), ['late', 'old'], 'chronology is by the source time, so a late-seen change sits at its own time');
    const openHtml = SB.whatChangedView(open).html;
    assert.ok(openHtml.includes('Show only the last 24 hours') && openHtml.includes('Last 7 days'));
  });
});

test('display scope narrows located events to the AO and never hides an unlocated warning', () => {
  const out = ev('flood', { lid: 'OUT', name: 'Ohio River at Somewhere', ft: 40, from: 'none', to: 'major', lat: 39.1, lon: -84.5 });
  const m = withState({ changes: payload([out, EVENTS.crest, EVENTS.warnNew]) }, () => SB.whatChangedModel(NOW));
  assert.deepEqual(m.rows.map((e) => e.lid || e.key).sort(), ['CMFT2', 'KEWX.FL.W.0052']);
});

test('malformed and unknown events are skipped, never thrown on and never counted', () => {
  const junk = [null, 7, 'x', {}, { k: 'crest' }, ev('crest', { name: 'No stage', cat: 'minor' }),
    ev('crest', { name: 'Bad cat', ft: 3, cat: 'none' }), ev('flood', { name: 'Same', ft: 3, from: 'minor', to: 'minor' }),
    ev('warn', { act: 'end', ev: 'Flood Warning', areas: ['X'] }), ev('warn', { act: 'new', ev: 'Flood Warning', areas: [] }),
    ev('road', { act: 'reopen', route: 'US0090' }), ev('xing', { act: 'new', name: 'X', status: 'open' }),
    ev('teleport', { name: 'Y' }), ev('crest', { name: 'Bad time', ft: 2, cat: 'minor', t: 'yesterday' }),
    ev('warn', { act: 'new', ev: 'Flood Warning', areas: 'Bexar' })];
  const { html } = withCopy(() => view(junk.concat([EVENTS.crest])));
  const rows = rowsOf(html);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].text.includes('Guadalupe River at Comfort'));
  assert.ok(!html.includes('Show all'), 'skipped junk is not counted toward the week either');
});

/* ---------------- honesty states (E1) ---------------- */

test('no payload yet is loading, a failed cold read is unknown, and neither renders a list or an all clear', () => {
  withCopy(() => {
    const loading = withState({ changes: null, changesUnknown: false }, () => SB.whatChangedView(SB.whatChangedModel(NOW)).html);
    assert.deepEqual(notes(loading), [{ cls: 'loading', text: 'Waiting for the change log' }]);
    const failed = withState({ changes: null, changesUnknown: true }, () => SB.whatChangedView(SB.whatChangedModel(NOW)).html);
    assert.deepEqual(notes(failed).map((n) => n.cls), ['failed']);
    assert.ok(/unknown, not absent/.test(notes(failed)[0].text));
    for (const h of [loading, failed]) assert.ok(!/No changes recorded/.test(h) && !rowsOf(h).length);
  });
});

test('a stale change log and a stale source each say so ahead of the list', () => {
  withCopy(() => {
    const roadsStale = freshSources({ roads: { src: 'txdot', at: iso(3 * HOUR), since: iso(3 * 24 * HOUR) } });
    const { html } = view([EVENTS.crest], { sources: roadsStale });
    const ns = notes(html);
    assert.equal(ns.length, 1);
    assert.equal(ns[0].cls, 'stale');
    assert.equal(ns[0].text, 'Not checked since 1:00 PM CT: TxDOT road closures. Changes there are paused, not absent.');
    assert.ok(html.indexOf('sit-note') < html.indexOf('wch-row'), 'the paused note leads the rows');

    const two = freshSources({ roads: { src: 'txdot', at: iso(3 * HOUR) }, shelters: { src: 'fema', at: iso(3 * HOUR) }, roadrisk: { src: 'transtar', at: null } });
    const tn = notes(view([], { sources: two }).html);
    assert.deepEqual(tn.map((n) => n.text), [
      'Not checked since 1:00 PM CT: TxDOT road closures and shelters. Changes there are paused, not absent.',
      'Not yet checked: Houston roadway flood risk. Changes there are unknown, not absent.',
      'No changes recorded in the last 24 hours',
    ], 'sources sharing a state share a line, and the empty line still follows the paused ones');

    const missing = freshSources();
    delete missing.crossings;
    assert.ok(notes(view([], { sources: missing }).html)[0].text.includes('low water crossings'),
      'a source the file does not describe is unknown, not current');

    const old = notes(view([EVENTS.crest], { generated: iso(2 * HOUR) }).html);
    assert.equal(old[0].cls, 'stale');
    assert.ok(old[0].text.startsWith('Not updated since 2:00 PM CT'), old[0].text);
  });
});

test('an empty window names when tracking began instead of implying a quiet day', () => {
  withCopy(() => {
    const young = notes(view([], { since: iso(2 * HOUR) }).html);
    assert.deepEqual(young.map((n) => n.text), ['No changes recorded since tracking began 2:00 PM CT']);
    const settled = notes(view([]).html);
    assert.deepEqual(settled.map((n) => n.text), ['No changes recorded in the last 24 hours']);
    const html = view([], {}, { pb: { live: false } }).html;
    assert.equal(notes(html)[0].text, I18N.en['playback.striplive'], 'playback says this panel is live');
  });
});

test('a row from another day carries its date', () => {
  const y = ev('crest', { lid: 'Y', name: 'Yesterday Gauge', ft: 5, cat: 'minor', t: iso(20 * HOUR), seen: iso(10 * MIN), lat: 29.5, lon: -98 });
  assert.equal(textFor(y).time, 'Oct 1, 8:00 PM');
});

/* ---------------- kind filter chips ---------------- */

const chipsOf = (html) => [...html.matchAll(/<button type="button" class="wch-chip( on)?" data-wch-kind="(\w+)" aria-pressed="(true|false)">([\s\S]*?) <span class="wch-n">(\d+)<\/span><\/button>/g)]
  .map((m) => ({ kind: m[2], on: !!m[1], label: decode(m[4]), n: Number(m[5]) }));

function mixedDay() {
  const out = [];
  const at = (i) => ({ t: iso((i + 1) * 10 * MIN), seen: iso((i + 1) * 10 * MIN) });
  for (let i = 0; i < 20; i++) out.push(ev(i % 2 ? 'road' : 'risk', Object.assign({ id: `rd${i}`, act: 'new', route: 'US0090', cond: 'Flooding', name: `Sensor ${i}`, lat: 29.7, lon: -95.4 }, at(i))));
  out.push(ev('xing', Object.assign({ id: 'x', act: 'new', name: 'Low Water 1', status: 'closed', lat: 30.3, lon: -97.7 }, at(2))));
  out.push(ev('crest', Object.assign({ id: 'cr', lid: 'CMFT2', name: 'Guadalupe River at Comfort', ft: 18.2, cat: 'moderate', lat: 29.97, lon: -98.9 }, at(3))));
  out.push(ev('flood', Object.assign({ id: 'fl', lid: 'FCYT2', name: 'Atascosa River at Falls City', ft: 13.1, from: 'none', to: 'minor', lat: 28.98, lon: -98.02 }, at(5))));
  out.push(ev('warn', Object.assign({ id: 'wn', key: 'KEWX.FL.W.0052', act: 'new', ev: 'Flood Warning', sev: 'warning', areas: ['Victoria'] }, at(7))));
  out.push(ev('road', { id: 'oldroad', act: 'clear', route: 'SH0016', cond: 'Closure', t: iso(3 * 24 * HOUR), seen: iso(3 * 24 * HOUR), lat: 29.5, lon: -98 }));
  return out;
}

test('chips count each kind inside the current window and hide an empty kind', () => {
  withCopy(() => {
    const day = view(mixedDay()).html;
    assert.deepEqual(chipsOf(day).map((c) => [c.kind, c.n, c.on]),
      [['all', 24, true], ['rivers', 2, false], ['nws', 1, false], ['roads', 21, false]],
      'twenty roads, risk areas and crossings would bury two river lines; the chips say how many of each there are');
    assert.ok(!chipsOf(day).some((c) => c.kind === 'shelters'), 'a kind with nothing in the window gets no chip');
    const week = view(mixedDay(), null, { changesAll: true }).html;
    assert.equal(chipsOf(week).find((c) => c.kind === 'roads').n, 22, 'the week view counts the week');
    const quietShelters = view(mixedDay(), null, { changesKind: 'shelters' }).html;
    assert.deepEqual(chipsOf(quietShelters).find((c) => c.kind === 'shelters'), { kind: 'shelters', on: true, label: 'Shelters', n: 0 },
      'the active chip stays even at zero, so the way back to All is never lost');
    assert.deepEqual(notes(quietShelters).map((n) => n.text), ['No shelter changes recorded in the last 24 hours']);
    const single = view([EVENTS.crest]).html;
    assert.equal(chipsOf(single).length, 0, 'a window holding one kind of change needs no filter');
  });
});

test('a busy road day cannot push river and NWS lines out of the capped list, which stays in time order', () => {
  withCopy(() => {
    const m = withState({ changes: payload(mixedDay()), changesAll: false, changesKind: '' }, () => SB.whatChangedModel(NOW));
    const ids = m.rows.map((e) => e.id);
    assert.equal(m.rows.length, WCH_SHOWN);
    for (const id of ['cr', 'fl', 'wn', 'x']) assert.ok(ids.includes(id), `${id} kept ahead of TranStar churn`);
    assert.deepEqual(m.rows.filter((e) => e.k === 'risk').map((e) => e.id), ['rd0'], 'risk areas only fill what is left, newest first');
    const times = m.rows.map((e) => Date.parse(e.t));
    assert.deepEqual(times, times.slice().sort((a, b) => b - a), 'the picks are still shown newest first');
    const open = withState({ changes: payload(mixedDay()), changesAll: true, changesKind: '' }, () => SB.whatChangedModel(NOW));
    assert.equal(open.rows.filter((e) => e.k === 'risk').length, 10, 'the full list holds every line');
  });
});

test('the 15-row cap applies after the filter, and the toggle counts the filtered week', () => {
  withCopy(() => {
    const rivers = withState({ changes: payload(mixedDay()), changesAll: false, changesKind: 'rivers' }, () => SB.whatChangedModel(NOW));
    assert.deepEqual(rivers.rows.map((e) => e.id), ['cr', 'fl']);
    const roads = withState({ changes: payload(mixedDay()), changesAll: false, changesKind: 'roads' }, () => SB.whatChangedModel(NOW));
    assert.equal(roads.rows.length, WCH_SHOWN);
    assert.ok(roads.rows.every((e) => ['road', 'xing', 'risk'].includes(e.k)));
    assert.ok(SB.whatChangedView(roads).html.includes('Show all 22 from the last 7 days'));
    const es = withCopy(() => view([], null, { changesKind: 'rivers' }).html, 'es');
    assert.deepEqual(notes(es).map((n) => n.text), ['No se registraron cambios de ríos en las últimas 24 horas']);
  });
});

/* ---------------- taps ---------------- */

test('a gauge row focuses that gauge, a warning row opens its alert, a road row frames its location', () => {
  const calls = [];
  const gauge = { lid: 'CMFT2', name: 'Guadalupe River at Comfort', latitude: 29.97, longitude: -98.9 };
  const alertF = { id: 'a1', properties: { event: 'Flood Warning', parameters: { VTEC: ['/O.CON.KEWX.FL.W.0052.000000T0000Z-000000T0000Z/'] } } };
  const map = { getZoom: () => 9, setView: (ll, z) => calls.push(['setView', ll, z]) };
  withStubs({
    focusGauges: (list, lead) => calls.push(['focusGauges', list.map((g) => g.lid), lead.lid]),
    openInAlertsList: (f) => calls.push(['openInAlertsList', f.id]),
    revealMapOnPhone: () => calls.push(['reveal']),
  }, () => withState({ gauges: [gauge], alerts: [alertF], map }, () => {
    const { acts } = view([EVENTS.crest, EVENTS.warnNew, EVENTS.roadNew, EVENTS.exit]);
    assert.equal(acts.length, 4);
    for (const a of acts) a();
  }));
  const plain = JSON.parse(JSON.stringify(calls));
  assert.equal(plain.filter((c) => c[0] === 'focusGauges').length, 1);
  assert.deepEqual(plain.find((c) => c[0] === 'focusGauges').slice(1), [['CMFT2'], 'CMFT2']);
  assert.equal(plain.filter((c) => c[0] === 'reveal').length, 2, 'each map pan also brings the map up on a phone');
  assert.deepEqual(calls.find((c) => c[0] === 'openInAlertsList'), ['openInAlertsList', 'a1']);
  assert.ok(calls.some((c) => c[0] === 'setView' && c[1][0] === 29.4 && c[2] === 13), 'road frames at street zoom');
  assert.ok(calls.some((c) => c[0] === 'setView' && c[1][0] === 28.44 && c[2] === 11), 'a gauge the board no longer lists still frames its spot');
});

test('a warning the board no longer carries opens the Alerts tab instead of nothing', () => {
  const clicked = [];
  const prevQS = SB.document.querySelector;
  SB.document.querySelector = (sel) => (sel === '.tabs button[data-tab="tab-alerts"]' ? { click: () => clicked.push(sel) } : prevQS(sel));
  try {
    withStubs({ openInAlertsList: () => assert.fail('no alert should match') }, () => withState({ alerts: [] }, () => {
      view([EVENTS.warnExp]).acts[0]();
    }));
  } finally { SB.document.querySelector = prevQS; }
  assert.equal(clicked.length, 1);
});

/* ---------------- renderer + loader ---------------- */

function trackedEl() {
  const listeners = [];
  return { innerHTML: '', listeners, addEventListener(type, fn) { listeners.push([type, fn]); } };
}

test('renderFeedChanges paints the section, wires one listener, and the toggle repaints through it', () => {
  const el = trackedEl();
  const prevQS = SB.document.querySelector;
  SB.document.querySelector = (sel) => (sel === '#feed-changes' ? el : prevQS(sel));
  const now = Date.now();
  const at = (ago) => new Date(now - ago).toISOString();
  const evs = [];
  for (let i = 0; i < 18; i++) evs.push({ id: `r${i}`, k: 'risk', act: 'new', tk: 'd', name: `Sensor ${i}`, t: at((i + 1) * MIN), seen: at((i + 1) * MIN), src: 'transtar', lat: 29.8, lon: -95.4 });
  try {
    withState({ changes: { generated: at(MIN), since: at(48 * HOUR), sources: {}, events: evs }, changesUnknown: false, changesAll: false, wchActs: [], pb: null }, () => {
      SB.renderFeedChanges();
      assert.equal(rowsOf(el.innerHTML).length, WCH_SHOWN);
      assert.equal(state.wchActs.length, WCH_SHOWN);
      SB.renderFeedChanges();
      assert.equal(el.listeners.length, 1, 'a repaint never stacks a second listener');
      const [, onClick] = el.listeners[0];
      onClick({ target: { closest: (sel) => (sel === '[data-wch-more]' ? {} : null) } });
      assert.equal(state.changesAll, true);
      assert.equal(rowsOf(el.innerHTML).length, 18, 'the toggle opens every retained row');
    });
    const mixed = [
      { id: 'cr', k: 'crest', lid: 'CMFT2', name: 'Guadalupe River at Comfort', ft: 18.2, cat: 'moderate', t: at(5 * MIN), tk: 's', seen: at(4 * MIN), src: 'nwps', lat: 29.97, lon: -98.9 },
    ].concat(evs);
    const clickKind = (g) => el.listeners[0][1]({ target: { closest: (sel) => (sel === '[data-wch-kind]' ? { getAttribute: () => g } : null) } });
    withCopy(() => withState({ changes: { generated: at(MIN), since: at(48 * HOUR), sources: {}, events: mixed }, changesUnknown: false, changesAll: false, changesKind: '', wchActs: [], pb: null }, () => {
      SB.renderFeedChanges();
      assert.equal(rowsOf(el.innerHTML).length, WCH_SHOWN);
      clickKind('rivers');
      assert.equal(state.changesKind, 'rivers');
      const rows = rowsOf(el.innerHTML);
      assert.equal(rows.length, 1, 'the chip repaints with only the river line');
      assert.ok(rows[0].text.includes('Guadalupe River at Comfort'));
      assert.equal(state.wchActs.length, 1, 'tap actions follow the filtered rows');
      clickKind('rivers');
      assert.equal(state.changesKind, '', 'tapping the active chip returns to All');
      assert.equal(rowsOf(el.innerHTML).length, WCH_SHOWN);
      clickKind('all');
      assert.equal(state.changesKind, '');
    }));
  } finally { SB.document.querySelector = prevQS; }
});

test('loadChanges keeps the last good copy through a failure and is unknown only when cold', async () => {
  const good = payload([EVENTS.crest]);
  const answer = { body: good, status: 200 };
  const prevFetch = SB.fetch;
  const saved = { changes: state.changes, changesUnknown: state.changesUnknown, changesAt: state.changesAt };
  SB.fetch = async () => ({ ok: answer.status === 200, status: answer.status, json: async () => answer.body });
  try {
    state.changes = null; state.changesUnknown = false; state.changesAt = 0;
    await SB.loadChanges(true);
    assert.equal(state.changes, good);
    assert.equal(state.changesUnknown, false);
    answer.status = 503;
    await SB.loadChanges(true);
    assert.equal(state.changes, good, 'a failed refresh keeps what the reader already has');
    assert.equal(state.changesUnknown, false);
    answer.status = 200; answer.body = { error: 'nope' };
    await SB.loadChanges(true);
    assert.equal(state.changes, good, 'a body without events is a failed read, not an empty log');
    state.changes = null; answer.status = 503;
    await SB.loadChanges(true);
    assert.equal(state.changes, null);
    assert.equal(state.changesUnknown, true, 'cold and failed is unknown, never "no changes"');
    let hits = 0;
    SB.fetch = async () => { hits++; return { ok: true, status: 200, json: async () => good }; };
    state.changesAt = Date.now();
    await SB.loadChanges(false);
    assert.equal(hits, 0, 'the refresh tick does not refetch inside the throttle window');
    await SB.loadChanges(true);
    assert.equal(hits, 1);
  } finally {
    SB.fetch = prevFetch;
    Object.assign(state, saved);
  }
});

/* ---------------- review fixes ---------------- */

test('a road condition named after an Object property falls back to the generic label, never a prototype', () => {
  const odd = ev('road', { key: 'X|a|b', act: 'new', route: 'US0090', cond: 'constructor', lat: 29.4, lon: -99.1 });
  assert.equal(withCopy(() => rowsOf(view([odd]).html)[0]).text, `🚧 US 90: ${I18N.en['road.cond.other']}`);
  assert.ok(!/undefined|function/.test(toneOf(odd) || 'missing'), toneOf(odd));
});

test('a change log not published yet reads as starting, a failed one as unknown', async () => {
  const prevFetch = SB.fetch;
  const saved = { changes: state.changes, changesUnknown: state.changesUnknown, changesAt: state.changesAt, changesMissing: state.changesMissing };
  let status = 404;
  SB.fetch = async () => ({ ok: status === 200, status, json: async () => ({}) });
  try {
    state.changes = null; state.changesUnknown = false; state.changesAt = 0;
    await SB.loadChanges(true);
    const starting = withCopy(() => notes(SB.whatChangedView(SB.whatChangedModel(NOW)).html));
    assert.deepEqual(starting.map((n) => n.text), [I18N.en['wch.starting']]);
    assert.ok(/15 minutes/.test(I18N.en['wch.starting']) && I18N.es['wch.starting']);
    status = 503;
    await SB.loadChanges(true);
    const failed = withCopy(() => notes(SB.whatChangedView(SB.whatChangedModel(NOW)).html));
    assert.deepEqual(failed.map((n) => n.cls), ['failed'], 'a server error is not the not-yet-published case');
  } finally {
    SB.fetch = prevFetch;
    Object.assign(state, saved);
  }
});

function weekOf(n, now) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const at = new Date(now - (i + 1) * 30 * MIN).toISOString();
    out.push({ id: `w${i}`, k: 'risk', act: 'new', key: `transtar:${i}`, tk: 'd', name: `Sensor ${i}`, t: at, seen: at, src: 'transtar', lat: 29.8, lon: -95.4 });
  }
  return out;
}

test('the full week renders a page at a time, so thousands of lines cannot freeze the board', () => {
  const el = trackedEl();
  const prevQS = SB.document.querySelector;
  SB.document.querySelector = (sel) => (sel === '#feed-changes' ? el : prevQS(sel));
  const now = Date.now();
  const page = (sel) => ({ target: { closest: (s) => (s === sel ? {} : null) } });
  try {
    withCopy(() => withState({ changes: { generated: new Date(now - MIN).toISOString(), since: null, sources: {}, events: weekOf(250, now) },
      changesUnknown: false, changesAll: true, changesKind: '', wchActs: [], pb: null }, () => {
      SB.renderFeedChanges();
      assert.equal(rowsOf(el.innerHTML).length, 100, 'the week opens on its first hundred lines');
      assert.ok(el.innerHTML.includes('data-wch-page'), 'with a way to the next hundred');
      el.listeners[0][1](page('[data-wch-page]'));
      assert.equal(rowsOf(el.innerHTML).length, 200);
      el.listeners[0][1](page('[data-wch-page]'));
      assert.equal(rowsOf(el.innerHTML).length, 250);
      assert.ok(!el.innerHTML.includes('data-wch-page'), 'no next-page control once every line is shown');
    }));
  } finally { SB.document.querySelector = prevQS; }
});

test('a repaint with nothing new does not rebuild the section, and a filter change does', () => {
  const el = trackedEl();
  const prevQS = SB.document.querySelector;
  const prevView = SB.whatChangedView;
  let builds = 0;
  SB.document.querySelector = (sel) => (sel === '#feed-changes' ? el : prevQS(sel));
  SB.whatChangedView = (m) => { builds++; return prevView(m); };
  const now = Date.now();
  try {
    withState({ changes: { generated: new Date(now - MIN).toISOString(), since: null, sources: {}, events: weekOf(40, now) },
      changesUnknown: false, changesAll: false, changesKind: '', wchActs: [], pb: null }, () => {
      SB.renderFeedChanges();
      SB.renderFeedChanges();
      SB.renderFeedChanges();
      assert.equal(builds, 1, 'renderTiles runs this on every repaint; an unchanged log must cost nothing');
      assert.equal(state.wchActs.length, WCH_SHOWN, 'the tap actions of the painted rows are kept');
      el.listeners[0][1]({ target: { closest: (s) => (s === '[data-wch-more]' ? {} : null) } });
      assert.equal(builds, 2, 'a filter change still repaints');
    });
  } finally {
    SB.document.querySelector = prevQS;
    SB.whatChangedView = prevView;
  }
});

test('rendering a page of lines builds no date formatter per row', () => {
  const names = ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'];
  const saved = names.map((n) => Date.prototype[n]);
  let calls = 0;
  names.forEach((n, i) => { Date.prototype[n] = function (...a) { calls++; return saved[i].apply(this, a); }; });
  try {
    const m = withState({ changes: payload(weekOf(120, NOW)), changesAll: true, changesKind: '' }, () => SB.whatChangedModel(NOW));
    const html = SB.whatChangedView(m).html;
    assert.equal(rowsOf(html).length, 100);
    assert.equal(calls, 0, 'formatters are built once at load, not three per row');
  } finally {
    names.forEach((n, i) => { Date.prototype[n] = saved[i]; });
  }
});
