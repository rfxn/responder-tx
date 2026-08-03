/* River Sentry siren sites: a marker that says a flood warning siren stands somewhere is a
   life-safety claim, and the board has no feed backing it. These tests hold the layer to
   "reported location" and stop it from ever drifting into "working tower".

   Everything below that can be run IS run: initMap() registers the real overlay handlers, the
   sheet and pill rows are rendered, the popup and the lazy fetch are called. A string existing in
   js/map.js never proved the layer loads. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, loadMapApp, loadWiredMap, loadHeaderStatus } = require('./harness.js');
const I18N = require('./i18n-load.js');

const ROOT = path.join(__dirname, '..');
const readFile = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const data = JSON.parse(readFile('data/river-sentry.json'));

const app = loadApp();
const mapApp = loadMapApp();

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// a node that records what the render wrote; unregistered selectors answer null on purpose,
// because a DOM that answers everything lets a missing element pass
function mkNode(over) {
  return Object.assign({
    innerHTML: '', textContent: '', title: '', hidden: false, scrollTop: 0, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {}, append() {}, addEventListener() {}, setAttribute() {},
    querySelectorAll: () => [], querySelector: () => null,
  }, over || {});
}

function wired() {
  const w = loadWiredMap();
  w.sandbox.document.getElementById = () => null; // each test registers only the nodes it asserts on
  return w;
}

test('the shipped file carries its provenance, and it is the honest one', () => {
  assert.match(data.generated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'no generated stamp');
  assert.match(data.captured, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'no capture stamp');
  assert.ok(data.source && data.source.url, 'the file does not cite where it came from');
  assert.match(data.source.name, /author not identified/i,
    'the source line does not admit the upstream map names no author');
  assert.match(data.note, /[Ll]ocations only/, 'the note does not limit the file to locations');
  assert.match(data.note, /no author|names\s+no author/i, 'the note does not admit the missing author');
});

test('no tower carries a status, an elevation or a water level the board cannot stand behind', () => {
  assert.ok(Array.isArray(data.towers) && data.towers.length > 40, 'towers missing or implausibly few');
  const allowed = new Set(['site', 'label', 'lat', 'lon']);
  for (const tw of data.towers) {
    for (const k of Object.keys(tw)) {
      assert.ok(allowed.has(k), `tower field '${k}' is shipped but not a location; it reads as status`);
    }
    assert.ok(Number.isFinite(tw.lat) && Number.isFinite(tw.lon), `${tw.site} has no usable point`);
    assert.ok(tw.lat > 25.5 && tw.lat < 37 && tw.lon > -107 && tw.lon < -93,
      `${tw.site} sits outside Texas: ${tw.lat},${tw.lon}`);
    assert.ok(String(tw.site).trim(), 'a tower with no site name cannot be attributed in a popup');
  }
});

test('the per-site counts agree with the towers actually shipped', () => {
  const tally = {};
  for (const tw of data.towers) tally[tw.site] = (tally[tw.site] || 0) + 1;
  assert.equal(data.sites.length, Object.keys(tally).length, 'site list and tower list disagree');
  for (const s of data.sites) {
    assert.equal(s.towers, tally[s.site], `${s.site} claims ${s.towers} towers, ships ${tally[s.site]}`);
  }
});

test('the rendered sheet row names the layer and claims no provenance it has not earned', () => {
  const w = wired();
  w.map.hasLayer = () => false;
  const body = mkNode();
  const parts = { '.ls-head strong': mkNode(), '.ls-close': mkNode(), '.ls-note': mkNode(), '.ls-body': body };
  const sheet = mkNode({ querySelector: (s) => (has(parts, s) ? parts[s] : null) });
  w.sandbox.document.getElementById = (id) => (id === 'layer-sheet' ? sheet : null);
  // the offline tile estimator is a different surface and needs a real Leaflet projection
  w.sandbox.refreshOfflineStatus = () => {};
  w.sandbox.refreshOfflineEstimate = () => {};
  w.sandbox.renderLayerSheet();

  const row = body.innerHTML.match(/<button class="ls-row[^"]*" data-layer="riverSentry"[\s\S]*?<\/button>/);
  assert.ok(row, 'the layer sheet renders no River Sentry row, so the layer cannot be reached');
  assert.match(row[0], /<span class="ls-name">layers\.rsentry\b/, 'the row carries no name');
  assert.match(row[0], /<span class="ls-sub">sheet\.s\.rsentry</, 'the row carries no limitation subtitle');
  assert.ok(!/src-mini/.test(row[0]),
    'the row wears a provenance badge, but the upstream export names no author and no date');
  const lwc = body.innerHTML.match(/<button class="ls-row[^"]*" data-layer="lwc"[\s\S]*?<\/button>/);
  assert.match(lwc[0], /src-mini/, 'non-vacuity: a row that has earned a badge still renders one');
});

test('the layer ships off by default: a sheet reset turns it off and never turns it on', () => {
  const off = wired();
  const removed = [];
  off.map.hasLayer = () => true;
  off.map.removeLayer = (l) => { removed.push(l); return off.map; };
  off.sandbox.layerSheetReset();
  assert.ok(removed.includes(off.layers.riverSentry), 'a reset leaves the siren layer on the map');
  assert.ok(!removed.includes(off.layers.gauges), 'non-vacuity: a default layer survives the same reset');

  const on = wired();
  const turnedOn = [];
  for (const [k, l] of Object.entries(on.layers)) {
    if (l && typeof l === 'object') l.addTo = () => { turnedOn.push(k); return l; };
  }
  on.map.hasLayer = () => false;
  on.map.removeLayer = () => on.map;
  on.sandbox.layerSheetReset();
  assert.ok(!turnedOn.includes('riverSentry'), 'a reset enables the siren layer, so it is on by default');
  assert.ok(turnedOn.includes('gauges'), 'non-vacuity: the reset does enable the default layers');
});

test('the layer is pilled when on, so an off-by-default overlay is never silently active', () => {
  const w = wired();
  const el = mkNode({ hidden: true, querySelector: (s) => (s === '.lp-add' ? mkNode() : null) });
  w.sandbox.document.getElementById = (id) => (id === 'layer-pills' ? el : null);
  w.map.hasLayer = (l) => l === w.layers.riverSentry;
  w.sandbox.renderLayerPills();
  assert.equal(el.hidden, false, 'the pill row stays hidden while the siren layer is on');
  assert.match(el.innerHTML, /data-layer="riverSentry"/, 'no pill names the layer that is on');
  assert.match(el.innerHTML, /layers\.rsentry/, 'the pill carries no label');
  w.map.hasLayer = () => false;
  w.sandbox.renderLayerPills();
  assert.equal(el.hidden, true, 'non-vacuity: with the layer off the pill row hides again');
});

test('playback hides the layer: an undated snapshot cannot render as-of a past frame', () => {
  const hidden = mapApp.pbLiveHideAll().map(([k]) => k);
  assert.ok(hidden.includes('riverSentry'), 'the tower layer survives playback, so it impersonates the past');
  assert.ok(!hidden.includes('crossings'),
    'non-vacuity: a layer whose items carry their own timestamps re-renders as-of the frame instead');
});

test('the marker is legended, glossaried and labelled in both languages', () => {
  assert.match(mapApp._sandbox.mapLegendHtml(), /legend\.rsentry/, 'the map legend does not name the marker');

  const hdr = loadHeaderStatus();
  hdr.sandbox.renderGlossary();
  const gloss = hdr.node('#glossary-body').innerHTML;
  assert.match(gloss, /glossary\.rsentry\.label/, 'the glossary does not name the marker');
  assert.match(gloss, /rsentry-icon/, 'the glossary entry does not show the marker it describes');

  for (const k of ['layers.rsentry', 'sheet.s.rsentry', 'legend.rsentry', 'glossary.rsentry',
    'glossary.rsentry.label', 'rs.towers', 'rs.what', 'rs.nostatus', 'rs.reported', 'rs.captured',
    'note.rsentryfail']) {
    for (const lang of ['en', 'es']) {
      assert.ok(I18N[lang][k], `${k} is missing from ${lang}`);
      assert.ok(!I18N[lang][k].includes('—'), `em-dash in ${lang} ${k}`);
    }
    assert.notEqual(I18N.en[k], I18N.es[k], `${k} was never actually translated`);
  }
});

test('every user-facing string states the limitation rather than implying a working siren', () => {
  for (const k of ['sheet.s.rsentry', 'rs.nostatus']) {
    for (const lang of ['en', 'es']) {
      assert.match(I18N[lang][k], /no live status|sin estado en vivo|Reported location only|Solo ubicación reportada/,
        `${k} does not say it is locations only: ${I18N[lang][k]}`);
    }
  }
  // the marker must never assert the tower works
  for (const k of ['layers.rsentry', 'sheet.s.rsentry', 'legend.rsentry', 'rs.what', 'rs.nostatus']) {
    for (const lang of ['en', 'es']) {
      assert.ok(!/\boperational\b|\bactive\b|\bworking siren\b|\boperativa\b|\bactiva\b/i.test(I18N[lang][k]),
        `${k} asserts the tower works, which no feed supports: ${I18N[lang][k]}`);
    }
  }
});

/* css/app.css is not something the harness can execute, so the marker's appearance stays a
   source-text check. It is the only one left in this file that has no runnable alternative. */
