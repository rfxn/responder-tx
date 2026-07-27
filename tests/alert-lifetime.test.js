'use strict';

/* An alert's `expires` is the deadline for its next message, not the end of the hazard. The board
   read only `expires`, so a Flood Warning that expires tonight and ends on the 29th vanished from
   the map, the ticker, the quiet claim and the risk answer roughly 2.7 days early; and the VTEC
   "until further notice" sentinel that riverine warnings use routinely has no end at all, so the
   obvious `ends || expires` fix drops those instead. These pin the one predicate, the sites that
   must route through it, the severity ladder that let an unknown value outrank an emergency, and
   the area scoping that stops a Texas board printing Oklahoma counties. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./harness.js');

const {
  alertEndsAt, alertEnded, alertVtecEnds, VTEC_NO_END, alertOpen, alertUntilText, histAlertEnd,
  alertSevRank, ALERT_SEV_UNKNOWN, alertSevCmp, aoStates, alertAreaParts, alertAreaText, alertAreaLead,
  alertGroups, CONFIG,
} = loadApp();

const ROOT = path.join(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');
const readJs = (f) => fs.readFileSync(path.join(JS_DIR, f), 'utf8');
const JS_FILES = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js') && f !== 'i18n.js');

// the balanced argument list of a call whose opening paren is the last char of `match`
function callArgs(src, startIdx) {
  const open = src.indexOf('(', startIdx);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

// every `state.alerts.filter(...)` / `.some(...)` in the tree, as file plus its exact argument text
const ALERT_SELECT_RE = /\(?state\.alerts\s*(?:\|\|\s*\[\]\s*\))?\s*\.(?:filter|some)\s*\(/g;
function alertSelections(files, readSource) {
  const out = [];
  for (const file of files) {
    const src = readSource(file);
    for (const m of src.matchAll(ALERT_SELECT_RE)) {
      out.push({ file, line: src.slice(0, m.index).split('\n').length, expr: callArgs(src, m.index + m[0].length - 1) });
    }
  }
  return out;
}

const PAST = '2020-01-01T00:00:00Z';
const FUTURE = '2099-01-01T00:00:00Z';

// sandbox values carry the vm realm's prototypes, so structural comparison goes through JSON
const plain = (v) => JSON.parse(JSON.stringify(v));

// the shape the live feed serves, trimmed to the fields the predicate reads
function alert(props) {
  const { vtec, ...rest } = props;
  const parameters = { ...(rest.parameters || {}) };
  if (vtec) parameters.VTEC = Array.isArray(vtec) ? vtec : [vtec];
  return { id: rest.id || 'x', _sev: rest._sev || 'warning', properties: { event: 'Flood Warning', ...rest, parameters } };
}

/* ---------- the predicate ---------- */

/* Live probe 2026-07-27, api.weather.gov/alerts/active?area=TX, La Salle County Flood Warning:
   expires 2026-07-27T05:00-05:00, ends 2026-07-29T21:30-05:00. Reading `expires` retired it 2.7
   days before NWS did. */
test('alertEndsAt: ends outranks expires, so an alert stays open until the hazard ends', () => {
  const f = alert({
    expires: '2026-07-27T05:00:00-05:00',
    ends: '2026-07-29T21:30:00-05:00',
    vtec: '/O.CON.KCRP.FL.W.0025.000000T0000Z-260730T0230Z/',
  });
  assert.equal(alertEndsAt(f), '2026-07-29T21:30:00-05:00');

  // the message deadline has passed, the hazard has not: open
  assert.equal(alertEnded(alertEndsAt(f), '2026-07-28T12:00:00Z'), false);
  // past the hazard end: closed
  assert.equal(alertEnded(alertEndsAt(f), '2026-07-30T12:00:00Z'), true);
  // and the reverse of the old behaviour, which retired it at the message deadline
  assert.equal(alertEnded(f.properties.expires, '2026-07-28T12:00:00Z'), true);
});

test('alertEndsAt: eventEndingTime backs ends up, and it is an array like every CAP parameter', () => {
  const f = alert({ expires: PAST, parameters: { eventEndingTime: [FUTURE] } });
  assert.equal(alertEndsAt(f), FUTURE);
  assert.equal(alertOpen(f), true);
});

/* Two of the three Texas Flood Warnings live on 2026-07-27 carried a zeroed VTEC end slot with
   ends: null. `ends || expires` would have dropped both at the next message deadline. */
