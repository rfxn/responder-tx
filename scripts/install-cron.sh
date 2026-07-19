#!/bin/bash
# install-cron.sh [--remove] [--dry-run] — idempotently install/remove the
# system-cron entry that drives the durable Responder data-refresh cycle.
# Re-running never duplicates the entry (grep-guarded on the command path).
set -euo pipefail

REMOVE=0
DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --remove) REMOVE=1 ;;
        --dry-run) DRY_RUN=1 ;;
        *) echo "FAIL: unknown argument: $arg (supported: --remove, --dry-run)" >&2; exit 2 ;;
    esac
done

CRON_CMD="/root/admin/work/proj/responder/scripts/run-cycle.sh"
CRON_SCHEDULE="8,23,38,53 * * * *"
CRON_MARKER="# responder-tx durable data-refresh cycle (managed by install-cron.sh)"
# run-cycle.sh self-logs to /var/log/responder-cycle.log; discard cron stdout to avoid a double copy
CRON_LINE="${CRON_SCHEDULE} ${CRON_CMD} >/dev/null 2>&1"

tmp=$(mktemp) || { echo "FAIL: mktemp" >&2; exit 1; }
trap 'rm -f "$tmp"' EXIT

# Drop any prior managed lines (marker + the entry, matched by command path), then re-add if installing.
crontab -l 2>/dev/null | grep -vF "$CRON_CMD" | grep -vF "$CRON_MARKER" > "$tmp" || true  # absent crontab / no-match greps exit non-zero; both fine

if [ "$REMOVE" -eq 0 ]; then
    printf '%s\n%s\n' "$CRON_MARKER" "$CRON_LINE" >> "$tmp"
fi

if [ "$DRY_RUN" -eq 1 ]; then
    echo "DRY-RUN: resulting crontab would be:"
    echo "-----"
    cat "$tmp"
    echo "-----"
    exit 0
fi

crontab "$tmp"

if [ "$REMOVE" -eq 1 ]; then
    echo "removed responder-tx cycle entry"
else
    echo "installed responder-tx cycle entry: ${CRON_SCHEDULE} ${CRON_CMD}"
fi
echo "current crontab:"
crontab -l
