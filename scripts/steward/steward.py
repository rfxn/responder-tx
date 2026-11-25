#!/usr/bin/env python3
"""steward.py <command>: zero-LLM helpers for scripts/steward.sh (see scripts/README.md "Steward")."""
import argparse
import calendar
import datetime as dt
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from html.parser import HTMLParser

UA = "responder-tx-ops/steward"
FETCH_TIMEOUT_S = 25
FETCH_MAX_BYTES = 6 * 1024 * 1024
SOURCE_MAX_CHARS = 12000
H = 3600
DAY = 24 * H

WPC = "NWS Weather Prediction Center"
SPC = "NWS Storm Prediction Center"
SOURCES = [
    {"id": "wpc-ero", "name": WPC, "title": "Excessive Rainfall Outlook discussion, days 1 to 3",
     "url": "https://www.wpc.ncep.noaa.gov/discussions/hpcdiscussions.php?disc=qpferd", "max_age": 30 * H, "horizon": 78 * H},
    {"id": "wpc-short", "name": WPC, "title": "Short Range Forecast Discussion (rain totals, days 1 to 3)",
     "url": "https://www.wpc.ncep.noaa.gov/discussions/hpcdiscussions.php?disc=pmdspd", "max_age": 30 * H, "horizon": 54 * H},
    {"id": "wpc-extended", "name": WPC, "title": "Extended Forecast Discussion, days 3 to 7",
     "url": "https://www.wpc.ncep.noaa.gov/discussions/hpcdiscussions.php?disc=pmdepd", "max_age": 30 * H, "horizon": 168 * H},
    {"id": "spc-d1", "name": SPC, "title": "Day 1 Convective Outlook",
     "url": "https://www.spc.noaa.gov/products/outlook/day1otlk.html", "max_age": 30 * H, "horizon": 30 * H},
    {"id": "spc-d2", "name": SPC, "title": "Day 2 Convective Outlook",
     "url": "https://www.spc.noaa.gov/products/outlook/day2otlk.html", "max_age": 30 * H, "horizon": 54 * H},
    {"id": "spc-d3", "name": SPC, "title": "Day 3 Convective Outlook",
     "url": "https://www.spc.noaa.gov/products/outlook/day3otlk.html", "max_age": 36 * H, "horizon": 78 * H},
    {"id": "spc-d48", "name": SPC, "title": "Day 4 to 8 Convective Outlook",
     "url": "https://www.spc.noaa.gov/products/exper/day4-8/", "max_age": 36 * H, "horizon": 198 * H},
    {"id": "spc-fire-d1", "name": SPC, "title": "Day 1 Fire Weather Outlook",
     "url": "https://www.spc.noaa.gov/products/fire_wx/fwdy1.html", "max_age": 30 * H, "horizon": 30 * H},
    {"id": "spc-fire-d2", "name": SPC, "title": "Day 2 Fire Weather Outlook",
     "url": "https://www.spc.noaa.gov/products/fire_wx/fwdy2.html", "max_age": 30 * H, "horizon": 54 * H},
    {"id": "cpc-6-14", "name": "NWS Climate Prediction Center", "title": "6 to 10 and 8 to 14 day outlook discussion",
     "url": "https://www.cpc.ncep.noaa.gov/products/predictions/610day/fxus06.html", "max_age": 72 * H, "horizon": 15 * DAY},
    {"id": "nhc-atlantic", "name": "NWS National Hurricane Center", "title": "Atlantic Tropical Weather Outlook",
     "url": "https://www.nhc.noaa.gov/text/MIATWOAT.shtml", "max_age": 30 * H, "horizon": 7 * DAY, "season": ((6, 1), (11, 30))},
    {"id": "nhc-epac", "name": "NWS National Hurricane Center", "title": "Eastern Pacific Tropical Weather Outlook",
     "url": "https://www.nhc.noaa.gov/text/MIATWOEP.shtml", "max_age": 30 * H, "horizon": 7 * DAY, "season": ((5, 15), (11, 30))},
    {"id": "tfs-fire", "name": "Texas A&M Forest Service", "title": "Texas Fire Potential Update",
     "url": "https://ticc.tamu.edu/Documents/PredictiveServices/Outlooks/texas_fire_potential_update.pdf",
     "fmt": "pdf", "issued_from": "last-modified", "max_age": 8 * DAY, "horizon": 8 * DAY},
    {"id": "usdm-tx", "name": "U.S. Drought Monitor", "title": "Texas drought map and statistics",
     "url": "https://droughtmonitor.unl.edu/CurrentMap/StateDroughtMonitor.aspx?TX",
     "fmt": "usdm", "issued_from": "usdm", "max_age": 10 * DAY, "horizon": 10 * DAY},
]
USDM_STATS = ("https://usdmdataservices.unl.edu/api/StateStatistics/GetDroughtSeverityStatisticsByAreaPercent"
              "?aoi=48&startdate={start}&enddate={end}&statisticsType=1")

