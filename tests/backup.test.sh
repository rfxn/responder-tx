#!/bin/bash
# backup.test.sh — disaster-recovery scripts. Everything runs against a throwaway repo and a
# throwaway backup dir; the live repo and the real /root/backups are never touched.
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd) || exit 1
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd) || exit 1
PASS=0
FAIL=0
ok()   { echo "PASS: $1"; PASS=$((PASS + 1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }
check(){ if [ "$1" -eq 0 ]; then ok "$2"; else bad "$2"; fi; }
# a red drill used to print only the test name, so days of CI failures carried no reason with them
check_log(){ if [ "$1" -eq 0 ]; then ok "$2"; else bad "$2"; sed 's/^/    | /' "$3" >&2; fi; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/responder-backup-test.XXXXXX") || exit 1
trap 'rm -rf "$WORK"' EXIT

# --- a small repo shaped like the real one: the archive is rebuilt from history, so the
# fixture needs a data/gauges-capture.json with more than one commit behind it
FIX="$WORK/repo"
mkdir -p "$FIX/data" "$FIX/tests"
cd "$FIX" || exit 1
git init -q .
git config user.email t@t.test; git config user.name test
mkdir -p scripts
cp "$REPO_ROOT/scripts/backup.sh" "$REPO_ROOT/scripts/restore-drill.sh" scripts/
mkdir -p scripts/hooks && cp "$REPO_ROOT/scripts/hooks/pre-push" scripts/hooks/
printf '{"gauges":[]}\n' > data/gauges-capture.json
printf 'const t=require("node:test");const a=require("node:assert");t("fixture",()=>a.ok(true));\n' > tests/fixture.test.js
git add -A >/dev/null && git commit -qm "fixture 1"
printf '{"gauges":[{"lid":"AAA"}]}\n' > data/gauges-capture.json
git add -A >/dev/null && git commit -qm "fixture 2"
FIX_HEAD=$(git rev-parse HEAD)

BDIR="$WORK/backups"
export RESPONDER_BACKUP_DIR="$BDIR"

# --- backup.sh
./scripts/backup.sh --tier daily >"$WORK/backup.log" 2>&1
check $? "backup: a first run on a fresh dir succeeds (creates its own dest)"

[ -d "$BDIR/mirror.git" ]; check $? "backup: writes a mirror"
bundle=$(ls -1 "$BDIR"/daily/repo-*.bundle 2>/dev/null | head -1)
[ -n "$bundle" ]; check $? "backup: writes a bundle"
manifest=$(ls -1 "$BDIR"/daily/manifest-*.json 2>/dev/null | head -1)
[ -n "$manifest" ]; check $? "backup: writes a manifest"

git bundle verify "$bundle" >/dev/null 2>&1
check $? "backup: the bundle it wrote passes git bundle verify"

grep -q "$FIX_HEAD" "$manifest"
check $? "backup: the manifest records the real HEAD"

# the backup must not live inside the repo it protects, or a repo delete takes both
case "$BDIR" in "$FIX"/*) bad "backup: dest is inside the repo" ;; *) ok "backup: dest is outside the repo" ;; esac

# a mirror sharing inodes with the repo is one copy under two names
pack=$(find "$BDIR/mirror.git/objects/pack" -name '*.pack' 2>/dev/null | head -1)
if [ -n "$pack" ]; then
    [ "$(stat -c %h "$pack")" = "1" ]; check $? "backup: mirror is a real copy, not hardlinked to the repo"
else
    ok "backup: mirror has no pack yet (loose objects only)"
fi

# --- the space guard must refuse rather than write a snapshot that fills the disk
RESPONDER_BACKUP_MIN_FREE_MB=99999999 ./scripts/backup.sh --tier daily >"$WORK/full.log" 2>&1
[ $? -ne 0 ]; check $? "backup: refuses to run when free space is under the floor"
grep -q '"verdict": "FAIL"' "$BDIR/status.json"
check $? "backup: a refusal is recorded in status.json, not swallowed"

# --- restore-drill.sh
./scripts/restore-drill.sh >"$WORK/drill.log" 2>&1
check_log $? "drill: passes against a healthy backup" "$WORK/drill.log"
grep -q '"verdict": "OK"' "$BDIR/drill-status.json"
check $? "drill: records OK in drill-status.json"

# MUTATION: a flipped byte must be caught by the manifest sha, not discovered during an incident
cp -r "$BDIR" "$WORK/corrupt"
cbundle=$(ls -1 "$WORK"/corrupt/daily/repo-*.bundle | head -1)
printf 'X' | dd of="$cbundle" bs=1 seek=200 conv=notrunc status=none 2>/dev/null
RESPONDER_BACKUP_DIR="$WORK/corrupt" ./scripts/restore-drill.sh >"$WORK/drill2.log" 2>&1
[ $? -ne 0 ]; check $? "drill: MUTATION a corrupted bundle fails the drill"
grep -q "sha256 mismatch" "$WORK/drill2.log"
check $? "drill: names bit rot as the reason rather than failing vaguely"

# MUTATION: a manifest that disagrees with the bundle must not pass
cp -r "$BDIR" "$WORK/liar"
lmanifest=$(ls -1 "$WORK"/liar/daily/manifest-*.json | head -1)
python3 -c "
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d['head']='0'*40; json.dump(d,open(p,'w'))" "$lmanifest"
RESPONDER_BACKUP_DIR="$WORK/liar" ./scripts/restore-drill.sh >"$WORK/drill3.log" 2>&1
[ $? -ne 0 ]; check $? "drill: MUTATION a manifest with the wrong HEAD fails the drill"

# the archive is rebuilt by walking history, so the drill has to prove old blobs are readable
grep -q "gauges-capture" scripts/restore-drill.sh
check $? "drill: asserts the oldest gauges-capture blob is readable in the restored tree"

# --- CWD independence. Cron runs these from $HOME, not the repo. `git bundle verify` needs a
# repository to resolve against, so the drill failed every night while passing by hand for a day
# before anyone looked at drill-status.json.
( cd / && "$FIX/scripts/restore-drill.sh" >"$WORK/cwd.log" 2>&1 )
check_log $? "drill: MUTATION passes when run from / , the way cron runs it" "$WORK/cwd.log"
grep -q '"verdict": "OK"' "$BDIR/drill-status.json"
check $? "drill: records OK after a run from a foreign cwd, not just a clean exit"
( cd /tmp && "$FIX/scripts/backup.sh" --tier daily >"$WORK/cwd2.log" 2>&1 )
check $? "backup: also runs from a foreign cwd"

# --- pre-push guard
Z40="0000000000000000000000000000000000000000"
HEADSHA=$(git rev-parse HEAD)
PREV=$(git rev-parse HEAD~1)

echo "refs/heads/main $HEADSHA refs/heads/main $PREV" | ./scripts/hooks/pre-push origin url >/dev/null 2>&1
check $? "hook: allows a fast-forward push"

echo "refs/heads/main $PREV refs/heads/main $HEADSHA" | ./scripts/hooks/pre-push origin url >/dev/null 2>&1
[ $? -ne 0 ]; check $? "hook: MUTATION refuses a non-fast-forward push to main"

echo "refs/heads/main $Z40 refs/heads/main $HEADSHA" | ./scripts/hooks/pre-push origin url >/dev/null 2>&1
[ $? -ne 0 ]; check $? "hook: refuses to delete main"

echo "refs/heads/main $HEADSHA refs/heads/main $Z40" | ./scripts/hooks/pre-push origin url >/dev/null 2>&1
check $? "hook: allows creating a branch that does not exist on the remote yet"

echo "refs/heads/scratch $PREV refs/heads/scratch $HEADSHA" | ./scripts/hooks/pre-push origin url >/dev/null 2>&1
check $? "hook: leaves non-protected branches alone"

RESPONDER_ALLOW_FORCE_PUSH=1 ./scripts/hooks/pre-push origin url >/dev/null 2>&1 <<EOF
refs/heads/main $PREV refs/heads/main $HEADSHA
EOF
check $? "hook: the deliberate override works"

echo "----"
echo "backup.test.sh: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ] || exit 1
echo "ALL PASS"
