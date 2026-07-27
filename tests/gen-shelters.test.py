#!/usr/bin/env python3
"""tests/gen-shelters.test.py — shelter-status honesty for scripts/gen-shelters.py.

A FEMA NSS record with no reported shelter_status must publish as "unknown", never
as OPEN: a green "OPEN: <name>" carrying a FEMA/ARC citation asserts an openness no
authoritative source reported. Drives the generator against a stubbed NSS response
under a fixture RESPONDER_ROOT (never the network, never the real data/), then runs
the cycle-check schema gate extracted from scripts/cycle-check.sh against fixture
output so the gate's expectation is verified alongside the generator's default.
Run: python3 tests/gen-shelters.test.py"""
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GEN = os.path.join(ROOT, 'scripts', 'gen-shelters.py')
CYCLE_CHECK = os.path.join(ROOT, 'scripts', 'cycle-check.sh')

FAILS = 0


def check(name, ok, detail=''):
    global FAILS
    print('%s: %s%s' % ('PASS' if ok else 'FAIL', name, '' if ok else ' -> %s' % detail))
    if not ok:
        FAILS += 1


def load_gen(root):
    """Import gen-shelters.py fresh with RESPONDER_ROOT pointed at a fixture."""
    os.environ['RESPONDER_ROOT'] = root
    spec = importlib.util.spec_from_file_location('gen_shelters_under_test', GEN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def feature(name, status, lon=-99.0, lat=29.0):
    props = {'shelter_name': name, 'address': '1 Main St', 'city': 'Uvalde', 'state': 'TX'}
    if status is not _MISSING:
        props['shelter_status'] = status
    return {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [lon, lat]}, 'properties': props}


class _Missing:
    pass


_MISSING = _Missing()


