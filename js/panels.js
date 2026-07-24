'use strict';

function renderForecastList() {
  const el = $('#forecast-list');
  const rising = state.gauges
    .filter((g) => gaugeRising(g) && CAT_RANK[gaugeForecastCat(g)] >= CAT_RANK.minor)
    .sort((a, b) => CAT_RANK[gaugeForecastCat(b)] - CAT_RANK[gaugeForecastCat(a)]
      || new Date(a.status.forecast.validTime) - new Date(b.status.forecast.validTime));
  el.innerHTML = `<div class="section-title">${esc(t('sec.forecast'))}</div>`;
  if (!rising.length) { el.innerHTML += `<div class="card">${esc(t('sec.forecast.empty'))}</div>`; return; }
  for (const g of rising) {
    const fCat = gaugeForecastCat(g);
    const f = g.status.forecast;
    const div = document.createElement('div');
    div.className = 'card';
    div.style.borderLeftColor = `var(--cat-${fCat})`;
    div.innerHTML = `<div class="head"><span>▲</span><span class="type-chip">${esc(catLabel(gaugeCat(g)))} → <span style="color:var(--cat-${fCat})">${esc(catLabel(fCat))}</span></span>` +
      `<span class="when">${esc(t('wave.crest'))} ${esc(fmtWhen(f.validTime))}</span></div>` +
      `<div class="summary">${esc(g.name)}: ${esc(t('gauge.fcrest').toLowerCase())} ${fmtNum(f.primary)} ${esc(f.primaryUnit)}</div>`;
    div.addEventListener('click', () => state.map.setView([g.latitude, g.longitude], 11));
    el.appendChild(div);
  }
}

/* ---------- gauges tab — bucketed by actionability ---------- */

function focusGauge(g) {
  flyOpenPopup([g.latitude, g.longitude], 11, state.gaugeMarkers && state.gaugeMarkers[g.lid]);
  // phone layout: the map is above the scrolled list — make the pan visible
  if (window.innerWidth <= 768) $('#map').scrollIntoView({ behavior: 'smooth' });
}

function gaugeGlyphHtml(g) {
  if (gaugeObsStale(g)) return `<span class="stale-glyph" title="${esc(t('gauge.staleglyph'))}">⏱</span>`;
  if (gaugeRising(g)) return `<span style="color:var(--cat-${gaugeForecastCat(g)})">▲</span>`;
  const cat = gaugeCat(g);
  if (cat === 'none') return '<span style="color:var(--cat-none)">○</span>';
  if ((gaugeTrend(g.lid) || {}).dir === 'down') return '<span style="color:var(--good)">▼</span>';
  return `<span style="color:var(--cat-${cat})">●</span>`;
}

function gaugeCardDiv(g) {
  const stale = gaugeObsStale(g);
  const cat = gaugeObsCat(g);
  const o = g.status.observed;
  const tr = stale ? null : gaugeTrend(g.lid);
  const fCat = gaugeForecastCat(g);
  const f = g.status.forecast;
  const site = g.name.slice(riverOf(g.name).length).trim();
  const div = document.createElement('div');
  div.className = `card gauge-card${stale ? ' stale' : (cat === 'none' && !gaugeRising(g) ? ' aged' : '')}`;
  div.dataset.lid = g.lid;
  div.style.borderLeftColor = stale ? 'var(--cat-none)' : `var(--cat-${cat})`;
  const trendBit = tr ? ` ${tr.dir === 'up' ? '↑' : tr.dir === 'down' ? '↓' : '→'} ${tr.rate >= 0 ? '+' : ''}${tr.rate.toFixed(1)} ft/hr` : '';
  div.innerHTML = `<div class="head">${gaugeGlyphHtml(g)}<span class="g-name">${esc(g.name)}</span>` +
    `<span class="geo-flag" title="${esc(t('sync.geoflag.title'))}">📍</span>` +
    `<span class="when"><a href="https://water.noaa.gov/gauges/${esc(g.lid)}" target="_blank" rel="noopener" style="color:var(--accent)">NWPS →</a></span></div>` +
    `<div class="meta">OBS ${o.primary > -999 && Number.isFinite(o.primary) ? `${fmtNum(o.primary)} ${esc(o.primaryUnit)} · <span class="cat-word" style="color:var(--cat-${stale ? 'none' : cat})">${esc(catWord(cat))}</span>${trendBit}` : esc(t('gauge.noreading'))}</div>` +
    (stale ? `<div class="meta stale-note">⏱ ${esc(t('gauge.stale').replace('{t}', fmtWhen(o.validTime)))}</div>` : '') +
    (fCat ? `<div class="meta">${esc(t('wave.crest'))} ${fmtNum(f.primary)} ${esc(f.primaryUnit)} · <span class="cat-word" style="color:var(--cat-${fCat})">${esc(catWord(fCat))}</span> · ${esc(fmtWhen(f.validTime))}</div>` : '') +
    recordLineHtml(g) +
    (site ? `<div class="meta">📍 ${esc(site)}</div>` : '');
  div.addEventListener('click', (ev) => { if (ev.target.closest('a')) return; focusGauge(g); });
  return div;
}

// one honest line: at/above the crest of record, or N ft below it (with year)
function recordLineHtml(g) {
  const rc = recordContext(g);
  if (!rc) return '';
  if (rc.atOrAbove) {
    return `<div class="meta record-line at"><strong>⚑ ${esc(t('record.athead'))}</strong>: ${esc(t('record.attail').replace('{rec}', rc.recFt).replace('{y}', rc.year).replace('{m}', Math.abs(rc.margin)))}</div>`;
  }
  if (rc.near) {
    return `<div class="meta record-line near">⚑ ${esc(t('record.nearhead'))}: ${esc(t('record.neartail').replace('{rec}', rc.recFt).replace('{y}', rc.year).replace('{m}', rc.margin))}</div>`;
  }
  return '';
}

// crest-wave tracker: on one river the forecast-crest time IS the wave's arrival order,
// so ordering a river's gauges by crest validTime shows the crest marching downstream.
// pure NWPS validTime data — no interpolation between gauges (would be fake precision).
function waveRivers() {
  const withCrest = state.gauges.filter((g) => {
    if (gaugeObsStale(g)) return false; // dead sensor — its crest wave is not trustworthy live data
    const f = g.status && g.status.forecast;
    return f && f.validTime && f.primary > 0 && CAT_RANK[gaugeForecastCat(g)] >= CAT_RANK.action;
  });
  const byRiver = {};
  for (const g of withCrest) (byRiver[riverOf(g.name)] = byRiver[riverOf(g.name)] || []).push(g);
  const crestT = (g) => new Date(g.status.forecast.validTime).getTime();
  return Object.keys(byRiver)
    .map((river) => [river, byRiver[river].sort((a, b) => crestT(a) - crestT(b))])
    .filter(([, gs]) => gs.length >= 2) // a "wave" needs ≥2 points on the same river
    .sort((a, b) => crestT(a[1][0]) - crestT(b[1][0]));
}

function renderWave() {
  const el = $('#wave-list');
  if (!el) return;
  const rivers = waveRivers();
  if (!rivers.length) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  // collapsed by default (owner: the gauge list, not the crest view, is what opens) — state persists
  const open = localStorage.getItem('respondertx.waveOpen') === '1';
  const now = Date.now();
  let body = '';
  for (const [river, gs] of rivers) {
    body += `<div class="wave-river">${esc(river)} <span class="wave-hint">${esc(t('wave.order'))}</span></div>`;
    for (const g of gs) {
      const f = g.status.forecast;
      const fCat = gaugeForecastCat(g);
      const past = new Date(f.validTime).getTime() < now;
      const site = g.name.slice(riverOf(g.name).length).trim() || g.name;
      body += `<button class="wave-row" data-lid="${esc(g.lid)}">` +
        `<span class="wave-dot" style="background:var(--cat-${fCat})"></span>` +
        `<span class="wave-site">${esc(site)}</span>` +
        `<span class="wave-stage" style="color:var(--cat-${fCat})">${fmtNum(f.primary)} ft ${esc(catWord(fCat))}</span>` +
        `<span class="wave-eta ${past ? 'past' : ''}">${esc(t(past ? 'wave.crested' : 'wave.crest'))} ${esc(fmtWhen(f.validTime))}</span></button>`;
    }
  }
  const nGauges = rivers.reduce((s, [, gs]) => s + gs.length, 0);
  el.innerHTML = `<button class="wave-toggle${open ? ' open' : ''}" id="wave-toggle">` +
    `<span>${esc(t('sec.wave'))}</span>` +
    `<span class="wave-count">${esc(t('wave.count').replace('{r}', rivers.length).replace('{p}', nGauges))} ${open ? '▾' : '▸'}</span></button>` +
    `<div class="wave-body"${open ? '' : ' hidden'}>${body}</div>`;
  $('#wave-toggle').addEventListener('click', () => {
    const nowOpen = $('.wave-body').hasAttribute('hidden');
    $('.wave-body').hidden = !nowOpen;
    localStorage.setItem('respondertx.waveOpen', nowOpen ? '1' : '0');
    $('#wave-toggle').classList.toggle('open', nowOpen);
    $('.wave-count').textContent = `${t('wave.count').replace('{r}', rivers.length).replace('{p}', nGauges)} ${nowOpen ? '▾' : '▸'}`;
  });
  el.querySelectorAll('.wave-row').forEach((b) => b.addEventListener('click', () => {
    const g = state.gauges.find((x) => x.lid === b.dataset.lid);
    if (g) focusGauge(g);
  }));
}

