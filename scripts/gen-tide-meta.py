#!/usr/bin/env python3
"""Generate data/tide-meta.json: a coordinate for every tide station in data/event.json.

Resolves each id in event.json tideStations against the NOAA CO-OPS metadata API so the
coastal card can place a station without a per-load lookup. The result is merged over the
previously published file: an id whose fetch fails this run keeps its cached coordinate,
because a failed request and a station that no longer exists are different facts. Only ids
currently listed in event.json survive the merge, so dropping one is a config decision and
never a fetch outcome.

Static dataset, not a cycle artifact. Re-run by hand and commit the result; it is
deliberately absent from run-cycle.sh DATA_FILES.

Run: python3 scripts/gen-tide-meta.py [--dry-run]
"""
import datetime
import json
import math
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.environ.get("RESPONDER_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVENT = os.path.join(ROOT, "data", "event.json")
OUT = os.path.join(ROOT, "data", "tide-meta.json")
MDAPI_URL = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/"
UA = "responder-tx-ops/gen-tide-meta (rfxnryan@gmail.com)"
SOURCE = {
    "name": "NOAA CO-OPS station metadata (MDAPI)",
    "url": "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.html",
}
# a degraded upstream must not replace a good file with a stub
MIN_STATIONS = 20
FETCH_SPACING_S = 0.2
BACKOFFS = [2, 5]
TIMEOUT = 30
# Gulf coast sanity box: a point outside it is a parse error, not a station
BBOX = {"xmin": -98.0, "ymin": 25.0, "xmax": -88.0, "ymax": 31.0}


def fetch_station(sid):
    """The MDAPI document for a station id, or None when upstream knows no such station."""
    req = urllib.request.Request(MDAPI_URL + sid + ".json",
                                 headers={"User-Agent": UA, "Accept": "application/json"})
    for attempt in range(len(BACKOFFS) + 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if attempt < len(BACKOFFS) and (e.code == 429 or 500 <= e.code < 600):
                time.sleep(BACKOFFS[attempt])
                continue
            raise
        except (urllib.error.URLError, TimeoutError, ValueError, OSError):
            if attempt < len(BACKOFFS):
                time.sleep(BACKOFFS[attempt])
                continue
            raise
    return None


def point(lat, lon):
    """Rounded (lat, lon), or None when the pair is not a finite Gulf-coast coordinate."""
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return None
    if not math.isfinite(lat) or not math.isfinite(lon):
        return None
    if not (BBOX["ymin"] <= lat <= BBOX["ymax"] and BBOX["xmin"] <= lon <= BBOX["xmax"]):
        return None
    return round(lat, 5), round(lon, 5)


def entry(lat, lon, name):
    pt = point(lat, lon)
    if pt is None:
        return None
    return {"lat": pt[0], "lon": pt[1], "name": str(name or "").strip()}


def station_of(doc):
    """The usable entry inside an MDAPI station document, or None if it carries no point."""
    stations = (doc or {}).get("stations") or []
    if not isinstance(stations, list) or not stations:
        return None
    st = stations[0] if isinstance(stations[0], dict) else {}
    return entry(st.get("lat"), st.get("lng"), st.get("name"))


def configured():
    """[(id, name)] from event.json tideStations, first occurrence wins on a repeated id."""
    try:
        with open(EVENT, encoding="utf-8") as f:
            stations = json.load(f).get("tideStations")
    except (OSError, ValueError) as exc:
        sys.exit(f"gen-tide-meta: {EVENT} will not read ({exc})")
    if not isinstance(stations, list) or not stations:
        sys.exit(f"gen-tide-meta: {EVENT} lists no tideStations")
    out, seen = [], set()
    for st in stations:
        sid = str((st or {}).get("id") or "").strip()
        if sid and sid not in seen:
            seen.add(sid)
            out.append((sid, str((st or {}).get("name") or "").strip()))
    if not out:
        sys.exit(f"gen-tide-meta: {EVENT} tideStations carries no station id")
    return out


def cached():
    """The stations map of the previously published file, or {} on a genuine first run.

    A file that exists and will not read is not a first run, so it aborts rather than discarding
    every cached coordinate and the floor they establish.
    """
    try:
        with open(OUT, encoding="utf-8") as f:
            doc = json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        sys.exit(f"gen-tide-meta: {OUT} exists but will not read ({exc}); refusing to publish "
                 f"without the coordinates it carries")
    stations = (doc or {}).get("stations")
    if not isinstance(stations, dict):
        sys.exit(f"gen-tide-meta: {OUT} exists but carries no stations map; refusing to publish "
                 f"without the coordinates it should hold")
    return stations


def main():
    dry_run = "--dry-run" in sys.argv[1:]
    prev = cached()  # first, so an unreadable baseline aborts before any upstream request
    wanted = configured()

    resolved, missed = {}, []
    for i, (sid, _name) in enumerate(wanted):
        if i:
            time.sleep(FETCH_SPACING_S)
        try:
            doc = fetch_station(sid)
        except Exception as exc:  # noqa: BLE001, one dead id must not cost the rest of the list
            missed.append((sid, f"fetch failed: {exc}"))
            continue
        if doc is None:
            missed.append((sid, "upstream knows no such station (404)"))
            continue
        found = station_of(doc)
        if found is None:
            missed.append((sid, "metadata carries no coordinate inside the Gulf coast box"))
            continue
        resolved[sid] = found

    merged, carried = {}, []
    for sid, name in wanted:
        rec = resolved.get(sid)
        if rec is None:
            cache = prev.get(sid)
            rec = entry(cache.get("lat"), cache.get("lon"),
                        cache.get("name")) if isinstance(cache, dict) else None
            if rec is None:
                continue
            carried.append(sid)
        if not rec["name"]:
            rec["name"] = name
        merged[sid] = rec

    for sid, why in missed:
        sys.stderr.write(f"gen-tide-meta: {sid} unresolved, {why}\n")

    if len(merged) < MIN_STATIONS:
        sys.exit(f"gen-tide-meta: only {len(merged)} stations resolved (need >={MIN_STATIONS}); "
                 f"keeping previous file")
    wanted_ids = {sid for sid, _ in wanted}
    known = sum(1 for sid in prev if sid in wanted_ids)
    if len(merged) < known:
        sys.exit(f"gen-tide-meta: {len(merged)} stations against {known} the previous file held "
                 f"for ids still configured; keeping previous file")

    summary = (f"gen-tide-meta: {len(wanted)} configured, {len(resolved)} fetched, "
               f"{len(missed)} missed, {len(carried)} carried over from cache, "
               f"{len(merged)} written")
    if dry_run:
        print(summary.replace("written", "would be written") + " (dry run)")
        return

    payload = {
        "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": SOURCE,
        "stations": merged,
    }
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(OUT), prefix=".tide-meta.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, OUT)
    except Exception:
        os.unlink(tmp)
        raise
    print(summary)


if __name__ == "__main__":
    main()
