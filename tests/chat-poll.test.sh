#!/bin/bash
# tests/chat-poll.test.sh — durability regression tests for scripts/chat-poll.sh.
# Proves the ops-chat processor is non-MIA and clobber/timeout-safe:
#   1 durable substantive reply written with NO live session
#   2 a concurrent session reply is NOT clobbered on the success path
#   3 a concurrent session reply is NOT clobbered even when claude times out
#     (the exact old-bug scenario: old code did `mv backup outbox` and reverted it)
#   4 a timeout leaves the outbox valid + cursor unadvanced + retries bounded (no loop)
# A stub `claude` (RESPONDER_CHAT_CLAUDE_CMD) and a throwaway temp dir keep the
# real repo data untouched. Run: bash tests/chat-poll.test.sh
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
POLL="$REPO_ROOT/scripts/chat-poll.sh"
FAILS=0

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; FAILS=$((FAILS + 1)); }

json_valid() { python3 -m json.tool "$1" > /dev/null 2>&1; }

count_role() {  # FILE ROLE -> stdout count
    python3 - "$1" "$2" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
print(sum(1 for m in d.get("messages", []) if m.get("role") == sys.argv[2]))
PY
}

has_text() {  # FILE SUBSTR -> exit 0 if any message text contains SUBSTR
    python3 - "$1" "$2" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
sys.exit(0 if any(sys.argv[2] in (m.get("text") or "") for m in d.get("messages", [])) else 1)
PY
}

append_session() {  # FILE TEXT — mimic a live session's read-modify-write on the outbox
    python3 - "$1" "$2" <<'PY'
import json, os, sys, tempfile, time
t, txt = sys.argv[1], sys.argv[2]
d = json.load(open(t))
d["messages"].append({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "role": "claude", "text": txt})
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(t))
with os.fdopen(fd, "w") as f:
    json.dump(d, f, indent=2)
os.replace(tmp, t)
PY
}

setup() {  # fresh temp workdir: 2-message inbox, empty outbox, cursors at 0, fake creds
    WORK=$(mktemp -d)
    mkdir -p "$WORK/data" "$WORK/bin" "$WORK/home/.claude"
    printf '%s\n' \
        '{"ts":"2026-07-20T18:00:00Z","role":"user","text":"whats the frio at concan doing"}' \
        '{"ts":"2026-07-20T18:01:00Z","role":"user","text":"any low water crossings out near there"}' \
        > "$WORK/data/chat-inbox.jsonl"
    printf '{\n "messages": []\n}\n' > "$WORK/data/chat-outbox.json"
    echo 0 > "$WORK/data/.chat-cursor"
    echo 0 > "$WORK/data/.chat-ack-cursor"
    echo '{"stub":"creds"}' > "$WORK/home/.claude/.credentials.json"
}

make_stub() {  # MODE -> writes an executable stub claude to $WORK/bin/claude, sets $STUB
    STUB="$WORK/bin/claude"
    case "$1" in
        reply)
            cat > "$STUB" <<'SH'
#!/bin/bash
printf '%s\n' "Frio at Concan is receding (~18 ft, dropping). TxDOT still flags two low-water crossings near Concan closed; eyeball the cam before you route. Not 911 for emergencies."
SH
            ;;
        slow)
            cat > "$STUB" <<'SH'
#!/bin/bash
sleep "${STUB_SLEEP:-3}"
printf '%s\n' "CLAUDE-REPLY covering both messages."
SH
            ;;
        hang)
            cat > "$STUB" <<'SH'
#!/bin/bash
echo call >> "$STUB_CALLS"
sleep "${STUB_SLEEP:-60}"
printf '%s\n' "never captured"
SH
            ;;
    esac
    chmod +x "$STUB"
}

run_poll() {  # runs chat-poll against the temp state + stub (no live session)
    RESPONDER_CHAT_INBOX="$WORK/data/chat-inbox.jsonl" \
    RESPONDER_CHAT_OUTBOX="$WORK/data/chat-outbox.json" \
    RESPONDER_CHAT_CURSOR="$WORK/data/.chat-cursor" \
    RESPONDER_CHAT_ACK_CURSOR="$WORK/data/.chat-ack-cursor" \
    RESPONDER_CHAT_ATTEMPTS="$WORK/data/.chat-attempts" \
    RESPONDER_CHAT_LOCK="$WORK/poll.lock" \
    RESPONDER_CHAT_LOG="$WORK/poll.log" \
    RESPONDER_CHAT_CLAUDE_CMD="$STUB" \
    RESPONDER_CHAT_TIMEOUT="${TMO:-30}" \
    RESPONDER_CHAT_KILL_AFTER="${KILL:-2}" \
    RESPONDER_CHAT_MAX_ATTEMPTS="${MAXA:-3}" \
    STUB_SLEEP="${STUB_SLEEP:-3}" \
    STUB_CALLS="${STUB_CALLS:-$WORK/stub-calls}" \
    HOME="$WORK/home" \
    bash "$POLL" > "$WORK/run.out" 2>&1
}

