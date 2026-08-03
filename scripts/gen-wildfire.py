#!/usr/bin/env python3
"""Poll active wildfire incidents to data/wildfire.json.

Two independent sources: Texas A&M Forest Service (in-state, the only feed that carries live
Texas wildfire content) and NIFC WFIGS incident locations for the band just outside the state.
WFIGS records whose point of origin is Texas are dropped, because TFS is authoritative in-state
and a duplicate would double-count the same fire.

Scope is data/wildfire-scope.json, an outline of Texas plus a buffer in miles, and deliberately
NOT data/event.json: event.json is the flood area of operations, and a flood re-target must not
silently redefine which fires the board carries. Each record publishes the side of the line it
fell on, so the client need not imply every incident is a Texas one.

Zero active wildfires is the normal Texas state for most of the year, so an empty-but-valid read
publishes cleanly with status "ok" and count 0. A failed read never does: a source that could not
be read publishes status "failed" with a null count and contributes no records, and the run exits
non-zero so run-cycle.sh signs the cycle DEGRADED. When neither source can be read nothing is
written at all, and the previous file keeps its own older stamp for the board to age.

acres and contain are None when the source did not report them. WFIGS omits containment on about
two thirds of its records, and a 0 substituted for a null would assert an uncontained fire that
nobody reported.
"""
import datetime
import json
import math
import os
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.environ.get("RESPONDER_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "wildfire.json")
UA = "responder-tx-ops/gen-wildfire (rfxnryan@gmail.com)"

TFS_URL = "https://tfswildfires.com/public/api/incidents"
WFIGS_LAYER = ("https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services"
               "/WFIGS_Incident_Locations_Current/FeatureServer/0")
SOURCES = {
    "tfs": {"name": "Texas A&M Forest Service", "url": "https://tfswildfires.com/public/"},
    "wfigs": {"name": "National Interagency Fire Center (WFIGS)",
              "url": "https://data-nifc.opendata.arcgis.com/"},
    "wfigs-perimeters": {"name": "National Interagency Fire Center (WFIGS perimeters)",
                         "url": "https://data-nifc.opendata.arcgis.com/"},
}

SCOPE = os.path.join(ROOT, "data", "wildfire-scope.json")
MI_PER_DEG_LAT = 69.0
# both endpoints answer healthy in well under a second, so a short deadline plus retries beats one
# long wait on a hang
TIMEOUT = 12
BACKOFFS = [2, 5]
PAGE = 1000
MAX_PAGES = 4
# fill rates measured 2026-07-29 over 47 in-scope records: FireCause 96%, PercentContained 15%,
# IncidentManagementOrganization 15%, TotalIncidentPersonnel 13%. ContainmentDateTime was 0/47 and
# is left out rather than carried as a column nothing populates.
WFIGS_FIELDS = ("IncidentName,POOState,POOCounty,IncidentSize,PercentContained,"
                "ModifiedOnDateTime_dt,FireDiscoveryDateTime,UniqueFireIdentifier,IrwinID,"
                "POOProtectingAgency,IncidentTypeCategory,FireCause,"
                "TotalIncidentPersonnel,IncidentManagementOrganization")
WFIGS_WHERE = "IncidentTypeCategory='WF' AND FireOutDateTime IS NULL"

# Perimeters come from WFIGS for Texas fires TOO, unlike incident points: the in-state dedupe
# above exists because TFS publishes its own points, and it publishes no perimeter of any kind.
WFIGS_PERIM_LAYER = ("https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services"
                     "/WFIGS_Interagency_Perimeters_Current/FeatureServer/0")
PERIM_FIELDS = ("poly_IncidentName,poly_GISAcres,poly_IRWINID,poly_DateCurrent,"
                "poly_FeatureCategory,poly_MapMethod")
# ~55 m. Server-side generalization, because the raw geometry is unusable on this board: measured
# 2026-07-30 over 6 in-scope fires, 11064 vertices and 243 KB became 202 vertices and 7 KB, and a
# fire edge is a daily interpretation of imagery, not a survey.
PERIM_OFFSET = "0.0005"
PERIM_MAX_VERTS = 40000   # a runaway geometry must not become the payload; refuse instead


def load_scope():
    """(ring, buffer_mi, bbox). Raises: with no scope there is no way to tell a Texas fire from a
    Montana one, and both answers a fallback could give (publish everything, publish nothing) are
    false claims. Failing keeps the previous file, which ages visibly."""
    with open(SCOPE, encoding="utf-8") as f:
        s = json.load(f)
    ring = s.get("ring")
    if not isinstance(ring, list) or len(ring) < 4:
        raise ValueError("wildfire-scope.json: ring missing or too short to be a boundary")
    ring = [(float(x), float(y)) for x, y in ring]
    buf = s.get("bufferMiles")
    if not isinstance(buf, (int, float)) or not 0 <= buf <= 500:
        raise ValueError(f"wildfire-scope.json: bufferMiles {buf!r} outside 0-500")
    lons = [p[0] for p in ring]
    lats = [p[1] for p in ring]
    pad_lat = buf / MI_PER_DEG_LAT
    pad_lon = buf / max(1.0, MI_PER_DEG_LAT * math.cos(math.radians(sum(lats) / len(lats))))
    bbox = {"xmin": min(lons) - pad_lon, "ymin": min(lats) - pad_lat,
            "xmax": max(lons) + pad_lon, "ymax": max(lats) + pad_lat}
    return ring, float(buf), bbox


def in_ring(lat, lon, ring):
    inside = False
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        if (y1 > lat) != (y2 > lat) and lon < x1 + (lat - y1) / (y2 - y1) * (x2 - x1):
            inside = not inside
    return inside


def miles_to_ring(lat, lon, ring):
    """Shortest distance to the boundary, in statute miles. Degrees are scaled to miles before the
    comparison, because a degree of longitude at this latitude is about 56 miles, not 69."""
    kx = MI_PER_DEG_LAT * math.cos(math.radians(lat))
    px, py = lon * kx, lat * MI_PER_DEG_LAT
    best = float("inf")
    for i in range(len(ring) - 1):
        ax, ay = ring[i][0] * kx, ring[i][1] * MI_PER_DEG_LAT
        bx, by = ring[i + 1][0] * kx, ring[i + 1][1] * MI_PER_DEG_LAT
        dx, dy = bx - ax, by - ay
        span = dx * dx + dy * dy
        t = 0.0 if span == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / span))
        best = min(best, math.hypot(px - (ax + t * dx), py - (ay + t * dy)))
    return best


