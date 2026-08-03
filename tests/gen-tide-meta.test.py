#!/usr/bin/env python3
"""tests/gen-tide-meta.test.py · E1 semantics for scripts/gen-tide-meta.py.

The station coordinates are a cache, so the failure that matters is a fetch error silently
DELETING a coordinate the board already publishes. Drives main() against a stubbed urlopen
under a fixture RESPONDER_ROOT (never the network, never the real data/): a failed id keeps
its cached point, a miss with no cache is simply absent rather than written as 0,0, a point
outside the Gulf coast box is a parse error, a collapsed run leaves the published file byte
identical, and an id removed from event.json is dropped because that is a config decision.
Run: python3 tests/gen-tide-meta.test.py"""
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
GEN = os.path.join(os.path.dirname(HERE), 'scripts', 'gen-tide-meta.py')

FAILS = 0


def check(name, ok, detail=''):
    global FAILS
    print('%s: %s%s' % ('PASS' if ok else 'FAIL', name, '' if ok else ' -> %s' % detail))
    if not ok:
        FAILS += 1


def load_gen(root):
    """Import gen-tide-meta.py fresh with RESPONDER_ROOT pinned at a fixture, never inherited."""
    os.environ['RESPONDER_ROOT'] = root
    spec = importlib.util.spec_from_file_location('gen_tide_meta_under_test', GEN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def mdapi(sid, lat, lng, name):
    return {'count': 1, 'stations': [{'id': sid, 'name': name, 'lat': lat, 'lng': lng,
                                      'state': 'TX', 'tidal': True}]}


OK = {
    '8770822': mdapi('8770822', 29.6893, -93.8418, 'Texas Point, Sabine Pass'),
    '8771450': mdapi('8771450', 29.3100, -94.7933, 'Galveston Pier 21'),
    '8779770': mdapi('8779770', 26.0612, -97.2155, 'Port Isabel'),
}
CONFIG = [{'id': '8770822', 'name': 'Texas Point, Sabine Pass'},
          {'id': '8771450', 'name': 'Galveston Pier 21'},
          {'id': '8779770', 'name': 'Port Isabel'}]


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def run(stations=CONFIG, answers=None, previous=None, min_stations=1, argv=None):
    """Drive main() with urlopen routed by station id.

    answers maps id to a body to answer with, an Exception to raise, or a list of either
    replayed in order (the last element repeats). Ids absent from it answer healthily.
    """
    answers = dict(OK, **(answers or {}))
    root = tempfile.mkdtemp(prefix='gen-tide-meta-test.')
    try:
        os.mkdir(os.path.join(root, 'data'))
        with open(os.path.join(root, 'data', 'event.json'), 'w', encoding='utf-8') as f:
            json.dump({'name': 'Fixture AO', 'tideStations': stations}, f)
        out = os.path.join(root, 'data', 'tide-meta.json')
        if previous is not None:
            with open(out, 'w', encoding='utf-8') as f:
                f.write(previous)
        mod = load_gen(root)
        mod.MIN_STATIONS = min_stations
        mod.FETCH_SPACING_S = 0  # the real 0.2s spacing is upstream politeness, not behaviour
        seen, sleeps, calls = {}, [], []

        def urlopen(req, timeout=None):
            url = req.full_url if hasattr(req, 'full_url') else str(req)
            sid = url.rsplit('/', 1)[-1].split('.')[0]
            calls.append(sid)
            steps = answers.get(sid, [urllib.error.HTTPError(url, 404, 'Not Found', {}, None)])
            if not isinstance(steps, list):
                steps = [steps]
            step = steps[min(seen.get(sid, 0), len(steps) - 1)]
            seen[sid] = seen.get(sid, 0) + 1
            if isinstance(step, Exception):
                raise step
            return FakeResponse(json.dumps(step).encode())

        def sleep(seconds):
            if seconds:  # FETCH_SPACING_S is zeroed above; only a real backoff is behaviour
                sleeps.append(seconds)

        mod.urllib.request.urlopen = urlopen
        mod.time.sleep = sleep
        saved_argv = sys.argv
        sys.argv = ['gen-tide-meta.py'] + list(argv or [])
        code, msg = 0, ''
        try:
            mod.main()
        except SystemExit as e:
            code = e.code if isinstance(e.code, int) else 1
            msg = '' if isinstance(e.code, int) else str(e.code)
        except Exception as e:  # noqa: BLE001, an uncaught raise is a failed run, not a dead suite
            code, msg = 1, repr(e)
        finally:
            sys.argv = saved_argv
        body = open(out, encoding='utf-8').read() if os.path.exists(out) else None
        try:
            doc = json.loads(body) if body else None
        except ValueError:  # a refusal can leave a deliberately malformed fixture in place
            doc = None
        return {'code': code, 'msg': msg, 'body': body, 'doc': doc,
                'calls': calls, 'seen': seen, 'sleeps': sleeps, 'mod': mod}
    finally:
        os.environ.pop('RESPONDER_ROOT', None)
        shutil.rmtree(root, ignore_errors=True)


PREV_ALL = json.dumps(
    {'generated': '2026-07-01T00:00:00Z',
     'source': {'name': 'fixture', 'url': 'https://example.invalid/'},
     'stations': {'8770822': {'lat': 29.6893, 'lon': -93.8418, 'name': 'Texas Point, Sabine Pass'},
                  '8771450': {'lat': 29.31, 'lon': -94.7933, 'name': 'Galveston Pier 21'},
                  '8779770': {'lat': 26.0612, 'lon': -97.2155, 'name': 'Port Isabel'}}},
    indent=2, sort_keys=True, ensure_ascii=False) + '\n'

SERVER_ERROR = urllib.error.HTTPError(
    'https://api.tidesandcurrents.noaa.gov/x', 500, 'Server Error', {}, None)
NOT_FOUND = urllib.error.HTTPError(
    'https://api.tidesandcurrents.noaa.gov/x', 404, 'Not Found', {}, None)


# --- the common path ------------------------------------------------------------------------
r = run()
D = r['doc']
check('a healthy run publishes every configured station and exits clean',
      r['code'] == 0 and sorted(D['stations']) == ['8770822', '8771450', '8779770'],
      'code=%s %s' % (r['code'], D and sorted(D['stations'])))
check('each station carries the coordinate the metadata reported, lng read as lon',
      D['stations']['8770822'] == {'lat': 29.6893, 'lon': -93.8418,
                                   'name': 'Texas Point, Sabine Pass'},
      D['stations']['8770822'])
check('the file names the source it was built from and when',
      D['source'] == r['mod'].SOURCE and D['generated'].endswith('Z') and len(D['generated']) == 20,
      (D.get('source'), D.get('generated')))
check('the written file is valid JSON at indent 2 with a trailing newline',
      r['body'].endswith('}\n') and '\n  "generated"' in r['body']
      and '\n    "8770822"' in r['body'], repr(r['body'][:60]))
check('keys are sorted, so a re-run produces a reviewable diff',
      list(D.keys()) == ['generated', 'source', 'stations']
      and list(D['stations']) == sorted(D['stations']), list(D.keys()))
r = run(answers={'8770822': mdapi('8770822', 29.68933333, -93.84177777, 'Texas Point')})
check('coordinates are rounded to 5 decimals',
      r['doc']['stations']['8770822'] == {'lat': 29.68933, 'lon': -93.84178,
                                          'name': 'Texas Point'},
      r['doc']['stations']['8770822'])

# --- E1 · a failed fetch never deletes a published coordinate --------------------------------
r = run(answers={'8770822': SERVER_ERROR}, previous=PREV_ALL)
D = r['doc']
check('E1 · a station that fails every retry keeps its previously cached coordinate',
      r['code'] == 0 and D['stations'].get('8770822') == {
          'lat': 29.6893, 'lon': -93.8418, 'name': 'Texas Point, Sabine Pass'},
      'code=%s %s' % (r['code'], D and D['stations'].get('8770822')))
check('E1 · the failed id is not dropped from the published set',
      sorted(D['stations']) == ['8770822', '8771450', '8779770'], sorted(D['stations']))
check('a 500 is retried on the documented backoffs before it counts as a miss',
      r['seen']['8770822'] == len(r['mod'].BACKOFFS) + 1 and r['sleeps'] == r['mod'].BACKOFFS,
      'seen=%s sleeps=%s' % (r['seen'], r['sleeps']))
check('the ids that did resolve are refreshed alongside the carried-over one',
      D['stations']['8771450']['lat'] == 29.31, D['stations']['8771450'])

r = run(answers={'8770822': [SERVER_ERROR, SERVER_ERROR, OK['8770822']]}, previous=PREV_ALL)
check('a transient failure that recovers on a retry publishes the fresh coordinate',
      r['code'] == 0 and r['seen']['8770822'] == 3, 'code=%s seen=%s' % (r['code'], r['seen']))

r = run(answers={'8770822': OSError('connection reset')}, previous=PREV_ALL)
check('a transport error, not just an HTTP status, also carries the cached coordinate over',
      r['code'] == 0 and r['doc']['stations']['8770822']['lat'] == 29.6893,
      'code=%s %s' % (r['code'], r['doc'] and r['doc']['stations'].get('8770822')))

r = run(answers={'8770822': urllib.error.HTTPError('https://x/', 429, 'Too Many', {}, None)},
        previous=PREV_ALL)
check('a 429 is transient and retried rather than read as a missing station',
      r['seen']['8770822'] == len(r['mod'].BACKOFFS) + 1, r['seen'])

# --- a miss with no cache is an absence, never a placeholder ---------------------------------
r = run(answers={'8770822': NOT_FOUND})
D = r['doc']
check('a station that misses with no prior cache is simply absent from stations',
      '8770822' not in D['stations'] and sorted(D['stations']) == ['8771450', '8779770'],
      sorted(D['stations']))
check('a miss is never written as null or as 0,0',
      all(s['lat'] != 0 and s['lon'] != 0 and s['lat'] is not None for s in D['stations'].values()),
      D['stations'])
check('a 404 is one attempt, not a burnt retry budget', r['seen']['8770822'] == 1
      and r['sleeps'] == [], 'seen=%s sleeps=%s' % (r['seen'], r['sleeps']))

r = run(answers={'8770822': {'count': 0, 'stations': []}})
check('an empty stations array in an HTTP 200 is a miss, not a station',
      '8770822' not in r['doc']['stations'], r['doc']['stations'])

# --- the sanity box -------------------------------------------------------------------------
r = run(answers={'8770822': mdapi('8770822', 39.74, -104.99, 'Denver, somehow')})
check('a coordinate outside the Gulf coast box is a parse error, not a station',
      r['code'] == 0 and '8770822' not in r['doc']['stations'], r['doc']['stations'])
r = run(answers={'8770822': mdapi('8770822', 29.6893, None, 'No longitude')})
check('a null coordinate is a miss rather than a half-placed pin',
      '8770822' not in r['doc']['stations'], r['doc']['stations'])
r = run(answers={'8770822': mdapi('8770822', '29.6893', '-93.8418', 'Strings')})
check('a coordinate delivered as a string is a miss, never coerced',
      '8770822' not in r['doc']['stations'], r['doc']['stations'])
r = run(answers={'8770822': mdapi('8770822', float('nan'), -93.8418, 'NaN')})
check('a non-finite coordinate is a miss', '8770822' not in r['doc']['stations'],
      r['doc']['stations'])
r = run(answers={'8770822': mdapi('8770822', 39.74, -104.99, 'Denver, somehow')},
        previous=PREV_ALL)
check('an out-of-box answer falls back to the cached coordinate rather than overwriting it',
      r['doc']['stations']['8770822']['lat'] == 29.6893, r['doc']['stations']['8770822'])

# --- the floor: a collapsed run must not replace a good file ---------------------------------
r = run(answers={'8770822': SERVER_ERROR, '8771450': SERVER_ERROR, '8779770': SERVER_ERROR},
        previous=PREV_ALL, min_stations=20)
check('a run under MIN_STATIONS refuses to publish',
      r['code'] != 0 and 'need >=20' in r['msg'], 'code=%s %s' % (r['code'], r['msg']))
check('the refusal leaves the published file byte identical', r['body'] == PREV_ALL,
      repr(r['body'])[:160])

r = run(answers={'8770822': SERVER_ERROR}, min_stations=20)
check('a first run under MIN_STATIONS writes nothing at all',
      r['code'] != 0 and r['body'] is None, 'code=%s body=%s' % (r['code'], r['body']))

r = run(previous='{"stations": {"8770822":')
check('a previous file that will not read refuses rather than discarding its cache',
      r['code'] != 0 and 'will not read' in r['msg'], 'code=%s %s' % (r['code'], r['msg']))
check('it refuses before spending a single upstream request', r['calls'] == [], r['calls'])

r = run(previous=json.dumps({'generated': '2026-07-01T00:00:00Z'}) + '\n')
check('a previous file carrying no stations map refuses rather than treating it as empty',
      r['code'] != 0 and 'no stations map' in r['msg'], 'code=%s %s' % (r['code'], r['msg']))

# a cached entry that is itself unusable still counts against the floor it established
r = run(answers={'8770822': SERVER_ERROR, '8771450': SERVER_ERROR, '8779770': SERVER_ERROR},
        previous=json.dumps(
            {'generated': '2026-07-01T00:00:00Z',
             'stations': {'8770822': {'lat': None, 'lon': None, 'name': 'Corrupted'},
                          '8771450': {'lat': 29.31, 'lon': -94.7933, 'name': 'Galveston Pier 21'},
                          '8779770': {'lat': 26.0612, 'lon': -97.2155, 'name': 'Port Isabel'}}}))
check('a run holding fewer stations than the previous file did refuses to publish',
      r['code'] != 0 and 'the previous file held' in r['msg'], 'code=%s %s' % (r['code'], r['msg']))

# --- config scope: only event.json decides which ids are carried ------------------------------
r = run(stations=CONFIG[:2], previous=PREV_ALL)
check('an id removed from event.json is dropped from the output',
      r['code'] == 0 and sorted(r['doc']['stations']) == ['8770822', '8771450'],
      sorted(r['doc']['stations']))
check('a removed id costs no upstream request', '8779770' not in r['calls'], r['calls'])

r = run(stations=CONFIG + [{'id': '8775237', 'name': 'Port Aransas'}],
        answers=dict(OK, **{'8775237': mdapi('8775237', 27.8397, -97.0725, 'Port Aransas')}),
        previous=PREV_ALL)
check('an id added to event.json is fetched and published',
      r['doc']['stations']['8775237']['lat'] == 27.8397, r['doc']['stations'].get('8775237'))

r = run(stations=[{'id': '8770822', 'name': 'A'}, {'id': '8770822', 'name': 'B'}],
        answers={'8770822': OK['8770822']})
check('a repeated id is fetched once', r['calls'] == ['8770822'], r['calls'])

r = run(answers={'8770822': mdapi('8770822', 29.6893, -93.8418, '')})
check('a station the metadata does not name falls back to the event.json name',
      r['doc']['stations']['8770822']['name'] == 'Texas Point, Sabine Pass',
      r['doc']['stations']['8770822'])

# --- --dry-run ---------------------------------------------------------------------------
r = run(previous=PREV_ALL, argv=['--dry-run'])
check('a dry run reports without touching the published file',
      r['code'] == 0 and r['body'] == PREV_ALL, 'code=%s' % r['code'])
r = run(argv=['--dry-run'])
check('a dry run on a first run writes no file at all', r['body'] is None, r['body'])

print('----')
if FAILS == 0:
    print('ALL GEN-TIDE-META TESTS PASSED')
    sys.exit(0)
print('%d TEST(S) FAILED' % FAILS)
sys.exit(1)
