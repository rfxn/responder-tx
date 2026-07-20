#!/bin/bash
# install-cron.sh [--chat|--chat-ack-only] [--remove] [--dry-run] — idempotently
# install/remove the durable Responder system-cron entries.
#   (default)        the 15-min data-refresh cycle (run-cycle.sh)
#   --chat           the chat-inbox poll (chat-poll.sh) — full headless-claude
#                    processing; enabling it is a controller/owner decision
#   --chat-ack-only  the chat-inbox poll in ack-only (no-LLM) safe mode
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
        *) echo "FAIL: unknown argument: $arg (supported: --chat, --chat-ack-only, --remove, --dry-run)" >&2; exit 2 ;;
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

case "$TARGET" in
    data)           MARKER="$DATA_MARKER"; CMD="$DATA_CMD"; LINE="$DATA_LINE"; LABEL="data-refresh cycle" ;;
    chat)           MARKER="$CHAT_MARKER"; CMD="$CHAT_CMD"; LINE="$CHAT_LINE_FULL"; LABEL="chat-inbox poll (headless claude)" ;;
    chat-ack-only)  MARKER="$CHAT_MARKER"; CMD="$CHAT_CMD"; LINE="$CHAT_LINE_ACK"; LABEL="chat-inbox poll (ack-only, no LLM)" ;;
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

tmp=$(mktemp) || { echo "FAIL: mktemp" >&2; exit 1; }
trap 'rm -f "$tmp"' EXIT

# Drop any prior managed lines for THIS target (marker + entry, matched by command path), then re-add if installing.
crontab -l 2>/dev/null | grep -vF "$CMD" | grep -vF "$MARKER" > "$tmp" || true  # absent crontab / no-match greps exit non-zero; both fine

if [ "$REMOVE" -eq 0 ]; then
    printf '%s\n%s\n' "$MARKER" "$LINE" >> "$tmp"
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
    echo "removed responder-tx ${LABEL} entry"
else
    echo "installed responder-tx ${LABEL} entry: ${LINE}"
fi
echo "current crontab:"
crontab -l
