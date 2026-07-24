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

const CSS = fs.readFileSync(path.join(__dirname, '..', 'css', 'app.css'), 'utf8');

// pull one @media block out by its condition text, brace-counting so nested blocks survive
function mediaBlock(condition) {
  const at = CSS.indexOf(`@media ${condition}`);
  assert.notEqual(at, -1, `no @media ${condition} block in css/app.css`);
  const open = CSS.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === '{') depth += 1;
    else if (CSS[i] === '}') {
      depth -= 1;
      if (depth === 0) return CSS.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces after @media ${condition}`);
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

test('the header status has exactly one writer, so no call site can uncap it', () => {
  const files = ['boot', 'map', 'sources', 'playback', 'panels', 'board', 'team'];
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', `${f}.js`), 'utf8');
    for (const m of src.matchAll(/\$\('#refresh-note'\)\s*\.\s*(textContent|innerHTML)\s*=/g)) {
      offenders.push(`js/${f}.js: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [],
    'assign the header status through setFeedNote()/setFeedNoteHealthy(); a raw write is what broke the header');
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
