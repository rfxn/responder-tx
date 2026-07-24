#!/usr/bin/env python3
"""gen-cameras.py — build data/cameras.json: TxDOT traffic cams (full statewide
MapLarge inventory), TxDOT ITS snapshot-only cams (no HLS stream, JPEG stills
via the district ITS API), USGS HIVIS river cams (NIMS API) inside the AO
bbox, City of El Paso international-bridge live HLS cams, plus Hays County OES
flood cams (CameraFTP/DriveHQ stills, San Marcos corridor). Hand-maintained
sources are liveness-checked at gen time. Run at build time; the inventory is
near-static, so the output is committed. Stdlib only."""

import http.client
import json
import math
import os
import re
import sys
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_BBOX = (-106.65, 25.83, -93.4, 36.5)  # event-neutral Texas-wide fallback, mirrors js/core.js CONFIG.gaugeBbox
CAM_RIVER_BBOX = (-107.0, 25.5, -93.5, 33.8)  # statewide-TX river-cam clip — pulls Houston/DFW/Laredo flood-gage cams the gauge AO drops


def ao_bbox():
    try:
        with open(os.path.join(ROOT, 'data', 'event.json'), encoding='utf-8') as f:
            b = json.load(f).get('gaugeBbox') or {}
        if all(isinstance(b.get(k), (int, float)) for k in ('xmin', 'ymin', 'xmax', 'ymax')):
            return (b['xmin'], b['ymin'], b['xmax'], b['ymax'])
    except Exception as e:  # noqa: BLE001 — a broken event.json must not kill the poller; fallback matches core.js
        print(f'warn: event.json bbox unreadable, using default: {e}', file=sys.stderr)
    return DEFAULT_BBOX


BBOX = ao_bbox()  # xmin, ymin, xmax, ymax — gauge AO from data/event.json
MAPLARGE = 'https://dtx-e-cdn.maplarge.com/Api/ProcessDirect'
NIMS = 'https://api.waterdata.usgs.gov/nims/v0/cameras'
ITS = 'https://its.txdot.gov/its/DistrictIts/GetCctvStatusListByDistrict?districtCode='
ITS_DISTRICTS = ('ABL', 'AMA', 'ATL', 'AUS', 'BMT', 'BRY', 'BWD', 'CHS', 'CRP', 'DAL', 'ELP',
                 'FTW', 'HOU', 'LBB', 'LFK', 'LRD', 'ODA', 'PAR', 'PHR', 'SJT', 'SAT', 'TYL',
                 'WAC', 'WFS', 'YKM')
