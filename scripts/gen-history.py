#!/usr/bin/env python3
"""Generate data/history.json — the playback archive of observed gauge states.

Two layers, deliberately separated. RETENTION walks the committed history of
data/gauges-capture.json (falling back to data/gauges-snapshot.json for commits
older than the capture split) and keeps every gauge it ever saw, with no
geographic filter anywhere in the path. PUBLICATION then projects that retained
set through the board's display scope. A display-scope change can therefore
narrow what the board shows and can never delete a stored observation: the
2026-07-23 coastal pivot retroactively pruned 18 days of Hill Country frames
because the old code filtered re-walked frames against the *current* bbox.

Publication scope is the union of every gaugeBbox this repo has ever committed
in data/event.json, plus every lid already present in the published
history.json. Both terms only ever grow, so the published record is a ratchet.

Provenance vocabulary on each frame (see js/playback.js updatePlaybackNote):
  src absent  natively captured by our own snapshot cycle
  "usgs"      rebuilt from the USGS instantaneous-values archive
  "nwps"      rebuilt from the NWPS 30-day observed buffer
  "git"       recovered verbatim from one of our own earlier commits ("ref")
A recovered frame never overwrites a natively captured frame at the same
timestamp; recovery only fills gaps.

Frame category code: 0=none 1=action 2=minor 3=moderate 4=major;
stale observations are encoded as -(code+1) so stale-at-none survives (-1).

A pre-archive backfill stage (skippable with --no-backfill, failures non-fatal)
prepends hourly frames for the window between the archive floor and the earliest
retained frame, read first from the local NWPS rescue buffer in
archive/recovered/nwps-30d/ and then from the USGS IV and NWPS APIs, categorized
against NWPS flood thresholds cached in data/gauge-meta.json. A gauge with no
cached flood scale is left out of those frames rather than coded as not-in-flood.

Frame contract (hazard-agnostic, additive — future hazard sources add a
parallel per-frame array + a top-level index, existing keys never rename):
  {frames:[{t, gauges:{lid:[stage,code]}, roads:[rid,...], src?, ref?}],
   gaugeIndex:{lid:{name,lat,lon}}, roadIndex:{rid:{cond,route,v,start,end}},
   roadsFrom:ISO, retained:{frames,gauges,roads?}, thinned?:{...}}
Roads run the same two layers. RETENTION walks the committed history of
data/roads-capture.json (falling back to data/roads-snapshot.json for commits
older than the capture split), so an AO pivot that empties the display snapshot
cannot stop new closures entering the record. PUBLICATION then projects that
retained set through the same bbox ratchet the gauges use, so roadIndex stays
display-scoped while the archive behind it stays statewide. Road state per frame
is the union of two signals: presence in that archive (frames at/after roadsFrom)
and the record's own posted start/end window (the only signal before roadsFrom,
which the client labels reconstructed rather than archived).

The record publishes chunked under history/: history/index.json carries the
gauge/road indexes plus one descriptor per UTC day, and history/day/YYYY-MM-DD.json
carries that day's frames and nothing else. A day payload holds no build stamp, so
a frozen day hashes identically every cycle; the index publishes that hash and the
client puts it in the query string, which is what makes an immutable cache header
on the day files a fact rather than a promise. That chunked record is the whole
record and the only thing this script reads back.

data/history.json is a bounded compatibility view for clients cached from before
the chunk index existed: the newest COMPAT_WINDOW_DAYS of frames, the record's
whole gauge/road index, and a top-level "view" object naming its depth and
pointing at the full archive. Bounding it is what makes the per-cycle git cost
constant instead of growing with archive depth; the "view" object is what keeps a
partial file from reading as a complete one.
"""
import bisect
import datetime
import glob
import gzip
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.environ.get("RESPONDER_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAPTURE_PATH = "data/gauges-capture.json"
SNAPSHOT_PATH = "data/gauges-snapshot.json"
EVENT_PATH = "data/event.json"
ROADS_CAPTURE_PATH = "data/roads-capture.json"
ROADS_PATH = "data/roads-snapshot.json"
OUT_PATH = "data/history.json"
CHUNK_INDEX_PATH = "history/index.json"
CHUNK_DAY_DIR = "history/day"
CHUNK_FORMAT = 1
CHUNK_HASH_LEN = 12
# data/history.json publishes this much of the tail. 7 matches a UI range chip and the
# BACKFILL_FALLBACK_DAYS floor below, so the fallback file's depth is not a third number.
COMPAT_WINDOW_DAYS = 7
GAUGE_META_PATH = "data/gauge-meta.json"
RECOVERED_DIR = "archive/recovered"
NWPS_RESCUE_DIR = "archive/recovered/nwps-30d"
CAT_CODE = {"no_flooding": 0, "action": 1, "minor": 2, "moderate": 3, "major": 4}
STALE_HOURS = 12
FRAME_MIN_GAP_S = 14 * 60          # cadence is ~15 min with jitter; 14 min keeps one per cycle
# raised from 600 KB in v0.97.97: the pre-2026-07-23 record fits whole, and the wire cost is
# gzip, where the full file is ~230 KB. Thinning past this point keeps every crest frame.
SIZE_BUDGET = 3000 * 1024
THIN_KEEP_FULL_DAYS = 3            # over budget: >3d-old frames thin to 30-min spacing
THIN_OLD_GAP_S = 29 * 60

BACKFILL_FALLBACK_DAYS = 7         # no archive floor in data/event.json: rolling window
TOTAL_SIZE_BUDGET = 3600 * 1024    # over budget: thin reconstruction from 1-hour to 2-hour spacing
NWPS_GAUGE_URL = "https://api.water.noaa.gov/nwps/v1/gauges/"
USGS_IV_URL = "https://waterservices.usgs.gov/nwis/iv/"
USGS_SITES_PER_REQ = 10
FETCH_SPACING_S = 0.2
THRESHOLD_KEYS = ("action", "minor", "moderate", "major")
META_MISS_KEY = "miss"             # entry present but never answered: retried, never read as thresholds
META_MISS_RETRY_S = 3600
EPOCH = datetime.datetime.min.replace(tzinfo=datetime.timezone.utc)  # sort floor for an unparseable commit stamp


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


def load_event():
    try:
        with open(os.path.join(ROOT, "data", "event.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def bbox_of(b):
    try:
        return (float(b["xmin"]), float(b["ymin"]), float(b["xmax"]), float(b["ymax"]))
    except (KeyError, TypeError, ValueError):
        return None


def event_bboxes(ev):
    """Every gaugeBbox this repo has ever declared, current first. Publication scope
    is their union, so narrowing the live display never un-publishes past frames."""
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


def archive_floor(ev):
    """How far back reconstruction may reach. Deliberately NOT event.json "start":
    that is the display start of the current event and moves with an AO pivot,
    which silently killed the whole backfill stage once already."""
    for key in ("archiveStart", "backfillStart"):
        dt = parse_iso(ev.get(key))
        if dt:
            return dt.astimezone(datetime.timezone.utc)
    return (datetime.datetime.now(datetime.timezone.utc)
            - datetime.timedelta(days=BACKFILL_FALLBACK_DAYS))


def snapshot_commits():
    """Commits touching either capture or display snapshot, oldest first. The capture
    file only exists from the 2026-07-24 split forward; older commits carry the
    display snapshot alone, which was the widest thing captured at the time."""
    seen, order = {}, {}
    for path in (CAPTURE_PATH, SNAPSHOT_PATH):
        lines = [ln for ln in git("log", "--format=%H %cI", "--follow", "--", path).splitlines() if ln.strip()]
        for line in reversed(lines):  # git log is newest-first; reverse gives parent-before-child
            chash, ciso = line.split(" ", 1)
            if chash not in seen:
                seen[chash] = ciso
                order[chash] = len(order)
    # parse %cI before sorting (its per-commit UTC offset defeats string order), and keep the
    # reversed-log position as the tiebreak so same-second commits stay in ancestry order
    return sorted(seen.items(),
                  key=lambda kv: (parse_iso(kv[1]) or EPOCH, order[kv[0]]))


def load_snapshot(commit_hash):
    """Widest gauge set available at this commit: capture if it exists, else display."""
    try:
        return json.loads(git_blob(commit_hash, CAPTURE_PATH))
    except (subprocess.CalledProcessError, ValueError):
        return json.loads(git_blob(commit_hash, SNAPSHOT_PATH))


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
    """Retention layer. No geographic filter exists here by design."""
    frames = []
    gauge_index = {}
    unreadable = empty = 0
    last_kept = None
    for chash, _ciso in commits:
        try:
            snap = load_snapshot(chash)
            snap_dt = parse_iso(snap["generated"])
            if not snap_dt:
                raise ValueError(f"bad generated stamp {snap['generated']!r}")
        except (subprocess.CalledProcessError, ValueError, KeyError, TypeError):
            unreadable += 1
            continue
        if last_kept and (snap_dt - last_kept).total_seconds() < FRAME_MIN_GAP_S:
            continue
        gauges = frame_from(snap, snap_dt, gauge_index)
        if not gauges:
            empty += 1  # snapshot readable but no gauge reported a usable observation
            continue
        frames.append({"t": snap["generated"], "gauges": gauges, "_dt": snap_dt})
        last_kept = snap_dt
    return frames, gauge_index, unreadable, empty


def recovered_sources():
    """Recovered history blobs staged under archive/, newest commit first."""
    prov = {}
    try:
        with open(os.path.join(ROOT, RECOVERED_DIR, "_provenance.json"), encoding="utf-8") as f:
            doc = json.load(f)
        for entry in doc.get("files", []):
            if entry.get("was") == OUT_PATH and entry.get("path"):
                prov[entry["path"]] = (doc.get("source_commit") or "")[:7]
    except (OSError, ValueError, AttributeError, TypeError) as e:  # noqa: BLE001 — recovery is optional
        print(f"note: no recovered-history provenance ({e})", file=sys.stderr)
    out = []
    for path in sorted(glob.glob(os.path.join(ROOT, RECOVERED_DIR, "history-*.json"))):
        out.append((path, prov.get(os.path.basename(path), "")))
    return out


def merge_gap_frames(frames, gauge_index, doc, default_src, ref=""):
    """Fill timestamp gaps in the retained set. Native capture at a timestamp always
    wins: recovery never overwrites and never edits a natively captured frame."""
    have = {f["t"] for f in frames}
    index = (doc.get("gaugeIndex") or {}) if isinstance(doc, dict) else {}
    added = 0
    for fr in (doc.get("frames") or []):
        t = fr.get("t")
        dt = parse_iso(t)
        if not t or not dt or t in have:
            continue
        gauges = {lid: v for lid, v in (fr.get("gauges") or {}).items()
                  if isinstance(v, list) and len(v) >= 2}
        if not gauges:
            continue
        out = {"t": t, "gauges": gauges, "_dt": dt, "src": fr.get("src") or default_src}
        src_ref = fr.get("ref") or ref
        if src_ref:
            out["ref"] = src_ref
        frames.append(out)
        have.add(t)
        added += 1
        for lid in gauges:
            if lid not in gauge_index and lid in index:
                gi = index[lid]
                gauge_index[lid] = {"name": gi.get("name", lid),
                                    "lat": gi.get("lat", 0), "lon": gi.get("lon", 0)}
    frames.sort(key=lambda f: f["_dt"])
    return added


def merge_recovered(frames, gauge_index, prev):
    """Two recovery sources, both gap-fill only: the blobs staged under archive/ and the
    reconstructed frames already in the published file. The second is what keeps a fixed
    historical window from being re-pulled from upstream on every 15-minute cycle."""
    added = 0
    for path, ref in recovered_sources():
        try:
            with open(path, encoding="utf-8") as f:
                doc = json.load(f)
        except (OSError, ValueError) as e:  # noqa: BLE001 — a bad recovery blob must not break the cycle
            print(f"warn: recovered history {os.path.basename(path)} unreadable ({e})", file=sys.stderr)
            continue
        added += merge_gap_frames(frames, gauge_index, doc, "git", ref)
    reconstructed = {"frames": [f for f in (prev.get("frames") or []) if f.get("src")],
                     "gaugeIndex": prev.get("gaugeIndex") or {}}
    added += merge_gap_frames(frames, gauge_index, reconstructed, "git")
    return added


def scope_lids(gauge_index, boxes, sticky_lids):
    """Publication scope: any gauge inside a bbox this board has ever declared, plus any
    gauge already published. Both terms only grow, so scope is a ratchet."""
    return {lid for lid, gi in gauge_index.items()
            if lid in sticky_lids or in_any_bbox(gi.get("lat"), gi.get("lon"), boxes)}


def project_display(frames, gauge_index, keep):
    """Publication layer. The ONLY place display scope is applied. Returns published
    frames + index and the counts held back, so the artifact can say the record is
    wider than the view instead of pretending the held-back gauges never reported."""
    out, out_of_scope = [], 0
    for f in frames:
        gauges = {lid: v for lid, v in f["gauges"].items() if lid in keep}
        if not gauges:
            out_of_scope += 1  # the frame HAS observations, none in display scope
            continue
        pub = dict(f)
        pub["gauges"] = gauges
        out.append(pub)
    seen = set()
    for f in out:
        seen.update(f["gauges"])
    index = {lid: gauge_index[lid] for lid in gauge_index if lid in seen}
    return out, index, out_of_scope, len(gauge_index) - len(keep)


def read_chunked_record():
    """The whole published record, reassembled from history/index.json + history/day/. Raises
    if the chunk set is unusable so the caller can fall back."""
    with open(os.path.join(ROOT, CHUNK_INDEX_PATH), encoding="utf-8") as f:
        idx = json.load(f)
    frames = []
    for day in (idx.get("days") or []):
        with open(os.path.join(ROOT, CHUNK_DAY_DIR, "%s.json" % day["d"]), encoding="utf-8") as f:
            frames.extend(json.load(f).get("frames") or [])
    if not frames:
        raise ValueError("chunk index lists no frames")
    doc = {"frames": frames, "gaugeIndex": idx.get("gaugeIndex") or {}}
    if idx.get("roadIndex"):
        doc["roadIndex"] = idx["roadIndex"]
    return doc


def load_published():
    """The previously published record. Read from the chunks, NOT from data/history.json: that
    file is now a bounded tail, and the reconstruction this re-uses lives at the record's head,
    so reading it here would re-pull the whole backfill window from upstream every cycle.

    This is the sticky term of the publication ratchet, so a record that EXISTS and cannot be
    read stops the run. Defaulting it to empty would let a read failure narrow publication
    scope and un-publish gauges, which is the v0.97.97 prune in a new disguise. Only a record
    that is genuinely absent is an empty one."""
    idx_path = os.path.join(ROOT, CHUNK_INDEX_PATH)
    out_path = os.path.join(ROOT, OUT_PATH)
    if os.path.exists(idx_path):
        try:
            return read_chunked_record()
        except (OSError, ValueError, KeyError, TypeError) as e:
            sys.exit(f"published record {CHUNK_INDEX_PATH} exists but is unreadable ({e}); "
                     "refusing to republish, because a scope that cannot be read cannot be "
                     "shown to have only grown")
    if not os.path.exists(out_path):
        return {}
    print(f"note: no chunk index; reading {OUT_PATH} instead", file=sys.stderr)
    try:
        with open(out_path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        sys.exit(f"published record {OUT_PATH} exists but is unreadable ({e}); refusing to "
                 "republish, because a scope that cannot be read cannot be shown to have "
                 "only grown")


def compat_view(frames):
    """The bounded tail published as data/history.json, plus the object that declares it one.
    Anchored on the newest frame rather than the clock, so a stalled cycle narrows nothing."""
    if not frames:
        return frames, None
    cut = frames[-1]["_dt"] - datetime.timedelta(days=COMPAT_WINDOW_DAYS)
    kept = [f for f in frames if f["_dt"] >= cut]
    if len(kept) == len(frames):
        return frames, None  # the record is younger than the window: the view IS the record
    return kept, {
        "kind": "recent-window",
        "days": COMPAT_WINDOW_DAYS,
        "from": kept[0]["t"],
        "frames": len(kept),
        "note": "Recent-window view, not the whole record. The full archive is %s plus %s/YYYY-MM-DD.json."
                % (CHUNK_INDEX_PATH, CHUNK_DAY_DIR),
        "full": {"index": CHUNK_INDEX_PATH, "day": "%s/YYYY-MM-DD.json" % CHUNK_DAY_DIR,
                 "frames": len(frames), "from": frames[0]["t"], "to": frames[-1]["t"]},
    }


def peak_frame_indices(frames):
    """Frames holding a gauge's highest observed stage. Thinning may coarsen the record
    but must never drop the moment a river crested."""
    best = {}
    for i, f in enumerate(frames):
        for lid, v in f["gauges"].items():
            if lid not in best or v[0] > best[lid][0]:
                best[lid] = (v[0], i)
    return {i for _, i in best.values()}


def thin_old_frames(frames):
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=THIN_KEEP_FULL_DAYS)
    protect = peak_frame_indices(frames)
    kept, last_old = [], None
    for i, f in enumerate(frames):
        if f["_dt"] >= cutoff or i in protect:
            kept.append(f)
            continue
        if last_old and (f["_dt"] - last_old).total_seconds() < THIN_OLD_GAP_S:
            continue
        kept.append(f)
        last_old = f["_dt"]
    return kept, cutoff


# identity across snapshots: OBJECTIDs are null/unstable in the archive; vertex coords
# disambiguate distinct closures on the same route batch-posted the same minute
def road_key(rec):
    v = rec.get("v") or ()
    lat = round(v[0], 4) if len(v) > 1 and isinstance(v[0], (int, float)) else None
    lon = round(v[1], 4) if len(v) > 1 and isinstance(v[1], (int, float)) else None
    return f"{rec.get('route')}|{rec.get('start')}|{lat},{lon}"


def load_road_snapshot(commit_hash):
    """Widest road set available at this commit: statewide capture if it exists, else display."""
    try:
        return json.loads(git_blob(commit_hash, ROADS_CAPTURE_PATH))
    except (subprocess.CalledProcessError, ValueError):
        return json.loads(git_blob(commit_hash, ROADS_PATH))


def road_snapshots():
    """Retention layer for roads. No display filter exists here by design."""
    out = git("log", "--format=%H", "--", ROADS_CAPTURE_PATH, ROADS_PATH).split()
    snaps = []
    index, rid_by_key = {}, {}
    for chash in reversed(out):
        try:
            snap = load_road_snapshot(chash)
            snap_dt = parse_iso(snap["generated"])
            if not snap_dt:
                raise ValueError(f"bad generated stamp {snap['generated']!r}")
        except (subprocess.CalledProcessError, ValueError, KeyError, TypeError):
            continue
        present = set()
        for rec in snap.get("roads", []):
            if not isinstance(rec.get("v"), list) or not rec.get("start"):
                continue
            key = road_key(rec)
            rid = rid_by_key.setdefault(key, len(rid_by_key))
            index[rid] = {"cond": rec.get("cond"), "route": rec.get("route"), "v": rec["v"],
                          "start": rec.get("start"), "end": rec.get("end")}  # latest-seen wins (ends get extended)
            present.add(rid)
        snaps.append({"dt": snap_dt, "iso": snap["generated"], "present": present})
    snaps.sort(key=lambda s: s["dt"])
    return snaps, index


def scope_rids(index, boxes, sticky_keys):
    """Publication scope for roads: any closure inside a bbox this board has ever declared,
    plus any closure already published. Both terms only grow, so scope is a ratchet."""
    keep = set()
    for rid, e in index.items():
        v = e.get("v") or [None, None]
        if road_key(e) in sticky_keys or in_any_bbox(v[0], v[1], boxes):
            keep.add(rid)
    return keep


def apply_road_history(frames, boxes, sticky_keys):
    snaps, index = road_snapshots()
    if not snaps:
        for f in frames:
            f.pop("roads", None)  # salvaged backfill frames may carry stale road lists
        return None, None, 0, 0, 0, 0
    keep = scope_rids(index, boxes, sticky_keys)
    windows = []
    for rid, e in index.items():
        s, en = parse_iso(e["start"]), parse_iso(e["end"])
        if s:
            windows.append((rid, s.astimezone(datetime.timezone.utc),
                            en.astimezone(datetime.timezone.utc) if en else None))
    snap_times = [s["dt"] for s in snaps]
    roads_from = snaps[0]["dt"]
    recon = arch = 0
    for f in frames:
        t = f["_dt"]
        active = {rid for rid, s, en in windows if s <= t and (en is None or t < en)}
        i = bisect.bisect_right(snap_times, t) - 1
        if i >= 0:
            active |= snaps[i]["present"]
        active &= keep  # the ONLY place display scope touches roads
        f["roads"] = sorted(active)  # assign even when empty — overwrites stale salvaged road lists
        if active:
            if t >= roads_from:
                arch += 1
            else:
                recon += 1
    road_index = {str(rid): e for rid, e in index.items() if rid in keep}
    return road_index, snaps[0]["iso"], recon, arch, len(index) - len(keep), len(index)


def emit_frame(f):
    frame = {"t": f["t"], "gauges": f["gauges"]}
    if f.get("roads"):
        frame["roads"] = f["roads"]
    for key in ("src", "ref"):
        if f.get(key):
            frame[key] = f[key]
    return frame


def serialize(frames, gauge_index, road_index=None, roads_from=None, retained=None, thinned=None,
              view=None):
    out = {"generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    if view:
        out["view"] = view  # before frames on purpose: this file is one line, and the declaration must be readable
    out.update({
        "frames": [emit_frame(f) for f in frames],
        "gaugeIndex": gauge_index,
    })
    if road_index:
        out["roadIndex"] = road_index
        out["roadsFrom"] = roads_from
    if retained:
        out["retained"] = retained
    if thinned:
        out["thinned"] = thinned
    return json.dumps(out, separators=(",", ":")) + "\n"


def write_atomic(path, payload):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".chunk.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
        os.replace(tmp, path)
    except Exception:  # noqa: BLE001, cleanup: drop the temp file, then re-raise
        os.unlink(tmp)
        raise


def write_if_changed(path, payload):
    """A byte-identical rewrite is skipped so a frozen day stays out of the commit."""
    try:
        with open(path, encoding="utf-8") as f:
            if f.read() == payload:
                return False
    except OSError:
        pass
    write_atomic(path, payload)
    return True


def day_payload(day, frames):
    return json.dumps({"d": day, "frames": [emit_frame(f) for f in frames]},
                      separators=(",", ":")) + "\n"


def write_chunks(frames, index_meta):
    """Publish the record as one index plus one file per UTC day, and delete day files
    no longer covered so a stale chunk can never outlive the record it came from."""
    day_dir = os.path.join(ROOT, CHUNK_DAY_DIR)
    os.makedirs(day_dir, exist_ok=True)
    by_day = {}
    for f in frames:
        by_day.setdefault(f["_dt"].strftime("%Y-%m-%d"), []).append(f)
    days, written = [], 0
    for day in sorted(by_day):
        group = by_day[day]
        payload = day_payload(day, group)
        if write_if_changed(os.path.join(day_dir, day + ".json"), payload):
            written += 1
        days.append({"d": day, "n": len(group), "t0": group[0]["t"], "t1": group[-1]["t"],
                     "bytes": len(payload),
                     "h": hashlib.sha256(payload.encode("utf-8")).hexdigest()[:CHUNK_HASH_LEN]})
    keep = {day + ".json" for day in by_day}
    stale = [n for n in os.listdir(day_dir) if n.endswith(".json") and n not in keep]
    for name in stale:
        os.unlink(os.path.join(day_dir, name))
    index = {"generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
             "format": CHUNK_FORMAT, "frames": len(frames)}
    index.update(index_meta)
    index["days"] = days
    write_atomic(os.path.join(ROOT, CHUNK_INDEX_PATH), json.dumps(index, separators=(",", ":")) + "\n")
    return days, written, len(stale)


def http_json(url, timeout=90):
    req = urllib.request.Request(url, headers={"User-Agent": "responder-ops-board/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def meta_due(entry, now):
    """A never-answered entry is due again once its retry window passes. An unparseable stamp
    is due immediately, so a malformed marker can never become the permanent cache."""
    if not isinstance(entry, dict):
        return True
    stamp = entry.get(META_MISS_KEY)
    if not stamp:
        return False
    dt = parse_iso(stamp)
    return not dt or (now - dt).total_seconds() >= META_MISS_RETRY_S


def load_gauge_meta(lids):
    """Cached NWPS flood thresholds. A fetch that never answered is recorded as a miss and
    retried later; it is NEVER stored in the shape of a gauge with no thresholds, because
    cat_from_stage would then read it as a published "not in flood" at any stage."""
    meta_path = os.path.join(ROOT, GAUGE_META_PATH)
    meta = {}
    if os.path.exists(meta_path):
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
    now = datetime.datetime.now(datetime.timezone.utc)
    missing = [lid for lid in sorted(lids) if lid not in meta or meta_due(meta[lid], now)]
    misses = 0
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
        except Exception as e:  # noqa: BLE001 — record the miss as a miss, keep fetching the rest
            print(f"  warn: NWPS metadata fetch failed for {lid}: {e}", file=sys.stderr)
            entry[META_MISS_KEY] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
            misses += 1
        meta[lid] = entry
        time.sleep(FETCH_SPACING_S)
    if missing:
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(meta_path), prefix=".gauge-meta.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(meta, f, separators=(",", ":"), sort_keys=True)
                f.write("\n")
            os.replace(tmp, meta_path)
        except Exception:  # noqa: BLE001, cleanup: drop the temp file, then re-raise
            os.unlink(tmp)
            raise
        print(f"gauge-meta.json: fetched {len(missing)} lids from NWPS ({misses} did not answer "
              f"and are queued for retry, not cached as thresholdless), {len(meta)} total cached")
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
    """Category code, or None when this gauge has no flood scale to judge the stage against.
    Without a single threshold the function is the constant 0, which would publish "not in
    flood" at a record crest; the caller omits the gauge instead, exactly as frame_from does
    for a live gauge NWPS reports as not_defined."""
    if not isinstance(entry, dict) or all(entry.get(key) is None for key in THRESHOLD_KEYS):
        return None
    code = 0
    for level, key in enumerate(THRESHOLD_KEYS, start=1):
        threshold = entry.get(key)
        if threshold is not None and stage >= threshold:
            code = level
    return code


def observed_points(data, start_dt, end_dt):
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


def rescue_observed(lid, start_dt, end_dt):
    """Local NWPS 30-day rescue buffer: a free, deterministic first pass so a routine
    regen does not re-pull the same reconstruction window from upstream every cycle."""
    path = os.path.join(ROOT, NWPS_RESCUE_DIR, f"{lid}.json.gz")
    if not os.path.exists(path):
        return []
    try:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return observed_points(json.load(f).get("data") or [], start_dt, end_dt)
    except (OSError, ValueError) as e:  # noqa: BLE001 — a corrupt rescue file falls through to the network
        print(f"  warn: rescue buffer unreadable for {lid}: {e}", file=sys.stderr)
        return []


def fetch_nwps_observed(lid, start_dt, end_dt):
    return observed_points(http_json(f"{NWPS_GAUGE_URL}{lid}/stageflow/observed").get("data", []),
                           start_dt, end_dt)


def build_backfill(lids, first_dt, start_dt):
    """Hourly reconstruction for [start_dt, first_dt): local rescue buffer, then USGS IV,
    then the live NWPS observed endpoint for whatever is still uncovered. Callers pass
    only the lids in publication scope, so a Texas-wide capture cannot turn a one-hour
    gap into a thousand upstream requests."""
    if first_dt <= start_dt or not lids:
        return [], {}
    meta = load_gauge_meta(lids)
    pts_by_lid, src_by_lid = {}, {}
    for lid in sorted(lids):
        pts = rescue_observed(lid, start_dt, first_dt)
        if pts:
            pts_by_lid[lid] = pts
            src_by_lid[lid] = "nwps"
    site_by_lid = {lid: m["usgs"] for lid, m in meta.items()
                   if lid in lids and lid not in pts_by_lid and m.get("usgs")}
    if site_by_lid:
        end_dt = first_dt - datetime.timedelta(seconds=1)
        series = fetch_usgs_series(set(site_by_lid.values()),
                                   start_dt.strftime("%Y-%m-%dT%H:%MZ"),
                                   end_dt.strftime("%Y-%m-%dT%H:%MZ"))
        for lid, site in site_by_lid.items():
            pts = series.get(site)
            if pts:
                pts_by_lid[lid] = pts
                src_by_lid[lid] = "usgs"
    for lid in sorted(lids):
        if lid in pts_by_lid:
            continue
        try:
            pts = fetch_nwps_observed(lid, start_dt, first_dt)
        except Exception as e:  # noqa: BLE001 — per-lid fallback fetch; a miss is an honest gap
            print(f"  warn: NWPS observed fetch failed for {lid}: {e}", file=sys.stderr)
            continue
        if pts:
            pts_by_lid[lid] = pts
            src_by_lid[lid] = "nwps"
        time.sleep(FETCH_SPACING_S)
    times = {lid: [p[0] for p in pts] for lid, pts in pts_by_lid.items()}
    frames = []
    uncategorized = set()
    hour = datetime.timedelta(hours=1)
    t = start_dt
    while t < first_dt:
        gauges, srcs = {}, set()
        for lid, pts in pts_by_lid.items():
            idx = bisect.bisect_right(times[lid], t) - 1
            if idx < 0 or (t - pts[idx][0]) >= hour:
                continue
            stage = pts[idx][1]
            code = cat_from_stage(stage, meta.get(lid))
            if code is None:
                uncategorized.add(lid)  # no flood scale: absent, never coded as not-in-flood
                continue
            gauges[lid] = [round(stage, 2), code]
            srcs.add(src_by_lid[lid])
        if gauges:
            frames.append({"t": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "gauges": gauges,
                           "src": "usgs" if "usgs" in srcs else "nwps", "_dt": t})
        t += hour
    if uncategorized:
        for lid in uncategorized:
            src_by_lid.pop(lid, None)  # fetched but never published: not "covered" in the report
        retry = sorted(lid for lid in uncategorized if (meta.get(lid) or {}).get(META_MISS_KEY))
        print(f"  note: {len(uncategorized)} reconstructed gauge(s) have no flood scale and are "
              f"absent from those frames rather than coded not-in-flood"
              + (f"; {len(retry)} of them are unanswered metadata fetches queued for retry "
                 f"({','.join(retry[:10])})" if retry else ""), file=sys.stderr)
    return frames, src_by_lid


def thin_backfill(frames):
    protect = peak_frame_indices(frames)
    return [f for i, f in enumerate(frames)
            if not f.get("src") or f["_dt"].hour % 2 == 0 or i in protect]


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
    ev = load_event()
    boxes = event_bboxes(ev)
    start_dt = archive_floor(ev)

    frames, gauge_index, unreadable, empty = walk(commits)
    if not frames:
        sys.exit("no usable frames in the snapshot history")
    prev = load_published()
    recovered = merge_recovered(frames, gauge_index, prev)
    keep = scope_lids(gauge_index, boxes, set(prev.get("gaugeIndex") or {}))

    backfill, src_by_lid = [], {}
    if not no_backfill:
        try:
            backfill, src_by_lid = build_backfill(keep, frames[0]["_dt"], start_dt)
        except Exception as e:  # noqa: BLE001 — backfill is best-effort; retained frames must still ship
            print(f"warn: backfill reconstruction failed ({e}); "
                  "publishing the retained archive alone", file=sys.stderr)
    frames = backfill + frames
    retained = {"frames": len(frames), "gauges": len(gauge_index)}

    pub, pub_index, out_of_scope, held = project_display(frames, gauge_index, keep)
    if not pub:
        sys.exit("no frames left after display projection — check event.json gaugeBbox")

    thinned = None
    if len(serialize(pub, pub_index)) > SIZE_BUDGET:
        pub, cutoff = thin_old_frames(pub)
        thinned = {"fullFrom": cutoff.strftime("%Y-%m-%dT%H:%M:%SZ"),
                   "olderGapMinutes": THIN_OLD_GAP_S // 60, "peaksKept": True}
    sticky_roads = {road_key(e) for e in (prev.get("roadIndex") or {}).values()}
    (road_index, roads_from, road_recon, road_arch,
     road_held, road_retained) = apply_road_history(pub, boxes, sticky_roads)
    if road_retained:
        retained["roads"] = road_retained
    payload = serialize(pub, pub_index, road_index, roads_from, retained, thinned)
    if len(payload) > TOTAL_SIZE_BUDGET and any(f.get("src") for f in pub):
        pub = thin_backfill(pub)
        thinned = dict(thinned or {})
        thinned["backfillGapHours"] = 2
        payload = serialize(pub, pub_index, road_index, roads_from, retained, thinned)

    compat, view = compat_view(pub)
    compat_payload = serialize(compat, pub_index, road_index, roads_from, retained, thinned, view)
    write_atomic(os.path.join(ROOT, OUT_PATH), compat_payload)

    index_meta = {"gaugeIndex": pub_index}
    if road_index:
        index_meta["roadIndex"] = road_index
        index_meta["roadsFrom"] = roads_from
    if retained:
        index_meta["retained"] = retained
    if thinned:
        index_meta["thinned"] = thinned
    days, chunks_written, chunks_removed = write_chunks(pub, index_meta)

    n_backfill = sum(1 for f in pub if f.get("src") in ("usgs", "nwps"))
    n_recovered = sum(1 for f in pub if f.get("src") == "git")
    print(f"record: {len(commits)} commits walked ({unreadable} unreadable, {empty} with no "
          f"observation), retained {retained['frames']} frames / {retained['gauges']} gauges "
          f"({recovered} recovered from our own commits), published {len(pub)} frames / "
          f"{len(pub_index)} gauges ({n_backfill} reconstructed + {n_recovered} recovered), "
          f"{len(payload)} bytes ({len(payload) / 1024:.1f} KB)")
    print(f"  window {pub[0]['t']} → {pub[-1]['t']}")
    print(f"compat view {OUT_PATH}: {len(compat)} frames / {len(compat_payload)} bytes "
          f"({len(compat_payload) / 1024:.1f} KB)" +
          (f", last {COMPAT_WINDOW_DAYS}d from {view['from']}" if view else ", whole record (younger than the window)"))
    print(f"chunks: {len(days)} UTC days under {CHUNK_DAY_DIR}/ ({chunks_written} rewritten, "
          f"{len(days) - chunks_written} unchanged, {chunks_removed} removed), "
          f"index {CHUNK_INDEX_PATH}, largest day {max(d['bytes'] for d in days) / 1024:.1f} KB")
    print(f"  display scope: {len(boxes)} bbox(es) ever declared; {held} retained gauges and "
          f"{out_of_scope} retained frames are out of scope, held not deleted")
    if thinned:
        print(f"  THINNED for size: {thinned}")
    if road_index:
        print(f"roads: {road_retained} closures retained, {len(road_index)} published "
              f"({road_held} out of display scope, held not deleted), {road_recon + road_arch} frames with "
              f"road state ({road_recon} reconstructed from posted times, {road_arch} archived), "
              f"archive from {roads_from}")
    else:
        print("roads: no road archive found, road replay omitted")
    if backfill:
        report_backfill(backfill, src_by_lid, len(keep))


if __name__ == "__main__":
    main()
