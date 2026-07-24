// responder-push-alerts — Cloudflare Worker hosting the PushRegistry Durable Object (web-push P2).
// One well-known DO instance (idFromName('registry')) holds every anonymous push subscription:
// endpoint + browser keys + prefs (ffe on/off, AO-wide gauge tier) + language, nothing else
// (no name, no email, no IP retention). A Pages project cannot host a Durable Object, so this
// ships as a standalone Worker and the Pages Functions under functions/api/push/ bind to it
// (env.PUSH) and forward requests here. The evaluator is the */5 cron on this Worker (plus the
// HMAC-signed run-cycle nudge): FFE pass against api.weather.gov, gauge-crossing pass against the
// deployed mirror snapshot, both sending RFC 8291 encrypted localized payloads, deduped and
// flap-suppressed per (subscription, gauge). Sends drain through a queue in alarm-chained
// batches to respect the free-plan subrequest ceiling.

import { vapidJwk, signVapidJwt } from './vapid.js';
import { encryptPayload } from './webpush-encrypt.js';

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

const CAT_RANK = { none: 0, action: 1, minor: 2, moderate: 3, major: 4 };
const RANK_CAT = ['none', 'action', 'minor', 'moderate', 'major'];
const GAUGE_STALE_MS = 12 * 60 * 60 * 1000;    // client obs-recency rule (CONFIG.gaugeStaleHours)
const GAUGE_COOLDOWN_MS = 30 * 60 * 1000;      // min gap between sends for one (sub, gauge) key
const HYSTERESIS_EVALS = 2;                    // consecutive below-tier evals before re-arm
const HOURLY_CAP = 6;                          // gauge sends per sub per rolling hour (FFE exempt)
const NUDGE_WINDOW_MS = 10 * 60 * 1000;        // signed-nudge timestamp replay window

const ALERTS_URL = 'https://api.weather.gov/alerts/active?area=TX';
const EVENT_URL = 'https://respondertx.org/data/event.json';
const SNAPSHOT_URL = 'https://respondertx.org/data/gauges-snapshot.json';
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

// server-side push.* string table (a push has no page context, so the Worker owns translation);
// en/es parity and the no-em-dash rule are enforced by the test suite
const PUSH_STRINGS = {
  en: {
    'cat.moderate': 'MODERATE flood stage',
    'cat.major': 'MAJOR flood stage',
    'gauge.title': '{name} reached {cat}',
    'gauge.body': '{stage} observed {time} UTC. Not a WEA/911 service.',
    'gauge.body.notime': 'Open the board for current readings. Not a WEA/911 service.',
    'digest.title': '{n} more gauges reached flood stage',
    'digest.body': 'Hourly notification cap reached. Open the board for the full picture. Not a WEA/911 service.',
    'ffe.title': 'FLASH FLOOD EMERGENCY',
    'ffe.body': 'New NWS Flash Flood Emergency in the area. Not a WEA/911 service.',
    'confirm.title': 'Alerts enabled',
    'confirm.body': 'This device will now receive flood alerts. Adjust or turn them off on the board. Not a WEA/911 service.',
  },
  es: {
    'cat.moderate': 'etapa de inundación MODERADA',
    'cat.major': 'etapa de inundación MAYOR',
    'gauge.title': '{name} alcanzó {cat}',
    'gauge.body': '{stage} observado {time} UTC. No sustituye a WEA ni al 911.',
    'gauge.body.notime': 'Abra el tablero para ver las lecturas actuales. No sustituye a WEA ni al 911.',
    'digest.title': '{n} medidores más alcanzaron etapa de inundación',
    'digest.body': 'Límite de notificaciones por hora alcanzado. Abra el tablero para ver el panorama completo. No sustituye a WEA ni al 911.',
    'ffe.title': 'EMERGENCIA DE INUNDACIÓN REPENTINA',
    'ffe.body': 'Nueva emergencia de inundación repentina del NWS en la zona. No sustituye a WEA ni al 911.',
    'confirm.title': 'Alertas activadas',
    'confirm.body': 'Este dispositivo ahora recibirá alertas de inundación. Ajústelas o desactívelas en el tablero. No sustituye a WEA ni al 911.',
  },
};

