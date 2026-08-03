#!/bin/bash
# tests/run-cycle.test.sh — partial-publish regression tests for scripts/run-cycle.sh.
# On 2026-07-24T23:53Z NWPS answered 429, fetch-snapshot.py exited 1, and the whole cycle
# aborted: roads, history, crest, feeds, shelters and the CalTopo export never regenerated and
# NOTHING published, including the sources that were perfectly healthy. Same shape as the F3
# deploy bug fixed in v0.97.85. These tests pin the fix and its honesty constraints:
#   1 a healthy cycle still exits 0 and signs off clean
#   2 one failing generator still publishes the rest, and says which source went stale
#   3 the failed source's own file is untouched, so it keeps its older "generated" stamp
#   4 a derived generator is SKIPPED rather than restamping stale input as fresh
#   5 a degraded cycle is distinguishable from a clean one in exit status AND log verdict
#   6 every generator failing is still a hard failure that publishes nothing
#   7 validation stays fatal: unpublishable data is never pushed
#   8 the degraded commit subject does not claim a full regen
#   9 freshness-monitor.sh reads the degraded verdict and blames the right thing
#  10 a busy lock skips cleanly, proved against a SCRATCH lock path
# The cycle also runs COMMITTED pipeline code (v0.98.10). It executes on a 15-minute cron against
# a working tree an agent may be mid-edit in, and three separate agents in one night published or
# aborted on a half-finished generator. Pinned below:
#  11 a dirty working-tree generator cannot reach production data, and the cycle says so
#  12 --allow-dirty-code runs the tree on purpose and announces it in the log
#  13 data/event.json stays DATA: an uncommitted edit takes effect on the next cycle
#  14 every generator the cycle runs honors RESPONDER_ROOT, so HEAD code writes real data
#  15 the throwaway pipeline worktree is not leaked
# The cycle holds a non-blocking flock, so a generator that hangs past the window makes the NEXT
# cycle log SKIP: one hung upstream stops the board publishing for as long as it lasts (v0.99.62).
#  18 a step over its budget is killed, named as timed out, and does not block the publish
#  19 a killed step and a dead upstream are separate buckets, so a too-tight budget is findable
#  20 the aggregate guard bounds the cycle even when several steps run long
#  21 the budgets still fit the cron interval they exist to protect
# A scratch repo with stub generators and a bare origin keeps the real repo, the real Pages
# project and the network untouched. Every lock, log and state path this suite touches is
# redirected into $WORK: on 2026-07-25T01:23Z a hand-held flock on the production
# /tmp/responder-cycle.lock made a live cycle skip and cost a publish, so nothing here may
# ever name a path production owns.
set -uo pipefail

# kill any child still running and drop the scratch dir even on failure or interrupt, so a
# test process can never outlive this script holding a lock
cleanup() {
    trap - EXIT INT TERM
    local kids
    kids=$(jobs -p 2>/dev/null)
    if [ -n "$kids" ]; then kill $kids 2>/dev/null; fi  # best-effort reap; already-dead jobs are fine
    if [ -n "${WORK:-}" ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT INT TERM

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
CYCLE_SRC="$REPO_ROOT/scripts/run-cycle.sh"
MON_SRC="$REPO_ROOT/scripts/freshness-monitor.sh"
FAILS=0

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; FAILS=$((FAILS + 1)); }

OLD_STAMP='2026-07-24T20:00:00Z'

# mk_gen NAME OUTFILE — a stub generator that rewrites OUTFILE with a fresh stamp, or exits 1
# without touching it when RESPONDER_TEST_FAIL names it. Mirrors the real generators: every one
# writes its own "generated" and leaves the previous file intact on failure.
mk_gen() {
    cat > "$REPO/scripts/$1" <<PY
import datetime, json, os, sys, time
name = "${1%.py}"
# the hang comes BEFORE the write on purpose: a killed step must leave the previous file alone
if name in os.environ.get("RESPONDER_TEST_SLOW", "").split(","):
    time.sleep(45)
if name in os.environ.get("RESPONDER_TEST_FAIL", "").split(","):
    sys.exit(name + ": stub failure")
out = "$2"
now = datetime.datetime.now(datetime.timezone.utc)
# the stamp is second-resolution, so two cycles inside one second used to write byte-identical
# data; the cycle then correctly skipped the publish and the test read that as a failed deploy
try:
    with open(out, encoding="utf-8") as f:
        prev = f.read()
except OSError:
    prev = ""
while now.strftime("%Y-%m-%dT%H:%M:%SZ") in prev:
    now += datetime.timedelta(seconds=1)
now = now.strftime("%Y-%m-%dT%H:%M:%SZ")
if out.endswith(".json"):
    payload = {"generated": now, "gauges": [{"id": "G1"}], "roads": [], "shelters": [], "requests": []}
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f)
else:
    with open(out, "w", encoding="utf-8") as f:
        f.write("<rss><lastBuildDate>" + now + "</lastBuildDate></rss>\n")
print(name + ": stub wrote " + out)
PY
}

