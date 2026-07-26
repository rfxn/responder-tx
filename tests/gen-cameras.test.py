#!/usr/bin/env python3
"""tests/gen-cameras.test.py — the ITS per-district collapse guard, against a fixture
data/cameras.json (RESPONDER_ROOT override, never the real data/). The aggregate floor
cannot see a per-district collapse, so this covers the shape that can: gradual loss passes
through, a collapse is held, the hold expires, and a recovered district clears its clock.
Also covers the baseline read (absent is a first run, unreadable refuses to publish), the
per-network collapse floor, and the one-retry liveness probe. No network: pure functions only.
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
    cams, clock = g.its_hold_collapsed(live, never_near, g.load_prev())
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
    cams, clock = g.its_hold_collapsed(live, never_near, g.load_prev())
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
    cams, clock = g.its_hold_collapsed(live, never_near, g.load_prev())
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
    cams, clock = g.its_hold_collapsed(live, never_near, g.load_prev())
    check('a recovered district clears its carry clock', 'FTW' not in clock, str(list(clock)))
    check('a recovered district publishes the live feed', len(cams) == 140, 'kept %d' % len(cams))

    live['FTW'] = [dict(row('FTW', 0), name='FTW cam 0 renamed')]  # collapse to a single live row
    cams, _ = g.its_hold_collapsed(live, never_near, g.load_prev())
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
    cams, clock = g.its_hold_collapsed(live, never_near, g.load_prev())
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
    cams, _ = g.its_hold_collapsed(live, lambda lat, lon: lat < 31.5, g.load_prev())
    check('a held row now covered by a streamable cam is still deduped out',
          0 < len(cams) < 140, 'kept %d of 140' % len(cams))
finally:
    shutil.rmtree(root)

# ---------------------------------------------------------------------------
# A failed READ of the previous inventory must not become a published value. The empty pair that
# used to come back from an unreadable file was then used as "the last known ITS rows", so the
# collapse hold had nothing to hold and a district dropout published as a retirement: the loss
# v0.99.24 fixed, reappearing through the read-failure path.
root = fixture({'FTW': 140})
try:
    g = load_gen(root)
    check('a readable previous inventory still loads', len(g.load_prev()['txdot']) == 140)

    with open(os.path.join(root, 'data', 'cameras.json'), 'w', encoding='utf-8') as f:
        f.write('{"txdot": [{"src": "its", "dist": "FTW"')  # the shape a killed run leaves behind
    raised = ''
    try:
        g.load_prev()
    except SystemExit as exc:
        raised = str(exc)
    check('a previous inventory that exists but will not parse refuses to publish',
          'will not read' in raised, raised or 'no SystemExit raised')
finally:
    shutil.rmtree(root)

# root ignores mode bits, so unreadability is staged as a path that cannot be opened as a file
root = fixture({'FTW': 140})
try:
    g = load_gen(root)
    os.remove(os.path.join(root, 'data', 'cameras.json'))
    os.makedirs(os.path.join(root, 'data', 'cameras.json'))
    raised = ''
    try:
        g.load_prev()
    except SystemExit as exc:
        raised = str(exc)
    check('a previous inventory that cannot be opened at all refuses to publish',
          'will not read' in raised, raised or 'no SystemExit raised')
finally:
    shutil.rmtree(root)

# An absent file is a different fact from an unreadable one, and must stay a legitimate first run.
root = tempfile.mkdtemp(prefix='responder-cams-test.')
os.makedirs(os.path.join(root, 'data'))
try:
    g = load_gen(root)
    check('a genuinely absent previous inventory is a first run, not a failure', g.load_prev() is None)
    live = {d: [] for d in g.ITS_DISTRICTS}
    live['YKM'] = [row('YKM', i) for i in range(8)]
    cams, clock = g.its_hold_collapsed(live, never_near, g.load_prev())
    check('a first run publishes the live feed, with no baseline to hold against',
          len(cams) == 8 and not clock, 'kept %d' % len(cams))
finally:
    shutil.rmtree(root)

# The defect in one assertion: a collapsed district AND an unreadable baseline. Before, the empty
# read disarmed the hold and 36 of 140 shipped as a retirement.
root = fixture({'FTW': 140})
try:
    g = load_gen(root)
    with open(os.path.join(root, 'data', 'cameras.json'), 'w', encoding='utf-8') as f:
        f.write('not json at all')
    live = {d: [] for d in g.ITS_DISTRICTS}
    live['FTW'] = [row('FTW', i) for i in range(36)]
    try:
        published = len(g.its_hold_collapsed(live, never_near, g.load_prev())[0])
    except SystemExit:
        published = 'refused'
    check('an unreadable baseline refuses rather than retiring the 104 cameras it cannot see',
          published == 'refused', 'published %r' % (published,))
finally:
    shutil.rmtree(root)

# ---------------------------------------------------------------------------
# The per-network collapse floor. The absolute floors are fixed numbers that do not follow the
# fleet: austin's floor of 400 cannot see 817 fall to 401, and elpbridge/porthou carried none at all.
root = fixture({})
try:
    g = load_gen(root)

    def net(n, name='austin'):
        return {name: [{'id': str(i), 'lat': 30.0, 'lon': -97.0} for i in range(n)]}

    def refuses(prev, out):
        try:
            g.check_no_collapse(prev, out)
        except SystemExit as exc:
            return str(exc)
        return ''

    check('bbox and the metadata keys are not mistaken for camera networks',
          list(g.camera_networks({'bbox': [-107.0, 25.5, -93.5, 36.6], 'generated': 'x',
                                  'attribution': {'a': 'b'}, 'itsCarried': {}, 'austin': []})) == ['austin'],
          str(list(g.camera_networks({'bbox': [-107.0, 25.5], 'austin': []}))))
    check('a large network at under half its last published count refuses to publish',
          'floor 408' in refuses(net(817), net(407)), refuses(net(817), net(407)) or 'no SystemExit')
    check('a large network holding half still publishes, so ordinary loss is not blocked',
          refuses(net(817), net(409)) == '', refuses(net(817), net(409)))
    check('a first run has no baseline and cannot be blocked by one', refuses(None, net(1)) == '')
    check('a network the previous file never carried is not blocked from appearing',
          refuses(net(0), net(5)) == '')

    # the hand-kept lists the audit found floorless: too small for a fraction to mean anything, but
    # an emptied network is a dead host, never every camera retiring at once
    for small in ('elpbridge', 'porthou', 'hays', 'galveston'):
        check('%s falling to zero refuses to publish' % small,
              'does not empty itself' in refuses(net(8, small), net(0, small)))
    check('a small hand-kept list shedding heads still publishes',
          refuses(net(8, 'elpbridge'), net(3, 'elpbridge')) == '')
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

# ---------------------------------------------------------------------------
# The icd is a path segment, so a '/' has to be carried as a stand-in and reversed by the
# proxies. The three validators are hand-mirrored across three languages, so the drift that
# would silently drop a district's cameras again is asserted here rather than trusted.
root = fixture({})
try:
    g = load_gen(root)
    check('an icd with a slash becomes a path-safe key',
          g.its_icd_key('BMT BU90 @ FM1006/7th St  - Orange') == 'BMT BU90 @ FM1006~7th St  - Orange',
          str(g.its_icd_key('BMT BU90 @ FM1006/7th St  - Orange')))
    check('the key reverses back to exactly the upstream icd',
          g.its_icd_key('BMT FM105 @ Sandbar Rd/Granger Rd - Orange').replace(g.ITS_ICD_SLASH, '/')
          == 'BMT FM105 @ Sandbar Rd/Granger Rd - Orange')
    check('an ordinary icd is unchanged, so nothing already shipping moves',
          g.its_icd_key('BMT SH73 @ FM366') == 'BMT SH73 @ FM366')
    check('an icd already holding the stand-in cannot round-trip and is dropped',
          g.its_icd_key('BMT SH73 ~ FM366') is None)
    check('an icd outside the charset is still rejected', g.its_icd_key('BMT <script>') is None)
    check('an empty icd is rejected', g.its_icd_key('') is None)
    check('the stand-in is not a character any upstream icd uses',
          g.ITS_ICD_SLASH == '~' and g.ITS_ICD_RE.match('~'))

    srv = open(os.path.join(HERE, '..', 'server.py'), encoding='utf-8').read()
    edge = open(os.path.join(HERE, '..', 'functions', 'api', 'cam', '[district]', '[icd].js'),
                encoding='utf-8').read()
    charset = g.ITS_ICD_RE.pattern[1:-1]  # drop the ^ and $ anchors; the class is identical in all three
    check('server.py mirrors the generator icd charset', charset in srv, charset)
    check('the Pages Function mirrors the generator icd charset', charset in edge, charset)
    check('server.py reverses the stand-in before the upstream call',
          "replace(CAM_ICD_SLASH, '/')" in srv)
    check('the Pages Function reverses the stand-in before the upstream call',
          "split(ICD_SLASH).join('/')" in edge)
    check('both proxies pin the same stand-in character',
          ("CAM_ICD_SLASH = '~'" in srv) and ("ICD_SLASH = '~'" in edge))

    arl = g.ARLINGTON_ID_RE.pattern[1:-1]
    check('server.py mirrors the Arlington id charset', arl in srv, arl)
    check('the Pages Function mirrors the Arlington id charset', arl in edge, arl)
    check('the Arlington id charset admits a space, which one camera id contains',
          bool(g.ARLINGTON_ID_RE.match('Sublett-Twin Maple')))
    check('the Arlington id charset still admits no dot or slash, so no traversal',
          not g.ARLINGTON_ID_RE.match('../../etc/passwd') and not g.ARLINGTON_ID_RE.match('a.b'))
    check('server.py percent-encodes the id it interpolates into the upstream URL',
          "quote(cid, safe='')" in srv)
    check('the Pages Function percent-encodes the Arlington id',
          'encodeURIComponent(id)}.jpg' in edge)
    check('the Arlington query asks for geometry, which is where the missing positions live',
          'returnGeometry=true' in g.ARLINGTON and 'outSR=4326' in g.ARLINGTON)

    # The edge gets its path params percent-encoded while server.py unquotes its own. Without the
    # decode, every id holding a space, '@' or '&' fails its charset check: 859 of 861 ITS icds.
    check('the Pages Function decodes the district param', 'decodeURIComponent(String(context.params.district' in edge)
    check('the Pages Function decodes the id param', 'decodeURIComponent(String(context.params.icd' in edge)
    check('a malformed percent-escape is a 400, never an unhandled throw',
          'catch {\n    return new Response(\'bad request\', { status: 400 });' in edge)
    only_plain = [c for c in json.loads(open(os.path.join(HERE, '..', 'data', 'cameras.json'),
                                             encoding='utf-8').read())['txdot']
                  if c.get('src') == 'its' and not __import__('re').match(r'^[A-Za-z0-9_-]+$', c['icd'])]
    check('the shipped inventory really does depend on that decode',
          len(only_plain) > 500, '%d icds need percent-encoding' % len(only_plain))
finally:
    shutil.rmtree(root)

print('---')
if FAILS:
    print('%d FAILURE(S)' % FAILS)
    sys.exit(1)
print('ALL PASS')
