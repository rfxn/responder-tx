# Changelog — Responder TX Flood Ops Board

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
