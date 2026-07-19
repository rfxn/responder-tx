#!/usr/bin/env python3
"""gen-cameras.py — build data/cameras.json: TxDOT traffic cams (full statewide
MapLarge inventory) plus USGS HIVIS river cams (NIMS API) inside the AO bbox.
Run at build time; the inventory is near-static, so the output is committed.
Stdlib only."""

import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone

BBOX = (-102.0, 28.0, -97.0, 31.1)  # xmin, ymin, xmax, ymax — river-cam clip, matches CONFIG.gaugeBbox
MAPLARGE = 'https://dtx-e-cdn.maplarge.com/Api/ProcessDirect'
NIMS = 'https://api.waterdata.usgs.gov/nims/v0/cameras'
OUT = 'data/cameras.json'
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
    rv = river_cams()
    out = {
        'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'bbox': list(BBOX),
        'attribution': {
            'txdot': 'Traffic cameras: TxDOT (Lonestar/DriveTexas); streams not recorded',
            'river': 'River cameras: USGS HIVIS (public domain, provisional imagery)',
        },
        'txdot': tx,
        'river': rv,
    }
    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
        f.write('\n')
    print(f'{OUT}: {len(tx)} TxDOT cams, {len(rv)} USGS river cams')


if __name__ == '__main__':
    main()
