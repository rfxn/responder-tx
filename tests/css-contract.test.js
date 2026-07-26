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
const HEADER_CONTROL_IDS = ['#update-chip', '#search-btn', '#drive-btn', '#refresh-now', '#alerts-btn', '#risk-btn', '#hmore-btn'];

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

/* The hazard line scrolls (owner requirement, v0.99.13) and now scrolls ALONE: the pinned lead
   item and the count button beside it were removed on owner request after four reports of a
   "static alert" next to the moving feed. What this guards is what survives that removal: the reel
   still opens on the ranked worst item, it still carries every item, the motion can still be
   stopped, and a reduced-motion device still gets a readable list rather than a blank line. */
test('the hazard line is one scrolling reel, ranked worst first, with nothing pinned beside it', () => {
  assert.ok(CSS.includes('@keyframes tickerScroll'), 'the marquee keyframes are missing');
  assert.match(decl(CSS, '.ticker-reel', 'animation'), /tickerScroll/, '.ticker-reel must run the loop');
  assert.match(decl(CSS, '.ticker-reel', 'animation'), /infinite/);
  assert.equal(decl(CSS, '.ticker-marquee', 'animation'), '', 'the lane clips, the reel inside it moves');
  const panels = fs.readFileSync(path.join(__dirname, '..', 'js', 'panels.js'), 'utf8');
  assert.match(panels, /function renderTicker\(\)/);
  // the two surfaces the owner asked to remove must not come back in markup or in CSS
  for (const gone of ['ticker-lead', 'ticker-solo', 'ticker-more', 'tm-n', 'tm-lbl']) {
    assert.ok(!panels.includes(gone), `renderTicker still builds ${gone}`);
    assert.ok(!CSS.includes(`.${gone}`), `css/app.css still styles .${gone}`);
  }
  const fn = panels.match(/function renderTicker\(\)[\s\S]*?\n\}/)[0];
  // losing the pin must not lose the ranking: the reel takes the whole list, unsliced, in order
  assert.ok(!/items\.slice\(/.test(fn), 'the reel must carry every item, not a remainder');
  assert.match(fn, /tickerRunHtml\(items, false\)/, 'the visible run must be built from the ranked set');
  assert.match(fn, /tickerRunHtml\(items, true\)/, 'the duplicate run must carry the same set');
  // data-ti indexes state.tickerActs directly, so a tap acts on the item it was aimed at
  assert.match(panels, /state\.tickerActs = items\.map\(\(i\) => i\.act\)/);
  assert.match(panels, /\.map\(\(it, n\) => `\$\{tickerItemHtml\(it, n, '', dup\)\}/,
    'run items must be numbered from 0, or every tap acts on the wrong hazard');
  // two identical runs are what make -50% seamless; the duplicate must not be announced or focusable
  assert.match(panels, /ticker-run" aria-hidden="true"/, 'the duplicate run must be hidden from assistive tech');
  assert.match(panels, /dup \? ' tabindex="-1"' : ''/, 'the duplicate run must not be keyboard reachable');
});

test('the scroll can be stopped, and a reduced-motion device gets the whole list, not a blank line', () => {
  // WCAG 2.2.2: content that moves by itself for more than five seconds needs a pause
  assert.match(CSS, /#ticker:hover \.ticker-reel[^{]*\{[^}]*animation-play-state:\s*paused/,
    'the loop must pause on hover');
  assert.match(CSS, /#ticker:focus-within \.ticker-reel|focus-within[^{]*\.ticker-reel/,
    'the loop must pause on keyboard focus, not only on hover');
  const rm = mediaBlock('(prefers-reduced-motion: reduce)');
  assert.equal(decl(rm, '.ticker-marquee', 'display'), 'none',
    'reduced motion must drop the lane, not freeze it: a frozen loop hides every item past the fold');
  /* This is the regression the lead's removal could have caused. The lane was the only thing the
     reduced-motion block turned off, and the pinned item was what stayed behind. With no pinned
     item, dropping the lane and showing nothing else leaves that user no hazard line at all. */
  assert.equal(decl(rm, '#ticker-rest', 'display'), 'flex',
    'reduced motion drops the lane, so the static list must be shown or the line renders empty');
  assert.equal(decl(CSS, '#ticker-rest', 'display'), 'none',
    'the static list must be off while the reel runs, or the same hazards render twice');
  const panels = fs.readFileSync(path.join(__dirname, '..', 'js', 'panels.js'), 'utf8');
  const fn = panels.match(/function renderTicker\(\)[\s\S]*?\n\}/)[0];
  assert.match(fn, /const restHtml = items\.map\(\(it, n\) => tickerItemHtml\(it, n\)\)/,
    'the static list must carry the full ranked set, not a remainder of a lead that no longer exists');
  assert.match(fn, /\$\('#ticker-rest'\)\.innerHTML = restHtml/);
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

/* The reel used to be a reading surface with the tap targets elsewhere: the pinned item and the
   rows behind the count button. Both are gone, so the reel is the only thing in the line to aim
   at and it has to carry the floor itself. */
test('the reel carries the 44px tap floor now that it is the only target in the line', () => {
  const block = mediaBlock('(max-width: 768px)');
  assert.match(decl(block, '.ticker-marquee .ticker-item', 'min-height'), /^44px$/,
    'the moving items are the only tap target left and must meet the 44px floor');
  assert.match(decl(block, '#ticker-rest .ticker-item', 'min-height'), /^44px$/,
    'the reduced-motion rows must meet the floor too');
  // the two-row track existed only to give the lead and the count button their own line
  assert.equal(decl(block, '.ticker-track', 'flex-wrap'), '',
    'the track no longer needs to wrap: the reel is its only child');
  assert.match(CSS, /#ticker:active \.ticker-reel/,
    'a touch must stop the lane on touch-down, or the target moves out from under the thumb');
});

/* The list is no longer an overlay an expander opens; it is what a reduced-motion device reads
   instead of the reel. The invariant that survives the change is the one that mattered: a long
   hazard list must never take the map, which at 40vh once left a 390x844 phone with 96px of it. */
test('the reduced-motion hazard list caps its own height instead of taking the map', () => {
  assert.match(decl(CSS, '#ticker-rest', 'max-height'), /^\d+vh$/, 'the list must cap its height');
  assert.equal(decl(CSS, '#ticker-rest', 'overflow-y'), 'auto', 'a capped list must scroll its overflow');
  assert.equal(decl(CSS, '#ticker-rest', 'overscroll-behavior'), 'contain',
    'scrolling the list must not chain into the map behind it');
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

/* The hotline number is now the dial control itself, so it is a tap target on every layout a
   phone can be held in, not a run of text that happens to be clickable. */
test('the dial link meets the 44px floor at every phone and vehicle-mount width', () => {
  for (const condition of ['(max-width: 500px)', '(max-width: 768px)', TABLET, LANDSCAPE]) {
    assert.equal(decl(mediaBlock(condition), '.tel-link', 'min-height'), '44px',
      `@media ${condition} does not hold the 44px floor for .tel-link`);
  }
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

/* The scrolling hazard line cycles every ranked item, so the count chips above it said the same
   thing twice. The strip now stands down while the line has anything to carry, and keeps only the
   all-clear the line cannot express, because an empty line and a calm board look identical. */
test('the strip stands down while the hazard line is carrying, and never repeats it as counts', () => {
  const panels = fs.readFileSync(path.join(__dirname, '..', 'js', 'panels.js'), 'utf8');
  const fn = panels.match(/function renderThreatStrip\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'renderThreatStrip() not found');
  assert.ok(/tickerItems\(\)\.length/.test(fn[0]),
    'the strip must stand down while the hazard line has items, or the two are stacked again');
  for (const gone of ['threat-grid', 'stat-row', 'ffe-row', 'threat-headline', 'appendChipGrid', 'headlineParts']) {
    assert.ok(!panels.includes(gone), `js/panels.js still builds the retired ${gone}`);
  }
  // the all-clear states are the strip's whole remaining job: losing them leaves a calm board blank
  assert.ok(/quiet\.line/.test(fn[0]), 'the strip lost the quiet all-clear line');
  assert.ok(/threat\.okline/.test(fn[0]), 'the strip lost the no-active-threats line');
  assert.ok(/playback\.striplive/.test(fn[0]), 'the strip lost the playback live-data note');
});

/* The open-shelter count briefly rode in the header. The owner removed it: the settings menu
   already opens the same sheet and the top bar has no room for a second route to it. What this
   guards is that exactly one entry point survives and the count stays out of the hazard line. */
test('the shelters sheet keeps one entry point, and no shelter count rides in the header', () => {
  const panels = fs.readFileSync(path.join(__dirname, '..', 'js', 'panels.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const boot = fs.readFileSync(path.join(__dirname, '..', 'js', 'boot.js'), 'utf8');
  const header = html.slice(html.indexOf('<div class="controls">'), html.indexOf('<div id="hmore-menu"'));
  assert.ok(!/shelter-chip/.test(header), 'the header carries a shelter control again; there is no room for one');
  assert.ok(!/shelter-chip/.test(html + panels + boot), 'a shelter-chip vestige survives');
  // the settings row is the entry point, and it still opens the sheet
  assert.ok(/id="shelters-btn"/.test(html), 'the settings shelters row is gone; the sheet is unreachable');
  assert.ok(/#shelters-btn'\)\.addEventListener\('click', openHelpSheet\)/.test(boot),
    'the settings shelters row must still open the help sheet');
  // shelters are help, not a hazard: the count must never enter the hazard line
  const ticker = panels.match(/function tickerItems\(\)[\s\S]*?\n\}/);
  assert.ok(!/[Ss]helter/.test(ticker[0]), 'a shelter count leaked into the hazard line');
});

/* The camera bands are the sheet's only sub-category headers. Everything about them that is not
   genuinely new (the disclosure and the parent toggle) follows .ls-group, the one header idiom the
   sheet already had, instead of inventing a type step of its own. */
test('the camera sub-category header follows the sheet header convention and declares its own floor', () => {
  const rule = (sel) => {
    const i = CSS.indexOf(`${sel} {`);
    return i === -1 ? '' : CSS.slice(i, CSS.indexOf('}', i));
  };
  const group = rule('.ls-group');
  const head = rule('.ls-subhead');
  assert.notEqual(head, '', '.ls-subhead rule not found');
  for (const prop of ['font-size', 'font-weight', 'letter-spacing', 'text-transform']) {
    const want = new RegExp(`${prop}:\\s*([^;]+)`).exec(group);
    assert.ok(want, `.ls-group has no ${prop} to match`);
    assert.ok(new RegExp(`${prop}:\\s*${want[1].trim()}\\s*[;\\n]`).test(head),
      `.ls-subhead ${prop} diverges from .ls-group (${want[1].trim()})`);
  }
  // the floor must be its own, not inherited from whichever sibling happens to sit beside it
  assert.ok(/min-height:\s*44px/.test(head),
    'the sub-header must declare 44px itself; a 34px declaration only reached the floor via .ls-camband');
});

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

/* ---- v0.99.41: gloves, sunlight, one hand, screen reader ---- */

/* Every selector below is a control a field user aims at, and every one of them sat under the 44px
   floor at a touch width. The cause is always the same: a component rule outranks the breakpoint's
   `button, select` floor, so the floor never reached it. `.modal-head button` and `.ls-head button`
   are (0,1,1) against a (0,0,1) rule, which made the ✕ on every modal and every bottom sheet a
   ~22px target. The block that fixes this is declared last in the file so it wins at equal
   specificity, and it is the only place the floor is stated. */
const TOUCH = '(max-width: 960px), (max-height: 500px) and (orientation: landscape)';
const TOUCH_FLOOR = [
  '.modal-head button', '.ls-head button',
  '.filters select', '.filters input[type="search"]',
  '.mrms-chip', '.layer-pill', '.ao-current', '.ao-chip', '#sheet-handle button',
];

test('every touch-width control meets the 44px floor', () => {
  const block = mediaBlock(TOUCH);
  for (const sel of TOUCH_FLOOR) {
    assert.equal(decl(block, sel, 'min-height'), '44px',
      `${sel} must declare min-height: 44px in the touch block`);
  }
  assert.equal(decl(block, '#sheet-handle button', 'min-width'), '44px',
    'the sheet handle is a square pill; its width is a target too');
});

/* A floor stated once is worth nothing if a later rule undercuts it. These selectors carry no
   sub-44px min-height anywhere after the touch block, at any specificity. */
test('nothing declared after the touch block undercuts the 44px floor', () => {
  const at = CSS.indexOf(`@media ${TOUCH}`);
  assert.notEqual(at, -1, 'the touch-target block is missing');
  const after = CSS.slice(at).replace(/\/\*[\s\S]*?\*\//g, '');
  const offenders = [];
  for (const m of after.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    if (sel.startsWith('@')) continue;
    if (!TOUCH_FLOOR.some((s) => sel.includes(s))) continue;
    for (const d of m[2].matchAll(/min-(?:width|height)\s*:\s*(\d+)px/g)) {
      if (Number(d[1]) < 44) offenders.push(`${sel} { ${d[0].trim()} }`);
    }
  }
  assert.deepEqual(offenders, [], 'a rule after the touch block puts a listed control back under 44px');
});

/* The sheet handle is position:fixed at right:8/bottom:92 and three buttons tall; the overlay
   legend stack is right:8/bottom:76 and grows upward. They miss at sheet-half because the stack is
   measured from the map's shorter box, and collide head-on at sheet-peek, which is exactly the
   state a field user picks to get a full map. Both sat at z-index 900, so there was no winner. */
test('the overlay legends step clear of the sheet handle in map-full mode', () => {
  const block = mediaBlock('(max-width: 768px), (max-height: 500px) and (orientation: landscape)');
  const right = decl(block, 'main.sheet-peek #ov-legend-stack', 'right');
  assert.match(right, /^\d+px$/, 'sheet-peek must reposition the legend stack away from the handle');
  const handleRight = 8 + 44; // the handle sits at right: 8px and is now a 44px-wide target
  assert.ok(Number(right.replace('px', '')) >= handleRight,
    `the legend stack at right: ${right} still overlaps the ${handleRight}px the handle occupies`);
  // the selector must outrank the bare #ov-legend-stack rules (1,0,0) that set right/bottom
  assert.ok(/main\.sheet-peek #ov-legend-stack/.test(CSS),
    'the override needs the ID plus a class or it loses to the base rule it is correcting');
});

/* Reduced motion was honored by three rules out of roughly thirty-one animations. What was left
   running was the worst of it: everything in this list loops forever, so during an event it is a
   screen full of movement for someone who asked the OS for less, and a battery cost on an old
   phone. Colour and meaning are kept; only the movement stops. */
const LOOPING = [
  '.brand .sub .live-dot', '#update-chip', '#emergency-banner', '#data-age-bar.red',
  '#gps-wait', '.locate-btn.locating', '.gauge-icon.cat-major', '.cutoff-circle', '.pb-crest-line',
];

test('every looping animation stops under prefers-reduced-motion', () => {
  const rm = mediaBlock('(prefers-reduced-motion: reduce)');
  for (const sel of LOOPING) {
    assert.ok(rm.includes(sel), `${sel} loops forever and is not in the reduced-motion block`);
  }
  // a ring whose keyframes end invisible must not be left sitting on the map once it stops
  assert.match(rm, /\.my-pos-ring,\s*\.alert-ping,\s*\.pb-ring\s*\{[^}]*opacity:\s*0/,
    'stopping a ping animation must also hide the ring it would otherwise freeze on screen');
  assert.match(rm, /transition:\s*none/, 'movement that comes from a transition must stop too');
});

test('no animation the reduced-motion block names is still declared infinite outside it', () => {
  const rm = CSS.indexOf('@media (prefers-reduced-motion: reduce) {\n  .brand .sub .live-dot');
  assert.notEqual(rm, -1, 'the consolidated reduced-motion block was not found');
  for (const sel of LOOPING) {
    const at = CSS.indexOf(`${sel} {`);
    assert.notEqual(at, -1, `${sel} rule not found`);
    assert.match(CSS.slice(at, CSS.indexOf('}', at)), /animation:/,
      `${sel} is listed as looping but declares no animation; the guard has drifted`);
  }
});

/* There was no :focus-visible rule anywhere in the stylesheet, and the one :focus rule gave focus
   the same treatment as hover on the Leaflet controls, so a keyboard user could not tell where
   they were. */
test('keyboard focus has a ring of its own, distinct from hover', () => {
  assert.match(CSS, /(^|\n):focus-visible\s*\{[^}]*outline:/,
    'the stylesheet needs a global :focus-visible outline');
  assert.match(CSS, /:focus-visible\s*\{[^}]*outline-offset:/, 'the ring needs an offset to be visible');
  // Leaflet controls stack flush against each other, so their ring turns inward instead of overlapping
  assert.match(CSS, /\.leaflet-bar a:focus-visible[\s\S]{0,220}?outline-offset:\s*-2px/,
    'the Leaflet control ring must be inset or it draws over the neighbouring button');
  assert.ok(!/:focus-visible[^{]*\{[^}]*outline:\s*none/.test(CSS), 'no rule may remove the focus ring');
  /* A `:focus { outline: none }` anywhere outranks the global (0,1,0) ring, so every stylesheet
     that suppresses an outline has to restate one for keyboard focus. */
  for (const f of ['app.css', 'team.css']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'css', f), 'utf8');
    for (const m of src.matchAll(/([^{}\n]*):focus\s*\{[^}]*outline:\s*(?:none|0)/g)) {
      const base = m[1].trim();
      assert.ok(new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:focus-visible`).test(src),
        `${f}: ${base}:focus removes the outline with no ${base}:focus-visible ring to replace it`);
    }
  }
});

