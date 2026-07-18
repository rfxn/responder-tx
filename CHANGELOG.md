# Changelog — Responder TX Flood Ops Board

## v0.76.5 — 2026-07-18 (collapse the map attribution bar to a ⓘ)
- Change: the Leaflet attribution footer was crowding the bottom-left legend and eating scarce space on short/landscape phones (owner report), so it now collapses to a small tap-to-open ⓘ pill instead of a full-width bar; tapping ⓘ expands the complete credits (OpenStreetMap, CARTO, Leaflet, and the TxDOT DriveTexas / TDEM road-data citation) and tapping again collapses it — the credits are preserved (map-provider ToS + our source-citation invariant both require them) but no longer sit persistently over the map; attribution links still open normally when expanded

## v0.76.4 — 2026-07-18 (fix: expanded map legend clipped on short screens)
- Fix: on landscape phones (and when the bottom sheet is expanded) the map legend's expanded state was taller than the short map and got clipped at both ends — the "River gauge status" title above the top and the lower rows below — a regression surfaced by the v0.76.1 Roads section making the legend taller (owner report); the open legend now caps at `calc(100dvh - 120px)` with `overflow-y:auto` (+`overscroll-behavior:contain`) so it scrolls from the title down instead of clipping, and `L.DomEvent.disableScrollPropagation` keeps that scroll from zooming the map; portrait and desktop are unchanged (the cap only bites on short viewports)

## v0.76.3 — 2026-07-18 (Drive Mode uses the live road-closure data)
- New: Drive Mode's big-type nearest-hazard glance list now includes the live TDEM DriveTexas road closures/flooding/damage (owner ask) alongside the existing closed/caution crossings, life-safety/road notices, and major/rising gauges — each closure is ranked by distance using the line vertex NEAREST the driver (midpoint when no GPS), shown with a condition glyph (⛔ closed · 🌊 flooded · ⚠ damage), the prettified route (`FM0481`→`FM 481`), and the condition label; ranked below closed crossings and critical incidents so hard stops still lead the list; the 14-item cap and distance sort keep the ~100-closure AO volume manageable

## v0.76.2 — 2026-07-18 (road layer: exclude construction-driven closures)
- Change: the live TDEM DriveTexas road-hazard query now also excludes construction-driven closures that TxDOT codes as `Closure`/`Damage` rather than `Construction` (owner request — the board is flood-relevant only); added `AND (description IS NULL OR UPPER(description) NOT LIKE '%CONSTRUCTION%')` to the server-side `where` so "roadway closed due to construction" bridge/lane closures no longer render as red closure lines (dropped 4 of 102 AO records this cycle); null-safe so a closure with no description text is still shown rather than hidden

## v0.76.1 — 2026-07-18 (map legend: road-hazard line colors)
- New: the on-map legend now carries a "Roads (DriveTexas)" section keying the three road-hazard line colors added in v0.76.0 — red = Road CLOSED, magenta = Flooded / high water, amber = Road damage — with swatch colors and labels pulled straight from the `ROAD_COND` map so they can never drift from the rendered lines; a field user seeing colored lines on the map now has the key inline

## v0.76.0 — 2026-07-18 (live TDEM DriveTexas road-hazard source + TxGIO low-water-crossing inventory)
- Change: the "Road closures / high water (TxDOT)" layer now pulls from the live TDEM DriveTexas API (`services5.arcgis.com/.../DriveTexas_API/FeatureServer/0`) instead of the TxDOT HCRS_CC FeatureService, which had been frozen since Aug 2020 (0 active flood/closed records) so the layer never actually showed live closures; the new source is keyless, CORS-open (`access-control-allow-origin: *`), returns GeoJSON LineStrings live to the minute, and is filtered server-side to `condition IN ('Flooding','Closure','Damage')` over the AO bbox so routine construction/accidents never clutter the flood board — as of this cycle ~100 live flood-relevant hazard lines render in the AO, including the destroyed Nueces River bridge on FM 481 (a live `Closure`) that the dead layer showed as blank
- Change: remapped every road-condition field to the DriveTexas schema — full-word `condition` values (Closure/Flooding/Damage) replace the single-letter `CNSTRNT_TYPE_CD` codes, `route_name`/`from_limit`/`to_limit`/`description`/`start_time`/`end_time`/`detour_flag` replace the HCRS field names, and the aging predicate now parses the ISO-8601 `end_time` string (keep when missing/unparseable/future, drop only when it parses to a past time) instead of an epoch-ms compare; popups keep the same shape — condition label, `esc()`-escaped route (prettified `FM0481`→`FM 481`), from/to limits, HTML-stripped description, start time in CT, and a "Detour available" line driven by the confirmed numeric `detour_flag` (0/1) — plus the unchanged "verify before routing" honesty footer; attribution updated to "Road conditions: TxDOT DriveTexas / TDEM (drivetexas.org)"
- New: added a "Low-water crossings (locations · not live status)" overlay (OFF by default, lazy-loaded on first toggle, cached after one fetch) sourcing the TxGIO Low_Water_Crossing inventory (`feature.geographic.texas.gov`, keyless, CORS-open) — 3,753 crossing LOCATIONS in the AO fetched in two paginated pages (maxRecordCount 2000) and rendered as small canvas-backed circle markers so the point volume never hangs the map; every popup and the layer label make it unmistakable this is a static LOCATION inventory with NO live open/closed status ("Crossing location inventory (TxGIO) — NOT live flood status; check conditions before crossing.") for life-safety honesty
- Change: the road layer is now a single lines-only fetch (the DriveTexas API has no points layer) keeping `points: []` so the render loop stays safe; both the road layer and the new LWC layer stay out of the offline-tile cache (live/large data) and out of every KPI / threat-strip count (context layers, not gauges/alerts), and both degrade gracefully to an empty layer if their feed is unreachable so the board never blanks

## v0.75.9 — 2026-07-18 (mobile-landscape + tablet viewport usability)
- Fix: a phone held sideways was almost unusable — the app had exactly one responsive breakpoint (`@media (max-width: 768px)`) keyed on WIDTH only, so modern phones in landscape (844–932px wide but only 375–430px tall: iPhone 12–15, large Android held sideways in a vehicle) exceeded the 768px cutoff and fell into the full desktop layout (`main{display:flex}` + a 420px sidebar) on a viewport with no vertical room, leaving the 2-row header + threat grid + tabs + anchored 911 footer consuming the sidebar with ZERO feed cards visible; a new height-based query (`@media (max-height:500px) and (orientation:landscape)`, placed after the ≤768 block so it wins the 667×375 overlap) now puts every phone-landscape viewport into a map-favoring side-by-side split — a compact icon-only header (subtitle/ticker/KPI-tiles hidden), a 40vw scrollable sidebar (min 260 / max 340px) with a horizontal-scroll threat strip and headerless tabs, the map filling the remaining ~60%, and a short one-line 911 disclaimer that still tap-expands to the full notice (never blanks); tablets (≥501px tall in landscape) and all portrait layouts are excluded and unchanged
- Fix: the map left grey/mis-tiled after a device rotation — the only `invalidateSize()` call fired on bottom-sheet state changes, with no `resize`/`orientationchange` handler, so rotating a phone reflowed the map container without telling Leaflet until an unrelated interaction happened; added a single debounced `window` resize handler (200ms) that calls `state.map.invalidateSize()` so the map re-tiles cleanly on rotation and any viewport change

## v0.75.8 — 2026-07-18 (live TxDOT DriveTexas road closures / high-water layer)
- New: added a live "Road closures / high water (TxDOT)" map layer (first-class layer-control toggle, on by default) that fetches the TxDOT DriveTexas HCRS_CC ArcGIS FeatureService in-browser (CORS-open, no key, no proxy) — layer 1 (line segments) + layer 0 (points) queried over the AO bbox (`geometryType=esriGeometryEnvelope`, `outSR=4326`, `f=geojson`) and filtered server-side to the flood-relevant subset `CNSTRNT_TYPE_CD IN ('F','Z','D')` (F=Flood, Z=Closed, D=Damage) so routine construction never clutters the flood board; lines render as prominent colored polylines (Z closed + F flood in reds, D damage in amber), points as colored circle markers, each with an `esc()`-escaped popup carrying road name (RTE_NM/RDWAY_NM), the type in plain words, the HTML-stripped COND_DSCR, the from/to limits (handles both COND_LMT_*_DSCR and LMT_*_DSCR field names), the start time formatted to CT, and a detour flag; sourced/attributed exactly as "Road conditions: TxDOT DriveTexas (drivetexas.org)" and labeled live conditions, not a closure guarantee
- New: the road layer refetches on the app's normal refresh cycle (`fetchRoadClosures` joins the `refresh()` Promise.allSettled as source "TxDOT roads", shown in Data source health) and ages out cleared closures like the v0.75.6 map-recency / v0.75.4 gauge-staleness philosophy — any condition whose `COND_END_TS` (epoch-ms) is set and in the past is skipped, missing/empty end = ongoing = kept; the fetch is wrapped like every other live source (checks `res.ok`, degrades to an empty layer on error) so an unreachable TxDOT feed never blanks the board, and it is kept out of the offline-tile cache (live data) and out of the KPI/threat-strip counts (a road layer, not a gauge/alert)

## v0.75.7 — 2026-07-18 (owner: suppress "New notice" intake by default)
- Change: the Feed tab's "＋ New notice" intake button is now hidden by default per owner ("suppress for now") — the code and the intake form stay fully intact, revealed by the `?intake=1` deep link (same gating pattern as "Am I at risk?" ?risk=1 and Field Notes ?notes=1); the button carries a static `hidden` attribute so it never flashes on boot, and a `?intake=1` check un-hides it

