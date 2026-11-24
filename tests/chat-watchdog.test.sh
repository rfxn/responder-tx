#!/bin/bash
# tests/chat-watchdog.test.sh — tree-hygiene regression tests for scripts/chat-watchdog.sh.
# On 2026-07-25 a watchdog recovery was killed on timeout (rc=124) and left uncommitted edits
# across data/event.json and four js/ files. The js/ edits could not ship (the cycle runs
# committed code) but data/event.json is read from the working tree by the cycle's generators,
# so it widened the AO before any release carried it. These prove:
#   1 a killed run's leftovers are quarantined as a patch and the tree is restored to HEAD
#   2 the run is refused outright when the tree is already dirty (no build on someone else's work)
#   3 the data cycle's own regenerated files are never reverted (no racing a live publish)
#   4 a run that commits its work leaves nothing to quarantine
#   5 the kill switch and the drain-marker deference still short-circuit before any of it
#   10 each recovery run lands in the steward ledger as WATCHDOG, with its cost from the JSON result
#   9 the headless run starts no MCP connector (Slack, Gmail and the rest stay out of reach)
#   8 a staged NEW file is unstaged and banked too, under the cycle lock (and left alone without it)
#   7 the headless run gets the rfxn profile (CLAUDE_CONFIG_DIR) and needs that profile's credentials
# A stub `claude` (RESPONDER_CHAT_CLAUDE_CMD) and a throwaway git repo keep the real repo
# untouched. Run: bash tests/chat-watchdog.test.sh
set -uo pipefail

cleanup() {
    trap - EXIT INT TERM
    local kids
    kids=$(jobs -p 2>/dev/null)
    if [ -n "$kids" ]; then kill $kids 2>/dev/null; fi  # best-effort reap; already-dead jobs are fine
    if [ -n "${WORK:-}" ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT INT TERM

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
WATCHDOG_SRC="$REPO_ROOT/scripts/chat-watchdog.sh"
# Every inherited RESPONDER_* is dropped (tests/run.sh exports shared scratch paths); each run pins its own.
SCRUB=()
while IFS= read -r v; do SCRUB+=(-u "$v"); done < <(compgen -e | grep '^RESPONDER_' || :)
FAILS=0

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; FAILS=$((FAILS + 1)); }

# a scratch git repo shaped like the board: committed source, committed cycle data, an ops mailbox
setup() {
    WORK=$(mktemp -d)
    REPO="$WORK/repo"
    mkdir -p "$REPO/scripts" "$REPO/js" "$REPO/data" "$WORK/bin" "$WORK/home/.claude"
    cp "$WATCHDOG_SRC" "$REPO/scripts/chat-watchdog.sh"
    mkdir -p "$REPO/scripts/steward" && cp "$REPO_ROOT/scripts/steward/steward.py" "$REPO/scripts/steward/"

    printf 'const APP_VERSION = "v9.9.9";\n' > "$REPO/js/core.js"
    printf '{"name":"Scratch Event","gaugeBbox":{"xmin":-100,"ymin":29,"xmax":-98,"ymax":31}}\n' > "$REPO/data/event.json"
    printf '{"generated":"2026-07-25T00:00:00Z","gauges":[]}\n' > "$REPO/data/gauges-snapshot.json"

    git -C "$REPO" init -q
    git -C "$REPO" config user.email t@example.test
    git -C "$REPO" config user.name Test
    git -C "$REPO" add -A
    git -C "$REPO" commit -qm 'scratch base'

    # the mailbox is gitignored in the real repo, so it lives outside git here too
    printf '%s\n' '{"ts":"2000-01-01T00:00:00Z","role":"user","text":"ship the fix please"}' > "$WORK/chat-inbox.jsonl"
    printf '{\n "messages": []\n}\n' > "$WORK/chat-outbox.json"
    echo 0 > "$WORK/.chat-cursor"
    echo '{"stub":"creds"}' > "$WORK/home/.claude/.credentials.json"
    STUB="$WORK/bin/claude"
}

# make_stub MODE — an executable stand-in for the headless build session
make_stub() {
    case "$1" in
        killed)  # edits source + working-tree config, commits nothing, dies like `timeout` killed it
            cat > "$STUB" <<'SH'
#!/bin/bash
echo call >> "$STUB_CALLS"
printf 'const CAM_LEGACY_PARAMS = undefinedSymbol();\n' >> js/core.js
python3 - <<'PY'
import json
d = json.load(open('data/event.json'))
d['gaugeBbox'] = {"xmin": -106.65, "ymin": 25.83, "xmax": -93.4, "ymax": 36.5}
json.dump(d, open('data/event.json', 'w'))
PY
exit 124
SH
            ;;
        stage-new)  # stages a brand-new file and edits source, commits nothing
            cat > "$STUB" <<'SH'
