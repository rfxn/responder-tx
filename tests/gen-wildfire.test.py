#!/usr/bin/env python3
"""tests/gen-wildfire.test.py — E1 semantics for scripts/gen-wildfire.py.

Zero active Texas wildfires is the NORMAL state for most of the year, so an empty read has to
publish cleanly. A failed read must never look like it. Both facts are asserted here, along with
the two null-vs-zero traps the sources actually carry: WFIGS omits PercentContained on about two
thirds of its records, and neither source is guaranteed to state when it was last built.

Drives the generator against stubbed responses under a fixture RESPONDER_ROOT (never the network,
never the real data/), then runs the cycle-check schema gate extracted from scripts/cycle-check.sh
against the generator's own output, so the gate and the generator are verified together.
Run: python3 tests/gen-wildfire.test.py"""
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
GEN = os.path.join(ROOT, 'scripts', 'gen-wildfire.py')
CYCLE_CHECK = os.path.join(ROOT, 'scripts', 'cycle-check.sh')

FAILS = 0


def check(name, ok, detail=''):
    global FAILS
    print('%s: %s%s' % ('PASS' if ok else 'FAIL', name, '' if ok else ' -> %s' % detail))
    if not ok:
        FAILS += 1


def load_gen(root):
    """Import gen-wildfire.py fresh with RESPONDER_ROOT pointed at a fixture. Pinned rather than
    inherited: an ambient one once aimed a test's generator at the live repo."""
    os.environ['RESPONDER_ROOT'] = root
    spec = importlib.util.spec_from_file_location('gen_wildfire_under_test', GEN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def tfs_feature(name='Upshur 6318', fid='ID-1', lon=-94.889, lat=32.575, **over):
    props = {'id': fid, 'name': name, 'statusname': 'Contained',
             'statustimestamp': '2026-07-29T01:03:27.000Z',
             'firsttimestatus': '2026-07-28T22:26:00.000Z',
             'lastupdated': '2026-07-29T01:04:00.108Z',
             'size': 2, 'sizeunit': 'Acres', 'containment': 100, 'containmentunit': 'Percent',
             'admindivision': 'Upshur', 'admindivisiontype': 'COUNTY',
             'protectingunit': 'TXTXS - Texas A & M Forest Service',
             'publicvisibility': 'Visible', 'categoryType': 'Wildfire'}
    props.update(over)
    return {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
            'properties': props}


def wfigs_feature(name='Frontera', fid='2026-NMN4S-000055', lon=-103.216, lat=35.714, **over):
    props = {'IncidentName': name, 'UniqueFireIdentifier': fid, 'POOState': 'US-NM',
             'POOCounty': 'Quay', 'IncidentSize': 45, 'PercentContained': None,
             'ModifiedOnDateTime_dt': 1784666188770, 'FireDiscoveryDateTime': 1772139645000,
             'POOProtectingAgency': 'SF', 'IncidentTypeCategory': 'WF'}
    props.update(over)
    return {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
            'properties': props}


def collection(features, **over):
    doc = {'type': 'FeatureCollection', 'features': features}
    doc.update(over)
    return doc


TFS_OK = collection([tfs_feature()], created='2026-07-29T03:55:03.767Z')
WFIGS_OK = collection([wfigs_feature()])


def perim_feature(name='Frontera', ring=None, **over):
    """A ring is [lon, lat] and must close, exactly as the service returns it."""
    ring = ring or [[-99.0, 31.0], [-99.0, 31.1], [-98.9, 31.1], [-98.9, 31.0], [-99.0, 31.0]]
    props = {'poly_IncidentName': name, 'poly_GISAcres': 120.5,
             'poly_IRWINID': '{ABC-123}', 'poly_DateCurrent': 1785297127038,
             'poly_FeatureCategory': 'Wildfire Daily Fire Perimeter',
             'poly_MapMethod': 'Image Interpretation'}
    props.update(over)
    return {'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': [ring]},
            'properties': props}


