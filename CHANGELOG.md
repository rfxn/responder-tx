# Changelog — Responder TX Flood Ops Board

## v0.99.89 · 2026-08-03 (map markers follow a live language switch)

-- Bug Fixes --
- [Fix] Switching language kept the old language on the wildfire, River Sentry siren
      and coastal station map markers, including the labels a screen reader reads.
      All three now repaint with the rest of the board

## v0.99.88 · 2026-08-03 (coastal stations map from the list, calm ones fold away)

-- New Features --
- [New] Tapping a tide station name in Coastal water levels turns on a new station
      layer and frames that station on the map, with its observed level, surge
      residual, trend and reading time in the popup
- [New] Stations sitting within half a foot of the predicted tide and not moving fold
      into a single row that says how many are hidden; one tap shows them. A station
      that could not be read, or that has no prediction to compare against, is never
      folded

## v0.99.87 · 2026-08-03 (a fault in the board stops reading as a fault in the feed)

-- Bug Fixes --
- [Fix] When the wildfire data arrived but the board could not draw it, the message
      said the incidents were unavailable, which pointed at the source. The source
      had answered. The board now says the failure is its own and that a reload may
      clear it

## v0.99.86 · 2026-08-03 (unused strings out, stale claims corrected)

-- Bug Fixes --
- [Fix] Master oversight styles an unrecognised member status consistently in the
      roster and on the map, drops an unreadable timestamp instead of printing
      "NaN", and no longer loads the roster twice when the panel opens
- [Fix] The ops chat said the session checks the inbox every 5 minutes; it is 3

-- Changes --
- [Change] Retired 25 unused interface strings from both languages, including the
         per-source camera layer names replaced by the regional camera rows
- [Change] The merged radar and forecast view is now the only layout; the unused
         alternate arrangement and its strings are gone

## v0.99.85 · 2026-08-02 (the popup stops denying what the map draws)

-- Bug Fixes --
- [Fix] Wildfire popups and the layer name said no perimeters are drawn while the
      board was drawing them. They now say what a mapped outline means, and that
      an absent one is not a claim the fire is small
- [Fix] Drive Mode searched only 9 of the 19 camera networks for the nearest
      cameras, so 174 cameras in Lubbock, Laredo, Corpus Christi, Del Rio, Eagle
      Pass, Galveston and four other networks never appeared
- [Fix] A wildfire layer that cannot be read now says so instead of reporting no
      incidents
- [Fix] A shared camera link no longer opens behind the first-run overlay
- [Fix] The board answered "bad request" when a notice, note or message could not
      be written to disk; a lost intake is no longer reported as operator error
- [Fix] A team marker with no timestamp showed a broken age; the age is omitted

-- Changes --
- [Change] The publish step of the data cycle is time-bounded, so a stalled publish
         costs one cycle instead of several
- [Change] Event configuration and playback crest data are checked on load, so a
         failed request is no longer read as an empty result

## v0.99.84 · 2026-08-02 (one road identity, live feed or snapshot)

-- Bug Fixes --
- [Fix] Roads: a closure starred while the TxDOT feed was down is found again when
      the feed returns, instead of being reported as absent from the closure list.
      Closures sharing a route are tracked separately, so starring one no longer
      stars the rest
- [Fix] Roads: a watched road is reported gone only when the source that covers it
      answered, and the unstar control is offered only for rows that were checked
- [Fix] Roads: the tab could fail to render at all when no hazards were listed
- [Fix] Roads: a closure whose limits change now repaints instead of leaving a star
      on the wrong row
- [Fix] Watchlist notices read correctly for a single item, in English and Spanish

-- Changes --
- [Change] Gauges: the Watching header appears only when it has rows; the notices
         below account for the rest
- [Change] Gauges: opening a starred gauge from the map no longer expands the whole
         normal gauge fold

## v0.99.83 · 2026-08-02 (the rows you are watching stay at the top)

-- New Features --
- [New] A star on each Gauges and Roads row pins that row to the top of its tab,
      kept on this device. Rows you are not watching keep the sort they already had
- [New] When a row you are watching is not on screen, the tab says which of three
      things happened: the view filter is hiding it, with one tap to show it; it is
      no longer in the data; or a source did not answer. A star is only ever removed
      when you remove it

## v0.99.82 · 2026-07-31 (a missing outline is not a missing fire)

-- Bug Fixes --
- [Fix] When the mapped fire outlines could not be read, the wildfire layer said the
      list of incidents was incomplete. Every incident was in fact listed and only
      the outlines were missing, which is what it now says

## v0.99.81 · 2026-07-30 (reported acreage you can see)

-- New Features --
- [New] A fire of 100 acres or more with no mapped perimeter now draws a dashed
      circle covering the acreage reported burning, around the reported origin.
      It is styled unlike a mapped perimeter on purpose: it says how much is
      burning, not the shape of the fire or how far it has spread. A real
      perimeter always replaces it

## v0.99.80 · 2026-07-30 (the wildfire layer draws again)

-- Bug Fixes --
- [Fix] Switching the wildfire layer on reported "wildfire incidents unavailable"
      and drew nothing. The fire perimeters added in the previous release stopped
      the layer rendering at all, so no fire appeared, including the incident
      points that had been working. Perimeters and points both draw again

## v0.99.79 · 2026-07-30 (fire perimeters, where anyone has mapped one)

-- New Features --
- [New] The wildfire layer draws the mapped edge of a fire where an agency
      publishes one, under the reported origin point rather than replacing it. The
      popup names how the edge was mapped and when, because it is a daily
      interpretation of imagery and not a survey
- [New] The legend and glossary say what a missing outline means: most fires never
      get an edge mapped, so no outline is a statement about mapping and never about
      the size of the fire

## v0.99.78 · 2026-07-30 (the did-not-load notice no longer covers a working board)

-- Bug Fixes --
- [Fix] The board could show the "did not load" notice over a map that had loaded
      perfectly. The check that detects a failed start also treated a blocked
      third-party tag as a failure, and the public site carries one that the
      board's own security policy blocks by design. Only the board's own startup
      now decides

## v0.99.77 · 2026-07-30 (the board says when it could not start)

-- New Features --
- [New] A board that cannot run in your browser now says so on the page, in
      English and Spanish, and tells you not to read the empty shell behind the
      notice. It needs Chrome or Android WebView 80 or newer, or iOS 13.4 or
      newer, which the About view now states as well
- [New] Opening the page with JavaScript turned off gives the same plain notice
      rather than a header above a blank map

## v0.99.76 · 2026-07-30 (the forecast timeline says when it has nothing to show)

-- Bug Fixes --
- [Fix] An empty forecast timeline could read as a dry forecast. When the model
      imagery fails to load, the radar legend now says the forecast is
      unavailable instead of stepping through blank hours

## v0.99.75 · 2026-07-30 (the update prompt now actually updates)

-- Bug Fixes --
- [Fix] The board could keep offering an update that never applied, reloading
      back into the same version each time. Reloading alone does not hand the
      page over to the new build while a tab is open, so both the automatic
      reload and the "tap to reload" button now hand over first

## v0.99.74 · 2026-07-30 (crest of record now covers the whole gauge network)

-- Bug Fixes --
- [Fix] Crest of record covered 216 of the 1018 gauges on the board, all of
      them in East Texas, so no gauge on the Nueces could be read against its
      own record during a flood. It now covers the whole network, 845 gauges
      with a published historic crest
- [Fix] The check on that file measured its age, not how much of the network it
      described, so a six day old file covering a fifth of the gauges passed.
      It now checks both

## v0.99.73 · 2026-07-30 (the board is findable, and says what it is)

-- New Features --
- [New] The page now tells a search engine what the board is and where it
      covers, with a title, description, canonical address and structured data
      naming the six open data feeds it publishes. A robots.txt and a sitemap
      are served for the first time
- [New] A machine-readable summary at /llms.txt for tools pointed at the site,
      leading with the fact that this is not an emergency reporting channel

-- Bug Fixes --
- [Fix] The page title was being replaced at load with just the board name, so
      a search engine only ever saw one word. The fuller title now stands, and
      an event name still takes over when the board is aimed at a named event
- [Fix] The page not found screen was English only and used the old name

## v0.99.72 · 2026-07-30 (where crossings are not covered, the board says so)

-- Bug Fixes --
- [Fix] Outside the area the crossing feeds cover, the Roads tab said no
      crossing hazards were reported, which read as an all-clear. It now says
      crossing status is not published for that area, so crossings there are
      unknown rather than clear, and to treat any flooded roadway as
      impassable. Road closures from TxDOT are statewide and unaffected

## v0.99.71 · 2026-07-30 (an empty Feed says whether anything is being held back)

-- Bug Fixes --
- [Fix] When every notice in the Feed was too old to show, the Feed said there
      were none. It now says how many are being held back and offers to show
      them, and the calm styling no longer renders over suppressed notices. The
      count was previously only a button in the filter row

## v0.99.71 · 2026-07-29 (the Notify me row stops crowding the alert list on a phone)

-- Changes --
- [Change] On a phone the Notify me row at the top of the Alerts tab is one
           slim line and no longer grows to several, so more of the alert list
           is visible without scrolling. On a phone that already has alerts
           switched on and delivering, the row steps aside entirely; Settings
           still holds the same entry
- [Change] The Notify me row and the Settings entry state the alert state in
           short form. When the board cannot reach the alert service they read
           that availability could not be checked, in place of the longer notice
           that the Notify me panel itself carries

## v0.99.70 · 2026-07-29 (the fire card reads properly, and a fire marker takes its own tap)

-- Bug Fixes --
- [Fix] The fire popup ran its labels and values together into one block of
      text. Each fact is now a row with its label in its own column, and the
      caveats sit below a divider instead of crowding the figures
- [Fix] Tapping a fire could open a nearby river gauge instead. Fire markers now
      sit above gauge markers, so the marker you tap is the one that answers
- [Change] The two caveat lines on the fire card are shorter

## v0.99.69 · 2026-07-29 (the fire layer covers Texas, and says more about each fire)

-- Changes --
- [Change] The wildfire layer now carries Texas and a 50 mile band beyond its
           border, instead of a rectangle that reached into New Mexico,
           Oklahoma and Arkansas. An incident beyond the band is not shown, and
           one inside it is marked as near Texas rather than presented as a
           Texas fire
- [Change] Fire now has its own group in the layer list, alongside water, rain
           and tropical, instead of sitting at the bottom with alerts and
           reports
- [Change] The wildfire layer description is shorter

-- New Features --
- [New] The fire popup is now a card with one row per fact, and adds cause,
      first reported time, protecting unit, how the incident is being managed,
      assigned personnel and incident number. A row appears only where the
      agency reported it, and an unreported size or containment is shown as a
      gap rather than written out as prose

## v0.99.68 · 2026-07-29 (fire products, and a wildfire layer)

-- New Features --
- [New] A wildfire layer, off until you turn it on, carrying incidents reported
      by Texas A&M Forest Service and the National Interagency Fire Center.
      Points, not perimeters. Acreage and containment appear only where the
      reporting agency stated them, and are shown as unknown otherwise
- [New] With no reported fires the layer says so, naming both sources and when
      they were read, so a quiet day cannot be mistaken for a layer that failed
- [New] Red Flag Warning, Fire Weather Watch and Dense Smoke Advisory are now
      carried, each with its own colour and symbol. Smoke is kept visually
      distinct from fire, because a smoke advisory often covers ground far from
      anything burning

-- Bug Fixes --
- [Fix] A county Fire Warning is now carried. These are written by a county or
      state agency and relayed through the weather service, and the board had
      been discarding them

## v0.99.67 · 2026-07-28 (a count of zero now means the board checked)

-- Bug Fixes --
- [Fix] Tab counts read "?" until the source has answered. A zero now means the
      board checked and found nothing, and is no longer shown before the check
- [Fix] A low-water crossing the curator has not re-confirmed inside the
      confirmation window is no longer presented as a current closure. Drive
      Mode, the risk view and the point inspector carry its age, and the
      crossing card counts only what the board can vouch for
- [Fix] When the jurisdiction closure feed or the live shelter feed cannot be
      read, the board says so instead of showing an empty list
- [Fix] A failure to load the curated notices, resources and crossings now
      appears in the data health note instead of passing as a clean load
- [Fix] Crest of record context returns on the next refresh after a failed
      fetch instead of staying blank for the rest of the visit
- [Fix] The river forecast chart no longer draws an empty forecast under a
      legend that claims one. It names the forecast that did not answer
- [Fix] When fallback radar imagery returns nothing, the timeline says the
      imagery is unverified instead of leaving a blank map under a confident
      timeline
- [Fix] A capped map export reports how many storm reports were cut. It
      previously reported that it carried everything in scope
- [Fix] Removed a resources link describing CrowdSource Rescue as activated for
      the Hill Country. The address was no longer valid

## v0.99.66 · 2026-07-27 (Notify me: alert setup gets its own place)

-- Changes --
- [Change] Alert setup has moved out of the settings menu into its own panel,
           called Notify me. Settings now carries a single row that opens it, and
           the Alerts tab carries one at the top
- [Change] The panel opens with one line per choice, where alerts go, what to
           send, and which gauges you follow, each opening in place. The full
           form is no longer stacked in a small scrolling menu
- [Change] The RSS feed and crest calendar moved into the same panel and are now
           full-size rows
- [Change] On a phone held sideways the panel now uses the full height of the
           screen, and the 911 notice stays visible while you scroll

-- Bug Fixes --
- [Fix] Turning alerts off no longer discards the gauges you follow and the
      places you added. Turning them back on restores what you had
- [Fix] Switching language now updates the alert panel instead of leaving it in
      the previous language

## v0.99.65 · 2026-07-27 (device alerts say what they will actually send)

-- Bug Fixes --
- [Fix] Turning device alerts on no longer reads as covered when nothing has
      been selected to send. A new subscription starts with no alert area, and
      the status line now says so plainly instead of showing the green on state
- [Fix] An alert area that is set but has every alert type switched off now says
      nothing will be sent
- [Fix] When the board cannot reach its own alert service, it now says the check
      failed. Showing nothing read as this board having no device alerts at all

## v0.99.64 · 2026-07-27 (the summary row steps aside on a phone held upright)

-- Changes --
- [Change] The summary cards no longer appear on a phone held upright, where the
           map and the list are already sharing the screen. They stay on desktop,
           on landscape tablets, and on a phone turned sideways
- [Change] The row leaves no empty band behind it above the tabs when it steps
           aside

## v0.99.63 · 2026-07-27 (a glance summary above the board tabs)

-- New Features --
- [New] A row of summary cards now sits above the board tabs whenever hazards
      are active: hazards in effect, gauges in flood, gauges rising, roads
      closed, and crossings closed or on caution
- [New] Each card opens what it counts. A lone hazard frames itself on the map,
      the gauge cards frame the gauges they speak for, and the road and crossing
      cards open their tab
- [New] A card whose source could not be read shows a question mark instead of a
      count, so an unreadable feed never reads as none

## v0.99.62 · 2026-07-27 (a slow source can no longer stall the refresh)

-- Changes --
- [Change] Each source in the 15-minute refresh now has a time limit, and the
           refresh as a whole has one. A source that runs past its limit is
           stopped and keeps its previous data with its own timestamp
- [Change] A source that was stopped for running too long is named as timed out
           in the refresh record, separately from one that is unreachable
- [Change] Everything that finished in time still publishes, so a single slow
           source no longer delays the following refresh
- [Change] The archive rebuild limits how long it spends fetching from upstream
           and resumes where it stopped on the next refresh. Nothing already
           recorded is dropped
- [Change] The public feeds are written so an interrupted refresh leaves the
           previous feed in place rather than a partial one

## v0.99.61 · 2026-07-27 (a source that times out gets another try)

-- Changes --
- [Change] The shelter list, road closures, low water crossing status, the public
           feeds and the CalTopo export now retry a source that times out before
           giving up. A brief upstream outage no longer costs a refresh, and a
           source that stays unreachable still keeps its previous data with its
           own timestamp rather than publishing anything new
- [Change] A release now confirms the site is serving every part of the new
           version before reporting success

## v0.99.60 · 2026-07-27 (a source that did not answer no longer reads as zero)

-- Bug Fixes --
- [Fix] The tropical cyclone tracker reported no active storms, with the source
      marked healthy, when its query to the hurricane service had actually
      failed. A failed query now reads as unavailable, and the tracker only
      reports a clear Gulf when the service really said so
- [Fix] The same correction is applied across every live source on the board.
      Flood warnings, river gauges, road closures, forecast flood points, storm
      reports, low water crossings, water levels and the camera list each now
      tell a failed request apart from a genuine zero, and none of them reports
      an empty result it did not receive
- [Fix] A road closure feed that answers with an unreadable list no longer
      contributes to the recently reopened list, which could show roads as
      reopened when the feed had simply failed
- [Fix] The Roads tab said no closures or crossing hazards were reported when the
      crossing list had failed to load. It now says the crossing hazards are
      unknown and states plainly that this is not a report that crossings are
      clear
- [Fix] The recovery and basin views showed zero gauges past crest and zero
      crest ahead when the crest data was unavailable. Both now say the crest
      position is unknown instead of showing counts of zero
- [Fix] Playback showed zero warnings in effect for a moment whose archive
      request failed. That moment now reads as unknown
- [Fix] The team panel could report no hospital or veterinary within 50 km when
      the facility lookup had timed out. A lookup that did not answer now says so
- [Fix] Place search reported no match when the geocoder had not answered. The
      two are now told apart
- [Fix] Importing a file that is not a board export now reports the failure
      instead of reporting zero records added

-- Changes --
- [Change] A source is marked healthy only after the board has checked that the
           response is the shape it asked for. A partly answered tropical fetch
           leaves the source ageing rather than showing as fresh

## v0.99.59 · 2026-07-27 (hazards in the exports and the archive)

-- New Features --
- [New] The CalTopo export, the KML layer, the self-refreshing KML link and the
      GeoRSS feed now carry tornado, severe thunderstorm and the other
      storm-based warnings, plus local emergency and evacuation orders, at the
      top of the priority order. Anyone subscribed from ArcGIS, Field Maps, ATAK
      or Google Earth sees them alongside the flood layers
- [New] All four exports now say when a product is in effect whose area is
      published as county and zone codes rather than as a polygon, naming the
      products and counting them. Their absence from the map no longer reads as
      the board seeing none
- [New] The public feed now carries tornado emergencies and particularly
      dangerous situation tornado warnings. If that check cannot reach the
      National Weather Service, the feed says so in its own item rather than
      staying silent
- [New] Playback captions severe thunderstorm and tornado warnings in the event
      story, not only flood warnings

-- Bug Fixes --
- [Fix] A tornado emergency in playback now reads as an emergency, with the same
      emphasis the live board gives it, instead of looking like an ordinary
      tornado warning. Its popup names the right emergency
- [Fix] Evacuation orders, civil emergency messages, 911 telephone outages and
      local area emergencies exported in the lowest style the board has. They now
      export as directives
- [Fix] An exported order credits the county or state agency that issued it. It
      previously credited the National Weather Service, which only relays them.
      An order that names no issuing agency says so

-- Changes --
- [Change] Emergency and tornado items are held ahead of the public feed's item
           limit, so a busy day cannot push them out

## v0.99.58 · 2026-07-27 (tapping a hazard focuses it)

-- Bug Fixes --
- [Fix] Tapping a warning in the hazard line at the top of the board now frames
      that warning on the map, flashes its outline, and opens its card in the
      Alerts tab. It previously only switched to the Alerts tab, which showed
      nothing about the hazard that was tapped
- [Fix] A hazard with no mapped extent opens its readable text when tapped in
      the hazard line, matching what its card already does

-- Changes --
- [Change] Tapping a storm report or a critical request in the hazard line now
           brings the map into view on a phone, so the jump is visible instead of
           happening behind a full-height panel
- [Change] Tapping a critical request in the hazard line scrolls to that request
           and marks it, rather than opening the feed at the top

## v0.99.57 · 2026-07-27 (local emergency and evacuation orders)

-- New Features --
- [New] The board now carries local emergency and evacuation orders: civil
      danger, evacuation immediate, shelter in place, hazardous materials, civil
      emergency messages, law enforcement warnings, 911 telephone outages and
      local area emergencies
- [New] Orders never fold out of the alert list at any distance, carry their own
      colour on the map and cards, and reach the hazard line and Drive Mode with
      an action taken from the order's own declared response: evacuate, shelter
      in place, avoid the area, be ready to move, or read the order
- [New] An order whose area is given only in words now says its extent is not
      mapped, instead of showing nothing on the map without explanation
- [New] A 911 telephone outage covering your position adds a notice above the
      disclaimer strip naming the agency, the affected area and the alternate
      number the alert published, or saying plainly that no alternate number was
      published. It still says to try 911 first, because an outage can be partial
      and service can return without a new alert. The 911 guidance everywhere
      else on the board is unchanged

-- Bug Fixes --
- [Fix] An order is credited to the county or state agency that issued it rather
      than to the National Weather Service, which relays these products but does
      not write them
- [Fix] An alert that names no sender is no longer attributed to the National
      Weather Service
- [Fix] Orders with no "warning" in their product name are no longer ranked and
      styled as advisories, the board's lowest tier

## v0.99.56 · 2026-07-27 (tornado and severe storm warnings on the live board)

-- New Features --
- [New] The board now carries tornado, severe thunderstorm, dust storm, snow
      squall and extreme wind warnings alongside flood products, on the same
      hazard layer and in the Alerts tab
- [New] Drive Mode leads each warning with the action to take rather than the
      hazard's name: take shelter for a tornado, pull off the road for a dust
      storm, do not cross for flooding. A warning covering your current position
      sits at the top of the list regardless of distance
- [New] Warnings carry the issuing office's impact tags: damage threat,
      particularly dangerous situation, whether a tornado was observed or radar
      indicated, peak gust and hail size
- [New] Storm-based warnings show which way the storm is moving and how fast, on
      the card, in the map popup, in the hazard line and in Drive Mode
- [New] Tornado, hail, funnel cloud, wildfire, dust storm and snow squall ground
      reports now reach the board's storm report layer

-- Changes --
- [Change] Each hazard type has its own colour and draws as a dashed outline for
           storm-based warnings, so a tornado polygon is no longer a flood
           polygon in a different shade
- [Change] The hazard line admits warnings only, never watches or advisories,
           collapses repeat messages about one warning into a single item, caps a
           full pass at a glance and re-checks expiry between refreshes
- [Change] The Alerts tab groups by warnings, watches and standing conditions,
           and what counts as near is now set per hazard: about an hour of storm
           travel for a moving warning, coverage for the rest
- [Change] A warning is judged fresh or stale against its own declared lifetime,
           so a tornado warning with a 20-minute life ages far faster than a
           multi-day flood warning
- [Change] The alerts feed refreshes every 60 seconds while a moving storm
           warning is open nearby, and returns to the normal interval when none is
- [Change] The map layer and its Alerts tab heading are named for hazards rather
           than floods

## v0.99.55 · 2026-07-27 (alerts run to the end of the hazard)

-- Bug Fixes --
- [Fix] An alert now stays on the board until the hazard ends rather than until
      its next update is due. A flood warning whose update was due tonight but
      which runs through Wednesday stays on the map, in the ticker, in the risk
      answer and in the all-clear check for its full length
- [Fix] A warning issued until further notice no longer expires on its own. The
      board shows it as in effect until further notice instead of counting down
      to an update deadline
- [Fix] The ticker no longer hides a flash flood emergency that carries no end
      time, which every other surface was showing
- [Fix] The Alerts tab, its count badge, Drive Mode, the SITREP and the map point
      check now all agree on which alerts are still in effect. An alert past its
      end folds into the expired list rather than leaving the tab
- [Fix] An alert of an unrecognised severity no longer outranks a flash flood
      emergency in the risk answer or the map point check

-- Changes --
- [Change] Alert cards, popups and the SITREP name the counties inside the area
           of operations and state the number outside it, in place of printing a
           neighbouring state's counties as if they were ours
- [Change] Drive Mode leads with the two nearest counties and counts the rest,
           in place of one line of every county an alert names
- [Change] Alert cards, popups and the reader show the time the hazard ends
           rather than the time the next update is due

## v0.99.54 · 2026-07-26 (road closures survive an upstream outage)

-- New Features --
- [New] Road closures stay on the board when the live TxDOT feed is unreachable.
      The most recent saved closure set is served instead, labelled as a snapshot
      and timed from when it was taken
- [New] The Roads tab reports an unknown closure set when neither the live feed
      nor a saved snapshot can be read, in place of reporting no closures

-- Changes --
- [Change] Snapshot closures are listed and mapped but left out of the Roads
           count, and the closure feed still reads as down while one is serving
- [Change] Road reopenings are detected from the live feed only, so a snapshot
           can never report a road as reopened
- [Change] The all-clear is withheld while the closure set is unknown

## v0.99.53 · 2026-07-26 (a camera network cannot empty quietly)

-- New Features --
- [New] Release checks flag a camera inventory or crest record set that has gone
      too long without a refresh to still describe what is out there

-- Bug Fixes --
- [Fix] Cameras stay on the map when the published inventory cannot be read. The
      board keeps the cameras it has rather than publishing an upstream dropout
      as a retirement
- [Fix] A camera network that empties, or that loses most of its cameras at once,
      is no longer published. Each network is now measured against what it last
      carried
- [Fix] Crest of record data is kept when a refresh returns far fewer records
      than the set it would replace

## v0.99.52 · 2026-07-26 (what could not be read is not reported as nothing)

-- Bug Fixes --
- [Fix] Reconstructed playback leaves out a river gauge whose flood levels the
      board could not retrieve, in place of drawing it as not in flood for that
      period. The retrieval is retried on a later cycle
- [Fix] The map exports name every source that did not answer, in the CalTopo
      file, both KML files and the GeoRSS feed. A layer that failed to load is
      reported as missing rather than shown as empty
- [Fix] The crest summary says when it cannot establish the start of the window
      it covers, instead of reporting a later start than the record holds
- [Fix] Playback and the crest summary keep their previous copies when the
      already published record cannot be read, so nothing the board has already
      published is dropped
- [Fix] A road closure snapshot that cannot be completed marks the update cycle
      degraded, so the source that stopped refreshing is named

## v0.99.51 · 2026-07-26 (an unchecked feed says so, and eight days offline)

-- Bug Fixes --
- [Fix] The RSS feed states when the flash flood emergency check could not be
      completed. A failed check published as an all clear before, carrying no
      emergency entries and nothing to tell it apart from a genuine quiet period
- [Fix] The RSS feed carries the board name and its standing 911 note as its
      title and description, in place of the text of whichever entry happened to
      be published last
- [Fix] The RSS feed and the crest calendar keep their previous copies when
      river or notice data cannot be read, rather than publishing without crests
- [Fix] Reported low-water crossing closures are kept when the source replies in
      a form the board cannot read, instead of publishing an empty list that
      reads as no crossing closed
- [Fix] Saved playback covers the full eight days offline. Recent days had grown
      past the download allowance, leaving about two

-- Changes --
- [Change] The pre-publish checks measure saved playback depth against the real
           archive size, so the declared day count and the download allowance
           cannot drift apart

## v0.99.50 · 2026-07-26 (the whole closure list, and crests kept in playback)

-- Bug Fixes --
- [Fix] The road closure layer loads every closure in the area. A large closure
      list used to stop short, leaving closures off the map and out of the Roads
      tab
- [Fix] A partial closure load no longer marks the missing roads as recently
      reopened. The board keeps the last confirmed recovery list and says on the
      map and in the Roads tab that the closure list is incomplete
- [Fix] The road closure archive keeps its last complete capture rather than
      recording a short one, so a closure missing from a reply is no longer
      written into playback as having cleared
- [Fix] Reconstructed playback history keeps the frame holding each river's
      crest. This applies to reconstruction from here on; crest frames already
      thinned out of the record are not restored

-- Changes --
- [Change] The pre-publish checks validate the live area-of-operations settings
           rather than the last committed copy, so a retarget is checked before
           it goes out

## v0.99.49 · 2026-07-26 (the USGS layer reports again)

-- Bug Fixes --
- [Fix] The USGS gauge layer reports again, across the whole area of operations.
      Its raw stage readings are available once more as a backstop for sites the
      main gauge feed has nothing for, which is when the board leans on them most
- [Fix] If only part of the area answers, the USGS layer now says so on the
      readings it did get instead of presenting a short sweep as a complete one

-- Changes --
- [Change] The USGS layer refreshes on its own six-minute cycle, so its feed chip
           can read a few minutes older than the others without anything being
           wrong

## v0.99.48 · 2026-07-26 (the whole board, in every export)

-- Changes --
- [Change] The CalTopo import, the live KML layer and the GeoRSS feed now carry
           the whole board rather than a 500-feature slice. Every alert, crest,
           gauge, road closure and low-water crossing publishes, and the exports
           are held to a size that imports cleanly in ArcGIS Online, ATAK and
           Google Earth. When an export still has to be shortened it says so, in
           all three formats, and drops the lowest-priority features first
- [Change] A road closure made up of separate stretches now says how many. The
           distance shown is the total of those stretches, not one continuous
           barricade

-- Bug Fixes --
- [Fix] A shared note link opened on the public board now says Field Notes is not
      published there. It used to do nothing at all

## v0.99.47 · 2026-07-26 (the view you set is the view you get back)

-- New Features --
- [New] The board keeps the view you set. The map layers you have switched on,
      where the map is looking, the area chip, and the tab, filters and sort all
      come back after a hard refresh or an app update
- [New] Saving a map area offline has a detail setting: the current view on its
      own, one zoom deeper, or two. The number of tiles is shown before the
      download starts, so the cost is clear on a metered connection
- [New] The area chip travels in a shared link

-- Changes --
- [Change] Tapping a rising to major item on the hazard line frames that gauge,
           marks the rising gauges on the map, and opens them in the Gauges tab.
           A device set to reduce motion gets a still marker instead of a pulse
- [Change] A shared link takes precedence over the kept view for the load it
           opens. A saved layer that no longer exists is dropped

-- Bug Fixes --
- [Fix] An offline save now says what happened. A partial save, a save stopped by
      full device storage, and a save that fetched nothing are each reported
      rather than reading as complete, and saved tiles the browser has since
      reclaimed are reported too

## v0.99.46 · 2026-07-26 (who runs this board, and what it keeps)

-- New Features --
- [New] Settings, then Help, now opens "About this board": who builds and
      maintains it, what it is and is not, how it stays honest about stale and
      forecast data, where each layer's data comes from, and exactly what the two
      opt-in relays store. English and Spanish
- [New] The about surface states the device-alert promise plainly, best effort,
      not a Wireless Emergency Alert, and never a replacement for 911, and links
      the source repository and the GNU GPL v2 license

-- Changes --
- [Change] The update check reads a small version file instead of the whole
           changelog, so a board left open all shift uses far less data in the
           background. What's new still shows the complete history

## v0.99.45 · 2026-07-26 (a live layer in the tools you already run)

-- New Features --
- [New] The board publishes its curated map as a KML layer at a fixed address.
      Added once in ArcGIS, ATAK or Google Earth, the layer re-checks the board
      about every 15 minutes on its own, so it stays current without being
      re-imported
- [New] A GeoRSS feed of the same features, for ArcGIS Online and feed readers
- [New] Both formats carry what the GeoJSON export carries: the source for every
      feature, its update time, the generation time, and a plain statement on
      the layer name when the export is capped and how many features were left
      out

-- Changes --
- [Change] Share now lists three addresses for the same curated selection,
           GeoJSON for CalTopo, KML for a self-updating layer, and GeoRSS,
           each saying what it is for

## v0.99.44 · 2026-07-26 (one door per view)

