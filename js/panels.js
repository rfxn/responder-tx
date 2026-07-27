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
  revealMapOnPhone();
}

const DEG_GLYPH = { nothresh: '◌', stale: '⏱', oos: '⊘' };

function gaugeGlyphHtml(g) {
  if (gaugeDegraded(g)) {
    const gs = gaugeState(g);
    return `<span class="stale-glyph" title="${esc(gaugeStateLabel(gs))}">${DEG_GLYPH[gs] || '◌'}</span>`;
  }
  if (gaugeObsStale(g)) return `<span class="stale-glyph" title="${esc(t('gauge.staleglyph'))}">⏱</span>`;
  if (gaugeRising(g)) return `<span style="color:var(--cat-${gaugeForecastCat(g)})">▲</span>`;
  const cat = gaugeCat(g);
  if (cat === 'none') return '<span style="color:var(--cat-none)">○</span>';
  if ((gaugeTrend(g.lid) || {}).dir === 'down') return '<span style="color:var(--good)">▼</span>';
  return `<span style="color:var(--cat-${cat})">●</span>`;
}

/* A card for a gauge NWPS reports as degraded says the degraded state where a severity word would
   go, never a category. "Normal" off a gauge with no thresholds defined would be the board reading
   a severity it does not have, which is the whole reason these gauges are split out. */
function gaugeCardDiv(g) {
  const deg = gaugeDegraded(g);
  const gs = gaugeState(g);
  const stale = gaugeObsStale(g);
  const cat = gaugeObsCat(g);
  const o = g.status.observed;
  const tr = stale ? null : gaugeTrend(g.lid);
  const fCat = gaugeForecastCat(g);
  const f = g.status.forecast;
  const site = g.name.slice(riverOf(g.name).length).trim();
  const div = document.createElement('div');
  div.className = `card gauge-card${deg ? ' degraded' : ''}${stale ? ' stale' : (cat === 'none' && !gaugeRising(g) ? ' aged' : '')}`;
  div.dataset.lid = g.lid;
  div.dataset.gstate = gs;
  div.style.borderLeftColor = deg || stale ? 'var(--cat-none)' : `var(--cat-${cat})`;
  const trendBit = tr ? ` ${tr.dir === 'up' ? '↑' : tr.dir === 'down' ? '↓' : '→'} ${tr.rate >= 0 ? '+' : ''}${tr.rate.toFixed(1)} ft/hr` : '';
  const word = deg
    ? `<span class="cat-word deg-word">${esc(gaugeStateLabel(gs))}</span>`
    : `<span class="cat-word" style="color:var(--cat-${stale ? 'none' : cat})">${esc(catWord(cat))}</span>${trendBit}`;
  div.innerHTML = `<div class="head">${gaugeGlyphHtml(g)}<span class="g-name">${esc(g.name)}</span>` +
    `<span class="geo-flag" title="${esc(t('sync.geoflag.title'))}">📍</span>` +
    `<span class="when"><a href="https://water.noaa.gov/gauges/${esc(g.lid)}" target="_blank" rel="noopener" style="color:var(--accent)">NWPS →</a></span></div>` +
    `<div class="meta">OBS ${gaugeHasReading(g) ? `${fmtNum(o.primary)} ${esc(o.primaryUnit)} · ${word}` : (deg ? word : esc(t('gauge.noreading')))}</div>` +
    (deg ? `<div class="meta stale-note">${esc(t(`gstate.${gs}.note`))}</div>`
      : (stale ? `<div class="meta stale-note">⏱ ${esc(t('gauge.stale').replace('{t}', fmtWhen(o.validTime)))}</div>` : '')) +
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
  const p = state.myPos;
  const fix = p && Number.isFinite(p.lat) && Number.isFinite(p.lng) ? [[p.lat, p.lng]] : null;
  /* Until now a tornado warning directly over the truck appeared nowhere in the surface built for
     the person in the truck. These rows lead with the action and sit above every crossing: a
     crossing is a point you might drive to, a warning is a polygon you may be standing inside. */
  for (const f of alertDedupe((state.alerts || []).filter((x) => alertOpen(x) && hazardGlance(x)))) {
    const act = alertActionKey(f);
    if (!act) continue;
    const geom = alertGeom(f);
    const b = geoBounds(geom);
    const d = fix ? geoDistMi(geom, fix) : NaN;
    const motion = alertMotionText(f);
    items.push({
      glyph: hazardGlyph(f),
      color: f._sev === 'emergency' ? 'var(--sev-emergency)' : `var(--haz-${hazardStyleKey(f)}, var(--sev-warning))`,
      name: t(act),
      sub: [f.properties.event, `${t('alert.untilShort')} ${tickerUntil(f)}`, motion, alertAreaText(f.properties, 2)].filter(Boolean).join(' · '),
      lat: b ? (b.n + b.s) / 2 : null, lon: b ? (b.e + b.w) / 2 : null,
      rank: 0, pin: d === 0, // standing inside the polygon outranks anything a distance sort could say
    });
  }
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
  // recovery: recently reopened roads tail the list as low-priority ✓ entries — never competing with hazards for slots
  const cleared = [];
  for (const r of reopenedRoads().fresh) {
    if (!r.vertex || !reopenIsFlood(r)) continue;
    cleared.push({ glyph: '✓', color: 'var(--good)', name: `${t('reopen.flag')} · ${prettyRoute(r.route_name) || t('ntype.road')}`, sub: `TxDOT DriveTexas · ${t('reopen.at')} ${relWhen(r.reopenedAt)}`, lat: r.vertex[0], lon: r.vertex[1], rank: 3 });
  }
  // live TxDOT road closures/flooding/damage, standing at the line vertex nearest the driver
  for (const f of roadFeatures()) {
    const pt = roadPointNear(f.geometry, p);
    if (!pt) continue;
    const ct = roadCondType(f.properties);
    const cond = f.properties.condition;
    const sub = f.properties._snapshot ? `TxDOT DriveTexas · ${t('roads.snapshot.sub')}` : 'TxDOT DriveTexas';
    items.push({ glyph: cond === 'Flooding' ? '🌊' : cond === 'Damage' ? '⚠' : '⛔', color: ct.color, name: `${roadLabel(ct)} · ${prettyRoute(f.properties.route_name) || t('ntype.road')}`, sub, lat: pt[0], lon: pt[1], rank: cond === 'Damage' ? 2 : 1 });
  }
  // verify-before-routing: the 2 nearest cameras tail the list like the reopened rows — never competing with hazards
  const cams = [];
  if (p && state.cameras) {
    const pool = [['txdot', 'txdot'], ['river', 'river'], ['austin', 'austin'], ['atxfloods', 'atxfloods'], ['houston', 'houston'], ['arlington', 'arlington'], ['elpbridge', 'elpbridge'], ['hays', 'hays'], ['porthou', 'porthou']]
      .flatMap(([arr, kind]) => (state.cameras[arr] || []).map((c) => ({ c, kind })));
    for (const x of pool) { if (Number.isFinite(x.c.lat) && Number.isFinite(x.c.lon)) x.d = distMi(p.lat, p.lng, x.c.lat, x.c.lon); }
    for (const x of pool.filter((y) => y.d != null).sort((a, b) => a.d - b.d).slice(0, 2)) {
      cams.push({
        glyph: camIsLive(x.c) ? '▶' : '📷', color: 'var(--accent)', name: camTitle(x.c, x.kind),
        sub: `${camKindLong(x.c)} · ${camNetLabel(x.kind)} · ${t('cam.view')}`,
        lat: x.c.lat, lon: x.c.lon, rank: 4, cam: x.c, camKind: x.kind,
      });
    }
  }
  if (p) {
    for (const it of items.concat(cleared, cams)) {
      if (!Number.isFinite(it.lat) || !Number.isFinite(it.lon)) continue; // a zone-only warning has no centre to measure to
      it.dist = distMi(p.lat, p.lng, it.lat, it.lon);
      it.brng = bearing(p.lat, p.lng, it.lat, it.lon);
    }
    const dv = (x) => (x.dist == null ? Infinity : x.dist);
    const byDist = (a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0) || dv(a) - dv(b);
    items.sort(byDist);
    cleared.sort(byDist);
  } else {
    items.sort((a, b) => a.rank - b.rank);
  }
  return items.slice(0, 14).concat(cleared.slice(0, 4), cams);
}

