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

# run-cycle.sh exports RESPONDER_ROOT and deploy.sh runs this gate under it, so an inherited one
# pointed every generator a test spawns at the LIVE repo: gen-history.test.py wrote the real
# data/history.json and then failed on the file its own temp repo never got. No gated test may
# inherit it; a test that needs one sets its own.
unset RESPONDER_ROOT

# Nothing gated may reach a third party: the publish path of a life-safety board cannot depend on
# an upstream being up. tests/nonet/sitecustomize.py is imported by every python process started
# under this PYTHONPATH, including the generator subprocesses the suites spawn.
export PYTHONPATH="$PWD/tests/nonet${PYTHONPATH:+:$PYTHONPATH}"
export RESPONDER_NONET_LOG="$SCRATCH/network-reached.log"
: > "$RESPONDER_NONET_LOG" || { echo "FAIL: cannot arm the network trap ledger" >&2; exit 1; }
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
    # same reason as restore-drill.sh: a bare dir is one failing test on Node 22+, and 24 defaults to the spec reporter
    run_one "node unit suite" node --test --test-reporter=tap tests/*.test.js
fi

# The shell and python suites are enumerated from disk, never from a list kept here. A hand-kept
# list is how four python suites ended up running nowhere in CI: they existed, and nothing named
# them. An empty match is a failure, not a green suite, for the same reason.
run_glob() {
    local label=$1 pattern=$2
    shift 2
    local found=0 f
    # shellcheck disable=SC2086  # $pattern must stay unquoted: it is the glob; a no-match yields the literal, caught below
    for f in $pattern; do
        [ -e "$f" ] || continue
        found=1
        run_one "$f" "$@" "$f"
    done
    if [ "$found" -eq 0 ]; then
        echo "FAIL: no ${pattern} found; an empty ${label} suite is not a passing one" | tee -a "$LOG"
        FAILED+=("${label} suite: no files matched ${pattern}")
    fi
}

if [ "$SUITE" = shell ] || [ "$SUITE" = all ]; then
    run_glob shell 'tests/*.test.sh' bash
fi

if [ "$SUITE" = py ] || [ "$SUITE" = all ]; then
    run_glob py 'tests/*.test.py' python3
fi

# The ledger, not the raised error, is the verdict: a generator that catches the trap and records
# a miss would otherwise pass while still having reached out.
if [ -s "$RESPONDER_NONET_LOG" ]; then
    {
        echo
        echo "FAIL: a gated test reached a real host; the gate must not depend on third-party uptime"
        cat "$RESPONDER_NONET_LOG"
    } | tee -a "$LOG"
    FAILED+=("network trap: a gated test reached a real host")
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