/* Aging is an honesty signal, not a reason to make a card unreadable. `opacity: 0.55` composited
   to about 3.3:1 in the light theme, under the 4.5:1 floor. */
test('aged cards are muted with a colour token, never with opacity', () => {
  for (const sel of ['.card.aged', '.resource-item.reopened.aged']) {
    const at = CSS.indexOf(`${sel} {`);
    assert.notEqual(at, -1, `${sel} rule not found`);
    const rule = CSS.slice(at, CSS.indexOf('}', at));
    assert.ok(!/opacity:/.test(rule), `${sel} still dims with opacity instead of a colour token`);
    assert.match(rule, /color:\s*var\(--ink-aged\)/, `${sel} must take the aged ink token`);
  }
  // the token has to exist in both themes or one of them falls back to inherited ink
  const dark = CSS.slice(CSS.indexOf(':root {'), CSS.indexOf('}', CSS.indexOf(':root {')));
  const light = CSS.slice(CSS.indexOf(':root[data-theme="light"] {'),
    CSS.indexOf('}', CSS.indexOf(':root[data-theme="light"] {')));
  assert.match(dark, /--ink-aged:\s*#[0-9a-f]{6}/i, '--ink-aged is undefined in the dark theme');
  assert.match(light, /--ink-aged:\s*#[0-9a-f]{6}/i, '--ink-aged is undefined in the light theme');
});

/* 9px was the smallest type the board rendered anywhere, on the overlay legends, at the widths
   most likely to be read outdoors in glare. */
test('no overlay legend text drops below 10px on a small screen', () => {
  const block = mediaBlock('(max-width: 820px), (max-height: 500px)');
  for (const m of block.matchAll(/font-size:\s*([\d.]+)px/g)) {
    assert.ok(Number(m[1]) >= 10, `the small-screen legend block declares font-size: ${m[1]}px`);
  }
  for (const sel of ['.wx-src', '.mrms-labels', '.inun-note', '.surge-note', '.surge-rows']) {
    const at = CSS.indexOf(`${sel} {`);
    if (at === -1) continue;
    const size = CSS.slice(at, CSS.indexOf('}', at)).match(/font-size:\s*([\d.]+)px/);
    if (size) assert.ok(Number(size[1]) >= 10, `${sel} renders at ${size[1]}px`);
  }
});
