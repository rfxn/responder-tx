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
#   9 data/event.json is data: both lanes read the working tree, so an uncommitted re-target
#     is what gets validated (the copy the generators and the client actually load)
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
    printf '%s\n' '{"version": "v1.0.0"}' > "$REPO/data/version.json"
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
    printf '%s\n' '{"version": "v9.9.9"}' > "$REPO/data/version.json"
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
if grep -qE 'cycle-check\.sh"? --code-from-head' "$REPO_ROOT/scripts/run-cycle.sh"; then
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

# --- Tests 16-20: the bounded compatibility view (v0.98.9) -------------------
# data/history.json is now the newest COMPAT_WINDOW_DAYS of the record, not the record. The gate
# has to allow that and still catch a fallback file that is stale, forked, or silently partial.
setup
seed_history() {  # $1 = how the fixture's data/history.json should be wrong (or "ok")
    mkdir -p "$REPO/history/day"
    python3 - "$REPO" "$1" <<'HISTPY'
import hashlib, json, os, sys
repo, mode = sys.argv[1], sys.argv[2]
frames = [{"t": "2026-07-%02dT00:00:00Z" % d, "gauges": {"FX000": [1.0, 0]}} for d in range(11, 26)]
days = []
for f in frames:
    day = f["t"][:10]
    payload = json.dumps({"d": day, "frames": [f]}, separators=(",", ":")) + "\n"
    open(os.path.join(repo, "history", "day", day + ".json"), "w").write(payload)
    days.append({"d": day, "n": 1, "t0": f["t"], "t1": f["t"], "bytes": len(payload),
                 "h": hashlib.sha256(payload.encode()).hexdigest()[:12]})
gi = {"FX000": {"name": "Fixture", "lat": 30.0, "lon": -97.0}}
json.dump({"generated": "2026-07-25T00:00:00Z", "format": 1, "frames": len(frames),
           "gaugeIndex": gi, "days": days}, open(os.path.join(repo, "history", "index.json"), "w"))
kept = frames[-8:]
view = {"kind": "recent-window", "days": 7, "from": kept[0]["t"], "frames": len(kept),
        "full": {"index": "history/index.json", "day": "history/day/YYYY-MM-DD.json",
                 "frames": len(frames), "from": frames[0]["t"], "to": frames[-1]["t"]}}
doc = {"generated": "2026-07-25T00:00:00Z", "view": view, "frames": kept, "gaugeIndex": gi}
if mode == "undeclared":
    doc.pop("view")
elif mode == "stale":               # a window that is not recent: the prefix, not the tail
    doc["frames"] = frames[:8]
    doc["view"]["from"] = frames[0]["t"]
elif mode == "forked":              # same length, one observation quietly different
    doc["frames"] = [dict(f) for f in kept]
    doc["frames"][3] = dict(doc["frames"][3], gauges={"FX000": [99.0, 4]})
elif mode == "overclaims":          # declares a whole record no bigger than what it carries
    doc["view"]["full"]["frames"] = len(kept)
json.dump(doc, open(os.path.join(repo, "data", "history.json"), "w"))
HISTPY
}

seed_history ok
run_check; A=$?
if [ "$A" -eq 0 ] && grep -q 'OK:   data schemas' "$WORK/out"; then
    pass "16 a bounded compatibility view that declares itself passes"
else
    fail "16 bounded view passes (rc=${A})"; cat "$WORK/out"
fi

seed_history undeclared
run_check; A=$?
if [ "$A" -ne 0 ] && grep -q 'does not declare' "$WORK/out"; then
    pass "17 a partial data/history.json that does NOT say so is rejected"
else
    fail "17 undeclared partial rejected (rc=${A})"; cat "$WORK/out"
fi

seed_history stale
run_check; A=$?
if [ "$A" -ne 0 ] && grep -q 'not the tail' "$WORK/out"; then
    pass "18 a recent-window claim over the OLDEST frames is rejected"
else
    fail "18 stale window rejected (rc=${A})"; cat "$WORK/out"
fi

seed_history forked
run_check; A=$?
if [ "$A" -ne 0 ] && grep -q 'not the tail' "$WORK/out"; then
    pass "19 a same-length view that disagrees with the record about an observation is rejected"
else
    fail "19 forked view rejected (rc=${A})"; cat "$WORK/out"
fi

seed_history overclaims
run_check; A=$?
if [ "$A" -ne 0 ] && grep -q 'view.full says' "$WORK/out"; then
    pass "20 a view whose pointer to the whole record understates it is rejected"
else
    fail "20 overclaiming view rejected (rc=${A})"; cat "$WORK/out"
