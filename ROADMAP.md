# ResponderTX — MASTER ROADMAP (updated 2026-07-19)

Current build: **v0.96.5** (see `CHANGELOG.md` for the full v0.1.0 → v0.96.5 arc,
which is the authoritative record of what has shipped). This roadmap tracks
delivered capabilities and the forward queue; per-cycle volatile status lives in
CHANGELOG/HANDOFF, not here.

---

## Delivered / status summary (read this first)

ResponderTX is a **production-grade, single-event flood operating picture** that
is now feature-complete against its own original backlog: the entire NOW block,
all of the W1–W9 next-wave, most table-stakes (T1/T2/T4/T6/T8), the self-audit
quick-wins (A1/A2/A4/A5/A6/A7), and the **historical-playback flagship** have all
shipped. What remains is less about missing situational-awareness features and
more about **coverage, delivery, reliability, and generalization** (see the
forward queue).

**Delivered capability clusters** (lead version in parentheses):

- **Alerts** — live NWS flood alerts with flash-flood-emergency detection,
  AO-vs-elsewhere fold (A1, v0.69.0), on-map polygons, new-emergency banner,
  7-day expired-alert history, in-app alert-text reader with the named river
  reach (v0.96.3).
- **Gauges & forecast** — NWPS bbox gauges with flood categories and
  rising/falling trend, stale-sensor suppression (v0.75.4), 48h sparkline + full
  hydrograph modal with the crest-of-record line (W6, v0.62.0), RFC 5-day
  forecast-max rings (v0.34.0), USGS raw-stage auto-fallback (#11, v0.34.0/0.38.0),
  Record-Watch crest-of-record context (W2, v0.57.0), and the down-basin
  crest-wave tracker (W1, v0.58.0).
- **Radar & rainfall timeline** — one unified scrubber that runs observed radar →
  NOW → amber HRRR model future (+1h→+18h) in a single bar (v0.96.0), plus the
  standalone HRRR future-cast layer (v0.95.0) and a unified MRMS rainfall overlay
  with 1/24/48/72h windows (v0.90.0). Closes the long-open "future-cast source
  hunt."
- **Roads & crossings** — live TDEM DriveTexas closures/high-water (v0.76.0),
  recently-reopened-roads recovery signal (v0.79.0), TxGIO low-water-crossing
  location inventory (~3.7k) plus the curator-maintained crossing tracker
  (W4/#13, v0.60.0).
- **Cameras** — road & river cameras with live HLS + snapshot + stale badging,
  auto-linked into nearby gauge popups (T6, v0.83.0; TxDOT ITS snapshot cams
  v0.88.x).
- **Flood inundation** — NWM model inundation-extent overlay, labelled a MODELED
  estimate, off by default (T1, v0.73.0).
- **Field/first-responder UX** — Drive Mode big-type nearest-hazards glance
  (V1/W5, v0.61.0), long-press point inspector (v0.85.0), plain-language
  headline, threat-to-life strip, actionable ticker, radio-speakable R-### short
  IDs (#14, v0.53.0), USNG grids, "Am I at risk?" address lookup (T2, v0.74.0;
  flag-gated `?risk=1` since v0.75.0).
- **History & AAR** — multi-layer historical playback: 3/7/14-day scrub over
  gauges + NWS warning archive + roads + radar + rainfall with crest chapters and
  a story caption track (T8/V5, v0.82.0 → v0.96.0), plus the event crest-summary
  AAR view (v0.80.0).
- **Sharing & interop** — one-tap Share View with full view-state in the URL,
  per-item deep links (W7, v0.48.0 + `?hydro=`/`?fq=`/`?cam=`/`?pbt=`), OG unfurl
  cards (W3, v0.59.0), public RSS + ICS crest calendar (W8, v0.63.0), and
  SITREP/AAR/JSON/GeoJSON exports (→ CalTopo/SARTopo).
- **Platform** — EN/ES localization + a11y pass (T4, v0.75.0), first-run
  onboarding + glossary + unified search (A5, v0.86.0), grouped layer sheet
  (v0.89.0), graceful in-tab update rollover (v0.87.0), IndexedDB offline
  **basemap tiles** (W9/#16, v0.64.0), OFFICIAL-vs-CURATED provenance badges
  (A4, v0.81.0), and a security/quality hardening pass (v0.75.5, v0.77.0).
- **Architecture** — the js/app.js monolith was split into ordered modules
  (core/map/sources/panels/board/boot + chat/notes/i18n, v0.78.0); a per-cycle
  Python generator pipeline (roads/crest/history/feeds/cameras + snapshot) backs
  the feeds; deploy via `scripts/deploy.sh` (A7). Public read-only mirror at
  respondertx.org (v0.31.0) with all LAN-only surfaces (ops chat, field-notes
  intake) stripped from the artifact.

**Genuinely still open** (detail in the forward queue): notification delivery
(web-push, gated on a service worker) · a durable scheduled data pipeline
independent of the curator session · automated tests + CI · region/all-hazard
generalization (region-agnostic config) · a service-worker + safe-reinstall path
· T5 evacuation zones (data-gated) · V2 basin-focus and V3 recovery dedicated
views · live FEMA-shelter poller (#12) · the divergence indicator · small polish
(A3 desktop KPI declutter, A8 LSR ranking, #18 measure tool, #19 watchlist star).

---

## (a) Product thesis

- **Who:** a first responder / SAR lead working an active flood from a truck —
  gloved, glare-lit, intermittently connected — plus anyone watching the public
  mirror.
- **What:** a zero-backend live operating picture that fuses authoritative
  hazard layers with a curator-maintained **alert feed** — nothing on the board
  asks the responder to manage state; alerts age out or are resolved by the
  curator via data updates, and everything suppressed stays retrievable history.
- **Why:** in flash floods the decision is "where do I go and what do I expect"
  in under 10 seconds; the board's job is anticipation (forecast-first),
  recency (aging everywhere), and honesty (stale data never masquerades as live).

---

## Standing invariants (definition-of-done for every item below)

1. **Aging everywhere:** every new layer/feature ships with a default timeout,
   auto-suppression off map/panes, and a retrievable persisted history view. No
   exceptions — shelters, crossings, HWMs, notes, chips, all of it.
   Suppress ≠ delete.
2. **Reframe vocabulary (DELIVERED v0.33.0 + grep-clean sweep v0.36.0):** no
   "request", no manual acknowledge/status anywhere. Items are alerts; lifecycle
   is active → aging → resolved(history), driven by the curator or the clock.
3. **Public mirror hygiene:** zero chat vestige on respondertx.org — no FAB,
   no panel, no chat.js, no outbox fetch. The deploy-time strip is real
   (`scripts/deploy.sh`) and each cycle greps the deployed archive to verify.
4. Existing invariants hold: 911 disclaimer, source citations (official-vs-
   curated provenance), wall-clock timestamps, PII rules (risk lookup on-device
   only), USNG accuracy, copyText fallback, model/forecast never reads as
   observed (amber HRRR ≠ radar), screenshot check at 1600px + 500px.

---

## (b) Delivered inventory — original tracks, marked

Item identifiers (T#, W#, A#, V#, N#, #11–#30) are preserved for cross-reference
with prior planning. Status is DELIVERED (with lead version) / IN PROGRESS /
OPEN / DROPPED — cross-referenced against CHANGELOG.

### NOW block — all DELIVERED

1. **Reframe completion sweep — "Feed", alerts-not-requests** — DELIVERED
   (v0.33.0 reframe; v0.36.0 vocabulary sweep completed, repo grep clean).
2. **Public-mirror chat strip (deploy-time)** — DELIVERED (v0.32.0 chat gated
   LAN-only; deploy strips chat.js + chat data; A7 `deploy.sh` scripts it).
3. **Module split of js/app.js** — DELIVERED (v0.78.0: six ordered scripts —
   core/map/sources/panels/board/boot; line-for-line, no behavior change).
4. **UX-audit remainder** — DELIVERED (#10 GPS-wait chip v0.51.0; #11 light-theme
   sunlight contrast v0.52.0; #14 threat-strip chip cap obsoleted by the v0.44
   rework).
5. **#9 Dead-tap alert cards** — DELIVERED (geometry → zoneGeomCache →
   full-alert-text fallback; never a dead tap; v0.36.0).
6. **RFC forecast-max layer** — DELIVERED (v0.34.0 forecast-crest rings).
7. **Leaflet.markercluster (vendored)** — DELIVERED (v0.34.0, used by USGS layer).
8. **Saved AO quick-jump presets** — DELIVERED (v0.43.0 AO chips; collapsed to a
   single context chip v0.94.0).
9. **#15 MRMS legend color-scale strip** — DELIVERED (v0.50.0 ramp + light→extreme
   labels; folded into the unified Rainfall legend v0.90.0).
10. **#17 Editable lat/lon + scroll-map-into-view on form open** — DELIVERED
    (v0.49.0).

### Table-stakes (T1–T8)

- **T1. Street-level flood inundation (NWPS/NWM)** — DELIVERED (v0.73.0, NWM
  AnA inundation-extent overlay, labelled MODELED, off by default).
- **T2. "Am I at risk?" address lookup + saved my-places** — DELIVERED (v0.74.0;
  flag-gated behind `?risk=1` v0.75.0 as a first-responder tool, kept intact).
- **T3. Web-push threshold alerts** — OPEN. The one universal table stake still
  missing; gated on a service worker (see forward queue / GA themes). Store
  endpoint+threshold only, no identity; never a WEA/911 replacement.
- **T4. Spanish localization (+ a11y pass)** — DELIVERED (v0.75.0 EN/ES toggle,
  `?lang=es`, standard NWS/FEMA Spanish register; live data stays EN).
- **T5. Evacuation zones w/ status + "safe to return"** — OPEN, data-gated.
  Mirror authoritative zone status where available; never invent an order.
- **T6. Live river/road/traffic cameras** — DELIVERED (v0.83.0 TxDOT/USGS cams +
  v0.88.x ITS snapshot cams; stale badging; auto-linked into gauge popups).
- **T7. Crowdsourced field reports → curator moderation queue** — OPEN
  (deliberately deferred write surface). LAN-only Field Notes groundwork shipped
  (v0.45.0) and is parked behind `?notes=1`; no public write path.
- **T8. Day-by-day incident replay for AAR** — DELIVERED (historical playback
  flagship, v0.82.0 → v0.96.0; crest-summary AAR view v0.80.0).

### Self-audit quick-wins (A1–A8)

- **A1. AO-filter the Alerts tab** — DELIVERED (v0.69.0).
- **A2. Make Drive Mode discoverable** — DELIVERED (v0.69.0 teal accent +
  one-time hint).
- **A3. Declutter desktop KPI tiles** — OPEN (minor). Phones already hide the
  tiles (v0.29.0) and desktop tiles are actionable (v0.43.0), but the desktop
  fold-into-threat-module has not landed.
- **A4. Tag authoritative vs curated** — DELIVERED (v0.81.0 OFFICIAL/CURATED
  provenance badges via a shared `srcBadge()` helper).
- **A5. Public onboarding + richer legend** — DELIVERED (v0.86.0 first-run
  onboarding + "?" glossary).
- **A6. Collapse desktop map legend to a pill** — DELIVERED (v0.71.0).
- **A7. deploy.sh** — DELIVERED (`scripts/deploy.sh`: strip chat.js, empty
  outbox, grep the archive, version-agreement preflight, live smoke).
- **A8. Bury LSRs less** — OPEN (minor). Storm reports are collapsed to a top-N
  expander (v0.29.0); an explicit freshness-first ranking bump has not shipped.

### Next-wave (W1–W9) — all DELIVERED

- **W1. Down-basin crest-wave tracker** — DELIVERED (v0.58.0).
- **W2. Record-Watch (crest-of-record context)** — DELIVERED (v0.57.0).
- **W3. OG share-card unfurl** — DELIVERED (v0.59.0, evergreen card).
- **W4. Low-water crossing inventory + layer** — DELIVERED (v0.60.0 curated
  tracker; v0.76.0 TxGIO inventory).
- **W5. Drive Mode (`?view=drive`)** — DELIVERED (v0.61.0; routed in boot.js).
- **W6. Full-screen hydrograph** — DELIVERED (v0.62.0, `?hydro=` deep link).
- **W7. Per-item share** — DELIVERED (v0.48.0 Share View + Web Share; per-item
  `?hydro=`/`?fq=`/`?cam=`/`?note=`/`?pbt=` deep links across releases; map↔list
  sync v0.92.0).
- **W8. Public RSS/Atom + ICS crest calendar** — DELIVERED (v0.63.0,
  `scripts/gen-feeds.py`).
- **W9. Offline AO tile pre-cache** — DELIVERED (v0.64.0, custom cache-first
  IndexedDB tile layer — chosen over vendoring leaflet.offline).

### Community/social track (N1–N5) — OPEN (parked write surfaces)

Field Notes shipped v0.45.0 then was parked behind `?notes=1` (v0.54.0); the
public notes-curation flow (N1), corroboration tally (N2), per-note share cards
(N3), filter chips (N4), and photo attachment (N5) remain OPEN. Crowdsourced
write surfaces are deliberately deferred until a new owner ask (see Anti-backlog).

### NEXT items (#11–#20)

- **#11. USGS IV gauge fallback layer** — DELIVERED (v0.34.0 layer + v0.38.0
  auto-fallback on NWPS staleness).
- **#12. FEMA NSS open-shelters poller** — OPEN. No `data/shelters-live.json`
  yet; shelters are curated in resources.json. Live shelter status is a top
  recovery-phase question — a real degrade-tolerant poller is still wanted.
- **#13. Low-water crossing inventory** — DELIVERED (v0.60.0 / v0.76.0; same as
  W4).
- **#14. Speakable short IDs (R-###)** — DELIVERED (v0.53.0).
- **#15. Inundation 5-day-max polygons** — DROPPED/superseded. The NWM AnA
  inundation-extent aggregate (T1, v0.73.0) was the right single-overlay fit; the
  separate forecast-max polygon layer was not pursued.
- **#16. Offline tile pre-cache** — DELIVERED (v0.64.0; custom implementation,
  same as W9).
- **#17. Radar/rain time scrubber** — DELIVERED (v0.35.0 radar scrub → v0.82.0
  playback → v0.90/0.93 rainfall replay → v0.96.0 unified timeline).
