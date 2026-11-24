#!/bin/bash
# run-cycle.sh [--dry-run] [--allow-dirty-code] [--now] — durable data-refresh cycle, fired every 15 min.
# Every fire refreshes the gauge snapshot and runs scripts/weather-mode.py; the rest of the cycle
# runs only when the cadence says a publish is due (--now forces it). See scripts/README.md "Cadence".
# Fetch NWPS snapshot, regenerate roads/history/crest/notices/feeds/shelters/
# caltopo, validate, then (unless --dry-run) commit the data files by name and
# hand off to deploy.sh, which gates HEAD before it pushes or uploads anything.
# flock-serialized, idempotent, safe when nothing changed.
#
# The pipeline CODE is read from HEAD, the DATA is the working tree's. See
# scripts/README.md "The cycle runs committed code".
#
# One failing source does not stop the publish: generators are non-fatal and
# the cycle ships whatever refreshed. See scripts/README.md "Partial publish".
# Each generator runs under a time budget, under an aggregate budget over all of
# them; a step that outruns its budget is killed and counts as a failed one.
# Exit: 0 clean or lock-skip, 1 nothing refreshed / fatal, 2 bad argument,
#       3 published but degraded, or deploy.sh's own code if deploy failed.
set -euo pipefail

DRY_RUN=0
ALLOW_DIRTY_CODE=0
NOW_FLAG=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --allow-dirty-code) ALLOW_DIRTY_CODE=1 ;;
        --now) NOW_FLAG=1 ;;
        *) echo "FAIL: unknown argument: $arg (supported: --dry-run, --allow-dirty-code, --now)" >&2; exit 2 ;;
    esac
done

SCRIPT_DIR=$(cd "$(command dirname "$0")" && pwd) || exit 1
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd) || exit 1
cd "$REPO_ROOT" || exit 1

# cron runs with a minimal PATH (/usr/bin:/bin) that omits /usr/local/bin where
# wrangler lives — prepend the standard dirs so deploy.sh finds it (and node/git/
# ansible-vault) the same way an interactive shell does.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

# --- durable logging: tee all output (this script + every subprocess) to the log ---
LOGFILE="${RESPONDER_CYCLE_LOG:-/var/log/responder-cycle.log}"
if ! ( : >> "$LOGFILE" ) 2>/dev/null; then  # probe: /var/log may be unwritable for non-root cron
    LOGFILE=/tmp/responder-cycle.log
fi
exec > >(command tee -a "$LOGFILE") 2>&1

# The status file freshness-monitor.sh reads to tell a failing cycle from a dead cron.
CYCLE_STATUS="${RESPONDER_CYCLE_STATUS:-/var/log/responder-cycle-status.json}"
if ! [ -w "$(command dirname "$CYCLE_STATUS")" ]; then  # probe: /var/log may be unwritable for non-root cron
    CYCLE_STATUS=/tmp/responder-cycle-status.json
fi
STAGE=start
FIRST_ERROR=""
LAST_LOGGED=""

log() {
    printf '%s %s\n' "$(command date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
    case "$*" in
        ERROR:*) [ -n "$FIRST_ERROR" ] || FIRST_ERROR="$*" ;;
        *) : ;;
    esac
    LAST_LOGGED="$*"
}
# $LINENO, not ${BASH_LINENO[0]}: for a top-level command the latter is the caller frame, which is
# empty at top level, so every real failure logged the useless "near line 0"
trap 'log "ERROR: cycle failed (exit $?) near line ${LINENO}"' ERR

# --- per-source bookkeeping: one failing upstream must not block publishing the rest ---
STEPS_OK=()
STEPS_FAILED=()
STEPS_SKIPPED=()
STEPS_TIMEOUT=()
STEPS_PARTIAL=()

