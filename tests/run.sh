#!/bin/bash
# run.sh [node|shell|py|all] — run the suites with the full log always written to a file.
#
# This exists to make the tee rule mechanical rather than remembered: a pipe-only run
# (`node --test tests/ | tail -30`) discards the failing test's name and its assertion diff,
# and a flake that cannot be reproduced then has no evidence left. Two failures were lost that
# way on 2026-07-25. Every invocation here writes the whole log and prints the failing test
# names and the log path at the end.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

SUITE="${1:-all}"
case "$SUITE" in
    node|shell|py|all) ;;
    *) echo "FAIL: unknown suite '$SUITE' (supported: node, shell, py, all)" >&2; exit 2 ;;
esac

LOG="${RESPONDER_TEST_LOG:-/tmp/responder-test-${SUITE}-$(date -u '+%Y%m%dT%H%M%SZ').log}"
: > "$LOG" || { echo "FAIL: cannot write ${LOG}" >&2; exit 1; }

# Belt and braces over each suite's own isolation: nothing run from here may reach a path the
# live 15-minute data cycle owns. Taking /tmp/responder-cycle.lock costs a real publish.
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/responder-test.XXXXXX") || exit 1
trap 'rm -rf "$SCRATCH"' EXIT INT TERM
export RESPONDER_CYCLE_LOCK="$SCRATCH/cycle.lock"
export RESPONDER_CYCLE_LOG="$SCRATCH/cycle.log"
export RESPONDER_MONITOR_LOCK="$SCRATCH/monitor.lock"
export RESPONDER_MONITOR_STATE="$SCRATCH/monitor.state"
export RESPONDER_MONITOR_LOG="$SCRATCH/monitor.log"
export RESPONDER_CHAT_LOCK="$SCRATCH/chat.lock"
export RESPONDER_CHAT_LOG="$SCRATCH/chat.log"
export RESPONDER_CHAT_WATCHDOG_LOCK="$SCRATCH/watchdog.lock"
export RESPONDER_CHAT_WATCHDOG_STATE="$SCRATCH/watchdog.state"
export RESPONDER_CHAT_WATCHDOG_LOG="$SCRATCH/watchdog.log"

FAILED=()

run_one() {
    local label=$1
    shift
    printf '\n=== %s: %s\n' "$label" "$*" | tee -a "$LOG"
    "$@" 2>&1 | tee -a "$LOG"
    local rc=${PIPESTATUS[0]}
    [ "$rc" -eq 0 ] || FAILED+=("$label")
}

if [ "$SUITE" = node ] || [ "$SUITE" = all ]; then
    run_one "node unit suite" node --test tests/
fi

if [ "$SUITE" = shell ] || [ "$SUITE" = all ]; then
    for f in chat-poll chat-watchdog deploy cycle-check run-cycle freshness-monitor; do
        run_one "tests/${f}.test.sh" bash "tests/${f}.test.sh"
    done
fi

if [ "$SUITE" = py ] || [ "$SUITE" = all ]; then
    for f in server-gate gen-notices gen-shelters gen-caltopo gen-history gen-cameras; do
        run_one "tests/${f}.test.py" python3 "tests/${f}.test.py"
    done
fi

{
    echo
    echo "=== full log: ${LOG}"
    if [ "${#FAILED[@]}" -eq 0 ]; then
        echo "SUMMARY: all suites green"
    else
        echo "SUMMARY: ${#FAILED[@]} suite(s) FAILED: ${FAILED[*]}"
        echo "failing tests:"
        grep -E '^(not ok |FAIL: |FAIL · )' "$LOG" | sed 's/^/  /'
    fi
} | tee -a "$LOG"

[ "${#FAILED[@]}" -eq 0 ]
