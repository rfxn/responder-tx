'use strict';

/* The client half of short links, executed: shortenShareUrl/copyShortLink run against a stubbed
   network, clipboard and clock, and the share sheet's real handlers are called. The server half
   is in share-links.test.js; the agreement between the two is asserted at the bottom. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, loadFullApp } = require('./harness.js');
const server = require('./share-harness.js');

const app = loadApp();
const sb = app._sandbox;
const { state, SHORT_LINK_TIMEOUT_MS } = app;

const MIRROR = { origin: 'https://respondertx.org', hostname: 'respondertx.org', protocol: 'https:', pathname: '/', search: '' };
let seq = 0;
const longUrl = (origin = MIRROR.origin) => `${origin}/?mlat=29.4241&mlon=-98.4936&mz=${10 + (seq++ % 8)}&fq=t${seq}`;
const okCode = (code) => async () => ({ ok: true, status: 200, json: async () => ({ code, url: `https://respondertx.org/s/${code}` }) });
const tick = () => new Promise((r) => setImmediate(r));

class ClipboardItem { constructor(items) { this.items = items; } }

/* `modern` is every current browser: ClipboardItem with a promised value (what Safari requires).
   `legacy` has writeText only. Both record what landed on the clipboard and how many writes STARTED,
   so a test can tell a write begun inside the tap from one begun after a network wait. */
function world({ loc = MIRROR, fetchImpl = null, onLine = true, clipboard = 'modern' } = {}) {
  const keys = ['location', 'fetch', 'navigator', 'isSecureContext', 'setTimeout', 'clearTimeout', 'prompt',
    'AbortController', 'ClipboardItem', 'Blob'];
  const saved = Object.fromEntries(keys.map((k) => [k, sb[k]]));
  const w = { calls: [], copied: [], timers: [], prompted: [], started: 0 };
  const writeText = async (s) => { w.started++; w.copied.push(s); };
  const write = (items) => {
    w.started++;
    return Promise.resolve(items[0].items['text/plain']).then((b) => b.text()).then((s) => { w.copied.push(s); });
  };
  const clip = clipboard === 'modern' ? { write, writeText } : clipboard === 'legacy' ? { writeText } : clipboard;
  sb.location = { ...loc };
  sb.fetch = (url, opts) => {
    w.calls.push({ url, opts });
    return fetchImpl ? fetchImpl(url, opts) : Promise.reject(new TypeError('Failed to fetch'));
  };
  sb.navigator = { onLine, clipboard: clip };
  sb.isSecureContext = true;
  sb.AbortController = AbortController;
  sb.ClipboardItem = clip.write ? ClipboardItem : undefined;
  sb.Blob = Blob;
  sb.setTimeout = (fn, ms) => { w.timers.push({ fn, ms }); return w.timers.length; };
  sb.clearTimeout = () => {};
  sb.prompt = (msg, val) => { w.prompted.push(val); };
  w.restore = () => { for (const k of keys) sb[k] = saved[k]; };
  w.fire = (ms) => { for (const t of w.timers.filter((x) => x.ms === ms)) t.fn(); };
  return w;
}

const button = () => ({ innerHTML: '🔗 <span>Copy link</span>', textContent: '🔗 Copy link', dataset: {} });

test('the public mirror mints one short link per view, reuses it, and reports it synchronously once made', async () => {
  const w = world({ fetchImpl: okCode('37401230') });
  try {
    const long = longUrl();
    assert.equal(sb.shortLinkIfReady(long), long, 'nothing minted yet');
    assert.equal(await sb.shortenShareUrl(long), 'https://respondertx.org/s/37401230');
    assert.equal(w.calls.length, 1);
    assert.equal(w.calls[0].url, '/api/share');
    assert.equal(w.calls[0].opts.method, 'POST');
    assert.equal(JSON.parse(w.calls[0].opts.body).q, new URL(long).search.slice(1));
    assert.equal(await sb.shortenShareUrl(long), 'https://respondertx.org/s/37401230');
    assert.equal(w.calls.length, 1, 'the same view must not be minted twice in one session');
    assert.equal(sb.shortLinkIfReady(long), 'https://respondertx.org/s/37401230');
  } finally { w.restore(); }
});

