'use strict';

/* A budget, not a gate: the suite's source-text habit may shrink, never grow.

   v0.99.79 shipped the wildfire layer completely dead behind six green tests, all of them
   `assert.match(<the text of a js file>, /.../)`. A string existing in a file proves nothing about
   whether the code runs, and it also breaks spuriously when a COMMENT is edited. The backlog of
   1,000-odd such assertions is too large to convert in one pass, so this holds the line while it
   burns down. See tests/README.md for the exact shape counted and how to move these numbers. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { scanAll } = require('./source-text-scan.js');

// Assertions whose subject is file text rather than a value the app produced. Lower it, never raise it.
const SOURCE_TEXT_BASELINE = 726;
// Tests in which EVERY assertion is source-text, so the feature could be deleted and the test would pass.
const UNEXECUTED_TEST_BASELINE = 130;

const scan = scanAll();

const table = (pick) => scan.per.filter(pick).sort((a, b) => b.sourceText - a.sourceText)
  .map((p) => `  ${String(p.sourceText).padStart(4)} src-text (${p.sourceTextJs} of them against js the harness can run)  ${p.file}`)
  .join('\n');

test('source-text assertions do not grow', () => {
  assert.ok(scan.sourceText <= SOURCE_TEXT_BASELINE,
    `source-text assertions rose to ${scan.sourceText} from a baseline of ${SOURCE_TEXT_BASELINE}.\n` +
    'Assert on what the code RETURNS, not on the text of the file it lives in. tests/harness.js\n' +
    'loadApp() / loadMapApp() / loadWiredMap() exist for this.\n' + table((p) => p.sourceText));

  assert.ok(scan.sourceText >= SOURCE_TEXT_BASELINE,
    `source-text assertions are down to ${scan.sourceText}. Lower SOURCE_TEXT_BASELINE in this file ` +
    `to ${scan.sourceText} so the gain is held.`);
});

test('tests with no executed assertion do not grow', () => {
  const all = scan.per.flatMap((p) => p.blocks.filter((b) => b.total > 0 && b.srcText === b.total)
    .map((b) => `  ${p.file}:${b.line}  ${b.name}`));

  assert.ok(scan.testsAllSourceText <= UNEXECUTED_TEST_BASELINE,
    `tests that execute no application code rose to ${scan.testsAllSourceText} from a baseline of ` +
    `${UNEXECUTED_TEST_BASELINE}. Each of these would still pass if the feature under test were deleted.\n` +
    all.join('\n'));

  assert.ok(scan.testsAllSourceText >= UNEXECUTED_TEST_BASELINE,
    `tests that execute no application code are down to ${scan.testsAllSourceText}. Lower ` +
    `UNEXECUTED_TEST_BASELINE in this file to ${scan.testsAllSourceText} so the gain is held.`);
});

/* The scanner is the thing everything above trusts, so it gets its own coverage: a shape it stops
   recognising would silently unlock the growth this file exists to prevent. */
test('the scanner still recognises the shape it is counting', () => {
  const { scanFile } = require('./source-text-scan.js');
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-text-scan-'));
  const file = path.join(dir, 'sample.test.js');
  try {
    fs.writeFileSync(file, [
      "const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');",
      "const src = read('js/sources.js');",
      "const BOOT = fs.readFileSync(path.join(ROOT, 'js', 'boot.js'), 'utf8');",
      "const parsed = JSON.parse(read('data/wildfire.json'));",
      "test('counted: direct match on file text', () => { assert.match(src, /x/); });",
      "test('counted: extract a body, then regex the body', () => {",
      "  const fn = src.slice(src.indexOf('function f'), src.indexOf('\\n}'));",
      '  assert.ok(fn.includes(\'y\'));',
      '});',
      "test('counted: a second file under a reused name', () => {",
      "  const src = read('js/map.js');",
      '  assert.match(src, /z/);',
      '});',
      "test('not counted: the value the app returned', () => { assert.equal(popup(FIRE), 'ok'); });",
      "test('not counted: a parsed artifact', () => { assert.equal(parsed.generated, 'x'); });",
      "test('not counted: an object literal with a src: key', () => {",
      "  const FIRE = { id: 'a', src: 'tfs' };",
      "  assert.equal(FIRE.src, 'tfs');",
      '});',
      "test('mixed: regexes the source AND runs it, so it is not an unexecuted test', () => {",
      '  assert.match(BOOT, /q/);',
      "  assert.equal(render(), 'ok');",
      '});',
    ].join('\n'));
    const r = scanFile(file);
    assert.equal(r.sourceText, 4, 'three counted tests plus the source half of the mixed one');
    assert.equal(r.tests, 7);
    assert.equal(r.testsAllSourceText, 3, 'the mixed test executes something and must not be counted');
    const byLine = Object.fromEntries(r.records.map((x) => [x.line, x.files]));
    assert.deepEqual(byLine[5], ['js/sources.js']);
    assert.deepEqual(byLine[12], ['js/map.js'], 'a name reused for another file resolves by position');
    assert.deepEqual(byLine[21], ['js/boot.js'], "path.join('js','boot.js') must name the same file as read('js/boot.js')");
    assert.equal(byLine[18], null, "an object literal's `src:` key is not a read");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
