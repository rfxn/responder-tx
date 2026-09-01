'use strict';

/* ---------- NWS alerts ---------- */

function alertSeverity(p) {
  const threat = (p.parameters && p.parameters.flashFloodDamageThreat || []).join(' ');
  if (/FLASH FLOOD EMERGENCY/i.test(p.description || '') || /CATASTROPHIC/i.test(threat)) return 'emergency';
  /* Four of the eight order products carry no "Warning" in their name, so the word test below would
     read an evacuation order as an advisory: the lowest tier the board has, and the one tier
     renderAlertPolys declines to resolve zone geometry for. A directive is never an advisory. */
  if (hazardIsOrder(p.event)) return 'warning';
  if (/Warning/i.test(p.event)) return 'warning';
  if (/Watch/i.test(p.event)) return 'watch';
  return 'advisory';
}

/* The one severity ladder. Read the rank through alertSevRank, never through indexOf() on a list:
   indexOf returns -1 for a value it does not know, and -1 sorts ABOVE emergency, so an unrecognised
   severity would outrank a flash flood emergency in the answer given to a resident. Unknown sorts last. */
const ALERT_SEV_RANK = { emergency: 0, warning: 1, watch: 2, advisory: 3 };
const ALERT_SEV_UNKNOWN = 9;
const alertSevRank = (sev) => (Object.prototype.hasOwnProperty.call(ALERT_SEV_RANK, sev) ? ALERT_SEV_RANK[sev] : ALERT_SEV_UNKNOWN);
const alertSevCmp = (a, b) => alertSevRank(a && a._sev) - alertSevRank(b && b._sev);

/* Who actually wrote the product. An order is authored by a county or a state agency and only
   relayed by NWS, so crediting the National Weather Service for a county judge's evacuation order
   states something false. senderName carries the author and arrives dirty: an IPAWS COG number is
   prefixed ("200033, Idaho State Communications Center, ..."), and the same name is often repeated
   two or three times ("Boone County WV,Boone County WV,Boone County WV"). Both shapes are verbatim
   in tests/fixtures/alerts-orders.json. Empty means the product did not say, which is a different
   fact from "NWS" and has to stay different all the way to the card. */
function alertAgency(f) {
  const raw = String(((f && f.properties) || {}).senderName || '').trim();
  const segs = [];
  for (const part of raw.split(',')) {
    const seg = part.trim();
    if (!seg || /^\d+$/.test(seg)) continue; // a bare number is IPAWS routing, not a name
    if (!segs.some((s) => s.toLowerCase() === seg.toLowerCase())) segs.push(seg);
  }
  return segs.join(', ');
}

const alertAgencyText = (f) => {
  const a = alertAgency(f);
  return a ? t('alert.agency').replace('{a}', a) : t('alert.agency.unknown');
};

// Riverine Flood Warnings in one county share an areaDesc ("Val Verde, TX"); the
// specific reach that tells them apart lives in the description text.
function alertReach(p) {
  const s = (p.description || '').replace(/\s+/g, ' ');
  const m = s.match(/rivers?\b[^.]*\.\.\.\s*(.+?)\s+affecting\b/i);
  if (!m) return '';
  return m[1].replace(/\bAt\b/g, 'at').replace(/\bOf\b/g, 'of').replace(/\b(?:Nr|Near)\b/gi, 'near').trim();
}

/* area= returns every product that TOUCHES the area of operations, and each one carries its full
   multi-state county list, so a Texas board prints Oklahoma counties. geocode.UGC is index-aligned
   with the areaDesc segments, so the ones outside the AO are counted instead of named. Nothing is
   ever dropped: the alert stays in the list either way, and an unreadable alignment names them all. */
function aoStates() {
  const m = /[?&]area=([A-Za-z,]+)/.exec(CONFIG.alertsUrl || '');
  return m ? m[1].toUpperCase().split(',').filter(Boolean) : [];
}

function alertAreaParts(p) {
  const segs = String((p && p.areaDesc) || '').split(';').map((s) => s.trim()).filter(Boolean);
  const ugc = (p && p.geocode && p.geocode.UGC) || [];
  const states = aoStates();
  if (!states.length || ugc.length !== segs.length) return { inAo: segs, out: 0 };
  const inAo = segs.filter((s, i) => states.includes(String(ugc[i]).slice(0, 2).toUpperCase()));
  return inAo.length ? { inAo, out: segs.length - inAo.length } : { inAo: segs, out: 0 };
}

// area line for a card, popup or glance row: AO counties named, the rest counted, never silently cut
function alertAreaText(p, max) {
  const { inAo, out } = alertAreaParts(p);
  const shown = max > 0 ? inAo.slice(0, max) : inAo;
  const more = inAo.length - shown.length;
  return [shown.join('; '),
    more ? t('alert.areaMore').replace('{n}', String(more)) : '',
    out ? t('alert.areaOut').replace('{n}', String(out)) : ''].filter(Boolean).join(' · ');
}

// the one AO county a glance surface has room for
const alertAreaLead = (p) => (alertAreaParts(p).inAo[0] || '?').replace(/,\s*[A-Z]{2}$/, '');

/* The one hazard allowlist, and the one place a hazard's class and rank are decided.
   Exact event strings, never a pattern: "Dust Storm Warning" is a storm-based polygon product and
   "Blowing Dust Warning" is a zone product, and /dust/i cannot tell them apart. An unrecognised
   string returns HTTP 200 with zero features rather than an error, so a typo here would publish
   "no tornado warnings" instead of failing; tests/hazard-table.test.js checks every string against
   a pinned snapshot of /alerts/types and against the scripts/gen-caltopo.py mirror.
   class routes the surface: acute reaches every glance surface, watch and standing do not. */
const HAZARD_EVENTS = {
  'Tornado Warning': { cls: 'acute', rank: 3 },
  'Extreme Wind Warning': { cls: 'acute', rank: 8 },
  'Dust Storm Warning': { cls: 'acute', rank: 8 },
  'Snow Squall Warning': { cls: 'acute', rank: 8 },
  'Severe Thunderstorm Warning': { cls: 'acute', rank: 11 },
  'Flash Flood Warning': { cls: 'acute', rank: 7 },
  'Flash Flood Statement': { cls: 'acute', rank: 7 },
  'Flood Warning': { cls: 'acute', rank: 10 },
  'Flood Statement': { cls: 'acute', rank: 10 },
  'Coastal Flood Warning': { cls: 'acute', rank: 10 },
  'Coastal Flood Statement': { cls: 'acute', rank: 10 },
  'Lakeshore Flood Warning': { cls: 'acute', rank: 10 },
  'Lakeshore Flood Statement': { cls: 'acute', rank: 10 },
  'Storm Surge Warning': { cls: 'acute', rank: 10 },
  'Hurricane Warning': { cls: 'acute', rank: 10 },
  'Hurricane Force Wind Warning': { cls: 'acute', rank: 10 },
  'Tropical Storm Warning': { cls: 'acute', rank: 10 },
  'Flash Flood Watch': { cls: 'watch', rank: 13 },
  'Flood Watch': { cls: 'watch', rank: 13 },
  'Coastal Flood Watch': { cls: 'watch', rank: 13 },
  'Lakeshore Flood Watch': { cls: 'watch', rank: 13 },
  'Storm Surge Watch': { cls: 'watch', rank: 13 },
  'Hurricane Watch': { cls: 'watch', rank: 13 },
  'Hurricane Force Wind Watch': { cls: 'watch', rank: 13 },
  'Tropical Storm Watch': { cls: 'watch', rank: 13 },
  'High Wind Watch': { cls: 'watch', rank: 14 },
  // the fire-weather pair sits where the wind pair does: the watch is the precursor to the warning
  'Fire Weather Watch': { cls: 'watch', rank: 14 },
  /* Orders. Not NWS products: under 47 CFR 11.31 these are state and local event codes with
     originator CIV, written by a county or a state agency and relayed down the NWS path, which is
     why they carry their author in senderName and why alertAgency reads it. They rank above every
     severe product and below the life-immediate meteorological ones: nothing the board carries
     should sit over a peer agency's evacuation order except a threat measured in minutes. */
  'Civil Danger Warning': { cls: 'order', rank: 4 },
  'Evacuation Immediate': { cls: 'order', rank: 4 },
  'Shelter In Place Warning': { cls: 'order', rank: 4 },
  'Hazardous Materials Warning': { cls: 'order', rank: 4 },
  'Civil Emergency Message': { cls: 'order', rank: 4 },
  'Law Enforcement Warning': { cls: 'order', rank: 4 },
  '911 Telephone Outage': { cls: 'order', rank: 4 },
  'Local Area Emergency': { cls: 'order', rank: 4 },
  'Fire Warning': { cls: 'order', rank: 4 },
  'High Wind Warning': { cls: 'standing', rank: 17 },
  /* Red flag is a fuel-and-weather condition with an hours-to-days life, not an event in progress:
     it belongs beside the High Wind Warning it is usually issued with, and it must never reach a
     glance surface where it could push an evacuation order or a tornado warning off the list. */
  'Red Flag Warning': { cls: 'standing', rank: 17 },
  'Dense Smoke Advisory': { cls: 'standing', rank: 18 },
  'Flood Advisory': { cls: 'standing', rank: 18 },
  'Coastal Flood Advisory': { cls: 'standing', rank: 18 },
  'Lakeshore Flood Advisory': { cls: 'standing', rank: 18 },
  'Wind Advisory': { cls: 'standing', rank: 18 },
  'Lake Wind Advisory': { cls: 'standing', rank: 18 },
  'Brisk Wind Advisory': { cls: 'standing', rank: 18 },
  'Beach Hazards Statement': { cls: 'standing', rank: 18 },
  'Tropical Cyclone Local Statement': { cls: 'standing', rank: 18 },
};

const HAZARD_EVENT_LIST = Object.keys(HAZARD_EVENTS);
const hazardAdmits = (event) => Object.prototype.hasOwnProperty.call(HAZARD_EVENTS, String(event || ''));
const hazardIsOrder = (event) => (HAZARD_EVENTS[String(event || '')] || {}).cls === 'order';

/* An unrecognised product still shows, because hiding a hazard the board does not know is the worse
   error, but it never outranks one the board does know. Same shape as ALERT_SEV_UNKNOWN. */
const HAZARD_RANK_UNKNOWN = 99;

const alertParam = (p, k) => (((p && p.parameters) || {})[k] || []).join(' ').trim();

/* Impact-based warning tags. Every parameters value is an array of strings, maxWindGust carries its
   unit ("60 MPH") and maxHailSize has no fixed format ("Up to .75", "1.00", "0.00") where 0.00 is
   a measured absence of hail rather than a missing reading. The PDS sentence is appended to the
   warning text and is not a parameter; on tornado products it tracks CONSIDERABLE 1:1, so both are
   read and either one is enough. */
function alertTags(f) {
  const p = (f && f.properties) || {};
  const damageThreat = (alertParam(p, 'tornadoDamageThreat') || alertParam(p, 'thunderstormDamageThreat')
    || alertParam(p, 'flashFloodDamageThreat')).toUpperCase() || null;
  const gust = /(\d+(?:\.\d+)?)/.exec(alertParam(p, 'maxWindGust'));
  const hail = /(\d*\.?\d+)/.exec(alertParam(p, 'maxHailSize').replace(/^up to\s*/i, ''));
  const hailIn = hail ? parseFloat(hail[1]) : null;
  const tornado = String(p.event || '') === 'Tornado Warning';
  return {
    damageThreat,
    detection: (alertParam(p, 'tornadoDetection') || alertParam(p, 'flashFloodDetection')).toUpperCase() || null,
    maxWindGustMph: gust ? Math.round(parseFloat(gust[1])) : null,
    maxHailIn: Number.isFinite(hailIn) ? hailIn : null,
    pds: /PARTICULARLY DANGEROUS SITUATION/i.test(p.description || '')
      || (tornado && (damageThreat === 'CONSIDERABLE' || damageThreat === 'CATASTROPHIC')),
  };
}

/* A flash flood emergency can arrive on a follow-up statement rather than the warning, so the
   severity read decides the class in that one case; the table decides every other, and the order
   class decides ahead of both. */
function hazardClass(f) {
  const row = HAZARD_EVENTS[String(((f && f.properties) || {}).event || '')];
  // an order stays an order whatever its prose says: the class carries the attribution and the
  // never-fold rule, and a county relaying flash-flood-emergency wording must not shed either
  if (row && row.cls === 'order') return 'order';
  if (f && f._sev === 'emergency') return 'acute';
  return row ? row.cls : 'acute';
}

// the two classes that reach every glance surface; a directive and an immediate threat both change
// what someone does in the next ten minutes, and watch and standing do not
const hazardGlance = (f) => { const c = hazardClass(f); return c === 'acute' || c === 'order'; };

/* Rank across hazard types, not within one. Time-to-harm and whether movement helps, so a tornado
   warning outranks a flash flood warning: the driver can decline to enter water, he cannot outdrive
   a tornado. Tag promotions come first so a tornado emergency reads as rank 0 rather than as the
   flash-flood-emergency rank its severity would give it. */
function hazardRank(f) {
  const ev = String(((f && f.properties) || {}).event || '');
  const tags = alertTags(f);
  if (ev === 'Tornado Warning') return tags.damageThreat === 'CATASTROPHIC' ? 0 : (tags.pds ? 2 : 3);
  if (f && f._sev === 'emergency') return 1;
  if (ev === 'Severe Thunderstorm Warning') {
    if (tags.damageThreat === 'DESTRUCTIVE') return 5;
    return tags.damageThreat === 'CONSIDERABLE' ? 9 : 11;
  }
  if (ev === 'Flash Flood Warning' || ev === 'Flash Flood Statement') return tags.damageThreat === 'CONSIDERABLE' ? 6 : 7;
  const row = HAZARD_EVENTS[ev];
  return row ? row.rank : HAZARD_RANK_UNKNOWN;
}

// CAP urgency breaks a rank tie and costs nothing; Extreme Heat Watch ships urgency Past, so it is a tiebreak only
const URGENCY_RANK = { Immediate: 0, Expected: 1, Future: 2, Past: 3 };
const urgencyRank = (f) => {
  const u = ((f && f.properties) || {}).urgency;
  return Object.prototype.hasOwnProperty.call(URGENCY_RANK, u) ? URGENCY_RANK[u] : 4;
};

const alertHazCmp = (a, b) => hazardRank(a) - hazardRank(b) || urgencyRank(a) - urgencyRank(b);

/* One warning's identity across every reissue and follow-up: the VTEC tuple
   (office, phenomenon, significance, ETN) out of /O.CON.KCRP.FL.W.0025.…/. f.id changes on every
   message, and (event, areaDesc) collides between two unrelated warnings in the same county. 200
   archived tornado records carry 63 distinct tuples. No VTEC (non-NWS products) falls back to the id. */
const VTEC_TUPLE_RE = /\/[A-Z]\.[A-Z]{3}\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\./;
function alertVtecKey(f) {
  const p = (f && f.properties) || {};
  const m = VTEC_TUPLE_RE.exec(((p.parameters && p.parameters.VTEC) || []).join(' '));
  return m ? `${m[1]}.${m[2]}.${m[3]}.${m[4]}` : String((f && f.id) || p.id || '');
}

/* Collapse a lifecycle to one row per warning, keeping the message that runs latest. Used wherever
   a surface counts warnings rather than messages: the ticker, the glance rows, history. */
function alertDedupe(list) {
  const best = new Map();
  for (const f of list || []) {
    const k = alertVtecKey(f);
    const cur = best.get(k);
    if (!cur) { best.set(k, f); continue; }
    const a = alertEndsAt(f), b = alertEndsAt(cur);
    if (!b) continue; // a product with no declared end already outlives any dated one
    if (!a || new Date(a) > new Date(b)) best.set(k, f);
  }
  return [...best.values()];
}

/* eventMotionDescription: "…T00:46:00-00:00...storm...359DEG...42KT...37.33,-87.96".
   DEG is the direction the storm comes FROM, per the meteorological convention: verified against
   the "moving southeast at 60 mph" sentence in 195 live warnings, where deg+180 matched 193 and
   deg matched none. Rendering the raw bearing would send a driver the wrong way. */
function alertMotion(f) {
  const p = (f && f.properties) || {};
  const m = /\.\.\.(\d{1,3})DEG\.\.\.(\d{1,3})KT/.exec(alertParam(p, 'eventMotionDescription'));
  if (!m) return null;
  const from = Number(m[1]), kt = Number(m[2]);
  if (!Number.isFinite(from) || !Number.isFinite(kt)) return null;
  return { dir: COMPASS[Math.round(((from + 180) % 360) / 45) % 8], mph: Math.round(kt * 1.151) };
}

const alertMotionText = (f) => {
  const mo = alertMotion(f);
  return mo ? t('alert.motion').replace('{dir}', mo.dir).replace('{n}', String(mo.mph)) : '';
};

/* A zeroed VTEC end slot means "until further notice". Riverine Flood Warnings use it routinely and
   it declares no end at all, so no clock may retire the product. */
const VTEC_NO_END = '000000T0000Z';

// the end half of each VTEC string on the product: /O.CON.KCRP.FL.W.0025.000000T0000Z-260730T0230Z/
function alertVtecEnds(p) {
  const vtec = ((p && p.parameters && p.parameters.VTEC) || []).join(' ');
  return (vtec.match(/-\d{6}T\d{4}Z/g) || []).map((s) => s.slice(1));
}

/* When the HAZARD ends, which is not properties.expires: that is the deadline for the next message,
   and on riverine warnings it runs days short of the hazard itself. Null = no declared end. */
function alertEndsAt(f) {
  const p = (f && f.properties) || {};
  if (alertVtecEnds(p).includes(VTEC_NO_END)) return null;
  return p.ends || ((p.parameters && p.parameters.eventEndingTime) || [])[0] || p.expires || null;
}

/* The single clock test behind every open/expired decision on the board. A product that declared no
   end never expires, and an unreadable end is not treated as past: this errs toward showing. */
function alertEnded(endsAt, at) {
  if (!endsAt) return false;
  const e = new Date(endsAt).getTime();
  return Number.isFinite(e) && e < (at == null ? Date.now() : new Date(at).getTime());
}

const alertOpen = (f) => !alertEnded(alertEndsAt(f));

// what the product says about its own end; a product with no declared end says so rather than lying
const alertUntilText = (f) => { const e = alertEndsAt(f); return e ? fmtWhen(e) : t('alert.further'); };

/* Each product declares its own lifetime, so nothing here needs a per-hazard table of aging
   thresholds to drift out of date: onset→ends runs 23 minutes for the median tornado warning and
   22 hours for the median extreme heat warning, a 58-fold spread that no single constant survives.
   A product with no computable lifetime falls back to the floor, which errs toward calling it old. */
const ALERT_STALE_FLOOR_MS = 15 * 60000;

