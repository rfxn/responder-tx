#!/bin/bash
# tick-gate.sh [--peek] [--json] — zero-LLM admission control for the autonomous
# revival tick. The tick runs this FIRST and stops immediately on IDLE, so a tick
# with nothing to do costs one tool call instead of a full context re-read.
#
# Verdict on stdout line 1:
#   INBOX <n>              n unprocessed owner messages; drain and act. Never suppressed.
#   ALERT <what> <detail>  a monitored fault has persisted; diagnose and fix it (claimed).
#   BACKLOG                no inbox work and a discretionary work slot is available (claimed).
#   IDLE <why>             stop now.
#
# BACKLOG and ALERT claim their slot as they report it: deciding "nothing is ready" is
# itself the expensive part of a tick, so the rate limit has to bind before that
# decision, not after it. --peek reports without claiming. See scripts/README.md "Tick gate".
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
OVERRIDE="${RESPONDER_TICK_GATE_OFF:-data/.tick-gate-off}"  # presence bypasses quiet hours and both cooldowns (owner override)
STATE_FILE="${RESPONDER_TICK_GATE_STATE:-data/.tick-gate-state}"  # last claimed-backlog epoch; tracked in-repo is wrong, it is git-excluded
ALERT_STATE="${RESPONDER_TICK_ALERT_STATE:-data/.tick-gate-alert-state}"  # "<condition> <last claimed epoch>" lines, git-ignored the same way
LOCKFILE="${RESPONDER_TICK_GATE_LOCK:-/tmp/responder-tick-gate.lock}"
LOGFILE="${RESPONDER_TICK_GATE_LOG:-/var/log/responder-tick-gate.log}"

# Same env names and defaults as freshness-monitor.sh, the writer of both; tests/tick-gate.test.sh asserts they agree.
MONITOR_STATE="${RESPONDER_MONITOR_STATE:-/tmp/responder-freshness-state}"
BACKUP_STATE="${RESPONDER_BACKUP_STATE:-/tmp/responder-backup-health-state}"

COOLDOWN="${RESPONDER_TICK_BACKLOG_COOLDOWN:-21600}"  # 6h between discretionary work slots; the inbox path ignores this
ALERT_AFTER_MIN="${RESPONDER_TICK_ALERT_AFTER_MIN:-60}"  # a fault must hold this long before a tick is spent on it
ALERT_COOLDOWN="${RESPONDER_TICK_ALERT_COOLDOWN:-10800}"  # 3h per condition, so one the tick cannot fix cannot claim every tick
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

ALERT_NOTE=""

emit() {  # VERDICT DETAIL... — verdict line, then the evidence the tick reasons from
    local verdict="$1"; shift
    local detail="$*${ALERT_NOTE:+; ${ALERT_NOTE}}"
    if [ "$JSON" -eq 1 ]; then
        printf '{"verdict":"%s","detail":"%s","inbox":%s,"cursor":%s,"unread":%s,"hour":%s,"cooldown_left_s":%s}\n' \
            "${verdict%% *}" "$detail" "$INBOX_COUNT" "$CURSOR_VAL" "$UNREAD" "$HOUR" "$COOL_LEFT"
    else
        printf '%s\n' "$verdict"
        printf 'inbox=%s cursor=%s unread=%s local_hour=%s cooldown_left=%ss %s\n' \
            "$INBOX_COUNT" "$CURSOR_VAL" "$UNREAD" "$HOUR" "$COOL_LEFT" "$detail"
    fi
    log "$verdict ($detail ; unread=$UNREAD hour=$HOUR cooldown_left=${COOL_LEFT}s peek=$PEEK)"
}

held_since() {  # FILE WANT FIELD -> epoch the current WANT verdict began (0-based FIELD), empty otherwise
    local -a f=()
    local since
    [ -f "$1" ] || return 0
    read -r -a f < "$1" || [ "${#f[@]}" -gt 0 ] || return 0  # a last line without its newline still counts
    [ "${f[0]:-}" = "$2" ] || return 0
    since=$(printf '%s' "${f[$3]:-}" | command tr -cd '0-9')
    if [ -n "$since" ] && [ "$since" -gt 0 ]; then echo "$since"; fi
    return 0
}

alert_claimed() {  # NAME -> epoch NAME last claimed an ALERT slot, 0 if never
    local name epoch
    if [ -f "$ALERT_STATE" ]; then
        while read -r name epoch; do
            epoch="${epoch//[!0-9]/}"
            if [ "$name" = "$1" ]; then echo "${epoch:-0}"; return 0; fi
        done < "$ALERT_STATE"
    fi
    echo 0
}

