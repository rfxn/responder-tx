#!/usr/bin/env python3
"""Responder TX LAN server: static files + POST /api/chat|/api/notes|/api/requests -> data/*.jsonl; serves HTTPS on :8443 (self-signed) with an :8080 HTTP->HTTPS redirect when a TLS cert is present, else plain HTTP on :8080."""
import base64
import http.client
import ipaddress
import json
import os
import posixpath
import re
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
INBOX = os.path.join(ROOT, 'data', 'chat-inbox.jsonl')
NOTES_INBOX = os.path.join(ROOT, 'data', 'notes-inbox.jsonl')
CHAT_CURSOR = os.path.join(ROOT, 'data', '.chat-cursor')
CHAT_ACK_CURSOR = os.path.join(ROOT, 'data', '.chat-ack-cursor')
INBOX_ARCHIVE_FMT = os.path.join(ROOT, 'data', 'chat-inbox-archive-%s.jsonl')
INBOX_MAX_BYTES = 2 * 1024 * 1024
INBOX_MAX_LINES = 5000
POST_RATE_BURST = 12  # per-IP token bucket: 12-post burst, then 12/min sustained — a human typing chat never hits it
POST_RATE_PER_SEC = 0.2
NOTE_KINDS = ('marker', 'general', 'comment')
NOTE_CATS = ('info', 'hazard', 'road', 'water', 'photo')
NOTICES_INBOX = os.path.join(ROOT, 'data', 'notices-inbox.jsonl')
NOTICE_TYPES = ('rescue', 'evacuation', 'medical', 'supplies', 'shelter', 'animal',
                'wellness', 'volunteer', 'equipment', 'road', 'cutoff', 'info')
