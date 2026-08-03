'use strict';

/* The 911 safety gate and the modal focus trap (js/core.js), run rather than grepped: registerModal
   and the observer it installs drive trap/inert/focus for every overlay, and the gate is the one
   surface the board must never lose. What stays a source scan here is the boot.js half, which lives
   inside `async function boot()` and cannot be reached without booting the whole app, plus the
   index.html/css contracts, which the node suite has no way to execute. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, loadHeaderStatus } = require('./harness.js');

const APP = loadApp();
const SBX = APP._sandbox;
const { modalCycleIndex, modalIsFocusableVisible } = APP;

/* Which surfaces are modal is a correctness question, not a style one: registerModal() marks the
   rest of the page inert. Drive Mode is eyes-off-road and SHOULD cover and trap. The three docked
   lenses must not, because Basin fits the corridor and rings its gauges, so making the map inert
   is making the thing the lens exists to show unusable (v0.97.94). */
const ROOT = path.join(__dirname, '..');
const BOOT = fs.readFileSync(path.join(ROOT, 'js', 'boot.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* A node that records what was written to it. `writes` counts textContent/innerHTML assignments,
   which is what the per-tick guards in updateDriveFreshness()/renderDataAgeBar() exist to keep at
   one, and no assertion below can see that without counting. */
function el(id, extra) {
  const attrs = new Map();
  let text = '';
  let html = '';
  const node = {
    id, tagName: 'DIV', hidden: true, dataset: {}, style: {}, className: '',
    offsetWidth: 100, offsetHeight: 20, getClientRects: () => [{}],
    writes: 0, focused: 0, kids: {},
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    removeAttribute(k) { attrs.delete(k); },
    hasAttribute(k) { return attrs.has(k); },
    attrs,
    querySelector(sel) { return node.kids[sel] || null; },
    querySelectorAll() { return Object.values(node.kids); },
    contains(n) { return n === node || Object.values(node.kids).includes(n); },
    focus() { node.focused++; },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    closest() { return null; }, scrollIntoView() {},
  };
  Object.defineProperty(node, 'textContent', {
    get() { return text; }, set(v) { text = String(v); node.writes++; }, enumerable: true });
  Object.defineProperty(node, 'innerHTML', {
    get() { return html; }, set(v) { html = String(v); node.writes++; }, enumerable: true });
  Object.assign(node, extra || {});
  return node;
}

/* Only the selectors a test deliberately registers answer; everything else is null, so a node the
   shipped code starts needing fails loudly instead of silently receiving a live stub (v0.99.83). */
function withDom(nodes, fn) {
  const saved = SBX.document.querySelector;
  SBX.document.querySelector = (sel) => (Object.prototype.hasOwnProperty.call(nodes, sel) ? nodes[sel] : null);
  try { return fn(); } finally { SBX.document.querySelector = saved; }
}

test('Drive Mode is registered as a modal; the docked lenses are not', () => {
  assert.ok(/registerModal\(\$\('#drive-mode'\)\)/.test(BOOT), '#drive-mode must stay a registered modal');
  for (const id of ['#summary-view', '#recovery-view', '#basin-view']) {
    assert.ok(!new RegExp(`registerModal\\(\\$\\('${id}'\\)\\)`).test(BOOT),
      `${id} is registered as a modal; that marks the map inert and the lens exists to show the map`);
  }
});

test('the docked lenses drop the modal ARIA that no longer describes them', () => {
  for (const id of ['summary-view', 'recovery-view', 'basin-view']) {
    const m = HTML.match(new RegExp(`<div id="${id}"[^>]*>`));
    assert.ok(m, `#${id} not found in index.html`);
    assert.ok(m[0].includes('class="lens-pane"'), `#${id} is not a .lens-pane`);
    assert.ok(!m[0].includes('aria-modal="true"'), `#${id} still claims aria-modal while not being modal`);
    assert.ok(/aria-labelledby="/.test(m[0]), `#${id} lost its accessible name`);
  }
  const drive = HTML.match(/<div id="drive-mode"[^>]*>/);
  assert.ok(drive && drive[0].includes('aria-modal="true"'), '#drive-mode must stay aria-modal');
});

test('the docked lenses live inside <main> and stay in the Escape chain', () => {
  const main = HTML.slice(HTML.indexOf('<main>'), HTML.indexOf('</main>'));
  for (const id of ['summary-view', 'recovery-view', 'basin-view']) {
    assert.ok(main.includes(`id="${id}"`), `#${id} must be inside <main> for the docked geometry to anchor`);
  }
  assert.ok(!main.includes('id="drive-mode"'), '#drive-mode is full-screen fixed; it does not belong in <main>');
  // anchored on a member rather than the first entry: new modals join the head of this list
  const esc = BOOT.match(/for \(const id of \[[^\]]*'#drive-mode'[^\]]*\]/);
  assert.ok(esc, 'the Escape-dismiss loop array was not found');
  for (const id of ['#summary-view', '#recovery-view', '#basin-view', '#health-modal']) {
    assert.ok(esc[0].includes(id), `${id} left the Escape chain`);
  }
});

test('Leaflet is told to re-measure when a lens pane opens or closes', () => {
  assert.ok(/attributeFilter: \['hidden'\][\s\S]{0,80}?/.test(BOOT) && /invalidateSize/.test(BOOT),
    'a lens pane appearing or leaving must trigger map.invalidateSize() or Leaflet greys out');
  const block = BOOT.match(/for \(const id of \['#summary-view', '#recovery-view', '#basin-view'\][\s\S]*?\n  \}/);
  assert.ok(block, 'the lens-pane observer block was not found');
  assert.ok(/invalidateSize\(\)/.test(block[0]), 'the lens-pane observer must call invalidateSize()');
});

/* openRecoveryView() adds the reopened-roads and shelter layers behind the lens. Under playback that
   would paint live markers over a historical frame, so the add is guarded (v0.97.87). Both branches
   are run here; the guard is checked before the first await, so the sync effect is the whole answer. */
function openRecovery(pb) {
  const added = [];
  const map = { hasLayer: (l) => added.includes(l), addLayer(l) { added.push(l); } };
  const layer = (k) => ({ __k: k, addTo(m) { m.addLayer(this); return this; } });
  const { state } = APP;
  const saved = { map: state.map, layers: state.layers, pb: state.pb };
  state.map = map;
  state.layers = { roadReopen: layer('roadReopen'), shelters: layer('shelters') };
  state.pb = pb;
  try {
    withDom({ '#recovery-view': el('recovery-view'), '#recovery-body': el('recovery-body') },
      () => { SBX.openRecoveryView().catch(() => {}); }); // the awaited crest fetch is offline here
  } finally { Object.assign(state, saved); }
  return added.map((l) => l.__k);
}

test('the Recovery lens adds its live layers, and the v0.97.87 playback guard stops it under a frame', () => {
  assert.deepEqual(openRecovery(null).sort(), ['roadReopen', 'shelters']);
  assert.deepEqual(openRecovery({ live: true }).sort(), ['roadReopen', 'shelters'],
    'playback parked on live is not a historical frame; the layers still belong');
  assert.deepEqual(openRecovery({ live: false }), [],
    'openRecoveryView lost its playback guard; it would re-add live markers under a historical frame');
});

test('modalCycleIndex — empty focus set yields -1 (nothing to focus)', () => {
  assert.equal(modalCycleIndex(0, -1, false), -1);
  assert.equal(modalCycleIndex(0, 0, true), -1);
});

test('modalCycleIndex — single focusable pins to 0 for both directions', () => {
  assert.equal(modalCycleIndex(1, 0, false), 0);
  assert.equal(modalCycleIndex(1, 0, true), 0);
  assert.equal(modalCycleIndex(1, -1, false), 0);
});

test('modalCycleIndex — Tab advances and wraps at the last focusable', () => {
  assert.equal(modalCycleIndex(3, 0, false), 1);
  assert.equal(modalCycleIndex(3, 1, false), 2);
  assert.equal(modalCycleIndex(3, 2, false), 0); // wrap forward
});

test('modalCycleIndex — Shift-Tab retreats and wraps at the first focusable', () => {
  assert.equal(modalCycleIndex(3, 2, true), 1);
  assert.equal(modalCycleIndex(3, 1, true), 0);
  assert.equal(modalCycleIndex(3, 0, true), 2); // wrap backward
});

test('modalCycleIndex — focus outside the trap (current -1) enters at the first focusable', () => {
  assert.equal(modalCycleIndex(4, -1, false), 0);
  assert.equal(modalCycleIndex(4, -1, true), 0);
});

test('modalIsFocusableVisible — nullish is not focusable', () => {
  assert.equal(modalIsFocusableVisible(null), false);
  assert.equal(modalIsFocusableVisible(undefined), false);
});

test('modalIsFocusableVisible — a zero-box node with no client rects is hidden', () => {
  const hidden = { offsetWidth: 0, offsetHeight: 0, getClientRects: () => [] };
  assert.equal(modalIsFocusableVisible(hidden), false);
});

test('modalIsFocusableVisible — a laid-out node (nonzero box) is visible', () => {
  const shown = { offsetWidth: 120, offsetHeight: 32, getClientRects: () => [{}] };
  assert.equal(modalIsFocusableVisible(shown), true);
});

test('modalIsFocusableVisible — client rects alone (zero offsets) still count as visible', () => {
  const inline = { offsetWidth: 0, offsetHeight: 0, getClientRects: () => [{ width: 10, height: 4 }] };
  assert.equal(modalIsFocusableVisible(inline), true);
});

/* ---- v0.99.41: live regions, menu semantics, and the close button ---- */

const CSS = fs.readFileSync(path.join(ROOT, 'css', 'app.css'), 'utf8');
const PANELS = fs.readFileSync(path.join(ROOT, 'js', 'panels.js'), 'utf8');
const BOARD = fs.readFileSync(path.join(ROOT, 'js', 'board.js'), 'utf8');

const tagFor = (id) => {
  const m = HTML.match(new RegExp(`<[a-z]+ id="${id}"[^>]*>`));
  assert.ok(m, `#${id} not found in index.html`);
  return m[0];
};

/* The wrong things were live regions. #drive-fresh is rewritten by a 1000ms interval, so a screen
   reader in Drive Mode was interrupted once per second for as long as it stayed open, while the
   two elements that genuinely announce a change to the board said nothing at all. */
function driveFreshness(ticks, opts) {
  const fresh = el('drive-fresh');
  const drive = el('drive-mode', { hidden: !!opts.driveHidden });
  const { state } = APP;
  const saved = { locWatch: state.locWatch, driveFixAt: state.driveFixAt };
  state.locWatch = !!opts.locWatch;
  state.driveFixAt = null; // the "locating" line carries no seconds, so the string cannot drift mid-test
  try {
    withDom({ '#drive-fresh': fresh, '#drive-mode': drive },
      () => { for (let i = 0; i < ticks; i++) SBX.updateDriveFreshness(); });
  } finally { Object.assign(state, saved); }
  return fresh;
}

test('the per-second freshness line does not announce, and only writes on a change', () => {
  assert.ok(!/aria-live/.test(tagFor('drive-fresh')),
    '#drive-fresh is rewritten every second; an aria-live region there talks over everything else');
  const live = driveFreshness(5, { locWatch: true });
  assert.equal(live.hidden, false);
  assert.match(live.textContent, /drive\.autoupd/, 'the line never rendered');
  assert.equal(live.writes, 1,
    'five ticks made five DOM writes; an unchanged string must never touch the DOM');
  assert.equal(driveFreshness(3, { locWatch: false }).hidden, true, 'no location watch: the line has nothing to say');
  assert.equal(driveFreshness(3, { locWatch: true, driveHidden: true }).hidden, true, 'Drive Mode is closed');
});

test('the emergency banner and the data-age bar announce themselves', () => {
  assert.match(tagFor('emergency-banner'), /role="alert"/,
    'the flash flood emergency banner is the loudest thing the board says and had no role at all');
  assert.match(tagFor('data-age-bar'), /role="status"/,
    'the data-age bar is a currency warning and was silent to assistive tech');
});

/* role="status" on #data-age-bar is only safe because the render is signature-guarded: the bar is
   re-rendered on a 1s tick, and an unguarded rewrite re-announces the whole warning every second. */
test('the data-age bar repaints on a real change and stays silent on the 1s tick', () => {
  const hdr = loadHeaderStatus();
  const bar = hdr.node('#data-age-bar');
  let writes = 0;
  let html = '';
  Object.defineProperty(bar, 'innerHTML', { get() { return html; }, set(v) { html = String(v); writes++; } });
  const st = hdr.state;
  Object.assign(st, { alertsLoadedOnce: true, gauges: [], snapshotAt: null, bootAt: Date.now() - 60000 });
  const ageMin = (n) => { st.sourceHealth = { gauges: Date.now() - n * 60000, alerts: Date.now() }; };

  ageMin(20);
  for (let i = 0; i < 5; i++) hdr.sandbox.renderDataAgeBar();
  assert.equal(bar.hidden, false, 'a 20-minute-old gauge feed must raise the bar');
  assert.equal(bar.className, 'red');
  assert.match(html, /age-bar-x/, 'the dismiss control never rendered');
  assert.equal(writes, 1, 'the 1s tick re-announced the whole warning; the signature guard is gone');

  ageMin(10); // still stale, but amber rather than red: a real change, so it must repaint
  hdr.sandbox.renderDataAgeBar();
  assert.equal(bar.className, 'amber');
  assert.equal(writes, 2, 'a severity change must reach the DOM');

  ageMin(0);
  hdr.sandbox.renderDataAgeBar();
  assert.equal(bar.hidden, true, 'a fresh feed must not leave a currency warning on screen');
});

test('the four toasts keep the status role they already had', () => {
  for (const id of ['update-toast', 'intake-toast', 'op-toast', 'sw-toast']) {
    assert.match(tagFor(id), /role="status"/, `#${id} lost its status role`);
  }
});

/* role="menu" is a promise of roving tabindex and arrow-key navigation. #hmore-menu implemented
   neither, and its children include group headings, the device-alerts card and RSS links, none of
   which can be a menuitem. Claiming the role was worse for assistive tech than not claiming it. */
test('the settings panel is a disclosure group, not a menu it cannot implement', () => {
  const tag = tagFor('hmore-menu');
  assert.ok(!/role="menu"/.test(tag), '#hmore-menu still claims role="menu" with no keyboard semantics');
  assert.match(tag, /role="group"/, '#hmore-menu needs a container role that matches what it is');
  assert.match(tag, /aria-labelledby="hmore-btn"/, 'the panel needs an accessible name');
  assert.ok(!/role="menuitem"/.test(HTML), 'a role="menuitem" survives outside a menu');
  const btn = tagFor('hmore-btn');
  assert.ok(!/aria-haspopup/.test(btn), 'aria-haspopup on the trigger re-asserts the menu that was removed');
  assert.match(btn, /aria-expanded="false"/, 'the disclosure state must still be published');
  assert.match(btn, /aria-controls="hmore-menu"/, 'the trigger must point at the panel it opens');
  // the JS half of the contract: the expanded state is kept in sync on every open and close
  assert.match(BOOT, /setAttribute\('aria-expanded', open \? 'true' : 'false'\)/,
    'aria-expanded must track the panel, or the published state lies');
});

/* Tapping a card on a phone panned a map that was not on screen. Nothing on the page scrolls:
   html/body are height:100%, main is flex:1/min-height:0, and the only scroll containers are
   .tab-body and the map. scrollIntoView('#map') was therefore a no-op, and at sheet-full the map
   is squeezed to its 60px min-height, so the pan landed inside a strip with no feedback. */
function revealMap({ width, full }) {
  const asked = [];
  const savedWidth = SBX.innerWidth;
  const savedSetSheet = SBX.setSheet;
  SBX.innerWidth = width;
  SBX.setSheet = (s) => asked.push(s);
  try {
    withDom(full ? { 'main.sheet-full': el('main') } : {}, () => SBX.revealMapOnPhone());
  } finally { SBX.innerWidth = savedWidth; SBX.setSheet = savedSetSheet; }
  return asked;
}

test('a card tap drops the sheet instead of scrolling a page that does not scroll', () => {
  for (const f of ['board.js', 'panels.js', 'boot.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
    assert.ok(!/\$\('#map'\)\.scrollIntoView/.test(src),
      `${f} still scrolls #map into view; the page has no scroll container for it to move`);
  }
  assert.deepEqual(revealMap({ width: 420, full: true }), ['sheet-half'],
    'a phone at sheet-full must drop to half; nothing else puts the map back on screen');
  assert.deepEqual(revealMap({ width: 420, full: false }), [],
    'peek and half already show the map; changing the sheet under the user would be gratuitous');
  assert.deepEqual(revealMap({ width: 1200, full: true }), [],
    'the desktop map is always on screen; the reveal is a phone-layout concern only');
});

/* The ✕ on every modal and every bottom sheet was roughly a 22px target: `.modal-head button` and
   `.ls-head button` are (0,1,1) and outrank the phone `button, select { min-height: 42px }` rule,
   and no media query ever raised them again. */
test('every modal and sheet close button is a real target at a touch width', () => {
  for (const cls of ['modal-head', 'ls-head']) {
    const base = CSS.indexOf(`.${cls} button {`);
    assert.notEqual(base, -1, `.${cls} button rule not found`);
    assert.match(CSS.slice(base, CSS.indexOf('}', base)), /min-height:\s*0/,
      `.${cls} button should keep its compact desktop rule; the touch block is what raises it`);
    const raised = [...CSS.matchAll(new RegExp(`\\.${cls} button \\{[^}]*min-height:\\s*44px`, 'g'))];
    assert.equal(raised.length, 1, `.${cls} button must be raised to 44px exactly once, in the touch block`);
  }
  // the close buttons themselves are still in the markup for every surface that had one
  for (const id of ['glossary-close', 'changelog-close', 'hydro-close', 'alert-close',
    'cam-close', 'sitrep-close', 'risk-close', 'health-close', 'share-sheet-close', 'help-sheet-close']) {
    assert.ok(HTML.includes(`id="${id}"`), `#${id} left index.html`);
  }
});

/* ---- the trap itself, run rather than described ----------------------------------------------
   registerModal() installs a MutationObserver on `hidden`, and that observer is the only thing that
   moves focus, marks the background inert or restores the trigger. Nothing below asserts on the text
   of js/core.js: the shipped observer is captured and fired, so a helper that stopped being called,
   or threw on first open, fails here. The 911 gate is the worked example because losing it is the
   one modal failure that is a life-safety matter. */

function runModal(fn) {
  const observers = [];
  const savedDoc = SBX.document;
  const savedMO = SBX.MutationObserver;
  const body = { tagName: 'BODY', children: [], focused: 0, focus() { body.focused++; } };
  const doc = {
    body,
    activeElement: null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    createElement: () => el('created'),
    documentElement: savedDoc.documentElement,
  };
  // toggling `hidden` is the only thing that opens or closes an overlay; the observer does the rest
  const setHidden = (node, hidden) => { node.hidden = hidden; observers.forEach((cb) => cb()); };
  const key = (init) => {
    let prevented = 0;
    const e = { shiftKey: false, ...init, preventDefault() { prevented++; } };
    for (const h of SBX.__docHandlers.get('keydown') || []) h(e);
    return prevented;
  };
  SBX.document = doc;
  SBX.MutationObserver = function (cb) {
    observers.push(cb);
    return { observe() {}, disconnect() {}, takeRecords: () => [] };
  };
  try { return fn({ doc, body, setHidden, key }); } finally {
    for (const node of body.children) if (!node.hidden) setHidden(node, true); // leave modalStack empty
    SBX.document = savedDoc;
    SBX.MutationObserver = savedMO;
  }
}

test('the 911 gate takes focus, makes the rest of the page inert, and gives both back on close', () => {
  runModal(({ doc, body, setHidden }) => {
    const ack = el('safety-ack');
    const gate = el('safety-modal', { kids: { '#safety-ack': ack } });
    const board = el('main');
    const scripts = el('scripts', { tagName: 'SCRIPT' });
    const trigger = el('disclaimer');
    body.children.push(gate, board, scripts);
    doc.activeElement = trigger;

    SBX.registerModal(gate, { initialFocus: '#safety-ack' });
    assert.equal(ack.focused, 0, 'registering a hidden overlay must not steal focus');
    assert.equal(board.getAttribute('inert'), null, 'nothing is inert while no modal is open');

    setHidden(gate, false);
    assert.equal(ack.focused, 1, 'opening the 911 gate must land focus on the acknowledgement button');
    assert.equal(board.getAttribute('inert'), '', 'the board behind the gate must be inert');
    assert.equal(board.getAttribute('aria-hidden'), 'true', 'a screen reader must not reach past the gate');
    assert.equal(gate.getAttribute('inert'), null, 'the gate itself must stay live');
    assert.equal(scripts.getAttribute('inert'), null, '<script> is not a surface; inerting it is noise');

    setHidden(gate, true);
    assert.equal(board.getAttribute('inert'), null, 'closing the gate must release the page');
    assert.equal(board.getAttribute('aria-hidden'), null, 'a leftover aria-hidden mutes the whole board');
    assert.equal(trigger.focused, 1, 'focus must return to whatever opened the gate');
  });
});

/* #risk-modal ships `{ initialFocus: '#risk-addr' }` and its close ✕ comes first in the markup, so
   without the option the open would land on ✕ and the address field would need a Tab to reach. */
test('initialFocus overrides document order, so #risk-modal opens on its address field', () => {
  runModal(({ body, setHidden }) => {
    const close = el('risk-close');
    const addr = el('risk-addr');
    const modal = el('risk-modal', { kids: { '#risk-close': close, '#risk-addr': addr } });
    body.children.push(modal, el('main'));
    SBX.registerModal(modal, { initialFocus: '#risk-addr' });
    setHidden(modal, false);
    assert.equal(addr.focused, 1, 'the address field is the point of the modal and must take focus');
    assert.equal(close.focused, 0, 'opening on the close button makes the user Tab to do anything');
  });
});

test('stacked overlays: only the topmost stays live, and closing it restores the one below', () => {
  runModal(({ body, setHidden }) => {
    const gate = el('safety-modal');
    const sheet = el('help-sheet');
    const board = el('main');
    body.children.push(gate, sheet, board);
    SBX.registerModal(gate);
    SBX.registerModal(sheet);

    setHidden(gate, false);
    setHidden(sheet, false);
    assert.equal(gate.getAttribute('inert'), '', 'the modal underneath must go inert when one opens over it');
    assert.equal(sheet.getAttribute('inert'), null);
    assert.equal(board.getAttribute('inert'), '');

    setHidden(sheet, true);
    assert.equal(gate.getAttribute('inert'), null, 'the modal below must come back to life, not stay inert');
    assert.equal(board.getAttribute('inert'), '', 'the page stays inert while any modal is still open');
  });
});

test('Tab cycles inside the open modal and never escapes it', () => {
  runModal(({ doc, body, setHidden, key }) => {
    const [a, b, c] = ['a', 'b', 'c'].map((n) => el(n));
    const sheet = el('help-sheet', { kids: { a, b, c } });
    body.children.push(sheet, el('main'));
    SBX.registerModal(sheet);

    assert.equal(key({ key: 'Tab' }), 0, 'with no modal open the trap must leave Tab alone');

    setHidden(sheet, false);
    assert.equal(a.focused, 1, 'opening an overlay with no initialFocus lands on its first focusable');

    doc.activeElement = a;
    assert.equal(key({ key: 'Tab' }), 1, 'the trap must take the Tab over');
    assert.equal(b.focused, 1, 'Tab must advance to the next focusable inside the modal');

    doc.activeElement = c;
    key({ key: 'Tab' });
    assert.equal(a.focused, 2, 'Tab at the last focusable must wrap to the first, not leave the modal');

    doc.activeElement = a;
    key({ key: 'Tab', shiftKey: true });
    assert.equal(c.focused, 1, 'Shift-Tab at the first focusable must wrap to the last');

    doc.activeElement = el('somewhere-else'); // focus outside the trap, e.g. after a browser-chrome hop
    key({ key: 'Tab' });
    assert.equal(a.focused, 3, 'Tab from outside the modal must re-enter it at the first focusable');
  });
});

/* The 911 gate closes only through #safety-ack, which records the acknowledgement. cycle-check.sh
   guards the boot.js half; this guards the core half, where a stray Escape branch would be just as
   fatal and is not covered by that check. */
test('the core trap is Tab-only: Escape never closes a registered modal', () => {
  runModal(({ doc, body, setHidden, key }) => {
    const ack = el('safety-ack');
    const gate = el('safety-modal', { kids: { '#safety-ack': ack } });
    const board = el('main');
    body.children.push(gate, board);
    SBX.registerModal(gate, { initialFocus: '#safety-ack' });
    setHidden(gate, false);
    doc.activeElement = ack;

    assert.equal(key({ key: 'Escape' }), 0, 'the core trap must not consume Escape; boot.js owns it');
    assert.equal(gate.hidden, false, 'Escape closed the 911 gate; it closes only via #safety-ack');
    assert.equal(board.getAttribute('inert'), '', 'Escape released the inert background behind the gate');
  });
});
