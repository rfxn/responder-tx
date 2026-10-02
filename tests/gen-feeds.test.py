#!/usr/bin/env python3
"""tests/gen-feeds.test.py — feed.xml + crests.ics against stubbed sources (RESPONDER_ROOT
override, never the real repo root). The rule under test is that an emergency check which never
completed must not reach a subscriber as an all clear: the absence of emergency items IS the
all-clear assertion in RSS, so a failed check has to say so in the feed itself. Also pins the
channel identity, which carries the 911 line, and the flood warnings, watches and advisories the
feed carries as the standing picture. No network: every urlopen is stubbed.
Run: python3 tests/gen-feeds.test.py"""
import datetime
import importlib.util
import inspect
import json
import os
import re
import shutil
import tempfile
import urllib.error
import urllib.parse
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


def run(alerts, gauges=(), requests_=(), tornado=None, products=None, now=None):
    """Generate with stubbed NWS responses; each of alerts (the flash flood check), tornado (the
    tornado check) and products (the flood warnings, watches and advisories) may be a payload or an
    exception to raise, and they are answered independently so one check failing cannot be mistaken
    for another. tornado and products default to a genuine zero; now pins the generator's clock.
    Returns (module, parsed feed.xml root, feed.xml text, crests.ics text)."""
    root = tempfile.mkdtemp(prefix='responder-feeds-test.')
    tornado = {'features': []} if tornado is None else tornado
    products = {'features': []} if products is None else products
    try:
        seed(root, gauges, requests_)
        g = load_gen(root)
        g.time.sleep = lambda _s: None  # the retry backoff is real; paying it here would only slow the suite
        if now is not None:
            g.now_utc = lambda: now

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
            if req.full_url == g.PRODUCTS_URL:
                answer = products
            else:
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

# The cycle now kills a generator that outruns its time budget, and commits whatever is on disk.
# A truncated feed.xml would be published as the real one, so both outputs rename into place.
main_src = inspect.getsource(g.main)
check('feed.xml and crests.ics are written by rename, so a killed run leaves the previous feed '
      'intact rather than a truncated one', "open(" not in main_src.replace("write_atomic(", "")
      and main_src.count('write_atomic(') == 2, main_src[-400:])

# ---------------------------------------------------------------------------
# 8. Flood warnings, watches and advisories: the standing picture the feed used to carry only when
#    someone wrote it by hand. tests/fixtures/alerts-tx-flood-products.json is every Texas product
#    live at capture, verbatim but for trimmed prose; the clock is pinned to the capture so the
#    products are still in effect whenever this runs.
with open(os.path.join(HERE, 'fixtures', 'alerts-tx-flood-products.json'), encoding='utf-8') as _f:
    PRODUCTS_FIX = json.load(_f)
CAPTURED = datetime.datetime.fromisoformat(PRODUCTS_FIX['captured'].replace('Z', '+00:00'))
FIX_FEATS = PRODUCTS_FIX['features']


PRODUCT_GUID_RE = re.compile(r'^nws-[A-Z]{4}\.[A-Z]{2}\.[A-Z]\.\d{4}-\d{4}$')


def product_items(root):
    return [it for it in root.findall('./channel/item') if PRODUCT_GUID_RE.match(it.findtext('guid', ''))]


def first(ts, prefix):
    return next((i for i, t in enumerate(ts) if t.startswith(prefix)), -1)


g, root, xml, _ = run({'features': []}, gauges=[CREST], products=PRODUCTS_FIX, now=CAPTURED)
ts = titles(root)
items = product_items(root)
flood_feats = [f for f in FIX_FEATS if f['properties']['event'] in g.FLOOD_PRODUCTS]
check('the fixture still holds a non-flood product, so the filter below is not vacuous',
      len(flood_feats) < len(FIX_FEATS))
check('one item per warning: the two segments of one watch are one item',
      len(items) == len({g.vtec_key(f) for f in flood_feats}) == len(flood_feats) - 1,
      '%d items, %d flood messages' % (len(items), len(flood_feats)))
check('a non-flood standing product does not publish', not any(t.startswith('High Wind Warning') for t in ts), str(ts))
for event in ('Flash Flood Warning', 'Flood Warning', 'Flood Watch', 'Flood Advisory', 'Coastal Flood Advisory'):
    check('the %s tier publishes' % event, any(t.startswith(event + ' · ') for t in ts), str(ts))
fwd_watch = [it for it in items if it.findtext('guid', '').startswith('nws-KFWD.FA.A.0007-')]
body = fwd_watch[0].findtext('description', '') if fwd_watch else ''
check('a watch split into segments names the areas of every segment',
      len(fwd_watch) == 1 and 'Denton' in body and 'Parker' in body, body[:200])
coastal = [t for t in ts if t.startswith('Coastal Flood Advisory')]
check('a zone outside the area is not named', coastal and 'Southern Orange' in coastal[0]
      and 'Calcasieu' not in coastal[0], str(coastal))
check('warnings lead the crests, and watches and advisories follow them',
      -1 < first(ts, 'Flash Flood Warning') < first(ts, 'Flood Warning') < first(ts, 'MAJOR crest')
      < first(ts, 'Flood Watch') < first(ts, 'Flood Advisory'), str(ts))