# --- step budgets: a hung generator must not eat the 15-minute window -------------------------
# The cycle holds a non-blocking flock, so a run that outlives its window makes the NEXT cycle
# log SKIP: an overrun stops the board publishing for as long as it lasts. Numbers are sized from
# the logged per-step distribution, not guessed; tests/run-cycle.test.sh asserts the headroom and
# the window arithmetic so a future edit cannot quietly tighten a budget onto a legitimate run.
BUDGET_SNAPSHOT_S=150
BUDGET_ROADS_S=150
BUDGET_HISTORY_S=540
BUDGET_NOTICES_S=60
BUDGET_SHELTERS_S=150
BUDGET_CROSSSTATUS_S=120
BUDGET_WILDFIRE_S=90
BUDGET_ROADFLOOD_S=60
BUDGET_CREST_S=120
BUDGET_FEEDS_S=150
BUDGET_CALTOPO_S=120
BUDGET_CHANGES_S=60
BUDGET_CADENCE_S=60
# Per-step budgets alone cannot bound the cycle: they sum past the window. This is the aggregate
# guard, and it leaves room for the publish path (cycle-check, commit, deploy's own test gate,
# push, upload, smoke) to finish. Trimmed from 660s when that gate widened to the python and shell
# suites; tests/run-cycle.test.sh asserts this against the publish reserve and the cron interval.
CYCLE_BUDGET_S="${RESPONDER_CYCLE_BUDGET_S:-540}"  # + the probe's BUDGET_CADENCE_S, outside this clock
# The publish reserve, enforced rather than assumed: deploy.sh's own retry ladders are unbounded and
# it runs holding the cycle lock, so an overrun costs several cycles instead of one. Killed here the
# data stays committed locally and the next cycle republishes. tests/run-cycle.test.sh reads this.
PUBLISH_BUDGET_S="${RESPONDER_PUBLISH_BUDGET_S:-300}"
STEP_BUDGET_OVERRIDE="${RESPONDER_STEP_BUDGET_S:-}"  # operational escape hatch; also how the suite forces a timeout
KILL_GRACE_S=20   # SIGTERM, then SIGKILL: long enough for a generator to drop its temp file
MIN_STEP_S=5      # never hand `timeout` a budget of 0 — GNU timeout reads 0 as "no timeout"

# PIPE_ROOT is the tree the cycle's own code is read from; the data always lives in REPO_ROOT
PIPE_ROOT="$REPO_ROOT"
CODE_TMP=""
STEP_OUT=""  # tee copy of a gate step's output, so its first FAIL line can name the cause
ADVISORIES_OUT=""  # every data-lane advisory WARN this run, for the status file

# gen LABEL SCRIPT KEEP BUDGET_S — run one generator under a time budget, record the outcome,
# return its real status. A failed OR timed-out generator leaves its previous output untouched, so
# that file keeps its own older "generated" stamp and the board's freshness/aging/suppression
# machinery marks it stale by itself. Every generator writes its output atomically, which is what
# makes "killed" and "failed" the same fact on disk rather than a half-written file.
# A timeout is bucketed apart from a failure on purpose: an upstream being down and a budget being
# too tight both stale the same source, and only the log tells them apart.
gen() {
    local label=$1 script=$2 keep=$3 budget=$4
    local now remaining effective rc=0
    if [ -n "$STEP_BUDGET_OVERRIDE" ]; then budget="$STEP_BUDGET_OVERRIDE"; fi
    now=$(command date +%s)
    remaining=$(( GEN_DEADLINE - now ))
    if [ "$remaining" -lt "$MIN_STEP_S" ]; then
        STEPS_TIMEOUT+=("$label")
        log "TIMEOUT: ${script} not started; the ${CYCLE_BUDGET_S}s cycle generator budget is spent. Keeping previous ${keep} and its older stamp"
        return 1
    fi
    effective="$budget"
    if [ "$remaining" -lt "$effective" ]; then
        effective="$remaining"
        log "step: ${script} (budget ${effective}s, squeezed from ${budget}s by the cycle deadline)"
    else
        log "step: ${script} (budget ${effective}s)"
    fi
    command timeout -k "$KILL_GRACE_S" "$effective" python3 "${PIPE_ROOT}/scripts/${script}" || rc=$?
    if [ "$rc" -eq 0 ]; then
        STEPS_OK+=("$label")
        return 0
    fi
    if [ "$rc" -eq 3 ]; then  # written, degraded: the output is new, but some input could not be checked
        STEPS_PARTIAL+=("$label")
        log "WARN: ${script} wrote ${keep} but reported a degraded read (exit 3); its own lines above name what it could not check"
        return 0
    fi
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then  # timeout's own code, and SIGKILL after the grace period
        STEPS_TIMEOUT+=("$label")
        log "TIMEOUT: ${script} exceeded ${effective}s and was killed; keeping previous ${keep} and its older stamp"
        return 1
    fi
    STEPS_FAILED+=("$label")
    log "WARN: ${script} failed (non-fatal); keeping previous ${keep} and its older stamp"
    return 1
}