PERIM_OK = collection([])   # most cycles have no perimeter in scope; that is the ordinary case
META_OK = {'name': 'Incidents', 'editingInfo': {'lastEditDate': 1785297127038}}
ARCGIS_ERR = {'error': {'code': 400, 'message': "Invalid field: DailyAcres"}}
PREV = json.dumps({'generated': '2026-07-01T00:00:00Z',
                   'sources': [{'key': 'tfs', 'name': 'Texas A&M Forest Service',
                                'url': 'https://tfswildfires.com/public/', 'status': 'ok',
                                'captured': '2026-07-01T00:00:00Z', 'count': 1}],
                   'fires': [{'id': 'tfs:OLD', 'src': 'tfs', 'name': 'Older Fire', 'lat': 30.0,
                              'lon': -99.0, 'observed': '2026-07-01T00:00:00Z',
                              'acres': None, 'contain': None}]})


# The flood AO the fixture repo declares. The wildfire layer must NOT follow it: event.json is the
# flood area of operations, and a flood re-target must not redefine which fires the board carries.
TX_BBOX = {'xmin': -106.65, 'ymin': 25.83, 'xmax': -93.4, 'ymax': 36.5}
# the shipped outline itself, so these tests exercise the real ring rather than a stand-in
REPO_SCOPE = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                         '..', 'data', 'wildfire-scope.json')))


