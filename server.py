#!/usr/bin/env python3
"""Responder TX LAN server: static files + POST /api/chat|/api/notes -> data/*.jsonl."""
import base64
import json
import os
import posixpath
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
INBOX = os.path.join(ROOT, 'data', 'chat-inbox.jsonl')
NOTES_INBOX = os.path.join(ROOT, 'data', 'notes-inbox.jsonl')
NOTE_KINDS = ('marker', 'general', 'comment')
NOTE_CATS = ('info', 'hazard', 'road', 'water', 'photo')
GAUGE_RE = re.compile(r'^/api/gauge/([A-Za-z0-9]{3,8})/(detail|series)$')
NWPS_BASE = 'https://api.water.noaa.gov/nwps/v1/gauges/'
GAUGE_TTL = 180
CAM_RE = re.compile(r'^/api/cam/([A-Z]{3})/([^/]{1,200})$')
CAM_ICD_RE = re.compile(r"^[A-Za-z0-9 @\-.'_()&,#+]{1,64}$")  # matches gen-cameras.py ITS_ICD_RE — not an open proxy
ITS_SNAP = 'https://its.txdot.gov/its/DistrictIts/GetCctvSnapshotByIcdId'
CAM_TTL = 120
DENY_PREFIXES = ('/.git', '/.rdf', '/.claude')
DENY_PATHS = ('/HANDOFF.md', '/data/.chat-cursor', '/data/notes-inbox.jsonl')  # inbox served on LAN so the app can show the owner's own messages (git-ignored; never on the public mirror)
# Master oversight proxy: the LAN board reaches the Cloudflare-only team registry through here so
# the secret admin token stays server-side (env only, never in git or the browser). Unset → the
# master view is disabled (ping.master=false) and the endpoints 503.
TEAM_ADMIN_TOKEN = os.environ.get('TEAM_ADMIN_TOKEN', '')
TEAM_ADMIN_UPSTREAM = os.environ.get('TEAM_ADMIN_UPSTREAM', 'https://responder.rfxn.com').rstrip('/')
ADMIN_RE = re.compile(r'^/api/team/admin/(overview|list)$')
ADMIN_TTL = 5
_gauge_cache = {}
_gauge_lock = threading.Lock()
_cam_cache = {}
_cam_lock = threading.Lock()
_admin_cache = {}
_admin_lock = threading.Lock()


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        # LAN-only capability beacon: app.js loads the chat + master-view UI only when this answers.
        # master is advertised only when the admin token is configured, so the LAN board hides the
        # oversight tool on servers that cannot reach the token-gated registry.
        if self.path == '/api/ping':
            body = json.dumps({'ok': True, 'chat': True, 'notes': True, 'master': bool(TEAM_ADMIN_TOKEN)}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        m = ADMIN_RE.match(self.path)
        if m:
            self._admin_proxy(m.group(1))
            return
        m = GAUGE_RE.match(self.path)
        if m:
            self._gauge_proxy(m.group(1).upper(), m.group(2))
            return
        path = self.path.split('?', 1)[0]
        m = CAM_RE.match(path)
        if m:
            self._cam_proxy(m.group(1), urllib.parse.unquote(m.group(2)))
            return
        # repo internals and agent inboxes must never be served to the LAN. Normalize before the check —
        # super().do_GET() resolves the path NORMALIZED, so a raw-string guard is bypassable (/./.git → /.git)
        norm = posixpath.normpath(urllib.parse.unquote(path))
        if norm.startswith(DENY_PREFIXES) or norm in DENY_PATHS or any(seg in ('.git', '.rdf', '.claude') for seg in norm.split('/')):
            self.send_error(404)
            return
        super().do_GET()

    # NWPS hydrograph proxy with a 3-min in-memory cache — popup reopens and
    # multi-viewer LANs stop hammering api.water.noaa.gov (it 429s under load)
    def _gauge_proxy(self, lid, kind):
        key = lid + '/' + kind
        now = time.time()
        with _gauge_lock:
            hit = _gauge_cache.get(key)
        body = hit[1] if hit and now - hit[0] < GAUGE_TTL else None
        if body is None:
            url = NWPS_BASE + lid + ('' if kind == 'detail' else '/stageflow/observed')
            try:
                req = urllib.request.Request(url, headers={'Accept': 'application/json'})
                with urllib.request.urlopen(req, timeout=10) as r:
                    body = r.read()
            except OSError:
                self.send_error(502)
                return
            with _gauge_lock:
                _gauge_cache[key] = (now, body)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # TxDOT ITS snapshot proxy (mirrors functions/api/cam): upstream JSON carries a base64
    # JPEG; serve the raw image with the capture stamp so the viewer never needs CORS
    def _cam_proxy(self, district, icd):
        if not CAM_ICD_RE.match(icd):
            self.send_error(400)
            return
        key = district + '/' + icd
        now = time.time()
        with _cam_lock:
            hit = _cam_cache.get(key)
        entry = hit if hit and now - hit[0] < CAM_TTL else None
        if entry is None:
            url = ITS_SNAP + '?icdId=' + urllib.parse.quote(icd) + '&districtCode=' + district
            try:
                req = urllib.request.Request(url, headers={'Accept': 'application/json'})
                with urllib.request.urlopen(req, timeout=15) as r:
                    d = json.loads(r.read())
                jpeg = base64.b64decode(d['snippet'])
                if not jpeg:
                    raise ValueError('empty snapshot')
                stamp = re.sub(r'[^\x20-\x7e]+', ' ', str(d.get('timestampFormatted', ''))).strip()[:64]
            except (OSError, ValueError, KeyError, TypeError):
                self.send_error(502)
                return
            entry = (now, jpeg, stamp)
            with _cam_lock:
                for k in [k for k, v in _cam_cache.items() if now - v[0] >= CAM_TTL]:
                    del _cam_cache[k]  # expired-entry sweep keeps memory bounded to recently viewed cams
                _cam_cache[key] = entry
        self.send_response(200)
        self.send_header('Content-Type', 'image/jpeg')
        self.send_header('X-Cam-Captured', entry[2])
        self.send_header('Content-Length', str(len(entry[1])))
        self.end_headers()
        self.wfile.write(entry[1])

    # Master oversight proxy → Cloudflare token-gated registry endpoints. Injects the admin token
    # from the server env (never the browser) so the LAN command view is same-origin and secretless.
    # A short cache bounds Cloudflare hits when several command viewers poll the LAN at once.
    def _admin_proxy(self, kind):
        if not TEAM_ADMIN_TOKEN:
            self.send_error(503, 'master oversight not configured')
            return
        now = time.time()
        with _admin_lock:
            hit = _admin_cache.get(kind)
        body = hit[1] if hit and now - hit[0] < ADMIN_TTL else None
        if body is None:
            url = TEAM_ADMIN_UPSTREAM + '/api/team/admin/' + kind
            try:
                req = urllib.request.Request(url, headers={'Accept': 'application/json', 'X-Admin-Token': TEAM_ADMIN_TOKEN, 'User-Agent': 'responder-tx-lan/master-proxy'})  # Cloudflare 1010-blocks the default Python-urllib UA
                with urllib.request.urlopen(req, timeout=15) as r:
                    body = r.read()
            except urllib.error.HTTPError as e:
                self.send_error(e.code)  # surface 403 (token mismatch) / 503 (relay down) to the operator
                return
            except OSError:
                self.send_error(502)
                return
            with _admin_lock:
                _admin_cache[kind] = (now, body)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path == '/api/chat':
            self._append_chat()
        elif self.path == '/api/notes':
            self._append_note()
        else:
            self.send_error(404)

    def _read_body(self):
        # CSRF guard: cross-origin simple requests can't set application/json, and a
        # browser-forged POST carries an Origin that won't match our Host
        ctype = self.headers.get('Content-Type', '')
        if ctype.split(';')[0].strip().lower() != 'application/json':
            self.send_error(415)
            return None
        origin = self.headers.get('Origin')
        if origin and urllib.parse.urlsplit(origin).netloc != self.headers.get('Host', ''):
            self.send_error(403)
            return None
        n = int(self.headers.get('Content-Length', 0))
        if not 0 < n <= 65536:
            self.send_error(413)
            return None
        return json.loads(self.rfile.read(n))

    def _append_line(self, path, entry):
        with open(path, 'a', encoding='utf-8') as f:
            f.write(json.dumps(entry) + '\n')
        self.send_response(204)
        self.end_headers()

    def _append_chat(self):
        try:
            d = self._read_body()
            if d is None:
                return
            text = str(d.get('text', '')).strip()[:4000]
            if not text:
                self.send_error(400)
                return
            entry = {'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'role': 'user', 'text': text}
            self._append_line(INBOX, entry)
        except (ValueError, OSError):
            self.send_error(400)

    def _append_note(self):
        try:
            d = self._read_body()
            if d is None:
                return
            text = str(d.get('text', '')).strip()[:2000]
            if not text:
                self.send_error(400)
                return
            entry = {
                'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'id': str(d.get('id', '')).strip()[:48] or 'n-%x' % int(time.time() * 1000),
                'kind': d.get('kind') if d.get('kind') in NOTE_KINDS else 'general',
                'cat': d.get('cat') if d.get('cat') in NOTE_CATS else 'info',
                'text': text,
                'name': str(d.get('name', '')).strip()[:40],
            }
            if entry['kind'] == 'marker':
                lat, lon = float(d.get('lat')), float(d.get('lon'))
                if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                    self.send_error(400)
                    return
                entry['lat'], entry['lon'] = round(lat, 5), round(lon, 5)
            elif entry['kind'] == 'comment':
                parent = str(d.get('parent', '')).strip()[:48]
                if not parent:
                    self.send_error(400)
                    return
                entry['parent'] = parent
            self._append_line(NOTES_INBOX, entry)
        except (ValueError, TypeError, OSError):
            self.send_error(400)

    def end_headers(self):
        # data + api must never be cached — live board state
        if self.path.startswith('/data/') or self.path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # LAN ops traffic — request logging is noise


if __name__ == '__main__':
    os.chdir(ROOT)
    ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('PORT', '8080'))), Handler).serve_forever()
