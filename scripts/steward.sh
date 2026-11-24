#!/bin/bash
# steward.sh [--dry-run] [--force-collateral]: zero-LLM pre-gate, then at most one headless claude run. See scripts/README.md "Steward".
set -euo pipefail

DRY_RUN=0
FORCE_COLLATERAL=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --force-collateral) FORCE_COLLATERAL=1 ;;
        *) echo "FAIL: unknown argument: $arg (supported: --dry-run, --force-collateral)" >&2; exit 2 ;;
    esac
done

SCRIPT_DIR=$(cd "$(command dirname "$0")" && pwd) || exit 1
ROOT="${RESPONDER_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
cd "$ROOT" || exit 1
HELPER="$SCRIPT_DIR/steward/steward.py"
PROMPTS="$SCRIPT_DIR/steward"

export HOME="${HOME:-/root}"
export PATH="$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
export IS_SANDBOX="${IS_SANDBOX:-1}"  # claude refuses bypassPermissions as root without it
CLAUDE_PROFILE="${RESPONDER_CLAUDE_CONFIG_DIR:-/root/.claude-rfxn}"
CLAUDE_CMD="${RESPONDER_STEWARD_CLAUDE_CMD:-claude}"  # test seam
TICK_GATE="${RESPONDER_STEWARD_TICK_GATE:-$ROOT/scripts/tick-gate.sh}"
INBOX_BAN="This is a headless steward run. It must not read or act on data/chat-inbox.jsonl and must not touch data/.chat-cursor or data/chat-outbox.json except to append its one report: the chat watchdog owns the inbox. The CLAUDE.md inbox-drain steps do not apply to this run."

KILL_SWITCH="${RESPONDER_STEWARD_OFF:-data/.steward-off}"
BACKLOG_FLAG="${RESPONDER_STEWARD_BACKLOG_ON:-data/.steward-backlog-on}"
DRAIN_MARKER="${RESPONDER_CHAT_DRAIN_MARKER:-data/.chat-drain-active}"
DRAIN_STALE="${RESPONDER_CHAT_DRAIN_STALE:-1800}"
WATCHDOG_LOCK="${RESPONDER_CHAT_WATCHDOG_LOCK:-/tmp/responder-chat-watchdog.lock}"
CYCLE_LOCK="${RESPONDER_CYCLE_LOCK:-/tmp/responder-cycle.lock}"
LOCKFILE="${RESPONDER_STEWARD_LOCK:-/tmp/responder-steward.lock}"
CADENCE_STATE="${RESPONDER_CADENCE_STATE:-data/.cadence-state.json}"
OUTLOOK="data/outlook.json"
OUTBOX="${RESPONDER_CHAT_OUTBOX:-data/chat-outbox.json}"
CYCLE_STATUS="${RESPONDER_CYCLE_STATUS:-/var/log/responder-cycle-status.json}"
BYPASS_LOG="${RESPONDER_DEPLOY_BYPASS_LOG:-/var/log/responder-deploy-bypass.log}"
QUARANTINE_DIR="${RESPONDER_STEWARD_QUARANTINE:-/tmp/responder-steward-quarantine}"
STATE_DIR="${RESPONDER_STEWARD_STATE_DIR:-/var/lib/responder-steward}"
LOGFILE="${RESPONDER_STEWARD_LOG:-/var/log/responder-steward.log}"
LEDGER="${RESPONDER_STEWARD_LEDGER:-/var/log/responder-steward-ledger.jsonl}"

