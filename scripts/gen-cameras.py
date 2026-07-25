#!/usr/bin/env python3
"""gen-cameras.py — build data/cameras.json: TxDOT traffic cams (full statewide
MapLarge inventory), TxDOT ITS snapshot-only cams (no HLS stream, JPEG stills
via the district ITS API), USGS HIVIS river cams (NIMS API) inside the AO
bbox, City of El Paso international-bridge live HLS cams, Port Houston Ship
Channel wharf and air-draft cams, ATX Floods low-water-crossing flood cams,
plus Hays County OES flood cams (CameraFTP/DriveHQ stills, San Marcos
corridor). Hand-maintained sources are liveness-checked at gen time. Run at
build time; the inventory is near-static, so the output is committed.
Stdlib only."""

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

ROOT = os.environ.get('RESPONDER_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_BBOX = (-106.65, 25.83, -93.4, 36.5)  # event-neutral Texas-wide fallback, mirrors js/core.js CONFIG.gaugeBbox
# statewide-TX river-cam clip. The north edge sits above the Panhandle line so the Canadian River
# at Amarillo and the NM Pecos headwaters that feed Texas are not clipped out of their own basins.
CAM_RIVER_BBOX = (-107.0, 25.5, -93.5, 36.6)
CAM_MAX_AGE_D = 30  # a camera whose newest frame is a month old has nothing to show


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
# ATX Floods low-water-crossing flood cams. The service is operated by Beholder Technology, LLC;
# every row reports jurisdiction COA, so the cameras themselves are City of Austin assets and the
# credit names both. Inventory only: the newest image_name rotates every ~3 min and is resolved at
# view time by the /api/cam/atxfloods proxy, so no imagery is mirrored here.
ATXFLOODS = 'https://api.atxfloods.com/api/cameras'
ATX_ID_RE = re.compile(r'^[0-9]{1,8}$')  # mirrors the /api/cam/atxfloods proxy validator
HOUSTON = 'https://traffic.houstontranstar.org/data/layers/cctvSnapshots_out.js'
# geometry is requested because 18 online rows carry a valid point but NULL Lat/Long columns
ARLINGTON = 'https://services.arcgis.com/jXi5GuMZwfCYtZP9/arcgis/rest/services/Traffic_Camera_Updates/FeatureServer/0/query?where=1%3D1&outFields=Camera_Location,Status,Pic_URL,Lat,Long&returnGeometry=true&outSR=4326&f=json'
ELP_BRIDGE_HOST = 'https://zoocams.elpasozoo.org'
# NOT a growth source: elpasotexas.gov/disclaimer forbids copying or reproduction "without the
# prior written consent of the CITY OF EL PASO" (verified 2026-07-25). bridgesantafe2.m3u8 is
# live and absent from this table on purpose. See CAMERA-SOURCES-RESEARCH.md row 7.
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
PORTHOU_HOST = 'https://info.porthouston.com/vtraffic/gateimages'
PORTHOU_MIN_BYTES = 1  # one probe answered 200 with content-length 0; an empty frame is not a camera
# Port Houston Ship Channel cams. There is no index to enumerate, so the ids are hand-kept like
# HAYS_CAMS and each is liveness-checked at gen time. Man1 watches air draft under the 610 bridge,
# which is the one that matters when the channel is running high.
# Positions are the terminal, not the individual berth: Port Houston publishes no per-camera
# coordinate, so every wharf cam on a terminal carries that terminal's position and the layer
# subtitle says so. Man1 is a single fixed structure and is placed on the bridge itself.
PORTHOU_BCT = (29.6836, -95.0680)   # Barbours Cut Terminal, Morgan's Point
PORTHOU_BPT = (29.6135, -95.0155)   # Bayport Container Terminal, Seabrook
PORTHOU_CAMS = (
    {'name': 'Sidney Sherman (I-610) Bridge air draft, Houston Ship Channel', 'lat': 29.7284, 'lon': -95.2588, 'id': 'Man1'},
) + tuple(
    {'name': f'Barbours Cut Terminal wharf {n}', 'lat': PORTHOU_BCT[0], 'lon': PORTHOU_BCT[1], 'id': f'bct_wharf_{n}'}
    for n in range(1, 8)
) + tuple(
    {'name': f'Bayport Container Terminal wharf {n}', 'lat': PORTHOU_BPT[0], 'lon': PORTHOU_BPT[1], 'id': f'bpt_wharf_{n}'}
    for n in range(2, 7)
)
PORTHOU_ID_RE = re.compile(r'^[A-Za-z0-9_]{1,32}$')  # mirrors the /api/cam/porthou proxy validator
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
# must mirror the /api/cam proxy validators (edge + server.py). The icd is a path segment, so a
# literal '/' cannot survive the round trip; ITS_ICD_SLASH stands in for it and both proxies
# reverse the substitution before calling upstream. No icd upstream contains it (0 of 3745).
ITS_ICD_SLASH = '~'
ITS_ICD_RE = re.compile(r"^[A-Za-z0-9 @\-.'_()&,#+~]{1,64}$")
AUSTIN_ID_RE = re.compile(r'^[0-9]{1,8}$')  # mirrors the /api/cam/austin proxy validator
HOUSTON_PATH_RE = re.compile(r'^([0-9]{1,8})\.jpg$')  # TranStar snapshot filename; id mirrors the /api/cam/houston validator
ARLINGTON_ID_RE = re.compile(r'^[A-Za-z0-9 _-]{1,64}$')  # mirrors the /api/cam/arlington proxy validator; no '.' or '/', so no traversal
ARLINGTON_PIC_RE = re.compile(r'^https?://webapps\.arlingtontx\.gov/webcams/(.+)\.jpg$', re.I)  # snapshot stem = proxy id
HAYS_ID_RE = re.compile(r'^[0-9]{1,12}-[0-9]{1,12}$')  # composite parentID-shareID; mirrors the /api/cam/hays proxy validator
TX_MIN_LAT, TX_MAX_LAT, TX_MIN_LON, TX_MAX_LON = 25.0, 37.0, -107.5, -93.0  # generous Texas coord sanity gate
ITS_NEAR_M = 150.0  # an ITS cam this close to a MapLarge streamable cam is the same head — streamable wins
# A district returning under half its last-known count is a partial response, not a retirement:
# the aggregate floor cannot see it (834 -> 672 still clears 300). Same shape as the
# fetch-snapshot.py partial-response guard, per district instead of per file.
ITS_DISTRICT_KEEP = 2  # divisor: live must reach last-known // 2 or the district is held
ITS_CARRY_MAX_D = 14  # a district that stays collapsed this long has really lost the cameras
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


def its_icd_key(icd):
    """Path-segment-safe form of an ITS icd, or None when it cannot round-trip.

    Both /api/cam proxies reverse ITS_ICD_SLASH before calling upstream, so an icd already
    holding that character is unrepresentable and is dropped rather than mis-resolved.
    """
    if not icd or ITS_ICD_SLASH in icd:
        return None
    key = icd.replace('/', ITS_ICD_SLASH)
    return key if ITS_ICD_RE.match(key) else None


def prev_its():
    """Last committed ITS rows grouped by district, plus the carry-forward clock."""
    try:
        with open(OUT, encoding='utf-8') as f:
            prev = json.load(f)
    except (OSError, ValueError):
        return {}, {}
    by_dist = {}
    for c in prev.get('txdot') or []:
        if c.get('src') == 'its' and c.get('dist') and c.get('icd'):
            by_dist.setdefault(c['dist'], []).append(c)
    clock = prev.get('itsCarried')
    return by_dist, dict(clock) if isinstance(clock, dict) else {}


def its_hold_collapsed(live, near_streamable):
    """Hold a district whose feed collapsed, so an upstream outage cannot prune the inventory.

    Gradual loss passes straight through, because a camera taken out of service is real. A
    district under half its last-known count is treated as a partial response and keeps the
    last-known rows, but only for ITS_CARRY_MAX_D — past that the loss is accepted as real.
    """
    prev_rows, prev_clock = prev_its()
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    cams, clock = [], {}
    for d in ITS_DISTRICTS:
        rows = live.get(d) or []
        known = prev_rows.get(d) or []
        floor = len(known) // ITS_DISTRICT_KEEP
        if not known or len(rows) >= floor:
            cams.extend(rows)
            continue
        since = (prev_clock.get(d) or {}).get('since') or now
        held_d = iso_age_days(since)
        if held_d is not None and held_d > ITS_CARRY_MAX_D:
            print(f'ITS {d}: {len(rows)} of {len(known)} last known, collapsed over {ITS_CARRY_MAX_D}d — accepting the loss as real')
            cams.extend(rows)
            continue
        merged = {c['icd']: c for c in known}
        merged.update({c['icd']: c for c in rows})  # a row the feed still returns wins: fresh name and coords
        held = [c for c in merged.values() if not near_streamable(c['lat'], c['lon'])]
        print(f'ITS {d}: {len(rows)} of {len(known)} last known (floor {floor}) — partial response, holding {len(held)} since {since}')
        cams.extend(held)
        clock[d] = {'since': since, 'known': len(known)}
    return cams, clock


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

    live, skipped_icd, dropped_near = {}, 0, 0
    for d in ITS_DISTRICTS:
        try:
            data = fetch_json(ITS + d)
        except OSError:
            data = fetch_json(ITS + d)  # one retry; a second failure is fatal — never commit a silently reduced set
        rows, seen = [], set()
        for lst in (data.get('roadwayCctvStatuses') or {}).values():
            for c in lst:
                if c.get('statusDescription') != 'Device Online' or not c.get('hasSnapshot'):
                    continue
                icd = its_icd_key(str(c.get('icd_Id') or ''))
                if icd is None:
                    skipped_icd += 1
                    continue
                try:
                    lat, lon = float(c['latitude']), float(c['longitude'])
                except (KeyError, TypeError, ValueError):
                    continue
                if not (25.0 <= lat <= 37.0 and -107.5 <= lon <= -93.0):
                    continue  # placeholder/junk coords — keep to a generous Texas envelope
                if icd in seen:
                    continue
                if near_streamable(lat, lon):
                    dropped_near += 1
                    continue
                seen.add(icd)
                rows.append({
                    'name': c.get('name') or icd,
                    'route': (c.get('equipLoc') or {}).get('roadway') or '',
                    'lat': round(lat, 6),
                    'lon': round(lon, 6),
                    'src': 'its',
                    'icd': icd,
                    'dist': d,
                })
        live[d] = rows
        print(f'ITS {d}: +{len(rows)}')
    cams, carried = its_hold_collapsed(live, near_streamable)
    print(f'ITS: {len(cams)} snapshot-only cams kept ({dropped_near} dropped as near-duplicates of streamable, {skipped_icd} skipped on icd charset)')
    return sorted(cams, key=lambda c: (c['dist'], c['name'])), carried


def iso_age_days(stamp):
    # None means the camera has never produced a frame, which is not the same as an old one
    try:
        t = datetime.fromisoformat(str(stamp).replace('Z', '+00:00'))
    except (TypeError, ValueError):
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - t).total_seconds() / 86400


