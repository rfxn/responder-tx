# ResponderTX · MASTER ROADMAP (updated 2026-07-24)

Current build: **v0.97.63** (see `CHANGELOG.md` for the full v0.1.0 → v0.97.63 arc,
which is the authoritative record of what has shipped). This roadmap tracks
delivered capabilities and the forward queue; per-cycle volatile status lives in
CHANGELOG/HANDOFF, not here. Verified against the 2026-07-24 twelve-agent
product-owner assessment (25 confirmed / 6 partial / 0 refuted findings).

> Recently shipped in the v0.97.25–63 arc, reflected below: the live coastal
> pivot for TS Bertha (board re-targeted to the upper Texas coast through
> `data/event.json`, v0.97.47); tropical layers (NHC cone/track tracker
> v0.97.48 with auto-default v0.97.50, SLOSH storm-surge overlay v0.97.53,
> CO-OPS coastal water levels v0.97.52); the offline app-shell service worker
> with user-controlled updates (v0.97.63) plus the branded install manifest /
> PWA (v0.97.60); automated tests + CI (node:test harness, 89 tests across 8
> files, GitHub Actions running cycle-check; merged 2026-07-19); field-device
> UX (live compass heading v0.97.54, screen wake lock v0.97.56, continuous
> follow mode v0.97.28–34, GPS accuracy rings v0.97.57, 44px tap targets
> v0.97.61); and team wave 2 (rehab status, marker assignment, invite presets
> v0.97.27; Unavailable status v0.97.45; last-known tombstones v0.97.46;
> teammate detail taps v0.97.57).

---

## Delivered / status summary (read this first)

ResponderTX is a **production-grade flood + tropical operating picture** that
has now been proven on two live events (Hill Country floods, TS Bertha coastal
pivot) and is feature-complete against its own original backlog: the entire NOW
block, all of the W1–W9 next-wave, most table-stakes (T1/T2/T4/T6/T8), the
self-audit quick-wins (A1/A2/A4/A5/A6/A7), the **historical-playback flagship**,
the team layer, and the 2026-07-20 infra NOW block (durable pipeline, tests +
CI, service worker) have all shipped. What remains is less about missing
situational-awareness features and more about **offline correctness, security,
notification delivery, and generalization** (see the forward queue).

**Delivered capability clusters** (lead version in parentheses):

- **Alerts** — live NWS flood alerts with flash-flood-emergency detection,
  AO-vs-elsewhere fold (A1, v0.69.0), on-map polygons, new-emergency banner,
  7-day expired-alert history, in-app alert-text reader with the named river
  reach (v0.96.3), and the hazard allowlist widened beyond flood-only for the
  tropical arc (v0.97.47).