DAILY_CAP="${RESPONDER_STEWARD_DAILY_CAP_USD:-8}"
COLLATERAL_MODEL="${RESPONDER_STEWARD_COLLATERAL_MODEL:-sonnet}"
COLLATERAL_BUDGET="${RESPONDER_STEWARD_COLLATERAL_BUDGET:-1.00}"
COLLATERAL_TIMEOUT="${RESPONDER_STEWARD_COLLATERAL_TIMEOUT:-420}"
ALERT_MODEL="${RESPONDER_STEWARD_ALERT_MODEL:-opus}"
ALERT_BUDGET="${RESPONDER_STEWARD_ALERT_BUDGET:-2.50}"
ALERT_TIMEOUT="${RESPONDER_STEWARD_ALERT_TIMEOUT:-1500}"
ALERT_COOLDOWN="${RESPONDER_STEWARD_ALERT_COOLDOWN:-7200}"
ALERT_MAX_RUNS="${RESPONDER_STEWARD_ALERT_MAX_RUNS:-3}"  # per fault episode, so a fault the run cannot fix does not eat the daily cap
BACKLOG_MODEL="${RESPONDER_STEWARD_BACKLOG_MODEL:-opus}"
BACKLOG_BUDGET="${RESPONDER_STEWARD_BACKLOG_BUDGET:-5.00}"
BACKLOG_TIMEOUT="${RESPONDER_STEWARD_BACKLOG_TIMEOUT:-2400}"
KILL_AFTER="${RESPONDER_STEWARD_KILL_AFTER:-30}"
CYCLE_LOCK_WAIT="${RESPONDER_STEWARD_CYCLE_LOCK_WAIT:-900}"
TTL_QUIET="${RESPONDER_STEWARD_TTL_QUIET:-54000}"
TTL_ADVERSE="${RESPONDER_STEWARD_TTL_ADVERSE:-14400}"
QUIET_START="${RESPONDER_STEWARD_QUIET_START:-1}"  # local hours quiet-mode COLLATERAL skips; equal values disable
QUIET_END="${RESPONDER_STEWARD_QUIET_END:-9}"

if ! ( : >> "$LOGFILE" ) 2>/dev/null; then LOGFILE=/tmp/responder-steward.log; fi
log() { printf '%s %s\n' "$(command date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOGFILE"; }
idle() { log "IDLE $*"; exit 0; }
trap 'log "ERROR: steward failed (exit $?) near line ${BASH_LINENO[0]:-?}"' ERR

helper() { python3 -I "$HELPER" "$@" 2>>"$LOGFILE"; }  # cron discards stderr, so tracebacks land in the log
now_epoch() { echo "${RESPONDER_STEWARD_NOW:-$(command date -u '+%s')}"; }
read_int() { local v; v=$(command head -c 32 "$1" 2>/dev/null | command tr -dc '0-9'); echo "${v:-0}"; }
fits() { awk -v s="$SPENT" -v b="$1" -v c="$DAILY_CAP" 'BEGIN { exit !(s + b <= c) }'; }

# Must equal chat-watchdog.sh CYCLE_LANE; tests/steward.test.sh asserts they agree.
CYCLE_LANE='^(data/(gauges-snapshot|gauges-capture|roads-snapshot|roads-capture|crest-summary|gauge-meta|history|requests|shelters-live|crossing-status|wildfire|transtar-flood|caltopo-export|changes|changes-state|cadence)\.json|data/(board|board-live)\.kml|data/board-georss\.xml|history/|feed\.xml|crests\.ics)'

tree_dirt() {
    local changed
    changed=$(git diff --name-only HEAD) || return 1
    [ -n "$changed" ] || return 0
    printf '%s\n' "$changed" | grep -Ev "$CYCLE_LANE" || :
}

