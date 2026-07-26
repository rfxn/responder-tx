# ResponderTX · MASTER ROADMAP (updated 2026-07-26)

Current build: **v0.99.52** (see `CHANGELOG.md` for the full v0.1.0 → v0.99.52 arc,
which is the authoritative record of what has shipped). This roadmap tracks
delivered capabilities and the forward queue; per-cycle volatile status lives in
CHANGELOG/HANDOFF, not here. The forward queue below was re-derived from source
on 2026-07-25 after the v0.97.82–v0.98.6 arc and reconciled against the
v0.98.7–v0.99.34 arc on 2026-07-26.

> The v0.99.35–v0.99.52 arc came from a product-owner assessment (UX audit,
> competitive analysis, backlog reconciliation) and then from the failure class
> those releases kept exposing. Delivered inventory:
> **the assessment's top ten** · device alerts discoverable at last, the whole
> push stack having been built, tested and reachable only behind a query flag
> (v0.99.37); alerts scoped to an alert area rather than all of Texas, which
> mattered the moment the registry opened (v0.99.38); the complete 8,339-crossing
> inventory and a Roads tab that lists the roads (v0.99.39); Alerts leading with
> what is near you (v0.99.40); 44px targets, working list-to-map on a phone, and
> reduce-motion honoured across the stylesheet (v0.99.41); 121 KB off the cold
> load (v0.99.43); one door per lens, which also repaired a state where four
> lenses had no door at all (v0.99.44); an in-app about surface and a version
> poll that stopped pulling a 130 KB changelog every 3 minutes (v0.99.46); KML
> and GeoRSS making the board a live layer in ArcGIS, ATAK and Google Earth
> (v0.99.45).
> **owner asks that had gone cold** · view state surviving a refresh, a
> rising-to-major focus that had lost its caller and gone dead, and an offline
> save that reported success after saving nothing (v0.99.47).
> **things the board asserted that no source stated** · an "All clear" over live
> hazards and a cold-load emergency banner that never fired (v0.99.35); a green
> REOPENED on a still-closed road, twice by two mechanisms (v0.99.36, v0.99.50);
> an RSS feed publishing zero flash-flood emergencies from a failed fetch, plus a
> channel that had silently lost its 911 line (v0.99.51); a gauge coded not-in-flood
> at a record crest (v0.99.52).
> **the USGS layer** · dead in production for three days after the AO widened past
> an undocumented upstream area cap, restored by tiling, with the real cosine rule
> measured and a guard that fails the cycle on a repeat (v0.99.49).

> The v0.98.7–v0.99.34 arc closed five of the six NOW items and then spent most
> of its length on the camera fleet, which grew from roughly 1,000 to 6,510.
> Delivered inventory rather than queue:
> **archive and pipeline** · road playback got the gauge lane's retention split,
> so a display-scope change can no longer stop the road record (v0.98.7); the
> whole-record playback file became a bounded seven-day view and the crest
> summary moved onto the chunked archive (v0.98.9); the data cycle now runs
> committed code against working-tree data (v0.98.10); each deploy stages into
> its own directory (v0.99.19); an interrupted ops-chat recovery leaves the
> working copy as it found it (v0.99.18).
> **honesty** · the crest summary, the CalTopo export and the curated shelter
> list stopped claiming more than they knew (v0.99.4, v0.99.1); the freshness
> alert names the source that stopped answering instead of blaming the cycle
> (v0.99.16); a camera with no published capture time says so (v0.99.28); the
> chat-cursor check fails on a cursor moving backwards (v0.98.8).
> **reach** · the AO reset from a finished storm to twelve standing Texas
> regions (v0.99.0); cameras regrouped by region rather than operator (v0.99.2),
> gained statewide and per-region switches (v0.99.12), split out-of-state
> cameras by state (v0.99.21), and separated live video from still photos in
> the marker set (v0.99.8); TxDOT district snapshots opened on the public board
> at last (v0.99.26); River Sentry siren sites became a layer (v0.99.10); a
> reported-closure crossing layer landed (v0.99.27).
> **legibility** · the top of the board became one scrolling hazard line rather
> than two competing rows (v0.99.13, v0.99.20, v0.99.23); the life-safety cues
> speak Spanish and the guard against untranslated text became structural
> (v0.99.3); degraded gauges reached the Gauges list (v0.99.15); hotlines dial
> and shelters navigate (v0.99.17); Playback replays with no signal (v0.99.14).

