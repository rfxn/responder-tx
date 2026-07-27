'use strict';

/*
 * Local emergency and evacuation orders. These are not NWS products: under 47 CFR 11.31 they are
 * state and local event codes with originator CIV, written by a county or a state agency and only
 * relayed down the NWS dissemination path. Crediting the National Weather Service for a county
 * judge's evacuation order states something false, so the attribution here is a correctness test
 * and not a styling one.
 *
 * tests/fixtures/alerts-orders.json splits what it holds. Its "real" half is six products captured
 * verbatim from api.weather.gov on 2026-07-26 and covers every senderName shape seen nationally: a
 * COG number prefix, a segment repeated three times, a plain agency name, and an NWS office as the
 * genuine sender. Its "shaped" half carries 911 Telephone Outage and Evacuation Immediate records,
 * which no archived product could supply: the endpoint holds roughly seven days and had zero of
 * either string, nationally, on the day this was written. Their field set and value shapes are
 * copied from the real CIV products, and the two phone formats are the two the real Idaho products
 * use verbatim.
 *
 * The fact these tests exist to defend: the board's single most repeated instruction is to call
 * 911, and a 911 Telephone Outage says that instruction is currently wrong for the affected area.
 * The board must be able to say so there without weakening it anywhere else.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp } = require('./harness.js');

const {
  alertSeverity, alertAgency, alertAgencyText, alertNear, alertGroups, alertGeom,
  hazardClass, hazardRank, hazardIsOrder, hazardGlance, hazardStyleKey, hazardGlyph,
  alertActionKey, alertCardDiv, nine11Alt, nine11Outages, NINE11_EVENT,
  tickerAlertItems, driveItems, nine11NoticeHtml, HAZARD_EVENTS, t, state,
} = loadApp();

/* The harness echoes translation keys back, which would let a card render "alert.agency" and still
   match a loose assertion. These tests swap in the shipped table instead, so what is asserted is the
   sentence a responder actually reads, in both languages. */
const I18N = require('./i18n-load.js');
const SANDBOX = loadApp()._sandbox;
function withCopy(lang, fn) {
  const prev = SANDBOX.t;
  SANDBOX.t = (k) => (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k;
  try { return fn(); } finally { SANDBOX.t = prev; }
}

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'alerts-orders.json'), 'utf8'));
const withSev = (f) => Object.assign({}, f, { _sev: alertSeverity(f.properties) });
const REAL = FIX.real.map(withSev);
const SHAPED = FIX.shaped.map(withSev);
const byId = (id) => {
  const f = REAL.concat(SHAPED).find((x) => x.properties.id === id);
  assert.ok(f, `fixture ${id} is missing; the suite below would pass vacuously without it`);
  return f;
};

// Kerr County box in the fixtures; ELSEWHERE is ~500 mi away, outside every fixture polygon
const IN_KERR = [[30.05, -99.15]];
const ELSEWHERE = [[32.78, -96.80]];

const ORDER_EVENTS = Object.keys(HAZARD_EVENTS).filter((k) => HAZARD_EVENTS[k].cls === 'order');

test('the fixture set is real, complete and non-vacuous', () => {
  assert.equal(ORDER_EVENTS.length, 8, 'all eight order event strings must be in the hazard table');
  assert.equal(REAL.length, 6, 'six verbatim archived products; a shrunken set would weaken every assertion below');
  assert.ok(SHAPED.length >= 6);
  // the senderName shapes the normaliser has to survive must all actually be present
  const senders = REAL.map((f) => f.properties.senderName);
  assert.ok(senders.some((s) => /^\d+,/.test(s)), 'a COG-number-prefixed senderName must be in the sample');
  assert.ok(senders.some((s) => s.split(',').length === 3 && new Set(s.split(',')).size === 1),
    'a senderName repeated three times must be in the sample');
  assert.ok(senders.some((s) => /^NWS /.test(s)), 'the case where NWS genuinely is the sender must be in the sample');
  assert.ok(REAL.some((f) => !f.geometry && !(f.properties.affectedZones || []).length),
    'a product with no geometry and no zones must be in the sample, or the unmappable state is untested');
});

/* ---------- attribution: the authoring agency, never a default of NWS ---------- */

