#!/usr/bin/env python3
"""Fetch the NWPS gauge set to data/gauges-capture.json and data/gauges-snapshot.json.

One upstream request at data/event.json captureBbox (Texas-wide fallback) produces two
files: gauges-capture.json is the full capture, the durable archive whose git history is
the only record of observed stage outside the current AO; gauges-snapshot.json is that
capture filtered to gaugeBbox, the display-scoped public cold-start fallback and the frame
source walked by gen-history.py / gen-crest-summary.py. Capture is deliberately wider than
display so retargeting the AO can never again reduce what we collect. Both carry
{generated, bbox, gauges:[{lid,name,latitude,longitude,status}]} compact. Refuses to
overwrite good files with garbage: exits non-zero on HTTP/parse error or a partial
response (same-bbox refresh under 50% of that file's previous count, or under the absolute
floor), leaving both previous files intact. Writes atomically via temp + rename.
"""
import datetime
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.environ.get("RESPONDER_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "gauges-snapshot.json")
CAPTURE_OUT = os.path.join(ROOT, "data", "gauges-capture.json")
UA = "responder-tx-ops/fetch-snapshot (rfxnryan@gmail.com)"
# event-neutral Texas-wide fallback, mirrors js/core.js CONFIG.gaugeBbox
DEFAULT_BBOX = (-106.65, 25.83, -93.4, 36.5)
MIN_GAUGES_FLOOR = 25


def event_bbox(key):
    try:
        with open(os.path.join(ROOT, "data", "event.json"), encoding="utf-8") as f:
            b = json.load(f).get(key) or {}
        if all(isinstance(b.get(k), (int, float)) for k in ("xmin", "ymin", "xmax", "ymax")):
            return (b["xmin"], b["ymin"], b["xmax"], b["ymax"])
    except Exception as e:  # noqa: BLE001 — a broken event.json must not kill the cycle; fallback matches core.js
        sys.stderr.write(f"fetch-snapshot: event.json {key} unreadable, using default: {e}\n")
    return DEFAULT_BBOX


def in_bbox(g, bbox):
    lat, lon = g.get("latitude"), g.get("longitude")
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return False
    return bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]


# partial-response guard: same-bbox refreshes must return >=50% of that file's last count;
# a bbox change (event re-target) only has to clear the absolute floor
def min_gauges(path, bbox):
    try:
        with open(path, encoding="utf-8") as f:
            prev = json.load(f)
        if list(prev.get("bbox") or []) == list(bbox):
            return max(MIN_GAUGES_FLOOR, len(prev.get("gauges") or []) // 2)
    except Exception:  # noqa: BLE001 — no/old-format previous snapshot: absolute floor only
        pass
    return MIN_GAUGES_FLOOR


def write_snapshot(path, bbox, gauges, generated):
    payload = {"generated": generated, "bbox": list(bbox), "gauges": gauges}
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path),
                               prefix="." + os.path.basename(path) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, separators=(",", ":"))
        os.replace(tmp, path)
    except Exception:
        os.unlink(tmp)
        raise


def main():
    bbox = event_bbox("captureBbox")
    display = event_bbox("gaugeBbox")
    url = ("https://api.water.noaa.gov/nwps/v1/gauges"
           f"?bbox.xmin={bbox[0]}&bbox.ymin={bbox[1]}"
           f"&bbox.xmax={bbox[2]}&bbox.ymax={bbox[3]}&srid=EPSG_4326")
    print(f"fetch-snapshot: capture bbox {bbox} | display bbox {display}")
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

    shown = [g for g in gauges if in_bbox(g, display)]

    # both files are validated before either is written, so a partial response can never
    # leave a fresh capture beside a stale display subset
    for label, path, box, rows in (("capture", CAPTURE_OUT, bbox, gauges),
                                   ("snapshot", OUT, display, shown)):
        floor = min_gauges(path, box)
        if len(rows) < floor:
            sys.exit(f"fetch-snapshot: {label} only {len(rows)} gauges (need >={floor}); "
                     "keeping previous files")

    generated = datetime.datetime.now(datetime.timezone.utc).replace(
        second=0, microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")
    write_snapshot(CAPTURE_OUT, bbox, gauges, generated)
    write_snapshot(OUT, display, shown, generated)

    print(f"gauges-capture.json: {len(gauges)} gauges @ {generated}")
    print(f"gauges-snapshot.json: {len(shown)} gauges @ {generated}")


if __name__ == "__main__":
    main()
