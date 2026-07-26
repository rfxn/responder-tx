#!/usr/bin/env python3
"""tests/gen-caltopo.test.py — interchange generator against a fixture repo root
(RESPONDER_ROOT override, never the real data/): folder membership and counts,
simplestyle palette hexes, title/description/citation presence, PII exclusion,
aged/resolved/operator notice filtering, alert filtering (non-hazard, expired,
no-geometry), LSR type filtering, truncation drop order, offline source skip, and
the KML + GeoRSS emitters (well-formedness, count parity with the GeoJSON,
truncation and attribution parity, coordinate order, geometry degradation).
Run: python3 tests/gen-caltopo.test.py"""
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
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
    check('crest with no resolvable coords is counted, not swallowed', doc['properties']['crests_unresolved'] == 1)
    check('unresolved crest count appears in the log line', 'crests unresolved 1' in r.stdout, r.stdout[-200:])

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

# the wide capture backfills crests whose gauge sits outside the display AO. Own fixture root so the
# baseline drop-and-report checks above keep testing the capture-absent path.
tmp2 = tempfile.mkdtemp()
try:
    write_fixtures(tmp2)
    # MAJT2 is deliberately wrong here: the display snapshot must win where both carry a lid
    capture = {'generated': iso(NOW), 'bbox': [-106, 25, -93, 36], 'gauges': [
        {'lid': 'GONE2', 'name': 'No Coords Gauge', 'latitude': 29.5, 'longitude': -99.7, 'status': {}},
        {'lid': 'MAJT2', 'name': 'Major River at Testville', 'latitude': 25.0, 'longitude': -99.0, 'status': {}},
    ]}
    with open(os.path.join(tmp2, 'data', 'gauges-capture.json'), 'w') as f:
        json.dump(capture, f)
    r4 = run_gen(tmp2)
    doc4 = load(tmp2)
    m4 = [f for f in doc4['features'] if (f.get('properties') or {}).get('class') != 'Folder']
    crests4 = [f for f in m4 if f['properties']['folder'] == 'Crests (event peaks)']
    check('capture backfill run exits 0', r4.returncode == 0, r4.stderr[-300:])
    check('out-of-AO crest is recovered from the wide capture', len(crests4) == 2,
          'got %d' % len(crests4))
    check('fully resolved run reports crests_unresolved 0', doc4['properties']['crests_unresolved'] == 0)
    gone = [f for f in crests4 if f['properties'].get('lid') == 'GONE2']
    check('recovered crest carries the capture coordinates', bool(gone)
          and abs(gone[0]['geometry']['coordinates'][0][0][0] - (-99.7)) < 0.05
          and abs(gone[0]['geometry']['coordinates'][0][0][1] - 29.5) < 0.05)
    check('capture never overrides a display-snapshot coordinate',
          any(f['properties'].get('lid') == 'MAJT2'
              and abs(f['geometry']['coordinates'][0][0][1] - 30.0) < 0.05 for f in crests4))
finally:
    shutil.rmtree(tmp2)

# build_gauges only appends " · CATEGORY" when the gauge is in a flood category, so the suffix
# is how a surviving gauge proves it was not a quiet one the cap should have dropped first
def gauge_cat_in_title(f):
    return any(f['properties']['title'].endswith(' · ' + c)
               for c in ('ACTION', 'MINOR', 'MODERATE', 'MAJOR'))


