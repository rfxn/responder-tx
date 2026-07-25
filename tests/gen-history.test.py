#!/usr/bin/env python3
"""tests/gen-history.test.py — the retention invariant of the playback archive.

Pins the rule that the 2026-07-23 coastal pivot broke: narrowing the display bbox
must never remove a frame or a gauge from what is retained, and must never
un-publish something the board already published. Runs gen-history.py against a
throwaway git repo (never the real data/), plus unit checks on the pure helpers.
Run: python3 tests/gen-history.test.py"""
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
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
    check('index frame total matches the whole-record view',
          sum(d['n'] for d in days) == len(h4['frames']),
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
    check('CONTRACT · the chunks reassemble into exactly the compatibility view',
          rebuilt == h4['frames'], '%d rebuilt vs %d published' % (len(rebuilt), len(h4['frames'])))
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

peaks = [{'t': 'a', 'gauges': {'A': [1.0, 0], 'B': [9.0, 4]}},
         {'t': 'b', 'gauges': {'A': [5.0, 2]}},
         {'t': 'c', 'gauges': {'A': [2.0, 1], 'B': [3.0, 1]}}]
check('thinning protects the frame holding each gauge\'s crest',
      GH.peak_frame_indices(peaks) == {0, 1}, str(GH.peak_frame_indices(peaks)))

print('---')
if FAILS:
    print('%d FAILURE(S)' % FAILS)
    sys.exit(1)
print('ALL PASS')
