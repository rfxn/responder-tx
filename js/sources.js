'use strict';

/* ---------- NWS alerts ---------- */

function alertSeverity(p) {
  const threat = (p.parameters && p.parameters.flashFloodDamageThreat || []).join(' ');
  if (/FLASH FLOOD EMERGENCY/i.test(p.description || '') || /CATASTROPHIC/i.test(threat)) return 'emergency';
  if (/Warning/i.test(p.event)) return 'warning';
  if (/Watch/i.test(p.event)) return 'watch';
  return 'advisory';
}

async function fetchAlerts() {
  const res = await fetch(CONFIG.alertsUrl, { headers: { Accept: 'application/geo+json' } });
  if (!res.ok) throw new Error(`NWS alerts HTTP ${res.status}`);
  const data = await res.json();
  const floods = (data.features || []).filter((f) => /flood/i.test(f.properties.event || ''));
  floods.forEach((f) => { f._sev = alertSeverity(f.properties); });
  const rank = { emergency: 0, warning: 1, watch: 2, advisory: 3 };
  floods.sort((a, b) => rank[a._sev] - rank[b._sev] || new Date(b.properties.sent || 0) - new Date(a.properties.sent || 0));
  const emergencies = floods.filter((f) => f._sev === 'emergency');
  const fresh = emergencies.filter((f) => !state.knownEmergencyIds.has(f.id));
  emergencies.forEach((f) => state.knownEmergencyIds.add(f.id));
  if (state.alertsLoadedOnce && fresh.length) showEmergencyBanner(fresh);
  if (!emergencies.length && !$('#emergency-banner').hidden) dismissEmergencyBanner(); // banner ages out with its alert
  state.alertsLoadedOnce = true;
  state.alerts = floods;
  markHealthy('alerts');
  recordAlertHist();
  renderAlertList();
  await renderAlertPolys();
  renderTiles();
}

async function zoneGeometry(zoneUrl) {
  if (state.zoneGeomCache.has(zoneUrl)) return state.zoneGeomCache.get(zoneUrl);
  try {
    const res = await fetch(zoneUrl, { headers: { Accept: 'application/geo+json' } });
    const gj = res.ok ? (await res.json()).geometry : null;
    state.zoneGeomCache.set(zoneUrl, gj);
    return gj;
  } catch { state.zoneGeomCache.set(zoneUrl, null); return null; }
}

async function renderAlertPolys() {
  state.layers.alerts.clearLayers();
  let zoneFetchBudget = CONFIG.maxZoneGeomFetches;
  // reverse severity order: least-severe drawn first, emergencies land on top
  for (const f of state.alerts.slice().reverse()) {
    // recency: never draw an alert the NWS no longer lists as open — expired drops off, open (expires in future, any age) stays; missing expires = still active (new Date(null) is epoch)
    if (f.properties.expires && new Date(f.properties.expires) < new Date()) continue;
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
    const layer = L.geoJSON({ type: 'Feature', geometry: geom }, {
      style: { className: `alert-poly sev-${f._sev}`, weight: f._sev === 'emergency' ? 2.5 : 1.5, fillOpacity: f._sev === 'emergency' ? 0.22 : 0.10, opacity: 0.9 },
    });
    layer.bindPopup(alertPopupHtml(f));
    state.layers.alerts.addLayer(layer);
  }
}

function showEmergencyBanner(freshAlerts) {
  const areas = freshAlerts.map((f) => f.properties.areaDesc).join(' | ');
  $('#banner-text').textContent = `⚠ NEW FLASH FLOOD EMERGENCY: ${areas}`;
  $('#emergency-banner').hidden = false;
  if (!document.title.startsWith('🔴')) document.title = `🔴 ${document.title}`;
}

function dismissEmergencyBanner() {
  $('#emergency-banner').hidden = true;
  document.title = document.title.replace(/^🔴 /, '');
}

function alertPopupHtml(f) {
  const p = f.properties;
  return `<div class="popup-title">${esc(p.event)}${f._sev === 'emergency' ? ': <span style="color:var(--sev-emergency);font-weight:700">FLASH FLOOD EMERGENCY</span>' : ''}</div>` +
    `<div class="popup-meta">${esc(p.areaDesc || '')}</div>` +
    `<div class="popup-meta">Expires: ${esc(fmtWhen(p.expires))}</div>` +
    `<div class="popup-link"><a href="${esc(f.id)}" target="_blank" rel="noopener">Full alert text →</a></div>`;
}

