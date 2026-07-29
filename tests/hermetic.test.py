#!/usr/bin/env python3
"""tests/hermetic.test.py — the publish gate may not depend on anything it does not control.

scripts/deploy.sh runs node --test, the python suites, the shell suites and cycle-check.sh before
it ships, so anything those reach is on the publish path of a life-safety board. Two ambient
things have already turned a green suite red for reasons no assertion described: an inherited
RESPONDER_ROOT pointed a spawned generator at the LIVE repo (gen-history.test.py wrote the real
archive and then failed on the file its own fixture never got), and a test that fetched a live
catalogue could fail the gate on an upstream's bad day. This pins both shut and proves the trap
that enforces it actually fires. Run: python3 tests/hermetic.test.py"""
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RUN_SH = os.path.join(HERE, 'run.sh')
TRAP_DIR = os.path.join(HERE, 'nonet')

# floors, not exact counts: a suite that silently loses files is the failure this guards. Raise
# them when a suite grows.
GATED_FLOOR = {'py': 12, 'sh': 6, 'js': 45}

FAILS = 0


def check(name, ok, detail=''):
    global FAILS
    print('%s: %s%s' % ('PASS' if ok else 'FAIL', name, (' · ' + detail) if (detail and not ok) else ''))
    if not ok:
        FAILS += 1


RUN_SRC = open(RUN_SH, encoding='utf-8').read()

# --- the trap fires, proven by making the call it exists to catch --------------------------------
probe = tempfile.mkdtemp(prefix='hermetic-test.')
try:
    ledger = os.path.join(probe, 'reached.log')
    env = dict(os.environ, PYTHONPATH=TRAP_DIR, RESPONDER_NONET_LOG=ledger)
    env.pop('RESPONDER_ROOT', None)
    reach = subprocess.run(
        (sys.executable, '-c', 'import urllib.request;'
         'urllib.request.urlopen("https://api.weather.gov/alerts/types", timeout=5)'),
        capture_output=True, text=True, env=env)
    check('TRAP · a gated process cannot reach a real host', reach.returncode != 0, reach.stdout[-200:])
    recorded = open(ledger, encoding='utf-8').read() if os.path.exists(ledger) else ''
    # the ledger, not the raised error, is the verdict: the generators catch fetch failures and
    # record them as misses (E1), so a swallowed trap would otherwise leave no trace
    check('TRAP · the reach is recorded even when the caller would have swallowed the error',
          'api.weather.gov' in recorded, recorded[:200])

    swallowed = subprocess.run(
        (sys.executable, '-c', 'import urllib.request\n'
         'try:\n    urllib.request.urlopen("https://api.water.noaa.gov/nwps/v1/gauges/AAAT2", timeout=5)\n'
         'except Exception:\n    pass\nprint("swallowed")'),
        capture_output=True, text=True, env=dict(env, RESPONDER_NONET_LOG=os.path.join(probe, 'swallowed.log')))
    check('TRAP · a swallowed reach still lands in the ledger, so the run fails anyway',
          swallowed.returncode == 0 and os.path.getsize(os.path.join(probe, 'swallowed.log')) > 0,
          swallowed.stdout[-200:])

    loop = subprocess.run(
        (sys.executable, '-c', 'import socket\n'
         's=socket.socket();s.bind(("127.0.0.1",0));s.listen(1)\n'
         'socket.create_connection(s.getsockname(), timeout=2)\nprint("loopback ok")'),
        capture_output=True, text=True, env=dict(env, RESPONDER_NONET_LOG=os.path.join(probe, 'loop.log')))
    check('TRAP · loopback is untouched, so a suite that binds its own server still runs',
          loop.returncode == 0 and 'loopback ok' in loop.stdout, loop.stderr[-300:])
finally:
    for name in os.listdir(probe):
        os.unlink(os.path.join(probe, name))
    os.rmdir(probe)

# --- the trap is wired into the runner, and into every suite it runs -----------------------------
check('WIRING · tests/run.sh puts the trap on PYTHONPATH before any suite',
      re.search(r'^export PYTHONPATH="\$PWD/tests/nonet', RUN_SRC, re.M) is not None)
check('WIRING · tests/run.sh arms the ledger and fails the run on a non-empty one',
      'RESPONDER_NONET_LOG=' in RUN_SRC and re.search(r'if \[ -s "\$RESPONDER_NONET_LOG" \]', RUN_SRC) is not None)