setup() {  # scratch repo: run-cycle.sh, stub generators, stub validation + deploy, a bare origin
    WORK=$(mktemp -d)
    REPO="$WORK/repo"
    mkdir -p "$REPO/scripts" "$REPO/data"

    # every data file starts at the SAME old stamp, so any restamping is visible
    for f in gauges-snapshot roads-snapshot crest-summary history gauge-meta shelters-live caltopo-export requests wildfire; do
        printf '{"generated":"%s","gauges":[{"id":"G1"}],"roads":[],"shelters":[],"requests":[]}\n' \
            "$OLD_STAMP" > "$REPO/data/$f.json"
    done
    printf '<rss><lastBuildDate>%s</lastBuildDate></rss>\n' "$OLD_STAMP" > "$REPO/feed.xml"
    printf 'BEGIN:VCALENDAR\nDTSTAMP:%s\nEND:VCALENDAR\n' "$OLD_STAMP" > "$REPO/crests.ics"

    mk_gen fetch-snapshot.py      data/gauges-snapshot.json
    mk_gen gen-roads-snapshot.py  data/roads-snapshot.json
    mk_gen gen-history.py         data/history.json
    mk_gen gen-crest-summary.py   data/crest-summary.json
    mk_gen gen-notices.py         data/requests.json
    mk_gen gen-feeds.py           feed.xml
    mk_gen gen-shelters.py        data/shelters-live.json
    mk_gen gen-caltopo.py         data/caltopo-export.json
    mk_gen gen-crossings-status.py data/crossing-status.json
    mk_gen gen-wildfire.py        data/wildfire.json

    # validation + publish stubs; RESPONDER_TEST_CHECK_RC lets one test make validation fail
    # shellcheck disable=SC2016  # deliberate: the stub must expand this when IT runs, not now
    printf '%s\n' '#!/bin/bash' 'echo "SUMMARY: all 11 checks passed"' \
        'exit "${RESPONDER_TEST_CHECK_RC:-0}"' > "$REPO/scripts/cycle-check.sh"
    printf '%s\n' '#!/bin/bash' 'echo "stub deploy"' > "$REPO/scripts/deploy.sh"
    chmod +x "$REPO/scripts/cycle-check.sh" "$REPO/scripts/deploy.sh"

    cp "$CYCLE_SRC" "$REPO/scripts/run-cycle.sh"
    chmod +x "$REPO/scripts/run-cycle.sh"

    git init --quiet "$WORK/remote.git" --bare
    (
        cd "$REPO" || exit 1
        git init --quiet
        git symbolic-ref HEAD refs/heads/main
        git config user.name 'Fixture'
        git config user.email 'fixture@example.test'
        git add -A
        git commit --quiet -m 'fixture baseline'
        git remote add origin "$WORK/remote.git"
        git push --quiet -u origin main
    ) > /dev/null 2>&1
}

run_cycle() {  # sets RC and writes $WORK/cycle.log; RESPONDER_TEST_FAIL names the generators that fail
    RESPONDER_CYCLE_LOG="$WORK/cycle.log" \
    RESPONDER_CYCLE_LOCK="$WORK/cycle.lock" \
    RESPONDER_TEST_FAIL="${FAILING:-}" \
    RESPONDER_TEST_CHECK_RC="${CHECK_RC:-0}" \
    RESPONDER_TEST_SLOW="${SLOW:-}" \
    RESPONDER_STEP_BUDGET_S="${STEP_BUDGET:-}" \
    RESPONDER_CYCLE_BUDGET_S="${CYCLE_BUDGET:-}" \
    RESPONDER_PUBLISH_BUDGET_S="${PUBLISH_BUDGET:-300}" \
    bash "$REPO/scripts/run-cycle.sh" "$@" > "$WORK/run.out" 2>&1
    RC=$?
}

stamp_of() {  # FILE — the "generated"/lastBuildDate stamp currently in a fixture file
    grep -o '[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}T[0-9:]\{8\}Z' "$REPO/$1" | head -1
}

# --- Test 1: a healthy cycle is unchanged: exit 0, clean sign-off, everything refreshed -------
setup
FAILING="" run_cycle
if [ "$RC" -eq 0 ] \
   && grep -q '=== cycle complete ===' "$WORK/cycle.log" \
   && ! grep -q 'DEGRADED' "$WORK/cycle.log" \
   && [ "$(stamp_of data/gauges-snapshot.json)" != "$OLD_STAMP" ] \
   && [ "$(stamp_of data/crest-summary.json)" != "$OLD_STAMP" ]; then
    pass "1 a fully healthy cycle exits 0 and signs off clean"
else
    fail "1 healthy cycle stays clean (rc=$RC)"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