// in area-of-operations? geometry bounds must intersect the gauge bbox (padded).
// zone alerts w/o geometry are kept in-AO (don't hide) — better a false include than a hidden warning.
function alertInAO(f) {
  const geom = f.geometry || (f.properties.affectedZones || []).map((z) => state.zoneGeomCache.get(z)).find(Boolean);
  if (!geom) return true;
  const b = CONFIG.gaugeBbox, pad = 0.3;
  try {
    const gb = L.geoJSON(geom).getBounds();
    return gb.getEast() >= b.xmin - pad && gb.getWest() <= b.xmax + pad
      && gb.getNorth() >= b.ymin - pad && gb.getSouth() <= b.ymax + pad;
  } catch { return true; }
}

function alertCardDiv(f) {
  const p = f.properties;
  const div = document.createElement('div');
  div.className = `card alert-card sev-${f._sev}`;
  div.innerHTML = `<div class="event">${esc(p.event)}${f._sev === 'emergency' ? '<span class="emergency-flag">EMERGENCY</span>' : ''}</div>` +
    `<div class="areas">${esc(p.areaDesc || '')}</div>` +
    `<div class="meta" style="margin-top:3px;font-size:11px;color:var(--ink-muted)">` +
    (p.sent ? `<span class="fresh-dot ${freshClass(p.sent)}"></span> sent ${esc(fmtWhen(p.sent))} · ` : '') +
    `until ${esc(fmtWhen(p.expires))} · <a href="${esc(f.id)}" target="_blank" rel="noopener" style="color:var(--accent)">text</a></div>`;
  div.addEventListener('click', () => {
    if (f.geometry) {
      const b = L.geoJSON(f.geometry).getBounds();
      if (b.isValid()) { state.map.fitBounds(b, { maxZoom: 10 }); return; }
    }
    const z = (f.properties.affectedZones || [])[0];
    const g = z && state.zoneGeomCache.get(z);
    if (g) {
      const b = L.geoJSON(g).getBounds();
      if (b.isValid()) { state.map.fitBounds(b, { maxZoom: 10 }); return; }
    }
    window.open(f.id, '_blank', 'noopener');
  });
  return div;
}

function renderAlertList() {
  const el = $('#alert-list');
  el.innerHTML = `<div class="section-title">${esc(t('sec.alerts'))}</div>`;
  const sevF = $('#flt-alert-sev').value, qF = $('#flt-alert-q').value.toLowerCase();
  const shown = state.alerts.filter((f) => (!sevF || f._sev === sevF)
    && (!qF || `${f.properties.event} ${f.properties.areaDesc}`.toLowerCase().includes(qF)));
  if (!shown.length) { el.innerHTML += `<div class="card">${esc(t('sec.alerts.empty'))}</div>`; return; }
  // AO-relevant alerts first; the rest fold into "elsewhere in TX" so a Big Bend FFW can't sit on top
  const inAO = shown.filter(alertInAO), elsewhere = shown.filter((f) => !alertInAO(f));
  for (const f of inAO) el.appendChild(alertCardDiv(f));
  if (elsewhere.length) {
    const btn = document.createElement('button');
    btn.className = 'aged-toggle';
    btn.textContent = `${state.showAlertsElsewhere ? '▾ hide' : '▸ show'} ${elsewhere.length} flood alert${elsewhere.length > 1 ? 's' : ''} elsewhere in TX`;
    btn.addEventListener('click', () => { state.showAlertsElsewhere = !state.showAlertsElsewhere; renderAlertList(); });
    el.appendChild(btn);
    if (state.showAlertsElsewhere) for (const f of elsewhere) el.appendChild(alertCardDiv(f));
  }
  const emergN = state.alerts.filter((f) => f._sev === 'emergency').length;
  const alertsBadge = $('#alerts-count');
  alertsBadge.textContent = emergN ? `⚠ ${emergN}` : state.alerts.length;
  alertsBadge.classList.toggle('sev', emergN > 0);
  renderAlertHistory(el);
}