quarantine_dirt() {  # PATHS...: under the cycle lock, bank the diff, unstage and move added files, restore the rest
    local patch p rc=0
    local -a added=() others=()
    command mkdir -p "$QUARANTINE_DIR" || { log "ERROR: cannot create ${QUARANTINE_DIR}; leaving the tree dirty"; return 1; }
    exec 7>"$CYCLE_LOCK"
    if ! flock -w "$CYCLE_LOCK_WAIT" 7; then
        log "ERROR: cycle lock busy for ${CYCLE_LOCK_WAIT}s; leftovers stay in the tree: $*"
        exec 7>&-
        return 1
    fi
    patch="${QUARANTINE_DIR}/steward-$(command date -u '+%Y%m%dT%H%M%SZ')-$$.patch"
    if ! git diff HEAD -- "$@" > "$patch"; then
        log "ERROR: could not write ${patch}; NOT restoring"
        exec 7>&-
        return 1
    fi
    while IFS= read -r p; do [ -n "$p" ] && added+=("$p"); done < <(git diff --name-only --diff-filter=A HEAD -- "$@")
    for p in "$@"; do
        printf '%s\n' "${added[@]}" | grep -qxF -- "$p" || others+=("$p")
    done
    if [ "${#added[@]}" -gt 0 ]; then
        git rm -q --cached -- "${added[@]}" || rc=1
        for p in "${added[@]}"; do
            command mkdir -p "${patch%.patch}.files/$(command dirname "$p")" && [ ! -e "$p" ] \
                || command mv -f -- "$p" "${patch%.patch}.files/$p" || rc=1
        done
    fi
    if [ "${#others[@]}" -gt 0 ]; then git checkout HEAD -- "${others[@]}" || rc=1; fi
    exec 7>&-
    [ "$rc" -eq 0 ] || { log "ERROR: quarantine incomplete; the tree needs a human: $*"; return 1; }
    log "quarantined to ${patch} and restored to HEAD: $*"
}

gate() {  # ARGS... -> the tick gate's first two lines, with the steward's per-alert cooldown
    local out
    out=$(RESPONDER_TICK_ALERT_COOLDOWN="$ALERT_COOLDOWN" bash "$TICK_GATE" "$@" 2>/dev/null) || :  # whole output first: no pipe a claim could die on
    printf '%s\n' "$out" | command sed -n '1,2p'
}

hold_watchdog_lock() {  # held exclusively through an ALERT or BACKLOG run, so the chat watchdog skips its fires
    exec 8>>"$WATCHDOG_LOCK"
    flock -n -x 8 && return 0
    exec 8>&-
    return 1
}

run_claude() {  # MODEL BUDGET TIMEOUT CWD PROMPT OUT EXTRA... -> rc on stdout
    local model="$1" budget="$2" tmo="$3" cwd="$4" prompt="$5" out="$6" rc=0
    shift 6
    ( cd "$cwd" && CLAUDE_CONFIG_DIR="$CLAUDE_PROFILE" ENABLE_CLAUDEAI_MCP_SERVERS=false command timeout -k "$KILL_AFTER" "$tmo" \
        "$CLAUDE_CMD" -p --model "$model" --max-budget-usd "$budget" --output-format json --strict-mcp-config "$@" \
        < "$prompt" > "$out" 2> "${out}.err" 7>&- 8>&- 9>&- ) || rc=$?  # closed fds: a surviving child cannot hold our locks
    echo "$rc"
}

ledger() {  # TASK MODEL RC OUTCOME BUDGET RESULT DETAIL -> cost string; settles RUN_ID's reservation
    helper ledger-append --ledger "$LEDGER" --task "$1" --model "$2" --rc "$3" --outcome "$4" \
        --budget "$5" --result "$6" --detail "$7" --run-id "${RUN_ID:-}" || echo "unrecorded (reservation stands)"
}

reserve() {  # TASK MODEL BUDGET: put the cap on the books before claude starts, or refuse the run
    RUN_ID="$(command date -u '+%Y%m%dT%H%M%SZ')-$$-$1"
    if ! helper ledger-reserve --ledger "$LEDGER" --task "$1" --model "$2" --budget "$3" --run-id "$RUN_ID"; then
        log "DONE $1 refused: could not reserve \$$3 in ${LEDGER}; claude not called"
        RUN_ID=""
        return 1
    fi
    : > "$LEDGER_SEEN"
}

