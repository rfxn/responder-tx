#!/bin/bash
# backup.sh [--tier hourly|daily|weekly] [--dry-run] — point-in-time disaster recovery
# snapshot of the whole repository plus the working state git does not track.
#
# The playback archive is REBUILT BY WALKING GIT HISTORY (gen-history.py git_blob()s
# every past data/gauges-capture.json), so this repository is not source code with a
# recoverable copy on a build server: it is the flood observation record itself, and
# upstream keeps only 30 days. GitHub is a replica of that history, not a backup of it,
# because anything destructive that reaches main is pushed there too.
#
# Writes OUTSIDE the repository on purpose. See scripts/README.md "Disaster recovery".
set -euo pipefail

TIER="hourly"
DRY_RUN=0
while [ $# -gt 0 ]; do
    case "$1" in
        --tier) TIER="${2:-}"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        *) echo "FAIL: unknown argument: $1 (supported: --tier, --dry-run)" >&2; exit 2 ;;
    esac
done
case "$TIER" in
    hourly|daily|weekly) ;;
    *) echo "FAIL: --tier must be hourly, daily or weekly (got '${TIER}')" >&2; exit 2 ;;
esac

SCRIPT_DIR=$(cd "$(command dirname "$0")" && pwd) || exit 1
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd) || exit 1
cd "$REPO_ROOT" || exit 1

# cron's minimal PATH (/usr/bin:/bin) omits /usr/local/bin where git/tar may live
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

DEST="${RESPONDER_BACKUP_DIR:-/root/backups/responder}"
MIRROR="$DEST/mirror.git"
STATUS="$DEST/status.json"
MIN_FREE_MB="${RESPONDER_BACKUP_MIN_FREE_MB:-2048}"
KEEP_HOURLY="${RESPONDER_BACKUP_KEEP_HOURLY:-6}"
KEEP_DAILY="${RESPONDER_BACKUP_KEEP_DAILY:-7}"
KEEP_WEEKLY="${RESPONDER_BACKUP_KEEP_WEEKLY:-4}"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
started_epoch=$(date +%s)

# Every exit path writes status.json. A backup that fails quietly is worse than none: the
# next incident would be met with a directory of stale bundles nobody knew had stopped.
FAIL_REASON=""
write_status() {
    local verdict="$1" detail="$2" head_hash count
    head_hash=$(git rev-parse HEAD 2>/dev/null || echo unknown)  # unknown is honest if the repo itself is the casualty
    count=$(git rev-list --count HEAD 2>/dev/null || echo 0)     # same
    command mkdir -p "$DEST" 2>/dev/null || true                 # status is best-effort when the volume is the problem
    command cat > "$STATUS" <<EOF 2>/dev/null || true
{
  "verdict": "${verdict}",
  "tier": "${TIER}",
  "detail": "${detail}",
  "at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "head": "${head_hash}",
  "commits": ${count},
  "elapsed_s": $(( $(date +%s) - started_epoch ))
}
EOF
}
on_exit() {
    local rc=$?
    if [ "$rc" -ne 0 ]; then
        write_status "FAIL" "${FAIL_REASON:-exited ${rc}}"
        echo "backup: FAILED (${FAIL_REASON:-exit ${rc}})" >&2
    fi
    return $rc
}
trap on_exit EXIT
fail() { FAIL_REASON="$1"; echo "FAIL: $1" >&2; exit 1; }

command mkdir -p "$DEST" || fail "cannot create ${DEST}"  # before the space check: df needs a path that exists
free_mb=$(df -Pm "$DEST" | awk 'NR==2{print $4}') || fail "cannot read free space for ${DEST}"
[ "$free_mb" -ge "$MIN_FREE_MB" ] \
    || fail "only ${free_mb} MB free at ${DEST}, need ${MIN_FREE_MB}; refusing to write a snapshot that could fill the disk the board runs on"

if [ "$DRY_RUN" -eq 1 ]; then
    echo "backup: dry run, tier=${TIER} dest=${DEST} free=${free_mb}MB"
    trap - EXIT
    exit 0
fi

command mkdir -p "$DEST/$TIER" || fail "cannot create ${DEST}/${TIER}"

# --- Copy 1: incremental mirror. Cheap enough to run every hour, and NEVER pruned, so a
# branch deleted or rewritten upstream leaves its objects sitting here, reachable by hash.
if [ ! -d "$MIRROR" ]; then
    # --no-hardlinks or git's local-clone optimization would share inodes with the repo it is
    # meant to survive, which is a second name for one copy rather than a second copy
    git clone --mirror --no-hardlinks "$REPO_ROOT" "$MIRROR" >/dev/null 2>&1 || fail "initial mirror clone failed"
