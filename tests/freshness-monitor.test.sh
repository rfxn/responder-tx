#!/bin/bash
# tests/freshness-monitor.test.sh — regression tests for scripts/freshness-monitor.sh.
# Proves the public-mirror freshness monitor alerts when it should and stays quiet
# when it should not:
#   1 fresh mirror => no alert
#   2 stale mirror => one alert, correct tier, no em-dash in owner-facing text
#   3 one transient fetch failure => no alert
#   4 fetch failures past the streak => one UNREACHABLE alert
#   5 cooldown suppresses a repeat alert for the same verdict
#   6 no prior state file and no outbox (fresh install) => tolerated, alert lands
#   7 stale then fresh => one recovery notice
# A file:// mirror URL and a throwaway temp dir keep the real repo data and the
# network untouched. Run: bash tests/freshness-monitor.test.sh
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
MON="$REPO_ROOT/scripts/freshness-monitor.sh"
FAILS=0

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; FAILS=$((FAILS + 1)); }

json_valid() { python3 -m json.tool "$1" > /dev/null 2>&1; }

count_msgs() {  # FILE -> stdout count of outbox entries
    python3 - "$1" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except (OSError, ValueError):
    print(0); raise SystemExit(0)
print(len(d.get("messages", [])))
PY
}

has_text() {  # FILE SUBSTR -> exit 0 if any entry text contains SUBSTR
    python3 - "$1" "$2" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except (OSError, ValueError):
    raise SystemExit(1)
sys.exit(0 if any(sys.argv[2] in (m.get("text") or "") for m in d.get("messages", [])) else 1)
PY
}

mk_snapshot() {  # FILE AGE_MIN — a minimal snapshot with a generated stamp AGE_MIN old
    printf '{"generated":"%s","gauges":[]}\n' "$(date -u -d "-$2 min" '+%Y-%m-%dT%H:%M:%SZ')" > "$1"
}

setup() {  # fresh temp workdir: fresh local pipeline state, empty outbox, no monitor state
    WORK=$(mktemp -d)
    mkdir -p "$WORK/data" "$WORK/remote"
    printf '{\n "messages": []\n}\n' > "$WORK/data/chat-outbox.json"
    mk_snapshot "$WORK/data/gauges-snapshot.json" 3
    mk_snapshot "$WORK/remote/gauges-snapshot.json" 3
    printf '%s deploy OK\n' "$(date -u -d '-3 min' '+%Y-%m-%dT%H:%M:%SZ')" > "$WORK/cycle.log"
    OUT="$WORK/data/chat-outbox.json"
    STATE="$WORK/monitor-state"
}

run_monitor() {  # runs the monitor against the temp state + file:// mirror; sets RC
    RESPONDER_MONITOR_URL="${URL:-file://$WORK/remote/gauges-snapshot.json}" \
    RESPONDER_MONITOR_OUTBOX="$WORK/data/chat-outbox.json" \
    RESPONDER_MONITOR_SNAPSHOT="$WORK/data/gauges-snapshot.json" \
    RESPONDER_MONITOR_STATE="$STATE" \
    RESPONDER_MONITOR_LOCK="$WORK/monitor.lock" \
    RESPONDER_MONITOR_LOG="$WORK/monitor.log" \
    RESPONDER_CYCLE_LOG="$WORK/cycle.log" \
    RESPONDER_MONITOR_WARN_MIN="${WARN:-45}" \
    RESPONDER_MONITOR_CRIT_MIN="${CRIT:-90}" \
    RESPONDER_MONITOR_FAIL_STREAK="${STREAK:-3}" \
    RESPONDER_MONITOR_COOLDOWN="${COOL:-21600}" \
    RESPONDER_MONITOR_TIMEOUT=10 \
    bash "$MON" > "$WORK/run.out" 2>&1
    RC=$?
}

# --- Test 1: fresh mirror => no alert ---------------------------------------
setup
run_monitor
if [ "$RC" -eq 0 ] && [ "$(count_msgs "$OUT")" -eq 0 ] \
   && grep -q 'verdict=FRESH' "$WORK/monitor.log" \
   && [ -f "$STATE" ] && grep -q '^FRESH 0 0$' "$STATE"; then
    pass "1 fresh mirror: no alert, verdict FRESH, state written"
else
    fail "1 fresh mirror produces no alert"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