AUSTIN = 'https://data.austintexas.gov/resource/b4k4-adkb.json'
ATXFLOODS = 'https://api.atxfloods.com/api/cameras'
HOUSTON = 'https://traffic.houstontranstar.org/data/layers/cctvSnapshots_out.js'
ARLINGTON = 'https://services.arcgis.com/jXi5GuMZwfCYtZP9/arcgis/rest/services/Traffic_Camera_Updates/FeatureServer/0/query?where=1%3D1&outFields=Camera_Location,Status,Pic_URL,Lat,Long&returnGeometry=false&f=json'
ELP_BRIDGE_HOST = 'https://zoocams.elpasozoo.org'
# City of El Paso Rio Grande international-bridge cams — direct-play CORS-open HLS; the operator
# rotates stream names, so each .m3u8 is liveness-checked at gen time and dead ones are dropped.
ELP_BRIDGE_CAMS = (
    {'name': 'Paso del Norte Bridge (Santa Fe St.)', 'lat': 31.7527, 'lon': -106.4869, 'file': 'bridgepdn1.m3u8'},
    {'name': 'Santa Fe St. Bridge (view 3)', 'lat': 31.7530, 'lon': -106.4875, 'file': 'bridgesantafe3.m3u8'},
    {'name': 'Santa Fe St. Bridge (view 4)', 'lat': 31.7530, 'lon': -106.4875, 'file': 'bridgesantafe4.m3u8'},
    {'name': 'Stanton St. Bridge', 'lat': 31.7566, 'lon': -106.4790, 'file': 'BridgeStanton3.m3u8'},
    {'name': 'Ysleta-Zaragoza Bridge (view 1)', 'lat': 31.6698, 'lon': -106.3272, 'file': 'BridgeZaragoza1.m3u8'},
    {'name': 'Ysleta-Zaragoza Bridge (view 2)', 'lat': 31.6698, 'lon': -106.3272, 'file': 'BridgeZaragoza2.m3u8'},
    {'name': 'Ysleta-Zaragoza Bridge (view 3)', 'lat': 31.6698, 'lon': -106.3272, 'file': 'BridgeZaragoza3.m3u8'},
)
HAYS_THUMB = 'https://cameraftpapi.drivehq.com/api/Camera/GetCameraThumbnail.ashx?parentID={pid}&shareID={sid}'
HAYS_MIN_BYTES = 15000  # a live cam is a ~170 KB JPEG; DriveHQ serves a ~6 KB PNG placeholder when a head is idle/rotated
# Hays County Office of Emergency Services flood cams (Blue Iris NVR via CameraFTP/DriveHQ). Each thumbnail
# is liveness-checked at gen time; an idle/rotated head serves the placeholder and is dropped.
HAYS_CAMS = (
    {'name': 'Post Road at Blanco River', 'lat': 29.937905, 'lon': -97.894292, 'pid': 313579753, 'sid': 14844947},
    {'name': 'Little Arkansas Rd at Blanco River', 'lat': 29.983862, 'lon': -98.052270, 'pid': 313579380, 'sid': 14844891},
    {'name': 'FM150 at Onion Creek Double Crossing N', 'lat': 30.084686, 'lon': -98.012382, 'pid': 321464974, 'sid': 14930060},
    {'name': 'FM150 at Onion Creek Double Crossing S', 'lat': 30.082748, 'lon': -98.007575, 'pid': 321464972, 'sid': 14930067},
    {'name': 'NRCS Dam 4 Upper San Marcos', 'lat': 29.884379, 'lon': -98.031100, 'pid': 313579754, 'sid': 14844933},
    {'name': 'NRCS Dam 5 Upper San Marcos', 'lat': 29.870300, 'lon': -97.968622, 'pid': 313579755, 'sid': 14844919},
)
BROWSER_UA = 'Mozilla/5.0 (compatible; responder-tx-board/1.0)'  # some hosts block the default urllib UA
# must mirror the /api/cam proxy validators (edge + server.py); no '/' — it is the URL path separator
ITS_ICD_RE = re.compile(r"^[A-Za-z0-9 @\-.'_()&,#+]{1,64}$")
AUSTIN_ID_RE = re.compile(r'^[0-9]{1,8}$')  # mirrors the /api/cam/austin proxy validator
HOUSTON_PATH_RE = re.compile(r'^([0-9]{1,8})\.jpg$')  # TranStar snapshot filename; id mirrors the /api/cam/houston validator
ARLINGTON_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')  # mirrors the /api/cam/arlington proxy validator
ARLINGTON_PIC_RE = re.compile(r'^https?://webapps\.arlingtontx\.gov/webcams/(.+)\.jpg$', re.I)  # snapshot stem = proxy id
HAYS_ID_RE = re.compile(r'^[0-9]{1,12}-[0-9]{1,12}$')  # composite parentID-shareID; mirrors the /api/cam/hays proxy validator
TX_MIN_LAT, TX_MAX_LAT, TX_MIN_LON, TX_MAX_LON = 25.0, 37.0, -107.5, -93.0  # generous Texas coord sanity gate
ITS_NEAR_M = 150.0  # an ITS cam this close to a MapLarge streamable cam is the same head — streamable wins
OUT = os.path.join(ROOT, 'data', 'cameras.json')
PAGE = 1000


