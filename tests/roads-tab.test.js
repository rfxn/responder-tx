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
  const fn = panels.match(/function renderRoadsTab\(\)[\s\S]*?\n\}/);
  assert.ok(fn && /#roads-count/.test(fn[0]), 'renderRoadsTab must keep the Roads badge current');
  assert.match(fn[0], /badge\.textContent = String\(live\.length\)/, 'the badge counts the tab\'s live rows');
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
  const count = panels.match(/function openShelterCount\(\)[\s\S]*?\n\}/);
  assert.ok(count, 'openShelterCount() not found');
  // v0.98.0 asserted `=== 'open'` appears here, which the `!sh.live ||` short-circuit satisfied
  // while counting every curated entry regardless of status. Assert the reading, not its spelling.
  assert.match(count[0], /shelterOpen\(sh\)/, 'both paths must read status through shelterOpen()');
  assert.ok(!/!sh\.live \|\|/.test(count[0]),
    'the !sh.live short-circuit counted curated entries whatever their status');
  assert.match(count[0], /curatedSheltersStale/, 'the curated list must be aged against its own stamp');
  assert.match(count[0], /mergeShelters/, 'the chip must count the same merged list the sheet renders');
  assert.ok(!/fetch\(/.test(count[0]), 'the chip must not introduce a new fetch');
  // shelters are help, not a hazard: the count must never sit in the hazard surfaces at all
  const strip = panels.match(/function renderThreatStrip\(\)[\s\S]*?\n\}/);
  assert.ok(!/[Ss]helter/.test(strip[0]),
    'the shelter count must stay out of the threat strip, which now carries only the all-clear');
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

/* ---------- crossing staleness (v0.99.4) ---------- */
/* #roads-count summed every non-open crossing with no aging gate, sitting beside Alerts and Gauges
   counts that both suppress a sensor they cannot vouch for. data/crossings.json was eight days old
   and the badge read 5. Per-row staleness already existed; the badge made the claim before the
   qualification was reachable. */

const { loadApp } = require('./harness.js');
const { crossingStale, crossingAgeH, CROSSING_STALE_H } = loadApp();

const xAgo = (h, status) => ({ status: status || 'closed', updated_at: new Date(Date.now() - h * 3600000).toISOString() });
const roadsBadgeCount = (list) => list.filter((c) => c.status !== 'open').filter((c) => !crossingStale(c)).length;

test('crossingStale — the window is the same CROSSING_STALE_H the row note already used', () => {
  assert.equal(CROSSING_STALE_H, 12);
  assert.equal(crossingStale(xAgo(CROSSING_STALE_H - 1)), false);
  assert.equal(crossingStale(xAgo(CROSSING_STALE_H + 1)), true);
});

test('crossingAgeH — a crossing with no updated_at can never be vouched for', () => {
  assert.equal(crossingAgeH({ status: 'closed' }), Infinity);
  assert.equal(crossingStale({ status: 'closed' }), true);
  assert.equal(crossingAgeH({ status: 'closed', updated_at: 'not-a-date' }), Infinity);
});

test('the Roads badge counts only closures the board can still vouch for', () => {
  const list = [xAgo(1), xAgo(2, 'caution'), xAgo(200), xAgo(200, 'longterm'), xAgo(1, 'open')];
  assert.equal(list.filter((c) => c.status !== 'open').length, 4, 'four non-open crossings in the fixture');
  assert.equal(roadsBadgeCount(list), 2, 'the two unconfirmed ones must not inflate the badge');
});

test('an all-stale crossing file yields a badge of zero, and the rows still exist to explain it', () => {
  const list = [xAgo(190), xAgo(200, 'caution')];
  assert.equal(roadsBadgeCount(list), 0);
  assert.equal(list.filter(crossingStale).length, 2, 'nothing is dropped from the list itself');
});

