#!/usr/bin/env python3
"""tests/gen-crossings-status.test.py — the jurisdiction-reported crossing-status generator
against a stubbed feed (RESPONDER_ROOT override, never the real data/). Covers the honesty
rule the layer rests on: only non-open rows are published, because the feed timestamps a
record's last change and not a confirmation, so a stale open would assert passability nobody
has checked. Also covers coordinate and shape guards. No network: fetch_json is stubbed.
Run: python3 tests/gen-crossings-status.test.py"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
GEN = os.path.join(HERE, '..', 'scripts', 'gen-crossings-status.py')

FAILS = 0


def check(name, ok, detail=''):
    global FAILS
    print('%s: %s%s' % ('PASS' if ok else 'FAIL', name, (' · ' + detail) if (detail and not ok) else ''))
    if not ok:
        FAILS += 1


def load_gen(root):
    os.environ['RESPONDER_ROOT'] = root
    spec = importlib.util.spec_from_file_location('gen_xstatus_%d' % id(root), GEN)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def row(rid, status, name='CR 123 @ Creek', lat=30.1, lon=-97.8, upd='2026-07-16T20:41:22.149Z',
        juris='HCO', addr='Hays County', comment=''):
    return {'id': rid, 'name': name, 'jurisdiction': juris, 'address': addr, 'lat': str(lat),
            'lon': str(lon), 'comment': comment, 'status': status, 'updated_at': upd}


def run(feed):
    """Generate against a stubbed feed and return the written payload."""
    root = tempfile.mkdtemp(prefix='responder-xstatus-test.')
    os.makedirs(os.path.join(root, 'data'))
    try:
        g = load_gen(root)
        g.fetch_json = lambda url: feed
        g.main()
        with open(os.path.join(root, 'data', 'crossing-status.json'), encoding='utf-8') as f:
            return g, json.load(f)
    finally:
        shutil.rmtree(root)


# ---------------------------------------------------------------------------
# The rule the whole layer rests on: an 'open' row is never published. Most open records in
# this feed have not been touched in over a year, and a stale open under-warns where a stale
# closure only over-warns.
g, p = run({'attributes': [
    row('1', 'closed'), row('2', 'caution'), row('3', 'open'),
    row('4', 'open', upd='2022-09-01T11:24:32.757Z'), row('5', 'OPEN'),
]})
kept = {r['id'] for r in p['crossings']}
check('a reported closure is published', '1' in kept)
check('a reported caution is published', '2' in kept)
check('an open crossing is never published, whatever its age', kept == {'1', '2'}, str(sorted(kept)))
check('status casing from the feed is normalised', all(r['status'] in ('closed', 'caution') for r in p['crossings']))
check('closures sort ahead of cautions', [r['status'] for r in p['crossings']] == ['closed', 'caution'])

# The artifact has to say what its timestamps mean, because the layer subtitle claims it.
check('the payload declares the currency it actually has', p['currency'] == 'record-change', p.get('currency'))
check('the payload carries the newest record change, not a fetch time',
      p['newestChange'] == '2026-07-16T20:41:22Z', p.get('newestChange'))
check('each row carries the time its own record last changed',
      all(r['changed'] == '2026-07-16T20:41:22Z' for r in p['crossings']))
check('the feed timestamp is normalised to the board Z form',
      not any(r['changed'].endswith('.149Z') for r in p['crossings']))
check('the artifact names the operator and the source',
      'ATX Floods' in p['attribution'] and p['source'].startswith('https://'))
check('a generated stamp is present and distinct from the record change',
      p['generated'].endswith('Z') and p['generated'] != p['newestChange'])

# ---------------------------------------------------------------------------
# Position and shape guards: an unplaceable row must not reach a map.
g, p = run({'attributes': [
    row('1', 'closed'),
    row('2', 'closed', lat=0.0, lon=0.0),
    row('3', 'closed', lat=48.5, lon=-122.0),
    row('4', 'closed', lat='n/a'),
    row('5', 'closed', name='  '),
]})
check('a 0,0 placeholder position is dropped', '2' not in {r['id'] for r in p['crossings']})
check('a position outside Texas is dropped', '3' not in {r['id'] for r in p['crossings']})
check('an unparseable position is dropped', '4' not in {r['id'] for r in p['crossings']})
check('a nameless row is dropped', '5' not in {r['id'] for r in p['crossings']})
check('the placeable closure survives all of that', [r['id'] for r in p['crossings']] == ['1'])

g, p = run({'attributes': [row('1', 'closed', upd=None), row('2', 'closed', upd='not a date')]})
check('an unparseable record time becomes null rather than a guessed one',
      all(r['changed'] is None for r in p['crossings']), str([r['changed'] for r in p['crossings']]))
check('newestChange is null when no row has a usable time', p['newestChange'] is None)

# An empty closure list is a real, common state: nothing is closed right now.
g, p = run({'attributes': []})
check('an empty closure list publishes an empty layer, not a failure', p['crossings'] == [])

# Alternate envelope shapes the feed might use.
for shape in ({'data': [row('1', 'closed')]}, [row('1', 'closed')], {'closures': [row('1', 'closed')]}):
    g, p = run(shape)
    check('the row envelope %s is understood' % (list(shape)[0] if isinstance(shape, dict) else 'bare list'),
          len(p['crossings']) == 1)

# ---------------------------------------------------------------------------
# A fetch failure must never overwrite a good file, and a runaway list must not publish.
root = tempfile.mkdtemp(prefix='responder-xstatus-test.')
os.makedirs(os.path.join(root, 'data'))
out = os.path.join(root, 'data', 'crossing-status.json')
try:
    with open(out, 'w', encoding='utf-8') as f:
        f.write('{"crossings":["previous good file"]}')
    g = load_gen(root)

    def boom(url):
        raise OSError('upstream down')

    g.fetch_json = boom
    try:
        g.main()
        check('a failed fetch exits non-zero', False, 'main() returned normally')
    except SystemExit as e:
        check('a failed fetch exits non-zero', e.code != 0)
    with open(out, encoding='utf-8') as f:
        check('a failed fetch leaves the previous file intact', 'previous good file' in f.read())

    g.fetch_json = lambda url: {'attributes': [row(str(i), 'closed') for i in range(g.MAX_ROWS + 1)]}
    try:
        g.main()
        check('a closure list over the cap refuses to publish', False, 'main() returned normally')
    except SystemExit as e:
        check('a closure list over the cap refuses to publish', e.code != 0)
    with open(out, encoding='utf-8') as f:
        check('the over-cap run also leaves the previous file intact', 'previous good file' in f.read())

    # An HTTP 200 carrying an error object or a renamed key raises nothing, so the shape guard is
    # the only thing between it and a published "no jurisdiction reports a closed crossing".
    for label, body in (('an error object', {'error': {'code': 500, 'message': 'upstream fault'}}),
                        ('a renamed row key', {'results': [row('1', 'closed')]}),
                        ('a bare string', 'service unavailable')):
        g.fetch_json = lambda url, b=body: b
        try:
            g.main()
            check('a 200 carrying %s refuses to publish an empty closure list' % label, False,
                  'main() returned normally')
        except SystemExit as e:
            check('a 200 carrying %s refuses to publish an empty closure list' % label, e.code != 0)
        with open(out, encoding='utf-8') as f:
            check('the %s run leaves the previous file intact' % label, 'previous good file' in f.read())
finally:
    shutil.rmtree(root)

# ---------------------------------------------------------------------------
# The layer's honesty strings and its wiring have to exist in both languages.
i18n = open(os.path.join(HERE, '..', 'js', 'i18n.js'), encoding='utf-8').read()
for key in ('layers.xstatus', 'sheet.s.xstatus', 'xstatus.title', 'xstatus.changed',
            'xstatus.nocheck', 'xstatus.old'):
    check('%s is defined in both en and es' % key, i18n.count("'%s':" % key) == 2,
          '%d definitions' % i18n.count("'%s':" % key))
check('the layer subtitle says the time is a report change, not a recheck',
      'not that it was rechecked' in i18n)
check('the Spanish subtitle carries the same qualifier',
      'no que se haya vuelto a verificar' in i18n)
check('the TxGIO row no longer just advertises the gap',
      'for reported status see the layer above' in i18n)
check('no em-dash reached the new strings',
      not any('—' in ln for ln in i18n.splitlines() if 'xstatus' in ln))

cycle = open(os.path.join(HERE, '..', 'scripts', 'run-cycle.sh'), encoding='utf-8').read()
check('the generator runs on the data cycle', 'gen-crossings-status.py' in cycle)
check('the artifact is staged by the data cycle', 'data/crossing-status.json' in cycle)

panels = open(os.path.join(HERE, '..', 'js', 'panels.js'), encoding='utf-8').read()
check('a transient fetch failure keeps the last good rows rather than wiping the layer',
      'crossing-status.json' in panels and '.catch(() => null)' in panels)
check('the reported layer is rendered from its own state, not the curated list',
      'state.crossStatus' in panels and 'renderCrossStatus' in panels)

print('---')
if FAILS:
    print('%d FAILURE(S)' % FAILS)
    sys.exit(1)
print('ALL PASS')