test('an order credits its authoring agency and never the National Weather Service', () => {
  const orders = REAL.filter((f) => hazardClass(f) === 'order');
  assert.equal(orders.length, 6, 'every archived fixture is an order; a zero here would pass the loop vacuously');

  for (const f of orders) {
    const agency = alertAgency(f);
    assert.ok(agency, `${f.id} must resolve an agency from senderName`);
    // NWS Medford OR really did send one of these, on Siskiyou County's behalf. Crediting the
    // office that sent it is accurate; inventing "National Weather Service" for the other five is not.
    if (/^NWS /.test(f.properties.senderName)) {
      assert.equal(agency, 'NWS Medford OR', 'when NWS genuinely is the sender, say so');
      continue;
    }
    assert.doesNotMatch(agency, /National Weather Service/i,
      `${f.id} is a CIV-originated county or state product and must not be credited to NWS`);
    assert.doesNotMatch(agency, /\bNWS\b/, `${f.id} must not be credited to NWS`);
  }

  assert.equal(alertAgency(byId('AS-ID-dd078a49-fe9f-49a3-ba18-a430613392a4')),
    'Idaho State Communications Center, Idaho Office of Emergency Management',
    'the leading IPAWS COG number is routing, not part of the agency name');
  assert.equal(alertAgency(byId('ASHERGROUP-1738024-post-1784591163')), 'Boone County WV',
    'a name repeated three times is one agency');
  assert.equal(alertAgency(byId('AS-NM-33f0f7cb-632f-483a-a0bb-819df95af537')), 'Village of Ruidoso',
    'COG number plus a repeated segment collapses to the one agency name');
  assert.equal(alertAgency(byId('200049.eed2c2d8d7b840a5f018b622e33579')), 'WVEMD, South Charleston, WV',
    'distinct segments are all part of the name and none may be dropped');
});

test('a missing senderName degrades honestly instead of defaulting to NWS', () => {
  const nosender = byId('FIXTURE-911-NOSENDER');
  assert.equal('senderName' in nosender.properties, false, 'the fixture must genuinely lack the field');
  assert.equal(alertAgency(nosender), '', 'nothing to credit means nothing, not a substitute');
  assert.equal(alertAgencyText(nosender), t('alert.agency.unknown'));
  assert.doesNotMatch(alertAgencyText(nosender), /NWS|National Weather Service/i,
    'an unattributed product must not be published as an NWS product');

  for (const bad of [{}, { properties: {} }, { properties: { senderName: '   ' } }, { properties: { senderName: '200033' } }]) {
    assert.equal(alertAgency(bad), '', 'a blank or number-only senderName resolves to no agency');
  }
  assert.equal(alertAgencyText({ properties: { senderName: '200033' } }), t('alert.agency.unknown'));
});

test('the order card carries the agency credit and the reader modal no longer defaults to NWS', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'sources.js'), 'utf8');
  assert.doesNotMatch(src, /senderName \|\| 'NWS'/,
    'the reader footer must not fall back to asserting NWS when the product named no sender');
  assert.match(src, /alertAgency\(f\) \|\| t\('alert\.agency\.unknown'\)/);

  const order = byId('AS-NM-33f0f7cb-632f-483a-a0bb-819df95af537');
  for (const lang of ['en', 'es']) {
    const html = withCopy(lang, () => alertCardDiv(order, 12).innerHTML);
    assert.match(html, /class="alert-agency">[^<]*Village of Ruidoso/,
      `an order card must name who issued the order (${lang})`);
    assert.doesNotMatch(html, /National Weather Service/i);
    assert.doesNotMatch(html, /\bNWS\b/, 'the card must not credit NWS for a village ordinance');
  }
  // a missing sender reaches the card as the honest string, never as NWS
  const nosender = withCopy('en', () => alertCardDiv(byId('FIXTURE-911-NOSENDER'), 3).innerHTML);
  assert.match(nosender, new RegExp(`class="alert-agency">${I18N.en['alert.agency.unknown']}<`));
  assert.doesNotMatch(nosender, /\bNWS\b/);
  // a flood warning gets no agency line, so the assertions above are about orders and not all cards
  const flood = withSev({ properties: { event: 'Flood Warning', areaDesc: 'Kerr, TX', senderName: 'NWS San Angelo TX', parameters: {} } });
  assert.doesNotMatch(withCopy('en', () => alertCardDiv(flood, 4).innerHTML), /alert-agency/);
});

