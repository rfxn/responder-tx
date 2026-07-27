'use strict';

/*
 * Hazard-allowlist agreement, in one implementation used by two callers: tests/hazard-table.test.js
 * asserts on it, and scripts/cycle-check.sh runs this file directly as a release gate.
 *
 * Three facts are checked, and all three fail silently in production if they are not:
 *   1. js/sources.js HAZARD_EVENTS and the scripts/gen-caltopo.py mirror are the same table. Nothing
 *      at runtime compares them, so drift means the board and its export describe different hazard
 *      sets while each looks correct alone.
 *   2. js/core.js LSR_HAZARD_RE and the generator's copy are the same pattern.
 *   3. Every event string still exists in the live NWS catalogue. An unknown event= value returns
 *      HTTP 200 with zero features rather than an error, so a typo or a retired product name
 *      publishes "no tornado warnings" instead of failing.
 *
 * Check 3 skips on a transport failure only: an api.weather.gov outage must not fail a commit or
 * stop a flood publish, but a reachable catalogue that disagrees is a hard failure.
 *
 * Both sides are read from the same directory tree, so cycle-check --code-from-head compares HEAD's
 * js/sources.js against HEAD's gen-caltopo.py rather than one copy of each.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { loadApp } = require('./harness.js');

const ROOT = path.join(__dirname, '..');
const TYPES_URL = 'https://api.weather.gov/alerts/types';
const UA = 'responder-tx-ops/hazard-mirror (rfxnryan@gmail.com)';
const MIN_TABLE = 30; // non-vacuity floor: a table this small is a truncated read, not a real allowlist
const MIN_TYPES = 80; // the catalogue has carried >100 strings for years; far under that is a bad read

function jsSide() {
  const { HAZARD_EVENTS, HAZARD_EVENT_LIST, LSR_HAZARD_RE } = loadApp();
  return { events: HAZARD_EVENTS, list: HAZARD_EVENT_LIST, lsr: LSR_HAZARD_RE.source };
}

// run the generator rather than parse it: a regex over the source would pass on a table the
// interpreter never sees
function pySide() {
  const src = 'import json,sys;import importlib.util as u;'
    + `s=u.spec_from_file_location("gc",${JSON.stringify(path.join(ROOT, 'scripts', 'gen-caltopo.py'))});`
    + 'm=u.module_from_spec(s);s.loader.exec_module(m);'
    + 'print(json.dumps({"events":{k:list(v) for k,v in m.HAZARD_EVENTS.items()},"lsr":m.LSR_HAZARD_RE.pattern}))';
  return JSON.parse(execFileSync('python3', ['-c', src], { cwd: ROOT, encoding: 'utf8' }));
}

// the mirror halves, offline and hard-failing. Returns a list of problems, empty when they agree.
function mirrorProblems(js, py) {
  const out = [];
  if (js.list.length < MIN_TABLE) out.push(`js hazard table has only ${js.list.length} entries`);
  if (Object.keys(py.events).length < MIN_TABLE) out.push(`python hazard mirror has only ${Object.keys(py.events).length} entries`);
  if (out.length) return out;

  for (const ev of js.list) {
    if (!py.events[ev]) { out.push(`${ev}: in js/sources.js, missing from the gen-caltopo.py mirror`); continue; }
    const [cls, rank] = py.events[ev];
    if (cls !== js.events[ev].cls || rank !== js.events[ev].rank) {
      out.push(`${ev}: js says ${js.events[ev].cls}/${js.events[ev].rank}, python says ${cls}/${rank}`);
    }
  }
  for (const ev of Object.keys(py.events)) {
    if (!js.events[ev]) out.push(`${ev}: in the gen-caltopo.py mirror, missing from js/sources.js`);
  }
  if (js.lsr !== py.lsr) out.push('LSR_HAZARD_RE differs between js/core.js and scripts/gen-caltopo.py');
  return out;
}

/* Live catalogue. Resolves to { types } when reachable, or { skipped: reason } on a transport
   failure. A reachable-but-implausible catalogue is an error, not a skip: it would let every
   membership test pass vacuously. */
async function fetchTypes(timeoutMs) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs || 15000);
    let res;
    try {
      res = await fetch(TYPES_URL, { headers: { 'User-Agent': UA, Accept: 'application/ld+json' }, signal: ac.signal });
    } finally { clearTimeout(timer); }
    if (!res.ok) return { skipped: `HTTP ${res.status}` };
    const types = (await res.json()).eventTypes;
    if (!Array.isArray(types) || types.length < MIN_TYPES) {
      return { bad: `/alerts/types returned ${Array.isArray(types) ? types.length : 'no'} entries, which cannot be the real catalogue` };
    }
    return { types };
  } catch (e) {
    return { skipped: e.message };
  }
}

async function main() {
  const js = jsSide();
  let py;
  try { py = pySide(); } catch (e) {
    process.stderr.write(`hazard mirror: cannot read the python side: ${e.message}\n`);
    process.exit(1);
  }
  const problems = mirrorProblems(js, py);
  if (problems.length) {
    process.stderr.write(`hazard mirror disagreement:\n  ${problems.join('\n  ')}\n`);
    process.exit(1);
  }

  const up = await fetchTypes(15000);
  if (up.bad) {
    process.stderr.write(`hazard mirror: ${up.bad}\n`);
    process.exit(1);
  }
  if (up.skipped) {
    process.stdout.write(`${js.list.length} events mirrored, upstream not checked (${up.skipped})`);
    return;
  }
  const missing = js.list.filter((ev) => !up.types.includes(ev));
  if (missing.length) {
    process.stderr.write('these event strings are not in the live NWS catalogue, so the board would '
      + `silently publish zero of them:\n  ${missing.join('\n  ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`${js.list.length} events mirrored, all present in ${up.types.length} upstream types`);
}

module.exports = { jsSide, pySide, mirrorProblems, fetchTypes, MIN_TABLE, MIN_TYPES };

if (require.main === module) {
  main().catch((e) => { process.stderr.write(`hazard mirror: ${e.stack}\n`); process.exit(1); });
}
