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
#
# data/event.json is a DATA file that two code-lane checks read, so it follows the data lane in both
# modes: the generators read it from the working tree with no commit, so that is the config the
# pipeline actually runs on. Gating HEAD's copy validates a box nothing is using yet, and a bad box
# already at HEAD must not stop the data cycle from publishing fresh flood data either.
CODE_ROOT="."
DATA_ROOT="."
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
    command mkdir -p "$CODE_ROOT/js" "$CODE_ROOT/data" "$CODE_ROOT/scripts" "$CODE_ROOT/tests"
    # the hazard-mirror check reads js/sources.js AND scripts/gen-caltopo.py; both must come from the
    # same lane, or it would report on a pairing that exists nowhere
    while IFS= read -r f; do
        git show "HEAD:$f" > "$CODE_ROOT/$f" || { echo "FAIL: cannot read ${f} from HEAD" >&2; exit 1; }
    done < <(git ls-tree -r --name-only HEAD -- js index.html sw.js CHANGELOG.md data/changelog.json data/version.json \
            scripts/gen-caltopo.py tests/harness.js tests/hazard-mirror.js \
        | grep -E '^js/[^/]+\.js$|^index\.html$|^sw\.js$|^CHANGELOG\.md$|^data/(changelog|version)\.json$|^scripts/gen-caltopo\.py$|^tests/(harness|hazard-mirror)\.js$')
    echo "note: code-lane checks read HEAD ($(git rev-parse --short HEAD)); data-lane checks read the working tree"
fi
export CODE_ROOT DATA_ROOT

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
    local app_version stamp_version stamps stamp cl_version md_version sw_version poll_version
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
    # the update poll reads this artifact and nothing else, so a stale one silently strands every
    # long-lived tab on an old build with no signal that a new one exists
    poll_version=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$CODE_ROOT/data/version.json") \
        || { echo "cannot read version from data/version.json" >&2; return 1; }
    if [ "$poll_version" != "$app_version" ]; then
        echo "data/version.json '${poll_version}' != APP_VERSION '${app_version}'" >&2
        return 1
    fi
    VERSION_DETAIL="$app_version"
    return 0
}
VERSION_DETAIL=""
if check_versions; then pass "version agreement (${VERSION_DETAIL}: core.js, index.html, changelog.json, CHANGELOG.md, sw.js, version.json)"; else failck "version agreement (core.js, index.html, changelog.json, CHANGELOG.md, sw.js, version.json)"; fi

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
const ev = JSON.parse(fs.readFileSync(`${process.env.DATA_ROOT || '.'}/data/event.json`, 'utf8'));
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

    # the KML and the GeoRSS are the same feature list in two more syntaxes. A feed that carries a
    # different count, or that drops the truncation claim, tells a subscriber a different story
    # about the same flood than the GeoJSON does.
    import xml.etree.ElementTree as ET
    ns = {"k": "http://www.opengis.net/kml/2.2", "a": "http://www.w3.org/2005/Atom"}
    members = len([f for f in d["features"] if (f.get("properties") or {}).get("class") != "Folder"])
    truncated = bool((d.get("properties") or {}).get("truncated"))
    for path, root_q, count_q, title_q in (
            ("data/board.kml", "kml", ".//k:Placemark", ".//k:Document/k:name"),
            ("data/board-georss.xml", "feed", "a:entry", "a:title")):
        if not os.path.exists(path):
            continue
        try:
            root = ET.parse(path).getroot()
        except ET.ParseError as exc:
            die("%s: not well-formed XML: %s" % (path, exc))
        if not root.tag.endswith("}" + root_q):
            die("%s: root element is %s, expected a namespaced %s" % (path, root.tag, root_q))
        got = len(root.findall(count_q, ns))
        if got != members:
            die("%s carries %d features, caltopo-export.json %d; the feeds disagree about the board"
                % (path, got, members))
        title = root.findtext(title_q, "", ns) or ""
        if truncated and "partial" not in title:
            die("%s is truncated but its title makes no partial claim" % path)
        if not truncated and "partial" in title:
            die("%s claims to be partial but nothing was dropped" % path)

    if os.path.exists("data/board-live.kml"):
        try:
            live = ET.parse("data/board-live.kml").getroot()
        except ET.ParseError as exc:
            die("board-live.kml: not well-formed XML: %s" % exc)
        if live.findtext(".//k:Link/k:refreshMode", "", ns) != "onInterval":
            die("board-live.kml: no onInterval refreshMode; the subscribe URL would not self-update")
        if not (live.findtext(".//k:Link/k:href", "", ns) or "").endswith("/data/board.kml"):
            die("board-live.kml: NetworkLink does not point at board.kml")

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