tmp3 = tempfile.mkdtemp()
try:
    write_fixtures(tmp3)
    rc = run_gen(tmp3)
    check('uncapped run exits 0', rc.returncode == 0, rc.stderr[-300:])
    whole = load(tmp3)
    whole_n = len([f for f in whole['features'] if (f.get('properties') or {}).get('class') != 'Folder'])
    check('an untruncated export claims nothing was dropped',
          whole['properties']['truncated'] is False and whole['properties']['dropped'] == 0)
    check('an untruncated export counts candidates as what it carries',
          whole['properties']['candidates'] == whole_n, 'got %s vs %d' % (whole['properties'].get('candidates'), whole_n))
    check('an untruncated title makes no partial claim', 'partial' not in whole['properties']['title'])

    rt = run_gen(tmp3, RESPONDER_CALTOPO_MAX_FEATURES='2')
    check('capped run exits 0', rt.returncode == 0, rt.stderr[-300:])
    cut = load(tmp3)
    kept = [f for f in cut['features'] if (f.get('properties') or {}).get('class') != 'Folder']
    p = cut['properties']
    check('the cap is actually applied', len(kept) == 2, 'got %d' % len(kept))
    check('a truncated export reports the drop', p['truncated'] is True and p['dropped'] == whole_n - 2,
          'dropped=%s expected %d' % (p.get('dropped'), whole_n - 2))
    check('a truncated export publishes the candidate total and the cap',
          p['candidates'] == whole_n and p['cap'] == 2)
    # the artifact must be honest to someone who imports the URL and never sees our share sheet
    check('a truncated title says partial, with both numbers',
          'partial' in p['title'] and ('%d of %d' % (2, whole_n)) in p['title'], p['title'])
    check('a truncated note explains what survives the cut',
          'dropped' in p['note'] and 'in-flood gauge' in p['note'], p['note'][-120:])
    check('truncation keeps the highest-ranked features, never quiet gauges',
          all(f['properties']['folder'] != 'Gauges (NOAA NWPS)' for f in kept)
          or all(gauge_cat_in_title(f) for f in kept if f['properties']['folder'] == 'Gauges (NOAA NWPS)'),
          [f['properties']['title'] for f in kept])
finally:
    shutil.rmtree(tmp3)


# ---------------------------------------------------------------------------
# KML + GeoRSS: the same assembled feature list in two more interchange formats.
# ---------------------------------------------------------------------------

NS = {'k': 'http://www.opengis.net/kml/2.2',
      'a': 'http://www.w3.org/2005/Atom',
      'g': 'http://www.georss.org/georss'}


def xml_root(tmp, name):
    return ET.parse(os.path.join(tmp, 'data', name)).getroot()


def members_of(doc):
    return [f for f in doc['features'] if (f.get('properties') or {}).get('class') != 'Folder']