/* ---------- orders never fold ---------- */

test('an order never folds out of view, at any distance and under every scope', () => {
  const orders = REAL.filter((f) => hazardClass(f) === 'order').concat(SHAPED);
  assert.ok(orders.length >= 12, 'a shrunken order set would make the loop below vacuous');

  const scopes = [
    null,
    { src: 'me', pts: ELSEWHERE },
    { src: 'me', pts: IN_KERR },
    { src: 'place', pts: [[25.90, -97.49]] },
    { src: 'inview', view: { s: 25.8, w: -97.6, n: 26.0, e: -97.3 } },
  ];
  for (const f of orders) {
    for (const scope of scopes) {
      assert.equal(alertNear(f, scope), true,
        `${f.properties.event} (${f.id}) folded under scope ${scope ? scope.src : 'none'}; a directive from a peer agency is not a distance question`);
    }
  }

  // and the fold actually has teeth on something that is not an order, or the assertion above is empty
  const distantFlood = withSev({
    id: 'ctrl-flood', geometry: { type: 'Polygon', coordinates: [[[-97.6, 25.8], [-97.3, 25.8], [-97.3, 26.0], [-97.6, 26.0], [-97.6, 25.8]]] },
    properties: { event: 'Flood Warning', areaDesc: 'Cameron, TX', parameters: {} },
  });
  assert.equal(alertNear(distantFlood, { src: 'me', pts: ELSEWHERE }), false,
    'the fold must reject a distant non-order, or "orders never fold" asserts nothing');

  const groups = alertGroups([distantFlood].concat(orders), { src: 'me', pts: ELSEWHERE });
  assert.equal(groups.far.length, 1, 'only the control flood warning may be folded');
  assert.equal(groups.far[0].f.id, 'ctrl-flood');
  assert.equal(groups.near.length, orders.length);
});

/* ---------- unmappable extent renders its own state ---------- */

test('an unmappable extent renders its own card state rather than vanishing', () => {
  const unmapped = byId('AS-UT-2ca261be-de9c-43ff-8994-b0f1a11c9d94');
  assert.equal(unmapped.geometry, null);
  assert.deepEqual(unmapped.properties.affectedZones, [], 'no polygon and no zone: nothing to draw');
  assert.equal(alertGeom(unmapped), null);

  const card = alertCardDiv(unmapped, NaN);
  assert.match(card.className, /alert-unmapped/);
  assert.match(card.innerHTML, /class="alert-noextent"/,
    'the card must say the extent is not mapped rather than show a silent absence');
  assert.match(card.innerHTML, /title="[^"]*alert\.extent\.unmapped\.title/);
  assert.match(card.innerHTML, /Southeastern Utah/, 'the words the product used for its area still render');

  // a mappable order must NOT carry the state, or the badge would be decoration rather than a signal
  const mappable = byId('AS-NM-33f0f7cb-632f-483a-a0bb-819df95af537');
  assert.ok(alertGeom(mappable));
  const ok = alertCardDiv(mappable, 12);
  assert.doesNotMatch(ok.className, /alert-unmapped/);
  assert.doesNotMatch(ok.innerHTML, /alert-noextent/);

  // and it is still in the list, in the lead group, at every scope
  const groups = alertGroups([unmapped], { src: 'me', pts: ELSEWHERE });
  assert.equal(groups.near.length, 1, 'an order the board cannot place must not disappear from the list');
});

/* ---------- classification, ranking and the glance surfaces ---------- */

