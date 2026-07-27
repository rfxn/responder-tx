#!/usr/bin/env python3
"""tests/gen-history.test.py — the retention invariant of the playback archive.

Pins the rule that the 2026-07-23 coastal pivot broke: narrowing the display bbox
must never remove a frame or a gauge from what is retained, and must never
un-publish something the board already published. Also pins the two failed-read
rules: an unanswered NWPS threshold fetch is never encoded as "not in flood" and
is retried rather than cached forever (E1), and an unreadable published record
stops the run instead of narrowing publication scope (E6). Runs gen-history.py
against a throwaway git repo (never the real data/), plus unit checks on the pure
helpers. Run: python3 tests/gen-history.test.py"""
import hashlib
import importlib.util
import inspect
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
GEN = os.path.join(HERE, '..', 'scripts', 'gen-history.py')

FAILS = 0


def check(name, ok, detail=''):
    global FAILS
    print('%s: %s%s' % ('PASS' if ok else 'FAIL', name, (' · ' + detail) if (detail and not ok) else ''))
    if not ok:
        FAILS += 1


def load_module():
    spec = importlib.util.spec_from_file_location('gen_history', GEN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


GH = load_module()

WIDE = {'xmin': -102.0, 'ymin': 28.0, 'xmax': -93.0, 'ymax': 31.5}
NARROW = {'xmin': -98.0, 'ymin': 27.5, 'xmax': -93.4, 'ymax': 31.0}
# WESTA/WESTB sit outside NARROW; EASTA/EASTB sit inside both
SITES = [('WESTA', 30.0, -99.5), ('WESTB', 29.5, -100.2), ('EASTA', 29.8, -95.2), ('EASTB', 29.9, -94.6)]
BASE = datetime(2026, 7, 20, 0, 0, 0, tzinfo=timezone.utc)


def iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%SZ')


def capture(n):
    stamp = iso(BASE + timedelta(minutes=20 * n))
    return {'generated': stamp, 'gauges': [
        {'lid': lid, 'name': lid + ' River', 'latitude': lat, 'longitude': lon,
         'status': {'observed': {'primary': 10.0 + n, 'primaryUnit': 'ft',
                                 'floodCategory': 'minor', 'validTime': stamp}}}
        for lid, lat, lon in SITES]}


def git(repo, *args):
    return subprocess.run(('git', '-C', repo) + args, capture_output=True, text=True, check=True).stdout


def commit(repo, bbox, n, msg):
    with open(os.path.join(repo, 'data', 'event.json'), 'w', encoding='utf-8') as f:
        json.dump({'name': 'fixture', 'start': '2026-07-22T00:00:00Z', 'gaugeBbox': bbox}, f)
    with open(os.path.join(repo, 'data', 'gauges-capture.json'), 'w', encoding='utf-8') as f:
        json.dump(capture(n), f)
    git(repo, 'add', 'data/event.json', 'data/gauges-capture.json')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg)


def run_gen(repo):
    return subprocess.run((sys.executable, os.path.join(repo, 'scripts', 'gen-history.py'), '--no-backfill'),
                          capture_output=True, text=True)


def history(repo):
    with open(os.path.join(repo, 'data', 'history.json'), encoding='utf-8') as f:
        return json.load(f)


def make_repo(tmp):
    repo = os.path.join(tmp, 'repo')
    os.makedirs(os.path.join(repo, 'data'))
    os.makedirs(os.path.join(repo, 'scripts'))
    shutil.copy(GEN, os.path.join(repo, 'scripts', 'gen-history.py'))
    git(repo if os.path.isdir(os.path.join(repo, '.git')) else repo, 'init', '-q') if False else None
    subprocess.run(('git', 'init', '-q', repo), check=True, capture_output=True)
    return repo


