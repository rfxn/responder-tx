'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
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