function alertLifetimeMs(f) {
  const p = (f && f.properties) || {};
  const end = alertEndsAt(f), start = p.onset || p.sent || p.effective;
  if (!end || !start) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

const alertStaleAfterMs = (f) => Math.max(ALERT_STALE_FLOOR_MS, 0.25 * (alertLifetimeMs(f) || 0));

// staleness scales with the product's own lifetime: a short-fuse warning ages far sooner than a
// multi-day heat warning, but never sooner than ALERT_STALE_FLOOR_MS
function alertFreshClass(f, at) {
  const sent = ((f && f.properties) || {}).sent;
  const age = (at == null ? Date.now() : new Date(at).getTime()) - new Date(sent).getTime();
  if (!sent || !Number.isFinite(age)) return 'stale';
  const limit = alertStaleAfterMs(f);
  return age < limit / 2 ? 'fresh' : (age < limit ? 'aging' : 'stale');
}

// active hurricane/tropical threat to the TX mainland = an unexpired storm surge / tropical storm / hurricane warning or watch
const TROPICAL_THREAT_RE = /storm surge (warning|watch)|tropical storm (warning|watch)|hurricane (warning|watch)/i;
function hasActiveTropicalThreat() {
  return (state.alerts || []).some((f) => TROPICAL_THREAT_RE.test(f.properties.event || '') && alertOpen(f));
}
// default the tropical tracker ON the first time TX has an active tropical/hurricane threat; a manual toggle-off (overlayremove) stops auto-enable
function maybeAutoTropical() {
  if (state.tropicalAutoDone || CONFIG.tropicalAutoEnable === false) return;
  if (!state.map || !state.layers.tropical || !hasActiveTropicalThreat()) return;
  state.tropicalAutoDone = true;
  if (!state.map.hasLayer(state.layers.tropical)) state.layers.tropical.addTo(state.map);
}

async function fetchAlerts() {
  const res = await fetch(CONFIG.alertsUrl, { headers: { Accept: 'application/geo+json' } });
  const data = await okJson(res, 'NWS alerts');
  // E1: a body without features is a failed request, never "no warnings are in effect"
  const hazards = okList(data, 'features', 'NWS alerts').filter((f) => hazardAdmits(f.properties.event));
  hazards.forEach((f) => { f._sev = alertSeverity(f.properties); });
  hazards.sort((a, b) => alertHazCmp(a, b) || new Date(b.properties.sent || 0) - new Date(a.properties.sent || 0));
  const emergencies = hazards.filter((f) => f._sev === 'emergency');
  const openEmerg = emergencies.filter(alertOpen);
  const fresh = emergencies.filter((f) => !state.knownEmergencyIds.has(f.id));
  emergencies.forEach((f) => state.knownEmergencyIds.add(f.id));
  const mode = emergencyBannerMode(openEmerg.length, fresh.length, state.alertsLoadedOnce);
  if (mode) showEmergencyBanner(mode === 'active' ? openEmerg : fresh, mode);
  if (!emergencies.length && !$('#emergency-banner').hidden) dismissEmergencyBanner(); // banner ages out with its alert
  state.alertsLoadedOnce = true;
  state.alerts = hazards;
  markHealthy('alerts');
  recordAlertHist();
  renderAlertList();
  await renderAlertPolys();
  renderTiles();
  maybeAutoTropical(); // auto-enable the tracker when TX has an active tropical/hurricane threat
  syncAcutePoll();
}

/* Three minutes is nothing for a river and up to two miles of storm travel for a tornado. Shortening
   the global refresh would multiply load across ten feeds to serve one hazard class, and the phone
   on a weak signal would pay for it, so the alerts endpoint alone polls faster and only while a
   moving product is open.
   The gate is the product's own storm motion, not a list of event names and not a lifetime constant:
   measured live, eventMotionDescription is present on 100% of tornado and severe thunderstorm
   warnings and 0% of flood warnings, so it separates the swath that travels from the river that does
   not, and it keeps a Texas summer of standing flood warnings off the fast path. */
const alertMoves = (f) => hazardClass(f) === 'acute' && !!alertMotion(f);

function syncAcutePoll() {
  const scope = alertScope();
  const fast = (state.alerts || []).some((f) => alertOpen(f) && alertMoves(f) && alertNear(f, scope));
  if (!fast) {
    if (state.acuteAlertTimer) clearInterval(state.acuteAlertTimer);
    state.acuteAlertTimer = null;
    return;
  }
  if (state.acuteAlertTimer) return;
  state.acuteAlertTimer = setInterval(() => {
    if (document.visibilityState === 'hidden') return; // battery: the visibility handler catches up on return
    fetchAlerts().catch(() => { /* transient; the 180 s cycle owns feed-health reporting */ });
  }, CONFIG.acuteRefreshMs);
}

async function zoneGeometry(zoneUrl) {
  if (state.zoneGeomCache.has(zoneUrl)) return state.zoneGeomCache.get(zoneUrl);
  try {
    const res = await fetch(zoneUrl, { headers: { Accept: 'application/geo+json' } });
    const gj = (await okJson(res, 'NWS zone')).geometry;
    if (!gj || typeof gj !== 'object') throw new Error('NWS zone: no geometry');
    state.zoneGeomCache.set(zoneUrl, gj);
    return gj;
  } catch { return null; } // not cached: a transient failure must not pin this zone shapeless for the session
}

/* Hazard type is a visual dimension in its own right, not a shade of severity: a tornado polygon and
   a flood polygon that share a colour can only be told apart by reading the label. These are the
   tokens playback has drawn storm-based products with since v0.91, promoted to the live map. */
const HAZARD_STYLE = {
  'Tornado Warning': 'tornado',
  'Severe Thunderstorm Warning': 'severe',
  'Dust Storm Warning': 'dust',
  'Snow Squall Warning': 'winter',
  'Extreme Wind Warning': 'wind',
  'Red Flag Warning': 'fire',
  'Fire Weather Watch': 'fire',
  /* Smoke is its own token rather than a shade of fire: a dense smoke advisory is a visibility
     hazard over ground that is usually nowhere near what is burning, so a fire glyph on it would
     assert a fire where the product asserts only smoke. */
  'Dense Smoke Advisory': 'smoke',
};
// an order is a directive rather than a forecast, so it reads as one colour of its own whatever
// hazard prompted it: the wildfire behind an evacuation order is not what the reader has to act on
const hazardStyleKey = (f) => HAZARD_STYLE[String(((f && f.properties) || {}).event || '')]
  || (hazardClass(f) === 'order' ? 'order' : 'flood');

const HAZARD_GLYPH = { tornado: '🌪', severe: '⛈', dust: '🌫', winter: '❄', wind: '🌬', fire: '🔥', smoke: '💨', flood: '🌊', order: '⛔' };
const hazardGlyph = (f) => HAZARD_GLYPH[hazardStyleKey(f)] || '⚠';

/* The verb, not the hazard name. A driver has ten seconds and gloves, and "Tornado Warning" is a
   noun: the answer to a tornado is shelter, and the answer to a dust storm is the opposite of the
   answer to a flood. A product with no correct ten-second driving action gets no row in Drive Mode
   at all, because a row a driver cannot act on is what teaches him to stop reading the list.
   Snow squall reads "avoid travel" rather than "take shelter": the hazard is the whiteout on the
   roadway, and stopping on the shoulder in one is how the pile-up happens.
   Only acute and order products reach Drive Mode at all (driveItems filters on hazardGlance), so a
   row here for a watch or standing product would be unreachable rather than merely wrong. */
const HAZARD_ACTION = {
  'Tornado Warning': 'drive.act.shelter',
  'Extreme Wind Warning': 'drive.act.shelter',
  'Dust Storm Warning': 'drive.act.pulloff',
  'Snow Squall Warning': 'drive.act.notravel',
  'Storm Surge Warning': 'drive.act.highground',
  'Flash Flood Warning': 'drive.act.nocross',
  'Flash Flood Statement': 'drive.act.nocross',
  'Flood Warning': 'drive.act.nocross',
  'Flood Statement': 'drive.act.nocross',
  'Coastal Flood Warning': 'drive.act.nocross',
  'Coastal Flood Statement': 'drive.act.nocross',
  'Lakeshore Flood Warning': 'drive.act.nocross',
  'Lakeshore Flood Statement': 'drive.act.nocross',
};

/* An order's verb comes from the order, not from a table here. CAP carries responseType on the
   product, so the county that wrote "Evacuate" has already said what to do more authoritatively
   than any mapping of ours could, and it stays right when a Civil Danger Warning means shelter one
   day and leave the next. The event string overrides only where it is itself the directive. */
const ORDER_RESPONSE_ACTION = {
  Evacuate: 'drive.act.evacuate',
  Shelter: 'drive.act.shelterplace',
  Avoid: 'drive.act.avoidarea',
  Prepare: 'drive.act.readymove',
};
const ORDER_EVENT_ACTION = {
  '911 Telephone Outage': 'drive.act.nine11',
  'Evacuation Immediate': 'drive.act.evacuate',
  'Shelter In Place Warning': 'drive.act.shelterplace',
  'Hazardous Materials Warning': 'drive.act.hazmat',
};

function alertActionKey(f) {
  const ev = String(((f && f.properties) || {}).event || '');
  /* Unlike a hazard, an order never falls through to no row: it is a directive addressed to the
     person reading it, and "read it" is a correct ten-second action even when nothing narrower is. */
  if (hazardClass(f) === 'order') {
    return ORDER_EVENT_ACTION[ev]
      || ORDER_RESPONSE_ACTION[String(((f && f.properties) || {}).response || '')]
      || 'drive.act.order';
  }
  // a destructive severe thunderstorm carries tornado-strength wind, which is why it is the one WEA-carried severe tag
  if (ev === 'Severe Thunderstorm Warning') return alertTags(f).damageThreat === 'DESTRUCTIVE' ? 'drive.act.shelter' : 'drive.act.inside';
  const key = HAZARD_ACTION[ev];
  if (key === 'drive.act.nocross' && f && f._sev === 'emergency') return 'drive.act.highground';
  return key || null;
}

/* A storm-based warning is a swath the storm will travel, not an area that is flooded, so it draws
   as a dashed outline: the edge carries the information and a filled area buries the gauge and road
   layers the board is built on. */
const HAZARD_SWATH = ['tornado', 'severe', 'dust', 'winter', 'wind'];
function hazardPolyStyle(f) {
  const hz = hazardStyleKey(f);
  const swath = HAZARD_SWATH.includes(hz);
  const emerg = f && f._sev === 'emergency';
  return {
    className: `alert-poly sev-${f && f._sev} haz-${hz}`,
    weight: emerg ? 2.5 : (swath ? 2 : 1.5),
    fillOpacity: swath ? 0.06 : (emerg ? 0.22 : 0.10),
    dashArray: swath ? '6 4' : null,
    opacity: 0.9,
  };
}

async function renderAlertPolys() {
  state.layers.alerts.clearLayers();
  let zoneFetchBudget = CONFIG.maxZoneGeomFetches;
  // reverse rank order: least-severe drawn first, the worst hazard lands on top
  for (const f of state.alerts.slice().reverse()) {
    if (!alertOpen(f)) continue; // never draw an alert the NWS no longer lists as open
    let geom = f.geometry;
    if (!geom && f._sev !== 'advisory' && zoneFetchBudget > 0) {
      const zones = f.properties.affectedZones || [];
      const geoms = [];
      for (const z of zones.slice(0, 3)) {
        if (zoneFetchBudget <= 0 && !state.zoneGeomCache.has(z)) break;
        if (!state.zoneGeomCache.has(z)) zoneFetchBudget--;
        const g = await zoneGeometry(z);
        if (g) geoms.push(g);
      }
      if (geoms.length === 1) geom = geoms[0];
      else if (geoms.length > 1) geom = { type: 'GeometryCollection', geometries: geoms };
    }
    if (!geom) continue;
    const layer = L.geoJSON({ type: 'Feature', geometry: geom }, { style: hazardPolyStyle(f) });
    layer._alertId = f.id; // lets a card click find and flash its polygon
    layer.bindPopup(alertPopupHtml(f));
    state.layers.alerts.addLayer(layer);
  }
}

/* Opening the board during an emergency must surface it. A first fetch has no arrival to report,
   so it states the standing emergency ("active"); later fetches report only new ids ("new"). */
function emergencyBannerMode(openCount, freshCount, loadedOnce) {
  if (!loadedOnce) return openCount ? 'active' : null;
  return freshCount ? 'new' : null;
}

function showEmergencyBanner(alerts, mode) {
  const areas = alerts.map((f) => alertAreaText(f.properties)).join(' | ');
  $('#banner-text').textContent = t(mode === 'active' ? 'banner.ffe.active' : 'banner.ffe').replace('{areas}', areas);
  $('#emergency-banner').hidden = false;
  if (!document.title.startsWith('🔴')) document.title = `🔴 ${document.title}`;
}

function dismissEmergencyBanner() {
  $('#emergency-banner').hidden = true;
  document.title = document.title.replace(/^🔴 /, '');
}

function alertPopupHtml(f) {
  const p = f.properties;
  const reach = alertReach(p);
  return `<div class="popup-title">${esc(p.event)}${f._sev === 'emergency' ? `: <span style="color:var(--sev-emergency);font-weight:700">${esc(t('drive.emerg'))}</span>` : ''}</div>` +
    `<div class="popup-meta">${esc(alertAreaText(p))}${reach ? ` · ${esc(reach)}` : ''}</div>` +
    `<div class="popup-meta">${esc(t('alert.until'))} ${esc(alertUntilText(f))}${alertMotionText(f) ? ` · ${esc(alertMotionText(f))}` : ''}</div>` +
    `<div class="popup-link"><a href="#" class="alert-popup-link" data-alert-id="${esc(f.id)}">${esc(t('alert.full'))} →</a></div>`;
}

/* ---------- proximity scope: the Alerts tab leads with what is near, and folds nothing away ---------- */

const ALERT_NEAR_MI = 50;

// GeoJSON bounds without Leaflet, so the scope math runs before the map exists and stays testable
function mergeBounds(list) {
  const parts = (list || []).filter(Boolean);
  if (!parts.length) return null;
  return parts.reduce((a, b) => ({ n: Math.max(a.n, b.n), s: Math.min(a.s, b.s), e: Math.max(a.e, b.e), w: Math.min(a.w, b.w) }));
}

function geoBounds(geom) {
  if (!geom || typeof geom !== 'object') return null;
  if (geom.type === 'Feature') return geoBounds(geom.geometry);
  if (geom.type === 'FeatureCollection') return mergeBounds((Array.isArray(geom.features) ? geom.features : []).map(geoBounds));
  if (geom.type === 'GeometryCollection') return mergeBounds((geom.geometries || []).map(geoBounds));
  const b = { n: -Infinity, s: Infinity, e: -Infinity, w: Infinity };
  let seen = false;
  const walk = (c) => {
    if (!Array.isArray(c)) return;
    if (!Array.isArray(c[0]) && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
      seen = true;
      b.n = Math.max(b.n, c[1]); b.s = Math.min(b.s, c[1]);
      b.e = Math.max(b.e, c[0]); b.w = Math.min(b.w, c[0]);
      return;
    }
    for (const x of c) walk(x);
  };
  walk(geom.coordinates);
  return seen ? b : null;
}

// miles from the nearest scope point to a footprint, 0 inside its box; NaN when there is nothing to measure
function geoDistMi(geom, pts) {
  const b = geoBounds(geom);
  if (!b || !Array.isArray(pts)) return NaN;
  let best = NaN;
  for (const p of pts) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const d = distMi(p[0], p[1], Math.min(Math.max(p[0], b.s), b.n), Math.min(Math.max(p[1], b.w), b.e));
    if (!(best <= d)) best = d;
  }
  return best;
}

function geoInView(geom, view) {
  const b = geoBounds(geom);
  if (!b || !view) return false;
  return b.e >= view.w && b.w <= view.e && b.n >= view.s && b.s <= view.n;
}

// unscoped, or unplaceable: either way the board cannot rule this out, so it stays in the lead group
function geomInScope(geom, scope) {
  if (!scope || !geom) return true;
  if (scope.view) return geoInView(geom, scope.view);
  const d = geoDistMi(geom, scope.pts);
  return !Number.isFinite(d) || d <= ALERT_NEAR_MI;
}

function ptInScope(lat, lon, scope) {
  const pt = Number.isFinite(lat) && Number.isFinite(lon) ? { type: 'Point', coordinates: [lon, lat] } : null;
  return geomInScope(pt, scope);
}

const alertGeom = (f) => (f && f.geometry)
  || (((f && f.properties && f.properties.affectedZones) || []).map((z) => state.zoneGeomCache.get(z)).find(Boolean))
  || null;

/* The alert-area points from the push prefs. The user named these as places they want flood alerts
   about, so ordering this list by them serves that same purpose and never leaves the device. Saved
   my-places are deliberately not read: copying one into the alert area is an explicit act. */
function alertAreaPlaces() {
  if (typeof pushPrefs !== 'function') return [];
  const prefs = pushPrefs();
  if (!prefs || prefs.scope !== 'places') return [];
  return (prefs.places || []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon)).map((p) => [p.lat, p.lon]);
}

// points to measure a card's distance from; never prompts, only reuses what the user already gave
function alertDistPts() {
  const p = state.myPos;
  if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) return [[p.lat, p.lng]];
  return alertAreaPlaces();
}

/* What "near" means right now, most specific first. Null = nothing to measure from, which keeps
   the list flat and complete rather than inventing a centre the user never chose. */
function alertScope() {
  if (state.inView && state.map && typeof state.map.getBounds === 'function') {
    try {
      const b = state.map.getBounds(), sw = b.getSouthWest(), ne = b.getNorthEast();
      const view = { s: sw.lat, w: sw.lng, n: ne.lat, e: ne.lng };
      if (Object.values(view).every(Number.isFinite)) return { src: 'inview', view };
    } catch { /* map not ready this tick; fall through to a point scope */ }
  }
  const p = state.myPos;
  if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) return { src: 'me', pts: [[p.lat, p.lng]] };
  const places = alertAreaPlaces();
  return places.length ? { src: 'place', pts: places } : null;
}

const alertScopeSrc = (scope) => (scope ? scope.src : 'all');

/* What "near" means is a property of the hazard, not one radius for all of them. An hour of storm
   travel at 45 kt is about 60 miles, so that is the acute radius. A watch box is 20,000 sq mi and a
   heat advisory 50 miles away is meteorologically identical to one overhead: for those, distance
   conveys nothing and only containment does, which is what a radius of 0 means here. */
const ALERT_NEAR_MI_ACUTE = 60;
const alertNearMi = (cls) => (cls === 'acute' ? ALERT_NEAR_MI_ACUTE : 0);

/* A flash-flood emergency never folds: the banner carries it statewide and the list must agree.
   Deliberately not extended to every acute product: a tornado warning in Amarillo is genuinely
   irrelevant to a Hill Country responder, and storm-based polygons are precise enough to say so. */
function alertNear(f, scope) {
  if (f && f._sev === 'emergency') return true;
  /* An order never folds. It is a directive from a peer agency, and folding the next county's
     evacuation behind a "show more" button is wrong for the team lead moving people across that
     boundary. Distance is the wrong question about a directive. */
  if (hazardClass(f) === 'order') return true;
  const geom = alertGeom(f);
  if (!scope || !geom) return true; // unscoped, or unplaceable: the board cannot rule this out
  if (scope.view) return geoInView(geom, scope.view);
  const d = geoDistMi(geom, scope.pts);
  return !Number.isFinite(d) || d <= alertNearMi(hazardClass(f));
}

/* Near first, the rest folded below, nothing dropped. Hazard rank leads inside each group, so a
   tornado warning never sits under a flood advisory; distance breaks the tie. */
function alertGroups(list, scope, pts) {
  const origin = Array.isArray(pts) ? pts : (scope && scope.pts) || null;
  const rows = (list || []).map((f) => ({ f, d: geoDistMi(alertGeom(f), origin), near: alertNear(f, scope) }));
  const dv = (r) => (Number.isFinite(r.d) ? r.d : Infinity);
  const bySev = (a, b) => alertHazCmp(a.f, b.f) || alertSevCmp(a.f, b.f);
  const byDist = (a, b) => (dv(a) === dv(b) ? 0 : dv(a) - dv(b));
  const bySent = (a, b) => (Date.parse(b.f.properties && b.f.properties.sent) || 0) - (Date.parse(a.f.properties && a.f.properties.sent) || 0);
  return {
    near: rows.filter((r) => r.near).sort((a, b) => bySev(a, b) || byDist(a, b) || bySent(a, b)),
    far: rows.filter((r) => !r.near).sort((a, b) => byDist(a, b) || bySev(a, b) || bySent(a, b)),
  };
}

// bbox distance under-reads a concave polygon, so the chip reads as approximate and never as coverage
const alertDistChip = (d) => (Number.isFinite(d) ? t('alert.dist').replace('{n}', String(Math.round(d))) : '');

const NINE11_EVENT = '911 Telephone Outage';

/* The alternate number the outage product itself published, quoted rather than composed. Civil
   authorities write it two ways and both shapes are verbatim in tests/fixtures/alerts-orders.json:
   830-896-1216, and 8 3 0 2 4 9 9 5 4 6 spaced one digit at a time so the text-to-speech relay
   reads it correctly. Only ever run on an outage product, where a ten-digit number in the text is
   the callback and nothing else. No match returns empty: "the alert published no number" is true
   and a guessed number on this particular card could send someone nowhere. */
const NINE11_SPACED_RE = /(?:\d[  ]+){9}\d/;
const NINE11_PLAIN_RE = /\(?([2-9]\d{2})\)?[\s.-]*([2-9]\d{2})[\s.-]*(\d{4})(?!\d)/;

function nine11Alt(f) {
  const p = (f && f.properties) || {};
  if (String(p.event || '') !== NINE11_EVENT) return '';
  const text = [p.instruction, p.description, ((p.parameters || {}).CMAMlongtext || []).join(' ')]
    .filter(Boolean).join('\n');
  const spaced = (text.match(NINE11_SPACED_RE) || [''])[0].replace(/\D/g, '');
  if (spaced.length === 10) return `${spaced.slice(0, 3)}-${spaced.slice(3, 6)}-${spaced.slice(6)}`;
  const plain = text.match(NINE11_PLAIN_RE);
  return plain ? `${plain[1]}-${plain[2]}-${plain[3]}` : '';
}