function renderAlertHistory(el) {
  const liveIds = new Set(state.alerts.map((f) => f.id));
  const expired = Object.entries(state.hist.alerts)
    .filter(([id, a]) => !liveIds.has(id) || (a.expires && new Date(a.expires) < new Date()))
    .map(([, a]) => a)
    .sort((a, b) => new Date(b.t) - new Date(a.t));
  if (!expired.length) return;
  const btn = document.createElement('button');
  btn.className = 'aged-toggle';
  btn.textContent = `${state.showAlertHist ? '▾ hide' : '▸ show'} ${expired.length} expired alerts (kept ${CONFIG.histDays}d)`;
  btn.addEventListener('click', () => { state.showAlertHist = !state.showAlertHist; renderAlertList(); });
  el.appendChild(btn);
  if (!state.showAlertHist) return;
  for (const a of expired.slice(0, 50)) {
    const div = document.createElement('div');
    div.className = `card alert-card aged sev-${a.sev}`;
    div.innerHTML = `<div class="event">${esc(a.event)}</div><div class="areas">${esc(a.areaDesc || '')}</div>` +
      `<div class="meta" style="margin-top:3px;font-size:11px;color:var(--ink-muted)">sent ${esc(fmtWhen(a.t))} · expired ${esc(fmtWhen(a.expires))}</div>`;
    el.appendChild(div);
  }
}

/* ---------- NOAA NWPS gauges ---------- */

