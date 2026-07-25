# Tests

Zero-dependency unit tests for the board's honesty-critical pure logic, run with
Node's built-in test runner (`node:test` + `node:assert`, Node 18+). No npm
install, no jest/mocha/vitest — everything runs locally with just `node`.

## Run

```bash
node --test tests/          # whole suite
node --test tests/usng.test.js   # one file
```

The cron-side pipeline scripts are shell and python, so their suites run under
their own interpreter (each is self-contained, uses a throwaway temp dir, and
touches neither the network nor the real repo data):

```bash
bash tests/chat-poll.test.sh          # ops-chat durability
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

## Browser verification: point it at a local server, never the public mirror

Release verification that drives a headless browser across a viewport matrix must
load a **local** server, not respondertx.org:

```bash
python3 -m http.server 8791 --bind 127.0.0.1   # or: python3 server.py
# then drive http://127.0.0.1:8791/ with the headless browser
```

The board fetches NWPS, USGS, NWS and the tile providers **directly from the
client**, so every viewport in a matrix run is another full round of upstream
requests against the same APIs the data cycle depends on. Repeated matrix runs
against production are a plausible contributor to the NWPS `429` that took down
the 2026-07-24T23:53Z cycle. Verification must never be able to rate-limit the
live board. Verifying the deployed artifact is still fine over plain `curl` for
version stamps and markup, which costs the upstream APIs nothing.

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
