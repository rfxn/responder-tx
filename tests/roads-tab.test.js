'use strict';

/* Resources dissolved (v0.98.0). It was a junk drawer by construction: the only tab with no count
   badge (no single kind of thing to count), the only one needing a paragraph to explain itself, and
   its reading order put feed-health diagnostics first and shelters at position 6 of 8. Its contents
   were redistributed by who is asking and when, so these tests assert each destination AND the two
   deep-link shims that keep ?tab=monitor and ?tab=resources working. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('index.html').replace(/<!--[\s\S]*?-->/g, '');
const I18N = require('./i18n-load.js');

test('the Resources slot is a Roads tab that counts its own hazard content', () => {
  assert.ok(!/data-tab="tab-resources"/.test(HTML), 'the Resources tab button is still declared');
  assert.ok(!/id="tab-resources"/.test(HTML), 'the Resources tab body is still declared');
  assert.match(HTML, /<button data-tab="tab-roads">/, 'the Roads tab button is missing');
  // it is the only tab that had no count badge; that was the tell, so the replacement carries one
  const tabs = HTML.slice(HTML.indexOf('<div class="tabs">'), HTML.indexOf('</div>', HTML.indexOf('<div class="tabs">')));
  const buttons = [...tabs.matchAll(/<button[^>]*data-tab="([a-z-]+)"[\s\S]*?<\/button>/g)];
  assert.equal(buttons.length, 5, `expected 5 tabs, found ${buttons.length}`);
  for (const b of buttons) {
    assert.ok(/class="count"/.test(b[0]), `${b[1]} has no count badge`);
  }
  const body = HTML.slice(HTML.indexOf('id="tab-roads"'), HTML.indexOf('id="tab-team"'));
  assert.ok(body.includes('id="crossings-body"'), 'low-water crossings must live in Roads');
  assert.ok(!/tab-sub/.test(HTML), 'no tab should need a paragraph to explain what it holds');

  const panels = read('js/panels.js');
  const fn = panels.match(/function renderCrossings\(\)[\s\S]*?\n\}/);
  assert.ok(fn && /#roads-count/.test(fn[0]), 'renderCrossings must keep the Roads badge current');
  assert.match(fn[0], /c\.status !== 'open'/, 'the badge counts crossings that are not open');
  // reopened roads render as a sibling of the crossings host, so they land in Roads with them
  assert.match(panels, /const host = \$\('#crossings-body'\)/, 'reopened roads must anchor to the crossings host');
});

test('a tide is a water-level reading, so it renders in Gauges and is absent inland', () => {
  const gauges = HTML.slice(HTML.indexOf('id="tab-gauges"'), HTML.indexOf('id="tab-roads"'));
  assert.ok(gauges.includes('id="tides-body"'), '#tides-body must live in the Gauges tab');
  assert.equal((HTML.match(/id="tides-body"/g) || []).length, 1);

  const boot = read('js/boot.js');
  assert.ok(/b\.dataset\.tab === 'tab-gauges'\) loadTides\(\)/.test(boot), 'the lazy tide fetch must follow the Gauges tab');
  assert.ok(/\$\('#tab-gauges'\)\.classList\.contains\('active'\)\) loadTides\(\)/.test(boot),
    'the refresh loop must keep tides live off the Gauges tab');
  assert.ok(!/tab-resources/.test(boot), 'js/boot.js still references the dissolved tab');

  // inland event: absent, not an empty host that still carries fetch hooks
  const panels = read('js/panels.js');
  const fn = panels.match(/function renderTides\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'renderTides() not found');
  assert.match(fn[0], /el\.innerHTML = ''; el\.hidden = true; return;/,
    'with no configured stations the tide host must be hidden, not left as an empty div');
  const load = read('js/sources.js').match(/async function loadTides\(\)[\s\S]*?\n\}/);
  assert.match(load[0], /if \(!coopStations\(\)\.length\)/, 'loadTides must not fetch with no stations configured');
});

test('source health is the detail behind the data-age bar, not a content section', () => {
  assert.equal((HTML.match(/id="source-health"/g) || []).length, 1);
  const modal = HTML.slice(HTML.indexOf('id="health-modal"'), HTML.indexOf('id="help-sheet"'));
  assert.ok(modal.includes('id="source-health"'), 'the chip row must live inside #health-modal');

  const boot = read('js/boot.js');
  assert.match(boot, /const openFeedHealth = \(\) => \{ renderSourceHealth\(\); \$\('#health-modal'\)\.hidden = false; \}/,
    'the detail must open in place');
  const bar = boot.match(/\$\('#data-age-bar'\)\.addEventListener\('click'[\s\S]*?\n  \}\);/);
  assert.ok(bar, 'the data-age-bar handler was not found');
  assert.match(bar[0], /openFeedHealth\(\)/, 'tapping the age bar must open the per-source detail');
  assert.match(bar[0], /age-bar-x/, 'the dismiss affordance must still be distinguished from the tap-through');
  assert.ok(!/tabs button\[data-tab=/.test(boot.slice(boot.indexOf('const openFeedHealth'), boot.indexOf('$(\'#help-btn\')'))),
    'opening feed health must not switch tabs');

  // the freshness slot is a permanent entry point now that no tab hosts feed health
  for (const re of [/function setFeedNote\(short, detail\)[\s\S]*?\n\}/, /function setFeedNoteHealthy\(html\)[\s\S]*?\n\}/]) {
    const m = boot.match(re);
    assert.ok(m, `${re} did not match a writer in js/boot.js`);
    assert.match(m[0], /setAttribute\('role', 'button'\)/, 'the writer must leave the slot tappable');
    assert.match(m[0], /setAttribute\('tabindex', '0'\)/, 'the writer must leave the slot keyboard reachable');
  }
});

test('shelters and hotlines are promoted out of position 6 of 8', () => {
  assert.equal((HTML.match(/id="resources-body"/g) || []).length, 1);
  const sheet = HTML.slice(HTML.indexOf('id="help-sheet"'), HTML.indexOf('id="share-sheet"'));
  assert.ok(sheet.includes('id="resources-body"'), 'the one shelter host must live in the help sheet');
  // permanent row in the settings surface, above every display/alert preference
  const menu = HTML.slice(HTML.indexOf('<div id="hmore-menu"'), HTML.indexOf('<div class="refresh-meta">'));
  assert.ok(menu.indexOf('id="shelters-btn"') < menu.indexOf('id="theme-toggle"'),
    'the shelters row must lead the settings sheet, not trail the preferences');

  const panels = read('js/panels.js');
  // count-gated chip in the strip the resident already reads
  assert.match(panels, /const shelterChip = shelters > 0/, 'the chip must be count-gated');
  const count = panels.match(/function openShelterCount\(\)[\s\S]*?\n\}/);
  assert.ok(count, 'openShelterCount() not found');
  assert.match(count[0], /=== 'open'/, 'standby, full, closed and unknown must not read as open');
  assert.match(count[0], /mergeShelters/, 'the chip must count the same merged list the sheet renders');
  assert.ok(!/fetch\(/.test(count[0]), 'the chip must not introduce a new fetch');
  // shelters are help, not a hazard: they must never suppress the all-clear line
  const strip = panels.match(/function renderThreatStrip\(\)[\s\S]*?\n\}/);
  assert.ok(strip[0].indexOf('const shelterChip') > strip[0].indexOf(".filter((c) => c.n > 0)"),
    'the shelter chip must be built after the hazard emptiness test, never inside it');
});

test('the monitor link farm left the client entirely', () => {
  for (const f of ['js/panels.js', 'js/boot.js', 'js/core.js', 'index.html', 'css/app.css']) {
    const src = read(f);
    for (const token of ['renderMonitors', 'monitor-body', 'monitorGroupHtml', 'showMonitors', 'mon-toggle']) {
      assert.ok(!src.includes(token), `${f} still carries ${token}`);
    }
  }
  const res = JSON.parse(read('data/resources.json'));
  assert.ok(!('monitors' in res), 'data/resources.json still ships the monitors block');
  assert.ok(!('comms' in res), 'data/resources.json still ships the comms block');
  for (const k of ['mon.social', 'mon.comms', 'mon.verify', 'tab.resources', 'tab.resources.sub']) {
    for (const lang of ['en', 'es']) assert.ok(!(k in I18N[lang]), `${lang} still carries retired key ${k}`);
  }
});

test('the outbound source and recovery link lists moved to the share surface', () => {
  const sheet = HTML.slice(HTML.indexOf('id="share-sheet"'), HTML.indexOf('id="notes-flyout"'));
  assert.ok(sheet.includes('id="datalinks-body"'), '#datalinks-body must live in the Share surface');
  assert.ok(sheet.includes('data-i18n="res.sources"'), 'the group needs a clear label');
  const panels = read('js/panels.js');
  const fn = panels.match(/function renderResources\(\)[\s\S]*?\n  state\.layers\.shelters\.clearLayers\(\);/);
  assert.ok(fn, 'renderResources() not found');
  assert.match(fn[0], /\$\('#datalinks-body'\)/, 'the link lists must render into their own host');
  assert.ok(!/res\.data|res\.recovery/.test(fn[0].slice(0, fn[0].indexOf("$('#datalinks-body')"))),
    'the shelter host must no longer carry the link lists');
});

/* Deep links are the whole risk of this move. ?tab=resources is in the wild, and ?tab=monitor was
   already shimmed to it, so the alias must resolve transitively rather than one hop. */
