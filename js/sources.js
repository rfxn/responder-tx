'use strict';

/* ---------- NWS alerts ---------- */

function alertSeverity(p) {
  const threat = (p.parameters && p.parameters.flashFloodDamageThreat || []).join(' ');
  if (/FLASH FLOOD EMERGENCY/i.test(p.description || '') || /CATASTROPHIC/i.test(threat)) return 'emergency';
  if (/Warning/i.test(p.event)) return 'warning';
  if (/Watch/i.test(p.event)) return 'watch';
  return 'advisory';
}

// Riverine Flood Warnings in one county share an areaDesc ("Val Verde, TX"); the
// specific reach that tells them apart lives in the description text.
function alertReach(p) {
  const s = (p.description || '').replace(/\s+/g, ' ');
  const m = s.match(/rivers?\b[^.]*\.\.\.\s*(.+?)\s+affecting\b/i);
  if (!m) return '';
  return m[1].replace(/\bAt\b/g, 'at').replace(/\bOf\b/g, 'of').replace(/\b(?:Nr|Near)\b/gi, 'near').trim();
}

// alert-feed allowlist: river flood plus the coastal/tropical/wind hazards the old /flood/ filter dropped
// (storm surge, tropical storm, hurricane, high wind); 2-letter VTEC lives in properties.parameters.VTEC
const HAZARD_ALERT_RE = /flood|storm surge|tropical|hurricane|high wind|wind advisory|beach hazard/i;

// active hurricane/tropical threat to the TX mainland = an unexpired storm surge / tropical storm / hurricane warning or watch
const TROPICAL_THREAT_RE = /storm surge (warning|watch)|tropical storm (warning|watch)|hurricane (warning|watch)/i;
function hasActiveTropicalThreat() {
  return (state.alerts || []).some((f) => TROPICAL_THREAT_RE.test(f.properties.event || '')
    && !(f.properties.expires && new Date(f.properties.expires) < new Date()));
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
  if (!res.ok) throw new Error(`NWS alerts HTTP ${res.status}`);
  const data = await res.json();
  const hazards = (data.features || []).filter((f) => HAZARD_ALERT_RE.test(f.properties.event || ''));
  hazards.forEach((f) => { f._sev = alertSeverity(f.properties); });
  const rank = { emergency: 0, warning: 1, watch: 2, advisory: 3 };
  hazards.sort((a, b) => rank[a._sev] - rank[b._sev] || new Date(b.properties.sent || 0) - new Date(a.properties.sent || 0));
  const emergencies = hazards.filter((f) => f._sev === 'emergency');
  const fresh = emergencies.filter((f) => !state.knownEmergencyIds.has(f.id));
  emergencies.forEach((f) => state.knownEmergencyIds.add(f.id));
  if (state.alertsLoadedOnce && fresh.length) showEmergencyBanner(fresh);
  if (!emergencies.length && !$('#emergency-banner').hidden) dismissEmergencyBanner(); // banner ages out with its alert
  state.alertsLoadedOnce = true;
  state.alerts = hazards;
  markHealthy('alerts');
  recordAlertHist();
  renderAlertList();
  await renderAlertPolys();
  renderTiles();
  maybeAutoTropical(); // auto-enable the tracker when TX has an active tropical/hurricane threat
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
    layer._alertId = f.id; // lets a card click find and flash its polygon
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
  const reach = alertReach(p);
  return `<div class="popup-title">${esc(p.event)}${f._sev === 'emergency' ? ': <span style="color:var(--sev-emergency);font-weight:700">FLASH FLOOD EMERGENCY</span>' : ''}</div>` +
    `<div class="popup-meta">${esc(p.areaDesc || '')}${reach ? ` · ${esc(reach)}` : ''}</div>` +
    `<div class="popup-meta">Expires: ${esc(fmtWhen(p.expires))}</div>` +
    `<div class="popup-link"><a href="#" class="alert-popup-link" data-alert-id="${esc(f.id)}">${esc(t('alert.full'))} →</a></div>`;
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
  const reach = alertReach(p);
  const div = document.createElement('div');
  div.className = `card alert-card sev-${f._sev}`;
  div.innerHTML = `<div class="event"><span class="ev-name">${esc(p.event)}</span>${f._sev === 'emergency' ? '<span class="emergency-flag">EMERGENCY</span>' : ''}` +
    `<a class="alert-text-link" role="button" tabindex="0">${esc(t('alert.text'))} ↗</a></div>` +
    `<div class="areas">${esc(p.areaDesc || '')}${reach ? ` · <span class="alert-reach">${esc(reach)}</span>` : ''}</div>` +
    `<div class="alert-meta">` +
    (p.sent ? `<span class="am-when"><span class="fresh-dot ${freshClass(p.sent)}"></span>${esc(t('alert.sent'))} ${esc(fmtWhen(p.sent))}</span>` : '') +
    `<span class="am-when">${esc(t('alert.untilShort'))} ${esc(fmtWhen(p.expires))}</span></div>`;
  const link = div.querySelector('.alert-text-link');
  link.addEventListener('click', (e) => { e.stopPropagation(); openAlertText(f); });
  link.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openAlertText(f); } });
  div.addEventListener('click', () => {
    let b = null;
    if (f.geometry) { const bb = L.geoJSON(f.geometry).getBounds(); if (bb.isValid()) b = bb; }
    if (!b) {
      const z = (f.properties.affectedZones || [])[0];
      const g = z && state.zoneGeomCache.get(z);
      if (g) { const bb = L.geoJSON(g).getBounds(); if (bb.isValid()) b = bb; }
    }
    if (b) { state.map.fitBounds(b, { maxZoom: 10 }); flashAlert(f); return; }
    openAlertText(f); // no geometry to fly to → open the readable alert text instead of raw JSON
  });
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
  $('#alert-title').textContent = p.event + (f._sev === 'emergency' ? ' · FLASH FLOOD EMERGENCY' : '');
  const parts = [`<div class="alert-doc-area">${esc(p.areaDesc || '')}${reach ? ` · ${esc(reach)}` : ''}</div>`];
  if (p.headline) parts.push(`<div class="alert-doc-headline">${esc(p.headline)}</div>`);
  parts.push(`<div class="alert-doc-when">${esc(t('alert.until'))} ${esc(fmtWhen(p.expires))}</div>`);
  if (p.description) parts.push(`<pre class="alert-doc-text">${esc(p.description.trim())}</pre>`);
  if (p.instruction) parts.push(`<div class="alert-doc-instr-h">${esc(t('alert.instruction'))}</div><pre class="alert-doc-text">${esc(p.instruction.trim())}</pre>`);
  parts.push(`<div class="alert-doc-src">${esc(p.senderName || 'NWS')} · <a href="${esc(safeUrl(f.id))}" target="_blank" rel="noopener">${esc(t('alert.raw'))} →</a></div>`);
  $('#alert-body').innerHTML = parts.join('');
  $('#alert-modal').hidden = false;
}

