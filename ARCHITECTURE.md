# Architecture

ResponderTX is a **zero-backend single-page app**: vanilla JavaScript and Leaflet,
no framework and no build step. The browser fetches public data sources directly;
hosting is a static file server. This document maps the modules, the request flow,
the two hosting modes, and the generator pipeline.

<p align="center"><img src="assets/architecture.svg" alt="ResponderTX system architecture" width="960"></p>

## Client — the browser SPA

`index.html` loads a handful of focused, order-dependent scripts from `js/`. There
is no bundler; each file adds to a shared global `state` and `CONFIG` defined in
`core.js`.

| Module | Responsibility |
|--------|----------------|
| `core.js` | `APP_VERSION`, `CONFIG` (endpoints, poll interval, staleness thresholds, map center/bbox), global `state` |
| `i18n.js` | English / Spanish string tables and the `t()` translation helper |
| `usng.js` | WGS84 lat/lon &#8594; USNG/MGRS conversion (validated against the NGA `mgrs` library) |
| `map.js` | Leaflet map, themes, basemaps and panes, the unified radar timeline (observed &#8594; NOW &#8594; HRRR), rainfall (MRMS), cameras, low-water crossings, layer control |
| `sources.js` | Fetch + parse of NWS alerts, NWPS gauges/forecast, USGS, Local Storm Reports, and DriveTexas roads |
| `panels.js` | Sidebar rendering: forecast-to-flood list, gauges tab, alert list |
| `board.js` | Curated feed store (localStorage), smart sort, Nominatim search, JSON/GeoJSON/AAR/SITREP exports |
| `boot.js` | Cache save/hydrate, cold-start snapshot hydration, the init + poll loop; conditionally loads `chat.js` |
| `notes.js` | Field Notes flyout and map pins; merges `data/notes.json` with LAN posts |
| `chat.js` | **LAN-only** operator chat — loaded by `boot.js` only after `/api/ping` confirms the local host, and **stripped from the public deploy** |

Data flows one direction: fetch &#8594; normalize into `state` &#8594; render. Live
layers poll on `CONFIG.refreshMs` (~3 min). The last good payload is cached to
`localStorage`; basemap tiles can be pre-cached to `IndexedDB` for offline use. On a
cold start behind a rate-limit window, `boot.js` hydrates from the committed
`data/gauges-snapshot.json` so a fresh public visitor still sees gauges.

## Hosting — two modes, one repo

The same committed repository is served two ways.

### Operator (LAN) — `server.py`

A small Python **stdlib** `http.server` (no dependencies) that serves the static
app and `data/`, plus a few routes:

- `GET /api/ping` — capability beacon; the client loads chat/notes UI only if this answers.
- `GET /api/gauge/{lid}/{detail|series}` — NWPS hydrograph proxy with a 3-minute in-memory cache, so multi-viewer LANs do not hammer (and get rate-limited by) `api.water.noaa.gov`.
- `GET /api/cam/{district}/{icd}` — TxDOT ITS camera-snapshot proxy (2-minute cache) that returns the raw JPEG, so the viewer never needs CORS.
- `POST /api/chat`, `POST /api/notes` — append to `data/*.jsonl` (JSON-only content type, Origin/Host CSRF guard, size caps, coordinate validation).

Repo internals (`/.git`, `/.rdf`, `/.claude`) and operator inbox files are denied,
and `data/` + `api/` responses are `no-store`.

### Public mirror — Cloudflare Pages

A read-only copy on Cloudflare's CDN (<https://respondertx.org>). It serves the
same static app and committed `data/`, replicates the gauge and camera proxies as
**Pages Functions** (`functions/api/`), and publishes the follow feeds `/feed.xml`
and `/crests.ics`. It has **no write routes**; `chat.js` and the chat data are
stripped at deploy and the absence is verified.

## Generator pipeline — git history as the archive

Each cycle, the operator runs the generators in `scripts/`, which snapshot the live
sources and write committed artifacts. Because the snapshots are committed on a
regular cadence, the **git history of `data/` is the event archive** — historical
playback and the crest summary are reconstructed from it, not from a database.

| Script | Output | Purpose |
|--------|--------|---------|
| `gen-history.py` | `data/history.json` | Playback frames from the committed snapshot history, plus a USGS/NWPS pre-event backfill |
| `gen-crest-summary.py` | `data/crest-summary.json` | Per-gauge event peak stages for after-action / FEMA review |
| `gen-feeds.py` | `feed.xml`, `crests.ics` | Public RSS + crest calendar |
| `gen-cameras.py` | `data/cameras.json` | TxDOT + USGS HIVIS camera inventory (near-static) |
| `gen-roads-snapshot.py` | `data/roads-snapshot.json` | DriveTexas closure archive |

`scripts/cycle-check.sh` is the pre-commit sanity bundle (JSON validity, `node
--check` on `js/*.js`, and a four-way version agreement across `js/core.js`,
`index.html` cache-busting stamps, `data/changelog.json`, and `CHANGELOG.md`).
`scripts/deploy.sh` re-verifies that agreement, builds a stripped archive (removing
the LAN-only chat), confirms no chat references survive, and publishes to Cloudflare
Pages.

## Honesty & aging

The aging discipline is an architectural invariant, not a feature toggle — every
layer has a staleness threshold, auto-suppression, and a retrievable history view.
See the lifecycle diagram and rules in the README:

<p align="center"><img src="assets/data-lifecycle.svg" alt="The honesty and aging lifecycle" width="920"></p>

## Configuration

- `data/event.json` — per-event identity and geography (name, subtitle, map
  center/zoom, gauge bbox). Swap it to re-point the board; no code change.
- `CONFIG` in `js/core.js` — endpoints, poll interval, LSR window, staleness
  thresholds, playback window.

---

> Copyright (C) 2026 R-fx Networks &lt;proj@rfxn.com&gt; &#183; Ryan MacDonald &#183; Licensed under GNU GPL v2