tmp = tempfile.mkdtemp(prefix='gen-history-test.')
try:
    repo = make_repo(tmp)
    commit(repo, WIDE, 0, 'wide 1')
    commit(repo, WIDE, 1, 'wide 2')
    r1 = run_gen(repo)
    check('wide run exits 0', r1.returncode == 0, r1.stderr[-400:])
    h1 = history(repo)
    check('wide run retains all four gauges', h1['retained']['gauges'] == 4, str(h1['retained']))
    check('wide run publishes all four gauges', set(h1['gaugeIndex']) == {s[0] for s in SITES},
          str(sorted(h1['gaugeIndex'])))

    # the pivot: display scope narrows to the coast, dropping both western gauges
    commit(repo, NARROW, 2, 'coastal pivot')
    r2 = run_gen(repo)
    check('narrowed run exits 0', r2.returncode == 0, r2.stderr[-400:])
    h2 = history(repo)

    check('RETENTION INVARIANT · narrowing the display bbox removes no retained gauge',
          h2['retained']['gauges'] >= h1['retained']['gauges'],
          'was %s now %s' % (h1['retained'], h2['retained']))
    check('RETENTION INVARIANT · narrowing the display bbox removes no retained frame',
          h2['retained']['frames'] >= h1['retained']['frames'],
          'was %s now %s' % (h1['retained'], h2['retained']))
    check('RETENTION INVARIANT · no already-published gauge is un-published',
          set(h1['gaugeIndex']) <= set(h2['gaugeIndex']),
          'lost %s' % sorted(set(h1['gaugeIndex']) - set(h2['gaugeIndex'])))
    check('RETENTION INVARIANT · no already-published frame is un-published',
          {f['t'] for f in h1['frames']} <= {f['t'] for f in h2['frames']},
          'lost %s' % sorted({f['t'] for f in h1['frames']} - {f['t'] for f in h2['frames']}))
    check('narrowed run keeps the western gauges reporting in the newest frame',
          {'WESTA', 'WESTB'} <= set(h2['frames'][-1]['gauges']), str(sorted(h2['frames'][-1]['gauges'])))

    # hostile variant: no prior history.json, so the sticky term is gone and only the
    # union of every committed gaugeBbox can keep the western record alive
    os.unlink(os.path.join(repo, 'data', 'history.json'))
    r3 = run_gen(repo)
    check('cold rebuild exits 0', r3.returncode == 0, r3.stderr[-400:])
    h3 = history(repo)
    check('RETENTION INVARIANT · a cold rebuild under the narrow bbox still publishes the '
          'gauges the wider bbox recorded', {'WESTA', 'WESTB'} <= set(h3['gaugeIndex']),
          str(sorted(h3['gaugeIndex'])))
    check('cold rebuild retains every frame', h3['retained']['frames'] == h2['retained']['frames'],
          '%s vs %s' % (h3['retained'], h2['retained']))

    # structural pin: the retention path must not be able to see a display bbox at all
    src = open(GEN, encoding='utf-8').read()
    walk_src = src[src.index('\ndef frame_from('):src.index('\ndef recovered_sources(')]
    check('STRUCTURAL · frame_from/walk take no bbox argument',
          'def frame_from(snap, snap_dt, gauge_index)' in walk_src and 'def walk(commits)' in walk_src)
    check('STRUCTURAL · the retention path references no bbox at all',
          'bbox' not in walk_src, 'bbox leaked back into frame_from/walk')

    # --- chunked publication: index + one file per UTC day -------------------
    # push the fixture across three UTC days so day boundaries are actually exercised
    commit(repo, NARROW, 80, 'next day')
    commit(repo, NARROW, 160, 'day after')
    run_gen(repo)
    h4 = history(repo)

    def chunk_path(day):
        return os.path.join(repo, 'history', 'day', day + '.json')

    def read_index():
        with open(os.path.join(repo, 'history', 'index.json'), encoding='utf-8') as f:
            return json.load(f)

    idx = read_index()
    days = idx['days']
    check('chunked publish spans one file per UTC day', len(days) == 3, str([d['d'] for d in days]))
    check('index gaugeIndex matches the whole-record view',
          set(idx['gaugeIndex']) == set(h4['gaugeIndex']))
    check('the chunked record is never shorter than the compatibility view it backs',
          sum(d['n'] for d in days) >= len(h4['frames']),
          '%d vs %d' % (sum(d['n'] for d in days), len(h4['frames'])))

    rebuilt = []
    for day in days:
        with open(chunk_path(day['d']), 'rb') as f:
            raw = f.read()
        check('IMMUTABILITY · the published hash describes the bytes on disk (%s)' % day['d'],
              hashlib.sha256(raw).hexdigest()[:len(day['h'])] == day['h'])
        chunk = json.loads(raw.decode('utf-8'))
        check('day file holds exactly the frame count the index claims (%s)' % day['d'],
              len(chunk['frames']) == day['n'])
        check('every frame in a day file belongs to that UTC day (%s)' % day['d'],
              all(f['t'][:10] == day['d'] for f in chunk['frames']))
        rebuilt += chunk['frames']
    check('CONTRACT · the compatibility view is the TAIL of the reassembled chunks, never a '
          'different record', rebuilt[len(rebuilt) - len(h4['frames']):] == h4['frames'],
          '%d rebuilt vs %d published' % (len(rebuilt), len(h4['frames'])))
    check('CONTRACT · a record younger than the compat window publishes whole and claims no window',
          len(rebuilt) == len(h4['frames']) and 'view' not in h4, str(h4.get('view')))
    check('a day payload carries no build stamp, or a frozen day would rehash every cycle',
          'generated' not in json.loads(open(chunk_path(days[0]['d']), encoding='utf-8').read()))

    frozen = {d['d']: d['h'] for d in days}
    run_gen(repo)
    check('IMMUTABILITY · a regeneration with no new data moves no day hash',
          {d['d']: d['h'] for d in read_index()['days']} == frozen)

    # mutation proof: a changed observation must move exactly its own day's hash, so the URL
    # the client caches forever changes with it
    commit(repo, NARROW, 161, 'one more observation')
    run_gen(repo)
    after = {d['d']: d['h'] for d in read_index()['days']}
    moved = sorted(d for d in after if frozen.get(d) != after[d])
    check('MUTATION · new data moves only the affected day hash',
          moved == [sorted(frozen)[-1]], 'moved %s' % moved)

    # a day file the index no longer lists must not survive to be served from an immutable cache
    with open(chunk_path('1999-01-01'), 'w', encoding='utf-8') as f:
        f.write('{"d":"1999-01-01","frames":[]}\n')
    run_gen(repo)
    check('an orphan day file is removed, never left to be served',
          not os.path.exists(chunk_path('1999-01-01')))

    # --- E6 · a failed read of the published record must not shrink the sticky scope ---------
    # The previously published gaugeIndex is the sticky term of the publication ratchet. It used
    # to default to {} when the record would not read, which is a read failure quietly deciding
    # what stays published: the v0.97.97 prune with a different trigger.
    idx_path = os.path.join(repo, 'history', 'index.json')
    good_index = open(idx_path, encoding='utf-8').read()
    published_before = set(read_index()['gaugeIndex'])
    days_before = sorted(os.listdir(os.path.join(repo, 'history', 'day')))
    with open(idx_path, 'w', encoding='utf-8') as f:
        f.write('{"days": [ this is not json')
    rbad = run_gen(repo)
    check('E6 · an unreadable published record stops the run instead of republishing a '
          'scope it could not read', rbad.returncode != 0, 'exit %s' % rbad.returncode)
    check('E6 · the refusal names the reason rather than failing silently',
          'unreadable' in rbad.stderr and 'only grown' in rbad.stderr, rbad.stderr[-300:])
    check('E6 · the refused run rewrites no day file, so the record survives intact',
          sorted(os.listdir(os.path.join(repo, 'history', 'day'))) == days_before)
    with open(idx_path, 'w', encoding='utf-8') as f:
        f.write(good_index)
    check('E6 · the record still publishes every gauge it published before the failed read',
          run_gen(repo).returncode == 0 and published_before <= set(read_index()['gaugeIndex']))

    # --- roads: the same two layers the gauges get ---------------------------
    # WEST sits inside WIDE only, EAST inside both, FAR outside every declared bbox. EAST and
    # FAR carry an expired posted window, so the only signal that can surface them in a frame
    # is presence in the archive, which is exactly what reading roads-capture.json restores.
    def road(rid, route, lat, lon, expired):
        return {'id': rid, 'cond': 'Flooding', 'route': route, 'desc': 'water over roadway',
                'start': iso(BASE - timedelta(hours=5 if expired else 1)),
                'end': iso(BASE - timedelta(hours=4)) if expired else iso(BASE + timedelta(hours=10)),
                'v': [lat, lon]}

    WEST_R = road(1, 'RM0187', 30.0, -99.5, False)
    EAST_R = road(2, 'FM1960', 29.8, -95.2, True)
    FAR_R = road(3, 'RM2400', 31.9, -103.5, True)

    def commit_roads(repo2, bbox, n, msg, snapshot_roads, capture_roads=None):
        stamp = iso(BASE + timedelta(minutes=20 * n))
        with open(os.path.join(repo2, 'data', 'event.json'), 'w', encoding='utf-8') as f:
            json.dump({'name': 'fixture', 'gaugeBbox': bbox}, f)
        with open(os.path.join(repo2, 'data', 'gauges-capture.json'), 'w', encoding='utf-8') as f:
            json.dump(capture(n), f)
        with open(os.path.join(repo2, 'data', 'roads-snapshot.json'), 'w', encoding='utf-8') as f:
            json.dump({'generated': stamp, 'roads': snapshot_roads}, f)
        paths = ['data/event.json', 'data/gauges-capture.json', 'data/roads-snapshot.json']
        if capture_roads is not None:
            with open(os.path.join(repo2, 'data', 'roads-capture.json'), 'w', encoding='utf-8') as f:
                json.dump({'generated': stamp, 'roads': capture_roads}, f)
            paths.append('data/roads-capture.json')
        git(repo2, 'add', *paths)
        git(repo2, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg)

    rrepo = os.path.join(tmp, 'roads')
    os.makedirs(os.path.join(rrepo, 'data'))
    os.makedirs(os.path.join(rrepo, 'scripts'))
    shutil.copy(GEN, os.path.join(rrepo, 'scripts', 'gen-history.py'))
    subprocess.run(('git', 'init', '-q', rrepo), check=True, capture_output=True)

    # pre-split: only the display snapshot exists, and it is the widest road set we had
    commit_roads(rrepo, WIDE, 0, 'roads pre-split 1', [WEST_R])
    commit_roads(rrepo, WIDE, 1, 'roads pre-split 2', [WEST_R])
    rr1 = run_gen(rrepo)
    check('roads: pre-split run exits 0', rr1.returncode == 0, rr1.stderr[-400:])
    hr1 = history(rrepo)
    check('roads: the pre-split display snapshot is still read when no capture exists',
          len(hr1.get('roadIndex') or {}) == 1, str(hr1.get('roadIndex')))

    # the pivot: display snapshot goes empty, the statewide capture carries the real set
    commit_roads(rrepo, NARROW, 2, 'roads pivot', [], [WEST_R, EAST_R, FAR_R])
    rr2 = run_gen(rrepo)
    check('roads: post-pivot run exits 0', rr2.returncode == 0, rr2.stderr[-400:])
    hr2 = history(rrepo)
    ridx = hr2.get('roadIndex') or {}
    routes = {e['route'] for e in ridx.values()}
    check('ROAD RETENTION · a closure that only the statewide capture saw still enters the record',
          'FM1960' in routes, str(sorted(routes)))
    check('ROAD RETENTION · an empty display snapshot un-publishes no earlier closure',
          'RM0187' in routes, str(sorted(routes)))
    check('ROAD PUBLICATION · a closure outside every declared bbox is held, not published',
          'RM2400' not in routes, str(sorted(routes)))
    check('ROAD PUBLICATION · retained road count exceeds the published one, and says so',
          hr2['retained'].get('roads') == 3 and len(ridx) == 2, str(hr2['retained']))
    east_rid = [rid for rid, e in ridx.items() if e['route'] == 'FM1960'][0]
    check('ROAD REPLAY · playback frames actually carry the capture-only closure',
          int(east_rid) in (hr2['frames'][-1].get('roads') or []),
          'rid %s not in %s' % (east_rid, hr2['frames'][-1].get('roads')))
    check('ROAD REPLAY · the held closure never reaches a published frame',
          all(str(r) in ridx for f in hr2['frames'] for r in (f.get('roads') or [])))

    # cold rebuild: no prior history.json, so only the bbox ratchet can keep WEST published
    os.unlink(os.path.join(rrepo, 'data', 'history.json'))
    rr3 = run_gen(rrepo)
    check('roads: cold rebuild exits 0', rr3.returncode == 0, rr3.stderr[-400:])
    routes3 = {e['route'] for e in (history(rrepo).get('roadIndex') or {}).values()}
    check('ROAD RETENTION · a cold rebuild under the narrow bbox still publishes the retired-bbox '
          'closure', routes3 == {'RM0187', 'FM1960'}, str(sorted(routes3)))

    # structural pin: the road retention walk must not be able to see a display bbox
    road_src = src[src.index('\ndef load_road_snapshot('):src.index('\ndef scope_rids(')]
    check('STRUCTURAL · the road retention path references no bbox at all',
          'bbox' not in road_src and 'ROADS_CAPTURE_PATH' in road_src,
          'road retention reads a bbox, or stopped reading the capture')