/* Open outages covering a point the reader actually gave the board. Deliberately not the map view:
   panning across a county does not put anyone in it, and this qualifies the board's own "call 911"
   line, which is a claim about where the reader stands. No fix, or an unmappable extent, returns
   nothing: neither can be confirmed, and the order still carries in the list, the hazard line and
   Drive Mode, so it is never hidden, only never asserted about someone the board cannot place.
   geoDistMi measures to the bounding box, so containment errs wide, which is why the notice names
   the areas it read. */
function nine11Outages(pts) {
  const at = Array.isArray(pts) ? pts : alertDistPts();
  if (!at.length) return [];
  return (state.alerts || []).filter((f) => String((f.properties || {}).event || '') === NINE11_EVENT
    && alertOpen(f) && geoDistMi(alertGeom(f), at) === 0);
}

/* What the warning office measured, in its own words: the damage threat that decides whether a
   phone screamed, whether the tornado was seen or only radar-inferred, and the gust and hail it
   carries. A storm-based product is a moving swath, so the motion line runs with them. */
function alertTagChips(f) {
  const tags = alertTags(f);
  const chips = [];
  if (tags.pds) chips.push({ key: 'alert.tag.pds', cls: 'ht-pds' });
  else if (tags.damageThreat === 'DESTRUCTIVE') chips.push({ key: 'alert.tag.destructive', cls: 'ht-pds' });
  else if (tags.damageThreat === 'CONSIDERABLE') chips.push({ key: 'alert.tag.considerable', cls: 'ht-hi' });
  if (tags.detection === 'OBSERVED') chips.push({ key: 'alert.tag.observed', cls: 'ht-hi' });
  else if (tags.detection === 'RADAR INDICATED') chips.push({ key: 'alert.tag.radar', cls: '' });
  const out = chips.map((c) => `<span class="haz-tag ${c.cls}">${esc(t(c.key))}</span>`);
  if (tags.maxWindGustMph) out.push(`<span class="haz-tag">${esc(t('alert.tag.gust').replace('{n}', String(tags.maxWindGustMph)))}</span>`);
  if (tags.maxHailIn > 0) out.push(`<span class="haz-tag">${esc(t('alert.tag.hail').replace('{n}', tags.maxHailIn.toFixed(2)))}</span>`);
  const motion = alertMotionText(f);
  if (motion) out.push(`<span class="haz-tag">${esc(motion)}</span>`);
  return out.length ? `<div class="haz-tags">${out.join('')}</div>` : '';
}

function alertCardDiv(f, dist) {
  const p = f.properties;
  const reach = alertReach(p);
  const isOrder = hazardClass(f) === 'order';
  /* An order's extent is often prose, with no polygon and no zone to resolve: two of the six
     archived products carry neither. The card says so rather than leaving a reader to read a
     silent absence as "nowhere near me", and the board never estimates a boundary it was not given. */
  const unmapped = isOrder && !alertGeom(f);
  const div = document.createElement('div');
  div.className = `card alert-card sev-${f._sev} haz-${hazardStyleKey(f)}${unmapped ? ' alert-unmapped' : ''}`;
  div.dataset.alertId = f.id || ''; // the handle the hazard line reveals this row by
  div.innerHTML = `<div class="event"><span class="ev-name">${esc(p.event)}</span>${f._sev === 'emergency' ? `<span class="emergency-flag">${esc(t('alert.flag.emerg'))}</span>` : ''}` +
    `<a class="alert-text-link" role="button" tabindex="0">${esc(t('alert.text'))} ↗</a></div>` +
    `<div class="areas">${esc(alertAreaText(p))}${reach ? ` · <span class="alert-reach">${esc(reach)}</span>` : ''}` +
    (alertDistChip(dist) ? ` · <span class="alert-dist">${esc(alertDistChip(dist))}</span>` : '') +
    (unmapped ? ` · <span class="alert-noextent" title="${esc(t('alert.extent.unmapped.title'))}">${esc(t('alert.extent.unmapped'))}</span>` : '') + '</div>' +
    // these are not NWS products; the badge credits whoever senderName says wrote it
    (isOrder ? `<div class="alert-agency">${esc(alertAgencyText(f))}</div>` : '') +
    alertTagChips(f) +
    `<div class="alert-meta">` +
    (p.sent ? `<span class="am-when"><span class="fresh-dot ${alertFreshClass(f)}"></span>${esc(t('alert.sent'))} ${esc(fmtWhen(p.sent))}</span>` : '') +
    `<span class="am-when">${esc(t('alert.untilShort'))} ${esc(alertUntilText(f))}</span></div>`;
  const link = div.querySelector('.alert-text-link');
  link.addEventListener('click', (e) => { e.stopPropagation(); openAlertText(f); });
  link.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openAlertText(f); } });
  div.addEventListener('click', () => focusAlert(f));
  return div;
}

// after a card jumps the map, identify the one you clicked: flash its polygon
// outline and drop a pulsing ping at its center (works even in crowded areas, or
// when the polygon is not drawn — falls back to the geometry/zone bounds center).
function flashAlert(f) {
  let target = null, center = null;
  state.layers.alerts.eachLayer((lyr) => { if (lyr._alertId === f.id) target = lyr; });
  if (target) {
    try { target.bringToFront(); center = target.getBounds().getCenter(); } catch {}
    const toggle = (add) => target.eachLayer((p) => {
      const el = p.getElement && p.getElement();
      if (el && el.classList) el.classList[add ? 'add' : 'remove']('alert-flash');
    });
    toggle(true); setTimeout(() => toggle(false), 1900);
  }
  if (!center) {
    const geom = f.geometry || (f.properties.affectedZones || []).map((z) => state.zoneGeomCache.get(z)).find(Boolean);
    if (geom) { try { center = L.geoJSON(geom).getBounds().getCenter(); } catch {} }
  }
  if (!center) return;
  const icon = L.divIcon({ className: '', html: '<div class="alert-ping"></div>', iconSize: [0, 0] });
  const ping = L.marker(center, { icon, interactive: false, keyboard: false, zIndexOffset: 1200 }).addTo(state.map);
  setTimeout(() => { try { state.map.removeLayer(ping); } catch {} }, 1900);
}

// Human-readable alert reader: NWS has no per-alert HTML page, so render the
// description/instruction we already fetched, cited, instead of the raw API JSON.
function openAlertText(f) {
  const p = f.properties, reach = alertReach(p);
  $('#alert-title').textContent = p.event + (f._sev === 'emergency' ? ` · ${t('drive.emerg')}` : '');
  const parts = [`<div class="alert-doc-area">${esc(alertAreaText(p))}${reach ? ` · ${esc(reach)}` : ''}</div>`];
  if (p.headline) parts.push(`<div class="alert-doc-headline">${esc(p.headline)}</div>`);
  parts.push(`<div class="alert-doc-when">${esc(t('alert.until'))} ${esc(alertUntilText(f))}</div>`);
  if (p.description) parts.push(`<pre class="alert-doc-text">${esc(p.description.trim())}</pre>`);
  if (p.instruction) parts.push(`<div class="alert-doc-instr-h">${esc(t('alert.instruction'))}</div><pre class="alert-doc-text">${esc(p.instruction.trim())}</pre>`);
  // a product that did not say who wrote it is not an NWS product; the old 'NWS' default asserted one
  parts.push(`<div class="alert-doc-src">${esc(alertAgency(f) || t('alert.agency.unknown'))} · <a href="${esc(safeUrl(f.id))}" target="_blank" rel="noopener">${esc(t('alert.raw'))} →</a></div>`);
  $('#alert-body').innerHTML = parts.join('');
  $('#alert-modal').hidden = false;
}

function openAlertTextById(id) {
  const f = state.alerts.find((a) => a.id === id);
  if (f) openAlertText(f);
}

// mirrors the Feed and Gauges chip: one shared scope, one count, live on pan while it is on
function syncAlertInViewChip(n) {
  const btn = $('#flt-alert-inview');
  if (!btn) return;
  btn.classList.toggle('on', state.inView);
  btn.textContent = state.inView ? `${t('sync.inview')} · ${n}` : t('sync.inview');
}

/* Rows arrive ranked, so the classes already come out in order; the header names the boundary the
   reader is crossing. Each header is emitted once, so an unrecognised product landing last under
   the acute class cannot open a second copy of the heading it already sat under. */
const HAZARD_CLASS_LABEL = { acute: 'alert.cls.acute', order: 'alert.cls.order', watch: 'alert.cls.watch', standing: 'alert.cls.standing' };

function appendAlertRows(el, rows) {
  const seen = new Set();
  for (const r of rows) {
    const cls = hazardClass(r.f);
    if (!seen.has(cls) && HAZARD_CLASS_LABEL[cls]) {
      seen.add(cls);
      const h = document.createElement('div');
      h.className = `alert-class-head cls-${cls}`;
      h.textContent = t(HAZARD_CLASS_LABEL[cls]);
      el.appendChild(h);
    }
    el.appendChild(alertCardDiv(r.f, r.d));
  }
}

function renderAlertList() {
  const el = $('#alert-list');
  const scope = alertScope();
  // no radius in the heading: "near" is now per hazard class, so one number there would be a false claim
  el.innerHTML = `<div class="section-title">${esc(t(`sec.alerts.${alertScopeSrc(scope)}`))}</div>`;
  const sevF = $('#flt-alert-sev').value, qF = $('#flt-alert-q').value.toLowerCase();
  // an alert past its hazard end folds into the expired drawer below, never out of the tab entirely.
  // the search still reads the full areaDesc, so an out-of-AO county name finds its alert.
  const shown = state.alerts.filter((f) => alertOpen(f) && (!sevF || f._sev === sevF)
    && (!qF || `${f.properties.event} ${f.properties.areaDesc} ${alertReach(f.properties)}`.toLowerCase().includes(qF)));
  const { near, far } = alertGroups(shown, scope, alertDistPts());
  syncAlertInViewChip(near.length);
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'card';
    empty.textContent = t('sec.alerts.empty');
    el.appendChild(empty);
  } else {
    appendAlertRows(el, near);
    // scoping folds, never drops: the rest stay one tap away and keep their own distance
    if (far.length) {
      const btn = document.createElement('button');
      btn.className = 'aged-toggle';
      btn.textContent = `${t(state.showAlertsFar ? 'toggle.hide' : 'toggle.show')} ${far.length > 1 ? t('alert.far').replace('{n}', far.length) : t('alert.far1')}`;
      btn.addEventListener('click', () => { state.showAlertsFar = !state.showAlertsFar; renderAlertList(); });
      el.appendChild(btn);
      if (state.showAlertsFar) appendAlertRows(el, far);
    }
  }
  const open = state.alerts.filter(alertOpen);
  const emergN = open.filter((f) => f._sev === 'emergency').length;
  const alertsBadge = $('#alerts-count');
  alertsBadge.textContent = emergN ? `⚠ ${emergN}` : open.length;
  alertsBadge.classList.toggle('sev', emergN > 0);
  renderAlertHistory(el);
}

// pre-v0.99.55 rows stored only the message deadline, which is why the stored end is read this way
const histAlertEnd = (a) => (a && Object.prototype.hasOwnProperty.call(a, 'endsAt') ? a.endsAt : (a || {}).expires);

function renderAlertHistory(el) {
  const liveIds = new Set(state.alerts.map((f) => f.id));
  const expired = Object.entries(state.hist.alerts)
    .filter(([id, a]) => !liveIds.has(id) || alertEnded(histAlertEnd(a)))
    .map(([, a]) => a)
    .sort((a, b) => new Date(b.t) - new Date(a.t));
  if (!expired.length) return;
  const btn = document.createElement('button');
  btn.className = 'aged-toggle';
  btn.textContent = `${t(state.showAlertHist ? 'toggle.hide' : 'toggle.show')} ${t('alert.expired').replace('{n}', expired.length).replace('{d}', CONFIG.histDays)}`;
  btn.addEventListener('click', () => { state.showAlertHist = !state.showAlertHist; renderAlertList(); });
  el.appendChild(btn);
  if (!state.showAlertHist) return;
  for (const a of expired.slice(0, 50)) {
    const div = document.createElement('div');
    div.className = `card alert-card aged sev-${a.sev}`;
    div.innerHTML = `<div class="event">${esc(a.event)}</div><div class="areas">${esc(a.areaDesc || '')}</div>` +
      `<div class="meta" style="margin-top:3px;font-size:11px;color:var(--ink-muted)">sent ${esc(fmtWhen(a.t))}` +
      (histAlertEnd(a) ? ` · expired ${esc(fmtWhen(histAlertEnd(a)))}` : '') + '</div>';
    el.appendChild(div);
  }
}

/* ---------- NOAA NWPS gauges ---------- */

/* NWPS puts three degraded states in the same field as severity. Split, never dropped: state.gauges
   stays exactly the severity-bearing set every count, tile and threat chip reads, so a gauge without
   thresholds or without current data can still never inflate a flood claim; state.gaugesDegraded
   carries the rest so the map and the legend can show them as what they are. */
// the NWPS-reported degraded set. One predicate for the split, the card, the popup and the
// guards below, so no surface can disagree with another about what a gauge is.
const gaugeDegraded = (g) => !!NWPS_DEGRADED_CAT[g && g.status && g.status.observed && g.status.observed.floodCategory];

function splitGauges(list) {
  const live = [], degraded = [];
  for (const g of (list || [])) {
    if (!(g.status && g.status.observed && g.status.observed.floodCategory)) continue;
    (gaugeDegraded(g) ? degraded : live).push(g);
  }
  return { live, degraded };
}

async function fetchGauges() {
  const b = CONFIG.gaugeBbox;
  const url = `${CONFIG.nwpsBase}/gauges?bbox.xmin=${b.xmin}&bbox.ymin=${b.ymin}&bbox.xmax=${b.xmax}&bbox.ymax=${b.ymax}&srid=EPSG_4326`;
  const res = await fetch(url);
  const data = await okJson(res, 'NWPS');
  // E1: an unreadable body must not wipe the board to zero gauges and stand the snapshot down
  const split = splitGauges(okList(data, 'gauges', 'NWPS'));
  state.gauges = split.live;
  state.gaugesDegraded = split.degraded;
  markHealthy('gauges');
  state.snapshotAt = null; // live feed recovered — snapshot semantics no longer apply
  recordTrends();
  renderGauges();
  renderGaugesTab();
  renderForecastList();
  renderTiles();
}

// a sensor is stale/dead when its last observation is missing/unparseable or older than the
// recency cutoff — a frozen gauge keeps reporting a real floodCategory, so obs-age is the only tell
function gaugeObsStale(g) {
  const iso = g.status && g.status.observed && g.status.observed.validTime;
  if (!iso) return true;
  const m = ageMins(iso);
  return Number.isNaN(m) || m > CONFIG.gaugeStaleHours * 60;
}

// raw observed category — DISPLAY source of truth (popup/list/marker still show the frozen reading, badged stale)
function gaugeObsCat(g) {
  const c = g.status.observed.floodCategory;
  return FLOOD_CATS.includes(c) ? c : 'none';
}

// flood-signal gate: a stale sensor never counts as in-flood, so every count/threat/tile that keys
// off gaugeCat (KPI tile, threat strip, sitrep, ticker, drive mode) drops dead gauges automatically
function gaugeCat(g) {
  return gaugeObsStale(g) ? 'none' : gaugeObsCat(g);
}

/* Legend taxonomy: one severity or one degraded state, never both. Precedence is deliberate: a
   disabled sensor outranks a late one, and "the number you see is old" outranks "this site has no
   thresholds", because only the first misleads someone reading a level off the screen. Our own 12h
   rule folds into the same row as the NWPS obs_not_current flag; both mean data not current. */
function gaugeState(g) {
  const c = g.status && g.status.observed && g.status.observed.floodCategory;
  if (c === 'out_of_service') return 'oos';
  if (c === 'obs_not_current' || gaugeObsStale(g)) return 'stale';
  if (c === 'not_defined') return 'nothresh';
  return gaugeObsCat(g);
}
const gaugeAll = () => state.gauges.concat(state.gaugesDegraded || []);
function gaugeStateCounts() {
  const n = {};
  for (const s of GAUGE_STATES) n[s] = 0;
  for (const g of gaugeAll()) n[gaugeState(g)]++;
  return n;
}

const riverOf = (name) => String(name || '').split(/ (?:at|near|below|above) /)[0];

function gaugeForecastCat(g) {
  const c = g.status && g.status.forecast && g.status.forecast.floodCategory;
  return FLOOD_CATS.includes(c) ? c : null;
}

function gaugeRising(g) {
  if (gaugeDegraded(g)) return false; // no severity to rise from, whatever the forecast field says
  if (gaugeObsStale(g)) return false; // no trustworthy baseline — keep dead gauges out of rising/record-watch
  const f = gaugeForecastCat(g);
  if (f === null) return false;
  const vt = g.status.forecast && g.status.forecast.validTime;
  if (!vt || new Date(vt) <= new Date()) return false; // a crest already past is not rising
  return CAT_RANK[f] > CAT_RANK[gaugeCat(g)];
}

// crest-of-record context (data/records.json = NWPS historic crests). Honest by design:
// reports the forecast's margin to the all-time crest, never claims a break unless fcst ≥ record.
const RECORD_NEAR_FT = 5;
function recordContext(g) {
  if (gaugeDegraded(g)) return null; // its forecast is not current either: no margin to report off it
  const rec = state.records && state.records[g.lid];
  const f = g.status && g.status.forecast;
  if (!rec || !f || !(f.primary > 0) || !(rec.record_ft > 0)) return null;
  const margin = +(rec.record_ft - f.primary).toFixed(1); // >0 fcst below record, ≤0 at/above
  const year = (rec.record_date || '').slice(0, 4);
  return { recFt: rec.record_ft, year, margin, atOrAbove: margin <= 0, near: margin > 0 && margin <= RECORD_NEAR_FT };
}
// gauges whose forecast is within RECORD_NEAR_FT of (or above) their crest of record
function recordWatchGauges() {
  return state.gauges.filter((g) => {
    if (!gaugeRising(g)) return false;
    const rc = recordContext(g);
    return rc && (rc.atOrAbove || rc.near);
  });
}

/* observed trend: accumulated across refreshes in localStorage — no extra API calls */
const TREND_KEY = 'respondertx.trend.v1';
function recordTrends() {
  const hist = state.trendHist;
  const cutoff = Date.now() - 2 * 3600000;
  for (const g of state.gauges) {
    const o = g.status.observed;
    if (!(o.primary > -999) || !o.validTime) continue;
    const t = Date.parse(o.validTime);
    const arr = hist[g.lid] = (hist[g.lid] || []).filter((p) => p[0] >= cutoff);
    if (!arr.length || arr[arr.length - 1][0] < t) arr.push([t, o.primary]);
  }
  try { localStorage.setItem(TREND_KEY, JSON.stringify(hist)); } catch { /* quota — trend is best-effort */ }
}
function gaugeTrend(lid) {
  const arr = (state.trendHist[lid] || []).filter((p) => p[0] >= Date.now() - 75 * 60000);
  if (arr.length < 2) return null;
  const dtH = (arr[arr.length - 1][0] - arr[0][0]) / 3600000;
  if (dtH < 0.25) return null;
  const rate = (arr[arr.length - 1][1] - arr[0][1]) / dtH;
  return { rate, dir: rate > 0.2 ? 'up' : rate < -0.2 ? 'down' : 'steady' };
}

// recovery lens (?view=recovery): classify a crest-summary row against its live gauge.
// 'receded' = flooded during the event window, now below flood stage; 'falling' = still
// in flood with real falling evidence (trend down, off-crest, or forecast below current cat)
const RECOVERY_OFF_CREST_FT = 0.5;
function gaugeRecoveryState(row, live, trend) {
  if (!row || row.stale) return null;
  if (live && gaugeObsStale(live)) return null; // dead sensor: no honest current reading
  const liveCat = live ? gaugeCat(live) : null;
  if (!row.ongoing) return (liveCat && liveCat !== 'none') ? null : 'receded'; // re-risen gauges drop out
  if (!live || gaugeRising(live)) return null;
  if (trend && trend.dir === 'down') return 'falling';
  const o = live.status.observed.primary;
  if (Number.isFinite(o) && Number.isFinite(row.peak) && new Date(row.peak_time) < new Date()
    && o <= row.peak - RECOVERY_OFF_CREST_FT) return 'falling';
  const fc = live.status.forecast || {};
  const fRank = fc.floodCategory === 'no_flooding' ? CAT_RANK.none
    : FLOOD_CATS.includes(fc.floodCategory) ? CAT_RANK[fc.floodCategory] : null;
  if (fRank !== null && fc.validTime && new Date(fc.validTime) > new Date() && fRank < CAT_RANK[liveCat]) return 'falling';
  return null;
}

