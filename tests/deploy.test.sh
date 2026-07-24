#!/bin/bash
# tests/deploy.test.sh — release-gate regression tests for scripts/deploy.sh.
# Proves the deploy gate reads and ships HEAD, never the working tree:
#   1 the version gate reports HEAD's version, not a bumped-but-uncommitted tree
#   2 the gated version always equals the version in the upload directory
#   3 a dirty functions/ no longer aborts the deploy (static data still publishes)
#   4 uncommitted Functions code reaches neither the upload dir nor wrangler's CWD
#   5 --allow-dirty-functions still ships the uncommitted Functions on purpose
#   6 the test gate runs against HEAD (a red working tree cannot block a good deploy)
#   7 a red suite at HEAD still blocks, and --skip-tests still bypasses
#   8 no git worktree is leaked, on the success path or the failure path
# A scratch git repo, a stub wrangler, and a local bare remote keep the real repo
# and the real Pages project untouched. Run: bash tests/deploy.test.sh
set -uo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEPLOY_SRC="$REPO_ROOT/scripts/deploy.sh"
FAILS=0

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; FAILS=$((FAILS + 1)); }

HEAD_MARKER='committed-functions-marker'
TREE_MARKER='uncommitted-functions-marker'

setup() {  # fresh scratch repo at v1.0.0 with a bare origin, a stub wrangler, and a green suite
    WORK=$(mktemp -d)
    REPO="$WORK/repo"
    mkdir -p "$REPO"/{js,data,scripts,tests,functions/api} "$WORK/bin"

    printf "%s\n" "const APP_VERSION = 'v1.0.0';" > "$REPO/js/core.js"
    printf '%s\n' \
        '<!doctype html><html><head>' \
        '<link rel="stylesheet" href="css/app.css?v=1.0.0">' \
        '<script src="js/core.js?v=1.0.0"></script>' \
        '</head><body>board</body></html>' > "$REPO/index.html"
    printf "%s\n" "const SW_VERSION = '1.0.0';" > "$REPO/sw.js"
    printf '%s\n' '{"versions":[{"v":"v1.0.0","d":"2026-07-24","items":[]}]}' > "$REPO/data/changelog.json"
    printf '%s\n' '## v1.0.0 (2026-07-24)' '' '- [New] fixture release' > "$REPO/CHANGELOG.md"
    printf '%s\n' 'tests/          export-ignore' '.gitattributes  export-ignore' > "$REPO/.gitattributes"
    printf '%s\n' "export const marker = '$HEAD_MARKER';" > "$REPO/functions/api/hello.js"

    # green stubs for the two halves of the test gate
    printf '%s\n' '#!/bin/bash' 'echo "SUMMARY: all checks passed"' > "$REPO/scripts/cycle-check.sh"
    printf '%s\n' \
        "const { test } = require('node:test');" \
        "const assert = require('node:assert/strict');" \
        "test('fixture suite is green', () => { assert.equal(1, 1); });" > "$REPO/tests/ok.test.js"

    cp "$DEPLOY_SRC" "$REPO/scripts/deploy.sh"
    chmod +x "$REPO/scripts/deploy.sh"

    # stub wrangler: records its CWD, its args, and what the Functions tree looked like from there
    STUB="$WORK/bin/wrangler"
    cat > "$STUB" <<'SH'
#!/bin/bash
pwd > "$STUB_CWD_FILE"
printf '%s\n' "$@" > "$STUB_ARGS_FILE"
cat functions/api/hello.js > "$STUB_FN_FILE" 2>/dev/null || echo "MISSING" > "$STUB_FN_FILE"
ls functions/api > "$STUB_FN_LS" 2>/dev/null || echo "MISSING" > "$STUB_FN_LS"
echo "stub wrangler: deployed $*"
SH
    chmod +x "$STUB"

    git init --quiet "$WORK/remote.git" --bare
    (
        cd "$REPO" || exit 1
        git init --quiet
        git symbolic-ref HEAD refs/heads/main  # portable across git defaults of master vs main
        git config user.name 'Fixture'
        git config user.email 'fixture@example.test'
        git add -A
        git commit --quiet -m 'v1.0.0 fixture'
        git remote add origin "$WORK/remote.git"
        git push --quiet -u origin main
    )
}

