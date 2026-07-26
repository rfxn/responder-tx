'use strict';

/* The on-demand asset contract (v0.99.43).

   Four assets used to load on every visit and cost roughly 126 KB gzipped on the critical path of
   a first load: the HLS player, the QR generator, the team client, and its stylesheet. The
   overwhelming majority of visits open none of them. They are fetched on first use now, which
   moves the honesty burden onto the failure path: a weak-signal device that cannot pull the asset
   must be TOLD, in place, rather than shown an empty box that reads as "this board has no such
   feature".

   These pin the four properties that make that safe: the loader fetches once and memoizes, a
   failed fetch is not memoized (so the next tap retries), every caller degrades with a visible
   localized message, and the routes into the team surface still reach it. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSandbox } = require('./harness.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* A sandbox whose document records every element the loader creates, so a test can inspect the
   tag it injected and then resolve or reject it by hand. Nothing here fakes the loader itself. */
function loadWithRecorder(files, epilogue) {
  const sandbox = buildSandbox();
  const created = [];
  sandbox.document.createElement = (tag) => {
    const el = {
      tag, rel: '', href: '', src: '', dataset: {}, innerHTML: '', hidden: false,
      onload: null, onerror: null,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild() {}, setAttribute() {}, addEventListener() {}, click() { this.clicked = true; },
      querySelector: () => null, querySelectorAll: () => [],
    };
    created.push(el);
    return el;
  };
  sandbox.document.head = { appendChild() {} };
  sandbox.document.body = { appendChild() {}, focus() {} };
  const context = vm.createContext(sandbox);
  // core.js declares these with const, which is lexical in a vm realm and never lands on the
  // global object, so the epilogue is the only way a test can reach them (as in harness.js)
  const exported = '\n;globalThis.assetUrl = assetUrl; globalThis.APP_VERSION = APP_VERSION;'
    + ' globalThis.ensureQrcode = ensureQrcode;';
  vm.runInContext(files.map(read).join('\n;\n') + exported + (epilogue || ''), context, { filename: 'lazy-bundle.js' });
  return { sandbox, created };
}

const settle = () => new Promise((r) => setImmediate(r));

/* ---------- loadAssetOnce: one fetch per URL, retryable after a failure ---------- */

test('loadAssetOnce injects one stamped tag and reuses it for every later caller', async () => {
  const { sandbox, created } = loadWithRecorder(['js/core.js']);
  const a = sandbox.loadAssetOnce('js/vendor/qrcode.min.js?v=9.9.9');
  const b = sandbox.loadAssetOnce('js/vendor/qrcode.min.js?v=9.9.9');
  assert.equal(created.length, 1, 'a second caller must share the in-flight request, not start another');
  assert.equal(created[0].tag, 'script');
  assert.equal(created[0].src, 'js/vendor/qrcode.min.js?v=9.9.9');

  created[0].onload();
  await Promise.all([a, b]);

  sandbox.loadAssetOnce('js/vendor/qrcode.min.js?v=9.9.9');
  assert.equal(created.length, 1, 'an already-loaded asset must never be fetched a second time');
});

test('loadAssetOnce builds a stylesheet link for css and appends it to the head', async () => {
  const { sandbox, created } = loadWithRecorder(['js/core.js']);
  const p = sandbox.loadAssetOnce('css/team.css?v=9.9.9', 'css');
  assert.equal(created[0].tag, 'link');
  assert.equal(created[0].rel, 'stylesheet');
  assert.equal(created[0].href, 'css/team.css?v=9.9.9');
  assert.equal(created[0].src, '', 'a stylesheet must not be given a script src');
  created[0].onload();
  await p;
});

test('a failed fetch is not memoized, so the next attempt retries instead of failing forever', async () => {
  const { sandbox, created } = loadWithRecorder(['js/core.js']);
  const first = sandbox.loadAssetOnce('js/team.js?v=9.9.9');
  created[0].onerror();
  await assert.rejects(first, /asset failed to load/);

  const second = sandbox.loadAssetOnce('js/team.js?v=9.9.9');
  assert.equal(created.length, 2, 'a dead-zone failure must not permanently poison the asset');
  created[1].onload();
  await second;
});

