'use strict';

/* Counts the assertion shape that let the v0.99.79 wildfire outage ship green: an assertion whose
   subject is the TEXT of a project file rather than the result of running it. Backs the ratchet in
   source-text-budget.test.js, and runs standalone (`node tests/source-text-scan.js`) to re-derive
   the baselines. The exact shape counted is documented in tests/README.md. */

const fs = require('node:fs');
const path = require('node:path');

const TESTS_DIR = __dirname;
const READ_CALL = /\b(?:fs\s*\.\s*)?readFileSync\s*\(/;

/* Two masked copies of the source, offset-for-offset with the original: `code` blanks comments
   only, `struct` also blanks string and regex CONTENTS so a `;` or an identifier inside a literal
   cannot be read as syntax. */
function mask(src) {
  const code = src.split('');
  const struct = src.split('');
  const blank = (i) => { if (src[i] !== '\n') { code[i] = ' '; struct[i] = ' '; } };
  const blankStr = (i) => { if (src[i] !== '\n') struct[i] = ' '; };
  let i = 0;
  let prev = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') blank(i++); continue; }
    if (c === '/' && src[i + 1] === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) blank(i++);
      blank(i); blank(i + 1); i += 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { blankStr(i); blankStr(i + 1); i += 2; continue; }
        if (src[i] === c) break;
        blankStr(i); i++;
      }
      i++; prev = '"'; continue;
    }
    if (c === '/' && /[([{,;=:!&|?+\-*%~^<>]/.test(prev)) { // regex literal, not division
      i++;
      let inClass = false;
      while (i < src.length && src[i] !== '\n') {
        if (src[i] === '\\') { blankStr(i); blankStr(i + 1); i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        blankStr(i); i++;
      }
      i++; prev = '/'; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return { code: code.join(''), struct: struct.join('') };
}

function matchParen(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// End offset of the initializer that starts at `from` (just past the `=`).
function initEnd(struct, from) {
  let depth = 0;
  for (let i = from; i < struct.length; i++) {
    const c = struct[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return i; depth--; }
    else if (c === ';' && depth === 0) return i;
    else if (c === '\n' && depth === 0) {
      const sofar = struct.slice(from, i).trimEnd();
      if (!sofar) continue;
      if (/[=+\-*/%&|?:,.<([{!]$/.test(sofar)) continue;      // an operator continues the expression
      if (/^\s*[.?)\]]|^\s*(?:\+|\|\||&&)/.test(struct.slice(i + 1))) continue; // a chained next line
      return i;
    }
  }
  return struct.length;
}

// Value references only: not `foo.NAME`, not an object key `NAME:`.
function refs(struct, name) {
  const re = new RegExp(`(^|[^\\w$.])${name}(?![\\w$])`, 'g');
  let m;
  while ((m = re.exec(struct))) {
    const after = struct.slice(m.index + m[0].length);
    if (/^\s*:/.test(after) && !/^\s*::/.test(after)) continue; // object key
    return true;
  }
  return false;
}

/* Which project file a read names. path.join('js','boot.js') and read('js/boot.js') must land on
   the same answer, so the segments of one call are joined rather than reported separately. */
function pathsRead(text, readers) {
  const re = new RegExp(`\\b(?:${readers.join('|')})\\s*\\(`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    const open = text.indexOf('(', m.index + m[0].length - 1);
    const end = matchParen(text, open);
    if (end < 0) continue;
    const segs = (text.slice(open + 1, end).match(/['"`]([^'"`]+)['"`]/g) || [])
      .map((s) => s.slice(1, -1))
      .filter((s) => !/^utf-?8$/i.test(s));
    if (segs.length) out.push(segs.join('/').replace(/\/{2,}/g, '/'));
  }
  return out;
}

function analyse(raw) {
  const { code, struct } = mask(raw);

  // Declarations, with their initializer span.
  const decls = [];
  const declRe = /(?:^|[;{}()\n,])\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/g;
  let m;
  while ((m = declRe.exec(struct))) {
    const eq = m.index + m[0].length;
    const end = initEnd(struct, eq);
    decls.push({ name: m[1], pos: m.index, init: true, struct: struct.slice(eq, end), text: code.slice(eq, end) });
  }
  // `for (const id of idsIn(src))` binds source text just as an assignment does
  const forRe = /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+/g;
  while ((m = forRe.exec(struct))) {
    const from = m.index + m[0].length;
    const end = matchParen(struct, struct.lastIndexOf('(', m.index + 4));
    decls.push({ name: m[1], pos: m.index, struct: struct.slice(from, end), text: code.slice(from, end) });
  }
  /* An accumulator filled inside a loop is the one derivation an initializer cannot show:
     `const stale = []` says nothing, and `stale.push(...)` two lines down is where the file text
     actually arrives. */
  const pushRe = /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\.\s*(?:push|unshift)\s*\(/g;
  while ((m = pushRe.exec(struct))) {
    const open = struct.indexOf('(', m.index + m[0].length - 1);
    const end = matchParen(struct, open);
    if (end < 0) continue;
    decls.push({ name: m[1], pos: m.index, struct: struct.slice(open + 1, end), text: code.slice(open + 1, end) });
  }
  decls.sort((a, b) => a.pos - b.pos);

  // A helper whose body reads a file is a reader; its RESULT is source text, it is not itself.
  const readers = new Set(['readFileSync']);
  for (const d of decls) {
    if (d.init && READ_CALL.test(d.struct) && /=>|\bfunction\b/.test(d.struct)) readers.add(d.name);
  }
  const fnRe = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{([\s\S]{0,400}?)\n\}/g;
  while ((m = fnRe.exec(struct))) {
    if (READ_CALL.test(m[2]) && /\breturn\b/.test(m[2])) readers.add(m[1]);
  }
  const readerList = [...readers];
  const readerCall = new RegExp(`\\b(?:${readerList.join('|')})\\s*\\(`);

  /* A binding holds source text when its initializer reads a file, or derives from one that does.
     A function-valued initializer is skipped: its parameters shadow, and its RESULT is what the
     caller asserts on. */
  const vars = new Map(); // name -> [{ pos, files }], so a name reused for a second file resolves by position
  const known = (name, at) => {
    const hits = vars.get(name);
    if (!hits) return null;
    let best = null;
    for (const h of hits) if (h.pos < at && (!best || h.pos > best.pos)) best = h;
    return best || hits[0];
  };
  const add = (name, pos, files) => {
    if (!vars.has(name)) vars.set(name, []);
    const hits = vars.get(name);
    if (hits.some((h) => h.pos === pos)) return false;
    hits.push({ pos, files });
    return true;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of decls) {
      if (readers.has(d.name)) continue;
      if (/^\s*JSON\s*\.\s*parse\s*\(/.test(d.struct)) continue; // a parsed artifact is data, not source text
      if (/=>|\bfunction\b/.test(d.struct)) continue;
      if (readerCall.test(d.struct)) { changed = add(d.name, d.pos, pathsRead(d.text, readerList)) || changed; continue; }
      for (const name of vars.keys()) {
        if (name === d.name || !refs(d.struct, name)) continue;
        const h = known(name, d.pos);
        if (h) { changed = add(d.name, d.pos, h.files) || changed; break; }
      }
    }
  }

  return { code, struct, vars, known, readerList, readerCall };
}

function scanFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const { code, struct, vars, known, readerList, readerCall } = analyse(raw);
  const lineOf = (idx) => raw.slice(0, idx).split('\n').length;

  const classify = (argStruct, argText, at) => {
    if (/^\s*JSON\s*\.\s*parse\s*\(/.test(argStruct)) return null;
    if (readerCall.test(argStruct)) return pathsRead(argText, readerList);
    let fallback = null;
    for (const name of vars.keys()) {
      if (!refs(argStruct, name)) continue;
      const h = known(name, at);
      if (!h) continue;
      if (h.files.length) return h.files; // a named file beats a derivation that lost its path
      fallback = h.files;
    }
    return fallback;
  };

  const blocks = [];
  const testRe = /(^|[^\w.$])(?:test|it)\s*\(/g;
  let m;
  while ((m = testRe.exec(struct))) {
    const open = struct.indexOf('(', m.index + m[0].length - 1);
    const end = matchParen(struct, open);
    if (end < 0) continue;
    const nameM = /^\s*['"`]/.test(code.slice(open + 1)) ? /['"`]([^'"`]*)/.exec(raw.slice(open + 1)) : null;
    blocks.push({ start: open, end, name: nameM ? nameM[1] : '(anonymous)', line: lineOf(m.index), total: 0, srcText: 0 });
  }

  const records = [];
  const assertRe = /\bassert\s*(?:\.\s*([A-Za-z]+)\s*)?\(/g;
  while ((m = assertRe.exec(struct))) {
    const open = struct.indexOf('(', m.index + 6);
    const end = matchParen(struct, open);
    if (end < 0) continue;
    let cut = end;
    let depth = 0;
    for (let i = open + 1; i < end; i++) {
      const c = struct[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) { cut = i; break; }
    }
    const files = classify(struct.slice(open + 1, cut), code.slice(open + 1, cut), m.index);
    records.push({ method: m[1] || '(call)', line: lineOf(m.index), files });
    let owner = null;
    for (const b of blocks) if (m.index > b.start && m.index < b.end && (!owner || b.start > owner.start)) owner = b;
    if (owner) { owner.total++; if (files) owner.srcText++; }
  }

  return {
    file: path.basename(file),
    asserts: records.length,
    sourceText: records.filter((r) => r.files).length,
    sourceTextJs: records.filter((r) => r.files && r.files.some(isExecutableJs)).length,
    tests: blocks.length,
    testsAllSourceText: blocks.filter((b) => b.total > 0 && b.srcText === b.total).length,
    blocks, records,
  };
}

// Files the node harness can load and run; a source-text assertion against one has an alternative.
function isExecutableJs(p) {
  return /(^|\/)js\/[\w-]+\.js$/.test(p) || /(^|\/)sw\.js$/.test(p);
}

function scanAll() {
  const per = fs.readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.js')).sort()
    .map((f) => scanFile(path.join(TESTS_DIR, f)));
  const sum = (k) => per.reduce((a, r) => a + r[k], 0);
  return { per, asserts: sum('asserts'), sourceText: sum('sourceText'), sourceTextJs: sum('sourceTextJs'),
    tests: sum('tests'), testsAllSourceText: sum('testsAllSourceText') };
}

module.exports = { scanAll, scanFile, isExecutableJs };

if (require.main === module) {
  const r = scanAll();
  for (const p of r.per.filter((x) => x.sourceText).sort((a, b) => b.sourceText - a.sourceText)) {
    console.log(`${String(p.sourceText).padStart(4)}/${String(p.asserts).padEnd(4)} src-text  ` +
      `${String(p.sourceTextJs).padStart(4)} vs js/  ` +
      `${String(p.testsAllSourceText).padStart(3)}/${String(p.tests).padEnd(3)} tests all-src-text  ${p.file}`);
  }
  console.log(`\nSOURCE_TEXT_BASELINE ${r.sourceText}   (of ${r.asserts} assertions, ` +
    `${((r.sourceText / r.asserts) * 100).toFixed(1)}%; ${r.sourceTextJs} of them against executable js)`);
  console.log(`UNEXECUTED_TEST_BASELINE ${r.testsAllSourceText}   (of ${r.tests} tests)`);
}
