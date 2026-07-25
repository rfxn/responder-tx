#!/bin/bash
# tests/cycle-check.test.sh — data-cycle immunity tests for scripts/cycle-check.sh.
# The cycle validator runs inside the 15-min data cron. Its code-lane checks read the
# repo, so a release agent editing js/core.js, index.html, sw.js or the changelogs made
# a data cycle fail and the public board serve stale flood data. --code-from-head reads
# the committed code instead, while the data lane keeps reading the working tree (that
# is the data the cycle is about to commit). Proven here:
#   1 a consistent repo passes both ways
#   2 a mid-bump working tree fails the release lane but does NOT fail the data cycle
#   3 a fully bumped but uncommitted tree passes both ways
#   4 a genuine version disagreement AT HEAD still fails (the check is not a no-op)
#   5 same immunity for the JS-syntax check, and a syntax error at HEAD still fails
#   6 the 911-gate Escape check still has teeth when read from HEAD
#   7 the data lane still reads the working tree under --code-from-head
#   8 run-cycle.sh actually passes the flag
# Runs against a scratch git repo, never the real one. Run: bash tests/cycle-check.test.sh
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
CHECK_SRC="$REPO_ROOT/scripts/cycle-check.sh"
FAILS=0

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; FAILS=$((FAILS + 1)); }

setup() {  # scratch repo at v1.0.0 that satisfies all ten checks
    WORK=$(mktemp -d)
    REPO="$WORK/repo"
    mkdir -p "$REPO"/{js,data,scripts}

    printf "%s\n" "const APP_VERSION = 'v1.0.0';" > "$REPO/js/core.js"
    cat > "$REPO/js/boot.js" <<'JS'
'use strict';
// #safety-modal is intentionally absent: the 911 self-deploy gate closes only via #safety-ack
// (which records the acknowledgment), never on Escape or a backdrop click
function escDismiss() {
  for (const id of ['#hydro-modal', '#basin-view']) {
    const m = document.querySelector(id);
    if (m && !m.hidden) { m.hidden = true; break; }
  }
}
async function loadEventConfig() {
  const el = document.querySelector('.brand');
  if (el) el.textContent = 'fixture';
}
JS
    # the lens-911 gate (check k, v0.97.94) needs #disclaimer plus a .drive-911 footer inside every
    # lens root, so the fixture carries them; without this the gate fails on the fixture, not the code
    printf '%s\n' \
        '<!doctype html><html><head>' \
        '<script src="js/core.js?v=1.0.0"></script>' \
        '<script src="js/boot.js?v=1.0.0"></script>' \
        '</head><body><div class="brand">fixture board</div>' \
        '<main>' \
        '<div id="drive-mode"><span class="drive-911">call 911</span></div>' \
        '<div id="summary-view"><span class="drive-911">call 911</span></div>' \
        '<div id="recovery-view"><span class="drive-911">call 911</span></div>' \
        '<div id="basin-view"><span class="drive-911">call 911</span></div>' \
        '</main>' \
        '<div id="disclaimer">call 911</div>' \
        '</body></html>' > "$REPO/index.html"
    printf "%s\n" "const SW_VERSION = '1.0.0';" > "$REPO/sw.js"
    printf '%s\n' '## v1.0.0 (2026-07-24)' '' '- [New] fixture' > "$REPO/CHANGELOG.md"
    printf '%s\n' '{"versions":[{"v":"v1.0.0","date":"2026-07-24","line":"fixture"}]}' > "$REPO/data/changelog.json"
    printf '%s\n' '{}' > "$REPO/data/event.json"
    printf '%s\n' '{"requests":[]}' > "$REPO/data/requests.json"
    python3 - "$REPO/data/gauges-snapshot.json" <<'PY'
import json, sys
gauges = [{"lid": "FX%03d" % i, "status": {"observed": {"primary": 1.0}}} for i in range(30)]
json.dump({"generated": "2026-07-24T00:00:00Z", "gauges": gauges}, open(sys.argv[1], "w"))
PY
    printf '%s\n' '<?xml version="1.0"?><rss version="2.0"><channel><title>fixture</title></channel></rss>' > "$REPO/feed.xml"
    printf '%s\n' 'BEGIN:VCALENDAR' 'END:VCALENDAR' > "$REPO/crests.ics"

    cp "$CHECK_SRC" "$REPO/scripts/cycle-check.sh"
    (
        cd "$REPO" || exit 1
        git init --quiet
        git symbolic-ref HEAD refs/heads/main  # portable across git defaults of master vs main
        git config user.name 'Fixture'
        git config user.email 'fixture@example.test'
        git add -A
        git commit --quiet -m 'v1.0.0 fixture'
    )
}

run_check() {  # runs the fixture's cycle-check; args passed through. Sets RC and $WORK/out
    ( cd "$REPO" && bash scripts/cycle-check.sh "$@" ) > "$WORK/out" 2>&1
    RC=$?
    return "$RC"
}

