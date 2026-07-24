#!/bin/bash
# cycle-check.sh — pre-commit sanity bundle for the release cycle; runs all checks, reports each, exits non-zero if any fail
set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

FAILURES=0
pass() { echo "OK:   $*"; }
failck() { echo "FAIL: $*"; FAILURES=$((FAILURES + 1)); }

# a. JSON validity
check_json() {
    local f
    for f in data/*.json; do
        python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$f" || { echo "invalid JSON: $f" >&2; return 1; }
    done
    if [ -f data/chat-inbox.jsonl ]; then
        python3 -c '
import json, sys
for n, line in enumerate(open("data/chat-inbox.jsonl"), 1):
    line = line.strip()
    if line:
        try:
            json.loads(line)
        except ValueError as e:
            sys.exit(f"data/chat-inbox.jsonl line {n}: {e}")
' || return 1
    fi
    return 0
}
if check_json; then pass "JSON validity (data/*.json, chat-inbox.jsonl)"; else failck "JSON validity (data/*.json, chat-inbox.jsonl)"; fi

# b. JS syntax (js/*.js glob excludes js/vendor/)
check_js() {
    local f
    for f in js/*.js; do
        node --check "$f" || return 1
    done
    return 0
}
if check_js; then pass "JS syntax (node --check, js/*.js excl. vendor)"; else failck "JS syntax (node --check, js/*.js excl. vendor)"; fi

# c. Four-way version agreement
check_versions() {
    local app_version stamp_version stamps stamp cl_version md_version sw_version
    app_version=$(grep -oP "APP_VERSION = '\K[^']+" js/core.js) || { echo "no APP_VERSION in js/core.js" >&2; return 1; }
    stamp_version="${app_version#v}"
    stamps=$(grep -o '?v=[^"]*' index.html) || { echo "no ?v= stamps in index.html" >&2; return 1; }
    while IFS= read -r stamp; do
        if [ "$stamp" != "?v=${stamp_version}" ]; then
            echo "index.html stamp '${stamp}' != '?v=${stamp_version}'" >&2
            return 1
        fi
    done <<< "$stamps"
    cl_version=$(python3 -c "import json; print(json.load(open('data/changelog.json'))['versions'][0]['v'])") \
        || { echo "cannot read versions[0].v from data/changelog.json" >&2; return 1; }
    if [ "$cl_version" != "$app_version" ]; then
        echo "changelog.json '${cl_version}' != APP_VERSION '${app_version}'" >&2
        return 1
    fi
    md_version=$(grep -m1 -oP '^## \Kv[0-9][^ ]*' CHANGELOG.md) || { echo "no '## vX.Y.Z' heading in CHANGELOG.md" >&2; return 1; }
    if [ "$md_version" != "$app_version" ]; then
        echo "CHANGELOG.md top heading '${md_version}' != APP_VERSION '${app_version}'" >&2
        return 1
    fi
    sw_version=$(grep -m1 -oP "SW_VERSION = '\K[^']+" sw.js) || { echo "no SW_VERSION in sw.js" >&2; return 1; }
    if [ "$sw_version" != "$stamp_version" ]; then
        echo "sw.js SW_VERSION '${sw_version}' != stamp version '${stamp_version}'" >&2
        return 1
    fi
    VERSION_DETAIL="$app_version"
    return 0
}
VERSION_DETAIL=""
if check_versions; then pass "version agreement (${VERSION_DETAIL}: core.js, index.html, changelog.json, CHANGELOG.md, sw.js)"; else failck "version agreement (core.js, index.html, changelog.json, CHANGELOG.md, sw.js)"; fi

# d. Feed freshness sanity
check_feeds() {
    [ -s feed.xml ] || { echo "feed.xml missing or empty" >&2; return 1; }
    [ -s crests.ics ] || { echo "crests.ics missing or empty" >&2; return 1; }
    python3 -c "import xml.etree.ElementTree as ET; ET.parse('feed.xml')" || { echo "feed.xml does not parse as XML" >&2; return 1; }
    return 0
}
if check_feeds; then pass "feeds (feed.xml well-formed, crests.ics non-empty)"; else failck "feeds (feed.xml, crests.ics)"; fi

# e. Snapshot sanity (no freshness window — must pass on a quiet-day repo)
check_snapshot() {
    python3 -c '
import json, sys
from datetime import datetime
d = json.load(open("data/gauges-snapshot.json"))
n = len(d["gauges"])
if n < 200:
    sys.exit(f"only {n} gauges (need >=200)")
datetime.fromisoformat(d["generated"].replace("Z", "+00:00"))
' || return 1
    return 0
}
if check_snapshot; then pass "snapshot (>=200 gauges, ISO-8601 generated stamp)"; else failck "snapshot (data/gauges-snapshot.json)"; fi

# f. Staged-file guard
check_staged() {
    local staged banned rc=0
    staged=$(git diff --cached --name-only) || { echo "git diff --cached failed" >&2; return 1; }
    for banned in HANDOFF.md data/chat-inbox.jsonl data/.chat-cursor data/chat-outbox.json data/notes-inbox.jsonl; do
        if printf '%s\n' "$staged" | grep -qxF "$banned"; then
            echo "working file staged: ${banned}" >&2
            rc=1
        fi
    done
    return "$rc"
}
if check_staged; then pass "staged-file guard (no working/chat files staged)"; else failck "staged-file guard"; fi

# g. 911-gate Escape immunity — #safety-modal must never appear in the Escape-dismiss loop array
check_safety_escape() {
    local arr
    arr=$(awk '/never on Escape or a backdrop click/{f=1} f&&/for \(const id of \[/{print; exit}' js/boot.js)
    [ -n "$arr" ] || { echo "Escape-dismiss loop array not found in js/boot.js (anchor comment moved?)" >&2; return 1; }
    if printf '%s\n' "$arr" | grep -q "safety-modal"; then
        echo "js/boot.js: #safety-modal in the Escape-dismiss loop array — the 911 gate must stay Escape-immune" >&2
        return 1
    fi
    return 0
}
if check_safety_escape; then pass "911-gate Escape immunity (#safety-modal absent from Escape loop)"; else failck "911-gate Escape immunity"; fi

if [ "$FAILURES" -eq 0 ]; then
    echo "SUMMARY: all 7 checks passed"
    exit 0
fi
echo "SUMMARY: ${FAILURES} of 7 checks FAILED"
exit 1
