'use strict';

/* The Feed's generated situation section. The owner's report was that the Feed no longer carried
   the advisories and situation lines it used to, because those had been hand-written by sessions
   that no longer run. These tests CALL the shipped model, view and renderer against a real NWS
   capture and assert on what a reader would see and tap, including the two states E1 cares about:
   a source that has not answered is "loading", a source that failed is "unavailable", and neither
   may ever render as a zero or as the calm line. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, loadFullApp } = require('./harness.js');
const I18N = require('./i18n-load.js');

const app = loadApp();
const { state, alertOpen, _sandbox: SB } = app;
// sandbox values carry the vm realm's prototypes, so structural comparison goes through JSON
const plain = (v) => JSON.parse(JSON.stringify(v));

/* tests/fixtures/alerts-tx-flood-products.json: every Texas product live on 2026-10-02, verbatim but
   for trimmed prose. Its times are shifted so the capture instant is "now", which keeps every product
   in effect whenever this suite runs: shipped data is never bounded against the wall clock. */
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'alerts-tx-flood-products.json'), 'utf8'));
const TIME_KEYS = ['sent', 'effective', 'onset', 'expires', 'ends'];
function liveAlerts(mutate) {
  const shift = Date.now() - Date.parse(FIX.captured);
  const move = (iso) => (iso ? new Date(Date.parse(iso) + shift).toISOString() : iso);
  return FIX.features.map((src) => {
    const f = JSON.parse(JSON.stringify(src));
    for (const k of TIME_KEYS) f.properties[k] = move(f.properties[k]);
    const ee = f.properties.parameters.eventEndingTime;
    if (Array.isArray(ee)) f.properties.parameters.eventEndingTime = ee.map(move);
    if (mutate) mutate(f);
    f._sev = SB.alertSeverity(f.properties);
    return f;
  });
}
const vtecOf = (f) => (f.properties.parameters.VTEC || []).join(' ');

const isoIn = (h) => new Date(Date.now() + h * 3600000).toISOString();
function gauge(lid, name, cat, obs, fc) {
  return {
    lid, name, latitude: 29.5, longitude: -97.5,
    status: {
      observed: { primary: obs, floodCategory: cat, validTime: isoIn(-0.25) },
      forecast: fc ? { primary: fc.ft, floodCategory: fc.cat, validTime: isoIn(fc.inH) } : { primary: -999, floodCategory: 'fcst_not_current', validTime: '0001-01-01T00:00:00Z' },
    },
  };
}
// two readings 45 minutes apart, so gaugeTrend reports a direction
const trend = (from, to) => [[Date.now() - 50 * 60000, from], [Date.now() - 5 * 60000, to]];

const GAUGES = [
  gauge('VICT2', 'Guadalupe River at Victoria', 'major', 31.2),
  gauge('CUET2', 'Guadalupe River at Cuero', 'minor', 26.4),
  gauge('BOQT2', 'Rio Grande at Boquillas Crossing', 'moderate', 18.1),
  gauge('JUNT2', 'Devils River near Juno', 'no_flooding', 3.2),
  gauge('AMAT2', 'Canadian River at Amarillo', 'no_flooding', 3.9, { ft: 7.5, cat: 'minor', inH: 16 }),
  gauge('TILT2', 'Nueces River near Tilden', 'minor', 10.8, { ft: 23.1, cat: 'major', inH: 6 }),
];
const TRENDS = { VICT2: trend(30.6, 31.2), CUET2: trend(27.2, 26.4) };
const RECORDS = { TILT2: { record_ft: 25.1, record_date: '1919-09-15' } };

const quietBase = () => ({
  alerts: [], gauges: [gauge('JUNT2', 'Devils River near Juno', 'no_flooding', 3.2)], gaugesDegraded: [],
  roadClosures: { lines: [], points: [] }, roadsUnknown: false, roadsFallbackAt: null, snapshotAt: null,
  alertsLoadedOnce: true, seedsLoadedOnce: true, sheltersUnknown: false,
  sheltersLive: { generated: new Date().toISOString(), shelters: [] }, resources: { generated: new Date().toISOString(), shelters: [] },
  sourceHealth: { alerts: Date.now() - 60000, gauges: Date.now() - 120000, roads: Date.now() - 90000 },
  sourceFailed: {}, trendHist: {}, records: {}, pb: null,
});