if check_schemas; then pass "data schemas (gauges-snapshot, history, crest-summary, roads-snapshot, shelters-live, caltopo-export + kml/georss feeds, cameras, requests, notices-inbox)"; else failck "data schemas (generator/consumer required keys)"; fi

# l. USGS bbox area cap. WaterServices 400s any bBox over 25 equator-equivalent square degrees, and
# the AO outgrew that in a config change alone, with no code touched: the layer died silently for
# months. This fails the cycle at release time instead, for the shipped bbox and the built-in one.
USGS_TILE_DETAIL=""
check_usgs_bbox() {
    USGS_TILE_DETAIL=$(node - <<'EOF'
const fs = require('fs');
const vm = require('vm');
const root = process.env.CODE_ROOT || '.';
const fail = (m) => { console.error(`usgs-bbox gate: ${m}`); process.exit(1); };
const sandbox = {
  console, Math, Date, JSON, RegExp, Array, Object, String, Number, Boolean, Map, Set,
  parseInt, parseFloat, isNaN, isFinite, URL, URLSearchParams,
  setTimeout, clearTimeout, setInterval, clearInterval, Promise,
  document: {
    title: '', documentElement: { lang: 'en' }, body: null,
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {} }),
  },
  navigator: {}, location: { origin: '', pathname: '/', search: '' },
  addEventListener() {}, removeEventListener() {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const names = ['CONFIG', 'usgsBboxTiles', 'usgsBboxCost', 'USGS_BBOX_LIMIT', 'USGS_BBOX_BUDGET', 'USGS_BBOX_MAX_TILES'];
const epilogue = `\n;globalThis.__G = { ${names.map((n) => `${n}: typeof ${n} !== 'undefined' ? ${n} : null`).join(', ')} };\n`;
try {
  vm.runInContext(fs.readFileSync(`${root}/js/core.js`, 'utf8') + epilogue, sandbox, { filename: 'core.js' });
} catch (e) { fail(`cannot evaluate js/core.js: ${e.message}`); }
const G = sandbox.__G;
// a core.js that does not configure the USGS feed has no bbox query to gate (minimal test fixtures)
if (!G.CONFIG || !G.CONFIG.usgsIvBase) { process.stdout.write('no USGS feed configured; nothing to gate'); process.exit(0); }
for (const k of ['usgsBboxTiles', 'usgsBboxCost']) {
  if (typeof G[k] !== 'function') fail(`js/core.js configures usgsIvBase but no longer defines ${k}(); the statewide query would 400`);
}
if (!(G.USGS_BBOX_BUDGET < G.USGS_BBOX_LIMIT)) fail('USGS_BBOX_BUDGET must sit under USGS_BBOX_LIMIT');

let ev = {};
try { ev = JSON.parse(fs.readFileSync(`${process.env.DATA_ROOT || '.'}/data/event.json`, 'utf8')); } catch { /* absent event.json: CONFIG's built-in bbox is what ships */ }
// event.json without a gaugeBbox is legal; loadEventConfig then leaves CONFIG's own bbox in place
const boxes = [['CONFIG.gaugeBbox fallback', G.CONFIG.gaugeBbox]];
if (ev.gaugeBbox) boxes.unshift(['data/event.json gaugeBbox', ev.gaugeBbox]);
const detail = [];
for (const [label, b] of boxes) {
  if (!b) fail(`${label} is missing`);
  const tiles = G.usgsBboxTiles(b);
  if (!tiles.length) fail(`${label} yields no queryable tile; the USGS layer would be dead`);
  if (tiles.length > G.USGS_BBOX_MAX_TILES) {
    fail(`${label} needs ${tiles.length} sub-requests, over the ${G.USGS_BBOX_MAX_TILES} ceiling; narrow the AO or raise the ceiling deliberately`);
  }
  let worst = 0;
  for (const t of tiles) {
    const cost = G.usgsBboxCost(t);
    if (cost > G.USGS_BBOX_BUDGET) fail(`${label} produced a tile costing ${cost.toFixed(2)}, over budget ${G.USGS_BBOX_BUDGET}`);
    if (cost >= G.USGS_BBOX_LIMIT) fail(`${label} produced a tile costing ${cost.toFixed(2)}, at or over the upstream limit ${G.USGS_BBOX_LIMIT}`);
    worst = Math.max(worst, cost);
  }
  if (!detail.length) detail.push(`${tiles.length} tiles, worst ${worst.toFixed(1)}/${G.USGS_BBOX_LIMIT}`);
}
process.stdout.write(detail[0]);
EOF
    ) || return 1
    return 0
}
if check_usgs_bbox; then pass "USGS bbox area cap (${USGS_TILE_DETAIL}; event.json + CONFIG fallback both tile under the limit)"; else failck "USGS bbox area cap (gaugeBbox exceeds what WaterServices accepts)"; fi