tmp4 = tempfile.mkdtemp()
try:
    write_fixtures(tmp4)
    r5 = run_gen(tmp4)
    check('generator emitting all four artifacts exits 0', r5.returncode == 0, r5.stderr[-400:])
    for name in ('board.kml', 'board-live.kml', 'board-georss.xml'):
        check('%s is written' % name, os.path.exists(os.path.join(tmp4, 'data', name)))

    doc5 = load(tmp4)
    mem5 = members_of(doc5)
    kml = xml_root(tmp4, 'board.kml')
    live = xml_root(tmp4, 'board-live.kml')
    feed = xml_root(tmp4, 'board-georss.xml')
    check('every emitted feed parses as XML', True)  # ET.parse above raises on malformed input

    check('kml root is the KML 2.2 namespace', kml.tag == '{http://www.opengis.net/kml/2.2}kml')
    check('georss root is an Atom feed', feed.tag == '{http://www.w3.org/2005/Atom}feed')

    placemarks = kml.findall('.//k:Placemark', NS)
    entries = feed.findall('a:entry', NS)
    check('kml placemark count matches the GeoJSON member count',
          len(placemarks) == len(mem5), '%d vs %d' % (len(placemarks), len(mem5)))
    check('georss entry count matches the GeoJSON member count',
          len(entries) == len(mem5), '%d vs %d' % (len(entries), len(mem5)))

    kml_folders = [f.findtext('k:name', '', NS) for f in kml.findall('.//k:Folder', NS)]
    check('kml folders are exactly the folders the GeoJSON carries',
          sorted(kml_folders) == sorted(doc5['properties']['counts'].keys()), str(kml_folders))
    check('kml per-folder placemark counts match the GeoJSON counts',
          all(len(f.findall('k:Placemark', NS)) == doc5['properties']['counts'][f.findtext('k:name', '', NS)]
              for f in kml.findall('.//k:Folder', NS)))

    defined = {s.get('id') for s in kml.findall('.//k:Style', NS)}
    check('every kml styleUrl resolves to a Style defined in the same document',
          all((p.findtext('k:styleUrl', '', NS) or '').lstrip('#') in defined for p in placemarks))
    check('kml styles carry no external icon href (the feed pulls no remote image)',
          not kml.findall('.//k:Icon', NS))

    check('every placemark has a name and a Source citation',
          all(p.findtext('k:name', '', NS) and 'Source:' in (p.findtext('k:description', '', NS) or '')
              for p in placemarks))
    check('every placemark carries an Updated stamp',
          all('Updated:' in (p.findtext('k:description', '', NS) or '') for p in placemarks))
    check('every placemark exposes source and updated as ExtendedData fields, not only prose',
          all({d.get('name') for d in p.findall('k:ExtendedData/k:Data', NS)} >= {'source', 'updated', 'folder'}
              for p in placemarks))
    check('no placemark carries a TimeStamp (it would arm the Google Earth time slider)',
          not kml.findall('.//k:TimeStamp', NS))

    kml_data = {d.get('name'): d.findtext('k:value', '', NS)
                for d in kml.findall('.//k:Document/k:ExtendedData/k:Data', NS)}
    check('kml publishes the generated time', kml_data.get('generated') == doc5['properties']['generated'])
    check('kml publishes the cap, candidate total and dropped count',
          kml_data.get('cap') == str(doc5['properties']['cap'])
          and kml_data.get('candidates') == str(doc5['properties']['candidates'])
          and kml_data.get('dropped') == str(doc5['properties']['dropped']))
    check('kml carries source attribution', 'respondertx.org' in (kml_data.get('attribution') or '')
          and 'NOAA' in (kml_data.get('attribution') or ''))
    check('kml document description carries the 911 disclaimer',
          'call 911' in (kml.findtext('.//k:Document/k:description', '', NS) or ''))

    check('georss feed updated is the generated time',
          feed.findtext('a:updated', '', NS) == doc5['properties']['generated'])
    check('georss feed carries source attribution in rights',
          'respondertx.org' in (feed.findtext('a:rights', '', NS) or '')
          and 'NOAA' in (feed.findtext('a:rights', '', NS) or ''))
    check('georss subtitle carries the 911 disclaimer',
          'call 911' in (feed.findtext('a:subtitle', '', NS) or ''))
    check('every entry has a title, an id, an updated stamp and a summary',
          all(e.findtext('a:title', '', NS) and e.findtext('a:id', '', NS)
              and e.findtext('a:updated', '', NS) and e.findtext('a:summary', '', NS) for e in entries))
    check('every entry summary carries the Source citation',
          all('Source:' in (e.findtext('a:summary', '', NS) or '') for e in entries))
    ids = [e.findtext('a:id', '', NS) for e in entries]
    check('entry ids are unique', len(set(ids)) == len(ids))
    check('entry ids are tag URIs scoped by folder',
          all(i.startswith('tag:respondertx.org,2026:folder-') for i in ids), ids[:2])
    check('entry categories name the folder the feature came from',
          all((e.find('a:category', NS) is not None
               and e.find('a:category', NS).get('term') in doc5['properties']['counts']) for e in entries))

    # GeoRSS-Simple is "lat lon"; GeoJSON is [lon, lat]. Swapping them puts Texas in the Indian Ocean.
    maj_entry = next(e for e in entries if e.findtext('a:title', '', NS).startswith('Gauge: Major River'))
    check('georss point is lat lon, the reverse of the GeoJSON pair order',
          (maj_entry.findtext('g:point', '', NS) or '').split() == ['30', '-95'],
          maj_entry.findtext('g:point', '', NS))
    for tag in ('point', 'line', 'polygon'):
        for el in feed.findall('.//g:' + tag, NS):
            vals = [float(v) for v in (el.text or '').split()]
            check('georss:%s coordinates are in-range lat/lon pairs' % tag,
                  vals and len(vals) % 2 == 0
                  and all(abs(v) <= 90 for v in vals[0::2]) and all(abs(v) <= 180 for v in vals[1::2]),
                  el.text)
            break  # one sample per geometry type is enough; the generator gate checks them all

    # the NetworkLink is the whole point: a plain KML at a URL is a one-shot, the same defect as
    # the GeoJSON import. Only refreshMode onInterval makes the fixed URL a self-updating layer.
    link = live.find('.//k:NetworkLink/k:Link', NS)
    check('board-live.kml wraps a NetworkLink', link is not None)
    check('the NetworkLink points at board.kml',
          link.findtext('k:href', '', NS) == 'https://respondertx.org/data/board.kml')
    check('the NetworkLink refreshes on an interval',
          link.findtext('k:refreshMode', '', NS) == 'onInterval'
          and int(link.findtext('k:refreshInterval', '0', NS)) == 900)
    check('board-live.kml carries the 911 disclaimer',
          'call 911' in (live.findtext('.//k:Document/k:description', '', NS) or ''))

    # truncation parity: the claim v0.99.1 added to the GeoJSON has to survive into every format,
    # because whoever subscribes to the KML or the feed never sees the share sheet either
    rt5 = run_gen(tmp4, RESPONDER_CALTOPO_MAX_FEATURES='3')
    check('capped run emitting all formats exits 0', rt5.returncode == 0, rt5.stderr[-400:])
    cut5 = load(tmp4)
    kept5 = len(members_of(cut5))
    total5 = cut5['properties']['candidates']
    kml_c = xml_root(tmp4, 'board.kml')
    feed_c = xml_root(tmp4, 'board-georss.xml')
    check('a truncated kml says partial, with both numbers',
          'partial' in kml_c.findtext('.//k:Document/k:name', '', NS)
          and ('%d of %d' % (kept5, total5)) in kml_c.findtext('.//k:Document/k:name', '', NS),
          kml_c.findtext('.//k:Document/k:name', '', NS))
    check('a truncated georss feed says partial, with both numbers',
          'partial' in feed_c.findtext('a:title', '', NS)
          and ('%d of %d' % (kept5, total5)) in feed_c.findtext('a:title', '', NS),
          feed_c.findtext('a:title', '', NS))
    check('a truncated kml explains what survives the cut',
          'in-flood gauge' in (kml_c.findtext('.//k:Document/k:description', '', NS) or ''))
    check('a truncated georss feed explains what survives the cut',
          'in-flood gauge' in (feed_c.findtext('a:subtitle', '', NS) or ''))
    check('truncated feeds still agree with the GeoJSON on how many features they carry',
          len(kml_c.findall('.//k:Placemark', NS)) == kept5
          and len(feed_c.findall('a:entry', NS)) == kept5 == 3)

    # offline: the XML feeds must publish alongside the GeoJSON, not only on a fully-sourced run
    ro5 = run_gen(tmp4, RESPONDER_CALTOPO_OFFLINE='1', RESPONDER_CALTOPO_ALERTS_FILE='',
                  RESPONDER_CALTOPO_LSRS_FILE='', RESPONDER_CALTOPO_MAX_FEATURES='500')
    check('offline run still emits both XML feeds', ro5.returncode == 0
          and len(xml_root(tmp4, 'board.kml').findall('.//k:Placemark', NS)) == len(members_of(load(tmp4))),
          ro5.stderr[-300:])
