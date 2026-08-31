#!/bin/bash
# tick-gate.sh [--peek] [--json] — zero-LLM admission control for the autonomous
# revival tick. The tick runs this FIRST and stops immediately on IDLE, so a tick
# with nothing to do costs one tool call instead of a full context re-read.
#
# Verdict on stdout line 1:
#   INBOX <n>   n unprocessed owner messages; drain and act. Never suppressed.
#   BACKLOG     no inbox work and a discretionary work slot is available (claimed).
#   IDLE <why>  stop now.
#
# BACKLOG claims the slot as it reports it: deciding "nothing is ready" is itself
# the expensive part of a tick, so the rate limit has to bind before that decision,
# not after it. --peek reports without claiming. See scripts/README.md "Tick gate".
set -euo pipefail

PEEK=0
JSON=0
for arg in "$@"; do
    case "$arg" in
        --peek) PEEK=1 ;;
        --json) JSON=1 ;;
        *) echo "FAIL: unknown argument: $arg (supported: --peek, --json)" >&2; exit 2 ;;
    esac
done

SCRIPT_DIR=$(cd "$(command dirname "$0")" && pwd) || exit 1
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd) || exit 1
cd "$REPO_ROOT" || exit 1

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"  # cron's minimal PATH omits where git/python3 may live

INBOX="${RESPONDER_CHAT_INBOX:-data/chat-inbox.jsonl}"
CURSOR="${RESPONDER_CHAT_CURSOR:-data/.chat-cursor}"
DRAIN_MARKER="${RESPONDER_CHAT_DRAIN_MARKER:-data/.chat-drain-active}"
DRAIN_STALE="${RESPONDER_CHAT_DRAIN_STALE:-1800}"  # matches chat-watchdog.sh: an older marker is abandoned, not active
OVERRIDE="${RESPONDER_TICK_GATE_OFF:-data/.tick-gate-off}"  # presence bypasses quiet hours and cooldown (owner override)
STATE_FILE="${RESPONDER_TICK_GATE_STATE:-data/.tick-gate-state}"  # last claimed-backlog epoch; tracked in-repo is wrong, it is git-excluded
LOCKFILE="${RESPONDER_TICK_GATE_LOCK:-/tmp/responder-tick-gate.lock}"
LOGFILE="${RESPONDER_TICK_GATE_LOG:-/var/log/responder-tick-gate.log}"

COOLDOWN="${RESPONDER_TICK_BACKLOG_COOLDOWN:-21600}"  # 6h between discretionary work slots; the inbox path ignores this
QUIET_START="${RESPONDER_TICK_QUIET_START:-1}"        # local hour the quiet window opens (inclusive)
QUIET_END="${RESPONDER_TICK_QUIET_END:-9}"            # local hour it closes (exclusive); equal values disable quiet hours

if ! ( : >> "$LOGFILE" ) 2>/dev/null; then  # probe: /var/log may be unwritable for non-root cron
    LOGFILE=/tmp/responder-tick-gate.log
fi
log() { printf '%s %s\n' "$(command date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOGFILE"; }

count_lines() {  # FILE -> line count, 0 when absent
    [ -f "$1" ] || { echo 0; return 0; }
    command wc -l < "$1" | command tr -d ' '
}

read_int() {  # FILE DEFAULT -> first integer in FILE, or DEFAULT
    local v
    [ -f "$1" ] || { echo "$2"; return 0; }
    v=$(command head -c 32 "$1" | command tr -dc '0-9')
    [ -n "$v" ] && echo "$v" || echo "$2"
}