/* ---------- Drive Mode: big-type nearest-hazards glance list ---------- */

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function bearing(fromLat, fromLon, toLat, toLon) {
  const toR = Math.PI / 180;
  const dLon = (toLon - fromLon) * toR;
  const y = Math.sin(dLon) * Math.cos(toLat * toR);
  const x = Math.cos(fromLat * toR) * Math.sin(toLat * toR) - Math.sin(fromLat * toR) * Math.cos(toLat * toR) * Math.cos(dLon);
  return COMPASS[Math.round((((Math.atan2(y, x) / toR) + 360) % 360) / 45) % 8];
}

// hazards a driver cares about: closed/caution crossings, life-safety + road/cutoff notices, major/rising gauges, live TxDOT road closures
function driveItems() {
  const items = [];
  for (const c of (state.crossings || [])) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
    const st = CROSSING_STATUS[c.status] || CROSSING_STATUS.caution;
    if (c.status === 'open') continue;
    items.push({ glyph: st.glyph, color: st.color, name: c.name, sub: t('drive.sub.crossing').replace('{st}', xstLabel(st)), lat: c.lat, lon: c.lon, rank: c.status === 'closed' ? 0 : 2 });
  }
  for (const r of activeRequests().filter((x) => x.status !== 'resolved')) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    if (!LIFE_SAFETY_TYPES.includes(r.type) && r.type !== 'road') continue;
    items.push({ glyph: TYPE_GLYPH[r.type] || '📍', color: r.priority === 'critical' ? 'var(--sev-emergency)' : 'var(--sev-warning)', name: r.summary, sub: `${ntypeLabel(r.type)} · ${r.place}`, lat: r.lat, lon: r.lon, rank: r.priority === 'critical' ? 0 : 1 });
  }
  for (const g of state.gauges.filter((x) => gaugeCat(x) === 'major' || (gaugeRising(x) && gaugeForecastCat(x) === 'major'))) {
    items.push({ glyph: '●', color: 'var(--cat-major)', name: g.name, sub: t(gaugeCat(g) === 'major' ? 'drive.majnow' : 'drive.majrise'), lat: g.latitude, lon: g.longitude, rank: 1 });
  }
  const p = state.myPos;
  // recovery: recently reopened roads tail the list as low-priority ✓ entries — never competing with hazards for slots
  const cleared = [];
  for (const r of reopenedRoads().fresh) {
    if (!r.vertex || !reopenIsFlood(r)) continue;
    cleared.push({ glyph: '✓', color: 'var(--good)', name: `${t('reopen.flag')} · ${prettyRoute(r.route_name) || t('ntype.road')}`, sub: `TxDOT DriveTexas · ${t('reopen.at')} ${relWhen(r.reopenedAt)}`, lat: r.vertex[0], lon: r.vertex[1], rank: 3 });
  }
  // live TxDOT road closures/flooding/damage — representative point = line vertex nearest the driver (midpoint if no GPS)
  for (const f of ((state.roadClosures && state.roadClosures.lines) || [])) {
    const geo = f.geometry;
    if (!geo || !geo.coordinates) continue;
    const verts = geo.type === 'MultiLineString' ? geo.coordinates.flat() : geo.coordinates;
    let pt = null;
    if (p) {
      let best = Infinity;
      for (const c of verts) { if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue; const dd = distMi(p.lat, p.lng, c[1], c[0]); if (dd < best) { best = dd; pt = c; } }
    } else { pt = verts[Math.floor(verts.length / 2)]; }
    if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    const ct = roadCondType(f.properties);
    const cond = f.properties.condition;
    items.push({ glyph: cond === 'Flooding' ? '🌊' : cond === 'Damage' ? '⚠' : '⛔', color: ct.color, name: `${roadLabel(ct)} · ${prettyRoute(f.properties.route_name) || t('ntype.road')}`, sub: 'TxDOT DriveTexas', lat: pt[1], lon: pt[0], rank: cond === 'Damage' ? 2 : 1 });
  }
  // verify-before-routing: the 2 nearest cameras tail the list like the reopened rows — never competing with hazards
  const cams = [];
  if (p && state.cameras) {
    const pool = [['txdot', 'txdot'], ['river', 'river'], ['austin', 'austin'], ['atxfloods', 'atxfloods'], ['houston', 'houston'], ['arlington', 'arlington'], ['elpbridge', 'elpbridge'], ['hays', 'hays']]
      .flatMap(([arr, kind]) => (state.cameras[arr] || []).map((c) => ({ c, kind })));
    for (const x of pool) { if (Number.isFinite(x.c.lat) && Number.isFinite(x.c.lon)) x.d = distMi(p.lat, p.lng, x.c.lat, x.c.lon); }
    for (const x of pool.filter((y) => y.d != null).sort((a, b) => a.d - b.d).slice(0, 2)) {
      cams.push({
        glyph: '📷', color: 'var(--accent)', name: camTitle(x.c, x.kind),
        sub: `${camNetLabel(x.kind)} · ${t('cam.view')}`,
        lat: x.c.lat, lon: x.c.lon, rank: 4, cam: x.c, camKind: x.kind,
      });
    }
  }
  if (p) {
    for (const it of items.concat(cleared, cams)) { it.dist = distMi(p.lat, p.lng, it.lat, it.lon); it.brng = bearing(p.lat, p.lng, it.lat, it.lon); }
    items.sort((a, b) => a.dist - b.dist);
    cleared.sort((a, b) => a.dist - b.dist);
  } else {
    items.sort((a, b) => a.rank - b.rank);
  }
  return items.slice(0, 14).concat(cleared.slice(0, 4), cams);
}

function renderDriveMode() {
  if ($('#drive-mode').hidden) return;
  // camera rows need the inventory — fetch once, re-render when it lands
  if (!state.cameras) loadCameras().then(() => renderDriveMode()).catch(() => { /* no cams — hazard rows unaffected */ });
  const emerg = state.alerts.filter((a) => a._sev === 'emergency');
  const soonest = state.gauges
    .filter((g) => gaugeRising(g) && CAT_RANK[gaugeForecastCat(g)] >= CAT_RANK.moderate && new Date(g.status.forecast.validTime) > new Date())
    .sort((a, b) => new Date(a.status.forecast.validTime) - new Date(b.status.forecast.validTime))[0];
  $('#drive-threat').innerHTML =
    (emerg.length ? `<div class="dt-emerg">⚠ ${emerg.length} ${esc(t('drive.emerg'))}: ${esc(emerg.map((a) => a.properties.areaDesc).join('; '))}</div>` : '') +
    (soonest ? `<div class="dt-crest">${esc(t('drive.nextcrest'))} ${esc(riverOf(soonest.name))} ${esc(fmtWhen(soonest.status.forecast.validTime))}</div>` : '') +
    (state.myPos ? '' : `<div class="dt-nogps">${esc(t('drive.nogps'))}</div>`);
  const items = driveItems();
  state.driveCams = items.map((it) => (it.cam ? { cam: it.cam, kind: it.camKind } : null));
  $('#drive-list').innerHTML = items.length ? items.map((it, i) => {
    const distBit = it.dist != null ? `<span class="d-dist">${it.dist.toFixed(1)} ${esc(t('risk.mi'))} ${it.brng}</span>` : '';
    return `<button class="drive-row" data-lat="${it.lat}" data-lon="${it.lon}"${it.cam ? ` data-cam="${i}"` : ''}>` +
      `<span class="d-glyph" style="color:${it.color}">${it.glyph}</span>` +
      `<span class="d-body"><span class="d-name">${esc(it.name)}</span><span class="d-sub">${esc(it.sub)}</span></span>${distBit}</button>`;
  }).join('') : `<div class="dt-nogps">${esc(t('drive.nohaz'))}</div>`;
  $('#drive-list').querySelectorAll('.drive-row').forEach((b) => b.addEventListener('click', () => {
    const dc = b.dataset.cam != null && state.driveCams[+b.dataset.cam];
    if (dc) { openCamViewer(dc.cam, dc.kind); return; } // viewer overlays Drive Mode — stays one-handed
    $('#drive-mode').hidden = true;
    keepAwake(false, 'drive'); // tapping a hazard exits Drive Mode; drop the screen-awake hold
    state.map.setView([+b.dataset.lat, +b.dataset.lon], 13);
  }));
  updateDriveFreshness();
}

/* ---------- Live location tracker: one continuous geolocation watch (app + Drive Mode) ---------- */