function renderDriveMode() {
  if ($('#drive-mode').hidden) return;
  // camera rows need the inventory — fetch once, re-render when it lands
  if (!state.cameras) loadCameras().then(() => renderDriveMode()).catch(() => { /* no cams — hazard rows unaffected */ });
  const emerg = state.alerts.filter((a) => a._sev === 'emergency' && alertOpen(a));
  const soonest = state.gauges
    .filter((g) => gaugeRising(g) && CAT_RANK[gaugeForecastCat(g)] >= CAT_RANK.moderate && new Date(g.status.forecast.validTime) > new Date())
    .sort((a, b) => new Date(a.status.forecast.validTime) - new Date(b.status.forecast.validTime))[0];
  $('#drive-threat').innerHTML =
    // a gloved ten-second read: the two nearest AO counties per alert, the rest counted, never a 430-char line
    (emerg.length ? `<div class="dt-emerg">⚠ ${emerg.length} ${esc(t('drive.emerg'))}: ${esc(emerg.map((a) => alertAreaText(a.properties, 2)).join('; '))}</div>` : '') +
    (soonest ? `<div class="dt-crest">${esc(t('drive.nextcrest'))} ${esc(riverOf(soonest.name))} ${esc(fmtWhen(soonest.status.forecast.validTime))}</div>` : '') +
    (state.myPos ? '' : `<div class="dt-nogps">${esc(t('drive.nogps'))}</div>`);
  const items = driveItems();
  state.driveCams = items.map((it) => (it.cam ? { cam: it.cam, kind: it.camKind } : null));
  $('#drive-list').innerHTML = items.length ? items.map((it, i) => {
    const distBit = it.dist != null ? `<span class="d-dist">${it.dist.toFixed(1)} ${esc(t('risk.mi'))} ${it.brng}</span>` : '';
    return `<button class="drive-row${it.pin ? ' d-here' : ''}" data-lat="${it.lat}" data-lon="${it.lon}"${it.cam ? ` data-cam="${i}"` : ''}>` +
      `<span class="d-glyph" style="color:${it.color}">${it.glyph}</span>` +
      `<span class="d-body"><span class="d-name">${esc(it.name)}</span><span class="d-sub">${esc(it.sub)}</span></span>${distBit}</button>`;
  }).join('') : `<div class="dt-nogps">${esc(t('drive.nohaz'))}</div>`;
  $('#drive-list').querySelectorAll('.drive-row').forEach((b) => b.addEventListener('click', () => {
    const dc = b.dataset.cam != null && state.driveCams[+b.dataset.cam];
    if (dc) { openCamViewer(dc.cam, dc.kind); return; } // viewer overlays Drive Mode — stays one-handed
    const lat = +b.dataset.lat, lon = +b.dataset.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return; // zone-only warning: nothing to fly to, stay in Drive Mode
    $('#drive-mode').hidden = true;
    keepAwake(false, 'drive'); // tapping a hazard exits Drive Mode; drop the screen-awake hold
    state.map.setView([lat, lon], 13);
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
  const text = secs == null
    ? `⌖ ${t('drive.autoupd')} · ${t('drive.locating')}`
    : `⌖ ${t('drive.autoupd')} · ${t('drive.lastfix').replace('{s}', secs)}`;
  if (el.textContent !== text) el.textContent = text; // ticks every second: only touch the DOM on a change
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

/* The crest file mixes peaks this board read from its own committed snapshots with peaks rebuilt
   from the upstream USGS/NWPS record for the window before that archive begins. gen-crest-summary
   marks the rebuilt ones with src; an after-action artifact has to carry the distinction. */
const crestReconRows = (rows) => (Array.isArray(rows) ? rows : []).filter((g) => g.src).length;

function crestSourceCite(rows) {
  const n = crestReconRows(rows);
  return n
    ? t('summary.source.mixed').replace('{n}', n).replace('{m}', rows.length)
    : t('summary.source');
}

function crestRowHtml(g) {
  const cat = g.peak_category;
  const badges =
    `<span class="badge" style="border-color:var(--cat-${esc(cat)});color:var(--cat-${esc(cat)});font-weight:700">${esc(cat.toUpperCase())}</span>` +
    (g.src ? ` <span class="badge stale-note" title="${esc(t('summary.recon.title'))}">⟲ ${esc(t('summary.recon'))}</span>` : '') +
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

const VIEW_RIVER_SLUG = /^[a-z0-9-]{1,60}$/; // allowlist: an unknown slug falls back to the most active river

// closeLens keep — leave every lens except `keep`; radio semantics for the whole family
function closeLens(keep) {
  const shown = (sel) => { const el = $(sel); return !!el && !el.hidden; };
  if (keep !== 'drive' && shown('#drive-mode')) {
    $('#drive-mode').hidden = true;
    updateDriveFreshness();
    keepAwake(false, 'drive'); // location tracking continues in the app, only the screen lock is released
  }
  if (keep !== 'summary' && shown('#summary-view')) $('#summary-view').hidden = true;
  if (keep !== 'recovery' && shown('#recovery-view')) $('#recovery-view').hidden = true;
  if (keep !== 'basin' && shown('#basin-view')) closeBasinView();
  if (keep !== 'playback' && state.pb && shown('#playback-bar')) closePlayback();
}

// openView name, opts — the one dispatcher for ?view= deep links; routes by name, never by button id
function openView(name, opts) {
  const river = String((opts && opts.river) || '');
  switch (name) {
    case 'live': closeLens(null); break; // the board itself; the way back out of any lens
    case 'drive': closeLens('drive'); if (typeof enterDriveMode === 'function') enterDriveMode(); break;
    case 'basin': closeLens('basin'); if (typeof openBasinView === 'function') openBasinView(VIEW_RIVER_SLUG.test(river) ? river : null); break;
    case 'playback': closeLens('playback'); if (typeof openPlayback === 'function') openPlayback(); break;
    case 'recovery': closeLens('recovery'); if (typeof openRecoveryView === 'function') openRecoveryView(); break;
    case 'summary': closeLens('summary'); if (typeof openCrestSummary === 'function') openCrestSummary(); break;
    default: break; // absent or unknown: leave the board where it is rather than throw on a stale link
  }
  if (typeof syncViewsTrigger === 'function') syncViewsTrigger();
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
    `<div class="sum-cite">${esc(crestSourceCite(d.gauges))}${w.first ? ` · ${esc(fmtCT(w.first))} → ${esc(fmtCT(w.last))}` : ''}${w.first_incomplete ? ` · ${esc(t('summary.window.partial'))}` : ''}</div>` +
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
  const gaugeCite = `<div class="sum-cite">${esc(crestSourceCite(rows))}</div>`;

  const reo = reopenedRoads();
  const freshReo = reo.fresh.filter(reopenIsFlood);
  const agedReo = reo.aged.filter(reopenIsFlood);
  const roadItems = freshReo.map((r) => reopenedItemHtml(r, false)).join('') +
    (agedReo.length ? `<div class="rcv-none">${esc(t('reopen.aged').replace('{n}', agedReo.length).replace('{h}', CONFIG.reopenedAgeHours).replace('{d}', CONFIG.histDays))}</div>` : '');
  const roadCite = `<div class="sum-cite">${srcBadge('official')} ${esc(ROAD_ATTRIB)} · ${esc(t('reopen.cleared'))}</div>`;

  const res = state.resources || {};
  const shelters = mergeShelters(res.shelters || [], state.sheltersLive && state.sheltersLive.shelters);
  const shlSrcUrl = shlLiveSrcUrl();
  const shelterItems = shelterListHtml(shelters, shlSrcUrl);

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
  if (state.map && !pbBlocksLive(state)) { // playback engaged: never add a live layer under a historical frame
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

/* ---------- basin focus — single-river corridor lens (?view=basin) ---------- */

const BASIN_CATS_BY_RANK = ['none', 'action', 'minor', 'moderate', 'major'];

function basinCrestRowsByLid() {
  const rows = (state.basinCrest && Array.isArray(state.basinCrest.gauges)) ? state.basinCrest.gauges : [];
  const out = {};
  for (const r of rows) out[r.lid] = r;
  return out;
}

// corridor rings survive marker re-renders: renderGauges calls this after rebuilding markers
function basinApplyHighlight() {
  const want = state.basinHiLids || null;
  for (const lid in (state.gaugeMarkers || {})) {
    const m = state.gaugeMarkers[lid];
    const el = m && m.getElement && m.getElement();
    const hit = el && el.querySelector && el.querySelector('.gauge-hit');
    if (hit) hit.classList.toggle('basin-hi', !!(want && want.has(lid)));
  }
}

function basinCrestLineHtml(x) {
  const { g, row, crestT } = x;
  const now = Date.now();
  if (row && !row.stale && row.peak_time && Date.parse(row.peak_time) <= now) {
    return `<span style="color:var(--cat-${esc(row.peak_category || 'none')})">` +
      `${esc(t('basin.crested').replace('{t}', relWhen(row.peak_time)).replace('{ft}', fmtNum(row.peak)))}</span>`;
  }
  const f = g.status && g.status.forecast;
  if (f && Number.isFinite(f.primary) && f.primary > -999 && crestT != null) {
    const fCat = gaugeForecastCat(g);
    const col = fCat ? `var(--cat-${fCat})` : '#d9dee3';
    if (x.wave !== 'none' && Math.abs(crestT - now) <= 90 * 60000) {
      return `<span style="color:${col}">${esc(t('basin.cresting').replace('{ft}', fmtNum(f.primary)))}</span>`;
    }
    const word = crestT > now ? t('gauge.fcrest') : t('wave.crested');
    return `<span style="color:${col}">${esc(word)} ${fmtNum(f.primary)} ft · ${esc(fmtWhen(f.validTime))}</span>`;
  }
  return `<span class="basin-nocrest">${esc(t('basin.nocrest'))}</span>`;
}

function basinGaugeRowHtml(x, isFront) {
  const { g, stale } = x;
  const cat = gaugeCat(g);
  const o = g.status.observed;
  const tr = stale ? null : gaugeTrend(g.lid);
  const site = g.name.slice(riverOf(g.name).length).trim() || g.name;
  const trendBit = tr ? ` ${tr.dir === 'up' ? '↑' : tr.dir === 'down' ? '↓' : '→'} ${tr.rate >= 0 ? '+' : ''}${tr.rate.toFixed(1)} ft/hr` : '';
  const obsBit = (Number.isFinite(o.primary) && o.primary > -999)
    ? `${esc(t('recovery.now'))} ${fmtNum(o.primary)} ${esc(o.primaryUnit || 'ft')} · <span class="cat-word" style="color:var(--cat-${stale ? 'none' : cat})">${esc(catWord(cat))}</span>${esc(trendBit)}`
    : esc(t('gauge.noreading'));
  const railCls = x.wave === 'passed' ? 'passed' : x.wave === 'coming' ? 'coming' : 'quiet';
  const glyph = x.wave === 'passed' ? '✓' : x.wave === 'coming' ? '●' : '○';
  return (isFront ? `<div class="basin-front">〜 ${esc(t('basin.front'))} 〜</div>` : '') +
    `<button class="basin-row" data-lid="${esc(g.lid)}">` +
    `<span class="basin-rail ${railCls}">${glyph}</span>` +
    `<span class="basin-main"><span class="basin-site">${esc(site)}</span>` +
    `<span class="basin-obs">${obsBit}</span>` +
    (stale ? `<span class="basin-crest stale-note">⏱ ${esc(t('gauge.stale').replace('{t}', fmtWhen(o.validTime)))}</span>`
      : `<span class="basin-crest">${basinCrestLineHtml(x)}</span>`) +
    '</span></button>';
}

function renderBasinBody() {
  const el = $('#basin-body');
  if (!el) return;
  if (!state.gauges.length) { el.innerHTML = `<div class="sum-quiet">${esc(t('changelog.loading'))}</div>`; return; }
  const crestRows = basinCrestRowsByLid();
  const rivers = basinRivers(state.gauges, crestRows);
  if (!rivers.length) { el.innerHTML = `<div class="sum-quiet">${esc(t('basin.none'))}</div>`; return; }
  let sel = state.basinRiver ? rivers.find((r) => r.slug === state.basinRiver) : null;
  if (!sel) sel = rivers[0]; // unknown or absent slug: fall back to the most active river
  state.basinRiver = sel.slug;

  const activeRivers = rivers.filter((r) => r.active || r.crested);
  const chips = activeRivers.slice(0, 10).map((r) =>
    `<button class="basin-chip${r.slug === sel.slug ? ' sel' : ''}" data-river="${esc(r.slug)}">` +
    `<span class="basin-chip-dot" style="background:var(--cat-${BASIN_CATS_BY_RANK[r.worst] || 'none'})"></span>${esc(r.river)}</button>`).join('');
  const opts = rivers.map((r) =>
    `<option value="${esc(r.slug)}"${r.slug === sel.slug ? ' selected' : ''}>${esc(r.river)} (${r.gauges.length})</option>`).join('');

  // only material wave points feed corridor direction and the wave framing (no fabricated motion)
  const states = {};
  const waveTimes = {};
  for (const g of sel.gauges) {
    states[g.lid] = basinWaveState(g, crestRows[g.lid]);
    if (states[g.lid].wave !== 'none') waveTimes[g.lid] = states[g.lid].crestT;
  }
  const corridor = basinCorridor(sel.gauges, waveTimes);
  const infos = corridor.order.map((g) => Object.assign({ g, row: crestRows[g.lid], stale: gaugeObsStale(g) }, states[g.lid]));
  const nPassed = infos.filter((x) => x.wave === 'passed').length;
  const nComing = infos.filter((x) => x.wave === 'coming').length;
  const nFlood = sel.gauges.filter((g) => gaugeCat(g) !== 'none').length;

  let headline;
  const nxt = infos.find((x) => x.wave === 'coming');
  if (nxt) {
    const site = nxt.g.name.slice(riverOf(nxt.g.name).length).trim() || nxt.g.name;
    headline = t('basin.next').replace('{site}', site).replace('{t}', fmtWhen(new Date(nxt.crestT).toISOString()));
  } else if (nPassed) headline = t('basin.allpassed');
  else if (nFlood) headline = t('basin.inflood').replace('{k}', nFlood);
  else headline = t('basin.quiet');

  const caveat = sel.coastal ? t('basin.order.coastal')
    : corridor.basis === 'single' ? t('basin.single')
      : corridor.basis === 'crest' ? (corridor.mismatch ? `${t('basin.order.crest')} ${t('basin.order.mismatch')}` : t('basin.order.crest'))
        : t('basin.order.geo');

  // the front marker sits before the first crest-ahead gauge once at least one point upstream has crested
  let frontIdx = -1;
  const firstComing = infos.findIndex((x) => x.wave === 'coming');
  if (firstComing > -1 && infos.slice(0, firstComing).some((x) => x.wave === 'passed')) frontIdx = firstComing;

  el.innerHTML =
    '<div class="sum-head">' +
    `<div class="sum-event">${esc(t('recovery.event'))} ${esc((state.basinCrest && state.basinCrest.event) || state.baseTitle || '')}</div>` +
    `<div class="sum-cite">${esc(t('basin.sub'))}</div>` +
    '</div>' +
    `<div class="basin-chips">${chips}</div>` +
    `<div class="basin-pickrow"><label for="basin-select">${esc(t('basin.pick'))}</label>` +
    `<select id="basin-select">${opts}</select></div>` +
    `<div class="rcv-headline">${esc(sel.river)} · ${esc(t('basin.counts').replace('{n}', infos.length).replace('{p}', nPassed).replace('{c}', nComing))}</div>` +
    `<div class="basin-headline">${esc(headline)}</div>` +
    (sel.coastal ? '' : `<div class="basin-dir">${esc(t('basin.updown'))}</div>`) +
    infos.map((x, i) => basinGaugeRowHtml(x, i === frontIdx)).join('') +
    `<div class="rcv-note">${esc(caveat)}</div>` +
    `<div class="sum-cite">${esc(crestSourceCite(state.basinCrest && state.basinCrest.gauges))}</div>`;

  if (state.basinFramedSlug !== sel.slug) {
    state.basinFramedSlug = sel.slug;
    state.basinHiLids = new Set(sel.gauges.map((g) => g.lid));
    basinApplyHighlight();
    const pts = sel.gauges.filter((g) => Number.isFinite(g.latitude) && Number.isFinite(g.longitude))
      .map((g) => [g.latitude, g.longitude]);
    if (state.map && pts.length) state.map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 11 });
  }

  el.querySelectorAll('.basin-chip').forEach((b) => b.addEventListener('click', () => {
    state.basinRiver = b.dataset.river;
    renderBasinBody();
  }));
  const selEl = $('#basin-select');
  if (selEl) selEl.addEventListener('change', () => { state.basinRiver = selEl.value; renderBasinBody(); });
  el.querySelectorAll('.basin-row').forEach((b) => b.addEventListener('click', () => {
    const g = state.gauges.find((x) => x.lid === b.dataset.lid);
    if (!g) return;
    $('#basin-view').hidden = true; // tapping a point drops to the map, like Drive Mode rows
    focusGauge(g);
  }));
}

// data lands after a boot-time ?view=basin opens (snapshot hydrate, live refresh) — re-render the open lens
function refreshBasinView() {
  const bv = $('#basin-view');
  if (bv && !bv.hidden) renderBasinBody();
}

async function openBasinView(slug) {
  if (slug) state.basinRiver = slug;
  $('#basin-view').hidden = false;
  renderBasinBody();
  let crest = null;
  try { crest = await fetch(`data/crest-summary.json?_=${Date.now()}`).then((r) => (r.ok ? r.json() : null)); }
  catch { crest = null; } // absent on older deploys or offline — the corridor still renders from live gauges
  state.basinCrest = crest;
  renderBasinBody();
}

// leaving Basin Focus must drop the corridor rings: they carry no legend once the view is gone,
// and renderGauges re-applies them on every 90s marker rebuild until the frame is cleared
function closeBasinView() {
  $('#basin-view').hidden = true;
  state.basinHiLids = null;
  state.basinFramedSlug = null; // reopening the same river must re-frame, not silently no-op
  basinApplyHighlight();
}

/* The degraded set is deliberately absent from state.gauges, so every bucket below is blind to it.
   It still belongs in the list: 411 of 1018 sites unlistable is not a filter, it is a hole. Its own
   fold, its own counts, never merged into the severity buckets or the tab badge. */
const degradedGaugePool = () => {
  const all = state.gaugesDegraded || [];
  return state.inView ? all.filter((g) => inMapView(g.latitude, g.longitude)) : all;
};
const degradedGaugeList = () => degradedGaugePool().slice().sort((a, b) => a.name.localeCompare(b.name));

function degradedStateCounts(list) {
  const n = {};
  for (const s of GAUGE_DEGRADED) n[s] = 0;
  for (const g of list) n[gaugeState(g)] = (n[gaugeState(g)] || 0) + 1;
  return n;
}

function renderGaugesTab() {
  renderWave();
  refreshRecoveryView();
  refreshBasinView();
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
  const degraded = degradedGaugeList();
  if (!rising.length && !holding.length && !falling.length) {
    const none = document.createElement('div');
    none.className = 'card';
    none.textContent = (state.gauges.length || degraded.length) ? t('sec.gauge.empty') : t('sec.gauge.noload');
    el.appendChild(none);
  }
  const fold = (cls, label, list, on, set) => {
    const btn = document.createElement('button');
    btn.className = cls;
    btn.textContent = `${t(on ? 'toggle.hide' : 'toggle.show')} ${label}`;
    btn.addEventListener('click', () => { set(!on); renderGaugesTab(); });
    el.appendChild(btn);
    if (on) for (const g of list) el.appendChild(gaugeCardDiv(g));
  };
  if (normal.length) {
    fold('aged-toggle', normalStale
      ? t('gauges.toggle.split').replace('{n}', normal.length).replace('{a}', normal.length - normalStale).replace('{s}', normalStale)
      : t('gauges.toggle.all').replace('{n}', normal.length),
    normal, state.showNormalGauges, (v) => { state.showNormalGauges = v; });
  }
  if (degraded.length) {
    const dc = degradedStateCounts(degraded);
    fold('aged-toggle deg-toggle', t('gauges.toggle.degraded')
      .replace('{n}', degraded.length).replace('{t}', dc.nothresh).replace('{s}', dc.stale).replace('{o}', dc.oos),
    degraded, state.showDegradedGauges, (v) => { state.showDegradedGauges = v; });
  }
}

/* Migration cue. A reorganization with no in-product pointer produces "what happened to X" support
   threads; this points at the new home from where the control used to live. Deliberately not a fifth
   bottom toast: that stack is the data/update channel and a layout note must never impersonate it. */
const MOVED_CUES = [
  ['exports', 'moved.exports', () => { if (typeof openShareSheet === 'function') openShareSheet(); }],
  ['resources', 'moved.resources', () => { if (typeof openHelpSheet === 'function') openHelpSheet(); }],
];

function movedCueSeen(key) {
  try { return localStorage.getItem(`respondertx.moved.${key}`) === '1'; } catch { return true; } // private mode: never nag
}

function dismissMovedCue(key) {
  try { localStorage.setItem(`respondertx.moved.${key}`, '1'); } catch { /* private mode: the cue lasts this session only, never longer */ }
  renderMovedCues();
}

function renderMovedCues() {
  const el = $('#moved-cue');
  if (!el) return;
  el.innerHTML = MOVED_CUES.filter(([key]) => !movedCueSeen(key)).slice(0, 1).map(([key, textKey]) =>
    `<div class="moved-note" data-cue="${esc(key)}"><span class="moved-glyph" aria-hidden="true">↗</span>` +
    `<span class="moved-txt">${esc(t(textKey))}</span>` +
    `<button class="moved-go" data-go="${esc(key)}">${esc(t('moved.go'))}</button>` +
    `<button class="moved-x" data-x="${esc(key)}" title="${esc(t('hint.dismiss'))}" aria-label="${esc(t('hint.dismiss'))}">✕</button></div>`).join('');
  el.querySelectorAll('.moved-go').forEach((b) => b.addEventListener('click', () => {
    const cue = MOVED_CUES.find(([k]) => k === b.dataset.go);
    dismissMovedCue(b.dataset.go);
    if (cue) cue[2]();
  }));
  el.querySelectorAll('.moved-x').forEach((b) => b.addEventListener('click', () => dismissMovedCue(b.dataset.x)));
}

/* ---------- resources & monitors ---------- */

const dataLinkHtml = (d) => `<div class="resource-item"><a href="${esc(safeUrl(d.url))}" target="_blank" rel="noopener">${esc(d.label)}</a></div>`;

const SHELTER_STATUS = {
  open: { key: 'shl.st.open', color: 'var(--good)' },
  standby: { key: 'shl.st.standby', color: 'var(--cat-action)' },
  full: { key: 'shl.st.full', color: 'var(--cat-action)' },
  closed: { key: 'shl.st.closed', color: 'var(--ink-muted)' },
  // the feed listed the site but reported no status: say so rather than imply open
  unknown: { key: 'shl.st.unknown', color: 'var(--ink-2)' },
};
function shlStatus(status) {
  const st = SHELTER_STATUS[String(status || '').toLowerCase()];
  return { label: (st ? t(st.key) : String(status || '')).toUpperCase(), color: st ? st.color : 'var(--ink-2)' };
}
// a listed address is only actionable if it can be handed to a map, so the row carries the same
// navigate affordance a notice card does; no coordinates means no button rather than a dead one
const shlNavHtml = (s) => (Number.isFinite(s.lat) && Number.isFinite(s.lon)
  ? `<div class="card-actions"><button class="act-btn shl-nav" type="button" data-lat="${esc(s.lat)}" data-lon="${esc(s.lon)}">🧭 ${esc(t('card.nav'))}</button></div>`
  : '');

function liveShelterHtml(s, srcUrl) {
  const st = shlStatus(s.status);
  const meta = [];
  if (Number.isFinite(s.capacity)) meta.push(t('shl.cap').replace('{n}', s.capacity));
  if (Number.isFinite(s.occupancy)) meta.push(t('shl.occ').replace('{n}', s.occupancy));
  if (s.org) meta.push(s.org);
  return `<div class="resource-item"><strong style="color:${st.color}">🏠 ${esc(st.label)}</strong>: <strong>${esc(s.name)}</strong> ${srcBadge('official')}` +
    `<div class="addr">${esc(s.address || '')}${meta.length ? ` · ${esc(meta.join(' · '))}` : ''} · ${esc(t('shl.livesrc'))} <a href="${esc(safeUrl(srcUrl))}" target="_blank" rel="noopener">src</a></div>${shlNavHtml(s)}</div>`;
}

/* The curated list is hand-maintained from official statements and carries no live feed behind it,
   so its own generated stamp is the only thing that can date the claim. Past this window the board
   still shows every entry, it just stops counting them as currently open. */
const SHELTER_CURATED_STALE_H = 72;
const curatedShelterAgeH = () => {
  const gen = state.resources && state.resources.generated;
  const ms = gen ? Date.now() - new Date(gen).getTime() : NaN;
  return Number.isFinite(ms) ? ms / 3600000 : Infinity;
};
const curatedSheltersStale = () => curatedShelterAgeH() > SHELTER_CURATED_STALE_H;

function curatedShelterHtml(s) {
  const st = shlStatus(s.status);
  const unconf = curatedSheltersStale()
    ? ` · <span class="xg-stale">${esc(t('shl.curated.unconf').replace('{h}', Math.round(curatedShelterAgeH())))}</span>` : '';
  return `<div class="resource-item"><strong style="color:${st.color}">🏠 ${esc(st.label)}</strong>: <strong>${esc(s.name)}</strong> ${srcBadge('curated')}` +
    `<div class="addr">${esc(s.address)} · ${esc(s.county)} Co. · ${esc(s.note)}${unconf} <a href="${esc(safeUrl(s.source))}" target="_blank" rel="noopener">src</a></div>${shlNavHtml(s)}</div>`;
}

const shlLiveSrcUrl = () => (state.sheltersLive && state.sheltersLive.source && state.sheltersLive.source.url) || 'https://gis.fema.gov/arcgis/rest/services/NSS/OpenShelters/MapServer/0';

const shlNoteHtml = (body) => `<div class="resource-item" style="border-bottom:none;font-size:12px;color:var(--ink-2)">${body}</div>`;

// heads the LIVE block only; it used to sit above the curated list too, dating a hand-kept
// record with the feed's clock
const shlLiveUpdatedHtml = () => {
  const live = state.sheltersLive;
  if (!live || !live.generated) return '';
  const when = fmtWhen(live.generated);
  return (live.shelters || []).length
    ? shlNoteHtml(`${esc(t('shl.livefeed'))} · ${esc(t('word.updated').toLowerCase())} ${esc(when)}`)
    : shlNoteHtml(esc(t('shl.live.none').replace('{t}', when)));
};

const shlCuratedHeadHtml = () => {
  const gen = state.resources && state.resources.generated;
  if (!gen) return '';
  const stale = curatedSheltersStale()
    ? ` · <span class="xg-stale">${esc(t('shl.curated.stale').replace('{h}', Math.round(curatedShelterAgeH())))}</span>` : '';
  return shlNoteHtml(`${esc(t('shl.curated'))} · ${esc(t('shl.curated.asof').replace('{t}', fmtWhen(gen)))}${stale}`);
};

// live entries first (mergeShelters already orders them), each block under its own dated header
const shelterListHtml = (shelters, srcUrl) => {
  const live = shelters.filter((s) => s.live);
  const curated = shelters.filter((s) => !s.live);
  return shlLiveUpdatedHtml() + live.map((s) => liveShelterHtml(s, srcUrl)).join('') +
    (curated.length ? shlCuratedHeadHtml() + curated.map(curatedShelterHtml).join('') : '');
};

// "who do I call" is one line, "where do I go" is a list, so the emergency number leads whatever
// order the curated file happens to carry
const hotlineIsEmergency = (h) => telHref(h && h.value) === 'tel:911';
const hotlinesOrdered = (list) => {
  const arr = Array.isArray(list) ? list : [];
  return arr.filter(hotlineIsEmergency).concat(arr.filter((h) => !hotlineIsEmergency(h)));
};

// a curated value that is not a dialable number stays plain text rather than becoming a dead link
function hotlineHtml(h) {
  const href = telHref(h.value);
  const num = href
    ? `<a class="tel-link" href="${esc(href)}" aria-label="${esc(t('res.call').replace('{n}', h.value))}">${esc(h.value)}</a>`
    : `<strong>${esc(h.value)}</strong>`;
  return `<div class="resource-item">${num} · ${esc(h.name)}<div class="addr">${esc(h.note)}</div></div>`;
}

function renderResources() {
  const r = state.resources;
  if (!r) return;
  const el = $('#resources-body');
  const recovery = r.recoveryLinks || [];
  const liveShl = state.sheltersLive;
  const shelters = mergeShelters(r.shelters, liveShl && liveShl.shelters);
  const shlSrcUrl = shlLiveSrcUrl();
  el.innerHTML = `<div class="section-title">${esc(t('res.hotlines'))}</div>` +
    hotlinesOrdered(r.hotlines).map(hotlineHtml).join('') +
    `<div class="section-title">${esc(t('res.shelters'))}</div>` +
    shelterListHtml(shelters, shlSrcUrl);
  el.querySelectorAll('.shl-nav').forEach((b) => b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const lat = Number(b.dataset.lat);
    const lon = Number(b.dataset.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) window.open(`https://maps.google.com/?q=${lat},${lon}`, '_blank', 'noopener');
  }));
  // outbound source and recovery links are pointers off the board, so they ride the share surface
  const links = $('#datalinks-body');
  if (links) {
    links.innerHTML = `<div class="section-title">${esc(t('res.data'))}</div>` +
      r.dataLinks.map(dataLinkHtml).join('') +
      (recovery.length
        ? `<button class="aged-toggle" id="recovery-toggle">${state.showRecovery ? '▾' : '▸'} ${esc(t('res.recovery'))}</button>` +
          `<div id="res-recovery-body"${state.showRecovery ? '' : ' hidden'}>${recovery.map(dataLinkHtml).join('')}</div>`
        : '');
    const rt = $('#recovery-toggle');
    if (rt) rt.addEventListener('click', () => { state.showRecovery = !state.showRecovery; renderResources(); });
  }
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
      const st = shlStatus(s.status);
      m.bindPopup(`<div class="popup-title">🏠 <span style="color:${st.color}">${esc(st.label)}</span> · ${esc(s.name)} ${srcBadge('curated')}</div>` +
        `<div class="popup-meta">${esc(s.address)}</div><div>${esc(s.note)}</div>` +
        `<div class="popup-meta">${esc(t('shl.curated'))} · ${esc(t('shl.curated.asof').replace('{t}', fmtWhen((state.resources || {}).generated)))}</div>` +
        (curatedSheltersStale() ? `<div class="popup-meta"><span class="xg-stale">${esc(t('shl.curated.stale').replace('{h}', Math.round(curatedShelterAgeH())))}</span></div>` : '') +
        `<div class="popup-meta">${esc(t('shl.approx'))}</div>`);
    }
    state.layers.shelters.addLayer(m);
  }
}

// count only sites currently listed as open; standby, full, closed and unknown must never read as
// open, on the curated path as well as the live one, and a curated list past its confirmation
// window is a record of the past rather than a status the board can assert
const shelterOpen = (sh) => String(sh.status || '').toLowerCase() === 'open';
function openShelterCount() {
  const r = state.resources;
  if (!r) return 0;
  const live = state.sheltersLive;
  const stale = curatedSheltersStale();
  return mergeShelters(r.shelters, live && live.shelters)
    .filter((sh) => (sh.live || !stale) && shelterOpen(sh)).length;
}

// entries the board is still listing but can no longer call open; the chip says so rather than
// letting a suppressed count read as "no shelters"
function unconfirmedShelterCount() {
  const r = state.resources;
  if (!r || !curatedSheltersStale()) return 0;
  return (r.shelters || []).filter(shelterOpen).length;
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
  // inland event: the coastal card is absent, not an empty host that still carries fetch hooks
  if (!Array.isArray(CONFIG.tideStations) || !CONFIG.tideStations.length) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
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

// the gauges a quiet claim is allowed to speak for: the ones inside the area it names
const quietGauges = (scope) => state.gauges.filter((g) => ptInScope(g.latitude, g.longitude, scope));

/* The all-clear is only ever claimed over the area it actually checked: the open alerts, the
   gauges and the road closures inside the current scope, with the wording naming that same area.
   An empty scope is not an all-clear either, so a radius holding no gauge stays silent. */
function quietState() {
  // an unknown closure set is not a checked one: never claim an all-clear over roads we cannot read
  if (!state.gauges.length || !state.roadClosures || state.roadsUnknown) return false;
  const scope = alertScope();
  const gauges = quietGauges(scope);
  if (!gauges.length) return false;
  const open = state.alerts.filter((f) => alertOpen(f) && alertNear(f, scope));
  const inFlood = gauges.filter((g) => CAT_RANK[gaugeCat(g)] >= CAT_RANK.minor);
  const roads = roadFeatures().filter((f) => geomInScope(f.geometry, scope));
  return !open.length && !inFlood.length && !roads.length;
}

// an empty curated feed is not a hazard verdict: the reassuring treatment needs the live hazard
// feeds loaded and quiet, and no open alert anywhere in the feed, not just in the AO
function feedCalmOk() {
  return !(state.alerts || []).length && quietState();
}

/* The hazard line carries the ranked live items now, so the strip no longer repeats them as
   counts. What is left is the reassurance that line cannot give: it renders only when the line
   has nothing to carry, so the two are never stacked. */
function renderThreatStrip() {
  const el = $('#threat-strip');
  // playback engaged: the dimmed strip stays LIVE data, say so, never let it read as the frame
  const pbNote = pbBlocksLive(state) ? `<div class="strip-live-note">${esc(t('playback.striplive'))}</div>` : '';
  if (!state.alertsLoadedOnce || tickerItems().length) { el.innerHTML = pbNote; return; }
  if (quietState()) {
    const scope = alertScope();
    const gauges = quietGauges(scope);
    const normal = gauges.filter((g) => gaugeCat(g) === 'none' && !gaugeObsStale(g)).length;
    const sub = t('quiet.sub').replace('{n}', gauges.length).replace('{m}', normal);
    const line = t(`quiet.line.${alertScopeSrc(scope)}`).replace('{n}', String(ALERT_NEAR_MI));
    el.innerHTML = `${pbNote}<div class="strip-ok quiet"><span class="ok-line">${esc(line)}</span><span class="ok-sub">${esc(sub)}</span></div>`;
    return;
  }
  el.innerHTML = `${pbNote}<div class="strip-ok"><span class="ok-line">${esc(t('threat.okline'))}</span>` +
    `<span class="ok-sub">${esc(t('threat.oksub'))}</span></div>`;
}

/* The board's most repeated instruction is call 911, and a 911 Telephone Outage says that
   instruction is currently wrong where the reader is. This is a line above the disclaimer strip,
   never an edit to it: the guidance is right everywhere else, so the strip, the lens footers and the
   safety modal stay exactly as written, and this does not tell anyone to stop calling 911 either.
   Outages are often partial, service returns without a new product, and the board's picture is three
   minutes old at best. The number is quoted and attributed, or its absence stated. */
const nine11NoticeHtml = (outages) => (outages || []).map((f) => {
  const num = nine11Alt(f);
  const href = num ? telHref(num) : '';
  const body = t('nine11.body')
    .replace('{a}', alertAgency(f) || t('alert.agency.unknown'))
    .replace('{areas}', alertAreaText(f.properties, 3));
  return '<div class="n11-item">'
    + `<div class="n11-head">${esc(t('nine11.head'))}</div>`
    + `<div class="n11-body">${esc(body)} · ${esc(t('alert.untilShort'))} ${esc(alertUntilText(f))}</div>`
    + (href
      ? `<div class="n11-alt">${esc(t('nine11.alt'))} <a class="n11-num" href="${esc(href)}">${esc(num)}</a></div>`
      : `<div class="n11-alt n11-noalt">${esc(t('nine11.noalt'))}</div>`)
    + `<div class="n11-keep">${esc(t('nine11.keep'))}</div>`
    + `<a class="n11-text" role="button" tabindex="0" data-n11="${esc(f.id)}">${esc(t('alert.text'))} ↗</a>`
    + '</div>';
}).join('');

function renderNine11Notice() {
  const el = $('#nine11-notice');
  if (!el) return;
  const outages = nine11Outages();
  el.hidden = !outages.length;
  el.innerHTML = nine11NoticeHtml(outages);
  for (const a of el.querySelectorAll('[data-n11]')) {
    const open = () => openAlertTextById(a.getAttribute('data-n11'));
    a.addEventListener('click', open);
    a.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  }
}

/* ---------- actionable ticker — recency-biased glance line ---------- */

const relWhen = (iso) => fmtWhen(iso).split(' · ')[0];

// aging invariant: only active alerts, rising/in-flood gauges, fresh LSRs, and non-aged critical notices qualify
const tickerUntil = (f) => {
  const end = alertEndsAt(f);
  return end
    ? new Date(end).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })
    : t('alert.further');
};

