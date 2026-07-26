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

const { pushCardVisible, pushCardState } = loadApp();

// the same environment facts pushEnvFacts() reports, for a capable browser that never opted in
const facts = (over = {}) => ({
  ios: false, standalone: false, secure: true, hasSW: true, hasPush: true, hasNotif: true,
  permission: 'default', subscribed: false, flagged: false, ...over,
});

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
  // and the toggle really is rendered for the two toggleable states
  const render = BOARD.match(/function renderPushCard\(\)[\s\S]*?\n\}/)[0];
  assert.match(render, /const toggleable = st === 'on' \|\| st === 'off';/);
  assert.match(render, /toggleable \? `<button type="button" class="act-btn push-toggle"/);
  assert.match(render, /push\.toggle\.off/, 'the off label must still be reachable from the card');
  const manageHtml = BOARD.match(/function pushManageHtml\(prefs\)[\s\S]*?\n\}/)[0];
  assert.match(manageHtml, /id="push-unsub-all"/, 'the manage view keeps its everything-off action');
});

test('only a real local subscription counts as subscribed, never a truthy stand-in', () => {
  const dead = facts({ hasPush: false, hasSW: false, hasNotif: false });
  assert.equal(pushCardVisible({ ...dead, subscribed: 'yes' }), false);
  assert.equal(pushCardVisible({ ...dead, subscribed: 1 }), false);
  assert.equal(pushCardVisible({}), false, 'an empty fact bag is not a capable browser');
});

test('initPushCard consults the predicate over real environment facts, and needs a live backend', () => {
  const fn = BOARD.match(/async function initPushCard\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'initPushCard not found in js/board.js');
  assert.match(fn[0], /const facts = pushEnvFacts\(\);/, 'the predicate must see capability, not just two flags');
  assert.match(fn[0], /facts\.subscribed = pushLocal\(\)\.on === true;/, 'the subscription fact comes from the local record');
  assert.match(fn[0], /facts\.flagged = new URLSearchParams\(location\.search\)\.has\('push'\);/, '?push handling was dropped');
  assert.match(fn[0], /if \(!pushCardVisible\(facts\)\) return;/);
  // the status probe now guards every state: an install hint or a blocked notice must not
  // advertise a channel that has no worker behind it
  const gate = fn[0].indexOf("fetch('api/push/status')");
  const stateRead = fn[0].indexOf('const st = pushCardState(facts)');
  assert.ok(gate !== -1 && stateRead !== -1 && gate < stateRead,
    'the backend check must run before the card commits to a state, for every state');
  assert.match(fn[0], /if \(!d \|\| !d\.configured \|\| !d\.vapidKey\) return;/);
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

  // making the card visible must not enable anything by itself
  const initFn = BOARD.match(/async function initPushCard\(\)[\s\S]*?\n\}/)[0];
  const renderFn = BOARD.match(/function renderPushCard\(\)[\s\S]*?\n\}/)[0];
  for (const [name, src] of [['initPushCard', initFn], ['renderPushCard', renderFn]]) {
    assert.ok(!/requestPermission|pushEnable\(/.test(src), `${name} must never request permission on its own`);
  }
  // the boot self-heal re-subscribes only where permission was already granted
  const sync = BOARD.match(/async function pushBootSync\(\)[\s\S]*?\n\}/)[0];
  assert.ok(!/requestPermission/.test(sync), 'pushBootSync must never prompt');
  const plan = BOARD.match(/function pushBootPlan\(f\)[\s\S]*?\n\}/)[0];
  assert.match(plan, /return f\.permission === 'granted' \? 'resubscribe' : 'off';/,
    'a missing subscription without a granted permission must go off, never re-prompt');
});

/* ---------- the promoted door ---------- */

test('the header carries a one-tap alerts control that opens the Alerts group', () => {
  const header = HTML.slice(HTML.indexOf('<div class="controls">'), HTML.indexOf('<div id="hmore-menu"'));
  assert.ok(header.includes('id="alerts-btn"'), 'the header lost the alerts control');
  assert.match(header, /id="alerts-btn"[^>]*data-i18n-title="ctl\.notify\.title"/, 'the control needs a localized title');
  assert.match(header, /id="alerts-btn"[^>]*data-i18n-aria="ctl\.notify\.aria"/, 'the control needs a localized aria-label');
  assert.ok(/id="alerts-btn"[\s\S]{0,200}?data-i18n="push\.notify"/.test(header),
    'the control should reuse the gauge-popup bell vocabulary');

  assert.match(BOOT, /const openAlertsPanel = \(\) => \{/, 'the alerts opener is gone');
  assert.match(BOOT, /\$\('#alerts-btn'\)\.addEventListener\('click'/, 'the alerts control is not wired');
  // the bell sits outside #hmore, so the dismiss-on-outside-click must spare it or the menu
  // closes in the same tap that opened it
  assert.match(BOOT, /e\.target\.closest\('#hmore, #alerts-btn'\)/,
    'the outside-click dismissal must exempt the alerts control');
  assert.ok(!/openSettingsMenu/.test(BOOT + BOARD), 'openSettingsMenu was superseded by openAlertsPanel');

  // the gauge-popup bell lands on the same surface, so there is one alerts destination
  const manage = BOARD.match(/function pushOpenManageFor\(lid\)[\s\S]*?\n\}/);
  assert.ok(manage, 'pushOpenManageFor() not found');
  assert.match(manage[0], /openAlertsPanel\(\)/, 'the Notify me bell must open the alerts surface');
});

test('the Alerts group leads the settings sheet and owns every way of being told', () => {
  const html = HTML.replace(/<!--[\s\S]*?-->/g, '');
  const menu = html.slice(html.indexOf('<div id="hmore-menu"'), html.indexOf('<div class="refresh-meta">'));
  assert.ok(menu.includes('id="set-alerts"'), 'the Alerts group wrapper is missing');
  assert.ok(!/id="set-alerts" role="group" hidden/.test(menu),
    'the group holds RSS and the calendar now, so it can no longer start hidden');
  assert.ok(menu.indexOf('id="set-alerts"') < menu.indexOf('data-i18n="set.g.display"'),
    'Alerts must sit above the display preferences');
  assert.ok(menu.indexOf('id="shelters-btn"') < menu.indexOf('id="set-alerts"'),
    'Public help keeps the lead row');

  // the subscribe rows moved here from the export drawer, and moved rather than duplicated
  const group = menu.slice(menu.indexOf('id="set-alerts"'), menu.indexOf('data-i18n="set.g.display"'));
  assert.ok(group.includes('id="push-body"'), 'the device-alerts card left the Alerts group');
  assert.ok(group.includes('id="follow-body"'), 'the subscribe rows did not land in the Alerts group');
  assert.ok(group.includes('href="feed.xml"') && group.includes('href="crests.ics"'),
    'RSS and the crest calendar must be in the Alerts group');
  for (const id of ['push-body', 'follow-body']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `#${id} is not declared exactly once`);
  }
  const share = html.slice(html.indexOf('<div id="share-sheet"'), html.indexOf('<div id="notes-flyout"'));
  assert.ok(!/res\.follow|feed\.xml|crests\.ics/.test(share),
    'the export drawer still owns subscribe; the promotion was a move, not a copy');

  // the card's own heading is no longer redundant now that the group holds two sub-sections
  assert.ok(!/#hmore-menu #push-body \.section-title \{ display: none/.test(CSS),
    'the device-alerts sub-heading must be visible beside Follow / subscribe');
  assert.match(CSS, /#hmore-menu #follow-body \.resource-item \{/, 'the menu-side subscribe rows are unstyled');
});

