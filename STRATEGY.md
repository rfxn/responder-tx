# Responder TX — Social-Signal & Data Strategy

Event: Texas Hill Country severe flooding, July 2026 (Kerr, Uvalde, Blanco,
Gillespie, Kendall + downstream basins). This document is the operating strategy
behind the ops board in `index.html`.

## 1. Objective

Build and maintain a single live operating picture that fuses:

1. **Authoritative hazard data** (automated, no keys): NWS alerts, NOAA/NWPS
   river gauges with flood categories, USGS stage/flow.
2. **Community assistance signals** (human-in-the-loop): requests for rescue,
   evacuation help, shelter, supplies, animal rescue, wellness checks — surfaced
   from X, Facebook groups, Nextdoor, news live blogs, and field reports.
3. **Response resources**: open shelters, hotlines, road status, vetted
   volunteer intake.

Non-goal: this is **not** a dispatch system. Life-safety traffic is relayed to
911/EOC immediately; the board tracks everything else and provides context.

## 2. Signal source tiers

| Tier | Source | Trust | Ingestion |
|------|--------|-------|-----------|
| 0 | NWS alerts, NOAA NWPS gauges + forecasts, NEXRAD radar (IEM), USGS IV | Authoritative | Automated, 3–5 min poll |
| 0.5 | IEM Local Storm Reports (trained spotters, fire/EMS, officials) | Authoritative ground truth | Automated, flood-filtered, road mentions highlighted |
| 1 | County OEM / city / sheriff official pages (X, Facebook); county scanner audio (Broadcastify) | Official | Manual sweep via Monitor tab deep links; scanner monitoring per shift |
| 2 | News live blogs (Tribune, KUT, KXAN, TPR) | High, lagged | Manual sweep; seed entries cite these |
| 3 | Public X live searches, Facebook group/post searches, Nextdoor searches; CrowdSource Rescue tickets; Zello nets | Unverified | Manual triage → intake form → `unverified` status |
| 4 | Direct field reports / callbacks | Variable | Intake form, `field` source |

**Scanner monitoring**: assign one operator per shift to the relevant county
Broadcastify feed (Comms section). Card anything actionable heard on
dispatch as `field` source with "scanner" in the handle — treat as
unverified until corroborated; scanner traffic is raw and often revised
minutes later.

## 3. Why manual triage instead of direct API ingestion (and the upgrade path)

- **X/Twitter**: search/filtered-stream APIs are paid tiers with app review;
  no credentials in this environment. *Upgrade path*: X API v2 filtered stream
  with rules per county keyword pack (§5), feeding the same request schema via
  a small ingest worker that queues candidates for human triage — never
  auto-publish.
- **Facebook Groups**: the Graph API does not expose public group content
  without the app being installed by a group admin; CrowdTangle is retired.
  *Upgrade path*: Meta Content Library (research access) or per-group admin
  partnership; otherwise sweep via the Monitor tab's post-search deep links.
- **Nextdoor**: no public read API; agency posting is available to verified
  public agencies. *Upgrade path*: partner county OEMs post/collect via
  Nextdoor for Public Agencies; volunteers with accounts sweep the search
  links.

Manual triage is not a stopgap weakness: in the July 2025 event, false or stale
rescue posts recirculated for days. A human gate with a verification step is
the feature, not the compromise.

## 4. Operating workflow (per shift)

Roles (can be one person on a small team, rotate hourly):

- **Monitor** — sweeps Monitor-tab links every 15–30 min per county cluster;
  drops candidate posts into the board via the intake form (status
  `unverified`, source URL pasted).
- **Triage/verify** — deduplicates against existing cards; verifies via
  callback number, cross-reference with official channels, or geolocation
  sanity check against the gauge/alert layers (a "water rising" post inside a
  major-flood polygon is credible; one far outside is suspect). Promotes to
  `open`, or resolves as duplicate/false.
- **Liaison** — relays life-safety items to 911/county EOC *immediately at
  intake, before verification completes*; tracks the outcome, advances status
  to `in-progress`/`resolved`.

Board hygiene: everything actionable gets a map pin; resolved cards stay on
the board (struck through) for the shift log; export JSON at shift change and
hand off (import merges by id, newest status wins).

## 5. Search query pack (Monitor tab encodes these)

