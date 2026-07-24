'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/*
 * js/team.js is a classic-script IIFE whose top level only declares functions and wires
 * window.* exports (no DOM or network at load). Evaluating it verbatim in a vm sandbox
 * surfaces window.teamQueueOps, the pure store-and-forward queue ops under test.
 */
function loadTeamQueueOps() {
  const el = () => ({
    style: {}, dataset: {}, hidden: false, textContent: '', innerHTML: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, setAttribute() {}, appendChild() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
  });
  const sandbox = {
    console, Math, Date, JSON, RegExp, Array, Object, String, Number, Boolean, Map, Set,
    parseInt, parseFloat, isNaN, isFinite, Promise, URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      createElement: el, addEventListener() {}, body: el(),
    },
    navigator: { geolocation: null, onLine: true },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { origin: 'https://example.test', pathname: '/', search: '' },
    history: { replaceState() {} },
    fetch: () => Promise.reject(new Error('network disabled in tests')),
    window: {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'team.js'), 'utf8'), sandbox, { filename: 'team.js' });
  assert.ok(sandbox.teamQueueOps, 'team.js exposes window.teamQueueOps');
  return sandbox.teamQueueOps;
}

const ops = loadTeamQueueOps();
const fix = (ts, over) => Object.assign({ lat: 29.75, lon: -99.35, acc: 8, hdg: null, spd: null, ts }, over);

test('queue — the bound matches the relay batch cap (480 ≈ 2h of 15s fixes)', () => {
  assert.equal(ops.MAX, 480);
});

test('queue — FIFO push preserves the original timestamp and accuracy of each fix', () => {
  const q = [];
  ops.push(q, fix(1000, { acc: 12.5 }), ops.MAX);
  ops.push(q, fix(2000, { acc: 3 }), ops.MAX);
  assert.equal(q.length, 2);
  assert.equal(q[0].ts, 1000);
  assert.equal(q[0].acc, 12.5);
  assert.equal(q[1].ts, 2000);
  assert.equal(q[1].acc, 3);
});

test('queue — the cap drops the OLDEST fixes first (bounded FIFO)', () => {
  const q = [];
  for (let i = 1; i <= ops.MAX + 5; i++) ops.push(q, fix(i * 1000), ops.MAX);
  assert.equal(q.length, ops.MAX);
  assert.equal(q[0].ts, 6000, 'the 5 oldest fixes were dropped');
  assert.equal(q[q.length - 1].ts, (ops.MAX + 5) * 1000, 'the newest fix is retained');
});

test('queue — a same-timestamp duplicate (unchanged GPS fix retried) is not enqueued twice', () => {
  const q = [];
  ops.push(q, fix(1000), ops.MAX);
  ops.push(q, fix(1000), ops.MAX);
  assert.equal(q.length, 1);
});

test('queue — invalid fixes (bad coords, missing ts) are ignored', () => {
  const q = [];
  ops.push(q, fix(1000, { lat: 200 }), ops.MAX);
  ops.push(q, fix(1000, { lon: -999 }), ops.MAX);
  ops.push(q, { lat: 29.75, lon: -99.35 }, ops.MAX); // no ts
  ops.push(q, null, ops.MAX);
  assert.equal(q.length, 0);
  assert.equal(ops.valid(fix(1000)), true);
  assert.equal(ops.valid(fix(NaN)), false);
});

test('queue — sanitize rebuilds a persisted queue: garbage dropped, order kept, cap applied', () => {
  const raw = [fix(3000), 'junk', fix(1000, { lat: 'x' }), fix(4000), null, fix(5000)];
  const q = ops.sanitize(raw, ops.MAX);
  assert.deepEqual([...q.map((f) => f.ts)], [3000, 4000, 5000]); // spread: vm-realm array → main-realm for strict deepEqual
  assert.deepEqual([...ops.sanitize('not-an-array', ops.MAX)], []);
  const big = [];
  for (let i = 1; i <= ops.MAX + 3; i++) big.push(fix(i * 1000));
  assert.equal(ops.sanitize(big, ops.MAX).length, ops.MAX);
});

test('queue — flush order is oldest-first (slice from the head is the batch)', () => {
  const q = [];
  for (let i = 1; i <= 10; i++) ops.push(q, fix(i * 1000), ops.MAX);
  const batch = q.slice(0, ops.MAX); // mirrors flushQueue's batch construction
  assert.deepEqual(batch.map((f) => f.ts), [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]);
});
