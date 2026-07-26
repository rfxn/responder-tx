# Internal notes

Institutional knowledge that does not belong in source comments, in the public
changelog, or in ROADMAP.md. Not published: `.gitattributes` marks this file
`export-ignore`, so it stays in git but never reaches the mirror.

## USGS WaterServices decommission (Q1 2027)

`waterservices.usgs.gov` is scheduled for decommission in the first quarter of
2027. USGS guarantees no intentional degradation before August 2026.

Verified 2026-07-26 against USGS's own documentation:

- Site banner, <https://waterservices.usgs.gov/>: "WaterServices will be
  decommissioned in early 2027. Applications will need to migrate to the APIs
  hosted at https://api.waterdata.usgs.gov."
- <https://waterdata.usgs.gov/blog/api-waterservices-decom/>: "WaterServices will
  be decommissioned in the first quarter of 2027" and "We will not begin any
  intentional degradation of these services before August 2026."

Two call sites depend on it:

- `js/core.js` `usgsIvBase`, called from `js/sources.js` `fetchUsgsIv()`
  (bbox plus `modifiedSince=PT2H`, `parameterCd=00065`).
- `scripts/gen-history.py` `USGS_IV_URL`, called from `fetch_usgs_series()`
  (10 sites per request, `startDT`/`endDT`, `parameterCd=00065`).

The replacement is `https://api.waterdata.usgs.gov/ogcapi/v0/` (OGC API Features,
GeoJSON). Verified live 2026-07-26: CORS `access-control-allow-origin: *`, 40 of
40 unauthenticated requests returned 200, no rate-limit headers observed. The
collection mapping is `latest-continuous` for the client call and `continuous`
for the history backfill. USGS documents an `api_key=` query parameter as needed
above "a few queries per hour"; nothing enforced it in testing, and a key placed
in a query parameter is not secret in a browser.

**Migration is deferred, not blocked.** Three reasons, in order of weight:

1. The response shape is a full parser rewrite in both call sites. The new API
   returns one GeoJSON feature per observation instead of grouped
   `value.timeSeries[]`, and geometry plus every property repeats on each
   observation. Measured for identical data (2 sites, 7 days, 2689 points):
   211 KB legacy against 2187 KB new, 10.4x.
2. Monitoring location names are absent from the data response. The popup title
   in `fetchUsgsIv()` would need a join against the `monitoring-locations`
   collection, which is a second request the current path does not make.
3. `api.waterdata.usgs.gov` is in neither CSP `connect-src` (`server.py` and
   `_headers`). The client-side migration needs a new CSP host in both, which is
   an owner decision. The Python generator has no CSP constraint and can migrate
   on its own schedule.

**What has to change, and when.** Revisit by mid-2026 so the work lands well
before Q1 2027 and before the August 2026 no-degradation guarantee lapses.
`scripts/gen-history.py` can move first and independently: rewrite
`fetch_usgs_series()` against `continuous`, prefix site ids with `USGS-`, replace
`startDT`/`endDT` with a `datetime=` RFC 3339 interval, and note that
`/continuous` caps at three years per query. `js/sources.js` `fetchUsgsIv()`
moves only once the CSP host is approved.

## USGS IV client layer returns HTTP 400 (bbox too large) — fixed in v0.99.49

Separate from the decommission, and the more urgent of the two. Resolved by
tiling (option 1 below); the record of the fault and the measurements is kept
because the cap is an upstream limit that will bind again on the next AO change.

`fetchUsgsIv()` passes the statewide `CONFIG.gaugeBbox` (13.25 by 10.67 degrees)
to WaterServices, which rejects it. Verified 2026-07-26, deterministic:

```
GET /nwis/iv/?format=json&parameterCd=00065&modifiedSince=PT2H
    &bBox=-106.65,25.83,-93.4,36.5
-> HTTP 400  "Bounding Box too large [13.3x10.7 degrees]. Your requested width
              must be less than or equal to 2.6 degrees at latitude 25.8 with
              requested height of 10.7 degrees."
```

The endpoint is healthy; the area cap is the sole fault.

The cap is not raw square degrees. Measured 2026-07-26 against the live service,
the exact rule is:

```
width_deg * height_deg * cos(latitude of the edge nearest the equator) <= 25
```

That is, 25 *equator-equivalent* square degrees. A degree of longitude narrows
with latitude, so the same box is cheaper the further from the equator it sits,
and the edge nearest the equator is the one that binds. The server's own 400 body
states the same rule from the other direction: for the Texas box it reports a
maximum width of 2.6 degrees at latitude 25.8, and `25 / (10.67 * cos 25.83)`
is 2.60.

Fitted against ten probes at latitudes 25.8, 29 and 45, all ten agree, including
both sides of the boundary: at latitude 29, 28.58 raw square degrees returns 200
and 28.60 returns 400 (24.997 and 25.014 equator-equivalent). The model was then
confirmed out of sample: it predicts a maximum width of 7.07 degrees for a
5-degree-tall box at latitude 45, and 7.0 returns 200 while 7.2 returns 400.

An earlier reading of "roughly 29 square degrees, varies with latitude" was an
artifact of probing at a single latitude. Do not use it; the cosine rule is exact.

Two further properties, both measured, both load-bearing for the fix:

- **bBox edges are inclusive on both sides.** A station sitting exactly on a
  shared tile boundary is returned by both adjacent tiles, so a tiled sweep must
  deduplicate by site code. Verified with site 08168000 at longitude -98.140009,
  which appears in both a box ending at that longitude and one starting there.
