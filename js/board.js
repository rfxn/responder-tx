'use strict';

/* ---------- assistance requests ---------- */

function loadStore() {
  try { state.store = Object.assign({ added: [], overrides: {}, archived: [] }, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); }
  catch { state.store = { added: [], overrides: {}, archived: [] }; }
}
function saveStore() { localStorage.setItem(LS_KEY, JSON.stringify(state.store)); }

function allRequests(includeArchived = false) {
  const merged = state.seedRequests.concat(state.store.added)
    .map((r) => Object.assign({}, r, state.store.overrides[r.id] || {}));
  return includeArchived ? merged : merged.filter((r) => !state.store.archived.includes(r.id));
}

// aged cards drop out of counts, strip, SITREP, and default views — still in exports and the aged toggle
function activeRequests() { return allRequests().filter((r) => !cardAged(r)); }

function smartScore(r) {
  return (PRI_WEIGHT[r.priority] || 1) * Math.pow(0.5, ageMins(r.ts) / CONFIG.smartHalfLifeMins);
}

function sortRequests(reqs) {
  const agedLast = (a, b) => cardAged(a) - cardAged(b);
  const resolvedLast = (a, b) => (a.status === 'resolved') - (b.status === 'resolved');
  const byTs = (a, b) => new Date(b.ts) - new Date(a.ts);
  return reqs.slice().sort((a, b) => agedLast(a, b) || resolvedLast(a, b) || (
    state.sort === 'newest' ? byTs(a, b)
      : state.sort === 'priority' ? (PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || byTs(a, b))
        : smartScore(b) - smartScore(a)));
}

function requestVisible(r) {
  const f = state.filters;
  if (f.type && r.type !== f.type) return false;
  if (f.county && r.county !== f.county) return false;
  if (f.window && ageMins(r.ts) > +f.window) return false;
  if (f.dist && state.myPos && Number.isFinite(r.lat)
      && distMi(state.myPos.lat, state.myPos.lng, r.lat, r.lon) > +f.dist) return false;
  if (f.q) {
    const hay = `${shortId(r.id)} ${r.summary} ${r.details} ${r.place} ${r.county}`.toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  return true;
}

function updateFiltersBadge() {
  const f = state.filters;
  const n = ['type', 'county', 'q', 'window', 'dist'].filter((k) => f[k]).length
    + (state.sort !== 'smart' ? 1 : 0) + (state.showAged ? 1 : 0) + (state.inView ? 1 : 0);
  $('#filters-toggle').textContent = n ? `☰ Filters (${n})` : '☰ Filters';
  $('#filters-toggle').classList.toggle('on', n > 0 || !$('#req-filters').hidden);
}

// radio-speakable stable reference ("flag R-036"); local intakes hash to 3 base36 chars
function shortId(id) {
  const m = /^seed-0*(\d+)$/.exec(id);
  if (m) return `R-${m[1].padStart(3, '0')}`;
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `R-${(h % 46656).toString(36).toUpperCase().padStart(3, '0')}`;
}

// exact, complete radio-ID ("R-031" / "r031") flies the map to that card's pin and opens it.
// requires the full 3-char code so mid-typing "R-03" doesn't wobble to R-003 first.
function flyToRadioId(raw) {
  const m = /^r-?([0-9a-z]{3})$/i.exec(String(raw || '').trim());
  if (!m) return false;
  const want = `R-${m[1].toUpperCase()}`;
  const hit = allRequests().find((r) => shortId(r.id) === want);
  if (!hit || !Number.isFinite(hit.lat)) return false;
  flyOpenPopup([hit.lat, hit.lon], 12, state.reqMarkers[hit.id]);
  if (window.innerWidth <= 768) $('#map').scrollIntoView({ behavior: 'smooth' });
  return true;
}

/* ---------- map↔list sync — popup "Open in …" reveal + "In view" scoping ---------- */

// map→list reveal: switch tab, scroll the row into view, ~1.5s outline pulse
function revealInList(tab, sel) {
  const btn = document.querySelector(`.tabs button[data-tab="${tab}"]`);
  if (btn) btn.click();
  requestAnimationFrame(() => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('flash');
    void el.offsetWidth; // restart the pulse on repeat taps
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  });
}

function openInFeed(id) {
  revealInList('tab-requests', `#request-list .card[data-rid="${CSS.escape(id)}"]`);
}

function openInGaugesList(lid) {
  const sel = `#gauge-list .gauge-card[data-lid="${CSS.escape(lid)}"]`;
  // normal-category gauges hide behind the "show N gauges normal" fold — unfold before revealing
  if (!document.querySelector(sel) && !state.showNormalGauges) { state.showNormalGauges = true; renderGaugesTab(); }
  revealInList('tab-gauges', sel);
}

const IN_VIEW_KEY = 'respondertx.inview';
function setInView(on) {
  state.inView = on;
  try { sessionStorage.setItem(IN_VIEW_KEY, on ? '1' : '0'); } catch { /* private mode — chip still works this load */ }
  renderRequests();
  renderGaugesTab();
}

// while the chip is ON, list re-renders on pan/zoom are the interaction; OFF keeps the seed-hash scroll guard untouched
function initInViewSync() {
  try { state.inView = sessionStorage.getItem(IN_VIEW_KEY) === '1'; } catch { state.inView = false; }
  let tmr = null;
  state.map.on('moveend', () => {
    if (!state.inView) return;
    clearTimeout(tmr);
    tmr = setTimeout(() => { if (state.inView) { renderRequests(); renderGaugesTab(); } }, 300);
  });
}

function reqPopup(r) {
  const el = document.createElement('div');
  el.innerHTML = `<div class="popup-title">${TYPE_GLYPH[r.type] || ''} ${esc(r.type.toUpperCase())} · ${esc(r.priority)}</div>` +
    `<div>${esc(r.summary)}</div>` +
    `<div class="popup-meta">${shortId(r.id)} · ${esc(r.place)} · ${esc(r.status)} · ${esc(fmtWhen(r.ts))}</div>` +
    `<div class="popup-meta">USNG ${esc(toUSNG(r.lat, r.lon))} · ${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}</div>` +
    `<button class="popup-expand open-in-feed">${esc(t('sync.openfeed'))}</button>` +
    (r.source && r.source.url && safeUrl(r.source.url) !== '#' ? `<div class="popup-link"><a href="${esc(safeUrl(r.source.url))}" target="_blank" rel="noopener">source →</a></div>` : '');
  el.querySelector('.open-in-feed').addEventListener('click', () => openInFeed(r.id));
  return el;
}

