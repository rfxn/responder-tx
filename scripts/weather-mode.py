#!/usr/bin/env python3
"""Publish cadence for the data cycle: quiet (2 runs a day) or adverse (hourly). Zero-LLM.

  weather-mode.py                  probe NWS alerts + the gauge capture, update data/.cadence-state.json
  weather-mode.py --due ...        print this fire's verdict: "full|ship|hold <reason>"
  weather-mode.py --mark-published ISO
  weather-mode.py --write-cadence ISO   write data/cadence.json for a publish that started at ISO
See scripts/README.md "Cadence".
"""
import ast
import datetime
import hashlib
import importlib.util
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections import Counter
from zoneinfo import ZoneInfo

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("RESPONDER_ROOT") or os.path.dirname(SCRIPTS)
STATE_PATH = os.environ.get("RESPONDER_CADENCE_STATE") or os.path.join(ROOT, "data", ".cadence-state.json")
FORCE_PATH = os.path.join(ROOT, "data", ".cadence-force")
CADENCE_PATH = os.path.join(ROOT, "data", "cadence.json")
CAPTURE_PATH = os.path.join(ROOT, "data", "gauges-capture.json")
EVENT_PATH = os.path.join(ROOT, "data", "event.json")
ALERTS_URL = os.environ.get("RESPONDER_WX_ALERTS_URL") or "https://api.weather.gov/alerts/active?area=TX"
TIMEOUT = 20
BACKOFFS = [2, 5]

MODES = ("quiet", "adverse")
INTERVAL_MIN = {"quiet": 720, "adverse": 60}
ADVERSE_DUE_S = 55 * 60
QUIET_DUE_S = 11 * 3600 + 50 * 60
ANCHOR_HOURS = (6, 18)
ANCHOR_TZ = ZoneInfo("America/Chicago")
LEAVE_ADVERSE_S = 6 * 3600
FAIL_STREAK_ADVERSE = 3
FAST_RETRY_FAILS = 4
CLOCK_SKEW_S = 5 * 60
CAPTURE_MAX_AGE_S = 45 * 60
FORCE_TTL_S = 24 * 3600
OPERATOR_REASON = "Set by the operator"

# the board's own allowlist decides which flood, tropical and surge products exist (E5)
TRIGGER_TIERS = ("acute", "watch")
TRIGGER_NAME_RE = re.compile(r"flood|tropical|surge|^hurricane (warning|watch)$", re.I)
TRIGGER_SEVERITIES = ("Extreme", "Severe", "Moderate")  # watches and statements; a warning triggers at any severity
OBS_FLOOD = ("minor", "moderate", "major")
FCST_FLOOD = ("moderate", "major")


def iso(dt):
    return dt.astimezone(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    try:
        dt = datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=datetime.timezone.utc)


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_json_atomic(path, payload):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", prefix=".cadence.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=1)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def load_state():
    s = load_json(STATE_PATH)
    return s if isinstance(s, dict) else {}