check('WIRING · the arming is unconditional, never per-suite: a suite added later is trapped too',
      re.search(r'if \[ "\$SUITE"[^\n]*\n[^\n]*PYTHONPATH', RUN_SRC) is None)

if os.environ.get('RESPONDER_NONET_LOG'):
    trap = sys.modules.get('sitecustomize')
    check('ARMED · running under tests/run.sh, the trap is installed in this very process, not just '
          'named in the runner', getattr(trap, 'RESPONDER_NONET', False) is True, str(trap))

# --- the ambient root that took the board down ---------------------------------------------------
# scripts/run-cycle.sh exports RESPONDER_ROOT and deploy.sh runs this gate under it. Dynamic, so it
# fires under exactly the condition that caused the incident rather than describing it.
check('AMBIENT · no gated test inherits RESPONDER_ROOT, so none can be redirected at the live repo',
      'RESPONDER_ROOT' not in os.environ, os.environ.get('RESPONDER_ROOT', ''))
check('AMBIENT · tests/run.sh is what scrubs it', re.search(r'^unset RESPONDER_ROOT$', RUN_SRC, re.M) is not None)

# --- nothing lands outside the gated set ---------------------------------------------------------
globs = re.findall(r"run_glob\s+\w+\s+'([^']+)'", RUN_SRC)
check('COVERAGE · the runner still enumerates its suites from disk rather than a hand-kept list',
      sorted(globs) == ['tests/*.test.py', 'tests/*.test.sh'], str(globs))
check('COVERAGE · the runner still runs the whole node directory', 'node --test tests/' in RUN_SRC)

discovered = {'py': [], 'sh': [], 'js': [], 'stray': []}
for dirpath, dirnames, filenames in os.walk(HERE):
    dirnames[:] = [d for d in dirnames if d != '__pycache__']
    for name in filenames:
        if '.test.' not in name or name.endswith('.pyc'):
            continue
        rel = os.path.relpath(os.path.join(dirpath, name), ROOT)
        ext = name.rsplit('.', 1)[-1]
        if os.path.dirname(rel) == 'tests' and ext in discovered:
            discovered[ext].append(rel)
        else:
            discovered['stray'].append(rel)

check('COVERAGE · every test file sits where the gate looks for it; none is stranded in a subdir '
      'or under an unrun extension', not discovered['stray'], str(sorted(discovered['stray'])))
for suite, floor in sorted(GATED_FLOOR.items()):
    check('COVERAGE · the gated %s suite still holds at least %d files' % (suite, floor),
          len(discovered[suite]) >= floor, '%d found' % len(discovered[suite]))

# --- the node half, which runs outside the python trap -------------------------------------------
# deploy.sh invokes node --test directly, so PYTHONPATH cannot reach it. These are the two shapes
# that would put a live host back on the publish path.
NET_IMPORT = re.compile(r"""(?:require\(\s*|from\s+)['"](?:node:)?(?:https?|net|tls|dns|dgram|undici)['"]""")
FETCH_CALL = re.compile(r"""(?<![.\w'"`])fetch\s*\(\s*(?!\)\s*\{)""")
net_imports, fetchers = [], []
for name in sorted(os.listdir(HERE)):
    if not name.endswith('.js'):
        continue
    src = open(os.path.join(HERE, name), encoding='utf-8').read()
    if NET_IMPORT.search(src):
        net_imports.append(name)
    if FETCH_CALL.search(src):
        fetchers.append(name)

check('NODE · no test file opens a socket through a node network builtin', not net_imports, str(net_imports))
# hazard-mirror.js is the one live-catalogue path left, and it is off unless --upstream asks for it;
# tests/hazard-table.test.js proves the gated call answers from PINNED_TYPES with fetch throwing
check('NODE · the only fetch call under tests/ is the opt-in catalogue refresh',
      fetchers == ['hazard-mirror.js'], str(fetchers))
check('NODE · that refresh is opt-in, so the gated path never reaches api.weather.gov',
      'if (!live) return pinnedTypes();' in open(os.path.join(HERE, 'hazard-mirror.js'), encoding='utf-8').read())

print('---')
if FAILS:
    print('%d FAILURE(S)' % FAILS)
    sys.exit(1)
print('ALL PASS')