/* ---------- basin focus (?view=basin) — pure corridor helpers ---------- */

const riverSlug = (river) => String(river || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// crest time for corridor sequencing: an observed peak (crest-summary row) wins over a
// forecast crest; stale sensors contribute nothing (their timing is not trustworthy)
function basinCrestTime(g, row) {
  if (gaugeObsStale(g)) return null;
  if (row && !row.stale && row.peak_time) {
    const pt = Date.parse(row.peak_time);
    if (Number.isFinite(pt)) return pt;
  }
  const f = g.status && g.status.forecast;
  if (f && Number.isFinite(f.primary) && f.primary > -999 && f.validTime) {
    const ft = Date.parse(f.validTime);
    if (Number.isFinite(ft) && ft > 0) return ft; // NWPS "no current forecast" carries year 0001
  }
  return null;
}

// A point rides the wave only when its crest is material: an observed in-flood peak, a
// forecast at/above action stage, or a forecast rise of >= 0.5 ft. NWPS publishes a
// "forecast crest" (trace maximum) for flat quiet rivers too; calling that a wave would
// fabricate motion on a quiet reach.
const BASIN_WAVE_RISE_FT = 0.5;
function basinWaveState(g, row, nowMs) {
  const now = nowMs || Date.now();
  const crestT = basinCrestTime(g, row);
  if (crestT == null) return { crestT: null, wave: 'none' };
  if (row && !row.stale && row.peak_time && Date.parse(row.peak_time) <= now) return { crestT, wave: 'passed' };
  const f = (g.status && g.status.forecast) || {};
  const o = (g.status && g.status.observed) || {};
  const material = !!gaugeForecastCat(g)
    || (Number.isFinite(f.primary) && Number.isFinite(o.primary) && o.primary > -999 && f.primary - o.primary >= BASIN_WAVE_RISE_FT);
  if (!material) return { crestT, wave: 'none' };
  return { crestT, wave: crestT <= now ? 'passed' : 'coming' };
}

// Corridor order: project gauges onto their best-fit straight axis (lon scaled by cos(lat)
// so east-west distances are honest), then orient it downstream. Direction comes from crest
// timing when >=2 points have it (a crest arrives later downstream — the wave-tracker
// premise); otherwise seaward (SE, toward the Gulf) as an estimate the view must caveat.
// `mismatch` flags a reach where crest sequence and gauge geometry disagree.
function basinCorridor(gauges, crestTimes) {
  const pts = (gauges || []).filter((g) => Number.isFinite(g.latitude) && Number.isFinite(g.longitude));
  if (pts.length <= 1) return { order: pts, basis: 'single', mismatch: false };
  const mLat = pts.reduce((s, g) => s + g.latitude, 0) / pts.length;
  const mLon = pts.reduce((s, g) => s + g.longitude, 0) / pts.length;
  const kx = Math.cos(mLat * Math.PI / 180);
  let sxx = 0, sxy = 0, syy = 0;
  for (const g of pts) {
    const x = (g.longitude - mLon) * kx, y = g.latitude - mLat;
    sxx += x * x; sxy += x * y; syy += y * y;
  }
  const half = (sxx + syy) / 2;
  const l1 = half + Math.sqrt(Math.max(0, half * half - (sxx * syy - sxy * sxy)));
  let ax = sxy, ay = l1 - sxx;
  if (Math.abs(ax) < 1e-12 && Math.abs(ay) < 1e-12) { ax = 1; ay = 0; }
  const proj = new Map();
  for (const g of pts) proj.set(g.lid, ((g.longitude - mLon) * kx) * ax + (g.latitude - mLat) * ay);
  const ct = crestTimes || {};
  const timed = pts.filter((g) => Number.isFinite(ct[g.lid]));
  let basis = 'geo', flip = false;
  if (timed.length >= 2) {
    const tMean = timed.reduce((s, g) => s + ct[g.lid], 0) / timed.length;
    const pMean = timed.reduce((s, g) => s + proj.get(g.lid), 0) / timed.length;
    let cov = 0;
    for (const g of timed) cov += (ct[g.lid] - tMean) * (proj.get(g.lid) - pMean);
    if (cov !== 0) { basis = 'crest'; flip = cov < 0; }
  }
  if (basis === 'geo') flip = (ax - ay) < 0; // seaward estimate: Texas rivers run SE to the Gulf
  const order = pts.slice().sort((a, b) => (flip ? proj.get(b.lid) - proj.get(a.lid) : proj.get(a.lid) - proj.get(b.lid)));
  let mismatch = false;
  const seq = order.filter((g) => Number.isFinite(ct[g.lid])).map((g) => ct[g.lid]);
  for (let i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1] - 3600000) mismatch = true; // near-equal times are noise, not disagreement
  return { order, basis, mismatch };
}

// River picker inventory, most-active first: any in-flood/rising/receding gauge now, then
// crested-this-event, then quiet; ties by worst category, gauge count, name.
function basinRivers(gauges, crestRows) {
  const byRiver = {};
  for (const g of (gauges || [])) {
    const r = riverOf(g.name);
    if (!r) continue;
    (byRiver[r] = byRiver[r] || []).push(g);
  }
  const rows = crestRows || {};
  return Object.keys(byRiver).map((river) => {
    const gs = byRiver[river];
    let worst = 0, active = false, crested = false;
    for (const g of gs) {
      const cat = gaugeCat(g);
      if (cat !== 'none' || gaugeRising(g)) active = true;
      const fRank = gaugeRising(g) ? (CAT_RANK[gaugeForecastCat(g)] || 0) : 0;
      worst = Math.max(worst, CAT_RANK[cat] || 0, fRank);
      const row = rows[g.lid];
      if (row && !row.stale) crested = true;
    }
    return { river, slug: riverSlug(river), gauges: gs, active, crested, worst, coastal: /^tide /i.test(river) };
  }).sort((a, b) => (b.active - a.active) || (b.crested - a.crested) || (b.worst - a.worst)
    || (b.gauges.length - a.gauges.length) || a.river.localeCompare(b.river));
}

function renderGauges() {
  state.layers.gauges.clearLayers();
  state.gaugeMarkers = {};
  // ?hydro=<lid> deep link — open the full hydrograph once its gauge is loaded (once)
  if (state.pendingHydro) {
    const g = state.gauges.find((x) => x.lid === state.pendingHydro);
    if (g) { state.pendingHydro = null; openHydro(g); }
  }
  for (const g of gaugeAll()) {
    const gs = gaugeState(g);
    if (!gaugeStateShown(gs)) continue; // hidden by its legend row
    const degraded = GAUGE_DEGRADED.includes(gs);
    const cat = gaugeCat(g);
    const rising = !degraded && gaugeRising(g);
    const size = degraded ? 11 : CAT_SIZE[cat];
    const trend = degraded ? null : gaugeTrend(g.lid);
    const falling = cat !== 'none' && trend && trend.dir === 'down';
    // 32px hit area around the visual dot — 8-18px dots are untappable one-thumbed (UX audit #5)
    const icon = L.divIcon({
      className: '',
      html: `<div class="gauge-hit${(cat === 'none' && !degraded) || gs === 'nothresh' ? ' hit-none' : ''}">` +
        `<div class="gauge-icon ${degraded ? `deg-${gs}` : `cat-${cat}`}" style="width:${size}px;height:${size}px"></div>` +
        (rising ? `<span class="rise-arrow cat-${gaugeForecastCat(g)}">▲</span>` : '') +
        (falling ? '<span class="fall-arrow">▼</span>' : '') + '</div>',
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
    const m = L.marker([g.latitude, g.longitude], { icon, zIndexOffset: cat === 'major' ? 1000 : rising ? 500 : 0 });
    m.bindPopup(() => gaugePopup(g), { minWidth: 290 });
    state.layers.gauges.addLayer(m);
    state.gaugeMarkers[g.lid] = m;
  }
  if (typeof renderMapLegend === 'function') renderMapLegend(); // counts move with the data
  if (typeof basinApplyHighlight === 'function') basinApplyHighlight(); // re-render dropped the corridor rings
}

/* NWPS ships a disabled or never-reporting site as primary -999 at validTime year 0001. Printing
   that is worse than printing nothing, so every reading surface gates on this. */
function gaugeHasReading(g) {
  const o = (g.status && g.status.observed) || {};
  if (!(o.primary > -999) || !o.validTime) return false;
  const ts = Date.parse(o.validTime);
  return Number.isFinite(ts) && ts > Date.parse('1900-01-01T00:00:00Z');
}

function gaugePopup(g) {
  const o = g.status.observed;
  const gs = gaugeState(g);
  const stale = gaugeObsStale(g);
  const hasRead = gaugeHasReading(g);
  const cat = gaugeObsCat(g);
  const el = document.createElement('div');
  const f = g.status.forecast;
  const fCat = gaugeForecastCat(g);
  const forecastLine = fCat
    ? `<div class="popup-meta">${gaugeRising(g) ? `▲ ${esc(t('gauge.rising'))} · ` : ''}${esc(t('word.forecast'))}: ${fmtNum(f.primary)} ${esc(f.primaryUnit)} · <span class="cat-word" style="color:var(--cat-${fCat})">${esc(catLabel(fCat))}</span> @ ${esc(fmtWhen(f.validTime))}</div>`
    : '';
  const tr = gaugeTrend(g.lid);
  const trendLine = tr
    ? `<div class="popup-meta">${esc(t('gauge.trendlbl'))}: ${tr.rate >= 0 ? '+' : ''}${tr.rate.toFixed(1)} ft/hr ${tr.dir === 'up' ? '↑' : tr.dir === 'down' ? '↓' : `→ ${esc(t('trend.steady'))}`} ${esc(t('gauge.lasthour'))}</div>`
    : '';
  const degraded = GAUGE_DEGRADED.includes(gs);
  // an out-of-service sensor gets a sentence where the chart goes, never a chart over dead data
  const noChart = gs === 'oos';
  const headLine = degraded
    ? `<div class="popup-meta"><span class="cat-word deg-word">${esc(gaugeStateLabel(gs))}</span>` +
      (hasRead ? ` · ${fmtNum(o.primary)} ${esc(o.primaryUnit)} @ ${esc(fmtWhen(o.validTime))}` : '') + '</div>' +
      `<div class="popup-meta stale-note">${esc(t('gstate.' + gs + '.note'))}</div>`
    : `<div class="popup-meta"><span class="cat-word" style="color:var(--cat-${stale ? 'none' : cat})">${esc(catLabel(cat))}</span> · ${fmtNum(o.primary)} ${esc(o.primaryUnit)} @ ${esc(fmtWhen(o.validTime))}</div>` +
      (stale ? `<div class="popup-meta stale-note">⏱ ${esc(t('gauge.stale').replace('{t}', fmtWhen(o.validTime)))}</div>` : '');
  el.innerHTML = `<div class="popup-title">${esc(g.name)}</div>` +
    headLine +
    trendLine +
    forecastLine +
    (noChart
      ? `<div class="popup-spark spark-off"><div class="spark-note">${esc(t('spark.oos'))}</div></div>`
      : `<div class="popup-spark"><canvas width="270" height="80"></canvas><div class="spark-note">${esc(t('spark.loading').replace('{h}', CONFIG.sparkHours))}</div></div>`) +
    `<button class="popup-expand" data-lid="${esc(g.lid)}">${esc(t('hydro.open'))}</button>` +
    `<button class="popup-expand open-in-gauges">${esc(t('sync.opengauges'))}</button>` +
    `<button class="popup-expand basin-link">🏞 ${esc(t('basin.popup').replace('{river}', riverOf(g.name)))}</button>` +
    (typeof pushManageAvailable === 'function' && pushManageAvailable()
      ? `<button class="popup-expand push-notify-btn" data-lid="${esc(g.lid)}">🔔 ${esc(t('push.notify'))}</button>` : '') +
    `<div class="popup-link"><a href="https://water.noaa.gov/gauges/${esc(g.lid)}" target="_blank" rel="noopener">${esc(t('gauge.noaapage'))}</a></div>`;
  if (!noChart) drawSparkline(g, el.querySelector('canvas'), el.querySelector('.spark-note'));
  el.querySelector('.popup-expand').addEventListener('click', () => openHydro(g));
  el.querySelector('.open-in-gauges').addEventListener('click', () => openInGaugesList(g.lid));
  el.querySelector('.basin-link').addEventListener('click', () => openBasinView(riverSlug(riverOf(g.name))));
  const nb = el.querySelector('.push-notify-btn');
  if (nb) nb.addEventListener('click', () => pushOpenManageFor(g.lid));
  // eyes-on pairing: a HIVIS cam within 2 km gets a view link (inventory lazy-loads on first popup)
  loadCameras().then(() => {
    const cam = nearestRiverCam(g.latitude, g.longitude, 2);
    if (!cam || !el.isConnected || el.querySelector('.cam-gauge-link')) return;
    const btn = document.createElement('button');
    btn.className = 'popup-expand cam-gauge-link';
    btn.textContent = `${t('cam.rivercam')} · ${t('cam.view')}`;
    btn.addEventListener('click', () => openCamViewer(cam, 'river'));
    el.insertBefore(btn, el.querySelector('.popup-link'));
  }).catch(() => { /* inventory unavailable — popup simply lacks the cam link */ });
  return el;
}

// full-screen hydrograph: observed history + forecast trace + flood-stage bands + crest-of-record line
async function openHydro(g) {
  $('#hydro-modal').hidden = false;
  $('#hydro-title').textContent = g.name;
  const note = $('#hydro-note');
  const cv = $('#hydro-canvas');
  const legend = $('#hydro-legend');
  cv.hidden = false;
  // out of service: no chart at all. A hydrograph of a disabled sensor is a picture of nothing.
  if (gaugeState(g) === 'oos') {
    cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    cv.hidden = true;
    legend.innerHTML = '';
    note.textContent = t('hydro.oos');
    return;
  }
  note.textContent = t('hydro.loading');
  try {
    const [detail, obs, fcst] = await Promise.all([
      gaugeJson(g.lid, 'detail', `${CONFIG.nwpsBase}/gauges/${g.lid}`),
      gaugeJson(g.lid, 'series', `${CONFIG.nwpsBase}/gauges/${g.lid}/stageflow/observed`),
      cachedJson(`${CONFIG.nwpsBase}/gauges/${g.lid}/stageflow/forecast`).catch(() => null), // E1: null = unanswered, not an empty forecast
    ]);
    drawHydro(g, detail, obs.data || [], fcst);
  } catch { note.textContent = t('hydro.unavail'); }
}

function drawHydro(g, detail, obsData, fcstRes) {
  const fcstFailed = !fcstRes; // the forecast request did not answer; its absence is not a flat river
  const fcstData = fcstRes && Array.isArray(fcstRes.data) ? fcstRes.data : [];
  const now = Date.now();
  const back = now - 24 * 3600000; // 24h observed history
  const obs = obsData.filter((p) => new Date(p.validTime).getTime() >= back && p.primary > -999)
    .map((p) => ({ t: new Date(p.validTime).getTime(), v: p.primary }));
  const fcst = fcstData.filter((p) => p.primary > -999).map((p) => ({ t: new Date(p.validTime).getTime(), v: p.primary }));
  if (obs.length < 2 && fcst.length < 2) { $('#hydro-note').textContent = t('hydro.nodata'); return; }
  const cats = (detail.flood && detail.flood.categories) || {};
  const stages = FLOOD_CATS.map((c) => ({ c, v: cats[c] && cats[c].stage })).filter((s) => s.v > 0);
  const rec = state.records && state.records[g.lid];
  const allV = obs.concat(fcst).map((p) => p.v).concat(stages.map((s) => s.v)).concat(rec ? [rec.record_ft] : []);
  const allT = obs.concat(fcst).map((p) => p.t);
  const minV = Math.min(...allV), maxV = Math.max(...allV), padV = (maxV - minV) * 0.08 || 1;
  const minT = Math.min(...allT), maxT = Math.max(...allT);
  const cv = $('#hydro-canvas'), ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height, mL = 46, mR = 16, mT = 16, mB = 34;
  const x = (t) => mL + ((t - minT) / (maxT - minT || 1)) * (W - mL - mR);
  const y = (v) => H - mB - ((v - (minV - padV)) / ((maxV + padV) - (minV - padV))) * (H - mT - mB);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = cssVar('--surface-1'); ctx.fillRect(0, 0, W, H);

  // flood-stage bands (translucent) + labels
  const bandTop = { major: maxV + padV, moderate: cats.major && cats.major.stage, minor: cats.moderate && cats.moderate.stage, action: cats.minor && cats.minor.stage };
  for (const s of stages) {
    const top = bandTop[s.c] || (maxV + padV);
    ctx.fillStyle = cssVar(`--cat-${s.c}`) + '22';
    ctx.fillRect(mL, y(top), W - mL - mR, y(s.v) - y(top));
    ctx.strokeStyle = cssVar(`--cat-${s.c}`); ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(mL, y(s.v)); ctx.lineTo(W - mR, y(s.v)); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = cssVar(`--cat-${s.c}`); ctx.font = '11px system-ui';
    ctx.fillText(`${s.c} ${s.v}ft`, mL + 4, y(s.v) - 3);
  }
  // record-of-crest line
  if (rec && rec.record_ft > 0) {
    ctx.strokeStyle = cssVar('--ink-1'); ctx.lineWidth = 1.5; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.moveTo(mL, y(rec.record_ft)); ctx.lineTo(W - mR, y(rec.record_ft)); ctx.stroke();
    ctx.setLineDash([]); ctx.fillStyle = cssVar('--ink-1'); ctx.font = 'bold 11px system-ui';
    ctx.fillText(`⚑ ${t('hydro.recline')} ${rec.record_ft}ft (${(rec.record_date || '').slice(0, 4)})`, mL + 4, y(rec.record_ft) - 3);
  }
  // now marker
  if (now >= minT && now <= maxT) {
    ctx.strokeStyle = cssVar('--ink-muted'); ctx.lineWidth = 1; ctx.setLineDash([1, 3]);
    ctx.beginPath(); ctx.moveTo(x(now), mT); ctx.lineTo(x(now), H - mB); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = cssVar('--ink-muted'); ctx.font = '10px system-ui'; ctx.fillText('now', x(now) + 3, mT + 10);
  }
  // axes: y ticks + x day/hour ticks
  ctx.fillStyle = cssVar('--ink-2'); ctx.font = '10px system-ui'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) { const v = (minV - padV) + (i / 4) * ((maxV + padV) - (minV - padV)); ctx.fillText(v.toFixed(0), mL - 4, y(v) + 3); }
  ctx.textAlign = 'center';
  for (let i = 0; i <= 4; i++) { const t = minT + (i / 4) * (maxT - minT); ctx.fillText(new Date(t).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'numeric', day: 'numeric', hour: 'numeric' }), x(t), H - mB + 16); }
  ctx.textAlign = 'left';
  // observed (solid accent) + forecast (dashed purple)
  const drawTrace = (pts, color, dash) => {
    if (pts.length < 2) return; ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.lineJoin = ctx.lineCap = 'round'; ctx.setLineDash(dash);
    ctx.beginPath(); pts.forEach((p, i) => { i ? ctx.lineTo(x(p.t), y(p.v)) : ctx.moveTo(x(p.t), y(p.v)); }); ctx.stroke(); ctx.setLineDash([]);
  };
  drawTrace(obs, cssVar('--accent'), []);
  if (obs.length && fcst.length) fcst.unshift(obs[obs.length - 1]); // join obs→forecast
  drawTrace(fcst, cssVar('--cat-major'), [6, 4]);

  $('#hydro-legend').innerHTML =
    `<span class="hl"><i style="background:var(--accent)"></i>${esc(t('hydro.obs'))}</span>` +
    // the legend names a trace only when one was drawn, and says so when the forecast never answered
    (fcst.length ? `<span class="hl"><i style="background:var(--cat-major)"></i>${esc(t('word.forecast').toLowerCase())}</span>` : '') +
    (fcstFailed ? `<span class="hl stale-note">${esc(t('hydro.fcstfail'))}</span>` : '') +
    (rec ? `<span class="hl"><i class="dashed"></i>${esc(t('hydro.recline'))}</span>` : '') +
    // only claim bands when bands were actually drawn
    (stages.length ? `<span class="hl">${esc(t('hydro.shaded'))}</span>` : `<span class="hl">${esc(t('hydro.nobands'))}</span>`);
  // a trace that stops hours short of NOW must say so on the chart, not leave the gap to be read as flat water
  const lastObs = obs.length ? obs[obs.length - 1].t : null;
  const endsEarly = lastObs && (now - lastObs) > CONFIG.gaugeStaleHours * 3600000;
  $('#hydro-note').innerHTML = (endsEarly ? `<span class="stale-note">${esc(t('hydro.ends').replace('{t}', fmtWhen(new Date(lastObs).toISOString())))}</span> · ` : '') +
    `${esc(t('hydro.note'))} · <a href="https://water.noaa.gov/gauges/${esc(g.lid)}" target="_blank" rel="noopener">${esc(t('gauge.noaapage2'))}</a>` +
    (typeof pushManageAvailable === 'function' && pushManageAvailable()
      ? ` · <a href="#" id="hydro-notify">🔔 ${esc(t('push.notify'))}</a>` : '');
  const hn = $('#hydro-notify');
  if (hn) {
    hn.addEventListener('click', (e) => {
      e.preventDefault();
      $('#hydro-modal').hidden = true;
      pushOpenManageFor(g.lid);
    });
  }
}