function cutoffPopup(r) {
  const el = document.createElement('div');
  el.innerHTML = `<div class="popup-title">⛔ CUT-OFF AREA (est.)</div><div>${esc(r.summary)}</div>` +
    `<div class="popup-meta">~${r.radiusMi} mi isolation footprint · operator estimate</div>` +
    `<button class="popup-expand open-in-feed">${esc(t('sync.openfeed'))}</button>`;
  el.querySelector('.open-in-feed').addEventListener('click', () => openInFeed(r.id));
  return el;
}

function renderRequests() {
  updateFiltersBadge();
  const reqs = sortRequests(allRequests());
  const agedCount = reqs.filter(cardAged).length;
  const agedBtn = $('#flt-aged');
  agedBtn.textContent = `aged ${agedCount}`;
  agedBtn.classList.toggle('on', state.showAged);
  agedBtn.style.display = agedCount ? '' : 'none';
  const visible = reqs.filter((r) => (state.showAged || !cardAged(r)) && requestVisible(r));
  // "In view" scopes the LIST only — the map keeps every filter-passing marker (it is the filter source)
  const listed = state.inView ? visible.filter((r) => inMapView(r.lat, r.lon)) : visible;
  const ivBtn = $('#flt-inview');
  ivBtn.classList.toggle('on', state.inView);
  ivBtn.textContent = state.inView ? `${t('sync.inview')} · ${listed.length}` : t('sync.inview');
  const el = $('#request-list');
  el.innerHTML = '';

  const counties = [...new Set(reqs.map((r) => r.county))].sort();
  const cSel = $('#flt-county');
  const cur = cSel.value;
  cSel.innerHTML = `<option value="">${esc(t('feed.allcounties'))}</option>` + counties.map((c) => `<option${c === cur ? ' selected' : ''}>${esc(c)}</option>`).join('');

  for (const r of listed) {
    const div = document.createElement('div');
    div.className = `card pri-${r.priority}${cardAged(r) ? ' aged' : ''}`;
    div.dataset.rid = r.id;
    const src = r.source || {};
    // compact citation — platform name or bare domain, never the full raw URL; source.url preserved as href
    const srcUrl = src.url && safeUrl(src.url) !== '#' ? safeUrl(src.url) : '';
    const srcLabel = src.platform || hostOf(src.url) || t('card.source');
    const srcTitle = `${srcLabel}${src.handle ? ` · ${src.handle}` : ''} ↗`;
    const srcLink = srcUrl
      ? `<a class="badge src-link" href="${esc(srcUrl)}" target="_blank" rel="noopener" title="${esc(srcTitle)}">${esc(srcLabel)} ↗</a>`
      : ((src.platform || src.handle) ? `<span class="badge src-link off">${esc(`${src.platform || ''} ${src.handle || ''}`.trim())}</span>` : '');
    const isNew = state.lastSeen && new Date(r.ts).getTime() > state.lastSeen;
    const needsReverify = r.status !== 'resolved' && ageMins(r.ts) > CONFIG.staleMins;
    const hasPos = Number.isFinite(r.lat) && Number.isFinite(r.lon);
    div.innerHTML =
      `<div class="head"><span>${TYPE_GLYPH[r.type] || '📍'}</span><span class="type-chip">${esc(r.type)} · ${esc(r.priority)}</span>` +
      `<span class="sid" title="Radio reference: tap to copy">${shortId(r.id)}</span>` +
      (hasPos ? `<span class="geo-flag" title="${esc(t('sync.geoflag.title'))}">📍</span>` : '') +
      `<span class="when"><span class="fresh-dot ${freshClass(r.ts)}"></span> ${esc(fmtWhen(r.ts))}</span></div>` +
      `<div class="summary">${esc(r.summary)}</div>` +
      `<div class="meta">📍 ${esc(r.place)} (${esc(r.county)} Co.)${r.contact ? ` · ☎ ${esc(r.contact)}` : ''}` +
      (state.myPos && hasPos ? ` · ${distMi(state.myPos.lat, state.myPos.lng, r.lat, r.lon).toFixed(1)} mi` : '') + '</div>' +
      (r.details ? `<div class="meta" style="margin-top:3px">${esc(r.details)}</div>` : '') +
      `<div class="badges">${isNew ? '<span class="badge new-chip">NEW</span>' : ''}` +
      (r.status !== 'open' ? `<span class="badge status-${esc(r.status)}">${esc(r.status)}</span>` : '') +
      (cardAged(r) ? '<span class="badge aged-chip">aged · suppressed</span>' : (needsReverify ? '<span class="badge reverify">stale · re-verify</span>' : '')) +
      srcBadge('curated') + srcLink +
      '</div>' +
      (hasPos ? '<div class="card-actions">' +
        `<button class="act-btn nav-act" type="button">🧭 ${esc(t('card.nav'))}</button>` +
        `<button class="act-btn copy-act" type="button">📋 ${esc(t('card.copy'))}</button>` +
        '</div>' : '');
    div.addEventListener('click', (ev) => {
      if (ev.target.closest('a')) return;
      if (ev.target.classList.contains('sid')) {
        copyText(shortId(r.id)).then(() => { ev.target.textContent = 'copied ✓'; setTimeout(() => { ev.target.textContent = shortId(r.id); }, 1200); });
        return;
      }
      if (ev.target.closest('.nav-act')) { window.open(`https://maps.google.com/?q=${r.lat},${r.lon}`, '_blank', 'noopener'); return; }
      const copyBtn = ev.target.closest('.copy-act');
      if (copyBtn) {
        copyText(`${r.lat}, ${r.lon} · USNG ${toUSNG(r.lat, r.lon)}`).then(() => { copyBtn.textContent = t('card.copied'); setTimeout(() => { copyBtn.textContent = `📋 ${t('card.copy')}`; }, 1500); });
        return;
      }
      if (hasPos) {
        flyOpenPopup([r.lat, r.lon], 12, state.reqMarkers[r.id]);
        document.querySelectorAll('.card.selected').forEach((c) => c.classList.remove('selected'));
        div.classList.add('selected');
        // phone layout: the map is above the scrolled list — make the pan visible
        if (window.innerWidth <= 768) $('#map').scrollIntoView({ behavior: 'smooth' });
      }
    });
    el.appendChild(div);
  }
  if (!listed.length) el.innerHTML = `<div class="card">${esc(t('feed.empty'))}</div>`;

  state.layers.requests.clearLayers();
  state.reqMarkers = {};
  for (const r of visible) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon)) continue;
    const resolved = r.status === 'resolved';
    if (r.type === 'cutoff' && r.radiusMi > 0 && !resolved) {
      state.layers.requests.addLayer(L.circle([r.lat, r.lon], {
        radius: r.radiusMi * 1609.34, className: 'cutoff-circle', weight: 2, fillOpacity: 0.07,
      }).bindPopup(() => cutoffPopup(r)));
    }
    const icon = L.divIcon({
      className: '',
      html: `<div class="req-icon pri-${esc(r.priority)}${resolved ? ' resolved' : ''}">${TYPE_GLYPH[r.type] || '📍'}</div>`,
      iconSize: [26, 26], iconAnchor: [4, 26],
    });
    const m = L.marker([r.lat, r.lon], { icon });
    m.bindPopup(() => reqPopup(r));
    state.layers.requests.addLayer(m);
    state.reqMarkers[r.id] = m;
  }

  const open = reqs.filter((r) => !cardAged(r) && r.status !== 'resolved');
  $('#requests-count').textContent = open.length;
  renderTiles();
}