# --- Test 1: durable substantive reply, no live session ---------------------
setup; make_stub reply
run_poll
OUT="$WORK/data/chat-outbox.json"
if json_valid "$OUT" && [ "$(count_role "$OUT" claude)" -eq 1 ] \
   && has_text "$OUT" "Frio at Concan is receding" \
   && [ "$(cat "$WORK/data/.chat-cursor")" = "2" ] \
   && [ "$(cat "$WORK/data/.chat-ack-cursor")" = "2" ]; then
    pass "1 durable substantive reply written with no live session (cursor 0->2, ack 2, JSON valid)"
else
    fail "1 durable substantive reply"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

# --- Test 2: concurrent session reply NOT clobbered (success path) -----------
setup; make_stub slow; export STUB_SLEEP=3
( sleep 1; append_session "$WORK/data/chat-outbox.json" "SESSION-REPLY landed mid-claude-call" ) &
BG=$!
run_poll
wait "$BG"
OUT="$WORK/data/chat-outbox.json"
if json_valid "$OUT" && has_text "$OUT" "SESSION-REPLY landed mid-claude-call" \
   && has_text "$OUT" "CLAUDE-REPLY covering both messages" \
   && [ "$(cat "$WORK/data/.chat-cursor")" = "2" ]; then
    pass "2 concurrent session reply preserved AND claude reply appended (no clobber, success path)"
else
    fail "2 concurrent session reply preserved (success path)"; cat "$OUT"; cat "$WORK/run.out"
fi
unset STUB_SLEEP
rm -rf "$WORK"

# --- Test 3: concurrent session reply NOT clobbered when claude TIMES OUT ----
# This is the exact old bug: old code snapshotted the outbox before the claude
# call and, on failure, `mv backup outbox` — reverting the session's write.
setup; make_stub hang; export STUB_SLEEP=60; TMO=3; KILL=1
( sleep 1; append_session "$WORK/data/chat-outbox.json" "SESSION-REPLY during a hung claude" ) &
BG=$!
run_poll
wait "$BG"
OUT="$WORK/data/chat-outbox.json"
if json_valid "$OUT" && has_text "$OUT" "SESSION-REPLY during a hung claude" \
   && [ "$(count_role "$OUT" claude)" -eq 1 ] \
   && [ "$(cat "$WORK/data/.chat-cursor")" = "0" ]; then
    pass "3 session reply survives a claude timeout (no mv-backup clobber); cursor NOT advanced; JSON valid"
else
    fail "3 session reply survives a claude timeout"; cat "$OUT"; cat "$WORK/run.out"
fi
unset STUB_SLEEP; unset TMO; unset KILL
rm -rf "$WORK"

# --- Test 4: timeout => bounded retries, no loop, no corruption --------------
setup; make_stub hang; export STUB_SLEEP=60 STUB_CALLS="$WORK/stub-calls"; : > "$STUB_CALLS"
TMO=2; KILL=1; MAXA=3
for _ in 1 2 3 4 5; do run_poll; done
OUT="$WORK/data/chat-outbox.json"
CALLS=$(wc -l < "$STUB_CALLS" | tr -d ' ')
if json_valid "$OUT" && [ "$CALLS" -eq 3 ] \
   && [ "$(cat "$WORK/data/.chat-cursor")" = "0" ] \
   && [ "$(count_role "$OUT" claude)" -eq 0 ] \
   && grep -q "attempt budget exhausted" "$WORK/poll.log"; then
    pass "4 claude invoked exactly ${CALLS}/${MAXA} times then deferred (no infinite loop); outbox valid; cursor unadvanced"
else
    fail "4 bounded retries on timeout (calls=${CALLS}, expected 3)"; cat "$WORK/run.out"
fi
unset STUB_SLEEP; unset STUB_CALLS; unset TMO; unset KILL; unset MAXA
rm -rf "$WORK"

echo "----"
if [ "$FAILS" -eq 0 ]; then
    echo "ALL CHAT-POLL DURABILITY TESTS PASSED"
    exit 0
else
    echo "${FAILS} TEST(S) FAILED"
    exit 1
fi
