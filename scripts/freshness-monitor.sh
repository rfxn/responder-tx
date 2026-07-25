#!/bin/bash
# freshness-monitor.sh [--dry-run] — external data-freshness monitor for the
# PUBLIC mirror. Fetches respondertx.org's gauge snapshot over the network,
# ages its embedded generation stamp, and cross-checks local pipeline health
# (cycle output, data commit, last deploy) so a stale board is attributed to the
# right failure. Alerts go to the LAN ops chat outbox, transition-gated with a
# cooldown. See scripts/README.md "Freshness monitor (freshness-monitor.sh)".
set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        *) echo "FAIL: unknown argument: $arg (supported: --dry-run)" >&2; exit 2 ;;
    esac
done

SCRIPT_DIR=$(cd "$(command dirname "$0")" && pwd) || exit 1
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd) || exit 1
cd "$REPO_ROOT" || exit 1

# cron's minimal PATH (/usr/bin:/bin) omits /usr/local/bin where curl/git may live
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

MIRROR_URL="${RESPONDER_MONITOR_URL:-https://respondertx.org/data/gauges-snapshot.json}"
OUTBOX="${RESPONDER_MONITOR_OUTBOX:-data/chat-outbox.json}"
SNAPSHOT="${RESPONDER_MONITOR_SNAPSHOT:-data/gauges-snapshot.json}"
CYCLE_LOG="${RESPONDER_CYCLE_LOG:-/var/log/responder-cycle.log}"
STATE_FILE="${RESPONDER_MONITOR_STATE:-/tmp/responder-freshness-state}"  # "verdict streak last_alert_epoch"; a reboot reset costs at most one extra alert
WARN_MIN="${RESPONDER_MONITOR_WARN_MIN:-45}"        # 3 missed 15-min cycles
CRIT_MIN="${RESPONDER_MONITOR_CRIT_MIN:-90}"        # 6 missed 15-min cycles
FAIL_STREAK="${RESPONDER_MONITOR_FAIL_STREAK:-3}"   # consecutive fetch failures before the mirror counts as unreachable
COOLDOWN="${RESPONDER_MONITOR_COOLDOWN:-21600}"     # re-alert gap (s) while one verdict persists
FETCH_TIMEOUT="${RESPONDER_MONITOR_TIMEOUT:-25}"

LOGFILE="${RESPONDER_MONITOR_LOG:-/var/log/responder-freshness.log}"
if ! ( : >> "$LOGFILE" ) 2>/dev/null; then  # probe: /var/log may be unwritable for non-root cron
    LOGFILE=/tmp/responder-freshness.log
fi
exec > >(command tee -a "$LOGFILE") 2>&1

