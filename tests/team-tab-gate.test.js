'use strict';

/* The Team tab's entry point is gated, not its capability. A resident checking whether their
   house is at risk should not be offered "create or join an operations team" in the primary tab
   bar; anyone who holds a team link, is already in a team, asked via ?tab=team or the Settings
   entry, or is on the LAN operator build still gets it. These tests pin both halves: the tab is
   withheld by default, and every documented route back still reveals it. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSandbox } = require('./harness.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// core.js + team.js in one context, with a tab button whose `hidden` writes are observable
function loadTeam(search) {
  const sandbox = buildSandbox();
  sandbox.location.search = search;
  const tabBtn = { hidden: false, click() { this.clicked = true; }, clicked: false };
  const tabsEl = { querySelector: () => tabBtn, prepend() {}, insertBefore() {}, appendChild() {} };
  sandbox.document.querySelector = (sel) => {
    if (sel === '.tabs button[data-tab="tab-team"]') return tabBtn;
    if (sel === '.tabs') return tabsEl;
    return null;
  };
  sandbox.document.getElementById = () => null;
  const context = vm.createContext(sandbox);
  vm.runInContext(`${read('js/core.js')}\n;\n${read('js/team.js')}`, context, { filename: 'team-bundle.js' });
  return { sandbox, tabBtn };
}

test('an unaffiliated visitor is not offered the Team tab', () => {
  const { sandbox, tabBtn } = loadTeam('');
  assert.equal(sandbox.teamTabAllowed(), false);
  sandbox.initTeamTab();
  assert.equal(tabBtn.hidden, true, 'the Team tab button must start hidden on a plain visit');
});

test('a team link, ?tab=team, or the Settings entry each reveal the tab', () => {
  for (const search of ['?team=00000000-0000-4000-8000-000000000000', '?team=new', '?tab=team']) {
    const { sandbox, tabBtn } = loadTeam(search);
    assert.equal(sandbox.teamTabAllowed(), true, `${search} must allow the tab`);
    sandbox.initTeamTab();
    assert.equal(tabBtn.hidden, false, `${search} must reveal the tab button`);
  }

  const settings = loadTeam('');
  settings.sandbox.showTeamTab(); // what the Settings "Live team" entry invokes
  assert.equal(settings.tabBtn.hidden, false, 'the Settings entry must reveal the tab');
  assert.equal(settings.tabBtn.clicked, true, 'the Settings entry must also open the tab');

  const lan = loadTeam('');
  lan.sandbox.revealTeamTab(); // what boot.js calls on a successful /api/ping
  assert.equal(lan.tabBtn.hidden, false, 'the LAN operator build must keep the tab visible');
});

test('an unrelated tab deep-link does not reveal the Team tab', () => {
  for (const search of ['?tab=roads', '?tab=gauges', '?view=basin&river=guadalupe']) {
    const { sandbox } = loadTeam(search);
    assert.equal(sandbox.teamTabAllowed(), false, `${search} must not open the team surface`);
  }
});

test('index.html ships the Team tab hidden and the Settings entry that reveals it', () => {
  const html = read('index.html');
  assert.match(html, /<button data-tab="tab-team" hidden>/,
    'the Team tab button must carry hidden in the shipped markup');
  assert.match(html, /id="team-open-btn"/, 'Settings must keep a route into the team surface');
  // the .tabs rule sets display:inline-flex, which beats the UA [hidden] rule
  assert.match(read('css/app.css'), /\.tabs button\[hidden\]\s*\{\s*display:\s*none/,
    'a hidden tab button needs an explicit display:none or the flex rule keeps showing it');
});

test('the intake form is refused wherever no LAN write endpoint answers', () => {
  const html = read('index.html');
  assert.match(html, /id="toggle-form" hidden/, 'the intake entry point stays hidden by default');
  const boot = read('js/boot.js');
  assert.match(boot, /withdrawIntake/, 'boot.js must withdraw the intake form without a LAN backend');
  assert.match(read('js/board.js'), /if \(!state\.lanIntake\) \{ intakeToast\(t\('intake\.nolan'\)\); return; \}/,
    'submitRequest must refuse rather than bank a notice that reaches nobody');
});
