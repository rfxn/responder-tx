# Tests

Zero-dependency unit tests for the board's honesty-critical pure logic, run with
Node's built-in test runner (`node:test` + `node:assert`, Node 18+). No npm
install, no jest/mocha/vitest — everything runs locally with just `node`.

## Run

```bash
bash tests/run.sh           # every suite, log always captured, failing test names printed
bash tests/run.sh node      # node unit suite only (also: shell, py)
node --test tests/          # whole node suite
node --test tests/usng.test.js   # one file
```

`tests/run.sh` is the preferred entry point: it writes the whole log to a file, prints the
path, and on failure lists the failing test names. It also redirects every production lock
and log path into its own `mktemp -d` before running anything (see below).

The cron-side pipeline scripts are shell and python, so their suites run under
their own interpreter (each is self-contained, uses a throwaway temp dir, and
touches neither the network nor the real repo data):

```bash
bash tests/chat-poll.test.sh          # ops-chat durability
bash tests/chat-watchdog.test.sh      # stall watchdog: a killed recovery leaves no dirty tree
bash tests/deploy.test.sh             # release gate: deploy.sh reads and ships HEAD
bash tests/cycle-check.test.sh        # data cycle: cycle-check is immune to a mid-bump tree
bash tests/run-cycle.test.sh          # data cycle: one failing source still publishes the rest
bash tests/freshness-monitor.test.sh  # public-mirror freshness monitor
python3 tests/server-gate.test.py     # LAN server write gate
python3 tests/gen-notices.test.py     # LAN intake merge semantics
python3 tests/gen-shelters.test.py    # shelter-status honesty + the schema gate
python3 tests/gen-caltopo.test.py     # CalTopo GeoJSON export
python3 tests/gen-history.test.py     # playback archive: the retention invariant
python3 tests/gen-cameras.test.py     # camera inventory: the per-district collapse guard
python3 tests/gen-crossings-status.test.py  # crossing status: only non-open rows publish
```

CI runs the same commands (`.github/workflows/ci.yml`) plus `node --check` on
every `js/*.js` and the release-cycle sanity bundle (`scripts/cycle-check.sh`).

## Never touch a path production owns

The cron scripts single-flight on fixed `/tmp` locks and log to `/var/log`. Every
test that runs one must redirect **all** of them into its own `mktemp -d`:
`RESPONDER_CYCLE_LOCK`, `RESPONDER_CYCLE_LOG`, `RESPONDER_MONITOR_LOCK`,
`RESPONDER_MONITOR_STATE`, `RESPONDER_MONITOR_LOG`, `RESPONDER_CHAT_LOCK`,
`RESPONDER_CHAT_LOG`, `RESPONDER_CHAT_WATCHDOG_LOCK`,
`RESPONDER_CHAT_WATCHDOG_STATE`, `RESPONDER_CHAT_WATCHDOG_LOG`.

Taking `/tmp/responder-cycle.lock` makes the live 15-minute data cycle log
`SKIP: another cycle holds ...` and miss a publish. That happened on
2026-07-25T01:23Z, from a hand-held lock rather than a test, and it cost a real
refresh on a live flood board.

To prove skip-on-contention, hold the **scratch** lock on one of the test
shell's own file descriptors (`exec 8>"$WORK/cycle.lock"; flock -n 8`) and assert
on the log line. Never hold the lock from a detached background process: a
`nohup`/`setsid` child survives its parent and keeps the lock after the test is
gone. Every suite here traps `EXIT INT TERM` to reap its jobs and its temp dir.

## Always tee a test run; never pipe it away

```bash
node --test tests/ 2>&1 | tee /tmp/responder-test.log | tail -30   # correct
node --test tests/ 2>&1 | tail -30                                 # WRONG: evidence gone
```

A pipe-only run keeps the tail and throws away the failing test's name, its
assertion diff and everything above it. On 2026-07-25 two failures were lost
that way and could not be reproduced, which cost a second full run and left the
flake undiagnosed. On **any** failure, flake included, keep the full log and
report the failing test name from it.

`bash tests/run.sh` enforces this: it tees every suite into one log, prints the
path, and lists the failing test names on exit. Prefer it over a hand-rolled
pipeline.

## Browser verification: serve locally AND block the upstream hosts

Serving the page locally is necessary but **not sufficient**. The instruction
"point it at 127.0.0.1 so production is not rate-limited" was wrong on its own,
and following it still degraded a real data cycle: a viewport matrix at
2026-07-25T02:38Z contributed to an NWPS `429` while the page was correctly
served from `127.0.0.1`.

The reason is that the origin serving the HTML has nothing to do with where the
board's data comes from. `js/sources.js`, `js/map.js`, `js/cameras.js` and
`js/playback.js` call NWPS, USGS, NWS and IEM **from the browser**, so the
requests leave the machine no matter who served the page. CORS blocks *reading*
a cross-origin response, it never blocks *sending* the request, and the upstream
rate limiter counts the request either way. A five-viewport matrix is five more
full rounds against the same APIs the 15-minute cycle depends on.

So a browser verification run must do both: serve locally, and abort the
upstream requests **at the network layer** inside the driver.

