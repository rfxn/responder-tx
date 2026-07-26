#!/bin/bash
# cycle-check.sh [--code-from-head] — pre-commit sanity bundle for the release cycle; runs all checks, reports each, exits non-zero if any fail
set -euo pipefail

# RESPONDER_ROOT lets run-cycle.sh execute a committed copy of this script against the live repo:
# the script body comes from HEAD, the data it validates is still the working tree's
cd "${RESPONDER_ROOT:-$(command dirname "$0")/..}" || exit 1

CODE_FROM_HEAD=0
for arg in "$@"; do
    case "$arg" in
        --code-from-head) CODE_FROM_HEAD=1 ;;
        *) echo "FAIL: unknown argument: $arg (supported: --code-from-head)" >&2; exit 2 ;;
    esac
done

FAILURES=0
pass() { echo "OK:   $*"; }
failck() { echo "FAIL: $*"; FAILURES=$((FAILURES + 1)); }

# Two lanes. The DATA lane (JSON validity, feeds, snapshot, staged files, cursors, schemas) always
# reads the working tree: that is the data the cycle is about to commit. The CODE lane (JS syntax,
# version agreement, the 911-gate and brand-hook source checks) reads HEAD under --code-from-head,
# so a release agent's half-finished version bump cannot fail a data cycle and strand the public
# board on stale flood data. Without the flag the code lane reads the tree at full strength, which
# is what a release agent needs before committing a bump.
CODE_ROOT="."
CODE_TMP=""
# shellcheck disable=SC2317  # reached only via the EXIT trap below
cleanup_code_snapshot() {
    rc=$?
    if [ -n "$CODE_TMP" ]; then command rm -rf "$CODE_TMP"; fi
    exit "$rc"
}
if [ "$CODE_FROM_HEAD" -eq 1 ]; then
    git rev-parse --verify HEAD >/dev/null 2>&1 || { echo "FAIL: --code-from-head needs a commit to read" >&2; exit 1; }
    CODE_TMP=$(command mktemp -d "${TMPDIR:-/tmp}/responder-codecheck.XXXXXX") || { echo "FAIL: mktemp for the HEAD code snapshot failed" >&2; exit 1; }
    trap cleanup_code_snapshot EXIT
    CODE_ROOT="$CODE_TMP"
    command mkdir -p "$CODE_ROOT/js" "$CODE_ROOT/data"
    while IFS= read -r f; do
        git show "HEAD:$f" > "$CODE_ROOT/$f" || { echo "FAIL: cannot read ${f} from HEAD" >&2; exit 1; }
    done < <(git ls-tree -r --name-only HEAD -- js index.html sw.js CHANGELOG.md data/changelog.json data/event.json \
        | grep -E '^js/[^/]+\.js$|^index\.html$|^sw\.js$|^CHANGELOG\.md$|^data/(changelog|event)\.json$')
    echo "note: code-lane checks read HEAD ($(git rev-parse --short HEAD)); data-lane checks read the working tree"
