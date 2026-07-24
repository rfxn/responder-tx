'use strict';

// Playback subsystem (split from js/map.js); loads after map.js: every cross-file reference (both directions) is runtime-only, never at load.

// true while playback replays history: live layer/radar/rain-window mutations stay locked
const pbBlocksLive = (s) => !!(s.pb && !s.pb.live);

/* ---------- historical playback (v0.82) — replay archived gauge frames over 3d/7d/14d ----------
   Honest by design: only layers with a real archive replay (gauges from data/history.json,
   radar from IEM archive tiles); alerts/roads/LSRs stay live and the bar says so. */

const PB_RADAR_URL = (stamp) => `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-${stamp}/{z}/{x}/{y}.png`;
// archived MRMS accumulations (probed 2026-07-18: mrms::p{1,24,48,72}h-YYYYMMDDHHMM serves tiles, hourly stamps only)
const PB_MRMS_URL = (w, stamp) => `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/mrms::p${parseInt(w, 10)}h-${stamp}/{z}/{x}/{y}.png`;
const PB_BASE_FRAME_MS = 500; // 1x is ~2 fps — slow enough to read the story (owner ask)
const PB_SPEEDS = [0.5, 1, 2, 4];
const PB_CAT_NAMES = ['none', 'action', 'minor', 'moderate', 'major'];
// prominence: playback-only marker scale — majors ≈ 2× the live size so threats-to-life read first
const PB_CAT_SIZE = { major: 32, moderate: 20, minor: 12, action: 10, none: 7 };
const PB_PULSE_FRAMES = 3;   // category-change ring decays over ~3 frames — visual only
const PB_LABEL_MAX = 5;
const PB_LABEL_MIN_ZOOM = 8;
const PB_ROAD_GLYPH = { Closure: '⛔', Flooding: '🌊', Damage: '⚠' };
const PB_FLOW_MAX = 3;
const PB_RIVER_SPLIT = / (?:at|near|below|above) /i;

/* archived NWS storm-based warnings — OFFICIAL products via IEM sbw.geojson (CORS-open).
   Cached per 15-min bucket (LRU); each poly's polygon_begin/end governs per-frame visibility,
   so frames between fetches honestly reuse the cached set. */
const PB_SBW_URL = (iso) => `https://mesonet.agron.iastate.edu/geojson/sbw.geojson?ts=${encodeURIComponent(iso)}`;
const PB_SBW_BUCKET_MS = 900000;
const PB_SBW_LRU = 40;
const PB_SBW_FLOOD = ['FF', 'FA', 'FL'];
const pbSbw = { buckets: new Map(), inflight: new Map(), warnEvents: new Map(), renderKey: '', visibleN: null };

function pbSbwSev(p) {
  if (p.phenomena === 'SV' || p.phenomena === 'TO') return p.phenomena.toLowerCase();
  if (p.is_emergency) return 'emergency';
  return p.significance === 'Y' ? 'advisory' : 'warning';
}

function pbSbwInAO(geom) {
  const b = CONFIG.gaugeBbox, pad = 0.3;
  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); }
    else c.forEach(walk);
  };
  try { walk(geom.coordinates); } catch { return false; }
  return e >= b.xmin - pad && w <= b.xmax + pad && n >= b.ymin - pad && s <= b.ymax + pad;
}

const pbSbwKey = (p) => `${p.wfo}|${p.phenomena}|${p.significance}|${p.eventid}|${p.year}`;

function pbSbwStore(bucket, features) {
  const keep = [];
  for (const f of features) {
    const p = f.properties || {};
    const flood = PB_SBW_FLOOD.includes(p.phenomena);
    if (!flood && p.phenomena !== 'SV' && p.phenomena !== 'TO') continue;
    if (!f.geometry || !pbSbwInAO(f.geometry)) continue;
    f._b0 = new Date(p.polygon_begin || p.issue).getTime();
    f._b1 = new Date(p.polygon_end || p.expire).getTime();
    keep.push(f);
    if (flood) {
      const k = pbSbwKey(p);
      const ev = pbSbw.warnEvents.get(k) || { issue: Infinity, expire: -Infinity, ps: p.ps, wfo: p.wfo };
      ev.issue = Math.min(ev.issue, new Date(p.issue).getTime());
      ev.expire = Math.max(ev.expire, new Date(p.expire).getTime());
      pbSbw.warnEvents.set(k, ev);
    }
  }
  pbSbw.buckets.set(bucket, keep);
  while (pbSbw.buckets.size > PB_SBW_LRU) pbSbw.buckets.delete(pbSbw.buckets.keys().next().value);
  pbStoryRebuild();
  return keep;
}

function pbSbwFetch(bucket) {
  if (pbSbw.inflight.has(bucket)) return pbSbw.inflight.get(bucket);
  const iso = new Date(bucket).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const p = fetch(PB_SBW_URL(iso))
    .then((r) => { if (!r.ok) throw new Error(`sbw HTTP ${r.status}`); return r.json(); })
    .then((d) => pbSbwStore(bucket, d.features || []))
    .finally(() => pbSbw.inflight.delete(bucket));
  pbSbw.inflight.set(bucket, p);
  return p;
}

// dragging debounces to settle (never per-pixel); play fetches at most one bucket at a time
function pbSbwSchedule() {
  const pb = state.pb;
  if (!pb || pb.live) return;
  pbSbwRender(); // whatever cached polys cover this frame, immediately
  const bucket = Math.floor(state.pbData.frames[pb.idx]._t / PB_SBW_BUCKET_MS) * PB_SBW_BUCKET_MS;
  if (pbSbw.buckets.has(bucket)) {
    const v = pbSbw.buckets.get(bucket);
    pbSbw.buckets.delete(bucket); pbSbw.buckets.set(bucket, v); // LRU touch
    return;
  }
  clearTimeout(pb.sbwTimer);
  if (pb.playing && pbSbw.inflight.size) return; // stay polite to IEM at 2-8 fps
  pb.sbwTimer = setTimeout(() => {
    pbSbwFetch(bucket)
      .then(() => { if (pbBlocksLive(state)) { pbSbwRender(); pbUpdateHud(); } })
      .catch(() => { /* archive fetch failed — warning polys simply absent for this bucket */ });
  }, pb.playing ? 0 : 250);
}

function pbSbwRender() {
  const pb = state.pb;
  if (!pb || pb.live || !state.layers.pbAlerts) return;
  const ft = state.pbData.frames[pb.idx]._t;
  const best = new Map(); // per warning: the cached copy from the bucket nearest the frame
  for (const [bk, feats] of pbSbw.buckets) {
    const d = Math.abs(bk - ft);
    for (const f of feats) {
      if (!(f._b0 <= ft && ft <= f._b1)) continue;
      const k = pbSbwKey(f.properties);
      const cur = best.get(k);
      if (!cur || d < cur.d) best.set(k, { f, d });
    }
  }
  pbSbw.visibleN = pbSbw.buckets.size ? best.size : null;
  const key = Array.from(best.keys()).sort().join(',');
  if (key === pbSbw.renderKey) return;
  pbSbw.renderKey = key;
  state.layers.pbAlerts.clearLayers();
  const order = { advisory: 0, sv: 1, to: 2, warning: 3, emergency: 4 }; // most severe drawn last, lands on top
  const feats = Array.from(best.values()).map((x) => x.f)
    .sort((a, b) => (order[pbSbwSev(a.properties)] || 0) - (order[pbSbwSev(b.properties)] || 0));
  for (const f of feats) {
    const sev = pbSbwSev(f.properties);
    const storm = sev === 'sv' || sev === 'to';
    const layer = L.geoJSON({ type: 'Feature', geometry: f.geometry }, {
      style: {
        className: `alert-poly pb-alert-poly sev-${sev}`,
        weight: sev === 'emergency' ? 2.5 : 1.5,
        fillOpacity: sev === 'emergency' ? 0.22 : storm ? 0.06 : 0.10,
        opacity: 0.9,
        dashArray: storm ? '6 4' : null,
      },
    });
    layer.bindPopup(() => pbSbwPopup(f.properties));
    state.layers.pbAlerts.addLayer(layer);
  }
}

