#!/bin/bash
# run-cycle.sh [--dry-run] — durable 15-min data-refresh cycle.
# Fetch NWPS snapshot, regenerate roads/history/crest/feeds, validate, then
# (unless --dry-run) commit the data files by name, push, and deploy via
# deploy.sh. flock-serialized, idempotent, safe when nothing changed.
set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        *) echo "FAIL: unknown argument: $arg (supported: --dry-run)" >&2; exit 2 ;;
    esac
done

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd) || exit 1
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd) || exit 1
cd "$REPO_ROOT" || exit 1

# --- durable logging: tee all output (this script + every subprocess) to the log ---
LOGFILE="${RESPONDER_CYCLE_LOG:-/var/log/responder-cycle.log}"
if ! ( : >> "$LOGFILE" ) 2>/dev/null; then  # probe: /var/log may be unwritable for non-root cron
    LOGFILE=/tmp/responder-cycle.log
fi
exec > >(tee -a "$LOGFILE") 2>&1

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
trap 'log "ERROR: cycle failed (exit $?) near line ${BASH_LINENO[0]}"' ERR

# --- lock: one cycle at a time (session refresh + system cron share this file) ---
LOCKFILE="${RESPONDER_CYCLE_LOCK:-/tmp/responder-cycle.lock}"
exec 9>"$LOCKFILE"
if ! flock -n 9; then
    log "SKIP: another cycle holds $LOCKFILE"
    exit 0
fi

log "=== cycle start (dry_run=${DRY_RUN}) repo=${REPO_ROOT} ==="

log "step: fetch-snapshot.py"
python3 scripts/fetch-snapshot.py

log "step: gen-roads-snapshot.py"
python3 scripts/gen-roads-snapshot.py

log "step: gen-history.py"
python3 scripts/gen-history.py

log "step: gen-crest-summary.py"
python3 scripts/gen-crest-summary.py

log "step: gen-feeds.py"
python3 scripts/gen-feeds.py

log "step: cycle-check.sh (validation)"
bash scripts/cycle-check.sh

if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN OK: fetch + 4 generators + validation composed; stopping before git/deploy"
    exit 0
fi

DATA_FILES=(
    data/gauges-snapshot.json
    data/roads-snapshot.json
    data/crest-summary.json
    data/history.json
    feed.xml
    crests.ics
)

if git diff --quiet HEAD -- "${DATA_FILES[@]}"; then
    log "no data changes vs HEAD — nothing to commit; skipping push/deploy"
    exit 0
fi

git add "${DATA_FILES[@]}"

GAUGE_COUNT=$(python3 -c "import json;print(len(json.load(open('data/gauges-snapshot.json'))['gauges']))")
STAMP=$(date -u '+%Y-%m-%dT%H:%MZ')
git -c user.name='Ryan MacDonald' -c user.email='ryan@rfxn.com' \
    commit -m "Data refresh ${STAMP} (auto-cron): snapshot ${GAUGE_COUNT} gauges + roads/history/crest/feeds regen"
log "committed: $(git log --oneline -1)"

log "step: git push origin main"
git push origin main

log "step: deploy.sh (push + CF Pages deploy + smoke)"
if scripts/deploy.sh; then
    log "deploy OK"
else
    rc=$?
    log "WARN: deploy.sh failed (exit ${rc}); data is committed+pushed — next cycle redeploys"
    exit "$rc"
fi

log "=== cycle complete ==="
