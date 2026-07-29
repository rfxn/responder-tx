#!/usr/bin/env python3
"""Poll active wildfire incidents to data/wildfire.json.

Two independent sources: Texas A&M Forest Service (in-state, the only feed that carries live
Texas wildfire content) and NIFC WFIGS incident locations for the area around the AO. WFIGS
records whose point of origin is Texas are dropped, because TFS is authoritative in-state and a
duplicate would double-count the same fire.

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
EVENT = os.path.join(ROOT, "data", "event.json")
UA = "responder-tx-ops/gen-wildfire (rfxnryan@gmail.com)"

TFS_URL = "https://tfswildfires.com/public/api/incidents"
WFIGS_LAYER = ("https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services"
               "/WFIGS_Incident_Locations_Current/FeatureServer/0")
SOURCES = {
    "tfs": {"name": "Texas A&M Forest Service", "url": "https://tfswildfires.com/public/"},
    "wfigs": {"name": "National Interagency Fire Center (WFIGS)",
              "url": "https://data-nifc.opendata.arcgis.com/"},
}

# event-neutral Texas-wide fallback, mirrors js/core.js CONFIG.gaugeBbox
DEFAULT_BBOX = {"xmin": -106.65, "ymin": 25.83, "xmax": -93.4, "ymax": 36.5}
MARGIN = 0.5
# both endpoints answer healthy in well under a second, so a short deadline plus retries beats one
# long wait on a hang
TIMEOUT = 12
BACKOFFS = [2, 5]
PAGE = 1000
MAX_PAGES = 4
WFIGS_FIELDS = ("IncidentName,POOState,POOCounty,IncidentSize,PercentContained,"
                "ModifiedOnDateTime_dt,FireDiscoveryDateTime,UniqueFireIdentifier,"
                "POOProtectingAgency,IncidentTypeCategory")
WFIGS_WHERE = "IncidentTypeCategory='WF' AND FireOutDateTime IS NULL"


def ao_bbox():
    try:
        with open(EVENT, encoding="utf-8") as f:
            b = json.load(f).get("gaugeBbox") or {}
        if all(isinstance(b.get(k), (int, float)) for k in ("xmin", "ymin", "xmax", "ymax")):
            return b
    except Exception as e:  # noqa: BLE001 — a broken event.json must not kill the poller; the fallback matches core.js
        print(f"warn: event.json bbox unreadable, using default: {e}", file=sys.stderr)
    return DEFAULT_BBOX


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


def in_bbox(lat, lon, b):
    return (b["xmin"] - MARGIN <= lon <= b["xmax"] + MARGIN
            and b["ymin"] - MARGIN <= lat <= b["ymax"] + MARGIN)


def collect_tfs(b):
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
            if not in_bbox(pt[0], pt[1], b):
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


def collect_wfigs(b):
    """(fires, captured). Raises on a failed or truncated read: a short set read as complete
    invents an absence."""
    raw = []
    for page in range(MAX_PAGES):
        params = urllib.parse.urlencode({
            "where": WFIGS_WHERE,
            "geometry": (f"{b['xmin'] - MARGIN},{b['ymin'] - MARGIN},"
                         f"{b['xmax'] + MARGIN},{b['ymax'] + MARGIN}"),
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
            if not in_bbox(pt[0], pt[1], b):
                continue
            fires.append({
                "id": "wfigs:%s" % fid,
                "src": "wfigs",
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
            })
        except Exception as e:  # noqa: BLE001 — one malformed feature must not drop the whole poll
            print(f"warn: skipped malformed WFIGS feature: {e!r}", file=sys.stderr)
    return fires, wfigs_captured()


def collect(key, fn, b):
    try:
        fires, captured = fn(b)
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


def main():
    b = ao_bbox()
    tfs_fires, tfs_src = collect("tfs", collect_tfs, b)
    wfigs_fires, wfigs_src = collect("wfigs", collect_wfigs, b)
    sources = [tfs_src, wfigs_src]

    if all(s["status"] == "failed" for s in sources):
        sys.exit("gen-wildfire: no source could be read, keeping the previous file and its older stamp")

    fires = sorted(tfs_fires + wfigs_fires, key=lambda x: (x["observed"], x["id"]), reverse=True)
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    write_payload({"generated": now, "sources": sources, "fires": fires})

    detail = " · ".join(
        f"{s['key']} {s['status']}"
        + (f" {s['count']} @ {s['captured'] or 'no upstream stamp'}" if s["status"] == "ok" else "")
        for s in sources)
    print(f"wildfire.json: {len(fires)} incidents ({detail}) @ {now}")
    # a half-sourced file is published but is not a clean cycle
    return 0 if all(s["status"] == "ok" for s in sources) else 1


if __name__ == "__main__":
    sys.exit(main())