// Nominatim forward-geocode — shared by the curator intake form, the address risk-check,
// and the header search. The address stays on-device: only this one geocode call leaves
// the browser; nothing is logged.
async function nominatimSearchN(q, n) {
  const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${n}&countrycodes=us&q=${encodeURIComponent(q)}`);
  const hits = await res.json();
  return hits.map((h) => ({ lat: +h.lat, lon: +h.lon, label: h.display_name || '' }));
}
async function nominatimSearch(q) {
  return (await nominatimSearchN(q, 1))[0] || null;
}

async function geocodePlace() {
  const place = $('#f-place').value.trim();
  if (!place) { $('#f-latlon').value = 'enter a place name first'; return; }
  const county = $('#f-county').value.trim();
  const q = `${place}${county ? `, ${county} County` : ''}, Texas`;
  $('#f-latlon').value = 'looking up…';
  try {
    const hit = await nominatimSearch(q);
    if (!hit) { $('#f-latlon').value = 'not found, click the map instead'; return; }
    state.pendingLatLng = L.latLng(hit.lat, hit.lon);
    $('#f-latlon').value = `${hit.lat.toFixed(4)}, ${hit.lon.toFixed(4)} (geocoded, verify)`;
    state.map.setView(state.pendingLatLng, 12);
  } catch { $('#f-latlon').value = 'lookup failed, click the map instead'; }
}

function submitRequest(ev) {
  ev.preventDefault();
  const ll = state.pendingLatLng;
  const r = {
    id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    ts: new Date().toISOString(),
    type: $('#f-type').value,
    priority: $('#f-priority').value,
    status: 'open',
    county: $('#f-county').value.trim() || 'Unknown',
    place: $('#f-place').value.trim(),
    lat: ll ? +ll.lat.toFixed(5) : NaN,
    lon: ll ? +ll.lng.toFixed(5) : NaN,
    radiusMi: parseFloat($('#f-radius').value) || null,
    summary: $('#f-summary').value.trim(),
    details: $('#f-details').value.trim(),
    source: { platform: $('#f-source').value, handle: $('#f-handle').value.trim(), url: $('#f-url').value.trim() },
    contact: $('#f-contact').value.trim(),
  };
  if (!r.summary || !r.place) { alert('Summary and place are required.'); return; }
  if (Number.isFinite(r.lat)) {
    const dup = allRequests().find((x) => x.status !== 'resolved' && x.type === r.type
      && Number.isFinite(x.lat) && distMi(x.lat, x.lon, r.lat, r.lon) < 3);
    if (dup) {
      const dist = distMi(dup.lat, dup.lon, r.lat, r.lon).toFixed(1);
      if (!confirm(`Possible duplicate: same type ${dist} mi away (${dup.status}):\n"${dup.summary.slice(0, 100)}"\n\nAdd anyway?`)) return;
    }
  }
  state.store.added.push(r);
  saveStore();
  ev.target.reset();
  state.pendingLatLng = null;
  $('#new-request-form').classList.remove('open');
  renderRequests();
}

/* ---------- "Am I at risk?" address check + saved my-places (client-only, no PII) ---------- */

const PLACES_KEY = 'respondertx.places';
const RISK_GAUGE_MI = 15; // nearest-gauge search radius
const RISK_NEAR_MI = 6;   // "within a few mi" for road/cutoff notices
const SEV_ORDER = ['emergency', 'warning', 'watch', 'advisory'];

function loadPlaces() {
  try { return JSON.parse(localStorage.getItem(PLACES_KEY)) || []; } catch { return []; }
}
function savePlaces(arr) {
  try { localStorage.setItem(PLACES_KEY, JSON.stringify(arr.slice(0, 12))); } catch { /* quota — saved places are best-effort */ }
}
function addPlace(p) {
  const arr = loadPlaces().filter((x) => distMi(x.lat, x.lon, p.lat, p.lon) > 0.2);
  arr.unshift(p);
  savePlaces(arr);
  renderSavedPlaces();
}
function removePlace(idx) {
  const arr = loadPlaces();
  arr.splice(idx, 1);
  savePlaces(arr);
  renderSavedPlaces();
}
function renderSavedPlaces() {
  const el = $('#risk-saved');
  const arr = loadPlaces();
  if (!arr.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="rs-title">${esc(t('risk.saved.title'))}</div>` +
    arr.map((p, i) => `<span class="rs-chip"><button class="rs-go" data-i="${i}">🏠 ${esc(p.label)}</button><button class="rs-x" data-i="${i}" title="${esc(t('risk.saved.remove'))}" aria-label="${esc(t('risk.saved.removearia'))}">✕</button></span>`).join('');
  el.querySelectorAll('.rs-go').forEach((b) => b.addEventListener('click', () => {
    const p = loadPlaces()[+b.dataset.i];
    if (p) { $('#risk-addr').value = p.label; runRiskCheck(p.lat, p.lon, p.label); }
  }));
  el.querySelectorAll('.rs-x').forEach((b) => b.addEventListener('click', () => removePlace(+b.dataset.i)));
}

