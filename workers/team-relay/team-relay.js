// responder-team-relay — Cloudflare Worker hosting the TeamRelay Durable Object.
// One DO instance per team holds the *only* copy of live team state: members, viewers,
// latest positions, and capped breadcrumb trails. State lives in Cloudflare, never in git.
// A Pages project cannot host a Durable Object, so this ships as a standalone Worker and the
// Pages Functions under functions/api/team/ bind to it (env.TEAM) and forward requests here.
//
// Privacy invariants enforced HERE (authoritative), not just at the edge:
//   - handles are >= 4 chars (members AND viewers)
//   - viewers can never publish a position (role check on /position)
//   - stale members/viewers, trails, and whole idle teams are TTL-reaped server-side
//   - nothing is ever persisted outside this DO's Cloudflare storage

const HANDLE_MIN = 4;
const HANDLE_MAX = 24;
const NAME_MAX = 40;
const MAX_PEOPLE = 100;

const MEMBER_STALE_MS = 20 * 60 * 1000;   // a member/viewer silent this long is dropped
const TEAM_TTL_MS = 24 * 60 * 60 * 1000;  // a team idle this long is deleted whole
const ALARM_EVERY_MS = 15 * 60 * 1000;    // backstop sweep cadence

const TRAIL_MAX_POINTS = 300;
const TRAIL_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2h
const TRAIL_MIN_MOVE_M = 15;                 // decimate: skip points closer than this
const TRAIL_MIN_GAP_MS = 12 * 1000;          // ...unless this much time has passed

// SAR member model + team-scoped shared markers (v0.97.4). These allow-sets are the
// authoritative server-side whitelist; the client picklists mirror them but the DO enforces.
const K9_NAME_MAX = 24;
const MARKER_LABEL_MAX = 60;
const MAX_MARKERS = 200;
const MARKER_TTL_MS = 12 * 60 * 60 * 1000;   // a shared team marker ages out after this
const MAX_SKILLS = 8;
const MEMBER_TYPES = ['ground', 'k9'];
const STATUSES = ['infield', 'standby', 'unavailable'];
const SPECIALTIES = ['searcher', 'medical', 'support', 'drone', 'comms', 'swiftwater', 'command', 'logistics'];
// 'HRD' retired from the offered list (cadaver covers it); values already stored on a member are
// preserved on read and on partial updates that omit skills — only a fresh skills array re-filters
const K9_SKILLS = ['live-find', 'trailing', 'cadaver', 'area', 'water', 'evidence', 'avalanche'];
const MARKER_KINDS = ['waypoint', 'hazard', 'search-area'];

// Global team registry (v0.97.5) — a single well-known DO (idFromName('registry')) tracks live
// team ids + light metadata so the LAN-only master oversight view can enumerate teams. It holds
// NO positions/markers; the overview fans out to each team's read-only peek on demand. Not
// externally addressable (team ids are UUIDs; 'registry' is never routed through the edge).
const MAX_REGISTRY = 1000;         // cap on team ids the registry tracks (oldest registration dropped first)
const REGISTRY_FANOUT_MAX = 200;   // max teams aggregated per overview call (bounds DO subrequest budget)