NOTICE_PRIORITIES = ('critical', 'high', 'medium', 'low')
NOTICE_SOURCES = ('x', 'facebook', 'nextdoor', 'news', 'official', 'field')
NOTICE_BBOX = (15.0, 55.0, -130.0, -60.0)  # lat min/max, lon min/max — CONUS-wide sanity fence, not an AO fence
NOTICE_ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{2,47}$')
NOTICE_TS_RE = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$')
TAG_RE = re.compile(r'<[^>]*>')
GAUGE_RE = re.compile(r'^/api/gauge/([A-Za-z0-9]{3,8})/(detail|series)$')
NWPS_BASE = 'https://api.water.noaa.gov/nwps/v1/gauges/'
GAUGE_TTL = 180
CAM_RE = re.compile(r'^/api/cam/([A-Za-z]{3,12})/([^/]{1,200})$')  # {source}/{id}: 3-letter ITS district or a named source
CAM_ICD_RE = re.compile(r"^[A-Za-z0-9 @\-.'_()&,#+]{1,64}$")  # matches gen-cameras.py ITS_ICD_RE — not an open proxy
CAM_DIST_RE = re.compile(r'^[A-Z]{3}$')  # ITS districts route to the base64-JSON upstream
ITS_SNAP = 'https://its.txdot.gov/its/DistrictIts/GetCctvSnapshotByIcdId'
# Strict per-source allowlist for direct-JPEG passthrough — fixed upstream host per key, NOT an open image proxy.
# Each source: (id-validation regex, upstream URL template). Templates use {id}; hays uses a composite
# {pid}-{sid} id the proxy splits into {pid}/{sid} (DriveHQ takes two ids, not one).
CAM_BYTES_SOURCES = {
    'austin': (re.compile(r'^[0-9]{1,8}$'), 'https://cctv.austinmobility.io/image/{id}.jpg'),
    'houston': (re.compile(r'^[0-9]{1,8}$'), 'https://www.houstontranstar.org/snapshots/cctv/{id}.jpg'),
    'arlington': (re.compile(r'^[A-Za-z0-9_-]{1,64}$'), 'https://webapps.arlingtontx.gov/webcams/{id}.jpg'),
    'hays': (re.compile(r'^[0-9]{1,12}-[0-9]{1,12}$'), 'https://cameraftpapi.drivehq.com/api/Camera/GetCameraThumbnail.ashx?parentID={pid}&shareID={sid}'),
}
CAM_UA = 'Mozilla/5.0 (compatible; responder-tx-board/1.0)'  # some CDNs 1010-block the default urllib UA
CAM_TTL = 120
DENY_PREFIXES = ('/.git', '/.rdf', '/.claude')
DENY_DIRS = ('.git', '.rdf', '.claude', '.github', 'docs', 'pkg', 'audit-output')  # dev/working dirs, never served on the LAN
DENY_EXTS = ('.py', '.sh', '.md', '.toml', '.yml', '.yaml')  # source/config/working docs — the app only fetches html/js/css/json/assets/feeds, so denying these blocks git-excluded notes (CLAUDE.md, *-SCOPE.md, BRAND-SPEC.md, etc.) and source (server.py) from LAN clients
DENY_PATHS = ('/data/.chat-cursor', '/data/notes-inbox.jsonl', '/data/notices-inbox.jsonl')  # HANDOFF.md now covered by the .md ext deny; chat-inbox.jsonl stays served so the app can show the owner's own messages (git-ignored; never on the public mirror)
# Master oversight proxy: the LAN board reaches the Cloudflare-only team registry through here so
# the secret admin token stays server-side (env only, never in git or the browser). Unset → the
# master view is disabled (ping.master=false) and the endpoints 503.
TEAM_ADMIN_TOKEN = os.environ.get('TEAM_ADMIN_TOKEN', '')
TEAM_ADMIN_UPSTREAM = os.environ.get('TEAM_ADMIN_UPSTREAM', 'https://respondertx.org').rstrip('/')
ADMIN_RE = re.compile(r'^/api/team/admin/(overview|list)$')
# Non-admin team relay endpoints the LAN board proxies to the Cloudflare backend so team
# create/join/live-position work same-origin on the LAN server (the Durable Object lives ONLY
# on Cloudflare; the LAN server has no DO). Fixed allowlist, never an open proxy; admin
# endpoints stay on the token-gated ADMIN_RE path above.
_TEAM_UUID = r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
TEAM_RE = re.compile(r'^/api/team/(?:create|' + _TEAM_UUID + r'/(?:join|leave|positions|position|marker|unmark|update|state))$')
ADMIN_TTL = 5
# XSS backstop behind esc() at the innerHTML render sites; keep in sync with _headers (public mirror)
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.basemaps.cartocdn.com "
       "https://mesonet.agron.iastate.edu https://*.rainviewer.com https://tiles.arcgis.com "
       "https://maps.water.noaa.gov https://usgs-nims-images.s3.amazonaws.com https://api.atxfloods.com; "
       "connect-src 'self' https://api.weather.gov https://api.water.noaa.gov https://maps.water.noaa.gov "
       "https://waterservices.usgs.gov https://mesonet.agron.iastate.edu https://api.rainviewer.com "
       "https://services5.arcgis.com https://services9.arcgis.com https://feature.geographic.texas.gov "
       "https://nominatim.openstreetmap.org https://overpass-api.de https://api.tidesandcurrents.noaa.gov "
       "https://api.atxfloods.com https://usgs-nims-images.s3.amazonaws.com https://tile.openstreetmap.org "
       "https://*.basemaps.cartocdn.com https://*.skyvdn.com https://zoocams.elpasozoo.org; "
       "media-src 'self' blob: https://*.skyvdn.com https://zoocams.elpasozoo.org; "
       "font-src 'self'; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; "
       "base-uri 'self'; form-action 'self'; frame-ancestors 'self'")
_gauge_cache = {}
_gauge_lock = threading.Lock()
_cam_cache = {}
_cam_lock = threading.Lock()
_admin_cache = {}
_admin_lock = threading.Lock()
_rate_buckets = {}
_rate_lock = threading.Lock()
_inbox_lock = threading.Lock()


def _notice_text(v, cap):
    # tag-strip is a backstop: the board escapes at render, but inbox lines outlive the app
    return TAG_RE.sub('', str(v or '')).strip()[:cap]