function openRiskCheck() {
  $('#risk-modal').hidden = false;
  renderSavedPlaces();
  const inp = $('#risk-addr');
  inp.focus();
  inp.select();
}

function placeLabel(typed, hit) {
  const t = typed.trim();
  if (t.length <= 42) return t;
  return (hit.label || t).split(',').slice(0, 2).join(',').trim();
}

async function runRiskFromInput() {
  const raw = $('#risk-addr').value.trim();
  if (!raw) return;
  const out = $('#risk-result');
  out.innerHTML = `<div class="risk-card"><div class="risk-quiet">${esc(t('risk.looking'))}</div></div>`;
  // bias to the board's AO when no state is named; the query is never stored or transmitted beyond this geocode
  const q = /\b(tx|texas)\b/i.test(raw) ? raw : `${raw}, Texas`;
  try {
    const hit = await nominatimSearch(q);
    if (!hit) { out.innerHTML = `<div class="risk-card"><div class="risk-quiet">${esc(t('risk.notfound'))}</div></div>`; return; }
    runRiskCheck(hit.lat, hit.lon, placeLabel(raw, hit));
  } catch { out.innerHTML = `<div class="risk-card"><div class="risk-quiet">${esc(t('risk.lookupfail'))}</div></div>`; }
}

function dropRiskPin(lat, lon, label) {
  if (state.riskMarker) state.map.removeLayer(state.riskMarker);
  state.riskMarker = L.marker([lat, lon], {
    icon: L.divIcon({ className: '', html: `<div class="risk-pin"><div class="risk-pin-dot"></div><div class="risk-pin-label">${esc(t('risk.pinlabel'))}</div></div>`, iconSize: [40, 46], iconAnchor: [20, 40] }),
    title: label || t('risk.pintitle'), zIndexOffset: 2100,
  }).addTo(state.map);
  state.map.setView([lat, lon], 12);
}

function nearestGauges(lat, lon, maxMi, n) {
  return state.gauges
    .filter((g) => Number.isFinite(g.latitude) && Number.isFinite(g.longitude))
    .map((g) => ({ g, dist: distMi(lat, lon, g.latitude, g.longitude) }))
    .filter((x) => x.dist <= maxMi)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, n);
}
function nearestCrossing(lat, lon, maxMi) {
  return (state.crossings || [])
    .filter((c) => c.status !== 'open' && Number.isFinite(c.lat) && Number.isFinite(c.lon))
    .map((c) => ({ c, dist: distMi(lat, lon, c.lat, c.lon) }))
    .filter((x) => x.dist <= maxMi)
    .sort((a, b) => a.dist - b.dist)[0] || null;
}
function nearestNotice(lat, lon, maxMi) {
  return activeRequests()
    .filter((r) => r.status !== 'resolved' && (r.type === 'cutoff' || r.type === 'road')
      && Number.isFinite(r.lat) && Number.isFinite(r.lon))
    .map((r) => ({ r, dist: distMi(lat, lon, r.lat, r.lon) }))
    .filter((x) => x.dist <= maxMi)
    .sort((a, b) => a.dist - b.dist)[0] || null;
}
// point-in-bbox (with small pad) against the alert polygon/zone bounds — "contains or is near"
function alertNearPoint(f, lat, lon) {
  const geom = f.geometry || (f.properties.affectedZones || []).map((z) => state.zoneGeomCache.get(z)).find(Boolean);
  if (!geom) return false;
  try {
    const gb = L.geoJSON(geom).getBounds();
    const pad = 0.05;
    return lat >= gb.getSouth() - pad && lat <= gb.getNorth() + pad
      && lon >= gb.getWest() - pad && lon <= gb.getEast() + pad;
  } catch { return false; }
}

function riskGaugeLine(x) {
  const { g, dist } = x;
  const stale = gaugeObsStale(g);
  const cat = gaugeObsCat(g);
  const fCat = gaugeForecastCat(g);
  const f = g.status.forecast;
  const o = g.status.observed;
  const tr = stale ? null : gaugeTrend(g.lid);
  const trendBit = tr ? ` · ${tr.dir === 'up' ? '↑ rising' : tr.dir === 'down' ? '↓ falling' : '→ steady'} ${tr.rate >= 0 ? '+' : ''}${tr.rate.toFixed(1)} ft/hr` : '';
  const fcst = fCat
    ? `<div class="rg-fcst">${gaugeRising(g) ? '▲ ' : ''}Forecast crest ${fmtNum(f.primary)} ${esc(f.primaryUnit)} · <span style="color:var(--cat-${fCat})">${esc(catLabel(fCat))}</span> · ${esc(fmtWhen(f.validTime))}</div>`
    : '';
  return `<button class="risk-gauge" data-lid="${esc(g.lid)}">` +
    `<div class="rg-top"><span class="rg-name">${esc(g.name)}</span><span class="rg-dist">${dist.toFixed(1)} ${esc(t('risk.mi'))}</span></div>` +
    `<div class="rg-now">${esc(t('risk.now'))} ${fmtNum(o.primary)} ${esc(o.primaryUnit)} · <span style="color:var(--cat-${stale ? 'none' : cat})">${esc(catLabel(cat))}</span>${trendBit}</div>` +
    (stale ? `<div class="rg-now stale-note">⏱ STALE: no current data (last obs ${esc(fmtWhen(o.validTime))})</div>` : '') +
    fcst + '</button>';
}