bump_partial() {  # the exact release-lane window: some files bumped, the rest not yet
    printf "%s\n" "const APP_VERSION = 'v9.9.9';" > "$REPO/js/core.js"
    sed -i 's/?v=1\.0\.0/?v=9.9.9/g' "$REPO/index.html"
    printf "%s\n" "const SW_VERSION = '9.9.9';" > "$REPO/sw.js"
    # data/changelog.json and CHANGELOG.md deliberately still at v1.0.0
}

bump_full() {  # a complete but not yet committed bump
    bump_partial
    printf '%s\n' '{"versions":[{"v":"v9.9.9","date":"2026-07-24","line":"fixture"}]}' > "$REPO/data/changelog.json"
    printf '%s\n' '## v9.9.9 (2026-07-24)' '' '- [New] fixture' > "$REPO/CHANGELOG.md"
}

# --- Test 1: a consistent repo passes both ways -----------------------------
setup
run_check; A=$?
run_check --code-from-head; B=$?
if [ "$A" -eq 0 ] && [ "$B" -eq 0 ]; then
    pass "1 a consistent repo passes with and without --code-from-head"
else
    fail "1 consistent repo passes (tree=${A} head=${B})"; cat "$WORK/out"
fi
rm -rf "$WORK"

# --- Test 2: a mid-bump working tree must not fail the data cycle -----------
setup
bump_partial
run_check; A=$?
run_check --code-from-head; B=$?
if [ "$A" -ne 0 ] && [ "$B" -eq 0 ] && grep -q 'version agreement (v1\.0\.0' "$WORK/out"; then
    pass "2 a mid-bump tree still fails the release lane but no longer fails the data cycle"
else
    fail "2 mid-bump immunity (tree=${A} expected non-zero, head=${B} expected 0)"; cat "$WORK/out"
fi
rm -rf "$WORK"

# --- Test 3: a fully bumped, uncommitted tree passes both ways --------------
setup
bump_full
run_check; A=$?
run_check --code-from-head; B=$?
if [ "$A" -eq 0 ] && [ "$B" -eq 0 ]; then
    pass "3 a complete but uncommitted bump passes both ways"
else
    fail "3 complete uncommitted bump (tree=${A} head=${B})"; cat "$WORK/out"
fi
rm -rf "$WORK"

# --- Test 4: a genuine disagreement AT HEAD still fails ---------------------
setup
printf "%s\n" "const APP_VERSION = 'v2.0.0';" > "$REPO/js/core.js"  # stamps left at 1.0.0
( cd "$REPO" && git add -A && git commit --quiet -m 'commit a real four-way disagreement' )
run_check --code-from-head; B=$?
if [ "$B" -ne 0 ] && grep -q 'FAIL: version agreement' "$WORK/out"; then
    pass "4 a committed four-way disagreement still fails (the check is not weakened to a no-op)"
else
    fail "4 committed disagreement still fails (head=${B})"; cat "$WORK/out"
fi
rm -rf "$WORK"

# --- Test 5: the JS-syntax check has the same immunity and the same teeth ---
setup
printf '%s\n' 'function broken( {' > "$REPO/js/core.js"
run_check; A=$?
run_check --code-from-head; B=$?
if [ "$A" -ne 0 ] && [ "$B" -eq 0 ]; then
    pass "5 an uncommitted syntax error fails the release lane, not the data cycle"
else
    fail "5 syntax-error immunity (tree=${A} head=${B})"; cat "$WORK/out"
fi
( cd "$REPO" && git add -A && git commit --quiet -m 'commit a syntax error' )
run_check --code-from-head; B=$?
if [ "$B" -ne 0 ] && grep -q 'FAIL: JS syntax' "$WORK/out"; then
    pass "6 a syntax error at HEAD still fails the data cycle"
else
    fail "6 committed syntax error still fails (head=${B})"; cat "$WORK/out"
fi
rm -rf "$WORK"

# --- Test 7: the 911-gate Escape check keeps its teeth when read from HEAD --
setup
sed -i "s/'#hydro-modal', '#basin-view'/'#safety-modal', '#hydro-modal'/" "$REPO/js/boot.js"
( cd "$REPO" && git add -A && git commit --quiet -m 'break the 911 gate at HEAD' )
run_check --code-from-head; B=$?
if [ "$B" -ne 0 ] && grep -q 'FAIL: 911-gate Escape immunity' "$WORK/out"; then
    pass "7 the 911-gate Escape check still fires when the code lane is read from HEAD"
else
    fail "7 911-gate check from HEAD (head=${B})"; cat "$WORK/out"
fi
rm -rf "$WORK"

