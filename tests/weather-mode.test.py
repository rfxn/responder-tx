#!/usr/bin/env python3
"""tests/weather-mode.test.py · the cadence detector and gate in scripts/weather-mode.py.

Drives the real module against a fixture RESPONDER_ROOT and file:// alert fixtures (never the
network, never the real data/), with the real scripts/gen-caltopo.py allowlist and the real
fetch-snapshot.py stage envelope. Pins: the trigger list is derived, not hand-kept (E5); a failed
probe is never quiet (E1); adverse is entered at once and left only after 6 h; the owner override
wins; and the per-fire verdict lands quiet publishes on the 06:00 / 18:00 local slots.
Run: python3 tests/weather-mode.test.py"""
import datetime
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
MOD_PATH = os.path.join(REPO, 'scripts', 'weather-mode.py')
UTC = datetime.timezone.utc

FAILS = 0


def check(name, ok, detail=''):
    global FAILS
    print('%s: %s%s' % ('PASS' if ok else 'FAIL', name, '' if ok else ' -> %s' % (detail,)))
    if not ok:
        FAILS += 1


def fixture(auto=('Tornado Warning', 'Severe Thunderstorm Warning', 'Flood Watch')):
    root = tempfile.mkdtemp(prefix='weather-mode-test.')
    os.mkdir(os.path.join(root, 'data'))
    with open(os.path.join(root, 'data', 'event.json'), 'w') as f:
        json.dump({'wxAutoEvents': list(auto)}, f)
    return root


