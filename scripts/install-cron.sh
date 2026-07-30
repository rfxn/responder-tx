#!/bin/bash
# install-cron.sh [--chat|--chat-ack-only|--watchdog|--monitor] [--remove] [--dry-run] —
# idempotently install/remove the durable Responder system-cron entries.
#   (default)        the 15-min data-refresh cycle (run-cycle.sh)
#   --chat           the chat-inbox poll (chat-poll.sh) — full headless-claude
#                    processing; enabling it is a controller/owner decision
#   --chat-ack-only  the chat-inbox poll in ack-only (no-LLM) safe mode
#   --watchdog       the chat stall-watchdog (chat-watchdog.sh) — build-capable
#                    auto-recovery when the in-session revival goes dark
#   --monitor        the public-mirror freshness monitor (freshness-monitor.sh)
#   --backup         the disaster-recovery snapshots (backup.sh hourly/daily/weekly
#                    plus a daily restore-drill.sh); installs 4 entries, not 1
#   --hooks          the git pre-push guard (not a cron; hooks live outside the tree
#                    and no clone carries them, so a fresh checkout must install it)
# Re-running never duplicates an entry (grep-guarded on the command path); each
# target is managed independently, so the others are left intact.
set -euo pipefail

REMOVE=0
DRY_RUN=0
TARGET=data
for arg in "$@"; do
    case "$arg" in
        --remove) REMOVE=1 ;;
        --dry-run) DRY_RUN=1 ;;
        --chat) TARGET=chat ;;
        --chat-ack-only) TARGET=chat-ack-only ;;
        --watchdog) TARGET=watchdog ;;
        --monitor) TARGET=monitor ;;
        --backup) TARGET=backup ;;
        --hooks) TARGET=hooks ;;
        *) echo "FAIL: unknown argument: $arg (supported: --chat, --chat-ack-only, --watchdog, --monitor, --backup, --hooks, --remove, --dry-run)" >&2; exit 2 ;;
    esac
done

DATA_CMD="/root/admin/work/proj/responder/scripts/run-cycle.sh"
DATA_MARKER="# responder-tx durable data-refresh cycle (managed by install-cron.sh)"
# run-cycle.sh self-logs to /var/log/responder-cycle.log; discard cron stdout to avoid a double copy
DATA_LINE="8,23,38,53 * * * * ${DATA_CMD} >/dev/null 2>&1"

CHAT_CMD="/root/admin/work/proj/responder/scripts/chat-poll.sh"
CHAT_MARKER="# responder-tx durable chat-inbox poll (managed by install-cron.sh)"
CHAT_SCHEDULE="*/3 * * * *"
# chat-poll.sh self-logs to /var/log/responder-chat-poll.log; discard cron stdout
CHAT_LINE_FULL="${CHAT_SCHEDULE} ${CHAT_CMD} >/dev/null 2>&1"
CHAT_LINE_ACK="${CHAT_SCHEDULE} ${CHAT_CMD} --ack-only >/dev/null 2>&1"

WATCHDOG_CMD="/root/admin/work/proj/responder/scripts/chat-watchdog.sh"
WATCHDOG_MARKER="# responder-tx durable chat stall-watchdog (managed by install-cron.sh)"
WATCHDOG_SCHEDULE="*/3 * * * *"
# chat-watchdog.sh self-logs to /var/log/responder-chat-watchdog.log; discard cron stdout
WATCHDOG_LINE="${WATCHDOG_SCHEDULE} ${WATCHDOG_CMD} >/dev/null 2>&1"

MONITOR_CMD="/root/admin/work/proj/responder/scripts/freshness-monitor.sh"
MONITOR_MARKER="# responder-tx public-mirror freshness monitor (managed by install-cron.sh)"
# offset ~5 min after each 8,23,38,53 data cycle so a healthy cycle has published before the check
MONITOR_SCHEDULE="13,28,43,58 * * * *"
# freshness-monitor.sh self-logs to /var/log/responder-freshness.log; discard cron stdout
MONITOR_LINE="${MONITOR_SCHEDULE} ${MONITOR_CMD} >/dev/null 2>&1"

BACKUP_CMD="/root/admin/work/proj/responder/scripts/backup.sh"
BACKUP_MARKER="# responder-tx disaster-recovery snapshots (managed by install-cron.sh)"
DRILL_CMD="/root/admin/work/proj/responder/scripts/restore-drill.sh"
# Off the :00/:30 marks and clear of the 8,23,38,53 data cycle, so a snapshot never races a
# commit mid-write. The drill runs after the daily snapshot it is meant to exercise.
BACKUP_LINES=(
    "47 * * * * ${BACKUP_CMD} --tier hourly >>/var/log/responder-backup.log 2>&1"
    "17 3 * * * ${BACKUP_CMD} --tier daily >>/var/log/responder-backup.log 2>&1"
    "37 4 * * 0 ${BACKUP_CMD} --tier weekly >>/var/log/responder-backup.log 2>&1"
    "51 3 * * * ${DRILL_CMD} >>/var/log/responder-backup.log 2>&1"
)