function pbSbwPopup(p) {
  const sev = pbSbwSev(p);
  return `<div class="popup-title">${esc(p.ps || 'NWS warning')}${sev === 'emergency' ? ': <span style="color:var(--sev-emergency);font-weight:700">FLASH FLOOD EMERGENCY</span>' : ''}</div>` +
    `<div class="popup-meta">NWS ${esc(p.wfo || '')} · ${esc(fmtCT(p.polygon_begin || p.issue))} → ${esc(fmtCT(p.polygon_end || p.expire))}</div>` +
    `<div class="popup-meta">${srcBadge('official')} ${esc(t('playback.warnarchive'))}</div>` +
    `<div class="popup-meta" style="color:var(--sev-warning);font-weight:700">⏮ ${esc(t('playback.pill'))} · ${esc(fmtCT(state.pbData.frames[state.pb.idx].t))}</div>` +
    (p.href ? `<div class="popup-link"><a href="${safeUrl(p.href)}" target="_blank" rel="noopener">${esc(t('alert.iemlink'))}</a></div>` : '');
}

/* time-integrity sweep (v0.93): every live overlay either replays from a real archive, re-renders
   as-of the frame from item timestamps, or hides — nothing live may impersonate the past. */
const PB_LIVE_HIDE = [
  ['shelters', 'layers.shelters'],
  ['camsTxdot', 'layers.cams.txdot'],
  ['camsRiver', 'layers.cams.river'],
  ['camsAustin', 'layers.cams.austin'],
  ['camsFlood', 'layers.cams.flood'],
  ['camsHouston', 'layers.cams.houston'],
  ['camsArlington', 'layers.cams.arlington'],
  ['camsElpBridge', 'layers.cams.elpbridge'],
  ['camsHays', 'layers.cams.hays'],
  ['usgs', 'layers.usgs'],
  ['fcstMax', 'layers.fcst'],
  ['fcstRadar', 'layers.fcstradar'],
  ['inundation', 'layers.inun'],
];
const PB_LSR_SHOW_MS = 3 * 3600000; // a storm report stays on the frame for 3h after its valid time
const PB_STORY_TYPES = { evacuation: ['playback.story.evac', 6], cutoff: ['playback.story.cutoff', 6], shelter: ['playback.story.shelter', 4], rescue: ['playback.story.rescue', 5] };

// wrap a live popup (element or html string) with the playback frame stamp
function pbCuratedPopup(content) {
  const wrap = document.createElement('div');
  if (typeof content === 'string') wrap.innerHTML = content;
  else wrap.appendChild(content);
  const meta = document.createElement('div');
  meta.className = 'popup-meta';
  meta.style.cssText = 'color:var(--sev-warning);font-weight:700';
  meta.textContent = `⏮ ${t('playback.pill')} · ${fmtCT(state.pbData.frames[state.pb.idx].t)}`;
  wrap.appendChild(meta);
  return wrap;
}

// device 7d LSR history + the live feed, deduped on the same key recordLsrHist uses
function pbLsrRecords() {
  const seen = new Map(Object.entries(state.hist.lsrs || {}));
  for (const f of state.lsrs || []) {
    if (!f.geometry || !Array.isArray(f.geometry.coordinates)) continue;
    const [lon, lat] = f.geometry.coordinates;
    const p = f.properties;
    seen.set(`${p.valid}|${lat}|${lon}`, {
      t: p.valid, lat, lon, typetext: p.typetext, magnitude: p.magnitude, unit: p.unit,
      city: p.city, county: p.county, source: p.source, remark: p.remark,
    });
  }
  return [...seen.values()];
}

// rebuilt at each engage from current curated data; markers toggle per frame (no re-create churn)
function pbBuildCurated() {
  state.layers.pbCurated = state.layers.pbCurated || L.layerGroup();
  state.layers.pbCurated.clearLayers();
  state.pbCuratedMarks = [];
  const add = (src, m, t0, t1) => {
    state.layers.pbCurated.addLayer(m);
    state.pbCuratedMarks.push({ src, m, t0, t1 });
  };
  for (const r of allRequests()) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon) || !r.ts) continue;
    const t0 = new Date(r.ts).getTime();
    if (!Number.isFinite(t0)) continue;
    const t1 = t0 + (CONFIG.agedCardMinsByType[r.type] || CONFIG.agedCardMins) * 60000;
    if (r.type === 'cutoff' && r.radiusMi > 0 && r.status !== 'resolved') {
      add('requests', L.circle([r.lat, r.lon], {
        radius: r.radiusMi * 1609.34, className: 'cutoff-circle', weight: 2, fillOpacity: 0.07,
      }).bindPopup(() => pbCuratedPopup(cutoffPopup(r))), t0, t1);
    }
    const icon = L.divIcon({
      className: '',
      html: `<div class="req-icon pri-${esc(r.priority)}${r.status === 'resolved' ? ' resolved' : ''}">${TYPE_GLYPH[r.type] || '📍'}</div>`,
      iconSize: [26, 26], iconAnchor: [4, 26],
    });
    add('requests', L.marker([r.lat, r.lon], { icon }).bindPopup(() => pbCuratedPopup(reqPopup(r))), t0, t1);
  }
  // crossing status is only known from its curator update forward — hidden before updated_at
  for (const c of state.crossings || []) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon) || !c.updated_at) continue;
    const t0 = new Date(c.updated_at).getTime();
    if (!Number.isFinite(t0)) continue;
    const st = CROSSING_STATUS[c.status] || CROSSING_STATUS.caution;
    const icon = L.divIcon({ className: '', html: `<div class="crossing-icon" style="border-color:${st.color};color:${st.color}">${st.glyph}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
    add('crossings', L.marker([c.lat, c.lon], { icon }).bindPopup(() => pbCuratedPopup(
      `<div class="popup-title" style="color:${st.color}">${st.glyph} ${esc(xstLabel(st))} · ${esc(t('risk.read.crosspost'))}</div><div>${esc(c.name)} ${srcBadge('curated')}</div>` +
      `<div class="popup-meta">${esc(c.reason || '')}</div><div class="popup-meta">${esc(t('word.updated'))} ${esc(fmtCT(c.updated_at))}</div>`)), t0, Infinity);
  }
  for (const e of pbLsrRecords()) {
    const t0 = new Date(e.t).getTime();
    if (!Number.isFinite(t0) || !Number.isFinite(e.lat) || !Number.isFinite(e.lon)) continue;
    const icon = L.divIcon({ className: '', html: '<div class="lsr-icon">💧</div>', iconSize: [22, 22] });
    add('lsr', L.marker([e.lat, e.lon], { icon }).bindPopup(() => pbCuratedPopup(lsrPopupHtml(e))), t0, t0 + PB_LSR_SHOW_MS);
  }
}

// deep-link engage (?playback=1&pbt=) can precede the seed/LSR fetches — rebuild as-of-frame data when they land
function pbRefreshCurated() {
  const pb = state.pb;
  if (!pb || pb.live || !state.pbData) return;
  pbBuildCurated();
  pbPaintCurated(state.pbData.frames[pb.idx]);
  pbBuildStory();
  pbUpdateCaption();
}

function pbPaintCurated(frame) {
  const pb = state.pb;
  if (!state.pbCuratedMarks || !pb) return;
  for (const x of state.pbCuratedMarks) {
    const el = x.m.getElement && x.m.getElement();
    if (!el) continue;
    const show = (pb.curatedOn || {})[x.src] && x.t0 <= frame._t && frame._t < x.t1;
    el.style.display = show ? '' : 'none';
  }
}

function pbMrmsStampAt(tMs) {
  const d = new Date(Math.floor(tMs / 3600000) * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}00`;
}
const pbMrmsStamp = () => pbMrmsStampAt(state.pbData.frames[state.pb.idx]._t);

// frame code: 0..4 = none..major; negative = stale observation, encoded -(code+1)
function pbDecode(code) {
  const stale = code < 0;
  return { stale, cat: PB_CAT_NAMES[stale ? -code - 1 : code] || 'none' };
}

async function loadPlaybackData() {
  if (state.pbData) return state.pbData;
  const res = await fetch(`data/history.json?_=${Math.floor(Date.now() / 300000)}`);
  if (!res.ok) throw new Error(`history HTTP ${res.status}`);
  const d = await res.json();
  if (!Array.isArray(d.frames) || !d.frames.length) throw new Error('empty history');
  d.frames.forEach((f) => { f._t = new Date(f.t).getTime(); });
  state.pbData = d;
  state.pbRoadsFromT = d.roadsFrom ? new Date(d.roadsFrom).getTime() : Infinity;
  // chapter marks: major-peak gauges from the crest summary, most significant first (best-effort)
  try {
    const cs = await fetch(`data/crest-summary.json?_=${Math.floor(Date.now() / 300000)}`).then((r) => (r.ok ? r.json() : null));
    state.pbCrests = (cs && cs.gauges) || [];
    state.pbChapters = state.pbCrests.filter((g) => g.peak_category === 'major').slice(0, 8);
  } catch { state.pbCrests = []; state.pbChapters = []; }
  state.pbRecordPct = {};
  for (const g of state.pbCrests) { if (g.record && g.record.peak_pct > 0) state.pbRecordPct[g.lid] = g.record.peak_pct; }
  pbBuildCrestFlows();
  return d;
}

/* crest-flow detection (v0.91, illustrative): a crest translating between two gauges on the SAME
   river — consecutive moderate/major peaks (crest summary) ordered by peak time, sanity-gated on
   gap and distance. Drawn as a straight dashed line: honestly schematic, never traced geometry. */
function pbBuildCrestFlows() {
  state.pbFlows = [];
  const gi = state.pbData.gaugeIndex;
  const byRiver = {};
  for (const g of state.pbCrests || []) {
    if (g.stale || !['moderate', 'major'].includes(g.peak_category) || !gi[g.lid]) continue;
    const river = String(g.name || '').split(PB_RIVER_SPLIT)[0].trim();
    if (!river) continue;
    (byRiver[river] = byRiver[river] || []).push(g);
  }
  for (const list of Object.values(byRiver)) {
    list.sort((a, b) => new Date(a.peak_time) - new Date(b.peak_time));
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i], b = list[i + 1];
      const t0 = new Date(a.peak_time).getTime(), t1 = new Date(b.peak_time).getTime();
      const dtH = (t1 - t0) / 3600000;
      if (!(dtH >= 1 && dtH <= 96)) continue; // same-moment peaks or unrelated events: not a translation
      const A = gi[a.lid], B = gi[b.lid];
      const mi = distMi(A.lat, A.lon, B.lat, B.lon);
      if (mi < 3 || mi > 150) continue;
      state.pbFlows.push({
        key: `${a.lid}>${b.lid}`, t0, t1, a: A, b: B, line: null, lbl: null,
        rank: Math.max(CAT_RANK[a.peak_category] || 0, CAT_RANK[b.peak_category] || 0),
      });
    }
  }
}

