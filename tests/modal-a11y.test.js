'use strict';

// Pure-function coverage for the modal focus-trap helper (js/core.js). The trap/inert/focus
// side effects need a real browser and are verified by manual QA; only the DOM-free sub-parts
// (Tab cycle-index math, focusable-visibility predicate) are unit-tested here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./harness.js');

const { modalCycleIndex, modalIsFocusableVisible } = loadApp();

/* Which surfaces are modal is a correctness question, not a style one: registerModal() marks the
   rest of the page inert. Drive Mode is eyes-off-road and SHOULD cover and trap. The three docked
   lenses must not, because Basin fits the corridor and rings its gauges, so making the map inert
   is making the thing the lens exists to show unusable (v0.97.94). */
const ROOT = path.join(__dirname, '..');
const BOOT = fs.readFileSync(path.join(ROOT, 'js', 'boot.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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

test('the Recovery lens keeps the v0.97.87 playback guard', () => {
  const panels = fs.readFileSync(path.join(ROOT, 'js', 'panels.js'), 'utf8');
  const fn = panels.match(/async function openRecoveryView\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'openRecoveryView() not found');
  assert.ok(/!pbBlocksLive\(state\)/.test(fn[0]),
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
test('the per-second freshness line does not announce, and only writes on a change', () => {
  assert.ok(!/aria-live/.test(tagFor('drive-fresh')),
    '#drive-fresh is rewritten every second; an aria-live region there talks over everything else');
  const fn = PANELS.match(/function updateDriveFreshness\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'updateDriveFreshness() not found');
  assert.match(fn[0], /if \(el\.textContent !== text\) el\.textContent = text/,
    'the per-second write must be guarded so an unchanged string never touches the DOM');
});

test('the emergency banner and the data-age bar announce themselves', () => {
  assert.match(tagFor('emergency-banner'), /role="alert"/,
    'the flash flood emergency banner is the loudest thing the board says and had no role at all');
  assert.match(tagFor('data-age-bar'), /role="status"/,
    'the data-age bar is a currency warning and was silent to assistive tech');
  // role="status" is only safe here because the render is signature-guarded against the 1s tick
  const boot = fs.readFileSync(path.join(ROOT, 'js', 'boot.js'), 'utf8');
  const fn = boot.match(/function renderDataAgeBar\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'renderDataAgeBar() not found');
  assert.match(fn[0], /if \(el\.dataset\.sig === sig\) return;/,
    'without the signature guard the status role would re-announce on every countdown tick');
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
test('a card tap drops the sheet instead of scrolling a page that does not scroll', () => {
  for (const f of ['board.js', 'panels.js', 'boot.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
    assert.ok(!/\$\('#map'\)\.scrollIntoView/.test(src),
      `${f} still scrolls #map into view; the page has no scroll container for it to move`);
  }
  const fn = BOARD.match(/function revealMapOnPhone\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'revealMapOnPhone() not found in js/board.js');
  assert.match(fn[0], /window\.innerWidth > 768/, 'the reveal is a phone-layout concern only');
  assert.match(fn[0], /main\.sheet-full/, 'only the full sheet hides the map; the other states need no change');
  assert.match(fn[0], /setSheet\('sheet-half'\)/,
    'the existing sheet helper owns the state, the class list and the map re-measure');
  // every former call site routes through the one helper
  const sites = ['board.js', 'panels.js', 'boot.js']
    .map((f) => (fs.readFileSync(path.join(ROOT, 'js', f), 'utf8').match(/revealMapOnPhone\(\)/g) || []).length)
    .reduce((a, b) => a + b, 0);
  assert.equal(sites, 6, 'expected five call sites plus the declaration to route through revealMapOnPhone()');
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
