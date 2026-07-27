#!/usr/bin/env python3
"""Publish the board's curated feature set in three interchange formats.

One assembled, priority-ranked, capped feature list feeds every emitter, so the
GeoJSON, the KML and the GeoRSS always describe the same board:

  data/caltopo-export.json  GeoJSON FeatureCollection, CalTopo/SARTopo import.
                            One-shot: re-importing duplicates. Honors mapbox
                            simplestyle keys, labels from properties.title,
                            folders from CalTopo-native folder features.
  data/board.kml            KML 2.2 document, folders + styled placemarks.
  data/board-live.kml       NetworkLink onto board.kml with a refresh interval,
                            which is what makes a static file a self-updating
                            layer in Google Earth, ArcGIS and ATAK.
  data/board-georss.xml     Atom + GeoRSS-Simple, one entry per feature.

Local layers come from the committed data files; alerts and LSRs are fetched live.
Either kind failing is non-fatal: the folder drops out and the source is named in
properties.sources_unavailable, and every emitted format re-states that claim so a
missing layer never reads as an empty one. Failures exit non-zero, keeping last-good.
"""
import datetime
import hashlib
import json
import math
import os
import re
import sys
import tempfile
import urllib.request
import xml.etree.ElementTree as ET

ROOT = os.environ.get("RESPONDER_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "caltopo-export.json")
OUT_KML = os.path.join(ROOT, "data", "board.kml")
OUT_KML_LIVE = os.path.join(ROOT, "data", "board-live.kml")
OUT_GEORSS = os.path.join(ROOT, "data", "board-georss.xml")
UA = "responder-tx-ops/gen-caltopo (rfxnryan@gmail.com)"
SITE = "https://respondertx.org"

KML_NS = "http://www.opengis.net/kml/2.2"
ATOM_NS = "http://www.w3.org/2005/Atom"
GEORSS_NS = "http://www.georss.org/georss"
REFRESH_SECONDS = 900  # the data cycle's own period; a shorter poll would only re-fetch identical bytes

ALERTS_URL = "https://api.weather.gov/alerts/active?area=TX"
LSR_URL = "https://mesonet.agron.iastate.edu/geojson/lsr.geojson?hours=24&states=TX"

MAX_FEATURES = int(os.environ.get("RESPONDER_CALTOPO_MAX_FEATURES", "2000"))
# The real import ceiling is bytes, not a feature count: ArcGIS Online refuses a KML layer over
# 10 MB outright, the tightest documented limit across the consumer set. Trim to 80% of it so a
# cycle full of large alert polygons cannot cross the line mid-event.
MAX_KML_BYTES = int(os.environ.get("RESPONDER_CALTOPO_MAX_KML_BYTES", str(8 * 1024 * 1024)))
FIT_PASSES = 8
LSR_CAP = 100

# hexes mirror css/app.css dark-theme custom properties (--cat-*, --sev-*, --good, --ink-muted, --accent)
CAT_COLOR = {"action": "#fab219", "minor": "#ec835a", "moderate": "#d03b3b", "major": "#a855f7"}
CAT_NONE = "#898781"
SEV_COLOR = {"emergency": "#d03b3b", "warning": "#ec835a", "watch": "#fab219", "advisory": "#898781"}
CROSSING_COLOR = {"closed": "#d03b3b", "caution": "#fab219", "longterm": "#9ba3b8", "open": "#0ca30c"}
PRI_COLOR = {"critical": "#d03b3b", "high": "#ec835a", "medium": "#fab219", "low": "#9ba3b8"}
LSR_COLOR = "#3f7ac4"

# mirror js/sources.js HAZARD_EVENTS and js/core.js LSR_HAZARD_RE.
# tests/hazard-table.test.js asserts both sides match and that every event string still exists
# upstream; an unknown event string returns HTTP 200 with zero features rather than an error, so a
# typo on either side would publish an empty hazard set instead of failing.
HAZARD_EVENTS = {
    "Tornado Warning": ("acute", 3),
    "Extreme Wind Warning": ("acute", 8),
    "Dust Storm Warning": ("acute", 8),
    "Snow Squall Warning": ("acute", 8),
    "Severe Thunderstorm Warning": ("acute", 11),
    "Flash Flood Warning": ("acute", 7),
    "Flash Flood Statement": ("acute", 7),
    "Flood Warning": ("acute", 10),
    "Flood Statement": ("acute", 10),
    "Coastal Flood Warning": ("acute", 10),
    "Coastal Flood Statement": ("acute", 10),
    "Lakeshore Flood Warning": ("acute", 10),
    "Lakeshore Flood Statement": ("acute", 10),
    "Storm Surge Warning": ("acute", 10),
    "Hurricane Warning": ("acute", 10),
    "Hurricane Force Wind Warning": ("acute", 10),
    "Tropical Storm Warning": ("acute", 10),
    "Flash Flood Watch": ("watch", 13),
    "Flood Watch": ("watch", 13),
    "Coastal Flood Watch": ("watch", 13),
    "Lakeshore Flood Watch": ("watch", 13),
    "Storm Surge Watch": ("watch", 13),
    "Hurricane Watch": ("watch", 13),
    "Hurricane Force Wind Watch": ("watch", 13),
    "Tropical Storm Watch": ("watch", 13),
    "High Wind Watch": ("watch", 14),
    "High Wind Warning": ("standing", 17),
    "Flood Advisory": ("standing", 18),
    "Coastal Flood Advisory": ("standing", 18),
    "Lakeshore Flood Advisory": ("standing", 18),
    "Wind Advisory": ("standing", 18),
    "Lake Wind Advisory": ("standing", 18),
    "Brisk Wind Advisory": ("standing", 18),
    "Beach Hazards Statement": ("standing", 18),
    "Tropical Cyclone Local Statement": ("standing", 18),
}
LSR_HAZARD_RE = re.compile(r"FLOOD|HEAVY RAIN|DEBRIS|DAM |LANDSLIDE|RESCUE|TSTM WND|HIGH WIND|SURGE|WATERSPOUT|MARINE"
                           r"|TORNADO|FUNNEL CLOUD|HAIL|WILDFIRE|DUST STORM|SNOW SQUALL", re.I)

# mirror js/core.js cardAged: resolved, or older than the per-type aging window
AGED_CARD_MINS = 1440
AGED_CARD_MINS_BY_TYPE = {"info": 720, "volunteer": 720}

DISCLAIMER = ("Situational awareness, not a dispatch system; call 911 for emergencies. "
              "One-shot import: re-importing this file into the same CalTopo map duplicates objects.")


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc)