function pbPaintFlows(frame) {
  if (!state.pbFlows || !state.layers.pbFlows) return;
  const act = state.pbFlows.filter((f) => f.t0 <= frame._t && frame._t <= f.t1)
    .sort((x, y) => y.rank - x.rank).slice(0, PB_FLOW_MAX);
  const key = act.map((f) => f.key).join(',');
  if (key === state.pbFlowKey) return;
  state.pbFlowKey = key;
  state.layers.pbFlows.clearLayers();
  for (const f of act) {
    if (!f.line) {
      f.line = L.polyline([[f.a.lat, f.a.lon], [f.b.lat, f.b.lon]], {
        className: 'pb-crest-line', color: cssVar('--cat-major') || '#e5342f',
        weight: 3, opacity: 0.85, dashArray: '10 8', interactive: false,
      });
      f.lbl = L.marker([(f.a.lat + f.b.lat) / 2, (f.a.lon + f.b.lon) / 2], {
        interactive: false, keyboard: false,
        icon: L.divIcon({ className: '', html: `<div class="pb-crest-lbl">▸ ${esc(t('playback.crestflow'))}</div>`, iconSize: [0, 0] }),
      });
    }
    state.layers.pbFlows.addLayer(f.line).addLayer(f.lbl);
  }
}

/* story engine — gauge category transitions (frame diffs) + moderate/major crests (crest summary)
   + warning lifecycle (SBW cache) + road reopenings (this device's DriveTexas store), merged into
   one time-sorted caption track. Derived data only, nothing interpolated. */
function pbBuildStory() {
  const frames = state.pbData.frames, pb = state.pb;
  const ev = [];
  const first = pbFirstIdx();
  for (let i = first + 1; i < frames.length; i++) {
    const cur = frames[i], prev = frames[i - 1];
    for (const [lid, rec] of Object.entries(cur.gauges)) {
      const p = prev.gauges[lid];
      if (!p || rec[1] < 0 || p[1] < 0 || rec[1] === p[1]) continue; // stale obs: no honest transition
      const gi = state.pbData.gaugeIndex[lid];
      if (!gi) continue;
      const up = rec[1] > p[1];
      ev.push({
        t: cur._t, iso: cur.t, pri: rec[1],
        text: t(up ? 'playback.story.rise' : 'playback.story.fall')
          .replace('{name}', gi.name).replace('{cat}', catLabel(PB_CAT_NAMES[rec[1]])).replace('{v}', rec[0]),
      });
    }
  }
  for (const g of state.pbCrests || []) {
    if (g.stale || !['moderate', 'major'].includes(g.peak_category)) continue;
    const pt = new Date(g.peak_time).getTime();
    if (!(pt >= pb.loT && pt <= pb.hiT)) continue;
    let txt = t('playback.story.crest').replace('{name}', g.name).replace('{v}', g.peak);
    const r = g.record;
    if (r && r.record_ft > 0) {
      txt += t(r.exceeded ? 'playback.story.recordover' : 'playback.story.record')
        .replace('{p}', r.peak_pct).replace('{y}', String(r.record_date || '').slice(0, 4));
    }
    ev.push({ t: pt, iso: g.peak_time, pri: 6, text: txt });
  }
  try {
    for (const r of Object.values(roadMemory().reopened)) {
      if (!reopenIsFlood(r)) continue;
      const rt = new Date(r.reopenedAt).getTime();
      if (!(rt >= pb.loT && rt <= pb.hiT)) continue;
      ev.push({ t: rt, iso: r.reopenedAt, pri: 3, text: t('playback.story.reopen').replace('{road}', prettyRoute(r.route_name) || t('ntype.road')) });
    }
  } catch { /* road memory unavailable — reopen captions simply absent */ }
  // closure-onset captions from the posted start times in the archived road index
  for (const r of Object.values(state.pbData.roadIndex || {})) {
    const st = new Date(r.start).getTime();
    if (!Number.isFinite(st) || st < pb.loT || st > pb.hiT) continue;
    const ct = ROAD_COND[r.cond] || ROAD_COND_FALLBACK;
    ev.push({
      t: st, iso: r.start, pri: 3,
      text: `${PB_ROAD_GLYPH[r.cond] || '🚧'} ${t('playback.story.road').replace('{road}', prettyRoute(r.route) || t('ntype.road')).replace('{cond}', roadLabel(ct))}`,
    });
  }
  // critical-notice / cut-off / evacuation / shelter events from curated timestamps
  for (const r of allRequests()) {
    if (!r.ts) continue;
    const rt = new Date(r.ts).getTime();
    if (!Number.isFinite(rt) || rt < pb.loT || rt > pb.hiT) continue;
    const sig = PB_STORY_TYPES[r.type] || (r.priority === 'critical' ? ['playback.story.critical', 5] : null);
    if (!sig) continue;
    ev.push({
      t: rt, iso: r.ts, pri: sig[1],
      text: `${TYPE_GLYPH[r.type] || '🆘'} ${t(sig[0]).replace('{place}', r.place || r.county || '').replace('{type}', ntypeLabel(r.type))}`,
    });
  }
  state.pbStoryBase = ev;
  pbStoryRebuild();
}

