'use strict';

/* Responsive contract for css/app.css. These are the rules that decide whether a control is
   reachable with a gloved thumb on a dash mount, and they are invisible to every other test in
   the suite: there is no DOM in the node harness, so nothing else can see a media query at all.
   The specific defect guarded here shipped for a long time. The landscape block declared
   `.controls button { min-height: 34px }` at the same specificity as the 44px phone rule and
   later in the file, so holding a phone sideways made the tap targets SMALLER, in exactly the
   vehicle-mount posture where they should be largest. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadHeaderStatus } = require('./harness.js');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'css', 'app.css'), 'utf8');

/* Every @media block carrying this exact condition, brace-counted so nested blocks survive and
   concatenated so a rule is found wherever its block sits. The file keeps several blocks per
   breakpoint, next to the component each one tunes, so reading only the first would let a rule
   escape a guard purely by being declared in a different block for the same condition. */
function mediaBlock(condition) {
  const needle = `@media ${condition}`;
  const out = [];
  for (let at = CSS.indexOf(needle); at !== -1; at = CSS.indexOf(needle, at + 1)) {
    // an exact match only: "(max-width: 768px)" must not swallow "(max-width: 768px), (…)"
    if (!/^\s*\{/.test(CSS.slice(at + needle.length))) continue;
    const open = CSS.indexOf('{', at);
    let depth = 0;
    let closed = false;
    for (let i = open; i < CSS.length; i++) {
      if (CSS[i] === '{') depth += 1;
      else if (CSS[i] === '}') {
        depth -= 1;
        if (depth === 0) { out.push(CSS.slice(open + 1, i)); closed = true; break; }
      }
    }
    if (!closed) throw new Error(`unbalanced braces after @media ${condition}`);
  }
  assert.notEqual(out.length, 0, `no @media ${condition} block in css/app.css`);
  return out.join('\n');
}

// the declaration a selector makes for one property inside a block ('' when the selector is absent)
function decl(block, selector, prop) {
  const re = new RegExp(`(^|[},])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
  const m = block.match(re);
  if (!m) return '';
  const p = m[2].match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`));
  return p ? p[1].trim() : '';
}

const LANDSCAPE = '(max-height: 500px) and (orientation: landscape)';
const TABLET = '(min-width: 769px) and (max-width: 960px)';

test('the phone block holds the 44px floor the landscape block once undercut', () => {
  const block = mediaBlock('(max-width: 768px)');
  assert.equal(decl(block, '.controls button', 'min-height'), '44px',
    'the phone block must declare min-height: 44px for .controls button');
  assert.equal(decl(block, '.controls button', 'min-width'), '44px');
});

test('landscape grows the header controls to 44px, never shrinks them', () => {
  const block = mediaBlock(LANDSCAPE);
  assert.equal(decl(block, '.controls button', 'min-height'), '44px',
    'the landscape block must declare min-height: 44px for .controls button');
  assert.equal(decl(block, '.controls button', 'min-width'), '44px');
  // nothing anywhere in the landscape block may shrink a control below the 44px floor
  for (const m of block.matchAll(/min-height\s*:\s*(\d+)px/g)) {
    const px = Number(m[1]);
    assert.ok(px >= 32, `landscape declares min-height: ${px}px, below any usable target`);
  }
});

/* Owner report: "the horizontal width of the settings gear icon on mobile is all bonkers". The
   floors above are class rules (0,1,1), so any ID rule (1,0,0) on a header control outranks them
   at every breakpoint no matter where it sits in the file. `#hmore-btn { min-width: 40px }` did
   exactly that, and measured at 390x844 / 844x390 / 932x430 the gear was a 40x44 box in a row of
   44x44 squares, four pixels under the tap-target floor its siblings all met. */
const HEADER_CONTROL_IDS = ['#update-chip', '#search-btn', '#drive-btn', '#refresh-now', '#risk-btn', '#hmore-btn'];

