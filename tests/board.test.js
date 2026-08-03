'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./harness.js');

const { smartScore, shortId, allRequests, state, CONFIG, pushCardState, pushFreshState } = loadApp();
const SB = loadApp()._sandbox;

/* ---------- the alerts card as the browser really paints it ----------

   The claims below are about what renderPushCard() puts on screen, so they are read off markup it
   actually emitted. A regex over js/board.js cannot tell a drawn card from one that throws on first
   paint, which is how a whole layer shipped dead in v0.99.79 behind green source-text assertions. */

// browser environments, not fact bags: pushEnvFacts() reads each one back out for itself
const PUSH_DEVICE = {
  off: { permission: 'default', subscribed: false, hasPush: true },
  on: { permission: 'granted', subscribed: true, hasPush: true },
  blocked: { permission: 'denied', subscribed: false, hasPush: true },
  ios: { permission: 'default', subscribed: false, hasPush: false, ua: 'iPhone' },
  unsupported: { permission: 'default', subscribed: false, hasPush: false },
};

// the accordion rows are the only nodes the card looks up on itself; answering them out of markup
// it really emitted stops a row it has quietly dropped from being faked back into existence
function pushHost() {
  const host = {
    innerHTML: '', firstChild: true, taps: {},
    querySelectorAll(sel) {
      if (sel !== '.push-sec[data-sec]') return [];
      return [...host.innerHTML.matchAll(/push-sec" data-sec="([a-z]+)"/g)].map(([, key]) => ({
        getAttribute: (a) => (a === 'data-sec' ? key : null),
        addEventListener: (ev, fn) => { if (ev === 'click') host.taps[key] = fn; },
      }));
    },
  };
  return host;
}

/* Renders `device` once and returns the host. Only the selectors passed in `nodes` are answered, so
   a node the card starts needing shows up as a change here rather than as a mock that agrees with
   anything. `body(host)` runs after the first paint; the cleanup closes any pane it left open,
   because pushSection is module state every test in this file shares. */
function renderCard(device, { prefs = {}, nodes = {} } = {}, body) {
  const d = PUSH_DEVICE[device];
  const keep = { qs: SB.document.querySelector, notif: SB.Notification, pm: SB.PushManager,
    secure: SB.isSecureContext, sw: SB.navigator.serviceWorker, ua: SB.navigator.userAgent };
  SB.isSecureContext = true;
  SB.navigator.serviceWorker = {};
  SB.navigator.userAgent = d.ua || 'Mozilla/5.0';
  SB.Notification = { permission: d.permission };
  if (d.hasPush) SB.PushManager = function PushManager() {}; else delete SB.PushManager;
  SB.localStorage.setItem('respondertx.push', JSON.stringify({ on: d.subscribed, prefs }));
  const host = pushHost();
  const reg = Object.assign({ '#push-body': host }, nodes);
  // a control the card draws inside itself resolves only once it has really drawn it, as it would
  // in a browser where the lookup runs after #push-body was overwritten
  const drawn = (sel) => sel === '#push-body' || !/^#push-/.test(sel)
    || host.innerHTML.includes(`id="${sel.slice(1)}"`);
  SB.document.querySelector = (s) =>
    (Object.prototype.hasOwnProperty.call(reg, s) && drawn(s) ? reg[s] : null);
  try {
    SB.renderPushCard();
    if (body) body(host);
    return host;
  } finally {
    const open = host.innerHTML.match(/data-sec="([a-z]+)" aria-expanded="true"/);
    if (open) host.taps[open[1]]();
    SB.document.querySelector = () => null; // so the preselect reset cannot reopen the sheet
    SB.pushOpenManageFor('');
    SB.document.querySelector = keep.qs; SB.Notification = keep.notif;
    SB.isSecureContext = keep.secure; SB.navigator.serviceWorker = keep.sw; SB.navigator.userAgent = keep.ua;
    if (keep.pm === undefined) delete SB.PushManager; else SB.PushManager = keep.pm;
    SB.localStorage.removeItem('respondertx.push'); // the bundle is cached across tests in this file
  }
}

/* ---------- smartScore: priority weight with half-life age decay ---------- */