// distinct, high-contrast qualitative palette for member markers/trails
const MEMBER_COLORS = [
  '#ff5252', '#40c4ff', '#69f0ae', '#ffd740', '#e040fb', '#ff6e40',
  '#7c4dff', '#18ffff', '#b2ff59', '#ff4081', '#64ffda', '#ffab40',
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sanitizeText(s, max) {
  return String(s == null ? '' : s).replace(/[\x00-\x1f\x7f<>]/g, '').trim().slice(0, max);
}

function haversineM(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// optional team-open defaults: area-of-operations view (+ a small filter whitelist). Coordinates
// out of range or a non-object drop to null so a malformed default never breaks a member's open.
function sanitizeDefaults(d) {
  if (!d || typeof d !== 'object') return null;
  const out = {};
  const lat = Number(d.lat), lon = Number(d.lon), zoom = Number(d.zoom);
  if (Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
    out.lat = lat; out.lon = lon;
    if (Number.isFinite(zoom)) out.zoom = Math.max(3, Math.min(18, Math.round(zoom)));
  }
  if (d.filters && typeof d.filters === 'object') {
    const f = {};
    for (const k of ['tab', 'county', 'type']) {
      if (typeof d.filters[k] === 'string') { const v = sanitizeText(d.filters[k], 40); if (v) f[k] = v; }
    }
    if (Object.keys(f).length) out.filters = f;
  }
  return Object.keys(out).length ? out : null;
}

export class TeamRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.team = null;
    this.ready = state.blockConcurrencyWhile(async () => {
      this.team = (await state.storage.get('team')) || null;
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\/+/, '');
    const now = Date.now();
    let body = {};
    if (request.method === 'POST') {
      try { body = await request.json(); } catch { body = {}; }
      if (!body || typeof body !== 'object') body = {};
    }
    let out;
    switch (action) {
      case 'create': out = await this.doCreate(body, now); break;
      case 'join': out = await this.doJoin(body, now); break;
      case 'update': out = await this.doUpdate(body, now); break;
      case 'position': out = await this.doPosition(body, now); break;
      case 'marker': out = await this.doMarker(body, now); break;
      case 'unmark': out = await this.doUnmark(body, now); break;
      case 'state': out = await this.doState(url, now); break;
      case 'leave': out = await this.doLeave(body, now); break;
      case 'peek': out = await this.doPeek(now); break;
      case 'register': out = await this.doRegister(body, now); break;
      case 'reglist': out = await this.doReglist(now); break;
      case 'overview': out = await this.doOverview(now); break;
      default: out = { _status: 404, error: 'unknown action' };
    }
    const status = out._status || 200;
    delete out._status;
    return new Response(JSON.stringify(out), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
    });
  }

  async persist(now) {
    if (this.team) this.team.lastActive = now;
    await this.state.storage.put('team', this.team);
    try { await this.state.storage.setAlarm(now + ALARM_EVERY_MS); } catch { /* alarms unsupported in some local backends — TTL still enforced lazily on each request */ }
  }

  // drop silent people and age out trail points; returns nothing (mutates this.team)
  reap(now) {
    if (!this.team) return;
    for (const [id, p] of Object.entries(this.team.people)) {
      if (now - p.lastSeen > MEMBER_STALE_MS) { delete this.team.people[id]; continue; }
      if (p.trail && p.trail.length) {
        p.trail = p.trail.filter((pt) => now - pt.ts <= TRAIL_MAX_AGE_MS).slice(-TRAIL_MAX_POINTS);
      }
    }
    this.reapMarkers(now);
  }

  pickColor() {
    const used = {};
    for (const p of Object.values(this.team.people)) if (p.role === 'member' && p.color) used[p.color] = (used[p.color] || 0) + 1;
    let best = MEMBER_COLORS[0], bestN = Infinity;
    for (const c of MEMBER_COLORS) { const n = used[c] || 0; if (n < bestN) { bestN = n; best = c; } }
    return best;
  }

  async doCreate(body, now) {
    const teamId = String(body.teamId || '');
    if (!UUID_RE.test(teamId)) return { _status: 400, error: 'bad team id' };
    if (!this.team) {
      this.team = {
        id: teamId, name: sanitizeText(body.name, NAME_MAX), created: now, lastActive: now,
        people: {}, markers: {}, defaults: sanitizeDefaults(body.defaults),
      };
      await this.persist(now);
      await this.registerInRegistry(this.team.id, this.team.name, this.team.created, now);
    }
    return { teamId: this.team.id, name: this.team.name, created: this.team.created, defaults: this.team.defaults || null };
  }

  // apply the SAR profile fields to a member record, keeping prior values for any field the caller
  // omits (so a lone status toggle does not wipe type/skills). Switching type clears the other
  // type's fields. Never called for viewers — they carry no profile.
  applyProfile(person, body) {
    if (MEMBER_TYPES.includes(body.mtype)) person.mtype = body.mtype;
    if (!MEMBER_TYPES.includes(person.mtype)) person.mtype = 'ground';
    if (STATUSES.includes(body.status)) person.status = body.status;
    if (!STATUSES.includes(person.status)) person.status = 'infield';
    if (person.mtype === 'k9') {
      if (typeof body.k9Name === 'string') person.k9Name = sanitizeText(body.k9Name, K9_NAME_MAX);
      if (!person.k9Name) person.k9Name = '';
      if (Array.isArray(body.skills)) person.skills = body.skills.filter((s) => K9_SKILLS.includes(s)).slice(0, MAX_SKILLS);
      if (!Array.isArray(person.skills)) person.skills = [];
      person.specialty = 'k9';
    } else {
      if ('specialty' in body) person.specialty = SPECIALTIES.includes(body.specialty) ? body.specialty : null;
      if (person.specialty === 'k9') person.specialty = null;
      person.k9Name = '';
      person.skills = [];
    }
  }

  clearProfile(person) {
    person.color = undefined; person.lastPos = null; person.trail = [];
    person.mtype = undefined; person.specialty = undefined; person.k9Name = undefined;
    person.skills = undefined; person.status = undefined;
  }

  validateHandleRole(body) {
    const handle = sanitizeText(body.handle, HANDLE_MAX);
    if (handle.length < HANDLE_MIN) return { error: `handle must be at least ${HANDLE_MIN} characters` };
    const role = body.role === 'viewer' ? 'viewer' : body.role === 'member' ? 'member' : null;
    if (!role) return { error: 'role must be member or viewer' };
    return { handle, role };
  }

  async doJoin(body, now) {
    if (!this.team) return { _status: 404, error: 'team not found or expired' };
    const v = this.validateHandleRole(body);
    if (v.error) return { _status: 400, error: v.error };
    this.reap(now);
    let id = String(body.ephemeralId || '');
    const existing = UUID_RE.test(id) ? this.team.people[id] : null;
    if (!existing) {
      if (Object.keys(this.team.people).length >= MAX_PEOPLE) return { _status: 429, error: 'team is full' };
      id = crypto.randomUUID();
    }
    const person = existing || { ephemeralId: id, pid: crypto.randomUUID(), joined: now, trail: [], lastPos: null };
    this.pidOf(person); // legacy rejoin: mint a public id if this person predates the pid split
    person.handle = v.handle;
    person.role = v.role;
    person.lastSeen = now;
    if (v.role === 'member') { if (!person.color) person.color = this.pickColor(); this.applyProfile(person, body); }
    else this.clearProfile(person);
    this.team.people[id] = person;
    await this.persist(now);
    return { teamId: this.team.id, name: this.team.name, defaults: this.team.defaults || null, you: this.publicSelf(person) };
  }

  // change your own record after joining: role, SAR type/specialty/skills, and/or status. Identified
  // by ephemeralId (must already be in the team); no handle change here.
  async doUpdate(body, now) {
    if (!this.team) return { _status: 404, error: 'team not found or expired' };
    const id = String(body.ephemeralId || '');
    const person = UUID_RE.test(id) ? this.team.people[id] : null;
    if (!person) return { _status: 403, error: 'not a member of this team' };
    this.reap(now);
    const nextRole = body.role === 'viewer' ? 'viewer' : body.role === 'member' ? 'member' : null;
    if (nextRole && nextRole !== person.role) {
      person.role = nextRole;
      if (nextRole === 'member') { if (!person.color) person.color = this.pickColor(); this.applyProfile(person, body); }
      else this.clearProfile(person);
    } else if (person.role === 'member') {
      this.applyProfile(person, body);
    }
    person.lastSeen = now;
    await this.persist(now);
    return { teamId: this.team.id, name: this.team.name, you: this.publicSelf(person) };
  }

  async doPosition(body, now) {
    if (!this.team) return { _status: 404, error: 'team not found or expired' };
    const id = String(body.ephemeralId || '');
    const person = UUID_RE.test(id) ? this.team.people[id] : null;
    if (!person) return { _status: 403, error: 'not a member of this team' };
    if (person.role !== 'member') return { _status: 403, error: 'viewers cannot publish a position' };
    const lat = Number(body.lat), lon = Number(body.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return { _status: 400, error: 'invalid coordinates' };
    }
    const acc = Number.isFinite(Number(body.acc)) ? Number(body.acc) : null;
    const hdg = Number.isFinite(Number(body.hdg)) ? Number(body.hdg) : null;
    const spd = Number.isFinite(Number(body.spd)) ? Number(body.spd) : null;
    person.lastPos = { lat, lon, acc, hdg, spd, ts: now };
    person.lastSeen = now;
    if (!person.trail) person.trail = [];
    const last = person.trail[person.trail.length - 1];
    if (!last || now - last.ts > TRAIL_MIN_GAP_MS || haversineM(last, { lat, lon }) > TRAIL_MIN_MOVE_M) {
      person.trail.push({ lat, lon, ts: now });
    }
    person.trail = person.trail.filter((pt) => now - pt.ts <= TRAIL_MAX_AGE_MS).slice(-TRAIL_MAX_POINTS);
    this.reap(now);
    await this.persist(now);
    return { ok: true };
  }

  async doState(url, now) {
    if (!this.team) return { _status: 404, error: 'team not found or expired' };
    const id = url.searchParams.get('ephemeralId') || '';
    // polling counts as presence: keep the caller alive even when stationary / just watching
    if (UUID_RE.test(id) && this.team.people[id]) this.team.people[id].lastSeen = now;
    this.reap(now);
    const members = [], viewers = [];
    for (const p of Object.values(this.team.people)) {
      if (p.role === 'member') members.push(this.publicMember(p));
      else viewers.push({ pid: this.pidOf(p), handle: p.handle, role: 'viewer', lastSeen: p.lastSeen });
    }
    await this.persist(now);
    return {
      teamId: this.team.id, name: this.team.name, now,
      you: UUID_RE.test(id) && this.team.people[id] ? this.publicSelf(this.team.people[id]) : null,
      members, viewers, markers: Object.values(this.team.markers || {}), defaults: this.team.defaults || null,
    };
  }

  async doLeave(body, now) {
    if (!this.team) return { ok: true };
    const id = String(body.ephemeralId || '');
    if (UUID_RE.test(id) && this.team.people[id]) { delete this.team.people[id]; await this.persist(now); }
    return { ok: true };
  }

  // read-only snapshot for the master oversight view: same shape as state but NEVER persists, so
  // observing a team does not reset its idle TTL. In-memory reap only, for a clean view.
  async doPeek(now) {
    if (!this.team) return { _status: 404, error: 'team not found or expired' };
    this.reap(now);
    const members = [], viewers = [];
    for (const p of Object.values(this.team.people)) {
      if (p.role === 'member') members.push(this.publicMember(p));
      else viewers.push({ pid: this.pidOf(p), handle: p.handle, role: 'viewer', lastSeen: p.lastSeen });
    }
    return {
      teamId: this.team.id, name: this.team.name, now, lastActive: this.team.lastActive || null,
      members, viewers, markers: Object.values(this.team.markers || {}), defaults: this.team.defaults || null,
    };
  }

  /* ---------- registry (this === the well-known idFromName('registry') instance) ---------- */

  // best-effort: record a newly created team's id in the registry DO. Never blocks create — a
  // registry outage does not fail a team; the master view self-heals as new teams register.
  async registerInRegistry(teamId, name, created, now) {
    try {
      const reg = this.env.TEAM.get(this.env.TEAM.idFromName('registry'));
      await reg.fetch(new Request('https://do/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId, name, created }),
      }));
    } catch { /* registry unreachable — team still works; enumeration catches up on the next create */ }
  }

  async loadRegistry() {
    return (await this.state.storage.get('registry')) || { teams: {} };
  }

  async doRegister(body, now) {
    const teamId = String(body.teamId || '');
    if (!UUID_RE.test(teamId)) return { _status: 400, error: 'bad team id' };
    const reg = await this.loadRegistry();
    reg.teams[teamId] = { name: sanitizeText(body.name, NAME_MAX), created: Number(body.created) || now, reg: now };
    const ids = Object.keys(reg.teams);
    if (ids.length > MAX_REGISTRY) {
      ids.sort((a, b) => (reg.teams[a].reg || 0) - (reg.teams[b].reg || 0));
      for (const id of ids.slice(0, ids.length - MAX_REGISTRY)) delete reg.teams[id];
    }
    await this.state.storage.put('registry', reg);
    return { ok: true, count: Object.keys(reg.teams).length };
  }

  // lightweight enumeration: ids + name + created only, no positions
  async doReglist(now) {
    const reg = await this.loadRegistry();
    const teams = Object.entries(reg.teams)
      .map(([id, e]) => ({ id, name: e.name || '', created: e.created || null }))
      .sort((a, b) => (b.created || 0) - (a.created || 0));
    return { now, teamCount: teams.length, teams };
  }

  // full oversight aggregation: fan out to each registered team's read-only peek, aggregate
  // makeup + a combined viewer roster, and prune ids whose team DO has expired (404).
  async doOverview(now) {
    const reg = await this.loadRegistry();
    const ids = Object.keys(reg.teams).slice(0, REGISTRY_FANOUT_MAX);
    const results = await Promise.all(ids.map(async (id) => {
      try {
        const stub = this.env.TEAM.get(this.env.TEAM.idFromName(id));
        const res = await stub.fetch(new Request('https://do/peek', { method: 'GET' }));
        if (res.status === 404) return { id, dead: true };
        if (!res.ok) return { id, skip: true };
        return { id, data: await res.json() };
      } catch { return { id, skip: true }; }
    }));
    const teams = [], viewers = [], dead = [];
    for (const r of results) {
      if (r.dead) { dead.push(r.id); continue; }
      if (r.skip || !r.data) continue;
      const d = r.data, meta = reg.teams[r.id] || {};
      teams.push({
        id: r.id, name: d.name || meta.name || '', created: meta.created || null,
        lastActive: d.lastActive || null,
        members: d.members || [], viewers: d.viewers || [], markers: d.markers || [], defaults: d.defaults || null,
      });
      for (const v of (d.viewers || [])) {
        viewers.push({ teamId: r.id, teamName: d.name || meta.name || '', handle: v.handle, pid: v.pid, lastSeen: v.lastSeen });
      }
    }
    if (dead.length) {
      for (const id of dead) delete reg.teams[id];
      await this.state.storage.put('registry', reg);
    }
    teams.sort((a, b) => (b.created || 0) - (a.created || 0));
    viewers.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    return { now, teamCount: teams.length, memberCount: teams.reduce((n, t) => n + t.members.length, 0), viewerCount: viewers.length, teams, viewers, pruned: dead.length };
  }

  // drop a shared, team-scoped map marker (waypoint / hazard / search-area). Members only —
  // viewers are rejected, mirroring the position write guard.
  async doMarker(body, now) {
    if (!this.team) return { _status: 404, error: 'team not found or expired' };
    const id = String(body.ephemeralId || '');
    const person = UUID_RE.test(id) ? this.team.people[id] : null;
    if (!person) return { _status: 403, error: 'not a member of this team' };
    if (person.role !== 'member') return { _status: 403, error: 'viewers cannot drop markers' };
    const lat = Number(body.lat), lon = Number(body.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return { _status: 400, error: 'invalid coordinates' };
    }
    if (!this.team.markers) this.team.markers = {};
    this.reapMarkers(now);
    if (Object.keys(this.team.markers).length >= MAX_MARKERS) return { _status: 429, error: 'too many team markers' };
    const kind = MARKER_KINDS.includes(body.kind) ? body.kind : 'waypoint';
    const mid = crypto.randomUUID();
    this.team.markers[mid] = { id: mid, kind, label: sanitizeText(body.label, MARKER_LABEL_MAX), lat, lon, by: person.handle, byPid: this.pidOf(person), ts: now };
    person.lastSeen = now;
    await this.persist(now);
    return { ok: true, marker: this.team.markers[mid] };
  }

  // remove a shared marker. Any member may clear one (trusted private team); viewers cannot.
  async doUnmark(body, now) {
    if (!this.team) return { ok: true };
    const id = String(body.ephemeralId || '');
    const person = UUID_RE.test(id) ? this.team.people[id] : null;
    if (!person || person.role !== 'member') return { _status: 403, error: 'not allowed' };
    const mid = String(body.markerId || '');
    if (this.team.markers && this.team.markers[mid]) { delete this.team.markers[mid]; person.lastSeen = now; await this.persist(now); }
    return { ok: true };
  }

  reapMarkers(now) {
    if (!this.team || !this.team.markers) return;
    for (const [mid, mk] of Object.entries(this.team.markers)) {
      if (now - mk.ts > MARKER_TTL_MS) delete this.team.markers[mid];
    }
  }

  // public keying/display id, distinct from the secret write-credential ephemeralId; minted on
  // first need so people who predate the pid split (legacy state) get one on next touch
  pidOf(p) {
    if (!p.pid) p.pid = crypto.randomUUID();
    return p.pid;
  }

  // the caller's OWN record: the only response that carries the secret ephemeralId (its write
  // credential). pid is the public id echoed to everyone else; the client self-detects by it.
  publicSelf(p) {
    return {
      ephemeralId: p.ephemeralId, pid: this.pidOf(p), handle: p.handle, role: p.role, color: p.color || null,
      mtype: p.mtype || null, specialty: p.specialty || null, k9Name: p.k9Name || '',
      skills: p.skills || [], status: p.status || null,
    };
  }

  // another participant's row: public pid only — the secret ephemeralId is never disclosed here
  publicMember(p) {
    return {
      pid: this.pidOf(p), handle: p.handle, role: 'member', color: p.color || null,
      lastPos: p.lastPos || null, lastSeen: p.lastSeen, trail: p.trail || [],
      mtype: p.mtype || 'ground', specialty: p.specialty || null, k9Name: p.k9Name || '',
      skills: p.skills || [], status: p.status || 'infield',
    };
  }

  async alarm() {
    await this.ready;
    const now = Date.now();
    if (!this.team) return;
    this.reap(now);
    const empty = Object.keys(this.team.people).length === 0;
    if (empty && now - this.team.lastActive > TEAM_TTL_MS) {
      this.team = null;
      await this.state.storage.deleteAll();
      return;
    }
    await this.state.storage.put('team', this.team);
    try { await this.state.storage.setAlarm(now + ALARM_EVERY_MS); } catch { /* local backend without alarms */ }
  }
}