def river_cams():
    xmin, ymin, xmax, ymax = CAM_RIVER_BBOX
    cams, never, dead = [], 0, 0
    for c in fetch_json(NIMS):
        try:
            lat, lon = float(c['lat']), float(c['lng'])
        except (KeyError, TypeError, ValueError):
            continue
        if c.get('hideCam') or not (ymin <= lat <= ymax and xmin <= lon <= xmax):
            continue
        # NIMS lists a camera the moment it is registered, years before (or after) it ever
        # returns a frame; listing one as available is the same defect as counting a shut shelter
        age = iso_age_days(c.get('newestImageDT'))
        if age is None:
            never += 1
            continue
        if age > CAM_MAX_AGE_D:
            dead += 1
            continue
        cams.append({
            'camId': c['camId'],
            'name': c.get('camDesc') or c.get('camName') or c['camId'],
            'nwisId': c.get('nwisId') or '',
            'lat': round(lat, 6),
            'lon': round(lon, 6),
            'newest': c['newestImageDT'],
        })
    print(f'USGS HIVIS: {len(cams)} river cams kept (statewide-TX clip), '
          f'{never} dropped with no image ever, {dead} dropped over {CAM_MAX_AGE_D}d stale')
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
    d = fetch_json(ATXFLOODS)
    cams, never, dead = [], 0, 0
    for c in (d.get('attributes') or []):
        try:
            lat, lon = float(c['lat']), float(c['lon'])
        except (KeyError, TypeError, ValueError):
            continue
        cid = str(c.get('id') or '')
        if not ATX_ID_RE.match(cid) or not c.get('display_status') or not in_texas(lat, lon):
            continue
        # same gate as the river cams: a crossing with no frame ever, or none this month, is not a
        # camera an operator can look through, and must not be offered as one
        newest = ((c.get('images') or [{}])[0]).get('created_at')
        age = iso_age_days(newest)
        if age is None:
            never += 1
            continue
        if age > CAM_MAX_AGE_D:
            dead += 1
            continue
        cams.append({
            'name': (c.get('name') or f'LWC {cid}').strip(),
            'lat': round(lat, 6),
            'lon': round(lon, 6),
            'id': int(cid),
            'newest': newest,
        })
    print(f'ATX Floods: {len(cams)} low-water-crossing flood cams kept, '
          f'{never} dropped with no image ever, {dead} dropped over {CAM_MAX_AGE_D}d stale')
    return sorted(cams, key=lambda c: c['id'])