function withState(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) saved[k] = state[k];
  Object.assign(state, patch);
  try { return fn(); } finally { Object.assign(state, saved); }
}

const withBoard = (patch, fn) => withState(Object.assign(quietBase(), patch), fn);

// the harness echoes keys; this puts the shipped sentences on screen so assertions read real copy
function withCopy(fn, lang = 'en') {
  const prev = SB.t;
  SB.t = (k) => (I18N[lang] && I18N[lang][k]) || k;
  try { return fn(); } finally { SB.t = prev; }
}

function withStubs(stubs, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(stubs)) { saved[k] = SB[k]; SB[k] = v; }
  try { return fn(); } finally { Object.assign(SB, saved); }
}

const cards = (html) => [...html.matchAll(/<button type="button" class="sit-card[^"]*" data-sit="(\d+)"[^>]*><span class="sit-card-title">([\s\S]*?)<\/span>(?:<span class="sit-card-sub">([\s\S]*?)<\/span>)?<\/button>/g)]
  .map((m) => ({ i: Number(m[1]), title: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), sub: (m[3] || '') }));
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/* ---------------- NWS products: one card per event type, standing tier included ---------------- */

test('alerts group into one card per event type, acute first and the standing tier kept, flood before non-flood', () => {
  const alerts = liveAlerts();
  withBoard({ alerts }, () => withCopy(() => {
    const m = SB.situationModel();
    const events = plain(m.groups.map((g) => g.event));
    assert.deepEqual(events.slice(0, 3), ['Flash Flood Warning', 'Flood Warning', 'Flood Watch'],
      'warnings lead, watches follow');
    assert.deepEqual(events.slice(3).sort(), ['Coastal Flood Advisory', 'Flood Advisory', 'High Wind Warning'],
      'the advisories the owner asked for are in the picture');
    assert.equal(events[events.length - 1], 'High Wind Warning',
      'a non-flood standing product sits after the flood advisories, not among them');
    const n = Object.fromEntries(m.groups.map((g) => [g.event, g.n]));
    assert.deepEqual(n, { 'Flash Flood Warning': 3, 'Flood Warning': 4, 'Flood Watch': 5, 'Flood Advisory': 5,
      'Coastal Flood Advisory': 1, 'High Wind Warning': 1 });
    const watch = m.groups.find((g) => g.event === 'Flood Watch');
    assert.ok(watch.areas.includes('Denton') && watch.areas.includes('Parker'),
      'the KFWD watch arrives as two segments sharing one VTEC; it counts once and names both');
    const coastal = m.groups.find((g) => g.event === 'Coastal Flood Advisory');
    assert.deepEqual(Array.from(coastal.areas), ['Southern Orange'], 'the Louisiana zone is counted, not named');

    const { html } = SB.situationView(m);
    const shown = cards(html).map((c) => decode(c.title));
    assert.equal(shown.length, 6, 'six products, six cards: grouping is what keeps a busy day to a few lines');
    assert.ok(shown[0].includes('Flash Flood Warning 3'), shown[0]);
    assert.equal(shown[0].slice(0, 2), '🌊', 'a flood product carries the flood glyph');
    assert.equal(shown[shown.length - 1].slice(0, 1), '⚠', 'a wind warning does not borrow the flood glyph');
    assert.ok(shown.some((s) => s.includes('Flood Advisory 5')), shown.join(' | '));
    for (const head of ['alert.cls.acute', 'alert.cls.watch', 'alert.cls.standing']) {
      assert.ok(html.includes(`<div class="sit-subhead">${I18N.en[head]}</div>`), `missing class head ${head}`);
    }
    // the group says when it ends: the latest member end, in CT
    const ffw = cards(html)[0];
    const lastEnd = m.groups[0].list.map((f) => Date.parse(SB.alertEndsAt(f))).reduce((a, b) => Math.max(a, b));
    assert.ok(decode(ffw.sub).includes(`until ${new Date(lastEnd).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} CT`), ffw.sub);
  }));
});

