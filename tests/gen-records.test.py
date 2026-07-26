#!/usr/bin/env python3
"""tests/gen-records.test.py — the floors that stop a degraded NWPS overwriting a good
data/records.json, against a fixture root (RESPONDER_ROOT override, never the real data/).
MIN_RECORDS is a fixed number that does not follow the gauge network as it grows, so the
floor that matters is the one measured against what was last published. Covers: an absent
previous file is a first run, an unreadable one refuses before any fetch, a collapsed run
is refused, and an ordinary run still publishes. No network: fetch_gauge is stubbed.
Run: python3 tests/gen-records.test.py"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
GEN = os.path.join(HERE, '..', 'scripts', 'gen-records.py')

FAILS = 0


def check(name, ok, detail=''):
    global FAILS
    print('%s: %s%s' % ('PASS' if ok else 'FAIL', name, (' · ' + detail) if (detail and not ok) else ''))
    if not ok:
        FAILS += 1


def load_gen(root):
    """Import gen-records.py with ROOT pinned at a fixture; module import does no network."""
    os.environ['RESPONDER_ROOT'] = root
    spec = importlib.util.spec_from_file_location('gen_records_%d' % id(root), GEN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.FETCH_SPACING_S = 0  # the real 0.2s spacing is upstream politeness, not behaviour under test
    return mod


def fixture(gauges, prev_records=None):
    """A repo root with a gauge snapshot and, optionally, a previously published records file."""
    root = tempfile.mkdtemp(prefix='responder-records-test.')
    os.makedirs(os.path.join(root, 'data'))
    snap = {'generated': '2026-07-26T00:00:00Z',
            'gauges': [{'lid': 'FX%04d' % i, 'name': 'Fixture %d' % i} for i in range(gauges)]}
    with open(os.path.join(root, 'data', 'gauges-snapshot.json'), 'w', encoding='utf-8') as f:
        json.dump(snap, f)
    if prev_records is not None:
        payload = {'generated': '2026-07-01T00:00:00Z', 'source': 'fixture', 'note': 'fixture',
                   'records': {'FX%04d' % i: {'name': 'Fixture %d' % i, 'record_ft': 20.0,
                                              'record_date': '1998-10-18'}
                               for i in range(prev_records)}}
        with open(os.path.join(root, 'data', 'records.json'), 'w', encoding='utf-8') as f:
            json.dump(payload, f)
    return root


def crest(lid):
    return {'name': 'Gauge %s' % lid,
            'flood': {'crests': {'historic': [{'stage': 20.5, 'occurredTime': '1998-10-18T00:00:00Z'}]}}}


def stub_fetch(mod, yielding):
    """Answer a crest for the first N lids and nothing for the rest; count the calls."""
    calls = []

    def fetch_gauge(lid):
        calls.append(lid)
        return crest(lid) if len(calls) <= yielding else None

    mod.fetch_gauge = fetch_gauge
    return calls


def run_main(mod):
    """Run main(), returning ('ok', '') or ('exit', message)."""
    try:
        mod.main()
    except SystemExit as exc:
        return 'exit', str(exc)
    return 'ok', ''


def records_in(root):
    with open(os.path.join(root, 'data', 'records.json'), encoding='utf-8') as f:
        return json.load(f)['records']


# ---------------------------------------------------------------------------
# The defect MIN_RECORDS cannot see: a broadly failing NWPS that still clears 50. The file
# published 216 records against 1018 gauges, so a run yielding 60 passes the absolute floor
# and destroys three quarters of the record set that drives the over/near-record headlines.
root = fixture(300, prev_records=216)
try:
    g = load_gen(root)
    stub_fetch(g, 60)
    kind, msg = run_main(g)
    check('a run at under half the last published record count refuses to publish',
          kind == 'exit' and 'published last run' in msg, '%s %s' % (kind, msg))
    check('the refusal leaves the previous records file exactly as it was',
          len(records_in(root)) == 216, '%d records' % len(records_in(root)))
    check('the refusal names the floor it measured against', 'floor 108' in msg, msg)
finally:
    shutil.rmtree(root)

# An ordinary run is not blocked: above the floor, the new file is written.
root = fixture(300, prev_records=216)
try:
    g = load_gen(root)
    stub_fetch(g, 200)
    kind, msg = run_main(g)
    check('a run holding half the last published count still publishes',
          kind == 'ok', '%s %s' % (kind, msg))
    check('the published file carries the new records', len(records_in(root)) == 200,
          '%d records' % len(records_in(root)))
finally:
    shutil.rmtree(root)

# A growing record set is never treated as a collapse.
root = fixture(300, prev_records=216)
try:
    g = load_gen(root)
    stub_fetch(g, 260)
    kind, _ = run_main(g)
    check('a run that gains records publishes', kind == 'ok' and len(records_in(root)) == 260)
finally:
    shutil.rmtree(root)

# ---------------------------------------------------------------------------
# An absent previous file is a first run, not a failure, and only MIN_RECORDS applies.
root = fixture(300)
try:
    g = load_gen(root)
    check('an absent previous file reads as a first run, not as zero records',
          g.prev_records() is None)
    stub_fetch(g, 60)
    kind, msg = run_main(g)
    check('a first run publishes with no baseline to measure against',
          kind == 'ok' and len(records_in(root)) == 60, '%s %s' % (kind, msg))
finally:
    shutil.rmtree(root)

# MIN_RECORDS still has teeth on a first run: a stub is not a records file.
root = fixture(300)
try:
    g = load_gen(root)
    stub_fetch(g, 40)
    kind, msg = run_main(g)
    check('a first run under MIN_RECORDS is still refused',
          kind == 'exit' and 'need >=50' in msg, '%s %s' % (kind, msg))
    check('nothing is written when the absolute floor refuses',
          not os.path.exists(os.path.join(root, 'data', 'records.json')))
finally:
    shutil.rmtree(root)

# ---------------------------------------------------------------------------
# A previous file that exists and will not read is not a first run. Treating it as one drops
# the only floor that follows the gauge network, so it must refuse, and refuse before it has
# spent ~1000 upstream requests finding that out.
root = fixture(300, prev_records=216)
try:
    g = load_gen(root)
    with open(os.path.join(root, 'data', 'records.json'), 'w', encoding='utf-8') as f:
        f.write('{"records": {"FX0001":')  # the shape a killed run leaves behind
    calls = stub_fetch(g, 300)
    kind, msg = run_main(g)
    check('an unreadable previous file refuses to publish',
          kind == 'exit' and 'will not read' in msg, '%s %s' % (kind, msg))
    check('it refuses before spending a single upstream fetch', len(calls) == 0,
          '%d fetches issued' % len(calls))
finally:
    shutil.rmtree(root)

root = fixture(300, prev_records=216)
try:
    g = load_gen(root)
    os.remove(os.path.join(root, 'data', 'records.json'))
    os.makedirs(os.path.join(root, 'data', 'records.json'))  # root ignores mode bits
    stub_fetch(g, 300)
    kind, msg = run_main(g)
    check('a previous file that cannot be opened at all refuses to publish',
          kind == 'exit' and 'will not read' in msg, '%s %s' % (kind, msg))
finally:
    shutil.rmtree(root)

print('---')
if FAILS:
    print('%d FAILURE(S)' % FAILS)
    sys.exit(1)
print('ALL PASS')
