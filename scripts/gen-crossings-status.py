#!/usr/bin/env python3
"""gen-crossings-status.py — build data/crossing-status.json: low-water crossings that a
Central Texas jurisdiction currently reports as closed or caution, from the ATX Floods
closures feed (same host as the /api/cam/atxfloods camera proxy).

Only the non-open rows are published. The feed's updated_at is the time the record last
CHANGED, not the time it was last confirmed, and most open rows have not been touched in
over a year; publishing those as "open" would assert current passability from a record
nobody has looked at since 2022. A stale closure over-warns, a stale open under-warns, so
only the closures are carried and each one ships the age of its own last change.
Stdlib only."""

import json
import os
import sys
import tempfile
import urllib.request
from datetime import datetime, timezone

ROOT = os.environ.get('RESPONDER_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLOSURES = 'https://api.atxfloods.com/api/closures'
OUT = os.path.join(ROOT, 'data', 'crossing-status.json')
UA = 'responder-board-gen-crossings-status'
KEEP = ('closed', 'caution')  # 'open' is never published: see the module docstring
MAX_ROWS = 2000  # the whole inventory is ~2.5k crossings; a closure list near that is a shape change
TX_MIN_LAT, TX_MAX_LAT, TX_MIN_LON, TX_MAX_LON = 25.0, 37.0, -107.5, -93.0


def fetch_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.loads(r.read())


def iso_utc(stamp):
    """Normalize the feed's ISO stamp to the board's Z form, or None if unparseable."""
    try:
        t = datetime.fromisoformat(str(stamp).replace('Z', '+00:00'))
    except (TypeError, ValueError):
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return t.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def rows(payload):
    if isinstance(payload, list):
        return payload
    for k in ('attributes', 'data', 'closures'):
        v = payload.get(k) if isinstance(payload, dict) else None
        if isinstance(v, list):
            return v
    return []


def crossings():
    out, dropped = [], 0
    for c in rows(fetch_json(CLOSURES)):
        status = str(c.get('status') or '').strip().lower()
        if status not in KEEP:
            continue
        try:
            lat, lon = float(c['lat']), float(c['lon'])
        except (KeyError, TypeError, ValueError):
            dropped += 1
            continue
        if not (TX_MIN_LAT <= lat <= TX_MAX_LAT and TX_MIN_LON <= lon <= TX_MAX_LON):
            dropped += 1  # 0,0 and other placeholder coords cannot be placed on a map
            continue
        name = str(c.get('name') or '').strip()
        if not name:
            dropped += 1
            continue
        out.append({
            'id': str(c.get('id') or ''),
            'name': name,
            'jurisdiction': str(c.get('jurisdiction') or '').strip(),
            'address': str(c.get('address') or '').strip(),
            'comment': str(c.get('comment') or '').strip(),
            'status': status,
            'lat': round(lat, 6),
            'lon': round(lon, 6),
            'changed': iso_utc(c.get('updated_at')),
        })
    out.sort(key=lambda r: (r['status'] != 'closed', r['name']))
    return out, dropped


def main():
    try:
        found, dropped = crossings()
    except Exception as e:  # noqa: BLE001 — never overwrite a good file with a failed fetch
        sys.exit(f'gen-crossings-status: closures fetch failed: {e}')
    if len(found) > MAX_ROWS:
        sys.exit(f'gen-crossings-status: {len(found)} closures over the {MAX_ROWS} cap — '
                 f'upstream shape change? refusing to overwrite {OUT}')
    newest = max((r['changed'] for r in found if r['changed']), default=None)
    out = {
        'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        # the feed carries no per-record confirmation time; 'changed' is when the record last
        # moved, which is what the layer subtitle tells the reader it is
        'currency': 'record-change',
        'newestChange': newest,
        'attribution': 'Low-water crossing status: reporting jurisdictions via ATX Floods, '
                       'a service of Beholder Technology, LLC',
        'source': 'https://atxfloods.com/',
        'crossings': found,
    }
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(OUT), prefix='.crossing-status.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(out, f, separators=(',', ':'))
            f.write('\n')
        os.replace(tmp, OUT)
    except Exception:  # noqa: BLE001, cleanup: drop the temp file, then re-raise
        os.unlink(tmp)
        raise
    closed = sum(1 for r in found if r['status'] == 'closed')
    print(f'{OUT}: {len(found)} reported crossings ({closed} closed, {len(found) - closed} caution), '
          f'{dropped} dropped with no usable position or name, newest record change {newest}')


if __name__ == '__main__':
    main()