-- Changes --
- [Change] Views is the one place to pick a view. Playback is no longer listed in
           the map layers sheet and Crest summary no longer has its own button in
           the Gauges tab; both open from Views. The playback pill on the map
           still opens playback in one tap, and Drive keeps its header button
- [Change] With the bottom panel expanded to full height on a phone, the map
           controls stay on screen instead of being cut off, so Views is
           reachable without collapsing the panel first

-- Bug Fixes --
- [Fix] The note about Export and CalTopo moving to Share pointed at a button
      that is no longer there. It names Settings, where the RSS feed and the
      crest calendar are

## v0.99.43 · 2026-07-26 (lighter on a weak signal)

-- Changes --
- [Change] A first visit downloads noticeably less of the board. The live camera
           player, the QR code generator, and the live team tools are fetched
           when you open them rather than on every visit, so the map and the
           gauges arrive sooner on a weak connection
- [Change] A live camera on a slow connection now shows that its player is
           loading, and says plainly if the player cannot be reached. A browser
           that simply cannot play live video keeps its own separate message
- [Change] A QR code that cannot be built without a connection says so and points
           to the link instead, rather than leaving an empty space
- [Change] A team link opened on a connection too weak to load the team tools
           opens the Team tab with the reason, instead of showing nothing

## v0.99.42 · 2026-07-26 (one settings door in the header)

-- Changes --
- [Change] The header alerts bell is gone. It opened the same Settings panel the
           gear does, so the two sat side by side as one door counted twice. The
           gear is the single way in, and Alerts stays the first group inside it
- [Change] The gear carries a small dot when alerts are off on a device that can
           turn them on. Enabling alerts clears it. A device that cannot receive
           them, iOS outside an installed app, a blocked permission, never shows
           it

## v0.99.41 · 2026-07-26 (usable with gloves, in sunlight, one hand, and a screen reader)

-- Changes --
- [Change] The close button on every panel and dialog, the Feed filters, the
           rainfall legend buttons, the map area and layer chips, and the sheet
           resize control are full-size tap targets on a phone or tablet now
- [Change] A device set to reduce motion no longer gets the looping animations.
           The live dot, major gauge markers, the data currency bar, the
           emergency banner, cut-off area circles, the locating chip and the
           playback crest line hold still; colour and meaning are unchanged
- [Change] In map-full mode the rainfall, radar, surge and inundation legends
           sit clear of the sheet resize control instead of behind it
- [Change] The emergency banner and the data currency bar are announced by a
           screen reader now. Drive Mode's location freshness line no longer
           interrupts a screen reader once per second
- [Change] The Settings panel describes itself to assistive tech as the panel
           the Settings button opens, so it no longer offers arrow-key
           navigation it does not have
- [Change] Map legend text no longer shrinks below 10px on a small screen

-- Bug Fixes --
- [Fix] Tapping a card on a phone while the list covers the screen now opens
      the map to the half-screen split, so the pin it flies to is visible
- [Fix] Aged and reopened rows are muted with a readable colour rather than a
      fade, so their text stays legible in both themes
- [Fix] Keyboard focus draws a visible ring. Map controls no longer show focus
      and hover identically

## v0.99.40 · 2026-07-26 (the Alerts tab tells you what is near you)

-- New Features --
- [New] The Alerts tab now leads with the alerts nearest you and shows each
      one's approximate distance. It measures from your location if the board
      already has it, otherwise from the places set as your alert area
- [New] Alerts gained the same In view control the Feed and Gauges tabs have.
      Turning it on anywhere scopes all three to the current map view and
      follows it as you pan

-- Changes --
- [Change] Alerts outside that area now fold into a one-tap group at the bottom
           of the list instead of sitting in the middle of it. Nothing is
           removed: every active alert stays in the list, and a Flash Flood
           Emergency is never folded no matter how far away it is
- [Change] The alerts header names the area it is ordering by, and says most
           severe first when it has no area to measure from
- [Change] Jurisdiction-reported crossing closures now appear on the map on
           their own when that feed reports a change within the last two days.
           They stay listed in the Roads tab either way

-- Bug Fixes --
- [Fix] The all-clear line now names the area it checked and reads only that
      area's alerts, gauges and road closures. It stays silent when there is no
      gauge in range to read

## v0.99.39 · 2026-07-26 (the Roads tab lists every road hazard the board holds)

-- New Features --
- [New] The Roads tab now lists live TxDOT DriveTexas closures and conditions
      and jurisdiction-reported crossing closures alongside the curated
      crossings, in one list. Each row names its operator and carries its own
      provenance badge, and tapping a row focuses it on the map
- [New] The list sorts nearest first when the device has a location, newest
      first otherwise

-- Changes --
- [Change] The Roads count now covers everything the tab lists, not the curated
           crossings alone. Rows the board cannot confirm right now stay listed
           and mapped and stay out of the count, and the tab says how many those
           are
- [Change] A TxDOT row reads Since, a curated row reads Updated, and a
           jurisdiction row reads Report last changed, because those three feeds
           timestamp three different things
- [Change] An open curated crossing no longer appears in the Roads list. It
           stays on the map

-- Bug Fixes --
- [Fix] The crossing inventory layer now loads every low-water crossing in the
      area instead of the first 4,000, roughly 8,300 statewide. If a load is
      ever cut short, the layer says it is partial in its map credit and in
      every crossing popup

## v0.99.38 · 2026-07-26 (device alerts follow an area you pick)

-- New Features --
- [New] Device alerts now carry an alert area: statewide, or near up to five
      places you add, each with a 5, 10 or 25 mile radius. Flash Flood Emergency
      and river gauge alerts fire only where that area reaches
- [New] A place is added only by tapping Use my current location or copying a
      saved place. The card lists what is stored with the subscription: the
      coordinates rounded to about a kilometer and the radius, no address and no
      label. Each place can be removed on its own

-- Changes --
- [Change] A new subscription starts with no alert area, so it sends no
           area-wide alerts until statewide or a place is chosen. The card and
           the welcome notification both say so. Subscriptions made before this
           release keep statewide coverage
- [Change] Followed gauges are unchanged by the alert area: a followed gauge
           alerts at its own threshold wherever it is, and the most sensitive
           applicable threshold still wins

## v0.99.37 · 2026-07-26 (device alerts open to everyone, one tap from the header)

-- New Features --
- [New] A 🔔 button in the header opens Alerts directly: turn on notifications
      for this device, or subscribe by RSS or the crest calendar
- [New] Device alerts are available to every visitor whose browser supports
      them, instead of only to devices that arrived by an alert link

-- Changes --
- [Change] The RSS feed and the crest calendar moved from Share and export into
           the Alerts group, so every way of being told is in one place
- [Change] Alerts now sits above the display preferences in Settings

-- Bug Fixes --
- [Fix] The alerts card no longer appears when the alert service is unreachable,
      in any of its states

## v0.99.36 · 2026-07-26 (road reopenings follow the segment, not its condition)

-- Bug Fixes --
- [Fix] A road is no longer shown as reopened when the state only re-codes its
      condition, such as a flooded segment re-listed as damaged while it stays
      closed. A road is marked reopened only when its segment leaves the live
      closure feed
- [Fix] A condition change now updates the road in place, so the closure list
      and the reopened card agree on how the segment is currently coded

-- Changes --
- [Change] Reopened-road history kept by earlier versions is cleared once on
           this upgrade; the board rebuilds it from the live feed

## v0.99.35 · 2026-07-26 (emergency banner on open, honest Feed headline)

-- Bug Fixes --
- [Fix] A flash flood emergency already in effect when the board is opened now
      raises the red banner and the red tab marker. The banner says the
      emergency is in effect, and reads as new only for one that arrives while
      you are watching
- [Fix] An empty Feed no longer reads as "all clear". It says the Feed has no
      notices and points to Alerts, Gauges and Roads for hazard status, and its
      calm styling appears only when those feeds are quiet
- [Fix] The footer safety line now carries the full 911 wording in both
      languages instead of a shortened version

-- Changes --
- [Change] The recovery posture line sends you to Roads rather than to a tab
           that no longer exists

## v0.99.34 · 2026-07-25 (border bridge and Port of Galveston cameras)

-- New Features --
- [New] 16 international bridge cameras on the Rio Grande: eight at Laredo
      covering Gateway to the Americas, Juarez-Lincoln, Colombia Solidarity and
      World Trade, six at Eagle Pass covering Bridge I and Camino Real, and two
      at the Del Rio bridge
- [New] The Port of Galveston cruise Terminal 16 view on the ship channel

-- Changes --
- [Change] Bridge cameras are placed on the bridge they watch, not on a camera
           position, which no operator publishes. The viewer says so
- [Change] The international bridge label no longer says "live". The live or
           snapshot chip beside it already states which one a camera is

## v0.99.33 · 2026-07-25 (National Park Service cameras)

-- New Features --
- [New] Six National Park Service cameras join the camera layer: Lake Meredith
      from Sanford Dam, the Sanford-Yake area and the Alibates visitor center in
      the Panhandle, Diablo East on Amistad Reservoir, Malaquite Beach on Padre
      Island, and Panther Junction in Big Bend
- [Change] These cameras are placed on the park facility they look from. The
           Park Service publishes no camera position, and the viewer says so

## v0.99.32 · 2026-07-25 (southern New Mexico cameras)

-- New Features --
- [New] 25 New Mexico DOT cameras covering the reach above Texas: the I-10
      corridor from the Arizona line into El Paso, I-25 and I-10 through the
      Mesilla Valley at Las Cruces where the Rio Grande runs, and US 70 at
      Apache Summit and Organ Mountain Pass
- [New] A camera whose operator rewrites its snapshot file in place is retried
      before the board calls it unavailable

## v0.99.31 · 2026-07-25 (one more El Paso bridge view)

-- New Features --
- [New] An eighth City of El Paso international-bridge camera, a second Santa Fe
      St. Bridge view, joins the live bridge set

-- Bug Fixes --
- [Fix] A weather camera whose publishing gap ran longer than the board's search
      window returned no picture at all. The window the viewer searches is now
      wider than the one used to decide the camera is working, so a slow camera
      still opens

## v0.99.30 · 2026-07-25 (Hill Country and Guadalupe weather cameras)

-- New Features --
- [New] 30 WeatherBug weather cameras join the camera layer, including Camp
      Verde Ranch at Center Point on the upper Guadalupe, Cuero ISD and two
      Victoria cameras on the lower Guadalupe, Harris County OHSEM, Madison
      County OEM and Edna ISD

## v0.99.29 · 2026-07-25 (Lubbock city cameras)

-- New Features --
- [New] 59 City of Lubbock traffic cameras join the camera layer, the board's
      first camera coverage on the South Plains beyond the TxDOT freeway set.
      Each is named for its intersection

## v0.99.28 · 2026-07-25 (Gulf Coast cameras)

-- New Features --
- [New] 33 Saltwater Recon coastal cameras join the camera layer, adding the
      board's first camera coverage at Port O'Connor, Surfside, Freeport,
      Quintana, San Luis Pass and Trinity Bay, plus Galveston, Bolivar, Clear
      Lake and Kemah
- [New] 4 City of Corpus Christi cameras join the camera layer, including the
      Calallen Reservoir saltwater barrier on the Nueces River and Park Road 22,
      the only road off North Padre Island

-- Changes --
- [Change] A camera whose operator publishes no capture time now says so in the
           viewer instead of showing an empty capture row, and it no longer
           carries the ordinary snapshot badge. Its age cannot be checked, so
           the viewer states that and asks for a refresh before the image is
           acted on

## v0.99.27 · 2026-07-25 (crossings reported closed, and a wider tide picture)

-- New Features --
- [New] A new layer shows low-water crossings that a Central Texas jurisdiction
      reports as closed or caution, across 39 reporting jurisdictions. Each one
      names the jurisdiction and shows when its report last changed. Off by
      default, in the water group of the layers sheet
- [New] The board now covers 32 NOAA tide stations, up from 14, adding Port
      Arthur, Rainbow Bridge, High Island, Rollover Pass, the Galveston Railroad
      Bridge, San Luis Pass, Sargent, Matagorda City, Port Lavaca, Copano Bay,
      the Corpus Christi bay stations, Realitos Peninsula and South Padre Island

-- Bug Fixes --
- [Fix] Three configured tide stations returned no data and are replaced by
      working neighbours: Freeport by Freeport Harbor, Bob Hall Pier by Packery
      Channel, and Port Mansfield, which does not publish on the datum the board
      reads

-- Changes --
- [Change] The reported-closure layer states what its timestamps mean: the feed
           records when a report last changed, not that anyone rechecked it, so
           a crossing carries the age of its own report and none of them are
           counted as confirmed hazards. Anything unchanged for more than two
           days is marked to confirm before routing
- [Change] The all-locations crossings layer now points at the reported-status
           layer instead of only noting that it has no status of its own
- [Change] Tide stations are fetched a few at a time rather than all at once, so
           a long station list degrades slowly instead of the whole card failing
           together

## v0.99.26 · 2026-07-25 (TxDOT district camera snapshots open on the public board)

-- Bug Fixes --
- [Fix] TxDOT district camera snapshots now open on respondertx.org. All but two
      of the 861 cameras in that layer returned an error instead of an image,
      because any camera whose name carries a space, an ampersand or an at-sign
      was rejected before the image was ever fetched. The same cameras have
      always worked on the LAN board

## v0.99.25 · 2026-07-25 (cameras we could already reach, now reachable)

-- New Features --
- [New] 28 more TxDOT district cameras are on the map, most of them along the
      Beaumont flood corridor: Orange, Bridge City, Silsbee, Kountze, Jasper,
      Liberty, Dayton, Port Arthur and Lumberton, plus El Paso, Yoakum and Tyler
- [New] 19 more City of Arlington cameras are on the map. They were in the city
      feed all along without a usable position in the columns the board read

-- Changes --
- [Change] Houston TranStar cameras the operator publishes with no position are
           now named in the build log instead of vanishing without a trace.
           Eleven cameras on US-290 Northwest and the Westpark Tollway are
           affected, and they stay off the map until a position is available,
           because a camera pinned to the wrong intersection is worse than one
           that is missing

## v0.99.24 · 2026-07-25 (the camera list holds through an upstream dropout)

-- Bug Fixes --
- [Fix] Cameras no longer drop off the map when a TxDOT district feed comes back
      short. That district keeps its last known set until the feed recovers, and
      releases it as genuinely retired if the feed stays short for two weeks. A
      district losing cameras a few at a time still shows the loss straight away
- [Fix] A hand-checked flood, bridge or port camera that misses one check is
      checked again before it is dropped, so a single timeout no longer takes a
      working camera off the map. One Hays County flood camera is back

## v0.99.23 · 2026-07-25 (the hazard line scrolls, and nothing sits still beside it)

-- Changes --
- [Change] The static hazard item and the count button beside the scrolling feed
           are gone. The feed is the whole line now
- [Change] The loop carries every hazard, worst first, so the first thing that
           scrolls past is still the most serious one and nothing waits behind a
           button
- [Change] On a phone the moving items are the only thing in the line to tap, so
           they now meet the same touch size as the rest of the board. The line
           is shorter than it was
- [Change] A device set to reduce motion gets the full hazard list as a still,
           readable list rather than the single item it used to show

## v0.99.22 · 2026-07-25 (one route to shelters and hotlines)

-- Changes --
- [Change] The shelters button has been taken off the top bar. Shelters and
           hotlines opens from the gear menu, which was already there, and the
           top bar keeps the room

## v0.99.21 · 2026-07-25 (out-of-state cameras split by state)

-- New Features --
- [New] Cameras outside the Texas regions are grouped by the state they sit in:
      New Mexico, Oklahoma, Arkansas and Louisiana, each with its own layer and
      its own switch, under a new Outside Texas group
- [New] The new group carries the same switches as the Texas bands, including
      the partial state when only some of its regions are on

-- Changes --
- [Change] A camera's group comes from its own coordinates, so a camera added
           upstream lands in the right one with no list to keep up to date
- [Change] Anything that falls in no named state keeps the residual row, still
           counted and still shareable in a link
- [Change] Each new row states how many cameras it holds and how many of those
           are live video, as the Texas rows do
- [Change] Camera sub-category headings in the layers view now use the same type
           as every other heading in that sheet, and set their own tap-target
           height instead of borrowing it from the switch beside them

## v0.99.20 · 2026-07-25 (one hazard line at the top, not two)

-- Changes --
- [Change] The status row above the tabs is gone. The scrolling hazard line
           already names each ranked item with its place, level and rate, so the
           counts stacked above it said the same thing twice
- [Change] The open-shelter count moved into the header, one tap from the
           shelters and hotlines sheet, instead of sitting last in a chip row
           that scrolled sideways
- [Change] The all-clear line stays and now shows only when the hazard line has
           nothing to carry, so a calm board still says it is calm
- [Change] The Legend section that described the retired chips now describes
           what each symbol means wherever it appears on the board

## v0.99.19 · 2026-07-25 (two deploys can no longer stage into one directory)

-- Bug Fixes --
- [Fix] A deploy run by hand while the 15 minute cycle was deploying could die
      partway through building its upload, because both were assembling it in
      the same directory

-- Changes --
- [Change] Each deploy now builds its upload in a directory of its own and
           removes it on the way out, including when the deploy fails. The
           directory can still be pinned when the built files need to be kept

## v0.99.18 · 2026-07-25 (the automatic recovery leaves the working copy as it found it)

-- Bug Fixes --
- [Fix] An interrupted automatic ops-chat recovery could leave half-finished
      edits in the board's working copy, and the data cycle could publish from
      them

-- Changes --
- [Change] The automatic recovery does not start while the working copy carries
           uncommitted changes. It logs what it found, says so in the ops chat,
           and waits
- [Change] Anything a recovery run leaves uncommitted is set aside as a patch
           and the working copy is restored. Files the data cycle regenerates
           itself are never touched

## v0.99.17 · 2026-07-25 (call the number, navigate to the shelter)

-- New Features --
- [New] Hotline numbers in Shelters & hotlines are now tap to dial. 911 is
      listed first
- [New] Shelters with a known location carry a Navigate button, the same one the
      notice cards use

-- Changes --
- [Change] Hotlines are listed above shelters, so the number to call is the
           first thing in the sheet rather than the last
- [Change] A hotline entry that is not a dialable number is shown as plain text
           instead of a link that goes nowhere

## v0.99.16 · 2026-07-25 (a stale board names the source that stopped answering)

-- Bug Fixes --
- [Fix] The freshness monitor reads the data cycle's sign-off in every form it
      takes, not just one. A cycle that ran, found a source not answering, and
      therefore had nothing new to publish was reported as a dead cron or a dead
      host, which is the wrong place to send whoever is on call

-- Changes --
- [Change] The alert now separates the two upstream cases: a cycle still
           publishing what it can, and a cycle that published nothing because
           too little refreshed. Both name the sources involved
- [Change] The runbook lists the four sign-offs, which of them publish, and what
           to do for each of the two upstream causes

## v0.99.15 · 2026-07-25 (every gauge on the map is in the Gauges list)

-- New Features --
- [New] The Gauges list has a fold for the gauges NWPS reports without a usable
      flood category, 411 of the 1018 statewide today. It counts them by state:
      no thresholds defined, data not current, and out of service
- [New] Those cards say which state the gauge is in where a severity word would
      go, and what that state means, so they never read as normal

-- Bug Fixes --
- [Fix] Gauges that show on the map but report no flood category could not be
      found in the Gauges list at all
- [Fix] The gauge popup's open in gauges list button lands on the gauge you
      tapped. For a gauge with no flood category it found nothing, switched the
      Show gauges reading normal filter on the way, and left you on a list
      without it
- [Fix] A gauge with no flood category no longer shows a crest of record line
      off a forecast that is not current either

-- Changes --
- [Change] In view scopes the new fold the same way it scopes the rest of the
           list, and is turned off when it is the only thing hiding a gauge you
           asked to open

## v0.99.14 · 2026-07-25 (Playback replays with no signal)

-- Bug Fixes --
- [Fix] Playback works offline again. Opening it with no signal reported the
      history archive as unavailable, on installs added since the archive
      moved to its current form
- [Fix] An install that has never opened Playback now still has recent days to
      replay the first time it loses signal

-- Changes --
- [Change] The archive is kept offline the way it is published: the day files
           are held one copy per day and the index is refreshed whenever there
           is a connection. A day that is not held is drawn as an unloaded
           stretch on the timeline, the same as before, rather than filled in
- [Change] The offline copy is topped up at most twice a day, is capped by
           size, and is skipped entirely on a connection set to save data

## v0.99.13 · 2026-07-25 (the hazard line scrolls again, and shows up in landscape)

-- Changes --
- [Change] The hazard line scrolls again, on every platform. The
           highest-priority hazard stays pinned in place at the left and does
           not move, so it is readable at a glance; the rest of the list loops
           beside it
- [Change] The scroll stops while you hover or tab into it, and the count
           button still opens the whole list as a static list at any time
- [Change] A device set to reduce motion gets no scrolling at all: the pinned
           hazard takes the full width and the rest stays one tap away
- [Change] On a phone the moving list takes its own row under the pinned
           hazard, rather than a narrow strip beside it

-- Bug Fixes --
- [Fix] The hazard line is visible with a phone held sideways. It was hidden
      outright in that layout, which is the dash-mount posture it matters most
      in
- [Fix] The flash flood emergency banner no longer covers the hazard line
      underneath it. The banner now sits below the line at every screen size,
      in both languages

## v0.99.12 · 2026-07-25 (one switch for every camera, one per region group)

-- New Features --
- [New] An All cameras statewide switch at the top of the Cameras group turns
      every camera region on or off in one action, and reports how many
      regions are on, how many cameras that is, and how many stream video
- [New] Each camera region group (Gulf Coast, Central Texas, North and East
      Texas, West Texas) has its own switch covering the regions inside it

-- Changes --
- [Change] The two new switches show a third state when only some of their
           regions are on: the count reads "12 of 13 on" and the switch sits
           between off and on. Turning regions on one at a time leaves the
           statewide switch showing partial, and tapping it completes the set
           rather than clearing it
- [Change] A group header now reads "3 of 4 on" instead of "3 on"
- [Change] With every camera region on, a shared link carries `camreg=all`
           instead of a list of region names, so the link still means statewide
           if regions are added later. Links already shared keep working
- [Change] Above two camera regions, the map's layer chips collapse to one
           chip naming the count, whose ✕ clears them all. Thirteen chips
           covered three rows of the map

## v0.99.11 · 2026-07-25 (a shared link keeps the siren layer on)

-- Bug Fixes --
- [Fix] Sharing a link with River Sentry siren sites switched on dropped the
      layer, so the person opening the link saw a different map. It now travels
      in the link as `rs=1`, matching the other layers that ship off by default

## v0.99.10 · 2026-07-25 (River Sentry siren sites, as reported locations)

-- New Features --
- [New] New map layer under Water: River Sentry flood siren sites, 105 towers
      across 26 Hill Country sites. Off by default. The layer states that it
      carries reported locations from a public map export with no named author
      and no date, and that no feed says whether a tower is powered, working or
      still standing. The popup names the site, how many towers the map places
      there, and where the data came from
- [New] The map legend and the glossary both name the siren-site marker

-- Changes --
- [Change] The siren layer hides during playback, like shelters, because an
           undated location snapshot cannot be redrawn as it stood on a past
           date

## v0.99.9 · 2026-07-25 (the changelog says what changed, not how it was found)

-- Changes --
- [Change] Entries from v0.97.81 forward are rewritten to state the change and
           stop there. Root-cause narration, discovery stories, severity
           commentary, before and after measurements and internal names are
           gone, in the file and in the in-app What's new list. Every
           correction to something the board asserts to a reader is kept

## v0.99.8 · 2026-07-25 (a live camera and a still photo stop wearing the same icon)

-- New Features --
- [New] The map legend has a Cameras key showing the live-stream marker and the
      still-photo marker

-- Changes --
- [Change] Camera markers separate live video from still photos: a filled
           marker with a play triangle streams, a dashed outline with a camera
           glyph is a still. The popup, the Drive Mode camera rows and the
           marker's hover and screen-reader label all name which one it is
- [Change] A camera region row in the layer sheet reports how many of its
           cameras stream video, alongside the total
- [Change] Camera markers no longer carry a per-operator ring colour; the
           operator is named in the popup, the credit line and the Drive Mode row

## v0.99.7 · 2026-07-25 (the Austin low-water-crossing cameras are back)

-- New Features --
- [New] The 26 Austin low-water-crossing flood cameras are on the board again,
      in the Austin region row with every other camera there

-- Changes --
- [Change] The credit on those cameras now names the operator of the service,
           ATX Floods by Beholder Technology, LLC, alongside the City of Austin
           crossings they watch. The previous credit named only the City
- [Change] Their images are served through this site rather than the browser
           reaching the camera service directly

-- Bug Fixes --
- [Fix] A low-water crossing with no picture ever, or none in the last 30 days,
      is not offered as a camera you can look through. This is the gate the
      river cameras already use

## v0.99.6 · 2026-07-25 (a gear that never met the tap floor, and an Alerts panel that led with prose)

-- Bug Fixes --
- [Fix] The settings gear now meets the same minimum tap size as every other
      control in the header row on a phone. It was the one that did not

-- Changes --
- [Change] The Alerts panel leads with the control. The current state and the
           on/off switch sit together on the first row, ahead of the
           explanation
- [Change] Alert types are two compact rows rather than three wrapped chips:
           Flash Flood Emergencies takes Off or On, river gauges take Off,
           Moderate or Major. Each option sets its value instead of toggling
           it, so the gauge tiers read as the single exclusive choice they are
- [Change] A one-line note (best effort, not a 911 replacement, not a Wireless
           Emergency Alert) is on screen in every state of the card, with the
           full text behind a "How these alerts work" disclosure that remembers
           whether it was opened
- [Change] The blocked, unsupported and iOS states each carry a short state
           line and their own one-sentence fix, so a revoked browser permission
           reads differently from a plain off

## v0.99.5 · 2026-07-25 (a source we were not licensed to copy, and cameras that never worked)

-- Bug Fixes --
- [Fix] The ATX Floods camera source is removed, and with it 26 Austin
      low-water-crossing cameras and the attribution that credited the City of
      Austin for a private company's service. Its terms forbid redistributing
      any part of it
- [Fix] Two USGS river cameras had never produced an image and a third had none
      since April 2023, yet all three were listed as available. A camera with no
      frame inside 30 days no longer ships, and every camera that does carries
      the timestamp it was judged on
- [Fix] The river-camera area no longer cuts the Canadian River at Amarillo out
      of Texas or the Pecos headwaters out of their own basin

-- New Features --
- [New] Port Houston Ship Channel cameras, 13 of them, including the Sidney
      Sherman (I-610) bridge air-draft view. A wharf camera carries its
      terminal's position and the viewer says so, rather than implying a
      berth-level fix
- [New] The Port Houston check requires a real frame, not just a good status

-- Changes --
- [Change] El Paso bridge cameras are deliberately not grown. One live stream
           stays out of the table because the city forbids reproduction without
           its written consent, and that reason now sits beside the table
- [Change] Twelve per-source camera picker strings left over from the v0.99.2
           regroup are removed from both languages

## v0.99.4 · 2026-07-25 (three surfaces stop claiming more than they know)

-- Bug Fixes --
- [Fix] The crest summary said every peak was an observed stage this board
      recorded. 30 of its 47 rows were reconstructed from the upstream USGS and
      NWPS record. A reconstructed row now carries its own badge, and the
      citation states how many of how many were rebuilt
- [Fix] A reconstructed crest names itself in the CalTopo export too, in its
      title, its notes and its citation
- [Fix] A curated shelter's status is read at last. A curated entry no longer
      counts as open whatever its status says, and one with no status reads
      unknown
- [Fix] The curated shelter list ages out after 72 hours. Its entries stay on
      the list and on the map with their dates shown, stop being counted as
      open, and the strip chip says the count is live-feed-only
- [Fix] Each shelter block carries its own header date. The live feed's stamp
      used to head the curated list as well, and a live feed that returns
      nothing now says so instead of appearing to vouch for curated entries
- [Fix] Curated shelters render their status and source badge on the card and in
      the map popup; they previously rendered no status field at all
- [Fix] The Roads badge counts only closures re-confirmed inside the existing
      12h window, so closures last confirmed days ago no longer add to it. They
      stay on the list and on the map, dashed and dimmed, and the panel says how
      many are excluded

-- Changes --
- [Change] Curated low-water-crossing text drops its em-dashes
- [Change] The v0.98.0 shelter-count test asserts how a status is read rather
           than how it is spelled

## v0.99.3 · 2026-07-25 (the life-safety cues speak Spanish)

-- Bug Fixes --
- [Fix] The flash flood emergency banner is localized, along with the EMERGENCY
      flag on emergency alert cards and the alert reader's own title
- [Fix] All four data-age bar states are localized: gauges from snapshot, data
      never loaded, data n minutes old, and the USGS raw-stage fallback note,
      plus the bar's dismiss control
- [Fix] Six more controls are translated: the map's My location button, the
      emergency banner dismiss, the changelog load-failure line, the sort, time
      window and distance filters, the aged-cards toggle, and the version chip
- [Fix] The data-age bar's dismiss control and the map's My location button
      gained accessible names; both were glyph-only with no label

-- Changes --
- [Change] The guard against untranslated text is structural instead of a list
           of known strings: it fails on a warning-glyph literal or a run of two
           or more all-caps words anywhere in the renderers
- [Change] Exemptions to that guard are token-shaped: a caps run built only of
           organization, protocol and product acronyms is a proper noun, and the
           few machine and interop strings are named one at a time
- [Change] Every title and aria-label on the page must now carry a translation
           attribute, asserted by a test

## v0.99.2 · 2026-07-25 (cameras group by Texas region, not by who owns the lens)

-- Changes --
- [Change] The camera picker is organised by region. Eight rows named after
           operators become one row per Texas region, grouped under the Gulf
           Coast, Central Texas, North and East Texas, and West Texas. The
           operator still sets the marker glyph, the popup and the citation.
- [Change] Each of the 6,263 cameras is assigned to exactly one region by its
           own coordinates. The regions are the same ones the AO quick-jump
           uses, so the two cannot drift apart.
- [Change] Each row states its own camera count, and a region with no cameras
           says so instead of offering an empty toggle.

-- Bug Fixes --
- [Fix] Cameras beyond 100 miles of every region anchor get their own row naming
      them as outside the Texas regions, rather than being folded onto the
      nearest Texas row. Cameras with no usable coordinates are counted there
      too. The residual today is 8 of 6,263, none in Texas.
- [Fix] The sweep that hides live camera layers during playback covers the
      region layers, so today's cameras cannot draw under a historical frame
      with a live citation.
- [Fix] Four region anchors sat outside the bounds of their own region, so the
      quick-jump rectangles for Dallas Fort Worth, El Paso, the Panhandle and
      the Coastal Bend did not contain Sherman, Pecos, Wichita Falls and
      Matagorda. The bounds now contain every anchor.
- [Fix] The CalTopo status line stays silent unless it has real per-folder
      counts, rather than describing a half-read export as complete.

-- New Features --
- [New] Camera regions are addressable: a shared link carries the region ids
      that are open. The eight retired per-source parameters are still read on
      the way in and mapped onto the regions each source covered, so links
      shared before the split still open the same cameras.
- [New] A new source slots in without another restructure: its cameras are
      assigned by coordinate into the regions that already exist, and a new
      region is a config edit.
- [New] Tests cover the assignment, the distance guard, malformed region config,
      the residual bucket, the shipped region set, the frozen legacy parameters
      and the playback sweep.

## v0.99.1 · 2026-07-25 (a capped CalTopo export has to say it is capped)

-- Bug Fixes --
- [Fix] The CalTopo export shipped a fraction of itself without saying so. The
      statewide AO pushed it past the 500-feature cap, so the file carried 506
      of 1131 while the share sheet still described it as complete.
