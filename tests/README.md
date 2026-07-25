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
scope — not modules. `harness.js` reads those files **verbatim** (never edits
them), concatenates the ones under test, and evaluates the combined source once
in a Node `vm` sandbox stocked with minimal mock browser globals (`document`,
`localStorage`, a Leaflet `L` stub, etc.). Only the pure functions are exercised;
nothing that needs a live DOM or Leaflet map is called.

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

Deliberately **not** unit-tested here (need a full Leaflet map / live DOM, would
require brittle over-stubbing): `buildShareUrl` / `applyShareParams`, alert/gauge
rendering, and anything touching `state.map`. Regenerate the USNG ground truth
with `python3 -c "import mgrs; print(mgrs.MGRS().toMGRS(LAT, LON))"`.
