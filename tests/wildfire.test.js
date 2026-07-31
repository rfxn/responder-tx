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
const { loadApp, loadMapApp } = require('./harness.js');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

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
    assert.match(I18N[lang]['wf.point'], /perimet|perímet/i, 'the string must deny fire perimeters');
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

test('the lazy fetch treats an absent list as unreadable, never as a fire-free day', () => {
  const src = read('js/sources.js');
  const fn = src.slice(src.indexOf('async function fetchWildfire()'), src.indexOf('\n}', src.indexOf('async function fetchWildfire()')));
  assert.ok(fn.includes('Array.isArray(data.fires)') && fn.includes('Array.isArray(data.sources)'),
    'a payload missing either list must throw rather than publish an empty layer');
  assert.ok(fn.includes('state._wildfireLoaded = false'), 'a failure must allow a retry on the next toggle');
  assert.ok(fn.includes("opNotice(t('note.wildfirefail'))"), 'a failure must be visible to the reader');
  assert.ok(fn.includes('data/wildfire.json'), 'the layer must read the committed same-origin file');
  assert.ok(!/https?:\/\//.test(fn), 'the layer must not reach a third party at runtime');
});

test('the layer ships off by default, claims OFFICIAL, is pilled and hides under playback', () => {
  const map = read('js/map.js');
  assert.match(map, /\['wildfire', '<span class="wildfire-icon">🔥<\/span>', 'layers\.wildfire', 'sheet\.s\.wildfire', 'official', false\]/,
    'the sheet row is missing, on by default, or does not claim the agency provenance it has');
  assert.match(map, /\['wildfire', 'layers\.wildfire'\]/, 'an off-by-default layer with no pill is invisible when on');
  assert.match(map, /state\.layers\.wildfire = L\.layerGroup\(\);/,
    'the layer is created already added to the map, so it is not off by default');
  assert.match(map, /if \(e\.layer === state\.layers\.wildfire\) fetchWildfire\(\);/, 'the layer never loads');
  assert.match(map, /legend\.wildfire/, 'the map legend does not name the marker');
  assert.match(read('js/boot.js'), /glossary\.wildfire/, 'the glossary does not name the marker');

  const pb = read('js/playback.js').match(/const PB_LIVE_HIDE = \[[\s\S]*?\];/);
  assert.ok(pb, 'PB_LIVE_HIDE not found');
  assert.match(pb[0], /\['wildfire', 'layers\.wildfire'\]/,
    'there is no incident archive, so a live wildfire layer under playback impersonates the past');
});

test('the layer travels in a shared link, in both directions and without stacking on a kept view', () => {
  const share = read('js/board.js').match(/for \(const \[key, lk\] of \[\['radar'[\s\S]*?\]\) \{/);
  assert.ok(share, 'the share-url layer list was not found');
  assert.match(share[0], /\['fire', 'wildfire'\]/, 'a shared link silently drops the wildfire layer');
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
  // the render path applies all three classes off the record, not off a hand-set flag
  const render = read('js/sources.js');
  assert.match(render, /wildfireContained\(f\) \? ' contained' : ''/);
  assert.match(render, /wildfireStale\(f\) \? ' unconfirmed' : ''/);
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

test('the fire marker outranks every gauge, so a gauge cannot take the click off a fire glyph', () => {
  const src = read('js/sources.js');
  const fire = src.match(/L\.marker\(\[f\.lat, f\.lon\][\s\S]{0,200}?zIndexOffset:\s*(\d+)/);
  assert.ok(fire, 'the wildfire marker must declare a zIndexOffset; Leaflet otherwise orders the pane by latitude');
  const gauge = src.match(/L\.marker\(\[g\.latitude, g\.longitude\][\s\S]{0,200}?zIndexOffset:([^}]*)\}/);
  assert.ok(gauge, 'gauge marker zIndexOffset not found; update this test with it');
  const gaugeMax = Math.max(...(gauge[1].match(/\d+/g) || ['0']).map(Number));
  assert.ok(Number(fire[1]) > gaugeMax,
    `fire zIndexOffset ${fire[1]} must exceed the gauge maximum ${gaugeMax}`);
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
  const src = read('js/sources.js');
  // ordering proven by execution, not by matching a comment that any edit can move
  assert.deepEqual(renderKinds({ sources: [], fires: [FIRE_PT], perimeters: [PERIM] }),
    ['polygon', 'marker'],
    'the perimeter must be added before the marker so the origin point stays clickable');
  assert.match(src, /\[c\[1\], c\[0\]\]/, 'stored lon,lat must be flipped for Leaflet');
  assert.match(src, /length < 4\) continue/, 'a degenerate ring must be skipped, not drawn');
  // the popup has to say the edge is an interpretation, not a measurement
  assert.match(I18N.en['wf.perim.sub'], /interpretation/i);
  assert.match(I18N.es['wf.perim.sub'], /interpretaci/i);
});

test('an absent perimeter list is not a claim that no fire has an edge', () => {
  const src = read('js/sources.js');
  const fn = src.slice(src.indexOf('function renderPerimeters'), src.indexOf('function perimeterPopupHtml'));
  assert.match(fn, /Array\.isArray\(data\.perimeters\) \? data\.perimeters : \[\]/,
    'a missing list must render nothing rather than throw');
  // the payload guard must still only require fires/sources: an old file has no perimeters key
  assert.match(src, /!Array\.isArray\(data\.fires\) \|\| !Array\.isArray\(data\.sources\)/,
    'perimeters must NOT be required, or every client would reject a pre-perimeter file');
});


/* ---------- the render actually runs ----------
   v0.99.79 shipped renderPerimeters() calling num(), which is a const local to
   wildfirePopupHtml. It threw ReferenceError on the first paint, fetchWildfire()'s catch turned
   that into "wildfire incidents unavailable", and the whole layer went dark including the incident
   points that had worked for weeks. Every client test in that release asserted on SOURCE TEXT, so
   all of them passed. These execute the render instead. */

const mapApp = loadMapApp();

function renderInto(data) {
  const MS = mapApp.state, MSB = mapApp._sandbox;
  const prev = { layers: MS.layers, wildfire: MS.wildfire };
  const added = [];
  try {
    MS.layers = Object.assign({}, MS.layers, {
      wildfire: { clearLayers() { added.length = 0; }, addLayer(l) { added.push(l); } },
    });
    MS.wildfire = data;
    MSB.renderWildfire();
    return added;
  } finally { Object.assign(MS, prev); }
}


/* The harness L is a proxy that answers every call with itself, so drawn layers are
   indistinguishable. This swaps in a recorder that tags what was created, which is what makes
   draw ORDER and draw KIND testable rather than a comment someone has to keep true. */
function renderKinds(data) {
  const MS = mapApp.state, MSB = mapApp._sandbox;
  const prev = { layers: MS.layers, wildfire: MS.wildfire, L: MSB.L };
  const kinds = [];
  const stub = (kind) => () => {
    const o = { __kind: kind };
    o.bindPopup = () => o; o.addTo = () => o; o.on = () => o; o.setStyle = () => o;
    return o;
  };
  try {
    MSB.L = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'polygon' || prop === 'circle' || prop === 'marker') return stub(prop);
        return () => ({ bindPopup() { return this; }, addTo() { return this; }, on() { return this; } });
      },
    });
    MS.layers = Object.assign({}, MS.layers, {
      wildfire: { clearLayers() { kinds.length = 0; }, addLayer(l) { kinds.push(l && l.__kind); } },
    });
    MS.wildfire = data;
    MSB.renderWildfire();
    return kinds;
  } finally { Object.assign(MS, prev); MSB.L = prev.L; }
}

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
  const src = read('js/sources.js');
  const fn = src.slice(src.indexOf('function renderFireAreas'), src.indexOf('function fireAreaPopupHtml'));
  assert.match(fn, /dashArray/, 'an inferred area must be dashed');
  assert.match(fn, /fill: false/, 'it must not be filled like a mapped perimeter');
  const perim = src.slice(src.indexOf('function renderPerimeters'), src.indexOf('function perimeterPopupHtml'));
  assert.match(perim, /fillOpacity: 0\.18/, 'the mapped perimeter keeps its fill');
  assert.ok(!/dashArray/.test(perim), 'a mapped perimeter must stay solid');
});