def run_generator(features):
    """Run main() with urlopen stubbed to return `features`; returns the written payload."""
    root = tempfile.mkdtemp()
    try:
        os.mkdir(os.path.join(root, 'data'))
        mod = load_gen(root)

        class FakeResponse(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        body = json.dumps({'type': 'FeatureCollection', 'features': features}).encode()
        mod.urllib.request.urlopen = lambda req, timeout=None: FakeResponse(body)
        mod.main()
        with open(os.path.join(root, 'data', 'shelters-live.json')) as f:
            return json.load(f)
    finally:
        os.environ.pop('RESPONDER_ROOT', None)
        shutil.rmtree(root, ignore_errors=True)


def extract_schema_gate():
    """Pull the check_schemas python block out of cycle-check.sh so the gate itself is tested."""
    src = open(CYCLE_CHECK).read()
    m = re.search(r"check_schemas\(\) \{\n\s*python3 - <<'EOF'\n(.*?)\nEOF\n", src, re.S)
    assert m, 'check_schemas python block not found in scripts/cycle-check.sh (structure changed?)'
    return m.group(1)


def run_schema_gate(shelters):
    """Run the extracted gate in a fixture CWD holding only what it requires. Returns (rc, output)."""
    gate = extract_schema_gate()
    work = tempfile.mkdtemp()
    try:
        os.mkdir(os.path.join(work, 'data'))

        def write(name, obj):
            with open(os.path.join(work, 'data', name), 'w') as f:
                json.dump(obj, f)

        write('gauges-snapshot.json', {'generated': '2026-07-24T00:00:00Z',
                                       'gauges': [{'lid': 'AAAT2', 'status': {}}]})
        write('requests.json', {'requests': []})
        write('shelters-live.json', {'generated': '2026-07-24T00:00:00Z', 'shelters': shelters})
        script = os.path.join(work, 'gate.py')
        with open(script, 'w') as f:
            f.write(gate)
        p = subprocess.run([sys.executable, script], cwd=work, capture_output=True, text=True)
        return p.returncode, (p.stdout or '') + (p.stderr or '')
    finally:
        shutil.rmtree(work, ignore_errors=True)


SHELTER = {'name': 'Civic Center', 'lat': 29.0, 'lon': -99.0}

# --- generator: the status default -----------------------------------------
out = run_generator([
    feature('No status at all', _MISSING),
    feature('Null status', None, lon=-99.1),
    feature('Empty status', '', lon=-99.2),
    feature('Whitespace status', '   ', lon=-99.3),
])
statuses = [s['status'] for s in out['shelters']]
check('a record with no reported status publishes as unknown, never OPEN',
      statuses == ['unknown'] * 4, statuses)
check('no status-less record is ever labelled OPEN',
      not any(s.upper() == 'OPEN' for s in statuses), statuses)

out = run_generator([
    feature('Open one', 'OPEN'),
    feature('Standby one', 'STANDBY', lon=-99.1),
    feature('Closed one', 'CLOSED', lon=-99.2),
    feature('Full one', 'FULL', lon=-99.3),
])
check('a real reported status is passed through verbatim',
      [s['status'] for s in out['shelters']] == ['OPEN', 'STANDBY', 'CLOSED', 'FULL'],
      [s['status'] for s in out['shelters']])

out = run_generator([feature('Padded', '  OPEN  ')])
check('a padded reported status is trimmed, not turned into unknown',
      out['shelters'][0]['status'] == 'OPEN', out['shelters'][0]['status'])

out = run_generator([])
check('an empty but healthy feed still writes a valid empty file',
      out['shelters'] == [] and 'generated' in out and 'source' in out, out)

# --- the retry: a flaky host must not stale the layer ------------------------
# The NSS host intermittently hangs (measured 2026-07-27: the generator's own query answered in
# 0.47s, another probe in the same minute held the socket open past 25s). A single attempt turned
# that into four DEGRADED cycles in one hour, interleaved with clean ones.
def run_sequence(sequence, previous=None):
    """Drive main() against a scripted urlopen sequence. Each element is an Exception to raise or
    a decoded body to answer with; the last element repeats. Returns a result dict."""
    root = tempfile.mkdtemp()
    try:
        os.mkdir(os.path.join(root, 'data'))
        out = os.path.join(root, 'data', 'shelters-live.json')
        if previous is not None:
            with open(out, 'w') as f:
                f.write(previous)
        mod = load_gen(root)

        class FakeResponse(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        deadlines, sleeps = [], []

        def urlopen(req, timeout=None):
            step = sequence[min(len(deadlines), len(sequence) - 1)]
            deadlines.append(timeout)
            if isinstance(step, Exception):
                raise step
            return FakeResponse(json.dumps(step).encode())

        mod.urllib.request.urlopen = urlopen
        mod.time.sleep = lambda s: sleeps.append(s)
        code = 0
        try:
            mod.main()
        except SystemExit as e:  # sys.exit("reason") exits 1; only an int code is itself
            code = e.code if isinstance(e.code, int) else 1
        body = open(out).read() if os.path.exists(out) else None
        return {'attempts': len(deadlines), 'sleeps': sleeps, 'code': code,
                'body': body, 'deadlines': deadlines, 'mod': mod}
    finally:
        os.environ.pop('RESPONDER_ROOT', None)
        shutil.rmtree(root, ignore_errors=True)


GOOD = {'type': 'FeatureCollection', 'features': [feature('Civic Center', 'OPEN')]}
ERR_BODY = {'error': {'code': 500, 'message': 'Unable to complete operation'}}
PREV = json.dumps({'generated': '2026-07-01T00:00:00Z', 'source': {'name': 'FEMA NSS'},
                   'shelters': [{'name': 'Older Shelter', 'address': '', 'lat': 29.0,
                                 'lon': -99.0, 'status': 'OPEN'}]})

r = run_sequence([OSError('timed out'), OSError('timed out'), GOOD])
check('a transient upstream failure is retried and a later attempt publishes',
      r['code'] == 0 and r['attempts'] == 3
      and json.loads(r['body'])['shelters'][0]['name'] == 'Civic Center',
      'attempts=%s code=%s' % (r['attempts'], r['code']))
check('the retry waits the declared backoff between attempts',
      len(r['sleeps']) == 2 and r['sleeps'] == r['mod'].BACKOFFS[:2], r['sleeps'])

URL_STUB = 'https://gis.fema.gov/q'
r = run_sequence([urllib.error.HTTPError(URL_STUB, 429, 'Too Many Requests', {}, None), GOOD])
check('a 429 is transient and retried, not treated as a bad query',
      r['code'] == 0 and r['attempts'] == 2, 'attempts=%s code=%s' % (r['attempts'], r['code']))

# E1 · an ArcGIS error inside HTTP 200 is a failed request, never zero shelters
r = run_sequence([ERR_BODY, GOOD])
check('an ArcGIS error body inside HTTP 200 is retried rather than published as zero shelters',
      r['code'] == 0 and r['attempts'] == 2 and len(json.loads(r['body'])['shelters']) == 1,
      'attempts=%s code=%s' % (r['attempts'], r['code']))

r = run_sequence([OSError('timed out')], previous=PREV)
MOD = r['mod']
check('a persistent failure still aborts non-zero', r['code'] != 0, 'code=%s' % r['code'])
check('a persistent failure leaves the previous file byte-identical, so it ages honestly',
      r['body'] == PREV, str(r['body'])[:120])
check('a persistent failure stops at the declared attempt ceiling',
      r['attempts'] == len(MOD.BACKOFFS) + 1, r['attempts'])

r = run_sequence([ERR_BODY], previous=PREV)
check('a persistent ArcGIS error body aborts and keeps the previous file',
      r['code'] != 0 and r['body'] == PREV and r['attempts'] == len(MOD.BACKOFFS) + 1,
      'attempts=%s code=%s' % (r['attempts'], r['code']))

# a bad query is our bug: retrying it only burns the cycle's budget
r = run_sequence([urllib.error.HTTPError(URL_STUB, 400, 'Bad Request', {}, None)], previous=PREV)
check('a hard 4xx aborts on the first attempt instead of burning the retry budget',
      r['code'] != 0 and r['attempts'] == 1 and r['sleeps'] == [] and r['body'] == PREV,
      'attempts=%s sleeps=%s' % (r['attempts'], r['sleeps']))

# The cycle publishes every 15 minutes and a healthy NSS answer measures ~0.5s, so the whole
# retry budget has to stay a small fraction of the window even with every attempt timing out.
WORST = (len(MOD.BACKOFFS) + 1) * MOD.TIMEOUT + sum(MOD.BACKOFFS)
check('the worst-case retry budget stays well inside the 15-minute cycle',
      WORST <= 60, '%ss worst case' % WORST)
check('every attempt uses the declared deadline, so no single hang can outlast it',
      set(r['deadlines']) == {MOD.TIMEOUT}, r['deadlines'])

# --- cycle-check: the gate's expectation ------------------------------------
rc, log = run_schema_gate([dict(SHELTER, status='unknown')])
check("the schema gate accepts 'unknown' (the generator's default must not break the cycle)",
      rc == 0, 'rc=%s %s' % (rc, log))

rc, log = run_schema_gate([dict(SHELTER, status='OPEN'), dict(SHELTER, status='closed')])
check('the schema gate accepts the mapped vocabulary in either case', rc == 0, 'rc=%s %s' % (rc, log))

rc, log = run_schema_gate([dict(SHELTER, status='')])
check('the schema gate rejects a status-less record and names unknown as the fix',
      rc != 0 and 'unknown' in log, 'rc=%s %s' % (rc, log))

rc, log = run_schema_gate([dict(SHELTER)])
check('the schema gate rejects a missing status key', rc != 0, 'rc=%s %s' % (rc, log))

rc, log = run_schema_gate([dict(SHELTER, status='EVACUATION CENTER')])
check('upstream vocabulary drift notes but never aborts the data cycle',
      rc == 0 and 'outside the mapped vocabulary' in log, 'rc=%s %s' % (rc, log))

# --- the app renders the honest value ---------------------------------------
panels = open(os.path.join(ROOT, 'js', 'panels.js'), encoding='utf-8').read()
check("js/panels.js maps 'unknown' to its own honest label",
      re.search(r"unknown: \{ key: 'shl\.st\.unknown'", panels) is not None)
i18n = open(os.path.join(ROOT, 'js', 'i18n.js'), encoding='utf-8').read()
check("shl.st.unknown has en and es strings", i18n.count("'shl.st.unknown':") == 2,
      i18n.count("'shl.st.unknown':"))

print('----')
if FAILS == 0:
    print('ALL GEN-SHELTERS TESTS PASSED')
    sys.exit(0)
print('%d TEST(S) FAILED' % FAILS)
sys.exit(1)
