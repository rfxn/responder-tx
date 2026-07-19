#!/usr/bin/env python3
"""Archive the current DriveTexas AO road-closure set to data/roads-snapshot.json.

Run each release cycle (like gen-feeds.py) and commit the output — the git
history of this file is the playback archive for road closures, the same
pattern gauges-snapshot.json serves for gauges. Failures are non-fatal to the
cycle: exit 0 with the previous file left intact.
"""
import datetime
import json
import os
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "roads-snapshot.json")
URL = "https://services5.arcgis.com/Rvw11bGpzJNE7apK/arcgis/rest/services/DriveTexas_API/FeatureServer/0/query"
BBOX = (-102.0, 28.0, -97.0, 31.1)
# mirror js/sources.js roadParams — construction-coded closures excluded (owner msg 34)
WHERE = ("condition IN ('Flooding','Closure','Damage') AND "
         "(description IS NULL OR UPPER(description) NOT LIKE '%CONSTRUCTION%')")


def main():
    params = urllib.parse.urlencode({
        "where": WHERE,
        "geometry": f"{BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]}",
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outSR": "4326",
        "outFields": "OBJECTID,condition,route_name,description,start_time,end_time",
        "f": "geojson",
    })
    try:
        with urllib.request.urlopen(f"{URL}?{params}", timeout=30) as r:
            gj = json.load(r)
        feats = gj.get("features", [])
    except Exception as e:  # noqa: BLE001 — archive is best-effort; cycle must not fail on TxDOT flakes
        print(f"warn: roads snapshot fetch failed, keeping previous file: {e}", file=sys.stderr)
        return
    roads = []
    for f in feats:
        try:
            p = f.get("properties", {})
            g = f.get("geometry") or {}
            coords = g.get("coordinates")
            if g.get("type") != "MultiLineString" and g.get("type") != "LineString":
                continue
            first = coords[0][0] if g["type"] == "MultiLineString" else coords[0]
            roads.append({
                # f=geojson moves OBJECTID to the feature level; consumers key on (route,start,vertex)
                "id": p.get("OBJECTID") if p.get("OBJECTID") is not None else f.get("id"),
                "cond": p.get("condition"),
                "route": p.get("route_name"),
                "desc": (p.get("description") or "")[:120],
                "start": p.get("start_time"),
                "end": p.get("end_time"),
                "v": [round(first[1], 4), round(first[0], 4)],
            })
        except Exception as e:  # noqa: BLE001 — one malformed feature must not kill the archive cycle
            print(f"warn: skipped malformed road feature: {e!r}", file=sys.stderr)
            continue
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump({"generated": now, "roads": roads}, fh, separators=(",", ":"))
    print(f"roads-snapshot.json: {len(roads)} closures @ {now}")


if __name__ == "__main__":
    main()
