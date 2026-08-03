'use strict';

/*
 * Web-push discovery contract (v0.99.37 · end of the soft launch). The evaluator, the registry and
 * the encryption are covered by the other push-*.test.js suites; this one covers the client half
 * that decides whether a resident can ever find alert delivery at all, plus the two invariants the
 * promotion is allowed to change nothing about: the honesty framing on the card, and the rule that
 * the Notification prompt only ever fires inside an explicit tap.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./harness.js');
const I18N = require('./i18n-load.js');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const BOARD = read('js/board.js');
const BOOT = read('js/boot.js');
const HTML = read('index.html');
const CSS = read('css/app.css');

const APP = loadApp();
const { pushCardVisible, pushCardState, pushEntryStateKey } = APP;
const SB = APP._sandbox;

// the same environment facts pushEnvFacts() reports, for a capable browser that never opted in
const facts = (over = {}) => ({
  ios: false, standalone: false, secure: true, hasSW: true, hasPush: true, hasNotif: true,
  permission: 'default', subscribed: false, flagged: false, ...over,
});

/* ---------- the card as the browser really paints it ----------

   renderPushCard() is what a resident actually meets, and a regex over js/board.js cannot tell a
   drawn card from one that throws on its first paint. That is how a whole layer shipped dead in
   v0.99.79 behind six green source-text assertions, so every claim below about the card's markup
   is read off markup the shipped function emitted. */

// browser environments, not fact bags: pushEnvFacts() reads each one back out for itself
const PUSH_DEVICE = {
  off: { permission: 'default', subscribed: false, hasPush: true },
  on: { permission: 'granted', subscribed: true, hasPush: true },
  blocked: { permission: 'denied', subscribed: false, hasPush: true },
  ios: { permission: 'default', subscribed: false, hasPush: false, ua: 'iPhone' },
  unsupported: { permission: 'default', subscribed: false, hasPush: false },
};

// the accordion rows are the only nodes the card looks up on itself; answering them out of markup
// it really emitted stops a row it has quietly dropped from being faked back into existence
function pushHost() {
  const host = {
    innerHTML: '', firstChild: true, taps: {}, asked: [],
    querySelectorAll(sel) {
      if (sel !== '.push-sec[data-sec]') return [];
      return [...host.innerHTML.matchAll(/push-sec" data-sec="([a-z]+)"/g)].map(([, key]) => ({
        getAttribute: (a) => (a === 'data-sec' ? key : null),
        addEventListener: (ev, fn) => { if (ev === 'click') host.taps[key] = fn; },
      }));
    },
  };
  return host;
}

/* Renders `device` once and returns the host. Only the selectors passed in `nodes` are answered;
   everything else resolves to null, so a node the card starts needing shows up as a change here
   rather than as a mock that agrees with anything. `body(host)` may tap panes open, and must carry
   its own assertions: the cleanup closes whatever is left open, since pushSection is module state
   every test in this file shares. */
function renderCard(device, { prefs = {}, nodes = {} } = {}, body) {
  const d = PUSH_DEVICE[device];
  const keep = { qs: SB.document.querySelector, notif: SB.Notification, pm: SB.PushManager,
    secure: SB.isSecureContext, sw: SB.navigator.serviceWorker, ua: SB.navigator.userAgent };
  SB.isSecureContext = true;
  SB.navigator.serviceWorker = {};
  SB.navigator.userAgent = d.ua || 'Mozilla/5.0';
  SB.Notification = { permission: d.permission };
  if (d.hasPush) SB.PushManager = function PushManager() {}; else delete SB.PushManager;
  SB.localStorage.setItem('respondertx.push', JSON.stringify({ on: d.subscribed, prefs }));
  const host = pushHost();
  const reg = Object.assign({ '#push-body': host }, nodes);
  // A control the card draws inside itself resolves only once it has really drawn it: in a browser
  // that lookup runs after #push-body was overwritten, so answering unconditionally would hide a
  // control that stopped being emitted.
  const drawn = (sel) => sel === '#push-body' || !/^#push-/.test(sel)
    || host.innerHTML.includes(`id="${sel.slice(1)}"`);
  SB.document.querySelector = (s) => {
    host.asked.push(s);
    return Object.prototype.hasOwnProperty.call(reg, s) && drawn(s) ? reg[s] : null;
  };
  try {
    SB.renderPushCard();
    if (body) body(host);
    return host;
  } finally {
    const open = host.innerHTML.match(/data-sec="([a-z]+)" aria-expanded="true"/);
    if (open) host.taps[open[1]]();
    SB.document.querySelector = () => null; // so the preselect reset cannot reopen the sheet
    SB.pushOpenManageFor('');
    SB.document.querySelector = keep.qs; SB.Notification = keep.notif;
    SB.isSecureContext = keep.secure; SB.navigator.serviceWorker = keep.sw; SB.navigator.userAgent = keep.ua;
    if (keep.pm === undefined) delete SB.PushManager; else SB.PushManager = keep.pm;
    SB.localStorage.removeItem('respondertx.push'); // the bundle is cached across tests in this file
  }
}