- [Fix] A truncated export names itself partial in its title with both numbers,
      and its note states the cap and what survives it.

-- New Features --
- [New] The share sheet states what the file holds, either all N features in
      scope or N of M with the reason, in English and Spanish.
- [New] The export publishes its candidate total and cap alongside the truncated
      flag and the drop count.
- [New] Tests pin the honesty in both directions: an uncapped export must not
      say partial, and a capped one must report the drop, name itself partial,
      and keep no quiet gauge ahead of a gauge in flood.

-- Changes --
- [Change] The cap stays at 500. Priority ranking keeps every alert, crest, road
           closure, crossing, storm report and in-flood gauge ahead of every
           quiet gauge, so the cut falls only on gauges reporting no flooding.

## v0.99.0 · 2026-07-25 (the AO resets to standing Texas regions)

-- Changes --
- [Change] The board is no longer framed on a finished storm. The TS Bertha name
           and event label are gone, the coverage line reads Texas, and the Full
           AO widens to the whole state: 290 gauges to 1018 and 271 road
           closures to 287, with nothing held out of scope.
- [Change] Twelve standing Texas regions replace the four Bertha sub-AOs in the
           quick-jump list: Houston · Gulf Coast, Beaumont · Golden Triangle,
           Coastal Bend · Victoria, Rio Grande Valley · Laredo, Austin · Hill
           Country, San Antonio · South Central, Waco · Brazos Valley, Dallas ·
           Fort Worth, East Texas · Piney Woods, West Texas · Permian Basin, El
           Paso · Far West, and Panhandle · South Plains. Every region carries a
           Spanish label.
- [Change] The tide card grows from ten upper-coast stations to fourteen, adding
           Freeport, Bob Hall Pier, Port Mansfield and Port Isabel, and Aransas
           Pass is now read at the Port Aransas gauge.
- [Change] With no named event configured, the crest summary labels its window
           by month rather than by a storm name that has expired.

-- New Features --
- [New] Regions are event config, never code, so a future re-target stays a
      config flip.

## v0.98.11 · 2026-07-25 (the public mirror stops shipping the intake form)

-- Changes --
- [Change] The field-report intake form no longer ships in the public artifact.
           The deploy removes both the entry-point button and the form; the LAN
           operator build keeps them whole.
- [Change] Every reader of the intake form tolerates the element being absent,
           and asking for the intake form on the mirror is a no-op rather than a
           page error.

-- New Features --
- [New] The strip is asserted on its result, in both directions: the source must
      still carry the form, and the published artifact must carry neither the
      form nor the button.

## v0.98.10 · 2026-07-25 (the data cycle runs committed code)

-- Bug Fixes --
- [Fix] The 15-minute data cycle ran the working tree's generators, so a
      half-finished pipeline edit became production data. It now checks HEAD out
      to a throwaway worktree and runs the generators, the validator and the
      deploy from there.
- [Fix] The post-deploy strip gate asks for each stripped path both with and
      without a cache buster. An origin 404 stays the pass condition, and an
      edge still serving a stripped path is named in a warning that does not
      fail the deploy.

-- Changes --
- [Change] The cycle's code comes from HEAD, its data does not. A generator
           running out of the HEAD worktree still reads the live event config
           and writes into the real repo, so re-targeting a live event stays an
           edit to a data file, never a release.
- [Change] The cycle gains an option to run an uncommitted pipeline on purpose,
           behind a loud banner. Without it, a cycle that finds uncommitted
           pipeline work logs the file list, says it is running HEAD instead,
           and carries on publishing.

-- New Features --
- [New] Five regressions pin the new boundary, among them that a poisoned
      working-tree generator cannot reach the data, that an uncommitted
      event-config edit still takes effect on the next cycle, and that no
      worktree is leaked.

## v0.98.9 · 2026-07-25 (the playback archive stops paying for itself twice)

-- Changes --
- [Change] The whole-record playback file is now a bounded seven-day view rather
           than a copy of the entire archive, which is published in day-sized
           pieces and stays complete
- [Change] The bounded file says what it is: a view block names the window, the
           frames it carries, the whole record's frame count and start, and
           where the full archive lives
- [Change] Playback on the fallback file no longer claims the missing stretch
           was never recorded. The archive-birth flash, the hatched pre-archive
           band, the range chip titles and the timeline note switch to wording
           that names the full archive, in English and Spanish

-- Bug Fixes --
- [Fix] The crest summary reads its pre-archive reconstruction from the chunked
      archive rather than the bounded file, and its output is byte-identical to
      before the change
- [Fix] The history generator reads the chunked archive too, so the bounded file
      is a pure output with no reader left in the pipeline
- [Fix] The cycle check asserts the bounded view is an exact suffix of the
      reassembled record, and that any shorter view declares a window whose
      depth, first frame, frame count and archive pointer match the bytes
      carried

## v0.98.8 · 2026-07-25 (two guards that were not guarding)

-- Bug Fixes --
- [Fix] The bilingual renderer guard covered a hand-kept list of six files while
      the board loads thirteen, so an English string could reappear in the
      playback, camera or team panels unflagged. The guarded set is now derived
      from the scripts the page actually loads.
- [Fix] The release cycle's chat-cursor check now fails on a cursor moving
      backwards, while still reading an inbox rotation and a fresh checkout as
      the legitimate resets they are.

-- Changes --
- [Change] A cursor regression is reported once and the new position recorded,
           so an ops-chat fault costs a single data cycle rather than stranding
           the public board on stale flood data.

## v0.98.7 · 2026-07-25 (the road closures playback stopped recording)

-- Bug Fixes --
- [Fix] Road playback stopped recording new closures when the area of operations
      moved to the coast. Retention now reads the statewide capture and falls
      back to the display snapshot for older commits: 285 closures retained
      where 257 were, and the newest frame replays 49 instead of 35.

-- Changes --
- [Change] Roads get the same two layers the gauges got. Retention walks the
           statewide capture with no geographic filter, and publication projects
           that through every area this board has declared, so an area change
           can narrow the view and can never delete a stored closure.

## v0.98.6 · 2026-07-25 (two things the public board offered that it could not honour)

-- Changes --
- [Change] The Team tab is no longer in the tab bar by default. The capability
           is unchanged and the tab returns for a team link, a live team, a URL
           request for it, the new Live team entry in Settings, or the operator
           build.
- [Change] The field-report form is withdrawn wherever no ops backend answers.
           A notice submitted on the public board saved to that one device and
           reached nobody; a submission that gets through now is declined in
           both languages.

-- Bug Fixes --
- [Fix] The post-deploy check added in v0.98.5 retries for a minute per path,
      instead of failing on a file the previous deploy is still serving.

## v0.98.5 · 2026-07-25 (the crests the CalTopo export was quietly leaving out)

-- Bug Fixes --
- [Fix] The CalTopo export dropped most of the event's crests while reporting
      nothing dropped: 33 of 47 were missing, 17 of the 18 major ones among
      them. Coordinates now resolve against the wide-area capture and all 47
      export.
- [Fix] A crest that still cannot be placed is counted in the export properties
      and in the generator's log, so a partial file says it is partial.

-- Changes --
- [Change] Field Notes stops loading for visitors who never asked for it. It is
           injected on demand, so the operator build keeps the feature
           unchanged.
- [Change] The public mirror stops publishing ops-side code no browser can run.
           The operations scripts and the LAN server are stripped, their absence
           asserted before upload, and each confirmed 404 afterwards.

## v0.98.4 · 2026-07-25 (two defects that only show up in a moving vehicle)

-- Bug Fixes --
- [Fix] The hazard line no longer scrolls itself. Android for Cars app quality
      requirement ST-1 forbids automatically scrolling text. The line is ranked
      worst-first, so the top item is pinned and legible at a glance.
- [Fix] Nothing was dropped to get there. The remaining items sit behind a count
      button and open as a static list, one tap, no motion. Acting on an item
      closes it.
- [Fix] Minimize now collapses the panel in landscape as it already did in
      portrait. A dash-mounted phone could not give the map the screen at all.

-- Changes --
- [Change] The landscape handle is the portrait pill turned on its side. It
           rides the panel's inner edge while the panel is open, moves to the
           right edge once the panel is gone, and sits in the lower third.
- [Change] Landscape reuses the existing minimize state, so a shared link naming
           the panel size and the stored panel preference both work there. The
           full-screen-panel button is hidden in landscape.
- [Change] Hazard-line items are real buttons, so they are keyboard reachable
           and pick up the phone target floor. They were spans.
- [Change] The expanded list floats over the map instead of pushing it down.
- [Change] Reduced-motion users previously got the marquee frozen in place,
           leaving every item past the fold unreachable. With no motion
           anywhere, that whole class of failure is gone.
- [Change] Three guards keep it that way: no animation may return to the hazard
           line, the remainder must float rather than resize, and the landscape
           layout must keep a visible handle with a collapsing sidebar.

## v0.98.3 · 2026-07-25 (degraded gauges become peer values in the legend)

-- New Features --
- [New] The map legend is now one list of eight gauge states: five flood
      severities in colour, then "Flood category not defined", "Data not
      current" and "Out of service" in greys, as peers of MAJOR and No flooding.
- [New] Every legend row carries a live count and its own checkbox, so the
      legend is also the filter.
- [New] Degraded rows ship ON by default, the inverse of the NWPS default.
- [New] Degraded gauges reach the map at all for the first time. They were being
      discarded at load, including ones carrying live readings that have no
      flood thresholds defined.

-- Bug Fixes --
- [Fix] The sparkline no longer labels the last point of a frozen trace with a
      bare value that reads as a current level; it names when the record stops.
- [Fix] An out-of-service gauge gets a sentence where the chart goes, in the
      popup and the hydrograph modal, instead of a chart of nothing.
- [Fix] A gauge with no thresholds carries a caption stating that no stages are
      defined, not one promising bands neither chart drew.
- [Fix] A disabled sensor arrives as a -999 reading stamped year 0001, and
      nothing renders that as a level any more.
- [Fix] The hydrograph says where the observed record stops instead of leaving
      the gap to now for the reader to interpret.
- [Fix] The playback layer subtitle still advertised 3 / 7 / 14 days after 30
      and 90 were added.

-- Changes --
- [Change] The degraded filter is stored locally rather than in the URL, so a
           shared link cannot arrive with dead gauges hidden from the recipient.
- [Change] Layer subtitles state the limitation in the layer picker: gauges name
           the three degraded states, alerts say a polygon is the area a warning
           covers, storm reports say each is a moment already past, and shelters
           say to call ahead.
- [Change] Degraded gauges declutter at low zoom as no-flood gauges do.
- [Change] The live and cold-start paths share one gauge-splitting helper.
- [Change] The glossary lists the same three degraded states as the legend.

## v0.98.2 · 2026-07-25 (30 and 90 day playback, and what the board does not have)

-- New Features --
- [New] Playback gains 30d and 90d ranges alongside 3d, 7d and 14d, arriving
      progressively and reusing every frozen day from the browser cache.
- [New] A range deeper than the archive is marked before it is chosen. The chip
      takes a dashed border and a warning dot, and its title and accessible name
      read "Replay the last 90 days. The archive holds 20; the rest predates
      this board and shows hatched, not as calm water."
- [New] The playback note states the shortfall in place: "90d window · 20d
      recorded, the rest is before this board existed". It is text on the bar
      rather than a hover title, so a touch device sees it too.

-- Changes --
- [Change] The window is not clamped to the archive, so the hatched pre-archive
           span stays proportionally honest.
- [Change] No range chip is ever disabled, because the archive grows.
- [Change] The archive-birth flash fires once per range that overreaches instead
           of once per session.

-- Bug Fixes --
- [Fix] A shared link to a moment older than the open window clamped silently to
      the window start, so the board showed a different time than the link
      named. It now opens the narrowest range that contains the linked moment.

## v0.98.1 · 2026-07-25 (the archive publishes in day-sized pieces)

-- New Features --
- [New] The playback archive publishes as an index plus one file per UTC day,
      and the client fetches only the days the chosen window touches, newest
      first, splicing each one in as it lands. A 3-day window used to pull the
      whole record before the scrubber would move.
- [New] The index carries the gauge and road indexes plus a descriptor per day:
      frame count, time bounds, and a content hash. A frozen day is
      byte-identical every cycle, so it can be served immutable.
- [New] The scrubber now distinguishes two kinds of absence. The hatch still
      means the board never recorded that stretch; a new band marks archived
      days still downloading or failed to download, so an unloaded day never
      renders as bare track.
- [New] The test runner writes a whole run to a log file and prints the failing
      test names at the end.

-- Changes --
- [Change] The whole-record file is unchanged and stays published as the
           compatibility view. When the chunk index is missing or unreadable the
           client falls back to it and plays normally.
- [Change] The cycle check re-hashes every published day file against the index
           and fails on a mismatch, on a frame-count disagreement, or on a day
           file the index does not list.
- [Change] The archive-start note is stated before you scrub rather than after.
- [Change] The test docs correct the browser-verification rule: serving the page
           locally does not stop the upstream requests, so verification blocks
           those hosts at the network layer inside the driver.
- [Change] The test docs state the log rule outright: always tee a run to a
           file, and on any flake keep the full log and report the failing test
           name from it.

-- Bug Fixes --
- [Fix] A test probed the production cycle lock at the end of the suite, which
      failed spuriously whenever an unrelated cycle was mid-run. It now asserts
      statically that no test file can name a production lock path.

## v0.98.0 · 2026-07-25 (Resources dissolves)

-- Changes --
- [Change] The Resources tab is gone. Its contents are redistributed by who is
           asking and when.
- [Change] Roads takes that slot: closed and cautioned low-water crossings and
           the roads that have reopened behind them, with a count badge like
           every other tab.
- [Change] Coastal water levels moved to Gauges. On an inland event the card is
           absent rather than an empty host, and the lazy fetch follows the
           Gauges tab.
- [Change] Live feed status became the detail view behind the data-age bar and
           the header status line, not a content section. Tapping either opens
           it in place, and neither switches tabs any more.
- [Change] Shelters and hotlines become a count-gated chip in the threat strip
           and a permanent row leading the settings sheet. Only sites listed as
           open are counted; standby, full, closed and unknown never read as
           open, and the chip never suppresses the all-clear line.
- [Change] The source and recovery link lists moved to the share surface under
           their own labelled group.
- [Change] Links naming the old Resources and Monitor tabs both resolve to
           Roads, so links already in the wild keep working across both renames.
- [Change] The monitor link farm left the client. It was a coordinator desk tool
           three taps deep, shipped to every public visitor.

-- Bug Fixes --
- [Fix] The migration cue now shows one pointer at a time rather than stacking
      every undismissed move onto one tab.

## v0.97.99 · 2026-07-25 (share and export become one surface)

-- Changes --
- [Change] Export JSON, Export GeoJSON, the CalTopo live URL, Export AAR and
           Import moved out of Resources into a Share surface, reached from the
           map link control and from Settings > Share.
- [Change] The Share control opens that surface instead of silently copying:
           copy link, the native share sheet and a QR of the current view, with
           the CalTopo live URL in the export group.
- [Change] RSS and the crest calendar moved to the same surface, under Follow
           and subscribe.
- [Change] One QR renderer now draws both the share link QR and the CalTopo
           export QR.

-- New Features --
- [New] One-time migration cue: a dismissible pointer renders where a moved
      control used to live, naming its new home. Dismissal persists.

## v0.97.98 · 2026-07-25 (the views control names its own state)

-- Changes --
- [Change] The map views control names the active lens instead of showing an
           unlabelled glyph. It reads Live at rest, says Basin, Replay or Recovery
           while one is open, and carries an exit back to the live map.
- [Change] The map top-right stack drops from five boxes to three with no
           capability lost: the compass rose joins the zoom and locate bar, and
           offline map save moves into the layer sheet.
- [Change] Every lens entrance and exit routes through one dispatcher, so only
           one lens can own the board and the views control cannot disagree with
           the screen.

## v0.97.97 · 2026-07-25 (the archive is retained wide and published narrow)

-- Bug Fixes --
- [Fix] A display-scope change could delete stored observations: narrowing the
      map area for the coastal pivot pruned 18 days of already-collected Hill
      Country readings and shrank the crest summary with them. All of it is
      restored. Retention and publication are separate now, and scope is applied
      only at publish time.
- [Fix] The pre-archive reconstruction stage had been dead on every run. Archive
      depth is its own field now, set to 2026-07-05, and 152 reconstructed
      frames are back.
- [Fix] History frames were ordered by raw commit-time string, so same-second
      commits walked newest-first and were dropped.
- [Fix] A test run took the production lock on the data cycle, which made one
      live cycle skip and miss a publish.

-- New Features --
- [New] Playback frames carry provenance and the board states it: captured by
      this board, rebuilt from the observed USGS or NWPS archives, or recovered
      from our own earlier archive. The playback note says which.
- [New] The published history reports retained counts beside published ones, so
      the record states it is wider than the current view rather than implying
      the held-back gauges never reported.
- [New] A test pins the retention invariant: narrowing the display area removes
      no retained frame or gauge, and a cold rebuild still publishes what the
      wider area recorded.
- [New] A test pins skip-on-contention and asserts the production lock is free
      afterwards.

-- Changes --
- [Change] Publication scope is the union of every map area this repo has ever
           committed plus every gauge already published, so the published record
           only grows.
- [Change] Both history builders read the wide capture snapshot where it exists
           and fall back to the display snapshot for older commits, so archive
           depth survives a future pivot.
- [Change] Archive size budgets were raised so the restored record ships whole;
           nothing is thinned today. Any future thinning protects each gauge's
           crest frame and is declared in the payload, never applied silently.
- [Change] Reconstruction reads the local 30-day rescue buffer before any
           network call, so a routine cycle never re-pulls a window it already
           has.

## v0.97.96 · 2026-07-24 (one failing upstream no longer blocks the whole publish)

-- Bug Fixes --
- [Fix] One failing generator no longer aborts the whole cycle. A single
      upstream refusing requests left roads, history, crest, feeds, shelters and
      the CalTopo export unpublished; the cycle now publishes whatever
      refreshed.
- [Fix] The cycle's error trap logged "near line 0" for every real failure. It
      reports the failing line now.
- [Fix] A stale test fixture was missing the 911 footers the validation check
      requires, so four tests failed on the fixture rather than the code.

-- Changes --
- [Change] A partial cycle degrades honestly. A failed generator's output is
           never touched, so it keeps its older stamp and the board marks that
           source stale; a generator derived from a source that did not refresh is
           skipped rather than restamped as current.
- [Change] The cycle's exit status distinguishes clean, nothing refreshed, bad
           argument and published-but-degraded, and a degraded cycle commits as
           partial instead of claiming a full regen.
- [Change] The freshness monitor reads the degraded verdict from the cycle log,
           so a stale mirror caused by an upstream that is not answering is no
           longer blamed on a dead cron.
- [Change] The pipeline README documents the real nine-step cycle, the exit
           codes and the partial-publish rules.

-- Tests --
- [New] Nine tests cover the partial-publish shape: one failure still publishes
      the rest, the failed source keeps its older stamp, derived generators are
      skipped, total failure publishes nothing.
- [New] Viewport-matrix browser verification must point at a local server; a
      matrix run against the public mirror can rate-limit the live board.

## v0.97.95 · 2026-07-24 (the freshness slot has one writer again, and tells the truth in Spanish)

-- Bug Fixes --
- [Fix] A transient failure can no longer erase or impersonate a degraded-feed
      warning. A denied compass permission left the header reading "compass
      unavailable" while wearing the amber degraded chip, with the real degraded
      state gone.
- [Fix] The degraded tooltip is fully localized; a Spanish reader used to get
      the list of unanswering feeds in English.

-- Changes --
- [Change] Transient failures now show a self-dismissing notice above the map
           (compass, locate, camera list, tropical feed, storm surge tiles,
           history archive), and the header slot says only how current the data
           is.
- [Change] Removed a hidden long-form 911 notice and its translations; no rule
           ever showed it. The footer wording and the safety modal are unchanged.

-- Tests --
- [New] A contract test asserts the freshness slot behaviorally: a transient
      notice cannot change its text, degraded class, tooltip, role or tabindex.
- [New] A test forbids the English source-name array returning and pins one
      source key per settled source.

## v0.97.94 · 2026-07-24 (Basin, Recovery and Crest summary dock beside the map they describe)

-- Changes --
- [Change] Basin Focus, Recovery and Crest summary are lenses now, not covers.
           All three filled the screen and froze the page behind them; they take
           the sidebar column instead, leaving the map visible and usable at every
           width.
- [Change] Drive Mode deliberately did not change. It stays full-screen because
           it is eyes-off-road.
- [Change] The docked panes keep an accessible name, their Exit buttons and
           their place in the Escape chain, and the map re-measures when a pane
           appears or leaves.
- [Change] The update chip goes icon-only on a phone like every other header
           control.

-- New Features --
- [New] The publish check now requires every lens (Drive, Crest summary,
      Recovery, Basin) to carry its 911 footer and the board to keep its
      disclaimer strip.
- [New] A test asserts which surfaces are modal: Drive Mode is, the three lenses
      are not, and the Recovery playback guard from v0.97.87 survives.

## v0.97.93 · 2026-07-24 (landscape stops shrinking the tap targets; the header holds one row)

-- Bug Fixes --
- [Fix] The degraded-feed status no longer shoves the header nav aside (owner
      report). Written as a full sentence in a nowrap header, it crushed the
      brand and made the page scroll sideways on a phone. It is width-capped
      now.
- [Fix] The countdown tooltip overwrote the degraded detail once a second. They
      compose now.

-- Changes --
- [Change] A degraded, offline or snapshot state reads as an amber "⚠ degraded"
           chip rather than a sentence. It is not dismissible, and it is a button
           that opens Resources > Live feeds, which names which source failed.

-- Bug Fixes (responsive) --
- [Fix] Holding a phone sideways made every header control smaller, in the
      vehicle-mount posture where they should be largest. They are full size
      now.
- [Fix] A tablet in portrait matched neither phone query and got the desktop
      layout, a two-row header and undersized targets. A new block compacts the
      header and raises the targets.
- [Fix] A wide phone held sideways cleared the phone width query, so sidebar
      controls fell back to desktop sizing. Landscape now restores the feed,
      card-action and tab targets, the map control bar and the layer pills.
- [Fix] The settings panel, widened in v0.97.92, ran off the edge of a small
      phone screen. On phones it spans the viewport under the header, capped.
- [Fix] Import JSON was never a full-size tap target at any width; it renders as
      a badge, so no button rule reached it.

-- Changes --
- [Change] The four header tiles are gone. They were hidden on every phone
           already and duplicated the threat strip; the two counts only they
           carried, flood warnings and active notices, are now chips in that
           strip.
- [Change] The header holds two things at every width: the brand and one control
           cluster, with no wrapping.
- [Change] Landscape swaps the wordmark lockup for the square mark.
- [Change] The composite refresh entry keeps its delegating calls and the
           document title update; only the tile writes left it.

-- New Features --
- [New] A CSS contract test covers the responsive rules no other test can see:
      the phone, landscape and tablet blocks, the retired tiles, the promoted
      chips and the brand swap.

## v0.97.92 · 2026-07-24 (the header menu becomes a real settings sheet)

-- Bug Fixes --
- [Fix] The header overflow menu had no height limit and could not scroll, so
      its lower rows were unreachable on a short landscape viewport. It caps and
      scrolls now.

-- Changes --
- [Change] The ⋮ button is now a gear labelled Settings, with grouped contents:
           Display (theme, language), Alerts, Actions (share) and Help. What's new
           and the 911 safety notice are named entries in Help now, not just a tap
           on the version string or the footer strip.
- [Change] Device alerts moved out of Resources into Settings > Alerts. The card
           behaves exactly as before.
- [Change] "Notify me" on a gauge popup or hydrograph now opens Settings with
           the gauge picker expanded and that gauge pinned, instead of switching
           to Resources.
- [Change] The ⋮ Team entry is gone; it was a second door onto the Team tab.
- [Change] Only the menu's own rows dismiss it now, so tapping the alerts toggle
           or a tier chip no longer closes the panel out from under the tap.

## v0.97.91 · 2026-07-24 (exports move to Resources, and Feed > More is retired)

-- Changes --
- [Change] Export JSON, Export GeoJSON, CalTopo URL, Export AAR, Import JSON and
           the CalTopo QR box moved out of the Feed tab into Resources, under a
           new "Data & interchange" heading.
- [Change] The Feed > More drawer is gone; the Feed action row is now New
           notice, SITREP and Filters.
- [Change] Export, import and CalTopo behavior is unchanged; only the markup
           moved.

-- New Features --
- [New] A placement gate requires the interchange controls to be declared once,
      inside Resources, and fails on any reference to the retired drawer.

## v0.97.90 · 2026-07-24 (the lenses move to the map, in a views sheet of their own)

-- New Features --
- [New] Views sheet: a new map control beside the layers trigger opens a picker
      for how the board is being looked at. Live map, Drive, Basin, Playback,
      Recovery and Crest summary, each with a one-line subtitle.
- [New] Opening any lens leaves whichever one was open before, and the Live map
      row is the way back out of any of them.

-- Changes --
- [Change] Crest summary, Recovery, Basin and Playback left the Feed > More menu
           and now live on the map. Playback keeps its ⏮ map pill and its
           ?playback=1 link.
- [Change] The existing ?view= links are unchanged, and ?view=live now genuinely
           exits a lens rather than being accepted and ignored.
- [Change] Opening either map sheet closes the other.

## v0.97.89 · 2026-07-24 (a mid-bump working tree can no longer fail a data cycle)

-- Bug Fixes --
- [Fix] A release in mid-bump can no longer fail a data cycle. Validation read
      version and code files from the working tree, so a cycle landing mid-bump
      failed outright and fresh gauge, road and shelter data did not reach the
      public board until a later run.
- [Fix] The same read affected the JS-syntax, 911-gate and event-config checks.
      All four now read one source.

-- Changes --
- [Change] Validation points its code lane at a snapshot of the last commit,
           while the data lane always reads the working tree, which is the data
           the cycle is about to commit. An unknown argument is rejected.
- [Change] The deploy path needs no change here: since v0.97.85 it validates
           inside its own committed checkout.

-- New Features --
- [New] Ten regressions against a scratch repo: a mid-bump tree fails the
      release lane but not the data cycle, a committed disagreement still fails,
      and uncommitted data is still validated. Wired into CI.

## v0.97.88 · 2026-07-24 (the offline data cache survives updates, plus three smaller fixes)

-- Bug Fixes --
- [Fix] The offline copy of the flood data is no longer erased by an app update,
      so a responder who loses signal after updating still has the last readings
      the board saw.
- [Fix] Copies saved under the old per-version scheme are carried over on
      activation rather than thrown away, and a fresher copy is never
      overwritten.
- [Fix] "Notify me" with alerts off gave a card with no manage view and no
      explanation. It states what is missing now, and turning alerts on opens
      the picker with that gauge pinned.
- [Fix] Leaving Basin Focus never cleared the corridor rings, so about a dozen
      gauges kept a ring on the live map with nothing explaining them. Both
      exits clear it now.
- [Fix] The clipboard fallback prompt, the import dialogs, intake validation,
      the team link copy fallback and the shelter location note were English
      only. All have real Spanish now.

-- New Features --
- [New] Service-worker tests now state the intended cache lifetime. Added with
      them: the push body tables, the basin ring lifecycle, and a guard against
      untranslated dialogs.

## v0.97.87 · 2026-07-24 (two honesty fixes: shelter status, and Recovery under playback)

-- Bug Fixes --
- [Fix] A shelter with no reported status is no longer published as OPEN. A
      null, empty or absent status rendered a green "OPEN: <name>" citing FEMA
      and ARC for a shelter no source had called open; it reads "unknown" now.
- [Fix] Unknown shelter status has its own English and Spanish string and a
      muted colour. Only a reported status is presented as fact.
- [Fix] Opening Recovery during playback put today's shelters and reopened roads
      under the PLAYBACK badge citing the live feed. Neither is added while
      playback owns the map now.
- [Fix] Reopened roads were missing from the playback hide list, so engaging
      playback left them on a historical frame. They hide on engage and restore
      on go-live now.

-- Changes --
- [Change] The shelter schema gate names the mapped vocabulary, requires a
           status-less record to publish as "unknown", and notes upstream drift
           rather than aborting the cycle.
- [Change] The shelter generator reports how many shelters arrived with no
           status, and can be pointed at a fixture directory.

-- New Features --
- [New] Tests cover the status default, real statuses passing through, and the
      schema gate against fixture output, plus the playback hide list and the
      Recovery guard. The generator suites are wired into CI now.

## v0.97.86 · 2026-07-24 (device alerts always carry a reachable off switch)

-- Bug Fixes --
- [Fix] An opted-in device always has a reachable off switch. Tapping a
      notification used to open a board with no alerts card, no state line and
      no toggle; holding a subscription now shows the card however the board was
      opened.
- [Fix] Every notification deep links with push=1 now, including the
      payload-free fallback, so a push always opens a page the alerts card is
      on.

-- Changes --
- [Change] ?push stays the discovery gate for devices that never opted in.
- [Change] The push Worker is a separate deploy target, so this release ships in
           two steps.

-- New Features --
- [New] Seven tests cover card visibility including the
      subscribed-without-the-flag case, and every payload emitting push=1 in
      both languages.

## v0.97.85 · 2026-07-24 (the deploy gate reads and ships HEAD, not the working tree)

-- Bug Fixes --
- [Fix] The deploy gate now reads what it ships. It took the app version from
      the working tree but uploaded the last commit, so a bumped-but-uncommitted
      release failed a deploy that had in fact succeeded.
- [Fix] An uncommitted change to the server-side functions aborted the deploy,
      which failed the whole cycle and left the public board serving stale flood
      data. It warns instead of aborting.

-- Changes --
- [Change] --allow-dirty-functions keeps its exact meaning: the working tree
           copy really does ship, behind the same loud warning. --skip-tests is
           unchanged.
- [Change] --preflight-only now builds and strip-verifies the deploy archive, so
           a strip regression surfaces before the push.

-- New Features --
- [New] Eight release-gate regressions run against a scratch repo with a stub
      uploader, never the live site, covering the committed version read, dirty
      server code, and leaked worktrees. Wired into CI.

## v0.97.84 · 2026-07-24 (openView() router for the ?view= deep links, no visual change)

-- Changes --
- [Change] Every ?view= deep link routes through one dispatcher. ?view=drive and
           ?view=summary had worked by synthesizing button clicks, tying two
           shipped links to two button ids. Nothing changes on screen.
- [Change] The river slug allowlist guarding ?view=basin moved into the router
           unchanged, so a crafted slug still falls back to the most active river.

-- New Features --
- [New] ?view=playback and ?view=live are accepted route names, and an unknown
      or missing view name stays a silent no-op, so a stale or mistyped bookmark
      opens the board rather than failing.
- [New] Router tests cover every value a share link can emit, crafted river
      slugs falling back, and the active lens staying out of saved view state:
      restoring "Recovery" on a later boot would imply an all-clear the data
      does not support.

## v0.97.83 · 2026-07-24 (Spanish parity for the feed and export controls)

-- Bug Fixes --
- [Fix] Eight Feed-tab controls read in English in a Spanish session: New
      notice, SITREP, Filters, More, Export JSON, Export GeoJSON, Export AAR and
      Import JSON. All are translated now.
- [Fix] The filters button rebuilt its label from an English literal on every
      render. It uses the translated label now and keeps the active-filter
      count.

-- Changes --
- [Change] Export JSON and Import JSON gained the tooltip their neighbours had;
           every control in both feed action rows has a label and a title in both
           languages.