> The v0.97.82–v0.98.6 arc drained all but one of the previous NOW block and
> then went well past it, because an archive-integrity emergency nobody had
> queued surfaced mid-arc. Delivered inventory rather than queue:
> **correctness and pipeline** · the Recovery view rendering into a duplicate
> hidden container (v0.97.82); the `openView()` router behind every `?view=`
> deep link (v0.97.84); the deploy gate reading and shipping HEAD instead of
> the working tree (v0.97.85); device alerts always carrying a reachable off
> switch (v0.97.86); shelter status no longer publishing OPEN for a shelter no
> source called open, and Recovery markers no longer painting live data under
> the playback badge (v0.97.87); the offline data cache surviving an app update
> (v0.97.88); a mid-bump working tree no longer failing a whole data cycle
> (v0.97.89); the freshness slot regaining a single writer and telling the truth
> in Spanish (v0.97.95); and one failing upstream no longer blocking the whole
> publish (v0.97.96).
> **Information architecture** · the lenses left the Feed overflow menu for a
> Views sheet on the map (v0.97.90); exports left the Feed tab (v0.97.91) and
> then Resources for a Share-anchored surface (v0.97.99); the header ⋮ became a
> real settings sheet holding Display, Alerts, Actions and Help (v0.97.92); the
> header stopped shrinking its own tap targets and the four tiles gave way to
> threat-strip chips (v0.97.93); Basin, Recovery and Crest summary stopped being
> full-screen modals and docked beside the map (v0.97.94); the views control
> started naming its own state and the map corner dropped from five boxes to
> three (v0.97.98); and Resources dissolved, with Roads taking the tab slot,
> tides moving to Gauges, feed status moving behind the data-age bar, and
> shelters becoming a count-gated chip plus a settings row (v0.98.0). This arc
> was argued from the app's own surfaces rather than from a research pass; the
> only external appeals in it are three one-liners (comparable products do not
> put export in a content tab, the platform guidance that a Share control should
> present an activity view, and the NWPS degraded-gauge default).
> **Playback archive** · retention split from display so a display-scope change
> can narrow what the board shows and can never delete a stored observation, plus
> `archiveStart` as its own field and per-frame provenance (v0.97.97); the NWPS
> 30-day observed buffer rescued for every gauge lid the board has ever seen and
> the pre-prune blobs recovered out of our own git; the archive publishing in
> day-sized immutable pieces behind a hashed index (v0.98.1); and 30 and 90 day
> ranges, marked honestly where the range is deeper than the archive (v0.98.2).
> **Map and vehicle** · degraded gauges became peer values in the legend, which
> is also the filter, and reached the map at all for the first time (v0.98.3);
> the hazard line stopped scrolling itself and landscape learned to give the map
> the screen (v0.98.4).
> **Public artifact** · the CalTopo export stopped silently dropping crests
> outside the display scope, and ops-side code (scripts, the LAN server) left the
> mirror (v0.98.5); the Team tab left the default tab bar and the field-report
> form was withdrawn wherever no ops backend answers (v0.98.6).

---

## Delivered / status summary (read this first)

ResponderTX is a **production-grade flood + tropical operating picture** that
has now been proven on two live events (Hill Country floods, TS Bertha coastal
pivot) and is feature-complete against its own original backlog: the entire NOW
block, all of the W1–W9 next-wave, most table-stakes (T1/T2/T3/T4/T6/T8), the
self-audit quick-wins (A1/A2/A4/A5/A6/A7), the **historical-playback flagship**,
the team layer, and the 2026-07-20 infra NOW block (durable pipeline, tests +
CI, service worker) have all shipped, as has the 2026-07-24 assessment block
(offline correctness, LAN write security, push notification delivery, CSP, and
the Recovery and Basin lenses). The v0.98 arc then closed the last of it: the
information architecture was consolidated end to end (Views sheet, settings
sheet, Share surface, Resources dissolved), and the archive was rebuilt so that
what the board displays can never again decide what the board keeps. The v0.99
arc reset the area of operations from a finished storm to standing Texas regions
and grew the camera fleet past six thousand.