/* ---------- who can find the card ---------- */

test('the alerts card is visible to a supported device that never subscribed and never got a link', () => {
  // the soft launch: pushCardVisible() returned subscribed || flagged, so the one surface that
  // delivers what this board exists for was unreachable for every first-time visitor
  const f = facts();
  assert.equal(pushCardState(f), 'off', 'the fixture must be a plain capable browser');
  assert.equal(pushCardVisible(f), true);
});

test('every prior card state still renders for a device that can act on it', () => {
  for (const [label, over] of [
    ['off', {}],
    ['on', { subscribed: true, permission: 'granted' }],
    ['blocked', { permission: 'denied' }],
    ['ios', { ios: true, hasPush: false }],
  ]) {
    const f = facts(over);
    assert.equal(pushCardState(f), label, `fixture for ${label} does not produce that state`);
    assert.equal(pushCardVisible(f), true, `${label} must still reach the card`);
  }
});

test('a browser with no push at all stays hidden unless it asked or already subscribed', () => {
  // nothing a visitor on such a browser could do about it, so an unprompted dead end is noise;
  // a deep link or a live subscription still shows the honest "not supported" state
  const dead = facts({ hasPush: false, hasSW: false, hasNotif: false });
  assert.equal(pushCardState(dead), 'unsupported');
  assert.equal(pushCardVisible(dead), false);
  assert.equal(pushCardVisible({ ...dead, flagged: true }), true, '?push must keep working');
  assert.equal(pushCardVisible({ ...dead, subscribed: true }), true, 'the off switch stays reachable');
});

test('a subscribed device gets its card, and therefore its off switch, in every state', () => {
  // the original regression: a Flash Flood Emergency deep link landed on a board with no card,
  // no state line and no toggle, so an opted-in device had no reachable way to turn alerts off
  for (const over of [{}, { permission: 'denied' }, { secure: false }, { ios: true, hasPush: false }]) {
    assert.equal(pushCardVisible(facts({ ...over, subscribed: true })), true);
    assert.equal(pushCardVisible(facts({ ...over, subscribed: true, flagged: true })), true);
  }
});

/* Reaching the card is half of it; the off switch has to be drawn on it, wired to the action that
   matches the state. The states that cannot be toggled out of get no switch at all, because a
   button that cannot do anything is worse than the sentence explaining why. */
test('the off switch is drawn and correctly wired in exactly the two toggleable states', () => {
  const tapped = (device) => {
    const btn = { addEventListener(ev, fn) { if (ev === 'click') btn.fn = fn; } };
    const drawn = renderCard(device, { nodes: { '#push-toggle': btn } }).innerHTML;
    return { html: drawn, fn: btn.fn };
  };

  const on = tapped('on');
  assert.match(on.html, /class="act-btn push-toggle" id="push-toggle">push\.toggle\.off</,
    'a subscribed device must be offered the off label');
  assert.equal(on.fn, SB.pushDisable, 'the switch on a subscribed device must turn alerts off');

  const off = tapped('off');
  assert.match(off.html, /class="act-btn push-toggle" id="push-toggle">push\.toggle\.on</);
  assert.equal(off.fn, SB.pushEnable, 'the switch on an unsubscribed device must be the one enable path');

  for (const device of ['blocked', 'ios', 'unsupported']) {
    const dead = tapped(device);
    assert.ok(!dead.html.includes('push-toggle'), `${device} cannot be toggled, so it must not draw a switch`);
    assert.equal(dead.fn, undefined, `${device} wired a click handler onto a switch it never drew`);
    assert.match(dead.html, new RegExp(`class="push-fix">push\\.fix\\.${device}<`),
      `${device} must say what the fix is, since the switch is not it`);
  }
});