# --- Test 2: one failing generator still publishes the rest -----------------------------------
# This is the 2026-07-24T23:53Z incident: NWPS 429s and everything else is healthy.
setup
FAILING="fetch-snapshot" run_cycle
if [ "$RC" -eq 3 ] \
   && grep -q 'WARN: fetch-snapshot.py failed (non-fatal)' "$WORK/cycle.log" \
   && [ "$(stamp_of data/roads-snapshot.json)" != "$OLD_STAMP" ] \
   && [ "$(stamp_of data/history.json)" != "$OLD_STAMP" ] \
   && [ "$(stamp_of data/shelters-live.json)" != "$OLD_STAMP" ] \
   && [ "$(stamp_of feed.xml)" != "$OLD_STAMP" ] \
   && grep -q 'stub deploy' "$WORK/run.out"; then
    pass "2 one failing source still regenerates and publishes every healthy source"
else
    fail "2 a single failing generator must not block the publish (rc=$RC)"; cat "$WORK/run.out"
fi

# --- Test 3: the failed source keeps its own older stamp (never republished as fresh) ---------
if [ "$(stamp_of data/gauges-snapshot.json)" = "$OLD_STAMP" ]; then
    pass "3 the failed source's file is untouched, so its stamp still tells the truth"
else
    fail "3 the failed source kept its older stamp (got $(stamp_of data/gauges-snapshot.json))"
fi

# --- Test 4: derived generators are skipped, not restamped over stale input -------------------
if grep -q 'SKIP: gen-crest-summary.py not run (the gauge snapshot did not refresh)' "$WORK/cycle.log" \
   && grep -q 'SKIP: gen-caltopo.py not run' "$WORK/cycle.log" \
   && [ "$(stamp_of data/crest-summary.json)" = "$OLD_STAMP" ] \
   && [ "$(stamp_of data/caltopo-export.json)" = "$OLD_STAMP" ]; then
    pass "4 a generator derived from a stale source is skipped, not restamped as fresh"
else
    fail "4 crest/caltopo must not restamp stale gauge data"; cat "$WORK/cycle.log"
fi

# --- Test 5: the degraded verdict is distinguishable in exit status AND in the log -------------
if [ "$RC" -eq 3 ] \
   && grep -q '=== cycle complete (DEGRADED) ===' "$WORK/cycle.log" \
   && grep -q 'failed: snapshot' "$WORK/cycle.log" \
   && grep -q 'skipped: crest caltopo' "$WORK/cycle.log" \
   && ! grep -q '=== cycle complete ===$' "$WORK/cycle.log"; then
    pass "5 a degraded cycle exits 3 and names the stale sources; it cannot pass for a clean run"
else
    fail "5 degraded must be distinguishable from clean (rc=$RC)"; cat "$WORK/cycle.log"
fi

# --- Test 8: the commit subject does not claim a full regen on a partial cycle -----------------
SUBJ=$(cd "$REPO" && git log -1 --format=%s)
case "$SUBJ" in
    *"(auto-cron, partial)"*"stale:"*)
        pass "8 the partial cycle's commit subject says what refreshed and what did not" ;;
    *)
        fail "8 a partial cycle must not commit a full-regen subject (got: $SUBJ)" ;;
esac

# --- Test 9: freshness-monitor blames the failing source, not a dead cron ----------------------
mkdir -p "$WORK/remote"
printf '{"generated":"%s","gauges":[]}\n' "$OLD_STAMP" > "$WORK/remote/gauges-snapshot.json"
printf '{\n "messages": []\n}\n' > "$REPO/data/chat-outbox.json"
MON_OUT=$(
    RESPONDER_MONITOR_URL="file://$WORK/remote/gauges-snapshot.json" \
    RESPONDER_MONITOR_OUTBOX="$REPO/data/chat-outbox.json" \
    RESPONDER_MONITOR_SNAPSHOT="$REPO/data/gauges-snapshot.json" \
    RESPONDER_MONITOR_STATE="$WORK/monitor-state" \
    RESPONDER_MONITOR_LOCK="$WORK/monitor.lock" \
    RESPONDER_MONITOR_LOG="$WORK/monitor.log" \
    RESPONDER_CYCLE_LOG="$WORK/cycle.log" \
    bash "$MON_SRC" --dry-run 2>&1
)
if printf '%s' "$MON_OUT$(cat "$WORK/monitor.log" 2>/dev/null)" | grep -q 'DEGRADED'; then
    pass "9 the freshness monitor surfaces the cycle's degraded verdict"
else
    fail "9 the monitor must read the degraded verdict"; printf '%s\n' "$MON_OUT"
fi
rm -rf "$WORK"

# --- Test 6: every generator failing is still a hard failure that publishes nothing ------------
setup
FAILING="fetch-snapshot,gen-roads-snapshot,gen-history,gen-crest-summary,gen-notices,gen-feeds,gen-shelters,gen-caltopo,gen-crossings-status,gen-wildfire" run_cycle
COMMITS=$(cd "$REPO" && git rev-list --count HEAD)
if [ "$RC" -eq 1 ] \
   && grep -q 'ERROR: cycle failed (no source refreshed' "$WORK/cycle.log" \
   && [ "$COMMITS" -eq 1 ] \
   && ! grep -q 'stub deploy' "$WORK/run.out" \
   && [ "$(stamp_of data/gauges-snapshot.json)" = "$OLD_STAMP" ]; then
    pass "6 a cycle where nothing refreshed is still a hard failure and publishes nothing"
