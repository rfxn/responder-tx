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

test('type — a response team rejects a SAR-only specialty and accepts one of its own', async () => {
  const { relay } = await newTeam('Resp', null, 'response');
  const now = Date.now();
  assert.equal(relay.team.teamType, 'response');
  const bad = (await relay.doJoin({ handle: 'RespOne', role: 'member', specialty: 'searcher' }, now)).you;
  assert.equal(bad.specialty, null, 'a SAR specialty (searcher) is not valid for a response team');
  const good = (await relay.doJoin({ handle: 'RespTwo', role: 'member', specialty: 'fire' }, now)).you;
  assert.equal(good.specialty, 'fire', 'a response-scoped specialty is accepted');
});

test('type — a non-SAR team hard-gates the k9 fields off even when the client sends them', async () => {
  const { relay } = await newTeam('Comm', null, 'community');
  const now = Date.now();
  const you = (await relay.doJoin({ handle: 'CommOne', role: 'member', mtype: 'k9', k9Name: 'Rex', skills: ['live-find', 'water'], specialty: 'shelter' }, now)).you;
  assert.notEqual(you.mtype, 'k9', 'a non-SAR member cannot be typed k9');
  assert.equal(you.k9Name, '', 'k9Name is forced empty on a non-SAR team');
  assert.equal(you.skills.length, 0, 'skills are forced empty on a non-SAR team');
  assert.equal(you.specialty, 'shelter', 'a valid community specialty is kept');
});

test('type — teamType is echoed by create/join/state and stored in the registry', async () => {
  const { relay } = await newTeam('Rec', null, 'recovery');
  const now = Date.now();
  assert.equal((await relay.doCreate({ teamId: relay.team.id }, now)).teamType, 'recovery');
  const j = await relay.doJoin({ handle: 'RecOne', role: 'member', specialty: 'cleanup' }, now);
  assert.equal(j.teamType, 'recovery');
  const state = await relay.doState(stateUrl(j.you.ephemeralId), now);
  assert.equal(state.teamType, 'recovery');
});

test('type — an unknown teamType at create coerces to sar and SAR k9 still works', async () => {
  const { relay } = await newTeam('Weird', null, 'not-a-real-type');
  const now = Date.now();
  assert.equal(relay.team.teamType, 'sar', 'a hostile/unknown type is never persisted verbatim');
  const you = (await relay.doJoin({ handle: 'SarK9', role: 'member', mtype: 'k9', k9Name: 'Fido', skills: ['live-find'] }, now)).you;
  assert.equal(you.mtype, 'k9');
  assert.equal(you.k9Name, 'Fido');
  assert.deepEqual([...you.skills], ['live-find']);
  assert.equal(you.specialty, 'k9');
});

