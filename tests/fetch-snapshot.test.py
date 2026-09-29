#!/usr/bin/env python3
"""tests/fetch-snapshot.test.py — display scope may narrow, the capture may not.

gauges-snapshot.json is the public display file and is clipped to data/event.json gaugeBbox plus
the aoArea outline and its border buffer; gauges-capture.json is the durable archive and is not
clipped at all. A display scope that yields too few gauges is a config problem, so it keeps the
previous display file without also stalling the capture. The rule is scripts/aoarea.py, the twin
of js/core.js aoContains(), held to tests/fixtures/ao-points.json. Runs the real publish() against
temp roots, never the repo's data/. Run: python3 tests/fetch-snapshot.test.py"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.join(HERE, '..')
SCRIPT = os.path.join(REPO, 'scripts', 'fetch-snapshot.py')

FAILS = 0


def check(name, ok, detail=''):
    global FAILS
    print('%s: %s%s' % ('PASS' if ok else 'FAIL', name, (' · ' + detail) if (detail and not ok) else ''))
    if not ok:
        FAILS += 1


with open(os.path.join(REPO, 'data', 'event.json'), encoding='utf-8') as f:
    EVENT = json.load(f)
with open(os.path.join(HERE, 'fixtures', 'ao-points.json'), encoding='utf-8') as f:
    POINTS = json.load(f)['points']


def load(root):
    """A fresh module per temp root: fetch-snapshot.py resolves its output paths at import."""
    os.environ['RESPONDER_ROOT'] = root
    spec = importlib.util.spec_from_file_location('fetch_snapshot_%d' % id(root), SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def make_root(tmp, name, event, prev_capture=None, prev_snapshot=None):
    root = os.path.join(tmp, name)
    os.makedirs(os.path.join(root, 'data'))
    for fname, doc in (('event.json', event), ('gauges-capture.json', prev_capture),
                       ('gauges-snapshot.json', prev_snapshot)):
        if doc is not None:
            with open(os.path.join(root, 'data', fname), 'w', encoding='utf-8') as f:
                json.dump(doc, f)
    return root


def read(root, fname):
    with open(os.path.join(root, 'data', fname), encoding='utf-8') as f:
        return json.load(f)


def gauge(lid, lat, lon):
    return {'lid': lid, 'name': lid, 'latitude': lat, 'longitude': lon,
            'status': {'observed': {'floodCategory': 'no_flooding'}}}


def run(mod, gauges):
    """publish() with the scopes main() would derive; returns the SystemExit message or None."""
    try:
        mod.publish(gauges, mod.event_bbox('captureBbox'), mod.event_bbox('gaugeBbox'), mod.event_area())
    except SystemExit as e:
        return str(e.code)
    return None


FIX = [gauge('P%02d' % i, p['lat'], p['lon']) for i, p in enumerate(POINTS)]
TX = [gauge('TX%03d' % i, 29.0 + (i % 40) * 0.05, -99.0 + (i // 40) * 0.05) for i in range(120)]
SEILING = next(g for g, p in zip(FIX, POINTS) if p['name'].startswith('Seiling'))

tmp = tempfile.mkdtemp(prefix='fetch-snapshot-test.')
saved_root = os.environ.get('RESPONDER_ROOT')
try:
    # --- the rule itself, on the shared fixture points (same list the JS test reads) ---------
    fs = load(make_root(tmp, 'rule', EVENT))
    area = fs.event_area()
    check('the shipped aoArea parses', area is not None and area['bufferMi'] == 15)
    bbox = fs.event_bbox('gaugeBbox')
    for p in POINTS:
        got = fs.aoarea.in_scope(bbox, area, p['lat'], p['lon'])
        check('E5 · %s is %s the AO, as the client says' % (p['name'], 'in' if p['inAo'] else 'out of'),
              got == p['inAo'], 'got %s' % got)

    # --- display narrows, capture does not ---------------------------------------------------
    root = make_root(tmp, 'clip', EVENT)
    fs = load(root)
    err = run(fs, TX + FIX)
    check('a normal refresh publishes both files', err is None, err or '')
    cap, snap = read(root, 'gauges-capture.json'), read(root, 'gauges-snapshot.json')
    cap_lids = {g['lid'] for g in cap['gauges']}
    snap_lids = {g['lid'] for g in snap['gauges']}
    check('E6 · the capture keeps every gauge the upstream returned, Seiling included',
          len(cap['gauges']) == len(TX) + len(FIX) and SEILING['lid'] in cap_lids)
    check('the display snapshot drops the Oklahoma gauge', SEILING['lid'] not in snap_lids)
    want = {g['lid'] for g, p in zip(FIX, POINTS) if p['inAo']} | {g['lid'] for g in TX}
    check('the display snapshot is exactly the in-AO set, border rivers included',
          snap_lids == want, 'extra %s missing %s' % (sorted(snap_lids - want), sorted(want - snap_lids)))
    check('the display file names the aoArea it was clipped to, so a re-target is not read as a '
          'partial fetch', snap.get('ao') == fs.aoarea.fingerprint(area) and 'ao' not in cap)

    # --- a display floor miss must not stall retention ---------------------------------------
    # previous display: same scope, 400 gauges, so the 50% guard wants 200; this run's display
    # yields ~130 while the capture is whole
    prev_snap = {'generated': '2026-09-01T00:00:00Z', 'bbox': list(bbox), 'ao': fs.aoarea.fingerprint(area),
                 'gauges': [gauge('OLD%03d' % i, 30.0, -97.0) for i in range(400)]}
    prev_cap = {'generated': '2026-09-01T00:00:00Z', 'bbox': list(fs.event_bbox('captureBbox')),
                'gauges': [gauge('C%03d' % i, 30.0, -97.0) for i in range(160)]}
    root = make_root(tmp, 'decouple', EVENT, prev_cap, prev_snap)
    fs = load(root)
    err = run(fs, TX + FIX)
    check('a display floor miss exits non-zero so the cycle signs off degraded', err is not None
          and 'display scope' in err and 'capture written' in err, err or 'exit 0')
    check('E6 · ...but the capture is still written: a display problem never stalls retention',
          len(read(root, 'gauges-capture.json')['gauges']) == len(TX) + len(FIX))
    check('...and the previous display file is kept, older stamp and all',
          read(root, 'gauges-snapshot.json') == prev_snap)

    # --- a partial response still writes nothing ---------------------------------------------
    prev_cap_big = dict(prev_cap, gauges=[gauge('C%03d' % i, 30.0, -97.0) for i in range(600)])
    root = make_root(tmp, 'partial', EVENT, prev_cap_big, prev_snap)
    fs = load(root)
    err = run(fs, TX + FIX)
    check('a partial capture is refused', err is not None and 'capture only' in err, err or 'exit 0')
    check('...and neither file is touched', read(root, 'gauges-capture.json') == prev_cap_big
          and read(root, 'gauges-snapshot.json') == prev_snap)

    # --- no aoArea, or a broken one: today's rectangle, never an empty board ------------------
    for label, ev in (('missing', {k: v for k, v in EVENT.items() if k != 'aoArea'}),
                      ('malformed', dict(EVENT, aoArea={'bufferMi': 15, 'polygon': [[30, -99], [31, -98]]}))):
        root = make_root(tmp, 'fallback-' + label, ev)
        fs = load(root)
        err = run(fs, TX + FIX)
        lids = {g['lid'] for g in read(root, 'gauges-snapshot.json')['gauges']}
        check('a %s aoArea falls back to the gaugeBbox rectangle (Seiling shown again), never to '
              'nothing' % label, err is None and SEILING['lid'] in lids and len(lids) == len(TX) + len(FIX),
              err or '%d shown' % len(lids))
finally:
    if saved_root is None:
        os.environ.pop('RESPONDER_ROOT', None)
    else:
        os.environ['RESPONDER_ROOT'] = saved_root
    shutil.rmtree(tmp, ignore_errors=True)

print('---')
if FAILS:
    print('%d FAILURE(S)' % FAILS)
    sys.exit(1)
print('ALL PASS')