# m. offline warm depth. HISTORY_WARM_MAX_DAYS declares how many days of playback an offline
# responder gets; HISTORY_WARM_MAX_BYTES only caps what a field phone stores. The two described one
# bound and disagreed silently as the archive grew, warming two days of eight, so the delivered depth
# is replayed here against the index's real chunk sizes. The data lane warns rather than fails: a
# growing archive must never stop a flood publish.
WARM_DETAIL=""
check_history_warm() {
    local days bytes
    grep -q 'HISTORY_WARM_MAX_DAYS' "$CODE_ROOT/sw.js" || { WARM_DETAIL="no history warm configured; nothing to gate"; return 0; }
    days=$(grep -m1 -oP 'HISTORY_WARM_MAX_DAYS = \K[0-9]+' "$CODE_ROOT/sw.js") \
        || { echo "sw.js names HISTORY_WARM_MAX_DAYS but declares no readable value" >&2; return 1; }
    bytes=$(grep -m1 -oP 'HISTORY_WARM_MAX_BYTES = \K[0-9]+' "$CODE_ROOT/sw.js") \
        || { echo "sw.js declares HISTORY_WARM_MAX_DAYS but no HISTORY_WARM_MAX_BYTES; the warm depth is bounded by something this check cannot read" >&2; return 1; }
    WARM_DETAIL=$(python3 - "$days" "$bytes" <<'EOF'
import json, os, sys

declared, ceiling = int(sys.argv[1]), int(sys.argv[2])
path = os.path.join(os.environ.get("DATA_ROOT", "."), "history", "index.json")
if not os.path.exists(path):
    sys.stdout.write("no history/index.json to measure against")
    raise SystemExit(0)
with open(path) as f:
    idx = json.load(f)
# newest-first, exactly the order and the slice sw.js warms in
days = list(reversed(idx.get("days") or []))[:declared]
if not days:
    raise SystemExit("history/index.json declares no days; the warm has nothing to size against")
blind = [str(d.get("d")) for d in days if not isinstance(d.get("bytes"), int) or d["bytes"] <= 0]
if blind:
    raise SystemExit("history/index.json declares no byte size for %s; the warm depth cannot be "
                     "verified and this check would go blind" % ",".join(blind))

want = len(days)  # an archive younger than the declared depth is not a shortfall
need = sum(d["bytes"] for d in days)
budget = min(need, ceiling)
warmed = 0
for d in days:  # replay sw.js warmHistoryCache(): the newest day is always taken, then the budget bites
    warmed += 1
    budget -= d["bytes"]
    if budget <= 0:
        break
if warmed < want:
    raise SystemExit("HISTORY_WARM_MAX_DAYS=%d wants %d bytes at the index's real chunk sizes, but "
                     "HISTORY_WARM_MAX_BYTES=%d warms only %d day(s); raise the ceiling or lower the "
                     "declared depth" % (declared, need, ceiling, warmed))
sys.stdout.write("%d/%d days, %d of %d bytes" % (warmed, declared, need, ceiling))
EOF
    ) || return 1
    return 0
}
if check_history_warm; then
    pass "offline warm depth (${WARM_DETAIL})"
