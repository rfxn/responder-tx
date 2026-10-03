#!/usr/bin/env python3
"""tests/gen-changes.test.py: the "What changed" generator, driven in process against fixture roots
on a fixed clock. Every source is a file the test writes; NWS is a stubbed fetch, never the network.
Run: python3 tests/gen-changes.test.py"""
import datetime
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
GEN = os.path.join(ROOT, 'scripts', 'gen-changes.py')
CYCLE_CHECK = os.path.join(ROOT, 'scripts', 'cycle-check.sh')
UTC = datetime.timezone.utc
BASE = datetime.datetime(2026, 10, 2, 12, 0, tzinfo=UTC)

FAILS = 0


def check(name, ok, detail=''):
    global FAILS
    print('%s: %s%s' % ('PASS' if ok else 'FAIL', name, '' if ok else ' -> %s' % (detail,)))
    if not ok:
        FAILS += 1


os.environ.pop('RESPONDER_ROOT', None)
spec = importlib.util.spec_from_file_location('gen_changes_under_test', GEN)
gc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gc)


def iso(dt):
    return dt.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%SZ')


def cyc(k, minutes=0):
    """The k-th 15-minute cycle, as an ISO stamp."""
    return iso(BASE + datetime.timedelta(minutes=15 * k + minutes))


def gauge(lid, ft, cat, vt, lat=29.5, lon=-98.5):
    return {'lid': lid, 'name': 'Test River at %s' % lid, 'latitude': lat, 'longitude': lon,
            'status': {'observed': {'primary': ft, 'primaryUnit': 'ft', 'floodCategory': cat, 'validTime': vt},
                       'forecast': {'primary': -999, 'floodCategory': 'fcst_not_current',
                                    'validTime': '0001-01-01T00:00:00Z'}}}


def road(route, frm, cond='Flooding', desc='Water over roadway', start=None, end=None, v=(29.5, -98.5)):
    return {'id': 1, 'cond': cond, 'route': route, 'from': frm, 'to': frm + ' end', 'desc': desc,
            'start': start or cyc(-40), 'end': end, 'v': list(v)}


class Fx:
    """A fixture repo: data/ holds every source the generator reads, each written with a stamp."""

    def __init__(self, meta=None, gauge_bbox=None, git=False):
        self.root = tempfile.mkdtemp(prefix='gen-changes-test.')
        os.mkdir(os.path.join(self.root, 'data'))
        box = {'xmin': -106.65, 'ymin': 25.83, 'xmax': -93.4, 'ymax': 36.5}
        self.put('event.json', {'gaugeBbox': gauge_bbox or box, 'captureBbox': box})
        self.put('gauge-meta.json', meta or {})
        self.gauges(0, [])
        self.roads(0, [])
        self.crossings(0, [])
        self.risk(0, [])
        self.shelters(0, [])
        self.alerts = []
        self.nws_reason = None
        if git:
            subprocess.run(['git', 'init', '-q', self.root], check=True)

    def put(self, name, doc):
        with open(os.path.join(self.root, 'data', name), 'w', encoding='utf-8') as f:
            f.write(doc if isinstance(doc, str) else json.dumps(doc))

    def read(self, name):
        with open(os.path.join(self.root, 'data', name), encoding='utf-8') as f:
            return json.load(f)

    def gauges(self, k, rows):
        self.put('gauges-capture.json', {'generated': cyc(k), 'bbox': [], 'gauges': rows})

    def roads(self, k, rows):
        self.put('roads-capture.json', {'generated': cyc(k), 'roads': rows})

    def crossings(self, k, rows):
        self.put('crossing-status.json', {'generated': cyc(k), 'crossings': rows})

    def risk(self, k, rows, status='ok', captured=None):
        self.put('transtar-flood.json', {'generated': cyc(k), 'warnings': rows, 'sources': [
            {'key': 'transtar', 'status': status, 'captured': captured or cyc(k, -1), 'count': len(rows)}]})

    def shelters(self, k, rows):
        self.put('shelters-live.json', {'generated': cyc(k), 'shelters': rows})

    def fetch(self, url):
        return ([] if self.nws_reason else self.alerts), self.nws_reason

    def run(self, k):
        r = gc.run(root=self.root, now=BASE + datetime.timedelta(minutes=15 * k + 2), fetch=self.fetch)
        return r[0], r[1], r[2]

    def close(self):
        shutil.rmtree(self.root, ignore_errors=True)


def kinds(events, k=None, act=None):
    return [e for e in events if (k is None or e['k'] == k) and (act is None or e.get('act') == act)]


def new_since(payload, k):
    """Events this run added: seen at or after cycle k."""
    return [e for e in payload['events'] if e['seen'] >= cyc(k, -1)]


# ---- first run, corrupt state, malformed state ------------------------------------------------
fx = Fx()
fx.gauges(1, [gauge('AAAT2', 14.0, 'minor', cyc(1, -5))])
fx.roads(1, [road('US0090', 'A')])
fx.crossings(1, [{'id': '7', 'name': 'Low Water 7', 'status': 'closed', 'lat': 30.1, 'lon': -97.7,
                  'changed': cyc(0)}])
p, notes, added = fx.run(1)
check('first run: every source baselines and nothing is emitted, even a gauge already in flood',
      added == 0 and p['events'] == [] and all(s['since'] for s in p['sources'].values()), (added, notes))
p, notes, added = fx.run(1)
check('an immediate re-run with nothing refreshed emits nothing', added == 0 and p['events'] == [], notes)
fx.put('changes-state.json', '{"v": 1, "sources": [truncated')
fx.gauges(2, [gauge('AAAT2', 9.0, 'no_flooding', cyc(2, -5))])
fx.roads(2, [])
p, notes, added = fx.run(2)
check('a corrupt state file re-baselines every source and emits nothing (not a mass clear)',
      added == 0 and any('unreadable' in n for n in notes), notes)
st = fx.read('changes-state.json')
st['sources']['roads']['items'] = ['not', 'a', 'dict']
fx.put('changes-state.json', st)
fx.roads(3, [road('IH0010', 'B')])
p, notes, added = fx.run(3)
check('a malformed per-source state re-baselines that source alone, silently',
      added == 0 and 'roads' in fx.read('changes-state.json')['sources'], notes)
fx.close()

# ---- gauges: flood stage with hysteresis, confirmation, crests --------------------------------
META = {'G1': {'minor': 13.0, 'moderate': 16.0, 'major': 20.0}}


