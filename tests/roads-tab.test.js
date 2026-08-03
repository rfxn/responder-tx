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
  assert.match(fn[0], /badge\.textContent = badgeText\(live\.length, roadsKnown\)/,
    'the badge counts the tab\'s live rows, and says "?" rather than zero when a feed never answered');
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
  assert.match(cross[0], /crossing-icon\$\{c\.stale \? ' unconfirmed' : ''\}/,
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
  ST.roadsFallbackAt = o.roadsFallbackAt || null;
  ST.roadsUnknown = o.roadsUnknown === true;
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
  assert.match(fn, /ev\.target\.closest\('a'\)/, 'the source link must not hijack the row tap');
  assert.match(fn, /ev\.target\.closest\('\.watch-star'\)/, 'nor may the watch star, which sits inside the row');
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
  // "none" is only reachable when BOTH feeds were actually read: a TxDOT outage and an unreadable
  // crossing list each get their own empty state naming the feed that failed
  assert.match(read('js/panels.js'),
    /t\(state\.roadsUnknown \? 'roads\.unknown' : state\.crossingsUnknown \? 'roads\.xunknown'\s*\n?\s*: state\.crossStatusUnknown \? 'roads\.jurunknown'\s*\n?\s*: crossUncovered\(\) \? 'roads\.nocross' : 'roads\.none'\)/,
    'the empty state must render the string, and only claim "none" when all three feeds were read AND the area is inside crossing coverage');
  for (const lang of ['en', 'es']) {
    const s = I18N[lang]['roads.xunknown'];
    assert.ok(typeof s === 'string' && s.length, `${lang} missing roads.xunknown`);
    assert.ok(!s.includes('—'), `em-dash in ${lang} roads.xunknown`);
  }
  assert.notEqual(I18N.en['roads.xunknown'], I18N.es['roads.xunknown'], 'roads.xunknown was never translated');
  // the unknown states must refuse the reading the "none" state invites
  assert.match(I18N.en['roads.xunknown'], /not a report that crossings are clear/i);
});

/* ---------- TxGIO crossing inventory paging (v0.99.39) ----------
   Two fixed pages of 2000 capped the layer at 4000 of the 8339 crossings the service holds for
   the AO, with nothing on screen saying the layer was partial. */