finally:
    shutil.rmtree(tmp)

# --- pure helpers -----------------------------------------------------------
check('archive_floor ignores event.json "start" (a display field that moves on a pivot)',
      GH.archive_floor({'start': '2026-07-22T00:00:00Z',
                        'archiveStart': '2026-07-05T00:00:00Z'}).isoformat().startswith('2026-07-05'))
check('archive_floor honours archiveStart over backfillStart',
      GH.archive_floor({'archiveStart': '2026-07-05T00:00:00Z',
                        'backfillStart': '2026-07-09T00:00:00Z'}).isoformat().startswith('2026-07-05'))
rolling = datetime.now(timezone.utc) - GH.archive_floor({'start': '2026-07-22T00:00:00Z'})
check('archive_floor falls back to a rolling window when nothing is declared',
      abs(rolling - timedelta(days=GH.BACKFILL_FALLBACK_DAYS)) < timedelta(seconds=5), str(rolling))

boxes = [GH.bbox_of(NARROW), GH.bbox_of(WIDE)]
check('in_any_bbox passes a point that only the retired bbox contained',
      GH.in_any_bbox(30.0, -99.5, boxes))
check('in_any_bbox rejects a point outside every declared bbox',
      not GH.in_any_bbox(40.0, -80.0, boxes))