// one derived line — never invents; each clause restates data already shown above.
// connectives localize; embedded feed data (event names, rivers) stays English.
function riskOverallRead(nearAlerts, gauges, xCross, nNotice) {
  const mi = t('risk.mi');
  const parts = [];
  if (nearAlerts.length) {
    const worst = nearAlerts.slice().sort((a, b) => SEV_ORDER.indexOf(a._sev) - SEV_ORDER.indexOf(b._sev))[0];
    parts.push(`${worst.properties.event}${worst._sev === 'emergency' ? `: ${t('risk.read.emerg')}` : ''} ${t('risk.read.covers')}`);
  }
  if (gauges.length) {
    const { g, dist } = gauges[0];
    const nearStale = gaugeObsStale(g);
    let s = `${t('risk.read.nearest')} ${riverOf(g.name)} (${dist.toFixed(1)} ${mi}) ${t('risk.read.is')} ${catLabel(gaugeObsCat(g))}${nearStale ? ` (stale, last obs ${fmtWhen(g.status.observed.validTime).split(' · ')[0]})` : ''}`;
    if (gaugeRising(g)) s += ` ${t('risk.read.forecast')} ${catLabel(gaugeForecastCat(g))} ${fmtWhen(g.status.forecast.validTime)}`;
    parts.push(s);
  } else {
    parts.push(`${t('risk.read.nogauge')} ${RISK_GAUGE_MI} ${mi}`);
  }
  if (xCross) parts.push(`${t('risk.read.crosspre')} ${t('xword.' + xCross.c.status)} ${t('risk.read.crosspost')} ${xCross.dist.toFixed(1)} ${mi}`);
  if (nNotice) parts.push(`${t('risk.read.noticepre')} ${t('ntype.' + nNotice.r.type)} ${t('risk.read.noticepost')} ${nNotice.dist.toFixed(1)} ${mi}`);
  const line = parts.join('; ');
  return line.charAt(0).toUpperCase() + line.slice(1) + '.';
}

// shared computation — the address modal and the map point inspector both consume this
function riskAssess(lat, lon) {
  const gauges = nearestGauges(lat, lon, RISK_GAUGE_MI, 3);
  const nearAlerts = state.alerts.filter((f) => alertNearPoint(f, lat, lon));
  const xCross = nearestCrossing(lat, lon, 12);
  const nNotice = nearestNotice(lat, lon, RISK_NEAR_MI);
  return { gauges, nearAlerts, xCross, nNotice, read: riskOverallRead(nearAlerts, gauges, xCross, nNotice) };
}

function runRiskCheck(lat, lon, label) {
  dropRiskPin(lat, lon, label);
  const { gauges, nearAlerts, xCross, nNotice, read } = riskAssess(lat, lon);

  const mi = t('risk.mi');
  let html = '<div class="risk-card">';
  html += `<div class="risk-place"><span class="rp-pin">🏠</span><span class="rp-label">${esc(label)}</span>` +
    `<button class="rp-save" title="${esc(t('risk.save.title'))}">${esc(t('risk.save'))}</button></div>`;
  html += `<div class="risk-read">${esc(read)}</div>`;

  if (nearAlerts.length) {
    html += `<div class="risk-sec"><div class="risk-sec-t">${esc(nearAlerts.length > 1 ? t('risk.sec.alertsN') : t('risk.sec.alerts1'))}</div>`;
    for (const f of nearAlerts.slice(0, 3)) {
      html += `<div class="risk-alert sev-${f._sev}"><strong>${esc(f.properties.event)}</strong>` +
        `<div class="ra-area">${esc(f.properties.areaDesc || '')}</div>` +
        `<div class="ra-meta">${esc(t('risk.until'))} ${esc(fmtWhen(f.properties.expires))}</div></div>`;
    }
    html += '</div>';
  } else {
    html += `<div class="risk-sec"><div class="risk-quiet">${t('risk.noalert')}</div></div>`;
  }

  html += `<div class="risk-sec"><div class="risk-sec-t">${esc(t('risk.sec.gauges'))} ${RISK_GAUGE_MI} ${esc(mi)}</div>`;
  if (gauges.length) html += gauges.map(riskGaugeLine).join('');
  else html += `<div class="risk-quiet">${esc(t('risk.read.nogauge'))} ${RISK_GAUGE_MI} ${esc(mi)}; ${t('risk.nogauge')}</div>`;
  html += '</div>';

  html += `<div class="risk-sec"><div class="risk-sec-t">${t('risk.sec.roads')}</div>`;
  if (xCross) {
    const st = CROSSING_STATUS[xCross.c.status];
    html += `<div class="risk-road"><span style="color:${st.color}">${st.glyph} ${st.label}</span>: ${esc(xCross.c.name)} <span class="rr-dist">${xCross.dist.toFixed(1)} ${esc(mi)}</span></div>`;
  }
  if (nNotice) {
    html += `<div class="risk-road"><span>${TYPE_GLYPH[nNotice.r.type] || '🚧'} ${esc(nNotice.r.type)}</span>: ${esc(nNotice.r.summary.slice(0, 90))} <span class="rr-dist">${nNotice.dist.toFixed(1)} ${esc(mi)}</span></div>`;
  }
  if (!xCross && !nNotice) html += `<div class="risk-quiet">${esc(t('risk.noroad'))}</div>`;
  html += `<div class="risk-tip">${esc(t('risk.tip'))}</div>`;
  html += '</div>';

  html += '</div>';
  const out = $('#risk-result');
  out.innerHTML = html;
  out.querySelectorAll('.risk-gauge').forEach((b) => b.addEventListener('click', () => {
    const g = state.gauges.find((x) => x.lid === b.dataset.lid);
    if (g) { $('#risk-modal').hidden = true; focusGauge(g); }
  }));
  const saveBtn = out.querySelector('.rp-save');
  saveBtn.addEventListener('click', () => {
    addPlace({ label, lat: +lat.toFixed(5), lon: +lon.toFixed(5) });
    saveBtn.textContent = '★ Saved';
    saveBtn.disabled = true;
  });
}