def gauge_run(series, meta=META, lid='G1'):
    """One reading per cycle; series = [(ft, cat)] or [(ft, cat, cycle)] to skip cycles. Returns all events."""
    fx = Fx(meta=meta)
    out, k = [], 0
    for r in series:
        k = r[2] if len(r) > 2 else k + 1
        fx.gauges(k, [gauge(lid, r[0], r[1], cyc(k, -5))])
        p, _, _ = fx.run(k)
        out = p['events']
    fx.close()
    return sorted(out, key=lambda e: e['t'])


ev = gauge_run([(12.0, 'no_flooding'), (13.4, 'minor'), (13.9, 'minor'), (14.6, 'minor'), (15.1, 'minor'),
                (14.7, 'minor'), (14.6, 'minor'), (14.2, 'minor'), (13.9, 'minor')])
fl = kinds(ev, 'flood')
cr = kinds(ev, 'crest')
check('entering flood needs two readings and is stamped at the FIRST one, the source\'s own time',
      len(fl) == 1 and fl[0]['from'] == 'none' and fl[0]['to'] == 'minor' and fl[0]['t'] == cyc(2, -5)
      and fl[0]['tk'] == 's' and fl[0]['ft'] == 13.4 and fl[0]['seen'] == cyc(3), fl)
check('a crest is confirmed by two readings at least 0.3 ft under the peak, stamped at the peak',
      len(cr) == 1 and cr[0]['ft'] == 15.1 and cr[0]['t'] == cyc(5, -5) and cr[0]['cat'] == 'minor'
      and not cr[0].get('unc') and cr[0]['seen'] == cyc(7), cr)
check('the crest is not declared on the first lower reading or on a dip inside the noise band',
      all(e['seen'] != cyc(6) for e in cr), cr)

ev = gauge_run([(12.0, 'no_flooding'), (13.4, 'minor'), (13.9, 'minor'), (15.0, 'minor'), (14.6, 'minor'),
                (15.4, 'minor'), (15.2, 'minor'), (15.3, 'minor')])
check('NOISE · a single dip then a new high is not a crest; the peak moves instead',
      kinds(ev, 'crest') == [], kinds(ev, 'crest'))

ev = gauge_run([(12.0, 'no_flooding'), (13.6, 'minor'), (12.4, 'no_flooding'), (12.2, 'no_flooding'),
                (12.1, 'no_flooding')])
check('NOISE · one reading in flood is neither a flood-stage entry nor a crest',
      kinds(ev, 'flood') == [] and kinds(ev, 'crest') == [], ev)

ev = gauge_run([(15.0, 'minor'), (14.6, 'minor'), (14.2, 'minor'), (13.8, 'minor')])
check('a gauge already in flood and falling at baseline never gets a crest it was not seen to reach',
      kinds(ev, 'crest') == [], kinds(ev, 'crest'))

osc = [(12.0, 'no_flooding'), (13.1, 'minor'), (13.2, 'minor')]
osc += [(12.9, 'no_flooding'), (13.05, 'minor'), (12.85, 'no_flooding'), (13.02, 'minor')] * 3
ev = gauge_run(osc)
check('HYSTERESIS · a stage oscillating inside 0.2 ft of flood stage enters once and never flaps out',
      [(e['from'], e['to']) for e in kinds(ev, 'flood')] == [('none', 'minor')], kinds(ev, 'flood'))
ev = gauge_run(osc + [(12.7, 'no_flooding'), (12.6, 'no_flooding')])
check('HYSTERESIS · a fall clearly below flood stage still leaves, stamped at its first reading',
      [(e['from'], e['to'], e['t']) for e in kinds(ev, 'flood')][-1:] == [('minor', 'none', cyc(16, -5))],
      kinds(ev, 'flood'))
ev = gauge_run(osc, meta={})
check('HYSTERESIS · with no published thresholds the lowest in-flood stage stands in for flood stage',
      [(e['from'], e['to']) for e in kinds(ev, 'flood')] == [('none', 'minor')], kinds(ev, 'flood'))

ev = gauge_run([(12.0, 'no_flooding'), (16.5, 'moderate'), (17.0, 'moderate'), (20.6, 'major'), (21.0, 'major'),
                (19.0, 'moderate')] + [(18.0, 'moderate')] * 13)
steps = [(e['from'], e['to']) for e in kinds(ev, 'flood')]
check('categories: rises skip straight to the confirmed band and a fall is reported per band',
      steps == [('none', 'moderate'), ('moderate', 'major'), ('major', 'moderate')], steps)

ev = gauge_run([(5.0, 'no_flooding'), (27.0, 'major'), (27.8, 'major'), (15.0, 'action'), (5.8, 'no_flooding'),
                (7.3, 'no_flooding'), (24.2, 'major'), (27.9, 'major')])
steps = [(e['from'], e['to']) for e in kinds(ev, 'flood')]
check('FAST ATTACK, SLOW RELEASE · a fall that reverses a rise inside 3h is held, so a flapping sensor '
      'reads one entry, not four transitions', steps == [('none', 'major')], steps)
ev = gauge_run([(5.0, 'no_flooding'), (27.0, 'major'), (27.8, 'major')] + [(5.0, 'no_flooding')] * 14)
steps = [(e['from'], e['to'], e['t']) for e in kinds(ev, 'flood')]
check('a held fall that persists past the hold is reported, stamped at its first reading',
      [s[:2] for s in steps] == [('none', 'major'), ('major', 'none')] and steps[1][2] == cyc(4, -5), steps)

ev = gauge_run([(12.0, 'no_flooding'), (12.1, 'no_flooding'), (14.0, 'minor', 15), (14.5, 'minor', 16),
                (14.1, 'minor', 17), (13.9, 'minor', 18)])
fl = kinds(ev, 'flood')
check('GAP · a change seen after a reading gap names the reading before it, so the window is honest',
      len(fl) == 1 and fl[0].get('after') == cyc(2, -5), fl)
ev = gauge_run([(12.0, 'no_flooding'), (13.4, 'minor'), (13.9, 'minor'), (15.1, 'minor'),
                (14.7, 'minor', 25), (14.6, 'minor', 26)])
cr = kinds(ev, 'crest')
check('GAP · a crest with no reading for hours after the peak is flagged as uncertain',
      len(cr) == 1 and cr[0].get('unc') is True, cr)
ev = gauge_run([(12.0, 'no_flooding'), (13.4, 'minor'), (13.9, 'minor'), (15.1, 'minor'), (14.7, 'minor'),
                (14.6, 'minor'), (13.0, 'minor'), (16.4, 'moderate'), (16.8, 'moderate'), (16.2, 'moderate'),
                (16.1, 'moderate')])
check('a second rise of a foot or more after a crest is a second crest',
      [e['ft'] for e in kinds(ev, 'crest')] == [15.1, 16.8], kinds(ev, 'crest'))

