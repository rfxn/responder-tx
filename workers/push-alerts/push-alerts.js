// responder-push-alerts — Cloudflare Worker hosting the PushRegistry Durable Object (web-push P1).
// One well-known DO instance (idFromName('registry')) holds every anonymous push subscription:
// endpoint + browser keys + prefs + language, nothing else (no name, no email, no IP retention).
// A Pages project cannot host a Durable Object, so this ships as a standalone Worker and the Pages
// Functions under functions/api/push/ bind to it (env.PUSH) and forward requests here.
// The evaluator is the */5 cron on this Worker: it polls api.weather.gov for new Flash Flood
// Emergencies intersecting the event AO and sends payload-free pushes (P1), deduped by alert id.
// Sends drain through a queue in alarm-chained batches to respect the free-plan subrequest ceiling.

import { vapidJwk, signVapidJwt } from './vapid.js';

const SUB_TTL_MS = 60 * 24 * 60 * 60 * 1000;   // rows expire 60 days after last renew
const AO_CACHE_MS = 15 * 60 * 1000;            // event.json AO bbox cache window
const FFE_SEEN_MAX = 200;                      // dedup ring of already-notified alert ids
const SEND_BATCH = 40;                         // per-invocation send cap (free plan ~50 subrequests)
const ALARM_GAP_MS = 2000;                     // chained-drain spacing
const MAX_SUBS = 25000;                        // registry capacity: beyond it subscribe says so honestly
const RATE_MAX = 10;                           // subscribe-family calls per IP per window
const RATE_WINDOW_MS = 10 * 60 * 1000;
const ENDPOINT_MAX = 1024;
const KEY_MAX = 256;
const ZONE_FETCH_MAX = 3;                      // zone-geometry lookups per polygon-less alert

const ALERTS_URL = 'https://api.weather.gov/alerts/active?area=TX';
const EVENT_URL = 'https://respondertx.org/data/event.json';
const UA = 'respondertx.org push-alerts (proj@rfxn.com)';
const VAPID_SUBJECT = 'mailto:proj@rfxn.com';
// bootstrap AO only until the first successful event.json fetch (then last-good rules)
const AO_FALLBACK = { xmin: -98.0, ymin: 27.5, xmax: -93.4, ymax: 31.0 };

// known push-service hosts only — anything else is 400 (kills subscribe-a-victim-URL SSRF abuse)
function allowedEndpoint(endpoint) {
  let u;
  try { u = new URL(String(endpoint)); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  const suffix = (base) => h === base || h.endsWith(`.${base}`);
  return h === 'fcm.googleapis.com' || h === 'android.googleapis.com'
    || /^jmt\d+\.google\.com$/.test(h) // FCM edge host minted by (unbranded) Chromium builds
    || h === 'updates.push.services.mozilla.com'
    || suffix('push.services.mozilla.com') || suffix('notify.windows.com')
    || h === 'web.push.apple.com' || suffix('push.apple.com');
}

// client rule from js/sources.js applied server-side to api.weather.gov alert JSON
function isFfe(p) {
  const threat = ((p.parameters && p.parameters.flashFloodDamageThreat) || []).join(' ');
  return /FLASH FLOOD EMERGENCY/i.test(p.description || '') || /CATASTROPHIC/i.test(threat);
}

function geomBbox(geometry) {
  let coords = null;
  if (geometry && geometry.type === 'Polygon') coords = geometry.coordinates.flat(1);
  else if (geometry && geometry.type === 'MultiPolygon') coords = geometry.coordinates.flat(2);
  if (!coords || !coords.length) return null;
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (const [x, y] of coords) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  return Number.isFinite(xmin) ? { xmin, ymin, xmax, ymax } : null;
}

const bboxOverlap = (a, b) => a && b && a.xmin <= b.xmax && a.xmax >= b.xmin && a.ymin <= b.ymax && a.ymax >= b.ymin;

async function sha256hex(subtle, s) {
  const d = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(String(s))));
  let hex = '';
  for (const b of d) hex += b.toString(16).padStart(2, '0');
  return hex;
}

