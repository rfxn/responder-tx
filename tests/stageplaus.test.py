#!/usr/bin/env python3
"""tests/stageplaus.test.py · scripts/stageplaus.py on synthetic series (major stage 20 ft).

A high reading nothing has reported after yet is unconfirmed and stands: both generators walk the
uncommitted capture last, so a voided "latest" reading withheld every rising gauge's newest high reading
at every publish, and a gauge that went silent at its crest lost its rising limb for good. Only a first
later reading, however late, that falls under half of it contradicts it.
Run: python3 tests/stageplaus.test.py"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("stageplaus", os.path.join(HERE, "..", "scripts", "stageplaus.py"))
sp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sp)

FAILS = 0


def check(name, ok, detail=""):
    global FAILS
    print("%s: %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else " -> %s" % (detail,)))
    if not ok:
        FAILS += 1


def dropped(series, major=20.0, record=None):
    """series of (minute, stage) -> the minutes the rule publishes as no reading."""
    p = sp.Plausibility({"G": (record, major)})
    for minute, stage in series:
        p.observe("G", minute * 60, stage)
    return sorted(t // 60 for _, t in p.dropped())


cases = [
    ("MUTATION · a 15-min rise still live at the newest reading keeps it (8/12/16/21)",
     [(0, 8), (15, 12), (30, 16), (45, 21)], []),
    ("MUTATION · a gauge that goes silent at its crest keeps its rising limb (10/14/19/23/27, then nothing)",
     [(0, 10), (15, 14), (30, 19), (45, 23), (60, 27)], []),
    ("MUTATION · the same gauge back two hours later at 22 ft confirms its crest",
     [(0, 10), (15, 14), (30, 19), (45, 23), (60, 27), (180, 22)], []),
    ("MUTATION · an hourly 24 ft reading after a 2 h gap to 15 ft stands (12/24, gap, 15)",
     [(0, 12), (60, 24), (240, 15)], []),
    ("a 15-min spike that falls straight back is no reading (6/30/6)",
     [(0, 6), (15, 30), (30, 6)], [15]),
    ("an hourly flash crest whose recession holds above half stands (3.36/7.15/17.35/10.3, major 16)",
     [(0, 3.36), (60, 7.15), (120, 17.35), (180, 10.3)], []),
    ("a spike contradicted hours later is still no reading (16.3/48.5, 3 h silence, 16.5; record 44.3)",
     [(0, 16.3), (60, 48.5), (240, 16.5)], [60]),
]
for name, series, want in cases:
    major = 16.0 if "major 16" in name else (None if "record 44.3" in name else 20.0)
    record = 44.3 if "record 44.3" in name else None
    got = dropped(series, major, record)
    check(name, got == want, got)

print("----")
if FAILS == 0:
    print("ALL STAGEPLAUS TESTS PASSED")
    sys.exit(0)
print("%d TEST(S) FAILED" % FAILS)
sys.exit(1)