elif [ "$CODE_FROM_HEAD" -eq 1 ]; then
    echo "WARN: offline warm depth: the byte ceiling no longer holds the declared day count. The release lane fails on this; a data cycle does not, because a growing archive must not stop a flood publish."
else
    failck "offline warm depth (HISTORY_WARM_MAX_BYTES cannot hold HISTORY_WARM_MAX_DAYS at the index's real chunk sizes)"
fi

# n. out-of-cycle artifact age. gen-cameras.py and gen-records.py are hand-run because their inputs
# are near-static, so nothing in the 15-minute cycle notices when their output stops describing
# anything anyone verified. The camera inventory is the worst case: its per-camera liveness claims
# expire at gen-cameras.py CAM_MAX_AGE_D, past which the board offers cameras it no longer knows are
# alive. Release lane fails, data lane warns: a stale hand-run must never stop a flood publish.
STATIC_DETAIL=""
check_static_age() {
    STATIC_DETAIL=$(python3 - <<'EOF'
import datetime, json, os, sys

# artifact -> (days it stays trustworthy, the generator that refreshes it). Cameras carry per-camera
# liveness claims that expire at 30d, so 45 leaves a fortnight to act; records are all-time crests
# that move only when one falls, so a quarter also catches "the gauge network grew and nobody re-ran it".
LIMITS = (("data/cameras.json", 45, "gen-cameras.py"), ("data/records.json", 90, "gen-records.py"))
root = os.environ.get("DATA_ROOT", ".")
now = datetime.datetime.now(datetime.timezone.utc)
detail, stale = [], []
for rel, limit, gen in LIMITS:
    path = os.path.join(root, rel)
    if not os.path.exists(path):
        detail.append("%s absent" % os.path.basename(rel))
        continue
    try:
        with open(path, encoding="utf-8") as f:
            stamp = json.load(f).get("generated")
        t = datetime.datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except (OSError, ValueError, TypeError) as exc:
        raise SystemExit("%s carries no readable generated stamp (%s); its age cannot be checked "
                         "and this gate would go blind" % (rel, exc))
    if t.tzinfo is None:
        t = t.replace(tzinfo=datetime.timezone.utc)
    age = (now - t).days
    detail.append("%s %dd/%dd" % (os.path.basename(rel), age, limit))
    if age > limit:
        stale.append("%s is %d days old (limit %d); re-run scripts/%s" % (rel, age, limit, gen))
if stale:
    raise SystemExit("; ".join(stale))
sys.stdout.write(", ".join(detail))
EOF
    ) || return 1
    return 0
}
if check_static_age; then
    pass "out-of-cycle artifact age (${STATIC_DETAIL})"
elif [ "$CODE_FROM_HEAD" -eq 1 ]; then
    echo "WARN: out-of-cycle artifact age: a hand-run generator's output has aged past its limit and nothing else watches it. The release lane fails on this; a data cycle does not, because a stale camera inventory must not stop a flood publish."