- **#18. Leaflet.PolylineMeasure (vendored)** — OPEN (minor). Distance/bearing to
  hazards already exists in Drive Mode and the point inspector; a dedicated
  measure tool is not vendored.
- **#19. Watchlist star (per-item follow)** — OPEN (minor). Smart sort + "In
  view" filter (v0.92.0) exist; an explicit pin-to-top star does not.
- **#20. Verified live-resource adds** — DELIVERED / ongoing (resources.json:
  CrowdSource Rescue, iSTAT, SARiverFlood HALT, scam-watch, recovery portals;
  curated each cycle).

### LATER (#21–#30)

- **#21. CoCoRaHS daily precip reports** — OPEN, [data].
- **#22. OpenFEMA declarations chip** — OPEN, [data]; pairs with the V3 Recovery
  view.
- **#23. USGS STN HWM hook** — OPEN, gated (needs a live STN event).
- **#24. usng.js swap-in** — OPEN, deferred (our converter is validated ±1 m;
  only if datum edge cases surface).
- **#25. Multi-event config presets** — IN PROGRESS / partial. `data/event.json`
  externalizes name/subtitle/center/zoom/bbox (v0.20.0), but full region-agnostic
  parameterization (AO presets, the TX-specific gauge/alert/LSR filters,
  timezone, event literals) is the core GA generalization work still to do (see
  forward queue).