test('the everything-off action is reachable from the followed-gauges pane', () => {
  const keep = APP.state.gauges;
  APP.state.gauges = [{ lid: 'SRRT2', name: 'San Marcos at Luling', latitude: 29.68, longitude: -97.65 }];
  try {
    renderCard('on', { prefs: { scope: 'statewide', gauges: [{ lid: 'SRRT2', tier: 'major' }] } }, (host) => {
      assert.ok(!host.innerHTML.includes('push-unsub-all'), 'the pane starts collapsed');
      assert.ok(host.taps.gauges, 'the card drew no followed-gauges row to open');
      host.taps.gauges();
      assert.match(host.innerHTML, /id="push-unsub-all"/, 'the manage view keeps its everything-off action');
      assert.match(host.innerHTML, /San Marcos at Luling/, 'a followed gauge must be listed by name');
    });
  } finally { APP.state.gauges = keep; }
});

test('only a real local subscription counts as subscribed, never a truthy stand-in', () => {
  const dead = facts({ hasPush: false, hasSW: false, hasNotif: false });
  assert.equal(pushCardVisible({ ...dead, subscribed: 'yes' }), false);
  assert.equal(pushCardVisible({ ...dead, subscribed: 1 }), false);
  assert.equal(pushCardVisible({}), false, 'an empty fact bag is not a capable browser');
});

/* Boots the card for real against a stubbed backend, so what a resident meets is the answer.
   `backend` is what api/push/status does: a body, an HTTP status, or a thrown transport error. */
async function bootCard(device, backend) {
  const d = PUSH_DEVICE[device];
  const keep = { qs: SB.document.querySelector, notif: SB.Notification, pm: SB.PushManager,
    secure: SB.isSecureContext, nav: SB.navigator, ua: SB.navigator.userAgent, fetch: SB.fetch,
    search: SB.location.search, sync: SB.pushBootSync };
  SB.isSecureContext = true;
  SB.navigator = { ...keep.nav, userAgent: d.ua || 'Mozilla/5.0',
    serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => null } }) } };
  SB.Notification = { permission: d.permission };
  if (d.hasPush) SB.PushManager = function PushManager() {}; else delete SB.PushManager;
  SB.location.search = backend.flagged ? '?push=1' : '';
  SB.localStorage.setItem('respondertx.push', JSON.stringify({ on: d.subscribed, prefs: {} }));
  SB.pushBootSync = () => {}; // its own re-subscribe path is covered by the registry suite
  SB.fetch = async () => {
    if (backend.threw) throw new Error('offline');
    return { ok: backend.status === 200, status: backend.status, json: async () => backend.body };
  };
  const host = pushHost();
  SB.document.querySelector = (s) => (s === '#push-body' ? host : null);
  try {
    await SB.initPushCard();
    return host.innerHTML;
  } finally {
    SB.document.querySelector = () => null;
    SB.pushOpenManageFor('');
    Object.assign(SB, { Notification: keep.notif, isSecureContext: keep.secure, navigator: keep.nav,
      fetch: keep.fetch, pushBootSync: keep.sync });
    SB.document.querySelector = keep.qs;
    SB.location.search = keep.search;
    if (keep.pm === undefined) delete SB.PushManager; else SB.PushManager = keep.pm;
    SB.localStorage.removeItem('respondertx.push');
  }
}

const LIVE_BACKEND = { status: 200, body: { configured: true, vapidKey: 'k', lastEval: 0 } };

test('initPushCard draws the card only for a device that can act, and only over a live backend', async () => {
  assert.match(await bootCard('off', LIVE_BACKEND), /push-card/,
    'a plain capable browser that never opted in must meet the card');
  assert.match(await bootCard('blocked', LIVE_BACKEND), /push-card/);

  // a device with no push at all is not offered a channel it cannot use
  assert.equal(await bootCard('unsupported', LIVE_BACKEND), '',
    'an unsupported browser must not be shown the card');
  // ...unless the link that carries ?push= says otherwise (the iOS install hint rides that path)
  assert.match(await bootCard('ios', { ...LIVE_BACKEND, flagged: true }), /push-card/,
    '?push= must still reach the install hint');
});

test('initPushCard commits to no state until the backend has answered', async () => {
  for (const device of ['off', 'on', 'blocked']) {
    assert.equal(await bootCard(device, { status: 503, body: null }), '',
      `${device}: an absent backend must hide the card, not advertise an unwired channel`);
    assert.equal(await bootCard(device, { status: 200, body: { configured: false, vapidKey: 'k' } }), '',
      `${device}: an unconfigured backend must hide the card, key or no key`);
    assert.equal(await bootCard(device, { status: 200, body: { configured: true } }), '',
      `${device}: no VAPID key means no channel, whatever the card would have said`);
    // E1: an unreachable backend is a different fact from an absent one and must say so
    assert.match(await bootCard(device, { status: 500, body: null }), /push-fix/,
      `${device}: a bad status must be reported, never rendered as "no device alerts here"`);
    assert.match(await bootCard(device, { threw: true }), /push-fix/,
      `${device}: a transport failure must be reported, never silently swallowed`);
  }
});

