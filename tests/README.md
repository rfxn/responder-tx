# Tests

Zero-dependency unit tests for the board's honesty-critical pure logic, run with
Node's built-in test runner (`node:test` + `node:assert`, Node 18+). No npm
install, no jest/mocha/vitest — everything runs locally with just `node`.

## Run

```bash
node --test tests/          # whole suite
node --test tests/usng.test.js   # one file
```

CI runs the same command (`.github/workflows/ci.yml`) plus `node --check` on
every `js/*.js` and the release-cycle sanity bundle (`scripts/cycle-check.sh`).

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