/* ---------- point inspector — long-press (touch) / right-click via Leaflet contextmenu ---------- */

function inspectContent(lat, lon) {
  const { gauges, nearAlerts, xCross, nNotice, read } = riskAssess(lat, lon);
  const mi = t('risk.mi');
  const usng = toUSNG(lat, lon);
  const usngLbl = `USNG ${usng} 📋`;
  const div = document.createElement('div');
  div.className = 'inspect-card';
  let html = `<div class="inspect-head"><span class="inspect-t">${esc(t('inspect.title'))}</span>` +
    `<button class="inspect-x" title="${esc(t('risk.close'))}" aria-label="${esc(t('risk.close'))}">✕</button></div>`;
  // playback engaged: this card reads live data while the map shows a historical frame — say so (striplive pattern)
  if (state.pb && !state.pb.live) html += `<div class="inspect-line sev-warning">${esc(t('inspect.live'))}</div>`;
  html += `<button class="inspect-usng" title="${esc(t('inspect.copy'))}">${esc(usngLbl)}</button>`;
  html += `<div class="inspect-read">${esc(read)}</div>`;
  if (nearAlerts.length) {
    const worst = nearAlerts.slice().sort((a, b) => SEV_ORDER.indexOf(a._sev) - SEV_ORDER.indexOf(b._sev))[0];
    html += `<div class="inspect-line sev-${worst._sev}">⚠ ${esc(worst.properties.event)} · ${esc(t('risk.until'))} ${esc(fmtWhen(worst.properties.expires).split(' · ')[0])}</div>`;
  } else {
    html += `<div class="inspect-line quiet">${esc(t('inspect.noalert'))}</div>`;
  }
  if (gauges.length) {
    const { g, dist } = gauges[0];
    const stale = gaugeObsStale(g);
    const cat = gaugeObsCat(g);
    const tr = stale ? null : gaugeTrend(g.lid);
    const trendBit = tr ? ` ${tr.dir === 'up' ? '↑' : tr.dir === 'down' ? '↓' : '→'} ${tr.rate >= 0 ? '+' : ''}${tr.rate.toFixed(1)} ft/hr` : '';
    html += `<button class="inspect-line inspect-gauge" data-lid="${esc(g.lid)}">● ${esc(g.name)} · ${dist.toFixed(1)} ${esc(mi)} · ` +
      `<span style="color:var(--cat-${stale ? 'none' : cat})">${esc(catLabel(cat))}</span>${stale ? ' ⏱' : trendBit}</button>`;
  }
  if (xCross) {
    const st = CROSSING_STATUS[xCross.c.status];
    html += `<div class="inspect-line"><span style="color:${st.color}">${st.glyph} ${esc(st.label)}</span> ${esc(xCross.c.name)} · ${xCross.dist.toFixed(1)} ${esc(mi)}</div>`;
  }
  if (nNotice) {
    html += `<div class="inspect-line">${TYPE_GLYPH[nNotice.r.type] || '🚧'} ${esc(nNotice.r.summary.slice(0, 60))} · ${nNotice.dist.toFixed(1)} ${esc(mi)}</div>`;
  }
  html += `<div class="inspect-note">${esc(t('inspect.note'))}</div>`;
  div.innerHTML = html;
  const usngBtn = div.querySelector('.inspect-usng');
  usngBtn.addEventListener('click', () => {
    copyText(`${usng} · ${lat.toFixed(5)}, ${lon.toFixed(5)}`).then(
      () => { usngBtn.textContent = t('inspect.copied'); setTimeout(() => { usngBtn.textContent = usngLbl; }, 1400); },
      () => { /* clipboard denied — the string stays visible for manual copy */ });
  });
  div.querySelector('.inspect-x').addEventListener('click', () => state.map.closePopup());
  const gb = div.querySelector('.inspect-gauge');
  if (gb) gb.addEventListener('click', () => {
    const g = state.gauges.find((x) => x.lid === gb.dataset.lid);
    if (g) focusGauge(g);
  });
  return div;
}

function initPointInspector() {
  state.map.on('contextmenu', (e) => {
    // autoPan OFF: the map must never move under the pressed point (Windy's redesign mistake)
    L.popup({ autoPan: false, closeButton: false, className: 'inspect-pop', maxWidth: 300 })
      .setLatLng(e.latlng)
      .setContent(inspectContent(e.latlng.lat, e.latlng.lng))
      .openOn(state.map);
  });
}

function downloadBlob(text, mime, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');

function exportRequests() {
  downloadBlob(JSON.stringify({ exported: new Date().toISOString(), requests: allRequests(true) }, null, 2),
    'application/json', `responder-requests-${stamp()}.json`);
}

function exportGeoJSON() {
  const features = allRequests(true).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon)).map((r) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
    properties: {
      title: `${r.type.toUpperCase()} · ${r.priority} · ${r.status}`,
      description: `${r.summary}\n${r.place} (${r.county} Co.)\n${r.ts}${r.source && r.source.url ? '\n' + r.source.url : ''}`,
      type: r.type, priority: r.priority, status: r.status, ts: r.ts, id: r.id,
    },
  }));
  downloadBlob(JSON.stringify({ type: 'FeatureCollection', features }, null, 2),
    'application/geo+json', `responder-requests-${stamp()}.geojson`);
}

function importRequests(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const incoming = data.requests || [];
      const known = new Set(allRequests(true).map((r) => r.id));
      let added = 0, updated = 0;
      for (const r of incoming) {
        if (!r.id || !r.summary) continue;
        if (known.has(r.id)) {
          const cur = allRequests(true).find((x) => x.id === r.id); // include archived — `known` does, and an archived id would leave cur undefined
          if (new Date(r.ts) >= new Date(cur.ts) && r.status !== cur.status) {
            state.store.overrides[r.id] = Object.assign({}, state.store.overrides[r.id], { status: r.status });
            updated++;
          }
        } else { state.store.added.push(r); added++; }
      }
      saveStore();
      renderRequests();
      alert(`Import: ${added} new, ${updated} status updates.`);
    } catch (e) { alert(`Import failed: ${e.message}`); }
  };
  reader.readAsText(file);
}