function openAlertTextById(id) {
  const f = state.alerts.find((a) => a.id === id);
  if (f) openAlertText(f);
}

function renderAlertList() {
  const el = $('#alert-list');
  el.innerHTML = `<div class="section-title">${esc(t('sec.alerts'))}</div>`;
  const sevF = $('#flt-alert-sev').value, qF = $('#flt-alert-q').value.toLowerCase();
  const shown = state.alerts.filter((f) => (!sevF || f._sev === sevF)
    && (!qF || `${f.properties.event} ${f.properties.areaDesc} ${alertReach(f.properties)}`.toLowerCase().includes(qF)));
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
  if (f === null) return false;
  const vt = g.status.forecast && g.status.forecast.validTime;
  if (!vt || new Date(vt) <= new Date()) return false; // a crest already past is not rising
  return CAT_RANK[f] > CAT_RANK[gaugeCat(g)];
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
    `<button class="popup-expand open-in-gauges">${esc(t('sync.opengauges'))}</button>` +
    `<div class="popup-link"><a href="https://water.noaa.gov/gauges/${esc(g.lid)}" target="_blank" rel="noopener">NOAA gauge page (forecast) →</a></div>`;
  drawSparkline(g, el.querySelector('canvas'), el.querySelector('.spark-note'));
  el.querySelector('.popup-expand').addEventListener('click', () => openHydro(g));
  el.querySelector('.open-in-gauges').addEventListener('click', () => openInGaugesList(g.lid));
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
  renderReopenedMap();
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
    const flood = p.condition === 'Flooding' || FLOOD_ROAD_RE.test(p.description || '');
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

// flood-scoped everywhere reopenings render; legacy respondertx.roads.v1 entries lack `flood` — backfill from condition
const reopenIsFlood = (r) => (r.flood ?? (r.condition === 'Flooding'));

function reopenedPopupHtml(r) {
  const ct = ROAD_COND[r.condition] || ROAD_COND_FALLBACK;
  return `<div class="popup-title" style="color:var(--good)">✓ ${esc(t('reopen.flag'))}: ${esc(prettyRoute(r.route_name) || 'Road')}</div>` +
    `<div class="popup-meta">${esc(t('reopen.was'))}: ${esc(ct.label)} · ${esc(t('reopen.at'))} ${esc(fmtWhen(r.reopenedAt))}</div>` +
    `<div class="popup-meta" style="opacity:.7;margin-top:4px">${srcBadge('official')} ${esc(ROAD_ATTRIB)} · cleared from the live feed; verify before routing</div>`;
}

function roadPopupHtml(p, geo) {
  const ct = roadCondType(p);
  const road = prettyRoute(p.route_name) || 'Road';
  const from = p.from_limit || '';
  const to = p.to_limit || '';
  const dscr = stripHtml(p.description).replace(/^[\s–—-]+/, ''); // TxDOT feeds a leading "- " artifact; display-only strip
  const detour = Number(p.detour_flag) === 1;
  const miles = Math.round(roadSegMiles(geo));
  const seg = miles >= 2 ? t('road.seg').replace('{mi}', String(miles)) : '';
  const isClosure = String(p.condition || '').toLowerCase() === 'closure';
  return `<div class="popup-title" style="color:${ct.color}">${esc(ct.label)}</div>` +
    `<div class="popup-meta"><strong>${esc(road)}</strong></div>` +
    ((from || to || seg) ? `<div class="popup-meta">${esc(from)}${from && to ? ' → ' : ''}${esc(to)}${(from || to) && seg ? ' · ' : ''}${esc(seg)}</div>` : '') +
    (dscr ? `<div class="popup-meta">${esc(dscr)}</div>` : '') +
    (p.start_time ? `<div class="popup-meta">Since ${esc(fmtWhen(p.start_time))}</div>` : '') +
    (detour ? '<div class="popup-meta">Detour available</div>' : '') +
    `<div class="popup-meta" style="opacity:.8">${esc(t(isClosure ? 'road.note.closure' : 'road.note.cond'))}</div>` +
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
    gj.bindPopup(roadPopupHtml(f.properties, f.geometry));
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

// lazy: fetched on first overlayadd and refreshed on the data cycle while the layer is on. All sublayers
// are optional — any that fails or returns empty simply renders nothing; total network failure degrades quietly.
async function fetchTropical() {
  const group = state.layers.tropical;
  if (!group) return;
  const grab = async (n) => {
    try {
      const r = await fetch(`${CONFIG.tropicalBase}/${n}/query?where=1%3D1&outFields=*&f=geojson`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()).features || [];
    } catch { return null; } // null = this sublayer failed (distinct from [] = no active storms)
  };
  const [cone, ftrack, otrack, ww, fpos, opos] = await Promise.all([grab(4), grab(2), grab(3), grab(5), grab(0), grab(1)]);
  if ([cone, ftrack, otrack, ww, fpos, opos].every((x) => x === null)) {
    $('#refresh-note').textContent = 'tropical feed unavailable';
    return; // every sublayer failed → network down; keep whatever was last drawn
  }
  markHealthy('tropical');
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

/* ---------- road & river cameras (TxDOT HLS live + USGS HIVIS stills) ---------- */

const CAM_ATTRIB_TXDOT = 'Traffic cameras: TxDOT (Lonestar/DriveTexas)';
const CAM_ATTRIB_USGS = 'River cameras: USGS HIVIS (public domain, provisional)';
const CAM_ATTRIB_AUSTIN = 'Traffic cameras: City of Austin, Texas (public domain)';
const CAM_ATTRIB_ATX = 'Flood cameras: ATX Floods / City of Austin (low-water crossings)';
const CAM_ATTRIB_HOUSTON = 'Traffic cameras: Houston TranStar (Houston region)';
const CAM_ATTRIB_ARLINGTON = 'Traffic cameras: City of Arlington, Texas';
const CAM_ATTRIB_ELP = 'Live cameras: City of El Paso (international bridges)';
const CAM_ATTRIB_HAYS = 'Flood cameras: Hays County Office of Emergency Services';
const CAM_ATTRIB = { txdot: CAM_ATTRIB_TXDOT, river: CAM_ATTRIB_USGS, austin: CAM_ATTRIB_AUSTIN, atxfloods: CAM_ATTRIB_ATX, houston: CAM_ATTRIB_HOUSTON, arlington: CAM_ATTRIB_ARLINGTON, elpbridge: CAM_ATTRIB_ELP, hays: CAM_ATTRIB_HAYS };
const CAM_STALE_MINS = 45; // aging invariant: a still older than this must never look live
const HIVIS_S3 = 'https://usgs-nims-images.s3.amazonaws.com';
const ATXFLOODS_BASE = 'https://api.atxfloods.com';
const CAM_KEY_RE = /___\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.jpg$/;

// lazy: inventory is a committed snapshot, fetched once on first layer enable / Drive Mode / gauge popup
function loadCameras() {
  if (state.camerasP) return state.camerasP;
  state.camerasP = fetch(`data/cameras.json?_=${Math.floor(Date.now() / 3600000)}`)
    .then((r) => { if (!r.ok) throw new Error(`cameras HTTP ${r.status}`); return r.json(); })
    .then((d) => {
      state.cameras = { txdot: d.txdot || [], river: d.river || [], austin: d.austin || [], atxfloods: d.atxfloods || [], houston: d.houston || [], arlington: d.arlington || [], elpbridge: d.elpbridge || [], hays: d.hays || [] };
      renderCameras();
      return state.cameras;
    });
  state.camerasP.catch(() => { state.camerasP = null; }); // failed fetch — allow retry on next trigger
  return state.camerasP;
}

function camTitle(c, kind) {
  if (kind === 'river' || kind === 'austin' || kind === 'atxfloods' || kind === 'houston' || kind === 'arlington' || kind === 'elpbridge' || kind === 'hays') return c.name;
  if (c.src === 'its') return c.name || prettyRoute(c.route) || 'Traffic camera'; // ITS names carry the cross-street
  return c.description || prettyRoute(c.route) || c.name || 'Traffic camera';
}

// per-network marker glyph — distinct outline so river/city/flood cams read apart at a glance
function camIconClass(c, kind) {
  if (kind === 'river') return ' cam-river';
  if (kind === 'austin') return ' cam-austin';
  if (kind === 'atxfloods') return ' cam-flood';
  if (kind === 'houston') return ' cam-houston';
  if (kind === 'arlington') return ' cam-arlington';
  if (kind === 'elpbridge') return ' cam-elp';
  if (kind === 'hays') return ' cam-flood'; // Hays OES flood cams reuse the flood glyph
  return c.src === 'its' ? ' cam-snap' : ''; // snapshot-only ITS cams read as "still", not "live"
}

// [state.layers key, cameras array, net] — one independent sub-layer per source
const CAM_NETS = [
  ['camsTxdot', 'txdot', 'txdot'],
  ['camsRiver', 'river', 'river'],
  ['camsAustin', 'austin', 'austin'],
  ['camsFlood', 'atxfloods', 'atxfloods'],
  ['camsHouston', 'houston', 'houston'],
  ['camsArlington', 'arlington', 'arlington'],
  ['camsElpBridge', 'elpbridge', 'elpbridge'],
  ['camsHays', 'hays', 'hays'],
];

function renderCameras() {
  if (!state.cameras || !state.layers.camsTxdot) return;
  const put = (layer, marks) => {
    if (!layer) return;
    layer.clearLayers();
    if (layer.addLayers) layer.addLayers(marks); // markercluster bulk add
    else marks.forEach((m) => layer.addLayer(m));
  };
  const mark = (c, kind) => {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) return null;
    const icon = L.divIcon({
      className: '',
      html: `<div class="cam-icon${camIconClass(c, kind)}">📷</div>`,
      iconSize: [22, 22], iconAnchor: [11, 11],
    });
    const m = L.marker([c.lat, c.lon], { icon, attribution: CAM_ATTRIB[kind] });
    m.bindPopup(() => camPopup(c, kind), { minWidth: 230 });
    return m;
  };
  for (const [lk, arr, net] of CAM_NETS) {
    put(state.layers[lk], (state.cameras[arr] || []).map((c) => mark(c, net)).filter(Boolean));
  }
  // ?cam=<name|camId|id> deep link — open the viewer once the inventory is in (once)
  if (state.pendingCam) {
    const want = state.pendingCam;
    state.pendingCam = null;
    const hit = findCamByKey(want);
    if (hit) openCamViewer(hit.c, hit.kind);
  }
}

// resolve a deep-link token across every network (camId / name / numeric id)
function findCamByKey(want) {
  const rv = state.cameras.river.find((c) => c.camId === want || c.name === want);
  if (rv) return { c: rv, kind: 'river' };
  const tx = state.cameras.txdot.find((c) => c.name === want);
  if (tx) return { c: tx, kind: 'txdot' };
  const au = state.cameras.austin.find((c) => String(c.id) === want || c.name === want);
  if (au) return { c: au, kind: 'austin' };
  const af = state.cameras.atxfloods.find((c) => String(c.id) === want || c.name === want);
  if (af) return { c: af, kind: 'atxfloods' };
  const ho = state.cameras.houston.find((c) => String(c.id) === want || c.name === want);
  if (ho) return { c: ho, kind: 'houston' };
  const ar = state.cameras.arlington.find((c) => String(c.id) === want || c.name === want);
  if (ar) return { c: ar, kind: 'arlington' };
  const ep = state.cameras.elpbridge.find((c) => c.name === want);
  if (ep) return { c: ep, kind: 'elpbridge' };
  const hy = (state.cameras.hays || []).find((c) => String(c.id) === want || c.name === want);
  if (hy) return { c: hy, kind: 'hays' };
  return null;
}

function camPopup(c, kind) {
  const el = document.createElement('div');
  let sub;
  if (kind === 'river') sub = `${esc(t('cam.river'))}${c.nwisId ? ` · USGS ${esc(c.nwisId)}` : ''}`;
  else if (kind === 'atxfloods' || kind === 'hays') sub = esc(t('cam.floodcam'));
  else if (kind === 'elpbridge') sub = esc(t('cam.bridge'));
  else if (kind === 'austin' || kind === 'houston' || kind === 'arlington') sub = esc(t('cam.traffic'));
  else sub = `${esc(prettyRoute(c.route) || '')}${c.route ? ' · ' : ''}${esc(t(c.src === 'its' ? 'cam.snapcam' : 'cam.traffic'))}`;
  el.innerHTML = `<div class="popup-title">📷 ${esc(camTitle(c, kind))}</div>` +
    `<div class="popup-meta">${sub}</div>` +
    `<button class="popup-expand cam-view-btn">${esc(t('cam.view'))}</button>` +
    `<div class="popup-meta" style="opacity:.7;margin-top:4px">${srcBadge('official')} ${esc(CAM_ATTRIB[kind])} · ${esc(t('cam.verify'))}</div>`;
  el.querySelector('.cam-view-btn').addEventListener('click', () => openCamViewer(c, kind));
  return el;
}

// short "Operator · type" label for the Drive-mode nearest-cam row
function camNetLabel(kind) {
  if (kind === 'river') return `USGS · ${t('cam.river')}`;
  if (kind === 'austin') return `Austin · ${t('cam.traffic')}`;
  if (kind === 'atxfloods') return `ATX Floods · ${t('cam.floodcam')}`;
  if (kind === 'houston') return `Houston TranStar · ${t('cam.traffic')}`;
  if (kind === 'arlington') return `Arlington · ${t('cam.traffic')}`;
  if (kind === 'elpbridge') return `City of El Paso · ${t('cam.bridge')}`;
  if (kind === 'hays') return `Hays County OES · ${t('cam.floodcam')}`;
  return `TxDOT · ${t('cam.traffic')}`;
}

function nearestRiverCam(lat, lon, maxKm) {
  if (!state.cameras) return null;
  let best = null, bestMi = maxKm * 0.621371;
  for (const c of state.cameras.river) {
    const d = distMi(lat, lon, c.lat, c.lon);
    if (d < bestMi) { bestMi = d; best = c; }
  }
  return best;
}

function openCamViewer(c, kind) {
  camViewerTeardown();
  state.camGen = (state.camGen || 0) + 1; // invalidates every in-flight load from the previous camera
  const gen = state.camGen;
  $('#cam-viewer').hidden = false;
  $('#cam-title').textContent = `📷 ${camTitle(c, kind)}`;
  const stage = $('#cam-stage'), meta = $('#cam-meta'), note = $('#cam-note');
  if (kind === 'austin') {
    // City of Austin still: fresh JPEG via the same-origin /api/cam/austin proxy (no CORS upstream)
    note.innerHTML = `${srcBadge('official')} ${esc(t('cam.austin.note'))} · ${esc(CAM_ATTRIB_AUSTIN)}`;
    stage.innerHTML = `<div class="cam-fallback">${esc(t('cam.loading'))}</div>`;
    loadCityStill(c, stage, meta, false, gen, 'austin');
  } else if (kind === 'houston') {
    // Houston TranStar still: fresh JPEG via the same-origin /api/cam/houston proxy (no CORS upstream)
    note.innerHTML = `${srcBadge('official')} ${esc(t('cam.houston.note'))} · ${esc(CAM_ATTRIB_HOUSTON)}`;
    stage.innerHTML = `<div class="cam-fallback">${esc(t('cam.loading'))}</div>`;
    loadCityStill(c, stage, meta, false, gen, 'houston');
  } else if (kind === 'arlington') {
    // City of Arlington still: fresh JPEG via the same-origin /api/cam/arlington proxy (no CORS upstream)
    note.innerHTML = `${srcBadge('official')} ${esc(t('cam.arlington.note'))} · ${esc(CAM_ATTRIB_ARLINGTON)}`;
    stage.innerHTML = `<div class="cam-fallback">${esc(t('cam.loading'))}</div>`;
    loadCityStill(c, stage, meta, false, gen, 'arlington');
  } else if (kind === 'hays') {
    // Hays County OES flood still: fresh JPEG via the same-origin /api/cam/hays proxy (DriveHQ drops CORS with an Origin)
    note.innerHTML = `${srcBadge('official')} ${esc(t('cam.hays.note'))} · ${esc(CAM_ATTRIB_HAYS)}`;
    stage.innerHTML = `<div class="cam-fallback">${esc(t('cam.loading'))}</div>`;
    loadCityStill(c, stage, meta, false, gen, 'hays');
  } else if (kind === 'atxfloods') {
    // ATX Floods low-water-crossing cam: newest image resolved live (CORS-open), loaded direct
    note.innerHTML = `${srcBadge('official')} ${esc(t('cam.atx.note'))} · ${esc(CAM_ATTRIB_ATX)}`;
    stage.innerHTML = `<div class="cam-fallback">${esc(t('cam.loading'))}</div>`;
    loadAtxFloodStill(c, stage, meta, gen).catch(() => {
      if (gen !== state.camGen) return; // viewer moved on — never paint into another camera's stage
      stage.innerHTML = `<div class="cam-fallback">${esc(t('cam.unavail'))}</div>`;
    });
  } else if (kind === 'txdot' && c.src === 'its') {
    // snapshot-only ITS cam: fresh JPEG via the same-origin /api/cam proxy, never a "LIVE" player
    note.innerHTML = `${srcBadge('official')} ${esc(t('cam.its.note'))} · ${esc(CAM_ATTRIB_TXDOT)}`;
    stage.innerHTML = `<div class="cam-fallback">${esc(t('cam.loading'))}</div>`;
    loadItsSnapshot(c, stage, meta, false, gen);
  } else if (kind === 'txdot' || kind === 'elpbridge') {
    // live HLS: TxDOT SkyVDN + City of El Paso bridge cams both play direct (CORS-open) in the shared player
    const url = safeUrl(c.httpsurl);
    const isElp = kind === 'elpbridge';
    note.innerHTML = `${srcBadge('official')} ${esc(t(isElp ? 'cam.elp.note' : 'cam.txdot.note'))} · ${esc(isElp ? CAM_ATTRIB_ELP : CAM_ATTRIB_TXDOT)}`;
    const video = document.createElement('video');
    video.muted = true; video.autoplay = true; video.playsInline = true; video.controls = true;
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      stage.appendChild(video);
      meta.innerHTML = `<span class="cam-badge live">● ${esc(t('cam.live'))}</span>`;
      video.src = url;
    } else if (window.Hls && Hls.isSupported()) {
      stage.appendChild(video);
      meta.innerHTML = `<span class="cam-badge live">● ${esc(t('cam.live'))}</span>`;
      state.camHls = new Hls({ maxBufferLength: 15 });
      state.camHls.loadSource(url);
      state.camHls.attachMedia(video);
    } else {
      stage.innerHTML = `<div class="cam-fallback">${esc(t('cam.nohls'))}</div>`;
    }
  } else {
    note.innerHTML = `${srcBadge('official')} ${esc(t('cam.usgs.note'))} · ${esc(CAM_ATTRIB_USGS)}`;
    stage.innerHTML = `<div class="cam-fallback">${esc(t('cam.loading'))}</div>`;
    loadRiverStill(c, stage, meta, gen).catch(() => {
      if (gen !== state.camGen) return; // viewer moved on — never paint into another camera's stage
      stage.innerHTML = `<div class="cam-fallback">${esc(t('cam.unavail'))}</div>`;
    });
  }
}

// ITS capture stamps are US Central wall time ("7/18/2026 7:56 PM"); captures are minutes
// old, so applying today's Chicago UTC offset is safe (DST-boundary error window is negligible)
function parseItsStamp(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[, ]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M?)$/i);
  if (!m) return null;
  let h = +m[4] % 12;
  if (/^p/i.test(m[7])) h += 12;
  const wallUtc = Date.UTC(+m[3], +m[1] - 1, +m[2], h, +m[5], +(m[6] || 0));
  let offMin = -300; // CDT fallback if shortOffset is unsupported
  try {
    const tz = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'shortOffset' })
      .formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
    const om = tz && tz.value.match(/GMT([+-])(\d+)(?::(\d+))?/);
    if (om) offMin = (om[1] === '-' ? -1 : 1) * ((+om[2]) * 60 + (+(om[3] || 0)));
  } catch { /* keep fallback */ }
  return new Date(wallUtc - offMin * 60000);
}