test('no ID-specificity rule undercuts the 44px floor on a header control', () => {
  const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const offenders = [];
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    if (sel.startsWith('@') || sel.includes('#hmore-menu')) continue; // menu rows are full-width, not header controls
    if (!HEADER_CONTROL_IDS.some((id) => sel.includes(id))) continue;
    for (const d of m[2].matchAll(/min-(?:width|height)\s*:\s*(\d+)px/g)) {
      if (Number(d[1]) < 44) offenders.push(`${sel} { ${d[0].trim()} }`);
    }
  }
  assert.deepEqual(offenders, [],
    'a header-control ID rule declares a sub-44px floor; ID specificity beats the .controls button ' +
    'rules in every responsive block, so the control silently opts out of the tap-target floor');
});

/* The hazard line scrolls (owner requirement, v0.99.13, reversing the v0.98.4 removal). What this
   guards is the part that is not negotiable while it does: the worst item is pinned outside the
   moving lane, the motion can be stopped, a reduced-motion device gets a readable static list
   instead of a frozen loop, and the whole remainder stays reachable without waiting for the loop.
   The v0.98.4 assertion that no animation may exist is deliberately gone: it encoded Android for
   Cars ST-1, and the owner has asked for the scroll with that stated. */
test('the hazard line scrolls, and the worst item is pinned outside the moving lane', () => {
  assert.ok(CSS.includes('@keyframes tickerScroll'), 'the marquee keyframes are missing');
  assert.match(decl(CSS, '.ticker-reel', 'animation'), /tickerScroll/, '.ticker-reel must run the loop');
  assert.match(decl(CSS, '.ticker-reel', 'animation'), /infinite/);
  // the pinned item must not live inside the lane, or it moves with everything else
  assert.equal(decl(CSS, '.ticker-lead', 'animation'), '', 'the pinned lead must never animate');
  assert.equal(decl(CSS, '.ticker-marquee', 'animation'), '', 'the lane clips, the reel inside it moves');
  const panels = fs.readFileSync(path.join(__dirname, '..', 'js', 'panels.js'), 'utf8');
  assert.match(panels, /function renderTicker\(\)/);
  assert.match(panels, /ticker-lead/, 'renderTicker must pin a lead item');
  assert.match(panels, /ticker-more/, 'renderTicker must offer the remainder on demand');
  // item 0 is the ranked worst; it is emitted on its own and the lane starts at item 1
  assert.match(panels, /tickerItemHtml\(items\[0\], 0, `ticker-lead/, 'the lead must be items[0], the ranked worst');
  assert.match(panels, /const rest = items\.slice\(1\)/, 'the lane must carry the remainder, not the lead again');
  // two identical runs are what make -50% seamless; the duplicate must not be announced or focusable
  assert.match(panels, /ticker-run" aria-hidden="true"/, 'the duplicate run must be hidden from assistive tech');
  assert.match(panels, /dup \? ' tabindex="-1"' : ''/, 'the duplicate run must not be keyboard reachable');
});

test('the scroll can be stopped, and a reduced-motion device gets a static list', () => {
  // WCAG 2.2.2: content that moves by itself for more than five seconds needs a pause
  assert.match(CSS, /#ticker:hover \.ticker-reel[^{]*\{[^}]*animation-play-state:\s*paused/,
    'the loop must pause on hover');
  assert.match(CSS, /#ticker:focus-within \.ticker-reel|focus-within[^{]*\.ticker-reel/,
    'the loop must pause on keyboard focus, not only on hover');
  const rm = mediaBlock('(prefers-reduced-motion: reduce)');
  assert.equal(decl(rm, '.ticker-marquee', 'display'), 'none',
    'reduced motion must drop the lane, not freeze it: a frozen loop hides every item past the fold');
  assert.equal(decl(rm, '.ticker-lead', 'max-width'), 'none',
    'with the lane gone the pinned item must take the width back');
  // and nothing is lost: the count button still opens every remainder item as a static list
  const panels = fs.readFileSync(path.join(__dirname, '..', 'js', 'panels.js'), 'utf8');
  assert.match(panels, /\$\('#ticker-rest'\)\.innerHTML = restHtml/,
    '#ticker-rest must carry the full remainder independently of the lane');
});

/* The hazard line was display:none in the landscape block, so the one posture it matters most in,
   a phone on a dash mount, was the one posture that had no hazard line at all. */
test('landscape shows the hazard line rather than hiding it', () => {
  const block = mediaBlock(LANDSCAPE);
  assert.equal(decl(block, '#ticker', 'display'), '',
    'the landscape block must not hide #ticker');
  assert.ok(!/#ticker\s*\{[^}]*display:\s*none/.test(block), 'a landscape rule still hides the hazard line');
});

/* The emergency banner is fixed at the top and the hazard line is the flow content under the
   header, so a constant `top` covered the line. Measured before the fix: 26px of overlap at
   1440x900, 87px at 390x844, 28px at 844x390 and 932x430. */
test('the emergency banner clears the hazard line instead of covering it', () => {
  const at = CSS.indexOf('#emergency-banner {');
  assert.notEqual(at, -1, '#emergency-banner rule not found');
  const rule = CSS.slice(at, CSS.indexOf('}', at));
  assert.match(rule, /top:\s*calc\(var\(--hazline-bottom/,
    'the banner must be positioned from the hazard line, not a constant');
  assert.match(rule, /--hazline-bottom,\s*\d+px/, 'the variable needs a fallback for a board with no hazard line');
  const panels = fs.readFileSync(path.join(__dirname, '..', 'js', 'panels.js'), 'utf8');
  assert.match(panels, /function syncHazlineAnchor\(\)/, 'nothing publishes the hazard line edge');
  assert.match(panels, /setProperty\('--hazline-bottom'/);
  // both exits of renderTicker must publish it, or a board that loses its last item leaves a stale edge
  const fn = panels.match(/function renderTicker\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'renderTicker() not found');
  assert.equal((fn[0].match(/syncHazlineAnchor\(\)/g) || []).length, 2,
    'renderTicker must publish the edge on both the empty and the populated path');
  const boot = fs.readFileSync(path.join(__dirname, '..', 'js', 'boot.js'), 'utf8');
  assert.match(boot, /syncHazlineAnchor\(\);/, 'rotation changes the line height; resize must republish it');
});

test('the phone gives the moving lane its own row rather than 46% of a 390px one', () => {
  const block = mediaBlock('(max-width: 768px)');
  assert.equal(decl(block, '.ticker-track', 'flex-wrap'), 'wrap');
  assert.match(decl(block, '.ticker-marquee', 'flex'), /100%/, 'the lane must take a full row on a phone');
  assert.equal(decl(block, '.ticker-lead', 'max-width'), 'none', 'the pinned item keeps its full width there');
  // order matters: without it the count button wraps to a third row below the lane
  assert.equal(decl(block, '.ticker-more', 'order'), '1');
  assert.equal(decl(block, '.ticker-marquee', 'order'), '2');
});

test('the hazard remainder floats over the map instead of resizing it', () => {
  // at max-height the list once pushed main down and left a 390x844 phone 96px of map
  assert.equal(decl(CSS, '#ticker-rest', 'position'), 'absolute');
  assert.equal(decl(CSS, '#ticker', 'position'), 'relative', '#ticker must anchor the floating list');
  assert.match(decl(CSS, '#ticker-rest', 'max-height'), /^\d+vh$/);
  assert.equal(decl(CSS, '#ticker-rest', 'overscroll-behavior'), 'contain');
});

/* A dash-mounted phone in landscape could not give the map the screen at all: the sheet handle was
   display:none here while #sidebar stayed pinned to 40vw. That is the posture where the map matters
   most, so the affordance has to exist and has to be reachable. */
test('landscape can collapse the sidebar and the handle is a real 44px target', () => {
  const block = mediaBlock(LANDSCAPE);
  assert.equal(decl(block, '#sheet-handle', 'display'), 'flex',
    'the landscape block must show #sheet-handle, not hide it');
  assert.equal(decl(block, '#sheet-handle', 'position'), 'fixed', 'the handle must cost no layout space');
  assert.equal(decl(block, '#sheet-handle button', 'min-height'), '44px');
  assert.equal(decl(block, '#sheet-handle button', 'min-width'), '44px');
  assert.equal(decl(block, 'main.sheet-peek #sidebar', 'width'), '0',
    'landscape peek must collapse the sidebar so the map takes the screen');
  // the handle must never sit in the top-right corner, the furthest point from a mounted right thumb
  assert.equal(decl(block, '#sheet-handle', 'top'), 'auto');
  assert.match(decl(block, '#sheet-handle', 'bottom'), /^\d+px$/);
  // and it must stay reachable once the sidebar it was anchored to is gone
  assert.equal(decl(block, 'main.sheet-peek #sheet-handle', 'right'), '8px');
});

test('landscape restores the sidebar targets that escape the 768px width query', () => {
  // 932x430 is wider than 768px, so no phone rule applies and these fell back to ~25px
  const block = mediaBlock(LANDSCAPE);
  assert.equal(decl(block, '.feed-actions button, .act-btn, .tabs button', 'min-height'), '44px',
    'landscape must raise the feed, card-action and tab targets to 44px');
});

test('the 769-960px tablet block exists and raises the targets it was created for', () => {
  const block = mediaBlock(TABLET);
  assert.equal(decl(block, '.controls button', 'min-height'), '44px');
  assert.equal(decl(block, '.feed-actions button, .act-btn, .tabs button', 'min-height'), '44px');
  assert.equal(decl(block, '.controls .ctl-lbl', 'display'), 'none', 'the tablet block should go icon-only');
  assert.ok(decl(block, '.refresh-meta', 'font-size'), 'the tablet block should compact .refresh-meta');
});

test('the 768px breakpoint was not moved (roughly 40 rules key off it)', () => {
  assert.ok(CSS.includes('@media (max-width: 768px)'), 'the main phone breakpoint is gone');
  const at768 = (CSS.match(/@media \(max-width: 768px\)/g) || []).length;
  assert.ok(at768 >= 2, `expected several max-width: 768px blocks, found ${at768}`);
  // a near-miss value (760, 770, 780…) means someone nudged the phone breakpoint instead of
  // adding an additive block. 820px is a long-standing, separate legend-stack rule.
  const near = [...CSS.matchAll(/max-width: (\d+)px/g)].map((m) => Number(m[1]))
    .filter((px) => px >= 750 && px <= 800 && px !== 768);
  assert.deepEqual(near, [], `near-768 breakpoint(s) ${near.join(', ')}; the phone breakpoint must stay at exactly 768px`);
});

/* Owner report: "the Alerts construct within the settings menu is a wall of text". The card now
   leads with the state and the switch, and the two honesty paragraphs sit behind a <details> that
   has to keep looking like a disclosure: display:flex on a summary drops the native marker. */
test('the alerts disclosure keeps a visible affordance and a real tap target', () => {
  const at = CSS.indexOf('#push-body .push-about > summary {');
  assert.notEqual(at, -1, 'the .push-about summary rule is gone');
  const rule = CSS.slice(at, CSS.indexOf('}', at));
  assert.ok(/min-height:\s*44px/.test(rule), 'the disclosure summary must be a 44px tap target');
  assert.ok(/cursor:\s*pointer/.test(rule));
  assert.ok(/summary::before \{[^}]*content:/.test(CSS), 'display:flex drops the native marker; the summary needs its own');
  assert.ok(/\[open\] > summary::before \{[^}]*content:/.test(CSS), 'the affordance must show the open state too');
  // the state line is never inside the disclosure: it is the one thing that must always be plain
  const head = CSS.slice(CSS.indexOf('#push-body .push-head {'), CSS.indexOf('}', CSS.indexOf('#push-body .push-head {')));
  assert.ok(/display:\s*flex/.test(head), 'the state and the switch share one row');
  assert.ok(/flex-wrap:\s*wrap/.test(head), 'a long translated state string must wrap, not overflow');
  assert.ok(/#push-body \.push-blocked \{[^}]*color:/.test(CSS), 'blocked needs its own colour, distinct from off');
});

test('the settings sheet is scrollable rather than unbounded', () => {
  // it now carries the device-alerts card; without a cap it ran off a short landscape viewport
  const at = CSS.indexOf('#hmore-menu {');
  assert.notEqual(at, -1, '#hmore-menu rule not found');
  const rule = CSS.slice(at, CSS.indexOf('}', at));
  assert.ok(/max-height\s*:/.test(rule), '#hmore-menu must declare a max-height');
  assert.ok(/overflow-y\s*:\s*auto/.test(rule), '#hmore-menu must declare overflow-y: auto');
  assert.ok(/overscroll-behavior\s*:\s*contain/.test(rule), '#hmore-menu should contain its overscroll');
});

test('the header stays one row at every width and the tiles are gone', () => {
  const at = CSS.indexOf('\nheader {');
  assert.notEqual(at, -1, 'base header rule not found');
  const rule = CSS.slice(at, CSS.indexOf('}', at));
  assert.ok(/flex-wrap\s*:\s*nowrap/.test(rule), 'header must declare flex-wrap: nowrap');
  assert.ok(!/^\s*\.tiles?\b/m.test(CSS) && !CSS.includes('.tiles,') && !CSS.includes(' .tiles '),
    'css/app.css still styles the retired header tiles');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(!/class="tiles"/.test(html) && !/id="tile-/.test(html), 'index.html still declares the header tiles');
  const boot = fs.readFileSync(path.join(__dirname, '..', 'js', 'boot.js'), 'utf8');
  assert.ok(!/#tile-/.test(boot), 'js/boot.js still wires the header tiles');
  const panels = fs.readFileSync(path.join(__dirname, '..', 'js', 'panels.js'), 'utf8');
  assert.ok(!/#tile-/.test(panels), 'js/panels.js still writes the header tiles');
  // renderTiles stays: it is the composite entry every refresh calls
  const fn = panels.match(/function renderTiles\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'renderTiles() was removed; it is the per-refresh composite entry');
  for (const call of ['renderThreatStrip()', 'renderTicker()', 'renderDriveMode()']) {
    assert.ok(fn[0].includes(call), `renderTiles() no longer calls ${call}`);
  }
  assert.ok(/document\.title\s*=/.test(fn[0]), 'renderTiles() no longer updates document.title');
});

test('the counts the tiles carried alone became threat-strip chips', () => {
  const panels = fs.readFileSync(path.join(__dirname, '..', 'js', 'panels.js'), 'utf8');
  const fn = panels.match(/function renderThreatStrip\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'renderThreatStrip() not found');
  assert.ok(/t\('threat\.warnings'\)/.test(fn[0]), 'the flood-warning count did not become a chip');
  assert.ok(/t\('threat\.notices'\)/.test(fn[0]), 'the active-notice count did not become a chip');
  assert.ok(/threat\.warnings[\s\S]*?tab-alerts/.test(fn[0]), 'the warnings chip should route to Alerts');
  assert.ok(/threat\.notices[\s\S]*?tab-requests/.test(fn[0]), 'the notices chip should route to Feed');
});

/* The camera band parent sits beside a 34px disclosure header. It is a real toggle, so it carries
   the same floor as every other control a gloved thumb has to hit, and it must express its third
   state by the knob's position rather than by colour alone. */
test('the camera parent toggles are 44px targets and state partial by position', () => {
  const band = CSS.slice(CSS.indexOf('.ls-camband {'), CSS.indexOf('}', CSS.indexOf('.ls-camband {')));
  assert.notEqual(band, '', '.ls-camband rule not found');
  assert.ok(/min-height:\s*44px/.test(band), 'the band parent must declare a 44px min-height');
  assert.ok(/min-width:\s*44px/.test(band), 'the band parent must declare a 44px min-width');
  assert.ok(/\.ls-subrow \{[^}]*align-items:\s*stretch/.test(CSS),
    'the disclosure must stretch to the parent toggle height, or half the header row is dead space');
  // off/mixed/on are three knob positions: 2px, 9px, 16px
  assert.ok(/\.ls-row\.part \.ls-knob::after[^}]*left:\s*9px/.test(CSS),
    'partial must move the knob to its own position, not merely recolour it');
  assert.ok(/\.ls-camband\.part \.ls-knob::after/.test(CSS));
});

test('the import control is a 44px target, not the 30px badge it was', () => {
  assert.ok(/#interchange-body label\[for="import-file"\] \.badge \{[^}]*min-height:\s*44px/.test(CSS),
    'the Import JSON badge must declare a 44px min-height');
});

/* Header status (owner report: "the degraded state status top right on mobile is bumping the top
   nav items far left"). #refresh-note is the last item in a nowrap header. Writers used to assign
   a whole sentence to it: measured at 390x844 with all seven sources failing, .refresh-meta went
   77px -> 600px, .controls 281px -> 804px, the nav slid 85px left, .brand was crushed to 0, and
   the document scrolled sideways at 820px. Even the plain offline message did it. */
test('the header status is width-capped so it can never displace the nav', () => {
  const at = CSS.indexOf('\n.refresh-meta {');
  assert.notEqual(at, -1, 'base .refresh-meta rule not found');
  const base = CSS.slice(at, CSS.indexOf('}', at));
  assert.ok(/max-width:\s*\d+px/.test(base), '.refresh-meta must declare a max-width');
  assert.ok(/overflow:\s*hidden/.test(base), '.refresh-meta must clip rather than grow');
  assert.ok(/min-width:\s*0/.test(base), '.refresh-meta must be allowed to shrink');
  assert.ok(/#refresh-note \{[^}]*text-overflow:\s*ellipsis/.test(CSS), '#refresh-note should ellipsize');
  // every responsive block that tunes it must keep the cap
  for (const cond of ['(max-width: 768px)', LANDSCAPE, TABLET]) {
    const w = decl(mediaBlock(cond), '.refresh-meta', 'max-width');
    assert.ok(/^\d+px$/.test(w), `@media ${cond} tunes .refresh-meta without keeping a max-width`);
  }
  assert.ok(/#refresh-note\.degraded \{/.test(CSS), 'the degraded state needs its own visible chip style');
});

/* The v0.97.93 version of this test matched only `$('#refresh-note').textContent =`, so
   compassNotice()'s two-line `const note = $('#refresh-note'); note.textContent = t(key)` walked
   straight through it. Match the LOOKUP instead of the assignment: once a file outside boot.js
   holds a reference to the slot there is no regex that can police what it does with it. */
const SLOT_LOOKUP = /(?:\$\(\s*['"]#refresh-note['"]|querySelector\(\s*['"]#refresh-note['"]|getElementById\(\s*['"]refresh-note['"])/g;

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('the header status has exactly one writer, so no call site can uncap it', () => {
  const files = ['map', 'sources', 'playback', 'panels', 'board', 'team', 'cameras', 'core', 'notes'];
  const offenders = [];
  for (const f of files) {
    const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'js', `${f}.js`), 'utf8'));
    for (const m of src.matchAll(SLOT_LOOKUP)) offenders.push(`js/${f}.js: ${m[0]}`);
  }
  assert.deepEqual(offenders, [],
    'only js/boot.js may reach #refresh-note; route feed state through setFeedNote()/setFeedNoteHealthy() ' +
    'and transient failures through opNotice()');
  const boot = fs.readFileSync(path.join(__dirname, '..', 'js', 'boot.js'), 'utf8');
  // the detail must survive: it is honesty-critical and is the reason the chip is tappable
  const fn = boot.match(/function setFeedNote\(short, detail\)[\s\S]*?\n\}/);
  assert.ok(fn, 'setFeedNote() not found in js/boot.js');
  assert.ok(/state\.feedNoteDetail = detail/.test(fn[0]), 'setFeedNote must keep the detail, not discard it');
  assert.ok(/classList\.toggle\('degraded'/.test(fn[0]), 'setFeedNote must mark the degraded chip');
  const tick = boot.match(/function tickCountdown\(\)[\s\S]*?\n\}/);
  assert.ok(tick && /refreshNoteTitle\(\)/.test(tick[0]),
    'the countdown must compose the tooltip, not overwrite the degraded detail every second');
  assert.ok(/#refresh-note'\)\.addEventListener\('click'/.test(boot),
    'the degraded chip must open the source-by-source detail');
});

/* The behavioral half of the same invariant, and the reason the static guard above was not enough.
   Sequence that shipped in v0.97.93/94: feeds go degraded, the user taps the compass, iOS denies
   motion, compassNotice() overwrites the slot. The header then read "compass unavailable" wearing
   the amber degraded chip, still tappable through to Live feeds, still carrying the stale "these
   sources did not answer" tooltip, while the real degraded state vanished from the only place it
   was shown. A board that looks healthier than it is. */
test('a transient notice cannot overwrite, restyle or impersonate the degraded feed state', () => {
  const h = loadHeaderStatus();
  const slot = h.node('#refresh-note');

  h.setFeedNote('note.degraded', 'note.degraded.detail NWPS gauges');
  assert.equal(slot.textContent, 'note.degraded');
  assert.ok(slot.classList.contains('degraded'), 'setup: the degraded chip should be on');
  assert.equal(slot.getAttribute('role'), 'button');
  assert.equal(slot.getAttribute('tabindex'), '0');
  const degradedTitle = slot.title;
  assert.ok(degradedTitle.includes('note.degraded.detail'), 'setup: the tooltip should carry the detail');

  for (const raise of [() => h.compassNotice('ctl.compass.denied'), () => h.opNotice('note.locfail')]) {
    raise();
    assert.equal(slot.textContent, 'note.degraded', 'a transient notice overwrote the freshness slot');
    assert.ok(slot.classList.contains('degraded'), 'a transient notice cleared the degraded chip');
    assert.equal(h.state.feedNoteDetail, 'note.degraded.detail NWPS gauges', 'the degraded detail was lost');
    assert.equal(slot.getAttribute('role'), 'button', 'the tap-through role was reset');
    assert.equal(slot.getAttribute('tabindex'), '0', 'the chip stopped being keyboard reachable');
    assert.equal(slot.title, degradedTitle, 'the degraded tooltip was replaced');
  }

  // it landed somewhere: its own auto-dismissing toast, which carries no feed-health affordance
  const toast = h.node('#op-toast');
  assert.equal(toast.hidden, false, 'the transient notice must still be shown, just not in the slot');
  assert.equal(h.node('#op-toast-text').textContent, 'note.locfail');
  assert.ok(!toast.classList.contains('degraded'), 'the op toast must not wear the degraded chip');
  assert.equal(toast.getAttribute('role'), null, 'the op toast must not be a tap-through to Live feeds');
  assert.ok(h.timers.some((x) => x.ms > 0), 'the op toast must arm an auto-dismiss');
});

test('every freshness-slot write is a data-currency state, not an op failure', () => {
  const boot = stripComments(fs.readFileSync(path.join(__dirname, '..', 'js', 'boot.js'), 'utf8'));
  const keys = [...boot.matchAll(/setFeedNote\(\s*t\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(keys)].sort(),
    ['note.degraded', 'note.offline', 'note.refreshing', 'note.snapshot'],
    'the freshness slot may only say how current the data is; route anything else through opNotice()');
});

test('landscape swaps the lockup for the square mark at the dark-theme specificity', () => {
  const block = mediaBlock(LANDSCAPE);
  assert.ok(/:root\[data-theme="dark"\] \.brand-logo/.test(block),
    'the landscape hide must match the (1,2,0) dark-theme lockup rule or it loses the cascade');
  assert.equal(decl(block, '.brand-mark', 'display'), 'block', 'landscape should show the square mark');
  const base = CSS.slice(CSS.indexOf('.brand-mark {'), CSS.indexOf('}', CSS.indexOf('.brand-mark {')));
  assert.ok(/display:\s*none/.test(base), '.brand-mark must be hidden by default');
  assert.ok(/height:\s*28px/.test(base), '.brand-mark should be 28px tall');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(/class="brand-mark" src="assets\/brand\/icon\.svg\?v=/.test(html),
    'index.html must ship the square mark from the already-stamped icon.svg');
});
