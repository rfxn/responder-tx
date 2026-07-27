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

# tests/fixtures/alert-tornado-pds.json is a Tornado Warning captured verbatim from
# api.weather.gov: a real polygon, a real senderName, tornadoDamageThreat CONSIDERABLE and the PDS
# sentence in the warning text. The emergency variant below raises only the damage threat to
# CATASTROPHIC, which is exactly the one field NWS changes to declare a tornado emergency.
with open(os.path.join(HERE, 'fixtures', 'alert-tornado-pds.json'), encoding='utf-8') as _f:
    TORNADO_PDS_FEATURE = json.load(_f)


with open(os.path.join(HERE, 'fixtures', 'alerts-tornado-lifecycle.json'), encoding='utf-8') as _f:
    TORNADO_PLAIN_FEATURE = json.load(_f)['features'][0]  # a real tornado warning with no PDS and no damage tag


def tornado_feature(threat, ident='urn:oid:tornado.1'):
    f = json.loads(json.dumps(TORNADO_PDS_FEATURE))
    f['id'] = ident
    f['properties']['id'] = ident
    f['properties']['parameters']['tornadoDamageThreat'] = [threat]
    return f


TORNADO_EMERGENCY = {'features': [tornado_feature('CATASTROPHIC')]}
TORNADO_PDS = {'features': [tornado_feature('CONSIDERABLE')]}
TORNADO_PLAIN = {'features': [TORNADO_PLAIN_FEATURE]}


def seed(root, gauges=(), requests_=()):
    os.makedirs(os.path.join(root, 'data'))
    with open(os.path.join(root, 'data', 'gauges-snapshot.json'), 'w', encoding='utf-8') as f:
        json.dump({'generated': '2026-07-26T17:00:00Z', 'gauges': list(gauges)}, f)
    with open(os.path.join(root, 'data', 'requests.json'), 'w', encoding='utf-8') as f:
        json.dump({'requests': list(requests_)}, f)
    with open(os.path.join(root, 'data', 'event.json'), 'w', encoding='utf-8') as f:
        json.dump({'name': 'Responder TX', 'event': 'Hill Country Floods', 'region': 'Central Texas'}, f)


def run(alerts, gauges=(), requests_=(), tornado=None):
    """Generate with stubbed NWS responses; each of alerts (the flash flood check) and tornado (the
    tornado check) may be a payload or an exception to raise, and they are answered independently so
    one check failing cannot be mistaken for the other. tornado defaults to a genuine zero.
    Returns (module, parsed feed.xml root, feed.xml text, crests.ics text)."""
    root = tempfile.mkdtemp(prefix='responder-feeds-test.')
    tornado = {'features': []} if tornado is None else tornado
    try:
        seed(root, gauges, requests_)
        g = load_gen(root)
        g.time.sleep = lambda _s: None  # the retry backoff is real; paying it here would only slow the suite

        class Resp:
            def __init__(self_inner, payload):
                self_inner.payload = payload

            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, *a):
                return False

            def read(self_inner):
                return json.dumps(self_inner.payload).encode()

        def urlopen(req, timeout=None):
            answer = tornado if 'Tornado' in req.full_url else alerts
            if isinstance(answer, Exception):
                raise answer
            return Resp(answer)

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
# 4b. Tornado emergencies and PDS tornado warnings (v0.99.59). Same discipline as the flash flood
#     check and a SEPARATE one: two products, two requests, two ways to be unknown. Conflating them
#     would let a working flash flood check vouch for a tornado check that never completed.
g, root, xml, ics = run({'features': []}, gauges=[CREST], tornado=TORNADO_EMERGENCY)
ts = titles(root)
check('a tornado emergency publishes its item', any(t.startswith('TORNADO EMERGENCY · ') for t in ts), str(ts))
check('a tornado emergency names the tornado warning it rides on', any('tornado warning' in t for t in ts), str(ts))
check('a tornado emergency publishes no unavailability item',
      g.TORNADO_UNKNOWN_TITLE not in ts and g.EMERGENCY_UNKNOWN_TITLE not in ts, str(ts))
check('a tornado emergency tells the reader to shelter', 'Take shelter now' in xml)

g, root, xml, ics = run({'features': []}, gauges=[CREST], tornado=TORNADO_PDS)
ts = titles(root)
check('a PDS tornado warning publishes its item',
      any(t.startswith('PARTICULARLY DANGEROUS SITUATION · ') for t in ts), str(ts))
check('a PDS tornado warning is not labelled a tornado emergency',
      not any('TORNADO EMERGENCY' in t for t in ts), str(ts))

g, root, xml, ics = run({'features': []}, gauges=[CREST], tornado=TORNADO_PLAIN)
ts = titles(root)
check('an ordinary tornado warning is not published as an emergency or a PDS',
      not any('tornado warning' in t for t in ts), str(ts))
check('an ordinary tornado warning publishes no unavailability item', g.TORNADO_UNKNOWN_TITLE not in ts)