/* ---------- SITREP ---------- */

function buildSitrep() {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const emerg = state.alerts.filter((a) => a._sev === 'emergency');
  const warnings = state.alerts.filter((a) => a._sev === 'warning').length;
  const majors = state.gauges.filter((g) => gaugeCat(g) === 'major');
  const toMajor = state.gauges.filter((g) => gaugeRising(g) && gaugeForecastCat(g) === 'major');
  const reqs = activeRequests().filter((r) => r.status !== 'resolved');
  const crit = sortRequests(reqs.filter((r) => r.priority === 'critical'));
  const cutoffs = reqs.filter((r) => r.type === 'cutoff');
  const L = [];
  L.push(`RESPONDER TX SITREP - ${now} CT`);
  L.push(`THREAT: ${emerg.length} flash flood emergencies${emerg.length ? ` (${emerg.map((a) => a.properties.areaDesc).join(' | ')})` : ''}; ${warnings} flood warnings statewide (official)`);
  L.push(`GAUGES: ${majors.length} at MAJOR, ${toMajor.length} forecast to reach major (official)`);
  for (const g of majors) {
    const tr = gaugeTrend(g.lid);
    L.push(`  MAJOR ${g.name} - ${g.status.observed.primary} ft${tr ? ` (${tr.rate >= 0 ? '+' : ''}${tr.rate.toFixed(1)} ft/hr)` : ''}`);
  }
  for (const g of toMajor) {
    const rc = recordContext(g);
    const recBit = rc ? (rc.atOrAbove ? ` [⚑ ${Math.abs(rc.margin)} ft OVER ${rc.recFt} ft record ${rc.year}]` : rc.near ? ` [⚑ ${rc.margin} ft below ${rc.recFt} ft record ${rc.year}]` : '') : '';
    L.push(`  RISING ${g.name} - fcst crest ${g.status.forecast.primary} ft ${fmtWhen(g.status.forecast.validTime)}${recBit}`);
  }
  const falling = state.gauges.filter((g) => gaugeCat(g) !== 'none' && (gaugeTrend(g.lid) || {}).dir === 'down');
  if (falling.length) L.push(`RECOVERY: ${falling.length} in-flood gauges falling (${falling.map((g) => riverOf(g.name)).slice(0, 6).join('; ')}) (official)`);
  if (cutoffs.length) L.push(`CUT-OFF AREAS: ${cutoffs.map((r) => `${r.place} (${r.county} Co.)`).join('; ')} (curated)`);
  L.push(`ACTIVE CRITICAL (${crit.length}) (curated):`);
  for (const r of crit.slice(0, 10)) {
    const pos = Number.isFinite(r.lat) ? ` [USNG ${toUSNG(r.lat, r.lon)}]` : '';
    L.push(`  [${shortId(r.id)}] [${r.type.toUpperCase()}] ${r.summary} - ${r.place}, ${r.county} Co.${pos} (${fmtWhen(r.ts).split(' · ')[0]})`);
  }
  L.push(`ACTIVE NOTICES TOTAL: ${reqs.length} (curated) · board ${APP_VERSION}`);
  L.push('Not a dispatch product. Life-threatening emergencies: 911.');
  return L.join('\n');
}

function copySitrep(btn) {
  const text = buildSitrep();
  const copy = () => copyText(text).then(
    () => { btn.textContent = 'SITREP copied ✓'; setTimeout(() => { btn.textContent = '📋 SITREP'; }, 2000); },
    () => downloadBlob(text, 'text/plain', `sitrep-${stamp()}.txt`));
  if (navigator.share) navigator.share({ title: 'Responder TX SITREP', text }).catch(copy);
  else copy();
}

/* ---------- share view — one link reproduces map, tab, and filters ---------- */

function buildShareUrl() {
  const p = new URLSearchParams();
  const c = state.map.getCenter();
  p.set('mlat', c.lat.toFixed(4));
  p.set('mlon', c.lng.toFixed(4));
  p.set('mz', String(state.map.getZoom()));
  const active = document.querySelector('.tabs button.active');
  const tab = active ? active.dataset.tab.replace(/^tab-/, '') : 'requests';
  if (tab !== 'requests') p.set('tab', tab);
  const f = state.filters;
  if (f.type) p.set('ft', f.type);
  if (f.county) p.set('fc', f.county);
  if (f.window) p.set('fw', f.window);
  if (f.dist) p.set('fd', f.dist);
  if (f.q) p.set('fq', f.q);
  if (state.sort !== 'smart') p.set('fs', state.sort);
  if ($('#flt-alert-sev').value) p.set('as', $('#flt-alert-sev').value);
  if ($('#flt-alert-q').value) p.set('aq', $('#flt-alert-q').value);
  if (state.map.hasLayer(state.layers.mrms)) p.set('rain', state.rainWindow); // rollover/share carry the rainfall window
  // non-default layer toggles travel too (set only when ON — default URLs stay short); parsed at boot
  for (const [key, lk] of [['radar', 'radar'], ['fcst', 'fcstRadar'], ['cams', 'cameras'], ['usgs', 'usgs'], ['lwc', 'lwc'], ['inun', 'inundation']]) {
    if (state.layers[lk] && state.map.hasLayer(state.layers[lk])) p.set(key, '1');
  }
  p.set('base', state.activeBase);
  p.set('theme', document.documentElement.getAttribute('data-theme'));
  return `${location.origin}${location.pathname}?${p}`;
}

function shareView(btn) {
  const url = buildShareUrl();
  const copy = () => copyText(url).then(
    () => {
      const orig = btn.innerHTML; // shared by the ⋮ menu entry and the map 🔗 control — restore whatever was there
      btn.innerHTML = btn.closest('.share-trigger') ? '✓' : '✓ Link copied';
      setTimeout(() => { btn.innerHTML = orig; }, 2000);
    },
    () => prompt('Copy this link:', url));
  if (navigator.share) navigator.share({ url }).catch(copy);
  else copy();
}

