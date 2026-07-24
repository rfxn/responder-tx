#!/usr/bin/env python3
"""Publish data/caltopo-export.json: a CalTopo/SARTopo-importable FeatureCollection.

Curated multi-layer export refreshed each cycle and served at a stable public URL.
CalTopo's GeoJSON import honors mapbox simplestyle keys (marker-color/-size,
stroke, fill), takes the object label from properties.title (name/id show N/A),
and restores folders from CalTopo-native folder features (class Folder + folderId).
One-shot import semantics: re-importing duplicates; CalTopo does not poll this URL.

Local layers come from the committed data files; alerts and LSRs are fetched live
(non-fatal: a failed source drops its folder and is listed in
properties.sources_unavailable). Failures exit non-zero, keeping last-good.
"""
import datetime
import json
import math
import os
import re
import sys
import tempfile
import urllib.request

ROOT = os.environ.get("RESPONDER_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "caltopo-export.json")
UA = "responder-tx-ops/gen-caltopo (rfxnryan@gmail.com)"
SITE = "https://respondertx.org"

ALERTS_URL = "https://api.weather.gov/alerts/active?area=TX"
LSR_URL = "https://mesonet.agron.iastate.edu/geojson/lsr.geojson?hours=24&states=TX"

MAX_FEATURES = int(os.environ.get("RESPONDER_CALTOPO_MAX_FEATURES", "500"))
LSR_CAP = 100

# hexes mirror css/app.css dark-theme custom properties (--cat-*, --sev-*, --good, --ink-muted, --accent)
CAT_COLOR = {"action": "#fab219", "minor": "#ec835a", "moderate": "#d03b3b", "major": "#a855f7"}
CAT_NONE = "#898781"
SEV_COLOR = {"emergency": "#d03b3b", "warning": "#ec835a", "watch": "#fab219", "advisory": "#898781"}
CROSSING_COLOR = {"closed": "#d03b3b", "caution": "#fab219", "longterm": "#9ba3b8", "open": "#0ca30c"}
PRI_COLOR = {"critical": "#d03b3b", "high": "#ec835a", "medium": "#fab219", "low": "#9ba3b8"}
LSR_COLOR = "#3f7ac4"

# mirror js/sources.js HAZARD_ALERT_RE and js/core.js LSR_FLOOD_RE
HAZARD_ALERT_RE = re.compile(r"flood|storm surge|tropical|hurricane|high wind|wind advisory|beach hazard", re.I)
LSR_FLOOD_RE = re.compile(r"FLOOD|HEAVY RAIN|DEBRIS|DAM |LANDSLIDE|RESCUE|TSTM WND|HIGH WIND|SURGE|WATERSPOUT|MARINE", re.I)

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


def load_json(path, default):
    try:
        with open(os.path.join(ROOT, path), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
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


def feature(folder_id, folder_name, geometry, title, description, style, extra=None, rank=5):
    props = {
        "class": "Marker" if geometry and geometry.get("type") == "Point" else "Shape",
        "folderId": folder_id,
        "folder": folder_name,
        "title": title,
        "description": description,
    }
    props.update(style)
    if extra:
        props.update(extra)
    return rank, {"type": "Feature", "geometry": geometry, "properties": props}


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
            desc(lines, f"NOAA NWPS · https://water.noaa.gov/gauges/{g.get('lid')}", obs.get("validTime")),
            style, extra={"lid": g.get("lid")}, rank=8 if cat != "none" else 3))
    return out


