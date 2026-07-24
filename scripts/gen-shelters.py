#!/usr/bin/env python3
"""Poll FEMA NSS open shelters (ESF6-SS/ARC sync) to data/shelters-live.json.

Queries the FEMA Open Shelters layer for the event AO bbox (data/event.json
gaugeBbox + margin). An empty result from a healthy API is real data (no
shelters open in the AO) and writes an empty-but-valid file; a fetch/parse
failure exits non-zero and leaves the previous file intact.
"""
import datetime
import json
import os
import sys
import tempfile
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "shelters-live.json")
EVENT = os.path.join(ROOT, "data", "event.json")
URL = "https://gis.fema.gov/arcgis/rest/services/NSS/OpenShelters/MapServer/0/query"
SOURCE = {
    "name": "FEMA National Shelter System (ARC sync)",
    "url": "https://gis.fema.gov/arcgis/rest/services/NSS/OpenShelters/MapServer/0",
}
UA = "responder-tx-ops/gen-shelters (rfxnryan@gmail.com)"
DEFAULT_BBOX = {"xmin": -98.0, "ymin": 27.5, "xmax": -93.4, "ymax": 31.0}
MARGIN = 0.5


def ao_bbox():
    try:
        with open(EVENT, encoding="utf-8") as f:
            b = json.load(f).get("gaugeBbox") or {}
        if all(isinstance(b.get(k), (int, float)) for k in ("xmin", "ymin", "xmax", "ymax")):
            return b
    except Exception as e:  # noqa: BLE001 — a broken event.json must not kill the poller; CONFIG default matches core.js
        print(f"warn: event.json bbox unreadable, using default: {e}", file=sys.stderr)
    return DEFAULT_BBOX


def main():
    b = ao_bbox()
    params = urllib.parse.urlencode({
        "where": "1=1",
        "geometry": f"{b['xmin'] - MARGIN},{b['ymin'] - MARGIN},{b['xmax'] + MARGIN},{b['ymax'] + MARGIN}",
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outSR": "4326",
        "outFields": ("shelter_name,address,city,state,zip,shelter_status,"
                      "evacuation_capacity,total_population,org_name"),
        "f": "geojson",
    })
    req = urllib.request.Request(f"{URL}?{params}", headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            gj = json.load(r)
    except Exception as e:  # noqa: BLE001 — any fetch/parse failure keeps last-good; cycle treats this step as optional
        sys.exit(f"gen-shelters: NSS fetch failed, keeping previous file: {e}")
    # ArcGIS returns 200 OK with an {"error":...} body; never mistake that for zero shelters
    if not isinstance(gj, dict) or "error" in gj or not isinstance(gj.get("features"), list):
        sys.exit(f"gen-shelters: response is not a FeatureCollection, keeping previous file: {str(gj)[:200]}")

    shelters = []
    for f in gj["features"]:
        try:
            p = f.get("properties") or {}
            g = f.get("geometry") or {}
            coords = g.get("coordinates")
            name = p.get("shelter_name")
            if g.get("type") != "Point" or not coords or not name:
                continue
            lon, lat = float(coords[0]), float(coords[1])
            addr = ", ".join(str(x).strip() for x in (p.get("address"), p.get("city"), p.get("state")) if x)
            if p.get("zip"):
                addr = f"{addr} {p['zip']}".strip()
            entry = {
                "name": str(name),
                "address": addr,
                "lat": round(lat, 5),
                "lon": round(lon, 5),
                "status": str(p.get("shelter_status") or "OPEN"),
            }
            if isinstance(p.get("evacuation_capacity"), (int, float)):
                entry["capacity"] = int(p["evacuation_capacity"])
            if isinstance(p.get("total_population"), (int, float)):
                entry["occupancy"] = int(p["total_population"])
            if p.get("org_name"):
                entry["org"] = str(p["org_name"])
            shelters.append(entry)
        except Exception as e:  # noqa: BLE001 — one malformed feature must not drop the whole poll
            print(f"warn: skipped malformed shelter feature: {e!r}", file=sys.stderr)
            continue

    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    payload = {"generated": now, "source": SOURCE, "shelters": shelters}
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(OUT), prefix=".shelters-live.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, separators=(",", ":"))
        os.replace(tmp, OUT)
    except Exception:  # noqa: BLE001, cleanup: drop the temp file, then re-raise
        os.unlink(tmp)
        raise
    print(f"shelters-live.json: {len(shelters)} open shelters in AO @ {now}")


if __name__ == "__main__":
    main()
