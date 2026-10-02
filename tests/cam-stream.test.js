'use strict';

/* TxDOT now signs every camera stream with a token that lapses within minutes, so the playable URL
   has to be resolved when a camera is opened and re-signed while it plays. A feed that cannot be
   resolved, or that the player gives up on, must say which operator's feed is down instead of
   leaving a spinner or a black frame under a LIVE badge. Everything here runs the shipped code
   against the captured DriveTexas answer in tests/fixtures; no request leaves the process. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadApp } = require('./harness.js');

const APP = loadApp();
const SB = APP._sandbox;
const { state } = APP;
const CAPTURED = require(path.join(__dirname, 'fixtures', 'drivetexas-cameras.json'));
SB.atob = (s) => Buffer.from(s, 'base64').toString('binary');

const ACTIVE_URL = 'https://dtx-e-cdn.maplarge.com/Remote/GetActiveTableID?shortTableId=appgeo%2FcameraPoint';
const jsonRes = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });

// a signed URL whose token expires `inS` seconds from now, in the operator's own token shape
function signed(name, inS) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const tok = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + inS })}.sig_${inS}`;
  return `https://s76.us-east-1.skyvdn.com/rtplive/${name}/playlist.m3u8?token=${tok}`;
}

// fetch stand-in that answers like the captured upstream; `byName` overrides the camera query body
function maplarge({ table = CAPTURED.activeTable, byName = CAPTURED.byName, calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url, init });
    if (url === ACTIVE_URL) return jsonRes(table);
    if (url.startsWith('https://dtx-e-cdn.maplarge.com/Api/ProcessDirect?request=')) return jsonRes(byName);
    throw new Error(`unexpected request ${url}`);
  };
}

async function withFetch(fake, fn) {
  const saved = SB.fetch;
  SB.fetch = fake;
  try { return await fn(); } finally { SB.fetch = saved; }
}

test('a TxDOT camera resolves to the operator\'s freshly signed playlist, by name, on the active table', async () => {
  const calls = [];
  const url = await withFetch(maplarge({ calls }), () => SB.dtxStreamUrl('TX_AUS_033'));
  assert.equal(url, CAPTURED.byName.data.data.httpsurl[0]);
  assert.match(url, /^https:\/\/s\d+\.us-east-1\.skyvdn\.com\/rtplive\/TX_AUS_033\/playlist\.m3u8\?token=/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.cache, 'no-store', 'the active table id must not come from the browser cache');
  const q = JSON.parse(decodeURIComponent(calls[1].url.split('request=')[1])).query;
  assert.equal(q.table, CAPTURED.activeTable.table, 'the CDN caches the short table name for a week');
  assert.deepEqual(q.where, [{ col: 'name', test: 'EqualAny', value: ['TX_AUS_033'] }]);
});

test('a resolver answer that is not this camera\'s stream is a dead feed, never a URL', async () => {
  const body = (names, urls, success = true) => ({ success, data: { data: { name: names, httpsurl: urls } } });
  const cases = {
    'another host': body(['TX_AUS_033'], ['https://evil.example/rtplive/TX_AUS_033/playlist.m3u8?token=x']),
    'plain http': body(['TX_AUS_033'], ['http://s76.us-east-1.skyvdn.com/rtplive/TX_AUS_033/playlist.m3u8']),
    'the camera is missing': body(['TX_AUS_034'], [CAPTURED.byName.data.data.httpsurl[0]]),
    'the query was refused': body(['TX_AUS_033'], [CAPTURED.byName.data.data.httpsurl[0]], false),
    'an error envelope': { error: { code: 500 } },
  };
  // errors are raised inside the vm realm, so match on the message rather than instanceof Error
  const refused = (e) => /drivetexas|upstream error body/.test(e && e.message);
  for (const [label, byName] of Object.entries(cases)) {
    await assert.rejects(withFetch(maplarge({ byName }), () => SB.dtxStreamUrl('TX_AUS_033')), refused, label);
  }
  await assert.rejects(withFetch(maplarge({ table: { table: 'appgeo/cameraPoint' } }), () => SB.dtxStreamUrl('TX_AUS_033')),
    /no active camera table/);
  await assert.rejects(withFetch(maplarge(), () => SB.dtxStreamUrl('TX_AUS_033&x=1')), /bad camera name/);
});

test('a token\'s remaining life is read from the token itself', () => {
  const left = SB.camTokenLeft(signed('TX_AUS_033', 200));
  assert.ok(left > 195 && left <= 200, `left=${left}`);
  assert.ok(SB.camTokenLeft(signed('TX_AUS_033', -5)) < 0, 'an expired token reads as expired');
  assert.equal(SB.camTokenLeft('https://zoocams.elpasozoo.org/bridgepdn1.m3u8'), Infinity, 'an unsigned stream never expires');
  assert.equal(SB.camTokenLeft('https://x.skyvdn.com/a/playlist.m3u8?token=garbage'), 0, 'an unreadable token is treated as spent');
});

test('the stream source re-resolves only as its token nears expiry, and never twice at once', async () => {
  let n = 0;
  const answers = [signed('TX_AUS_033', 20), signed('TX_AUS_033', 290)];
  const saved = SB.dtxStreamUrl;
  SB.dtxStreamUrl = async () => answers[Math.min(n++, answers.length - 1)];
  try {
    const src = SB.camStreamSource({ name: 'TX_AUS_033' }, 'txdot');
    const [a, b] = await Promise.all([src(), src()]);
    assert.equal(n, 1, 'concurrent requests share one resolution');
    assert.equal(a, b);
    // the first answer had 20 s left, under the margin, but was resolved a moment ago: held, not hammered
    assert.equal(await src(), answers[0]);
    assert.equal(n, 1);
    const realNow = SB.Date.now;
    SB.Date.now = () => realNow() + 16000;
    try { assert.equal(await src(), answers[1], 'a token inside the margin is replaced'); } finally { SB.Date.now = realNow; }
    assert.equal(n, 2);
    assert.equal(await src(), answers[1], 'a fresh token is reused');
    assert.equal(n, 2);
  } finally { SB.dtxStreamUrl = saved; }
  const elp = SB.camStreamSource({ httpsurl: 'https://zoocams.elpasozoo.org/bridgepdn1.m3u8' }, 'elpbridge');
  assert.equal(await elp(), 'https://zoocams.elpasozoo.org/bridgepdn1.m3u8', 'an unsigned network plays its published URL');
});

/* ---------- the viewer, executed end to end against a stub DOM ---------- */