async function fetchGauges() {
  const b = CONFIG.gaugeBbox;
  const url = `${CONFIG.nwpsBase}/gauges?bbox.xmin=${b.xmin}&bbox.ymin=${b.ymin}&bbox.xmax=${b.xmax}&bbox.ymax=${b.ymax}&srid=EPSG_4326`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NWPS HTTP ${res.status}`);
  const data = await res.json();
  state.gauges = (data.gauges || []).filter((g) => {
    const c = g.status && g.status.observed && g.status.observed.floodCategory;
    return c && !['out_of_service', 'obs_not_current', 'not_defined'].includes(c);
  });
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

const riverOf = (name) => String(name || '').split(/ (?:at|near|below|above) /)[0];

function gaugeForecastCat(g) {
  const c = g.status && g.status.forecast && g.status.forecast.floodCategory;
  return FLOOD_CATS.includes(c) ? c : null;
}

function gaugeRising(g) {
  if (gaugeObsStale(g)) return false; // no trustworthy baseline — keep dead gauges out of rising/record-watch
  const f = gaugeForecastCat(g);
  return f !== null && CAT_RANK[f] > CAT_RANK[gaugeCat(g)];
}

// crest-of-record context (data/records.json = NWPS historic crests). Honest by design:
// reports the forecast's margin to the all-time crest, never claims a break unless fcst ≥ record.
const RECORD_NEAR_FT = 5;
function recordContext(g) {
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

function renderGauges() {
  state.layers.gauges.clearLayers();
  state.gaugeMarkers = {};
  // ?hydro=<lid> deep link — open the full hydrograph once its gauge is loaded (once)
  if (state.pendingHydro) {
    const g = state.gauges.find((x) => x.lid === state.pendingHydro);
    if (g) { state.pendingHydro = null; openHydro(g); }
  }
  for (const g of state.gauges) {
    const stale = gaugeObsStale(g);
    const cat = gaugeCat(g);
    const rising = gaugeRising(g);
    const size = stale ? 11 : CAT_SIZE[cat];
    const trend = gaugeTrend(g.lid);
    const falling = cat !== 'none' && trend && trend.dir === 'down';
    // 32px hit area around the visual dot — 8-18px dots are untappable one-thumbed (UX audit #5)
    const icon = L.divIcon({
      className: '',
      html: `<div class="gauge-hit${cat === 'none' && !stale ? ' hit-none' : ''}">` +
        `<div class="gauge-icon ${stale ? 'stale' : `cat-${cat}`}" style="width:${size}px;height:${size}px"></div>` +
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
}

function gaugePopup(g) {
  const o = g.status.observed;
  const stale = gaugeObsStale(g);
  const cat = gaugeObsCat(g);
  const el = document.createElement('div');
  const f = g.status.forecast;
  const fCat = gaugeForecastCat(g);
  const forecastLine = fCat
    ? `<div class="popup-meta">${gaugeRising(g) ? '▲ RISING · ' : ''}Forecast: ${fmtNum(f.primary)} ${esc(f.primaryUnit)} · <span class="cat-word" style="color:var(--cat-${fCat})">${esc(CAT_LABEL[fCat])}</span> @ ${esc(fmtWhen(f.validTime))}</div>`
    : '';
  const tr = gaugeTrend(g.lid);
  const trendLine = tr
    ? `<div class="popup-meta">Trend: ${tr.rate >= 0 ? '+' : ''}${tr.rate.toFixed(1)} ft/hr ${tr.dir === 'up' ? '↑' : tr.dir === 'down' ? '↓' : '→ steady'} (last ~hour)</div>`
    : '';
  el.innerHTML = `<div class="popup-title">${esc(g.name)}</div>` +
    `<div class="popup-meta"><span class="cat-word" style="color:var(--cat-${stale ? 'none' : cat})">${esc(CAT_LABEL[cat])}</span> · ${fmtNum(o.primary)} ${esc(o.primaryUnit)} @ ${esc(fmtWhen(o.validTime))}</div>` +
    (stale ? `<div class="popup-meta stale-note">⏱ STALE: no current data (last obs ${esc(fmtWhen(o.validTime))})</div>` : '') +
    trendLine +
    forecastLine +
    `<div class="popup-spark"><canvas width="270" height="80"></canvas><div class="spark-note">Loading ${CONFIG.sparkHours}h stage history…</div></div>` +
    `<button class="popup-expand" data-lid="${esc(g.lid)}">⤢ Full hydrograph (obs + forecast + record)</button>` +
    `<div class="popup-link"><a href="https://water.noaa.gov/gauges/${esc(g.lid)}" target="_blank" rel="noopener">NOAA gauge page (forecast) →</a></div>`;
  drawSparkline(g, el.querySelector('canvas'), el.querySelector('.spark-note'));
  el.querySelector('.popup-expand').addEventListener('click', () => openHydro(g));
  return el;
}

// full-screen hydrograph: observed history + forecast trace + flood-stage bands + crest-of-record line
async function openHydro(g) {
  $('#hydro-modal').hidden = false;
  $('#hydro-title').textContent = g.name;
  const note = $('#hydro-note');
  note.textContent = 'Loading observed + forecast…';
  try {
    const [detail, obs, fcst] = await Promise.all([
      gaugeJson(g.lid, 'detail', `${CONFIG.nwpsBase}/gauges/${g.lid}`),
      gaugeJson(g.lid, 'series', `${CONFIG.nwpsBase}/gauges/${g.lid}/stageflow/observed`),
      cachedJson(`${CONFIG.nwpsBase}/gauges/${g.lid}/stageflow/forecast`).catch(() => ({ data: [] })),
    ]);
    drawHydro(g, detail, obs.data || [], fcst.data || []);
  } catch { note.textContent = 'Hydrograph data unavailable right now.'; }
}

function drawHydro(g, detail, obsData, fcstData) {
  const now = Date.now();
  const back = now - 24 * 3600000; // 24h observed history
  const obs = obsData.filter((p) => new Date(p.validTime).getTime() >= back && p.primary > -999)
    .map((p) => ({ t: new Date(p.validTime).getTime(), v: p.primary }));
  const fcst = fcstData.filter((p) => p.primary > -999).map((p) => ({ t: new Date(p.validTime).getTime(), v: p.primary }));
  if (obs.length < 2 && fcst.length < 2) { $('#hydro-note').textContent = 'No recent stage data.'; return; }
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
    ctx.fillText(`⚑ crest of record ${rec.record_ft}ft (${(rec.record_date || '').slice(0, 4)})`, mL + 4, y(rec.record_ft) - 3);
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
    '<span class="hl"><i style="background:var(--accent)"></i>observed (24h)</span>' +
    '<span class="hl"><i style="background:var(--cat-major)"></i>forecast</span>' +
    (rec ? '<span class="hl"><i class="dashed"></i>crest of record</span>' : '') +
    '<span class="hl">shaded = flood-stage bands</span>';
  $('#hydro-note').innerHTML = `Observed + NWPS forecast · <a href="https://water.noaa.gov/gauges/${esc(g.lid)}" target="_blank" rel="noopener">NOAA gauge page →</a>`;
}

// 3-min TTL promise cache — popup close/reopen redraws instantly; failures evict so retry works
const sparkCache = new Map();
function cachedJson(url, ttlMs = 180000) {
  const hit = sparkCache.get(url);
  if (hit && Date.now() - hit.t < ttlMs) return hit.p;
  const p = fetch(url).then((r) => { if (!r.ok) throw new Error(`http ${r.status}`); return r.json(); });
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
    let pts = (series.data || []).filter((p) => new Date(p.validTime).getTime() >= cutoff && p.primary > -999);
    if (pts.length < 2) { note.textContent = 'No recent stage history available.'; return; }
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
    note.textContent = `Last ${CONFIG.sparkHours}h · dashed lines = action/minor/moderate/major stages`;
  } catch { note.textContent = 'Stage history unavailable.'; }
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
  if (!res.ok) throw new Error(`RFC fcst HTTP ${res.status}`);
  const data = await res.json();
  // NWPS gauges already show their own forecast — keep only lids this board lacks
  const nwpsLids = new Set(state.gauges.map((g) => g.lid));
  state.fcstMax = (data.features || []).filter((f) => {
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
      `<div class="popup-meta">Forecast max: ${fmtNum(p.max_value)} ft · <span class="cat-word" style="color:var(--cat-${cat})">${esc(CAT_LABEL[cat])}</span> (5-day)</div>` +
      `<div class="popup-meta">Issued ${esc(fmtWhen(fcstIssuedIso(p.issued_time)))}</div>` +
      `<div class="popup-link"><a href="https://water.noaa.gov/gauges/${esc(p.nws_lid)}" target="_blank" rel="noopener">NOAA gauge page →</a></div>`);
    state.layers.fcstMax.addLayer(m);
  }
}

/* ---------- USGS instantaneous values (raw stage — no flood-stage context) ---------- */

async function fetchUsgsIv() {
  const b = CONFIG.gaugeBbox;
  const url = `${CONFIG.usgsIvBase}?format=json&parameterCd=00065&modifiedSince=PT2H&bBox=${b.xmin},${b.ymin},${b.xmax},${b.ymax}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`USGS IV HTTP ${res.status}`);
  const data = await res.json();
  const sites = [];
  for (const ts of (data.value && data.value.timeSeries) || []) {
    const si = ts.sourceInfo;
    const vals = ts.values && ts.values[0] && ts.values[0].value;
    const last = vals && vals[vals.length - 1];
    if (!last) continue;
    const ft = parseFloat(last.value);
    if (!Number.isFinite(ft) || ft <= -999) continue;
    const loc = si.geoLocation.geogLocation;
    sites.push({ site: si.siteCode[0].value, name: si.siteName, lat: loc.latitude, lon: loc.longitude, ft, t: last.dateTime });
  }
  // NWPS gauges carry flood categories — keep USGS to the sites NWPS lacks
  state.usgsSites = sites.filter((s) => !state.gauges.some((g) => distMi(s.lat, s.lon, g.latitude, g.longitude) < 0.3));
  markHealthy('usgs');
  renderUsgsIv();
}

