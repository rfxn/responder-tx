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
    div.innerHTML = `<div class="head"><span>▲</span><span class="type-chip">${esc(CAT_LABEL[gaugeCat(g)])} → <span style="color:var(--cat-${fCat})">${esc(CAT_LABEL[fCat])}</span></span>` +
      `<span class="when">crest ${esc(fmtWhen(f.validTime))}</span></div>` +
      `<div class="summary">${esc(g.name)} — forecast crest ${fmtNum(f.primary)} ${esc(f.primaryUnit)}</div>`;
    div.addEventListener('click', () => state.map.setView([g.latitude, g.longitude], 11));
    el.appendChild(div);
  }
}

/* ---------- gauges tab — bucketed by actionability ---------- */

function focusGauge(g) {
  state.map.setView([g.latitude, g.longitude], 11);
  const mk = state.gaugeMarkers && state.gaugeMarkers[g.lid];
  if (mk) mk.openPopup();
  // phone layout: the map is above the scrolled list — make the pan visible
  if (window.innerWidth <= 768) $('#map').scrollIntoView({ behavior: 'smooth' });
}

function gaugeGlyphHtml(g) {
  if (gaugeObsStale(g)) return '<span class="stale-glyph" title="stale — no current data">⏱</span>';
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
  div.style.borderLeftColor = stale ? 'var(--cat-none)' : `var(--cat-${cat})`;
  const trendBit = tr ? ` ${tr.dir === 'up' ? '↑' : tr.dir === 'down' ? '↓' : '→'} ${tr.rate >= 0 ? '+' : ''}${tr.rate.toFixed(1)} ft/hr` : '';
  div.innerHTML = `<div class="head">${gaugeGlyphHtml(g)}<span class="g-name">${esc(g.name)}</span>` +
    `<span class="when"><a href="https://water.noaa.gov/gauges/${esc(g.lid)}" target="_blank" rel="noopener" style="color:var(--accent)">NWPS →</a></span></div>` +
    `<div class="meta">OBS ${fmtNum(o.primary)} ${esc(o.primaryUnit)} · <span class="cat-word" style="color:var(--cat-${stale ? 'none' : cat})">${cat === 'none' ? 'no flooding' : esc(cat)}</span>${trendBit}</div>` +
    (stale ? `<div class="meta stale-note">⏱ STALE — no current data (last obs ${esc(fmtWhen(o.validTime))})</div>` : '') +
    (fCat ? `<div class="meta">crest ${fmtNum(f.primary)} ${esc(f.primaryUnit)} · <span class="cat-word" style="color:var(--cat-${fCat})">${esc(fCat)}</span> · ${esc(fmtWhen(f.validTime))}</div>` : '') +
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
    return `<div class="meta record-line at"><strong>⚑ AT/ABOVE CREST OF RECORD</strong> — record ${rc.recFt} ft (${esc(rc.year)}); forecast ${Math.abs(rc.margin)} ft over</div>`;
  }
  if (rc.near) {
    return `<div class="meta record-line near">⚑ approaching crest of record — record ${rc.recFt} ft (${esc(rc.year)}); forecast ${rc.margin} ft below</div>`;
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
    body += `<div class="wave-river">${esc(river)} <span class="wave-hint">crest arrival order →</span></div>`;
    for (const g of gs) {
      const f = g.status.forecast;
      const fCat = gaugeForecastCat(g);
      const past = new Date(f.validTime).getTime() < now;
      const site = g.name.slice(riverOf(g.name).length).trim() || g.name;
      body += `<button class="wave-row" data-lid="${esc(g.lid)}">` +
        `<span class="wave-dot" style="background:var(--cat-${fCat})"></span>` +
        `<span class="wave-site">${esc(site)}</span>` +
        `<span class="wave-stage" style="color:var(--cat-${fCat})">${fmtNum(f.primary)} ft ${esc(fCat)}</span>` +
        `<span class="wave-eta ${past ? 'past' : ''}">${past ? 'crested' : 'crest'} ${esc(fmtWhen(f.validTime))}</span></button>`;
    }
  }
  const nGauges = rivers.reduce((s, [, gs]) => s + gs.length, 0);
  el.innerHTML = `<button class="wave-toggle${open ? ' open' : ''}" id="wave-toggle">` +
    `<span>${esc(t('sec.wave'))}</span>` +
    `<span class="wave-count">${rivers.length} rivers · ${nGauges} pts ${open ? '▾' : '▸'}</span></button>` +
    `<div class="wave-body"${open ? '' : ' hidden'}>${body}</div>`;
  $('#wave-toggle').addEventListener('click', () => {
    const nowOpen = $('.wave-body').hasAttribute('hidden');
    $('.wave-body').hidden = !nowOpen;
    localStorage.setItem('respondertx.waveOpen', nowOpen ? '1' : '0');
    $('#wave-toggle').classList.toggle('open', nowOpen);
    $('.wave-count').textContent = `${rivers.length} rivers · ${nGauges} pts ${nowOpen ? '▾' : '▸'}`;
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
    items.push({ glyph: st.glyph, color: st.color, name: c.name, sub: `${st.label} crossing`, lat: c.lat, lon: c.lon, rank: c.status === 'closed' ? 0 : 2 });
  }
  for (const r of activeRequests().filter((x) => x.status !== 'resolved')) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    if (!LIFE_SAFETY_TYPES.includes(r.type) && r.type !== 'road') continue;
    items.push({ glyph: TYPE_GLYPH[r.type] || '📍', color: r.priority === 'critical' ? 'var(--sev-emergency)' : 'var(--sev-warning)', name: r.summary, sub: `${r.type} · ${r.place}`, lat: r.lat, lon: r.lon, rank: r.priority === 'critical' ? 0 : 1 });
  }
  for (const g of state.gauges.filter((x) => gaugeCat(x) === 'major' || (gaugeRising(x) && gaugeForecastCat(x) === 'major'))) {
    items.push({ glyph: '●', color: 'var(--cat-major)', name: g.name, sub: gaugeCat(g) === 'major' ? 'MAJOR flood now' : 'rising to MAJOR', lat: g.latitude, lon: g.longitude, rank: 1 });
  }
  const p = state.myPos;
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
    items.push({ glyph: cond === 'Flooding' ? '🌊' : cond === 'Damage' ? '⚠' : '⛔', color: ct.color, name: `${ct.label} · ${prettyRoute(f.properties.route_name) || 'road'}`, sub: 'TxDOT DriveTexas', lat: pt[1], lon: pt[0], rank: cond === 'Damage' ? 2 : 1 });
  }
  if (p) {
    for (const it of items) { it.dist = distMi(p.lat, p.lng, it.lat, it.lon); it.brng = bearing(p.lat, p.lng, it.lat, it.lon); }
    items.sort((a, b) => a.dist - b.dist);
  } else {
    items.sort((a, b) => a.rank - b.rank);
  }
  return items.slice(0, 14);
}

