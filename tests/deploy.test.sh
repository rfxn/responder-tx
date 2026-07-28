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
#   9 the strip gate reports the CDN edge, not just the origin (v0.98.10): every stripped path
#     is asked for twice, and an edge still serving one warns by name without failing the deploy
#  10 a stripped path still live at the ORIGIN is a release defect and still fails
#  12 the field-intake markup is stripped from the artifact and kept whole at HEAD (v0.98.11),
#     and markup left unmarked fails the deploy rather than shipping
#  22 the gate covers the python suites, not just node: a red one at HEAD blocks
#  23 the gate covers the shell suites too, and a red one at HEAD blocks
#  24 the shell suites are re-run exactly when scripts/ or tests/ change, and a red run
#     records no green key
#  25 an uncommitted data/event.json warns loudly and still deploys HEAD's copy
#  26 --skip-tests taints the sign-off line and leaves a durable record
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
    # the intake markup and its markers are part of the fixture: the strip gate is asserted on the
    # artifact, so a fixture without them would let a no-op strip pass every test below
    printf '%s\n' \
        '<!doctype html><html><head>' \
        '<link rel="stylesheet" href="css/app.css?v=1.0.0">' \
        '<script src="js/core.js?v=1.0.0"></script>' \
        '</head><body>board' \
        '<div class="feed-actions">' \
        '  <!-- lan-only:intake -->' \
        '  <button id="toggle-form" hidden>New notice</button>' \
        '  <!-- /lan-only:intake -->' \
        '  <button id="sitrep-btn">SITREP</button>' \
        '</div>' \
        '<!-- lan-only:intake -->' \
        '<form id="new-request-form"><input id="f-place"><button type="submit">Add</button></form>' \
        '<!-- /lan-only:intake -->' \
        '</body></html>' > "$REPO/index.html"
    printf "%s\n" "const SW_VERSION = '1.0.0';" > "$REPO/sw.js"
    printf '%s\n' '{"versions":[{"v":"v1.0.0","d":"2026-07-24","items":[]}]}' > "$REPO/data/changelog.json"
    printf '%s\n' '{"version": "v1.0.0"}' > "$REPO/data/version.json"
    printf '%s\n' '## v1.0.0 (2026-07-24)' '' '- [New] fixture release' > "$REPO/CHANGELOG.md"
    printf '%s\n' 'tests/          export-ignore' '.gitattributes  export-ignore' > "$REPO/.gitattributes"
    printf '%s\n' "export const marker = '$HEAD_MARKER';" > "$REPO/functions/api/hello.js"

    # the AO config the client reads; deploy.sh warns when the tree copy diverges from HEAD's
    printf '%s\n' '{"name":"Fixture Event","center":[30.0,-98.0],"zoom":9}' > "$REPO/data/event.json"

    # green stubs for every half of the test gate. tests/run.sh is the real one: the gate reads its
    # suite set from that file, so a fixture with a hand-written substitute would gate on different
    # code than production does.
    printf '%s\n' '#!/bin/bash' 'echo "SUMMARY: all checks passed"' > "$REPO/scripts/cycle-check.sh"
    cp "$REPO_ROOT/tests/run.sh" "$REPO/tests/run.sh"
    printf '%s\n' \
        "const { test } = require('node:test');" \
        "const assert = require('node:assert/strict');" \
        "test('fixture suite is green', () => { assert.equal(1, 1); });" > "$REPO/tests/ok.test.js"
    printf '%s\n' 'print("PASS: fixture python suite is green")' > "$REPO/tests/ok.test.py"
    printf '%s\n' '#!/bin/bash' 'echo "PASS: fixture shell suite is green"' > "$REPO/tests/ok.test.sh"

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
    RESPONDER_DEPLOY_SHELL_MARKER="$WORK/shell-gate.key" \
    RESPONDER_DEPLOY_BYPASS_LOG="$WORK/bypass.log" \
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
    printf '%s\n' '{"version": "v9.9.9"}' > "$REPO/data/version.json"
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
printf '%s\n' 'raise SystemExit("FAIL: working-tree python suite is red")' > "$REPO/tests/ok.test.py"
printf '%s\n' '#!/bin/bash' 'echo "FAIL: working-tree shell suite is red"' 'exit 1' > "$REPO/tests/ok.test.sh"
run_deploy --skip-live
RC=$?
if [ "$RC" -eq 0 ] && grep -q 'test gate OK' "$WORK/run.out" && [ -s "$WORK/wrangler-args" ]; then
    pass "6 the test gate runs at HEAD: a red uncommitted node/python/shell suite does not block a green HEAD"
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