else
    fail "6 total failure must stay fatal (rc=$RC commits=$COMMITS)"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

# --- Test 7: validation stays fatal, so unpublishable data is never pushed ---------------------
setup
FAILING="" CHECK_RC=1 run_cycle
COMMITS=$(cd "$REPO" && git rev-list --count HEAD)
if [ "$RC" -ne 0 ] && [ "$RC" -ne 3 ] \
   && [ "$COMMITS" -eq 1 ] \
   && ! grep -q 'stub deploy' "$WORK/run.out"; then
    pass "7 a cycle-check failure still aborts before commit/push/deploy"
else
    fail "7 validation must stay fatal (rc=$RC commits=$COMMITS)"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

# --- Test 10: a busy lock skips cleanly, and the scratch override is what gets locked ---------
# The holder is this shell's own fd, not a background sleep: there is no child process to leak
# and nothing survives an interrupt. Never hold the production lock to prove this.
setup
exec 8>"$WORK/cycle.lock"
if flock -n 8; then
    FAILING="" run_cycle
    exec 8>&-
    COMMITS=$(cd "$REPO" && git rev-list --count HEAD)
    if [ "$RC" -eq 0 ] \
       && grep -q "SKIP: another cycle holds $WORK/cycle.lock" "$WORK/cycle.log" \
       && [ "$COMMITS" -eq 1 ] \
       && ! grep -q 'stub deploy' "$WORK/run.out"; then
        pass "10 a busy lock skips cleanly, on the RESPONDER_CYCLE_LOCK path not the default"
    else
        fail "10 a busy lock must skip and publish nothing (rc=$RC commits=$COMMITS)"; cat "$WORK/run.out"
    fi
else
    exec 8>&-
    fail "10 could not take the scratch lock to set up the contention case"
fi
# Static, not a runtime probe. `flock -n /tmp/responder-cycle.lock true` would itself take the
# production lock for an instant, and a live cycle asking in that instant skips a real publish;
# it also failed spuriously whenever an unrelated cron cycle happened to be mid-run. Asserting
# that no test file can even name the path is the stronger claim and costs production nothing.
if grep -RIl --include='*.test.sh' --include='*.test.py' -e '/tmp/responder-cycle\.lock' \
       -e '/tmp/responder-monitor\.' -e '/tmp/responder-chat\.' "$REPO_ROOT/tests" \
     | grep -qv "$(basename "$0")\$"; then
    fail "10 a test file names a production lock path directly"
    grep -RIn --include='*.test.sh' --include='*.test.py' -e '/tmp/responder-cycle\.lock' "$REPO_ROOT/tests"
else
    pass "10 no test file names a production lock path; every suite locks its own scratch copy"
fi
rm -rf "$WORK"

# --- Tests 11-12: the cycle runs COMMITTED pipeline code -------------------------------------
# A generator edited but not yet committed used to become production data at the next 15-minute
# boundary. Both halves are proved with the same poison: HEAD's stub writes a clean file, the
# working-tree copy writes a marker. Whichever marker lands names the tree that actually ran.
POISON='UNCOMMITTED-GENERATOR-MARKER'

poison_gen() {  # $1 generator script, $2 output file — overwrite the TREE copy only, never HEAD's
    cat > "$REPO/scripts/$1" <<PY
import datetime, json
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
payload = {"generated": now, "marker": "$POISON", "gauges": [{"id": "G1"}],
           "roads": [], "shelters": [], "requests": []}
with open("$2", "w", encoding="utf-8") as f:
    json.dump(payload, f)
print("poisoned generator wrote $2")
PY
}

setup
poison_gen fetch-snapshot.py data/gauges-snapshot.json
run_cycle
if [ "$RC" -eq 0 ] \
   && ! grep -q "$POISON" "$REPO/data/gauges-snapshot.json" \
   && [ "$(stamp_of data/gauges-snapshot.json)" != "$OLD_STAMP" ] \
   && grep -q 'pipeline: HEAD' "$WORK/cycle.log" \
   && grep -q 'NOTE: scripts/ has uncommitted changes; this cycle runs HEAD instead' "$WORK/cycle.log"; then
    pass "11 MUTATION · an uncommitted generator cannot reach production data; HEAD's ran instead"
else
    fail "11 a dirty working-tree generator must not publish (rc=$RC)"; cat "$WORK/run.out"
fi

# --- Test 12: the escape hatch works, and is impossible to run past by accident ---------------
run_cycle --allow-dirty-code
if [ "$RC" -eq 0 ] \
   && grep -q "$POISON" "$REPO/data/gauges-snapshot.json" \
   && grep -q 'WARNING: --allow-dirty-code set' "$WORK/cycle.log" \
   && grep -q 'genuine field emergencies only' "$WORK/cycle.log"; then
    pass "12 --allow-dirty-code runs the working-tree pipeline and says so loudly"