// opt-in only: starts once the first granted fix lands (state.myPos). One continuous watch streams
// ~1s fixes so the follow glide is always fed; the fixes never move the map unless follow is engaged.
function startLocTrack() {
  if (state.locWatch) return; // idempotent: exactly one watch, no leak on reopen
  if (!state.myPos) return; // no granted fix yet → nothing to keep fresh
  state.locWatch = true;
  state.map.locate({ watch: true, enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
  updateDriveFreshness();
}

function stopLocTrack() {
  if (!state.locWatch) return;
  state.locWatch = false;
  state.map.stopLocate(); // drop the geolocation watch; no background drain while hidden
  updateDriveFreshness();
}

function updateDriveFreshness() {
  const el = $('#drive-fresh');
  if (!el) return;
  if ($('#drive-mode').hidden || !state.locWatch) { el.hidden = true; return; }
  el.hidden = false;
  const secs = state.driveFixAt ? Math.round((Date.now() - state.driveFixAt) / 1000) : null;
  el.textContent = secs == null
    ? `⌖ ${t('drive.autoupd')} · ${t('drive.locating')}`
    : `⌖ ${t('drive.autoupd')} · ${t('drive.lastfix').replace('{s}', secs)}`;
}

/* ---------- crest summary — after-action peak-stage view (?view=summary) ---------- */

const fmtCT = (iso) => `${new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} CT`;

function crestRecordHtml(g) {
  const r = g.record;
  if (!r) return '';
  const year = (r.record_date || '').slice(0, 4);
  const rel = r.exceeded ? t('summary.rec.exceeded') : t('summary.rec.reached').replace('{p}', r.peak_pct);
  const cls = r.exceeded ? ' at' : r.approached ? ' near' : '';
  return `<div class="sum-rec${cls}">⚑ ${esc(t('summary.rec.record'))} ${fmtNum(r.record_ft)} ft (${esc(year)}) · ${esc(rel)}</div>`;
}

function crestRowHtml(g) {
  const cat = g.peak_category;
  const badges =
    `<span class="badge" style="border-color:var(--cat-${esc(cat)});color:var(--cat-${esc(cat)});font-weight:700">${esc(cat.toUpperCase())}</span>` +
    (g.stale ? ` <span class="badge stale-note">⏱ ${esc(t('summary.stale'))}</span>` : '') +
    (g.ongoing ? ` <span class="badge" style="border-color:var(--good);color:var(--good)">${esc(t('summary.ongoing'))}</span>` : '');
  const windowEnd = g.last_in_flood === 'ongoing' ? esc(t('summary.ongoing')) : esc(fmtCT(g.last_in_flood));
  return '<tr>' +
    `<td><div class="sum-name">${esc(g.name)}</div><div class="sum-lid">${esc(g.lid)}</div>${crestRecordHtml(g)}</td>` +
    `<td><div class="sum-stage" style="color:var(--cat-${esc(cat)})">${fmtNum(g.peak)} ${esc(g.unit)}</div>${badges}</td>` +
    `<td><div class="sum-when">${esc(fmtCT(g.peak_time))}</div></td>` +
    `<td><div class="sum-window">${esc(fmtCT(g.first_in_flood))} →<br>${windowEnd}</div></td>` +
    '</tr>';
}

async function openCrestSummary() {
  $('#summary-view').hidden = false;
  const el = $('#summary-body');
  el.innerHTML = `<div class="sum-quiet">${esc(t('changelog.loading'))}</div>`;
  let d = null;
  try { d = await fetch(`data/crest-summary.json?_=${Date.now()}`).then((r) => (r.ok ? r.json() : null)); }
  catch { d = null; } // absent on older deploys or offline — quiet line below, never a crash
  if (!d || !Array.isArray(d.gauges) || !d.gauges.length) {
    el.innerHTML = `<div class="sum-quiet">${esc(t('summary.none'))}</div>`;
    return;
  }
  const w = d.window || {};
  el.innerHTML =
    '<div class="sum-head">' +
    `<div class="sum-event">${esc(t('summary.event'))} ${esc(d.event || '')} · ${esc(t('summary.generated'))} ${esc(fmtCT(d.generated))}</div>` +
    `<div class="sum-sub">${esc(t('summary.sub'))}</div>` +
    `<div class="sum-cite">${esc(t('summary.source'))}${w.first ? ` · ${esc(fmtCT(w.first))} → ${esc(fmtCT(w.last))}` : ''}</div>` +
    '</div>' +
    `<table class="sum-table"><thead><tr><th>${esc(t('summary.col.gauge'))}</th><th>${esc(t('summary.col.peak'))}</th><th>${esc(t('summary.col.when'))}</th><th>${esc(t('summary.col.window'))}</th></tr></thead>` +
    `<tbody>${d.gauges.map(crestRowHtml).join('')}</tbody></table>`;
}

/* ---------- recovery view — event wind-down lens (?view=recovery) ---------- */

const RECOVERY_NOTICE_RE = /boil[ -]?water|water (notice|advisory|system)|hervir|utilit|power|outage|debris|reopen|restor|recover|lifted|levantad/i;
const noticeText = (r) => `${r.summary} ${Array.isArray(r.details) ? r.details.join(' ') : (r.details || '')}`;

function recoveryGaugeRowHtml(x) {
  const cur = x.live ? x.live.status.observed : null;
  const cat = x.live ? gaugeCat(x.live) : 'none';
  const badge = x.kind === 'receded'
    ? `<span class="badge" style="border-color:var(--good);color:var(--good);font-weight:700">${esc(t('recovery.receded'))}</span>`
    : `<span class="badge" style="border-color:var(--cat-${esc(cat)});color:var(--cat-${esc(cat)});font-weight:700">▼ ${esc(t('recovery.falling'))} · ${esc(catLabel(cat).toUpperCase())}</span>`;
  const bits = [];
  if (cur && Number.isFinite(cur.primary) && cur.primary > -999) bits.push(`${t('recovery.now')} ${fmtNum(cur.primary)} ${cur.primaryUnit || 'ft'} @ ${fmtCT(cur.validTime)}`);
  bits.push(t('recovery.peaked').replace('{ft}', fmtNum(x.row.peak)).replace('{t}', fmtCT(x.row.peak_time)));
  if (x.kind === 'receded' && x.row.last_in_flood && x.row.last_in_flood !== 'ongoing') bits.push(`${t('recovery.since')} ${fmtCT(x.row.last_in_flood)}`);
  if (x.kind === 'falling' && x.trend && x.trend.dir === 'down') bits.push(t('recovery.rate').replace('{r}', x.trend.rate.toFixed(1)));
  if (x.kind === 'falling' && x.live) {
    const f = x.live.status.forecast || {};
    const fRank = f.floodCategory === 'no_flooding' ? CAT_RANK.none
      : FLOOD_CATS.includes(f.floodCategory) ? CAT_RANK[f.floodCategory] : null;
    if (fRank !== null && fRank < CAT_RANK[cat] && new Date(f.validTime) > new Date()) {
      bits.push(t('recovery.fcst').replace('{ft}', fmtNum(f.primary)).replace('{t}', fmtCT(f.validTime)));
    }
  }
  return `<div class="resource-item"><strong>${esc(x.row.name)}</strong> <span class="sum-lid">${esc(x.row.lid)}</span> ${badge}` +
    `<div class="addr">${esc(bits.join(' · '))}</div></div>`;
}

function recoveryNoticeHtml(r) {
  const badge = srcBadge(r.source && r.source.platform === 'official' ? 'official' : 'curated');
  return `<div class="resource-item"><strong>${TYPE_GLYPH[r.type] || 'ℹ️'} ${esc(ntypeLabel(r.type))}</strong>: ${esc(r.summary)}` +
    `<div class="addr">${esc(r.place || '')}${r.county ? ` · ${esc(r.county)} Co.` : ''} · ${esc(fmtWhen(r.ts))} ${badge}</div></div>`;
}

const recoverySection = (title, sub, itemsHtml, emptyKey, citeHtml) =>
  `<div class="section-title">${esc(title)}</div>` +
  (sub ? `<div class="rcv-note">${esc(sub)}</div>` : '') +
  (itemsHtml || `<div class="rcv-none">${esc(t(emptyKey))}</div>`) +
  (citeHtml || '');

function renderRecoveryBody(crest) {
  const el = $('#recovery-body');
  const rows = (crest && Array.isArray(crest.gauges)) ? crest.gauges : [];
  const byLid = {};
  for (const g of state.gauges) byLid[g.lid] = g;
  const classified = rows
    .map((row) => ({ row, live: byLid[row.lid] || null, trend: gaugeTrend(row.lid), kind: null }))
    .map((x) => Object.assign(x, { kind: gaugeRecoveryState(x.row, x.live, x.trend) }))
    .filter((x) => x.kind);
  const falling = classified.filter((x) => x.kind === 'falling');
  const receded = classified.filter((x) => x.kind === 'receded')
    .sort((a, b) => new Date(b.row.last_in_flood) - new Date(a.row.last_in_flood));
  const stillFlood = state.gauges.filter((g) => gaugeCat(g) !== 'none').length;

  const sitFalling = sitrepFallingGauges();
  const counts = t('recovery.counts').replace('{a}', receded.length).replace('{b}', falling.length).replace('{c}', stillFlood);
  const head =
    '<div class="sum-head">' +
    `<div class="sum-event">${esc(t('recovery.event'))} ${esc((crest && crest.event) || state.baseTitle || '')}${crest && crest.generated ? ` · ${esc(t('summary.generated'))} ${esc(fmtCT(crest.generated))}` : ''}</div>` +
    `<div class="rcv-headline">${esc(counts)}</div>` +
    (sitFalling.length ? `<div class="sum-sub">▼ ${esc(t('recovery.sitrep').replace('{n}', sitFalling.length).replace('{list}', sitFalling.map((g) => riverOf(g.name)).slice(0, 6).join('; ')))}</div>` : '') +
    `<div class="sum-cite">${esc(t('recovery.sub'))}</div>` +
    '</div>';

  const gaugeItems = falling.concat(receded).map(recoveryGaugeRowHtml).join('');
  const gaugeCite = `<div class="sum-cite">${esc(t('summary.source'))}</div>`;

  const reo = reopenedRoads();
  const freshReo = reo.fresh.filter(reopenIsFlood);
  const agedReo = reo.aged.filter(reopenIsFlood);
  const roadItems = freshReo.map((r) => reopenedItemHtml(r, false)).join('') +
    (agedReo.length ? `<div class="rcv-none">${esc(t('reopen.aged').replace('{n}', agedReo.length).replace('{h}', CONFIG.reopenedAgeHours).replace('{d}', CONFIG.histDays))}</div>` : '');
  const roadCite = `<div class="sum-cite">${srcBadge('official')} ${esc(ROAD_ATTRIB)} · ${esc(t('reopen.cleared'))}</div>`;

  const res = state.resources || {};
  const shelters = mergeShelters(res.shelters || [], state.sheltersLive && state.sheltersLive.shelters);
  const shlSrcUrl = shlLiveSrcUrl();
  const shelterItems = shlLiveUpdatedHtml() +
    shelters.map((s) => (s.live ? liveShelterHtml(s, shlSrcUrl) : curatedShelterHtml(s))).join('');

  const recMatch = allRequests().filter((r) => RECOVERY_NOTICE_RE.test(noticeText(r)));
  const recFresh = recMatch.filter((r) => !cardAged(r));
  const recAged = recMatch.length - recFresh.length;
  const noticeItems = recFresh.map(recoveryNoticeHtml).join('') +
    (recAged ? `<div class="rcv-none">${esc(t('recovery.notices.aged').replace('{n}', recAged))}</div>` : '');

  el.innerHTML = head +
    recoverySection(`📉 ${t('recovery.head.gauges')} (${classified.length})`, t('recovery.head.gauges.sub'), gaugeItems, 'recovery.gauges.none', gaugeCite) +
    recoverySection(`✓ ${t('recovery.head.roads')} (${freshReo.length})`, '', roadItems, 'recovery.roads.none', roadCite) +
    recoverySection(`🏠 ${t('recovery.head.shelters')} (${shelters.length})`, '', shelters.length ? shelterItems : '', 'recovery.shelters.none') +
    recoverySection(`🚰 ${t('recovery.head.notices')} (${recFresh.length})`, '', noticeItems, 'recovery.notices.none');
}

// data lands after a boot-time ?view=recovery opens (gauges, seeds, resources) — re-render the open lens
function refreshRecoveryView() {
  const rv = $('#recovery-view');
  if (rv && !rv.hidden) renderRecoveryBody(state.recoveryCrest);
}

async function openRecoveryView() {
  $('#recovery-view').hidden = false;
  // recovery lens map defaults: reopened roads + shelters visible behind the view
  if (state.map) {
    for (const lk of ['roadReopen', 'shelters']) {
      const l = state.layers[lk];
      if (l && !state.map.hasLayer(l)) l.addTo(state.map);
    }
  }
  const el = $('#recovery-body');
  el.innerHTML = `<div class="sum-quiet">${esc(t('changelog.loading'))}</div>`;
  let crest = null;
  try { crest = await fetch(`data/crest-summary.json?_=${Date.now()}`).then((r) => (r.ok ? r.json() : null)); }
  catch { crest = null; } // absent on older deploys or offline — the gauges section shows its honest empty line
  state.recoveryCrest = crest;
  renderRecoveryBody(crest);
}

function renderGaugesTab() {
  renderWave();
  refreshRecoveryView();
  const el = $('#gauge-list');
  if (!el) return;
  const inFloodAll = state.gauges.filter((g) => gaugeCat(g) !== 'none');
  const badge = $('#gauges-count');
  badge.textContent = inFloodAll.length;
  badge.classList.toggle('sev', inFloodAll.some((g) => gaugeCat(g) === 'major'));

  // "In view" scopes the list buckets; the tab badge above stays global situational truth
  const pool = state.inView ? state.gauges.filter((g) => inMapView(g.latitude, g.longitude)) : state.gauges;
  const inFlood = pool.filter((g) => gaugeCat(g) !== 'none');
  // double-listing precedence: rising wins, then falling, then in-flood
  const rising = pool.filter(gaugeRising)
    .sort((a, b) => new Date(a.status.forecast.validTime) - new Date(b.status.forecast.validTime));
  const risingLids = new Set(rising.map((g) => g.lid));
  const inFloodOnly = inFlood.filter((g) => !risingLids.has(g.lid));
  const falling = inFloodOnly.filter((g) => (gaugeTrend(g.lid) || {}).dir === 'down');
  const fallingLids = new Set(falling.map((g) => g.lid));
  const holding = inFloodOnly.filter((g) => !fallingLids.has(g.lid))
    .sort((a, b) => CAT_RANK[gaugeCat(b)] - CAT_RANK[gaugeCat(a)] || b.status.observed.primary - a.status.observed.primary);
  const normal = pool.filter((g) => gaugeCat(g) === 'none' && !risingLids.has(g.lid))
    .sort((a, b) => a.name.localeCompare(b.name));
  // gaugeCat maps stale sensors to 'none', so this bucket mixes truly-normal and dead gauges — count them apart for an honest label
  const normalStale = normal.filter(gaugeObsStale).length;

  el.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'filters group-toggle';
  for (const [key, label] of [['priority', t('sec.gauge.bypri')], ['river', t('sec.gauge.byriver')]]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.classList.toggle('on', state.gaugeGroup === key);
    b.addEventListener('click', () => { state.gaugeGroup = key; renderGaugesTab(); });
    bar.appendChild(b);
  }
  const iv = document.createElement('button');
  iv.textContent = state.inView ? `${t('sync.inview')} · ${pool.length}` : t('sync.inview');
  iv.title = t('sync.inview.title');
  iv.classList.toggle('on', state.inView);
  iv.addEventListener('click', () => setInView(!state.inView));
  bar.appendChild(iv);
  // one-tap crest summary (owner ask) — same view the ⋯ More menu opens
  const sum = document.createElement('button');
  sum.textContent = t('summary.menu');
  sum.title = t('summary.menu.title');
  sum.addEventListener('click', openCrestSummary);
  bar.appendChild(sum);
  el.appendChild(bar);

  const section = (title, list) => {
    const t = document.createElement('div');
    t.className = 'section-title';
    t.textContent = title;
    el.appendChild(t);
    for (const g of list) el.appendChild(gaugeCardDiv(g));
  };
  if (state.gaugeGroup === 'river') {
    // NWPS gauge objects carry no county — group by river name derived from the site name
    const groups = new Map();
    for (const g of rising.concat(holding, falling)) {
      const r = riverOf(g.name);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(g);
    }
    for (const [river, list] of groups) section(`${river} (${list.length})`, list);
  } else {
    if (rising.length) section(`${t('sec.gauge.rising')} (${rising.length})`, rising);
    if (holding.length) section(`${t('sec.gauge.inflood')} (${holding.length})`, holding);
    if (falling.length) section(`${t('sec.gauge.falling')} (${falling.length})`, falling);
  }
  if (!rising.length && !holding.length && !falling.length) {
    const none = document.createElement('div');
    none.className = 'card';
    none.textContent = state.gauges.length ? t('sec.gauge.empty') : t('sec.gauge.noload');
    el.appendChild(none);
  }
  if (normal.length) {
    const btn = document.createElement('button');
    btn.className = 'aged-toggle';
    btn.textContent = normalStale
      ? `${t(state.showNormalGauges ? 'toggle.hide' : 'toggle.show')} ${t('gauges.toggle.split').replace('{n}', normal.length).replace('{a}', normal.length - normalStale).replace('{s}', normalStale)}`
      : `${t(state.showNormalGauges ? 'toggle.hide' : 'toggle.show')} ${t('gauges.toggle.all').replace('{n}', normal.length)}`;
    btn.addEventListener('click', () => { state.showNormalGauges = !state.showNormalGauges; renderGaugesTab(); });
    el.appendChild(btn);
    if (state.showNormalGauges) for (const g of normal) el.appendChild(gaugeCardDiv(g));
  }
}

/* ---------- resources & monitors ---------- */

const dataLinkHtml = (d) => `<div class="resource-item"><a href="${esc(safeUrl(d.url))}" target="_blank" rel="noopener">${esc(d.label)}</a></div>`;

const SHELTER_STATUS = {
  open: { key: 'shl.st.open', color: 'var(--good)' },
  standby: { key: 'shl.st.standby', color: 'var(--cat-action)' },
  full: { key: 'shl.st.full', color: 'var(--cat-action)' },
  closed: { key: 'shl.st.closed', color: 'var(--ink-muted)' },
};
function shlStatus(status) {
  const st = SHELTER_STATUS[String(status || '').toLowerCase()];
  return { label: (st ? t(st.key) : String(status || '')).toUpperCase(), color: st ? st.color : 'var(--ink-2)' };
}
function liveShelterHtml(s, srcUrl) {
  const st = shlStatus(s.status);
  const meta = [];
  if (Number.isFinite(s.capacity)) meta.push(t('shl.cap').replace('{n}', s.capacity));
  if (Number.isFinite(s.occupancy)) meta.push(t('shl.occ').replace('{n}', s.occupancy));
  if (s.org) meta.push(s.org);
  return `<div class="resource-item"><strong style="color:${st.color}">🏠 ${esc(st.label)}</strong>: <strong>${esc(s.name)}</strong> ${srcBadge('official')}` +
    `<div class="addr">${esc(s.address || '')}${meta.length ? ` · ${esc(meta.join(' · '))}` : ''} · ${esc(t('shl.livesrc'))} <a href="${esc(safeUrl(srcUrl))}" target="_blank" rel="noopener">src</a></div></div>`;
}

const curatedShelterHtml = (s) =>
  `<div class="resource-item"><strong>${esc(s.name)}</strong><div class="addr">${esc(s.address)} · ${esc(s.county)} Co. · ${esc(s.note)} <a href="${esc(safeUrl(s.source))}" target="_blank" rel="noopener">src</a></div></div>`;

const shlLiveSrcUrl = () => (state.sheltersLive && state.sheltersLive.source && state.sheltersLive.source.url) || 'https://gis.fema.gov/arcgis/rest/services/NSS/OpenShelters/MapServer/0';

const shlLiveUpdatedHtml = () => (state.sheltersLive && state.sheltersLive.generated
  ? `<div class="resource-item" style="border-bottom:none;font-size:12px;color:var(--ink-2)">${esc(t('shl.livefeed'))} · ${esc(t('word.updated').toLowerCase())} ${esc(fmtWhen(state.sheltersLive.generated))}</div>`
  : '');

function renderResources() {
  const r = state.resources;
  if (!r) return;
  const el = $('#resources-body');
  const recovery = r.recoveryLinks || [];
  const liveShl = state.sheltersLive;
  const shelters = mergeShelters(r.shelters, liveShl && liveShl.shelters);
  const shlSrcUrl = shlLiveSrcUrl();
  el.innerHTML = `<div class="section-title">${esc(t('res.shelters'))}</div>` +
    shlLiveUpdatedHtml() +
    shelters.map((s) => (s.live ? liveShelterHtml(s, shlSrcUrl) : curatedShelterHtml(s))).join('') +
    `<div class="section-title">${esc(t('res.hotlines'))}</div>` +
    r.hotlines.map((h) => `<div class="resource-item"><strong>${esc(h.value)}</strong> · ${esc(h.name)}<div class="addr">${esc(h.note)}</div></div>`).join('') +
    `<div class="section-title">${esc(t('res.data'))}</div>` +
    r.dataLinks.map(dataLinkHtml).join('') +
    (recovery.length
      ? `<button class="aged-toggle" id="recovery-toggle">${state.showRecovery ? '▾' : '▸'} ${esc(t('res.recovery'))}</button>` +
        `<div id="recovery-body"${state.showRecovery ? '' : ' hidden'}>${recovery.map(dataLinkHtml).join('')}</div>`
      : '') +
    `<div class="section-title">${esc(t('res.follow'))}</div>` +
    `<div class="resource-item"><a href="feed.xml" target="_blank" rel="noopener">${esc(t('res.rss'))}</a> · ${esc(t('res.rss.note'))}</div>` +
    `<div class="resource-item"><a href="crests.ics" target="_blank" rel="noopener">${esc(t('res.ics'))}</a> · ${esc(t('res.ics.note'))}</div>`;
  const rt = $('#recovery-toggle');
  if (rt) rt.addEventListener('click', () => { state.showRecovery = !state.showRecovery; renderResources(); });
  refreshRecoveryView(); // shelters lens tracks resources + shelters-live

  state.layers.shelters.clearLayers();
  for (const s of shelters) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const icon = L.divIcon({ className: '', html: '<div class="shelter-icon">🏠</div>', iconSize: [24, 24] });
    const m = L.marker([s.lat, s.lon], { icon });
    if (s.live) {
      const st = shlStatus(s.status);
      m.bindPopup(`<div class="popup-title">🏠 <span style="color:${st.color}">${esc(st.label)}</span> · ${esc(s.name)} ${srcBadge('official')}</div>` +
        `<div class="popup-meta">${esc(s.address || '')}</div>` +
        `<div class="popup-meta">${esc(t('shl.livefeed'))}</div>` +
        `<div class="popup-link"><a href="${esc(safeUrl(shlSrcUrl))}" target="_blank" rel="noopener">${esc(t('word.source'))}</a></div>`);
    } else {
      m.bindPopup(`<div class="popup-title">🏠 ${esc(s.name)}</div><div class="popup-meta">${esc(s.address)}</div><div>${esc(s.note)}</div><div class="popup-meta">Location approximate; confirm before routing.</div>`);
    }
    state.layers.shelters.addLayer(m);
  }
}

function monitorGroupHtml(g) {
  return `<div class="monitor-group"><div class="section-title">${esc(g.group)}</div>` +
    (g.note ? `<div class="resource-item" style="border-bottom:none;font-size:12px;color:var(--ink-2)">${esc(g.note)}</div>` : '') +
    g.links.map((l) => `<a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">↗ ${esc(l.label)}</a>`).join('') + '</div>';
}

// social searches + scanner/net groups, behind one default-closed disclosure
function renderMonitors() {
  const el = $('#monitor-body');
  if (!el) return;
  const open = state.showMonitors;
  const body = open
    ? `<div class="section-title">${esc(t('mon.social'))}</div>` +
      state.resources.monitors.map(monitorGroupHtml).join('') +
      `<div class="section-title">${esc(t('mon.comms'))}</div>` +
      (state.resources.comms || []).map(monitorGroupHtml).join('')
    : '';
  el.innerHTML = `<button class="aged-toggle" id="mon-toggle">${open ? '▾' : '▸'} ${esc(t('mon.verify'))}</button>` +
    `<div id="mon-verify-body"${open ? '' : ' hidden'}>${body}</div>`;
  $('#mon-toggle').addEventListener('click', () => { state.showMonitors = !state.showMonitors; renderMonitors(); });
}

/* ---------- coastal water levels (NOAA CO-OPS): observed-vs-predicted surge residual ---------- */

const tideDirGlyph = (dir) => (dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→');
// higher positive residual = more water than the astronomical tide predicts = worse; below-predicted reads good
function tideSurgeColor(surge) {
  if (surge == null) return 'var(--ink-muted)';
  if (surge >= 1.5) return 'var(--cat-major)';
  if (surge >= 0.5) return 'var(--cat-moderate)';
  if (surge <= -0.5) return 'var(--good)';
  return 'var(--ink-2)';
}

function renderTides() {
  const el = $('#tides-body');
  if (!el) return;
  // no configured tide stations (inland event) — the coastal card does not render at all
  if (!Array.isArray(CONFIG.tideStations) || !CONFIG.tideStations.length) { el.innerHTML = ''; return; }
  const rows = state.tides;
  const open = localStorage.getItem('respondertx.tidesOpen') !== '0'; // default open once the operator picks the tab
  const live = rows ? rows.filter((r) => r.ok) : [];
  const countTxt = rows
    ? t('tides.live').replace('{n}', live.length).replace('{m}', rows.length)
    : (state.tidesLoading ? t('tides.loading') : t('tides.tap'));
  let body = '';
  if (rows) {
    const surgeKey = (r) => (r.ok && r.surge != null ? r.surge : -Infinity);
    const sorted = rows.slice().sort((a, b) => surgeKey(b) - surgeKey(a));
    const freshT = live.map((r) => r.t).sort().slice(-1)[0];
    const asOf = freshT ? t('tides.asof').replace('{t}', freshT.slice(11, 16)) : '';
    body =
      `<div class="tide-sub">${esc(t('tides.sub'))}${asOf ? ` · ${esc(asOf)}` : ''}</div>` +
      `<div class="tide-row tide-hdr"><span class="tide-name">${esc(t('tides.col.station'))}</span>` +
      `<span class="tide-obs">${esc(t('tides.col.obs'))}</span>` +
      `<span class="tide-surge">${esc(t('tides.col.surge'))}</span></div>` +
      sorted.map((r) => {
        if (!r.ok) {
          return '<div class="tide-row unavail"><span class="tide-name">' + esc(r.name) + '</span>' +
            '<span class="tide-obs"></span><span class="tide-surge muted">' + esc(t('tides.unavail')) + '</span></div>';
        }
        const surgeTxt = r.surge == null
          ? esc(t('tides.nopred'))
          : `${r.surge >= 0 ? '+' : ''}${r.surge.toFixed(1)} ft ${tideDirGlyph(r.dir)}`;
        const surgeCls = r.surge == null ? ' muted' : '';
        return `<div class="tide-row"><span class="tide-name">${esc(r.name)}</span>` +
          `<span class="tide-obs">${r.obs.toFixed(2)} ft</span>` +
          `<span class="tide-surge${surgeCls}" style="color:${tideSurgeColor(r.surge)}">${surgeTxt}</span></div>`;
      }).join('') +
      `<div class="tide-cite">${esc(t('tides.source'))} · ` +
      `<a href="https://tidesandcurrents.noaa.gov/" target="_blank" rel="noopener">tidesandcurrents.noaa.gov</a></div>`;
  }
  el.innerHTML = `<button class="wave-toggle tides-toggle${open ? ' open' : ''}" id="tides-toggle">` +
    `<span>${esc(t('tides.title'))}</span>` +
    `<span class="wave-count">${esc(countTxt)} ${open ? '▾' : '▸'}</span></button>` +
    `<div class="tide-body"${open && rows ? '' : ' hidden'}>${body}</div>`;
  $('#tides-toggle').addEventListener('click', () => {
    const willOpen = localStorage.getItem('respondertx.tidesOpen') === '0'; // currently collapsed → open it
    localStorage.setItem('respondertx.tidesOpen', willOpen ? '1' : '0');
    if (willOpen && !state.tides) loadTides(); else renderTides();
  });
}

/* ---------- threat-to-life strip ---------- */

function fitTo(latlngs) {
  if (latlngs.length) state.map.fitBounds(L.latLngBounds(latlngs).pad(0.25), { maxZoom: 10 });
}

// AO truly quiet: zero in-AO open alerts, zero gauges at minor+ (same stale-gated gaugeCat the
// chips use), zero active road closures — and the gauge/road feeds must have actually loaded
function quietState() {
  if (!state.gauges.length || !state.roadClosures) return false;
  const openInAO = state.alerts.filter((f) => alertInAO(f) && !(f.properties.expires && new Date(f.properties.expires) < new Date()));
  const inFlood = state.gauges.filter((g) => CAT_RANK[gaugeCat(g)] >= CAT_RANK.minor);
  return !openInAO.length && !inFlood.length && !(state.roadClosures.lines || []).length;
}

/* plain-language headline — one sentence derived from the same computed signals the
   chips/tiles use; never editorializes beyond the data. Quiet state keeps its own line. */
function headlineParts() {
  const parts = [];
  const now = new Date();
  const openInAO = (sev) => state.alerts.filter((f) => f._sev === sev && alertInAO(f)
    && !(f.properties.expires && new Date(f.properties.expires) < now)).length;
  const emergN = openInAO('emergency');
  if (emergN) parts.push(t('headline.ffe').replace('{n}', emergN));
  const inFlood = state.gauges.filter((g) => CAT_RANK[gaugeCat(g)] >= CAT_RANK.minor);
  if (inFlood.length) {
    const rcRank = (g) => { const rc = recordContext(g); return rc && (rc.atOrAbove || rc.near) ? 1 : 0; };
    const worst = inFlood.slice().sort((a, b) => (CAT_RANK[gaugeCat(b)] - CAT_RANK[gaugeCat(a)])
      || (rcRank(b) - rcRank(a)) || (b.status.observed.primary - a.status.observed.primary))[0];
    const rc = recordContext(worst);
    const tr = gaugeTrend(worst.lid);
    const st = tr && tr.dir === 'down' ? t('headline.st.falling')
      : rc && rc.atOrAbove ? t('headline.st.overrecord')
        : rc && rc.near ? t('headline.st.record')
          : tr && tr.dir === 'up' ? t('headline.st.rising') : t('headline.st.steady');
    parts.push(t('headline.gauge').replace('{site}', pbShortName(worst.name) || riverOf(worst.name))
      .replace('{cat}', catLabel(gaugeCat(worst))).replace('{st}', st));
  }
  const wave = state.gauges.filter((g) => gaugeRising(g) && gaugeForecastCat(g) === 'major')
    .sort((a, b) => new Date(a.status.forecast.validTime) - new Date(b.status.forecast.validTime))[0];
  if (wave) {
    // direction from observed trend, not the forecast delta — a forecast-to-major gauge can be receding right now
    const wtr = gaugeTrend(wave.lid);
    const waveKey = !wtr ? 'headline.wave.nodir' : wtr.dir === 'up' ? 'headline.wave' : wtr.dir === 'down' ? 'headline.wave.down' : null;
    if (waveKey) parts.push(t(waveKey).replace('{river}', riverOf(wave.name)).replace('{site}', pbShortName(wave.name)));
  }
  const warnN = openInAO('warning');
  if (warnN) parts.push(t('headline.warnN').replace('{n}', warnN));
  else if (!emergN && state.alertsLoadedOnce) parts.push(t('headline.warn0'));
  const roadN = ((state.roadClosures && state.roadClosures.lines) || []).length;
  if (roadN) parts.push(t('headline.roads').replace('{n}', roadN));
  const dirs = inFlood.map((g) => (gaugeTrend(g.lid) || {}).dir).filter(Boolean);
  if (dirs.length) { // no trend baseline yet (fresh browser) — say nothing rather than guess
    const down = dirs.filter((d) => d === 'down').length;
    const up = dirs.filter((d) => d === 'up').length;
    parts.push(t(down > up ? 'headline.trend.down' : up > down ? 'headline.trend.up' : 'headline.trend.steady'));
  }
  return parts;
}

function headlineHtml() {
  const parts = headlineParts();
  if (!parts.length) return '';
  return `<button id="threat-headline" class="threat-headline${state.headlineOpen ? ' open' : ''}" ` +
    `title="${esc(t('headline.title'))}">${esc(parts.join(' · '))}</button>`;
}

function bindHeadline(el) {
  const hb = el.querySelector('#threat-headline');
  if (hb) hb.addEventListener('click', () => {
    state.headlineOpen = !state.headlineOpen;
    hb.classList.toggle('open', state.headlineOpen);
  });
}

function renderThreatStrip() {
  const el = $('#threat-strip');
  // playback engaged: the dimmed strip stays LIVE data — say so, never let it read as the frame
  const pbNote = pbBlocksLive(state) ? `<div class="strip-live-note">${esc(t('playback.striplive'))}</div>` : '';
  const reqs = activeRequests().filter((r) => r.status !== 'resolved');
  const emergencies = state.alerts.filter((a) => a._sev === 'emergency').length;
  const lifeReqs = reqs.filter((r) => r.priority === 'critical' && LIFE_SAFETY_TYPES.includes(r.type) && r.type !== 'cutoff');
  const cutoffs = reqs.filter((r) => r.type === 'cutoff');
  const roads = reqs.filter((r) => r.type === 'road');
  const majors = state.gauges.filter((g) => gaugeCat(g) === 'major');
  const toMajor = state.gauges.filter((g) => gaugeRising(g) && gaugeForecastCat(g) === 'major');
  const chips = [
    { n: emergencies, cls: 'emergency', label: t('threat.ffemerg'), glyph: '⚠', act: () => document.querySelector('.tabs button[data-tab="tab-alerts"]').click() },
    { n: lifeReqs.length, cls: 'emergency', label: t('threat.life'), glyph: '🆘', src: 'curated', act: () => fitTo(lifeReqs.filter((r) => Number.isFinite(r.lat)).map((r) => [r.lat, r.lon])) },
    { n: cutoffs.length, cls: 'emergency', label: t('threat.cutoff'), glyph: '⛔', src: 'curated', act: () => fitTo(cutoffs.filter((r) => Number.isFinite(r.lat)).map((r) => [r.lat, r.lon])) },
    { n: majors.length, cls: 'major', label: t('threat.major'), glyph: '●', act: () => focusGauges(majors) },
    { n: toMajor.length, cls: 'major', label: t('threat.tomajor'), glyph: '▲', act: () => focusGauges(toMajor) },
    (() => { const rw = recordWatchGauges(); return { n: rw.length, cls: rw.some((g) => recordContext(g).atOrAbove) ? 'emergency' : 'major', label: t('threat.record'), glyph: '⚑', act: () => { fitTo(rw.map((g) => [g.latitude, g.longitude])); document.querySelector('.tabs button[data-tab="tab-gauges"]').click(); } }; })(),
    // roads chip counts operator road-notice cards (requests.json), not the DriveTexas feed — curated
    { n: roads.length, cls: 'warn', label: t('threat.roads'), glyph: '🚧', src: 'curated', act: () => fitTo(roads.filter((r) => Number.isFinite(r.lat)).map((r) => [r.lat, r.lon])) },
    {
      n: state.gauges.filter((g) => gaugeCat(g) !== 'none' && (gaugeTrend(g.lid) || {}).dir === 'down').length,
      cls: 'good', label: t('threat.falling'), glyph: '▼',
      act: () => fitTo(state.gauges.filter((g) => gaugeCat(g) !== 'none' && (gaugeTrend(g.lid) || {}).dir === 'down').map((g) => [g.latitude, g.longitude])),
    },
  ].filter((c) => c.n > 0);
  if (!chips.length) {
    if (!state.alertsLoadedOnce) { el.innerHTML = ''; return; }
    if (quietState()) {
      const normal = state.gauges.filter((g) => gaugeCat(g) === 'none' && !gaugeObsStale(g)).length;
      const sub = t('quiet.sub').replace('{n}', state.gauges.length).replace('{m}', normal);
      el.innerHTML = `${pbNote}<div class="strip-ok quiet"><span class="ok-line">${esc(t('quiet.line'))}</span><span class="ok-sub">${esc(sub)}</span></div>`;
      return;
    }
    el.innerHTML = pbNote + headlineHtml()
      + `<div class="strip-ok"><span class="ok-line">${esc(t('threat.okline'))}</span><span class="ok-sub">${esc(t('threat.oksub'))}</span></div>`;
    bindHeadline(el);
    return;
  }
  el.innerHTML = pbNote + headlineHtml();
  bindHeadline(el);
  if (chips.some((c) => c.cls === 'emergency')) {
    const h = document.createElement('div');
    h.className = 'threat-head';
    h.textContent = t('threat.headline');
    el.appendChild(h);
  }
  const grid = document.createElement('div');
  grid.className = 'threat-grid';
  for (const c of chips) {
    const b = document.createElement('button');
    b.className = `stat-row ${c.cls}`;
    b.innerHTML = `<span class="glyph">${c.glyph}</span><span class="num">${c.n}</span><span class="lbl">${esc(c.label)}</span>` +
      (c.src ? srcBadge(c.src, 'src-mini') : '');
    if (c.src) b.title = t(`src.${c.src}.title`);
    b.addEventListener('click', c.act);
    grid.appendChild(b);
  }
  // the board knows crest timing and emergency clocks — surface them at glance level
  const soonest = state.gauges
    .filter((g) => gaugeRising(g) && CAT_RANK[gaugeForecastCat(g)] >= CAT_RANK.minor
      && new Date(g.status.forecast.validTime) > new Date()) // a crest already past is not "next"
    .sort((a, b) => new Date(a.status.forecast.validTime) - new Date(b.status.forecast.validTime))[0];
  if (soonest) {
    const b = document.createElement('button');
    b.className = 'stat-row major crest';
    const river = riverOf(soonest.name);
    b.innerHTML = `<span class="glyph">⏱</span><span class="num">${esc(fmtWhen(soonest.status.forecast.validTime).split(' · ')[0])}</span><span class="lbl">${esc(t('threat.nextcrest'))}</span><span class="riv">· ${esc(river.slice(0, 22))}</span>`;
    b.addEventListener('click', () => state.map.setView([soonest.latitude, soonest.longitude], 11));
    grid.appendChild(b);
  }
  el.appendChild(grid);
  const emergAlerts = state.alerts.filter((a) => a._sev === 'emergency');
  if (emergAlerts.length) {
    const row = document.createElement('div');
    row.className = 'ffe-row';
    const tag = document.createElement('span');
    tag.className = 'ffe-tag';
    tag.textContent = t('threat.ffemergtag');
    row.appendChild(tag);
    const goAlerts = () => document.querySelector('.tabs button[data-tab="tab-alerts"]').click();
    for (const a of emergAlerts) {
      const where = (a.properties.areaDesc || '?').split(';')[0].replace(/, TX$/, '');
      const until = new Date(a.properties.expires).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
      const b = document.createElement('button');
      b.className = 'ffe-chip';
      b.title = t('ffe.opentab');
      b.innerHTML = `${esc(where)} <span class="until">→ ${esc(until)}</span>`;
      b.addEventListener('click', goAlerts);
      row.appendChild(b);
    }
    el.appendChild(row);
  }
}

/* ---------- actionable ticker — recency-biased glance line ---------- */

const relWhen = (iso) => fmtWhen(iso).split(' · ')[0];

// aging invariant: only active alerts, rising/in-flood gauges, fresh LSRs, and non-aged critical notices qualify
function tickerItems() {
  const emerg = [], rise = [], majors = [];
  const goAlerts = () => document.querySelector('.tabs button[data-tab="tab-alerts"]').click();
  for (const a of state.alerts.filter((x) => x._sev === 'emergency' && new Date(x.properties.expires) > new Date())) {
    const where = (a.properties.areaDesc || '?').split(';')[0].replace(/, TX$/, '');
    const until = new Date(a.properties.expires).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
    emerg.push({ text: t('ticker.ffe').replace('{where}', where).replace('{t}', until), color: 'var(--sev-emergency)', act: goAlerts });
  }
  const rising = state.gauges.filter((g) => gaugeRising(g) && CAT_RANK[gaugeForecastCat(g)] >= CAT_RANK.minor)
    .sort((a, b) => new Date(a.status.forecast.validTime) - new Date(b.status.forecast.validTime));
  for (const g of rising) {
    const fCat = gaugeForecastCat(g);
    rise.push({ text: `▲ ${riverOf(g.name)} → ${catWord(fCat).toUpperCase()} ${t('wave.crest')} ${relWhen(g.status.forecast.validTime)}`, color: `var(--cat-${fCat})`, act: () => focusGauge(g) });
  }
  for (const g of state.gauges.filter((x) => gaugeCat(x) === 'major' && !gaugeRising(x))) {
    const tr = gaugeTrend(g.lid);
    const trendBit = tr ? ` ${tr.rate >= 0 ? '+' : ''}${tr.rate.toFixed(1)} ft/hr` : '';
    majors.push({ text: `● ${riverOf(g.name)} ${t('catw.major')} ${fmtNum(g.status.observed.primary)} ft${trendBit}`, color: 'var(--cat-major)', act: () => focusGauge(g) });
  }
  const tail = [];
  const freshLsrs = state.lsrs.filter((f) => f.geometry && Array.isArray(f.geometry.coordinates) && ageMins(f.properties.valid) <= lsrFreshCutoffMins()).slice(0, 2);
  for (const f of freshLsrs) {
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    tail.push({ text: `💧 ${p.typetext} ${p.city} · ${relWhen(p.valid)}`, act: () => state.map.setView([lat, lon], 12) });
  }
  const crit = activeRequests().filter((r) => r.status !== 'resolved' && r.priority === 'critical')
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))[0];
  if (crit) {
    const head = crit.summary.length > 60 ? `${crit.summary.slice(0, 59)}…` : crit.summary;
    tail.push({
      text: `${TYPE_GLYPH[crit.type] || '📍'} ${head} · ${relWhen(crit.ts)}`,
      color: 'var(--sev-emergency)',
      act: () => {
        document.querySelector('.tabs button[data-tab="tab-requests"]').click();
        if (Number.isFinite(crit.lat)) state.map.setView([crit.lat, crit.lon], 12);
      },
    });
  }
  // ~12-item budget: emergencies, majors, and the ground-truth tail keep their slots; the rising block absorbs the trim
  const riseSlots = Math.max(0, 12 - tail.length - emerg.length - majors.length);
  return emerg.concat(rise.slice(0, riseSlots), majors, tail);
}

