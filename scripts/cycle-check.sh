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

# h. event-config brand hook — the loadEventConfig name/subtitle application must target elements that exist in index.html
check_event_brand() {
    node - <<'EOF'
const fs = require('fs');
const fail = (m) => { console.error(`event-brand gate: ${m}`); process.exit(1); };
const boot = fs.readFileSync('js/boot.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const ev = JSON.parse(fs.readFileSync('data/event.json', 'utf8'));
const m = boot.match(/async function loadEventConfig\(\)[\s\S]*?\n\}/);
if (!m) fail('loadEventConfig() not found in js/boot.js');
const fn = m[0];
if (ev.name && typeof ev.name === 'string') {
  if (!/state\.baseTitle\s*=/.test(fn)) fail('event.json has a name but loadEventConfig no longer sets state.baseTitle');
  if (!/document\.title\s*=/.test(fn)) fail('event.json has a name but loadEventConfig no longer sets document.title');
}
const sels = [...fn.matchAll(/querySelector(?:All)?\('([^']+)'\)/g)].map((x) => x[1]);
if (!sels.length) fail('loadEventConfig references no DOM selectors; the brand/subtitle hook is gone');
for (const sel of sels) {
  for (const cls of sel.match(/\.[A-Za-z0-9_-]+/g) || []) {
    const name = cls.slice(1);
    if (!new RegExp(`class="([^"]* )?${name}( [^"]*)?"`).test(html)) {
      fail(`loadEventConfig targets '${sel}' but index.html has no element with class '${name}'`);
    }
  }
  // bare tag tokens too: the original defect was '.brand h1' where .brand existed but no h1 did
  for (const part of sel.split(/[\s>+~]+/)) {
    const tag = (part.match(/^[a-zA-Z][a-zA-Z0-9]*/) || [])[0];
    if (tag && !new RegExp(`<${tag}[\\s>]`, 'i').test(html)) {
      fail(`loadEventConfig targets '${sel}' but index.html has no <${tag}> element`);
    }
  }
}
EOF
}
if check_event_brand; then pass "event-config brand hook (event.json name/subtitle targets exist in index.html)"; else failck "event-config brand hook"; fi

# i. chat-cursor sanity — cursors are non-negative ints and never exceed the inbox line count
check_cursors() {
    local lines=0 f val
    local int_re='^[0-9]+$'
    if [ -f data/chat-inbox.jsonl ]; then
        lines=$(wc -l < data/chat-inbox.jsonl)
    fi
    for f in data/.chat-cursor data/.chat-ack-cursor; do
        # absent cursor file = 0 (fresh checkout, or inbox just rotated to an archive)
        [ -f "$f" ] || continue
        val=$(tr -d '[:space:]' < "$f")
        if ! [[ "$val" =~ $int_re ]]; then
            echo "${f}: '${val}' does not match ^[0-9]+\$" >&2
            return 1
        fi
        if [ "$val" -gt "$lines" ]; then
            echo "${f}: ${val} exceeds data/chat-inbox.jsonl line count ${lines}" >&2
            return 1
        fi
    done
    return 0
}
if check_cursors; then pass "chat cursors (integer, <= inbox line count, rotation-aware)"; else failck "chat cursors"; fi

# j. data-contract schemas — required keys derived from the generator output + js consumer reads,
# so generator/consumer drift fails the cycle instead of degrading silently
check_schemas() {
    python3 - <<'EOF'
import json, os, sys


def die(m):
    sys.exit(m)


def optional(path):
    # absent tolerated only for files every consumer degrades gracefully without
    if not os.path.exists(path):
        print("note: %s absent, schema check skipped (consumers tolerate absence)" % path)
        return None
    with open(path) as f:
        return json.load(f)


# gauges-snapshot.json is load-bearing (cold-start hydrate + gen-history/gen-crest walk): absence hard-fails
with open("data/gauges-snapshot.json") as f:
    d = json.load(f)
if "generated" not in d or not isinstance(d.get("gauges"), list):
    die("gauges-snapshot.json: generated/gauges[] missing")
bad = sum(1 for g in d["gauges"] if not g.get("lid") or g.get("status") is None)
if bad:
    die("gauges-snapshot.json: %d gauges missing lid/status" % bad)

d = optional("data/history.json")
if d is not None:
    if not isinstance(d.get("frames"), list) or not d["frames"]:
        die("history.json: frames[] missing or empty")
    if not isinstance(d.get("gaugeIndex"), dict):
        die("history.json: gaugeIndex missing")
    for i, fr in enumerate(d["frames"]):
        if not fr.get("t") or not isinstance(fr.get("gauges"), dict):
            die("history.json: frames[%d] missing t/gauges" % i)

d = optional("data/crest-summary.json")
if d is not None:
    if not isinstance(d.get("gauges"), list):
        die("crest-summary.json: gauges[] missing")
    for i, g in enumerate(d["gauges"]):
        if not g.get("lid") or "peak_category" not in g:
            die("crest-summary.json: gauges[%d] missing lid/peak_category" % i)

d = optional("data/roads-snapshot.json")
if d is not None:
    if "generated" not in d or not isinstance(d.get("roads"), list):
        die("roads-snapshot.json: generated/roads[] missing")
    for i, r in enumerate(d["roads"]):
        if "route" not in r or not r.get("start") or not isinstance(r.get("v"), list):
            die("roads-snapshot.json: roads[%d] missing route/start/v" % i)

d = optional("data/shelters-live.json")
if d is not None:
    if "generated" not in d or not isinstance(d.get("shelters"), list):
        die("shelters-live.json: generated/shelters[] missing")
    for i, s in enumerate(d["shelters"]):
        if (not s.get("name") or not s.get("status")
                or not isinstance(s.get("lat"), (int, float))
                or not isinstance(s.get("lon"), (int, float))):
            die("shelters-live.json: shelters[%d] missing name/lat/lon/status" % i)

d = optional("data/cameras.json")
if d is not None:
    nets = ("txdot", "river", "austin", "atxfloods", "houston", "arlington", "elpbridge", "hays")
    miss = [n for n in nets if not isinstance(d.get(n), list)]
    if miss:
        die("cameras.json: network arrays missing: %s" % ",".join(miss))
    need = {"river": "camId", "austin": "id", "atxfloods": "id", "houston": "id",
            "arlington": "id", "hays": "id", "elpbridge": "httpsurl"}
    for n in nets:
        for i, c in enumerate(d[n]):
            if not isinstance(c.get("lat"), (int, float)) or not isinstance(c.get("lon"), (int, float)):
                die("cameras.json: %s[%d] missing lat/lon" % (n, i))
            k = need.get(n)
            if k and not c.get(k):
                die("cameras.json: %s[%d] missing %s" % (n, i, k))
            if n == "txdot" and not (c.get("httpsurl") or (c.get("dist") and c.get("icd"))):
                die("cameras.json: txdot[%d] missing httpsurl or dist/icd" % i)
EOF
}
if check_schemas; then pass "data schemas (gauges-snapshot, history, crest-summary, roads-snapshot, shelters-live, cameras)"; else failck "data schemas (generator/consumer required keys)"; fi

if [ "$FAILURES" -eq 0 ]; then
    echo "SUMMARY: all 10 checks passed"
    exit 0
fi
echo "SUMMARY: ${FAILURES} of 10 checks FAILED"
exit 1