REQUIRED_SOURCE = "wpc-ero"  # a flood board without its flood outlook does not refresh (E1)
HAZARDS = {  # kind -> (products that may back a "none", products whose ok fetch an absence claim needs, words)
    "rain": ({"wpc-ero", "wpc-short", "wpc-extended"}, {"wpc-ero"}, r"flood|rain|inundaci|lluvia"),
    "severe": ({"spc-d1", "spc-d2", "spc-d3", "spc-d48"}, {"spc-d1"}, r"severe|storm|tornado|hail|tormenta|granizo"),
    "tropical": ({"nhc-atlantic", "nhc-epac"}, {"nhc-atlantic"}, r"tropical|hurricane|cyclone|hurac|cicl"),
    "fire": ({"tfs-fire", "spc-fire-d1", "spc-fire-d2"}, {"tfs-fire", "spc-fire-d1"}, r"fire|incendi|fuego"),
    "drought": ({"usdm-tx"}, {"usdm-tx"}, r"drought|sequ"),
}
HAZARD_NAMES = {"rain": "rain or flooding", "severe": "severe storms", "tropical": "tropical storms",
                "fire": "fire danger", "drought": "drought"}
NEGATION_RE = re.compile(r"\b(no|not|none|without|unlikely|nothing|ning[uú]n[ao]?|sin|nada)\b")
LINK_RE = re.compile(r"https?://|www\.|\b[a-z0-9-]+\.(com|org|net|gov|edu|io|example)\b", re.I)
KINDS = {"rain", "severe", "tropical", "fire", "drought", "winter", "temperature", "other"}
LEVELS = {"none", "low", "elevated", "high"}
TOP_KEYS = {"generated", "validUntil", "author", "headline", "items"}
ITEM_KEYS = {"id", "kind", "level", "title", "body", "window", "source", "issued"}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,47}$")
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$")
HORIZON_SLACK_S = 6 * H  # an issuance a few hours before its valid period, or a window rounded to a calendar day
BY_ID = {src["id"]: src for src in SOURCES}
MAX_STR = 280
MAX_ITEMS = 6
ISSUED_SKEW_S = 120
NOMINAL_AHEAD_S = 2 * H  # NHC and others label a product with its nominal time and post it early

TZ_OFFSETS = {"UTC": 0, "GMT": 0, "EST": -5, "EDT": -4, "CST": -6, "CDT": -5, "MST": -7, "MDT": -6,
              "PST": -8, "PDT": -7, "AKST": -9, "AKDT": -8, "HST": -10}
NWS_TIME_RE = re.compile(
    r"\b(\d{3,4})\s+(AM|PM)\s+(" + "|".join(TZ_OFFSETS) + r")\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+"
    r"([A-Za-z]{3,9})\.?\s+(\d{1,2})\s+(\d{4})\b")
USDM_VALID_RE = re.compile(r"Data valid:\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*([A-Z]{3})")
USDM_RELEASED_RE = re.compile(r"Map released:\s*([^\n]+?\d{4})")
MONTHS = {m.lower(): i for i, m in enumerate(
    ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
     "November", "December"]) if m}


def now_epoch():
    return int(os.environ.get("RESPONDER_STEWARD_NOW") or time.time())