test('the marker is achromatic and square, so it reads as neither a hazard nor a severity', () => {
  const css = readFile('css/app.css');
  const rule = (css.match(/\.rsentry-icon \{([^}]*)\}/) || [])[1];
  assert.ok(rule, '.rsentry-icon has no rule');
  assert.match(rule, /border-radius:\s*4px/, 'the marker is round, so it reads as a gauge or alert dot');
  assert.ok(!/--sev-|--cat-|--good|--bad/.test(rule),
    'the marker borrows a severity colour, but a location snapshot carries no severity');
  assert.match(css, /\.leaflet-marker-pane \.rsentry-icon::before/, 'the marker has no phone tap halo');
});

function withSentry(doc, fn) {
  const prev = app.state.riverSentry;
  app.state.riverSentry = doc;
  try { return fn(); } finally { app.state.riverSentry = prev; }
}

test('the popup states the limits, counts the site and refuses a hostile source link', () => {
  const tw = data.towers[0];
  const html = withSentry(data, () => app._sandbox.rsentryPopupHtml(tw));
  for (const k of ['rs.what', 'rs.nostatus', 'rs.reported']) {
    assert.ok(html.includes(k), `the popup omits ${k}, so it asserts a tower with no caveat`);
  }
  assert.ok(html.includes(tw.site), 'the popup does not name the site it is attributed to');
  const site = data.sites.find((s) => s.site === tw.site);
  assert.ok(html.includes(`rs.towers: ${site.towers}`), 'the popup does not say how many towers the site reports');
  assert.match(html, /author not identified/, 'the popup drops the "no named author" line the file carries');
  assert.match(html, new RegExp(`href="${data.source.url.replace(/[.?*+^$[\]\\(){}|-]/g, '\\$&')}"`),
    'the source link is missing, so the reader cannot check the claim');

  const hostile = withSentry(Object.assign({}, data, { source: { name: 'x', url: 'javascript:alert(1)' } }),
    () => app._sandbox.rsentryPopupHtml(tw));
  assert.doesNotMatch(hostile, /javascript:/, 'safeUrl did not stop a script URL reaching the popup href');
  assert.doesNotMatch(hostile, /<a /, 'a URL safeUrl rejected must produce no link at all');
});