def scope_of(lat, lon, ring, buffer_mi):
    """"tx", "buffer", or None for a fire the board does not carry."""
    if in_ring(lat, lon, ring):
        return "tx"
    return "buffer" if miles_to_ring(lat, lon, ring) <= buffer_mi else None


def iso_z(dt):
    return dt.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def iso_from_ms(v):
    """ArcGIS epoch-milliseconds to an ISO stamp, or None. None means the source did not say."""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return None
    try:
        return iso_z(datetime.datetime.fromtimestamp(v / 1000.0, datetime.timezone.utc))
    except (ValueError, OSError, OverflowError):
        return None


def iso_from_text(v):
    if not isinstance(v, str) or not v.strip():
        return None
    try:
        dt = datetime.datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return iso_z(dt if dt.tzinfo else dt.replace(tzinfo=datetime.timezone.utc))


def number(v, lo=None, hi=None, ndigits=1):
    """A reported figure, or None when the source reported nothing usable. Out of range counts as
    nothing: publishing it would assert a measurement no agency made."""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return None
    if (lo is not None and v < lo) or (hi is not None and v > hi):
        return None
    v = round(float(v), ndigits)
    return int(v) if v == int(v) else v


def get_json(url, label):
    """One read, retried through BACKOFFS. Both upstreams report trouble as an error body inside
    HTTP 200, so that retries too; a hard 4xx is a bad query and raises at once."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    for attempt in range(len(BACKOFFS) + 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                doc = json.load(r)
            if not isinstance(doc, dict) or "error" in doc:
                raise ValueError(f"response is an error body, not data: {str(doc)[:200]}")
            return doc
        except Exception as e:  # noqa: BLE001 — the caller marks the source failed on the final raise
            hard_4xx = isinstance(e, urllib.error.HTTPError) and e.code != 429 and e.code < 500
            if attempt == len(BACKOFFS) or hard_4xx:
                raise
            print(f"warn: {label} attempt {attempt + 1} failed ({e}); retry in {BACKOFFS[attempt]}s",
                  file=sys.stderr)
            time.sleep(BACKOFFS[attempt])


def arcgis_has_more(doc):
    """ArcGIS truncation signal: top level in GeoJSON output, nested under properties elsewhere."""
    props = doc.get("properties")
    return bool(doc.get("exceededTransferLimit")
                or (isinstance(props, dict) and props.get("exceededTransferLimit")))


def feature_list(doc, label):
    if not isinstance(doc.get("features"), list):
        raise ValueError(f"{label}: no features[]; an absent list is a failed read, never zero fires")
    return doc["features"]


def point_of(f):
    g = f.get("geometry") or {}
    c = g.get("coordinates")
    if g.get("type") != "Point" or not isinstance(c, (list, tuple)) or len(c) < 2:
        return None
    lon, lat = float(c[0]), float(c[1])
    if not (math.isfinite(lat) and math.isfinite(lon)) or abs(lat) > 90 or abs(lon) > 180:
        return None
    return round(lat, 5), round(lon, 5)


def collect_tfs(scope):
    """(fires, captured). Raises on any read the file must not publish as an empty day."""
    doc = get_json(TFS_URL, "TFS")
    fires = []
    for f in feature_list(doc, "TFS"):
        try:
            p = f.get("properties") or {}
            if str(p.get("categoryType") or "") != "Wildfire":
                continue
            if str(p.get("publicvisibility") or "") != "Visible":
                continue
            pt = point_of(f)
            name = str(p.get("name") or "").strip()
            observed = iso_from_text(p.get("lastupdated")) or iso_from_text(p.get("statustimestamp"))
            if not pt or not name or not p.get("id") or not observed:
                continue
            where = scope_of(pt[0], pt[1], scope[0], scope[1])
            if where is None:
                continue
            # the feed states its own units rather than implying them, so an incident measured in
            # something other than acres publishes no acreage instead of a mislabelled number
            acres = number(p.get("size"), lo=0) if str(p.get("sizeunit") or "") == "Acres" else None
            contain = (number(p.get("containment"), lo=0, hi=100)
                       if str(p.get("containmentunit") or "") == "Percent" else None)
            county = str(p.get("admindivision") or "").strip() or None
            if str(p.get("admindivisiontype") or "") != "COUNTY":
                county = None
            fires.append({
                "id": "tfs:%s" % p["id"],
                "src": "tfs",
                "scope": where,
                "name": name,
                "lat": pt[0],
                "lon": pt[1],
                # open vocabulary, server-driven: rendered verbatim, never mapped to a fixed set
                "status": str(p.get("statusname") or "").strip() or None,
                "acres": acres,
                "contain": contain,
                "county": county,
                "state": "TX",
                "observed": observed,
                "started": iso_from_text(p.get("firsttimestatus")),
                "unit": str(p.get("protectingunit") or "").strip() or None,
                "number": str(p.get("number") or "").strip() or None,
            })
        except Exception as e:  # noqa: BLE001 — one malformed feature must not drop the whole poll
            print(f"warn: skipped malformed TFS feature: {e!r}", file=sys.stderr)
    return fires, iso_from_text(doc.get("created"))


def wfigs_captured():
    """The service's own last-edit stamp, or None. A missing stamp is not a failure: the incident
    read succeeded, and the board says the source's currency is unknown rather than guessing it."""
    try:
        meta = get_json(f"{WFIGS_LAYER}?f=json", "WFIGS metadata")
        return iso_from_ms((meta.get("editingInfo") or {}).get("lastEditDate"))
    except Exception as e:  # noqa: BLE001 — an ancillary stamp read must not fail a good incident read
        print(f"warn: WFIGS layer metadata unreadable, currency unknown: {e}", file=sys.stderr)
        return None


