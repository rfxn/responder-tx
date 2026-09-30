#!/usr/bin/env python3
"""Poll Houston TranStar's Roadway Flood Warning System to data/transtar-flood.json.

Every entry in the feed is an area TranStar rates at high risk of roadway flooding; it never
confirms a flooded or closed road. An empty array is a genuine zero and publishes status "ok".
A failed or unparseable read publishes status "failed" with a null count, or "carried" with the
last good warnings for up to CARRY_H, and exits non-zero. See INTERNAL-NOTES.md "Houston TranStar
roadway flood warnings".
"""
import datetime
import email.utils
import json
import math
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

ROOT = os.environ.get("RESPONDER_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "transtar-flood.json")
UA = "responder-tx-ops/gen-transtar-flood (rfxnryan@gmail.com)"
FEED_URL = "https://traffic.houstontranstar.org/data/layers/floodalert_json.js"
SOURCE = {
    "key": "transtar",
    "name": "Houston TranStar Roadway Flood Warning System",
    "url": "https://www.houstontranstar.org/about_transtar/about_rfws.aspx",
}
# the feed's timestamps are Central local time with no offset
FEED_ZONE = "America/Chicago"
TIMEOUT = 12
BACKOFFS = [2, 5]
# a failed read republishes the last good warnings, never a zero, for at most this long
CARRY_H = 1
FUTURE_SLACK_S = 15 * 60
MAX_RADIUS_MI = 10
# sanity box, not a scope: a point outside Texas is a malformed entry
TX_BOX = {"lat": (25.5, 37.0), "lon": (-107.0, -93.0)}
REASON_MAX = 160
# a date alone would read as local midnight, so a stamp must carry its time of day
STAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}")


def iso_z(dt):
    return dt.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def dt_from_iso(v):
    if not isinstance(v, str) or not v.strip():
        return None
    try:
        dt = datetime.datetime.fromisoformat(v.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=datetime.timezone.utc)


def text(v):
    """A stated string, or None. The feed spells an absent ShefId as the string "null"."""
    if v is None or isinstance(v, bool):
        return None
    s = str(v).strip()
    return None if not s or s.lower() in ("null", "none", "undefined") else s


def number(v, lo=None, hi=None):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return None
    if (lo is not None and v < lo) or (hi is not None and v > hi):
        return None
    v = round(float(v), 5)
    return int(v) if v == int(v) else v


def http_url(v):
    s = text(v)
    return s if s and s.lower().startswith(("https://", "http://")) else None


def local_to_iso(v, zone, now):
    """A feed timestamp as ISO UTC, or None when absent, a 0001-01-01 placeholder, unparseable, or
    later than now: a stamp from the future cannot be aged."""
    s = text(v) if isinstance(v, str) else None
    if not s or not STAMP_RE.match(s):
        return None
    try:
        dt = datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.year < 2000:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=zone)
    if (dt - now).total_seconds() > FUTURE_SLACK_S:
        print(f"warn: timestamp {s!r} is in the future, publishing it as unstated", file=sys.stderr)
        return None
    return iso_z(dt)