# skip LABEL SCRIPT REASON — a generator DERIVED from a source that did not refresh must not run:
# it would rewrite unchanged, stale numbers under a brand-new "generated" stamp, which is exactly
# publishing stale data as fresh. Leaving the previous file alone keeps its stamp truthful.
skip() {
    STEPS_SKIPPED+=("$1")
    log "SKIP: $2 not run ($3); keeping previous output and its older stamp"
}

# first_fail: the first "FAIL: " line the last captured gate step printed, empty if none
first_fail() {
    [ -n "$STEP_OUT" ] && [ -f "$STEP_OUT" ] || return 0
    grep -m1 '^FAIL: ' "$STEP_OUT" || :  # no FAIL line is an answer too: the caller keeps its own
}

# collect_advisories: keep the data-lane advisory WARN lines the last gate step printed
collect_advisories() {
    [ -n "$ADVISORIES_OUT" ] && [ -f "$STEP_OUT" ] || return 0
    grep -E '^WARN: .*data lane' "$STEP_OUT" >> "$ADVISORIES_OUT" || :  # a run with no advisory adds nothing
}

# git_reason GIT_OUTPUT — git's own fatal/error line out of its stderr, else its last line.
git_reason() {
    local line
    line=$(printf '%s\n' "$1" | grep -m1 -E '^(fatal|error):') \
        || line=$(printf '%s\n' "$1" | grep -v '^[[:space:]]*$' | command tail -1) \
        || line=''
    printf '%s' "${line:-git printed no reason}"
}

# write_cycle_status RC — record this run for freshness-monitor.sh; see scripts/README.md "Cycle status file".
# shellcheck disable=SC2317  # reached only via the EXIT trap set below
write_cycle_status() {
    local tmp
    tmp=$(command mktemp "${CYCLE_STATUS}.XXXXXX") || return 1
    if CS_PREV="$CYCLE_STATUS" CS_RC="$1" CS_STAGE="$STAGE" CS_ERROR="${FIRST_ERROR:-$LAST_LOGGED}" CS_ADVISORIES="$ADVISORIES_OUT" \
        python3 - > "$tmp" <<'PY'
import json, os, sys, time
now = int(time.time())
stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
rc = int(os.environ["CS_RC"])
try:
    with open(os.environ["CS_PREV"], encoding="utf-8") as f:
        prev = json.load(f)
    prev_fails = max(0, int(prev.get("consecutive_failures") or 0))
    prev_since = prev.get("failing_since")
    prev_adv, prev_adv_since = prev.get("advisories") or [], prev.get("advisories_since")
except (OSError, ValueError, TypeError, AttributeError):
    prev_fails, prev_since, prev_adv, prev_adv_since = 0, None, [], None
advisories = []
try:
    with open(os.environ.get("CS_ADVISORIES") or "/nonexistent", encoding="utf-8") as f:
        for line in f:
            line = " ".join(line.split())[:300]
            if line and line not in advisories:
                advisories.append(line)
except OSError:
    pass
advisories = advisories[:10]
adv_since = None
if advisories:
    adv_since = prev_adv_since if prev_adv and isinstance(prev_adv_since, str) and prev_adv_since else stamp
if rc in (0, 3):
    fails, since, err = 0, None, None
else:
    fails = prev_fails + 1
    since = prev_since if prev_fails > 0 and isinstance(prev_since, str) and prev_since else stamp
    err = " ".join(os.environ.get("CS_ERROR", "").split())[:400] or None
json.dump({"finished_at": stamp, "finished_epoch": now, "exit_code": rc,
           "stage": os.environ.get("CS_STAGE") or None, "first_error": err,
           "consecutive_failures": fails, "failing_since": since,
           "advisories": advisories, "advisories_since": adv_since}, sys.stdout, indent=2)
print()
PY
    then
        command mv -f "$tmp" "$CYCLE_STATUS"
    else
        command rm -f "$tmp"
        return 1
    fi
}

