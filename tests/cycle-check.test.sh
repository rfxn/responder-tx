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
    mkdir -p "$REPO"/{js,data,scripts,tests}

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
        '<div id="boot-noscript"><span class="drive-911">call 911</span></div>' \
        '<div id="boot-unsupported"><span class="drive-911">call 911</span></div>' \
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

    # The hazard-allowlist check shells out to tests/hazard-mirror.js. The fixture stands in for it:
    # this file proves the WIRING (the check runs, its detail is reported, and a non-zero exit fails
    # the lane), while tests/hazard-table.test.js proves the substance against the real tables.
    cat > "$REPO/tests/hazard-mirror.js" <<'JS'
'use strict';
process.stdout.write('35 events mirrored (fixture)');
JS
    printf '%s\n' '# fixture stand-in for the real generator' 'HAZARD_EVENTS = {}' > "$REPO/scripts/gen-caltopo.py"
    printf '%s\n' "module.exports = { loadApp: () => ({}) };" > "$REPO/tests/harness.js"

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

# --- Tests 27-32: the offline warm depth (v0.99.51) -------------------------
# HISTORY_WARM_MAX_DAYS and HISTORY_WARM_MAX_BYTES describe one bound. They drifted apart silently
# as the archive grew and the warm delivered two days of a declared eight, so the delivered depth is
# measured against the index's real chunk sizes. The check must have teeth in the release lane, must
# NOT stop a data cycle over archive growth, and must never go blind instead of failing.
set_warm() {  # $1 declared days, $2 byte ceiling
    printf '%s\n' "const SW_VERSION = '1.0.0';" \
        "const HISTORY_WARM_MAX_DAYS = $1;" "const HISTORY_WARM_MAX_BYTES = $2;" > "$REPO/sw.js"
}

setup
seed_history ok   # 15 days of ~60-byte chunks
set_warm 8 100000
run_check; A=$?
if [ "$A" -eq 0 ] && grep -q 'OK:   offline warm depth (8/8 days' "$WORK/out"; then
    pass "27 a ceiling that holds the declared depth passes, naming the days it delivers"
else
    fail "27 sufficient ceiling passes (rc=${A})"; cat "$WORK/out"
fi

# MUTATION: the exact shipped defect, a ceiling that cannot hold the days it declares
set_warm 8 100
run_check; A=$?
if [ "$A" -ne 0 ] && grep -q 'FAIL: offline warm depth' "$WORK/out" && grep -q 'warms only [0-9]* day' "$WORK/out"; then
    pass "28 MUTATION · a ceiling that cannot hold the declared depth fails, naming the depth it really delivers"
else
    fail "28 insufficient ceiling fails (rc=${A})"; cat "$WORK/out"
fi

# the same shortfall must NOT stop a data cycle: the archive grows on its own every day
( cd "$REPO" && git add -A && git commit --quiet -m 'commit the undersized ceiling' )
run_check --code-from-head; A=$?
if [ "$A" -eq 0 ] && grep -q 'WARN: offline warm depth' "$WORK/out"; then
    pass "29 the same shortfall only warns in the data lane, so a growing archive cannot stop a flood publish"
else
    fail "29 data lane warns rather than failing (rc=${A})"; cat "$WORK/out"
fi

# MUTATION: a renamed/removed ceiling must fail, never silently skip the measurement
printf '%s\n' "const SW_VERSION = '1.0.0';" "const HISTORY_WARM_MAX_DAYS = 8;" > "$REPO/sw.js"
run_check; A=$?
if [ "$A" -ne 0 ] && grep -q 'no HISTORY_WARM_MAX_BYTES' "$WORK/out"; then
    pass "30 MUTATION · a warm depth bounded by something this check cannot read fails, it does not skip"
else
    fail "30 unreadable ceiling fails (rc=${A})"; cat "$WORK/out"
fi

# MUTATION: an index that declares no byte size would blind the measurement; that must fail too
set_warm 8 100000
python3 - "$REPO/history/index.json" <<'PY'
import json, sys
idx = json.load(open(sys.argv[1]))
idx["days"][-1].pop("bytes", None)
json.dump(idx, open(sys.argv[1], "w"))
PY
run_check; A=$?
if [ "$A" -ne 0 ] && grep -q 'declares no byte size' "$WORK/out"; then
    pass "31 MUTATION · an index day with no declared size fails rather than letting the check go blind"
else
    fail "31 sizeless index day fails (rc=${A})"; cat "$WORK/out"