/* ---------- the permission prompt stays inside a tap ---------- */

test('Notification.requestPermission is reachable from exactly one place, and only from a click', () => {
  const hits = [...BOARD.matchAll(/Notification\.requestPermission/g)];
  assert.equal(hits.length, 1, 'the permission prompt must have exactly one call site');

  const enable = BOARD.match(/async function pushEnable\(\)[\s\S]*?\n\}/);
  assert.ok(enable, 'pushEnable() not found');
  assert.match(enable[0], /Notification\.requestPermission/, 'the one call site must be pushEnable()');

  // no other client file may prompt, including the boot path and the service worker
  for (const rel of ['js/boot.js', 'js/core.js', 'js/panels.js', 'js/sources.js', 'js/map.js', 'sw.js']) {
    assert.ok(!/Notification\.requestPermission/.test(read(rel)), `${rel} can prompt for notifications`);
  }

  // pushEnable is only ever installed as a click handler; nothing calls it directly
  const refs = [...BOARD.matchAll(/pushEnable/g)].map((m) => BOARD.slice(Math.max(0, m.index - 60), m.index + 20));
  for (const ctx of refs) {
    if (/async function pushEnable/.test(ctx)) continue;
    assert.match(ctx, /addEventListener\('click',/, `pushEnable reached outside a click handler: ${ctx.trim()}`);
  }
  assert.ok(!/(?<!function )pushEnable\s*\(/.test(BOARD), 'pushEnable is invoked directly somewhere; the prompt must ride a gesture');

  // Deliberately textual: this is a whole-body claim about paths NOT taken, and one render can
  // only ever show that one branch stayed quiet. Executing every branch is what the render tests
  // above do; this one has to read the body.
  const initFn = BOARD.match(/async function initPushCard\(\)[\s\S]*?\n\}/)[0];
  const renderFn = BOARD.match(/function renderPushCard\(\)[\s\S]*?\n\}/)[0];
  for (const [name, src] of [['initPushCard', initFn], ['renderPushCard', renderFn]]) {
    assert.ok(!/requestPermission|pushEnable\(/.test(src), `${name} must never request permission on its own`);
  }
  // the boot self-heal re-subscribes only where permission was already granted
  const sync = BOARD.match(/async function pushBootSync\(\)[\s\S]*?\n\}/)[0];
  assert.ok(!/requestPermission/.test(sync), 'pushBootSync must never prompt');
  // the plan a missing subscription produces without a granted permission is run in board.test.js
  // ("pushBootPlan: ... honest off on revocation"), which is what proves it never re-prompts
});

/* ---------- the promoted door ---------- */

/* Owner report: "the duplicative alert bell icon and gear settings icon top of page". The v0.99.37
   bell and the gear opened the identical sheet, and every phone/tablet breakpoint hides .ctl-lbl,
   so the header read as two unlabelled icons behind one panel. The bell is gone; what replaces its
   discoverability job is a dot on the gear, which is why these assertions guard the dot's gating
   rather than a second button. */