// boot-time restore: set each control the way a user would, then let its own handler re-render
function applyShareParams(q) {
  const lat = parseFloat(q.get('mlat')), lon = parseFloat(q.get('mlon')), z = parseInt(q.get('mz'), 10);
  if (Number.isFinite(lat) && Number.isFinite(lon)) state.map.setView([lat, lon], Number.isFinite(z) ? z : state.map.getZoom());
  const apply = (sel, key, evt) => {
    const val = q.get(key);
    if (val === null || val === '') return false;
    const el = $(sel);
    // county options arrive with board data — park the shared value until renderRequests rebuilds the list
    if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === val)) el.add(new Option(val, val));
    el.value = val;
    el.dispatchEvent(new Event(evt));
    return true;
  };
  const feedFiltered = [['#flt-type', 'ft', 'change'], ['#flt-county', 'fc', 'change'], ['#flt-window', 'fw', 'change'],
    ['#flt-dist', 'fd', 'change'], ['#flt-q', 'fq', 'input'], ['#flt-sort', 'fs', 'change']]
    .map(([sel, key, evt]) => apply(sel, key, evt)).some(Boolean);
  if (feedFiltered) $('#req-filters').hidden = false; // a shared filtered view must be visible, not silent
  apply('#flt-alert-sev', 'as', 'change');
  apply('#flt-alert-q', 'aq', 'input');
}

// mobile bottom-sheet: the sidebar (feed/alerts/threat) slides between peek (map-full),
// half (default split), and full (covers the map for full scroll). Handle taps cycle states.
const SHEET_STATES = ['sheet-peek', 'sheet-half', 'sheet-full'];
function setSheet(stateCls) {
  const main = document.querySelector('main');
  main.classList.remove(...SHEET_STATES);
  main.classList.add(stateCls);
  localStorage.setItem('respondertx.sheet', stateCls);
  document.querySelectorAll('#sheet-handle button').forEach((b) => b.classList.toggle('on', b.dataset.sheet === stateCls));
  if (state.map) setTimeout(() => state.map.invalidateSize(), 260); // re-tile after the height transition
}
function initSheet() {
  const param = new URLSearchParams(location.search).get('sheet'); // ?sheet=peek|half|full deep link
  const wanted = param ? `sheet-${param}` : localStorage.getItem('respondertx.sheet');
  setSheet(SHEET_STATES.includes(wanted) ? wanted : 'sheet-half');
  document.querySelectorAll('#sheet-handle button').forEach((b) =>
    b.addEventListener('click', () => setSheet(b.dataset.sheet)));
}

// persist the user's view (feed + alert filters, sort, aged toggle, active tab) across
// hard refreshes and app updates. URL share-params still win for their load (applied after).
const VIEW_KEY = 'respondertx.view';
function saveViewState() {
  try {
    const active = document.querySelector('.tabs button.active');
    localStorage.setItem(VIEW_KEY, JSON.stringify({
      ft: state.filters.type || '', fc: state.filters.county || '', fq: state.filters.q || '',
      fw: state.filters.window || '', fd: state.filters.dist || '', fs: state.sort,
      aged: state.showAged ? 1 : 0,
      as: $('#flt-alert-sev').value, aq: $('#flt-alert-q').value,
      tab: active ? active.dataset.tab : 'tab-requests',
    }));
  } catch { /* private-mode / quota — view persistence is best-effort */ }
}
function restoreViewState() {
  let v; try { v = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null'); } catch { v = null; }
  if (!v) return;
  state.filters.type = v.ft || ''; $('#flt-type').value = v.ft || '';
  state.filters.window = v.fw || ''; $('#flt-window').value = v.fw || '';
  state.filters.dist = v.fd || ''; $('#flt-dist').value = v.fd || '';
  state.filters.q = v.fq || ''; $('#flt-q').value = v.fq || '';
  state.sort = v.fs || 'smart'; $('#flt-sort').value = state.sort;
  state.showAged = !!v.aged;
  if (v.fc) { // county options arrive with board data — park the value so the select shows it
    const sel = $('#flt-county');
    if (![...sel.options].some((o) => o.value === v.fc)) sel.add(new Option(v.fc, v.fc));
    sel.value = v.fc; state.filters.county = v.fc;
  }
  $('#flt-alert-sev').value = v.as || '';
  $('#flt-alert-q').value = v.aq || '';
  if (v.ft || v.fc || v.fq || v.fw || v.fd || (v.fs && v.fs !== 'smart') || v.aged) $('#req-filters').hidden = false;
  if (v.tab && v.tab !== 'tab-requests' && /^[a-z-]+$/.test(v.tab)) {
    const btn = document.querySelector(`.tabs button[data-tab="${v.tab}"]`);
    if (btn) btn.click();
  }
}

function exportAAR() {
  const reqs = allRequests(true).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const count = (fn) => reqs.reduce((m, r) => { const k = fn(r); m[k] = (m[k] || 0) + 1; return m; }, {});
  const fmtCounts = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');
  const L = [];
  L.push(`# Responder TX - After-Action Export`);
  L.push(`Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT · board ${APP_VERSION}`);
  L.push('');
  L.push(`## Card statistics (${reqs.length} total)`);
  L.push(`- By status: ${fmtCounts(count((r) => r.status))}`);
  L.push(`- By type: ${fmtCounts(count((r) => r.type))}`);
  L.push(`- By county: ${fmtCounts(count((r) => r.county))}`);
  L.push('');
  L.push('## Chronological card log');
  for (const r of reqs) {
    const t = new Date(r.ts).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    L.push(`- **${t} CT** [${r.type}/${r.priority}/${r.status}] ${r.summary} - ${r.place} (${r.county} Co.)${r.source && r.source.url ? ` [src](${r.source.url})` : ''}`);
  }
  L.push('');
  L.push('## Situation snapshot at export');
  L.push('```');
  L.push(buildSitrep());
  L.push('```');
  downloadBlob(L.join('\n'), 'text/markdown', `responder-aar-${stamp()}.md`);
}