// fetch-as-blob (not <img src>) so the X-Cam-Captured header is readable; bust forces a re-fetch.
// opts: { url(bust) -> string, parse(stamp) -> Date|null, alt } — shared by every same-origin proxy still
async function loadProxyStill(stage, meta, bust, gen, opts) {
  try {
    const res = await fetch(opts.url(bust), bust ? { cache: 'reload' } : undefined);
    if (!res.ok) throw new Error(`cam HTTP ${res.status}`);
    const captured = res.headers.get('X-Cam-Captured') || '';
    const blob = await res.blob();
    if (gen !== state.camGen) return; // slow response for a switched/closed viewer — drop it before any state/DOM write
    if (state.camObjUrl) URL.revokeObjectURL(state.camObjUrl);
    state.camObjUrl = URL.createObjectURL(blob);
    const img = document.createElement('img');
    img.alt = opts.alt;
    img.src = state.camObjUrl;
    stage.innerHTML = '';
    stage.appendChild(img);
    const when = opts.parse(captured);
    const stale = !!when && ageMins(when.toISOString()) > CAM_STALE_MINS;
    meta.innerHTML = (stale
      ? `<span class="cam-badge stale">⏱ ${esc(t('cam.stale'))}</span>`
      : `<span class="cam-badge still">${esc(t('cam.snapshot'))}</span>`) +
      `<span class="cam-time">${esc(t('cam.captured'))} ${esc(when ? fmtWhen(when.toISOString()) : (captured || '·'))}</span>` +
      (stale ? `<span class="cam-stale-note">${esc(t('cam.stale.note'))}</span>` : '') +
      `<button class="popup-expand cam-refresh">↻ ${esc(t('cam.refresh'))}</button>`;
    meta.querySelector('.cam-refresh').addEventListener('click', () => {
      stage.innerHTML = `<div class="cam-fallback">${esc(t('cam.loading'))}</div>`;
      loadProxyStill(stage, meta, true, gen, opts);
    });
  } catch {
    if (gen !== state.camGen) return;
    stage.innerHTML = `<div class="cam-fallback">${esc(t('cam.snap.unavail'))}</div>`;
    meta.innerHTML = '';
  }
}