function node(tag) {
  const el = {
    tagName: tag, innerHTML: '', children: [], handlers: {}, style: {}, hidden: false, textContent: '',
    appendChild(x) { el.children.push(x); el.innerHTML = `<${x.tagName}>`; },
    addEventListener(type, fn) { (el.handlers[type] = el.handlers[type] || []).push(fn); },
    fire(type) { for (const fn of el.handlers[type] || []) fn({ type }); },
    querySelector(sel) {
      if (sel === 'video') return el.children.find((c) => c.tagName === 'video') || null;
      if (sel === '.cam-refresh') return el.innerHTML.includes('cam-refresh') ? node('button') : null;
      return null;
    },
    pause() {}, removeAttribute() {}, load() {}, play() { return Promise.resolve(); },
  };
  return el;
}

function mountViewer({ nativeHls = false, mse = true } = {}) {
  const dom = { '#cam-viewer': node('div'), '#cam-title': node('div'), '#cam-stage': node('div'),
    '#cam-meta': node('div'), '#cam-note': node('div') };
  const made = [];
  const saved = { qs: SB.document.querySelector, ce: SB.document.createElement, ms: SB.MediaSource, hls: SB.Hls };
  SB.document.querySelector = (sel) => dom[sel] || null;
  SB.document.createElement = (tag) => {
    const el = node(tag);
    if (tag === 'video') el.canPlayType = () => (nativeHls ? 'maybe' : '');
    made.push(el);
    return el;
  };
  SB.MediaSource = mse ? function MediaSource() {} : undefined;
  const players = [];
  SB.Hls = class {
    constructor(cfg) { this.cfg = cfg; this.on = (ev, fn) => { this.ev = ev; this.onError = fn; }; players.push(this); }
    static isSupported() { return true; }
    loadSource(u) { this.src = u; }
    attachMedia(v) { this.video = v; }
    destroy() { this.destroyed = true; }
  };
  SB.Hls.Events = { ERROR: 'hlsError' };
  const restore = () => {
    SB.document.querySelector = saved.qs; SB.document.createElement = saved.ce;
    SB.MediaSource = saved.ms; SB.Hls = saved.hls; state.camHls = null;
    clearTimeout(state.camResign);
  };
  return { stage: dom['#cam-stage'], meta: dom['#cam-meta'], made, players, restore };
}

