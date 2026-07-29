#!/usr/bin/env python3
"""tests/gen-crest-summary.test.py — the after-action artifact must not overstate itself.

Two failed-read defects are pinned here. The summary declares the window it covers, and a
playback archive that would not read used to drop out of that declaration silently, so the
artifact asserted the event started later than the record says. Separately, the set of gauges
already published is the ratchet that keeps a display-scope change from un-reporting a peak
(E6), and it used to default to empty when the previous summary would not read, which is the
read failure doing the un-publishing. Runs against a throwaway git repo, never the real data/.
Run: python3 tests/gen-crest-summary.test.py"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
GEN = os.path.join(HERE, '..', 'scripts', 'gen-crest-summary.py')

FAILS = 0


def check(name, ok, detail=''):
    global FAILS
    print('%s: %s%s' % ('PASS' if ok else 'FAIL', name, (' · ' + detail) if (detail and not ok) else ''))
    if not ok:
        FAILS += 1


class Bail(Exception):
    """A dependent step whose input never appeared. Recorded as a failure and its block skipped,
    rather than crashing the file and losing every assertion after it."""


BASE = datetime(2026, 7, 20, 0, 0, 0, tzinfo=timezone.utc)
ARCHIVE_START = BASE - timedelta(days=5)


def iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%SZ')


def git(repo, *args):
    return subprocess.run(('git', '-C', repo) + args, capture_output=True, text=True, check=True).stdout


def capture(n):
    stamp = iso(BASE + timedelta(minutes=20 * n))
    return {'generated': stamp, 'gauges': [
        {'lid': 'EASTA', 'name': 'East River', 'latitude': 29.8, 'longitude': -95.2,
         'status': {'observed': {'primary': 14.0 + n, 'primaryUnit': 'ft',
                                 'floodCategory': 'minor', 'validTime': stamp}}}]}


def commit(repo, n, msg):
    with open(os.path.join(repo, 'data', 'event.json'), 'w', encoding='utf-8') as f:
        json.dump({'name': 'fixture', 'gaugeBbox': {'xmin': -98.0, 'ymin': 27.5,
                                                    'xmax': -93.4, 'ymax': 31.0}}, f)
    with open(os.path.join(repo, 'data', 'gauges-capture.json'), 'w', encoding='utf-8') as f:
        json.dump(capture(n), f)
    git(repo, 'add', 'data/event.json', 'data/gauges-capture.json')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg)


def write_archive(repo):
    """A chunked playback record whose src-tagged frames predate the git archive, which is the
    only thing that can establish the real start of the window."""
    day = ARCHIVE_START.strftime('%Y-%m-%d')
    os.makedirs(os.path.join(repo, 'history', 'day'), exist_ok=True)
    frames = [{'t': iso(ARCHIVE_START), 'gauges': {'EASTA': [22.0, 2]}, 'src': 'usgs'}]
    with open(os.path.join(repo, 'history', 'day', day + '.json'), 'w', encoding='utf-8') as f:
        json.dump({'d': day, 'frames': frames}, f)
    with open(os.path.join(repo, 'history', 'index.json'), 'w', encoding='utf-8') as f:
        json.dump({'format': 1, 'frames': 1, 'days': [{'d': day, 'n': 1}],
                   'gaugeIndex': {'EASTA': {'name': 'East River', 'lat': 29.8, 'lon': -95.2}}}, f)


def make_repo(tmp, name):
    repo = os.path.join(tmp, name)
    os.makedirs(os.path.join(repo, 'data'))
    os.makedirs(os.path.join(repo, 'scripts'))
    shutil.copy(GEN, os.path.join(repo, 'scripts', 'gen-crest-summary.py'))
    subprocess.run(('git', 'init', '-q', repo), check=True, capture_output=True)
    commit(repo, 0, 'first')
    commit(repo, 1, 'second')
    return repo


def run_gen(repo):
    return subprocess.run((sys.executable, os.path.join(repo, 'scripts', 'gen-crest-summary.py')),
                          capture_output=True, text=True, env=dict(os.environ, RESPONDER_ROOT=repo))


def summary(repo):
    try:
        with open(os.path.join(repo, 'data', 'crest-summary.json'), encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        raise Bail('data/crest-summary.json did not read after the run under test: %s' % e)


tmp = tempfile.mkdtemp(prefix='gen-crest-summary-test.')
try:
    # --- the window a readable archive establishes ---------------------------------------
    repo = make_repo(tmp, 'window')
    write_archive(repo)
    r = run_gen(repo)
    check('a readable archive run exits 0', r.returncode == 0, r.stderr[-400:])
    good = summary(repo)
    check('the window starts where the archive says the record starts, not where the git '
          'archive happens to begin', good['window']['first'] == iso(ARCHIVE_START),
          str(good['window']))
    check('a readable archive declares the pre-archive window it folded in',
          good.get('backfill', {}).get('from') == iso(ARCHIVE_START), str(good.get('backfill')))
    check('a readable archive claims nothing about being incomplete',
          'first_incomplete' not in good['window'], str(good['window']))

    # --- E1 · an archive that exists and will not read must not shorten the claimed window --
    idx = os.path.join(repo, 'history', 'index.json')
    with open(idx, 'w', encoding='utf-8') as f:
        f.write('{"days": [ not json at all')
    r2 = run_gen(repo)
    check('an unreadable archive still publishes the peaks it can see', r2.returncode == 0,
          r2.stderr[-400:])
    bad = summary(repo)
    check('E1 · an unreadable archive is declared, never folded into a confident window',
          bad['window'].get('first_incomplete') is True, str(bad['window']))
    check('E1 · the declaration says the event may have started earlier',
          'may have begun earlier' in (bad['window'].get('note') or ''), str(bad['window']))
    check('E1 · the run says so on stderr rather than failing quietly',
          'unreadable' in r2.stderr and 'not empty' in r2.stderr, r2.stderr[-400:])
    check('E1 · the shortened window is not silently presented as the record start',
          bad['window']['first'] != good['window']['first'], str(bad['window']))

    # --- no archive at all is a different fact from an archive that would not read ---------
    plain = make_repo(tmp, 'noarchive')
    r3 = run_gen(plain)
    check('a repo with no archive at all exits 0', r3.returncode == 0, r3.stderr[-400:])
    none = summary(plain)
    check('no archive is an established window, not an unknown one: it claims no incompleteness',
          'first_incomplete' not in none['window'], str(none['window']))

    # --- E6 · the sticky published set may not shrink because a file would not read ---------
    sticky = make_repo(tmp, 'sticky')
    r4 = run_gen(sticky)
    check('the first run publishes with an empty ratchet', r4.returncode == 0, r4.stderr[-400:])
    path = os.path.join(sticky, 'data', 'crest-summary.json')
    published = json.dumps(summary(sticky), separators=(',', ':'))
    check('the first run published the gauge that flooded',
          [g['lid'] for g in json.loads(published)['gauges']] == ['EASTA'])

    with open(path, 'w', encoding='utf-8') as f:
        f.write('{"gauges": [ truncated mid-write')
    corrupt = open(path, encoding='utf-8').read()
    r5 = run_gen(sticky)
    check('E6 · an unreadable published summary stops the run rather than republishing a '
          'scope it could not read', r5.returncode != 0, 'exit %s' % r5.returncode)
    check('E6 · the refusal names the reason',
          'unreadable' in r5.stderr and 'only grown' in r5.stderr, r5.stderr[-400:])
    check('E6 · the refused run overwrites nothing', open(path, encoding='utf-8').read() == corrupt)

    with open(path, 'w', encoding='utf-8') as f:
        f.write(published)
    r6 = run_gen(sticky)
    check('E6 · a readable summary republishes normally, ratchet intact',
          r6.returncode == 0 and [g['lid'] for g in summary(sticky)['gauges']] == ['EASTA'],
          r6.stderr[-400:])

    os.unlink(path)
    r7 = run_gen(sticky)
    check('an ABSENT summary is a genuinely empty ratchet, not a read failure, and publishes',
          r7.returncode == 0 and [g['lid'] for g in summary(sticky)['gauges']] == ['EASTA'],
          r7.stderr[-400:])
except Bail as e:
    check(str(e), False)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print('---')
if FAILS:
    print('%d FAILURE(S)' % FAILS)
    sys.exit(1)
print('ALL PASS')
