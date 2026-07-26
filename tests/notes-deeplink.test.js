'use strict';

/* The ?note= / ?notes= deep-link contract (v0.99.48).

   js/boot.js injects js/notes.js when the URL carries ?note or ?notes, and scripts/deploy.sh
   strips js/notes.js from the public artifact. On respondertx.org the injected script therefore
   404s, and before v0.99.48 that produced silence: a published parameter that did nothing at all.

   The decision was to keep the parameter rather than retire it, because it still resolves on the
   LAN ops board where notes.js exists. What changed is the mirror's answer: the injection now
   carries a failure handler, so a link that cannot open says so. These pin both halves, since
   either one alone restores the silence: the loader must wire onerror, and the notes injection
   must pass a handler that surfaces a localized message. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const I18N = require('./i18n-load.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const BOOT = read('js/boot.js');
const DEPLOY = read('scripts/deploy.sh');
const NOTICE_KEY = 'note.notesunavailable';

// the injection block, from the ?note/?notes guard to the loadScript call it ends with
const injection = BOOT.match(/if \(notesParams\.has\('notes'\)[\s\S]*?loadScript\([^\n]*\n/);

test('boot: the deep link still loads Field Notes on demand rather than being retired', () => {
  assert.ok(injection, 'js/boot.js no longer injects notes.js on ?note/?notes');
  assert.match(injection[0], /js\/notes\.js/);
});

test('boot: a note link that cannot load says so instead of doing nothing', () => {
  assert.match(
    injection[0],
    new RegExp(`loadScript\\([^)]*js/notes\\.js[^)]*,\\s*\\(\\)\\s*=>\\s*opNotice\\(t\\('${NOTICE_KEY.replace('.', '\\.')}'\\)\\)`),
    'the notes injection must pass a failure handler that surfaces the localized notice',
  );
});

/* The handler above is inert unless the loader actually attaches it, so run the real loadScript
   against a recording document and fire the error the mirror's 404 would produce. */
test('boot: loadScript wires the failure handler onto the injected element', () => {
  const src = BOOT.match(/const loadScript = \(src, onFail\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(src, 'the loadScript definition moved; this test can no longer reach it');

  const created = [];
  const appended = [];
  const sandbox = {
    document: {
      createElement(tag) { const el = { tag, src: '', onerror: null }; created.push(el); return el; },
      body: { appendChild(el) { appended.push(el); } },
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInContext(`${src[0]}\n;globalThis.__loadScript = loadScript;`, vm.createContext(sandbox));

  let failures = 0;
  sandbox.__loadScript('js/notes.js?v=test', () => { failures += 1; });
  assert.equal(created.length, 1, 'exactly one script element');
  assert.equal(appended.length, 1, 'the element must reach the document to load at all');
  assert.equal(created[0].src, 'js/notes.js?v=test');
  assert.equal(typeof created[0].onerror, 'function', 'a 404 would otherwise pass unnoticed');
  created[0].onerror(new Error('404'));
  assert.equal(failures, 1, 'the failure must reach the caller');

  // an injection with no handler must stay silent-by-omission rather than throw
  sandbox.__loadScript('js/chat.js');
  assert.equal(created[1].onerror, null);
});

test('the mirror really is the failing case: deploy.sh still strips notes.js', () => {
  assert.match(DEPLOY, /command rm -f "\$deploy_dir\/js\/notes\.js"/, 'removal');
  assert.match(DEPLOY, /\[ ! -e "\$deploy_dir\/js\/notes\.js" \]/, 'absence assertion');
  assert.match(DEPLOY, /for stripped in [^\n]*js\/notes\.js/, 'post-deploy strip-verify');
});

test('the notice is published in both languages and names no fix the reader cannot apply', () => {
  for (const lang of ['en', 'es']) {
    const s = I18N[lang][NOTICE_KEY];
    assert.equal(typeof s, 'string', `${lang} is missing ${NOTICE_KEY}`);
    assert.ok(s.trim().length > 20, `${lang} notice is too terse to explain the outcome`);
    assert.ok(!s.includes('—'), `${lang} notice uses a banned em-dash`);
  }
});