def parse_iso(s):
    try:
        dt = datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt


def load_json(path, default, unavailable=None, label=None):
    """A local source that EXISTS and will not read is an unavailable source, not an empty one:
    silently defaulting produced an export whose sources_unavailable list positively asserted
    nothing was missing while a whole layer had vanished. A file that is simply not there is a
    different fact, tolerated the same way cycle-check.sh tolerates it, and claims nothing."""
    full = os.path.join(ROOT, path)
    try:
        with open(full, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"note: local source {path} is absent; its layer is empty", file=sys.stderr)
        return default
    except (OSError, ValueError) as e:
        print(f"warn: local source {path} exists but did not read: {e}", file=sys.stderr)
        if unavailable is not None:
            unavailable.append(label or os.path.basename(path).rsplit(".", 1)[0])
        return default


def fetch_json(url, fixture_env):
    fixture = os.environ.get(fixture_env)
    if fixture:
        with open(fixture, encoding="utf-8") as f:
            return json.load(f)
    if os.environ.get("RESPONDER_CALTOPO_OFFLINE"):
        return None
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/geo+json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)
    except (OSError, ValueError) as e:
        print(f"warn: fetch failed {url}: {e}", file=sys.stderr)
        return None


def strip_html(s):
    return re.sub(r"<[^>]+>", " ", str(s or "")).strip()


def desc(lines, source, updated):
    parts = [str(x) for x in lines if x]
    if source:
        parts.append(f"Source: {source}")
    if updated:
        parts.append(f"Updated: {updated}")
    return "\n".join(parts)


def feature(folder_id, folder_name, geometry, title, lines, style,
            extra=None, rank=5, source=None, updated=None, key=None):
    """(rank, GeoJSON feature, meta). meta carries what GeoJSON only has prose for:
    the XML emitters need source and update time as fields, not inside a description."""
    props = {
        "class": "Marker" if geometry and geometry.get("type") == "Point" else "Shape",
        "folderId": folder_id,
        "folder": folder_name,
        "title": title,
        "description": desc(lines, source, updated),
    }
    props.update(style)
    if extra:
        props.update(extra)
    feat = {"type": "Feature", "geometry": geometry, "properties": props}
    meta = {"folder_id": folder_id, "folder": folder_name, "title": title,
            "source": source, "updated": updated,
            "key": str(key or (extra or {}).get("lid") or (extra or {}).get("id") or "")}
    return rank, feat, meta


def ring(lat, lon, radius_km=1.5, points=24):
    coords = []
    dlat = radius_km / 111.32
    dlon = radius_km / (111.32 * max(0.2, math.cos(math.radians(lat))))
    for i in range(points + 1):
        a = 2 * math.pi * i / points
        coords.append([round(lon + dlon * math.cos(a), 5), round(lat + dlat * math.sin(a), 5)])
    return {"type": "Polygon", "coordinates": [coords]}


def gauge_cat(g):
    cat = ((g.get("status") or {}).get("observed") or {}).get("floodCategory") or ""
    return cat if cat in CAT_COLOR else "none"


def build_gauges(snapshot):
    out = []
    for g in snapshot.get("gauges", []):
        lat, lon = g.get("latitude"), g.get("longitude")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        cat = gauge_cat(g)
        obs = (g.get("status") or {}).get("observed") or {}
        fc = (g.get("status") or {}).get("forecast") or {}
        stage = obs.get("primary")
        stage_txt = f"{stage} {obs.get('primaryUnit') or 'ft'}" if isinstance(stage, (int, float)) and stage > -999 else "no reading"
        lines = [f"Observed: {stage_txt} ({cat.upper() if cat != 'none' else 'no flooding'})"]
        fcrest = fc.get("primary")
        fwhen = parse_iso(fc.get("validTime"))
        if isinstance(fcrest, (int, float)) and fcrest > -999 and fwhen and fwhen.year >= 2000:
            lines.append(f"Forecast: {fcrest} {fc.get('primaryUnit') or 'ft'} ({fc.get('floodCategory')}) at {fc.get('validTime')}")
        style = {"marker-color": CAT_COLOR.get(cat, CAT_NONE),
                 "marker-size": "small" if cat == "none" else "medium"}
        out.append(feature(
            "folder-gauges", "Gauges (NOAA NWPS)",
            {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]},
            f"Gauge: {g.get('name') or g.get('lid')}" + (f" · {cat.upper()}" if cat != "none" else ""),
            lines, style, extra={"lid": g.get("lid")}, rank=8 if cat != "none" else 3,
            source=f"NOAA NWPS · https://water.noaa.gov/gauges/{g.get('lid')}",
            updated=obs.get("validTime")))
    return out