function renderUsgsIv() {
  state.layers.usgs.clearLayers();
  for (const s of state.usgsSites) {
    const icon = L.divIcon({ className: '', html: '<div class="usgs-dot"></div>', iconSize: [24, 24], iconAnchor: [12, 12] });
    const m = L.marker([s.lat, s.lon], { icon });
    // raw stage has no flood-stage thresholds here — never imply a category
    m.bindPopup(`<div class="popup-title">${esc(s.name)}</div>` +
      `<div class="popup-meta">Stage: ${s.ft} ft @ ${esc(fmtWhen(s.t))} · raw reading, no flood-stage context</div>` +
      `<div class="popup-link"><a href="https://waterdata.usgs.gov/monitoring-location/${esc(s.site)}" target="_blank" rel="noopener">USGS site page →</a></div>`);
    state.layers.usgs.addLayer(m);
  }
}

/* ---------- TDEM DriveTexas live road conditions (closed / high-water / damage) ---------- */

const ROAD_ATTRIB = 'Road conditions: TxDOT DriveTexas / TDEM (drivetexas.org)';
// Closure + Flooding are prominent reds; Damage a distinct amber. Construction/Accident excluded server-side.
const ROAD_COND = {
  Closure: { label: 'Road CLOSED', color: '#e5342f' },
  Flooding: { label: 'Flooded / high water', color: '#d81b8c' },
  Damage: { label: 'Road damage', color: '#e8912b' },
};
const ROAD_COND_FALLBACK = { label: 'Road condition', color: '#e8912b' };
const roadCondType = (p) => ROAD_COND[p && p.condition] || ROAD_COND_FALLBACK;
const stripHtml = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
// FM0481 → "FM 481", IH0010 → "IH 10"; strips zero-padding after the letter prefix, robust fallback to trimmed original
const prettyRoute = (s) => { const m = String(s ?? '').trim().match(/^([A-Za-z]+)0*(\d.*)$/); return m ? `${m[1]} ${m[2]}` : String(s ?? '').trim(); };
// active = ongoing: keep when end_time is missing/unparseable/future, drop only when it parses to a past time (cleared)
const roadCondActive = (f) => { const e = f.properties && f.properties.end_time; if (!e) return true; const t = Date.parse(e); return !(Number.isFinite(t) && t < Date.now()); };

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