test('an emergency in a group flags the card and takes the emergency tone', () => {
  const alerts = liveAlerts((f) => {
    if (vtecOf(f).includes('KFWD.FF.W.0091')) f.properties.parameters.flashFloodDamageThreat = ['CATASTROPHIC'];
  });
  withBoard({ alerts }, () => withCopy(() => {
    const m = SB.situationModel();
    assert.equal(m.groups[0].emergency, true);
    const { html } = SB.situationView(m);
    const first = html.slice(html.indexOf('<button'), html.indexOf('</button>'));
    assert.match(first, /--sit-tone:var\(--sev-emergency\)/);
    assert.match(first, /<span class="emergency-flag">EMERGENCY<\/span>/);
  }));
});

test('an expired product drops out of the picture rather than lingering as current', () => {
  const alerts = liveAlerts((f) => {
    if (f.properties.event === 'High Wind Warning') f.properties.ends = f.properties.expires = new Date(Date.now() - 60000).toISOString();
  });
  withBoard({ alerts }, () => {
    assert.ok(!SB.situationModel().groups.some((g) => g.event === 'High Wind Warning'));
  });
});

/* ---------------- rivers in flood, rising toward flood ---------------- */

test('gauges in flood group by river with the worst category, the count and the trend', () => {
  withBoard({ gauges: GAUGES, trendHist: TRENDS, records: RECORDS }, () => withCopy(() => {
    const m = SB.situationModel();
    assert.deepEqual(plain(m.rivers.map((r) => [r.river, r.cat, r.gauges.length])),
      [['Guadalupe River', 'major', 2], ['Rio Grande', 'moderate', 1], ['Nueces River', 'minor', 1]]);
    const g = m.rivers[0];
    assert.equal(g.worst.lid, 'VICT2');
    assert.deepEqual([g.rising, g.falling], [1, 1]);
    assert.ok(!m.rivers.some((r) => r.river === 'Devils River'), 'a river running normal is not in flood');

    const c = cards(SB.situationView(m).html).find((x) => x.title.includes('Guadalupe River'));
    assert.equal(decode(c.title), '● Guadalupe River · MAJOR');
    assert.equal(decode(c.sub), '2 gauges in flood · at Victoria 31.2 ft · 1 rising · 1 falling');
  }));
});

test('rising toward flood lists each gauge, soonest crest first, with the crest and its record context', () => {
  withBoard({ gauges: GAUGES, trendHist: TRENDS, records: RECORDS }, () => withCopy(() => {
    const m = SB.situationModel();
    assert.deepEqual(m.rising.map((x) => x.lid), ['TILT2', 'AMAT2'], 'soonest crest first');
    const rows = cards(SB.situationView(m).html).filter((x) => x.title.startsWith('▲'));
    assert.equal(decode(rows[0].title), '▲ Nueces River near Tilden → MAJOR');
    assert.ok(decode(rows[0].sub).startsWith('now 10.8 ft · crest 23.1 ft '), rows[0].sub);
    assert.ok(decode(rows[0].sub).endsWith('⚑ record 25.1 ft (1919); forecast 2 ft below'), rows[0].sub);
    assert.equal(decode(rows[1].title), '▲ Canadian River at Amarillo → MINOR');
  }));
});

/* ---------------- the calm line, and E1 ---------------- */

