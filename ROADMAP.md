# Responder TX — Product Roadmap

Owner optics: a SAR team lead or first responder, likely on a phone in a
truck, intermittent connectivity, gloves, sunlight glare. Every feature is
judged by: *does this help someone decide where to go and what to expect in
under 10 seconds?*

## Product assessment (v0.1 baseline, 2026-07-16)

**Strengths**: live federal layers (alerts/gauges) with zero backend; cited
seed feed; human-gated triage; export/import handoff; dark ops theme.

**Gaps from the field:**

1. **Mobile is an afterthought** — 420px sidebar logic, small targets, no
   locate-me, no navigate-to-pin. A responder can't thumb this in a truck.
2. **No recency bias** — a 6h-old card looks identical to a 5-min-old one;
   stale flash-flood intel is dangerous intel.
3. **No anticipation** — NWPS *forecast* categories (already in the API
   response) are unsurfaced; teams should pre-position where MAJOR is
   *forecast*, not react after crest.
4. **No ground truth** — trained-spotter/official Local Storm Reports exist,
   free and CORS-open (IEM), with remarks like "Nueces River overtopping FM
   1025 bridge". Not shown.
5. **No radar** — the single most-checked layer during flash flooding.
6. **No threat-to-life synthesis** — emergencies, rescue requests, major
   gauges are separate lists; nobody fuses them for you at 3am.
7. **Roads/isolation invisible** — impassable crossings and cut-off
   communities are the operational currency of flood SAR; no iconography,
   no overlay, no alternate-route affordance.
8. **Comms blind** — no path to county dispatch/EMS scanner audio (
   Broadcastify feeds exist for all 9 affected counties), Zello nets, or
   community rescue platforms (CrowdSource Rescue).
9. **Degraded-network behavior** — a failed poll blanks nothing today (good)
   but shows no "as of" staleness, and a fresh page load with no signal shows
   an empty board.

## Release plan

### v0.2 — Field usability + recency engine ✅
- Mobile-first layout: map-on-top, sticky tabs, ≥44px touch targets,
  horizontally scrolling stat tiles.
- Freshness everywhere: age-colored dots, `re-verify` badge on stale
  unresolved cards (>6h), `NEW` chip since last visit.
- Sort control: **smart (priority × freshness decay)** default, newest,
  priority.
- Locate-me control + distance filter (10/25/50 mi); time-window filter.
- Per-card **Navigate** (Google Maps) and **Copy coords** actions.
- Last-good-data cache with "as of" stamp for degraded connectivity.

### v0.3 — Anticipation + ground truth layers ✅
- NEXRAD composite reflectivity radar overlay (IEM tiles, 5-min refresh).
- IEM Local Storm Reports: map layer + "Ground truth" list, flood-filtered,
  recency-sorted, road mentions highlighted.
- Gauge forecast surfacing: ▲ rising markers, forecast crest/category in
  popups, "Forecast to flood" pre-positioning list, rising count in tile.

### v0.4 — Threat-to-life operating picture ✅
- **Life-safety board**: fused, ranked view — flash-flood emergencies,
  rescue/evac requests, rescue-flagged LSRs, major + rising-to-major gauges.
- **Road & isolation iconography**: `road-blocked` (🚧) and `cut-off area`
  (⛔ + hatched radius overlay, pulsing) request types; road-name extraction
  (FM/RR/US/SH/I-/CR) from LSR remarks and card text as filter chips.
- Alert severity/county filters; LSR type filter; zoom decluttering.

### v0.5 — Comms, community & interop ✅
- **Comms tab**: Broadcastify live scanner feeds per county (all 9 mapped),
  OpenMHz, Zello SAR nets, CrowdSource Rescue, PulsePoint coverage note.
- **GeoJSON export** alongside JSON — drops straight into CalTopo/SARTopo.
- PWA manifest (add-to-home-screen); docs refresh.