restore_outlook() {  # put data/outlook.json back to HEAD without deleting a candidate
    if git cat-file -e "HEAD:$OUTLOOK" 2>/dev/null; then
        git checkout HEAD -- "$OUTLOOK" || log "ERROR: could not restore ${OUTLOOK} to HEAD"
    else
        git rm -q --cached -- "$OUTLOOK" 2>/dev/null || :
        [ -e "$OUTLOOK" ] && command mv -f "$OUTLOOK" "$RUN_DIR/outlook.rejected.json"
    fi
}

commit_outlook() {  # CANDIDATE MANIFEST -> commit sha on stdout; holds the cycle lock throughout
    local cand="$1" manifest="$2" stamp verdict sha
    stamp=$(command date -u '+%Y-%m-%dT%H:%MZ')
    exec 7>"$CYCLE_LOCK"
    if ! flock -w "$CYCLE_LOCK_WAIT" 7; then
        log "COLLATERAL: cycle lock busy for ${CYCLE_LOCK_WAIT}s; not committing"
        exec 7>&-
        return 1
    fi
    command cp "$cand" "data/.outlook.json.steward-tmp"
    command mv -f "data/.outlook.json.steward-tmp" "$OUTLOOK"
    if ! verdict=$(helper check "$OUTLOOK" --manifest "$manifest"); then  # re-check the copy the cycle will publish
        log "COLLATERAL: placed file failed the check (${verdict}); restoring"
        restore_outlook
        exec 7>&-
        return 1
    fi
    git add -- "$OUTLOOK"
    if git diff --cached --quiet -- "$OUTLOOK"; then
        exec 7>&-
        echo "unchanged"
        return 0
    fi
    if ! git commit -q -m "Collateral refresh ${stamp} (steward): outlook" -- "$OUTLOOK" >/dev/null 2>>"$LOGFILE"; then
        log "COLLATERAL: git commit failed; restoring ${OUTLOOK}"
        git reset -q -- "$OUTLOOK" 2>/dev/null || :
        restore_outlook
        exec 7>&-
        return 1
    fi
    sha=$(git rev-parse --short HEAD)
    exec 7>&-
    echo "$sha"
}

run_collateral() {
    local mode="$1" ahash="$2" reasons="$3" now rc verdict summary cost sha ttl
    RUN_DIR="$STATE_DIR/run-collateral"
    command mkdir -p "$RUN_DIR"
    now=$(now_epoch)
    helper state-set --state "$STATE" collateral "lastAttemptAt=$now" "lastMode=$mode" lastOk=false
    if ! summary=$(helper fetch --out "$RUN_DIR"); then
        cost=$(ledger COLLATERAL "$COLLATERAL_MODEL" 0 no-sources 0 "" "$summary")
        log "DONE COLLATERAL no-sources: ${summary}; claude not called"
        return 0
    fi
    helper render "$PROMPTS/collateral.md" \
        "NOW_UTC=$(command date -u -d "@$now" '+%Y-%m-%dT%H:%MZ')" \
        "NOW_LOCAL=$(TZ=America/Chicago command date -d "@$now" '+%a %b %-d %Y %-I:%M %p %Z')" \
        "MODE=$mode" "REASONS=$reasons" "SOURCES=@$RUN_DIR/sources.txt" "BUNDLE=@$RUN_DIR/bundle.txt" \
        > "$RUN_DIR/prompt.txt"
    : > "$RUN_DIR/result.json"
    reserve COLLATERAL "$COLLATERAL_MODEL" "$COLLATERAL_BUDGET" || return 0
    rc=$(run_claude "$COLLATERAL_MODEL" "$COLLATERAL_BUDGET" "$COLLATERAL_TIMEOUT" "$RUN_DIR" "$RUN_DIR/prompt.txt" \
        "$RUN_DIR/result.json" --safe-mode --tools "" --permission-mode dontAsk --no-session-persistence)
    ttl="$TTL_QUIET"
    [ "$mode" = adverse ] && ttl="$TTL_ADVERSE"
    if ! verdict=$(helper finalize --result "$RUN_DIR/result.json" --out "$RUN_DIR/candidate.json" --ttl-s "$ttl"); then
        cost=$(ledger COLLATERAL "$COLLATERAL_MODEL" "$rc" invalid "$COLLATERAL_BUDGET" "$RUN_DIR/result.json" "$verdict")
        log "DONE COLLATERAL invalid (claude rc=${rc}): ${verdict}; cost \$${cost}; not committed"
        return 0
    fi
    if ! verdict=$(helper check "$RUN_DIR/candidate.json" --manifest "$RUN_DIR/manifest.json"); then
        cost=$(ledger COLLATERAL "$COLLATERAL_MODEL" "$rc" invalid "$COLLATERAL_BUDGET" "$RUN_DIR/result.json" "$verdict")
        log "DONE COLLATERAL invalid: ${verdict}; cost \$${cost}; not committed"
        return 0
    fi
    if ! sha=$(commit_outlook "$RUN_DIR/candidate.json" "$RUN_DIR/manifest.json"); then
        cost=$(ledger COLLATERAL "$COLLATERAL_MODEL" "$rc" commit-failed "$COLLATERAL_BUDGET" "$RUN_DIR/result.json" "$verdict")
        log "DONE COLLATERAL commit-failed; cost \$${cost}"
        return 0
    fi
    helper state-set --state "$STATE" collateral lastOk=true "lastOkAt=$now" "lastOkHash=$ahash"
    cost=$(ledger COLLATERAL "$COLLATERAL_MODEL" "$rc" "committed $sha" "$COLLATERAL_BUDGET" "$RUN_DIR/result.json" "$verdict; $summary")
    log "DONE COLLATERAL committed ${sha} (${verdict}; ${summary}); cost \$${cost}"
}