function renderDriveMode() {
  if ($('#drive-mode').hidden) return;
  const emerg = state.alerts.filter((a) => a._sev === 'emergency');
  const soonest = state.gauges
    .filter((g) => gaugeRising(g) && CAT_RANK[gaugeForecastCat(g)] >= CAT_RANK.moderate && new Date(g.status.forecast.validTime) > new Date())
    .sort((a, b) => new Date(a.status.forecast.validTime) - new Date(b.status.forecast.validTime))[0];
  $('#drive-threat').innerHTML =
    (emerg.length ? `<div class="dt-emerg">⚠ ${emerg.length} ${esc(t('drive.emerg'))} — ${esc(emerg.map((a) => a.properties.areaDesc).join('; '))}</div>` : '') +
    (soonest ? `<div class="dt-crest">${esc(t('drive.nextcrest'))} ${esc(riverOf(soonest.name))} ${esc(fmtWhen(soonest.status.forecast.validTime))}</div>` : '') +
    (state.myPos ? '' : `<div class="dt-nogps">${esc(t('drive.nogps'))}</div>`);
  const items = driveItems();
  $('#drive-list').innerHTML = items.length ? items.map((it) => {
    const distBit = it.dist != null ? `<span class="d-dist">${it.dist.toFixed(1)} ${esc(t('risk.mi'))} ${it.brng}</span>` : '';
    return `<button class="drive-row" data-lat="${it.lat}" data-lon="${it.lon}">` +
      `<span class="d-glyph" style="color:${it.color}">${it.glyph}</span>` +
      `<span class="d-body"><span class="d-name">${esc(it.name)}</span><span class="d-sub">${esc(it.sub)}</span></span>${distBit}</button>`;
  }).join('') : `<div class="dt-nogps">${esc(t('drive.nohaz'))}</div>`;
  $('#drive-list').querySelectorAll('.drive-row').forEach((b) => b.addEventListener('click', () => {
    $('#drive-mode').hidden = true;
    state.map.setView([+b.dataset.lat, +b.dataset.lon], 13);
  }));
}