- **Gauges & forecast** — NWPS bbox gauges with flood categories and
  rising/falling trend, stale-sensor suppression (v0.75.4), 48h sparkline + full
  hydrograph modal with the crest-of-record line (W6, v0.62.0), RFC 5-day
  forecast-max rings (v0.34.0), USGS raw-stage auto-fallback (#11, v0.34.0/0.38.0),
  Record-Watch crest-of-record context (W2, v0.57.0), the down-basin
  crest-wave tracker (W1, v0.58.0), and honest no-data handling for sentinel
  readings (v0.97.41).
- **Coastal & tropical** · NHC tropical cyclone tracker: forecast cone, track,
  positions, coastal watches/warnings (v0.97.48), auto-defaulted ON during an
  active Texas tropical threat (v0.97.50); SLOSH MOM storm-surge hazard overlay
  (v0.97.53); CO-OPS observed-vs-predicted coastal water levels in Resources
  (v0.97.52). Built live during TS Bertha on the event-config pivot (v0.97.47).
- **Radar & rainfall timeline** — one unified scrubber that runs observed radar →
  NOW → amber HRRR model future (+1h→+18h) in a single bar (v0.96.0, merged
  scrub + legend v0.97.43), plus the standalone HRRR future-cast layer (v0.95.0)
  and a unified MRMS rainfall overlay with 1/24/48/72h windows (v0.90.0). Radar
  cell-retry fill (v0.97.55). Closes the long-open "future-cast source hunt."
- **Roads & crossings** — live TDEM DriveTexas closures/high-water (v0.76.0),
  recently-reopened-roads recovery signal (v0.79.0), TxGIO low-water-crossing
  location inventory (~3.7k) plus the curator-maintained crossing tracker
  (W4/#13, v0.60.0).
- **Cameras** — road & river cameras with live HLS + snapshot + stale badging,
  auto-linked into nearby gauge popups (T6, v0.83.0; TxDOT ITS snapshot cams
  v0.88.x), City of Arlington network (v0.97.25), collapsible grouped camera
  sub-sections (v0.97.36), and Hays County flood cams along the San Marcos
  corridor (v0.97.58).
- **Flood inundation** — NWM model inundation-extent overlay, labelled a MODELED
  estimate, off by default (T1, v0.73.0).
- **Field/first-responder UX** — Drive Mode big-type nearest-hazards glance
  (V1/W5, v0.61.0), long-press point inspector (v0.85.0), plain-language
  headline, threat-to-life strip, actionable ticker, radio-speakable R-### short
  IDs (#14, v0.53.0), USNG grids, "Am I at risk?" address lookup (T2, v0.74.0;
  flag-gated `?risk=1` since v0.75.0).
- **Field-device UX** · continuous follow-mode tracking with re-center-on-me
  (v0.97.28, smoothed v0.97.33–34), live compass heading on the rose (v0.97.54,
  visible on phones v0.97.62), screen wake lock during team sharing and Drive
  Mode (v0.97.56, reliability v0.97.59), GPS accuracy rings + teammate detail
  taps (v0.97.57), and 44px tap targets / always-visible tabs / legible
  freshness text (v0.97.61).
- **Team coordination** · opt-in live team location sharing over a per-team
  Cloudflare Durable Object relay (v0.97.0), multi-type teams (SAR / Response /
  Recovery / Community) + LAN master oversight view (v0.97.22–24), pid/secret
  credential split (v0.97.7), wave 2: rehab status, marker assignment, invite
  filter presets (v0.97.27), auto-rejoin (v0.97.31), backgrounding survival +
  admin hardening (v0.97.39, v0.97.46), Unavailable soft-stop status (v0.97.45),
  last-known tombstones + persistent safety notices (v0.97.46).
- **History & AAR** — multi-layer historical playback: 3/7/14-day scrub over
  gauges + NWS warning archive + roads + radar + rainfall with crest chapters and
  a story caption track (T8/V5, v0.82.0 → v0.96.0), plus the event crest-summary
  AAR view (v0.80.0) and record-crest context in event-scoped data (v0.97.60).
- **Sharing & interop** — one-tap Share View with full view-state in the URL,
  per-item deep links (W7, v0.48.0 + `?hydro=`/`?fq=`/`?cam=`/`?pbt=`), OG unfurl
  cards (W3, v0.59.0), public RSS + ICS crest calendar (W8, v0.63.0), and
  SITREP/AAR/JSON/GeoJSON exports (→ CalTopo/SARTopo).
- **Platform** — EN/ES localization + a11y pass (T4, v0.75.0; parity verified
  692=692 keys at v0.97.63), first-run onboarding + glossary + unified search
  (A5, v0.86.0), grouped layer sheet (v0.89.0), graceful in-tab update rollover
  (v0.87.0), IndexedDB offline **basemap tiles** (W9/#16, v0.64.0),
  OFFICIAL-vs-CURATED provenance badges (A4, v0.81.0), security/quality
  hardening passes (v0.75.5, v0.77.0), modal accessibility: focus-trap, inert
  background, consistent Escape with the 911 gate Escape-immune (v0.97.44),
  branded install manifest / PWA (v0.97.60), and the offline app-shell service
  worker with user-controlled updates (v0.97.63).
- **Architecture** — the js/app.js monolith was split into ordered modules
  (core/map/sources/panels/board/boot + chat/notes/i18n, v0.78.0); a per-cycle
  Python generator pipeline (roads/crest/history/feeds/cameras + snapshot) backs
  the feeds, now on a durable SYSTEM crontab independent of any curator session
  (run-cycle.sh at :08/:23/:38/:53, merged 2026-07-19) with a feed-status
  headline in Resources: per-source fresh/aging/stale chips plus an
  updated/next-in countdown (v0.97.49); automated tests + CI (node:test, 89
  tests across 8 files; GitHub Actions runs syntax checks, the unit suite, and
  cycle-check.sh on every push); unified team-relay proxy forwarder (v0.97.31);
  deploy via `scripts/deploy.sh` (A7). Public read-only mirror at
  respondertx.org (v0.31.0) with all LAN-only surfaces (ops chat, field-notes
  intake) stripped from the artifact.

**Genuinely still open** (detail in the forward queue): offline-shell
correctness (SW data-cache query-string miss, Leaflet still CDN-only) ·
event-pivot drift (AO presets still framed on the retired Hill Country AO) ·
LAN write-endpoint security · web-push threshold alerts (T3, now unblocked by
the SW) · i18n dynamic-string sweep · CSP backstop · region/event-pack
generalization remainder (#25) · severe/tornado + wildfire all-hazard remainder ·
multi-source failover for single-host feeds · T5 evacuation zones (data-gated) ·
V2 basin-focus, V3 recovery, V4 wall views · live FEMA-shelter poller (#12) ·
shared curated-board state (#27 remainder) · CalTopo enriched export ·
trust/governance content · small polish (A3 desktop KPI declutter, A8 LSR
ranking, #18 measure tool, #19 watchlist star).

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
   single context chip v0.94.0). NOTE: presets are still hardcoded to the Hill
   Country AO and now drifted from the live coastal event; making them
   event-config data is NOW item N2.
9. **#15 MRMS legend color-scale strip** — DELIVERED (v0.50.0 ramp + light→extreme
   labels; folded into the unified Rainfall legend v0.90.0).
10. **#17 Editable lat/lon + scroll-map-into-view on form open** — DELIVERED
    (v0.49.0).

### Table-stakes (T1–T8)

- **T1. Street-level flood inundation (NWPS/NWM)** — DELIVERED (v0.73.0, NWM
  AnA inundation-extent overlay, labelled MODELED, off by default).
- **T2. "Am I at risk?" address lookup + saved my-places** — DELIVERED (v0.74.0;
  flag-gated behind `?risk=1` v0.75.0 as a first-responder tool, kept intact).
  Public surfacing of the risk check is an owner-gated decision (see the
  owner-gated list).
- **T3. Web-push threshold alerts** — OPEN, now UNBLOCKED and queued as NOW N6:
  the stated blocker (no service worker) was removed by v0.97.63. The single
  biggest remaining adoption feature. Store endpoint+threshold only, no
  identity; never a WEA/911 replacement.
- **T4. Spanish localization (+ a11y pass)** — DELIVERED (v0.75.0 EN/ES toggle,
  `?lang=es`, standard NWS/FEMA Spanish register; live data stays EN). Key
  parity verified 692=692 at v0.97.63; the remaining gap is ~10 dynamic
  renderer strings hardcoded in English (NOW N5).
- **T5. Evacuation zones w/ status + "safe to return"** — OPEN, data-gated.
  Mirror authoritative zone status where available; never invent an order.
- **T6. Live river/road/traffic cameras** — DELIVERED (v0.83.0 TxDOT/USGS cams +
  v0.88.x ITS snapshot cams; stale badging; auto-linked into gauge popups;
  Arlington v0.97.25, Hays County flood cams v0.97.58).
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
  outbox, grep the archive, version-agreement preflight, live smoke). A
  test-suite preflight is queued (NOW N4).
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
- **#25. Multi-event config presets / region generalization** — IN PROGRESS,
  substantially advanced. `data/event.json` now drives name, region,
  center/zoom, gaugeBbox, and start time, and the **TS Bertha coastal pivot
  (v0.97.47) is the first live proof of re-targeting**: the whole board moved
  from the Hill Country to the upper Texas coast through config, and the public
  feed/crest/history exports became event-scoped (v0.97.60). Remaining scope is
  narrowed to hazard/event packs and non-TX literals. Acceptance checklist (the
  concrete hardcoding inventory that blocks non-Texas adoption): the NWS alerts
  URL (`area=TX`), the DriveTexas/TxGIO road + crossing layers, the eight
  Texas-city camera networks, the coastal tide-station seed, the LSR
  flood-in-AO bbox test, and the AO quick-jump presets (the presets are NOW
  item N2). Sequenced after the owner's name/domain decision.
- **#26. HTTPS service worker / full offline PWA** — DELIVERED. The app-shell
  service worker with user-controlled updates shipped v0.97.63, and the branded
  install manifest returned v0.97.60 (the v0.96.1 removal condition, a real SW
  update strategy, is satisfied). Offline-shell correctness fixes (data-cache
  query-string miss, Leaflet vendoring) are NOW item N1.
- **#27. Shared multi-operator state** — partially SUPERSEDED by the delivered
  team layer: live shared positions, shared team markers with assignment,
  invite filter presets, and the LAN master oversight view constitute a first
  shared-state layer (v0.97.0–63). The open remainder is shared curated-board
  state between operators, notices/AO rather than member positions: today
  "+ New notice" saves to localStorage on every surface and the only
  multi-station sync is manual Export/Import (see NEXT, shared notice write
  path).
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

The board is a proven multi-event instrument. The forward work is the path from
*instrument* to a **general-availability product**: offline-correct, secure,
notifying, and generalized. Ranked top-down within each horizon. Finding IDs
(prod-N, arch-N, test-N, compat-N) reference the 2026-07-24 assessment digest.

### Delivered from the previous (2026-07-20) forward queue

- **Reliability + honest failure (old NOW 1)** · DELIVERED except one remnant:
  refresh runs on a durable SYSTEM crontab independent of any curator session
  (run-cycle.sh at :08/:23/:38/:53, merged 2026-07-19) and Resources headlines
  per-source fresh/aging/stale chips with an updated/next-in countdown
  (v0.97.49). The remnant, multi-source failover for single-host feeds, carries
  forward as its own NEXT item.
- **Tests + CI (old NOW 2)** · DELIVERED (merged 2026-07-19): node:test
  harness, 89 tests across 8 files (USNG vs external ground truth, stale/category
  predicates, smart-sort, short-ID hashing, SW precache agreement, 22 team-relay
  security tests), plus GitHub Actions CI running syntax checks, the unit suite,
  and the 7-gate cycle-check.sh on every push. Hardening continues as NOW N4.
- **Service worker (old NOW 3, #26)** · DELIVERED v0.97.63: app-shell precache
  versioned in lockstep with `APP_VERSION`, user-controlled updates,
  chat.js/master.js excluded. Correctness fixes are NOW N1.
- **Installability / PWA (old NEXT 5)** · DELIVERED v0.97.60 (branded install
  manifest, returned only after the SW update strategy existed, honoring the
  v0.96.1 directive).
- **Tropical/coastal half of old LATER 13** · DELIVERED v0.97.47–53 ahead of
  1.0, during TS Bertha (NHC tracker, SLOSH surge, CO-OPS tides, widened
  hazard allowlist). The severe/tornado + wildfire remainder stays in LATER.
- **Live team location sharing (old NEXT 12)** · DELIVERED v0.97.0 → v0.97.63
  (see the Team coordination cluster above; Phase-2 SAR remains in the team
  build queue).

### NOW (active build queue, PO-ordered 2026-07-24)

- **N1. Offline shell correctness** [infra] · IN PROGRESS (release agent
  building now). Fix the shipped SW's data fallback: cache-busted `/data/*.json`
  URLs never match the data cache, so offline reload silently loses last-good
  data; match with `{ignoreSearch:true}` or strip the buster when keying
  (prod-1). Vendor Leaflet JS+CSS into `js/vendor/` with `?v=` stamps (matching
  the markercluster/hls/qrcode precedent) and add to the SW precache, so an
  offline cold boot actually renders a map instead of dying on the unpkg CDN
  dependency (compat-1, arch-2). Add `vh` fallback lines before the two
  unfallbacked `100dvh` rules for 2020-2022 WebViews (compat-4).
- **N2. Event-pivot drift** [ux/data] · AO quick-jump presets and "Reset view"
  still frame the retired Hill Country AO while the live event is on the coast;
  read `aoPresets` from `data/event.json` (hardcoded list as fallback) and
  derive "Full AO" from `CONFIG.gaugeBbox` (prod-2). Fix the swallowed
  `loadEventConfig` TypeError: the brand hook targets a removed `.brand h1`, so
  event name/subtitle silently never apply; null-guard and target the logo
  alt/aria + `document.title` (prod-3). Cheapest first concrete step of #25.
- **N3. Security: LAN write endpoints** [infra] · gate POST `/api/chat` and
  `/api/notes` behind `_lan_client_allowed` (parity with the team proxy); the
  inbox is currently attacker-POST-able while a build-capable watchdog reads it
  (arch-1). Add a per-IP token-bucket rate limit on the POST endpoints and
  inbox rotation/archival at a size threshold (arch-7).
- **N4. Test/CI hardening** [infra] · add tests/i18n.test.js asserting en/es
  key-set equality plus an em-dash lint over both blocks (test-1); wire
  tests/chat-poll.test.sh into CI as a step after the unit tests (test-2); make
  deploy.sh preflight run `node --test tests/` + cycle-check.sh with an
  explicit emergency skip flag (test-3); extend cycle-check with chat-cursor
  format/monotonicity checks (test-9).
- **N5. i18n dynamic-string sweep** [ux] · route the ~10 hardcoded English
  renderer strings (gauge "no flooding", wave crested/arrival order, crossing
  CLOSED/CAUTION statuses, Drive Mode subs) through `t()`; keys mostly exist;
  add a cycle-check grep for English literals in renderer templates (prod-6).
- **N6. Web-push threshold alerts (T3)** [infra] · now unblocked by the SW
  (v0.97.63); the single biggest adoption feature vs the 2026 Watch Duty
  national-flood frame (prod-9). VAPID + edge KV/cron storing
  endpoint+threshold only (no identity); new-FFE, gauge-to-major, and
  followed-place alerts; framed as "not a WEA/911 replacement."
- **N7. CSP backstop + data-contract schemas** [infra] · after N1 vendoring
  enables `script-src 'self'`, add a Content-Security-Policy to `_headers` and
  `server.py` as defense-in-depth behind `esc()` at the 150+ innerHTML sites
  (arch-5); extend cycle-check.sh with per-file required-key schema assertions
  (history frames, crest-summary lid/peak_category, roads-snapshot,
  cameras.json) so contract drift fails the cycle instead of degrading silently
  (arch-3).

### NEXT (after the NOW queue)

8. **Post-Bertha event revert readiness** [data] · the v0.97.47 pivot note
   promises "revert when the event clears"; pre-stage the revert path (event.json
   swap + tropical layers auto-default off) so it is a config flip, not a build.
9. **Multi-source failover for single-host feeds** [infra] · the old NOW 1
   remnant: RainViewer/HRRR/DriveTexas each sit behind one host.
10. **FEMA NSS open-shelters poller (#12)** [data] · durable server-side poll →
    `data/shelters-live.json`, merged over curated shelters, absence-tolerant.
11. **Module split wave 2** [infra] · extract the ~330-reference playback
    subsystem from map.js (2548 lines) and the camera layer from sources.js
    (1597) into ordered scripts; add a CI step that evaluates the full
    concatenated bundle so implicit cross-module references are checked (arch-4).
12. **Shared notice write path (P2, the #27 remainder)** [infra] · LAN
    notice-intake endpoint (POST `/api/requests` → notices-inbox.jsonl, merged
    into data/requests.json by the run-cycle generator, mirroring the
    notes-inbox pattern) so two coordinators share one board (prod-4).
13. **Team breadcrumb store-and-forward** [field] · fold into the Phase-2 SAR
    item already in the team build queue: buffer failed position posts and flush
    a batched backfill on reconnect so trails survive dead zones and
    screen-lock pauses (prod-5).
14. **Honesty-critical test coverage wave** [infra] · record-context boundary
    math, playback guard predicates, share-URL round-trip, cardAged/suppression
    (resolved short-circuit + per-type overrides), and the three
    exported-but-unasserted predicates (test-4..8).
15. **V3 Recovery Dashboard (`?view=recovery`)** [views] · consolidate the
    recovery signals (falling gauges, reopened roads, shelter/boil-water/utility
    cards, declarations chip #22) into one lens.
16. **V2 Basin Focus (`?view=basin`)** [views] · single-river corridor,
    upstream→downstream, with the crest wave visualized as it moves down-basin.
17. **CalTopo / SARTopo enriched export + QR (MVP), live sync (stretch)**
    [interop] · extend the GeoJSON export into a curated, multi-layer
    CalTopo-shaped FeatureCollection (folders, `title` labels, per-feature
    citations + `updated_at`, simplestyle-matched palettes) published at a
    stable cycle-refreshed URL with a client-side QR share. Stretch
    (account-gated): true continuous sync via the CalTopo Teams API; CalTopo
    does NOT poll a static GeoJSON URL, so real sync needs a subscription and a
    small always-on job. Detail in the internal assessment.
18. **Deploy resilience** [infra] · decouple deploy credentials from the
    rfxn-infra vault checkout (dedicated scoped token or wrangler-native login)
    and add an external freshness monitor that alerts when the mirror's data
    goes stale; today one host carries cron, LAN server, git push, and Pages
    deploy (arch-6).

### OWNER-GATED (explicit owner decision required; do NOT auto-build)

- **Rebrand / product name + domain** · the de-Texas-ify / all-hazard naming
  decision; #25's non-TX literals sequence after it. (N2 fixes the broken
  event.json brand hook as groundwork.)
- **Divergence indicator** [views] · forecast-vs-observed divergence cue on
  gauges; the design itself is the owner call.
- **Public risk-check surfacing** · the "Am I at risk?" button is hidden behind
  `?risk=1` by explicit owner directive; surfacing it on the public mirror
  during active events (or a persistent long-press hint) is an owner decision
  (prod-7).
- **Cloudflare zone cache rule for /sw.js** · respondertx.org serves /sw.js
  with max-age=14400 from a zone-level setting, overriding the repo `_headers`
  no-cache rule that works on pages.dev; fixing it is zone configuration, not
  repo code (compat-2).
- **Team C SOS** and **compass on-device sign** · owner-gated per the Bertha
  release wave; do not auto-advance.

### LATER (post-event or gated)

19. **All-hazard remainder: severe/tornado + wildfire** · the tropical/coastal
    half shipped v0.97.47–53; the remainder is cheap for warnings (extend
    `HAZARD_ALERT_RE` + styling) while wildfire needs perimeter data. Follows
    generalization (#25).
20. **T5 evacuation zones** — data-gated; mirror authoritative status, never
    invent an order.
21. **Trust/governance content** — about/who-runs-this, a methodology & accuracy
    page (surfacing the honesty discipline that is already a strength), a
    privacy/terms page, a LICENSE file, and a documented browser floor
    (Chrome/WebView 80+, iOS 13.4+ per compat-3).
22. **V4 EOC Wall (`?view=wall`)** — auto-rotating full-screen panels with the
    print-stylesheet tokens; pairs with the fullscreen plugin (#30).
23. **#22 OpenFEMA declarations chip · #21 CoCoRaHS precip · #23 USGS STN HWM
    hook** — [data], mostly recovery/AAR, event-gated.
24. **Minor polish** — A3 desktop KPI declutter, A8 LSR freshness ranking, #18
    measure tool, #19 watchlist star, offline tile-failure banner (compat-9).
25. **#28 X ingest worker · #29 remaining partnership feeds (PulsePoint,
    Broadcastify, LCRA, what3words)** — [infra], gated on partnerships or paid
    APIs; ingest never auto-publishes.

### Anti-backlog (do NOT build without a new owner ask)

Public crowdsourced write surfaces (T7, N1–N5) · accounts/identity · push nags ·
model-picker theater · reframe-obsoleted ack/status tiering · re-probing dead
data sources.

**Sanctioned exception:** live team location sharing (DELIVERED v0.97.0 →
v0.97.63) is the one owner-requested write surface — opt-in only, ephemeral
handles (no accounts/PII), TTL'd, private-by-default, flag-gated, and never
archived. It does **not** unpark the crowdsourced-curation write surfaces
(T7/N1–N5) or persistent accounts, which stay in this anti-backlog until a
separate owner ask.

---

## (d) Architecture & parallelization note

The **precondition for parallel development landed in v0.78.0** — the js/app.js
monolith is split into ordered modules (core/map/sources/panels/board/boot, plus
chat/notes/i18n/usng, and team/sw since), so disjoint lanes no longer collide on
a single file. Concurrent-safe lanes: [ux] index.html + css + feed/panels JS ·
[data-client] map/sources layer JS + vendored libs · [data-server]
server.py/cron + curated data files · [infra] deploy/build/service-worker ·
[views] the new-view JS files.

Shared-file ownership rule (per dispatch conventions): CHANGELOG.md,
data/changelog.json, and chat-outbox.json have exactly one owner per cycle — the
cycle controller writes them, agents report entries in their results. Verify no
two dispatched lanes list the same file before fan-out.