# --- Test 2: stale mirror => one alert, right tier, owner-facing text clean ---
setup; mk_snapshot "$WORK/remote/gauges-snapshot.json" 120
run_monitor
if [ "$RC" -eq 1 ] && json_valid "$OUT" && [ "$(count_msgs "$OUT")" -eq 1 ] \
   && has_text "$OUT" "Data freshness alert (CRITICAL)" \
   && has_text "$OUT" "the publish path (deploy or Cloudflare) is serving stale data" \
   && ! has_text "$OUT" "—"; then
    pass "2 stale mirror: one CRITICAL alert naming the publish path, no em-dash, outbox valid"
else
    fail "2 stale mirror alerts once"; cat "$OUT"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

# --- Test 3: a single transient fetch failure => no alert --------------------
setup; URL="file://$WORK/remote/absent.json"
run_monitor
if [ "$RC" -eq 0 ] && [ "$(count_msgs "$OUT")" -eq 0 ] \
   && grep -q 'treating as transient, no alert' "$WORK/monitor.log"; then
    pass "3 one unreachable fetch: treated as transient, no alert"
else
    fail "3 transient fetch failure stays quiet"; cat "$WORK/run.out"
fi
unset URL
rm -rf "$WORK"

# --- Test 4: failures past the streak => one UNREACHABLE alert ---------------
setup; URL="file://$WORK/remote/absent.json"; STREAK=3
run_monitor; rc1=$RC
run_monitor; rc2=$RC
run_monitor; rc3=$RC
if [ "$rc1" -eq 0 ] && [ "$rc2" -eq 0 ] && [ "$rc3" -eq 1 ] \
   && [ "$(count_msgs "$OUT")" -eq 1 ] \
   && has_text "$OUT" "Data freshness alert (UNREACHABLE)" \
   && has_text "$OUT" "did not answer the last 3 checks"; then
    pass "4 three consecutive unreachable fetches: exactly one UNREACHABLE alert on the third"
else
    fail "4 fetch failures past the streak alert once"; cat "$OUT"; cat "$WORK/run.out"
fi
unset URL; unset STREAK
rm -rf "$WORK"

# --- Test 5: cooldown suppresses a repeat alert ------------------------------
setup; mk_snapshot "$WORK/remote/gauges-snapshot.json" 120
run_monitor; run_monitor; run_monitor
if [ "$(count_msgs "$OUT")" -eq 1 ] && grep -q 'alert suppressed: same verdict CRITICAL' "$WORK/monitor.log"; then
    pass "5 sustained outage: cooldown holds the outbox to one alert across three runs"
else
    fail "5 cooldown suppresses repeat alerts (got $(count_msgs "$OUT") messages)"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

# --- Test 6: no prior state file and no outbox (fresh install) => tolerated ---
setup; mk_snapshot "$WORK/remote/gauges-snapshot.json" 60
rm -f "$OUT" "$STATE"
run_monitor
if [ "$RC" -eq 1 ] && json_valid "$OUT" && [ "$(count_msgs "$OUT")" -eq 1 ] \
   && has_text "$OUT" "Data freshness alert (WARN)" && [ -f "$STATE" ]; then
    pass "6 absent state file and absent outbox tolerated: WARN alert lands, both created"
else
    fail "6 missing state/outbox tolerated"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

# --- Test 7: recovery notice once the mirror catches up ----------------------
setup; mk_snapshot "$WORK/remote/gauges-snapshot.json" 120
run_monitor
mk_snapshot "$WORK/remote/gauges-snapshot.json" 2
run_monitor; rc_after=$RC
run_monitor
if [ "$rc_after" -eq 0 ] && [ "$(count_msgs "$OUT")" -eq 2 ] \
   && has_text "$OUT" "Data freshness recovered" \
   && has_text "$OUT" "Prior state was CRITICAL" \
   && grep -q '^FRESH 0 0$' "$STATE"; then
    pass "7 mirror catches up: exactly one recovery notice, state back to FRESH"
else
    fail "7 recovery notice posted once"; cat "$OUT"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

echo "----"
if [ "$FAILS" -eq 0 ]; then
    echo "ALL FRESHNESS-MONITOR TESTS PASSED"
    exit 0
else
    echo "${FAILS} TEST(S) FAILED"
    exit 1
fi
