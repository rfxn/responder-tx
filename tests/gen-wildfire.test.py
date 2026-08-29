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
import datetime
import importlib.util
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse

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
             'POOProtectingAgency': 'SF', 'POOProtectingUnit': 'NMN4S',
             'IncidentTypeCategory': 'WF'}
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
             'poly_PolygonDateTime': 1785000000000,
             'poly_FeatureCategory': 'Wildfire Daily Fire Perimeter',
             'poly_MapMethod': 'Image Interpretation',
             'attr_LocalIncidentIdentifier': '267549', 'attr_POOState': 'US-TX',
             'attr_IncidentComplexityLevel': 'Type 3 Incident'}
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


def query_url(calls, lane):
    return next(u for lane_seen, u, _ in calls if lane_seen == lane)


def query_envelope(calls, lane):
    """The bbox the generator actually asked upstream for, read back off the recorded query."""
    q = urllib.parse.parse_qs(urllib.parse.urlparse(query_url(calls, lane)).query)
    return [float(v) for v in q['geometry'][0].split(',')]


def bare(perim):
    return {k: v for k, v in perim.items() if k != 'rings'}


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

# complexity is the one threat tier either source states. It is an open upstream vocabulary, so it
# is published exactly as read, like status.
r = run(wfigs=collection([wfigs_feature(IncidentComplexityLevel='Type 5 Incident')]))
fire = [f for f in r['doc']['fires'] if f['src'] == 'wfigs'][0]
check('an incident publishes the complexity tier its source stated, verbatim and unmapped',
      fire['complexity'] == 'Type 5 Incident', fire)
check('the incident query asks upstream for the complexity column it publishes',
      'IncidentComplexityLevel' in query_url(r['calls'], 'wfigs'), query_url(r['calls'], 'wfigs'))
fire = [f for f in run()['doc']['fires'] if f['src'] == 'wfigs'][0]
check('an incident whose source states no complexity publishes null, not an invented tier',
      fire['complexity'] is None, fire)

# --- DEDUPE · TFS protects state and private land only ---------------------------------------
# Dropping every Texas WFIGS record made federal-land fires invisible by construction, because TFS
# never carries them. The discriminator is the unit that protects the point of origin.
r = run(wfigs=collection([wfigs_feature(name='Ross', POOState='US-TX', POOCounty='Sutton',
                                        POOProtectingUnit='TXTXS', POOProtectingAgency='SFS',
                                        lon=-100.15, lat=30.37)]))
check('DEDUPE · a Texas fire TFS itself protects is dropped, because TFS publishes that same fire',
      not [f for f in r['doc']['fires'] if f['src'] == 'wfigs']
      and src(r['doc'], 'wfigs')['status'] == 'ok', r['doc']['fires'])
check('DEDUPE · the incident query asks upstream for the protecting unit it discriminates on',
      'POOProtectingUnit' in query_url(r['calls'], 'wfigs'), query_url(r['calls'], 'wfigs'))
# the live case this fix exists for: Big Bend NP, 5 acres, dropped for as long as the state rule stood
r = run(wfigs=collection([wfigs_feature(name='Black', fid='2026-TXBBP-000123', POOState='US-TX',
                                        POOCounty='Brewster', POOProtectingUnit='TXBBP',
                                        POOProtectingAgency='NPS', IncidentSize=5,
                                        lon=-103.25, lat=29.27)]))
W = [f for f in r['doc']['fires'] if f['src'] == 'wfigs']
check('DEDUPE · a Texas fire on National Park land is published, because TFS never carries it',
      len(W) == 1 and W[0]['name'] == 'Black' and W[0]['state'] == 'TX' and W[0]['scope'] == 'tx',
      W)
r = run(wfigs=collection([wfigs_feature(name='Rita Blanca Unit 32', fid='2026-TXNFT-000032',
                                        POOState='US-TX', POOCounty='Dallam',
                                        POOProtectingUnit='TXNFT', POOProtectingAgency='USFS',
                                        IncidentSize=8907, lon=-102.9, lat=36.0)]))