finally:
    shutil.rmtree(tmp4)

# a MultiPolygon alert is the real multi-part case: NWS issues them routinely, KML represents them
# exactly, and GeoRSS-Simple cannot. Own fixture root so the baseline alert counts stay untouched.
tmp5 = tempfile.mkdtemp()
try:
    write_fixtures(tmp5)
    with open(os.path.join(tmp5, 'alerts.json'), 'w') as f:
        json.dump({'features': [{'id': 'mp1', 'properties': {
            'event': 'Flash Flood Warning', 'areaDesc': 'Two disjoint parts',
            'headline': 'Two-part FFW', 'sent': iso(NOW), 'expires': iso(NOW + timedelta(hours=3)),
            'description': ''},
            'geometry': {'type': 'MultiPolygon', 'coordinates': [
                [[[-95.9, 29.9], [-95.8, 29.9], [-95.8, 30.0], [-95.9, 30.0], [-95.9, 29.9]]],
                [[[-94.0, 29.0], [-93.0, 29.0], [-93.0, 30.0], [-94.0, 30.0], [-94.0, 29.0]]]]}}]}, f)
    rm = run_gen(tmp5)
    check('multipolygon run exits 0', rm.returncode == 0, rm.stderr[-400:])
    kmlm = xml_root(tmp5, 'board.kml')
    feedm = xml_root(tmp5, 'board-georss.xml')
    alert_pm = next(p for p in kmlm.findall('.//k:Placemark', NS)
                    if 'Flash Flood Warning' in p.findtext('k:name', '', NS))
    check('kml represents a MultiPolygon exactly, as a MultiGeometry of both parts',
          alert_pm.find('k:MultiGeometry', NS) is not None
          and len(alert_pm.findall('k:MultiGeometry/k:Polygon', NS)) == 2)
    alert_entry = next(e for e in feedm.findall('a:entry', NS)
                       if 'Flash Flood Warning' in e.findtext('a:title', '', NS))
    check('georss degrades a MultiPolygon to one polygon rather than dropping it',
          alert_entry.findtext('g:polygon', '', NS) != '')
    check('georss keeps the larger part, not whichever came first',
          '-94' in alert_entry.findtext('g:polygon', '', NS))
    check('georss says in the entry itself that the outline was simplified',
          'simplified' in alert_entry.findtext('a:summary', '', NS)
          and 'largest of 2' in alert_entry.findtext('a:summary', '', NS),
          alert_entry.findtext('a:summary', '', NS)[-160:])
    check('georss never invents a bounding box over disjoint parts',
          not feedm.findall('.//g:box', NS))