fi
rm -rf "$WORK"

# a board with no warm configured at all has nothing to gate, and must not fail on its absence
setup
set_warm_absent() { printf '%s\n' "const SW_VERSION = '1.0.0';" > "$REPO/sw.js"; }
set_warm_absent
run_check; A=$?
if [ "$A" -eq 0 ] && grep -q 'nothing to gate' "$WORK/out"; then
    pass "32 a build with no history warm configured is not failed for its absence"
else
    fail "32 absent warm tolerated (rc=${A})"; cat "$WORK/out"
fi
rm -rf "$WORK"

# --- Tests 33-38: out-of-cycle artifact age (check n) -----------------------
# gen-cameras.py and gen-records.py are hand-run, so nothing in the 15-minute cycle notices when
# their output stops describing anything anyone verified. The release lane fails, the data lane
# only warns: a stale camera inventory must not stop a flood publish.
# write_static FILE DAYS_AGO — an artifact stamped N days ago, in the shape check j also demands,
# so an age failure here is never really a schema failure wearing its clothes. DAYS_AGO "none"
# writes the same body with no generated stamp at all.
write_static() {
    python3 - "$REPO/data/$1" "$2" <<'PY'
import datetime, json, sys
path, days = sys.argv[1], sys.argv[2]
nets = ("txdot", "river", "austin", "atxfloods", "houston", "arlington", "elpbridge", "hays",
        "porthou", "swrecon", "corpus", "lubbock", "weatherbug", "nmdot", "nps", "laredo",
        "eaglepass", "delrio", "galveston")
body = {n: [] for n in nets} if path.endswith("cameras.json") else {"records": {}}
if days != "none":
    when = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=int(days))
    body["generated"] = when.strftime("%Y-%m-%dT%H:%M:%SZ")
json.dump(body, open(path, "w"))
PY
}

setup
write_static cameras.json 3
write_static records.json 10
run_check; A=$?
if [ "$A" -eq 0 ] && grep -q 'out-of-cycle artifact age (cameras.json 3d/45d, records.json 10d/90d' "$WORK/out" \
   && grep -q 'records.json predates the walked count' "$WORK/out"; then
    pass "33 fresh hand-run artifacts pass, their age is reported, and a pre-upgrade records.json notes rather than fails"
else
    fail "33 fresh artifacts pass (rc=${A})"; cat "$WORK/out"
fi
rm -rf "$WORK"

# MUTATION: age the camera inventory past its limit and watch the release lane fail.
setup
write_static cameras.json 46
write_static records.json 10
run_check; A=$?
run_check --code-from-head; B=$?
if [ "$A" -ne 0 ] && grep -q 'data/cameras.json is 46 days old (limit 45); re-run scripts/gen-cameras.py' "$WORK/out"; then
    pass "34 MUTATION · a camera inventory past its limit fails the release lane and names the fix"
else
    fail "34 stale cameras.json fails the release lane (rc=${A})"; cat "$WORK/out"
fi
if [ "$B" -eq 0 ]; then
    pass "35 the same stale inventory only WARNs the data cycle, so a flood publish is not stopped"
else
    fail "35 stale cameras.json must not fail the data lane (rc=${B})"; cat "$WORK/out"
fi
rm -rf "$WORK"

# MUTATION: the records file has its own, longer limit, and it is enforced too.
setup
write_static cameras.json 3
write_static records.json 91
run_check; A=$?
if [ "$A" -ne 0 ] && grep -q 'data/records.json is 91 days old (limit 90); re-run scripts/gen-records.py' "$WORK/out"; then
    pass "36 MUTATION · a records file past its own limit fails the release lane"
else
    fail "36 stale records.json fails (rc=${A})"; cat "$WORK/out"
fi
rm -rf "$WORK"

# MUTATION: an artifact with no readable generated stamp must fail rather than age as 0 days.
setup
write_static cameras.json none
run_check; A=$?
if [ "$A" -ne 0 ] && grep -q 'carries no readable generated stamp' "$WORK/out"; then
    pass "37 MUTATION · a stamp-less artifact fails rather than letting the check go blind"
else
    fail "37 stamp-less artifact fails (rc=${A})"; cat "$WORK/out"
fi
rm -rf "$WORK"

# A board that has never run either generator must not be failed for their absence.
setup
run_check; A=$?
if [ "$A" -eq 0 ] && grep -q 'cameras.json absent, records.json absent' "$WORK/out"; then
    pass "38 absent hand-run artifacts are tolerated, not failed"
