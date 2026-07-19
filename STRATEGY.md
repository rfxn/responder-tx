# Responder TX — Data & Operating Strategy

Event: Texas Hill Country severe flooding, July 2026 (Kerr, Uvalde, Blanco,
Gillespie, Kendall + downstream basins). This document is the operating strategy
behind the ops board in `index.html`. It has matured from an early social-signal
aggregator into a **production-grade single-event flood operating picture**; the
delivered capability arc lives in `CHANGELOG.md` (v0.1.0 → v0.96.5) and the
forward direction in `ROADMAP.md`.

## 1. Objective

Maintain a single live operating picture that fuses:

1. **Authoritative hazard data** (automated, keyless): NWS flood alerts with
   flash-flood-emergency detection, NOAA/NWPS river gauges with flood categories
   and forecasts, USGS stage/flow, NEXRAD + HRRR radar, MRMS rainfall, NWM
   inundation, and live TDEM/TxDOT road-hazard and camera feeds.
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
| 0 | NWS alerts, NOAA NWPS gauges + forecasts, NEXRAD/HRRR radar (IEM), MRMS, NWM inundation, USGS IV, TDEM DriveTexas roads, TxGIO crossings, TxDOT/USGS cameras | Authoritative | Automated, 3–5 min poll (keyless, CORS-open) |
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
| Flood alerts + emergencies | api.weather.gov (flood events; FFE via damage-threat/description) | AO-vs-elsewhere fold; polygons; 7-day expired history |
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
construction. The forward strategy (detailed in `ROADMAP.md`) is the path from a
mature single-event *instrument* to a **generally available product**, along
three axes:

1. **Trustworthy / productionized** — automated tests + CI on the honesty-
   critical logic; a durable scheduled data pipeline that runs independent of an
   interactive curator session; visible degraded-source states; defense-in-depth
   hardening; and trust/governance content (methodology & accuracy, privacy,
   about).
2. **Generalized** — parameterize the remaining single-event hardcoding into
   region-agnostic config packs (ROADMAP #25) and prove the board on a region
   beyond the Hill Country. The hydrology core (NWPS gauges + NWS alerts) is
   already national and keyless. The owner's direction is **all-hazard over
   time** (floods now; storms/tornadoes later) — the board's machinery is largely
   hazard-agnostic. The board keeps its current "Responder TX" identity; any
   generalized brand/name is a pending owner decision and is out of scope here.
3. **Reliably updatable + deliverable** — a service worker with a real update
   strategy first (also fixes offline cold-boot), then safe re-installability, and
   then web-push threshold alerts. Notification *delivery* is the one universal
   table stake the board still lacks and the highest-value fast-follow once the
   service worker exists.

Throughout, the standing invariants hold: honesty over vanity, aging everywhere,
model never reads as observed, stale never masquerades as live, source citations
and the 911 disclaimer immutable, and the public mirror carries zero write
surface.
