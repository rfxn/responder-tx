#!/usr/bin/env python3
"""tests/server-gate.test.py — LAN write-endpoint hardening tests for server.py.
Covers: the POST client gate (LAN/loopback allowed, public rejected), the per-IP
token-bucket rate limit (13th rapid post blocked, slow posting never blocked),
drained-only inbox rotation with coherent cursor reset, live loopback round-trips
on an ephemeral port, and /api/requests notice-intake validation (field caps,
tag stripping, bbox, rate limit). Run: python3 tests/server-gate.test.py"""
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import server

FAILS = 0


def check(name, ok):
    global FAILS
    print('%s: %s' % ('PASS' if ok else 'FAIL', name))
    if not ok:
        FAILS += 1


def make_handler(ip, path='/api/chat'):
    h = object.__new__(server.Handler)
    h.client_address = (ip, 40000)
    h.path = path
    h.command = 'POST'
    h.sent = []
    h.send_error = lambda code, msg=None: h.sent.append(code)
    return h


# --- client gate: address classes must mirror the team-proxy gate ---
for ip, want in [('127.0.0.1', True), ('192.168.2.50', True), ('10.0.0.5', True),
                 ('172.16.4.9', True), ('169.254.1.1', True), ('::1', True),
                 ('::ffff:192.168.2.50', True), ('8.8.8.8', False),
                 ('::ffff:8.8.8.8', False), ('2001:4860::1', False), ('bogus', False)]:
    got = server.Handler._lan_client_allowed(make_handler(ip))
    check('gate %s -> %s' % (ip, 'allow' if want else 'reject'), got is want)

# --- do_POST rejects a non-LAN client with 403 before reading any body ---
h = make_handler('8.8.8.8', '/api/chat')
server.Handler.do_POST(h)
check('do_POST /api/chat from 8.8.8.8 -> 403', h.sent == [403])
h = make_handler('93.184.216.34', '/api/notes')
server.Handler.do_POST(h)
check('do_POST /api/notes from 93.184.216.34 -> 403', h.sent == [403])

# --- rate limiter: burst of 12 allowed, 13th blocked, refill unblocks ---
server._rate_buckets.clear()
h = make_handler('192.168.1.77')
results = [server.Handler._post_rate_ok(h) for _ in range(13)]
check('rate: first 12 rapid posts allowed', all(results[:12]))
check('rate: 13th rapid post blocked', results[12] is False)
tokens, last = server._rate_buckets['192.168.1.77']
server._rate_buckets['192.168.1.77'] = (tokens, last - 10)  # simulate 10s of quiet -> 2 tokens refill
check('rate: slow posting not blocked after refill', server.Handler._post_rate_ok(h) is True)
server._rate_buckets.clear()

# --- rotation: fires only when both cursors equal the line count, resets both ---
tmp = tempfile.mkdtemp()
orig = (server.INBOX, server.CHAT_CURSOR, server.CHAT_ACK_CURSOR, server.INBOX_ARCHIVE_FMT,
        server.INBOX_MAX_LINES, server.NOTICES_INBOX)