export class PushRegistry {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.buckets = new Map();   // transient per-IP rate buckets — never persisted (no IP retention)
    this.jwtCache = new Map();  // per-push-service-origin VAPID JWT, valid for this instance's life
  }

  configured() {
    return Boolean(this.env && this.env.VAPID_PUBLIC_KEY && this.env.VAPID_PRIVATE_KEY);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\/+/, '');
    const now = Date.now();
    let body = {};
    if (request.method === 'POST') {
      try { body = await request.json(); } catch { body = {}; }
      if (!body || typeof body !== 'object') body = {};
    }
    const ip = request.headers.get('X-Client-IP') || '';
    let out;
    switch (action) {
      case 'subscribe': out = await this.doSubscribe(body, ip, now); break;
      case 'unsubscribe': out = await this.doUnsubscribe(body, ip, now); break;
      case 'renew': out = await this.doRenew(body, ip, now); break;
      case 'status': out = await this.doStatus(now); break;
      case 'evaluate': out = await this.doEvaluate(now); break;
      case 'peek': out = await this.doPeek(now); break;
      case 'testfire': out = await this.doTestfire(body, now); break;
      default: out = { _status: 404, error: 'unknown action' };
    }
    const status = out._status || 200;
    delete out._status;
    return new Response(JSON.stringify(out), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
    });
  }

  rateLimited(ip, now) {
    if (!ip) return false;
    const b = this.buckets.get(ip);
    if (!b || now - b.t > RATE_WINDOW_MS) { this.buckets.set(ip, { t: now, n: 1 }); return false; }
    b.n += 1;
    if (this.buckets.size > 5000) this.buckets.clear(); // transient memory bound; window restarts
    return b.n > RATE_MAX;
  }

  async getMeta() {
    return (await this.state.storage.get('meta')) || { lastEval: null, ffeSeen: [], ao: null, subCount: 0, dropped: 0 };
  }

  async subCount() {
    const subs = await this.state.storage.list({ prefix: 'sub:' });
    return subs.size;
  }

  async doSubscribe(body, ip, now) {
    if (!this.configured()) return { _status: 503, error: 'push not configured' };
    if (this.rateLimited(ip, now)) return { _status: 429, error: 'too many requests' };
    const s = body.subscription || {};
    const endpoint = String(s.endpoint || '');
    if (!endpoint || endpoint.length > ENDPOINT_MAX || !allowedEndpoint(endpoint)) {
      return { _status: 400, error: 'endpoint not accepted' };
    }
    const keys = s.keys || {};
    const p256dh = String(keys.p256dh || '').slice(0, KEY_MAX);
    const auth = String(keys.auth || '').slice(0, KEY_MAX);
    const lang = body.lang === 'es' ? 'es' : 'en';
    const id = await sha256hex(crypto.subtle, endpoint);
    const existing = await this.state.storage.get(`sub:${id}`);
    if (!existing && (await this.subCount()) >= MAX_SUBS) {
      return { _status: 503, error: 'at capacity' };
    }
    const row = {
      id, endpoint, p256dh, auth, lang,
      prefs: { ffe: true },   // P1: the only subscription option is AO-wide FFE (schema forward-stable)
      created: existing ? existing.created : now,
      renewed: now,
    };
    await this.state.storage.put(`sub:${id}`, row);
    return { ok: true, prefs: row.prefs };
  }

  async doUnsubscribe(body, ip, now) {
    if (this.rateLimited(ip, now)) return { _status: 429, error: 'too many requests' };
    const endpoint = String(body.endpoint || '');
    if (!endpoint || endpoint.length > ENDPOINT_MAX) return { _status: 400, error: 'endpoint required' };
    const id = await sha256hex(crypto.subtle, endpoint);
    await this.state.storage.delete(`sub:${id}`);
    return { ok: true };
  }

  async doRenew(body, ip, now) {
    if (this.rateLimited(ip, now)) return { _status: 429, error: 'too many requests' };
    const endpoint = String(body.endpoint || '');
    if (!endpoint || endpoint.length > ENDPOINT_MAX) return { _status: 400, error: 'endpoint required' };
    const id = await sha256hex(crypto.subtle, endpoint);
    const row = await this.state.storage.get(`sub:${id}`);
    if (!row) return { _status: 404, error: 'not subscribed' };
    row.renewed = now;
    await this.state.storage.put(`sub:${id}`, row);
    return { ok: true };
  }

  async doStatus(now) {
    const meta = await this.getMeta();
    return {
      configured: this.configured(),
      lastEval: meta.lastEval || null,
      vapidKey: (this.env && this.env.VAPID_PUBLIC_KEY) || null,
    };
  }

  // token-gated (at the edge) registry introspection for ops verification — counts only, no endpoints
  async doPeek(now) {
    const meta = await this.getMeta();
    const q = (await this.state.storage.get('sendq')) || [];
    return {
      configured: this.configured(),
      subCount: await this.subCount(),
      queue: q.length,
      lastEval: meta.lastEval || null,
      seenFfe: (meta.ffeSeen || []).length,
      dropped: meta.dropped || 0,
    };
  }

  // 15-min-cached AO bbox from the deployed mirror's event.json; last-good on fetch failure
  async aoBbox(meta, now) {
    if (meta.ao && meta.ao.bbox && now - meta.ao.fetched < AO_CACHE_MS) return meta.ao.bbox;
    try {
      const res = await fetch(EVENT_URL, { headers: { 'User-Agent': UA } });
      if (res.ok) {
        const ev = await res.json();
        const b = ev && ev.gaugeBbox;
        if (b && Number.isFinite(b.xmin) && Number.isFinite(b.ymin) && Number.isFinite(b.xmax) && Number.isFinite(b.ymax)) {
          meta.ao = { bbox: { xmin: b.xmin, ymin: b.ymin, xmax: b.xmax, ymax: b.ymax }, fetched: now };
          return meta.ao.bbox;
        }
      }
    } catch { /* fall through to last-good / bootstrap */ }
    if (meta.ao && meta.ao.bbox) return meta.ao.bbox;
    return AO_FALLBACK;
  }

  // polygon bbox test; polygon-less products fall back to a capped zone-geometry lookup and,
  // failing that, count as in-AO (fail toward notifying — FFE is the highest-stakes class)
  async inAo(feature, ao) {
    const bb = geomBbox(feature.geometry);
    if (bb) return bboxOverlap(bb, ao);
    const zones = ((feature.properties || {}).affectedZones || []).slice(0, ZONE_FETCH_MAX);
    let resolved = 0;
    for (const z of zones) {
      try {
        const res = await fetch(`${z}`, { headers: { 'User-Agent': UA, Accept: 'application/geo+json' } });
        if (!res.ok) continue;
        const zb = geomBbox((await res.json()).geometry);
        if (!zb) continue;
        resolved += 1;
        if (bboxOverlap(zb, ao)) return true;
      } catch { /* zone lookup failed — falls through to the default-include rule */ }
    }
    return resolved === 0; // nothing resolvable → include; resolved-but-outside → exclude
  }

  async doEvaluate(now) {
    if (!this.configured()) return { _status: 503, error: 'push not configured' };
    const meta = await this.getMeta();
    const ao = await this.aoBbox(meta, now);

    // TTL prune + live roster (spec §1.4: expiry pruning happens in the evaluator pass)
    const subs = await this.state.storage.list({ prefix: 'sub:' });
    const live = [];
    for (const [k, row] of subs) {
      if (now - (row.renewed || 0) > SUB_TTL_MS) { await this.state.storage.delete(k); continue; }
      live.push(row);
    }
    meta.subCount = live.length;

    let fresh = [];
    let alertsOk = true;
    try {
      const res = await fetch(ALERTS_URL, { headers: { 'User-Agent': UA, Accept: 'application/geo+json' } });
      if (!res.ok) throw new Error(`alerts HTTP ${res.status}`);
      const data = await res.json();
      const seen = new Set((meta.ffeSeen || []).map((e) => e.id));
      for (const f of (data.features || [])) {
        const p = f.properties || {};
        if (!isFfe(p)) continue;
        const id = String(f.id || p.id || '');
        if (!id || seen.has(id)) continue;
        if (!(await this.inAo(f, ao))) continue;
        fresh.push(id);
        meta.ffeSeen.push({ id, ts: now });
      }
      meta.ffeSeen = (meta.ffeSeen || []).slice(-FFE_SEEN_MAX);
    } catch {
      alertsOk = false; // feed down this tick — next cron pass covers it; dedup ring untouched
    }

    if (fresh.length && live.length) {
      const q = (await this.state.storage.get('sendq')) || [];
      for (const id of fresh) {
        for (const row of live) {
          if (row.prefs && row.prefs.ffe) q.push({ subId: row.id, tag: `ffe-${id}`, tries: 0 });
        }
      }
      await this.state.storage.put('sendq', q);
    }

    meta.lastEval = now;
    await this.state.storage.put('meta', meta);
    const drained = await this.drain(now);
    return { ok: true, alertsOk, newFfe: fresh.length, enqueued: fresh.length * live.length, ...drained };
  }

  async vapidAuthFor(origin, now) {
    const hit = this.jwtCache.get(origin);
    if (hit && now < hit.exp - 60 * 1000) return hit.header;
    const jwk = vapidJwk(this.env.VAPID_PUBLIC_KEY, this.env.VAPID_PRIVATE_KEY);
    const jwt = await signVapidJwt(origin, VAPID_SUBJECT, jwk, crypto.subtle, now);
    const header = `vapid t=${jwt}, k=${this.env.VAPID_PUBLIC_KEY}`;
    this.jwtCache.set(origin, { header, exp: now + 12 * 3600 * 1000 });
    return header;
  }

  // payload-free P1 send (RFC 8030 push without content encryption; the SW composes the text)
  async sendPush(endpoint, now) {
    const auth = await this.vapidAuthFor(new URL(endpoint).origin, now);
    return fetch(endpoint, {
      method: 'POST',
      headers: { TTL: '3600', Urgency: 'high', Authorization: auth },
    });
  }

  // drain up to SEND_BATCH queued sends; a chained alarm finishes the rest with a fresh
  // subrequest budget. 404/410 (and 403 key mismatch) delete the row; 429/5xx requeue once.
  async drain(now) {
    let q = (await this.state.storage.get('sendq')) || [];
    if (!q.length) return { sent: 0, queued: 0 };
    const batch = q.slice(0, SEND_BATCH);
    let rest = q.slice(SEND_BATCH);
    const requeue = [];
    let sent = 0, dropped = 0;
    for (const item of batch) {
      const row = await this.state.storage.get(`sub:${item.subId}`);
      if (!row) continue;
      try {
        const res = await this.sendPush(row.endpoint, now);
        if (res.status === 404 || res.status === 410 || res.status === 403) {
          await this.state.storage.delete(`sub:${item.subId}`);
          dropped += 1;
        } else if ((res.status === 429 || res.status >= 500) && (item.tries || 0) < 1) {
          requeue.push({ ...item, tries: 1 });
        } else if (res.status >= 400) {
          dropped += 1;
        } else {
          sent += 1;
        }
      } catch {
        if ((item.tries || 0) < 1) requeue.push({ ...item, tries: 1 });
        else dropped += 1;
      }
    }
    rest = rest.concat(requeue);
    await this.state.storage.put('sendq', rest);
    if (dropped) {
      const meta = await this.getMeta();
      meta.dropped = (meta.dropped || 0) + dropped;
      await this.state.storage.put('meta', meta);
    }
    if (rest.length) {
      try { await this.state.storage.setAlarm(now + ALARM_GAP_MS); } catch { /* local backend without alarms — next evaluate drains */ }
    }
    return { sent, queued: rest.length };
  }

  async alarm() {
    await this.drain(Date.now());
  }

  // ops verification only, token-gated at the edge: send a real payload-free push to one stored
  // subscription (by endpoint) or to every stored subscription when none is named. Returns the
  // push-service status codes so the delivery chain is checkable end to end.
  async doTestfire(body, now) {
    if (!this.configured()) return { _status: 503, error: 'push not configured' };
    let targets = [];
    if (body.endpoint) {
      const id = await sha256hex(crypto.subtle, String(body.endpoint));
      const row = await this.state.storage.get(`sub:${id}`);
      if (!row) return { _status: 404, error: 'not subscribed' };
      targets = [row];
    } else {
      const subs = await this.state.storage.list({ prefix: 'sub:' });
      targets = [...subs.values()].slice(0, SEND_BATCH);
    }
    const results = [];
    for (const row of targets) {
      try {
        const res = await this.sendPush(row.endpoint, now);
        if (res.status === 404 || res.status === 410) await this.state.storage.delete(`sub:${row.id}`);
        results.push({ id: row.id.slice(0, 8), status: res.status });
      } catch (err) {
        results.push({ id: row.id.slice(0, 8), status: 0, error: String(err && err.message).slice(0, 120) });
      }
    }
    return { ok: true, fired: results.length, results };
  }
}