/* Only acute products enter the line. This is the decision that determines whether the ticker
   survives going all-hazard: admit the standing tier and a Texas summer afternoon is thirteen heat
   advisories and nothing actionable, the responder learns the line is heat and stops reading it,
   and the tornado warning that lands there next week is not seen. */
function tickerAlertItems() {
  const goAlerts = () => document.querySelector('.tabs button[data-tab="tab-alerts"]').click();
  const open = alertDedupe(state.alerts.filter((x) => alertOpen(x) && hazardGlance(x)));
  return open.sort((a, b) => alertHazCmp(a, b)).map((a) => {
    const where = alertAreaLead(a.properties);
    const emerg = a._sev === 'emergency';
    const motion = alertMotionText(a);
    const text = emerg
      ? t('ticker.ffe').replace('{where}', where).replace('{t}', tickerUntil(a))
      : `${hazardGlyph(a)} ${a.properties.event} ${where} · ${t('alert.untilShort')} ${tickerUntil(a)}${motion ? ` · ${motion}` : ''}`;
    return { text, color: emerg ? 'var(--sev-emergency)' : `var(--haz-${hazardStyleKey(a)}, var(--sev-warning))`, act: goAlerts };
  });
}

function tickerItems() {
  const rise = [], majors = [];
  const emerg = tickerAlertItems();
  const rising = state.gauges.filter((g) => gaugeRising(g) && CAT_RANK[gaugeForecastCat(g)] >= CAT_RANK.minor)
    .sort((a, b) => new Date(a.status.forecast.validTime) - new Date(b.status.forecast.validTime));
  // tapping a rising item frames the tapped gauge and pulses the whole rising set, on the map and
  // in the Gauges tab, so which gauges are in question is obvious rather than inferred
  for (const g of rising) {
    const fCat = gaugeForecastCat(g);
    rise.push({ text: `▲ ${riverOf(g.name)} → ${catWord(fCat).toUpperCase()} ${t('wave.crest')} ${relWhen(g.status.forecast.validTime)}`, color: `var(--cat-${fCat})`, act: () => focusGauges(rising, g) });
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
  return tickerCap(emerg.concat(rise.slice(0, riseSlots), majors, tail), emerg.length > 0);
}

/* A full pass of the moving lane has to finish inside a glance. At five seconds an item, twelve
   items is a sixty-second loop and the driver gets about ten, so once an acute product is open the
   lane is capped to a pass under thirty seconds. Nothing is dropped: the overflow collapses into
   one item that says how many are behind it and opens the Alerts tab. */
const TICKER_ACUTE_MAX = 6;

function tickerCap(items, acute) {
  if (!acute || items.length <= TICKER_ACUTE_MAX) return items;
  const kept = items.slice(0, TICKER_ACUTE_MAX - 1);
  kept.push({
    text: t('ticker.more').replace('{n}', String(items.length - kept.length)),
    act: () => document.querySelector('.tabs button[data-tab="tab-alerts"]').click(),
  });
  return kept;
}

/* The hazard line scrolls, and the worst item never has to come round for you to read it.
   tickerItems() is ranked worst-first, so item 0 is pinned outside the moving lane and the
   remainder loops beside it. The loop is two identical runs translated -50%, which is what makes
   it seamless; the duplicate is aria-hidden and unfocusable so nothing is announced twice.
   The motion pauses on hover and on keyboard focus, and prefers-reduced-motion drops the lane
   entirely, leaving the pinned item plus the same remainder as a static list behind the count. */
const TICKER_SECS_PER_ITEM = 5; // ~50px/s at a typical item width: readable, not a blur
const tickerSecs = (n) => Math.max(20, n * TICKER_SECS_PER_ITEM);

function tickerItemHtml(item, n, cls, dup) {
  return `<button type="button" class="ticker-item${cls ? ` ${cls}` : ''}" data-ti="${n}"${dup ? ' tabindex="-1"' : ''}` +
    `${item.color ? ` style="color:${item.color}"` : ''}>${esc(item.text)}</button>`;
}

// one pass of the ranked set; the reel holds two of these, so -50% lands exactly on the seam
const tickerRunHtml = (items, dup) => items
  .map((it, n) => `${tickerItemHtml(it, n, '', dup)}<span class="ticker-sep" aria-hidden="true">·</span>`)
  .join('');

/* The emergency banner is fixed and has to clear the hazard line, whose height depends on its
   content and its breakpoint. Publish the line's bottom edge for #emergency-banner's top to read;
   with no line, the header's own bottom is the edge. */
function syncHazlineAnchor() {
  const el = $('#ticker');
  const anchor = (el && !el.hidden) ? el : document.querySelector('header');
  if (!anchor || !anchor.getBoundingClientRect) return;
  document.documentElement.style.setProperty('--hazline-bottom', `${Math.round(anchor.getBoundingClientRect().bottom)}px`);
}

function renderTicker() {
  const el = $('#ticker');
  if (!el) return;
  const items = tickerItems();
  state.tickerActs = items.map((i) => i.act);
  if (!items.length) { el.hidden = true; state.tickerHash = ''; syncHazlineAnchor(); return; }
  el.hidden = false;
  // the reel carries the whole ranked set, worst first, so the loop opens on the worst item
  const reel = `<div class="ticker-marquee"><div class="ticker-reel" style="animation-duration:${tickerSecs(items.length)}s">` +
    `<div class="ticker-run">${tickerRunHtml(items, false)}</div>` +
    `<div class="ticker-run" aria-hidden="true">${tickerRunHtml(items, true)}</div></div></div>`;
  // the same ranked set as a static list: the only hazard line a reduced-motion device is shown
  const restHtml = items.map((it, n) => tickerItemHtml(it, n)).join('');
  const hash = reel + restHtml;
  if (hash !== state.tickerHash) { // unchanged content must not restart the loop mid-pass
    state.tickerHash = hash;
    $('#ticker-track').innerHTML = reel;
    $('#ticker-rest').innerHTML = restHtml;
  }
  syncHazlineAnchor();
  armTickerExpiry();
}

/* The line is rendered from a fetch, every 180 s. Three minutes of staleness is nothing on a flood
   warning and a tenth of a tornado warning's life spent asserting a warning that has already ended,
   so one timer tracks the soonest end on screen and re-renders the line alone when it passes. No
   extra network, and nothing to arm when the next fetch would beat it there. */
function armTickerExpiry() {
  if (state.tickerExpiryTimer) clearTimeout(state.tickerExpiryTimer);
  state.tickerExpiryTimer = null;
  const ends = (state.alerts || [])
    .filter((f) => alertOpen(f) && hazardGlance(f))
    .map((f) => Date.parse(alertEndsAt(f) || ''))
    .filter((ms) => Number.isFinite(ms));
  if (!ends.length) return;
  const wait = Math.min(...ends) - Date.now() + 1000;
  if (wait <= 0 || wait > CONFIG.refreshMs) return;
  state.tickerExpiryTimer = setTimeout(() => { renderTicker(); renderDriveMode(); }, wait);
}

/* ---------- header ---------- */

// the composite entry every refresh calls; the header tiles it also wrote were retired in
// v0.97.93 (they duplicated the richer, tappable threat strip and were hidden on every phone)
function renderTiles() {
  renderThreatStrip();
  renderNine11Notice();
  renderTicker();
  renderDriveMode(); // no-op when Drive Mode is closed; keeps the glance list live on each refresh
  const crit = activeRequests().filter((r) => r.status !== 'resolved' && r.priority === 'critical').length;
  const flag = document.title.startsWith('🔴') ? '🔴 ' : '';
  document.title = `${flag}${crit ? `(${crit}) ` : ''}${state.baseTitle}`;
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
    // jurisdiction-reported crossing closures — absence-tolerant; transient failure keeps last-good
    const xst = await fetch(`data/crossing-status.json${bust}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (xst && Array.isArray(xst.crossings)) state.crossStatus = xst;
    // live NSS shelters — absence-tolerant (poller may never have run); transient failure keeps last-good
    const shl = await fetch(`data/shelters-live.json${bust}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (shl && Array.isArray(shl.shelters)) state.sheltersLive = shl;
    markHealthy('seeds');
    state.seedRequests = reqs.requests || [];
    state.resources = res;
    // hash = content + per-card aging fingerprint: identical seeds skip the re-render (scroll guard),
    // but aged/stale/fresh-bucket transitions on idle clients still repaint list, tiles, and crossings
    const agingFp = allRequests().map((r) => [r.id, cardAged(r) ? 1 : 0, r.status !== 'resolved' && ageMins(r.ts) > CONFIG.staleMins ? 1 : 0, freshClass(r.ts)]);
    const crossingFp = state.crossings.map((c) => (crossingStale(c) ? 1 : 0));
    const hash = JSON.stringify([reqs, res, state.crossings, agingFp, crossingFp, state.sheltersLive, state.crossStatus]);
    if (hash === state.seedHash) return true;  // unchanged — don't reset operator's scroll
    state.seedHash = hash;
    renderRequests();
    renderResources();
    renderCrossings();
    renderCrossStatus();
    pbRefreshCurated(); // playback may have engaged before this data arrived
    return true;
  } catch { return false; }
}

const CROSSING_STALE_H = 12;
const crossingAgeH = (c) => {
  const ms = c.updated_at ? Date.now() - new Date(c.updated_at).getTime() : NaN;
  return Number.isFinite(ms) ? ms / 3600000 : Infinity;
};
// a closure nobody has re-confirmed inside the window is still shown, it just stops being counted
const crossingStale = (c) => crossingAgeH(c) > CROSSING_STALE_H;
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
  renderRoadsTab();
  for (const c of list) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon) || !layer) continue;
    const st = CROSSING_STATUS[c.status] || CROSSING_STATUS.caution;
    const stale = crossingStale(c);
    const icon = L.divIcon({ className: '', html: `<div class="crossing-icon${stale ? ' unconfirmed' : ''}" style="border-color:${st.color};color:${st.color}">${st.glyph}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
    const m = L.marker([c.lat, c.lon], { icon });
    m.bindPopup(`<div class="popup-title" style="color:${st.color}">${st.glyph} ${esc(xstLabel(st))} · ${esc(t('risk.read.crosspost'))}</div><div>${esc(c.name)} ${srcBadge('curated')}</div>` +
      `<div class="popup-meta">${esc(c.reason || '')}</div>` +
      `<div class="popup-meta">${esc(t('cross.updated').replace('{t}', fmtWhen(c.updated_at)))}</div>` +
      (stale ? `<div class="popup-meta"><span class="xg-stale">${esc(t('cross.stale').replace('{h}', Math.round(crossingAgeH(c))))}</span></div>` : '') +
      (c.source && safeUrl(c.source) !== '#' ? `<div class="popup-link"><a href="${esc(safeUrl(c.source))}" target="_blank" rel="noopener">${esc(t('word.source'))}</a></div>` : ''));
    layer.addLayer(m);
  }
  renderReopenedRoads();
}

/* ---------- jurisdiction-reported crossing status (ATX Floods closures) ----------
   Separate from the curated tracker above and from the TxGIO inventory: this is what 39 Central
   Texas jurisdictions report, and the feed timestamps a record's last CHANGE, never a
   confirmation. Every marker therefore carries its own age and nothing here is counted as a
   live hazard, because no row can be vouched for the way a curated one can. */
const XSTATUS_UNCONFIRMED_D = 2;

function xstatusAgeD(c) {
  const ms = c.changed ? Date.now() - new Date(c.changed).getTime() : NaN;
  return Number.isFinite(ms) ? ms / 86400000 : Infinity;
}

/* Layer default. Every row here is a record-change stamp, never a confirmation, and the feed
   routinely carries only changes weeks to a year old, several of them construction. Default-on
   would paint the map with 🚨 markers none of which the board can vouch for, so the layer stays
   off until the feed carries a change inside its own unconfirmed window and then enables itself.
   Nothing is hidden either way: the Roads tab lists every row with its age. */
const xstatusAutoOn = (crossings) => (crossings || []).some((c) => xstatusAgeD(c) <= XSTATUS_UNCONFIRMED_D);

function maybeAutoXstatus() {
  if (state.xstatusAutoDone || !state.map || !state.layers.crossStatus) return;
  if (!xstatusAutoOn((state.crossStatus && state.crossStatus.crossings) || [])) return;
  state.xstatusAutoDone = true;
  if (!state.map.hasLayer(state.layers.crossStatus)) state.layers.crossStatus.addTo(state.map);
}

function renderCrossStatus() {
  const layer = state.layers.crossStatus;
  if (!layer) return;
  layer.clearLayers();
  for (const c of ((state.crossStatus && state.crossStatus.crossings) || [])) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
    const st = CROSSING_STATUS[c.status] || CROSSING_STATUS.caution;
    const ageD = xstatusAgeD(c);
    const old = ageD > XSTATUS_UNCONFIRMED_D;
    const icon = L.divIcon({ className: '', html: `<div class="crossing-icon${old ? ' unconfirmed' : ''}" style="border-color:${st.color};color:${st.color}">${st.glyph}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
    const where = [c.address, c.jurisdiction].filter(Boolean).join(' · ');
    const m = L.marker([c.lat, c.lon], { icon });
    m.bindPopup(`<div class="popup-title" style="color:${st.color}">${st.glyph} ${esc(xstLabel(st))} · ${esc(t('xstatus.title'))}</div>` +
      `<div>${esc(c.name)} ${srcBadge('official')}</div>` +
      (where ? `<div class="popup-meta">${esc(where)}</div>` : '') +
      (c.comment ? `<div class="popup-meta">${esc(c.comment)}</div>` : '') +
      `<div class="popup-meta">${esc(t('xstatus.changed').replace('{t}', fmtWhen(c.changed)))}</div>` +
      `<div class="popup-meta"><span class="xg-stale">${esc(old ? t('xstatus.old').replace('{d}', Math.round(ageD)) : t('xstatus.nocheck'))}</span></div>`);
    layer.addLayer(m);
  }
  maybeAutoXstatus();
}