// 3-min TTL promise cache — popup close/reopen redraws instantly; failures evict so retry works
const sparkCache = new Map();
function cachedJson(url, ttlMs = 180000) {
  const hit = sparkCache.get(url);
  if (hit && Date.now() - hit.t < ttlMs) return hit.p;
  const p = fetch(url).then((r) => okJson(r, 'gauge json'));
  sparkCache.set(url, { t: Date.now(), p });
  p.catch(() => sparkCache.delete(url));
  return p;
}

// same-origin /api/gauge proxy (CF edge / server.py, both 3-min cached) first; direct NOAA on miss
function gaugeJson(lid, kind, directUrl) {
  return cachedJson(`api/gauge/${lid}/${kind}`).catch(() => cachedJson(directUrl));
}

async function drawSparkline(g, canvas, note) {
  try {
    const [detail, series] = await Promise.all([
      gaugeJson(g.lid, 'detail', `${CONFIG.nwpsBase}/gauges/${g.lid}`),
      gaugeJson(g.lid, 'series', `${CONFIG.nwpsBase}/gauges/${g.lid}/stageflow/observed`),
    ]);
    const cutoff = Date.now() - CONFIG.sparkHours * 3600000;
    // E1: a body with no series did not answer, so it must reach the catch as "unavailable"
    // rather than fall through to "no recent readings" for a gauge that may well have them
    let pts = okList(series, 'data', 'gauge series').filter((p) => new Date(p.validTime).getTime() >= cutoff && p.primary > -999);
    if (pts.length < 2) { note.textContent = t('spark.nodata'); return; }
    const step = Math.max(1, Math.floor(pts.length / 220));
    pts = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);

    const cats = (detail.flood && detail.flood.categories) || {};
    const stages = FLOOD_CATS.map((c) => ({ c, v: cats[c] && cats[c].stage })).filter((s) => s.v > 0);
    const vals = pts.map((p) => p.primary).concat(stages.map((s) => s.v));
    const min = Math.min(...vals), max = Math.max(...vals);
    const pad = (max - min) * 0.1 || 1;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height, mL = 4, mR = 40, mT = 6, mB = 6;
    const x = (i) => mL + (i / (pts.length - 1)) * (W - mL - mR);
    const y = (v) => H - mB - ((v - (min - pad)) / ((max + pad) - (min - pad))) * (H - mT - mB);
    ctx.clearRect(0, 0, W, H);

    for (const s of stages) {
      ctx.strokeStyle = cssVar(`--cat-${s.c}`);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(mL, y(s.v)); ctx.lineTo(W - mR, y(s.v)); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = cssVar('--accent');
    ctx.lineWidth = 2;
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => { i ? ctx.lineTo(x(i), y(p.primary)) : ctx.moveTo(x(i), y(p.primary)); });
    ctx.stroke();

    const last = pts[pts.length - 1];
    ctx.fillStyle = cssVar('--accent');
    ctx.strokeStyle = cssVar('--surface-1');
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x(pts.length - 1), y(last.primary), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = cssVar('--ink-1');
    ctx.font = '11px system-ui';
    ctx.fillText(`${last.primary} ft`, W - mR + 4, y(last.primary) + 4);
    // the terminal value label is the strongest current-level claim in the app; hedge it the moment
    // the trace stops short of now, and never promise stage lines that were not drawn
    const lastT = new Date(last.validTime).getTime();
    const endsEarly = Number.isFinite(lastT) && (Date.now() - lastT) > CONFIG.gaugeStaleHours * 3600000;
    note.textContent = endsEarly
      ? t('spark.ends').replace('{t}', fmtWhen(last.validTime))
      : (stages.length ? t('spark.legend') : t('spark.legend.nobands')).replace('{h}', CONFIG.sparkHours);
    note.classList.toggle('stale-note', !!endsEarly);
  } catch { note.textContent = t('spark.unavail'); }
}

/* ---------- RFC forecast-max crests (5-day max stage per gauge) ---------- */

function inGaugeBbox(lat, lon) {
  const b = CONFIG.gaugeBbox;
  return lat >= b.ymin && lat <= b.ymax && lon >= b.xmin && lon <= b.xmax;
}

// issued_time is "YYYY-MM-DD HH:MM:SS UTC", not ISO
const fcstIssuedIso = (t) => String(t || '').replace(' ', 'T').replace(' UTC', 'Z');

async function fetchFcstMax() {
  const params = new URLSearchParams({
    where: "nws_lid LIKE '%T2' AND max_status NOT IN ('no_flooding','not_defined')",
    outFields: 'nws_lid,nws_name,max_value,max_status,issued_time',
    returnGeometry: 'true',
    f: 'geojson',
  });
  const res = await fetch(`${CONFIG.fcstMaxUrl}?${params}`);
  const data = await okJson(res, 'RFC fcst');
  // NWPS gauges already show their own forecast — keep only lids this board lacks
  const nwpsLids = new Set(state.gauges.map((g) => g.lid));
  // E1: an ArcGIS error body must not publish as zero forecast flood points
  state.fcstMax = okList(data, 'features', 'RFC fcst').filter((f) => {
    if (!f.geometry || !Array.isArray(f.geometry.coordinates)) return false;
    const [lon, lat] = f.geometry.coordinates;
    return inGaugeBbox(lat, lon) && !nwpsLids.has(f.properties.nws_lid);
  });
  markHealthy('fcstMax');
  renderFcstMax();
}

function renderFcstMax() {
  state.layers.fcstMax.clearLayers();
  for (const f of state.fcstMax) {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const cat = FLOOD_CATS.includes(p.max_status) ? p.max_status : 'none';
    const size = CAT_SIZE[cat];
    const icon = L.divIcon({
      className: '',
      html: `<div class="gauge-hit"><div class="fcst-ring cat-${cat}" style="width:${size}px;height:${size}px"></div></div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
    const m = L.marker([lat, lon], { icon });
    m.bindPopup(`<div class="popup-title">${esc(p.nws_name)}</div>` +
      `<div class="popup-meta">${esc(t('fcstmax.lbl'))}: ${fmtNum(p.max_value)} ft · <span class="cat-word" style="color:var(--cat-${cat})">${esc(catLabel(cat))}</span> (${esc(t('fcstmax.window'))})</div>` +
      `<div class="popup-meta">${esc(t('fcstmax.issued'))} ${esc(fmtWhen(fcstIssuedIso(p.issued_time)))}</div>` +
      `<div class="popup-link"><a href="https://water.noaa.gov/gauges/${esc(p.nws_lid)}" target="_blank" rel="noopener">${esc(t('gauge.noaapage2'))}</a></div>`);
    state.layers.fcstMax.addLayer(m);
  }
}

/* ---------- USGS instantaneous values (raw stage — no flood-stage context) ---------- */

// one tiled sub-request; the AO is far past what WaterServices accepts in a single bBox
async function fetchUsgsTile(tile) {
  const url = `${CONFIG.usgsIvBase}?format=json&parameterCd=00065&modifiedSince=PT2H`
    + `&bBox=${tile.xmin},${tile.ymin},${tile.xmax},${tile.ymax}`;
  const res = await fetch(url);
  const data = await okJson(res, 'USGS IV');
  const sites = [];
  // E1: a tile whose body has no timeSeries did not answer, so it must fail rather than
  // count as a tile that legitimately holds no sites
  for (const ts of okList(data, 'value.timeSeries', 'USGS IV')) {
    const si = ts.sourceInfo;
    const vals = ts.values && ts.values[0] && ts.values[0].value;
    const last = vals && vals[vals.length - 1];
    if (!last) continue;
    const ft = parseFloat(last.value);
    if (!Number.isFinite(ft) || ft <= -999) continue;
    const loc = si.geoLocation.geogLocation;
    sites.push({ site: si.siteCode[0].value, name: si.siteName, lat: loc.latitude, lon: loc.longitude, ft, t: last.dateTime });
  }
  return sites;
}

const usgsWait = (ms) => new Promise((r) => { setTimeout(r, ms); });

// stagger the burst, then allow one retry; a second failure is what makes a sweep partial
async function fetchUsgsTileRetry(tile, slot) {
  if (slot && CONFIG.usgsTileStaggerMs) await usgsWait(slot * CONFIG.usgsTileStaggerMs);
  try {
    return await fetchUsgsTile(tile);
  } catch {
    await usgsWait(CONFIG.usgsRetryMs);
    return fetchUsgsTile(tile);
  }
}

async function fetchUsgsIv() {
  if (state.usgsFetchedAt && Date.now() - state.usgsFetchedAt < CONFIG.usgsMinIntervalMs) return;
  const tiles = usgsBboxTiles(CONFIG.gaugeBbox);
  if (!tiles.length) throw new Error('USGS IV: gaugeBbox yields no queryable tile');
  const results = await Promise.allSettled(tiles.map((tile, i) => fetchUsgsTileRetry(tile, i)));
  const ok = results.filter((r) => r.status === 'fulfilled');
  if (!ok.length) throw new Error(`USGS IV: all ${tiles.length} sub-requests failed`);
  const sites = usgsMergeSites(ok.map((r) => r.value));
  state.usgsFetchedAt = Date.now();
  // NWPS gauges carry flood categories — keep USGS to the sites NWPS lacks
  state.usgsSites = sites.filter((s) => !state.gauges.some((g) => distMi(s.lat, s.lon, g.latitude, g.longitude) < 0.3));
  state.usgsPartial = ok.length < tiles.length;
  // a short sweep is never stamped healthy: the chip keeps ageing until a whole pass lands
  if (!state.usgsPartial) markHealthy('usgs');
  renderUsgsIv();
}

function renderUsgsIv() {
  state.layers.usgs.clearLayers();
  for (const s of state.usgsSites) {
    const icon = L.divIcon({ className: '', html: '<div class="usgs-dot"></div>', iconSize: [24, 24], iconAnchor: [12, 12] });
    const m = L.marker([s.lat, s.lon], { icon });
    // raw stage has no flood-stage thresholds here — never imply a category
    m.bindPopup(`<div class="popup-title">${esc(s.name)}</div>` +
      `<div class="popup-meta">${esc(t('usgs.stage').replace('{v}', s.ft).replace('{t}', fmtWhen(s.t)))}</div>` +
      (state.usgsPartial ? `<div class="popup-meta">${esc(t('usgs.partial'))}</div>` : '') +
      `<div class="popup-link"><a href="https://waterdata.usgs.gov/monitoring-location/${esc(s.site)}" target="_blank" rel="noopener">${esc(t('usgs.link'))}</a></div>`);
    state.layers.usgs.addLayer(m);
  }
}

/* ---------- TDEM DriveTexas live road conditions (closed / high-water / damage) ---------- */

const ROAD_ATTRIB = 'Road conditions: TxDOT DriveTexas / TDEM (drivetexas.org)';
// ArcGIS truncation signal, shared by the DriveTexas and TxGIO queries below: top level in
// GeoJSON output, nested under properties in other builds of the service
const arcgisHasMore = (d) => Boolean(d && (d.exceededTransferLimit || (d.properties && d.properties.exceededTransferLimit)));
const ROAD_PAGE = 2000; // the service's own maxRecordCount
const ROAD_MAX_PAGES = 8; // runaway guard; the statewide set runs in the tens even in a major event
// Closure + Flooding are prominent reds; Damage a distinct amber. Construction/Accident excluded server-side.
const ROAD_COND = {
  Closure: { key: 'road.cond.closure', color: '#e5342f' },
  Flooding: { key: 'road.cond.flooding', color: '#d81b8c' },
  Damage: { key: 'road.cond.damage', color: '#e8912b' },
};
const ROAD_COND_FALLBACK = { key: 'road.cond.other', color: '#e8912b' };
const roadLabel = (ct) => t(ct.key);
const roadCondType = (p) => ROAD_COND[p && p.condition] || ROAD_COND_FALLBACK;
const stripHtml = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
// FM0481 → "FM 481", IH0010 → "IH 10"; strips zero-padding after the letter prefix, robust fallback to trimmed original
const prettyRoute = (s) => { const m = String(s ?? '').trim().match(/^([A-Za-z]+)0*(\d.*)$/); return m ? `${m[1]} ${m[2]}` : String(s ?? '').trim(); };
// active = ongoing: keep when end_time is missing/unparseable/future, drop only when it parses to a past time (cleared)
const roadCondActive = (f) => { const e = f.properties && f.properties.end_time; if (!e) return true; const t = Date.parse(e); return !(Number.isFinite(t) && t < Date.now()); };

// [lat, lon] standing in for a closure line: the vertex nearest the driver, its midpoint with no fix
function roadPointNear(geo, pos) {
  if (!geo || !Array.isArray(geo.coordinates)) return null;
  // snapshot closures carry one vertex, not a line; without this they sort and map as unlocated
  if (geo.type === 'Point') {
    const c = geo.coordinates;
    return Number.isFinite(c[0]) && Number.isFinite(c[1]) ? [c[1], c[0]] : null;
  }
  const verts = geo.type === 'MultiLineString' ? geo.coordinates.flat() : geo.coordinates;
  let pt = null;
  if (pos) {
    let best = Infinity;
    for (const c of verts) {
      if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
      const d = distMi(pos.lat, pos.lng, c[1], c[0]);
      if (d < best) { best = d; pt = c; }
    }
  } else { pt = verts[Math.floor(verts.length / 2)]; }
  return Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1]) ? [pt[1], pt[0]] : null;
}

function roadParams(outFields) {
  const b = CONFIG.gaugeBbox;
  return new URLSearchParams({
    // exclude construction-driven closures coded as Closure/Damage (owner: flood-relevant only); null-safe keeps unlabeled closures
    where: "condition IN ('Flooding','Closure','Damage') AND (description IS NULL OR UPPER(description) NOT LIKE '%CONSTRUCTION%')",
    geometry: `${b.xmin},${b.ymin},${b.xmax},${b.ymax}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outSR: '4326',
    outFields,
    f: 'geojson',
  });
}

// every closure feature the board holds: live lines and snapshot points share one hazard set
const roadFeatures = () => (state.roadClosures ? (state.roadClosures.lines || []).concat(state.roadClosures.points || []) : []);

// Live DriveTexas first; on any failure fall back to the committed snapshot and re-throw, so the
// rows come back while feed health, the degraded note and the roads chip all still report the
// live source as down. A served fallback must never paint the source green.
async function fetchRoadClosures() {
  try {
    await fetchRoadClosuresLive();
  } catch (e) {
    await hydrateRoadsSnapshot();
    throw e;
  }
}

// paged: an unpaged query stops at the service's maxRecordCount, and every closure past that cut
// would be missing from the map and read as cleared by the reopened diff
async function fetchRoadClosuresLive() {
  const fields = 'condition,route_name,travel_direction,from_limit,to_limit,description,start_time,end_time,detour_flag,delay_flag';
  const pages = [];
  let partial = false;
  for (let page = 0; page < ROAD_MAX_PAGES; page++) {
    const qs = roadParams(fields);
    qs.set('resultRecordCount', String(ROAD_PAGE));
    qs.set('resultOffset', String(page * ROAD_PAGE));
    const res = await fetch(`${CONFIG.roadCondUrl}?${qs}`);
    const data = await okJson(res, 'DriveTexas');
    // E1: an ArcGIS error body must not read as zero closures, which the reopened diff would
    // then publish as every remembered road having reopened
    const got = okList(data, 'features', 'DriveTexas');
    pages.push(got);
    if (!got.length || !arcgisHasMore(data)) { partial = false; break; }
    partial = true; // more records remain; only survives the loop when the ceiling cuts paging short
  }
  state.roadsPartial = partial;
  if (partial) opNotice(t('road.partial'));
  // keep points: [] so renderRoadClosures's points loop stays safe (DriveTexas API is lines-only)
  state.roadClosures = { lines: [].concat(...pages).filter(roadCondActive), points: [] };
  state.roadsFallbackAt = null; // live again: stand the snapshot claim down
  state.roadsUnknown = false;
  markHealthy('roads');
  updateRoadMemory(state.roadClosures.lines, partial);
  renderRoadClosures();
  renderRoadsTab(); // live conditions are listed in Roads, not only drawn on the map
  renderReopenedMap();
  renderReopenedRoads();
  renderTiles();
}

/* Fallback to the committed snapshot the 15-minute cycle publishes, the same cold-start pattern
   hydrateGaugesSnapshot() uses for gauges. Three things this must not do: mark the live source
   healthy (it did not answer), feed the reopened diff (see updateRoadMemory), or turn an
   unreadable snapshot into an empty road network. The rows age on the snapshot's own `generated`
   stamp, never on the moment we fell back to it. */
async function hydrateRoadsSnapshot() {
  let d = null;
  try {
    d = await fetch(`data/roads-snapshot.json?_=${Date.now()}`).then((r) => (r.ok ? r.json() : null));
  } catch { d = null; } // same-origin fetch failed; handled below as unknown, never as zero closures
  const at = d && typeof d.generated === 'string' ? Date.parse(d.generated) : NaN;
  if (!d || !Array.isArray(d.roads) || !Number.isFinite(at)) {
    // E1: a failed fetch is not a value. With no snapshot the closure set is unknown, and the
    // Roads tab must say so instead of asserting that no roads are closed.
    state.roadsFallbackAt = null;
    state.roadsUnknown = true;
    renderRoadsTab();
    renderTiles();
    return false;
  }
  const stamp = new Date(at).toISOString();
  const points = d.roads.map((r) => {
    const v = Array.isArray(r.v) ? r.v : [];
    if (!Number.isFinite(v[0]) || !Number.isFinite(v[1])) return null;
    // a snapshot written before v0.99.84 archived no limits, so roadId cannot rebuild the key its
    // rows share with the live feed; _noLimits is what stops a colliding stand-in being used instead
    const limits = typeof r.from === 'string' && typeof r.to === 'string';
    return {
      // _snapshot taints the feature all the way to updateRoadMemory, which refuses to diff it
      _snapshot: true,
      properties: Object.assign({
        condition: r.cond, route_name: r.route, description: r.desc,
        start_time: r.start, end_time: r.end, _snapshot: true, _snapshotAt: stamp,
      }, limits ? { from_limit: r.from, to_limit: r.to } : { _noLimits: true }),
      geometry: { type: 'Point', coordinates: [v[1], v[0]] },
    };
  }).filter(Boolean).filter(roadCondActive);
  state.roadClosures = { lines: [], points };
  state.roadsFallbackAt = at;
  state.roadsUnknown = false;
  state.roadsPartial = false; // the snapshot generator refuses to publish a truncated capture
  renderRoadClosures();
  renderRoadsTab();
  renderTiles();
  return true;
}

/* ---------- recently-reopened roads — a closure leaving the live feed IS the recovery signal ---------- */

const ROADS_KEY = 'respondertx.roads.v2';
const ROADS_KEY_LEGACY = 'respondertx.roads.v1'; // v1 ids folded in condition; not translatable to v2, so it is discarded
const roadHash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
// identity is the physical segment: route + limits. Condition is state, so a Flooding→Damage
// re-code updates the remembered road instead of reading as a reopening; description stays out
// of the id so an edit to it never reads as one either.
const roadId = (p) => roadHash([p.route_name, p.from_limit, p.to_limit].map((v) => String(v ?? '')).join('|'));
// '' when the row's limits were never archived: no identity at all beats one that collides with
// every other closure on the route and matches nothing the live feed publishes
const roadWatchId = (p) => (!p || p._noLimits === true ? '' : roadId(p));

function roadVertex(geo) {
  if (!geo || !Array.isArray(geo.coordinates)) return null;
  const c = geo.type === 'MultiLineString' ? geo.coordinates[0] && geo.coordinates[0][0] : geo.coordinates[0];
  return Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]) ? [c[1], c[0]] : null;
}