def build_crests(crest, snapshot, capture):
    # crest-summary keeps peaks from every AO this repo has published, so the display-scoped
    # snapshot alone cannot place the out-of-AO ones; the wide capture backfills their coords
    coords = {g.get("lid"): (g.get("latitude"), g.get("longitude")) for g in capture.get("gauges", [])}
    coords.update({g.get("lid"): (g.get("latitude"), g.get("longitude")) for g in snapshot.get("gauges", [])})
    out = []
    unresolved = 0
    for c in crest.get("gauges", []):
        lat, lon = coords.get(c.get("lid"), (None, None))
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            unresolved += 1
            continue
        cat = c.get("peak_category") if c.get("peak_category") in CAT_COLOR else "none"
        rec = c.get("record") or {}
        lines = [f"Peak {c.get('peak')} {c.get('unit') or 'ft'} ({str(c.get('peak_category', '')).upper()}) at {c.get('peak_time')}",
                 "Ongoing flood" if c.get("ongoing") else "Crest has passed"]
        if isinstance(rec.get("record_ft"), (int, float)):
            lines.append(f"Record: {rec['record_ft']} ft ({rec.get('record_date')})"
                         + (" · EXCEEDED" if rec.get("exceeded") else ""))
        # a peak the board rebuilt from the upstream record must not import as one it observed
        recon = c.get("src")
        if recon:
            lines.append(f"RECONSTRUCTED peak: rebuilt from the {str(recon).upper()} record for the window "
                         "before this board's own archive begins, not read from a snapshot it captured")
        cite = (f"{str(recon).upper()} record via Responder TX crest summary (reconstructed) · "
                f"{SITE}/data/crest-summary.json") if recon else \
               f"NOAA NWS/NWPS via Responder TX crest summary · {SITE}/data/crest-summary.json"
        out.append(feature(
            "folder-crests", "Crests (event peaks)",
            ring(lat, lon),
            f"Crest: {c.get('name') or c.get('lid')} · peak {c.get('peak')} {c.get('unit') or 'ft'}"
            + (" (reconstructed)" if recon else ""),
            lines,
            {"stroke": CAT_COLOR.get(cat, CAT_NONE), "stroke-width": 2, "stroke-opacity": 0.9,
             "fill": CAT_COLOR.get(cat, CAT_NONE), "fill-opacity": 0.08},
            extra={"lid": c.get("lid")}, rank=8, source=cite, updated=c.get("peak_time")))
    return out, unresolved


def alert_severity(p):
    threat = " ".join((p.get("parameters") or {}).get("flashFloodDamageThreat") or [])
    if re.search(r"FLASH FLOOD EMERGENCY", p.get("description") or "", re.I) or re.search(r"CATASTROPHIC", threat, re.I):
        return "emergency"
    if re.search(r"Warning", p.get("event") or "", re.I):
        return "warning"
    if re.search(r"Watch", p.get("event") or "", re.I):
        return "watch"
    return "advisory"


def build_alerts(gj):
    out = []
    now = now_utc()
    for f in (gj or {}).get("features", []):
        p = f.get("properties") or {}
        if (p.get("event") or "") not in HAZARD_EVENTS:
            continue
        exp = parse_iso(p.get("expires"))
        if exp and exp < now:
            continue
        geom = f.get("geometry")
        if not geom or geom.get("type") not in ("Polygon", "MultiPolygon"):
            continue  # zone-referenced alerts carry no inline geometry; dropped (lowest-value: watches/advisories)
        sev = alert_severity(p)
        out.append(feature(
            "folder-alerts", "NWS alerts (active)", geom,
            f"{p.get('event')} · {(p.get('areaDesc') or '')[:80]}",
            [p.get("headline"), f"Severity: {sev}", f"Expires: {p.get('expires')}"],
            {"stroke": SEV_COLOR[sev], "stroke-width": 2, "stroke-opacity": 0.9,
             "fill": SEV_COLOR[sev], "fill-opacity": 0.15},
            rank=9, source=f"NWS · {p.get('@id') or p.get('id') or 'https://api.weather.gov/alerts'}",
            updated=p.get("sent")))
    return out


def build_roads(roads):
    out = []
    for r in roads.get("roads", []):
        v = r.get("v")
        if not isinstance(v, list) or len(v) != 2:
            continue
        color = "#d03b3b" if r.get("cond") == "Flooding" else "#ec835a"
        out.append(feature(
            "folder-roads", "Road closures (TxDOT)",
            {"type": "Point", "coordinates": [v[1], v[0]]},
            f"{r.get('cond') or 'Closure'}: {r.get('route') or 'road'}",
            [strip_html(r.get("desc"))[:200], f"From: {r.get('start')}" if r.get("start") else None],
            {"marker-color": color, "marker-size": "medium"}, rank=7,
            source="TxDOT DriveTexas · https://drivetexas.org", updated=r.get("start")))
    return out


def build_crossings(x):
    out = []
    for c in x.get("crossings", []):
        if not isinstance(c.get("lat"), (int, float)) or not isinstance(c.get("lon"), (int, float)):
            continue
        status = c.get("status") if c.get("status") in CROSSING_COLOR else "caution"
        out.append(feature(
            "folder-crossings", "Low-water crossings",
            {"type": "Point", "coordinates": [round(c["lon"], 5), round(c["lat"], 5)]},
            f"{status.upper()}: {c.get('name')}",
            [c.get("reason")],
            {"marker-color": CROSSING_COLOR[status], "marker-size": "medium"},
            extra={"status": status}, rank=7, key=c.get("id"),
            source=c.get("source") or "Responder TX curated", updated=c.get("updated_at")))
    return out


def notice_aged(r, now):
    if r.get("status") == "resolved":
        return True
    ts = parse_iso(r.get("ts"))
    if ts is None:
        return True
    limit = AGED_CARD_MINS_BY_TYPE.get(r.get("type"), AGED_CARD_MINS)
    return (now - ts).total_seconds() / 60 > limit


def build_notices(reqs):
    out = []
    now = now_utc()
    for r in reqs.get("requests", []):
        # public export: LAN operator intakes and aged/resolved cards never ship; PII fields (contact, details) never ship
        if r.get("origin") == "operator" or notice_aged(r, now):
            continue
        if not isinstance(r.get("lat"), (int, float)) or not isinstance(r.get("lon"), (int, float)):
            continue
        pri = r.get("priority") if r.get("priority") in PRI_COLOR else "low"
        place = f"{r.get('place')} ({r.get('county')} Co.)" if r.get("county") else r.get("place")
        out.append(feature(
            "folder-notices", "Curated notices",
            {"type": "Point", "coordinates": [round(r["lon"], 5), round(r["lat"], 5)]},
            f"{str(r.get('type') or 'notice').upper()} · {pri}: {str(r.get('summary') or '')[:70]}",
            [r.get("summary"), place, f"Status: {r.get('status')}"],
            {"marker-color": PRI_COLOR[pri], "marker-size": "medium"},
            extra={"type": r.get("type"), "priority": pri, "status": r.get("status"), "id": r.get("id")},
            rank=8, source=((r.get("source") or {}).get("url")) or "Responder TX curated board",
            updated=r.get("ts")))
    return out