/* ---------- the Roads tab: every road hazard the board holds, in one distance-sorted list ----------
   Three provenances with three different confirmation stories, so each row names its operator and
   only the ones the board can vouch for reach the badge. TxDOT DriveTexas is a live machine feed.
   A curated crossing counts while the curator's stamp is inside CROSSING_STALE_H. A jurisdiction
   report timestamps a record change, never a confirmation, so it is listed and mapped, never counted. */

const ROADS_TXDOT_GLYPH = { Flooding: '🌊', Damage: '⚠' };
const roadsAgeChip = (h) => (Number.isFinite(h) ? t('cross.stale').replace('{h}', Math.round(h)) : t('xstatus.nocheck'));

function roadsTxdotRows(pos) {
  const rows = [];
  for (const f of roadFeatures()) {
    const p = f.properties || {};
    const pt = roadPointNear(f.geometry, pos);
    const ct = roadCondType(p);
    const dscr = stripHtml(p.description).replace(/^[\s–—-]+/, ''); // TxDOT feeds a leading "- " artifact
    // a snapshot row is not a current confirmation: it joins the unconfirmed bucket, is left out of
    // the Roads badge, and ages on the snapshot's own stamp rather than on when we fell back to it
    const snap = p._snapshot === true;
    rows.push({
      kind: 'txdot', live: !snap, color: ct.color, glyph: ROADS_TXDOT_GLYPH[p.condition] || '⛔',
      label: roadLabel(ct), name: prettyRoute(p.route_name) || t('word.road'),
      detail: dscr || [p.from_limit, p.to_limit].filter(Boolean).join(' → '),
      when: p.start_time || '', whenText: p.start_time ? `${t('road.since')} ${fmtWhen(p.start_time)}` : '',
      age: snap ? t('roads.snapshot.age').replace('{n}', String(Math.max(0, Math.round(ageMins(p._snapshotAt))))) : '',
      op: snap ? t('roads.src.snapshot') : t('roads.src.txdot'), badge: 'official', href: 'https://drivetexas.org/',
      lat: pt ? pt[0] : NaN, lon: pt ? pt[1] : NaN,
    });
  }
  return rows;
}