def load(root):
    os.environ['RESPONDER_ROOT'] = root
    os.environ['RESPONDER_WX_ALERTS_URL'] = 'file://' + os.path.join(root, 'alerts.json')
    os.environ.pop('RESPONDER_CADENCE_STATE', None)
    spec = importlib.util.spec_from_file_location('weather_mode_under_test', MOD_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.BACKOFFS = []
    return mod


def alert(event, severity='Severe', status='Actual', mtype='Alert', aid=None):
    return {'id': aid or 'urn:' + event, 'properties': {'id': aid or 'urn:' + event, 'event': event,
            'severity': severity, 'status': status, 'messageType': mtype}}


def write_alerts(root, feats):
    with open(os.path.join(root, 'alerts.json'), 'w') as f:
        json.dump({'features': feats}, f)


def gauge(lid, obs='no_flooding', fcst='fcst_not_current', stage=3.0, name=None):
    return {'lid': lid, 'name': name or lid, 'latitude': 30.0, 'longitude': -97.0,
            'status': {'observed': {'floodCategory': obs, 'primary': stage},
                       'forecast': {'floodCategory': fcst, 'primary': -999 if fcst == 'fcst_not_current' else 9.0}}}


def write_capture(root, gauges, age_min=5):
    gen = datetime.datetime.now(UTC) - datetime.timedelta(minutes=age_min)
    with open(os.path.join(root, 'data', 'gauges-capture.json'), 'w') as f:
        json.dump({'generated': gen.strftime('%Y-%m-%dT%H:%M:%SZ'), 'gauges': gauges}, f)


def state(root):
    with open(os.path.join(root, 'data', '.cadence-state.json')) as f:
        return json.load(f)


# --- the trigger list is derived from the board's own tables (E5) --------------------------
root = fixture()
m = load(root)
events = m.trigger_events()
check('wxAutoEvents and the allowlist flood, tropical and surge warnings and watches are triggers',
      {'Tornado Warning', 'Severe Thunderstorm Warning', 'Flood Watch', 'Flash Flood Warning', 'Flood Warning',
       'Coastal Flood Warning', 'Storm Surge Warning', 'Hurricane Warning', 'Tropical Storm Watch'} <= events,
      sorted(events))
check('standing advisories, wind-only and heat products are not triggers',
      not ({'Flood Advisory', 'Coastal Flood Advisory', 'Hurricane Force Wind Warning', 'Red Flag Warning',
            'Wind Advisory', 'Heat Advisory', 'Tropical Cyclone Local Statement'} & events), sorted(events))
table = m.hazard_table()
check('every derived member is a product the board carries', events - {'Tornado Warning', 'Severe Thunderstorm Warning', 'Flood Watch'} <= set(table))
with open(os.path.join(REPO, 'data', 'event.json')) as f:
    live_auto = json.load(f).get('wxAutoEvents') or []
check('E5 · every wxAutoEvents entry in the live data/event.json is a product the allowlist carries',
      set(live_auto) <= set(table), sorted(set(live_auto) - set(table)))
shutil.rmtree(root)

# --- alerts: severity, status and cancels decide, not the event name alone ------------------
root = fixture()
m = load(root)
write_capture(root, [gauge('A1')])
write_alerts(root, [alert('Coastal Flood Statement', severity='Minor'), alert('Freeze Warning'),
                    alert('Flash Flood Warning', status='Test', aid='t1'), alert('Tornado Warning', mtype='Cancel', aid='c1')])
s = m.probe()
check("today's live shape (a Minor coastal flood statement, a freeze warning) stays quiet",
      s['mode'] == 'quiet' and s['reasons'] == [] and s['probeOk'], s)
write_alerts(root, [alert('Flash Flood Warning', aid='a1'), alert('Flash Flood Warning', aid='a2'),
                    alert('Tornado Warning', severity='Extreme', aid='a3')])
s = m.probe()
check('a live warning enters adverse at once and names it', s['mode'] == 'adverse'
      and s['reasons'] == ['Flash Flood Warning (2)', 'Tornado Warning (1)'] and s['lastTriggerAt'] == s['lastProbeAt'], s)
check('MUTATION · reasonCodes carry the same triggers for lane C to render in en and es',
      s.get('reasonCodes') == [{'code': 'alert', 'event': 'Flash Flood Warning', 'n': 2},
                               {'code': 'alert', 'event': 'Tornado Warning', 'n': 1}], s.get('reasonCodes'))
write_alerts(root, [alert('Flood Warning', severity='Minor', aid='w1'), alert('Flash Flood Warning', severity='Unknown', aid='w2'),
                    alert('Flood Watch', severity='Minor', aid='h1'), alert('Coastal Flood Statement', severity='Minor', aid='s1')])
s8 = m.probe()
check('MUTATION · a warning triggers at any NWS severity; a Minor watch or statement does not',
      s8['mode'] == 'adverse' and s8['reasons'] == ['Flash Flood Warning (1)', 'Flood Warning (1)'], s8['reasons'])
write_alerts(root, [alert('Flood Watch', severity='Severe', aid='h2')])
check('a watch at Moderate+ severity still triggers', m.probe()['reasons'] == ['Flood Watch (1)'])
write_alerts(root, [alert('Flash Flood Warning', aid='a1'), alert('Flash Flood Warning', aid='a2'),
                    alert('Tornado Warning', severity='Extreme', aid='a3')])
s = m.probe()
check('Contract 2 keys are all present', {'mode', 'since', 'lastTriggerAt', 'lastProbeAt', 'probeOk', 'probeFailStreak',
                                          'lastPublishAt', 'reasons', 'alertSetHash'} - set(s) <= {'lastPublishAt'}, sorted(s))
h1 = s['alertSetHash']
write_alerts(root, [alert('Tornado Warning', severity='Extreme', aid='a3'), alert('Flash Flood Warning', aid='a2'),
                    alert('Flash Flood Warning', aid='a1')])
check('the alert-set hash ignores answer order', m.probe()['alertSetHash'] == h1)
shutil.rmtree(root)

# --- gauges: observed minor+, forecast moderate+, and never an impossible stage --------------
root = fixture()
m = load(root)
write_alerts(root, [])
write_capture(root, [gauge('A1', obs='minor'), gauge('B1', fcst='moderate'), gauge('C1', fcst='minor')])
s = m.probe()
check('gauges in flood and forecast in moderate flood are triggers; a minor forecast is not',
      s['mode'] == 'adverse' and s['reasons'] == ['Gauges in flood (1)', 'Gauges forecast in moderate flood (1)'], s)
check('gauge reasonCodes: code gauges, the forecast one flagged',
      s.get('reasonCodes') == [{'code': 'gauges', 'n': 1}, {'code': 'gauges', 'n': 1, 'forecast': True}], s.get('reasonCodes'))
shutil.rmtree(root)
root = fixture()
m = load(root)
write_alerts(root, [])
# 2026-11-24T23:08Z, first live fire: MQTT2 observed minor at 1.39 ft on a routine high tide, while NWS
# carried only a Minor Coastal Flood Advisory there; the board went hourly over it
write_capture(root, [gauge('MQTT2', obs='minor', stage=1.39, name='Tide Gauge at Bob Hall Pier'),
                     gauge('GRRT2', fcst='minor', name='Tide Station (HGX) at Galveston Railroad Bridge')])
s = m.probe()
check('MUTATION · a tide gauge at observed or forecast minor is a high tide, not a trigger', s['mode'] == 'quiet', s.get('reasons'))
write_capture(root, [gauge('MQTT2', obs='moderate', stage=2.6, name='Tide Gauge at Bob Hall Pier'),
                     gauge('GRRT2', fcst='moderate', name='Tide Station (HGX) at Galveston Railroad Bridge')])
s = m.probe()
check('a tide gauge at observed or forecast moderate triggers adverse',
      s['mode'] == 'adverse' and s['reasons'] == ['Gauges in flood (1)', 'Gauges forecast in moderate flood (1)'], s.get('reasons'))
shutil.rmtree(root)
root = fixture()
m = load(root)
write_alerts(root, [])
write_capture(root, [gauge('BACT2', obs='minor', name='Colorado River (TX) near Bay City')])
s = m.probe()
check('a river gauge at observed minor still triggers adverse', s['mode'] == 'adverse' and s['reasons'] == ['Gauges in flood (1)'], s.get('reasons'))
shutil.rmtree(root)
root = fixture()
m = load(root)
write_alerts(root, [])
write_capture(root, [gauge('X1', obs='major', stage=10000030)])
s = m.probe()
check("MUTATION · NWPS's 10000030 ft 'major' no-reading shape is not a flood (fetch-snapshot's envelope applies)",
      s['mode'] == 'quiet' and s['probeOk'], s)
write_capture(root, [gauge('A1', obs='minor')], age_min=90)
s = m.probe()
check('E1 · a stale capture is a failed probe, not a quiet one', not s['probeOk'] and s['probeFailStreak'] == 1
      and s['mode'] == 'quiet' and 'stale' in ' '.join(s['problems']), s)
shutil.rmtree(root)

# --- E1: a failed probe keeps the mode, counts, and goes adverse after 3 in quiet ------------
root = fixture()
m = load(root)
write_capture(root, [gauge('A1')])
write_alerts(root, [])
m.probe()
os.unlink(os.path.join(root, 'alerts.json'))
modes = [m.probe()['mode'] for _ in range(3)]
s = state(root)
check('E1 · quiet survives two failed probes and turns adverse on the third', modes == ['quiet', 'quiet', 'adverse']
      and s['probeFailStreak'] == 3 and s['reasons'] == ['Weather checks unavailable'], (modes, s))
check('the probe-failure reason is code probe', s.get('reasonCodes') == [{'code': 'probe'}], s.get('reasonCodes'))
write_alerts(root, [])
s = m.probe()
check('a clean probe after a failure-only adverse returns to quiet (no real trigger to wait out)',
      s['mode'] == 'quiet' and s['probeFailStreak'] == 0, s)
shutil.rmtree(root)

root = fixture()
m = load(root)
write_capture(root, [gauge('A1')])
s = m.probe()  # no alerts fixture and no prior state
check('E1 · a first-ever probe that fails is adverse, never an assumed quiet', s['mode'] == 'adverse', s)
shutil.rmtree(root)

# --- hysteresis: leave adverse only after 6 h with no trigger ---------------------------------
root = fixture()
m = load(root)
now = datetime.datetime(2026, 11, 23, 18, 0, tzinfo=UTC)
prev = {'mode': 'adverse', 'since': '2026-11-23T00:00:00Z', 'reasons': ['Flood Warning (1)'],
        'lastTriggerAt': m.iso(now - datetime.timedelta(hours=5, minutes=59))}
s1 = m.next_state(prev, [], [], [], now, None)
prev['lastTriggerAt'] = m.iso(now - datetime.timedelta(hours=6))
s2 = m.next_state(prev, [], [], [], now, None)
check('the hysteresis reason is code recent', s1.get('reasonCodes') == [{'code': 'recent'}], s1.get('reasonCodes'))
check('adverse holds at 5 h 59 min without a trigger and leaves at 6 h', s1['mode'] == 'adverse'
      and s2['mode'] == 'quiet' and s2['reasons'] == [] and s2['since'] == m.iso(now) and s1['since'] == prev['since'], (s1, s2))
s3 = m.next_state(dict(prev, mode='adverse'), [], [], ['NWS alerts unreachable: x'], now, None)
check('E1 · a failed probe in adverse stays adverse even past 6 h', s3['mode'] == 'adverse', s3)

# --- the owner override ----------------------------------------------------------------------
sq = m.next_state({'mode': 'quiet', 'since': 'x'}, [{'code': 'alert', 'event': 'Flood Warning', 'n': 1}], ['u1'], [], now, 'quiet')
sa = m.next_state({'mode': 'quiet', 'since': '2026-11-23T00:00:00Z'}, [], [], [], now, 'adverse')
check('the override reason is code operator, both ways',
      sq.get('reasonCodes') == [{'code': 'operator'}] and sa.get('reasonCodes') == [{'code': 'operator'}], (sq, sa))
check('data/.cadence-force wins both ways, is marked, and says so in the reasons',
      sq['mode'] == 'quiet' and sq['reasons'] == ['Set by the operator'] and sq['forced']
      and sa['mode'] == 'adverse' and sa['reasons'] == ['Set by the operator'] and sa['since'] == m.iso(now), (sq, sa))
force_path = os.path.join(root, 'data', '.cadence-force')
with open(force_path, 'w') as f:
    f.write('sometimes\n')
check('an unreadable override word is ignored, not obeyed', m.forced_mode() is None)
with open(force_path, 'w') as f:
    f.write('quiet\n')
os.utime(force_path, (time.time() - 23 * 3600,) * 2)
check('an override 23 h old still holds', m.forced_mode() == 'quiet')
os.utime(force_path, (time.time() - 25 * 3600,) * 2)
write_capture(root, [gauge('A1', obs='minor')])
write_alerts(root, [])
s = m.probe()
check('MUTATION · an override 25 h old has lapsed: real triggers win and the file is removed',
      s['mode'] == 'adverse' and not s['forced'] and not os.path.exists(force_path), s)
shutil.rmtree(root)

# --- the per-fire verdict --------------------------------------------------------------------
root = fixture()
m = load(root)
CT = m.ANCHOR_TZ


def ct(h, mi, day=23):
    return datetime.datetime(2026, 11, day, h, mi, tzinfo=CT)


def verdict(mode, last, now, since=None, status=None, ahead=0, foreign=0, told=None):
    st = {'mode': mode, 'since': m.iso(since or ct(0, 0, 20)), 'lastPublishAt': m.iso(last) if last else None,
          'publishedMode': told or mode}
    return m.due(st, status or {}, ahead, foreign, now)


cases = [
    ('no publish recorded runs at once', verdict('quiet', None, ct(10, 8)), 'full'),
    ('adverse holds at 54 min', verdict('adverse', ct(10, 8), ct(11, 2)), 'hold'),
    ('adverse runs at 55 min', verdict('adverse', ct(10, 8), ct(11, 3)), 'full'),
    ('quiet holds mid-day', verdict('quiet', ct(6, 8), ct(12, 8)), 'hold'),
    ('quiet runs at 11 h 50 min', verdict('quiet', ct(6, 8), ct(17, 58)), 'full'),
    ('quiet runs at the first fire after 18:00 local', verdict('quiet', ct(6, 8), ct(18, 8)), 'full'),
    ('quiet realigns onto 06:00 after an event ends at 02:23', verdict('quiet', ct(2, 23), ct(6, 8)), 'full'),
    ('a slot 15 min after a publish waits for the 55 min floor', verdict('quiet', ct(5, 53), ct(6, 8)), 'hold'),
    ('quiet to adverse publishes now', verdict('adverse', ct(10, 8), ct(10, 23), since=ct(10, 23), told='quiet'), 'full'),
    ('adverse to quiet publishes once, so the mirror stops claiming hourly',
     verdict('quiet', ct(10, 8), ct(10, 23), since=ct(10, 23), told='adverse'), 'full'),
    ('a publish stamped seconds before the probe that saw the change is not a new change',
     verdict('adverse', ct(10, 23), ct(10, 38), since=ct(10, 23) + datetime.timedelta(seconds=7)), 'hold'),
    ('a commit the cycle did not make ships within one fire',
     verdict('quiet', ct(6, 8), ct(9, 8), ahead=1, foreign=1), 'ship'),
]
for name, got, want in cases:
    check('verdict · ' + name, got[0] == want, got)
check('the slot reason names the local time', 'the 06:00 local slot' in verdict('quiet', ct(2, 23), ct(6, 8))[1])

ep = lambda dt: int(dt.timestamp())  # noqa: E731
fail_cases = [
    ('a deploy failure retries the deploy alone at the next fire',
     verdict('quiet', ct(6, 8), ct(6, 23), status={'consecutive_failures': 2, 'stage': 'deploy', 'finished_epoch': ep(ct(6, 20))}), 'ship'),
    ('after 4 failures it backs off to hourly',
     verdict('quiet', ct(6, 8), ct(6, 38), status={'consecutive_failures': 5, 'stage': 'deploy', 'finished_epoch': ep(ct(6, 23))}), 'hold'),
    ('the hourly retry comes due at 55 min',
     verdict('quiet', ct(6, 8), ct(7, 23), status={'consecutive_failures': 5, 'stage': 'deploy', 'finished_epoch': ep(ct(6, 23))}), 'ship'),
    ('a failure before commit retries the whole cycle',
     verdict('quiet', ct(6, 8), ct(6, 23), status={'consecutive_failures': 1, 'stage': 'validate', 'finished_epoch': ep(ct(6, 20))}), 'full'),
    ('a turn to adverse beats the backoff once',
     verdict('adverse', ct(6, 8), ct(6, 38), since=ct(6, 38), told='quiet',
             status={'consecutive_failures': 9, 'stage': 'deploy', 'finished_epoch': ep(ct(6, 23))}), 'full'),
    ('...but not on every fire after that',
     verdict('adverse', ct(6, 8), ct(6, 53), since=ct(6, 38), told='quiet',
             status={'consecutive_failures': 10, 'stage': 'deploy', 'finished_epoch': ep(ct(6, 40))}), 'hold'),
]
for name, got, want in fail_cases:
    check('verdict · ' + name, got[0] == want, got)

# clock skew: a stamp from a clock that ran ahead must never hold every fire after it was corrected
skew_cases = [
    ('a last publish stamped a day ahead is no publish recorded',
     verdict('quiet', ct(12, 8, 24), ct(12, 8)), 'full'),
    ('a future attempt stamp past 4 failures does not pin the hourly retry',
     verdict('quiet', ct(11, 8), ct(12, 8), status={'consecutive_failures': 5, 'stage': 'deploy', 'finished_epoch': ep(ct(12, 0, 24))}), 'ship'),
    ('an unreadable failure record retries rather than crashing the gate',
     verdict('quiet', ct(11, 8), ct(12, 8), status={'consecutive_failures': '2', 'finished_epoch': 'abc', 'stage': 'deploy'}), 'ship'),
    ('E1 · an unreadable ahead-of-origin count ships instead of reading as zero',
     verdict('quiet', ct(6, 8), ct(9, 8), ahead=-1), 'ship'),
]
for name, got, want in skew_cases:
    check('verdict · ' + name, got[0] == want, got)

# --- Contract 1 and the CLI ------------------------------------------------------------------
fire = datetime.datetime(2026, 11, 23, 23, 8, tzinfo=UTC)
p = m.cadence_payload({'mode': 'quiet', 'since': '2026-11-23T18:00:00Z', 'reasons': [], 'reasonCodes': []}, fire, fire)
check('Contract 1 · cadence.json carries its six keys plus reasonCodes, with nextDueBy one interval after the fire',
      sorted(p) == ['generated', 'intervalMin', 'mode', 'nextDueBy', 'reasonCodes', 'reasons', 'since']
      and p['intervalMin'] == 720 and p['nextDueBy'] == '2026-11-24T11:08:00Z', p)
check('adverse is hourly', m.cadence_payload({'mode': 'adverse', 'since': p['since'], 'reasons': ['Flood Warning (1)']},
                                             fire, fire)['intervalMin'] == 60)

env = dict(os.environ, RESPONDER_ROOT=root, PYTHONPATH=os.environ.get('PYTHONPATH', ''))
cadence = os.path.join(root, 'data', 'cadence.json')
with open(cadence, 'w') as f:
    f.write('{"mode": "quiet"}\n')
r = subprocess.run([sys.executable, MOD_PATH, '--write-cadence', '2026-11-23T23:08:00Z'], env=env, capture_output=True, text=True)
check('with no usable state, --write-cadence withdraws the file rather than leave a stale claim',
      r.returncode != 0 and not os.path.exists(cadence), (r.returncode, r.stderr))
with open(os.path.join(root, 'data', '.cadence-state.json'), 'w') as f:
    json.dump({'mode': 'adverse', 'since': '2026-11-23T22:00:00Z', 'reasons': ['Flood Warning (1)'],
               'reasonCodes': [{'code': 'alert', 'event': 'Flood Warning', 'n': 1}, {'code': 'bogus'}],
               'lastPublishAt': '2026-11-23T22:08:00Z'}, f)
r = subprocess.run([sys.executable, MOD_PATH, '--due', '--status', os.path.join(root, 'none.json'), '--ahead', '0',
                    '--foreign', '0'], env=env, capture_output=True, text=True)
check('--due prints one verdict line and records it as lastGate',
      r.returncode == 0 and r.stdout.split(' ', 1)[0] in ('full', 'hold') and state(root)['lastGate'].startswith(r.stdout.split(' ', 1)[0]),
      (r.stdout, r.stderr))
r = subprocess.run([sys.executable, MOD_PATH, '--mark-published', '2026-11-23T23:08:00Z'], env=env, capture_output=True, text=True)
check('--mark-published records the fire time and the mode the mirror was told',
      r.returncode == 0 and state(root)['lastPublishAt'] == '2026-11-23T23:08:00Z' and state(root)['publishedMode'] == 'adverse', r.stderr)
r = subprocess.run([sys.executable, MOD_PATH, '--write-cadence', '2026-11-23T23:08:00Z'], env=env, capture_output=True, text=True)
with open(cadence) as f:
    written = json.load(f)
check('--write-cadence writes Contract 1 from the state', r.returncode == 0 and written['mode'] == 'adverse'
      and written['nextDueBy'] == '2026-11-24T00:08:00Z' and written['reasons'] == ['Flood Warning (1)']
      and written['reasonCodes'] == [{'code': 'alert', 'event': 'Flood Warning', 'n': 1}], (r.stderr, written))
shutil.rmtree(root)

print('----')
if FAILS == 0:
    print('ALL WEATHER-MODE TESTS PASSED')
    sys.exit(0)
print('%d TEST(S) FAILED' % FAILS)
sys.exit(1)
