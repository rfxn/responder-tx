'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const { newTeam } = require('./team-harness.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stateUrl = (secret) =>
  new URL('https://do/state' + (secret ? `?ephemeralId=${encodeURIComponent(secret)}` : ''));

test('join — a member gets a public pid and a secret ephemeralId, and they differ', async () => {
  const { relay } = await newTeam();
  const now = Date.now();
  const you = (await relay.doJoin({ handle: 'Alpha1', role: 'member' }, now)).you;
  assert.equal(you.role, 'member');
  assert.match(you.pid, UUID_RE);
  assert.match(you.ephemeralId, UUID_RE);
  assert.notEqual(you.pid, you.ephemeralId);
});

test('state — other members expose pid but never the secret ephemeralId', async () => {
  const { relay } = await newTeam();
  const now = Date.now();
  const a = (await relay.doJoin({ handle: 'AlphaOne', role: 'member' }, now)).you;
  const b = (await relay.doJoin({ handle: 'BravoTwo', role: 'member' }, now)).you;
  const state = await relay.doState(stateUrl(b.ephemeralId), now);
  const rowA = state.members.find((m) => m.pid === a.pid);
  assert.ok(rowA, 'member A appears in the roster keyed by pid');
  assert.equal(rowA.ephemeralId, undefined, 'a member row must not carry the secret');
  assert.ok(!JSON.stringify(state.members).includes(a.ephemeralId), "A's secret leaked into members[]");
  // the caller still receives its OWN secret in `you` (needed to sign its own writes)
  assert.equal(state.you.ephemeralId, b.ephemeralId);
  assert.equal(state.you.pid, b.pid);
});

test('state — viewer rows expose pid but never the secret ephemeralId', async () => {
  const { relay } = await newTeam();
  const now = Date.now();
  const m = (await relay.doJoin({ handle: 'AlphaOne', role: 'member' }, now)).you;
  const v = (await relay.doJoin({ handle: 'Watcher1', role: 'viewer' }, now)).you;
  const state = await relay.doState(stateUrl(m.ephemeralId), now);
  const rowV = state.viewers.find((x) => x.pid === v.pid);
  assert.ok(rowV, 'viewer appears keyed by pid');
  assert.equal(rowV.ephemeralId, undefined, 'a viewer row must not carry the secret');
  assert.ok(!JSON.stringify(state.viewers).includes(v.ephemeralId), "viewer's secret leaked into viewers[]");
});

test('security — a viewer holding a member\'s pid CANNOT write (position/marker/update/leave)', async () => {
  const { relay } = await newTeam();
  const now = Date.now();
  const m = (await relay.doJoin({ handle: 'AlphaOne', role: 'member' }, now)).you;
  const v = (await relay.doJoin({ handle: 'Watcher1', role: 'viewer' }, now)).you;
  // the viewer can legitimately read the member's PUBLIC pid from /state ...
  const state = await relay.doState(stateUrl(v.ephemeralId), now);
  const stolenPid = state.members.find((x) => x.handle === 'AlphaOne').pid;
  assert.equal(stolenPid, m.pid);
  // ... but the pid is not a write credential: lookup is by the secret ephemeralId, so every
  // write action rejects (person not found) — the spoof the old design allowed is closed.
  assert.equal((await relay.doPosition({ ephemeralId: stolenPid, lat: 29.75, lon: -99.35 }, now))._status, 403);
  assert.equal((await relay.doMarker({ ephemeralId: stolenPid, kind: 'hazard', label: 'x', lat: 29.75, lon: -99.35 }, now))._status, 403);
  assert.equal((await relay.doUpdate({ ephemeralId: stolenPid, role: 'viewer' }, now))._status, 403);
  await relay.doLeave({ ephemeralId: stolenPid }, now); // never errors, but must not remove the member
  const after = await relay.doState(stateUrl(v.ephemeralId), now);
  assert.ok(after.members.some((x) => x.pid === m.pid), 'a borrowed pid must not be able to remove a member');
});

test('security — the real member still writes with its own secret; a viewer with its own secret cannot', async () => {
  const { relay } = await newTeam();
  const now = Date.now();
  const m = (await relay.doJoin({ handle: 'AlphaOne', role: 'member' }, now)).you;
  const v = (await relay.doJoin({ handle: 'Watcher1', role: 'viewer' }, now)).you;
  assert.equal((await relay.doPosition({ ephemeralId: m.ephemeralId, lat: 29.75, lon: -99.35 }, now)).ok, true);
  // the existing role guard still holds for a viewer using its OWN id
  assert.equal((await relay.doPosition({ ephemeralId: v.ephemeralId, lat: 29.75, lon: -99.35 }, now))._status, 403);
});