def collect_wfigs(scope):
    """(fires, captured). Raises on a failed or truncated read: a short set read as complete
    invents an absence."""
    raw = []
    for page in range(MAX_PAGES):
        params = urllib.parse.urlencode({
            "where": WFIGS_WHERE,
            "geometry": (f"{scope[2]['xmin']},{scope[2]['ymin']},"
                         f"{scope[2]['xmax']},{scope[2]['ymax']}"),
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outSR": "4326",
            "geometryPrecision": "5",
            "outFields": WFIGS_FIELDS,
            "resultRecordCount": str(PAGE),
            "resultOffset": str(page * PAGE),
            "f": "geojson",
        })
        doc = get_json(f"{WFIGS_LAYER}/query?{params}", "WFIGS")
        feats = feature_list(doc, "WFIGS")
        raw += feats
        if not feats or not arcgis_has_more(doc):
            break
    else:
        raise ValueError(f"WFIGS still reports more rows after {MAX_PAGES} pages; "
                         "a truncated set read as complete would invent an absence")

    fires = []
    for f in raw:
        try:
            p = f.get("properties") or {}
            state = str(p.get("POOState") or "").strip().upper()
            # TFS is authoritative in Texas; the same fire from both sources would double-count
            if state == "US-TX":
                continue
            pt = point_of(f)
            name = str(p.get("IncidentName") or "").strip()
            fid = str(p.get("UniqueFireIdentifier") or "").strip()
            observed = iso_from_ms(p.get("ModifiedOnDateTime_dt"))
            if not pt or not name or not fid or not observed:
                continue
            where = scope_of(pt[0], pt[1], scope[0], scope[1])
            if where is None:
                continue
            fires.append({
                "id": "wfigs:%s" % fid,
                "src": "wfigs",
                "scope": where,
                "irwin": str(p.get("IrwinID") or "").strip() or None,  # joins a fire to its perimeter
                "name": name,
                "lat": pt[0],
                "lon": pt[1],
                "status": None,  # WFIGS publishes no status label, only dates
                "acres": number(p.get("IncidentSize"), lo=0),
                "contain": number(p.get("PercentContained"), lo=0, hi=100),
                "county": str(p.get("POOCounty") or "").strip() or None,
                "state": state[3:] if state.startswith("US-") else (state or None),
                "observed": observed,
                "started": iso_from_ms(p.get("FireDiscoveryDateTime")),
                "unit": str(p.get("POOProtectingAgency") or "").strip() or None,
                "cause": (lambda c: c if c and c.lower() not in ("none", "null") else None)(
                    str(p.get("FireCause") or "").strip()),
                "org": str(p.get("IncidentManagementOrganization") or "").strip() or None,
                "crew": number(p.get("TotalIncidentPersonnel"), lo=0, ndigits=0),
            })
        except Exception as e:  # noqa: BLE001 — one malformed feature must not drop the whole poll
            print(f"warn: skipped malformed WFIGS feature: {e!r}", file=sys.stderr)
    return fires, wfigs_captured()


