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

A pre-event backfill stage (skippable with --no-backfill, failures non-fatal)
prepends hourly frames for the window before the first git snapshot, built
from the USGS instantaneous-values archive with the NWPS 30-day observed
archive as per-lid fallback (IBWC gauges never reach NWIS), categorized
against NWPS flood thresholds cached in data/gauge-meta.json. Backfilled
frames carry "src":"usgs"; git-native frames carry no src field.
"""
import bisect
import datetime
import json
import os
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAPSHOT_PATH = "data/gauges-snapshot.json"
OUT_PATH = "data/history.json"
GAUGE_META_PATH = "data/gauge-meta.json"
CAT_CODE = {"no_flooding": 0, "action": 1, "minor": 2, "moderate": 3, "major": 4}
STALE_HOURS = 12
FRAME_MIN_GAP_S = 14 * 60          # cadence is ~15 min with jitter; 14 min keeps one per cycle
SIZE_BUDGET = 600 * 1024
THIN_KEEP_FULL_DAYS = 3            # over budget: >3d-old frames thin to 30-min spacing
THIN_OLD_GAP_S = 29 * 60

BACKFILL_START = "2026-07-05T00:00:00Z"
TOTAL_SIZE_BUDGET = 900 * 1024     # over budget: thin backfill from 1-hour to 2-hour spacing
NWPS_GAUGE_URL = "https://api.water.noaa.gov/nwps/v1/gauges/"
USGS_IV_URL = "https://waterservices.usgs.gov/nwis/iv/"
USGS_SITES_PER_REQ = 10
FETCH_SPACING_S = 0.2
THRESHOLD_KEYS = ("action", "minor", "moderate", "major")


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
    emitted = []
    for f in frames:
        frame = {"t": f["t"], "gauges": f["gauges"]}
        if "src" in f:
            frame["src"] = f["src"]
        emitted.append(frame)
    out = {
        "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "frames": emitted,
        "gaugeIndex": gauge_index,
    }
    return json.dumps(out, separators=(",", ":")) + "\n"


def http_json(url, timeout=90):
    req = urllib.request.Request(url, headers={"User-Agent": "responder-ops-board/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def load_gauge_meta(lids):
    meta_path = os.path.join(ROOT, GAUGE_META_PATH)
    meta = {}
    if os.path.exists(meta_path):
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
    missing = [lid for lid in sorted(lids) if lid not in meta]
    for lid in missing:
        entry = {"usgs": None, "action": None, "minor": None, "moderate": None, "major": None}
        try:
            g = http_json(NWPS_GAUGE_URL + lid)
            usgs = str(g.get("usgsId") or "").strip()
            entry["usgs"] = usgs or None
            cats = ((g.get("flood") or {}).get("categories") or {})
            for key in THRESHOLD_KEYS:
                stage = (cats.get(key) or {}).get("stage")
                if isinstance(stage, (int, float)) and stage > -999:
                    entry[key] = stage
        except Exception as e:  # noqa: BLE001 — cache the miss, keep fetching the rest
            print(f"  warn: NWPS metadata fetch failed for {lid}: {e}", file=sys.stderr)
        meta[lid] = entry
        time.sleep(FETCH_SPACING_S)
    if missing:
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, separators=(",", ":"), sort_keys=True)
            f.write("\n")
        print(f"gauge-meta.json: fetched {len(missing)} lids from NWPS, {len(meta)} total cached")
    return meta


def fetch_usgs_series(site_ids, start_iso, end_iso):
    series = {}
    site_ids = sorted(site_ids)
    for i in range(0, len(site_ids), USGS_SITES_PER_REQ):
        chunk = site_ids[i:i + USGS_SITES_PER_REQ]
        url = (f"{USGS_IV_URL}?format=json&sites={','.join(chunk)}"
               f"&parameterCd=00065&startDT={start_iso}&endDT={end_iso}")
        data = http_json(url, timeout=180)
        for ts in data.get("value", {}).get("timeSeries", []):
            site = ts["sourceInfo"]["siteCode"][0]["value"]
            blocks = ts.get("values") or []
            vals = max(blocks, key=lambda b: len(b.get("value", [])), default={}).get("value", [])
            pts = []
            for v in vals:
                try:
                    stage = float(v["value"])
                except (KeyError, ValueError, TypeError):
                    continue
                dt = parse_iso(v.get("dateTime"))
                if stage <= -999 or not dt:
                    continue
                pts.append((dt.astimezone(datetime.timezone.utc), stage))
            pts.sort()
            if len(pts) > len(series.get(site, ())):
                series[site] = pts
        time.sleep(FETCH_SPACING_S)
    return series


def cat_from_stage(stage, entry):
    code = 0
    for level, key in enumerate(THRESHOLD_KEYS, start=1):
        threshold = entry.get(key)
        if threshold is not None and stage >= threshold:
            code = level
    return code


def fetch_nwps_observed(lid, start_dt, end_dt):
    data = http_json(f"{NWPS_GAUGE_URL}{lid}/stageflow/observed").get("data", [])
    pts = []
    for v in data:
        stage = v.get("primary")
        dt = parse_iso(v.get("validTime"))
        if not isinstance(stage, (int, float)) or stage <= -999 or not dt:
            continue
        dt = dt.astimezone(datetime.timezone.utc)
        if start_dt <= dt < end_dt:
            pts.append((dt, stage))
    pts.sort()
    return pts


def build_backfill(gauge_index, first_git_dt):
    meta = load_gauge_meta(gauge_index.keys())
    site_by_lid = {lid: m["usgs"] for lid, m in meta.items()
                   if lid in gauge_index and m.get("usgs")}
    start_dt = parse_iso(BACKFILL_START)
    if first_git_dt <= start_dt:
        return [], {}
    end_dt = first_git_dt - datetime.timedelta(seconds=1)
    series = fetch_usgs_series(set(site_by_lid.values()),
                               start_dt.strftime("%Y-%m-%dT%H:%MZ"),
                               end_dt.strftime("%Y-%m-%dT%H:%MZ"))
    pts_by_lid, src_by_lid = {}, {}
    for lid, site in site_by_lid.items():
        pts = series.get(site)
        if pts:
            pts_by_lid[lid] = pts
            src_by_lid[lid] = "usgs"
    for lid in sorted(gauge_index):
        if lid in pts_by_lid:
            continue
        try:
            pts = fetch_nwps_observed(lid, start_dt, first_git_dt)
        except Exception as e:  # noqa: BLE001 — per-lid fallback fetch; a miss is an honest gap
            print(f"  warn: NWPS observed fetch failed for {lid}: {e}", file=sys.stderr)
            continue
        if pts:
            pts_by_lid[lid] = pts
            src_by_lid[lid] = "nwps"
        time.sleep(FETCH_SPACING_S)
    times = {lid: [p[0] for p in pts] for lid, pts in pts_by_lid.items()}
    frames = []
    hour = datetime.timedelta(hours=1)
    t = start_dt
    while t < first_git_dt:
        gauges = {}
        for lid, pts in pts_by_lid.items():
            idx = bisect.bisect_right(times[lid], t) - 1
            if idx < 0 or (t - pts[idx][0]) >= hour:
                continue
            stage = pts[idx][1]
            gauges[lid] = [round(stage, 2), cat_from_stage(stage, meta[lid])]
        if gauges:
            frames.append({"t": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "gauges": gauges,
                           "src": "usgs", "_dt": t})
        t += hour
    return frames, src_by_lid


def thin_backfill(frames):
    return [f for f in frames if "src" not in f or f["_dt"].hour % 2 == 0]


def report_backfill(backfill, src_by_lid, lid_count):
    majors_by_day = {}
    for f in backfill:
        day = f["t"][:10]
        majors_by_day.setdefault(day, set())
        for lid, (stage, code) in f["gauges"].items():
            if code == 4:
                majors_by_day[day].add(lid)
    n_usgs = sum(1 for s in src_by_lid.values() if s == "usgs")
    n_nwps = sum(1 for s in src_by_lid.values() if s == "nwps")
    print(f"backfill: {len(backfill)} frames, {len(src_by_lid)} of {lid_count} lids covered "
          f"({n_usgs} usgs-iv, {n_nwps} nwps-observed)")
    for day in sorted(majors_by_day):
        lids = majors_by_day[day]
        print(f"  {day}: majors={len(lids)}" + (f" ({','.join(sorted(lids))})" if lids else ""))


def main():
    no_backfill = "--no-backfill" in sys.argv[1:]
    commits = snapshot_commits()
    if not commits:
        sys.exit("no committed snapshots found — nothing to archive")
    frames, gauge_index, skipped = walk(commits)
    if not frames:
        sys.exit("no usable frames in the snapshot history")
    if len(serialize(frames, gauge_index)) > SIZE_BUDGET:
        frames = thin_old_frames(frames)
    backfill, src_by_lid = [], {}
    if not no_backfill:
        try:
            backfill, src_by_lid = build_backfill(gauge_index, frames[0]["_dt"])
        except Exception as e:  # noqa: BLE001 — backfill is best-effort; git frames must still ship
            print(f"warn: backfill failed, emitting git frames only: {e}", file=sys.stderr)
    git_count = len(frames)
    frames = backfill + frames
    payload = serialize(frames, gauge_index)
    thinned = False
    if len(payload) > TOTAL_SIZE_BUDGET and backfill:
        frames = thin_backfill(frames)
        backfill = [f for f in frames if f.get("src") == "usgs"]
        payload = serialize(frames, gauge_index)
        thinned = True
    with open(os.path.join(ROOT, OUT_PATH), "w", encoding="utf-8") as f:
        f.write(payload)
    print(f"history.json: {len(commits)} commits walked ({skipped} skipped), "
          f"{len(frames)} frames ({len(backfill)} usgs backfill + {git_count} git), "
          f"{len(gauge_index)} gauges indexed, "
          f"{len(payload)} bytes ({len(payload) / 1024:.1f} KB)"
          f"{' — thinned backfill to 2-hour' if thinned else ''}")
    print(f"  window {frames[0]['t']} → {frames[-1]['t']}")
    if backfill:
        report_backfill(backfill, src_by_lid, len(gauge_index))


if __name__ == "__main__":
    main()
