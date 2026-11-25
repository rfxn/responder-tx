#!/bin/bash
# tests/steward.test.sh: scripts/steward.sh, the cron steward that runs at most one headless claude per fire.
# A scratch git repo, a stub claude (RESPONDER_STEWARD_CLAUDE_CMD) and fixture source pages
# (RESPONDER_STEWARD_FETCH_DIR) keep the real repo, the network and the account untouched.
#   1-4   kill switch, steward lock, fresh drain marker, a live watchdog recovery: IDLE, claude never called
#   5-7   COLLATERAL: rfxn profile, sonnet, $1 cap, no tools; commits ONLY data/outlook.json under the cycle
#         lock; ledger records the run's cost and tokens; a stale (2018) source is not offered
#   8-9   quiet pacing: a fresh outlook, and quiet hours, are IDLE
#   10-12 adverse pacing: a quiet->adverse transition runs at once, then hourly only on a changed alert set
#   13-15 budget: a 24h spend near the cap refuses, entries older than 24h do not count, an unparseable
#         ledger refuses; a run that leaves no JSON is charged its full budget
#   16-18 invalid outlooks (a URL not fetched, an em-dash, a guessed issue time) commit nothing; retry backs off
#   19-21 ALERT: a held CRITICAL runs opus with bypassPermissions once per 2h, reports even when the run
#         did not, refuses a dirty tree, and stops after the episode's run cap
#   22-23 BACKLOG is off without its flag file; --dry-run calls nothing and claims nothing
#   24    the steward's cycle lane agrees with chat-watchdog.sh's (E5)
#   25    tick-burn.py --steward reports spend per day and per task, and UNKNOWN (exit 3) with no ledger
#   36    a product labelled up to 2h ahead of now (NHC publishes early) is current; further ahead is refused
#   34-35 an item may not outlast its product's horizon, and the outlook expires with its earliest "none"
#   31-33 spend is reserved before a run and settled after; no writable ledger, or a vanished one, means no run
#   30    every headless call shuts out MCP connectors; build runs are told the inbox is not theirs
#   29    ALERT and BACKLOG hold the chat-watchdog lock for the whole run (no two build sessions); COLLATERAL does not
#   28    a build run's leftovers, a staged NEW file included, are banked and removed under the cycle lock
#   26-27 E1: no flood product means no refresh; absence claimed for a hazard whose product failed, a
#         "none" item citing another hazard's product, or a link in text is rejected
# Quiet hours are pinned off (test 9 pins its own) and TZ is taken from the caller, so the suite
# passes at any wall-clock hour: TZ=<zone> bash tests/steward.test.sh pins the local hour.
# Run: bash tests/steward.test.sh
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SUITE_TZ="${TZ:-America/Chicago}"
# Every inherited RESPONDER_* is dropped (tests/run.sh exports shared scratch paths); each run pins its own.
SCRUB=()
while IFS= read -r v; do SCRUB+=(-u "$v"); done < <(compgen -e | grep '^RESPONDER_' || :)
FAILS=0
pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; FAILS=$((FAILS + 1)); }

cleanup() { if [ -n "${WORK:-}" ]; then rm -rf "$WORK"; fi; }
trap cleanup EXIT INT TERM