else
    fail "38 absent artifacts tolerated (rc=${A})"; cat "$WORK/out"
fi
rm -rf "$WORK"

# The hazard-allowlist check gates on a helper that can be absent or can fail. Both directions
# matter: a check that silently does not run is worse than no check, and one that cannot fail is
# a guard that passes vacuously.
setup
run_check; A=$?
if [ "$A" -eq 0 ] && grep -q 'hazard allowlist agreement (35 events mirrored' "$WORK/out"; then
    pass "39 the hazard allowlist check runs and reports what it compared"
else
    fail "39 hazard allowlist check runs (rc=${A})"; cat "$WORK/out"
fi
rm -rf "$WORK"

# MUTATION: a disagreeing mirror must fail the lane, not be reported as an OK line.
setup
cat > "$REPO/tests/hazard-mirror.js" <<'JS'
'use strict';
process.stderr.write('hazard mirror disagreement:\n  Tornado Warning: js says acute/3, python says standing/18\n');
process.exit(1);
JS
( cd "$REPO" && git add -A && git commit --quiet -m 'drifted mirror' )
run_check; A=$?
if [ "$A" -ne 0 ] && grep -q 'FAIL: hazard allowlist agreement' "$WORK/out"; then
    pass "40 MUTATION · a disagreeing hazard mirror fails the lane"
else
    fail "40 disagreeing mirror fails (rc=${A})"; cat "$WORK/out"
fi
rm -rf "$WORK"

# MUTATION: the helper going missing must fail loudly rather than skip the check.
setup
( cd "$REPO" && git rm --quiet tests/hazard-mirror.js && git commit --quiet -m 'drop the mirror check' )
run_check; A=$?
if [ "$A" -ne 0 ] && grep -q 'FAIL: hazard allowlist agreement' "$WORK/out"; then
    pass "41 MUTATION · a missing hazard-mirror helper fails rather than silently skipping"
else
    fail "41 missing mirror helper fails (rc=${A})"; cat "$WORK/out"
fi
rm -rf "$WORK"

# --- Tests 42-46: the export completeness claim (check q) -------------------
# caltopo-export.json's counters are what js/board.js renders as "this export carries all N features
# in scope". A bound applied before the count is taken makes that sentence true-looking and false, so
# the counters are checked against the features carried, against board.kml's copy of them, and
# against the storm-report cap the generator applies before assembly.
seed_export() {  # $1 carried LSRs, $2 candidates, $3 dropped, $4 truncated, $5 lsr_dropped ("none" omits it)
    python3 - "$REPO" "$@" <<'PY'
import json, os, sys
repo, lsrs, cand, dropped, trunc, cut = sys.argv[1:7]
lsrs, cand, dropped, truncated = int(lsrs), int(cand), int(dropped), trunc == "true"
partial = " (partial: %d of %d features)" % (lsrs, cand) if truncated else ""
props = {"title": "Fixture · CalTopo export" + partial, "counts": {"Storm reports (NWS LSR)": lsrs},
         "candidates": cand, "cap": 2000, "truncated": truncated, "dropped": dropped}
if cut != "none":
    props["lsr_dropped"] = int(cut)
json.dump({"type": "FeatureCollection", "properties": props, "features": [
    {"type": "Feature", "geometry": {"type": "Point", "coordinates": [-95.0, 30.0]},
     "properties": {"class": "Marker", "folder": "Storm reports (NWS LSR)",
                    "folderId": "folder-lsrs", "title": "LSR %d" % i}} for i in range(lsrs)]},
    open(os.path.join(repo, "data", "caltopo-export.json"), "w"))
ext = "".join('<Data name="%s"><value>%s</value></Data>' % kv for kv in
              (("features", lsrs), ("candidates", cand), ("dropped", dropped), ("truncated", truncated)))
open(os.path.join(repo, "data", "board.kml"), "w").write(
    '<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
    "<name>Fixture · live map%s</name><ExtendedData>%s</ExtendedData>%s</Document></kml>"
    % (partial, ext, "".join("<Placemark><name>LSR %d</name></Placemark>" % i for i in range(lsrs))))
PY
    printf '%s\n' '# fixture stand-in for the real generator' 'HAZARD_EVENTS = {}' 'LSR_CAP = 100' \
        'PUBLISHED = "lsr_dropped"' > "$REPO/scripts/gen-caltopo.py"
}