function roadsCuratedRows() {
  const rows = [];
  for (const c of (state.crossings || [])) {
    if (c.status === 'open') continue; // the tab lists hazards; an open crossing is the absence of one
    const st = CROSSING_STATUS[c.status] || CROSSING_STATUS.caution;
    const stale = crossingStale(c);
    rows.push({
      kind: 'curated', live: !stale, color: st.color, glyph: st.glyph,
      label: xstLabel(st), name: c.name, detail: c.reason || '',
      when: c.updated_at || '',
      whenText: c.updated_at ? `${t('word.updated').toLowerCase()} ${fmtWhen(c.updated_at)}` : '',
      age: stale ? roadsAgeChip(crossingAgeH(c)) : '',
      op: t('roads.src.curated'), badge: 'curated',
      href: c.source && safeUrl(c.source) !== '#' ? safeUrl(c.source) : '',
      lat: c.lat, lon: c.lon,
    });
  }
  return rows;
}

function roadsJurisdictionRows() {
  const rows = [];
  for (const c of ((state.crossStatus && state.crossStatus.crossings) || [])) {
    const st = CROSSING_STATUS[c.status] || CROSSING_STATUS.caution;
    const ageD = xstatusAgeD(c);
    rows.push({
      kind: 'xstatus', live: false, color: st.color, glyph: st.glyph,
      label: xstLabel(st), name: c.name, detail: [c.address, c.comment].filter(Boolean).join(' · '),
      when: c.changed || '',
      // never "updated": this feed stamps the last record change, and it publishes no confirmation time
      whenText: c.changed ? t('xstatus.changed').replace('{t}', fmtWhen(c.changed)) : t('xstatus.nocheck'),
      age: ageD > XSTATUS_UNCONFIRMED_D && Number.isFinite(ageD) ? t('xstatus.old').replace('{d}', Math.round(ageD)) : t('xstatus.nocheck'),
      op: [c.jurisdiction, t('roads.src.jur')].filter(Boolean).join(' · '), badge: 'official',
      href: 'https://atxfloods.com/', lat: c.lat, lon: c.lon,
    });
  }
  return rows;
}