def fetch_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'responder-board-gen-cameras'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def fetch_text(url):
    req = urllib.request.Request(url, headers={'User-Agent': BROWSER_UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode('utf-8', 'replace')


def maplarge_page(start):
    q = {
        'action': 'table/query',
        'query': {
            'sqlselect': ['route', 'description', 'name', 'httpsurl', 'XY'],
            'start': start,
            'table': 'appgeo/cameraPoint',
            'take': PAGE,
        },
    }
    d = fetch_json(MAPLARGE + '?request=' + urllib.parse.quote(json.dumps(q)))
    if not d.get('success'):
        sys.exit(f'MapLarge query failed: {d.get("errors")}')
    return d['data']['data']


def txdot_cams():
    test_re = re.compile(r'\btest\b', re.I)
    cams, start, pages = [], 0, 0
    while True:
        cols = maplarge_page(start)
        pages += 1
        names = cols.get('name', [])
        for i in range(len(names)):
            xy = cols['XY'][i]
            url = cols['httpsurl'][i]
            if not xy or not xy.startswith('POINT') or not str(url).startswith('https://'):
                continue
            if test_re.search(cols['description'][i] or ''):  # vendor test streams (e.g. "Paris test WWD")
                continue
            lon, lat = (float(v) for v in xy.strip('POINT ()').split())
            cams.append({
                'name': names[i],
                'route': cols['route'][i] or '',
                'description': cols['description'][i] or '',
                'lat': round(lat, 6),
                'lon': round(lon, 6),
                'httpsurl': url,
            })
        if len(names) < PAGE:
            if len(cams) <= PAGE:
                sys.exit(f'statewide sweep returned only {len(cams)} cams — pagination broken?')
            print(f'MapLarge: {pages} pages, {len(cams)} cams kept')
            return sorted(cams, key=lambda c: c['name'])
        start += PAGE


def its_cams(streamable):
    cell = 0.002
    grid = {}
    for c in streamable:
        grid.setdefault((int(c['lat'] / cell), int(c['lon'] / cell)), []).append(c)

    def near_streamable(lat, lon):
        ci, cj = int(lat / cell), int(lon / cell)
        for i in range(ci - 1, ci + 2):
            for j in range(cj - 1, cj + 2):
                for c in grid.get((i, j), ()):
                    dy = (lat - c['lat']) * 111320.0
                    dx = (lon - c['lon']) * 111320.0 * math.cos(math.radians(lat))
                    if dy * dy + dx * dx <= ITS_NEAR_M * ITS_NEAR_M:
                        return True
        return False

    cams, seen, skipped_icd, dropped_near = [], set(), 0, 0
    for d in ITS_DISTRICTS:
        try:
            data = fetch_json(ITS + d)
        except OSError:
            data = fetch_json(ITS + d)  # one retry; a second failure is fatal — never commit a silently reduced set
        n0 = len(cams)
        for lst in (data.get('roadwayCctvStatuses') or {}).values():
            for c in lst:
                if c.get('statusDescription') != 'Device Online' or not c.get('hasSnapshot'):
                    continue
                icd = str(c.get('icd_Id') or '')
                if not ITS_ICD_RE.match(icd):
                    skipped_icd += 1
                    continue
                try:
                    lat, lon = float(c['latitude']), float(c['longitude'])
                except (KeyError, TypeError, ValueError):
                    continue
                if not (25.0 <= lat <= 37.0 and -107.5 <= lon <= -93.0):
                    continue  # placeholder/junk coords — keep to a generous Texas envelope
                if (d, icd) in seen:
                    continue
                if near_streamable(lat, lon):
                    dropped_near += 1
                    continue
                seen.add((d, icd))
                cams.append({
                    'name': c.get('name') or icd,
                    'route': (c.get('equipLoc') or {}).get('roadway') or '',
                    'lat': round(lat, 6),
                    'lon': round(lon, 6),
                    'src': 'its',
                    'icd': icd,
                    'dist': d,
                })
        print(f'ITS {d}: +{len(cams) - n0}')
    print(f'ITS: {len(cams)} snapshot-only cams kept ({dropped_near} dropped as near-duplicates of streamable, {skipped_icd} skipped on icd charset)')
    return sorted(cams, key=lambda c: (c['dist'], c['name']))


def river_cams():
    xmin, ymin, xmax, ymax = CAM_RIVER_BBOX
    cams = []
    for c in fetch_json(NIMS):
        try:
            lat, lon = float(c['lat']), float(c['lng'])
        except (KeyError, TypeError, ValueError):
            continue
        if c.get('hideCam') or not (ymin <= lat <= ymax and xmin <= lon <= xmax):
            continue
        cams.append({
            'camId': c['camId'],
            'name': c.get('camDesc') or c.get('camName') or c['camId'],
            'nwisId': c.get('nwisId') or '',
            'lat': round(lat, 6),
            'lon': round(lon, 6),
        })
    print(f'USGS HIVIS: {len(cams)} river cams kept (statewide-TX clip)')
    return sorted(cams, key=lambda c: c['camId'])


def in_texas(lat, lon):
    return TX_MIN_LAT <= lat <= TX_MAX_LAT and TX_MIN_LON <= lon <= TX_MAX_LON


def austin_cams():
    # Socrata: $where with an apostrophe is fiddly to encode via urllib — filter status client-side
    data = fetch_json(AUSTIN + '?$limit=2000&$select=camera_id,location_name,location,camera_status')
    cams, skipped_id = [], 0
    for c in data:
        if c.get('camera_status') != 'TURNED_ON':
            continue
        cid = str(c.get('camera_id') or '')
        if not AUSTIN_ID_RE.match(cid):
            skipped_id += 1
            continue
        coords = ((c.get('location') or {}).get('coordinates')) or []
        if len(coords) != 2:
            continue
        try:
            lon, lat = float(coords[0]), float(coords[1])
        except (TypeError, ValueError):
            continue
        if not in_texas(lat, lon):
            continue
        cams.append({
            'name': (c.get('location_name') or '').strip() or f'Camera {cid}',
            'lat': round(lat, 6),
            'lon': round(lon, 6),
            'id': cid,
        })
    print(f'Austin ATD: {len(cams)} live city cams kept ({skipped_id} skipped on id charset)')
    return sorted(cams, key=lambda c: int(c['id']))


def atxfloods_cams():
    # inventory only — the newest image_name changes every ~3 min, so it is resolved client-side at view time
    d = fetch_json(ATXFLOODS)
    cams = []
    for c in (d.get('attributes') or []):
        try:
            lat, lon = float(c['lat']), float(c['lon'])
        except (KeyError, TypeError, ValueError):
            continue
        cid = c.get('id')
        if cid is None or not in_texas(lat, lon):
            continue
        cams.append({
            'name': (c.get('name') or f'LWC {cid}').strip(),
            'lat': round(lat, 6),
            'lon': round(lon, 6),
            'id': int(cid),
        })
    print(f'ATX Floods: {len(cams)} low-water-crossing flood cams kept')
    return sorted(cams, key=lambda c: c['id'])


def houston_cams():
    # TranStar inventory is a JS file of `new CctvCamera(name,monitor,roadway,loc,lat,lng,dir,path,validimg,...)`
    txt = fetch_text(HOUSTON)
    rec_re = re.compile(r'new CctvCamera\((.*?)\);')
    arg_re = re.compile(r"'([^']*)'")
    cams, seen = [], set()
    for m in rec_re.finditer(txt):
        a = arg_re.findall(m.group(1))
        if len(a) < 9 or a[8] != 'True':  # a[8] = validimg — skip cams the operator flags as no live image
            continue
        pm = HOUSTON_PATH_RE.match(a[7])  # a[7] = snapshot filename
        if not pm:
            continue
        try:
            lat, lon = float(a[4]), float(a[5])
        except ValueError:
            continue
        cid = pm.group(1)
        if not in_texas(lat, lon) or cid in seen:
            continue
        seen.add(cid)
        cams.append({
            'name': a[0].strip() or f'Camera {cid}',
            'lat': round(lat, 6),
            'lon': round(lon, 6),
            'id': cid,
        })
    print(f'Houston TranStar: {len(cams)} cams kept (validimg + in-TX)')
    return sorted(cams, key=lambda c: int(c['id']))


def arlington_cams():
    # City of Arlington ArcGIS FeatureServer: Online cams only; the snapshot filename stem is the proxy id
    d = fetch_json(ARLINGTON)
    cams, skipped = [], 0
    for f in (d.get('features') or []):
        a = f.get('attributes') or {}
        if not str(a.get('Status') or '').startswith('Online'):
            continue
        pm = ARLINGTON_PIC_RE.match(str(a.get('Pic_URL') or '').strip())
        if not pm:
            continue
        cid = pm.group(1)
        if not ARLINGTON_ID_RE.match(cid):  # a stem the strict proxy id rejects (e.g. an embedded space) is dropped
            skipped += 1
            continue
        try:
            lat, lon = float(a['Lat']), float(a['Long'])
        except (KeyError, TypeError, ValueError):
            continue
        if not in_texas(lat, lon):
            continue
        cams.append({
            'name': (a.get('Camera_Location') or f'Camera {cid}').strip(),
            'lat': round(lat, 6),
            'lon': round(lon, 6),
            'id': cid,
        })
    print(f'Arlington: {len(cams)} online city cams kept ({skipped} skipped on id charset)')
    return sorted(cams, key=lambda c: c['name'])


def hls_live(url):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': BROWSER_UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.getcode() == 200 and r.read(32).lstrip().startswith(b'#EXTM3U')
    except (OSError, http.client.HTTPException):
        return False


def elpbridge_cams():
    cams = []
    for c in ELP_BRIDGE_CAMS:
        url = f"{ELP_BRIDGE_HOST}/{c['file']}"
        if not hls_live(url):
            print(f"El Paso bridge: {c['file']} not live — dropped")
            continue
        cams.append({'name': c['name'], 'lat': round(c['lat'], 6), 'lon': round(c['lon'], 6), 'httpsurl': url})
    print(f'El Paso bridges: {len(cams)}/{len(ELP_BRIDGE_CAMS)} live HLS cams kept')
    return sorted(cams, key=lambda c: c['name'])


def hays_thumb_live(url):
    # DriveHQ answers 200 with a small PNG placeholder for an idle/rotated head; a live cam is a real JPEG
    try:
        req = urllib.request.Request(url, headers={'User-Agent': BROWSER_UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            ctype = (r.headers.get('Content-Type') or '').lower()
            clen = int(r.headers.get('Content-Length') or 0)
            return r.getcode() == 200 and 'image/jpeg' in ctype and clen >= HAYS_MIN_BYTES
    except (OSError, ValueError, http.client.HTTPException):
        return False


def hays_cams():
    cams = []
    for c in HAYS_CAMS:
        cid = f"{c['pid']}-{c['sid']}"
        if not HAYS_ID_RE.match(cid):  # a composite id the strict proxy would reject is never emitted
            continue
        if not hays_thumb_live(HAYS_THUMB.format(pid=c['pid'], sid=c['sid'])):
            print(f"Hays OES: {c['name']} not live (placeholder/offline), dropped")
            continue
        cams.append({'name': c['name'], 'lat': round(c['lat'], 6), 'lon': round(c['lon'], 6), 'id': cid})
    print(f'Hays OES: {len(cams)}/{len(HAYS_CAMS)} live flood cams kept')
    return sorted(cams, key=lambda c: c['name'])


def main():
    tx = txdot_cams()
    its = its_cams(tx)
    rv = river_cams()
    au = austin_cams()
    af = atxfloods_cams()
    ho = houston_cams()
    ar = arlington_cams()
    elp = elpbridge_cams()  # scoped liveness check — a dead host yields [] here, never aborts the whole gen
    ha = hays_cams()  # liveness-checked hand-list; idle cams serve a placeholder, so this legitimately shrinks toward 0
    # per-source floors abort a silently-zeroed source; its is the post-dedup residual (shrinks as the streamable set grows), so its floor stays low; hays floor is 0 (idle heads are expected, never a shape-change signal)
    for name, cams, floor in (('its', its, 300), ('river', rv, 20), ('austin', au, 400), ('atxfloods', af, 10), ('houston', ho, 400), ('arlington', ar, 40), ('hays', ha, 0)):
        if len(cams) < floor:
            sys.exit(f'{name}: {len(cams)} cams below floor {floor} — upstream shape change? refusing to overwrite {OUT}')
    out = {
        'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'bbox': list(BBOX),
        'attribution': {
            'txdot': 'Traffic cameras: TxDOT (Lonestar/DriveTexas + ITS district snapshots); imagery not recorded',
            'river': 'River cameras: USGS HIVIS (public domain, provisional imagery)',
            'austin': 'Traffic cameras: City of Austin, Texas (public domain); imagery not recorded',
            'atxfloods': 'Flood cameras: ATX Floods / City of Austin low-water crossings',
            'houston': 'Traffic cameras: Houston TranStar (Houston region incl. Galveston/Bolivar ferry)',
            'arlington': 'Traffic cameras: City of Arlington, Texas (public arterial cams)',
            'elpbridge': 'Live cameras: City of El Paso international bridges',
            'hays': 'Flood cameras: Hays County Office of Emergency Services',
        },
        'txdot': tx + its,
        'river': rv,
        'austin': au,
        'atxfloods': af,
        'houston': ho,
        'arlington': ar,
        'elpbridge': elp,
        'hays': ha,
    }
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(OUT), prefix='.cameras.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(out, f, separators=(',', ':'))
            f.write('\n')
        os.replace(tmp, OUT)
    except Exception:  # noqa: BLE001, cleanup: drop the temp file, then re-raise
        os.unlink(tmp)
        raise
    print(f'{OUT}: {len(tx)} TxDOT streamable + {len(its)} ITS snapshot-only cams, {len(rv)} USGS river cams, '
          f'{len(au)} Austin city cams, {len(af)} ATX Floods cams, {len(ho)} Houston TranStar cams, '
          f'{len(ar)} Arlington city cams, {len(elp)} El Paso bridge cams, {len(ha)} Hays OES flood cams, {os.path.getsize(OUT)} bytes')


if __name__ == '__main__':
    main()
