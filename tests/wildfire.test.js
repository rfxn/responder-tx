/* Wildfire incidents. Two claims this layer must never make: that a point is the edge of the
   fire, and that an unreported acreage or containment is a measurement. WFIGS omits containment
   on about two thirds of its records, so a popup that prints "0% contained" for a null asserts
   an uncontained fire nobody reported. The other half of the file is the empty state: Texas has
   no active wildfires for most of the year, and a blank layer that says nothing reads as broken. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadApp, loadMapApp, loadFullApp, loadWiredMap } = require('./harness.js');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// the "?" glossary lives in js/boot.js and paints into #glossary-body, so the bundle with boot.js
// in it builds the panel for real rather than the file being regexed for the key
function glossaryHtml() {
  const SB = loadFullApp()._sandbox;
  const body = { innerHTML: '' };
  const prev = SB.document.querySelector;
  SB.document.querySelector = (sel) => (sel === '#glossary-body' ? body : null);
  try { SB.renderGlossary(); } finally { SB.document.querySelector = prev; }
  return body.innerHTML;
}

const app = loadApp();
const { wildfirePopupHtml, wildfireNoticeText, wildfireStale, wildfireContained, wildfireAgeH,
  WILDFIRE_STALE_H, state } = app;

function loadI18N() {
  const sandbox = {
    console, URLSearchParams,
    location: { search: '' },
    document: { documentElement: {}, querySelectorAll: () => [], title: '' },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { language: 'en' },
    window: {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('js/i18n.js'), sandbox);
  return sandbox.window.I18N;
}
const I18N = loadI18N();

const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
const SOURCES = [
  { key: 'tfs', name: 'Texas A&M Forest Service', url: 'https://tfswildfires.com/public/',
    status: 'ok', captured: hoursAgo(0.1), count: 1 },
  { key: 'wfigs', name: 'National Interagency Fire Center (WFIGS)',
    url: 'https://data-nifc.opendata.arcgis.com/', status: 'ok', captured: hoursAgo(0.2), count: 1 },
];
const FIRE = { id: 'tfs:1', src: 'tfs', name: 'Upshur 6318', lat: 32.575, lon: -94.889,
  status: 'Contained', acres: 2, contain: 100, county: 'Upshur', state: 'TX',
  observed: hoursAgo(1), started: hoursAgo(6), unit: 'TXTXS' };

// the popup and the notice both read state, so each case sets the whole payload it describes
function withData(doc, fn) {
  const prev = state.wildfire;
  state.wildfire = doc;
  try { return fn(); } finally { state.wildfire = prev; }
}
const popup = (fire, sources) =>
  withData({ generated: hoursAgo(0.1), sources: sources || SOURCES, fires: [fire] },
    () => wildfirePopupHtml(fire));

test('an unreported acreage or containment is named as unreported, never rendered as zero', () => {
  const html = popup({ ...FIRE, src: 'wfigs', acres: null, contain: null });
  // the size and containment rows are always drawn, so an unreported figure is a visible gap
  assert.match(html, /wf\.k\.size/, 'the size row is drawn even when nothing was reported');
  assert.match(html, /wf\.k\.contain/, 'the containment row is drawn even when nothing was reported');
  assert.match(html, /wf\.unreported/, 'a null figure must name itself unreported');
  assert.match(html, /wf-unknown/, 'and must be drawn as a gap rather than as a value');
  assert.doesNotMatch(html, /wf\.contain'|wf\.contain"/, 'a null containment must not reach the "{n}% contained" string');
  assert.doesNotMatch(html, /\b0%/, 'a null containment rendered as 0% asserts an uncontained fire nobody reported');
  for (const lang of ['en', 'es']) {
    assert.match(I18N[lang]['wf.unreported'], /not reported|no reportado/i);
  }

  // a genuinely reported zero is still a reported figure and must survive
  const zero = popup({ ...FIRE, src: 'wfigs', acres: 0, contain: 0 });
  assert.match(zero, /wf\.contain/, 'a reported 0% is a fact the source published');
  assert.doesNotMatch(zero, /wf\.unreported/, 'a reported 0 is not an unreported figure');
  assert.doesNotMatch(zero, /wf-unknown/);
});

test('the popup credits the operator that reported the incident, never the other source', () => {
  const html = popup(FIRE);
  assert.match(html, /Texas A&amp;M Forest Service/, 'a TFS incident must be credited to TFS');
  assert.doesNotMatch(html, /National Interagency/, 'crediting NIFC for a state incident is a false citation');
  const fed = popup({ ...FIRE, id: 'wfigs:1', src: 'wfigs', name: 'Frontera' });
  assert.match(fed, /National Interagency/);
  assert.doesNotMatch(fed, /Texas A&amp;M/);
});

test('the popup says what the numbers are and what the point is, so neither is read as an observation', () => {
  const html = popup(FIRE);
  assert.match(html, /wf\.lag/, 'acreage and containment are reported figures, and the popup must say so');
  assert.match(html, /wf\.point/, 'the point is the reported origin, not the edge of the fire');
  assert.match(html, /wf\.k\.updated/, 'the popup must state when the incident record was last updated');
  for (const lang of ['en', 'es']) {
    assert.match(I18N[lang]['wf.point'], /perimet|perímet/i, 'the string must say what a perimeter means here');
    assert.match(I18N[lang]['wf.lag'], /hours|horas/i, 'the string must say the figures can lag');
  }
  // a source that published no build stamp says its currency is unknown rather than staying silent
  const nostamp = popup(FIRE, [{ ...SOURCES[0], captured: null }, SOURCES[1]]);
  assert.match(nostamp, /wf\.nocurrency/);
  assert.doesNotMatch(popup(FIRE), /wf\.nocurrency/, 'a stamped source must not claim its currency is unknown');
});

test('an incident nobody has restamped is drawn, aged and said to be aged', () => {
  assert.equal(wildfireStale(FIRE), false);
  assert.equal(wildfireStale({ ...FIRE, observed: hoursAgo(WILDFIRE_STALE_H + 1) }), true);
  assert.equal(wildfireStale({ ...FIRE, observed: null }), true, 'an undated record cannot be asserted as current');
  assert.ok(Math.abs(wildfireAgeH(FIRE) - 1) < 0.1);
  const old = popup({ ...FIRE, observed: hoursAgo(31) });
  assert.match(old, /wf\.stale/, 'past the window the popup must say how long it has been');
  assert.match(old, /xg-stale/, 'the age warning uses the board staleness treatment');
  assert.doesNotMatch(popup(FIRE), /wf\.stale/);
});

test('contained is read from a reported figure or a reported word, never guessed from acreage', () => {
  assert.equal(wildfireContained(FIRE), true);
  assert.equal(wildfireContained({ ...FIRE, contain: 40, status: 'Active' }), false);
  assert.equal(wildfireContained({ ...FIRE, contain: null, status: 'Contained' }), true);
  assert.equal(wildfireContained({ ...FIRE, contain: null, status: null }), false,
    'no reported containment and no reported word is not a contained fire');
  assert.equal(wildfireContained({ ...FIRE, contain: null, status: null, acres: 0.1 }), false,
    'a small fire is not a contained one');
});

test('the empty state is an honest sentence, and a failed source can never produce it', () => {
  const empty = withData({ generated: hoursAgo(0.1), sources: SOURCES, fires: [] }, wildfireNoticeText);
  assert.equal(empty, 'wf.none', 'zero incidents with both sources healthy is a reportable absence');
  for (const lang of ['en', 'es']) {
    assert.match(I18N[lang]['wf.none'], /Texas A&M Forest Service/, 'the empty sentence must name the operator');
    assert.match(I18N[lang]['wf.none'], /\{t\}/, 'the empty sentence must state as of when');
  }

  const undated = withData({ generated: hoursAgo(0.1), fires: [],
    sources: SOURCES.map((s) => ({ ...s, captured: null })) }, wildfireNoticeText);
  assert.equal(undated, 'wf.none.undated', 'an absence with no upstream stamp cannot claim an as-of time');

  const partial = withData({ generated: hoursAgo(0.1), fires: [],
    sources: [SOURCES[0], { ...SOURCES[1], status: 'failed', captured: null, count: null }] },
  wildfireNoticeText);
  assert.equal(partial, 'wf.partial', 'a half-read list must not be presented as a complete absence');

  const allDown = withData({ generated: hoursAgo(0.1), fires: [],
    sources: SOURCES.map((s) => ({ ...s, status: 'failed', captured: null, count: null })) },
  wildfireNoticeText);
  assert.equal(allDown, 'wf.unknown');
  for (const lang of ['en', 'es']) {
    assert.match(I18N[lang]['wf.unknown'], /not a report|no es un informe/i,
      'an unreadable feed must not read as "no fires are burning"');
    assert.match(I18N[lang]['wf.partial'], /incomplete|incompleta/i);
  }

  // a healthy day with incidents needs no sentence: the markers are the answer
  assert.equal(withData({ generated: hoursAgo(0.1), sources: SOURCES, fires: [FIRE] }, wildfireNoticeText), '');
});

/* Switching the layer on is the ONLY thing that loads it, and initMap() is where that is decided.
   v0.99.79's sibling failure is a commented-out wiring line, which every source-text assertion
   about js/map.js still matches. These run initMap() and fire the real event. */