function loadItsSnapshot(c, stage, meta, bust, gen) {
  loadProxyStill(stage, meta, bust, gen, {
    url: (b) => `api/cam/${encodeURIComponent(c.dist)}/${encodeURIComponent(c.icd)}${b ? `?_=${Date.now()}` : ''}`,
    parse: parseItsStamp,
    alt: camTitle(c, 'txdot'),
  });
}

// direct-JPEG city stills (austin/houston/arlington) proxied same-origin; net is both the
// /api/cam path segment and the camTitle kind
function loadCityStill(c, stage, meta, bust, gen, net) {
  loadProxyStill(stage, meta, bust, gen, {
    url: (b) => `api/cam/${net}/${encodeURIComponent(c.id)}${b ? `?_=${Date.now()}` : ''}`,
    parse: (s) => { const d = new Date(s); return isNaN(d.getTime()) ? null : d; }, // X-Cam-Captured is an HTTP (Last-Modified) date
    alt: camTitle(c, net),
  });
}

// ATX Floods newest image resolved from the live list (CORS-open); image_name changes every ~3 min,
// so cache the id→image map only briefly and re-resolve on the next viewer open
function loadAtxImages() {
  const now = Date.now();
  if (state.atxImgP && now - (state.atxImgAt || 0) < 120000) return state.atxImgP;
  state.atxImgAt = now;
  state.atxImgP = fetch(`${ATXFLOODS_BASE}/api/cameras`)
    .then((r) => { if (!r.ok) throw new Error(`atx HTTP ${r.status}`); return r.json(); })
    .then((d) => {
      const m = {};
      for (const c of (d.attributes || [])) {
        const im = (c.images || [])[0];
        if (im && im.image_name) m[c.id] = { name: im.image_name, at: im.created_at || '' };
      }
      return m;
    });
  state.atxImgP.catch(() => { state.atxImgP = null; state.atxImgAt = 0; }); // failed fetch — allow retry
  return state.atxImgP;
}

