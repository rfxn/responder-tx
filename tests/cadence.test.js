'use strict';

/* Contract 1: data/cadence.json tells the client how often the cycle publishes. Every surface that
   ages a cycle-published file ages it against intervalMin + 45 min when the file is valid, and keeps
   its fixed threshold when the file is missing or invalid (E1: missing is not "quiet"). Every test
   here RUNS the shipped model, view, renderer or loader. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, loadFullApp, loadHeaderStatus } = require('./harness.js');
const I18N = require('./i18n-load.js');
const CADENCE = require('./fixtures/cadence.json');

const app = loadApp();
const { state } = app;
const SB = app._sandbox;

const MIN = 60000;
const HOUR = 3600000;
const NOW = Date.parse('2026-11-23T23:30:00Z'); // 5:30 PM CT
const iso = (msAgo, now = NOW) => new Date(now - msAgo).toISOString().replace(/\.\d{3}Z$/, 'Z');
const QUIET = CADENCE;
const ADVERSE = { generated: iso(10 * MIN), mode: 'adverse', intervalMin: 60, since: iso(5 * HOUR),
  nextDueBy: iso(-50 * MIN), reasons: ['Flash Flood Warning (2)', 'Gauges in flood (3)', '<b>x</b>'] };

function withState(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) saved[k] = state[k];
  Object.assign(state, patch);
  try { return fn(); } finally { Object.assign(state, saved); }
}

function withCopy(fn, lang = 'en') {
  const prev = SB.t;
  SB.t = (k) => (I18N[lang] && k in I18N[lang] ? I18N[lang][k] : k);
  try { return fn(); } finally { SB.t = prev; }
}

const notes = (html) => [...html.matchAll(/<div class="sit-note([^"]*)">([^<]*)<\/div>/g)]
  .map((m) => ({ cls: m[1].trim(), text: m[2].replace(/&amp;/g, '&') }));

// every source checked in the same run that wrote the log, so only the log's own age can raise a note
const checked = (genAgo) => Object.fromEntries(['gauges', 'warnings', 'roads', 'crossings', 'roadrisk', 'shelters']
  .map((k) => [k, { src: k, at: iso(genAgo) }]));
const changes = (genAgo) => ({ generated: iso(genAgo), retainDays: 7, since: iso(72 * HOUR), sources: checked(genAgo), events: [] });
const wch = (cadence, genAgo) => withCopy(() => withState({ cadence, changes: changes(genAgo), changesAll: false, changesKind: '', pb: null },
  () => notes(SB.whatChangedView(SB.whatChangedModel(NOW)).html)));

test('the threshold follows a valid cadence and falls back to the fixed one otherwise', () => {
  withState({ cadence: null }, () => assert.equal(SB.cycleStaleMs(45 * MIN), 45 * MIN));
  withState({ cadence: QUIET }, () => assert.equal(SB.cycleStaleMs(45 * MIN), (720 + 45) * MIN));
  withState({ cadence: ADVERSE }, () => assert.equal(SB.cycleStaleMs(45 * MIN), 105 * MIN));
  const broken = [
    {}, 'quiet', { ...QUIET, mode: 'calm' }, { ...QUIET, intervalMin: '720' }, { ...QUIET, intervalMin: 0 },
    { ...QUIET, intervalMin: 100000 }, { ...QUIET, generated: 'soon' }, { ...QUIET, generated: 1763938080000 },
  ];
  for (const c of broken) {
    withState({ cadence: c }, () => assert.equal(SB.cycleStaleMs(45 * MIN), 45 * MIN, `accepted ${JSON.stringify(c)}`));
  }
});

test('What changed: six hours old is on schedule when quiet, stale with no cadence or when adverse', () => {
  const quiet = wch(QUIET, 6 * HOUR);
  assert.ok(!quiet.some((n) => n.cls === 'stale'), 'a quiet-mode log inside its 12h cadence is not stale');
  const none = wch(null, 6 * HOUR);
  assert.equal(none[0].cls, 'stale', 'no cadence keeps the fixed 45 min threshold');
  assert.ok(!none.some((n) => n.cls === 'cad'), 'no cadence, no schedule claim');
  const bad = wch({ ...QUIET, intervalMin: -1 }, 6 * HOUR);
  assert.equal(bad[0].cls, 'stale', 'an invalid cadence is not quiet');
  assert.equal(wch(ADVERSE, 2 * HOUR)[0].cls, 'stale', 'adverse ages past 105 min');
  assert.ok(!wch(ADVERSE, 90 * MIN).some((n) => n.cls === 'stale'));
});

test('What changed states the schedule and the next update, en and es', () => {
  const en = wch(QUIET, 20 * MIN).find((n) => n.cls === 'cad');
  assert.equal(en.text, 'Updated hourly during flood or severe weather, twice daily otherwise. Next update by Nov 24, 5:08 AM CT.');
  const es = withCopy(() => withState({ cadence: QUIET, changes: changes(20 * MIN), pb: null },
    () => notes(SB.whatChangedView(SB.whatChangedModel(NOW)).html)), 'es').find((n) => n.cls === 'cad');
  assert.ok(es.text.startsWith(I18N.es['cad.sched']), es.text);
  assert.ok(es.text.includes('Próxima actualización a más tardar: Nov 24, 5:08 AM CT.'), es.text);
});

test('adverse mode names its triggers, drops markup in them, and a missed update says so', () => {
  const line = wch(ADVERSE, 5 * MIN).find((n) => n.cls === 'cad').text;
  assert.ok(line.includes('Next update by 6:20 PM CT.'), line);
  assert.ok(line.endsWith('Hourly now: Flash Flood Warning (2), Gauges in flood (3).'), line);
  assert.ok(!line.includes('<b>') && !line.includes('&lt;'), 'a reason carrying markup is dropped');
  const late = { ...QUIET, nextDueBy: iso(2 * HOUR) };
  const text = withCopy(() => withState({ cadence: late }, () => SB.cadenceText(NOW)));
  assert.ok(text.endsWith('The update due by 3:30 PM CT has not arrived.'), text);
});

test('Situation: a live shelter file past its cadence is labelled a snapshot with its time', () => {
  const sit = (cadence, genAgo) => withCopy(() => withState({
    cadence, seedsLoadedOnce: true, sheltersUnknown: false,
    sheltersLive: { generated: new Date(Date.now() - genAgo).toISOString(), shelters: [{ name: 'Civic Center', status: 'open' }] },
    resources: { generated: new Date().toISOString(), shelters: [] },
  }, () => {
    const m = SB.situationModel();
    return { state: m.src.shelters, count: m.shelters, html: SB.situationView(m).html };
  }));
  const fresh = sit(null, 10 * MIN);
  assert.equal(fresh.state, 'ok');
  assert.equal(fresh.count, 1);
  const old = sit(null, 25 * 24 * HOUR);
  assert.equal(old.state, 'snapshot', 'a 25-day-old shelter file is not current');
  assert.equal(old.count, 1, 'the count still shows, badged rather than dropped');
  assert.ok(old.html.includes('Showing the published snapshot of shelter status from'), 'no date on an old shelter count');
  assert.equal(sit(QUIET, 6 * HOUR).state, 'ok', 'six hours is on schedule in quiet mode');
});

test('crest summary, recovery and basin heads flag a crest file past its cadence', () => {
  const old = { generated: new Date(Date.now() - 6 * 24 * HOUR).toISOString(), gauges: [] };
  const fresh = { generated: new Date(Date.now() - 5 * MIN).toISOString(), gauges: [] };
  withCopy(() => {
    withState({ cadence: null }, () => {
      assert.ok(SB.crestCurrencyHtml(old).includes('Not updated since'), 'a six-day-old crest summary must say so');
      assert.equal(SB.crestCurrencyHtml(fresh), '');
    });
    withState({ cadence: QUIET }, () => {
      assert.equal(SB.crestCurrencyHtml({ ...old, generated: new Date(Date.now() - 6 * HOUR).toISOString() }), '');
    });
  });
});

test('openCrestSummary paints the stale note above the table', async () => {
  const el = { innerHTML: '' };
  const view = { hidden: true };
  const prevQS = SB.document.querySelector;
  const prevFetch = SB.fetch;
  const prevT = SB.t;
  SB.t = (k) => (k in I18N.en ? I18N.en[k] : k);
  SB.document.querySelector = (sel) => (sel === '#summary-body' ? el : sel === '#summary-view' ? view : prevQS(sel));
  const body = { generated: new Date(Date.now() - 6 * 24 * HOUR).toISOString(), event: 'X', window: {},
    gauges: [{ lid: 'SGET2', name: 'Clear Creek near Sanger', peak: 12, peak_time: new Date().toISOString(), peak_category: 'minor', unit: 'ft' }] };
  SB.fetch = async () => ({ ok: true, status: 200, json: async () => body });
  try {
    await withState({ cadence: null }, () => SB.openCrestSummary());
    assert.ok(el.innerHTML.includes('class="sit-note stale sum-old"'), 'no stale note');
    assert.ok(el.innerHTML.indexOf('sum-old') < el.innerHTML.indexOf('<table'), 'the note leads the table');
  } finally {
    SB.t = prevT;
    SB.fetch = prevFetch;
    SB.document.querySelector = prevQS;
  }
});

test('the CalTopo status line dates the export and flags it past its cadence', () => {
  const p = (ago) => ({ generated: new Date(NOW - ago).toISOString() });
  withCopy(() => {
    withState({ cadence: null }, () => {
      assert.equal(SB.caltopoCurrencyText(p(10 * MIN), NOW), 'Published 5:20 PM CT.');
      assert.ok(SB.caltopoCurrencyText(p(3 * HOUR), NOW).startsWith('Not updated since 2:30 PM CT.'));
      assert.equal(SB.caltopoCurrencyText({}, NOW), '', 'an undated export makes no currency claim');
    });
    withState({ cadence: QUIET }, () => {
      const txt = SB.caltopoCurrencyText(p(3 * HOUR), NOW);
      assert.ok(txt.startsWith('Published 2:30 PM CT. Updated hourly'), txt);
    });
  });
});

test('loadCadence: 404 and junk fall back to fixed thresholds, a failed read keeps the last good copy', async () => {
  const prevFetch = SB.fetch;
  const answer = { status: 200, body: QUIET };
  SB.fetch = async () => ({ ok: answer.status === 200, status: answer.status, json: async () => answer.body });
  const saved = { cadence: state.cadence, cadenceAt: state.cadenceAt };
  try {
    await SB.loadCadence(true);
    assert.equal(state.cadence, QUIET);
    answer.status = 503;
    await SB.loadCadence(true);
    assert.equal(state.cadence, QUIET, 'a failed read keeps the last good cadence');
    answer.status = 200; answer.body = { mode: 'quiet' };
    await SB.loadCadence(true);
    assert.equal(state.cadence, null, 'an invalid file is not applied');
    answer.body = QUIET;
    await SB.loadCadence(true);
    answer.status = 404;
    await SB.loadCadence(true);
    assert.equal(state.cadence, null, 'an unpublished cadence is the fixed-threshold state');
  } finally {
    SB.fetch = prevFetch;
    Object.assign(state, saved);
  }
});

test('the gauge snapshot bar turns red past the cadence, and at 60 min with none', () => {
  const hdr = loadHeaderStatus();
  hdr.sandbox.t = (k) => k;
  const usgs = { addTo(m) { m.on.add(usgs); return usgs; } };
  const map = { on: new Set(), hasLayer: (l) => map.on.has(l), removeLayer: (l) => map.on.delete(l) };
  Object.assign(hdr.state, { alertsLoadedOnce: true, gauges: [], bootAt: Date.now() - 60000, map, layers: { usgs }, usgsSites: [] });
  const bar = hdr.node('#data-age-bar');
  const cls = (cadence, snapMins) => {
    hdr.state.cadence = cadence;
    hdr.state.snapshotAt = Date.now() - snapMins * MIN;
    hdr.state.sourceHealth = { gauges: Date.now() - 30 * MIN, alerts: Date.now() };
    bar.dataset.sig = '';
    hdr.sandbox.renderDataAgeBar();
    return bar.hidden ? 'hidden' : bar.className;
  };
  assert.equal(cls(null, 61), 'red', 'no cadence: the fixed hour still turns it red');
  assert.equal(cls(null, 45), 'amber');
  assert.equal(cls(QUIET, 180), 'amber', 'a snapshot inside the quiet cadence is late, not lost');
  assert.equal(cls(QUIET, 800), 'red');
  assert.equal(cls({ ...QUIET, mode: 'nope' }, 180), 'red', 'an invalid cadence is not quiet');
  assert.equal(cls(QUIET, 20), 'hidden', 'a fresh snapshot is still a working state');
});

test('adverse reasons render from reasonCodes in the reader language, skipping unknown codes', () => {
  const coded = { ...ADVERSE, reasons: ['Flash Flood Warning (2)'], reasonCodes: [
    { code: 'alert', event: 'Flash Flood Warning', n: 2 }, { code: 'gauges', n: 3 }, { code: 'probe' },
    { code: 'recent' }, { code: 'operator' }, { code: 'tsunami' }, { code: 'alert', event: '<b>x</b>', n: 1 }] };
  const line = (lang) => withCopy(() => withState({ cadence: coded }, () => SB.cadenceText(NOW)), lang);
  const want = (lang) => I18N[lang]['cad.adverse'].replace('{r}', [
    I18N[lang]['cad.r.alert'].replace('{event}', 'Flash Flood Warning').replace('{n}', '2'),
    I18N[lang]['cad.r.gauges'].replace('{n}', '3'),
    I18N[lang]['cad.r.probe'], I18N[lang]['cad.r.recent'], I18N[lang]['cad.r.operator']].join(', '));
  for (const lang of ['en', 'es']) {
    assert.ok(line(lang).endsWith(want(lang)), `${lang}: ${line(lang)}`);
    assert.ok(!line(lang).includes('tsunami') && !line(lang).includes('<b>'));
  }
  assert.ok(line('es').includes('Flash Flood Warning'), 'the NWS event name stays in English, as in What changed');
  for (const k of ['cad.r.alert', 'cad.r.gauges', 'cad.r.probe', 'cad.r.recent', 'cad.r.operator']) {
    for (const lang of ['en', 'es']) assert.ok(I18N[lang][k] && !I18N[lang][k].includes('—'), `${lang} ${k}`);
    assert.notEqual(I18N.en[k], I18N.es[k], `${k} was never actually translated`);
  }
  const fallback = (rc) => withCopy(() => withState({ cadence: { ...ADVERSE, reasonCodes: rc } }, () => SB.cadenceText(NOW)));
  for (const rc of [undefined, 'alert', [null], [{ n: 2 }]]) {
    assert.ok(fallback(rc).endsWith('Hourly now: Flash Flood Warning (2), Gauges in flood (3).'),
      `invalid reasonCodes ${JSON.stringify(rc)} must fall back to reasons`);
  }
});

/* The boot race: cadence.json lands after the first paint, so every surface that aged a file on the
   fixed 45 min threshold must repaint when it arrives, not on some later tick. Runs the whole page
   bundle with real renderers; only the DOM nodes and fetch are stand-ins. */