check('in_any_bbox with no declared bbox is unscoped, never empty',
      GH.in_any_bbox(40.0, -80.0, []))

native = [{'t': '2026-07-20T00:00:00Z', 'gauges': {'A': [1.0, 0]},
           '_dt': datetime(2026, 7, 20, tzinfo=timezone.utc)}]
added = GH.merge_gap_frames(native, {}, {'frames': [
    {'t': '2026-07-20T00:00:00Z', 'gauges': {'A': [99.0, 4]}, 'src': 'usgs'},
    {'t': '2026-07-19T00:00:00Z', 'gauges': {'A': [2.0, 1]}, 'src': 'usgs'},
]}, 'git', 'deadbee')
check('recovery never overwrites a natively captured frame', native[-1]['gauges']['A'] == [1.0, 0]
      and 'src' not in native[-1], str(native[-1]))
check('recovery fills a gap and keeps the source frame\'s own provenance',
      added == 1 and native[0]['src'] == 'usgs' and native[0]['ref'] == 'deadbee', str(native[0]))
check('recovered frames are merged in time order',
      [f['t'] for f in native] == sorted(f['t'] for f in native))

# --- the bounded compatibility view (v0.98.9) -------------------------------
# data/history.json is rewritten in full every 15-minute cycle, so an unbounded one costs the
# whole archive in git every cycle. It is bounded instead, and must SAY it is bounded: a partial
# file that reads as a complete one is the failure this board keeps having.
def frame_at(days_ago, base=datetime(2026, 7, 25, tzinfo=timezone.utc)):
    dt = base - timedelta(days=days_ago)
    return {'t': iso(dt), 'gauges': {'A': [1.0, 0]}, '_dt': dt}