## v0.75.6 — 2026-07-18 (map recency: age out stale flash-flood iconography)
- Change: the map alert-polygon draw loop (`renderAlertPolys`) now skips any NWS flood alert whose `properties.expires` is in the past (`new Date(f.properties.expires) < new Date()`) — on a failed refresh `state.alerts` keeps the prior set, so an alert that has since expired could linger as a polygon; expired alerts no longer draw, while every alert still open (expires in the future, regardless of how long ago it was issued) keeps rendering, so an open FF EMERGENCY / FF WARNING is never suppressed
- New: `CONFIG.lsrMaxHours: 24` hard live-map cap on IEM storm-report (💧 LSR) markers — `renderLsrs` now caps the live cutoff at `Math.min(lsrFreshCutoffMins(), lsrMaxHours * 60)`, so a report older than 24h routes to the existing `lsrsAged` history layer (off by default, kept `histDays`) instead of the live `lsrs` layer even when the user's window filter is wider than 24h; suppress ≠ delete, aged reports stay reachable, and reports within the cutoff render live unchanged

## v0.75.5 — 2026-07-18 (security + quality hardening pass)
- Fix: a crafted `?tab=` URL param (e.g. `?tab=%22%5D`) was interpolated raw into a `document.querySelector('.tabs button[data-tab="tab-${tabParam}"]')` selector — an invalid selector threw an uncaught DOMException that aborted the rest of async `boot()`, so share params, snapshot hydration, and seed loading never ran and the board rendered blank; the param (and the equivalent persisted-tab read in `restoreViewState`) is now validated against `/^[a-z-]+$/` before use and ignored otherwise
- Fix: the edge NWPS gauge proxy (`functions/api/gauge/[lid]/[kind].js`) guarded `kind` with `!UPSTREAM[kind]`, so a prototype-chain name like `kind=constructor` passed the check and reached the upstream fetch as a 500 instead of a clean 400; it now uses `Object.prototype.hasOwnProperty.call(UPSTREAM, kind)` and returns the existing 400 for unknown kinds
- Fix: `hydrateGaugesSnapshot()` unconditionally assigned `state.gauges = snapshot` after its `await`, so if a live NWPS `refresh()` resolved first the late continuation reverted fresh live gauges to older cold-start snapshot data; the entry guard (`if (state.gauges.length) return`) is now re-checked after the await, immediately before the assignment
- Change: gauge feed numbers (observed/forecast/record stage values) interpolated into template-literal `innerHTML` are now coerced with a `fmtNum()` helper (`Number.isFinite(+v) ? +v : esc(String(v))`) at each site as defense-in-depth — trusted-gov numbers today, but no longer trusted blindly; displayed formatting is unchanged (`+"15.37"` → `15.37`)
- Change: off-site anchor hrefs built from feed/operator data (intake `source.url`, shelter/dataLink/monitor URLs) pass through a `safeUrl()` helper that returns the URL only when it matches `^https?://`, else `#` — `esc()` already blocked attribute-breakout but not `javascript:`/`data:` schemes
- Change: added zero-risk security response headers to the global `_headers` rule — `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN`; the existing `/data/*` no-store and shell no-cache rules are unchanged
- Change: Escape now closes the top-most open overlay (risk / hydro / changelog / drive / safety) and the `#app-version` tag is keyboard-focusable (`tabindex="0"`) with Enter/Space activation, matching its `role="button"`
- Change: the collapsed "▸ show N gauges normal" bucket in the Gauges tab counted stale sensors as normal (a frozen-at-MAJOR gauge maps to category `none`); the label now splits them honestly as "N gauges — X normal · Y stale" when any stale gauges are present
- Note: a Content-Security-Policy was evaluated as a backstop for the above but deferred — the board loads many external origins (unpkg, CARTO/OSM tiles, api.weather.gov, api.water.noaa.gov, mesonet.agron.iastate.edu, maps.water.noaa.gov, nominatim, plus Leaflet-injected inline styles) and a strict policy could not be fully verified non-breaking without risking a blank public safety board

## v0.75.4 — 2026-07-18 (recency filter: suppress dead/stale gauge sensors)
- Fix: a frozen NWPS sensor kept counting as an active flood gauge — West Nueces River at Brackettville (BTVT2) sat at 22.86 ft MAJOR with its last observation ~60h old while its own live forecast read ~7.5 ft no_flooding, yet the board showed it in the "Gauges in flood" KPI and the threat-to-life MAJOR chip; gaugeInFlood/gaugeCat only ever tested the reported floodCategory, never observation age, so a stale reading was treated as live
- Fix: added a `gaugeStaleHours: 12` recency cutoff and a `gaugeObsStale(g)` predicate (obs `validTime` missing/unparseable or older than 12h = dead) that now gates every flood/threat signal — the in-flood KPI tile, threat strip (MAJOR / rising-to-major / near-record chips), sitrep, ticker, crest-wave tracker, and record-watch all drop stale gauges; 12h is long enough not to punish 1-6h rural reporters but catches genuinely dead sensors; suppress ≠ delete — a stale gauge stays visible on the map (greyed/dashed marker) and in the Gauges list with a "STALE — no current data (last obs Nh ago)" badge, and fresh gauges (Derby DBYT2 ~1h MAJOR) still count and render unchanged

## v0.75.3 — 2026-07-18 (owner: condense mobile feed-actions strip + 60/40 mid-sheet split)
- Change: condensed the Feed tab's `.feed-actions` button strip on phones (≤768px) — buttons drop from the shared 42px min-height to 34px with tighter padding/font (11.5px) and the row gap/margin shrink, so the "＋ New notice · 📋 SITREP · ☰ Filters · 🔍 ID · ⋯ More" strip (and the Export/Import `#more-menu` row) is noticeably shorter and reclaims vertical list space; buttons keep their icons + labels and stay tappable, desktop layout untouched
- Change: mid/default bottom-sheet now cheats a 60/40 map-favoring split — `main.sheet-half #sidebar` height cut from 54vh to 37vh so the map takes ~60% of the map+panel area in the default state and the feed panel ~40% (measured 500x900: map 494px / panel 333px ≈ 59.7/40.3, header chrome sits outside the split); the peek/full states, the floating ▲/↕/▼ sheet-handle cycle, and the anchored 911 disclaimer footer are unchanged

## v0.75.2 — 2026-07-18 (extend gauge coverage west to the Pecos / Val Verde)
- Change: extended the gauge/AO bounding box west from -101.2 to -102.0 so the active Pecos River flood wave (Pandale Crossing PDAT2, Langtry LTRT2) now renders as live gauge dots with hydrographs — the life-threatening NW Val Verde flooding under an active NWS FFW sat just outside the prior coverage edge; the wider box also lets the Val Verde alert register as in-AO (alertInAO reads CONFIG.gaugeBbox)
- NEW "Val Verde/Pecos" AO quick-jump chip (map top-edge presets) framing the active flood reach (Pandale → NW Val Verde); the "Full AO" quick-jump was widened to the new -102.0 west edge to match, and the public snapshot fallback was regenerated with the wider bbox (226 gauges, now including PDAT2/LTRT2/BTNT2/SPCT2)

## v0.75.1 — 2026-07-18 (owner: shorten + genericize the brand subtitle)
- Change: brand subtitle shortened from "Hill Country flood event · live NWS / NOAA / USGS · community assistance feed" to "First Responder & Life Safety Feed" — the old copy was long and named a single TX/Hill-Country event; the board is being built to manage multiple AOs and separate statewide events over time, so the header subtitle no longer pins to one event (localized EN/ES, the Spanish reads "Primeros respondedores y seguridad de vida"); all local asset ?v= stamps bumped to 0.75.1 with the version

