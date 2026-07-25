'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./harness.js');

const { smartScore, shortId, allRequests, state, CONFIG, pushCardState, pushFreshState } = loadApp();

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

test('smartScore — one half-life of age halves the score', () => {
  // freeze the clock so req() and smartScore() read the same instant; otherwise sub-ms
  // jitter between stamping ts and scoring makes the ages inexact and the equality flaky
  const realNow = Date.now;
  Date.now = () => 1700000000000;
  try {
    const fresh = smartScore(req('critical', 0));
    const aged = smartScore(req('critical', CONFIG.smartHalfLifeMins));
    assert.ok(Math.abs(aged - fresh / 2) < 1e-9, `fresh=${fresh} aged=${aged}`);
  } finally {
    Date.now = realNow;
  }
});

test('smartScore — age decay can let a fresh card overtake a stale higher-priority one', () => {
  // a critical decayed past two half-lives (score ~2) falls below a fresh high (score 4)
  const staleCritical = smartScore(req('critical', CONFIG.smartHalfLifeMins * 2));
  const freshHigh = smartScore(req('high', 0));
  assert.ok(freshHigh > staleCritical, `freshHigh=${freshHigh} staleCritical=${staleCritical}`);
});

test('smartScore — unknown priority falls back to weight 1', () => {
  assert.equal(smartScore(req('bogus', 0)), 1);
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

/* ---------- pushCardVisible: who gets the alerts card, and therefore the off switch ---------- */

const { pushCardVisible } = loadApp();

test('pushCardVisible — a subscribed device always gets its card, with or without ?push', () => {
  // the regression: a Flash Flood Emergency deep link landed on a board with no alerts card,
  // no state line and no toggle, so an opted-in device had no reachable way to turn alerts off
  assert.equal(pushCardVisible({ flagged: false, subscribed: true }), true);
  assert.equal(pushCardVisible({ flagged: true, subscribed: true }), true);
});

test('pushCardVisible — ?push stays the discovery gate for devices that never opted in', () => {
  assert.equal(pushCardVisible({ flagged: false, subscribed: false }), false, 'soft launch stays soft');
  assert.equal(pushCardVisible({ flagged: true, subscribed: false }), true);
});

test('pushCardVisible — only a real local subscription counts, never a truthy stand-in', () => {
  assert.equal(pushCardVisible({ flagged: false, subscribed: 'yes' }), false);
  assert.equal(pushCardVisible({ flagged: false, subscribed: 1 }), false);
  assert.equal(pushCardVisible({}), false);
});

test('initPushCard gates on pushCardVisible, not on the ?push flag alone', () => {
  // the predicate is only worth testing if it is the one the card actually consults
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'board.js'), 'utf8');
  const fn = src.match(/async function initPushCard\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'initPushCard not found in js/board.js');
  assert.match(fn[0], /pushCardVisible\(/, 'initPushCard must consult pushCardVisible');
  assert.match(fn[0], /subscribed: pushLocal\(\)\.on === true/, 'the subscription fact comes from the local record');
  assert.doesNotMatch(fn[0], /if \(!new URLSearchParams\(location\.search\)\.has\('push'\)\) return/,
    'the bare ?push early-return is what hid the off switch');
});

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

test('renderPushCard emits the pending note unconditionally, not behind a dead gate', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'board.js'), 'utf8');
  const fn = src.match(/function renderPushCard\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'renderPushCard not found in js/board.js');
  assert.match(fn[0], /^\s*pushPendingHtml\(st, pushManagePreselect\) \+$/m,
    'the card must concatenate the note directly, with nothing short-circuiting it');
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
  });
  const over = pushNormalizePrefs({ gauges: Array.from({ length: 25 }, (_, i) => ({ lid: `G${i}LID`, tier: 'major' })) });
  assert.equal(over.gauges.length, 20, 'client mirrors the registry cap');
  assert.deepEqual(JSON.parse(JSON.stringify(pushNormalizePrefs(null))), { ffe: true, tier: null, gauges: [] });
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

test('renderQr — hides the host when the QR lib is absent, never throws', () => {
  const host = { hidden: false, dataset: {}, innerHTML: '' };
  renderQr(host, CALTOPO_EXPORT_URL); // sandbox has no global qrcode
  assert.equal(host.hidden, true, 'graceful degrade without the vendor lib');
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
