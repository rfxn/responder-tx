'use strict';

/* The board is classic scripts, so an engine below the syntax floor stops the whole bundle and
   leaves a shell that still looks like a board. js/bootfloor.js is the one script that has to keep
   running in that state, which makes its own syntax and its load order the whole contract. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const guard = read('js/bootfloor.js');
const html = read('index.html');
const core = read('js/core.js');

// the guard's own comments name the constructs it avoids, so every check below reads code only
const guardCode = guard.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the guard is ES5, so it survives the engine it exists to catch', () => {
  const body = guardCode;
  const banned = [
    [/=>/, 'arrow function'],
    [/\b(const|let)\s/, 'block-scoped declaration'],
    [/`/, 'template literal'],
    [/\basync\b|\bawait\b/, 'async/await'],
    [/\?\?/, 'nullish coalescing'],
    [/\?\.[a-zA-Z_([]/, 'optional chaining'],
    [/\bclass\s+\w/, 'class'],
    [/\.\.\./, 'spread'],
  ];
  for (const [re, name] of banned) {
    assert.ok(!re.test(body), `js/bootfloor.js uses ${name}; it must parse on a below-floor engine`);
  }
});

test('the guard cannot use eval, because the CSP it ships under forbids it', () => {
  assert.ok(!/\bnew Function\b|\beval\(/.test(guardCode),
    'script-src is self with no unsafe-eval, so a syntax probe would throw on a healthy browser '
    + 'and tell every modern user their browser is unsupported');
  assert.match(read('_headers'), /script-src 'self';/,
    'if the CSP ever gains unsafe-eval this test should be revisited, not silently outgrown');
});

test('the sentinel lives in the file that carries the highest syntax floor', () => {
  assert.match(core, /window\.__boardBooted = true;/,
    'js/core.js is the floor sentinel: reaching its last line proves the engine parsed it');
  assert.match(core, /\?\?/, 'core.js must still be the file holding the floor syntax');
  assert.match(guard, /window\.__boardBooted/, 'the guard reads the sentinel core.js sets');
  // a sentinel in a file that parses on older engines than core.js would report a false success
  for (const f of ['js/boot.js', 'js/map.js', 'js/sources.js']) {
    assert.ok(!read(f).includes('__boardBooted'), `${f} must not also claim the boot sentinel`);
  }
});

test('the guard loads before the bundle it watches', () => {
  const at = (p) => html.indexOf(p);
  assert.ok(at('js/bootfloor.js') > -1, 'js/bootfloor.js must be in index.html');
  for (const later of ['js/vendor/leaflet.js', 'js/core.js', 'js/boot.js']) {
    assert.ok(at('js/bootfloor.js') < at(later), `js/bootfloor.js must load before ${later}`);
  }
  assert.match(html, /<script src="js\/bootfloor\.js\?v=/, 'it is a stamped local script like the rest');
});

test('the guard waits for load, so a slow connection is not called an old browser', () => {
  assert.match(guard, /addEventListener\('load'/,
    'DOMContentLoaded fires before late scripts finish; only load means every script ran or gave up');
  assert.ok(!/DOMContentLoaded/.test(guard), 'DOMContentLoaded would false-positive on a slow bundle');
});

/* v0.99.77 shipped a guard that also revealed on any script error event. Cloudflare injects an
   analytics beacon at the edge, our CSP blocks it, the blocked tag fires an error, and the notice
   covered a working board for every live visitor. Local screenshots could never see it, because
   only the edge injects the beacon. The sentinel is the only thing that speaks for our bundle. */
test('a third-party script the CSP blocks cannot blank a booted board', () => {
  assert.ok(!/lostScript|tagName\s*===\s*'SCRIPT'/.test(guardCode),
    'a script error event must not feed the reveal decision: the edge injects tags we block by design');
  const reveal = guardCode.slice(guardCode.indexOf("addEventListener('load'"));
  assert.match(reveal, /if \(!window\.__boardBooted\) reveal\(\);/,
    'the sentinel is the only reveal condition');
  assert.ok(!/\|\||&&/.test(reveal.slice(reveal.indexOf('if (!window.__boardBooted'), reveal.indexOf('reveal();'))),
    'no extra clause may rejoin the reveal condition without its own false-positive analysis');
});

test('both boot notices state the failure and carry their own 911 line', () => {
  for (const id of ['boot-noscript', 'boot-unsupported']) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > -1, `#${id} missing from index.html`);
    const block = html.slice(at, html.indexOf('</div>', html.indexOf('drive-911', at)) + 6);
    assert.match(block, /class="drive-911"/, `#${id} must carry its own 911 footer: it covers #disclaimer`);
    assert.match(block, /911/, `#${id} 911 line must name the number`);
    assert.match(block, /lang="es"/, `#${id} must be bilingual inline: i18n.js has not run in this state`);
  }
  assert.match(html, /<noscript>/, 'JS-off is a distinct failure from a below-floor engine');
});

test('the unsupported notice names the floor and disowns the shell behind it', () => {
  const at = html.indexOf('id="boot-unsupported"');
  const block = html.slice(at, at + 2000);
  assert.match(block, /80 or newer/, 'the floor must be stated where the reader is, not only in a doc');
  assert.match(block, /13\.4 or newer/, 'the iOS floor is the other half of the same bound');
  assert.match(block, /Do not read the page behind this notice/,
    'an empty shell reads as a quiet board; the notice has to say it is not one');
});

test('the guard is precached, or the offline shell would drop it', () => {
  assert.match(read('sw.js'), /'js\/bootfloor\.js',/,
    'a cached shell missing the guard fails exactly like the bundle it watches');
});