async function loadAtxFloodStill(c, stage, meta, gen) {
  const rec = (await loadAtxImages())[c.id];
  if (gen !== state.camGen) return; // slow list for a switched/closed viewer — drop it
  if (!rec) throw new Error('no recent imagery');
  const iso = rec.at;
  const img = document.createElement('img');
  img.alt = camTitle(c, 'atxfloods');
  img.addEventListener('load', () => {
    if (gen !== state.camGen) return;
    const stale = !!iso && ageMins(iso) > CAM_STALE_MINS;
    meta.innerHTML = (stale
      ? `<span class="cam-badge stale">⏱ ${esc(t('cam.stale'))}</span>`
      : `<span class="cam-badge still">${esc(t('cam.snapshot'))}</span>`) +
      (iso ? `<span class="cam-time">${esc(t('cam.captured'))} ${esc(fmtWhen(iso))}</span>` : '') +
      (stale ? `<span class="cam-stale-note">${esc(t('cam.stale.note'))}</span>` : '');
  });
  img.addEventListener('error', () => {
    if (gen !== state.camGen) return;
    stage.innerHTML = `<div class="cam-fallback">${esc(t('cam.unavail'))}</div>`;
  });
  img.src = `${ATXFLOODS_BASE}/uploads/${encodeURIComponent(rec.name)}`;
  stage.innerHTML = '';
  stage.appendChild(img);
}