fi
export CODE_ROOT

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
    for f in "$CODE_ROOT"/js/*.js; do
        node --check "$f" || return 1
    done
    return 0
}
if check_js; then pass "JS syntax (node --check, js/*.js excl. vendor)"; else failck "JS syntax (node --check, js/*.js excl. vendor)"; fi

# c. Version agreement: core.js, index.html stamps, changelog.json, CHANGELOG.md, sw.js
check_versions() {
    local app_version stamp_version stamps stamp cl_version md_version sw_version
    app_version=$(grep -oP "APP_VERSION = '\K[^']+" "$CODE_ROOT/js/core.js") || { echo "no APP_VERSION in js/core.js" >&2; return 1; }
    stamp_version="${app_version#v}"
    stamps=$(grep -o '?v=[^"]*' "$CODE_ROOT/index.html") || { echo "no ?v= stamps in index.html" >&2; return 1; }
    while IFS= read -r stamp; do
        if [ "$stamp" != "?v=${stamp_version}" ]; then
            echo "index.html stamp '${stamp}' != '?v=${stamp_version}'" >&2
            return 1
        fi
    done <<< "$stamps"
    cl_version=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['versions'][0]['v'])" "$CODE_ROOT/data/changelog.json") \
        || { echo "cannot read versions[0].v from data/changelog.json" >&2; return 1; }
    if [ "$cl_version" != "$app_version" ]; then
        echo "changelog.json '${cl_version}' != APP_VERSION '${app_version}'" >&2
        return 1
    fi
    md_version=$(grep -m1 -oP '^## \Kv[0-9][^ ]*' "$CODE_ROOT/CHANGELOG.md") || { echo "no '## vX.Y.Z' heading in CHANGELOG.md" >&2; return 1; }
    if [ "$md_version" != "$app_version" ]; then
        echo "CHANGELOG.md top heading '${md_version}' != APP_VERSION '${app_version}'" >&2
        return 1
    fi
    sw_version=$(grep -m1 -oP "SW_VERSION = '\K[^']+" "$CODE_ROOT/sw.js") || { echo "no SW_VERSION in sw.js" >&2; return 1; }
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

# e. Snapshot sanity (no freshness window — must pass on a quiet-day repo).
# Floor is event-agnostic (fetch-snapshot.py owns the same-bbox 50% partial guard)
check_snapshot() {
    python3 -c '
import json, sys
from datetime import datetime
d = json.load(open("data/gauges-snapshot.json"))
n = len(d["gauges"])
if n < 25:
    sys.exit(f"only {n} gauges (need >=25)")
datetime.fromisoformat(d["generated"].replace("Z", "+00:00"))
' || return 1
    return 0
}
if check_snapshot; then pass "snapshot (>=25 gauges, ISO-8601 generated stamp)"; else failck "snapshot (data/gauges-snapshot.json)"; fi

# f. Staged-file guard
check_staged() {
    local staged banned rc=0
    staged=$(git diff --cached --name-only) || { echo "git diff --cached failed" >&2; return 1; }
    for banned in HANDOFF.md data/chat-inbox.jsonl data/.chat-cursor data/.chat-cursor-guard data/chat-outbox.json data/notes-inbox.jsonl data/notices-inbox.jsonl; do
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
    arr=$(awk '/never on Escape or a backdrop click/{f=1} f&&/for \(const id of \[/{print; exit}' "$CODE_ROOT/js/boot.js")
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
const root = process.env.CODE_ROOT || '.';
const boot = fs.readFileSync(`${root}/js/boot.js`, 'utf8');
const html = fs.readFileSync(`${root}/index.html`, 'utf8');
const ev = JSON.parse(fs.readFileSync(`${root}/data/event.json`, 'utf8'));
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

# i. chat-cursor sanity. Format and the inbox upper bound are the cheap half; the half that matters
# is that a cursor never moves BACKWARDS, which is how an owner message gets re-delivered or hidden
# a second time. Prior values live in a gitignored guard file, so a fresh checkout records and
# passes. Rotation is not regression: server.py _rotate_inbox_if_due() archives a fully drained
# inbox and resets both cursors to 0, which shows up here as a line count that dropped.
# No ordering between the two cursors is asserted because none holds: chat-poll.sh returns before
# its ack step when the inbox is already drained, so .chat-ack-cursor legitimately sits behind
# .chat-cursor indefinitely whenever a session drains inside the */3 ack window, while in the
# ordinary case the ack runs ahead of it.
CURSOR_GUARD="${RESPONDER_CURSOR_GUARD:-data/.chat-cursor-guard}"
check_cursors() {
    local lines=0 f val rc=0 cur=0 ack=0
    local p_cur='' p_ack='' p_lines=''
    local int_re='^[0-9]+$'
    if [ -f data/chat-inbox.jsonl ]; then
        lines=$(command wc -l < data/chat-inbox.jsonl)
    fi
    for f in data/.chat-cursor data/.chat-ack-cursor; do
        # absent cursor file = 0 (fresh checkout, or inbox just rotated to an archive)
        [ -f "$f" ] || continue
        val=$(command tr -d '[:space:]' < "$f")
        if ! [[ "$val" =~ $int_re ]]; then
            echo "${f}: '${val}' does not match ^[0-9]+\$" >&2
            return 1
        fi
        if [ "$val" -gt "$lines" ]; then
            echo "${f}: ${val} exceeds data/chat-inbox.jsonl line count ${lines}" >&2
            return 1
        fi
        if [ "$f" = data/.chat-cursor ]; then cur="$val"; else ack="$val"; fi
    done
    if [ -f "$CURSOR_GUARD" ]; then
        read -r p_cur p_ack p_lines _ < "$CURSOR_GUARD" || true  # short or unterminated line falls through to the format gate below
        if [[ "$p_cur" =~ $int_re ]] && [[ "$p_ack" =~ $int_re ]] && [[ "$p_lines" =~ $int_re ]] \
           && [ "$lines" -ge "$p_lines" ]; then  # a shorter inbox is a rotation, the one legitimate reset
            if [ "$cur" -lt "$p_cur" ]; then
                echo "data/.chat-cursor regressed ${p_cur} -> ${cur} with no inbox rotation (inbox ${p_lines} -> ${lines})" >&2
                rc=1
            fi
            if [ "$ack" -lt "$p_ack" ]; then
                echo "data/.chat-ack-cursor regressed ${p_ack} -> ${ack} with no inbox rotation (inbox ${p_lines} -> ${lines})" >&2
                rc=1
            fi
        fi
    fi
    # record even when failing: the regression is reported once, and an ops-chat fault does not go
    # on to strand the public flood board on stale data every cycle after it
    printf '%s %s %s\n' "$cur" "$ack" "$lines" > "${CURSOR_GUARD}.tmp" && command mv "${CURSOR_GUARD}.tmp" "$CURSOR_GUARD"
    return "$rc"
}
if check_cursors; then pass "chat cursors (integer, <= inbox lines, no regression, rotation-aware)"; else failck "chat cursors"; fi