def houston_cams():
    # TranStar inventory is a JS file of `new CctvCamera(name,monitor,roadway,loc,lat,lng,dir,path,validimg,...)`
    txt = fetch_text(HOUSTON)
    rec_re = re.compile(r'new CctvCamera\((.*?)\);')
    arg_re = re.compile(r"'([^']*)'")
    cams, seen, nocoord = [], set(), []
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
        if cid in seen:
            continue
        if not in_texas(lat, lon):
            nocoord.append(f'{cid} {a[0]}')  # upstream publishes 0,0 for these; unplaceable, not unreal
            continue
        seen.add(cid)
        cams.append({
            'name': a[0].strip() or f'Camera {cid}',
            'lat': round(lat, 6),
            'lon': round(lon, 6),
            'id': cid,
        })
    print(f'Houston TranStar: {len(cams)} cams kept (validimg + in-TX), '
          f'{len(nocoord)} dropped with no usable position: {", ".join(nocoord) or "none"}')
    return sorted(cams, key=lambda c: int(c['id']))


def arlington_cams():
    # City of Arlington ArcGIS FeatureServer: Online cams only; the snapshot filename stem is the proxy id
    d = fetch_json(ARLINGTON)
    cams, skipped, from_geom, nocoord = [], 0, 0, 0
    for f in (d.get('features') or []):
        a = f.get('attributes') or {}
        if not str(a.get('Status') or '').startswith('Online'):
            continue
        pm = ARLINGTON_PIC_RE.match(str(a.get('Pic_URL') or '').strip())
        if not pm:
            continue
        cid = pm.group(1)
        if not ARLINGTON_ID_RE.match(cid):  # a stem the strict proxy id rejects is dropped
            skipped += 1
            continue
        try:
            lat, lon = float(a['Lat']), float(a['Long'])
        except (KeyError, TypeError, ValueError):
            # the Lat/Long columns are NULL on a fifth of the layer; the point geometry is not
            g = f.get('geometry') or {}
            try:
                lat, lon = float(g['y']), float(g['x'])
            except (KeyError, TypeError, ValueError):
                nocoord += 1
                continue
            from_geom += 1
        if not in_texas(lat, lon):
            nocoord += 1
            continue
        cams.append({
            'name': (a.get('Camera_Location') or f'Camera {cid}').strip(),
            'lat': round(lat, 6),
            'lon': round(lon, 6),
            'id': cid,
        })
    print(f'Arlington: {len(cams)} online city cams kept ({from_geom} positioned from geometry, '
          f'{skipped} skipped on id charset, {nocoord} dropped with no usable position)')
    return sorted(cams, key=lambda c: c['name'])


