#!/usr/bin/env python3
"""tests/gen-roads-snapshot.test.py — the road archive must never be short.

data/roads-capture.json is the ONLY record of a closure: upstream keeps no history, and
gen-history.py reads a closure's absence from a snapshot as the closure having cleared. So a
truncated capture does not just lose rows, it writes road recoveries that never happened. The
query is paged, and a set still short at the ceiling keeps the previous file instead of
publishing a partial one, exiting non-zero so run-cycle.sh signs the cycle off DEGRADED
rather than clean. Run: python3 tests/gen-roads-snapshot.test.py"""
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
GEN = os.path.join(HERE, '..', 'scripts', 'gen-roads-snapshot.py')

FAILS = 0


def check(name, ok, detail=''):
    global FAILS
    print('%s: %s%s' % ('PASS' if ok else 'FAIL', name, (' · ' + detail) if (detail and not ok) else ''))
    if not ok:
        FAILS += 1


def load_module():
    spec = importlib.util.spec_from_file_location('gen_roads_snapshot', GEN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


GR = load_module()
GR.time.sleep = lambda _s: None  # the retry backoff is real; paying it here would only slow the suite
BBOX = (-100.0, 29.0, -97.0, 31.0)


def feature(n):
    props = {'OBJECTID': n, 'condition': 'Flooding', 'route_name': 'FM%04d' % n,
             'description': 'Water over roadway.', 'start_time': '2026-07-26T00:00:00Z',
             'end_time': None}
    if n:  # n 0 stands in for a closure DriveTexas publishes no limits for
        props['from_limit'] = 'FM%04d A' % n
        props['to_limit'] = 'FM%04d B' % n
    return {'properties': props,
            'geometry': {'type': 'LineString', 'coordinates': [[-98.5, 29.7], [-98.4, 29.75]]}}


class Response(io.StringIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def serve(total):
    """Stub the service: `total` closures handed out PAGE at a time, flagged while more remain."""
    urls = []

    def urlopen(url, timeout=None):
        urls.append(url)
        off = int(url.split('resultOffset=')[1].split('&')[0])
        n = max(0, min(GR.PAGE, total - off))
        body = {'type': 'FeatureCollection', 'features': [feature(off + i) for i in range(n)]}
        if off + n < total:
            body['exceededTransferLimit'] = True
        return Response(json.dumps(body))

    return urls, urlopen


prev = GR.urllib.request.urlopen
urls, GR.urllib.request.urlopen = serve(GR.PAGE * 2 + 5)
feats, truncated = GR.fetch_features(BBOX)
GR.urllib.request.urlopen = prev
check('the closure query pages past the service maxRecordCount',
      len(feats) == GR.PAGE * 2 + 5, '%d features' % len(feats))
check('a complete set is not reported truncated', truncated is False)
check('each page asks for the next offset',
      [int(u.split('resultOffset=')[1].split('&')[0]) for u in urls] == [0, GR.PAGE, GR.PAGE * 2],
      str(len(urls)) + ' pages')

prev = GR.urllib.request.urlopen
urls, GR.urllib.request.urlopen = serve(GR.PAGE * GR.MAX_PAGES + 1)
feats, truncated = GR.fetch_features(BBOX)
GR.urllib.request.urlopen = prev
check('the page ceiling stops a runaway loop', len(urls) == GR.MAX_PAGES, '%d pages' % len(urls))
check('a set still short at the ceiling reports itself truncated', truncated is True)

prev = GR.urllib.request.urlopen
_, GR.urllib.request.urlopen = serve(0)
feats, truncated = GR.fetch_features(BBOX)
GR.urllib.request.urlopen = prev
check('a genuinely empty area is a complete answer, not a truncated one',
      feats == [] and truncated is False)


def error_body(url, timeout=None):
    return Response(json.dumps({'error': {'code': 400, 'message': 'Invalid query'}}))


prev = GR.urllib.request.urlopen
GR.urllib.request.urlopen = error_body
try:
    GR.fetch_features(BBOX)
    raised = False
except ValueError:
    raised = True
GR.urllib.request.urlopen = prev
check('a 200 OK ArcGIS error body is refused, never archived as an empty-roads day', raised)


# MUTATION · a truncated fetch must leave the previous archive on disk untouched. Overwriting it
# with a short set is what would tell gen-history.py the missing closures had cleared.
def run_main(total, dead=False):
    root = tempfile.mkdtemp(prefix='responder-roads-test.')
    os.makedirs(os.path.join(root, 'data'))
    with open(os.path.join(root, 'data', 'event.json'), 'w') as f:
        json.dump({'captureBbox': {'xmin': BBOX[0], 'ymin': BBOX[1], 'xmax': BBOX[2], 'ymax': BBOX[3]},
                   'gaugeBbox': {'xmin': BBOX[0], 'ymin': BBOX[1], 'xmax': BBOX[2], 'ymax': BBOX[3]}}, f)
    keep = {'generated': '2026-07-01T00:00:00Z', 'roads': [{'route': 'PREVIOUS', 'start': 'x', 'v': [29.7, -98.5]}]}
    for name in ('roads-capture.json', 'roads-snapshot.json'):
        with open(os.path.join(root, 'data', name), 'w') as f:
            json.dump(keep, f)
    saved = (GR.ROOT, GR.OUT, GR.CAPTURE_OUT, GR.urllib.request.urlopen)
    GR.ROOT = root
    GR.OUT = os.path.join(root, 'data', 'roads-snapshot.json')
    GR.CAPTURE_OUT = os.path.join(root, 'data', 'roads-capture.json')
    if dead:
        def boom(url, timeout=None):
            raise OSError('upstream refused the connection')
        GR.urllib.request.urlopen = boom
    else:
        _, GR.urllib.request.urlopen = serve(total)
    try:
        rc = GR.main()
        with open(GR.CAPTURE_OUT) as f:
            return json.load(f), rc
    finally:
        GR.ROOT, GR.OUT, GR.CAPTURE_OUT, GR.urllib.request.urlopen = saved
        shutil.rmtree(root, ignore_errors=True)


kept, rc = run_main(GR.PAGE * GR.MAX_PAGES + 1)
check('MUTATION · a truncated fetch keeps the previous archive rather than publishing a short one',
      [r['route'] for r in kept['roads']] == ['PREVIOUS'], str(len(kept['roads'])) + ' roads')

wrote, ok_rc = run_main(3)
check('a complete fetch does publish', len(wrote['roads']) == 3, str(len(wrote['roads'])) + ' roads')

# Route + limits is the segment identity js/sources.js roadId hashes. Without the limits every
# closure on one route archives to a single key, and none of them matches the live feed, so the
# Roads tab reports a watched road it is drawing as missing.
prev = GR.urllib.request.urlopen
field_urls, GR.urllib.request.urlopen = serve(1)
GR.fetch_features(BBOX)
GR.urllib.request.urlopen = prev
check('the query asks upstream for the segment limits',
      'from_limit' in field_urls[0] and 'to_limit' in field_urls[0], field_urls[0])

by_route = {r['route']: r for r in wrote['roads']}
check('the archived row carries the limits roadId keys on',
      by_route['FM0001']['from'] == 'FM0001 A' and by_route['FM0001']['to'] == 'FM0001 B',
      json.dumps(by_route.get('FM0001')))
# an archived empty limit and a snapshot written before limits were archived are different facts:
# the first still keys like the live feed, the second cannot be keyed at all
check('a closure with no limits upstream still archives both keys',
      by_route['FM0000']['from'] == '' and by_route['FM0000']['to'] == '',
      json.dumps(by_route.get('FM0000')))

# The archive stays honest on its own: the previous file keeps its older stamp and the board ages
# it. What a silent exit 0 threw away was the DEGRADED signal, which is what run-cycle.sh records
# in STEPS_OK and what freshness-monitor.sh reads to name the source that stopped refreshing.
check('a complete fetch signs off clean', ok_rc in (0, None), 'rc %r' % (ok_rc,))
check('DEGRADED · a truncated fetch exits non-zero so the cycle cannot sign off clean',
      rc not in (0, None), 'rc %r' % (rc,))
dead_kept, dead_rc = run_main(3, dead=True)
check('DEGRADED · a failed fetch exits non-zero so the cycle cannot sign off clean',
      dead_rc not in (0, None), 'rc %r' % (dead_rc,))
check('DEGRADED · the failed fetch still leaves the previous archive intact',
      [r['route'] for r in dead_kept['roads']] == ['PREVIOUS'], str(len(dead_kept['roads'])))

print('---')
if FAILS:
    print('%d FAILURE(S)' % FAILS)
    sys.exit(1)
print('ALL PASS')