function roadSegMiles(geo) {
  if (!geo || !Array.isArray(geo.coordinates)) return 0;
  const parts = geo.type === 'MultiLineString' ? geo.coordinates : [geo.coordinates];
  let mi = 0;
  for (const line of parts) {
    if (!Array.isArray(line)) continue;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      if (Array.isArray(a) && Array.isArray(b)) mi += distMi(a[1], a[0], b[1], b[0]);
    }
  }
  return mi;
}

// parts of a disjoint closure: roadSegMiles sums them but never bridges the gaps between them,
// so a multi-part total must say so or it reads as one continuous stretch of road
function roadSegParts(geo) {
  if (!geo || !Array.isArray(geo.coordinates)) return 0;
  if (geo.type !== 'MultiLineString') return 1;
  return geo.coordinates.filter((line) => Array.isArray(line) && line.length > 1).length;
}

const roadMemMap = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function roadMemory() {
  if (!state.roadMemory) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(ROADS_KEY) || '{}'); } catch { saved = null; }
    state.roadMemory = { seen: roadMemMap(saved && saved.seen), reopened: roadMemMap(saved && saved.reopened) };
    // v1 ids folded condition into the hash, so none of them match a v2 id. Translating them is
    // impossible (limits were never stored) and keeping them would mass-mark reopenings on the
    // first diff, so the old map is dropped: v2 rebuilds `seen` before it can report anything.
    try { localStorage.removeItem(ROADS_KEY_LEGACY); } catch { /* storage denied: the v1 map is unread either way */ }
  }
  return state.roadMemory;
}

// diff only a complete, non-empty, successful fetch. An empty response and a truncated one both
// hide live closures, so either would mark the missing segments reopened: a green recovery check
// on a road that is still under water. A partial fetch keeps the last good reopened set instead.
function updateRoadMemory(lines, partial) {
  if (!lines.length || partial) return;
  // Snapshot rows are up to 15 minutes stale, so diffing them would mark still-closed roads
  // reopened. The taint rides the feature itself so no future caller can route fallback data in here.
  if (lines.some((f) => f && f._snapshot)) return;
  const mem = roadMemory();
  const now = new Date().toISOString();
  const live = new Set();
  for (const f of lines) {
    const p = f.properties || {};
    const id = roadId(p);
    live.add(id);
    const prev = mem.seen[id];
    // sticky: a segment re-coded off Flooding (water down, road still shut) stays flood recovery
    const flood = (prev && prev.flood === true) || p.condition === 'Flooding' || FLOOD_ROAD_RE.test(p.description || '');
    mem.seen[id] = { id, route_name: p.route_name, condition: p.condition, flood, lastSeen: now, vertex: roadVertex(f.geometry) };
    delete mem.reopened[id];
  }
  for (const id of Object.keys(mem.seen)) {
    if (!live.has(id)) { mem.reopened[id] = Object.assign({}, mem.seen[id], { reopenedAt: now }); delete mem.seen[id]; }
  }
  const cutoff = Date.now() - CONFIG.histDays * 86400000;
  for (const id of Object.keys(mem.reopened)) { if (new Date(mem.reopened[id].reopenedAt).getTime() < cutoff) delete mem.reopened[id]; }
  try { localStorage.setItem(ROADS_KEY, JSON.stringify(mem)); } catch { /* quota — reopened memory is best-effort */ }
}

// suppress-not-delete: >reopenedAgeHours ages out of the default view, kept histDays behind the toggle
function reopenedRoads() {
  const all = Object.values(roadMemory().reopened).sort((a, b) => new Date(b.reopenedAt) - new Date(a.reopenedAt));
  const cut = CONFIG.reopenedAgeHours * 60;
  return { fresh: all.filter((r) => ageMins(r.reopenedAt) <= cut), aged: all.filter((r) => ageMins(r.reopenedAt) > cut) };
}

// flood-scoped everywhere reopenings render; an entry written before `flood` existed backfills from condition
const reopenIsFlood = (r) => (r.flood ?? (r.condition === 'Flooding'));

function reopenedPopupHtml(r) {
  const ct = ROAD_COND[r.condition] || ROAD_COND_FALLBACK;
  return `<div class="popup-title" style="color:var(--good)">✓ ${esc(t('reopen.flag'))}: ${esc(prettyRoute(r.route_name) || t('word.road'))}</div>` +
    `<div class="popup-meta">${esc(t('reopen.was'))}: ${esc(roadLabel(ct))} · ${esc(t('reopen.at'))} ${esc(fmtWhen(r.reopenedAt))}</div>` +
    `<div class="popup-meta" style="opacity:.7;margin-top:4px">${srcBadge('official')} ${esc(ROAD_ATTRIB)} · ${esc(t('reopen.cleared'))}</div>`;
}

function roadPopupHtml(p, geo) {
  const ct = roadCondType(p);
  const road = prettyRoute(p.route_name) || t('word.road');
  const from = p.from_limit || '';
  const to = p.to_limit || '';
  const dscr = stripHtml(p.description).replace(/^[\s–—-]+/, ''); // TxDOT feeds a leading "- " artifact; display-only strip
  const detour = Number(p.detour_flag) === 1;
  const miles = Math.round(roadSegMiles(geo));
  const parts = roadSegParts(geo);
  const seg = miles < 2 ? ''
    : parts > 1 ? t('road.seg.parts').replace('{mi}', String(miles)).replace('{n}', String(parts))
      : t('road.seg').replace('{mi}', String(miles));
  const isClosure = String(p.condition || '').toLowerCase() === 'closure';
  return `<div class="popup-title" style="color:${ct.color}">${esc(roadLabel(ct))}</div>` +
    `<div class="popup-meta"><strong>${esc(road)}</strong></div>` +
    ((from || to || seg) ? `<div class="popup-meta">${esc(from)}${from && to ? ' → ' : ''}${esc(to)}${(from || to) && seg ? ' · ' : ''}${esc(seg)}</div>` : '') +
    (dscr ? `<div class="popup-meta">${esc(dscr)}</div>` : '') +
    (p.start_time ? `<div class="popup-meta">${esc(t('road.since'))} ${esc(fmtWhen(p.start_time))}</div>` : '') +
    (detour ? `<div class="popup-meta">${esc(t('road.detour'))}</div>` : '') +
    `<div class="popup-meta" style="opacity:.8">${esc(t(isClosure ? 'road.note.closure' : 'road.note.cond'))}</div>` +
    `<div class="popup-meta" style="opacity:.7;margin-top:4px">${srcBadge('official')} ${esc(ROAD_ATTRIB)} · ` +
    `${esc(p._snapshot ? t('road.snapshot').replace('{t}', fmtWhen(p._snapshotAt)) : t('road.live'))}</div>`;
}

function renderRoadClosures() {
  const layer = state.layers.roadClosures;
  if (!layer) return;
  layer.clearLayers();
  const rc = state.roadClosures || { lines: [], points: [] };
  const attrib = state.roadsPartial ? `${ROAD_ATTRIB} · ${t('road.partial')}`
    : state.roadsFallbackAt ? `${ROAD_ATTRIB} · ${t('roads.src.snapshot')}` : ROAD_ATTRIB;
  for (const f of rc.lines) {
    if (!f.geometry) continue;
    const ct = roadCondType(f.properties);
    const gj = L.geoJSON(f, { style: { color: ct.color, weight: 5, opacity: 0.9 }, attribution: attrib });
    gj.bindPopup(roadPopupHtml(f.properties, f.geometry));
    layer.addLayer(gj);
  }
  for (const f of rc.points) {
    const c = f.geometry && f.geometry.coordinates;
    if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    const ct = roadCondType(f.properties);
    const m = L.circleMarker([c[1], c[0]], { radius: 7, color: '#fff', weight: 1.5, fillColor: ct.color, fillOpacity: 0.95, attribution: attrib });
    m.bindPopup(roadPopupHtml(f.properties));
    layer.addLayer(m);
  }
}

// recovery ✓ markers on their own opt-in layer, flood-scoped — split out of renderRoadClosures so the two toggle independently
function renderReopenedMap() {
  const layer = state.layers.roadReopen;
  if (!layer) return;
  layer.clearLayers();
  for (const r of reopenedRoads().fresh) {
    if (!r.vertex || !reopenIsFlood(r)) continue;
    // recovery badge, not a filled dot — a green ✓ road-sign shape so it never reads as a gauge/alert circle
    const icon = L.divIcon({
      className: '',
      html: '<div class="reopen-hit"><div class="reopen-icon">✓</div></div>',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
    const m = L.marker(r.vertex, { icon, attribution: ROAD_ATTRIB });
    m.bindPopup(reopenedPopupHtml(r));
    layer.addLayer(m);
  }
}

/* ---------- NOAA NHC active tropical cyclones (Esri Living Atlas): cone, track, positions, watches/warnings ---------- */

const TROPICAL_ATTRIB = 'Tropical: NOAA NHC via Esri Living Atlas';
const TROPICAL_TRACK = '#a05cff'; // storm track color (violet, distinct from road pink/red and gauge categories); works on dark + light bases
const TROPICAL_CONE_FILL = '#f4b13a'; // amber uncertainty tint
// NHC watch/warning codes → label key + color; the four wind codes match the Living Atlas renderer, SS* add storm surge
const TCWW_WW = {
  HWR: { key: 'trop.ww.HWR', color: '#ff0000' },
  TWR: { key: 'trop.ww.TWR', color: '#0000ff' },
  HWA: { key: 'trop.ww.HWA', color: '#ffaeb9' },
  TWA: { key: 'trop.ww.TWA', color: '#eeee00' },
  SSW: { key: 'trop.ww.SSW', color: '#b429f9' },
  SSA: { key: 'trop.ww.SSA', color: '#db7ff0' },
};
// STORMTYPE code → friendly classification; forecast points also carry TCDVLP (a full phrase), preferred when present
const TC_CLASS = {
  TD: 'Tropical Depression', TS: 'Tropical Storm', HU: 'Hurricane', MH: 'Major Hurricane',
  STS: 'Subtropical Storm', SD: 'Subtropical Depression', STD: 'Subtropical Depression',
  PTC: 'Potential Tropical Cyclone', EX: 'Post-Tropical Cyclone', LO: 'Remnant Low', DB: 'Disturbance',
};
const TC_COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
// NHC sentinel for a missing numeric field is 9999 (and -999-style no-data); guard before any display
const tcVal = (n) => Number.isFinite(+n) && +n !== 9999 && +n > -999;
const tcKtMph = (kt) => Math.round(+kt * 1.15078); // forward speed, nearest 1 mph
const tcKtMphWind = (kt) => Math.round((+kt * 1.15078) / 5) * 5; // wind, nearest 5 mph (NHC convention)
const tcCompass = (deg) => TC_COMPASS[Math.round((((+deg % 360) + 360) % 360) / 22.5) % 16];
const tcEpochIso = (ms) => (Number.isFinite(+ms) ? new Date(+ms).toISOString() : '');

function tcClass(p) {
  if (p.TCDVLP && String(p.TCDVLP).trim()) return String(p.TCDVLP).trim();
  const code = String(p.STORMTYPE || '').trim();
  if (TC_CLASS[code]) return TC_CLASS[code];
  return code.replace(/(Hurricane)(\d)/, '$1 (Cat $2)') || 'Tropical cyclone';
}

// point color by intensity class (forecast positions): hurricane red, storm amber, depression blue
function tcColor(p) {
  const s = `${p.TCDVLP || ''} ${p.STORMTYPE || ''}`;
  if (/hurricane|\bHU\b|\bMH\b/i.test(s)) return '#d11149';
  if (/tropical storm|subtropical storm|\bTS\b|\bSTS\b/i.test(s)) return '#f0a030';
  if (/depression|\bTD\b|\bSD\b|\bSTD\b/i.test(s)) return '#5aa0d0';
  return '#8a8a8a';
}

function tcSrcLine() {
  return `<div class="popup-meta" style="opacity:.7;margin-top:4px">${srcBadge('official')} ${esc(t('trop.src'))}</div>`;
}
function tcPopupCone(p) {
  const adv = String(p.ADVISNUM ?? '').trim();
  return `<div class="popup-title">${esc(p.STORMNAME || t('trop.pop.storm'))} · ${esc(t('trop.leg.cone'))}</div>` +
    `<div class="popup-meta">${esc(tcClass(p))}${adv ? ` · ${esc(t('trop.pop.adv'))} ${esc(adv)}` : ''}</div>` +
    tcSrcLine();
}
function tcPopupWw(p) {
  const w = TCWW_WW[p.TCWW];
  const color = w ? w.color : '#e8912b';
  const label = w ? t(w.key) : t('trop.leg.ww');
  const cls = String(p.STORMTYPE ?? '').trim();
  return `<div class="popup-title" style="color:${color}">${esc(label)}</div>` +
    `<div class="popup-meta">${esc(p.STORMNAME || '')}${cls ? ` · ${esc(tcClass(p))}` : ''}</div>` +
    tcSrcLine();
}
function tcPopupObs(p) {
  const wind = tcVal(p.INTENSITY) ? ` · ${esc(t('trop.pop.wind'))} ${tcKtMphWind(p.INTENSITY)} mph` : '';
  return `<div class="popup-title">${esc(p.STORMNAME || '')} · ${esc(t('trop.pop.obs'))}</div>` +
    `<div class="popup-meta">${esc(tcClass(p))}${wind}</div>` +
    (p.DTG ? `<div class="popup-meta">${esc(t('trop.pop.valid'))} ${esc(fmtWhen(tcEpochIso(p.DTG)))}</div>` : '') +
    tcSrcLine();
}
function tcPopupFcst(p) {
  const wind = tcVal(p.MAXWIND) ? ` · ${esc(t('trop.pop.wind'))} ${tcKtMphWind(p.MAXWIND)} mph` : '';
  const move = (tcVal(p.TCDIR) && tcVal(p.TCSPD))
    ? `<div class="popup-meta">${esc(t('trop.pop.moving'))} ${esc(tcCompass(p.TCDIR))} · ${tcKtMph(p.TCSPD)} mph</div>` : '';
  const when = String(p.FLDATELBL || p.DATELBL || '').trim();
  const adv = String(p.ADVISNUM ?? '').trim();
  return `<div class="popup-title">${esc(p.STORMNAME || '')} · ${esc(t('trop.pop.fcst'))}</div>` +
    `<div class="popup-meta">${esc(tcClass(p))}${wind}</div>` +
    move +
    (when ? `<div class="popup-meta">${esc(t('trop.pop.valid'))} ${esc(when)}</div>` : '') +
    (adv ? `<div class="popup-meta">${esc(t('trop.pop.adv'))} ${esc(adv)}</div>` : '') +
    tcSrcLine();
}

/* lazy: fetched on first overlayadd and refreshed on the data cycle while the layer is on.
   A sublayer that answers with no features means no active storms of that kind; a sublayer that
   fails means we do not know. Those are different facts (E1), and the source chip may only go
   green when every sublayer actually answered. */
async function fetchTropical() {
  const group = state.layers.tropical;
  if (!group) return;
  const grab = async (n) => {
    try {
      const r = await fetch(`${CONFIG.tropicalBase}/${n}/query?where=1%3D1&outFields=*&f=geojson`);
      const d = await okJson(r, `tropical ${n}`);
      return okList(d, 'features', `tropical ${n}`);
    } catch { return null; } // null = this sublayer failed (distinct from [] = no active storms)
  };
  const [cone, ftrack, otrack, ww, fpos, opos] = await Promise.all([grab(4), grab(2), grab(3), grab(5), grab(0), grab(1)]);
  const subs = [cone, ftrack, otrack, ww, fpos, opos];
  if (subs.every((x) => x === null)) {
    opNotice(t('note.tropfail'));
    return; // every sublayer failed, so keep whatever was last drawn
  }
  if (subs.some((x) => x === null)) opNotice(t('note.troppartial'));
  else markHealthy('tropical'); // a partial answer leaves the chip ageing rather than claiming fresh
  renderTropical({ cone, ftrack, otrack, ww, fpos, opos });
}

// z-order via add order within the 'tropical' pane: cone (bottom) → tracks → watches/warnings → positions (top)
function renderTropical(d) {
  const group = state.layers.tropical;
  const pane = 'tropical';
  group.clearLayers();
  const addVec = (features, opts, popupFn) => {
    if (!features || !features.length) return;
    const gj = L.geoJSON({ type: 'FeatureCollection', features }, Object.assign({ pane }, opts));
    if (popupFn) gj.eachLayer((l) => { const p = l.feature && l.feature.properties; if (p) l.bindPopup(popupFn(p)); });
    group.addLayer(gj);
  };
  addVec(d.cone, {
    style: { pane, color: '#e69422', weight: 1, opacity: 0.7, fillColor: TROPICAL_CONE_FILL, fillOpacity: 0.16 },
    attribution: TROPICAL_ATTRIB,
  }, tcPopupCone);
  addVec(d.otrack, { style: { pane, color: TROPICAL_TRACK, weight: 3, opacity: 0.9 }, attribution: TROPICAL_ATTRIB });
  addVec(d.ftrack, { style: { pane, color: TROPICAL_TRACK, weight: 2.5, opacity: 0.9, dashArray: '7,6' }, attribution: TROPICAL_ATTRIB });
  addVec(d.ww, {
    style: (f) => { const w = TCWW_WW[f.properties && f.properties.TCWW]; return { pane, color: w ? w.color : '#e8912b', weight: 5, opacity: 0.95 }; },
    attribution: TROPICAL_ATTRIB,
  }, tcPopupWw);
  addVec(d.opos, {
    pane,
    pointToLayer: (f, ll) => L.circleMarker(ll, { pane, radius: 3, color: '#ffffff', weight: 1, fillColor: '#2b2b2b', fillOpacity: 0.9 }),
    attribution: TROPICAL_ATTRIB,
  }, tcPopupObs);
  addVec(d.fpos, {
    pane,
    pointToLayer: (f, ll) => L.circleMarker(ll, { pane, radius: 5, color: '#ffffff', weight: 1.5, fillColor: tcColor(f.properties || {}), fillOpacity: 0.95 }),
    attribution: TROPICAL_ATTRIB,
  }, tcPopupFcst);
}

/* ---------- TxGIO low-water-crossing location inventory (LOCATIONS, not live status) ---------- */

const LWC_ATTRIB = 'Low-water crossings: TxGIO (Texas Geographic Information Office)';
const LWC_PAGE = 2000; // the service's own maxRecordCount
const LWC_MAX_PAGES = 15; // runaway guard; the AO holds ~8.3k points, so this leaves ~3.5x headroom

// lazy: fetched once on first overlayadd, paged until the service stops reporting more records
async function fetchLwc() {
  if (state._lwcLoaded) return;
  state._lwcLoaded = true;
  const b = CONFIG.gaugeBbox;
  const base = {
    where: '1=1',
    geometry: `${b.xmin},${b.ymin},${b.xmax},${b.ymax}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'lwx_type,road,county,grade,signage',
    outSR: '4326',
    resultRecordCount: String(LWC_PAGE),
    f: 'geojson',
  };
  try {
    const pages = [];
    let partial = false;
    for (let page = 0; page < LWC_MAX_PAGES; page++) {
      const qs = new URLSearchParams({ ...base, resultOffset: String(page * LWC_PAGE) });
      const r = await fetch(`${CONFIG.lwcUrl}?${qs}`);
      const d = await okJson(r, 'TxGIO');
      // E1: an ArcGIS error body must not draw an empty layer that reads as "no crossings here"
      const got = okList(d, 'features', 'TxGIO');
      pages.push(got);
      if (!got.length || !arcgisHasMore(d)) { partial = false; break; }
      partial = true; // more records remain; only survives the loop when the ceiling cuts paging short
    }
    state.lwcPartial = partial;
    if (partial) opNotice(t('lwc.partial'));
    renderLwc([].concat(...pages));
  } catch (err) {
    state._lwcLoaded = false; // allow a retry the next time the layer is toggled on
    opNotice(t('note.lwcfail')); // an empty layer would otherwise read as "no crossings here"
  }
}

function renderLwc(features) {
  const layer = state.layers.lwc;
  if (!layer) return;
  layer.clearLayers();
  const canvas = L.canvas({ padding: 0.5 });
  const attrib = state.lwcPartial ? `${LWC_ATTRIB} · ${t('lwc.partial')}` : LWC_ATTRIB;
  for (const f of features) {
    const c = f.geometry && f.geometry.coordinates;
    if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    const m = L.circleMarker([c[1], c[0]], { renderer: canvas, radius: 3.5, color: '#2b8ce8', weight: 1, fillColor: '#5ab0ff', fillOpacity: 0.5, attribution: attrib });
    m.bindPopup(() => lwcPopupHtml(f.properties)); // lazy: thousands of eager popup strings stall the layer toggle
    layer.addLayer(m);
  }
}

function lwcPopupHtml(p) {
  const road = String(p.road || '').trim() || t('lwc.generic');
  const rows = [[t('lwc.county'), p.county], [t('lwc.type'), p.lwx_type], [t('lwc.grade'), p.grade], [t('lwc.signage'), p.signage]]
    .filter(([, v]) => String(v || '').trim());
  return `<div class="popup-title">${esc(road)}</div>` +
    rows.map(([k, v]) => `<div class="popup-meta">${esc(k)}: ${esc(String(v).trim())}</div>`).join('') +
    `<div class="popup-meta" style="opacity:.7;margin-top:4px">${srcBadge('official')} ${esc(t('lwc.footer'))}</div>` +
    (state.lwcPartial ? `<div class="popup-meta"><span class="xg-stale">${esc(t('lwc.partial'))}</span></div>` : '');
}

/* ---------- River Sentry siren tower sites (REPORTED LOCATIONS, no status feed) ----------
   data/river-sentry.json is a static committed transcription of a public My Maps export that
   names no author. Every string this renders has to keep saying "reported location", because a
   marker asserting a working warning siren is the one claim this board must never make blind. */

const RSENTRY_ATTRIB = 'River Sentry tower sites: public Google My Maps export (author not identified)';

// lazy: fetched once on first overlayadd; same-origin static file, no CSP surface
async function fetchRiverSentry() {
  if (state._rsentryLoaded) return;
  state._rsentryLoaded = true;
  try {
    const res = await fetch(`data/river-sentry.json?_=${Date.now()}`);
    if (!res.ok) throw new Error(`river-sentry HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.towers)) throw new Error('river-sentry payload has no towers');
    state.riverSentry = data;
    renderRiverSentry();
  } catch (err) {
    state._rsentryLoaded = false; // allow a retry the next time the layer is toggled on
    opNotice(t('note.rsentryfail'));
  }
}