// nearest first with a fix, newest first without; a row with no coordinates keeps its place at the tail
function roadsTabRows() {
  const pos = state.myPos;
  const rows = roadsTxdotRows(pos).concat(roadsCuratedRows(), roadsJurisdictionRows());
  for (const r of rows) {
    r.dist = pos && Number.isFinite(r.lat) && Number.isFinite(r.lon) ? distMi(pos.lat, pos.lng, r.lat, r.lon) : Infinity;
  }
  if (pos) rows.sort((a, b) => a.dist - b.dist);
  else rows.sort((a, b) => (Date.parse(b.when) || 0) - (Date.parse(a.when) || 0));
  return rows;
}

function roadsRowHtml(r) {
  const mapped = Number.isFinite(r.lat) && Number.isFinite(r.lon);
  const nav = mapped ? ` data-lat="${r.lat}" data-lon="${r.lon}"` : '';
  const meta = [r.op, r.detail, r.whenText,
    Number.isFinite(r.dist) ? `${r.dist.toFixed(1)} mi` : ''].filter(Boolean).map(esc).join(' · ');
  return `<div class="resource-item road-row${r.live ? '' : ' unconfirmed'}" style="border-left-color:${r.color}"${nav}>` +
    `<strong style="color:${r.color}">${r.glyph} ${esc(r.label)}</strong>: ${esc(r.name)} ${srcBadge(r.badge)}` +
    `<div class="addr">${meta}` +
    (r.age ? ` · <span class="xg-stale">${esc(r.age)}</span>` : '') +
    (r.href ? ` <a href="${esc(r.href)}" target="_blank" rel="noopener">src</a>` : '') +
    '</div></div>';
}