claim_alert() {  # NAME — record NOW as NAME's last ALERT slot, keeping every other condition's line
    local name epoch tmp="${ALERT_STATE}.tmp"
    : > "$tmp"
    if [ -f "$ALERT_STATE" ]; then
        while read -r name epoch; do
            if [ -n "$name" ] && [ "$name" != "$1" ]; then printf '%s %s\n' "$name" "$epoch" >> "$tmp"; fi
        done < "$ALERT_STATE"
    fi
    printf '%s %s\n' "$1" "$NOW" >> "$tmp"
    command mv "$tmp" "$ALERT_STATE"
}

ALERT_WHAT=""
ALERT_DETAIL=""
ALERT_HINT=""
consider_alert() {  # NAME FILE WANT FIELD HINT — pick the first held, unclaimed fault; note the rest
    local since held claimed left
    since=$(held_since "$2" "$3" "$4")
    [ -n "$since" ] || return 0
    held=$(( (NOW - since) / 60 ))
    [ "$held" -ge "$ALERT_AFTER_MIN" ] || return 0
    claimed=$(alert_claimed "$1")
    left=$(( ALERT_COOLDOWN - (NOW - claimed) ))
    if [ "$OVERRIDDEN" -eq 0 ] && [ "$left" -gt 0 ]; then
        ALERT_NOTE="${ALERT_NOTE:+${ALERT_NOTE}; }${1} ${3} held ${held}m, its next ALERT slot in $((left / 60))m"
        return 0
    fi
    if [ -z "$ALERT_WHAT" ]; then
        ALERT_WHAT="$1"
        ALERT_DETAIL="${3} for ${held}m since $(command date -u -d "@${since}" '+%Y-%m-%dT%H:%MZ')"
        ALERT_HINT="$5"
    else
        ALERT_NOTE="${ALERT_NOTE:+${ALERT_NOTE}; }${1} ${3} held ${held}m, next in line"
    fi
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

# Freshness first: a stale public board outranks a stale backup. Field numbers are 0-based.
consider_alert freshness "$MONITOR_STATE" CRITICAL 4 "the public mirror is stale; scripts/freshness-monitor.sh --dry-run names the cause"
consider_alert backup "$BACKUP_STATE" FAIL 2 "backups are failing; the Backup alert row of the scripts/README.md freshness runbook says where to look"

if [ "$OVERRIDDEN" -eq 0 ] && [ "$QUIET_START" -ne "$QUIET_END" ]; then
    QUIET=0
    if [ "$QUIET_START" -lt "$QUIET_END" ]; then
        [ "$HOUR" -ge "$QUIET_START" ] && [ "$HOUR" -lt "$QUIET_END" ] && QUIET=1
    else  # window wraps midnight
        { [ "$HOUR" -ge "$QUIET_START" ] || [ "$HOUR" -lt "$QUIET_END" ]; } && QUIET=1
    fi
    if [ "$QUIET" -eq 1 ]; then
        [ -z "$ALERT_WHAT" ] || ALERT_NOTE="${ALERT_NOTE:+${ALERT_NOTE}; }${ALERT_WHAT} ${ALERT_DETAIL}, held for active hours"
        emit "IDLE quiet-hours" "discretionary work paused ${QUIET_START}:00-${QUIET_END}:00 local"
        exit 0
    fi
fi

if [ -n "$ALERT_WHAT" ]; then
    if [ "$PEEK" -eq 1 ]; then
        emit "ALERT ${ALERT_WHAT} ${ALERT_DETAIL}" "${ALERT_WHAT} ${ALERT_DETAIL}: ${ALERT_HINT} (peek: not claimed)"
        exit 0
    fi
    exec 9>"$LOCKFILE"
    if ! flock -n 9; then
        emit "IDLE gate-contended" "another tick is claiming a slot"
        exit 0
    fi
    CLAIMED=$(alert_claimed "$ALERT_WHAT")  # re-read inside the lock: the winner may have claimed while we waited
    if [ "$OVERRIDDEN" -eq 0 ] && [ $((NOW - CLAIMED)) -lt "$ALERT_COOLDOWN" ]; then
        emit "IDLE alert-cooldown" "${ALERT_WHAT} claimed by a concurrent tick"
        exit 0
    fi
    claim_alert "$ALERT_WHAT"
    emit "ALERT ${ALERT_WHAT} ${ALERT_DETAIL}" "${ALERT_WHAT} ${ALERT_DETAIL}: ${ALERT_HINT}; diagnose and fix before anything else$([ "$OVERRIDDEN" -eq 1 ] && echo ' (gate override active)')"
    exit 0
fi

if [ "$OVERRIDDEN" -eq 0 ] && [ "$COOL_LEFT" -gt 0 ]; then
    emit "IDLE backlog-cooldown" "next discretionary slot in $((COOL_LEFT / 60))m"
    exit 0
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