test('the calm line renders only when nothing is active and every source answered', () => {
  withBoard({}, () => withCopy(() => {
    const m = SB.situationModel();
    assert.equal(m.quiet, true);
    const { html } = SB.situationView(m);
    assert.ok(html.includes(`<div class="sit-quiet">✓ ${I18N.en['sit.quiet']}</div>`));
    assert.ok(html.includes('<span class="sit-asof">as of '), 'the calm line carries the as-of time');
  }));
  const notCalm = [
    ['alerts not answered yet', { alertsLoadedOnce: false }],
    ['alerts failed this round over an empty last-good list', { sourceFailed: { alerts: true } }],
    ['no gauge loaded', { gauges: [] }],
    ['road closures unknown', { roadsUnknown: true }],
    ['road closures not loaded', { roadClosures: null }],
    ['a gauge in flood', { gauges: [gauge('CUET2', 'Guadalupe River at Cuero', 'minor', 26.4)] }],
    ['a flood advisory', { alerts: liveAlerts().filter((f) => f.properties.event === 'Flood Advisory') }],
  ];
  for (const [label, patch] of notCalm) {
    withBoard(patch, () => withCopy(() => {
      const m = SB.situationModel();
      assert.equal(m.quiet, false, label);
      assert.ok(!SB.situationView(m).html.includes('sit-quiet'), `${label}: the calm line rendered`);
    }));
  }
});

test('E1: an alerts source that failed renders as unavailable, never as zero products or calm', () => {
  // a cold client: the alert fetch failed and the device cache handed back a stale list
  const cached = liveAlerts();
  withBoard({ alertsLoadedOnce: false, sourceFailed: { alerts: true }, alerts: cached }, () => withCopy(() => {
    const m = SB.situationModel();
    assert.equal(m.src.alerts, 'failed');
    assert.equal(m.groups.length, 0, 'an unanswered source contributes no cards, whatever the cache holds');
    const { html } = SB.situationView(m);
    assert.ok(html.includes(`<div class="sit-note failed">${I18N.en['sit.src.failed'].replace('{s}', I18N.en['sit.src.alerts'])}</div>`), html);
    assert.ok(!html.includes('sit-quiet'));
  }));
  withBoard({ alertsLoadedOnce: false, sourceFailed: {} }, () => withCopy(() => {
    const { html } = SB.situationView(SB.situationModel());
    assert.ok(html.includes('Waiting for a first answer from NWS alerts'), 'before the first answer it says loading');
    assert.ok(!html.includes('sit-note failed'), 'loading is not failure either');
  }));
  // answered before, failed this round: keep the last-good cards and say how old they are
  withBoard({ alerts: liveAlerts(), sourceFailed: { alerts: true } }, () => withCopy(() => {
    const m = SB.situationModel();
    assert.equal(m.src.alerts, 'stale');
    assert.equal(m.groups.length, 6);
    assert.ok(SB.situationView(m).html.includes('No answer from NWS alerts on the last refresh; showing what it reported at '));
  }));
  // the same rule for the other sources
  withBoard({ roadsUnknown: true, gauges: [], sourceFailed: { gauges: true } }, () => withCopy(() => {
    const { html } = SB.situationView(SB.situationModel());
    assert.ok(html.includes('Unavailable: road closures.'));
    assert.ok(html.includes('Unavailable: river gauges.'));
  }));
});

test('a snapshot is named as one, and the as-of time is the oldest source the picture rests on', () => {
  const snap = Date.now() - 40 * 60000;
  withBoard({ snapshotAt: snap, sourceFailed: { gauges: true } }, () => withCopy(() => {
    const m = SB.situationModel();
    assert.equal(m.src.gauges, 'snapshot');
    assert.equal(m.asOf, snap);
    assert.ok(SB.situationView(m).html.includes('Showing the published snapshot of river gauges from '));
    assert.equal(m.quiet, true, 'a published snapshot did answer; the as-of time carries its age');
  }));
  // two sources on the same snapshot read as one line, not two
  withBoard({ snapshotAt: snap, roadsFallbackAt: snap, sourceFailed: { gauges: true, roads: true } }, () => withCopy(() => {
    const notes = SB.situationView(SB.situationModel()).html.match(/<div class="sit-note snapshot">[^<]*<\/div>/g) || [];
    assert.equal(notes.length, 1, notes.join('\n'));
    assert.ok(notes[0].includes('Showing the published snapshot of river gauges and road closures from '), notes[0]);
  }));
  withBoard({ alertsLoadedOnce: false, gauges: [], roadClosures: null }, () => withCopy(() => {
    assert.ok(SB.situationView(SB.situationModel()).html.includes('Waiting for a first answer from NWS alerts, river gauges and road closures'));
  }));
});

