#!/usr/bin/env python3
"""Fetch the NWPS gauge set to data/gauges-capture.json and data/gauges-snapshot.json.

One upstream request at data/event.json captureBbox (Texas-wide fallback) produces two
files: gauges-capture.json is the full capture, the durable archive whose git history is
the only record of observed stage outside the current AO; gauges-snapshot.json is that
capture filtered to gaugeBbox and the event.json aoArea outline (scripts/aoarea.py), the
display-scoped public cold-start fallback. Capture is deliberately wider than display so
retargeting the AO can never again reduce what we collect. Both carry
{generated, bbox, gauges:[{lid,name,latitude,longitude,status}]} compact; the display file
also names its aoArea fingerprint. Refuses to overwrite good files with garbage: exits
non-zero on HTTP/parse error or a partial capture (same-scope refresh under 50% of that
file's previous count, or under the absolute floor), leaving both previous files intact. A
display scope that yields too few gauges keeps the previous display file but still writes
the capture, so a display-config problem can never stall retention. Writes atomically.
"""
import datetime
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import aoarea  # noqa: E402

ROOT = os.environ.get("RESPONDER_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "gauges-snapshot.json")
CAPTURE_OUT = os.path.join(ROOT, "data", "gauges-capture.json")
UA = "responder-tx-ops/fetch-snapshot (rfxnryan@gmail.com)"
# event-neutral Texas-wide fallback, mirrors js/core.js CONFIG.gaugeBbox
DEFAULT_BBOX = (-106.65, 25.83, -93.4, 36.5)
MIN_GAUGES_FLOOR = 25
# mirrors js/core.js stageOk; see INTERNAL-NOTES.md "Impossible gauge stages"
STAGE_MIN_FT = -300
STAGE_MAX_FT = 25000
NO_READING = {"observed": "obs_not_current", "forecast": "fcst_not_current"}


def stage_ok(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and STAGE_MIN_FT < v < STAGE_MAX_FT


def displayable(g):
    """Display copy of a captured gauge: an impossible stage becomes NWPS's own no-reading shape."""
    status = dict(g.get("status") or {})
    for key, no_reading in NO_READING.items():
        part = status.get(key)
        if isinstance(part, dict) and not stage_ok(part.get("primary")) \
                and part.get("floodCategory") not in (no_reading, "out_of_service"):
            status[key] = dict(part, primary=-999, floodCategory=no_reading)
    return dict(g, status=status)


def event_bbox(key):
    try:
        with open(os.path.join(ROOT, "data", "event.json"), encoding="utf-8") as f:
            b = json.load(f).get(key) or {}
        if all(isinstance(b.get(k), (int, float)) for k in ("xmin", "ymin", "xmax", "ymax")):
            return (b["xmin"], b["ymin"], b["xmax"], b["ymax"])
    except Exception as e:  # noqa: BLE001 — a broken event.json must not kill the cycle; fallback matches core.js
        sys.stderr.write(f"fetch-snapshot: event.json {key} unreadable, using default: {e}\n")
    return DEFAULT_BBOX


def event_area():
    """Parsed aoArea, or None: absent or malformed leaves gaugeBbox as the whole display rule."""
    try:
        with open(os.path.join(ROOT, "data", "event.json"), encoding="utf-8") as f:
            raw = json.load(f).get("aoArea")
    except Exception as e:  # noqa: BLE001, same fallback as event_bbox: the bbox rule still publishes
        sys.stderr.write(f"fetch-snapshot: event.json aoArea unreadable, display uses gaugeBbox only: {e}\n")
        return None
    area = aoarea.parse(raw)
    if raw is not None and area is None:
        sys.stderr.write("fetch-snapshot: event.json aoArea is malformed; display uses gaugeBbox only\n")
    return area


def display_rows(gauges, bbox, area):
    return [g for g in gauges if aoarea.in_scope(bbox, area, g.get("latitude"), g.get("longitude"))]


# partial-response guard: same-scope refreshes must return >=50% of that file's last count;
# a scope change (bbox or aoArea re-target) only has to clear the absolute floor
def min_gauges(path, bbox, ao=None):
    try:
        with open(path, encoding="utf-8") as f:
            prev = json.load(f)
        if list(prev.get("bbox") or []) == list(bbox) and prev.get("ao") == ao:
            return max(MIN_GAUGES_FLOOR, len(prev.get("gauges") or []) // 2)
    except Exception:  # noqa: BLE001 — no/old-format previous snapshot: absolute floor only
        pass
    return MIN_GAUGES_FLOOR


def write_snapshot(path, bbox, gauges, generated, ao=None):
    payload = {"generated": generated, "bbox": list(bbox), "gauges": gauges}
    if ao:
        payload["ao"] = ao
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
    area = event_area()
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

    publish(gauges, bbox, display, area)


def publish(gauges, bbox, display, area):
    # a short capture is a partial response and writes nothing; a short display is scope, so retention still lands
    floor = min_gauges(CAPTURE_OUT, bbox)
    if len(gauges) < floor:
        sys.exit(f"fetch-snapshot: capture only {len(gauges)} gauges (need >={floor}); "
                 "keeping previous files")
    ao = aoarea.fingerprint(area)
    shown = display_rows(gauges, display, area)
    generated = datetime.datetime.now(datetime.timezone.utc).replace(
        second=0, microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")
    write_snapshot(CAPTURE_OUT, bbox, gauges, generated)
    print(f"gauges-capture.json: {len(gauges)} gauges @ {generated}")
    floor = min_gauges(OUT, display, ao)
    if len(shown) < floor:
        sys.exit(f"fetch-snapshot: display scope only {len(shown)} gauges (need >={floor}); "
                 "capture written, previous gauges-snapshot.json kept")
    write_snapshot(OUT, display, [displayable(g) for g in shown], generated, ao)
    print(f"gauges-snapshot.json: {len(shown)} gauges @ {generated}"
          + (f" ({len(gauges) - len(shown)} outside aoArea {ao} or gaugeBbox)" if ao else ""))


if __name__ == "__main__":
    main()