// newest still via a client-side S3 listing: keys sort chronologically; the trailing
// "<camId>_newest.jpg" pointer key carries no timestamp, so only ___<stamp>Z.jpg keys qualify
async function loadRiverStill(c, stage, meta, gen) {
  const pfx = `720/${c.camId}/`;
  const after = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10); // 2d back: covers UTC-midnight + slow cams, stays ≤ ~400 keys
  const url = `${HIVIS_S3}/?list-type=2&prefix=${encodeURIComponent(pfx)}` +
    `&start-after=${encodeURIComponent(`${pfx}${c.camId}___${after}T00`)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HIVIS S3 HTTP ${res.status}`);
  const xml = await res.text();
  if (gen !== state.camGen) return; // slow listing for a switched/closed viewer — drop it
  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]).filter((k) => CAM_KEY_RE.test(k));
  if (!keys.length) throw new Error('no recent imagery');
  const key = keys[keys.length - 1];
  // capture time parsed FROM THE KEY: <camId>___YYYY-MM-DDTHH-MM-SSZ.jpg
  const iso = key.slice(-24, -4).replace(/T(\d{2})-(\d{2})-(\d{2})Z/, 'T$1:$2:$3Z');
  const img = document.createElement('img');
  img.alt = camTitle(c, 'river');
  img.addEventListener('load', () => {
    if (gen !== state.camGen) return;
    const stale = ageMins(iso) > CAM_STALE_MINS;
    meta.innerHTML = (stale
      ? `<span class="cam-badge stale">⏱ ${esc(t('cam.stale'))}</span>`
      : `<span class="cam-badge still">${esc(t('cam.still'))}</span>`) +
      `<span class="cam-time">${esc(t('cam.captured'))} ${esc(fmtWhen(iso))}</span>` +
      (stale ? `<span class="cam-stale-note">${esc(t('cam.stale.note'))}</span>` : '');
  });
  img.addEventListener('error', () => {
    if (gen !== state.camGen) return;
    stage.innerHTML = `<div class="cam-fallback">${esc(t('cam.unavail'))}</div>`;
  });
  img.src = `${HIVIS_S3}/${encodeURI(key)}`;
  stage.innerHTML = '';
  stage.appendChild(img);
}