Archive integrity closed in the v0.98.7–v0.99.34 arc: both the gauge and the road
record are retained wide and published narrow, and the whole-record file is a
bounded view rather than a full-file delta every cycle. What remains splits two
ways. **Resilience** is the two single-host feeds. **Legibility to outsiders** is
generalization and the in-app provenance surface. See the forward queue.

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
  readings (v0.97.41). Degraded gauges (no flood category defined, data not
  current, out of service) are peer values in the map legend with live counts and
  their own filter checkboxes, on by default, and reach the map at all for the
  first time (v0.98.3); charts and popups say where the observed record stops
  instead of drawing over dead data.
- **Coastal & tropical** · NHC tropical cyclone tracker: forecast cone, track,
  positions, coastal watches/warnings (v0.97.48), auto-defaulted ON during an
  active Texas tropical threat (v0.97.50); SLOSH MOM storm-surge hazard overlay
  (v0.97.53); CO-OPS observed-vs-predicted coastal water levels (v0.97.52, in
  Gauges since Resources dissolved at v0.98.0). Built live during TS Bertha on
  the event-config pivot (v0.97.47).
- **Radar & rainfall timeline** — one unified scrubber that runs observed radar →
  NOW → amber HRRR model future (+1h→+18h) in a single bar (v0.96.0, merged
  scrub + legend v0.97.43), plus the standalone HRRR future-cast layer (v0.95.0)
  and a unified MRMS rainfall overlay with 1/24/48/72h windows (v0.90.0). Radar
  cell-retry fill (v0.97.55). Closes the long-open "future-cast source hunt."