check('DEDUPE · a Texas fire on Forest Service land is published for the same reason',
      [f['name'] for f in r['doc']['fires'] if f['src'] == 'wfigs'] == ['Rita Blanca Unit 32'],
      r['doc']['fires'])
# AMBIGUOUS · the deliberate choice: an unrecognised or unstated unit publishes. A fire listed twice
# is recoverable in the field; a fire the board omits is not.
r = run(wfigs=collection([wfigs_feature(name='Unstated', POOState='US-TX',
                                        POOProtectingUnit=None, lon=-97.74, lat=30.27)]))
check('DEDUPE · a Texas fire whose protecting unit is unstated is published, not dropped on a guess',
      [f['name'] for f in r['doc']['fires'] if f['src'] == 'wfigs'] == ['Unstated'], r['doc']['fires'])
r = run(wfigs=collection([wfigs_feature(name='Parks', POOState='US-TX',
                                        POOProtectingUnit='TXTXP', lon=-97.74, lat=30.27)]))
check('DEDUPE · the unit is matched whole, so another Texas agency sharing the TXTX prefix survives',
      [f['name'] for f in r['doc']['fires'] if f['src'] == 'wfigs'] == ['Parks'], r['doc']['fires'])
r = run(wfigs=collection([wfigs_feature(name='Recased', POOState='US-TX',
                                        POOProtectingUnit=' txtxs ', lon=-97.74, lat=30.27)]))
check('DEDUPE · a re-cased or padded TXTXS is still the same unit and still a duplicate',
      not [f for f in r['doc']['fires'] if f['src'] == 'wfigs'], r['doc']['fires'])
r = run(wfigs=collection([wfigs_feature(name='Ross', POOState='US-TX', POOProtectingUnit='TXTXS',
                                        lon=-100.15, lat=30.37),
                          wfigs_feature(name='Velma', fid='2026-OKOKSC-260926', POOState='US-OK',
                                        POOProtectingUnit='OKOKS', lon=-97.68, lat=34.46)]))
check('DEDUPE · dropping a Texas duplicate leaves the out-of-state records in the same read alone',
      [f['name'] for f in r['doc']['fires'] if f['src'] == 'wfigs'] == ['Velma'], r['doc']['fires'])

# --- scope: what each source is allowed to contribute ---------------------------------------
r = run(tfs=collection([tfs_feature(categoryType='Prescribed'),
                        tfs_feature(fid='ID-2', publicvisibility='Hidden'),
                        tfs_feature(fid='ID-3')],
                       created='2026-07-29T03:55:03.767Z'))
check('a prescribed burn and a non-public incident are both dropped, and the read stays ok',
      [f['id'] for f in r['doc']['fires'] if f['src'] == 'tfs'] == ['tfs:ID-3']
      and src(r['doc'], 'tfs')['status'] == 'ok' and src(r['doc'], 'tfs')['count'] == 1,
      r['doc']['sources'])

# VOCAB · both filters read an open upstream vocabulary. A reword or a re-case drops every Texas
# fire, and the fetch that carried it still succeeded, so the file would publish a manufactured
# fire-free day. The guard keys on those two filters only.
r = run(tfs=collection([tfs_feature(categoryType='Wildland Fire'),
                        tfs_feature(fid='ID-2', categoryType='Wildland Fire')],
                       created='2026-07-29T03:55:03.767Z'))
check('VOCAB · a read the category filters rejected in full publishes failed, never as zero fires',
      src(r['doc'], 'tfs')['status'] == 'failed' and src(r['doc'], 'tfs')['count'] is None
      and r['code'] != 0 and not [f for f in r['doc']['fires'] if f['src'] == 'tfs'],
      'code=%s %s' % (r['code'], r['doc']['sources']))
r = run(tfs=collection([tfs_feature(publicvisibility='PUBLIC')],
                       created='2026-07-29T03:55:03.767Z'))
check('VOCAB · a re-cased visibility value trips the same guard rather than emptying the layer',
      src(r['doc'], 'tfs')['status'] == 'failed' and src(r['doc'], 'tfs')['count'] is None,
      r['doc']['sources'])
