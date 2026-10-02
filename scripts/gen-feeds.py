#!/usr/bin/env python3
"""Generate feed.xml (RSS 2.0) + crests.ics from current board data.

Zero-backend public follow mechanism: run each release cycle before deploy.
Reads data/requests.json + data/gauges-snapshot.json + live NWS alerts (flash flood and tornado
emergencies, and the flood warnings, watches and advisories in the area);
writes feed.xml and crests.ics at the repo root (served on the public mirror).
Honest by construction: every item stamps its time; forecast crests use real
NWPS validTime; nothing is invented.
"""
import datetime
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.sax.saxutils as sx

try:
    from zoneinfo import ZoneInfo
    CT = ZoneInfo("America/Chicago")
except (ImportError, KeyError):  # no tz database on this host: times print in UTC rather than fail the feed
    CT = None

ROOT = os.environ.get("RESPONDER_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://respondertx.org"
UA = "responder-tx-ops (rfxnryan@gmail.com)"
# healthy answers measure ~0.1s, so a short deadline plus retries beats one long wait on a hang
TIMEOUT = 12
BACKOFFS = [2, 5]
# mirrors js/core.js stageOk; see INTERNAL-NOTES.md "Impossible gauge stages"
STAGE_MIN_FT = -300
STAGE_MAX_FT = 25000


def stage_ok(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and STAGE_MIN_FT < v < STAGE_MAX_FT


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc)


def rfc822(dt):
    return dt.astimezone(datetime.timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")


def ics_stamp(dt):
    return dt.astimezone(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


EMERGENCY_UNKNOWN_TITLE = "Flash flood emergency check unavailable"
TORNADO_UNKNOWN_TITLE = "Tornado emergency check unavailable"
PRODUCTS_UNKNOWN_TITLE = "Flood warning and advisory check unavailable"
MAX_ITEMS = 40

AREA = "TX"  # the alerts query scope, as js/core.js CONFIG.alertsUrl
# the flood subset of js/sources.js HAZARD_EVENTS, lowest rank first; tests/gen-feeds.test.py holds
# every name to the scripts/gen-caltopo.py mirror, because a misspelt event= answers 200 with zero
FLOOD_PRODUCTS = {
    "Flash Flood Warning": 0, "Flash Flood Statement": 0,
    "Flood Warning": 1, "Flood Statement": 1, "Storm Surge Warning": 1,
    "Coastal Flood Warning": 1, "Coastal Flood Statement": 1,
    "Lakeshore Flood Warning": 1, "Lakeshore Flood Statement": 1,
    "Flash Flood Watch": 2, "Flood Watch": 2, "Storm Surge Watch": 2,
    "Coastal Flood Watch": 2, "Lakeshore Flood Watch": 2,
    "Flood Advisory": 3, "Coastal Flood Advisory": 3, "Lakeshore Flood Advisory": 3,
}
WARNING_RANK_MAX = 1  # warnings lead the crests under the item cap; watches and advisories follow them
PRODUCTS_URL = (f"https://api.weather.gov/alerts/active?area={AREA}&event="
                + urllib.parse.quote(",".join(FLOOD_PRODUCTS), safe=","))
VTEC_TUPLE_RE = re.compile(r"/[A-Z]\.[A-Z]{3}\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\.")
VTEC_NO_END = "-000000T0000Z"
AREAS_SHOWN = 6


def load_json(path, default):
    try:
        with open(os.path.join(ROOT, path), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def load_required(path):
    """A source the feed makes claims about. Unreadable aborts, so run-cycle.sh keeps the previous
    feed.xml and its older stamp rather than publishing a crest-free feed as the current picture."""
    try:
        with open(os.path.join(ROOT, path), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as exc:
        raise SystemExit(f"gen-feeds: {path} unreadable ({exc}); keeping the previous feed.xml and crests.ics")


def event_branding():
    ev = load_json("data/event.json", {})
    name = ev.get("name") or "Responder TX"
    label = ev.get("event") or ev.get("eventName") or ""
    region = ev.get("region") or ""
    title = f"{name} · {label}" if label else f"{name} · Flood Ops"
    area = region or label or "the current coverage area"
    desc = (f"Flood warnings, watches and advisories, flash flood emergencies, forecast river crests, "
            f"and active notices for {area}. "
            "Situational awareness, not a dispatch system; call 911 for emergencies.")
    return title, desc


def fetch_alerts(url):
    """(features, unreachable_reason). A failed check reports a reason and never a bare empty list:
    an empty feed reads as an all clear, which a request that failed never said. Retried through
    BACKOFFS so one slow answer does not drop live warnings for a whole cycle."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/geo+json"})
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
            print(f"warn: NWS attempt {attempt + 1} failed ({exc}); "
                  f"retry in {BACKOFFS[attempt]}s", file=sys.stderr)
            time.sleep(BACKOFFS[attempt])


def item_of(f, threat):
    p = f.get("properties", {})
    return {
        "id": p.get("id") or f.get("id"),
        "threat": threat,
        "area": p.get("areaDesc", ""),
        "headline": p.get("headline") or p.get("event"),
        "sent": p.get("sent"),
        "expires": p.get("expires"),
        "url": f.get("id"),
    }


def fetch_emergencies():
    feats, reason = fetch_alerts("https://api.weather.gov/alerts/active?event=Flash%20Flood%20Warning&area=TX")
    out = []
    for f in feats:
        threat = (f.get("properties", {}).get("parameters", {}).get("flashFloodDamageThreat") or [""])[0]
        if threat in ("CATASTROPHIC", "CONSIDERABLE"):
            out.append(item_of(f, threat))
    return out, reason


def fetch_tornado_emergencies():
    """Tornado emergencies (damage threat CATASTROPHIC) and PDS tornado warnings. Mirrors
    js/sources.js alertTags: the PDS sentence rides in the warning text and is not a parameter, so
    both are read and either is enough."""
    feats, reason = fetch_alerts("https://api.weather.gov/alerts/active?event=Tornado%20Warning&area=TX")
    out = []
    for f in feats:
        p = f.get("properties", {})
        threat = (p.get("parameters", {}).get("tornadoDamageThreat") or [""])[0].upper()
        pds = threat in ("CATASTROPHIC", "CONSIDERABLE") \
            or "PARTICULARLY DANGEROUS SITUATION" in (p.get("description") or "").upper()
        if threat == "CATASTROPHIC":
            out.append(item_of(f, "TORNADO EMERGENCY"))
        elif pds:
            out.append(item_of(f, "PARTICULARLY DANGEROUS SITUATION"))
    return out, reason


def vtec_key(f):
    """One warning's identity across reissues and segments (mirrors js/sources.js alertVtecKey)."""
    p = f.get("properties") or {}
    m = VTEC_TUPLE_RE.search(" ".join((p.get("parameters") or {}).get("VTEC") or []))
    return ".".join(m.groups()) if m else str(f.get("id") or p.get("id") or "")


def ends_at(p):
    """When the hazard ends (mirrors js/sources.js alertEndsAt); None is a declared open end."""
    params = p.get("parameters") or {}
    if VTEC_NO_END in " ".join(params.get("VTEC") or []):
        return None
    return p.get("ends") or (params.get("eventEndingTime") or [None])[0] or p.get("expires")


def area_names(p):
    """In-area names: geocode.UGC is index-aligned with areaDesc (mirrors js/sources.js
    alertAreaParts), and an alignment that cannot be read names them all."""
    segs = [s.strip() for s in str(p.get("areaDesc") or "").split(";") if s.strip()]
    ugc = (p.get("geocode") or {}).get("UGC") or []
    if len(ugc) == len(segs):
        segs = [s for s, u in zip(segs, ugc) if str(u)[:2].upper() == AREA] or segs
    return [re.sub(r",\s*[A-Z]{2}$", "", s) for s in segs]


def ct_text(iso):
    dt = parse_iso(iso)
    if not dt:
        return str(iso)
    if CT is None:
        return dt.strftime("%b %d, %H:%M UTC")
    d = dt.astimezone(CT)
    return f"{d:%b} {d.day}, {d.hour % 12 or 12}:{d:%M} {'AM' if d.hour < 12 else 'PM'} CT"


def flood_products(feats, now):
    """One entry per warning, keyed on its VTEC tuple: a reissue is the same entry, and a watch split
    into segments is one entry naming every segment's areas. The message that runs latest speaks
    for the entry, as js/sources.js alertDedupe keeps it."""
    groups = {}
    for f in feats:
        p = f.get("properties") or {}
        if p.get("event") not in FLOOD_PRODUCTS:
            continue
        end = ends_at(p)
        end_dt = parse_iso(end) if end else None
        if end_dt and end_dt < now:
            continue  # past its hazard end; the active list can trail the clock
        groups.setdefault(vtec_key(f), []).append(f)
    open_end = datetime.datetime.max.replace(tzinfo=datetime.timezone.utc)
    unreadable = datetime.datetime.min.replace(tzinfo=datetime.timezone.utc)

    def runs_until(f):
        end = ends_at(f.get("properties") or {})
        return open_end if end is None else (parse_iso(end) or unreadable)

    out = []
    for key, msgs in groups.items():
        lead = max(msgs, key=runs_until)
        lp = lead.get("properties") or {}
        areas = []
        for f in [lead] + [m for m in msgs if m is not lead]:
            for name in area_names(f.get("properties") or {}):
                if name not in areas:
                    areas.append(name)
        sent = [d for d in (parse_iso((m.get("properties") or {}).get("sent")) for m in msgs) if d]
        has_vtec = VTEC_TUPLE_RE.search(" ".join((lp.get("parameters") or {}).get("VTEC") or []))
        out.append({
            # the feature id is the alert URL and properties.id the bare urn; callers may hold either
            "ids": {str(i) for m in msgs for i in (m.get("id"), (m.get("properties") or {}).get("id")) if i},
            "event": lp.get("event"), "rank": FLOOD_PRODUCTS[lp.get("event")], "areas": areas,
            "headline": lp.get("headline") or lp.get("event"), "sent": lp.get("sent"), "until": ends_at(lp),
            # the ETN restarts every year, so the year keeps next year's 0001 off this guid
            "guid": f"nws-{key}-{min(sent).year}" if has_vtec and sent else key,
        })
    out.sort(key=lambda x: x["sent"] or "", reverse=True)
    out.sort(key=lambda x: x["rank"])
    return out


def fetch_flood_products(now):
    feats, reason = fetch_alerts(PRODUCTS_URL)
    return flood_products(feats, now), reason


def product_item(x, built):
    shown = x["areas"][:AREAS_SHOWN]
    more = len(x["areas"]) - len(shown)
    where = ", ".join(shown) + (f" and {more} more" if more > 0 else "")
    until = ct_text(x["until"]) if x["until"] else "further notice"
    it_title = f"{x['event']} · {where}" if where else x["event"]
    it_desc = (f"{x['headline']}. In effect until {until}. "
               + (f"Areas: {', '.join(x['areas'])}. " if x["areas"] else "")
               + "Source: National Weather Service. Call 911 for life-threatening emergencies.")
    return (parse_iso(x["sent"]) or built, it_title, it_desc, f"{SITE}/?tab=alerts", x["guid"])


def rising_crests(snapshot):
    RANK = {"none": 0, "action": 1, "minor": 2, "moderate": 3, "major": 4}
    out = []
    for g in snapshot.get("gauges", []):
        st = g.get("status") or {}
        o = st.get("observed") or {}
        fc = st.get("forecast") or {}
        obs = o.get("primary") if stage_ok(o.get("primary")) else None
        ocat = (o.get("floodCategory") or "none") if obs is not None else "none"
        fcat = fc.get("floodCategory") or "none"
        crest = fc.get("primary")
        when = parse_iso(fc.get("validTime"))
        if not stage_ok(crest):
            continue  # NWPS missing-value sentinel, or a value no river can reach
        if not when or when.year < 2000:
            continue  # NWPS epoch/sentinel timestamp
        if fcat == "major" and RANK.get(fcat, 0) > RANK.get(ocat, 0):
            out.append({
                "lid": g.get("lid"), "name": g.get("name"),
                "obs": obs, "ocat": ocat,
                "crest": fc.get("primary"), "when": fc.get("validTime"),
            })
    out.sort(key=lambda x: x["when"])
    return out


def parse_iso(s):
    try:
        dt = datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:  # offset-less upstream stamp — assume UTC, never return naive
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt


def unknown_item(built, title, what, guid_slug):
    return (built, title,
            "This feed could not reach the National Weather Service active-alerts "
            f"service at {rfc822(built)}, so it cannot say whether {what} "
            "is in effect. Treat that as unknown, not as an all clear. "
            "Check weather.gov for alerts covering your area. "
            "Call 911 for life-threatening emergencies.",
            "https://www.weather.gov/",
            f"{guid_slug}-{built.strftime('%Y-%m-%dT%H')}")


def build_rss(emergencies, tornadoes, crests, notices, built, title, desc,
              unreachable=None, tornado_unreachable=None, products=(), products_unreachable=None):
    # life-safety items and the unknown notices are held apart from the volume cap below: the
    # cap sorts by time, and a busy notice day would otherwise push a tornado emergency out
    lead = []
    items = []
    # the absence of emergency items is what a subscriber reads as an all clear, so a check that
    # never completed has to say so in the feed itself; nothing else the subscriber sees can
    if unreachable:
        lead.append(unknown_item(built, EMERGENCY_UNKNOWN_TITLE, "a flash flood emergency",
                                 "nws-check-unavailable"))
    if tornado_unreachable:
        lead.append(unknown_item(built, TORNADO_UNKNOWN_TITLE,
                                 "a tornado emergency or a particularly dangerous situation",
                                 "nws-tornado-check-unavailable"))
    if products_unreachable:
        lead.append(unknown_item(built, PRODUCTS_UNKNOWN_TITLE, "any flood warning, watch or advisory",
                                 "nws-flood-products-unavailable"))
    warnings = [product_item(x, built) for x in products if x["rank"] <= WARNING_RANK_MAX]
    standing = [product_item(x, built) for x in products if x["rank"] > WARNING_RANK_MAX]
    for e in emergencies:
        pub = parse_iso(e.get("sent")) or built
        it_title = f"{e['threat']} flash flood · {e['area']}"
        it_desc = f"{e.get('headline','')} Expires {e.get('expires','')}. Life-threatening emergency: call 911."
        lead.append((pub, it_title, it_desc, e.get("url") or SITE, e.get("id") or it_title))
    for e in tornadoes:
        pub = parse_iso(e.get("sent")) or built
        it_title = f"{e['threat']} · tornado warning · {e['area']}"
        it_desc = f"{e.get('headline','')} Expires {e.get('expires','')}. Take shelter now; call 911 only for life-threatening emergencies."
        lead.append((pub, it_title, it_desc, e.get("url") or SITE, e.get("id") or it_title))
    for c in crests:
        pub = built
        it_title = f"MAJOR crest forecast · {c['name']} ({c['crest']} ft)"
        obs = f"Observed {c['obs']} ft ({c['ocat']})" if c["obs"] is not None else "No current observed reading"
        it_desc = f"{obs}; forecast crest {c['crest']} ft MAJOR at {c['when']}. Source: NOAA NWPS."
        link = f"{SITE}/?hydro={c['lid']}"
        items.append((pub, it_title, it_desc, link, f"crest-{c['lid']}-{c['when']}"))
    for n in notices:
        pub = parse_iso(n.get("ts")) or built
        it_title = f"[{n.get('priority','').upper()}] {n.get('summary','')}"
        place = f"{n.get('place','')} ({n.get('county','')} Co.)"
        it_desc = f"{n.get('details','')} · {place}".strip(" ·")
        link = (n.get("source") or {}).get("url") or SITE
        items.append((pub, it_title, it_desc, link, n.get("id") or it_title))
    lead.sort(key=lambda x: x[0], reverse=True)
    items.sort(key=lambda x: x[0], reverse=True)
    rest = warnings + items + standing
    items = lead + rest[:max(0, MAX_ITEMS - len(lead))]

    parts = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<rss version="2.0"><channel>',
             f"<title>{sx.escape(title)}</title>",
             f"<link>{SITE}/</link>",
             f"<description>{sx.escape(desc)}</description>",
             "<language>en-us</language>",
             f"<lastBuildDate>{rfc822(built)}</lastBuildDate>"]
    for pub, it_title, it_desc, link, guid in items:
        parts.append("<item>"
                     f"<title>{sx.escape(it_title)}</title>"
                     f"<link>{sx.escape(link)}</link>"
                     f"<description>{sx.escape(it_desc)}</description>"
                     f"<pubDate>{rfc822(pub)}</pubDate>"
                     f"<guid isPermaLink=\"false\">{sx.escape(str(guid))}</guid>"
                     "</item>")
    parts.append("</channel></rss>")
    return "".join(parts)


def ics_escape(s):
    return str(s).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def build_ics(crests, built):
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Responder TX//Crest Calendar//EN",
             "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Responder TX · forecast river crests"]
    for c in crests:
        start = parse_iso(c["when"])
        if not start:
            continue
        end = start + datetime.timedelta(hours=1)
        obs = f"observed {c['obs']} ft" if c["obs"] is not None else "no current observed reading"
        lines += ["BEGIN:VEVENT",
                  f"UID:crest-{c['lid']}-{ics_stamp(start)}@responder.rfxn.com",
                  f"DTSTAMP:{ics_stamp(built)}",
                  f"DTSTART:{ics_stamp(start)}",
                  f"DTEND:{ics_stamp(end)}",
                  f"SUMMARY:{ics_escape('MAJOR crest · ' + c['name'] + ' (' + str(c['crest']) + ' ft)')}",
                  f"DESCRIPTION:{ics_escape('Forecast MAJOR crest ' + str(c['crest']) + ' ft (' + obs + '). NOAA NWPS. Not a dispatch system; call 911 for emergencies.')}",
                  f"URL:{SITE}/?hydro={c['lid']}",
                  "END:VEVENT"]
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"


def write_atomic(path, payload):
    """Rename into place, so a run killed at its time budget leaves the previous feed intact
    rather than a truncated one the cycle would then commit."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix="." + os.path.basename(path) + ".",
                               suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
        os.replace(tmp, path)
    except BaseException:  # BaseException, not Exception: SystemExit from a SIGTERM must clean up too
        os.unlink(tmp)
        raise


def main():
    built = now_utc()
    snapshot = load_required("data/gauges-snapshot.json")
    reqs = load_required("data/requests.json")
    cutoff = built - datetime.timedelta(hours=24)  # mirror the UI aging invariant: stale notices drop out

    def fresh(r):
        ts = parse_iso(r.get("ts"))
        return ts is not None and ts >= cutoff

    notices = [r for r in reqs.get("requests", [])
               if r.get("status") != "resolved" and r.get("priority") in ("critical", "high")
               and r.get("origin") != "operator"  # LAN operator intakes never ship to the public feed
               and fresh(r)]
    notices.sort(key=lambda r: r.get("ts", ""), reverse=True)
    emergencies, unreachable = fetch_emergencies()
    tornadoes, tornado_unreachable = fetch_tornado_emergencies()
    products, products_unreachable = fetch_flood_products(built)
    # a warning already published as an emergency item is not repeated as an ordinary one
    emergency_ids = {str(e.get("id")) for e in emergencies}
    products = [x for x in products if not x["ids"] & emergency_ids]
    crests = rising_crests(snapshot)
    title, desc = event_branding()

    write_atomic(os.path.join(ROOT, "feed.xml"),
                 build_rss(emergencies, tornadoes, crests, notices[:20], built, title, desc,
                           unreachable, tornado_unreachable, products, products_unreachable))
    write_atomic(os.path.join(ROOT, "crests.ics"), build_ics(crests, built))
    state = f"{len(emergencies)} emergencies" if unreachable is None else f"emergency check UNREACHABLE ({unreachable})"
    tstate = f"{len(tornadoes)} tornado" if tornado_unreachable is None else f"tornado check UNREACHABLE ({tornado_unreachable})"
    pstate = (f"{len(products)} flood products" if products_unreachable is None
              else f"flood product check UNREACHABLE ({products_unreachable})")
    print(f"feed.xml + crests.ics: {state}, {tstate}, {pstate}, {len(crests)} crests, {len(notices)} notices")


if __name__ == "__main__":
    main()