const isoMinAgo = (min) => new Date(Date.now() - min * 60000).toISOString();
const req = (priority, minAgo) => ({ priority, ts: isoMinAgo(minAgo) });

test('smartScore — fresh cards rank strictly by priority weight', () => {
  const crit = smartScore(req('critical', 0));
  const high = smartScore(req('high', 0));
  const med = smartScore(req('medium', 0));
  const low = smartScore(req('low', 0));
  assert.ok(crit > high && high > med && med > low, `${crit},${high},${med},${low}`);
});

// freeze the clock so req() and smartScore() read the same instant; otherwise sub-ms jitter
// between stamping ts and scoring makes the ages inexact and any exact equality flaky
function atFixedClock(fn) {
  const realNow = Date.now;
  Date.now = () => 1700000000000;
  try { return fn(); } finally { Date.now = realNow; }
}

test('smartScore — one half-life of age halves the score', () => {
  atFixedClock(() => {
    const fresh = smartScore(req('critical', 0));
    const aged = smartScore(req('critical', CONFIG.smartHalfLifeMins));
    assert.ok(Math.abs(aged - fresh / 2) < 1e-9, `fresh=${fresh} aged=${aged}`);
  });
});

test('smartScore — age decay can let a fresh card overtake a stale higher-priority one', () => {
  // a critical decayed past two half-lives (score ~2) falls below a fresh high (score 4)
  const staleCritical = smartScore(req('critical', CONFIG.smartHalfLifeMins * 2));
  const freshHigh = smartScore(req('high', 0));
  assert.ok(freshHigh > staleCritical, `freshHigh=${freshHigh} staleCritical=${staleCritical}`);
});

test('smartScore — unknown priority falls back to weight 1', () => {
  assert.equal(atFixedClock(() => smartScore(req('bogus', 0))), 1);
});

/* ---------- shortId: stable radio-speakable R-### reference ---------- */

test('shortId — seed ids map to zero-padded R-NNN', () => {
  assert.equal(shortId('seed-031'), 'R-031');
  assert.equal(shortId('seed-0031'), 'R-031'); // leading zeros collapse
  assert.equal(shortId('seed-7'), 'R-007');
  assert.equal(shortId('seed-123'), 'R-123');
});

test('shortId — non-seed ids hash to a valid 3-char base36 code', () => {
  const out = shortId('f47ac10b-58cc-4372-a567-0e02b2c3d479');
  assert.match(out, /^R-[0-9A-Z]{3}$/);
});

/* ---------- allRequests: LAN-shared copy supersedes the local intake (same id) ---------- */

test('allRequests — a seed entry with the same id supersedes the local copy', () => {
  const saved = { seed: state.seedRequests, store: state.store };
  try {
    state.seedRequests = [{ id: 'local-x1', summary: 'shared copy', status: 'open', ts: 'T' }];
    state.store = { added: [{ id: 'local-x1', summary: 'local copy', status: 'open', ts: 'T' }], overrides: {}, archived: [] };
    const all = allRequests();
    assert.equal(all.length, 1);
    assert.equal(all[0].summary, 'shared copy');
  } finally {
    state.seedRequests = saved.seed;
    state.store = saved.store;
  }
});

test('allRequests — local intakes not yet shared still render beside seeds', () => {
  const saved = { seed: state.seedRequests, store: state.store };
  try {
    state.seedRequests = [{ id: 'seed-001', summary: 'curated', status: 'open', ts: 'T' }];
    state.store = { added: [{ id: 'local-x2', summary: 'device-local', status: 'open', ts: 'T' }], overrides: {}, archived: [] };
    const all = allRequests();
    assert.deepEqual(all.map((r) => r.id).sort(), ['local-x2', 'seed-001']);
  } finally {
    state.seedRequests = saved.seed;
    state.store = saved.store;
  }
});

test('shortId — hashing is deterministic (same id -> same code)', () => {
  assert.equal(shortId('local-abc-123'), shortId('local-abc-123'));
});

test('shortId — distinct local ids produce distinct codes', () => {
  assert.notEqual(shortId('local-abc-123'), shortId('local-xyz-999'));
});