def collect(key, fn, scope):
    try:
        fires, captured = fn(scope)
    except Exception as e:  # noqa: BLE001 — a failed source is published as failed, never as zero
        print(f"warn: {key} read failed, publishing it as failed with no records: {e}", file=sys.stderr)
        return [], dict(SOURCES[key], key=key, status="failed", captured=None, count=None)
    return fires, dict(SOURCES[key], key=key, status="ok", captured=captured, count=len(fires))


def write_payload(payload):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(OUT), prefix=".wildfire.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, separators=(",", ":"))
        os.replace(tmp, OUT)
    except Exception:  # noqa: BLE001, cleanup: drop the temp file, then re-raise
        os.unlink(tmp)
        raise


def collect_perimeters(scope):
    """(perimeters, captured). A fire edge where an agency has mapped one; most fires have none,
    which is why the points layer stays. Raises on a truncated read, like the incident collector:
    a short set read as complete would draw a fire smaller than it is."""
    raw = []
    for page in range(MAX_PAGES):
        params = urllib.parse.urlencode({
            "where": "1=1",
            "geometry": (f"{scope[2]['xmin']},{scope[2]['ymin']},"
                         f"{scope[2]['xmax']},{scope[2]['ymax']}"),
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outSR": "4326",
            "geometryPrecision": "5",
            "maxAllowableOffset": PERIM_OFFSET,
            "outFields": PERIM_FIELDS,
            "resultRecordCount": str(PAGE),
            "resultOffset": str(page * PAGE),
            "f": "geojson",
        })
        doc = get_json(f"{WFIGS_PERIM_LAYER}/query?{params}", "WFIGS perimeters")
        feats = feature_list(doc, "WFIGS perimeters")
        raw += feats
        if not feats or not arcgis_has_more(doc):
            break
    else:
        raise ValueError(f"WFIGS perimeters still reports more rows after {MAX_PAGES} pages; "
                         "a truncated set read as complete would draw a fire smaller than it is")

    out, verts = [], 0
    for f in raw:
        try:
            p = f.get("properties") or {}
            rings = rings_of(f.get("geometry"))
            if not rings:
                continue
            # any vertex inside decides it: a perimeter on the state line is ours even when its
            # centre is not, and the centre of a horseshoe can sit outside its own fire
            hit = None
            for ring in rings:
                for lon, lat in ring:
                    hit = scope_of(lat, lon, scope[0], scope[1])
                    if hit:
                        break
                if hit:
                    break
            if not hit:
                continue
            verts += sum(len(r) for r in rings)
            if verts > PERIM_MAX_VERTS:
                raise ValueError(f"perimeter geometry exceeded {PERIM_MAX_VERTS} vertices; "
                                 "refusing to publish a payload that size")
            name = str(p.get("poly_IncidentName") or "").strip()
            irwin = str(p.get("poly_IRWINID") or "").strip()
            out.append({
                "id": f"wfigs-perim:{irwin or name or len(out)}",
                "irwin": irwin,
                "name": name,
                "scope": hit,
                "acres": number(p.get("poly_GISAcres"), lo=0),
                "observed": iso_from_ms(p.get("poly_DateCurrent")) or iso_from_text(p.get("poly_DateCurrent")),
                "method": str(p.get("poly_MapMethod") or "").strip() or None,
                "category": str(p.get("poly_FeatureCategory") or "").strip() or None,
                "rings": rings,
            })
        except ValueError:
            raise
        except Exception as e:  # noqa: BLE001 — one malformed polygon must not drop the rest
            print(f"warn: skipped malformed WFIGS perimeter: {e!r}", file=sys.stderr)
    out.sort(key=lambda x: (x["name"] or "", x["id"]))
    return out, wfigs_captured()