# shellcheck disable=SC2317  # reached only via the EXIT trap set below
on_exit() {
    local rc=$?
    set +e  # cleanup must never replace the cycle's own exit code
    if [ "$STAGE" != skip ] && [ "$STAGE" != hold ] && [ "$DRY_RUN" -eq 0 ]; then
        write_cycle_status "$rc" || log "WARN: could not write the cycle status file ${CYCLE_STATUS}"
    fi
    if [ -n "$STEP_OUT" ]; then command rm -f "$STEP_OUT"; fi
    if [ -n "$ADVISORIES_OUT" ]; then command rm -f "$ADVISORIES_OUT"; fi
    if [ -n "$CODE_TMP" ]; then
        cd "$REPO_ROOT" || exit "$rc"
        git worktree remove --force "$CODE_TMP" >/dev/null 2>&1 || command rm -rf "$CODE_TMP"  # remove is the clean path; rm covers a half-created worktree
        git worktree prune >/dev/null 2>&1 || :  # a stale admin entry is cosmetic, never worth failing a cycle over
    fi
    exit "$rc"
}
trap on_exit EXIT

# degraded_now: DEGRADED is a fact about every step bucket, recomputed at sign-off
degraded_now() {
    if [ "${#STEPS_FAILED[@]}" -gt 0 ] || [ "${#STEPS_SKIPPED[@]}" -gt 0 ] || [ "${#STEPS_TIMEOUT[@]}" -gt 0 ] \
       || [ "${#STEPS_PARTIAL[@]}" -gt 0 ]; then
        DEGRADED=1
    fi
}

# cycle_end MSG — the ONE exit point for every publishing path, so a partially-degraded cycle can
# never sign off as a clean success. Exit 3 = published what refreshed, some sources did not.
cycle_end() {
    STAGE=signoff
    if [ "$GATE_KIND" = full ] && [ "$DRY_RUN" -eq 0 ] && [ "$DETECTOR_OK" -eq 1 ]; then
        python3 "$DETECTOR" --mark-published "$FIRE_ISO" \
            || log "WARN: could not record this publish in the cadence state; the next fire runs the full cycle again"
    fi
    degraded_now
    if [ "$DEGRADED" -eq 1 ]; then
        log "=== $1 (DEGRADED) === refreshed: ${STEPS_OK[*]:-none} | failed: ${STEPS_FAILED[*]:-none} | timed out: ${STEPS_TIMEOUT[*]:-none} | skipped: ${STEPS_SKIPPED[*]:-none}${STEPS_PARTIAL[*]:+ | partial: ${STEPS_PARTIAL[*]}}"
        exit 3
    fi
    log "=== $1 ==="
    exit 0
}

# deploy.sh is the gate AND the publisher: it runs node, the python suites, the shell suites and
# cycle-check.sh at HEAD, and only then pushes and uploads. The cycle used to push here first, so a
# red gate still put the commit on origin. The commit above must still precede it, because the
# artifact deploy.sh builds is `git archive HEAD` and unpublished data would otherwise ship; a
# local commit is not a publish, and nothing reaches origin or the mirror until the gate is green.
publish_head() {
    STAGE=deploy
    log "step: deploy.sh (gate HEAD + git push + CF Pages deploy + smoke, budget ${PUBLISH_BUDGET_S}s)"
    : > "$STEP_OUT"
    if command timeout -k "$KILL_GRACE_S" "$PUBLISH_BUDGET_S" bash "${PIPE_ROOT}/scripts/deploy.sh" --data-lane 2>&1 \
        | command tee "$STEP_OUT"; then
        collect_advisories
        log "deploy OK"
    else
        rc=$?
        collect_advisories
        cause=$(first_fail)
        if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
            log "TIMEOUT: deploy.sh outran its ${PUBLISH_BUDGET_S}s publish budget and was killed; the data is committed locally and NOT pushed. Next cycle re-gates and republishes"
            [ -z "$cause" ] || FIRST_ERROR="deploy.sh timed out after ${PUBLISH_BUDGET_S}s; first ${cause}"
        else
            log "WARN: deploy.sh failed (exit ${rc}); the data is committed locally and NOT pushed. Next cycle re-gates and republishes"
            [ -z "$cause" ] || FIRST_ERROR="deploy.sh failed (exit ${rc}); first ${cause}"
        fi
        exit "$rc"
    fi

    # best-effort push-evaluator nudge (fast path; the Worker's */5 cron is the guaranteed path).
    # HMAC over the raw body with the shared key; NEVER fatal — push infra must not break the cycle.
    STAGE=nudge
    NUDGE_KEY_FILE=/root/.config/responder/push-nudge-key
    if [ -s "$NUDGE_KEY_FILE" ]; then
        log "step: push nudge (best-effort)"
        if nudge_out=$(
            key=$(command cat "$NUDGE_KEY_FILE") &&
            body="{\"ts\":$(command date +%s)}" &&
            sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$key" | awk '{print $NF}') &&
            curl -sf -m 20 -X POST -H 'Content-Type: application/json' -H "X-Push-Sig: ${sig}" \
                -d "$body" https://respondertx.org/api/push/nudge
        ); then
            log "push nudge OK: ${nudge_out}"
        else
            log "WARN: push nudge failed (non-fatal); the */5 worker cron covers it"
        fi
    fi
}