- **#26. HTTPS service worker / full offline PWA** — OPEN (GA-critical). Public
  HTTPS is live (v0.31.0) and basemap tiles cache offline (v0.64.0), but there is
  no service worker or app-shell cache; the installable manifest was intentionally
  removed (v0.96.1) pending a service worker with a real update strategy.
- **#27. Shared multi-operator state** — OPEN, deferred (public mirror + single-
  curator model lowered urgency).
- **#28. X filtered-stream ingest worker → triage queue** — OPEN, gated (paid
  API; never auto-publish).
- **#29. Partnership-gated feeds** — partial. DriveTexas road closures landed via
  a keyless source (v0.76.0); PulsePoint, Broadcastify official API, LCRA
  Hydromet, and what3words remain OPEN/gated.
- **#30. leaflet-sidebar-v2 / fullscreen (with EOC wall V4)** — OPEN.

### Views (V1–V5)

- **V1. Drive Mode (glance view)** — DELIVERED (v0.61.0 + discoverability v0.69.0
  + road data v0.76.3 + cameras v0.83.0).
- **V2. Basin Focus (`?view=basin`)** — OPEN. The crest-wave tracker (W1) delivers
  part of "when does the wave reach me"; a dedicated upstream→downstream corridor
  lens is not built.
- **V3. Recovery Dashboard (`?view=recovery`)** — OPEN. Recovery posture is
  surfaced in pieces (reopened-roads v0.79.0, quiet-state all-clear v0.79.0,
  recovery SITREP line v0.23.0, falling-gauges chip v0.15.0); the dedicated lens
  is not built.