# --- Tests 9-11: the post-deploy strip gate must measure what a browser gets -------------------
# The gate asked for every stripped path with a cache-buster, which reaches the origin, and
# reported the answer as if it were what a real client receives. Confirmed live on 2026-07-25:
# https://respondertx.org/js/notes.js answered 404 with ?_cb= and 200 plain, because a zone-level
# Cloudflare cache rule (max-age=14400) overrides this repo's _headers. The origin stays the
# pass/fail condition (it is the only half a deploy controls); the edge is reported, never fatal.
stub_network() {  # PATH stubs for the live-smoke step: curl answers per test, sleep never waits
    cat > "$WORK/bin/curl" <<'SH'
#!/bin/bash
url="${!#}"  # last argument is the URL
# The strip gate asks for a status code; the version poll and the bundle gate want a body. Keying
# on -w rather than on the URL keeps a js/ path from being answered by the wrong half.
wants_code=0
for a in "$@"; do
    if [ "$a" = '%{http_code}' ]; then wants_code=1; fi
done
if [ "$wants_code" -eq 0 ]; then
    case "$url" in
        *changelog.json*) printf '{"versions":[{"v":"%s"}]}\n' "${STUB_LIVE_VERSION:-v1.0.0}"; exit 0 ;;
    esac
    asset="${url#https://respondertx.org/}"
    asset="${asset%%\?*}"
    # an asset named in STUB_BUNDLE_STALE answers with the PREVIOUS build's bytes until it has done
    # so STUB_BUNDLE_HEAL times, which is how an edge entry behaves until it revalidates
    for p in ${STUB_BUNDLE_STALE:-}; do
        if [ "$p" = "$asset" ]; then
            n_file="$STUB_COUNT_DIR/${asset//\//_}"
            n=$(cat "$n_file" 2>/dev/null || echo 0)  # first request for this asset has no counter yet
            n=$((n + 1))
            echo "$n" > "$n_file"
            if [ "$n" -le "${STUB_BUNDLE_HEAL:-9999}" ]; then printf 'STALE-PREVIOUS-BUILD\n'; exit 0; fi
        fi
    done
    if [ -f "$STUB_DEPLOY_DIR/$asset" ]; then cat "$STUB_DEPLOY_DIR/$asset"; exit 0; fi
    exit 22
fi
path="${url#https://respondertx.org/}"
if [ "$path" = "${path%%\?*}" ]; then   # no cache-buster: this request reaches the CDN edge
    for p in ${STUB_EDGE_200:-}; do
        if [ "$p" = "$path" ]; then printf '200'; exit 0; fi
    done
    printf '404'; exit 0
fi
path="${path%%\?*}"                     # cache-busted: this request reaches the origin
for p in ${STUB_ORIGIN_200:-}; do
    if [ "$p" = "$path" ]; then printf '200'; exit 0; fi
done
printf '404'
SH
    printf '%s\n' '#!/bin/bash' 'exit 0' > "$WORK/bin/sleep"  # the gate's CDN-propagation backoff
    chmod +x "$WORK/bin/curl" "$WORK/bin/sleep"
}