test('the Roads tab surfaces the suppressed count instead of letting it vanish', () => {
  const panels = read('js/panels.js');
  const fn = panels.match(/function renderRoadsTab\(\)[\s\S]*?\n\}/);
  assert.ok(fn, 'renderRoadsTab() not found');
  assert.match(fn[0], /t\('cross\.unconfirmed'\)/, 'the panel must say how many were excluded');
  const cross = panels.match(/function renderCrossings\(\)[\s\S]*?\n\}/);
  assert.match(cross[0], /crossing-icon\$\{stale \? ' unconfirmed' : ''\}/,
    'a stale crossing marker must be visually distinct from a current one');
  for (const lang of ['en', 'es']) {
    assert.ok(I18N[lang]['cross.unconfirmed'], `${lang} missing cross.unconfirmed`);
    assert.ok(I18N[lang]['cross.unconfirmed'].includes('{n}'), `${lang} cross.unconfirmed lost its count placeholder`);
  }
  const css = read('css/app.css');
  assert.match(css, /\.crossing-icon\.unconfirmed \{/, 'the unconfirmed marker style is missing');
});

/* ---------- the Roads tab answers the road question (v0.99.39) ----------
   Live TxDOT conditions rendered only to a Leaflet layer and jurisdiction reports only to a
   second, off-by-default one, so a tab named Roads could read a low single digit while dozens of
   road hazards were live. All three provenances now list in the tab, each naming its operator,
   and the badge counts what the tab shows as live. */

const app = loadApp();
const SB = app._sandbox;
const ST = app.state; // `state` is a lexical const in core.js, reachable only through the export
const { roadsTabRows, roadsRowHtml } = app;

const iso = (h) => new Date(Date.now() - h * 3600000).toISOString();

function setRoadsState(o) {
  ST.crossings = o.crossings || [];
  ST.crossStatus = o.crossStatus || null;
  ST.roadClosures = o.roadClosures || { lines: [], points: [] };
  ST.myPos = o.myPos || null;
  ST.roadsTabFp = null;
}

const txdotLine = (route, condition, lat, lon) => ({
  type: 'Feature',
  properties: { route_name: route, condition, from_limit: `${route} A`, to_limit: `${route} B`, start_time: iso(3) },
  geometry: { type: 'LineString', coordinates: [[lon, lat], [lon + 0.01, lat + 0.01]] },
});

const FIXTURE = {
  crossings: [
    { name: 'Curated fresh', status: 'closed', lat: 30.1, lon: -97.8, updated_at: iso(2), reason: 'water over road' },
    { name: 'Curated stale', status: 'closed', lat: 30.2, lon: -97.9, updated_at: iso(200), reason: 'washout' },
    { name: 'Curated open', status: 'open', lat: 30.3, lon: -98.0, updated_at: iso(1) },
  ],
  crossStatus: {
    crossings: [
      { name: 'Jurisdiction row', status: 'closed', jurisdiction: 'WCO', address: 'CR 123', lat: 30.4, lon: -98.1, changed: iso(240) },
    ],
  },
  roadClosures: { lines: [txdotLine('FM0126', 'Closure', 30.5, -98.2), txdotLine('IH0010', 'Flooding', 30.6, -98.3)], points: [] },
};

test('every provenance reaches the Roads tab, and each row names its own operator', () => {
  setRoadsState(FIXTURE);
  const rows = roadsTabRows();
  assert.equal(rows.length, 5, 'two TxDOT + two non-open curated + one jurisdiction row');
  assert.deepEqual([...new Set(Array.from(rows, (r) => r.kind))].sort(), ['curated', 'txdot', 'xstatus']);

  const byKind = (k) => rows.find((r) => r.kind === k);
  assert.equal(byKind('txdot').op, 'roads.src.txdot', 'a TxDOT row must name TxDOT DriveTexas');
  assert.equal(byKind('curated').op, 'roads.src.curated', 'a curated row must name the board curator');
  assert.equal(byKind('xstatus').op, 'WCO · roads.src.jur', 'a jurisdiction row must name the jurisdiction and the aggregator');
  assert.equal(I18N.en['roads.src.txdot'], 'TxDOT DriveTexas');
  assert.equal(I18N.en['roads.src.jur'], 'via ATX Floods');

  // each feed's timestamp means a different thing, so each row says which thing it is
  assert.ok(byKind('txdot').whenText.startsWith('road.since'), 'a TxDOT stamp is a start time, not an update');
  assert.ok(byKind('curated').whenText.startsWith('word.updated'), 'a curated stamp is a curator update');
  assert.ok(byKind('xstatus').whenText.startsWith('xstatus.changed'), 'a jurisdiction stamp is a record change');

  // three operator strings, three provenance badges, all visible in the rendered row
  const html = rows.map(roadsRowHtml).join('');
  for (const op of ['roads.src.txdot', 'roads.src.curated', 'roads.src.jur']) {
    assert.ok(html.includes(op), `the rendered rows lost the ${op} label`);
  }
  assert.ok(/badge src-official/.test(html) && /badge src-curated/.test(html),
    'official and curated provenance badges must both render');
});