// Cron evaluator + a thin local-dev forwarder. In production the Worker is not publicly routable
// (workers_dev=false, no routes); Pages Functions reach the DO via the PUSH binding.
export default {
  async scheduled(event, env, ctx) {
    const stub = env.PUSH.get(env.PUSH.idFromName('registry'));
    ctx.waitUntil(stub.fetch(new Request('https://do/evaluate', { method: 'POST' })));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/push\/(subscribe|unsubscribe|renew|status|evaluate|peek|testfire)$/);
    if (!m) return new Response('not found', { status: 404 });
    const action = m[1];
    if (action !== 'status' && request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    if (action === 'evaluate' || action === 'peek' || action === 'testfire') {
      const token = (env && env.PUSH_ADMIN_TOKEN) || '';
      if (!token || request.headers.get('X-Admin-Token') !== token) return new Response('forbidden', { status: 403 });
    }
    const stub = env.PUSH.get(env.PUSH.idFromName('registry'));
    return stub.fetch(new Request(`https://do/${action}`, {
      method: action === 'status' ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-IP': request.headers.get('CF-Connecting-IP') || '' },
      body: action === 'status' ? undefined : JSON.stringify(await safeJson(request)),
    }));
  },
};

async function safeJson(request) {
  try { return (await request.json()) || {}; } catch { return {}; }
}