function renderGaugesTab() {
  renderWave();
  const el = $('#gauge-list');
  if (!el) return;
  const inFlood = state.gauges.filter((g) => gaugeCat(g) !== 'none');
  const badge = $('#gauges-count');
  badge.textContent = inFlood.length;
  badge.classList.toggle('sev', inFlood.some((g) => gaugeCat(g) === 'major'));

  // double-listing precedence: rising wins, then falling, then in-flood
  const rising = state.gauges.filter(gaugeRising)
    .sort((a, b) => new Date(a.status.forecast.validTime) - new Date(b.status.forecast.validTime));
  const risingLids = new Set(rising.map((g) => g.lid));
  const inFloodOnly = inFlood.filter((g) => !risingLids.has(g.lid));
  const falling = inFloodOnly.filter((g) => (gaugeTrend(g.lid) || {}).dir === 'down');
  const fallingLids = new Set(falling.map((g) => g.lid));
  const holding = inFloodOnly.filter((g) => !fallingLids.has(g.lid))
    .sort((a, b) => CAT_RANK[gaugeCat(b)] - CAT_RANK[gaugeCat(a)] || b.status.observed.primary - a.status.observed.primary);
  const normal = state.gauges.filter((g) => gaugeCat(g) === 'none' && !risingLids.has(g.lid))
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
      ? `${state.showNormalGauges ? '▾ hide' : '▸ show'} ${normal.length} gauges — ${normal.length - normalStale} normal · ${normalStale} stale`
      : `${state.showNormalGauges ? '▾ hide' : '▸ show'} ${normal.length} gauges normal`;
    btn.addEventListener('click', () => { state.showNormalGauges = !state.showNormalGauges; renderGaugesTab(); });
    el.appendChild(btn);
    if (state.showNormalGauges) for (const g of normal) el.appendChild(gaugeCardDiv(g));
  }
}

/* ---------- resources & monitors ---------- */

function renderResources() {
  const r = state.resources;
  if (!r) return;
  const el = $('#resources-body');
  el.innerHTML = `<div class="section-title">${esc(t('res.shelters'))}</div>` +
    r.shelters.map((s) => `<div class="resource-item"><strong>${esc(s.name)}</strong><div class="addr">${esc(s.address)} · ${esc(s.county)} Co. — ${esc(s.note)} <a href="${esc(safeUrl(s.source))}" target="_blank" rel="noopener">src</a></div></div>`).join('') +
    `<div class="section-title">${esc(t('res.hotlines'))}</div>` +
    r.hotlines.map((h) => `<div class="resource-item"><strong>${esc(h.value)}</strong> — ${esc(h.name)}<div class="addr">${esc(h.note)}</div></div>`).join('') +
    `<div class="section-title">${esc(t('res.data'))}</div>` +
    r.dataLinks.map((d) => `<div class="resource-item"><a href="${esc(safeUrl(d.url))}" target="_blank" rel="noopener">${esc(d.label)}</a></div>`).join('') +
    `<div class="section-title">${esc(t('res.follow'))}</div>` +
    `<div class="resource-item"><a href="feed.xml" target="_blank" rel="noopener">${esc(t('res.rss'))}</a> — ${esc(t('res.rss.note'))}</div>` +
    `<div class="resource-item"><a href="crests.ics" target="_blank" rel="noopener">${esc(t('res.ics'))}</a> — ${esc(t('res.ics.note'))}</div>`;

  state.layers.shelters.clearLayers();
  for (const s of r.shelters) {
    const icon = L.divIcon({ className: '', html: '<div class="shelter-icon">🏠</div>', iconSize: [24, 24] });
    const m = L.marker([s.lat, s.lon], { icon });
    m.bindPopup(`<div class="popup-title">🏠 ${esc(s.name)}</div><div class="popup-meta">${esc(s.address)}</div><div>${esc(s.note)}</div><div class="popup-meta">Location approximate — confirm before routing.</div>`);
    state.layers.shelters.addLayer(m);
  }
}

function monitorGroupHtml(g) {
  return `<div class="monitor-group"><div class="section-title">${esc(g.group)}</div>` +
    (g.note ? `<div class="resource-item" style="border-bottom:none;font-size:12px;color:var(--ink-2)">${esc(g.note)}</div>` : '') +
    g.links.map((l) => `<a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">↗ ${esc(l.label)}</a>`).join('') + '</div>';
}

