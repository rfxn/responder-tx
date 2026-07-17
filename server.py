#!/usr/bin/env python3
"""Responder TX LAN server: static files + POST /api/chat|/api/notes -> data/*.jsonl."""
import json
import os
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
INBOX = os.path.join(ROOT, 'data', 'chat-inbox.jsonl')
NOTES_INBOX = os.path.join(ROOT, 'data', 'notes-inbox.jsonl')
NOTE_KINDS = ('marker', 'general', 'comment')
NOTE_CATS = ('info', 'hazard', 'road', 'water', 'photo')


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        # LAN-only capability beacon: app.js loads the chat UI only when this answers
        if self.path == '/api/ping':
            body = b'{"ok": true, "chat": true, "notes": true}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def do_POST(self):
        if self.path == '/api/chat':
            self._append_chat()
        elif self.path == '/api/notes':
            self._append_note()
        else:
            self.send_error(404)

    def _read_body(self):
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