#!/bin/bash
echo call >> "$STUB_CALLS"
printf 'echo planted\n' > js/new-tool.js
git add js/new-tool.js
printf '// half\n' >> js/core.js
exit 124
SH
            ;;
        cycle-lane)  # only touches a file the data cycle regenerates and stages itself
            cat > "$STUB" <<'SH'
#!/bin/bash
echo call >> "$STUB_CALLS"
printf '{"generated":"2026-07-25T18:00:00Z","gauges":[{"id":"X"}]}\n' > data/gauges-snapshot.json
exit 124
SH
            ;;
        clean)  # does the job properly: edits, commits, advances the cursor
            cat > "$STUB" <<'SH'
#!/bin/bash
echo call >> "$STUB_CALLS"
printf '%s\n' "${CLAUDE_CONFIG_DIR:-unset}" > "${STUB_CALLS}.cfg"
{ printf '%s\n' "${ENABLE_CLAUDEAI_MCP_SERVERS:-unset}"; printf '%s\n' "$@"; } > "${STUB_CALLS}.argv"
printf 'const APP_VERSION = "v9.9.10";\n' > js/core.js
git -c user.email=t@example.test -c user.name=Test commit -qam 'v9.9.10: recovery shipped'
echo 1 > "$RESPONDER_CHAT_CURSOR"
printf '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.42,"num_turns":3,"usage":{"output_tokens":7}}\n'
SH
            ;;
    esac
    chmod +x "$STUB"
}

run_watchdog() {
    env "${SCRUB[@]}" \
    RESPONDER_CHAT_INBOX="$WORK/chat-inbox.jsonl" \
    RESPONDER_CHAT_OUTBOX="$WORK/chat-outbox.json" \
    RESPONDER_CHAT_CURSOR="$WORK/.chat-cursor" \
    RESPONDER_CHAT_DRAIN_MARKER="${MARKER:-$WORK/.chat-drain-active}" \
    RESPONDER_CHAT_WATCHDOG_OFF="${KILLSW:-$WORK/.chat-watchdog-off}" \
    RESPONDER_CHAT_WATCHDOG_LOCK="$WORK/watchdog.lock" \
    RESPONDER_CHAT_WATCHDOG_STATE="$WORK/watchdog.state" \
    RESPONDER_CHAT_WATCHDOG_LOG="$WORK/watchdog.log" \
    RESPONDER_CHAT_WATCHDOG_QUARANTINE="$WORK/quarantine" \
    RESPONDER_CHAT_CLAUDE_CMD="$STUB" \
    RESPONDER_CHAT_WATCHDOG_TIMEOUT=20 \
    RESPONDER_CHAT_WATCHDOG_KILL_AFTER=2 \
    RESPONDER_CYCLE_LOCK="$WORK/cycle.lock" \
    RESPONDER_STEWARD_LEDGER="$WORK/ledger.jsonl" \
    RESPONDER_CHAT_WATCHDOG_CYCLE_LOCK_WAIT="${LOCK_WAIT:-5}" \
    STUB_CALLS="$WORK/stub-calls" \
    RESPONDER_CLAUDE_CONFIG_DIR="${PROFILE:-$WORK/home/.claude}" \
    HOME="$WORK/home" \
    bash "$REPO/scripts/chat-watchdog.sh" > "$WORK/run.out" 2>&1
}

# tracked paths still differing from HEAD — what the data cycle could sweep into a commit
dirty_paths() { git -C "$REPO" diff --name-only HEAD; }
stub_calls() { [ -f "$WORK/stub-calls" ] && wc -l < "$WORK/stub-calls" | tr -d ' ' || echo 0; }

