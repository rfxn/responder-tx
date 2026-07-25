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
import datetime, json, os, sys
name = "${1%.py}"
if name in os.environ.get("RESPONDER_TEST_FAIL", "").split(","):
    sys.exit(name + ": stub failure")
out = "$2"
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
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
    for f in gauges-snapshot roads-snapshot crest-summary history gauge-meta shelters-live caltopo-export requests; do
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
    bash "$REPO/scripts/run-cycle.sh" > "$WORK/run.out" 2>&1
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
FAILING="fetch-snapshot,gen-roads-snapshot,gen-history,gen-crest-summary,gen-notices,gen-feeds,gen-shelters,gen-caltopo" run_cycle
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

echo "----"
if [ "$FAILS" -eq 0 ]; then
    echo "ALL RUN-CYCLE TESTS PASSED"
    exit 0
else
    echo "${FAILS} TEST(S) FAILED"
    exit 1
fi