// Public entry — used only for local `wrangler dev` verification. In production this Worker is
// not publicly routable (workers_dev=false, no routes); Pages Functions reach the DO via the
// TEAM binding and invoke TeamRelay.fetch() directly. Kept as a thin forwarder so the exact
// same DO code path is exercised locally and in production.
const TEAM_PATH_RE = /^\/api\/team\/(?:(create)|([0-9a-f-]{36})\/(join|update|position|marker|unmark|state|leave))$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(TEAM_PATH_RE);
    if (!m) return new Response('not found', { status: 404 });
    let teamId, action;
    if (m[1]) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      teamId = crypto.randomUUID();
      action = 'create';
      const stub = env.TEAM.get(env.TEAM.idFromName(teamId));
      const req = new Request('https://do/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(await safeJson(request)), teamId }),
      });
      const res = await stub.fetch(req);
      const data = await res.json();
      if (data.teamId) data.url = `${url.origin}/?team=${data.teamId}`;
      return new Response(JSON.stringify(data), { status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    teamId = m[2];
    action = m[3];
    if (action !== 'state' && request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const stub = env.TEAM.get(env.TEAM.idFromName(teamId));
    const doUrl = new URL(`https://do/${action}`);
    if (action === 'state') { const e = url.searchParams.get('ephemeralId'); if (e) doUrl.searchParams.set('ephemeralId', e); }
    const req = new Request(doUrl, {
      method: action === 'state' ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: action === 'state' ? undefined : JSON.stringify(await safeJson(request)),
    });
    return stub.fetch(req);
  },
};

async function safeJson(request) {
  try { return (await request.json()) || {}; } catch { return {}; }
}