def build_lsrs(gj):
    out = []
    feats = [f for f in (gj or {}).get("features", [])
             if LSR_HAZARD_RE.search((f.get("properties") or {}).get("typetext") or "")]

    def valid_key(f):
        return str((f.get("properties") or {}).get("valid") or "")

    feats.sort(key=valid_key, reverse=True)
    for i, f in enumerate(feats[:LSR_CAP]):
        p = f.get("properties") or {}
        g = f.get("geometry") or {}
        if g.get("type") != "Point" or not isinstance(g.get("coordinates"), list):
            continue
        mag = f" {p.get('magnitude')} {p.get('unit') or ''}".rstrip() if p.get("magnitude") else ""
        out.append(feature(
            "folder-lsrs", "Storm reports (NWS LSR)", g,
            f"LSR: {p.get('typetext')}{mag} · {p.get('city') or ''}",
            [str(p.get("remark") or "")[:300], f"{p.get('city')}, {p.get('county')} Co. · via {p.get('source')}"],
            {"marker-color": LSR_COLOR, "marker-size": "small"},
            rank=6 if i < 30 else 2,
            source="NWS Local Storm Reports via IEM · https://mesonet.agron.iastate.edu/lsr/",
            updated=p.get("valid")))
    return out


FOLDERS = [
    ("folder-alerts", "NWS alerts (active)"),
    ("folder-crests", "Crests (event peaks)"),
    ("folder-gauges", "Gauges (NOAA NWPS)"),
    ("folder-roads", "Road closures (TxDOT)"),
    ("folder-crossings", "Low-water crossings"),
    ("folder-notices", "Curated notices"),
    ("folder-lsrs", "Storm reports (NWS LSR)"),
]

ATTRIBUTION = ("Responder TX · respondertx.org. Sources: NOAA NWS and NWPS, TxDOT DriveTexas, "
               "Iowa Environmental Mesonet, and curated local reports. Every feature names its own source.")
NO_GEOM_NOTE = "No mappable geometry in the source record; this entry carries text only."
# every format re-states this: a layer that failed to load is missing from the export, which is
# not the same claim as that layer having nothing in it
UNAVAILABLE_NOTE = ("Sources that did not answer this cycle are missing from this export rather "
                    "than empty: %s.")
UNAVAILABLE_CLAIM = "did not answer this cycle"
UNPARSED_TIME_NOTE = ("The source published no machine-readable update time, so this entry's "
                      "timestamp is the feed's own generation time, not the observation time.")


def atomic_write(path, text):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix="." + os.path.basename(path) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except Exception:  # noqa: BLE001, cleanup: drop the temp file, then re-raise
        os.unlink(tmp)
        raise


def num(v):
    s = "%.6f" % float(v)
    return s.rstrip("0").rstrip(".")


def is_pos(c):
    return isinstance(c, (list, tuple)) and len(c) >= 2 \
        and all(isinstance(x, (int, float)) for x in c[:2])


def serialize(root):
    if hasattr(ET, "indent"):
        ET.indent(root, "  ")
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root, encoding="unicode") + "\n"


# ---------- KML 2.2 ----------

MARKER_SCALE = {"small": 0.8, "medium": 1.0, "large": 1.3}


def kml_color(hex_rgb, opacity=1.0):
    """KML colors are aabbggrr, the reverse byte order of the CSS #rrggbb the board styles with."""
    h = re.sub(r"[^0-9a-f]", "", str(hex_rgb or "").lower())
    if len(h) != 6:
        h = "ffffff"
    try:
        a = max(0, min(255, int(round(float(opacity) * 255))))
    except (TypeError, ValueError):
        a = 255
    return "%02x%s%s%s" % (a, h[4:6], h[2:4], h[0:2])


def style_id(props):
    if "marker-color" in props:
        raw = "mk-%s-%s" % (kml_color(props.get("marker-color")), props.get("marker-size") or "medium")
    else:
        raw = "sh-%s-%s-%s" % (kml_color(props.get("stroke"), props.get("stroke-opacity", 1)),
                              kml_color(props.get("fill"), props.get("fill-opacity", 0)),
                              props.get("stroke-width") or 2)
    return re.sub(r"[^A-Za-z0-9_-]", "-", raw)


def kml_style(sid, props):
    st = ET.Element("Style", {"id": sid})
    if "marker-color" in props:
        # no <Icon><href>: the client's own default pin is tinted, so the feed pulls no external image
        icon = ET.SubElement(st, "IconStyle")
        ET.SubElement(icon, "color").text = kml_color(props.get("marker-color"))
        ET.SubElement(icon, "scale").text = str(MARKER_SCALE.get(props.get("marker-size"), 1.0))
    else:
        ln = ET.SubElement(st, "LineStyle")
        ET.SubElement(ln, "color").text = kml_color(props.get("stroke"), props.get("stroke-opacity", 1))
        ET.SubElement(ln, "width").text = str(props.get("stroke-width") or 2)
        po = ET.SubElement(st, "PolyStyle")
        ET.SubElement(po, "color").text = kml_color(props.get("fill"), props.get("fill-opacity", 0))
        ET.SubElement(po, "fill").text = "1" if float(props.get("fill-opacity") or 0) > 0 else "0"
        ET.SubElement(po, "outline").text = "1"
    return st


def kml_coords(seq):
    return " ".join("%s,%s" % (num(c[0]), num(c[1])) for c in seq if is_pos(c))