def iso(epoch):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def parse_iso(value):
    if not isinstance(value, str) or not ISO_RE.match(value):
        return None
    try:
        return int(dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def month_num(name):
    name = name.lower().rstrip(".")
    for full, num in MONTHS.items():
        if full.startswith(name) and len(name) >= 3:
            return num
    return None


def wall_to_epoch(year, month, day, hour, minute, tz):
    if tz not in TZ_OFFSETS or not month:
        return None
    try:
        base = calendar.timegm((year, month, day, hour, minute, 0))
    except (ValueError, OverflowError):
        return None
    return base - TZ_OFFSETS[tz] * H


def nws_issued(text):
    """First NWS header issue time ("1034 AM CST Mon Nov 23 2026") as epoch, else None."""
    m = NWS_TIME_RE.search(text)
    if not m:
        return None
    hhmm, ampm, tz, mon, day, year = m.groups()
    hour, minute = int(hhmm[:-2]), int(hhmm[-2:])
    if hour > 12 or minute > 59:
        return None
    hour = hour % 12 + (12 if ampm == "PM" else 0)
    return wall_to_epoch(int(year), month_num(mon), int(day), hour, minute, tz)


def usdm_issued(text):
    m = USDM_VALID_RE.search(text)
    if not m:
        return None
    mon, day, year, hour, minute, ap, tz = m.groups()
    hour = int(hour) % 12 + (12 if ap == "p" else 0)
    return wall_to_epoch(int(year), month_num(mon), int(day), hour, int(minute or 0), tz)


class _Text(HTMLParser):
    BLOCK = {"br", "p", "div", "tr", "li", "h1", "h2", "h3", "h4", "td", "table"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.pre, self.text, self.in_pre, self.skip = [], [], 0, 0

    def handle_starttag(self, tag, attrs):
        if tag == "pre":
            self.in_pre += 1
            self.pre.append("")
        elif tag in ("script", "style", "noscript"):
            self.skip += 1
        elif tag in self.BLOCK:
            self.text.append("\n")

    def handle_endtag(self, tag):
        if tag == "pre" and self.in_pre:
            self.in_pre -= 1
        elif tag in ("script", "style", "noscript") and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if self.skip:
            return
        if self.in_pre:
            self.pre[-1] += data
        self.text.append(data)


def html_text(raw):
    """Text of the <pre> product blocks when present, else the page's visible text."""
    parser = _Text()
    parser.feed(raw)
    pre = "\n\n".join(p.strip() for p in parser.pre if len(p.strip()) > 200)
    text = pre or "".join(parser.text)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    return re.sub(r"\n\s*\n+", "\n\n", text).strip()


def clean_upstream(text):
    """Drop lines that could pose as the bundle's own frame markers; cap the size."""
    lines = [ln for ln in text.splitlines() if not ln.lstrip().startswith(("===", "<<<", ">>>"))]
    return "\n".join(lines)[:SOURCE_MAX_CHARS]


def http_get(url, fixture_dir, key, accept="*/*"):
    """-> (bytes, headers dict). The fixture dir is the test seam: <key> and optional <key>.headers."""
    if fixture_dir:
        path = os.path.join(fixture_dir, key)
        with open(path, "rb") as f:
            body = f.read()
        headers = {}
        try:
            with open(path + ".headers", encoding="utf-8") as f:
                for line in f:
                    if ":" in line:
                        k, v = line.split(":", 1)
                        headers[k.strip().lower()] = v.strip()
        except OSError:
            pass
        return body, headers
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp:
        body = resp.read(FETCH_MAX_BYTES + 1)
        if len(body) > FETCH_MAX_BYTES:
            raise ValueError("response larger than %d bytes" % FETCH_MAX_BYTES)
        return body, {k.lower(): v for k, v in resp.headers.items()}


def pdf_text(body):
    with tempfile.NamedTemporaryFile(suffix=".pdf") as tmp:
        tmp.write(body)
        tmp.flush()
        out = subprocess.run(["pdftotext", "-layout", tmp.name, "-"], capture_output=True, timeout=60, check=True)
    lines = []
    for ln in out.stdout.decode("utf-8", "replace").splitlines():
        ln = re.sub(r"\s+", " ", ln).strip()
        if ln and not re.fullmatch(r"[\d\s.%|]+", ln):
            lines.append(ln)
    return "\n".join(lines)


def usdm_text(raw, now, fixture_dir):
    page = html_text(raw)
    keep = []
    for rx in (USDM_RELEASED_RE, re.compile(r"Data valid:[^\n]+")):
        m = rx.search(page)
        if m:
            keep.append(m.group(0).strip())
    end = time.gmtime(now)
    start = time.gmtime(now - 21 * DAY)
    url = USDM_STATS.format(start="%d/%d/%d" % (start.tm_mon, start.tm_mday, start.tm_year),
                            end="%d/%d/%d" % (end.tm_mon, end.tm_mday, end.tm_year))
    body, _ = http_get(url, fixture_dir, "usdm-tx.stats", accept="application/json")
    rows = json.loads(body.decode("utf-8"))
    for row in sorted(rows, key=lambda r: r.get("mapDate", ""), reverse=True)[:2]:
        keep.append("Texas percent of area, map dated %s: none %s, D0-D4 %s, D1-D4 %s, D2-D4 %s, D3-D4 %s, D4 %s" % (
            row.get("mapDate", "?")[:10], row.get("none"), row.get("d0"), row.get("d1"), row.get("d2"),
            row.get("d3"), row.get("d4")))
    return "\n".join(keep)


def in_season(src, now):
    season = src.get("season")
    if not season:
        return True
    t = time.gmtime(now)
    return season[0] <= (t.tm_mon, t.tm_mday) <= season[1]


def fetch_one(src, now, fixture_dir):
    """-> (manifest row, text or None). Failure and staleness are reported, never turned into a value."""
    row = {k: src[k] for k in ("id", "name", "title", "url")}
    row.update(status="failed", issued=None, reason="", chars=0)
    if not in_season(src, now):
        row.update(status="off-season", reason="outside the product's season")
        return row, None
    try:
        body, headers = http_get(src["url"], fixture_dir, src["id"])
        fmt = src.get("fmt", "html")
        if fmt == "pdf":
            text = pdf_text(body)
        elif fmt == "usdm":
            text = usdm_text(body.decode("utf-8", "replace"), now, fixture_dir)
        else:
            text = html_text(body.decode("utf-8", "replace"))
    except Exception as exc:  # any fetch or parse fault is a failed source, recorded with its reason
        row["reason"] = ("%s: %s" % (type(exc).__name__, exc))[:200]
        return row, None
    how = src.get("issued_from", "nws")
    if how == "last-modified":
        try:
            issued = calendar.timegm(time.strptime(headers.get("last-modified", ""), "%a, %d %b %Y %H:%M:%S GMT"))
        except ValueError:
            issued = None
    elif how == "usdm":
        issued = usdm_issued(text)
    else:
        issued = nws_issued(text)
    if not text.strip():
        row["reason"] = "no product text found"
        return row, None
    if issued is None:
        row["reason"] = "no upstream issue time found"
        return row, None
    row["issued"] = iso(issued)
    age = now - issued
    if age > src["max_age"]:
        row.update(status="stale", reason="issued %dh ago (limit %dh)" % (age // H, src["max_age"] // H))
        return row, None
    if age < -NOMINAL_AHEAD_S:
        row.update(status="failed", reason="issue time is in the future")
        return row, None
    text = clean_upstream(text)
    row.update(status="ok", chars=len(text))
    return row, text


def cmd_fetch(args):
    now = now_epoch()
    fixture_dir = os.environ.get("RESPONDER_STEWARD_FETCH_DIR") or None
    os.makedirs(args.out, exist_ok=True)
    rows, parts = [], []
    for i, src in enumerate(SOURCES):
        if i and not fixture_dir:
            time.sleep(1)  # one request a second; these are shared public servers
        row, text = fetch_one(src, now, fixture_dir)
        rows.append(row)
        if text:
            parts.append("=== SOURCE %s | %s | %s\n=== url: %s\n=== issued: %s\n%s\n=== END SOURCE %s" % (
                row["id"], row["name"], row["title"], row["url"], row["issued"], text, row["id"]))
    manifest = {"fetchedAt": iso(now), "sources": rows}
    atomic_write(os.path.join(args.out, "manifest.json"), json.dumps(manifest, indent=2) + "\n")
    atomic_write(os.path.join(args.out, "bundle.txt"), "\n\n".join(parts) + "\n")
    atomic_write(os.path.join(args.out, "sources.txt"), "".join(
        "- %s | name: %s | url: %s | issued: %s | %s%s\n" % (
            r["id"], r["name"], r["url"], r["issued"] or "unknown", r["status"],
            " (" + r["reason"] + ")" if r["reason"] else "") for r in rows))
    ok = sum(1 for r in rows if r["status"] == "ok")
    required_ok = any(r["id"] == REQUIRED_SOURCE and r["status"] == "ok" for r in rows)
    print("%s%d/%d sources ok; %s" % (
        "" if required_ok else "%s not ok, no flood outlook to stand on; " % REQUIRED_SOURCE, ok, len(rows), "; ".join(
        "%s %s%s" % (r["id"], r["status"], " (" + r["reason"] + ")" if r["reason"] else "") for r in rows
        if r["status"] != "ok") or "none failed"))
    return 0 if ok and required_ok else 4


def cmd_render(args):
    with open(args.template, encoding="utf-8") as f:
        template = f.read()
    values = {}
    for pair in args.vars:
        key, _, value = pair.partition("=")
        if value.startswith("@"):
            with open(value[1:], encoding="utf-8") as f:
                value = f.read()
        values[key] = value
    missing = sorted(set(re.findall(r"\{\{([A-Z_]+)\}\}", template)) - set(values))
    if missing:
        sys.stderr.write("render: no value for %s\n" % ", ".join(missing))
        return 2
    sys.stdout.write(re.sub(r"\{\{([A-Z_]+)\}\}", lambda m: values[m.group(1)], template))
    return 0


def extract_json_object(text):
    if not isinstance(text, str):
        return None
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        obj = json.loads(text[start:end + 1])
    except ValueError:
        return None
    return obj if isinstance(obj, dict) else None


def cmd_finalize(args):
    try:
        with open(args.result, encoding="utf-8") as f:
            result = json.load(f)
    except (OSError, ValueError) as exc:
        print("INVALID: claude output is not JSON (%s)" % exc)
        return 1
    if not isinstance(result, dict) or result.get("is_error") or result.get("subtype") != "success":
        print("INVALID: claude run did not succeed (subtype=%s)" % (result.get("subtype") if isinstance(result, dict) else "?"))
        return 1
    obj = extract_json_object(result.get("result"))
    if obj is None:
        print("INVALID: the reply held no JSON object")
        return 1
    now = now_epoch()
    until = now + int(args.ttl_s)
    for item in obj.get("items") if isinstance(obj.get("items"), list) else []:
        end = parse_iso((item.get("window") or {}).get("end")) if isinstance(item, dict) and isinstance(item.get("window"), dict) else None
        if isinstance(item, dict) and item.get("level") == "none" and end is not None:
            until = min(until, end)  # a "no risk" item must not outlive the window its product covers
    obj["generated"] = iso(now)
    obj["validUntil"] = iso(until)
    obj["author"] = "steward"
    ordered = {k: obj[k] for k in ("generated", "validUntil", "author", "headline", "items") if k in obj}
    ordered.update({k: v for k, v in obj.items() if k not in ordered})
    atomic_write(args.out, json.dumps(ordered, ensure_ascii=False, indent=2) + "\n")
    print("OK")
    return 0


def check_str(value, where, errors):
    if not isinstance(value, str) or not value.strip():
        errors.append("%s: missing or empty" % where)
        return
    if len(value) > MAX_STR:
        errors.append("%s: %d chars (max %d)" % (where, len(value), MAX_STR))
    if "—" in value:
        errors.append("%s: contains an em-dash" % where)
    if "<" in value or ">" in value:
        errors.append("%s: contains markup characters" % where)
    if re.search(r"[\x00-\x08\x0b-\x1f\x7f]", value):
        errors.append("%s: contains control characters" % where)
    if LINK_RE.search(value):
        errors.append("%s: contains a link" % where)


def check_absence(value, where, ok_ids, errors):
    """A string that denies a hazard needs that hazard's product fetched ok this run (E1)."""
    if not isinstance(value, str) or not NEGATION_RE.search(value.lower()):
        return
    for kind, (_, needs, words) in HAZARDS.items():
        if re.search(words, value.lower()) and not needs & ok_ids:
            errors.append("%s: claims no %s but %s was not fetched ok" % (where, HAZARD_NAMES[kind], "/".join(sorted(needs))))


def check_i18n(value, where, errors):
    if not isinstance(value, dict) or set(value) != {"en", "es"}:
        errors.append("%s: must be {en, es}" % where)
        return
    for lang in ("en", "es"):
        check_str(value[lang], "%s.%s" % (where, lang), errors)


def validate(doc, manifest, now):
    errors = []
    if not isinstance(doc, dict):
        return ["top level is not an object"]
    extra = set(doc) - TOP_KEYS
    if extra:
        errors.append("unknown top-level keys: %s" % ", ".join(sorted(extra)))
    gen, until = parse_iso(doc.get("generated")), parse_iso(doc.get("validUntil"))
    if gen is None:
        errors.append("generated: not an ISO time")
    if until is None:
        errors.append("validUntil: not an ISO time")
    if gen is not None and until is not None and not gen < until <= gen + 2 * DAY:
        errors.append("validUntil must be after generated and within 48h of it")
    if gen is not None and gen > now + ISSUED_SKEW_S:
        errors.append("generated is in the future")
    if doc.get("author") != "steward":
        errors.append("author must be steward")
    check_i18n(doc.get("headline"), "headline", errors)
    items = doc.get("items")
    if not isinstance(items, list) or len(items) > MAX_ITEMS:
        errors.append("items must be a list of 0..%d" % MAX_ITEMS)
        items = []
    by_url = {}
    if manifest is not None:
        by_url = {s["url"]: s for s in manifest.get("sources", []) if s.get("status") == "ok"}
        ok_ids = {s["id"] for s in by_url.values()}
        texts = [("headline." + lang, (doc.get("headline") or {}).get(lang)) for lang in ("en", "es")
                 if isinstance(doc.get("headline"), dict)]
        for n, item in enumerate(items if isinstance(items, list) else []):
            for field in ("title", "body"):
                if isinstance(item, dict) and isinstance(item.get(field), dict):
                    texts += [("items[%d].%s.%s" % (n, field, lang), item[field].get(lang)) for lang in ("en", "es")]
        for where, value in texts:
            check_absence(value, where, ok_ids, errors)
    seen = set()
    for n, item in enumerate(items):
        where = "items[%d]" % n
        if not isinstance(item, dict):
            errors.append("%s: not an object" % where)
            continue
        if set(item) != ITEM_KEYS:
            errors.append("%s: keys must be exactly %s" % (where, ", ".join(sorted(ITEM_KEYS))))
        iid = item.get("id")
        if not isinstance(iid, str) or not ID_RE.match(iid):
            errors.append("%s.id: must match %s" % (where, ID_RE.pattern))
        elif iid in seen:
            errors.append("%s.id: duplicate %s" % (where, iid))
        else:
            seen.add(iid)
        if item.get("kind") not in KINDS:
            errors.append("%s.kind: not one of %s" % (where, "|".join(sorted(KINDS))))
        if item.get("level") not in LEVELS:
            errors.append("%s.level: not one of %s" % (where, "|".join(sorted(LEVELS))))
        check_i18n(item.get("title"), where + ".title", errors)
        check_i18n(item.get("body"), where + ".body", errors)
        win = item.get("window")
        start = parse_iso(win.get("start")) if isinstance(win, dict) else None
        end = parse_iso(win.get("end")) if isinstance(win, dict) else None
        if start is None or end is None:
            errors.append("%s.window: needs ISO start and end" % where)
        elif not start <= end <= start + 16 * DAY:
            errors.append("%s.window: end must follow start within 16 days" % where)
        elif gen is not None and end <= gen:
            errors.append("%s.window: already over at generation time" % where)
        elif item.get("level") == "none" and until is not None and until > end + 60:
            errors.append('validUntil: after the earliest "none" window end (%s)' % win.get("end"))
        src = item.get("source")
        if not isinstance(src, dict) or set(src) != {"name", "url"}:
            errors.append("%s.source: must be {name, url}" % where)
            src = {}
        check_str(src.get("name"), where + ".source.name", errors)
        url = src.get("url")
        if not isinstance(url, str) or not url.startswith("https://"):
            errors.append("%s.source.url: must be an https URL" % where)
        issued = parse_iso(item.get("issued"))
        if issued is None:
            errors.append("%s.issued: not an ISO time" % where)
        elif gen is not None and issued > gen + NOMINAL_AHEAD_S:
            errors.append("%s.issued: after generation time" % where)
        if manifest is not None and isinstance(url, str):
            row = by_url.get(url)
            if row is None:
                errors.append("%s.source.url: not a source fetched ok this run (%s)" % (where, url[:120]))
            else:
                family = HAZARDS.get(item.get("kind"), (None,))[0]
                if item.get("level") == "none" and family and row["id"] not in family:
                    errors.append('%s: a %s "none" must cite %s' % (where, item.get("kind"), "/".join(sorted(family))))
                horizon = BY_ID.get(row["id"], {}).get("horizon")
                row_issued = parse_iso(row["issued"])
                if row_issued is not None and gen is not None:
                    row_issued = min(row_issued, gen)  # an early-posted nominal label counts from now, never later
                if horizon and end is not None and row_issued is not None and end > row_issued + horizon + HORIZON_SLACK_S:
                    errors.append("%s.window: ends %dh after issue, past %s's %dh horizon" % (
                        where, (end - row_issued) // H, row["id"], horizon // H))
                if src.get("name") != row["name"]:
                    errors.append("%s.source.name: %r does not match %r" % (where, src.get("name"), row["name"]))
                if issued is None or abs(issued - parse_iso(row["issued"])) > 60:
                    errors.append("%s.issued: %s does not match the fetched issue time %s" % (
                        where, item.get("issued"), row["issued"]))
    return errors


def cmd_check(args):
    try:
        with open(args.file, encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError) as exc:
        print("INVALID: unreadable (%s)" % exc)
        return 1
    manifest = None
    if args.manifest:
        with open(args.manifest, encoding="utf-8") as f:
            manifest = json.load(f)
    errors = validate(doc, manifest, now_epoch())
    if errors:
        print("INVALID: " + "; ".join(errors[:12]) + ("; ..." if len(errors) > 12 else ""))
        return 1
    print("OK %d items" % len(doc.get("items", [])))
    return 0


def read_json(path):
    """-> (obj, status). status: ok | missing | invalid."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f), "ok"
    except FileNotFoundError:
        return None, "missing"
    except (OSError, ValueError):
        return None, "invalid"


def cmd_pace(args):
    """Prints: VERDICT<TAB>mode<TAB>hash<TAB>reasons<TAB>why, VERDICT being RUN or IDLE."""
    now = now_epoch()
    cadence, cstat = read_json(args.cadence)
    mode = cadence.get("mode") if cstat == "ok" and isinstance(cadence, dict) else None
    notes = []
    if mode not in ("quiet", "adverse"):
        notes.append("cadence state %s, quiet pacing" % (cstat if cstat != "ok" else "has no mode"))
        mode = "quiet"
    ahash = cadence.get("alertSetHash", "") if cstat == "ok" and isinstance(cadence, dict) else ""
    ahash = ahash if isinstance(ahash, str) and re.fullmatch(r"[0-9a-f]{0,64}", ahash) else ""
    reasons = cadence.get("reasons") if cstat == "ok" and isinstance(cadence, dict) else None
    reasons = [re.sub(r"[^\w ().,:/-]", "", r)[:80] for r in reasons if isinstance(r, str)] if isinstance(reasons, list) else []
    outlook, ostat = read_json(args.outlook)
    gen = parse_iso(outlook.get("generated")) if ostat == "ok" and isinstance(outlook, dict) else None
    until = parse_iso(outlook.get("validUntil")) if ostat == "ok" and isinstance(outlook, dict) else None
    state, _ = read_json(args.state)
    st = (state or {}).get("collateral", {}) if isinstance(state, dict) else {}
    last_attempt = int(st.get("lastAttemptAt") or 0)
    last_ok = bool(st.get("lastOk"))
    since_attempt = now - last_attempt
    note = ("; " + "; ".join(notes)) if notes else ""

    def out(verdict, why):
        print("%s\t%s\t%s\t%s\t%s%s" % (verdict, mode, ahash or "-", "; ".join(reasons[:8]) or "none", why, note))
        return 0

    if gen is None:
        state_why = "outlook %s" % (ostat if ostat != "ok" else "has no generated time")
    else:
        state_why = "outlook %dh%02dm old" % ((now - gen) // H, (now - gen) % H // 60)
    expired = until is None or now >= until
    if mode == "adverse":
        if st.get("lastMode") != "adverse":
            return out("RUN", "quiet->adverse transition; " + state_why)
        if since_attempt < args.adverse_gap_s:
            return out("IDLE", "adverse: last run %dm ago (< %dm)" % (since_attempt // 60, args.adverse_gap_s // 60))
        if ahash and ahash != st.get("lastOkHash"):
            return out("RUN", "adverse: alert set changed; " + state_why)
        if expired:
            return out("RUN", "adverse: outlook past validUntil; " + state_why)
        return out("IDLE", "adverse: alert set unchanged and outlook valid; " + state_why)
    hour = time.localtime(now).tm_hour
    if args.quiet_start <= hour < args.quiet_end:
        return out("IDLE", "quiet: local hour %02d inside %02d:00-%02d:59" % (hour, args.quiet_start, args.quiet_end - 1))
    if gen is not None and now - gen < args.quiet_age_s and not expired:
        return out("IDLE", "quiet: %s (< %dh%02dm)" % (state_why, args.quiet_age_s // H, args.quiet_age_s % H // 60))
    if last_attempt and not last_ok and since_attempt < args.retry_s:
        return out("IDLE", "quiet: last run failed %dm ago, retry after %dm" % (since_attempt // 60, args.retry_s // 60))
    return out("RUN", "quiet: " + state_why + ("; outlook past validUntil" if gen is not None and expired else ""))


def atomic_write(path, text):
    d = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".steward.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def cmd_state_set(args):
    state, stat = read_json(args.state)
    if stat == "invalid" or not isinstance(state, dict):
        state = {}
    section = state.setdefault(args.section, {})
    for pair in args.pairs:
        key, _, value = pair.partition("=")
        if re.fullmatch(r"-?\d+", value):
            section[key] = int(value)
        elif value in ("true", "false"):
            section[key] = value == "true"
        else:
            section[key] = value
    atomic_write(args.state, json.dumps(state, indent=2, sort_keys=True) + "\n")
    return 0


def cmd_state_get(args):
    state, _ = read_json(args.state)
    value = (state or {}).get(args.section, {}).get(args.key, "") if isinstance(state, dict) else ""
    print(value if not isinstance(value, bool) else str(value).lower())
    return 0


def append_line(path, entry):
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, sort_keys=True) + "\n")
        f.flush()
        os.fsync(f.fileno())


def cmd_ledger_reserve(args):
    """Charge the run's full cap before it starts; its settle line replaces this one."""
    append_line(args.ledger, {"ts": iso(now_epoch()), "kind": "reserve", "run_id": args.run_id, "task": args.task,
                              "model": args.model, "cost_usd": float(args.budget), "cost_known": False})
    return 0


def ledger_entries(path):
    """-> (entries, None) or (None, reason). An unparseable line makes the whole ledger untrustworthy."""
    entries = []
    with open(path, encoding="utf-8") as handle:
        for n, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
                entry["_ts"] = parse_iso(entry["ts"])
                entry["cost_usd"] = float(entry["cost_usd"])
            except (ValueError, KeyError, TypeError):
                return None, "ledger line %d unparseable" % n
            entries.append(entry)
    return entries, None


def charged(entries):
    """Entries that carry spend: settles and plain runs, plus reservations nothing settled (killed runs)."""
    settled = {e.get("run_id") for e in entries if e.get("kind") == "settle"}
    return [e for e in entries if e.get("kind") != "reserve" or e.get("run_id") not in settled]


def cmd_ledger_append(args):
    result, _ = read_json(args.result) if args.result else (None, "missing")
    result = result if isinstance(result, dict) else {}
    usage = result.get("usage") or {}
    cost = result.get("total_cost_usd")
    known = isinstance(cost, (int, float))
    entry = {
        "ts": iso(now_epoch()), "task": args.task, "model": args.model, "rc": args.rc,
        "outcome": args.outcome, "cost_usd": round(float(cost), 6) if known else float(args.budget),
        "cost_known": known, "subtype": result.get("subtype"), "num_turns": result.get("num_turns"),
        "duration_ms": result.get("duration_ms"), "input_tokens": usage.get("input_tokens", 0),
        "output_tokens": usage.get("output_tokens", 0),
        "cache_read_tokens": usage.get("cache_read_input_tokens", 0),
        "cache_creation_tokens": usage.get("cache_creation_input_tokens", 0),
        "models": sorted((result.get("modelUsage") or {}).keys()), "session_id": result.get("session_id"),
        "detail": args.detail[:300], "kind": "settle" if args.run_id else "run",
    }
    if args.run_id:
        entry["run_id"] = args.run_id
    append_line(args.ledger, entry)
    print("%.4f%s" % (entry["cost_usd"], "" if known else " (unknown; budget charged)"))
    return 0


def cmd_ledger_spent(args):
    """Prints the steward's USD in the last 24 h (WATCHDOG runs are recorded, never capped). Exit 3 if untrusted."""
    cutoff = now_epoch() - DAY
    try:
        entries, why = ledger_entries(args.ledger)
    except FileNotFoundError:
        print("0.0000")
        return 0
    except OSError as exc:
        why = "ledger unreadable: %s" % exc
        entries = None
    if entries is None:
        sys.stderr.write(why + "\n")
        return 3
    total = sum(e["cost_usd"] for e in charged(entries)
                if e["_ts"] is not None and e["_ts"] >= cutoff and e.get("task") != "WATCHDOG")
    print("%.4f" % total)
    return 0


def cmd_outbox_append(args):
    text = args.text.strip()[:4000]
    if not text:
        return 3
    msg = {"ts": iso(int(time.time())), "role": args.role, "text": text}
    for _ in range(6):
        try:
            with open(args.outbox, "rb") as f:
                before = f.read()
        except OSError:
            before = None
        try:
            data = json.loads(before.decode("utf-8")) if before else {"messages": []}
        except ValueError:
            data = {"messages": []}
        if not isinstance(data, dict) or not isinstance(data.get("messages"), list):
            data = {"messages": []}
        data["messages"].append(msg)
        d = os.path.dirname(os.path.abspath(args.outbox))
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".chat-outbox.", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        try:
            with open(args.outbox, "rb") as f:
                now_bytes = f.read()
        except OSError:
            now_bytes = None
        if now_bytes != before:
            os.unlink(tmp)
            continue
        os.replace(tmp, args.outbox)
        return 0
    return 4


def cmd_outbox_count(args):
    data, stat = read_json(args.outbox)
    msgs = data.get("messages") if stat == "ok" and isinstance(data, dict) else None
    print(len(msgs) if isinstance(msgs, list) else 0)
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("fetch")
    p.add_argument("--out", required=True)
    p = sub.add_parser("render")
    p.add_argument("template")
    p.add_argument("vars", nargs="*")
    p = sub.add_parser("finalize")
    p.add_argument("--result", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--ttl-s", required=True, type=int)
    p = sub.add_parser("check")
    p.add_argument("file")
    p.add_argument("--manifest")
    p = sub.add_parser("pace")
    p.add_argument("--cadence", required=True)
    p.add_argument("--outlook", required=True)
    p.add_argument("--state", required=True)
    p.add_argument("--quiet-age-s", type=int, default=11 * H + 50 * 60)
    p.add_argument("--adverse-gap-s", type=int, default=58 * 60)
    p.add_argument("--retry-s", type=int, default=2 * H)
    p.add_argument("--quiet-start", type=int, default=1)
    p.add_argument("--quiet-end", type=int, default=9)
    p = sub.add_parser("state-set")
    p.add_argument("--state", required=True)
    p.add_argument("section")
    p.add_argument("pairs", nargs="+")
    p = sub.add_parser("state-get")
    p.add_argument("--state", required=True)
    p.add_argument("section")
    p.add_argument("key")
    p = sub.add_parser("ledger-append")
    p.add_argument("--ledger", required=True)
    p.add_argument("--task", required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--rc", type=int, required=True)
    p.add_argument("--outcome", required=True)
    p.add_argument("--budget", required=True)
    p.add_argument("--result")
    p.add_argument("--detail", default="")
    p.add_argument("--run-id", default="")
    p = sub.add_parser("ledger-reserve")
    p.add_argument("--ledger", required=True)
    p.add_argument("--task", required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--budget", required=True)
    p.add_argument("--run-id", required=True)
    p = sub.add_parser("ledger-spent")
    p.add_argument("--ledger", required=True)
    p = sub.add_parser("outbox-append")
    p.add_argument("--outbox", required=True)
    p.add_argument("--role", default="action")
    p.add_argument("text")
    p = sub.add_parser("outbox-count")
    p.add_argument("--outbox", required=True)
    args = ap.parse_args()
    handler = {"fetch": cmd_fetch, "render": cmd_render, "finalize": cmd_finalize, "check": cmd_check,
               "pace": cmd_pace, "state-set": cmd_state_set, "state-get": cmd_state_get,
               "ledger-append": cmd_ledger_append, "ledger-spent": cmd_ledger_spent,
               "ledger-reserve": cmd_ledger_reserve,
               "outbox-append": cmd_outbox_append, "outbox-count": cmd_outbox_count}[args.cmd]
    return handler(args)


if __name__ == "__main__":
    sys.exit(main())
