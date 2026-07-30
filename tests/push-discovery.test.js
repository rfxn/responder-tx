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

const { pushCardVisible, pushCardState, pushEntryStateKey } = loadApp();

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
  assert.match(BOARD, /if \(window\.setAlertsCta\) setAlertsCta\(st === 'off'\)/,
    "the dot must track the push card's own state, and only its 'off' state");
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
  const manage = BOARD.match(/function pushOpenManageFor\(lid\)[\s\S]*?\n\}/);
  assert.ok(manage, 'pushOpenManageFor() not found');
  assert.match(manage[0], /openNotifySheet\('gauges'\)/, 'the Notify me bell must open the notify sheet');
  for (const wiring of [/\$\('#notify-btn'\)\.addEventListener\('click', \(\) => openNotifySheet\(\)\)/,
    /\$\('#alerts-notify-row'\)\.addEventListener\('click', \(\) => openNotifySheet\(\)\)/]) {
    assert.match(BOOT, wiring, 'an entry point lost its opener');
  }
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
  assert.match(BOARD, /function pushSyncEntries\(cardState, deliversAny\)/, 'the entry-row updater is gone');
  assert.match(BOARD, /pushSyncEntries\(st, delivers\.any\)/,
    'renderPushCard must publish its own state to the entry rows');
});

/* v0.99.65: a subscription that can deliver nothing must never wear the green ON. The rework
   repeated that claim on two more surfaces (the gear row and the Alerts-tab row), and a surface
   that repeats a claim has to repeat the honesty branch with it. */
test('no entry point claims ON for a subscription that can deliver nothing', () => {
  const fn = BOARD.match(/function pushEntryStateKey\(cardState, deliversAny\)[\s\S]*?\n\}/);
  assert.ok(fn, 'pushEntryStateKey() not found');
  assert.match(fn[0], /cardState === 'on' && !deliversAny \? 'push\.state\.silent'/,
    'the entry rows must take the silent claim, exactly as the card does');
  assert.match(fn[0], /cardState === 'unreachable'/,
    'an unreachable backend must not leave the entry rows reading as OFF');
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
  assert.match(BOARD, /row\.classList\.toggle\('entry-quiet', cardState === 'on' && deliversAny\)/,
    'the row must publish the already-delivering case the CSS hides on a phone');
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