def run(tfs=TFS_OK, wfigs=WFIGS_OK, meta=META_OK, previous=None, bbox=TX_BBOX,
        buffer_mi=50, scope=True, perim=PERIM_OK):
    """Drive main() with urlopen routed by URL. Each of tfs/wfigs/meta is an Exception to raise,
    a body to answer with, or a list of either replayed in order (the last element repeats)."""
    root = tempfile.mkdtemp(prefix='gen-wildfire-test.')
    try:
        os.mkdir(os.path.join(root, 'data'))
        with open(os.path.join(root, 'data', 'event.json'), 'w') as f:
            json.dump({'name': 'Fixture AO', 'gaugeBbox': bbox}, f)
        if scope:
            with open(os.path.join(root, 'data', 'wildfire-scope.json'), 'w') as f:
                json.dump(dict(REPO_SCOPE, bufferMiles=buffer_mi), f)
        out = os.path.join(root, 'data', 'wildfire.json')
        if previous is not None:
            with open(out, 'w') as f:
                f.write(previous)
        mod = load_gen(root)

        class FakeResponse(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        calls, sleeps = [], []
        scripts = {k: (v if isinstance(v, list) else [v]) for k, v in
                   (('tfs', tfs), ('wfigs', wfigs), ('meta', meta), ('perim', perim))}
        seen = {'tfs': 0, 'wfigs': 0, 'meta': 0, 'perim': 0}

        def urlopen(req, timeout=None):
            url = req.full_url if hasattr(req, 'full_url') else str(req)
            if 'tfswildfires.com' in url:
                lane = 'tfs'
            elif 'Perimeters_Current' in url and '/query?' in url:
                lane = 'perim'
            elif '/query?' in url:
                lane = 'wfigs'
            else:
                lane = 'meta'
            calls.append((lane, url, timeout))
            steps = scripts[lane]
            step = steps[min(seen[lane], len(steps) - 1)]
            seen[lane] += 1
            if isinstance(step, Exception):
                raise step
            return FakeResponse(json.dumps(step).encode())

        mod.urllib.request.urlopen = urlopen
        mod.time.sleep = lambda s: sleeps.append(s)
        code = 0
        errors = []
        try:
            code = mod.main()
        except SystemExit as e:  # sys.exit("reason") exits 1; only an int code is itself
            code = e.code if isinstance(e.code, int) else 1
        except Exception as e:  # noqa: BLE001 — an uncaught raise is a non-zero run, not a dead suite
            code = 1
            errors.append(repr(e))
        body = open(out).read() if os.path.exists(out) else None
        return {'code': code, 'body': body, 'doc': json.loads(body) if body else None,
                'calls': calls, 'sleeps': sleeps, 'mod': mod, 'seen': seen, 'errors': errors}
    finally:
        os.environ.pop('RESPONDER_ROOT', None)
        shutil.rmtree(root, ignore_errors=True)


def src(doc, key):
    return next(s for s in doc['sources'] if s['key'] == key)


def extract_schema_gate():
    """Pull the check_schemas python block out of cycle-check.sh so the gate itself is tested."""
    source = open(CYCLE_CHECK).read()
    m = re.search(r"check_schemas\(\) \{\n\s*python3 - <<'EOF'\n(.*?)\nEOF\n", source, re.S)
    assert m, 'check_schemas python block not found in scripts/cycle-check.sh (structure changed?)'
    return m.group(1)


def run_schema_gate(payload):
    """Run the extracted gate in a fixture CWD holding only what it requires. Returns (rc, output)."""
    gate = extract_schema_gate()
    work = tempfile.mkdtemp(prefix='gen-wildfire-gate.')
    try:
        os.mkdir(os.path.join(work, 'data'))

        def write(name, obj):
            with open(os.path.join(work, 'data', name), 'w') as f:
                json.dump(obj, f)

        write('gauges-snapshot.json', {'generated': '2026-07-29T00:00:00Z',
                                       'gauges': [{'lid': 'AAAT2', 'status': {}}]})
        write('requests.json', {'requests': []})
        write('wildfire.json', payload)
        write('wildfire-scope.json', REPO_SCOPE)
        script = os.path.join(work, 'gate.py')
        with open(script, 'w') as f:
            f.write(gate)
        p = subprocess.run([sys.executable, script], cwd=work, capture_output=True, text=True)
        return p.returncode, (p.stdout or '') + (p.stderr or '')
    finally:
        shutil.rmtree(work, ignore_errors=True)


# --- the common path: both sources healthy --------------------------------------------------
r = run()
D = r['doc']
check('a healthy run publishes both sources ok and exits clean',
      r['code'] == 0 and src(D, 'tfs')['status'] == 'ok' and src(D, 'wfigs')['status'] == 'ok',
      'code=%s %s' % (r['code'], D and D['sources']))
check('every incident credits the source that reported it',
      sorted(f['src'] for f in D['fires']) == ['tfs', 'wfigs'], [f['src'] for f in D['fires']])
check('captured is the upstream stamp, not our clock',
      src(D, 'tfs')['captured'] == '2026-07-29T03:55:03Z'
      and src(D, 'wfigs')['captured'] == '2026-07-29T03:52:07Z'
      and src(D, 'tfs')['captured'] != D['generated'],
      [s['captured'] for s in D['sources']])
check('each source counts only what it contributed',
      src(D, 'tfs')['count'] == 1 and src(D, 'wfigs')['count'] == 1,
      [s['count'] for s in D['sources']])

# --- E1 · empty but valid is the normal Texas state and must publish clean -------------------
r = run(tfs=collection([], created='2026-07-29T03:55:03.767Z'), wfigs=collection([]))
D = r['doc']
check('an empty but valid read publishes as ok with count 0 and exits clean',
      r['code'] == 0 and D['fires'] == []
      and [s['status'] for s in D['sources']] == ['ok', 'ok', 'ok']
      and [s['count'] for s in D['sources']] == [0, 0, 0],
      'code=%s %s' % (r['code'], D['sources']))
check('an empty day still states when each source was last built, so it can be aged',
      src(D, 'tfs')['captured'] == '2026-07-29T03:55:03Z', src(D, 'tfs')['captured'])

# --- E1 · a failed read is never an empty one -----------------------------------------------
r = run(tfs=OSError('timed out'), wfigs=OSError('timed out'), previous=PREV)
check('both sources failing writes nothing and exits non-zero',
      r['code'] != 0 and r['body'] == PREV, 'code=%s body=%s' % (r['code'], str(r['body'])[:120]))

r = run(wfigs=ARCGIS_ERR, previous=PREV)
D = r['doc']
check('an ArcGIS error body inside HTTP 200 marks the source failed, never zero fires',
      r['code'] != 0 and src(D, 'wfigs')['status'] == 'failed'
      and src(D, 'wfigs')['count'] is None and src(D, 'wfigs')['captured'] is None,
      'code=%s %s' % (r['code'], D['sources']))
check('the failed source contributes no records while the healthy one publishes normally',
      [f['src'] for f in D['fires']] == ['tfs'] and src(D, 'tfs')['status'] == 'ok',
      [f['src'] for f in D['fires']])
check('a partial read still signs the cycle degraded rather than clean', r['code'] != 0, r['code'])

r = run(tfs=OSError('connection reset'))
D = r['doc']
check('the other direction degrades the same way: TFS down, WFIGS published',
      r['code'] != 0 and src(D, 'tfs')['status'] == 'failed'
      and src(D, 'wfigs')['status'] == 'ok' and [f['src'] for f in D['fires']] == ['wfigs'],
      'code=%s %s' % (r['code'], D['sources']))

r = run(tfs=[OSError('timed out'), OSError('timed out'), TFS_OK])
check('a transient failure is retried and a later attempt publishes',
      r['code'] == 0 and r['seen']['tfs'] == 3 and r['sleeps'][:2] == r['mod'].BACKOFFS[:2],
      'seen=%s sleeps=%s' % (r['seen'], r['sleeps']))

r = run(tfs=[urllib.error.HTTPError('https://tfswildfires.com/x', 429, 'Too Many', {}, None), TFS_OK])
check('a 429 is transient and retried, not read as a bad query',
      r['code'] == 0 and r['seen']['tfs'] == 2, 'seen=%s code=%s' % (r['seen'], r['code']))

r = run(tfs=urllib.error.HTTPError('https://tfswildfires.com/x', 404, 'Not Found', {}, None))
check('a hard 4xx aborts that source on the first attempt instead of burning the retry budget',
      r['seen']['tfs'] == 1 and r['sleeps'] == [] and src(r['doc'], 'tfs')['status'] == 'failed',
      'seen=%s sleeps=%s' % (r['seen'], r['sleeps']))

r = run(tfs={'type': 'FeatureCollection', 'created': '2026-07-29T03:55:03.767Z'})
check('a body with no features[] is a failed read, never a fire-free day',
      src(r['doc'], 'tfs')['status'] == 'failed' and r['code'] != 0, r['doc']['sources'])

r = run(wfigs=collection([wfigs_feature()], exceededTransferLimit=True))
D = r['doc']
check('a set still truncated after the page ceiling fails rather than inventing an absence',
      src(D, 'wfigs')['status'] == 'failed' and not [f for f in D['fires'] if f['src'] == 'wfigs']
      and r['seen']['wfigs'] == r['mod'].MAX_PAGES,
      'seen=%s %s' % (r['seen'], D['sources']))

# --- the capture stamp: unknown currency is a fact, not a reason to substitute our own -------
r = run(tfs=collection([tfs_feature()]))
D = r['doc']
check('an upstream that states no build time publishes captured null, never our clock',
      src(D, 'tfs')['captured'] is None and src(D, 'tfs')['status'] == 'ok'
      and src(D, 'tfs')['captured'] != D['generated'], src(D, 'tfs')['captured'])
r = run(meta=OSError('timed out'))
D = r['doc']
check('an unreadable service stamp leaves currency unknown without failing a good incident read',
      r['code'] == 0 and src(D, 'wfigs')['status'] == 'ok'
      and src(D, 'wfigs')['captured'] is None and src(D, 'wfigs')['count'] == 1,
      'code=%s %s' % (r['code'], D['sources']))

# --- null is not zero ------------------------------------------------------------------------
r = run(wfigs=collection([wfigs_feature(PercentContained=None, IncidentSize=None)]))
fire = [f for f in r['doc']['fires'] if f['src'] == 'wfigs'][0]
check('an unreported containment publishes as null, never as 0% contained',
      fire['contain'] is None and fire['contain'] != 0, fire)
check('an unreported size publishes as null, never as 0 acres', fire['acres'] is None, fire)
r = run(wfigs=collection([wfigs_feature(PercentContained=0)]))
fire = [f for f in r['doc']['fires'] if f['src'] == 'wfigs'][0]
check('a genuinely reported 0% is still published as 0, so null and zero stay different facts',
      fire['contain'] == 0, fire)
r = run(wfigs=collection([wfigs_feature(PercentContained=140, IncidentSize=-3)]))
fire = [f for f in r['doc']['fires'] if f['src'] == 'wfigs'][0]
check('an out-of-range figure publishes as null rather than as a measurement nobody made',
      fire['contain'] is None and fire['acres'] is None, fire)
r = run(tfs=collection([tfs_feature(size=12, sizeunit='Hectares', containment=50,
                                    containmentunit='Percent')],
                       created='2026-07-29T03:55:03.767Z'))
fire = [f for f in r['doc']['fires'] if f['src'] == 'tfs'][0]
check('a size in units other than acres publishes no acreage rather than a mislabelled number',
      fire['acres'] is None and fire['contain'] == 50, fire)

# --- scope: what each source is allowed to contribute ---------------------------------------
r = run(wfigs=collection([wfigs_feature(POOState='US-TX', POOCounty='Bastrop')]))
check('a Texas WFIGS record is dropped, because TFS is authoritative in state',
      not [f for f in r['doc']['fires'] if f['src'] == 'wfigs']
      and src(r['doc'], 'wfigs')['status'] == 'ok', r['doc']['fires'])
r = run(tfs=collection([tfs_feature(categoryType='Prescribed'),
                        tfs_feature(fid='ID-2', publicvisibility='Hidden')],
                       created='2026-07-29T03:55:03.767Z'))
check('a prescribed burn and a non-public incident are both dropped, and the read stays ok',
      not [f for f in r['doc']['fires'] if f['src'] == 'tfs']
      and src(r['doc'], 'tfs')['status'] == 'ok' and src(r['doc'], 'tfs')['count'] == 0,
      r['doc']['sources'])
r = run(tfs=collection([tfs_feature(lon=-70.0, lat=43.0)], created='2026-07-29T03:55:03.767Z'))
check('an incident outside the area of operations is dropped',
      not [f for f in r['doc']['fires'] if f['src'] == 'tfs'], r['doc']['fires'])
# SCOPE: the fire layer is keyed to data/wildfire-scope.json, never to the flood AO. Narrowing
# event.json used to silently shrink the fire layer with it, which is E6 in reverse.
r = run(bbox={'xmin': -99.5, 'ymin': 29.5, 'xmax': -98.5, 'ymax': 30.5})
check('SCOPE · narrowing the flood AO does not narrow the wildfire layer',
      [f for f in r['doc']['fires'] if f['src'] == 'tfs'], r['doc']['fires'])
r = run(tfs=collection([tfs_feature(lon=-97.74, lat=30.27)], created='2026-07-29T03:55:03.767Z'))
check('SCOPE · a Texas incident publishes as scope tx',
      [f for f in r['doc']['fires'] if f['src'] == 'tfs' and f['scope'] == 'tx'], r['doc']['fires'])
# Shreveport LA, 17 mi out: close enough that its smoke and its mutual aid both reach Texas
r = run(wfigs=collection([wfigs_feature(lon=-93.75, lat=32.53, POOState='US-LA')]))
check('SCOPE · an out-of-state incident inside the buffer publishes as scope buffer',
      [f for f in r['doc']['fires'] if f['src'] == 'wfigs' and f['scope'] == 'buffer'],
      r['doc']['fires'])
# Santa Fe NM, 159 mi out: the exact shape of record a Texas-shaped bounding box used to admit
r = run(wfigs=collection([wfigs_feature(lon=-105.87, lat=35.67, POOState='US-NM')]))
check('SCOPE · an incident well outside the buffer is dropped, and the run still publishes clean',
      r['code'] == 0 and not [f for f in r['doc']['fires'] if f['src'] == 'wfigs'],
      r['doc']['fires'])
r = run(buffer_mi=0, wfigs=collection([wfigs_feature(lon=-93.75, lat=32.53, POOState='US-LA')]))
check('SCOPE · a zero buffer keeps Texas and drops everything beyond the line',
      not [f for f in r['doc']['fires'] if f['src'] == 'wfigs'], r['doc']['fires'])
r = run(scope=False)
check('SCOPE · an unreadable scope file refuses to publish rather than guessing at coverage',
      r['code'] != 0 and r['doc'] is None, (r['code'], r['doc']))
r = run(tfs=collection([tfs_feature(lastupdated=None, statustimestamp=None),
                        tfs_feature(fid='ID-3', name='')],
                       created='2026-07-29T03:55:03.767Z'))
check('an undated or unnamed incident is skipped, because it could be neither aged nor named',
      not [f for f in r['doc']['fires'] if f['src'] == 'tfs'], r['doc']['fires'])
r = run(tfs=collection([{'type': 'Feature', 'geometry': None, 'properties': None},
                        tfs_feature()], created='2026-07-29T03:55:03.767Z'))
check('one malformed feature is skipped and the rest of the read still publishes',
      r['code'] == 0 and len([f for f in r['doc']['fires'] if f['src'] == 'tfs']) == 1,
      r['doc']['fires'])

# the retry budget has to stay a small fraction of the 15-minute publish window, per source
MOD = run()['mod']
WORST = (len(MOD.BACKOFFS) + 1) * MOD.TIMEOUT + sum(MOD.BACKOFFS)
check('the worst-case retry budget for one source stays well inside the cycle window',
      WORST <= 60, '%ss worst case' % WORST)

# --- cycle-check: the gate's expectation -----------------------------------------------------
GOOD_SOURCES = [{'key': 'tfs', 'name': 'Texas A&M Forest Service',
                 'url': 'https://tfswildfires.com/public/', 'status': 'ok',
                 'captured': '2026-07-29T03:55:03Z', 'count': 1},
                {'key': 'wfigs', 'name': 'National Interagency Fire Center (WFIGS)',
                 'url': 'https://data-nifc.opendata.arcgis.com/', 'status': 'failed',
                 'captured': None, 'count': None}]
FIRE = {'id': 'tfs:ID-1', 'src': 'tfs', 'name': 'Upshur 6318', 'lat': 32.575, 'lon': -94.889,
        'scope': 'tx', 'status': 'Contained', 'acres': 2, 'contain': 100,
        'observed': '2026-07-29T01:04:00Z'}


def payload(fires, sources=None):
    return {'generated': '2026-07-29T04:00:00Z',
            'sources': sources if sources is not None else GOOD_SOURCES, 'fires': fires}


rc, log = run_schema_gate(payload([FIRE]))
check('the schema gate accepts a half-sourced but honest file', rc == 0, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(payload([]))
check('the schema gate accepts a fire-free day, which is the normal Texas state',
      rc == 0, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(payload([dict(FIRE, src='wfigs')]))
check('the schema gate rejects a record that outlived the source marked failed',
      rc != 0 and 'marked failed' in log, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(payload([dict(FIRE, src='nifc')]))
check('the schema gate rejects a record crediting a source the file does not name',
      rc != 0, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(payload([{k: v for k, v in FIRE.items() if k != 'observed'}]))
check('the schema gate rejects an undated incident, because nothing could age it',
      rc != 0 and 'aged' in log, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(payload([dict(FIRE, contain='100')]))
check('the schema gate rejects a containment that is neither a number nor null',
      rc != 0, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(payload([dict(FIRE, contain=140)]))
check('the schema gate rejects a containment outside 0-100', rc != 0, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(payload([dict(FIRE, contain=None, acres=None)]))
check('the schema gate accepts null acreage and null containment as first-class facts',
      rc == 0, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(payload([], sources=[dict(GOOD_SOURCES[1], count=7)]))
check('the schema gate rejects a failed source that still reports a count',
      rc != 0 and 'failed but reports count' in log, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(payload([], sources=[]))
check('the schema gate rejects a payload that names no source at all',
      rc != 0, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(payload([], sources=[dict(GOOD_SOURCES[0], status='degraded')]))
check('the schema gate rejects a status outside ok/failed', rc != 0, 'rc=%s %s' % (rc, log))

# --- the generator's own output survives the gate it will be published through ---------------
rc, log = run_schema_gate(run()['doc'])
check('the generator writes what the release gate accepts', rc == 0, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(run(wfigs=ARCGIS_ERR)['doc'])
check('a degraded run also writes what the release gate accepts', rc == 0, 'rc=%s %s' % (rc, log))


# GATE · the scope decision is re-derived from the outline, not taken on the generator's word: a
# widened scope would otherwise publish out-of-state fires with nobody noticing.
rc, log = run_schema_gate(payload([dict(FIRE, lat=39.74, lon=-104.99, scope='buffer')]))
check('the schema gate rejects a fire past the border buffer even when it is labelled buffer',
      rc != 0 and 'past the' in log, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(payload([dict(FIRE, scope='buffer')]))
check('the schema gate rejects a Texas fire mislabelled as out of state',
      rc != 0 and 'inside Texas but labelled' in log, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(payload([dict(FIRE, lat=32.53, lon=-93.75, scope='tx')]))
check('the schema gate rejects an out-of-state fire mislabelled as Texas',
      rc != 0 and 'outside Texas but labelled' in log, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(payload([dict(FIRE, lat=32.53, lon=-93.75, scope='buffer')]))
check('the schema gate accepts a Louisiana fire 17 mi from the line, which is inside the buffer',
      rc == 0, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(payload([FIRE, dict(FIRE, id='tfs:ID-2', scope=None)]))
check('the schema gate rejects a half-populated scope column rather than trusting the labelled half',
      rc != 0 and 'partial column' in log, 'rc=%s %s' % (rc, log))
# --- perimeters: an edge where one is published, never a claim where none is -----------------
r = run(perim=collection([perim_feature()]))
D = r['doc']
P = D['perimeters']
check('a perimeter in scope is published with its ring, name and mapping provenance',
      len(P) == 1 and P[0]['name'] == 'Frontera' and P[0]['acres'] == 120.5
      and P[0]['method'] == 'Image Interpretation' and len(P[0]['rings'][0]) == 5, P)
check('the ring keeps [lon, lat] order, so the client flip lands in Texas',
      P[0]['rings'][0][0] == [-99.0, 31.0], P[0]['rings'][0][0])
check('the perimeter read gets its own source row, so a failure is visible',
      src(D, 'wfigs-perimeters')['status'] == 'ok' and src(D, 'wfigs-perimeters')['count'] == 1,
      D['sources'])

# a fire whose edge crosses the line is ours even when most of it is not
r = run(perim=collection([perim_feature(
    ring=[[-94.5, 33.0], [-93.0, 33.0], [-93.0, 33.5], [-94.5, 33.5], [-94.5, 33.0]])]))
check('a perimeter with only some vertices in scope is kept, not dropped',
      len(r['doc']['perimeters']) == 1, r['doc']['perimeters'])

r = run(perim=collection([perim_feature(ring=[[-80.0, 40.0], [-79.9, 40.0], [-79.9, 40.1],
                                             [-80.0, 40.1], [-80.0, 40.0]])]))
check('a perimeter wholly outside the scope is dropped',
      r['doc']['perimeters'] == [], r['doc']['perimeters'])

# E1 · an enrichment that fails must not empty the layer it enriches
r = run(perim=OSError('timed out'))
D = r['doc']
check('a failed perimeter read publishes as failed with a null count, never as zero edges',
      src(D, 'wfigs-perimeters')['status'] == 'failed'
      and src(D, 'wfigs-perimeters')['count'] is None and D['perimeters'] == [],
      D['sources'])
check('a failed perimeter read still publishes every incident from both live sources',
      [f['src'] for f in D['fires']] == ['tfs', 'wfigs'],
      [f['src'] for f in D['fires']])

r = run(perim=ARCGIS_ERR)
check('an ArcGIS error body inside HTTP 200 marks the perimeter source failed, never zero edges',
      src(r['doc'], 'wfigs-perimeters')['status'] == 'failed' and r['doc']['perimeters'] == [],
      r['doc']['sources'])

# holes are dropped deliberately; an unburnt island is not an operational fact at this zoom
r = run(perim=collection([{
    'type': 'Feature',
    'geometry': {'type': 'Polygon', 'coordinates': [
        [[-99.0, 31.0], [-99.0, 31.2], [-98.8, 31.2], [-98.8, 31.0], [-99.0, 31.0]],
        [[-98.95, 31.05], [-98.95, 31.1], [-98.9, 31.1], [-98.95, 31.05]]]},
    'properties': {'poly_IncidentName': 'Holed', 'poly_GISAcres': 10,
                   'poly_DateCurrent': 1785297127038}}]))
check('a polygon hole is dropped and only the outer ring is published',
      len(r['doc']['perimeters'][0]['rings']) == 1
      and len(r['doc']['perimeters'][0]['rings'][0]) == 5, r['doc']['perimeters'])

r = run(perim=collection([perim_feature(ring=[[-99.0, 31.0], [-99.0, 31.1], [-99.0, 31.0]])]))
check('a ring with too few points to be a polygon is skipped rather than drawn',
      r['doc']['perimeters'] == [], r['doc']['perimeters'])

# an enrichment failure is reported without spending the cycle's DEGRADED signal
r = run(perim=OSError('timed out'))
check('a perimeter timeout alone exits CLEAN, so the cycle keeps DEGRADED for the incidents',
      r['code'] == 0 and src(r['doc'], 'wfigs-perimeters')['status'] == 'failed',
      'code=%s %s' % (r['code'], r['doc']['sources']))
check('a failed incident source still exits degraded even when perimeters are fine',
      run(wfigs=ARCGIS_ERR)['code'] != 0, run(wfigs=ARCGIS_ERR)['code'])

print('----')
if FAILS == 0:
    print('ALL GEN-WILDFIRE TESTS PASSED')
    sys.exit(0)
print('%d TEST(S) FAILED' % FAILS)
sys.exit(1)