setup
seed_export 100 160 60 true 60
run_check; A=$?
if [ "$A" -eq 0 ] && grep -q 'OK:   export completeness claim (100 carried, 60 of 160 candidates dropped)' "$WORK/out"; then
    pass "42 an export whose counters agree with what it carries passes, reporting the numbers it checked"
else
    fail "42 consistent export passes (rc=${A})"; cat "$WORK/out"
fi

# MUTATION: the shipped defect. The cap cut 60 storm reports and the header still reads as whole.
seed_export 100 100 0 false 60
run_check; A=$?
if [ "$A" -ne 0 ] && grep -q 'cap cut 60 reports and the export still claims nothing was dropped' "$WORK/out"; then
    pass "43 MUTATION · a cap that cut reports while the export claims completeness fails"
else
    fail "43 silent cap fails (rc=${A})"; cat "$WORK/out"
fi

# MUTATION: counters that cannot all be true of one board
seed_export 100 200 60 true 60
run_check; A=$?
if [ "$A" -ne 0 ] && grep -q 'do not describe one board' "$WORK/out"; then
    pass "44 MUTATION · a candidate total that does not equal what is carried plus what was dropped fails"
else
    fail "44 arithmetic mismatch fails (rc=${A})"; cat "$WORK/out"
fi

# MUTATION: the generator caps but counts nothing, so no artifact could ever carry the overflow
seed_export 100 160 60 true 60
printf '%s\n' '# fixture stand-in' 'HAZARD_EVENTS = {}' 'LSR_CAP = 100' > "$REPO/scripts/gen-caltopo.py"
run_check; A=$?
if [ "$A" -ne 0 ] && grep -q 'publishes no lsr_dropped counter' "$WORK/out"; then
    pass "45 MUTATION · a cap the generator never counts fails, before any export can look whole"
else
    fail "45 uncounted cap fails (rc=${A})"; cat "$WORK/out"
fi

# an export written before the counter existed is an upgrade path, not a fault: reported, not failed
seed_export 100 160 60 true none
run_check; A=$?
if [ "$A" -eq 0 ] && grep -q 'export predates the storm-report counter' "$WORK/out"; then
    pass "46 an export from before the counter is tolerated and says so, rather than failing a cycle"
else
    fail "46 pre-counter export tolerated (rc=${A})"; cat "$WORK/out"
fi
rm -rf "$WORK"


# --- 47-49: records coverage. Age is not coverage ---------------------------
# 2026-07-30: records.json was six days old, well inside its 90-day limit, and described 216 of 1018
# gauges. Every gauge on the flooding Nueces was absent while this check reported OK. The old comment
# on the age limit claimed it caught "the gauge network grew and nobody re-ran it". It did not.
setup
write_static records.json 10
python3 - "$REPO" <<'PY'
import json, os, sys
p = os.path.join(sys.argv[1], "data", "records.json")
d = json.load(open(p)); d["walked"] = 30  # the fixture snapshot carries 30 gauges
json.dump(d, open(p, "w"))
PY
run_check; A=$?
if [ "$A" -eq 0 ] && grep -q 'records walked 30/30 gauges' "$WORK/out"; then
    pass "47 an artifact built against the whole current network passes and reports its coverage"
else
    fail "47 full coverage passes (rc=${A})"; cat "$WORK/out"
fi
rm -rf "$WORK"

setup
write_static records.json 10
python3 - "$REPO" <<'PY'
import json, os, sys
p = os.path.join(sys.argv[1], "data", "records.json")
d = json.load(open(p)); d["walked"] = 6  # a fifth of the network, the shipped defect's shape
json.dump(d, open(p, "w"))
PY
run_check; A=$?
if [ "$A" -ne 0 ] && grep -q 'was built against 6 gauges but the board now carries 30' "$WORK/out"; then
    pass "48 MUTATION · an artifact describing a fraction of the network fails, however fresh it is"
else
    fail "48 stale coverage fails (rc=${A})"; cat "$WORK/out"
fi
rm -rf "$WORK"

setup
write_static records.json 10
python3 - "$REPO" <<'PY'
import json, os, sys
p = os.path.join(sys.argv[1], "data", "records.json")
d = json.load(open(p)); d["walked"] = 28  # gauges added since the last out-of-band run
json.dump(d, open(p, "w"))
PY
run_check; A=$?
if [ "$A" -eq 0 ] && grep -q 'records walked 28/30 gauges' "$WORK/out"; then
    pass "49 a network that grew slightly since the last run is slack, not a failure"
else
    fail "49 small growth tolerated (rc=${A})"; cat "$WORK/out"
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