async function fetchRoadClosures() {
  const fields = 'condition,route_name,travel_direction,from_limit,to_limit,description,start_time,end_time,detour_flag,delay_flag';
  const res = await fetch(`${CONFIG.roadCondUrl}?${roadParams(fields)}`);
  if (!res.ok) throw new Error(`DriveTexas HTTP ${res.status}`);
  const data = await res.json();
  // keep points: [] so renderRoadClosures's points loop stays safe (DriveTexas API is lines-only)
  state.roadClosures = { lines: (data.features || []).filter(roadCondActive), points: [] };
  markHealthy('roads');
  updateRoadMemory(state.roadClosures.lines);
  renderRoadClosures();
  renderReopenedRoads();
  renderTiles();
}

/* ---------- recently-reopened roads — a closure leaving the live feed IS the recovery signal ---------- */

const ROADS_KEY = 'respondertx.roads.v1';
const roadHash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36); };
// identity from route+condition+limits only — a description edit must not read as a reopening
const roadId = (p) => roadHash([p.route_name, p.condition, p.from_limit, p.to_limit].map((v) => String(v ?? '')).join('|'));

function roadVertex(geo) {
  if (!geo || !Array.isArray(geo.coordinates)) return null;
  const c = geo.type === 'MultiLineString' ? geo.coordinates[0] && geo.coordinates[0][0] : geo.coordinates[0];
  return Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]) ? [c[1], c[0]] : null;
}

function roadMemory() {
  if (!state.roadMemory) {
    try { state.roadMemory = Object.assign({ seen: {}, reopened: {} }, JSON.parse(localStorage.getItem(ROADS_KEY) || '{}')); }
    catch { state.roadMemory = { seen: {}, reopened: {} }; }
  }
  return state.roadMemory;
}