# $1 = paths the EDGE still serves, $2 = paths the ORIGIN still serves. Passed as arguments, not
# as an env prefix: bash leaves a prefix assignment on a shell function set in the caller, and a
# leaked STUB_EDGE_200 would silently make the clean-run test pass for the wrong reason.
# $3 = assets the edge serves from the PREVIOUS build, $4 = how many such answers before it heals
run_live_deploy() {
    local old_path=$PATH rc
    export STUB_EDGE_200="${1:-}" STUB_ORIGIN_200="${2:-}"
    export STUB_BUNDLE_STALE="${3:-}" STUB_BUNDLE_HEAL="${4:-9999}"
    export STUB_DEPLOY_DIR="$WORK/deploy" STUB_COUNT_DIR="$WORK/bundle-counts"
    rm -rf "$STUB_COUNT_DIR"
    mkdir -p "$STUB_COUNT_DIR"
    PATH="$WORK/bin:$PATH"
    run_deploy --skip-tests
    rc=$?
    PATH="$old_path"
    return "$rc"
}

setup
stub_network
run_live_deploy "js/notes.js" ""
RC=$?
if [ "$RC" -eq 0 ] \
   && grep -q 'STILL SERVING stripped paths' "$WORK/run.out" \
   && grep -q 'js/notes.js (HTTP 200)' "$WORK/run.out" \
   && grep -q 'zone-level Cloudflare cache' "$WORK/run.out" \
   && grep -q 'OK: v1\.0\.0 live' "$WORK/run.out"; then
    pass "9 an edge still serving a stripped path warns by name and does not fail the deploy"
else
    fail "9 edge-serving warning is surfaced, non-fatally (rc=${RC})"; cat "$WORK/run.out"
fi

# MUTATION: the file is genuinely still in the deployment, not merely cached at the edge
run_live_deploy "js/notes.js" "js/notes.js"
RC=$?
if [ "$RC" -ne 0 ] && grep -q 'live js/notes.js returned HTTP 200 from the origin' "$WORK/run.out"; then
    pass "10 MUTATION · a stripped path still live at the ORIGIN still fails the deploy"
else
    fail "10 origin 200 must stay fatal (rc=${RC})"; cat "$WORK/run.out"
fi

run_live_deploy "" ""
RC=$?
if [ "$RC" -eq 0 ] \
   && grep -q 'strip gate OK: origin and CDN edge both 404' "$WORK/run.out" \
   && ! grep -q 'STILL SERVING' "$WORK/run.out"; then
    pass "11 a clean edge and origin report one line and no warning"
else
    fail "11 clean strip gate reports both halves (rc=${RC})"; cat "$WORK/run.out"
fi

# --- Tests 18-21: success must mean the served JS bundle is coherent, not that one JSON updated ---
# Immediately after the v0.99.60 upload the site served the new core.js beside the previous
# sources.js under one ?v=0.99.60 key, so the release's fix was absent from a page that reported
# the new version. deploy.sh still printed "OK: v0.99.60 live" because it judged the release on
# changelog.json, which was already correct. A stale core.js under a fresh boot.js is a failed
# start, so the gate reads the URLs a browser requests and compares them to the uploaded bytes.
run_live_deploy "" ""
RC=$?
if [ "$RC" -eq 0 ] \
   && grep -q 'bundle gate OK: 2 served assets byte-identical to the v1\.0\.0 artifact' "$WORK/run.out"; then
    pass "18 a coherent bundle passes, and the gate reports how many assets it actually read"
else
    fail "18 a coherent bundle passes the gate (rc=${RC})"; cat "$WORK/run.out"
fi

# MUTATION · changelog.json answers v1.0.0 throughout, so this can fail only because a served
# SCRIPT disagrees. That is exactly the state the old gate reported as a successful release.
run_live_deploy "" "" "js/core.js"
RC=$?
if [ "$RC" -ne 0 ] \
   && grep -q 'live JS bundle never became coherent at v1\.0\.0' "$WORK/run.out" \
   && grep -q 'js/core.js (served' "$WORK/run.out" \
   && ! grep -q 'OK: v1\.0\.0 live' "$WORK/run.out"; then
    pass "19 MUTATION · a served script that disagrees fails the deploy, though changelog.json is right"
