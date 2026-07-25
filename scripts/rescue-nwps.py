#!/usr/bin/env python3
"""Pull the NWPS 30-day observed buffer for every gauge lid this repo has ever seen.

One-shot recovery tool, not part of the cycle. The NWPS observed endpoint serves a
30-day rolling buffer and takes no date parameters, so an observation is only
retrievable from it for 30 days after it is recorded. Writes one gzipped verbatim
response per lid under archive/recovered/nwps-30d/ plus a manifest recording
provenance, per-lid outcome, and observed coverage. See scripts/README.md.
"""
import argparse
import datetime
import gzip
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAPSHOT_PATH = "data/gauges-snapshot.json"
HISTORY_PATH = "data/history.json"
PIN_TAG = "preprune-history-2026-07-23"
OUT_DIR = os.path.join(ROOT, "archive", "recovered", "nwps-30d")
MANIFEST = "_manifest.json"
NWPS_OBSERVED_URL = "https://api.water.noaa.gov/nwps/v1/gauges/{lid}/stageflow/observed"
UA = "responder-tx-ops/rescue-nwps (rfxnryan@gmail.com)"
FETCH_SPACING_S = 0.2
BACKOFFS = [3, 8, 20]


def git(*args):
    return subprocess.run(("git", "-C", ROOT) + args,
                          capture_output=True, text=True, check=True).stdout


def git_show(ref_path):
    r = subprocess.run(("git", "-C", ROOT, "show", ref_path),
                       capture_output=True, text=True)
    if r.returncode != 0:
        return None
    try:
        return json.loads(r.stdout)
    except ValueError:
        return None


def add_lid(seen, lid, name, lat, lon):
    if not lid or not isinstance(lid, str):
        return
    rec = seen.setdefault(lid, {"name": None, "lat": None, "lon": None})
    if name and not rec["name"]:
        rec["name"] = name
    if isinstance(lat, (int, float)) and rec["lat"] is None:
        rec["lat"] = round(lat, 4)
    if isinstance(lon, (int, float)) and rec["lon"] is None:
        rec["lon"] = round(lon, 4)


def ever_seen_lids(progress=True):
    """Union of lids across every committed gauges-snapshot plus both history gaugeIndexes."""
    seen = {}
    commits = [c for c in git("log", "--format=%H", "--follow",
                              "--", SNAPSHOT_PATH).split() if c]
    for i, chash in enumerate(commits, 1):
        snap = git_show(f"{chash}:{SNAPSHOT_PATH}")
        if not isinstance(snap, dict):
            continue
        for g in snap.get("gauges") or []:
            add_lid(seen, g.get("lid"), g.get("name"),
                    g.get("latitude"), g.get("longitude"))
        if progress and i % 100 == 0:
            print(f"  scanned {i}/{len(commits)} snapshot commits, {len(seen)} lids",
                  file=sys.stderr)
    for ref in (f"{PIN_TAG}:{HISTORY_PATH}", f"HEAD:{HISTORY_PATH}"):
        hist = git_show(ref)
        if not isinstance(hist, dict):
            continue
        for lid, gi in (hist.get("gaugeIndex") or {}).items():
            gi = gi if isinstance(gi, dict) else {}
            add_lid(seen, lid, gi.get("name"), gi.get("lat"), gi.get("lon"))
    print(f"ever-seen lids: {len(seen)} across {len(commits)} snapshot commits")
    return seen


def fetch_observed(lid):
    """Returns (raw_bytes, error). Transient failures retry; a hard 4xx gives up at once."""
    req = urllib.request.Request(NWPS_OBSERVED_URL.format(lid=lid),
                                 headers={"User-Agent": UA, "Accept": "application/json"})
    for attempt in range(len(BACKOFFS) + 1):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read(), None
        except Exception as e:  # noqa: BLE001 — any failure is per-lid, never fatal to the run
            transient = (not isinstance(e, urllib.error.HTTPError)
                         or e.code == 429 or 500 <= e.code < 600)
            if attempt < len(BACKOFFS) and transient:
                time.sleep(BACKOFFS[attempt])
                continue
            return None, f"{type(e).__name__}: {e}"
    return None, "exhausted"