def _read_cursor(path):
    try:
        with open(path) as f:
            return int(f.read().strip() or 0)
    except (OSError, ValueError):
        return 0


def _write_cursor(path, n):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        f.write('%d\n' % n)
    os.replace(tmp, path)


def _rotate_inbox_if_due():
    # Rotation rule: only when BOTH cursors equal the current line count (fully drained), then reset both to 0 — otherwise defer, so rotation never strands or replays a message.
    try:
        size = os.path.getsize(INBOX)
        with open(INBOX, 'rb') as f:
            lines = sum(1 for _ in f)
    except OSError:
        return
    if size < INBOX_MAX_BYTES and lines < INBOX_MAX_LINES:
        return
    if _read_cursor(CHAT_CURSOR) != lines or _read_cursor(CHAT_ACK_CURSOR) != lines:
        return
    os.replace(INBOX, INBOX_ARCHIVE_FMT % time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()))
    _write_cursor(CHAT_CURSOR, 0)
    _write_cursor(CHAT_ACK_CURSOR, 0)


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        # LAN-only capability beacon: boot.js loads the chat + master-view UI only when this answers.
        # master is advertised only when the admin token is configured, so the LAN board hides the
        # oversight tool on servers that cannot reach the token-gated registry.
        if self.path == '/api/ping':
            body = json.dumps({'ok': True, 'chat': True, 'notes': True, 'requests': True, 'master': bool(TEAM_ADMIN_TOKEN)}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        m = ADMIN_RE.match(self.path)
        if m:
            if not self._lan_client_allowed():
                self.send_error(403)
                return
            self._admin_proxy(m.group(1))
            return
        if TEAM_RE.match(self.path.split('?', 1)[0]):  # GET /api/team/{id}/state polling carries ?since=
            self._team_proxy()
            return
        m = GAUGE_RE.match(self.path)
        if m:
            self._gauge_proxy(m.group(1).upper(), m.group(2))
            return
        path = self.path.split('?', 1)[0].split('#', 1)[0]  # strip BOTH — translate_path drops query AND fragment
        m = CAM_RE.match(path)
        if m:
            self._cam_proxy(m.group(1), urllib.parse.unquote(m.group(2)))
            return
        # repo internals and agent inboxes must never be served to the LAN. Normalize before the check —
        # super().do_GET() resolves the path NORMALIZED, so a raw-string guard is bypassable (/./.git → /.git)
        norm = posixpath.normpath(urllib.parse.unquote(path))
        if (norm.startswith(DENY_PREFIXES) or norm in DENY_PATHS
                or posixpath.splitext(norm)[1].lower() in DENY_EXTS
                or any(seg in DENY_DIRS for seg in norm.split('/'))):
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

    # Camera snapshot proxy (mirrors functions/api/cam): dispatch by source key to a fixed upstream host.
    # ITS districts decode a base64-JSON JPEG; named sources pass raw JPEG bytes through.
    def _cam_proxy(self, source, cid):
        if CAM_DIST_RE.match(source):
            self._cam_its(source, cid)
        elif source in CAM_BYTES_SOURCES:
            self._cam_bytes(source, cid)
        else:
            self.send_error(404)

    def _cam_cache_put(self, key, entry, now):
        with _cam_lock:
            for k in [k for k, v in _cam_cache.items() if now - v[0] >= CAM_TTL]:
                del _cam_cache[k]  # expired-entry sweep keeps memory bounded to recently viewed cams
            _cam_cache[key] = entry

    # TxDOT ITS: upstream JSON carries a base64 JPEG; serve the raw image with the
    # capture stamp so the viewer never needs CORS
    def _cam_its(self, district, icd):
        if not CAM_ICD_RE.fullmatch(icd):  # fullmatch, not match — $ allows a trailing newline, fullmatch does not
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
                req = urllib.request.Request(url, headers={'Accept': 'application/json', 'User-Agent': CAM_UA})
                with urllib.request.urlopen(req, timeout=15) as r:
                    d = json.loads(r.read())
                jpeg = base64.b64decode(d['snippet'])
                if not jpeg:
                    raise ValueError('empty snapshot')
                stamp = re.sub(r'[^\x20-\x7e]+', ' ', str(d.get('timestampFormatted', ''))).strip()[:64]
            except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException):
                self.send_error(502)
                return
            entry = (now, jpeg, stamp)
            self._cam_cache_put(key, entry, now)
        self._send_jpeg(entry[1], entry[2])

    # Named direct-JPEG source (Austin ATD, …): stream the upstream bytes through, lifting the
    # HTTP Last-Modified date into the capture stamp. Fixed host per key — never an open proxy.
    def _cam_bytes(self, source, cid):
        id_re, tmpl = CAM_BYTES_SOURCES[source]
        if not id_re.fullmatch(cid):  # fullmatch: reject a trailing newline (cid then can't inject a bad URL)
            self.send_error(400)
            return
        key = source + '/' + cid
        now = time.time()
        with _cam_lock:
            hit = _cam_cache.get(key)
        entry = hit if hit and now - hit[0] < CAM_TTL else None
        if entry is None:
            pid, _, sid = cid.partition('-')  # composite id: {pid}-{sid} for hays; single-id sources ignore pid/sid
            url = tmpl.format(id=cid, pid=pid, sid=sid)
            try:
                req = urllib.request.Request(url, headers={'Accept': 'image/jpeg', 'User-Agent': CAM_UA})
                with urllib.request.urlopen(req, timeout=15) as r:
                    jpeg = r.read()
                    ctype = r.headers.get('Content-Type', '')
                    stamp = re.sub(r'[^\x20-\x7e]+', ' ', str(r.headers.get('Last-Modified', ''))).strip()[:64]
                if not jpeg or 'image' not in ctype.lower():
                    raise ValueError('not an image')
            except (OSError, ValueError, http.client.HTTPException):
                self.send_error(502)
                return
            entry = (now, jpeg, stamp)
            self._cam_cache_put(key, entry, now)
        self._send_jpeg(entry[1], entry[2])

    def _send_jpeg(self, jpeg, stamp):
        self.send_response(200)
        self.send_header('Content-Type', 'image/jpeg')
        self.send_header('X-Cam-Captured', stamp)
        self.send_header('Content-Length', str(len(jpeg)))
        self.end_headers()
        self.wfile.write(jpeg)

    # Gate LAN-only proxies (master-oversight fan-out AND the team relay passthrough) to
    # LAN/loopback clients. Blocks internet-facing pulls if the host has a public IP; a peer on the
    # same private subnet is a known, accepted limitation. Unwrap IPv4-mapped IPv6 for pre-3.13
    # is_private correctness.
    def _lan_client_allowed(self):
        try:
            ip = ipaddress.ip_address(self.client_address[0])
        except ValueError:
            return False
        mapped = getattr(ip, 'ipv4_mapped', None)
        if mapped is not None:
            ip = mapped
        return ip.is_private or ip.is_loopback or ip.is_link_local

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

    # Team relay passthrough → Cloudflare. The Durable Object backend lives only on Cloudflare, so on
    # the LAN server the same-origin /api/team/* calls the board makes have nowhere to land (they 404,
    # which surfaces as "Could not create the team."). Forward the allowlisted non-admin endpoints
    # verbatim (method + body + Content-Type), no admin token, LAN clients only — these are the same
    # public endpoints anyone hits on respondertx.org, so this adds no capability, just reachability.
    def _team_proxy(self):
        if not self._lan_client_allowed():
            self.send_error(403)
            return
        method = self.command
        body = None
        if method in ('POST', 'PUT'):
            try:
                n = int(self.headers.get('Content-Length', 0) or 0)
            except ValueError:
                self.send_error(400)
                return
            if not 0 <= n <= 65536:
                self.send_error(413)
                return
            body = self.rfile.read(n) if n else b''
        headers = {'Accept': 'application/json', 'User-Agent': 'responder-tx-lan/team-proxy'}  # Cloudflare 1010-blocks the default Python-urllib UA
        if body is not None:
            headers['Content-Type'] = self.headers.get('Content-Type', 'application/json')
        try:
            req = urllib.request.Request(TEAM_ADMIN_UPSTREAM + self.path, data=body, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=15) as r:
                resp, status, ctype = r.read(), r.status, r.headers.get('Content-Type', 'application/json')
        except urllib.error.HTTPError as e:  # surface the relay's status + JSON body (404 unknown team, 400 bad input, 503 relay down)
            resp, status = e.read(), e.code
            ctype = e.headers.get('Content-Type', 'application/json') if e.headers else 'application/json'
        except OSError:
            self.send_error(502)
            return
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(resp)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(resp)

    def do_POST(self):
        if self.path in ('/api/chat', '/api/notes', '/api/requests'):
            # same client gate as the team/master proxies — the inbox feeds a build-capable session, so non-LAN writes are refused
            if not self._lan_client_allowed():
                self._reject_post(403, 'client not LAN/loopback')
                return
            if not self._post_rate_ok():
                self._reject_post(429, 'rate limited')
                return
            if self.path == '/api/chat':
                self._append_chat()
            elif self.path == '/api/requests':
                self._append_request()
            else:
                self._append_note()
        elif TEAM_RE.match(self.path.split('?', 1)[0]):
            self._team_proxy()
        else:
            self.send_error(404)

    def _reject_post(self, code, why):
        sys.stderr.write('%s blocked POST %s from %s: %s\n' % (
            time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), self.path, self.client_address[0], why))
        self.send_error(code)

    def _post_rate_ok(self):
        ip = self.client_address[0]
        now = time.time()
        with _rate_lock:
            for k in [k for k, v in _rate_buckets.items() if now - v[1] > 300]:
                del _rate_buckets[k]  # idle-bucket sweep keeps memory bounded
            tokens, last = _rate_buckets.get(ip, (float(POST_RATE_BURST), now))
            tokens = min(float(POST_RATE_BURST), tokens + (now - last) * POST_RATE_PER_SEC)
            allowed = tokens >= 1
            _rate_buckets[ip] = (tokens - 1 if allowed else tokens, now)
        return allowed

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
            with _inbox_lock:
                _rotate_inbox_if_due()
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

    # Shared multi-operator notice intake: the '+ New notice' form on a LAN board POSTs its
    # notice here; gen-notices.py folds accepted lines into data/requests.json each cycle so
    # every station sees every station's intakes. Validation mirrors _append_note.
    def _append_request(self):
        try:
            d = self._read_body()
            if d is None:
                return
            summary = _notice_text(d.get('summary'), 300)
            place = _notice_text(d.get('place'), 120)
            if not summary or not place:
                self.send_error(400)
                return
            rid = str(d.get('id', '')).strip()
            if not NOTICE_ID_RE.match(rid):
                rid = 'r-%x' % int(time.time() * 1000)
            now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            ts = str(d.get('ts', '')).strip()[:32]
            if not NOTICE_TS_RE.match(ts):
                ts = now
            src = d.get('source') if isinstance(d.get('source'), dict) else {}
            url = str(src.get('url', '')).strip()[:300]
            if url and not url.lower().startswith(('http://', 'https://')):
                url = ''
            entry = {
                'received_at': now,
                'ts': ts,
                'id': rid,
                'type': d.get('type') if d.get('type') in NOTICE_TYPES else 'info',
                'priority': d.get('priority') if d.get('priority') in NOTICE_PRIORITIES else 'medium',
                'status': 'open',
                'county': _notice_text(d.get('county'), 40) or 'Unknown',
                'place': place,
                'summary': summary,
                'details': _notice_text(d.get('details'), 2000),
                'source': {'platform': src.get('platform') if src.get('platform') in NOTICE_SOURCES else 'field',
                           'handle': _notice_text(src.get('handle'), 80), 'url': url},
                'contact': _notice_text(d.get('contact'), 80),
            }
            lat, lon = d.get('lat'), d.get('lon')
            if lat is not None or lon is not None:
                lat, lon = float(lat), float(lon)  # one-sided/non-numeric coords raise -> 400
                if not (NOTICE_BBOX[0] <= lat <= NOTICE_BBOX[1] and NOTICE_BBOX[2] <= lon <= NOTICE_BBOX[3]):
                    self.send_error(400)
                    return
                entry['lat'], entry['lon'] = round(lat, 5), round(lon, 5)
            radius = d.get('radiusMi')
            if isinstance(radius, (int, float)) and not isinstance(radius, bool) and 0 < radius <= 100:
                entry['radiusMi'] = round(float(radius), 1)
            self._append_line(NOTICES_INBOX, entry)
        except (ValueError, TypeError, OSError):
            self.send_error(400)

    def end_headers(self):
        # data + api must never be cached — live board state
        if self.path.startswith('/data/') or self.path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Security-Policy', CSP)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'strict-origin-when-cross-origin')
        self.send_header('X-Frame-Options', 'SAMEORIGIN')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # LAN ops traffic — request logging is noise