test('copyShortLink starts the clipboard write inside the tap and lands the short link', async () => {
  let answer;
  const w = world({ fetchImpl: () => new Promise((r) => { answer = r; }) });
  try {
    const btn = button();
    const copying = sb.copyShortLink(longUrl(), btn);
    assert.equal(w.started, 1, 'the write must begin synchronously, before the mint answers');
    await tick();
    assert.equal(w.copied.length, 0, 'the clipboard holds the promise until the mint answers');
    answer({ ok: true, status: 200, json: async () => ({ code: '51234567' }) });
    assert.equal(await copying, 'https://respondertx.org/s/51234567');
    assert.deepEqual(w.copied, ['https://respondertx.org/s/51234567']);
    assert.equal(btn.textContent, 'share.copied');
    w.fire(2000);
    assert.equal(btn.innerHTML, '🔗 <span>Copy link</span>', 'the label is restored with its markup');
  } finally { w.restore(); }
});

test('every service failure copies the full link and says so plainly', async () => {
  const failures = {
    'binding absent (503)': async () => ({ ok: false, status: 503, json: async () => ({ error: 'share links not configured' }) }),
    'rate limited (429)': async () => ({ ok: false, status: 429, json: async () => ({ error: 'too many requests' }) }),
    'refused (400)': async () => ({ ok: false, status: 400, json: async () => ({ error: 'param not allowed' }) }),
    'network error': async () => { throw new TypeError('Failed to fetch'); },
    'malformed code': okCode('123'),
    'foreign url as code': okCode('https://evil.example/s/1'),
    'unparseable body': async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }),
  };
  for (const [why, impl] of Object.entries(failures)) {
    const w = world({ fetchImpl: impl });
    try {
      const long = longUrl();
      const btn = button();
      assert.equal(await sb.copyShortLink(long, btn), long, why);
      assert.deepEqual(w.copied, [long], why);
      assert.equal(btn.textContent, 'share.copied.full', why);
      assert.equal(sb.shortLinkIfReady(long), long, `${why}: a failure is never reported as a short link`);
      await sb.shortenShareUrl(long);
      assert.equal(w.calls.length, 2, `${why}: a failure is not cached, the next copy asks again`);
    } finally { w.restore(); }
  }
});

test('a mirror that does not answer within the timeout yields the full link and aborts the request', async () => {
  let signal = null;
  const w = world({ fetchImpl: (url, opts) => { signal = opts.signal; return new Promise(() => {}); } });
  try {
    assert.equal(SHORT_LINK_TIMEOUT_MS, 3000);
    const long = longUrl();
    const btn = button();
    const copying = sb.copyShortLink(long, btn);
    await tick();
    assert.equal(w.copied.length, 0, 'nothing is copied while the mint is in flight');
    w.fire(SHORT_LINK_TIMEOUT_MS);
    assert.equal(await copying, long);
    assert.deepEqual(w.copied, [long]);
    assert.equal(btn.textContent, 'share.copied.full');
    assert.equal(signal.aborted, true);
  } finally { w.restore(); }
});

test('offline, the full link is copied without asking the network', async () => {
  const w = world({ fetchImpl: okCode('37401230'), onLine: false });
  try {
    const long = longUrl();
    const btn = button();
    assert.equal(await sb.copyShortLink(long, btn), long);
    assert.equal(w.calls.length, 0);
    assert.equal(btn.textContent, 'share.copied.full');
  } finally { w.restore(); }
});

test('the LAN board and every non-mirror origin copy the full link and never call the service', async () => {
  const origins = [
    { origin: 'http://192.168.1.50:8080', hostname: '192.168.1.50', protocol: 'http:' }, // server.py
    { origin: 'https://192.168.1.50:8443', hostname: '192.168.1.50', protocol: 'https:' }, // server.py TLS
    { origin: 'http://localhost:8080', hostname: 'localhost', protocol: 'http:' },
    { origin: 'http://respondertx.org', hostname: 'respondertx.org', protocol: 'http:' },
    { origin: 'https://respondertx.org.evil.example', hostname: 'respondertx.org.evil.example', protocol: 'https:' },
    { origin: 'https://other.pages.dev', hostname: 'other.pages.dev', protocol: 'https:' },
  ];
  for (const o of origins) {
    for (const clipboard of ['modern', 'legacy']) {
      const w = world({ loc: { ...MIRROR, ...o }, fetchImpl: okCode('37401230'), clipboard });
      try {
        const long = longUrl(o.origin);
        const btn = button();
        assert.equal(await sb.copyShortLink(long, btn), long, o.origin);
        assert.equal(w.calls.length, 0, `${o.origin} must not call /api/share`);
        assert.deepEqual(w.copied, [long]);
        assert.equal(btn.textContent, 'share.copied.full');
      } finally { w.restore(); }
    }
  }
  // on the mirror, a link that is not a board view is never shortened either
  const w = world({ fetchImpl: okCode('37401230') });
  try {
    for (const u of ['https://example.org/?mlat=1', 'https://respondertx.org/data/x.json?mlat=1',
      'https://respondertx.org/', 'https://respondertx.org/?mlat=1#frag', 'not a url']) {
      assert.equal(await sb.shortenShareUrl(u), u);
    }
    assert.equal(w.calls.length, 0);
  } finally { w.restore(); }
});