function pbStoryRebuild() {
  const pb = state.pb;
  if (!pb || !state.pbStoryBase) return;
  const ev = state.pbStoryBase.slice();
  for (const w of pbSbw.warnEvents.values()) {
    if (w.issue >= pb.loT && w.issue <= pb.hiT) {
      ev.push({ t: w.issue, iso: new Date(w.issue).toISOString(), pri: 5, text: t('playback.story.warnissued').replace('{ps}', w.ps || 'NWS warning').replace('{wfo}', w.wfo || 'AO') });
    }
    if (w.expire >= pb.loT && w.expire <= pb.hiT) {
      ev.push({ t: w.expire, iso: new Date(w.expire).toISOString(), pri: 2, text: t('playback.story.warnexpired').replace('{ps}', w.ps || 'NWS warning').replace('{wfo}', w.wfo || 'AO') });
    }
  }
  ev.sort((a, b) => a.t - b.t || a.pri - b.pri); // equal-time ties: highest significance last, wins nearest-past
  state.pbStory = ev;
  if (!pb.live) pbUpdateCaption(); // capKey change-detection keeps an unchanged caption from re-flashing
}

function pbUpdateCaption() {
  const pb = state.pb, el = $('#pb-caption');
  if (!el) return;
  if (!pb || pb.live || !state.pbStory) { el.hidden = true; return; }
  const ft = state.pbData.frames[pb.idx]._t;
  let ev = null;
  for (const e of state.pbStory) { if (e.t <= ft) ev = e; else break; }
  if (!ev) { el.hidden = true; return; }
  el.hidden = false;
  const key = `${ev.t}|${ev.text}`;
  if (key === pb.capKey) return;
  pb.capKey = key;
  el.textContent = `${fmtCT(ev.iso)}: ${ev.text}`;
  el.classList.remove('cap-in');
  void el.offsetWidth; // restart the entry transition
  el.classList.add('cap-in');
}

const pbShortName = (name) => { const m = String(name || '').split(/ (?:at|near|below|above) /); return (m[1] || m[0] || '').trim(); };

function pbTopMovers(k) {
  const pb = state.pb, frames = state.pbData.frames;
  if (pb.idx <= pbFirstIdx()) return [];
  const cur = frames[pb.idx], prev = frames[pb.idx - 1];
  const dtH = (cur._t - prev._t) / 3600000;
  if (dtH <= 0) return [];
  const out = [];
  for (const [lid, rec] of Object.entries(cur.gauges)) {
    const p = prev.gauges[lid];
    if (!p || rec[1] < 0 || p[1] < 0) continue;
    const rate = (rec[0] - p[0]) / dtH;
    if (Math.abs(rate) < 0.1) continue;
    const gi = state.pbData.gaugeIndex[lid];
    out.push({ name: pbShortName(gi && gi.name), rate });
  }
  out.sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate));
  return out.slice(0, k);
}

const pbMoverTxt = (m) => `${m.rate > 0 ? '▲' : '▼'} ${esc(m.name)} ${m.rate > 0 ? '+' : ''}${m.rate.toFixed(1)} ft/hr`;

function pbUpdateHud() {
  const pb = state.pb, el = $('#pb-hud');
  if (!el) return;
  if (!pb || pb.live) { el.hidden = true; $('#pb-hud-detail').hidden = true; return; }
  el.hidden = false;
  const frame = state.pbData.frames[pb.idx];
  const n = { major: 0, moderate: 0, minor: 0, action: 0 };
  for (const rec of Object.values(frame.gauges)) { if (rec[1] > 0) n[PB_CAT_NAMES[rec[1]]]++; }
  const mv = pbTopMovers(1)[0];
  el.innerHTML =
    `<span style="color:var(--cat-major)">MAJ ${n.major}</span> · ` +
    `<span style="color:var(--cat-moderate)">MOD ${n.moderate}</span> · ` +
    `<span style="color:var(--cat-minor)">MIN ${n.minor}</span> · ` +
    `<span>⚠ ${pbSbw.visibleN === null ? '–' : pbSbw.visibleN}</span>` +
    (state.pbData.roadIndex ? ` · <span>⛔ ${(frame.roads || []).length}</span>` : '') +
    (mv ? ` · <span>${pbMoverTxt(mv)}</span>` : '');
}

function pbToggleHudDetail() {
  const pb = state.pb, d = $('#pb-hud-detail');
  if (!pb || pb.live) return;
  d.hidden = !d.hidden;
  if (d.hidden) return;
  const movers = pbTopMovers(3);
  const ft = state.pbData.frames[pb.idx]._t;
  const warns = [], seen = new Set();
  for (const feats of pbSbw.buckets.values()) {
    for (const f of feats) {
      if (!(f._b0 <= ft && ft <= f._b1)) continue;
      const k = pbSbwKey(f.properties);
      if (seen.has(k)) continue;
      seen.add(k);
      warns.push(`${f.properties.ps || 'NWS warning'} · ${f.properties.wfo || ''}`);
    }
  }
  d.innerHTML =
    `<div><strong>${esc(t('playback.hud.movers'))}</strong>: ${movers.length ? movers.map(pbMoverTxt).join(' · ') : esc(t('playback.hud.none'))}</div>` +
    `<div><strong>${esc(t('playback.hud.warns'))}</strong>: ${warns.length ? warns.map((w) => esc(w)).join(' · ') : esc(t('playback.hud.none'))}</div>`;
}

async function openPlayback() {
  const pill = $('#pb-pill');
  try { await loadPlaybackData(); } catch {
    pill.classList.add('pb-disabled');
    pill.title = t('playback.unavail');
    $('#refresh-note').textContent = t('playback.unavail');
    return;
  }
  if (!state.pb) state.pb = { days: 3, idx: state.pbData.frames.length - 1, live: true, playing: false, raf: null, lastStep: 0, speed: 0.5, capKey: null };
  state.pb.speed = 0.5; // every entry resets to the readable default; a changed speed lasts only until close
  $('#playback-bar').hidden = false;
  $('#pb-speed').textContent = `${state.pb.speed}×`;
  pill.classList.add('open');
  document.body.classList.add('pb-bar-open');
  pbSheetMin();
  setPlaybackRange(state.pb.days);
  const pbt = Date.parse(new URLSearchParams(location.search).get('pbt') || ''); // deep link: jump to a moment
  if (Number.isFinite(pbt) && !state.pbtApplied) {
    state.pbtApplied = true;
    setPlaybackFrame(pbFrameAt(pbt));
    updatePlaybackNote();
  }
}

function closePlayback() {
  if (!state.pb) return;
  playbackGoLive();
  $('#playback-bar').hidden = true;
  $('#pb-pill').classList.remove('open');
  document.body.classList.remove('pb-bar-open');
}

function togglePlayback() {
  if (state.pb && !$('#playback-bar').hidden) closePlayback();
  else openPlayback();
}

