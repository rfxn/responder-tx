#!/usr/bin/env python3
"""Fold LAN operator intakes (data/notices-inbox.jsonl, written by POST /api/requests)
into data/requests.json so every station on the LAN sees every station's notices.

Operator entries carry origin:"operator" and are re-derived from the whole inbox on
every run: rerun-idempotent, and deleting an inbox line removes its entry. Curated
entries are never touched. No inbox file = no-op. These entries stay LAN-only:
requests.json is not in the cycle commit list and gen-feeds.py excludes them.
"""
import json
import os
import sys

ROOT = os.environ.get('RESPONDER_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REQUESTS = os.path.join(ROOT, 'data', 'requests.json')
INBOX = os.path.join(ROOT, 'data', 'notices-inbox.jsonl')
REQUIRED = ('id', 'ts', 'summary', 'place')


def main():
    if not os.path.exists(INBOX):
        print('gen-notices: no inbox, nothing to merge')
        return 0
    try:
        with open(REQUESTS, encoding='utf-8') as f:
            doc = json.load(f)
    except (OSError, ValueError) as e:
        print('gen-notices: cannot read requests.json (%s); refusing to touch it' % e, file=sys.stderr)
        return 1
    if not isinstance(doc.get('requests'), list):
        print('gen-notices: requests.json has no requests[]; refusing to touch it', file=sys.stderr)
        return 1
    curated = [r for r in doc['requests'] if r.get('origin') != 'operator']
    curated_ids = {r.get('id') for r in curated}
    ops = {}
    skipped = 0
    with open(INBOX, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                skipped += 1
                continue
            if not isinstance(e, dict) or any(not e.get(k) for k in REQUIRED) or e['id'] in curated_ids:
                skipped += 1
                continue
            e = dict(e)
            e['origin'] = 'operator'
            ops[e['id']] = e  # last line wins: a re-posted id updates its entry
    merged = curated + sorted(ops.values(), key=lambda r: r.get('ts', ''), reverse=True)
    if merged == doc['requests']:
        print('gen-notices: %d operator notices already merged (no change)' % len(ops))
        return 0
    doc['requests'] = merged
    tmp = REQUESTS + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(doc, f, indent=1)
        f.write('\n')
    os.replace(tmp, REQUESTS)
    print('gen-notices: merged %d operator notices into requests.json (%d inbox lines skipped)' % (len(ops), skipped))
    return 0


if __name__ == '__main__':
    sys.exit(main())