run_deploy() {  # runs the fixture's deploy.sh against the fixture repo; args passed through
    STUB_CWD_FILE="$WORK/wrangler-cwd" \
    STUB_ARGS_FILE="$WORK/wrangler-args" \
    STUB_FN_FILE="$WORK/wrangler-functions" \
    STUB_FN_LS="$WORK/wrangler-functions-ls" \
    RESPONDER_DEPLOY_WRANGLER="$WORK/bin/wrangler" \
    RESPONDER_DEPLOY_DIR="$WORK/deploy" \
    CLOUDFLARE_API_TOKEN='stub-token-not-a-real-credential' \
    bash "$REPO/scripts/deploy.sh" "$@" > "$WORK/run.out" 2>&1
    RC=$?
    rm -f "$WORK/wrangler-cwd.seen"
    return "$RC"
}

bump_tree_only() {  # bump every release-lane file in the working tree WITHOUT committing
    printf "%s\n" "const APP_VERSION = 'v9.9.9';" > "$REPO/js/core.js"
    sed -i 's/?v=1\.0\.0/?v=9.9.9/g' "$REPO/index.html"
    printf "%s\n" "const SW_VERSION = '9.9.9';" > "$REPO/sw.js"
    printf '%s\n' '{"versions":[{"v":"v9.9.9","d":"2026-07-24","items":[]}]}' > "$REPO/data/changelog.json"
    printf '%s\n' '## v9.9.9 (2026-07-24)' '' '- [New] uncommitted' > "$REPO/CHANGELOG.md"
}

dirty_functions() {  # one modified tracked Functions file plus one untracked one
    printf '%s\n' "export const marker = '$TREE_MARKER';" > "$REPO/functions/api/hello.js"
    printf '%s\n' "export const rogue = true;" > "$REPO/functions/api/rogue.js"
}

worktrees_clean() {  # only the main worktree may remain
    [ "$(git -C "$REPO" worktree list | wc -l)" -eq 1 ]
}

# --- Test 1: the version gate reads HEAD, not a bumped-but-uncommitted working tree -----
setup
bump_tree_only
run_deploy --skip-live --skip-tests
RC=$?
if [ "$RC" -eq 0 ] \
   && grep -q 'pre-flight OK: v1\.0\.0' "$WORK/run.out" \
   && ! grep -q 'pre-flight OK: v9\.9\.9' "$WORK/run.out" \
   && grep -q 'working tree is v9\.9\.9 but HEAD' "$WORK/run.out"; then
    pass "1 version gate reports HEAD v1.0.0 while the working tree sits at v9.9.9 (and says so)"
else
    fail "1 version gate reads HEAD (rc=${RC})"; cat "$WORK/run.out"
fi

# --- Test 2: the gated version is the version actually placed in the upload directory ----
if [ "$RC" -eq 0 ] \
   && grep -q "APP_VERSION = 'v1.0.0'" "$WORK/deploy/js/core.js" \
   && ! grep -q '9\.9\.9' "$WORK/deploy/index.html"; then
    pass "2 the upload directory holds the gated HEAD version, never the working-tree bump"
else
    fail "2 upload directory matches the gated version"; cat "$WORK/run.out"
fi
worktrees_clean || fail "2b a git worktree leaked after a successful deploy"
rm -rf "$WORK"

# --- Test 3/4: a dirty functions/ warns but still deploys, and never ships uncommitted code ---
setup
dirty_functions
run_deploy --skip-live --skip-tests
RC=$?
if [ "$RC" -eq 0 ] \
   && grep -q 'functions/ has uncommitted changes' "$WORK/run.out" \
   && grep -q 'static data still publishes' "$WORK/run.out" \
   && [ -s "$WORK/wrangler-args" ]; then
    pass "3 a dirty functions/ warns and still publishes (wrangler ran, cycle not aborted)"
else
    fail "3 dirty functions/ still publishes (rc=${RC})"; cat "$WORK/run.out"
