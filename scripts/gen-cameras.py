#!/usr/bin/env python3
"""gen-cameras.py — build data/cameras.json: TxDOT traffic cams (full statewide
MapLarge inventory), TxDOT ITS snapshot-only cams (no HLS stream, JPEG stills
via the district ITS API), plus USGS HIVIS river cams (NIMS API) inside the AO
bbox. Run at build time; the inventory is near-static, so the output is
committed. Stdlib only."""

import json
import math
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

BBOX = (-102.0, 28.0, -97.0, 31.1)  # xmin, ymin, xmax, ymax — river-cam clip, matches CONFIG.gaugeBbox
MAPLARGE = 'https://dtx-e-cdn.maplarge.com/Api/ProcessDirect'
NIMS = 'https://api.waterdata.usgs.gov/nims/v0/cameras'
ITS = 'https://its.txdot.gov/its/DistrictIts/GetCctvStatusListByDistrict?districtCode='
ITS_DISTRICTS = ('ABL', 'AMA', 'ATL', 'AUS', 'BMT', 'BRY', 'BWD', 'CHS', 'CRP', 'DAL', 'ELP',
                 'FTW', 'HOU', 'LBB', 'LFK', 'LRD', 'ODA', 'PAR', 'PHR', 'SJT', 'SAT', 'TYL',
                 'WAC', 'WFS', 'YKM')
# must mirror the /api/cam proxy validators (edge + server.py); no '/' — it is the URL path separator
ITS_ICD_RE = re.compile(r"^[A-Za-z0-9 @\-.'_()&,#+]{1,64}$")
ITS_NEAR_M = 150.0  # an ITS cam this close to a MapLarge streamable cam is the same head — streamable wins
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'cameras.json')
PAGE = 1000


def fetch_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'responder-board-gen-cameras'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


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
    xmin, ymin, xmax, ymax = BBOX
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
    return sorted(cams, key=lambda c: c['camId'])


def main():
    tx = txdot_cams()
    its = its_cams(tx)
    rv = river_cams()
    out = {
        'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'bbox': list(BBOX),
        'attribution': {
            'txdot': 'Traffic cameras: TxDOT (Lonestar/DriveTexas + ITS district snapshots); imagery not recorded',
            'river': 'River cameras: USGS HIVIS (public domain, provisional imagery)',
        },
        'txdot': tx + its,
        'river': rv,
    }
    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
        f.write('\n')
    print(f'{OUT}: {len(tx)} TxDOT streamable + {len(its)} ITS snapshot-only cams, {len(rv)} USGS river cams, {os.path.getsize(OUT)} bytes')


if __name__ == '__main__':
    main()
