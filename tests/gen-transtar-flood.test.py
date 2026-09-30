#!/usr/bin/env python3
"""tests/gen-transtar-flood.test.py: E1 semantics for scripts/gen-transtar-flood.py.

An empty TranStar array is a genuine zero and publishes clean; a failed read never does. Drives
the generator against stubbed responses under a fixture RESPONDER_ROOT (never the network, never
the real data/), then runs the cycle-check schema gate against the generator's own output.
Run: python3 tests/gen-transtar-flood.test.py"""
import datetime
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GEN = os.path.join(ROOT, 'scripts', 'gen-transtar-flood.py')
CYCLE_CHECK = os.path.join(ROOT, 'scripts', 'cycle-check.sh')
UTC = datetime.timezone.utc

FAILS = 0


def check(name, ok, detail=''):
    global FAILS
    print('%s: %s%s' % ('PASS' if ok else 'FAIL', name, '' if ok else ' -> %s' % (detail,)))
    if not ok:
        FAILS += 1


def load_gen(root):
    os.environ['RESPONDER_ROOT'] = root
    spec = importlib.util.spec_from_file_location('gen_transtar_under_test', GEN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# the live feed as probed 2026-09-30, both string-null spellings and the 0001 placeholder included
LIVE = [
    {'Timestamp': '2026-09-30T09:16:22', 'SensorId': 5353, 'SensorName': 'Dickinson Bayou @ HWY 3',
     'Latitude': 29.45688, 'Longitude': -95.046822, 'TopOfBank': 3.5, 'ShefId': 'null', 'Radius': 0.5,
     'SensorUrl': 'https://www.harriscountyfws.org/GageDetail/Index/5350?v=streamelevation',
     'PrecipitationLatestTimestamp': '2026-09-30T09:16:22', 'PrecipitationLatestValue': 0.0,
     'StreamElevationLatestTimestamp': '2026-09-30T09:16:22', 'StreamElevationLatestValue': 2.71,
     'StreamElevationUpdateIntervalMinutes': 15,
     'PrecipitationAlertExpireTimestamp': '0001-01-01T00:00:00',
     'XCoord': 0, 'YCoord': 0, 'RegionCode': 'HOU'},
    {'Timestamp': '2026-09-30T09:27:14', 'SensorId': 145, 'SensorName': 'JF13-3',
     'Latitude': 29.81087096, 'Longitude': -94.33457146, 'TopOfBank': 2.405, 'ShefId': '',
     'Radius': 0.5, 'SensorUrl': '',
     'StreamElevationLatestTimestamp': '2026-09-30T09:27:14', 'StreamElevationLatestValue': 3.56,
     'StreamElevationUpdateIntervalMinutes': 15, 'XCoord': 0, 'YCoord': 0, 'RegionCode': 'SRA'},
]
LAST_MODIFIED = 'Wed, 30 Sep 2026 14:27:24 GMT'


def entry(**over):
    e = dict(LIVE[0])
    e.update(over)
    return e


class FakeResponse:
    def __init__(self, body, headers):
        self._body = body
        self.headers = headers

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def iso_ago(hours):
    return (datetime.datetime.now(UTC) - datetime.timedelta(hours=hours)).strftime('%Y-%m-%dT%H:%M:%SZ')


def run(feed=LIVE, last_modified=LAST_MODIFIED, previous=None):
    """Drive main(). feed is a body (list/dict serialised, bytes/str as is), an Exception to raise,
    or a list of those replayed per attempt when wrapped in a tuple."""
    root = tempfile.mkdtemp(prefix='gen-transtar-test.')
    try:
        os.mkdir(os.path.join(root, 'data'))
        out = os.path.join(root, 'data', 'transtar-flood.json')
        if previous is not None:
            with open(out, 'w', encoding='utf-8') as f:
                f.write(previous if isinstance(previous, str) else json.dumps(previous))
        mod = load_gen(root)
        steps = list(feed) if isinstance(feed, tuple) else [feed]
        calls, sleeps = [], []

        def urlopen(req, timeout=None):
            calls.append((req.full_url, timeout))
            step = steps[min(len(calls) - 1, len(steps) - 1)]
            if isinstance(step, Exception):
                raise step
            body = step if isinstance(step, bytes) else (
                step.encode() if isinstance(step, str) else json.dumps(step).encode())
            headers = {'Last-Modified': last_modified} if last_modified else {}
            return FakeResponse(body, headers)

        mod.urllib.request.urlopen = urlopen
        mod.time.sleep = lambda s: sleeps.append(s)
        errors = []
        try:
            code = mod.main()
        except Exception as e:  # noqa: BLE001, an uncaught raise is a non-zero run, not a dead suite
            code = 1
            errors.append(repr(e))
        body = open(out, encoding='utf-8').read() if os.path.exists(out) else None
        return {'code': code, 'body': body, 'doc': json.loads(body) if body else None,
                'calls': calls, 'sleeps': sleeps, 'mod': mod, 'errors': errors}
    finally:
        os.environ.pop('RESPONDER_ROOT', None)
        shutil.rmtree(root, ignore_errors=True)


def src(doc):
    return doc['sources'][0]


def extract_schema_gate():
    source = open(CYCLE_CHECK, encoding='utf-8').read()
    m = re.search(r"check_schemas\(\) \{\n\s*python3 - <<'EOF'\n(.*?)\nEOF\n", source, re.S)
    assert m, 'check_schemas python block not found in scripts/cycle-check.sh (structure changed?)'
    return m.group(1)


def run_schema_gate(payload):
    work = tempfile.mkdtemp(prefix='gen-transtar-gate.')
    try:
        os.mkdir(os.path.join(work, 'data'))

        def write(name, obj):
            with open(os.path.join(work, 'data', name), 'w', encoding='utf-8') as f:
                json.dump(obj, f)

        write('gauges-snapshot.json', {'generated': '2026-09-30T00:00:00Z',
                                       'gauges': [{'lid': 'AAAT2', 'status': {}}]})
        write('requests.json', {'requests': []})
        write('transtar-flood.json', payload)
        script = os.path.join(work, 'gate.py')
        with open(script, 'w', encoding='utf-8') as f:
            f.write(extract_schema_gate())
        p = subprocess.run([sys.executable, script], cwd=work, capture_output=True, text=True)
        return p.returncode, (p.stdout or '') + (p.stderr or '')
    finally:
        shutil.rmtree(work, ignore_errors=True)


# --- the live shape --------------------------------------------------------------------------
r = run()
D = r['doc']
W = {w['id']: w for w in (D or {}).get('warnings', [])}
check('the live sample publishes ok with both warnings and exits clean',
      r['code'] == 0 and src(D)['status'] == 'ok' and src(D)['count'] == 2 and len(W) == 2,
      (r['code'], D and D['sources'], r['errors']))
check('the source row credits TranStar and links its own description of the system',
      src(D)['name'] == 'Houston TranStar Roadway Flood Warning System'
      and src(D)['url'] == 'https://www.houstontranstar.org/about_transtar/about_rfws.aspx', src(D))
check('captured is the feed\'s Last-Modified, not our clock',
      src(D)['captured'] == '2026-09-30T14:27:24Z' and src(D)['captured'] != D['generated'], src(D))
d = W.get('transtar:5353', {})
check('a Central local stamp in daylight time is published as UTC (CDT, -5h)',
      d.get('observed') == '2026-09-30T14:16:22Z' and d.get('stageAt') == '2026-09-30T14:16:22Z', d)
check('the reading, the bank and the radius carry through as numbers',
      d.get('stageFt') == 2.71 and d.get('bankFt') == 3.5 and d.get('radiusMi') == 0.5
      and d.get('lat') == 29.45688 and d.get('lon') == -95.04682, d)
check('the string "null" ShefId publishes as null, not as the word',
      'shef' in d and d['shef'] is None, d.get('shef'))
check('a stated sensor page carries through',
      d.get('url') == 'https://www.harriscountyfws.org/GageDetail/Index/5350?v=streamelevation', d.get('url'))
j = W.get('transtar:145', {})
check('an empty SensorUrl and ShefId publish as null, never as ""',
      j.get('url') is None and j.get('shef') is None and j.get('name') == 'JF13-3', j)
check('the request carries the cache-busting ?arg=<epoch ms> TranStar\'s own map sends',
      re.search(r'floodalert_json\.js\?arg=\d{13}$', r['calls'][0][0]) is not None, r['calls'])
check('the published file carries no em-dash', r['body'] and '—' not in r['body'])
rc, out = run_schema_gate(D)
check('the schema gate accepts a healthy read', rc == 0, out)

# --- E1 · an empty array is a genuine zero ---------------------------------------------------
r = run(feed=[])
D = r['doc']
check('[] publishes ok with count 0 and no warnings, and exits clean',
      r['code'] == 0 and src(D)['status'] == 'ok' and src(D)['count'] == 0 and D['warnings'] == [],
      (r['code'], D))
rc, out = run_schema_gate(D)
check('the schema gate accepts a genuine zero', rc == 0, out)

# --- E1 · a failed read is never a zero ------------------------------------------------------
r = run(feed=urllib.error.URLError('timed out'))
D = r['doc']
check('a fetch failure publishes failed with a null count, not ok with zero',
      r['code'] == 1 and src(D)['status'] == 'failed' and src(D)['count'] is None
      and D['warnings'] == [] and src(D)['captured'] is None, (r['code'], D))
check('the failure names its reason for whoever reads the file',
      'timed out' in (src(D).get('reason') or ''), src(D))
check('a transient failure is retried through the backoff ladder before it is published',
      r['sleeps'] == [2, 5] and len(r['calls']) == 3, (r['sleeps'], len(r['calls'])))
rc, out = run_schema_gate(D)
check('the schema gate accepts the failed shape', rc == 0, out)

r = run(feed=(urllib.error.URLError('reset'), LIVE))
check('a retry that succeeds publishes ok', r['code'] == 0 and src(r['doc'])['status'] == 'ok',
      r['doc'] and r['doc']['sources'])

r = run(feed=urllib.error.HTTPError('https://x', 404, 'Not Found', {}, None))
check('a hard 404 is not retried and publishes failed',
      r['code'] == 1 and len(r['calls']) == 1 and src(r['doc'])['status'] == 'failed',
      (r['code'], len(r['calls'])))

for label, body in (('an HTML error page', '<html><body>Server Error</body></html>'),
                    ('an empty body', b''),
                    ('a JSON object instead of the array', {'error': 'maintenance'}),
                    ('JSON null', 'null'),
                    ('an array of junk', [{'SensorName': 'x'}, 7, 'nope'])):
    r = run(feed=body)
    check('malformed body (%s) publishes failed, never a zero' % label,
          r['code'] == 1 and src(r['doc'])['status'] == 'failed' and src(r['doc'])['count'] is None,
          (r['code'], r['doc']))

r = run(feed=[LIVE[0], {'SensorId': 9, 'SensorName': 'No location', 'Latitude': 0, 'Longitude': 0}])
D = r['doc']
check('one unplaceable entry is skipped and counted, the rest still publish',
      r['code'] == 0 and src(D)['status'] == 'ok' and src(D)['count'] == 1 and src(D)['skipped'] == 1,
      D and D['sources'])

# --- last good: carried, never as a zero -----------------------------------------------------
GOOD = run()['doc']
prev = dict(GOOD, generated=iso_ago(0.5))
r = run(feed=urllib.error.URLError('down'), previous=prev)
D = r['doc']
check('a failure inside the carry window republishes the last good warnings as carried',
      r['code'] == 1 and src(D)['status'] == 'carried' and src(D)['count'] == 2
      and D['warnings'] == GOOD['warnings'] and src(D)['carriedFrom'] == prev['generated'],
      (r['code'], D and D['sources']))
check('carried keeps the captured stamp of the read that produced it',
      src(D)['captured'] == src(GOOD)['captured'], src(D))
rc, out = run_schema_gate(D)
check('the schema gate accepts the carried shape', rc == 0, out)

r2 = run(feed=urllib.error.URLError('still down'), previous=dict(D, generated=iso_ago(0.1)))
check('a second failure keeps the original read time instead of ratcheting it forward',
      src(r2['doc'])['status'] == 'carried' and src(r2['doc'])['carriedFrom'] == prev['generated'],
      r2['doc'] and r2['doc']['sources'])

r = run(feed=urllib.error.URLError('down'), previous=dict(GOOD, generated=iso_ago(3)))
check('past the carry window the warnings are dropped and the read is failed',
      src(r['doc'])['status'] == 'failed' and r['doc']['warnings'] == [], r['doc'] and r['doc']['sources'])

ZERO = run(feed=[])['doc']
r = run(feed=urllib.error.URLError('down'), previous=dict(ZERO, generated=iso_ago(0.1)))
check('a previous zero is never carried: a failed read may not assert an absence',
      src(r['doc'])['status'] == 'failed' and src(r['doc'])['count'] is None, r['doc'])

r = run(feed=urllib.error.URLError('down'), previous='{not json')
check('an unreadable previous file publishes failed rather than crashing',
      r['code'] == 1 and src(r['doc'])['status'] == 'failed', (r['errors'], r['doc']))

# --- placeholders, bounds and duplicates -----------------------------------------------------
r = run(feed=[entry(Timestamp='0001-01-01T00:00:00')])
w = r['doc']['warnings'][0]
check('a 0001-01-01 record stamp is absent, so observed falls back to the reading time',
      w['observed'] == '2026-09-30T14:16:22Z', w)
r = run(feed=[entry(Timestamp='0001-01-01T00:00:00', StreamElevationLatestTimestamp='0001-01-01T00:00:00')])
w = r['doc']['warnings'][0]
check('a warning with only placeholder stamps is still published, with its time unstated',
      r['code'] == 0 and w['observed'] is None and w['stageAt'] is None, w)
rc, out = run_schema_gate(r['doc'])
check('the schema gate accepts an unstated observation time', rc == 0, out)

for radius in (0, -1, 50, None, 'x'):
    r = run(feed=[entry(Radius=radius)])
    check('radius %r is not drawn as a circle' % (radius,), r['doc']['warnings'][0]['radiusMi'] is None,
          r['doc']['warnings'][0])

r = run(feed=[entry(StreamElevationLatestValue=None, TopOfBank='null')])
w = r['doc']['warnings'][0]
check('an unreported reading and bank publish as null, never as 0',
      w['stageFt'] is None and w['bankFt'] is None, w)

r = run(feed=[entry(Timestamp='2026-09-30T08:00:00', StreamElevationLatestTimestamp='2026-09-30T08:00:00'),
              entry()])
check('a repeated sensor publishes once, keeping its latest report',
      len(r['doc']['warnings']) == 1 and r['doc']['warnings'][0]['observed'] == '2026-09-30T14:16:22Z',
      r['doc']['warnings'])

r = run(last_modified=None)
check('a feed that states no Last-Modified publishes captured null, not our clock',
      src(r['doc'])['captured'] is None and src(r['doc'])['status'] == 'ok', r['doc']['sources'])
for lm in ('Thu, 01 Jan 2099 00:00:00 GMT', 'not a date'):
    r = run(feed=[], last_modified=lm)
    check('Last-Modified %r publishes captured null, so an all-clear cannot look current forever' % lm,
          src(r['doc'])['captured'] is None and src(r['doc'])['status'] == 'ok', r['doc']['sources'])

# --- DST: Central local to UTC on both sides of each change ----------------------------------
mod = run(feed=[])['mod']
zone = ZoneInfo('America/Chicago')
later = datetime.datetime(2027, 1, 1, tzinfo=UTC)
for local, want, label in (
        ('2026-03-07T12:00:00', '2026-03-07T18:00:00Z', 'the day before spring forward is CST, -6h'),
        ('2026-03-09T12:00:00', '2026-03-09T17:00:00Z', 'the day after spring forward is CDT, -5h'),
        ('2026-10-31T12:00:00', '2026-10-31T17:00:00Z', 'the day before fall back is CDT, -5h'),
        ('2026-11-02T12:00:00', '2026-11-02T18:00:00Z', 'the day after fall back is CST, -6h'),
        ('2026-11-01T00:59:00', '2026-11-01T05:59:00Z', 'the minute before the repeated hour is CDT'),
        ('2026-11-01T03:00:00', '2026-11-01T09:00:00Z', 'the hour after the repeated one is CST'),
        ('2026-11-01T01:30:00', '2026-11-01T06:30:00Z', 'the repeated hour reads as its first (CDT) pass')):
    got = mod.local_to_iso(local, zone, later)
    check('DST · %s' % label, got == want, '%s -> %s, want %s' % (local, got, want))

now = datetime.datetime(2026, 9, 30, 14, 30, tzinfo=UTC)
check('a stamp that already states its offset is honoured rather than re-zoned',
      mod.local_to_iso('2026-09-30T14:00:00Z', zone, now) == '2026-09-30T14:00:00Z')
check('a stamp hours in the future cannot be aged, so it publishes as unstated',
      mod.local_to_iso('2026-09-30T15:30:00', zone, now) is None)
for junk in ('0001-01-01T00:00:00', '', 'null', None, 'yesterday', 20260930):
    check('timestamp %r publishes as unstated' % (junk,), mod.local_to_iso(junk, zone, now) is None)

# --- the gate refuses what the client could misread ------------------------------------------
BAD = [
    ('a failed read that reports a count', dict(ZERO, sources=[dict(src(ZERO), status='failed', count=0)])),
    ('a failed read that publishes warnings',
     dict(GOOD, sources=[dict(src(GOOD), status='failed', count=None)])),
    ('a carried read with nothing in it',
     dict(ZERO, sources=[dict(src(ZERO), status='carried', carriedFrom=ZERO['generated'])])),
    ('a carried read naming no carriedFrom', dict(GOOD, sources=[dict(src(GOOD), status='carried')])),
    ('a count that disagrees with warnings[]', dict(GOOD, sources=[dict(src(GOOD), count=5)])),
    ('an unknown status', dict(GOOD, sources=[dict(src(GOOD), status='stale')])),
    ('a warning with no location', dict(GOOD, warnings=[dict(GOOD['warnings'][0], lat=None)])),
    ('a warning with a zero radius', dict(GOOD, warnings=[dict(GOOD['warnings'][0], radiusMi=0)])),
    ('an unparseable observed stamp',
     dict(GOOD, warnings=[dict(GOOD['warnings'][0], observed='09/30 9:16')])),
    ('no sources at all', dict(GOOD, sources=[])),
]
for label, payload in BAD:
    rc, out = run_schema_gate(payload)
    check('GATE · rejects %s' % label, rc != 0 and 'transtar-flood.json' in out, (rc, out[-300:]))

print('---')
if FAILS:
    print('%d FAILURE(S)' % FAILS)
    sys.exit(1)
print('ALL PASS')