test('enabling the layer loads it once, from the committed file, and a failure stays retryable', async () => {
  const w = wired();
  const calls = w.spyOn('fetchRiverSentry');
  w.fire('overlayadd', { layer: w.layers.riverSentry });
  assert.deepEqual(calls.names(), ['fetchRiverSentry'],
    'turning the layer on loads nothing, so the map shows an empty siren layer');

  const SB = app._sandbox;
  const ST = app.state;
  const prev = { fetch: SB.fetch, opNotice: SB.opNotice, loaded: ST._rsentryLoaded,
    riverSentry: ST.riverSentry, layers: ST.layers };
  const said = [];
  const urls = [];
  const added = [];
  try {
    ST.layers = Object.assign({}, ST.layers, {
      riverSentry: { clearLayers() { added.length = 0; }, addLayer(l) { added.push(l); } },
    });
    SB.opNotice = (s) => said.push(s);

    ST._rsentryLoaded = false;
    ST.riverSentry = null;
    SB.fetch = (u) => { urls.push(String(u)); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) }); };
    await SB.fetchRiverSentry();
    assert.equal(urls.length, 1);
    assert.match(urls[0], /^data\/river-sentry\.json\?/, 'the layer does not read the committed same-origin file');
    assert.ok(!/^https?:/.test(urls[0]), 'the layer reaches a third party at runtime, which needs a CSP entry');
    assert.equal(added.length, data.towers.length, 'every shipped tower must reach the layer');
    assert.deepEqual(said, [], 'a healthy load raises no failure notice');

    await SB.fetchRiverSentry();
    assert.equal(urls.length, 1, 'a second enable must not re-fetch a static committed file');

    ST._rsentryLoaded = false;
    ST.riverSentry = null;
    SB.fetch = () => Promise.resolve({ ok: false, status: 503, json: () => Promise.reject(new Error('no body')) });
    await SB.fetchRiverSentry();
    assert.deepEqual(said, ['note.rsentryfail'], 'a failed load must tell the reader the layer is missing');
    assert.equal(ST.riverSentry, null, 'a failed load must not publish a payload');
    assert.equal(ST._rsentryLoaded, false, 'a failed load must stay retryable on the next toggle');
  } finally {
    SB.fetch = prev.fetch; SB.opNotice = prev.opNotice;
    ST._rsentryLoaded = prev.loaded; ST.riverSentry = prev.riverSentry; ST.layers = prev.layers;
  }
});

