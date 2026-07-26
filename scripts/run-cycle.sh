#!/bin/bash
# run-cycle.sh [--dry-run] [--allow-dirty-code] — durable 15-min data-refresh cycle.
# Fetch NWPS snapshot, regenerate roads/history/crest/notices/feeds/shelters/
# caltopo, validate, then (unless --dry-run) commit the data files by name,
# push, and deploy via deploy.sh. flock-serialized, idempotent, safe when
# nothing changed.
#
# The pipeline CODE is read from HEAD, the DATA is the working tree's. See
# scripts/README.md "The cycle runs committed code".
#
# One failing source does not stop the publish: generators are non-fatal and
# the cycle ships whatever refreshed. See scripts/README.md "Partial publish".
# Exit: 0 clean or lock-skip, 1 nothing refreshed / fatal, 2 bad argument,
#       3 published but degraded, or deploy.sh's own code if deploy failed.
set -euo pipefail

DRY_RUN=0
ALLOW_DIRTY_CODE=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --allow-dirty-code) ALLOW_DIRTY_CODE=1 ;;
        *) echo "FAIL: unknown argument: $arg (supported: --dry-run, --allow-dirty-code)" >&2; exit 2 ;;
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

log() { printf '%s %s\n' "$(command date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
# $LINENO, not ${BASH_LINENO[0]}: for a top-level command the latter is the caller frame, which is
# empty at top level, so every real failure logged the useless "near line 0"
trap 'log "ERROR: cycle failed (exit $?) near line ${LINENO}"' ERR

# --- per-source bookkeeping: one failing upstream must not block publishing the rest ---
STEPS_OK=()
STEPS_FAILED=()
STEPS_SKIPPED=()

# PIPE_ROOT is the tree the cycle's own code is read from; the data always lives in REPO_ROOT
PIPE_ROOT="$REPO_ROOT"
CODE_TMP=""

# gen LABEL SCRIPT KEEP — run one generator, record the outcome, return its real status.
# A failed generator leaves its previous output untouched, so that file keeps its own older
# "generated" stamp and the board's freshness/aging/suppression machinery marks it stale by itself.
gen() {
    local label=$1 script=$2 keep=$3
    log "step: ${script}"
    if python3 "${PIPE_ROOT}/scripts/${script}"; then
        STEPS_OK+=("$label")
        return 0
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

# shellcheck disable=SC2317  # reached only via the EXIT trap set below
drop_pipeline() {
    rc=$?
    if [ -n "$CODE_TMP" ]; then
        cd "$REPO_ROOT" || exit "$rc"
        git worktree remove --force "$CODE_TMP" >/dev/null 2>&1 || command rm -rf "$CODE_TMP"  # remove is the clean path; rm covers a half-created worktree
        git worktree prune >/dev/null 2>&1 || :  # a stale admin entry is cosmetic, never worth failing a cycle over
    fi
    exit "$rc"
}

# --- lock: one cycle at a time (session refresh + system cron share this file) ---
LOCKFILE="${RESPONDER_CYCLE_LOCK:-/tmp/responder-cycle.lock}"
exec 9>"$LOCKFILE"
if ! flock -n 9; then
    log "SKIP: another cycle holds $LOCKFILE"
    exit 0
fi

log "=== cycle start (dry_run=${DRY_RUN}) repo=${REPO_ROOT} ==="

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
    trap drop_pipeline EXIT
    # stdout only: git's progress chatter would repeat in the log every 15 minutes, stderr still speaks
    if ! git worktree add --detach --no-checkout "$CODE_TMP" HEAD >/dev/null \
       || ! git -C "$CODE_TMP" checkout HEAD -- scripts; then
        log "ERROR: could not materialize HEAD scripts/ at ${CODE_TMP} (--allow-dirty-code runs the working tree instead)"
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

if gen snapshot fetch-snapshot.py data/gauges-snapshot.json; then SNAPSHOT_FRESH=1; else SNAPSHOT_FRESH=0; fi

gen roads gen-roads-snapshot.py data/roads-snapshot.json || :  # independent source; outcome already recorded in gen()
gen history gen-history.py data/history.json || :  # reads COMMITTED snapshot history, so this cycle's fetch does not gate it
gen notices gen-notices.py data/requests.json || :  # LAN intake merge, never committed by the cycle
gen shelters gen-shelters.py data/shelters-live.json || :  # independent optional feed
gen crossstatus gen-crossings-status.py data/crossing-status.json || :  # independent optional feed; live jurisdiction-reported closures

# crest-summary is purely derived from the gauge snapshot; feeds is not (it also carries live NWS
# flash-flood alerts, and its lastBuildDate is a document build stamp, not a data-currency claim),
# so withholding it over a gauge-API outage would hide fresh warnings from a flood board.
if [ "$SNAPSHOT_FRESH" -eq 1 ]; then
    gen crest gen-crest-summary.py data/crest-summary.json || :  # outcome recorded in gen()
else
    skip crest gen-crest-summary.py "the gauge snapshot did not refresh"
fi

gen feeds gen-feeds.py "feed.xml + crests.ics" || :  # outcome recorded in gen()

# the CalTopo export is a snapshot of published gauge/crest state; restamping it over stale gauges
# would hand a field team a fresh-looking export of old numbers
if [ "$SNAPSHOT_FRESH" -eq 1 ]; then
    gen caltopo gen-caltopo.py "caltopo-export.json + board.kml + board-georss.xml" || :  # outcome recorded in gen()
else
    skip caltopo gen-caltopo.py "the gauge snapshot did not refresh"
fi

# a cycle where NOTHING refreshed is a hard failure: there is nothing to publish and the fault is
# upstream-wide, not a single flaky source
if [ "${#STEPS_OK[@]}" -eq 0 ]; then
    log "ERROR: cycle failed (no source refreshed; failed: ${STEPS_FAILED[*]:-none}, skipped: ${STEPS_SKIPPED[*]:-none})"
    exit 1
fi

DEGRADED=0
if [ "${#STEPS_FAILED[@]}" -gt 0 ] || [ "${#STEPS_SKIPPED[@]}" -gt 0 ]; then
    DEGRADED=1
fi

# cycle_end MSG — the ONE exit point for every publishing path, so a partially-degraded cycle can
# never sign off as a clean success. Exit 3 = published what refreshed, some sources did not.
cycle_end() {
    if [ "$DEGRADED" -eq 1 ]; then
        log "=== $1 (DEGRADED) === refreshed: ${STEPS_OK[*]:-none} | failed: ${STEPS_FAILED[*]:-none} | skipped: ${STEPS_SKIPPED[*]:-none}"
        exit 3
    fi
    log "=== $1 ==="
    exit 0
}

# validation stays fatal: it gates whether the data on disk is publishable at all
log "step: cycle-check.sh (validation)"
bash "${PIPE_ROOT}/scripts/cycle-check.sh" --code-from-head

if [ "$DRY_RUN" -eq 1 ]; then
    cycle_end "DRY-RUN OK: fetch + generators + validation composed; stopping before git/deploy"
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
    data/caltopo-export.json
    data/board.kml
    data/board-live.kml
    data/board-georss.xml
    feed.xml
    crests.ics
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
    COMMIT_MSG="Data refresh ${STAMP} (auto-cron, partial): refreshed ${STEPS_OK[*]}; stale: ${STEPS_FAILED[*]:-none} ${STEPS_SKIPPED[*]:-}"
fi
git -c user.name='Ryan MacDonald' -c user.email='ryan@rfxn.com' commit -m "$COMMIT_MSG"
log "committed: $(git log --oneline -1)"

log "step: git push origin main"
git push origin main

log "step: deploy.sh (push + CF Pages deploy + smoke)"
if bash "${PIPE_ROOT}/scripts/deploy.sh"; then
    log "deploy OK"
else
    rc=$?
    log "WARN: deploy.sh failed (exit ${rc}); data is committed+pushed — next cycle redeploys"
    exit "$rc"
fi

# best-effort push-evaluator nudge (fast path; the Worker's */5 cron is the guaranteed path).
# HMAC over the raw body with the shared key; NEVER fatal — push infra must not break the cycle.
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

cycle_end "cycle complete"