// playback collapses the phone bottom sheet so the map owns the screen; prior state restores on exit/NOW
function pbSheetMin() {
  if (window.innerWidth > 768 || typeof setSheet !== 'function') return;
  const main = document.querySelector('main');
  const cur = SHEET_STATES.find((s) => main.classList.contains(s));
  if (!cur || cur === 'sheet-peek') return;
  state.pbPrevSheet = cur;
  setSheet('sheet-peek');
}
function pbSheetRestore() {
  const prev = state.pbPrevSheet;
  state.pbPrevSheet = null;
  if (!prev || typeof setSheet !== 'function') return;
  // a manual resize during playback wins — only snap back if the pane is still where playback put it
  if (document.querySelector('main').classList.contains('sheet-peek')) setSheet(prev);
}

// window = chosen 3/7/14d; the slider track spans the full request, frames clip to the archive —
// the pre-archive gap renders hatched, never faked with empty frames
function setPlaybackRange(days) {
  const pb = state.pb, frames = state.pbData.frames;
  pb.days = days;
  pb.winLoT = Date.now() - days * 86400000;
  pb.loT = Math.max(pb.winLoT, frames[0]._t);
  pb.hiT = frames[frames.length - 1]._t;
  document.querySelectorAll('.pb-chip').forEach((b) => b.classList.toggle('on', +b.dataset.days === days));
  const sl = $('#pb-slider');
  sl.min = pb.winLoT;
  sl.max = pb.hiT;
  sl.step = 60000;
  renderPlaybackPreArchive();
  renderPlaybackTicks();
  pbBuildStory();
  if (pb.live) { sl.value = pb.hiT; updatePlaybackReadout(); } else setPlaybackFrame(pb.idx);
  updatePlaybackNote();
}

function renderPlaybackPreArchive() {
  const pb = state.pb, frames = state.pbData.frames;
  const el = $('#pb-prearch');
  const frac = (frames[0]._t - pb.winLoT) / (pb.hiT - pb.winLoT || 1);
  el.hidden = frac <= 0.004;
  el.style.width = `${Math.min(Math.max(frac, 0), 1) * 100}%`;
  if (!el.hidden) pbFlashArchNote();
}

