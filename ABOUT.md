# About ResponderTX

ResponderTX is a live, zero-backend flood operating picture for Texas. It fuses
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
  flood category), NWS flash-flood alerts, a unified observed-to-forecast radar
  timeline, road and low-water-crossing status, a statewide camera fleet, and a
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
- **Every card cites its source.** Authoritative (federal/state API), curated
  (human-triaged with a source link), or field (direct report), and the provenance is
  always visible.
- **Manual triage is a feature, not a gap.** In prior events, false or stale rescue
  posts recirculated for days. A human verification gate is deliberate.

## Data provenance

Live hazard layers are keyless, CORS-open public endpoints, fetched directly by
your browser: the National Weather Service, NOAA's National Water Prediction
Service and River Forecast Centers, the National Hurricane Center and CO-OPS Tides
&amp; Currents, the U.S. Geological Survey, the Iowa Environmental Mesonet (Iowa State
University), RainViewer, TxDOT DriveTexas, the Texas Geographic Information Office,
ATX Floods, OpenStreetMap/Nominatim, and CARTO basemaps. Camera stills come from
city, county, port, border and state networks and are relayed through a same-origin
proxy, because that imagery is not CORS-open; each camera names its operator, and
no camera imagery is recorded. See the
[data-source table](README.md#data-sources) for hosts and citations.

Curated content (assistance requests, shelters and hotlines, and known crossings)
is edited by hand, cites its source, and is committed to the repository like code,
so its full history is auditable.

## Privacy

- **No accounts.** Nothing to sign up for.
- **No analytics, no third-party trackers, no advertising cookies.**
- **Your data stays local.** Theme, language, last-seen markers, and cached
  last-good data live in your browser (`localStorage` / `IndexedDB`) and are never
  transmitted.
- **Read-only public mirror.** The public site has no chat and no board-data write
  routes; the LAN-only operator chat is stripped from the deploy and verified each
  release.
- **The two opt-in exceptions, stated plainly.** Joining a team (`?team=`)
  publishes your handle, position and breadcrumb trail to the team relay so your
  team can see you. Enabling device alerts stores the push subscription your
  browser mints, your alert preferences, and your language. Both live in expiring
  Cloudflare storage, carry no name, email, account or retained IP, are never
  written to the git archive, and stop the moment you leave the team or turn
  alerts off.
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