def build_crests(crest, snapshot):
    coords = {g.get("lid"): (g.get("latitude"), g.get("longitude")) for g in snapshot.get("gauges", [])}
    out = []
    for c in crest.get("gauges", []):
        lat, lon = coords.get(c.get("lid"), (None, None))
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        cat = c.get("peak_category") if c.get("peak_category") in CAT_COLOR else "none"
        rec = c.get("record") or {}
        lines = [f"Peak {c.get('peak')} {c.get('unit') or 'ft'} ({str(c.get('peak_category', '')).upper()}) at {c.get('peak_time')}",
                 "Ongoing flood" if c.get("ongoing") else "Crest has passed"]
        if isinstance(rec.get("record_ft"), (int, float)):
            lines.append(f"Record: {rec['record_ft']} ft ({rec.get('record_date')})"
                         + (" · EXCEEDED" if rec.get("exceeded") else ""))
        out.append(feature(
            "folder-crests", "Crests (event peaks)",
            ring(lat, lon),
            f"Crest: {c.get('name') or c.get('lid')} · peak {c.get('peak')} {c.get('unit') or 'ft'}",
            desc(lines, f"NOAA NWS/NWPS via Responder TX crest summary · {SITE}/data/crest-summary.json",
                 c.get("peak_time")),
            {"stroke": CAT_COLOR.get(cat, CAT_NONE), "stroke-width": 2, "stroke-opacity": 0.9,
             "fill": CAT_COLOR.get(cat, CAT_NONE), "fill-opacity": 0.08},
            extra={"lid": c.get("lid")}, rank=8))
    return out


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
        if not HAZARD_ALERT_RE.search(p.get("event") or ""):
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
            desc([p.get("headline"), f"Severity: {sev}", f"Expires: {p.get('expires')}"],
                 f"NWS · {p.get('@id') or p.get('id') or 'https://api.weather.gov/alerts'}", p.get("sent")),
            {"stroke": SEV_COLOR[sev], "stroke-width": 2, "stroke-opacity": 0.9,
             "fill": SEV_COLOR[sev], "fill-opacity": 0.15},
            rank=9))
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
            desc([strip_html(r.get("desc"))[:200], f"From: {r.get('start')}" if r.get("start") else None],
                 "TxDOT DriveTexas · https://drivetexas.org", r.get("start")),
            {"marker-color": color, "marker-size": "medium"}, rank=7))
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
            desc([c.get("reason")], c.get("source") or "Responder TX curated", c.get("updated_at")),
            {"marker-color": CROSSING_COLOR[status], "marker-size": "medium"},
            extra={"status": status}, rank=7))
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
            desc([r.get("summary"), place, f"Status: {r.get('status')}"],
                 ((r.get("source") or {}).get("url")) or "Responder TX curated board", r.get("ts")),
            {"marker-color": PRI_COLOR[pri], "marker-size": "medium"},
            extra={"type": r.get("type"), "priority": pri, "status": r.get("status"), "id": r.get("id")},
            rank=8))
    return out


def build_lsrs(gj):
    out = []
    feats = [f for f in (gj or {}).get("features", [])
             if LSR_FLOOD_RE.search((f.get("properties") or {}).get("typetext") or "")]

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
            desc([str(p.get("remark") or "")[:300], f"{p.get('city')}, {p.get('county')} Co. · via {p.get('source')}"],
                 "NWS Local Storm Reports via IEM · https://mesonet.agron.iastate.edu/lsr/", p.get("valid")),
            {"marker-color": LSR_COLOR, "marker-size": "small"},
            rank=6 if i < 30 else 2))
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


def main():
    snapshot = load_json("data/gauges-snapshot.json", {"gauges": []})
    crest = load_json("data/crest-summary.json", {"gauges": []})
    roads = load_json("data/roads-snapshot.json", {"roads": []})
    crossings = load_json("data/crossings.json", {"crossings": []})
    reqs = load_json("data/requests.json", {"requests": []})
    event = load_json("data/event.json", {})

    unavailable = []
    alerts_gj = fetch_json(ALERTS_URL, "RESPONDER_CALTOPO_ALERTS_FILE")
    if alerts_gj is None:
        unavailable.append("nws-alerts")
    lsr_gj = fetch_json(LSR_URL, "RESPONDER_CALTOPO_LSRS_FILE")
    if lsr_gj is None:
        unavailable.append("iem-lsr")

    ranked = (build_alerts(alerts_gj) + build_crests(crest, snapshot) + build_gauges(snapshot)
              + build_roads(roads) + build_crossings(crossings) + build_notices(reqs) + build_lsrs(lsr_gj))

    dropped = 0
    if len(ranked) > MAX_FEATURES:
        ranked.sort(key=lambda rf: rf[0], reverse=True)  # stable: keeps source order within a rank
        dropped = len(ranked) - MAX_FEATURES
        ranked = ranked[:MAX_FEATURES]

    members = [f for _, f in ranked]
    counts = {}
    for f in members:
        counts[f["properties"]["folder"]] = counts.get(f["properties"]["folder"], 0) + 1

    folder_feats = [{"type": "Feature", "id": fid, "geometry": None,
                     "properties": {"class": "Folder", "title": name, "labelVisible": True}}
                    for fid, name in FOLDERS if any(f["properties"]["folderId"] == fid for f in members)]

    now = now_utc().strftime("%Y-%m-%dT%H:%M:%SZ")
    doc = {
        "type": "FeatureCollection",
        "properties": {
            "title": f"{event.get('name') or 'Responder TX'} · CalTopo export",
            "generated": now,
            "note": DISCLAIMER,
            "import_url": f"{SITE}/data/caltopo-export.json",
            "counts": counts,
            "truncated": dropped > 0,
            "dropped": dropped,
            "sources_unavailable": unavailable,
        },
        "features": folder_feats + members,
    }

    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(OUT), prefix=".caltopo-export.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, separators=(",", ":"))
        os.replace(tmp, OUT)
    except Exception:  # noqa: BLE001, cleanup: drop the temp file, then re-raise
        os.unlink(tmp)
        raise
    print(f"caltopo-export.json: {len(members)} features in {len(folder_feats)} folders "
          f"(dropped {dropped}, unavailable: {','.join(unavailable) or 'none'}) @ {now}")


if __name__ == "__main__":
    main()