test('an order is never read as an advisory and never loses its class to its own prose', () => {
  for (const ev of ORDER_EVENTS) {
    assert.equal(hazardIsOrder(ev), true);
    const f = withSev({ properties: { event: ev, parameters: {} } });
    assert.notEqual(f._sev, 'advisory', `${ev} must not read as the board's lowest tier`);
    assert.equal(hazardClass(f), 'order');
    assert.equal(hazardRank(f), 4);
    assert.equal(hazardGlance(f), true, `${ev} must reach the glance surfaces`);
    assert.equal(hazardStyleKey(f), 'order');
    assert.equal(hazardGlyph(f), '⛔');
  }
  // four of the eight carry no "Warning" in the name and are exactly the ones the word test missed
  const noWarning = ORDER_EVENTS.filter((e) => !/Warning/i.test(e));
  assert.deepEqual(noWarning.sort(),
    ['911 Telephone Outage', 'Civil Emergency Message', 'Evacuation Immediate', 'Local Area Emergency']);
  for (const ev of noWarning) {
    assert.equal(alertSeverity({ event: ev, parameters: {} }), 'warning');
  }
  // the word test still has teeth on a non-order, or the line above proves nothing
  assert.equal(alertSeverity({ event: 'Flood Advisory', parameters: {} }), 'advisory');

  // a county relaying flash-flood-emergency wording keeps its order class
  const relayed = withSev({ properties: { event: 'Local Area Emergency', description: 'FLASH FLOOD EMERGENCY for the river corridor.', parameters: {} } });
  assert.equal(relayed._sev, 'emergency', 'the severity read is unchanged');
  assert.equal(hazardClass(relayed), 'order', 'the order class survives, and with it the attribution and never-fold rules');
});

test('every order reaches Drive Mode with a verb, taken from the order own declared response', () => {
  for (const ev of ORDER_EVENTS) {
    const f = withSev({ properties: { event: ev, parameters: {} } });
    assert.ok(alertActionKey(f), `${ev} must produce a Drive Mode row; a null key means no row at all`);
  }
  const resp = (r) => alertActionKey(withSev({ properties: { event: 'Civil Danger Warning', response: r, parameters: {} } }));
  assert.equal(resp('Evacuate'), 'drive.act.evacuate');
  assert.equal(resp('Shelter'), 'drive.act.shelterplace');
  assert.equal(resp('Avoid'), 'drive.act.avoidarea');
  assert.equal(resp('Prepare'), 'drive.act.readymove');
  assert.equal(resp('Monitor'), 'drive.act.order', 'no reducible action still gets "read it", never nothing');
  assert.equal(resp(undefined), 'drive.act.order');
  // the event string wins where it is itself the directive, whatever response it carries
  assert.equal(alertActionKey(withSev({ properties: { event: 'Evacuation Immediate', response: 'Monitor', parameters: {} } })), 'drive.act.evacuate');
  assert.equal(alertActionKey(withSev({ properties: { event: NINE11_EVENT, response: 'Evacuate', parameters: {} } })), 'drive.act.nine11');
  // and a non-order is untouched by any of it
  assert.equal(alertActionKey(withSev({ properties: { event: 'Heat Advisory', response: 'Evacuate', parameters: {} } })), null);
});

test('orders enter the hazard line and Drive Mode alongside acute products', () => {
  const prev = { alerts: state.alerts, myPos: state.myPos };
  try {
    state.alerts = [byId('FIXTURE-EVI')];
    state.myPos = { lat: 30.05, lng: -99.15 };
    assert.equal(tickerAlertItems().length, 1, 'an evacuation order belongs on the glance line');
    assert.match(tickerAlertItems()[0].text, /Evacuation Immediate/);
    const rows = withCopy('en', () => driveItems()).filter((r) => r.name === I18N.en['drive.act.evacuate']);
    assert.equal(rows.length, 1, 'the person in the truck must see the evacuation order');
    assert.equal(rows[0].rank, 0);
    assert.equal(rows[0].pin, true, 'the fix is inside the order polygon, so the row pins above the distance sort');

    // a watch in the same slot must NOT enter, or "orders enter" says nothing about admission
    state.alerts = [withSev({ id: 'w', geometry: byId('FIXTURE-EVI').geometry, properties: { event: 'Flood Watch', areaDesc: 'Kerr, TX', parameters: {} } })];
    assert.equal(tickerAlertItems().length, 0, 'the watch class still stays off the glance line');
  } finally { Object.assign(state, prev); }
});

/* ---------- the 911 telephone outage case ---------- */

