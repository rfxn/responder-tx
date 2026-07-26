'use strict';

/* The about/methodology surface and the version-poll artifact it shipped alongside.
 *
 * Two things are pinned here. First, a life-safety board that a stranger can reach must be able to
 * say who runs it, what it will not do, and what its two opt-in relays keep, without leaving the
 * board for GitHub. Second, the update poll must never again pull the whole changelog (~145 KB,
 * every 180 s) to read one version string, while the changelog modal must still show full history.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSandbox } = require('./harness.js');
const I18N = require('./i18n-load.js');

const ROOT = path.join(__dirname, '..');
const readRoot = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const HTML = readRoot('index.html');
const BOOT = readRoot('js/boot.js');

/* boot.js sandbox with recording nodes, a scriptable fetch and held timers: checkAppVersion arms a
   5 s rollover interval and openChangelog writes localStorage, neither of which may escape a run. */
function loadAbout() {
  const sandbox = buildSandbox();
  const nodes = new Map();
  const node = (sel) => {
    if (!nodes.has(sel)) {
      const classes = new Set();
      nodes.set(sel, {
        id: String(sel).replace(/^#/, ''),
        style: {}, dataset: {}, value: '', textContent: '', innerHTML: '', title: '', hidden: true,
        classList: {
          add: (c) => classes.add(c),
          remove: (c) => classes.delete(c),
          toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
          contains: (c) => classes.has(c),
        },
        classes,
        setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
        appendChild() {}, append() {}, remove() {}, add() {},
        addEventListener() {}, removeEventListener() {},
        querySelector() { return null; }, querySelectorAll() { return []; },
        dispatchEvent() { return true; }, closest() { return null; }, scrollIntoView() {},
      });
    }
    return nodes.get(sel);
  };
  sandbox.document.querySelector = node;
  sandbox.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  sandbox.setInterval = () => 1;
  sandbox.setTimeout = () => 1;
  sandbox.clearTimeout = () => {};
  sandbox.fetches = [];
  sandbox.fetchBody = null;
  sandbox.fetch = (url) => {
    sandbox.fetches.push(String(url));
    if (sandbox.fetchBody === null) return Promise.reject(new Error('no body scripted'));
    return Promise.resolve({ ok: true, json: () => Promise.resolve(sandbox.fetchBody) });
  };

  const files = ['core.js', 'usng.js', 'map.js', 'playback.js', 'sources.js', 'cameras.js', 'board.js', 'boot.js'];
  const exports = ['APP_VERSION', 'ABOUT_SECTIONS', 'ABOUT_REPO', 'renderAbout', 'openAbout', 'checkAppVersion', 'openChangelog', 'state'];
  const src = files.map((f) => fs.readFileSync(path.join(ROOT, 'js', f), 'utf8')).join('\n;\n')
    + `\n;globalThis.__ABOUT = { ${exports.join(', ')} };\n`;
  vm.runInContext(src, vm.createContext(sandbox), { filename: 'about-bundle.js' });
  return { ...sandbox.__ABOUT, node, sandbox };
}

// every string the about surface can paint, plus the Settings row that opens it
const aboutKeys = () => Object.keys(I18N.en).filter((k) => k === 'set.about' || k === 'set.about.title' || k.indexOf('about.') === 0);

/* ---------- reachability ---------- */

test('about: the Settings sheet Help group is the one door, with no competing header control', () => {
  const sheet = HTML.slice(HTML.indexOf('id="hmore-menu"'), HTML.indexOf('</div>\n      </div>\n      <div class="refresh-meta"'));
  assert.ok(sheet.includes('id="about-btn"'), '#about-btn must live inside #hmore-menu');

  // it belongs to the existing Help group: after that heading, alongside Legend and What's new
  const help = sheet.indexOf('data-i18n="set.g.help"');
  assert.notEqual(help, -1, 'the Help group heading must still exist');
  assert.ok(sheet.indexOf('id="about-btn"') > help, '#about-btn must sit inside the Help group');

  assert.equal(HTML.split('id="about-btn"').length - 1, 1, 'exactly one about control may exist');
  const controls = HTML.slice(HTML.indexOf('<div class="controls"'), HTML.indexOf('id="hmore-menu"'));
  assert.ok(!/about/i.test(controls), 'the header control strip must gain no about door of its own');
});

test('about: the modal, its labelled title and its body container are declared in index.html', () => {
  assert.ok(HTML.includes('id="about-modal"'), '#about-modal must be declared');
  assert.ok(HTML.includes('id="about-body"'), '#about-body must be declared');
  assert.ok(HTML.includes('id="about-close"'), '#about-close must be declared');
  const modal = HTML.slice(HTML.indexOf('id="about-modal"'), HTML.indexOf('id="about-modal"') + 400);
  assert.ok(modal.includes('role="dialog"') && modal.includes('aria-modal="true"'), 'the about surface must be a dialog');
  assert.ok(modal.includes('aria-labelledby="about-title"'), 'the dialog must be labelled by its own title');
});

test('about: boot.js opens, closes and traps it like every other static overlay', () => {
  assert.ok(/\$\('#about-btn'\)\.addEventListener\('click', openAbout\)/.test(BOOT), 'the Settings row must open the surface');
  assert.ok(/registerModal\(\$\('#about-modal'\)\)/.test(BOOT), 'the about dialog must be a registered modal (focus trap + inert background)');
  assert.ok(/\$\('#about-close'\)\.addEventListener/.test(BOOT), 'the close button must be wired');
  assert.ok(/e\.target\.id === 'about-modal'/.test(BOOT), 'a backdrop click must dismiss it');

  // the Escape chain and the update-rollover busy list both have to know about a new overlay:
  // one so it can be dismissed, the other so a reload never yanks it out from under a reader
  const escape = BOOT.slice(BOOT.indexOf("for (const id of ['#health-modal'"));
  assert.ok(escape.slice(0, 400).includes("'#about-modal'"), 'Escape must close the about surface');
  const busy = BOOT.slice(BOOT.indexOf("for (const id of ['#safety-modal'"));
  assert.ok(busy.slice(0, 500).includes("'#about-modal'"), 'an open about surface must count as busy for the update rollover');
});

/* ---------- content: parity, punctuation, and the claims that must be there ---------- */

test('about: every claim string has en and es parity and neither table carries an em-dash', () => {
  const keys = aboutKeys();
  assert.ok(keys.length >= 25, `expected the full about surface, saw ${keys.length} keys`);
  for (const k of keys) {
    for (const lang of ['en', 'es']) {
      assert.equal(typeof I18N[lang][k], 'string', `${k} missing from ${lang}`);
      assert.ok(I18N[lang][k].trim().length > 0, `${k} is empty in ${lang}`);
      assert.ok(!I18N[lang][k].includes('—'), `em-dash in ${lang} ${k}`);
    }
  }
});

test('about: every key the renderer paints exists in both tables', () => {
  const { ABOUT_SECTIONS } = loadAbout();
  const painted = ['about.head', 'about.sec.source', 'about.src.repo', 'about.src.license'];
  for (const [sec, keys] of ABOUT_SECTIONS) painted.push(sec, ...keys);
  for (const k of painted) {
    assert.equal(typeof I18N.en[k], 'string', `renderAbout paints ${k}, absent from en`);
    assert.equal(typeof I18N.es[k], 'string', `renderAbout paints ${k}, absent from es`);
  }
});

test('about: it says who runs the board and links the source and the license', () => {
  const { ABOUT_REPO } = loadAbout();
  assert.equal(ABOUT_REPO, 'https://github.com/rfxn/responder-tx');
  assert.ok(/renderAbout[\s\S]*?ABOUT_REPO\}\/blob\/main\/LICENSE/.test(BOOT), 'the license file must be linked, not just named');
  for (const needle of ['Ryan MacDonald', 'R-fx Networks', 'GNU GPL v2']) {
    assert.ok(I18N.en['about.who'].includes(needle), `about.who must name ${needle}`);
    assert.ok(I18N.es['about.who'].includes(needle), `es about.who must name ${needle}`);
  }
  assert.ok(I18N.en['about.src.license'].includes('GNU GPL v2'));
  assert.ok(I18N.es['about.src.license'].includes('GNU GPL v2'));
});

