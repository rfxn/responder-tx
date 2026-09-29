#!/usr/bin/env python3
"""tests/stage-bounds.test.py — an impossible gauge stage is no reading, in every generator.

NWPS published SEIO2 at 10000030 ft and SGET2 at 10000000 ft, both with floodCategory "major".
Each consumer below turned that into a published claim: the display snapshot the client and the
push worker read, the feed and calendar, the CalTopo/KML export, and the crest-of-record file.
The capture file is retention and must keep the raw row. See INTERNAL-NOTES.md "Impossible gauge
stages". Every check calls the shipped function; tests/stage-bounds.test.js holds the Python
copies of stage_ok() to the client's stageOk(). Run: python3 tests/stage-bounds.test.py"""
import datetime
import importlib.util
import io
import json
import os
import shutil
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, '..', 'scripts')

FAILS = 0


def check(name, ok, detail=''):
    global FAILS
    print('%s: %s%s' % ('PASS' if ok else 'FAIL', name, (' · ' + detail) if (detail and not ok) else ''))
    if not ok:
        FAILS += 1


def load(script, root):
    prev = os.environ.get('RESPONDER_ROOT')
    os.environ['RESPONDER_ROOT'] = root
    try:
        spec = importlib.util.spec_from_file_location(script.replace('-', '_')[:-3], os.path.join(SCRIPTS, script))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    finally:
        if prev is None:
            os.environ.pop('RESPONDER_ROOT', None)
        else:
            os.environ['RESPONDER_ROOT'] = prev


def gauge(lid, primary, cat, fprimary=-999, fcat='fcst_not_current', fwhen='0001-01-01T00:00:00Z'):
    return {'lid': lid, 'name': '%s test river' % lid, 'latitude': 30.1, 'longitude': -97.9,
            'status': {'observed': {'primary': primary, 'primaryUnit': 'ft', 'secondary': -999,
                                    'floodCategory': cat, 'validTime': '2026-09-03T01:00:00Z'},
                       'forecast': {'primary': fprimary, 'primaryUnit': 'ft', 'floodCategory': fcat,
                                    'validTime': fwhen}}}