else
    failck "out-of-cycle artifact age (data/cameras.json or data/records.json past its limit; re-run the generator)"
fi

# o. hazard allowlist agreement. The list of NWS products the board carries exists twice, in
# js/sources.js and in the scripts/gen-caltopo.py mirror, and nothing at runtime compares them: they
# would simply describe different hazard sets and each would look right alone. The upstream half is
# the sharper edge. An unknown event= string returns HTTP 200 with zero features rather than an
# error, so a typo or a product NWS retires publishes "no tornado warnings" instead of failing,
# which is the E1 shape. Both halves read the same lane, so --code-from-head compares HEAD's
# js/sources.js against HEAD's gen-caltopo.py rather than one of each.
HAZARD_DETAIL=""
check_hazard_table() {
    HAZARD_DETAIL=$(node "$CODE_ROOT/tests/hazard-mirror.js") || return 1
    return 0
}
if check_hazard_table; then
    pass "hazard allowlist agreement (${HAZARD_DETAIL})"
else
    failck "hazard allowlist agreement (js/sources.js, scripts/gen-caltopo.py and the live NWS catalogue disagree)"
fi

# p. Cron bootstrap sanity
# These four run straight from the WORKING TREE on the system crontab, so unlike every other script
# they are live the moment they are saved. run-cycle.sh is the one that materializes HEAD's pipeline,
# which is exactly why it cannot itself come from HEAD. This check therefore reads the tree in both
# modes (E3: check the copy the code actually uses). A half-saved bootstrap skips a flood publish.
check_bootstrap() {
    local src="$DATA_ROOT/scripts/run-cycle.sh" f line declared used seen=0
    # An entrypoint that is absent is a different fact from one that is broken, and only the second
    # can strand a publish. Absent ones are skipped rather than failed, so this can never turn a
    # partial checkout into a stopped data cycle; the count below makes a vacuous pass visible.
    for f in run-cycle.sh chat-poll.sh chat-watchdog.sh freshness-monitor.sh; do
        [ -f "$DATA_ROOT/scripts/$f" ] || continue
        bash -n "$DATA_ROOT/scripts/$f" || { echo "cron entrypoint scripts/${f} does not parse" >&2; return 1; }
        seen=$((seen + 1))
    done
    BOOTSTRAP_DETAIL="${seen} cron entrypoint(s) parse"
    [ -f "$src" ] || return 0
    # bash -n cannot see an unbound $4, which is how a mid-edit gen() signature once killed a live
    # cycle under set -u. Every call site must pass a budget, and every budget must have a call site.
    while IFS= read -r line; do
        printf '%s\n' "$line" | grep -qE 'BUDGET_[A-Z]+_S' \
            || { echo "run-cycle.sh gen() call site passes no budget argument: ${line}" >&2; return 1; }
    done < <(grep -E '^[[:space:]]*(if )?gen [a-z]+ [a-z-]+\.py' "$src")
    declared=$(grep -cE '^BUDGET_[A-Z]+_S=[0-9]+' "$src") || declared=0
    used=$(grep -oE '\$\{?BUDGET_[A-Z]+_S\}?' "$src" | sort -u | wc -l)
    if [ "$declared" -eq 0 ] || [ "$declared" -ne "$used" ]; then
        echo "run-cycle.sh declares ${declared} step budgets but references ${used}" >&2
        return 1
    fi
    BOOTSTRAP_DETAIL="${seen} cron entrypoint(s) parse, ${declared} step budgets all wired"
    return 0
}
BOOTSTRAP_DETAIL=""
if check_bootstrap; then
    pass "cron bootstrap sanity (${BOOTSTRAP_DETAIL})"
else
    failck "cron bootstrap sanity (a working-tree cron entrypoint is unrunnable)"
fi

if [ "$FAILURES" -eq 0 ]; then
    echo "SUMMARY: all 16 checks passed"
    exit 0
fi
echo "SUMMARY: ${FAILURES} of 16 checks FAILED"
exit 1