# --- lock: one cycle at a time (session refresh + system cron share this file) ---
LOCKFILE="${RESPONDER_CYCLE_LOCK:-/tmp/responder-cycle.lock}"
DEGRADED=0
STAGE=lock
exec 9>"$LOCKFILE"
if ! flock -n 9; then
    STAGE=skip  # a skip is not a run; the holder records its own status when it finishes
    log "SKIP: another cycle holds $LOCKFILE"
    exit 0
fi
STAGE=materialize

log "=== cycle start (dry_run=${DRY_RUN}) repo=${REPO_ROOT} ==="
FIRE_ISO=$(command date -u '+%Y-%m-%dT%H:%M:%SZ')
GATE_KIND=full
DETECTOR_OK=0
STEP_OUT=$(command mktemp "${TMPDIR:-/tmp}/responder-step.XXXXXX") || { log "ERROR: mktemp for the gate capture failed"; exit 1; }
ADVISORIES_OUT=$(command mktemp "${TMPDIR:-/tmp}/responder-advisories.XXXXXX") || ADVISORIES_OUT=""  # without it the status file just lists none

# --- Materialize HEAD's pipeline. This runs from cron every 15 minutes against a working tree an
# agent may be mid-edit in, so executing the tree's generators publishes half-finished code as
# production data; that happened three times in one night. Same fix as deploy.sh in v0.97.85: check
# HEAD out to a throwaway worktree and run from there. Only scripts/ is materialized, because that
# is the only code the cycle executes and a generator that ignored RESPONDER_ROOT would then fail
# loudly on a missing data/ instead of quietly writing into a tree nobody publishes.
if [ "$ALLOW_DIRTY_CODE" -eq 1 ]; then
    log "##########################################################"
    log "# WARNING: --allow-dirty-code set: THIS CYCLE RUNS THE"
    log "# WORKING-TREE PIPELINE. Uncommitted scripts/ code will"
    log "# generate, validate and COMMIT production data."
    log "# This flag is for genuine field emergencies only."
    log "##########################################################"
else
    dirty_scripts=$(git status --porcelain --untracked-files=all -- scripts/) || dirty_scripts=''
    CODE_TMP=$(command mktemp -d "${TMPDIR:-/tmp}/responder-pipeline.XXXXXX") || { log "ERROR: mktemp for the HEAD pipeline failed"; exit 1; }
    # git's output is held back on success (progress chatter every 15 minutes) and quoted on failure
    mat_err=""
    if ! mat_err=$(git worktree add --detach --no-checkout "$CODE_TMP" HEAD 2>&1 >/dev/null) \
       || ! mat_err=$(git -C "$CODE_TMP" checkout HEAD -- scripts 2>&1); then
        [ -z "$mat_err" ] || printf '%s\n' "$mat_err"
        log "ERROR: could not materialize HEAD scripts/ at ${CODE_TMP}: $(git_reason "$mat_err") (--allow-dirty-code runs the working tree instead)"
        exit 1
    fi
    PIPE_ROOT="$CODE_TMP"
    for entry in cycle-check.sh deploy.sh; do
        [ -f "${PIPE_ROOT}/scripts/${entry}" ] || { log "ERROR: HEAD pipeline is missing scripts/${entry}"; exit 1; }
    done
    log "pipeline: HEAD $(git rev-parse --short HEAD) materialized at ${CODE_TMP}"
    if [ -n "$dirty_scripts" ]; then
        log "NOTE: scripts/ has uncommitted changes; this cycle runs HEAD instead. Commit the pipeline work, or pass --allow-dirty-code to run it:"
        printf '%s\n' "$dirty_scripts"
    fi