deep = [frame_at(d) for d in range(20, -1, -1)]
kept, view = GH.compat_view(deep)
check('compat view keeps exactly the declared window, anchored on the NEWEST frame (a stalled '
      'cycle must not narrow it)', [f['t'] for f in kept] == [f['t'] for f in deep[-(GH.COMPAT_WINDOW_DAYS + 1):]],
      '%d kept of %d' % (len(kept), len(deep)))
check('compat view is a strict suffix of the record, never a resample of it',
      deep[len(deep) - len(kept):] == kept)
check('DECLARATION · a bounded view says it is bounded', view and view['kind'] == 'recent-window'
      and view['days'] == GH.COMPAT_WINDOW_DAYS, str(view))
check('DECLARATION · the declared depth and first frame match the bytes actually carried',
      view['from'] == kept[0]['t'] and view['frames'] == len(kept), str(view))
check('DECLARATION · the view names the whole record and where to find it',
      view['full']['frames'] == len(deep) and view['full']['from'] == deep[0]['t']
      and view['full']['index'] == GH.CHUNK_INDEX_PATH and 'YYYY-MM-DD' in view['full']['day'],
      str(view['full']))
shallow = [frame_at(d) for d in range(2, -1, -1)]
kept2, view2 = GH.compat_view(shallow)
check('a record younger than the window publishes whole and claims no window',
      kept2 == shallow and view2 is None, str(view2))
