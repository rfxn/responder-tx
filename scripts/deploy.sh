#!/bin/bash
# deploy.sh [--preflight-only] [--skip-live] [--skip-tests] [--allow-dirty-functions] — gate HEAD, build the stripped archive, deploy to Cloudflare Pages
# Staging is a per-run mktemp dir, dropped on exit; set RESPONDER_DEPLOY_DIR to pin it and keep it.
set -euo pipefail

# RESPONDER_ROOT lets run-cycle.sh execute a committed copy of this script against the live repo
cd "${RESPONDER_ROOT:-$(command dirname "$0")/..}" || exit 1
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

# Staging is per-run by default. It used to be a fixed /tmp/responder-deploy shared by every
# deploy, so the 8,23,38,53 cron's `rm -rf` under a concurrent hand-run deploy killed it with
# ENOENT on data/history.json mid-archive. RESPONDER_DEPLOY_DIR still pins the path for a caller
# that needs to inspect the artifact afterwards (tests/deploy.test.sh does); that caller owns the
# directory's lifetime, and two deploys sharing one deliberately can still collide.
DEPLOY_DIR_PINNED="${RESPONDER_DEPLOY_DIR:-}"
case "$DEPLOY_DIR_PINNED" in
    ''|/*) ;;
    *) fail "RESPONDER_DEPLOY_DIR must be an absolute path, got '${DEPLOY_DIR_PINNED}'" ;;
esac
deploy_dir=''  # set at build time; the EXIT trap removes it only when this run created it

# --- Materialize HEAD. The version gate, the test gate, and the Functions tree wrangler compiles
# all read from here, so a working-tree edit can neither block a deploy nor contaminate one. ---
SRC=$(command mktemp -d "${TMPDIR:-/tmp}/responder-src.XXXXXX") || fail "mktemp for the HEAD source tree failed"
cleanup() {
    rc=$?
    cd "$REPO_ROOT" || exit "$rc"
    git worktree remove --force "$SRC" >/dev/null 2>&1 || command rm -rf "$SRC"  # remove is the clean path; rm covers a half-created worktree
    git worktree prune >/dev/null 2>&1 || :  # a stale admin entry is cosmetic, never worth failing a deploy over
    # only a dir this run made: a pinned one belongs to the caller, which may still want to read it
    if [ -z "$DEPLOY_DIR_PINNED" ] && [ -n "$deploy_dir" ]; then
        command rm -rf "$deploy_dir"
    fi
    exit "$rc"
}
trap cleanup EXIT INT TERM
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
        command rm -rf "$SRC/functions"
        command cp -a functions "$SRC/functions" || fail "could not overlay the working-tree functions/ onto ${SRC}"
    else
        echo "NOTE: functions/ has uncommitted changes; shipping HEAD (${head_commit}) Functions instead:" >&2
        echo "$dirty_functions" >&2
        echo "NOTE: static data still publishes. Commit the Functions work, or pass --allow-dirty-functions to ship it." >&2
    fi
fi

# --- Pre-flight: version agreement, read from HEAD because HEAD is what ships ---
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

# the client's update poll reads only this artifact; if it ships stale, no tab ever learns of a build
poll_version=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$SRC/data/version.json") \
    || fail "cannot read version from HEAD data/version.json"
[ "$poll_version" = "$version" ] || fail "data/version.json version is '${poll_version}', expected '${version}'"

sw_version=$(grep -m1 -oP "SW_VERSION = '\K[^']+" "$SRC/sw.js") || fail "cannot extract SW_VERSION from HEAD sw.js"
[ "$sw_version" = "$stamp_version" ] || fail "sw.js SW_VERSION is '${sw_version}', expected '${stamp_version}'"

heading_re="^## ${version//./\\.} "
grep -qE "$heading_re" "$SRC/CHANGELOG.md" || fail "CHANGELOG.md has no '## ${version} ' heading"

echo "pre-flight OK: ${version} @ ${head_commit} (${stamp_count} index.html stamps, changelog.json, version.json, CHANGELOG.md all agree)"

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
if [ -n "$DEPLOY_DIR_PINNED" ]; then
    deploy_dir="$DEPLOY_DIR_PINNED"
    command rm -rf "$deploy_dir"
    command mkdir -p "$deploy_dir"
else
    deploy_dir=$(command mktemp -d "${TMPDIR:-/tmp}/responder-deploy.XXXXXX") || fail "mktemp for the deploy staging dir failed"
fi
git archive HEAD | tar -x -C "$deploy_dir" || fail "git archive extraction failed"
command rm -f "$deploy_dir/js/chat.js"
command rm -f "$deploy_dir/js/master.js"
# Field Notes is disabled and LAN-only; boot.js injects it on ?notes/?note, so the mirror needs neither file
command rm -f "$deploy_dir/js/notes.js"
command rm -f "$deploy_dir/css/notes.css"
# ops-side code no browser can execute: the cycle/chat/deploy scripts and the LAN server, which
# together carry the ops host's absolute paths, its cron lines and the whole /api/chat plumbing
command rm -rf "$deploy_dir/scripts"
command rm -f "$deploy_dir/server.py"
command rm -f "$deploy_dir/.gitignore"
printf '{"messages":[]}\n' > "$deploy_dir/data/chat-outbox.json"

# the field-report intake is operator-only: the mirror has no write endpoint, so boot.js withdraws
# the form there and submit is refused. Ship no markup a public visitor can never reach.
python3 - "$deploy_dir/index.html" <<'PY' || fail "intake markup strip failed on the deploy index.html"
import re, sys

path = sys.argv[1]
with open(path, encoding='utf-8') as fh:
    src = fh.read()
out, n = re.subn(r'[ \t]*<!-- lan-only:intake -->.*?<!-- /lan-only:intake -->[ \t]*\n', '', src, flags=re.S)
if 'lan-only:intake' in out:
    sys.exit('unbalanced lan-only:intake marker left in index.html after removing %d region(s)' % n)
print('intake strip: removed %d lan-only:intake region(s) from the deploy index.html' % n)
with open(path, 'w', encoding='utf-8') as fh:
    fh.write(out)
PY

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
# the intake strip is asserted on its result, both ways: HEAD must still carry the form (the LAN
# operator build depends on it) and the artifact must not (a no-op strip cannot pass unnoticed)
grep -q 'id="new-request-form"' "$SRC/index.html" \
    || fail "HEAD index.html has no #new-request-form; the LAN operator build lost its intake form"
if grep -q 'id="new-request-form"\|id="toggle-form"\|lan-only:intake' "$deploy_dir/index.html"; then
    fail "field-intake markup still present in the deploy index.html"
fi
[ -f "$deploy_dir/sw.js" ] || fail "sw.js missing from deploy dir"
if grep -q 'js/chat\.js\|js/master\.js\|js/notes\.js\|css/notes\.css' "$deploy_dir/sw.js"; then
    fail "stripped client (chat/master/notes) precached in deploy sw.js"
fi
archive_version=$(grep -oP "APP_VERSION = '\K[^']+" "$deploy_dir/js/core.js") || fail "cannot extract APP_VERSION from the deploy dir"
[ "$archive_version" = "$version" ] || fail "deploy dir APP_VERSION is '${archive_version}', expected the gated HEAD value '${version}'"
[ -f "$deploy_dir/data/version.json" ] || fail "data/version.json missing from deploy dir (the update poll would 404 forever)"
echo "strip-verify OK: ${version} archive, chat + master + notes + ops-scripts + field-intake markup absent from ${deploy_dir}"

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
    for attempt in $(command seq 1 8); do
        live_version=""
        cb=$(command date +%s)  # cache-buster so an intermediary cache can't return a stale copy
        if live_version=$(curl -sf --retry 3 "https://respondertx.org/data/changelog.json?_cb=${cb}" \
            | python3 -c "import sys,json; print(json.load(sys.stdin)['versions'][0]['v'])"); then
            if [ "$live_version" = "$version" ]; then
                live_ok=1
                break
            fi
        fi
        if [ "$attempt" -lt 8 ]; then
            echo "live changelog.json not yet ${version} (attempt ${attempt}/8, got '${live_version}'), waiting 15s for CDN propagation"
            command sleep 15
        fi
    done
    [ "$live_ok" -eq 1 ] || fail "live changelog.json versions[0].v never reached ${version} after ~2min (CDN propagation lag or deploy failure)"

    # Two URLs per stripped path, because they answer two different questions. The cache-busted
    # one reaches the origin and is the only one this deploy controls, so it stays the pass/fail
    # condition. The plain one is what a browser actually gets, and a zone-level cache rule set in
    # the Cloudflare dashboard (max-age=14400, overriding this repo's _headers) can keep serving a
    # stripped asset from the edge for hours after the origin stopped having it. Asserting only on
    # the cache-busted URL measured the origin while reporting on the browser.
    edge_serving=()
    # an asset the previous deploy served keeps answering 200 for a few seconds after the new
    # manifest lands, so this retries like the changelog check above rather than failing on lag
    for stripped in js/chat.js js/master.js js/notes.js css/notes.css server.py scripts/deploy.sh; do
        stripped_ok=0
        for attempt in $(command seq 1 6); do
            stripped_status=$(curl -s -o /dev/null -w '%{http_code}' "https://respondertx.org/${stripped}?_cb=$(command date +%s%N)") \
                || fail "curl origin status check for live ${stripped} failed"
            if [ "$stripped_status" = "404" ]; then
                stripped_ok=1
                break
            fi
            if [ "$attempt" -lt 6 ]; then command sleep 10; fi  # `[ ] &&` as the last body statement would trip set -e
        done
        [ "$stripped_ok" -eq 1 ] || fail "live ${stripped} returned HTTP ${stripped_status} from the origin, expected 404"

        edge_status=$(curl -s -o /dev/null -w '%{http_code}' "https://respondertx.org/${stripped}") \
            || fail "curl edge status check for live ${stripped} failed"
        [ "$edge_status" = "404" ] || edge_serving+=("${stripped} (HTTP ${edge_status})")
    done
    if [ "${#edge_serving[@]}" -eq 0 ]; then
        echo "strip gate OK: origin and CDN edge both 404 for every stripped path"
    else
        # never fatal: the zone cache rule is owner-gated dashboard config, not something a
        # deploy can fix, and failing here would block shipping flood data over a stale asset
        echo "##########################################################" >&2
        echo "# WARNING: the CDN edge is STILL SERVING stripped paths: #" >&2
        echo "##########################################################" >&2
        for served in "${edge_serving[@]}"; do echo "#   ${served}" >&2; done
        echo "# The origin returns 404 for each, so this deploy is correct and" >&2
        echo "# the files are not in the artifact. A zone-level Cloudflare cache" >&2
        echo "# rule (max-age=14400) overrides this repo's _headers, so a real" >&2
        echo "# browser can keep receiving them for up to 4h. To clear it now," >&2
        echo "# purge the zone cache in the Cloudflare dashboard." >&2
    fi
fi

echo "OK: ${version} live"