tmp = tempfile.mkdtemp(prefix='stage-bounds-test.')
try:
    os.makedirs(os.path.join(tmp, 'data'))
    with open(os.path.join(tmp, 'data', 'event.json'), 'w', encoding='utf-8') as f:
        json.dump({'captureBbox': {'xmin': -107, 'ymin': 25, 'xmax': -93, 'ymax': 37},
                   'gaugeBbox': {'xmin': -107, 'ymin': 25, 'xmax': -93, 'ymax': 37}}, f)

    # --- fetch-snapshot: the capture keeps the raw row, the published display copy does not ---
    fs = load('fetch-snapshot.py', tmp)
    upstream = [gauge('SEIO2', 10000030, 'major'), gauge('SGET2', 10000000, 'major'),
                gauge('ABIN5', 6200.4, 'not_defined'), gauge('OOST2', -999, 'out_of_service'),
                gauge('STALT2', -999, 'obs_not_current'), gauge('TLCN5', -696.32, 'not_defined'),
                gauge('FCBT2', 4.2, 'no_flooding', fprimary=10000000, fcat='major',
                      fwhen='2026-09-04T00:00:00Z')]
    upstream += [gauge('FILL%02d' % i, 3.0 + i, 'no_flooding') for i in range(25)]

    class Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    fs.urllib.request.urlopen = lambda req, timeout=None: Resp(json.dumps({'gauges': upstream}).encode())
    fs.main()
    with open(os.path.join(tmp, 'data', 'gauges-capture.json'), encoding='utf-8') as f:
        cap = {g['lid']: g['status'] for g in json.load(f)['gauges']}
    with open(os.path.join(tmp, 'data', 'gauges-snapshot.json'), encoding='utf-8') as f:
        shown = {g['lid']: g['status'] for g in json.load(f)['gauges']}
    check('E6 · the capture keeps the raw NWPS row, impossible value and all',
          cap['SEIO2']['observed']['primary'] == 10000030 and cap['SEIO2']['observed']['floodCategory'] == 'major')
    check('the display copy of a 10000030 ft "major" is NWPS\'s own no-current-reading shape',
          shown['SEIO2']['observed']['floodCategory'] == 'obs_not_current'
          and shown['SEIO2']['observed']['primary'] == -999, str(shown['SEIO2']['observed']))
    check('the display copy keeps the observation time it was sent with',
          shown['SGET2']['observed']['validTime'] == '2026-09-03T01:00:00Z')
    check('a -696 ft stage on a no-thresholds site is no reading either',
          shown['TLCN5']['observed']['floodCategory'] == 'obs_not_current', str(shown['TLCN5']))
    check('an impossible forecast crest is no forecast, while its real observation stands',
          shown['FCBT2']['forecast']['floodCategory'] == 'fcst_not_current'
          and shown['FCBT2']['observed'] == cap['FCBT2']['observed'], str(shown['FCBT2']))
    check('a reservoir elevation, an out-of-service site and a not-current site pass untouched',
          all(shown[k] == cap[k] for k in ('ABIN5', 'OOST2', 'STALT2')))
    check('no display row carries a stage outside the envelope with a flood category',
          not [k for k, s in shown.items() for part in ('observed', 'forecast')
               if s[part]['floodCategory'] in ('action', 'minor', 'moderate', 'major')
               and not -300 < s[part]['primary'] < 25000])

    # --- gen-feeds: no "observed 10000030 ft", no crest item off an impossible forecast ---------
    gf = load('gen-feeds.py', tmp)
    when = '2026-09-04T00:00:00Z'
    crests = gf.rising_crests({'gauges': [
        gauge('SEIO2', 10000030, 'major', fprimary=31.5, fcat='major', fwhen=when),
        gauge('FCBT2', 4.2, 'no_flooding', fprimary=10000000, fcat='major', fwhen=when),
        gauge('REALT2', 12.1, 'minor', fprimary=28.4, fcat='major', fwhen=when)]})
    by = {c['lid']: c for c in crests}
    check('a forecast crest of 10000000 ft publishes no crest item', 'FCBT2' not in by, str(by))
    check('a real forecast major crest over an unreadable observation still publishes, with no obs value',
          by.get('SEIO2', {}).get('obs') is None and by.get('SEIO2', {}).get('crest') == 31.5, str(by.get('SEIO2')))
    built = datetime.datetime(2026, 9, 3, 2, 0, tzinfo=datetime.timezone.utc)
    rss = gf.build_rss([], [], crests, [], built, 'Responder TX', 'desc')
    ics = gf.build_ics(crests, built)
    check('neither feed prints the impossible value', '10000030' not in rss + ics and '10000000' not in rss + ics)
    check('the feed says there is no current reading instead of inventing one',
          'No current observed reading' in rss and 'no current observed reading' in ics)
    check('a readable observation is still printed as before', 'Observed 12.1 ft (minor)' in rss)

    # --- gen-caltopo: the export draws no major marker off an impossible reading ---------------
    gc = load('gen-caltopo.py', tmp)
    feats = {m['key']: f['properties'] for _r, f, m in gc.build_gauges({'gauges': [
        gauge('SGET2', 10000000, 'major'), gauge('STALT2', -999, 'obs_not_current'),
        gauge('LAKET2', 681.2, 'minor')]})}
    check('the export marker for a 10000000 ft "major" is not major-coloured or titled',
          feats['SGET2']['marker-color'] == gc.CAT_NONE and 'MAJOR' not in feats['SGET2']['title'],
          str(feats['SGET2']))
    check('the export says "no reading" and claims no category, "no flooding" included',
          'Observed: no reading' in feats['SGET2']['description']
          and 'no flooding' not in feats['SGET2']['description'].lower()
          and 'no flooding' not in feats['STALT2']['description'].lower(), feats['SGET2']['description'])
    check('a reservoir elevation still exports as a real minor reading',
          'Observed: 681.2 ft (MINOR)' in feats['LAKET2']['description']
          and feats['LAKET2']['marker-color'] == gc.CAT_COLOR['minor'], feats['LAKET2']['description'])

    # --- gen-records: an impossible historic crest cannot become the record ---------------------
    gr = load('gen-records.py', tmp)
    now = datetime.datetime(2026, 9, 28, tzinfo=datetime.timezone.utc)
    best = gr.record_crest({'flood': {'crests': {'historic': [
        {'stage': 10000000, 'occurredTime': '2019-05-01T00:00:00Z'},
        {'stage': 36.5, 'occurredTime': '1908-05-01T00:00:00Z'}]}}}, now)
    check('an impossible historic crest is skipped and the real record kept', best == (36.5, '1908-05-01'), str(best))
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print('---')
if FAILS:
    print('%d FAILURE(S)' % FAILS)
    raise SystemExit(1)
print('ALL PASS')