```bash
python3 -m http.server 8791 --bind 127.0.0.1   # or: python3 server.py
```

```js
// Playwright: abort before the request is issued
for (const h of BLOCK) await page.route(`**://${h}/**`, (r) => r.abort());
```

```js
// CDP (puppeteer / raw DevTools protocol): one call, no per-request handler
await cdp.send('Network.setBlockedURLs', { urls: BLOCK.map((h) => `*://${h}/*`) });
```

The hosts the client contacts, derived from source rather than guessed. Group A
is the set whose rate limits the production data cycle actually depends on, so
blocking it is mandatory; group B is tiles, imagery, media and geocoding, which
cost bandwidth and time but not a cycle.

**Group A, always block:**

```
*://api.water.noaa.gov/*              NWPS gauge inventory, status and hydrographs
*://maps.water.noaa.gov/*             NWPS RFC max forecast + NWM inundation raster
*://api.weather.gov/*                 NWS active alerts + per-zone polygons
*://waterservices.usgs.gov/*          USGS NWIS instantaneous values
*://mesonet.agron.iastate.edu/*       IEM: LSRs, MRMS, HRRR, NEXRAD, playback archive tiles, SBW polys
*://services5.arcgis.com/*            TxDOT/TDEM DriveTexas road conditions
*://services9.arcgis.com/*            NOAA/NHC active tropical cyclones
*://feature.geographic.texas.gov/*    TxGIO low-water-crossing inventory
*://api.tidesandcurrents.noaa.gov/*   NOAA CO-OPS water levels and predictions
*://api.rainviewer.com/*              RainViewer radar frame index
*://usgs-nims-images.s3.amazonaws.com/*   USGS HIVIS river-cam listing and stills
```

**Group B, block too unless the run is specifically about them:**

```
*://tile.openstreetmap.org/*          OSM streets basemap
*://*.basemaps.cartocdn.com/*         CARTO dark/light basemap and labels
*://tiles.arcgis.com/*                NOAA/NHC SLOSH surge raster
*://*.rainviewer.com/*                RainViewer radar tiles (host arrives at runtime)
*://*.skyvdn.com/*                    TxDOT Lonestar HLS camera streams
*://zoocams.elpasozoo.org/*           El Paso bridge HLS streams
*://nominatim.openstreetmap.org/*     geocoding for map search and intake pins
*://overpass-api.de/*                 nearest hospital lookup in the team panel
```

No fixture is required for the board to render with all of these blocked. Every
first-load surface reads same-origin `data/*.json` and `history/`: the gauge
board, the threat strip, roads, shelters, crest summary and playback all hydrate
from committed snapshots before any upstream call is attempted. What the blocks
cost is the live refresh overlay, so expect the header to show a degraded feed
chip and the basemap to be blank grey. Both are correct under this setup and
neither hides the layout, the controls or the honesty strings being verified.
Verify tiles or a live upstream by unblocking that single host for one run.

Verifying the deployed artifact over plain `curl` (version stamps, headers,
markup, `history/index.json`) stays fine: it costs the upstream APIs nothing.

## How it works

The app ships `js/*.js` as classic browser `<script>` files that share one global
scope, not modules. `harness.js` reads those files **verbatim** (never edits
them), concatenates the ones under test, and evaluates the combined source once
in a Node `vm` sandbox stocked with minimal mock browser globals (`document`,
`localStorage`, a Leaflet `L` stub, etc.).

Five loaders, in increasing order of how much of the app they start:

| loader | what it gives you |
|---|---|
| `loadApp()` | core + usng + playback + sources + cameras + **panels** + board |
| `loadMapApp()` | the same, with **map.js** in place of panels.js |
| `loadFullApp()` | every file in `index.html` order, **boot.js included**: the only bundle with map.js and panels.js together, so `relocalizeDynamic()` and the rest of boot.js's cross-file callers can be run |
| `loadWiredMap()` | a private bundle with `initMap()` actually **run**: `fire('overlayadd', { layer: layers.wildfire })` executes the shipped handler, `spyOn('fetchX')` records the call |
| `loadHeaderStatus()` | core..board plus **boot.js**, against a DOM that records `classList` and attribute writes |

`._sandbox` exposes every top-level `function` **declaration** on the sandbox
global, so `loadApp()._sandbox.renderRoadsTab()` calls the shipped function with
no harness change. A top-level `const NAME = () =>` is lexical and is NOT on the
sandbox: it has to be named in `EXPORTS` / `PANEL_EXPORTS` / `MAP_EXPORTS` /
`BOOT_EXPORTS`.

Gotchas that have each cost a release:

- The harness `t()` **echoes the key back**, so `t('x').replace('{n}', v)`
  substitutes nothing. Override `sandbox.t` when asserting on interpolated
  output, and restore it in a `finally`.
- The module-level `L` is a Proxy that returns **itself**, so every drawn layer
  compares equal to every other one. To assert draw order, kind or options, swap
  in a recording `L` (see `drawWith()` in `wildfire.test.js`).
  `loadWiredMap()` already hands out distinct layer objects.
- A recording DOM must **not** answer `querySelector` with a live stub
  unconditionally. That exact mistake let a missing star element pass in
  v0.99.83. Register the selectors you deliberately provide and return `null`
  for the rest, so a node the shipped code starts needing fails loudly.
- `loadApp()` / `loadMapApp()` / `loadFullApp()` are **cached** and shared by every
  test in a file. Restore anything you mutate in a `finally`. `loadWiredMap()` is
  per call.
- Listeners the files register on `document` at load time are kept in
  `_sandbox.__docHandlers` (a `type -> [fn]` Map), so the modal focus trap in
  `core.js` can be fired with a synthetic event instead of matched. Handlers
  registered inside `boot()` are NOT there: nothing invokes `boot()` from node.
- Arrays built inside the sandbox come from a different realm, so
  `assert.deepEqual` fails on the prototype. Re-home them with `Array.from`.

## The source-text budget

`source-text-budget.test.js` holds two committed numbers and fails if either
grows. `source-text-scan.js` computes them, and prints both when run directly:

```
node tests/source-text-scan.js
```

A **source-text assertion** is an `assert.*(...)` whose FIRST argument (the
subject under assertion) is project-file text rather than a value the app
produced. Concretely, the subject either contains a call to a file-reading
helper (any `const`/`function` in the test file that wraps `readFileSync`), or
names a binding whose initializer does, transitively. `assert.match(src, /../)`
and the extract-a-body-then-regex variant
(`const fn = src.slice(src.indexOf('function f'), ...)`) both count. Deliberately
NOT counted: a subject wrapped in `JSON.parse(...)` (a parsed artifact is data,
not source text), a function-valued binding (its parameters shadow, and callers
assert on its RESULT), and an object-literal key that happens to be spelled like
a source variable.

An **unexecuted test** is a `test()` block with at least one assertion in which
EVERY assertion is source-text. Those would still pass if the feature under test
were deleted. A test that regexes source AND also runs the code is not counted:
mixing the two is not the failure mode.

Both numbers may only go **down**. Lowering one is a normal part of converting a
suite, and the test prints the number to lower it to. Raising one is a decision
someone has to make in a diff, on purpose.

Known limits, so nobody reads the number as exact: the contents of template
literals are masked before analysis, so text that arrives through an
interpolation (`out.push(\`${src.slice(a, b)}\`)`) is not tracked; scope is
approximated by nearest preceding declaration, so one name reused for two
different files resolves by position rather than by block; and reads of `css/`,
`index.html`, `scripts/*.py` and shipped JSON are counted but have no executing
alternative in the node suite, which is why the scan prints the executable-`js/`
subset separately. It is a budget, not a proof.

Why it exists: v0.99.79 shipped the wildfire layer completely dead behind six
green tests, every one of them `assert.match(source_text, /.../)`. A string
existing in a file proves nothing about whether the code runs, and it also breaks
spuriously, one of those six broke in the next release when a COMMENT was edited.
See the CLAUDE.md section "A source-text assertion is a lint, not a test".

## Coverage

Focused on the guarantees the board makes, not a coverage number:

- **`usng.js` — `toUSNG`**: WGS84 -> USNG/MGRS, checked against ground truth from
  the python `mgrs` library (the app's stated ±1 m reference) across the TX bbox
  plus hemisphere / zone / band edges.
- **`sources.js` — `alertReach` / `alertSeverity`**: parsing the specific river
  reach out of NWS prose and the emergency/warning/watch/advisory classification.
- **`sources.js` — `gaugeObsStale` / `gaugeCat`**: the stale-sensor gate — a
  frozen gauge stuck at MAJOR (or with a missing/old observation) must drop to
  `none` so it never inflates flood counts.
- **`core.js` — `esc` / `fmtNum` / `safeUrl` / `distMi` / `freshClass`**: HTML
  escaping of injection payloads, numeric coercion, http(s)-only URL gating,
  haversine distance, and freshness bucketing.
- **`board.js` — `smartScore` / `shortId`**: priority-weighted half-life feed
  ranking and the stable radio-speakable `R-###` id derivation.

Render paths, popup builders and map event wiring ARE exercised, through
`loadWiredMap()` and a recording `L`: `buildShareUrl`, the layer sheet, the
overlay lazy-loads, the saved-view restore, the offline tile save, the
rising-gauge focus and the wildfire/gauge marker rendering all run for real.

`sw.test.js` keeps the listeners `sw.js` registers rather than counting them, so
its `fire(s, 'activate' | 'fetch' | 'push' | 'message' | 'pushsubscriptionchange')`
runs the shipped handler and settles whatever it passed to `waitUntil` /
`respondWith`. The cache routing, the archive warm, the push fallback and the
rotation self-heal are all asserted on outcomes.

Still out of reach from node: anything registered inside `js/boot.js`'s
`DOMContentLoaded` init (the update chip, the hazard-line delegate), `js/team.js`,
`js/notes.js`, `js/chat.js`, and anything whose answer depends on real layout.
Regenerate the USNG ground truth with
`python3 -c "import mgrs; print(mgrs.MGRS().toMGRS(LAT, LON))"`.
