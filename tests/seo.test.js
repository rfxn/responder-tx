'use strict';

/* The indexable surface: <head> metadata, robots.txt, sitemap.xml, llms.txt.
 *
 * Every regression this file guards is silent. A dropped canonical, a sitemap <loc> that 404s, a
 * stray "Disallow: /" and a JSON-LD block that stopped parsing all look identical in a browser and
 * none of them fail any other suite. The coverage assertions are the E4 case: index.html and
 * llms.txt hardcode "Texas" while data/event.json is what actually decides the region, so the two
 * are pinned to each other rather than to a note somebody has to remember to read.
 *
 * Deliberately absent: any assertion about a live HTTP response. The suite is hermetic (see
 * tests/run.sh's network trap), so every "does it resolve" check here is against the repo tree,
 * which is exactly what `git archive HEAD` publishes.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readRoot = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ORIGIN = 'https://respondertx.org';
const HTML = readRoot('index.html');
const HEAD = HTML.slice(0, HTML.indexOf('</head>'));
const ROBOTS = readRoot('robots.txt');
const SITEMAP = readRoot('sitemap.xml');
const LLMS = readRoot('llms.txt');
const EVENT = JSON.parse(readRoot('data/event.json'));

const metaContent = (re) => (HEAD.match(re) || [])[1];

test('the head carries a self-referencing canonical that agrees with og:url and the sitemap', () => {
  const canonical = (HEAD.match(/<link rel="canonical" href="([^"]+)"/) || [])[1];
  assert.equal(canonical, `${ORIGIN}/`, 'index.html lost its canonical link');
  assert.equal(metaContent(/<meta property="og:url" content="([^"]+)"/), canonical,
    'og:url and rel=canonical disagree, so a share and a crawl name different pages');
  assert.ok(SITEMAP.includes(`<loc>${canonical}</loc>`), 'the sitemap does not list the canonical URL');
});

test('title and description say what the board is and where it covers', () => {
  const title = (HEAD.match(/<title>([^<]+)<\/title>/) || [])[1];
  const desc = metaContent(/<meta name="description" content="([^"]+)"/);
  assert.ok(title && title.length <= 70, `title is missing or too long for a result page: ${title}`);
  assert.ok(/flood/i.test(title) && /texas/i.test(title), `title states neither the hazard nor the region: ${title}`);
  assert.ok(desc && desc.length >= 80 && desc.length <= 175,
    `description is ${desc ? desc.length : 0} chars; outside what a result page shows`);
  assert.ok(/911/.test(desc), 'the description dropped the 911 line');
  assert.ok(/not a dispatch system/i.test(desc), 'the description dropped the not-a-dispatch-system scope');
});

test('the social card is declared with the dimensions the file actually has', () => {
  const img = metaContent(/<meta property="og:image" content="([^"]+)"/);
  assert.ok(img && img.startsWith(`${ORIGIN}/`), `og:image must be absolute: ${img}`);
  const rel = img.slice(ORIGIN.length + 1).split('?')[0];
  const buf = fs.readFileSync(path.join(ROOT, rel));
  assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG', `${rel} is not a PNG`);
  assert.equal(String(buf.readUInt32BE(16)), metaContent(/<meta property="og:image:width" content="([^"]+)"/),
    'og:image:width does not match the PNG header');
  assert.equal(String(buf.readUInt32BE(20)), metaContent(/<meta property="og:image:height" content="([^"]+)"/),
    'og:image:height does not match the PNG header');
  assert.ok(metaContent(/<meta property="og:image:alt" content="([^"]+)"/), 'og:image:alt is missing');
  assert.equal(metaContent(/<meta name="twitter:image" content="([^"]+)"/), img,
    'twitter:image and og:image point at different files');
});

test('every rel=alternate in the head points at a file this repo publishes', () => {
  const alts = [...HEAD.matchAll(/<link rel="alternate"[^>]*href="\/([^"]+)"/g)].map((m) => m[1]);
  assert.ok(alts.length >= 1, 'the head advertises no alternate representation at all');
  for (const a of alts) {
    assert.ok(fs.existsSync(path.join(ROOT, a)), `head advertises /${a} but it is not in the repo`);
  }
});

test('the JSON-LD parses, is a graph, and claims nothing time-sensitive', () => {
  const blocks = [...HEAD.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1, 'expected exactly one JSON-LD block');
  const doc = JSON.parse(blocks[0][1]);
  const types = doc['@graph'].map((n) => n['@type']);
  for (const t of ['Organization', 'WebSite', 'WebApplication', 'Dataset']) {
    assert.ok(types.includes(t), `JSON-LD lost its ${t} node`);
  }
  /* E1 on a new surface: a static shell cannot retract an alert. Anything announcement-shaped here
     would be crawled once and then served past the event it described. */
  const raw = blocks[0][1];
  for (const banned of ['SpecialAnnouncement', 'NewsArticle', 'datePosted', 'expires', 'validThrough']) {
    assert.ok(!raw.includes(banned),
      `JSON-LD gained ${banned}: a static shell cannot keep a time-bounded claim true`);
  }
});

