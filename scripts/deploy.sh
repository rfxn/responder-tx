#!/bin/bash
# deploy.sh [--preflight-only] [--skip-live] — verify version agreement, build stripped archive, deploy to Cloudflare Pages
set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

SKIP_LIVE=0
PREFLIGHT_ONLY=0
for arg in "$@"; do
    case "$arg" in
        --skip-live) SKIP_LIVE=1 ;;
        --preflight-only) PREFLIGHT_ONLY=1 ;;
        *) echo "FAIL: unknown argument: $arg (supported: --preflight-only, --skip-live)" >&2; exit 2 ;;
    esac
done

fail() { echo "FAIL: $*" >&2; exit 1; }

# --- Pre-flight: four-way version agreement ---
version=$(grep -oP "APP_VERSION = '\K[^']+" js/core.js) || fail "cannot extract APP_VERSION from js/core.js"
[ -n "$version" ] || fail "APP_VERSION extracted from js/core.js is empty"
stamp_version="${version#v}"

stamps=$(grep -o '?v=[^"]*' index.html) || fail "no ?v= stamps found in index.html"
stamp_count=0
while IFS= read -r stamp; do
    stamp_count=$((stamp_count + 1))
    [ "$stamp" = "?v=${stamp_version}" ] || fail "index.html stamp mismatch: '${stamp}' (expected '?v=${stamp_version}')"
done <<< "$stamps"
[ "$stamp_count" -gt 0 ] || fail "no ?v= stamps found in index.html"

cl_version=$(python3 -c "import json; print(json.load(open('data/changelog.json'))['versions'][0]['v'])") || fail "cannot read versions[0].v from data/changelog.json"
[ "$cl_version" = "$version" ] || fail "data/changelog.json versions[0].v is '${cl_version}', expected '${version}'"

heading_re="^## ${version//./\\.} "
grep -qE "$heading_re" CHANGELOG.md || fail "CHANGELOG.md has no '## ${version} ' heading"

echo "pre-flight OK: ${version} (${stamp_count} index.html stamps, changelog.json, CHANGELOG.md all agree)"
if [ "$PREFLIGHT_ONLY" -eq 1 ]; then
    echo "OK: pre-flight only, stopping before push/deploy"
    exit 0
fi

# --- Push ---
git push origin main || fail "git push origin main failed"

# --- Cloudflare credentials ---
export CLOUDFLARE_ACCOUNT_ID=bfa0d8d232102bbf18dd50d9edc064a1
CLOUDFLARE_API_TOKEN=$(
    cd /root/admin/work/proj/rfxn-infra/ansible || exit 1
    ansible-vault view inventory/group_vars/all/vault.yml \
        | python3 -c "import sys,yaml; print(yaml.safe_load(sys.stdin)['vault_cloudflare_api_token_admin'])"
) || fail "could not derive CLOUDFLARE_API_TOKEN from ansible vault"
[ -n "$CLOUDFLARE_API_TOKEN" ] || fail "CLOUDFLARE_API_TOKEN is empty"
export CLOUDFLARE_API_TOKEN

# --- Build stripped deploy dir ---
deploy_dir=/tmp/responder-deploy
rm -rf "$deploy_dir"
mkdir "$deploy_dir"
git archive HEAD | tar -x -C "$deploy_dir" || fail "git archive extraction failed"
rm -f "$deploy_dir/js/chat.js"
rm -f "$deploy_dir/js/master.js"
printf '{"messages":[]}\n' > "$deploy_dir/data/chat-outbox.json"

# --- Strip-verify before upload ---
[ ! -e "$deploy_dir/js/chat.js" ] || fail "js/chat.js still present in deploy dir"
[ ! -e "$deploy_dir/js/master.js" ] || fail "js/master.js still present in deploy dir"
[ ! -e "$deploy_dir/HANDOFF.md" ] || fail "HANDOFF.md present in deploy dir"
[ ! -e "$deploy_dir/data/chat-inbox.jsonl" ] || fail "data/chat-inbox.jsonl present in deploy dir"
if grep -rq 'api/chat' "$deploy_dir/js" "$deploy_dir/index.html"; then
    fail "api/chat reference found in deploy dir js/ or index.html"
fi
# index.html must never statically reference the LAN-only clients (boot.js injects them at runtime)
if grep -q 'js/master\.js\|js/chat\.js' "$deploy_dir/index.html"; then
    fail "LAN-only client (chat.js/master.js) statically referenced in deploy index.html"
fi
echo "strip-verify OK: chat + master surfaces absent from ${deploy_dir}"

# --- Deploy ---
wrangler pages deploy "$deploy_dir" --project-name responder-tx --branch main --commit-dirty=true \
    || fail "wrangler pages deploy failed"

# --- Post-deploy smoke ---
if [ "$SKIP_LIVE" -eq 1 ]; then
    echo "skipping live smoke checks (--skip-live)"
else
    live_ok=0
    for attempt in 1 2 3; do
        live_version=""
        if live_version=$(curl -sf --retry 3 https://respondertx.org/data/changelog.json \
            | python3 -c "import sys,json; print(json.load(sys.stdin)['versions'][0]['v'])"); then
            if [ "$live_version" = "$version" ]; then
                live_ok=1
                break
            fi
        fi
        echo "live changelog.json not yet ${version} (attempt ${attempt}/3, got '${live_version}'), waiting 10s for CDN"
        sleep 10
    done
    [ "$live_ok" -eq 1 ] || fail "live changelog.json versions[0].v never reached ${version}"

    chat_status=$(curl -s -o /dev/null -w '%{http_code}' https://respondertx.org/js/chat.js) \
        || fail "curl status check for live js/chat.js failed"
    [ "$chat_status" = "404" ] || fail "live js/chat.js returned HTTP ${chat_status}, expected 404"
fi

echo "OK: ${version} live"