// stop/destroy the player — a closed viewer must never keep a stream open
function camViewerTeardown() {
  if (state.camHls) {
    try { state.camHls.destroy(); } catch { /* already detached */ }
    state.camHls = null;
  }
  const v = $('#cam-stage video');
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
  if (state.camObjUrl) { URL.revokeObjectURL(state.camObjUrl); state.camObjUrl = null; }
  $('#cam-stage').innerHTML = '';
  $('#cam-meta').innerHTML = '';
  $('#cam-note').innerHTML = '';
}

function closeCamViewer() {
  state.camGen = (state.camGen || 0) + 1; // late responses must not write into the hidden stage
  camViewerTeardown();
  $('#cam-viewer').hidden = true;
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
  pbRefreshCurated(); // playback may have engaged before the LSR fetch arrived
}

/* ---------- NOAA CO-OPS coastal water levels: observed vs predicted storm-surge residual ----------
   Lazy: fetched on Resources-tab open and refreshed on the data cycle only while that tab is visible.
   Per-station failures degrade to an unavailable row; a total feed failure keeps the last-good rows. */

const COOP_STATIONS = [
  { id: '8770822', name: 'Texas Point, Sabine Pass' },
  { id: '8770777', name: 'Manchester (Houston Ship Channel)' },
  { id: '8770613', name: 'Morgans Point, Barbours Cut' },
  { id: '8771013', name: 'Eagle Point, Galveston Bay' },
  { id: '8771341', name: 'Galveston Bay Entrance, North Jetty' },
  { id: '8771450', name: 'Galveston Pier 21' },
  { id: '8773037', name: 'Seadrift' },
  { id: '8773701', name: "Port O'Connor" },
  { id: '8774770', name: 'Rockport' },
  { id: '8775241', name: 'Aransas, Aransas Pass' },
];