test('turning the overlay on is what loads the layer, and no other overlay does', () => {
  const w = loadWiredMap();
  const calls = w.spyOn('fetchWildfire', 'fetchLwc', 'fetchRiverSentry', 'loadCameras');
  w.fire('overlayadd', { layer: w.layers.wildfire });
  assert.deepEqual(calls.names(), ['fetchWildfire'],
    'switching the wildfire overlay on must load the wildfire layer, and only it');
  calls.length = 0;
  for (const other of ['lwc', 'riverSentry', 'mrms', 'inundation']) {
    w.fire('overlayadd', { layer: w.layers[other] });
  }
  assert.ok(!calls.names().includes('fetchWildfire'), 'no other overlay may load the wildfire layer');
});

test('the layer ships off by default and the sheet row says which agency stands behind it', () => {
  const w = loadWiredMap();
  const S = w.sandbox;
  assert.ok(S.layerRowKeys().includes('wildfire'), 'the layer has no user-facing sheet row');
  assert.equal(S.layerRowOn('wildfire'), false, 'the layer must not be on the map at boot');
  assert.ok(!S.collectLayerState().on.includes('wildfire'), 'and must not be in the default saved set');

  // renderLayerSheet writes the real markup; the DOM answers only the nodes it is asked for, so a
  // node the shipped code starts needing shows up as a failure rather than as a silent pass
  const body = { innerHTML: '', scrollTop: 0 };
  const sheet = {
    querySelector: (sel) => ({
      '.ls-head strong': { textContent: '' },
      '.ls-close': { title: '' },
      '.ls-note': { hidden: true, textContent: '' },
      '.ls-body': body,
    }[sel] || null),
  };
  const prevGet = S.document.getElementById;
  try {
    S.document.getElementById = (id) => (id === 'layer-sheet' ? sheet : null);
    S.renderLayerSheet();
  } finally { S.document.getElementById = prevGet; }
  const row = body.innerHTML.slice(body.innerHTML.indexOf('data-layer="wildfire"'));
  assert.ok(row, 'the sheet renders no wildfire row');
  assert.match(row.slice(0, 400), /aria-checked="false"/, 'the row renders as already on');
  assert.match(row.slice(0, 400), /wildfire-icon/, 'the row carries no fire glyph');
  assert.match(row.slice(0, 400), /src-official/, 'the row does not claim the agency provenance it has');
  assert.match(row.slice(0, 400), /sheet\.s\.wildfire/, 'the row has no subtitle');
  assert.match(body.innerHTML.slice(0, body.innerHTML.indexOf('data-layer="wildfire"')).slice(-200),
    /sheet\.g\.fire/, 'the row is not filed under the fire group');
});

test('the layer is named in the legend and the glossary, and hides under playback', () => {
  const legend = mapApp._sandbox.mapLegendHtml();
  for (const k of ['legend.wildfire', 'legend.wildfire.perim', 'legend.wildfire.area']) {
    assert.ok(legend.includes(k), `the map legend does not name ${k}`);
  }
  assert.match(legend, /wildfire-icon/, 'the legend names the layer without showing its glyph');
  const glossary = glossaryHtml();
  assert.match(glossary, /glossary\.wildfire/, 'the glossary does not name the marker');
  assert.match(glossary, /wildfire-icon/, 'the glossary names the marker without showing its glyph');
  const hidden = mapApp.pbLiveHideAll().find(([k]) => k === 'wildfire');
  assert.ok(hidden, 'there is no incident archive, so a live wildfire layer under playback impersonates the past');
  assert.equal(hidden[1], 'layers.wildfire', 'playback must be able to name the layer it took away');
});

