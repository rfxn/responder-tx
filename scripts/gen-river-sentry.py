#!/usr/bin/env python3
"""Export the public "River Sentry Towers" Google My Maps to data/river-sentry.json.

Locations only. The upstream map is a public My Maps KML export that names no
author and carries no date, and River Sentry publishes no location or status
feed of its own, so this file is a reported-position snapshot and never a status
source. Water-level and elevation columns present in the KML are dropped on
purpose: they are undated survey figures that would read as live readings.

Static dataset, not a cycle artifact. Re-run by hand and commit the result; it
is deliberately absent from run-cycle.sh DATA_FILES.
"""
import datetime
import json
import os
import re
import sys
import tempfile
import urllib.request
import xml.etree.ElementTree as ET

ROOT = os.environ.get("RESPONDER_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "river-sentry.json")
MID = os.environ.get("RESPONDER_RSENTRY_MID", "1Iiu6CdjrASAdCpdXBhgOS6-pNJeYzGw")
URL = f"https://www.google.com/maps/d/kml?mid={MID}&forcekml=1"
UA = "responder-tx-ops/gen-river-sentry (rfxnryan@gmail.com)"
KML_NS = {"k": "http://www.opengis.net/kml/2.2"}
SOURCE = {
    "name": "Public “River Sentry Towers” map (Google My Maps), author not identified",
    "url": "https://www.google.com/maps/d/viewer?mid=1Iiu6CdjrASAdCpdXBhgOS6-pNJeYzGw",
}
# a degraded upstream must not replace a good file with a stub
MIN_TOWERS = 40
# AO sanity box: the map is a Texas Hill Country dataset, anything outside is a parse error
BBOX = {"xmin": -107.0, "ymin": 25.5, "xmax": -93.0, "ymax": 37.0}


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=45) as resp:
        return resp.read()


def tower_label(raw, seen_site):
    """Normalize the KML per-point Name ('tower 7 ', 'Tower 1', 'Sherman') to a display label."""
    lbl = re.sub(r"\s+", " ", str(raw or "")).strip()
    if not lbl:
        return ""
    m = re.match(r"^tower\s*(\d+)$", lbl, re.IGNORECASE)
    if m:
        return f"Tower {m.group(1)}"
    # a site-name repeat carries no per-tower information
    if lbl.casefold() == seen_site.casefold():
        return ""
    return lbl


def parse(raw):
    root = ET.fromstring(raw)
    towers = []
    for pm in root.findall(".//k:Placemark", KML_NS):
        site = re.sub(r"\s+", " ", (pm.findtext("k:name", default="", namespaces=KML_NS) or "")).strip()
        data = {}
        for d in pm.findall(".//k:Data", KML_NS):
            data[d.get("name")] = (d.findtext("k:value", default="", namespaces=KML_NS) or "").strip()
        coords = (pm.findtext(".//k:coordinates", default="", namespaces=KML_NS) or "").strip()
        parts = coords.split(",")
        if not site or len(parts) < 2:
            print(f"warn: placemark without a site name or point, skipped: {site!r}", file=sys.stderr)
            continue
        try:
            lon, lat = float(parts[0]), float(parts[1])
        except ValueError:
            print(f"warn: unparseable coordinate for {site!r}, skipped: {coords!r}", file=sys.stderr)
            continue
        if not (BBOX["xmin"] <= lon <= BBOX["xmax"] and BBOX["ymin"] <= lat <= BBOX["ymax"]):
            print(f"warn: {site!r} outside the Texas box, skipped: {lat},{lon}", file=sys.stderr)
            continue
        towers.append({
            "site": site,
            "label": tower_label(data.get("Name"), site),
            "lat": round(lat, 6),
            "lon": round(lon, 6),
        })
    return towers


def main():
    try:
        raw = fetch(URL)
    except Exception as exc:  # noqa: BLE001, any transport/HTTP failure keeps the committed file
        sys.exit(f"gen-river-sentry: KML fetch failed, keeping previous file: {exc}")
    try:
        towers = parse(raw)
    except ET.ParseError as exc:
        sys.exit(f"gen-river-sentry: KML did not parse, keeping previous file: {exc}")

    if len(towers) < MIN_TOWERS:
        sys.exit(f"gen-river-sentry: only {len(towers)} towers parsed (floor {MIN_TOWERS}), keeping previous file")

    # per-site count is the one derived figure worth shipping: it says which camps the map claims
    # coverage for and how much, which is the operator question a bare pin cannot answer
    counts = {}
    for tw in towers:
        counts[tw["site"]] = counts.get(tw["site"], 0) + 1
    towers.sort(key=lambda tw: (tw["site"], tw["label"]))

    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    payload = {
        "generated": now,
        "captured": now,
        "source": SOURCE,
        "note": (
            "Reported tower positions transcribed from a public Google My Maps export. The map names "
            "no author and carries no revision date. Locations only: no operational, power, or "
            "activation status is available from any published feed."
        ),
        "sites": [{"site": s, "towers": n} for s, n in sorted(counts.items())],
        "towers": towers,
    }

    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(OUT), prefix=".river-sentry.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=1, ensure_ascii=False)
            fh.write("\n")
        os.replace(tmp, OUT)
    except Exception:  # noqa: BLE001, cleanup: drop the temp file, then re-raise
        os.unlink(tmp)
        raise

    print(f"gen-river-sentry: {len(towers)} towers across {len(counts)} sites, captured {now}")


if __name__ == "__main__":
    main()