const fmt = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
const pushStrings = (lang) => PUSH_STRINGS[lang === 'es' ? 'es' : 'en'];

// g: {lid, name, rank, obs}; obs may be null (test fires) — the body then points at the board
function gaugePayload(lang, g, now) {
  const s = pushStrings(lang);
  const cat = s[`cat.${RANK_CAT[g.rank]}`] || RANK_CAT[g.rank];
  const o = g.obs || {};
  const stage = Number.isFinite(o.primary) ? `${o.primary} ${o.primaryUnit || 'ft'}` : '';
  const time = o.validTime ? String(o.validTime).slice(11, 16) : '';
  return JSON.stringify({
    t: 'gauge', lid: g.lid, lang,
    title: fmt(s['gauge.title'], { name: g.name, cat }),
    body: stage && time ? fmt(s['gauge.body'], { stage, time }) : s['gauge.body.notime'],
    url: `/?hydro=${encodeURIComponent(g.lid)}`,
    ts: new Date(now).toISOString(), tag: `g-${g.lid}`,
  });
}

function digestPayload(lang, n, now) {
  const s = pushStrings(lang);
  return JSON.stringify({
    t: 'digest', lang,
    title: fmt(s['digest.title'], { n }),
    body: s['digest.body'],
    url: '/', ts: new Date(now).toISOString(), tag: 'g-digest',
  });
}

function ffePayload(lang, area, id, now) {
  const s = pushStrings(lang);
  return JSON.stringify({
    t: 'ffe', lang,
    title: area ? `${s['ffe.title']} · ${String(area).slice(0, 80)}` : s['ffe.title'],
    body: s['ffe.body'],
    url: '/', ts: new Date(now).toISOString(), tag: `ffe-${id}`,
  });
}

function confirmPayload(lang, now) {
  const s = pushStrings(lang);
  return JSON.stringify({
    t: 'confirm', lang,
    title: s['confirm.title'],
    body: s['confirm.body'],
    url: '/?push=1', ts: new Date(now).toISOString(), tag: 'confirm',
  });
}

// P2 prefs: ffe on/off + AO-wide gauge tier (moderate implies major); per-gauge choices are P3
function sanitizePrefs(p) {
  const src = p && typeof p === 'object' ? p : {};
  return {
    ffe: src.ffe !== false,
    tier: src.tier === 'moderate' || src.tier === 'major' ? src.tier : null,
  };
}

// observed category rank with the client's stale-sensor suppression: a frozen gauge keeps
// reporting a real floodCategory, so obs-age is the only tell — stale never notifies
function gaugeRank(g, now) {
  const o = g && g.status && g.status.observed;
  if (!o || !o.validTime) return 0;
  const age = now - Date.parse(o.validTime);
  if (!Number.isFinite(age) || age > GAUGE_STALE_MS) return 0;
  return CAT_RANK[o.floodCategory] || 0;
}

// one evaluator step for a (subscription, gauge) key. st = {lastCat, lastSent, below}.
// Notify only on an upward crossing into rank >= tier with rank > lastCat; escalation
// (moderate to major) notifies again; cooldown defers without advancing state so a persisting
// crossing fires on a later pass; 2 consecutive below-tier evals re-arm (hysteresis).
function crossingStep(rank, tierRank, st, now) {
  const s = { lastCat: st.lastCat || 0, lastSent: st.lastSent || 0, below: st.below || 0 };
  if (rank >= tierRank) {
    s.below = 0;
    if (rank > s.lastCat && now - s.lastSent >= GAUGE_COOLDOWN_MS) {
      s.lastCat = rank;
      s.lastSent = now;
      return { notify: true, st: s };
    }
    return { notify: false, st: s };
  }
  if (s.lastCat) {
    s.below += 1;
    if (s.below >= HYSTERESIS_EVALS) { s.lastCat = 0; s.below = 0; }
  }
  return { notify: false, st: s };
}

// rolling-hour cap: how many of `count` candidates send directly, how many collapse into one
// digest, how many defer to a later pass (cap already exhausted — state stays armed, not dropped)
function applyHourlyCap(count, stamps, now) {
  const recent = (stamps || []).filter((t) => now - t < 60 * 60 * 1000);
  const room = HOURLY_CAP - recent.length;
  if (count <= room) return { direct: count, digest: 0, defer: 0, stamps: recent.concat(new Array(count).fill(now)) };
  if (room >= 1) {
    const direct = room - 1;
    return { direct, digest: count - direct, defer: 0, stamps: recent.concat(new Array(room).fill(now)) };
  }
  return { direct: 0, digest: 0, defer: count, stamps: recent };
}