fi

# The code comes from HEAD; the DATA does not. Every generator resolves its paths through
# RESPONDER_ROOT, so they read the live data/event.json and write data/, history/, feed.xml and
# crests.ics into the real repo, which is what this cycle stages and commits. Re-targeting a live
# event stays an edit to a data file, never a release.
export RESPONDER_ROOT="$REPO_ROOT"

# ...which makes an uncommitted data/event.json a split brain rather than a re-target: these
# generators read the working-tree copy, deploy.sh ships `git archive HEAD`. Warned every cycle,
# never fatal, because failing here would stop a flood publish over a config edit (CLAUDE.md E2/E3).
dirty_event=$(git status --porcelain --untracked-files=all -- data/event.json) || dirty_event=''
if [ -n "$dirty_event" ]; then
    log "##########################################################"
    log "# WARNING: data/event.json does not match HEAD."
    log "# These generators use the WORKING-TREE copy; the artifact"
    log "# deploy.sh ships carries HEAD's, so the board's map centre,"
    log "# AO pills, gaugeBbox, zoom and tideStations are NOT the ones"
    log "# this data is being generated against."
    log "# Commit data/event.json: that is what makes a re-target real."
    log "##########################################################"
    printf '%s\n' "$dirty_event"
    git --no-pager diff --unified=0 -- data/event.json || :  # an untracked file has no diff; the status line above already named it
fi

STAGE=generators
# the aggregate clock starts at the first generator, not at cycle start: materializing the HEAD
# worktree is bounded work that must not eat a data source's budget
GEN_START=$(command date +%s)
GEN_DEADLINE=$(( GEN_START + CYCLE_BUDGET_S ))
log "generator budget: ${CYCLE_BUDGET_S}s total"

if gen snapshot fetch-snapshot.py data/gauges-snapshot.json "$BUDGET_SNAPSHOT_S"; then SNAPSHOT_FRESH=1; else SNAPSHOT_FRESH=0; fi
SNAPSHOT_S=$(( $(command date +%s) - GEN_START ))

# --- cadence gate. The snapshot above is the detector's gauge input, so it runs every fire and stays
# uncommitted on a hold. A detector that is missing or broken never holds a publish.
STAGE=cadence
GATE_REASON="no cadence verdict"
DETECTOR="${PIPE_ROOT}/scripts/weather-mode.py"
if [ ! -f "$DETECTOR" ]; then
    log "WARN: scripts/weather-mode.py is not in the HEAD pipeline; running the full cycle"
elif ! command timeout -k "$KILL_GRACE_S" "$BUDGET_CADENCE_S" python3 "$DETECTOR"; then
    log "WARN: weather-mode.py did not finish its probe; running the full cycle and withdrawing data/cadence.json"
else
    DETECTOR_OK=1
    ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null) || ahead=-1  # E1: a failed read is not "0 ahead"
    case "$ahead" in ''|*[!0-9-]*) ahead=-1 ;; esac
    foreign=$(git log --format=%s origin/main..HEAD 2>/dev/null | grep -cv '^Data refresh ') || foreign=0
    if verdict=$(python3 "$DETECTOR" --due --status "$CYCLE_STATUS" --ahead "${ahead:-0}" --foreign "${foreign:-0}"); then
        GATE_KIND=${verdict%% *}
        GATE_REASON=${verdict#* }
    else
        log "WARN: weather-mode.py --due failed; running the full cycle"
    fi
fi
case "$GATE_KIND" in
    full|ship|hold) ;;
    *) log "WARN: unknown cadence verdict '${GATE_KIND}'; running the full cycle"; GATE_KIND=full ;;