test('arcgisHasMore reads the service signal wherever the response carries it', () => {
  const { arcgisHasMore } = app;
  assert.equal(arcgisHasMore({ exceededTransferLimit: true }), true, 'top-level GeoJSON flag');
  assert.equal(arcgisHasMore({ properties: { exceededTransferLimit: true } }), true, 'nested ArcGIS flag');
  assert.equal(arcgisHasMore({ features: [] }), false, 'no flag means no more records');
  assert.equal(arcgisHasMore({ exceededTransferLimit: false, properties: {} }), false);
  assert.equal(arcgisHasMore(null), false, 'a missing body must not loop forever');
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

/* ---------- DriveTexas closure paging (v0.99.50) ----------
   The closure query was unpaged, so the service's maxRecordCount silently cut the set. Every
   segment past the cut vanished from the map AND from the live set the reopened diff is built
   from, which painted a green "recently reopened" check on roads that were still shut. */

// drive fetchRoadClosures against a scripted service: `total` closures served ROAD_PAGE at a time
async function runRoads(total) {
  const urls = [];
  const notices = [];
  const saved = {};
  for (const k of ['fetch', 'renderRoadClosures', 'renderRoadsTab', 'renderReopenedMap',
    'renderReopenedRoads', 'renderTiles', 'opNotice', 'markHealthy']) saved[k] = SB[k];
  SB.fetch = (url) => {
    urls.push(String(url));
    const off = +new URL(String(url), 'https://x.test').searchParams.get('resultOffset');
    const n = Math.max(0, Math.min(app.ROAD_PAGE, total - off));
    const body = {
      features: Array.from({ length: n }, (_, i) => ({
        properties: { route_name: `FM${off + i}`, from_limit: 'a', to_limit: 'b', condition: 'Flooding' },
        geometry: { type: 'LineString', coordinates: [[-98.5, 29.7], [-98.4, 29.75]] },
      })),
    };
    if (off + n < total) body.exceededTransferLimit = true;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  };
  for (const k of ['renderRoadClosures', 'renderRoadsTab', 'renderReopenedMap', 'renderReopenedRoads',
    'renderTiles', 'markHealthy']) SB[k] = () => {};
  SB.opNotice = (m) => notices.push(m);
  ST.roadsPartial = false;
  try { await SB.fetchRoadClosures(); } finally { Object.assign(SB, saved); }
  return { urls, notices, partial: ST.roadsPartial, lines: ST.roadClosures.lines };
}

test('the closure query pages past maxRecordCount and stops when the service reports no more', async () => {
  ST.roadMemory = null;
  SB.localStorage.clear();
  const r = await runRoads(app.ROAD_PAGE * 2 + 7);
  assert.equal(r.urls.length, 3, 'three pages cover the set');
  assert.equal(r.lines.length, app.ROAD_PAGE * 2 + 7, 'every closure the service holds reaches the map');
  assert.deepEqual(r.urls.map((u) => +new URL(u, 'https://x.test').searchParams.get('resultOffset')),
    [0, app.ROAD_PAGE, app.ROAD_PAGE * 2], 'each page asks for the next offset');
  assert.equal(r.partial, false, 'a complete load is not partial');
  assert.deepEqual(r.notices, [], 'a complete load raises no notice');
});

test('a truncated closure set is declared partial and never diffed into reopenings', async () => {
  ST.roadMemory = null;
  SB.localStorage.clear();
  const r = await runRoads(app.ROAD_PAGE * app.ROAD_MAX_PAGES + 1);
  assert.equal(r.urls.length, app.ROAD_MAX_PAGES, 'the ceiling stops a runaway loop');
  assert.equal(r.partial, true, 'the layer must know it is incomplete');
  assert.deepEqual(r.notices, ['road.partial'], 'and must say so');
  assert.deepEqual(Object.keys(app.roadMemory().seen), [],
    'a truncated set must not seed the memory the reopened diff is built from');

  const src = read('js/sources.js');
  assert.match(src, /state\.roadsPartial \? `\$\{ROAD_ATTRIB\} · \$\{t\('road\.partial'\)\}`/,
    'the map attribution must carry the partial claim, not just a dismissable toast');
  assert.match(read('js/panels.js'), /state\.roadsPartial \? `<div class="rcv-note">\$\{esc\(t\('road\.partial'\)\)\}/,
    'the Roads tab must repeat that the closure list is partial');
  for (const lang of ['en', 'es']) {
    assert.ok(I18N[lang]['road.partial'] && !I18N[lang]['road.partial'].includes('—'), `${lang} road.partial`);
  }
  assert.notEqual(I18N.en['road.partial'], I18N.es['road.partial']);
});

test('a failed page leaves the layer retryable rather than half loaded', async () => {
  const prevFetch = SB.fetch;
  const prevRender = SB.renderLwc;
  const prevNotice = SB.opNotice;
  let rendered = false;
  const notices = [];
  SB.renderLwc = () => { rendered = true; };
  SB.opNotice = (m) => notices.push(m);
  SB.fetch = () => Promise.resolve({ ok: false, status: 503 });
  ST._lwcLoaded = false;
  try { await SB.fetchLwc(); } finally { SB.fetch = prevFetch; SB.renderLwc = prevRender; SB.opNotice = prevNotice; }
  assert.equal(rendered, false, 'nothing may be drawn from a failed page');
  assert.equal(ST._lwcLoaded, false, 'the layer must be retryable on the next toggle');
  assert.deepEqual(notices, ['note.lwcfail'], 'an empty crossings layer must say it failed, not read as no crossings');
});

// TxGIO is ArcGIS: a rejected query arrives as HTTP 200 carrying {"error":...}, which res.ok admits
test('an ArcGIS error body on the crossing query fails the layer instead of drawing zero crossings', async () => {
  const prevFetch = SB.fetch;
  const prevRender = SB.renderLwc;
  const prevNotice = SB.opNotice;
  let rendered = null;
  const notices = [];
  SB.renderLwc = (f) => { rendered = f; };
  SB.opNotice = (m) => notices.push(m);
  SB.fetch = () => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ error: { code: 400, message: '', details: ["'Invalid field: x' parameter is invalid"] } }),
  });
  ST._lwcLoaded = false;
  try { await SB.fetchLwc(); } finally { SB.fetch = prevFetch; SB.renderLwc = prevRender; SB.opNotice = prevNotice; }
  assert.equal(rendered, null, 'an error body must never reach the renderer as an empty crossing set');
  assert.equal(ST._lwcLoaded, false, 'the layer stays retryable');
  assert.deepEqual(notices, ['note.lwcfail'], 'and the operator is told the list is unavailable');
});

/* ---------- DriveTexas outage fallback (v0.99.54) ----------
   Road closures had exactly one source, so a DriveTexas outage emptied the layer entirely. The
   15-minute cycle already commits data/roads-snapshot.json, so the board now serves that when the
   live fetch fails. Everything below exists to keep that fallback honest: it ages on the
   snapshot's own stamp, it is marked as a snapshot, it leaves the live source reading unhealthy,
   it never reaches the reopened diff, and its absence is reported as unknown rather than as zero
   closures. */

const DRIVETEXAS_RE = /arcgis/i;
const SNAPSHOT_RE = /roads-snapshot\.json/;

// live DriveTexas fails; the snapshot endpoint answers with whatever `snap` scripts
async function runRoadsFallback(snap, opts) {
  const o = opts || {};
  const healthy = [];
  const saved = {};
  for (const k of ['fetch', 'renderRoadClosures', 'renderRoadsTab', 'renderReopenedMap',
    'renderReopenedRoads', 'renderTiles', 'opNotice', 'markHealthy']) saved[k] = SB[k];
  for (const k of ['renderRoadClosures', 'renderRoadsTab', 'renderReopenedMap', 'renderReopenedRoads',
    'renderTiles']) SB[k] = () => {};
  SB.opNotice = () => {};
  SB.markHealthy = (s) => healthy.push(s);
  SB.fetch = (url) => {
    const u = String(url);
    if (DRIVETEXAS_RE.test(u)) {
      return o.liveThrows ? Promise.reject(new Error('network down'))
        : Promise.resolve({ ok: false, status: 503 });
    }
    if (SNAPSHOT_RE.test(u)) {
      if (snap === 'missing') return Promise.resolve({ ok: false, status: 404 });
      if (snap === 'throw') return Promise.reject(new Error('offline'));
      if (snap === 'badjson') return Promise.resolve({ ok: true, json: () => Promise.reject(new Error('bad json')) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(snap) });
    }
    return Promise.reject(new Error(`unscripted fetch ${u}`));
  };
  let threw = null;
  try {
    await SB.fetchRoadClosures();
  } catch (e) {
    threw = e;
  } finally {
    Object.assign(SB, saved);
  }
  return { threw, healthy, closures: ST.roadClosures, fallbackAt: ST.roadsFallbackAt, unknown: ST.roadsUnknown };
}

// the harness stubs t() as a key echo, which swallows {n}/{t} substitution; these assertions are
// about the rendered claim, so they run against the real en table
function withEn(fn) {
  const saved = SB.t;
  SB.t = (k) => (typeof I18N.en[k] === 'string' ? I18N.en[k] : k);
  try { return fn(); } finally { SB.t = saved; }
}

const snapshotBody = (ageMin, roads) => ({
  generated: new Date(Date.now() - ageMin * 60000).toISOString(),
  roads: roads || [{ id: 1, cond: 'Flooding', route: 'FM0481', desc: '- Water over roadway', start: iso(3), end: null, v: [29.9, -98.4] }],
});

test('a DriveTexas outage falls back to the committed snapshot instead of an empty layer', async () => {
  ST.roadMemory = null;
  SB.localStorage.clear();
  const r = await runRoadsFallback(snapshotBody(6));
  assert.ok(r.threw, 'the live failure must still propagate to the refresh loop');
  assert.equal(r.closures.points.length, 1, 'the snapshot closure must reach the layer');
  assert.equal(r.closures.lines.length, 0, 'a snapshot carries one vertex, never a line');

  // and the rows actually render, mapped and named
  setRoadsState({ roadClosures: r.closures, roadsFallbackAt: r.fallbackAt });
  const rows = app.roadsTabRows().filter((x) => x.kind === 'txdot');
  assert.equal(rows.length, 1, 'the fallback closure must render as a Roads row');
  assert.equal(rows[0].name, 'FM 481');
  assert.ok(Number.isFinite(rows[0].lat) && Number.isFinite(rows[0].lon),
    'a snapshot vertex must map, or the row is unreachable from the list');
});

test('fallback rows age on the snapshot stamp, not on when the fallback was served', async () => {
  ST.roadMemory = null;
  SB.localStorage.clear();
  const r = await runRoadsFallback(snapshotBody(120));
  setRoadsState({ roadClosures: r.closures, roadsFallbackAt: r.fallbackAt });
  const row = withEn(() => app.roadsTabRows().find((x) => x.kind === 'txdot'));
  const n = Number((row.age.match(/(\d+)/) || [])[1]);
  assert.ok(n >= 118 && n <= 122, `a two-hour-old snapshot must say so, said "${row.age}"`);
  assert.ok(n > 5, 'ageing on fetch time would report a fresh row for two-hour-old data');
  // the stamp the badge is built from is the snapshot's, so it keeps ageing without a new fetch
  assert.equal(r.fallbackAt, Date.parse(r.closures.points[0].properties._snapshotAt));
});

test('fallback rows are marked as a snapshot and stay out of the live Roads count', async () => {
  ST.roadMemory = null;
  SB.localStorage.clear();
  const r = await runRoadsFallback(snapshotBody(9));
  setRoadsState({ roadClosures: r.closures, roadsFallbackAt: r.fallbackAt });
  const row = withEn(() => app.roadsTabRows().find((x) => x.kind === 'txdot'));
  assert.equal(row.live, false, 'a snapshot row is not a current confirmation');
  assert.equal(row.op, I18N.en['roads.src.snapshot'], 'the row must name the snapshot as its provenance');
  assert.ok(row.age, 'the row must carry a staleness chip');
  assert.match(app.roadsRowHtml(row), /unconfirmed/, 'it must take the unconfirmed treatment the board already uses');
  // the popup makes the same claim on the map, not just in the list
  const html = app.roadPopupHtml(r.closures.points[0].properties);
  assert.match(html, /road\.snapshot/, 'the popup must say the data is a snapshot');
  assert.ok(!/road\.live/.test(html), 'a snapshot popup must never claim live conditions');

  for (const k of ['roads.src.snapshot', 'roads.snapshot.age', 'roads.snapshot.note', 'roads.snapshot.sub',
    'road.snapshot', 'roads.unknown', 'roads.unknown.note']) {
    for (const lang of ['en', 'es']) {
      assert.ok(typeof I18N[lang][k] === 'string' && I18N[lang][k].length, `${lang} missing ${k}`);
      assert.ok(!I18N[lang][k].includes('—'), `em-dash in ${lang} ${k}`);
    }
    assert.notEqual(I18N.en[k], I18N.es[k], `${k} was never actually translated`);
  }
  assert.match(read('js/panels.js'), /roads\.snapshot\.note/, 'the Roads tab must head the list with the snapshot claim');
});

test('a served fallback never paints the live closure source healthy', async () => {
  ST.roadMemory = null;
  SB.localStorage.clear();
  const r = await runRoadsFallback(snapshotBody(4));
  assert.ok(!r.healthy.includes('roads'),
    'marking roads healthy off a snapshot would hide the outage the way the USGS silence was hidden');
  assert.ok(r.threw, 'fetchRoadClosures must reject so the refresh loop counts roads among the failed sources');

  // the rejection is what puts roads in the degraded list, so that wiring must stay
  const boot = read('js/boot.js');
  assert.match(boot, /REFRESH_SOURCE_KEYS = \[[^\]]*'health\.roads'/, 'roads must stay named in the degraded detail');
  assert.match(read('js/sources.js'), /await hydrateRoadsSnapshot\(\);\s*\n\s*throw e;/,
    'the fallback must render and then re-throw, never swallow the live failure');
});

test('snapshot closures never enter the reopened diff', async () => {
  ST.roadMemory = null;
  SB.localStorage.clear();
  // a good live round first, so the memory holds real closures the diff could "reopen"
  await runRoads(3);
  const seeded = Object.keys(app.roadMemory().seen);
  assert.equal(seeded.length, 3, 'the live round must seed the memory');
  assert.equal(app.reopenedRoads().fresh.length, 0, 'nothing has reopened yet');

  // now DriveTexas dies and the snapshot serves a completely different set of roads
  const r = await runRoadsFallback(snapshotBody(11,
    [{ id: 9, cond: 'Closure', route: 'SH0071', desc: 'x', start: iso(2), end: null, v: [30.2, -97.9] }]));
  assert.ok(r.threw);
  assert.equal(app.reopenedRoads().fresh.length, 0,
    'a snapshot that omits a live closure must not manufacture a reopening');
  assert.equal(app.reopenedRoads().aged.length, 0);
  assert.deepEqual(Object.keys(app.roadMemory().seen).sort(), seeded.sort(),
    'the remembered live set must survive the outage untouched');

  // the guard is on the data, not on the call site, so a future caller cannot route around it
  const tainted = r.closures.points;
  assert.ok(tainted.length && tainted.every((f) => f._snapshot === true), 'snapshot features must be tainted');
  app.updateRoadMemory(tainted, false);
  assert.equal(app.reopenedRoads().fresh.length, 0,
    'calling updateRoadMemory directly with snapshot features must still be refused');
  assert.deepEqual(Object.keys(app.roadMemory().seen).sort(), seeded.sort(),
    'and must not rewrite the remembered set either');
});

test('a missing or unreadable snapshot is reported as unknown, never as zero closures', async () => {
  for (const bad of ['missing', 'throw', 'badjson', { roads: [] }, { generated: 'not-a-date', roads: [] },
    { generated: new Date().toISOString() }]) {
    ST.roadMemory = null;
    SB.localStorage.clear();
    ST.roadClosures = { lines: [], points: [] };
    const label = typeof bad === 'string' ? bad : JSON.stringify(bad);
    const r = await runRoadsFallback(bad);
    assert.ok(r.threw, `${label}: the live failure must still propagate`);
    assert.equal(r.unknown, true, `${label}: an unreadable snapshot is unknown, not an empty road network`);
    assert.equal(r.fallbackAt, null, `${label}: nothing may claim a snapshot is being served`);
    assert.ok(!r.healthy.includes('roads'), `${label}: the live source stays unhealthy`);
  }

  // and "unknown" is what the tab actually says, instead of "no closures reported"
  setRoadsState({ roadsUnknown: true });
  assert.equal(app.roadsTabRows().length, 0);
  assert.notEqual(I18N.en['roads.unknown'], I18N.en['roads.none']);
  for (const lang of ['en', 'es']) {
    assert.match(I18N[lang]['roads.unknown'], /desconoc|unknown/i, `${lang} must say the set is unknown`);
  }
  // an unknown closure set must also stop the board claiming an all-clear over it
  assert.match(read('js/panels.js'), /!state\.roadClosures \|\| state\.roadsUnknown\) return false;/,
    'quietState must refuse an all-clear while the closure set is unknown');
});

test('a recovered live fetch stands the snapshot claim down', async () => {
  ST.roadMemory = null;
  SB.localStorage.clear();
  const r = await runRoadsFallback(snapshotBody(30));
  assert.ok(r.fallbackAt, 'the fallback is serving');
  await runRoads(2);
  assert.equal(ST.roadsFallbackAt, null, 'a live round must clear the snapshot claim');
  assert.equal(ST.roadsUnknown, false, 'and clear the unknown claim');
  assert.equal(ST.roadClosures.points.length, 0, 'live lines replace the snapshot points entirely');
});

/* 2026-07-30, during a Severe/Immediate Flood Warning on the Nueces: both crossing feeds are
   regional (curated list is Hill Country, jurisdiction feed is ATX Floods, Central Texas), the
   nearest crossing record to Three Rivers was 98 mi away, and the tab rendered "No road closures or
   crossing hazards are reported in this area right now" to a county under that warning. A coverage
   hole must not wear the words of an all-clear. */
test('outside crossing coverage the tab says crossings are unknown, not clear', () => {
  const src = read('js/panels.js');
  assert.match(src, /function crossUncovered\(\)/, 'coverage must be decided in code, not assumed');
  const fn = src.slice(src.indexOf('function crossUncovered()'), src.indexOf('function renderRoadsTab'));
  assert.match(fn, /crossingList\(\)/, 'coverage reads the curated list through its accessor');
  assert.match(fn, /state\.crossStatus/, 'and off the jurisdiction feed');
  assert.match(fn, /distMi/, 'measured by real distance rather than a hardcoded region');
  assert.match(fn, /if \(!pts\.length\) return false/,
    'with nothing loaded the unknown states already speak; this must not double-claim');

  for (const lang of ['en', 'es']) {
    const s = I18N[lang]['roads.nocross'];
    assert.ok(typeof s === 'string' && s.length, `${lang} missing roads.nocross`);
    assert.ok(!s.includes('—'), `em-dash in ${lang} roads.nocross`);
  }
  assert.notEqual(I18N.en['roads.nocross'], I18N.es['roads.nocross'], 'roads.nocross was never translated');
  // it must deny the all-clear reading explicitly, the way roads.unknown and roads.xunknown do
  assert.match(I18N.en['roads.nocross'], /unknown, not clear/i);
  assert.match(I18N.es['roads.nocross'], /se desconocen, no est/i);
});