test('alertEndsAt: a zeroed VTEC end slot means until further notice, never an expiry', () => {
  const ufn = alert({
    expires: PAST,
    ends: null,
    vtec: '/O.CON.KCRP.FL.W.0026.000000T0000Z-000000T0000Z/',
  });
  assert.equal(alertVtecEnds(ufn.properties).includes(VTEC_NO_END), true);
  assert.equal(alertEndsAt(ufn), null, 'until-further-notice must resolve to no end at all');
  assert.equal(alertOpen(ufn), true, 'an until-further-notice alert must not expire early');

  // the same sentinel in the O.EXT form seen live on the Live Oak County warning
  const ext = alert({ expires: PAST, ends: null, vtec: '/O.EXT.KCRP.FL.W.0027.260729T1301Z-000000T0000Z/' });
  assert.equal(alertEndsAt(ext), null);
  assert.equal(alertOpen(ext), true);

  // a real VTEC end is not the sentinel and must still be read from ends
  const bounded = alert({ expires: PAST, ends: PAST, vtec: '/O.NEW.KCRP.FL.W.0028.260725T1200Z-260726T0230Z/' });
  assert.deepEqual(plain(alertVtecEnds(bounded.properties)), ['260726T0230Z']);
  assert.equal(alertOpen(bounded), false);
});

test('alertEndsAt: a missing end value reads as open, never as expired', () => {
  assert.equal(alertEndsAt(alert({})), null);
  assert.equal(alertOpen(alert({})), true, 'no expires, no ends, no VTEC: the board cannot rule it out');
  assert.equal(alertOpen(alert({ expires: null, ends: null })), true);
  // an unreadable end is not a past one either
  assert.equal(alertOpen(alert({ expires: 'not a date' })), true);
  assert.equal(alertEnded('not a date'), false);
  // and the plain expires-only case still works both ways
  assert.equal(alertOpen(alert({ expires: FUTURE })), true);
  assert.equal(alertOpen(alert({ expires: PAST })), false);
});

test('alertUntilText: a product with no declared end says so instead of showing a stale deadline', () => {
  const ufn = alert({ expires: PAST, vtec: '/O.CON.KCRP.FL.W.0026.000000T0000Z-000000T0000Z/' });
  assert.equal(alertUntilText(ufn), 'alert.further', 'renders the until-further-notice string, not a time');
  assert.notEqual(alertUntilText(alert({ expires: FUTURE, ends: FUTURE })), 'alert.further');
});

test('histAlertEnd: rows stored before endsAt existed fall back to expires, and a stored null stays null', () => {
  assert.equal(histAlertEnd({ expires: PAST }), PAST, 'pre-v0.99.55 row: only the deadline was kept');
  assert.equal(histAlertEnd({ expires: PAST, endsAt: FUTURE }), FUTURE);
  assert.equal(histAlertEnd({ expires: PAST, endsAt: null }), null, 'a declared no-end must not fall back to expires');
  assert.equal(alertEnded(histAlertEnd({ expires: PAST, endsAt: null })), false);
});

/* ---------- one predicate, structurally ---------- */

/* The ticker rolled its own with `new Date(x.properties.expires) > new Date()`, which is false when
   expires is absent, so it HID an emergency that every other surface showed. A new copy of that
   shape is what this catches, by construction rather than by review. */
test('one predicate: no file rolls its own clock comparison on an alert end field', () => {
  const END_FIELD = String.raw`expires|endsAt|eventEndingTime|histAlertEnd|alertEndsAt|\bends\b`;
  const PATTERNS = [
    // new Date(<end field>) < now  /  Date.parse(...ends...) >= ...
    new RegExp(String.raw`(?:new\s+Date|Date\.parse)\s*\([^)]*(?:${END_FIELD})[^)]*\)[^;\n]*?[<>]`),
    // ...ends... < new Date()  /  ... > Date.now()
    new RegExp(String.raw`(?:${END_FIELD})[^;\n]*[<>]=?\s*(?:new\s+Date\s*\(\s*\)|Date\.now\s*\(\s*\))`),
  ];
  const hits = [];
  for (const file of JS_FILES) {
    readJs(file).split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (PATTERNS.some((re) => re.test(code))) hits.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], 'an alert open/expired decision was rolled by hand; route it through alertEnded()');
});

/* Every currency decision over the live alert set goes through the predicate. A new consumer that
   filters state.alerts without it is the exact regression this release fixed at six sites. */