test('the layer travels in a shared link, in both directions and without stacking on a kept view', () => {
  const w = loadWiredMap();
  const S = w.sandbox;
  const prev = S.document.querySelector;
  try {
    // buildShareUrl reads the feed filter controls; anything else it asks for it must handle as absent
    S.document.querySelector = (sel) => ({ '#flt-alert-sev': { value: '' }, '#flt-alert-q': { value: '' } }[sel] || null);
    assert.ok(!/[?&]fire=/.test(S.buildShareUrl()), 'a link built with the layer off must not carry ?fire=');
    w.layers.wildfire.addTo(w.map);
    assert.match(S.buildShareUrl(), /[?&]fire=1\b/, 'a shared link silently drops the wildfire layer');
  } finally { S.document.querySelector = prev; }
  // the inbound ?fire=1 parser lives inside boot(), which cannot be called: matched, not run
  const boot = read('js/boot.js').match(/for \(const \[qk, lk\] of \[\['usgs'[\s\S]*?\]\) \{/);
  assert.ok(boot, 'the share-param parser was not found');
  assert.match(boot[0], /\['fire', 'wildfire'\]/, 'an incoming ?fire=1 link does not reopen the layer');
  assert.ok(app.LINK_VIEW_PARAMS.includes('fire'), 'a link carrying ?fire= must win over the kept layer set');
});

test('the marker reads as a hazard, retires when contained and dashes when unrestamped', () => {
  const css = read('css/app.css');
  const rule = (css.match(/\.wildfire-icon \{([^}]*)\}/) || [])[1];
  assert.ok(rule, '.wildfire-icon has no rule');
  assert.match(rule, /border-radius:\s*50%/, 'a hazard marker is a circle on this map');
  assert.match(rule, /var\(--haz-fire\)/, 'the marker must carry the fire hazard token');
  assert.ok(!/--sev-|--cat-/.test(rule),
    'the marker borrows a severity colour, but neither source publishes a severity');
  assert.match(css, /\.wildfire-icon\.contained \{/, 'a contained incident has no retired treatment');
  assert.match(css, /\.wildfire-icon\.unconfirmed \{[^}]*dashed/, 'an aged incident is drawn as current');
  assert.match(css, /\.leaflet-marker-pane \.wildfire-icon::before/, 'the marker has no phone tap halo');
  for (const theme of [':root {', ':root[data-theme="light"] {']) {
    const block = css.slice(css.indexOf(theme), css.indexOf('}', css.indexOf(theme)));
    assert.match(block, /--haz-fire:/, `--haz-fire is missing from the ${theme} block`);
  }
  // the render applies all three classes off the record, not off a hand-set flag
  // FIRE_PT carries a fixed observed stamp that has since aged out, so the base is restamped here
  const cls = (fire) => iconHtml(markerFor(Object.assign({}, FIRE_PT, { observed: hoursAgo(1) }, fire)));
  assert.match(cls({}), /class="wildfire-icon"/, 'an active, freshly restamped fire wears neither treatment');
  assert.match(cls({ contain: 100 }), /class="wildfire-icon contained"/,
    'a contained incident must be drawn as retired');
  assert.match(cls({ observed: hoursAgo(WILDFIRE_STALE_H + 1) }), /class="wildfire-icon unconfirmed"/,
    'an incident nobody has restamped must be drawn as unconfirmed');
  assert.match(cls({ contain: 100, observed: null }), /class="wildfire-icon contained unconfirmed"/,
    'an undated contained incident is both, and neither class may drop the other');
});

test('every wildfire string exists in both languages and carries no em-dash', () => {
  const i18n = read('js/i18n.js');
  const keys = ['layers.wildfire', 'sheet.s.wildfire', 'legend.wildfire', 'glossary.wildfire',
    'glossary.wildfire.label', 'wf.county', 'wf.acres', 'wf.contain',
    'wf.stale', 'wf.lag', 'wf.point', 'wf.captured', 'wf.nocurrency', 'wf.none',
    'wf.none.undated', 'wf.partial', 'wf.unknown', 'note.wildfirefail',
    'wf.unreported', 'wf.nearby', 'wf.crew', 'wf.k.size', 'wf.k.contain', 'wf.k.where',
    'wf.k.cause', 'wf.k.started', 'wf.k.updated', 'wf.k.unit', 'wf.k.org', 'wf.k.crew',
    'wf.k.number', 'wf.k.method', 'wf.k.mapped', 'wf.unnamed', 'wf.perim.sub',
    'legend.wildfire.perim'];
  for (const k of keys) {
    assert.equal((i18n.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) || []).length, 2,
      `${k} is missing from en or es`);
    for (const lang of ['en', 'es']) {
      assert.ok(I18N[lang][k], `${k} is empty in ${lang}`);
      assert.ok(!I18N[lang][k].includes('—'), `em-dash in ${lang} ${k}`);
    }
  }
  /* The layer draws perimeters where an agency publishes one (most fires have none), so the
     strings have to carry BOTH halves: the marker is an origin point, and a missing outline means
     unmapped rather than small. Dropping either half turns an absence into a claim about size. */
  for (const k of ['sheet.s.wildfire', 'glossary.wildfire']) {
    for (const lang of ['en', 'es']) {
      assert.match(I18N[lang][k], /perimet|perímet/i, `${k} must address perimeters: ${I18N[lang][k]}`);
      assert.match(I18N[lang][k], /origin|origen/i, `${k} must still call the marker an origin point`);
    }
  }
  for (const lang of ['en', 'es']) {
    assert.match(I18N[lang]['glossary.wildfire'], /never|nunca/i,
      'the glossary must say a missing perimeter is never a statement about the size of the fire');
  }
});

test('the shipped incident file, when present, matches what the client and the gate both expect', () => {
  const p = path.join(ROOT, 'data', 'wildfire.json');
  if (!fs.existsSync(p)) return; // the generator may never have run on this checkout
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.match(d.generated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(Array.isArray(d.sources) && d.sources.length, 'a payload naming no source cannot be credited');
  const ok = new Set(d.sources.filter((s) => s.status === 'ok').map((s) => s.key));
  for (const f of d.fires) {
    assert.ok(ok.has(f.src), `${f.id} credits a source that is not marked ok`);
    assert.ok(Number.isFinite(f.lat) && Number.isFinite(f.lon), `${f.id} has no usable point`);
    for (const k of ['acres', 'contain']) {
      assert.ok(f[k] === null || typeof f[k] === 'number', `${f.id} ${k} is neither a number nor null`);
    }
  }
  assert.ok(!fs.readFileSync(p, 'utf8').includes('—'), 'em-dash in data/wildfire.json');
});

test('a fire in the border buffer is marked as near Texas, not presented as a Texas fire', () => {
  const near = popup({ ...FIRE, src: 'wfigs', scope: 'buffer', state: 'LA' });
  assert.match(near, /wf\.nearby/, 'an out-of-state fire must say it is only near Texas');
  assert.match(near, /wf-tag is-near/);
  assert.doesNotMatch(popup({ ...FIRE, scope: 'tx' }), /wf\.nearby/,
    'a Texas fire must not be labelled as merely nearby');
  for (const lang of ['en', 'es']) assert.match(I18N[lang]['wf.nearby'], /texas/i);
});

test('the richer metadata rows appear only when the source reported them', () => {
  const bare = popup({ ...FIRE, src: 'wfigs', cause: null, org: null, crew: null, number: null });
  for (const k of ['wf.k.cause', 'wf.k.org', 'wf.k.crew', 'wf.k.number']) {
    assert.doesNotMatch(bare, new RegExp(k.replace(/\./g, '\\.')),
      `${k} must be absent rather than drawn empty, since most records do not carry it`);
  }
  const full = popup({ ...FIRE, src: 'wfigs', cause: 'Human', org: 'Type 3', crew: 42, number: '266318' });
  for (const k of ['wf.k.cause', 'wf.k.org', 'wf.k.crew', 'wf.k.number']) {
    assert.match(full, new RegExp(k.replace(/\./g, '\\.')), `${k} must be drawn when reported`);
  }
  assert.match(full, /Human/);
});

/* Both layers are rendered here rather than read, because the claim is about what Leaflet ends up
   stacking: the pane orders by latitude, so a gauge a little to the south was taking the click off
   a fire glyph the user could see. */
test('the fire marker outranks every gauge, so a gauge cannot take the click off a fire glyph', () => {
  const fire = markerFor(FIRE_PT).opts.zIndexOffset;
  assert.ok(Number.isFinite(fire), 'the wildfire marker must declare a zIndexOffset');
  const iso = (min) => new Date(Date.now() - min * 60000).toISOString();
  const gauge = (cat) => ({ lid: `T-${cat}`, name: 'Test River', latitude: 30, longitude: -98,
    status: { observed: { floodCategory: cat, primary: 12.3, primaryUnit: 'ft', validTime: iso(30) } } });
  const offsets = gaugesDrawn(['major', 'moderate', 'minor', 'action', 'no_flooding'].map(gauge))
    .filter((o) => o.kind === 'marker').map((o) => o.opts.zIndexOffset);
  assert.ok(offsets.length, 'no gauge markers were drawn; the comparison below would be vacuous');
  const gaugeMax = Math.max(...offsets);
  assert.ok(gaugeMax > 0, 'the gauge ceiling read as 0, so this test would pass on any fire offset');
  assert.ok(fire > gaugeMax, `fire zIndexOffset ${fire} must exceed the gauge maximum ${gaugeMax}`);
});

test('the popup facts grid puts labels and values in it directly, not inside a row wrapper', () => {
  const html = popup(FIRE);
  assert.match(html, /<dl class="wf-facts">/, 'the facts block must be the grid container itself');
  assert.match(html, /<dt class="wf-k">/, 'labels must be direct grid children');
  assert.match(html, /<dd class="wf-v/, 'values must be direct grid children');
  // a wrapper per row becomes one grid item, which packs two rows per line and butts the label
  // against its value: that is the jumbled render this asserts against
  assert.doesNotMatch(html, /class="wf-row"/, 'a per-row wrapper breaks the two-column grid');
  const css = read('css/app.css');
  assert.match(css, /\.wf-facts \{[^}]*grid-template-columns/, 'the grid columns must be declared');
  assert.match(css, /\.wf-v \{[^}]*margin: 0/, 'dd carries a default indent that must be reset');
});

/* ---------- perimeters: an edge where one is published, and no claim where none is ---------- */

test('rings_of keeps outer rings only and rejects a degenerate ring', () => {
  const src = read('scripts/gen-wildfire.py');
  assert.match(src, /def rings_of\(geom\)/);
  // holes are dropped on purpose; an unburnt island is not an operational fact at this zoom
  assert.match(src, /coords\[:1\]/, 'Polygon must take the outer ring only');
  assert.match(src, /poly\[0\] for poly in coords/, 'MultiPolygon must take each outer ring');
  assert.match(src, /len\(r\) >= 4/, 'a ring with under 4 points is not a polygon');
});

test('a perimeter is in scope when ANY vertex is, not just its centre', () => {
  const src = read('scripts/gen-wildfire.py');
  const fn = src.slice(src.indexOf('def collect_perimeters'), src.indexOf('def rings_of'));
  assert.match(fn, /for ring in rings:/, 'the scope test must walk the ring');
  assert.match(fn, /scope_of\(lat, lon, scope\[0\], scope\[1\]\)/,
    'it must reuse the same scope test the incident points use');
  // a horseshoe fire can have its centroid outside its own burn, and a border fire is still ours.
  // Comments are stripped first: the code's own note names the approach it deliberately avoids.
  const code = fn.replace(/#.*$/gm, '');
  assert.ok(!/centroid|center|centre/i.test(code), 'a centroid test would drop border and horseshoe fires');
});

test('the perimeter read is generalized and bounded, so one geometry cannot become the payload', () => {
  const src = read('scripts/gen-wildfire.py');
  assert.match(src, /PERIM_OFFSET = "0\.0005"/, 'server-side generalization must stay on');
  assert.match(src, /"maxAllowableOffset": PERIM_OFFSET/);
  assert.match(src, /PERIM_MAX_VERTS/, 'an unbounded geometry must be refused, not published');
  assert.match(src, /raise ValueError\(f"WFIGS perimeters still reports more rows/,
    'a truncated perimeter read must raise: a short set would draw a fire smaller than it is');
});

test('a perimeter failure is published as failed and never sinks the incident layer', () => {
  const src = read('scripts/gen-wildfire.py');
  assert.match(src, /"wfigs-perimeters": \{"name"/, 'the perimeter read needs its own source entry');
  // E1: the points are the board's answer; an enrichment that fails must not empty the layer
  assert.match(src, /if all\(s\["status"\] == "failed" for s in \(tfs_src, wfigs_src\)\):/,
    'the fatal check must consider the two incident sources, not the perimeter read');
});

test('the client draws perimeters under the points and states what the geometry is', () => {
  const drawn = renderDrawn({ sources: [], fires: [FIRE_PT], perimeters: [PERIM] });
  assert.deepEqual(drawn.map((o) => o.kind), ['polygon', 'marker'],
    'the perimeter must be added before the marker so the origin point stays clickable');
  // the file stores lon,lat like the GeoJSON it came from; Leaflet wants lat,lng.
  // Array.from re-homes the sandbox's arrays: deepEqual compares prototypes across realms.
  assert.deepEqual(Array.from(drawn[0].args[0], (p) => [p[0], p[1]]),
    PERIM.rings[0].map(([lon, lat]) => [lat, lon]),
    'stored lon,lat must be flipped for Leaflet, or the perimeter lands in the wrong hemisphere');
  // the popup has to say the edge is an interpretation, not a measurement
  assert.match(I18N.en['wf.perim.sub'], /interpretation/i);
  assert.match(I18N.es['wf.perim.sub'], /interpretaci/i);
});


/* ---------- the render actually runs ----------
   v0.99.79 shipped renderPerimeters() calling num(), which is a const local to
   wildfirePopupHtml. It threw ReferenceError on the first paint, fetchWildfire()'s catch turned
   that into "wildfire incidents unavailable", and the whole layer went dark including the incident
   points that had worked for weeks. Every client test in that release asserted on SOURCE TEXT, so
   all of them passed. These execute the render instead. */

const mapApp = loadMapApp();

/* The harness L is a proxy that answers every call with itself, so drawn layers are
   indistinguishable and every option vanishes. This swaps in a recorder that keeps what
   renderWildfire() actually created: its kind, the options it was given, and the popup it bound.
   A lazily-bound popup is INVOKED here, because Leaflet invokes it on the first click and a
   builder reaching outside its own scope is exactly the v0.99.79 defect. */
const RECORDED_SHAPES = ['polygon', 'circle', 'marker', 'divIcon'];

function drawWith(layerName, run) {
  const MS = mapApp.state, MSB = mapApp._sandbox;
  const prev = { layers: MS.layers, L: MSB.L };
  const drawn = [];
  const shape = (kind) => (...args) => {
    const o = { kind, args, opts: args[args.length - 1] || {}, popup: undefined };
    o.bindPopup = (p) => { o.popup = typeof p === 'function' ? p() : p; return o; };
    o.addTo = () => o; o.on = () => o; o.setStyle = () => o; o.setLatLng = () => o;
    return o;
  };
  try {
    MSB.L = new Proxy({}, {
      get(_t, prop) {
        if (RECORDED_SHAPES.includes(prop)) return shape(prop);
        return () => ({ bindPopup() { return this; }, addTo() { return this; }, on() { return this; } });
      },
    });
    MS.layers = Object.assign({}, MS.layers, {
      [layerName]: { clearLayers() { drawn.length = 0; }, addLayer(l) { drawn.push(l); } },
    });
    run();
    return drawn;
  } finally { Object.assign(MS, prev); MSB.L = prev.L; }
}

function renderDrawn(data) {
  const MS = mapApp.state;
  const prev = MS.wildfire;
  try { MS.wildfire = data; return drawWith('wildfire', () => mapApp._sandbox.renderWildfire()); }
  finally { MS.wildfire = prev; }
}

function gaugesDrawn(gauges) {
  const MS = mapApp.state;
  const prev = MS.gauges;
  try { MS.gauges = gauges; return drawWith('gauges', () => mapApp._sandbox.renderGauges()); }
  finally { MS.gauges = prev; }
}

const renderInto = renderDrawn; // the count-only callers below read better this way
const iconHtml = (o) => ((o.opts.icon || {}).args || [{}])[0].html || '';
const markerFor = (fire) => renderDrawn({ sources: SOURCES, fires: [fire], perimeters: [] })
  .find((o) => o.kind === 'marker');

const PERIM = {
  id: 'wfigs-perim:{X}', irwin: '{X}', name: 'Fixture', scope: 'tx', acres: 120.5,
  observed: '2026-07-30T02:00:00Z', method: 'Image Interpretation',
  category: 'Wildfire Daily Fire Perimeter',
  rings: [[[-99, 31], [-99, 31.1], [-98.9, 31.1], [-98.9, 31], [-99, 31]]],
};
const FIRE_PT = {
  id: 'tfs:X', src: 'tfs', scope: 'tx', name: 'Point', lat: 31.5, lon: -99.5,
  status: 'Active', acres: 10, contain: null, observed: '2026-07-30T20:00:00Z',
};

test('rendering a payload with perimeters does not throw', () => {
  const added = renderInto({ generated: '2026-07-30T21:00:00Z', sources: [], fires: [FIRE_PT], perimeters: [PERIM] });
  assert.equal(added.length, 2, 'one perimeter ring plus one incident marker');
});

/* The board denied perimeters in every incident popup for six releases after it started drawing
   them. Both halves run here so the claim and the behaviour cannot drift apart again. */
test('the perimeter line in the incident popup stays true of a board that draws perimeters', () => {
  assert.equal(renderInto({ sources: [], fires: [FIRE_PT], perimeters: [PERIM] }).length, 2,
    'a mapped perimeter must actually be drawn, or the popup line below is the honest one');
  assert.match(popup(FIRE), /wf\.point/, 'the line must reach every incident popup');
  for (const lang of ['en', 'es']) {
    const s = I18N[lang]['wf.point'];
    assert.doesNotMatch(s, /no perimeters are drawn|no se dibujan perímetros/i,
      'the board draws mapped perimeters, so the popup may not deny them');
    assert.match(s, /origin|origen/i, 'the point is still the reported origin and not the fire edge');
    assert.match(s, /small|pequeñ/i, 'an absent outline must not be read as a small fire');
    assert.ok(!s.includes('—'), `em-dash in ${lang} wf.point`);
  }
});

test('a perimeter popup builds without reaching outside its own scope', () => {
  // the actual v0.99.79 defect: the popup body referenced a helper local to another function
  assert.doesNotThrow(() => mapApp._sandbox.perimeterPopupHtml(PERIM));
  const MSB = mapApp._sandbox;
  const prevT = MSB.t;
  try {
    // the harness echoes keys, so the number needs a real template to substitute into
    MSB.t = (k) => (k === 'wf.acres' ? '{n} acres' : k);
    const html = MSB.perimeterPopupHtml(PERIM);
    assert.match(html, /120\.5 acres/, 'acreage must render, not silently vanish');
    assert.match(html, /Fixture/);
  } finally { MSB.t = prevT; }
});

test('a perimeter with no acreage still builds a popup', () => {
  assert.doesNotThrow(() => mapApp._sandbox.perimeterPopupHtml(
    Object.assign({}, PERIM, { acres: null, method: null, observed: null, name: '' })));
});

test('the incident points still render when the perimeter list is absent or junk', () => {
  for (const p of [undefined, null, [], 'nonsense', [{ rings: null }], [{ rings: [[[0, 0]]] }]]) {
    const added = renderInto({ generated: 'x', sources: [], fires: [FIRE_PT], perimeters: p });
    assert.equal(added.length, 1, `incident marker must survive perimeters=${JSON.stringify(p)}`);
  }
});

test('a fire with no perimeter and a perimeter with no fire both render', () => {
  assert.equal(renderInto({ sources: [], fires: [], perimeters: [PERIM] }).length, 1);
  assert.equal(renderInto({ sources: [], fires: [FIRE_PT], perimeters: [] }).length, 1);
});

/* ---------- inferred area circles ----------
   Reported acreage as a circle of equal area, for fires with no mapped perimeter. The circle is
   centred on the reported ORIGIN and a fire spreads downwind from its origin, so it states how
   much is burning and nothing about where. Everything below guards that distinction. */

const BIG = Object.assign({}, FIRE_PT, { name: 'Steady', acres: 158, irwin: '{A}' });

test('the area floor is where the circle first beats the marker at a single-fire zoom', () => {
  const S = mapApp;
  assert.equal(S.WILDFIRE_AREA_MIN_ACRES, 100);
  // 100 acres is a 359 m radius: 22px at z13 against the marker's 13px. 50 would be 15px.
  assert.ok(Math.abs(S.fireAreaRadiusM(100) - 359) < 2, S.fireAreaRadiusM(100));
  assert.ok(Math.abs(S.fireAreaRadiusM(6000) - 2780) < 5, S.fireAreaRadiusM(6000));
  // equal-area, not a diameter or a guess: area of the drawn circle must equal the reported acreage
  const r = S.fireAreaRadiusM(158);
  assert.ok(Math.abs((Math.PI * r * r) / 4046.86 - 158) < 0.01, 'circle area must equal the acreage');
});

test('a fire at or over the floor draws a circle, one under it does not', () => {
  assert.equal(renderInto({ sources: [], fires: [BIG], perimeters: [] }).length, 2, 'circle + marker');
  const small = Object.assign({}, BIG, { acres: 99 });
  assert.equal(renderInto({ sources: [], fires: [small], perimeters: [] }).length, 1, 'marker only');
});

test('a mapped perimeter always beats an inferred circle, matched by IRWIN or by name', () => {
  const byIrwin = Object.assign({}, PERIM, { irwin: '{A}', name: 'Different Name' });
  assert.equal(renderInto({ sources: [], fires: [BIG], perimeters: [byIrwin] }).length, 2,
    'perimeter ring + marker, and no circle');
  const byName = Object.assign({}, PERIM, { irwin: '', name: 'steady' });
  assert.equal(renderInto({ sources: [], fires: [BIG], perimeters: [byName] }).length, 2,
    'a name match is case-insensitive');
  const unrelated = Object.assign({}, PERIM, { irwin: '{Z}', name: 'Elsewhere' });
  assert.equal(renderInto({ sources: [], fires: [BIG], perimeters: [unrelated] }).length, 3,
    'an unrelated perimeter must not suppress the circle');
});

test('a fire with no acreage reported draws no circle, because null is not zero', () => {
  for (const acres of [null, undefined, NaN, 'lots']) {
    const f = Object.assign({}, BIG, { acres });
    assert.equal(renderInto({ sources: [], fires: [f], perimeters: [] }).length, 1,
      `acres=${String(acres)} must not infer an area`);
  }
});

test('the circle popup says it is acreage and not the shape or reach of the fire', () => {
  const S = mapApp._sandbox;
  assert.doesNotThrow(() => S.fireAreaPopupHtml(BIG));
  for (const lang of ['en', 'es']) {
    const s = I18N[lang]['wf.area.sub'];
    assert.match(s, /shape|forma/i, `${lang} must deny it is the shape`);
    assert.match(s, /spread|extend/i, `${lang} must deny it shows where the fire reached`);
    assert.ok(!s.includes('—'), `em-dash in ${lang} wf.area.sub`);
  }
});

test('the circle is drawn unlike a perimeter, so the two are never confused', () => {
  const circle = renderDrawn({ sources: [], fires: [BIG], perimeters: [] }).find((o) => o.kind === 'circle');
  assert.ok(circle, 'no inferred area was drawn');
  assert.ok(circle.opts.dashArray, 'an inferred area must be dashed');
  assert.equal(circle.opts.fill, false, 'it must not be filled like a mapped perimeter');
  const perim = renderDrawn({ sources: [], fires: [], perimeters: [PERIM] }).find((o) => o.kind === 'polygon');
  assert.ok(perim, 'no mapped perimeter was drawn');
  assert.ok(perim.opts.fillOpacity > 0, 'the mapped perimeter keeps its fill');
  assert.ok(!perim.opts.dashArray, 'a mapped perimeter must stay solid');
});

/* ---------- an enrichment failure is not the reader's problem ----------
   Perimeters fail on about one cycle in ten and most cycles have no edge to draw anyway, so a
   board-level notice about them fired on noise the reader could neither act on nor tell apart from
   the ordinary case. It was removed in v0.99.90. The trap is the fall-through: a perimeter-only
   failure that reaches wf.partial would tell the reader the INCIDENT list is short, which is the
   overstatement v0.99.82 shipped to fix. Silence is honest because the board never claims a fire
   has no mapped edge; wf.point says an absent outline means unmapped, never small. */

const OKSRC = (key) => ({ key, name: key, url: 'u', status: 'ok', captured: '2026-07-30T00:00:00Z', count: 1 });
const BADSRC = (key) => ({ key, name: key, url: 'u', status: 'failed', captured: null, count: null });
const CARRIEDSRC = (key) => ({ key, name: key, url: 'u', status: 'carried',
  captured: '2026-07-30T00:00:00Z', count: 1, carriedFrom: '2026-07-30T00:05:00Z' });

function noticeFor(sources, fires) {
  const MS = mapApp.state, MSB = mapApp._sandbox;
  const prev = MS.wildfire;
  try {
    MS.wildfire = { generated: 'x', sources, fires: fires || [], perimeters: [] };
    return MSB.wildfireNoticeText();
  } finally { MS.wildfire = prev; }
}

test('a perimeter-only failure says nothing, and above all does not call the list short', () => {
  for (const edges of [BADSRC('wfigs-perimeters'), CARRIEDSRC('wfigs-perimeters')]) {
    const said = noticeFor([OKSRC('tfs'), OKSRC('wfigs'), edges], [FIRE_PT]);
    assert.notEqual(said, 'wf.partial',
      `edges ${edges.status} must never assert the incident list is incomplete`);
    assert.equal(said, '', `edges ${edges.status} leave the incident list whole, so there is nothing to say`);
  }
  // the removed string may not linger in either language, and no surface may ask for it
  for (const lang of ['en', 'es']) {
    assert.equal(I18N[lang]['wf.noedges'], undefined, `wf.noedges still ships in ${lang}`);
  }
  // silence stays honest only while the popup keeps saying what a missing outline means
  for (const lang of ['en', 'es']) {
    assert.match(I18N[lang]['wf.point'], /small|pequeñ/i,
      'an absent outline must still be denied as evidence of a small fire');
  }
});

test('a failed or carried edge read still draws every incident, and carried edges still draw', () => {
  const carried = renderInto({ generated: 'x', sources: [OKSRC('tfs'), OKSRC('wfigs'), CARRIEDSRC('wfigs-perimeters')],
    fires: [FIRE_PT], perimeters: [PERIM] });
  assert.equal(carried.length, 2, 'a carried perimeter is real data and must be drawn like any other');
  const lost = renderInto({ generated: 'x', sources: [OKSRC('tfs'), OKSRC('wfigs'), BADSRC('wfigs-perimeters')],
    fires: [FIRE_PT], perimeters: [] });
  assert.equal(lost.length, 1, 'the incident marker survives an edge read that produced nothing');
});

test('an incident source failing still says the list is incomplete', () => {
  assert.equal(noticeFor([BADSRC('tfs'), OKSRC('wfigs'), OKSRC('wfigs-perimeters')], [FIRE_PT]), 'wf.partial');
  // and it still reports when the edges failed in the same cycle: the two are independent facts
  assert.equal(noticeFor([BADSRC('tfs'), OKSRC('wfigs'), BADSRC('wfigs-perimeters')], [FIRE_PT]), 'wf.partial');
  assert.equal(noticeFor([BADSRC('tfs'), BADSRC('wfigs'), BADSRC('wfigs-perimeters')], []), 'wf.unknown');
  assert.equal(noticeFor([BADSRC('tfs'), BADSRC('wfigs'), OKSRC('wfigs-perimeters')], []), 'wf.unknown',
    'a healthy edge read cannot rescue an incident list nobody could read');
});

test('a fire-free day with a failed edge read is still reported as fire-free, not as partial', () => {
  const said = noticeFor([OKSRC('tfs'), OKSRC('wfigs'), BADSRC('wfigs-perimeters')], []);
  assert.equal(said, 'wf.none', 'both incident sources answered, so the absence is reportable');
  // a payload naming no incident source cannot support that sentence at all
  assert.equal(noticeFor([BADSRC('wfigs-perimeters')], []), 'wf.unknown');
  assert.equal(noticeFor([], []), 'wf.unknown');
});

/* E1: state.wildfireUnknown shipped with zero readers, so an unreadable file and a fire-free Texas
   were the same fact everywhere downstream of the fetch. Executed, not grepped. */
test('an unreadable wildfire file is unknown, and the sentence the reader gets says so', async () => {
  const MS = mapApp.state, MSB = mapApp._sandbox;
  const saved = { wildfire: MS.wildfire, unknown: MS.wildfireUnknown, loaded: MS._wildfireLoaded,
    fetch: MSB.fetch, opNotice: MSB.opNotice };
  const said = [];
  try {
    MS.wildfire = null;
    MS.wildfireUnknown = false;
    MS._wildfireLoaded = false;
    MSB.fetch = () => Promise.reject(new Error('offline'));
    MSB.opNotice = (s) => said.push(s);
    await MSB.fetchWildfire();
    assert.equal(MS.wildfireUnknown, true, 'a failed read with no last-good is unknown, not empty');
    assert.equal(MS._wildfireLoaded, false, 'and must stay retryable on the next toggle');
    // the flag has to be READ: with no payload the sentence builder otherwise reports an absence
    assert.equal(MSB.wildfireNoticeText(), 'wf.unknown',
      'an unreadable file must never produce the "no wildfire incidents" sentence');
    assert.equal(said.length, 1, 'the reader is told exactly once');
    assert.equal(said[0], 'wf.unknown', 'and is told the sources could not be read');
    for (const lang of ['en', 'es']) {
      assert.match(I18N[lang][said[0]], /not a report|no es un informe/i);
    }
  } finally {
    MS.wildfire = saved.wildfire; MS.wildfireUnknown = saved.unknown;
    MS._wildfireLoaded = saved.loaded; MSB.fetch = saved.fetch; MSB.opNotice = saved.opNotice;
  }
});

/* ---------- the lazy fetch, driven rather than described ----------
   The previous version of this block sliced fetchWildfire() out of js/sources.js and regexed the
   slice, which is the shape that let the whole layer ship dead in v0.99.79. Everything here runs it
   against a scripted transport instead. */

// Puts a scripted transport and a recording opNotice in front of the real fetchWildfire().
function driveFetch(opts) {
  const MS = mapApp.state, MSB = mapApp._sandbox;
  const o = opts || {};
  const saved = { wildfire: MS.wildfire, unknown: MS.wildfireUnknown, loaded: MS._wildfireLoaded,
    layers: MS.layers, fetch: MSB.fetch, opNotice: MSB.opNotice };
  const said = [];
  const urls = [];
  MS.wildfire = o.last || null;
  MS.wildfireUnknown = false;
  MS._wildfireLoaded = false;
  MS.layers = Object.assign({}, MS.layers,
    { wildfire: o.layer || { clearLayers() {}, addLayer() {} } });
  MSB.fetch = (url) => { urls.push(String(url)); return o.transport(String(url)); };
  MSB.opNotice = (s) => said.push(s);
  return {
    said,
    urls,
    run: () => MSB.fetchWildfire(),
    notice: () => MSB.wildfireNoticeText(),
    get unknown() { return MS.wildfireUnknown; },
    get loaded() { return MS._wildfireLoaded; },
    get payload() { return MS.wildfire; },
    restore() {
      MS.wildfire = saved.wildfire; MS.wildfireUnknown = saved.unknown;
      MS._wildfireLoaded = saved.loaded; MS.layers = saved.layers;
      MSB.fetch = saved.fetch; MSB.opNotice = saved.opNotice;
    },
  };
}
const served = (body) => () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const GOOD = { generated: '2026-07-30T21:00:00Z', sources: SOURCES, fires: [FIRE_PT], perimeters: [] };

test('the layer reads the committed same-origin file and reaches no third party', async () => {
  const d = driveFetch({ transport: served(GOOD) });
  try {
    await d.run();
    assert.equal(d.urls.length, 1, 'the layer must read exactly one file');
    assert.match(d.urls[0], /^data\/wildfire\.json\?/, 'the layer must read the committed same-origin file');
    assert.ok(!/^[a-z]+:|^\/\//i.test(d.urls[0]), 'the layer must not reach a third party at runtime');
    assert.equal(d.unknown, false);
    assert.deepEqual(d.said, [], 'a healthy day with incidents needs no sentence');
  } finally { d.restore(); }
});

test('a payload missing either list is an unreadable file, never a fire-free day', async () => {
  for (const body of [{ sources: SOURCES }, { fires: [] }, { fires: [], sources: 'nope' }, null]) {
    const d = driveFetch({ transport: served(body) });
    try {
      await d.run();
      assert.equal(d.unknown, true, `${JSON.stringify(body)} must read as unknown, not as an empty layer`);
      assert.equal(d.notice(), 'wf.unknown', 'and must never produce the "no wildfire incidents" sentence');
      assert.deepEqual(d.said, ['wf.unknown'], 'the reader is told once, and told the sources could not be read');
    } finally { d.restore(); }
  }
});

test('a pre-perimeter file is still a good file, so the edges may never be required', async () => {
  const old = { generated: 'x', sources: SOURCES, fires: [FIRE_PT] }; // no perimeters key at all
  const d = driveFetch({ transport: served(old) });
  try {
    await d.run();
    assert.equal(d.unknown, false, 'a client that rejected a pre-perimeter file would empty the layer');
    assert.equal(d.payload.fires.length, 1);
  } finally { d.restore(); }
});

/* The owner's ask in v0.99.90: the reader must get NOTHING when only the edge read failed. Driven
   through the real fetch, because it is opNotice() and not the sentence builder that reaches a
   reader, and an empty sentence still posting a banner would look identical in a unit assertion. */
test('a failed edge read reaches the reader as silence, not as a banner', async () => {
  for (const edges of [BADSRC('wfigs-perimeters'), CARRIEDSRC('wfigs-perimeters')]) {
    const d = driveFetch({ transport: served({ generated: '2026-07-30T21:00:00Z',
      sources: SOURCES.concat([edges]), fires: [FIRE_PT], perimeters: [] }) });
    try {
      await d.run();
      assert.deepEqual(d.said, [], `edges ${edges.status} must post no notice at all`);
      assert.equal(d.unknown, false, 'and the incident file was read perfectly well');
      assert.equal(d.payload.fires.length, 1, 'every incident still reaches the map');
    } finally { d.restore(); }
  }
});

test('an HTTP error and a failed read both stay retryable on the next toggle', async () => {
  const http = driveFetch({ transport: () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }) });
  try {
    await http.run();
    assert.equal(http.loaded, false, 'a failure must allow a retry the next time the layer is toggled on');
    await http.run();
    assert.equal(http.urls.length, 2, 'the retry must actually re-read the file');
  } finally { http.restore(); }

  const good = driveFetch({ transport: served(GOOD) });
  try {
    await good.run();
    assert.equal(good.loaded, true);
    await good.run();
    assert.equal(good.urls.length, 1, 'a loaded layer must not re-read on every toggle');
  } finally { good.restore(); }
});

/* v0.99.79 in one sentence: renderWildfire() threw, fetchWildfire()'s catch swallowed it, and the
   board told the reader the SOURCES were unavailable. The file had been read perfectly. */
test('a render failure is not reported as a source failure', async () => {
  const boom = { clearLayers() {}, addLayer() { throw new Error('render blew up'); } };
  const d = driveFetch({ transport: served(GOOD), layer: boom });
  try {
    await d.run();
    assert.equal(d.unknown, false,
      'the file was read, so the board may not claim the sources are unreadable');
    assert.notEqual(d.said[0], 'wf.unknown',
      'a render exception must never produce the "sources could not be read" sentence');
    assert.equal(d.said.length, 1, 'the reader must still be told something, not left with a dead layer');
    assert.equal(d.loaded, false, 'and the layer must stay retryable');
    // v0.99.79 was a render throw reported against the feed; the two faults must read differently
    assert.equal(d.said[0], 'note.wildfiredraw',
      'a render exception must name the board as the fault, not the source');
    assert.notEqual(d.said[0], 'note.wildfirefail',
      'note.wildfirefail is the refresh-failed sentence and must not cover a draw failure');
  } finally { d.restore(); }
});

/* The incident marker binds its popup LAZILY, so a builder that reaches outside its own scope
   survives the render and only throws on the first click. renderDrawn invokes what was bound. */
test('every popup the render binds is built without reaching outside its own scope', () => {
  const drawn = renderDrawn({ sources: SOURCES, fires: [BIG], perimeters: [PERIM] });
  assert.equal(drawn.length, 3, 'perimeter, marker and inferred circle must all be drawn');
  for (const o of drawn) {
    assert.equal(typeof o.popup, 'string', `the ${o.kind} bound no popup`);
    assert.ok(o.popup.includes('<div class="pop') || o.popup.includes('wf-head'),
      `the ${o.kind} popup rendered nothing usable: ${o.popup.slice(0, 80)}`);
  }
});