const settle = () => new Promise((r) => setImmediate(r));
const TX_CAM = { name: 'TX_AUS_033', description: 'IH-35 @ River Hills Drive', lat: 30.63984, lon: -97.6897,
  httpsurl: 'https://s76.us-east-1.skyvdn.com/rtplive/TX_AUS_033/playlist.m3u8' };

test('a TxDOT stream that cannot be resolved says the TxDOT feed is down, with no LIVE badge', async () => {
  // both players: hls.js where MSE exists, and the native one where it is the only option
  for (const opts of [{ nativeHls: false, mse: true }, { nativeHls: true, mse: false }]) {
    const v = mountViewer(opts);
    try {
      await withFetch(async () => jsonRes({}, false), async () => {
        SB.openCamViewer(TX_CAM, 'txdot');
        await settle(); await settle();
      });
      const how = JSON.stringify(opts);
      assert.match(v.stage.innerHTML, /cam\.feed\.unavail/, `${how} stage was: ${v.stage.innerHTML}`);
      assert.doesNotMatch(v.stage.innerHTML, /cam\.loading/, `${how}: a spinner left up is the silent failure this replaces`);
      assert.doesNotMatch(v.meta.innerHTML, /cam\.live/, `${how}: a dead feed must not wear the LIVE badge`);
      assert.equal(v.players.length, 0, `${how}: no player is started on a URL that was never resolved`);
    } finally { v.restore(); }
  }
});

test('a resolved TxDOT stream plays the signed URL, re-signs every request, and a fatal player error is reported', async () => {
  const v = mountViewer({ nativeHls: true, mse: true });
  try {
    await withFetch(maplarge(), async () => {
      SB.openCamViewer(TX_CAM, 'txdot');
      await settle(); await settle(); await settle();
    });
    assert.equal(v.players.length, 1, 'a signed stream goes to hls.js even where native HLS exists, so it can be re-signed');
    const p = v.players[0];
    assert.equal(p.src, CAPTURED.byName.data.data.httpsurl[0]);
    assert.match(v.meta.innerHTML, /cam\.live/);
    assert.equal(p.ev, 'hlsError', 'the player has no error handler, so a dead stream would sit black under LIVE');

    // hls.js reloads chunklists with the token it started on; xhrSetup must swap in the newest one
    const fresh = signed('TX_AUS_033', 280);
    const saved = SB.dtxStreamUrl;
    const realNow = SB.Date.now;
    SB.dtxStreamUrl = async () => fresh;
    SB.Date.now = () => realNow() + 10 * 60000; // the captured token is long spent by now
    const opened = [];
    try {
      await p.cfg.xhrSetup({ open: (m, u) => opened.push(u) },
        'https://s76.us-east-1.skyvdn.com/rtplive/TX_AUS_033/chunklist_w1499630002.m3u8?token=OLD');
    } finally { SB.dtxStreamUrl = saved; SB.Date.now = realNow; }
    assert.equal(new URL(opened[0]).searchParams.get('token'), new URL(fresh).searchParams.get('token'));
    assert.match(opened[0], /chunklist_w1499630002\.m3u8/, 're-signing must keep the session the player is on');

    p.onError('hlsError', { fatal: false, details: 'fragLoadError' });
    assert.match(v.meta.innerHTML, /cam\.live/, 'a recoverable hiccup is not a dead feed');
    p.onError('hlsError', { fatal: true, details: 'manifestLoadError' });
    assert.match(v.stage.innerHTML, /cam\.feed\.unavail/);
    assert.equal(v.meta.innerHTML, '', 'the LIVE badge goes with the feed');
    assert.ok(p.destroyed, 'a dead player is torn down, not left retrying in the background');
  } finally { v.restore(); }
});

test('an unsigned live stream still plays natively without fetching the player', async () => {
  const v = mountViewer({ nativeHls: true, mse: true });
  try {
    SB.openCamViewer({ name: 'Paso del Norte', lat: 31.75, lon: -106.48, httpsurl: 'https://zoocams.elpasozoo.org/bridgepdn1.m3u8' }, 'elpbridge');
    await settle();
    const video = v.made.find((e) => e.tagName === 'video');
    assert.equal(video.src, 'https://zoocams.elpasozoo.org/bridgepdn1.m3u8');
    assert.equal(v.players.length, 0);
    video.fire('error');
    assert.match(v.stage.innerHTML, /cam\.feed\.unavail/, 'a native player error is reported, not left black');
  } finally { v.restore(); }
});

