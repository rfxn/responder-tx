#!/bin/bash
# run-outofband.sh: weekly unattended refresh of the hand-run inventories (records, cameras, tide
# stations, River Sentry towers). Runs HEAD's generators, validates, and commits only the files that
# changed, by name; the data cycle ships the commit at its next fire. See scripts/README.md "Cadence".
# Exit: 0 all refreshed or unchanged, 3 some generator refused (the rest committed), 1 fatal.
set -euo pipefail

SCRIPT_DIR=$(cd "$(command dirname "$0")" && pwd) || exit 1
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd) || exit 1
cd "$REPO_ROOT" || exit 1
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

LOCKFILE="${RESPONDER_CYCLE_LOCK:-/tmp/responder-cycle.lock}"
LOCK_WAIT_S="${RESPONDER_OUTOFBAND_LOCK_WAIT_S:-900}"
GEN_BUDGET_S="${RESPONDER_OUTOFBAND_GEN_BUDGET_S:-1500}"
GENERATORS=(
    "gen-records.py data/records.json"
    "gen-cameras.py data/cameras.json"
    "gen-tide-meta.py data/tide-meta.json"
    "gen-river-sentry.py data/river-sentry.json"
)

log() { printf '%s %s\n' "$(command date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

CODE_TMP=""
GEN_ROOT=""
cleanup() {
    local rc=$?
    if [ -n "$GEN_ROOT" ]; then command rm -rf "$GEN_ROOT"; fi
    if [ -n "$CODE_TMP" ]; then
        git worktree remove --force "$CODE_TMP" >/dev/null 2>&1 || command rm -rf "$CODE_TMP"
        git worktree prune >/dev/null 2>&1 || :  # a stale admin entry is cosmetic
    fi
    exit "$rc"
}
trap cleanup EXIT

log "=== out-of-band refresh start repo=${REPO_ROOT} ==="
CODE_TMP=$(command mktemp -d "${TMPDIR:-/tmp}/responder-outofband.XXXXXX") || { log "ERROR: mktemp failed"; exit 1; }
if ! git worktree add --detach --no-checkout "$CODE_TMP" HEAD >/dev/null 2>&1 \
   || ! git -C "$CODE_TMP" checkout HEAD -- scripts >/dev/null 2>&1; then
    log "ERROR: could not materialize HEAD scripts/ at ${CODE_TMP}"
    exit 1
fi
export RESPONDER_ROOT="$REPO_ROOT"
# generators write into a scratch root holding only the inputs they read; nothing reaches the live
# tree until the cycle lock is held, so the data cycle never validates a half-refreshed inventory
GEN_ROOT=$(command mktemp -d "${TMPDIR:-/tmp}/responder-outofband-data.XXXXXX") || { log "ERROR: mktemp failed"; exit 1; }
command mkdir -p "$GEN_ROOT/data"
for f in data/event.json data/gauges-snapshot.json data/records.json data/cameras.json data/tide-meta.json data/river-sentry.json; do
    if [ -f "$f" ]; then command cp -p "$f" "$GEN_ROOT/$f"; fi
done

CHANGED=()
REFRESHED=()
FAILED=()
UNCHANGED=()
SKIPPED=()
for entry in "${GENERATORS[@]}"; do
    gen=${entry%% *}
    out=${entry#* }
    label=${gen#gen-}
    label=${label%.py}
    if [ -n "$(git status --porcelain -- "$out")" ]; then
        SKIPPED+=("$label")
        log "SKIP: ${out} has uncommitted changes this script did not make; leaving them for whoever made them"
        continue
    fi
    log "step: ${gen} (budget ${GEN_BUDGET_S}s)"
    rc=0
    RESPONDER_ROOT="$GEN_ROOT" command timeout -k 20 "$GEN_BUDGET_S" python3 "${CODE_TMP}/scripts/${gen}" || rc=$?
    if [ "$rc" -ne 0 ]; then
        FAILED+=("$label")
        log "WARN: ${gen} exited ${rc}; it refuses to write a degraded run, so the previous ${out} stands"
        continue
    fi
    if [ ! -f "$GEN_ROOT/$out" ] || command cmp -s "$GEN_ROOT/$out" "$out"; then
        UNCHANGED+=("$label")
    else
        CHANGED+=("$out")
        REFRESHED+=("$label")
    fi
done

summary="refreshed ${REFRESHED[*]:-none}; unchanged ${UNCHANGED[*]:-none}; failed ${FAILED[*]:-none}; skipped ${SKIPPED[*]:-none}"
if [ "${#CHANGED[@]}" -eq 0 ]; then
    log "=== nothing changed: ${summary} ==="
    [ "${#FAILED[@]}" -eq 0 ] || exit 3
    exit 0
fi

exec 8>"$LOCKFILE"
if ! flock -w "$LOCK_WAIT_S" 8; then
    log "ERROR: the data cycle held ${LOCKFILE} for ${LOCK_WAIT_S}s; ${CHANGED[*]} discarded, the live tree untouched, retried next week"
    exit 1
fi
MOVED=()
for out in "${CHANGED[@]}"; do
    if [ -n "$(git status --porcelain -- "$out")" ]; then
        log "SKIP: ${out} was changed by someone else while this refresh ran; their copy stands"
        continue
    fi
    command cp -p "$GEN_ROOT/$out" "${out}.outofband.tmp" && command mv -f "${out}.outofband.tmp" "$out"
    MOVED+=("$out")
done
CHANGED=(${MOVED[@]+"${MOVED[@]}"})
if [ "${#CHANGED[@]}" -eq 0 ]; then
    log "=== nothing left to commit: ${summary} ==="
    exit 3
fi
# a file every data-lane deploy re-checks at HEAD must not be committed unvalidated: it would freeze the board
if ! check_out=$(bash "${CODE_TMP}/scripts/cycle-check.sh" --code-from-head 2>&1); then
    printf '%s\n' "$check_out"
    log "ERROR: cycle-check failed with the refreshed files ($(printf '%s\n' "$check_out" | grep -m1 '^FAIL: ' || echo 'no FAIL line')); restoring ${CHANGED[*]} from HEAD"
    git checkout --quiet -- "${CHANGED[@]}"
    exit 1
fi
STAMP=$(command date -u '+%Y-%m-%dT%H:%MZ')
git add -- "${CHANGED[@]}"
git -c user.name='Ryan MacDonald' -c user.email='ryan@rfxn.com' commit --quiet \
    -m "Out-of-band refresh ${STAMP} (auto-cron): ${summary}" -- "${CHANGED[@]}"
log "committed: $(git log --oneline -1)"
[ "${#FAILED[@]}" -eq 0 ] || { log "=== done, degraded: ${summary} ==="; exit 3; }
log "=== done: ${summary} ==="
