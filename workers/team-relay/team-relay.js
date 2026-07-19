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
      case 'position': out = await this.doPosition(body, now); break;
      case 'state': out = await this.doState(url, now); break;
      case 'leave': out = await this.doLeave(body, now); break;
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
      this.team = { id: teamId, name: sanitizeText(body.name, NAME_MAX), created: now, lastActive: now, people: {} };
      await this.persist(now);
    }
    return { teamId: this.team.id, name: this.team.name, created: this.team.created };
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
    const person = existing || { ephemeralId: id, joined: now, trail: [], lastPos: null };
    person.handle = v.handle;
    person.role = v.role;
    person.lastSeen = now;
    if (v.role === 'member') { if (!person.color) person.color = this.pickColor(); }
    else { person.color = undefined; person.lastPos = null; person.trail = []; }
    this.team.people[id] = person;
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
      else viewers.push({ ephemeralId: p.ephemeralId, handle: p.handle, role: 'viewer', lastSeen: p.lastSeen });
    }
    await this.persist(now);
    return {
      teamId: this.team.id, name: this.team.name, now,
      you: UUID_RE.test(id) && this.team.people[id] ? this.publicSelf(this.team.people[id]) : null,
      members, viewers,
    };
  }

  async doLeave(body, now) {
    if (!this.team) return { ok: true };
    const id = String(body.ephemeralId || '');
    if (UUID_RE.test(id) && this.team.people[id]) { delete this.team.people[id]; await this.persist(now); }
    return { ok: true };
  }

  publicSelf(p) {
    return { ephemeralId: p.ephemeralId, handle: p.handle, role: p.role, color: p.color || null };
  }

  publicMember(p) {
    return {
      ephemeralId: p.ephemeralId, handle: p.handle, role: 'member', color: p.color || null,
      lastPos: p.lastPos || null, lastSeen: p.lastSeen, trail: p.trail || [],
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
const TEAM_PATH_RE = /^\/api\/team\/(?:(create)|([0-9a-f-]{36})\/(join|position|state|leave))$/i;

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