function renderRoadsTab() {
  const el = $('#crossings-body');
  const badge = $('#roads-count');
  const rows = roadsTabRows();
  const live = rows.filter((r) => r.live);
  const unconf = rows.filter((r) => !r.live);
  // the badge sits beside Alerts and Gauges, both of which suppress a sensor they cannot vouch
  // for; a closure with no current confirmation gets the same treatment
  if (badge) badge.textContent = String(live.length);
  if (!el) return;
  // whole-mile distance buckets: a moving fix must not repaint (and reset the scroll) every tick
  const fp = JSON.stringify([state.roadsPartial === true, state.roadsFallbackAt || 0, state.roadsUnknown === true,
    rows.map((r) => [r.kind, r.name, r.label, r.when, r.live, r.age, Math.round(r.dist) || 0])]);
  if (fp === state.roadsTabFp) return;
  state.roadsTabFp = fp;
  // the closure feed's own state leads the list: a snapshot is named as one, and a feed we cannot
  // reach at all is reported as unknown. Neither may read as a current, complete closure set.
  const feedNote = state.roadsFallbackAt
    ? `<div class="rcv-note">${esc(t('roads.snapshot.note').replace('{t}', fmtWhen(new Date(state.roadsFallbackAt).toISOString())))}</div>`
    : state.roadsUnknown ? `<div class="rcv-note">${esc(t('roads.unknown.note'))}</div>` : '';
  // one list, not one group per feed: a crossing shut two miles away must not sit below forty
  // distant TxDOT rows just because a different operator reported it
  el.innerHTML = rows.length
    ? `<div class="section-title">${esc(t('roads.live.title'))}</div>` + feedNote +
      (state.roadsPartial ? `<div class="rcv-note">${esc(t('road.partial'))}</div>` : '') +
      (unconf.length ? `<div class="rcv-note">${esc(t('cross.unconfirmed').replace('{n}', unconf.length))}</div>` : '') +
      rows.map(roadsRowHtml).join('') +
      `<div class="resource-item" style="border:none"><a href="https://drivetexas.org/" target="_blank" rel="noopener">${esc(t('cross.drivetx'))}</a></div>`
    // E1: with the feed down and no snapshot, "none reported" would be a failed fetch published as a value
    : `<div class="rcv-none">${esc(t(state.roadsUnknown ? 'roads.unknown' : 'roads.none'))}</div>`;
  el.querySelectorAll('.road-row[data-lat]').forEach((d) => d.addEventListener('click', (ev) => {
    if (ev.target.closest('a')) return;
    state.map.setView([+d.dataset.lat, +d.dataset.lon], 13);
  }));
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