test('where only a native player exists, a signed stream is re-pointed before its token lapses', async () => {
  const v = mountViewer({ nativeHls: true, mse: false });
  const timers = [];
  const savedSet = SB.setTimeout;
  const saved = SB.dtxStreamUrl;
  const answers = [signed('TX_AUS_033', 200), signed('TX_AUS_033', 290)];
  SB.dtxStreamUrl = async () => answers.shift();
  SB.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  try {
    SB.openCamViewer(TX_CAM, 'txdot');
    await settle(); await settle();
    const video = v.made.find((e) => e.tagName === 'video');
    assert.match(video.src, /token=/);
    assert.equal(timers.length, 1);
    assert.ok(timers[0].ms > 150000 && timers[0].ms < 175000, `re-sign due in ${timers[0].ms} ms for a 200 s token`);
    const first = video.src;
    const realNow = SB.Date.now;
    SB.Date.now = () => realNow() + timers[0].ms;
    try {
      timers[0].fn();
      await settle(); await settle();
    } finally { SB.Date.now = realNow; }
    assert.notEqual(video.src, first, 'the player is handed the newly signed URL');
    assert.equal(timers.length, 2, 'and the next re-sign is scheduled');
  } finally { SB.setTimeout = savedSet; SB.dtxStreamUrl = saved; v.restore(); }
});

/* ---------- City of Austin: the edge is refused, the browser is not ---------- */

const AUSTIN_CAM = { id: '250', name: 'FM 969 / Johnny Morris', lat: 30.28, lon: -97.66 };

test('an Austin still the edge cannot fetch loads straight from the city, and says its age is unchecked', async () => {
  const v = mountViewer();
  try {
    await withFetch(async () => ({ ok: false, status: 502, headers: { get: () => null } }), async () => {
      SB.openCamViewer(AUSTIN_CAM, 'austin');
      await settle(); await settle();
    });
    const img = v.made.find((e) => e.tagName === 'img');
    assert.ok(img, 'no direct image was attempted');
    assert.equal(img.src, 'https://cctv.austinmobility.io/image/250.jpg');
    assert.match(v.stage.innerHTML, /cam\.loading/, 'the frame is not swapped in until it has actually loaded');
    img.fire('load');
    assert.deepEqual(v.stage.children.slice(-1), [img]);
    assert.match(v.meta.innerHTML, /cam\.direct/);
    assert.doesNotMatch(v.meta.innerHTML, /cam\.snapshot|cam\.captured/,
      'a frame whose time the board never read must not wear the dated snapshot chip');
  } finally { v.restore(); }
});

test('an Austin camera the city cannot serve either is reported down, naming the operator', async () => {
  const v = mountViewer();
  try {
    await withFetch(async () => ({ ok: false, status: 502, headers: { get: () => null } }), async () => {
      SB.openCamViewer(AUSTIN_CAM, 'austin');
      await settle(); await settle();
    });
    v.made.find((e) => e.tagName === 'img').fire('error');
    assert.match(v.stage.innerHTML, /cam\.feed\.unavail/);
    assert.equal(v.meta.innerHTML, '');
  } finally { v.restore(); }
});

test('a still network with no direct path reports the proxy failure without guessing a URL', async () => {
  const v = mountViewer();
  try {
    await withFetch(async () => ({ ok: false, status: 502, headers: { get: () => null } }), async () => {
      SB.openCamViewer({ id: '102', name: 'IH-45 at Main', lat: 29.7, lon: -95.3 }, 'houston');
      await settle(); await settle();
    });
    assert.equal(v.made.filter((e) => e.tagName === 'img').length, 0);
    assert.match(v.stage.innerHTML, /cam\.feed\.unavail/);
  } finally { v.restore(); }
});

test('the operator named in a dead-feed message is the one that runs the camera', () => {
  const saved = SB.t;
  SB.t = (k) => (k === 'cam.feed.unavail' ? 'Camera feed unavailable from {op} right now.' : k);
  const stage = node('div');
  const meta = node('div');
  try {
    for (const [kind, op] of [['txdot', 'TxDOT'], ['austin', 'Austin'], ['nmdot', 'NMDOT'], ['river', 'USGS']]) {
      SB.camFeedDown(stage, meta, kind);
      assert.match(stage.innerHTML, new RegExp(`unavailable from ${op} right now`), kind);
    }
  } finally { SB.t = saved; }
});
