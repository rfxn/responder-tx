# Responder TX — Flood Ops Board

Live web ops board for the July 2026 Texas Hill Country flood, built for a
responder/SAR lens: a fused threat-to-life picture, live federal hazard
layers, ground-truth storm reports, radar, and a human-triaged community
assistance feed. Zero backend — any static host.

Docs: `STRATEGY.md` (social-signal & ops strategy) · `ROADMAP.md` (product
assessment + release plan) · `CHANGELOG.md` (release history).

## Run

```bash
cd /root/admin/work/proj/responder
python3 -m http.server 8080          # LAN: binds 0.0.0.0
# open http://<host>:8080  (deep links: ?tab=alerts, ?theme=light)
```

Runtime needs internet (Leaflet CDN, CARTO basemaps, federal APIs, IEM).
Installable to a phone home screen via the PWA manifest (full offline
support needs HTTPS — see ROADMAP).

## Live layers (all keyless, CORS-open, 3-min poll)

| Layer | Source |
|---|---|
| Flood alerts + FF-emergency detection | `api.weather.gov/alerts/active` |
| River gauges: observed + **forecast** flood category, ▲ rising markers | `api.water.noaa.gov/nwps/v1/gauges` |
| 48h stage sparkline vs flood stages (on gauge tap) | NWPS `stageflow/observed` |
| Ground truth — Local Storm Reports (spotter/official, road mentions highlighted) | IEM `lsr.geojson` |
| NEXRAD composite radar (5-min refresh) | IEM tile cache |

## Field workflow

- **THREAT TO LIFE strip** (top of sidebar): live fused counts — FF
  emergencies, critical life-safety requests, cut-off areas, MAJOR gauges,
  rising-to-major, roads blocked. Tap a chip to focus it.
- **Requests tab**: smart sort (urgency × freshness) with freshness dots,
  stale re-verify flags, NEW-since-last-visit chips; filters for
  type/status/county/age/distance-from-me/text; per-card navigate +
  copy-coords; ⌖ locate-me control.
- **Intake**: tap map to pin; `road` (🚧) and `cutoff` (⛔ + pulsing
  estimated isolation radius) types carry SAR iconography.
- **Alerts tab**: Forecast-to-flood pre-positioning list (soonest crest
  first), storm reports, filterable NWS alert list.
- **Monitor tab**: per-county X/Facebook/Nextdoor live-search deep links +
  **Comms**: Broadcastify scanner feeds for all 9 affected counties,
  CrowdSource Rescue, OpenMHz, Zello nets.
- **Handoff/interop**: Export JSON (operator merge by id, newest status
  wins) and **Export GeoJSON** (drops into CalTopo/SARTopo).
- Degraded connectivity: last-good data cached, shown with an "as of" stamp.

## What's curated vs live

`data/requests.json` (source-cited assistance requests) and
`data/resources.json` (shelters, hotlines, monitor/comms links) are curated
seeds — update as the event evolves. Everything in the table above is live.

## Configuration

Per-event settings live in `data/event.json` (name, subtitle, map
center/zoom, gauge bbox) — swap that file to re-point the board at a new
event; no code changes. Remaining knobs (poll interval, LSR window, stale
threshold) are in `CONFIG` at the top of `js/app.js`. Flood-category colors follow the NWS AHPS convention as status
colors, always paired with text labels and size-stepped markers.

## Safety

**Life-threatening emergencies go to 911.** This board is situational
awareness and volunteer coordination support; it is not a dispatch system
and is not monitored by emergency services. Do not self-deploy into warned
areas.
