'use strict';

/*
 * Hazard-allowlist agreement, in one implementation used by two callers: tests/hazard-table.test.js
 * asserts on it, and scripts/cycle-check.sh runs this file directly as a release gate.
 *
 * Four facts are checked, and all of them fail silently in production if they are not:
 *   1. js/sources.js HAZARD_EVENTS and the scripts/gen-caltopo.py mirror are the same table. Nothing
 *      at runtime compares them, so drift means the board and its export describe different hazard
 *      sets while each looks correct alone.
 *   2. js/core.js LSR_HAZARD_RE and the generator's copy are the same pattern.
 *   3. No heat product is admitted. Owner decision (2026-07-27): heat is not the awareness this
 *      board is built for, and a Texas summer afternoon is a dozen heat advisories that teach a
 *      responder the hazard surfaces are noise before the tornado warning lands there next week.
 *      Asserted here rather than written down, because the table is edited every time the board
 *      goes wider and nothing else would notice heat arriving with the rest of a standing tier.
 *   4. Every event string still exists in the NWS catalogue. An unknown event= value returns
 *      HTTP 200 with zero features rather than an error, so a typo or a retired product name
 *      publishes "no tornado warnings" instead of failing.
 *
 * Check 4 reads the PINNED_TYPES catalogue below by default, because this file runs inside the
 * publish gate and a flood publish may neither wait on api.weather.gov nor lose the check to an
 * outage. `--upstream` re-judges against the live catalogue, which is how PINNED_TYPES is refreshed.
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
// The NWS product catalogue as of PINNED_CAPTURED, pinned here rather than in tests/fixtures/
// because cycle-check.sh --code-from-head materializes this file and not a sibling one, and a
// catalogue read from a different lane than the table it judges is the check E3 warns about.
const PINNED_CAPTURED = '2026-07-29';
const PINNED_TYPES = [
  '911 Telephone Outage', 'Administrative Message', 'Air Quality Alert', 'Air Stagnation Advisory',
  'Ashfall Advisory', 'Ashfall Warning', 'Avalanche Advisory', 'Avalanche Warning', 'Avalanche Watch',
  'Beach Hazards Statement', 'Blizzard Warning', 'Blowing Dust Advisory', 'Blowing Dust Warning', 'Blue Alert',
  'Brisk Wind Advisory', 'Child Abduction Emergency', 'Civil Danger Warning', 'Civil Emergency Message',
  'Coastal Flood Advisory', 'Coastal Flood Statement', 'Coastal Flood Warning', 'Coastal Flood Watch',
  'Cold Weather Advisory', 'Dense Fog Advisory', 'Dense Smoke Advisory', 'Dust Advisory', 'Dust Storm Warning',
  'Earthquake Warning', 'Evacuation Immediate', 'Extreme Cold Warning', 'Extreme Cold Watch',
  'Extreme Fire Danger', 'Extreme Heat Warning', 'Extreme Heat Watch', 'Extreme Wind Warning', 'Fire Warning',
  'Fire Weather Watch', 'Flash Flood Statement', 'Flash Flood Warning', 'Flash Flood Watch', 'Flood Advisory',
  'Flood Statement', 'Flood Warning', 'Flood Watch', 'Freeze Warning', 'Freeze Watch', 'Freezing Fog Advisory',
  'Freezing Spray Advisory', 'Frost Advisory', 'Gale Warning', 'Gale Watch', 'Hazardous Materials Warning',
  'Hazardous Seas Warning', 'Hazardous Seas Watch', 'Hazardous Weather Outlook', 'Heat Advisory',
  'Heavy Freezing Spray Warning', 'Heavy Freezing Spray Watch', 'High Surf Advisory', 'High Surf Warning',
  'High Wind Warning', 'High Wind Watch', 'Hurricane Force Wind Warning', 'Hurricane Force Wind Watch',
  'Hurricane Warning', 'Hurricane Watch', 'Hydrologic Outlook', 'Ice Storm Warning',
  'Lake Effect Snow Warning', 'Lake Wind Advisory', 'Lakeshore Flood Advisory', 'Lakeshore Flood Statement',
  'Lakeshore Flood Warning', 'Lakeshore Flood Watch', 'Law Enforcement Warning', 'Local Area Emergency',
  'Low Water Advisory', 'Marine Weather Statement', 'Nuclear Power Plant Warning',
  'Radiological Hazard Warning', 'Red Flag Warning', 'Rip Current Statement', 'Severe Thunderstorm Warning',
  'Severe Thunderstorm Watch', 'Severe Weather Statement', 'Shelter In Place Warning', 'Short Term Forecast',
  'Small Craft Advisory', 'Snow Squall Warning', 'Special Marine Warning', 'Special Weather Statement',
  'Storm Surge Warning', 'Storm Surge Watch', 'Storm Warning', 'Storm Watch', 'Test', 'Tornado Warning',
  'Tornado Watch', 'Tropical Cyclone Local Statement', 'Tropical Storm Warning', 'Tropical Storm Watch',
  'Tsunami Advisory', 'Tsunami Warning', 'Tsunami Watch', 'Typhoon Warning', 'Typhoon Watch',
  'Volcano Warning', 'Wind Advisory', 'Winter Storm Warning', 'Winter Storm Watch', 'Winter Weather Advisory'
];

const MIN_TABLE = 30; // non-vacuity floor: a table this small is a truncated read, not a real allowlist
const MIN_TYPES = 80; // the catalogue has carried >100 strings for years; far under that is a bad read
// every NWS heat product carries the word; no flood, wind or storm product does
const HEAT_RE = /\bheat\b/i;

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

  // both sides, not just js: a heat row reaching only the export still puts heat on a responder's map
  for (const ev of new Set([...js.list, ...Object.keys(py.events)])) {
    if (HEAT_RE.test(ev)) out.push(`${ev}: heat products are excluded from this board by decision, not by omission`);
  }

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

/* The pinned catalogue. Its plausibility is checked the same way the live one's is, so a
   truncated or hand-edited fixture is an error rather than a test that passes vacuously. */
