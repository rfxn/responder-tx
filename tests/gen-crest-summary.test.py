#!/usr/bin/env python3
"""tests/gen-crest-summary.test.py — the after-action artifact must not overstate itself.

Two failed-read defects are pinned here. The summary declares the window it covers, and a
playback archive that would not read used to drop out of that declaration silently, so the
artifact asserted the event started later than the record says. Separately, the set of gauges
already published is the ratchet that keeps a display-scope change from un-reporting a peak
(E6), and it used to default to empty when the previous summary would not read, which is the
read failure doing the un-publishing. The event.json aoArea clip is the one thing allowed to
narrow that ratchet, and only the listing: the retained record keeps every peak. Runs against a
throwaway git repo, never the real data/.
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
AOAREA = os.path.join(HERE, '..', 'scripts', 'aoarea.py')
STAGEPLAUS = os.path.join(HERE, '..', 'scripts', 'stageplaus.py')
with open(os.path.join(HERE, '..', 'data', 'event.json'), encoding='utf-8') as _f:
    SHIPPED_AO = json.load(_f)['aoArea']

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
    shutil.copy(AOAREA, os.path.join(repo, 'scripts', 'aoarea.py'))
    shutil.copy(STAGEPLAUS, os.path.join(repo, 'scripts', 'stageplaus.py'))
    subprocess.run(('git', 'init', '-q', repo), check=True, capture_output=True)
    commit(repo, 0, 'first')
    commit(repo, 1, 'second')
    return repo


def ao_repo(tmp, name, with_ao):
    """Texas, a Red River gauge on the Arkansas bank, Seiling OK, and a row with no coordinates,
    all flooding, under a statewide gaugeBbox. Seiling and the unplaced row are already published."""
    repo = os.path.join(tmp, name)
    os.makedirs(os.path.join(repo, 'data'))
    os.makedirs(os.path.join(repo, 'scripts'))
    shutil.copy(GEN, os.path.join(repo, 'scripts', 'gen-crest-summary.py'))
    shutil.copy(AOAREA, os.path.join(repo, 'scripts', 'aoarea.py'))
    shutil.copy(STAGEPLAUS, os.path.join(repo, 'scripts', 'stageplaus.py'))
    subprocess.run(('git', 'init', '-q', repo), check=True, capture_output=True)
    event = {'name': 'fixture', 'gaugeBbox': {'xmin': -106.65, 'ymin': 25.83, 'xmax': -93.4, 'ymax': 36.5}}
    if with_ao:
        event['aoArea'] = SHIPPED_AO
    for n in (0, 1):
        stamp = iso(BASE + timedelta(minutes=20 * n))
        obs = lambda cat: {'primary': 20.0 + n, 'primaryUnit': 'ft', 'floodCategory': cat, 'validTime': stamp}  # noqa: E731
        rows = [
            {'lid': 'EASTA', 'name': 'East River', 'latitude': 29.8, 'longitude': -95.2, 'status': {'observed': obs('minor')}},
            {'lid': 'INGA4', 'name': 'Red River at Index', 'latitude': 33.551944, 'longitude': -94.041111,
             'status': {'observed': obs('moderate')}},
            {'lid': 'SEIO2', 'name': 'North Canadian River near Seiling', 'latitude': 36.183373,
             'longitude': -98.921206, 'status': {'observed': obs('major')}},
            {'lid': 'NOLOC', 'name': 'Unplaced gauge', 'status': {'observed': obs('minor')}},
        ]
        with open(os.path.join(repo, 'data', 'event.json'), 'w', encoding='utf-8') as f:
            json.dump(event, f)
        with open(os.path.join(repo, 'data', 'gauges-capture.json'), 'w', encoding='utf-8') as f:
            json.dump({'generated': stamp, 'gauges': rows}, f)
        git(repo, 'add', 'data/event.json', 'data/gauges-capture.json')
        git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'c%d' % n)
    with open(os.path.join(repo, 'data', 'crest-summary.json'), 'w', encoding='utf-8') as f:
        json.dump({'gauges': [{'lid': 'SEIO2'}, {'lid': 'NOLOC'}]}, f)
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

    # --- the aoArea clip narrows the listing, never the retained record ------------------------
    ctl = ao_repo(tmp, 'noao', with_ao=False)
    r8 = run_gen(ctl)
    check('control: without an aoArea the published Oklahoma peak stays listed (the ratchet)',
          r8.returncode == 0 and 'SEIO2' in {g['lid'] for g in summary(ctl)['gauges']}, r8.stderr[-400:])
    clip = ao_repo(tmp, 'aoclip', with_ao=True)
    r9 = run_gen(clip)
    got = summary(clip) if r9.returncode == 0 else {'gauges': []}
    lids = sorted(g['lid'] for g in got['gauges'])
    check('the aoArea clip drops the deep Oklahoma gauge even though it was already published',
          r9.returncode == 0 and 'SEIO2' not in lids, '%s %s' % (lids, r9.stderr[-300:]))
    check('...and keeps Texas and the Red River gauge on the Arkansas bank', {'EASTA', 'INGA4'} <= set(lids), str(lids))
    check('...and leaves a row it cannot place, rather than guessing it is out of state', 'NOLOC' in lids, str(lids))
    check('E6 · the retained record still counts all four; only publication narrowed',
          got.get('retained_gauges') == 4, str(got.get('retained_gauges')))
    check('the run names what the clip dropped', '1 outside the aoArea: SEIO2' in r9.stdout, r9.stdout[:300])
except Bail as e:
    check(str(e), False)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

# --- an impossible stage is no reading, and the category NWPS sent with it is void ------------
# NWPS published SEIO2 at 10000030 ft and SGET2 at 10000000 ft, both "major", and the summary
# carried both as ten-million-foot major crests. A reservoir that reports elevation must still count.
def row(lid, primary, cat, stamp, lat=29.8, lon=-95.2):
    return {'lid': lid, 'name': lid + ' River', 'latitude': lat, 'longitude': lon,
            'status': {'observed': {'primary': primary, 'primaryUnit': 'ft', 'floodCategory': cat,
                                    'validTime': stamp}}}


STAGE_TIMELINE = [  # (SGET2-like, SEIO2-like, real flood that also got one bad reading, lake, low)
    [('BOGA', 6.06, 'no_flooding'), ('BOGB', 3.4, 'no_flooding'), ('MIXD', 18.2, 'moderate'),
     ('LAKE', 681.3, 'minor'), ('LOWS', 2.0, 'no_flooding')],
    [('BOGA', 10000000, 'major'), ('BOGB', 10000030, 'major'), ('MIXD', 10000000, 'major'),
     ('LAKE', 681.9, 'minor'), ('LOWS', -999, 'major')],
    [('BOGA', 6.05, 'no_flooding'), ('BOGB', 3.5, 'no_flooding'), ('MIXD', 17.9, 'moderate'),
     ('LAKE', 681.6, 'minor'), ('LOWS', -9999, 'major')],
]

tmp_stage = tempfile.mkdtemp(prefix='gen-crest-summary-stage.')
try:
    srepo = os.path.join(tmp_stage, 'stage')
    os.makedirs(os.path.join(srepo, 'data'))
    os.makedirs(os.path.join(srepo, 'scripts'))
    shutil.copy(GEN, os.path.join(srepo, 'scripts', 'gen-crest-summary.py'))
    shutil.copy(AOAREA, os.path.join(srepo, 'scripts', 'aoarea.py'))
    shutil.copy(STAGEPLAUS, os.path.join(srepo, 'scripts', 'stageplaus.py'))
    subprocess.run(('git', 'init', '-q', srepo), check=True, capture_output=True)
    for n, rows in enumerate(STAGE_TIMELINE):
        stamp = iso(BASE + timedelta(minutes=20 * n))
        with open(os.path.join(srepo, 'data', 'event.json'), 'w', encoding='utf-8') as f:
            json.dump({'name': 'fixture', 'gaugeBbox': {'xmin': -98.0, 'ymin': 27.5,
                                                        'xmax': -93.4, 'ymax': 31.0}}, f)
        with open(os.path.join(srepo, 'data', 'gauges-capture.json'), 'w', encoding='utf-8') as f:
            json.dump({'generated': stamp, 'gauges': [row(lid, v, c, stamp) for lid, v, c in rows]}, f)
        git(srepo, 'add', 'data/event.json', 'data/gauges-capture.json')
        git(srepo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'n%d' % n)
    # a reconstructed pre-archive frame carrying the same junk must not seed a peak either
    day = ARCHIVE_START.strftime('%Y-%m-%d')
    os.makedirs(os.path.join(srepo, 'history', 'day'))
    with open(os.path.join(srepo, 'history', 'day', day + '.json'), 'w', encoding='utf-8') as f:
        json.dump({'d': day, 'frames': [{'t': iso(ARCHIVE_START), 'src': 'nwps',
                                         'gauges': {'BOGA': [10000000, 4], 'LAKE': [681.1, 2]}}]}, f)
    with open(os.path.join(srepo, 'history', 'index.json'), 'w', encoding='utf-8') as f:
        json.dump({'format': 1, 'days': [{'d': day, 'n': 1}], 'gaugeIndex': {
            'BOGA': {'name': 'BOGA River', 'lat': 29.8, 'lon': -95.2},
            'LAKE': {'name': 'LAKE River', 'lat': 29.8, 'lon': -95.2}}}, f)
    rs = run_gen(srepo)
    check('STAGE · the run with impossible stages in the archive exits 0', rs.returncode == 0,
          rs.stderr[-400:])
    peaks = {g['lid']: g for g in summary(srepo)['gauges']}
    check('STAGE · a 10000000 ft "major" that never really flooded publishes no crest at all',
          'BOGA' not in peaks, str(peaks.get('BOGA')))
    check('STAGE · a 10000030 ft "major" that never really flooded publishes no crest at all',
          'BOGB' not in peaks, str(peaks.get('BOGB')))
    check('STAGE · a gauge that really flooded keeps its real peak and category, not the junk',
          peaks.get('MIXD', {}).get('peak') == 18.2
          and peaks.get('MIXD', {}).get('peak_category') == 'moderate', str(peaks.get('MIXD')))
    check('STAGE · a reservoir reporting elevation (681.9 ft) is a real reading and still crests',
          peaks.get('LAKE', {}).get('peak') == 681.9
          and peaks.get('LAKE', {}).get('peak_category') == 'minor', str(peaks.get('LAKE')))
    check('STAGE · the -999 / -9999 missing sentinels are still rejected, even tagged "major"',
          'LOWS' not in peaks, str(peaks.get('LOWS')))
    check('STAGE · no published peak sits outside the physical envelope',
          all(-300 < g['peak'] < 25000 for g in peaks.values()), str(peaks))
except Bail as e:
    check(str(e), False)
finally:
    shutil.rmtree(tmp_stage, ignore_errors=True)

# --- quiet mode: the capture this cycle fetched is the newest snapshot, though not yet committed ---
# Captures are committed only at a publish (2x/day quiet), so walking commits alone ended every
# published summary at the PREVIOUS publish.
tmp_wt = tempfile.mkdtemp(prefix='gen-crest-summary-worktree.')
try:
    wrepo = make_repo(tmp_wt, 'wt')
    with open(os.path.join(wrepo, 'data', 'gauges-capture.json'), 'w', encoding='utf-8') as f:
        json.dump(capture(2), f)
    rw = run_gen(wrepo)
    doc = summary(wrepo)
    east = {g['lid']: g for g in doc['gauges']}.get('EASTA', {})
    check('WORKTREE · MUTATION the uncommitted capture this cycle fetched is the newest peak and window end',
          rw.returncode == 0 and east.get('peak') == 16.0 and doc['window']['last'] == capture(2)['generated'],
          '%s %s' % (east, doc.get('window')))
    check('WORKTREE · the generator commits nothing itself',
          git(wrepo, 'status', '--porcelain', '--', 'data/gauges-capture.json').strip().startswith('M'),
          git(wrepo, 'status', '--porcelain'))
except Bail as e:
    check(str(e), False)
finally:
    shutil.rmtree(tmp_wt, ignore_errors=True)

# --- a reading implausible for ITS OWN gauge is no reading ------------------------------------
# 2026-11-17 summary, live on the mirror: SGET2 at 638 ft "major", 1747.9% of its 36.5 ft record, was
# the top row. It sat inside the absolute envelope; its real stage was 6.4 ft (a x100 datum shift).
# GRRT2, a Galveston tide gauge, read 9.89 then 25.49 ft for one observation each, repeated while the
# gauge was silent, between 1.58 and 1.17 ft. SHAT2 jumped 5.05 -> 32.39 -> 5.06 in one hour. Readings
# here are 30 min apart, as those gauges report; SPRS reports hourly, the BWRT2 case that must stand.
PLAUS_TIMELINE = [  # (lid, stage, category, validTime index)
    [('DATM', 6.38, 'no_flooding', 0), ('TIDE', 1.58, 'no_flooding', 0), ('SPIK', 5.05, 'no_flooding', 0),
     ('REAL', 10.0, 'minor', 0), ('FLSH', 8.0, 'minor', 0), ('NREF', 9.0, 'minor', 0), ('SPRS', 2.0, 'no_flooding', 0),
     ('ALTN', 9.7, 'no_flooding', 0), ('FLSH2', 3.36, 'no_flooding', 0), ('SPKH', 16.28, 'no_flooding', 0)],
    [('DATM', 634, 'major', 1), ('TIDE', 9.89, 'major', 1), ('SPIK', 32.39, 'major', 1),
     ('REAL', 18.0, 'moderate', 1), ('FLSH', 17.0, 'major', 1), ('NREF', 60.0, 'major', 1), ('SPRS', 2.0, 'no_flooding', 0),
     ('ALTN', 40.62, 'major', 1), ('FLSH2', 7.15, 'minor', 1), ('SPKH', 16.3, 'no_flooding', 1)],
    [('DATM', 638, 'major', 2), ('TIDE', 9.89, 'major', 1), ('SPIK', 5.06, 'no_flooding', 2),
     ('REAL', 27.5, 'major', 2), ('FLSH', 16.0, 'major', 2), ('NREF', 9.5, 'minor', 2), ('SPRS', 15.0, 'major', 2),
     ('ALTN', 9.68, 'no_flooding', 2), ('FLSH2', 17.35, 'major', 2), ('SPKH', 48.47, 'major', 2)],
    [('DATM', 6.4, 'no_flooding', 3), ('TIDE', 25.49, 'major', 3), ('SPIK', 5.04, 'no_flooding', 3),
     ('REAL', 26.8, 'major', 3), ('FLSH', 9.0, 'minor', 3), ('NREF', 9.1, 'minor', 3), ('SPRS', 15.0, 'major', 2),
     ('ALTN', 35.83, 'major', 3), ('FLSH2', 10.3, 'moderate', 3), ('SPKH', 16.53, 'no_flooding', 3)],
    [('DATM', 6.41, 'no_flooding', 4), ('TIDE', 1.17, 'no_flooding', 4), ('SPIK', 5.0, 'no_flooding', 4),
     ('REAL', 20.0, 'moderate', 4), ('FLSH', 7.0, 'no_flooding', 4), ('NREF', 9.0, 'minor', 4), ('SPRS', 4.0, 'no_flooding', 4),
     ('ALTN', 42.08, 'major', 4), ('FLSH2', 9.45, 'moderate', 4), ('SPKH', 16.63, 'no_flooding', 4)],
    [('ALTN', 42.08, 'major', 4)],  # NWPS repeats the last reading while the gauge is silent
    [('ALTN', 9.7, 'no_flooding', 8)],  # ...until it reports again, as PRST2 did, back at 9.7 ft
]
RECORDS = {'DATM': 36.5, 'TIDE': 5.04, 'SPIK': 21.1, 'REAL': 25.0, 'FLSH': 15.0, 'SPRS': 12.0, 'ALTN': 28.21,
           'FLSH2': 14.5, 'SPKH': 44.3}
MAJORS = {'TIDE': 4.5, 'REAL': 22.0, 'FLSH': 14.0, 'ALTN': 22.9, 'FLSH2': 16.0}

tmp_pl = tempfile.mkdtemp(prefix='gen-crest-summary-plausible.')
try:
    prepo = os.path.join(tmp_pl, 'plausible')
    os.makedirs(os.path.join(prepo, 'data'))
    os.makedirs(os.path.join(prepo, 'scripts'))
    shutil.copy(GEN, os.path.join(prepo, 'scripts', 'gen-crest-summary.py'))
    shutil.copy(AOAREA, os.path.join(prepo, 'scripts', 'aoarea.py'))
    shutil.copy(STAGEPLAUS, os.path.join(prepo, 'scripts', 'stageplaus.py'))
    subprocess.run(('git', 'init', '-q', prepo), check=True, capture_output=True)
    with open(os.path.join(prepo, 'data', 'records.json'), 'w', encoding='utf-8') as f:
        json.dump({'records': {k: {'record_ft': v, 'record_date': '1908-05-01'} for k, v in RECORDS.items()}}, f)
    with open(os.path.join(prepo, 'data', 'gauge-meta.json'), 'w', encoding='utf-8') as f:
        json.dump({k: {'action': v * 0.6, 'minor': v * 0.7, 'moderate': v * 0.85, 'major': v} for k, v in MAJORS.items()}, f)
    first = datetime(2026, 9, 30, 23, 0, 0, tzinfo=timezone.utc)
    for n, rows in enumerate(PLAUS_TIMELINE):
        stamp = iso(first + timedelta(minutes=30 * n))
        caprows = [row(lid, v, c, iso(first + timedelta(minutes=(60 if lid in ('SPRS', 'FLSH2', 'SPKH') else 30) * k))) for lid, v, c, k in rows]
        if n >= 5:  # only the silent gauge reports in the last two snapshots
            caprows = [r for r in caprows if r['lid'] == 'ALTN']
        with open(os.path.join(prepo, 'data', 'event.json'), 'w', encoding='utf-8') as f:
            json.dump({'name': 'fixture', 'event': '', 'gaugeBbox': {'xmin': -98.0, 'ymin': 27.5, 'xmax': -93.4, 'ymax': 31.0}}, f)
        with open(os.path.join(prepo, 'data', 'gauges-capture.json'), 'w', encoding='utf-8') as f:
            json.dump({'generated': stamp, 'gauges': caprows}, f)
        git(prepo, 'add', 'data/event.json', 'data/gauges-capture.json')
        git(prepo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'p%d' % n)
    rp = run_gen(prepo)
    check('PLAUSIBLE · the run exits 0 and reports what it voided', rp.returncode == 0
          and 'published as no reading: 13 snapshot readings at ALTNx4 DATMx2 SPIKx1 SPKHx1 SPRSx2 TIDEx3' in rp.stdout, rp.stdout[-600:] + rp.stderr[-400:])
    doc = summary(prepo)
    peaks = {g['lid']: g for g in doc['gauges']}
    check('PLAUSIBLE · MUTATION a x100 datum shift (634, 638 ft on a 36.5 ft record) is no crest, however consistent',
          'DATM' not in peaks, str(peaks.get('DATM')))
    check('PLAUSIBLE · a tide gauge whose single readings jump 1.58 -> 9.89 -> 25.49 -> 1.17 ft is no crest',
          'TIDE' not in peaks, str(peaks.get('TIDE')))
    # 2026-10-26 PRST2 Rio Grande at Presidio: 9.7 / 40.62 / 9.68 / 35.83 / 42.08 (then repeated), NWPS's
    # own observed series never above 20 ft; the summary published 42.08 ft major, record exceeded
    check('PLAUSIBLE · MUTATION a series alternating 9.7 and 35-42 ft is no crest: no high reading is sustained',
          'ALTN' not in peaks, str(peaks.get('ALTN')))
    check('PLAUSIBLE · a one-hour 5 -> 32 -> 5 ft spike claims no record', 'SPIK' not in peaks, str(peaks.get('SPIK')))
    real = peaks.get('REAL', {})
    check('PLAUSIBLE · a real record crest on a continuous hydrograph still publishes, record exceeded',
          real.get('peak') == 27.5 and real.get('record', {}).get('exceeded') is True, str(real))
    check('PLAUSIBLE · a flash rise that doubles in an hour keeps its record, its next reading confirms it',
          peaks.get('FLSH', {}).get('peak') == 17.0, str(peaks.get('FLSH')))
    # 2026-08-23 BAMT2 Elm Creek at Ballinger, hourly: 3.36 / 7.15 / 17.35 / 10.3 / 9.45, a flash crest
    check('PLAUSIBLE · an hourly flash crest whose recession holds above half of it keeps its record',
          peaks.get('FLSH2', {}).get('peak') == 17.35 and peaks['FLSH2'].get('record', {}).get('exceeded') is True, str(peaks.get('FLSH2')))
    # 2026-07-24 BWRT2, hourly: 16.28 / 48.47 / 16.53, while NWPS's own series read ~16.7 ft
    check('PLAUSIBLE · an hourly spike that falls straight back is no crest', 'SPKH' not in peaks, str(peaks.get('SPKH')))
    check('PLAUSIBLE · a lone record whose next reading, 2 h on, is under half of it is contradicted',
          'SPRS' not in peaks, str(peaks.get('SPRS')))
    check('PLAUSIBLE · a gauge with no record or flood stage is not judged by a bound it does not have',
          peaks.get('NREF', {}).get('peak') == 60.0, str(peaks.get('NREF')))
    check('PLAUSIBLE · the summary counts what it voided', doc.get('implausible_readings') == 13, str(doc.get('implausible_readings')))
    check('LABEL · with no configured event name, the label is the months the window spans',
          doc.get('event') == 'September to October 2026', str(doc.get('event')))
except Bail as e:
    check(str(e), False)
finally:
    shutil.rmtree(tmp_pl, ignore_errors=True)

print('---')
if FAILS:
    print('%d FAILURE(S)' % FAILS)
    sys.exit(1)
print('ALL PASS')