else
    fail "12 the escape hatch runs the tree and announces itself (rc=$RC)"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

# --- Test 13: event.json is DATA, not code ----------------------------------------------------
# The cycle reads its code from HEAD and its data from the working tree. An operator re-targeting
# a live event edits data/event.json and the very next cycle must honor it, with no commit and no
# release. This also proves RESPONDER_ROOT end to end: a generator executed out of the throwaway
# HEAD tree still reads and writes the real repo.
setup
cat > "$REPO/scripts/gen-shelters.py" <<'PY'
import datetime, json, os
root = os.environ.get("RESPONDER_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(root, "data", "event.json"), encoding="utf-8") as f:
    event = json.load(f)
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
with open(os.path.join(root, "data", "shelters-live.json"), "w", encoding="utf-8") as f:
    json.dump({"generated": now, "event_name": event.get("name"), "shelters": []}, f)
print("shelters: read event.json name=%s" % event.get("name"))
PY
printf '%s\n' '{"name":"committed event"}' > "$REPO/data/event.json"
( cd "$REPO" && git add -A && git commit --quiet -m 'commit the event-reading generator' )
printf '%s\n' '{"name":"re-targeted basin"}' > "$REPO/data/event.json"  # operator edit, NOT committed
run_cycle
if [ "$RC" -eq 0 ] && grep -q 're-targeted basin' "$REPO/data/shelters-live.json"; then
    pass "13 an uncommitted data/event.json edit takes effect immediately; only CODE comes from HEAD"
else
    fail "13 event.json must stay live data (rc=$RC, got: $(cat "$REPO/data/shelters-live.json"))"
    cat "$WORK/run.out"
fi

# --- Test 15: no throwaway worktree is left behind --------------------------------------------
LEAKED=$(cd "$REPO" && git worktree list | wc -l)
if [ "$LEAKED" -eq 1 ]; then
    pass "15 the throwaway HEAD pipeline worktree is removed; none is leaked"
else
    fail "15 pipeline worktree leaked ($LEAKED entries)"; (cd "$REPO" && git worktree list)
fi
rm -rf "$WORK"

# --- Test 14: every generator the cycle runs honors RESPONDER_ROOT ----------------------------
# Static, and it has to be: a generator that resolves its paths from __file__ would run out of the
# throwaway HEAD tree and write its output there, where nothing is published. The step would still
# report OK, so the failure is silent, which is the one kind this pipeline must not ship.
NO_ROOT=()
while IFS= read -r g; do
    [ -f "$REPO_ROOT/scripts/$g" ] || { NO_ROOT+=("$g (missing)"); continue; }
    grep -q 'RESPONDER_ROOT' "$REPO_ROOT/scripts/$g" || NO_ROOT+=("$g")
done < <(grep -oE '\bgen [a-z]+ [a-z-]+\.py' "$REPO_ROOT/scripts/run-cycle.sh" | awk '{print $3}' | sort -u)
if [ "${#NO_ROOT[@]}" -eq 0 ]; then
    pass "14 every generator run-cycle.sh invokes resolves its paths through RESPONDER_ROOT"
else
    fail "14 generators that ignore RESPONDER_ROOT would write into the throwaway HEAD tree: ${NO_ROOT[*]}"
fi

# --- Test 16: the REAL road generator, failing, must reach a DEGRADED sign-off ----------------
# Every degraded test above drives a stub that exits 1 on request, so none of them could see that
# gen-roads-snapshot.py returned 0 on a dead upstream. run-cycle.sh then filed it under STEPS_OK
# and signed the cycle off clean while the road archive had not refreshed, which is exactly the
# signal freshness-monitor.sh reads. This drives the real module with its upstream cut.
setup
REAL_ROADS="$REPO_ROOT/scripts/gen-roads-snapshot.py"
cat > "$REPO/scripts/gen-roads-snapshot.py" <<PY
import importlib.util, sys
spec = importlib.util.spec_from_file_location("real_roads", "$REAL_ROADS")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.urllib.request.urlopen = lambda *a, **k: (_ for _ in ()).throw(OSError("upstream refused"))
mod.time.sleep = lambda _s: None  # the retry backoff is real; paying it here would only slow the suite
sys.exit(mod.main() or 0)
PY
( cd "$REPO" && git add -A && git commit --quiet -m 'real roads generator with a dead upstream' )
run_cycle
if [ "$RC" -eq 3 ] \
   && grep -q '=== cycle complete (DEGRADED) ===' "$WORK/cycle.log" \
   && grep -q 'failed: roads' "$WORK/cycle.log" \
   && [ "$(stamp_of data/roads-snapshot.json)" = "$OLD_STAMP" ]; then
    pass "16 a failed road snapshot degrades the sign-off instead of passing for a clean cycle"
else
    fail "16 a failed road snapshot must not sign off clean (rc=$RC)"; cat "$WORK/cycle.log"
fi
rm -rf "$WORK"

# --- Test 17: retrying a flaky NSS host must not soften what a genuinely dead one does ---------
# gen-shelters.py retries now, because a single attempt against an intermittently hanging FEMA host
# signed four cycles off DEGRADED in one hour. When the host is really down the contract is
# unchanged: abort, leave the previous file at its older stamp so it ages honestly, and name
# shelters in the degraded sign-off. Drives the real module with its upstream cut.
setup
REAL_SHELTERS="$REPO_ROOT/scripts/gen-shelters.py"
cat > "$REPO/scripts/gen-shelters.py" <<PY
import importlib.util, sys
spec = importlib.util.spec_from_file_location("real_shelters", "$REAL_SHELTERS")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.urllib.request.urlopen = lambda *a, **k: (_ for _ in ()).throw(OSError("upstream refused"))
mod.time.sleep = lambda _s: None  # the retry backoff is real; paying it here would only slow the suite
sys.exit(mod.main() or 0)
PY
( cd "$REPO" && git add -A && git commit --quiet -m 'real shelter generator with a dead upstream' )
run_cycle
if [ "$RC" -eq 3 ] \
   && grep -q '=== cycle complete (DEGRADED) ===' "$WORK/cycle.log" \
   && grep -q 'failed: shelters' "$WORK/cycle.log" \
   && [ "$(stamp_of data/shelters-live.json)" = "$OLD_STAMP" ]; then
    pass "17 a persistently dead NSS host still degrades the sign-off and keeps the previous file"
else
    fail "17 a dead shelter upstream must degrade, not sign off clean (rc=$RC)"; cat "$WORK/cycle.log"
fi
rm -rf "$WORK"

# --- Tests 18-21: step and cycle time budgets -------------------------------------------------
# The cycle holds a non-blocking flock, so a generator that hangs past the 15-minute window makes
# the NEXT cycle log SKIP and exit: one hung upstream stops the board publishing for as long as it
# lasts. gen-history.py was the long pole, walking hundreds of lids at 90-180s per request with no
# aggregate bound. A timed-out step must land on the EXISTING partial-publish path rather than
# opening a new failure mode, so these pin that it behaves exactly like a failed one.
hash_of() { sha256sum "$REPO/$1" | awk '{print $1}'; }

# --- Test 18: a step over its budget is killed, reported as timed out, and publishes nothing new
setup
SHELTERS_BEFORE=$(hash_of data/shelters-live.json)
FAILING="" SLOW="gen-shelters" STEP_BUDGET=5 CYCLE_BUDGET="" run_cycle
if [ "$RC" -eq 3 ] \
   && grep -q 'TIMEOUT: gen-shelters.py exceeded 5s and was killed' "$WORK/cycle.log" \
   && ! grep -q 'WARN: gen-shelters.py failed' "$WORK/cycle.log" \
   && grep -q '=== cycle complete (DEGRADED) ===' "$WORK/cycle.log" \
   && grep -q 'timed out: shelters' "$WORK/cycle.log" \
   && [ "$(hash_of data/shelters-live.json)" = "$SHELTERS_BEFORE" ] \
   && [ "$(stamp_of data/roads-snapshot.json)" != "$OLD_STAMP" ] \
   && [ "$(stamp_of data/gauges-snapshot.json)" != "$OLD_STAMP" ] \
   && [ "$(stamp_of feed.xml)" != "$OLD_STAMP" ] \
   && grep -q 'stub deploy' "$WORK/run.out"; then
    pass "18 a step over its budget is killed and named as timed out; the rest still publish"
else
    fail "18 a timed-out step must degrade, not succeed and not block the publish (rc=$RC)"
    cat "$WORK/cycle.log"
fi

# --- Test 18b: the killed step's previous output is byte-identical, not merely same-stamped ------
if [ "$(hash_of data/shelters-live.json)" = "$SHELTERS_BEFORE" ] \
   && [ "$(stamp_of data/shelters-live.json)" = "$OLD_STAMP" ]; then
    pass "18b the timed-out step's previous file is byte-identical, so it keeps aging honestly"
else
    fail "18b a killed generator must not touch its output file"
fi
rm -rf "$WORK"

# --- Test 19: a timeout is distinguishable from an upstream that is simply down -----------------
# Both stale the same source. If they share one bucket, a budget that is slightly too tight reads
# as a permanent upstream outage and nobody ever fixes the budget.
setup
FAILING="gen-crossings-status" SLOW="gen-shelters" STEP_BUDGET=5 CYCLE_BUDGET="" run_cycle
SIGNOFF=$(grep -F '=== cycle complete (DEGRADED) ===' "$WORK/cycle.log" | command tail -1)
case "$SIGNOFF" in
    *"failed: crossstatus"*"timed out: shelters"*)
        pass "19 a killed step and a dead upstream are reported in separate buckets" ;;
    *)
        fail "19 timeout and failure must not share a bucket (got: $SIGNOFF)" ;;