- **Aspect ratio is irrelevant.** Only the product matters: at latitude 29, a
  28.6 by 1 strip and a 5.72 by 5 block both fail at the same 25.01.

Introduced in v0.97.47 (`07949f0`) when the display bbox went statewide for the
TS Bertha coastal pivot. `gen-history.py` is unaffected: it queries by site list,
not bbox, and still returns 200.

This is **not** silent. `fetchUsgsIv()` throws before `markHealthy('usgs')`, and
`health.usgs` is in `REFRESH_SOURCE_KEYS`, so the board reports the feed as
degraded through the normal feed-health path. That is why it was left alone in
v0.99.48 rather than fixed in a hurry.

Three ways out were considered:

1. **Tile the request** against the legacy endpoint. No CSP change and no new
   host, at the cost of several requests per sweep. **Chosen.**
2. Use `stateCd=` instead of `bBox=`, which has no area cap. One request, but it
   hardcodes a state and works against the region/event-pack generalization the
   roadmap already carries. Rejected.
3. Migrate this call site to `latest-continuous` now. One request and it retires
   the 2027 exposure at the same time, but it needs a new CSP host, a parser
   rewrite, and a second join for station names. Deferred; WaterServices is good
   until Q1 2027 and this fix is not thrown away by taking it later.

### How the fix is built

`usgsBboxTiles()` in `js/core.js` derives the split from whatever bbox it is
given, so a re-target cannot silently outgrow the limit. It picks the fewest
near-square tiles whose cost stays under `USGS_BBOX_BUDGET` (18, against the
measured limit of 25, so roughly 28 percent margin). The standing Texas AO costs
127.25 and takes 8 tiles at a worst tile cost of 15.9.

Tiles are cut to 5 decimal places for the query string, and a split that lands
exactly on the budget can be tipped over it by that rounding, so the function
verifies every tile and steps up the tile count if any exceeds the budget. The
whole-globe case exercises this.

Request volume is held down by `CONFIG.usgsMinIntervalMs` (6 minutes) rather than
by the 3-minute poll loop: USGS publishes instantaneous values on a 15-minute
upstream cadence, so sweeping every poll would only spend requests. Six minutes
also stays under the 10-minute mark where the feed chip stops reading fresh, and
well under the 15-minute NWPS staleness that offers this layer as a fallback. Net
cost is 8 requests per 6 minutes against the old 1 per 3 minutes.

Partial sweeps keep their data but are never stamped healthy, so the feed chip
keeps ageing and the popups carry `usgs.partial`. Only a sweep where every tile
fails throws, which is what puts USGS in the degraded feed list. The throttle
stamp is set on any sweep that produced data, including a partial one, so a
permanently dead tile cannot double the request rate indefinitely.

The guard against a repeat is `check_usgs_bbox` in `scripts/cycle-check.sh`
(check l), which fails the release cycle if the shipped `data/event.json` bbox or
the built-in `CONFIG.gaugeBbox` tiles over the limit or needs more than
`USGS_BBOX_MAX_TILES` (24) sub-requests. It skips a core.js that configures no
`usgsIvBase` so the minimal cycle-check fixtures still pass, but it fails loudly
if a real core.js has the feed and lost the helper. `tests/usgs-bbox.test.js`
pins the same contract, including an oversized AO.

## CalTopo/KML/GeoRSS export feature cap

`MAX_FEATURES` in `scripts/gen-caltopo.py`. See the CHANGELOG entry for what
changed; this section records the measurements behind the number so the next
person does not have to retake them.

Measured 2026-07-26 against live data, 1117 candidate features:

| cap | JSON | KML | GeoRSS | total | generation |
|-----|------|-----|--------|-------|------------|
| 500 (old) | 250 KB | 420 KB | 289 KB | 960 KB | 0.13 s |
| full (1117) | 508 KB | 878 KB | 604 KB | 1.95 MB | 0.18 s |

Git cost is the real constraint, because all three artifacts are committed every
15 minutes and the history is the archive. Measured by regenerating the last
eight cycles from their own committed inputs at both caps and packing each series
with `git pack-objects --delta-base-offset`, so only the cap varies:

- cap 500: 24 blobs over 8 cycles, 141 KB packed, **18.1 KB per cycle**
- uncapped: 21 blobs over 8 cycles, 291 KB packed, **37.3 KB per cycle**

The 18.1 KB figure cross-checks against the same measurement taken on the real
committed blobs (18.6 KB per cycle), so the method is sound. At 96 cycles per
day that is 1.74 MB/day against 3.58 MB/day, or roughly 635 MB/year against
1.31 GB/year of pack growth.

Rank histogram of the same 1117 candidates, which is what makes the tradeoff
decidable: rank 9 alerts 3, rank 8 crests 48, rank 8 in-flood gauges 3, rank 7
road closures 43, rank 7 low-water crossings 5, rank 3 quiet gauges 1015. Every
life-safety feature sits at rank 7 or above and there are only 102 of them. The
truncation has never cut into them; the entire 617-feature drop at cap 500 was
quiet, non-flooding gauges, which are also the features that churn every cycle
while carrying the least operational value.

The 500 was never a consumer limit. It predates the gauge network's expansion
from roughly 290 to 1018 stations, at which point the whole board fit under the
cap and the truncation never fired. It first bit on 2026-07-25.