/* ---------------- roads and shelters ---------------- */

test('flooded road closures and open shelters get one card each, and a tap reaches their surface', () => {
  const line = (condition, description) => ({ properties: { condition, description, route_name: 'FM0481' }, geometry: null });
  const roadClosures = { lines: [line('Flooding', ''), line('Flooding', ''), line('Closure', 'High water over roadway'), line('Closure', 'Bridge work')], points: [] };
  const sheltersLive = { generated: new Date().toISOString(), shelters: [{ name: 'A', status: 'open' }, { name: 'B', status: 'Open' }, { name: 'C', status: 'full' }] };
  const taps = [];
  withBoard({ roadClosures, sheltersLive }, () => withCopy(() => withStubs({
    openHelpSheet: () => taps.push('help'),
  }, () => {
    const m = SB.situationModel();
    assert.deepEqual(JSON.parse(JSON.stringify(m.roads)), { flood: 3, total: 4 });
    assert.equal(m.shelters, 2, 'a full shelter is not an open one');
    assert.equal(m.quiet, false);
    const { html, acts } = SB.situationView(m);
    const cs = cards(html);
    const road = cs.find((c) => c.title.includes('flooded road closures'));
    assert.equal(decode(road.title), '🌊 3 flooded road closures');
    assert.equal(decode(road.sub), 'TxDOT DriveTexas · 4 closures of any kind');
    const shl = cs.find((c) => c.title.includes('shelters open'));
    acts[shl.i]();
    assert.deepEqual(taps, ['help']);
    const prevQs = SB.document.querySelector;
    SB.document.querySelector = (sel) => (/data-tab="tab-roads"/.test(sel) ? { click: () => taps.push('roads') } : null);
    try { acts[road.i](); } finally { SB.document.querySelector = prevQs; }
    assert.deepEqual(taps, ['help', 'roads']);
  })));
});

/* ---------------- the renderer, executed end to end ---------------- */

function host() {
  const h = { innerHTML: '', dataset: {}, handlers: [] };
  h.addEventListener = (type, fn) => { if (type === 'click') h.handlers.push(fn); };
  h.tap = (i) => h.handlers.forEach((fn) => fn({ target: { closest: () => ({ getAttribute: () => String(i) }) } }));
  return h;
}

test('renderFeedSituation paints into #feed-situation and every card tap reaches its detail', () => {
  const el = host();
  const calls = [];
  const prevQs = SB.document.querySelector;
  SB.document.querySelector = (sel) => (sel === '#feed-situation' ? el : null);
  try {
    withBoard({ alerts: liveAlerts(), gauges: GAUGES, trendHist: TRENDS, records: RECORDS }, () => withCopy(() => withStubs({
      openAlertGroupInList: (list) => calls.push(['group', list.length]),
      openInAlertsList: (f) => calls.push(['one', f.properties.event]),
      focusGauges: (list, lead) => calls.push(['gauges', list.map((g) => g.lid).join(','), lead.lid]),
    }, () => {
      SB.renderFeedSituation();
      assert.ok(el.innerHTML.startsWith('<div class="sit-head">'), 'the section rendered');
      assert.equal(el.handlers.length, 1, 'one delegated listener');
      const cs = cards(el.innerHTML);
      const at = (needle) => cs.find((c) => decode(c.title).includes(needle)).i;
      el.tap(at('Flood Watch'));
      el.tap(at('High Wind Warning'));
      el.tap(at('Guadalupe River'));
      el.tap(at('Nueces River near Tilden'));
      assert.deepEqual(calls, [['group', 5], ['one', 'High Wind Warning'], ['gauges', 'VICT2,CUET2', 'VICT2'], ['gauges', 'TILT2', 'TILT2']]);

      // an unchanged repaint leaves the DOM alone and does not stack listeners
      const painted = el.innerHTML;
      el.innerHTML = 'untouched';
      SB.renderFeedSituation();
      assert.equal(el.innerHTML, 'untouched');
      assert.equal(el.handlers.length, 1);
      // a real change repaints
      state.gauges = [];
      SB.renderFeedSituation();
      assert.notEqual(el.innerHTML, 'untouched');
      assert.notEqual(el.innerHTML, painted);
      assert.ok(el.innerHTML.includes('Waiting for a first answer from river gauges'), el.innerHTML.slice(0, 400));
    })));
  } finally { SB.document.querySelector = prevQs; }
});