fx = Fx(meta=META)
fx.gauges(1, [gauge('G1', 12.0, 'no_flooding', cyc(1, -5))])
fx.run(1)
for k in (2, 3, 4):
    fx.gauges(k, [gauge('G1', 14.0 + k, 'minor', cyc(1, -5))])
    p, _, _ = fx.run(k)
check('a reading whose validTime did not advance is not a new reading', p['events'] == [], p['events'])
fx.gauges(5, [gauge('G1', -999, 'out_of_service', '0001-01-01T00:00:00Z')])
fx.run(5)
fx.gauges(6, [gauge('G1', 10000030, 'major', cyc(6, -5))])
p, _, _ = fx.run(6)
check('E1 · an out-of-service or impossible reading moves nothing (no flood, no recovery)', p['events'] == [],
      p['events'])
fx.close()

# ---- roads: the E1 stale-source cases, recovery after a gap, edits, posted ends ---------------
fx = Fx()
fx.roads(1, [road('US0090', 'A', start=cyc(-20)), road('FM1930', 'B', start=cyc(-10), v=(27.7, -98.1))])
fx.run(1)
fx.put('roads-capture.json', '{"generated": "2026-10-02T12:30:00Z", "roads": [')
fx.run(2)
p, notes, _ = fx.run(3)
check('E1 · an unreadable roads capture is carried: no closure becomes "cleared"',
      kinds(p['events'], 'road') == [] and any('roads' in n and 'unreadable' in n for n in notes), notes)
fx.roads(1, [])
fx.run(4)
p, notes, _ = fx.run(5)
check('E1 · a roads capture that did not refresh (same or older stamp) is never diffed: an emptied '
      'copy under an old stamp clears nothing', kinds(p['events'], 'road') == []
      and any('roads: not refreshed' in n for n in notes), notes)
fx.put('roads-capture.json', {'generated': cyc(6), 'status': 'failed', 'roads': []})
fx.run(6)
fx.put('roads-capture.json', {'generated': cyc(7), 'status': 'failed', 'roads': []})
p, notes, _ = fx.run(7)
check('E1 · a capture that declares a failed read publishes no clears, whatever its stamp',
      kinds(p['events'], 'road') == [], notes)
st = fx.read('changes-state.json')['sources']['roads']
check('E1 · the stale source keeps its previous state and stamp untouched', st['at'] == cyc(1)
      and sorted(st['items']) == ['FM1930|B|B end', 'US0090|A|A end'], st)
fx.roads(20, [road('US0090', 'A', start=cyc(-20)), road('SH0016', 'C', start=cyc(12))])
p, _, _ = fx.run(20)
ev = new_since(p, 20)
check('RECOVERY · a closure posted during the gap is stamped with TxDOT\'s own start time',
      [(e['act'], e['route'], e['t'], e['tk']) for e in ev] == [('new', 'SH0016', cyc(12), 's')], ev)
check('RECOVERY · a closure missing on the first fresh read is pending, not cleared yet',
      kinds(ev, 'road', 'clear') == [], ev)
fx.roads(21, [road('US0090', 'A', start=cyc(-20)), road('SH0016', 'C', start=cyc(12))])
p, _, _ = fx.run(21)
cl = kinds(new_since(p, 21), 'road', 'clear')
check('RECOVERY · a closure that vanished during the gap is "no longer listed as of" the recovery read, '
      'with the last time it was listed, never stamped as clearing at recovery time',
      len(cl) == 1 and cl[0]['route'] == 'FM1930' and cl[0]['tk'] == 'd' and cl[0]['t'] == cyc(20)
      and cl[0]['after'] == cyc(1) and cl[0]['how'] == 'gone', cl)
fx.roads(22, [road('US0090', 'A', start=cyc(-20)), road('SH0016', 'C', start=cyc(12), end=cyc(23, 5))])
fx.run(22)
fx.roads(24, [road('US0090', 'A', start=cyc(-20))])
fx.run(24)
fx.roads(25, [road('US0090', 'A', start=cyc(-20))])
p, _, _ = fx.run(25)
cl = kinds(new_since(p, 24), 'road', 'clear')
check('a closure that leaves inside its posted end time is stamped at that end time, as the source\'s',
      len(cl) == 1 and cl[0]['t'] == cyc(23, 5) and cl[0]['tk'] == 's' and cl[0]['how'] == 'end', cl)
fx.roads(26, [road('US0090', 'A2', start=cyc(26), v=(29.502, -98.5))])
fx.run(26)
fx.roads(27, [road('US0090', 'A2', start=cyc(26), v=(29.502, -98.5))])
p, _, _ = fx.run(27)
check('a closure TxDOT re-entered with edited limits on the same route nearby is not reported clear',
      kinds(new_since(p, 26), 'road', 'clear') == [], kinds(new_since(p, 26), 'road'))
fx.roads(28, [road('US0090', 'A2', start=cyc(26), v=(29.502, -98.5)),
              road('FM0001', 'Z', cond='Closure', desc='Crash', start=cyc(27))])
p, _, _ = fx.run(28)
check('a non-flood closure is tracked but never reported', kinds(new_since(p, 28), 'road') == [],
      new_since(p, 28))
fx.roads(29, [road('US0090', 'A2', start=cyc(26), v=(29.502, -98.5)),
              road('FM0001', 'Z', cond='Flooding', desc='High water', start=cyc(27))])
p, _, _ = fx.run(29)
ev = kinds(new_since(p, 29), 'road', 'new')
check('a closure re-coded to flooding is reported then, at detection time',
      [(e['route'], e['tk'], e['t']) for e in ev] == [('FM0001', 'd', cyc(29))], ev)
fx.roads(30, [road('FM0002', 'Q', start=cyc(40))])
p, _, _ = fx.run(30)
ev = kinds(new_since(p, 30), 'road', 'new')
check('a start time later than the read that reported it is never used as the event time',
      [(e['tk'], e['t']) for e in ev] == [('d', cyc(30))], ev)
fx.close()

# ---- the other list sources: crossings, TranStar, shelters ------------------------------------
fx = Fx()
fx.crossings(1, [{'id': '7', 'name': 'Low Water 7', 'status': 'caution', 'lat': 30.1, 'lon': -97.7,
                  'changed': cyc(0)}])
fx.run(1)
fx.crossings(2, [{'id': '7', 'name': 'Low Water 7', 'status': 'closed', 'lat': 30.1, 'lon': -97.7,
                  'changed': cyc(1, 7)},
                 {'id': '9', 'name': 'Low Water 9', 'status': 'closed', 'lat': 30.2, 'lon': -97.8,
                  'changed': cyc(1, 10)}])