else
    fail "19 a stale served script must fail the deploy (rc=${RC})"; cat "$WORK/run.out"
fi

# MUTATION · the asset list is not merely index.html's scripts; sw.js carries the precache manifest
run_live_deploy "" "" "sw.js"
RC=$?
if [ "$RC" -ne 0 ] && grep -q 'sw.js (served' "$WORK/run.out"; then
    pass "20 MUTATION · a stale served sw.js fails the deploy too, so the gate covers the worker"
else
    fail "20 a stale sw.js must fail the deploy (rc=${RC})"; cat "$WORK/run.out"
fi

# A brief edge inconsistency is expected under the zone cache rule and clears on revalidation. It
# must not fail a deploy that actually succeeded, and the wait must be reported rather than hidden.
run_live_deploy "" "" "js/core.js" 2
RC=$?
if [ "$RC" -eq 0 ] \
   && grep -q 'live bundle not yet coherent at v1\.0\.0 (attempt 1/13)' "$WORK/run.out" \
   && grep -q 'bundle gate OK' "$WORK/run.out" \
   && grep -q 'OK: v1\.0\.0 live' "$WORK/run.out"; then
    pass "21 a bundle that heals inside the window still passes, and the wait is logged"
else
    fail "21 a brief edge inconsistency must not fail a good deploy (rc=${RC})"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

# --- Tests 12-14: the field-intake markup is operator-only and must not reach the mirror --------
# ~45 lines of intake form shipped to every public page load while being unreachable there since
# v0.98.6 (entry point withdrawn, submit refused with no ops backend). The markup is now stripped
# from the artifact only; HEAD keeps it whole, because the LAN operator build files real notices.
setup
run_deploy --skip-live --skip-tests
RC=$?
if [ "$RC" -eq 0 ] \
   && ! grep -q 'new-request-form' "$WORK/deploy/index.html" \
   && ! grep -q 'toggle-form' "$WORK/deploy/index.html" \
   && ! grep -q 'f-place' "$WORK/deploy/index.html" \
   && ! grep -q 'lan-only:intake' "$WORK/deploy/index.html" \
   && grep -q 'intake strip: removed 2 lan-only:intake region(s)' "$WORK/run.out"; then
    pass "12 the deploy index.html carries no field-intake markup, markers included"
else
    fail "12 intake markup is stripped from the artifact (rc=${RC})"; cat "$WORK/run.out"
fi

# the strip is surgical: its siblings inside the same container survive, and HEAD keeps the form
if grep -q 'id="sitrep-btn"' "$WORK/deploy/index.html" \
   && grep -q 'class="feed-actions"' "$WORK/deploy/index.html" \
   && grep -q 'id="new-request-form"' "$REPO/index.html"; then
    pass "13 the strip removes only the marked regions; siblings and the HEAD copy are untouched"
else
    fail "13 strip is surgical and HEAD keeps the intake form"; cat "$WORK/deploy/index.html"
fi

# MUTATION: markup present but markers gone. The strip finds nothing to do and the artifact would
# ship the form; asserting on the RESULT rather than a region count is what catches it.
sed -i '/lan-only:intake/d' "$REPO/index.html"
( cd "$REPO" && git commit --quiet -am 'drop the intake strip markers' )
run_deploy --skip-live --skip-tests
RC=$?
if [ "$RC" -ne 0 ] && grep -q 'field-intake markup still present in the deploy index.html' "$WORK/run.out"; then
    pass "14 MUTATION · intake markup with no markers fails the deploy instead of shipping"
else
    fail "14 an unmarked intake form must not reach the artifact (rc=${RC})"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

# --- Tests 15-17: staging is per-run, so two deploys can never share a directory -----------------
# A hand-run deploy died with ENOENT on data/history.json because the 8,23,38,53 cron deploy was
# building into the same fixed /tmp/responder-deploy and `rm -rf`d it mid-archive.
setup