test('?tab= and saved views survive both renames, transitively', () => {
  const board = read('js/board.js');
  const table = board.match(/const TAB_ALIASES = \{[^}]*\}/);
  assert.ok(table, 'TAB_ALIASES not found in js/board.js');
  assert.match(table[0], /monitor: 'resources'/, 'the ?tab=monitor shim must survive');
  assert.match(table[0], /resources: 'roads'/, 'the ?tab=resources hop is missing');

  const fn = board.match(/function resolveTabName\(name\)[\s\S]*?\n\}/);
  assert.ok(fn, 'resolveTabName() not found');
  const ctx = { TAB_ALIASES: {} };
  // eslint-disable-next-line no-new-func
  const resolve = new Function(`${table[0]}; ${fn[0]}; return resolveTabName;`)();
  assert.equal(resolve('monitor'), 'roads', 'the two-hop legacy link must land on Roads');
  assert.equal(resolve('resources'), 'roads');
  assert.equal(resolve('roads'), 'roads');
  assert.equal(resolve('gauges'), 'gauges', 'an unaliased tab must pass through untouched');
  assert.equal(resolve(undefined), '', 'a missing tab must not throw');

  assert.match(read('js/boot.js'), /tabParam = resolveTabName\(tabParam\)/, '?tab= must run through the alias table');
  const restore = board.match(/function restoreViewState\(\)[\s\S]*?\n\}/);
  assert.match(restore[0], /resolveTabName\(vtab\.slice\(4\)\)/, 'a saved view must run through the same table');
  // and both former call sites moved with the tab
  assert.match(read('js/team.js'), /button\[data-tab="tab-roads"\]/, 'the team tab-order anchor did not move');
});

test('i18n: every string this release introduced exists in both languages', () => {
  const keys = ['tab.roads', 'threat.shelters', 'set.g.public', 'set.shelters', 'set.shelters.title',
    'help.sheet.title', 'health.sub', 'res.sources', 'moved.resources'];
  for (const k of keys) {
    for (const lang of ['en', 'es']) {
      assert.ok(typeof I18N[lang][k] === 'string' && I18N[lang][k].length, `${lang} missing ${k}`);
      assert.ok(!I18N[lang][k].includes('—'), `em-dash in ${lang} ${k}`);
    }
    assert.notEqual(I18N.en[k], I18N.es[k], `${k} was never actually translated`);
  }
});