esac
rm -rf "$WORK"

# --- Test 20: the aggregate guard bounds the cycle even when several steps run long -------------
# Per-step budgets alone cannot do this: they sum to more than the window.
setup
T0=$(date +%s)
FAILING="" SLOW="gen-roads-snapshot,gen-history,gen-shelters,gen-notices" \
    STEP_BUDGET=30 CYCLE_BUDGET=12 run_cycle
ELAPSED=$(( $(date +%s) - T0 ))
# unguarded, four 30s steps would run 120s; the aggregate guard has to cut that to about 12s
if [ "$ELAPSED" -lt 45 ] \
   && grep -q 'squeezed from 30s by the cycle deadline' "$WORK/cycle.log" \
   && grep -q 'not started; the 12s cycle generator budget is spent' "$WORK/cycle.log" \
   && [ "$RC" -eq 3 ] \
   && grep -q 'stub deploy' "$WORK/run.out"; then
    pass "20 the aggregate guard bounds the cycle with several slow steps (${ELAPSED}s, not 120s)"
else
    fail "20 the cycle budget must bound the total (elapsed=${ELAPSED}s rc=$RC)"
    cat "$WORK/cycle.log"
fi
rm -rf "$WORK"

# --- Tests 22-23: nothing reaches origin until deploy.sh's gate is green ------------------------
# The cycle used to `git push origin main` itself, one line before calling deploy.sh, so a red gate
# still put the commit (and any un-gated code commit sitting on the branch) on origin. The commit
# still has to precede deploy.sh, because the artifact it builds is `git archive HEAD`; the push is
# now deploy.sh's, on the far side of its own gate.
origin_count() { git -C "$WORK/remote.git" rev-list --count refs/heads/main; }