# j. data-contract schemas — required keys derived from the generator output + js consumer reads,
# so generator/consumer drift fails the cycle instead of degrading silently
check_schemas() {
    python3 - <<'EOF'
import datetime, hashlib, json, os, sys


def die(m):
    sys.exit(m)


def parse_iso(s):
    dt = datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=datetime.timezone.utc)


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

# the chunked playback record. The published hash is what the client puts in the query string,
# and an immutable cache header is only honest while that hash still describes the file on disk.
idx = optional("history/index.json")
if idx is not None:
    if not isinstance(idx.get("days"), list) or not idx["days"]:
        die("history/index.json: days[] missing or empty")
    if not isinstance(idx.get("gaugeIndex"), dict):
        die("history/index.json: gaugeIndex missing")
    record = []
    for i, day in enumerate(idx["days"]):
        miss = [k for k in ("d", "n", "t0", "t1", "h") if not day.get(k)]
        if miss:
            die("history/index.json: days[%d] missing %s" % (i, ",".join(miss)))
        path = os.path.join("history", "day", day["d"] + ".json")
        if not os.path.exists(path):
            die("history/index.json lists %s but %s is absent" % (day["d"], path))
        with open(path, "rb") as f:
            raw = f.read()
        got = hashlib.sha256(raw).hexdigest()[:len(day["h"])]
        if got != day["h"]:
            die("%s hashes %s, index publishes %s; the immutable URL would serve stale bytes"
                % (path, got, day["h"]))
        chunk = json.loads(raw.decode("utf-8"))
        if len(chunk.get("frames") or []) != day["n"]:
            die("%s holds %d frames, index claims %d" % (path, len(chunk.get("frames") or []), day["n"]))
        record += chunk["frames"]
    total = len(record)

    # data/history.json is the bounded compatibility view (v0.98.9). It is allowed to be shorter
    # than the record, and NOT allowed to be a different record, to be stale, or to look whole.
    if d is not None:
        view = d.get("view") or {}
        if set(idx["gaugeIndex"]) != set(d["gaugeIndex"]):
            die("history/index.json gaugeIndex disagrees with data/history.json gaugeIndex")
        if len(d["frames"]) > total:
            die("data/history.json holds %d frames, the chunked record only %d" % (len(d["frames"]), total))
        if record[-len(d["frames"]):] != d["frames"]:
            die("data/history.json is not the tail of the chunked record; the two disagree about "
                "what was observed, and the fallback would replay a different event")
        if len(d["frames"]) < total:
            if view.get("kind") != "recent-window":
                die("data/history.json holds %d of the record's %d frames and does not declare "
                    "itself a bounded view" % (len(d["frames"]), total))
            days = view.get("days")
            if not isinstance(days, int) or days <= 0:
                die("data/history.json view.days is %r, not a positive day count" % (days,))
            if view.get("from") != d["frames"][0]["t"] or view.get("frames") != len(d["frames"]):
                die("data/history.json declares from=%s frames=%s but carries from=%s frames=%d"
                    % (view.get("from"), view.get("frames"), d["frames"][0]["t"], len(d["frames"])))
            full = view.get("full") or {}
            if full.get("frames") != total or full.get("from") != record[0]["t"]:
                die("data/history.json view.full says %s frames from %s, the record holds %d from %s"
                    % (full.get("frames"), full.get("from"), total, record[0]["t"]))
            if not full.get("index") or not os.path.exists(full["index"]):
                die("data/history.json points at full archive %r, which is not on disk" % (full.get("index"),))
            # the declared window must be the reason frames were dropped, not a coincidence
            cut = parse_iso(record[-1]["t"]) - datetime.timedelta(days=days)
            outside = [f["t"] for f in d["frames"] if parse_iso(f["t"]) < cut]
            dropped = [f["t"] for f in record[:total - len(d["frames"])] if parse_iso(f["t"]) >= cut]
            if outside or dropped:
                die("data/history.json declares a %dd window but carries %d frames older than it "
                    "and omits %d inside it" % (days, len(outside), len(dropped)))
    orphans = [n for n in os.listdir(os.path.join("history", "day"))
               if n.endswith(".json") and n[:-5] not in {day["d"] for day in idx["days"]}]
    if orphans:
        die("history/day/ holds day files the index does not list: %s" % ",".join(sorted(orphans)))

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
    # "unknown" is a first-class expected value: a record the feed published with no status
    # must say so. Accepting any truthy string here is what once rewarded an OPEN default.
    shelter_vocab = ("open", "standby", "full", "closed", "unknown")
    for i, s in enumerate(d["shelters"]):
        if (not s.get("name")
                or not isinstance(s.get("lat"), (int, float))
                or not isinstance(s.get("lon"), (int, float))):
            die("shelters-live.json: shelters[%d] missing name/lat/lon" % i)
        st = str(s.get("status") or "").strip()
        if not st:
            die("shelters-live.json: shelters[%d] has no status; a status-less record must publish as 'unknown'" % i)
        if st.lower() not in shelter_vocab:
            # upstream vocabulary drift renders verbatim and must never abort the data cycle
            print("note: shelters-live.json shelters[%d] status %r is outside the mapped vocabulary" % (i, st))