test('assetUrl stamps with the release, which is what lets the service worker cache-first it', () => {
  const { sandbox } = loadWithRecorder(['js/core.js']);
  const stamp = sandbox.APP_VERSION.replace(/^v/, '');
  assert.equal(sandbox.assetUrl('js/team.js'), `js/team.js?v=${stamp}`);
  assert.equal(stamp, read('sw.js').match(/const SW_VERSION = '([^']+)'/)[1],
    'a lazy asset stamped off a different version than the SW would never hit the precache-era cache');
});

/* ---------- QR: loading, painted, and honestly failed ---------- */

function qrHost() {
  return { dataset: {}, innerHTML: '', hidden: false };
}

test('the QR box says it is building, then paints once the lazy library lands', async () => {
  const { sandbox, created } = loadWithRecorder(['js/core.js']);
  const host = qrHost();
  sandbox.renderQrCode(host, 'https://respondertx.org/x', 8);
  assert.match(host.innerHTML, /qr\.loading/, 'the wait must be visible, not a blank box');
  assert.equal(host.hidden, false);
  assert.equal(created[0].src, sandbox.assetUrl('js/vendor/qrcode.min.js'));

  sandbox.qrcode = () => ({ addData() {}, make() {}, createSvgTag: () => '<svg>painted</svg>' });
  created[0].onload();
  await settle();
  assert.equal(host.innerHTML, '<svg>painted</svg>');
  assert.equal(host.dataset.done, '1');
});

test('a QR box whose library never arrives says so instead of sitting on "building"', async () => {
  const { sandbox, created } = loadWithRecorder(['js/core.js']);
  const host = qrHost();
  sandbox.renderQrCode(host, 'https://respondertx.org/x', 8);
  created[0].onerror();
  await settle();
  assert.match(host.innerHTML, /qr\.fail/, 'an offline QR must be explained, not left mid-sentence');
  assert.equal(host.hidden, false, 'the message has to be visible to be honest');
  assert.notEqual(host.dataset.done, '1', 'nothing was painted, so a re-open must try again');
});

// a captive portal or a truncated response answers 200 with something that is not the library
test('a QR whose library loads but defines nothing still reports the failure', async () => {
  const { sandbox, created } = loadWithRecorder(['js/core.js']);
  const host = qrHost();
  sandbox.renderQrCode(host, 'https://respondertx.org/x', 8);
  created[0].onload(); // resolved, but no global qrcode was defined
  await settle();
  assert.match(host.innerHTML, /qr\.fail/, 'a load that produced no library is a failure, not a silent wait');
});

test('a QR whose view changed mid-fetch is not painted with the stale link', async () => {
  const { sandbox, created } = loadWithRecorder(['js/core.js']);
  const host = qrHost();
  sandbox.renderQrCode(host, 'https://respondertx.org/old', 8);
  host.dataset.qrurl = 'https://respondertx.org/new'; // the share sheet re-opened on a different view
  sandbox.qrcode = () => ({ addData() {}, make() {}, createSvgTag: () => '<svg>stale</svg>' });
  created[0].onload();
  await settle();
  assert.doesNotMatch(host.innerHTML, /stale/, 'a QR that encodes the previous view is a wrong answer, not a slow one');
});

test('both QR surfaces route through the one lazy painter', () => {
  assert.match(read('js/board.js'), /const renderQr = \(host, url\) => renderQrCode\(host, url, 8\)/,
    'the Share sheet and CalTopo box must not keep a second, eager QR path');
  assert.match(read('js/team.js'), /const renderQR = \(container, url\) => renderQrCode\(container, url, 16\)/,
    'the team invite QR must not keep a second, eager QR path');
});

/* ---------- HLS: only a live stream pays for the player ---------- */