function renderMonitors() {
  const el = $('#monitor-body');
  el.innerHTML = `<div class="section-title">${esc(t('mon.social'))}</div>` +
    state.resources.monitors.map(monitorGroupHtml).join('') +
    `<div class="section-title">${esc(t('mon.comms'))}</div>` +
    (state.resources.comms || []).map(monitorGroupHtml).join('') +
    `<div class="section-title">${esc(t('mon.workflow.head'))}</div>` +
    '<div class="resource-item">1. Sweep each search every 15–30 min. 2. For actionable posts, tap “＋ New notice”, click the map to drop the pin, paste the post URL as source. 3. Verify (cross-reference official channels or call back) before tasking. 4. Anything life-threatening → relay to 911/EOC immediately; this board does not dispatch.</div>';
}

/* ---------- threat-to-life strip ---------- */

function fitTo(latlngs) {
  if (latlngs.length) state.map.fitBounds(L.latLngBounds(latlngs).pad(0.25), { maxZoom: 10 });
}

function renderThreatStrip() {
  const el = $('#threat-strip');
  const reqs = activeRequests().filter((r) => r.status !== 'resolved');
  const emergencies = state.alerts.filter((a) => a._sev === 'emergency').length;
  const lifeReqs = reqs.filter((r) => r.priority === 'critical' && LIFE_SAFETY_TYPES.includes(r.type) && r.type !== 'cutoff');
  const cutoffs = reqs.filter((r) => r.type === 'cutoff');
  const roads = reqs.filter((r) => r.type === 'road');
  const majors = state.gauges.filter((g) => gaugeCat(g) === 'major');
  const toMajor = state.gauges.filter((g) => gaugeRising(g) && gaugeForecastCat(g) === 'major');
  const chips = [
    { n: emergencies, cls: 'emergency', label: t('threat.ffemerg'), glyph: '⚠', act: () => document.querySelector('.tabs button[data-tab="tab-alerts"]').click() },
    { n: lifeReqs.length, cls: 'emergency', label: t('threat.life'), glyph: '🆘', act: () => fitTo(lifeReqs.filter((r) => Number.isFinite(r.lat)).map((r) => [r.lat, r.lon])) },
    { n: cutoffs.length, cls: 'emergency', label: t('threat.cutoff'), glyph: '⛔', act: () => fitTo(cutoffs.filter((r) => Number.isFinite(r.lat)).map((r) => [r.lat, r.lon])) },
    { n: majors.length, cls: 'major', label: t('threat.major'), glyph: '●', act: () => fitTo(majors.map((g) => [g.latitude, g.longitude])) },
    { n: toMajor.length, cls: 'major', label: t('threat.tomajor'), glyph: '▲', act: () => fitTo(toMajor.map((g) => [g.latitude, g.longitude])) },
    (() => { const rw = recordWatchGauges(); return { n: rw.length, cls: rw.some((g) => recordContext(g).atOrAbove) ? 'emergency' : 'major', label: t('threat.record'), glyph: '⚑', act: () => { fitTo(rw.map((g) => [g.latitude, g.longitude])); document.querySelector('.tabs button[data-tab="tab-gauges"]').click(); } }; })(),
    { n: roads.length, cls: 'warn', label: t('threat.roads'), glyph: '🚧', act: () => fitTo(roads.filter((r) => Number.isFinite(r.lat)).map((r) => [r.lat, r.lon])) },
    {
      n: state.gauges.filter((g) => gaugeCat(g) !== 'none' && (gaugeTrend(g.lid) || {}).dir === 'down').length,
      cls: 'good', label: t('threat.falling'), glyph: '▼',
      act: () => fitTo(state.gauges.filter((g) => gaugeCat(g) !== 'none' && (gaugeTrend(g.lid) || {}).dir === 'down').map((g) => [g.latitude, g.longitude])),
    },
  ].filter((c) => c.n > 0);
  if (!chips.length) {
    el.innerHTML = state.alertsLoadedOnce
      ? `<div class="strip-ok"><span class="ok-line">${esc(t('threat.okline'))}</span><span class="ok-sub">${esc(t('threat.oksub'))}</span></div>`
      : '';
    return;
  }
  el.innerHTML = '';
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
    b.innerHTML = `<span class="glyph">${c.glyph}</span><span class="num">${c.n}</span><span class="lbl">${esc(c.label)}</span>`;
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
      b.title = 'Open Alerts tab';
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
    emerg.push({ text: `⚠ FF EMERGENCY ${where} — until ${until}`, color: 'var(--sev-emergency)', act: goAlerts });
  }
  const rising = state.gauges.filter((g) => gaugeRising(g) && CAT_RANK[gaugeForecastCat(g)] >= CAT_RANK.minor)
    .sort((a, b) => new Date(a.status.forecast.validTime) - new Date(b.status.forecast.validTime));
  for (const g of rising) {
    const fCat = gaugeForecastCat(g);
    rise.push({ text: `▲ ${riverOf(g.name)} → ${fCat.toUpperCase()} crest ${relWhen(g.status.forecast.validTime)}`, color: `var(--cat-${fCat})`, act: () => focusGauge(g) });
  }
  for (const g of state.gauges.filter((x) => gaugeCat(x) === 'major' && !gaugeRising(x))) {
    const tr = gaugeTrend(g.lid);
    const trendBit = tr ? ` ${tr.rate >= 0 ? '+' : ''}${tr.rate.toFixed(1)} ft/hr` : '';
    majors.push({ text: `● ${riverOf(g.name)} MAJOR ${fmtNum(g.status.observed.primary)} ft${trendBit}`, color: 'var(--cat-major)', act: () => focusGauge(g) });
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
    ? `${inFlood.length} <span class="unit">${major} major · ▲${rising}</span>`
    : '– <span class="unit">no data</span>';
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
    markHealthy('seeds');
    state.seedRequests = reqs.requests || [];
    state.resources = res;
    // hash = content + per-card aging fingerprint: identical seeds skip the re-render (scroll guard),
    // but aged/stale/fresh-bucket transitions on idle clients still repaint list, tiles, and crossings
    const agingFp = allRequests().map((r) => [r.id, cardAged(r) ? 1 : 0, r.status !== 'resolved' && ageMins(r.ts) > CONFIG.staleMins ? 1 : 0, freshClass(r.ts)]);
    const crossingFp = state.crossings.map((c) => (c.updated_at ? (Date.now() - new Date(c.updated_at).getTime()) / 3600000 : Infinity) > CROSSING_STALE_H ? 1 : 0);
    const hash = JSON.stringify([reqs, res, state.crossings, agingFp, crossingFp]);
    if (hash === state.seedHash) return true;  // unchanged — don't reset operator's scroll
    state.seedHash = hash;
    renderRequests();
    renderResources();
    renderCrossings();
    renderMonitors();
    return true;
  } catch { return false; }
}