test('a cadence that arrives after the first paint clears every fixed-threshold stale claim', async () => {
  const full = loadFullApp();
  const FS = full._sandbox;
  const ST = full.state;
  const node = () => {
    const classes = new Set();
    return { innerHTML: '', textContent: '', hidden: false, dataset: {}, style: {},
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
        toggle: (c, on) => ((on === undefined ? !classes.has(c) : on) ? classes.add(c) : classes.delete(c)) },
      addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; } };
  };
  const nodes = new Map();
  const prev = { qs: FS.document.querySelector, fetch: FS.fetch, t: FS.t };
  FS.document.querySelector = (sel) => { if (!nodes.has(sel)) nodes.set(sel, node()); return nodes.get(sel); };
  const threeHours = new Date(Date.now() - 3 * HOUR).toISOString();
  const crest = { generated: threeHours, event: 'X', window: {}, gauges: [] };
  const bodies = {
    'crest-summary.json': { ...crest, gauges: [{ lid: 'A', name: 'A', peak: 1, peak_time: threeHours, peak_category: 'minor', unit: 'ft' }] },
    'caltopo-export.json': { properties: { generated: threeHours, counts: { Gauges: 5 }, truncated: false } },
    'cadence.json': { ...QUIET, generated: new Date().toISOString() },
  };
  FS.fetch = async (url) => {
    const hit = Object.keys(bodies).find((k) => String(url).includes(k));
    return { ok: !!hit, status: hit ? 200 : 404, json: async () => bodies[hit] };
  };
  FS.t = (k) => (k in I18N.en ? I18N.en[k] : k);
  const saved = { cadence: ST.cadence, cadenceAt: ST.cadenceAt, recoveryCrest: ST.recoveryCrest, basinCrest: ST.basinCrest };
  const settle = () => new Promise((r) => setImmediate(r));
  try {
    ST.cadence = null;
    Object.assign(ST, { alertsLoadedOnce: true, gauges: [], bootAt: Date.now() - 60000, usgsSites: [],
      snapshotAt: Date.now() - 3 * HOUR, sourceHealth: { gauges: Date.now() - 30 * MIN, alerts: Date.now() },
      recoveryCrest: crest, basinCrest: crest });
    await FS.openCrestSummary();
    FS.renderRecoveryBody(crest);
    FS.renderCaltopoStatus();
    FS.renderDataAgeBar();
    await settle();
    const stale = () => ({
      summary: /sum-old/.test(nodes.get('#summary-body').innerHTML),
      recovery: /sum-old/.test(nodes.get('#recovery-body').innerHTML),
      caltopo: nodes.get('#caltopo-status').textContent.includes('Not updated since'),
      bar: nodes.get('#data-age-bar').className,
    });
    assert.deepEqual(stale(), { summary: true, recovery: true, caltopo: true, bar: 'red' },
      'with no cadence the fixed thresholds call a three-hour-old file stale');
    await FS.loadCadence(true);
    await settle();
    assert.deepEqual(stale(), { summary: false, recovery: false, caltopo: false, bar: 'amber' },
      'the quiet cadence must repaint every surface that aged against the fixed threshold');
  } finally {
    FS.document.querySelector = prev.qs;
    FS.fetch = prev.fetch;
    FS.t = prev.t;
    Object.assign(ST, saved);
  }
});

test('a forecast gauge trigger never reads as gauges already in flood, en and es', () => {
  const line = (rc, lang) => withCopy(() => withState({ cadence: { ...ADVERSE, reasonCodes: [rc] } }, () => SB.cadenceText(NOW)), lang);
  for (const lang of ['en', 'es']) {
    const fcst = line({ code: 'gauges', n: 4, forecast: true }, lang);
    assert.ok(fcst.endsWith(I18N[lang]['cad.adverse'].replace('{r}', I18N[lang]['cad.r.gaugesfcst'].replace('{n}', '4'))), `${lang}: ${fcst}`);
    assert.ok(!fcst.includes(I18N[lang]['cad.r.gauges'].replace('{n}', '4')), `${lang}: forecast rendered as observed`);
    for (const rc of [{ code: 'gauges', n: 4 }, { code: 'gauges', n: 4, forecast: false }]) {
      assert.ok(line(rc, lang).includes(I18N[lang]['cad.r.gauges'].replace('{n}', '4')), `${lang}: observed lost its key`);
    }
    assert.ok(!I18N[lang]['cad.r.gaugesfcst'].includes('—'));
  }
  assert.notEqual(I18N.en['cad.r.gaugesfcst'], I18N.es['cad.r.gaugesfcst']);
});