function renderTicker() {
  const el = $('#ticker');
  if (!el) return;
  const items = tickerItems();
  state.tickerActs = items.map((i) => i.act);
  if (!items.length) { el.hidden = true; state.tickerHash = ''; return; }
  el.hidden = false;
  const half = items.map((i, n) =>
    `<span class="ticker-item" data-ti="${n}"${i.color ? ` style="color:${i.color}"` : ''}>${esc(i.text)}</span><span class="ticker-sep">·</span>`).join('');
  if (half === state.tickerHash) return; // unchanged — don't restart the scroll animation
  state.tickerHash = half;
  $('#ticker-track').innerHTML = `<span class="ticker-half">${half}</span><span class="ticker-half">${half}</span>`;
}

/* ---------- tiles / header ---------- */

function renderTiles() {
  renderThreatStrip();
  renderTicker();
  renderDriveMode(); // no-op when Drive Mode is closed; keeps the glance list live on each refresh
  const emergencies = state.alerts.filter((a) => a._sev === 'emergency').length;
  const warnings = state.alerts.filter((a) => a._sev === 'warning').length;
  const inFlood = state.gauges.filter((g) => FLOOD_CATS.includes(gaugeCat(g)));
  const major = inFlood.filter((g) => gaugeCat(g) === 'major').length;
  const rising = state.gauges.filter(gaugeRising).length;
  const open = activeRequests().filter((r) => r.status !== 'resolved').length;
  const crit = activeRequests().filter((r) => r.status !== 'resolved' && r.priority === 'critical').length;
  const flag = document.title.startsWith('🔴') ? '🔴 ' : '';
  document.title = `${flag}${crit ? `(${crit}) ` : ''}${state.baseTitle}`;
  $('#tile-emergency .value').innerHTML = `<span class="dot" style="background:var(--sev-emergency)"></span>${emergencies}`;
  $('#tile-warnings .value').textContent = warnings;
  // never render a confident 0 when the feed has not loaded — a missing MAJOR is dangerous
  $('#tile-gauges .value').innerHTML = state.sourceHealth.gauges || state.gauges.length
    ? `${inFlood.length} <span class="unit">${major} ${esc(t('catw.major').toLowerCase())} · ▲${rising}</span>`
    : `– <span class="unit">${esc(t('word.nodata'))}</span>`;
  $('#tile-open .value').textContent = open;
}