test('ensureHls fetches the player once and reports whether this browser can use it', async () => {
  const { sandbox, created } = loadWithRecorder(['js/core.js', 'js/sources.js', 'js/cameras.js']);
  const p = sandbox.ensureHls();
  assert.equal(created.length, 1);
  assert.equal(created[0].src, sandbox.assetUrl('js/vendor/hls.light.min.js'));

  sandbox.Hls = function Hls() {};
  sandbox.Hls.isSupported = () => true;
  created[0].onload();
  assert.equal(await p, true);

  assert.equal(await sandbox.ensureHls(), true);
  assert.equal(created.length, 1, 'the player must be fetched once per session, not once per camera');
});

test('ensureHls reports false when the player loads but the browser cannot play it', async () => {
  const { sandbox, created } = loadWithRecorder(['js/core.js', 'js/sources.js', 'js/cameras.js']);
  const p = sandbox.ensureHls();
  sandbox.Hls = function Hls() {};
  sandbox.Hls.isSupported = () => false;
  created[0].onload();
  assert.equal(await p, false, 'unsupported and unreachable are different messages to the user');
});

test('the camera viewer separates "cannot play" from "could not load", and Safari skips the fetch', () => {
  const src = read('js/cameras.js');
  const viewer = src.slice(src.indexOf('function openCamViewer'));
  assert.match(viewer, /canPlayType\('application\/vnd\.apple\.mpegurl'\)/,
    'native HLS must be tried first so iOS never downloads the player at all');
  assert.match(viewer, /if \(!ok\) \{[^}]*cam\.nohls/, 'a browser that cannot play HLS keeps its own message');
  assert.match(viewer, /\.catch\(\(\) => \{[\s\S]{0,200}cam\.hlsfail/,
    'a player that failed to download must say so, not reuse the unsupported-browser message');
  assert.match(viewer, /if \(gen !== state\.camGen\) return;/,
    'a late player load must not paint into a viewer that already moved to another camera');
});

/* ---------- team: the routes in still reach it ---------- */

test('the ?team= deep link and ?tab=team still pull in the team client', () => {
  const { sandbox } = loadWithRecorder(['js/core.js', 'js/boot.js']);
  for (const search of ['?team=00000000-0000-4000-8000-000000000000', '?team=new', '?tab=team']) {
    assert.equal(sandbox.teamAssetsWanted(search), true, `${search} must load the team client`);
  }
  for (const search of ['', '?tab=roads', '?tab=gauges', '?view=basin&river=guadalupe', '?teamx=1']) {
    assert.equal(sandbox.teamAssetsWanted(search), false, `${search} must not pay for the team client`);
  }
});

// the gate above only helps if it agrees with the gate team.js applies once it has loaded
test('teamAssetsWanted matches the URL half of team.js own teamTabAllowed', () => {
  const gate = read('js/team.js').match(/function teamTabAllowed\(\)\s*\{[\s\S]*?\n  \}/)[0];
  assert.match(gate, /q\.has\('team'\) \|\| q\.get\('tab'\) === 'team'/);
  const boot = read('js/boot.js').match(/function teamAssetsWanted\(search\)\s*\{[\s\S]*?\n\}/)[0];
  assert.match(boot, /q\.has\('team'\) \|\| q\.get\('tab'\) === 'team'/,
    'a boot gate narrower than team.js own would leave the tab visible with no client behind it');
});

test('the team deep link loads the stylesheet and the client, then initialises both', async () => {
  const { sandbox, created } = loadWithRecorder(['js/core.js', 'js/boot.js']);
  const p = sandbox.ensureTeamAssets();
  const urls = created.map((el) => el.href || el.src).sort();
  assert.deepEqual(urls, [sandbox.assetUrl('css/team.css'), sandbox.assetUrl('js/team.js')].sort(),
    'the team surface needs its stylesheet as well as its client');
  created.forEach((el) => el.onload());
  await p;

  const boot = read('js/boot.js');
  const deepLink = boot.match(/if \(teamAssetsWanted\(location\.search\)\) \{[\s\S]*?\n  \}/);
  assert.ok(deepLink, 'boot must still gate the team client on the URL');
  assert.match(deepLink[0], /ensureTeamAssets\(\)\.then\(/, 'the client has to be fetched before it is called');
  assert.match(deepLink[0], /initTeamTab\(\);/, 'the tab body must still be painted on boot');
  assert.match(deepLink[0], /initTeam\(\);/,
    'the deep link must still reach initTeam, which is what opens the tab on a ?team= link');
  assert.match(deepLink[0], /\.catch\(\(\) => teamLoadFailed\(true\)\)/,
    'a link the board cannot honour must land the user on the reason, not on a silent Feed tab');
  assert.match(boot, /\$\('#team-open-btn'\)[\s\S]{0,240}ensureTeamAssets\(\)\.then\(\(\) => \{ initTeamTab\(\); showTeamTab\(\); \}\)/,
    'the Settings entry must load the client before asking it to show the tab');
  assert.match(boot, /ensureTeamAssets\(\)\s*\n\s*\.then\(\(\) => \{ initTeamTab\(\); revealTeamTab\(\); \}\)/,
    'the LAN operator build must still get Team as a first-class tab');
});

test('a team client that cannot be fetched says so on the tab instead of vanishing', async () => {
  const sandbox = buildSandbox();
  const tabBtn = { hidden: true, clicked: false, click() { this.clicked = true; } };
  const body = { innerHTML: '' };
  sandbox.document.querySelector = (sel) => (sel === '.tabs button[data-tab="tab-team"]' ? tabBtn : null);
  sandbox.document.getElementById = (id) => (id === 'team-tab-body' ? body : null);
  const context = vm.createContext(sandbox);
  vm.runInContext(`${read('js/core.js')}\n;\n${read('js/boot.js')}\n;globalThis.teamLoadFailed = teamLoadFailed;`,
    context, { filename: 'boot-bundle.js' });

  sandbox.teamLoadFailed(true);
  assert.equal(tabBtn.hidden, false, 'team.js owns the tab visibility, so the fallback has to unhide it itself');
  assert.match(body.innerHTML, /team\.loadfail/, 'the user asked for the team surface and must be told why it is missing');
  assert.equal(tabBtn.clicked, true, 'an explicit tap must land on the explanation');

  const quiet = { hidden: true, clicked: false, click() { this.clicked = true; } };
  sandbox.document.querySelector = (sel) => (sel === '.tabs button[data-tab="tab-team"]' ? quiet : null);
  sandbox.teamLoadFailed(false);
  assert.equal(quiet.clicked, false, 'the LAN auto-reveal must not yank the operator onto the Team tab');
});

/* ---------- every honest-failure string is real, localized copy ---------- */

test('the degrade messages exist in both locales and carry no em-dash', () => {
  const I18N = require('./i18n-load.js');
  for (const key of ['qr.loading', 'qr.fail', 'cam.hlsfail', 'team.loadfail']) {
    for (const lang of ['en', 'es']) {
      const v = I18N[lang][key];
      assert.ok(typeof v === 'string' && v.length > 10, `${lang}.${key} is missing or a stub`);
      assert.ok(!v.includes('—'), `em-dash in ${lang}.${key}`);
    }
    assert.notEqual(I18N.en[key], I18N.es[key], `${key} was never actually translated`);
  }
});

test('the on-demand messages are styled where they render, not in the lazy stylesheet', () => {
  const app = read('css/app.css');
  assert.match(app, /\.qr-note \{/, 'the QR message renders while qrcode.min.js is absent');
  assert.match(app, /\.team-loadfail \{/,
    'the team failure message renders when css/team.css is exactly what failed to load');
  assert.ok(!read('css/team.css').includes('.team-loadfail'),
    'styling the team failure inside the stylesheet that failed to load would be unreadable');
});