test('nine11Alt quotes the number the alert published, in both formats agencies write', () => {
  assert.equal(nine11Alt(byId('FIXTURE-911-DASHED')), '830-896-1216');
  assert.equal(nine11Alt(byId('FIXTURE-911-SPACED')), '830-249-9546',
    'agencies space the digits so the text-to-speech relay reads them; both real Idaho products do this');
  assert.equal(nine11Alt(byId('FIXTURE-911-NOALT')), '',
    'no number in the text means no number, and the card says so rather than inventing one');

  // it never runs on anything but an outage product, where a ten-digit run is the callback
  const cem = byId('AS-ID-dd078a49-fe9f-49a3-ba18-a430613392a4');
  assert.match(cem.properties.description, /2 0 8 4 9 5 1 2 0 5/, 'this real product does contain a spaced number');
  assert.equal(nine11Alt(cem), '', 'a Civil Emergency Message is not a 911 outage and gets no alternate-number claim');

  // and it never answers 911 itself, nor invents one out of ordinary prose
  const noise = { properties: { event: NINE11_EVENT, description: 'Call 911. Interstate 59 north bound blocked at mile 26 on 2026-07-26.', parameters: {} } };
  assert.equal(nine11Alt(noise), '', 'prose with no callback number must not yield one');
});

test('the 911 outage notice fires only where the outage actually is', () => {
  const prev = { alerts: state.alerts, myPos: state.myPos };
  try {
    const el = { hidden: true, innerHTML: '', querySelectorAll: () => [] };
    const near = byId('FIXTURE-911-DASHED');
    const far = byId('FIXTURE-911-FAR');
    const unmapped = byId('FIXTURE-911-UNMAPPED');
    state.alerts = [near, far, unmapped];

    state.myPos = { lat: 30.05, lng: -99.15 }; // inside the Kerr polygon
    let hit = nine11Outages();
    assert.equal(hit.length, 1, 'exactly the outage covering the reader');
    assert.equal(hit[0].properties.id, near.properties.id);

    state.myPos = { lat: 32.78, lng: -96.80 }; // Dallas: covered by neither
    assert.equal(nine11Outages().map((f) => f.properties.id).join(','), '',
      'an outage 500 miles away must not tell this reader their 911 is down');

    state.myPos = { lat: 31.75, lng: -106.40 }; // inside the El Paso polygon
    assert.equal(nine11Outages().map((f) => f.properties.id).join(','), far.properties.id);

    // no fix and no saved place: the board cannot place the reader and must not assert an area
    state.myPos = null;
    assert.equal(nine11Outages().map((f) => f.properties.id).join(','), '',
      'with nothing to measure from, the board says nothing about where the reader is');
    assert.equal(nine11Outages([]).length, 0);

    // an unmappable outage never fires the notice, at any position, because containment is unknowable
    state.myPos = { lat: 30.05, lng: -99.15 };
    assert.equal(nine11Outages().some((f) => f.properties.id === unmapped.properties.id), false,
      'no boundary means no containment claim; the order still carries in the list and the card says the extent is not mapped');

    // an expired outage over the reader must not fire either
    state.alerts = [Object.assign({}, near, { properties: Object.assign({}, near.properties, { expires: '2020-01-01T00:00:00-06:00' }) })];
    assert.equal(nine11Outages().map((f) => f.properties.id).join(','), '', 'a closed outage is not an outage');
  } finally { Object.assign(state, prev); }
});