check('compat view of an empty record is empty and claims nothing', GH.compat_view([]) == ([], None))
check('serialize puts the declaration ahead of the frames, so a one-line file still reads as partial',
      json.loads(GH.serialize(kept, {}, view=view)).get('view') == view
      and list(json.loads(GH.serialize(kept, {}, view=view)))[:2] == ['generated', 'view'])
check('serialize emits no view key at all when the record is whole',
      'view' not in json.loads(GH.serialize(shallow, {})))

# --- E1 · an unanswered threshold fetch must never publish as "not in flood" -----------------
# cat_from_stage starts at 0 and only raises the code when a threshold exists, so an entry whose
# NWPS metadata fetch failed used to categorize a record crest as 0. That code went into the
# permanent playback archive and was never retried, because the miss was cached as if it were an
# answer. gen-history.py already had the honest encoding for "we cannot judge this gauge":
# frame_from leaves it out of the frame, which is what NWPS not_defined gauges get live.
FULL = {'usgs': '08158000', 'action': 10.0, 'minor': 13.0, 'moderate': 16.0, 'major': 20.0}
MISS = {'usgs': None, 'action': None, 'minor': None, 'moderate': None, 'major': None,
        GH.META_MISS_KEY: '2026-07-26T00:00:00Z'}
NO_SCALE = {'usgs': '08158001', 'action': None, 'minor': None, 'moderate': None, 'major': None}
PARTIAL = {'usgs': None, 'action': None, 'minor': 13.0, 'moderate': None, 'major': 20.0}

check('E1 · a cached threshold miss categorizes nothing, at any stage',
      GH.cat_from_stage(1.0, MISS) is None and GH.cat_from_stage(999.0, MISS) is None)
check('E1 · a gauge with a known flood scale still categorizes normally',
      [GH.cat_from_stage(s, FULL) for s in (1.0, 10.0, 13.0, 16.0, 20.0)] == [0, 1, 2, 3, 4])
check('a gauge whose flood scale is only partly defined still uses the levels it has',
      [GH.cat_from_stage(s, PARTIAL) for s in (1.0, 13.0, 20.0)] == [0, 2, 4])
check('a gauge NWPS answered for but defined no flood scale for is not judged either, which is '
      'what frame_from does with a live not_defined gauge',
      GH.cat_from_stage(50.0, NO_SCALE) is None)
check('a lid absent from the cache entirely is not judged either',
      GH.cat_from_stage(50.0, None) is None and GH.cat_from_stage(50.0, {}) is None)

NOW = datetime.now(timezone.utc)
check('RETRY · a miss inside the retry window is not re-fetched yet',
      not GH.meta_due(dict(MISS, **{GH.META_MISS_KEY: iso(NOW)}), NOW))
check('RETRY · a miss is re-fetched once the retry window passes, never cached forever',
      GH.meta_due(dict(MISS, **{GH.META_MISS_KEY: iso(NOW - timedelta(seconds=GH.META_MISS_RETRY_S + 60))}), NOW))
check('RETRY · a miss with an unparseable stamp is due immediately, so a malformed marker '
      'cannot become the permanent cache', GH.meta_due(dict(MISS, **{GH.META_MISS_KEY: 'soon'}), NOW))
check('RETRY · an answered entry is never re-fetched', not GH.meta_due(FULL, NOW))