## v0.75.0 — 2026-07-18 (table-stakes T4: Spanish localization (EN/ES) + a11y)
- NEW EN/ES language toggle (🌐 header control, next to the theme toggle; icon-only on phones like the other controls) — the flood-affected Hill Country / South TX population is heavily Hispanic and the public mirror was English-only; the app UI chrome now renders in Spanish or English, choice persisted in localStorage (respondertx.lang), defaulting to the browser language when it is es-* and accepting a ?lang=es deep link; document.documentElement.lang is set to the active locale and aria-labels/titles localize with it
- Locale table lives in a new js/i18n.js (a flat EN/ES string map keyed by short ids, a t(key) helper, and an applyI18n() that drives data-i18n / -html / -title / -aria / -ph attributes) — static index.html strings apply once on boot and the app's own render paths call t() so a live toggle re-localizes the board without a reload
- Localized: header/brand subtitle, KPI tiles, control buttons, the five tab names, the whole threat-to-life module (headline + every chip: critical life-safety, cut-off areas, MAJOR gauges, rising to major, near crest of record, roads blocked, falling/recovery, next crest), the safety modal, the always-visible 911 disclaimer (short + full), Drive Mode (title/controls/threat header/empty state), the "Am I at risk?" modal and its honesty box, Resources/Follow + Social + crossings section headings, map legends, and key empty-states
- SAFETY COPY uses standard NWS/FEMA Spanish register, not literal word-for-word: "Emergencia potencialmente mortal → llame al 911", "NO es un sistema de despacho", "NO SE AUTODESPLIEGUE en zonas inundadas o bajo advertencia", "Dé la vuelta, no se ahogue" (the NWS-standard Turn-Around-Don't-Drown slogan, used exactly), "Solo orientación — no es una determinación oficial de inundación"; "911" stays 911
- Live NWS/NOAA/USGS data is never translated — gauge names, alert event/areaDesc text, forecast values, timestamps, and curated card text stay in the English the feeds provide; only the app's own UI chrome localizes (the data-dense feed intake form, exports, gauge/alert cards, and ticker deliberately stay English)
- Change: "Am I at risk?" hidden by default per owner (still at ?risk=1) — this is primarily a first-responder + public-information tool, not a consumer address-risk lookup; the button is removed from the default header (same gating pattern as Field Notes' ?notes=1) with all code and the modal kept intact, revealed and auto-opened by the ?risk=1 deep link

## v0.74.0 — 2026-07-18 (table-stakes T2: "Am I at risk?" address lookup + saved my-places)
- NEW "🏠 Am I at risk?" address flood-risk check (header control, next to Share/Drive): type any address or place → it geocodes with the board's existing Nominatim geocoder and produces a risk-glance card for that exact point, then flies the map there and drops a distinct "YOUR PLACE" marker — the address-first entry point every leading flood app (Watch Duty, Google Flood Hub, Genasys) has and this board lacked (the only prior address entry was buried in the curator intake form)
- The card reads ONLY live board state near the point — nothing invented: nearest river gauges within 15 mi (name, current stage + flood category, forecast crest + timing, observed trend, distance; tap a gauge to open its hydrograph), any active NWS flood alert whose polygon/zone bbox contains or is near the point, the nearest closed/caution low-water crossing and nearest road/cut-off notice within a few miles, plus one derived overall-read line ("Nearest gauge X is MODERATE and forecast to reach MAJOR at …; nearest closed crossing 2.1 mi") — all from the same state.gauges/alerts/crossings + gaugeCat/gaugeForecastCat/gaugeTrend/distMi helpers the rest of the board uses
- SAVE MY-PLACES: a one-tap Save stores {label, lat, lon} in localStorage (respondertx.places); saved places render as chips for one-tap re-check and persist across reloads — pure client-side, no backend, no account, no identity
- Honesty + no-PII by design: framed as "Guidance only — not a flood determination. Life-threatening emergency: call 911", it never says "you are safe", and when no gauge or alert is near the point it says so explicitly ("does not mean no risk — verify locally"); cites NWS/NOAA/USGS and points to the NWM inundation layer for modeled extent; the typed address is used only on-device to place the pin and is never logged or transmitted — the single Nominatim geocode is the only call that leaves the browser (the existing geocoder was refactored into a shared nominatimSearch() so both the intake form and the risk check reuse one code path)
## v0.73.0 — 2026-07-18 (table-stakes T1: street-level flood inundation layer)
- NEW "Flood inundation — NWM model (est.)" map overlay (layer control, OFF by default — hazard layers are explicit-enable): NOAA/NWPS National Water Model Analysis-and-Assimilation inundation extent — the street-level "which roads/blocks go under" picture that gauge numbers alone can't show; renders as a translucent blue extent hugging the river channels once you zoom to street level (the source only draws below ~1:400k, i.e. z≈11+)
- Source: maps.water.noaa.gov nwm/ana_inundation_extent MapServer (layer 0), consumed as ArcGIS dynamic-export tiles (per-tile Web-Mercator bbox) in core Leaflet — no esri-leaflet dependency; it's live model DATA so it's deliberately kept out of the offline-tile cache, and it cache-busts hourly to match the service's hourly update
- Honesty guard: the layer name, a dedicated on-map legend, and the map attribution all state this is a MODELED estimate from the NWM analysis (experimental) — NOT observed conditions — cite NOAA/NWPS, and note the hourly update; the data-age framing is unchanged (this layer is live and refreshes with the cycle, stale ≠ live)
## v0.72.0 — 2026-07-18 (owner: resize control off the panel, onto a floating pill)
- The Min/Half/Full resize control no longer takes a horizontal strip at the top of the panel — it's now a small floating vertical pill (▲ full / ↕ half / ▼ min) in the bottom-right, above the chat button, consuming zero panel space and visible in every state
- Because the control floats, Minimize now collapses the panel to nothing — a true full-screen map; the threat module + tabs reclaim the space the old strip used
## v0.71.0 — 2026-07-18 (reassessment A6: collapsible map legend)
- The map legend now collapses to a small "River gauge status ▸" pill on desktop too (was mobile-only) — it was permanently covering the Eagle Pass/Del Rio marker cluster, i.e. the most active corner of the map; click the pill to expand the full key, click again to collapse
## v0.70.0 — 2026-07-18 (owner fixes: bottom-sheet buttons + footer)
- Fix: the Min/Half/Full buttons were oversized and eating screen space — now a small centered pill that barely uses any room
- Fix: the sheet was hijacking the 911 footer and version tag — root cause was a stale CSS rule pinning the map at 42vh, so the Full sheet overflowed the viewport and shoved the footer off-screen. The map now flexibly fills whatever the sheet leaves, so the 911 line + version tag sit correctly at the bottom in Half and Full, and the three sizes all resize cleanly
## v0.69.0 — 2026-07-18 (reassessment quick-wins: AO-first alerts + discoverable Drive Mode)
- Alerts tab now leads with Hill Country AO alerts and folds the rest into "N flood alerts elsewhere in TX" — a Big Bend / far-West-TX warning can no longer sort above your area just for being newer (alerts are fetched statewide; this ranks by relevance, geometry-vs-AO-bbox)
- Drive Mode is now discoverable: its 🚗 control gets a distinct teal accent, and a one-time dismissible hint points to it on first visit — the field's best view no longer hides behind an unlabeled icon
## v0.68.0 — 2026-07-18 (owner fix: intuitive bottom-sheet buttons)
- Fix: from the fully-collapsed panel the old grabber was hard to find/expand. The bottom sheet now has an explicit always-visible "▼ Min / ↕ Half / ▲ Full" segmented control — each button jumps straight to that size, so it's never ambiguous and always easy to bring the panel back
- Min collapses to just the ~48px control bar (map full-screen), Half is the split, Full covers the map; the active size is highlighted and remembered; map re-tiles after each change
## v0.67.0 — 2026-07-17 (owner: mobile bottom-sheet for the feed/alerts panel)
- On phones the feed/alerts/threat panel is now a bottom sheet with a grabber handle: tap to cycle PEEK (collapsed to the bottom, map ~full-screen) → HALF (the old split) → FULL (slides up to cover the map for a full-screen scroll of alerts/feed) — state persists, and the map re-tiles after each resize
- ?sheet=peek|half|full deep link opens straight to a panel size; tapping a tab from peek auto-expands to half so you see the content; desktop layout unchanged
## v0.66.0 — 2026-07-17 (owner: declutter the mobile header)
- Phone header is no longer crowded: the Refresh / Share / Drive / theme controls become icon-only (⟳ 🔗 🚗 ☀️) on phones so they fit one uncramped row with real tap targets (36px) — labels stay on desktop; aria-labels keep them accessible
- The "next in Xs" refresh countdown is hidden on phones (the "updated H:MM" time is enough) and the meta is tightened, giving the "Responder TX" name room to breathe
## v0.65.0 — 2026-07-17 (owner chat: crest view not default, offline subtler + expanded)
- Gauges tab opens to the gauge list again: the 🌊 Crest Wave section is now a collapsed toggle (shows "N rivers · N pts") instead of leading the tab — one tap to expand, state remembered
- Offline map control is now subtle: a small ⬇ button matching the zoom/layer controls (turns green when tiles are cached), expanding its save/status/clear panel only on tap — no more prominent box over the map
- Offline save expanded: now caches the current view plus TWO deeper zoom levels (was one) so you can zoom in offline, same 1500-tile cap and CARTO-friendly bounds
## v0.64.0 — 2026-07-17 (next-wave W9: offline map tiles for canyon dead zones)
- NEW "⬇ Save map offline" control (bottom-left, above the legend): caches the current map view — this zoom plus one deeper — into IndexedDB so the basemap keeps drawing when signal drops in the Hill Country canyons; works over plain LAN http (no Service Worker, which http can't use), custom cache-first tile layer (~140 lines, no bundler, no new vendored dep)
- When the network fails, cached tiles render automatically from IndexedDB — the active base (and its place-label boost) route through the offline layer; the saved-tile count persists across reloads (read from IndexedDB on boot) and a "Clear offline cache" affordance is offered once anything is stored
- Honesty guard: the control states "Basemap only — gauge/alert data still needs a connection." — cached map tiles never imply the DATA is live; the data-age bar and all stale-data indicators keep governing staleness offline, unchanged
- CARTO/OSM-friendly: only the current viewport + one zoom is cached, no bulk pre-fetch, hard cap of 1500 tiles per save (over cap → "zoom in, then save"); already-stored tiles are skipped on re-save
## v0.63.0 — 2026-07-17 (next-wave W8: public RSS feed + crest calendar)
- NEW public follow mechanism, no account or backend: /feed.xml (RSS 2.0 — flash flood emergencies, forecast MAJOR crests, active critical/high notices) and /crests.ics (subscribe to add forecast crests to any calendar app)
- RSS auto-discovery link in the page head; a "Follow / subscribe" section in the Resources tab links both; each item stamps its time and forecast crests carry real NWPS validTime + a ?hydro= deep link back to the chart
- Generated by scripts/gen-feeds.py each release cycle from current board data — stays fresh on every deploy
## v0.62.0 — 2026-07-17 (next-wave W6: full-screen hydrograph)
- NEW full hydrograph: the gauge popup gains a "⤢ Full hydrograph" button (and ?hydro=<lid> deep link) opening a big chart with 24h observed history + the NWPS forecast trace (dashed), translucent flood-stage bands (action/minor/moderate/major), the crest-of-record line, a "now" marker, and dated axes
- The record line visually confirms the honest framing — you can see the forecast peak sit below the all-time crest of record instead of taking anyone's word for it
- Reuses the 3-min cached gauge proxy for observed; forecast fetched on demand; scales from desktop to phone
## v0.61.0 — 2026-07-17 (next-wave W5: Drive Mode)
- NEW 🚗 Drive Mode (header button or ?view=drive): a full-screen, big-type, high-contrast glance list built for the truck — nearest hazards (closed/caution crossings, critical life-safety + road notices, MAJOR gauges) ranked by distance + compass bearing from your GPS, with the active FF-emergency banner and next-major-crest countdown on top
- Auto-refreshes with the board's 3-min cycle; tap any row to exit and fly the map there; ⌖ Locate ranks by distance; sticky "Turn Around, Don't Drown — never enter flooded roads" + 911 line always visible
- No GPS needed to open — falls back to severity ranking and prompts to locate; degrades cleanly when no hazards are mapped
## v0.60.0 — 2026-07-17 (next-wave W4: low-water crossing inventory)
- NEW low-water crossing tracker — the operational currency of flood SAR: curator-maintained data/crossings.json (closed/caution/long-term, reason, updated-at, cited source) renders as a color-coded map layer AND a Resources-tab list; each entry stamps its update time and flips to "stale — reverify" after 12h
- Every entry carries "verify before routing" and links to TxDOT DriveTexas as the authoritative statewide closure map — the board never claims a crossing is safe
- Seeded from this event's documented closures (US 90 Sabinal/west-of-Uvalde, Kerrville Goat Creek + Junction Hwy crossings); absence-tolerant so older deploys degrade cleanly
## v0.59.0 — 2026-07-17 (next-wave W3: social link-unfurl card)
- NEW Open Graph / Twitter card: links to the public board now unfurl with a branded 1200×630 image and description on X, Facebook, iMessage, Slack, etc. — turning every shared link into a recognizable card instead of a bare URL
- The card is intentionally evergreen (capabilities + the 911/not-a-dispatch line), NOT live counts: social platforms cache og:image for hours-to-days, so a stats card would go stale in their cache and misrepresent the situation — honesty over vanity metrics
- Ships og-card.png at the site root + og:*/twitter:* meta and a standard description in the head
## v0.58.0 — 2026-07-17 (next-wave W1: crest-wave tracker)
- NEW 🌊 CREST WAVE section at the top of the Gauges tab: for each river with a moving crest, lists its gauges in crest-arrival order with the forecast crest stage, category, and ETA (relative + clock) — answers "when does the wave reach my town" for the multi-day downstream progression (e.g. Nueces: below Uvalde tonight → Asherton Sat 1 PM → Cotulla Tue; Frio: Derby overnight → Tilden Mon)
- Each row taps to fly the map to that gauge; hidden when no river has ≥2 forecast-crest points
- Honesty: ordering is by real NWPS forecast crest validTime only (labeled "crest arrival order", not a geographic claim); no interpolation between gauges — no invented "the wave is here now" precision
## v0.57.0 — 2026-07-17 (next-wave W2: Record-Watch — crest-of-record context)
- NEW crest-of-record context: gauges forecast within 5 ft of (or above) their all-time NWPS crest of record now show it — a "⚑ near crest of record" row in the threat module, a per-gauge record line on the Gauges tab ("record 33 ft (1935); forecast 3 ft below"), and a bracketed note on SITREP rising lines
- Data: new curated data/records.json built from NOAA NWPS historic crests (cited, dated); absence-tolerant so older deploys degrade cleanly
- Honesty guard: the feature reports the forecast's MARGIN to the record and only says "AT/ABOVE" when the forecast actually meets it — no "record-breaking" claims where none exist; reconciled the Asherton card to carry both the 1991 modern record and the 1935 all-time crest (both real, different eras)
## v0.56.0 — 2026-07-17 (owner request: persist view settings across refresh)
- Your view now survives hard refreshes and app updates: feed filters (type/county/sort/time window/distance/search), the aged toggle, alert filters (severity/text), and the active tab are saved to the browser and restored on next load — no more re-setting filters after every deploy-triggered reload
- Precedence preserved: a shared/deep-link URL (?tab=, ?ft=, ?theme=, etc.) still wins for that load; theme, basemap, and filters-panel open-state already persisted and continue to
## v0.55.0 — 2026-07-17 (product vet pass: radio-ID share-link + wobble fixes)
- Fix (field bug): a shared/deep radio-ID link (?fq=R-031) now flies the map to the card and opens its popup on load — previously the fly-to fired before seeds loaded and left the map statewide; re-applied after the board data lands
- Fix: typing a multi-digit radio ID no longer wobbles the map through intermediate matches (R-03 → R-003) — fly-to now requires the complete 3-character code
- Verified (full adversarial UAT this cycle): threat module, safety modal, snapshot discipline, cached hydrographs (LAN + edge), Share View, radio IDs, hidden Notes, typed-coord intake, GPS chip, light-theme contrast, MRMS legend, and public-mirror chat-hygiene all pass; seed-013 empty source URL confirmed a correctly-exempt field card, not a defect
## v0.54.0 — 2026-07-17 (owner chat directives: radio-ID search + Notes hidden)
- Radio-ID search (owner request): the Feed search now matches short IDs, and typing an exact ID ("R-031", "r031") flies the map to that card and opens its popup — phones scroll the map into view; new 🔍 ID button opens search pre-focused for gloved one-tap entry
- Field Notes hidden for now (owner request): the 📍 Notes button and flyout no longer load by default — ?notes=1 / ?note= deep links still work for testing, server /api/notes stays live, nothing deleted
## v0.53.0 — 2026-07-17 (13:23 cycle: speakable short IDs)
- Every feed card now carries a radio-speakable reference (R-036 style — seeds keep their number, field intakes hash to 3 characters, stable across reloads): tap the badge to copy, shown in map popups, and prefixed on every SITREP critical line so "flag R-036" works over radio/SMS; curator resolves by ID from chat
- LSR short-IDs deferred: IEM report identity isn't stable enough across refreshes to promise a speakable reference yet
## v0.52.0 — 2026-07-17 (13:08 cycle: light-theme sunlight contrast)
- Light theme retuned for direct-sunlight readability (the field case for light mode): darker secondary ink and muted text, stronger hairlines/borders, and dedicated light-mode severity/category colors — the dark theme's pale amber (watch/action), orange (warning/minor), and gray tokens washed out on white; category dots, sev text, threat rows, and the ticker now hold contrast outdoors
## v0.51.0 — 2026-07-17 (12:53 cycle: GPS-wait feedback)
- Tapping ⌖ (or enabling a distance filter) now shows a pulsing "acquiring GPS fix…" chip on the map and lights the locate button until the fix lands or fails — no more dead air during the 5-30s GPS wait; locates now carry a 20s timeout so failures actually report instead of hanging silently
## v0.50.0 — 2026-07-17 (12:38 cycle: MRMS rainfall legend)
- Rainfall layers finally carry a scale: turning on MRMS 1h/24h shows a color-ramp legend on the map (blue→cyan→green→yellow→orange→red, endpoints sampled from the live IEM q2 tiles) labeled light→extreme; title tracks which accumulation window is active; hides when the layers go off
- Labels stay qualitative on purpose — IEM does not publish the inch-value breakpoints for this ramp, and inventing numbers would be dishonest; warmer = heavier is the field read
## v0.49.0 — 2026-07-17 (12:23 cycle: typed-coordinate intake)
- The intake form's lat/lon field is now editable (was readonly): type radio-relayed decimal coords ("29.2810, -99.7862"), they parse/validate, drop the pin, and pan the map — bad input says so instead of silently failing; map-click and 🔎 geocode unchanged
- Phones scroll the map into view when the intake form opens — the pin-drop target is on screen instead of below the fold
- ROADMAP hygiene: #9 dead-tap alert cards confirmed already fixed in code (marked done)
## v0.48.0 — 2026-07-17 (owner directive: stupidly-simple Share View)
- NEW 🔗 Share button in the header (next to Refresh): one tap builds a link that reproduces the current view exactly — map center/zoom, active tab, Feed filters (type/county/sort/time window/distance/search), Alerts filters (severity/text), basemap, and theme — then copies it ("✓ Link copied") or hands it to the phone's native share sheet (navigator.share) when available
- Short param scheme (mlat/mlon/mz · tab · ft/fc/fs/fw/fd/fq · as/aq) rides the existing ?tab=/?base=/?theme= deep-link vocabulary; URL wins over saved basemap/theme for that load only; existing deep links (?chat=1, ?note=, ?notes=1, ?rf=, ?radar=, ?rain=) untouched
- On open, restored filters apply through the same handlers a user change would fire (so every list re-renders live) and the Filters panel auto-opens so a shared filtered view is visible, not silent; notes state intentionally excluded from share links for now
- Links are built from the page's own origin — the same button works on the LAN board and the public mirror
## v0.47.0 — 2026-07-17 (owner directive: our-side gauge hydrograph caching)
- Gauge graphs now load through our own cached proxy instead of hitting NOAA per viewer: same-origin /api/gauge/<lid>/<detail|series> served by a Cloudflare Pages Function on the public mirror (edge-cached 3 min, cache-API + s-maxage) and by server.py on the LAN board (in-memory 3-min cache — 269ms cold → <1ms warm measured); browser falls back to direct NOAA automatically if the proxy is unavailable
- cachedJson now rejects on non-OK responses instead of parsing error pages — fallback chains fire correctly
## v0.46.0 — 2026-07-17 (owner directives: calmer fallback warnings + one-time safety modal)
- Snapshot fallback is no longer alarmist: the "GAUGES FROM SNAPSHOT" bar now appears only when the snapshot is ≥30 min old (a fresh snapshot is a working state, not a warning); amber 30-60 min, red beyond
- The data-age warning bar is now dismissable (✕) on desktop and mobile — dismissal holds until the failing source or severity changes, so escalations still break through
- One-time safety modal on first visit (persisted): life-threatening-emergency → 911 text with strong "DO NOT SELF-DEPLOY into warned or flooded areas" emphasis and an explicit acknowledge button; the always-on footer disclaimer is unchanged
- Header degraded note now names the failing feed ("degraded: NWPS gauges, storm reports") instead of a bare "Failed to fetch"
## v0.45.0 — 2026-07-17 (Field Notes — community + responder annotation board)
- NEW 📍 Field Notes flyout (agent-built): chronological annotation board over the map — right-side panel on desktop, full-width bottom sheet on phones; teal "📍 Notes" button stacks above the map legend
- Three note kinds: pinned map notes (drop-pin mode → tap the map → mini-compose with info/hazard/road/water-level/photo-worthy category), flat comment threads on any note, and general no-location board posts
- Teal teardrop pins (visually distinct from gauge/need markers) with a popup thread + reply/copy-link; every note is shareable — ?note=<id> deep links open the flyout, focus the note, and fly the map to its pin
- Persistence: POST /api/notes appends to data/notes-inbox.jsonl on the LAN server (chat-inbox pattern, kind/category/coord validation); client merges curated data/notes.json so published notes survive to the mirror; the public mirror detects the missing API and degrades honestly to "Read-only public mirror — notes viewable only"
- Compose carries the safety line (Life-threatening emergency → call 911; notes are unverified community input) and asks only an optional display name — no PII solicited; server.py gains a PORT env override for side-by-side test instances
## v0.44.0 — 2026-07-17 (command-area rework: threat module, tabs, slim header)
- Threat-to-life strip rebuilt as a structured status module: "THREAT TO LIFE" header (only when life-safety signals exist), aligned stat rows in a 2-col grid — glyph + tabular number + label with a consistent 4-tier semantic (life-safety red, escalation amber, major-flood purple, recovery green), subtle left accent + tinted background instead of 8 mismatched outlined pills; every row keeps its tap-through (tab jump / map zoom)
- "Next crest" gets its own emphasized full-width countdown row; raw red "FF EMERG:" text line replaced by tidy per-emergency mini-chips (place → expiry) that open the Alerts tab
- Mobile: threat module collapses to 1-2 dense horizontally-scrollable rows (header hidden, chips compact) — reclaims roughly a third of the sidebar for tabs + feed per owner directive
- Tabs modernized: never wrap (fixes desktop "Gauges/21" badge breaking to a second line) — nowrap buttons with inline-centered count badges, hidden-scrollbar horizontal overflow on narrow widths, smooth active-underline transition; red sev badge on Alerts preserved
- Rename: app is now just "Responder TX" (header h1, page title, manifest, event config); subtitle carries the Hill Country flood context
- Header slimmed: tighter padding, smaller KPI tiles, compact Refresh/Light controls — buys back vertical space, especially on phones (all click-through and update-chip behavior intact)
- Gauge popup hydrograph now served from a 3-min TTL cache: closing and reopening a gauge redraws instantly instead of refetching; in-flight requests are shared and failures evict so retries still work (owner request)
## v0.43.0 — 2026-07-17 (nav/UX package — the researched reorg lands)
- Top-left corner is one organized unit: zoom + locate merged into a single 3-button control bar (was two disconnected stacked boxes); 42px touch targets on phones
- AO quick-jump chips along the map top edge: Full AO, Kerr/Guadalupe, Uvalde/Frio-Nueces, Sonora/Ozona, Cibolo corridor — one tap fits the map; collapses behind a 🗺 toggle on phones
- KPI tiles are now actionable: tap emergencies/warnings → Alerts, gauges → Gauges tab, notices → Feed (keyboard-accessible, hover affordance)
- Mobile: the collapsed 911 disclaimer now anchors flush at the viewport bottom (root cause: missing flex min-height let long feeds shove it off-screen); chat FAB clearance verified
- Patterns per the Watch Duty / CalTopo / PulsePoint research; deferred by design: bottom tab bar (M), ticker discrete mode (owner prefers the tuned crawl)
## v0.42.0 — 2026-07-17 (11:23 cycle: stale-tab update chip + ticker pacing)
- Long-lived tabs now learn about new builds: each 3-min refresh compares the deployed changelog version against the running APP_VERSION and shows a pulsing "⬆ Updated — tap to reload" chip on divergence (never auto-reloads mid-use) — closes the cache story after the owner's tab sat on v0.39 through three deploys
- Ticker slowed ~30% (40s → 58s loop) per owner feedback
- Data: Ozona/Crockett emergency extended again to 2:15 PM confirmed in feed; Junction (Llano) 29.21 ft rising on 31.3 major forecast — card current; snapshot refreshed
## v0.41.0 — 2026-07-17 (Gauges tab + ticker + fresh-load honesty fix)
- NEW Gauges tab (agent-built, merged): monitored gauges bucketed by actionability — ▲ RISING (soonest crest first) → ● IN FLOOD NOW → ▼ FALLING, normal gauges collapsed; "By priority / By river" grouping (NWPS carries no county field); cards show obs+category, trend ft/hr, forecast crest with timing, NWPS link; tap flies the map and opens the gauge popup; red tab badge on majors
- NEW actionable ticker under the header: recency-biased marquee of FF-emergency countdowns, rising-to-flood crests (category-colored), MAJOR holds, fresh storm reports, newest critical notice; pauses on touch, honors reduced-motion, every segment tap-navigates; becomes the phone's glance surface
- Fix (owner report): fresh loads flashed "GAUGE DATA NEVER LOADED" — snapshot now hydrates immediately at boot (live fetch overwrites), snapshot state clears on live recovery, and the staleness bar gets a 25s boot grace
- Data: Ozona/Crockett emergency EXTENDED to 2:15 PM; NEW critical cards — Frio at Concan crested MAJOR (~15.4 ft, Garner corridor) and Llano near Junction rising to MAJOR (~31.3 ft ~noon); westward round now flooding the Frio/Llano
## v0.40.0 — 2026-07-17 (radar suppression fix)
- Fix (owner report, agent root-caused): radar frames were painted OVER by the Streets base — the layers control auto-assigns base z-indexes (Streets=3) while late-created radar frame layers defaulted to z-index 1 in the same pane; dark base only worked by DOM-order luck. Radar now renders in a dedicated pane (z-350: above every base, below alert polys and boosted labels); crossfade opacity 0.75; color schemes tested and proven pixel-identical (kept 2); ?rf=N scrub deep-link; frame advance verified by pixel diff
- Fix: "next crest" chip no longer shows crests already past
- Live during verification: NWPS throttled again and the full fallback chain performed — snapshot bar + auto-enabled USGS clusters
## v0.39.0 — 2026-07-17 (owner radar/base directives)
- Streets (OSM) is now the DEFAULT basemap (saved choice and ?base= respected; picks persist across visits) — street-level detail out of the box, dark/light CARTO still one tap away
- Radar scrub extended to the full published history (~2h @ 10-min steps, was 1h) and playback made fluid: all frames pre-mount as opacity-crossfaded tile layers — no per-frame tile reload/redraw during loop or scrub
- Future-cast truth: RainViewer's free API dropped nowcast (docs now list past-2h only) — scrubber labels "now · no future-cast in free feed" instead of implying projection; source hunt queued in ROADMAP (keyed RainViewer / Open-Meteo 15-min precip / HRRR sub-hourly)
- Radar play state survives the 3-min frame refresh; time labels switch to hours beyond -110m
## v0.38.0 — 2026-07-17 (10:43 cycle: USGS auto-fallback)
- When the live NWPS gauge feed is stale >15 min and USGS sites are loaded, the clustered USGS raw-stage layer auto-enables and the staleness bar notes "USGS raw-stage fallback ON (no flood categories)"; auto-stands-down on NWPS recovery without fighting a manual toggle
- Snapshot refreshed (220 gauges, 21 in flood, 1 major); both FF emergencies steady (Sutton 1:15 PM, Crockett 11:45 AM); healthy-path renders verified at both widths
## v0.37.0 — 2026-07-17 (10:35 cycle: snapshot resilience + readable maps)
- Gauge snapshot fallback: every ops cycle publishes data/gauges-snapshot.json (≤15 min old); fresh public visitors hydrate from it when NWPS rate-limits, with an honest amber/red "GAUGES FROM SNAPSHOT N MIN OLD" bar — proven live during this cycle's NWPS 429 window
- Place-label boost (agent-built, merged): CARTO label overlay in a dedicated pane ABOVE radar/alert washes with dark-mode brightness filter — city/county names now readable over heavy echoes (screenshot-proven on the storm core); theme-aware, toggleable
- Streets base layer: OSM standard as a third base (Dark / Light / Streets) for street-level detail; label variant tracks the basemap surface; ?base=osm deep link
- Both FF emergencies steady (Sutton 1:15 PM, Crockett 11:45 AM); NWPS healthy at sweep time
## v0.36.0 — 2026-07-17 (reassessment round: surface what the board already knows)
- Threat strip gains the two facts the board knew but never showed: "⏱ next crest in Xm/h {river}" chip (soonest rising-gauge forecast, tap to fly there) and an FF-emergency clock line ("Sutton → 1:15 PM · Crockett → 11:45 AM")
- Honesty-leak fix: degraded boot no longer sticks on "refreshing…" — the early-return path now sets the degraded note and renders source health
- Alert cards are never dead taps: zone alerts without geometry fall back to cached zone polys, else open the full alert text
- Aging: in-progress immortality removed (nothing escapes the clock) + per-type timeouts (info/volunteer 12h, default 24h); meaningless "open" badges dropped from cards
- Public mirror honesty: intake form on the mirror now states saves are device-only and never reach the ops session
- Reframe vocabulary sweep completed: legend, empty-state, SITREP "ACTIVE CRITICAL", Social workflow text, More tooltip, dead STATUSES/filter code — repo grep clean
- Alerts sort by recency within severity; fresh-eyes reassessment verdict: "converging" — remaining items queued (USGS auto-fallback, gauges snapshot for public cold-start, Drive Mode view, MRMS scale)
## v0.35.0 — 2026-07-17 (radar scrub + location beacon)
- Radar time-scrub: RainViewer past-hour frames + forward nowcast projection (when published; labeled "+Nm PROJECTED", amber) with play/pause loop and slider over the map; replaces the static NEXRAD layer; maxNativeZoom 7 upscaling (free-tier tiles placeholder above z7); frames refresh with the 3-min cycle while enabled; ?radar=1 deep link
- All radar/rainfall layers now OFF by default (owner directive) — explicit enable via layer control ("Radar scrub (-1h → +30m)", MRMS 1h/24h)
- Location beacon: locate-me now drops an unmissable double-ping ring + core dot + "YOU" tag (was a subtle 14px dot), zooms to 12, sits above all markers
- Cache stamps bumped to ?v=0.35.0
## v0.34.0 — 2026-07-17 (cache-skew fix + parallel-agent data layers)
- Fix: public mirror "no data" — stale edge-cached app.js (max-age 3600) paired with newer HTML crashed boot on removed elements; all local asset URLs now carry ?v=VERSION stamps (atomic HTML↔asset pairing) and `_headers` forces no-store on /data/* and no-cache on the shell
- NEW (agent-built branch, merged): RFC forecast-crest layer — hollow rings in category colors for gauges carrying a 5-day max forecast NWPS lacks (on by default); USGS raw-stage layer — 224 in-bbox instantaneous-value sites, clustered (vendored Leaflet.markercluster v1.5.3, MIT), off by default, no fake flood categories on raw stage
- Data: Sonora FF emergency EXTENDED to 1:15 PM CT (new emergency-worded FFW 10:06 AM); Ozona active through 11:45 AM — 3 emergency-worded warnings live
- 404.html added (kills Pages SPA fallback — removed paths now truly 404); master-roadmap draft assembled by planning agent
## v0.33.0 — 2026-07-17 (reframe: notices, not requests)
- Requests reframed as alerts/notices (owner directive): no manual status management — no "status →" cycling, no archive chore, no status filter/intake field; curator (the ops session) resolves via data updates and resolved cards auto-suppress to the aged/history layer immediately; everything else ages out on the 24h timeout as before
- Renames: Requests tab → Feed, "Open requests" tile → "Active notices", "+ New request" → "+ New notice" (field capture keeps working), map layer → "Notices (curated + field)", SITREP "OPEN REQUESTS TOTAL" → "ACTIVE NOTICES TOTAL"
- Exports (JSON/GeoJSON/AAR) unchanged — full history including aged/resolved stays exportable

## v0.32.0 — 2026-07-17 (chat gated to LAN-only)
- Ops chat is now strictly a local construct: UI extracted to js/chat.js, injected only after the LAN server answers GET /api/ping (server.py beacon); public mirror ships NO chat route, code, markup, styles, or data
- data/chat-outbox.json un-tracked from the public repo; deploys strip js/chat.js and all chat data from the artifact
- LAN behavior unchanged: same panel, send, action feed, unread badge, ?chat=1 deep link
## v0.31.0 — 2026-07-17 (public launch)
- LIVE on the public internet: https://responder.rfxn.com — Cloudflare Pages behind Cloudflare SSL (HTTP/2, valid cert), plus https://responder-tx.pages.dev
- Open-sourced: https://github.com/rfxn/responder-tx (public repo; LAN-internal files excluded — HANDOFF, chat inbox/cursor)
- HTTPS unlocks the secure-context features the LAN board couldn't have: geolocation (locate-me + distance filters now work on phones), native clipboard, PWA add-to-home-screen
- Public mirror is read-only: chat send + new-request intake persist only on the LAN board; mirror data refreshes on every release-cycle push; chat panel shows the action feed
- Release cycles now commit, push to GitHub, and redeploy Pages — the live mirror stays current automatically
## v0.30.0 — 2026-07-17 (9:42 AM fast cycle)
- Gauge markers get 32px invisible hit areas (visual dots unchanged) — 8-18px dots were untappable one-thumbed; non-flooding gauges hidden entirely on phone maps (UX audit #5)
- Data: Sutherland Springs secondary bump CANCELED — falling at 33.9, forecast revised 35.5 → 33.1; card de-escalated to roadway watch (NWPS SUPT2)
- Health: both FF emergencies active (Sutton to 10:15, Crockett/Ozona to 11:45); APIs green; renders read at 1600px + 500px
## v0.29.0 — 2026-07-17 (double-down cycle 2: UX-audit dangerous fixes)
- Stale-data bar: full-width amber (>7.5 min) / pulsing red (>15 min) banner when gauge/alert feeds stop refreshing — stale data must never masquerade as live (UX audit ⚠#3)
- Status changes guarded: confirm before marking resolved, resolved is terminal with explicit reopen (no more silent 4-tap resurrection on 26px badges) (⚠#2)
- Alerts tab reordered: filters → actual NWS alerts (emergencies first) → forecast list → storm reports collapsed to top 5 with expander — emergencies were ~35 cards deep (⚠#4)
- Alerts tab badge turns red "⚠ N" showing the emergency count instead of a flat statewide total; Monitor tab renamed Social (audit #16)
- Phone: stat tiles hidden (threat strip is the richer tappable duplicate, ~55px reclaimed); disclaimer collapses to one line (911 wording always visible, tap to expand); tab bodies pad clear of the chat FAB (#7, #12, #13)
- Card selection: tapped cards outline, open their marker popup, and scroll the map into view on phones (#8)
- Full UX audit (17 findings), OSS borrow-list (leaflet.offline = offline tiles WITHOUT a service worker — works on LAN http), verified live-resource list (CrowdSource Rescue activated, iSTAT, SARiverFlood HALT), and corrected data-integration specs all landed — folded into ROADMAP
## v0.28.0 — 2026-07-17 (double-down cycle 1: declutter + Ozona emergency)
- NEW FLASH FLOOD EMERGENCY carded: Ozona / Crockett County (8:45 AM, "PARTICULARLY DANGEROUS SITUATION", 2-5.5 in fallen) — second westward-shift emergency; Johnson Draw 1954 history noted
- UX declutter (owner: "UX is still generally terrible" — first strike): feed shrinks 8 buttons → 4 (＋ New request, SITREP, ☰ Filters, ⋯ More); filters collapse behind a badge-counting toggle (persisted); exports/import/archive fold into More; mobile legend collapses to a tap-to-expand pill freeing ~1/3 of the phone map; first card now above the fold on phones
- Card→marker linkage: tapping a card pans AND opens the marker popup
- Honest-zero fix: gauges tile shows "– no data" instead of a confident 0 when NWPS hasn't loaded (caught live during an NWPS 429 rate-limit window) — a missing MAJOR must never look like "no flooding"
- Emergency banner now auto-dismisses when its alert expires (aging invariant applied to the banner)
- Cadence doubled to 30-min cycles (:23/:53); three deep agents dispatched (UX audit, OSS mining, data-source integration specs)
## v0.27.0 — 2026-07-17 (mid-morning cycle)
- Rainfall accumulation layers: MRMS 1h + 24h QPE tiles (IEM, CORS-open) in the layer control, off by default, 5-min cache-busted with radar; `?rain=1h|24h` deep link — "how much fell where" flags the next crossings to go under (first Post-research backlog item shipped)
- NEW Falls City card (seed-033): crest REVISED to 25.2 ft MAJOR tonight ~10 PM — below the 26.3 record but ~24h earlier than prior messaging; prep this evening
- Data refresh: Sutherland Springs easing (34.5, back under major) but NWS forecasts a secondary bump to ~35.5 this morning — hold the area; Asherton record watch holds (obs 23.59, fcst 25.8 Sat AM vs 25.7/1991 record); agricultural-emergency card upgraded with hundreds of livestock reported lost along Pedernales/Cibolo/Frio/Nueces (KSAT); downstream watch list carded (Crystal City/Asherton/Cotulla, Derby/Fowlerton/Choke Canyon, Spring Branch, Stockdale/Falls City/Kenedy); 2,000+ responders, 230+ rescues statewide (Tribune)
- Health: all APIs green (NWPS 220 gauges, MRMS tiles verified); Sonora FF emergency active to 10:15 AM; renders read at 1600px + 500px; 2 cards aged out (visible via aged toggle)
## v0.26.0 — 2026-07-17 (owner-directive cycle: aging, changelog, ops chat)
- Aging/suppression engine (TAK stale-time pattern): request cards idle >24h auto-suppress off the map, feed, counts, threat strip, and SITREP into a dimmed "aged" view (filter-bar toggle shows them); storm reports older than 3h move to an "Aged storm reports (history)" map layer (off by default) with a show/hide list toggle; expired NWS alerts persist to a 7-day localStorage history pane under the Alerts tab — nothing is deleted, everything stays retrievable
- In-app changelog: tap the version number (blue dot = unseen release) for a succinct per-version "What's new" modal fed by data/changelog.json
- 💬 Ops session chat: floating button opens a panel that messages the live Claude session (POST /api/chat → inbox polled every ~5 min by a new cron) and shows session replies plus a recent-actions feed; unread badge piggybacks on the 3-min refresh; ?chat=1 deep link
- server.py replaces `python3 -m http.server`: same static serving plus the chat POST endpoint and no-store headers on /data/
- Research sweep (two agents): comparable-tools survey (Watch Duty, TAK, CalTopo, CrisisCleanup, ATX Floods…) and curl-verified data-source hunt (NOAA forecast-max/inundation ArcGIS, USGS IV, MRMS tiles, CoCoRaHS, OpenFEMA, FEMA NSS) — distilled into a 15-item prioritized backlog in ROADMAP.md
- Health: APIs green; renders verified at 1600px and 390/500px (mobile "defect" was chromium's 500px min-window clamp, not an app bug); board data consistent at 27 open (1 card aged out)
- NEW FLASH FLOOD EMERGENCY carded: Sonora / Sutton County (7:12 AM) — the forecast westward shift arriving on saturated ground; live clients get their first real emergency-banner firing
- Fix: clipboard actions (copy coords, SITREP) silently failed on LAN http:// origins — navigator.clipboard requires a secure context; added an execCommand fallback via copyText() helper
- Data refresh: rain ended for most (dry stretch from this afternoon), Falls City crest revised to 26.4 ft late Saturday (potential second record on the Cibolo — 26.3, 2007), Kerrville Main St + Water St bridges debris-covered, local disaster declarations noted with federal request pending
- Health: APIs green; Sutherland Springs confirmed falling; Nueces below Uvalde 19.2 approaching moderate

## v0.24.0 — 2026-07-17 (morning cycle)
- LSR popups gain navigate → (Google Maps) links and USNG grids — field crews can drive straight to storm-report locations
- ROADMAP refreshed with post-sprint status: all bounded backlog shipped v0.2→v0.24; remaining work is infra/partnership-gated (shared state, HTTPS offline, X ingest)
- Data refresh: Sutherland Springs marked PEAKED (~35.3, homes-cutoff avoided; Falls City crest still coming), Asherton card gains FM 190/livestock thresholds, Llano County evacuation center added (63 sheltering), gov.texas.gov/floodresponse added as the official recovery hub, CTEC 1,000+ rural meters out noted
- Health: APIs green; 0 FF emergencies; Nueces below Uvalde nearly out of major (20.75)

## v0.23.0 — 2026-07-17 (dawn cycle)
- Tab-title badge: open-critical count in the browser title (`(5) Responder TX…`), composing with the 🔴 new-emergency flag — for many-tab ops rooms
- SITREP gains a RECOVERY line (falling in-flood gauges) alongside the threat lines
- Data refresh: NEW Asherton potential-record-crest card (25.8 vs 25.7 record from 1991, Saturday AM), Sutherland Springs crest trimmed to ~36.7 (below the homes-cutoff threshold — good news, card updated), Kerrville utility recovery quantified (outages 98→39; Arcadia Loop bridge 15–20 ft hole, homes temporarily without water)
- Health: APIs green; 0 FF emergencies; Sutherland Springs 35.3 near peak; Nueces below Uvalde down to 22.4 and falling

## v0.22.0 — 2026-07-17 (crest-watch + hardening cycle)
- Data refresh: Sutherland Springs AT MAJOR (35.2 ft, FM 539-south roadway submerging, crest 38.3 due), Crystal City escalated to evacuation (mobile homes evacuated, FM 582 flooded, "disastrous widespread lowland flooding" forecast, wave continuing to Asherton)
- STRATEGY.md gains a running "Event lessons" section feeding the AAR (forecast-first pre-positioning, timestamp discipline, corrections-as-cards, 2025 siren success, scam wave timing)
- QA sweep passed: syntax/JSON clean, 911 disclaimer intact, zero stray logs/TODOs, all non-field cards source-cited
- Health: APIs green; 0 FF emergencies; 3 majors (Sutherland Springs newly major); Nueces below Uvalde falling steadily

## v0.21.0 — 2026-07-17 (pre-dawn recovery cycle)
- Quiet-state threat strip: when the last life-safety chip clears, the strip explicitly shows "✓ NO ACTIVE LIFE-SAFETY SIGNALS — recovery posture" instead of an ambiguous empty bar
- Data refresh: Spring Branch crest PASSED (card moved to damage-assessment posture), NEW Crystal City downstream-wave welfare card (FM 1025 already overtopped), NEW agricultural-emergency card (TDA relief for drowned livestock/flooded crops), fatality details firmed on the welfare card + 2025-lessons siren success noted, Hill Country Daily Bread address added
- Health: APIs green; 0 FF emergencies; 2 majors; Sutherland Springs 34.97 — cresting at the road-submersion threshold now

## v0.20.0 — 2026-07-17 (multi-event groundwork cycle)
- Event config externalized to `data/event.json` (name, subtitle, map center/zoom, gauge bbox) — re-point the board at a future event by swapping one data file; built-in defaults remain the fallback
- NEW: Canyon Lake BOIL WATER NOTICE card (treatment-plant turbidity from flood debris) — potable-water staging flagged
- Spring Branch card hardened: crest ~37–38 ft just after midnight, 1991 record 38.0, disastrous-at-39 context, Kendall Co ~200,000 cfs measurement
- Fix: three cards were future-stamped (~9h ahead) — caught in the render check ("in 9h" ages); all timestamps clamped to actual time
- Health: APIs green; 0 FF emergencies; majors down to 2; Sutherland Springs 34.5 at the road-submersion threshold

## v0.19.0 — 2026-07-17 (recovery-vigilance cycle)
- Archive resolved: one click moves resolved cards out of the feed/map while keeping them in JSON/GeoJSON/AAR exports (which now always include archived history)
- ESCALATION handled: Guadalupe near Spring Branch forecast upgraded to MAJOR 39 ft (36.1 observed) — card raised back to critical
- Recovery-vigilance monitor pack: FTC scam alert, Texas Tribune vetted how-to-help, BBB Give.org, National Center for Disaster Fraud, and a live X search for donation-scam reports (2025 precedent: fake Venmo accounts impersonating a Kerr Co VFD); TDI claims helpline added to hotlines
- Health: APIs green; 0 FF emergencies; majors down to 2; Sutherland Springs 34.0 approaching the 35-ft road-submersion threshold

## v0.18.0 — 2026-07-17 (recovery-posture cycle)
- Export AAR: one-click markdown after-action bundle — card statistics (by status/type/county), full chronological card log with source links, and a situation snapshot at export time
- Data refresh: official state recovery portals added (Damage.TDEM.Texas.gov, Disaster.Texas.gov, RebuildTX.org + KSAT resource roundup), Uvalde Fairplex marked pets-accepted, Hwy 39 bridge noted stabilized, NEW card for the destroyed Kerr County wildlife rescue facility (animal-rescue coordination)
- Health: APIs green; 0 FF emergencies; Sutherland Springs 33.4 ft — approaching the 35-ft roadway-submersion threshold ahead of the crest

## v0.17.0 — 2026-07-17 (pre-dawn cycle)
- Data Source Health panel (Resources tab): per-feed last-success freshness dots (NWS alerts / NOAA gauges / storm reports / board data) so degraded connectivity is visible at a glance
- Data refresh: Sutherland Springs card gains the 35-ft threshold (roadway south of FM 539 bridge submerges; now 32.7 and rising), Elmendorf crest marked PASSED and receding with lowland-impact notes, outlook flipped to "pattern breaking — dry stretch from Friday afternoon", Hill Country Daily Bread Ministries (Boerne cleanup buckets/emergency food) added to recovery links
- Health: APIs green; 0 FF emergencies; 21 in flood, 3 major (all falling except Sutherland Springs)

## v0.16.0 — 2026-07-17 (recovery-transition cycle)
- SITREP now uses the native share sheet on mobile (navigator.share) with clipboard/download fallback
- Ground-truth (LSR) window now follows the time-window filter (1h–24h) instead of a fixed 12h
- Morning prune pass: Uvalde vehicle-entrapment card RESOLVED (waters receding, no new entrapments), unconfirmed Comfort livestock lead closed after 16h, Uvalde ops card transitioned to welfare-checks/resupply, access card updated (US 90 intermittent), outlook updated (storm shifts to Big Bend; zero FF emergencies)
- NEW: San Antonio River near Elmendorf crest card (38.7 ft, through 11 PM Friday; Wilson Co. voluntary-evacuation advisory)
- Health: APIs green; 0 FF emergencies; 21 in flood, 3 major; Sutherland Springs 32.0 ft climbing toward its Friday-morning crest

## v0.15.0 — 2026-07-17 (overnight cycle)
- ▼ falling (recovery) chip in the THREAT TO LIFE strip — taps to fit the map to recovering in-flood gauges (access-opening signal)
- @media print stylesheet: EOC wall printouts — light ink tokens, map/controls hidden, threat strip + active-tab cards with page-break protection; verified via print-to-PDF
- Data refresh: Sutherland Springs card upgraded with crest specifics (38.3 ft Fri AM vs 38.8 record 2009; FM 539 impassable at 37 ft; Gum Branch/Alum Creek backflow; Wilson Co. 24-48h FF-emergency alert), Cajun Navy deployed to Center Point, Kendall Co. zero fatalities/missing + Comfort top-3 crest context, records context (Nueces record ~2x Niagara, Frio top-5)
- Health: APIs green; majors down to 3 (recovery upstream); Sutherland Springs 31.2 climbing; timestamps corrected (no future-dated cards)

## v0.14.0 — 2026-07-17 (early-morning cycle)
- Duplicate-intake guard: submitting a request now warns when a same-type open request exists within 3 mi (multi-monitor triage hygiene) — confirm to add anyway
- Data refresh: TDEM food/water deliveries into cut-off Uvalde (85+ boats, 20 aircraft, 200 high-water vehicles), TxDOT 125 roadways affected / 87 closed on the road card, Johnson City crest passed (falling from 24.3), overnight outlook updated (8–15 in possible N/W of Kerrville; Friday threat shifts west, 2–6 in)
- Health: APIs green; Nueces below Uvalde cresting at ~27.8 ft (record forecast); Sutherland Springs 30.5 ft still climbing toward 37.2; flood warnings easing (39→29 during cycle)

## v0.13.0 — 2026-07-17 (overnight cycle)
- New-emergency banner: a fresh Flash Flood Emergency appearing between refreshes now raises a pulsing dismissible banner (click → Alerts tab) and flags the tab title 🔴 — built for overnight monitoring; fixed a `[hidden]` vs `display:flex` CSS defect caught in the render check
- Data refresh: US-90 corridor closure card (both directions at Sabinal + west of Uvalde, US 57/FM 140/FM 3352/FM 1581), D'Hanis flash-flood-emergency/Seco Creek card with Hondo shelter, Kerr bridge damage consolidated (Sidney Baker closed, three bridges washed out), Abbott's greatest-risk-24h statement (Uvalde + Johnson City; record Nueces ~2x Niagara flow; 230+ rescues), official Texas Flood Information Viewer + TPR live blog added to data links
- Health: APIs green; 19 in flood, 5 major; Sutherland Springs 29.95 ft still climbing toward 37.8 major

## v0.12.0 — 2026-07-16 (late-night cycle)
- Visibility-aware polling: backgrounded tabs stop refreshing (battery/data saver for field phones) and catch up instantly on return to foreground
- Data refresh with corrections: Schertz evacuation RESOLVED (order lifted 3 PM — prior card was built on pre-lift reporting; corrected with citation), NEW Sutherland Springs/Falls City card (Cibolo forecast upgraded to MAJOR 37.8 ft vs 21 ft flood stage), death toll 2 (Comfort RV victim; 74-year-old Uvalde driver), Level 4/4 risk shifted to US-90 corridor west of San Antonio (10–15 in pockets possible), Silver Sage shelter (Bandera) added with address, Pioneer RV Park flood thresholds on the Bandera card
- Health: APIs green; 19 in flood, 5 major; Hunt back to moderate on the second wave; observed-trend ▼ arrows now live on the map as history accumulated

## v0.11.0 — 2026-07-16 (night cycle)
- 📋 SITREP generator: one tap copies a plain-text situation report (emergencies, majors with ft/hr trend, rising-to-major crests, cut-off areas, top open criticals with USNG) for radio/SMS/email shift handoff; falls back to .txt download if clipboard is unavailable
- Night data refresh: Schertz DISASTER DECLARATION + mandatory Cibolo Creek evacuations (Pecan Grove RV Park), Bandera County Medina River RV-park evacuations ordered, WPC Level 4/4 overnight outlook (2–5 in more, embedded tornado warnings), Uvalde PD "no way into the city" quote on the isolation card
- Health: 1 FF emergency (Blanco); 19 in flood, 5 major; Johnson City Pedernales still rising (24.3 ft); Sutherland Springs 29.2 ft trending to 38+ major

## v0.10.0 — 2026-07-16 (evening cycle)
- Observed gauge trend engine: stage history accumulates across refreshes in localStorage (zero extra API calls); popups show ft/hr trend with direction; in-flood gauges that are falling get a green ▼ (recovery/access signal); legend updated
- Evening data refresh with resolve/prune: Camp Mystic card RESOLVED (all camps confirmed safe), Kerrville updated to waters-receding/shelter-in-place (main bridge closed), Hwy 39 buckling between Hunt and Ingram, Ingram damage worse than 2025, NEW Spring Branch/Canyon Lake downstream crest card (moderate+ early Friday), overnight outlook 2–4 in (isolated 8) added to the multi-crest advisory
- Health: 1 FF emergency remains (Blanco); 19 gauges in flood, 5 major; Nueces below Uvalde 26.5 ft still rising

## v0.9.0 — 2026-07-16 (hourly cycle)
- USNG/MGRS grid coordinates (SAR-standard) on request popups and in copy-coords — JS converter cross-validated against the NGA-based python mgrs library on 27 points across the operating bbox (all match ±1 m)
- Data refresh: Comfort crest corrected to 37.08 ft (surpassed the 2025 record of 35.64), fatality recovered near Center Point noted on the welfare-check card, Kendall Co. sheltering ~70
- Health check: Kerr/Kendall FF emergencies expired (2 remain: Blanco/Gillespie, Uvalde); observed MAJORs rose 4→6 — Pedernales at Johnson City hit major as forecast; Nueces below Uvalde still rising at 25.2 ft; 4 gauges still forecast to reach major (Bandera, Falls City, Sabinal, Sutherland Springs)

## v0.8.0 — 2026-07-16 (hourly cycle)
- Fix: seed data (requests/resources) now re-fetched on every 3-min refresh with change detection — open clients pick up curated updates without reload, without resetting scroll when nothing changed
- Alert cards show sent-time with freshness dot (recency for the alert list itself)
- Data refresh: NWS multi-crest "false sense of security" advisory, Kerrville utility damage card (~1,800 without power, Arcadia Loop water line break), City West Church shelter corrected to its real address (3139 Junction Hwy, Ingram)
- Health check: 49 flood alerts / 4 FF emergencies; Nueces below Uvalde still rising (24.0 ft MAJOR); fresh LSRs — FM 1320 underwater at the Pedernales crossing, aerial-confirmed inundation in Comfort

## v0.7.0 — 2026-07-16
- Intake geocoding assist: "🔎 Find on map" resolves place + county via Nominatim, sets the pin (marked "geocoded — verify"), pans the map for visual confirmation
- TxDOT closures investigated: `gis.txdot.gov` unreachable and DriveTexas API 500s — closure layer stays a partnership item (ROADMAP), deep link retained

## v0.6.0 — 2026-07-16 (afternoon data + correctness cycle)
- Event refresh from afternoon reporting: Comfort/Kendall evacuation (Guadalupe crest ~37 ft, sirens twice), Buckhorn Lake Resort + Ingram RV Park evacuations, LCRA Wirtz/Starcke floodgate release advisory for the Marble Falls–Kingsland corridor
- Gauge bbox widened south/east for the downstream Nueces wave and Colorado releases
- Alert polygons draw least-severe-first so flash-flood emergencies always sit on top
- LSR list capped at 30 (rest stay on the map layer)

## v0.5.0 — 2026-07-16
- Comms section in Monitor tab: Broadcastify scanner feeds for all 9 affected counties (Uvalde 7 feeds), CrowdSource Rescue + activation status, OpenMHz, Zello nets; scanner-monitoring shift protocol added to STRATEGY
- Export GeoJSON — assistance board drops directly into CalTopo/SARTopo
- PWA manifest + icon: add-to-home-screen on phones (standalone display)
- Legend swatches decoupled from marker declutter/pulse CSS; README/STRATEGY refreshed

## v0.4.0 — 2026-07-16
- THREAT TO LIFE strip: fused live counts (FF emergencies, critical life-safety requests, cut-off areas, MAJOR gauges, rising-to-major, roads blocked); each chip focuses the relevant view/map extent
- New request types with SAR iconography: road blocked (🚧) and cut-off area (⛔) with pulsing dashed isolation-radius overlay (operator-estimated footprint)
- Uvalde isolation footprint and Hwy 39/I-10 closure seeded from official reporting
- Alert list filters (severity + county/river text); zoom-based decluttering of no-flood gauges
- Future-crest sort in Forecast-to-flood list (soonest first)

## v0.3.0 — 2026-07-16
- NEXRAD composite radar overlay (IEM tiles), 5-min cache-busted refresh, layer-toggleable
- IEM Local Storm Reports: ground-truth map layer (freshness-faded diamonds) + list with road-name highlighting (FM/RM/CR/SH/US/IH/Loop) and distance readout
- Gauge forecast surfacing: ▲ rising arrows colored by forecast category, forecast crest line in popups, "Forecast to flood" pre-positioning list (soonest crest first), ▲ rising count in gauge tile
- Deep-linkable tabs (`?tab=alerts`); future-time fix in relative timestamps ("in 2h" vs "-39m ago")

## v0.2.0 — 2026-07-16
- Mobile-first layout: map-on-top, scrolling stat tiles, ≥42px touch targets
- Recency engine: freshness dots, stale re-verify badges (>6h), NEW-since-last-visit chips, smart sort (priority × freshness half-life) with newest/priority alternatives
- Locate-me map control; distance (10/25/50 mi) and time-window (1–24h) filters; per-card distance readout
- Navigate (Google Maps) and copy-coords actions on cards
- Last-good-data cache with "offline — cached as of" degraded mode; version stamp in footer

## v0.1.0 — 2026-07-16
- Initial release: Leaflet ops board with live NWS flood alerts (emergency
  detection), NOAA NWPS gauge flood categories + 48h stage sparklines,
  cited assistance-request seed feed with intake form, localStorage
  persistence, JSON export/import, monitor deep links, shelters/hotlines,
  stat tiles, dark/light themes.
