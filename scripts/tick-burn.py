#!/usr/bin/env python3
"""tick-burn.py [--days N] [--json] — measure what the revival tick actually costs.

Reads the Claude Code session transcripts for this project and attributes model
requests and tokens to the tick that caused them, so a cadence change is argued
from measurement rather than from a number written down once and left to rot.

A tick's cost is requests x session-context size, and the second factor is the
one that surprises: the same IDLE verdict is cheap in a fresh session and
expensive in a saturated one, because every request re-reads the accumulated
context. Both factors are reported separately for that reason.

Exit 0 on a real measurement, 3 when no transcripts could be read. A missing
transcript directory is reported as unknown, never as zero burn.
"""
import argparse
import collections
import glob
import json
import os
import sys

TRANSCRIPTS = os.environ.get(
    "RESPONDER_TRANSCRIPT_DIR",
    "/root/.claude/projects/-root-admin-work-proj-responder",
)
TICK_MARKER = "AUTONOMOUS REVIVAL TICK"
CHEAP_MAX_REQUESTS = 4  # a gate-obeying idle tick is the gate call plus a one-line reply


def _is_real_user_turn(content):
    """True for an owner/keyboard message, false for a tool result carrying a turn on."""
    if isinstance(content, str):
        return True
    if isinstance(content, list):
        return not any(
            isinstance(b, dict) and b.get("type") == "tool_result" for b in content
        )
    return False


def collect(since_day):
    """-> (ticks, files_read). Each tick: ts, session, requests, cache_read, output."""
    ticks, files_read = [], 0
    for path in sorted(glob.glob(os.path.join(TRANSCRIPTS, "*.jsonl"))):
        try:
            handle = open(path, "r", errors="replace")
        except OSError:
            continue
        files_read += 1
        current = None
        with handle:
            for line in handle:
                if '"usage"' not in line and TICK_MARKER not in line:
                    continue  # cheap prefilter: transcripts run to hundreds of MB
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                stamp = record.get("timestamp", "")
                if record.get("type") == "user":
                    content = record.get("message", {}).get("content")
                    blob = content if isinstance(content, str) else json.dumps(content)[:4000]
                    if TICK_MARKER in blob:
                        if current:
                            ticks.append(current)
                        current = {
                            "ts": stamp,
                            "session": os.path.basename(path)[:8],
                            "requests": 0,
                            "cache_read": 0,
                            "output": 0,
                        }
                    elif not record.get("isMeta") and _is_real_user_turn(content):
                        if current:
                            ticks.append(current)
                        current = None  # a keyboard turn ends tick attribution
                    continue
                usage = record.get("message", {}).get("usage")
                if not usage or not current:
                    continue
                current["requests"] += 1
                current["cache_read"] += usage.get("cache_read_input_tokens", 0)
                current["output"] += usage.get("output_tokens", 0)
        if current:
            ticks.append(current)
    ticks = [t for t in ticks if t["ts"][:10] >= since_day]
    ticks.sort(key=lambda t: t["ts"])
    return ticks, files_read


def summarise(ticks):
    cheap = [t for t in ticks if t["requests"] <= CHEAP_MAX_REQUESTS]
    working = [t for t in ticks if t["requests"] > CHEAP_MAX_REQUESTS]
    days = collections.Counter(t["ts"][:10] for t in ticks)

    def mean(rows, key):
        return sum(r[key] for r in rows) // len(rows) if rows else 0

    return {
        "ticks": len(ticks),
        "days_observed": len(days),
        "ticks_per_active_day": round(len(ticks) / len(days), 1) if days else 0,
        "cache_read_total": sum(t["cache_read"] for t in ticks),
        "cache_read_per_tick": mean(ticks, "cache_read"),
        "cache_read_per_request": (
            sum(t["cache_read"] for t in ticks) // sum(t["requests"] for t in ticks)
            if sum(t["requests"] for t in ticks)
            else 0
        ),
        "gated_ticks": len(cheap),
        "gated_cache_read_per_tick": mean(cheap, "cache_read"),
        "working_ticks": len(working),
        "working_cache_read_per_tick": mean(working, "cache_read"),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", type=int, default=7, help="look-back window (default 7)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--detail", action="store_true", help="one line per tick")
    args = ap.parse_args()

    import datetime

    since = (datetime.date.today() - datetime.timedelta(days=args.days)).isoformat()
    if not os.path.isdir(TRANSCRIPTS):
        # E1: an unreadable source is not a measurement of zero.
        msg = f"UNKNOWN: no transcript directory at {TRANSCRIPTS}; burn not measured"
        print(json.dumps({"status": "unknown", "reason": msg}) if args.json else msg,
              file=sys.stderr)
        return 3

    ticks, files_read = collect(since)
    if not files_read:
        msg = f"UNKNOWN: no readable transcripts in {TRANSCRIPTS}; burn not measured"
        print(json.dumps({"status": "unknown", "reason": msg}) if args.json else msg,
              file=sys.stderr)
        return 3

    stats = summarise(ticks)
    if args.json:
        print(json.dumps({"status": "ok", "since": since, **stats}, indent=2))
        return 0

    print(f"revival-tick burn since {since}  ({files_read} transcripts scanned)")
    if not ticks:
        print("  no ticks fired in this window")
        return 0
    if args.detail:
        print(f"  {'when (UTC)':<18}{'sess':<10}{'req':>5}{'cache_read':>13}{'output':>9}")
        for t in ticks:
            print(f"  {t['ts'][:16]:<18}{t['session']:<10}{t['requests']:>5}"
                  f"{t['cache_read']:>13,}{t['output']:>9,}")
        print()
    print(f"  ticks                  {stats['ticks']} over {stats['days_observed']} active "
          f"days ({stats['ticks_per_active_day']}/day)")
    print(f"  cache read total       {stats['cache_read_total']:,}")
    print(f"  per tick (mean)        {stats['cache_read_per_tick']:,}")
    print(f"  per request (mean)     {stats['cache_read_per_request']:,}"
          "   <- grows with session context, not with the work")
    print(f"  gated ticks            {stats['gated_ticks']} "
          f"(<= {CHEAP_MAX_REQUESTS} req), mean {stats['gated_cache_read_per_tick']:,}")
    print(f"  working ticks          {stats['working_ticks']}, "
          f"mean {stats['working_cache_read_per_tick']:,}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
