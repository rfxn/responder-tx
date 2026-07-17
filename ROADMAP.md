# Responder TX — MASTER ROADMAP (draft, 2026-07-17)

Consolidates: owner directives 1–6, UX-audit remainder, OSS borrow-list,
data-integration specs, live-resource additions, post-research backlog.
Supersedes those sections once integrated. Volatile status lives in
CHANGELOG/HANDOFF, not here.

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

1. **Aging everywhere (directive 1):** every new layer/feature ships with a
   default timeout, auto-suppression off map/panes, and a retrievable persisted
   history view. No exceptions — shelters, crossings, HWMs, notes, chips, all
   of it. Suppress ≠ delete.
2. **Reframe vocabulary (directive 5):** no "request", no manual
   acknowledge/status anywhere new. Items are alerts; lifecycle is
   active → aging → resolved(history), driven by the curator or the clock.
3. **Public mirror hygiene (directive 3):** zero chat vestige on
   responder.rfxn.com — no FAB, no panel, no chat.js, no outbox fetch. Build a
   deploy-time strip and verify with a grep of the deployed archive each cycle.
4. Existing invariants hold: 911 disclaimer, source citations, wall-clock
   timestamps, PII rules, USNG accuracy, copyText fallback, screenshot check.

---

## (b) Ranked tracks — NOW / NEXT / LATER

Agent tracks: **[data]** data-layers · **[views]** views · **[ux]** UX-polish ·
**[infra]** infra. Cost S/M/L. Ranked top-down within each horizon.

### NOW (this and the next few 15-min cycles)

1. **Reframe completion sweep — "Feed", alerts-not-requests** — the board's
   mental model matches how the owner actually uses it: read, drive, done. Cost
   M. Deps: none (in flight). **[ux]** — owns index.html + app.js this window.
   Full downstream enumeration in §Reframe implications below; the sweep is not
   done until every bullet there is resolved and a repo-wide grep for
   request/acknowledge/status vocabulary is clean.
2. **Public-mirror chat strip (deploy-time)** — directive 3 compliance; a
   public page with a dead chat button is worse than none. Cost S. Deps: none.
   **[infra]** — touches deploy recipe + a build exclusion list, not app code.
3. **Module split of js/app.js** (layers / feed / views / exports / ui) — the
   single-file monolith is the #1 blocker to parallel agent development
   (directive 6); every track currently collides on app.js. Cost M. Deps: none;
   do before fan-out widens. **[infra]** (one agent, exclusive app.js lock).
4. **UX-audit remainder** — #10 GPS-wait chip SHIPPED v0.51.0 (pulsing map
   chip + locate-button state + 20s timeout); #14 threat-strip chip cap
   OBSOLETE (v0.44 rework replaced the chip model). #11 light-theme
   sunlight contrast SHIPPED v0.52.0 — batch complete.
5. ~~**#9 Dead-tap alert cards**~~ — DONE (verified in code 7/17 12:15: geometry
   → zoneGeomCache → window.open fallback in renderAlertList; never a dead tap).
6. ~~**RFC forecast-max layer**~~ — DONE pre-v0.44 (fetchFcstMax + fcstMax
   layer live in app.js; shipped v0.34 as forecast-crest rings).
7. ~~**Leaflet.markercluster (vendored)**~~ — DONE (vendored in js/vendor/,
   used by USGS layer).
8. ~~**Saved AO quick-jump presets**~~ — DONE v0.43 (AO chips: Full AO, Kerr,
   Uvalde/Frio, Sonora/Ozona, Cibolo).
9. **#15 MRMS legend color-scale strip + radar dim on overlayadd** — rainfall
   layers shipped without a scale are unreadable in the field. Cost M. Deps:
   none. **[ux]**.
10. ~~**#17 Editable #f-latlon + scroll-map-into-view on form open**~~ — SHIPPED
    v0.49.0 (typed "lat, lon" parses/validates/pins + map pans; phones scroll
    the map into view when intake opens).

### Community/social track addendum (2026-07-17 11:45 owner directive)

Owner directive: iterate for first responders, community, social, communication,
shareability. In flight: v0.44.0 command-area rework (threat module + tabs +
brand rename "Responder TX" + slimmer header) and v0.45.0 **Field Notes** flyout
(map markers + per-note comment threads + general comments, ?note= deep links,
LAN-write / public-read via data/notes.json). Follow-on items, ranked:

- **N1. Notes curation flow** — cycle protocol step: promote notes-inbox.jsonl
  lines into published data/notes.json (curated, cited where possible) so the
  public mirror sees community notes. Cost S. **[data]**