### v0.6+ — Backlog (needs infra or partnerships)
- **Shared state backend** (multi-operator sync; export/import is interim).
- **HTTPS + service worker** → true offline shell + install prompt (SW
  requires a secure context; LAN HTTP won't register one).
- **TxDOT road closures as a live layer** — DriveTexas has no stable public
  API (500s on probe) and `gis.txdot.gov` ArcGIS REST is unreachable
  (probed 7/16); pursue via TxDOT/district data-share or Waze for Cities
  (partner feed). Deep link remains the interim.
- **PulsePoint** — incident feed is encrypted and agency-opt-in; pursue as a
  partnership/data-share, not a scrape. Same posture for Broadcastify's
  official API (auth-gated).
- **X filtered-stream ingest worker** feeding the triage queue (STRATEGY §3).
- ~~USNG/MGRS grid readout on pins~~ — shipped v0.9 (validated vs python
  mgrs, ±1 m on 27 bbox points).
- ~~Geocoding assist on intake (Nominatim)~~ — shipped v0.7. what3words
  display still open (needs API key).
- **CrowdSource Rescue liaison**: mirror open tickets with consent.
- Multi-event support: event config presets (bbox/center/query packs).

## Status after the July 2026 event sprint (v0.2 → v0.24)

All bounded backlog items shipped during the event: mobile-first UX, recency
engine, radar/LSR/forecast layers, threat-to-life strip with road/isolation
iconography, comms + scanner feeds, GeoJSON/AAR/SITREP exports, USNG
(validated ±1 m), geocoded intake with duplicate guard, live seed refresh,
source-health panel, print stylesheet, event-config externalization, archive
workflow, emergency banner, visibility-aware polling. Remaining work is
infra- or partnership-gated (see v0.6+ backlog above) — the top three by
value: **shared multi-operator state**, **HTTPS for true offline PWA**, and
an **X filtered-stream ingest worker** feeding the triage queue.

## UX-audit backlog (2026-07-17 agent audit of v0.27; ⚠ items + declutter shipped v0.28-v0.29)

Remaining, ranked (item numbers from the audit):
- #5 Gauge tap targets: iconSize [32,32] transparent hit area around the dot; hide cat-none gauges on ≤768px (S)
- #9 Dead-tap alert cards: reuse zoneGeomCache for bounds on zone-based warnings, else open alert text link (S/M)
- #10 Distance filter without GPS fix: inline "⌖ waiting for location — showing ALL" chip + reset on locationerror (S)
- #11 Light-theme sunlight contrast: darken --ink-muted→#5d5c56 / --ink-2→#41403c in light; fillOpacity 0.18 for warning+; tinted threat-chip backgrounds (S)
- #14 Threat strip: cap 4 chips + "+N" overflow on phone; move ▼ recovery chip under its own label (S)
- #15 MRMS layers need an in/hr color-scale strip in the legend + dim radar to 0.2 on overlayadd (M)
- #17 Editable #f-latlon (radio-relayed coords) + scroll map into view when form opens (M)

## OSS borrow-list (2026-07-17 mining agent; licenses verified, vendor from GitHub)

1. leaflet.offline (allartk, v3.2.0 2025) — offline tile cache via IndexedDB, NO
   service worker needed = works on LAN http. Pre-cache AO tiles before dead
   zones. Point at CARTO tiles not OSM (bulk-download policy). (M — top value)
2. Leaflet.markercluster (MIT, stable) — needed before USGS-IV's 224 dots land;
   disableClusteringAtZoom for ops zooms (S)
3. leaflet-locatecontrol (MIT, active) — note Chrome gates geolocation on http;
   works in Firefox / chrome flag (S)
4. Leaflet.PolylineMeasure — distance + BEARINGS for radio relay; vendor master (S)
5. usng.js (codice, MIT) — swap-in if our converter needs datum edge cases (S)
6. leaflet-sidebar-v2 (noerw fork), brunob/leaflet.fullscreen — EOC wall-screen
   niceties (S, defer)
7. ctxfloods-backend (cityofaustin, MIT, dead project, data model is the steal):
   crossings as {id,name,latlng,status: open/closed/caution/longterm, reason,
   updated_at, updated_by} + append-only history — use for our crossing layer
8. TAK concept: stale-time on every hand-placed marker (aligns with our aging)

## Data-integration specs (2026-07-17 spec agent; CORRECTED vs first sweep — full fetch sketches in the agent report, gotchas here are load-bearing)

Ranked for this event:
1. USGS IV: bBox (NOT stateCd) = 341KB/224 sites; parameterCd=00065,
   modifiedSince=PT2H; CORS *; dedupe vs NWPS within 0.3mi; neutral markers
   (raw stage has NO flood-stage context — never fake a category); layer off
   by default; needs markercluster first
2. RFC forecast-max: 10KB statewide; issued_time is "YYYY-MM-DD HH:MM:SS UTC"
   (not ISO — parse manually); dedupe lids vs NWPS; hollow-ring markers in
   cat colors; on by default
3. FEMA NSS shelters poller (no CORS): field names NOW LOWERCASE
   (shelter_name); lat/lon often null — use geometry.x/y; 15-min cron →
   data/shelters-live.json {generated, source, shelters[]}; merge = live
   overrides curated on normalized-name match, curated note/source kept;
   absence-tolerant fetch (upgrade path)
4. Inundation 5-day max: server 500s WITHOUT maxAllowableOffset=0.002&
   geometryPrecision=4 (mandatory); 1.96MB → lazy-load on overlayadd, hourly;
   caveat EXPERIMENTAL/NWM in popup; PNG export fallback exists
5. USGS STN HWMs: NO 2026 TX event exists yet — poll Events.json daily, ship
   only the event.json stnEventId hook; SensorViews endpoint is dead (404)

## Live-resource additions (2026-07-17, vetted; add to Monitor/Social + Resources)

Verified: CrowdSourceRescue ACTIVATED (crowdsourcerescue.org/hill-country,
credentialed SAR only); iSTAT damage.tdem.texas.gov (official); DriveTexas
(Hwy 90 Hondo–Del Rio closed, US 57 closed); SARiverFlood.org HALT sensors
(Wilson/Karnes!); BEXARflood.org; Tribune how-to-help aggregator; Hill Country
Flood Relief Fund (CFHC, launched 7/16 for THIS event); rebuildtx.org
summer-2026 fund; uwtexas.org/floodrelief. UNVERIFIED (don't link without
check): VOST TX, event Zello channels, 2026 Broadcastify feeds (2025 IDs may
be dead — flag "availability varies").

## Post-research backlog (2026-07-17 research sweep — endpoints verified by curl, ideas from Watch Duty / TAK / CalTopo / CrisisCleanup / ATX Floods survey)

Shipped this sweep (v0.26.0): aging/suppression timeouts (TAK stale-time
pattern), in-app changelog, ops-session chat with recent-actions feed.

Ordered by value ÷ cost for a solo field responder; all client-side unless noted:

1. **MRMS rainfall accumulation layer** (S) — IEM tiles, one-line add via the
   existing radar pattern: `q2-n1p-900913` (1h) / `q2-p24h-900913` (24h),
   CORS-open. "How much fell where" predicts which crossings go under next.
2. **NOAA forecast-max + inundation polygons** (M) — `maps.water.noaa.gov`
   ArcGIS REST, CORS-safe (reflects Origin): `rfc/rfc_max_forecast` (every
   gauge's 5-day max stage/category — 42 TX hits on probe) and
   `rfc_based_5day_max_inundation_extent` (69 polygons in Hill Country bbox
   on probe). Shows where water WILL be — the layer the board lacks.
3. **USGS instantaneous values fallback** (S) — `waterservices.usgs.gov/nwis/iv`
   CORS `*`, 5-min sensor data, fresher than NWPS and covers extra gauges;
   health-degrade fallback when api.water.noaa.gov lags.
4. **Saved AO quick-jump presets** (S) — Watch Duty pattern: 3-5 pinned
   map extents as one-tap buttons.
5. **Short speakable card IDs (R-014) + status pin colors** (S) —
   CrisisCleanup/CrowdSource Rescue pattern; radio-friendly ticket numbers.
6. **Data-age banner escalation** (S) — amber/red "data as of HH:MM" when
   fetch age grows (CalTopo offline-truth pattern; extends source-health).
7. **CoCoRaHS daily precip + significant-weather reports** (S) —
   `data.cocorahs.org/export/exportreports.aspx` CORS `*` (note: JSON body
   with text/html content-type — parse manually).
8. **OpenFEMA declarations chip** (S) — CORS `*`; IA/PA status per county
   drives what recovery resources exist.
9. **FEMA NSS open-shelters live layer** (M) — `gis.fema.gov` NSS/OpenShelters;
   NO CORS header → cron-poller writes `data/shelters-live.json`.
10. **USGS STN high-water marks / rapid-deployment gauges** (M) — CORS `*`;
    temporary event sensors that never appear in NWPS.
11. **Low-water crossing inventory w/ tap-to-cycle status** (M) — ATX Floods /
    Bexar HALT pattern; static crossing JSON + operator-set open/rising/closed.
12. **Radar time scrubber** (M) — IEM timestamped tile archive, last 1-2h loop.
13. **Per-card follow + append-only note log** (M) — Watch Duty incident-feed
    pattern; notes with relative timestamps, gray-not-delete.
14. **DriveTexas closures** (blocked-ish) — drivetexas.org blocks datacenter
    IPs; `HCRS_Edit_AGO` FeatureServer is CORS `*` but 0 features on probe —
    watch it during this event; TxDOT open-data portal for a real feed.
15. Alert-fatigue tiering (M) — ack-required only for FF emergencies; per-alert
    mute with auto-unmute on escalation (Watch Duty threshold pattern).

Dead ends (verified, don't re-probe): Waze georss (403/partnership),
poweroutage.us (paid API), LCRA Hydromet (apiKey; email them), GBRA Contrail
(unreachable from this host), TWDB hub hosts (DNS), FLASH (token), TDEM (no API).

## Operating cadence

Release cycles run continuously during the event: assess → build → headless
test (phone + desktop viewports) → ship → update CHANGELOG → reassess.
Data-source candidates are validated (CORS, fields, latency) before they
enter a cycle. Nothing ships without a rendered-screenshot check.