finally:
    shutil.rmtree(tmp5)

# emitter units: the geometry matrix no upstream source currently produces, plus the escaping and
# no-geometry paths. Loaded directly because the file name is not an importable module name.
_spec = importlib.util.spec_from_file_location('gen_caltopo', GEN)
gen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gen)

check('kml maps a MultiLineString to a MultiGeometry of LineStrings',
      len(gen.kml_geometry({'type': 'MultiLineString',
                            'coordinates': [[[-95, 30], [-95, 31]], [[-94, 30], [-94, 31]]]})
          .findall('LineString')) == 2)
check('kml maps a GeometryCollection to a MultiGeometry',
      gen.kml_geometry({'type': 'GeometryCollection', 'geometries': [
          {'type': 'Point', 'coordinates': [-95, 30]},
          {'type': 'LineString', 'coordinates': [[-95, 30], [-94, 31]]}]}).tag == 'MultiGeometry')
check('kml collapses a single-part multi geometry rather than wrapping it pointlessly',
      gen.kml_geometry({'type': 'MultiPolygon',
                        'coordinates': [[[[-95, 30], [-94, 30], [-94, 31], [-95, 30]]]]}).tag == 'Polygon')
check('kml keeps polygon holes as innerBoundaryIs',
      len(gen.kml_geometry({'type': 'Polygon', 'coordinates': [
          [[-95, 30], [-94, 30], [-94, 31], [-95, 30]],
          [[-94.8, 30.2], [-94.6, 30.2], [-94.6, 30.4], [-94.8, 30.2]]]}).findall('innerBoundaryIs')) == 1)
for bad in (None, {}, {'type': 'Point'}, {'type': 'Point', 'coordinates': []},
            {'type': 'Polygon', 'coordinates': []}, {'type': 'Wormhole', 'coordinates': [1, 2]},
            {'type': 'GeometryCollection', 'geometries': []}):
    check('kml returns nothing for an unmappable geometry rather than emitting a broken one',
          gen.kml_geometry(bad) is None, repr(bad))
    check('georss returns no tag for an unmappable geometry', gen.georss_geometry(bad)[0] is None, repr(bad))

tag, txt, note = gen.georss_geometry({'type': 'MultiLineString',
                                      'coordinates': [[[-95, 30], [-95, 31]],
                                                      [[-94, 30], [-94, 31], [-93, 32]]]})
check('georss degrades a MultiLineString to its longest segment and says so',
      tag == 'georss:line' and '-93' in txt and 'longest of 2' in note, note)
tag, txt, note = gen.georss_geometry({'type': 'Polygon', 'coordinates': [
    [[-95, 30], [-94, 30], [-94, 31], [-95, 30]],
    [[-94.8, 30.2], [-94.6, 30.2], [-94.6, 30.4], [-94.8, 30.2]]]})
check('georss drops polygon holes it cannot express and says so',
      tag == 'georss:polygon' and 'hole' in note, note)
tag, txt, note = gen.georss_geometry({'type': 'Polygon', 'coordinates': [[[-95, 30], [-94, 30], [-94, 31]]]})
check('georss closes an open ring instead of emitting a polygon the spec rejects',
      txt.split()[:2] == txt.split()[-2:] and len(txt.split()) == 8, txt)
check('georss refuses a ring with too few points to be a polygon',
      gen.georss_geometry({'type': 'Polygon', 'coordinates': [[[-95, 30], [-94, 30]]]})[0] is None)
check('georss refuses a one-point line',
      gen.georss_geometry({'type': 'LineString', 'coordinates': [[-95, 30]]})[0] is None)
tag, txt, note = gen.georss_geometry({'type': 'MultiPoint', 'coordinates': [[-95, 30], [-94, 31]]})
check('georss degrades a MultiPoint to its first point and says so',
      tag == 'georss:point' and txt == '30 -95' and 'first of 2' in note, note)