p, _, _ = fx.run(2)
ev = sorted(new_since(p, 2), key=lambda e: e['key'])
check('crossings: a status change and a new closure carry the jurisdiction\'s own change stamp',
      [(e['key'], e['act'], e['status'], e['t'], e['tk']) for e in ev]
      == [('7', 'status', 'closed', cyc(1, 7), 's'), ('9', 'new', 'closed', cyc(1, 10), 's')], ev)
fx.crossings(3, [])
fx.run(3)
fx.crossings(4, [])
p, _, _ = fx.run(4)
ev = kinds(new_since(p, 3), 'xing', 'clear')
check('crossings: a row that leaves the list is reported at detection time, with when it was last listed',
      sorted((e['key'], e['tk'], e['t'], e['after']) for e in ev)
      == [('7', 'd', cyc(3), cyc(2)), ('9', 'd', cyc(3), cyc(2))], ev)
fx.close()

fx = Fx()
W = [{'id': 'transtar:1', 'name': 'Carpenters Bayou', 'lat': 29.8, 'lon': -95.1},
     {'id': 'transtar:2', 'name': 'Langham Creek', 'lat': 29.9, 'lon': -95.7}]
fx.risk(1, W)
fx.run(1)
for k in (2, 3, 4, 5, 6):
    fx.risk(k, [], status='failed', captured=None)
    p, notes, _ = fx.run(k)
check('E1 · a failed TranStar read (empty list, fresh stamp) clears nothing however long it lasts',
      kinds(p['events'], 'risk') == [] and any('roadrisk' in n and 'failed' in n for n in notes), notes)
fx.risk(7, W[:1], status='carried')
p, _, _ = fx.run(7)
check('E1 · a carried TranStar read is not fresh either', kinds(p['events'], 'risk') == [], p['events'])
fx.risk(8, [], captured=cyc(-4))
fx.run(8)
fx.risk(9, [], captured=cyc(-3))
p, _, _ = fx.run(9)
check('E1 · an ok read whose upstream capture is hours old cannot vouch for an all-clear',
      kinds(p['events'], 'risk') == [], p['events'])
fx.risk(10, W[:1])
fx.run(10)
fx.risk(11, W[:1])
fx.run(11)
fx.risk(12, W[:1])
p, _, _ = fx.run(12)
check('TranStar: a warning missing for under an hour is not cleared (its sensors drop and return)',
      kinds(p['events'], 'risk') == [], p['events'])
for k in (13, 14, 15, 16):
    fx.risk(k, W[:1])
    p, _, _ = fx.run(k)
ev = kinds(p['events'], 'risk', 'clear')
check('TranStar: a warning gone for an hour is reported as no longer flagged, at detection time',
      [(e['key'], e['t'], e['tk']) for e in ev] == [('transtar:2', cyc(10, -1), 'd')], ev)
fx.risk(17, W)
p, _, _ = fx.run(17)
check('TranStar: a new risk area is reported at detection time (the feed has no flag time)',
      [(e['key'], e['tk']) for e in kinds(new_since(p, 17), 'risk', 'new')] == [('transtar:2', 'd')],
      new_since(p, 17))
fx.close()

SH = [{'name': 'Dunbar Gym', 'address': 'x', 'lat': 30.0, 'lon': -97.0, 'status': 'OPEN'},
      {'name': 'Far West Center', 'address': 'y', 'lat': 31.8, 'lon': -106.4, 'status': 'OPEN'}]
fx = Fx()
fx.shelters(1, SH)
fx.run(1)
fx.put('event.json', {'gaugeBbox': {'xmin': -99.0, 'ymin': 29.0, 'xmax': -96.0, 'ymax': 31.0},
                      'captureBbox': {'xmin': -106.65, 'ymin': 25.83, 'xmax': -93.4, 'ymax': 36.5}})
fx.shelters(2, SH[:1])
fx.run(2)
fx.shelters(3, SH[:1])
p, _, _ = fx.run(3)
check('E6 · an AO narrowing that drops a shelter from the query is not a shelter closing',
      kinds(p['events'], 'shelter') == [], p['events'])
fx.put('event.json', {'gaugeBbox': {'xmin': -106.65, 'ymin': 25.83, 'xmax': -93.4, 'ymax': 36.5},
                      'captureBbox': {'xmin': -106.65, 'ymin': 25.83, 'xmax': -93.4, 'ymax': 36.5}})
fx.shelters(4, SH)
p, _, _ = fx.run(4)
check('E6 · widening the AO back does not announce the shelters it brings into scope',
      kinds(p['events'], 'shelter') == [], p['events'])
fx.shelters(5, SH + [{'name': 'Kyle Rec Center', 'lat': 30.0, 'lon': -97.8, 'status': 'OPEN'}])
fx.run(5)
fx.shelters(6, [dict(SH[0], status='FULL')] + SH[1:] + [{'name': 'Kyle Rec Center', 'lat': 30.0, 'lon': -97.8,
                                                         'status': 'OPEN'}])
p, _, _ = fx.run(6)
ev = sorted(kinds(p['events'], 'shelter'), key=lambda e: e['name'])
check('shelters: an opening and a status change are reported at detection time',
      [(e['name'], e['act'], e['status'], e['tk']) for e in ev]
      == [('Dunbar Gym', 'status', 'FULL', 'd'), ('Kyle Rec Center', 'new', 'OPEN', 'd')], ev)
fx.close()

# ---- NWS warnings ------------------------------------------------------------------------------


def alert(event, office, phen, sig, etn, act, sent, ends=None, areas=('Bexar',), threat=None, desc='',
          headline=''):
    endcode = ends.strftime('%y%m%dT%H%MZ') if ends else '000000T0000Z'
    return {'id': 'https://api.weather.gov/alerts/%s-%s-%s' % (office, etn, act), 'properties': {
        'event': event, 'sent': iso(sent), 'ends': iso(ends) if ends else None, 'expires': iso(ends) if ends else None,
        'areaDesc': '; '.join('%s, TX' % a for a in areas), 'headline': headline or event,
        'description': desc, 'geocode': {'UGC': ['TXC%03d' % i for i, _ in enumerate(areas)]},
        'parameters': {'VTEC': ['/O.%s.%s.%s.%s.%04d.000000T0000Z-%s/' % (act, office, phen, sig, etn, endcode)],
                       'flashFloodDamageThreat': [threat] if threat else []}}}


