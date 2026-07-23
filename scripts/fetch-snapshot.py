#!/usr/bin/env python3
"""Fetch the NWPS bbox gauge set to data/gauges-snapshot.json.

Standalone extraction of the per-cycle snapshot fetch. Writes {generated,
gauges:[{lid,name,latitude,longitude,
status}]} compact — the public cold-start fallback and the frame source walked
by gen-history.py / gen-crest-summary.py. Refuses to overwrite a good snapshot
with garbage: exits non-zero on HTTP/parse error or a <200-gauge response,
leaving the previous file intact. Writes atomically via a temp file + rename.
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
URL = ("https://api.water.noaa.gov/nwps/v1/gauges"
       "?bbox.xmin=-98.0&bbox.ymin=27.5&bbox.xmax=-93.4&bbox.ymax=31.0"
       "&srid=EPSG_4326")
UA = "responder-tx-ops/fetch-snapshot (rfxnryan@gmail.com)"
MIN_GAUGES = 200


def main():
    req = urllib.request.Request(
        URL, headers={"User-Agent": UA, "Accept": "application/json"})
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

    if len(gauges) < MIN_GAUGES:
        sys.exit(f"fetch-snapshot: only {len(gauges)} gauges (need >={MIN_GAUGES}); "
                 "keeping previous snapshot")

    generated = datetime.datetime.now(datetime.timezone.utc).replace(
        second=0, microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")
    payload = {"generated": generated, "gauges": gauges}

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