tag, txt, note = gen.georss_geometry({'type': 'GeometryCollection', 'geometries': [
    {'type': 'Wormhole'}, {'type': 'Point', 'coordinates': [-95, 30]}]})
check('georss takes the first representable part of a collection and says so',
      tag == 'georss:point' and 'collection' in note, note)
check('kml colors are aabbggrr, the reverse of the CSS hex the board styles with',
      gen.kml_color('#a855f7') == 'fff755a8' and gen.kml_color('#d03b3b', 0.15) == '263b3bd0',
      gen.kml_color('#a855f7') + ' / ' + gen.kml_color('#d03b3b', 0.15))
check('kml color falls back to opaque white on a malformed hex rather than raising',
      gen.kml_color('not-a-color') == 'ffffffff' and gen.kml_color(None) == 'ffffffff')

tmp6 = tempfile.mkdtemp()
try:
    hdr = {'title': 'T & <test>', 'note': 'call 911 & "stay out"', 'generated': iso(NOW),
           'features': 1, 'candidates': 1, 'cap': 500, 'truncated': False, 'dropped': 0,
           'georss_url': 'https://respondertx.org/data/board-georss.xml'}
    unmappable = {'type': 'Feature', 'geometry': {'type': 'Wormhole', 'coordinates': [1, 2]},
                  'properties': {'title': 'Ampersand & angle <bracket>', 'marker-color': '#d03b3b',
                                 'marker-size': 'medium', 'description': 'Source: unit test\nUpdated: now'}}
    meta = {'folder_id': 'folder-notices', 'folder': 'Curated notices',
            'title': 'Ampersand & angle <bracket>', 'source': 'unit test', 'updated': iso(NOW), 'key': 'u1'}
    kpath = os.path.join(tmp6, 'board.kml')
    gpath = os.path.join(tmp6, 'board-georss.xml')
    unmapped = gen.write_kml([unmappable], [meta], hdr, kpath)
    gen.write_georss([unmappable], [meta], hdr, gpath)
    k6 = ET.parse(kpath).getroot()
    g6 = ET.parse(gpath).getroot()
    check('an unmappable geometry is counted, not swallowed', unmapped == 1)
    check('an unmappable feature still ships as a placemark, so counts stay truthful',
          len(k6.findall('.//k:Placemark', NS)) == 1 and len(g6.findall('a:entry', NS)) == 1)
    check('the placemark for an unmappable geometry says it has none',
          'No mappable geometry' in k6.findtext('.//k:Placemark/k:description', '', NS))
    check('the georss entry for an unmappable geometry says it has none',
          'No mappable geometry' in g6.findtext('a:entry/a:summary', '', NS))
    check('markup in a title round-trips through both feeds instead of breaking them',
          k6.findtext('.//k:Placemark/k:name', '', NS) == 'Ampersand & angle <bracket>'
          and g6.findtext('a:entry/a:title', '', NS) == 'Ampersand & angle <bracket>')

    # a source with no parseable time must not read as freshly observed
    for bad_time in ('sometime tuesday', '', None,
                     '0001-01-01T00:00:00Z'):  # the NWPS "no reading" sentinel, not an observation
        gen.write_georss([unmappable], [dict(meta, updated=bad_time)], hdr, gpath)
        g7 = ET.parse(gpath).getroot()
        check('an unusable source time falls back to the generation time and says so',
              g7.findtext('a:entry/a:updated', '', NS) == hdr['generated']
              and 'generation time' in g7.findtext('a:entry/a:summary', '', NS), repr(bad_time))
    # Atom requires RFC 3339, and strftime renders year 1 as "1-01-01", which is not
    check('every emitted Atom timestamp is RFC 3339',
          all(re.match(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$', el.text or '')
              for el in [g7.find('a:updated', NS)] + g7.findall('a:entry/a:updated', NS)))
    gen.write_georss([unmappable], [dict(meta, updated='2026-07-26T08:15:00-05:00')], hdr, gpath)
    check('a source time with an offset is normalized to UTC',
          ET.parse(gpath).getroot().findtext('a:entry/a:updated', '', NS) == '2026-07-26T13:15:00Z')
finally:
    shutil.rmtree(tmp6)

print('---')
if FAILS:
    print('%d FAILURE(S)' % FAILS)
    sys.exit(1)
print('ALL PASS')