- **V4. EOC Wall (`?view=wall`)** — OPEN. Print stylesheet groundwork exists
  (v0.15.0); the auto-rotating wall is not built.
- **V5. Timeline / Replay (`?view=timeline`)** — DELIVERED (shipped as the
  historical-playback timeline flagship, v0.82.0 → v0.96.0 — the AAR/review tool).

### Dropped / obsoleted by the reframe

- Post-research alert-fatigue ack tiering — "ack-required" contradicts
  no-manual-acknowledge; only the auto-unmute-on-escalation idea survives as a
  curator-side rule.
- Status pin colors, archive-resolved button, guarded status changes — the
  status surface is gone; freshness/severity carry the pin encoding, and
  auto-suppression of curator-resolved items replaces the manual archive.
- Dead data ends stay dead (don't re-probe): Waze georss, poweroutage.us, GBRA
  Contrail, TWDB hub, FLASH, TDEM API, HCRS_CC (frozen since 2020).

---

## (c) Forward queue — ranked NOW / NEXT / LATER

The board is a mature single-event instrument. The forward work is the path from
*instrument* to a **general-availability product**: trustworthy, generalized, and
reliably updatable. Ranked top-down within each horizon.

### NOW (highest-value open work)

1. **Reliability + honest failure [infra]** — replace the session-coupled
   per-cycle crons with a durable scheduled data pipeline (snapshot/history/feeds)
   that runs independent of an interactive curator session, plus a visible
   "source degraded / last updated" status and multi-source failover for the
   single-host feeds behind several layers. The board's honesty story depends on
   the data staying fresh without a human in the loop.
2. **Tests + CI [infra]** — the biggest single gap: there is no automated test
   coverage or CI. Unit-test the honesty-critical pure logic (USNG conversion,
   stale-sensor/category predicates, record context, smart-sort scoring, short-ID
   hashing, share-URL round-trip) and add a headless harness for the playback
   state machine; run the existing `cycle-check.sh` + tests on every change.
3. **Service worker with a real update strategy [infra]** — cache-versioned to
   the existing `?v=` stamp scheme, controlled reload, and app-shell caching (so
   a cold offline boot works, not just basemap tiles). This is the explicit
   precondition (v0.96.1) for safely re-adding installability, and the enabler
   for web-push (T3).

### NEXT (today/tomorrow horizon)

4. **Generalization / region-agnostic config (#25) [infra]** — parameterize the
   remaining single-event hardcoding beyond event.json (AO presets, the
   TX-specific gauge/alert/LSR query filters, timezone, event literals) into
   config-driven event packs, and prove the board on at least one region beyond
   the Hill Country. This is the core enabler for general availability and for
   the owner's stated all-hazard direction (floods now; storms/tornadoes later) —
   the machinery is largely hazard-agnostic. (Brand/identity for that direction
   is an owner decision and is out of scope here.)
5. **Re-add installability (PWA) — after the service worker exists** — safe once
   the SW owns updates; do NOT re-add a manifest before then (that repeats exactly
   what v0.96.1 rejected).
6. **Web-push threshold alerts (T3) [infra]** — VAPID + edge KV/cron storing
   endpoint+threshold only (no identity), framed as "not a WEA/911 replacement."
   Notification delivery is the one universal table stake the board lacks; lands
   as a fast-follow the moment the service worker exists.
7. **FEMA NSS open-shelters poller (#12) [data]** — durable server-side poll →
   `data/shelters-live.json`, merged over curated shelters, absence-tolerant.
8. **Divergence indicator [views]** — a careful forecast-vs-observed divergence
   cue on gauges (owner-gated design decision), extending the honesty story.
9. **V3 Recovery Dashboard (`?view=recovery`) [views]** — consolidate the
   recovery signals (falling gauges, reopened roads, shelter/boil-water/utility
   cards, declarations chip #22) into one lens; the event enters this phase and
   recovery posture currently hides inside SITREP lines.
10. **V2 Basin Focus (`?view=basin`) [views]** — single-river corridor,
    upstream→downstream, with the crest wave visualized as it moves down-basin.
11. **CalTopo / SARTopo interop — "Send to CalTopo" (MVP) + live sync (stretch)
    [interop]** — extend the GeoJSON export into a full curated, multi-layer
    CalTopo-shaped FeatureCollection: every enriched layer (gauges with AHPS
    flood-category colors, forecast-crest rings, alert polygons, road closures,
    low-water crossings, curated notices, LSRs) as CalTopo folders with `title`
    labels, per-feature citations + `updated_at`, simplestyle-matched to our
    palettes. Publish it at a stable URL refreshed by the cycle as an
    always-current, bookmarkable export, plus a client-side QR of a CalTopo share
    link — no paid tier to produce. **Stretch (account-gated):** true continuous
    sync via the CalTopo Teams API push, or a WFS/FeatureServer shim — honest
    caveat: CalTopo does NOT poll a static GeoJSON URL as a live layer, so real
    sync needs a CalTopo subscription and a small always-on job. Detailed
    mechanism / fidelity / licensing analysis is kept in an internal assessment.
12. **Live team location sharing (Garmin-style breadcrumbs) [infra/field] —
    owner-requested, sanctioned backend departure** — create a public or private
    team, share a link + QR; the link on load asks for an ephemeral handle (no
    login, low barrier), requests Geolocation permission on explicit opt-in, then
    streams each member's position and a capped breadcrumb trail onto the map as
    distinct labeled markers with "last seen" aging. Field use needs a real relay
    (cellular devices can't peer, and geolocation requires a secure context): the
    recommended path is a light Cloudflare relay — a per-team Durable Object with
    short-poll updates — layered onto our existing Pages Functions, private by
    default, flag-gated on the HTTPS mirror. This is a deliberate, owner-sanctioned
    departure from the zero-backend / no-account / no-PII posture — the first
    first-party write surface and first server-held user location — so it is
    bounded by opt-in only, ephemeral handles, auto-expiry / TTL, one-tap
    stop-sharing, private-by-default, and is never committed to the git archive.
    MVP = handle + colored breadcrumb markers over the relay; a later login binds
    to the ephemeral-handle layer without rearchitecture. Full architecture +
    privacy analysis in the internal assessment.

### LATER (post-event or gated)

13. **All-hazard layers (post-1.0)** — severe/tornado warnings are cheap (the
    machinery is hazard-agnostic); wildfire needs perimeter data. Follows
    generalization.
14. **T5 evacuation zones** — data-gated; mirror authoritative status, never
    invent an order.
15. **Trust/governance content** — about/who-runs-this, a methodology & accuracy
    page (surfacing the honesty discipline that is already a strength), a
    privacy/terms page, and a LICENSE file.
16. **Security hardening (defense-in-depth)** — add a content-security backstop
    over the feed-text render surface and unify the duplicated proxy validators.
17. **V4 EOC Wall (`?view=wall`)** — auto-rotating full-screen panels with the
    print-stylesheet tokens; pairs with the fullscreen plugin (#30).
18. **#22 OpenFEMA declarations chip · #21 CoCoRaHS precip · #23 USGS STN HWM
    hook** — [data], mostly recovery/AAR, event-gated.
19. **Minor polish** — A3 desktop KPI declutter, A8 LSR freshness ranking, #18
    measure tool, #19 watchlist star.
20. **#27 shared multi-operator state · #28 X ingest worker · #29 remaining
    partnership feeds (PulsePoint, Broadcastify, LCRA, what3words)** — [infra],
    gated on partnerships or paid APIs; ingest never auto-publishes.

### Anti-backlog (do NOT build without a new owner ask)

Public crowdsourced write surfaces (T7, N1–N5) · web-push *before* the service
worker exists · an installable manifest / Install button before a real SW update
strategy (explicit v0.96.1 directive) · accounts/identity · push nags ·
model-picker theater · reframe-obsoleted ack/status tiering · re-probing dead
data sources.

**Sanctioned exception:** live team location sharing (NEXT item 12) is the one
owner-requested write surface — opt-in only, ephemeral handles (no accounts/PII),
TTL'd, private-by-default, flag-gated, and never archived. It does **not** unpark
the crowdsourced-curation write surfaces (T7/N1–N5) or persistent accounts, which
stay in this anti-backlog until a separate owner ask.

---

## (d) Architecture & parallelization note

The **precondition for parallel development landed in v0.78.0** — the js/app.js
monolith is split into ordered modules (core/map/sources/panels/board/boot, plus
chat/notes/i18n/usng), so disjoint lanes no longer collide on a single file.
Concurrent-safe lanes: [ux] index.html + css + feed/panels JS · [data-client]
map/sources layer JS + vendored libs · [data-server] server.py/cron + curated
data files · [infra] deploy/build/service-worker · [views] the new-view JS files.

Shared-file ownership rule (per dispatch conventions): CHANGELOG.md,
data/changelog.json, and chat-outbox.json have exactly one owner per cycle — the
cycle controller writes them, agents report entries in their results. Verify no
two dispatched lanes list the same file before fan-out.
