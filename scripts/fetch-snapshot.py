#!/usr/bin/env python3
"""Fetch the NWPS bbox gauge set to data/gauges-snapshot.json.

Standalone extraction of the per-cycle snapshot fetch. AO bbox comes from
data/event.json gaugeBbox (Texas-wide fallback). Writes {generated, bbox,
gauges:[{lid,name,latitude,longitude,
status}]} compact — the public cold-start fallback and the frame source walked
by gen-history.py / gen-crest-summary.py. Refuses to overwrite a good snapshot
with garbage: exits non-zero on HTTP/parse error or a partial gauge response
(same-bbox refresh under 50% of the previous count, or under the absolute
floor), leaving the previous file intact. Writes atomically via temp + rename.
"""
import datetime
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "gauges-snapshot.json")
UA = "responder-tx-ops/fetch-snapshot (rfxnryan@gmail.com)"
# event-neutral Texas-wide fallback, mirrors js/core.js CONFIG.gaugeBbox
DEFAULT_BBOX = (-106.65, 25.83, -93.4, 36.5)
MIN_GAUGES_FLOOR = 25


def ao_bbox():
    try:
        with open(os.path.join(ROOT, "data", "event.json"), encoding="utf-8") as f:
            b = json.load(f).get("gaugeBbox") or {}
        if all(isinstance(b.get(k), (int, float)) for k in ("xmin", "ymin", "xmax", "ymax")):
            return (b["xmin"], b["ymin"], b["xmax"], b["ymax"])
    except Exception as e:  # noqa: BLE001 — a broken event.json must not kill the cycle; fallback matches core.js
        sys.stderr.write(f"fetch-snapshot: event.json bbox unreadable, using default: {e}\n")
    return DEFAULT_BBOX


# partial-response guard: same-bbox refreshes must return >=50% of the last snapshot;
# a bbox change (event re-target) only has to clear the absolute floor
def min_gauges(bbox):
    try:
        with open(OUT, encoding="utf-8") as f:
            prev = json.load(f)
        if list(prev.get("bbox") or []) == list(bbox):
            return max(MIN_GAUGES_FLOOR, len(prev.get("gauges") or []) // 2)
    except Exception:  # noqa: BLE001 — no/old-format previous snapshot: absolute floor only
        pass
    return MIN_GAUGES_FLOOR


def main():
    bbox = ao_bbox()
    url = ("https://api.water.noaa.gov/nwps/v1/gauges"
           f"?bbox.xmin={bbox[0]}&bbox.ymin={bbox[1]}"
           f"&bbox.xmax={bbox[2]}&bbox.ymax={bbox[3]}&srid=EPSG_4326")
    print(f"fetch-snapshot: AO bbox {bbox}")
    req = urllib.request.Request(
        url, headers={"User-Agent": UA, "Accept": "application/json"})
    # Retry transient failures (429 rate-limit, 5xx, timeouts) with backoff so a
    # brief NWPS hiccup doesn't stale the board; a hard 4xx aborts immediately.
    backoffs = [3, 8, 20]
    data = None
    for attempt in range(len(backoffs) + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.load(r)
            break
        except Exception as e:  # noqa: BLE001 — any fetch/parse failure aborts, never writes garbage
            transient = (not isinstance(e, urllib.error.HTTPError)
                         or e.code == 429 or 500 <= e.code < 600)
            if attempt < len(backoffs) and transient:
                sys.stderr.write(f"fetch-snapshot: attempt {attempt + 1} failed ({e}); "
                                 f"retry in {backoffs[attempt]}s\n")
                time.sleep(backoffs[attempt])
                continue
            sys.exit(f"fetch-snapshot: NWPS fetch failed: {e}")

    gauges = []
    for g in data.get("gauges", []):
        lid = g.get("lid")
        status = g.get("status")
        if not lid or status is None:
            continue
        gauges.append({
            "lid": lid,
            "name": g.get("name"),
            "latitude": g.get("latitude"),
            "longitude": g.get("longitude"),
            "status": status,
        })

    floor = min_gauges(bbox)
    if len(gauges) < floor:
        sys.exit(f"fetch-snapshot: only {len(gauges)} gauges (need >={floor}); "
                 "keeping previous snapshot")

    generated = datetime.datetime.now(datetime.timezone.utc).replace(
        second=0, microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")
    payload = {"generated": generated, "bbox": list(bbox), "gauges": gauges}

    data_dir = os.path.dirname(OUT)
    fd, tmp = tempfile.mkstemp(dir=data_dir, prefix=".gauges-snapshot.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, separators=(",", ":"))
        os.replace(tmp, OUT)
    except Exception:
        os.unlink(tmp)
        raise

    print(f"gauges-snapshot.json: {len(gauges)} gauges @ {generated}")


if __name__ == "__main__":
    main()