r = run(tfs=collection([], created='2026-07-29T03:55:03.767Z'))
check('VOCAB · an upstream that published no features at all is still a legal fire-free day',
      r['code'] == 0 and src(r['doc'], 'tfs')['status'] == 'ok'
      and src(r['doc'], 'tfs')['count'] == 0, r['doc']['sources'])
r = run(tfs=collection([{'type': 'Feature', 'geometry': None, 'properties': None},
                        {'type': 'Feature'}], created='2026-07-29T03:55:03.767Z'))
check('VOCAB · a day of wholly malformed records does not masquerade as a vocabulary break',
      r['code'] == 0 and src(r['doc'], 'tfs')['status'] == 'ok'
      and src(r['doc'], 'tfs')['count'] == 0, r['doc']['sources'])
r = run(tfs=collection([tfs_feature(categoryType='Prescribed'), tfs_feature(fid='ID-2', lon=-70.0)],
                       created='2026-07-29T03:55:03.767Z'))
check('VOCAB · an out-of-scope fire alongside a filtered one keeps the read ok, not failed',
      r['code'] == 0 and src(r['doc'], 'tfs')['status'] == 'ok'
      and src(r['doc'], 'tfs')['count'] == 0, r['doc']['sources'])
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

# STATE · the source's own state beats the outline. The shipped ring is 152 points, too coarse for
# the Rio Grande bend, and it put this live Big Bend NP fire 1.7 mi outside its own state: the popup
# disclaimed a Texas fire as merely nearby and the hero count, which excludes buffer, never saw it.
BLACK = dict(name='Black', fid='2026-TXBBP-000367', POOCounty='Brewster',
             POOProtectingUnit='TXBBP', POOProtectingAgency='NPS', IncidentSize=5,
             lon=-103.47251, lat=29.07034)


def black(**over):
    return collection([wfigs_feature(**dict(BLACK, **over))])


def wfigs_fires(res):
    return [f for f in res['doc']['fires'] if f['src'] == 'wfigs']


r = run(wfigs=black(POOState='US-TX'))
W = wfigs_fires(r)
check('STATE · a record its source places in Texas is scoped tx even outside the simplified outline',
      len(W) == 1 and W[0]['state'] == 'TX' and W[0]['scope'] == 'tx', W)
rc, log = run_schema_gate(r['doc'])
check('STATE · the gate accepts that Texas fire sitting outside the outline',
      rc == 0, 'rc=%s %s' % (rc, log))
# the control that proves the ring really does exclude this point rather than the test passing on
# geometry it never left
r = run(wfigs=black(POOState='US-NM'))
W = wfigs_fires(r)
check('STATE · the same point stated as another state is still buffer, so the ring still decides',
      len(W) == 1 and W[0]['state'] == 'NM' and W[0]['scope'] == 'buffer', W)
rc, log = run_schema_gate(r['doc'])
check('STATE · the gate accepts an out-of-state record just outside the outline',
      rc == 0, 'rc=%s %s' % (rc, log))
for label, stated in (('unstated', None), ('empty', ''), ('unparseable', 'Texas')):
    r = run(wfigs=black(POOState=stated))
    W = wfigs_fires(r)
    check('STATE · an %s state falls through to the geometric test unchanged' % label,
          len(W) == 1 and W[0]['state'] is None and W[0]['scope'] == 'buffer', W)
# Denver: a state claim may correct a label, never widen what the board carries
r = run(wfigs=collection([wfigs_feature(name='Claimed', POOState='US-TX', lon=-104.99, lat=39.74)]))
check('STATE · a stated Texas record past the buffer is still dropped, so coverage cannot widen',
      r['code'] == 0 and not wfigs_fires(r), r['doc']['fires'])
r = run(tfs=collection([tfs_feature(lon=-103.47251, lat=29.07034)],
                       created='2026-07-29T03:55:03.767Z'))
T = [f for f in r['doc']['fires'] if f['src'] == 'tfs']
check('STATE · TFS protects Texas, so its records are scoped tx outside the outline too',
      len(T) == 1 and T[0]['scope'] == 'tx', T)