test('one predicate: every state.alerts filter/some routes through alertOpen', () => {
  const sel = alertSelections(JS_FILES, readJs);
  assert.ok(sel.length >= 6, `only ${sel.length} alert selections matched; the scan would pass vacuously`);
  const misses = sel.filter((s) => !s.expr.includes('alertOpen')).map((s) => `${s.file}:${s.line}: ${s.expr.slice(0, 100)}`);
  assert.deepEqual(misses, [], 'a state.alerts selection decides currency without alertOpen()');

  // the derivation works: a selection missing the predicate is detected, one carrying it is not
  const probe = (body) => alertSelections(['x'], () => `const a = state.alerts.filter((f) => ${body});`);
  assert.equal(probe('f._sev === "emergency"')[0].expr.includes('alertOpen'), false);
  assert.equal(probe('alertOpen(f)')[0].expr.includes('alertOpen'), true);
});

/* v0.99.40 established fold-do-not-drop for Alerts. Area scoping may narrow what a card PRINTS and
   must never narrow which alerts are listed: an alert whose polygon reaches into the AO while its
   county list names none of it still has to appear. */
test('area: scoping is a display filter, never a selection predicate', () => {
  const AREA_HELPERS = /alertAreaParts|alertAreaText|alertAreaLead|aoStates/;
  const hits = alertSelections(JS_FILES, readJs)
    .filter((s) => AREA_HELPERS.test(s.expr))
    .map((s) => `${s.file}:${s.line}: ${s.expr.slice(0, 100)}`);
  assert.deepEqual(hits, [], 'area scoping decides which alerts are listed; it may only decide what they print');
});

