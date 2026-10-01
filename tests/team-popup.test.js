'use strict';

/* The teammate popup: heading, speed and distance flow from the device to the relay and back, and
   these call the shipped memberPopupHtml() to check what a reader is finally told. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSandbox } = require('./harness.js');
const I18N = require('./i18n-load.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function loadTeam(lang) {
  const sandbox = buildSandbox();
  sandbox.document.getElementById = () => null;
  sandbox.document.querySelector = () => null;
  if (lang) sandbox.t = (k) => (Object.prototype.hasOwnProperty.call(I18N[lang], k) ? I18N[lang][k] : k);
  vm.runInContext(`${read('js/core.js')}\n;\n${read('js/team.js')}`, vm.createContext(sandbox), { filename: 'team-bundle.js' });
  assert.ok(sandbox.teamMemberOps, 'team.js exposes window.teamMemberOps');
  return sandbox.teamMemberOps;
}

const en = loadTeam('en');
const now = () => Date.now();
const mate = (over) => Object.assign({ handle: 'Bravo 2', lastSeen: now() - 5000 }, over);
const fix = (over) => Object.assign({ lat: 30, lon: -98, acc: 6, hdg: null, spd: null, ts: now() - 5000 }, over);
const text = (html) => html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');

test('a moving teammate shows speed and heading in mph and degrees true', () => {
  const html = en.popupHtml(mate(), { pos: fix({ spd: 5.4, hdg: 47 }) });
  assert.match(text(html), /\|moving 12 mph, heading NE \(047°\)\|/);
});

test('below walking-noise speed it says not moving, and drops the heading a still receiver invents', () => {
  const html = en.popupHtml(mate(), { pos: fix({ spd: 0.2, hdg: 200 }) });
  assert.match(text(html), /\|not moving\|/);
  assert.doesNotMatch(html, /heading/);
});

test('a fix with speed but no course gives the speed alone; one with neither says nothing', () => {
  assert.match(text(en.popupHtml(mate(), { pos: fix({ spd: 3, hdg: NaN }) })), /\|moving 7 mph\|/);
  assert.doesNotMatch(en.popupHtml(mate(), { pos: fix() }), /moving/);
});

test('distance and direction from you, in feet up close and miles beyond', () => {
  const self = fix({ lat: 30, lon: -98 });
  assert.match(text(en.popupHtml(mate(), { pos: fix({ lat: 30.001, lon: -98 }), self })), /\|365 ft N of you\|/);
  assert.match(text(en.popupHtml(mate(), { pos: fix({ lat: 30.01, lon: -97.99 }), self })), /\|0\.9 mi NE of you\|/);
});

test('motion and distance are withheld once contact is lost, from a last-known marker, and from a stale self fix', () => {
  const pos = fix({ spd: 5, hdg: 90, lat: 30.01 });
  const self = fix();
  const lost = en.popupHtml(mate({ lastSeen: now() - en.STALE_MS - 1000 }), { pos, self });
  assert.doesNotMatch(lost, /moving|of you/, 'a lost unit must not read as moving now');
  assert.doesNotMatch(en.popupHtml(mate(), { pos, self, tomb: true }), /moving|of you/);
  const oldSelf = fix({ ts: now() - en.STALE_MS - 1000 });
  assert.doesNotMatch(en.popupHtml(mate(), { pos, self: oldSelf }), /of you/, 'distance from where you were is not distance from you');
  assert.match(en.popupHtml(mate(), { pos, self }), /of you/);
});

test('your own marker shows your motion but never a distance from yourself', () => {
  const html = en.popupHtml(mate(), { isSelf: true, pos: fix({ spd: 2, hdg: 180 }), self: fix() });
  assert.match(text(html), /\|moving 4 mph, heading S \(180°\)\|/);
  assert.doesNotMatch(html, /of you/);
});

test('Spanish reads the same facts in Spanish units', () => {
  const es = loadTeam('es');
  const self = fix({ lat: 30, lon: -98 });
  const t = text(es.popupHtml(mate(), { pos: fix({ lat: 30.001, lon: -98, spd: 5.4, hdg: 47 }), self }));
  assert.match(t, /\|a 365 pies al N de usted\|/);
  assert.match(t, /\|en movimiento a 12 mph, rumbo NE \(047°\)\|/);
});

/* The roster: command's eye should land on the unit that went silent, not wherever the server
   happened to list it. renderRoster() runs against a recording host. */
function rosterHost(ops) {
  const list = { innerHTML: '' };
  const count = { textContent: '', cls: new Set(), classList: { toggle(c, on) { if (on) count.cls.add(c); else count.cls.delete(c); } } };
  const host = { querySelector: (sel) => (sel === '.tp-list' ? list : sel === '#team-rcount' ? count : null) };
  return { host, list, count };
}

function loadRoster() {
  const sandbox = buildSandbox();
  const r = rosterHost();
  sandbox.document.getElementById = (id) => (id === 'team-tab-body' ? r.host : null);
  sandbox.document.querySelector = () => null;
  vm.runInContext(`${read('js/core.js')}\n;\n${read('js/team.js')}`, vm.createContext(sandbox), { filename: 'team-bundle.js' });
  return { ops: sandbox.teamMemberOps, ...r };
}

const names = (html) => [...html.matchAll(/class="tp-name">([^<]*)</g)].map((x) => x[1]);

test('lost units rise to the top of the roster, longest silent first, and the header counts them', () => {
  const { ops, list, count } = loadRoster();
  const at = (s) => Date.now() - s * 1000;
  const pos = { lat: 30, lon: -98 };
  ops.renderRoster({ viewers: [], members: [
    { pid: 'a', handle: 'Alpha', lastSeen: at(5), lastPos: pos },
    { pid: 'b', handle: 'Bravo', lastSeen: at(200), lastPos: pos },
    { pid: 'c', handle: 'Charlie', lastSeen: at(10), lastPos: pos },
    { pid: 'd', handle: 'Delta', lastSeen: at(900), lastPos: pos },
    { pid: 'e', handle: 'Echo', lastSeen: at(900), lastPos: pos, status: 'unavailable' },
    { pid: 'f', handle: 'Foxtrot', lastSeen: at(900), lastPos: null },
  ] });
  assert.deepEqual(names(list.innerHTML), ['Delta', 'Bravo', 'Alpha', 'Charlie', 'Echo', 'Foxtrot'],
    'lost units lead, longest silent first; a member who chose not to share and one with no fix keep their place');
  assert.match(count.textContent, /· 2 lost contact$/);
  assert.ok(count.cls.has('tt-rcount-lost'));
});

test('with everyone reporting, the roster keeps server order and the header claims no losses', () => {
  const { ops, list, count } = loadRoster();
  const pos = { lat: 30, lon: -98 };
  ops.renderRoster({ viewers: [], members: [
    { pid: 'a', handle: 'Alpha', lastSeen: Date.now() - 4000, lastPos: pos },
    { pid: 'b', handle: 'Bravo', lastSeen: Date.now() - 8000, lastPos: pos },
  ] });
  assert.deepEqual(names(list.innerHTML), ['Alpha', 'Bravo']);
  assert.doesNotMatch(count.textContent, /lost/);
  assert.ok(!count.cls.has('tt-rcount-lost'));
});