test('the Roads badge equals the rows the tab renders as live, and nothing unconfirmed inflates it', () => {
  setRoadsState({ ...FIXTURE, myPos: { lat: 30.2, lng: -97.9 } });
  const el = { innerHTML: '', querySelectorAll: () => [] };
  const badge = { textContent: '' };
  const prev = SB.document.querySelector;
  SB.document.querySelector = (s) => (s === '#crossings-body' ? el : s === '#roads-count' ? badge : prev(s));
  try { SB.renderRoadsTab(); } finally { SB.document.querySelector = prev; }

  const rendered = (el.innerHTML.match(/class="resource-item road-row/g) || []).length;
  const unconfirmed = (el.innerHTML.match(/class="resource-item road-row unconfirmed/g) || []).length;
  assert.equal(rendered, 5, 'the tab renders every hazard row it holds');
  assert.equal(+badge.textContent, rendered - unconfirmed, 'the badge is the live rows the tab renders');
  assert.equal(+badge.textContent, 3, 'two TxDOT conditions plus the one confirmable curated closure');
  assert.equal(unconfirmed, 2, 'the stale curated row and the jurisdiction row are listed, not counted');
  assert.ok(el.innerHTML.includes('cross.unconfirmed'), 'the tab must say how many rows it is not counting');

  // one distance-ordered list, not one group per feed: the fix sits on the stale curated crossing,
  // so that row leads even though it is the one row the badge does not count
  const order = [...el.innerHTML.matchAll(/class="resource-item road-row( unconfirmed)?"/g)].map((m) => !m[1]);
  assert.deepEqual(order, Array.from(roadsTabRows(), (r) => r.live), 'the rendered order must be the sorted order');
  assert.equal(order[0], false, 'a nearby unconfirmed closure must not be exiled below distant live rows');
});

test('a stale curated crossing stays listed and stays out of the count', () => {
  setRoadsState({ crossings: FIXTURE.crossings });
  const rows = roadsTabRows();
  const stale = rows.find((r) => r.name === 'Curated stale');
  assert.ok(stale, 'the stale row must still be listed');
  assert.equal(stale.live, false, 'a stale curated closure is not a live closure');
  assert.equal(rows.filter((r) => r.live).length, 1, 'only the fresh curated closure counts');
  assert.ok(!rows.some((r) => r.name === 'Curated open'), 'an open crossing is not a road hazard');
  assert.ok(roadsRowHtml(stale).includes('cross.stale'), 'the stale row must show how old its report is');
});

test('a jurisdiction row keeps saying its stamp is a record change, never a confirmation', () => {
  setRoadsState({ crossStatus: FIXTURE.crossStatus });
  const [row] = roadsTabRows();
  assert.equal(row.live, false, 'a jurisdiction report can never be counted as a live closure');
  assert.equal(row.age, 'xstatus.old', 'an old report must say how long it has been unchanged');
  assert.match(roadsRowHtml(row), /xg-stale/, 'the qualification must render, not just exist on the row');
  assert.ok(row.whenText.startsWith('xstatus.changed'), 'the row stamps a record change, not an update');
  assert.ok(!/word\.updated/.test(roadsRowHtml(row)), 'a jurisdiction row must never claim it was updated');

  // a report changed inside the window still carries the no-recheck qualifier, because the feed
  // publishes a change time and never a confirmation time
  setRoadsState({ crossStatus: { crossings: [{ name: 'Fresh report', status: 'closed', jurisdiction: 'WCO', lat: 30.4, lon: -98.1, changed: iso(3) }] } });
  const [fresh] = roadsTabRows();
  assert.equal(fresh.live, false);
  assert.equal(fresh.age, 'xstatus.nocheck');
  for (const lang of ['en', 'es']) {
    assert.ok(/change|cambi/i.test(I18N[lang]['xstatus.changed']), `${lang} xstatus.changed must describe a record change`);
  }
});

test('the tab sorts nearest-first with a fix and newest-first without one', () => {
  setRoadsState(FIXTURE);
  const newestFirst = roadsTabRows();
  // Array.from re-homes the vm-realm array so deepEqual's prototype check passes
  const stamps = Array.from(newestFirst, (r) => Date.parse(r.when) || 0);
  assert.deepEqual(stamps, [...stamps].sort((a, b) => b - a), 'with no fix the newest report leads');

  setRoadsState({ ...FIXTURE, myPos: { lat: 30.4, lng: -98.1 } });
  const nearestFirst = roadsTabRows();
  const dists = Array.from(nearestFirst, (r) => r.dist);
  assert.deepEqual(dists, [...dists].sort((a, b) => a - b), 'with a fix the nearest hazard leads');
  assert.equal(nearestFirst[0].kind, 'xstatus', 'the fix sits on the jurisdiction row, so it leads');
  assert.ok(nearestFirst.every((r) => Number.isFinite(r.dist)), 'every mapped row gets a distance');
});

test('a row with no coordinates is still listed, it just cannot be focused', () => {
  setRoadsState({ crossings: [{ name: 'No fix', status: 'closed', updated_at: iso(1) }], myPos: { lat: 30, lng: -98 } });
  const [row] = roadsTabRows();
  assert.equal(row.live, true, 'a missing coordinate does not make a fresh closure unconfirmable');
  assert.equal(row.dist, Infinity, 'an unmappable row sorts to the tail');
  assert.ok(!roadsRowHtml(row).includes('data-lat'), 'an unmappable row must not claim a map target');
  assert.ok(roadsRowHtml(row).includes('road-row'), 'it is still a row');
});

test('tapping a Roads row focuses it on the map the way the reopened rows do', () => {
  const panels = read('js/panels.js');
  const fn = panels.match(/function renderRoadsTab\(\)[\s\S]*?\n\}/)[0];
  assert.match(fn, /querySelectorAll\('\.road-row\[data-lat\]'\)/, 'mapped rows must be wired for focus');
  assert.match(fn, /state\.map\.setView\(\[\+d\.dataset\.lat, \+d\.dataset\.lon\]/, 'a tap must focus the row on the map');
  assert.match(fn, /if \(ev\.target\.closest\('a'\)\) return;/, 'the source link must not hijack the row tap');
  // and the block v0.99.36 fixed is untouched: reopened roads still render into their own sibling host
  assert.match(panels, /el\.id = 'reopened-roads'/, 'the reopened-roads host must survive');
  assert.match(panels, /function renderCrossings\(\)[\s\S]*?renderReopenedRoads\(\);/, 'reopenings still render with the crossings');
});

test('the empty tab says so instead of rendering nothing at all', () => {
  setRoadsState({});
  assert.equal(roadsTabRows().length, 0);
  for (const k of ['roads.live.title', 'roads.none', 'roads.src.txdot', 'roads.src.curated', 'roads.src.jur']) {
    for (const lang of ['en', 'es']) {
      assert.ok(typeof I18N[lang][k] === 'string' && I18N[lang][k].length, `${lang} missing ${k}`);
      assert.ok(!I18N[lang][k].includes('—'), `em-dash in ${lang} ${k}`);
    }
  }
  // the proper noun stays a proper noun; everything else is really translated
  for (const k of ['roads.live.title', 'roads.none', 'roads.src.curated', 'roads.src.jur']) {
    assert.notEqual(I18N.en[k], I18N.es[k], `${k} was never actually translated`);
  }
  assert.equal(I18N.en['roads.src.txdot'], I18N.es['roads.src.txdot']);
  assert.match(read('js/panels.js'), /t\('roads\.none'\)/, 'the empty state must render the string');
});

/* ---------- TxGIO crossing inventory paging (v0.99.39) ----------
   Two fixed pages of 2000 capped the layer at 4000 of the 8339 crossings the service holds for
   the AO, with nothing on screen saying the layer was partial. */

test('lwcHasMore reads the service signal wherever the response carries it', () => {
  const { lwcHasMore } = app;
  assert.equal(lwcHasMore({ exceededTransferLimit: true }), true, 'top-level GeoJSON flag');
  assert.equal(lwcHasMore({ properties: { exceededTransferLimit: true } }), true, 'nested ArcGIS flag');
  assert.equal(lwcHasMore({ features: [] }), false, 'no flag means no more records');
  assert.equal(lwcHasMore({ exceededTransferLimit: false, properties: {} }), false);
  assert.equal(lwcHasMore(null), false, 'a missing body must not loop forever');
});

// drive fetchLwc against a scripted service: `total` records served LWC_PAGE at a time
async function runLwc(total, opts) {
  const o = opts || {};
  const urls = [];
  const prevFetch = SB.fetch;
  const prevRender = SB.renderLwc;
  const prevNotice = SB.opNotice;
  let rendered = null;
  const notices = [];
  SB.fetch = (url) => {
    urls.push(String(url));
    const off = +new URL(String(url), 'https://x.test').searchParams.get('resultOffset');
    const n = Math.max(0, Math.min(app.LWC_PAGE, total - off));
    const body = { features: Array.from({ length: n }, (_, i) => ({ id: off + i })) };
    if (off + n < total) body.exceededTransferLimit = true;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  };
  SB.renderLwc = (f) => { rendered = f; };
  SB.opNotice = (m) => notices.push(m);
  ST._lwcLoaded = false;
  ST.lwcPartial = false;
  try { await SB.fetchLwc(); } finally { SB.fetch = prevFetch; SB.renderLwc = prevRender; SB.opNotice = prevNotice; }
  return { urls, rendered, notices, partial: ST.lwcPartial };
}

test('the inventory pages past 4000 and stops when the service reports no more', async () => {
  const r = await runLwc(8339);
  assert.equal(r.urls.length, 5, 'five pages of 2000 cover 8339 records');
  assert.equal(r.rendered.length, 8339, 'every crossing the service holds reaches the layer');
  assert.deepEqual(r.urls.map((u) => +new URL(u, 'https://x.test').searchParams.get('resultOffset')),
    [0, 2000, 4000, 6000, 8000], 'each page asks for the next offset'); // urls is a Node-realm array
  assert.equal(r.partial, false, 'a complete load is not partial');
  assert.deepEqual(r.notices, [], 'a complete load raises no notice');

  // the old two-page shape would have stopped here; prove the loop is driven by the service
  const small = await runLwc(2000);
  assert.equal(small.urls.length, 1, 'one full page with no exceeded flag ends the loop');
  assert.equal(small.rendered.length, 2000);
});

test('a load that hits the ceiling says it is partial instead of under-reporting quietly', async () => {
  const r = await runLwc(app.LWC_PAGE * app.LWC_MAX_PAGES + 1);
  assert.equal(r.urls.length, app.LWC_MAX_PAGES, 'the ceiling stops a runaway loop');
  assert.equal(r.partial, true, 'the layer must know it is incomplete');
  assert.deepEqual(r.notices, ['lwc.partial'], 'and must say so');

  const src = read('js/sources.js');
  assert.match(src, /state\.lwcPartial \? `\$\{LWC_ATTRIB\} · \$\{t\('lwc\.partial'\)\}` : LWC_ATTRIB/,
    'the map attribution must carry the partial claim, not just a dismissable toast');
  assert.match(src, /state\.lwcPartial \? `<div class="popup-meta"><span class="xg-stale">\$\{esc\(t\('lwc\.partial'\)\)\}/,
    'each crossing popup must repeat that the layer is partial');
  for (const lang of ['en', 'es']) {
    assert.ok(I18N[lang]['lwc.partial'] && !I18N[lang]['lwc.partial'].includes('—'), `${lang} lwc.partial`);
  }
  assert.notEqual(I18N.en['lwc.partial'], I18N.es['lwc.partial']);
});

test('a failed page leaves the layer retryable rather than half loaded', async () => {
  const prevFetch = SB.fetch;
  const prevRender = SB.renderLwc;
  let rendered = false;
  SB.renderLwc = () => { rendered = true; };
  SB.fetch = () => Promise.resolve({ ok: false, status: 503 });
  ST._lwcLoaded = false;
  try { await SB.fetchLwc(); } finally { SB.fetch = prevFetch; SB.renderLwc = prevRender; }
  assert.equal(rendered, false, 'nothing may be drawn from a failed page');
  assert.equal(ST._lwcLoaded, false, 'the layer must be retryable on the next toggle');
});