test('one predicate: stored alert history is read through the same comparator', () => {
  // the readers wrap the store and break the line, so the scan runs over whitespace-collapsed source
  const READ_RE = /(?:Object\.(?:entries|values)\s*\(\s*)?state\.hist\.alerts\b[^;]{0,200}?\.(?:filter|some)\s*\(/g;
  const misses = [];
  let sites = 0;
  for (const file of JS_FILES) {
    const flat = readJs(file).replace(/\s+/g, ' ');
    for (const m of flat.matchAll(READ_RE)) {
      sites++;
      const expr = flat.slice(m.index, m.index + 320);
      if (!expr.includes('alertEnded')) misses.push(`${file}: ${expr.slice(0, 120)}`);
    }
  }
  assert.ok(sites >= 2, `only ${sites} history readers matched; the scan would pass vacuously`);
  assert.deepEqual(misses, [], 'stored alert history decides currency without alertEnded()');
});

test('one predicate: alertOpen delegates rather than comparing, and alertEnded is the only comparator', () => {
  const src = readJs('sources.js');
  assert.match(src, /const alertOpen = \(f\) => !alertEnded\(alertEndsAt\(f\)\);/);
  const body = src.slice(src.indexOf('function alertEnded'), src.indexOf('const alertOpen'));
  assert.equal((body.match(/[<>]=?/g) || []).length, 1, 'alertEnded holds exactly one relational comparison');
});

/* ---------- severity ladder ---------- */

/* SEV_ORDER.indexOf() returned -1 for an unrecognised severity, and -1 sorts above index 0
   (emergency), so an unknown value won the "what is the worst thing near me" answer. */
test('severity: an unknown value sorts last, never above a flash flood emergency', () => {
  assert.equal(alertSevRank('emergency'), 0);
  assert.equal(alertSevRank('advisory'), 3);
  for (const unknown of ['tornado', 'destructive', '', null, undefined, 'Emergency']) {
    assert.equal(alertSevRank(unknown), ALERT_SEV_UNKNOWN, `unknown severity ${String(unknown)} must rank last`);
    assert.ok(alertSevRank(unknown) > alertSevRank('emergency'));
    assert.ok(alertSevRank(unknown) > alertSevRank('advisory'));
  }
  // the failure exactly as it reached the resident: unknown first in the list, emergency second
  const rows = [{ _sev: 'mystery' }, { _sev: 'emergency' }, { _sev: 'watch' }];
  assert.equal(rows.slice().sort(alertSevCmp)[0]._sev, 'emergency');
  assert.deepEqual(rows.slice().sort(alertSevCmp).map((r) => r._sev), ['emergency', 'watch', 'mystery']);
  // and it is not inherited from the prototype chain
  assert.equal(alertSevRank('toString'), ALERT_SEV_UNKNOWN);
  assert.equal(alertSevRank('constructor'), ALERT_SEV_UNKNOWN);
});

test('severity: the ladder is read through alertSevRank, never through indexOf on a list', () => {
  const hits = [];
  for (const file of JS_FILES) {
    readJs(file).split('\n').forEach((line, i) => {
      if (/SEV_ORDER|indexOf\([^)]*_sev/.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], 'a severity ladder was read by indexOf(); -1 sorts above emergency');
});

test('severity: the Alerts tab grouping keeps an unknown severity below every known one', () => {
  const mk = (id, sev) => ({ id, _sev: sev, properties: { event: 'x', areaDesc: id, sent: '2026-07-26T10:00:00Z' } });
  const { near } = alertGroups([mk('mystery', 'nope'), mk('emerg', 'emergency'), mk('adv', 'advisory')], null, null);
  assert.deepEqual(near.map((r) => r.f.id), ['emerg', 'adv', 'mystery']);
});

/* ---------- area scoping ---------- */

/* area=TX returns any product that touches Texas and each carries its full multi-state county list.
   Measured on the live feed 2026-07-27: 218 zones, 92 of them OK/LA/AR/NM, 42%. */
test('area: out-of-AO counties are counted, not printed, and the AO comes from the query itself', () => {
  assert.deepEqual(plain(aoStates()), ['TX']);
  assert.match(CONFIG.alertsUrl, /area=TX/);

  const p = {
    areaDesc: 'Sevier; Howard; Bowie; Cass',
    geocode: { UGC: ['ARZ050', 'ARZ051', 'TXZ096', 'TXZ097'] },
  };
  assert.deepEqual(plain(alertAreaParts(p)), { inAo: ['Bowie', 'Cass'], out: 2 });
  const text = alertAreaText(p);
  assert.ok(text.includes('Bowie') && text.includes('Cass'), 'AO counties are named in full');
  assert.ok(!text.includes('Sevier') && !text.includes('Howard'), 'other states are not printed as ours');
  assert.ok(text.includes('alert.areaOut'), 'the out-of-area count is stated, never silently dropped');
  assert.equal(alertAreaLead(p), 'Bowie', 'a glance surface leads with an AO county');
});

test('area: an unreadable alignment names every county rather than hiding one', () => {
  // no UGC at all: the board cannot tell which are ours, so it shows all of them
  assert.deepEqual(plain(alertAreaParts({ areaDesc: 'La Salle, TX; McMullen, TX' })), { inAo: ['La Salle, TX', 'McMullen, TX'], out: 0 });
  // UGC present but not aligned with the segments: same, err toward showing
  assert.deepEqual(plain(alertAreaParts({ areaDesc: 'A; B; C', geocode: { UGC: ['TXZ001'] } })), { inAo: ['A', 'B', 'C'], out: 0 });
  // nothing matched the AO: a polygon reaching into Texas keeps its whole description
  assert.deepEqual(plain(alertAreaParts({ areaDesc: 'Caddo; Bossier', geocode: { UGC: ['LAZ001', 'LAZ002'] } })), { inAo: ['Caddo', 'Bossier'], out: 0 });
  assert.deepEqual(plain(alertAreaParts({})), { inAo: [], out: 0 });
});

test('area: scoping folds the description and never drops the alert', () => {
  const outOfAo = {
    id: 'la',
    _sev: 'warning',
    geometry: { type: 'Polygon', coordinates: [[[-94.1, 32.0], [-93.5, 32.0], [-93.5, 32.5], [-94.1, 32.5], [-94.1, 32.0]]] },
    properties: { event: 'Flood Warning', areaDesc: 'Caddo; Bossier; Cass', geocode: { UGC: ['LAZ001', 'LAZ002', 'TXZ097'] }, sent: '2026-07-26T10:00:00Z' },
  };
  const { near, far } = alertGroups([outOfAo], null, null);
  assert.equal(near.length + far.length, 1, 'the alert is still listed after scoping');
  assert.equal(alertAreaParts(outOfAo.properties).out, 2, 'and its out-of-area counties are counted');
});

/* Drive Mode joined every segment into one line: 48 counties, 430 characters, for a gloved reader
   with ten seconds. The cap states what it held back rather than truncating in silence. */
test('area: a glance surface caps the segments and says how many it held back', () => {
  const p = {
    areaDesc: 'Bowie; Cass; Marion; Harrison; Sevier',
    geocode: { UGC: ['TXZ096', 'TXZ097', 'TXZ108', 'TXZ109', 'ARZ050'] },
  };
  const capped = alertAreaText(p, 2);
  assert.ok(capped.startsWith('Bowie; Cass'), 'the two nearest AO counties lead');
  assert.ok(!capped.includes('Marion'), 'the rest are held back');
  assert.ok(capped.includes('alert.areaMore'), 'and counted, not silently truncated');
  assert.ok(capped.includes('alert.areaOut'), 'the out-of-area count survives the cap');
  assert.equal(capped.split(';').length, 2, 'the joined county run is two segments, not five');
  // uncapped callers are unaffected
  assert.ok(alertAreaText(p).includes('Harrison'));
});
