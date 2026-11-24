#!/bin/bash
# tests/run-outofband.test.sh: scripts/run-outofband.sh and the install-cron.sh flags that arm it.
# The weekly refresh is unattended and commits into the live tree, so the pins are about what it may
# touch: only files that changed and validated, by name, never one a person left uncommitted, never a
# generator's refused run. A scratch repo with stub generators, a scratch lock and a fake crontab keep
# the real repo, the real cycle lock and the system crontab untouched. Run: bash tests/run-outofband.test.sh
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
FAILS=0
pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; FAILS=$((FAILS + 1)); }
cleanup() { if [ -n "${WORK:-}" ]; then rm -rf "$WORK"; fi; }
trap cleanup EXIT INT TERM

stub_gen() {  # NAME OUT MODE; MODE: new (rewrite with a fresh stamp), same (rewrite identical), refuse (exit 1)
    cat > "$REPO/scripts/$1" <<PY
import datetime, json, os, sys
mode = os.environ.get("STUB_${1//[.-]/_}", "$3")
if mode == "refuse":
    sys.exit("$1: stub refusal, previous file kept")
out = os.path.join(os.environ["RESPONDER_ROOT"], "$2")
body = {"generated": "2026-11-01T00:00:00Z", "records": {}}
if mode == "new":
    body["generated"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
with open(out, "w") as f:
    json.dump(body, f)
PY
}

setup() {
    WORK=$(mktemp -d)
    REPO="$WORK/repo"
    mkdir -p "$REPO/scripts" "$REPO/data"
    for f in records cameras tide-meta river-sentry; do
        printf '{"generated": "2026-11-01T00:00:00Z", "records": {}}' > "$REPO/data/$f.json"
    done
    stub_gen gen-records.py data/records.json new
    stub_gen gen-cameras.py data/cameras.json refuse
    stub_gen gen-tide-meta.py data/tide-meta.json same
    stub_gen gen-river-sentry.py data/river-sentry.json new
    printf '%s\n' '#!/bin/bash' 'echo "OK:   stub check"' '[ -z "${STUB_CHECK_FAIL:-}" ] || { echo "FAIL: data schemas (stub)"; exit 1; }' \
        > "$REPO/scripts/cycle-check.sh"
    cp "$REPO_ROOT/scripts/run-outofband.sh" "$REPO/scripts/run-outofband.sh"
    (
        cd "$REPO" && git init --quiet && git symbolic-ref HEAD refs/heads/main
        git config user.name Fixture && git config user.email fixture@example.test
        git add -A && git commit --quiet -m 'fixture baseline'
    ) > /dev/null 2>&1
}

run_oob() {
    RESPONDER_CYCLE_LOCK="$WORK/cycle.lock" RESPONDER_OUTOFBAND_LOCK_WAIT_S="${LOCK_WAIT:-900}" \
        bash "$REPO/scripts/run-outofband.sh" > "$WORK/out" 2>&1
    RC=$?
}

# --- 1: only changed, validated files are committed, by name, under the Contract 4 subject -------
setup
printf 'operator scratch\n' > "$REPO/data/notes-unrelated.txt"
run_oob
FILES=$(git -C "$REPO" show --name-only --format= HEAD | sort | tr '\n' ' ')
SUBJECT=$(git -C "$REPO" log -1 --format=%s)
if [ "$RC" -eq 3 ] && [ "$FILES" = "data/records.json data/river-sentry.json " ] \
   && printf '%s' "$SUBJECT" | grep -qE '^Out-of-band refresh [0-9T:-]+Z \(auto-cron\): refreshed records river-sentry; unchanged tide-meta; failed cameras; skipped none$' \
   && [ -f "$REPO/data/notes-unrelated.txt" ] && ! git -C "$REPO" ls-files --error-unmatch data/notes-unrelated.txt >/dev/null 2>&1; then
    pass "1 commits exactly the two files that changed, names the refused generator, exits 3, leaves strays alone"
else
    fail "1 by-name commit (rc=$RC files='$FILES' subject='$SUBJECT')"; cat "$WORK/out"
fi
rm -rf "$WORK"

# --- 2: a file somebody left uncommitted is not theirs to overwrite --------------------------
setup
printf '{"generated": "2026-11-23T00:00:00Z", "records": {"HAND": 1}}' > "$REPO/data/records.json"
BEFORE=$(sha256sum "$REPO/data/records.json")
run_oob
if [ "$(sha256sum "$REPO/data/records.json")" = "$BEFORE" ] && grep -q 'SKIP: data/records.json has uncommitted changes' "$WORK/out" \
   && ! git -C "$REPO" show --name-only --format= HEAD | grep -qx data/records.json; then
    pass "2 MUTATION · an uncommitted hand-run file is skipped, byte-identical and uncommitted"
else
    fail "2 a dirty file must be left alone"; cat "$WORK/out"
fi
rm -rf "$WORK"

# --- 3: a refresh that fails validation is never committed ----------------------------------
setup
HEAD_BEFORE=$(git -C "$REPO" rev-parse HEAD)
STUB_CHECK_FAIL=1 run_oob
if [ "$RC" -eq 1 ] && [ "$(git -C "$REPO" rev-parse HEAD)" = "$HEAD_BEFORE" ] && [ -z "$(git -C "$REPO" status --porcelain -- data)" ] \
   && grep -q 'cycle-check failed with the refreshed files (FAIL: data schemas (stub))' "$WORK/out"; then
    pass "3 MUTATION · a refresh that fails cycle-check is restored from HEAD, not committed"
else
    fail "3 an invalid refresh must not land (rc=$RC)"; cat "$WORK/out"
fi
rm -rf "$WORK"

# --- 4: generation never touches the live tree; only the locked step moves files in ----------
setup
exec 7>"$WORK/cycle.lock"
flock -n 7
HEAD_BEFORE=$(git -C "$REPO" rev-parse HEAD)
LIVE_BEFORE=$(cat "$REPO"/data/*.json | sha256sum)
LOCK_WAIT=2 run_oob
exec 7>&-
if [ "$RC" -eq 1 ] && [ "$(git -C "$REPO" rev-parse HEAD)" = "$HEAD_BEFORE" ] && grep -q 'held .*cycle.lock for 2s' "$WORK/out" \
   && [ "$(cat "$REPO"/data/*.json | sha256sum)" = "$LIVE_BEFORE" ] && [ -z "$(git -C "$REPO" status --porcelain -- data)" ]; then
    pass "4 MUTATION · with the cycle lock held, nothing is committed and the live data files are byte-identical"
else
    fail "4 the commit must happen only under the cycle lock (rc=$RC)"; cat "$WORK/out"
fi
rm -rf "$WORK"

# --- 5-7: install-cron.sh --outofband / --steward, against a fake crontab -------------------
WORK=$(mktemp -d)
mkdir -p "$WORK/bin" "$WORK/scripts"
printf '%s\n' '#!/bin/bash' 'if [ "$1" = -l ]; then cat "$FAKE_CRONTAB" 2>/dev/null; else cp "$1" "$FAKE_CRONTAB"; fi' > "$WORK/bin/crontab"
chmod +x "$WORK/bin/crontab"
printf '%s\n' '8,23,38,53 * * * * /root/admin/work/proj/responder/scripts/run-cycle.sh >/dev/null 2>&1' > "$WORK/crontab"
cp "$REPO_ROOT/scripts/install-cron.sh" "$REPO_ROOT/scripts/run-outofband.sh" "$WORK/scripts/"
cron() { PATH="$WORK/bin:$PATH" FAKE_CRONTAB="$WORK/crontab" bash "$WORK/scripts/install-cron.sh" "$@" > "$WORK/out" 2>&1; RC=$?; }
cron --outofband
cron --outofband
if [ "$RC" -eq 0 ] && [ "$(grep -c 'run-outofband.sh' "$WORK/crontab")" -eq 1 ] \
   && grep -qxF '29 4 * * 1 /root/admin/work/proj/responder/scripts/run-outofband.sh >>/var/log/responder-outofband.log 2>&1' "$WORK/crontab" \
   && grep -q 'run-cycle.sh' "$WORK/crontab"; then
    pass "5 --outofband installs the Contract 4 line once, idempotently, leaving the data cycle entry"
else
    fail "5 --outofband entry (rc=$RC)"; cat "$WORK/out" "$WORK/crontab"
fi
cron --steward
if [ "$RC" -ne 0 ] && grep -q 'scripts/steward.sh is not in this checkout' "$WORK/out" && ! grep -q steward "$WORK/crontab"; then
    pass "6 --steward refuses while steward.sh is absent, rather than arming a cron that fails silently"
else
    fail "6 --steward must refuse without steward.sh (rc=$RC)"; cat "$WORK/out"
fi
printf '%s\n' '#!/bin/bash' 'exit 0' > "$WORK/scripts/steward.sh"
cron --steward
if [ "$RC" -eq 0 ] && grep -qxF '11,41 * * * * /root/admin/work/proj/responder/scripts/steward.sh >/dev/null 2>&1' "$WORK/crontab" \
   && grep -q 'run-outofband.sh' "$WORK/crontab"; then
    pass "7 --steward installs the Contract 4 line once steward.sh exists, beside the others"
else
    fail "7 --steward entry (rc=$RC)"; cat "$WORK/out" "$WORK/crontab"
fi
cron --outofband --remove
if [ "$RC" -eq 0 ] && ! grep -q 'run-outofband' "$WORK/crontab" && grep -q steward.sh "$WORK/crontab"; then
    pass "7b --outofband --remove drops only its own entry"
else
    fail "7b remove must be targeted (rc=$RC)"; cat "$WORK/crontab"
fi
rm -rf "$WORK"

echo "----"
if [ "$FAILS" -eq 0 ]; then
    echo "ALL RUN-OUTOFBAND TESTS PASSED"
    exit 0
fi
echo "${FAILS} TEST(S) FAILED"
exit 1