// diff only a non-empty successful fetch — a failed or empty response must never mark everything reopened
function updateRoadMemory(lines) {
  if (!lines.length) return;
  const mem = roadMemory();
  const now = new Date().toISOString();
  const live = new Set();
  for (const f of lines) {
    const p = f.properties || {};
    const id = roadId(p);
    live.add(id);
    mem.seen[id] = { id, route_name: p.route_name, condition: p.condition, lastSeen: now, vertex: roadVertex(f.geometry) };
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

function reopenedPopupHtml(r) {
  const ct = ROAD_COND[r.condition] || ROAD_COND_FALLBACK;
  return `<div class="popup-title" style="color:var(--good)">✓ ${esc(t('reopen.flag'))}: ${esc(prettyRoute(r.route_name) || 'Road')}</div>` +
    `<div class="popup-meta">${esc(t('reopen.was'))}: ${esc(ct.label)} · ${esc(t('reopen.at'))} ${esc(fmtWhen(r.reopenedAt))}</div>` +
    `<div class="popup-meta" style="opacity:.7;margin-top:4px">${srcBadge('official')} ${esc(ROAD_ATTRIB)} · cleared from the live feed; verify before routing</div>`;
}

function roadPopupHtml(p) {
  const ct = roadCondType(p);
  const road = prettyRoute(p.route_name) || 'Road';
  const from = p.from_limit || '';
  const to = p.to_limit || '';
  const dscr = stripHtml(p.description);
  const detour = Number(p.detour_flag) === 1;
  return `<div class="popup-title" style="color:${ct.color}">${esc(ct.label)}</div>` +
    `<div class="popup-meta"><strong>${esc(road)}</strong></div>` +
    ((from || to) ? `<div class="popup-meta">${esc(from)}${from && to ? ' → ' : ''}${esc(to)}</div>` : '') +
    (dscr ? `<div class="popup-meta">${esc(dscr)}</div>` : '') +
    (p.start_time ? `<div class="popup-meta">Since ${esc(fmtWhen(p.start_time))}</div>` : '') +
    (detour ? '<div class="popup-meta">Detour available</div>' : '') +
    `<div class="popup-meta" style="opacity:.7;margin-top:4px">${srcBadge('official')} ${esc(ROAD_ATTRIB)} · live conditions, not a closure guarantee; verify before routing</div>`;
}

function renderRoadClosures() {
  const layer = state.layers.roadClosures;
  if (!layer) return;
  layer.clearLayers();
  const rc = state.roadClosures || { lines: [], points: [] };
  for (const f of rc.lines) {
    if (!f.geometry) continue;
    const ct = roadCondType(f.properties);
    const gj = L.geoJSON(f, { style: { color: ct.color, weight: 5, opacity: 0.9 }, attribution: ROAD_ATTRIB });
    gj.bindPopup(roadPopupHtml(f.properties));
    layer.addLayer(gj);
  }
  for (const f of rc.points) {
    const c = f.geometry && f.geometry.coordinates;
    if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    const ct = roadCondType(f.properties);
    const m = L.circleMarker([c[1], c[0]], { radius: 7, color: '#fff', weight: 1.5, fillColor: ct.color, fillOpacity: 0.95, attribution: ROAD_ATTRIB });
    m.bindPopup(roadPopupHtml(f.properties));
    layer.addLayer(m);
  }
  for (const r of reopenedRoads().fresh) {
    if (!r.vertex) continue;
    const m = L.circleMarker(r.vertex, { radius: 6, color: '#fff', weight: 1.5, fillColor: cssVar('--good') || '#0ca30c', fillOpacity: 0.9, attribution: ROAD_ATTRIB });
    m.bindPopup(reopenedPopupHtml(r));
    layer.addLayer(m);
  }
}

/* ---------- TxGIO low-water-crossing location inventory (LOCATIONS, not live status) ---------- */

const LWC_ATTRIB = 'Low-water crossings: TxGIO (Texas Geographic Information Office)';
const LWC_FOOTER = 'Crossing location inventory (TxGIO): NOT live flood status; check conditions before crossing.';

// lazy: fetched once on first overlayadd; ~3.7k points paginated (maxRecordCount 2000), canvas-rendered
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
    resultRecordCount: '2000',
    f: 'geojson',
  };
  try {
    const pages = await Promise.all([0, 2000].map(async (off) => {
      const qs = new URLSearchParams({ ...base, resultOffset: String(off) });
      const r = await fetch(`${CONFIG.lwcUrl}?${qs}`);
      if (!r.ok) throw new Error(`TxGIO HTTP ${r.status}`);
      const d = await r.json();
      return d.features || [];
    }));
    renderLwc([].concat(...pages));
  } catch (err) {
    state._lwcLoaded = false; // allow a retry the next time the layer is toggled on
  }
}