# the two checks fail independently, and each failure must name its own product
for label, alerts, tornado, want, unwanted in (
        ('the tornado check alone', {'features': []}, OSError('down'),
         g.TORNADO_UNKNOWN_TITLE, g.EMERGENCY_UNKNOWN_TITLE),
        ('the flash flood check alone', OSError('down'), {'features': []},
         g.EMERGENCY_UNKNOWN_TITLE, g.TORNADO_UNKNOWN_TITLE)):
    _, root_i, xml_i, _ = run(alerts, gauges=[CREST], tornado=tornado)
    ts = titles(root_i)
    check('%s failing publishes its own unknown item' % label, want in ts, str(ts))
    check('%s failing does not claim the other check failed' % label, unwanted not in ts, str(ts))
    check('%s failing still publishes the rest of the board' % label, any('MAJOR crest' in t for t in ts))

_, root_both, xml_both, _ = run(OSError('down'), gauges=[CREST], tornado=OSError('down'))
ts = titles(root_both)
check('both checks failing publishes both unknown items',
      g.EMERGENCY_UNKNOWN_TITLE in ts and g.TORNADO_UNKNOWN_TITLE in ts, str(ts))
item = [it for it in root_both.findall('./channel/item')
        if it.findtext('title', '') == g.TORNADO_UNKNOWN_TITLE][0]
body = item.findtext('description', '')
check('the tornado unknown item says the state is unknown, not clear',
      'not as an all clear' in body and 'tornado emergency' in body, body[:120])
check('the two unknown items carry distinct guids',
      len({it.findtext('guid', '') for it in root_both.findall('./channel/item')
           if it.findtext('title', '') in (g.EMERGENCY_UNKNOWN_TITLE, g.TORNADO_UNKNOWN_TITLE)}) == 2)

# a genuine zero on both checks: neither unknown item, and no invented tornado item
_, root_z, xml_z, _ = run({'features': []}, gauges=[CREST], tornado={'features': []})
ts = titles(root_z)
check('a genuine zero on the tornado check publishes no unavailability item',
      g.TORNADO_UNKNOWN_TITLE not in ts, str(ts))
check('a genuine zero on the tornado check publishes no tornado item',
      not any('tornado' in t.lower() for t in ts), str(ts))
check('a failed tornado check and a genuine zero are not the same artifact', xml_z != xml_both)

# Volume. The feed caps its item count and sorts by time, so a day with more crests than the cap
# would silently push a tornado emergency out. Every crest below forecasts MAJOR, so all of them
# qualify: enough to make the cap bite by a wide margin.
NOISY_CRESTS = [gauge('NZ%03d' % i, 'Noise Creek %d' % i, 3.0, 30.0,
                      when='2026-07-2%dT0%d:00:00Z' % (8 + i // 500, i % 10)) for i in range(60)]
_, root_n, xml_n, _ = run(ALERT, gauges=NOISY_CRESTS, tornado=TORNADO_EMERGENCY)
ts = titles(root_n)
crest_titles = [t for t in ts if 'MAJOR crest' in t]
check('the volume fixture is over the cap, so this case is not vacuous',
      len(NOISY_CRESTS) + 2 > g.MAX_ITEMS, '%d crests vs a cap of %d' % (len(NOISY_CRESTS), g.MAX_ITEMS))
check('the feed still caps its item count', len(ts) == g.MAX_ITEMS, str(len(ts)))
check('the cap actually cut, so the survival checks below mean something',
      len(crest_titles) < len(NOISY_CRESTS), '%d of %d crests kept' % (len(crest_titles), len(NOISY_CRESTS)))
check('a tornado emergency survives the item cap on a busy day',
      any(t.startswith('TORNADO EMERGENCY · ') for t in ts), str(len(ts)))
check('a flash flood emergency survives the item cap on a busy day',
      any('CATASTROPHIC flash flood ·' in t for t in ts), str(len(ts)))
_, root_nf, xml_nf, _ = run(OSError('down'), gauges=NOISY_CRESTS, tornado=OSError('down'))
tsf = titles(root_nf)
check('both unknown notices survive the item cap on a busy day',
      g.EMERGENCY_UNKNOWN_TITLE in tsf and g.TORNADO_UNKNOWN_TITLE in tsf, str(len(tsf)))

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
check('no em-dash reached the feed text', '—' not in xml)
check('the unavailability item points the reader at a real source', 'weather.gov' in xml)
# Behavioural, not textual: every fetch helper has to hand back a reason alongside its result, so a
# caller cannot publish a failed request as a zero. urlopen is stubbed to fail so this makes no
# network call and cannot pass by reaching a live NWS that happens to answer.


def _boom(req, timeout=None):
    raise OSError('stubbed transport failure')


g.urllib.request.urlopen = _boom
for name, args in (('fetch_emergencies', ()), ('fetch_tornado_emergencies', ()),
                   ('fetch_alerts', ('https://api.weather.gov/alerts/active',))):
    got = getattr(g, name)(*args)
    check('%s returns (result, reason), never a bare list' % name,
          isinstance(got, tuple) and len(got) == 2 and isinstance(got[0], list), repr(got)[:90])
    check('%s reports a reason when the request fails' % name,
          isinstance(got[1], str) and 'stubbed transport failure' in got[1], repr(got)[:120])
    check('%s reports an empty result alongside the reason, never invented items' % name, got[0] == [])
check('the fetch helpers are the only network path in the generator',
      len(re.findall(r'urlopen\(', inspect.getsource(g))) == 1, inspect.getsource(g.fetch_alerts))

print('----')
print('ALL PASS' if FAILS == 0 else '%d TEST(S) FAILED' % FAILS)
raise SystemExit(1 if FAILS else 0)