def kml_polygon(rings):
    e = ET.Element("Polygon")
    ET.SubElement(e, "tessellate").text = "1"
    for i, r in enumerate(rings or []):
        txt = kml_coords(r or [])
        if not txt:
            continue
        boundary = ET.SubElement(e, "outerBoundaryIs" if i == 0 else "innerBoundaryIs")
        ET.SubElement(ET.SubElement(boundary, "LinearRing"), "coordinates").text = txt
    return e if len(e) > 1 else None


MULTI_PART = {"MultiPoint": "Point", "MultiLineString": "LineString", "MultiPolygon": "Polygon"}


def kml_geometry(geom):
    """KML element for a GeoJSON geometry, or None when nothing mappable survives."""
    t = (geom or {}).get("type")
    c = (geom or {}).get("coordinates")
    if t == "Point":
        if not is_pos(c):
            return None
        e = ET.Element("Point")
        ET.SubElement(e, "coordinates").text = "%s,%s" % (num(c[0]), num(c[1]))
        return e
    if t == "LineString":
        txt = kml_coords(c or [])
        if not txt:
            return None
        e = ET.Element("LineString")
        ET.SubElement(e, "tessellate").text = "1"
        ET.SubElement(e, "coordinates").text = txt
        return e
    if t == "Polygon":
        return kml_polygon(c)
    if t in MULTI_PART or t == "GeometryCollection":
        if t == "GeometryCollection":
            parts = [kml_geometry(g) for g in (geom.get("geometries") or [])]
        else:
            parts = [kml_geometry({"type": MULTI_PART[t], "coordinates": p}) for p in (c or [])]
        parts = [p for p in parts if p is not None]
        if not parts:
            return None
        if len(parts) == 1:
            return parts[0]
        e = ET.Element("MultiGeometry")
        for p in parts:
            e.append(p)
        return e
    return None


def build_kml(members, metas, header):
    """(document text, count of features with no mappable geometry). Returns text rather than
    writing, so the caller can weigh the emitted bytes against the import ceiling before publishing."""
    root = ET.Element("kml", {"xmlns": KML_NS})
    doc = ET.SubElement(root, "Document")
    ET.SubElement(doc, "name").text = header["title"]
    ET.SubElement(doc, "open").text = "1"
    ET.SubElement(doc, "description").text = header["note"] + "\n" + ATTRIBUTION

    styles = {}
    for f in members:
        sid = style_id(f["properties"])
        styles.setdefault(sid, kml_style(sid, f["properties"]))
    for sid in sorted(styles):
        doc.append(styles[sid])

    ext = ET.SubElement(doc, "ExtendedData")
    for k in ("generated", "features", "candidates", "cap", "truncated", "dropped"):
        ET.SubElement(ET.SubElement(ext, "Data", {"name": k}), "value").text = str(header[k])
    ET.SubElement(ET.SubElement(ext, "Data", {"name": "sources_unavailable"}), "value").text = \
        ",".join(header.get("unavailable") or ())
    ET.SubElement(ET.SubElement(ext, "Data", {"name": "attribution"}), "value").text = ATTRIBUTION

    unmapped = 0
    for fid, fname in FOLDERS:
        rows = [(f, m) for f, m in zip(members, metas) if m["folder_id"] == fid]
        if not rows:
            continue
        folder = ET.SubElement(doc, "Folder")
        ET.SubElement(folder, "name").text = fname
        ET.SubElement(folder, "open").text = "0"
        for f, m in rows:
            geom = kml_geometry(f.get("geometry"))
            body = f["properties"].get("description") or ""
            if geom is None:
                unmapped += 1
                body = (body + "\n" + NO_GEOM_NOTE).strip()
            pm = ET.SubElement(folder, "Placemark")
            ET.SubElement(pm, "name").text = m["title"]
            ET.SubElement(pm, "description").text = body
            ET.SubElement(pm, "styleUrl").text = "#" + style_id(f["properties"])
            # source and update time also ride as fields, not just prose, so a client that
            # renders ExtendedData as a table shows provenance without parsing the balloon.
            # No <TimeStamp>: it would arm Google Earth's time slider and hide features behind it.
            ed = ET.SubElement(pm, "ExtendedData")
            for k, v in (("folder", fname), ("source", m.get("source")), ("updated", m.get("updated"))):
                if v:
                    ET.SubElement(ET.SubElement(ed, "Data", {"name": k}), "value").text = str(v)
            if geom is not None:
                pm.append(geom)
    return serialize(root), unmapped


def write_kml_networklink(path, header):
    root = ET.Element("kml", {"xmlns": KML_NS})
    doc = ET.SubElement(root, "Document")
    ET.SubElement(doc, "name").text = "Responder TX live map"
    unavailable = header.get("unavailable") or ()
    ET.SubElement(doc, "description").text = (
        "Self-updating link to the Responder TX board. The linked document is re-fetched every "
        f"{REFRESH_SECONDS // 60} minutes, which is how often the board republishes. "
        + DISCLAIMER.split(" One-shot")[0] + " "
        + ((UNAVAILABLE_NOTE % ", ".join(unavailable)) + " " if unavailable else "")
        + ATTRIBUTION)
    nl = ET.SubElement(doc, "NetworkLink")
    ET.SubElement(nl, "name").text = "Responder TX board"
    ET.SubElement(nl, "open").text = "1"
    ET.SubElement(nl, "refreshVisibility").text = "0"
    ET.SubElement(nl, "flyToView").text = "0"
    link = ET.SubElement(nl, "Link")
    ET.SubElement(link, "href").text = f"{SITE}/data/board.kml"
    ET.SubElement(link, "refreshMode").text = "onInterval"
    ET.SubElement(link, "refreshInterval").text = str(REFRESH_SECONDS)
    atomic_write(path, serialize(root))


# ---------- GeoRSS-Simple over Atom ----------

def ring_area(ring):
    a = 0.0
    pts = [c for c in (ring or []) if is_pos(c)]
    for i in range(len(pts) - 1):
        a += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1]
    return abs(a) / 2


def georss_coords(seq):
    """GeoRSS-Simple is whitespace-separated "lat lon" pairs, the reverse of GeoJSON's [lon, lat]."""
    return " ".join("%s %s" % (num(c[1]), num(c[0])) for c in seq if is_pos(c))