def forced_mode(now=None):
    """The owner override, which lapses 24 h after it was written so a forgotten one cannot mute an event."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    try:
        with open(FORCE_PATH, encoding="utf-8") as f:
            word = f.read().strip().lower()
        age = now.timestamp() - os.stat(FORCE_PATH).st_mtime
    except OSError:
        return None
    if word not in MODES:
        return None
    if age > FORCE_TTL_S:
        try:
            os.unlink(FORCE_PATH)
        except OSError:
            pass
        print(f"cadence: data/.cadence-force ({word}) is {age / 3600:.0f} h old, past its 24 h life; removed")
        return None
    print(f"cadence: data/.cadence-force holds the mode {word}, set {age / 3600:.1f} h ago, lapses in "
          f"{(FORCE_TTL_S - age) / 3600:.1f} h")
    return word


def hazard_table(path=os.path.join(SCRIPTS, "gen-caltopo.py")):
    with open(path, encoding="utf-8") as f:
        tree = ast.parse(f.read())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "HAZARD_EVENTS" for t in node.targets):
            table = ast.literal_eval(node.value)
            if isinstance(table, dict) and table:
                return table
    raise ValueError("scripts/gen-caltopo.py carries no readable HAZARD_EVENTS table")


def trigger_events():
    ev = load_json(EVENT_PATH) or {}
    auto = {e.strip() for e in (ev.get("wxAutoEvents") or []) if isinstance(e, str) and e.strip()}
    carried = {name for name, spec in hazard_table().items()
               if isinstance(spec, (tuple, list)) and spec and spec[0] in TRIGGER_TIERS
               and TRIGGER_NAME_RE.search(name)}
    return auto | carried


def fetch_alerts(url):
    """(features, unreachable_reason): a failed request is never an empty all-clear (E1)."""
    ua = "responder-tx-ops/weather-mode"
    try:
        ua = displayable_module().UA.replace("/fetch-snapshot", "/weather-mode")
    except Exception:  # noqa: BLE001, the generic name is still an identifiable client
        pass
    req = urllib.request.Request(url, headers={"User-Agent": ua, "Accept": "application/geo+json"})
    for attempt in range(len(BACKOFFS) + 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                body = json.load(r)
            feats = body.get("features") if isinstance(body, dict) else None
            if not isinstance(feats, list):
                raise ValueError("the answer carries no features list")
            return feats, None
        except (OSError, ValueError) as exc:
            hard_4xx = isinstance(exc, urllib.error.HTTPError) and exc.code != 429 and exc.code < 500
            if attempt == len(BACKOFFS) or hard_4xx:
                return [], f"{type(exc).__name__}: {exc}"
            print(f"warn: NWS attempt {attempt + 1} failed ({exc}); retry in {BACKOFFS[attempt]}s", file=sys.stderr)
            time.sleep(BACKOFFS[attempt])


_DISPLAYABLE = None


def displayable_module():
    global _DISPLAYABLE
    if _DISPLAYABLE is None:
        spec = importlib.util.spec_from_file_location("fetch_snapshot", os.path.join(SCRIPTS, "fetch-snapshot.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _DISPLAYABLE = mod
    return _DISPLAYABLE


REASON_CODES = ("alert", "gauges", "probe", "recent", "operator")


def reason_text(c):
    """The English reason string for one reasonCodes entry; lane C renders the codes in both languages."""
    code = c.get("code")
    if code == "alert":
        return f"{c.get('event')} ({c.get('n')})"
    if code == "gauges":
        return (f"Gauges forecast in moderate flood ({c.get('n')})" if c.get("forecast")
                else f"Gauges in flood ({c.get('n')})")
    return {"probe": "Weather checks unavailable", "recent": "Alerts active in the last 6 hours",
            "operator": OPERATOR_REASON}.get(code, str(code))


def alert_triggers():
    """(reason codes, ids, problem)."""
    try:
        events = trigger_events()
    except (OSError, ValueError, SyntaxError) as exc:
        return [], [], f"trigger list unreadable: {exc}"
    feats, why = fetch_alerts(ALERTS_URL)
    if why:
        return [], [], f"NWS alerts unreachable: {why}"
    counts, ids = Counter(), []
    for f in feats:
        p = (f or {}).get("properties") or {}
        event = str(p.get("event") or "")
        warning_tier = event.endswith(("Warning", "Emergency"))
        if (event in events and p.get("status") == "Actual" and p.get("messageType") != "Cancel"
                and (warning_tier or p.get("severity") in TRIGGER_SEVERITIES)):
            counts[p["event"]] += 1
            ids.append(str(p.get("id") or f.get("id")))
    return [{"code": "alert", "event": e, "n": n} for e, n in sorted(counts.items())], ids, None


def gauge_triggers(now):
    """(reason codes, ids, problem) from the capture fetch-snapshot.py wrote this fire."""
    cap = load_json(CAPTURE_PATH)
    if not isinstance(cap, dict) or not isinstance(cap.get("gauges"), list):
        return [], [], "gauge capture unreadable"
    gen = parse_iso(cap.get("generated"))
    if gen is None or (now - gen).total_seconds() > CAPTURE_MAX_AGE_S:
        return [], [], f"gauge capture is stale (generated {cap.get('generated')})"
    try:
        clean = displayable_module().displayable
    except Exception as exc:  # noqa: BLE001, without the stage envelope an impossible stage reads as a flood
        return [], [], f"stage envelope unavailable: {type(exc).__name__}: {exc}"
    obs, fcst = [], []
    for g in cap["gauges"]:
        st = (clean(g) if isinstance(g, dict) else {}).get("status") or {}
        lid = str(g.get("lid"))
        if (st.get("observed") or {}).get("floodCategory") in OBS_FLOOD:
            obs.append("gauge:" + lid)
        elif (st.get("forecast") or {}).get("floodCategory") in FCST_FLOOD:
            fcst.append("gauge-forecast:" + lid)
    codes = []
    if obs:
        codes.append({"code": "gauges", "n": len(obs)})
    if fcst:
        codes.append({"code": "gauges", "n": len(fcst), "forecast": True})
    return codes, obs + fcst, None


def next_state(prev, codes, ids, problems, now, force):
    s = dict(prev)
    prev_mode = prev.get("mode") if prev.get("mode") in MODES else None
    ok = not problems
    s["lastProbeAt"] = iso(now)
    s["probeOk"] = ok
    s["problems"] = problems
    s["probeFailStreak"] = 0 if ok else max(0, int(prev.get("probeFailStreak") or 0)) + 1
    if ids:
        s["lastTriggerAt"] = iso(now)
    s["alertSetHash"] = hashlib.sha1("\n".join(sorted(ids)).encode()).hexdigest()
    last_trigger = parse_iso(s.get("lastTriggerAt"))
    recent = last_trigger is not None and (now - last_trigger).total_seconds() < LEAVE_ADVERSE_S
    if ids:
        mode, why = "adverse", list(codes)
    elif not ok and (prev_mode is None or (prev_mode == "quiet" and s["probeFailStreak"] >= FAIL_STREAK_ADVERSE)):
        mode, why = "adverse", [{"code": "probe"}]
    elif not ok:
        kept = [c for c in (prev.get("reasonCodes") or []) if isinstance(c, dict) and c.get("code") in REASON_CODES]
        mode, why = prev_mode, kept if prev_mode == "adverse" else []
    elif prev_mode == "adverse" and recent:
        mode, why = "adverse", [{"code": "recent"}]
    else:
        mode, why = "quiet", []
    s["forced"] = force is not None
    if force == "quiet":
        mode, why = "quiet", [{"code": "operator"}]
    elif force == "adverse":
        mode, why = "adverse", [c for c in why if c.get("code") != "operator"] + [{"code": "operator"}] \
            if mode == "adverse" else [{"code": "operator"}]
    s["mode"], s["reasonCodes"], s["reasons"] = mode, why, [reason_text(c) for c in why]
    if mode != prev_mode or not parse_iso(prev.get("since")):
        s["since"] = iso(now)
    return s


def probe(now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    a_codes, a_ids, a_problem = alert_triggers()
    g_codes, g_ids, g_problem = gauge_triggers(now)
    problems = [p for p in (a_problem, g_problem) if p]
    s = next_state(load_state(), a_codes + g_codes, a_ids + g_ids, problems, now, forced_mode(now))
    write_json_atomic(STATE_PATH, s)
    print(f"cadence: mode={s['mode']}{' (forced)' if s['forced'] else ''} since={s['since']} "
          f"reasons={'; '.join(s['reasons']) or 'none'} probe={'ok' if s['probeOk'] else 'FAILED'}"
          + (f" (streak {s['probeFailStreak']}: {'; '.join(problems)})" if problems else ""))
    return s


def latest_anchor(now):
    local = now.astimezone(ANCHOR_TZ)
    slots = [datetime.datetime.combine(local.date() - datetime.timedelta(days=back), datetime.time(h), ANCHOR_TZ)
             for back in (0, 1) for h in ANCHOR_HOURS]
    return max(t for t in slots if t <= local)


def mins(seconds):
    return int(seconds // 60)


def due(state, status, ahead, foreign, now):
    """("full"|"ship"|"hold", reason) for this cron fire."""
    mode = state.get("mode") if state.get("mode") in MODES else "adverse"
    last_pub = parse_iso(state.get("lastPublishAt"))
    since = parse_iso(state.get("since"))
    regular = None
    if last_pub is not None and (last_pub - now).total_seconds() > CLOCK_SKEW_S:
        last_pub, regular = None, "last publish is stamped in the future (clock skew), treated as none"
    if last_pub is None:
        regular = regular or "no publish recorded"
    elif state.get("publishedMode") != mode:
        regular = f"mode changed to {mode}"
    else:
        elapsed = (now - last_pub).total_seconds()
        if mode == "adverse" and elapsed >= ADVERSE_DUE_S:
            regular = f"adverse, last publish {mins(elapsed)} min ago"
        elif mode == "quiet" and elapsed >= QUIET_DUE_S:
            regular = f"quiet, last publish {mins(elapsed)} min ago"
        elif mode == "quiet" and elapsed >= ADVERSE_DUE_S and last_pub < latest_anchor(now):
            regular = f"quiet, the {latest_anchor(now).strftime('%H:%M')} local slot"
    try:
        fails = max(0, int(status.get("consecutive_failures") or 0))
    except (TypeError, ValueError):
        fails = 1  # an unreadable failure count is a failure we cannot pace, never a clean record
    if fails:
        try:
            last_try = datetime.datetime.fromtimestamp(int(status.get("finished_epoch")), datetime.timezone.utc)
            waited = (now - last_try).total_seconds()
        except (TypeError, ValueError, OverflowError, OSError):
            last_try, waited = None, float("inf")
        if waited < -CLOCK_SKEW_S:
            waited = float("inf")  # a future attempt stamp must not pin the retry clock
        news = since is not None and last_try is not None and since > last_try and (mode == "adverse" or last_pub is None)
        if fails <= FAST_RETRY_FAILS or waited >= ADVERSE_DUE_S or news:
            kind = "full" if regular or status.get("stage") != "deploy" else "ship"
            return kind, (f"retry after {fails} failed run(s) at stage {status.get('stage') or 'unknown'}"
                          + (f"; {regular}" if regular else ""))
        return "hold", f"{fails} failed runs; retrying hourly, last attempt {mins(waited)} min ago"
    if regular:
        return "full", regular
    if ahead < 0:
        return "ship", "could not read HEAD against origin/main; an unreadable answer is not \"nothing to ship\""
    if ahead > 0:
        return "ship", f"HEAD is {ahead} commit(s) ahead of origin/main, {foreign} not made by the cycle"
    left = (QUIET_DUE_S if mode == "quiet" else ADVERSE_DUE_S) - (now - last_pub).total_seconds()
    return "hold", f"{mode}, last publish {mins((now - last_pub).total_seconds())} min ago, due within {max(0, mins(left))} min"


def cycle_status(path):
    d = load_json(path)
    return d if isinstance(d, dict) else {}


def cadence_payload(state, fire, now):
    mode = state.get("mode")
    if mode not in MODES or not parse_iso(state.get("since")):
        return None
    return {"generated": iso(now), "mode": mode, "intervalMin": INTERVAL_MIN[mode], "since": state["since"],
            "nextDueBy": iso(fire + datetime.timedelta(minutes=INTERVAL_MIN[mode])),
            "reasons": [str(r)[:80] for r in (state.get("reasons") or [])][:6],
            "reasonCodes": [c for c in (state.get("reasonCodes") or [])
                            if isinstance(c, dict) and c.get("code") in REASON_CODES][:6]}


def arg_after(argv, flag, default=None):
    return argv[argv.index(flag) + 1] if flag in argv and argv.index(flag) + 1 < len(argv) else default


def main(argv):
    now = datetime.datetime.now(datetime.timezone.utc)
    if "--due" in argv:
        state = load_state()
        kind, reason = due(state, cycle_status(arg_after(argv, "--status", "")),
                           int(arg_after(argv, "--ahead", "0")), int(arg_after(argv, "--foreign", "0")), now)
        if state:
            state["lastGate"] = f"{kind}: {reason}"
            state["lastGateAt"] = iso(now)
            write_json_atomic(STATE_PATH, state)
        print(f"{kind} {reason}")
        return 0
    if "--mark-published" in argv:
        at = parse_iso(arg_after(argv, "--mark-published"))
        state = load_state()
        if at is None or not state:
            sys.exit("weather-mode: --mark-published needs an ISO time and an existing state file")
        state["lastPublishAt"] = iso(at)
        state["publishedMode"] = state.get("mode")
        write_json_atomic(STATE_PATH, state)
        return 0
    if "--write-cadence" in argv:
        fire = parse_iso(arg_after(argv, "--write-cadence"))
        payload = cadence_payload(load_state(), fire, now) if fire else None
        if payload is None:
            # a cadence file that cannot be truthful is removed: absent means "fixed thresholds", never quiet
            try:
                os.unlink(CADENCE_PATH)
            except OSError:
                pass
            sys.exit("weather-mode: no usable cadence state; data/cadence.json withdrawn")
        write_json_atomic(CADENCE_PATH, payload)
        print(f"cadence.json: {payload['mode']} every {payload['intervalMin']} min, next due by {payload['nextDueBy']}")
        return 0
    probe(now)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
