#!/usr/bin/env python3
"""Generate feed.xml (RSS 2.0) + crests.ics from current board data.

Zero-backend public follow mechanism: run each release cycle before deploy.
Reads data/requests.json + data/gauges-snapshot.json + live NWS FF alerts;
writes feed.xml and crests.ics at the repo root (served on the public mirror).
Honest by construction: every item stamps its time; forecast crests use real
NWPS validTime; nothing is invented.
"""
import datetime
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
import xml.sax.saxutils as sx

ROOT = os.environ.get("RESPONDER_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://respondertx.org"
UA = "responder-tx-ops (rfxnryan@gmail.com)"
# healthy answers measure ~0.1s, so a short deadline plus retries beats one long wait on a hang
TIMEOUT = 12
BACKOFFS = [2, 5]


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc)


def rfc822(dt):
    return dt.strftime("%a, %d %b %Y %H:%M:%S +0000")


def ics_stamp(dt):
    return dt.strftime("%Y%m%dT%H%M%SZ")


EMERGENCY_UNKNOWN_TITLE = "Flash flood emergency check unavailable"
TORNADO_UNKNOWN_TITLE = "Tornado emergency check unavailable"
MAX_ITEMS = 40


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
    desc = (f"Flash flood emergencies, forecast river crests, and active notices for {area}. "
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
                return json.load(r).get("features", []), None
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


def rising_crests(snapshot):
    RANK = {"none": 0, "action": 1, "minor": 2, "moderate": 3, "major": 4}
    out = []
    for g in snapshot.get("gauges", []):
        st = g.get("status") or {}
        o = st.get("observed") or {}
        fc = st.get("forecast") or {}
        ocat = o.get("floodCategory") or "none"
        fcat = fc.get("floodCategory") or "none"
        crest = fc.get("primary")
        when = parse_iso(fc.get("validTime"))
        if not isinstance(crest, (int, float)) or crest <= -999:
            continue  # NWPS missing-value sentinel
        if not when or when.year < 2000:
            continue  # NWPS epoch/sentinel timestamp
        if fcat == "major" and RANK.get(fcat, 0) > RANK.get(ocat, 0):
            out.append({
                "lid": g.get("lid"), "name": g.get("name"),
                "obs": o.get("primary"), "ocat": ocat,
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
              unreachable=None, tornado_unreachable=None):
    # life-safety items and the two unknown notices are held apart from the volume cap below: the
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
        it_desc = f"Observed {c['obs']} ft ({c['ocat']}); forecast crest {c['crest']} ft MAJOR at {c['when']}. Source: NOAA NWPS."
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
    items = lead + items[:max(0, MAX_ITEMS - len(lead))]

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
        lines += ["BEGIN:VEVENT",
                  f"UID:crest-{c['lid']}-{ics_stamp(start)}@responder.rfxn.com",
                  f"DTSTAMP:{ics_stamp(built)}",
                  f"DTSTART:{ics_stamp(start)}",
                  f"DTEND:{ics_stamp(end)}",
                  f"SUMMARY:{ics_escape('MAJOR crest · ' + c['name'] + ' (' + str(c['crest']) + ' ft)')}",
                  f"DESCRIPTION:{ics_escape('Forecast MAJOR crest ' + str(c['crest']) + ' ft (observed ' + str(c['obs']) + ' ft). NOAA NWPS. Not a dispatch system; call 911 for emergencies.')}",
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
    crests = rising_crests(snapshot)
    title, desc = event_branding()

    write_atomic(os.path.join(ROOT, "feed.xml"),
                 build_rss(emergencies, tornadoes, crests, notices[:20], built, title, desc,
                           unreachable, tornado_unreachable))
    write_atomic(os.path.join(ROOT, "crests.ics"), build_ics(crests, built))
    state = f"{len(emergencies)} emergencies" if unreachable is None else f"emergency check UNREACHABLE ({unreachable})"
    tstate = f"{len(tornadoes)} tornado" if tornado_unreachable is None else f"tornado check UNREACHABLE ({tornado_unreachable})"
    print(f"feed.xml + crests.ics: {state}, {tstate}, {len(crests)} crests, {len(notices)} notices")


if __name__ == "__main__":
    main()