test('type — a legacy team with no teamType reads as sar and rejects a non-SAR specialty', async () => {
  const { relay } = await newTeam(); // default create — no teamType, mirrors a pre-feature team
  const now = Date.now();
  delete relay.team.teamType; // simulate state persisted before the field existed
  const you = (await relay.doJoin({ handle: 'LegacyM', role: 'member', mtype: 'ground', specialty: 'fire' }, now)).you;
  assert.equal(you.specialty, null, 'fire is not a SAR specialty, so it is rejected under the sar fallback');
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

test('status — rehab is an accepted member status and echoed; an unknown status still coerces to infield', async () => {
  const { relay } = await newTeam();
  const now = Date.now();
  const you = (await relay.doJoin({ handle: 'RehabOne', role: 'member', status: 'rehab' }, now)).you;
  assert.equal(you.status, 'rehab', 'rehab is a valid status');
  const state = await relay.doState(stateUrl(you.ephemeralId), now);
  assert.equal(state.members.find((m) => m.pid === you.pid).status, 'rehab', 'rehab is echoed in the roster');
  // a non-SAR team keeps the same uniform status set
  const { relay: rec } = await newTeam('Rec', null, 'recovery');
  const recYou = (await rec.doJoin({ handle: 'RecRehab', role: 'member', status: 'rehab', specialty: 'cleanup' }, now)).you;
  assert.equal(recYou.status, 'rehab', 'rehab is uniform across team types');
  // backward compat: a fresh member sent an unknown status coerces to the first allowed status
  const coerced = (await relay.doJoin({ handle: 'BadStatus', role: 'member', status: 'napping' }, now)).you;
  assert.equal(coerced.status, 'infield', 'an unknown status coerces to infield');
});

test('marker — a member-pid assignee is stored and echoed; a viewer/bogus/absent assignee is null', async () => {
  const { relay } = await newTeam();
  const now = Date.now();
  const a = (await relay.doJoin({ handle: 'AlphaOne', role: 'member' }, now)).you;
  const b = (await relay.doJoin({ handle: 'BravoTwo', role: 'member' }, now)).you;
  const vwr = (await relay.doJoin({ handle: 'Watcher1', role: 'viewer' }, now)).you;
  // assign to a real member by public pid
  const mk = (await relay.doMarker({ ephemeralId: a.ephemeralId, kind: 'waypoint', label: 'assigned', lat: 29.75, lon: -99.35, assignee: b.pid }, now)).marker;
  assert.equal(mk.assignee, b.pid, 'a current member pid is stored as the assignee');
  const state = await relay.doState(stateUrl(a.ephemeralId), now);
  assert.equal(state.markers.find((x) => x.id === mk.id).assignee, b.pid, 'the assignee is echoed via state');
  // a viewer cannot be an assignee (members only)
  const mkV = (await relay.doMarker({ ephemeralId: a.ephemeralId, kind: 'hazard', label: 'v', lat: 29.75, lon: -99.35, assignee: vwr.pid }, now)).marker;
  assert.equal(mkV.assignee, null, 'a viewer pid is not a valid assignee');
  // a garbage value coerces to null
  const mkBad = (await relay.doMarker({ ephemeralId: a.ephemeralId, kind: 'waypoint', label: 'x', lat: 29.75, lon: -99.35, assignee: 'not-a-real-pid' }, now)).marker;
  assert.equal(mkBad.assignee, null, 'a non-uuid assignee coerces to null');
  // an unassigned marker carries a null assignee (unchanged behavior)
  const mkNone = (await relay.doMarker({ ephemeralId: a.ephemeralId, kind: 'waypoint', label: 'plain', lat: 29.75, lon: -99.35 }, now)).marker;
  assert.equal(mkNone.assignee, null, 'an omitted assignee is null');
});

test('defaults — invite filter presets are sanitized, persisted, and echoed by create/join/state', async () => {
  const filters = { type: 'rescue', county: 'Kerr', q: 'lowwater', window: '120', dist: '25', inView: true, bogus: 'nope' };
  const { relay } = await newTeam('Filt', { lat: 29.7, lon: -98.5, zoom: 10, filters });
  const now = Date.now();
  const expected = { type: 'rescue', county: 'Kerr', q: 'lowwater', window: '120', dist: '25', inView: true };
  // the DO runs in a vm realm, so round-trip through JSON to compare against a main-realm literal
  const plain = (o) => JSON.parse(JSON.stringify(o));
  assert.deepEqual(plain(relay.team.defaults.filters), expected, 'only whitelisted filter keys persist; inView kept, bogus dropped');
  // create echoes the stored defaults back to the creator
  assert.deepEqual(plain((await relay.doCreate({ teamId: relay.team.id }, now)).defaults.filters), expected);
  // join and state both carry the preset so members/viewers can apply it on open
  const j = await relay.doJoin({ handle: 'FiltOne', role: 'member' }, now);
  assert.deepEqual(plain(j.defaults.filters), expected, 'join echoes the filter preset');
  const state = await relay.doState(stateUrl(j.you.ephemeralId), now);
  assert.deepEqual(plain(state.defaults.filters), expected, 'state echoes the filter preset');
  // a team created with no defaults still behaves exactly as before
  const { relay: noDef } = await newTeam();
  assert.equal(noDef.team.defaults, null, 'no defaults means null, unchanged behavior');
});

test('rejoin — re-joining with the saved ephemeralId reuses one person; after a beacon leave it re-creates from the saved profile without a duplicate', async () => {
  const { relay } = await newTeam();
  const now = Date.now();
  const you = (await relay.doJoin({ handle: 'AlphaOne', role: 'member', mtype: 'ground', specialty: 'medical', status: 'standby' }, now)).you;
  // a foreground rejoin re-POSTs join with the SAME ephemeralId → the same person, no duplicate
  const again = (await relay.doJoin({ handle: 'AlphaOne', role: 'member', ephemeralId: you.ephemeralId, mtype: 'ground', specialty: 'medical', status: 'standby' }, now)).you;
  assert.equal(again.ephemeralId, you.ephemeralId, 'the saved ephemeralId is retained on an idempotent rejoin');
  assert.equal(again.pid, you.pid, 'the public pid is stable across a rejoin');
  let state = await relay.doState(stateUrl(you.ephemeralId), now);
  assert.equal(state.members.length, 1, 'an idempotent rejoin does not create a duplicate member');
  assert.equal(state.members[0].specialty, 'medical', 'the profile is preserved across the rejoin');
  // simulate the background beacon deleting the member, then a foreground rejoin from the saved identity
  await relay.doLeave({ ephemeralId: you.ephemeralId }, now);
  assert.equal((await relay.doState(stateUrl(you.ephemeralId), now)).members.length, 0, 'the beacon leave removed the member');
  const restored = (await relay.doJoin({ handle: 'AlphaOne', role: 'member', ephemeralId: you.ephemeralId, mtype: 'ground', specialty: 'medical', status: 'standby' }, now)).you;
  assert.match(restored.ephemeralId, UUID_RE);
  assert.equal(restored.handle, 'AlphaOne', 'the handle is restored from the saved identity');
  assert.equal(restored.specialty, 'medical', 'the profile is restored on a post-beacon re-create');
  const finalState = await relay.doState(stateUrl(restored.ephemeralId), now);
  assert.equal(finalState.members.length, 1, 'exactly one member after a beacon leave then a foreground rejoin');
});

/* ---------- batched backfill (store-and-forward, /positions) ---------- */

test('backfill — a valid batch inserts trail points with their ORIGINAL timestamps, in ts order', async () => {
  const { relay } = await newTeam();
  const now = Date.now();
  const you = (await relay.doJoin({ handle: 'AlphaOne', role: 'member' }, now)).you;
  const fixes = [
    { lat: 29.7500, lon: -99.3500, acc: 8, ts: now - 90000 },
    { lat: 29.7520, lon: -99.3520, acc: 9, ts: now - 60000 },
    { lat: 29.7540, lon: -99.3540, acc: 7, ts: now - 30000 },
  ];
  // send deliberately out of order — the relay must sort by ts
  const out = await relay.doPositions({ ephemeralId: you.ephemeralId, fixes: [fixes[2], fixes[0], fixes[1]] }, now);
  assert.equal(out.ok, true);
  assert.equal(out.accepted, 3);
  assert.equal(out.rejected, 0);
  const state = await relay.doState(stateUrl(you.ephemeralId), now);
  const row = state.members.find((m) => m.pid === you.pid);
  const ts = row.trail.map((pt) => pt.ts);
  assert.deepEqual([...ts], fixes.map((f) => f.ts), 'trail carries the original client timestamps, sorted');
  assert.equal(row.lastPos.ts, fixes[2].ts, 'lastPos advanced to the newest backfilled fix');
  assert.equal(row.lastPos.acc, 7, 'accuracy of the newest fix is preserved');
});

test('backfill — future-stamped and older-than-retention fixes are rejected, valid ones still land', async () => {
  const { relay } = await newTeam();
  const now = Date.now();
  const you = (await relay.doJoin({ handle: 'AlphaOne', role: 'member' }, now)).you;
  const out = await relay.doPositions({
    ephemeralId: you.ephemeralId,
    fixes: [
      { lat: 29.75, lon: -99.35, ts: now + 60000 },              // future — rejected
      { lat: 29.75, lon: -99.35, ts: now - 3 * 3600 * 1000 },    // older than the 2h trail window — rejected
      { lat: 200, lon: -99.35, ts: now - 30000 },                // bad coordinates — rejected
      { lat: 29.76, lon: -99.36, ts: now - 30000 },              // valid
    ],
  }, now);
  assert.equal(out.ok, true);
  assert.equal(out.accepted, 1);
  assert.equal(out.rejected, 3);
  const state = await relay.doState(stateUrl(you.ephemeralId), now);
  const row = state.members.find((m) => m.pid === you.pid);
  assert.equal(row.trail.length, 1, 'only the valid fix entered the trail');
  assert.equal(row.trail[0].ts, now - 30000);
});

test('backfill — an oversized batch is rejected whole (400), matching the client queue bound', async () => {
  const { relay } = await newTeam();
  const now = Date.now();
  const you = (await relay.doJoin({ handle: 'AlphaOne', role: 'member' }, now)).you;
  const fixes = [];
  for (let i = 0; i < 481; i++) fixes.push({ lat: 29.75, lon: -99.35, ts: now - i * 1000 });
  const out = await relay.doPositions({ ephemeralId: you.ephemeralId, fixes }, now);
  assert.equal(out._status, 400);
  assert.match(out.error, /480/);
  assert.equal((await relay.doPositions({ ephemeralId: you.ephemeralId, fixes: 'nope' }, now))._status, 400, 'a non-array fixes payload is rejected');
});

test('backfill — auth matches a live post: stolen pid rejected, viewer rejected, non-member rejected', async () => {
  const { relay } = await newTeam();
  const now = Date.now();
  const m = (await relay.doJoin({ handle: 'AlphaOne', role: 'member' }, now)).you;
  const v = (await relay.doJoin({ handle: 'Watcher1', role: 'viewer' }, now)).you;
  const fixes = [{ lat: 29.75, lon: -99.35, ts: now - 1000 }];
  // the public pid is not a write credential (same spoof-closure as /position)
  assert.equal((await relay.doPositions({ ephemeralId: m.pid, fixes }, now))._status, 403);
  // a viewer's own secret still cannot publish
  assert.equal((await relay.doPositions({ ephemeralId: v.ephemeralId, fixes }, now))._status, 403);
  // garbage credential
  assert.equal((await relay.doPositions({ ephemeralId: 'not-a-uuid', fixes }, now))._status, 403);
  // the real member works
  assert.equal((await relay.doPositions({ ephemeralId: m.ephemeralId, fixes }, now)).ok, true);
});

test('backfill — merges into an existing live trail in time order and never regresses a fresher lastPos', async () => {
  const { relay } = await newTeam();
  const now = Date.now();
  const you = (await relay.doJoin({ handle: 'AlphaOne', role: 'member' }, now)).you;
  // a live post lands NOW (server-stamped)
  assert.equal((await relay.doPosition({ ephemeralId: you.ephemeralId, lat: 29.7600, lon: -99.3600, acc: 5 }, now)).ok, true);
  // then the dead-zone backlog arrives: all OLDER than the live fix
  const out = await relay.doPositions({
    ephemeralId: you.ephemeralId,
    fixes: [
      { lat: 29.7500, lon: -99.3500, ts: now - 60000 },
      { lat: 29.7550, lon: -99.3550, ts: now - 30000 },
    ],
  }, now);
  assert.equal(out.accepted, 2);
  const state = await relay.doState(stateUrl(you.ephemeralId), now);
  const row = state.members.find((m) => m.pid === you.pid);
  const ts = row.trail.map((pt) => pt.ts);
  assert.deepEqual([...ts], [...ts].sort((a, b) => a - b), 'trail is time-ordered after the merge');
  assert.equal(row.trail.length, 3, 'backfilled points joined the live point');
  assert.equal(row.lastPos.lat, 29.76, 'the fresher live lastPos is NOT regressed by older backfill');
});

test('backfill — the legacy single /position protocol is unchanged alongside the batch route', async () => {
  const { relay } = await newTeam();
  const now = Date.now();
  const you = (await relay.doJoin({ handle: 'AlphaOne', role: 'member' }, now)).you;
  const single = await relay.doPosition({ ephemeralId: you.ephemeralId, lat: 29.75, lon: -99.35, acc: 4, hdg: 90, spd: 1.5 }, now);
  assert.deepEqual(JSON.parse(JSON.stringify(single)), { ok: true }, 'single-post response shape is unchanged');
  const state = await relay.doState(stateUrl(you.ephemeralId), now);
  const row = state.members.find((m) => m.pid === you.pid);
  assert.equal(row.lastPos.ts, now, 'a live post is still server-stamped');
  assert.equal(row.lastPos.acc, 4);
  assert.equal(row.trail.length, 1);
  // out-of-range live coordinates still reject exactly as before
  assert.equal((await relay.doPosition({ ephemeralId: you.ephemeralId, lat: 200, lon: 0 }, now))._status, 400);
});
