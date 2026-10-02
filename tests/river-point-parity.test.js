'use strict';

/* River names in flood warnings. feed.xml names a river warning by the forecast point its own
   segment covers (scripts/gen-feeds.py river_point), and the Feed's warning cards name the same
   point from js/sources.js alertRiverPoint. Two implementations of one rule drift silently (E5),
   so this runs BOTH, the real Python and the shipped JS, over the same texts and requires the same
   answer, then checks what the Feed card shows. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadApp } = require('./harness.js');
const I18N = require('./i18n-load.js');

const app = loadApp();
const SB = app._sandbox;
const { state } = app;

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'river-points.json'), 'utf8'));
const FULL = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'alerts-river-products-full.json'), 'utf8'));
const GEN = path.join(__dirname, '..', 'scripts', 'gen-feeds.py');

const PY = [
  'import importlib.util, json, sys',
  "spec = importlib.util.spec_from_file_location('gen_feeds', sys.argv[1])",
  'g = importlib.util.module_from_spec(spec)',
  'spec.loader.exec_module(g)',
  'print(json.dumps([g.river_point(p) for p in json.load(sys.stdin)]))',
].join('\n');

const python = (props) => JSON.parse(execFileSync('python3', ['-c', PY, GEN], { input: JSON.stringify(props), encoding: 'utf8' }));
const js = (props) => props.map((p) => SB.alertRiverPoint(p));

test('the Python feed and the JS board name the same river point for every fixture text', () => {
  const props = FIX.cases.map((c) => ({ description: c.description }));
  const py = python(props);
  const mine = js(props);
  FIX.cases.forEach((c, i) => {
    assert.equal(mine[i], py[i], `parity: ${c.name}`);
    assert.equal(mine[i], c.expect, `expected value: ${c.name}`);
  });
});

test('parity holds over untruncated river products from api.weather.gov, and every name is a whole phrase', () => {
  const props = FULL.features.map((f) => f.properties);
  const py = python(props);
  assert.deepEqual(js(props), py);
  const named = py.filter(Boolean);
  assert.ok(named.length >= 12, `the capture names ${named.length} of ${py.length} products; a parser that names nothing passes parity`);
  props.forEach((p, i) => {
    if (!py[i]) return;
    const flat = p.description.split(/\s+/).join(' ');
    const at = flat.indexOf(py[i]);
    assert.ok(at >= 0 && !/[A-Za-z]/.test(flat.charAt(at + py[i].length)), `"${py[i]}" is cut mid-word or not in the text`);
  });
  assert.ok(py.includes('Trinity River at Dallas'), 'the Texas warning in the capture is named');
  assert.ok(py.includes('Purgatoire River near Purgatoire R near Las Animas'), 'a header wrapped after "in" is still read');
});

/* ---------------- the Feed warning card ---------------- */

const DESC = Object.fromEntries(FIX.cases.map((c) => [c.name, c.description]));
let etn = 100;
function warning(event, desc, area, ugc) {
  const n = String(++etn).padStart(4, '0');
  const iso = (h) => new Date(Date.now() + h * 3600000).toISOString();
  const f = { id: `https://api.weather.gov/alerts/urn:oid:test.${n}`, type: 'Feature', geometry: null, properties: {
    id: `urn:oid:test.${n}`, event, areaDesc: area, geocode: { UGC: [ugc] }, severity: 'Severe', urgency: 'Expected', certainty: 'Likely',
    headline: `${event} issued by NWS`, description: desc, sent: iso(-1), effective: iso(-1), onset: iso(-1), expires: iso(12), ends: iso(12),
    parameters: { VTEC: [`/O.NEW.KEWX.FL.W.${n}.000000T0000Z-261003T0800Z/`] } } };
  f._sev = SB.alertSeverity(f.properties);
  return f;
}