fi
if grep -q "$HEAD_MARKER" "$WORK/wrangler-functions" \
   && ! grep -q "$TREE_MARKER" "$WORK/wrangler-functions" \
   && ! grep -q 'rogue' "$WORK/wrangler-functions-ls" \
   && grep -q "$HEAD_MARKER" "$WORK/deploy/functions/api/hello.js" \
   && [ ! -e "$WORK/deploy/functions/api/rogue.js" ]; then
    pass "4 uncommitted Functions code reaches neither wrangler's CWD nor the upload directory"
else
    fail "4 uncommitted Functions code never ships"
    echo "wrangler cwd: $(cat "$WORK/wrangler-cwd" 2>/dev/null)"
    echo "wrangler saw: $(cat "$WORK/wrangler-functions" 2>/dev/null)"
fi
worktrees_clean || fail "4b a git worktree leaked after a dirty-functions deploy"
rm -rf "$WORK"

# --- Test 5: --allow-dirty-functions still ships the uncommitted Functions on purpose ----
setup
dirty_functions
run_deploy --skip-live --skip-tests --allow-dirty-functions
RC=$?
if [ "$RC" -eq 0 ] \
   && grep -q 'allow-dirty-functions set' "$WORK/run.out" \
   && grep -q "$TREE_MARKER" "$WORK/wrangler-functions" \
   && grep -q 'rogue' "$WORK/wrangler-functions-ls"; then
    pass "5 --allow-dirty-functions still compiles the uncommitted Functions (escape hatch intact)"
else
    fail "5 --allow-dirty-functions escape hatch (rc=${RC})"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

# --- Test 6: the test gate runs against HEAD, so a red working tree cannot block a deploy ---
setup
printf '%s\n' '#!/bin/bash' 'echo "cycle-check: working-tree copy is broken"' 'exit 1' > "$REPO/scripts/cycle-check.sh"
printf '%s\n' \
    "const { test } = require('node:test');" \
    "const assert = require('node:assert/strict');" \
    "test('working-tree suite is red', () => { assert.equal(1, 2); });" > "$REPO/tests/ok.test.js"
run_deploy --skip-live
RC=$?
if [ "$RC" -eq 0 ] && grep -q 'test gate OK' "$WORK/run.out" && [ -s "$WORK/wrangler-args" ]; then
    pass "6 the test gate runs at HEAD: a red uncommitted suite does not block a green HEAD"
else
    fail "6 test gate runs at HEAD (rc=${RC})"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

# --- Test 7: a red suite AT HEAD still blocks, and --skip-tests still bypasses -----------
setup
printf '%s\n' \
    "const { test } = require('node:test');" \
    "const assert = require('node:assert/strict');" \
    "test('committed suite is red', () => { assert.equal(1, 2); });" > "$REPO/tests/ok.test.js"
( cd "$REPO" && git add -A && git commit --quiet -m 'commit a red suite' )
run_deploy --skip-live
RC=$?
if [ "$RC" -ne 0 ] && grep -q 'test gate: node --test tests/ failed at HEAD' "$WORK/run.out" \
   && [ ! -s "$WORK/wrangler-args" ]; then
    pass "7 a red suite at HEAD still blocks the deploy (wrangler never runs)"
else
    fail "7 red HEAD suite blocks (rc=${RC})"; cat "$WORK/run.out"
fi
worktrees_clean || fail "7b a git worktree leaked after a failed deploy"
run_deploy --skip-live --skip-tests
RC=$?
if [ "$RC" -eq 0 ] && grep -q 'TEST GATE BYPASSED' "$WORK/run.out" && [ -s "$WORK/wrangler-args" ]; then
    pass "8 --skip-tests still bypasses a red HEAD suite (emergency flag intact)"
else
    fail "8 --skip-tests emergency bypass (rc=${RC})"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

echo "----"
if [ "$FAILS" -eq 0 ]; then
    echo "ALL DEPLOY GATE TESTS PASSED"
    exit 0
else
    echo "${FAILS} TEST(S) FAILED"
    exit 1
fi