# the whole point: a miss must not reach a published frame as a stage with code 0
meta_tmp = tempfile.mkdtemp(prefix='gen-history-meta.')
try:
    saved = (GH.ROOT, GH.http_json, GH.FETCH_SPACING_S, GH.rescue_observed, GH.load_gauge_meta)
    os.makedirs(os.path.join(meta_tmp, 'data'))
    GH.ROOT = meta_tmp
    GH.FETCH_SPACING_S = 0

    calls = []

    def dead_nwps(url, timeout=90):
        calls.append(url)
        raise OSError('upstream refused')

    GH.http_json = dead_nwps
    meta = GH.load_gauge_meta(['AAAT2'])
    check('E1 · an unanswered metadata fetch is recorded as a miss, not as a gauge with no '
          'thresholds', meta['AAAT2'].get(GH.META_MISS_KEY), str(meta['AAAT2']))
    on_disk = json.load(open(os.path.join(meta_tmp, 'data', 'gauge-meta.json'), encoding='utf-8'))
    check('E1 · the miss marker is persisted, so a later run can tell it apart from an answer',
          on_disk['AAAT2'].get(GH.META_MISS_KEY) == meta['AAAT2'][GH.META_MISS_KEY])
    check('E1 · the recorded miss judges no stage', GH.cat_from_stage(99.0, meta['AAAT2']) is None)

    # age the marker past the retry window and prove the next run really re-fetches it
    on_disk['AAAT2'][GH.META_MISS_KEY] = iso(NOW - timedelta(seconds=GH.META_MISS_RETRY_S + 60))
    with open(os.path.join(meta_tmp, 'data', 'gauge-meta.json'), 'w', encoding='utf-8') as f:
        json.dump(on_disk, f)
    GH.http_json = lambda url, timeout=90: {
        'usgsId': '08158000',
        'flood': {'categories': {k: {'stage': v} for k, v in
                                 (('action', 10.0), ('minor', 13.0), ('moderate', 16.0), ('major', 20.0))}}}
    meta2 = GH.load_gauge_meta(['AAAT2'])
    check('RETRY · a miss is retried on a later cycle rather than cached permanently',
          GH.META_MISS_KEY not in meta2['AAAT2'] and meta2['AAAT2']['minor'] == 13.0, str(meta2['AAAT2']))
    check('RETRY · the recovered gauge categorizes again', GH.cat_from_stage(21.0, meta2['AAAT2']) == 4)
    check('RETRY · an answered lid is not re-fetched on the next run',
          GH.load_gauge_meta(['AAAT2'])['AAAT2']['minor'] == 13.0)

    # frame level: the miss lid must be ABSENT, and the healthy lid alongside it unaffected
    base = datetime(2026, 7, 5, tzinfo=timezone.utc)
    GH.load_gauge_meta = lambda lids: {'GOODT2': dict(FULL, usgs=None), 'MISST2': dict(MISS),
                                       'NOSCT2': dict(NO_SCALE, usgs=None)}
    GH.rescue_observed = lambda lid, s, e: [(base, 99.0), (base + timedelta(hours=1), 99.0)]
    frames, _ = GH.build_backfill(['GOODT2', 'MISST2', 'NOSCT2'], base + timedelta(hours=2), base)
    coded = {lid: v for f in frames for lid, v in f['gauges'].items()}
    check('E1 · a reconstructed frame carries the gauge whose flood scale is known',
          coded.get('GOODT2') == [99.0, 4], str(coded))
    check('E1 · a cached miss is ABSENT from the reconstructed frame, never [stage, 0]',
          'MISST2' not in coded, str(coded))
    check('E1 · a gauge with no flood scale is absent too, for the same reason',
          'NOSCT2' not in coded, str(coded))
    check('E1 · a frame that would hold only unjudgeable gauges is not published as a quiet one',
          all(f['gauges'] for f in frames) and len(frames) == 2, str(len(frames)))
finally:
    GH.ROOT, GH.http_json, GH.FETCH_SPACING_S, GH.rescue_observed, GH.load_gauge_meta = saved
    shutil.rmtree(meta_tmp, ignore_errors=True)

peaks = [{'t': 'a', 'gauges': {'A': [1.0, 0], 'B': [9.0, 4]}},
         {'t': 'b', 'gauges': {'A': [5.0, 2]}},
         {'t': 'c', 'gauges': {'A': [2.0, 1], 'B': [3.0, 1]}}]
check('thinning protects the frame holding each gauge\'s crest',
      GH.peak_frame_indices(peaks) == {0, 1}, str(GH.peak_frame_indices(peaks)))

# Backfill thinning drops reconstructed frames to 2-hour spacing. It used to keep even hours and
# nothing else, so a crest that happened on an odd hour inside the reconstructed window was simply
# not in the record: the one moment playback exists to show.
recon_base = datetime(2026, 7, 5, tzinfo=timezone.utc)
recon = []
for h in range(6):
    dt = recon_base + timedelta(hours=h)
    stage = 42.0 if h == 3 else 2.0 + h * 0.01  # the crest sits on an ODD hour
    recon.append({'t': iso(dt), 'gauges': {'A': [stage, 4 if h == 3 else 0]}, 'src': 'usgs', '_dt': dt})