- **Roads & crossings** — live TDEM DriveTexas closures/high-water (v0.76.0),
  recently-reopened-roads recovery signal (v0.79.0), TxGIO low-water-crossing
  location inventory (~3.7k) plus the curator-maintained crossing tracker
  (W4/#13, v0.60.0).
- **Cameras** · 6,510 cameras across 19 networks with live HLS + snapshot + stale
  badging, auto-linked into nearby gauge popups (T6, v0.83.0; TxDOT ITS snapshot
  cams v0.88.x, opened on the public mirror v0.99.26). Grouped by Texas region
  rather than by operator (v0.99.2), with out-of-state cameras split by state
  (v0.99.21), a statewide switch plus one per region group (v0.99.12), and live
  video separated from still photos in both the markers and the legend (v0.99.8).
  Networks: TxDOT, USGS HIVIS, Houston TranStar, Austin, ATX Floods, Arlington,
  Lubbock, Corpus Christi, El Paso bridges, Laredo, Eagle Pass, Del Rio, Hays
  County OES, Port Houston, Port of Galveston, Saltwater Recon, WeatherBug, NMDOT
  and NPS (v0.97.25 → v0.99.34). All stills relay through a same-origin proxy, so
  the camera fleet costs zero additional CSP hosts.
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
  freshness text (v0.97.61), the hazard line pinned worst-first with no
  self-scrolling motion and 44px targets, and landscape able to collapse the
  panel and hand the map the screen (v0.98.4).
- **Team coordination** · opt-in live team location sharing over a per-team
  Cloudflare Durable Object relay (v0.97.0), multi-type teams (SAR / Response /
  Recovery / Community) + LAN master oversight view (v0.97.22–24), pid/secret
  credential split (v0.97.7), wave 2: rehab status, marker assignment, invite
  filter presets (v0.97.27), auto-rejoin (v0.97.31), backgrounding survival +
  admin hardening (v0.97.39, v0.97.46), Unavailable soft-stop status (v0.97.45),
  last-known tombstones + persistent safety notices (v0.97.46).
- **History & AAR** · multi-layer historical playback: 3/7/14/30/90-day scrub
  over gauges + NWS warning archive + roads + radar + rainfall with crest
  chapters and a story caption track (T8/V5, v0.82.0 → v0.96.0, deep ranges
  v0.98.2), plus the event crest-summary AAR view (v0.80.0) and record-crest
  context in event-scoped data (v0.97.60). The archive itself is now two layers:
  RETENTION walks the committed capture with no geographic filter anywhere in the
  path, PUBLICATION projects that retained set through a display scope that only
  ever grows (v0.97.97), so a display-scope change can narrow the board and can
  never delete a stored observation. Frames carry provenance (self-captured,
  rebuilt from USGS or NWPS observed, or recovered from our own earlier commits),
  ranges deeper than the archive are marked before they are chosen, and the
  record publishes as a hashed index plus one immutable file per UTC day so a
  90-day window moves roughly what a 3-day window used to cost (v0.98.1).
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
  worker with user-controlled updates (v0.97.63) whose data cache now survives
  an accepted update (v0.97.88).
- **Information architecture** · one taxonomy across desktop, portrait and
  landscape (v0.97.90 → v0.98.0). Whole-app lenses live in a Views sheet on the
  map and route through a single `openView()` dispatcher (v0.97.84, v0.97.90),
  with Basin, Recovery and Crest summary docked beside the map rather than
  covering it and Drive Mode deliberately still full-screen (v0.97.94); settings
  live in a real settings sheet grouped Display / Alerts / Actions / Help
  (v0.97.92); the data-interchange cluster (Export JSON, GeoJSON, CalTopo, AAR,
  Import, RSS, crest calendar) lives on a Share-anchored surface (v0.97.99); the
  header holds one row with capped freshness text and threat-strip chips instead
  of tiles (v0.97.93); and Resources is gone, redistributed to Roads, Gauges, the
  data-age bar, a count-gated shelter chip and the settings sheet, with
  `?tab=resources` and `?tab=monitor` aliased forward (v0.98.0).
- **Architecture** — the js/app.js monolith was split into ordered modules
  (core/map/sources/panels/board/boot + chat/notes/i18n, v0.78.0); a per-cycle
  Python generator pipeline (roads/crest/history/feeds/cameras + snapshot) backs
  the feeds, now on a durable SYSTEM crontab independent of any curator session
  (run-cycle.sh at :08/:23/:38/:53, merged 2026-07-19), tolerant of a single
  failing upstream so a healthy source still publishes and a failed one ages
  honestly (v0.97.96), with per-source fresh/aging/stale detail behind the
  data-age bar (v0.97.49, relocated v0.98.0); automated tests + CI (node:test
  plus generator and shell suites; GitHub Actions runs syntax checks, the unit
  suite, and cycle-check.sh on every push); unified team-relay proxy forwarder
  (v0.97.31); deploy via `scripts/deploy.sh` (A7), which now gates and ships a
  throwaway HEAD checkout rather than the working tree (v0.97.85). Public
  read-only mirror at respondertx.org (v0.31.0) with every LAN-only and ops-side
  surface stripped from the artifact: ops chat, master view, Field Notes, and
  since v0.98.5 the whole `scripts/` tree and `server.py`.

**Genuinely still open** (detail in the forward queue): device alerts built and
deployed but undiscoverable behind `?push=1` · a still-closed road able to paint
a reopened badge when the upstream re-codes its condition · multi-source failover
for the two remaining single-host feeds (HRRR, DriveTexas) · no in-app
about/methodology/privacy surface ·
deploy-credential decoupling from the rfxn-infra vault · region/event-pack
generalization remainder (#25) · team Phase-2 SAR · severe/tornado + wildfire
all-hazard remainder · T5 evacuation zones (data-gated) · V4 wall view ·
camera-imagery retention (object-store scale, not repo scale) · CalTopo live-sync
stretch (subscription-gated) · small polish (#18 measure tool, #19 watchlist
star).

Refuted on re-verification, do not re-queue: **A3** desktop KPI declutter (the
tiles went at v0.97.93; no `kpi` identifier survives anywhere in the tree) and
**A8** LSR ranking (`js/sources.js:1349` already sorts freshest first). The N1
through N4 items this paragraph used to carry all shipped in the
v0.98.7–v0.99.34 arc; see the forward queue for their versions.

> **Known permanent gap in the archive.** DriveTexas keeps no upstream archive of
> its own, and between 2026-07-23T14:49Z and the capture/display split our own
> road capture was scoped to the display box. Any closure that opened *and*
> cleared in South or Central Texas inside that window was never recorded by
> anyone and is gone for good. It is not recoverable and it is not a task; it is
> recorded here so nobody later reads the road archive as complete.

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
   single context chip v0.94.0; event-config data since v0.97.65, so they follow
   the event rather than drifting from it, via `data/event.json` `aoPresets`).
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
- **T3. Web-push threshold alerts** · DELIVERED across three phases (v0.97.69
  Flash-Flood-Emergency opt-in, v0.97.71 gauge-level thresholds, v0.97.79
  followed gauges + manage view + subscription self-heal), backed by
  `workers/push-alerts`. Endpoint and threshold only, no identity; never a
  WEA/911 replacement. The card is now visible on subscription alone, so an
  opted-in device always has a reachable off switch (v0.97.86).
- **T4. Spanish localization (+ a11y pass)** — DELIVERED (v0.75.0 EN/ES toggle,
  `?lang=es`, standard NWS/FEMA Spanish register; live data stays EN). The
  hardcoded-English renderer strings were swept in v0.97.83 (feed and export
  controls), v0.97.88 (LAN clipboard/import/intake/team/shelter strings) and
  v0.97.95 (the degraded-feed tooltip). What is open is the guard, not the
  strings: see NOW N3.
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
- **A7. deploy.sh** · DELIVERED (`scripts/deploy.sh`: strip the LAN-only and
  ops-side files, empty the outbox, grep the archive, version-agreement
  preflight, test gate, live smoke). Every gate now reads a throwaway HEAD
  checkout rather than the working tree (v0.97.85), regression-covered by
  `tests/deploy.test.sh`.
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
- **#12. FEMA NSS open-shelters poller** · DELIVERED (v0.97.72,
  `scripts/gen-shelters.py` → `data/shelters-live.json`, FEMA + ARC citations).
  A record with a null or empty status now publishes as "unknown" with a muted
  colour instead of masquerading as OPEN (v0.97.87).
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
  flood-in-AO bbox test. The AO quick-jump presets came off that list at
  v0.97.65 (they are `data/event.json` data now), and the capture bbox joined
  `event.json` at the capture/display split. Sequenced after the owner's
  name/domain decision.