# a wrangler that lingers, so the two runs' staging windows genuinely overlap
cat > "$WORK/bin/wrangler" <<'SH'
#!/bin/bash
sleep 3
echo "stub wrangler: deployed $*"
SH
chmod +x "$WORK/bin/wrangler"

# deploy.sh with NO RESPONDER_DEPLOY_DIR: the default per-run staging path. `env -u` enforces that
# rather than assuming it, because this suite now runs inside deploy.sh's own test gate, where an
# ambient RESPONDER_DEPLOY_DIR from the outer run would pin every "unpinned" deploy to one path.
run_unpinned() {
    RESPONDER_DEPLOY_WRANGLER="$WORK/bin/wrangler" \
    RESPONDER_DEPLOY_BYPASS_LOG="$WORK/bypass.log" \
    CLOUDFLARE_API_TOKEN='stub-token-not-a-real-credential' \
    env -u RESPONDER_DEPLOY_DIR -u RESPONDER_DEPLOY_SHELL_MARKER \
        bash "$REPO/scripts/deploy.sh" --skip-live --skip-tests > "$1" 2>&1
}

run_unpinned "$WORK/conc-a.out" & A=$!
run_unpinned "$WORK/conc-b.out" & B=$!
wait "$A"; RC_A=$?
wait "$B"; RC_B=$?
DIR_A=$(sed -n 's/.*absent from \(.*\)$/\1/p' "$WORK/conc-a.out")
DIR_B=$(sed -n 's/.*absent from \(.*\)$/\1/p' "$WORK/conc-b.out")
if [ "$RC_A" -eq 0 ] && [ "$RC_B" -eq 0 ] \
   && [ -n "$DIR_A" ] && [ -n "$DIR_B" ] && [ "$DIR_A" != "$DIR_B" ] \
   && ! grep -q 'No such file or directory' "$WORK/conc-a.out" "$WORK/conc-b.out"; then
    pass "15 two concurrent deploys both finish, in different staging dirs ($(basename "$DIR_A") vs $(basename "$DIR_B"))"
else
    fail "15 concurrent deploys collided (rc ${RC_A}/${RC_B}, dirs '${DIR_A}' vs '${DIR_B}')"
    cat "$WORK/conc-a.out" "$WORK/conc-b.out"
fi

# the strip-verify assertions still run, and still run against the new per-run path
if grep -q "strip-verify OK: v1.0.0 archive, chat + master + notes + ops-scripts + field-intake markup absent from ${DIR_A}" "$WORK/conc-a.out" \
   && [ ! -e "$DIR_A" ] && [ ! -e "$DIR_B" ]; then
    pass "16 strip-verify ran against the per-run staging dir, and both dirs are gone after exit"
else
    fail "16 strip-verify path + cleanup (A exists: $([ -e "$DIR_A" ] && echo yes || echo no))"
    cat "$WORK/conc-a.out"
fi

# a failing run must not leave staging behind either. wrangler is made to fail so the run gets
# past strip-verify and names its staging dir, which is then asserted on directly rather than by
# scanning /tmp (a live production deploy has a dir of the same shape in flight).
printf '%s\n' '#!/bin/bash' 'echo "stub wrangler: refusing"; exit 1' > "$WORK/bin/wrangler"
chmod +x "$WORK/bin/wrangler"
run_unpinned "$WORK/conc-fail.out"
RC=$?
DIR_F=$(sed -n 's/.*absent from \(.*\)$/\1/p' "$WORK/conc-fail.out")
if [ "$RC" -ne 0 ] && [ -n "$DIR_F" ] && [ ! -e "$DIR_F" ] \
   && grep -q 'wrangler pages deploy failed' "$WORK/conc-fail.out"; then
    pass "17 a failed deploy removes its staging dir on the way out ($(basename "$DIR_F") gone)"