run_build() {  # TASK PROMPT_TEMPLATE MODEL BUDGET TIMEOUT RENDER_VARS... — ALERT and BACKLOG share this
    local task="$1" template="$2" model="$3" budget="$4" tmo="$5" rc before after bypass_before bypass_after cost dirt
    shift 5
    RUN_DIR="$STATE_DIR/run-$(printf '%s' "$task" | command tr 'A-Z' 'a-z')"
    command mkdir -p "$RUN_DIR"
    before=$(helper outbox-count --outbox "$OUTBOX")
    bypass_before=$(command wc -l < "$BYPASS_LOG" 2>/dev/null || echo 0)
    helper render "$template" "REPO=$ROOT" "OUTBOX=$OUTBOX" "QUARANTINE=$QUARANTINE_DIR" "BUDGET=$budget" "$@" \
        > "$RUN_DIR/prompt.txt"
    : > "$RUN_DIR/result.json"
    reserve "$task" "$model" "$budget" || return 0
    rc=$(run_claude "$model" "$budget" "$tmo" "$ROOT" "$RUN_DIR/prompt.txt" "$RUN_DIR/result.json" \
        --permission-mode bypassPermissions --append-system-prompt "$INBOX_BAN")
    if ! dirt=$(tree_dirt); then dirt=""; log "WARN: could not read git status after the ${task} run"; fi
    if [ -n "$dirt" ]; then
        local -a paths=()
        while IFS= read -r p; do [ -n "$p" ] && paths+=("$p"); done <<< "$dirt"
        quarantine_dirt "${paths[@]}" || :
    fi
    bypass_after=$(command wc -l < "$BYPASS_LOG" 2>/dev/null || echo 0)
    if [ "$bypass_after" -gt "$bypass_before" ]; then
        log "WARN: a deploy with --skip-tests was recorded during the ${task} run"
        helper outbox-append --outbox "$OUTBOX" "Steward ${task} run: a deploy bypassed the test gate (--skip-tests) during this run, which the steward is not allowed to do. See ${BYPASS_LOG}." || :
    fi
    after=$(helper outbox-count --outbox "$OUTBOX")
    if [ "$after" -le "$before" ]; then
        helper outbox-append --outbox "$OUTBOX" "Steward ${task} run ended without posting a report (claude rc=${rc}). Details: ${LOGFILE} and ${RUN_DIR}/result.json." || :
    fi
    cost=$(ledger "$task" "$model" "$rc" "rc=$rc" "$budget" "$RUN_DIR/result.json" "${dirt:+quarantined: $(printf '%s' "$dirt" | command tr '\n' ' ')}")
    log "DONE ${task} claude rc=${rc}; cost \$${cost}${dirt:+; quarantined leftovers}"
}