# The upstream envelope is only a prefilter and scope_of still does the exact test, but a fire the
# query never returned can never reach it, so the envelope has to cover the buffer EVERYWHERE. A
# pad derived from the ring's mean latitude falls ~3 mi short across the panhandle.
BUF = 50
CALLS = run(buffer_mi=BUF)['calls']
BOX = query_envelope(CALLS, 'wfigs')
RING_LONS = [p[0] for p in REPO_SCOPE['ring']]
RING_LATS = [p[1] for p in REPO_SCOPE['ring']]
TOP = max(abs(y) for y in RING_LATS)
PAD_MI_TOP = (min(RING_LONS) - BOX[0]) * 69.0 * math.cos(math.radians(TOP))
check('SCOPE · the query envelope covers the whole buffer at the outline poleward edge',
      PAD_MI_TOP >= BUF - 0.01, '%.1f mi of a %g mi buffer at lat %.2f' % (PAD_MI_TOP, BUF, TOP))
check('SCOPE · the envelope only ever widens the outline, never clips it',
      BOX[0] < min(RING_LONS) and BOX[2] > max(RING_LONS)
      and BOX[1] < min(RING_LATS) and BOX[3] > max(RING_LATS), BOX)
check('SCOPE · the perimeter read asks upstream for the same envelope as the incident read',
      query_envelope(CALLS, 'perim') == BOX, query_envelope(CALLS, 'perim'))

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
# GATE · the state override is re-derived from the payload's own state column, never taken off the
# scope label: only a record whose source names Texas may be tx from outside the outline, and no
# state claim reaches past the buffer.
BB = dict(FIRE, lat=29.07034, lon=-103.47251)
rc, log = run_schema_gate(payload([dict(BB, scope='tx', state='TX')]))
check('the schema gate accepts a stated-Texas fire labelled tx from outside the outline',
      rc == 0, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(payload([dict(BB, scope='tx')]))
check('the schema gate rejects an outside-the-outline fire labelled tx that states no state at all',
      rc != 0 and 'no source state places it there' in log, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(payload([dict(BB, scope='tx', state='NM')]))
check('the schema gate rejects a fire labelled tx whose own source names another state',
      rc != 0 and 'no source state places it there' in log, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(payload([dict(BB, scope='buffer', state='TX')]))
check('the schema gate still accepts the narrower buffer label on a stated-Texas fire',
      rc == 0, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(payload([dict(FIRE, lat=39.74, lon=-104.99, scope='tx', state='TX')]))
check('the schema gate rejects a fire past the buffer even when its source claims Texas',
      rc != 0 and 'past the' in log, 'rc=%s %s' % (rc, log))
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
check('the perimeter query asks upstream for the collection time, join key, state and complexity',
      all(k in query_url(r['calls'], 'perim') for k in
          ('poly_PolygonDateTime', 'attr_LocalIncidentIdentifier', 'attr_POOState',
           'attr_IncidentComplexityLevel')), query_url(r['calls'], 'perim'))

# EDGE AGE · observed is when the RECORD was last touched; mapped is when the edge was collected.
# The two ran 109h apart on an 85,000-acre fire, so dating one by the other reads a four-day-old
# outline as hours old.
check('a perimeter publishes when its edge was collected, not only when the record was touched',
      P[0]['mapped'] == '2026-07-25T17:20:00Z' and P[0]['observed'] == '2026-07-29T03:52:07Z',
      bare(P[0]))
r = run(perim=collection([perim_feature(poly_PolygonDateTime='2026-07-25T17:20:00.000Z')]))
check('a collection time published as text reads the same as one published in epoch millis',
      r['doc']['perimeters'][0]['mapped'] == '2026-07-25T17:20:00Z', bare(r['doc']['perimeters'][0]))
r = run(perim=collection([perim_feature(poly_PolygonDateTime=None)]))
check('an unstated collection time publishes mapped null, never backfilled from observed or a clock',
      r['doc']['perimeters'][0]['mapped'] is None
      and r['doc']['perimeters'][0]['observed'] == '2026-07-29T03:52:07Z',
      bare(r['doc']['perimeters'][0]))

# JOIN · the incident number both sources carry. Name equality collides for real: WFIGS published
# two live "West Fork" perimeters, one in Texas and one in Washington.
check('a perimeter publishes the local incident number the TFS records carry as their own number',
      P[0]['local'] == '267549', bare(P[0]))
check('a perimeter state is normalized to the two-letter code the incident records already use',
      P[0]['state'] == 'TX', bare(P[0]))
check('a perimeter publishes the complexity tier verbatim, exactly as the source stated it',
      P[0]['complexity'] == 'Type 3 Incident', bare(P[0]))
r = run(perim=collection([perim_feature(attr_LocalIncidentIdentifier=None, attr_POOState=None,
                                        attr_IncidentComplexityLevel='')]))
Q = r['doc']['perimeters'][0]
check('an unstated join key, state or complexity publishes null rather than an empty string',
      Q['local'] is None and Q['state'] is None and Q['complexity'] is None, bare(Q))
r = run(perim=collection([perim_feature(attr_POOState='Texas')]))
check('a state that does not read as two letters publishes null, never a half-parsed one',
      r['doc']['perimeters'][0]['state'] is None, bare(r['doc']['perimeters'][0]))

# a fire whose edge crosses the line is ours even when most of it is not
r = run(perim=collection([perim_feature(
    ring=[[-94.5, 33.0], [-93.0, 33.0], [-93.0, 33.5], [-94.5, 33.5], [-94.5, 33.0]])]))
check('a perimeter with only some vertices in scope is kept, not dropped',
      len(r['doc']['perimeters']) == 1, r['doc']['perimeters'])

r = run(perim=collection([perim_feature(ring=[[-80.0, 40.0], [-79.9, 40.0], [-79.9, 40.1],
                                             [-80.0, 40.1], [-80.0, 40.0]])]))
check('a perimeter wholly outside the scope is dropped',
      r['doc']['perimeters'] == [], r['doc']['perimeters'])

# --- ORPHAN · an edge the incident list cannot account for ------------------------------------
# The edge layer retains outlines after the incident record goes out, so an edge with nothing
# behind it is ordinary. Alamo Creek drew on the live board with no incident anywhere in fires[].
TFS_EMPTY = collection([], created='2026-07-29T03:55:03.767Z')
TFS_ROSS = collection([tfs_feature(name='Ross')], created='2026-07-29T03:55:03.767Z')

r = run(tfs=TFS_ROSS, wfigs=collection([]), perim=collection([perim_feature(name='Ross')]))
check('ORPHAN · an edge whose incident is still open publishes orphan false',
      r['doc']['perimeters'][0]['orphan'] is False, bare(r['doc']['perimeters'][0]))
r = run(tfs=TFS_ROSS, wfigs=collection([]), perim=collection([perim_feature(name='Alamo Creek')]))
P = r['doc']['perimeters'][0]
check('ORPHAN · an edge no incident accounts for keeps its ring and says so, rather than vanishing',
      P['orphan'] is True and P['acres'] == 120.5 and len(P['rings'][0]) == 5, bare(P))
r = run(tfs=collection([tfs_feature(name='Renamed Since', number='267549')],
                       created='2026-07-29T03:55:03.767Z'),
        wfigs=collection([]), perim=collection([perim_feature(name='Ross')]))
check('ORPHAN · a renamed fire still matches on the local incident number inside the same state',
      r['doc']['perimeters'][0]['orphan'] is False, bare(r['doc']['perimeters'][0]))
r = run(tfs=TFS_EMPTY, wfigs=collection([wfigs_feature(name='Renamed Since', IrwinID='{ABC-123}')]),
        perim=collection([perim_feature(name='Ross')]))
check('ORPHAN · an IRWIN id matches across a name change and across the state line',
      r['doc']['perimeters'][0]['orphan'] is False, bare(r['doc']['perimeters'][0]))
r = run(tfs=TFS_EMPTY, wfigs=collection([wfigs_feature(name='West Fork', POOState='US-NM')]),
        perim=collection([perim_feature(name='West Fork', poly_IRWINID='',
                                        attr_LocalIncidentIdentifier=None)]))
check('ORPHAN · a name that collides across two states is not read as the incident behind the edge',
      r['doc']['perimeters'][0]['orphan'] is True, bare(r['doc']['perimeters'][0]))
# E1 · an unread incident source is not an absent fire, so the question goes unanswered
r = run(wfigs=ARCGIS_ERR, perim=collection([perim_feature(name='Alamo Creek')]))
check('ORPHAN · a failed incident read publishes orphan null, never an edge falsely marked out',
      r['doc']['perimeters'][0]['orphan'] is None, bare(r['doc']['perimeters'][0]))
r = run(tfs=OSError('timed out'), perim=collection([perim_feature(name='Alamo Creek')]))
check('ORPHAN · the other incident source failing leaves the same question unanswered',
      r['doc']['perimeters'][0]['orphan'] is None, bare(r['doc']['perimeters'][0]))

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

# --- E1 · a failed edge read must not delete edges nobody restamped --------------------------
# The bound comes from the generator itself, so a change to PERIM_CARRY_H moves these cases with it
# rather than leaving them asserting a number the code stopped using.
CARRY_H = MOD.PERIM_CARRY_H
KEPT = [{'id': 'wfigs-perim:{X}', 'irwin': '{X}', 'name': 'Kept', 'scope': 'tx', 'acres': 120.5,
         'observed': '2026-07-30T02:00:00Z', 'method': 'Image Interpretation',
         'category': 'Wildfire Daily Fire Perimeter',
         'rings': [[[-99.0, 31.0], [-99.0, 31.1], [-98.9, 31.1], [-98.9, 31.0], [-99.0, 31.0]]]}]
# a carry republishes the row verbatim; orphan is the one column re-derived, against this cycle's
# incidents rather than the ones the retained read saw
CARRIED = [dict(KEPT[0], orphan=True)]
PERIM_CAPTURED = '2026-07-30T02:05:00Z'


def ago(h):
    dt = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=h)
    return dt.strftime('%Y-%m-%dT%H:%M:%SZ')


def prev_edges(generated_h, perims=None, status='ok', captured=PERIM_CAPTURED, carried_from=None):
    """A previously published file whose edge read was `status`, generated `generated_h` ago."""
    perims = KEPT if perims is None else perims
    row = {'key': 'wfigs-perimeters',
           'name': 'National Interagency Fire Center (WFIGS perimeters)',
           'url': 'https://data-nifc.opendata.arcgis.com/', 'status': status,
           'captured': captured, 'count': None if status == 'failed' else len(perims)}
    if carried_from:
        row['carriedFrom'] = carried_from
    return json.dumps({
        'generated': ago(generated_h),
        'sources': [{'key': 'tfs', 'name': 'Texas A&M Forest Service',
                     'url': 'https://tfswildfires.com/public/', 'status': 'ok',
                     'captured': ago(generated_h), 'count': 0}, row],
        'fires': [], 'perimeters': perims})


r = run(perim=OSError('timed out'), previous=prev_edges(0.5))
D = r['doc']
S = src(D, 'wfigs-perimeters')
check('CARRY · a failed edge read republishes the last good perimeters instead of deleting them',
      r['code'] == 0 and D['perimeters'] == CARRIED, 'code=%s %s' % (r['code'], D['perimeters']))
check('CARRY · the retained set is marked carried and counted, never laundered as a fresh read',
      S['status'] == 'carried' and S['count'] == 1, S)
check('CARRY · the retained set keeps the stamps of the read that produced it, not this clock',
      S['captured'] == PERIM_CAPTURED and S['carriedFrom'] != D['generated']
      and D['perimeters'][0]['observed'] == KEPT[0]['observed'],
      '%s · generated %s' % (S, D['generated']))
check('CARRY · the incident sources are untouched by the carry and still publish their own reads',
      [f['src'] for f in D['fires']] == ['tfs', 'wfigs']
      and src(D, 'tfs')['status'] == 'ok', [f['src'] for f in D['fires']])

r = run(perim=OSError('timed out'), previous=prev_edges(CARRY_H - 0.5))
check('CARRY · a set just inside the %gh window is still republished' % CARRY_H,
      src(r['doc'], 'wfigs-perimeters')['status'] == 'carried'
      and r['doc']['perimeters'] == CARRIED, r['doc']['sources'])
r = run(perim=OSError('timed out'), previous=prev_edges(0.5, perims=[dict(KEPT[0], orphan=False)]))
check('CARRY · orphan is re-derived on a carry, never republished as the previous cycle read it',
      r['doc']['perimeters'][0]['orphan'] is True, bare(r['doc']['perimeters'][0]))
r = run(perim=OSError('timed out'), previous=prev_edges(CARRY_H + 0.5))
check('CARRY · a set past the %gh window is dropped rather than drawn forever' % CARRY_H,
      src(r['doc'], 'wfigs-perimeters')['status'] == 'failed' and r['doc']['perimeters'] == [],
      r['doc']['sources'])

# the clock is the last REAL read: a run of failures republishing every 15 minutes must not push it
r = run(perim=OSError('timed out'),
        previous=prev_edges(0.05, status='carried', carried_from=ago(CARRY_H + 0.5)))
check('CARRY · a carry cannot ratchet itself forward one cycle at a time',
      src(r['doc'], 'wfigs-perimeters')['status'] == 'failed' and r['doc']['perimeters'] == [],
      r['doc']['sources'])
ORIG = ago(1)
r = run(perim=OSError('timed out'), previous=prev_edges(0.05, status='carried', carried_from=ORIG))
check('CARRY · a second carry keeps naming the same original read',
      src(r['doc'], 'wfigs-perimeters').get('carriedFrom') == ORIG,
      src(r['doc'], 'wfigs-perimeters'))

# absence: none of these may crash the cycle, and none may publish an edge it cannot vouch for
for label, prev in (('no previous file at all', None),
                    ('an unreadable previous file', '{not json at all'),
                    ('a previous file holding no edges', prev_edges(0.5, perims=[])),
                    ('a previous file whose own edge read failed',
                     prev_edges(0.5, status='failed')),
                    ('a previous file with no readable stamp',
                     json.dumps({'perimeters': KEPT, 'sources': [], 'fires': []})),
                    ('a previous file stamped in the future', prev_edges(-2))):
    r = run(perim=OSError('timed out'), previous=prev)
    check('CARRY · %s publishes no edges, marked failed, without failing the run' % label,
          r['code'] == 0 and r['doc']['perimeters'] == []
          and src(r['doc'], 'wfigs-perimeters')['status'] == 'failed',
          'code=%s %s' % (r['code'], r['doc'] and r['doc']['sources']))

r = run(perim=collection([perim_feature()]), previous=prev_edges(0.5))
check('CARRY · a healthy edge read publishes what it read and is never marked carried',
      src(r['doc'], 'wfigs-perimeters')['status'] == 'ok'
      and [p['name'] for p in r['doc']['perimeters']] == ['Frontera'], r['doc']['perimeters'])

CARRIED_ROW = {'key': 'wfigs-perimeters',
               'name': 'National Interagency Fire Center (WFIGS perimeters)',
               'url': 'https://data-nifc.opendata.arcgis.com/', 'status': 'carried',
               'captured': '2026-07-29T03:55:03Z', 'count': 1,
               'carriedFrom': '2026-07-29T03:58:00Z'}
rc, log = run_schema_gate(payload([FIRE], sources=GOOD_SOURCES + [CARRIED_ROW]))
check('the schema gate accepts a carried source row', rc == 0, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(payload([FIRE], sources=GOOD_SOURCES + [
    {k: v for k, v in CARRIED_ROW.items() if k != 'carriedFrom'}]))
check('the schema gate rejects a carried row that names no read to age it from',
      rc != 0 and 'names no carriedFrom read' in log, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(payload([FIRE], sources=GOOD_SOURCES + [
    dict(CARRIED_ROW, carriedFrom='2026-07-29T05:00:00Z')]))
check('the schema gate rejects a carried row claiming a read later than the file itself',
      rc != 0 and 'later than generated' in log, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(run(perim=OSError('timed out'), previous=prev_edges(0.5))['doc'])
check('a carried run also writes what the release gate accepts', rc == 0, 'rc=%s %s' % (rc, log))

# --- the gate holds the perimeter columns to the same discipline as the incident ones ----------
PERIM_ROW = {'id': 'wfigs-perim:267549', 'irwin': '', 'local': '267549', 'name': 'Ross',
             'scope': 'tx', 'state': 'TX', 'acres': 85303, 'complexity': 'Type 3 Incident',
             'observed': '2026-07-29T03:52:07Z', 'mapped': '2026-07-25T01:07:00Z',
             'method': 'Image Interpretation', 'category': 'Wildfire Daily Fire Perimeter',
             'rings': [[[-99.0, 31.0], [-99.0, 31.1], [-98.9, 31.1], [-98.9, 31.0], [-99.0, 31.0]]]}


def perim_payload(rows):
    return dict(payload([FIRE]), perimeters=rows)


rc, log = run_schema_gate(perim_payload([PERIM_ROW]))
check('the schema gate accepts a perimeter whose edge is days older than its record',
      rc == 0, 'rc=%s %s' % (rc, log))
check('the schema gate treats a file predating the orphan column as an upgrade path, not a fault',
      rc == 0 and 'predates the perimeter orphan column' in log, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(perim_payload([dict(PERIM_ROW, orphan=True)]))
check('the schema gate accepts an edge flagged as backed by no active incident',
      rc == 0, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(perim_payload([dict(PERIM_ROW, orphan=None)]))
check('the schema gate accepts orphan null, which is the answer when an incident source failed',
      rc == 0, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(perim_payload([dict(PERIM_ROW, orphan='yes')]))
check('the schema gate rejects an orphan flag that is neither true, false nor null',
      rc != 0 and 'neither true, false nor null' in log, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(perim_payload([dict(PERIM_ROW, orphan=False),
                                         dict(PERIM_ROW, id='wfigs-perim:2')]))
check('the schema gate rejects a half-answered orphan column rather than trusting the flagged half',
      rc != 0 and 'partial column' in log, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(perim_payload([dict(PERIM_ROW, mapped=None, local=None, state=None,
                                              complexity=None)]))
check('the schema gate accepts every new perimeter column as null, which is a fact not a gap',
      rc == 0, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(perim_payload([dict(PERIM_ROW, mapped='2026-07-29T04:00:00Z')]))
check('the schema gate rejects an edge collected after the record that carries it',
      rc != 0 and 'later than observed' in log, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(perim_payload([dict(PERIM_ROW, mapped=1785000000000)]))
check('the schema gate rejects a collection time that is not an ISO stamp',
      rc != 0 and 'ISO stamp' in log, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(perim_payload([dict(PERIM_ROW, state='US-TX')]))
check('the schema gate rejects a perimeter state left in its prefixed upstream form',
      rc != 0 and 'two-letter' in log, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(perim_payload([dict(PERIM_ROW, local=267549)]))
check('the schema gate rejects a join key published as a number, which would never match TFS',
      rc != 0 and 'neither a string nor null' in log, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(perim_payload([dict(PERIM_ROW, complexity=3)]))
check('the schema gate rejects a perimeter complexity that is not the string the source stated',
      rc != 0, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(payload([dict(FIRE, complexity=3)]))
check('the schema gate rejects an incident complexity that is not a string',
      rc != 0, 'rc=%s %s' % (rc, log))
rc, log = run_schema_gate(run(perim=collection([perim_feature()]))['doc'])
check('the generator writes the new perimeter columns in the form the release gate accepts',
      rc == 0, 'rc=%s %s' % (rc, log))

print('----')
if FAILS == 0:
    print('ALL GEN-WILDFIRE TESTS PASSED')
    sys.exit(0)
print('%d TEST(S) FAILED' % FAILS)
sys.exit(1)