function situation(alerts) {
  const base = {
    alerts, gauges: [], gaugesDegraded: [], roadClosures: { lines: [], points: [] }, roadsUnknown: false,
    roadsFallbackAt: null, snapshotAt: null, alertsLoadedOnce: true, seedsLoadedOnce: false, sheltersUnknown: false,
    sourceHealth: { alerts: Date.now(), gauges: Date.now(), roads: Date.now() }, sourceFailed: {}, trendHist: {}, records: {}, pb: null,
  };
  const keep = { t: SB.t };
  for (const k of Object.keys(base)) keep[k] = state[k];
  Object.assign(state, base);
  SB.t = (k) => (I18N.en[k] !== undefined ? I18N.en[k] : k);
  try {
    const m = SB.situationModel();
    const { html } = SB.situationView(m);
    const cards = [...html.matchAll(/<button type="button" class="sit-card[^"]*" data-sit="\d+"[^>]*><span class="sit-card-title">([\s\S]*?)<\/span>(?:<span class="sit-card-sub">([\s\S]*?)<\/span>)?<\/button>/g)]
      .map((x) => ({ title: x[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), sub: x[2] || '' }));
    return { m, cards };
  } finally {
    SB.t = keep.t;
    delete keep.t;
    Object.assign(state, keep);
  }
}

test('a Flood Warning card names each river its warnings cover, as the RSS titles them, and nothing for one it cannot read', () => {
  const alerts = [
    warning('Flood Warning', DESC['segment WHERE line names its own point, wrapped across two lines'], 'Val Verde, TX', 'TXC465'),
    warning('Flood Warning', DESC['the other segment of the same product names the other point'], 'Val Verde, TX', 'TXC465'),
    warning('Flood Warning', DESC['several preamble points and no WHERE line name nothing rather than guess'], 'Kinney, TX', 'TXC271'),
  ];
  const { m, cards } = situation(alerts);
  const g = m.groups.find((x) => x.event === 'Flood Warning');
  assert.deepEqual(Array.from(g.rivers).sort(),
    ['Devils River at Bakers Crossing 19N Of Comstock', 'Devils River at Pafford Crossing nr Comstock']);
  const card = cards.find((c) => c.title.includes('Flood Warning'));
  const parts = card.sub.split(' · ');
  assert.deepEqual(parts[0].split('; ').sort(), Array.from(g.rivers).sort(), card.sub);
  assert.deepEqual(parts[1].split(', ').sort(), ['Kinney', 'Val Verde'], 'the counties still follow, the unnamed warning\'s county among them');
  assert.ok(parts[2].startsWith('until '), card.sub);
});

test('a card whose rivers cannot be read is unchanged: areas, then until', () => {
  const alerts = [
    warning('Flood Warning', DESC['several preamble points and no WHERE line name nothing rather than guess'], 'Val Verde, TX', 'TXC465'),
    warning('Flood Advisory', DESC["an areal warning's WHERE is a county list, never a river point"], 'Bosque, TX', 'TXC035'),
  ];
  const { m, cards } = situation(alerts);
  for (const g of m.groups) assert.equal(g.rivers.length, 0, g.event);
  for (const c of cards) {
    const parts = c.sub.split(' · ');
    assert.equal(parts.length, 2, c.sub);
    assert.ok(parts[1].startsWith('until '), c.sub);
  }
});

test('more rivers than the card has room for are counted, not dropped', () => {
  const names = ['Brazos River near Rosharon', 'San Bernard River near Boling', 'Navasota River near Easterly', 'Neches River at Evadale', 'Sabine River near Deweyville'];
  const alerts = names.map((n) => warning('Flood Warning',
    `...The Flood Warning continues for the following rivers in Texas...\n\n${n} affecting Fort Bend County.\n\n* WHERE...${n}.\n\n* WHEN...Until further notice.`,
    'Fort Bend, TX', 'TXC157'));
  const { cards } = situation(alerts);
  const sub = cards.find((c) => c.title.includes('Flood Warning')).sub;
  const lead = sub.split(' · ')[0];
  assert.equal(lead.split('; ').length, 3);
  assert.ok(lead.endsWith(' +2 more'), lead);
});

/* ---------------- the Alerts tab names the same point ---------------- */

const reachOf = (html) => {
  const m = /<span class="alert-reach">([^<]*)<\/span>/.exec(html);
  return m ? m[1] : null;
};

test('the Alerts tab card and map popup name each segment of a two-point product by its own point, as the Feed does', () => {
  const bakers = warning('Flood Warning', DESC['segment WHERE line names its own point, wrapped across two lines'], 'Val Verde, TX', 'TXC465');
  const pafford = warning('Flood Warning', DESC['the other segment of the same product names the other point'], 'Val Verde, TX', 'TXC465');
  const { m } = situation([bakers, pafford]);
  const feed = Array.from(m.groups.find((g) => g.event === 'Flood Warning').rivers);
  for (const [f, want] of [[bakers, 'Devils River at Bakers Crossing 19N of Comstock'], [pafford, 'Devils River at Pafford Crossing near Comstock']]) {
    const card = SB.alertCardDiv(f, null).innerHTML;
    assert.equal(reachOf(card), want, 'both segments preamble-list Pafford first; the card follows its own WHERE line');
    assert.ok(SB.alertPopupHtml(f).includes(` · ${want}</div>`), SB.alertPopupHtml(f));
    assert.ok(feed.some((x) => x.toLowerCase() === want.replace(' near ', ' nr ').toLowerCase()),
      `the Feed names the same point, in the NWS casing: ${feed.join(' | ')}`);
  }
});

test('a product listing several points with no WHERE line names none in the Alerts tab rather than the first', () => {
  const f = warning('Flood Warning', DESC['several preamble points and no WHERE line name nothing rather than guess'], 'Val Verde, TX', 'TXC465');
  assert.equal(SB.alertReach(f.properties), '');
  assert.equal(reachOf(SB.alertCardDiv(f, null).innerHTML), null);
  // outside the river-product shape, a lone "X affecting" reach is still named, and two are not
  assert.equal(SB.alertReach({ description: 'rivers in Texas... Nueces River At Cotulla affecting La Salle County.' }), 'Nueces River at Cotulla');
  assert.equal(SB.alertReach({ description: 'rivers in Texas... Nueces River At Cotulla affecting La Salle County. Frio River At Tilden affecting McMullen County.' }), '');
});
