#!/bin/bash
# deploy.sh [--preflight-only] [--skip-live] [--skip-tests] [--allow-dirty-functions] — gate HEAD, build the stripped archive, deploy to Cloudflare Pages
set -euo pipefail

cd "$(dirname "$0")/.." || exit 1
REPO_ROOT="$PWD"

SKIP_LIVE=0
PREFLIGHT_ONLY=0
SKIP_TESTS=0
ALLOW_DIRTY_FUNCTIONS=0
for arg in "$@"; do
    case "$arg" in
        --skip-live) SKIP_LIVE=1 ;;
        --preflight-only) PREFLIGHT_ONLY=1 ;;
        --skip-tests) SKIP_TESTS=1 ;;
        --allow-dirty-functions) ALLOW_DIRTY_FUNCTIONS=1 ;;
        *) echo "FAIL: unknown argument: $arg (supported: --preflight-only, --skip-live, --skip-tests, --allow-dirty-functions)" >&2; exit 2 ;;
    esac
done

fail() { echo "FAIL: $*" >&2; exit 1; }

WRANGLER="${RESPONDER_DEPLOY_WRANGLER:-wrangler}"
deploy_dir="${RESPONDER_DEPLOY_DIR:-/tmp/responder-deploy}"
case "$deploy_dir" in
    /*) ;;
    *) fail "RESPONDER_DEPLOY_DIR must be an absolute path, got '${deploy_dir}'" ;;
esac

# --- Materialize HEAD. The version gate, the test gate, and the Functions tree wrangler compiles
# all read from here, so a working-tree edit can neither block a deploy nor contaminate one. ---
SRC=$(mktemp -d "${TMPDIR:-/tmp}/responder-src.XXXXXX") || fail "mktemp for the HEAD source tree failed"
cleanup() {
    rc=$?
    cd "$REPO_ROOT" || exit "$rc"
    git worktree remove --force "$SRC" >/dev/null 2>&1 || rm -rf "$SRC"  # remove is the clean path; rm covers a half-created worktree
    git worktree prune >/dev/null 2>&1 || :  # a stale admin entry is cosmetic, never worth failing a deploy over
    exit "$rc"
}
trap cleanup EXIT
git worktree add --detach "$SRC" HEAD >/dev/null || fail "could not check HEAD out to ${SRC}"
head_commit=$(git rev-parse --short HEAD) || fail "git rev-parse HEAD failed"

# --- Pre-flight: functions/ hygiene. wrangler compiles functions/ from its CWD, which is the HEAD
# tree above, so uncommitted Functions code cannot ship by accident and no longer aborts the cycle. ---
dirty_functions=$(git status --porcelain --untracked-files=all -- functions/) || fail "git status check on functions/ failed"
if [ -n "$dirty_functions" ]; then
    if [ "$ALLOW_DIRTY_FUNCTIONS" -eq 1 ]; then
        echo "##########################################################" >&2
        echo "# WARNING: --allow-dirty-functions set: DEPLOYING WITH   #" >&2
        echo "# UNCOMMITTED functions/ CODE. wrangler will compile and #" >&2
        echo "# SHIP these files to production Pages Functions:        #" >&2
        echo "##########################################################" >&2
        echo "$dirty_functions" >&2
        echo "# This flag is for genuine field emergencies only." >&2
        rm -rf "$SRC/functions"
        cp -a functions "$SRC/functions" || fail "could not overlay the working-tree functions/ onto ${SRC}"
    else
        echo "NOTE: functions/ has uncommitted changes; shipping HEAD (${head_commit}) Functions instead:" >&2
        echo "$dirty_functions" >&2
        echo "NOTE: static data still publishes. Commit the Functions work, or pass --allow-dirty-functions to ship it." >&2
    fi
fi

# --- Pre-flight: four-way version agreement, read from HEAD because HEAD is what ships ---
version=$(grep -oP "APP_VERSION = '\K[^']+" "$SRC/js/core.js") || fail "cannot extract APP_VERSION from HEAD js/core.js"
[ -n "$version" ] || fail "APP_VERSION extracted from HEAD js/core.js is empty"
stamp_version="${version#v}"

tree_version=$(grep -oP "APP_VERSION = '\K[^']+" js/core.js) || tree_version=''  # an edited/absent tree copy is not fatal: HEAD is authoritative
if [ -n "$tree_version" ] && [ "$tree_version" != "$version" ]; then
    echo "NOTE: working tree is ${tree_version} but HEAD (${head_commit}) is ${version}; ${version} is what deploys." >&2
fi

stamps=$(grep -o '?v=[^"]*' "$SRC/index.html") || fail "no ?v= stamps found in HEAD index.html"
stamp_count=0
while IFS= read -r stamp; do
    stamp_count=$((stamp_count + 1))
    [ "$stamp" = "?v=${stamp_version}" ] || fail "index.html stamp mismatch: '${stamp}' (expected '?v=${stamp_version}')"
done <<< "$stamps"
[ "$stamp_count" -gt 0 ] || fail "no ?v= stamps found in HEAD index.html"

cl_version=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['versions'][0]['v'])" "$SRC/data/changelog.json") \
    || fail "cannot read versions[0].v from HEAD data/changelog.json"
[ "$cl_version" = "$version" ] || fail "data/changelog.json versions[0].v is '${cl_version}', expected '${version}'"

sw_version=$(grep -m1 -oP "SW_VERSION = '\K[^']+" "$SRC/sw.js") || fail "cannot extract SW_VERSION from HEAD sw.js"
[ "$sw_version" = "$stamp_version" ] || fail "sw.js SW_VERSION is '${sw_version}', expected '${stamp_version}'"

heading_re="^## ${version//./\\.} "
grep -qE "$heading_re" "$SRC/CHANGELOG.md" || fail "CHANGELOG.md has no '## ${version} ' heading"

echo "pre-flight OK: ${version} @ ${head_commit} (${stamp_count} index.html stamps, changelog.json, CHANGELOG.md all agree)"

# --- Pre-flight: test gate (never ship on a red suite; --skip-tests is for genuine field emergencies only) ---
if [ "$SKIP_TESTS" -eq 1 ]; then
    echo "##########################################################" >&2
    echo "# WARNING: --skip-tests set: TEST GATE BYPASSED.         #" >&2
    echo "# Deploying WITHOUT running node --test / cycle-check.   #" >&2
    echo "# This flag is for genuine field emergencies only.       #" >&2
    echo "##########################################################" >&2
else
    ( cd "$SRC" && node --test tests/ ) || fail "test gate: node --test tests/ failed at HEAD (fix it, or --skip-tests for a genuine field emergency)"
    ( cd "$SRC" && bash scripts/cycle-check.sh ) || fail "test gate: scripts/cycle-check.sh failed at HEAD (fix it, or --skip-tests for a genuine field emergency)"
    echo "test gate OK: node --test tests/ + cycle-check.sh green at HEAD"
fi

# --- Build stripped deploy dir ---
rm -rf "$deploy_dir"
mkdir -p "$deploy_dir"
git archive HEAD | tar -x -C "$deploy_dir" || fail "git archive extraction failed"
rm -f "$deploy_dir/js/chat.js"
rm -f "$deploy_dir/js/master.js"
# Field Notes is disabled and LAN-only; boot.js injects it on ?notes/?note, so the mirror needs neither file
rm -f "$deploy_dir/js/notes.js"
rm -f "$deploy_dir/css/notes.css"
# ops-side code no browser can execute: the cycle/chat/deploy scripts and the LAN server, which
# together carry the ops host's absolute paths, its cron lines and the whole /api/chat plumbing
rm -rf "$deploy_dir/scripts"
rm -f "$deploy_dir/server.py"
rm -f "$deploy_dir/.gitignore"
printf '{"messages":[]}\n' > "$deploy_dir/data/chat-outbox.json"

# --- Strip-verify before upload ---
[ ! -e "$deploy_dir/js/chat.js" ] || fail "js/chat.js still present in deploy dir"
[ ! -e "$deploy_dir/js/master.js" ] || fail "js/master.js still present in deploy dir"
[ ! -e "$deploy_dir/js/notes.js" ] || fail "js/notes.js still present in deploy dir"
[ ! -e "$deploy_dir/css/notes.css" ] || fail "css/notes.css still present in deploy dir"
[ ! -e "$deploy_dir/scripts" ] || fail "scripts/ present in deploy dir"
[ ! -e "$deploy_dir/server.py" ] || fail "server.py present in deploy dir"
[ ! -e "$deploy_dir/HANDOFF.md" ] || fail "HANDOFF.md present in deploy dir"
[ ! -e "$deploy_dir/data/chat-inbox.jsonl" ] || fail "data/chat-inbox.jsonl present in deploy dir"
# recovery archive is git-tracked but must never be published: hundreds of MB and non-public provenance
[ ! -e "$deploy_dir/archive" ] || fail "archive/ present in deploy dir (.gitattributes export-ignore not applied)"
# the chunked playback record must ship whole: the client asks for the index before any day file
if [ -e "$SRC/history/index.json" ]; then
    [ -f "$deploy_dir/history/index.json" ] || fail "history/index.json is at HEAD but missing from the deploy dir"
    [ -d "$deploy_dir/history/day" ] || fail "history/day/ is at HEAD but missing from the deploy dir"
fi
if grep -rq 'api/chat' "$deploy_dir/js" "$deploy_dir/index.html"; then
    fail "api/chat reference found in deploy dir js/ or index.html"
fi
# index.html must never statically reference a stripped client (boot.js injects them at runtime)
if grep -q 'js/master\.js\|js/chat\.js\|js/notes\.js\|css/notes\.css' "$deploy_dir/index.html"; then
    fail "stripped client (chat/master/notes) statically referenced in deploy index.html"
fi
[ -f "$deploy_dir/sw.js" ] || fail "sw.js missing from deploy dir"
if grep -q 'js/chat\.js\|js/master\.js\|js/notes\.js\|css/notes\.css' "$deploy_dir/sw.js"; then
    fail "stripped client (chat/master/notes) precached in deploy sw.js"
fi
archive_version=$(grep -oP "APP_VERSION = '\K[^']+" "$deploy_dir/js/core.js") || fail "cannot extract APP_VERSION from the deploy dir"
[ "$archive_version" = "$version" ] || fail "deploy dir APP_VERSION is '${archive_version}', expected the gated HEAD value '${version}'"
echo "strip-verify OK: ${version} archive, chat + master + notes + ops-scripts absent from ${deploy_dir}"

if [ "$PREFLIGHT_ONLY" -eq 1 ]; then
    echo "OK: pre-flight only, stopping before push/deploy"
    exit 0
fi

# --- Push ---
git push origin main || fail "git push origin main failed"

# --- Cloudflare credentials ---
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-bfa0d8d232102bbf18dd50d9edc064a1}"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    CLOUDFLARE_API_TOKEN=$(
        cd /root/admin/work/proj/rfxn-infra/ansible || exit 1
        ansible-vault view inventory/group_vars/all/vault.yml \
            | python3 -c "import sys,yaml; print(yaml.safe_load(sys.stdin)['vault_cloudflare_api_token_admin'])"
    ) || fail "could not derive CLOUDFLARE_API_TOKEN from ansible vault"
fi
[ -n "$CLOUDFLARE_API_TOKEN" ] || fail "CLOUDFLARE_API_TOKEN is empty"
export CLOUDFLARE_API_TOKEN

# --- Deploy. CWD is the HEAD tree, so the Functions wrangler compiles are the committed ones. ---
( cd "$SRC" && "$WRANGLER" pages deploy "$deploy_dir" --project-name responder-tx --branch main --commit-dirty=true ) \
    || fail "wrangler pages deploy failed"

# --- Post-deploy smoke ---
if [ "$SKIP_LIVE" -eq 1 ]; then
    echo "skipping live smoke checks (--skip-live)"
else
    live_ok=0
    for attempt in $(seq 1 8); do
        live_version=""
        cb=$(date +%s)  # cache-buster so an intermediary cache can't return a stale copy
        if live_version=$(curl -sf --retry 3 "https://respondertx.org/data/changelog.json?_cb=${cb}" \
            | python3 -c "import sys,json; print(json.load(sys.stdin)['versions'][0]['v'])"); then
            if [ "$live_version" = "$version" ]; then
                live_ok=1
                break
            fi
        fi
        if [ "$attempt" -lt 8 ]; then
            echo "live changelog.json not yet ${version} (attempt ${attempt}/8, got '${live_version}'), waiting 15s for CDN propagation"
            sleep 15
        fi
    done
    [ "$live_ok" -eq 1 ] || fail "live changelog.json versions[0].v never reached ${version} after ~2min (CDN propagation lag or deploy failure)"

    # an asset the previous deploy served keeps answering 200 for a few seconds after the new
    # manifest lands, so this retries like the changelog check above rather than failing on lag
    for stripped in js/chat.js js/master.js js/notes.js css/notes.css server.py scripts/deploy.sh; do
        stripped_ok=0
        for attempt in $(seq 1 6); do
            stripped_status=$(curl -s -o /dev/null -w '%{http_code}' "https://respondertx.org/${stripped}?_cb=$(date +%s%N)") \
                || fail "curl status check for live ${stripped} failed"
            if [ "$stripped_status" = "404" ]; then
                stripped_ok=1
                break
            fi
            if [ "$attempt" -lt 6 ]; then sleep 10; fi  # `[ ] &&` as the last body statement would trip set -e
        done
        [ "$stripped_ok" -eq 1 ] || fail "live ${stripped} returned HTTP ${stripped_status}, expected 404"
    done
fi

echo "OK: ${version} live"
