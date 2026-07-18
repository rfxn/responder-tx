#!/usr/bin/env python3
"""Generate data/history.json — the playback archive of observed gauge states.

Walks the committed history of data/gauges-snapshot.json (one snapshot every
~15 min for the life of the event) and emits one compact frame per snapshot:
observed stage + flood category per gauge, thinned to at most one frame per
15 minutes. Drives the v0.82 historical-playback timeline. Run at release
time like gen-crest-summary.py. Honest by construction: gauges whose category
the live board hides (out_of_service / obs_not_current / not_defined) are
omitted, stale observations (>12h behind the snapshot) are flagged via a
negative category code so the client badges them, nothing is interpolated.

Frame category code: 0=none 1=action 2=minor 3=moderate 4=major;
stale observations are encoded as -(code+1) so stale-at-none survives (-1).
"""
import datetime
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAPSHOT_PATH = "data/gauges-snapshot.json"
OUT_PATH = "data/history.json"
CAT_CODE = {"no_flooding": 0, "action": 1, "minor": 2, "moderate": 3, "major": 4}
STALE_HOURS = 12
FRAME_MIN_GAP_S = 14 * 60          # cadence is ~15 min with jitter; 14 min keeps one per cycle
SIZE_BUDGET = 600 * 1024
THIN_KEEP_FULL_DAYS = 3            # over budget: >3d-old frames thin to 30-min spacing
THIN_OLD_GAP_S = 29 * 60


def git(*args):
    return subprocess.run(("git", "-C", ROOT) + args, capture_output=True, text=True, check=True).stdout


def parse_iso(s):
    try:
        return datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def snapshot_commits():
    out = git("log", "--format=%H %cI", "--follow", "--", SNAPSHOT_PATH)
    commits = [line.split(" ", 1) for line in out.splitlines() if line.strip()]
    commits.reverse()
    return commits


def load_snapshot(commit_hash):
    raw = subprocess.run(("git", "-C", ROOT, "show", f"{commit_hash}:{SNAPSHOT_PATH}"),
                         capture_output=True, text=True, check=True).stdout
    return json.loads(raw)


def frame_from(snap, snap_dt, gauge_index):
    gauges = {}
    for g in snap["gauges"]:
        try:
            lid = g["lid"]
            observed = g["status"]["observed"]
            cat = observed.get("floodCategory")
            stage = observed.get("primary")
        except (KeyError, TypeError):
            continue
        if cat not in CAT_CODE or not isinstance(stage, (int, float)) or stage <= -999:
            continue
        code = CAT_CODE[cat]
        obs_dt = parse_iso(observed.get("validTime"))
        if not obs_dt or (snap_dt - obs_dt).total_seconds() > STALE_HOURS * 3600:
            code = -(code + 1)
        gauges[lid] = [round(stage, 2), code]
        if lid not in gauge_index:
            gauge_index[lid] = {"name": g.get("name", lid),
                                "lat": round(g.get("latitude", 0), 4),
                                "lon": round(g.get("longitude", 0), 4)}
    return gauges


def walk(commits):
    frames = []
    gauge_index = {}
    skipped = 0
    last_kept = None
    for chash, _ciso in commits:
        try:
            snap = load_snapshot(chash)
            snap_dt = parse_iso(snap["generated"])
            if not snap_dt:
                raise ValueError(f"bad generated stamp {snap['generated']!r}")
        except (subprocess.CalledProcessError, ValueError, KeyError, TypeError):
            skipped += 1
            continue
        if last_kept and (snap_dt - last_kept).total_seconds() < FRAME_MIN_GAP_S:
            continue
        gauges = frame_from(snap, snap_dt, gauge_index)
        if not gauges:
            skipped += 1
            continue
        frames.append({"t": snap["generated"], "gauges": gauges, "_dt": snap_dt})
        last_kept = snap_dt
    return frames, gauge_index, skipped


def thin_old_frames(frames):
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=THIN_KEEP_FULL_DAYS)
    kept, last_old = [], None
    for f in frames:
        if f["_dt"] >= cutoff:
            kept.append(f)
            continue
        if last_old and (f["_dt"] - last_old).total_seconds() < THIN_OLD_GAP_S:
            continue
        kept.append(f)
        last_old = f["_dt"]
    return kept


def serialize(frames, gauge_index):
    out = {
        "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "frames": [{"t": f["t"], "gauges": f["gauges"]} for f in frames],
        "gaugeIndex": gauge_index,
    }
    return json.dumps(out, separators=(",", ":")) + "\n"


def main():
    commits = snapshot_commits()
    if not commits:
        sys.exit("no committed snapshots found — nothing to archive")
    frames, gauge_index, skipped = walk(commits)
    if not frames:
        sys.exit("no usable frames in the snapshot history")
    payload = serialize(frames, gauge_index)
    thinned = False
    if len(payload) > SIZE_BUDGET:
        frames = thin_old_frames(frames)
        payload = serialize(frames, gauge_index)
        thinned = True
    with open(os.path.join(ROOT, OUT_PATH), "w", encoding="utf-8") as f:
        f.write(payload)
    print(f"history.json: {len(commits)} commits walked ({skipped} skipped), "
          f"{len(frames)} frames, {len(gauge_index)} gauges indexed, "
          f"{len(payload)} bytes ({len(payload) / 1024:.1f} KB)"
          f"{' — thinned >3d-old frames to 30-min' if thinned else ''}")
    print(f"  window {frames[0]['t']} → {frames[-1]['t']}")


if __name__ == "__main__":
    main()