if [ "$TARGET" = "hooks" ]; then
    hook_src="/root/admin/work/proj/responder/scripts/hooks/pre-push"
    hook_dst="$(git -C /root/admin/work/proj/responder rev-parse --absolute-git-dir)/hooks/pre-push"
    if [ "$REMOVE" -eq 1 ]; then
        command rm -f "$hook_dst"
        echo "removed the pre-push guard from ${hook_dst}"
    else
        [ -f "$hook_src" ] || { echo "FAIL: ${hook_src} not found" >&2; exit 1; }
        if [ "$DRY_RUN" -eq 1 ]; then
            echo "DRY-RUN: would install ${hook_src} -> ${hook_dst}"
            exit 0
        fi
        command cp "$hook_src" "$hook_dst" || { echo "FAIL: cannot write ${hook_dst}" >&2; exit 1; }
        command chmod +x "$hook_dst"
        echo "installed the pre-push guard: ${hook_dst}"
        echo "  refuses non-fast-forward and branch-delete pushes to main."
        echo "  Hooks are per-clone and git never carries them, so every fresh checkout needs this."
    fi
    exit 0
fi

case "$TARGET" in
    data)           MARKER="$DATA_MARKER"; CMD="$DATA_CMD"; LINE="$DATA_LINE"; LABEL="data-refresh cycle" ;;
    chat)           MARKER="$CHAT_MARKER"; CMD="$CHAT_CMD"; LINE="$CHAT_LINE_FULL"; LABEL="chat-inbox poll (headless claude)" ;;
    chat-ack-only)  MARKER="$CHAT_MARKER"; CMD="$CHAT_CMD"; LINE="$CHAT_LINE_ACK"; LABEL="chat-inbox poll (ack-only, no LLM)" ;;
    watchdog)       MARKER="$WATCHDOG_MARKER"; CMD="$WATCHDOG_CMD"; LINE="$WATCHDOG_LINE"; LABEL="chat stall-watchdog (build-capable recovery)" ;;
    monitor)        MARKER="$MONITOR_MARKER"; CMD="$MONITOR_CMD"; LINE="$MONITOR_LINE"; LABEL="public-mirror freshness monitor" ;;
esac

if [ "$TARGET" = "chat" ] && [ "$REMOVE" -eq 0 ]; then
    echo "NOTICE: --chat enables an AUTONOMOUS headless-claude cron that processes the"
    echo "        LAN ops chat. The inbox is attacker-influenceable via POST /api/chat, so"
    echo "        claude runs READ-ONLY (Read only; Edit/Write/Bash/network/subagents all"
    echo "        denied) and emits its reply on stdout — the trusted wrapper is the sole"
    echo "        outbox writer, so an injection can touch no file. NO permission bypass."
    echo "        Enabling it is a controller/owner decision — review scripts/README.md"
    echo "        'Chat processor' first."
fi

if [ "$TARGET" = "watchdog" ] && [ "$REMOVE" -eq 0 ]; then
    echo "NOTICE: --watchdog enables a BUILD-CAPABLE auto-recovery cron. It stays idle"
    echo "        until a message has waited past the stall threshold with the cursor"
    echo "        un-advanced (in-session revival gone dark), then fires ONE headless"
    echo "        claude to drain+ship. Guardrails: single-flight lock, cooldown, a"
    echo "        per-cursor attempt budget, and a kill switch (data/.chat-watchdog-off)."
    echo "        It softens the read-only-cron boundary by design (owner decision) —"
    echo "        review scripts/README.md 'Stall watchdog' first."
fi

tmp=$(command mktemp) || { echo "FAIL: mktemp" >&2; exit 1; }
trap 'command rm -f "$tmp"' EXIT

if [ "$TARGET" = "backup" ]; then
    crontab -l 2>/dev/null | grep -vF "$BACKUP_CMD" | grep -vF "$DRILL_CMD" | grep -vF "$BACKUP_MARKER" > "$tmp" || true  # absent crontab / no-match greps exit non-zero; both fine
    if [ "$REMOVE" -eq 0 ]; then
        printf '%s\n' "$BACKUP_MARKER" >> "$tmp"
        for l in "${BACKUP_LINES[@]}"; do printf '%s\n' "$l" >> "$tmp"; done
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
        echo "DRY-RUN: resulting crontab would be:"; echo "-----"; command cat "$tmp"; echo "-----"; exit 0
    fi
    crontab "$tmp"
    if [ "$REMOVE" -eq 1 ]; then
        echo "removed responder-tx disaster-recovery entries"
    else
        echo "installed responder-tx disaster-recovery entries:"
        for l in "${BACKUP_LINES[@]}"; do echo "  ${l}"; done
        echo "NOTE: snapshots land in \${RESPONDER_BACKUP_DIR:-/root/backups/responder}, OUTSIDE the repo."
        echo "      They are on the same host and the same filesystem, so they survive a bad commit,"
        echo "      a bad push and an accidental delete, but NOT the loss of this machine. Completing"
        echo "      3-2-1 needs an offsite target; see scripts/README.md 'Disaster recovery'."
    fi
    echo "current crontab:"; crontab -l
    exit 0
fi

# Drop any prior managed lines for THIS target (marker + entry, matched by command path), then re-add if installing.
crontab -l 2>/dev/null | grep -vF "$CMD" | grep -vF "$MARKER" > "$tmp" || true  # absent crontab / no-match greps exit non-zero; both fine

if [ "$REMOVE" -eq 0 ]; then
    printf '%s\n%s\n' "$MARKER" "$LINE" >> "$tmp"
fi

if [ "$DRY_RUN" -eq 1 ]; then
    echo "DRY-RUN: resulting crontab would be:"
    echo "-----"
    command cat "$tmp"
    echo "-----"
    exit 0
fi

crontab "$tmp"

if [ "$REMOVE" -eq 1 ]; then
    echo "removed responder-tx ${LABEL} entry"
else
    echo "installed responder-tx ${LABEL} entry: ${LINE}"
fi
echo "current crontab:"
crontab -l
