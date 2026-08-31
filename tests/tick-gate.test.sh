#!/bin/bash
# tests/tick-gate.test.sh: regression tests for scripts/tick-gate.sh, the zero-LLM
# admission control the autonomous revival tick runs first so an idle tick costs one
# tool call instead of a full context re-read.
#   1  clean state, active hours, no cooldown => BACKLOG
#   2  an immediate second run => IDLE backlog-cooldown (the first run claimed the slot)
#   3  unread inbox lines outrank an active cooldown => INBOX <n>
#   4  cursor caught up to the inbox => back to IDLE backlog-cooldown
#   5  quiet hours covering the current hour => IDLE quiet-hours
#   6  the override file wins over quiet hours AND an active cooldown => BACKLOG
#   7  a fresh drain marker => IDLE drain-active
#   8  a drain marker older than RESPONDER_CHAT_DRAIN_STALE => not deferred, BACKLOG
#   9  --peek reports BACKLOG without claiming the slot; two peeks in a row both do
#   10 --json emits one valid JSON object whose .verdict is BACKLOG
#   11 an unknown argument exits 2 with a FAIL: message on stderr
#   12 fresh install (no cursor/state/inbox files at all) does not crash, exits 0
#   13 a quiet window that wraps midnight is evaluated correctly, both containing and
#      excluding the current local hour, computed from that hour rather than hardcoded
#   14 unread inbox lines are not suppressed by quiet hours either => INBOX <n>
# A throwaway temp dir per case, with every path the script reads passed by env var,
# keeps the real repo data/ and /var/log untouched. Run: bash tests/tick-gate.test.sh
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
GATE="$REPO_ROOT/scripts/tick-gate.sh"
FAILS=0

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; FAILS=$((FAILS + 1)); }