-- New Features --
- [New] A markup-parity gate fails if any control in a feed action row lacks a
      translation attribute. The check is positional, so it holds as controls
      move.

## v0.97.82 · 2026-07-24 (Fix: the Recovery view rendered into the wrong container)

-- Bug Fixes --
- [Fix] Recovery view opened empty, showing only its header and the 911 footer,
      because a Resources element carried the same id. Present since the view
      shipped in v0.97.75; the two containers have distinct ids now.
- [Fix] Removes a style leak: the lens padding and sizing rules were also
      matching the Resources disclosure.

-- New Features --
- [New] A test intersects every id declared in the markup with every id a
      renderer emits and fails on any overlap, so a renderer cannot shadow a
      container the page owns.

## v0.97.81 · 2026-07-24 (Deploy resilience: external public-mirror freshness monitor)

-- New Features --
- [New] External data-freshness monitor: it fetches the published gauge snapshot
      over the network, ages its generation stamp, and rates it (warn over 45
      min, critical over 90 min).
- [New] Fault attribution, not just detection: each run names the likely cause,
      separating a dead cron from a push path that is not landing from a publish
      path serving a stale copy.
- [New] Alerts post to the ops chat outbox, transition-gated with a 6h cooldown
      and one recovery notice, so a multi-day outage costs a handful of entries.
- [New] A network error is not staleness: only a streak of consecutive fetch
      failures raises an UNREACHABLE alert, and missing local state degrades to
      unknown.
- [New] Installable from the cron installer, documented with an operator runbook
      per cause line, and covered by tests that are now a CI step.

## v0.97.80 · 2026-07-24 (Basin Focus: single-river corridor view with the crest wave)

-- New Features --
- [New] Basin Focus view (?view=basin&river=<slug>): a single-river corridor
      lens, upstream to downstream. A river picker lists every river group in
      the gauge inventory, most active first (any in-flood, rising, or receding
      gauge, then rivers that crested this event, then quiet reaches); the
      selected river renders as a corridor strip: each gauge with its current
      stage, category, and trend arrow, plus an honest crest status line
      (crested N ago at X ft from the event's observed peaks, forecast crest at
      Y, or "no crest signal"), with a dashed crest-wave-front marker between
      the last point the crest has passed and the next point it is heading to.
      Selecting a river frames its corridor on the map behind the view and
      rings its gauge markers in the accent color.
- [New] Corridor ordering is derived honestly, never fabricated: gauges are
      placed along the river's best-fit geographic axis, and the flow direction
      is confirmed by crest timing where two or more points carry an observed
      peak or a material forecast crest (a crest arrives later downstream);
      with no usable crest timing the view says so plainly: order approximate,
      by gauge location only, direction estimated toward the coast. A reach
      where crest timing and gauge geometry disagree is flagged as approximate,
      and tide-station groups are labeled coastal stations, not river corridors.
- [New] Receding-event honesty: the wave framing only counts material crests
      (an observed in-flood peak, a forecast at or above action stage, or a
      forecast rise of at least 0.5 ft). NWPS publishes a "forecast crest" even
      for flat quiet rivers; those render as muted forecast lines with a quiet
      headline, never as a fabricated wave. Stale sensors keep their stale badge
      and contribute nothing to wave timing or ordering.
- [New] Entry points: a Basin button under More in the Feed tab, a basin link
      in every gauge popup that opens that gauge's river, and full share
      round-trip: a shared link carries view=basin plus the selected river and
      restores both on open (crafted river slugs fail an allowlist and fall
      back to the most active river). English and Spanish throughout.

## v0.97.79 · 2026-07-24 (Device alerts, phase 3: follow specific gauges + subscription self-heal)

-- New Features --
- [New] Device-alert subscribers can now follow specific gauges, each at its
      own threshold (moderate or major), alongside or instead of the area-wide
      setting; the most sensitive applicable threshold wins per gauge, and up
      to 20 gauges can be followed per device. The alert evaluator's per-gauge
      dedup, hysteresis, cooldown, and hourly-cap machinery applies to followed
      gauges exactly as it does to area-wide tiers, and the subscription record
      stays anonymous: endpoint, keys, preferences, language, nothing else.
- [New] The Device alerts card (still behind ?push=1) gains a manage view:
      every followed gauge listed with its threshold, one-tap threshold change
      and remove, a nearest-gauges picker seeded from the current map view
      (pan the map to follow gauges around any point of interest), and a
      turn-off-everything action. A "Notify me" entry in each gauge popup and
      the hydrograph modal opens the manage view with that gauge preselected.
      English and Spanish throughout.
- [New] Subscriptions now self-heal: if the push service rotates a device's
      endpoint, the service worker re-subscribes and migrates the stored
      preferences to the new endpoint automatically; if the server's VAPID key
      rotates or the browser subscription disappears, the next board visit
      transparently re-subscribes and restores the device's preferences. A
      revoked notification permission shows the honest blocked/off state and
      never re-prompts; preferences are kept locally for a later manual
      re-enable.

-- Changes --
- [Change] Boot-time renew now doubles as the endpoint-authenticated
         self-lookup: the server's stored preferences (the authoritative copy)
         sync back to the device on every visit, so the manage view always
         shows the registry truth.

## v0.97.78 · 2026-07-24 (CalTopo / SARTopo interop: stable import URL + QR)

-- New Features --
- [New] Server-side CalTopo export: new scripts/gen-caltopo.py runs each data
      cycle and publishes data/caltopo-export.json, a CalTopo/SARTopo-importable
      FeatureCollection at a stable public URL. Seven folders (NWS alerts,
      event crest rings, NWPS gauges, TxDOT road closures, low-water crossings,
      curated notices, NWS storm reports) shaped for CalTopo's GeoJSON import:
      folder features (class Folder) + folderId membership, properties.title
      labels (CalTopo ignores name/id), and mapbox simplestyle colors matched
      to the app palette (AHPS category hexes for gauges/crests, severity hexes
      for alerts, status hexes for crossings, priority hexes for notices).
      Every feature description carries its source citation and an Updated
      stamp; the collection carries the 911 disclaimer, per-folder counts, and
      an honest one-shot-import note (re-import duplicates; CalTopo does not
      poll the URL). Public-safety filters: LAN operator intakes, aged or
      resolved cards, and all contact/handle/details fields never export.
      Feature cap 500 with lowest-value-first truncation (quiet gauges, oldest
      storm reports) flagged in collection properties. Live alert/LSR fetch
      failures degrade to a sources_unavailable note, never a broken file.
- [New] Feed tab "CalTopo URL" panel under More: the bookmarkable import URL
      with one-tap copy, a client-side QR code for cross-device handoff, and
      honest usage copy (Import > Import from URL downloads a fresh copy each
      time; CalTopo does not refresh it on its own). English and Spanish.

-- Changes --
- [Change] run-cycle.sh runs gen-caltopo.py non-fatally and commits
         data/caltopo-export.json with the cycle data files; cycle-check
         check j validates the export schema (FeatureCollection, per-feature
         geometry + properties.title; absent file skips gracefully).

## v0.97.77 · 2026-07-24 (Module split wave 2: playback.js + cameras.js)

-- Changes --
- [Change] Behavior-neutral refactor of the two post-v0.78 monolith hotspots:
         the historical-playback subsystem (state machine, timeline bar, IEM
         archive tile faders, story captions, ~1170 lines) moved from js/map.js
         into new js/playback.js, and the camera layer (8 networks, markers,
         inventory load, HLS/still viewer, ~390 lines) moved from js/sources.js
         into new js/cameras.js. Pure moves, byte-identical bodies; load order
         is map.js then playback.js, sources.js then cameras.js (all
         cross-file references are runtime-only). Service worker precache and
         asset stamps carry both new files.
- [Change] The repeated inline playback lock expression (state.pb &&
         !state.pb.live) at 12 call sites across map, panels, board, and boot
         is now one named predicate, pbBlocksLive(state), with unit tests.

-- New Features --
- [New] Cross-module load-order gate (tests/bundle.test.js): every first-party
      script from index.html is evaluated in tag order in a shared scope, so a
      script referencing an identifier defined by a later-loaded file now
      fails the test suite instead of only surfacing as a browser boot error;
      a built-in mutation test proves the check trips on a mis-ordered pair.

## v0.97.76 · 2026-07-24 (Event-revert readiness + radar failover)

-- New Features --
- [New] Observed-radar failover: if the RainViewer frame API is down, the radar
      layer now rebuilds its timeline from the IEM NEXRAD composite archive
      (the same tiles playback already replays): past-only 10-minute frames
      over ~2 hours, no fabricated nowcast, with the legend and attribution
      switching to "Observed · NEXRAD via IEM (backup source)". Recovery is
      automatic: every refresh retries RainViewer first.
- [New] Honest degraded states where no secondary source exists: the forecast
      radar legend says "Forecast radar unavailable" when the HRRR/IEM source
      is failing and no model tile has painted, and Resources feed chips for a
      source that has never loaded now read "no data yet" instead of a blank
      stale dot. English and Spanish.
- [New] Coastal tide stations are now event config: data/event.json
      tideStations drives the Coastal water levels card (the TS Bertha station
      list moved there unchanged); an inland event.json without stations
      renders no coastal card and makes no CO-OPS fetches. event.json can also
      pin tropicalAutoEnable off per event (the NHC tracker auto-default
      stays data-driven: it engages only on an active TX tropical
      warning/watch).

-- Changes --
- [Change] Event-revert readiness: closing or re-targeting an event is now
         config-only. fetch-snapshot.py, gen-roads-snapshot.py, gen-cameras.py,
         and gen-shelters.py all take their AO bbox from data/event.json
         (previously the gauge/roads/cameras fetches hardcoded the Bertha
         coastal box and would have silently kept fetching it into a new
         event); built-in code fallbacks (CONFIG center/zoom/bbox, snapshot
         floor, cycle-check floor) are event-neutral Texas-wide values; the
         stale Hill Country sub-AO pill fallback is removed (no event presets =
         Full AO pill only). The gauge-snapshot partial-response guard is now
         bbox-aware: same-bbox refreshes must return at least half the previous
         count, a re-target only clears the absolute floor. Operator runbook
         for closing an event added to scripts/README.md. Verified by a
         scratch-checkout dry run with a synthetic Hill Country event.json:
         pipeline plus headless boot render with zero Bertha/coastal residue.

## v0.97.75 · 2026-07-24 (Recovery view: the event wind-down on one screen)

-- New Features --
- [New] Recovery view (V3): one screen for the recovery phase of an event,
      opened from Feed > More > "Recovery" or shared directly as
      ?view=recovery. It gathers the recovery signals that were scattered
      across SITREP lines and separate panels: receding gauges (below flood
      stage after flooding during the event, or past crest and falling, with
      current stage, peak, and the falling evidence: trend, off-crest reading,
      or a forecast below the current category), recently reopened roads from
      the live DriveTexas feed, open shelters (live FEMA/ARC merged over
      curated), and utility/recovery notices (boil water, power, debris,
      reopenings) filtered from the feed. Every section shows timestamps and
      sources, renders an honest empty state when a signal has nothing real to
      show, and the header counts what is still in flood; the framing is
      explicit that recovery signals are not an all-clear. English and
      Spanish.
- [New] The receding-gauge classification is derived from the same
      crest-summary archive and live gauge data the board already ships:
      stale sensors are excluded, still-rising gauges never count, and a
      gauge whose in-flood window closed but that is back in flood drops out.
- [New] Share links round-trip the view: sharing while the recovery view is
      open carries ?view=recovery, and opening such a link lands directly in
      the recovery view. Opening the view also turns on the reopened-roads
      and shelters map layers as its default lens.

## v0.97.74 · 2026-07-24 (LAN EOC: notice intakes shared between stations)

-- New Features --
- [New] On a LAN ops board, saving a '+ New notice' intake now also shares it
      with every other station. The notice still appears instantly on the
      device that entered it, exactly as before, and a quiet confirmation
      says it was shared to the board and will appear for everyone after the
      next refresh cycle (English and Spanish). Two EOC coordinators triaging
      on different stations finally see each other's intakes without passing
      Export/Import files around.
- [New] LAN server: a new POST /api/requests intake endpoint behind the same
      LAN/loopback client gate and per-IP rate limiter as chat and notes. It
      validates the notice server-side (required summary and place, length
      caps on every text field, HTML tags stripped, coordinates rejected
      outside a sane bounding box, type/priority/source coerced to known
      values) and appends one server-stamped line per intake to
      data/notices-inbox.jsonl.
- [New] Pipeline: a new gen-notices step folds accepted intakes into
      data/requests.json each refresh cycle with origin "operator" provenance,
      fully re-derived from the inbox every run so reruns never duplicate and
      removing an inbox line removes its entry; curated entries are never
      touched, and a station's own intake is superseded in place by the shared
      copy (same id) instead of doubling up. The release gate now validates
      the notices inbox and the merged provenance.
- [New] Privacy fences: operator intakes stay on the LAN. They are excluded
      from the public feed.xml, the inbox file is never git-tracked, never
      served over HTTP, and never part of the cycle commit, so the public
      mirror keeps exactly its current behavior (notices added there remain
      device-local, as its banner already says).

## v0.97.73 · 2026-07-24 (Team: dead-zone breadcrumbs no longer vanish; queued fixes send when signal returns)

-- New Features --
- [New] A team member's position fixes are no longer lost in a dead zone. When a
      position update cannot reach the relay (no signal, a timeout, or the relay
      briefly down) the fix is saved on the phone instead of dropped, up to about
      2 hours of fixes, and the queue survives an app reload. When signal returns
      (or the next update lands) the whole backlog sends in one batch, each fix
      keeping its original time and GPS accuracy, and the breadcrumb trail at
      command fills in the missing stretch.
- [New] While fixes are waiting, the Team tab says so plainly: "N fixes queued,
      sending when signal returns", in English and Spanish. The line clears once
      the backlog sends.
- [New] When the screen locks or you switch apps, the last position already in
      hand is saved into the queue before sharing pauses, so command sees an
      honest final point from before the pause instead of a trail that just
      stops. Sharing still pauses while the screen is off, exactly as before
      (battery, and the "foreground, screen-on only" promise).
- [New] Relay: a new batched backfill endpoint accepts queued fixes with the same
      membership checks and per-fix validation as a live update, refuses fixes
      stamped in the future or older than the 2 hour trail window, caps the batch
      size, and slots accepted points into the trail in time order without ever
      overwriting a fresher live position. Existing clients posting single
      updates are untouched.

## v0.97.72 · 2026-07-24 (Live FEMA/ARC shelter status in Resources)

-- New Features --
- [New] The Resources tab now folds in live open-shelter status from the FEMA
      National Shelter System (the federal shelter database synced with the
      American Red Cross). A new pipeline poller queries the FEMA Open
      Shelters layer for the event area every cycle and publishes
      data/shelters-live.json; live entries render first with their status
      (open, standby, full, closed) in both languages, address, capacity and
      occupancy when the feed reports them, a freshness line showing when the
      data was generated, and a source link on every card. When a live entry
      matches a curated shelter by name or location, the live entry wins;
      curated shelters from official statements remain listed otherwise, and
      the board behaves exactly as before when no live data exists. The
      Shelters map layer shows the same merged set, with live markers citing
      FEMA/ARC in their popups.
- [New] Honest-data plumbing throughout: an empty result from a healthy feed
      is published as real data (no shelters open in the area), while a fetch
      failure keeps the previous file and never clobbers last-good; the
      release gate now validates the shelters file schema whenever it is
      present and skips gracefully when it is not.

-- Changes --
- [Change] Test infrastructure (no app change): 37 new unit tests (216 total)
         covering crest-of-record context and the record-watch list (exact-zero
         and exact-near margin boundaries, missing record/forecast, stale or
         non-rising gauges excluded), playback frame selection and archive tile
         stamps (at-or-before frame resolution, window clamping, 5-minute and
         hourly stamp flooring), a full share-URL round trip (every encoded
         param restored field-for-field through applyShareParams on a fresh
         mock DOM), card aging (resolved suppresses immediately, per-type
         cutoff beats the default, strict greater-than boundaries), and the
         forecast-category / rising / river-grouping predicates including the
         stale-sensor and stale-forecast honesty rules. Harness now also loads
         map.js in the sandbox and exports the symbols under test; key
         boundary tests were mutation-verified against flipped comparisons.
- [Change] Release tooling (deploy infra, no app change): the deploy script
         now refuses to ship when uncommitted or untracked files exist under
         functions/, naming the offending files, because wrangler compiles
         Pages Functions from the repo working tree rather than the deploy
         directory and half-written code could previously reach production
         via the 15-minute data-refresh deploy. A loud
         --allow-dirty-functions override exists for genuine field
         emergencies, alongside the existing --skip-tests escape hatch.

## v0.97.71 · 2026-07-24 (Device alerts, phase 2: gauge-level alerts with real notification content)

-- New Features --
- [New] Gauge-level alerts arrived for device-alert subscribers: opt in to a
      notification when any gauge in the area reaches moderate or major flood
      stage (choosing moderate includes major). New selection chips on the
      Device alerts card (still behind ?push=1) let each device pick Flash
      Flood Emergencies, gauges at major, or gauges at moderate. Crossings are
      evaluated against the same published gauge snapshot the board shows, so
      a notification never claims something the board cannot back up; frozen
      or stale sensors never fire an alert.
- [New] Notifications now carry real content in your language: the gauge name,
      the flood stage reached, the observed reading, and a link that opens the
      board directly on that gauge's hydrograph. Payloads are end-to-end
      encrypted to your browser per the Web Push standard; devices that cannot
      accept payloads still get the generic notification as before.
- [New] Turning alerts on now sends a clearly labeled confirmation
      notification right away, so you know delivery works on that device
      before an emergency does.
- [New] The card shows evaluator freshness honestly: "Alerts checked N min
      ago" when the alert checker is current, and a delayed-checks warning
      when it has not run for over 20 minutes, so the board never pretends
      the alert channel is live when it is not.
- [New] Anti-noise machinery for flapping rivers: one notification per
      upward crossing, a repeat only if the gauge escalates further, a 30
      minute floor between notifications for the same gauge, re-arm only
      after the river has genuinely receded, and at most 6 gauge
      notifications per device per hour with the overflow collapsed into a
      single "N more gauges" digest. Emergency alerts are exempt from the
      cap.

-- Changes --
- [Change] The data pipeline now nudges the alert evaluator right after each
         deploy so gauge notifications follow the board's refresh promptly;
         the every-5-minutes check remains the guaranteed path. The nudge is
         authenticated and can never inject alert content.

## v0.97.70 · 2026-07-24 (Security hardening: Content-Security-Policy backstop + data-contract checks)

-- New Features --
- [New] Content-Security-Policy on both serving surfaces (Cloudflare Pages
      `_headers` and the LAN `server.py`), built from the app's observed
      runtime needs: scripts and styles self-hosted only (inline style
      attributes allowed, no inline scripts), images limited to the tile,
      radar, surge, and camera-still hosts the map actually uses plus data:
      (Leaflet's empty-tile placeholder) and blob: (offline tiles, proxied
      cam stills), network calls limited to the NWS/NOAA/USGS/IEM/TxDOT/
      RainViewer/geocoder APIs the board reads, HLS camera streams allowed
      for the two live-stream hosts, plugins blocked, framing restricted to
      the site itself. This is a defense-in-depth backstop behind the
      existing output-escaping at every render site; a compromised or
      hostile upstream feed can no longer pull scripts or exfiltrate to
      arbitrary origins even if an escaping bug slipped through.
- [New] cycle-check gains a tenth check: per-file required-key schema
      assertions for the five generated data files (gauges snapshot, gauge
      history frames, crest summary, roads snapshot, cameras), with every
      asserted key derived from the actual generator output and consumer
      reads; a renamed or dropped key now fails the release cycle instead
      of silently degrading playback, crest summaries, or camera layers.
      Files whose absence the app tolerates are skipped when absent; the
      load-bearing gauges snapshot is not.

-- Changes --
- [Change] The LAN server now also sends the nosniff, referrer-policy, and
         frame-options headers the public mirror already sent.

## v0.97.69 · 2026-07-24 (Device alerts, phase 1 soft launch: opt-in push for Flash Flood Emergencies)

-- New Features --
- [New] Opt-in device notifications for new Flash Flood Emergencies in the area,
      soft-launched behind ?push=1 while it burns in (the card is hidden without
      the flag). A new "Device alerts" card in the Resources tab explains what
      you get, asks for notification permission only when you tap the toggle,
      and always shows the honest state: on, off, blocked in browser settings,
      not supported on this browser, or the iPhone/iPad add-to-Home-Screen step.
      English and Spanish throughout, including the notification text.
- [New] The subscription is anonymous: the server stores only the push endpoint,
      the browser's delivery keys, the alert preference, and the language. No
      name, no email, no account, no location. Subscriptions expire on their own
      60 days after the device last opened the board, and turning alerts off
      deletes the record.
- [New] Every alert surface repeats the standing safety framing: these
      notifications are a convenience layer over public NWS data, can be late or
      missed, and are not Wireless Emergency Alerts and never a substitute for
      911 or official warnings.
- [New] Backend (separate from the site): a Cloudflare Worker checks the NWS
      alert feed every 5 minutes for new Flash Flood Emergencies intersecting
      the event area, sends one notification per alert (no repeats for the same
      alert id), and queues deliveries in polite batches. Device endpoints that
      go dead are removed immediately.

## v0.97.68 · 2026-07-24 (Full Spanish coverage on the live surfaces)

-- Bug Fixes --
- [Fix] Spanish mode no longer shows mixed English on the core surfaces: about
      120 strings that renderers built in English now translate properly. This
      covers gauge cards (the category word, "no flooding", crest lines, the
      stale-sensor note, record-of-crest lines), the crest-wave tracker rows
      ("crest arrival order", "crested", the rivers/points counter), crossing
      status chips (CLOSED / CAUTION / LONG-TERM CLOSED and their popups),
      Drive Mode row subtitles, feed card type/priority/status chips and badges
      (NEW, aged, stale), gauge and forecast-crest map popups, road closure and
      reopened-road popups, the map legend, the storm-report list and popups,
      show/hide toggles, hydrograph and sparkline notes, the low-water-crossing
      inventory popups, and the "YOU" location marker.
- [Fix] Statuses that arrive as raw data codes (crossing status, road
      condition, notice type, priority) are now mapped to translated labels at
      render time; unknown codes still display as-is instead of breaking.
- [Fix] Switching language while the board is open now also refreshes the map
      legend and Drive Mode list, so no stale-language text lingers.

-- Changes --
- [Change] A regression guard in the test suite now fails the build if any of
         these formerly-hardcoded English strings reappear in renderer code,
         and checks that the status label maps keep using translation keys.

## v0.97.67 · 2026-07-24 (Tidier map overlays: legend stack, offline button under the compass)

-- Changes --
- [Change] The storm surge legend no longer floats mid-map: all four overlay
         legends (rainfall, radar, storm surge, inundation) now live in one
         tidy bottom-right stack that hugs the corner, with surge directly
         above the radar legend when both are on. Every overlay legend starts
         as a small title pill on all screen sizes (tap to expand); the full
         panel only opens when you ask for it, so the map stays uncluttered.
- [Change] The offline map button moved from the bottom-left corner to the
         top-right control column, directly below the compass, and now matches
         the other map buttons. Its save panel opens leftward from the button
         so it never covers the compass or runs off screen on phones.
- [Change] The offline map panel is now fully translated: every label and
         status message (save, progress, tile counts, cache cleared, too-large
         area) shows in Spanish when the board is in Spanish.
- [Change] Release tooling (post-release infra, no app change): CI now runs
         every test suite on each push (unit tests, chat-poll durability,
         server write-gate, release sanity checks) and reports each even when
         one fails; deploys run the full test gate first and refuse to ship on
         a red suite unless an explicit emergency skip flag is given; the
         release sanity bundle gains a ninth check that chat cursors are valid
         integers within the inbox size; the language test now lints every
         English and Spanish string, the public changelog, and the page markup
         for stray em-dashes.

## v0.97.66 · 2026-07-24 (LAN server hardening: writes limited to the local network)

-- Changes --
- [Change] The LAN server now accepts chat and note posts only from devices on
      the local network (private, loopback, and link-local addresses, the same
      rule the team relay already used). Posts from outside addresses are
      refused with a logged one-line notice (path and client address) so a
      blocked device is easy to diagnose. Reading the board and its data is
      unchanged, and the public respondertx.org mirror is unaffected.
- [Change] Chat and note posts are rate limited per device (a burst of 12,
      then 12 per minute) so a runaway or hostile client cannot flood the
      inbox; normal typing never hits the limit. The chat inbox also rotates
      to a dated archive file once it passes 2 MB or 5000 lines, and only
      after every message has been read and acknowledged, so no message is
      ever lost or replayed.

## v0.97.65 · 2026-07-24 (Event-aware AO presets and event name in the header)

-- Bug Fixes --
- [Fix] The area quick-jump pills and the layer sheet's "Reset view" now follow
      the live event instead of the retired Hill Country operation: "Full AO" is
      derived from the active gauge coverage box, and the sub-area pills come from
      the event configuration (data/event.json), with the previous list kept as a
      fallback when no event presets exist. For TS Bertha the pills now frame the
      upper Texas coast: Houston metro, Beaumont · Port Arthur, Galveston Bay, and
      Matagorda · Victoria. Previously "Full AO" cut off everything east of -97.0,
      excluding the entire Houston and Beaumont operational area.
- [Fix] The event name set in the event configuration shows again in the browser
      tab title and on the brand logo's accessible text; the hook silently broke
      when the header heading was replaced by logo images, and the error was
      swallowed. A release-check gate now verifies the hook targets elements that
      actually exist in the page.

## v0.97.64 · 2026-07-24 (Offline correctness: map library served locally, data fallback fixed)

-- Bug Fixes --
- [Fix] Offline data fallback now actually serves saved data: live feeds are
      fetched with unique cache-busting query strings, so the service worker's
      saved copies never matched when offline. The worker now keys /data/ files
      by their bare path (one saved copy per file), so gauges, changelog, and
      other board data reappear from the last good fetch when there is no signal.
- [Fix] The map now loads with no internet: the Leaflet map library (1.9.4,
      scripts, styles, and marker/control images) is served from the app itself
      instead of the unpkg CDN, and is saved for offline with the rest of the app
      shell. A cold start with no signal previously left the whole board blank
      because the map library could not be fetched; this also removes the CDN as
      a live single point of failure.
- [Fix] The map legend's scroll cap and the full-sheet list height now include a
      viewport-height fallback for older browsers (roughly Chrome 80-107 and
      iOS 13.4-15.3) that do not understand dynamic viewport units.

## v0.97.63 · 2026-07-24 (Offline app shell: service worker with user-controlled updates)

-- New Features --
- [New] Service worker (/sw.js): the app shell (page, styles, scripts, and brand
      assets at their exact versioned URLs) is saved on install, so opening the
      board with no signal still renders the full frame, complementing the
      existing offline basemap tiles. Live data and the page itself stay
      network-first and only fall back to the saved copy when offline; map tiles,
      radar, and all /api/ endpoints are never intercepted.
- [New] Controlled updates: when a new build is ready, a small "Update available"
      notice offers Reload and Later (English and Spanish); applying swaps to the
      new version with one reload and nothing ever reloads on its own mid-session.

-- Changes --
- [Change] Release tooling now enforces sw.js version agreement (cycle-check plus
         deploy preflight) and verifies the public deploy's service worker carries
         no LAN-only client references; /sw.js is served no-cache so new versions
         propagate immediately.

## v0.97.62 · 2026-07-24 (Visible compass on phones)

-- Changes --
- [Change] The compass rose is far easier to read on phones: the N label and the
         red north needle are larger and bolder, the ring has stronger contrast,
         and the rose now scales up to match the 42px phone map buttons instead
         of staying at desktop size.

## v0.97.61 · 2026-07-23 (Field-use polish: 44px tap targets, always-visible tabs, legible freshness text)

-- Bug Fixes --
- [Fix] A river no longer shows in the ticker or record watch as rising toward a
      crest whose forecast validTime has already passed; the staleness gate now
      lives in gaugeRising so every consumer inherits it.

-- Changes --
- [Change] Field-use tap targets on phones: feed actions, card actions, and header
         controls raised to 44px; bottom-sheet handle to 40px; rain-window chips to
         a 30px touch height. Desktop density unchanged.
- [Change] All five tabs stay physically on-screen at phone widths in English and
         Spanish via shrink plus ellipsis (Team and Resources were scrolling away
         behind a hidden scrollbar); count badges never shrink.
- [Change] Freshness and citation text floored at 12px on phones: refresh meta,
         card timestamps and meta, and source badges.

## v0.97.60 · 2026-07-23 (Mobile legend pills, event-scoped data, record crests, install branding)

-- New Features --
- [New] Web app manifest plus install icons (192px and maskable 512px): Add to Home
      Screen now installs a branded ResponderTX app, and the browser chrome color
      follows the theme (brand navy in dark mode).
- [New] Crest-of-record data regenerated for the active coverage area: 216 gauges now
      carry record stage and date from NWPS historic crests via new
      scripts/gen-records.py, re-lighting record-watch chips and over/near-record
      headlines; recent preliminary crests are excluded so an ongoing event cannot
      become its own record.

-- Bug Fixes --
- [Fix] Mobile legend overhaul: all four map legends (radar, rainfall, inundation,
      surge) collapse to compact pills on phones with tap-to-expand carets; covers
      landscape and 501-820px widths that previously showed a full 230px box
      mid-screen; legends stack above the radar scrub bar without overlap.
- [Fix] Public feed, crest summary, and history playback are scoped to the active
      event from event.json (24h feed notice aging, TS Bertha window and naming),
      ending stale Hill Country carryover on public surfaces.
- [Fix] Team marker colors are gated to hex values before style interpolation on the
      team map and the LAN master view; malformed Content-Length on the team proxy
      now returns a clean 400.

-- Changes --
- [Change] Drive Mode and Crest Summary text tones moved from legacy warm grays to
         brand slate and light for palette consistency and better contrast.

## v0.97.59 · 2026-07-23 (Quality pass: screen-wake reliability, radar retry cleanup, formal Spanish wording)

-- Bug Fixes --
- [Fix] The screen-wake hold could be dropped early in a rare case: if an old wake
      sentinel reported its release after a new one had already been acquired, the
      app forgot the new hold and the screen could dim mid-response. A stale release
      no longer clears a newer hold.
- [Fix] Radar tile retries no longer re-fetch tiles that were already discarded by a
      radar data refresh; a pending retry now checks the tile is still on the map
      before reloading it, saving wasted requests on slow connections.

-- Changes --
- [Change] Spanish interface strings now use the formal register consistently:
         "toca" became "toque" in the map flag tooltip, the tide table loading hint,
         and the three compass control labels.

## v0.97.58 · 2026-07-23 (New camera layer: Hays County flood cams along the San Marcos corridor)

-- New Features --
- [New] Added a dedicated "Hays County flood cams" map layer with the Hays County
      Office of Emergency Services flood cameras along the San Marcos corridor: Post
      Road and Little Arkansas Rd at the Blanco River, the FM150 Onion Creek double
      crossing (north and south), and the two Upper San Marcos NRCS dams. It lives
      under the flood cameras group in the layer sheet, off by default, and the still
      image opens in the viewer with its capture time, aging to a stale badge like the
      other camera sources. Each camera is liveness-checked when the inventory is built,
      so an offline or placeholder-only camera is left out rather than showing a broken
      image, and the layer renders empty and error-free on older snapshots that predate
      it.

## v0.97.57 · 2026-07-23 (Team map: tap a teammate for details, tap the map to place a marker, and see GPS accuracy)