def atomic_write(path, data, compress=False):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path),
                               prefix="." + os.path.basename(path) + ".", suffix=".tmp")
    try:
        if compress:
            with os.fdopen(fd, "wb") as fh:
                with gzip.GzipFile(filename="", mode="wb", fileobj=fh, mtime=0) as gz:
                    gz.write(data)
        else:
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
        os.replace(tmp, path)
    except Exception:
        os.unlink(tmp)
        raise
    return os.path.getsize(path)


def coverage(raw):
    try:
        pts = json.loads(raw).get("data") or []
    except ValueError:
        return None
    if not pts:
        return {"points": 0, "first": None, "last": None}
    return {"points": len(pts),
            "first": pts[0].get("validTime"),
            "last": pts[-1].get("validTime")}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="report the lid union and planned output, make no requests")
    ap.add_argument("--limit", type=int, default=0, help="stop after N lids (smoke test)")
    args = ap.parse_args()

    seen = ever_seen_lids()
    lids = sorted(seen)
    if args.limit:
        lids = lids[:args.limit]

    if args.dry_run:
        print(f"dry-run: would fetch {len(lids)} lids into {OUT_DIR}")
        print(f"dry-run: ~{len(lids) * FETCH_SPACING_S:.0f}s of inter-request spacing alone")
        print(f"dry-run: sample {lids[:5]} ... {lids[-3:]}")
        return 0

    os.makedirs(OUT_DIR, exist_ok=True)
    started = datetime.datetime.now(datetime.timezone.utc)
    entries, ok, failed, total_bytes = {}, 0, 0, 0
    for i, lid in enumerate(lids, 1):
        raw, err = fetch_observed(lid)
        if raw is None:
            entries[lid] = {"status": "failed", "error": err}
            failed += 1
            print(f"  warn: {lid} failed: {err}", file=sys.stderr)
        else:
            n = atomic_write(os.path.join(OUT_DIR, f"{lid}.json.gz"), raw, compress=True)
            total_bytes += n
            ok += 1
            entries[lid] = {"status": "ok", "file": f"{lid}.json.gz", "gz_bytes": n,
                            "raw_bytes": len(raw), "name": seen[lid]["name"],
                            "lat": seen[lid]["lat"], "lon": seen[lid]["lon"],
                            "coverage": coverage(raw)}
        if i % 50 == 0:
            print(f"  {i}/{len(lids)} lids, {ok} ok, {failed} failed, "
                  f"{total_bytes / 1048576:.1f} MB", file=sys.stderr)
        time.sleep(FETCH_SPACING_S)

    finished = datetime.datetime.now(datetime.timezone.utc)
    manifest = {
        "generated": finished.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "started": started.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tool": "scripts/rescue-nwps.py",
        "source": NWPS_OBSERVED_URL.format(lid="<lid>"),
        "why": ("NWPS observed serves a 30-day rolling buffer with no date parameters; "
                "this is a one-shot rescue of the South/Central Texas capture gap that "
                "opened 2026-07-23T14:39Z when the AO pivot narrowed the capture bbox"),
        "repo_head": git("rev-parse", "HEAD").strip(),
        "lids_attempted": len(lids), "lids_ok": ok, "lids_failed": failed,
        "gz_bytes": total_bytes, "encoding": "gzip verbatim NWPS response body",
        "lids": entries,
    }
    atomic_write(os.path.join(OUT_DIR, MANIFEST),
                 (json.dumps(manifest, indent=1) + "\n").encode("utf-8"))
    print(f"rescue-nwps: {ok} ok, {failed} failed, {total_bytes / 1048576:.1f} MB gz "
          f"in {(finished - started).total_seconds():.0f}s -> {OUT_DIR}")
    return 1 if ok == 0 else 0


if __name__ == "__main__":
    sys.exit(main())