- **#26. HTTPS service worker / full offline PWA** — DELIVERED. The app-shell
  service worker with user-controlled updates shipped v0.97.63, and the branded
  install manifest returned v0.97.60 (the v0.96.1 removal condition, a real SW
  update strategy, is satisfied). Offline-shell correctness fixes shipped
  v0.97.64 (data-cache query-string miss, Leaflet vendored locally) and v0.97.88
  (the data cache surviving an accepted update instead of being wiped by it).
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
- **V2. Basin Focus (`?view=basin`)** · DELIVERED (v0.97.80, single-river
  corridor view carrying the crest wave; docked beside the map v0.97.94; routed
  through `openView()` in `js/panels.js`).
- **V3. Recovery Dashboard (`?view=recovery`)** · DELIVERED (v0.97.75, pulling
  together reopened roads, quiet-state all-clear, the recovery SITREP line and
  falling gauges). It rendered into a duplicate hidden container until v0.97.82,
  docked beside the map at v0.97.94, and stopped painting live markers under the
  playback badge at v0.97.87.
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
notifying, and generalized. Ranked top-down within each horizon, irreversible and
honesty-affecting work first, then what unblocks other work, then polish. Finding
IDs (prod-N, arch-N, test-N, compat-N) reference the 2026-07-24 assessment
digest.

### Delivered from the previous (2026-07-20) forward queue

- **Reliability + honest failure (old NOW 1)** · DELIVERED except one remnant:
  refresh runs on a durable SYSTEM crontab independent of any curator session
  (run-cycle.sh at :08/:23/:38/:53, merged 2026-07-19), one failing upstream no
  longer blocks the whole publish (v0.97.96), and per-source fresh/aging/stale
  detail sits behind the data-age bar with an updated/next-in countdown
  (v0.97.49, relocated v0.98.0). The remnant, multi-source failover for
  single-host feeds, carries forward as NOW N5.
- **Tests + CI (old NOW 2)** · DELIVERED (merged 2026-07-19): a node:test unit
  harness (USNG vs external ground truth, stale/category predicates, smart-sort,
  short-ID hashing, SW precache agreement, team-relay security), since joined by
  DOM-id, view-router, CSS-contract and modal-a11y suites and by shell and
  generator suites for deploy, cycle-check, run-cycle, gen-history and
  gen-shelters, all running in GitHub Actions on every push alongside syntax
  checks and cycle-check.sh.