check('every item carries its own guid', len({it.findtext('guid') for it in root.findall('./channel/item')})
      == len(root.findall('./channel/item')))
check('a product item points at the Alerts tab', all(it.findtext('link') == g.SITE + '/?tab=alerts' for it in items))
check('the product items carry no em-dash', '—' not in xml)

# A reissue is the same item to a reader: the guid rides the VTEC tuple, not the message id that
# changes with every update, so a subscriber is not re-notified every fifteen minutes.
warn = next(f for f in FIX_FEATS if 'KEWX.FL.W.0053' in ' '.join(f['properties']['parameters'].get('VTEC', [])))
reissue = json.loads(json.dumps(warn))
reissue['id'] = reissue['properties']['id'] = 'urn:oid:reissue'
reissue['properties']['sent'] = '2026-10-02T13:30:00Z'
reissue['properties']['ends'] = reissue['properties']['expires'] = '2026-10-03T12:00:00Z'
other = json.loads(json.dumps(warn))
other['id'] = other['properties']['id'] = 'urn:oid:other'
other['properties']['parameters']['VTEC'] = [v.replace('.0053.', '.0054.') for v in other['properties']['parameters']['VTEC']]
guid_of = lambda feats: [x['guid'] for x in g.flood_products(feats, CAPTURED)]
check('a reissued warning keeps its guid', guid_of([warn]) == guid_of([reissue]), '%s vs %s' % (guid_of([warn]), guid_of([reissue])))
check('a reissue and its original are one item, speaking for the later end',
      len(g.flood_products([warn, reissue], CAPTURED)) == 1
      and g.flood_products([warn, reissue], CAPTURED)[0]['until'] == '2026-10-03T12:00:00Z')
check('a different warning gets a different guid', guid_of([warn]) != guid_of([other]))

# A riverine warning with no declared end stays in the feed past its message expiry, and says so.
open_ended = json.loads(json.dumps(warn))
open_ended['properties']['parameters']['VTEC'] = ['/O.EXT.KEWX.FL.W.0053.000000T0000Z-000000T0000Z/']
later = CAPTURED + datetime.timedelta(days=3)
kept = g.flood_products([open_ended], later)
check('a warning with no declared end is not retired by the clock', len(kept) == 1)
check('and it says until further notice', 'until further notice' in g.product_item(kept[0], later)[2])

# A product past its hazard end is not published as current.
_, root_late, _, _ = run({'features': []}, gauges=[CREST], products=PRODUCTS_FIX,
                         now=CAPTURED + datetime.timedelta(days=1))
still = [f for f in flood_feats if (g.parse_iso(g.ends_at(f['properties'])) or later) > CAPTURED + datetime.timedelta(days=1)]
check('a product past its hazard end does not publish',
      len(product_items(root_late)) == len({g.vtec_key(f) for f in still}) and len(still) < len(flood_feats),
      '%d items' % len(product_items(root_late)))

# A warning already carried as an emergency item is not published a second time. The fixture's
# KFWD 0092 is a real CONSIDERABLE flash flood warning, and as NWS serves it the feature id is the
# alert URL while properties.id is the bare urn, which is exactly what a naive id match misses.
ffw = next(f for f in FIX_FEATS if 'KFWD.FF.W.0092' in ' '.join(f['properties']['parameters'].get('VTEC', [])))
check('the fixture warning carries a damage threat and two different ids, so the case is real',
      ffw['properties']['parameters'].get('flashFloodDamageThreat') == ['CONSIDERABLE'] and ffw['id'] != ffw['properties']['id'])
_, root_e, _, _ = run({'features': [ffw]}, gauges=[CREST], products=PRODUCTS_FIX, now=CAPTURED)
ts_e = titles(root_e)
guids_e = [it.findtext('guid', '') for it in root_e.findall('./channel/item')]
check('an emergency publishes once, as the emergency item',
      any(t.startswith('CONSIDERABLE flash flood · Bosque') for t in ts_e)
      and not any(gd.startswith('nws-KFWD.FF.W.0092-') for gd in guids_e), str(ts_e[:4]))
check('the other warnings still publish beside it', any(gd.startswith('nws-KFWD.FF.W.0091-') for gd in guids_e))

# pubDate is UTC, whatever offset NWS stamped: a -05:00 sent time printed as +0000 reads five hours early.
pub = {it.findtext('guid', ''): it.findtext('pubDate', '') for it in root_e.findall('./channel/item')}
check('a product pubDate is the sent time in UTC',
      pub.get('nws-KEWX.FL.W.0053-2026') == 'Fri, 02 Oct 2026 07:48:00 +0000', str(pub.get('nws-KEWX.FL.W.0053-2026')))
emerg_pub = [it.findtext('pubDate', '') for it in root_e.findall('./channel/item')
             if it.findtext('title', '').startswith('CONSIDERABLE flash flood')]
check('an emergency pubDate is the sent time in UTC', emerg_pub == ['Fri, 02 Oct 2026 12:50:00 +0000'], str(emerg_pub))