d = optional("data/caltopo-export.json")
if d is not None:
    if d.get("type") != "FeatureCollection" or not isinstance(d.get("features"), list):
        die("caltopo-export.json: not a FeatureCollection with features[]")
    for i, f in enumerate(d["features"]):
        if f.get("type") != "Feature" or "geometry" not in f:
            die("caltopo-export.json: features[%d] missing type/geometry" % i)
        if not (f.get("properties") or {}).get("title"):
            die("caltopo-export.json: features[%d] missing properties.title" % i)

d = optional("data/cameras.json")
if d is not None:
    nets = ("txdot", "river", "austin", "atxfloods", "houston", "arlington", "elpbridge", "hays",
            "porthou", "swrecon", "corpus", "lubbock", "weatherbug", "nmdot", "nps", "laredo", "eaglepass", "delrio",
            "galveston")
    miss = [n for n in nets if not isinstance(d.get(n), list)]
    if miss:
        die("cameras.json: network arrays missing: %s" % ",".join(miss))
    need = {"river": "camId", "austin": "id", "atxfloods": "id", "houston": "id",
            "arlington": "id", "hays": "id", "porthou": "id", "elpbridge": "httpsurl",
            "swrecon": "id", "corpus": "id", "lubbock": "id", "weatherbug": "id",
            "nmdot": "id", "nps": "id", "laredo": "id", "eaglepass": "id",
            "delrio": "id", "galveston": "id"}
    for n in nets:
        for i, c in enumerate(d[n]):
            if not isinstance(c.get("lat"), (int, float)) or not isinstance(c.get("lon"), (int, float)):
                die("cameras.json: %s[%d] missing lat/lon" % (n, i))
            k = need.get(n)
            if k and not c.get(k):
                die("cameras.json: %s[%d] missing %s" % (n, i, k))
            if n == "txdot" and not (c.get("httpsurl") or (c.get("dist") and c.get("icd"))):
                die("cameras.json: txdot[%d] missing httpsurl or dist/icd" % i)
            if n in ("river", "atxfloods", "weatherbug") and not c.get("newest"):
                die("cameras.json: %s[%d] has no newest-image stamp (a camera that never produced one must not ship)" % (n, i))