test('a group tap unfolds the Alerts tab for any hidden member, then lands on and pulses every row', () => {
  const alerts = liveAlerts().filter((f) => f.properties.event === 'Flood Advisory');
  const flashed = [];
  let rendered = 0, tab = 0, scrolled = 0;
  const present = new Set([`#alert-list .alert-card[data-alert-id="${alerts[1].id}"]`]);
  const inputs = { '#flt-alert-sev': { value: '' }, '#flt-alert-q': { value: 'bexar' } };
  const prevQs = SB.document.querySelector;
  SB.document.querySelector = (sel) => {
    if (/data-tab="tab-alerts"/.test(sel)) return { click: () => { tab += 1; } };
    if (inputs[sel]) return inputs[sel];
    return present.has(sel) ? { scrollIntoView: () => { scrolled += 1; }, sel } : null;
  };
  try {
    withState({ alerts, showAlertsFar: false }, () => withStubs({
      renderAlertList: () => { rendered += 1; for (const f of alerts) present.add(`#alert-list .alert-card[data-alert-id="${f.id}"]`); },
      flashRow: (row) => flashed.push(row.sel),
      requestAnimationFrame: (fn) => fn(),
    }, () => {
      SB.openAlertGroupInList(SB.alertDedupe(alerts));
      assert.equal(inputs['#flt-alert-q'].value, '', 'the search hiding members is cleared');
      assert.equal(state.showAlertsFar, true);
      assert.equal(rendered, 1);
      assert.equal(tab, 1);
      assert.equal(scrolled, 1, 'the list scrolls once, to the first row');
      assert.equal(flashed.length, 5, 'every member row pulses');
    }));
  } finally { SB.document.querySelector = prevQs; }
});

test('refresh() marks a source that gave no answer, and repaints the section even when nothing else does', async () => {
  const full = loadFullApp();
  const sb = full._sandbox;
  const st = full.state;
  const painted = [];
  const ok = (k) => async () => { sb.markHealthy(k); };
  const stubs = {
    fetchAlerts: async () => { throw new Error('NWS down'); },
    fetchGauges: ok('gauges'),
    fetchFcstMax: ok('fcstMax'), fetchUsgsIv: ok('usgs'), fetchLsrs: ok('lsrs'), loadSeeds: ok('seeds'),
    // answered, then a draw step threw: that source did answer this round
    fetchRoadClosures: async () => { sb.markHealthy('roads'); throw new Error('render failed'); },
    fetchRoadFlood: async () => {}, setFeedNote() {}, setFeedNoteHealthy() {}, renderSourceHealth() {},
    checkAppVersion() {}, saveCache() {}, loadTides() {}, hydrateFromCache: () => false, hydrateGaugesSnapshot: async () => false,
    renderFeedSituation: () => painted.push(JSON.parse(JSON.stringify(st.sourceFailed))),
  };
  const saved = {};
  for (const [k, v] of Object.entries(stubs)) { saved[k] = sb[k]; sb[k] = v; }
  const prev = { gauges: st.gauges, alerts: st.alerts, layers: st.layers, refreshBusy: st.refreshBusy };
  st.gauges = [gauge('JUNT2', 'Devils River near Juno', 'no_flooding', 3.2)];
  st.layers = {};
  try {
    await sb.refresh();
    assert.equal(painted.length, 1, 'the section repaints once the round settles');
    assert.equal(painted[0].alerts, true, 'alerts gave no answer');
    assert.equal(painted[0].gauges, false);
    assert.equal(painted[0].roads, false, 'a source that answered and then failed to draw is not unanswered');
  } finally {
    Object.assign(sb, saved);
    Object.assign(st, prev);
  }
});