tz_at_hour() {  # HOUR -> a POSIX TZ string whose local hour is HOUR now
    local u off
    u=$((10#$(date -u +%H))); off=$(( ($1 - u + 24) % 24 ))
    [ "$off" -gt 12 ] && off=$((off - 24))
    if [ "$off" -ge 0 ]; then echo "PIN-${off}"; else echo "PIN+$((-off))"; fi
}

hdr_time() {  # MINUTES_AGO -> an NWS header time in UTC, e.g. "0734 PM UTC Mon Nov 23 2026"
    date -u -d "-$1 min" '+%I%M %p UTC %a %b %d %Y'
}

make_fixtures() {
    local filler="Forecast text for the outlook period with enough words to look like a real product body."
    filler="$filler $filler $filler"
    printf '<html><pre>\nDay 1 Convective Outlook\nNWS Storm Prediction Center Norman OK\n%s\n\n%s\n</pre></html>\n' \
        "$(hdr_time 60)" "$filler" > "$FX/spc-d1"
    printf '<html><pre>\nExcessive Rainfall Discussion\nNWS Weather Prediction Center College Park MD\n%s\n\n%s\n</pre></html>\n' \
        "$(hdr_time 90)" "$filler" > "$FX/wpc-ero"
    printf '<html><pre>\nShort Range Forecast Discussion\nNWS Weather Prediction Center College Park MD\n532 AM EDT Tue Jun 05 2018\n\n%s\n</pre></html>\n' \
        "$filler" > "$FX/wpc-short"
}

setup() {
    WORK=$(mktemp -d)
    REPO="$WORK/repo"
    FX="$WORK/fx"
    STUB_DIR="$WORK/stub"
    mkdir -p "$REPO/scripts/steward" "$REPO/data" "$FX" "$STUB_DIR" "$WORK/profile" "$WORK/state"
    cp "$REPO_ROOT/scripts/steward.sh" "$REPO_ROOT/scripts/tick-gate.sh" "$REPO/scripts/"
    cp "$REPO_ROOT"/scripts/steward/*.md "$REPO_ROOT/scripts/steward/steward.py" "$REPO/scripts/steward/"
    printf '{"generated":"2026-07-25T00:00:00Z","gauges":[]}\n' > "$REPO/data/gauges-snapshot.json"
    printf 'const APP_VERSION = "v9.9.9";\n' > "$REPO/data/app.txt"
    git -C "$REPO" init -q
    git -C "$REPO" config user.email t@example.test
    git -C "$REPO" config user.name Test
    git -C "$REPO" add -A
    git -C "$REPO" commit -qm 'scratch base'
    printf '{\n "messages": []\n}\n' > "$WORK/outbox.json"
    echo '{"stub":"creds"}' > "$WORK/profile/.credentials.json"
    make_fixtures
    cat > "$STUB_DIR/claude" <<'SH'
#!/bin/bash
printf '%s\n' "$@" > "$STUB_DIR/args"
printf '%s\n' "${CLAUDE_CONFIG_DIR:-unset}" > "$STUB_DIR/cfg"
{ printf '%s\n' "${ENABLE_CLAUDEAI_MCP_SERVERS:-unset}"; printf '%s\n' "$@"; echo ----; } >> "$STUB_DIR/calllog"
pwd > "$STUB_DIR/cwd"
cat > "$STUB_DIR/stdin"
echo call >> "$STUB_DIR/calls"
if flock -n "$STUB_WDLOCK" true; then echo free; else echo held; fi >> "$STUB_DIR/wdlock"
python3 -I "$STUB_HELPER" ledger-spent --ledger "$STUB_LEDGER" >> "$STUB_DIR/spent-during" 2>&1
[ "$STUB_MODE" = "crash" ] && exit 1
if [ "$STUB_MODE" = "stage-new" ]; then
    printf 'echo planted\n' > scripts/new-tool.sh
    git add scripts/new-tool.sh
    printf 'half-finished\n' >> data/app.txt
fi
exec python3 -I "$STUB_DIR/stub.py" "$STUB_MODE"
SH
    cat > "$STUB_DIR/stub.py" <<'PY'
import json, os, sys, time
mode = sys.argv[1]
iso = lambda e: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(e))
reply = "Checked the fault; nothing to fix."
if os.path.exists("manifest.json"):
    src = [s for s in json.load(open("manifest.json"))["sources"] if s["status"] == "ok" and s["id"] == "spc-d1"][0]
    now = int(time.time())
    item = {"id": "spc-d1", "kind": "severe", "level": "none",
            "title": {"en": "No severe storms forecast", "es": "No se pronostican tormentas severas"},
            "body": {"en": "Severe storms are not expected in Texas today.",
                     "es": "No se esperan tormentas severas en Texas hoy."},
            "window": {"start": iso(now), "end": iso(now + (5 if mode == "short-none" else 20) * 3600)},
            "source": {"name": src["name"], "url": src["url"]}, "issued": src["issued"]}
    if mode == "bad-url":
        item["source"]["url"] = "https://example.com/made-up"
    if mode == "emdash":
        item["body"]["en"] = "Quiet weather — no storms."
    if mode == "guessed-time":
        item["issued"] = iso(now - 7200)
    reply = "Here it is:\n" + json.dumps({"headline": {"en": "Quiet days ahead for Texas.",
                                                      "es": "Dias tranquilos para Texas."}, "items": [item]})
print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": reply,
                  "total_cost_usd": float(os.environ.get("STUB_COST", "0.1234")), "num_turns": 1,
                  "duration_ms": 900, "session_id": "stub-session",
                  "usage": {"input_tokens": 11, "output_tokens": 222, "cache_read_input_tokens": 3333,
                            "cache_creation_input_tokens": 4444},
                  "modelUsage": {"claude-stub-model": {}}}))
PY
    chmod +x "$STUB_DIR/claude"
    STUB_MODE=good
    STUB_COST=0.1234
}

run_steward() {  # ARGS... ; sets RC
    env "${SCRUB[@]}" \
    STUB_DIR="$STUB_DIR" STUB_MODE="$STUB_MODE" STUB_COST="$STUB_COST" STUB_WDLOCK="$WORK/watchdog.lock" \
    STUB_HELPER="$REPO/scripts/steward/steward.py" STUB_LEDGER="${LEDGER_AT:-$WORK/ledger.jsonl}" \
    RESPONDER_STEWARD_CLAUDE_CMD="$STUB_DIR/claude" \
    RESPONDER_CLAUDE_CONFIG_DIR="$WORK/profile" \
    RESPONDER_STEWARD_FETCH_DIR="$FX" \
    RESPONDER_STEWARD_LOG="$WORK/steward.log" \
    RESPONDER_STEWARD_LEDGER="${LEDGER_AT:-$WORK/ledger.jsonl}" \
    RESPONDER_STEWARD_STATE_DIR="$WORK/state" \
    RESPONDER_STEWARD_LOCK="$WORK/steward.lock" \
    RESPONDER_STEWARD_QUARANTINE="$WORK/quarantine" \
    RESPONDER_CHAT_WATCHDOG_LOCK="$WORK/watchdog.lock" \
    RESPONDER_CYCLE_LOCK="$WORK/cycle.lock" \
    RESPONDER_CHAT_OUTBOX="$WORK/outbox.json" \
    RESPONDER_CYCLE_STATUS="$WORK/cycle-status.json" \
    RESPONDER_DEPLOY_BYPASS_LOG="$WORK/bypass.log" \
    RESPONDER_MONITOR_STATE="$WORK/monitor-state" \
    RESPONDER_BACKUP_STATE="$WORK/backup-state" \
    RESPONDER_TICK_GATE_LOG="$WORK/tick-gate.log" \
    RESPONDER_TICK_GATE_LOCK="$WORK/tick-gate.lock" \
    RESPONDER_TICK_QUIET_START=0 RESPONDER_TICK_QUIET_END=0 \
    RESPONDER_STEWARD_CYCLE_LOCK_WAIT="${LOCK_WAIT:-5}" \
    RESPONDER_TICK_ALERT_STATE="$REPO/data/.tick-gate-alert-state" \
    RESPONDER_STEWARD_QUIET_START="${QS:-0}" RESPONDER_STEWARD_QUIET_END="${QE:-0}" \
    RESPONDER_STEWARD_NOW="${NOW_AT:-}" TZ="${TZ_AT:-$SUITE_TZ}" \
    bash "$REPO/scripts/steward.sh" "$@" > "$WORK/run.out" 2>&1
    RC=$?
}

calls() { [ -f "$STUB_DIR/calls" ] && wc -l < "$STUB_DIR/calls" | tr -d ' ' || echo 0; }
last_log() { tail -n 1 "$WORK/steward.log" 2>/dev/null; }
commits() { git -C "$REPO" rev-list --count HEAD; }
ledger_n() { [ -f "$WORK/ledger.jsonl" ] && wc -l < "$WORK/ledger.jsonl" | tr -d ' ' || echo 0; }
ledger_field() { tail -n 1 "$WORK/ledger.jsonl" | python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])"; }
cadence() {  # MODE HASH
    printf '{"mode":"%s","alertSetHash":"%s","reasons":["Flash Flood Warning (2)"],"forced":false,"problems":[]}\n' \
        "$1" "$2" > "$REPO/data/.cadence-state.json"
}
mk_crit() {  # HELD_MIN: a freshness monitor state whose CRITICAL began HELD_MIN ago
    local now; now=$(date +%s)
    printf 'CRITICAL 0 %s 120 %s\n' "$now" "$((now - $1 * 60))" > "$WORK/monitor-state"
}

# --- 1-4: the cheap refusals ------------------------------------------------------------------
setup
touch "$REPO/data/.steward-off"
run_steward
if [ "$(calls)" -eq 0 ] && last_log | grep -q 'IDLE kill switch present'; then
    pass "1 the kill switch file stops the steward before anything else"
else fail "1 kill switch (calls=$(calls)): $(last_log)"; fi
rm -f "$REPO/data/.steward-off"

( flock -n 5 && run_steward ) 5>"$WORK/steward.lock"
if [ "$(calls)" -eq 0 ] && last_log | grep -q 'IDLE another steward run holds'; then
    pass "2 a held steward lock makes the fire IDLE (single flight)"
else fail "2 steward lock (calls=$(calls)): $(last_log)"; fi

date +%s > "$REPO/data/.chat-drain-active"
run_steward
if [ "$(calls)" -eq 0 ] && last_log | grep -q 'IDLE a chat drain is active'; then
    pass "3 a fresh chat drain marker defers the steward"
else fail "3 drain marker (calls=$(calls)): $(last_log)"; fi
rm -f "$REPO/data/.chat-drain-active"

( flock -n 5 && run_steward ) 5>"$WORK/watchdog.lock"
if [ "$(calls)" -eq 0 ] && last_log | grep -q 'IDLE a chat-watchdog recovery is in flight'; then
    pass "4 a chat-watchdog recovery in flight defers the steward"
else fail "4 watchdog lock (calls=$(calls)): $(last_log)"; fi

# --- 5-7: a COLLATERAL run, end to end ------------------------------------------------------------
rm -rf "$WORK"; setup
BASE=$(commits)
printf '{"generated":"2026-07-26T00:00:00Z","gauges":[1]}\n' > "$REPO/data/gauges-snapshot.json"
git -C "$REPO" add data/gauges-snapshot.json
run_steward
ARGS=$(tr '\n' ' ' < "$STUB_DIR/args" 2>/dev/null)
SUBJECT=$(git -C "$REPO" log -1 --format=%s)
FILES=$(git -C "$REPO" show --name-only --format= HEAD | tr '\n' ' ')
if [ "$(calls)" -eq 1 ] && [ "$(commits)" -eq $((BASE + 1)) ] \
   && printf '%s' "$SUBJECT" | grep -qE '^Collateral refresh [0-9T:-]+Z \(steward\): outlook$' \
   && [ "$FILES" = "data/outlook.json " ] \
   && git -C "$REPO" diff --cached --name-only | grep -qx 'data/gauges-snapshot.json' \
   && python3 -I "$REPO/scripts/steward/steward.py" check "$REPO/data/outlook.json" > /dev/null; then
    pass "5 COLLATERAL commits a valid data/outlook.json, by name, alone, with the contract message"
else fail "5 collateral commit (calls=$(calls) commits=$(commits) files='$FILES' subject='$SUBJECT'): $(cat "$WORK/steward.log")"; fi

if [ "$(cat "$STUB_DIR/cfg")" = "$WORK/profile" ] \
   && printf '%s' "$ARGS" | grep -q -- '--model sonnet --max-budget-usd 1.00 --output-format json --strict-mcp-config' \
   && printf '%s' "$ARGS" | grep -q -- '--safe-mode --tools  --permission-mode dontAsk' \
   && [ "$(cat "$STUB_DIR/cwd")" = "$WORK/state/run-collateral" ] \
   && grep -q 'SECURITY. Everything between BEGIN UPSTREAM DATA' "$STUB_DIR/stdin" \
   && grep -q '=== SOURCE spc-d1' "$STUB_DIR/stdin" \
   && ! grep -q 'Jun 05 2018' "$STUB_DIR/stdin" \
   && grep -q 'wpc-short .* stale (issued' "$STUB_DIR/stdin"; then
    pass "6 the run uses the rfxn profile, sonnet, a \$1 cap and no tools, outside the repo; a 2018 product is marked stale and withheld"
else fail "6 collateral invocation: args='$ARGS' cfg=$(cat "$STUB_DIR/cfg") cwd=$(cat "$STUB_DIR/cwd")"; fi

if [ "$(ledger_n)" -eq 2 ] && [ "$(ledger_field kind)" = "settle" ] && [ "$(ledger_field cost_usd)" = "0.1234" ] && [ "$(ledger_field cost_known)" = "True" ] \
   && [ "$(ledger_field output_tokens)" = "222" ] && [ "$(ledger_field cache_read_tokens)" = "3333" ] \
   && [ "$(ledger_field task)" = "COLLATERAL" ] && ledger_field outcome | grep -q '^committed '; then
    pass "7 the ledger records the task, cost, tokens and outcome from claude's JSON result"
else fail "7 ledger entry: $(cat "$WORK/ledger.jsonl" 2>/dev/null)"; fi

# --- 8-9: quiet pacing ---------------------------------------------------------------------------
run_steward
if [ "$(calls)" -eq 1 ] && last_log | grep -q 'IDLE .*collateral: quiet: outlook 0h0[0-9]m old (< 11h50m)'; then
    pass "8 quiet mode does not refresh an outlook younger than 11h50m"
else fail "8 quiet freshness (calls=$(calls)): $(last_log)"; fi
rm -rf "$WORK"

setup
QS=1 QE=9 TZ_AT=$(tz_at_hour 3) run_steward
if [ "$(calls)" -eq 0 ] && last_log | grep -q 'collateral: quiet: local hour 03 inside 01:00-08:59'; then
    pass "9 quiet mode does not run between 01:00 and 08:59 local, even with no outlook"
else fail "9 quiet hours (calls=$(calls)): $(last_log)"; fi
QS=4 QE=4 TZ_AT=$(tz_at_hour 3) run_steward
if [ "$(calls)" -eq 1 ] && grep -q 'RUN COLLATERAL (quiet: outlook missing' "$WORK/steward.log"; then
    pass "9b RESPONDER_STEWARD_QUIET_START/END override the window (equal values disable it)"
else fail "9b quiet-hours override (calls=$(calls)): $(last_log)"; fi
rm -rf "$WORK"

# --- 10-12: adverse pacing -----------------------------------------------------------------------
setup
run_steward
cadence adverse aaaa
run_steward
T_OK=0; [ "$(calls)" -eq 2 ] && grep -q 'RUN COLLATERAL (quiet->adverse transition' "$WORK/steward.log" && T_OK=1
run_steward
H_OK=0; [ "$(calls)" -eq 2 ] && last_log | grep -q 'collateral: adverse: last run 0m ago (< 58m)' && H_OK=1
if [ "$T_OK" -eq 1 ] && [ "$H_OK" -eq 1 ]; then
    pass "10 a quiet->adverse transition refreshes at once, and not again within the hour"
else fail "10 transition (${T_OK}) / hourly (${H_OK}): $(cat "$WORK/steward.log")"; fi

NOW_AT=$(( $(date +%s) + 3600 )) run_steward
if [ "$(calls)" -eq 2 ] && last_log | grep -q 'adverse: alert set unchanged and outlook valid'; then
    pass "11 adverse mode skips the hour when the alert set is unchanged and the outlook is still valid"
else fail "11 unchanged alert set (calls=$(calls)): $(last_log)"; fi

cadence adverse bbbb
NOW_AT=$(( $(date +%s) + 3600 )) run_steward
if [ "$(calls)" -eq 3 ] && grep -q 'RUN COLLATERAL (adverse: alert set changed' "$WORK/steward.log" \
   && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); import datetime as t; f=lambda s:t.datetime.fromisoformat(s.replace("Z","+00:00")); sys.exit(0 if (f(d["validUntil"])-f(d["generated"])).total_seconds()==14400 else 1)' "$REPO/data/outlook.json"; then
    pass "12 a changed alert set refreshes after the hour, and an adverse outlook is valid for 4h"
else fail "12 changed alert set (calls=$(calls)): $(last_log)"; fi
rm -rf "$WORK"

# --- 13-15: the rolling 24h budget ---------------------------------------------------------------
setup
printf '{"ts":"%s","task":"COLLATERAL","cost_usd":7.5}\n{"ts":"%s","task":"ALERT","cost_usd":100}\n' \
    "$(date -u -d '-3 hours' '+%Y-%m-%dT%H:%M:%SZ')" "$(date -u -d '-25 hours' '+%Y-%m-%dT%H:%M:%SZ')" > "$WORK/ledger.jsonl"
run_steward
if [ "$(calls)" -eq 0 ] && last_log | grep -q 'collateral due but \$1.00 would pass the 24h cap; spent \$7.5000/\$8 in 24h'; then
    pass "13 spend near the cap refuses a run that could pass it; an entry older than 24h is not counted"
else fail "13 budget cap (calls=$(calls)): $(last_log)"; fi

printf '{"ts":"%s","task":"COLLATERAL","cost_usd":0.5}\n' "$(date -u -d '-3 hours' '+%Y-%m-%dT%H:%M:%SZ')" > "$WORK/ledger.jsonl"
run_steward
if [ "$(calls)" -eq 1 ]; then
    pass "14 the same fire runs once the 24h spend leaves room"
else fail "14 budget room (calls=$(calls)): $(last_log)"; fi

printf 'not json\n' >> "$WORK/ledger.jsonl"
run_steward --force-collateral
if [ "$(calls)" -eq 1 ] && last_log | grep -q 'IDLE ledger .* unreadable; refusing to spend blind'; then
    pass "15 an unparseable ledger line refuses to spend (unknown spend is not zero spend)"
else fail "15 ledger fail-closed (calls=$(calls)): $(last_log)"; fi
rm -rf "$WORK"

# --- 16-18: an invalid outlook commits nothing ----------------------------------------------------
INVALID_OK=1
for case_ in "bad-url|not a source fetched ok this run" "emdash|contains an em-dash" \
             "guessed-time|does not match the fetched issue time" "crash|claude output is not JSON"; do
    mode=${case_%%|*}; why=${case_#*|}
    setup; STUB_MODE=$mode
    BASE=$(commits)
    run_steward
    if [ "$(calls)" -ne 1 ] || [ "$(commits)" -ne "$BASE" ] || [ -e "$REPO/data/outlook.json" ] \
       || ! ledger_field outcome | grep -q '^invalid$' || ! last_log | grep -qF "$why"; then
        INVALID_OK=0
        fail "16 ${mode}: an invalid outlook must not be committed: $(last_log)"
    fi
    if [ "$mode" = crash ]; then
        if [ "$(ledger_field cost_known)" = "False" ] && [ "$(ledger_field cost_usd)" = "1.0" ]; then
            pass "17 a run that leaves no JSON result is charged its full \$1 budget, not \$0"
        else fail "17 unknown cost charging: $(tail -1 "$WORK/ledger.jsonl")"; fi
        run_steward
        if [ "$(calls)" -eq 1 ] && last_log | grep -q 'quiet: last run failed 0m ago, retry after 120m'; then
            pass "18 a failed refresh waits 2h before retrying instead of spending every fire"
        else fail "18 retry backoff (calls=$(calls)): $(last_log)"; fi
    fi
    rm -rf "$WORK"
done
[ "$INVALID_OK" -eq 0 ] || pass "16 a URL that was not fetched, an em-dash, a guessed issue time or a crash each commit nothing, for that reason"

# --- 19-21: ALERT -------------------------------------------------------------------------------
setup; mk_crit 120
run_steward
ARGS=$(tr '\n' ' ' < "$STUB_DIR/args" 2>/dev/null)
A_OK=0
if [ "$(calls)" -eq 1 ] && printf '%s' "$ARGS" | grep -q -- '--model opus --max-budget-usd 2.50 --output-format json --strict-mcp-config --permission-mode bypassPermissions' \
   && [ "$(cat "$STUB_DIR/cwd")" = "$REPO" ] && grep -q 'ALERT freshness CRITICAL for 120m since' "$STUB_DIR/stdin" \
   && grep -q 'Steward ALERT run ended without posting a report' "$WORK/outbox.json" \
   && [ "$(ledger_field task)" = "ALERT" ] && grep -qE '^freshness [0-9]+$' "$REPO/data/.tick-gate-alert-state"; then
    A_OK=1
fi
run_steward
if [ "$A_OK" -eq 1 ] && [ "$(calls)" -eq 2 ] && grep -q 'RUN COLLATERAL' "$WORK/steward.log" \
   && last_log | grep -q 'DONE COLLATERAL committed'; then
    pass "19 a held CRITICAL runs one opus ALERT (claimed, reported even when the run was silent); the next fire moves on"
else fail "19 ALERT run (A_OK=$A_OK calls=$(calls)): $(cat "$WORK/steward.log")"; fi
rm -rf "$WORK"

setup; mk_crit 120
printf 'half-finished\n' >> "$REPO/data/app.txt"
run_steward
if grep -q 'skipped: alert freshness: tree has uncommitted changes' "$WORK/steward.log" \
   && ! grep -q 'RUN ALERT' "$WORK/steward.log" && [ ! -e "$REPO/data/.tick-gate-alert-state" ]; then
    pass "20 ALERT refuses to start a build on a tree with someone else's uncommitted edits, and does not burn its slot"
else fail "20 dirty-tree ALERT: $(cat "$WORK/steward.log")"; fi
rm -rf "$WORK"

setup; mk_crit 120
SINCE=$(date -u -d "@$(awk '{print $5}' "$WORK/monitor-state")" '+%Y-%m-%dT%H:%MZ')
python3 -I "$REPO/scripts/steward/steward.py" state-set --state "$WORK/state/state.json" alert "episode=freshness $SINCE" runs=3
run_steward
if ! grep -q 'RUN ALERT' "$WORK/steward.log" && grep -q 'alert freshness: 3 runs this episode, giving it to the owner' "$WORK/steward.log"; then
    pass "21 after 3 ALERT runs on one fault episode the steward stops spending on it"
else fail "21 episode cap: $(cat "$WORK/steward.log")"; fi
rm -rf "$WORK"

# --- 22-23: BACKLOG off by default; dry-run ---------------------------------------------------------
setup
run_steward
run_steward
B_OFF=0; [ "$(calls)" -eq 1 ] && ! grep -q 'BACKLOG' "$WORK/steward.log" && B_OFF=1
touch "$REPO/data/.steward-backlog-on"
run_steward
ARGS=$(tr '\n' ' ' < "$STUB_DIR/args" 2>/dev/null)
if [ "$B_OFF" -eq 1 ] && [ "$(calls)" -eq 2 ] && grep -q 'RUN BACKLOG' "$WORK/steward.log" \
   && printf '%s' "$ARGS" | grep -q -- '--max-budget-usd 5.00'; then
    pass "22 BACKLOG never runs without data/.steward-backlog-on, and runs on a granted slot with it"
else fail "22 backlog flag (B_OFF=$B_OFF calls=$(calls)): $(cat "$WORK/steward.log")"; fi
rm -rf "$WORK"

setup; mk_crit 120
run_steward --dry-run
if [ "$(calls)" -eq 0 ] && last_log | grep -q 'DRY-RUN would RUN ALERT' && [ ! -e "$REPO/data/.tick-gate-alert-state" ] \
   && [ ! -e "$WORK/state/state.json" ] && [ "$(ledger_n)" -eq 0 ]; then
    pass "23 --dry-run names the task it would run and calls, claims and records nothing"
else fail "23 dry-run (calls=$(calls)): $(cat "$WORK/steward.log")"; fi
rm -rf "$WORK"

# --- 24: one cycle lane, two copies (E5) -----------------------------------------------------------
S_LANE=$(grep -oP "^CYCLE_LANE='\\K[^']+" "$REPO_ROOT/scripts/steward.sh")
W_LANE=$(grep -oP "^CYCLE_LANE='\\K[^']+" "$REPO_ROOT/scripts/chat-watchdog.sh")
if [ -n "$S_LANE" ] && [ "$S_LANE" = "$W_LANE" ]; then
    pass "24 steward.sh and chat-watchdog.sh treat the same files as the data cycle's lane"
else fail "24 CYCLE_LANE differs between steward.sh and chat-watchdog.sh"; fi

# --- 25: the owner's spend view ----------------------------------------------------------------
WORK=$(mktemp -d)
{
    printf '{"ts":"%s","task":"COLLATERAL","cost_usd":0.13,"cost_known":true,"input_tokens":2,"cache_creation_tokens":23300,"output_tokens":3900}\n' "$(date -u -d '-2 hours' '+%Y-%m-%dT%H:%M:%SZ')"
    printf '{"ts":"%s","task":"ALERT","cost_usd":2.5,"cost_known":false}\n' "$(date -u -d '-3 hours' '+%Y-%m-%dT%H:%M:%SZ')"
    printf '{"ts":"%s","task":"COLLATERAL","cost_usd":0.2,"cost_known":true,"output_tokens":100}\n' "$(date -u -d '-50 hours' '+%Y-%m-%dT%H:%M:%SZ')"
} > "$WORK/ledger.jsonl"
TODAY=$(date -u -d '-2 hours' '+%Y-%m-%d'); OLDDAY=$(date -u -d '-50 hours' '+%Y-%m-%d')
RESPONDER_STEWARD_LEDGER="$WORK/ledger.jsonl" python3 -I "$REPO_ROOT/scripts/tick-burn.py" --steward --days 7 > "$WORK/burn.out"
OUT=$(cat "$WORK/burn.out")
RESPONDER_STEWARD_LEDGER="$WORK/absent.jsonl" python3 -I "$REPO_ROOT/scripts/tick-burn.py" --steward > /dev/null 2> "$WORK/burn.err"
MISSING_RC=$?
if printf '%s' "$OUT" | grep -q 'last 24h               \$2.63 of the \$8.00 cap' \
   && printf '%s' "$OUT" | grep -qE "^  ${OLDDAY} +COLLATERAL +1 +0.20 " \
   && printf '%s' "$OUT" | grep -qE "ALERT +1 +2.50 .*\(1 charged at budget\)" \
   && printf '%s' "$OUT" | grep -qE "COLLATERAL +1 +0.13 +23,302 +3,900" \
   && [ "$MISSING_RC" -eq 3 ] && grep -q 'UNKNOWN: steward ledger' "$WORK/burn.err"; then
    pass "25 tick-burn.py --steward shows spend per day and task against the cap, and UNKNOWN without a ledger"
else fail "25 steward spend summary (missing rc=$MISSING_RC): $OUT"; fi
rm -rf "$WORK"

# --- 26-27: a failed fetch must never become "no risk" (E1) ---------------------------------------
setup
printf '{"generated":"2026-01-01T00:00:00Z","old":true}\n' > "$REPO/data/outlook.json"
git -C "$REPO" add data/outlook.json && git -C "$REPO" commit -qm 'old outlook'
BASE=$(commits)
rm -f "$FX/wpc-ero"
run_steward --force-collateral
if [ "$(calls)" -eq 0 ] && [ "$(commits)" -eq "$BASE" ] && grep -q '"old":true' "$REPO/data/outlook.json" \
   && last_log | grep -q 'no-sources: wpc-ero not ok, no flood outlook to stand on' && [ "$(ledger_field outcome)" = "no-sources" ]; then
    pass "26 without the WPC excessive rainfall product the steward does not call claude and leaves the old outlook to expire"
else fail "26 required flood source (calls=$(calls)): $(last_log)"; fi
rm -rf "$WORK"

WORK=$(mktemp -d)
NOWI=$(date -u '+%Y-%m-%dT%H:%M:%SZ'); ISS=$(date -u -d '-2 hours' '+%Y-%m-%dT%H:%M:%SZ'); END=$(date -u -d '+10 hours' '+%Y-%m-%dT%H:%M:%SZ')
mk_manifest() {  # WPC_STATUS SPC_STATUS
    printf '{"fetchedAt":"%s","sources":[{"id":"wpc-ero","name":"NWS Weather Prediction Center","url":"https://www.wpc.ncep.noaa.gov/discussions/hpcdiscussions.php?disc=qpferd","status":"%s","issued":"%s"},{"id":"spc-d1","name":"NWS Storm Prediction Center","url":"https://www.spc.noaa.gov/products/outlook/day1otlk.html","status":"%s","issued":"%s"},{"id":"nhc-atlantic","name":"NWS National Hurricane Center","url":"https://www.nhc.noaa.gov/text/MIATWOAT.shtml","status":"ok","issued":"%s"}]}\n' \
        "$NOWI" "$1" "$ISS" "$2" "$ISS" "$ISS" > "$WORK/m.json"
}
mk_outlook() {  # HEADLINE_EN KIND URL BODY_EN
    printf '{"generated":"%s","validUntil":"%s","author":"steward","headline":{"en":"%s","es":"Pronostico para Texas."},"items":[{"id":"x-d1","kind":"%s","level":"none","title":{"en":"Quiet","es":"Tranquilo"},"body":{"en":"%s","es":"Sin cambios."},"window":{"start":"%s","end":"%s"},"source":{"name":"%s","url":"%s"},"issued":"%s"}]}\n' \
        "$NOWI" "$END" "$1" "$2" "$4" "$NOWI" "$END" "$5" "$3" "$ISS" > "$WORK/o.json"
}
chk() { python3 -I "$REPO_ROOT/scripts/steward/steward.py" check "$WORK/o.json" --manifest "$WORK/m.json" || :; }
NHC_URL=https://www.nhc.noaa.gov/text/MIATWOAT.shtml; SPC_URL=https://www.spc.noaa.gov/products/outlook/day1otlk.html
E1_OK=1
mk_manifest failed ok; mk_outlook "No flood or severe storm risk forecast for Texas through Wednesday" tropical "$NHC_URL" "Formation is not expected." "NWS National Hurricane Center"
chk | grep -q 'headline.en: claims no rain or flooding but wpc-ero was not fetched ok' || { E1_OK=0; fail "27a flood absence with wpc-ero failed: $(chk)"; }
mk_manifest ok failed; mk_outlook "Quiet week ahead for Texas" tropical "$NHC_URL" "Severe storms are not expected." "NWS National Hurricane Center"
chk | grep -q 'items\[0\].body.en: claims no severe storms but spc-d1 was not fetched ok' || { E1_OK=0; fail "27b severe absence with spc-d1 failed: $(chk)"; }
mk_manifest ok ok; mk_outlook "Quiet week ahead for Texas" rain "$SPC_URL" "Dry today." "NWS Storm Prediction Center"
chk | grep -q 'items\[0\]: a rain "none" must cite wpc-ero' || { E1_OK=0; fail "27c none item citing another hazard's product: $(chk)"; }
mk_outlook "Quiet week ahead for Texas" severe "$SPC_URL" "Severe storms are not expected. Updates at https://evil.example/tx" "NWS Storm Prediction Center"
chk | grep -q 'items\[0\].body.en: contains a link' || { E1_OK=0; fail "27d link in text: $(chk)"; }
mk_outlook "No flood or severe storm risk forecast for Texas through Wednesday" severe "$SPC_URL" "Severe storms are not expected." "NWS Storm Prediction Center"
chk | grep -q '^OK 1 items' || { E1_OK=0; fail "27e the same claims with both products ok must pass: $(chk)"; }
[ "$E1_OK" -eq 0 ] || pass "27 absence claimed for a hazard whose product failed, a mis-sourced none, or a link is rejected; backed claims pass"
rm -rf "$WORK"

# --- 28: quarantine undoes a staged new file, under the cycle lock --------------------------------
setup; mk_crit 120; STUB_MODE=stage-new
run_steward
QD=$(ls -d "$WORK/quarantine"/*.files 2>/dev/null | head -1)
QP=$(ls "$WORK/quarantine"/*.patch 2>/dev/null | head -1)
if [ -z "$(git -C "$REPO" status --porcelain --untracked-files=all -- scripts data/app.txt)" ] \
   && [ -n "$QP" ] && grep -q 'echo planted' "$QP" && grep -q 'half-finished' "$QP" \
   && [ -n "$QD" ] && grep -q 'echo planted' "$QD/scripts/new-tool.sh"; then
    pass "28 a staged new file and an edit left by an ALERT run are banked, unstaged and removed; the tree is HEAD again"
else fail "28 staged-new quarantine: $(git -C "$REPO" status --porcelain | tr '\n' ' ') $(cat "$WORK/steward.log")"; fi
rm -rf "$WORK"

setup; mk_crit 120; STUB_MODE=stage-new
( flock -n 5 && LOCK_WAIT=1 run_steward ) 5>"$WORK/cycle.lock"
if git -C "$REPO" diff --cached --name-only | grep -qx 'scripts/new-tool.sh' && grep -q 'cycle lock busy for 1s; leftovers stay in the tree' "$WORK/steward.log"; then
    pass "28b quarantine waits for the cycle lock and, when it cannot get it, leaves the tree rather than racing a cycle commit"
else fail "28b quarantine lock: $(cat "$WORK/steward.log")"; fi
rm -rf "$WORK"

# --- 29: one build session at a time -------------------------------------------------------------
setup; mk_crit 120
run_steward
run_steward
touch "$REPO/data/.steward-backlog-on"; rm -f "$WORK/monitor-state"
run_steward
SEEN=$(tr '\n' ' ' < "$STUB_DIR/wdlock" 2>/dev/null)
if [ "$SEEN" = "held free held " ] && grep -q 'RUN ALERT' "$WORK/steward.log" && grep -q 'RUN COLLATERAL' "$WORK/steward.log" \
   && grep -q 'RUN BACKLOG' "$WORK/steward.log"; then
    pass "29 the watchdog lock is held through ALERT and BACKLOG runs (the watchdog skips) and left free for COLLATERAL"
else fail "29 watchdog lock during runs (ALERT, COLLATERAL, BACKLOG saw: '$SEEN'): $(cat "$WORK/steward.log")"; fi
rm -rf "$WORK"

# --- 30: no outward channels from a headless run ---------------------------------------------------
setup; mk_crit 120
run_steward; cp "$STUB_DIR/stdin" "$WORK/stdin.alert"
run_steward
touch "$REPO/data/.steward-backlog-on"; rm -f "$WORK/monitor-state"
run_steward; cp "$STUB_DIR/stdin" "$WORK/stdin.backlog"
MCP_OK=$(python3 -I - "$STUB_DIR/calllog" <<'PY'
import sys
calls = [c.strip("\n").split("\n") for c in open(sys.argv[1]).read().split("----\n") if c.strip()]
ok = len(calls) == 3 and all(c[0] == "false" and "--strict-mcp-config" in c for c in calls)
inbox = "must not read or act on data/chat-inbox.jsonl"
for c in (calls[0], calls[2]):
    ok = ok and "--append-system-prompt" in c and inbox in c[c.index("--append-system-prompt") + 1]
ok = ok and not any("--append-system-prompt" in c for c in calls[1:2])
print("yes" if ok else "no: %r" % calls)
PY
)
if [ "$MCP_OK" = "yes" ] && grep -q 'must not read or act on data/chat-inbox.jsonl' "$WORK/stdin.alert" \
   && grep -q 'must not read or act on data/chat-inbox.jsonl' "$WORK/stdin.backlog" && ! grep -qi 'ops-chat reply' "$WORK/stdin.backlog"; then
    pass "30 ALERT, COLLATERAL and BACKLOG all run with --strict-mcp-config and ENABLE_CLAUDEAI_MCP_SERVERS=false; build runs carry the inbox ban"
else fail "30 outward channels: $MCP_OK"; fi
rm -rf "$WORK"

# --- 31-33: spend is on the books before the run starts ---------------------------------------------
setup
run_steward
AFTER=$(python3 -I "$REPO/scripts/steward/steward.py" ledger-spent --ledger "$WORK/ledger.jsonl")
if [ "$(cat "$STUB_DIR/spent-during" 2>/dev/null)" = "1.0000" ] && [ "$AFTER" = "0.1234" ] && [ "$(ledger_n)" -eq 2 ] \
   && head -n 1 "$WORK/ledger.jsonl" | grep -q '"kind": "reserve"' && [ "$(ledger_field kind)" = "settle" ]; then
    pass "31 the \$1 cap is charged before claude starts (a killed run stays charged) and settles to the real cost after"
else fail "31 reserve/settle (during=$(cat "$STUB_DIR/spent-during" 2>/dev/null) after=$AFTER): $(cat "$WORK/ledger.jsonl")"; fi
rm -rf "$WORK"

setup
printf 'not a dir\n' > "$WORK/blocker"
LEDGER_AT="$WORK/blocker/ledger.jsonl" run_steward
if [ "$(calls)" -eq 0 ] && last_log | grep -q 'not writable; refusing to spend unrecorded'; then
    pass "32 a ledger that cannot be written refuses the run instead of spending unrecorded"
else fail "32 unwritable ledger (calls=$(calls)): $(last_log)"; fi
rm -rf "$WORK"

setup
run_steward
mv "$WORK/ledger.jsonl" "$WORK/ledger.moved"
run_steward --force-collateral
if [ "$(calls)" -eq 1 ] && last_log | grep -q 'vanished since the last run; refusing to spend blind'; then
    pass "33 a ledger that vanished after it was seen refuses spending (a missing ledger is not \$0)"
else fail "33 vanished ledger (calls=$(calls)): $(last_log)"; fi
rm -rf "$WORK"

# --- 34-35: the product's horizon bounds what an item may claim ---------------------------------------
WORK=$(mktemp -d)
NOWI=$(date -u '+%Y-%m-%dT%H:%M:%SZ'); ISS=$(date -u -d '-20 hours' '+%Y-%m-%dT%H:%M:%SZ')
printf '{"fetchedAt":"%s","sources":[{"id":"spc-d1","name":"NWS Storm Prediction Center","url":"https://www.spc.noaa.gov/products/outlook/day1otlk.html","status":"ok","issued":"%s"}]}\n' "$NOWI" "$ISS" > "$WORK/m.json"
mk_h() {  # WINDOW_END VALID_UNTIL
    printf '{"generated":"%s","validUntil":"%s","author":"steward","headline":{"en":"Quiet day for Texas.","es":"Dia tranquilo para Texas."},"items":[{"id":"spc-d1","kind":"severe","level":"none","title":{"en":"Quiet","es":"Tranquilo"},"body":{"en":"Severe storms are not expected today.","es":"No se esperan tormentas severas hoy."},"window":{"start":"%s","end":"%s"},"source":{"name":"NWS Storm Prediction Center","url":"https://www.spc.noaa.gov/products/outlook/day1otlk.html"},"issued":"%s"}]}\n' \
        "$NOWI" "$2" "$ISS" "$1" "$ISS" > "$WORK/o.json"
}
hchk() { python3 -I "$REPO_ROOT/scripts/steward/steward.py" check "$WORK/o.json" --manifest "$WORK/m.json" || :; }
mk_h "$(date -u -d '+15 days -1 hour' '+%Y-%m-%dT%H:%M:%SZ')" "$(date -u -d '+10 hours' '+%Y-%m-%dT%H:%M:%SZ')"
H1=$(hchk)
mk_h "$(date -u -d '+8 hours' '+%Y-%m-%dT%H:%M:%SZ')" "$(date -u -d '+10 hours' '+%Y-%m-%dT%H:%M:%SZ')"
H2=$(hchk)
mk_h "$(date -u -d '+8 hours' '+%Y-%m-%dT%H:%M:%SZ')" "$(date -u -d '+8 hours' '+%Y-%m-%dT%H:%M:%SZ')"
H3=$(hchk)
if printf '%s' "$H1" | grep -q "items\[0\].window: ends .* past spc-d1's 30h horizon" \
   && printf '%s' "$H2" | grep -q 'validUntil: after the earliest "none" window end' && [ "$H3" = "OK 1 items" ]; then
    pass "34 a 20h-old Day 1 'none' cannot run 15 days, and validUntil may not outlive a 'none' item"
else fail "34 horizon: '$H1' | '$H2' | '$H3'"; fi
rm -rf "$WORK"

setup; STUB_MODE=short-none
run_steward
LEFT=$(python3 -c 'import json,sys,datetime as t; d=json.load(open(sys.argv[1])); f=lambda s:t.datetime.fromisoformat(s.replace("Z","+00:00")); print(int((f(d["validUntil"])-f(d["generated"])).total_seconds()))' "$REPO/data/outlook.json" 2>/dev/null)
if [ -n "$LEFT" ] && [ "$LEFT" -ge 17880 ] && [ "$LEFT" -le 18000 ]; then
    pass "35 a 'none' item ending in 5h caps validUntil at 5h instead of the 15h quiet TTL"
else fail "35 validUntil cap (validUntil - generated = ${LEFT:-none}s): $(last_log)"; fi
rm -rf "$WORK"

# --- 36: nominal issuance labels a little ahead of the clock -------------------------------------------
setup
AHEAD_FILLER="Tropical cyclone formation is not expected during the next 7 days. Forecaster text padding to look real."
printf '<html><pre>\nDay 1 Convective Outlook\nNWS Storm Prediction Center Norman OK\n%s\n\n%s %s %s\n</pre></html>\n' \
    "$(date -u -d '+49 min' '+%I%M %p UTC %a %b %d %Y')" "$AHEAD_FILLER" "$AHEAD_FILLER" "$AHEAD_FILLER" > "$FX/spc-d1"
RESPONDER_STEWARD_FETCH_DIR="$FX" python3 -I "$REPO/scripts/steward/steward.py" fetch --out "$WORK/f1" > /dev/null
ROW=$(python3 -c 'import json,sys; r=[s for s in json.load(open(sys.argv[1]))["sources"] if s["id"]=="spc-d1"][0]; print(r["status"], r["issued"])' "$WORK/f1/manifest.json")
ISS=${ROW#* }
NOWI=$(date -u '+%Y-%m-%dT%H:%M:%SZ'); END=$(date -u -d '+30 hours' '+%Y-%m-%dT%H:%M:%SZ'); UNTIL=$(date -u -d '+10 hours' '+%Y-%m-%dT%H:%M:%SZ')
printf '{"generated":"%s","validUntil":"%s","author":"steward","headline":{"en":"Quiet day for Texas.","es":"Dia tranquilo para Texas."},"items":[{"id":"spc-d1","kind":"severe","level":"none","title":{"en":"Quiet","es":"Tranquilo"},"body":{"en":"Severe storms are not expected today.","es":"No se esperan tormentas severas hoy."},"window":{"start":"%s","end":"%s"},"source":{"name":"NWS Storm Prediction Center","url":"https://www.spc.noaa.gov/products/outlook/day1otlk.html"},"issued":"%s"}]}\n' \
    "$NOWI" "$UNTIL" "$NOWI" "$END" "$ISS" > "$WORK/o.json"
CHK=$(python3 -I "$REPO/scripts/steward/steward.py" check "$WORK/o.json" --manifest "$WORK/f1/manifest.json" || :)
printf '<html><pre>\nDay 1 Convective Outlook\nNWS Storm Prediction Center Norman OK\n%s\n\n%s %s %s\n</pre></html>\n' \
    "$(date -u -d '+3 hours' '+%I%M %p UTC %a %b %d %Y')" "$AHEAD_FILLER" "$AHEAD_FILLER" "$AHEAD_FILLER" > "$FX/spc-d1"
RESPONDER_STEWARD_FETCH_DIR="$FX" python3 -I "$REPO/scripts/steward/steward.py" fetch --out "$WORK/f2" > /dev/null
ROW2=$(python3 -c 'import json,sys; r=[s for s in json.load(open(sys.argv[1]))["sources"] if s["id"]=="spc-d1"][0]; print(r["status"], r["reason"])' "$WORK/f2/manifest.json")
if [ "${ROW%% *}" = "ok" ] && [ "$ISS" = "$(date -u -d "@$(( $(date -u -d "$ISS" +%s) ))" '+%Y-%m-%dT%H:%M:%SZ')" ] \
   && [ "$(date -u -d "$ISS" +%s)" -gt "$(date -u +%s)" ] && [ "$CHK" = "OK 1 items" ] \
   && [ "$ROW2" = "failed issue time is in the future" ]; then
    pass "36 a label 49m ahead is current, keeps its nominal time and validates; 3h ahead is still refused"
else fail "36 nominal early issuance: fetch '$ROW' | check '$CHK' | 3h '$ROW2'"; fi
rm -rf "$WORK"

echo "----"
if [ "$FAILS" -eq 0 ]; then
    echo "ALL STEWARD TESTS PASSED"
    exit 0
fi
echo "${FAILS} TEST(S) FAILED"
exit 1
