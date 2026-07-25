/* River Sentry siren sites: a marker that says a flood warning siren stands somewhere is a
   life-safety claim, and the board has no feed backing it. These tests hold the layer to
   "reported location" and stop it from ever drifting into "working tower". */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readFile = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const data = JSON.parse(readFile('data/river-sentry.json'));

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

test('the layer ships off by default and is pilled when on', () => {
  const map = readFile('js/map.js');
  assert.match(map, /\['riverSentry', '<span class="rsentry-icon">📢<\/span>', 'layers\.rsentry', 'sheet\.s\.rsentry', null, false\]/,
    'the sheet row is missing, on by default, or claims a provenance badge it has not earned');
  assert.match(map, /\['riverSentry', 'layers\.rsentry'\]/, 'an off-by-default layer with no pill is invisible when on');
  assert.match(map, /state\.layers\.riverSentry = L\.layerGroup\(\);/,
    'the layer is created already added to the map, so it is not off by default');
});

test('playback hides the layer: an undated snapshot cannot render as-of a past frame', () => {
  const pb = readFile('js/playback.js');
  const block = pb.match(/const PB_LIVE_HIDE = \[[\s\S]*?\];/);
  assert.ok(block, 'PB_LIVE_HIDE not found');
  assert.match(block[0], /\['riverSentry', 'layers\.rsentry'\]/,
    'the tower layer survives playback, so it impersonates the past');
});

test('the marker is legended, glossaried and labelled in both languages', () => {
  assert.match(readFile('js/map.js'), /legend\.rsentry/, 'the map legend does not name the marker');
  assert.match(readFile('js/boot.js'), /glossary\.rsentry/, 'the glossary does not name the marker');
  const i18n = readFile('js/i18n.js');
  for (const k of ['layers.rsentry', 'sheet.s.rsentry', 'legend.rsentry', 'glossary.rsentry',
    'glossary.rsentry.label', 'rs.towers', 'rs.what', 'rs.nostatus', 'rs.reported', 'rs.captured',
    'note.rsentryfail']) {
    assert.equal((i18n.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) || []).length, 2,
      `${k} is missing from en or es`);
  }
});

test('every user-facing string states the limitation rather than implying a working siren', () => {
  const i18n = readFile('js/i18n.js');
  const val = (k) => {
    const m = i18n.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '((?:[^'\\\\]|\\\\.)*)'`, 'g')) || [];
    return m.map((s) => s.replace(/^[^:]*: '/, '').replace(/'$/, ''));
  };
  for (const k of ['sheet.s.rsentry', 'rs.nostatus']) {
    const both = val(k);
    assert.equal(both.length, 2, `${k} did not resolve in both languages`);
    for (const v of both) {
      assert.match(v, /no live status|sin estado en vivo|Reported location only|Solo ubicación reportada/,
        `${k} does not say it is locations only: ${v}`);
    }
  }
  // the marker must never assert the tower works
  for (const k of ['layers.rsentry', 'sheet.s.rsentry', 'legend.rsentry', 'rs.what', 'rs.nostatus']) {
    for (const v of val(k)) {
      assert.ok(!/\boperational\b|\bactive\b|\bworking siren\b|\boperativa\b|\bactiva\b/i.test(v),
        `${k} asserts the tower works, which no feed supports: ${v}`);
    }
  }
});

test('the marker is achromatic and square, so it reads as neither a hazard nor a severity', () => {
  const css = readFile('css/app.css');
  const rule = (css.match(/\.rsentry-icon \{([^}]*)\}/) || [])[1];
  assert.ok(rule, '.rsentry-icon has no rule');
  assert.match(rule, /border-radius:\s*4px/, 'the marker is round, so it reads as a gauge or alert dot');
  assert.ok(!/--sev-|--cat-|--good|--bad/.test(rule),
    'the marker borrows a severity colour, but a location snapshot carries no severity');
  assert.match(css, /\.leaflet-marker-pane \.rsentry-icon::before/, 'the marker has no phone tap halo');
});

test('the renderer cites its source and never hotlinks the third-party map for imagery', () => {
  const src = readFile('js/sources.js');
  const fn = (src.match(/function rsentryPopupHtml\(tw\) \{[\s\S]*?\n\}/) || [])[0];
  assert.ok(fn, 'rsentryPopupHtml not found');
  for (const k of ['rs.what', 'rs.nostatus', 'rs.reported']) {
    assert.ok(fn.includes(k), `the popup omits ${k}, so it asserts a tower with no caveat`);
  }
  assert.match(fn, /safeUrl\(src\.url\)/, 'the source link is not passed through safeUrl');
  // the layer is served same-origin from data/; no third-party host may be fetched at runtime
  const layerCode = (src.match(/async function fetchRiverSentry\(\)[\s\S]*?\n\}/) || [])[0];
  assert.match(layerCode, /data\/river-sentry\.json/, 'the layer does not read the committed file');
  assert.ok(!/google\.com/.test(layerCode), 'the layer fetches Google at runtime, which needs a CSP entry');
});

test('no em-dash reaches the shipped data file', () => {
  assert.ok(!readFile('data/river-sentry.json').includes('—'), 'em-dash in data/river-sentry.json');
});
