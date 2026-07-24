#!/usr/bin/env python3
"""tests/gen-notices.test.py — merge semantics for scripts/gen-notices.py.
Runs the generator against a fixture repo root (RESPONDER_ROOT override, never
the real data/): idempotent double-run, curated entries untouched, operator
provenance stamped, re-posted id updates in place, curated-id collision skipped,
deleted inbox line removes its entry, absent inbox is a no-op.
Run: python3 tests/gen-notices.test.py"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
GEN = os.path.join(HERE, '..', 'scripts', 'gen-notices.py')

FAILS = 0


def check(name, ok):
    global FAILS
    print('%s: %s' % ('PASS' if ok else 'FAIL', name))
    if not ok:
        FAILS += 1


CURATED = [
    {'id': 'seed-001', 'ts': '2026-07-24T10:00:00Z', 'type': 'road', 'priority': 'high',
     'status': 'open', 'county': 'Hays', 'place': 'Curated place', 'summary': 'Curated entry',
     'source': {'platform': 'official', 'handle': 'x', 'url': 'https://example.test'}},
]
LINES = [
    {'id': 'local-aaa-0001', 'ts': '2026-07-24T11:00:00Z', 'received_at': '2026-07-24T11:00:05Z',
     'type': 'rescue', 'priority': 'critical', 'status': 'open', 'county': 'Hays',
     'place': 'Op place A', 'summary': 'Operator intake A'},
    {'id': 'local-bbb-0002', 'ts': '2026-07-24T11:30:00Z', 'received_at': '2026-07-24T11:30:05Z',
     'type': 'road', 'priority': 'high', 'status': 'open', 'county': 'Comal',
     'place': 'Op place B', 'summary': 'Operator intake B'},
]

tmp = tempfile.mkdtemp()
try:
    os.mkdir(os.path.join(tmp, 'data'))
    req_path = os.path.join(tmp, 'data', 'requests.json')
    inbox_path = os.path.join(tmp, 'data', 'notices-inbox.jsonl')

    def write_requests(entries):
        with open(req_path, 'w') as f:
            json.dump({'generated': '2026-07-24T00:00:00Z', 'note': 'fixture', 'requests': entries}, f, indent=1)
            f.write('\n')

    def write_inbox(lines):
        with open(inbox_path, 'w') as f:
            for e in lines:
                f.write(json.dumps(e) + '\n')

    def run_gen():
        env = dict(os.environ, RESPONDER_ROOT=tmp)
        return subprocess.run([sys.executable, GEN], env=env, capture_output=True, text=True)

    def load():
        with open(req_path) as f:
            return json.load(f)['requests']

    write_requests(list(CURATED))
    write_inbox(LINES)
    r = run_gen()
    got = load()
    ops = [e for e in got if e.get('origin') == 'operator']
    check('first run exits 0', r.returncode == 0)
    check('first run merges 2 operator entries', len(ops) == 2 and len(got) == 3)
    check('operator entries stamped origin=operator',
          all(e['origin'] == 'operator' for e in ops))
    check('curated entry untouched',
          [e for e in got if e['id'] == 'seed-001'] == CURATED)

    r2 = run_gen()
    got2 = load()
    check('second run exits 0 (idempotent)', r2.returncode == 0)
    check('second run adds no duplicates', got2 == got)
    check('second run reports no change', 'no change' in r2.stdout)

    # re-post of an existing id updates that entry in place, never duplicates
    write_inbox(LINES + [dict(LINES[0], summary='Operator intake A updated')])
    run_gen()
    got3 = load()
    a = [e for e in got3 if e['id'] == 'local-aaa-0001']
    check('re-posted id updates in place', len(a) == 1 and a[0]['summary'] == 'Operator intake A updated')
    check('entry count stable after re-post', len(got3) == 3)

    # a line whose id collides with a curated entry is skipped
    write_inbox(LINES + [dict(LINES[0], id='seed-001', summary='id hijack attempt')])
    run_gen()
    got4 = load()
    check('curated-id collision skipped',
          [e for e in got4 if e['id'] == 'seed-001'] == CURATED and len(got4) == 3)

    # deleting an inbox line removes its merged entry on the next run
    write_inbox(LINES[1:])
    run_gen()
    got5 = load()
    check('deleted inbox line removes its entry',
          not [e for e in got5 if e['id'] == 'local-aaa-0001'] and len(got5) == 2)

    # malformed / incomplete lines are skipped, valid ones still merge
    with open(inbox_path, 'a') as f:
        f.write('not json\n')
        f.write(json.dumps({'id': 'local-ccc-0003', 'ts': '2026-07-24T12:00:00Z'}) + '\n')
    r6 = run_gen()
    got6 = load()
    check('malformed/incomplete lines skipped', r6.returncode == 0 and len(got6) == 2)

    # absent inbox: no-op, requests.json byte-identical
    os.unlink(inbox_path)
    before = open(req_path).read()
    r7 = run_gen()
    check('absent inbox is a no-op', r7.returncode == 0 and open(req_path).read() == before)
finally:
    shutil.rmtree(tmp)

print('---')
if FAILS:
    print('%d FAILURE(S)' % FAILS)
    sys.exit(1)
print('ALL PASS')