// constant-time hex HMAC-SHA256 check over the raw nudge body (the key string's bytes are the
// HMAC key, matching `openssl dgst -sha256 -hmac "$key"` on the sending side)
async function verifyNudgeSig(subtle, key, rawBody, sigHex) {
  const enc = new TextEncoder();
  const k = await subtle.importKey('raw', enc.encode(String(key)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await subtle.sign('HMAC', k, enc.encode(String(rawBody))));
  let hex = '';
  for (const b of mac) hex += b.toString(16).padStart(2, '0');
  const given = String(sigHex || '').toLowerCase();
  if (given.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
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
    let raw = '';
    if (request.method === 'POST') {
      try { raw = await request.text(); } catch { raw = ''; }
    }
    let body = {};
    try { body = JSON.parse(raw) || {}; } catch { body = {}; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
    const ip = request.headers.get('X-Client-IP') || '';
    let out;
    switch (action) {
      case 'subscribe': out = await this.doSubscribe(body, ip, now); break;
      case 'unsubscribe': out = await this.doUnsubscribe(body, ip, now); break;
      case 'renew': out = await this.doRenew(body, ip, now); break;
      case 'status': out = await this.doStatus(now); break;
      case 'evaluate': out = await this.doEvaluate(now); break;
      case 'nudge': out = await this.doNudge(raw, request.headers.get('X-Push-Sig') || '', now); break;
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
    return (await this.state.storage.get('meta')) || { lastEval: null, ffeSeen: [], ao: null, subCount: 0, dropped: 0, lastSnapshotGen: null };
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
    const prefs = sanitizePrefs(body.prefs);
    const row = {
      id, endpoint, p256dh, auth, lang, prefs,
      created: existing ? existing.created : now,
      renewed: now,
    };
    await this.state.storage.put(`sub:${id}`, row);
    // dropping the gauge tier resets that dedup state — a later re-enable starts fresh
    if (!prefs.tier) await this.state.storage.delete(`ns:${id}`);
    // confirmation push on NEW subscriptions only (spec §4.1): proves delivery end to end and
    // kills fabricated endpoints on real push hosts within one send
    let confirmed = false;
    if (!existing) {
      const q = (await this.state.storage.get('sendq')) || [];
      q.push({ subId: id, payload: confirmPayload(lang, now), tries: 0 });
      await this.state.storage.put('sendq', q);
      const drained = await this.drain(now);
      confirmed = drained.sent > 0;
    }
    return { ok: true, prefs, confirmed };
  }

  async doUnsubscribe(body, ip, now) {
    if (this.rateLimited(ip, now)) return { _status: 429, error: 'too many requests' };
    const endpoint = String(body.endpoint || '');
    if (!endpoint || endpoint.length > ENDPOINT_MAX) return { _status: 400, error: 'endpoint required' };
    const id = await sha256hex(crypto.subtle, endpoint);
    await this.state.storage.delete(`sub:${id}`);
    await this.state.storage.delete(`ns:${id}`);
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
    const subs = await this.state.storage.list({ prefix: 'sub:' });
    const tiers = { moderate: 0, major: 0 };
    for (const row of subs.values()) {
      const tier = row.prefs && row.prefs.tier;
      if (tier === 'moderate' || tier === 'major') tiers[tier] += 1;
    }
    return {
      configured: this.configured(),
      subCount: subs.size,
      tiers,
      queue: q.length,
      lastEval: meta.lastEval || null,
      lastSnapshotGen: meta.lastSnapshotGen || null,
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
      if (now - (row.renewed || 0) > SUB_TTL_MS) {
        await this.state.storage.delete(k);
        await this.state.storage.delete(`ns:${row.id}`);
        continue;
      }
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
        fresh.push({ id, area: String(p.areaDesc || '') });
        meta.ffeSeen.push({ id, ts: now });
      }
      meta.ffeSeen = (meta.ffeSeen || []).slice(-FFE_SEEN_MAX);
    } catch {
      alertsOk = false; // feed down this tick — next cron pass covers it; dedup ring untouched
    }

    let ffeQueued = 0;
    if (fresh.length && live.length) {
      const q = (await this.state.storage.get('sendq')) || [];
      for (const f of fresh) {
        for (const row of live) {
          if (row.prefs && row.prefs.ffe) {
            q.push({ subId: row.id, payload: ffePayload(row.lang, f.area, f.id, now), tries: 0 });
            ffeQueued += 1;
          }
        }
      }
      await this.state.storage.put('sendq', q);
    }

    const gauge = await this.gaugePass(live, meta, now);

    meta.lastEval = now;
    await this.state.storage.put('meta', meta);
    const drained = await this.drain(now);
    return {
      ok: true, alertsOk, newFfe: fresh.length, enqueued: ffeQueued,
      gaugesOk: gauge.ok, crossings: gauge.crossings, digests: gauge.digests, ...drained,
    };
  }

  // P2 gauge pass: upward category crossings from the DEPLOYED mirror snapshot (the push must
  // never claim something the board cannot show); per-(sub, gauge) dedup + hysteresis + cooldown
  // + rolling-hour cap with digest collapse. Skips entirely when nothing new was deployed.
  async gaugePass(live, meta, now) {
    const out = { ok: true, crossings: 0, digests: 0, skipped: false };
    const tierSubs = live.filter((r) => r.prefs && (r.prefs.tier === 'moderate' || r.prefs.tier === 'major'));
    try {
      const res = await fetch(SNAPSHOT_URL, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
      const snap = await res.json();
      const gen = String((snap && snap.generated) || '');
      if (gen && gen === meta.lastSnapshotGen) { out.skipped = true; return out; }
      meta.lastSnapshotGen = gen;
      if (!tierSubs.length) return out;
      const ranked = [];
      for (const g of ((snap && snap.gauges) || [])) {
        const lid = String(g.lid || '');
        if (!lid) continue;
        ranked.push({ lid, name: String(g.name || lid), rank: gaugeRank(g, now), obs: g.status && g.status.observed });
      }
      const q = (await this.state.storage.get('sendq')) || [];
      for (const row of tierSubs) {
        const tierRank = CAT_RANK[row.prefs.tier];
        const ns = (await this.state.storage.get(`ns:${row.id}`)) || { g: {}, hourly: [] };
        const candidates = [];
        for (const g of ranked) {
          const prev = ns.g[g.lid];
          if (g.rank < tierRank && !prev) continue; // no crossing, no armed state — nothing to do
          const step = crossingStep(g.rank, tierRank, prev || {}, now);
          if (step.notify) candidates.push({ g, st: step.st });
          else if (step.st.lastCat || step.st.below) ns.g[g.lid] = step.st;
          else delete ns.g[g.lid];
        }
        const cap = applyHourlyCap(candidates.length, ns.hourly, now);
        for (let i = 0; i < cap.direct; i++) {
          const c = candidates[i];
          ns.g[c.g.lid] = c.st;
          q.push({ subId: row.id, payload: gaugePayload(row.lang, c.g, now), tries: 0 });
          out.crossings += 1;
        }
        if (cap.digest) {
          for (let i = cap.direct; i < candidates.length; i++) ns.g[candidates[i].g.lid] = candidates[i].st;
          q.push({ subId: row.id, payload: digestPayload(row.lang, cap.digest, now), tries: 0 });
          out.digests += 1;
        }
        // cap.defer candidates keep their previous state untouched: they retry next pass
        ns.hourly = cap.stamps;
        await this.state.storage.put(`ns:${row.id}`, ns);
      }
      await this.state.storage.put('sendq', q);
    } catch {
      out.ok = false; // mirror unreachable this tick — dedup state untouched, next pass covers it
    }
    return out;
  }

  // HMAC-signed run-cycle nudge (fast path after each data deploy; the */5 cron is the guarantee).
  // Verified over the RAW body bytes; ts is epoch seconds inside a ±10 min replay window.
  async doNudge(rawBody, sigHex, now) {
    if (!this.configured()) return { _status: 503, error: 'push not configured' };
    const key = (this.env && this.env.PUSH_NUDGE_KEY) || '';
    if (!key) return { _status: 503, error: 'nudge not configured' };
    if (!(await verifyNudgeSig(crypto.subtle, key, rawBody, sigHex))) {
      return { _status: 403, error: 'bad signature' };
    }
    let ts = NaN;
    try { ts = Number((JSON.parse(rawBody) || {}).ts); } catch { ts = NaN; }
    if (!Number.isFinite(ts) || Math.abs(now - ts * 1000) > NUDGE_WINDOW_MS) {
      return { _status: 403, error: 'timestamp outside window' };
    }
    const out = await this.doEvaluate(now);
    return { ...out, nudged: true };
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

  // RFC 8291 encrypted send when the row has browser keys and a payload; payload-free RFC 8030
  // fallback otherwise (the SW's baked table composes generic localized text — spec compat rule)
  async sendPush(row, payload, now) {
    const auth = await this.vapidAuthFor(new URL(row.endpoint).origin, now);
    const headers = { TTL: '3600', Urgency: 'high', Authorization: auth };
    if (payload && row.p256dh && row.auth) {
      let body = null;
      try {
        body = await encryptPayload(
          crypto.subtle, (a) => crypto.getRandomValues(a), row.p256dh, row.auth,
          new TextEncoder().encode(payload),
        );
      } catch { body = null; } // malformed stored keys — degrade to the payload-free fallback
      if (body) {
        headers['Content-Encoding'] = 'aes128gcm';
        return fetch(row.endpoint, { method: 'POST', headers, body });
      }
    }
    return fetch(row.endpoint, { method: 'POST', headers });
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
        const res = await this.sendPush(row, item.payload || null, now);
        if (res.status === 404 || res.status === 410 || res.status === 403) {
          await this.state.storage.delete(`sub:${item.subId}`);
          await this.state.storage.delete(`ns:${item.subId}`);
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

  // ops verification only, token-gated at the edge: send a real push to one stored subscription
  // (by endpoint) or to every stored subscription when none is named. kind 'gauge' fires an
  // encrypted sample gauge-tier payload (lid/name/cat overridable), 'confirm' the confirmation
  // payload; no kind = payload-free like P1. Returns push-service status codes.
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
    const kind = body.kind === 'gauge' || body.kind === 'confirm' ? body.kind : null;
    const results = [];
    for (const row of targets) {
      let payload = null;
      if (kind === 'confirm') payload = confirmPayload(row.lang, now);
      else if (kind === 'gauge') {
        payload = gaugePayload(row.lang, {
          lid: String(body.lid || 'TEST').slice(0, 16),
          name: String(body.name || 'Test gauge').slice(0, 120),
          rank: CAT_RANK[body.cat] >= CAT_RANK.moderate ? CAT_RANK[body.cat] : CAT_RANK.moderate,
          obs: null,
        }, now);
      }
      try {
        const res = await this.sendPush(row, payload, now);
        if (res.status === 404 || res.status === 410) {
          await this.state.storage.delete(`sub:${row.id}`);
          await this.state.storage.delete(`ns:${row.id}`);
        }
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
    const m = url.pathname.match(/^\/api\/push\/(subscribe|unsubscribe|renew|status|nudge|evaluate|peek|testfire)$/);
    if (!m) return new Response('not found', { status: 404 });
    const action = m[1];
    if (action !== 'status' && request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    if (action === 'evaluate' || action === 'peek' || action === 'testfire') {
      const token = (env && env.PUSH_ADMIN_TOKEN) || '';
      if (!token || request.headers.get('X-Admin-Token') !== token) return new Response('forbidden', { status: 403 });
    }
    // nudge signatures cover the raw body bytes, so every action forwards the body verbatim
    let raw = '';
    if (action !== 'status') {
      try { raw = await request.text(); } catch { raw = ''; }
    }
    const stub = env.PUSH.get(env.PUSH.idFromName('registry'));
    return stub.fetch(new Request(`https://do/${action}`, {
      method: action === 'status' ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-IP': request.headers.get('CF-Connecting-IP') || '',
        'X-Push-Sig': request.headers.get('X-Push-Sig') || '',
      },
      body: action === 'status' ? undefined : raw,
    }));
  },
};