// CO-OPS returns "YYYY-MM-DD HH:MM" naive station-local (lst_ldt); parse to epoch only for prediction-match delta math
const tideEpoch = (s) => new Date(String(s).replace(' ', 'T')).getTime();

async function fetchTideStation(s) {
  const url = (extra) => `${CONFIG.coopBase}?${extra}&station=${s.id}&datum=MLLW&time_zone=lst_ldt&units=english&format=json&application=respondertx.org`;
  try {
    const [obsR, predR] = await Promise.all([
      fetch(url('range=3&product=water_level')),
      fetch(url('date=today&product=predictions&interval=6')),
    ]);
    if (!obsR.ok || !predR.ok) throw new Error('http');
    const obs = await obsR.json();
    const pred = await predR.json();
    const data = (obs && obs.data) || [];
    const preds = (pred && pred.predictions) || [];
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
  const rows = await Promise.all(COOP_STATIONS.map(fetchTideStation));
  if (rows.some((r) => r.ok)) { state.tides = rows; state.tidesAt = Date.now(); } // keep last-good if the whole feed is down
}

// refetch unless a fetch is already in flight or we already have fresh (<90s) rows (tab-toggle spam guard)
async function loadTides() {
  if (state.tidesLoading) { renderTides(); return; }
  if (state.tides && state.tidesAt && Date.now() - state.tidesAt < 90000) { renderTides(); return; }
  state.tidesLoading = true;
  renderTides(); // paint the loading state before the network round-trip
  try { await fetchTides(); } catch { /* fetchTides already swallows per-station errors */ }
  finally { state.tidesLoading = false; renderTides(); }
}

