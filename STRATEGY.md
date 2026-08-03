# ResponderTX · Data & Operating Strategy

Area of operations: Texas statewide, with standing regional presets for the
basins and metros in play. The board began on the July 2026 Hill Country flood
(Kerr, Uvalde, Blanco, Gillespie, Kendall + downstream basins), covered the TS
Bertha coastal pivot, and now runs as a standing instrument rather than a
single-event page. This document is the operating strategy behind the ops board
in `index.html`. It has matured from an early social-signal aggregator into a
**production-grade multi-hazard flood operating picture**; the delivered
capability arc lives in `CHANGELOG.md` and the forward direction in `ROADMAP.md`.

## 1. Objective

Maintain a single live operating picture that fuses:

1. **Authoritative hazard data** (automated, keyless): NWS warnings across the
   warned hazards, from flash flood to tornado, with emergency detection;
   NOAA/NWPS river gauges with flood categories and forecasts; USGS stage/flow;
   NEXRAD + HRRR radar; MRMS rainfall; NWM inundation; tropical track and surge;
   wildfire incidents and perimeters; and live TDEM/TxDOT road-hazard and camera
   feeds.
2. **A curated life-safety feed** (human-in-the-loop): notices for rescue,
   evacuation, cut-off areas, shelter, road status, and welfare context —
   verified and maintained by the board curator, cited to a source, and aged on a
   clock so nothing stale masquerades as live.
3. **Response resources**: open shelters, hotlines, road/crossing status, vetted
   volunteer intake, and recovery portals.

Non-goal: this is **not** a dispatch system. Life-safety traffic is relayed to
911/EOC immediately; the board tracks everything else and provides context. The
public mirror is read-only.

## 2. The reframe — notices, not requests (delivered v0.33.0)

The board no longer models "requests" with manual status management. Every
curated item is an **alert/notice** with a single lifecycle:

`active → aging (auto, on a per-type timeout) → resolved (curator) → history`

There is no operator "mark resolved / in-progress / reopen" chore and no status
filter. The **curator** (the ops session) resolves items by writing data updates;
curator-resolved and aged items auto-suppress into a retrievable history layer
(suppress ≠ delete). A repo-wide grep for request/acknowledge/status vocabulary
is kept clean (sweep completed v0.36.0). Filters are lifecycle-based
(active / aging / history), and smart sort (urgency × freshness) orders the feed.

## 3. Signal source tiers

| Tier | Source | Trust | Ingestion |
|------|--------|-------|-----------|
| 0 | NWS alerts, NOAA NWPS gauges + forecasts, NHC tropical + SLOSH surge, CO-OPS tides, NEXRAD/HRRR radar (IEM), MRMS, NWM inundation, USGS IV, TDEM DriveTexas roads, TxGIO crossings, city/county/port/border/coastal camera networks | Authoritative | Automated, 3–5 min poll (keyless and CORS-open, or same-origin proxied for camera stills) |
| 0.5 | IEM Local Storm Reports (trained spotters, fire/EMS, officials) | Authoritative ground truth | Automated, flood-filtered, road mentions highlighted, aged |
| 1 | County OEM / city / sheriff official pages; county scanner audio | Official | Manual sweep; curated into cited notices |
| 2 | News live blogs (Tribune, KUT, KXAN, TPR) | High, lagged | Manual sweep; curated notices cite these |
| 3 | Public social searches; CrowdSource Rescue tickets; Zello nets | Unverified | Manual triage → curated as `unverified` pending confirmation |
| 4 | Direct field reports / callbacks (LAN-only Field Notes) | Variable | LAN intake / field capture, curator-verified before it reaches the mirror |

Tier-0 automated layers are keyless, CORS-open federal/state APIs — the map stays
live from any static host with zero backend. Higher tiers are curator-gated: raw
posts never publish to the mirror without a verification step.

## 4. Why curated verification instead of direct auto-ingestion

Manual, human-gated verification is a **feature, not a stopgap**: in the July 2025
event, false or stale rescue posts recirculated for days. A verification step
before anything reaches the public mirror is the honesty guarantee.

