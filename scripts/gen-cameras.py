#!/usr/bin/env python3
"""gen-cameras.py — build data/cameras.json: TxDOT traffic cams (full statewide
MapLarge inventory), TxDOT ITS snapshot-only cams (no HLS stream, JPEG stills
via the district ITS API), USGS HIVIS river cams (NIMS API) inside the AO
bbox, City of El Paso international-bridge live HLS cams, Port Houston Ship
Channel wharf and air-draft cams, ATX Floods low-water-crossing flood cams,
plus Hays County OES flood cams (CameraFTP/DriveHQ stills, San Marcos
corridor), Saltwater Recon Gulf Coast cams and City of Corpus Christi cams
(both Ozolio posters, which publish no capture time), City of Lubbock signal
cameras, WeatherBug weather-camera stills, NMDOT cameras on the southern New
Mexico reach that drains into Texas, National Park Service park cams, Laredo /
Eagle Pass / Del Rio international-bridge cams and the Port of Galveston cruise
terminal cam. Hand-maintained sources are liveness-checked at gen time. Run at
build time; the inventory is near-static, so the output is committed. Stdlib only."""

import email.utils
import http.client
import json
import math
import os
import re
import sys
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

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
# City of El Paso Rio Grande international-bridge cams — direct-play CORS-open HLS; the operator
# rotates stream names, so each .m3u8 is liveness-checked at gen time and dead ones are dropped.
# A sweep of 31 candidate names found exactly these 8 live; the host is case-insensitive, so
# BridgePDN1 and bridgepdn1 are one stream, not two.
ELP_BRIDGE_CAMS = (
    {'name': 'Paso del Norte Bridge (Santa Fe St.)', 'lat': 31.7527, 'lon': -106.4869, 'file': 'bridgepdn1.m3u8'},
    {'name': 'Santa Fe St. Bridge (view 2)', 'lat': 31.7530, 'lon': -106.4875, 'file': 'bridgesantafe2.m3u8'},
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
# WeatherBug / Earth Networks camera stills. There is no JSON API and no per-camera page: the
# per-camera URL 302s back to this index, whose records carry a "distance" field because the list
# is ranked against the requester's own geolocation. That is fine here (gen runs in Texas and the
# rows are state-filtered) but it is why the /api/cam/weatherbug proxy must never resolve against
# this page: a Cloudflare colo's idea of "near" is not the user's. There is also no "latest" URL,
# so the proxy walks the minute-stamped filename back from now instead. See WB_PROBE_MINUTES.
WEATHERBUG = 'https://www.weatherbug.com/weather-camera'
WEATHERBUG_IMG = 'https://cameras-cam.cdn.weatherbug.net/{id}/{y}/{m}/{d}/{stamp}_s.jpg'
WEATHERBUG_ID_RE = re.compile(r'^[A-Z0-9]{4,8}$')  # mirrors the /api/cam/weatherbug proxy validator
# the filename stamp is station-local (America/Chicago) wall time to the minute
WB_TZ = 'America/Chicago'
# gen-time liveness window. The proxies use a wider one, so anything shipped here stays
# resolvable when a camera's cadence stretches; never raise this above the proxy window.
WB_PROBE_MINUTES = 12
WB_REC_RE = re.compile(
    r'\{\\"city\\":\\"(?P<city>[^"\\]{0,40})\\",\\"distance\\":[-0-9.]+,\\"id\\":\\"(?P<id>[A-Z0-9]{4,8})\\"'
    r'.{0,200}?\\"lat\\":(?P<lat>[-0-9.]+),\\"lng\\":(?P<lon>[-0-9.]+),\\"name\\":\\"(?P<name>[^"\\]{0,60})\\"'
    r',\\"state\\":\\"(?P<state>[^"\\]{0,24})\\"')
# City of Lubbock signal cameras. The inventory lists every signalised asset, not every camera:
# most asset numbers have no image at all, and a fair share of the rest are heads that stopped
# posting months ago. Both are settled here at gen time, by HTTP status and by frame age.
LUBBOCK = 'https://pubgis.ci.lubbock.tx.us/server/rest/services/Traffic_Cameras/MapServer/0/query?where=1%3D1&outFields=ASSETNO,STREET,AVENUE,TxDOTNAME&returnGeometry=true&outSR=4326&f=json'
LUBBOCK_IMG = 'https://ewebmap.ci.lubbock.tx.us/TrafficCam/Images/{id}.jpg'
LUBBOCK_ID_RE = re.compile(r'^[0-9]{1,8}$')  # mirrors the /api/cam/lubbock proxy validator
# International port-of-entry cameras. No operator publishes a camera coordinate, so each is placed
# on the bridge structure it watches: the OSM man_made=bridge way for that named crossing, each of
# which also carries a Wikidata QID whose own coordinate agrees within ~150 m. Citations are in
# CAMERA-SOURCES-RESEARCH.md. Cameras on one bridge therefore share a pin, as the Port Houston wharf
# cams share a terminal, and the layer note says the position is the bridge and not the camera.
LAREDO_IMG = 'https://www.openlaredo.com/bridge/BridgeWebCamStills/{id}.jpg'
LAREDO_ID_RE = re.compile(r'^bridge[1-4](US|MEX)$')  # mirrors the /api/cam/laredo proxy validator
# Each Laredo frame burns its own bridge name into the picture, which is what identifies these:
# bridge3 is Colombia Solidarity and bridge4 is World Trade, not the other way round.
LAREDO_BRIDGES = (
    ('bridge1', 'Gateway to the Americas Bridge', 27.499956, -99.507498),
    ('bridge2', 'Juarez-Lincoln Bridge', 27.500190, -99.502705),
    ('bridge3', 'Colombia Solidarity Bridge', 27.699916, -99.745415),
    ('bridge4', 'World Trade Bridge', 27.597223, -99.537060),
)
LAREDO_SIDES = (('US', 'US side'), ('MEX', 'Mexico side'))
LAREDO_CAMS = tuple(
    {'name': f'{label} · {side_label}', 'lat': lat, 'lon': lon, 'id': f'{stem}{side}'}
    for stem, label, lat, lon in LAREDO_BRIDGES for side, side_label in LAREDO_SIDES
)
# ipcamlive: the stable key is the alias, never the s{N} host, which the operator migrates. The
# alias-direct snapshot URL redirects to whichever host currently holds the stream, so the proxy
# pins one host and follows the redirect rather than resolving the player page at view time.
IPCAMLIVE_IMG = 'https://ipcamlive.com/player/snapshot.php?alias={id}'
IPCAMLIVE_ID_RE = re.compile(r'^[a-z0-9]{8,24}$')  # mirrors the /api/cam/{eaglepass,delrio} validator
# Names are the operator's own where ipcamlive publishes one; the rest are numbered views rather
# than a guessed direction, because neither city page says which camera faces which way.
EAGLEPASS_CAMS = (
    {'name': 'Eagle Pass Bridge I · Plaza traffic', 'lat': 28.705617, 'lon': -100.509883, 'id': 'bridge1trafficplaza'},
    {'name': 'Eagle Pass Bridge I · platform', 'lat': 28.705617, 'lon': -100.509883, 'id': 'bridge1platform'},
    {'name': 'Camino Real Bridge · platform 2', 'lat': 28.697870, 'lon': -100.509637, 'id': '67231a475ead1'},
    {'name': 'Camino Real Bridge (view 2)', 'lat': 28.697870, 'lon': -100.509637, 'id': '639ba5d96b3f6'},
    {'name': 'Camino Real Bridge (view 3)', 'lat': 28.697870, 'lon': -100.509637, 'id': '639ba81bb4b49'},
    {'name': 'Camino Real Bridge (view 4)', 'lat': 28.697870, 'lon': -100.509637, 'id': '68f3f8b846277'},
)
DELRIO_CAMS = (
    {'name': 'Del Rio International Bridge (view 1)', 'lat': 29.327669, 'lon': -100.926688, 'id': '5da4899f1d893'},
    {'name': 'Del Rio International Bridge (view 2)', 'lat': 29.327669, 'lon': -100.926688, 'id': '5dd41e07c9949'},
)
# Port of Galveston cruise Terminal 16, EarthCam-hosted. The object is served from EarthCam's own
# edge with a ~24 h cache TTL, so a request without a unique query value can answer 200 with a frame
# hours old: measured 1927 s stale on the bare URL against 127 s with a cache buster. Both proxies
# therefore append one. Coordinates are the operator's, from the EarthCam camera record.
GALVESTON_IMG = ('https://resource6.earthcam.net/v0/object/'
                 'GtVJZlL4VnwZ3X0VJw8Bsdu5YUgJriK-Y8BAT-OpapoNxQAqapAVVnNTRqduHk_J')
GALVESTON_CAMS = (
    {'name': 'Port of Galveston cruise Terminal 16', 'lat': 29.311300, 'lon': -94.788630, 'id': 't16'},
)
GALVESTON_ID_RE = re.compile(r'^t16$')  # mirrors the /api/cam/galveston proxy validator
NPS_IMG = 'https://www.nps.gov/webcams-{park}/{cam}.jpg'
NPS_ARD_IMG = 'https://www.nps.gov/featurecontent/ard/webcams/images/{cam}.jpg'
NPS_ARD_PARK = 'ard'  # id prefix routing to the air-resources path; no park code collides with it
NPS_ID_RE = re.compile(r'^[a-z]{3,4}-[A-Za-z0-9]{1,32}$')  # mirrors the /api/cam/nps proxy validator
# National Park Service cameras, public domain. NPS publishes no coordinate for any of them, so each
# is hand-placed on the named facility it looks from, sourced from a gazetteer or OSM record; the
# citations are in CAMERA-SOURCES-RESEARCH.md and the layer note says the position is the facility.
# The API is deliberately not used: it needs a key, and its images[] field is a promo crop.
NPS_CAMS = (
    {'name': 'Lake Meredith from Sanford Dam', 'lat': 35.714105, 'lon': -101.552242, 'id': 'lamr-LAMR2'},
    {'name': 'Sanford-Yake area, Lake Meredith', 'lat': 35.706121, 'lon': -101.561763, 'id': 'lamr-LAMR1'},
    {'name': 'Alibates Flint Quarries visitor center', 'lat': 35.579319, 'lon': -101.703340, 'id': 'lamr-LAMR3'},
    {'name': 'Diablo East boat ramp, Amistad Reservoir', 'lat': 29.477891, 'lon': -101.016670, 'id': 'amis-camera0'},
    {'name': 'Malaquite Beach, Padre Island', 'lat': 27.424250, 'lon': -97.299080, 'id': 'pais-camera'},
    {'name': 'Panther Junction, Big Bend', 'lat': 29.328533, 'lon': -103.205173, 'id': 'ard-bibe'},
)
NMDOT = 'https://servicev5.nmroads.com/RealMapWAR/GetCameraInfo'
# HTTP-only snapshot host. That is fine behind the server-side proxy and never reaches the browser;
# the HTTPS alternative on servicev5 publishes no Last-Modified, so it could not be aged honestly.
NMDOT_IMG = 'http://ss.nmroads.com/snapshots/{id}.jpg'
NMDOT_SNAP_RE = re.compile(r'^https?://ss\.nmroads\.com/snapshots/([A-Za-z0-9_-]{4,32})\.jpg$', re.I)
NMDOT_ID_RE = re.compile(r'^[A-Za-z0-9_-]{4,32}$')  # mirrors the /api/cam/nmdot proxy validator
# Southern New Mexico only. This is the Rio Grande below Elephant Butte, which becomes the Texas
# river at El Paso, plus the I-10 approach and the Sacramento Mountains head of the Pecos. Above the
# reservoir the upper Rio Grande is decoupled from Texas, so those cameras are not carried.
NMDOT_BBOX = (-109.1, 31.0, -105.5, 33.5)  # xmin, ymin, xmax, ymax
OZOLIO_POSTER = 'https://relay.ozolio.com/pub.api?cmd=poster&oid={oid}'
OZOLIO_OID_RE = re.compile(r'^[A-Z]{3}_[A-Za-z0-9]{4,24}$')  # mirrors the /api/cam/{swrecon,corpus} proxy validator
OZOLIO_MIN_BYTES = 8000  # a live poster runs 130-550 KB; a down head answers far smaller or not at all
# Ozolio publishes no capture time on the poster (no Last-Modified, and ses.api is 403 to the public),
# so these cameras reach the viewer through the no-capture-time path rather than the aging badge.
SWRECON = 'https://saltwater-recon.nyc3.cdn.digitaloceanspaces.com/app/webcams.json'
# City of Corpus Christi webcams. The city publishes no inventory and no coordinates: the oids are
# lifted from its page's Ozolio iframes and each position is hand-placed against a verified source
# (the Calallen cam sits on USGS gauge 08211500 "Nueces Rv at Calallen", which is the barrier).
# The city also publishes "Commodores at Park Road 22"; it is omitted because no source places
# Commodores Dr, and a guessed coordinate on a routing map is worse than one fewer camera.
CORPUS_CAMS = (
    {'name': 'Calallen Reservoir, Nueces River saltwater barrier', 'lat': 27.883077, 'lon': -97.625273, 'oid': 'EMB_JBTF00001277'},
    {'name': 'Aquarius St at Park Road 22', 'lat': 27.626936, 'lon': -97.227023, 'oid': 'CID_WEGM000011BE'},
    {'name': 'Whitecap Beach', 'lat': 27.602140, 'lon': -97.223803, 'oid': 'CID_XCLW000002D1'},
    {'name': 'St. Augustine beach access', 'lat': 27.607037, 'lon': -97.209852, 'oid': 'CID_BHYP000002DB'},
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
# EarthCam spells it image/jpg. Accepting both keeps this gate from being stricter than the proxies,
# which admit any image/*, and so dropping a camera that would in fact have served.
JPEG_CTYPES = ('image/jpeg', 'image/jpg')
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
CAM_COLLAPSE_KEEP = 2  # divisor: a network must reach half what it last published
CAM_COLLAPSE_MIN = 20  # under this, only a fall to zero counts; hand-kept lists shed heads normally
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


def load_prev():
    """The last published inventory, or None on a genuine first run.

    A file that exists and will not read is not an empty inventory. Treating it as one disarms
    both the ITS collapse hold and check_no_collapse, so a district or a network that dropped out
    upstream would publish as a retirement.
    """
    try:
        with open(OUT, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        print(f'note: {OUT} absent, first run: no carry-forward baseline and no collapse floor')
        return None
    except (OSError, ValueError) as exc:
        sys.exit(f'{OUT} exists but will not read ({exc}); refusing to publish, because an '
                 f'unreadable baseline would retire every camera it exists to protect')


def prev_its(prev):
    """Last published ITS rows grouped by district, plus the carry-forward clock."""
    by_dist = {}
    for c in (prev or {}).get('txdot') or []:
        if c.get('src') == 'its' and c.get('dist') and c.get('icd'):
            by_dist.setdefault(c['dist'], []).append(c)
    clock = (prev or {}).get('itsCarried')
    return by_dist, dict(clock) if isinstance(clock, dict) else {}


def camera_networks(payload):
    """Network name -> rows for every camera array in a cameras.json payload.

    Read off the payload rather than a hand-kept list, so a network added later is covered by the
    collapse floor without anyone remembering to name it. bbox is numbers, not rows.
    """
    return {k: v for k, v in payload.items()
            if isinstance(v, list) and all(isinstance(row, dict) for row in v)}


def check_no_collapse(prev, out):
    """Refuse to publish a network that collapsed against the last published inventory.

    The absolute floors in main() are fixed numbers that do not follow the fleet as it grows, so a
    network can shed most of its cameras and still clear one. This measures against what was
    actually published last: an emptied network is never churn, and a large one at under half is a
    partial response rather than a mass retirement.
    """
    if prev is None:
        return
    was = camera_networks(prev)
    for name, rows in sorted(camera_networks(out).items()):
        known = len(was.get(name) or [])
        if not known:
            continue
        if not rows:
            sys.exit(f'{name}: 0 cams against {known} published last run; a whole network does not '
                     f'empty itself, refusing to overwrite {OUT}')
        floor = known // CAM_COLLAPSE_KEEP
        if known >= CAM_COLLAPSE_MIN and len(rows) < floor:
            sys.exit(f'{name}: {len(rows)} cams against {known} published last run (floor {floor}); '
                     f'partial response upstream? refusing to overwrite {OUT}')


def its_hold_collapsed(live, near_streamable, prev):
    """Hold a district whose feed collapsed, so an upstream outage cannot prune the inventory.

    Gradual loss passes straight through, because a camera taken out of service is real. A
    district under half its last-known count is treated as a partial response and keeps the
    last-known rows, but only for ITS_CARRY_MAX_D — past that the loss is accepted as real.
    """
    prev_rows, prev_clock = prev_its(prev)
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


def its_cams(streamable, prev):
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
    cams, carried = its_hold_collapsed(live, near_streamable, prev)
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


def http_date_age_days(stamp):
    """Age in days of an HTTP-date header, or None when it is absent or unparseable."""
    try:
        t = email.utils.parsedate_to_datetime(stamp)
    except (TypeError, ValueError):
        return None
    if t is None:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - t).total_seconds() / 86400


def jpeg_frame_age(url):
    """Age in days of a direct-JPEG camera's newest frame; None when it serves no dated image."""
    try:
        req = urllib.request.Request(url, headers={'User-Agent': BROWSER_UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            ctype = (r.headers.get('Content-Type') or '').lower()
            if r.getcode() != 200 or not any(c in ctype for c in JPEG_CTYPES):
                return None
            return http_date_age_days(r.headers.get('Last-Modified'))
    except (OSError, ValueError, http.client.HTTPException):
        return None


def lubbock_cams():
    seen, rows = set(), []
    for f in (fetch_json(LUBBOCK).get('features') or []):
        a, g = f.get('attributes') or {}, f.get('geometry') or {}
        cid = str(a.get('ASSETNO') or '')
        if not LUBBOCK_ID_RE.match(cid) or cid in seen:
            continue
        try:
            lat, lon = float(g['y']), float(g['x'])
        except (KeyError, TypeError, ValueError):
            continue
        if not in_texas(lat, lon):
            continue
        seen.add(cid)
        street, avenue = (a.get('STREET') or '').strip(), (a.get('AVENUE') or '').strip()
        name = f'{street} at {avenue}' if street and avenue else (street or avenue or f'Camera {cid}')
        route = (a.get('TxDOTNAME') or '').strip()
        rows.append({'name': f'{name} · {route}' if route else name, 'lat': lat, 'lon': lon, 'id': cid})
    cams, noimg, dead = [], 0, 0
    for c in rows:
        age = jpeg_frame_age(LUBBOCK_IMG.format(id=c['id']))
        if age is None:
            noimg += 1
            continue
        # the same gate the river cams use: a head whose newest frame is a month old has nothing
        # to show, and the inventory lists far more signals than it does working cameras
        if age > CAM_MAX_AGE_D:
            dead += 1
            continue
        cams.append({'name': c['name'], 'lat': round(c['lat'], 6), 'lon': round(c['lon'], 6), 'id': c['id']})
    print(f'Lubbock: {len(cams)} of {len(rows)} signals carry a live camera '
          f'({noimg} serve no image, {dead} last posted over {CAM_MAX_AGE_D}d ago)')
    return sorted(cams, key=lambda c: int(c['id']))


def jpeg_frame_age_twice(url):
    # one transient miss is not a dead camera; mirrors live_twice for the sources that carry an age
    age = jpeg_frame_age(url)
    return jpeg_frame_age(url) if age is None else age


def dated_still_cams(rows, id_re, url_of, label):
    """Keep the hand-kept cameras that answer with a JPEG carrying a recent Last-Modified."""
    cams, noimg, dead = [], 0, 0
    for c in rows:
        if not id_re.match(c['id']):  # an id the strict proxy would reject is never emitted
            continue
        if not in_texas(c['lat'], c['lon']):
            continue
        age = jpeg_frame_age_twice(url_of(c['id']))
        if age is None:
            noimg += 1
            print(f"{label}: {c['name']} serves no dated image, dropped")
            continue
        if age > CAM_MAX_AGE_D:
            dead += 1
            continue
        cams.append({'name': c['name'], 'lat': round(c['lat'], 6), 'lon': round(c['lon'], 6), 'id': c['id']})
    print(f'{label}: {len(cams)}/{len(rows)} cameras kept '
          f'({noimg} serve no dated image, {dead} last posted over {CAM_MAX_AGE_D}d ago)')
    return sorted(cams, key=lambda c: c['name'])


def galveston_url(_cid):
    # The id is validated to the single fixed camera and never steers the URL. The cache buster is
    # unique per call: without it the operator's edge answers 200 with a frame up to a day old.
    return f'{GALVESTON_IMG}?cb={int(datetime.now(timezone.utc).timestamp() * 1000)}'


def nps_url(cid):
    park, _, cam = cid.partition('-')
    return (NPS_ARD_IMG if park == NPS_ARD_PARK else NPS_IMG).format(park=park, cam=cam)


def nps_cams():
    return dated_still_cams(NPS_CAMS, NPS_ID_RE, nps_url, 'NPS')


def nmdot_cams():
    xmin, ymin, xmax, ymax = NMDOT_BBOX
    rows, seen = [], set()
    for c in (fetch_json(NMDOT).get('cameraInfo') or []):
        if not c.get('enabled'):
            continue
        m = NMDOT_SNAP_RE.match(str(c.get('snapshotFile') or '').strip())
        if not m:
            continue
        cid = m.group(1)
        if not NMDOT_ID_RE.match(cid) or cid in seen:
            continue
        try:
            lat, lon = float(c['lat']), float(c['lon'])
        except (KeyError, TypeError, ValueError):
            continue
        if not (ymin <= lat <= ymax and xmin <= lon <= xmax):
            continue
        seen.add(cid)
        title = (c.get('title') or c.get('name') or cid).strip()
        # the state is part of the name: 18 of these sit inside 100 mi of the El Paso anchor and so
        # share its region row, where a bare "I-10 @ Mesquite" would read as the Texas town
        rows.append({'name': f'{title} · New Mexico', 'lat': lat, 'lon': lon, 'id': cid})
    cams, noimg, dead = [], 0, 0
    for c in rows:
        # snapshots are rewritten in place, so a fetch landing mid-write answers 404 or 500 on a
        # live camera; the same retry the proxies use decides liveness here
        age = jpeg_frame_age_twice(NMDOT_IMG.format(id=c['id']))
        if age is None:
            noimg += 1
            continue
        if age > CAM_MAX_AGE_D:
            dead += 1
            continue
        cams.append({'name': c['name'], 'lat': round(c['lat'], 6), 'lon': round(c['lon'], 6), 'id': c['id']})
    print(f'NMDOT: {len(cams)} of {len(rows)} southern New Mexico cameras carry a live frame '
          f'({noimg} serve no dated image, {dead} last posted over {CAM_MAX_AGE_D}d ago)')
    return sorted(cams, key=lambda c: c['name'])


def weatherbug_newest(cid, minutes=WB_PROBE_MINUTES):
    """Newest published frame for a WeatherBug camera as (url, capture-datetime), or None.

    There is no 'latest' URL: the filename is a station-local wall-time stamp to the minute, so
    the newest frame is found by walking back from now. Mirrors the /api/cam/weatherbug proxy.
    """
    now = datetime.now(ZoneInfo(WB_TZ))
    for back in range(1, minutes + 1):  # the current minute is still being written
        t = now - timedelta(minutes=back)
        url = WEATHERBUG_IMG.format(id=cid, y=f'{t:%Y}', m=f'{t:%m}', d=f'{t:%d}', stamp=f'{t:%m%d%Y%H%M}')
        try:
            req = urllib.request.Request(url, headers={'User-Agent': BROWSER_UA})
            req.get_method = lambda: 'HEAD'
            with urllib.request.urlopen(req, timeout=15) as r:
                if r.getcode() == 200 and 'image/jpeg' in (r.headers.get('Content-Type') or '').lower():
                    return url, t
        except (OSError, http.client.HTTPException):
            continue
    return None


def weatherbug_cams():
    txt = fetch_text(WEATHERBUG)
    rows, seen = [], set()
    for m in WB_REC_RE.finditer(txt):
        cid = m.group('id')
        if cid in seen or not WEATHERBUG_ID_RE.match(cid) or m.group('state') != 'Texas':
            continue
        try:
            lat, lon = float(m.group('lat')), float(m.group('lon'))
        except ValueError:
            continue
        if not in_texas(lat, lon):
            continue
        seen.add(cid)
        city, name = m.group('city').strip(), m.group('name').strip()
        rows.append({'name': f'{name} · {city}' if city else name, 'lat': lat, 'lon': lon, 'id': cid})
    cams, dead = [], 0
    for c in rows:
        hit = weatherbug_newest(c['id'])
        if hit is None:
            dead += 1
            print(f"WeatherBug: {c['name']} has no frame in the last {WB_PROBE_MINUTES} min, dropped")
            continue
        cams.append({'name': c['name'], 'lat': round(c['lat'], 6), 'lon': round(c['lon'], 6), 'id': c['id'],
                     'newest': hit[1].astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')})
    print(f'WeatherBug: {len(cams)}/{len(rows)} live Texas cams kept ({dead} with no recent frame)')
    return sorted(cams, key=lambda c: c['name'])


def ozolio_poster_live(url):
    # a head that is down answers with a placeholder far under a real frame, or not at all
    try:
        req = urllib.request.Request(url, headers={'User-Agent': BROWSER_UA})
        with urllib.request.urlopen(req, timeout=25) as r:
            ctype = (r.headers.get('Content-Type') or '').lower()
            return r.getcode() == 200 and 'image/jpeg' in ctype and len(r.read(OZOLIO_MIN_BYTES)) >= OZOLIO_MIN_BYTES
    except (OSError, ValueError, http.client.HTTPException):
        return False


def ozolio_cams(rows, label):
    """Liveness-check a list of {name,lat,lon,oid} Ozolio cameras and emit the live ones."""
    cams = []
    for c in rows:
        if not OZOLIO_OID_RE.match(c['oid']):  # an oid the strict proxy would reject is never emitted
            continue
        if not in_texas(c['lat'], c['lon']):
            continue
        if not live_twice(ozolio_poster_live, OZOLIO_POSTER.format(oid=c['oid'])):
            print(f"{label}: {c['name']} not live, dropped")
            continue
        cams.append({'name': c['name'], 'lat': round(c['lat'], 6), 'lon': round(c['lon'], 6), 'id': c['oid']})
    print(f'{label}: {len(cams)}/{len(rows)} live cams kept')
    return sorted(cams, key=lambda c: c['name'])


def swrecon_cams():
    # Saltwater Recon publishes its own inventory with exact coordinates; the oid is the Ozolio channel
    rows = []
    for c in (fetch_json(SWRECON).get('webcams') or []):
        coords = c.get('coords') or {}
        try:
            lat, lon = float(coords['lat']), float(coords['long'])
        except (KeyError, TypeError, ValueError):
            continue
        oid = str(c.get('id') or '')
        name = (c.get('label') or '').strip()
        city = (c.get('city') or '').strip()
        if not oid or not name:
            continue
        rows.append({'name': f'{name} · {city}' if city else name, 'lat': lat, 'lon': lon, 'oid': oid})
    return ozolio_cams(rows, 'Saltwater Recon')


def corpus_cams():
    return ozolio_cams(list(CORPUS_CAMS), 'Corpus Christi')


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
    prev = load_prev()  # first, so an unreadable baseline aborts before any upstream work
    tx = txdot_cams()
    its, its_carried = its_cams(tx, prev)
    rv = river_cams()
    au = austin_cams()
    af = atxfloods_cams()
    ho = houston_cams()
    ar = arlington_cams()
    elp = elpbridge_cams()  # scoped liveness check — a dead host yields [] here, never aborts the whole gen
    ph = porthou_cams()  # hand-kept, liveness-checked; an offline head serves an empty body and is dropped
    ha = hays_cams()  # liveness-checked hand-list; idle cams serve a placeholder, so this legitimately shrinks toward 0
    sw = swrecon_cams()  # liveness-checked; the operator rotates heads, so a dropped one is normal
    co = corpus_cams()  # hand-placed 4-cam list, liveness-checked
    lu = lubbock_cams()  # inventory is every signal, so the camera set is settled by image + frame age
    wb = weatherbug_cams()  # no 'latest' URL: liveness is a walk back through the minute-stamped filenames
    nm = nmdot_cams()  # clipped to the southern reach; liveness is the frame age on the snapshot host
    np = nps_cams()  # hand-placed 6-cam list; liveness is the frame age on the park still
    la = dated_still_cams(LAREDO_CAMS, LAREDO_ID_RE, lambda i: LAREDO_IMG.format(id=i), 'Laredo bridges')
    ep = dated_still_cams(EAGLEPASS_CAMS, IPCAMLIVE_ID_RE, lambda i: IPCAMLIVE_IMG.format(id=i), 'Eagle Pass bridges')
    dr = dated_still_cams(DELRIO_CAMS, IPCAMLIVE_ID_RE, lambda i: IPCAMLIVE_IMG.format(id=i), 'Del Rio bridge')
    gv = dated_still_cams(GALVESTON_CAMS, GALVESTON_ID_RE, galveston_url, 'Port of Galveston')
    # per-source floors abort a silently-zeroed source; its is the post-dedup residual (shrinks as the streamable set grows), so its floor stays low; the liveness-checked hand-lists sit at 0 because idle heads are expected there and check_no_collapse carries them against the last published count instead
    for name, cams, floor in (('its', its, 300), ('river', rv, 20), ('austin', au, 400), ('atxfloods', af, 10), ('houston', ho, 400), ('arlington', ar, 40), ('elpbridge', elp, 0), ('hays', ha, 0), ('porthou', ph, 0), ('swrecon', sw, 10), ('corpus', co, 0), ('lubbock', lu, 20), ('weatherbug', wb, 5), ('nmdot', nm, 10), ('nps', np, 3), ('laredo', la, 4), ('eaglepass', ep, 2), ('delrio', dr, 1), ('galveston', gv, 0)):
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
            'swrecon': 'Coastal cameras: Saltwater Recon (Gulf Coast webcam network); no capture time published',
            'corpus': 'City cameras: City of Corpus Christi; no capture time published',
            'lubbock': 'Traffic cameras: City of Lubbock, Texas',
            'weatherbug': 'Weather cameras: WeatherBug (Earth Networks) and the hosting sites',
            'nmdot': 'Traffic cameras: New Mexico DOT (NM Roads), southern New Mexico',
            'nps': 'Park cameras: National Park Service (public domain); position is the park facility, not a surveyed camera point',
            'laredo': 'Bridge cameras: City of Laredo (international bridges); position is the bridge, not the camera',
            'eaglepass': 'Bridge cameras: City of Eagle Pass, Port of Eagle Pass; position is the bridge, not the camera',
            'delrio': 'Bridge cameras: City of Del Rio, International Bridge; position is the bridge, not the camera',
            'galveston': 'Port cameras: Port of Galveston (hosted by EarthCam)',
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
        'swrecon': sw,
        'corpus': co,
        'lubbock': lu,
        'weatherbug': wb,
        'nmdot': nm,
        'nps': np,
        'laredo': la,
        'eaglepass': ep,
        'delrio': dr,
        'galveston': gv,
    }
    check_no_collapse(prev, out)
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
          f'{len(ph)} Port Houston cams, {len(sw)} Saltwater Recon coastal cams, {len(co)} Corpus Christi cams, '
          f'{len(lu)} Lubbock city cams, {len(wb)} WeatherBug cams, {len(nm)} NMDOT cams, {len(np)} NPS park cams, {len(la)} Laredo bridge cams, {len(ep)} Eagle Pass bridge cams, '
          f'{len(dr)} Del Rio bridge cams, {len(gv)} Port of Galveston cams, {os.path.getsize(OUT)} bytes')


if __name__ == '__main__':
    main()
