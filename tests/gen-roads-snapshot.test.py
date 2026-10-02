#!/usr/bin/env python3
"""tests/gen-roads-snapshot.test.py: the road archive must never be short, stale or invented.

data/roads-capture.json is the ONLY record of a closure: upstream keeps no history, and
gen-history.py reads a closure's absence from a snapshot as the closure having cleared. So a
truncated capture does not just lose rows, it writes road recoveries that never happened. The
source is DriveTexas's MapLarge condition table; the end-to-end cases run the generator against a
captured answer from it (tests/fixtures/drivetexas-conditions.json) with the clock pinned to the
capture. Any failed, truncated or stalled read keeps the previous file and exits non-zero so
run-cycle.sh signs the cycle off DEGRADED rather than clean. Run: python3 tests/gen-roads-snapshot.test.py"""
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
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
GEN = os.path.join(HERE, '..', 'scripts', 'gen-roads-snapshot.py')
FIXTURE = json.load(open(os.path.join(HERE, 'fixtures', 'drivetexas-conditions.json'), encoding='utf-8'))
FX_UPDATED = FIXTURE['census']['data']['data']['lastUpdated_Max'][0] / 1000
FX_NOW = FX_UPDATED + 300

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
GR.time.time = lambda: FX_NOW
BBOX = (-106.65, 25.83, -93.4, 36.5)