test('about: the three "what it is not" claims survive intact in both languages', () => {
  assert.match(I18N.en['about.not.dispatch'], /Not a dispatch/);
  assert.match(I18N.en['about.not.dispatch'], /911/);
  assert.match(I18N.en['about.not.official'], /Not an official warning source/);
  assert.match(I18N.en['about.not.official'], /Wireless Emergency Alerts/);
  assert.match(I18N.en['about.not.monitored'], /Not monitored/);
  assert.match(I18N.es['about.not.dispatch'], /No es un sistema de despacho/);
  assert.match(I18N.es['about.not.official'], /No es una fuente oficial/);
  assert.match(I18N.es['about.not.monitored'], /No está monitoreado/);
});

test('about: the honesty discipline states all four invariants', () => {
  assert.match(I18N.en['about.honest.stale'], /Stale never shows as live/);
  assert.match(I18N.en['about.honest.suppress'], /Suppressing is not deleting/);
  assert.match(I18N.en['about.honest.suppress'], /history and playback/);
  assert.match(I18N.en['about.honest.fcst'], /Forecast is labeled distinctly from observed/);
  assert.match(I18N.en['about.honest.cite'], /Every card carries a provenance badge/);
  assert.match(I18N.es['about.honest.stale'], /nunca se muestra como actual/);
  assert.match(I18N.es['about.honest.suppress'], /Suprimir no es borrar/);
  assert.match(I18N.es['about.honest.cite'], /insignia de procedencia/);
});