-- New Features --
- [New] Team member markers are now tappable: tap a teammate (or yourself) on the
      map to see their handle, status, role or specialty, how long ago they were
      last seen, and their GPS accuracy, so command can read a unit without opening
      the roster.
- [New] Drop a shared team marker exactly where you want it: tap the drop button to
      arm a "tap the map to place" mode, shown with a crosshair cursor and a hint
      banner, then tap the spot to open the marker form there. A "Use map center"
      button in the hint keeps the old center drop one tap away, and the mode cancels
      itself on Escape, when the marker form opens, or when you switch away from the app.
- [New] Your own position now shows a GPS accuracy ring on the team map so you can
      tell at a glance how precise your fix is, with the exact distance in meters and
      feet in your marker popup. Teammate accuracy shows as a number in their popup,
      keeping the map uncluttered.

## v0.97.56 · 2026-07-23 (Screen stays awake while you share your location in a team or use Drive Mode)

-- New Features --
- [New] Your screen now stays awake while you are actively sharing your location
      with a team or using Drive Mode, so the phone no longer dims and locks in the
      middle of a response. The hold releases the moment you stop sharing, leave the
      team, close Drive Mode, or switch away from the tab, and it comes back when you
      return, so it never keeps the screen on in the background. It needs the secure
      site (https) and a browser that supports screen wake locks; where that is not
      available, such as the plain http LAN board or older iPhones, everything works
      as before and the screen just follows your normal auto-lock.

## v0.97.55 · 2026-07-23 (Radar reliability: missing radar cells now fill in instead of staying blank)

-- Bug Fixes --
- [Fix] Some radar and forecast cells could stay blank after turning the layer on:
      enabling it loaded every animation frame at once, so any tile dropped by the
      busy radar server had no way to recover. The layer now loads the visible "now"
      frame first and adds the rest a moment later, and any tile that fails is retried
      a few times, so cells fill in instead of leaving holes. The forecast layer also
      renders at a lighter native resolution that loads faster and more reliably on
      the slower model server.

## v0.97.54 · 2026-07-23 (Live compass heading: tap the compass to rotate the rose to your device heading)

-- New Features --
- [New] The compass box now rotates to your live device heading when tapped:
      the rose turns so its red north needle points to true north as you turn the
      phone, a hands-free way to orient yourself to what is in front of you. Tap
      again to lock back to the static north-up rose. It is a progressive
      enhancement, so it stays a plain north-up indicator on desktops, unsupported
      browsers, or when motion permission is declined; on iOS 13+ the tap asks for
      the one-time motion permission first, and if no compass signal arrives it
      quietly falls back to north up.

## v0.97.53 · 2026-07-23 (Storm surge risk overlay: NOAA/NHC National Storm Surge Hazard Maps, SLOSH MOM)

-- New Features --
- [New] Storm surge risk map layer (off by default, opt-in under the Tropical group):
      an overlay of the NOAA/NHC National Storm Surge Hazard Maps (SLOSH MOM) showing the
      near worst-case (Category 5) storm-surge inundation banded by height above ground,
      greater than 9 ft (red), greater than 6 ft (orange), greater than 3 ft (yellow), and
      less than 3 ft (blue), plus levee areas, with a compact bottom-right legend citing
      the product; it is a static planning map, not a live forecast, always available
      regardless of active storms, drawn at half opacity so roads and the basemap stay
      readable, and it degrades to a subtle notice if the tile service is unreachable.

## v0.97.52 · 2026-07-23 (Coastal water levels: NOAA CO-OPS observed-vs-predicted storm-surge readout in Resources)

-- New Features --
- [New] Resources now carries a collapsible "Coastal water levels" card reading NOAA CO-OPS
      tide stations from Sabine to Aransas: per station it shows the observed level (ft MLLW),
      the storm-surge residual (observed minus the same-timestamp predicted tide) signed and
      colored, and a rising/falling trend arrow, sorted worst residual first with the
      observation time and a NOAA Tides & Currents citation; it fetches only while the tab is
      open, refreshes on the data cycle, and degrades to a subtle unavailable state per
      station or feed. Ten stations are live; three seed stations with no current sensor data
      (Sabine Pass North, Freeport, Corpus Christi) were dropped.

## v0.97.51 · 2026-07-23 (Compass moved under the Share button as a matching control; dead tap removed)

-- Changes --
- [Change] The north compass is now the third box in the top-right control stack, directly
           below the Share button, and inherits that button's size and chrome so the two
           read as a consistent pair (it was a larger, separate control floating in the
           bottom-right). It is now an honest north-up indicator: the useless tap that did
           nothing was removed, and it no longer relies on the LAN-only chat button for its
           placement.

## v0.97.50 · 2026-07-23 (Tropical tracker auto-defaults ON during an active Texas tropical/hurricane threat)

-- Changes --
- [Change] The tropical-cyclone tracker layer now turns on by itself the first time
           the Texas alert feed carries an active Storm Surge, Tropical Storm, or
           Hurricane Warning or Watch, so the storm shows without a manual toggle
           during an active threat. Turning it off keeps it off, and it stays opt-in
           when no such threat is active.

## v0.97.49 · 2026-07-23 (Social tab merged into Resources: one feed-status-headlined Resources tab)

-- New Features --
- [New] Resources now headlines with a compact live-feed status chip row: the seven data
      sources (Alerts, Gauges, Roads, then Forecast, USGS, Reports, Board), life-safety
      first, each colored fresh, aging, or stale with its age, plus an "updated H:MM CT,
      next in M:SS" line that ticks down with the refresh countdown.

-- Changes --
- [Change] The Social tab is merged into Resources and removed; Resources now hosts, top to
           bottom, the feed-status headline, routing (low-water crossings and recently
           reopened roads), shelters and hotlines, a default-closed "Monitor / verify"
           disclosure (social searches and scanner/nets), a default-closed "Recovery &
           donations" disclosure, and an RSS and crest-calendar footer.
- [Change] Curated Resources to the most actionable items: kept DriveTexas, Texas Flood
           Viewer, SARiverFlood, BEXARflood, Disaster.Texas.gov, Damage.TDEM, and CrowdSource
           Rescue inline; cut four news live-blogs, four map-redundant links (radar, NWPS,
           WaterWatch, EWX office), the TDEM homepage, the fraud/scams monitor group, and the
           monitor workflow paragraph.
- [Change] Legacy ?tab=monitor deep-links and saved views now open Resources; the Team tab
           returns to just left of Resources instead of becoming the rightmost tab.

## v0.97.48 · 2026-07-23 (Tropical cyclone tracker layer: NHC forecast cone, track, positions, and coastal watches and warnings)

-- New Features --
- [New] Tropical cyclone tracker map layer (off by default, opt-in under a new Tropical
      group in the layer sheet): draws the NHC forecast error cone, forecast and observed
      tracks, current and forecast storm positions, and coastal watch and warning lines
      colored by type (hurricane, tropical storm, storm surge; watch vs warning), with
      popups for storm name, classification, max wind, movement, and advisory or valid time.
      Data is NOAA NHC via Esri Living Atlas, keyless and CORS-open; the layer lazy-loads on
      first enable, refreshes on the data cycle while on, and shows nothing when no storms are
      active or a sublayer is empty, degrading quietly on network failure.

-- Bug Fixes --
- [Fix] The radar and forecast legend no longer stretches across the middle of a narrow
      phone screen; on phones it is pinned to a compact bottom-right chip that rides above
      the radar scrub bar.

## v0.97.47 · 2026-07-23 (Coastal pivot for Tropical Storm Bertha: upper Texas coast coverage, surge and tropical alerts surfaced)

-- Bug Fixes --
- [Fix] Storm Surge, Tropical Storm, Hurricane, and High Wind alerts are no longer
      dropped. The NWS alert feed was filtered to the literal word "flood," so the
      most dangerous coastal warnings never appeared on the board; the filter now
      keeps flood plus the coastal, tropical, hurricane, and wind hazard types, and
      local storm reports keep wind and surge events too.

-- Changes --
- [Change] Coverage pivoted from the Hill Country to the upper and mid Texas coast
           (Matagorda to Sabine, inland to Houston and Beaumont) for Tropical Storm
           Bertha, so the board opens on the coast and river gauges, USGS stage, road
           closures, and low-water crossings load there. Configured in data/event.json
           and the snapshot pipeline; revert when the event clears.

## v0.97.46 · 2026-07-23 (Team: phone backgrounding no longer drops you; lost members leave a last-known tombstone; safety notices persist)

-- New Features --
- [New] A field member who drops off (reaped after ~20 min of no contact, or who leaves)
      now leaves a clearly-stale "last known" tombstone on the map, shown hollow, dashed,
      and time-stamped, in both the in-app roster and the LAN command view, instead of the
      unit silently vanishing; the tombstone is retained up to 30 minutes, then removed.
- [New] Team safety notices (team expired, location unavailable, reconnected, you left)
      now show in a dedicated, dismissible notice line in the Team tab that persists until
      you dismiss it or the state changes; location-denied is especially sticky since it
      means you are not actually sharing, and it clears on its own once a fix arrives.

-- Bug Fixes --
- [Fix] mobile backgrounding no longer deletes you from the team: the pagehide leave
      beacon is gated on a real unload, so a bfcache (persisted) background keeps your
      slot, color, and breadcrumb trail instead of re-minting an empty-trail member on
      return; visibilitychange pause/resume and the server TTL still cover a real exit.
- [Fix] the command view now flags a dropped member the moment contact is lost, greying
      the roster row and labelling it "lost contact" with the last-seen time, plus a
      lost-contact count on the LAN command team card, so command is not left unaware.
- [Fix] master command-view map tooltips now escape the team name and handle before
      rendering, matching every other render path (defense-in-depth).

## v0.97.45 · 2026-07-23 (Team status: Unavailable stops sharing but keeps you on the team; clearer active status; readable buttons)

-- New Features --
- [New] Setting your team status to Unavailable now stops sharing your live location
      while keeping you on the team: you still see the roster and map, your marker shows
      hollow and faded as not-live, and switching back to In field, Standby, or Rehab
      resumes sharing automatically, including after a screen-lock or reconnect.
- [New] The self-status control now shows a "Your status" caption, marks the current
      status with a check and a pressed look, tints each button with its status color,
      and adds a one-line note that Unavailable stops sharing while Leave exits the team.

-- Bug Fixes --
- [Fix] selected role, marker-type, status, and K9-skill buttons now use white text so
      they stay readable on the dark accent, instead of near-black text.

-- Changes --
- [Change] the member action button is now "Leave team" (was "Stop sharing & leave")
           now that Unavailable handles stopping sharing without leaving; status buttons
           expose aria-pressed, and an unavailable member shows a "not sharing" cue in
           the roster and "Unavailable · not sharing" in the you-bar.

## v0.97.44 · 2026-07-23 (Modal accessibility: focus-trap, inert background, consistent Escape; the 911 gate stays Escape-immune)

-- New Features --
- [New] Every modal and overlay now traps keyboard focus while open (Tab and Shift-Tab
      cycle within it), moves focus inside on open, and returns focus to the control that
      opened it on close; the rest of the page is made inert and hidden from screen readers
      so only the dialog is reachable.
- [New] Escape now closes the alert reader, the team marker and team role dialogs, and the
      field notes flyout, which previously had no keyboard dismiss.

-- Changes --
- [Change] the 911 self-deploy safety gate is now focus-trapped on its acknowledgment button
           and stays immune to Escape and backdrop dismissal, so it clears only by
           acknowledging it; a release check now guards that behavior against regressions.

## v0.97.43 · 2026-07-23 (Radar and forecast merged into one scrub with a legend; play no longer stalls)

-- Bug Fixes --
- [Fix] Pressing play on the HRRR forecast now animates instead of freezing on the
      first hour. Each forecast hour is now a preloaded map layer and a play step only
      swaps which one is visible, so it never interrupts an in-flight tile load; the old
      cross-fade waited on a network event that never landed while playing, leaving the
      slider and label advancing over a frozen picture.

-- New Features --
- [New] The observed radar and the HRRR forecast are now one "Radar & forecast" toggle
      with a single past to NOW to +12h scrubber and a shared reflectivity (dBZ) legend
      whose source line reads "Observed · RainViewer" or "Forecast · HRRR model" as the
      playhead crosses NOW; enabling it while radar is on starts on the observed picture
      at NOW instead of jumping into the forecast.

-- Changes --
- [Change] the radar-timeline forecast horizon is now +12h (was +18h), keeping every
           projected hour on a single consistent HRRR model run

## v0.97.42 · 2026-07-23 (Team creation works on the LAN board; readable Create team button)

-- Bug Fixes --
- [Fix] Creating or joining a live team now works from the LAN board, not only the
      public site. The board's same-origin /api/team/* calls had nowhere to land on the
      LAN server (the team backend lives only on Cloudflare), so create failed with
      "Could not create the team."; server.py now proxies the non-admin team relay
      endpoints (create, join, leave, position, marker, unmark, update, state) to the
      Cloudflare backend for LAN clients, admin endpoints stay token-gated.
- [Fix] The "Create team" and other primary team buttons now use white label text for
      legible contrast on the accent background, instead of near-black text that was
      unreadable on the dark accent theme.

## v0.97.41 · 2026-07-23 (Gauge no-data: show "no current reading", not the -999 sentinel)

-- Bug Fixes --
- [Fix] A gauge whose upstream source reports no current reading (the -999 no-data
      sentinel, e.g. a sensor briefly offline) now shows "no current reading" on the
      gauge card and the "Am I at risk?" list instead of a literal "-999 ft". These
      gauges were already flagged stale and kept out of the flood, rising, crest, and
      record logic; this only cleans up the displayed value. A real reading that has
      simply gone stale still shows its last value with the stale note.

## v0.97.40 · 2026-07-21 (Internal cleanup: dead code, stale comments, deduped helpers)

-- Changes --
- [Change] internal cleanup with no change to how the board works: removed a dead HTML id
           and an unused print-only CSS selector, fixed stale source comments that named a
           loader file that no longer exists, and folded three identical camera-still
           loaders, two identical filter-control helpers, and a duplicated camera-cache
           sweep into shared helpers

## v0.97.39 · 2026-07-21 (Backgrounded members stay visible, safety gate and admin hardening)

-- Bug Fixes --
- [Fix] a team member whose phone screen locks or who switches away is no longer dropped
      from the team the moment the screen goes dark; sharing pauses instead, their last
      position stays on the command map, and sharing resumes on its own when they return
- [Fix] the 911 do-not-self-deploy safety notice can no longer be dismissed with the
      Escape key or a tap outside it; it now closes only when you tap the acknowledgment button
- [Fix] you can once again leave follow mode by pinching or scrolling to zoom while the map
      is gliding toward your latest location, not only by dragging the map

-- Changes --
- [Change] the LAN command oversight feed, which fans out every team's live positions, is
           now served only to devices on the local network, and its access token is taken
           only from a request header so it can no longer leak through a link or a server log

## v0.97.38 · 2026-07-21 (Social tab name restored, moved to far right)

-- Changes --
- [Change] the tab that holds the live searches, scanners, and road and crossing status
           is named Social again instead of Monitor, and it now sits at the far right of
           the tab bar; only the label and the position changed, the tab contents and
           every shared link and saved view still open it the same way

## v0.97.37 · 2026-07-20 (re-center hint drawer + pulse-then-settle location marker)

-- Changes --
- [Change] the bottom-center re-center pill is gone; the locate button still re-centers
           and re-engages follow when tapped, and a small hint now slides out beside it
           the moment you pan off follow, flashes a few times to point you back to that
           button, then retracts on its own
- [Change] the YOU location marker now pulses just a few times each time you tap locate
           or re-center, then settles into a static dot instead of pulsing forever; live
           tracking keeps moving the marker without restarting the pulse

## v0.97.36 · 2026-07-20 (camera layers grouped into collapsible sub-sections)

-- New Features --
- [New] the Cameras section in the layer panel is now split into three collapsible
      groups, Flood / low-water first, then Traffic, then Border, so the seven camera
      sources are organized by purpose instead of one long flat list

-- Changes --
- [Change] the camera groups start collapsed and open with one tap, so the long list of
           seven camera sources no longer fills the layer panel; a group opens on its
           own whenever a camera in it is already on, so a shared link or active camera
           is never hidden, and each open group shows how many of its cameras are on

## v0.97.35 · 2026-07-20 (Monitor and Resources tabs re-sliced by intent)

-- New Features --
- [New] each of the Monitor and Resources tabs now shows a one-line purpose subtitle
      under its header, in English and Spanish, so the job of each tab is clear at a
      glance
- [New] the Monitor tab workflow steps are now translated into Spanish instead of
      showing English only

-- Changes --
- [Change] renamed the "Social" tab to "Monitor": the label now matches what the tab
           does (live searches, scanners, and road and crossing status to verify) and
           lines up with the tab id and its share link, so every saved view and ?tab=
           link keeps working unchanged
- [Change] re-sliced the two tabs by purpose: low-water crossings, recently reopened
           roads, and the data-source health readout moved onto Monitor, leaving
           Resources as a clean directory of shelters, hotlines, trusted data, and
           subscribe links
- [Change] fixed the recovery-posture note so its fraud-watch pointer names the Monitor
           tab instead of the retired "Social" label

## v0.97.34 · 2026-07-20 (continuous smooth follow-mode tracking)

-- Changes --
- [Change] follow mode now tracks you continuously like a nav app: instead of jumping
           once every 10 seconds, the map takes a live location feed and glides smoothly
           toward each new fix at a steady, even pace, so movement reads as one fluid
           motion at road speed; tapping locate or re-center still snaps you in, and
           panning the map still turns following off

## v0.97.33 · 2026-07-20 (smoother follow-mode tracking)

-- Changes --
- [Change] in follow mode the map now glides smoothly to each new location fix
           instead of snapping across the distance, which reads much better at road
           speed; location updates also step every 10 seconds (was 30) for smaller,
           smoother moves

## v0.97.32 · 2026-07-20 (remove dormant archival-photo overlay)

-- Changes --
- [Removed] retired the dormant archival-photo overlay from historical playback (it had no data source and never displayed on the map); the event timeline and radar scrubber are unchanged

## v0.97.31 · 2026-07-20 (team auto-rejoin, proxy dedup)

-- Bug Fixes --
- [Fix] team members no longer vanish after backgrounding the phone: the app now
      auto-rejoins your team on return to the foreground, restoring your handle, role,
      and profile and resuming location sharing, with a brief "reconnected" note
- [Fix] deliberate "leave team" now reaches the server reliably (it had been posting
      to an empty team id after teardown, so only the server TTL removed the member)

-- Changes --
- [Change] internal: the team relay Pages Functions share one forwarder helper
           instead of repeating the same validation and proxy code in each route (no
           behavior change)

-- New Features --
- [New] tap Locate or "Re-center on me" to follow: the map now keeps you centered as
      your position updates, so you no longer drift off-screen while moving; pan or
      pinch-zoom the map yourself to stop following, in English and Spanish
- [New] a compass in the bottom-right corner always shows which way is north; the map
      is oriented north up, in English and Spanish

-- Changes --
- [Change] the Locate (⌖) button now zooms in to the same closer level as "Re-center
           on me" so both deliberate locates give the same view
- [Change] the "Re-center on me" pill now appears only after you move the map away
           from your location, and hides again once the map is following you

## v0.97.29 · 2026-07-20 (logo: larger wordmark)

-- Changes --
- [Change] header logo wordmark ("ResponderTX" plus the red heartbeat rule) enlarged
           about 20% so the name reads bigger; the Texas-shape mark is unchanged (same
           size), both light and dark lockups

## v0.97.28 · 2026-07-20 (continuous location updates + re-center-on-me control)

-- New Features --
- [New] once you tap Locate and grant permission, your position keeps updating on
      the map about every 30 seconds, in both the app and Drive Mode; the map is
      never pulled back to you on those updates, so panning away stays put, in
      English and Spanish
- [New] a "Re-center on me" pill sits center-bottom of the map once tracking is on
      and is emphasized when your marker scrolls off-screen; tapping it pans back to
      your current location, in English and Spanish

-- Changes --
- [Change] the periodic location refresh that used to run only in Drive Mode now
           persists in the app too and keeps updating after you leave Drive Mode; it
           still pauses while the tab is backgrounded to save battery

## v0.97.27 · 2026-07-20 (team: rehab status, marker assignment, invite filter presets)

-- New Features --
- [New] team members can set a new "Rehab" rest status alongside in field, standby,
      and unavailable; it carries its own roster chip and map-marker style, in English
      and Spanish
- [New] a dropped team marker can now be assigned to a specific member via an optional
      "Assign to" picker in the drop dialog; the assignee's handle shows in the marker
      popup, in English and Spanish
- [New] team invites can carry the creator's current feed filters as a preset via an
      optional create toggle: the active type, county, search, time, distance, and
      in-view scope load for everyone who joins, in English and Spanish

## v0.97.26 · 2026-07-20 (false-complete + polish fixes)

-- Bug Fixes --
- [Fix] browser tab title, og:title, and twitter:title now drop "for Texas" to
      match the shortened header subtitle (they were missed in v0.97.23, so shared
      links and the tab still read "for Texas")
- [Fix] team K9-name input restyled: its class was .tp-input but the stylesheet
      defines .tt-input, so the field had lost its min-height and iOS zoom-safe sizing

-- Changes --
- [Change] SITREP toolbar button's "copied" confirmation now routes through i18n so
           it translates; replaced two blank-value placeholder dashes (playback
           credit, camera capture time) and the El Paso camera-label dash per the
           punctuation style

## v0.97.25 · 2026-07-20 (cameras: add City of Arlington layer)

-- New Features --
- [New] City of Arlington traffic cameras are now their own opt-in camera layer
      (off by default), adding about 60 live arterial-intersection cams in the
      Dallas and Fort Worth area; they appear in the camera viewer, Drive Mode's
      nearest-camera rows, the layer picker, and deep links, labeled in English
      and Spanish

-- Bug Fixes --
- [Fix] the camera inventory builder could no longer refresh because its TxDOT
      ITS minimum-count floor (2000) sat well above the real count after
      duplicate removal (about 800); the floor was corrected so the camera
      poller regenerates cleanly again

-- Changes --
- [Change] refreshed the committed camera inventory alongside the Arlington
           addition; the Houston TranStar set grew (about 963 to 1027 cams) and
           all source counts were re-synced from the live feeds

## v0.97.24 · 2026-07-20 (SITREP: copy plus formatted modal)

-- New Features --
- [New] tapping SITREP now opens a formatted, scrollable situation report in a
      modal on both desktop and mobile, with the section labels (threat, gauges,
      recovery, cut-off areas, active critical, active notices) emphasized; the
      modal offers Copy, Share (where the device supports it), Download, and Close,
      the 911 disclaimer line stays visible, and every button is in English and
      Spanish

-- Changes --
- [Change] SITREP still copies to the clipboard as before, but on mobile it no
           longer replaces the report with the OS share sheet; the text is copied
           and the modal opens every time, and Share is now an explicit button
           inside the modal

## v0.97.23 · 2026-07-20 (header logo polish)

-- Changes --
- [Change] header logo enlarged a touch (38 to 44px desktop, 32 to 36px mobile) so the
           ResponderTX wordmark reads larger; the brand subtitle is shortened to "Live
           Hazard Awareness" (the "for Texas" was dropped), in English and Spanish

## v0.97.22 · 2026-07-20 (multi-type teams: SAR, Response, Recovery, Community)

-- New Features --
- [New] live teams can now be created as one of four types: Search and Rescue (the
      existing model, unchanged and still the default), Response (active-incident first
      responders), Recovery (post-incident cleanup), and Community (volunteer support);
      the create screen adds a team-type picker with a one-line description for each, and
      the type is fixed once the team is made
- [New] each type carries its own member functions: Response, Recovery, and Community
      members pick a single role from that type's list (for example Fire / Rescue,
      Cleanup, or Shelter) plus a status, while SAR keeps its ground/K9 model with K9
      name and skill chips; 20 new function labels ship in English and Spanish

-- Changes --
- [Change] the Durable Object relay is now type-aware: it stores each team's type at
           creation, validates a member's function against only that type's allow-set,
           and hard-gates the K9 fields off for non-SAR teams; existing teams and saved
           profiles read as SAR with no migration, so anything already running is
           unaffected

## v0.97.21 · 2026-07-20 (brand polish: clean header logo lockup, drop duplicate tagline)

-- Bug Fixes --
- [Fix] the header logo rendered horizontally stretched: the .brand column flexbox
      defaulted to align-items:stretch and pulled the width:auto lockup out to the
      sub-line width; .brand now uses align-items:flex-start so the mark and wordmark
      keep their true aspect ratio at any size
- [Fix] the header logo showed the tagline twice: the horizontal lockup baked in
      "LIVE HAZARD AWARENESS FOR TEXAS" and the header also rendered the separate
      sub-line; the header now uses new no-tagline lockups (logo-lockup.png and
      logo-lockup-dark.png: Texas mark plus RESPONDERTX wordmark) so it shows once

-- Changes --
- [Change] enlarged the header wordmark from 32px to 38px (32px on phones) against a
           tighter crop so RESPONDERTX reads clearly instead of cramped; the dark
           lockup's baked textured background is flattened to the flat #0D1B2A header
           surface so it sits seamlessly, and the live dot is preserved

## v0.97.20 · 2026-07-20 (ResponderTX visual rebrand: brand palette, logo, favicon, fonts, name and tagline)

-- Changes --
- [Change] ResponderTX visual rebrand across the app chrome, keeping every
           life-safety color intact: re-mapped the theme variables to the brand
           palette (navy #0D1B2A background, #1B365D panels, red #DC262B reserved
           for the brand mark and danger signal) in both light and dark, without
           touching the flood-severity, alert-severity, or green all-clear scales;
           the header now shows the ResponderTX logo lockup (dark and light art
           swapped by theme) instead of the text wordmark, the tab, bookmark, and
           iOS icons point at the new favicon set and icon.svg, and Inter plus
           Oswald ship as local WOFF2 for offline and CSP-safe fonts
- [Change] renamed the app to ResponderTX with the tagline "Live Hazard Awareness
           for Texas" (English and Spanish); the title, meta description, Open
           Graph and Twitter cards, RSS title, and the remaining responder.rfxn.com
           references now use respondertx.org, paired with a new 1200x630 brand OG
           image at assets/brand/og-card.png

## v0.97.19 · 2026-07-20 (layer sheet: kill horizontal scroll; sweep em-dashes from user-facing text)

-- Bug Fixes --
- [Fix] the map-layers sheet no longer raises a horizontal scrollbar when a long
      camera subtitle wraps; .ls-body now sets overflow-x:hidden and .ls-name and
      .ls-sub wrap with overflow-wrap:anywhere, so labels break cleanly inside the
      fixed 344px panel at both desktop and mobile widths instead of overflowing

-- Changes --
- [Change] swept the em-dash out of user-facing text per the punctuation rule:
           every em-dash in the js/i18n.js en+es UI strings, plus the few built in
           JS (boot glossary rows, the sources alert title and El Paso camera
           credit, the map layer-control camera labels, and team.js fallback
           strings), now uses a spaced middot, colon, comma, or restructured
           phrase; two empty-value placeholders (no timestamp, no photo credit)
           keep a lone dash where nothing else reads as an empty field

## v0.97.18 — 2026-07-20 (El Paso international-bridge live cameras: own opt-in HLS sub-layer, off by default)

-- New Features --
- [New] El Paso international-bridge live cameras: a new Cameras sub-layer
      (camsElpBridge) plots the City of El Paso Rio Grande crossings — Paso del
      Norte, Santa Fe, Stanton, and Ysleta-Zaragoza — as their own independent
      toggle nested with the other camera sources and OFF by default; markers open
      the existing live HLS <video> player (direct CORS-open playback, no proxy and
      no new player) with a ● LIVE badge, each popup and the layer subtitle cite
      City of El Paso, and the toggle travels via ?came=1 with active-layer pill,
      playback-hide, and en+es strings; the 7 streams are liveness-checked at
      generator time (scripts/gen-cameras.py) so rotated/dead stream names drop out

## v0.97.17 — 2026-07-20 (quality-audit fixes: filters badge honors the distance filter's GPS gate; camera edge proxy rejects inherited keys; camera generator aborts on a zeroed source)

-- Bug Fixes --
- [Fix] the ☰ Filters badge no longer counts the distance filter when there is no
      GPS fix: the distance filter only applies once a location is known, so with no
      fix the badge now stays unhighlighted to match the ✓ all-clear feed instead of
      the two disagreeing
- [Fix] the camera edge snapshot proxy (functions/api/cam) now rejects source keys
      that resolve to inherited Object.prototype members (e.g. /api/cam/constructor/x
      or /api/cam/toString/x); an own-property guard returns the same 400 as any
      other unknown source instead of throwing a 500
- [Fix] the camera generator (scripts/gen-cameras.py) now aborts with a non-zero
      exit and leaves data/cameras.json untouched when any of the ITS, USGS river,
      Austin, ATX Floods, or Houston sources returns below a conservative floor, so
      an upstream shape change can no longer silently publish an empty camera layer

-- Changes --
- [Change] the token-gated master oversight routes (admin/list, admin/overview) now
           import the shared functions/api/team/_json.js helper (extended with an
           optional robots argument) instead of admin/util.js carrying a duplicate
           json(); response headers are byte-identical (X-Robots-Tag: noindex,
           nofollow)
- [Change] removed a dead window.i18nSupported export from js/i18n.js that nothing
           read

## v0.97.16 — 2026-07-20 (quality-audit fixes: all-clear wording honors the distance filter's GPS gate; internal json() dedup and dead-code trim)

-- Bug Fixes --
- [Fix] the empty-feed all-clear message (v0.97.14) now shows correctly when a
      distance filter is set but GPS is unavailable: the distance filter only
      applies once a location fix exists, so with no fix it hides nothing, yet the
      board still read "No notices match the current filters" instead of the ✓
      all-clear; the distance term is now gated on having a position, matching the
      filter's own apply condition

-- Changes --
- [Change] the team relay route handlers (create + the [id]/ state/join/leave/
           position/marker/unmark/update endpoints) now import a shared json()
           response helper from functions/api/team/_json.js instead of each
           carrying an identical copy; no response-behavior change (same
           Content-Type, no-store, and X-Robots-Tag noindex headers)
- [Change] dropped a dead write in the map layer-control setup: the
           L.control.layers handle was assigned to state.layerCtl but never read
           anywhere, so it is now created and added without the unused assignment

## v0.97.15 — 2026-07-20 (cameras split into independent per-source sub-layers; add Austin city, ATX Floods, Houston TranStar, and statewide USGS river cams)

-- New Features --
- [New] the Cameras layer is now a group of independently-selectable sub-layers —
      one toggle per source (TxDOT road, USGS river/flood, Austin city, ATX Floods
      low-water crossings, Houston TranStar) — each keeping its own marker style,
      source citation, active-layer pill, playback-hide and deep-link
      (?cams/?camr/?cama/?camf/?camh=1); all off by default and lazy-loaded, so TxDOT
      itself is now an independent toggle
- [New] City of Austin arterial/intersection cameras (817 live, public domain) as
      their own sub-layer, served through a hardened same-origin snapshot proxy
- [New] ATX Floods low-water-crossing flood cameras (26, City of Austin) as the
      flagged flood sub-layer; the newest image is resolved live at view time to
      follow the ~3-min capture cadence
- [New] Houston TranStar cameras (963, incl. Galveston/Bolivar ferry) as their own
      sub-layer, served through the same hardened snapshot proxy — extends camera
      coverage to the Houston metro and upper Texas coast

-- Changes --
- [Change] USGS HIVIS river/flood-gage cameras now use a statewide-TX clip
           (9 to 51 cams), pulling the Houston/DFW/Laredo flood-gage cams that the
           gauge-AO clip previously dropped