else
    # no --prune, deliberately: pruning would replicate a destructive rewrite into the backup
    git --git-dir="$MIRROR" fetch --quiet "$REPO_ROOT" '+refs/heads/*:refs/heads/*' \
        || fail "mirror fetch failed"
fi
# unreachable objects are the point of this mirror, so compaction must never drop them
[ "$TIER" = "weekly" ] && git --git-dir="$MIRROR" gc --quiet --no-prune 2>/dev/null

# --- Copy 2: an immutable, self-contained point in time. A bundle carries its own history
# and is restorable with a plain `git clone`, with no dependency on this host or on GitHub.
BUNDLE="$DEST/$TIER/repo-${STAMP}.bundle"
git bundle create "$BUNDLE" --all >/dev/null 2>&1 || fail "git bundle create failed"
# an unverified backup is a hypothesis, so verify before anything is allowed to rotate out
git bundle verify "$BUNDLE" >/dev/null 2>&1 || fail "git bundle verify failed for ${BUNDLE}"

# --- The state git does not track. Small, and the only copy that exists anywhere: the ops
# chat is the owner's message record and the cursors are what stop a message being re-run.
STATE="$DEST/$TIER/state-${STAMP}.tar.gz"
state_files=()
for f in data/chat-inbox.jsonl data/chat-outbox.json data/.chat-cursor data/.chat-ack-cursor \
         data/.chat-drain-active .git/info/exclude; do
    [ -e "$f" ] && state_files+=("$f")
done
if [ "${#state_files[@]}" -gt 0 ]; then
    tar --ignore-failed-read -czf "$STATE" "${state_files[@]}" 2>/dev/null \
        || fail "state tar failed"
fi

MANIFEST="$DEST/$TIER/manifest-${STAMP}.json"
head_hash=$(git rev-parse HEAD) || fail "git rev-parse HEAD failed"
commits=$(git rev-list --count HEAD) || fail "git rev-list failed"
origin_gap=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo -1)  # -1 = no origin ref locally
bundle_sha=$(sha256sum "$BUNDLE" | awk '{print $1}') || fail "sha256 of bundle failed"
state_sha=""
[ -f "$STATE" ] && state_sha=$(sha256sum "$STATE" | awk '{print $1}')
command cat > "$MANIFEST" <<EOF || fail "cannot write ${MANIFEST}"
{
  "stamp": "${STAMP}",
  "tier": "${TIER}",
  "head": "${head_hash}",
  "commits": ${commits},
  "unpushed_to_origin": ${origin_gap},
  "bundle": "$(command basename "$BUNDLE")",
  "bundle_sha256": "${bundle_sha}",
  "bundle_bytes": $(command stat -c %s "$BUNDLE"),
  "state": "$([ -f "$STATE" ] && command basename "$STATE" || echo "")",
  "state_sha256": "${state_sha}",
  "state_files": [$(printf '"%s",' "${state_files[@]+"${state_files[@]}"}" | sed 's/,$//')]
}
EOF

# --- Retention. Newest-first, delete beyond the keep count for this tier only.
case "$TIER" in
    hourly) keep="$KEEP_HOURLY" ;;
    daily)  keep="$KEEP_DAILY" ;;
    weekly) keep="$KEEP_WEEKLY" ;;
esac
pruned=0
for prefix in repo state manifest; do
    while IFS= read -r old; do
        [ -n "$old" ] || continue
        command rm -f "$old" && pruned=$(( pruned + 1 ))
    done < <(ls -1t "$DEST/$TIER/${prefix}-"* 2>/dev/null | tail -n +$(( keep + 1 )))  # no matches is not an error
done

mirror_mb=$(du -sm "$MIRROR" | awk '{print $1}')
write_status "OK" "bundle $(command basename "$BUNDLE"), ${commits} commits, mirror ${mirror_mb}MB, pruned ${pruned}"
echo "backup: OK tier=${TIER} head=${head_hash} commits=${commits} bundle=$(( $(command stat -c %s "$BUNDLE") / 1048576 ))MB mirror=${mirror_mb}MB pruned=${pruned} free=${free_mb}MB"
[ "$origin_gap" -gt 0 ] && echo "backup: note: ${origin_gap} commit(s) not yet on origin; the offsite copy lags until the next successful deploy" >&2
trap - EXIT
exit 0