def georss_ring(coords):
    """OGC 17-002r1: a georss:polygon SHALL carry at least four pairs and close on the first."""
    pts = [c for c in (coords or []) if is_pos(c)]
    if len(pts) >= 3 and (pts[0][0], pts[0][1]) != (pts[-1][0], pts[-1][1]):
        pts.append(pts[0])
    return georss_coords(pts) if len(pts) >= 4 else ""


def georss_path(coords):
    """OGC 17-002r1: a georss:line SHALL carry at least two pairs."""
    pts = [c for c in (coords or []) if is_pos(c)]
    return georss_coords(pts) if len(pts) >= 2 else ""


def georss_geometry(geom):
    """(tag, text, note) in GeoRSS-Simple, which has only point, line, polygon and box:
    no multi-part and no hole syntax. Multi-part shapes degrade to their largest part and
    say so, because a georss:box would claim ground the alert does not cover and dropping
    them silently is the same defect in a new syntax."""
    t = (geom or {}).get("type")
    c = (geom or {}).get("coordinates")
    if t == "Point":
        return ("georss:point", "%s %s" % (num(c[1]), num(c[0])), "") if is_pos(c) else (None, None, "")
    if t == "LineString":
        txt = georss_path(c)
        return ("georss:line", txt, "") if txt else (None, None, "")
    if t == "Polygon":
        rings = [r for r in (c or []) if georss_ring(r)]
        if not rings:
            return (None, None, "")
        note = ("" if len(rings) == 1 else
                "Outline simplified for this feed: %d interior hole(s) are not represented. "
                "The KML and GeoJSON carry the full shape." % (len(rings) - 1))
        return "georss:polygon", georss_ring(rings[0]), note
    if t == "MultiPolygon":
        polys = [p for p in (c or []) if p and georss_ring(p[0])]
        if not polys:
            return (None, None, "")
        best = max(polys, key=lambda p: ring_area(p[0]))
        note = ("" if len(polys) == 1 else
                "Outline simplified for this feed: the largest of %d separate parts is shown. "
                "The KML and GeoJSON carry all of them." % len(polys))
        return "georss:polygon", georss_ring(best[0]), note
    if t == "MultiLineString":
        lines = [ln for ln in (c or []) if georss_path(ln)]
        if not lines:
            return (None, None, "")
        best = max(lines, key=len)
        note = ("" if len(lines) == 1 else
                "Geometry simplified for this feed: the longest of %d segments is shown. "
                "The KML and GeoJSON carry all of them." % len(lines))
        return "georss:line", georss_path(best), note
    if t == "MultiPoint":
        pts = [p for p in (c or []) if is_pos(p)]
        if not pts:
            return (None, None, "")
        note = ("" if len(pts) == 1 else
                "Geometry simplified for this feed: the first of %d points is shown. "
                "The KML and GeoJSON carry all of them." % len(pts))
        return "georss:point", "%s %s" % (num(pts[0][1]), num(pts[0][0])), note
    if t == "GeometryCollection":
        for g in (geom.get("geometries") or []):
            tag, txt, _ = georss_geometry(g)
            if tag:
                return tag, txt, ("Geometry simplified for this feed: one part of a collection is shown. "
                                  "The KML and GeoJSON carry all of them.")
    return None, None, ""


def atom_time(value, fallback):
    """(RFC 3339 stamp, was_guessed). NWPS publishes 0001-01-01 for "no reading", which is a
    sentinel rather than an observation time and which strftime cannot even render as RFC 3339."""
    dt = parse_iso(value)
    if dt is None or dt.year < 2000:
        return fallback, True
    return dt.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), False


def entry_id(meta, feat):
    key = meta.get("key")
    if not key:
        seed = (meta.get("title") or "") + "|" + json.dumps(feat.get("geometry"), sort_keys=True)
        key = hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]  # identity only, not a security digest
    return "tag:respondertx.org,2026:%s:%s" % (meta["folder_id"], re.sub(r"[^A-Za-z0-9._-]", "-", str(key))[:64])


def write_georss(members, metas, header, path):
    root = ET.Element("feed", {"xmlns": ATOM_NS, "xmlns:georss": GEORSS_NS})
    ET.SubElement(root, "title").text = header["title"]
    ET.SubElement(root, "subtitle").text = header["note"]
    ET.SubElement(root, "id").text = header["georss_url"]
    ET.SubElement(root, "link", {"rel": "self", "type": "application/atom+xml", "href": header["georss_url"]})
    ET.SubElement(root, "link", {"rel": "alternate", "type": "text/html", "href": SITE + "/"})
    ET.SubElement(root, "updated").text = header["generated"]
    ET.SubElement(root, "rights").text = ATTRIBUTION
    ET.SubElement(ET.SubElement(root, "author"), "name").text = "Responder TX"
    ET.SubElement(root, "generator", {"uri": SITE}).text = "Responder TX board"

    simplified = 0
    for f, m in zip(members, metas):
        tag, txt, note = georss_geometry(f.get("geometry"))
        body = f["properties"].get("description") or ""
        if note:
            simplified += 1
        if tag is None:
            note = (note + " " + NO_GEOM_NOTE).strip()
        stamp, guessed = atom_time(m.get("updated"), header["generated"])
        if guessed:
            note = (note + " " + UNPARSED_TIME_NOTE).strip()
        entry = ET.SubElement(root, "entry")
        ET.SubElement(entry, "title").text = m["title"]
        ET.SubElement(entry, "id").text = entry_id(m, f)
        ET.SubElement(entry, "updated").text = stamp
        ET.SubElement(entry, "link", {"rel": "alternate", "type": "text/html", "href": SITE + "/"})
        ET.SubElement(entry, "category", {"term": m["folder"]})
        ET.SubElement(entry, "summary", {"type": "text"}).text = (body + ("\n" + note if note else "")).strip()
        if tag:
            ET.SubElement(entry, tag).text = txt
    atomic_write(path, serialize(root))
    return simplified


