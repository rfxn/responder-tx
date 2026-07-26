#!/usr/bin/env python3
"""tests/gen-feeds.test.py — feed.xml + crests.ics against stubbed sources (RESPONDER_ROOT
override, never the real repo root). The rule under test is that an emergency check which never
completed must not reach a subscriber as an all clear: the absence of emergency items IS the
all-clear assertion in RSS, so a failed check has to say so in the feed itself. Also pins the
channel identity, which carries the 911 line. No network: fetch_emergencies' urlopen is stubbed.
Run: python3 tests/gen-feeds.test.py"""
import importlib.util
import inspect
import json
import os
import re
import shutil
import tempfile
import urllib.error
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
GEN = os.path.join(HERE, '..', 'scripts', 'gen-feeds.py')

FAILS = 0


def check(name, ok, detail=''):
    global FAILS
    print('%s: %s%s' % ('PASS' if ok else 'FAIL', name, (' · ' + detail) if (detail and not ok) else ''))
    if not ok:
        FAILS += 1


def load_gen(root):
    os.environ['RESPONDER_ROOT'] = root
    spec = importlib.util.spec_from_file_location('gen_feeds_%d' % id(root), GEN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def gauge(lid, name, obs, crest, when='2026-07-28T00:00:00Z'):
    return {'lid': lid, 'name': name,
            'status': {'observed': {'primary': obs, 'floodCategory': 'no_flooding'},
                       'forecast': {'primary': crest, 'floodCategory': 'major', 'validTime': when}}}


ALERT = {'features': [{'id': 'urn:oid:alert.1',
                       'properties': {'id': 'urn:oid:alert.1', 'areaDesc': 'Travis, TX',
                                      'headline': 'Flash Flood Warning issued.',
                                      'event': 'Flash Flood Warning',
                                      'sent': '2026-07-26T17:00:00Z',
                                      'expires': '2026-07-26T20:00:00Z',
                                      'parameters': {'flashFloodDamageThreat': ['CATASTROPHIC']}}}]}


def seed(root, gauges=(), requests_=()):
    os.makedirs(os.path.join(root, 'data'))
    with open(os.path.join(root, 'data', 'gauges-snapshot.json'), 'w', encoding='utf-8') as f:
        json.dump({'generated': '2026-07-26T17:00:00Z', 'gauges': list(gauges)}, f)
    with open(os.path.join(root, 'data', 'requests.json'), 'w', encoding='utf-8') as f:
        json.dump({'requests': list(requests_)}, f)
    with open(os.path.join(root, 'data', 'event.json'), 'w', encoding='utf-8') as f:
        json.dump({'name': 'Responder TX', 'event': 'Hill Country Floods', 'region': 'Central Texas'}, f)


def run(alerts, gauges=(), requests_=()):
    """Generate with a stubbed NWS response; alerts may be a payload or an exception to raise.
    Returns (module, parsed feed.xml root, crests.ics text)."""
    root = tempfile.mkdtemp(prefix='responder-feeds-test.')
    try:
        seed(root, gauges, requests_)
        g = load_gen(root)

        class Resp:
            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, *a):
                return False

            def read(self_inner):
                return json.dumps(alerts).encode()

        def urlopen(req, timeout=None):
            if isinstance(alerts, Exception):
                raise alerts
            return Resp()

        g.urllib.request.urlopen = urlopen
        g.main()
        with open(os.path.join(root, 'feed.xml'), encoding='utf-8') as f:
            xml = f.read()
        with open(os.path.join(root, 'crests.ics'), encoding='utf-8') as f:
            ics = f.read()
        return g, ET.fromstring(xml), xml, ics
    finally:
        shutil.rmtree(root)


def titles(root):
    return [it.findtext('title', '') for it in root.findall('./channel/item')]


CREST = gauge('TILT2', 'Nueces River near Tilden', 10.83, 23.1)

# ---------------------------------------------------------------------------
# 1. A genuine zero. NWS answered, nothing qualified: the feed carries no emergency item and,
#    crucially, no "unavailable" item either. This is the only case that may read as an all clear.
g, root, xml, ics = run({'features': []}, gauges=[CREST])
zero_titles = titles(root)
check('a genuine zero publishes no emergency item', not any('flash flood ·' in t for t in zero_titles))
check('a genuine zero publishes no unavailability item',
      g.EMERGENCY_UNKNOWN_TITLE not in zero_titles, str(zero_titles))
check('a genuine zero still publishes the rest of the board', any('MAJOR crest' in t for t in zero_titles))