class Response(io.StringIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def url_of(req):
    return req.full_url if hasattr(req, 'full_url') else str(req)


def query_of(url):
    return json.loads(urllib.parse.parse_qs(urllib.parse.urlparse(url).query)['request'][0])['query']


def synthetic_page(start, take, total):
    n = max(0, min(take, total - start))
    ids = range(start, start + n)
    cols = {
        'OBJECTID': list(ids), 'CNSTRNTTYPECD': ['F'] * n, 'RTENM': ['FM%04d' % i for i in ids],
        'CONDLMTFROMDSCR': ['FM%04d A' % i for i in ids], 'CONDLMTTODSCR': ['FM%04d B' % i for i in ids],
        'CONDDSCR': ['- Water over roadway.<br/>'] * n, 'CONDSTARTTS': [1790917740000] * n,
        'CONDENDTS': [1791028800000] * n, 'CNSTRNTDETOURFLAG': ['N'] * n,
        'lastUpdated': [int(FX_UPDATED * 1000)] * n,
        'conditionsLine': ['LINESTRING (-98.5 29.7, -98.4 29.75)'] * n,
    }
    return {'success': True, 'data': {'data': cols, 'totals': {'Records': total}}}


def serve(rows=None, total=None, active=None, census=None):
    """Stub MapLarge. With `total`, synthetic rows paged `take` at a time; otherwise the fixture.
    Each override is a body, or an exception to raise for that call."""
    calls = []

    def answer(kind, default):
        body = {'active': active, 'rows': rows, 'census': census}[kind]
        if isinstance(body, BaseException):
            raise body
        return Response(json.dumps(default if body is None else body))

    def urlopen(req, timeout=None):
        url = url_of(req)
        if 'GetActiveTableID' in url:
            calls.append(('active', url, None))
            return answer('active', FIXTURE['activeTable'])
        q = query_of(url)
        kind = 'census' if q.get('groupby') else 'rows'
        calls.append((kind, url, q))
        if kind == 'rows' and total is not None and rows is None:
            return Response(json.dumps(synthetic_page(q['start'], q['take'], total)))
        return answer(kind, FIXTURE['page'] if kind == 'rows' else FIXTURE['census'])

    return calls, urlopen


def with_urlopen(fake, fn):
    prev = GR.urllib.request.urlopen
    GR.urllib.request.urlopen = fake
    try:
        return fn()
    finally:
        GR.urllib.request.urlopen = prev


# ---- paging ----
calls, fake = serve(total=GR.PAGE * 2 + 5)
rows, truncated = with_urlopen(fake, lambda: GR.fetch_rows('appgeo/conditionsLine/1'))
row_calls = [q for k, _, q in calls if k == 'rows']
check('the condition query pages past one page', len(rows) == GR.PAGE * 2 + 5, '%d rows' % len(rows))
check('a complete set is not reported truncated', truncated is False)
check('each page asks for the next offset of the same versioned table',
      [q['start'] for q in row_calls] == [0, GR.PAGE, GR.PAGE * 2]
      and {q['table'] for q in row_calls} == {'appgeo/conditionsLine/1'}, str(row_calls[:1]))
check('the query asks for exactly Closure, Flooding and Damage',
      sorted(row_calls[0]['where'][0]['value']) == ['D', 'F', 'Z'], str(row_calls[0]['where']))

calls, fake = serve(total=GR.PAGE * GR.MAX_PAGES + 1)
rows, truncated = with_urlopen(fake, lambda: GR.fetch_rows('appgeo/conditionsLine/1'))
check('the page ceiling stops a runaway loop', len([c for c in calls if c[0] == 'rows']) == GR.MAX_PAGES)
check('a set still short at the ceiling reports itself truncated', truncated is True)

short = synthetic_page(0, 3, 3)
short['data']['totals']['Records'] = 10
_, fake = serve(rows=short)
rows, truncated = with_urlopen(fake, lambda: GR.fetch_rows('appgeo/conditionsLine/1'))
check('a table that reports more rows than it hands back is truncated, not complete', truncated is True,
      '%d rows' % len(rows))

calls, fake = serve(total=0)
rows, truncated = with_urlopen(fake, lambda: GR.fetch_rows('appgeo/conditionsLine/1'))
check('a genuinely empty table is a complete answer, not a truncated one', rows == [] and truncated is False)


# ---- refused answers never become an empty-roads day ----
def raises(fn):
    try:
        fn()
        return False
    except Exception:  # noqa: BLE001, any raise is the pass condition
        return True


missing = json.loads(json.dumps(FIXTURE['page']))
del missing['data']['data']['CONDDSCR']
REFUSALS = [
    ('a refused query', {'success': False, 'errors': ['bad query'], 'data': None}),
    ('the ArcGIS token error body', {'error': {'code': 499, 'message': 'Token Required', 'messageCode': 'GWM_0003'}}),
    ('a table missing a column the archive reads', missing),
    ('an answer with no record count', {'success': True, 'data': {'data': FIXTURE['page']['data']['data']}}),
]
for label, body in REFUSALS:
    _, fake = serve(rows=body)
    check('E1 · %s raises instead of reading as zero closures' % label,
          with_urlopen(fake, lambda: raises(lambda: GR.fetch_rows('appgeo/conditionsLine/1'))))

for label, body in [('no table', {'success': True}), ('the CDN-cached short name', {'success': True, 'table': 'appgeo/conditionsLine'}),
                    ('another table', {'success': True, 'table': 'appgeo/cameraPoint/639265586802570940'})]:
    _, fake = serve(active=body)
    check('the active table id is refused when it is %s' % label, with_urlopen(fake, lambda: raises(GR.active_table)))
_, fake = serve()
check('the captured active table id is accepted', with_urlopen(fake, GR.active_table) == FIXTURE['activeTable']['table'])

server_errors = []


def flaky(req, timeout=None):
    server_errors.append(url_of(req))
    raise urllib.error.HTTPError(url_of(req), 500, 'Internal Server Error', {}, None)


check('a server error is retried through every backoff, then raises',
      with_urlopen(flaky, lambda: raises(GR.active_table)) and len(server_errors) == len(GR.BACKOFFS) + 1,
      '%d attempts' % len(server_errors))
denied = []


def forbidden(req, timeout=None):
    denied.append(1)
    raise urllib.error.HTTPError(url_of(req), 403, 'Forbidden', {}, None)


check('a hard 4xx raises at once', with_urlopen(forbidden, lambda: raises(GR.active_table)) and len(denied) == 1)


# ---- end to end against the captured table ----
CYCLE_CHECK = os.path.join(HERE, '..', 'scripts', 'cycle-check.sh')


def roads_gate(root):
    """cycle-check.sh's own roads-snapshot schema block, run on `root`: '' when it passes."""
    with open(CYCLE_CHECK, encoding='utf-8') as f:
        src = f.read()
    prelude = src[src.index('import datetime', src.index('check_schemas()')):src.index('# gauges-snapshot.json is load-bearing')]
    start = src.index('d = optional("data/roads-snapshot.json")')
    block = src[start:src.index('\nd = optional(', start + 1)]
    p = subprocess.run([sys.executable, '-c', prelude + block], cwd=root, capture_output=True, text=True)
    return '' if p.returncode == 0 else (p.stderr.strip() or 'rc %d' % p.returncode)


def run_main(now=FX_NOW, gate=False, **answers):
    root = tempfile.mkdtemp(prefix='responder-roads-test.')
    os.makedirs(os.path.join(root, 'data'))
    box = answers.pop('display', BBOX)
    with open(os.path.join(root, 'data', 'event.json'), 'w') as f:
        json.dump({'captureBbox': dict(zip(('xmin', 'ymin', 'xmax', 'ymax'), BBOX)),
                   'gaugeBbox': dict(zip(('xmin', 'ymin', 'xmax', 'ymax'), box))}, f)
    keep = {'generated': '2026-07-01T00:00:00Z', 'roads': [{'route': 'PREVIOUS', 'start': 'x', 'v': [29.7, -98.5]}]}
    for name in ('roads-capture.json', 'roads-snapshot.json'):
        with open(os.path.join(root, 'data', name), 'w') as f:
            json.dump(keep, f)
    saved = (GR.ROOT, GR.OUT, GR.CAPTURE_OUT, GR.urllib.request.urlopen, GR.time.time)
    GR.ROOT = root
    GR.OUT = os.path.join(root, 'data', 'roads-snapshot.json')
    GR.CAPTURE_OUT = os.path.join(root, 'data', 'roads-capture.json')
    _, GR.urllib.request.urlopen = serve(**answers)
    GR.time.time = lambda: now
    try:
        rc = GR.main()
        with open(GR.CAPTURE_OUT) as f:
            cap = json.load(f)
        with open(GR.OUT) as f:
            shown = json.load(f)
        return (cap, shown, rc, roads_gate(root)) if gate else (cap, shown, rc)
    finally:
        GR.ROOT, GR.OUT, GR.CAPTURE_OUT, GR.urllib.request.urlopen, GR.time.time = saved
        shutil.rmtree(root, ignore_errors=True)


def page_with(col, f):
    body = json.loads(json.dumps(FIXTURE['page']))
    body['data']['data'][col] = [f(i, v) for i, v in enumerate(body['data']['data'][col])]
    return body


def kept(cap, rc):
    return rc not in (0, None) and [r['route'] for r in cap['roads']] == ['PREVIOUS']


cap, shown, rc = run_main()
by = {r['route']: r for r in cap['roads']}
check('a fresh, complete read publishes and signs off clean', rc in (0, None) and len(cap['roads']) == 9,
      'rc %r, %d roads' % (rc, len(cap['roads'])))
check('a construction-coded closure stays out of the archive', 'FM2990' not in by, sorted(by))
check('the condition codes archive as the words every consumer keys on',
      sorted(r['cond'] for r in cap['roads']) == ['Closure'] * 3 + ['Damage'] * 2 + ['Flooding'] * 4,
      str(sorted(r['cond'] for r in cap['roads'])))
sl = by.get('SL0323', {})
check('the archived row carries the route and limits roadId keys on',
      sl.get('from') == '485.76 Feet South of US0271 on SL0323' and sl.get('to') == '0.515 Miles South of US0271 on SL0323',
      json.dumps(sl))
check('start and end keep the Central-offset form gen-history.py has always keyed on',
      sl.get('start') == '2026-03-02T09:01:00-06:00' and sl.get('end') == '2026-12-31T16:00:00-06:00'
      and by['FM0928']['start'] == '2026-09-30T14:51:00-05:00', '%s %s %s' % (sl.get('start'), sl.get('end'), by['FM0928']['start']))
check('the vertex is the first point of the line, rounded the way the archive always was',
      sl.get('v') == [32.395, -95.2687], str(sl.get('v')))
check('a multi-part closure archives its first part\'s first vertex', by['FM2044']['v'] == [27.8469, -98.0851]
      if 'FM2044' in by else False, str(by.get('FM2044', {}).get('v')))
check('the description is cleaned exactly as the client cleans it',
      sl.get('desc') == 'The roadway is closed due to damage. - ALL main lanes closed. - Use alternate route', repr(sl.get('desc')))
check('the flooded closure keeps the words the client classifies it by',
      by['RM2768']['cond'] == 'Closure' and 'closed due to flooding' in by['RM2768']['desc'], json.dumps(by['RM2768']))
check('the display file is the capture scoped to gaugeBbox', len(shown['roads']) == 9)

_, sa, _ = run_main(display=(-98.8, 29.2, -98.3, 29.7))
check('a narrow display box keeps only its own closures', [r['route'] for r in sa['roads']] == ['US0090'],
      str([r['route'] for r in sa['roads']]))

stale_cap, _, stale_rc = run_main(now=FX_UPDATED + (GR.STALE_MIN + 1) * 60)
check('DEGRADED · a stalled import keeps the previous archive', [r['route'] for r in stale_cap['roads']] == ['PREVIOUS'])
check('DEGRADED · a stalled import exits non-zero', stale_rc not in (0, None), 'rc %r' % (stale_rc,))
_, _, edge_rc = run_main(now=FX_UPDATED + (GR.STALE_MIN - 1) * 60)
check('a read inside the stale window still publishes', edge_rc in (0, None), 'rc %r' % (edge_rc,))
ahead_cap, _, ahead_rc = run_main(now=FX_UPDATED - (GR.FUTURE_MIN + 1) * 60)
check('DEGRADED · an import stamped in the future keeps the previous archive', kept(ahead_cap, ahead_rc), 'rc %r' % (ahead_rc,))
_, _, skew_rc = run_main(now=FX_UPDATED - (GR.FUTURE_MIN - 1) * 60)
check('a few minutes of clock skew still publishes', skew_rc in (0, None), 'rc %r' % (skew_rc,))
micros = page_with('lastUpdated', lambda i, v: v * 1000)
micro_cap, _, micro_rc = run_main(rows=micros)
check('DEGRADED · a stamp whose unit drifted reads as far future and is refused', kept(micro_cap, micro_rc), 'rc %r' % (micro_rc,))

empty = json.loads(json.dumps(FIXTURE['page']))
for c in empty['data']['data']:
    empty['data']['data'][c] = []
empty['data']['totals']['Records'] = 0
zero_cap, _, zero_rc = run_main(rows=empty)
check('a genuine statewide zero off a fresh table publishes an empty archive', zero_rc in (0, None) and zero_cap['roads'] == [])
zero_stale, _, zero_stale_rc = run_main(rows=empty, now=FX_UPDATED + (GR.STALE_MIN + 5) * 60)
check('DEGRADED · a zero off a stalled table is not published as an all-clear',
      zero_stale_rc not in (0, None) and [r['route'] for r in zero_stale['roads']] == ['PREVIOUS'])
blind, _, blind_rc = run_main(rows=empty, census={'success': False, 'errors': ['x']})
check('DEGRADED · a zero whose import time cannot be read is not published',
      blind_rc not in (0, None) and [r['route'] for r in blind['roads']] == ['PREVIOUS'])

trunc_cap, _, trunc_rc = run_main(rows=short)
check('MUTATION · a truncated fetch keeps the previous archive rather than publishing a short one',
      [r['route'] for r in trunc_cap['roads']] == ['PREVIOUS'], str(len(trunc_cap['roads'])) + ' roads')
check('DEGRADED · a truncated fetch exits non-zero so the cycle cannot sign off clean',
      trunc_rc not in (0, None), 'rc %r' % (trunc_rc,))
dead_cap, _, dead_rc = run_main(active=OSError('upstream refused the connection'))
check('DEGRADED · a failed fetch exits non-zero so the cycle cannot sign off clean',
      dead_rc not in (0, None), 'rc %r' % (dead_rc,))
check('DEGRADED · the failed fetch still leaves the previous archive intact',
      [r['route'] for r in dead_cap['roads']] == ['PREVIOUS'], str(len(dead_cap['roads'])))



# E1 · gen-history.py reads a closure missing from the archive as cleared, so an unreadable line
# that is skipped publishes a recovery on a road that is still shut
SL = FIXTURE['page']['data']['data']['RTENM'].index('SL0323')
geo_cap, _, geo_rc = run_main(rows=page_with('conditionsLine', lambda i, g: 'POINT (-95.2 32.3)' if i == SL else g))
check('DEGRADED · one closure with an unreadable line keeps the previous archive and exits non-zero',
      kept(geo_cap, geo_rc), 'rc %r, %d roads' % (geo_rc, len(geo_cap['roads'])))
zgeo_cap, _, zgeo_rc = run_main(rows=page_with('conditionsLine', lambda i, g: re.sub(r'^(MULTI)?LINESTRING \(', lambda m: (m.group(1) or '') + 'LINESTRING Z (', g)))
check('DEGRADED · every line in a new geometry format is a failed read, not an empty-roads day',
      kept(zgeo_cap, zgeo_rc), 'rc %r, %d roads' % (zgeo_rc, len(zgeo_cap['roads'])))
check('a construction-coded row is excluded before its line is read',
      run_main(rows=page_with('conditionsLine', lambda i, g: 'POINT (1 2)' if i == 0 else g))[2] in (0, None))

# a row cycle-check.sh refuses (no start) must never reach disk: that failure stops every source's publish
cap, _, rc, verdict = run_main(gate=True)
check('the gate check runs: a fresh publish passes cycle-check.sh\'s roads schema', verdict == '' and rc in (0, None), verdict)
for label, f in [('null', lambda i, v: None if i == SL else v), ('an ISO string', lambda i, v: '2026-10-02T12:00:00Z' if i == SL else v),
                 ('zero', lambda i, v: 0 if i == SL else v)]:
    ns_cap, _, ns_rc, verdict = run_main(rows=page_with('CONDSTARTTS', f), gate=True)
    check('DEGRADED · a closure whose start is %s keeps the previous archive and exits non-zero' % label,
          kept(ns_cap, ns_rc), 'rc %r, %d roads' % (ns_rc, len(ns_cap['roads'])))
    check('what a closure with a start of %s leaves on disk passes cycle-check.sh' % label, verdict == '', verdict)
check('a construction-coded row with no start does not block the archive',
      run_main(rows=page_with('CONDSTARTTS', lambda i, v: None if i == 0 else v))[2] in (0, None))

# E1 · a re-coded condition drops out of the Z/F/D query without a trace, so the legend is checked table-wide
def census_with(f, extra=0):
    body = json.loads(json.dumps(FIXTURE['census']))
    body['data']['data']['CNSTRNTTYPECD'] = [f(i, c) for i, c in enumerate(body['data']['data']['CNSTRNTTYPECD'])]
    body['data']['totals']['Records'] += extra
    return body


no_flood = json.loads(json.dumps(FIXTURE['page']))
keep_rows = [c != 'F' for c in no_flood['data']['data']['CNSTRNTTYPECD']]
for c in no_flood['data']['data']:
    no_flood['data']['data'][c] = [v for v, k in zip(no_flood['data']['data'][c], keep_rows) if k]
no_flood['data']['totals']['Records'] = sum(keep_rows)
for label, answers in [
        ('Flooding re-coded outside the legend', {'census': census_with(lambda i, c: 'FL' if c == 'F' else c), 'rows': no_flood}),
        ('every code re-coded, so nothing matches', {'census': census_with(lambda i, c: c + '1'), 'rows': empty}),
        ('a row with no condition code', {'census': census_with(lambda i, c: None if i == 0 else c)}),
        ('a census cut short of the groups it reports', {'census': census_with(lambda i, c: c, extra=1)})]:
    drift_cap, _, drift_rc = run_main(**answers)
    check('DEGRADED · %s keeps the previous archive and exits non-zero' % label,
          kept(drift_cap, drift_rc), 'rc %r, %d roads' % (drift_rc, len(drift_cap['roads'])))
calls, fake = serve()
with_urlopen(fake, lambda: GR.table_census(FIXTURE['activeTable']['table']))
cq = [q for k, _, q in calls if k == 'census']
check('the legend census reads the whole table in one grouped request',
      len(cq) == 1 and cq[0]['where'] == [] and cq[0]['groupby'] == ['CNSTRNTTYPECD'], str(cq))
check('the captured table\'s codes are all legend codes', set(FIXTURE['census']['data']['data']['CNSTRNTTYPECD']) <= set(GR.LEGEND))

# ---- the AO intersection ----
box = (-98.5, 29.5, -98.0, 30.0)
check('a line crossing the box with no vertex inside touches it', GR.line_hits_box([[(-99, 29.75), (-97, 29.75)]], box))
check('a line passing below the box does not', not GR.line_hits_box([[(-99, 29), (-97, 29.3)]], box))
check('a one-vertex line is an inside test', GR.line_hits_box([[(-98.2, 29.7)]], box)
      and not GR.line_hits_box([[(-99.2, 29.7)]], box))
check('WKT multi-part lines parse into their parts',
      GR.wkt_lines('MULTILINESTRING ((1 2, 3 4), (5 6, 7 8, 9 10))') == [[(1, 2), (3, 4)], [(5, 6), (7, 8), (9, 10)]])
check('anything but a line is refused', raises(lambda: GR.wkt_lines('POINT (1 2)')) and raises(lambda: GR.wkt_lines(None)))

# ---- description cleaning ----
# A bare slice is what published this closure as "...low visibility from smoke. A", a sentence that
# reads as whole and had dropped the only operative fact in the record.
SMOKE = ('- The roadway is closed due to Other conditions.<br/><br/><br/>'
         'the roadway is closed due to low visibility from smoke. ALL MANE LANES CLOSED')
LONG = 'Water over roadway at the low water crossing. ' * 12
LONG = LONG.strip()

check('the boilerplate prefix and the <br/> markup every consumer already strips are dropped here',
      GR.clean_desc(SMOKE) == ('The roadway is closed due to Other conditions. the roadway is '
                               'closed due to low visibility from smoke. ALL MANE LANES CLOSED'),
      repr(GR.clean_desc(SMOKE)))
check('the real TxDOT wildfire closure survives whole, with the fact the old cut removed',
      GR.clean_desc(SMOKE).endswith('ALL MANE LANES CLOSED') and '…' not in GR.clean_desc(SMOKE),
      repr(GR.clean_desc(SMOKE)))
check('a description that needs no normalising is returned unchanged',
      GR.clean_desc('Water over roadway.') == 'Water over roadway.')
check('a description past the cap is marked as cut and stays inside the cap',
      GR.clean_desc(LONG).endswith('…') and len(GR.clean_desc(LONG)) <= GR.DESC_MAX,
      '%d chars · %r' % (len(GR.clean_desc(LONG)), GR.clean_desc(LONG)[-30:]))
body = GR.clean_desc(LONG)[:-1]
check('the cap cuts on a word boundary, never mid-word',
      LONG.startswith(body) and LONG[len(body)] == ' ', repr(GR.clean_desc(LONG)[-30:]))
check('an empty, missing or markup-only description yields a safe value with no marker',
      GR.clean_desc(None) == '' and GR.clean_desc('') == '' and GR.clean_desc('  <br/> ') == '')

# E5 · two files cap the same string. If gen-caltopo.py's cap were the tighter one it would slice
# the ellipsis back off and the export would carry the bare cut this fix exists to remove.
with open(os.path.join(HERE, '..', 'scripts', 'gen-caltopo.py'), encoding='utf-8') as f:
    ct_cap = re.search(r'strip_html\(r\.get\("desc"\)\)\[:(\d+)\]', f.read())
check('E5 · the cap stays inside the one gen-caltopo.py re-applies to the same field',
      ct_cap is not None and GR.DESC_MAX <= int(ct_cap.group(1)),
      'gen-caltopo %s vs DESC_MAX %d' % (ct_cap.group(1) if ct_cap else 'cap not found', GR.DESC_MAX))

long_page = json.loads(json.dumps(FIXTURE['page']))
long_page['data']['data']['CONDDSCR'] = [LONG if 'CONSTRUCTION' not in d.upper() else d for d in long_page['data']['data']['CONDDSCR']]
long_cap, _, _ = run_main(rows=long_page)
check('the published row carries the marker rather than a bare cut',
      all(r['desc'].endswith('…') and len(r['desc']) <= GR.DESC_MAX for r in long_cap['roads']) and long_cap['roads'],
      repr(long_cap['roads'][0]['desc'] if long_cap['roads'] else None))

print('---')
if FAILS:
    print('%d FAILURE(S)' % FAILS)
    sys.exit(1)
print('ALL PASS')
