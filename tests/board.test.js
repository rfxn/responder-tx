'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

const { smartScore, shortId, CONFIG } = loadApp();

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
  const fresh = smartScore(req('critical', 0));
  const aged = smartScore(req('critical', CONFIG.smartHalfLifeMins));
  assert.ok(Math.abs(aged - fresh / 2) < 1e-9, `fresh=${fresh} aged=${aged}`);
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

test('shortId — hashing is deterministic (same id -> same code)', () => {
  assert.equal(shortId('local-abc-123'), shortId('local-abc-123'));
});

test('shortId — distinct local ids produce distinct codes', () => {
  assert.notEqual(shortId('local-abc-123'), shortId('local-xyz-999'));
});