def live_twice(probe, url):
    # a hand-kept camera is only called dead on a second failure; one transient miss silently
    # dropped a live Hays cam that the floor of 0 could not catch. Mirrors the its_cams retry.
    return probe(url) or probe(url)


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
        if not live_twice(hls_live, url):
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


def porthou_still_live(url):
    # the terminal cams answer 200 with content-length 0 when a head is down; that is not a frame
    try:
        req = urllib.request.Request(url, headers={'User-Agent': BROWSER_UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            ctype = (r.headers.get('Content-Type') or '').lower()
            return r.getcode() == 200 and 'image/jpeg' in ctype and len(r.read(PORTHOU_MIN_BYTES)) >= PORTHOU_MIN_BYTES
    except (OSError, ValueError, http.client.HTTPException):
        return False


def porthou_cams():
    cams = []
    for c in PORTHOU_CAMS:
        if not PORTHOU_ID_RE.match(c['id']):  # an id the strict proxy would reject is never emitted
            continue
        if not live_twice(porthou_still_live, f"{PORTHOU_HOST}/{c['id']}.jpg"):
            print(f"Port Houston: {c['id']} not live (empty or offline), dropped")
            continue
        cams.append({'name': c['name'], 'lat': round(c['lat'], 6), 'lon': round(c['lon'], 6), 'id': c['id']})
    print(f'Port Houston: {len(cams)}/{len(PORTHOU_CAMS)} live Ship Channel cams kept')
    return sorted(cams, key=lambda c: c['name'])


def hays_cams():
    cams = []
    for c in HAYS_CAMS:
        cid = f"{c['pid']}-{c['sid']}"
        if not HAYS_ID_RE.match(cid):  # a composite id the strict proxy would reject is never emitted
            continue
        if not live_twice(hays_thumb_live, HAYS_THUMB.format(pid=c['pid'], sid=c['sid'])):
            print(f"Hays OES: {c['name']} not live (placeholder/offline), dropped")
            continue
        cams.append({'name': c['name'], 'lat': round(c['lat'], 6), 'lon': round(c['lon'], 6), 'id': cid})
    print(f'Hays OES: {len(cams)}/{len(HAYS_CAMS)} live flood cams kept')
    return sorted(cams, key=lambda c: c['name'])


def main():
    tx = txdot_cams()
    its, its_carried = its_cams(tx)
    rv = river_cams()
    au = austin_cams()
    af = atxfloods_cams()
    ho = houston_cams()
    ar = arlington_cams()
    elp = elpbridge_cams()  # scoped liveness check — a dead host yields [] here, never aborts the whole gen
    ph = porthou_cams()  # hand-kept, liveness-checked; an offline head serves an empty body and is dropped
    ha = hays_cams()  # liveness-checked hand-list; idle cams serve a placeholder, so this legitimately shrinks toward 0
    # per-source floors abort a silently-zeroed source; its is the post-dedup residual (shrinks as the streamable set grows), so its floor stays low; hays floor is 0 (idle heads are expected, never a shape-change signal)
    for name, cams, floor in (('its', its, 300), ('river', rv, 20), ('austin', au, 400), ('atxfloods', af, 10), ('houston', ho, 400), ('arlington', ar, 40), ('hays', ha, 0)):
        if len(cams) < floor:
            sys.exit(f'{name}: {len(cams)} cams below floor {floor} — upstream shape change? refusing to overwrite {OUT}')
    out = {
        'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'bbox': list(BBOX),
        'itsCarried': its_carried,  # districts held through a collapsed feed, with the clock that expires the hold
        'attribution': {
            'txdot': 'Traffic cameras: TxDOT (Lonestar/DriveTexas + ITS district snapshots); imagery not recorded',
            'river': 'River cameras: USGS HIVIS (public domain, provisional imagery)',
            'austin': 'Traffic cameras: City of Austin, Texas (public domain); imagery not recorded',
            'atxfloods': 'Flood cameras: ATX Floods, a service of Beholder Technology, LLC · City of Austin low-water crossings; imagery not recorded',
            'houston': 'Traffic cameras: Houston TranStar (Houston region incl. Galveston/Bolivar ferry)',
            'arlington': 'Traffic cameras: City of Arlington, Texas (public arterial cams)',
            'elpbridge': 'Live cameras: City of El Paso international bridges',
            'hays': 'Flood cameras: Hays County Office of Emergency Services',
            'porthou': 'Ship Channel cameras: Port Houston',
        },
        'txdot': tx + its,
        'river': rv,
        'austin': au,
        'atxfloods': af,
        'houston': ho,
        'arlington': ar,
        'elpbridge': elp,
        'hays': ha,
        'porthou': ph,
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
          f'{len(ar)} Arlington city cams, {len(elp)} El Paso bridge cams, {len(ha)} Hays OES flood cams, '
          f'{len(ph)} Port Houston cams, {os.path.getsize(OUT)} bytes')


if __name__ == '__main__':
    main()
