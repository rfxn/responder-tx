#!/usr/bin/env python3
"""Generate data/records.json: NWPS all-time crest of record per AO gauge.

Walks every lid in data/gauges-snapshot.json and pulls flood.crests.historic
from the NWPS gauge endpoint, keeping the highest historic crest (stage + date).
Output schema matches the curated 2026-07-17 file exactly:
{generated, source, note, records:{LID:{name, record_ft, record_date}}}.
Gauges with no historic crests are skipped (normal for minor gauges). Refuses
to write unless the run clears MIN_RECORDS and reaches half of what the last
published file carried, so a degraded NWPS never replaces a good file with a
stub. Run out of band, by hand. Atomic temp-file + rename write.
"""
import datetime
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.environ.get("RESPONDER_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAPSHOT = os.path.join(ROOT, "data", "gauges-snapshot.json")
OUT = os.path.join(ROOT, "data", "records.json")
NWPS_GAUGE_URL = "https://api.water.noaa.gov/nwps/v1/gauges/"
UA = "responder-tx-ops/gen-records (rfxnryan@gmail.com)"
MIN_RECORDS = 50
RECORD_KEEP = 2  # divisor: a run must reach half what it last published, which MIN_RECORDS alone does not follow as the gauge network grows
FETCH_SPACING_S = 0.2
BACKOFFS = [2, 5]
# A preliminary ("P") crest posted during the current event must not become the
# record it is being compared against, or over/near-record headlines go dark.
PRELIM_EXCLUDE_DAYS = 60


def fetch_gauge(lid):
    req = urllib.request.Request(
        NWPS_GAUGE_URL + lid, headers={"User-Agent": UA, "Accept": "application/json"})
    for attempt in range(len(BACKOFFS) + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
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


def record_crest(gauge, now):
    crests = (((gauge or {}).get("flood") or {}).get("crests") or {}).get("historic") or []
    prelim_cutoff = now - datetime.timedelta(days=PRELIM_EXCLUDE_DAYS)
    best = None
    for c in crests:
        stage = c.get("stage")
        when = str(c.get("occurredTime") or "")
        if not isinstance(stage, (int, float)) or stage <= 0 or len(when) < 10:
            continue
        if c.get("preliminary") == "P":
            try:
                occurred = datetime.datetime.fromisoformat(when.replace("Z", "+00:00"))
            except ValueError:
                continue
            if occurred >= prelim_cutoff:
                continue
        if best is None or stage > best[0]:
            best = (stage, when[:10])
    return best


def prev_records():
    """How many records the last published file carried, or None on a genuine first run.

    A file that exists and will not read is not a first run: treating it as one would drop the only
    floor that follows the gauge network as it grows, and a broadly failing NWPS would then publish
    a fraction of the records over a good file.
    """
    try:
        with open(OUT, encoding="utf-8") as f:
            return len(json.load(f).get("records") or {})
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        sys.exit(f"gen-records: {OUT} exists but will not read ({exc}); refusing to publish "
                 f"without the floor it carries")


def main():
    known = prev_records()  # first, so an unreadable baseline aborts before ~1000 upstream fetches
    with open(SNAPSHOT, encoding="utf-8") as f:
        snap = json.load(f)
    lids = [(g["lid"], g.get("name") or g["lid"]) for g in snap.get("gauges", []) if g.get("lid")]
    if not lids:
        sys.exit("gen-records: empty gauge snapshot")

    now = datetime.datetime.now(datetime.timezone.utc)
    records, no_crests, failed = {}, 0, 0
    for i, (lid, snap_name) in enumerate(lids):
        if i:
            time.sleep(FETCH_SPACING_S)
        try:
            gauge = fetch_gauge(lid)
        except Exception as e:  # noqa: BLE001 — one dead lid must not kill the other 289
            sys.stderr.write(f"gen-records: {lid} fetch failed: {e}\n")
            failed += 1
            continue
        best = record_crest(gauge, now)
        if best is None:
            no_crests += 1
            continue
        records[lid] = {
            "name": (gauge.get("name") or snap_name),
            "record_ft": best[0],
            "record_date": best[1],
        }

    if len(records) < MIN_RECORDS:
        sys.exit(f"gen-records: only {len(records)} gauges with records "
                 f"(need >={MIN_RECORDS}); keeping previous file")
    if known and len(records) < known // RECORD_KEEP:
        sys.exit(f"gen-records: {len(records)} gauges with records against {known} published last "
                 f"run (floor {known // RECORD_KEEP}, {failed} fetches failed); keeping previous file")

    payload = {
        "generated": now.replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "NOAA NWPS flood.crests.historic (all-time crest of record at each gauge)",
        "note": ("Record = highest crest in the NWPS period of record. Datum shifts "
                 "across decades can affect very old crests; treat as context, not a "
                 "datum-exact guarantee."),
        "records": records,
    }
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(OUT), prefix=".records.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=1, ensure_ascii=False)
        os.replace(tmp, OUT)
    except Exception:
        os.unlink(tmp)
        raise
    print(f"gen-records: {len(lids)} gauges fetched, {len(records)} with records, "
          f"{no_crests} without crests, {failed} failed")


if __name__ == "__main__":
    main()