function rsentrySiteCount(site) {
  const rows = ((state.riverSentry || {}).sites) || [];
  const hit = rows.find((s) => s.site === site);
  return hit ? hit.towers : 0;
}

function renderRiverSentry() {
  const layer = state.layers.riverSentry;
  const data = state.riverSentry;
  if (!layer || !data) return;
  layer.clearLayers();
  const lbl = esc(t('layers.rsentry'));
  for (const tw of (Array.isArray(data.towers) ? data.towers : [])) {
    if (!Number.isFinite(tw.lat) || !Number.isFinite(tw.lon)) continue;
    const icon = L.divIcon({
      className: '',
      html: `<div class="rsentry-icon" role="img" aria-label="${lbl}" title="${lbl}">📢</div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
    const m = L.marker([tw.lat, tw.lon], { icon, attribution: RSENTRY_ATTRIB });
    m.bindPopup(() => rsentryPopupHtml(tw));
    layer.addLayer(m);
  }
}

function rsentryPopupHtml(tw) {
  const data = state.riverSentry || {};
  const src = data.source || {};
  const n = rsentrySiteCount(tw.site);
  const title = tw.label ? `${tw.site} · ${tw.label}` : tw.site;
  const link = safeUrl(src.url) !== '#'
    ? `<div class="popup-link"><a href="${esc(safeUrl(src.url))}" target="_blank" rel="noopener">${esc(t('word.source'))}</a></div>`
    : '';
  return `<div class="popup-title">📢 ${esc(title)}</div>` +
    (n ? `<div class="popup-meta">${esc(t('rs.towers'))}: ${esc(String(n))}</div>` : '') +
    `<div class="popup-meta">${esc(t('rs.what'))}</div>` +
    `<div class="popup-meta" style="margin-top:4px">${esc(t('rs.nostatus'))}</div>` +
    `<div class="popup-meta" style="opacity:.7;margin-top:4px">${esc(t('rs.reported'))}` +
    (data.captured ? ` ${esc(t('rs.captured').replace('{t}', fmtWhen(data.captured)))}` : '') + '</div>' +
    (src.name ? `<div class="popup-meta" style="opacity:.7">${esc(src.name)}</div>` : '') +
    link;
}

/* ---------- Wildfire incidents (REPORTED INCIDENTS, not fire perimeters) ----------
   data/wildfire.json is written each cycle from Texas A&M Forest Service and NIFC WFIGS. Two
   things the layer must never do: draw a point as if it were the edge of the fire, and read an
   unreported figure as a measurement. Acreage and containment are what an incident commander
   typed into a system at some point, so a null is "nobody reported", never 0. */

/* TFS keeps a contained incident in its feed for weeks (measured max 24 days) and WFIGS "Current"
   holds records modified up to a fortnight ago, so past this window an incident is still drawn,
   it just stops being asserted as something anyone is working. */
const WILDFIRE_STALE_H = 24;
// the edge read, an enrichment: it answers for outlines only, never for the incident list
const WILDFIRE_PERIM_KEY = 'wfigs-perimeters';
const wildfireSources = () => (((state.wildfire || {}).sources) || []);
const wildfireAgeH = (f) => (Date.now() - new Date(f && f.observed).getTime()) / 3600000;
const wildfireStale = (f) => !(wildfireAgeH(f) < WILDFIRE_STALE_H); // NaN counts as stale
// contained is a reported state, so it needs a reported number or a status word saying so
const wildfireContained = (f) => f && (f.contain === 100 || /contain|out|control/i.test(String(f.status || '')));

/* Read once, either at boot ({ quiet: true }) or on the first overlayadd; same-origin static file,
   no CSP surface. The quiet read is the board preloading a count it needs before anyone opens the
   layer, so it raises no toast about a layer nobody is looking at. Every toggle-on still speaks,
   including one that lands on an already-loaded payload: an empty layer reads as broken. */
async function fetchWildfire(opts) {
  const quiet = !!(opts && opts.quiet);
  const speak = (msg) => { if (!quiet && msg) opNotice(msg); };
  if (state._wildfireLoaded) { speak(wildfireNoticeText()); return; }
  state._wildfireLoaded = true;
  try {
    const res = await fetch(`data/wildfire.json?_=${Date.now()}`);
    if (!res.ok) throw new Error(`wildfire HTTP ${res.status}`);
    const data = await res.json();
    // E1: an absent list is an unreadable file, never a report that nothing is burning
    if (!data || !Array.isArray(data.fires) || !Array.isArray(data.sources)) throw new Error('wildfire payload has no fires/sources');
    state.wildfire = data;
    state.wildfireUnknown = false;
  } catch (err) {
    state._wildfireLoaded = false; // allow a retry the next time the layer is toggled on
    state.wildfireUnknown = !state.wildfire;
    // nothing on the map: the sentence builder answers. Last-good drawn: only the refresh failed.
    speak(state.wildfireUnknown ? wildfireNoticeText() : t('note.wildfirefail'));
    wildfireRepaint(); // the fire surfaces must show unknown rather than keep a stale count
    return;
  }
  // the read succeeded, so a throw from here is ours and must not be reported against the feed
  let drew = false;
  try {
    renderWildfire();
    drew = true;
  } catch (err) {
    state._wildfireLoaded = false;
    speak(t('note.wildfiredraw'));
  }
  // a layer that failed to draw must not be opened at anyone: it would arrive blank or half-painted
  if (drew) { speak(wildfireNoticeText()); maybeAutoWildfire(); }
  wildfireRepaint(); // the count comes from the payload, which was read whether or not it drew
}

// the hero strip is painted from this payload, and nothing else fetches it again
function wildfireRepaint() {
  if (typeof renderThreatStrip === 'function') renderThreatStrip(); // panels.js is absent from the map-only bundle
}

/* An empty layer looks broken, and for most of a Texas year empty is the correct answer, so the
   layer says which of the two it is out loud the moment it is switched on. Returns the sentence
   or '' when the markers speak for themselves. */
function wildfireNoticeText() {
  // E1: the file was unreadable, so there is no source list to reason about and no reportable zero
  if (state.wildfireUnknown) return t('wf.unknown');
  /* Only the incident sources decide this sentence. A perimeter read that failed or was carried
     forward leaves the incident list whole, and wf.point already tells the reader that a missing
     outline means nobody mapped that edge, so there is nothing here for the reader to act on. */
  const srcs = wildfireSources().filter((s) => s.key !== WILDFIRE_PERIM_KEY);
  const failed = srcs.filter((s) => s.status !== 'ok');
  if (failed.length) return t(failed.length < srcs.length ? 'wf.partial' : 'wf.unknown');
  if (((state.wildfire || {}).fires || []).length) return '';
  // an absence is only reportable when an incident source actually reported it
  if (!srcs.length) return t('wf.unknown');
  const stamp = srcs.map((s) => s.captured).filter(Boolean).sort()[0];
  return stamp ? t('wf.none').replace('{t}', fmtWhen(stamp)) : t('wf.none.undated');
}

/* Reported acreage drawn as a circle of equal area, for fires big enough that the figure says
   something a pin cannot. NOT a perimeter and never styled like one: it is centred on the reported
   ORIGIN, and a fire spreads downwind from its origin rather than around it, so the circle says how
   much is burning and says nothing about where. Suppressed the moment a real perimeter exists.

   The floor is where the circle first reads as bigger than the 26px marker at the zoom someone uses
   to look at one fire (z13): 100 acres is a 359 m radius, 22px there, against the marker's 13px.
   50 acres would be 15px and 25 acres 11px, which is smaller than the pin it is drawn around. */
const WILDFIRE_AREA_MIN_ACRES = 100;
const SQ_M_PER_ACRE = 4046.86;
const fireAreaRadiusM = (acres) => Math.sqrt((acres * SQ_M_PER_ACRE) / Math.PI);

const wildfireKey = (v) => String(v || '').trim().toUpperCase();
// two live perimeters are named "West Fork" in different states, so a stated disagreement rules a name out
const wildfireStateDiffers = (a, b) => {
  const x = wildfireKey(a);
  const y = wildfireKey(b);
  return !!x && !!y && x !== y;
};

/* The local incident id in its own state first: the TFS feed carries no IRWIN at all, so every
   match used to ride on name equality, which two states can both publish. */
function perimeterFor(data, f) {
  const perims = Array.isArray(data.perimeters) ? data.perimeters : [];
  if (!perims.length) return null;
  const local = wildfireKey(f.number);
  const st = wildfireKey(f.state);
  const irwin = wildfireKey(f.irwin);
  const name = wildfireKey(f.name);
  return perims.find((p) => {
    if (local && st && wildfireKey(p.local) === local && wildfireKey(p.state) === st) return true;
    if (irwin && wildfireKey(p.irwin) === irwin) return true;
    return !!name && wildfireKey(p.name) === name && !wildfireStateDiffers(f.state, p.state);
  }) || null;
}

function perimeterMatches(data, f) { return !!perimeterFor(data, f); }

function renderFireAreas(layer, data) {
  for (const f of (Array.isArray(data.fires) ? data.fires : [])) {
    if (!Number.isFinite(f.lat) || !Number.isFinite(f.lon)) continue;
    if (!Number.isFinite(f.acres) || f.acres < WILDFIRE_AREA_MIN_ACRES) continue;
    if (perimeterMatches(data, f)) continue; // a mapped edge always beats an inferred circle
    const circle = L.circle([f.lat, f.lon], {
      radius: fireAreaRadiusM(f.acres),
      pane: 'shadowPane', color: '#e8590c', weight: 2, opacity: 0.8,
      dashArray: '6 5', fill: false, className: 'wildfire-area',
    });
    circle.bindPopup(fireAreaPopupHtml(f));
    layer.addLayer(circle);
  }
}

function fireAreaPopupHtml(f) {
  return `<div class="pop"><strong>${esc(f.name || t('wf.unnamed'))}</strong>`
    + `<div class="pop-sub">${esc(t('wf.area.sub'))}</div>`
    + `<div class="pop-meta">${esc(t('wf.k.size'))}: `
    + `${esc(t('wf.acres').replace('{n}', fmtNum(f.acres)))}</div></div>`;
}

/* p.mapped is when the edge was actually collected; p.observed only says when the record was last
   restamped, and upstream the two have run 4.5 days apart on a growing fire. */
const perimeterAgeH = (p) => (Date.now() - new Date(p && p.mapped).getTime()) / 3600000;

/* How long an outline may be asserted as current depends on what it is an outline OF. 24h suits a
   small local incident and badly oversells a campaign fire, where a shift is thousands of acres.
   The tier comes from WFIGS IncidentComplexityLevel, the only threat tier either source states:
   acreage and containment must not be ranked on (containment measures crew progress, not threat).
   Types 1-3 carry an organised IMT and are re-flown per 12h operational period, so an outline past
   one period has missed a flight. An absent or unparseable tier keeps 24h: an unread field must not
   silently tighten or loosen the window it cannot speak for. */
const WILDFIRE_CAMPAIGN_STALE_H = 12;
const perimeterCampaign = (p) => {
  const m = /type\s*([1-5])/i.exec(String((p && p.complexity) || ''));
  return !!m && Number(m[1]) <= 3;
};
const perimeterStaleH = (p) => (perimeterCampaign(p) ? WILDFIRE_CAMPAIGN_STALE_H : WILDFIRE_STALE_H);
const perimeterStale = (p) => !(perimeterAgeH(p) < perimeterStaleH(p)); // an uncollected edge cannot be asserted as current
// strictly true: null or absent means an incident read failed, and an unread source is no answer about this edge (E1)
const perimeterUnbacked = (p) => !!p && p.orphan === true;

/* Farthest mapped vertex from the reported origin. Longitude scaled by cos(lat) like camRegionId(),
   so this is real distance. null, never 0, when no vertex is usable: a zero would read as a fact. */
function perimeterReachMi(p, lat, lon) {
  if (!p || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const kx = Math.cos((lat * Math.PI) / 180);
  let far = 0;
  for (const ring of (Array.isArray(p.rings) ? p.rings : [])) {
    if (!Array.isArray(ring)) continue;
    for (const c of ring) {
      if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
      const dy = c[1] - lat, dx = (c[0] - lon) * kx;
      far = Math.max(far, Math.sqrt(dy * dy + dx * dx));
    }
  }
  return far > 0 ? far * MI_PER_DEG_LAT : null;
}

/* Where an agency has mapped the fire edge. Most fires never get one, so this draws under the
   points rather than replacing them, and its absence is never a claim the fire is small. The
   geometry is a generalized daily interpretation of imagery, which the popup says out loud. */
function renderPerimeters(layer, data) {
  for (const p of (Array.isArray(data.perimeters) ? data.perimeters : [])) {
    const cls = `wildfire-perimeter${perimeterStale(p) ? ' aged' : ''}${perimeterUnbacked(p) ? ' unbacked' : ''}`;
    for (const ring of (Array.isArray(p.rings) ? p.rings : [])) {
      if (!Array.isArray(ring) || ring.length < 4) continue;
      const latlngs = ring
        .filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]))
        .map((c) => [c[1], c[0]]); // stored lon,lat like the GeoJSON it came from
      if (latlngs.length < 4) continue;
      const poly = L.polygon(latlngs, {
        pane: 'shadowPane', color: '#d9480f', weight: 2, opacity: 0.9,
        fillColor: '#f76707', fillOpacity: 0.18, className: cls,
      });
      poly.bindPopup(perimeterPopupHtml(p));
      layer.addLayer(poly);
    }
  }
}

function perimeterPopupHtml(p) {
  const rows = [];
  // fmtNum, not wildfirePopupHtml's local num(): that one is scoped to the incident popup
  if (Number.isFinite(p.acres)) rows.push(`${esc(t('wf.k.size'))}: ${esc(t('wf.acres').replace('{n}', fmtNum(p.acres)))}`);
  // the mapping method is the provenance: image interpretation and a GPS walk are different claims
  if (p.method) rows.push(`${esc(t('wf.k.method'))}: ${esc(p.method)}`);
  const aged = perimeterStale(p);
  const mappedCls = p.mapped ? (aged ? ' class="xg-stale"' : '') : ' class="wf-unknown"';
  // always drawn: an unreported collection time is the fact the reader most needs to see
  rows.push(`${esc(t('wf.k.mapped'))}: <span${mappedCls}>`
    + `${esc(p.mapped ? fmtWhen(p.mapped) : t('wf.unreported'))}</span>`);
  if (p.observed) rows.push(`${esc(t('wf.k.updated'))}: ${esc(fmtWhen(p.observed))}`);
  return `<div class="pop"><strong>${esc(p.name || t('wf.unnamed'))}</strong>`
    + `<div class="pop-sub">${esc(t('wf.perim.sub'))}</div>`
    + `<div class="pop-meta">${rows.join(' · ')}</div>`
    + (aged ? `<div class="pop-meta xg-stale">${esc(p.mapped
      ? t('wf.edge.stale').replace('{h}', String(Math.round(perimeterAgeH(p))))
      : t('wf.edge.undated'))}</div>` : '')
    // a second, independent fact: the age note above says nothing about whether an incident backs it
    + (perimeterUnbacked(p) ? `<div class="pop-meta wf-unbacked">${esc(t('wf.edge.unbacked'))}</div>` : '')
    + `</div>`;
}

/* The reported acreage drawn at weight, the same reported figure renderFireAreas() draws as a
   circle. Decade bands off the 100-acre floor that circle already uses; an unreported acreage and
   a contained fire both sit at the base, never at the ramp floor. */
const WILDFIRE_BASE_PX = 26;
const WILDFIRE_TIERS = [[10000, 38], [1000, 34], [WILDFIRE_AREA_MIN_ACRES, 30]];
const wildfireTier = (f) => ((!f || wildfireContained(f) || !Number.isFinite(f.acres)) ? -1
  : WILDFIRE_TIERS.findIndex(([acres]) => f.acres >= acres));
const wildfireMarkerPx = (f) => {
  const i = wildfireTier(f);
  return i < 0 ? WILDFIRE_BASE_PX : WILDFIRE_TIERS[i][1];
};

/* The set every fire surface counts: what an agency currently reports as burning inside the AO.
   'buffer' is the only scope the popup disclaims as merely near Texas, so it is the only one
   excluded here, and a payload written before the field existed keeps counting. */
const wildfireActive = () => (((state.wildfire || {}).fires) || [])
  .filter((f) => f && f.scope !== 'buffer' && !wildfireContained(f));

// the largest reported size among them; null when nobody has reported a size at all
const wildfireLargest = () => wildfireActive()
  .filter((f) => Number.isFinite(f.acres))
  .sort((a, b) => b.acres - a.acres)[0] || null;

/* Default the layer ON the first time the AO holds a fire this size that nobody reports as
   contained. The bar is the top band of the marker ramp rather than a fourth number of its own,
   and it is meant to be rare: one Texas fire met it the day this shipped. Latches like the
   tropical tracker, so a manual toggle-off (overlayremove) or a restored OFF is final. */
const WILDFIRE_AUTO_ACRES = WILDFIRE_TIERS[0][0];
const hasMajorWildfire = () => wildfireActive()
  .some((f) => Number.isFinite(f.acres) && f.acres >= WILDFIRE_AUTO_ACRES);

function maybeAutoWildfire() {
  if (state.wildfireAutoDone || CONFIG.wildfireAutoEnable === false) return;
  if (!state.map || !state.layers.wildfire || !hasMajorWildfire()) return;
  state.wildfireAutoDone = true;
  if (!state.map.hasLayer(state.layers.wildfire)) state.layers.wildfire.addTo(state.map);
}

/* The layer-sheet row's subtitle, so what is burning is readable without opening the layer.
   An unreadable file says so; a read that found nothing falls back to the static description
   rather than announcing a zero. */
function wildfireRowSub() {
  if (state.wildfireUnknown) return t('wf.unknown');
  const active = wildfireActive();
  if (!active.length) return t('sheet.s.wildfire');
  const big = wildfireLargest();
  return big
    ? t('sheet.s.wildfire.n').replace('{n}', fmtNum(active.length)).replace('{a}', fmtNum(big.acres))
    : t('sheet.s.wildfire.na').replace('{n}', fmtNum(active.length));
}

function renderWildfire() {
  const layer = state.layers.wildfire;
  const data = state.wildfire;
  if (!layer || !data) return;
  layer.clearLayers();
  renderFireAreas(layer, data);   // inferred area first: a mapped perimeter must draw over it
  renderPerimeters(layer, data); // then edges, so the origin points stay clickable on top
  const lbl = esc(t('layers.wildfire'));
  for (const f of (Array.isArray(data.fires) ? data.fires : [])) {
    if (!Number.isFinite(f.lat) || !Number.isFinite(f.lon)) continue;
    const cls = `wildfire-icon${wildfireContained(f) ? ' contained' : ''}${wildfireStale(f) ? ' unconfirmed' : ''}`
      + `${wildfireTier(f) === 0 ? ' large' : ''}`;
    const px = wildfireMarkerPx(f);
    const icon = L.divIcon({
      className: '',
      html: `<div class="${cls}" role="img" aria-label="${lbl}" title="${lbl}"`
        + ` style="width:${px}px;height:${px}px;font-size:${Math.round(px / 2)}px">🔥</div>`,
      iconSize: [px, px],
      iconAnchor: [px / 2, px / 2],
    });
    /* Above every gauge (js/sources.js gauge markers reach zIndexOffset 1000 for a major category),
       because Leaflet orders the marker pane by latitude, so a gauge a little to the south was
       taking the click off a fire glyph the user could see. The asymmetry decides it: a gauge is
       also reachable from the Gauges tab, the ticker and the hero cards, while a fire incident has
       no surface but this marker. Stays under the alert ping at 1200. */
    const m = L.marker([f.lat, f.lon], { icon, attribution: wildfireAttrib(f), zIndexOffset: 1100 });
    m.bindPopup(() => wildfirePopupHtml(f));
    layer.addLayer(m);
  }
}

// the operator that actually runs the service, per record; NIFC must never be credited for a TFS fire
const wildfireSource = (f) => wildfireSources().find((s) => s.key === (f && f.src)) || {};
const wildfireAttrib = (f) => `${t('layers.wildfire')}: ${wildfireSource(f).name || t('word.source')}`;

/* One row per fact the source actually stated. A reported figure and an unreported one are drawn
   differently rather than both as plain text, because "not reported" is the answer a responder most
   needs to notice: 85% of WFIGS records carry no containment at all. */
/* The label and the value are direct children of the .wf-facts grid, with no per-row wrapper: a
   wrapper div becomes a single grid item, which packs two rows onto each line and leaves the label
   butted against its value. */
function wfRow(labelKey, value, opts) {
  const o = opts || {};
  const unknown = value === null || value === undefined || value === '';
  if (unknown && !o.showUnknown) return '';
  const cls = `wf-v${unknown ? ' wf-unknown' : ''}${o.cls ? ` ${o.cls}` : ''}`;
  const text = unknown ? t('wf.unreported') : String(value);
  return `<dt class="wf-k">${esc(t(labelKey))}</dt>`
    + `<dd class="${cls}">${esc(text)}</dd>`;
}

/* Under this the origin county still describes the fire and the row is noise: measured on the live
   payload, the four other mapped Texas edges reach 0.9 to 3.9 mi while Ross reaches 28. */
const WILDFIRE_REACH_MIN_MI = 5;

// stated only where it corrects the origin, and only ever about the edge as it was last mapped
function wildfireReachText(f) {
  const mi = perimeterReachMi(perimeterFor(state.wildfire || {}, f), f.lat, f.lon);
  return mi !== null && mi >= WILDFIRE_REACH_MIN_MI
    ? t('wf.reach').replace('{n}', fmtNum(Math.round(mi))) : null;
}

function wildfirePopupHtml(f) {
  const src = wildfireSource(f);
  const num = (v) => (v === null || v === undefined ? null : fmtNum(v));
  const place = [f.county && t('wf.county').replace('{c}', f.county), f.state].filter(Boolean).join(', ');
  const stale = wildfireStale(f);
  const head = `<div class="wf-head">`
    + `<div class="popup-title">🔥 ${esc(f.name || t('layers.wildfire'))}</div>`
    + `<div class="wf-tags">`
    + (f.status ? `<span class="wf-tag${wildfireContained(f) ? ' is-out' : ''}">${esc(f.status)}</span>` : '')
    // a fire in the border band is not a Texas fire, and the card says so rather than letting the
    // layer's name imply it
    + (f.scope === 'buffer' ? `<span class="wf-tag is-near">${esc(t('wf.nearby'))}</span>` : '')
    + (stale ? `<span class="wf-tag is-stale">${esc(t('wf.stale').replace('{h}', String(Math.round(wildfireAgeH(f)))))}</span>` : '')
    + `</div></div>`;
  const facts = `<dl class="wf-facts">`
    + wfRow('wf.k.size', f.acres === null || f.acres === undefined ? null : t('wf.acres').replace('{n}', num(f.acres)), { showUnknown: true })
    + wfRow('wf.k.contain', f.contain === null || f.contain === undefined ? null : t('wf.contain').replace('{n}', num(f.contain)), { showUnknown: true })
    // the only threat tier either source states; never derived, and never filled in from acreage
    + wfRow('wf.k.complexity', f.complexity, { showUnknown: true })
    + wfRow('wf.k.where', place)
    + wfRow('wf.k.reach', wildfireReachText(f))
    + wfRow('wf.k.cause', f.cause)
    + wfRow('wf.k.started', f.started ? fmtWhen(f.started) : null)
    + wfRow('wf.k.updated', f.observed ? fmtWhen(f.observed) : null, { showUnknown: true, cls: stale ? 'xg-stale' : '' })
    + wfRow('wf.k.unit', f.unit)
    + wfRow('wf.k.org', f.org)
    + wfRow('wf.k.crew', f.crew === null || f.crew === undefined ? null : t('wf.crew').replace('{n}', num(f.crew)))
    + wfRow('wf.k.number', f.number)
    + `</dl>`;
  const prov = `<div class="wf-prov">`
    + `<div>${esc(t('wf.lag'))}</div>`
    + `<div>${esc(t('wf.point'))}</div>`
    + (src.name
      ? `<div>${esc(src.name)}`
        + (src.captured ? ` · ${esc(t('wf.captured').replace('{t}', fmtWhen(src.captured)))}`
          : ` · ${esc(t('wf.nocurrency'))}`) + `</div>`
      : '')
    + `</div>`;
  const link = safeUrl(src.url) !== '#'
    ? `<div class="popup-link"><a href="${esc(safeUrl(src.url))}" target="_blank" rel="noopener">${esc(t('word.source'))}</a></div>`
    : '';
  return `<div class="wf-card">${head}${facts}${prov}${link}</div>`;
}

/* ---------- IEM local storm reports (ground truth) ---------- */

async function fetchLsrs() {
  const hours = state.filters.window ? Math.max(2, Math.ceil(+state.filters.window / 60)) : CONFIG.lsrHours;
  const res = await fetch(`${CONFIG.lsrUrl}?hours=${hours}&states=TX`);
  const data = await okJson(res, 'LSR');
  // E1: an unreadable body must not publish as zero storm reports on the ground
  state.lsrs = okList(data, 'features', 'LSR')
    .filter((f) => LSR_HAZARD_RE.test(f.properties.typetext || ''))
    .sort((a, b) => new Date(b.properties.valid) - new Date(a.properties.valid));
  markHealthy('lsrs');
  recordLsrHist();
  renderLsrs();
}

function highlightRoads(text) {
  return esc(text).replace(ROAD_RE, (m) => `<span class="road-chip">${m}</span>`);
}

function lsrPopupHtml(e) {
  return `<div class="popup-title">💧 ${esc(e.typetext)}${e.magnitude ? `: ${esc(e.magnitude)} ${esc(e.unit || '')}` : ''}</div>` +
    `<div class="popup-meta">${esc(e.city)}, ${esc(e.county)} Co. · ${esc(e.source)} · ${esc(fmtWhen(e.t))}</div>` +
    (e.remark ? `<div style="margin-top:4px">${highlightRoads(e.remark)}</div>` : '') +
    `<div class="popup-link"><a href="https://maps.google.com/?q=${e.lat},${e.lon}" target="_blank" rel="noopener">${esc(t('word.nav'))}</a> · USNG ${esc(toUSNG(e.lat, e.lon))}</div>`;
}

function lsrCardDiv(e, aged) {
  const div = document.createElement('div');
  div.className = `card lsr-card${aged ? ' aged' : ''}`;
  div.innerHTML = `<div class="head"><span>💧</span><span class="type-chip">${esc(e.typetext)}</span>` +
    `<span class="when"><span class="fresh-dot ${freshClass(e.t)}"></span> ${esc(fmtWhen(e.t))}</span></div>` +
    (e.remark ? `<div class="summary">${highlightRoads(e.remark)}</div>` : '') +
    `<div class="meta">📍 ${esc(e.city)}, ${esc(e.county)} Co. · ${esc(t('word.via'))} ${esc(e.source)}` +
    (state.myPos ? ` · ${distMi(state.myPos.lat, state.myPos.lng, e.lat, e.lon).toFixed(1)} mi` : '') + '</div>';
  div.addEventListener('click', () => state.map.setView([e.lat, e.lon], 12));
  return div;
}

function renderLsrs() {
  // live layer is hard-capped at lsrMaxHours regardless of a wider window filter — older reports route to lsrsAged (history), never delete
  const cutoff = Math.min(lsrFreshCutoffMins(), CONFIG.lsrMaxHours * 60);
  const live = state.lsrs.filter((f) => f.geometry && Array.isArray(f.geometry.coordinates)).map((f) => {
    const [lon, lat] = f.geometry.coordinates;
    const p = f.properties;
    return { t: p.valid, lat, lon, typetext: p.typetext, magnitude: p.magnitude, unit: p.unit, city: p.city, county: p.county, source: p.source, remark: p.remark };
  });
  const liveKeys = new Set(live.map((e) => `${e.t}|${e.lat}|${e.lon}`));
  const fresh = live.filter((e) => ageMins(e.t) <= cutoff);
  // aged = timed-out live reports + persisted history the API window no longer returns
  const aged = live.filter((e) => ageMins(e.t) > cutoff)
    .concat(Object.entries(state.hist.lsrs).filter(([k]) => !liveKeys.has(k)).map(([, e]) => e))
    .sort((a, b) => new Date(b.t) - new Date(a.t));

  state.layers.lsrs.clearLayers();
  state.layers.lsrsAged.clearLayers();
  for (const e of fresh) {
    const icon = L.divIcon({ className: '', html: `<div class="lsr-icon ${freshClass(e.t)}">💧</div>`, iconSize: [22, 22] });
    state.layers.lsrs.addLayer(L.marker([e.lat, e.lon], { icon }).bindPopup(lsrPopupHtml(e)));
  }
  for (const e of aged) {
    const icon = L.divIcon({ className: '', html: '<div class="lsr-icon aged-icon">💧</div>', iconSize: [22, 22] });
    state.layers.lsrsAged.addLayer(L.marker([e.lat, e.lon], { icon }).bindPopup(lsrPopupHtml(e)));
  }

  const el = $('#lsr-list');
  el.innerHTML = `<div class="section-title">${esc(t('sec.lsr'))}</div>`;
  if (!fresh.length) el.innerHTML += `<div class="card">${esc(t('sec.lsr.empty').replace('{h}', Math.round(cutoff / 60)))}</div>`;
  const lsrCap = state.showAllLsrs ? 30 : 5;
  for (const e of fresh.slice(0, lsrCap)) el.appendChild(lsrCardDiv(e, false));
  if (fresh.length > 5) {
    const more = document.createElement('button');
    more.className = 'aged-toggle';
    more.textContent = state.showAllLsrs ? t('lsr.fewer') : t('lsr.more').replace('{n}', Math.min(fresh.length, 30) - 5);
    more.addEventListener('click', () => { state.showAllLsrs = !state.showAllLsrs; renderLsrs(); });
    el.appendChild(more);
  }
  if (aged.length) {
    const btn = document.createElement('button');
    btn.id = 'lsr-aged-toggle';
    btn.className = 'aged-toggle';
    btn.textContent = `${t(state.showAgedLsrs ? 'toggle.hide' : 'toggle.show')} ${t('lsr.aged').replace('{n}', aged.length).replace('{h}', Math.round(cutoff / 60)).replace('{d}', CONFIG.histDays)}`;
    btn.addEventListener('click', () => { state.showAgedLsrs = !state.showAgedLsrs; renderLsrs(); });
    el.appendChild(btn);
    if (state.showAgedLsrs) for (const e of aged.slice(0, 40)) el.appendChild(lsrCardDiv(e, true));
  }
  renderTicker();
  pbRefreshCurated(); // playback may have engaged before the LSR fetch arrived
}

/* ---------- NOAA CO-OPS coastal water levels: observed vs predicted storm-surge residual ----------
   Lazy: fetched on Gauges-tab open and refreshed on the data cycle only while that tab is visible.
   Per-station failures degrade to an unavailable row; a total feed failure keeps the last-good rows. */

// station seed comes from data/event.json tideStations (coastal events only); empty = no card, no fetches
const coopStations = () => (Array.isArray(CONFIG.tideStations) ? CONFIG.tideStations : []);

// CO-OPS returns "YYYY-MM-DD HH:MM" naive station-local (lst_ldt); parse to epoch only for prediction-match delta math
const tideEpoch = (s) => new Date(String(s).replace(' ', 'T')).getTime();

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function fetchTideStation(s) {
  const url = (extra) => `${CONFIG.coopBase}?${extra}&station=${s.id}&datum=MLLW&time_zone=lst_ldt&units=english&format=json&application=respondertx.org`;
  try {
    const [obsR, predR] = await Promise.all([
      fetch(url('range=3&product=water_level')),
      fetch(url('date=today&product=predictions&interval=6')),
    ]);
    // CO-OPS reports a rejected request as an {"error":...} body, so ok:false must come from the
    // guard rather than from an absent .data reading as a station with no water level
    const obs = await okJson(obsR, 'CO-OPS obs');
    const pred = await okJson(predR, 'CO-OPS pred');
    const data = okList(obs, 'data', 'CO-OPS obs');
    const preds = okList(pred, 'predictions', 'CO-OPS pred');
    if (!data.length) return { id: s.id, name: s.name, ok: false };
    const last = data[data.length - 1];
    const obv = +last.v;
    if (!Number.isFinite(obv)) return { id: s.id, name: s.name, ok: false };
    let prev = null;
    for (let i = data.length - 2; i >= 0; i--) { if (Number.isFinite(+data[i].v)) { prev = data[i]; break; } }
    let pv = null;
    if (preds.length) {
      const exact = preds.find((p) => p.t === last.t);
      if (exact) { pv = +exact.v; }
      else {
        const lt = tideEpoch(last.t);
        let best = null, bestD = Infinity;
        for (const p of preds) { const d = Math.abs(tideEpoch(p.t) - lt); if (d < bestD) { bestD = d; best = p; } }
        if (best && bestD <= 1800000) pv = +best.v; // accept a nearest prediction only within 30 min of the obs
      }
    }
    const surge = (pv != null && Number.isFinite(pv)) ? obv - pv : null;
    let dir = 'steady';
    if (prev && Number.isFinite(+prev.v)) { const d = obv - +prev.v; dir = d > 0.03 ? 'up' : d < -0.03 ? 'down' : 'steady'; }
    return { id: s.id, name: s.name, ok: true, obs: obv, pred: pv, surge, dir, t: last.t };
  } catch { return { id: s.id, name: s.name, ok: false }; }
}

async function fetchTides() {
  // each station costs two requests and CO-OPS answers 429 to a burst; a capped pool makes a long
  // station list take longer rather than fail together and blank the whole card
  const rows = await mapPool(coopStations(), 4, fetchTideStation);
  if (rows.some((r) => r.ok)) { state.tides = rows; state.tidesAt = Date.now(); } // keep last-good if the whole feed is down
}

/* The residual band the card colours by, and the only band anything else may call quiet.
   tideSurgeColor and tideQuiet both read it, so the fold can never drift from the colour. */
const TIDE_NEUTRAL_FT = 0.5;

// 'unknown' is a station that could not be read or has no prediction to subtract; never 'steady'
function tideBand(r) {
  if (!r || r.ok !== true || typeof r.surge !== 'number' || !Number.isFinite(r.surge)) return 'unknown';
  if (r.surge >= 1.5) return 'major';
  if (r.surge >= TIDE_NEUTRAL_FT) return 'moderate';
  if (r.surge <= -TIDE_NEUTRAL_FT) return 'below';
  return 'steady';
}

/* Nothing worth reading: inside the neutral band AND not moving. An unreadable station and one
   reporting observations with no prediction are UNKNOWN, so neither may ever fold away as calm. */
const tideQuiet = (r) => tideBand(r) === 'steady' && r.dir === 'steady';

const tideSplit = (rows) => {
  const list = Array.isArray(rows) ? rows : [];
  return { loud: list.filter((r) => !tideQuiet(r)), quiet: list.filter((r) => tideQuiet(r)) };
};

/* Station coordinates come from data/tide-meta.json, a committed one-time cache written by
   scripts/gen-tide-meta.py. Per-station metadata requests are not an option at runtime: the card
   already spends two CO-OPS requests per station and the API answers 429 to a burst. */
async function fetchTideMeta() {
  if (state.tideMeta) return;
  try {
    const res = await fetch(`data/tide-meta.json?_=${Date.now()}`);
    if (!res.ok) throw new Error(`tide-meta HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.stations || typeof data.stations !== 'object') throw new Error('tide-meta payload has no stations');
    state.tideMeta = data;
  } catch { /* no cache: every station simply goes without a focus control, and the next load retries */ }
}

function tideStationLatLon(id) {
  const s = ((state.tideMeta || {}).stations || {})[id];
  if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) return null;
  return [s.lat, s.lon];
}