function renderLwc(features) {
  const layer = state.layers.lwc;
  if (!layer) return;
  layer.clearLayers();
  const canvas = L.canvas({ padding: 0.5 });
  for (const f of features) {
    const c = f.geometry && f.geometry.coordinates;
    if (!c || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    const m = L.circleMarker([c[1], c[0]], { renderer: canvas, radius: 3.5, color: '#2b8ce8', weight: 1, fillColor: '#5ab0ff', fillOpacity: 0.5, attribution: LWC_ATTRIB });
    m.bindPopup(() => lwcPopupHtml(f.properties)); // lazy — 3.7k eager popup strings stall the layer toggle
    layer.addLayer(m);
  }
}

function lwcPopupHtml(p) {
  const road = String(p.road || '').trim() || 'Low-water crossing';
  const rows = [['County', p.county], ['Type', p.lwx_type], ['Grade', p.grade], ['Signage', p.signage]]
    .filter(([, v]) => String(v || '').trim());
  return `<div class="popup-title">${esc(road)}</div>` +
    rows.map(([k, v]) => `<div class="popup-meta">${esc(k)}: ${esc(String(v).trim())}</div>`).join('') +
    `<div class="popup-meta" style="opacity:.7;margin-top:4px">${srcBadge('official')} ${esc(LWC_FOOTER)}</div>`;
}

/* ---------- IEM local storm reports (ground truth) ---------- */

async function fetchLsrs() {
  const hours = state.filters.window ? Math.max(2, Math.ceil(+state.filters.window / 60)) : CONFIG.lsrHours;
  const res = await fetch(`${CONFIG.lsrUrl}?hours=${hours}&states=TX`);
  if (!res.ok) throw new Error(`LSR HTTP ${res.status}`);
  const data = await res.json();
  state.lsrs = (data.features || [])
    .filter((f) => LSR_FLOOD_RE.test(f.properties.typetext || ''))
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
    `<div class="popup-link"><a href="https://maps.google.com/?q=${e.lat},${e.lon}" target="_blank" rel="noopener">navigate →</a> · USNG ${esc(toUSNG(e.lat, e.lon))}</div>`;
}

function lsrCardDiv(e, aged) {
  const div = document.createElement('div');
  div.className = `card lsr-card${aged ? ' aged' : ''}`;
  div.innerHTML = `<div class="head"><span>💧</span><span class="type-chip">${esc(e.typetext)}</span>` +
    `<span class="when"><span class="fresh-dot ${freshClass(e.t)}"></span> ${esc(fmtWhen(e.t))}</span></div>` +
    (e.remark ? `<div class="summary">${highlightRoads(e.remark)}</div>` : '') +
    `<div class="meta">📍 ${esc(e.city)}, ${esc(e.county)} Co. · via ${esc(e.source)}` +
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
  el.innerHTML = '<div class="section-title">Ground truth: storm reports (spotter/official)</div>';
  if (!fresh.length) el.innerHTML += `<div class="card">No flood storm reports in TX in the last ${Math.round(cutoff / 60)}h.</div>`;
  const lsrCap = state.showAllLsrs ? 30 : 5;
  for (const e of fresh.slice(0, lsrCap)) el.appendChild(lsrCardDiv(e, false));
  if (fresh.length > 5) {
    const more = document.createElement('button');
    more.className = 'aged-toggle';
    more.textContent = state.showAllLsrs ? '▾ show fewer reports' : `▸ show ${Math.min(fresh.length, 30) - 5} more recent reports`;
    more.addEventListener('click', () => { state.showAllLsrs = !state.showAllLsrs; renderLsrs(); });
    el.appendChild(more);
  }
  if (aged.length) {
    const btn = document.createElement('button');
    btn.id = 'lsr-aged-toggle';
    btn.className = 'aged-toggle';
    btn.textContent = `${state.showAgedLsrs ? '▾ hide' : '▸ show'} ${aged.length} aged reports (>${Math.round(cutoff / 60)}h, kept ${CONFIG.histDays}d)`;
    btn.addEventListener('click', () => { state.showAgedLsrs = !state.showAgedLsrs; renderLsrs(); });
    el.appendChild(btn);
    if (state.showAgedLsrs) for (const e of aged.slice(0, 40)) el.appendChild(lsrCardDiv(e, true));
  }
  renderTicker();
}