/* ---------- pushCardState: device-alerts card state machine (web push P1) ---------- */

const pushFacts = (over = {}) => ({
  ios: false, standalone: false, secure: true, hasSW: true, hasPush: true, hasNotif: true,
  permission: 'default', subscribed: false, ...over,
});

test('pushCardState — capable browser toggles between off and on', () => {
  assert.equal(pushCardState(pushFacts()), 'off');
  assert.equal(pushCardState(pushFacts({ subscribed: true, permission: 'granted' })), 'on');
});

test('pushCardState — iOS outside a Home Screen install shows the install hint first', () => {
  // Safari hides PushManager in a plain tab; the install path must win over generic unsupported
  assert.equal(pushCardState(pushFacts({ ios: true, hasPush: false })), 'ios');
  assert.equal(pushCardState(pushFacts({ ios: true })), 'ios');
  assert.equal(pushCardState(pushFacts({ ios: true, standalone: true })), 'off', 'installed iOS app behaves normally');
});

test('pushCardState — missing capability reads unsupported, never an error', () => {
  assert.equal(pushCardState(pushFacts({ hasPush: false })), 'unsupported');
  assert.equal(pushCardState(pushFacts({ hasSW: false })), 'unsupported');
  assert.equal(pushCardState(pushFacts({ hasNotif: false })), 'unsupported');
  assert.equal(pushCardState(pushFacts({ secure: false })), 'unsupported');
});

test('pushCardState — a denied permission is blocked (no re-prompt state)', () => {
  assert.equal(pushCardState(pushFacts({ permission: 'denied' })), 'blocked');
  assert.equal(pushCardState(pushFacts({ permission: 'denied', subscribed: true })), 'blocked', 'blocked wins over a stale local on-flag');
});

/* pushCardVisible and the rest of the discovery contract live in tests/push-discovery.test.js */

/* ---------- pushFollowPending: what the "Notify me" bell can actually deliver ---------- */

const { pushFollowPending, pushPendingHtml } = loadApp();

test('pushFollowPending — a follow requested with alerts off is pending, not silently dropped', () => {
  // the regression: tapping the gauge-popup bell with alerts off switched to a card with no
  // manage view, no preselected gauge and no explanation, and v0.97.79 claimed otherwise
  for (const st of ['off', 'blocked', 'unsupported', 'ios']) {
    assert.equal(pushFollowPending(st, 'SRRT2'), true, `${st} must explain itself`);
  }
});

test('pushFollowPending — on a subscribed device the picker opens, so nothing is pending', () => {
  assert.equal(pushFollowPending('on', 'SRRT2'), false);
});

test('pushFollowPending — no requested gauge means no note, in any card state', () => {
  for (const st of ['on', 'off', 'blocked', 'unsupported', 'ios']) {
    assert.equal(pushFollowPending(st, null), false);
    assert.equal(pushFollowPending(st, ''), false);
  }
});

test('pushPendingHtml renders a translated explanation when off, and nothing when on', () => {
  const off = pushPendingHtml('off', 'SRRT2');
  assert.match(off, /push-m-note/, 'the note uses the card note style');
  assert.match(off, /push\.manage\.pending/, 'and is routed through t(), never a bare literal');
  assert.equal(pushPendingHtml('on', 'SRRT2'), '', 'a subscribed device just gets the picker');
  assert.equal(pushPendingHtml('off', null), '', 'no requested gauge, no note');
  for (const st of ['blocked', 'unsupported', 'ios']) {
    assert.match(pushPendingHtml(st, 'SRRT2'), /push-m-note/, `${st} must still explain itself`);
  }
});

test('a follow requested with alerts off explains itself on the card it lands on', () => {
  const keep = state.gauges;
  state.gauges = [{ lid: 'SRRT2', name: 'San Marcos at Luling', latitude: 29.68, longitude: -97.65 }];
  try {
    // the real entry point: the gauge-popup bell, which pins the gauge and opens the notify sheet
    const html = renderCard('off', { nodes: { '#notify-sheet': { hidden: true } } },
      () => SB.pushOpenManageFor('srrt2')).innerHTML;
    assert.match(html, /<div class="push-m-note">push\.manage\.pending<\/div>/,
      'the card must say why the picker did not open');
    assert.ok(html.indexOf('push.manage.pending') < html.indexOf('push.pitch'),
      'the answer to the tap must come before the general pitch');
  } finally { state.gauges = keep; }
});