/* ---------- the promise stays honest ---------- */

test('the card still carries the best-effort framing, unweakened, on every render', () => {
  const render = BOARD.match(/function renderPushCard\(\)[\s\S]*?\n\}/)[0];
  // unconditional: not inside an `on ?` or `st === ... ?` branch that a first-time visitor misses
  assert.match(render, /`<div class="push-note">\$\{esc\(t\('push\.note'\)\)\}<\/div>` \+/);
  assert.match(render, /push\.disclaimer/, 'the full disclaimer paragraph left the card');
  assert.match(render, /push\.sub/, 'the what-you-get paragraph left the card');

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
  const keys = ['ctl.notify.title', 'ctl.notify.aria', 'push.notify',
    'set.g.alerts', 'res.follow', 'res.follow.sub', 'res.rss', 'res.rss.note', 'res.ics', 'res.ics.note',
    'push.title', 'push.note', 'push.disclaimer', 'push.sub', 'push.about'];
  for (const k of keys) {
    for (const lang of ['en', 'es']) {
      assert.ok(typeof I18N[lang][k] === 'string' && I18N[lang][k].length, `${lang} missing ${k}`);
      assert.ok(!I18N[lang][k].includes('—'), `em-dash in ${lang} ${k}`);
    }
    assert.notEqual(I18N.en[k], I18N.es[k], `${k} was never actually translated`);
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