test('a pages.dev preview of the mirror shortens on its own host', async () => {
  const host = 'abc123.responder-tx.pages.dev';
  const w = world({ loc: { ...MIRROR, origin: `https://${host}`, hostname: host }, fetchImpl: okCode('42424242') });
  try {
    assert.equal(await sb.shortenShareUrl(longUrl(`https://${host}`)), `https://${host}/s/42424242`);
  } finally { w.restore(); }
});

test('without ClipboardItem the link on hand is copied inside the tap: full now, short once one exists', async () => {
  const w = world({ fetchImpl: okCode('61234567'), clipboard: 'legacy' });
  try {
    const long = longUrl();
    const btn = button();
    const copying = sb.copyShortLink(long, btn);
    assert.equal(w.started, 1, 'the write must begin synchronously');
    assert.deepEqual(w.copied, [long], 'the full link, because waiting for a mint would lose the tap');
    assert.equal(w.calls.length, 0, 'no view is stored for a link the user did not get');
    assert.equal(await copying, long);
    assert.equal(btn.textContent, 'share.copied.full');
    // a short link minted earlier (the same view copied in a browser that could wait) is used at once
    sb.ClipboardItem = ClipboardItem;
    sb.navigator.clipboard.write = (items) => Promise.resolve(items[0].items['text/plain']).then((b) => b.text()).then((s) => { w.copied.push(s); });
    await sb.copyShortLink(long, button());
    sb.ClipboardItem = undefined;
    delete sb.navigator.clipboard.write;
    w.copied.length = 0;
    w.started = 0;
    sb.copyShortLink(long, btn);
    assert.equal(w.started, 1);
    assert.deepEqual(w.copied, ['https://respondertx.org/s/61234567']);
  } finally { w.restore(); }
});

test('a refused clipboard hands the link over in a prompt instead', async () => {
  const modern = world({ fetchImpl: okCode('71234567'), clipboard: { write: async () => { throw new Error('NotAllowedError'); }, writeText: async () => {} } });
  try {
    await sb.copyShortLink(longUrl(), button());
    assert.deepEqual(modern.prompted, ['https://respondertx.org/s/71234567']);
  } finally { modern.restore(); }
  const legacy = world({ fetchImpl: okCode('71234568'), clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } });
  try {
    const long = longUrl();
    await sb.copyShortLink(long, button());
    assert.deepEqual(legacy.prompted, [long]);
  } finally { legacy.restore(); }
});

/* ---------- the share sheet: the map's chain-link control and Settings > Share both open it ---------- */

function sheetDom() {
  const el = (extra = {}) => ({ textContent: '', hidden: true, dataset: {}, innerHTML: '', focus() {}, ...extra });
  const els = { '#share-sheet': el(), '#share-url': el(), '#share-native': el(), '#share-qr': el(), '#share-copy': el({ textContent: 'Copy link', innerHTML: 'Copy link' }) };
  return { els, querySelector: (s) => els[s] || null };
}

async function withSheet(fetchImpl, fn) {
  const w = world({ fetchImpl });
  const saved = { document: sb.document, buildShareUrl: sb.buildShareUrl, renderQr: sb.renderQr, shareUrl: state.shareUrl };
  const dom = sheetDom();
  const long = longUrl();
  sb.document = dom;
  sb.buildShareUrl = () => long;
  sb.renderQr = () => {};
  try { await fn(dom.els, long, w); } finally {
    w.restore();
    sb.document = saved.document;
    sb.buildShareUrl = saved.buildShareUrl;
    sb.renderQr = saved.renderQr;
    state.shareUrl = saved.shareUrl;
  }
}

test('opening the share sheet stores nothing; Copy link mints, copies, and shows the short link', async () => {
  await withSheet(okCode('81234567'), async (els, long, w) => {
    sb.openShareSheet();
    assert.equal(els['#share-sheet'].hidden, false);
    await tick();
    assert.equal(w.calls.length, 0, 'the sheet also hosts export, so opening it must not store a view');
    assert.equal(els['#share-url'].textContent, long);
    await sb.copyShareUrl();
    assert.equal(w.calls.length, 1);
    assert.deepEqual(w.copied, ['https://respondertx.org/s/81234567']);
    assert.equal(els['#share-copy'].textContent, 'share.copied');
    assert.equal(els['#share-url'].textContent, 'https://respondertx.org/s/81234567', 'the code to read aloud is on screen');
    // reopening the same view shows the short link at once, and Share to an app gets it without waiting
    sb.openShareSheet();
    assert.equal(els['#share-url'].textContent, 'https://respondertx.org/s/81234567');
    assert.equal(sb.shortLinkIfReady(long), 'https://respondertx.org/s/81234567');
    await sb.copyShareUrl();
    assert.equal(w.calls.length, 1, 'a second Copy reuses the minted link');
  });
});