function pinnedTypes() {
  if (PINNED_TYPES.length < MIN_TYPES) {
    return { bad: `the pinned catalogue holds ${PINNED_TYPES.length} entries, which cannot be the real catalogue` };
  }
  return { types: PINNED_TYPES, captured: PINNED_CAPTURED };
}

/* Resolves to { types } when readable, or { skipped: reason } on a transport failure. A
   reachable-but-implausible catalogue is an error, not a skip: it would let every membership
   test pass vacuously. Live only when asked: the publish gate runs this. */
async function fetchTypes(timeoutMs, live) {
  if (!live) return pinnedTypes();
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

  const live = process.argv.slice(2).includes('--upstream');
  const up = await fetchTypes(15000, live);
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
    process.stderr.write(`these event strings are not in the ${live ? 'live' : 'pinned'} NWS catalogue, so the board `
      + `would silently publish zero of them:\n  ${missing.join('\n  ')}\n`);
    process.exit(1);
  }
  // the capture date rides the sign-off line cycle-check.sh already logs, so a fixture nobody has
  // refreshed is visible without a check that could block a publish over it
  const provenance = live ? 'live' : `pinned ${up.captured}`;
  process.stdout.write(`${js.list.length} events mirrored, all present in ${up.types.length} ${provenance} types`);
}

module.exports = { jsSide, pySide, mirrorProblems, fetchTypes, pinnedTypes, PINNED_TYPES, PINNED_CAPTURED, MIN_TABLE, MIN_TYPES, HEAT_RE };

if (require.main === module) {
  main().catch((e) => { process.stderr.write(`hazard mirror: ${e.stack}\n`); process.exit(1); });
}