/* srcBadge() has exactly two kinds. Naming a third ("field") on a trust surface would describe a
   badge the board cannot draw, so the claim is pinned to what js/core.js can actually render. */
test('about: the provenance claim names only the badges the board can actually draw', () => {
  // srcBadge() interpolates src.<kind>, so the i18n table is what bounds the set of drawable badges
  const badges = Object.keys(I18N.en).filter((k) => /^src\.[a-z]+$/.test(k)).sort();
  assert.deepEqual(badges, ['src.curated', 'src.official'], 'a new badge kind means this claim needs revisiting');
  assert.ok(!/field report/i.test(I18N.en['about.honest.cite']), 'about must not claim a field badge the board never renders');
  assert.ok(!/reporte de campo/i.test(I18N.es['about.honest.cite']), 'es about must not claim a field badge either');
});

test('about: the privacy text names BOTH opt-in relays and what each one stores', () => {
  const en = `${I18N.en['about.privacy.local']} ${I18N.en['about.privacy.team']} ${I18N.en['about.privacy.push']} ${I18N.en['about.privacy.both']}`;
  // relay one: live team sharing
  assert.match(en, /team/i);
  assert.match(en, /handle/i);
  assert.match(en, /breadcrumb/i);
  // relay two: device alerts
  assert.match(en, /[Dd]evice alerts/);
  assert.match(en, /push subscription/i);
  assert.match(en, /five points/i);
  assert.match(en, /kilometer/i);
  // and the promise that binds both
  assert.match(en, /opt in/i);
  assert.match(en, /no name, email, account or retained IP/i);
  assert.match(en, /No accounts, no analytics/);

  const es = `${I18N.es['about.privacy.local']} ${I18N.es['about.privacy.team']} ${I18N.es['about.privacy.push']} ${I18N.es['about.privacy.both']}`;
  assert.match(es, /equipo/);
  assert.match(es, /identificador/);
  assert.match(es, /rastro/);
  assert.match(es, /suscripción de notificaciones/);
  assert.match(es, /cinco puntos/);
  assert.match(es, /kilómetro/);
  assert.match(es, /opcional/);
  assert.match(es, /Sin cuentas, sin analítica/);
});

test('about: the alert promise stays best effort, not a WEA, not a 911 replacement', () => {
  assert.match(I18N.en['about.alerts'], /best effort/i);
  assert.match(I18N.en['about.alerts'], /not Wireless Emergency Alerts/i);
  assert.match(I18N.en['about.alerts'], /911/);
  assert.match(I18N.es['about.alerts'], /mejor esfuerzo/i);
  assert.match(I18N.es['about.alerts'], /Alertas Inalámbricas de Emergencia/);
  assert.match(I18N.es['about.alerts'], /911/);
});

test('about: it does not duplicate the glossary', () => {
  const { ABOUT_SECTIONS } = loadAbout();
  const keys = [];
  for (const [sec, ks] of ABOUT_SECTIONS) keys.push(sec, ...ks);
  assert.equal(keys.filter((k) => k.indexOf('glossary.') === 0).length, 0, 'the about surface must not re-render glossary strings');
  assert.ok(keys.length >= 15, `expected a substantive surface, saw ${keys.length} keys`);
});

