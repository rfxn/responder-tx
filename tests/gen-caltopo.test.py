#!/usr/bin/env python3
"""tests/gen-caltopo.test.py — CalTopo export generator against a fixture repo root
(RESPONDER_ROOT override, never the real data/): folder membership and counts,
simplestyle palette hexes, title/description/citation presence, PII exclusion,
aged/resolved/operator notice filtering, alert filtering (non-hazard, expired,
no-geometry), LSR type filtering, truncation drop order, offline source skip.
Run: python3 tests/gen-caltopo.test.py"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
GEN = os.path.join(HERE, '..', 'scripts', 'gen-caltopo.py')

FAILS = 0


def check(name, ok, detail=''):
    global FAILS
    print('%s: %s%s' % ('PASS' if ok else 'FAIL', name, (' · ' + detail) if (detail and not ok) else ''))
    if not ok:
        FAILS += 1


def iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%SZ')


NOW = datetime.now(timezone.utc)

GAUGES = {'generated': iso(NOW), 'bbox': [-98, 27, -93, 31], 'gauges': [
    {'lid': 'MAJT2', 'name': 'Major River at Testville', 'latitude': 30.0, 'longitude': -95.0,
     'status': {'observed': {'primary': 32.1, 'primaryUnit': 'ft', 'floodCategory': 'major', 'validTime': iso(NOW)},
                'forecast': {'primary': 33.0, 'primaryUnit': 'ft', 'floodCategory': 'major', 'validTime': iso(NOW + timedelta(hours=6))}}},
    {'lid': 'ACTT2', 'name': 'Action Creek', 'latitude': 30.1, 'longitude': -95.1,
     'status': {'observed': {'primary': 10.0, 'primaryUnit': 'ft', 'floodCategory': 'action', 'validTime': iso(NOW)},
                'forecast': {'primary': -999, 'primaryUnit': '', 'floodCategory': 'fcst_not_current', 'validTime': '0001-01-01T00:00:00Z'}}},
    {'lid': 'NONT2', 'name': 'Quiet Bayou', 'latitude': 30.2, 'longitude': -95.2,
     'status': {'observed': {'primary': 1.0, 'primaryUnit': 'ft', 'floodCategory': 'no_flooding', 'validTime': iso(NOW)},
                'forecast': {'primary': -999, 'primaryUnit': '', 'floodCategory': 'fcst_not_current', 'validTime': '0001-01-01T00:00:00Z'}}},
]}

CREST = {'generated': iso(NOW), 'gauges': [
    {'lid': 'MAJT2', 'name': 'Major River at Testville', 'peak': 32.5, 'peak_time': iso(NOW),
     'peak_category': 'moderate', 'unit': 'ft', 'ongoing': True,
     'record': {'record_ft': 40.0, 'record_date': '2016-03-13', 'exceeded': False}},
    {'lid': 'GONE2', 'name': 'No Coords Gauge', 'peak': 9.9, 'peak_time': iso(NOW),
     'peak_category': 'minor', 'unit': 'ft', 'ongoing': False},
]}

ROADS = {'generated': iso(NOW), 'roads': [
    {'id': 1, 'cond': 'Flooding', 'route': 'FM123', 'desc': '- Water over <br/>roadway',
     'start': iso(NOW - timedelta(hours=2)), 'end': None, 'v': [30.3, -95.3]},
]}

CROSSINGS = {'generated': iso(NOW), 'crossings': [
    {'id': 'x1', 'name': 'CR 100 at Test Creek', 'lat': 30.4, 'lon': -95.4, 'status': 'closed',
     'reason': 'Washed out', 'updated_at': iso(NOW), 'source': 'https://example.test/x1'},
    {'id': 'x2', 'name': 'CR 200 at Test Creek', 'lat': 30.5, 'lon': -95.5, 'status': 'open',
     'reason': '', 'updated_at': iso(NOW), 'source': 'https://example.test/x2'},
]}

REQUESTS = {'generated': iso(NOW), 'requests': [
    {'id': 'seed-001', 'ts': iso(NOW - timedelta(hours=2)), 'type': 'rescue', 'priority': 'critical',
     'status': 'open', 'county': 'Harris', 'place': 'Testville', 'lat': 30.6, 'lon': -95.6,
     'summary': 'Fresh open critical notice', 'contact': 'PII-PHONE-555-0100',
     'details': 'PII-DETAILS-street-address', 'source': {'platform': 'official', 'handle': 'PII-HANDLE', 'url': 'https://example.test/n1'}},
    {'id': 'seed-002', 'ts': iso(NOW - timedelta(hours=48)), 'type': 'supplies', 'priority': 'high',
     'status': 'open', 'county': 'Harris', 'place': 'Oldtown', 'lat': 30.7, 'lon': -95.7,
     'summary': 'Aged notice must not export'},
    {'id': 'seed-003', 'ts': iso(NOW - timedelta(hours=1)), 'type': 'road', 'priority': 'high',
     'status': 'resolved', 'county': 'Harris', 'place': 'Doneville', 'lat': 30.8, 'lon': -95.8,
     'summary': 'Resolved notice must not export'},
    {'id': 'op-001', 'ts': iso(NOW), 'type': 'rescue', 'priority': 'critical', 'status': 'open',
     'origin': 'operator', 'county': 'Harris', 'place': 'LAN-only', 'lat': 30.9, 'lon': -95.9,
     'summary': 'Operator intake must not export'},
    {'id': 'seed-004', 'ts': iso(NOW), 'type': 'info', 'priority': 'low', 'status': 'open',
     'county': 'Harris', 'place': 'Nowhere', 'summary': 'No coordinates, no export'},
]}

ALERTS = {'features': [
    {'id': 'a1', 'properties': {'event': 'Flash Flood Warning', 'areaDesc': 'Harris, TX',
     'headline': 'FFW for Harris', 'sent': iso(NOW - timedelta(hours=1)), 'expires': iso(NOW + timedelta(hours=3)),
     'description': 'FLASH FLOOD EMERGENCY for Testville', 'parameters': {'flashFloodDamageThreat': ['CATASTROPHIC']}},
     'geometry': {'type': 'Polygon', 'coordinates': [[[-95.9, 29.9], [-95.8, 29.9], [-95.8, 30.0], [-95.9, 30.0], [-95.9, 29.9]]]}},
    {'id': 'a2', 'properties': {'event': 'Flood Warning', 'areaDesc': 'Expired, TX',
     'sent': iso(NOW - timedelta(hours=9)), 'expires': iso(NOW - timedelta(hours=1)), 'description': ''},
     'geometry': {'type': 'Polygon', 'coordinates': [[[-95.9, 29.9], [-95.8, 29.9], [-95.8, 30.0], [-95.9, 29.9]]]}},
    {'id': 'a3', 'properties': {'event': 'Red Flag Warning', 'areaDesc': 'Not a flood hazard',
     'sent': iso(NOW), 'expires': iso(NOW + timedelta(hours=3)), 'description': ''},
     'geometry': {'type': 'Polygon', 'coordinates': [[[-95.9, 29.9], [-95.8, 29.9], [-95.8, 30.0], [-95.9, 29.9]]]}},
    {'id': 'a4', 'properties': {'event': 'Flood Watch', 'areaDesc': 'Zone-based, no geometry',
     'sent': iso(NOW), 'expires': iso(NOW + timedelta(hours=3)), 'description': ''}, 'geometry': None},
]}

LSRS = {'features': [
    {'properties': {'typetext': 'FLASH FLOOD', 'city': 'Testville', 'county': 'Harris', 'source': 'trained spotter',
     'remark': 'Road covered', 'valid': iso(NOW - timedelta(minutes=30))},
     'geometry': {'type': 'Point', 'coordinates': [-95.05, 30.05]}},
    {'properties': {'typetext': 'HAIL', 'city': 'Elsewhere', 'county': 'Harris', 'source': 'public',
     'remark': 'Not flood-relevant', 'valid': iso(NOW)},
     'geometry': {'type': 'Point', 'coordinates': [-95.06, 30.06]}},
]}


def write_fixtures(tmp):
    os.mkdir(os.path.join(tmp, 'data'))
    files = {'gauges-snapshot.json': GAUGES, 'crest-summary.json': CREST, 'roads-snapshot.json': ROADS,
             'crossings.json': CROSSINGS, 'requests.json': REQUESTS,
             'event.json': {'name': 'ResponderTX Test'}}
    for name, doc in files.items():
        with open(os.path.join(tmp, 'data', name), 'w') as f:
            json.dump(doc, f)
    with open(os.path.join(tmp, 'alerts.json'), 'w') as f:
        json.dump(ALERTS, f)
    with open(os.path.join(tmp, 'lsrs.json'), 'w') as f:
        json.dump(LSRS, f)


def run_gen(tmp, **env_extra):
    env = dict(os.environ, RESPONDER_ROOT=tmp,
               RESPONDER_CALTOPO_ALERTS_FILE=os.path.join(tmp, 'alerts.json'),
               RESPONDER_CALTOPO_LSRS_FILE=os.path.join(tmp, 'lsrs.json'))
    env.update(env_extra)
    return subprocess.run([sys.executable, GEN], env=env, capture_output=True, text=True)


def load(tmp):
    with open(os.path.join(tmp, 'data', 'caltopo-export.json')) as f:
        return json.load(f)


tmp = tempfile.mkdtemp()
try:
    write_fixtures(tmp)
    r = run_gen(tmp)
    check('generator exits 0', r.returncode == 0, r.stderr[-300:])
    doc = load(tmp)
    check('output is a FeatureCollection', doc.get('type') == 'FeatureCollection')

    feats = doc['features']
    folders = [f for f in feats if (f.get('properties') or {}).get('class') == 'Folder']
    members = [f for f in feats if (f.get('properties') or {}).get('class') != 'Folder']
    by_folder = {}
    for f in members:
        by_folder.setdefault(f['properties']['folder'], []).append(f)

    check('folder features carry class Folder + null geometry + title',
          all(f['geometry'] is None and f['properties'].get('title') for f in folders) and len(folders) == 7)
    check('every member carries folderId matching an emitted folder',
          all(any(fd.get('id') == m['properties'].get('folderId') for fd in folders) for m in members))
    check('per-folder counts: gauges 3', len(by_folder.get('Gauges (NOAA NWPS)', [])) == 3)
    check('per-folder counts: crests 1 (no-coords crest skipped)', len(by_folder.get('Crests (event peaks)', [])) == 1)
    check('per-folder counts: alerts 1 (expired/non-hazard/no-geometry dropped)',
          len(by_folder.get('NWS alerts (active)', [])) == 1)
    check('per-folder counts: roads 1', len(by_folder.get('Road closures (TxDOT)', [])) == 1)
    check('per-folder counts: crossings 2', len(by_folder.get('Low-water crossings', [])) == 2)
    check('per-folder counts: notices 1 (aged/resolved/operator/no-coords excluded)',
          len(by_folder.get('Curated notices', [])) == 1)
    check('per-folder counts: LSRs 1 (non-flood type filtered)', len(by_folder.get('Storm reports (NWS LSR)', [])) == 1)
    check('collection counts property matches member tally',
          doc['properties']['counts'] == {k: len(v) for k, v in by_folder.items()})

    maj = next(f for f in by_folder['Gauges (NOAA NWPS)'] if f['properties'].get('lid') == 'MAJT2')
    non = next(f for f in by_folder['Gauges (NOAA NWPS)'] if f['properties'].get('lid') == 'NONT2')
    check('major gauge marker-color is the app palette hex #a855f7', maj['properties']['marker-color'] == '#a855f7')
    check('no-flooding gauge marker-color is #898781', non['properties']['marker-color'] == '#898781')
    crest = by_folder['Crests (event peaks)'][0]
    check('crest ring stroke matches moderate palette hex #d03b3b', crest['properties']['stroke'] == '#d03b3b')
    check('crest ring geometry is a closed Polygon',
          crest['geometry']['type'] == 'Polygon'
          and crest['geometry']['coordinates'][0][0] == crest['geometry']['coordinates'][0][-1])
    alert = by_folder['NWS alerts (active)'][0]
    check('emergency alert stroke is #d03b3b', alert['properties']['stroke'] == '#d03b3b')
    closed = next(f for f in by_folder['Low-water crossings'] if f['properties']['status'] == 'closed')
    check('closed crossing marker-color is #d03b3b', closed['properties']['marker-color'] == '#d03b3b')

    raw = json.dumps(doc)
    check('no PII strings anywhere in the export',
          'PII-PHONE' not in raw and 'PII-DETAILS' not in raw and 'PII-HANDLE' not in raw)
    check('no contact/details/handle keys on any feature',
          all(not set(f.get('properties') or {}) & {'contact', 'details', 'handle'} for f in feats))
    check('excluded notices absent by id',
          not any((f.get('properties') or {}).get('id') in ('seed-002', 'seed-003', 'op-001', 'seed-004') for f in feats))

    check('every member has a title and a Source citation in its description',
          all(f['properties'].get('title') and 'Source:' in f['properties'].get('description', '') for f in members))
    check('every member description carries an Updated stamp',
          all('Updated:' in f['properties'].get('description', '') for f in members))
    check('collection carries the 911 disclaimer', 'call 911' in doc['properties']['note'])
    check('untruncated run reports truncated false', doc['properties']['truncated'] is False and doc['properties']['dropped'] == 0)

    # truncation: cap 8 forces 2 drops; the no_flooding gauge (rank 3) goes before any in-flood feature
    r2 = run_gen(tmp, RESPONDER_CALTOPO_MAX_FEATURES='8')
    doc2 = load(tmp)
    m2 = [f for f in doc2['features'] if (f.get('properties') or {}).get('class') != 'Folder']
    check('truncated run exits 0 and caps members', r2.returncode == 0 and len(m2) == 8)
    check('truncation flagged with dropped count', doc2['properties']['truncated'] is True and doc2['properties']['dropped'] == 2)
    check('no_flooding gauge dropped first', not any((f['properties'].get('lid')) == 'NONT2' for f in m2))
    check('in-flood gauge and alert survive truncation',
          any(f['properties'].get('lid') == 'MAJT2' for f in m2)
          and any(f['properties']['folder'] == 'NWS alerts (active)' for f in m2))

    # offline: live sources skipped gracefully, local folders still export
    r3 = run_gen(tmp, RESPONDER_CALTOPO_OFFLINE='1',
                 RESPONDER_CALTOPO_ALERTS_FILE='', RESPONDER_CALTOPO_LSRS_FILE='',
                 RESPONDER_CALTOPO_MAX_FEATURES='500')
    doc3 = load(tmp)
    check('offline run exits 0', r3.returncode == 0, r3.stderr[-300:])
    check('offline run lists unavailable sources',
          set(doc3['properties']['sources_unavailable']) == {'nws-alerts', 'iem-lsr'})
    check('offline run keeps local folders',
          'Gauges (NOAA NWPS)' in doc3['properties']['counts']
          and 'NWS alerts (active)' not in doc3['properties']['counts'])
finally:
    shutil.rmtree(tmp)

print('---')
if FAILS:
    print('%d FAILURE(S)' % FAILS)
    sys.exit(1)
print('ALL PASS')