setup
printf '%s\n' '#!/bin/bash' 'echo "stub deploy: gate is RED"; exit 1' > "$REPO/scripts/deploy.sh"
chmod +x "$REPO/scripts/deploy.sh"
( cd "$REPO" && git add -A && git commit --quiet -m 'a deploy whose gate fails' )
BEFORE=$(origin_count)
FAILING="" run_cycle
LOCAL=$(cd "$REPO" && git rev-list --count HEAD)
if [ "$RC" -ne 0 ] \
   && [ "$LOCAL" -gt "$BEFORE" ] \
   && [ "$(origin_count)" -eq "$BEFORE" ] \
   && grep -q 'committed locally and NOT pushed' "$WORK/cycle.log"; then
    pass "22 MUTATION · a failing deploy gate leaves the data committed locally and origin untouched"
else
    fail "22 a red gate must not reach origin (rc=$RC local=$LOCAL origin=$(origin_count) before=$BEFORE)"
    cat "$WORK/cycle.log"
fi
rm -rf "$WORK"

# the converse: when the gate passes, deploy.sh's own post-gate push is what advances origin, so a
# healthy cycle still publishes exactly once
setup
printf '%s\n' '#!/bin/bash' 'echo "stub deploy"' 'git push --quiet origin main' > "$REPO/scripts/deploy.sh"
chmod +x "$REPO/scripts/deploy.sh"
( cd "$REPO" && git add -A && git commit --quiet -m 'a deploy that pushes after its gate' )
BEFORE=$(origin_count)
FAILING="" run_cycle
if [ "$RC" -eq 0 ] && [ "$(origin_count)" -gt "$BEFORE" ]; then
    pass "23 a green gate still lands the data on origin, pushed by deploy.sh after it gated HEAD"
else
    fail "23 a healthy cycle must still reach origin (rc=$RC origin=$(origin_count) before=$BEFORE)"
    cat "$WORK/cycle.log"
fi
rm -rf "$WORK"

# --- Test 26: the publish phase is budgeted too --------------------------------------------------
# It was the only unbudgeted step, and it runs holding the cycle lock, so deploy.sh's own retry
# ladders (13 bundle tries x 15s, uncapped curls) could stall the board's publishing for several
# cycles rather than one. A hung publish must be killed, bucketed as a TIMEOUT, and leave the data
# committed locally for the next cycle to republish.
setup
printf '%s\n' '#!/bin/bash' 'echo "stub deploy: hanging"' 'sleep 60' > "$REPO/scripts/deploy.sh"
chmod +x "$REPO/scripts/deploy.sh"
( cd "$REPO" && git add -A && git commit --quiet -m 'a deploy that hangs' )
BEFORE=$(origin_count)
START=$(date +%s)
FAILING="" PUBLISH_BUDGET=5 run_cycle
ELAPSED=$(( $(date +%s) - START ))
if [ "$RC" -ne 0 ] && [ "$ELAPSED" -lt 45 ] \
   && grep -q 'TIMEOUT: deploy.sh outran its 5s publish budget' "$WORK/cycle.log" \
   && grep -q 'committed:' "$WORK/cycle.log" \
   && [ "$(origin_count)" -eq "$BEFORE" ]; then
    pass "26 a hung publish is killed at its budget, bucketed TIMEOUT, and republished next cycle (${ELAPSED}s)"