- **N2. Confirm/“seen it” tally on notes** — lightweight corroboration count
  (tap ✓), stored like note comments; surfaces trust without login. Cost S.
  **[views]**
- **N3. Share cards** — per-note/per-card "copy link" + Web Share API on
  mobile; OG meta for link unfurls. Cost S/M. **[ux]**
- **N4. Notes filter chips** — hazard/road/water/info category filter in the
  flyout; map layer toggle for note markers. Cost S. **[views]**
- **N5. Photo attachment (LAN-only v1)** — compose accepts an image, server
  stores under data/notes-media/, published only after curation. Cost M.
  **[infra]**

### NEXT addendum (2026-07-17 11:00)

- **Future-cast radar source hunt** — RainViewer's free API dropped nowcast
  (docs now list past-2h only; empty array confirmed repeatedly). Candidates:
  RainViewer keyed tier, Open-Meteo 15-min precip forecast (grid → canvas
  overlay), NWS HRRR sub-hourly reflectivity via mapservices (verify token
  policy). Research-agent task before implementing. **[data]**

### NEXT (today/tomorrow horizon)

11. **USGS IV gauge fallback layer** — 5-min data, extra gauges, health-degrade
    fallback when NWPS lags/429s (already observed live). bBox query, neutral
    markers (raw stage has NO flood-stage context — never fake a category), off
    by default, dedupe vs NWPS within 0.3 mi. Cost M. Deps: #7 markercluster.
    **[data]**.
12. **FEMA NSS open-shelters poller** — no CORS → 15-min server-side cron
    writes data/shelters-live.json; lowercase field names, geometry.x/y for
    null lat/lon; merge live-over-curated by normalized name;
    absence-tolerant fetch. Live shelter status is a top field question in
    recovery phase. Cost M. Deps: none (server-side, no app.js contention).
    **[data]**.
13. **Low-water crossing inventory** (ctxfloods data model: id, name, latlng,
    status open/closed/caution/longterm, reason, updated_at + append-only
    history) — curator-maintained data file, NOT operator tap-to-cycle
    (reframe: status changes are curator data updates); owner reports via
    intake/chat. The operational currency of flood SAR. Cost M. Deps: reframe
    (item 1) for lifecycle wording. **[data]**.
14. **Speakable short IDs (R-014) on feed items + LSRs** — radio-friendly
    references ("responder, flag R-014") since the owner can't tap-manage;
    curator resolves by ID from chat. Replaces the old "status pin colors" half
    of this item (statuses are gone). Cost S. Deps: reframe. **[ux]**.
15. **Inundation 5-day-max polygons** — where water WILL be; the layer the
    board still lacks. Mandatory params maxAllowableOffset=0.002 &
    geometryPrecision=4 (server 500s without); 1.96MB → lazy-load on
    overlayadd, hourly, EXPERIMENTAL/NWM caveat in popup. Cost M. Deps: none.
    **[data]**.
16. **leaflet.offline tile pre-cache** — offline AO tiles via IndexedDB, no
    service worker needed; dead zones are routine in the Hill Country. Point at
    CARTO (not OSM bulk policy). Cost M. Deps: #3 module split helpful.
    **[infra]**.
17. **Radar/rain time scrubber** — IEM timestamped archive, last 1–2h loop;
    "is it building or collapsing" at a glance. Cost M. Deps: none. **[views]**.
18. **Leaflet.PolylineMeasure (vendored)** — distance + bearings for radio
    relay. Cost S. Deps: none. **[views]**.
19. **Watchlist star (per-item follow)** — local-only pin-to-top of feed items;
    the surviving half of the old "follow + note log" (notes move curator-side
    under the reframe). Cost S. Deps: reframe. **[ux]**.
20. **Verified live-resource adds** — CrowdSourceRescue activation, iSTAT,
    DriveTexas closures note, SARiverFlood HALT, BEXARflood, vetted relief
    funds; UNVERIFIED items (VOST TX, event Zello, 2026 Broadcastify IDs) only
    with a check or an "availability varies" flag. Cost S. Deps: none —
    data-file only. **[data]** (resources.json owner).

### LATER (post-event or gated)

21. **CoCoRaHS daily precip reports** (S, [data]) — JSON-with-html-content-type
    parse gotcha.