test('the JSON-LD non-emergency statement survives, verbatim enough to be useful', () => {
  const doc = JSON.parse(HEAD.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const app = doc['@graph'].find((n) => n['@type'] === 'WebApplication');
  const s = app.disambiguatingDescription || '';
  assert.match(s, /911/, 'the machine-readable scope statement dropped 911');
  assert.match(s, /not a dispatch system/i);
  assert.match(s, /not an official warning source/i);
  assert.match(s, /not monitored/i);
});

test('the JSON-LD dataset distributions all exist in this repo', () => {
  const doc = JSON.parse(HEAD.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const ds = doc['@graph'].find((n) => n['@type'] === 'Dataset');
  assert.ok(ds.distribution.length >= 4, 'the dataset node advertises almost nothing');
  for (const d of ds.distribution) {
    assert.ok(d.contentUrl.startsWith(`${ORIGIN}/`), `distribution URL is not absolute: ${d.contentUrl}`);
    const rel = d.contentUrl.slice(ORIGIN.length + 1);
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `JSON-LD advertises /${rel} but it is not in the repo`);
    assert.ok(d.encodingFormat, `${rel} is advertised with no encodingFormat`);
  }
});

/* E4. data/event.json is what decides the region; index.html and llms.txt only assert it. A
   re-target that changes `region` and leaves these strings alone would publish a false coverage
   claim in structured data, which is the one place a machine reads it as fact rather than prose. */
test('the coverage claims track data/event.json, so a re-target cannot leave them lying', () => {
  const region = EVENT.region;
  assert.ok(region, 'data/event.json has no region');
  const doc = JSON.parse(HEAD.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const covered = doc['@graph'].filter((n) => n.spatialCoverage);
  assert.ok(covered.length >= 2, 'no JSON-LD node declares spatialCoverage');
  for (const n of covered) {
    assert.ok(n.spatialCoverage.name.includes(region),
      `JSON-LD ${n['@type']}.spatialCoverage says "${n.spatialCoverage.name}" but data/event.json region is "${region}". `
      + 'Update index.html spatialCoverage, title, description, og/twitter titles and llms.txt to the new region.');
  }
  assert.ok(LLMS.includes(region), `llms.txt does not mention the event.json region "${region}"`);
});

test('robots.txt allows the board, blocks only what is not a document, and names the sitemap', () => {
  const lines = ROBOTS.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.ok(lines.includes('User-agent: *'), 'robots.txt has no wildcard group');
  assert.ok(lines.includes('Allow: /'), 'robots.txt does not explicitly allow the board');
  const disallows = lines.filter((l) => /^Disallow:/i.test(l)).map((l) => l.split(':')[1].trim());
  assert.ok(!disallows.includes('/'), 'robots.txt disallows the entire site');
  assert.ok(!disallows.includes(''), 'robots.txt has an empty Disallow, which reads as a stray rule');
  for (const d of disallows) {
    assert.ok(!/^\/(data|feed|crests|assets|history\/index)/.test(d),
      `robots.txt blocks ${d}, which is a published machine-readable surface`);
  }
  const sitemap = lines.find((l) => /^Sitemap:/i.test(l));
  assert.equal(sitemap, `Sitemap: ${ORIGIN}/sitemap.xml`, 'robots.txt does not point at the sitemap');
});

test('the sitemap is well formed and every loc resolves to something this repo ships', () => {
  assert.ok(SITEMAP.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'sitemap lost its XML declaration');
  assert.match(SITEMAP, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  const body = SITEMAP.replace(/<!--[\s\S]*?-->/g, '');
  const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length >= 1, 'the sitemap lists no URLs');
  for (const loc of locs) {
    assert.ok(loc.startsWith(`${ORIGIN}/`), `sitemap loc is not on the canonical origin: ${loc}`);
    const rel = loc.slice(ORIGIN.length + 1).split('?')[0] || 'index.html';
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `sitemap lists /${rel} but it is not in the repo, so it would 404`);
  }
  assert.ok(!/<lastmod>/.test(body),
    'the sitemap gained a lastmod nothing regenerates; an absent date beats a date that goes stale');
});

test('no indexable surface is export-ignored out of the published archive', () => {
  const attrs = readRoot('.gitattributes');
  for (const f of ['robots.txt', 'sitemap.xml', 'llms.txt', 'index.html', '404.html', '_headers', 'manifest.webmanifest']) {
    assert.ok(!new RegExp(`^${f.replace('.', '\\.')}\\s`, 'm').test(attrs),
      `${f} is export-ignored, so it would never reach the Cloudflare Pages deploy`);
  }
});

test('llms.txt tells a reader to fetch live rather than answer from the file', () => {
  assert.ok(LLMS.startsWith('# ResponderTX\n'), 'llms.txt does not open with the site name');
  assert.match(LLMS, /^> /m, 'llms.txt has no blockquote summary');
  assert.match(LLMS, /911/, 'llms.txt dropped the 911 line');
  assert.match(LLMS, /not a dispatch system/i);
  assert.match(LLMS, /generated/, 'llms.txt does not point a reader at the freshness stamp');
  /* A count in this file cannot be kept true and would be read as fact. The gauge network went from
     290 to 1018 without anything noticing; a hardcoded figure here would have gone quietly wrong. */
  const STABLE = /\b(911|8443|8080)\b/g; // the emergency number and the LAN ports are not data
  const counts = LLMS.split('\n')
    .filter((l) => !l.trim().startsWith('['))
    .filter((l) => /\b\d{3,}\b/.test(l.replace(STABLE, '')));
  assert.deepEqual(counts, [], 'llms.txt states a volatile count; point at the live endpoint instead');
});

test('every URL llms.txt advertises on our own origin is a file this repo ships', () => {
  const urls = [...LLMS.matchAll(/https:\/\/respondertx\.org\/([^)\s`]*)/g)].map((m) => m[1]);
  for (const u of urls) {
    if (!u || u.startsWith('?')) continue;
    assert.ok(fs.existsSync(path.join(ROOT, u)), `llms.txt advertises /${u} but it is not in the repo`);
  }
});

test('the 404 page is bilingual, unindexed, and points home', () => {
  const html = readRoot('404.html');
  assert.match(html, /<meta name="robots" content="noindex/, '404.html is indexable');
  assert.match(html, /href="\/"/, '404.html has no route back to the board');
  assert.match(html, /lang="es"/, '404.html is English only');
  assert.ok(!html.includes('—'), 'em-dash in 404.html');
});

test('the manifest declares a stable identity and matches the canonical origin', () => {
  const m = JSON.parse(readRoot('manifest.webmanifest'));
  assert.equal(m.id, '/', 'manifest id must stay "/", the default derived from start_url; changing it forks installs');
  assert.equal(m.start_url, '/');
  assert.equal(m.scope, '/');
  assert.ok(m.lang, 'manifest declares no language');
  for (const icon of m.icons) {
    assert.ok(fs.existsSync(path.join(ROOT, icon.src)), `manifest lists ${icon.src} but it is not in the repo`);
  }
  assert.ok(!JSON.stringify(m).includes('—'), 'em-dash in manifest.webmanifest');
});

test('the indexable text nowhere invites a reader to report an emergency here', () => {
  const invite = /(report|request|call for)\s+(an?\s+)?(emergency|rescue|help)\s+(here|below|on this)/i;
  for (const [name, body] of [['index.html head', HEAD], ['llms.txt', LLMS], ['404.html', readRoot('404.html')]]) {
    assert.ok(!invite.test(body), `${name} reads as an emergency reporting channel`);
  }
});

/* js/boot.js overwrote the indexable <title> with data/event.json's `name`, which is the bare brand
   "ResponderTX". Googlebot renders JS, so every word of geography and hazard in the static title was
   destroyed before indexing. A real event re-target still takes the title, because that is new
   information; the brand alone is not. */
test('the event name does not overwrite a static title that already leads with it', () => {
  const boot = fs.readFileSync(path.join(ROOT, 'js', 'boot.js'), 'utf8');
  const block = boot.slice(boot.indexOf('brand-logo'), boot.indexOf('if (ev.subtitle)'));
  assert.match(block, /startsWith\(ev\.name\)/,
    'the override must be conditional on the static title not already carrying the name');
  assert.match(block, /!String\(state\.baseTitle/, 'and must read the seeded static title to decide');

  // and the static title must still be the richer one, or the guard protects nothing
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  const evName = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'event.json'), 'utf8')).name || '';
  assert.ok(title.length > evName.length + 8,
    `static title "${title}" adds nothing over the event name "${evName}"`);
  assert.ok(title.startsWith(evName),
    'the guard only holds while the static title leads with the event name');
});