def fetch(now):
    """(body, Last-Modified) for one read, retried through BACKOFFS; a hard 4xx raises at once."""
    url = f"{FEED_URL}?arg={int(now.timestamp() * 1000)}"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json, */*"})
    for attempt in range(len(BACKOFFS) + 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return r.read(), r.headers.get("Last-Modified")
        except Exception as e:  # noqa: BLE001, the caller publishes the final raise as a failed read
            hard_4xx = isinstance(e, urllib.error.HTTPError) and e.code != 429 and e.code < 500
            if attempt == len(BACKOFFS) or hard_4xx:
                raise
            print(f"warn: TranStar attempt {attempt + 1} failed ({e}); retry in {BACKOFFS[attempt]}s",
                  file=sys.stderr)
            time.sleep(BACKOFFS[attempt])


def captured_from(last_modified, now):
    """The feed's own currency stamp from Last-Modified, or None when it stated none usable. A
    stamp from the future would keep an all-clear looking current forever."""
    if not last_modified:
        return None
    try:
        dt = email.utils.parsedate_to_datetime(last_modified)
    except (TypeError, ValueError, IndexError):
        return None
    dt = dt if dt.tzinfo else dt.replace(tzinfo=datetime.timezone.utc)
    if (dt - now).total_seconds() > FUTURE_SLACK_S:
        print(f"warn: Last-Modified {last_modified!r} is in the future, publishing no capture stamp",
              file=sys.stderr)
        return None
    return iso_z(dt)


def parse_entry(e, zone, now):
    if not isinstance(e, dict):
        raise ValueError("entry is not an object")
    lat = number(e.get("Latitude"), *TX_BOX["lat"])
    lon = number(e.get("Longitude"), *TX_BOX["lon"])
    if lat is None or lon is None:
        raise ValueError(f"no usable location in Texas: {e.get('Latitude')!r},{e.get('Longitude')!r}")
    sensor = text(e.get("SensorId"))
    sensor = int(sensor) if sensor and sensor.isdigit() else None
    stage_at = local_to_iso(e.get("StreamElevationLatestTimestamp"), zone, now)
    stamps = [s for s in (local_to_iso(e.get("Timestamp"), zone, now), stage_at) if s]
    return {
        "id": f"transtar:{sensor}" if sensor is not None else f"transtar:{lat:.5f},{lon:.5f}",
        "sensor": sensor,
        "name": text(e.get("SensorName")),
        "lat": round(lat, 5),
        "lon": round(lon, 5),
        "radiusMi": number(e.get("Radius"), 0, MAX_RADIUS_MI) or None,
        # the most recent report behind the warning; None when the feed stated no usable time
        "observed": max(stamps) if stamps else None,
        "stageFt": number(e.get("StreamElevationLatestValue"), -1000, 10000),
        "stageAt": stage_at,
        "bankFt": number(e.get("TopOfBank"), -1000, 10000),
        "shef": text(e.get("ShefId")),
        "url": http_url(e.get("SensorUrl")),
    }


def parse_feed(body, zone, now):
    """(warnings, skipped). Raises when the body is not the documented array, or when a non-empty
    array yields nothing usable: a format change is not a day with no warnings."""
    doc = json.loads(body.decode("utf-8-sig"))
    if not isinstance(doc, list):
        raise ValueError(f"feed is not a JSON array: {str(doc)[:120]}")
    kept, skipped = {}, 0
    for e in doc:
        try:
            w = parse_entry(e, zone, now)
        except Exception as err:  # noqa: BLE001, one malformed entry must not drop the rest
            skipped += 1
            print(f"warn: skipped malformed TranStar entry: {err}", file=sys.stderr)
            continue
        prev = kept.get(w["id"])
        if prev is None or (w["observed"] or "") > (prev["observed"] or ""):
            kept[w["id"]] = w
    if doc and not kept:
        raise ValueError(f"all {len(doc)} entries were unusable")
    return sorted(kept.values(), key=lambda w: (w["name"] or "", w["id"])), skipped


def collect(now):
    zone = ZoneInfo(FEED_ZONE)
    body, last_modified = fetch(now)
    warnings, skipped = parse_feed(body, zone, now)
    return warnings, skipped, captured_from(last_modified, now)


def read_previous():
    try:
        with open(OUT, encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError) as e:
        print(f"note: previous transtar-flood.json unreadable, nothing to carry: {e}", file=sys.stderr)
        return None
    return doc if isinstance(doc, dict) else None


def carry(prev, now, reason):
    """(warnings, source row) republished from the previous file, or (None, None). Only a list
    with warnings in it is carried: a carried zero would be a failed read published as a zero."""
    warnings = (prev or {}).get("warnings")
    if not isinstance(warnings, list) or not warnings:
        return None, None
    row = next((s for s in prev.get("sources") or [] if isinstance(s, dict)
                and s.get("key") == SOURCE["key"]), {})
    if row.get("status") not in ("ok", "carried"):
        return None, None
    # the clock is the last successful READ, propagated so a run of failures cannot ratchet it
    read_dt = dt_from_iso(row.get("carriedFrom") or prev.get("generated"))
    if read_dt is None:
        return None, None
    age_h = (now - read_dt).total_seconds() / 3600.0
    if not 0 <= age_h <= CARRY_H:
        print(f"note: last good warnings are {age_h:.1f}h old, past the {CARRY_H}h carry window",
              file=sys.stderr)
        return None, None
    return warnings, dict(SOURCE, status="carried", captured=row.get("captured"),
                          count=len(warnings), skipped=row.get("skipped") or 0,
                          carriedFrom=iso_z(read_dt), reason=reason)


def write_payload(payload):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(OUT), prefix=".transtar-flood.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, separators=(",", ":"), ensure_ascii=False)
            fh.write("\n")
        os.replace(tmp, OUT)
    except Exception:  # noqa: BLE001, cleanup: drop the temp file, then re-raise
        os.unlink(tmp)
        raise


def main():
    now = datetime.datetime.now(datetime.timezone.utc)
    try:
        warnings, skipped, captured = collect(now)
    except Exception as e:  # noqa: BLE001, a failed read is published as failed, never as zero
        reason = " ".join(f"{type(e).__name__}: {e}".split())[:REASON_MAX]
        kept, row = carry(read_previous(), now, reason)
        if kept is None:
            kept, row = [], dict(SOURCE, status="failed", captured=None, count=None, skipped=0,
                                 reason=reason)
        write_payload({"generated": iso_z(now), "sources": [row], "warnings": kept})
        print(f"transtar-flood.json: read failed ({reason}); published {row['status']}"
              + (f" with {row['count']} warnings last read {row['carriedFrom']}"
                 if row["status"] == "carried" else ""), file=sys.stderr)
        return 1
    row = dict(SOURCE, status="ok", captured=captured, count=len(warnings), skipped=skipped)
    write_payload({"generated": iso_z(now), "sources": [row], "warnings": warnings})
    print(f"transtar-flood.json: {len(warnings)} warnings ({skipped} skipped) "
          f"@ {captured or 'no upstream stamp'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