/* ---------------- the SITREP after the refactor ---------------- */

test('the SITREP still states the same facts, now from the selectors the Feed reads', () => {
  withBoard({ alerts: liveAlerts(), gauges: GAUGES, trendHist: TRENDS, records: RECORDS }, () => withCopy(() => {
    const text = SB.buildSitrep();
    const lines = text.split('\n');
    // independent oracle: the pre-refactor expressions, written out here
    const open = state.alerts.filter(alertOpen);
    const warnings = open.filter((a) => a._sev === 'warning').length;
    const majors = state.gauges.filter((g) => SB.gaugeCat(g) === 'major');
    const toMajor = state.gauges.filter((g) => SB.gaugeRising(g) && SB.gaugeForecastCat(g) === 'major');
    assert.equal(lines.find((l) => l.startsWith('THREAT:')), `THREAT: 0 flash flood emergencies; ${warnings} flood warnings statewide (official)`);
    assert.equal(warnings, 8, 'three flash flood, four flood and one high wind warning message are open');
    assert.equal(lines.find((l) => l.startsWith('GAUGES:')), `GAUGES: ${majors.length} at MAJOR, ${toMajor.length} forecast to reach major (official)`);
    assert.ok(lines.includes('  MAJOR Guadalupe River at Victoria - 31.2 ft (+0.8 ft/hr)'), text);
    assert.ok(lines.some((l) => l.startsWith('  RISING Nueces River near Tilden - fcst crest 23.1 ft ') && l.endsWith('[⚑ 2 ft below 25.1 ft record 1919]')), text);
    assert.ok(lines.some((l) => l.startsWith('RECOVERY: 1 in-flood gauges falling (Guadalupe River)')), text);
    // the product line and the Feed cards are one selector, so they cannot disagree
    const groups = SB.situationModel().groups;
    assert.equal(lines.find((l) => l.startsWith('NWS PRODUCTS:')),
      `NWS PRODUCTS: ${groups.map((g) => `${g.event} (${g.n})`).join('; ')} (official)`);
    assert.ok(text.includes('NWS PRODUCTS: Flash Flood Warning (3); Flood Warning (4); Flood Watch (5)'));
  }));
  withBoard({}, () => {
    assert.ok(!SB.buildSitrep().includes('NWS PRODUCTS'), 'no product line when no product is open');
  });
});

/* ---------------- copy and parity ---------------- */

test('every situation string exists in both languages with its placeholders, and carries no em-dash', () => {
  const keys = Object.keys(I18N.en).filter((k) => k.startsWith('sit.') || k === 'feed.notices');
  assert.ok(keys.length >= 30, `only ${keys.length} situation keys`);
  for (const k of keys) {
    assert.ok(I18N.es[k], `es is missing ${k}`);
    for (const ph of (I18N.en[k].match(/\{[a-z]+\}/g) || [])) assert.ok(I18N.es[k].includes(ph), `es ${k} lost ${ph}`);
    assert.ok(!/—/.test(I18N.en[k] + I18N.es[k]), `${k} carries an em-dash`);
  }
  assert.ok(!/all clear/i.test(I18N.en['sit.quiet']), 'the calm line names what was checked, it does not declare an all clear');
});

test('the section renders in Spanish without a raw key leaking through', () => {
  withBoard({ alerts: liveAlerts(), gauges: GAUGES, trendHist: TRENDS, records: RECORDS, sourceFailed: { roads: true }, roadsUnknown: true }, () => withCopy(() => {
    const { html } = SB.situationView(SB.situationModel());
    assert.ok(!/\b(sit|alert|record|roads)\.[a-z.]+\b/.test(html.replace(/class="[^"]*"/g, '')), 'an i18n key rendered raw');
    assert.ok(html.includes('Situación') && html.includes('Ríos en inundación') && html.includes('No disponible: los cierres de caminos.'));
  }, 'es'));
});