# ---- pre-gate: cheapest checks first, no LLM anywhere above the RUN line ----
[ -e "$KILL_SWITCH" ] && idle "kill switch present (${KILL_SWITCH})"

exec 9>"$LOCKFILE"
flock -n 9 || idle "another steward run holds ${LOCKFILE}"

if [ -f "$DRAIN_MARKER" ]; then
    mark=$(read_int "$DRAIN_MARKER")
    [ "$mark" -gt 0 ] && [ $(( $(now_epoch) - mark )) -lt "$DRAIN_STALE" ] && idle "a chat drain is active ($(( $(now_epoch) - mark ))s old)"
fi
exec 8>>"$WATCHDOG_LOCK"
flock -n -s 8 || idle "a chat-watchdog recovery is in flight"
exec 8>&-

if ! command mkdir -p "$STATE_DIR" 2>/dev/null || [ ! -w "$STATE_DIR" ]; then
    STATE_DIR=/tmp/responder-steward
    command mkdir -p "$STATE_DIR"
fi
STATE="$STATE_DIR/state.json"
LEDGER_SEEN="$STATE_DIR/ledger-seen"
if [ -e "$LEDGER_SEEN" ] && [ ! -e "$LEDGER" ]; then
    idle "ledger ${LEDGER} vanished since the last run; refusing to spend blind"
fi
( : >> "$LEDGER" ) 2>/dev/null || idle "ledger ${LEDGER} not writable; refusing to spend unrecorded"

SPENT=$(helper ledger-spent --ledger "$LEDGER") || idle "ledger ${LEDGER} unreadable; refusing to spend blind"
NOTES=()
TASK=""

ALERT_LINES=$(gate --alert-only --peek || :)
ALERT_VERDICT=$(printf '%s\n' "$ALERT_LINES" | command sed -n 1p)
if [ "${ALERT_VERDICT%% *}" = "ALERT" ]; then
    ALERT_NAME=$(printf '%s' "$ALERT_VERDICT" | awk '{print $2}')
    EPISODE="${ALERT_NAME} ${ALERT_VERDICT##* since }"
    PREV_EPISODE=$(helper state-get --state "$STATE" alert episode)
    RUNS=0
    [ "$PREV_EPISODE" = "$EPISODE" ] && RUNS=$(helper state-get --state "$STATE" alert runs)
    RUNS="${RUNS:-0}"
    if [ "$RUNS" -ge "$ALERT_MAX_RUNS" ]; then
        NOTES+=("alert ${ALERT_NAME}: ${RUNS} runs this episode, giving it to the owner")
    elif ! fits "$ALERT_BUDGET"; then
        NOTES+=("alert ${ALERT_NAME}: \$${ALERT_BUDGET} would pass the 24h cap")
    elif ! DIRT=$(tree_dirt) || [ -n "$DIRT" ]; then
        NOTES+=("alert ${ALERT_NAME}: tree has uncommitted changes the steward did not make")
    elif [ "$DRY_RUN" -eq 1 ]; then
        TASK=ALERT
    elif ! hold_watchdog_lock; then
        NOTES+=("alert ${ALERT_NAME}: a chat-watchdog recovery started")
    else
        CLAIM=$(gate --alert-only | command sed -n 1p)
        if [ "${CLAIM%% *}" = "ALERT" ]; then
            TASK=ALERT
        else
            exec 8>&-
            NOTES+=("alert ${ALERT_NAME}: claim lost (${CLAIM})")
        fi
    fi
else
    NOTES+=("alert: ${ALERT_VERDICT:-gate gave no verdict}")
fi