try:
    server.NOTICES_INBOX = os.path.join(tmp, 'notices-inbox.jsonl')
    server.INBOX = os.path.join(tmp, 'chat-inbox.jsonl')
    server.CHAT_CURSOR = os.path.join(tmp, '.chat-cursor')
    server.CHAT_ACK_CURSOR = os.path.join(tmp, '.chat-ack-cursor')
    server.INBOX_ARCHIVE_FMT = os.path.join(tmp, 'chat-inbox-archive-%s.jsonl')
    server.INBOX_MAX_LINES = 5

    def seed(lines, cursor, ack):
        with open(server.INBOX, 'w') as f:
            for i in range(lines):
                f.write(json.dumps({'ts': 'T', 'role': 'user', 'text': 'm%d' % i}) + '\n')
        with open(server.CHAT_CURSOR, 'w') as f:
            f.write('%d\n' % cursor)
        with open(server.CHAT_ACK_CURSOR, 'w') as f:
            f.write('%d\n' % ack)

    def archives():
        return [p for p in os.listdir(tmp) if p.startswith('chat-inbox-archive-')]

    seed(5, 5, 5)  # at threshold, fully drained -> rotate
    server._rotate_inbox_if_due()
    check('rotation: fires when drained at threshold', not os.path.exists(server.INBOX) and len(archives()) == 1)
    check('rotation: archive keeps all 5 lines', sum(1 for _ in open(os.path.join(tmp, archives()[0]))) == 5)
    check('rotation: both cursors reset to 0',
          server._read_cursor(server.CHAT_CURSOR) == 0 and server._read_cursor(server.CHAT_ACK_CURSOR) == 0)
    for p in archives():
        os.unlink(os.path.join(tmp, p))

    seed(6, 4, 6)  # main cursor behind -> undrained, must defer
    server._rotate_inbox_if_due()
    check('rotation: deferred when .chat-cursor behind', os.path.exists(server.INBOX) and not archives())
    check('rotation: cursors untouched on defer',
          server._read_cursor(server.CHAT_CURSOR) == 4 and server._read_cursor(server.CHAT_ACK_CURSOR) == 6)

    seed(6, 6, 5)  # ack cursor behind -> defer too
    server._rotate_inbox_if_due()
    check('rotation: deferred when .chat-ack-cursor behind', os.path.exists(server.INBOX) and not archives())

    seed(3, 3, 3)  # under threshold -> never rotates
    server._rotate_inbox_if_due()
    check('rotation: no-op under threshold', os.path.exists(server.INBOX) and not archives())

    # --- live loopback round-trip: allowed client posts land; limiter answers 429 over HTTP ---
    server._rate_buckets.clear()
    srv = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        seed(0, 0, 0)
        os.unlink(server.INBOX)

        def post(text):
            body = json.dumps({'text': text}).encode()
            req = urllib.request.Request('http://127.0.0.1:%d/api/chat' % port, data=body,
                                         headers={'Content-Type': 'application/json'})
            try:
                with urllib.request.urlopen(req, timeout=5) as r:
                    return r.status
            except urllib.error.HTTPError as e:
                return e.code

        check('live: loopback POST /api/chat -> 204', post('gate test message') == 204)
        check('live: message appended to inbox',
              os.path.exists(server.INBOX) and 'gate test message' in open(server.INBOX).read())
        codes = [post('burst %d' % i) for i in range(12)]
        check('live: 13th rapid post over HTTP -> 429', codes[:11] == [204] * 11 and codes[11] == 429)
        req = urllib.request.Request('http://127.0.0.1:%d/api/ping' % port)
        with urllib.request.urlopen(req, timeout=5) as r:
            ping = json.loads(r.read())
            check('live: GET /api/ping still 200', r.status == 200 and ping['ok'] is True)
            check('live: /api/ping advertises requests capability', ping.get('requests') is True)

        # --- /api/requests: shared notice intake — gate, validation, caps, tag strip, bbox, rate limit ---
        h = make_handler('8.8.8.8', '/api/requests')
        server.Handler.do_POST(h)
        check('requests: non-LAN POST -> 403', h.sent == [403])
        server._rate_buckets.clear()

        def post_req(payload):
            body = json.dumps(payload).encode()
            req = urllib.request.Request('http://127.0.0.1:%d/api/requests' % port, data=body,
                                         headers={'Content-Type': 'application/json'})
            try:
                with urllib.request.urlopen(req, timeout=5) as r:
                    return r.status
            except urllib.error.HTTPError as e:
                return e.code

        def last_line():
            return json.loads(open(server.NOTICES_INBOX).read().splitlines()[-1])

        notice = {'id': 'local-abc-1234', 'ts': '2026-07-24T18:00:00.000Z', 'type': 'road',
                  'priority': 'high', 'status': 'open', 'county': 'Hays', 'place': 'Test crossing',
                  'lat': 29.9, 'lon': -97.9, 'summary': 'Gate-test notice', 'details': 'water over road',
                  'source': {'platform': 'field', 'handle': '', 'url': ''}, 'contact': ''}
        check('requests: valid intake -> 204', post_req(notice) == 204)
        line = last_line()
        check('requests: line keeps client id + ts and adds received_at',
              line['id'] == 'local-abc-1234' and line['ts'].startswith('2026-07-24T18:00')
              and bool(line.get('received_at')) and line['status'] == 'open')
        check('requests: html stripped from text fields',
              post_req(dict(notice, id='local-abc-9999', summary='before <script>x</script>after')) == 204
              and last_line()['summary'] == 'before xafter')
        check('requests: overlong summary truncated to cap',
              post_req(dict(notice, id='local-cap-0001', summary='S' * 500)) == 204
              and len(last_line()['summary']) == 300)
        check('requests: markup-only summary -> 400', post_req(dict(notice, summary='<b></b>')) == 400)
        check('requests: missing place -> 400',
              post_req({k: v for k, v in notice.items() if k != 'place'}) == 400)
        check('requests: coords outside sane bbox -> 400', post_req(dict(notice, lat=61.0)) == 400)
        check('requests: one-sided coords -> 400', post_req(dict(notice, lon=None)) == 400)
        check('requests: pinless (null coords) intake -> 204',
              post_req(dict(notice, id='local-nopin-01', lat=None, lon=None)) == 204
              and 'lat' not in last_line())
        check('requests: oversize body -> 413', post_req(dict(notice, details='x' * 70000)) == 413)
        server._rate_buckets.clear()
        codes = [post_req(dict(notice, id='local-burst-%03d' % i)) for i in range(13)]
        check('requests: 13th rapid post -> 429', codes[:12] == [204] * 12 and codes[12] == 429)
    finally:
        srv.shutdown()
        srv.server_close()
finally:
    (server.INBOX, server.CHAT_CURSOR, server.CHAT_ACK_CURSOR, server.INBOX_ARCHIVE_FMT,
     server.INBOX_MAX_LINES, server.NOTICES_INBOX) = orig
    server._rate_buckets.clear()
    shutil.rmtree(tmp)

print('---')
if FAILS:
    print('%d FAILURE(S)' % FAILS)
    sys.exit(1)
print('ALL PASS')