NOW=$(command date +%s)
HOUR=$(command date +%H)
HOUR=$((10#$HOUR))  # strip the leading zero so 08 is not read as invalid octal

emit() {  # VERDICT DETAIL... — verdict line, then the evidence the tick reasons from
    local verdict="$1"; shift
    if [ "$JSON" -eq 1 ]; then
        printf '{"verdict":"%s","detail":"%s","inbox":%s,"cursor":%s,"unread":%s,"hour":%s,"cooldown_left_s":%s}\n' \
            "${verdict%% *}" "$*" "$INBOX_COUNT" "$CURSOR_VAL" "$UNREAD" "$HOUR" "$COOL_LEFT"
    else
        printf '%s\n' "$verdict"
        printf 'inbox=%s cursor=%s unread=%s local_hour=%s cooldown_left=%ss %s\n' \
            "$INBOX_COUNT" "$CURSOR_VAL" "$UNREAD" "$HOUR" "$COOL_LEFT" "$*"
    fi
    log "$verdict ($* ; unread=$UNREAD hour=$HOUR cooldown_left=${COOL_LEFT}s peek=$PEEK)"
}

INBOX_COUNT=$(count_lines "$INBOX")
CURSOR_VAL=$(read_int "$CURSOR" 0)
UNREAD=$((INBOX_COUNT > CURSOR_VAL ? INBOX_COUNT - CURSOR_VAL : 0))
LAST_CLAIM=$(read_int "$STATE_FILE" 0)
ELAPSED=$((NOW - LAST_CLAIM))
COOL_LEFT=$((COOLDOWN > ELAPSED ? COOLDOWN - ELAPSED : 0))

# The inbox outranks every throttle: an owner message is the one thing this gate must never delay.
if [ "$UNREAD" -gt 0 ]; then
    emit "INBOX $UNREAD" "unprocessed owner messages; drain and act"
    exit 0
fi

# A live drain elsewhere owns the turn; a second actor would duplicate its work.
if [ -f "$DRAIN_MARKER" ]; then
    MARK=$(read_int "$DRAIN_MARKER" 0)
    if [ $((NOW - MARK)) -lt "$DRAIN_STALE" ]; then
        emit "IDLE drain-active" "another drain started $((NOW - MARK))s ago"
        exit 0
    fi
fi

OVERRIDDEN=0
[ -f "$OVERRIDE" ] && OVERRIDDEN=1

if [ "$OVERRIDDEN" -eq 0 ]; then
    if [ "$QUIET_START" -ne "$QUIET_END" ]; then
        QUIET=0
        if [ "$QUIET_START" -lt "$QUIET_END" ]; then
            [ "$HOUR" -ge "$QUIET_START" ] && [ "$HOUR" -lt "$QUIET_END" ] && QUIET=1
        else  # window wraps midnight
            { [ "$HOUR" -ge "$QUIET_START" ] || [ "$HOUR" -lt "$QUIET_END" ]; } && QUIET=1
        fi
        if [ "$QUIET" -eq 1 ]; then
            emit "IDLE quiet-hours" "discretionary work paused ${QUIET_START}:00-${QUIET_END}:00 local"
            exit 0
        fi
    fi
    if [ "$COOL_LEFT" -gt 0 ]; then
        emit "IDLE backlog-cooldown" "next discretionary slot in $((COOL_LEFT / 60))m"
        exit 0
    fi
fi

if [ "$PEEK" -eq 1 ]; then
    emit "BACKLOG" "slot available (peek: not claimed)"
    exit 0
fi

# Claim under a lock so two ticks firing together cannot both take the same slot.
exec 9>"$LOCKFILE"
if ! flock -n 9; then
    emit "IDLE gate-contended" "another tick is claiming the slot"
    exit 0
fi
LAST_CLAIM=$(read_int "$STATE_FILE" 0)  # re-read inside the lock: the winner may have claimed while we waited
if [ "$OVERRIDDEN" -eq 0 ] && [ $((NOW - LAST_CLAIM)) -lt "$COOLDOWN" ]; then
    COOL_LEFT=$((COOLDOWN - (NOW - LAST_CLAIM)))
    emit "IDLE backlog-cooldown" "claimed by a concurrent tick"
    exit 0
fi
echo "$NOW" > "${STATE_FILE}.tmp" && command mv "${STATE_FILE}.tmp" "$STATE_FILE"
emit "BACKLOG" "discretionary slot claimed$([ "$OVERRIDDEN" -eq 1 ] && echo ' (gate override active)')"