# --- Test 8: the data lane still reads the working tree ---------------------
setup
printf '%s\n' '{ this is not json' > "$REPO/data/gauges-snapshot.json"
run_check --code-from-head; B=$?
if [ "$B" -ne 0 ] && grep -q 'FAIL: JSON validity' "$WORK/out"; then
    pass "8 --code-from-head never blinds the data checks: uncommitted data is still validated"
else
    fail "8 data lane still reads the working tree (head=${B})"; cat "$WORK/out"
fi
rm -rf "$WORK"

# --- Test 9: the data cron actually asks for the immunity -------------------
if grep -q 'cycle-check\.sh --code-from-head' "$REPO_ROOT/scripts/run-cycle.sh"; then
    pass "9 run-cycle.sh invokes cycle-check with --code-from-head"
else
    fail "9 run-cycle.sh passes the flag"
    grep -n 'cycle-check' "$REPO_ROOT/scripts/run-cycle.sh"
fi

# --- Test 10: an unknown argument is rejected, never silently ignored -------
setup
run_check --not-a-real-flag; A=$?
if [ "$A" -ne 0 ] && grep -q 'unknown argument' "$WORK/out"; then
    pass "10 an unknown argument is rejected loudly (a silently ignored flag is a silent no-op)"
else
    fail "10 unknown argument rejected (rc=${A})"; cat "$WORK/out"
fi
rm -rf "$WORK"

# --- Tests 11-14: the cursor guard sees regression but tolerates rotation ----
# A cursor that moves backwards re-delivers or re-hides owner messages, the exact failure the ops
# chat pipeline exists to prevent, and the old check could not see it: it read format and an upper
# bound only. Rotation looks identical from a single sample, so the guard is checked against both.
set_chat() {  # $1 inbox lines, $2 .chat-cursor, $3 .chat-ack-cursor
    python3 -c 'import sys; open(sys.argv[1], "w").write("{\"m\":1}\n" * int(sys.argv[2]))' \
        "$REPO/data/chat-inbox.jsonl" "$1"
    printf '%s\n' "$2" > "$REPO/data/.chat-cursor"
    printf '%s\n' "$3" > "$REPO/data/.chat-ack-cursor"
}

setup
set_chat 10 10 10
run_check; A=$?
if [ "$A" -eq 0 ] && [ ! -f "$REPO/data/.chat-cursor-guard" ]; then
    fail "11 first run records prior cursor state"
elif [ "$A" -eq 0 ] && [ "$(cat "$REPO/data/.chat-cursor-guard")" = "10 10 10" ]; then
    pass "11 a first run with no prior state records it and passes (fresh checkout is not a failure)"
else
    fail "11 first run records and passes (rc=${A}, guard='$(cat "$REPO/data/.chat-cursor-guard" 2>/dev/null)')"; cat "$WORK/out"
fi

# MUTATION: feed it a cursor that moved backwards with the inbox unchanged
set_chat 10 3 10
run_check; A=$?
if [ "$A" -ne 0 ] && grep -q 'FAIL: chat cursors' "$WORK/out" && grep -q '\.chat-cursor regressed 10 -> 3' "$WORK/out"; then
    pass "12 MUTATION · a cursor that moved backwards fails, naming both values"
else
    fail "12 backwards cursor fails (rc=${A})"; cat "$WORK/out"
fi
# and the very next run passes: one ops-chat fault must not strand the board on every later cycle
run_check; A=$?
if [ "$A" -eq 0 ]; then
    pass "13 the regression is reported once, not latched into every following data cycle"
else
    fail "13 regression self-heals after one report (rc=${A})"; cat "$WORK/out"
fi
rm -rf "$WORK"

setup
set_chat 10 10 10
run_check
# rotation, exactly as server.py _rotate_inbox_if_due() leaves it: inbox archived, both cursors 0
mv "$REPO/data/chat-inbox.jsonl" "$REPO/data/chat-inbox-archive-20260725T000000Z.jsonl"
set_chat 0 0 0
run_check; A=$?
if [ "$A" -eq 0 ] && grep -q 'OK:   chat cursors' "$WORK/out"; then
    pass "14 an inbox rotation resets both cursors to 0 and is not read as regression"
else
    fail "14 rotation tolerated (rc=${A})"; cat "$WORK/out"
fi
# a cursor beyond the rotated inbox is still caught: the reset must move both, never one
printf '%s\n' '7' > "$REPO/data/.chat-cursor"
run_check; A=$?
if [ "$A" -ne 0 ] && grep -q 'exceeds data/chat-inbox.jsonl line count 0' "$WORK/out"; then
    pass "15 a half-applied rotation (one cursor left behind) still fails"
else
    fail "15 half-applied rotation fails (rc=${A})"; cat "$WORK/out"
fi
rm -rf "$WORK"

echo "----"
if [ "$FAILS" -eq 0 ]; then
    echo "ALL CYCLE-CHECK IMMUNITY TESTS PASSED"
    exit 0
else
    echo "${FAILS} TEST(S) FAILED"
    exit 1
fi