# the current local hour, decimal (strip the leading zero so 08/09 are not read as octal)
HOUR=$(date +%H)
HOUR=$((10#$HOUR))
CONTAIN_START=$HOUR            # a wrap window (START > END) guaranteed to contain HOUR:
CONTAIN_END=$((HOUR - 1))      # HOUR >= START holds trivially since START == HOUR
EXCLUDE_START=$((HOUR + 1))    # a wrap window guaranteed to exclude HOUR: neither
EXCLUDE_END=$HOUR              # HOUR >= START nor HOUR < END can hold when START = HOUR+1, END = HOUR

setup() {  # fresh temp workdir + default env overrides; nothing here touches the real repo
    WORK=$(mktemp -d)
    reset_gate_env
}

reset_gate_env() {  # defaults for a case that is not exercising that particular knob
    INBOXF="$WORK/chat-inbox.jsonl"
    CURSORF="$WORK/.chat-cursor"
    MARKERF="$WORK/.chat-drain-active"
    STALESEC=1800
    OFFFILE="$WORK/.tick-gate-off"
    STATEF="$WORK/.tick-gate-state"
    COOLSEC=14400
    QSTART=0
    QEND=0
}

run_gate() {  # ARGS...: invokes tick-gate.sh against the case's env; sets RC and VERDICT
    RESPONDER_CHAT_INBOX="$INBOXF" \
    RESPONDER_CHAT_CURSOR="$CURSORF" \
    RESPONDER_CHAT_DRAIN_MARKER="$MARKERF" \
    RESPONDER_CHAT_DRAIN_STALE="$STALESEC" \
    RESPONDER_TICK_GATE_OFF="$OFFFILE" \
    RESPONDER_TICK_GATE_STATE="$STATEF" \
    RESPONDER_TICK_GATE_LOCK="$WORK/tick-gate.lock" \
    RESPONDER_TICK_GATE_LOG="$WORK/tick-gate.log" \
    RESPONDER_TICK_BACKLOG_COOLDOWN="$COOLSEC" \
    RESPONDER_TICK_QUIET_START="$QSTART" \
    RESPONDER_TICK_QUIET_END="$QEND" \
    bash "$GATE" "$@" > "$WORK/run.out" 2> "$WORK/run.err"
    RC=$?
    VERDICT=$(sed -n '1p' "$WORK/run.out")
}

write_inbox() {  # N: overwrite INBOXF with N jsonl-shaped lines
    local n="$1" i
    : > "$INBOXF"
    for ((i = 0; i < n; i++)); do
        printf '{"ts":"2000-01-01T00:00:00Z","role":"user","text":"msg %d"}\n' "$i" >> "$INBOXF"
    done
}

json_valid_str() { printf '%s' "$1" | python3 -m json.tool > /dev/null 2>&1; }

verdict_field() {  # STR: .verdict out of a JSON gate line
    printf '%s' "$1" | python3 -c 'import json, sys; print(json.load(sys.stdin)["verdict"])' 2>/dev/null
}

# --- Tests 1-4: backlog claim, its cooldown, and the inbox overriding it -------
setup
run_gate
if [ "$VERDICT" = "BACKLOG" ]; then
    pass "1 clean state, active hours, no cooldown: BACKLOG"
else
    fail "1 clean state should claim BACKLOG (got '$VERDICT')"; cat "$WORK/run.out"
fi

run_gate
if [ "$VERDICT" = "IDLE backlog-cooldown" ]; then
    pass "2 an immediate second run finds the slot already claimed: IDLE backlog-cooldown"
else
    fail "2 second immediate run should be IDLE backlog-cooldown (got '$VERDICT')"; cat "$WORK/run.out"
fi

write_inbox 3
run_gate
if [ "$VERDICT" = "INBOX 3" ]; then
    pass "3 unread inbox lines outrank an active cooldown: INBOX 3"
else
    fail "3 unread inbox should report INBOX 3 even under cooldown (got '$VERDICT')"; cat "$WORK/run.out"
fi

printf '%s\n' 3 > "$CURSORF"
run_gate
if [ "$VERDICT" = "IDLE backlog-cooldown" ]; then
    pass "4 cursor caught up to the inbox: back to IDLE backlog-cooldown"
else
    fail "4 caught-up cursor should fall back to backlog-cooldown (got '$VERDICT')"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

# --- Tests 5-6: quiet hours, and the override beating quiet hours + cooldown --
setup
QSTART=$CONTAIN_START
QEND=$CONTAIN_END
run_gate
if [ "$VERDICT" = "IDLE quiet-hours" ]; then
    pass "5 quiet hours covering the current hour: IDLE quiet-hours"
else
    fail "5 quiet hours covering now should block (got '$VERDICT')"; cat "$WORK/run.out"
fi

date +%s > "$STATEF"    # simulate an active cooldown: quiet hours never let test 5 claim one itself
touch "$OFFFILE"
run_gate
if [ "$VERDICT" = "BACKLOG" ]; then
    pass "6 the override file wins over quiet hours and an active cooldown: BACKLOG"
else
    fail "6 override should win over quiet hours + cooldown (got '$VERDICT')"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

# --- Test 7: a fresh drain marker defers ---------------------------------------
setup
date +%s > "$MARKERF"
run_gate
if [ "$VERDICT" = "IDLE drain-active" ]; then
    pass "7 a fresh drain marker: IDLE drain-active"
else
    fail "7 a fresh drain marker should defer (got '$VERDICT')"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

# --- Test 8: a stale drain marker is abandoned, not active ---------------------
setup
STALESEC=5
echo $(( $(date +%s) - 10 )) > "$MARKERF"
run_gate
if [ "$VERDICT" = "BACKLOG" ]; then
    pass "8 a drain marker older than DRAIN_STALE is not deferred: BACKLOG"
else
    fail "8 a stale drain marker should not defer (got '$VERDICT')"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

# --- Test 9: --peek reports without claiming -----------------------------------
setup
run_gate --peek
P1=$VERDICT
STATE_AFTER_1=$([ -e "$STATEF" ] && echo present || echo absent)
run_gate --peek
P2=$VERDICT
STATE_AFTER_2=$([ -e "$STATEF" ] && echo present || echo absent)
if [ "$P1" = "BACKLOG" ] && [ "$P2" = "BACKLOG" ] \
   && [ "$STATE_AFTER_1" = "absent" ] && [ "$STATE_AFTER_2" = "absent" ]; then
    pass "9 --peek reports BACKLOG twice in a row and never creates the state file"
else
    fail "9 --peek should report BACKLOG without claiming (peek1='$P1' peek2='$P2' state1=$STATE_AFTER_1 state2=$STATE_AFTER_2)"
fi
rm -rf "$WORK"

# --- Test 10: --json emits one valid JSON object -------------------------------
setup
run_gate --json
FIELD=$(verdict_field "$VERDICT")
if json_valid_str "$VERDICT" && [ "$FIELD" = "BACKLOG" ]; then
    pass "10 --json emits one valid JSON object with .verdict == BACKLOG"
else
    fail "10 --json should be valid JSON with .verdict BACKLOG (got '$VERDICT')"
fi
rm -rf "$WORK"

# --- Test 11: an unknown argument is refused ------------------------------------
setup
run_gate --bogus
if [ "$RC" -eq 2 ] && grep -q 'FAIL: unknown argument' "$WORK/run.err"; then
    pass "11 an unknown argument exits 2 with a FAIL: message on stderr"
else
    fail "11 unknown argument handling (rc=$RC)"; cat "$WORK/run.err"
fi
rm -rf "$WORK"

# --- Test 12: fresh install, nothing on disk yet --------------------------------
setup
if [ ! -e "$INBOXF" ] && [ ! -e "$CURSORF" ] && [ ! -e "$STATEF" ]; then
    run_gate
    if [ "$RC" -eq 0 ] && [ "$VERDICT" = "BACKLOG" ]; then
        pass "12 fresh install with no cursor/state/inbox files does not crash: exit 0, BACKLOG"
    else
        fail "12 fresh install should exit 0 with BACKLOG (rc=$RC, got '$VERDICT')"; cat "$WORK/run.out" "$WORK/run.err"
    fi
else
    fail "12 test setup should start with no cursor/state/inbox files present"
fi
rm -rf "$WORK"

# --- Test 13: a quiet window that wraps midnight, both directions --------------
setup
QSTART=$CONTAIN_START
QEND=$CONTAIN_END
run_gate
if [ "$VERDICT" = "IDLE quiet-hours" ]; then
    pass "13 a wrapping quiet window (start=$QSTART end=$QEND) containing hour $HOUR blocks: IDLE quiet-hours"
else
    fail "13 wrapping window containing hour $HOUR should block (start=$QSTART end=$QEND, got '$VERDICT')"; cat "$WORK/run.out"
fi

QSTART=$EXCLUDE_START
QEND=$EXCLUDE_END
run_gate
if [ "$VERDICT" = "BACKLOG" ]; then
    pass "13b a wrapping quiet window (start=$QSTART end=$QEND) excluding hour $HOUR does not block: BACKLOG"
else
    fail "13b wrapping window excluding hour $HOUR should not block (start=$QSTART end=$QEND, got '$VERDICT')"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

# --- Test 14: unread inbox lines are not suppressed by quiet hours either ------
setup
QSTART=$CONTAIN_START
QEND=$CONTAIN_END
write_inbox 2
run_gate
if [ "$VERDICT" = "INBOX 2" ]; then
    pass "14 unread inbox lines during quiet hours still report INBOX 2"
else
    fail "14 inbox should not be suppressed by quiet hours (got '$VERDICT')"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

echo "----"
if [ "$FAILS" -eq 0 ]; then
    echo "ALL TICK-GATE TESTS PASSED"
    exit 0
else
    echo "${FAILS} TEST(S) FAILED"
    exit 1
fi