with open("data/requests.json") as f:
    d = json.load(f)
if not isinstance(d.get("requests"), list):
    die("requests.json: requests[] missing")
seen = set()
for i, r in enumerate(d["requests"]):
    if not r.get("id") or not r.get("ts") or not r.get("summary"):
        die("requests.json: requests[%d] missing id/ts/summary" % i)
    if r["id"] in seen:
        die("requests.json: duplicate id %s" % r["id"])
    seen.add(r["id"])
    if r.get("origin") == "operator" and not r.get("received_at"):
        die("requests.json: operator entry %s missing received_at" % r["id"])

if os.path.exists("data/notices-inbox.jsonl"):
    for n, line in enumerate(open("data/notices-inbox.jsonl"), 1):
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except ValueError as exc:
            die("notices-inbox.jsonl line %d: %s" % (n, exc))
        miss = [k for k in ("id", "ts", "received_at", "summary", "place") if not e.get(k)]
        if miss:
            die("notices-inbox.jsonl line %d: missing %s" % (n, ",".join(miss)))
EOF
}
# k. 911 footer on every lens — Drive Mode and the three docked lenses each carry .drive-911, and
# the board keeps its #disclaimer strip. A lens that fills the screen without the 911 line is the
# one place a responder could read this board and never see it.
check_lens_911() {
    node - <<'EOF'
const fs = require('fs');
const root = process.env.CODE_ROOT || '.';
const html = fs.readFileSync(`${root}/index.html`, 'utf8');
const fail = (m) => { console.error(`lens-911 gate: ${m}`); process.exit(1); };
if (!/id="disclaimer"/.test(html)) fail('#disclaimer strip missing from index.html');
for (const id of ['drive-mode', 'summary-view', 'recovery-view', 'basin-view']) {
  const at = html.indexOf(`id="${id}"`);
  if (at === -1) fail(`#${id} missing from index.html`);
  // the root's own markup runs to the next lens root or to </main>; close enough to catch a drop
  const rest = html.slice(at);
  const end = Math.min(...['id="summary-view"', 'id="recovery-view"', 'id="basin-view"', '</main>', '<script']
    .map((s) => { const i = rest.indexOf(s, 1); return i === -1 ? rest.length : i; }));
  if (!/class="drive-911"/.test(rest.slice(0, end))) fail(`#${id} has no .drive-911 footer`);
}
EOF
}
if check_lens_911; then pass "911 footer on every lens (drive/summary/recovery/basin) + #disclaimer"; else failck "911 footer on every lens"; fi

if check_schemas; then pass "data schemas (gauges-snapshot, history, crest-summary, roads-snapshot, shelters-live, caltopo-export, cameras, requests, notices-inbox)"; else failck "data schemas (generator/consumer required keys)"; fi

if [ "$FAILURES" -eq 0 ]; then
    echo "SUMMARY: all 11 checks passed"
    exit 0
fi
echo "SUMMARY: ${FAILURES} of 11 checks FAILED"
exit 1
