#!/usr/bin/env python3
"""Publish bounds for data/changes.json. gen-changes.py drops any line that fails them,
cycle-check.sh gates on them, and run-cycle.sh runs this file to restore a bad log from HEAD
rather than let it stop the publish. Exit 1 names the first problem."""
import datetime
import json
import os
import sys

KINDS = ("crest", "flood", "warn", "road", "xing", "risk", "shelter")
GAUGE_KINDS = ("crest", "flood")
TIME_KINDS = ("s", "d")
FUTURE_SLACK = datetime.timedelta(minutes=10)
RETAIN_SLACK = datetime.timedelta(hours=1)
STATE_V = 1


def parse_iso(s):
    dt = datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=datetime.timezone.utc)


def event_problem(e, gen_at, keep_days):
    """Why one line may not publish against a run stamped gen_at, or None."""
    if not isinstance(e, dict) or not e.get("id"):
        return "id missing"
    if e.get("k") not in KINDS or e.get("tk") not in TIME_KINDS or not e.get("src"):
        return "kind %r, time kind %r, src %r" % (e.get("k"), e.get("tk"), e.get("src"))
    try:
        t, seen = parse_iso(e["t"]), parse_iso(e["seen"])
    except (KeyError, TypeError, ValueError):
        return "unreadable t/seen"
    if seen > gen_at or t > seen + FUTURE_SLACK:
        return "dated after the run or the observation that reported it"
    if seen < gen_at - datetime.timedelta(days=keep_days) - RETAIN_SLACK:
        return "seen %s is past the %dd retention window" % (e["seen"], keep_days)
    if e["k"] in GAUGE_KINDS and not e.get("lid"):
        return "gauge event names no lid"
    if e["k"] not in GAUGE_KINDS and (not e.get("key") or not e.get("act")):
        return "names no key/act"
    return None


def payload_problem(d):
    if not isinstance(d, dict) or not d.get("generated") or not isinstance(d.get("events"), list) \
            or not isinstance(d.get("sources"), dict):
        return "generated/events[]/sources{} missing"
    try:
        gen_at = parse_iso(d["generated"])
    except (TypeError, ValueError):
        return "generated %r is not an ISO stamp" % (d.get("generated"),)
    keep = d.get("retainDays")
    if isinstance(keep, bool) or not isinstance(keep, int) or keep < 1:
        return "retainDays %r is not a positive day count" % (keep,)
    for name, s in d["sources"].items():
        if not isinstance(s, dict) or not s.get("src"):
            return "sources.%s names no src" % name
        try:
            if s.get("at") is not None and parse_iso(s["at"]) > gen_at:
                return "sources.%s at %s is later than generated" % (name, s["at"])
        except (TypeError, ValueError):
            return "sources.%s at is not an ISO stamp" % name
    ids = set()
    for i, e in enumerate(d["events"]):
        problem = event_problem(e, gen_at, keep)
        if problem is None and e["id"] in ids:
            problem = "id repeated"
        if problem:
            return "events[%d] %s" % (i, problem)
        ids.add(e["id"])
    return None


def state_problem(doc):
    if not isinstance(doc, dict) or doc.get("v") != STATE_V or not isinstance(doc.get("sources"), dict):
        return "state is not a v%d object with sources{}" % STATE_V
    return None


def files_problem(root):
    """The first problem with the working copies the cycle is about to commit, or None."""
    for rel, judge in (("data/changes.json", payload_problem), ("data/changes-state.json", state_problem)):
        path = os.path.join(root, rel)
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                doc = json.load(f)
        except (OSError, ValueError) as e:
            return "%s unreadable: %s" % (rel, e)
        problem = judge(doc)
        if problem:
            return "%s: %s" % (rel, problem)
    return None


if __name__ == "__main__":
    found = files_problem(os.environ.get("RESPONDER_ROOT") or os.getcwd())
    if found:
        print(found)
        sys.exit(1)