if [ -z "$TASK" ]; then
    PACE=$(helper pace --cadence "$CADENCE_STATE" --outlook "$OUTLOOK" --state "$STATE" \
        --quiet-start "$QUIET_START" --quiet-end "$QUIET_END")
    IFS=$'\t' read -r PACE_VERDICT MODE AHASH REASONS PACE_WHY <<< "$PACE"
    [ "$AHASH" = "-" ] && AHASH=""
    if [ "$FORCE_COLLATERAL" -eq 1 ]; then
        PACE_VERDICT=RUN
        PACE_WHY="forced; ${PACE_WHY}"
    fi
    if [ "$PACE_VERDICT" = "RUN" ]; then
        if fits "$COLLATERAL_BUDGET"; then
            TASK=COLLATERAL
        else
            NOTES+=("collateral due but \$${COLLATERAL_BUDGET} would pass the 24h cap")
        fi
    else
        NOTES+=("collateral: ${PACE_WHY}")
    fi
fi

if [ -z "$TASK" ] && [ -e "$BACKLOG_FLAG" ]; then
    BL=$(gate --peek | command sed -n 1p)
    if [ "$BL" != "BACKLOG" ]; then
        NOTES+=("backlog: ${BL}")
    elif ! fits "$BACKLOG_BUDGET"; then
        NOTES+=("backlog: \$${BACKLOG_BUDGET} would pass the 24h cap")
    elif ! DIRT=$(tree_dirt) || [ -n "$DIRT" ]; then
        NOTES+=("backlog: tree has uncommitted changes the steward did not make")
    elif [ "$DRY_RUN" -eq 1 ]; then
        TASK=BACKLOG
    elif ! hold_watchdog_lock; then
        NOTES+=("backlog: a chat-watchdog recovery started")
    elif [ "$(gate | command sed -n 1p)" = "BACKLOG" ]; then
        TASK=BACKLOG
    else
        exec 8>&-
        NOTES+=("backlog: claim lost")
    fi
fi

BUDGET_NOTE="spent \$${SPENT}/\$${DAILY_CAP} in 24h"
NOTE_TEXT=""
for n in "${NOTES[@]}"; do NOTE_TEXT="${NOTE_TEXT:+${NOTE_TEXT}; }${n}"; done
[ -n "$TASK" ] || idle "${NOTE_TEXT}; ${BUDGET_NOTE}"
[ -z "$NOTE_TEXT" ] || BUDGET_NOTE="${BUDGET_NOTE}; skipped: ${NOTE_TEXT}"

case "$TASK" in
    ALERT) WHY="${ALERT_VERDICT}" ;;
    COLLATERAL) WHY="${PACE_WHY}" ;;
    BACKLOG) WHY="discretionary slot" ;;
esac
if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN would RUN ${TASK} (${WHY}); ${BUDGET_NOTE}; nothing claimed"
    exit 0
fi
log "RUN ${TASK} (${WHY}); ${BUDGET_NOTE}"

case "$TASK" in
    ALERT)
        helper state-set --state "$STATE" alert "episode=$EPISODE" "runs=$((RUNS + 1))" "lastAttemptAt=$(now_epoch)"
        run_build ALERT "$PROMPTS/alert.md" "$ALERT_MODEL" "$ALERT_BUDGET" "$ALERT_TIMEOUT" \
            "ALERT=$ALERT_VERDICT" "HINT=$(printf '%s\n' "$ALERT_LINES" | command sed -n 2p)" \
            "CYCLE_STATUS=$CYCLE_STATUS" "RUN_N=$((RUNS + 1))" "RUN_MAX=$ALERT_MAX_RUNS"
        ;;
    COLLATERAL) run_collateral "$MODE" "$AHASH" "$REASONS" ;;
    BACKLOG) run_build BACKLOG "$PROMPTS/backlog.md" "$BACKLOG_MODEL" "$BACKLOG_BUDGET" "$BACKLOG_TIMEOUT" ;;
esac
exit 0