def rings_of(geom):
    """Outer rings as [[lon, lat], ...], for a GeoJSON Polygon or MultiPolygon. Holes are dropped:
    the board draws where the fire is, and an unburnt island inside it is not an operational fact
    at this zoom."""
    if not isinstance(geom, dict):
        return []
    kind, coords = geom.get("type"), geom.get("coordinates")
    if kind == "Polygon" and isinstance(coords, list):
        return [r for r in coords[:1] if isinstance(r, list) and len(r) >= 4]
    if kind == "MultiPolygon" and isinstance(coords, list):
        return [poly[0] for poly in coords
                if isinstance(poly, list) and poly and isinstance(poly[0], list) and len(poly[0]) >= 4]
    return []


def main():
    scope = load_scope()
    tfs_fires, tfs_src = collect("tfs", collect_tfs, scope)
    wfigs_fires, wfigs_src = collect("wfigs", collect_wfigs, scope)
    perims, perim_src = collect("wfigs-perimeters", collect_perimeters, scope)
    sources = [tfs_src, wfigs_src, perim_src]

    # the points layer is the board's wildfire answer; perimeters are an enrichment, so a
    # perimeter failure must not sink a good incident read. E1 keeps it visible in sources[].
    if all(s["status"] == "failed" for s in (tfs_src, wfigs_src)):
        sys.exit("gen-wildfire: no source could be read, keeping the previous file and its older stamp")

    fires = sorted(tfs_fires + wfigs_fires, key=lambda x: (x["observed"], x["id"]), reverse=True)
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    write_payload({"generated": now, "sources": sources, "fires": fires, "perimeters": perims})

    detail = " · ".join(
        f"{s['key']} {s['status']}"
        + (f" {s['count']} @ {s['captured'] or 'no upstream stamp'}" if s["status"] == "ok" else "")
        for s in sources)
    print(f"wildfire.json: {len(fires)} incidents, {len(perims)} perimeters ({detail}) @ {now}")
    # A half-sourced INCIDENT read is not a clean cycle. A failed perimeter read is not the same
    # thing: perimeters are an enrichment most fires never have, and the layer's answer is the
    # points. Spending the cycle's DEGRADED signal on it measured 2 of 15 cycles in one night,
    # which devalues that signal for the gauges and roads it exists for. The failure stays visible
    # without it: the source row publishes failed, and the client says so when the layer opens.
    if any(s["status"] != "ok" for s in (tfs_src, wfigs_src)):
        return 1
    if perim_src["status"] != "ok":
        print("note: perimeter enrichment failed; the incident layer published in full",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