esac
if [ "$GATE_KIND" != full ] && { [ "$NOW_FLAG" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; }; then
    GATE_REASON="${GATE_KIND} (${GATE_REASON}) overridden by $([ "$NOW_FLAG" -eq 1 ] && echo --now || echo --dry-run)"
    GATE_KIND=full
fi
log "cadence: ${GATE_KIND} (${GATE_REASON})"
if [ "$GATE_KIND" = hold ]; then
    STAGE=hold  # not a run and not a failure: the status file keeps the last real run
    log "HOLD: ${GATE_REASON}"
    exit 0
fi
if [ "$GATE_KIND" = ship ]; then
    publish_head
    cycle_end "cycle complete, HEAD shipped without regenerating (${GATE_REASON})"
fi
STAGE=generators
# the probe ran outside the generator clock: a slow NWS answer must not squeeze gen-history
GEN_DEADLINE=$(( $(command date +%s) + CYCLE_BUDGET_S - SNAPSHOT_S ))

gen roads gen-roads-snapshot.py data/roads-snapshot.json "$BUDGET_ROADS_S" || :  # independent source; outcome already recorded in gen()
gen roadflood gen-transtar-flood.py data/transtar-flood.json "$BUDGET_ROADFLOOD_S" || :  # independent optional feed; ahead of history so its long pole cannot squeeze a flood feed
gen history gen-history.py data/history.json "$BUDGET_HISTORY_S" || :  # reads COMMITTED snapshot history, so this cycle's fetch does not gate it
gen notices gen-notices.py data/requests.json "$BUDGET_NOTICES_S" || :  # LAN intake merge, never committed by the cycle
gen shelters gen-shelters.py data/shelters-live.json "$BUDGET_SHELTERS_S" || :  # independent optional feed
gen crossstatus gen-crossings-status.py data/crossing-status.json "$BUDGET_CROSSSTATUS_S" || :  # independent optional feed; live jurisdiction-reported closures
gen wildfire gen-wildfire.py data/wildfire.json "$BUDGET_WILDFIRE_S" || :  # independent optional feed; two sources, either one may degrade alone

# crest-summary is purely derived from the gauge snapshot; feeds is not (it also carries live NWS
# flash-flood alerts, and its lastBuildDate is a document build stamp, not a data-currency claim),
# so withholding it over a gauge-API outage would hide fresh warnings from a flood board.
if [ "$SNAPSHOT_FRESH" -eq 1 ]; then
    gen crest gen-crest-summary.py data/crest-summary.json "$BUDGET_CREST_S" || :  # outcome recorded in gen()
else
    skip crest gen-crest-summary.py "the gauge snapshot did not refresh"
fi

gen feeds gen-feeds.py "feed.xml + crests.ics" "$BUDGET_FEEDS_S" || :  # outcome recorded in gen()

# the CalTopo export is a snapshot of published gauge/crest state; restamping it over stale gauges
# would hand a field team a fresh-looking export of old numbers
if [ "$SNAPSHOT_FRESH" -eq 1 ]; then
    gen caltopo gen-caltopo.py "caltopo-export.json + board.kml + board-georss.xml" "$BUDGET_CALTOPO_S" || :  # outcome recorded in gen()
else
    skip caltopo gen-caltopo.py "the gauge snapshot did not refresh"
fi

# last: it diffs every source above, and its NWS read must never delay the flood feeds
gen changes gen-changes.py "data/changes.json + data/changes-state.json" "$BUDGET_CHANGES_S" || :  # a stale source is carried, never diffed

# a cycle where NOTHING refreshed is a hard failure: there is nothing to publish and the fault is
# upstream-wide, not a single flaky source
if [ "${#STEPS_OK[@]}" -eq 0 ]; then
    log "ERROR: cycle failed (no source refreshed; failed: ${STEPS_FAILED[*]:-none}, timed out: ${STEPS_TIMEOUT[*]:-none}, skipped: ${STEPS_SKIPPED[*]:-none})"
    exit 1
fi

degraded_now

# heal_changes — the change log is derived, so one that breaks its publish bounds must never stop a
# flood publish (CLAUDE.md "Deliberately NOT adopted"): restore it with its state from HEAD, or drop
# both when HEAD has none that passes, and sign the cycle off degraded
heal_changes() {
    local checker="${PIPE_ROOT}/scripts/changescheck.py" why f
    [ -f "$checker" ] || return 0
    why=$(python3 "$checker" 2>&1) && return 0
    log "WARN: the change log broke its publish bounds (${why}); restoring data/changes.json and data/changes-state.json from HEAD"
    for f in data/changes.json data/changes-state.json; do
        if git cat-file -e "HEAD:$f" 2>/dev/null; then  # absent at HEAD means there is nothing to restore
            if ! { git show "HEAD:$f" > "$f.heal" && command mv -f "$f.heal" "$f"; }; then
                log "WARN: could not restore $f"
            fi
        else
            command rm -f "$f"
        fi
    done
    if ! why=$(python3 "$checker" 2>&1); then
        log "WARN: the committed change log fails too (${why}); dropping it, the next run starts a new one"
        command rm -f data/changes.json data/changes-state.json
    fi
    STEPS_FAILED+=("changes")
    DEGRADED=1
}

# validation stays fatal: it gates whether the data on disk is publishable at all
STAGE=validate
heal_changes
log "step: cycle-check.sh (validation)"
: > "$STEP_OUT"
if ! bash "${PIPE_ROOT}/scripts/cycle-check.sh" --code-from-head 2>&1 | command tee "$STEP_OUT"; then
    collect_advisories
    cause=$(first_fail)
    log "ERROR: validation failed: ${cause:-cycle-check.sh exited non-zero and printed no FAIL line}"
    exit 1
fi
collect_advisories

if [ "$DRY_RUN" -eq 1 ]; then
    cycle_end "DRY-RUN OK: fetch + generators + validation composed; stopping before git/deploy"
fi

STAGE=commit
if [ "$DETECTOR_OK" -eq 1 ]; then
    python3 "$DETECTOR" --write-cadence "$FIRE_ISO" \
        || log "WARN: no truthful data/cadence.json could be written; withdrawn, so clients use fixed thresholds"
else
    command rm -f data/cadence.json  # an unprobed cadence is no claim at all (E1)
fi
DATA_FILES=(
    data/gauges-snapshot.json
    data/gauges-capture.json
    data/roads-snapshot.json
    data/roads-capture.json
    data/crest-summary.json
    data/gauge-meta.json
    data/history.json
    history/index.json
    history/day
    data/shelters-live.json
    data/crossing-status.json
    data/wildfire.json
    data/transtar-flood.json
    data/changes.json
    data/changes-state.json
    data/caltopo-export.json
    data/board.kml
    data/board-live.kml
    data/board-georss.xml
    feed.xml
    crests.ics
    data/cadence.json
)

# history/day is a directory pathspec on purpose: the chunk set gains a file every UTC day, and
# `git add <dir>` stages its adds, edits and deletions without an -A over the whole tree.
# git add aborts the cycle on a pathspec that matches nothing, so a generator that has
# never yet produced its file (new artifact, first run after an upgrade) must not be staged
PRESENT_FILES=()
for f in "${DATA_FILES[@]}"; do
    if [ -e "$f" ] || git cat-file -e "HEAD:$f" 2>/dev/null; then  # tracked-but-deleted still needs staging
        PRESENT_FILES+=("$f")
    else
        log "note: ${f} absent and untracked; not staged this cycle"
    fi
done

if [ "${#PRESENT_FILES[@]}" -eq 0 ]; then
    cycle_end "no data files present to commit; skipping push/deploy"
fi

if git diff --quiet HEAD -- "${PRESENT_FILES[@]}"; then
    cycle_end "no data changes vs HEAD; nothing to commit, skipping push/deploy"
fi

git add "${PRESENT_FILES[@]}"

GAUGE_COUNT=$(python3 -c "import json;print(len(json.load(open('data/gauges-snapshot.json'))['gauges']))")
STAMP=$(command date -u '+%Y-%m-%dT%H:%MZ')
# the commit subject names what actually refreshed, so git history does not imply a full regen
# on a cycle that only published some of its sources
COMMIT_MSG="Data refresh ${STAMP} (auto-cron): snapshot ${GAUGE_COUNT} gauges + roads/history/crest/feeds/shelters/caltopo regen"
if [ "$DEGRADED" -eq 1 ]; then
    COMMIT_MSG="Data refresh ${STAMP} (auto-cron, partial): refreshed ${STEPS_OK[*]}${STEPS_PARTIAL[*]:+; partial: ${STEPS_PARTIAL[*]}}; stale: ${STEPS_FAILED[*]:-none} ${STEPS_TIMEOUT[*]:-} ${STEPS_SKIPPED[*]:-}"
fi
# the pathspec keeps anything another process left staged out of a "Data refresh" commit
git -c user.name='Ryan MacDonald' -c user.email='ryan@rfxn.com' commit -m "$COMMIT_MSG" -- "${PRESENT_FILES[@]}"
log "committed: $(git log --oneline -1)"

publish_head
cycle_end "cycle complete"
