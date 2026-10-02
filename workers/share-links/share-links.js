// responder-share-links: hosts the ShareLinks Durable Object (8-digit code -> board query). See README.md.

// Exactly the keys buildShareUrl() (js/board.js) can emit; tests/share-short.test.js holds the two equal.
const VIEW_KEYS = ['mlat', 'mlon', 'mz', 'tab', 'ft', 'fc', 'fw', 'fd', 'fq', 'fs', 'as', 'aq', 'rain',
  'radar', 'fcst', 'usgs', 'lwc', 'inun', 'reopen', 'rflood', 'rs', 'fire', 'tide', 'camreg', 'ao',
  'view', 'river', 'base', 'theme'];
// Record deep links the board opens at boot. Never `team`: an invite link is a capability URL.
const RECORD_KEYS = ['cam'];
const SHARE_KEYS = new Set(VIEW_KEYS.concat(RECORD_KEYS));

const Q_MAX = 1024;
const CODE_RE = /^[1-9]\d{7}$/;
const CODE_MIN = 10000000;   // no leading zero, so a spreadsheet in an after-action report cannot strip one
const CODE_SPAN = 90000000;
const PROBE_MAX = 16;
const MAX_ROWS = 500000;
const RATE_MAX = 60;  // new links per IP (IPv6 per /64) per window; re-sharing a known view is free
const RATE_WINDOW_MS = 10 * 60 * 1000;
const HIT_WRITE_MS = 60 * 60 * 1000;
const CTRL_RE = /[\u0000-\u001f\u007f]/;

const rowKey = (code) => `c:${code}`;

function normalizeQuery(raw) {
  if (typeof raw !== 'string') return { error: 'q required' };
  const s = raw.charAt(0) === '?' ? raw.slice(1) : raw;
  if (!s) return { error: 'empty query' };
  if (s.length > Q_MAX) return { error: 'query too long' };
  const seen = new Set();
  const pairs = [];
  for (const [k, v] of new URLSearchParams(s)) {
    if (!SHARE_KEYS.has(k)) return { error: 'param not allowed' };
    if (seen.has(k)) return { error: 'duplicate param' };
    if (CTRL_RE.test(v)) return { error: 'bad value' };
    seen.add(k);
    pairs.push([k, v]);
  }
  if (!pairs.length) return { error: 'empty query' };
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const q = new URLSearchParams(pairs).toString();
  if (q.length > Q_MAX) return { error: 'query too long' };
  return { q };
}

// probe 0 is the view's home code; a collision with another view walks a fixed per-view sequence
async function codeFor(q, probe) {
  const data = new TextEncoder().encode(probe ? `${q}\n${probe}` : q);
  const b = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + b[i];
  return String(CODE_MIN + (n % CODE_SPAN));
}

function ipBucket(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s.includes(':')) return s;
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const tl = tail ? tail.split(':') : [];
  const full = tail === undefined ? h : h.concat(Array(Math.max(0, 8 - h.length - tl.length)).fill('0'), tl);
  return `${full.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export class ShareLinks {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.buckets = new Map(); // transient, never persisted: no IP retention
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\/+/, '');
    const now = Date.now();
    let out;
    if (action === 'create' && request.method === 'POST') {
      let body = {};
      try { body = JSON.parse(await request.text()) || {}; } catch { body = {}; }
      out = await this.doCreate(body, request.headers.get('X-Client-IP') || '', now);
    } else if (action === 'resolve') {
      out = await this.doResolve(url.searchParams.get('code') || '', now);
    } else {
      out = { _status: 404, error: 'unknown action' };
    }
    const status = out._status || 200;
    delete out._status;
    return new Response(JSON.stringify(out), {
      status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
    });
  }

  rateLimited(ip, now) {
    const key = ipBucket(ip);
    if (!key) return false;
    const b = this.buckets.get(key);
    if (!b || now - b.t > RATE_WINDOW_MS) { this.buckets.set(key, { t: now, n: 1 }); return false; }
    b.n += 1;
    if (this.buckets.size > 5000) this.buckets.clear(); // memory bound; every window restarts
    return b.n > RATE_MAX;
  }

  async doCreate(body, ip, now) {
    const norm = normalizeQuery(body && typeof body === 'object' ? body.q : undefined);
    if (norm.error) return { _status: 400, error: norm.error };
    const storage = this.state.storage;
    return this.state.blockConcurrencyWhile(async () => {
      let free = null;
      for (let i = 0; i < PROBE_MAX; i++) {
        const code = await codeFor(norm.q, i);
        const row = await storage.get(rowKey(code));
        if (row && row.q === norm.q) return { code };
        if (!row) { free = code; break; }
      }
      if (!free) return { _status: 503, error: 'no free code' };
      const meta = (await storage.get('meta')) || { rows: 0 };
      if (meta.rows >= MAX_ROWS) return { _status: 503, error: 'at capacity' };
      if (this.rateLimited(ip, now)) return { _status: 429, error: 'too many requests' };
      await storage.put({ [rowKey(free)]: { q: norm.q, created: now, hit: null }, meta: { ...meta, rows: meta.rows + 1 } });
      return { code: free, created: true };
    });
  }

  async doResolve(code, now) {
    if (!CODE_RE.test(code)) return { _status: 404, error: 'unknown code' };
    const row = await this.state.storage.get(rowKey(code));
    if (!row) return { _status: 404, error: 'unknown code' };
    if (!row.hit || now - row.hit >= HIT_WRITE_MS) await this.state.storage.put(rowKey(code), { ...row, hit: now });
    return { q: row.q };
  }
}

// Not publicly routable (workers_dev = false): the Pages Functions reach the DO via the SHARE binding.
export default {
  async fetch() { return new Response('not found', { status: 404 }); },
};