else
    fail "26 the publish phase must be bounded (rc=$RC elapsed=${ELAPSED}s origin=$(origin_count) before=$BEFORE)"
    cat "$WORK/cycle.log"
fi
rm -rf "$WORK"

# --- Tests 24-25: an uncommitted data/event.json is announced, not silently half-applied ---------
# Test 13 above pins that the edit takes effect immediately, which is the point AND the hazard: the
# generators use it while deploy.sh ships HEAD's, so the board is configured for a different AO
# than its data. The cycle never stages event.json, so this state persists until somebody commits
# it; the warning is what makes "until somebody" finite. Warned every cycle, never fatal.
setup
printf '%s\n' '{"name":"committed event","zoom":9}' > "$REPO/data/event.json"
( cd "$REPO" && git add -A && git commit --quiet -m 'commit the event config' )
FAILING="" run_cycle
if [ "$RC" -eq 0 ] && ! grep -q 'data/event.json does not match HEAD' "$WORK/cycle.log"; then
    pass "24 a committed data/event.json produces no divergence warning"
else
    fail "24 a clean event.json must not warn (rc=$RC)"; cat "$WORK/cycle.log"
fi

printf '%s\n' '{"name":"re-targeted basin","zoom":11}' > "$REPO/data/event.json"  # operator edit, NOT committed
FAILING="" run_cycle
if [ "$RC" -eq 0 ] \
   && grep -q 'data/event.json does not match HEAD' "$WORK/cycle.log" \
   && grep -q 'AO pills, gaugeBbox, zoom and tideStations' "$WORK/cycle.log" \
   && grep -q 're-targeted basin' "$WORK/cycle.log" \
   && grep -q 'stub deploy' "$WORK/run.out"; then
    pass "25 MUTATION · an uncommitted event.json warns loudly, shows the diff, and still publishes"
else
    fail "25 the event.json divergence must warn without stopping the publish (rc=$RC)"
    cat "$WORK/cycle.log"
fi
rm -rf "$WORK"

# --- Test 21: the budgets have to fit the window they exist to protect -------------------------
# Static arithmetic over the real constants, per the "assert the bound in code" edict: a budget
# raised past the cron interval, or a cron made more frequent, silently makes the guard useless.
# Both numbers are read from source so neither can drift alone.
CYCLE_BUDGET_DEFAULT=$(grep -oP 'CYCLE_BUDGET_S="\$\{RESPONDER_CYCLE_BUDGET_S:-\K[0-9]+' "$CYCLE_SRC")
BIGGEST_STEP=$(grep -oP '^BUDGET_[A-Z]+_S=\K[0-9]+' "$CYCLE_SRC" | sort -n | command tail -1)
INTERVAL_S=$(python3 -c '
import re, sys
line = re.search(r"^DATA_LINE=\"([0-9,]+) ", open(sys.argv[1]).read(), re.M).group(1)
m = sorted(int(x) for x in line.split(","))
print(min(min((b - a) for a, b in zip(m, m[1:])), 60 - m[-1] + m[0]) * 60)
' "$REPO_ROOT/scripts/install-cron.sh")
# The publish reserve is the one the cycle actually enforces on deploy.sh, read from source rather
# than restated here: a reserve this file believed in while nothing enforced it is how the publish
# phase stayed the only unbudgeted step. Worst observed publish phase is ~261s (a code-change cycle,
# where the deploy gate also runs the shell suites); a data-only cycle is ~30s.
PUBLISH_RESERVE_S=$(grep -oP 'PUBLISH_BUDGET_S="\$\{RESPONDER_PUBLISH_BUDGET_S:-\K[0-9]+' "$CYCLE_SRC")
if [ -n "$CYCLE_BUDGET_DEFAULT" ] && [ -n "$BIGGEST_STEP" ] && [ -n "$INTERVAL_S" ] && [ -n "$PUBLISH_RESERVE_S" ] \
   && [ "$(( CYCLE_BUDGET_DEFAULT + PUBLISH_RESERVE_S ))" -le "$INTERVAL_S" ] \
   && [ "$BIGGEST_STEP" -le "$CYCLE_BUDGET_DEFAULT" ] \
   && grep -q 'command timeout -k "\$KILL_GRACE_S" "\$PUBLISH_BUDGET_S" bash' "$CYCLE_SRC"; then
    pass "21 budgets fit the cron window (${CYCLE_BUDGET_DEFAULT}s + ${PUBLISH_RESERVE_S}s enforced publish budget <= ${INTERVAL_S}s; biggest step ${BIGGEST_STEP}s)"
else
    fail "21 the generator budget plus the ENFORCED publish budget must fit the cron interval (budget=${CYCLE_BUDGET_DEFAULT} publish=${PUBLISH_RESERVE_S:-unset} step=${BIGGEST_STEP} interval=${INTERVAL_S})"
fi

echo "----"
if [ "$FAILS" -eq 0 ]; then
    echo "ALL RUN-CYCLE TESTS PASSED"
    exit 0
else
    echo "${FAILS} TEST(S) FAILED"
    exit 1
fi