/* ---------- an enrichment failure is reported, not escalated ----------
   Perimeters timed out on 2 of 15 cycles in one night. Spending the data cycle's DEGRADED signal
   on a rarely-populated enrichment devalues it for the gauges and roads it exists for, and the
   incident list is still complete when only the edges are missing. */

const OKSRC = (key) => ({ key, name: key, url: 'u', status: 'ok', captured: '2026-07-30T00:00:00Z', count: 1 });
const BADSRC = (key) => ({ key, name: key, url: 'u', status: 'failed', captured: null, count: null });

function noticeFor(sources, fires) {
  const MS = mapApp.state, MSB = mapApp._sandbox;
  const prev = MS.wildfire;
  try {
    MS.wildfire = { generated: 'x', sources, fires: fires || [], perimeters: [] };
    return MSB.wildfireNoticeText();
  } finally { MS.wildfire = prev; }
}

test('a perimeter-only failure names the edges, not the whole list, as missing', () => {
  const said = noticeFor([OKSRC('tfs'), OKSRC('wfigs'), BADSRC('wfigs-perimeters')], [FIRE_PT]);
  assert.equal(said, 'wf.noedges');
  for (const lang of ['en', 'es']) {
    const s = I18N[lang]['wf.noedges'];
    assert.ok(s && !s.includes('—'), `wf.noedges missing or em-dashed in ${lang}`);
  }
  // and it must not claim the incident list is short when it is not
  assert.ok(!/incomplete/i.test(I18N.en['wf.noedges']), 'must not call the incident list incomplete');
});

test('an incident source failing still says the list is incomplete', () => {
  assert.equal(noticeFor([BADSRC('tfs'), OKSRC('wfigs'), OKSRC('wfigs-perimeters')], [FIRE_PT]), 'wf.partial');
  assert.equal(noticeFor([BADSRC('tfs'), BADSRC('wfigs'), BADSRC('wfigs-perimeters')], []), 'wf.unknown');
});

test('the generator exit code answers for the incidents, not the enrichment', () => {
  const src = read('scripts/gen-wildfire.py');
  const tail = src.slice(src.indexOf('detail = " · ".join'));
  assert.match(tail, /if any\(s\["status"\] != "ok" for s in \(tfs_src, wfigs_src\)\):\n\s+return 1/,
    'a failed incident source must still degrade the cycle');
  assert.match(tail, /if perim_src\["status"\] != "ok":/,
    'a failed enrichment must still be reported on stderr');
});
