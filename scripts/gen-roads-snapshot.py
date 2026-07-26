#!/usr/bin/env python3
"""Archive the DriveTexas road-closure set to data/roads-capture.json and data/roads-snapshot.json.

Run each release cycle (like gen-feeds.py) and commit the output. The git history of these
files is the playback archive for road closures, the same pattern gauges-snapshot.json
serves for gauges, and it is the ONLY archive that exists: the upstream ArcGIS service
reports hasVersionedData false, syncEnabled false, no archivingInfo, and layer 0 has
neither supportsHistoricMoment nor timeInfo, so a closure that clears is gone from
upstream for good. One request at data/event.json captureBbox (Texas-wide fallback)
produces roads-capture.json, the durable statewide archive; roads-snapshot.json is that
capture filtered to gaugeBbox, the display-scoped file gen-history.py and gen-caltopo.py
consume. Capture is deliberately wider than display so retargeting the AO can never again
reduce what we collect. Failures are non-fatal to the cycle but exit non-zero: the previous
files are left intact, and the non-zero status is what makes run-cycle.sh sign the cycle off
DEGRADED instead of clean, which is the signal the freshness monitor reads.
"""
import datetime
import json
import os
import sys
import tempfile
import urllib.parse
import urllib.request

ROOT = os.environ.get("RESPONDER_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "roads-snapshot.json")
CAPTURE_OUT = os.path.join(ROOT, "data", "roads-capture.json")
URL = "https://services5.arcgis.com/Rvw11bGpzJNE7apK/arcgis/rest/services/DriveTexas_API/FeatureServer/0/query"
# event-neutral Texas-wide fallback, mirrors js/core.js CONFIG.gaugeBbox
DEFAULT_BBOX = (-106.65, 25.83, -93.4, 36.5)
# mirror js/sources.js roadParams — construction-coded closures excluded
WHERE = ("condition IN ('Flooding','Closure','Damage') AND "
         "(description IS NULL OR UPPER(description) NOT LIKE '%CONSTRUCTION%')")
PAGE = 2000        # the service's own maxRecordCount
MAX_PAGES = 8      # runaway guard; the statewide set runs in the tens even in a major event


def arcgis_has_more(doc):
    """ArcGIS truncation signal: top level in GeoJSON output, nested under properties elsewhere."""
    if not isinstance(doc, dict):
        return False
    props = doc.get("properties")
    return bool(doc.get("exceededTransferLimit")
                or (isinstance(props, dict) and props.get("exceededTransferLimit")))


def fetch_features(bbox):
    """Every closure in the bbox, paged. Returns (features, truncated); truncated means the
    ceiling cut paging short, so the set is short of what the service holds."""
    feats = []
    for page in range(MAX_PAGES):
        params = urllib.parse.urlencode({
            "where": WHERE,
            "geometry": f"{bbox[0]},{bbox[1]},{bbox[2]},{bbox[3]}",
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outSR": "4326",
            "outFields": "OBJECTID,condition,route_name,description,start_time,end_time",
            "resultRecordCount": str(PAGE),
            "resultOffset": str(page * PAGE),
            "f": "geojson",
        })
        with urllib.request.urlopen(f"{URL}?{params}", timeout=30) as r:
            doc = json.load(r)
        # ArcGIS returns 200 OK with an {"error":...} body; never archive that as an empty-roads day
        if not isinstance(doc, dict) or "error" in doc or not isinstance(doc.get("features"), list):
            raise ValueError(f"response is not a FeatureCollection: {str(doc)[:200]}")
        feats += doc["features"]
        if not doc["features"] or not arcgis_has_more(doc):
            return feats, False
    return feats, True


def event_bbox(key):
    try:
        with open(os.path.join(ROOT, "data", "event.json"), encoding="utf-8") as f:
            b = json.load(f).get(key) or {}
        if all(isinstance(b.get(k), (int, float)) for k in ("xmin", "ymin", "xmax", "ymax")):
            return (b["xmin"], b["ymin"], b["xmax"], b["ymax"])
    except Exception as e:  # noqa: BLE001 — a broken event.json must not kill the cycle; fallback matches core.js
        print(f"warn: event.json {key} unreadable, using default: {e}", file=sys.stderr)
    return DEFAULT_BBOX


def in_bbox(rec, bbox):
    v = rec.get("v")
    if not isinstance(v, list) or len(v) != 2:
        return False
    lat, lon = v
    return bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]


def write_roads(path, roads, now):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path),
                               prefix="." + os.path.basename(path) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"generated": now, "roads": roads}, fh, separators=(",", ":"))
        os.replace(tmp, path)
    except Exception:  # noqa: BLE001, cleanup: drop the temp file, then re-raise
        os.unlink(tmp)
        raise


def main():
    bbox = event_bbox("captureBbox")
    display = event_bbox("gaugeBbox")
    print(f"gen-roads-snapshot: capture bbox {bbox} | display bbox {display}")
    try:
        feats, truncated = fetch_features(bbox)
    except Exception as e:  # noqa: BLE001 — archive is best-effort; cycle must not fail on TxDOT flakes
        print(f"warn: roads snapshot fetch failed, keeping previous file: {e}", file=sys.stderr)
        return 1
    # a short set archives live closures as absent, and this archive is the only record there is:
    # gen-history.py reads absence as cleared, so a truncated capture invents road recoveries
    if truncated:
        print(f"warn: roads snapshot still truncated after {MAX_PAGES} pages "
              f"({len(feats)} features), keeping previous file", file=sys.stderr)
        return 1
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
    shown = [r for r in roads if in_bbox(r, display)]
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    write_roads(CAPTURE_OUT, roads, now)
    write_roads(OUT, shown, now)
    print(f"roads-capture.json: {len(roads)} closures @ {now}")
    print(f"roads-snapshot.json: {len(shown)} closures @ {now}")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