T = lambda k, m=0: BASE + datetime.timedelta(minutes=15 * k + m)  # noqa: E731
FFW = alert('Flash Flood Warning', 'KEWX', 'FF', 'W', 90, 'NEW', T(1, 3), ends=T(12), areas=('Bexar', 'Comal'))
WATCH = alert('Flood Watch', 'KFWD', 'FA', 'A', 7, 'CON', T(-30), ends=T(60), areas=('Denton',))
fx = Fx()
fx.alerts = [WATCH]
fx.run(1)
fx.alerts = [WATCH, FFW, alert('Flood Advisory', 'KEWX', 'FA', 'Y', 220, 'NEW', T(1, 4), ends=T(9))]
p, _, _ = fx.run(2)
ev = new_since(p, 2)
check('warnings: a new warning is stamped at its NEW message\'s issuance time; advisories stay out',
      [(e['key'], e['act'], e['t'], e['tk'], e['ev'], e['sev'], e['wfo']) for e in ev]
      == [('KEWX.FF.W.0090', 'new', iso(T(1, 3)), 's', 'Flash Flood Warning', 'warning', 'EWX')], ev)
check('warnings: areas are named', ev and ev[0]['areas'] == ['Bexar', 'Comal'], ev)
EMERG = alert('Flash Flood Warning', 'KEWX', 'FF', 'W', 90, 'CON', T(2, 6), ends=T(12), areas=('Bexar', 'Comal'),
              threat='CATASTROPHIC', desc='...FLASH FLOOD EMERGENCY FOR SAN ANTONIO...')
fx.alerts = [WATCH, FFW, EMERG]
p, _, _ = fx.run(3)
ev = new_since(p, 3)
check('warnings: an upgrade to a flash flood emergency is stamped at the emergency message',
      [(e['act'], e['sev'], e['t'], e['tk']) for e in ev] == [('up', 'emergency', iso(T(2, 6)), 's')], ev)
fx.nws_reason = 'URLError: timed out'
for k in (4, 5, 6):
    p, notes, _ = fx.run(k)
check('E1 · an unreachable NWS ends nothing: the failed fetch is carried, not read as zero warnings',
      new_since(p, 4) == [] and any('warnings' in n and 'unreachable' in n for n in notes), notes)
fx.nws_reason = None
CAN = alert('Flash Flood Warning', 'KEWX', 'FF', 'W', 90, 'CAN', T(6, 9), ends=T(12), areas=('Bexar', 'Comal'))
fx.alerts = [WATCH, CAN]
p, _, _ = fx.run(7)
ev = new_since(p, 7)
check('warnings: a cancellation still listed is reported at once, at the CAN message\'s time',
      [(e['act'], e['how'], e['t'], e['tk']) for e in ev] == [('end', 'can', iso(T(6, 9)), 's')], ev)
fx.alerts = []
p, _, _ = fx.run(8)
check('warnings: a product missing once is pending, not ended', new_since(p, 8) == [], new_since(p, 8))
p, _, _ = fx.run(9)
ev = new_since(p, 9)
check('warnings: missing twice, before its end time, is "no longer in effect" at detection time',
      [(e['key'], e['how'], e['tk'], e['t'], e['after']) for e in ev]
      == [('KFWD.FA.A.0007', 'gone', 'd', iso(T(8, 2)), iso(T(7, 2)))], ev)
fx.alerts = [alert('Flood Watch', 'KFWD', 'FA', 'A', 7, 'EXT', T(9, 5), ends=T(60), areas=('Denton',))]
p, _, _ = fx.run(10)
ev = new_since(p, 10)
check('warnings: a product listed again after it was reported gone says so, it is not a new issuance',
      [(e['act'], e.get('again'), e['tk']) for e in ev] == [('new', True, 'd')], ev)
FLW = alert('Flood Warning', 'KEWX', 'FL', 'W', 52, 'NEW', T(10, 1), ends=T(11, 10), areas=('Guadalupe',))
fx.alerts = [fx.alerts[0], FLW]
fx.run(11)
fx.alerts = fx.alerts[:1]
p, _, _ = fx.run(12)
ev = new_since(p, 12)
check('warnings: a product that leaves after its stated end is "expired" at that end, the source\'s time',
      [(e['key'], e['how'], e['t'], e['tk']) for e in ev] == [('KEWX.FL.W.0052', 'exp', iso(T(11, 10)), 's')], ev)
fx.close()

FIX = json.load(open(os.path.join(HERE, 'fixtures', 'alerts-tx-flood-products.json'), encoding='utf-8'))
groups = gc.group_products(FIX['features'], datetime.datetime.fromisoformat(FIX['captured'].replace('Z', '+00:00')))
check('the real 2026-10-02 capture groups into its 12 warnings and watches, one per VTEC product, '
      'advisories and the wind warning left out',
      len(groups) == 12 and sorted({g['ev'] for g in groups.values()})
      == ['Flash Flood Warning', 'Flood Warning', 'Flood Watch']
      and groups['KFWD.FA.A.0007']['areas'][0] == 'Denton' and groups['KFWD.FA.A.0007']['more'] == 23
      and groups['KFWD.FF.W.0092']['sev'] == 'warning' and groups['KEWX.FL.W.0052'].get('pt')
      and not groups['KFWD.FA.A.0007'].get('pt'),
      sorted((k, g['ev']) for k, g in groups.items()))

# ---- retention, dedupe, the log ---------------------------------------------------------------
fx = Fx()
fx.run(1)
old = {'id': 'road:OLD:new:x', 'k': 'road', 'act': 'new', 'key': 'OLD', 't': cyc(-800), 'tk': 's',
       'seen': cyc(-800), 'src': 'txdot', 'route': 'US0001', 'cond': 'Flooding'}
young = dict(old, id='road:YOUNG:new:x', key='YOUNG', t=cyc(-600), seen=cyc(-600))
log = fx.read('changes.json')
log['events'] = [old, young]
fx.put('changes.json', log)
p, _, _ = fx.run(2)
check('RETENTION · events are kept 7 days by when they were seen, and pruned after',
      [e['key'] for e in p['events']] == ['YOUNG'], [e['key'] for e in p['events']])
fx.put('changes.json', '{"generated": "x", "events": [')
p, notes, _ = fx.run(3)
check('a corrupt log with no committed copy restarts empty and says so; it never blocks the cycle',
      p['events'] == [] and any('log restarts' in n for n in notes), notes)
fx.close()

fx = Fx(git=True)
fx.roads(1, [road('US0090', 'A')])
fx.run(1)
fx.roads(2, [road('US0090', 'A'), road('SH0071', 'B', start=cyc(1))])
p, _, _ = fx.run(2)
subprocess.run(['git', '-C', fx.root, 'add', 'data/changes.json'], check=True)
subprocess.run(['git', '-C', fx.root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'log'], check=True)
fx.put('changes.json', '{"broken')
p, notes, _ = fx.run(3)
check('a corrupt working log is recovered from the committed copy, events intact',
      [e['route'] for e in kinds(p['events'], 'road')] == ['SH0071'] and any('recovered' in n for n in notes), notes)