const CROSSING_STALE_H = 12;
const CROSSING_STATUS = {
  closed: { color: 'var(--sev-emergency)', glyph: '⛔', label: 'CLOSED' },
  caution: { color: 'var(--cat-action)', glyph: '⚠', label: 'CAUTION' },
  longterm: { color: 'var(--ink-muted)', glyph: '⛔', label: 'LONG-TERM CLOSED' },
  open: { color: 'var(--good)', glyph: '✓', label: 'OPEN' },
};
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
          const stale = staleH > CROSSING_STALE_H ? ` · <span class="xg-stale">stale ${Math.round(staleH)}h — reverify</span>` : '';
          return `<div class="resource-item"><strong style="color:${st.color}">${st.glyph} ${st.label}</strong> — ${esc(c.name)}` +
            `<div class="addr">${esc(c.reason || '')} · updated ${esc(fmtWhen(c.updated_at))}${stale}${c.source && safeUrl(c.source) !== '#' ? ` <a href="${esc(safeUrl(c.source))}" target="_blank" rel="noopener">src</a>` : ''}</div></div>`;
        }).join('') +
        `<div class="resource-item" style="border:none"><a href="https://drivetexas.org/" target="_blank" rel="noopener">${esc(t('cross.drivetx'))}</a></div>`
      : '';
  }
  for (const c of list) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon) || !layer) continue;
    const st = CROSSING_STATUS[c.status] || CROSSING_STATUS.caution;
    const icon = L.divIcon({ className: '', html: `<div class="crossing-icon" style="border-color:${st.color};color:${st.color}">${st.glyph}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
    const m = L.marker([c.lat, c.lon], { icon });
    m.bindPopup(`<div class="popup-title" style="color:${st.color}">${st.glyph} ${st.label} — crossing</div><div>${esc(c.name)}</div>` +
      `<div class="popup-meta">${esc(c.reason || '')}</div>` +
      `<div class="popup-meta">Updated ${esc(fmtWhen(c.updated_at))} · verify before routing</div>` +
      (c.source && safeUrl(c.source) !== '#' ? `<div class="popup-link"><a href="${esc(safeUrl(c.source))}" target="_blank" rel="noopener">source →</a></div>` : ''));
    layer.addLayer(m);
  }
}

