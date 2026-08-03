# About ResponderTX

ResponderTX is a live, zero-backend hazard operating picture for Texas. It fuses
authoritative hazard data with a human-triaged field feed into one map that a
responder can read in under ten seconds. This page is the trust and methodology
statement behind the board.

> [!WARNING]
> **Life-threatening emergency? Call 911.** ResponderTX is situational awareness
> and volunteer-coordination support. It is **not** a dispatch system, it is
> **not** an official warning source, and it is not monitored by emergency
> services. Always verify with the National Weather Service, Wireless Emergency
> Alerts, and 911.

## Who runs it

ResponderTX is built and maintained by **Ryan MacDonald** for
**[R-fx Networks](https://www.rfxn.com)** (`proj@rfxn.com`), the same group behind
long-running open-source infrastructure tools (APF, BFD, Linux Malware Detect). It
is open source under the **GNU GPL v2**; the full source, data, and history are
public at <https://github.com/rfxn/responder-tx>.

## What it is

- A **single operating picture** that fuses river gauges (observed *and* forecast
  flood category), NWS warnings across the warned hazards from flash flood to
  tornado, tropical track and storm-surge risk, wildfire incidents and mapped
  perimeters, a unified observed-to-forecast radar timeline, road and
  low-water-crossing status, open shelters, a statewide camera fleet, and a
  curated field feed.
- **Forecast-first.** Every major crest this event appeared in the NWPS forecast
  field hours before the water arrived. The board is built to anticipate, not just
  report.
- **Zero backend.** The board itself runs from any static host and stays up when
  heavier infrastructure does not. The public mirror is a read-only copy on a CDN.
  Two opt-in extras (live team sharing and device alerts) are the only pieces with
  server-side state, and both stay dormant until someone turns them on.
- **For the field.** Drive Mode, USNG/MGRS coordinates, an "Am I at risk?" address
  check, offline app and map caching, exports to CalTopo/SARTopo, and radio-ready
  SITREPs are first-class.

## What it is NOT

- **Not a dispatch or tasking system.** It does not send help. Life-safety traffic
  is relayed to 911 / the county EOC by a human, immediately, out of band.
- **Not an official warning source.** NWS, Wireless Emergency Alerts, and local
  emergency management are authoritative. ResponderTX surfaces and contextualizes
  their data; it does not replace it.
- **Not monitored.** No one is watching the board waiting to respond to something
  you post. It is a shared picture, not a hotline.
- **Not a rumor amplifier.** Unverified social signal never auto-publishes; it goes
  through human triage first (see [STRATEGY.md](STRATEGY.md)).

## Methodology & honesty discipline

The board is *honest by construction*. These invariants are not optional:

- **Stale never masquerades as live.** Every layer has a staleness threshold. When
  an observation ages past it, the board flags and badges it, and does not quietly
  keep drawing it as current. A frozen gauge reading is shown as frozen.
- **Suppress &#8800; delete.** Aged and resolved items drop out of live counts and
  the default map, but remain retrievable in history and playback. Nothing is
  destroyed.
- **Forecast is labeled distinctly from observed.** Predicted crests and model
  (HRRR) radar are always visually and textually separated from measured data.
- **Wall-clock timestamps.** Cards are stamped from the clock at ingest, never from
  ambiguous day references in prose, a lesson learned the hard way when future-
  dated summaries slipped through.
- **Every card cites its source.** The board draws two provenance badges: **official**
  for a federal or state feed, and **curated** for a human-triaged item carrying a link
  back to where it came from. A direct field report is a curated card; there is no
  separate field badge. The provenance is always visible.
- **Manual triage is a feature, not a gap.** In prior events, false or stale rescue
  posts recirculated for days. A human verification gate is deliberate.

## Data provenance

Live hazard layers are keyless, CORS-open public endpoints, and the browser fetches
most of them directly: the National Weather Service, NOAA's National Water Prediction
Service and River Forecast Centers, the National Hurricane Center and CO-OPS Tides
&amp; Currents, the U.S. Geological Survey, the Iowa Environmental Mesonet (Iowa State
University), RainViewer, TxDOT DriveTexas, Esri ArcGIS Online (which hosts the NHC
tropical layers, the SLOSH surge tiles and DriveTexas), the Texas Geographic
Information Office, ATX Floods, OpenStreetMap with Nominatim and Overpass, and CARTO
basemaps. Three exceptions to "directly": gauge hydrographs prefer a same-origin proxy
and fall back to NOAA, FEMA National Shelter System data is collected server-side by
the publishing cycle, and so are the wildfire incidents and perimeters that come from
the Texas A&amp;M Forest Service and the National Interagency Fire Center (WFIGS).

Camera stills come from city, county, port, border, state and federal (USGS, National
Park Service) networks, a neighboring-state DOT, and private webcam operators. The
still-image networks are relayed through a same-origin proxy because that imagery is
not CORS-open; USGS HIVIS river cameras and the live HLS streams are fetched from
their own hosts. Each camera names its operator, and no camera imagery is recorded:
the proxy holds responses in an ephemeral edge cache for a minute or two and nothing
is ever written to disk or to git. See the
[data-source table](README.md#data-sources) for hosts and citations.

Curated content (assistance requests, shelters and hotlines, and known crossings)
is edited by hand, cites its source, and is committed to the repository like code,
so its full history is auditable.

## What it needs to run

The board draws every map, gauge, alert and closure in your browser, so it needs
JavaScript on and a reasonably current engine: **Chrome or Android WebView 80 or
newer, or iOS 13.4 or newer** (both released in early 2020). Below that floor the
code will not parse and nothing loads.

That is stated here because the failure is quiet: the page would otherwise show a
header, empty tabs and a blank map, which looks like a board reporting nothing
rather than a board that never started. If your browser cannot run it, the board
says so on the page and tells you not to read the empty shell behind the notice.

## Privacy

- **No accounts.** Nothing to sign up for.
- **No analytics, no third-party trackers, no advertising cookies.**
- **Your data stays local.** Theme, language, filters, last-seen markers, saved
  places, and cached last-good data live in your browser (`localStorage`;
  `IndexedDB` holds offline map tiles). Nothing leaves the browser except through
  the two opt-in relays below: alert preferences are posted to the alert registry
  when you subscribe or renew, and the team client queues GPS fixes locally to
  upload when a dead zone ends.
- **Read-only public mirror.** The public site has no chat and no board-data write
  routes. The deploy strips the LAN-only operator chat, the command oversight view,
  Field Notes, the LAN server and the ops scripts, and removes the field-report
  intake markup; every removal is asserted before upload and re-checked as a 404 on
  the origin and the CDN edge after it.
- **The two opt-in exceptions, stated plainly.** Joining a team (`?team=`) publishes
  your handle, role, status and specialty, your position with its accuracy, heading
  and speed, and your breadcrumb trail, so your team can see you. Enabling device
  alerts stores the push subscription your browser mints, your alert preferences,
  your language, and a small record of when this device was last notified. Both live
  in expiring Cloudflare storage, carry no name, email, account or retained IP, are
  never written to the git archive, and stop when you leave the team or turn alerts
  off. One carve-out: a map marker you drop is team data rather than personal data,
  so it keeps your handle and outlives your session by up to 12 hours.
- **Notifications are best effort.** They are a convenience layer over public NWS
  data and ride your browser's push service, so they can be late, throttled by your
  device, or missed entirely. They are not Wireless Emergency Alerts and they never
  replace 911 or official warnings.
- **Alert places are the one location the alert registry can hold, and only if
  you add one.** Choosing to be alerted near a place stores up to five points as
  coordinates rounded to about a kilometer, each with the radius you picked. No
  address, no label, no name, and no position captured for Drive Mode or team
  sharing is ever reused for this. Statewide coverage stores no location at all,
  and a subscription with no area chosen sends no area-wide alerts. Places are
  removable one at a time and go with the subscription when you turn alerts off.
- **PII discipline.** Curated exports strip exact addresses unless the requester
  posted them for help, carry no minors' identifying details, and drop phone
  numbers from resolved rescue cards (see [STRATEGY.md](STRATEGY.md)).

---

> Copyright (C) 2026 R-fx Networks &lt;proj@rfxn.com&gt; &#183; Ryan MacDonald &#183; Licensed under GNU GPL v2