fx.close()

fx = Fx()
fx.roads(1, [road('US0090', 'A')])
fx.run(1)
before = fx.read('changes-state.json')
fx.roads(2, [road('US0090', 'A'), road('SH0071', 'B', start=cyc(1))])
fx.run(2)
fx.put('changes-state.json', before)
p, _, _ = fx.run(2)
check('a run killed between its two writes re-derives the same events without duplicating them',
      len(kinds(p['events'], 'road')) == 1, p['events'])
fx.close()

# ---- clock skew: an upstream clock ahead of ours must never reach the fatal gate --------------
fx = Fx(meta=META)
fx.risk(1, W, captured=cyc(1, 9))
fx.gauges(1, [gauge('G1', 12.0, 'no_flooding', cyc(1, -5))])
fx.run(1)
fx.risk(2, W[:1], captured=cyc(2, 10))
fx.gauges(2, [gauge('G1', 13.5, 'minor', cyc(2, 40))])
fx.run(2)
fx.risk(3, W[:1], captured=cyc(6, 10))
fx.gauges(3, [gauge('G1', 13.9, 'minor', cyc(3, -5))])
fx.run(3)
fx.risk(7, W[:1], captured=cyc(7, 10))
fx.gauges(7, [gauge('G1', 14.0, 'minor', cyc(7, -5))])
SKEW, _, _ = fx.run(7)
clear = kinds(SKEW['events'], 'risk', 'clear')
check('SKEW · a source stamp ahead of our clock is clamped: no event is seen after the run that '
      'published it', all(e['seen'] <= SKEW['generated'] for e in SKEW['events']) and len(clear) == 1
      and all(s['at'] is None or s['at'] <= SKEW['generated'] for s in SKEW['sources'].values()),
      (SKEW['generated'], clear, SKEW['sources']))
check('SKEW · a gauge reading dated after the capture that carried it is not a reading: the entry is '
      'stamped at the first valid reading', [(e['t'], e['ft']) for e in kinds(SKEW['events'], 'flood')]
      == [(cyc(3, -5), 13.9)], kinds(SKEW['events'], 'flood'))
fx.close()

fx = Fx()
fx.roads(1, [road('US0090', 'A')])
fx.run(1)
fx.roads(2, [road('US0090', 'A-edited')])
fx.run(2)
fx.roads(3, [road('US0090', 'A-edited')])
p, _, _ = fx.run(3)
check('a closure re-entered at the very same point (distance 0) is not reported clear',
      kinds(p['events'], 'road', 'clear') == [], kinds(p['events'], 'road'))
log = fx.read('changes.json')
log['events'].append(dict(log['events'][0], id='bad', seen=cyc(90), t=cyc(90)))
fx.put('changes.json', log)
p, _, _ = fx.run(4)
check('a line outside the publish bounds is dropped from the log, never handed to the gate',
      'bad' not in [e['id'] for e in p['events']] and len(p['events']) == 1, [e['id'] for e in p['events']])
fx.close()

# ---- the schema gate runs against the generator's own output ----------------------------------


def extract_schema_gate():
    source = open(CYCLE_CHECK, encoding='utf-8').read()
    m = re.search(r"check_schemas\(\) \{\n\s*python3 - <<'EOF'\n(.*?)\nEOF\n", source, re.S)
    assert m, 'check_schemas python block not found in scripts/cycle-check.sh'
    return m.group(1)


def run_schema_gate(payload):
    work = tempfile.mkdtemp(prefix='gen-changes-gate.')
    try:
        os.mkdir(os.path.join(work, 'data'))
        for name, obj in (('gauges-snapshot.json', {'generated': cyc(0), 'gauges': [{'lid': 'AAAT2', 'status': {}}]}),
                          ('requests.json', {'requests': []}), ('changes.json', payload)):
            with open(os.path.join(work, 'data', name), 'w', encoding='utf-8') as f:
                json.dump(obj, f)
        script = os.path.join(work, 'gate.py')
        with open(script, 'w', encoding='utf-8') as f:
            f.write(extract_schema_gate())
        env = dict(os.environ, RESPONDER_SCRIPTS_DIR=os.path.join(ROOT, 'scripts'))
        r = subprocess.run([sys.executable, script], cwd=work, capture_output=True, text=True, env=env)
        return r.returncode, (r.stdout or '') + (r.stderr or '')
    finally:
        shutil.rmtree(work, ignore_errors=True)


fx = Fx(meta=META)
fx.roads(1, [road('US0090', 'A')])
fx.alerts = [WATCH]
fx.gauges(1, [gauge('G1', 12.0, 'no_flooding', cyc(1, -5))])
fx.run(1)
fx.roads(2, [road('SH0071', 'B', start=cyc(1))])
fx.alerts = [WATCH, FFW]
fx.gauges(2, [gauge('G1', 13.5, 'minor', cyc(2, -5))])
fx.run(2)
fx.roads(3, [road('SH0071', 'B', start=cyc(1))])
fx.gauges(3, [gauge('G1', 13.9, 'minor', cyc(3, -5))])
GOOD, _, _ = fx.run(3)
fx.close()
rc, out = run_schema_gate(GOOD)
check('GATE · the generator\'s own output passes cycle-check (%d events, every kind it made)' % len(GOOD['events']),
      rc == 0 and {e['k'] for e in GOOD['events']} >= {'road', 'warn', 'flood'}, (rc, out[-300:]))
rc, out = run_schema_gate(SKEW)
check('GATE · output built from clock-skewed sources still passes cycle-check', rc == 0, (rc, out[-300:]))
E0 = GOOD['events'][0]
for label, payload in (
        ('an event dated after the run', dict(GOOD, events=[dict(E0, seen=cyc(99))])),
        ('an event past retention', dict(GOOD, events=[dict(E0, seen=cyc(-1000), t=cyc(-1000))])),
        ('a repeated id', dict(GOOD, events=[E0, E0])),
        ('an event with no time kind', dict(GOOD, events=[dict(E0, tk=None)])),
        ('an event with no source', dict(GOOD, events=[dict(E0, src='')])),
        ('a source stamp after generated', dict(GOOD, sources=dict(GOOD['sources'], roads={'src': 'txdot', 'at': cyc(99)}))),
        ('no events list', {k: v for k, v in GOOD.items() if k != 'events'})):
    rc, out = run_schema_gate(payload)
    check('GATE · rejects %s' % label, rc != 0 and 'changes.json' in out, (rc, out[-200:]))

# ---- review fixes -----------------------------------------------------------------------------

