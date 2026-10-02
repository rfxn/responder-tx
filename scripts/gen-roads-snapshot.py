#!/usr/bin/env python3
"""Archive the DriveTexas road-closure set to data/roads-capture.json and data/roads-snapshot.json.

Run each release cycle (like gen-feeds.py) and commit the output. The git history of these
files is the playback archive for road closures, the same pattern gauges-snapshot.json
serves for gauges, and it is the ONLY archive that exists: upstream holds current conditions
only, so a closure that clears is gone from upstream for good. The source is the MapLarge
condition table drivetexas.org itself draws (INTERNAL-NOTES.md "Road closures after the
DriveTexas token change"). Rows touching data/event.json captureBbox (Texas-wide fallback)
produce roads-capture.json, the durable statewide archive; roads-snapshot.json is that
capture filtered to gaugeBbox, the display-scoped file gen-history.py and gen-caltopo.py
consume. Capture is deliberately wider than display so retargeting the AO can never again
reduce what we collect. Failures are non-fatal to the cycle but exit non-zero: the previous
files are left intact, and the non-zero status is what makes run-cycle.sh sign the cycle off
DEGRADED instead of clean, which is the signal the freshness monitor reads.
"""
import datetime
import json
import math
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

ROOT = os.environ.get("RESPONDER_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "roads-snapshot.json")
CAPTURE_OUT = os.path.join(ROOT, "data", "roads-capture.json")
MAPLARGE = "https://dtx-e-cdn.maplarge.com"
ACTIVE_URL = MAPLARGE + "/Remote/GetActiveTableID?shortTableId=appgeo%2FconditionsLine"
QUERY_URL = MAPLARGE + "/Api/ProcessDirect?request="
# the short name is CDN-cached for days; only a versioned id is a current read
TABLE_RE = re.compile(r"^appgeo/conditionsLine/[0-9]{6,24}$")
GEO_COL = "conditionsLine"
# drivetexas.org's own CNSTRNTTYPECD legend; mirrors js/sources.js ROAD_ML_COND
COND = {"Z": "Closure", "F": "Flooding", "D": "Damage"}
# the site's full legend; a code outside it means upstream re-coded, mirrors js/sources.js ROAD_ML_LEGEND
LEGEND = ("Z", "F", "D", "C", "A", "I", "O", "Y", "X", "N")
CENSUS_TAKE = 100
COLS = ["OBJECTID", "CNSTRNTTYPECD", "RTENM", "CONDLMTFROMDSCR", "CONDLMTTODSCR", "CONDDSCR",
        "CONDSTARTTS", "CONDENDTS", "CNSTRNTDETOURFLAG", "lastUpdated", GEO_COL]
# event-neutral Texas-wide fallback, mirrors js/core.js CONFIG.gaugeBbox
DEFAULT_BBOX = (-106.65, 25.83, -93.4, 36.5)
PAGE = 1000
MAX_PAGES = 8      # runaway guard; the statewide set runs in the tens even in a major event
# upstream re-imports every 5 minutes; mirrors js/sources.js ROAD_STALE_MIN
STALE_MIN = 30
# clock-skew allowance for a stamp ahead of us; mirrors js/sources.js ROAD_FUTURE_MIN
FUTURE_MIN = 5
# start/end keep the Central-offset form the archive has always held: gen-history.py keys on start
CENTRAL = ZoneInfo("America/Chicago")
UA = "responder-board-gen-roads"
# healthy answers measure ~0.3s, so a short deadline plus retries beats one long wait on a hang
TIMEOUT = 12
BACKOFFS = [2, 5]
# raising this past gen-caltopo.py's own desc cap would let that cap cut the ellipsis back off
DESC_MAX = 200
DESC_TAG_RE = re.compile(r"<[^>]*>")
DESC_WS_RE = re.compile(r"\s+")
DESC_LEAD_RE = re.compile(r"^[\s–—-]+")
WKT_RE = re.compile(r"^\s*(MULTILINESTRING|LINESTRING)\s*\((.*)\)\s*$", re.S)
WKT_PART_RE = re.compile(r"\(([^()]*)\)")


def clean_desc(raw):
    """Markup and TxDOT's leading "- " artifact dropped exactly as js/sources.js stripHtml does,
    so a snapshot row reads identically to a live one, then capped on a word with an ellipsis."""
    s = DESC_LEAD_RE.sub("", DESC_WS_RE.sub(" ", DESC_TAG_RE.sub(" ", str(raw or ""))).strip())
    if len(s) <= DESC_MAX:
        return s
    cut = s[:DESC_MAX - 1]
    space = cut.rfind(" ")
    if space >= DESC_MAX // 2:
        cut = cut[:space]
    return cut.rstrip() + "…"


def fetch_json(url, label):
    """One MapLarge read, retried through BACKOFFS; a hard 4xx raises at once. Anything but a
    successful answer raises, so a refused query can never archive as an empty-roads day."""
    for attempt in range(len(BACKOFFS) + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                doc = json.load(r)
            if not isinstance(doc, dict) or doc.get("success") is not True:
                raise ValueError(f"{label}: not a successful MapLarge answer: {str(doc)[:200]}")
            return doc
        except Exception as e:  # noqa: BLE001 — the caller keeps the previous file on the final raise
            hard_4xx = isinstance(e, urllib.error.HTTPError) and e.code != 429 and e.code < 500
            if attempt == len(BACKOFFS) or hard_4xx:
                raise
            print(f"warn: DriveTexas {label} attempt {attempt + 1} failed ({e}); "
                  f"retry in {BACKOFFS[attempt]}s", file=sys.stderr)
            time.sleep(BACKOFFS[attempt])


def query_url(query):
    return QUERY_URL + urllib.parse.quote(json.dumps({"action": "table/query", "query": query},
                                                     separators=(",", ":")))


def active_table():
    table = str(fetch_json(ACTIVE_URL, "active table").get("table") or "")
    if not TABLE_RE.match(table):
        raise ValueError(f"no active condition table ({table!r})")
    return table


def table_rows(doc, cols):
    """Column-major MapLarge answer -> (rows, totals.Records); a missing or ragged column raises."""
    data = doc.get("data") if isinstance(doc.get("data"), dict) else {}
    table = data.get("data") if isinstance(data.get("data"), dict) else {}
    total = (data.get("totals") or {}).get("Records")
    if not isinstance(total, int) or isinstance(total, bool):
        raise ValueError(f"no record count in {str(doc)[:200]}")
    width = {len(table[c]) if isinstance(table.get(c), list) else -1 for c in cols}
    if len(width) != 1 or -1 in width:
        raise ValueError(f"column set incomplete: {sorted(table)}")
    n = width.pop()
    return [{c: table[c][i] for c in cols} for i in range(n)], total


def fetch_rows(table):
    """Every Closure/Flooding/Damage row, paged. Returns (rows, truncated); truncated means the
    set is short of what the table reports holding."""
    rows, seen = [], set()
    for page in range(MAX_PAGES):
        doc = fetch_json(query_url({
            "sqlselect": COLS, "start": page * PAGE, "table": table, "take": PAGE,
            "where": [{"col": "CNSTRNTTYPECD", "test": "EqualAny", "value": list(COND)}],
        }), "conditions")
        got, total = table_rows(doc, COLS)
        # a page that repeats rows already held is not progress, whatever its length
        fresh = [r for r in got if r["OBJECTID"] not in seen]
        seen.update(r["OBJECTID"] for r in fresh)
        rows += fresh
        if len(rows) >= total:
            return rows, False
        if not fresh:
            return rows, True
    return rows, True


def table_census(table):
    """Newest import stamp per condition code across the whole table; a code outside LEGEND raises."""
    doc = fetch_json(query_url({
        "sqlselect": ["CNSTRNTTYPECD", "lastUpdated.max"], "groupby": ["CNSTRNTTYPECD"],
        "start": 0, "table": table, "take": CENSUS_TAKE, "where": [],
    }), "census")
    groups, total = table_rows(doc, ["CNSTRNTTYPECD", "lastUpdated_Max"])
    if len(groups) < total:
        raise ValueError(f"condition census short: {len(groups)} of {total} groups")
    odd = sorted({repr(g["CNSTRNTTYPECD"]) for g in groups if g["CNSTRNTTYPECD"] not in LEGEND})
    if odd:
        raise ValueError(f"condition codes outside drivetexas.org's legend: {', '.join(odd)}")
    return [g["lastUpdated_Max"] for g in groups]


def table_updated(rows, census):
    """Epoch seconds of upstream's last import: off the rows, or the table census when none matched."""
    stamps = [r.get("lastUpdated") for r in rows] if rows else census
    nums = [s for s in stamps if isinstance(s, (int, float)) and not isinstance(s, bool)]
    if not nums:
        raise ValueError("condition table carries no readable lastUpdated stamp")
    return max(nums) / 1000


def wkt_lines(wkt):
    """[[(lon, lat), ...], ...] from a WKT LINESTRING or MULTILINESTRING; ValueError otherwise."""
    m = WKT_RE.match(str(wkt or ""))
    if not m:
        raise ValueError(f"unsupported geometry {str(wkt)[:40]!r}")
    parts = WKT_PART_RE.findall(m.group(2)) if m.group(1) == "MULTILINESTRING" else [m.group(2)]
    lines = [[tuple(float(v) for v in pt.split()[:2]) for pt in part.split(",")] for part in parts]
    if not lines or any(not line or any(len(c) != 2 or not all(map(math.isfinite, c)) for c in line)
                        for line in lines):
        raise ValueError(f"malformed geometry {str(wkt)[:40]!r}")
    return lines


def seg_hits_box(a, b, box):
    """Liang-Barsky: does segment a-b touch the (xmin, ymin, xmax, ymax) box?"""
    t0, t1 = 0.0, 1.0
    dx, dy = b[0] - a[0], b[1] - a[1]
    for p, q in ((-dx, a[0] - box[0]), (dx, box[2] - a[0]), (-dy, a[1] - box[1]), (dy, box[3] - a[1])):
        if p == 0:
            if q < 0:
                return False
        elif p < 0:
            if q / p > t1:
                return False
            t0 = max(t0, q / p)
        else:
            if q / p < t0:
                return False
            t1 = min(t1, q / p)
    return True


def line_hits_box(lines, box):
    """True when any part of the line touches the box, not just its first vertex."""
    return any(seg_hits_box(line[i], line[min(i + 1, len(line) - 1)], box)
               for line in lines for i in range(max(1, len(line) - 1)))


def central_iso(ms):
    if not isinstance(ms, (int, float)) or isinstance(ms, bool) or ms <= 0:
        return None
    return datetime.datetime.fromtimestamp(ms / 1000, CENTRAL).isoformat(timespec="seconds")


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


def road_record(r, bbox):
    """One archive row, or None when the row is construction-coded or outside the capture box.
    Raises on a row the archive cannot hold: an unreadable line, or no start to key it on."""
    # construction-driven closures are coded Closure/Damage too (owner: flood-relevant only)
    if "CONSTRUCTION" in str(r.get("CONDDSCR") or "").upper():
        return None
    lines = wkt_lines(r.get(GEO_COL))
    if not line_hits_box(lines, bbox):
        return None
    lon, lat = lines[0][0]
    start = central_iso(r.get("CONDSTARTTS"))
    # gen-history.py keys a closure on its start, and cycle-check.sh refuses a row without one
    if start is None:
        raise ValueError(f"unreadable start {r.get('CONDSTARTTS')!r}")
    return {
        "id": r.get("OBJECTID"),
        "cond": COND[r.get("CNSTRNTTYPECD")],
        "route": r.get("RTENM"),
        # route + limits is the segment identity js/sources.js roadId hashes; without them a
        # snapshot row keys to something no live row can equal, and every closure on one
        # route collapses to a single key
        "from": r.get("CONDLMTFROMDSCR") or "",
        "to": r.get("CONDLMTTODSCR") or "",
        "desc": clean_desc(r.get("CONDDSCR")),
        "start": start,
        "end": central_iso(r.get("CONDENDTS")),
        "v": [round(lat, 4), round(lon, 4)],
    }


def main():
    bbox = event_bbox("captureBbox")
    display = event_bbox("gaugeBbox")
    print(f"gen-roads-snapshot: capture bbox {bbox} | display bbox {display}")
    try:
        table = active_table()
        census = table_census(table)
        rows, truncated = fetch_rows(table)
        updated = table_updated(rows, census)
    except Exception as e:  # noqa: BLE001 — archive is best-effort; cycle must not fail on TxDOT flakes
        print(f"warn: roads snapshot fetch failed, keeping previous file: {e}", file=sys.stderr)
        return 1
    # a short set archives live closures as absent, and this archive is the only record there is:
    # gen-history.py reads absence as cleared, so a truncated capture invents road recoveries
    if truncated:
        print(f"warn: roads snapshot still truncated after {MAX_PAGES} pages "
              f"({len(rows)} rows), keeping previous file", file=sys.stderr)
        return 1
    # a stalled import keeps answering with its last set; stamping that set fresh would hide it
    age_min = (time.time() - updated) / 60
    if age_min > STALE_MIN:
        print(f"warn: DriveTexas condition table last imported {age_min:.0f} min ago "
              f"(over {STALE_MIN}), keeping previous file", file=sys.stderr)
        return 1
    if age_min < -FUTURE_MIN:
        print(f"warn: DriveTexas condition table stamped {-age_min:.0f} min in the future "
              f"(over {FUTURE_MIN}), keeping previous file", file=sys.stderr)
        return 1
    roads, unreadable = [], []
    for r in rows:
        try:
            rec = road_record(r, bbox)
        except Exception as e:  # noqa: BLE001, counted below: one unarchivable closure refuses the whole set
            unreadable.append(f"{r.get('OBJECTID')!r}: {e}")
            continue
        if rec:
            roads.append(rec)
    # gen-history.py reads a closure missing from the archive as cleared, so a skipped row is a false reopening
    if unreadable:
        print(f"warn: {len(unreadable)} of {len(rows)} closure rows unreadable ({unreadable[0]}), "
              f"keeping previous file", file=sys.stderr)
        return 1
    shown = [r for r in roads if in_bbox(r, display)]
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    write_roads(CAPTURE_OUT, roads, now)
    write_roads(OUT, shown, now)
    print(f"source: {table}, last imported {age_min:.0f} min ago")
    print(f"roads-capture.json: {len(roads)} closures @ {now}")
    print(f"roads-snapshot.json: {len(shown)} closures @ {now}")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
