#!/usr/bin/env python3
"""Generate data/crest-summary.json — per-gauge event peak stages for AAR/FEMA documentation.

Walks the committed history of data/gauges-capture.json (falling back to
data/gauges-snapshot.json before the capture split) and records, for every gauge
that reached an observed minor/moderate/major flood category, its peak stage,
when the peak first occurred, and its in-flood window. The git archive starts
mid-event, so the pre-archive window is folded in from the playback archive's
src-tagged frames (reconstructed or recovered, built by gen-history.py); peaks
sourced there carry that frame's own src. Run at release time like gen-feeds.py.

That fold reads the chunked record under history/, not data/history.json: the
latter is a bounded recent-window view and the reconstruction sits at the head of
the record, outside it. data/history.json remains the fallback for a checkout
that predates the chunk index.

Scope works the same way as gen-history.py: the walk retains every gauge, and
the display filter is applied once, at the end, against the union of every
gaugeBbox this repo has ever committed. A display-scope change narrows the live
board and never deletes a recorded peak.

Honest by construction: peaks whose observation was stale at peak time are
flagged, not dropped; nothing is interpolated or invented.
"""
import datetime
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.environ.get("RESPONDER_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAPTURE_PATH = "data/gauges-capture.json"
SNAPSHOT_PATH = "data/gauges-snapshot.json"
EVENT_PATH = "data/event.json"
HISTORY_PATH = "data/history.json"
CHUNK_INDEX_PATH = "history/index.json"
CHUNK_DAY_DIR = "history/day"
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


def bbox_of(b):
    try:
        return (float(b["xmin"]), float(b["ymin"]), float(b["xmax"]), float(b["ymax"]))
    except (KeyError, TypeError, ValueError):
        return None


def event_bboxes(ev):
    """Every gaugeBbox this repo has ever declared, current first; their union is the
    publication scope, so narrowing the live display never un-publishes a past peak."""
    boxes = []
    cur = bbox_of(ev.get("gaugeBbox") or {})
    if cur:
        boxes.append(cur)
    try:
        hashes = git("log", "--format=%H", "--follow", "--", EVENT_PATH).split()
    except subprocess.CalledProcessError:
        return boxes
    for chash in hashes:
        try:
            b = bbox_of((json.loads(git_blob(chash, EVENT_PATH)).get("gaugeBbox") or {}))
        except (subprocess.CalledProcessError, ValueError, AttributeError):
            continue
        if b and b not in boxes:
            boxes.append(b)
    return boxes


def in_any_bbox(lat, lon, boxes):
    if not boxes:
        return True
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return False
    return any(b[0] <= lon <= b[2] and b[1] <= lat <= b[3] for b in boxes)


def git(*args):
    return subprocess.run(("git", "-C", ROOT) + args, capture_output=True, text=True, check=True).stdout


def git_blob(commit_hash, path):
    return subprocess.run(("git", "-C", ROOT, "show", f"{commit_hash}:{path}"),
                          capture_output=True, text=True, check=True).stdout


def parse_iso(s):
    try:
        dt = datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:  # offset-less upstream stamp — assume UTC, never return naive
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt


def snapshot_commits():
    """Commits touching either capture or display snapshot, oldest first."""
    seen = {}
    for path in (CAPTURE_PATH, SNAPSHOT_PATH):
        for line in git("log", "--format=%H %cI", "--follow", "--", path).splitlines():
            if not line.strip():
                continue
            chash, ciso = line.split(" ", 1)
            seen.setdefault(chash, ciso)
    # parse before sorting: %cI carries per-commit UTC offsets, so the raw strings do not
    # sort chronologically once the committer's timezone changes
    return sorted(seen.items(),
                  key=lambda kv: parse_iso(kv[1]) or datetime.datetime.min.replace(
                      tzinfo=datetime.timezone.utc))


def load_snapshot(commit_hash):
    """Widest gauge set available at this commit: capture if it exists, else display."""
    try:
        return json.loads(git_blob(commit_hash, CAPTURE_PATH))
    except (subprocess.CalledProcessError, ValueError):
        return json.loads(git_blob(commit_hash, SNAPSHOT_PATH))


def obs_stale(observed, snap_dt):
    obs_dt = parse_iso(observed.get("validTime"))
    if not obs_dt or not snap_dt:
        return True
    return (snap_dt - obs_dt).total_seconds() > STALE_HOURS * 3600


def read_chunked_record():
    """The whole playback archive, reassembled from history/index.json + history/day/. Raises
    if the chunk set is unusable so the caller can fall back."""
    with open(os.path.join(ROOT, CHUNK_INDEX_PATH), encoding="utf-8") as f:
        idx = json.load(f)
    frames = []
    for day in (idx.get("days") or []):
        with open(os.path.join(ROOT, CHUNK_DAY_DIR, "%s.json" % day["d"]), encoding="utf-8") as f:
            frames.extend(json.load(f).get("frames") or [])
    if not frames:
        raise ValueError("chunk index lists no frames")
    return {"frames": frames, "gaugeIndex": idx.get("gaugeIndex") or {}}


def load_archive():
    """The playback archive, whole. data/history.json is only the bounded fallback: a peak that
    predates its window must still reach the AAR."""
    try:
        return read_chunked_record()
    except (OSError, ValueError, KeyError, TypeError) as e:
        print(f"note: chunked record unreadable ({e}); falling back to {HISTORY_PATH}", file=sys.stderr)
    try:
        with open(os.path.join(ROOT, HISTORY_PATH), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        print(f"warn: {HISTORY_PATH} unavailable ({e}); pre-archive peaks omitted", file=sys.stderr)
        return {}


def fold_backfill(gauges):
    """Seed peaks from the archive's src-tagged pre-archive frames; returns first such
    stamp. No scope filter here: scoping happens once, in project_display()."""
    hist = load_archive()
    index = hist.get("gaugeIndex", {})
    first_t = None
    for fr in hist.get("frames", []):
        if not fr.get("src"):
            continue
        t = fr.get("t")
        if not t or not parse_iso(t):
            continue
        first_t = first_t or t
        src = fr.get("src")
        for lid, pair in (fr.get("gauges") or {}).items():
            try:
                stage, code = pair[0], pair[1]
            except (IndexError, TypeError):
                continue
            cat = CODE_CAT.get(code)
            if cat is None or not isinstance(stage, (int, float)):
                continue
            gi = index.get(lid) or {}
            rec = gauges.setdefault(lid, {
                "lid": lid, "name": gi.get("name", lid),
                "lat": gi.get("lat"), "lon": gi.get("lon"),
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
                rec["peak_src"] = src
    return first_t


def walk(commits, gauges):
    """Retention layer: every gauge that ever flooded, no geographic filter."""
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
            rec = gauges.setdefault(lid, {
                "lid": lid, "name": g.get("name", lid),
                "lat": g.get("latitude"), "lon": g.get("longitude"),
                "peak": None, "peak_time": None,
                "peak_category": None, "peak_stale": False, "peak_src": None,
                "unit": observed.get("primaryUnit") or "ft",
                "first_in_flood": snap_iso, "last_in_flood": snap_iso,
            })
            rec["last_in_flood"] = snap_iso
            if rec.get("lat") is None:
                rec["lat"], rec["lon"] = g.get("latitude"), g.get("longitude")
            if rec["peak"] is None or stage > rec["peak"]:
                rec["peak"] = stage
                rec["peak_time"] = snap_iso
                rec["peak_category"] = cat
                rec["peak_stale"] = obs_stale(observed, snap_dt)
                rec["peak_src"] = None
    return gauges, skipped, first_snap, last_snap


def published_lids():
    """Every gauge already in the published summary. Scope is a ratchet: a peak this
    board has reported once is never un-reported by a later display-scope change."""
    try:
        with open(os.path.join(ROOT, "data", "crest-summary.json"), encoding="utf-8") as f:
            return {g.get("lid") for g in (json.load(f).get("gauges") or [])}
    except (OSError, ValueError):
        return set()


def project_display(gauges, boxes, sticky):
    """Publication layer. The ONLY place display scope is applied."""
    keep, held = {}, 0
    for lid, rec in gauges.items():
        if lid in sticky or in_any_bbox(rec.get("lat"), rec.get("lon"), boxes):
            keep[lid] = rec
        else:
            held += 1
    return keep, held


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
    boxes = event_bboxes(ev)
    gauges = {}
    backfill_from = fold_backfill(gauges)
    gauges, skipped, first_snap, last_snap = walk(commits, gauges)
    if not gauges:
        sys.exit("no gauges reached minor+ flood in the snapshot history")
    retained = len(gauges)
    gauges, held = project_display(gauges, boxes, published_lids())
    if not gauges:
        sys.exit("no gauges left after display projection — check event.json gaugeBbox")
    mark_ongoing(gauges, last_snap)
    add_record_context(gauges)
    rows = sorted(gauges.values(), key=lambda r: (-CAT_RANK[r["peak_category"]], -r["peak"]))
    n_backfill = 0
    for r in rows:
        r.pop("lat", None)
        r.pop("lon", None)
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
                  "pre-archive window reconstructed from USGS/NWPS observed via the chunked "
                  "playback archive under history/",
        "gauges": rows,
        "retained_gauges": retained,
        "skipped_commits": skipped,
    }
    if backfill_from:
        out["backfill"] = {"from": backfill_from, "until": first_snap,
                           "src": sorted({r["src"] for r in rows if r.get("src")}) or ["usgs"]}
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
          f"retained {retained} gauges, published {len(rows)} ({n_backfill} peaks from "
          f"reconstruction/recovery, {held} out of display scope, held not deleted), "
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