# an absence is not an end: a product with no end time needs an hour of absence before it is reported
OPEN = alert('Flood Warning', 'KEWX', 'FL', 'W', 53, 'NEW', T(0, 3), ends=None, areas=('Victoria',))
fx = Fx()
fx.alerts = [OPEN]
fx.run(1)
fx.alerts = []
early = []
for k in (2, 3, 4, 5):
    p, _, _ = fx.run(k)
    early += kinds(new_since(p, k), 'warn')
check('ABSENCE · an open-ended river warning missing from reads 15 to 45 minutes apart is not ended',
      early == [], early)
p, _, _ = fx.run(6)
ev = kinds(new_since(p, 6), 'warn')
check('ABSENCE · missing for an hour it is reported as gone at its first missing read, detection time',
      [(e['how'], e['tk'], e['t']) for e in ev] == [('gone', 'd', iso(T(2, 2)))], ev)
fx.close()

# the publish bounds are one module, applied by the generator and by the gate alike (E5)
try:
    sys.path.insert(0, os.path.join(ROOT, 'scripts'))
    import changescheck
except ImportError as e:
    changescheck = None
    check('BOUNDS · scripts/changescheck.py holds the publish bounds', False, e)
if changescheck is not None:
    NOW_B = BASE + datetime.timedelta(minutes=30)
    VALID = {'id': 'p1', 'k': 'road', 'act': 'new', 'key': 'US0090|A|B', 't': cyc(1), 'tk': 's', 'seen': cyc(2),
             'src': 'txdot', 'route': 'US0090', 'cond': 'Flooding'}
    PROBES = [
        ('a valid road line', VALID),
        ('a valid crest', dict(VALID, k='crest', lid='G1', key=None, act=None)),
        ('an unknown kind', dict(VALID, k='tornado')),
        ('no source', dict(VALID, src='')),
        ('an odd time kind', dict(VALID, tk='x')),
        ('an event time 7 minutes after it was seen', dict(VALID, t=cyc(2, 7))),
        ('an event time 12 minutes after it was seen', dict(VALID, t=cyc(2, 12))),
        ('seen after the run', dict(VALID, seen=cyc(3))),
        ('a gauge kind with no lid', dict(VALID, k='flood', key=None, act=None)),
        ('a list kind with no key', dict(VALID, key=None)),
        ('seen just inside the retention slack', dict(VALID, t=cyc(-675), seen=cyc(-675))),
        ('an unreadable time', dict(VALID, t='yesterday')),
    ]
    for label, e in PROBES:
        e = {k: v for k, v in e.items() if v is not None}
        payload = {'generated': iso(NOW_B), 'retainDays': 7, 'since': None,
                   'sources': {'roads': {'src': 'txdot', 'at': cyc(2)}}, 'events': [e]}
        rc, out = run_schema_gate(payload)
        check('BOUNDS · the generator and the gate agree on %s' % label,
              gc.publishable(e, NOW_B) == (rc == 0), (gc.publishable(e, NOW_B), rc, out[-160:]))

# a single glitch reading can be a peak, never a corroborated one
ev = gauge_run([(12.0, 'no_flooding'), (13.5, 'minor'), (13.6, 'minor'), (13.4, 'minor'), (45.0, 'major'),
                (13.5, 'minor'), (13.4, 'minor')])
cr = kinds(ev, 'crest')
check('GLITCH · an uncorroborated peak is uncertain and never escalates the category it was confirmed at',
      len(cr) == 1 and cr[0].get('unc') is True and cr[0]['cat'] == 'minor', cr)
check('GLITCH · a single reading in a higher band is not a band change', kinds(ev, 'flood')
      and [(e['from'], e['to']) for e in kinds(ev, 'flood')] == [('none', 'minor')], kinds(ev, 'flood'))
ev = gauge_run([(12.0, 'no_flooding'), (13.4, 'minor'), (13.9, 'minor'), (15.1, 'minor'),
                (14.7, 'minor', 8), (14.6, 'minor', 9)])
cr = kinds(ev, 'crest')
check('GAP · an hour with no reading after the peak already makes the crest uncertain',
      len(cr) == 1 and cr[0].get('unc') is True, cr)

# one malformed source or feature never freezes the others
fx = Fx()
fx.alerts = [WATCH]
fx.roads(1, [road('US0090', 'A')])
fx.run(1)
BADF = json.loads(json.dumps(FFW))
BADF['properties']['parameters']['VTEC'] = [None]
FLW2 = alert('Flood Warning', 'KHGX', 'FL', 'W', 7, 'NEW', T(1, 4), ends=T(40), areas=('Harris',))
fx.alerts = [WATCH, BADF, FLW2]
fx.roads(2, [road('US0090', 'A'), road('SH0071', 'B', start=cyc(1))])
try:
    p, notes, _ = fx.run(2)
    got = sorted((e['k'], e.get('key', '')[:14]) for e in new_since(p, 2))
    ok = got == [('road', 'SH0071|B|B end'), ('warn', 'KHGX.FL.W.0007')]
except Exception as e:  # noqa: BLE001, the failure under test is an uncaught raise
    ok, got = False, repr(e)
check('ISOLATION · a feature with a malformed VTEC is skipped; its neighbours and other sources still report',
      ok, got)
orig_sources = gc.SOURCES


def boom(root, now, fetch):
    raise RuntimeError('simulated crossing parser bug')


gc.SOURCES = tuple((n, boom if n == 'crossings' else f) for n, f in orig_sources)
fx.roads(3, [road('US0090', 'A'), road('SH0071', 'B', start=cyc(1)), road('FM0001', 'C', start=cyc(2))])
try:
    p, notes, _ = fx.run(3)
    ok = [e['route'] for e in kinds(new_since(p, 3), 'road')] == ['FM0001'] \
        and p['sources']['crossings']['at'] == cyc(0) and any('crossings' in n and 'RuntimeError' in n for n in notes)
    got = notes
except Exception as e:  # noqa: BLE001
    ok, got = False, repr(e)
finally:
    gc.SOURCES = orig_sources
check('ISOLATION · an exception reading one source carries that source and lets the rest publish', ok, got)
orig_step = gc.LIST_STEPS['roads']


def boom_step(*a):
    raise RuntimeError('simulated diff bug')


gc.LIST_STEPS['roads'] = boom_step
fx.roads(4, [road('FM0002', 'D', start=cyc(3))])
try:
    p, notes, _ = fx.run(4)
    st = fx.read('changes-state.json')['sources']['roads']
    ok = st['at'] == cyc(3) and kinds(new_since(p, 4), 'road') == [] and 'FM0001|C|C end' in st['items']
    got = (st['at'], notes)
except Exception as e:  # noqa: BLE001
    ok, got = False, repr(e)