else
    fail "17 failed deploy left staging behind (rc=${RC}, dir='${DIR_F}')"
    cat "$WORK/conc-fail.out"
fi
rm -rf "$WORK"

# --- Tests 22-26: the gate covers every suite, not just node --------------------------------------
# It ran node --test and cycle-check.sh only, so the python suites never gated a release at all:
# gen-feeds.test.py, which guards the failed-fetch-is-not-a-zero rule, was among them.
setup
printf '%s\n' 'raise SystemExit("gen-feeds: a failed fetch became a published zero")' > "$REPO/tests/ok.test.py"
( cd "$REPO" && git add -A && git commit --quiet -m 'commit a red python suite' )
run_deploy --skip-live
RC=$?
if [ "$RC" -ne 0 ] \
   && grep -q 'test gate: the python suites failed at HEAD' "$WORK/run.out" \
   && [ ! -s "$WORK/wrangler-args" ]; then
    pass "22 MUTATION · a red python suite at HEAD blocks the deploy (wrangler never runs)"
else
    fail "22 a red python suite must block (rc=${RC})"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

setup
printf '%s\n' '#!/bin/bash' 'echo "FAIL: committed shell suite is red"' 'exit 1' > "$REPO/tests/ok.test.sh"
( cd "$REPO" && git add -A && git commit --quiet -m 'commit a red shell suite' )
run_deploy --skip-live
RC=$?
if [ "$RC" -ne 0 ] \
   && grep -q 'test gate: the shell suites failed at HEAD' "$WORK/run.out" \
   && [ ! -s "$WORK/wrangler-args" ]; then
    pass "23 MUTATION · a red shell suite at HEAD blocks the deploy (wrangler never runs)"
else
    fail "23 a red shell suite must block (rc=${RC})"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

# --- Test 24: the shell suites cost ~95s and read nothing but scripts/ and tests/, so the gate
# re-runs them exactly when that pair changes. A cached verdict that survived a code change would
# be the same silent-invalidation shape the gate exists to close, so both halves are asserted.
setup
run_deploy --skip-live
RC=$?
FIRST_KEY=$(cat "$WORK/shell-gate.key" 2>/dev/null)
if [ "$RC" -eq 0 ] && grep -q 'shell suites green at scripts+tests' "$WORK/run.out" && [ -n "$FIRST_KEY" ]; then
    pass "24 the first deploy at a given scripts+tests pair runs the shell suites and records the key"
else
    fail "24 first deploy must run the shell suites (rc=${RC})"; cat "$WORK/run.out"
fi

run_deploy --skip-live
if grep -q 'shell suites already green at scripts+tests' "$WORK/run.out" \
   && ! grep -q 'shell suites green at scripts+tests' "$WORK/run.out"; then
    pass "24b an unchanged scripts+tests pair does not pay for the shell suites twice"
else
    fail "24b an unchanged code pair must skip the shell suites"; cat "$WORK/run.out"
fi

run_deploy --skip-live --full-tests
if grep -q 'shell suites green at scripts+tests' "$WORK/run.out"; then
    pass "24c --full-tests forces the shell suites even on a recorded-green pair"
else
    fail "24c --full-tests must force the shell suites"; cat "$WORK/run.out"
fi

# MUTATION · commit a RED shell suite over the recorded-green key. If the cached verdict were keyed
# on anything but the content of scripts/ and tests/, this deploy would sail through.
printf '%s\n' '#!/bin/bash' 'echo "FAIL: committed shell suite is red"' 'exit 1' > "$REPO/tests/ok.test.sh"
( cd "$REPO" && git add -A && git commit --quiet -m 'commit a red shell suite over a green key' )
run_deploy --skip-live
RC=$?
SECOND_KEY=$(cat "$WORK/shell-gate.key" 2>/dev/null)
if [ "$RC" -ne 0 ] \
   && grep -q 'test gate: the shell suites failed at HEAD' "$WORK/run.out" \
   && [ "$SECOND_KEY" = "$FIRST_KEY" ]; then
    pass "24d MUTATION · changing tests/ invalidates the recorded key, and a red run never records one"