// transient flash of the sheet's locked message — layer pills share the playback read-only regime
function pbLayersLockedNote() {
  const el = $('#pb-arch-note');
  if (!el) return;
  el.textContent = t('sheet.locked');
  el.hidden = false;
  clearTimeout(state.pbArchNoteTimer);
  state.pbArchNoteTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

// one prominent flash per session the first time a chosen range reaches before the archive's birth
function pbFlashArchNote() {
  if (state.pbArchNoted) return;
  state.pbArchNoted = true;
  const el = $('#pb-arch-note');
  el.textContent = t('playback.archnote').replace('{t}', fmtCT(state.pbData.frames[0].t));
  el.hidden = false;
  clearTimeout(state.pbArchNoteTimer);
  state.pbArchNoteTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

function pbFrameAt(tMs) {
  const frames = state.pbData.frames;
  let best = 0;
  for (let i = 0; i < frames.length; i++) { if (frames[i]._t <= tMs) best = i; else break; }
  return Math.max(best, pbFirstIdx());
}
function pbFirstIdx() {
  const frames = state.pbData.frames;
  for (let i = 0; i < frames.length; i++) { if (frames[i]._t >= state.pb.loT) return i; }
  return frames.length - 1;
}

function renderPlaybackTicks() {
  const pb = state.pb;
  const el = $('#pb-ticks');
  el.innerHTML = '';
  for (const g of state.pbChapters || []) {
    const pt = new Date(g.peak_time).getTime();
    if (!(pt >= pb.loT && pt <= pb.hiT)) continue;
    const b = document.createElement('button');
    b.className = 'pb-tick';
    b.textContent = '▲';
    b.style.left = `${((pt - pb.winLoT) / (pb.hiT - pb.winLoT || 1)) * 100}%`;
    b.title = `${g.name} crest ${g.peak} ${g.unit || 'ft'}`;
    b.addEventListener('click', () => { stopPlaybackPlay(); setPlaybackFrame(pbFrameAt(pt)); });
    el.appendChild(b);
  }
}

// build once per session: one marker per archived gauge, mutated per frame (8 fps re-create would churn)
function pbEnsureMarkers() {
  if (state.pbMarkers) return;
  state.layers.pbGauges = state.layers.pbGauges || L.layerGroup();
  state.pbMarkers = {};
  for (const [lid, gi] of Object.entries(state.pbData.gaugeIndex)) {
    const icon = L.divIcon({
      className: '',
      // children order is load-bearing: [0]=pulse ring, [1]=dot, [2]=callout label (pbPaintMarkers)
      html: '<div class="gauge-hit pb-ghit"><div class="pb-ring" hidden></div><div class="gauge-icon cat-none" style="width:8px;height:8px"></div><div class="pb-glabel" hidden></div></div>',
      iconSize: [40, 40],
      iconAnchor: [20, 20],
    });
    const m = L.marker([gi.lat, gi.lon], { icon });
    m.bindPopup(() => pbPopup(lid), { minWidth: 240 });
    state.layers.pbGauges.addLayer(m);
    state.pbMarkers[lid] = m;
  }
}

function pbPopup(lid) {
  const pb = state.pb;
  const frame = state.pbData.frames[pb.idx];
  const gi = state.pbData.gaugeIndex[lid];
  const rec = frame.gauges[lid];
  if (!rec) return '';
  const { stale, cat } = pbDecode(rec[1]);
  return `<div class="popup-title">${esc(gi.name)}</div>` +
    `<div class="popup-meta"><span class="cat-word" style="color:var(--cat-${stale ? 'none' : cat})">${esc(catLabel(cat))}</span> · ${fmtNum(rec[0])} ft</div>` +
    (stale ? `<div class="popup-meta stale-note">⏱ ${esc(t('playback.stale'))}</div>` : '') +
    `<div class="popup-meta" style="color:var(--sev-warning);font-weight:700">⏮ ${esc(t('playback.pill'))} · ${esc(fmtCT(frame.t))}</div>`;
}

function pbPaintMarkers(frame) {
  const prev = state.pbPrevCodes || {};
  const pulse = state.pbPulse || (state.pbPulse = {});
  const next = {};
  for (const [lid, m] of Object.entries(state.pbMarkers)) {
    const el = m.getElement();
    if (!el) continue;
    const rec = frame.gauges[lid];
    if (!rec) { el.style.display = 'none'; delete pulse[lid]; continue; }
    el.style.display = '';
    next[lid] = rec[1];
    const { stale, cat } = pbDecode(rec[1]);
    const hit = el.firstChild;
    hit.className = `gauge-hit pb-ghit${cat === 'none' && !stale ? ' hit-none' : ''}`;
    const [ring, dot] = hit.children;
    dot.className = `gauge-icon ${stale ? 'stale' : `cat-${cat}`}`;
    const size = stale ? 11 : PB_CAT_SIZE[cat];
    dot.style.width = `${size}px`;
    dot.style.height = `${size}px`;
    // colored pulse ring on a category change this frame (stale codes carry no honest transition)
    if (lid in prev && prev[lid] !== rec[1] && prev[lid] >= 0 && rec[1] >= 0) pulse[lid] = PB_PULSE_FRAMES;
    if (pulse[lid] > 0) {
      pulse[lid]--;
      ring.hidden = false;
      ring.className = `pb-ring cat-${cat}`;
      ring.style.animation = 'none';
      void ring.offsetWidth; // restart the ring animation on consecutive changes
      ring.style.animation = '';
    } else { ring.hidden = true; delete pulse[lid]; }
    m.setZIndexOffset(cat === 'major' ? 1000 : cat === 'moderate' ? 500 : 0);
  }
  state.pbPrevCodes = next;
  pbUpdateLabels(frame);
}

/* top-5 significant-gauge callouts — always-visible name+stage labels, majors before moderates
   (threats-to-life first), then proximity to record, then stage; collision-nudged, hidden < z8 */
function pbUpdateLabels(frame) {
  const marks = state.pbMarkers;
  const placed = [];
  if (state.map.getZoom() >= PB_LABEL_MIN_ZOOM) {
    const cands = [];
    for (const [lid, rec] of Object.entries(frame.gauges)) {
      if (rec[1] < 2 || !marks[lid]) continue; // flooding gauges only (minor and up), never stale
      cands.push({ lid, code: rec[1], pct: (state.pbRecordPct || {})[lid] || 0, stage: rec[0] });
    }
    cands.sort((a, b) => b.code - a.code || b.pct - a.pct || b.stage - a.stage);
    for (const c of cands.slice(0, PB_LABEL_MAX)) {
      const el = marks[c.lid].getElement();
      if (!el) continue;
      const lbl = el.firstChild.children[2];
      const gi = state.pbData.gaugeIndex[c.lid];
      lbl.textContent = `${pbShortName(gi.name)} ${fmtNum(c.stage)} ft`;
      lbl.hidden = false;
      c.pt = state.map.latLngToContainerPoint(marks[c.lid].getLatLng());
      c.dy = 0;
      placed.push(c);
    }
  }
  const shown = new Set(placed.map((c) => c.lid));
  for (const lid of state.pbLabeled || []) {
    if (shown.has(lid)) continue;
    const el = marks[lid] && marks[lid].getElement();
    if (el) el.firstChild.children[2].hidden = true;
  }
  state.pbLabeled = shown;
  // collision nudge: sweep top-to-bottom, push an overlapping label below its neighbor
  placed.sort((a, b) => a.pt.y - b.pt.y);
  let last = null;
  for (const c of placed) {
    if (last && Math.abs(c.pt.x - last.pt.x) < 150 && c.pt.y - (last.pt.y + last.dy) < 18) {
      c.dy = last.pt.y + last.dy + 18 - c.pt.y;
    }
    marks[c.lid].getElement().firstChild.children[2].style.transform = c.dy ? `translate(-50%, ${c.dy}px)` : '';
    last = c;
  }
}

/* road-closure replay (v0.91) — archived/reconstructed DriveTexas records at their first vertex */
function pbEnsureRoadMarkers() {
  if (state.pbRoadMarkers || !state.pbData.roadIndex) return;
  state.layers.pbRoads = L.layerGroup();
  state.pbRoadMarkers = {};
  for (const [rid, r] of Object.entries(state.pbData.roadIndex)) {
    if (!Array.isArray(r.v) || r.v.length !== 2) continue;
    const icon = L.divIcon({
      className: '',
      html: `<div class="pb-road" style="border-color:${(ROAD_COND[r.cond] || ROAD_COND_FALLBACK).color}">${PB_ROAD_GLYPH[r.cond] || '🚧'}</div>`,
      iconSize: [22, 22], iconAnchor: [11, 11],
    });
    const m = L.marker(r.v, { icon });
    m.bindPopup(() => pbRoadPopup(rid), { minWidth: 220 });
    state.layers.pbRoads.addLayer(m);
    state.pbRoadMarkers[rid] = m;
  }
}

function pbRoadPopup(rid) {
  const r = state.pbData.roadIndex[rid];
  const frame = state.pbData.frames[state.pb.idx];
  const ct = ROAD_COND[r.cond] || ROAD_COND_FALLBACK;
  const arch = frame._t >= state.pbRoadsFromT;
  return `<div class="popup-title" style="color:${ct.color}">${PB_ROAD_GLYPH[r.cond] || '🚧'} ${esc(prettyRoute(r.route) || t('word.road'))} · ${esc(roadLabel(ct))}</div>` +
    `<div class="popup-meta">${esc(t('playback.road.window'))}: ${esc(fmtCT(r.start))} → ${r.end ? esc(fmtCT(r.end)) : esc(t('playback.road.noend'))}</div>` +
    `<div class="popup-meta">${srcBadge('official')} ${esc(t(arch ? 'playback.road.arch' : 'playback.road.recon'))}</div>` +
    `<div class="popup-meta" style="color:var(--sev-warning);font-weight:700">⏮ ${esc(t('playback.pill'))} · ${esc(fmtCT(frame.t))}</div>`;
}

function pbPaintRoads(frame) {
  if (!state.pbRoadMarkers) return;
  const active = new Set(frame.roads || []);
  for (const [rid, m] of Object.entries(state.pbRoadMarkers)) {
    const el = m.getElement();
    if (el) el.style.display = active.has(+rid) ? '' : 'none';
  }
}

/* archive tile cross-fade (v0.93.1) — two persistent A/B layers per archive source: a bucket
   change loads into the hidden layer, fades in on its 'load' event, then roles swap, so the
   visible layer never blanks mid-replay; unchanged buckets are skipped outright. */
const PB_FADE_FALLBACK_MS = 2500; // archive gap: fade anyway if 'load' never fires

function pbFaderCreate(urlFor, opts, opacity, stamp) {
  const fd = { urlFor, opacity, stamp, front: null, back: null, pending: null, wanted: false, loaded: false, backOn: false, timer: null, onIdle: null };
  const mk = (op) => {
    const lyr = L.tileLayer(urlFor(stamp), Object.assign({ opacity: op }, opts));
    lyr.on('load', () => { if (fd.back === lyr && fd.pending !== null) pbFaderLoaded(fd); });
    return lyr;
  };
  fd.front = mk(opacity).addTo(state.map);
  fd.back = mk(0);
  pbFaderTagXfade(fd.front);
  return fd;
}

function pbFaderTagXfade(lyr) {
  if (lyr._container) lyr._container.classList.add('pb-xfade'); // tile layers expose no public container accessor
}

function pbFaderLoad(fd, stamp) {
  fd.pending = stamp;
  fd.loaded = false;
  if (fd.backOn) { fd.back.setUrl(fd.urlFor(stamp)); return; }
  fd.back.setUrl(fd.urlFor(stamp), true); // noRedraw — the addTo below does the first fetch
  fd.back.addTo(state.map);
  fd.backOn = true;
  pbFaderTagXfade(fd.back);
}

function pbFaderLoaded(fd) {
  fd.loaded = true;
  clearTimeout(fd.timer);
  fd.timer = null;
  if (fd.wanted) pbFaderFade(fd);
}

function pbFaderFade(fd) {
  fd.front.setOpacity(0);
  fd.back.setOpacity(fd.opacity);
  const old = fd.front;
  fd.front = fd.back;
  fd.back = old;
  fd.stamp = fd.pending;
  fd.pending = null;
  fd.wanted = false;
  fd.loaded = false;
  clearTimeout(fd.timer);
  fd.timer = null;
  if (fd.onIdle) fd.onIdle();
}

// per-frame decision: 'skip' (bucket unchanged), 'pending' (already loading), 'fade' (preloaded), 'load'
function pbFaderSet(fd, stamp) {
  if (stamp === fd.stamp) { fd.wanted = false; return 'skip'; } // back onto the shown bucket — any pending demotes to prefetch
  if (stamp === fd.pending) {
    fd.wanted = true;
    if (fd.loaded) { pbFaderFade(fd); return 'fade'; }
    // prefetched bucket still loading — arm the same archive-gap fallback the 'load' path gets
    if (!fd.timer) fd.timer = setTimeout(() => { if (fd.pending === stamp && fd.wanted) pbFaderFade(fd); }, PB_FADE_FALLBACK_MS);
    return 'pending';
  }
  pbFaderLoad(fd, stamp);
  fd.wanted = true;
  clearTimeout(fd.timer);
  fd.timer = setTimeout(() => { if (fd.pending === stamp && fd.wanted) pbFaderFade(fd); }, PB_FADE_FALLBACK_MS);
  return 'load';
}

// while playing, warm the hidden buffer with the next frame's bucket as soon as a fade settles
function pbFaderPrefetchNext(fd, stampAt) {
  const pb = state.pb;
  if (!pb || pb.live || !pb.playing || pb.idx + 1 >= state.pbData.frames.length) return;
  const stamp = stampAt(state.pbData.frames[pb.idx + 1]._t);
  if (stamp !== fd.stamp && stamp !== fd.pending) pbFaderLoad(fd, stamp);
}

// scrub drags settle 250ms before a new bucket loads (SBW pattern); play applies instantly
function pbFaderSchedule(fd, key, stamp) {
  const pb = state.pb;
  clearTimeout(pb[key]);
  if (pb.playing || stamp === fd.stamp || stamp === fd.pending) { pbFaderSet(fd, stamp); return; }
  pb[key] = setTimeout(() => { if (pbBlocksLive(state)) pbFaderSet(fd, stamp); }, 250);
}

function pbFaderDestroy(fd) {
  clearTimeout(fd.timer);
  fd.onIdle = null;
  state.map.removeLayer(fd.front);
  if (fd.backOn) state.map.removeLayer(fd.back);
}

// engage: swap the live gauge + alert layers for archive layers, badge the view, archive the radar if it's on
function playbackEngage() {
  const pb = state.pb;
  if (!pb.live) return;
  pb.live = false;
  pb.rtlWasIdx = state.rtl.idx; // captured before PB_LIVE_HIDE strips the forecast layer
  rtlStopPlay();
  pbSheetMin(); // re-engaging after NOW re-collapses the pane
  pbEnsureMarkers();
  pb.gaugesWereOn = state.map.hasLayer(state.layers.gauges);
  if (pb.gaugesWereOn) state.map.removeLayer(state.layers.gauges);
  state.layers.pbGauges.addTo(state.map);
  pb.alertsWereOn = state.map.hasLayer(state.layers.alerts);
  if (pb.alertsWereOn) state.map.removeLayer(state.layers.alerts);
  state.layers.pbAlerts = state.layers.pbAlerts || L.layerGroup();
  state.layers.pbAlerts.addTo(state.map);
  // roads replay only when the archive carries a roadIndex — otherwise live roads stay, note says live
  if (state.pbData.roadIndex) {
    pbEnsureRoadMarkers();
    pb.roadsWereOn = state.map.hasLayer(state.layers.roadClosures);
    if (pb.roadsWereOn) state.map.removeLayer(state.layers.roadClosures);
    state.layers.pbRoads.addTo(state.map);
  }
  state.layers.pbFlows = state.layers.pbFlows || L.layerGroup();
  state.layers.pbFlows.addTo(state.map);
  state.pbFlowKey = '';
  pbSbw.renderKey = '';
  pbSbw.visibleN = null;
  // time-integrity: timestamped curated/report layers re-render as-of the frame; live-only layers hide
  pb.liveOff = {};
  for (const k of ['requests', 'crossings', 'lsrs', 'lsrsAged'].concat(PB_LIVE_HIDE.map((x) => x[0]))) {
    pb.liveOff[k] = !!(state.layers[k] && state.map.hasLayer(state.layers[k]));
    if (pb.liveOff[k]) state.map.removeLayer(state.layers[k]);
  }
  pb.curatedOn = { requests: pb.liveOff.requests, crossings: pb.liveOff.crossings, lsr: pb.liveOff.lsrs || pb.liveOff.lsrsAged };
  pbBuildCurated();
  state.layers.pbCurated.addTo(state.map);
  document.body.classList.toggle('pb-tween', pb.speed <= 1);
  document.body.classList.add('pb-on');
  $('#pb-badge').hidden = false;
  $('#pb-now').classList.add('armed');
  rtlSync(); // the unified radar timeline hides — the playback bar owns time while engaged
  if (state.map.hasLayer(state.layers.radar)) {
    if (state.radar) state.radar.frameLayers.forEach((l) => l.setOpacity(0));
    pb.radarFader = pbFaderCreate(PB_RADAR_URL, {
      pane: 'radar', maxNativeZoom: 8, maxZoom: 19, attribution: 'Radar archive: IEM NEXRAD',
    }, 0.75, pbRadarStamp());
    pb.radarFader.onIdle = () => pbFaderPrefetchNext(pb.radarFader, pbRadarStampAt);
  }
  // rainfall replays from the IEM MRMS archive (hourly stamps) in the user's chosen window
  pb.mrmsWasOn = state.map.hasLayer(state.layers.mrms);
  if (pb.mrmsWasOn) {
    state.map.removeLayer(state.layers.mrms);
    pb.mrmsFader = pbFaderCreate((s) => PB_MRMS_URL(state.rainWindow, s), {
      attribution: 'Rainfall archive: MRMS via IEM',
    }, 0.55, pbMrmsStamp());
    pb.mrmsFader.onIdle = () => pbFaderPrefetchNext(pb.mrmsFader, pbMrmsStampAt);
  }
  updatePlaybackNote();
  layerSheetSync();
  renderTiles(); // threat strip gains its "LIVE below / replay on map" note
}

// NOW: instant, total restore of the live picture
function playbackGoLive() {
  const pb = state.pb;
  if (!pb) return;
  pbSheetRestore();
  if (pb.live) return;
  stopPlaybackPlay();
  pb.live = true;
  if (state.map.hasLayer(state.layers.pbGauges)) state.map.removeLayer(state.layers.pbGauges);
  if (pb.gaugesWereOn && !state.map.hasLayer(state.layers.gauges)) state.layers.gauges.addTo(state.map);
  // archived warning polys clear instantly — never linger over the live picture
  if (state.layers.pbAlerts) {
    state.layers.pbAlerts.clearLayers();
    if (state.map.hasLayer(state.layers.pbAlerts)) state.map.removeLayer(state.layers.pbAlerts);
  }
  if (pb.alertsWereOn && !state.map.hasLayer(state.layers.alerts)) state.layers.alerts.addTo(state.map);
  if (state.layers.pbRoads && state.map.hasLayer(state.layers.pbRoads)) state.map.removeLayer(state.layers.pbRoads);
  if (pb.roadsWereOn && !state.map.hasLayer(state.layers.roadClosures)) state.layers.roadClosures.addTo(state.map);
  if (state.layers.pbFlows) {
    state.layers.pbFlows.clearLayers();
    if (state.map.hasLayer(state.layers.pbFlows)) state.map.removeLayer(state.layers.pbFlows);
  }
  state.pbFlowKey = '';
  state.pbPrevCodes = null;
  state.pbPulse = null;
  clearTimeout(pb.sbwTimer);
  pbSbw.renderKey = '';
  pbSbw.visibleN = null;
  // drop the as-of-frame curated layer, restore every live layer exactly as it was
  if (state.layers.pbCurated) {
    state.layers.pbCurated.clearLayers();
    if (state.map.hasLayer(state.layers.pbCurated)) state.map.removeLayer(state.layers.pbCurated);
  }
  state.pbCuratedMarks = null;
  for (const k of Object.keys(pb.liveOff || {})) {
    if (pb.liveOff[k] && state.layers[k] && !state.map.hasLayer(state.layers[k])) state.layers[k].addTo(state.map);
  }
  pb.liveOff = {};
  clearTimeout(pb.radarSettle);
  clearTimeout(pb.mrmsSettle);
  if (pb.mrmsFader) { pbFaderDestroy(pb.mrmsFader); pb.mrmsFader = null; }
  if (pb.mrmsWasOn && !state.map.hasLayer(state.layers.mrms)) state.layers.mrms.addTo(state.map);
  pb.mrmsWasOn = false;
  if (pb.radarFader) { pbFaderDestroy(pb.radarFader); pb.radarFader = null; }
  rtlSync(); // unified radar timeline restores exactly as it was before engage
  if (pb.rtlWasIdx != null && rtlDomain().total) rtlSet(pb.rtlWasIdx);
  pb.rtlWasIdx = null;
  document.body.classList.remove('pb-on');
  document.body.classList.remove('pb-tween');
  $('#pb-badge').hidden = true;
  $('#pb-now').classList.remove('armed');
  $('#pb-caption').hidden = true;
  $('#pb-hud').hidden = true;
  $('#pb-hud-detail').hidden = true;
  pb.capKey = null;
  $('#pb-slider').value = pb.hiT;
  updatePlaybackReadout();
  updatePlaybackNote();
  layerSheetSync();
  renderTiles();
}

function pbRadarStampAt(tMs) {
  const d = new Date(Math.floor(tMs / 300000) * 300000); // IEM archive is 5-min steps
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}
const pbRadarStamp = () => pbRadarStampAt(state.pbData.frames[state.pb.idx]._t);

function setPlaybackFrame(i) {
  const pb = state.pb, frames = state.pbData.frames;
  pb.idx = Math.max(pbFirstIdx(), Math.min(i, frames.length - 1)); // before engage — faders must stamp from the target frame, not the pre-jump idx
  playbackEngage();
  const frame = frames[pb.idx];
  pbPaintMarkers(frame);
  pbPaintRoads(frame);
  pbPaintFlows(frame);
  if (pb.radarFader) pbFaderSchedule(pb.radarFader, 'radarSettle', pbRadarStampAt(frame._t));
  if (pb.mrmsFader) pbFaderSchedule(pb.mrmsFader, 'mrmsSettle', pbMrmsStampAt(frame._t));
  pbPaintCurated(frame);
  $('#pb-slider').value = frame._t;
  updatePlaybackReadout();
  pbSbwSchedule();
  pbUpdateHud();
  pbUpdateCaption();
}

function updatePlaybackReadout() {
  const pb = state.pb;
  if (pb.live) {
    $('#pb-time').textContent = t('playback.live');
    $('#pb-time').classList.add('live');
    return;
  }
  const frame = state.pbData.frames[pb.idx];
  $('#pb-time').textContent = fmtCT(frame.t);
  $('#pb-time').classList.remove('live');
  $('#pb-badge-t').textContent = fmtCT(frame.t);
}

// truth line: which layers replay vs re-render as-of the frame vs hide, incl. the viewer's own 7d alert history
function updatePlaybackNote() {
  const pb = state.pb;
  const hasRoads = !pb.live && !!state.pbData.roadIndex;
  const roadsNote = hasRoads
    ? t(state.pbData.frames[pb.idx]._t >= state.pbRoadsFromT ? 'playback.note.roads.arch' : 'playback.note.roads.recon')
    : '';
  let note = pb.live ? t('playback.note.idle')
    : `${t('playback.note.replay')}${t('playback.note.warn')}${roadsNote}${pb.radarFader ? t('playback.note.radar') : ''}`;
  if (!pb.live) {
    if (pb.mrmsFader) {
      const hour = fmtCT(new Date(Math.floor(state.pbData.frames[pb.idx]._t / 3600000) * 3600000).toISOString());
      note += t('playback.note.rain').replace('{w}', state.rainWindow).replace('{t}', hour);
    }
    const filt = [];
    if (pb.curatedOn && pb.curatedOn.requests) filt.push(t('layers.notices'));
    if (pb.curatedOn && pb.curatedOn.crossings) filt.push(t('layers.crossings'));
    if (pb.curatedOn && pb.curatedOn.lsr) filt.push(t('layers.lsr'));
    if (filt.length) note += ` · ${t('playback.note.filtered').replace('{list}', filt.join(', '))}`;
    const hidden = PB_LIVE_HIDE.filter(([k]) => pb.liveOff && pb.liveOff[k]).map(([, key]) => t(key));
    if (hidden.length) note += ` · ${t('playback.note.hidden').replace('{list}', hidden.join(', '))}`;
    if (!hasRoads) note += ` · ${t('playback.note.live')}`;
  }
  if (!pb.live) {
    const ft = state.pbData.frames[pb.idx]._t;
    const n = Object.values(state.hist.alerts || {}).filter((a) => {
      const s = new Date(a.t).getTime(), e = a.expires ? new Date(a.expires).getTime() : 0;
      return s <= ft && e >= ft;
    }).length;
    if (n) note += ` · ${t('playback.note.alerthist').replace('{n}', n)}`;
    if (state.pbData.frames[pbFirstIdx()]._t > pb.winLoT + 60000) {
      note += ` · ${t('playback.note.start').replace('{t}', fmtCT(state.pbData.frames[0].t))}`;
    }
  }
  $('#pb-note').textContent = note;
}

function stopPlaybackPlay() {
  const pb = state.pb;
  if (!pb) return;
  pb.playing = false;
  if (pb.raf) { cancelAnimationFrame(pb.raf); pb.raf = null; }
  $('#pb-play').textContent = '▶';
}

function togglePlaybackPlay() {
  const pb = state.pb;
  if (!pb) return;
  if (pb.playing) { stopPlaybackPlay(); return; }
  if (pb.live || pb.idx >= state.pbData.frames.length - 1) setPlaybackFrame(pbFirstIdx()); // play from window start
  pb.playing = true;
  $('#pb-play').textContent = '⏸';
  pb.lastStep = 0;
  const step = (ts) => {
    if (!pb.playing) return;
    if (ts - pb.lastStep >= PB_BASE_FRAME_MS / pb.speed) {
      pb.lastStep = ts;
      if (pb.idx >= state.pbData.frames.length - 1) { stopPlaybackPlay(); updatePlaybackNote(); return; }
      setPlaybackFrame(pb.idx + 1);
      updatePlaybackNote();
    }
    pb.raf = requestAnimationFrame(step);
  };
  pb.raf = requestAnimationFrame(step);
}

function pbCycleSpeed() {
  const pb = state.pb;
  if (!pb) return;
  pb.speed = PB_SPEEDS[(PB_SPEEDS.indexOf(pb.speed) + 1) % PB_SPEEDS.length];
  $('#pb-speed').textContent = `${pb.speed}×`;
  // 0.5-1x: tween marker size/color between frames — visual transition only, readout stays the real frame time
  document.body.classList.toggle('pb-tween', pb.speed <= 1 && !pb.live);
}

function pbStepFrame(d) {
  const pb = state.pb;
  if (!pb) return;
  stopPlaybackPlay();
  setPlaybackFrame((pb.live ? state.pbData.frames.length - 1 : pb.idx) + d);
  updatePlaybackNote();
}

function initPlaybackControls() {
  // over-map controls must never leak taps into Leaflet (double-tap zoom, pinch) — same guard as AO chips/layer pills
  for (const sel of ['#playback-bar', '#pb-pill', '#pb-badge', '#radar-scrub']) {
    const el = $(sel);
    if (!el) continue;
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);
  }
  $('#pb-pill').addEventListener('click', togglePlayback);
  $('#pb-play').addEventListener('click', togglePlaybackPlay);
  $('#pb-now').addEventListener('click', playbackGoLive);
  $('#pb-close').addEventListener('click', closePlayback);
  $('#pb-speed').addEventListener('click', pbCycleSpeed);
  $('#pb-back').addEventListener('click', () => pbStepFrame(-1));
  $('#pb-fwd').addEventListener('click', () => pbStepFrame(1));
  $('#pb-caption').addEventListener('click', stopPlaybackPlay); // tap the caption = pause
  $('#pb-hud').addEventListener('click', pbToggleHudDetail);
  // callout labels hide below z8 and re-nudge on zoom — recompute against the current frame
  if (state.map) state.map.on('zoomend', () => { if (pbBlocksLive(state)) pbUpdateLabels(state.pbData.frames[state.pb.idx]); });
  $('#pb-slider').addEventListener('input', () => {
    stopPlaybackPlay();
    setPlaybackFrame(pbFrameAt(+$('#pb-slider').value));
    updatePlaybackNote();
  });
  document.querySelectorAll('.pb-chip').forEach((b) => b.addEventListener('click', () => {
    stopPlaybackPlay();
    setPlaybackRange(+b.dataset.days);
    updatePlaybackNote();
  }));
}

