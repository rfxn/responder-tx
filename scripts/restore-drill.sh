#!/bin/bash
# restore-drill.sh [--tier hourly|daily|weekly] [--keep] — restore the newest backup into a
# throwaway tree and prove it is a working repository, not just a file that exists.
#
# An unexercised backup is a hypothesis. This is the part of a recovery plan that is usually
# skipped and the only part that answers the question actually asked during an incident.
# Reads the backup and writes nothing but a status file: it never touches the live repo.
set -euo pipefail

TIER=""
KEEP=0
while [ $# -gt 0 ]; do
    case "$1" in
        --tier) TIER="${2:-}"; shift 2 ;;
        --keep) KEEP=1; shift ;;
        *) echo "FAIL: unknown argument: $1 (supported: --tier, --keep)" >&2; exit 2 ;;
    esac
done

SCRIPT_DIR=$(cd "$(command dirname "$0")" && pwd) || exit 1
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd) || exit 1
# `git bundle verify` needs a repository to resolve prerequisites against and errors out with
# "need a repository to verify a bundle" without one. Under cron the CWD is $HOME, not the repo,
# which is why this script passed by hand and failed every night.
cd "$REPO_ROOT" || exit 1
export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"  # appended, not prepended: a caller that selected a toolchain (CI setup-node) must not be shadowed by the image's own node

DEST="${RESPONDER_BACKUP_DIR:-/root/backups/responder}"
STATUS="$DEST/drill-status.json"
WORK=""

FAIL_REASON=""
write_status() {
    command mkdir -p "$DEST" 2>/dev/null || true  # best-effort: the volume may be the casualty
    command cat > "$STATUS" <<EOF 2>/dev/null || true
{
  "verdict": "$1",
  "detail": "$2",
  "at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "manifest": "${MANIFEST:-}"
}
EOF
}
cleanup() {
    local rc=$?
    if [ "$rc" -ne 0 ]; then
        write_status "FAIL" "${FAIL_REASON:-exited ${rc}}"
        echo "restore-drill: FAILED (${FAIL_REASON:-exit ${rc}})" >&2
    fi
    if [ -n "$WORK" ] && [ "$KEEP" -eq 0 ]; then
        command rm -rf "$WORK"
    elif [ -n "$WORK" ]; then
        echo "restore-drill: restored tree kept at ${WORK}" >&2
    fi
    return $rc
}
trap cleanup EXIT
fail() { FAIL_REASON="$1"; echo "FAIL: $1" >&2; exit 1; }

# newest manifest across every tier unless one was named
tiers=(hourly daily weekly)
[ -n "$TIER" ] && tiers=("$TIER")
candidates=()
for t in "${tiers[@]}"; do
    while IFS= read -r m; do
        [ -n "$m" ] && candidates+=("$m")
    done < <(ls -1t "$DEST/$t"/manifest-*.json 2>/dev/null)  # a tier with no backup yet is not an error
done
[ "${#candidates[@]}" -gt 0 ] || fail "no manifest under ${DEST}; has backup.sh ever run?"
MANIFEST=$(ls -1t "${candidates[@]}" | head -1) || fail "cannot rank the manifests under ${DEST}"

tier_dir=$(command dirname "$MANIFEST")
read_key() { python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" "$MANIFEST" "$1"; }
want_head=$(read_key head)
want_commits=$(read_key commits)
bundle="$tier_dir/$(read_key bundle)"
want_sha=$(read_key bundle_sha256)
state_name=$(read_key state)

[ -f "$bundle" ] || fail "manifest names ${bundle} but it is not there"

# the manifest is only worth as much as the bytes still matching it
got_sha=$(sha256sum "$bundle" | awk '{print $1}') || fail "sha256 of the bundle failed"
[ "$got_sha" = "$want_sha" ] \
    || fail "bundle sha256 mismatch: manifest says ${want_sha}, file is ${got_sha} (bit rot or a partial write)"
verify_err=$(git bundle verify "$bundle" 2>&1 >/dev/null) \
    || fail "git bundle verify rejected ${bundle}: ${verify_err}"

WORK=$(command mktemp -d "${TMPDIR:-/tmp}/responder-drill.XXXXXX") || fail "mktemp failed"
git clone --quiet "$bundle" "$WORK/repo" 2>/dev/null || fail "git clone from the bundle failed"
cd "$WORK/repo" || fail "cannot enter the restored tree"

got_head=$(git rev-parse HEAD) || fail "restored tree has no HEAD"
[ "$got_head" = "$want_head" ] || fail "restored HEAD ${got_head} != manifest ${want_head}"
got_commits=$(git rev-list --count HEAD) || fail "cannot count commits in the restored tree"
[ "$got_commits" = "$want_commits" ] || fail "restored ${got_commits} commits, manifest says ${want_commits}"
git fsck --no-progress --connectivity-only >/dev/null 2>&1 || fail "git fsck failed on the restored tree"

# The archive is rebuilt by walking git history, so a restore that cannot read its own past
# commits is not a restore. Read the oldest capture blob the record depends on.
oldest=$(git log --format=%H --follow -- data/gauges-capture.json 2>/dev/null | tail -1)
if [ -n "$oldest" ]; then
    git show "${oldest}:data/gauges-capture.json" >/dev/null 2>&1 \
        || fail "the oldest gauges-capture blob is unreadable in the restored tree; the playback archive could not be rebuilt"
fi

# The manifest states what was captured; the drill verifies exactly that, rather than assuming
# a file list. The untracked ops chat is the only copy that exists, so a silently empty tar
# would be discovered during an incident instead of here.
if [ -n "$state_name" ] && [ -f "$tier_dir/$state_name" ]; then
    tar -xzf "$tier_dir/$state_name" -C "$WORK/repo" 2>/dev/null || fail "state tar failed to extract"
    while IFS= read -r want; do
        [ -n "$want" ] || continue
        [ -e "$WORK/repo/$want" ] || fail "manifest lists ${want} in the state tar but the restore has no such file"
    done < <(python3 -c "
import json,sys
for f in json.load(open(sys.argv[1])).get('state_files') or []: print(f)" "$MANIFEST")
fi

# the suite is the definition of a working tree here, and it runs offline
# name the files and pin the reporter: Node 22+ runs a bare dir as one failing test, and 24 drops the "# pass" line
test_out=$(node --test --test-reporter=tap tests/*.test.js 2>&1) || fail "the restored tree fails its own test suite"
passed=$(printf '%s' "$test_out" | grep -oE '^# pass [0-9]+' | awk '{print $3}')
[ -n "$passed" ] && [ "$passed" -gt 0 ] || fail "the restored tree ran no tests"

detail="head ${got_head:0:12}, ${got_commits} commits, ${passed} tests pass, bundle $(command basename "$bundle")"
write_status "OK" "$detail"
echo "restore-drill: OK ${detail}"
trap - EXIT
[ -n "$WORK" ] && [ "$KEEP" -eq 0 ] && command rm -rf "$WORK"
exit 0