test('the layer travels in a shared link, like every other off-by-default layer', () => {
  const w = wired();
  const filters = { '#flt-alert-sev': mkNode({ value: '' }), '#flt-alert-q': mkNode({ value: '' }) };
  w.sandbox.document.querySelector = (s) => (has(filters, s) ? filters[s] : null);

  w.map.hasLayer = (l) => l === w.layers.riverSentry;
  assert.match(w.sandbox.buildShareUrl(), /[?&]rs=1(&|$)/, 'a shared link silently drops the siren layer');
  w.map.hasLayer = () => false;
  assert.doesNotMatch(w.sandbox.buildShareUrl(), /rs=1/,
    'non-vacuity: the link carries the layer only when it is on');
  assert.ok(w.app.linkOwnsView(new URLSearchParams('rs=1')),
    'an incoming ?rs=1 must win over the saved layer set, or the link is ignored on a returning client');

  // the inbound toggle loop lives inside boot(), which cannot be called: matched, not run
  assert.match(readFile('js/boot.js'), /\[\['usgs', 'usgs'\][\s\S]{0,300}?\['rs', 'riverSentry'\]/,
    'an incoming ?rs=1 link does not reopen the layer');
});

test('no em-dash reaches the shipped data file', () => {
  assert.ok(!JSON.stringify(data).includes('—'), 'em-dash in data/river-sentry.json');
});