fi
# --- Test 21: the update-poll artifact is inside the version gate ------------
# data/version.json is the only thing a long-lived tab reads to learn a new build exists, so a
# stale one strands every open board silently. It must fail the gate exactly like the changelog.
setup
printf '%s\n' '{"version": "v0.0.1"}' > "$REPO/data/version.json"
run_check; A=$?
if [ "$A" -ne 0 ] && grep -q "data/version.json 'v0.0.1' != APP_VERSION" "$WORK/out"; then
    pass "21 a stale data/version.json fails the version gate by name"
else
    fail "21 stale version.json rejected (rc=${A})"; cat "$WORK/out"
fi

setup
rm -f "$REPO/data/version.json"
run_check; A=$?
if [ "$A" -ne 0 ] && grep -q 'cannot read version from data/version.json' "$WORK/out"; then
    pass "22 a missing data/version.json fails the version gate"
else
    fail "22 missing version.json rejected (rc=${A})"; cat "$WORK/out"
fi
rm -rf "$WORK"

# --- Tests 23-26: event.json is DATA, so both lanes must read the working tree ---
# The generators and the client read data/event.json from the working tree with no commit — that is
# the deliberate design that lets an AO re-target take effect immediately. A code-lane check that
# read HEAD's copy would validate the previous config and never see the change it exists to catch.
usgs_fixture() {  # core.js exposing the bbox gate's contract, plus a committed in-budget gaugeBbox
    cat > "$REPO/js/core.js" <<'JS'
const APP_VERSION = 'v1.0.0';
const USGS_BBOX_LIMIT = 25;
const USGS_BBOX_BUDGET = 20;
const USGS_BBOX_MAX_TILES = 4;
const CONFIG = {
  usgsIvBase: 'https://example.test/iv',
  gaugeBbox: { xmin: -98.0, ymin: 29.0, xmax: -97.0, ymax: 30.0 },
};
const usgsBboxCost = (b) => (b.xmax - b.xmin) * (b.ymax - b.ymin);
const usgsBboxTiles = (b) => [b];
JS
    printf '%s\n' '{"gaugeBbox":{"xmin":-98.0,"ymin":29.0,"xmax":-97.0,"ymax":30.0}}' > "$REPO/data/event.json"
    ( cd "$REPO" && git add -A && git commit --quiet -m 'commit an in-budget gaugeBbox' )
}

setup
usgs_fixture
run_check --code-from-head; A=$?
if [ "$A" -eq 0 ] && grep -q 'OK:   USGS bbox area cap' "$WORK/out"; then
    pass "23 the committed in-budget gaugeBbox passes the bbox gate"
else
    fail "23 in-budget gaugeBbox passes (rc=${A})"; cat "$WORK/out"
fi

# MUTATION: re-target the AO in the working tree only, exactly as an operator does
printf '%s\n' '{"gaugeBbox":{"xmin":-106.0,"ymin":25.0,"xmax":-93.0,"ymax":37.0}}' > "$REPO/data/event.json"
run_check --code-from-head; A=$?
if [ "$A" -ne 0 ] && grep -q 'FAIL: USGS bbox area cap' "$WORK/out"; then
    pass "24 MUTATION · an UNCOMMITTED oversized gaugeBbox is caught (the gate reads the config the pipeline uses)"
else
    fail "24 uncommitted oversized gaugeBbox caught (rc=${A})"; cat "$WORK/out"
fi

# and the converse: a bad box at HEAD that the tree has already fixed must not fail the cycle
( cd "$REPO" && git add -A && git commit --quiet -m 'commit the oversized gaugeBbox' )
printf '%s\n' '{"gaugeBbox":{"xmin":-98.0,"ymin":29.0,"xmax":-97.0,"ymax":30.0}}' > "$REPO/data/event.json"
run_check --code-from-head; A=$?
if [ "$A" -eq 0 ]; then
    pass "25 a bbox already fixed in the working tree passes, even though HEAD still carries the bad one"
else
    fail "25 working-tree fix passes (rc=${A})"; cat "$WORK/out"
fi
rm -rf "$WORK"

# the brand hook reads event.json too, and had the same confusion
setup
printf '%s\n' '{"name":"Fixture Flood"}' > "$REPO/data/event.json"  # uncommitted: boot.js at HEAD sets no baseTitle
run_check --code-from-head; A=$?
if [ "$A" -ne 0 ] && grep -q 'FAIL: event-config brand hook' "$WORK/out"; then
    pass "26 the brand hook also reads the working-tree event.json, not HEAD's"
else
    fail "26 brand hook reads the working tree (rc=${A})"; cat "$WORK/out"
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
