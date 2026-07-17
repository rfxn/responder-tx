#!/usr/bin/env python3
"""Responder TX LAN server: static files + POST /api/chat -> data/chat-inbox.jsonl."""
import json
import os
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
INBOX = os.path.join(ROOT, 'data', 'chat-inbox.jsonl')


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        # LAN-only capability beacon: app.js loads the chat UI only when this answers
        if self.path == '/api/ping':
            body = b'{"ok": true, "chat": true}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def do_POST(self):
        if self.path != '/api/chat':
            self.send_error(404)
            return
        try:
            n = int(self.headers.get('Content-Length', 0))
            if not 0 < n <= 65536:
                self.send_error(413)
                return
            text = str(json.loads(self.rfile.read(n)).get('text', '')).strip()[:4000]
            if not text:
                self.send_error(400)
                return
            entry = {'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'role': 'user', 'text': text}
            with open(INBOX, 'a', encoding='utf-8') as f:
                f.write(json.dumps(entry) + '\n')
            self.send_response(204)
            self.end_headers()
        except (ValueError, OSError):
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
    ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