# E1 for the products check: a failure is an explicit unknown, a genuine zero is silent, and the
# two are different artifacts. One check failing never claims another failed.
for label, boom in (('a network error', OSError('connection refused')),
                    ('an HTTP error', urllib.error.HTTPError('u', 503, 'unavailable', {}, None)),
                    ('a 200 with no features list', {'title': 'Service Unavailable', 'status': 503}),
                    ('a malformed body', ValueError('Expecting value'))):
    gp, root_p, xml_p, _ = run({'features': []}, gauges=[CREST], products=boom, now=CAPTURED)
    ts_p = titles(root_p)
    check('the product check failing on %s publishes its own unknown item' % label, gp.PRODUCTS_UNKNOWN_TITLE in ts_p, str(ts_p))
    item = [it for it in root_p.findall('./channel/item') if it.findtext('title', '') == gp.PRODUCTS_UNKNOWN_TITLE]
    body = item[0].findtext('description', '') if item else ''
    check('the product check failing on %s says unknown, not clear' % label,
          'not as an all clear' in body and 'flood warning, watch or advisory' in body, body[:120])
    check('the product check failing on %s does not claim the emergency check failed' % label,
          gp.EMERGENCY_UNKNOWN_TITLE not in ts_p and gp.TORNADO_UNKNOWN_TITLE not in ts_p, str(ts_p))
    check('the product check failing on %s still publishes the rest of the board' % label,
          any('MAJOR crest' in t for t in ts_p) and not product_items(root_p))
_, root_z, xml_z, _ = run({'features': []}, gauges=[CREST], now=CAPTURED)
_, root_f, xml_f, _ = run({'features': []}, gauges=[CREST], products=OSError('down'), now=CAPTURED)
check('a genuine zero on the product check publishes no unknown item and no product item',
      g.PRODUCTS_UNKNOWN_TITLE not in titles(root_z) and not product_items(root_z))
check('a failed product check and a genuine zero are not the same artifact', xml_z != xml_f)
check('a failed product check carries one extra item, not a wiped feed',
      len(titles(root_f)) == len(titles(root_z)) + 1)

# Volume: warnings outrank a busy crest day under the cap, and advisories are what the cap cuts.
_, root_v, _, _ = run({'features': []}, gauges=NOISY_CRESTS, products=PRODUCTS_FIX, now=CAPTURED)
ts_v = titles(root_v)
check('the feed still caps its item count with products in it', len(ts_v) == g.MAX_ITEMS, str(len(ts_v)))
check('every flood warning survives the cap on a busy crest day',
      sum(t.startswith(('Flash Flood Warning', 'Flood Warning')) for t in ts_v)
      == sum(t.startswith(('Flash Flood Warning', 'Flood Warning')) for t in ts), str(ts_v[:10]))
check('advisories are what the cap cuts first', not any(t.startswith('Flood Advisory') for t in ts_v))

# The request asks for exactly the table, and the table is the board's own: a name NWS does not know
# answers 200 with zero features, so drift here would publish "no flood warnings" instead of failing.
caltopo = importlib.util.spec_from_file_location('gen_caltopo_mirror', os.path.join(HERE, '..', 'scripts', 'gen-caltopo.py'))
gc = importlib.util.module_from_spec(caltopo)
caltopo.loader.exec_module(gc)
check('every flood product name is in the board hazard table',
      not [e for e in g.FLOOD_PRODUCTS if e not in gc.HAZARD_EVENTS], str([e for e in g.FLOOD_PRODUCTS if e not in gc.HAZARD_EVENTS]))
check('every flood product in the board hazard table is requested',
      not [e for e in gc.HAZARD_EVENTS if re.search(r'flood|storm surge', e, re.I) and e not in g.FLOOD_PRODUCTS])
q = urllib.parse.parse_qs(urllib.parse.urlsplit(g.PRODUCTS_URL).query)
check('the product request names exactly the table, in the area the board covers',
      q.get('event', [''])[0].split(',') == list(g.FLOOD_PRODUCTS) and q.get('area') == [g.AREA], g.PRODUCTS_URL)

# a killed step publishes nothing, so the unavailability items only reach readers if every fetch can
# exhaust its retry ladder inside the cycle's step budget
src = inspect.getsource(g)
fetches = len(re.findall(r'(?<!def )\bfetch_alerts\(', src))
worst = fetches * ((len(g.BACKOFFS) + 1) * g.TIMEOUT + sum(g.BACKOFFS))
with open(os.path.join(HERE, '..', 'scripts', 'run-cycle.sh'), encoding='utf-8') as _f:
    budget = int(re.search(r'^BUDGET_FEEDS_S=(\d+)', _f.read(), re.M).group(1))
check('the feeds step budget outlasts every alert fetch timing out', fetches >= 3 and budget >= worst + 10,
      'budget %ds, worst case %ds over %d fetches' % (budget, worst, fetches))

print('----')
print('ALL PASS' if FAILS == 0 else '%d TEST(S) FAILED' % FAILS)
raise SystemExit(1 if FAILS else 0)