test('one header door to the notify sheet, with the call-to-action riding the gear', () => {
  const header = HTML.slice(HTML.indexOf('<div class="controls">'), HTML.indexOf('<div id="hmore-menu"'));
  assert.ok(!/id="alerts-btn"/.test(HTML), 'the duplicate bell is back in the header');
  assert.ok(!/alerts-btn/.test(BOOT + BOARD + CSS), 'the removed bell left wiring or styling behind');
  assert.match(header, /id="hmore-dot"[^>]*hidden/, 'the alerts dot must start hidden, not asserted on load');
  assert.ok(/id="hmore-btn"[\s\S]{0,400}?id="hmore-dot"/.test(header), 'the dot must live inside the gear');

  assert.match(BOARD, /function openNotifySheet\(section\) \{/, 'the one alert-setup opener is gone');
  assert.match(BOOT, /window\.setAlertsCta = setAlertsCta/, 'the dot has no setter for the push card to call');
  assert.ok(!/openSettingsMenu|openAlertsPanel/.test(BOOT + BOARD),
    'a second alert-setup opener is back; openNotifySheet is the only one');

  // the dot is a claim that this device can subscribe, so only the card that checked may raise it
  assert.equal((BOARD.match(/setAlertsCta\(/g) || []).length, 1, 'the dot is set from more than the card render');
  // swapping the key attributes alone would leave the live button stale: applyI18n() scopes to
  // descendants, so the gear itself is never re-read until a full-document pass
  const cta = BOOT.match(/const setAlertsCta = \(on\) => \{[\s\S]*?\n  \};/)[0];
  for (const attr of ['data-i18n-title', 'data-i18n-aria']) {
    assert.ok(cta.includes(attr), `the CTA swap must keep ${attr} in sync for the language toggle`);
  }
  assert.match(cta, /btn\.title = t\(titleKey\)/, 'the swapped title must be painted immediately');
  assert.match(cta, /btn\.setAttribute\('aria-label', t\(ariaKey\)\)/, 'the swapped aria-label must be painted immediately');

  // every door lands on the same sheet, so alert setup has one destination
  for (const wiring of [/\$\('#notify-btn'\)\.addEventListener\('click', \(\) => openNotifySheet\(\)\)/,
    /\$\('#alerts-notify-row'\)\.addEventListener\('click', \(\) => openNotifySheet\(\)\)/]) {
    assert.match(BOOT, wiring, 'an entry point lost its opener');
  }
});

/* The gauge-popup bell used to click its way to the Resources tab. It now opens the same sheet as
   every other door, and it has to arrive with the requested gauge already in reach: a picker that
   opens on eight nearby gauges and not the one that was tapped is a dead end with extra steps. */
test('the gauge-popup bell opens the sheet on the followed-gauges pane with that gauge pinned', () => {
  const keep = APP.state.gauges;
  APP.state.gauges = [
    { lid: 'GRDT2', name: 'Guadalupe at Gonzales', latitude: 29.50, longitude: -97.45 },
    { lid: 'SRRT2', name: 'San Marcos at Luling', latitude: 29.68, longitude: -97.65 },
  ];
  const notifySheet = { hidden: true };
  try {
    renderCard('on', { prefs: { scope: 'statewide' }, nodes: { '#notify-sheet': notifySheet } }, (host) => {
      assert.ok(!host.innerHTML.includes('data-lid='), 'the picker must start collapsed');
      host.asked.length = 0;
      SB.pushOpenManageFor('srrt2');
      assert.equal(notifySheet.hidden, false, 'the bell must open the notify sheet');
      assert.match(host.innerHTML, /data-sec="gauges" aria-expanded="true"/,
        'it must land on the followed-gauges pane, not on the pane the card was last left on');
      assert.match(host.innerHTML, /class="push-g-row push-nearby-row preselect" data-lid="SRRT2"/,
        'the requested gauge must be pinned, and marked as the one that was asked for');
      assert.ok(host.innerHTML.indexOf('data-lid="SRRT2"') < host.innerHTML.indexOf('data-lid="GRDT2"'),
        'the pinned gauge must lead the picker');
      assert.deepEqual(host.asked.filter((s) => /\btabs?\b|\.tabs/.test(s)), [],
        'the bell reached for a tab; alert setup has one destination');
    });
  } finally { APP.state.gauges = keep; }
});

test('rendering the card raises the gear dot only where this device could actually subscribe', () => {
  const keep = SB.setAlertsCta;
  const raised = [];
  SB.setAlertsCta = (on) => raised.push(on);
  try {
    for (const device of ['off', 'on', 'blocked', 'ios', 'unsupported']) {
      raised.length = 0;
      renderCard(device, { prefs: { scope: 'statewide' } });
      assert.equal(raised.length, 1, `${device} must publish the dot exactly once per render`);
      assert.equal(raised[0], device === 'off', `${device} sets the dot to ${raised[0]}`);
    }
  } finally { if (keep === undefined) delete SB.setAlertsCta; else SB.setAlertsCta = keep; }
});

/* The card was the largest thing in a 300px-wide, 418px-tall settings panel it shared with five
   other feature groups. It moved to its own .ls-panel, keeping the id #push-body so ~30 CSS rules
   and every $('#push-body') resolver still find it. What must not regress: the sheet owns EVERY way
   of being told, each host is declared exactly once, and it joins the modal machinery the rest of
   the .ls-panel family already has. */
test('the notify sheet owns every way of being told, and is a real sheet', () => {
  const html = HTML.replace(/<!--[\s\S]*?-->/g, '');
  const sheet = html.slice(html.indexOf('<div id="notify-sheet"'), html.indexOf('<div id="share-sheet"'));
  assert.ok(sheet.length > 500, '#notify-sheet was not found in index.html');
  assert.ok(sheet.includes('id="push-body"'), 'the device-alerts card left the notify sheet');
  assert.ok(sheet.includes('id="follow-body"'), 'the subscribe rows did not land in the notify sheet');
  assert.ok(sheet.includes('href="feed.xml"') && sheet.includes('href="crests.ics"'),
    'RSS and the crest calendar must be in the notify sheet');
  for (const id of ['push-body', 'follow-body']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `#${id} is not declared exactly once`);
  }
  // the settings panel keeps exactly one row to it, and that row must be a DIRECT child button:
  // js/boot.js dismisses the panel on `#hmore-menu > button` only, so a nested control would
  // leave the panel open on top of the sheet it just opened
  const menu = html.slice(html.indexOf('<div id="hmore-menu"'), html.indexOf('<div class="refresh-meta">'));
  assert.match(menu, /<div id="hmore-menu"[\s\S]*?\n\s*<button id="notify-btn"/,
    '#notify-btn must be a direct child button of #hmore-menu');
  assert.ok(menu.indexOf('id="notify-btn"') < menu.indexOf('data-i18n="set.g.display"'),
    'being told must sit above the display preferences');
  assert.ok(menu.indexOf('id="shelters-btn"') < menu.indexOf('id="notify-btn"'),
    'Public help keeps the lead row');

  // same sheet family as share/help, so it must inherit the same guarantees
  assert.match(sheet, /class="ls-panel" role="dialog" aria-modal="true" aria-labelledby="notify-sheet-title"/,
    'the notify panel must be a labelled modal dialog like every other .ls-panel');
  assert.ok(sheet.includes('class="ls-backdrop"') && sheet.includes('class="ls-grab"'),
    'the backdrop and the phone grab handle are what make it a bottom sheet');
  assert.match(BOOT, /registerModal\(\$\('#notify-sheet'\), \{ focusEl: '\.ls-panel' \}\)/,
    'the notify sheet must trap focus like the rest of the family');
  assert.match(BOOT, /if \(!\$\('#notify-sheet'\)\.hidden\) \{ closeNotifySheet\(\); return; \}/,
    'Escape must close the notify sheet');
  assert.ok(/rolloverBusy[\s\S]*?'#notify-sheet'/.test(BOOT),
    'an open notify sheet must postpone the update rollover, like every other overlay');

  const share = html.slice(html.indexOf('<div id="share-sheet"'), html.indexOf('<div id="notes-flyout"'));
  assert.ok(!/res\.follow|feed\.xml|crests\.ics/.test(share),
    'the export drawer still owns subscribe; the promotion was a move, not a copy');

  // the two feed links were 15px .resource-item rows; in the sheet they are real 48px targets
  const follow = sheet.slice(sheet.indexOf('id="follow-body"'));
  assert.equal((follow.match(/class="ls-row"/g) || []).length, 2,
    'both subscribe rows must be .ls-row (48px), not .resource-item (15px)');
  assert.match(CSS, /#notify-sheet #follow-body \.ls-row \{/, 'the sheet-side subscribe rows are unstyled');
  assert.ok(!/#share-sheet #follow-body/.test(CSS), 'dead CSS for a #follow-body the share sheet never had');
});

/* Discovery by context rather than by interruption: a reader of the Alerts tab is by definition the
   reader who wants to be told about the next one. It must sit ABOVE .filters so renderAlertList()
   repainting #alert-list can never move it, and it publishes the card's own state rather than a
   standing invitation. */
test('the Alerts tab carries a persistent row that cannot be repainted away', () => {
  const html = HTML.replace(/<!--[\s\S]*?-->/g, '');
  const tab = html.slice(html.indexOf('<div class="tab-body" id="tab-alerts">'), html.indexOf('id="tab-gauges"'));
  assert.ok(tab.includes('id="alerts-notify-row"'), 'the Alerts tab lost its notify row');
  assert.ok(tab.indexOf('id="alerts-notify-row"') < tab.indexOf('class="filters"'),
    'the row must sit above .filters, outside anything a render replaces');
  assert.ok(tab.indexOf('id="alerts-notify-row"') < tab.indexOf('id="alert-list"'),
    'the row must sit above the list its own renderer replaces wholesale');
  // hidden until the card proves a backend exists: a row into an empty sheet is a dead end
  assert.match(tab, /id="alerts-notify-row"[^>]*hidden/, 'the row must start hidden, not asserted on load');
});

/* The row ships hidden, so only a render can reveal it, and what it reveals has to be the state the
   card itself just committed to. `entry-quiet` is the one case the phone CSS hides: a device that is
   already delivering does not need a second entry point above its alert list. */
test('a render reveals the entry rows and publishes the card state onto them', () => {
  const entries = () => {
    const classes = new Set();
    return {
      '#notify-state': { textContent: '' },
      '#alerts-notify-sub': { textContent: '' },
      '#alerts-notify-row': { hidden: true, classes, classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } },
    };
  };

  for (const [device, prefs, key, quiet] of [
    ['on', { scope: 'statewide', ffe: true }, 'push.state.on', true],
    ['on', { scope: 'none' }, 'push.state.silent', false],
    ['off', {}, 'push.state.off', false],
    ['blocked', {}, 'push.state.blocked', false],
  ]) {
    const nodes = entries();
    renderCard(device, { prefs, nodes });
    const row = nodes['#alerts-notify-row'];
    assert.equal(row.hidden, false, `${device}/${key} left the Alerts-tab row hidden`);
    assert.equal(nodes['#alerts-notify-sub'].textContent, key, `${device} published the wrong state`);
    assert.equal(nodes['#notify-state'].textContent, ` · ${key}`, 'the gear row must carry the same claim');
    assert.equal(row.classes.has('entry-quiet'), quiet, `${device}/${key} got the wrong entry-quiet verdict`);
  }
});

/* v0.99.65: a subscription that can deliver nothing must never wear the green ON. The rework
   repeated that claim on two more surfaces (the gear row and the Alerts-tab row), and a surface
   that repeats a claim has to repeat the honesty branch with it. */
test('no entry point claims ON for a subscription that can deliver nothing', () => {
  assert.equal(pushEntryStateKey('on', true), 'push.state.on');
  assert.equal(pushEntryStateKey('on', false), 'push.state.silent', 'a silent subscription must not read as on');
  assert.equal(pushEntryStateKey('off', false), 'push.state.off');
  assert.equal(pushEntryStateKey('blocked', false), 'push.state.blocked');
  assert.equal(pushEntryStateKey('unreachable', false), 'push.state.unreachable');
});

/* v0.99.71: the entry rows took the card's 140-char unreachable paragraph, which wrapped the
   Alerts-tab row to four lines on a phone. The short form replaces it and must stay as honest:
   an unreachable check is neither an OFF nor an ON claim. */
test('the short unreachable state reads as unchecked, not as off, in both languages', () => {
  for (const lang of ['en', 'es']) {
    const short = I18N[lang]['push.state.unreachable'];
    assert.ok(short, `${lang} is missing push.state.unreachable`);
    assert.ok(short.length < 60, `${lang} push.state.unreachable is a paragraph again: ${short.length} chars`);
    assert.ok(!/—/.test(short), `${lang} push.state.unreachable uses an em-dash`);
    const off = I18N[lang]['push.state.off'], on = I18N[lang]['push.state.on'];
    assert.notEqual(short, off, `${lang} an unchecked backend must not read as off`);
    assert.notEqual(short, on, `${lang} an unchecked backend must not read as on`);
    // the long explanation stays on the card inside the sheet, where there is room for it
    assert.ok(I18N[lang]['push.unreachable'].length > short.length, `${lang} lost the card's full notice`);
  }
});

/* The row sits above the alert list that is the reason the tab is open, so on a phone it holds one
   line at the touch floor and cannot grow, and it steps aside for a device already delivering. */
test('the Alerts-tab notify row is one fixed 44px line on a phone', () => {
  const mobile = CSS.slice(CSS.indexOf('/* ---- the Alerts-tab Notify me entry row ---- */'),
    CSS.indexOf('/* ---- the Notify me sheet ---- */'));
  assert.match(mobile, /@media \(max-width: 768px\)/, 'the compaction must be phone-scoped');
  assert.match(mobile, /#alerts-notify-row\s*\{[^}]*min-height: 44px/,
    'the row must keep the touch floor: this is a width change, not a smaller target');
  assert.match(mobile, /#alerts-notify-row\.entry-quiet \{ display: none; \}/);
  assert.match(mobile, /#alerts-notify-row \.ls-txt \{[^}]*flex-direction: row/,
    'the name and state must share one line');
  assert.match(mobile, /#alerts-notify-row \.ls-sub \{[^}]*white-space: nowrap[\s\S]*?text-overflow: ellipsis/,
    'the state must ellipsise rather than wrap the row taller');
});

/* ---------- the promise stays honest ---------- */

test('the card still carries the best-effort framing, unweakened, on every render', () => {
  // every state a resident can arrive in, including the ones a first-time visitor lands on
  for (const device of ['off', 'on', 'blocked', 'ios', 'unsupported']) {
    for (const prefs of [{}, { scope: 'statewide', ffe: true }]) {
      const drawn = renderCard(device, { prefs }).innerHTML;
      assert.match(drawn, /<div class="push-note">push\.note<\/div>/,
        `${device} dropped the compact honesty line`);
      assert.match(drawn, /<div class="push-sub">push\.sub<\/div>/, `${device} dropped the what-you-get paragraph`);
      assert.match(drawn, /<div class="push-disclaimer">push\.disclaimer<\/div>/,
        `${device} dropped the full disclaimer paragraph`);
    }
  }

  for (const lang of ['en', 'es']) {
    const note = I18N[lang]['push.note'];
    const disc = I18N[lang]['push.disclaimer'];
    assert.ok(note && disc, `${lang} is missing the honesty strings`);
    assert.match(note, /911/, `${lang} push.note dropped the 911 carve-out`);
    assert.match(disc, /911/, `${lang} push.disclaimer dropped the 911 carve-out`);
    assert.match(lang === 'en' ? note : note, lang === 'en' ? /Wireless Emergency Alert/ : /WEA|Inal[áa]mbrica/,
      `${lang} push.note dropped the Wireless Emergency Alert carve-out`);
    assert.ok(/best effort|Best effort|mejor esfuerzo/.test(note), `${lang} push.note dropped the best-effort claim`);
  }
});

test('i18n: the promoted alerts surface is complete in both languages and dash-free', () => {
  const keys = ['ctl.settings.cta.title', 'ctl.settings.cta.aria', 'push.notify', 'push.notify.title',
    'res.follow.sub', 'res.rss', 'res.rss.note', 'res.ics', 'res.ics.note',
    'push.title', 'push.note', 'push.disclaimer', 'push.sub', 'push.about', 'push.g.other',
    'push.pitch', 'push.pitch.next', 'push.off.kept', 'push.sec.what', 'push.sum.unset',
    'push.sum.nothing', 'push.sum.none', 'push.sum.ffe', 'push.sum.gauges', 'push.sum.followed',
    'push.fix.ios.steps', 'push.manage.more', 'moved.notify'];
  for (const k of keys) {
    for (const lang of ['en', 'es']) {
      assert.ok(typeof I18N[lang][k] === 'string' && I18N[lang][k].length, `${lang} missing ${k}`);
      assert.ok(!I18N[lang][k].includes('—'), `em-dash in ${lang} ${k}`);
    }
    assert.notEqual(I18N.en[k], I18N.es[k], `${k} was never actually translated`);
    for (const ph of I18N.en[k].match(/\{[a-z]+\}/g) || []) {
      assert.ok(I18N.es[k].includes(ph), `es ${k} lost placeholder ${ph}`);
    }
  }
  /* Retired with the rework. set.g.alerts and tab.alerts were the byte-identical string "Alerts"
     on two surfaces; the tab keeps the noun (it names NWS products and is deep-linked via
     ?tab=alerts), the settings surface became the verb phrase "Notify me". The manage
     show/hide pair died with the button the accordion replaced. */
  for (const dead of ['set.g.alerts', 'push.manage.show', 'push.manage.hide', 'res.follow']) {
    for (const lang of ['en', 'es']) {
      assert.equal(I18N[lang][dead], undefined, `${lang} still carries retired key ${dead}`);
    }
    assert.ok(!HTML.includes(`data-i18n="${dead}"`), `index.html still references retired key ${dead}`);
    assert.ok(!(BOARD + BOOT).includes(`'${dead}'`), `a script still resolves retired key ${dead}`);
  }
  // the subscribe blurb described itself as an export while it lived in the export drawer
  assert.ok(!/export|exportaci/i.test(I18N.en['res.follow.sub'] + I18N.es['res.follow.sub']),
    'res.follow.sub still describes itself from its old home');
  // and the migration cue must not send anyone to Share for a feed that is no longer there
  for (const lang of ['en', 'es']) {
    assert.ok(!/RSS[\s\S]*Share|RSS[\s\S]*Compartir/.test(I18N[lang]['moved.exports']),
      `${lang} moved.exports still points RSS at the Share sheet`);
  }
});