test('when the mint fails the sheet keeps the full link, and Copy link says it copied the full link', async () => {
  await withSheet(async () => ({ ok: false, status: 503, json: async () => ({}) }), async (els, long, w) => {
    sb.openShareSheet();
    await sb.copyShareUrl();
    assert.deepEqual(w.copied, [long]);
    assert.equal(els['#share-copy'].textContent, 'share.copied.full');
    assert.equal(els['#share-url'].textContent, long);
    assert.equal(sb.shortLinkIfReady(long), long, 'Share to an app then hands out the full link');
  });
});

/* ---------- client and server agree on what a board view can carry ---------- */

// every condition buildShareUrl tests answers "on", so every param it can emit is emitted
function everythingOn(fn) {
  const saved = {
    map: state.map, layers: state.layers, filters: state.filters, sort: state.sort, rainWindow: state.rainWindow,
    basinRiver: state.basinRiver, activeBase: state.activeBase, document: sb.document, aoPickedId: sb.aoPickedId,
  };
  const anyEl = { value: 'x', hidden: false, dataset: {} };
  sb.document = {
    querySelector: (s) => (s === '.tabs button.active' ? { dataset: { tab: 'tab-gauges' } } : anyEl),
    documentElement: { getAttribute: () => 'dark' },
  };
  state.map = { getCenter: () => ({ lat: 29.4241, lng: -98.4936 }), getZoom: () => 11, hasLayer: () => true };
  state.layers = new Proxy({}, { get: (t, k) => ({ id: String(k) }) });
  state.filters = new Proxy({}, { get: () => 'x' });
  state.sort = 'age';
  state.rainWindow = '24h';
  state.basinRiver = 'guadalupe-river';
  state.activeBase = 'Dark';
  sb.aoPickedId = () => 'houston';
  try { return fn(); } finally {
    Object.assign(state, { map: saved.map, layers: saved.layers, filters: saved.filters, sort: saved.sort,
      rainWindow: saved.rainWindow, basinRiver: saved.basinRiver, activeBase: saved.activeBase });
    sb.document = saved.document;
    sb.aoPickedId = saved.aoPickedId;
  }
}

test('every key buildShareUrl can emit is on the server allowlist, and the allowlist holds nothing else', () => {
  const url = everythingOn(() => sb.buildShareUrl());
  const emitted = [...new URLSearchParams(new URL(url).search).keys()].sort();
  assert.deepEqual(emitted, Array.from(server.VIEW_KEYS).sort());
  const norm = server.normalizeQuery(new URL(url).search);
  assert.equal(norm.error, undefined, `the server refuses the board's own maximal link: ${norm.error}`);
});

test("the server's extra keys are record links the board opens at boot, and never a team invite", () => {
  const { OB_RECORD_PARAMS } = loadFullApp();
  for (const k of server.RECORD_KEYS) assert.ok(OB_RECORD_PARAMS.includes(k), `${k} is not a param the board opens`);
  assert.ok(OB_RECORD_PARAMS.includes('team'), 'the board does open ?team=, which is why it is excluded on purpose');
  assert.ok(!server.VIEW_KEYS.includes('team') && !server.RECORD_KEYS.includes('team'));
});

test('a real board link survives the round trip: mint, open /s/<code>, land on the same query', async () => {
  const url = everythingOn(() => sb.buildShareUrl());
  const { links } = server.newLinks();
  const SHARE = server.makeNamespace(links);
  const minted = await server.shareFn.onRequestPost({
    request: new Request('https://respondertx.org/api/share', { method: 'POST', body: JSON.stringify({ q: new URL(url).search.slice(1) }) }),
    env: { SHARE },
  });
  const { code } = await minted.json();
  const opened = await server.shortFn.onRequestGet({ request: new Request(`https://respondertx.org/s/${code}`), env: { SHARE }, params: { code } });
  assert.equal(opened.status, 302);
  const landed = new URL(opened.headers.get('Location'));
  const sorted = (u) => [...new URLSearchParams(u.search)].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  assert.deepEqual(sorted(landed), sorted(new URL(url)));
  assert.equal(landed.pathname, '/');
});