// seeds are re-fetched every refresh so open clients pick up curated data updates
async function loadSeeds() {
  try {
    const bust = `?_=${Date.now()}`;
    const [reqs, res] = await Promise.all([
      fetch(`data/requests.json${bust}`).then((r) => r.json()),
      fetch(`data/resources.json${bust}`).then((r) => r.json()),
    ]);
    // crest-of-record context — absence-tolerant (older deploys shipped no records.json)
    if (!state.records) {
      state.records = (await fetch(`data/records.json${bust}`).then((r) => (r.ok ? r.json() : null)).catch(() => null) || {}).records || {};
    }
    // low-water crossings — absence-tolerant; refetched each cycle for status changes; transient failure keeps last-good, never wipes to []
    const xing = await fetch(`data/crossings.json${bust}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (xing && Array.isArray(xing.crossings)) state.crossings = xing.crossings;
    else state.crossings = state.crossings || [];
    // live NSS shelters — absence-tolerant (poller may never have run); transient failure keeps last-good
    const shl = await fetch(`data/shelters-live.json${bust}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (shl && Array.isArray(shl.shelters)) state.sheltersLive = shl;
    markHealthy('seeds');
    state.seedRequests = reqs.requests || [];
    state.resources = res;
    // hash = content + per-card aging fingerprint: identical seeds skip the re-render (scroll guard),
    // but aged/stale/fresh-bucket transitions on idle clients still repaint list, tiles, and crossings
    const agingFp = allRequests().map((r) => [r.id, cardAged(r) ? 1 : 0, r.status !== 'resolved' && ageMins(r.ts) > CONFIG.staleMins ? 1 : 0, freshClass(r.ts)]);
    const crossingFp = state.crossings.map((c) => (c.updated_at ? (Date.now() - new Date(c.updated_at).getTime()) / 3600000 : Infinity) > CROSSING_STALE_H ? 1 : 0);
    const hash = JSON.stringify([reqs, res, state.crossings, agingFp, crossingFp, state.sheltersLive]);
    if (hash === state.seedHash) return true;  // unchanged — don't reset operator's scroll
    state.seedHash = hash;
    renderRequests();
    renderResources();
    renderCrossings();
    renderMonitors();
    pbRefreshCurated(); // playback may have engaged before this data arrived
    return true;
  } catch { return false; }
}

const CROSSING_STALE_H = 12;
const CROSSING_STATUS = {
  closed: { color: 'var(--sev-emergency)', glyph: '⛔', key: 'xword.closed' },
  caution: { color: 'var(--cat-action)', glyph: '⚠', key: 'xword.caution' },
  longterm: { color: 'var(--ink-muted)', glyph: '⛔', key: 'xword.longterm' },
  open: { color: 'var(--good)', glyph: '✓', key: 'xword.open' },
};
const xstLabel = (st) => t(st.key).toUpperCase();
function renderCrossings() {
  const layer = state.layers.crossings;
  if (layer) layer.clearLayers();
  const list = state.crossings || [];
  const el = $('#crossings-body');
  if (el) {
    el.innerHTML = list.length
      ? `<div class="section-title">${esc(t('cross.title'))}</div>` +
        list.map((c) => {
          const st = CROSSING_STATUS[c.status] || CROSSING_STATUS.caution;
          const staleH = c.updated_at ? (Date.now() - new Date(c.updated_at).getTime()) / 3600000 : Infinity;
          const stale = staleH > CROSSING_STALE_H ? ` · <span class="xg-stale">${esc(t('cross.stale').replace('{h}', Math.round(staleH)))}</span>` : '';
          return `<div class="resource-item"><strong style="color:${st.color}">${st.glyph} ${esc(xstLabel(st))}</strong>: ${esc(c.name)} ${srcBadge('curated')}` +
            `<div class="addr">${esc(c.reason || '')} · ${esc(t('word.updated').toLowerCase())} ${esc(fmtWhen(c.updated_at))}${stale}${c.source && safeUrl(c.source) !== '#' ? ` <a href="${esc(safeUrl(c.source))}" target="_blank" rel="noopener">src</a>` : ''}</div></div>`;
        }).join('') +
        `<div class="resource-item" style="border:none"><a href="https://drivetexas.org/" target="_blank" rel="noopener">${esc(t('cross.drivetx'))}</a></div>`
      : '';
  }
  for (const c of list) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon) || !layer) continue;
    const st = CROSSING_STATUS[c.status] || CROSSING_STATUS.caution;
    const icon = L.divIcon({ className: '', html: `<div class="crossing-icon" style="border-color:${st.color};color:${st.color}">${st.glyph}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
    const m = L.marker([c.lat, c.lon], { icon });
    m.bindPopup(`<div class="popup-title" style="color:${st.color}">${st.glyph} ${esc(xstLabel(st))} · ${esc(t('risk.read.crosspost'))}</div><div>${esc(c.name)} ${srcBadge('curated')}</div>` +
      `<div class="popup-meta">${esc(c.reason || '')}</div>` +
      `<div class="popup-meta">${esc(t('cross.updated').replace('{t}', fmtWhen(c.updated_at)))}</div>` +
      (c.source && safeUrl(c.source) !== '#' ? `<div class="popup-link"><a href="${esc(safeUrl(c.source))}" target="_blank" rel="noopener">${esc(t('word.source'))}</a></div>` : ''));
    layer.addLayer(m);
  }
  renderReopenedRoads();
}

/* ---------- recently reopened roads — recovery view of the DriveTexas feed ---------- */

function reopenedItemHtml(r, aged) {
  const ct = ROAD_COND[r.condition] || ROAD_COND_FALLBACK;
  const nav = r.vertex ? ` data-lat="${r.vertex[0]}" data-lon="${r.vertex[1]}"` : '';
  return `<div class="resource-item reopened${aged ? ' aged' : ''}"${nav}><strong>✓ ${esc(t('reopen.flag'))}</strong>: ${esc(prettyRoute(r.route_name) || t('word.road'))}` +
    `<div class="addr">${esc(t('reopen.was'))}: ${esc(roadLabel(ct))} · ${esc(t('reopen.at'))} ${esc(fmtWhen(r.reopenedAt))} · <a href="https://drivetexas.org/" target="_blank" rel="noopener">src</a></div></div>`;
}

function renderReopenedRoads() {
  const host = $('#crossings-body');
  if (!host) return;
  let el = $('#reopened-roads');
  if (!el) {
    el = document.createElement('div');
    el.id = 'reopened-roads';
    host.parentNode.insertBefore(el, host.nextSibling);
  }
  const raw = reopenedRoads();
  const fresh = raw.fresh.filter(reopenIsFlood);
  const aged = raw.aged.filter(reopenIsFlood);
  if (!fresh.length && !aged.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="section-title">${esc(t('reopen.title'))}</div>` +
    fresh.map((r) => reopenedItemHtml(r, false)).join('') +
    `<div class="resource-item" style="border-bottom:none;font-size:11px;color:var(--ink-muted)">${srcBadge('official')} ${esc(ROAD_ATTRIB)}</div>`;
  if (aged.length) {
    const btn = document.createElement('button');
    btn.className = 'aged-toggle';
    btn.textContent = `${t(state.showAgedReopened ? 'toggle.hide' : 'toggle.show')} ${t('reopen.aged').replace('{n}', aged.length).replace('{h}', CONFIG.reopenedAgeHours).replace('{d}', CONFIG.histDays)}`;
    btn.addEventListener('click', () => { state.showAgedReopened = !state.showAgedReopened; renderReopenedRoads(); });
    el.appendChild(btn);
    if (state.showAgedReopened) el.insertAdjacentHTML('beforeend', aged.map((r) => reopenedItemHtml(r, true)).join(''));
  }
  el.querySelectorAll('.resource-item.reopened[data-lat]').forEach((d) => d.addEventListener('click', (ev) => {
    if (ev.target.closest('a')) return;
    state.map.setView([+d.dataset.lat, +d.dataset.lon], 12);
  }));
}