test('join — a handle shorter than 4 characters is rejected', async () => {
  const { relay } = await newTeam();
  const out = await relay.doJoin({ handle: 'ab', role: 'member' }, Date.now());
  assert.equal(out._status, 400);
  assert.match(out.error, /handle/i);
});

test('position — out-of-range or non-numeric coordinates are rejected', async () => {
  const { relay } = await newTeam();
  const now = Date.now();
  const m = (await relay.doJoin({ handle: 'AlphaOne', role: 'member' }, now)).you;
  assert.equal((await relay.doPosition({ ephemeralId: m.ephemeralId, lat: 200, lon: 0 }, now))._status, 400);
  assert.equal((await relay.doPosition({ ephemeralId: m.ephemeralId, lat: 0, lon: -999 }, now))._status, 400);
  assert.equal((await relay.doPosition({ ephemeralId: m.ephemeralId, lat: 'abc', lon: 0 }, now))._status, 400);
});

test('sanitize — angle brackets are stripped, and new markers key by public byPid (not the secret)', async () => {
  const { relay } = await newTeam();
  const now = Date.now();
  const you = (await relay.doJoin({ handle: 'Al<b>pha', role: 'member' }, now)).you;
  assert.equal(you.handle, 'Albpha');
  assert.ok(!/[<>]/.test(you.handle));
  const mk = (await relay.doMarker({ ephemeralId: you.ephemeralId, kind: 'waypoint', label: 'ha<script>z', lat: 29.75, lon: -99.35 }, now)).marker;
  assert.ok(!/[<>]/.test(mk.label));
  assert.equal(mk.byPid, you.pid, 'a marker references the dropper by public pid');
  assert.equal(mk.byId, undefined, 'a marker must not store the secret ephemeralId');
});

test('update — a viewer can promote itself to member (pid stable) and then publish', async () => {
  const { relay } = await newTeam();
  const now = Date.now();
  const v = (await relay.doJoin({ handle: 'Watcher1', role: 'viewer' }, now)).you;
  assert.equal(v.role, 'viewer');
  const up = (await relay.doUpdate({ ephemeralId: v.ephemeralId, role: 'member', mtype: 'ground', status: 'infield' }, now)).you;
  assert.equal(up.role, 'member');
  assert.ok(up.color, 'a promoted member is assigned a color');
  assert.equal(up.pid, v.pid, 'pid is stable across a role change');
  assert.equal((await relay.doPosition({ ephemeralId: v.ephemeralId, lat: 29.75, lon: -99.35 }, now)).ok, true);
});

test('marker — the per-team cap returns 429 once full', async () => {
  const { relay } = await newTeam();
  const now = Date.now();
  const m = (await relay.doJoin({ handle: 'AlphaOne', role: 'member' }, now)).you;
  relay.team.markers = {};
  for (let i = 0; i < 200; i++) {
    relay.team.markers[`m${i}`] = { id: `m${i}`, kind: 'waypoint', label: '', lat: 0, lon: 0, ts: now };
  }
  const out = await relay.doMarker({ ephemeralId: m.ephemeralId, kind: 'waypoint', label: 'one too many', lat: 29.75, lon: -99.35 }, now);
  assert.equal(out._status, 429);
});

test('legacy — a pre-split person (no pid) gets one on next touch; a legacy byId marker does not crash', async () => {
  const { relay } = await newTeam();
  const now = Date.now();
  const legacyId = nodeCrypto.randomUUID();
  relay.team.people[legacyId] = {
    ephemeralId: legacyId, handle: 'OldHand', role: 'member', color: '#ff5252',
    lastSeen: now, joined: now, trail: [], lastPos: null,
  };
  relay.team.markers = { old1: { id: 'old1', kind: 'waypoint', label: 'legacy', lat: 0, lon: 0, by: 'OldHand', byId: legacyId, ts: now } };
  const state = await relay.doState(stateUrl(legacyId), now);
  const row = state.members.find((m) => m.handle === 'OldHand');
  assert.ok(row.pid, 'a legacy member is assigned a pid on read');
  assert.equal(row.ephemeralId, undefined, 'the legacy secret is not disclosed');
  assert.ok(state.markers.some((mk) => mk.id === 'old1'), 'a legacy byId marker is still returned');
});