- **Service worker (old NOW 3, #26)** · DELIVERED v0.97.63: app-shell precache
  versioned in lockstep with `APP_VERSION`, user-controlled updates, LAN-only
  clients excluded. The data cache is now keyed independently of the app version
  so an accepted update no longer empties it (v0.97.88).
- **Installability / PWA (old NEXT 5)** · DELIVERED v0.97.60 (branded install
  manifest, returned only after the SW update strategy existed, honoring the
  v0.96.1 directive).
- **Tropical/coastal half of old LATER 13** · DELIVERED v0.97.47–53 ahead of
  1.0, during TS Bertha (NHC tracker, SLOSH surge, CO-OPS tides, widened
  hazard allowlist). The severe/tornado + wildfire remainder stays in LATER.
- **Live team location sharing (old NEXT 12)** · DELIVERED v0.97.0 → v0.97.63
  (see the Team coordination cluster above; Phase-2 SAR remains in the team
  build queue).

### NOW (re-derived 2026-07-25 after v0.98.6, reconciled 2026-07-26 after v0.99.34)

Five of the six NOW items shipped in the v0.98.7–v0.99.34 arc. What remains is
N5 and half of N6, both verified still open in source.

- ~~**N1. Road replay still narrows with the display box**~~ · DELIVERED v0.98.7.
  The road walk got the same capture-then-snapshot retention the gauge walk has,
  with publication scope applied once at publish time.
- ~~**N2. The `data/history.json` compatibility view**~~ · DELIVERED v0.98.9. The
  whole-record file became a bounded `COMPAT_WINDOW_DAYS` view that names its own
  window, and `gen-crest-summary.py` now reads the chunked archive instead, so the
  per-cycle full-file delta is gone.
- ~~**N3. i18n renderer-guard coverage gap**~~ · DELIVERED v0.99.3. The guard is
  structural rather than a hand-kept file list, and every title and aria-label on
  the page must now carry a translation.
- ~~**N4. Chat-cursor monotonicity**~~ · DELIVERED v0.98.8. `check_cursors` fails
  on a cursor moving backwards and records the new position. The
  `.chat-ack-cursor <= .chat-cursor` half was deliberately **not** asserted: the
  ack cursor legitimately runs ahead of the build cursor by design, so that
  assertion would have false-failed a fatal data-cycle gate.
- **N5. Single-host feed failover remainder** [infra] · the v0.97.76 radar leg
  landed (RainViewer falling back to the IEM NEXRAD archive, `js/map.js`
  `iemRadarFrames()`), but 2 of 3 single-host feeds still have no second
  source: HRRR forecast radar (one IEM WMS endpoint, and `js/map.js` says so in
  as many words) and DriveTexas road closures (`js/sources.js`
  `fetchRoadClosures()`, single `CONFIG.roadCondUrl`, throws on non-200). Both
  degrade honestly rather than failing over, which is correct behavior but not
  resilience. Find and wire a real alternate for each, or document why none
  exists and keep the honest degrade as the final answer.
- **N6. Public-artifact remainder** [ux] · DELIVERED. The intake-form half shipped
  v0.98.11 (the markup no longer reaches the mirror, and every reader tolerates the
  element being absent). The `?note=<id>` half shipped v0.99.48: the parameter is
  kept rather than retired, because it still resolves on the LAN ops board where
  `js/notes.js` exists. On the mirror the injected script 404s and now answers with
  a notice saying Field Notes is not published there, so the link states its outcome
  instead of doing nothing.

### NEXT (after the NOW queue)

7. **Deploy-credential decoupling** [infra] · the remaining half of the old item
   18 (its freshness-monitor half shipped v0.97.81). `scripts/deploy.sh` still
   reaches into the rfxn-infra Ansible vault for the Cloudflare token, so deploys
   are coupled to an unrelated repo checkout. Move to a dedicated scoped token or
   a wrangler-native login. The token mint is an owner action (see OWNER-GATED);
   the wiring is ours once it exists.
8. **Generalization / region-event packs (#25)** [infra] · the remaining
   non-TX-literal sequence: the NWS alerts URL (`area=TX` in `js/core.js`,
   `scripts/gen-feeds.py` and `scripts/gen-caltopo.py`), the DriveTexas/TxGIO
   road and crossing layers, the city camera networks, the coastal tide-station
   seed, and the LSR flood-in-AO bbox test. Sequenced after the owner's naming
   decision (see OWNER-GATED), with the event-config brand hook, `aoPresets` and
   `captureBbox` as groundwork already in `data/event.json`.
9. **Trust/governance content** [content] · the repo half landed 2026-07-26
   (`ABOUT.md` who-runs-this and methodology, the privacy statement, and a
   `LICENSE` file). What is left is the in-app surface: an about/methodology view
   reachable from the board itself rather than only from GitHub, a terms page, and
   a documented browser floor (Chrome/WebView 80+, iOS 13.4+ per compat-3). With
   push alerts shipped and a public mirror carrying life-safety framing,
   provenance now matters more than another layer.
10. **Team Phase-2 SAR** [field] · the remaining team build-queue item.
    Breadcrumb store-and-forward already landed (v0.97.73), and v0.98.6 moved
    Team off the default tab bar, so the surface is opt-in before this is built.

### OWNER-GATED (explicit owner decision required; do NOT auto-build)

Each of these is a decision, not a dependency. Nothing below is blocked on
engineering.

- **Rebrand / product name + domain.** Decide the de-Texas-ify / all-hazard name
  and the domain that goes with it. #25's non-TX literals sequence after it; the
  `data/event.json` brand hook is already wired and waiting for a value.
- **Mint a scoped Cloudflare Pages token.** Decide whether deploys get a
  dedicated token scoped to this project, or a wrangler-native login. Until one
  exists, `scripts/deploy.sh` derives the token from the rfxn-infra Ansible
  vault, which couples every deploy to an unrelated repo checkout.
- **Cloudflare zone cache rule.** Decide whether to narrow or remove the
  zone-level `max-age=14400` rule on respondertx.org. It overrides the repo
  `_headers` file, which works correctly on pages.dev. Already known to affect
  `/sw.js` (compat-2); now confirmed to affect **stripped** assets too: with the
  rule in place a request for `/js/notes.js` still returns HTTP 200 from the edge
  after v0.98.5 removed the file, while a cache-busted request for the same path
  correctly returns 404. `deploy.sh` asserts absence with a cache-busting query
  string, so the deploy gate cannot see this. Zone configuration, not repo code.
- **Public risk-check surfacing.** Decide whether "Am I at risk?" appears on the
  public mirror. It is hidden behind `?risk=1` by explicit owner directive
  (`js/boot.js` `riskEnabled`); surfacing it during active events, or adding a
  persistent long-press hint, is the owner's call (prod-7).
- **CalTopo Teams subscription.** Decide whether to buy the subscription that
  live sync requires. Export plus import URL plus QR ship today (v0.97.78);
  account-gated live sync is the stretch and cannot be reached without it.
- **Divergence indicator** [views] · forecast-vs-observed divergence cue on
  gauges; the design itself is the owner call.
- **Team C SOS** and **compass on-device sign** · owner-gated per the Bertha
  release wave; do not auto-advance.

### LATER (post-event or gated)

19. **All-hazard remainder: severe/tornado + wildfire** · the tropical/coastal
    half shipped v0.97.47–53; the remainder is cheap for warnings (extend
    `HAZARD_ALERT_RE` + styling) while wildfire needs perimeter data. Follows
    generalization (#25).
20. **T5 evacuation zones** — data-gated; mirror authoritative status, never
    invent an order.
21. **Camera-imagery retention** · gated on storage, not on code. There is no
    archive of camera imagery of any kind: `scripts/gen-cameras.py` builds an
    inventory and says so in its own attribution strings ("imagery not
    recorded"), and nothing writes a frame anywhere. Capturing every camera in
    the inventory at the cycle cadence is an object-store problem, not a repo
    one, so any retention needs an external bucket, a curated subset rather than
    the whole inventory, and a retention window decided up front. Until then the
    honest statement is that camera imagery is live-only and unrecoverable once
    it scrolls off.
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