finally:
    gc.LIST_STEPS['roads'] = orig_step
check('ISOLATION · an exception diffing one source carries its previous state untouched', ok, got)
fx.close()

# a diff that fails part-way carries the state it started from, never one it half-advanced
fx = Fx(meta=META)
for k, ft, cat in ((1, 12.0, 'no_flooding'), (2, 13.4, 'minor'), (3, 13.9, 'minor'), (4, 14.0, 'minor')):
    fx.gauges(k, [gauge('GA', ft, cat, cyc(k, -5)), gauge('GB', 5.0, 'no_flooding', cyc(k, -5), lat=30.0)])
    fx.run(k)
orig_reading = gc.gauge_reading


def flaky_reading(st, lid, cur, meta, at, out):
    if lid == 'GB':
        raise RuntimeError('simulated transient fault on another gauge')
    return orig_reading(st, lid, cur, meta, at, out)


FALL = [gauge('GA', 13.5, 'minor', cyc(5, -5)), gauge('GB', 5.1, 'no_flooding', cyc(5, -5), lat=30.0)]
gc.gauge_reading = flaky_reading
try:
    fx.gauges(5, FALL)
    fx.run(5)
finally:
    gc.gauge_reading = orig_reading
fx.gauges(6, FALL)
p, _, _ = fx.run(6)
got = [(e['k'], e['ft'], e['cat']) for e in kinds(p['events'], 'crest')]
check('CARRY · after a diff fails part-way, one 0.5 ft falling reading is not counted twice into a crest',
      got == [], got)
fx.close()

# gen-changes reports its own failed NWS read as degraded, after still publishing everything else
fx = Fx()
fx.run(1)
try:
    fx.nws_reason = 'URLError: timed out'
    bad = gc.main(root=fx.root, now=BASE + datetime.timedelta(minutes=17), fetch=fx.fetch)
    fx.nws_reason = None
    good = gc.main(root=fx.root, now=BASE + datetime.timedelta(minutes=32), fetch=fx.fetch)
    got = (bad, good, fx.read('changes.json')['generated'])
except Exception as e:  # noqa: BLE001
    got = repr(e)
check('DEGRADED · a failed NWS read still writes the log and exits 3 (written, degraded); a clean run exits 0',
      got == (3, 0, cyc(2, 2)), got)
fx.close()

# a kill between the two writes can neither duplicate nor lose a detection-timed line
fx = Fx()
fx.risk(1, W[:1])
fx.run(1)
fx.risk(2, W)
real_write = gc.write_atomic
calls = []


class Killed(Exception):
    pass


def killed_after_first(path, doc):
    calls.append(path)
    if len(calls) == 2:
        raise Killed()
    real_write(path, doc)


gc.write_atomic = killed_after_first
try:
    fx.run(2)
except Killed:
    pass
finally:
    gc.write_atomic = real_write
fx.risk(3, W)
p, _, _ = fx.run(3)
got = [(e['key'], e['t']) for e in kinds(p['events'], 'risk', 'new')]
check('KILL · a run killed between its two writes leaves exactly one line for what it saw',
      got == [('transtar:2', cyc(2, -1))], got)
fx.close()

# the state stays out of the published artifact
arch = tempfile.mkdtemp(prefix='gen-changes-archive.')
try:
    os.mkdir(os.path.join(arch, 'data'))
    for name in ('changes.json', 'changes-state.json'):
        with open(os.path.join(arch, 'data', name), 'w', encoding='utf-8') as f:
            f.write('{}\n')
    shutil.copy(os.path.join(ROOT, '.gitattributes'), os.path.join(arch, '.gitattributes'))

    def archived():
        g = ['git', '-C', arch, '-c', 'user.name=t', '-c', 'user.email=t@t']
        subprocess.run(['git', 'init', '-q', arch], check=True)
        subprocess.run(g + ['add', '-A'], check=True)
        subprocess.run(g + ['commit', '-qm', 'x', '--allow-empty'], check=True)
        tar = subprocess.run(g + ['archive', 'HEAD'], capture_output=True, check=True).stdout
        return subprocess.run(['tar', '-t'], input=tar, capture_output=True, check=True).stdout.decode().split()

    shipped = archived()
    with open(os.path.join(arch, '.gitattributes'), encoding='utf-8') as f:
        attrs = f.read()
    with open(os.path.join(arch, '.gitattributes'), 'w', encoding='utf-8') as f:
        f.write(attrs.replace('data/changes-state.json', '# removed for the control'))
    control = archived()
    check('ARCHIVE · the deploy archive ships the log and never the diff state (and the control sees it '
          'when the rule is removed)', 'data/changes.json' in shipped and 'data/changes-state.json' not in shipped
          and 'data/changes-state.json' in control, (shipped, control))
finally:
    shutil.rmtree(arch, ignore_errors=True)

# the state is deterministic and does not churn when nothing changed
fx = Fx()
fx.roads(1, [road('US0090', 'A')])
fx.gauges(1, [gauge('G1', 12.0, 'no_flooding', cyc(1, -5))])
fx.run(1)
raw1 = open(os.path.join(fx.root, 'data', 'changes-state.json'), encoding='utf-8').read()
fx.nws_reason = 'URLError: timed out'
fx.run(2)
raw2 = open(os.path.join(fx.root, 'data', 'changes-state.json'), encoding='utf-8').read()
check('CHURN · a run where nothing refreshed leaves the state byte-identical', raw1 == raw2,
      (len(raw1), len(raw2)))
doc = json.loads(raw2)
check('CHURN · the state is written with sorted keys, so equal states are equal bytes',
      raw2 == json.dumps(doc, sort_keys=True, indent=0, separators=(',', ':'), ensure_ascii=False) + '\n',
      raw2[:120])
items1 = json.loads(raw1)['sources']['roads']['items']
fx.roads(3, [road('US0090', 'A')])
fx.run(3)
items3 = fx.read('changes-state.json')['sources']['roads']['items']
check('CHURN · a refresh listing the same closures does not rewrite their entries', items1 == items3,
      (items1, items3))
fx.close()

# ---- mirrors and wiring -----------------------------------------------------------------------
core = open(os.path.join(ROOT, 'js', 'core.js'), encoding='utf-8').read()
m = re.search(r"const FLOOD_ROAD_RE = /(.+)/i;", core)
check('the flood-road pattern is the client\'s own (E5: one bound, two copies, held equal)',
      m and m.group(1) == gc.FLOOD_ROAD_RE.pattern, (m and m.group(1), gc.FLOOD_ROAD_RE.pattern))

print('---')
if FAILS:
    print('%d FAILURE(S)' % FAILS)
    sys.exit(1)
print('ALL PASS')