native_tail = {'t': iso(recon_base + timedelta(hours=7)), 'gauges': {'A': [1.0, 0]},
               '_dt': recon_base + timedelta(hours=7)}
thinned_backfill = GH.thin_backfill(recon + [native_tail])
kept_hours = [f['_dt'].hour for f in thinned_backfill]
check('backfill thinning keeps the reconstructed frame holding the crest, odd hour and all',
      3 in kept_hours, str(kept_hours))
check('backfill thinning still coarsens the rest of the reconstruction to even hours',
      [h for h in kept_hours if h != 3 and h != 7] == [0, 2, 4], str(kept_hours))
check('backfill thinning never touches a natively captured frame',
      native_tail in thinned_backfill)
check('the crest survives with its stage and category intact, not just its timestamp',
      [f['gauges']['A'] for f in thinned_backfill if f['_dt'].hour == 3] == [[42.0, 4]])

# --- the reconstruction budget bounds the NETWORK stage, and only that ------------------------
# Reconstruction walks one upstream request per uncovered lid at 90-180s each, so at a thousand
# gauges the stage can outrun the whole 15-minute cycle and stop the board publishing. Bounding it
# is safe only because retention is untouched and because reconstructed frames are re-merged from
# the published record next cycle, so a truncated window resumes instead of restarting.
budget_tmp = tempfile.mkdtemp(prefix='gen-history-budget.')
try:
    saved = (GH.ROOT, GH.http_json, GH.FETCH_SPACING_S, GH.BACKFILL_BUDGET_S, GH._backfill_deadline)
    os.makedirs(os.path.join(budget_tmp, 'data'))
    GH.ROOT = budget_tmp
    GH.FETCH_SPACING_S = 0
    meta_file = os.path.join(budget_tmp, 'data', 'gauge-meta.json')
    lids = ['L%03dT2' % i for i in range(40)]
    fetched = []

    def counting_nwps(url, timeout=90):
        fetched.append(url)
        return {'usgsId': None, 'flood': {'categories': {'minor': {'stage': 5.0}}}}

    GH.http_json = counting_nwps

    GH._backfill_deadline = time.monotonic() + 3600
    GH.load_gauge_meta(lids)
    check('BUDGET · a reconstruction budget with time left still fetches every lid',
          len(fetched) == len(lids), '%d of %d' % (len(fetched), len(lids)))

    os.unlink(meta_file)
    del fetched[:]
    GH._backfill_deadline = time.monotonic() - 1
    GH.load_gauge_meta(lids)
    check('BUDGET · a spent budget stops the per-lid metadata walk instead of running it to the end',
          not fetched, '%d fetched' % len(fetched))
    check('BUDGET · a deferred lid is left uncached, so the next cycle retries it rather than '
          'reading it as a gauge with no thresholds', not os.path.exists(meta_file))

    GH._backfill_deadline = None
    del fetched[:]
    GH.load_gauge_meta(lids)
    check('BUDGET · with no budget in force the walk is unbounded, as it is outside backfill',
          len(fetched) == len(lids), '%d of %d' % (len(fetched), len(lids)))
finally:
    GH.ROOT, GH.http_json, GH.FETCH_SPACING_S, GH.BACKFILL_BUDGET_S, GH._backfill_deadline = saved
    shutil.rmtree(budget_tmp, ignore_errors=True)

# E6: retention scope may only grow. A clock must never be able to truncate the archive walk, so
# the bound is asserted to be absent from the retention path rather than merely believed to be.
RETENTION_FNS = ('walk', 'snapshot_commits', 'road_snapshots', 'merge_recovered',
                 'merge_gap_frames', 'project_display', 'write_chunks', 'load_published')
timed_retention = [n for n in RETENTION_FNS
                   if 'backfill_spent' in inspect.getsource(getattr(GH, n))]
check('E6 · no retention or publication function is time-bounded; only the network stage is',
      not timed_retention, str(timed_retention))
check('BUDGET · the reconstruction budget is a real bound, not an unset default',
      GH.BACKFILL_BUDGET_S > 0)

print('---')
if FAILS:
    print('%d FAILURE(S)' % FAILS)
    sys.exit(1)
print('ALL PASS')