- [Change] the /api/cam snapshot proxy (LAN server + Cloudflare edge) now dispatches
           by source key to a strict per-source host + id allowlist and sends a real
           browser User-Agent on every upstream fetch — still a closed, non-open proxy

## v0.97.14 — 2026-07-19 (an empty feed now reads as an all-clear, not a null result)

-- Changes --
- [Change] when the notices feed is empty and no restricting filter is applied, it
           now shows a positive all-clear message ("✓ All clear — no active notices
           right now") instead of "No notices match the current filters"; the filter
           wording still shows when a type/county/search/window/distance filter or
           In-view is what's hiding notices (en + es)

## v0.97.13 — 2026-07-19 (light theme is now the default, with the Streets basemap)

-- Changes --
- [Change] light mode is now the app default (with the Streets basemap) for
           sunlight readability in the field; dark stays one tap away via the
           ☀️/🌙 toggle. A one-time migration clears the previously auto-persisted
           theme so returning visitors adopt the new default; an explicit toggle
           persists as before

## v0.97.12 — 2026-07-19 (road reopenings become their own opt-in flood-only layer, nested under Live road closures, off by default)

-- New Features --
- [New] recently-reopened roads now live on their own map layer, nested under
      "Live road closures" in the layers sheet and OFF by default — the recovery ✓
      markers no longer ride the closures layer, so turning closures on never
      brings reopenings with them (explicit opt-in, no cascade); the toggle travels
      as ?reopen=1 in shared/rollover links and shows a dismissible active-layer
      pill when on

-- Changes --
- [Change] road reopenings are now flood-scoped everywhere they render (the new map
           layer, the Resources panel list, the Drive-mode nearest-hazards tail, and
           playback captions): a new FLOOD_ROAD_RE plus a stored per-road flood flag
           keeps non-flood clearances (generic pavement/debris damage) off the board;
           legacy respondertx.roads.v1 memory without the flag backfills from its
           condition so older Flooding reopenings survive the upgrade

## v0.97.11 — 2026-07-19 (fix: USGS raw-stage fallback stops re-adding itself after you dismiss it)

-- Bug Fixes --
- [Fix] the "USGS stage" raw-gauge fallback layer no longer keeps re-appearing at
      the top-left after you close it: the auto-fallback fired on every refresh
      tick while the live NWPS feed was >15 min stale, re-adding the layer the
      instant you dismissed its pill; it now offers once per outage (on the stale
      transition), honors a dismissal (pill ✕ / sheet toggle) until the live feed
      recovers, and re-arms the one-time offer only for a genuinely new outage

## v0.97.10 — 2026-07-19 (card polish: Team-tab 911 duplicate dropped, alert text button moves to card top-right)

-- Changes --
- [Change] the Team tab no longer repeats the "call 911 — situational awareness,
           not a dispatch system" disclaimer in its create and join views; the
           persistent footer already carries it on every tab, so the duplicate
           (and its now-unused team.safety strings and .tt-safety style) is dropped
- [Change] the flood-alert card's "text ↗" button moves from the meta row up into
           the event header row, right-aligned like the gauge cards' NWPS link, so
           it reads as a consistent per-card action and clears the expires time

## v0.97.9 — 2026-07-19 (rising-to-major chip pulses the target gauges and opens the Gauges tab)

-- New Features --
- [New] tapping the "rising to major" threat chip now frames the target gauges,
      plays a temporary expanding-halo pulse (gauge-attn) on each of their map
      markers so it is obvious which gauges are meant, and opens the Gauges tab
      with every target row scrolled into view and flashed; degrades gracefully
      when the gauge layer is toggled off (list reveal still runs)

-- Changes --
- [Change] the "MAJOR gauges" chip reuses the same focus behavior (frame + marker
           pulse + Gauges-tab reveal) for symmetry, and single-gauge focus now
           settles at a sane zoom (~11) instead of max

## v0.97.8 — 2026-07-20 (mobile presentation: Team tab far-left when active, denser Alerts cards)

-- Changes --
- [Change] the Team tab moves to the far left of the tab bar (before Feed) while a
           team is active, so the crew view is the first thing under your thumb;
           it returns to its default last position when you leave the team
- [Change] Alerts cards are tighter on phones — trimmed card padding, inter-card
           gap, and the spacing/line-height of the event, area, and meta rows to
           reclaim vertical space; the county/coords line, human-readable alert
           link, and severity color are unchanged, and tap targets stay ≥40px;
           desktop layout is unchanged

## v0.97.7 — 2026-07-20 (team security: public pid split from the secret write credential)

-- Bug Fixes --
- [Fix] team relay HIGH-1: a person's ephemeralId was both their public identifier
      AND their sole write credential, and it was disclosed to every participant (in
      /state and /peek member/viewer rows and each marker's byId), so a viewer could
      read a member's id and POST as that member — spoofing its live position or
      markers, or altering/removing it; the role guard only held for a caller using
      its OWN id; split a public non-secret pid (the only id echoed to others, used
      for display/keying/self-detection) from the secret ephemeralId (write
      credential, now returned solely in the caller's own you/publicSelf), so a
      borrowed pid can no longer authenticate a write; team-relay Worker redeploy
      required (see workers/team-relay/README.md)

-- Changes --
- [Change] shared team markers now reference the dropper by public pid (byPid)
           rather than the secret id (byId); the client, LAN master oversight view,
           and self-detection all key the roster and member markers by pid; legacy
           people without a pid get one minted on next touch and legacy byId markers
           are tolerated on read (teams auto-expire in 24h)
- [Change] added the first Durable Object relay tests (tests/team-relay.test.js,
           node:test over a mock DO storage harness): join mints a distinct
           pid+secret, /state exposes pid but never the secret, a viewer holding a
           member's pid cannot write, plus handle/coordinate/sanitize/marker-cap
           guards; wired into node --test tests/

## v0.97.6 — 2026-07-20 (first-class Team tab, clear join, Waze-style drop control)

-- New Features --
- [New] first-class "Team" tab in the sidebar tab bar (Feed/Alerts/Gauges/Social/
      Resources/Team): out of a team it shows roomy create-a-team + join-by-link
      controls; in a team it shows the roster (type/specialty/K9 name/status per
      member, plus viewers), a prominent self-status control, and team controls;
      team map markers keep rendering on any active tab; EN + ES
- [New] Waze-style member-only drop-a-pin control in the bottom-right of the map —
      drops a shared waypoint / hazard / search-area marker (with a short label) at
      the map center via the existing /api/team/{id}/marker flow; shown only to
      members (viewers are 403'd by the relay); EN + ES

-- Changes --
- [Change] join actions relabeled so they read as joining: a primary "Join & share
           my location" and a secondary "Join as viewer (watch only)", with the
           handle / call-sign field labeled directly above them; the ⋮ More → 🧭
           Team menu entry is retained as a shortcut that opens the new Team tab
- [Change] team controls get comfortable ≥44px touch targets on phones — roster
           rows, status toggles, segmented pickers, K9 skill chips, buttons, and the
           map drop control
- [Change] dropped the "don't use your legal name" caveat from the handle help /
           consent text (EN + ES); the ≥4-character handle rule is unchanged
- [Change] removed "HRD" from the offered K9 skill tags (cadaver covers it) in the
           client picklist and the relay's authoritative whitelist; already-stored
           HRD values are preserved on read and on partial updates that omit skills;
           a Worker redeploy is required for the whitelist change (see
           workers/team-relay/README.md)

## v0.97.5 — 2026-07-19 (LAN master oversight view: all teams & viewers)

-- New Features --
- [New] LAN-only master oversight view (command side): a panel that enumerates
      every active team and shows each team's makeup — member count, K9 vs
      ground, specialties, and in-field/standby/unavailable status — plots all
      members on the map reusing the team marker style, and lists every viewer
      across all teams in one combined roster; read-only, 20s poll; injected only
      when the LAN server advertises it (/api/ping master:true) and stripped from
      the public mirror; EN + ES
- [New] global team registry: a single well-known Durable Object records each
      team's id + name + created timestamp on create so teams can be enumerated;
      it holds no positions or markers (the overview fans out to a new read-only
      per-team peek on demand, which never resets a team's idle TTL) and prunes
      ids whose team DO has expired

-- Changes --
- [Change] new token-gated Pages endpoints /api/team/admin/list and
           /api/team/admin/overview require a matching X-Admin-Token
           (env.TEAM_ADMIN_TOKEN secret) and FAIL SAFE (no/wrong token → 403
           empty); server.py proxies them injecting the token from its env so the
           secret never touches git or the browser; the private-team model is
           unchanged (?team= links untouched; the admin path is the only
           enumeration route); Worker redeploy + TEAM_ADMIN_TOKEN secret required
           — see workers/team-relay/README.md

## v0.97.4 — 2026-07-19 (SAR team model: member types, status, shared markers)

-- New Features --
- [New] SAR member profile on join: pick a member type — K9 handler (with a K9
      name field and skill tags: HRD, live-find, trailing, cadaver, area, water,
      evidence, avalanche) or ground member with a specialty (searcher, medical,
      support, drone-ops, comms, swiftwater, command, logistics) — plus a status
      (in-field / standby / unavailable); type, specialty, skills, and status
      render in the roster and on/near the member's map marker (🐕 K9 dot, status
      color/opacity); EN + ES
- [New] members can change their role, type/specialty, skills, and status after
      joining — a one-tap status chip cycles in-field → standby → unavailable in
      the roster, and an ✎ editor switches member↔viewer and edits the SAR
      profile; changes POST to the Durable Object and re-render for everyone
- [New] shared team markers (resurrected drop-a-marker): members drop team-scoped
      waypoint / hazard / search-area pins with a short label, rendered on the map
      for all members and viewers with who dropped it and an age; any member can
      remove one; markers live only in the team's DO (never in git), cap 200, age
      out after 12h; viewers are blocked from dropping/removing (403)
- [New] optional team default area: when creating a team, tick "set current map
      view as the team's default area" to capture the AO (center + zoom); members
      opening the team link recenter to it once on entry
- [New] nearby-facilities callout in the roster: nearest hospital and nearest
      veterinary relative to the team AO, queried live from OpenStreetMap via
      Overpass, with distance and an ER hint where OSM tags it; honestly labelled
      — NOT verified as a trauma center or 24h emergency vet (that designation is
      not in the free source; call ahead), source cited; EN + ES

-- Changes --
- [Change] Durable Object state model extended backward-compatibly: member records
           gain mtype/specialty/k9Name/skills/status, the team gains a markers map
           and optional defaults; new endpoints /update, /marker, /unmark plus
           create now forwards defaults; all existing guardrails preserved (viewer
           403 on position and markers, ≥4-char handles, UUID-gating, TTL reaping,
           positions/markers never persisted outside the DO). Worker redeploy
           required — see workers/team-relay/README.md

## v0.97.3 — 2026-07-19 (team feature surfaced into the main app + share QR)

-- New Features --
- [New] a "🧭 Team" item in the header ⋮ More menu opens live team location
      sharing without needing a ?team= link first: create a private team (shows
      the shareable link plus a scannable client-side QR of it and lets you join
      as a member with a handle), or join an existing team by pasting its link
      or code; if already in a team it reopens the roster; secure-context gated,
      EN + ES
- [New] vendored a minimal QR generator (qrcode-generator v2.0.4, MIT) to render
      the team share link as a scannable code for a second device, entirely
      client-side (the private team UUID never leaves the browser)

## v0.97.2 — 2026-07-19 (Drive Mode auto-updating location)

-- New Features --
- [New] Drive Mode keeps your position fresh while driving: once you tap ⌖ Locate
      (opt-in) it re-locates every 30s and re-ranks the nearest-hazards list by the
      new fix, with a subtle "auto-updating · last fix Xs ago" line under the header;
      EN + ES

-- Changes --
- [Change] the Drive Mode fix loop is lifecycle-bound — it starts only after a
           granted fix with Drive Mode open, stops on exit/Escape/hazard-row tap and
           when the tab is backgrounded (no geolocation drain), and resumes on return;
           one watcher at a time, cleared on close

## v0.97.1 — 2026-07-19 (reopened-road marker redesign + mobile tap targets)

- [Change] the recently-reopened road marker is redrawn as a muted green ✓
           road-recovery badge instead of a plain filled circle, so it reads as
           a "cleared / recovering" signal and no longer looks like an important
           alert marker or blends into the gauge/crossing/camera circle
           iconography; the map legend gains a "road reopened (recovering)"
           swatch; theme-aware in light and dark, EN + ES popup unchanged
- [Fix] mobile tap targets: the reopened ✓ badge, camera, storm-report (LSR),
        and USGS raw-stage markers get a transparent ~44px touch halo at ≤768px,
        centered on the marker anchor so each still points at its true
        coordinate; the visible glyph size is unchanged

## v0.97.0 — 2026-07-19 (live team location sharing — opt-in, private)

- [New] live team location sharing, flag-gated behind ?team= on the secure
      mirror: open a team's unguessable UUID link to join as a member (shares
      your live GPS position) or a viewer (watches without sharing); both set a
      handle (≥4 chars, validated client + server) and appear in the roster
- [New] members render as a distinct colored, labeled map marker with a
      Garmin-style capped breadcrumb trail and a live "last seen" age; the
      self-marker is haloed; position + breadcrumb publish every ~15s and the
      roster polls every ~15s; viewers are listed but drop no marker
- [New] one-tap "stop sharing & leave" clears the geolocation watch and drops you
      from the server, with a pagehide beacon for tab-close; server-side TTL
      reaps stale members, trails, and whole idle teams (20 min / 2 h / 24 h) as
      the backstop
- [New] backend (first server-held state): one Cloudflare Durable Object per team
      holds the only copy of live state — members, viewers, latest positions,
      capped trails — fronted by Pages Functions under functions/api/team/
      (create · join · position · state · leave); the DO authoritatively enforces
      role (viewers cannot publish a position), the ≥4-char handle, coordinate
      validity, and all TTLs
- [New] privacy guardrails: private-by-default with no public teams, X-Robots-Tag
      noindex + Cache-Control no-store on every relay response, ephemeral
      call-sign handles (no accounts, no PII, login can bind later without
      rearchitecture), and team positions NEVER written to git / snapshots /
      exports — the one data class exempt from the git-history archive model
      (EN + ES)

## v0.96.5 — 2026-07-19 (mobile card UX)

- [Change] feed notice cards are built for a phone now: "navigate" and "copy
           coords" are real tappable buttons (bordered, ≥40px touch targets) in
           their own action row instead of bare text links, and the card spacing
           tightens at ≤500px so a crowded feed stays scannable (EN + ES)
- [Change] a notice card's source citation no longer prints the whole raw URL —
           it shows a compact chip link labelled with the platform name or bare
           domain plus a ↗, the full URL kept as the link target and tooltip;
           every card still carries its source, presentation changed not content
- [Change] alert cards wrap cleanly on narrow screens: the event name keeps its
           EMERGENCY flag beside it, the sent/until times stay whole (a label no
           longer splits from its value), and the in-app "text" reader is a
           right-aligned chip — the header stops breaking awkwardly across lines
           (EN + ES)
- [Change] card badges render to one rhythm — CURATED/OFFICIAL provenance and
           the "stale · re-verify" chip get consistent sizing, a clock glyph on
           re-verify, and never wrap mid-label across feed, gauge, alert,
           crossing, and storm-report cards

## v0.96.4 — 2026-07-19 (tap an alert card → the map identifies the one you picked)

- [New] tapping an alert card flies the map to it and now flashes that alert's
      outline and drops a pulsing ping at its center, so in a crowded area (e.g.
      three overlapping Devils River warnings in Val Verde) you can tell exactly
      which one you selected; the ping falls back to the alert's center if its
      polygon is not currently drawn

## v0.96.3 — 2026-07-19 (readable alert cards: river reach + in-app alert text)

- [New] alert cards now name the specific river reach on the second line, so
      the multiple Flood Warnings a county can carry stop looking like duplicates
      — e.g. three "Val Verde, TX" warnings now read "Devils River at Cauthorn
      Ranch near Juno", "…at Bakers Crossing 19N of Comstock", and "…at Pafford
      Crossing near Comstock"; parsed from the NWS product text, shown on the
      card, the map popup, and inside the reader; the alert filter now also
      matches the river name so "(county, river)" search works as promised
- [Change] the alert "text" link used to dump you at a raw api.weather.gov JSON
           URL; it now opens an in-app reader showing the full NWS alert text
           (headline, description, instructions, in-effect-until), cited to the
           issuing office, with a "View raw NWS data" link kept for provenance —
           NWS no longer serves a per-alert human-readable page (EN + ES)

- [Fix] the "Am I at risk?" address card claimed your address "is never logged or transmitted" — but to place the pin the typed address is sent to OpenStreetMap's Nominatim geocoder to turn it into coordinates. Corrected the copy (EN + ES) to say exactly that: the address is sent to the OpenStreetMap geocoder to convert it to coordinates and is not stored, logged, or shared beyond that one lookup. Honesty invariant applies to our own privacy claims too. No behavior change.

## v0.96.1 — 2026-07-19 (drop installable-app manifest)

- [Change] the board is no longer offered as an installable home-screen app: the web-app manifest is removed so phones stop prompting "Add to Home Screen" / "Install." Installed as a standalone app it had no service worker and therefore no reliable way to pick up new versions — it could pin a stale board — whereas an ordinary browser tab honors the board's built-in refresh. Open in your browser as usual; if you already added it to your home screen, delete that icon and reopen from the browser (or re-add — it now opens as a normal tab). Nothing else changes: same URL, same live data, offline map tiles still cached.

## v0.96.0 — 2026-07-19 (unified radar timeline)

- [New] one radar timeline: the live radar scrub and the forecast-model scrub merge into a single bar — observed radar frames on the left, a NOW divider, and the HRRR model future (+1h → +18h) as an amber dashed segment on the right; scrub straight across NOW and the map cross-fades between observed echoes and the model's future with no blank frame; play loops observed → NOW → forecast and starts over (with the forecast layer off, the bar is observed-only exactly as before; forecast-only works too)
- [Fix] forecast stepping no longer stutters: each model hour preloads into a hidden twin layer and cross-fades in (~350ms) once its tiles are ready — the same buffering fix the replay radar got in v0.93.1 — with the next hour prefetched during auto-play, a 250ms settle while you drag, and unchanged hours skipped outright; no more hard redraws between forecast hours
- [Change] forecast tiles render smoother: the model imagery is requested at double resolution and lightly softened so HRRR's blocky ~3km cells read like normative radar instead of pixel squares — it remains a model, and the styling still says so
- [Change] the future zone stays unmistakable: crossing NOW flips the whole bar to the amber dashed forecast dress with the FORECAST MODEL badge, and the readout switches to "+Nh · local valid time" with the model-run time in the tooltip; the +18h no-run-mixing cap stays; during historical playback the playback bar owns time — the radar timeline hides entirely and restores exactly when you return to NOW
- [Change] layer picker and glossary wording updated for the single bar: the Radar row is the observed past of the radar timeline, and the Forecast radar row extends the same bar beyond NOW; English y español

## v0.95.1 — 2026-07-19 (visual QA fixes)

- [Fix] the ops-chat button no longer covers the replay bar's NOW and ✕ controls on desktop: while the timeline bar is open the chat button rides above it (phones already did this), and the amber forecast scrub now keeps clear of the chat-button corner at every width — narrow desktops cap its width and phones anchor it left of the corner
- [Fix] Spanish threat-strip counters no longer cut off mid-phrase ("medidores nivel MAYOR", "cerca del récord histórico"): counter labels now wrap to a second line instead of truncating, so no meaning-carrying word is ever lost; the phone strip keeps its one-line sideways-scrolling chips
- [Fix] gauge and report popups opened from search or a card tap no longer slide up under the top of the map on phones: the popup now opens after the map flight settles (opening mid-flight mis-aimed the auto-pan) and pans clear of the area chip at the map's top edge
- [Fix] feed-card text no longer runs under the floating sheet-size control and chat button on phones: the card list leaves a clear band on the right at phone widths, so line ends stay readable
- [Fix] the chat unread badge is capped at "99+", and a first visit on a new device no longer opens to a three-digit badge counting the whole chat history — the first load baselines what's already been said, and only messages after that count as unread (devices that have visited before keep their real unread count)
- [Fix] español: a rising river wave is now "crecida" (the standard hydrology term) instead of "onda" in the situation headline
- [Fix] road closure popups no longer show TxDOT's leading "-" artifact in front of the description text (display-only cleanup; the source data is untouched)

## v0.95.0 — 2026-07-19 (HRRR future-cast radar layer)

- [New] "Forecast radar (HRRR model)" map layer: NOAA's HRRR weather model rendered as a radar-style overlay so you can see where the model expects storms over the next 18 hours — served keyless via the Iowa Environmental Mesonet WMS (one layer per forecast step, always the latest hourly model run; the scrub stops at +18h on purpose because hours beyond that would silently come from an older model run). Off by default, in the layer picker's Rain & radar group with its own layer pill; the layer row, glossary entry, and attribution all state NOAA HRRR via Iowa Environmental Mesonet
- [New] forecast-hour scrub: turning the layer on shows a distinct amber, dashed-border control with a persistent "FORECAST MODEL" badge — deliberately unmistakable from the grey live-radar scrub, because a model's guess about the future must never read as observed radar; step +1h → +18h (default +1h), play/pause loop, and the readout shows the forecast offset plus the valid local time ("+3h · Jul 19, 4:00 AM CT") with the model-run time in the tooltip; the model run refreshes automatically as new HRRR cycles land (hourly, ~50 min behind); shared links carry the layer (`fcst=1`); English y español (`fcst.*`)
- [New] forecast + live radar can be on together (they answer different questions: what's happening vs what's expected) — the two scrub bars stack vertically and never collide, on phones included
- [Change] during historical playback the forecast layer is hidden with the other live-only layers and named in the truth line — a model future has no place in a historical replay; it restores exactly when you return to NOW
- [Fix] a crafted `?base=` value in a shared link (e.g. `?base=toString`) can no longer confuse the basemap picker: the value is now checked as a real basemap name (same guard pattern as the v0.94.1 `?theme=` fix), anything unrecognized falls back to your saved choice or Streets

## v0.94.1 — 2026-07-19 (defect fixes)

- [Fix] a bad `?theme=` value in a shared link no longer breaks the board: the theme is now checked against the two valid choices (dark/light) at startup and inside the theme switcher, an unrecognized value falls back to dark instead of stopping the page from loading, and a previously saved bad value is repaired automatically on the next visit — the broken link no longer poisons future visits
- [Fix] switching cameras quickly in the camera viewer can no longer mislabel imagery: a slow response from the first camera is now discarded instead of overwriting the second camera's picture and caption, and a response arriving after the viewer closes is dropped cleanly (no leaked image memory)
- [Fix] the map layer pills (Radar, Rainfall, and friends) now honor the same lock as the layer picker while a replay is playing: tapping a pill's ✕ during a replay shows the "press NOW to change layers" note instead of silently dropping that layer from your live view when the replay ends
- [Fix] the point-check card (long-press / right-click on the map, and search-by-coordinates) now states "⏮ LIVE data — the map is showing a replay" when opened during a replay, so its live readings are never mistaken for the historical frame on screen; English y español (`inspect.live`)
- [Change] the replay's dashed river-peak line is now labeled "river peaks in sequence" instead of "crest moving downstream" — the pairing is based on peak timing on the same river, not verified river direction, and the label no longer claims more than the data shows; English y español
- [Fix] replay radar/rainfall no longer freezes on a stalled pre-loaded time-step: the 2.5s catch-up fallback now also covers buckets that were prefetched but never finished loading, and the very first replay step now loads the correct time-step instead of briefly requesting the pre-jump one
- [Fix] a board that starts in degraded mode (data sources failing) now still learns about app updates — the update check runs before the degraded early-return
- [Fix] shared links and automatic update reloads now carry the Radar, Cameras, USGS gauges, crossing-inventory, and inundation layer toggles (added to the link only when a layer is on — default links stay short), so an update mid-shift no longer quietly turns those layers off
- [Fix] links that deep-link to a map position (`mlat`/`mlon`) now skip the first-run welcome tour like other deep links
- [Fix] alert popup and alert card "text" links now pass through the same link-safety check as every other external link

## v0.94.0 — 2026-07-19 (calmer map chrome: collapsed area chip + matched controls)

- [Change] the area quick-jump row collapses to a single context chip ("◎ Full AO ▾") on every screen size: the chip always names the area in view — picking a preset updates it, and panning away from a picked area flips it to "◎ custom view" (bounds check against the map center) so the label never claims an area the map has left; tapping the chip expands the full preset row in place (horizontal scroll on phones), picking an area jumps the map and collapses the row immediately (the map flight is the confirmation — a lingering row would compete with it), and tap-outside, Escape, or ~6s of no interaction also collapse it; EN+ES (`ao.current.title`, `ao.chip.title`, `ao.custom`)
- [Change] the map-layers and share buttons drop their emoji glyphs for clean stroke icons, and the whole map-control family (zoom + / −, locate ⌖, layers, share) now shares one theme-aware style — app surface background, hairline separators, matched border, radius, and hover in both dark and light themes (desktop emoji fonts drew the layers glyph as a flat black box that clashed with the zoom bar)
- [New] road closure popups state the segment's length ("49 mi segment", shown at ≥2 mi, computed from the reported geometry) beside the from → to limits, plus a condition-aware note: closures say TxDOT barricades the full stretch between the listed limits even if water or damage is localized within it; flooding/damage reports say the condition may be localized within the stretch; EN+ES (`road.seg`, `road.note.closure`, `road.note.cond`)

## v0.93.2 — 2026-07-19

- [Change] Radar scrub label reads just "now" (removed "no future-cast in free
 feed" caveat

## v0.93.1 — 2026-07-18 (smooth replay radar/rainfall transitions)

- [Fix] replay radar no longer redraws jarringly on every step: the archived IEM radar and MRMS rainfall layers each become a two-layer A/B buffer — a bucket change loads the new stamp into the hidden layer, waits for its tiles to finish fetching ('load' event, 2.5s fallback for archive gaps), then cross-fades opacity (~350ms CSS transition) and swaps roles, so the visible layer never blanks to empty tiles mid-replay; frames whose 5-min radar / hourly rainfall bucket is unchanged are skipped outright (15-min frames over hourly rainfall stamps = 3 of 4 frames do nothing at all — previously every setUrl redraw churned)
- [Change] replay tile loading matches the v0.84 SBW cadence: scrub drags settle ~250ms before a new bucket loads (no mid-drag refetch churn), and during play the next frame's bucket prefetches into the hidden buffer as soon as a fade completes, so sequential playback becomes a pre-warmed loop; NOW/exit tears down both buffer layers and restores the live radar/rainfall layers exactly as before

## v0.93.0 — 2026-07-18 (replay time-integrity + richer replay layers)

- [Fix] time-integrity sweep across every map overlay during playback: each layer is now (a) replayed from a real archive, (b) re-rendered as-of the frame from item timestamps, or (c) hidden with an honest live-only note — nothing live may impersonate the past. Time-filtered per frame: curated notices/requests + cut-off circles (visible from each card's `ts` through its live aging window), curated crossings (visible only from their curator `updated_at` forward — the status before that update is unknown), and storm reports (live feed + this device's 7d LSR history, each visible for 3h after its valid time; the honest variant of the suggested ±3h — a report never renders before it was made). Hidden while a historical frame is up (restored exactly on NOW/exit): shelters (resources.json carries no open/close timestamps — inventing them would fake history), cameras (live imagery in a historical frame is a lie), USGS raw stage, RFC forecast-crest rings, and the NWM inundation model (all live now-state). The live RainViewer radar scrub is hidden+inert while the IEM archive radar replays (previously dragging it painted live radar over a historical frame), the auto-USGS-fallback can no longer add its live layer mid-playback, and the dimmed live threat strip gains an explicit "⏮ Replay on the map — this panel shows LIVE current data" line. The truth line now enumerates all three regimes: replaying / as-of-frame / hidden (live-only, named layers)
- [New] rainfall replay: the unified Rainfall layer joins playback via IEM's archived MRMS accumulation tiles (probed live: `mrms::p{1,24,48,72}h-YYYYMMDDHHMM` serves PNG tiles at hourly stamps across the whole event span; sub-hourly stamps 503) — when Rainfall is on, engaging playback swaps it for the archive tile layer at the frame's hour in the user's chosen 1h/24h/48h/72h window, updating as the frame advances, and the truth line states the window and the exact hour shown (" + rainfall 24h (IEM MRMS archive, hour ending Jul 17, 2:00 PM CT)")
- [New] critical-events narrative: the caption/story stream gains curated-notice events merged chronologically with the existing gauge/warning/road captions — evacuation ("🏃 EVACUATION — Asherton area"), cut-off areas, shelter openings, rescues, and critical-priority notices of any type, each at its curated `ts`; significance-ranked so evacuations/cut-offs tie-break above warnings; EN+ES (`playback.story.evac/cutoff/shelter/rescue/critical`)
- [New] replay-media hook (framework only): optional `data/replay-media.json` ({items:[{t, lat, lon, title, img, source_url, credit}]}) loads best-effort at playback open (404 = dormant); when play crosses an item's timestamp the map shows one small archival photo card at its location — sepia/bordered with a "🕰 ARCHIVAL · <frame date>" badge, thumbnail, title, and a prominent credit + source link — max one visible, auto-dismissing after ~6 frames or via ✕, forward crossings only (scrubbing back never resurrects one); EN+ES (`playback.media.*`)
- [Change] playback popups for as-of-frame items (notices, cut-off circles, crossings, storm reports) carry the ⏮ PLAYBACK frame stamp like gauge/road/warning popups

## v0.92.0 — 2026-07-18 (map↔list sync)

- [New] "Open in feed →" on every notice/request map popup — marker and cut-off-circle popups gain an action that switches to the Feed tab, scrolls the matching card into view, and flash-highlights it with a ~1.5s outline pulse (UX ladder ref: PulsePoint/HCFWS — map and list should feel like one product; list→map tap-to-fly existed since early builds, this ships the reverse path); gauge popups likewise gain "Open in gauges list →" which reveals that gauge's row on the Gauges tab, auto-unfolding the "show N gauges normal" section when the gauge lives there; one shared `revealInList` helper (tab switch + scroll + pulse) drives both paths, and cards/rows carry stable `data-rid`/`data-lid` anchors; EN+ES (`sync.openfeed`, `sync.opengauges`)
- [New] "In view" filter chip on the Feed filter row and the Gauges chip row: scopes the list to items whose lat/lon fall inside the current map viewport, live-updating on map pan/zoom (moveend, 300ms debounce) with a count in the chip ("In view · 12"); AND-composes with the existing type/county/window/distance/search filters and the smart sort keeps ordering the filtered set; the chip scopes the LIST only — map markers keep showing every filter-passing item since the map is the filter source; feed cards without coordinates drop out while the chip is on (nothing to place in a viewport); chip state persists per-session only (sessionStorage — a stale viewport filter surviving a reopen would confuse), counts into the "☰ Filters (n)" badge, and the seed-hash scroll guard for background refreshes is untouched when the chip is off (the moveend re-render path early-returns unless the chip is on); EN+ES (`sync.inview`, `sync.inview.title`)
- [Change] discoverability polish for list→map flight: feed cards with coordinates and every gauge row show a subtle 📍 glyph in the card head ("On the map — tap to fly there" tooltip) so the existing tap-to-fly affordance is visible before the first tap; EN+ES (`sync.geoflag.title`)

## v0.91.0 — 2026-07-18 (playback: the full incident picture)

- [New] road closures replay in playback: `gen-history.py` now walks the git history of `data/roads-snapshot.json` (the archive started ~02:14Z Jul 19) AND every record's own TxDOT-posted start/end window, unioning both signals into per-frame road state — `history.json` gains an additive `roadIndex` {rid:{cond,route,v,start,end}} + per-frame `roads` id arrays + a `roadsFrom` boundary stamp (current build: 84 closures indexed, all 417 frames carry road state, 417 reconstructed / 0 archived — the gauge frames end 4 min before the road archive's first snapshot); during playback the live TxDOT road layer swaps for archive markers (⛔ closed / 🌊 flooded / ⚠ damage at the closure's first vertex, condition-colored) that appear and disappear per frame, popups show the posted closure window + OFFICIAL badge + frame stamp, and the truth line says which regime the frame is in — " + roads (archived snapshots)" vs " + roads (reconstructed from posted closure times)" — with roads removed from the "showing live" list; the frame HUD adds a ⛔ closure count; identity keys on (route,start) because DriveTexas OBJECTIDs are unstable (also fixed: `gen-roads-snapshot.py` now captures the feature-level id that `f=geojson` moves out of properties); EN+ES (`playback.note.roads.*`, `playback.note.live2`, `playback.road.*`)
- [New] prominent gauge callouts during playback: playback markers scale by category with majors ≈ 2× the live size (32px vs 18), a colored pulse ring fires on any gauge whose category changed that frame and decays over ~3 frames, and the top 5 most significant flooding gauges get small always-visible name+stage labels — ranked category first (majors always label before moderates: threats-to-life first), then proximity to the historical record (crest-summary %), then stage; labels collision-nudge downward when they'd overlap and hide below zoom 8; all of it visual-only over the archived values, stale sensors keep their dashed grey and never pulse or label
- [New] crest-flow animation: when the crest summary shows a crest translating between two gauges on the same river (consecutive moderate/major peaks ordered by peak time, 1-96h apart, 3-150 mi apart — tonight's real case: Devils R Cauthorn Ranch → Bakers Crossing → Pafford Crossing; also the Llano, Pecos, Cibolo, and Nueces chains), playback draws an animated dashed line from the earlier peak to the later one during the frames between the two peaks, with a "▸ crest moving downstream" pill at the midpoint; the line is a straight great-circle segment on purpose — tracing river geometry would be invented precision, the dash motion conveys direction while staying honestly schematic; capped at the 3 most significant active translations; EN+ES (`playback.crestflow`)
- [New] story captions gain closure-onset events from the archived road index ("⛔ FM 481: Road CLOSED" at the TxDOT-posted start time), joining the existing rise/fall/crest/warning/reopen caption track
- [Change] `history.json` frame contract documented as hazard-agnostic and additive in `gen-history.py`: {frames:[{t, gauges:{}, roads:[], src?}], gaugeIndex, roadIndex, roadsFrom} — future hazard sources add a parallel per-frame array + top-level index, existing keys never rename; total-size budget raised 900KB → 1150KB for the road payload (current build 839.5 KB)

## v0.90.1 — 2026-07-18 (condensed headline + one-row 911 footer)

- [Change] the plain-language situation line is now a slim one-line strip at every width: smaller type, tighter padding, single-line ellipsis enforced on desktop and phone alike (phone min-height 34→24px); tap-to-expand for the full sentence is unchanged
- [Fix] headline wave clause no longer derives its direction word from the forecast delta alone (it read "Devils River wave rising at Bakers Crossing" while that gauge was observed falling): direction now comes from the observed trend — "rising" only when the trend is genuinely up, "{river} wave receding at {site}" when falling, no direction word when no trend baseline exists yet (fresh browser), and the clause is dropped entirely when the trend is steady; EN+ES (`headline.wave.down`, `headline.wave.nodir`)
- [Change] the bottom 911 strip condenses to exactly one row at every width: "⚠ 911 emergencies · not a dispatch system · tap for full notice" with single-line ellipsis at narrow widths and the red 911 emphasis kept; tapping the strip opens the full safety-notice modal at any width (the notice text itself is untouched, and the ack button now always closes the modal — previously it was only wired on first run), and the version stamp becomes a right-aligned underlined link that opens What's New (still driven by APP_VERSION); EN+ES (`disc.short` reworded, `disc.full` unchanged)

## v0.90.0 — 2026-07-18 (unified Rainfall layer)

- [New] unified Rainfall overlay (ref: Harris County FWS — one rainfall view with a time-window selector beats N separate checkboxes): the independent "Rain 1h" / "Rain 24h" MRMS overlays, which could confusingly be enabled simultaneously, collapse into a single "Rainfall" layer; when it is on, the MRMS legend gains 1h/24h/48h/72h window chips (all four IEM accumulation tile services probed live and serving PNG tiles — `q2-n1p`/`q2-p24h`/`q2-p48h`/`q2-p72h`; 3h/6h/12h do not exist upstream) — tapping a chip swaps the tile URL on the same layer object in place (no remove/re-add flicker), retitles the legend ("Rainfall accumulation 48h (MRMS)"), and persists the chosen window for the session (`respondertx.rainwin`); the layer sheet shows one Rainfall row with pick-a-window subtext, the pill row one "Rainfall" pill, and the glossary gains a 🌧 rainfall entry; EN+ES (`layers.rain`, `sheet.s.rain`, `leg.rain.acc`, `leg.rain.win`, `glossary.rain.*`)
- [New] map Share control: "keep the share option a top level first class citizen, maybe the share icon goes below the layer picker overlayed in the map? And stays in the hamburger menu also"): a 🔗 button sits directly below the 🗂 layer-sheet trigger in the map's top-right control stack, driving the exact same share handler as the ⋮ menu entry (which stays); copied-link feedback flips the control to ✓ for 2s, and the shared restore-original-content swap means the ⋮ entry no longer resets to hard-coded English after copying
- [Change] share links and the v0.87 update rollover now carry rainfall state (`?rain=<window>` serialized when the layer is on — previously rainfall never survived a rollover); legacy deep links map cleanly: `?rain=1h` → Rainfall@1h, `?rain=24h` → Rainfall@24h, both present → 24h wins, unknown values ignored
- [Change] the window chips honor the playback read-only regime: while playback is engaged the rainfall window is locked, matching the layer sheet — MRMS remains a live-only layer under playback (unchanged since v0.82), and the playback truth line is unaffected

## v0.89.0 — 2026-07-18 (grouped layer sheet)

- [New] grouped layer sheet (ref: Watch Duty's curated grouped legend; the competitive analysis called the stock Leaflet checkbox control "the weakest navigation surface in the app"): the raw 17-checkbox popup is replaced by a custom picker — a thumb-zone bottom sheet on phones (tap-outside, Escape, and swipe-down dismiss, grab bar, safe-area padding) and a compact panel anchored where the old control sat on desktop; content is grouped (Basemap, Water, Rain & radar, Roads, Alerts & reports, History) with a plain-language name, a one-line "what is this" subtext, an icon, and a ≥48px touch target per row, switch-style knobs reflecting live state, and OFFICIAL/CURATED provenance mini-badges where the distinction matters (the crossings pair — curator-verified status vs TxGIO all-locations inventory — plus notices and shelters); a segmented Dark/Light/Streets basemap row sits at the top; the History group's ⏮ Playback row is an entry point that opens the playback timeline, not a checkbox; EN+ES (`sheet.*`, new `layers.*` names)
- [New] "↺ Reset to default view" button in the sheet: turns off every non-default overlay, restores the default-on set (gauges, alerts, crests, notices, shelters, crossings, roads, storm reports, labels), returns the basemap to Streets, and reframes the Full AO (same bounds as the AO chip) — tab and feed state untouched; EN+ES
- [Change] the sheet opens from a 🗂 button in the old control's top-right anchor spot and from the layer-pill row's ＋ (which previously expanded the stock control); Drive Mode stays minimal — no new entry point there; the pill row itself is unchanged
- [Change] the stock `L.control.layers` stays mounted but hidden — it remains the overlay-event registry, so sheet toggles go through `map.addLayer/removeLayer` and the map still fires `overlayadd`/`overlayremove`/`baselayerchange`: camera and crossing-inventory lazy-loads, the MRMS legend, radar-scrub visibility, layer pills, theme/base persistence, and programmatic enables (`?cams=1`, `?radar=1`, `?rain=`, USGS auto-fallback) all keep working and the sheet's rows mirror them live
- [Change] while playback is engaged the sheet goes read-only with an explainer note ("Playback is replaying archived layers — press NOW to change layers") — it reflects the playback layer swaps but never fights them; the sheet also joins the Escape-dismiss chain and the update-rollover busy list

## v0.88.1 — 2026-07-18 (header declutter)

- [Change] header declutter: the header now shows only the direct-action controls — 🔍 search, 🚗 Drive, ⟳ refresh — plus a single ⋮ overflow button; Share, theme, language, and "?" Legend move into the ⋮ dropdown as icon+label entries (labels visible at every width — discoverability lives in the menu now); the menu uses the standard dismiss pattern (tap-outside, Escape, closes after picking an entry) with `aria-haspopup`/`aria-expanded` on the trigger; all four relocated buttons keep their ids and handlers, so theme persistence, `?lang=`/`?theme=` deep links, and the onboarding panel-3 legend link are untouched; EN+ES (`ctl.more.*`)
- [Change] updated-stamp slimmed: the corner note is now a small green freshness dot + time ("● 8:42 PM CT") instead of "updated 8:42 PM CT", and the visible "next in m:ss" countdown moves into the stamp's tooltip (the data-age bar already owns staleness warnings); degraded/offline/snapshot notes are unchanged
- [Change] phone header tap targets grow 36→40px with 8px gaps (was 5px) between the four remaining controls; header vertical padding tightens 4→2px so the header height does not grow; the ⬆ update chip stays outside the menu (it is a state indicator, not an action) as does the hidden-by-default 🏠 risk button (`?risk=1` reveals it as before)

- [New] snapshot-only TxDOT ITS cameras (deferred Part B of v0.83.0): 835 cams that serve fresh JPEG snapshots (~2-min refresh) but have no HLS stream — mostly Houston (+347), Fort Worth (+139), Dallas (+95), Beaumont (+69), and El Paso (+31) surface streets — join the camera layer; `gen-cameras.py` gains an ITS pass over all 25 TxDOT districts (`GetCctvStatusListByDistrict`), keeping online+snapshot heads not already within 150 m of a MapLarge streamable cam (streamable wins; 3,124 near-duplicates dropped, 91 skipped whose ids contain `/` — unroutable in a URL path segment)
- [New] `/api/cam/<district>/<icd>` snapshot proxy, both tiers (the ITS endpoints have no CORS): a Cloudflare Pages Function modeled on the gauge proxy (edge-cached 120 s, district `^[A-Z]{3}$` and icd charset-validated against the generator's exact allowlist — not an open proxy) and a matching stdlib route in `server.py` (120-s in-memory cache with expired-entry sweep); both decode the upstream base64 `snippet` and serve raw `image/jpeg` with the capture stamp in an `X-Cam-Captured` header
- [New] snapshot viewer: ITS cams open as a fetched still (blob, so the capture header is readable) with a SNAPSHOT badge — never the LIVE player — plus "captured <time>" parsed from the ITS Central-time stamp, the standard ⏱ STALE badge >45 min (aging invariant), a ↻ refresh button (cache-busted re-fetch), TxDOT attribution, and an honest "Snapshot unavailable right now" state on proxy failure (never a broken-image icon); map markers are dashed/muted 📷 so a still never reads as live, popup subtitle says "snapshot cam (still)", and the Legend gains a snapshot-cam row; EN+ES (`cam.snapcam`, `cam.snapshot`, `cam.refresh`, `cam.its.note`, `cam.snap.unavail`, `glossary.camsnap.*`)

## v0.87.0 — 2026-07-18 (graceful dynamic refresh)

- [New] graceful update rollover: "dynamic refreshing the app so updates pull in as gracefully as possible"): the board ships many times a day but long-lived tabs ran old code until someone tapped the ⬆ chip — now when the 3-min cycle's changelog.json check sees a newer version the app rolls itself over: it waits for full idle (no overlay up — safety ack, onboarding, hydrograph, crest summary, glossary, camera viewer, Drive Mode, risk check, changelog; playback closed, intake form closed, header search closed, LAN chat panel closed, no touch/click/key/scroll in the last 20s, no data refresh in flight, tab visible — a hidden tab rolls on return instead), then shows a quiet 4s toast "Board updated to vX.Y.Z — reloading…" with a Later button (postpones 5 min; any re-engagement during the 4s aborts and retries at next idle), captures the full view with the existing Share serializer (map center/zoom, tab, feed+alert filters, sort, basemap, theme) into sessionStorage and the reload URL, and `location.replace()`s into the new build — the fresh index.html pulls the new `?v=` assets; on boot the view restores exactly, the restore URL is cleaned so later manual reloads use the saved view, and a 2s "✓ Updated to vX.Y.Z" confirmation toast opens What's New on tap; EN+ES (`update.reloading`/`update.later`/`update.done`)
- [New] rollover safety rails: a malformed state blob boots defaults (try/catch + clear); a rollover that still boots the old build (CDN propagation lag) suppresses the false "updated" confirmation and holds further rollovers for 10 min (`respondertx.rolledTo`) so the board can never reload-loop; a serializer failure degrades to a plain reload; an unsent LAN chat compose draft is parked in sessionStorage across the reload and restored into the compose box ("unsent draft restored after board update")
- [Change] the ⬆ update chip stays as the immediate manual reload path; the chip and the automatic rollover arm from the same per-cycle version check

## v0.86.0 — 2026-07-18 (onboarding + glossary + search)

- [New] first-run onboarding (refs: FEMA app's illustrated help, Watch Duty's symbol FAQs): a dismissible 3-panel overlay shown once per device (`respondertx.onboardSeen`), chained strictly AFTER the 911 safety modal is acknowledged — it never competes with the safety ack; three ~15-word panels with small illustrations built from existing UI glyphs (no new image assets): (1) "The map is live hazards: gauges, warnings, roads, cameras" with live gauge-category dots, (2) "The feed is verified notices: newest first, stale items age out" with a NEW/aged mini-card pair, (3) "Long-press the map for a point report · ⏮ replays the event" with a "? anytime for the legend" link that opens the new glossary; swipeable panels + Next/Got it button + always-visible Skip; deep-link entries (`?playback=`, `?hydro=`, `?view=`, `?fq=`, `?cams=`, `?cam=`, `?pbt=`) suppress onboarding entirely and mark it seen so a shared link never gets interrupted; Escape dismisses and counts as seen; EN+ES (`onboard.*`)
- [New] "?" glossary (ref: Watch Duty's "what are the red dots" FAQs): a "?" Legend button in the header (matching the theme/lang toggle styling) opens a scrollable overlay explaining every board symbol, rebuilt from i18n strings on each open so live language switches localize it — gauge category colors (action/minor/moderate/major, real swatches) plus the STALE dashed state, map markers (▲ rising, ▼ falling, forecast-crest ring, 💧 LSR, 📷 cameras, ⛔/🌊 TxDOT closures, ✓ reopened, crossing states, notice glyphs), every threat-strip chip, the OFFICIAL vs CURATED provenance badges (reusing the live srcBadge markup and tooltip copy), aging semantics ("aged items are suppressed, not deleted — toggle history layers"), playback (⏮ + hatched pre-archive span), and a USNG note; uses the standard modal pattern (✕ / tap-outside / Escape); EN+ES (`glossary.*`)
- [New] header search (ref: every consumer map): one 🔍 magnifier in the header (header density is already high, so magnifier-only at every width; on phones the expanded box takes over the top bar) accepting four input shapes — place/address (existing Nominatim geocoder, AO-biased "…, Texas" like the risk check, never logged), typed "lat, lon" pairs (same parser rules as the intake pin field), gauge LID or gauge-name substring (exact-LID wins, else up to 5 name matches in a pick list → focusGauge), and R-### radio card IDs (existing flyToRadioId); a place or coords result flies the map and drops the v0.85.0 point-inspector card at the spot — search is the typed version of long-press; multi-hit geocodes show a simple max-5 esc()'d pick list, no autocomplete; EN+ES (`search.*`)
- [Change] the feed's separate "🔍 ID" button is absorbed by the header search (same flyToRadioId logic, no duplication) — the button and its handler are removed; `?fq=` deep links and typing an ID into the feed filter box still fly to the card exactly as before
- [Change] geocoder refactor: `nominatimSearchN(q, n)` multi-result variant added; the existing single-result `nominatimSearch()` now wraps it (intake form and risk-check behavior unchanged)
- [Fix] the one-time Drive Mode hint no longer fires over the safety modal or onboarding overlay (screenshot finding: two nudges at once on first run) — it defers while either is up and shows on the next visit instead

## v0.85.1 — 2026-07-18 (playback mobile quality pass)

- [Fix] playback tap-through: "very hard to tap on mobile and often zooms the map"): the playback bar, ⏮ pill, PLAYBACK badge, and radar scrub strip now carry the same Leaflet `disableClickPropagation` + `disableScrollPropagation` guards as the AO chips and layer pills, so taps on the scrub, ⏪/⏩ steps, range chips, speed, play, NOW, ✕, caption, HUD, and chapter ticks never reach the map (no more double-tap zoom); `touch-action: manipulation` on every control and `touch-action: none` on both sliders stops browser double-tap zoom at the source
- [Fix] fat-finger scrub: the timeline slider is now custom-drawn — slim 6px visual track over a 44px-tall hit area at phone widths (34px desktop) with a 28px thumb (22px desktop); at ≤500px the scrub takes a full-width row of its own and ⏪/⏩/▶/speed/NOW grow to ≥44px tap targets (✕ 40px), chapter ticks get bigger too
- [Fix] range clarity: the archive legitimately begins Jul 17, 10:31 AM CT — that is data birth, not a bug; when the chosen 3/7/14d window reaches earlier, the slider now spans the full request and renders the pre-archive span as a hatched dead segment (scrubbing into it snaps to the first real frame; no frames are ever faked), and the first time a chosen range exceeds the archive a prominent note flashes over the bar for 3s: "Archive begins Jul 17, 10:31 AM CT: the board's first recorded frame" (EN+ES)
- [Fix] playback entry auto-behaviors: speed always resets to 0.5× on entering playback (a changed speed persists for the session only), and on phones the bottom sheet auto-collapses to minimum so the map owns the screen; the prior pane state restores on NOW/✕ (a manual resize during playback wins)
- [Fix] mobile overlap pass: the floating sheet handle hides while the playback bar is open (pane sizing is automated during playback), the LAN chat FAB lifts clear of the open bar, and the radar scrub rides higher above the taller wrapped phone bar

## v0.85.0 — 2026-07-18 (UX quick wins, part 1)

- [New] long-press point inspector (competitive ref: Windy's picker / RadarScope's inspector): touch-hold or right-click anywhere on the map (Leaflet `contextmenu` covers both gestures) runs the existing "Am I at risk?" computation at that point and shows a compact card in a popup pinned to the pressed location — overall plain-language read, worst NWS alert at the point (or an honest "no alert" line), nearest gauge with distance/category/trend (tap flies to it), nearest closed crossing and road/cutoff notice, the point's USNG string with tap-to-copy (USNG + decimal coords), a small ✕ dismiss, and the "guidance only · 911" honesty line; the popup opens with `autoPan` OFF so the map never moves under the user's finger; the hidden `?risk=1` address UI is unchanged — only the gesture entry point is new; refactor: the shared computation extracted from `runRiskCheck()` into `riskAssess()` (address modal behavior unchanged)
- [New] plain-language headline (competitive ref: Watch Duty's human-readable statements): one auto-generated sentence at the top of the threat strip built strictly from already-computed signals — worst in-flood gauge with record/trend context ("Asherton MAJOR flood cresting near record"), the soonest rising-to-major crest wave ("Devils River wave rising at Pafford Crossing"), in-AO flash flood emergency/warning counts (honest "no flash flood warnings in the AO" when zero), TxDOT closure count, and an overall receding/rising trend read; single ellipsized line on small screens, tap to expand/collapse the full sentence; recomputed on every renderTiles() pass; the v0.79 quiet-state all-clear line remains the headline's fully-quiet case (never doubled up); localized EN+ES (`headline.*`)
- [New] active-layer pills (competitive ref: Windy always names the active layer): a slim dismissible pill row over the map, under the AO quick-jump chips, naming every non-default overlay currently ON (Radar · Rain 1h/24h · Flood model · USGS stage · Report history · Crossing inventory · Cameras); tapping a pill turns that layer off, a trailing ＋ pill expands the existing Leaflet layer control; the row hides entirely when only default layers are on (zero clutter at rest), tracks programmatic enables too (deep links, auto-USGS fallback), and during playback drops below the amber ⏮ PLAYBACK badge so the two never collide; localized EN+ES (`layers.*`)

- [New] archived NWS warning polygons replay in playback: "the rolling in of nws alerts, fading of them"): IEM's storm-based-warning archive (`sbw.geojson?ts=` — official archived NWS products, CORS-open, endpoint probed live before build) is fetched for the frame time, filtered to the AO bbox and flood phenomena (FF/FA/FL; SV/TO storm warnings drawn too, with a distinct dashed style), and rendered in the live alert-poly visual language under the playback layer regime: each poly appears at its polygon_begin and vanishes at its polygon_end as the scrub moves, the live alert layer swaps out while engaged and restores on NOW/exit, and archive polys clear instantly; popups carry the product name, WFO, valid window (CT), an OFFICIAL badge, "NWS warning archive via IEM" provenance, the amber PLAYBACK timestamp, and a link to the IEM product page; responses cache by 15-min bucket (LRU of 40) with a fetch-on-settle debounce while dragging and a single-inflight guard while playing
- [New] story captions: "it needs to tell the story of the events that have transpired"): a tap-to-pause caption strip above the timeline narrates the event as the playhead crosses it — gauge category transitions diffed client-side from history.json frames ("Nueces River at Laguna rises to MAJOR flood"), moderate/major crests from crest-summary.json with crest-of-record context ("crests 31.48 ft · 95% of the 1935 record"), warning issue/expire lifecycle from the SBW cache, and road reopenings from this device's DriveTexas reopened store; events are precomputed once per range selection, merged time-sorted, and the nearest-past caption shows with a subtle entry transition; stale-sensor frames never generate transitions
- [New] speed + granularity: "slower granularity / speed"): default play slows from ~8 fps to ~2 fps, with a cycling 0.5×/1×/2×/4× speed control and ⏪/⏩ single-frame step buttons for precise scrubbing; at 0.5×–1× marker size/color tween smoothly between frames — a visual transition only, the readout always shows the real frame time and no interpolated value is ever presented as data
- [New] playback HUD: a one-line stats readout in the bar — gauges in flood by category ("MAJ 4 · MOD 2 · MIN 3"), warnings active at the frame from the archive ("⚠ 8"), and the top mover vs the previous frame ("▲ Derby +1.2 ft/hr"); tap expands top-3 movers and the active warning product list
- [New] `?pbt=<ISO time>` deep link jumps playback straight to a moment (pairs with `?playback=1`)
- [Change] the playback truth line now reads "Replaying: gauges (archive) + warnings (NWS archive via IEM) [+ radar (IEM archive)] · showing live: roads, crossings, reports" — alerts left the showing-live list because they now replay from the official archive; the device's own 7d alert-history note stays
- [New] all new strings localized EN+ES (`playback.story.*`, `playback.hud.*`, `playback.speed.title`, `playback.step.*`, `playback.warnarchive`, `playback.note.warn`)

## v0.83.0 — 2026-07-18 (road & river cameras)

- [New] `scripts/gen-cameras.py`: build-time generator (stdlib only) that writes the committed inventory `data/cameras.json` — 656 TxDOT traffic cameras in the AO from the MapLarge `appgeo/cameraPoint` table (bbox WKT query, paginated at 1000; stores name/route/description/lat/lon plus the verbatim `httpsurl` HLS playlist — stream subdomains vary per camera and are never constructed) and 9 USGS HIVIS river cameras from the NIMS inventory API filtered to the AO (camId/name/nwisId/lat/lon; includes the Blanco River at Wimberley, Fischer Store Rd, and Crabapple Rd cams plus the San Antonio River/Medina Lake/Olmos Dam cluster); output carries a `generated` stamp and per-source attribution
- [New] "Cameras: road & river (TxDOT/USGS)" map overlay, OFF by default: lazy-loads the inventory on first enable, clustered 📷 markers at low zoom (river cams get an accent ring); popups carry name/route, an OFFICIAL provenance badge, TxDOT or USGS attribution, a "one spot at one moment — verify before routing" line, and a ▶ view action
- [New] camera viewer overlay (same pattern as the hydrograph modal, one-handed dismissible via ✕ / tap-outside / Escape, video letterboxed never cropped): TxDOT cams play the live HLS stream — native `<video>` where supported (Safari), else the newly vendored `js/vendor/hls.light.min.js` (hls.js v1.5.20 light build, committed; no runtime CDN dependency) — with a red LIVE badge and a "TxDOT · not recorded · may lag" line; USGS cams fetch the newest still client-side from the public HIVIS S3 bucket (keys listed with a 2-day start-after window; the untimestamped `_newest.jpg` pointer key is excluded), show the capture time parsed from the key prominently, and badge STALE when the still is >45 min old — stale imagery never looks live; closing the viewer stops and destroys the player so no stream leaks
- [New] Drive Mode: the 2 nearest cameras tail the hazard list as 📷 rows (after the reopened-road rows, never competing with hazards for slots); tapping one opens the viewer over Drive Mode
- [New] gauge popups: when a HIVIS river cam sits within 2 km of a gauge, the popup gains a "📷 river cam · ▶ view" button (Wimberley/Blanco pairing) — the camera inventory lazy-loads on first gauge popup open
- [New] `?cams=1` deep link enables the camera layer; `?cam=<camId|name>` opens the viewer directly
- [New] all new strings localized EN+ES (`cam.*` keys)

## v0.82.1 — 2026-07-18

- [Change] Gauge section headers: "Forecast to flood" and "Rising" drop the
 "pre-position ahead of these" phrasing, EN+ES; counts unchanged

## v0.82.0 — 2026-07-18 (historical playback)
- [New] `scripts/gen-history.py`: release-time generator that walks the committed history of `data/gauges-snapshot.json` (113 commits) and writes `data/history.json` — one compact frame per snapshot (thinned to at most one per 15 min: 98 frames, 196 KB, window Jul 17 15:31Z → Jul 18 22:25Z) holding observed stage + flood-category code per gauge (0=none 1=action 2=minor 3=moderate 4=major; stale observations >12h behind the snapshot are encoded as a negative code so the client badges them — catches the frozen BTVT2 sensor across all 98 frames); gauges the live board hides (out_of_service / obs_not_current / not_defined) are omitted, nothing is interpolated; per-commit parsing is skip-and-count, never fatal; a `gaugeIndex` (lid → name/lat/lon) keeps frames small; if the payload ever exceeds 600 KB, frames older than 3 days automatically thin to 30-min spacing (not needed at 196 KB)
- [New] historical playback: a collapsible bottom timeline bar over the map — collapsed to a small ⏮ pill by the map controls; expanded it offers 3d / 7d / 14d range chips (clipped to the archive, with an honest "archive starts …" note when the window predates it), a draggable time scrub, ▶/⏸ play at ~8 fps (requestAnimationFrame-throttled), a live CT timestamp readout, and a NOW button that snaps every layer back to live instantly; entry points: the ⏮ pill, "▶ Playback" in ⋯ More, and a `?playback=1` deep link; if `data/history.json` is absent (older deploy) the pill shows a "history unavailable" tooltip and playback never opens — no crash
- [New] playback scrubbing re-renders the gauge layer from archive frames using the live marker styling (same category colors/sizes, stale badging, none-dots hidden at low zoom / on phones), swapping the live gauge layer out while engaged; markers are built once per session and mutated per frame so 8 fps playback doesn't churn the DOM; gauge popups during playback carry the frame's stage/category plus an amber PLAYBACK+timestamp line
- [New] radar in playback: when the radar layer is on, scrubbing switches it to IEM's archived NEXRAD composite tiles (`ridge::USCOMP-N0Q-<YYYYMMDDHHMM>`, 5-min steps — pattern verified live) and restores the RainViewer frame on exit
- [New] honest playback framing: an amber "⏮ PLAYBACK · <time> CT" pill sits top-center over the map and the threat strip dims while a historical frame is shown; the bar's note line states exactly what is replaying (gauges; + radar when on) and what stays live (alerts, roads, crossings, reports — no archived per-frame data exists for these and none is faked); when this device's 7-day local alert history covers the frame time, the note adds "N alerts active then (this device's 7d history)"
- [New] chapter marks: up to 8 ▲ ticks on the scrub track at the major-peak crest times from `data/crest-summary.json` (tooltip "Nueces River near Asherton crest 31.48 ft"); tapping a tick jumps the scrub to that moment
- [Change] the existing radar-only scrub (-1h → +30m RainViewer) is untouched this release and briefly coexists with the playback bar (it rides above the bar when both are open); absorbing it into the timeline comes later
- [New] all new strings localized EN+ES (`playback.*` keys)

## v0.81.1 — 2026-07-18 (em-dash sweep + one-tap crest summary)
- [Change] em-dash sweep of all user-facing UI text: replaced ~150 em-dashes across the EN and ES i18n tables, hardcoded UI strings in every script (labels, tooltips, popups, badges, empty states, stale/health bars), and index.html visible text/meta with a comma, colon, semicolon, period, or the board's existing · separator — whichever reads faster at a glance; plain-text exports (SITREP, AAR markdown) now use ASCII hyphens so they survive radio/SMS/CAD paste; code comments and curated card data untouched
- [New] one-tap crest summary: a "📊 Crest summary" chip now sits in the Gauges tab controls row next to By priority / By river, opening the same after-action view as the ⋯ More menu item (which stays); localized EN+ES via the existing summary.menu strings
- [Change] header subtitle: "First Responder & Life Safety Feed" → "Life Safety & Response Feed" (ES: "Primeros respondedores y seguridad de vida" → "Seguridad de vida y respuesta")

## v0.81.0 — 2026-07-18 (official-vs-curated source tagging)
- [New] provenance badges: every ambiguous signal now carries a small OFFICIAL (blue — machine-fed from an authoritative source: NWS, NWPS, IEM, TxDOT/TDEM, TxGIO, USGS) or CURATED (amber — verified and maintained by the board operator) badge via a shared `srcBadge()` helper with hover tooltips, localized EN+ES; applied where provenance is genuinely ambiguous, not everywhere — feed notice cards (CURATED next to the source citation), curated low-water-crossing entries in the Resources list and their map popups (CURATED), TxGIO crossing-inventory popups and DriveTexas road-closure/reopened-road popups plus the reopened-roads attribution line (OFFICIAL), and the threat-strip chips driven by operator cards — critical life-safety, cut-off areas, roads blocked — get a compact CURATED badge plus provenance tooltip (gauge/alert chips stay unbadged: they are unambiguously NWS/NWPS and already labeled)
- [New] SITREP provenance suffixes: THREAT/GAUGES/RECOVERY lines are tagged (official) and CUT-OFF AREAS/ACTIVE CRITICAL/ACTIVE NOTICES TOTAL are tagged (curated), so data provenance survives copy-paste relay
- [Change] the roads-blocked threat chip is badged CURATED (not OFFICIAL): it counts operator road-notice cards from requests.json, not the DriveTexas feed — the DriveTexas layer itself carries the OFFICIAL badge in its popups

## v0.80.0 — 2026-07-18 (event crest summary — AAR part 1)
- [New] `scripts/gen-crest-summary.py`: release-time generator that walks the committed history of `data/gauges-snapshot.json` (111 snapshots, ~15-min cadence since Jul 17) and writes `data/crest-summary.json` — for every gauge that reached an observed minor/moderate/major category it records the event peak stage, the snapshot time the peak first occurred, the peak's flood category, and the first/last-seen in-flood window ("ongoing" when still in flood in the newest snapshot); per-commit parsing is wrapped so a malformed historical snapshot is skipped and counted (`skipped_commits`), never fatal; peaks whose observation was >12h older than the snapshot's generated stamp are flagged `"stale": true` rather than dropped (catches the frozen BTVT2 sensor, stuck at 22.86 since Jul 15), and `data/records.json` crests of record are cross-referenced per lid with the peak's percentage of record plus exceeded / approached (>90%) flags — Asherton ASRT2 peaked 31.43 ft MAJOR at 95.2% of the 1935 record
- [New] crest summary view in the app (`?view=summary`, same routing pattern as `?view=drive`): a full-screen after-action table — gauge name/lid, peak stage with category badge, peak time in CT, in-flood window, record comparison where present ("record 33.0 ft (1935) — reached 95.2%"), STALE badge with the existing stale styling for flagged sensors, and an "ongoing" badge for gauges still in flood; header carries the event name, generated stamp, "After-action summary — peak stages per gauge", and the NWS/NWPS source citation; the same 911 disclaimer strip as Drive Mode closes the view; opened from a "📊 Crest summary" item in the feed's existing ⋯ More menu (no new prime-real-estate chrome); if `data/crest-summary.json` is absent (older deploy) the view shows a quiet "not yet generated" line instead of crashing; all new strings localized EN+ES

## v0.79.0 — 2026-07-18 (recovery posture, part 1: reopened-roads signal + quiet-state all-clear)
- [New] recently-reopened roads: the board now remembers every closure the live TDEM DriveTexas feed has shown (persisted in localStorage under `respondertx.roads.v1` — stable id hashed from route+condition+from/to limits so a description edit never reads as a reopening, plus route, condition, last-seen time, and a representative line vertex) and, when a previously-seen closure disappears from a NON-EMPTY successful road fetch (never on a fetch failure or an empty response), marks it REOPENED at that moment; reopened roads surface three ways — green ✓ circle markers on the existing road-closures map layer (popup: route, what it was, when it cleared, DriveTexas attribution + "verify before routing"), a "✓ Recently reopened roads (DriveTexas)" section beside the crossings list in Resources (green-flagged entries, click to fly the map there), and low-priority ✓ rows at the bottom of Drive Mode's nearest-hazard list so drivers see cleared routes without them outranking live hazards
- [New] reopened entries follow the board's aging invariant: after 12h (`CONFIG.reopenedAgeHours`) they age out of the default view into a "▸ show N reopened" toggle (suppressed, not deleted), and localStorage entries older than 7 days are pruned on each update (same `histDays` window as expired alerts); a closure that reappears in the feed immediately clears its reopened status
- [New] quiet-state posture: when the AO has zero active signals — no open in-AO NWS flood alerts, no gauges at minor+ observed flood category (same stale-gated `gaugeCat` predicate the threat chips use), and no active DriveTexas road closures — the threat strip now renders a calm green all-clear line ("✓ No active flood threat in the AO — monitoring N gauges · M normal", live counts, EN+ES) instead of reading empty/dead; it requires the gauge and road feeds to have actually loaded, never renders while any threat chip is up, and disappears the moment any real signal returns; the existing life-safety-ok line still covers the in-between state (no life-safety chips but alerts/closures/action-stage gauges still active)

## v0.78.0 — 2026-07-18 (maintenance: module split, no behavior change)
- [Change] split the js/app.js monolith (~3,200 lines) into six classic scripts loaded in order — js/core.js (config, state, utils, aging helpers), js/map.js (theme, offline tiles, map init, radar), js/sources.js (NWS/NWPS/RFC/USGS/DriveTexas/TxGIO/IEM fetch+render), js/panels.js (forecast, wave, Drive Mode, gauges tab, resources, threat strip, ticker, tiles, crossings), js/board.js (store, requests, geocode, intake, risk check, import/export, SITREP, share view), js/boot.js (cache, refresh orchestrator, health, boot); pure line-for-line move with zero logic edits — APP_VERSION now lives in js/core.js and scripts/deploy.sh + scripts/cycle-check.sh read it from there

## v0.77.0 — 2026-07-18 (bug-fix release: audit findings — refresh integrity, popup URL gating, server hardening)
- Fix: the seed-refresh change detector hashed only requests+resources, so a crossings.json status flip never repainted the crossings layer/list on open clients, and byte-identical seeds meant time-based aging (aged suppression, stale — re-verify badges, fresh-dot buckets) froze on idle clients while the KPI tiles kept recomputing — list and tiles diverged; the hash now folds in the crossings payload plus a per-card aging fingerprint (aged / stale / coarse age-bucket) and a per-crossing stale flag, so the list re-renders exactly when content or any card's aging presentation changes — and still does NOT re-render (or reset the operator's scroll) on refreshes where nothing visible changed
- Fix: map-popup source links (request markers, crossing list + crossing popups) rendered `href` with only HTML-escaping — a `javascript:` URL arriving via the JSON import flow became a click-to-execute link; all three now gate through the same `safeUrl()` http(s)-only check the feed cards already used, omitting the link when the URL is rejected
- Fix: concurrent `refresh()` runs were unguarded (3-min interval + refresh-now + visibility catch-up could overlap and race); an in-flight guard now queues at most one trailing refresh and runs it when the current cycle finishes, so the visibility catch-up is never dropped
- Fix: server.py POST endpoints (/api/chat, /api/notes) accepted cross-origin simple requests, letting any LAN page (or a malicious site via the operator's browser) forge messages into the ops chat inbox; POSTs now require `Content-Type: application/json` (415 otherwise) and any present `Origin` header must match the request `Host` (403 otherwise); the static GET handler also 404s repo internals and agent inboxes (/.git, /.rdf, /.claude, /HANDOFF.md, chat/notes inbox files) that SimpleHTTPRequestHandler was serving to the whole LAN
- Fix: one null-geometry GeoJSON feature killed the whole source for the cycle in four spots (RFC forecast-max filter, LSR render, LSR history recorder, ticker LSR items) — all four now skip features without a coordinates array, matching the guards the road/LWC layers already had
- Fix: a transient crossings.json fetch failure wiped the crossings board state to empty for the cycle; the last-good crossings list is now kept until a successful fetch replaces it
- Fix: alerts with a missing/null `expires` were dropped from the map (`new Date(null)` = 1970 = always expired); missing expires now counts as still-active — only an expires that is present AND past filters the polygon
- Fix: importing a JSON file that referenced an archived request id threw a TypeError (`cur` looked up without archived entries) and aborted the whole import; the lookup now includes archived requests like the duplicate check does
- Fix: the data-age warning bar rebuilt its innerHTML every second from the countdown tick; it now caches the rendered signature and only touches the DOM when the text/severity actually changes
- Change: the ~3.7k TxGIO low-water-crossing markers built their popup HTML eagerly at layer build; popups are now bound lazily (built on first open, matching the gauge-popup pattern)
- Change: the Leaflet attribution footer was crowding the bottom-left legend and eating scarce space on short/landscape phones, so it now collapses to a small tap-to-open ⓘ pill instead of a full-width bar; tapping ⓘ expands the complete credits (OpenStreetMap, CARTO, Leaflet, and the TxDOT DriveTexas / TDEM road-data citation) and tapping again collapses it — the credits are preserved (map-provider ToS + our source-citation invariant both require them) but no longer sit persistently over the map; attribution links still open normally when expanded

## v0.76.4 — 2026-07-18 (fix: expanded map legend clipped on short screens)
- Fix: on landscape phones (and when the bottom sheet is expanded) the map legend's expanded state was taller than the short map and got clipped at both ends — the "River gauge status" title above the top and the lower rows below — a regression surfaced by the v0.76.1 Roads section making the legend taller; the open legend now caps at `calc(100dvh - 120px)` with `overflow-y:auto` (+`overscroll-behavior:contain`) so it scrolls from the title down instead of clipping, and `L.DomEvent.disableScrollPropagation` keeps that scroll from zooming the map; portrait and desktop are unchanged (the cap only bites on short viewports)

## v0.76.3 — 2026-07-18 (Drive Mode uses the live road-closure data)
- New: Drive Mode's big-type nearest-hazard glance list now includes the live TDEM DriveTexas road closures/flooding/damage alongside the existing closed/caution crossings, life-safety/road notices, and major/rising gauges — each closure is ranked by distance using the line vertex NEAREST the driver (midpoint when no GPS), shown with a condition glyph (⛔ closed · 🌊 flooded · ⚠ damage), the prettified route (`FM0481`→`FM 481`), and the condition label; ranked below closed crossings and critical incidents so hard stops still lead the list; the 14-item cap and distance sort keep the ~100-closure AO volume manageable

## v0.76.2 — 2026-07-18 (road layer: exclude construction-driven closures)
- Change: the live TDEM DriveTexas road-hazard query now also excludes construction-driven closures that TxDOT codes as `Closure`/`Damage` rather than `Construction` — the board is flood-relevant only); added `AND (description IS NULL OR UPPER(description) NOT LIKE '%CONSTRUCTION%')` to the server-side `where` so "roadway closed due to construction" bridge/lane closures no longer render as red closure lines (dropped 4 of 102 AO records this cycle); null-safe so a closure with no description text is still shown rather than hidden

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

## v0.75.7 — 2026-07-18
- Change: the Feed tab's "＋ New notice" intake button is now hidden by default — the code and the intake form stay fully intact, revealed by the `?intake=1` deep link (same gating pattern as "Am I at risk?" ?risk=1 and Field Notes ?notes=1); the button carries a static `hidden` attribute so it never flashes on boot, and a `?intake=1` check un-hides it

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

## v0.75.3 — 2026-07-18
- Change: condensed the Feed tab's `.feed-actions` button strip on phones (≤768px) — buttons drop from the shared 42px min-height to 34px with tighter padding/font (11.5px) and the row gap/margin shrink, so the "＋ New notice · 📋 SITREP · ☰ Filters · 🔍 ID · ⋯ More" strip (and the Export/Import `#more-menu` row) is noticeably shorter and reclaims vertical list space; buttons keep their icons + labels and stay tappable, desktop layout untouched
- Change: mid/default bottom-sheet now cheats a 60/40 map-favoring split — `main.sheet-half #sidebar` height cut from 54vh to 37vh so the map takes ~60% of the map+panel area in the default state and the feed panel ~40% (measured 500x900: map 494px / panel 333px ≈ 59.7/40.3, header chrome sits outside the split); the peek/full states, the floating ▲/↕/▼ sheet-handle cycle, and the anchored 911 disclaimer footer are unchanged

## v0.75.2 — 2026-07-18 (extend gauge coverage west to the Pecos / Val Verde)
- Change: extended the gauge/AO bounding box west from -101.2 to -102.0 so the active Pecos River flood wave (Pandale Crossing PDAT2, Langtry LTRT2) now renders as live gauge dots with hydrographs — the life-threatening NW Val Verde flooding under an active NWS FFW sat just outside the prior coverage edge; the wider box also lets the Val Verde alert register as in-AO (alertInAO reads CONFIG.gaugeBbox)
- NEW "Val Verde/Pecos" AO quick-jump chip (map top-edge presets) framing the active flood reach (Pandale → NW Val Verde); the "Full AO" quick-jump was widened to the new -102.0 west edge to match, and the public snapshot fallback was regenerated with the wider bbox (226 gauges, now including PDAT2/LTRT2/BTNT2/SPCT2)

## v0.75.1 — 2026-07-18
- Change: brand subtitle shortened from "Hill Country flood event · live NWS / NOAA / USGS · community assistance feed" to "First Responder & Life Safety Feed" — the old copy was long and named a single TX/Hill-Country event; the board is being built to manage multiple AOs and separate statewide events over time, so the header subtitle no longer pins to one event (localized EN/ES, the Spanish reads "Primeros respondedores y seguridad de vida"); all local asset ?v= stamps bumped to 0.75.1 with the version

## v0.75.0 — 2026-07-18 (table-stakes T4: Spanish localization (EN/ES) + a11y)
- NEW EN/ES language toggle (🌐 header control, next to the theme toggle; icon-only on phones like the other controls) — the flood-affected Hill Country / South TX population is heavily Hispanic and the public mirror was English-only; the app UI chrome now renders in Spanish or English, choice persisted in localStorage (respondertx.lang), defaulting to the browser language when it is es-* and accepting a ?lang=es deep link; document.documentElement.lang is set to the active locale and aria-labels/titles localize with it
- Locale table lives in a new js/i18n.js (a flat EN/ES string map keyed by short ids, a t(key) helper, and an applyI18n() that drives data-i18n / -html / -title / -aria / -ph attributes) — static index.html strings apply once on boot and the app's own render paths call t() so a live toggle re-localizes the board without a reload
- Localized: header/brand subtitle, KPI tiles, control buttons, the five tab names, the whole threat-to-life module (headline + every chip: critical life-safety, cut-off areas, MAJOR gauges, rising to major, near crest of record, roads blocked, falling/recovery, next crest), the safety modal, the always-visible 911 disclaimer (short + full), Drive Mode (title/controls/threat header/empty state), the "Am I at risk?" modal and its honesty box, Resources/Follow + Social + crossings section headings, map legends, and key empty-states
- SAFETY COPY uses standard NWS/FEMA Spanish register, not literal word-for-word: "Emergencia potencialmente mortal → llame al 911", "NO es un sistema de despacho", "NO SE AUTODESPLIEGUE en zonas inundadas o bajo advertencia", "Dé la vuelta, no se ahogue" (the NWS-standard Turn-Around-Don't-Drown slogan, used exactly), "Solo orientación — no es una determinación oficial de inundación"; "911" stays 911
- Live NWS/NOAA/USGS data is never translated — gauge names, alert event/areaDesc text, forecast values, timestamps, and curated card text stay in the English the feeds provide; only the app's own UI chrome localizes (the data-dense feed intake form, exports, gauge/alert cards, and ticker deliberately stay English)
- Change: "Am I at risk?" hidden by default (still at ?risk=1) — this is primarily a first-responder + public-information tool, not a consumer address-risk lookup; the button is removed from the default header (same gating pattern as Field Notes' ?notes=1) with all code and the modal kept intact, revealed and auto-opened by the ?risk=1 deep link

## v0.74.0 — 2026-07-18 (table-stakes T2: "Am I at risk?" address lookup + saved my-places)
- NEW "🏠 Am I at risk?" address flood-risk check (header control, next to Share/Drive): type any address or place → it geocodes with the board's existing Nominatim geocoder and produces a risk-glance card for that exact point, then flies the map there and drops a distinct "YOUR PLACE" marker — the address-first entry point every leading flood app (Watch Duty, Google Flood Hub, Genasys) has and this board lacked (the only prior address entry was buried in the curator intake form)
- The card reads ONLY live board state near the point — nothing invented: nearest river gauges within 15 mi (name, current stage + flood category, forecast crest + timing, observed trend, distance; tap a gauge to open its hydrograph), any active NWS flood alert whose polygon/zone bbox contains or is near the point, the nearest closed/caution low-water crossing and nearest road/cut-off notice within a few miles, plus one derived overall-read line ("Nearest gauge X is MODERATE and forecast to reach MAJOR at …; nearest closed crossing 2.1 mi") — all from the same state.gauges/alerts/crossings + gaugeCat/gaugeForecastCat/gaugeTrend/distMi helpers the rest of the board uses
- SAVE MY-PLACES: a one-tap Save stores {label, lat, lon} in localStorage (respondertx.places); saved places render as chips for one-tap re-check and persist across reloads — pure client-side, no backend, no account, no identity
- Honesty + no-PII by design: framed as "Guidance only — not a flood determination. Life-threatening emergency: call 911", it never says "you are safe", and when no gauge or alert is near the point it says so explicitly ("does not mean no risk — verify locally"); cites NWS/NOAA/USGS and points to the NWM inundation layer for modeled extent; the typed address is used only on-device to place the pin and is never logged or transmitted — the single Nominatim geocode is the only call that leaves the browser (the existing geocoder was refactored into a shared nominatimSearch() so both the intake form and the risk check reuse one code path)
## v0.73.0 — 2026-07-18 (table-stakes T1: street-level flood inundation layer)
- NEW "Flood inundation — NWM model (est.)" map overlay (layer control, OFF by default — hazard layers are explicit-enable): NOAA/NWPS National Water Model Analysis-and-Assimilation inundation extent — the street-level "which roads/blocks go under" picture that gauge numbers alone can't show; renders as a translucent blue extent hugging the river channels once you zoom to street level (the source only draws below ~1:400k, i.e. z≈11+)
- Source: maps.water.noaa.gov nwm/ana_inundation_extent MapServer (layer 0), consumed as ArcGIS dynamic-export tiles (per-tile Web-Mercator bbox) in core Leaflet — no esri-leaflet dependency; it's live model DATA so it's deliberately kept out of the offline-tile cache, and it cache-busts hourly to match the service's hourly update
- Honesty guard: the layer name, a dedicated on-map legend, and the map attribution all state this is a MODELED estimate from the NWM analysis (experimental) — NOT observed conditions — cite NOAA/NWPS, and note the hourly update; the data-age framing is unchanged (this layer is live and refreshes with the cycle, stale ≠ live)
## v0.72.0 — 2026-07-18
- The Min/Half/Full resize control no longer takes a horizontal strip at the top of the panel — it's now a small floating vertical pill (▲ full / ↕ half / ▼ min) in the bottom-right, above the chat button, consuming zero panel space and visible in every state
- Because the control floats, Minimize now collapses the panel to nothing — a true full-screen map; the threat module + tabs reclaim the space the old strip used
## v0.71.0 — 2026-07-18 (reassessment A6: collapsible map legend)
- The map legend now collapses to a small "River gauge status ▸" pill on desktop too (was mobile-only) — it was permanently covering the Eagle Pass/Del Rio marker cluster, i.e. the most active corner of the map; click the pill to expand the full key, click again to collapse
## v0.70.0 — 2026-07-18
- Fix: the Min/Half/Full buttons were oversized and eating screen space — now a small centered pill that barely uses any room
- Fix: the sheet was hijacking the 911 footer and version tag — root cause was a stale CSS rule pinning the map at 42vh, so the Full sheet overflowed the viewport and shoved the footer off-screen. The map now flexibly fills whatever the sheet leaves, so the 911 line + version tag sit correctly at the bottom in Half and Full, and the three sizes all resize cleanly
## v0.69.0 — 2026-07-18 (reassessment quick-wins: AO-first alerts + discoverable Drive Mode)
- Alerts tab now leads with Hill Country AO alerts and folds the rest into "N flood alerts elsewhere in TX" — a Big Bend / far-West-TX warning can no longer sort above your area just for being newer (alerts are fetched statewide; this ranks by relevance, geometry-vs-AO-bbox)
- Drive Mode is now discoverable: its 🚗 control gets a distinct teal accent, and a one-time dismissible hint points to it on first visit — the field's best view no longer hides behind an unlabeled icon
## v0.68.0 — 2026-07-18
- Fix: from the fully-collapsed panel the old grabber was hard to find/expand. The bottom sheet now has an explicit always-visible "▼ Min / ↕ Half / ▲ Full" segmented control — each button jumps straight to that size, so it's never ambiguous and always easy to bring the panel back
- Min collapses to just the ~48px control bar (map full-screen), Half is the split, Full covers the map; the active size is highlighted and remembered; map re-tiles after each change
## v0.67.0 — 2026-07-17
- On phones the feed/alerts/threat panel is now a bottom sheet with a grabber handle: tap to cycle PEEK (collapsed to the bottom, map ~full-screen) → HALF (the old split) → FULL (slides up to cover the map for a full-screen scroll of alerts/feed) — state persists, and the map re-tiles after each resize
- ?sheet=peek|half|full deep link opens straight to a panel size; tapping a tab from peek auto-expands to half so you see the content; desktop layout unchanged
## v0.66.0 — 2026-07-17
- Phone header is no longer crowded: the Refresh / Share / Drive / theme controls become icon-only (⟳ 🔗 🚗 ☀️) on phones so they fit one uncramped row with real tap targets (36px) — labels stay on desktop; aria-labels keep them accessible
- The "next in Xs" refresh countdown is hidden on phones (the "updated H:MM" time is enough) and the meta is tightened, giving the "Responder TX" name room to breathe
## v0.65.0 — 2026-07-17
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
## v0.56.0 — 2026-07-17: persist view settings across refresh)
- Your view now survives hard refreshes and app updates: feed filters (type/county/sort/time window/distance/search), the aged toggle, alert filters (severity/text), and the active tab are saved to the browser and restored on next load — no more re-setting filters after every deploy-triggered reload
- Precedence preserved: a shared/deep-link URL (?tab=, ?ft=, ?theme=, etc.) still wins for that load; theme, basemap, and filters-panel open-state already persisted and continue to
## v0.55.0 — 2026-07-17 (product vet pass: radio-ID share-link + wobble fixes)
- Fix (field bug): a shared/deep radio-ID link (?fq=R-031) now flies the map to the card and opens its popup on load — previously the fly-to fired before seeds loaded and left the map statewide; re-applied after the board data lands
- Fix: typing a multi-digit radio ID no longer wobbles the map through intermediate matches (R-03 → R-003) — fly-to now requires the complete 3-character code
- Verified (full adversarial UAT this cycle): threat module, safety modal, snapshot discipline, cached hydrographs (LAN + edge), Share View, radio IDs, hidden Notes, typed-coord intake, GPS chip, light-theme contrast, MRMS legend, and public-mirror chat-hygiene all pass; seed-013 empty source URL confirmed a correctly-exempt field card, not a defect
## v0.54.0 — 2026-07-17
- Radio-ID search: the Feed search now matches short IDs, and typing an exact ID ("R-031", "r031") flies the map to that card and opens its popup — phones scroll the map into view; new 🔍 ID button opens search pre-focused for gloved one-tap entry
- Field Notes hidden for now: the 📍 Notes button and flyout no longer load by default — ?notes=1 / ?note= deep links still work for testing, server /api/notes stays live, nothing deleted
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
## v0.48.0 — 2026-07-17: stupidly-simple Share View)
- NEW 🔗 Share button in the header (next to Refresh): one tap builds a link that reproduces the current view exactly — map center/zoom, active tab, Feed filters (type/county/sort/time window/distance/search), Alerts filters (severity/text), basemap, and theme — then copies it ("✓ Link copied") or hands it to the phone's native share sheet (navigator.share) when available
- Short param scheme (mlat/mlon/mz · tab · ft/fc/fs/fw/fd/fq · as/aq) rides the existing ?tab=/?base=/?theme= deep-link vocabulary; URL wins over saved basemap/theme for that load only; existing deep links (?chat=1, ?note=, ?notes=1, ?rf=, ?radar=, ?rain=) untouched
- On open, restored filters apply through the same handlers a user change would fire (so every list re-renders live) and the Filters panel auto-opens so a shared filtered view is visible, not silent; notes state intentionally excluded from share links for now
- Links are built from the page's own origin — the same button works on the LAN board and the public mirror
## v0.47.0 — 2026-07-17: our-side gauge hydrograph caching)
- Gauge graphs now load through our own cached proxy instead of hitting NOAA per viewer: same-origin /api/gauge/<lid>/<detail|series> served by a Cloudflare Pages Function on the public mirror (edge-cached 3 min, cache-API + s-maxage) and by server.py on the LAN board (in-memory 3-min cache — 269ms cold → <1ms warm measured); browser falls back to direct NOAA automatically if the proxy is unavailable
- cachedJson now rejects on non-OK responses instead of parsing error pages — fallback chains fire correctly
## v0.46.0 — 2026-07-17s: calmer fallback warnings + one-time safety modal)
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
- Mobile: threat module collapses to 1-2 dense horizontally-scrollable rows (header hidden, chips compact) — reclaims roughly a third of the sidebar for tabs + feed per
- Tabs modernized: never wrap (fixes desktop "Gauges/21" badge breaking to a second line) — nowrap buttons with inline-centered count badges, hidden-scrollbar horizontal overflow on narrow widths, smooth active-underline transition; red sev badge on Alerts preserved
- Rename: app is now just "Responder TX" (header h1, page title, manifest, event config); subtitle carries the Hill Country flood context
- Header slimmed: tighter padding, smaller KPI tiles, compact Refresh/Light controls — buys back vertical space, especially on phones (all click-through and update-chip behavior intact)
- Gauge popup hydrograph now served from a 3-min TTL cache: closing and reopening a gauge redraws instantly instead of refetching; in-flight requests are shared and failures evict so retries still work
## v0.43.0 — 2026-07-17 (nav/UX package — the researched reorg lands)
- Top-left corner is one organized unit: zoom + locate merged into a single 3-button control bar (was two disconnected stacked boxes); 42px touch targets on phones
- AO quick-jump chips along the map top edge: Full AO, Kerr/Guadalupe, Uvalde/Frio-Nueces, Sonora/Ozona, Cibolo corridor — one tap fits the map; collapses behind a 🗺 toggle on phones
- KPI tiles are now actionable: tap emergencies/warnings → Alerts, gauges → Gauges tab, notices → Feed (keyboard-accessible, hover affordance)
- Mobile: the collapsed 911 disclaimer now anchors flush at the viewport bottom (root cause: missing flex min-height let long feeds shove it off-screen); chat FAB clearance verified
- Patterns per the Watch Duty / CalTopo / PulsePoint research; deferred by design: bottom tab bar (M), ticker discrete mode
## v0.42.0 — 2026-07-17 (11:23 cycle: stale-tab update chip + ticker pacing)
- Long-lived tabs now learn about new builds: each 3-min refresh compares the deployed changelog version against the running APP_VERSION and shows a pulsing "⬆ Updated — tap to reload" chip on divergence (never auto-reloads mid-use) — closes the cache-skew story where a long-lived tab sat on v0.39 through three deploys
- Ticker slowed ~30% (40s → 58s loop) for readability
- Data: Ozona/Crockett emergency extended again to 2:15 PM confirmed in feed; Junction (Llano) 29.21 ft rising on 31.3 major forecast — card current; snapshot refreshed
## v0.41.0 — 2026-07-17 (Gauges tab + ticker + fresh-load honesty fix)
- NEW Gauges tab (agent-built, merged): monitored gauges bucketed by actionability — ▲ RISING (soonest crest first) → ● IN FLOOD NOW → ▼ FALLING, normal gauges collapsed; "By priority / By river" grouping (NWPS carries no county field); cards show obs+category, trend ft/hr, forecast crest with timing, NWPS link; tap flies the map and opens the gauge popup; red tab badge on majors
- NEW actionable ticker under the header: recency-biased marquee of FF-emergency countdowns, rising-to-flood crests (category-colored), MAJOR holds, fresh storm reports, newest critical notice; pauses on touch, honors reduced-motion, every segment tap-navigates; becomes the phone's glance surface
- Fix: fresh loads flashed "GAUGE DATA NEVER LOADED" — snapshot now hydrates immediately at boot (live fetch overwrites), snapshot state clears on live recovery, and the staleness bar gets a 25s boot grace
- Data: Ozona/Crockett emergency EXTENDED to 2:15 PM; NEW critical cards — Frio at Concan crested MAJOR (~15.4 ft, Garner corridor) and Llano near Junction rising to MAJOR (~31.3 ft ~noon); westward round now flooding the Frio/Llano
## v0.40.0 — 2026-07-17 (radar suppression fix)
- Fix: radar frames were painted OVER by the Streets base — the layers control auto-assigns base z-indexes (Streets=3) while late-created radar frame layers defaulted to z-index 1 in the same pane; dark base only worked by DOM-order luck. Radar now renders in a dedicated pane (z-350: above every base, below alert polys and boosted labels); crossfade opacity 0.75; color schemes tested and proven pixel-identical (kept 2); ?rf=N scrub deep-link; frame advance verified by pixel diff
- Fix: "next crest" chip no longer shows crests already past
- Live during verification: NWPS throttled again and the full fallback chain performed — snapshot bar + auto-enabled USGS clusters
## v0.39.0 — 2026-07-17
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
- All radar/rainfall layers now OFF by default — explicit enable via layer control ("Radar scrub (-1h → +30m)", MRMS 1h/24h)
- Location beacon: locate-me now drops an unmissable double-ping ring + core dot + "YOU" tag (was a subtle 14px dot), zooms to 12, sits above all markers
- Cache stamps bumped to ?v=0.35.0
## v0.34.0 — 2026-07-17 (cache-skew fix + parallel-agent data layers)
- Fix: public mirror "no data" — stale edge-cached app.js (max-age 3600) paired with newer HTML crashed boot on removed elements; all local asset URLs now carry ?v=VERSION stamps (atomic HTML↔asset pairing) and `_headers` forces no-store on /data/* and no-cache on the shell
- NEW (agent-built branch, merged): RFC forecast-crest layer — hollow rings in category colors for gauges carrying a 5-day max forecast NWPS lacks (on by default); USGS raw-stage layer — 224 in-bbox instantaneous-value sites, clustered (vendored Leaflet.markercluster v1.5.3, MIT), off by default, no fake flood categories on raw stage
- Data: Sonora FF emergency EXTENDED to 1:15 PM CT (new emergency-worded FFW 10:06 AM); Ozona active through 11:45 AM — 3 emergency-worded warnings live
- 404.html added (kills Pages SPA fallback — removed paths now truly 404); master-roadmap draft assembled by planning agent
## v0.33.0 — 2026-07-17 (reframe: notices, not requests)
- Requests reframed as alerts/notices: no manual status management — no "status →" cycling, no archive chore, no status filter/intake field; curator (the ops session) resolves via data updates and resolved cards auto-suppress to the aged/history layer immediately; everything else ages out on the 24h timeout as before
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
- UX declutter: feed shrinks 8 buttons → 4 (＋ New request, SITREP, ☰ Filters, ⋯ More); filters collapse behind a badge-counting toggle (persisted); exports/import/archive fold into More; mobile legend collapses to a tap-to-expand pill freeing ~1/3 of the phone map; first card now above the fold on phones
- Card→marker linkage: tapping a card pans AND opens the marker popup
- Honest-zero fix: gauges tile shows "– no data" instead of a confident 0 when NWPS hasn't loaded (caught live during an NWPS 429 rate-limit window) — a missing MAJOR must never look like "no flooding"
- Emergency banner now auto-dismisses when its alert expires (aging invariant applied to the banner)
- Cadence doubled to 30-min cycles (:23/:53); three deep agents dispatched (UX audit, OSS mining, data-source integration specs)
## v0.27.0 — 2026-07-17 (mid-morning cycle)
- Rainfall accumulation layers: MRMS 1h + 24h QPE tiles (IEM, CORS-open) in the layer control, off by default, 5-min cache-busted with radar; `?rain=1h|24h` deep link — "how much fell where" flags the next crossings to go under (first Post-research backlog item shipped)
- NEW Falls City card (seed-033): crest REVISED to 25.2 ft MAJOR tonight ~10 PM — below the 26.3 record but ~24h earlier than prior messaging; prep this evening
- Data refresh: Sutherland Springs easing (34.5, back under major) but NWS forecasts a secondary bump to ~35.5 this morning — hold the area; Asherton record watch holds (obs 23.59, fcst 25.8 Sat AM vs 25.7/1991 record); agricultural-emergency card upgraded with hundreds of livestock reported lost along Pedernales/Cibolo/Frio/Nueces (KSAT); downstream watch list carded (Crystal City/Asherton/Cotulla, Derby/Fowlerton/Choke Canyon, Spring Branch, Stockdale/Falls City/Kenedy); 2,000+ responders, 230+ rescues statewide (Tribune)
- Health: all APIs green (NWPS 220 gauges, MRMS tiles verified); Sonora FF emergency active to 10:15 AM; renders read at 1600px + 500px; 2 cards aged out (visible via aged toggle)
## v0.26.0 — 2026-07-17
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