# ---------- assembly ----------

def trim_ranked(ranked, keep):
    """(kept, dropped) highest rank first. Only sorts when a bound actually bites, so the ordinary
    cycle that publishes every candidate keeps its source order."""
    if len(ranked) <= keep:
        return ranked, 0
    ordered = sorted(ranked, key=lambda rf: rf[0], reverse=True)  # stable: source order within a rank
    return ordered[:keep], len(ranked) - keep


def build_header(event, kept_n, total, now, bound, unavailable=()):
    """Header shared by all three emitters. bound names which limit did the cutting, because
    "capped at 2000 features" is a false explanation when it was the byte ceiling that cut."""
    dropped = total - kept_n
    partial = (f" (partial: {kept_n} of {total} features, lowest-priority dropped first)"
               if dropped else "")
    note = DISCLAIMER
    if dropped:
        limit = (f"{MAX_KML_BYTES // 1048576} MB of KML so it stays importable"
                 if bound == "size" else f"{MAX_FEATURES} features")
        note += (f" This export is capped at {limit} and {dropped} lower-priority features were "
                 "dropped; every alert, crest, closure and in-flood gauge is kept before any "
                 "quiet gauge.")
    if unavailable:
        note += " " + UNAVAILABLE_NOTE % ", ".join(unavailable)
    name = event.get("name") or "Responder TX"
    return {
        "unavailable": list(unavailable),
        "title": f"{name} · live map{partial}",
        "geojson_title": f"{name} · CalTopo export{partial}",
        "note": note,
        "generated": now,
        "features": kept_n,
        "candidates": total,
        "cap": MAX_FEATURES,
        "truncated": dropped > 0,
        "dropped": dropped,
        "georss_url": f"{SITE}/data/board-georss.xml",
    }


def fit_to_ceiling(ranked, event, now, unavailable=()):
    """(kept, header, kml text, unmapped). Applies the feature cap, then trims by the same rank
    order until the emitted KML fits MAX_KML_BYTES, re-stating the truncation claim each pass."""
    kept, dropped = trim_ranked(ranked, MAX_FEATURES)
    bound = "cap" if dropped else ""
    for _ in range(FIT_PASSES):
        header = build_header(event, len(kept), len(ranked), now, bound, unavailable)
        text, unmapped = build_kml([f for _, f, _ in kept], [m for _, _, m in kept], header)
        if len(text.encode("utf-8")) <= MAX_KML_BYTES or len(kept) <= 1:
            return kept, header, text, unmapped
        # proportional step with a margin: converges in two or three passes rather than one at a time
        target = max(1, int(len(kept) * MAX_KML_BYTES / len(text.encode("utf-8")) * 0.95))
        kept, _ = trim_ranked(kept, target)
        bound = "size"
    return kept, header, text, unmapped


# ---------- emitted-artifact gate ----------

