#!/usr/bin/env python3
"""Generate data/crest-summary.json — per-gauge event peak stages for AAR/FEMA documentation.

Walks the committed history of data/gauges-snapshot.json (one snapshot every
~15 min for the life of the event) and records, for every gauge that reached
an observed minor/moderate/major flood category, its peak stage, when the peak
first occurred, and its in-flood window. The git archive starts mid-event, so
the pre-archive window is folded in from data/history.json's src-tagged
backfill frames (USGS/NWPS observed, built by gen-history.py); peaks sourced
there carry "src":"usgs". Run at release time like gen-feeds.py.
Honest by construction: peaks whose observation was stale at peak time are
flagged, not dropped; nothing is interpolated or invented.
"""
import datetime
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAPSHOT_PATH = "data/gauges-snapshot.json"
HISTORY_PATH = "data/history.json"
FLOOD_CATS = ("minor", "moderate", "major")
CAT_RANK = {"minor": 2, "moderate": 3, "major": 4}
CODE_CAT = {2: "minor", 3: "moderate", 4: "major"}
STALE_HOURS = 12
RECORD_NEAR_PCT = 0.90


def load_event():
    try:
        with open(os.path.join(ROOT, "data", "event.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def event_name(ev, now):
    return ev.get("event") or ev.get("eventName") or now.strftime("%B %Y")


def event_bbox(ev):
    b = ev.get("gaugeBbox") or {}
    try:
        return (float(b["xmin"]), float(b["ymin"]), float(b["xmax"]), float(b["ymax"]))
    except (KeyError, TypeError, ValueError):
        return None


def in_bbox(lat, lon, bbox):
    if bbox is None:
        return True
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return False
    return bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]


def git(*args):
    return subprocess.run(("git", "-C", ROOT) + args, capture_output=True, text=True, check=True).stdout


def parse_iso(s):
    try:
        dt = datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:  # offset-less upstream stamp — assume UTC, never return naive
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt


def snapshot_commits():
    out = git("log", "--format=%H %cI", "--follow", "--", SNAPSHOT_PATH)
    commits = [line.split(" ", 1) for line in out.splitlines() if line.strip()]
    commits.reverse()
    return commits


def load_snapshot(commit_hash):
    raw = subprocess.run(("git", "-C", ROOT, "show", f"{commit_hash}:{SNAPSHOT_PATH}"),
                         capture_output=True, text=True, check=True).stdout
    return json.loads(raw)


def obs_stale(observed, snap_dt):
    obs_dt = parse_iso(observed.get("validTime"))
    if not obs_dt or not snap_dt:
        return True
    return (snap_dt - obs_dt).total_seconds() > STALE_HOURS * 3600


def fold_backfill(gauges, bbox):
    """Seed peaks from history.json's src-tagged pre-archive frames; returns first backfill stamp."""
    try:
        with open(os.path.join(ROOT, HISTORY_PATH), encoding="utf-8") as f:
            hist = json.load(f)
    except (OSError, ValueError) as e:
        print(f"warn: {HISTORY_PATH} unavailable ({e}); pre-archive peaks omitted", file=sys.stderr)
        return None
    index = hist.get("gaugeIndex", {})
    first_t = None
    for fr in hist.get("frames", []):
        if not fr.get("src"):
            continue
        t = fr.get("t")
        if not t or not parse_iso(t):
            continue
        first_t = first_t or t
        for lid, pair in (fr.get("gauges") or {}).items():
            gi = index.get(lid) or {}
            if not in_bbox(gi.get("lat"), gi.get("lon"), bbox):
                continue
            try:
                stage, code = pair[0], pair[1]
            except (IndexError, TypeError):
                continue
            cat = CODE_CAT.get(code)
            if cat is None or not isinstance(stage, (int, float)):
                continue
            rec = gauges.setdefault(lid, {
                "lid": lid, "name": (index.get(lid) or {}).get("name", lid),
                "peak": None, "peak_time": None, "peak_category": None,
                "peak_stale": False, "peak_src": None, "unit": "ft",
                "first_in_flood": t, "last_in_flood": t,
            })
            rec["last_in_flood"] = t
            if rec["peak"] is None or stage > rec["peak"]:
                rec["peak"] = stage
                rec["peak_time"] = t
                rec["peak_category"] = cat
                rec["peak_stale"] = False
                rec["peak_src"] = "usgs"
    return first_t


def walk(commits, gauges, bbox):
    skipped = 0
    first_snap = last_snap = None
    for chash, _ciso in commits:
        try:
            snap = load_snapshot(chash)
            snap_iso = snap["generated"]
            snap_dt = parse_iso(snap_iso)
            if not snap_dt:
                raise ValueError(f"bad generated stamp {snap_iso!r}")
            rows = snap["gauges"]
        except (subprocess.CalledProcessError, ValueError, KeyError, TypeError):
            skipped += 1
            continue
        first_snap = first_snap or snap_iso
        last_snap = snap_iso
        for g in rows:
            try:
                observed = g["status"]["observed"]
                cat = observed.get("floodCategory")
                if cat not in FLOOD_CATS:
                    continue
                stage = observed.get("primary")
                if not isinstance(stage, (int, float)) or stage <= -999:
                    continue
                lid = g["lid"]
            except (KeyError, TypeError):
                continue
            if not in_bbox(g.get("latitude"), g.get("longitude"), bbox):
                continue
            rec = gauges.setdefault(lid, {
                "lid": lid, "name": g.get("name", lid), "peak": None, "peak_time": None,
                "peak_category": None, "peak_stale": False, "peak_src": None,
                "unit": observed.get("primaryUnit") or "ft",
                "first_in_flood": snap_iso, "last_in_flood": snap_iso,
            })
            rec["last_in_flood"] = snap_iso
            if rec["peak"] is None or stage > rec["peak"]:
                rec["peak"] = stage
                rec["peak_time"] = snap_iso
                rec["peak_category"] = cat
                rec["peak_stale"] = obs_stale(observed, snap_dt)
                rec["peak_src"] = None
    return gauges, skipped, first_snap, last_snap


def mark_ongoing(gauges, last_snap):
    for rec in gauges.values():
        rec["ongoing"] = rec["last_in_flood"] == last_snap
        if rec["ongoing"]:
            rec["last_in_flood"] = "ongoing"


def add_record_context(gauges):
    try:
        with open(os.path.join(ROOT, "data", "records.json"), encoding="utf-8") as f:
            records = json.load(f).get("records", {})
    except (OSError, ValueError):
        records = {}
    for lid, rec in gauges.items():
        r = records.get(lid)
        if not r or not isinstance(r.get("record_ft"), (int, float)) or r["record_ft"] <= 0:
            continue
        pct = rec["peak"] / r["record_ft"]
        rec["record"] = {
            "record_ft": r["record_ft"],
            "record_date": r.get("record_date", ""),
            "peak_pct": round(pct * 100, 1),
            "exceeded": rec["peak"] >= r["record_ft"],
            "approached": (not rec["peak"] >= r["record_ft"]) and pct > RECORD_NEAR_PCT,
        }


def main():
    commits = snapshot_commits()
    if not commits:
        sys.exit("no committed snapshots found — nothing to summarize")
    ev = load_event()
    bbox = event_bbox(ev)
    gauges = {}
    backfill_from = fold_backfill(gauges, bbox)
    gauges, skipped, first_snap, last_snap = walk(commits, gauges, bbox)
    if not gauges:
        sys.exit("no gauges reached minor+ flood in the snapshot history")
    mark_ongoing(gauges, last_snap)
    add_record_context(gauges)
    rows = sorted(gauges.values(), key=lambda r: (-CAT_RANK[r["peak_category"]], -r["peak"]))
    n_backfill = 0
    for r in rows:
        r["stale"] = r.pop("peak_stale")
        src = r.pop("peak_src", None)
        if src:
            r["src"] = src
            n_backfill += 1
    now = datetime.datetime.now(datetime.timezone.utc)
    out = {
        "generated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "event": event_name(ev, now),
        "window": {"first": backfill_from or first_snap, "last": last_snap},
        "source": "NOAA NWS/NWPS observed stages via committed gauges-snapshot.json archive; "
                  "pre-archive window backfilled from USGS/NWPS observed via history.json",
        "gauges": rows,
        "skipped_commits": skipped,
    }
    if backfill_from:
        out["backfill"] = {"from": backfill_from, "until": first_snap, "src": "usgs"}
    path = os.path.join(ROOT, "data", "crest-summary.json")
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".crest-summary.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=1)
            f.write("\n")
        os.replace(tmp, path)
    except Exception:  # noqa: BLE001, cleanup: drop the temp file, then re-raise
        os.unlink(tmp)
        raise
    print(f"crest-summary.json: {len(commits)} commits walked ({skipped} skipped), "
          f"{len(rows)} gauges ({n_backfill} peaks from backfill), "
          f"window {out['window']['first']} → {last_snap}")
    for r in rows:
        bits = [f"{r['lid']} {r['peak']} {r['unit']} {r['peak_category']} @ {r['peak_time']}"]
        if r.get("src"):
            bits.append(f"src:{r['src']}")
        if r["stale"]:
            bits.append("STALE")
        if r["ongoing"]:
            bits.append("ongoing")
        if r.get("record"):
            bits.append(f"record {r['record']['record_ft']} ({r['record']['peak_pct']}%)")
        print("  " + " · ".join(bits))


if __name__ == "__main__":
    main()