22. **OpenFEMA declarations chip** (S, [data]) — IA/PA per county drives
    recovery resources; pairs with Recovery view (#V3).
23. **USGS STN HWM hook** (S, [data]) — no 2026 TX event exists yet; ship only
    the event.json stnEventId hook + daily Events.json poll; SensorViews is
    dead (404).
24. **usng.js swap-in** (S, [infra]) — only if datum edge cases surface; ours
    is validated ±1 m.
25. **Multi-event config presets** (M, [infra]) — event.json packs
    (bbox/center/query packs); the board outlives this flood.
26. **HTTPS-origin service worker / full offline PWA** (M, [infra]) — now
    partially unlocked by responder.rfxn.com; leaflet.offline (#16) first, SW
    shell second.
27. **Shared multi-operator state** (L, [infra]) — the public mirror + curator
    model has lowered urgency (one writer, many readers); revisit if a second
    operator joins.
28. **X filtered-stream ingest worker → curator triage queue** (L, [infra]) —
    paid API; still never auto-publish.
29. **Partnership-gated:** TxDOT/DriveTexas closures feed (watch HCRS_Edit_AGO
    during the event — CORS * but 0 features on probe), PulsePoint,
    Broadcastify official API, CrowdSource Rescue liaison, LCRA Hydromet
    (email them), what3words key.
30. **leaflet-sidebar-v2 / fullscreen** (S, [views]) — with EOC wall view (#V4).

**Dropped/obsoleted by the reframe:**
- Post-research #15 *alert-fatigue ack tiering* — "ack-required" contradicts
  no-manual-acknowledge. Salvage only the auto-unmute-on-escalation idea as a
  curator-side rule, maybe a local per-item mute later; no ack UI ever.
- *Status pin colors* (half of R-014) — no statuses to color; freshness/severity
  carry the pin encoding.
- *Archive-resolved button* (v0.19) — auto-suppression of curator-resolved
  items replaces manual archive; keep the history pane, retire the button.
- *Guarded status changes* (v0.29 ⚠#2) — the confirm/reopen flow goes away with
  the status buttons; the guard pattern was right, the surface no longer exists.
- Dead ends stay dead (don't re-probe): Waze georss, poweroutage.us, GBRA
  Contrail, TWDB hub, FLASH, TDEM API.

---

## Reframe implications — full downstream enumeration (directive 5)

The sweep (NOW #1) must resolve every line; grep-verify afterward.

1. **Tab + vocabulary:** Requests → **Feed** everywhere: tab label, headers,
   empty-states, buttons, aria-labels, in-app changelog wording, README/
   STRATEGY/ROADMAP prose. Keep `data/requests.json` filename + export `status`
   field for one release as a compat shim, then migrate to `feed.json` with an
   absence-tolerant loader (upgrade-path rule).
2. **Status UI removal:** no mark-resolved / in-progress / reopen buttons on
   cards; lifecycle is curator-written in data. The v0.29 confirm-guard code is
   removed with it.
3. **Lifecycle model:** `active → aging (auto, timeout) → resolved (curator) →
   history`. Curator-resolved items auto-suppress to the history layer
   immediately (with the resolution note); aged items suppress at timeout as
   today. History stays retrievable (aged toggle + history panes).
4. **Filters:** status filter (open/in-progress/resolved) → lifecycle filter
   (active / aging / history). Smart sort (urgency × freshness), NEW chips,
   type/county/age/distance/text filters all survive unchanged.
5. **Threat strip:** "critical life-safety requests" chip → "critical alerts";
   all counts include ACTIVE items only (aging + resolved excluded — verify the
   counting path post-sweep).
6. **SITREP:** "top open criticals" → "active critical alerts"; drop any
   request/status phrasing; resolved-this-shift line becomes
   "resolved since last SITREP (curator)"; RECOVERY line unchanged.
7. **Intake form role:** it is now a **field report** submission (LAN-only) —
   input to the curator, not a direct feed publisher. Submitted reports appear
   as `unverified` alerts pending curator confirmation, or route via chat.
   Wording, button labels, and the "verify" affordances change accordingly.
   Public mirror keeps zero intake (already true).
8. **Duplicate guard:** "same-type open request within 3 mi" → "same-type
   ACTIVE alert within 3 mi"; also becomes a curator-side check on data
   updates, since the curator is now the main writer.
9. **Exports:** JSON export field `status` maps to lifecycle (compat note in
   README); import merge "newest status wins" → "newest lifecycle wins,
   curator-resolved is terminal"; GeoJSON properties renamed alert/lifecycle;
   AAR "by status" statistics → "by lifecycle/type"; exports must still include
   full history (aging invariant).
10. **Stale re-verify badge:** stays, but it is a **curator cue** (re-verify
    the intel) not an owner action prompt; wording adjusts.
11. **STRATEGY.md §4 + §6 rewrite:** the Monitor/Triage/Liaison
    status-advancing workflow becomes the **curator model** — Claude session
    curates, verifies, resolves via data updates; liaison-to-911 rule
    unchanged.
12. **Docs + action feed:** README field-workflow section, in-app changelog
    entry announcing the reframe, chat action-feed entries use alert
    vocabulary.
13. **Aging interplay:** default timeouts per alert class stay; curator can
    extend/refresh a timeout by updating the item (touching `updated_at`
    restarts the clock) — that IS the "still active" signal now.

---

## (c) Views — proposed new views (build under [views])

The board has one map+tabs view. These are distinct *lenses* over the same
data; after the module split each is a separate JS file (parallel-safe).

- **V1. Drive Mode (glance view)** — `?view=drive`. One-thumb, huge type,
  GPS-anchored: nearest active threats (crossings, emergencies, MAJOR gauges)
  as a ranked list with distance + bearing, auto-refreshing, no map pan needed.
  Optionally speech-synthesis on new critical within N mi. *Highest value:*
  this is literally the owner's context (phone, truck, glare). Cost M.
- **V2. Basin Focus** — `?view=basin=guadalupe`. Single-river corridor:
  gauges ordered upstream→downstream with observed/forecast category strip,
  the crest wave visualized as it moves down-basin, alerts + feed items
  filtered to the basin. Answers "when does the wave reach me". Cost M
  (needs a small basin→lid ordering table in event.json). 
- **V3. Recovery Dashboard** — `?view=recovery`. Falling in-flood gauges,
  reopened roads/crossings, shelter status, boil-water/utility cards,
  declarations chip (item 22), scam-watch links. The event is entering this
  phase now; recovery posture currently hides inside SITREP lines. Cost M.
- **V4. EOC Wall** — `?view=wall`. Full-screen auto-rotating panels (map w/
  threat extent → feed criticals → forecast list), big type, no interaction,
  print-stylesheet tokens reused, fullscreen plugin (item 30). Cost S/M.
- **V5. Timeline / Replay** — `?view=timeline`. Scrub the event: radar archive
  (item 17) + alert/feed history layers on one time axis; doubles as the AAR
  review tool and directly exploits the everything-is-history aging
  architecture. Cost L — build last, after V1–V3 prove the view framework.

Recommended order: V1 → V3 → V2 → V4 → V5. V1/V2/V3 first — field value now;
V4/V5 serve the room and the after-action.

---

## (d) Parallelization map (directive 6)

**Precondition:** NOW #3 module split. Until it lands, js/app.js is a single
mutex — exactly one agent may hold it per cycle; everything else must be
data-file, server-side, css, or docs work.

Concurrent-safe lanes (disjoint files):

| Lane | Agent track | Files owned | Items |
|---|---|---|---|
| A | [ux] | index.html, js/feed.js*, css | Reframe sweep (#1), UX batch (#4, #5, #9, #10 audit items), #14 speakable IDs, #19 watchlist |
| B | [data] client | js/layers-*.js*, vendored libs | RFC forecast-max (#6), markercluster (#7), USGS IV (#11), inundation (#15), scrubber (#17) |
| C | [data] server | server.py/cron, data/shelters-live.json, data/resources.json, data/crossings.json | Shelters poller (#12), crossings inventory (#13), resource adds (#20) |
| D | [infra] | deploy recipe, pkg/build scripts, sw/offline | Chat strip (#2), leaflet.offline (#16), HTTPS SW (#26) |
| E | [views] | js/views/*.js* (new files) | AO presets (#8), V1–V5, PolylineMeasure (#18) |
| F | docs | README/STRATEGY/CHANGELOG*, data/changelog.json | Reframe doc rewrite (implications #11–12) |

(* = post-split filenames; before the split, lanes A/B/E collapse into one.)

Shared-file ownership rules (per global dispatch conventions): CHANGELOG.md,
data/changelog.json, and chat-outbox.json have exactly ONE owner per cycle —
the cycle controller writes them, agents report entries in their results.
index.html tab scaffolding: lane A owns it; lanes B/E request hook points via
the controller rather than editing directly. Verify no two dispatched lanes
list the same file before fan-out.

Suggested first parallel wave (one 15-min cycle, post-split):
A = reframe sweep · B = RFC forecast-max + markercluster · C = shelters
poller · D = public chat strip. Second wave: A = UX batch · B = USGS IV ·
C = crossings · E = Drive Mode (V1).
