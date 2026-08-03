'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/*
 * js/team.js is a classic-script IIFE whose top level only declares functions and wires
 * window.* exports (no DOM or network at load). Evaluating it verbatim in a vm sandbox
 * surfaces window.teamQueueOps and window.teamMarkerOps, the pure ops under test.
 */
function loadTeamSandbox() {
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
    // core.js is not loaded here; team.js reads esc off the shared classic-script scope
    esc: (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`),
    window: {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'team.js'), 'utf8'), sandbox, { filename: 'team.js' });
  assert.ok(sandbox.teamQueueOps, 'team.js exposes window.teamQueueOps');
  assert.ok(sandbox.teamMarkerOps, 'team.js exposes window.teamMarkerOps');
  return sandbox;
}

const teamSandbox = loadTeamSandbox();
const ops = teamSandbox.teamQueueOps;
const marker = teamSandbox.teamMarkerOps;
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

/* A marker relayed without a usable ts rendered the literal "NaNs ago" in the field: two of the
   three ageStr call sites papered over it with `|| Date.now()`, and this one did not. */
test('marker popup — an undated marker drops the age clause rather than printing NaN', () => {
  for (const ts of [undefined, null, 0, '', 'not-a-date', NaN]) {
    const html = marker.popupHtml({ id: 'm1', kind: 'hazard', by: 'K9-2', ts });
    assert.ok(!/NaN/.test(html), `ts=${String(ts)} rendered NaN: ${html}`);
    assert.ok(!/\d{4,}h/.test(html), `ts=${String(ts)} measured an age from the epoch: ${html}`);
    assert.ok(!/·\s*(ago|team\.ago)/.test(html), `ts=${String(ts)} left a dangling "ago": ${html}`);
    assert.match(html, /K9-2/, 'who dropped it is still reported');
  }
  // non-vacuity: a real stamp still says how long ago, so the guard did not silence the age
  const fresh = marker.popupHtml({ id: 'm2', kind: 'hazard', by: 'K9-2', ts: Date.now() - 120000 });
  assert.match(fresh, /2m/, 'a dated marker must still carry its age');
});

test('ageStr — an unusable stamp has no age, and a usable one still reads in s/m/h', () => {
  for (const ts of [undefined, null, 0, '', 'not-a-date', NaN]) assert.equal(marker.ageStr(ts), '', String(ts));
  assert.equal(marker.ageStr(Date.now() - 30000), '30s');
  assert.equal(marker.ageStr(Date.now() - 300000), '5m');
  assert.equal(marker.ageStr(Date.now() - 7200000), '2h');
  assert.equal(marker.ageStr(Date.now() + 60000), '0s', 'a clock-skewed future stamp is not a negative age');
});