def verify_feeds(expected, header):
    """Re-read what was just written. A feed that does not parse, or that carries a different
    feature count than the GeoJSON, must fail the cycle rather than publish over last-good."""
    kml = ET.parse(OUT_KML).getroot()
    ns = {"k": KML_NS, "a": ATOM_NS, "g": GEORSS_NS}
    placemarks = kml.findall(".//k:Placemark", ns)
    if len(placemarks) != expected:
        raise ValueError("board.kml carries %d placemarks, the GeoJSON export %d" % (len(placemarks), expected))
    defined = {s.get("id") for s in kml.findall(".//k:Style", ns)}
    for pm in placemarks:
        ref = (pm.findtext("k:styleUrl", "", ns) or "").lstrip("#")
        if ref not in defined:
            raise ValueError("board.kml placemark references undefined style %r" % ref)
    link = ET.parse(OUT_KML_LIVE).getroot()
    if link.findtext(".//k:Link/k:refreshMode", "", ns) != "onInterval":
        raise ValueError("board-live.kml carries no onInterval refresh; it would not self-update")

    feed = ET.parse(OUT_GEORSS).getroot()
    entries = feed.findall("a:entry", ns)
    if len(entries) != expected:
        raise ValueError("board-georss.xml carries %d entries, the GeoJSON export %d" % (len(entries), expected))
    rfc3339 = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$")
    for el in [feed.find("a:updated", ns)] + feed.findall("a:entry/a:updated", ns):
        if el is None or not rfc3339.match(el.text or ""):
            raise ValueError("board-georss.xml has an Atom timestamp that is not RFC 3339: %r"
                             % (el is not None and el.text))
    # OGC 17-002r1 minimums, checked on what was written rather than on what was intended
    for tag, least in (("point", 2), ("line", 4), ("polygon", 8)):
        for el in feed.findall(".//g:" + tag, ns):
            vals = (el.text or "").split()
            if len(vals) < least or len(vals) % 2 or any(not re.match(r"^-?\d+(\.\d+)?$", v) for v in vals):
                raise ValueError("board-georss.xml georss:%s is not %d+ lat/lon pairs: %r"
                                 % (tag, least // 2, el.text))
            if any(abs(float(v)) > 90 for v in vals[0::2]) or any(abs(float(v)) > 180 for v in vals[1::2]):
                raise ValueError("board-georss.xml georss:%s is out of range; lat/lon may be swapped" % tag)
            if tag == "polygon" and vals[:2] != vals[-2:]:
                raise ValueError("board-georss.xml georss:polygon does not close on its first pair")

    # fit_to_ceiling already trims to MAX_KML_BYTES, so this only fires if the passes ran out on a
    # single oversized geometry. Warn rather than fail: withholding the whole cycle over one
    # consumer's ceiling would cost more than the layer it protects.
    kml_bytes = os.path.getsize(OUT_KML)
    if kml_bytes > MAX_KML_BYTES:
        print("warn: board.kml is %.1f MB, over the %.0f MB import budget; ArcGIS Online refuses a "
              "KML layer over 10 MB" % (kml_bytes / 1048576.0, MAX_KML_BYTES / 1048576.0),
              file=sys.stderr)
    if header["truncated"]:
        for label, text in (("board.kml", kml.findtext(".//k:Document/k:name", "", ns)),
                            ("board-georss.xml", feed.findtext("a:title", "", ns))):
            if "partial" not in (text or ""):
                raise ValueError("%s is truncated but its title makes no partial claim" % label)

    # the unavailable-sources claim is all-or-none across the formats. It reached only the GeoJSON
    # once, so three published artifacts read as complete boards while a whole layer was missing.
    unavailable = header.get("unavailable") or []
    with open(OUT, encoding="utf-8") as f:
        geo_props = (json.load(f).get("properties") or {})
    listed = geo_props.get("sources_unavailable")
    if listed != unavailable:
        raise ValueError("caltopo-export.json lists sources_unavailable %r, the run found %r"
                         % (listed, unavailable))
    ext = {d.get("name"): (d.findtext("k:value", "", ns) or "")
           for d in kml.findall(".//k:Document/k:ExtendedData/k:Data", ns)}
    carried = {
        "caltopo-export.json": geo_props.get("note") or "",
        "board.kml": kml.findtext(".//k:Document/k:description", "", ns) or "",
        "board-live.kml": ET.parse(OUT_KML_LIVE).getroot().findtext(".//k:Document/k:description", "", ns) or "",
        "board-georss.xml": feed.findtext("a:subtitle", "", ns) or "",
    }
    for label, text in carried.items():
        claims = UNAVAILABLE_CLAIM in text
        if claims != bool(unavailable):
            raise ValueError("%s %s an unavailable-sources claim; the run found %r"
                             % (label, "makes" if claims else "makes no", unavailable))
        if claims and not all(name in text for name in unavailable):
            raise ValueError("%s claims sources unavailable but does not name all of %r"
                             % (label, unavailable))
    if ext.get("sources_unavailable") != ",".join(unavailable):
        raise ValueError("board.kml ExtendedData sources_unavailable is %r, the run found %r"
                         % (ext.get("sources_unavailable"), unavailable))


def main():
    unavailable = []
    snapshot = load_json("data/gauges-snapshot.json", {"gauges": []}, unavailable, "gauges")
    capture = load_json("data/gauges-capture.json", {"gauges": []}, unavailable, "gauges-capture")
    crest = load_json("data/crest-summary.json", {"gauges": []}, unavailable, "crest-summary")
    roads = load_json("data/roads-snapshot.json", {"roads": []}, unavailable, "roads")
    crossings = load_json("data/crossings.json", {"crossings": []}, unavailable, "crossings")
    reqs = load_json("data/requests.json", {"requests": []}, unavailable, "notices")
    event = load_json("data/event.json", {}, unavailable, "event-config")

    alerts_gj = fetch_json(ALERTS_URL, "RESPONDER_CALTOPO_ALERTS_FILE")
    if alerts_gj is None:
        unavailable.append("nws-alerts")
    lsr_gj = fetch_json(LSR_URL, "RESPONDER_CALTOPO_LSRS_FILE")
    if lsr_gj is None:
        unavailable.append("iem-lsr")

    crest_feats, crests_unresolved = build_crests(crest, snapshot, capture)
    ranked = (build_alerts(alerts_gj) + crest_feats + build_gauges(snapshot)
              + build_roads(roads) + build_crossings(crossings) + build_notices(reqs) + build_lsrs(lsr_gj))

    now = now_utc().strftime("%Y-%m-%dT%H:%M:%SZ")
    kept, header, kml_text, unmapped = fit_to_ceiling(ranked, event, now, unavailable)
    dropped = header["dropped"]

    members = [f for _, f, _ in kept]
    metas = [m for _, _, m in kept]
    counts = {}
    for f in members:
        counts[f["properties"]["folder"]] = counts.get(f["properties"]["folder"], 0) + 1

    folder_feats = [{"type": "Feature", "id": fid, "geometry": None,
                     "properties": {"class": "Folder", "title": name, "labelVisible": True}}
                    for fid, name in FOLDERS if any(f["properties"]["folderId"] == fid for f in members)]

    # a truncated export must say so in the artifact itself: whoever imports the URL into CalTopo
    # never sees our share sheet, and the title is the one string CalTopo always shows them
    doc = {
        "type": "FeatureCollection",
        "properties": {
            "title": header["geojson_title"],
            "generated": now,
            "note": header["note"],
            "import_url": f"{SITE}/data/caltopo-export.json",
            "kml_url": f"{SITE}/data/board.kml",
            "kml_live_url": f"{SITE}/data/board-live.kml",
            "georss_url": f"{SITE}/data/board-georss.xml",
            "counts": counts,
            "candidates": header["candidates"],
            "cap": MAX_FEATURES,
            "truncated": header["truncated"],
            "dropped": dropped,
            "crests_unresolved": crests_unresolved,
            "sources_unavailable": unavailable,
        },
        "features": folder_feats + members,
    }
    atomic_write(OUT, json.dumps(doc, separators=(",", ":")))

    # the XML feeds re-state the same truncation claim: a KML that quietly drops 200 features is
    # the same defect the GeoJSON title was fixed to stop, only in another syntax
    atomic_write(OUT_KML, kml_text)
    write_kml_networklink(OUT_KML_LIVE, header)
    simplified = write_georss(members, metas, header, OUT_GEORSS)
    verify_feeds(len(members), header)

    print(f"caltopo-export.json: {len(members)} features in {len(folder_feats)} folders "
          f"(dropped {dropped}, crests unresolved {crests_unresolved}, "
          f"unavailable: {','.join(unavailable) or 'none'}) @ {now}")
    print(f"board.kml + board-live.kml + board-georss.xml: {len(members)} features "
          f"(kml {os.path.getsize(OUT_KML) / 1048576.0:.2f} MB of a "
          f"{MAX_KML_BYTES / 1048576.0:.0f} MB budget, unmapped {unmapped}, "
          f"georss simplified {simplified})")


if __name__ == "__main__":
    main()