/* Owner report: "the Alerts construct within the settings menu is a wall of text". Measured at
   390x844 before the restructure: 67 words of prose stood between opening Settings and the on/off
   switch, which rendered last in the card and below the fold of the height-capped menu. The order
   is now state, switch, per-type rows, and the honesty text is compact-plus-disclosure. These
   assertions are on emission ORDER, which is the property that regressed, measured on the markup
   the card really paints rather than on the shape of the source that paints it. */
const emitOrder = (html, ...needles) => needles.map((n) => {
  const at = html.indexOf(n);
  assert.notEqual(at, -1, `the rendered card no longer carries ${n}`);
  return at;
});

test('the alerts card leads with the state and the switch, not with prose', () => {
  const html = renderCard('on', { prefs: { scope: 'statewide', ffe: true } }).innerHTML;
  const [head, status, toggle, types, note, about, sub, disclaimer] = emitOrder(html,
    'push-head', 'push.state.', 'push-toggle', 'push-types', 'push.note', 'push.about', 'push.sub', 'push.disclaimer');
  assert.ok(head < status && status < toggle, 'the state must open the card, with the switch beside it');
  assert.ok(toggle < types, 'the on/off switch must precede the per-type rows');
  assert.ok(toggle < note && note < about, 'the compact honesty line sits after the controls, before the disclosure');
  assert.ok(about < sub && about < disclaimer, 'the paragraphs must be inside the disclosure, never above the switch');
});