Direct API ingestion of social platforms is also constrained: X/Twitter
search/filtered-stream is a paid, app-reviewed tier; Facebook Groups have no
public content API (CrowdTangle retired); Nextdoor has no public read API.
Upgrade paths exist (X filtered-stream worker feeding a triage queue; Meta
Content Library or per-group admin partnership; Nextdoor for Public Agencies) but
they feed the same **curator triage queue — never auto-publish** (see ROADMAP
#28, anti-backlog).

## 5. Operating workflow — the curator model

The board is maintained by a curator loop (the ops session), not a multi-role
shift board. Per cycle the curator:

- **Sweeps** authoritative layers and Tier 1–3 links; the board already fuses the
  Tier-0 feeds automatically, so attention goes to what the machine cannot verify.
- **Curates** candidate signals into cited notices, deduplicated against existing
  items (a same-type active alert within ~3 mi is flagged), geolocation-sanity-
  checked against the hazard layers (a "water rising" post inside a major-flood
  polygon is credible; one far outside is suspect).
- **Resolves** via data updates — touching an item's `updated_at` is the "still
  active" signal; resolving auto-suppresses it to history with a resolution note.
- **Relays** life-safety items to 911/county EOC *immediately at intake, before
  verification completes* — this liaison-to-911 rule is unchanged and absolute.

Everything actionable gets a map pin; history stays retrievable (aged toggle +
history panes) and fully exportable (JSON/GeoJSON/AAR include aged/resolved
items). Ops chat and Field Notes intake are **LAN-only** and stripped from the
public mirror artifact at deploy time.

## 6. Search query pack (curator sweep encodes these)

Pattern: `(<place names>) AND (<need terms>)`, live-search where supported.

- Need terms: `rescue OR trapped OR "need help" OR stranded OR evacuate OR
  "water rising" OR "send boat" OR "can't get out"`
- Offer terms (volunteer capacity): `volunteers OR "high water vehicle" OR
  boat OR chainsaw OR "supplies drop"`
- Place packs: Kerr (Kerrville, Hunt, Ingram, Center Point, Comfort), Uvalde
  (Uvalde, Knippa, Sabinal, Concan), Pedernales (Fredericksburg, Stonewall,
  Johnson City), Val Verde/Pecos (Comstock, Langtry, Pandale), plus
  `#TexasFlood #HillCountryFlood`.

Refresh the place packs as the flood wave moves downstream (Nueces/Frio/
Guadalupe below the Hill Country — Camp Wood, Barksdale, Leakey, New Braunfels,
Seguin as gauges trend up).

## 7. Verification & triage rubric

Priority at intake:

- **critical** — life safety now (trapped, rising water, medical): relay to
  911/EOC immediately, then card it.
- **high** — imminent need (evacuation assistance, welfare check in a warned
  polygon, shelter placement).
- **medium** — supplies, equipment, staging, non-urgent moves.
- **low** — animals (unless owner trapped), property, information.

Verification checklist before tasking: (1) direct contact/callback or
corroboration from an official channel; (2) location pinned and consistent with
the hazard layers; (3) timestamp fresh — anything older than ~6h in a flash-flood
context is re-verified; (4) duplicate check against the board.

## 8. Data ethics & safety

- Post publicly visible information only; strip exact street addresses from
  public exports unless the requester posted them for help.
- No minors' identifying details on cards; reference "family of 4" style.
- Resolved rescue cards keep no phone numbers on export.
- The "Am I at risk?" address lookup runs on-device; the typed address leaves the
  browser only for the single geocoder call needed to place the pin (the privacy
  copy states this exactly — honesty applies to our own claims too, v0.96.4).
- Never instruct self-deployment into warned polygons; volunteer offers route to
  vetted org intake (Team Rubicon, Red Cross) listed in Resources.
- The 911 disclaimer stays pinned in the UI at all times.

## 9. Automated layers (implemented)

The board fuses a deep stack of keyless federal/state feeds — deeper single-board
flood-SA layer fusion than any single comparable tool. Cadence is the 3-min cycle
unless noted.

| Layer | Source | Notes |
|-------|--------|-------|
| Hazard alerts + emergencies | api.weather.gov (a fixed event table: flood, tornado, severe thunderstorm, dust storm, snow squall, extreme wind, plus watches and standing conditions such as Fire Weather; FFE and tornado emergencies via damage-threat/description) | AO-vs-elsewhere fold; polygons; ranked across hazard types; 7-day expired history |
| Gauge flood status + forecast | api.water.noaa.gov/nwps (`floodCategory`, forecast) | trend glyphs, stale-sensor suppression, crest-wave + record-watch |
| Stage history + hydrograph | NWPS stageflow (our cached proxy) | 48h sparkline + full modal with crest-of-record line |
| RFC 5-day forecast-max | NWPS/RFC | forecast-crest rings where NWPS lacks the field |
| USGS raw stage (IV) | USGS instantaneous-values | clustered fallback layer; auto-enables when NWPS lags (no fake categories) |
| Radar (observed + HRRR future) | IEM (NEXRAD, HRRR WMS) | unified observed→NOW→+18h model timeline; model never reads as observed |
| Rainfall (MRMS) | IEM q2 accumulation tiles | unified layer, 1/24/48/72h windows, color-ramp legend |
| Flood inundation | maps.water.noaa.gov (NWM AnA extent) | off by default, labelled a MODELED estimate |
| Road hazards | TDEM DriveTexas | live closures/high-water/damage + recently-reopened recovery signal |
| Low-water crossings | TxGIO inventory + curated tracker | inventory is LOCATIONS only (not live status); curated tracker is cited + aged |
| Cameras | TxDOT MapLarge/ITS + USGS HIVIS | live HLS + snapshot, stale badging, auto-linked into gauge popups |
| Storm reports (LSR) | IEM Local Storm Reports | ground-truth diamonds, road-name highlighting, aged to history |
| Tropical track + storm-surge risk | NHC via Esri Living Atlas (tracks, cones, SLOSH) | tracker auto-enables on an active TX tropical warning or watch |
| Coastal water level vs prediction | NOAA CO-OPS | surge residual; coastal events only, stations seeded from `data/event.json` |
| Crossings reported closed | ATX Floods (Central Texas jurisdictions), published by the cycle | only non-open rows publish; a coverage hole never reads as an all-clear |
| Open shelters | FEMA National Shelter System, published by the cycle | status published only where a source states one |
| Wildfire incidents + perimeters | Texas A&M Forest Service + NIFC WFIGS, published by the cycle | per-source status; a fire over 100 acres with no mapped perimeter draws an equal-area circle, styled unlike a real perimeter |
| River Sentry siren sites | a public "River Sentry Towers" Google My Maps, author not identified, published by the cycle | reported locations only, never live siren state |

Provenance is explicit: an OFFICIAL vs CURATED badge marks every ambiguous
signal (v0.81.0). All layers honor the aging/staleness invariants and stay out of
the offline basemap-tile cache (live data is never implied fresh offline).

## 10. Event lessons (running log — feed the AAR)

- **Forecast beats observation for pre-positioning.** Every MAJOR crest this
  event appeared in the NWPS forecast field hours before the water arrived. The
  forecast-first framing (forecast-to-flood list, crest-wave tracker,
  record-watch) is the board's highest-value posture.
- **Timestamps rot silently.** Cards were caught future-dated from ambiguous
  prose; the recency chips exposed them. Rule: stamp from the wall clock, never
  from prose.
- **Corrections are cards too.** Evacuation orders lifted before the citing card
  shipped — always check whether "current" reporting is already stale.
- **2025 lessons visibly worked**: sirens + proactive campground evacuations
  cleared 80+ people ahead of the crest; scanner traffic and LSRs confirmed it
  long before press coverage.
- **The scam wave starts before the water recedes** — fraud watch belongs in the
  rotation from day one, not the recovery phase.

## 11. Strategic direction — from single-event instrument to product

The board is feature-complete against its original backlog and honesty-first by
construction. The forward strategy (detailed in `ROADMAP.md`) was the path from a
mature single-event *instrument* to a **generally available product**, along
three axes. All three have landed. The middle one's remainder was dropped rather
than built, because the naming decision that drove it went the other way.

1. **Trustworthy / productionized** · DELIVERED. Automated tests and CI on the
   honesty-critical logic, a durable system-cron data pipeline that runs
   independent of any interactive curator session, per-source fresh/aging/stale
   detail behind the data-age bar, defense-in-depth hardening, and the trust and
   methodology content in `ABOUT.md`, reachable from the board itself.
2. **Generalized** · the hydrology core (NWPS gauges + NWS alerts) is already
   national and keyless, and the owner's all-hazard direction has landed: severe
   and tornado warnings, tropical track and surge, and wildfire all draw today.
   What remained was a sweep of the surviving Texas literals (ROADMAP #25), and
   that was deprioritised 2026-07-30 when the owner decided the board stays
   **ResponderTX** on respondertx.org. The `data/event.json` event-pack half
   survives on merit: it re-points the board at a new event with no code change.
3. **Reliably updatable + deliverable** · DELIVERED. The app-shell service worker
   with user-controlled updates, the install manifest, and opt-in device alerts
   (flash-flood emergencies, an area-wide gauge tier, and specific gauges a user
   follows, in English or Spanish) all ship today.

Throughout, the standing invariants hold: honesty over vanity, aging everywhere,
model never reads as observed, stale never masquerades as live, source citations
and the 911 disclaimer immutable, and the public mirror carries zero write
surface.