log() { printf '%s %s\n' "$(command date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
trap 'log "ERROR: freshness-monitor failed (exit $?) near line ${BASH_LINENO[0]}"' ERR

LOCKFILE="${RESPONDER_MONITOR_LOCK:-/tmp/responder-freshness-monitor.lock}"
exec 9>"$LOCKFILE"
if ! flock -n 9; then
    log "SKIP: another freshness-monitor run holds $LOCKFILE"
    exit 0
fi

# iso_age_min ISO — whole minutes since an ISO-8601 stamp, empty if unparseable.
iso_age_min() {
    ISO_IN="$1" python3 - <<'PY'
import calendar, os, sys, time
iso = os.environ.get("ISO_IN", "").strip()
try:
    epoch = calendar.timegm(time.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S"))
except (ValueError, TypeError):
    sys.exit(0)
print(int((time.time() - epoch) // 60))
PY
}

# fetch_generated URL — the mirror snapshot's generated stamp; non-zero on any fetch/parse failure.
fetch_generated() {
    local url="$1" body
    case "$url" in
        http*) url="${url}?_cb=$(command date +%s)" ;;  # bust any intermediary cache; file:// test seams take no query
    esac
    body=$(curl -sf --max-time "$FETCH_TIMEOUT" "$url") || return 1
    printf '%s' "$body" | python3 -c '
import json, sys
try:
    g = json.load(sys.stdin).get("generated")
except ValueError:
    sys.exit(1)
if not isinstance(g, str) or not g.strip():
    sys.exit(1)
print(g.strip())
'
}

# snapshot_age_min FILE — age of a local snapshot's generated stamp, empty if unreadable.
snapshot_age_min() {
    SNAP_IN="$1" python3 - <<'PY'
import calendar, json, os, sys, time
try:
    with open(os.environ["SNAP_IN"], encoding="utf-8") as f:
        g = json.load(f).get("generated")
    epoch = calendar.timegm(time.strptime(str(g)[:19], "%Y-%m-%dT%H:%M:%S"))
except (OSError, ValueError, TypeError):
    sys.exit(0)
print(int((time.time() - epoch) // 60))
PY
}

# commit_age_min PATH — minutes since the last commit touching PATH, empty if unknown.
commit_age_min() {
    local ct now
    ct=$(git log -1 --format=%ct -- "$1" 2>/dev/null) || return 0  # not a repo / path outside it: age stays unknown
    [ -n "$ct" ] || return 0
    now=$(command date -u '+%s')
    echo $(( (now - ct) / 60 ))
}

# deploy_age_min — minutes since the cycle log's last successful deploy, empty if unknown.
deploy_age_min() {
    local line
    [ -f "$CYCLE_LOG" ] || return 0
    line=$(grep -F 'deploy OK' "$CYCLE_LOG" | command tail -1) || return 0  # no deploy line yet: age stays unknown
    iso_age_min "${line%% *}"
}

# cycle_degraded_sources — the stale-source list from the cycle log's last verdict, empty when the
# last verdict was clean. run-cycle.sh publishes what refreshed and signs a partial cycle off as
# "=== cycle complete (DEGRADED) === refreshed: ... | failed: ... | skipped: ...".
cycle_degraded_sources() {
    local line
    [ -f "$CYCLE_LOG" ] || return 0
    line=$(grep -F '=== cycle complete' "$CYCLE_LOG" | command tail -1) || return 0  # no verdict yet
    case "$line" in
        *'(DEGRADED)'*) printf '%s' "${line#*=== refreshed: }" ;;
        *) : ;;  # last cycle signed off clean, so a stale mirror is not a partial-publish story
    esac
}

# fmt_min MINUTES — "N min" or "unknown" for an empty reading.
fmt_min() {
    if [ -n "$1" ]; then printf '%s min' "$1"; else printf 'unknown'; fi
}

# outbox_append TARGET ROLE TEXT — append ONE {ts,role,text}, re-reading the CURRENT
# file and swapping via temp+atomic-rename so a concurrent writer is never clobbered.
outbox_append() {
    OUTBOX_TARGET="$1" OUTBOX_ROLE="$2" OUTBOX_TEXT="$3" python3 - <<'PY'
import json, os, sys, tempfile, time
target = os.environ["OUTBOX_TARGET"]
role = os.environ.get("OUTBOX_ROLE", "action")
text = os.environ.get("OUTBOX_TEXT", "").strip()[:4000]
if not text:
    sys.stderr.write("outbox_append: empty text, nothing to append\n")
    sys.exit(3)
new_msg = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "role": role, "text": text}


def read_bytes(path):
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        return None


for _ in range(6):
    before = read_bytes(target)
    if before is None:
        data = {"messages": []}
    else:
        try:
            data = json.loads(before.decode("utf-8"))
        except ValueError:
            data = {"messages": []}
    if not isinstance(data, dict) or not isinstance(data.get("messages"), list):
        data = {"messages": []}
    data["messages"].append(new_msg)
    d = os.path.dirname(target) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".chat-outbox.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        with open(tmp, encoding="utf-8") as f:
            json.load(f)  # validate before it can be served
        if read_bytes(target) != before:
            os.unlink(tmp)  # concurrent write: rebuild on the newer file
            continue
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    sys.exit(0)
sys.stderr.write("outbox_append: gave up after retries (contended)\n")
sys.exit(4)
PY
}

# read_state — load STATE into ST_VERDICT/ST_STREAK/ST_LASTALERT; absent file is the fresh-install default.
read_state() {
    ST_VERDICT=NONE; ST_STREAK=0; ST_LASTALERT=0
    local word_re='^[A-Z]+$'
    if [ -f "$STATE_FILE" ]; then
        read -r ST_VERDICT ST_STREAK ST_LASTALERT < "$STATE_FILE" || true  # short/absent line: keep defaults
        [[ "${ST_VERDICT:-}" =~ $word_re ]] || ST_VERDICT=NONE
        ST_STREAK=$(printf '%s' "${ST_STREAK:-0}" | command tr -cd '0-9'); ST_STREAK="${ST_STREAK:-0}"
        ST_LASTALERT=$(printf '%s' "${ST_LASTALERT:-0}" | command tr -cd '0-9'); ST_LASTALERT="${ST_LASTALERT:-0}"
    fi
}

# write_state VERDICT STREAK LASTALERT — persist monitor state atomically.
write_state() {
    printf '%s %s %s\n' "$1" "$2" "$3" > "${STATE_FILE}.tmp" && command mv "${STATE_FILE}.tmp" "$STATE_FILE"
}

read_state
NOW=$(command date -u '+%s')

REMOTE_GEN=""
REMOTE_AGE=""
FETCH_OK=0
if REMOTE_GEN=$(fetch_generated "$MIRROR_URL"); then
    FETCH_OK=1
    REMOTE_AGE=$(iso_age_min "$REMOTE_GEN")
fi

LOCAL_AGE=$(snapshot_age_min "$SNAPSHOT")
COMMIT_AGE=$(commit_age_min "$SNAPSHOT")
DEPLOY_AGE=$(deploy_age_min)
DEGRADED_SRC=$(cycle_degraded_sources)
PIPELINE="last cycle output $(fmt_min "$LOCAL_AGE"), last data commit $(fmt_min "$COMMIT_AGE"), last successful deploy $(fmt_min "$DEPLOY_AGE")"
if [ -n "$DEGRADED_SRC" ]; then
    PIPELINE="${PIPELINE}, last cycle DEGRADED (${DEGRADED_SRC})"
fi

STREAK="$ST_STREAK"
if [ "$FETCH_OK" -eq 1 ] && [ -n "$REMOTE_AGE" ]; then
    STREAK=0
    if [ "$REMOTE_AGE" -ge "$CRIT_MIN" ]; then
        VERDICT=CRITICAL
    elif [ "$REMOTE_AGE" -ge "$WARN_MIN" ]; then
        VERDICT=WARN
    else
        VERDICT=FRESH
    fi
else
    STREAK=$((STREAK + 1))
    if [ "$STREAK" -lt "$FAIL_STREAK" ]; then
        log "mirror unreadable (${STREAK}/${FAIL_STREAK} consecutive); treating as transient, no alert. ${PIPELINE}"
        [ "$DRY_RUN" -eq 1 ] || write_state "$ST_VERDICT" "$STREAK" "$ST_LASTALERT"
        exit 0
    fi
    VERDICT=UNREACHABLE
fi

# Cause attribution: a stale mirror is only a publish-path fault when local output is current.
CAUSE=""
if [ "$VERDICT" = UNREACHABLE ]; then
    CAUSE="the mirror or the network path to it is down, so its freshness cannot be confirmed"
elif [ "$VERDICT" != FRESH ]; then
    if [ -n "$DEGRADED_SRC" ]; then
        # the cycle IS running and IS publishing; one upstream is not answering. Saying "the cron
        # or its host is down" here would send an operator to the wrong place entirely.
        CAUSE="the cycle is running and publishing what it can, but a source is not refreshing (${DEGRADED_SRC})"
    elif [ -z "$LOCAL_AGE" ] || [ "$LOCAL_AGE" -ge "$WARN_MIN" ]; then
        CAUSE="the data cycle is not producing fresh local output, so the cron or its host is down"
    elif [ -n "$COMMIT_AGE" ] && [ "$COMMIT_AGE" -ge "$WARN_MIN" ]; then
        CAUSE="the cycle is fetching but the commit and push path is not landing"
    else
        CAUSE="the local pipeline is current, so the publish path (deploy or Cloudflare) is serving stale data"
    fi
fi

log "verdict=${VERDICT} mirror_generated=${REMOTE_GEN:-none} mirror_age=$(fmt_min "$REMOTE_AGE") warn=${WARN_MIN} crit=${CRIT_MIN} streak=${STREAK} | ${PIPELINE}"

alerting() { [ "$1" = WARN ] || [ "$1" = CRITICAL ] || [ "$1" = UNREACHABLE ]; }

POST_TEXT=""
if alerting "$VERDICT"; then
    if [ "$VERDICT" = UNREACHABLE ]; then
        POST_TEXT="Data freshness alert (UNREACHABLE). respondertx.org did not answer the last ${STREAK} checks. Local pipeline: ${PIPELINE}. Likely cause: ${CAUSE}. Runbook: scripts/README.md, section \"Freshness monitor\"."
    else
        POST_TEXT="Data freshness alert (${VERDICT}). The public mirror at respondertx.org is serving a gauge snapshot generated $(fmt_min "$REMOTE_AGE") ago (warn over ${WARN_MIN} min, critical over ${CRIT_MIN} min). Local pipeline: ${PIPELINE}. Likely cause: ${CAUSE}. Runbook: scripts/README.md, section \"Freshness monitor\"."
    fi
    if [ "$VERDICT" = "$ST_VERDICT" ] && [ "$ST_LASTALERT" -gt 0 ] && [ $((NOW - ST_LASTALERT)) -lt "$COOLDOWN" ]; then
        log "alert suppressed: same verdict ${VERDICT}, last alert $((NOW - ST_LASTALERT))s ago (< ${COOLDOWN}s cooldown)"
        POST_TEXT=""
    fi
elif alerting "$ST_VERDICT"; then
    POST_TEXT="Data freshness recovered. The public mirror at respondertx.org is current again (snapshot $(fmt_min "$REMOTE_AGE") old). Prior state was ${ST_VERDICT}."
fi

LASTALERT="$ST_LASTALERT"
if ! alerting "$VERDICT"; then
    LASTALERT=0
fi
if [ -n "$POST_TEXT" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
        log "DRY-RUN: would post to ${OUTBOX}: ${POST_TEXT}"
    elif outbox_append "$OUTBOX" "action" "$POST_TEXT"; then
        log "posted to ops chat: ${POST_TEXT}"
        if alerting "$VERDICT"; then
            LASTALERT="$NOW"
        fi
    else
        log "WARN: outbox append contended; nothing posted, retries next run"
    fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN: state left at ${ST_VERDICT} ${ST_STREAK} ${ST_LASTALERT}"
else
    write_state "$VERDICT" "$STREAK" "$LASTALERT"
fi

if alerting "$VERDICT"; then
    exit 1
fi
exit 0