Pattern: `(<place names>) AND (<need terms>)`, X searches with `f=live`.

- Need terms: `rescue OR trapped OR "need help" OR stranded OR evacuate OR
  "water rising" OR "send boat" OR "can't get out"`
- Offer terms (volunteer capacity): `volunteers OR "high water vehicle" OR
  boat OR chainsaw OR "supplies drop"`
- Place packs: Kerr (Kerrville, Hunt, Ingram, Center Point, Comfort), Uvalde
  (Uvalde, Knippa, Sabinal, Concan), Pedernales (Fredericksburg, Stonewall,
  Johnson City), plus `#TexasFlood #HillCountryFlood`.

Refresh the place packs as the flood wave moves downstream (Nueces/Frio/
Guadalupe below the Hill Country — add Camp Wood, Barksdale, Leakey, New
Braunfels, Seguin as gauges trend up).

## 6. Verification & triage rubric

Priority at intake:

- **critical** — life safety now (trapped, rising water, medical): relay to
  911/EOC immediately, then card it.
- **high** — imminent need (evacuation assistance, welfare check in warned
  polygon, shelter placement).
- **medium** — supplies, equipment, staging, non-urgent moves.
- **low** — animals (unless owner trapped), property, information.

Verification checklist before tasking volunteers: (1) direct contact or
callback with the requester, or corroboration from an official channel;
(2) location pinned and consistent with hazard layers; (3) timestamp fresh —
anything older than ~6h in a flash-flood context is re-verified; (4) duplicate
check against the board.

## 7. Data ethics & safety

- Post publicly visible information only; strip exact street addresses from
  public exports unless the requester posted them for help.
- No minors' identifying details on cards; reference "family of 4" style.
- Resolved rescue cards keep no phone numbers on export.
- Never instruct self-deployment into warned polygons; volunteer offers route
  to vetted org intake (Team Rubicon, Red Cross) listed in Resources.
- The 911 disclaimer stays pinned in the UI at all times.

## 8. Automated layers (implemented)

| Layer | Endpoint | Cadence |
|-------|----------|---------|
| Flood alerts + emergencies | `api.weather.gov/alerts/active?area=TX` (flood events; FF Emergency detected via `flashFloodDamageThreat: CATASTROPHIC` / description) | 3 min |
| Gauge flood status | `api.water.noaa.gov/nwps/v1/gauges?bbox…` (`floodCategory` per gauge) | 3 min |
| Stage history + flood stages | `…/gauges/{lid}` + `…/gauges/{lid}/stageflow/observed` (48h sparkline vs action/minor/moderate/major stages) | on gauge click |

All three are keyless, CORS-open federal APIs — the map stays live from any
static host with zero backend.

## 9. Event lessons (running log — feed the AAR)

- **Forecast beats observation for pre-positioning.** Every MAJOR crest this
  event (Johnson City, Bandera, Sabinal, Sutherland Springs, Spring Branch)
  appeared in the NWPS forecast field hours before the water arrived. The
  "Forecast to flood" list is the board's highest-value pane.
- **Timestamps rot silently.** Two cycles shipped future-dated cards from
  news summaries with ambiguous day references; the recency chips ("in 9h")
  exposed both. Rule: stamp cards from the wall clock, never from prose.
- **Corrections are cards too.** The Schertz evacuation was lifted hours
  before the card citing it shipped — always check whether "current"
  reporting is already stale before carding it.
- **2025 lessons visibly worked**: sirens + proactive campground evacuations
  cleared 80+ people ahead of the crest; scanner traffic and LSRs confirmed
  it long before press coverage.
- **The scam wave starts before the water recedes** — fraud watch belongs in
  the monitor rotation from day one, not the recovery phase.

## 10. Scale-out roadmap

1. **Shared state**: replace localStorage with a small sync backend (or a
   shared GitHub repo / CRDT doc) so multiple operators see one board;
   export/import merge is the interim mechanism.
2. **Ingest workers**: X filtered-stream worker feeding a triage queue (§3).
3. **Geocoding assist**: Nominatim lookup on the intake form's place field.
4. **Downstream expansion**: parameterize `CONFIG.gaugeBbox` per event; the
   rest of the board is event-agnostic.
5. **After-action**: exported JSON snapshots per shift are the event log for
   the AAR.
