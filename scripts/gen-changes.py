#!/usr/bin/env python3
"""Diff this cycle's sources against the state the previous run persisted and append the
transitions to data/changes.json, the Feed's "What changed" stream. The state is
data/changes-state.json. See INTERNAL-NOTES.md "What changed stream" for the state model."""
import copy
import datetime
import hashlib
import importlib.util
import json
import math
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.environ.get("RESPONDER_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import changescheck  # noqa: E402  the publish bounds, shared with cycle-check.sh and run-cycle.sh

OUT_REL = os.path.join("data", "changes.json")
STATE_REL = os.path.join("data", "changes-state.json")
STATE_V = changescheck.STATE_V
UTC = datetime.timezone.utc

RETAIN_DAYS = 7
MAX_EVENTS = 4000
GONE_AFTER = 2
GONE_MIN_S = 600
CONFIRM_N = 2
HYST_FT = 0.2
CREST_FALL_FT = 0.3
CORROB_FT = 1.0
REARM_FT = 1.0
GAP_S = 2 * 3600
CREST_GAP_S = 45 * 60
HOLD_S = 3 * 3600
RISK_GONE_MIN_S = 3600
OPEN_GONE_MIN_S = 3600
ADVANCE_RETRIES = 3
TOMB_S = 24 * 3600
FUTURE_SLACK_S = 300
TRANSTAR_MAX_AGE_S = 2 * 3600
GAUGE_IDLE_DAYS = 30
AREAS_KEPT = 8
NEAR_MAX = 80
KEY_MAX = 32
ROAD_SAME_MI = 1.0
MI_PER_DEG = 69.0
NWS_RANK_MAX = 2
ENDED_ACTS = ("CAN", "EXP", "UPG")
ISSUE_ACTS = ("NEW", "EXA", "EXB")
END_HOW = {"CAN": "can", "UPG": "upg", "EXP": "exp"}

BAND = {"no_flooding": 0, "action": 0, "minor": 1, "moderate": 2, "major": 3}
BAND_CAT = ("none", "minor", "moderate", "major")
# mirrors js/core.js FLOOD_ROAD_RE; tests/gen-changes.test.py holds the two to one pattern
FLOOD_ROAD_RE = re.compile(r"flood|high\s*water|water\s*over|low\s*water|washed?\s*out|overtopp|inundat|swept", re.I)
VTEC_RE = re.compile(r"/[A-Z]\.([A-Z]{3})\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\.")
SHELTER_KEY_RE = re.compile(r"[^a-z0-9]+")

SOURCE_SRC = {"gauges": "nwps", "warnings": "nws", "roads": "txdot", "crossings": "atx",
              "roadrisk": "transtar", "shelters": "fema"}

_SIBLINGS = {}


class Unavailable(Exception):
    """The source cannot vouch for anything this run; its previous state is carried untouched."""


def sibling(name):
    """A sibling generator loaded as a module, so shared constants are read rather than restated."""
    if name not in _SIBLINGS:
        spec = importlib.util.spec_from_file_location("chg_" + re.sub(r"\W", "_", name), os.path.join(HERE, name))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _SIBLINGS[name] = mod
    return _SIBLINGS[name]


def iso(dt):
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse(s):
    if not isinstance(s, str) or not s.strip():
        return None
    try:
        dt = datetime.datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt if dt.year >= 2000 else None


def norm(s):
    dt = parse(s)
    return iso(dt) if dt else None


def secs(a, b):
    """Seconds from ISO a to ISO b, or None when either is unreadable."""
    da, db = parse(a), parse(b)
    return (db - da).total_seconds() if da and db else None


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def coord(lat, lon):
    lat, lon = num(lat), num(lon)
    if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return {}
    return {"lat": round(lat, 4), "lon": round(lon, 4)}


def read_json(root, rel):
    try:
        with open(os.path.join(root, rel), encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError) as e:
        raise Unavailable(f"{rel} unreadable: {e}") from e
    if not isinstance(doc, dict):
        raise Unavailable(f"{rel} is not a JSON object")
    return doc


def stamp_of(doc, rel):
    if str(doc.get("status") or "ok").lower() != "ok" or doc.get("partial") or doc.get("truncated"):
        raise Unavailable(f"{rel} declares a failed or partial read")
    at = norm(doc.get("generated"))
    if not at:
        raise Unavailable(f"{rel} carries no readable generated stamp")
    return at


def event_bbox(root, key, default):
    try:
        with open(os.path.join(root, "data", "event.json"), encoding="utf-8") as f:
            b = json.load(f).get(key) or {}
        if all(num(b.get(k)) is not None for k in ("xmin", "ymin", "xmax", "ymax")):
            return [b["xmin"], b["ymin"], b["xmax"], b["ymax"]]
    except (OSError, ValueError, AttributeError):
        pass  # the sibling generators fall back to the same default on a broken event.json
    return list(default)


def dist_mi(a, b):
    if "lat" not in a or "lat" not in b:
        return None
    kx = math.cos(math.radians((a["lat"] + b["lat"]) / 2))
    return math.hypot((a["lat"] - b["lat"]) * MI_PER_DEG, (a["lon"] - b["lon"]) * MI_PER_DEG * kx)


def near_mi(a, b):
    d = dist_mi(a, b)
    return d is not None and d <= ROAD_SAME_MI


def inside(bbox, item):
    if not bbox or "lat" not in item:
        return True
    return bbox[0] <= item["lon"] <= bbox[2] and bbox[1] <= item["lat"] <= bbox[3]


def src_time(t, at):
    """A source-stated time is used as the event time only when it is readable and not after the
    observation that reported it; otherwise the observation time stands, labelled as detection."""
    dt, seen = parse(t), parse(at)
    if dt and seen and dt <= seen + datetime.timedelta(seconds=FUTURE_SLACK_S):
        return iso(dt), "s"
    return at, "d"


# observers return (at, scope, items) or raise Unavailable when the source cannot vouch this run

def observe_gauges(root, now, fetch):
    rel = os.path.join("data", "gauges-capture.json")
    doc = read_json(root, rel)
    at = stamp_of(doc, rel)
    if not isinstance(doc.get("gauges"), list):
        raise Unavailable(f"{rel} has no gauges list")
    feeds = sibling("gen-feeds.py")
    items = {}
    for g in doc["gauges"]:
        if not isinstance(g, dict) or not g.get("lid"):
            continue
        o = (g.get("status") or {}).get("observed") or {}
        ft, t = o.get("primary"), norm(o.get("validTime"))
        reading = None
        if feeds.stage_ok(ft) and o.get("primaryUnit") == "ft" and t and src_time(t, at)[1] == "s":
            reading = [t, round(float(ft), 2), BAND.get(o.get("floodCategory"))]
        items[str(g["lid"])] = dict({"name": str(g.get("name") or g["lid"]), "r": reading},
                                    **coord(g.get("latitude"), g.get("longitude")))
    return at, None, items


def observe_roads(root, now, fetch):
    rel = os.path.join("data", "roads-capture.json")
    doc = read_json(root, rel)
    at = stamp_of(doc, rel)
    if not isinstance(doc.get("roads"), list):
        raise Unavailable(f"{rel} has no roads list")
    items = {}
    for r in doc["roads"]:
        if not isinstance(r, dict):
            continue
        key = "|".join(str(r.get(k) or "") for k in ("route", "from", "to"))
        v = r.get("v") if isinstance(r.get("v"), list) and len(r["v"]) == 2 else [None, None]
        flood = r.get("cond") == "Flooding" or bool(FLOOD_ROAD_RE.search(str(r.get("desc") or "")))
        if key in items:
            items[key]["flood"] = items[key]["flood"] or flood
            continue
        items[key] = dict({"route": str(r.get("route") or ""), "cond": str(r.get("cond") or ""),
                           "near": str(r.get("from") or "")[:NEAR_MAX], "start": norm(r.get("start")),
                           "end": norm(r.get("end")), "flood": flood}, **coord(v[0], v[1]))
    scope = event_bbox(root, "captureBbox", sibling("gen-roads-snapshot.py").DEFAULT_BBOX)
    return at, scope, items


def observe_crossings(root, now, fetch):
    rel = os.path.join("data", "crossing-status.json")
    doc = read_json(root, rel)
    at = stamp_of(doc, rel)
    if not isinstance(doc.get("crossings"), list):
        raise Unavailable(f"{rel} has no crossings list")
    items = {}
    for c in doc["crossings"]:
        if not isinstance(c, dict) or not c.get("id"):
            continue
        items[str(c["id"])] = dict({"name": str(c.get("name") or c["id"]), "status": str(c.get("status") or ""),
                                    "changed": norm(c.get("changed"))}, **coord(c.get("lat"), c.get("lon")))
    return at, None, items


def observe_roadrisk(root, now, fetch):
    rel = os.path.join("data", "transtar-flood.json")
    doc = read_json(root, rel)
    rows = doc.get("sources") if isinstance(doc.get("sources"), list) else []
    row = rows[0] if rows and isinstance(rows[0], dict) else {}
    if row.get("status") != "ok":
        raise Unavailable(f"{rel} read status is {row.get('status')!r}, not ok")
    at, gen = norm(row.get("captured")), stamp_of(doc, rel)
    if not at:
        raise Unavailable(f"{rel} names no upstream capture time")
    if secs(at, gen) is None or secs(at, gen) > TRANSTAR_MAX_AGE_S:
        raise Unavailable(f"{rel} upstream capture {at} is too old to vouch for {gen}")
    if not isinstance(doc.get("warnings"), list):
        raise Unavailable(f"{rel} has no warnings list")
    items = {}
    for w in doc["warnings"]:
        if isinstance(w, dict) and w.get("id"):
            items[str(w["id"])] = dict({"name": str(w.get("name") or w["id"])}, **coord(w.get("lat"), w.get("lon")))
    return at, None, items


def observe_shelters(root, now, fetch):
    rel = os.path.join("data", "shelters-live.json")
    doc = read_json(root, rel)
    at = stamp_of(doc, rel)
    if not isinstance(doc.get("shelters"), list):
        raise Unavailable(f"{rel} has no shelters list")
    items = {}
    for s in doc["shelters"]:
        if not isinstance(s, dict) or not s.get("name"):
            continue
        pos = coord(s.get("lat"), s.get("lon"))
        key = "%s|%s|%s" % (SHELTER_KEY_RE.sub(" ", str(s["name"]).lower()).strip(),
                            round(pos.get("lat", 0), 2), round(pos.get("lon", 0), 2))
        items[key] = dict({"name": str(s["name"]), "status": str(s.get("status") or "unknown")}, **pos)
    mod = sibling("gen-shelters.py")
    b = event_bbox(root, "gaugeBbox", [mod.DEFAULT_BBOX[k] for k in ("xmin", "ymin", "xmax", "ymax")])
    m = mod.MARGIN
    return at, [b[0] - m, b[1] - m, b[2] + m, b[3] + m], items


def vtec_parts(f):
    codes = ((f.get("properties") or {}).get("parameters") or {}).get("VTEC") or []
    m = VTEC_RE.search(" ".join(c for c in codes if isinstance(c, str)))
    return m.groups() if m else None


def is_emergency(p):
    threat = " ".join((p.get("parameters") or {}).get("flashFloodDamageThreat") or [])
    return "FLASH FLOOD EMERGENCY" in str(p.get("description") or "").upper() or "CATASTROPHIC" in threat.upper()


def product_name(events, sig):
    named = [e for e in events if e and not e.endswith("Statement")]
    if named:
        return named[0]
    base = (events[0] or "").rsplit(" ", 1)[0]
    return f"{base} {dict(W='Warning', A='Watch', Y='Advisory').get(sig, 'Statement')}"


def first_sent(msgs):
    return min((t for t in (norm((m.get("properties") or {}).get("sent")) for m in msgs) if t), default=None)


def group_products(feats, now):
    """One entry per NWS product (VTEC tuple), warnings and watches only, with its lifecycle facts."""
    feeds = sibling("gen-feeds.py")
    groups = {}
    for f in feats:
        try:
            p = (f or {}).get("properties") or {}
            if p.get("event") in feeds.FLOOD_PRODUCTS:
                groups.setdefault(feeds.vtec_key(f), []).append(f)
        except Exception as e:  # noqa: BLE001, one malformed message must not drop every product
            print(f"warn: skipped a malformed NWS message: {type(e).__name__}: {e}", file=sys.stderr)
    out = {}
    for key, msgs in groups.items():
        try:
            g = product_facts(msgs, now, feeds)
        except Exception as e:  # noqa: BLE001, same: skip the product, keep the rest
            print(f"warn: skipped NWS product {key}: {type(e).__name__}: {e}", file=sys.stderr)
            continue
        if g is not None:
            out[key] = g
    return out


def product_facts(msgs, now, feeds):
    """The lifecycle facts of one product's messages, or None when it is not a warning or watch."""
    parts = [vtec_parts(m) for m in msgs]
    sig = next((x[3] for x in parts if x), "")
    name = product_name([(m.get("properties") or {}).get("event") for m in msgs], sig)
    if feeds.FLOOD_PRODUCTS.get(name, 3) > NWS_RANK_MAX:
        return None
    acts = [x[0] if x else None for x in parts]
    live = [m for m, a in zip(msgs, acts) if a not in ENDED_ACTS]
    lead = max(live or msgs, key=lambda m: (m.get("properties") or {}).get("sent") or "")
    lp = lead.get("properties") or {}
    areas = []
    for m in [lead] + [x for x in msgs if x is not lead]:
        for a in feeds.area_names(m.get("properties") or {}):
            if a not in areas:
                areas.append(a)
    ends = [feeds.ends_at(m.get("properties") or {}) for m in live]
    until = None if not live or any(e is None for e in ends) else max((norm(e) for e in ends if norm(e)), default=None)
    g = {"ev": name, "sev": "emergency" if any(is_emergency(m.get("properties") or {}) for m in msgs)
         else ("warning" if sig == "W" or "Warning" in name else "watch"),
         "areas": areas[:AREAS_KEPT], "more": max(0, len(areas) - AREAS_KEPT), "pt": feeds.river_point(lp),
         "wfo": next((x[1][1:] for x in parts if x), None), "until": until,
         "issued": first_sent([m for m, a in zip(msgs, acts) if a in ISSUE_ACTS]),
         "emergAt": first_sent([m for m in msgs if is_emergency(m.get("properties") or {})])}
    if not live:
        ended = [(norm((m.get("properties") or {}).get("sent")), a) for m, a in zip(msgs, acts)]
        t, a = max(ended, key=lambda x: x[0] or "")
        g["ended"] = {"how": END_HOW[a], "t": t}
    elif until and parse(until) <= now:
        g["ended"] = {"how": "exp", "t": until}
    return {k: v for k, v in g.items() if v not in (None, 0)}


def observe_warnings(root, now, fetch):
    feeds = sibling("gen-feeds.py")
    feats, reason = (fetch or feeds.fetch_alerts)(feeds.PRODUCTS_URL)
    if reason:
        raise Unavailable(f"NWS active alerts unreachable: {reason}")
    return iso(now), None, group_products(feats, now)


# steps map (previous items, observation) to (items, events)

def digest(s, n):
    return hashlib.sha1(s.encode("utf-8")).hexdigest()[:n]


def ev(kind, key, act, t, tk, at, src, **fields):
    e = {"id": digest(f"{kind}:{key}:{act}:{t}", 16), "k": kind, "t": t, "tk": tk, "seen": at, "src": src}
    if act:
        e.update(act=act, key=key if len(key) <= KEY_MAX else digest(key, 12))
    e.update({k: v for k, v in fields.items() if v is not None and v is not False and v != ""})
    return e


def gauge_threshold(meta, lid, band):
    m = meta.get(lid) if isinstance(meta, dict) else None
    v = m.get(BAND_CAT[band]) if isinstance(m, dict) and band >= 1 else None
    return float(v) if num(v) is not None else None


def reversal_held(st, p, t):
    """Fast attack, slow release: a fall that reverses a recent rise must persist HOLD_S first."""
    since_rise, held_for = secs(st.get("ut"), p["t"]), secs(p["t"], t)
    return p["d"] < 0 and since_rise is not None and since_rise < HOLD_S and (held_for or 0) < HOLD_S


def gauge_reading(st, lid, cur, meta, at, out):
    """Advance one gauge's band (hysteresis + confirmation) and crest tracker by one new reading."""
    t, ft, band = cur["r"]
    prev_t, prev_ft = st.get("t"), st.get("ft")
    st["t"], st["ft"] = t, ft
    pos = {k: cur[k] for k in ("lat", "lon") if k in cur}
    base = {"lid": lid, "name": cur["name"], **pos}
    if band is not None:
        b = st.get("b")
        if b is None:
            st.update(b=band, lo=ft if band >= 1 else None, p=None)
        else:
            thr = gauge_threshold(meta, lid, b) if b >= 1 else None
            thr = thr if thr is not None else st.get("lo")
            if band > b:
                d = 1
            elif band < b and (thr is None or ft < thr - HYST_FT):
                d = -1
            else:
                d = 0
            if d == 0:
                st["p"] = None
                if b >= 1 and band >= b:
                    st["lo"] = min(st.get("lo") if st.get("lo") is not None else ft, ft)
            else:
                p = st.get("p")
                if p and p["d"] == d:
                    p["n"] += 1
                    p["b"] = min(p["b"], band) if d > 0 else max(p["b"], band)
                else:
                    p = {"d": d, "b": band, "n": 1, "t": t, "ft": ft, "pre": prev_t}
                st["p"] = p
                if p["n"] >= CONFIRM_N and not reversal_held(st, p, t):
                    gap = secs(p.get("pre"), p["t"])
                    out.append(ev("flood", lid, None, p["t"], "s", at, "nwps", ft=p["ft"],
                                  **{"from": BAND_CAT[b], "to": BAND_CAT[p["b"]]},
                                  after=p.get("pre") if gap is not None and gap > GAP_S else None, **base))
                    st.update(b=p["b"], p=None, lo=min(p["ft"], ft) if p["b"] >= 1 else None)
                    if d > 0:
                        st["ut"] = p["t"]
    confirmed = st.get("b") or 0
    flood_now = confirmed >= 1
    k = st.get("k")
    if k and k.get("done"):
        k["lo"] = min(k["lo"], ft)
        if not flood_now and (band or 0) == 0:
            k = None
        elif ft >= k["lo"] + REARM_FT:
            k = new_peak(ft, t, band, prev_t, prev_ft, flood_now, confirmed, True)
    elif k:
        if ft > k["ft"]:
            k = new_peak(ft, t, band, prev_t, prev_ft, k["fl"] or flood_now, max(k.get("cb") or 0, confirmed), True)
        else:
            if "post" not in k:
                k["post"], k["nf"] = t, ft
            k["n"] = k["n"] + 1 if ft <= k["ft"] - CREST_FALL_FT else 0
            k["fl"] = k["fl"] or flood_now
            k["cb"] = max(k.get("cb") or 0, confirmed)
            if k["n"] >= CONFIRM_N:
                crest = crest_fields(k, st)
                if crest:
                    out.append(ev("crest", lid, None, k["t"], "s", at, "nwps", ft=k["ft"], **crest, **base))
                k = {"done": True, "lo": ft}
    elif flood_now or (band or 0) >= 1:
        k = new_peak(ft, t, band, prev_t, prev_ft, flood_now, confirmed, prev_ft is not None and ft > prev_ft)
    st["k"] = k


def compact(st):
    """A gauge's state without empty fields, so an idle gauge costs the state file a few bytes."""
    return {k: (compact(v) if isinstance(v, dict) else v) for k, v in st.items() if v is not None}


def new_peak(ft, t, band, prev_t, prev_ft, fl, cb, rose):
    return {"ft": ft, "t": t, "b": band, "pre": prev_t, "pf": prev_ft, "n": 0, "fl": fl, "cb": cb, "rose": rose}


def crest_fields(k, st):
    """cat and unc for a confirmed fall, or None when the peak was never seen rising into flood. A peak
    no neighbouring reading corroborates is uncertain and cannot raise the category it was confirmed at."""
    cat = k["b"] if k.get("b") is not None else st.get("b")
    near = [x for x in (k.get("pf"), k.get("nf")) if x is not None and abs(k["ft"] - x) <= CORROB_FT]
    if not near:
        cat = min(cat or 0, k.get("cb") or 0)
    if not (k["fl"] and k["rose"] and (cat or 0) >= 1):
        return None
    gaps = [secs(k.get("pre"), k["t"]), secs(k["t"], k.get("post"))]
    return {"cat": BAND_CAT[cat], "unc": not near or any(g is None or g > CREST_GAP_S for g in gaps)}


def step_gauges(prev, obs, at, now, root):
    try:
        meta = read_json(root, os.path.join("data", "gauge-meta.json"))
    except Unavailable:
        meta = {}
    items, out = {}, []
    for lid, cur in obs.items():
        st = dict(prev.get(lid) or {}) if isinstance(prev.get(lid), dict) else None
        if st is None:
            st = {}
            if cur["r"]:
                t, ft, band = cur["r"]
                st = {"t": t, "ft": ft, "b": band, "lo": ft if (band or 0) >= 1 else None}
        elif cur["r"] and (not st.get("t") or cur["r"][0] > st["t"]):
            gauge_reading(st, lid, cur, meta, at, out)
        items[lid] = compact(st)
    idle = now - datetime.timedelta(days=GAUGE_IDLE_DAYS)
    for lid, st in prev.items():
        if lid not in items and isinstance(st, dict) and (parse(st.get("t")) or now) >= idle:
            items[lid] = st
    return items, out


def step_list(prev, obs, at, prev_at, prev_scope, scope, on_new, on_change, on_gone, gone_min=GONE_MIN_S):
    """Shared diff for keyed lists. An absence only counts once the item has been missing from
    GONE_AFTER consecutive fresh observations; scope changes neither create nor clear items. A listed
    item is stored as observed, with no per-cycle stamp, so an unchanged list rewrites nothing."""
    items, out = {}, []
    for key, cur in obs.items():
        p = prev.get(key) if isinstance(prev.get(key), dict) else None
        if p is None:
            if inside(prev_scope, cur):
                out += on_new(key, cur)
        else:
            out += on_change(key, p, cur)
        items[key] = dict(cur)
    for key, p in prev.items():
        if key in obs or not isinstance(p, dict) or not inside(scope, p):
            continue
        p = dict(p, miss=int(p.get("miss") or 0) + 1, gone=p.get("gone") or at, last=p.get("last") or prev_at)
        if gone_confirmed(p, at, gone_min):
            out += on_gone(key, p)
        else:
            items[key] = p
    return items, out


def gone_confirmed(p, at, gone_min=GONE_MIN_S):
    span = secs(p["gone"], at)
    return p["miss"] >= GONE_AFTER and span is not None and span >= gone_min


def gone_fields(p):
    return {"after": p.get("last"), **{k: p[k] for k in ("lat", "lon") if k in p}}


def step_roads(prev, obs, at, prev_at, prev_scope, scope):
    def new(key, cur):
        if not cur["flood"]:
            return []
        t, tk = src_time(cur.get("start"), at)
        return [ev("road", key, "new", t, tk, at, "txdot", route=cur["route"], cond=cur["cond"],
                   near=cur["near"], **{k: cur[k] for k in ("lat", "lon") if k in cur})]

    def change(key, p, cur):
        cur["flood"] = cur["flood"] or bool(p.get("flood"))
        if cur["flood"] and not p.get("flood"):
            return [ev("road", key, "new", at, "d", at, "txdot", route=cur["route"], cond=cur["cond"],
                       near=cur["near"], **{k: cur[k] for k in ("lat", "lon") if k in cur})]
        return []

    def gone(key, p):
        if not p.get("flood"):
            return []
        # TxDOT re-enters closures with edited limits: the same route still listed nearby is no clear
        if any(c["route"] == p.get("route") and near_mi(c, p) for c in obs.values()):
            return []
        end, last = parse(p.get("end")), parse(p.get("last"))
        if end and last and last < end <= parse(p["gone"]):
            t, tk, how = iso(end), "s", "end"
        else:
            t, tk, how = p["gone"], "d", "gone"
        return [ev("road", key, "clear", t, tk, at, "txdot", route=p.get("route"), cond=p.get("cond"),
                   near=p.get("near"), how=how, **gone_fields(p))]

    return step_list(prev, obs, at, prev_at, prev_scope, scope, new, change, gone)


def step_crossings(prev, obs, at, prev_at, prev_scope, scope):
    def pos(x):
        return {k: x[k] for k in ("lat", "lon") if k in x}

    def new(key, cur):
        t, tk = src_time(cur.get("changed"), at)
        return [ev("xing", key, "new", t, tk, at, "atx", name=cur["name"], status=cur["status"], **pos(cur))]

    def change(key, p, cur):
        if cur["status"] == p.get("status"):
            return []
        newer = parse(cur.get("changed")) and (not parse(p.get("changed"))
                                                or parse(cur["changed"]) > parse(p["changed"]))
        t, tk = src_time(cur["changed"], at) if newer else (at, "d")
        return [ev("xing", key, "status", t, tk, at, "atx", name=cur["name"], status=cur["status"], **pos(cur))]

    def gone(key, p):
        return [ev("xing", key, "clear", p["gone"], "d", at, "atx", name=p.get("name"), status=p.get("status"),
                   **gone_fields(p))]

    return step_list(prev, obs, at, prev_at, prev_scope, scope, new, change, gone)


def step_roadrisk(prev, obs, at, prev_at, prev_scope, scope):
    def new(key, cur):
        return [ev("risk", key, "new", at, "d", at, "transtar", name=cur["name"],
                   **{k: cur[k] for k in ("lat", "lon") if k in cur})]

    def gone(key, p):
        return [ev("risk", key, "clear", p["gone"], "d", at, "transtar", name=p.get("name"), **gone_fields(p))]

    return step_list(prev, obs, at, prev_at, prev_scope, scope, new, lambda *a: [], gone, RISK_GONE_MIN_S)


def step_shelters(prev, obs, at, prev_at, prev_scope, scope):
    def pos(x):
        return {k: x[k] for k in ("lat", "lon") if k in x}

    def new(key, cur):
        return [ev("shelter", key, "new", at, "d", at, "fema", name=cur["name"], status=cur["status"], **pos(cur))]

    def change(key, p, cur):
        if cur["status"].lower() == str(p.get("status") or "").lower():
            return []
        return [ev("shelter", key, "status", at, "d", at, "fema", name=cur["name"], status=cur["status"], **pos(cur))]

    def gone(key, p):
        return [ev("shelter", key, "clear", p["gone"], "d", at, "fema", name=p.get("name"), status=p.get("status"),
                   **gone_fields(p))]

    return step_list(prev, obs, at, prev_at, prev_scope, scope, new, change, gone)


def warn_fields(g):
    return {k: g.get(k) for k in ("ev", "sev", "areas", "more", "pt", "wfo")}


def step_warnings(prev, obs, at, prev_at, now, tomb):
    items, out = {}, []
    for key, g in obs.items():
        p = prev.get(key) if isinstance(prev.get(key), dict) else None
        if g.get("ended"):
            if p:
                t, tk = src_time(g["ended"]["t"], at)
                out.append(ev("warn", key, "end", t, tk, at, "nws", how=g["ended"]["how"], **warn_fields(g)))
                tomb[key] = at
            continue
        if p is None:
            if key in tomb:
                out.append(ev("warn", key, "new", at, "d", at, "nws", again=True, **warn_fields(g)))
                tomb.pop(key, None)
            else:
                t, tk = src_time(g.get("issued"), at)
                out.append(ev("warn", key, "new", t, tk, at, "nws", **warn_fields(g)))
        elif g["sev"] == "emergency" and p.get("sev") != "emergency":
            t, tk = src_time(g.get("emergAt"), at)
            out.append(ev("warn", key, "up", t, tk, at, "nws", **warn_fields(g)))
        items[key] = dict(g)
    for key, p in prev.items():
        if key in obs or not isinstance(p, dict):
            continue
        until = parse(p.get("until"))
        if until and until <= now:
            out.append(ev("warn", key, "end", iso(until), "s", at, "nws", how="exp", **warn_fields(p)))
            tomb[key] = at
            continue
        p = dict(p, miss=int(p.get("miss") or 0) + 1, gone=p.get("gone") or at, last=p.get("last") or prev_at)
        # a product with no stated end is the one most likely to drop out of the feed between updates
        if gone_confirmed(p, at, GONE_MIN_S if p.get("until") else OPEN_GONE_MIN_S):
            out.append(ev("warn", key, "end", p["gone"], "d", at, "nws", how="gone", after=p.get("last"),
                          **warn_fields(p)))
            tomb[key] = at
        else:
            items[key] = p
    cut = now - datetime.timedelta(seconds=TOMB_S)
    for key in [k for k, v in tomb.items() if (parse(v) or now) < cut]:
        tomb.pop(key)
    return items, out


SOURCES = (
    ("gauges", observe_gauges),
    ("warnings", observe_warnings),
    ("roads", observe_roads),
    ("crossings", observe_crossings),
    ("roadrisk", observe_roadrisk),
    ("shelters", observe_shelters),
)
LIST_STEPS = {"roads": step_roads, "crossings": step_crossings, "roadrisk": step_roadrisk,
              "shelters": step_shelters}


def advance(name, prev, at, scope, items, now, root):
    """(new source state, events) for one fresh observation diffed against its previous state."""
    old = prev["items"]
    if name == "gauges":
        new_items, events = step_gauges(old, items, at, now, root)
        return {"items": new_items}, events
    if name == "warnings":
        tomb = dict(prev.get("tomb") or {})
        new_items, events = step_warnings(old, items, at, prev["at"], now, tomb)
        return {"items": new_items, "tomb": tomb}, events
    new_items, events = LIST_STEPS[name](old, items, at, prev["at"], prev.get("scope"), scope)
    return {"items": new_items}, events


def baseline_items(name, items, at):
    if name == "gauges":
        out = {}
        for lid, cur in items.items():
            if cur["r"]:
                t, ft, band = cur["r"]
                out[lid] = compact({"t": t, "ft": ft, "b": band, "lo": ft if (band or 0) >= 1 else None})
            else:
                out[lid] = {}
        return out
    return {k: dict(v) for k, v in items.items() if not (isinstance(v, dict) and v.get("ended"))}


def valid_prev(prev):
    return (isinstance(prev, dict) and isinstance(prev.get("items"), dict)
            and parse(prev.get("at")) is not None)


def load_state(root):
    """(sources, pending lines, note). Pending lines are the last runs' events not yet seen in the log."""
    path = os.path.join(root, STATE_REL)
    if not os.path.exists(path):
        return {}, [], "no previous state; every source baselines"
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
        problem = changescheck.state_problem(doc)
        if problem:
            raise ValueError(problem)
        pending = doc.get("pending") if isinstance(doc.get("pending"), list) else []
        return doc["sources"], [e for e in pending if isinstance(e, dict) and e.get("id")], None
    except (OSError, ValueError, AttributeError) as e:
        return {}, [], f"previous state unreadable ({e}); every source baselines"


def load_log(root):
    """The published event log; a corrupt working copy falls back to the committed one."""
    def events_of(doc):
        if not isinstance(doc, dict) or not isinstance(doc.get("events"), list):
            raise ValueError("no events list")
        return [e for e in doc["events"] if isinstance(e, dict) and e.get("id") and parse(e.get("seen"))
                and parse(e.get("t"))]

    path = os.path.join(root, OUT_REL)
    if not os.path.exists(path):
        return [], None
    try:
        with open(path, encoding="utf-8") as f:
            return events_of(json.load(f)), None
    except (OSError, ValueError) as e:
        local = e
    try:
        raw = subprocess.run(["git", "-C", root, "show", "HEAD:data/changes.json"], capture_output=True,
                             timeout=30, check=True).stdout
        return events_of(json.loads(raw)), f"{OUT_REL} unreadable ({local}); recovered the committed log"
    except (OSError, ValueError, subprocess.SubprocessError) as e:
        return [], f"{OUT_REL} unreadable ({local}) and no committed copy ({type(e).__name__}); log restarts"


def clamp(stamp, now):
    return min(stamp, iso(now)) if parse(stamp) else None


def publishable(e, now):
    """Exactly the bounds cycle-check enforces, so a line that would fail the gate is dropped here."""
    return changescheck.event_problem(e, now, RETAIN_DAYS) is None


def merge_events(log, fresh, now):
    by_id = {}
    for e in log + fresh:
        if not publishable(e, now):
            print(f"warn: dropped an event outside the publish bounds: {str(e)[:200]}", file=sys.stderr)
            continue
        by_id.setdefault(e["id"], e)
    cut = now - datetime.timedelta(days=RETAIN_DAYS)
    kept = [e for e in by_id.values() if parse(e["seen"]) >= cut]
    kept.sort(key=lambda e: (e["t"], e["seen"], e["id"]), reverse=True)
    if len(kept) > MAX_EVENTS:
        print(f"warn: change log over {MAX_EVENTS} events; dropping the {len(kept) - MAX_EVENTS} oldest",
              file=sys.stderr)
        kept = sorted(kept, key=lambda e: (e["seen"], e["t"]), reverse=True)[:MAX_EVENTS]
        kept.sort(key=lambda e: (e["t"], e["seen"], e["id"]), reverse=True)
    return kept


def write_atomic(path, text):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix="." + os.path.basename(path) + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:  # SystemExit from a SIGTERM must still drop the temp file
        os.unlink(tmp)
        raise


def write_state(path, state):
    """Sorted, one value per line, and untouched when unchanged, so a quiet cycle adds nothing to git."""
    text = json.dumps(state, sort_keys=True, indent=0, separators=(",", ":"), ensure_ascii=False) + "\n"
    try:
        with open(path, encoding="utf-8") as f:
            if f.read() == text:
                return
    except OSError:
        pass  # no previous state file: write it
    write_atomic(path, text)


def run(root=None, now=None, fetch=None):
    """One generator pass: writes both files, returns (payload, notes, new event count, degraded)."""
    root = root or ROOT
    now = (now or datetime.datetime.now(UTC)).astimezone(UTC).replace(microsecond=0)
    prev_sources, pending, state_note = load_state(root)
    log, log_note = load_log(root)
    notes = [n for n in (state_note, log_note) if n]
    sources, fresh, failed = {}, [], []
    for name, observe in SOURCES:
        prev = prev_sources.get(name)
        prev = prev if valid_prev(prev) else None
        try:
            raw_at, scope, items = observe(root, now, fetch)
        except Exception as e:  # noqa: BLE001, one broken source must not freeze the other five
            notes.append(f"{name}: {e if isinstance(e, Unavailable) else f'failed ({type(e).__name__}: {e})'}; "
                         "previous state carried")
            if name == "warnings" or not isinstance(e, Unavailable):
                failed.append(name)
            if prev is not None:
                sources[name] = prev
            continue
        # freshness compares the source's own stamps; no event is dated ahead of this run
        at = min(raw_at, iso(now))
        if prev is None:
            sources[name] = {"at": raw_at, "since": at, "scope": scope, "items": baseline_items(name, items, at)}
            notes.append(f"{name}: baseline at {raw_at}, no events")
            continue
        if parse(raw_at) <= parse(prev["at"]):
            sources[name] = prev
            notes.append(f"{name}: not refreshed since {prev['at']}; carried")
            continue
        try:
            # the diff works on a copy: a failure part-way must carry the state it started from
            body, events = advance(name, copy.deepcopy(prev), at, scope, items, now, root)
        except Exception as e:  # noqa: BLE001, a diff that cannot run carries the source; repeated, it re-baselines
            failed.append(name)
            errs = int(prev.get("err") or 0) + 1
            if errs >= ADVANCE_RETRIES:
                sources[name] = {"at": raw_at, "since": at, "scope": scope, "items": baseline_items(name, items, at)}
                notes.append(f"{name}: diff failed {errs} times ({type(e).__name__}: {e}); re-baselined, no events")
            else:
                sources[name] = dict(prev, err=errs)
                notes.append(f"{name}: diff failed ({type(e).__name__}: {e}); previous state carried")
            continue
        sources[name] = dict(body, at=raw_at, since=prev.get("since") or at, scope=scope)
        fresh += events
        notes.append(f"{name}: {len(events)} new events")
    log_ids = {e["id"] for e in log}
    carried = [e for e in pending if e["id"] not in log_ids]
    events = merge_events(log, carried + fresh, now)
    kept = {e["id"] for e in events}
    since = [s["since"] for s in sources.values() if s.get("since")]
    payload = {
        "generated": iso(now),
        "retainDays": RETAIN_DAYS,
        "since": max(since) if since else None,
        "sources": {name: {"src": SOURCE_SRC[name], "at": clamp((sources.get(name) or {}).get("at"), now),
                           "since": clamp((sources.get(name) or {}).get("since"), now)} for name, _ in SOURCES},
        "events": events,
    }
    os.makedirs(os.path.join(root, "data"), exist_ok=True)
    # the state goes first and names the lines this run adds, so a kill before the log lands loses
    # nothing and repeats nothing: the next run finds them pending and merges them by id
    pending = list({e["id"]: e for e in carried + fresh if e["id"] in kept}.values())
    write_state(os.path.join(root, STATE_REL), {"v": STATE_V, "sources": sources, "pending": pending})
    write_atomic(os.path.join(root, OUT_REL), json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n")
    return payload, notes, len(fresh), bool(failed)


def main(root=None, now=None, fetch=None):
    """Exit 3 when this run's own NWS read or a source's diff failed: the log is still written,
    and run-cycle.sh signs the cycle off degraded instead of clean."""
    payload, notes, added, degraded = run(root, now, fetch)
    for n in notes:
        print(f"gen-changes: {n}")
    print(f"changes.json: {added} new events, {len(payload['events'])} retained @ {payload['generated']}"
          + (" (DEGRADED)" if degraded else ""))
    return 3 if degraded else 0


if __name__ == "__main__":
    sys.exit(main())