# ---------------------------------------------------------------------------
# 2. A failed check. Every failure mode urlopen/json.load can produce must reach the subscriber as
#    an explicit unknown, never as the silent absence a genuine zero produces.
for label, boom in (('a network error', OSError('connection refused')),
                    ('a timeout', TimeoutError('timed out')),
                    ('an HTTP error', urllib.error.HTTPError('u', 503, 'unavailable', {}, None)),
                    ('a malformed body', ValueError('Expecting value'))):
    g, root, xml, ics = run(boom, gauges=[CREST])
    ts = titles(root)
    check('%s publishes an explicit unavailability item' % label, g.EMERGENCY_UNKNOWN_TITLE in ts, str(ts))
    item = [it for it in root.findall('./channel/item')
            if it.findtext('title', '') == g.EMERGENCY_UNKNOWN_TITLE]
    body = item[0].findtext('description', '') if item else ''
    check('%s says the state is unknown, not clear' % label,
          'not as an all clear' in body and 'cannot say whether' in body, body[:90])
    check('%s still publishes the rest of the board' % label, any('MAJOR crest' in t for t in ts))

# ---------------------------------------------------------------------------
# 3. The two cases must be distinguishable in the artifact a subscriber actually reads. This is the
#    whole point: before this guard both produced a byte-identical zero-emergency feed.
_, zero_root, zero_xml, _ = run({'features': []}, gauges=[CREST])
_, fail_root, fail_xml, _ = run(OSError('down'), gauges=[CREST])
check('a failed check and a genuine zero are not the same artifact', zero_xml != fail_xml)
check('only the failed check names the unavailability',
      g.EMERGENCY_UNKNOWN_TITLE in fail_xml and g.EMERGENCY_UNKNOWN_TITLE not in zero_xml)
check('the failed check carries one extra item, not a wiped feed',
      len(titles(fail_root)) == len(titles(zero_root)) + 1,
      '%d vs %d' % (len(titles(fail_root)), len(titles(zero_root))))

# ---------------------------------------------------------------------------
# 4. A real emergency still publishes, and is not confused with either of the above.
g, root, xml, ics = run(ALERT, gauges=[CREST])
ts = titles(root)
check('a real emergency publishes its item', any('CATASTROPHIC flash flood ·' in t for t in ts), str(ts))
check('a real emergency publishes no unavailability item', g.EMERGENCY_UNKNOWN_TITLE not in ts)
check('a real emergency keeps the 911 instruction', 'call 911' in xml)

# ---------------------------------------------------------------------------
# 5. Channel identity. The channel title and description are the feed's name and its standing
#    disclaimer in every reader; item loops must never overwrite them.
for label, alerts in (('with items', ALERT), ('with no items', {'features': []})):
    _, root, xml, _ = run(alerts, gauges=[CREST])
    ch_title = root.findtext('./channel/title', '')
    ch_desc = root.findtext('./channel/description', '')
    check('the channel title is the board name %s' % label,
          ch_title == 'Responder TX · Hill Country Floods', ch_title)
    check('the channel description carries the 911 line %s' % label,
          'call 911 for emergencies' in ch_desc, ch_desc)
    check('the channel description names the coverage area %s' % label, 'Central Texas' in ch_desc, ch_desc)

# ---------------------------------------------------------------------------
# 6. A source the feed makes claims about must abort rather than publish a thinner picture as
#    current: an unreadable snapshot silently emptied crests.ics and dropped every crest item.
for missing in ('gauges-snapshot.json', 'requests.json'):
    root_dir = tempfile.mkdtemp(prefix='responder-feeds-test.')
    try:
        seed(root_dir, [CREST])
        prev = os.path.join(root_dir, 'feed.xml')
        with open(prev, 'w', encoding='utf-8') as f:
            f.write('<?xml version="1.0"?><rss><channel><title>previous good feed</title></channel></rss>')
        os.remove(os.path.join(root_dir, 'data', missing))
        g = load_gen(root_dir)
        try:
            g.main()
            check('an unreadable %s aborts' % missing, False, 'main() returned normally')
        except SystemExit as e:
            check('an unreadable %s aborts' % missing, e.code != 0)
        with open(prev, encoding='utf-8') as f:
            check('an unreadable %s leaves the previous feed intact' % missing,
                  'previous good feed' in f.read())
    finally:
        shutil.rmtree(root_dir)

# ---------------------------------------------------------------------------
# 7. Wiring and house rules.
g, _, xml, _ = run(OSError('down'), gauges=[CREST])
fe = inspect.getsource(g.fetch_emergencies)
check('fetch_emergencies never returns a bare list',
      'return out, None' in fe and not re.search(r'return out\s*$', fe, re.M), fe)
check('no em-dash reached the feed text', '—' not in xml)
check('the unavailability item points the reader at a real source', 'weather.gov' in xml)

print('----')
print('ALL PASS' if FAILS == 0 else '%d TEST(S) FAILED' % FAILS)
raise SystemExit(1 if FAILS else 0)