const TIDE_ATTRIB = 'Coastal water levels: NOAA CO-OPS';

function renderTideStations() {
  const layer = (state.layers || {}).tideStations;
  if (!layer) return;
  layer.clearLayers();
  state.tideMarkers = {};
  const rows = Array.isArray(state.tides) ? state.tides : [];
  const lbl = esc(t('layers.tides'));
  for (const r of rows) {
    const ll = tideStationLatLon(r.id);
    if (!ll) continue;
    const icon = L.divIcon({
      className: '',
      html: `<div class="tide-marker tide-${tideBand(r)}" role="img" aria-label="${lbl}" title="${esc(r.name)}"></div>`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    const m = L.marker(ll, { icon, attribution: TIDE_ATTRIB });
    m.bindPopup(() => tidePopupHtml(r));
    layer.addLayer(m);
    state.tideMarkers[r.id] = m;
  }
  // an unreadable coordinate cache is an empty layer, not a coast with no stations
  if (rows.length && !Object.keys(state.tideMarkers).length && !state.tideMetaNoted
      && state.map && state.map.hasLayer(layer)) {
    state.tideMetaNoted = true;
    opNotice(t('note.tidemeta'));
  }
}

function tidePopupHtml(r) {
  const head = `<div class="popup-title">${esc(r.name)}</div>`;
  const cite = `<div class="popup-meta" style="opacity:.7;margin-top:4px">${esc(t('tides.source'))}</div>` +
    '<div class="popup-link"><a href="https://tidesandcurrents.noaa.gov/" target="_blank" rel="noopener">' +
    `${esc(t('word.source'))}</a></div>`;
  if (r.ok !== true) return `${head}<div class="popup-meta">${esc(t('tides.unavail'))}</div>${cite}`;
  const surgeTxt = typeof r.surge === 'number' && Number.isFinite(r.surge)
    ? `${r.surge >= 0 ? '+' : ''}${r.surge.toFixed(1)} ft · ${t(`tides.dir.${r.dir}`)}`
    : t('tides.nopred');
  return head +
    `<div class="popup-meta">${esc(t('tides.col.obs'))}: ${esc(r.obs.toFixed(2))} ft</div>` +
    `<div class="popup-meta">${esc(t('tides.col.surge'))}: ${esc(surgeTxt)}</div>` +
    (r.t ? `<div class="popup-meta">${esc(t('tides.asof').replace('{t}', r.t.slice(11, 16)))}</div>` : '') +
    cite;
}

// the card and the map layer read the same rows, so one repaint feeds both
function paintTides() {
  if (typeof renderTides === 'function') renderTides(); // panels.js is absent from the map-only bundle
  renderTideStations();
}

// refetch unless a fetch is already in flight or we already have fresh (<90s) rows (tab-toggle spam guard)
async function loadTides() {
  if (!coopStations().length) { paintTides(); return; } // inland event: no stations configured, no card
  if (state.tidesLoading) { paintTides(); return; }
  if (state.tides && state.tidesAt && Date.now() - state.tidesAt < 90000) {
    paintTides();
    if (!state.tideMeta) { await fetchTideMeta(); paintTides(); } // a first paint can precede the coordinate cache
    return;
  }
  state.tidesLoading = true;
  paintTides(); // paint the loading state before the network round-trip
  try { await Promise.all([fetchTides(), fetchTideMeta()]); } catch { /* each half swallows its own errors */ }
  finally { state.tidesLoading = false; paintTides(); }
}