class RedirectHandler(BaseHTTPRequestHandler):
    """Plain-HTTP listener that 301-redirects every request to the HTTPS port. Serves no files."""
    def _redirect(self):
        host = self.headers.get('Host', '') or '127.0.0.1'
        if host.startswith('['):
            host = host.split(']', 1)[0] + ']'  # IPv6 literal: keep the bracketed host, drop :port
        else:
            host = host.split(':', 1)[0]
        https_port = os.environ.get('HTTPS_PORT', '8443')
        self.send_response(301)
        self.send_header('Location', 'https://%s:%s%s' % (host, https_port, self.path))
        self.send_header('Content-Length', '0')
        self.end_headers()

    do_GET = _redirect
    do_HEAD = _redirect
    do_POST = _redirect

    def log_message(self, fmt, *args):
        pass  # LAN ops traffic — request logging is noise


class TLSServer(ThreadingHTTPServer):
    # TLS handshake runs in the per-connection worker thread, never the accept loop. Wrapping the
    # LISTENING socket makes accept() block on the handshake, so one slow or non-TLS client (e.g.
    # plain HTTP sent to the HTTPS port) would freeze the whole server. do_handshake_on_connect=False
    # defers the handshake to first I/O in the thread; the socket timeout bounds a stalled client.
    def __init__(self, addr, handler, ssl_ctx):
        self.ssl_ctx = ssl_ctx
        super().__init__(addr, handler)

    def get_request(self):
        sock, addr = self.socket.accept()
        sock.settimeout(30)
        return self.ssl_ctx.wrap_socket(sock, server_side=True, do_handshake_on_connect=False), addr

    def handle_error(self, request, client_address):
        # a non-TLS or stalled client (port scan, plain HTTP to the HTTPS port) fails the handshake
        # in its own thread — swallow the expected connection-level noise instead of logging a
        # traceback per hit; anything unexpected still surfaces
        if isinstance(sys.exc_info()[1], (ssl.SSLError, ConnectionError, TimeoutError)):
            return
        super().handle_error(request, client_address)


if __name__ == '__main__':
    os.chdir(ROOT)
    port = int(os.environ.get('PORT', '8080'))
    https_port = int(os.environ.get('HTTPS_PORT', '8443'))
    cert = os.environ.get('RESPONDER_TLS_CERT', '/root/.config/responder/tls/cert.pem')
    key = os.environ.get('RESPONDER_TLS_KEY', '/root/.config/responder/tls/key.pem')

    if os.access(cert, os.R_OK) and os.access(key, os.R_OK):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        https_server = TLSServer(('0.0.0.0', https_port), Handler, ctx)
        redirect_server = ThreadingHTTPServer(('0.0.0.0', port), RedirectHandler)
        print('Responder LAN server: HTTPS on :%d, HTTP->HTTPS redirect on :%d' % (https_port, port))
        threading.Thread(target=redirect_server.serve_forever, daemon=True).start()
        https_server.serve_forever()
    else:
        print('Responder LAN server: HTTPS disabled (no readable cert at %s); plain HTTP on :%d' % (cert, port))
        ThreadingHTTPServer(('0.0.0.0', port), Handler).serve_forever()