test('the honesty text survives: compact line always plain, full paragraphs one visible tap away', () => {
  // v0.97.69/v0.97.79 shipped the honest on/off/blocked state and the not-a-911-replacement framing
  const html = renderCard('on', { prefs: { scope: 'statewide', ffe: true } }).innerHTML;
  const det = html.slice(html.indexOf('<details'), html.indexOf('</details>'));
  assert.ok(!det.includes('push-note'), 'the compact honesty line must render outside the <details>');
  assert.match(html, /<div class="push-note">push\.note<\/div>/);
  assert.ok(det.includes('push.sub') && det.includes('push.disclaimer'),
    'the full paragraphs must still be emitted, inside the disclosure');
  assert.match(det, /<summary>push\.about<\/summary>/, 'the disclosure must carry a visible summary');

  /* The state line is emitted for every card state, never gated, one key per state. The one branch
     is honesty, not a gate: a subscribed device whose settings can deliver nothing must not wear the
     green ON, and tests/push-places.test.js owns that case. */
  for (const device of ['on', 'off', 'blocked', 'ios', 'unsupported']) {
    const each = renderCard(device, { prefs: { scope: 'statewide', ffe: true } }).innerHTML;
    assert.match(each, new RegExp(`<div class="push-status push-${device}">push\\.state\\.${device}<`),
      `${device} must render its own state line, in its own tone`);
    assert.equal((each.match(/class="push-status/g) || []).length, 1,
      `${device} rendered more than one state line`);
    assert.match(each, /<div class="push-note">push\.note<\/div>/,
      `${device} lost the compact honesty line`);
  }
});

const { pushFixKey } = loadApp();

test('pushFixKey — every unfixable state keeps its own instruction, and stays distinguishable', () => {
  assert.equal(pushFixKey('blocked'), 'push.fix.blocked');
  assert.equal(pushFixKey('unsupported'), 'push.fix.unsupported');
  assert.equal(pushFixKey('ios'), 'push.fix.ios');
  // on/off are fixed by the switch that is already on screen, so they get no second instruction
  assert.equal(pushFixKey('on'), '');
  assert.equal(pushFixKey('off'), '');
});

/* ---------- pushFreshState: evaluator freshness chip (web push P2) ---------- */

test('pushFreshState — hidden without data, ok within 20 min, stale past it', () => {
  const now = 1700000000000;
  assert.equal(pushFreshState(undefined, now), null, 'no status yet: chip hidden');
  assert.equal(pushFreshState(null, now), null);
  assert.equal(pushFreshState(0, now), null);
  assert.equal(pushFreshState(now - 3 * 60000, now), 'ok', 'checked 3 min ago');
  assert.equal(pushFreshState(now - 19 * 60000, now), 'ok', 'just inside the threshold');
  assert.equal(pushFreshState(now - 21 * 60000, now), 'stale', 'past 20 min: honest delayed state');
});

/* ---------- web push P3: prefs normalizer, self-heal plan, key compare, nearby picker ---------- */

const { pushNormalizePrefs, pushKeysMatch, pushBootPlan, pushNearbyGauges } = loadApp();

test('pushNormalizePrefs: followed gauges uppercased, deduped, invalid entries dropped, capped at 20', () => {
  const out = pushNormalizePrefs({
    ffe: false, tier: 'major',
    gauges: [
      { lid: 'srrt2', tier: 'moderate' },
      { lid: 'SRRT2', tier: 'major' },     // dup after uppercasing
      { lid: 'x', tier: 'major' },         // lid too short
      { lid: 'CMKT2', tier: 'minor' },     // invalid tier
      { lid: 'CMKT2', tier: 'major' },
    ],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(out)), {
    ffe: false, tier: 'major',
    gauges: [{ lid: 'SRRT2', tier: 'moderate' }, { lid: 'CMKT2', tier: 'major' }],
    scope: 'none', places: [],
  });
  const over = pushNormalizePrefs({ gauges: Array.from({ length: 25 }, (_, i) => ({ lid: `G${i}LID`, tier: 'major' })) });
  assert.equal(over.gauges.length, 20, 'client mirrors the registry cap');
  assert.deepEqual(JSON.parse(JSON.stringify(pushNormalizePrefs(null))),
    { ffe: true, tier: null, gauges: [], scope: 'none', places: [] });
});

test('pushKeysMatch: byte-wise, ArrayBuffer or view, null-safe', () => {
  const a = new Uint8Array([4, 1, 2, 3]);
  assert.equal(pushKeysMatch(a, new Uint8Array([4, 1, 2, 3])), true);
  assert.equal(pushKeysMatch(a.buffer, new Uint8Array([4, 1, 2, 3])), true, 'ArrayBuffer accepted (subscription option shape)');
  assert.equal(pushKeysMatch(a, new Uint8Array([4, 1, 2, 9])), false);
  assert.equal(pushKeysMatch(a, new Uint8Array([4, 1, 2])), false, 'length mismatch');
  assert.equal(pushKeysMatch(null, a), false);
  assert.equal(pushKeysMatch(a, null), false);
});

test('pushBootPlan: renew when healthy, rekey on rotation, resubscribe when the sub vanished, honest off on revocation', () => {
  const f = (over) => ({ localOn: true, permission: 'granted', hasSub: true, keyMatches: true, ...over });
  assert.equal(pushBootPlan(f({ localOn: false })), 'none');
  assert.equal(pushBootPlan(f()), 'renew');
  assert.equal(pushBootPlan(f({ keyMatches: false })), 'rekey', 'VAPID rotation self-heal');
  assert.equal(pushBootPlan(f({ hasSub: false, keyMatches: null })), 'resubscribe', 'prefs exist locally, sub vanished');
  assert.equal(pushBootPlan(f({ permission: 'denied' })), 'off', 'revoked permission never re-prompts');
  assert.equal(pushBootPlan(f({ hasSub: false, permission: 'default', keyMatches: null })), 'off', 'no sub + no grant = honest off');
});

test('pushNearbyGauges: nearest-first, excludes followed and coordinate-less gauges, capped', () => {
  const gs = [
    { lid: 'FAR11', name: 'Far', latitude: 31.0, longitude: -99.0 },
    { lid: 'NEAR1', name: 'Near', latitude: 29.51, longitude: -95.01 },
    { lid: 'MID11', name: 'Mid', latitude: 29.8, longitude: -95.4 },
    { lid: 'FOLW1', name: 'Followed', latitude: 29.5, longitude: -95.0 },
    { lid: 'NOPOS', name: 'No coords' },
  ];
  const out = pushNearbyGauges(gs, [{ lid: 'FOLW1', tier: 'major' }], 29.5, -95.0, 2);
  assert.deepEqual(out.map((x) => x.g.lid), ['NEAR1', 'MID11']);
  assert.ok(out[0].dist < out[1].dist);
});

/* ---------- CalTopo stable import URL + QR affordance ---------- */

const { CALTOPO_EXPORT_URL, renderQr } = loadApp();

test('CALTOPO_EXPORT_URL — https public-mirror data path (the URL CalTopo users import from)', () => {
  assert.equal(CALTOPO_EXPORT_URL, 'https://respondertx.org/data/caltopo-export.json');
  assert.ok(CALTOPO_EXPORT_URL.startsWith('https://'), 'must be fetchable by caltopo.com');
});

/* v0.99.43: the QR library is fetched on first use, so "absent" no longer means "unavailable" and
   hiding the box would read as "this view has no QR". It says it is loading, then either paints or
   says it could not. tests/lazy-assets.test.js drives both outcomes of that fetch. */
test('renderQr — asks for the lazy QR lib and says so, rather than hiding the box', () => {
  const host = { hidden: false, dataset: {}, innerHTML: '' };
  renderQr(host, CALTOPO_EXPORT_URL); // sandbox has no global qrcode
  assert.equal(host.hidden, false, 'a silently collapsed box reads as "no QR for this view"');
  assert.match(host.innerHTML, /qr\.loading/, 'the box must say the code is being built');
  assert.doesNotThrow(() => renderQr(null, CALTOPO_EXPORT_URL), 'null host is a no-op');
});

test('renderQr — dataset.done guard makes re-render a no-op', () => {
  const host = { hidden: false, dataset: { done: '1' }, innerHTML: 'existing' };
  renderQr(host, CALTOPO_EXPORT_URL);
  assert.equal(host.innerHTML, 'existing', 'already-rendered QR untouched');
  assert.equal(host.hidden, false);
});

/* ---------- CalTopo export completeness: the share sheet must not overstate the file ---------- */

const { caltopoStatusText } = loadApp();
const I18N = require('./i18n-load.js');

// the harness t() echoes keys, so these assert WHICH claim is made; the placeholder test below
// proves the chosen strings actually carry the numbers the function substitutes into them
test('caltopoStatusText: a complete export claims completeness, a capped one never does', () => {
  assert.equal(caltopoStatusText({ counts: { A: 40, B: 2 }, truncated: false, dropped: 0, candidates: 42 }),
    'caltopo.complete');
  assert.equal(caltopoStatusText({ counts: { A: 500, B: 6 }, truncated: true, dropped: 625, candidates: 1131 }),
    'caltopo.partial');
});

test('caltopoStatusText: a pre-v0.99.1 export with no candidates key still reads as capped', () => {
  assert.equal(caltopoStatusText({ counts: { A: 506 }, truncated: true, dropped: 625 }), 'caltopo.partial');
});

test('caltopoStatusText: unreadable metadata yields no claim at all, never a false complete', () => {
  // {} and a zero-count export are the dangerous ones: both are truthy, neither describes a file
  for (const bad of [null, undefined, 'nope', 42, {}, { counts: {} }, { counts: null, truncated: false }]) {
    assert.equal(caltopoStatusText(bad), '', `bad metadata must stay silent, got ${caltopoStatusText(bad)}`);
  }
});

test('caltopo status strings carry the counts they promise, in both languages', () => {
  for (const lang of ['en', 'es']) {
    assert.ok(I18N[lang]['caltopo.complete'].includes('{n}'), `${lang} caltopo.complete lost {n}`);
    assert.ok(I18N[lang]['caltopo.partial'].includes('{n}'), `${lang} caltopo.partial lost {n}`);
    assert.ok(I18N[lang]['caltopo.partial'].includes('{total}'), `${lang} caltopo.partial lost {total}`);
  }
});

/* ---------- feedCalmOk: an empty curated Feed is not a hazard verdict ---------- */

const { feedCalmOk } = loadApp();

const catGauge = (floodCategory) => ({ status: { observed: { floodCategory, validTime: isoMinAgo(30) } } });
const openAlert = () => ({ id: 'urn:test:1', properties: { event: 'Flood Warning', areaDesc: 'Kerr, TX' } });

// quiet baseline: feeds loaded, nothing running. Each case perturbs one hazard source.
function withHazards(patch, fn) {
  const prev = { alerts: state.alerts, gauges: state.gauges, roadClosures: state.roadClosures };
  Object.assign(state, { alerts: [], gauges: [catGauge('no_flooding')], roadClosures: { lines: [] } }, patch);
  try { return fn(); } finally { Object.assign(state, prev); }
}

test('feedCalmOk — quiet hazard feeds allow the calm treatment on an empty Feed', () => {
  withHazards({}, () => assert.equal(feedCalmOk(), true));
});

/* The Feed lists CURATED notices. Their absence says nothing about the river, the roads or the
   NWS, so the reassuring treatment must never outrank a live hazard on another tab. */
test('REGRESSION — no calm treatment while any hazard source is live', () => {
  withHazards({ alerts: [openAlert()] }, () => assert.equal(feedCalmOk(), false, 'open alert'));
  withHazards({ gauges: [catGauge('minor')] }, () => assert.equal(feedCalmOk(), false, 'gauge at minor'));
  withHazards({ gauges: [catGauge('major')] }, () => assert.equal(feedCalmOk(), false, 'gauge at major'));
  withHazards({ roadClosures: { lines: [{ id: 'r1' }] } }, () => assert.equal(feedCalmOk(), false, 'road closure'));
});

test('feedCalmOk — hazard feeds that have not loaded yet cannot support a calm claim', () => {
  withHazards({ gauges: [] }, () => assert.equal(feedCalmOk(), false, 'no gauges loaded'));
  withHazards({ roadClosures: undefined }, () => assert.equal(feedCalmOk(), false, 'no road data loaded'));
});

test('the empty-Feed headline claims only that the Feed is empty, in both languages', () => {
  assert.ok(!/all clear/i.test(I18N.en['feed.allclear']), 'en feed.allclear claims a hazard verdict');
  assert.ok(!/todo despejado/i.test(I18N.es['feed.allclear']), 'es feed.allclear claims a hazard verdict');
});

/* 2026-07-30: a MAJOR-category flood was running on the Nueces with two Severe/Immediate Flood
   Warnings, while the Feed, which is the tab the board opens on, held 43 notices suppressed for age
   and rendered "No notices in the Feed right now". The count existed only as a button in a filter
   row nobody on the default tab opens. Suppressed is not absent. */
test('a Feed emptied by age says so with the count, and never takes the calm treatment', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'board.js'), 'utf8');
  const branch = src.slice(src.indexOf('if (!listed.length)'), src.indexOf('state.layers.requests.clearLayers()'));
  assert.match(branch, /heldForAge/, 'the empty branch must distinguish held-for-age from genuinely empty');
  assert.match(branch, /feed\.aged\.only/, 'it must use the string that names the suppressed count');
  assert.match(branch, /calm = [^;]*!heldForAge/,
    'the calm treatment is a hazard claim and must not render over suppressed notices');
  assert.match(branch, /feed-show-aged/, 'the reader needs a way to see them without opening the filter row');

  for (const lang of ['en', 'es']) {
    assert.ok(I18N[lang]['feed.aged.only'], `feed.aged.only missing from ${lang}`);
    assert.ok(I18N[lang]['feed.aged.show'], `feed.aged.show missing from ${lang}`);
    assert.match(I18N[lang]['feed.aged.only'], /\{n\}/, `${lang} must interpolate the count`);
    assert.ok(!/—/.test(I18N[lang]['feed.aged.only'] + I18N[lang]['feed.aged.show']),
      `${lang} strings must carry no em-dash`);
  }
  // and it must still point at where the hazard actually lives
  assert.match(I18N.en['feed.aged.only'], /Alerts/);
  assert.match(I18N.es['feed.aged.only'], /Alertas/);
});