else
    fail "24d a changed scripts+tests pair must re-run and must not record a red verdict (rc=${RC})"
    cat "$WORK/run.out"
fi
rm -rf "$WORK"

# --- Test 24e: the key covers scripts/ and tests/, and that is only sound while no shell suite
# reads anything else. Asserted, not assumed: a suite that grew a dependency on js/ or data/ would
# let a recorded key read green after the tree it actually depends on changed, which is the exact
# silent-invalidation shape the gate exists to close. Static, like the RESPONDER_ROOT check in
# tests/run-cycle.test.sh, because the failure it catches is a read that never announces itself.
OUTSIDE=()
while IFS= read -r ref; do
    case "$ref" in
        */scripts|*/scripts/*|*/tests|*/tests/*) ;;
        *) OUTSIDE+=("$ref") ;;
    esac
done < <(grep -hoE '\$\{?REPO_ROOT\}?/[A-Za-z0-9_./-]*' "$REPO_ROOT"/tests/*.test.sh | sort -u)
if [ "${#OUTSIDE[@]}" -eq 0 ]; then
    pass "24e every shell suite reads only scripts/ and tests/, which is what the gate key covers"
else
    fail "24e a shell suite reads outside the gate key's scripts+tests pair: ${OUTSIDE[*]}"
fi

# --- Test 25: an uncommitted data/event.json is a split brain, warned about, never fatal ----------
# The generators read the working-tree copy; this artifact is `git archive HEAD`. A killed recovery
# session left exactly this state and widened the AO with nobody seeing it (CLAUDE.md E2/E3).
setup
run_deploy --skip-live --skip-tests
if ! grep -q 'data/event.json does not match HEAD' "$WORK/run.out"; then
    pass "25 a committed data/event.json produces no divergence warning"
else
    fail "25 a clean event.json must not warn"; cat "$WORK/run.out"
fi

printf '%s\n' '{"name":"Re-targeted Basin","center":[31.5,-97.1],"zoom":11}' > "$REPO/data/event.json"
run_deploy --skip-live --skip-tests
RC=$?
if [ "$RC" -eq 0 ] \
   && grep -q 'data/event.json does not match HEAD' "$WORK/run.out" \
   && grep -q 'map centre, AO pills' "$WORK/run.out" \
   && grep -q 'Re-targeted Basin' "$WORK/run.out" \
   && grep -q 'Fixture Event' "$WORK/deploy/data/event.json" \
   && [ -s "$WORK/wrangler-args" ]; then
    pass "25b MUTATION · an uncommitted event.json warns loudly, names the diff, and still deploys HEAD's"
else
    fail "25b the event.json divergence must warn without failing the deploy (rc=${RC})"; cat "$WORK/run.out"
fi
rm -rf "$WORK"

# --- Test 26: a bypassed gate may not sign off like a gated one -----------------------------------
setup
run_deploy --skip-live --skip-tests
RC=$?
if [ "$RC" -eq 0 ] \
   && grep -q 'TEST GATE BYPASSED via --skip-tests' "$WORK/run.out" \
   && grep -q -- '--skip-tests v1.0.0 @' "$WORK/bypass.log"; then
    pass "26 --skip-tests taints the sign-off line and leaves a durable record of the bypass"
else
    fail "26 a bypass must be visible in the sign-off and recorded (rc=${RC})"
    cat "$WORK/run.out"; cat "$WORK/bypass.log" 2>/dev/null
fi

run_deploy --skip-live
if grep -q 'test gate OK' "$WORK/run.out" && ! grep -q 'TEST GATE BYPASSED' "$WORK/run.out"; then
    pass "26b a gated deploy signs off without the bypass marker"
else
    fail "26b a gated deploy must not claim a bypass"; cat "$WORK/run.out"
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