# --- Test 1: a killed run leaves NO publishable dirt --------------------------
setup; make_stub killed
run_watchdog
QP=$(ls "$WORK/quarantine"/*.patch 2>/dev/null | head -1)  # absent dir is the failure this asserts against
if [ -z "$(dirty_paths)" ] \
   && [ "$(stub_calls)" -eq 1 ] \
   && [ -n "$QP" ] \
   && grep -q 'CAM_LEGACY_PARAMS' "$QP" \
   && grep -q 'data/event.json' "$QP" \
   && ! grep -q 'CAM_LEGACY_PARAMS' "$REPO/js/core.js" \
   && grep -q '"xmin":-100' "$REPO/data/event.json" \
   && [ "$(cat "$WORK/.chat-cursor")" = "0" ]; then
    pass "1 a killed recovery leaves a clean tree; its edits are banked in $(basename "$QP") and js/core.js + data/event.json are back at HEAD"
else
    fail "1 killed recovery left a publishable tree (dirty: $(dirty_paths | tr '\n' ' '))"
    cat "$WORK/watchdog.log"
fi
rm -rf "$WORK"

# --- Test 2: an already-dirty tree refuses the build entirely -----------------
setup; make_stub killed
printf 'half-written by somebody else\n' >> "$REPO/js/core.js"
run_watchdog
if [ "$(stub_calls)" -eq 0 ] \
   && grep -q 'REFUSING' "$WORK/watchdog.log" \
   && grep -q 'dirty: js/core.js' "$WORK/watchdog.log" \
   && grep -q 'half-written by somebody else' "$REPO/js/core.js" \
   && grep -q 'uncommitted changes' "$WORK/chat-outbox.json" \
   && [ ! -d "$WORK/quarantine" ]; then
    pass "2 a dirty tree refuses the build (claude never invoked), keeps the other actor's work, and says so in the outbox"
else
    fail "2 dirty-tree refusal (stub calls=$(stub_calls))"
    cat "$WORK/watchdog.log"
fi
rm -rf "$WORK"

# --- Test 3: the data cycle's own lane is never reverted ----------------------
setup; make_stub cycle-lane
run_watchdog
if [ "$(stub_calls)" -eq 1 ] \
   && grep -q '"id":"X"' "$REPO/data/gauges-snapshot.json" \
   && [ ! -d "$WORK/quarantine" ]; then
    pass "3 a regenerated data/gauges-snapshot.json survives the run (the watchdog never races a live publish)"
else
    fail "3 cycle-lane file was reverted or quarantined"
    cat "$WORK/watchdog.log"
fi
rm -rf "$WORK"

# --- Test 4: a run that commits its work is left alone ------------------------
setup; make_stub clean
run_watchdog
if [ -z "$(dirty_paths)" ] \
   && [ ! -d "$WORK/quarantine" ] \
   && grep -q 'v9.9.10' "$REPO/js/core.js" \
   && grep -q 'RECOVERED' "$WORK/watchdog.log"; then
    pass "4 a recovery that commits its work keeps it; nothing is quarantined and the cursor advance is recorded"
else
    fail "4 a clean recovery was disturbed"
    cat "$WORK/watchdog.log"
fi
rm -rf "$WORK"

# --- Test 5: the kill switch and drain marker still gate everything -----------
setup; make_stub killed
KILLSW="$WORK/off"; touch "$KILLSW"
run_watchdog
KS_OK=0
if [ "$(stub_calls)" -eq 0 ] && grep -q 'DISABLED: kill switch' "$WORK/watchdog.log"; then KS_OK=1; fi
unset KILLSW
rm -f "$WORK/watchdog.log"
MARKER="$WORK/draining"; date +%s > "$MARKER"
run_watchdog
DM_OK=0
if [ "$(stub_calls)" -eq 0 ] && grep -q 'defer: a live session marked itself draining' "$WORK/watchdog.log"; then DM_OK=1; fi
unset MARKER
if [ "$KS_OK" -eq 1 ] && [ "$DM_OK" -eq 1 ]; then
    pass "5 the kill switch and a fresh drain marker both short-circuit before the tree check or any build"
else
    fail "5 kill switch (${KS_OK}) / drain marker (${DM_OK}) gating"
    cat "$WORK/watchdog.log"
fi
rm -rf "$WORK"

# --- Test 6: every file the cycle stages is inside the lane --------------------
# Two lists describe one set (E5): a file run-cycle.sh stages but the lane omits gets reverted by
# a recovery run mid-publish. Both halves are read from source.
LANE=$(grep -oP "^CYCLE_LANE='\\K[^']+" "$WATCHDOG_SRC")
STAGED=$(sed -n '/^DATA_FILES=(/,/^)/p' "$REPO_ROOT/scripts/run-cycle.sh" | grep -E '^[[:space:]]+[a-z]' | tr -d ' ')
MISSING=""
for f in $STAGED; do
    printf '%s\n' "$f" | grep -Eq "$LANE" || MISSING="$MISSING $f"
done
if [ -n "$LANE" ] && [ "$(printf '%s\n' "$STAGED" | grep -c .)" -ge 10 ] && [ -z "$MISSING" ]; then
    pass "6 every run-cycle.sh DATA_FILES path is inside the watchdog's no-touch lane"
else
    fail "6 run-cycle.sh stages paths the watchdog would revert:${MISSING:- (lane or DATA_FILES unreadable)}"
fi

# --- Test 7: the rfxn account profile reaches claude, and its credentials gate the run ----------
setup; make_stub clean
PROFILE="$WORK/profile"; mkdir -p "$PROFILE"; echo '{"stub":"creds"}' > "$PROFILE/.credentials.json"
run_watchdog
P_OK=0
[ "$(cat "$WORK/stub-calls.cfg" 2>/dev/null)" = "$PROFILE" ] && P_OK=1
rm -f "$PROFILE/.credentials.json" "$WORK/stub-calls" "$WORK/watchdog.state"
echo 0 > "$WORK/.chat-cursor"
run_watchdog
C_OK=0
if [ "$(stub_calls)" -eq 0 ] && grep -q "no readable credentials at $PROFILE/.credentials.json" "$WORK/watchdog.log"; then C_OK=1; fi
unset PROFILE
if [ "$P_OK" -eq 1 ] && [ "$C_OK" -eq 1 ]; then
    pass "7 claude runs with CLAUDE_CONFIG_DIR set to the profile, and a profile without credentials is refused"
else
    fail "7 profile passed (${P_OK}) / credentials follow the profile (${C_OK})"
    cat "$WORK/watchdog.log"
fi
rm -rf "$WORK"

# --- Test 8: a staged new file is quarantined too, under the cycle lock --------------------------
setup; make_stub stage-new
run_watchdog
QD=$(ls -d "$WORK/quarantine"/*.files 2>/dev/null | head -1)
N_OK=0
if [ -z "$(git -C "$REPO" status --porcelain --untracked-files=all -- js)" ] && [ -n "$QD" ] \
   && grep -q 'echo planted' "$QD/js/new-tool.js"; then N_OK=1; fi
rm -rf "$WORK"
setup; make_stub stage-new
( flock -n 5 && LOCK_WAIT=1 run_watchdog ) 5>"$WORK/cycle.lock"
L_OK=0
if git -C "$REPO" diff --cached --name-only | grep -qx 'js/new-tool.js' && grep -q 'cycle lock busy for 1s; leftovers stay in the tree' "$WORK/watchdog.log"; then L_OK=1; fi
if [ "$N_OK" -eq 1 ] && [ "$L_OK" -eq 1 ]; then
    pass "8 a staged new file is unstaged and banked with the rest, only while holding the cycle lock"
else
    fail "8 staged-new quarantine (${N_OK}) / cycle lock (${L_OK})"
    cat "$WORK/watchdog.log"
fi
rm -rf "$WORK"

# --- Test 9: no outward channels --------------------------------------------------------------------
setup; make_stub clean
run_watchdog
if [ "$(head -n 1 "$WORK/stub-calls.argv" 2>/dev/null)" = "false" ] && grep -qx -- '--strict-mcp-config' "$WORK/stub-calls.argv"; then
    pass "9 the recovery run gets --strict-mcp-config and ENABLE_CLAUDEAI_MCP_SERVERS=false"
else
    fail "9 MCP lockdown: $(tr '\n' ' ' < "$WORK/stub-calls.argv" 2>/dev/null)"
fi
rm -rf "$WORK"

# --- Test 10: the watchdog's spend is on the same books ---------------------------------------------
setup; make_stub clean
run_watchdog
if [ -f "$WORK/ledger.jsonl" ] && python3 -c 'import json,sys; e=json.loads(open(sys.argv[1]).readlines()[-1]); sys.exit(0 if e["task"]=="WATCHDOG" and e["cost_usd"]==0.42 and e["cost_known"] else 1)' "$WORK/ledger.jsonl"; then
    pass "10 a recovery run is recorded in the steward ledger as WATCHDOG with its real cost"
else
    fail "10 watchdog ledger: $(cat "$WORK/ledger.jsonl" 2>/dev/null)"
    cat "$WORK/watchdog.log"
fi
rm -rf "$WORK"

echo "----"
if [ "$FAILS" -eq 0 ]; then
    echo "ALL CHAT-WATCHDOG TREE-HYGIENE TESTS PASSED"
    exit 0
else
    echo "${FAILS} TEST(S) FAILED"
    exit 1
fi