test('about: renderAbout paints every section into #about-body', () => {
  const { renderAbout, ABOUT_SECTIONS, node } = loadAbout();
  renderAbout();
  const html = node('#about-body').innerHTML;
  assert.ok(html.length > 0, '#about-body must not be left empty');
  for (const [sec, keys] of ABOUT_SECTIONS) {
    assert.ok(html.includes(sec), `missing section heading ${sec}`); // sandbox t() echoes the key
    for (const k of keys) assert.ok(html.includes(k), `missing claim ${k}`);
  }
  assert.ok(html.includes('github.com/rfxn/responder-tx'), 'the repo link must be painted');
  assert.ok(html.includes('/blob/main/LICENSE'), 'the license link must be painted');
  assert.ok(html.includes('rel="noopener"'), 'outbound links must carry rel=noopener');
});

/* ---------- the version poll ---------- */

test('poll: checkAppVersion reads data/version.json, never the full changelog', async () => {
  const { checkAppVersion, sandbox } = loadAbout();
  sandbox.fetchBody = { version: 'v99.0.0' };
  await checkAppVersion();
  assert.equal(sandbox.fetches.length, 1, 'the poll must make exactly one request');
  assert.match(sandbox.fetches[0], /^data\/version\.json\?/, `polled ${sandbox.fetches[0]}`);
  assert.ok(!sandbox.fetches[0].includes('changelog'), 'the poll must not touch the changelog');
});

test('poll: a newer version still raises the update chip; the running version does not', async () => {
  const newer = loadAbout();
  newer.sandbox.fetchBody = { version: 'v99.0.0' };
  await newer.checkAppVersion();
  assert.equal(newer.node('#update-chip').hidden, false, 'a new build must badge immediately');
  assert.equal(newer.state.updateTarget, 'v99.0.0', 'the rollover must be armed for the new build');

  const same = loadAbout();
  same.sandbox.fetchBody = { version: same.APP_VERSION };
  await same.checkAppVersion();
  assert.equal(same.node('#update-chip').hidden, true, 'the running version must not badge');
  assert.equal(same.state.updateTarget, undefined, 'no rollover may be armed for the running build');
});

test('poll: an unreadable or missing artifact is silent, exactly as an offline poll was', async () => {
  const t1 = loadAbout();
  t1.sandbox.fetchBody = null; // fetch rejects
  await t1.checkAppVersion();
  assert.equal(t1.node('#update-chip').hidden, true);

  const t2 = loadAbout();
  t2.sandbox.fetchBody = {}; // served, but no version key
  await t2.checkAppVersion();
  assert.equal(t2.node('#update-chip').hidden, true);
});

test('poll: data/version.json is tiny, well-formed and agrees with APP_VERSION', () => {
  const raw = readRoot('data/version.json');
  assert.ok(raw.endsWith('\n'), 'the artifact must end with a newline');
  assert.ok(raw.length < 200, `the poll artifact must stay tiny, saw ${raw.length} bytes`);
  const app = /APP_VERSION = '([^']+)'/.exec(readRoot('js/core.js'))[1];
  assert.equal(JSON.parse(raw).version, app, 'data/version.json must track APP_VERSION');
});

test('changelog: the modal still fetches and renders the full history', async () => {
  const { openChangelog, sandbox, node } = loadAbout();
  const versions = Array.from({ length: 271 }, (_, i) => ({ v: `v0.1.${i}`, line: `entry ${i}` }));
  sandbox.fetchBody = { versions };
  await openChangelog();
  assert.equal(sandbox.fetches.length, 1);
  assert.match(sandbox.fetches[0], /^data\/changelog\.json\?/, 'the modal is the one reader of full history');
  const html = node('#changelog-body').innerHTML;
  assert.equal(html.split('class="chg-row"').length - 1, versions.length, 'every version must render a row');
  assert.ok(html.includes('v0.1.0') && html.includes('v0.1.270'), 'the oldest and newest entries must both be present');
  assert.equal(node('#changelog-modal').hidden, false, 'the modal must open');
});