test('the notice states the outage, credits the agency and never tells anyone to stop calling 911', () => {
  for (const lang of ['en', 'es']) {
    const html = withCopy(lang, () => nine11NoticeHtml([byId('FIXTURE-911-DASHED')]));
    assert.match(html, /Kerr County/, `the authoring agency is named (${lang})`);
    assert.doesNotMatch(html, /National Weather Service/i, 'a county outage is not an NWS product');
    assert.doesNotMatch(html, /\bNWS\b/);
    assert.match(html, /Kerr, TX/, 'the notice names the area it read, because containment errs wide');
    assert.match(html, /830-896-1216/, 'the number the alert published is quoted');
    assert.match(html, /href="tel:8308961216"/, 'and is dialable');
    // the guidance is qualified where the outage is, never withdrawn: the band still says to try 911
    assert.match(html, /911/);
    assert.ok(html.includes(I18N[lang]['nine11.keep']),
      `the notice must still say to try 911, because an outage can be partial (${lang})`);
  }
  assert.match(I18N.en['nine11.keep'], /try 911 first/i);
  assert.match(I18N.es['nine11.keep'], /911/);

  const noalt = withCopy('en', () => nine11NoticeHtml([byId('FIXTURE-911-NOALT')]));
  assert.match(noalt, /n11-noalt/, 'no published number is stated as such rather than left blank');
  assert.ok(noalt.includes(I18N.en['nine11.noalt']));
  assert.doesNotMatch(noalt, /href="tel:/, 'no number published means no number offered');
  assert.equal(nine11NoticeHtml([]), '', 'no outage, no notice');
  assert.equal(nine11NoticeHtml(null), '');

  // the renderer is wired into the refresh path and hides the band when there is nothing to say
  const panels = fs.readFileSync(path.join(__dirname, '..', 'js', 'panels.js'), 'utf8');
  assert.match(panels, /function renderTiles\(\)\s*\{[^}]*renderNine11Notice\(\)/,
    'the notice must re-render on every refresh, like the strip and the hazard line');
  assert.match(panels, /el\.hidden = !outages\.length;/);
});

test('the standard 911 guidance is untouched everywhere else', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const panels = fs.readFileSync(path.join(__dirname, '..', 'js', 'panels.js'), 'utf8');

  // the notice is additive: it sits beside the contract, it does not edit it
  assert.equal((html.match(/class="drive-911"/g) || []).length, 4, 'all four lens footers stay');
  assert.match(html, /id="disclaimer"/);
  assert.match(html, /data-i18n-html="disc\.short"/);
  assert.match(html, /data-i18n="drive\.footer"/);
  assert.match(html, /id="safety-modal"/);
  assert.match(html, /data-i18n="safety\.head"/);
  assert.match(html, /data-i18n="safety\.nodeploy"/);
  assert.ok(html.indexOf('id="nine11-notice"') < html.indexOf('id="disclaimer"'),
    'the qualifier reads above the instruction it qualifies');

  // nothing in this release may rewrite the disclaimer, the lens footer or the safety modal
  for (const key of ['disc.short', 'drive.footer', 'safety.head', 'safety.nodeploy', 'safety.ack']) {
    assert.doesNotMatch(panels, new RegExp(`setAttribute\\(\\s*'data-i18n'\\s*,\\s*'${key.replace('.', '\\.')}'`));
  }
  assert.doesNotMatch(panels, /#safety-modal|#disclaimer|\.drive-911/,
    'the 911 outage renderer must not reach into the disclaimer, the lens footers or the safety modal');

  // the en and es 911 copy still says to call 911
  const i18n = fs.readFileSync(path.join(__dirname, '..', 'js', 'i18n.js'), 'utf8');
  assert.equal((i18n.match(/'disc\.short':/g) || []).length, 2);
  assert.equal((i18n.match(/'drive\.footer':/g) || []).length, 2);
  assert.equal((i18n.match(/911/g) || []).length >= 8, true, 'the 911 copy is still present in both languages');
});

test('the notice keys exist in both languages and carry no em-dash', () => {
  const keys = ['nine11.head', 'nine11.body', 'nine11.alt', 'nine11.noalt', 'nine11.keep',
    'alert.cls.order', 'alert.agency', 'alert.agency.unknown', 'alert.extent.unmapped',
    'alert.extent.unmapped.title', 'drive.act.evacuate', 'drive.act.shelterplace',
    'drive.act.avoidarea', 'drive.act.readymove', 'drive.act.hazmat', 'drive.act.nine11', 'drive.act.order'];
  assert.ok(keys.length >= 17, 'a shrunken key list would make this loop vacuous');
  for (const k of keys) {
    for (const lang of ['en', 'es']) {
      const v = I18N[lang][k];
      assert.ok(v, `${k} is missing from the ${lang} table`);
      assert.doesNotMatch(v, /—/, `${k} carries an em-dash in ${lang}`);
      assert.doesNotMatch(v, /–/, `${k} carries an en-dash in ${lang}`);
    }
    assert.notEqual(I18N.en[k], I18N.es[k], `${k} is untranslated`);
  }
  for (const lang of ['en', 'es']) {
    assert.match(I18N[lang]['nine11.body'], /\{a\}/, 'the agency placeholder must survive translation');
    assert.match(I18N[lang]['nine11.body'], /\{areas\}/);
    assert.match(I18N[lang]['alert.agency'], /\{a\}/);
  }
});
