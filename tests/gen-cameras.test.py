#!/usr/bin/env python3
"""tests/gen-cameras.test.py — the ITS per-district collapse guard, against a fixture
data/cameras.json (RESPONDER_ROOT override, never the real data/). The aggregate floor
cannot see a per-district collapse, so this covers the shape that can: gradual loss passes
through, a collapse is held, the hold expires, and a recovered district clears its clock.
Also covers the one-retry liveness probe. No network: the pure functions are called directly.
Run: python3 tests/gen-cameras.test.py"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
GEN = os.path.join(HERE, '..', 'scripts', 'gen-cameras.py')

FAILS = 0


def check(name, ok, detail=''):
    global FAILS
    print('%s: %s%s' % ('PASS' if ok else 'FAIL', name, (' · ' + detail) if (detail and not ok) else ''))
    if not ok:
        FAILS += 1


def iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%SZ')


NOW = datetime.now(timezone.utc)


def row(dist, n):
    # spread the rows far enough apart that the near-streamable grid never collapses them
    return {'name': '%s cam %d' % (dist, n), 'route': 'IH 20', 'lat': round(31.0 + n * 0.01, 6),
            'lon': round(-99.0 + n * 0.01, 6), 'src': 'its', 'icd': '%s-%d' % (dist, n), 'dist': dist}


def load_gen(root):
    """Import gen-cameras.py with ROOT pinned at a fixture; module import does no network."""
    os.environ['RESPONDER_ROOT'] = root
    spec = importlib.util.spec_from_file_location('gen_cameras_%d' % id(root), GEN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def fixture(prev_rows_by_dist, clock=None):
    """A repo root whose data/cameras.json carries the given last-known ITS inventory."""
    root = tempfile.mkdtemp(prefix='responder-cams-test.')
    os.makedirs(os.path.join(root, 'data'))
    txdot = []
    for d, n in prev_rows_by_dist.items():
        txdot.extend(row(d, i) for i in range(n))
    payload = {'generated': iso(NOW), 'bbox': [-107, 25, -93, 37], 'txdot': txdot,
               'itsCarried': clock or {}}
    with open(os.path.join(root, 'data', 'cameras.json'), 'w', encoding='utf-8') as f:
        json.dump(payload, f)
    return root


def never_near(lat, lon):
    return False


# ---------------------------------------------------------------------------
# The live case that shipped: FTW stable at 140 in the committed inventory while the
# district feed returned 36. The aggregate floor of 300 cannot see it, so the district
# guard has to.
root = fixture({'FTW': 140, 'HOU': 343, 'DAL': 103})
try:
    g = load_gen(root)
    live = {d: [] for d in g.ITS_DISTRICTS}
    live['FTW'] = [row('FTW', i) for i in range(36)]     # collapsed: 36 of 140
    live['HOU'] = [row('HOU', i) for i in range(343)]    # healthy
    live['DAL'] = [row('DAL', i) for i in range(95)]     # gradual loss: 95 of 103, above the floor
    cams, clock = g.its_hold_collapsed(live, never_near)
    by = {}
    for c in cams:
        by[c['dist']] = by.get(c['dist'], 0) + 1

    check('a collapsed district keeps its last-known inventory, not the collapsed feed',
          by.get('FTW') == 140, 'FTW=%s expected 140' % by.get('FTW'))
    check('the aggregate survives a per-district collapse',
          len(cams) == 140 + 343 + 95, 'total=%d' % len(cams))
    check('a healthy district passes through untouched',
          by.get('HOU') == 343, 'HOU=%s' % by.get('HOU'))
    check('gradual loss is real and is NOT held: a retired camera leaves the inventory',
          by.get('DAL') == 95, 'DAL=%s expected 95, the guard must not floor it back to 103' % by.get('DAL'))
    check('only the collapsed district starts a carry clock',
          list(clock) == ['FTW'], str(list(clock)))
    check('the carry clock records what was known, so the hold is auditable',
          clock['FTW']['known'] == 140 and clock['FTW']['since'], str(clock.get('FTW')))
    check('a held district is still marked as ITS, so the layer treats it normally',
          all(c['src'] == 'its' for c in cams))
finally:
    shutil.rmtree(root)

# ---------------------------------------------------------------------------
# The hold is bounded. A district that really lost its cameras must be able to say so.
HELD_D = 15
root = fixture({'FTW': 140}, clock={'FTW': {'since': iso(NOW - timedelta(days=HELD_D)), 'known': 140}})
try:
    g = load_gen(root)
    live = {d: [] for d in g.ITS_DISTRICTS}
    live['FTW'] = [row('FTW', i) for i in range(36)]
    cams, clock = g.its_hold_collapsed(live, never_near)
    check('a hold older than the cap expires: the loss is accepted as real',
          len(cams) == 36, 'kept %d, expected 36 after %dd > %dd cap' % (len(cams), HELD_D, g.ITS_CARRY_MAX_D))
    check('an expired hold stops re-arming its own clock',
          'FTW' not in clock, str(list(clock)))
finally:
    shutil.rmtree(root)

# A hold inside the cap keeps holding, and keeps its ORIGINAL since stamp so the
# clock cannot be reset by each successive run.
root = fixture({'FTW': 140}, clock={'FTW': {'since': iso(NOW - timedelta(days=3)), 'known': 140}})
try:
    g = load_gen(root)
    live = {d: [] for d in g.ITS_DISTRICTS}
    live['FTW'] = [row('FTW', i) for i in range(36)]
    cams, clock = g.its_hold_collapsed(live, never_near)
    check('a hold inside the cap still holds', len(cams) == 140, 'kept %d' % len(cams))
    check('the clock is not reset by a later run, so the cap can actually be reached',
          clock['FTW']['since'].startswith(iso(NOW - timedelta(days=3))[:10]), clock['FTW']['since'])
finally:
    shutil.rmtree(root)

# ---------------------------------------------------------------------------
# Recovery clears the hold, and a live row wins over the held copy of the same icd.
root = fixture({'FTW': 140}, clock={'FTW': {'since': iso(NOW - timedelta(days=1)), 'known': 140}})
try:
    g = load_gen(root)
    live = {d: [] for d in g.ITS_DISTRICTS}
    live['FTW'] = [row('FTW', i) for i in range(140)]
    live['FTW'][0] = dict(live['FTW'][0], name='FTW cam 0 renamed')
    cams, clock = g.its_hold_collapsed(live, never_near)
    check('a recovered district clears its carry clock', 'FTW' not in clock, str(list(clock)))
    check('a recovered district publishes the live feed', len(cams) == 140, 'kept %d' % len(cams))

    live['FTW'] = [dict(row('FTW', 0), name='FTW cam 0 renamed')]  # collapse to a single live row
    cams, _ = g.its_hold_collapsed(live, never_near)
    names = {c['icd']: c['name'] for c in cams}
    check('while held, a row the feed still returns wins over the held copy',
          names.get('FTW-0') == 'FTW cam 0 renamed', str(names.get('FTW-0')))
    check('while held, the icds the feed dropped are still carried',
          len(cams) == 140, 'kept %d' % len(cams))
finally:
    shutil.rmtree(root)

# ---------------------------------------------------------------------------
# A district with no history cannot be held: there is nothing to hold, and a brand new
# district must not be blocked from appearing.
root = fixture({})
try:
    g = load_gen(root)
    live = {d: [] for d in g.ITS_DISTRICTS}
    live['YKM'] = [row('YKM', i) for i in range(8)]
    cams, clock = g.its_hold_collapsed(live, never_near)
    check('a district with no last-known inventory passes through', len(cams) == 8 and not clock)
finally:
    shutil.rmtree(root)

# A held row that has since become near a streamable cam is dropped, so the hold cannot
# resurrect a duplicate the dedup had already removed.
root = fixture({'FTW': 140})
try:
    g = load_gen(root)
    live = {d: [] for d in g.ITS_DISTRICTS}
    live['FTW'] = []
    cams, _ = g.its_hold_collapsed(live, lambda lat, lon: lat < 31.5)
    check('a held row now covered by a streamable cam is still deduped out',
          0 < len(cams) < 140, 'kept %d of 140' % len(cams))
finally:
    shutil.rmtree(root)

# ---------------------------------------------------------------------------
# The single-shot liveness checks dropped a live camera on one transient miss.
root = fixture({})
try:
    g = load_gen(root)
    calls = []

    def flaky(url):
        calls.append(url)
        return len(calls) > 1  # fails once, then answers

    check('a liveness probe that fails once and then answers is called live',
          g.live_twice(flaky, 'u') is True)
    check('the retry only runs when the first probe failed', len(calls) == 2, 'calls=%d' % len(calls))

    calls2 = []

    def dead(url):
        calls2.append(url)
        return False

    check('a genuinely dead camera is still dropped', g.live_twice(dead, 'u') is False)
    check('a dead camera is probed exactly twice, never more', len(calls2) == 2, 'calls=%d' % len(calls2))

    ok = []

    def alive(url):
        ok.append(url)
        return True

    check('a live camera is probed once, so the retry costs nothing in the normal case',
          g.live_twice(alive, 'u') is True and len(ok) == 1, 'calls=%d' % len(ok))
finally:
    shutil.rmtree(root)

print('---')
if FAILS:
    print('%d FAILURE(S)' % FAILS)
    sys.exit(1)
print('ALL PASS')
