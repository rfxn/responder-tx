'use strict';

/* ---------- assistance requests ---------- */

function loadStore() {
  try { state.store = Object.assign({ added: [], overrides: {}, archived: [] }, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); }
  catch { state.store = { added: [], overrides: {}, archived: [] }; }
}
function saveStore() { localStorage.setItem(LS_KEY, JSON.stringify(state.store)); }

function allRequests(includeArchived = false) {
  // a LAN-shared intake comes back in requests.json under the same id — that copy supersedes the local one
  const seedIds = new Set(state.seedRequests.map((r) => r.id));
  const merged = state.seedRequests.concat(state.store.added.filter((r) => !seedIds.has(r.id)))
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
  const n = ['type', 'county', 'q', 'window'].filter((k) => f[k]).length
    + (f.dist && state.myPos ? 1 : 0) // dist only applies with a GPS fix, matching requestVisible + the all-clear check
    + (state.sort !== 'smart' ? 1 : 0) + (state.showAged ? 1 : 0) + (state.inView ? 1 : 0);
  $('#filters-toggle').textContent = n ? t('feed.filters.n').replace('{n}', n) : t('feed.filters');
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
  revealMapOnPhone();
  return true;
}

/* ---------- map↔list sync — popup "Open in …" reveal + "In view" scoping ---------- */

// ~1.5s outline pulse on a list row; restarts cleanly on repeat taps
function flashRow(el) {
  el.classList.remove('flash');
  void el.offsetWidth; // restart the pulse on repeat taps
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}

// map→list reveal: switch tab, scroll the row into view, ~1.5s outline pulse
function revealInList(tab, sel) {
  const btn = document.querySelector(`.tabs button[data-tab="${tab}"]`);
  if (btn) btn.click();
  requestAnimationFrame(() => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flashRow(el);
  });
}

function openInFeed(id) {
  revealInList('tab-requests', `#request-list .card[data-rid="${CSS.escape(id)}"]`);
}

/* The one focus path for a single named hazard, shared by the Alerts-tab card and the hazard line
   so neither surface can drift into doing less than the other. Frame the product's own extent,
   flash it, and let a phone actually see the map move. `reveal` also lands the reader on the card,
   which the hazard line needs because it starts nowhere near the list, and a card click does not.
   The extent is resolved with alertGeom, the same predicate that decides the card's unmapped badge,
   so what the card says about its extent and what a tap does with it can no longer disagree. */
function focusAlert(f, reveal) {
  let b = null;
  const geom = alertGeom(f);
  if (geom) {
    try { const bb = L.geoJSON(geom).getBounds(); if (bb.isValid()) b = bb; } catch { b = null; } // malformed cached zone geometry reads as no extent
  }
  if (!b) { openAlertText(f); return false; } // nothing to frame: open the readable text, never a bare tab switch
  state.map.fitBounds(b, { maxZoom: 10 });
  flashAlert(f);
  revealMapOnPhone();
  if (reveal) openInAlertsList(f);
  return true;
}

/* The hazard line can name an alert the Alerts tab is currently filtering out. Clear only what
   actually hides it, then reveal the row, so a tap never lands on a list without the alert it named. */
function openInAlertsList(f) {
  const sel = `#alert-list .alert-card[data-alert-id="${CSS.escape((f && f.id) || '')}"]`;
  if (!document.querySelector(sel)) {
    let changed = false;
    for (const id of ['#flt-alert-sev', '#flt-alert-q']) {
      const el = $(id);
      if (el && el.value) { el.value = ''; changed = true; }
    }
    if (!state.showAlertsFar) { state.showAlertsFar = true; changed = true; }
    if (changed) renderAlertList();
  }
  revealInList('tab-alerts', sel);
}

/* Two folds can hide a gauge row: the normal-category fold and the degraded fold. Which one holds
   a gauge is a fact about the gauge, so read it from the data. Deciding from the row simply being
   absent used to unfold the normal set for a degraded gauge, which changed a filter the user never
   touched and still revealed nothing. */
function gaugeListUnfoldFor(lids) {
  let changed = false;
  for (const lid of lids) {
    if ((state.gaugesDegraded || []).some((g) => g.lid === lid)) {
      if (!state.showDegradedGauges) { state.showDegradedGauges = true; changed = true; }
    } else if (!state.showNormalGauges && state.gauges.some((g) => g.lid === lid && gaugeCat(g) === 'none')) {
      state.showNormalGauges = true;
      changed = true;
    }
  }
  if (changed) renderGaugesTab();
  return changed;
}

function openInGaugesList(lid) {
  const sel = `#gauge-list .gauge-card[data-lid="${CSS.escape(lid)}"]`;
  gaugeListUnfoldFor([lid]);
  // In view is the only filter left that can hide a gauge the user just asked for by name; drop
  // the scope rather than land them on a list without the row they tapped
  if (state.inView && !document.querySelector(sel) && gaugeAll().some((g) => g.lid === lid)) setInView(false);
  revealInList('tab-gauges', sel);
}

/* Hazard-line focus: frame a set of gauges, pulse their map markers, and reveal + flash their rows
   in the Gauges tab, so which gauges are in question is obvious on both surfaces. `lead` is the one
   the user actually tapped: the map frames that gauge and the list scrolls to it, while the rest of
   the set still pulses and flashes. Without a lead the whole set is framed together.
   Degrades gracefully if the gauge layer is toggled off. */
function focusGauges(gauges, lead) {
  if (!gauges || !gauges.length) return;
  const lids = gauges.map((g) => g.lid);
  const ptOf = (g) => (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude) ? [g.latitude, g.longitude] : null);
  const leadPt = ptOf(lead);
  const pts = gauges.map(ptOf).filter(Boolean);
  if (leadPt || pts.length === 1) state.map.setView(leadPt || pts[0], Math.max(state.map.getZoom(), 11), { animate: true });
  else if (pts.length) fitTo(pts);
  let pulsed = false;
  const pulse = () => {
    if (pulsed) return;
    pulsed = true;
    for (const lid of lids) {
      const m = state.gaugeMarkers[lid];
      const el = m && m.getElement && m.getElement();
      if (!el) continue; // layer toggled off / marker not on map — list reveal still runs
      el.classList.remove('gauge-attn');
      void el.offsetWidth; // restart the halo on repeat taps
      el.classList.add('gauge-attn');
      setTimeout(() => el.classList.remove('gauge-attn'), 4600);
    }
  };
  state.map.once('moveend', pulse); // pulse once the eye follows the pan…
  setTimeout(pulse, 750);           // …or right away if the view was already framed
  const rowSel = (lid) => `#gauge-list .gauge-card[data-lid="${CSS.escape(lid)}"]`;
  gaugeListUnfoldFor(lids);
  // In view is the one filter that can hide the very rows this focus exists to surface; drop the
  // scope rather than land the user on a list without them
  if (state.inView && lids.some((lid) => !document.querySelector(rowSel(lid)) && gaugeAll().some((g) => g.lid === lid))) setInView(false);
  // the tapped gauge is the one the list scrolls to; the rest of the set still flashes behind it
  const order = lead && lids.includes(lead.lid) ? [lead.lid].concat(lids.filter((l) => l !== lead.lid)) : lids;
  const btn = document.querySelector('.tabs button[data-tab="tab-gauges"]');
  if (btn) btn.click();
  requestAnimationFrame(() => {
    let scrolled = false;
    for (const lid of order) {
      const el = document.querySelector(rowSel(lid));
      if (!el) continue;
      if (!scrolled) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); scrolled = true; }
      flashRow(el);
    }
  });
}

const IN_VIEW_KEY = 'respondertx.inview';
function setInView(on) {
  state.inView = on;
  try { sessionStorage.setItem(IN_VIEW_KEY, on ? '1' : '0'); } catch { /* private mode — chip still works this load */ }
  renderRequests();
  renderGaugesTab();
  renderAlertList();
}

// while the chip is ON, list re-renders on pan/zoom are the interaction; OFF keeps the seed-hash scroll guard untouched
function initInViewSync() {
  try { state.inView = sessionStorage.getItem(IN_VIEW_KEY) === '1'; } catch { state.inView = false; }
  let tmr = null;
  state.map.on('moveend', () => {
    if (!state.inView) return;
    clearTimeout(tmr);
    tmr = setTimeout(() => { if (state.inView) { renderRequests(); renderGaugesTab(); renderAlertList(); } }, 300);
  });
}

function reqPopup(r) {
  const el = document.createElement('div');
  el.innerHTML = `<div class="popup-title">${TYPE_GLYPH[r.type] || ''} ${esc(ntypeLabel(r.type).toUpperCase())} · ${esc(priLabel(r.priority))}</div>` +
    `<div>${esc(r.summary)}</div>` +
    `<div class="popup-meta">${shortId(r.id)} · ${esc(r.place)} · ${esc(nstatLabel(r.status))} · ${esc(fmtWhen(r.ts))}</div>` +
    `<div class="popup-meta">USNG ${esc(toUSNG(r.lat, r.lon))} · ${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}</div>` +
    `<button class="popup-expand open-in-feed">${esc(t('sync.openfeed'))}</button>` +
    (r.source && r.source.url && safeUrl(r.source.url) !== '#' ? `<div class="popup-link"><a href="${esc(safeUrl(r.source.url))}" target="_blank" rel="noopener">${esc(t('word.source'))}</a></div>` : '');
  el.querySelector('.open-in-feed').addEventListener('click', () => openInFeed(r.id));
  return el;
}

function cutoffPopup(r) {
  const el = document.createElement('div');
  el.innerHTML = `<div class="popup-title">⛔ ${esc(t('cutoff.title'))}</div><div>${esc(r.summary)}</div>` +
    `<div class="popup-meta">${esc(t('cutoff.foot').replace('{r}', r.radiusMi))}</div>` +
    `<button class="popup-expand open-in-feed">${esc(t('sync.openfeed'))}</button>`;
  el.querySelector('.open-in-feed').addEventListener('click', () => openInFeed(r.id));
  return el;
}

function renderRequests() {
  updateFiltersBadge();
  if (typeof refreshRecoveryView === 'function') refreshRecoveryView(); // notices lens tracks the feed

  const reqs = sortRequests(allRequests());
  const agedCount = reqs.filter(cardAged).length;
  const agedBtn = $('#flt-aged');
  agedBtn.textContent = t('feed.aged').replace('{n}', agedCount);
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
      `<div class="head"><span>${TYPE_GLYPH[r.type] || '📍'}</span><span class="type-chip">${esc(ntypeLabel(r.type))} · ${esc(priLabel(r.priority))}</span>` +
      `<span class="sid" title="${esc(t('card.sid.title'))}">${shortId(r.id)}</span>` +
      (hasPos ? `<span class="geo-flag" title="${esc(t('sync.geoflag.title'))}">📍</span>` : '') +
      `<span class="when"><span class="fresh-dot ${freshClass(r.ts)}"></span> ${esc(fmtWhen(r.ts))}</span></div>` +
      `<div class="summary">${esc(r.summary)}</div>` +
      `<div class="meta">📍 ${esc(r.place)} (${esc(r.county)} Co.)${r.contact ? ` · ☎ ${esc(r.contact)}` : ''}` +
      (state.myPos && hasPos ? ` · ${distMi(state.myPos.lat, state.myPos.lng, r.lat, r.lon).toFixed(1)} mi` : '') + '</div>' +
      (r.details ? `<div class="meta" style="margin-top:3px">${esc(r.details)}</div>` : '') +
      `<div class="badges">${isNew ? `<span class="badge new-chip">${esc(t('word.new'))}</span>` : ''}` +
      (r.status !== 'open' ? `<span class="badge status-${esc(r.status)}">${esc(nstatLabel(r.status))}</span>` : '') +
      (cardAged(r) ? `<span class="badge aged-chip">${esc(t('card.aged'))}</span>` : (needsReverify ? `<span class="badge reverify">${esc(t('card.stale'))}</span>` : '')) +
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
        revealMapOnPhone();
      }
    });
    el.appendChild(div);
  }
  if (!listed.length) {
    const restricted = ['type', 'county', 'q', 'window'].some((k) => state.filters[k]) || (state.filters.dist && state.myPos) || state.inView;
    // the calm treatment is a claim about hazards, so it renders only when the hazard feeds agree
    const calm = !restricted && feedCalmOk();
    el.innerHTML = `<div class="card${calm ? ' feed-allclear' : ''}">${esc(t(restricted ? 'feed.empty' : 'feed.allclear'))}</div>`;
  }

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
  // E1: Nominatim answers an error envelope with HTTP 200; only a real result array is a result
  const hits = await okJson(res, 'Nominatim');
  if (!Array.isArray(hits)) throw new Error('Nominatim: body is not a result list');
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
  // no LAN write endpoint means the notice reaches nobody; say so instead of banking it silently
  if (!state.lanIntake) { intakeToast(t('intake.nolan')); return; }
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
  if (!r.summary || !r.place) { alert(t('intake.required')); return; }
  if (Number.isFinite(r.lat)) {
    const dup = allRequests().find((x) => x.status !== 'resolved' && x.type === r.type
      && Number.isFinite(x.lat) && distMi(x.lat, x.lon, r.lat, r.lon) < 3);
    if (dup) {
      const dist = distMi(dup.lat, dup.lon, r.lat, r.lon).toFixed(1);
      if (!confirm(t('intake.dup').replace('{d}', dist).replace('{s}', dup.status).replace('{q}', dup.summary.slice(0, 100)))) return;
    }
  }
  state.store.added.push(r);
  saveStore();
  shareNoticeToLan(r);
  ev.target.reset();
  state.pendingLatLng = null;
  const form = $('#new-request-form'); // absent on the public mirror: deploy.sh strips the markup
  if (form) form.classList.remove('open');
  renderRequests();
}

// On LAN EOC surfaces the saved intake also POSTs to /api/requests so every station gets it
// after the next refresh cycle; the local copy above keeps it instantly visible for the author.
// Any failure (offline LAN, endpoint absent) leaves the existing local-only behavior untouched.
function shareNoticeToLan(r) {
  if (!state.lanIntake) return;
  fetch('/api/requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(r),
  }).then((res) => { if (res.ok) intakeToast(t('intake.shared')); })
    .catch(() => { /* LAN unreachable — the notice stays device-local, same as before this feature */ });
}

function intakeToast(msg) {
  const el = $('#intake-toast');
  if (!el) return;
  $('#intake-toast-text').textContent = msg;
  el.hidden = false;
  clearTimeout(intakeToast._t);
  intakeToast._t = setTimeout(() => { el.hidden = true; }, 6000);
}

/* ---------- "Am I at risk?" address check + saved my-places (client-only, no PII) ---------- */

const PLACES_KEY = 'respondertx.places';
const RISK_GAUGE_MI = 15; // nearest-gauge search radius
const RISK_NEAR_MI = 6;   // "within a few mi" for road/cutoff notices

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
// crossingList() attaches the confirmation verdict, so every caller below can name a stale closure
// as one instead of reading it out as a current status
function nearestCrossing(lat, lon, maxMi) {
  return crossingList()
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
// point-in-bbox (with small pad) against the alert polygon/zone bounds: "contains or is near"
function alertNearPoint(f, lat, lon) {
  const b = geoBounds(alertGeom(f));
  if (!b) return false;
  const pad = 0.05;
  return lat >= b.s - pad && lat <= b.n + pad && lon >= b.w - pad && lon <= b.e + pad;
}

function riskGaugeLine(x) {
  const { g, dist } = x;
  const stale = gaugeObsStale(g);
  const cat = gaugeObsCat(g);
  const fCat = gaugeForecastCat(g);
  const f = g.status.forecast;
  const o = g.status.observed;
  const tr = stale ? null : gaugeTrend(g.lid);
  const trendBit = tr ? ` · ${tr.dir === 'up' ? `↑ ${t('trend.rising')}` : tr.dir === 'down' ? `↓ ${t('trend.falling')}` : `→ ${t('trend.steady')}`} ${tr.rate >= 0 ? '+' : ''}${tr.rate.toFixed(1)} ft/hr` : '';
  const fcst = fCat
    ? `<div class="rg-fcst">${gaugeRising(g) ? '▲ ' : ''}${esc(t('gauge.fcrest'))} ${fmtNum(f.primary)} ${esc(f.primaryUnit)} · <span style="color:var(--cat-${fCat})">${esc(catLabel(fCat))}</span> · ${esc(fmtWhen(f.validTime))}</div>`
    : '';
  return `<button class="risk-gauge" data-lid="${esc(g.lid)}">` +
    `<div class="rg-top"><span class="rg-name">${esc(g.name)}</span><span class="rg-dist">${dist.toFixed(1)} ${esc(t('risk.mi'))}</span></div>` +
    `<div class="rg-now">${esc(t('risk.now'))} ${o.primary > -999 && Number.isFinite(o.primary) ? `${fmtNum(o.primary)} ${esc(o.primaryUnit)} · <span style="color:var(--cat-${stale ? 'none' : cat})">${esc(catLabel(cat))}</span>${trendBit}` : esc(t('gauge.noreading'))}</div>` +
    (stale ? `<div class="rg-now stale-note">⏱ ${esc(t('gauge.stale').replace('{t}', fmtWhen(o.validTime)))}</div>` : '') +
    fcst + '</button>';
}

// one derived line — never invents; each clause restates data already shown above.
// connectives localize; embedded feed data (event names, rivers) stays English.
function riskOverallRead(nearAlerts, gauges, xCross, nNotice) {
  const mi = t('risk.mi');
  const parts = [];
  if (nearAlerts.length) {
    const worst = nearAlerts.slice().sort(alertSevCmp)[0];
    parts.push(`${worst.properties.event}${worst._sev === 'emergency' ? `: ${t('risk.read.emerg')}` : ''} ${t('risk.read.covers')}`);
  }
  if (gauges.length) {
    const { g, dist } = gauges[0];
    const nearStale = gaugeObsStale(g);
    let s = `${t('risk.read.nearest')} ${riverOf(g.name)} (${dist.toFixed(1)} ${mi}) ${t('risk.read.is')} ${catLabel(gaugeObsCat(g))}${nearStale ? ` ${t('gauge.stalebit').replace('{t}', fmtWhen(g.status.observed.validTime).split(' · ')[0])}` : ''}`;
    if (gaugeRising(g)) s += ` ${t('risk.read.forecast')} ${catLabel(gaugeForecastCat(g))} ${fmtWhen(g.status.forecast.validTime)}`;
    parts.push(s);
  } else {
    parts.push(`${t('risk.read.nogauge')} ${RISK_GAUGE_MI} ${mi}`);
  }
  if (xCross) parts.push(`${t('risk.read.crosspre')} ${t('xword.' + xCross.c.status)} ${t('risk.read.crosspost')} ${xCross.dist.toFixed(1)} ${mi}${xCross.c.staleNote ? ` (${xCross.c.staleNote})` : ''}`);
  if (nNotice) parts.push(`${t('risk.read.noticepre')} ${t('ntype.' + nNotice.r.type)} ${t('risk.read.noticepost')} ${nNotice.dist.toFixed(1)} ${mi}`);
  const line = parts.join('; ');
  return line.charAt(0).toUpperCase() + line.slice(1) + '.';
}

// shared computation — the address modal and the map point inspector both consume this
function riskAssess(lat, lon) {
  const gauges = nearestGauges(lat, lon, RISK_GAUGE_MI, 3);
  const nearAlerts = state.alerts.filter((f) => alertOpen(f) && alertNearPoint(f, lat, lon));
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
        `<div class="ra-area">${esc(alertAreaText(f.properties))}</div>` +
        `<div class="ra-meta">${esc(t('risk.until'))} ${esc(alertUntilText(f))}</div></div>`;
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
    html += `<div class="risk-road"><span style="color:${st.color}">${st.glyph} ${esc(xstLabel(st))}</span>: ${esc(xCross.c.name)} <span class="rr-dist">${xCross.dist.toFixed(1)} ${esc(mi)}</span>` +
      (xCross.c.staleNote ? ` <span class="xg-stale">${esc(xCross.c.staleNote)}</span>` : '') + '</div>';
  }
  if (nNotice) {
    html += `<div class="risk-road"><span>${TYPE_GLYPH[nNotice.r.type] || '🚧'} ${esc(ntypeLabel(nNotice.r.type))}</span>: ${esc(nNotice.r.summary.slice(0, 90))} <span class="rr-dist">${nNotice.dist.toFixed(1)} ${esc(mi)}</span></div>`;
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
    saveBtn.textContent = t('risk.saved');
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
  if (pbBlocksLive(state)) html += `<div class="inspect-line sev-warning">${esc(t('inspect.live'))}</div>`;
  html += `<button class="inspect-usng" title="${esc(t('inspect.copy'))}">${esc(usngLbl)}</button>`;
  html += `<div class="inspect-read">${esc(read)}</div>`;
  if (nearAlerts.length) {
    const worst = nearAlerts.slice().sort(alertSevCmp)[0];
    html += `<div class="inspect-line sev-${worst._sev}">⚠ ${esc(worst.properties.event)} · ${esc(t('risk.until'))} ${esc(alertUntilText(worst).split(' · ')[0])}</div>`;
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
    html += `<div class="inspect-line"><span style="color:${st.color}">${st.glyph} ${esc(xstLabel(st))}</span> ${esc(xCross.c.name)} · ${xCross.dist.toFixed(1)} ${esc(mi)}` +
      (xCross.c.staleNote ? ` · <span class="xg-stale">${esc(xCross.c.staleNote)}</span>` : '') + '</div>';
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

/* ---------- Stable interchange URLs: one cycle-refreshed feature set in three formats ---------- */

const CALTOPO_EXPORT_URL = 'https://respondertx.org/data/caltopo-export.json';
// the NetworkLink wrapper, not board.kml itself: a plain KML at a URL is a one-shot import, and
// the in-file refresh directive is what ArcGIS and ATAK honor to keep the layer current
const KML_LIVE_URL = 'https://respondertx.org/data/board-live.kml';
const GEORSS_URL = 'https://respondertx.org/data/board-georss.xml';

const renderQr = (host, url) => renderQrCode(host, url, 8);

// the export is capped, so the surface offering it has to say what the file actually holds.
// reads the same-origin copy (present in both builds) rather than the absolute import URL.
function caltopoStatusText(p) {
  // metadata that does not carry per-folder counts is not an export we can describe; claiming
  // completeness from an empty or half-read object is the exact failure this line exists to stop
  if (!p || typeof p !== 'object' || !p.counts || typeof p.counts !== 'object') return '';
  const kept = Object.values(p.counts).reduce((a, b) => a + (Number(b) || 0), 0);
  if (!kept) return '';
  if (!p.truncated) return t('caltopo.complete').replace('{n}', fmtNum(kept));
  return t('caltopo.partial')
    .replace('{n}', fmtNum(kept))
    .replace('{total}', fmtNum(Number(p.candidates) || kept + (Number(p.dropped) || 0)));
}

function renderCaltopoStatus() {
  const el = $('#caltopo-status');
  if (!el) return;
  fetch('data/caltopo-export.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const txt = caltopoStatusText(d && d.properties);
      el.textContent = txt;
      el.classList.toggle('caltopo-partial', !!(d && d.properties && d.properties.truncated));
      el.hidden = !txt;
    })
    .catch(() => { el.hidden = true; }); // no metadata is silent; a wrong completeness claim would not be
}

const FEED_URLS = [
  ['#caltopo-url', '#caltopo-copy', CALTOPO_EXPORT_URL],
  ['#kml-url', '#kml-copy', KML_LIVE_URL],
  ['#georss-url', '#georss-copy', GEORSS_URL],
];

function toggleCaltopoBox() {
  const box = $('#caltopo-box');
  box.hidden = !box.hidden;
  if (box.hidden) return;
  for (const [slot, , url] of FEED_URLS) {
    const el = $(slot);
    if (el) el.textContent = url;
  }
  renderQr($('#caltopo-qr'), CALTOPO_EXPORT_URL);
  renderCaltopoStatus();
}

function copyFeedUrl(btnSel, url) {
  const btn = $(btnSel);
  copyText(url).then(
    () => { btn.textContent = t('caltopo.copied'); setTimeout(() => { btn.textContent = t('caltopo.copy'); }, 1400); },
    () => prompt(t('share.prompt'), url));
}

function importRequests(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      // a file with no requests list is not an export, so fail visibly instead of reporting "0 new"
      const incoming = okList(data, 'requests', 'not a Responder export');
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
      alert(t('import.done').replace('{a}', added).replace('{u}', updated));
    } catch (e) { alert(t('import.failed').replace('{e}', e.message)); }
  };
  reader.readAsText(file);
}

/* ---------- SITREP ---------- */

// shared by the SITREP RECOVERY line and the recovery view headline
function sitrepFallingGauges() {
  return state.gauges.filter((g) => gaugeCat(g) !== 'none' && (gaugeTrend(g.lid) || {}).dir === 'down');
}

function buildSitrep() {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const emerg = state.alerts.filter((a) => a._sev === 'emergency' && alertOpen(a));
  const warnings = state.alerts.filter((a) => a._sev === 'warning' && alertOpen(a)).length;
  const majors = state.gauges.filter((g) => gaugeCat(g) === 'major');
  const toMajor = state.gauges.filter((g) => gaugeRising(g) && gaugeForecastCat(g) === 'major');
  const reqs = activeRequests().filter((r) => r.status !== 'resolved');
  const crit = sortRequests(reqs.filter((r) => r.priority === 'critical'));
  const cutoffs = reqs.filter((r) => r.type === 'cutoff');
  const L = [];
  L.push(`RESPONDER TX SITREP - ${now} CT`);
  L.push(`THREAT: ${emerg.length} flash flood emergencies${emerg.length ? ` (${emerg.map((a) => alertAreaText(a.properties)).join(' | ')})` : ''}; ${warnings} flood warnings statewide (official)`);
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
  const falling = sitrepFallingGauges();
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

// bold the leading section label so the modal reads as a report, not a wall of text;
// the label tokens contain no HTML-special chars, so escaped length equals raw length
const SITREP_LABELS = /^(RESPONDER TX SITREP|THREAT|GAUGES|RECOVERY|CUT-OFF AREAS|ACTIVE CRITICAL|ACTIVE NOTICES TOTAL)/;
function sitrepHtml(text) {
  return text.split('\n').map((line) => {
    const e = esc(line);
    const m = line.match(SITREP_LABELS);
    return m ? `<strong>${esc(m[0])}</strong>${e.slice(m[0].length)}` : e;
  }).join('\n');
}

let sitrepText = '';
let sitrepReturnFocus = null;

function openSitrepModal(text) {
  sitrepText = text;
  $('#sitrep-pre').innerHTML = sitrepHtml(text);
  $('#sitrep-share').hidden = !navigator.share; // Share only where the OS provides a share sheet
  sitrepReturnFocus = document.activeElement;
  $('#sitrep-modal').hidden = false;
  $('#sitrep-copy').focus();
}

function closeSitrepModal() {
  $('#sitrep-modal').hidden = true;
  if (sitrepReturnFocus && typeof sitrepReturnFocus.focus === 'function') sitrepReturnFocus.focus();
  sitrepReturnFocus = null;
}

// desktop and mobile alike: copy to clipboard AND open a formatted modal of the same text
function copySitrep(btn) {
  const text = buildSitrep();
  openSitrepModal(text);
  copyText(text).then(
    () => { if (btn) { btn.textContent = t('sitrep.copied'); setTimeout(() => { btn.textContent = '📋 SITREP'; }, 2000); } },
    () => downloadBlob(text, 'text/plain', `sitrep-${stamp()}.txt`));
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
  for (const [key, lk] of [['radar', 'radar'], ['fcst', 'fcstRadar'], ['usgs', 'usgs'], ['lwc', 'lwc'], ['inun', 'inundation'], ['reopen', 'roadReopen'],
    ['rs', 'riverSentry'], ['fire', 'wildfire']]) {
    if (state.layers[lk] && state.map.hasLayer(state.layers[lk])) p.set(key, '1');
  }
  // cameras travel as one ?camreg= list of region ids; the retired per-source params stay readable
  // on the way in (js/boot.js CAM_LEGACY_PARAMS) so links shared before the split keep working
  const camRows = camRegionsAll();
  const camOn = camRows
    .filter((r) => state.layers[camRegionKey(r.id)] && state.map.hasLayer(state.layers[camRegionKey(r.id)]))
    .map((r) => r.id);
  // every region on travels as the statewide token, so the link still means statewide if the region set grows
  if (camOn.length && camOn.length === camRows.length) p.set('camreg', CAM_REGION_ALL);
  else if (camOn.length) p.set('camreg', camOn.join(','));
  // Full AO is the resting pick, so a default link stays short; any sub-AO travels by its id
  const ao = typeof aoPickedId === 'function' ? aoPickedId() : null;
  if (ao && ao !== AO_FULL_ID) p.set('ao', ao);
  const rv = $('#recovery-view');
  if (rv && !rv.hidden) p.set('view', 'recovery');
  const bv = $('#basin-view');
  if (bv && !bv.hidden) {
    p.set('view', 'basin');
    if (state.basinRiver) p.set('river', state.basinRiver);
  }
  p.set('base', state.activeBase);
  p.set('theme', document.documentElement.getAttribute('data-theme'));
  return `${location.origin}${location.pathname}?${p}`;
}

/* Share and Export are one surface. Apple's HIG is explicit that a Share control should present an
   activity view rather than a second way to do the same thing, and every comparable product anchors
   interchange to the object it operates on, not to a settings page or a content tab. */
function openShareSheet() {
  const el = $('#share-sheet');
  if (!el) return;
  const url = buildShareUrl();
  state.shareUrl = url;
  $('#share-url').textContent = url;
  $('#share-native').hidden = !navigator.share;
  const qr = $('#share-qr');
  if (qr) { delete qr.dataset.done; qr.innerHTML = ''; qr.hidden = false; renderQr(qr, url); } // the link changes with the view
  el.hidden = false;
  $('#share-copy').focus();
}

function closeShareSheet() {
  const el = $('#share-sheet');
  if (el) el.hidden = true;
}

/* Shelters and hotlines are the public's entire job on this board. They render from one host,
   reached from a permanent Settings row. */
function openHelpSheet() {
  const el = $('#help-sheet');
  if (el) el.hidden = false;
}

function closeHelpSheet() {
  const el = $('#help-sheet');
  if (el) el.hidden = true;
}

/* Alert setup is one sheet with one accordion, reached from the gear row, the Alerts tab row and
   every gauge bell. `section` preselects a pane for an entry point that already knows what the
   reader asked for; without one the sheet opens with all three closed.
   Repaints through pushRerender, never renderPushCard: the gear row is always present, so a board
   whose backend check never admitted a card must open on the subscribe links alone rather than on
   a switch that cannot subscribe. */
function openNotifySheet(section) {
  const el = $('#notify-sheet');
  if (!el) return;
  if (section) pushSection = section;
  el.hidden = false;
  pushRerender();
  const focus = $('#push-toggle') || $('#notify-sheet-close');
  if (focus && focus.focus) focus.focus();
}

function closeNotifySheet() {
  const el = $('#notify-sheet');
  if (el) el.hidden = true;
}

function copyShareUrl() {
  const btn = $('#share-copy');
  const url = state.shareUrl || buildShareUrl();
  copyText(url).then(
    () => { const orig = btn.textContent; btn.textContent = t('share.copied'); setTimeout(() => { btn.textContent = orig; }, 2000); },
    () => prompt(t('share.prompt'), url));
}

// set a filter control the way a user would (adding a missing SELECT option first, since the
// county list is rebuilt later with board data), then fire its handler; empty/absent val is a no-op
function setControl(sel, val, evt) {
  if (val == null || val === '') return false;
  const el = $(sel);
  if (!el) return false;
  if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === val)) el.add(new Option(val, val));
  el.value = val;
  el.dispatchEvent(new Event(evt));
  return true;
}

// boot-time restore: set each control the way a user would, then let its own handler re-render
function applyShareParams(q) {
  const lat = parseFloat(q.get('mlat')), lon = parseFloat(q.get('mlon')), z = parseInt(q.get('mz'), 10);
  const framed = Number.isFinite(lat) && Number.isFinite(lon);
  if (framed) state.map.setView([lat, lon], Number.isFinite(z) ? z : state.map.getZoom());
  // a bare ?ao= has no framing of its own to honour, so that form fits the region's bounds
  if (q.get('ao') && typeof aoSelectById === 'function') aoSelectById(q.get('ao'), !framed);
  const apply = (sel, key, evt) => setControl(sel, q.get(key), evt);
  const feedFiltered = [['#flt-type', 'ft', 'change'], ['#flt-county', 'fc', 'change'], ['#flt-window', 'fw', 'change'],
    ['#flt-dist', 'fd', 'change'], ['#flt-q', 'fq', 'input'], ['#flt-sort', 'fs', 'change']]
    .map(([sel, key, evt]) => apply(sel, key, evt)).some(Boolean);
  if (feedFiltered) $('#req-filters').hidden = false; // a shared filtered view must be visible, not silent
  apply('#flt-alert-sev', 'as', 'change');
  apply('#flt-alert-q', 'aq', 'input');
  // every ?view= lens (drive, basin, playback, recovery, summary) restores through the one router
  if (typeof openView === 'function') openView(q.get('view'), { river: q.get('river') });
}

// team-invite filter presets: snapshot the active feed filters (js/team.js sends these in
// defaults.filters at create), and apply an incoming preset by driving the real controls so their
// own handlers re-render the feed/map. Conservative: only known keys, empty snapshot returns null.
window.collectBoardFilters = function collectBoardFilters() {
  const f = state.filters, out = {};
  for (const k of ['type', 'county', 'q', 'window', 'dist']) { if (f[k]) out[k] = String(f[k]); }
  if (state.inView) out.inView = true;
  return Object.keys(out).length ? out : null;
};

window.applyBoardFilters = function applyBoardFilters(f) {
  if (!f || typeof f !== 'object') return;
  let any = false;
  if (setControl('#flt-type', f.type, 'change')) any = true;
  if (setControl('#flt-county', f.county, 'change')) any = true;
  if (setControl('#flt-window', f.window, 'change')) any = true;
  if (setControl('#flt-dist', f.dist, 'change')) any = true;
  if (setControl('#flt-q', f.q, 'input')) any = true;
  if (f.inView === true && !state.inView) { setInView(true); any = true; }
  if (any) $('#req-filters').hidden = false; // an applied preset must be visible, not silent
};

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
// phone: at sheet-full the sidebar owns the viewport and #map is squeezed to its 60px min-height, so
// a pan lands somewhere invisible. Nothing on the page scrolls, so scrolling #map into view was a
// no-op; dropping the sheet to half is what actually puts the map back on screen.
function revealMapOnPhone() {
  if (window.innerWidth > 768) return;
  if (document.querySelector('main.sheet-full')) setSheet('sheet-half');
}

function initSheet() {
  const param = new URLSearchParams(location.search).get('sheet'); // ?sheet=peek|half|full deep link
  const wanted = param ? `sheet-${param}` : localStorage.getItem('respondertx.sheet');
  setSheet(SHEET_STATES.includes(wanted) ? wanted : 'sheet-half');
  document.querySelectorAll('#sheet-handle button').forEach((b) =>
    b.addEventListener('click', () => setSheet(b.dataset.sheet)));
}

/* Tab renames are a deep-link hazard: ?tab=monitor and ?tab=resources are both in the wild, and a
   saved view can name either. Resolve transitively so one table serves the URL and the saved view. */
const TAB_ALIASES = { monitor: 'resources', resources: 'roads' };
function resolveTabName(name) {
  let n = String(name || '');
  for (let hop = 0; hop < 4 && TAB_ALIASES[n]; hop++) n = TAB_ALIASES[n];
  return n;
}

/* Persist the user's view (feed + alert filters, sort, aged toggle, active tab, map framing, AO
   pill, and the overlay set) across hard refreshes and app updates. URL share-params still win for
   their load: the per-control ones are applied after this, and the framing/overlay half stands
   down entirely when a link is present, since a link is an explicit intent for the whole view. */
const VIEW_KEY = 'respondertx.view';

function readViewState() {
  try { return JSON.parse(localStorage.getItem(VIEW_KEY) || 'null'); } catch { return null; }
}

/* Params that describe the framing/overlay half of a view. Any one of them means the load was
   opened from a link, so the stored framing and overlay set do not compete with it: the layer
   params only ever switch things ON, so a link showing three overlays would otherwise land on top
   of whatever the reader already had. The per-control filter params are not listed (those override
   control by control), and neither are ?hydro=/?cam=, which open one record and say nothing about
   how the map should be framed. */
const LINK_VIEW_PARAMS = ['mlat', 'mlon', 'mz', 'ao', 'rain', 'radar', 'fcst', 'usgs', 'lwc',
  'inun', 'reopen', 'rs', 'fire', 'camreg'];
const linkOwnsView = (q) => LINK_VIEW_PARAMS.some((k) => q.has(k));

function saveViewState() {
  try {
    const active = document.querySelector('.tabs button.active');
    const prev = readViewState() || {};
    // null while the archive owns the layers or the map is not up yet: carry the last real answer
    // forward rather than storing the archive's picture as if the user had chosen it
    const ls = typeof collectLayerState === 'function' ? collectLayerState() : null;
    const frame = mapFrame();
    localStorage.setItem(VIEW_KEY, JSON.stringify({
      ft: state.filters.type || '', fc: state.filters.county || '', fq: state.filters.q || '',
      fw: state.filters.window || '', fd: state.filters.dist || '', fs: state.sort,
      aged: state.showAged ? 1 : 0,
      as: $('#flt-alert-sev').value, aq: $('#flt-alert-q').value,
      tab: active ? active.dataset.tab : 'tab-requests',
      ly: ls ? ls.on : prev.ly, lyk: ls ? ls.known : prev.lyk,
      ao: (typeof aoPickedId === 'function' && aoPickedId()) || prev.ao || '',
      mlat: frame ? frame[0] : prev.mlat, mlon: frame ? frame[1] : prev.mlon,
      mz: frame ? frame[2] : prev.mz,
    }));
  } catch { /* private-mode / quota — view persistence is best-effort */ }
}

// current centre + zoom, or null when there is no map yet or the archive is driving it
function mapFrame() {
  if (!state.map || typeof state.map.getCenter !== 'function' || pbBlocksLive(state)) return null;
  const c = state.map.getCenter();
  if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) return null;
  return [+c.lat.toFixed(4), +c.lng.toFixed(4), state.map.getZoom()];
}

/* Layer toggles and pans arrive in bursts: a camera parent moves thirteen layers, a fitBounds
   fires moveend more than once. Coalesce them into one write. The viewReady gate is the same one
   the tab handler uses, so the boot-time restore never writes back over what it is restoring. */
let viewSaveTimer = null;
function scheduleViewSave() {
  if (!state.viewReady) return;
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(saveViewState, 400);
}

function restoreViewState() {
  const v = readViewState();
  if (!v) return;
  restoreViewFraming(v);
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
  let vtab = v.tab;
  if (vtab && /^tab-[a-z-]+$/.test(vtab)) vtab = `tab-${resolveTabName(vtab.slice(4))}`; // legacy saved view
  if (vtab && vtab !== 'tab-requests' && /^[a-z-]+$/.test(vtab)) {
    const btn = document.querySelector(`.tabs button[data-tab="${vtab}"]`);
    if (btn) btn.click();
  }
}

/* The framing half of the saved view: AO pill, map centre/zoom, overlay set. A link opened with
   any framing param owns this load instead, and the archive is never restored into: a stored
   layer set applied while playback is engaged would hide the live board behind archive layers. */
function restoreViewFraming(v) {
  if (!state.map || linkOwnsView(new URLSearchParams(location.search)) || pbBlocksLive(state)) return;
  if (typeof aoSelectById === 'function' && v.ao) aoSelectById(v.ao, false); // framing is restored below, not fitted
  const lat = parseFloat(v.mlat), lon = parseFloat(v.mlon), z = parseInt(v.mz, 10);
  if (Number.isFinite(lat) && Number.isFinite(lon)) state.map.setView([lat, lon], Number.isFinite(z) ? z : state.map.getZoom());
  if (typeof applyLayerState === 'function') applyLayerState(v.ly, v.lyk);
}

function exportAAR() {
  const reqs = allRequests(true).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const count = (fn) => reqs.reduce((m, r) => { const k = fn(r); m[k] = (m[k] || 0) + 1; return m; }, {});
  const fmtCounts = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');
  const L = [];
  L.push(`# ResponderTX After-Action Export`);
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


/* ---------- device alerts, web push P3 (FFE + AO tiers + followed gauges) ---------- */

const PUSH_LS_KEY = 'respondertx.push';
const PUSH_STALE_MS = 20 * 60 * 1000; // evaluator freshness threshold (spec §4.3)

// pure card-state predicate over environment facts. Order matters: the iOS install hint wins
// (Safari hides the Push API until the board is a Home Screen app), then capability, then permission.
function pushCardState(f) {
  if (f.ios && !f.standalone) return 'ios';
  if (!f.secure || !f.hasSW || !f.hasPush || !f.hasNotif) return 'unsupported';
  if (f.permission === 'denied') return 'blocked';
  return f.subscribed ? 'on' : 'off';
}

// pure visibility predicate for the alerts card, over the same environment facts pushCardState
// reads plus a `flagged` deep-link bit. Any device the browser could carry alerts on sees the
// card, so alert delivery is discoverable without a deep link. 'unsupported' stays hidden for a
// first-time visitor because there is nothing they could do about it; a subscribed device and a
// ?push arrival still get the card in every state, so the off switch is always reachable.
function pushCardVisible(f) {
  return f.subscribed === true || f.flagged === true || pushCardState(f) !== 'unsupported';
}

// the gauge picker only exists on a subscribed device, so a "Notify me" tap that arrives with
// alerts off has to say what is missing instead of switching to a card that looks inert
function pushFollowPending(cardState, preselect) {
  return Boolean(preselect) && cardState !== 'on';
}

function pushLocal() {
  try { return JSON.parse(localStorage.getItem(PUSH_LS_KEY)) || {}; } catch { return {}; }
}
function pushLocalSet(v) {
  try { localStorage.setItem(PUSH_LS_KEY, JSON.stringify(v)); } catch { /* private mode — card state falls back to browser truth */ }
}

const PUSH_MAX_GAUGES = 20; // registry cap per subscription (worker rejects above)
const PUSH_LID_RE = /^[A-Z0-9]{3,10}$/;
const PUSH_MAX_PLACES = 5;              // registry cap per subscription
const PUSH_PLACE_KM = [8, 16, 40];      // the 5, 10 and 25 mile radius chips
const PUSH_PLACE_KM_DEFAULT = 16;
const PUSH_PLACE_DP = 2;                // stored coordinate precision, about 1 km
const PUSH_SCOPES = ['statewide', 'places', 'none'];

// client mirror of the worker's sanitizePlaces: coordinates rounded to about a kilometer,
// deduped at that precision, no label ever leaves the device
function pushNormalizePlaces(src) {
  const out = [];
  const seen = {};
  const q = 10 ** PUSH_PLACE_DP;
  for (const p of Array.isArray(src) ? src.slice(0, PUSH_MAX_PLACES) : []) {
    const lat = Math.round(Number(p && p.lat) * q) / q;
    const lon = Math.round(Number(p && p.lon) * q) / q;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const key = `${lat},${lon}`;
    if (seen[key]) continue;
    seen[key] = 1;
    out.push({ lat, lon, km: PUSH_PLACE_KM.indexOf(Number(p.km)) >= 0 ? Number(p.km) : PUSH_PLACE_KM_DEFAULT });
  }
  return out;
}

// pure prefs normalizer (client mirror of the worker's sanitizePrefs): FFE on/off + alert area
// + area-wide gauge tier + followed gauges [{lid, tier}] + followed places [{lat, lon, km}].
// An unset area is 'none': a device that shared no location is never given the whole state.
function pushNormalizePrefs(p) {
  const src = p && typeof p === 'object' ? p : {};
  const gauges = [];
  const seen = {};
  for (const g of Array.isArray(src.gauges) ? src.gauges.slice(0, PUSH_MAX_GAUGES) : []) {
    const lid = String((g && g.lid) || '').toUpperCase();
    const tier = g && (g.tier === 'moderate' || g.tier === 'major') ? g.tier : null;
    if (!tier || !PUSH_LID_RE.test(lid) || seen[lid]) continue;
    seen[lid] = 1;
    gauges.push({ lid, tier });
  }
  return {
    ffe: src.ffe !== false,
    tier: src.tier === 'moderate' || src.tier === 'major' ? src.tier : null,
    gauges,
    scope: PUSH_SCOPES.indexOf(src.scope) >= 0 ? src.scope : 'none',
    places: pushNormalizePlaces(src.places),
  };
}

/* What this subscription can actually deliver, which is not the same fact as being subscribed.
   The area path needs a scope that covers something AND a type selected; a followed gauge fires on
   its own threshold wherever it is, so it is independent of the area. A fresh subscribe defaults
   scope 'none', so without this the card headlines a green ON over a device that receives silence. */
function pushDelivers(prefs, scopeState) {
  const p = prefs || {};
  const area = scopeState === 'ok' && !!(p.ffe || p.tier);
  const gauges = Array.isArray(p.gauges) && p.gauges.length > 0;
  return { area, gauges, any: area || gauges };
}

// what the card must say about area coverage: 'ok' when area alerts can really fire,
// 'unset' when no area was chosen, 'empty' when places is chosen with nothing in it
function pushScopeState(prefs) {
  const p = prefs || {};
  if (p.scope === 'statewide') return 'ok';
  if (p.scope === 'places') return (p.places || []).length ? 'ok' : 'empty';
  return 'unset';
}

function pushPrefs() {
  return pushNormalizePrefs(pushLocal().prefs);
}

// honest-failure chip over /api/push/status lastEval: null = unknown (chip hidden), 'ok' with
// the age, 'stale' past the threshold — the board never pretends the alert channel is live
function pushFreshState(lastEval, now) {
  if (!Number.isFinite(lastEval) || lastEval <= 0) return null;
  return now - lastEval > PUSH_STALE_MS ? 'stale' : 'ok';
}

function pushEnvFacts() {
  const ua = navigator.userAgent || '';
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return {
    ios,
    standalone: navigator.standalone === true || Boolean(window.matchMedia && matchMedia('(display-mode: standalone)').matches),
    secure: window.isSecureContext === true,
    hasSW: 'serviceWorker' in navigator,
    hasPush: 'PushManager' in window,
    hasNotif: 'Notification' in window,
    permission: 'Notification' in window ? Notification.permission : 'default',
    subscribed: pushLocal().on === true,
  };
}

// applicationServerKey wants raw bytes, /api/push/status serves base64url
function pushKeyBytes(b64u) {
  const pad = '='.repeat((4 - (b64u.length % 4)) % 4);
  const raw = atob((b64u + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// byte-wise compare of the subscription's applicationServerKey against the served VAPID key;
// accepts ArrayBuffer or typed-array views (avoids cross-realm instanceof)
function pushKeysMatch(a, b) {
  const bytes = (k) => {
    if (!k) return null;
    if (typeof k.length === 'number' && typeof k.byteLength === 'number') return k; // typed array
    if (typeof k.byteLength === 'number') return new Uint8Array(k); // ArrayBuffer
    return null;
  };
  const x = bytes(a), y = bytes(b);
  if (!x || !y || x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

// pure boot-time self-heal decision. facts: {localOn, permission, hasSub, keyMatches}.
// 'off' = permission revoked or unrecoverable: flip the card off honestly, keep local prefs
// so a later manual re-enable restores them (re-prompting is never allowed outside a tap).
function pushBootPlan(f) {
  if (!f.localOn) return 'none';
  if (f.permission === 'denied') return 'off';
  if (!f.hasSub) return f.permission === 'granted' ? 'resubscribe' : 'off';
  if (f.keyMatches === false) return 'rekey';
  return 'renew';
}

// mirror key/lang/prefs into the version-independent push cache so the SW can re-subscribe
// with preserved prefs on pushsubscriptionchange (a SW cannot read localStorage)
async function pushSwMirror(vapidKey, prefs) {
  try {
    const c = await caches.open('respondertx-push');
    await c.put('/push-lang', new Response(getLang()));
    await c.put('/push-key', new Response(String(vapidKey || '')));
    await c.put('/push-prefs', new Response(JSON.stringify(prefs || {})));
  } catch (err) { /* cache unavailable — SW falls back to generic defaults */ }
}

// nearest unfollowed gauges to a point, for the manage picker (pan the map to look elsewhere)
function pushNearbyGauges(gauges, followed, lat, lon, n) {
  const have = {};
  for (const f of followed || []) have[f.lid] = 1;
  return (gauges || [])
    .filter((g) => g.lid && !have[String(g.lid).toUpperCase()] && Number.isFinite(g.latitude) && Number.isFinite(g.longitude))
    .map((g) => ({ g, dist: distMi(lat, lon, g.latitude, g.longitude) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, n);
}

/* Single-open accordion: '' | 'where' | 'what' | 'gauges'. One open pane bounds the sheet's height
   and keeps push.note and the disclosure on screen in every state, which a routed sub-view would
   not. Render-time only, never persisted: rotation must not mutate it mid-interaction. */
let pushSection = '';
let pushManagePreselect = null;  // lid pinned atop the picker by a "Notify me" entry point
let pushAboutOpen = false;       // the full honesty paragraphs, expanded; survives a re-render
let pushPlaceMsg = '';           // one-shot place-editor message (geolocation refusal)
let pushNearbyMore = false;      // the nearby picker's overflow disclosure, past the first four

// the one-sentence fix for a state the user cannot toggle out of ('' when the toggle is the fix)
function pushFixKey(cardState) {
  return cardState === 'blocked' || cardState === 'unsupported' || cardState === 'ios'
    ? `push.fix.${cardState}` : '';
}

function pushGaugeName(lid) {
  const g = (state.gauges || []).find((x) => String(x.lid).toUpperCase() === lid);
  return g ? g.name : lid;
}

const PUSH_NEARBY_SHOWN = 4; // the picker's visible depth; the rest sit behind one disclosure

// the followed-gauges pane: each followed gauge with its tier + remove, a nearby-gauges picker
// seeded from the current map view, and the everything-off action
function pushManageHtml(prefs) {
  const tierBtns = (lid, current, cls) => ['moderate', 'major'].map((tier) =>
    `<button type="button" class="push-chip ${cls}${current === tier ? ' active' : ''}" data-lid="${esc(lid)}" data-tier="${tier}" aria-pressed="${current === tier}">${esc(t(`push.tier.${tier}`))}</button>`).join('');
  const followedRows = prefs.gauges.map((f) =>
    `<div class="push-g-row${pushManagePreselect === f.lid ? ' preselect' : ''}" data-lid="${esc(f.lid)}">` +
      `<span class="push-g-name">${esc(pushGaugeName(f.lid))}</span>` +
      `<span class="push-g-tiers" role="group">${tierBtns(f.lid, f.tier, 'push-g-tier')}` +
        `<button type="button" class="push-chip push-g-remove" data-lid="${esc(f.lid)}" aria-label="${esc(t('push.manage.removearia').replace('{g}', pushGaugeName(f.lid)))}">✕</button>` +
      '</span>' +
    '</div>').join('');
  const atCap = prefs.gauges.length >= PUSH_MAX_GAUGES;
  let pickerRows = '';
  if (!atCap) {
    const c = state.map && state.map.getCenter ? state.map.getCenter() : null;
    const lat = c ? c.lat : CONFIG.center[0];
    const lon = c ? c.lng : CONFIG.center[1];
    let nearby = pushNearbyGauges(state.gauges, prefs.gauges, lat, lon, 8);
    if (pushManagePreselect && !prefs.gauges.some((f) => f.lid === pushManagePreselect)) {
      const pre = (state.gauges || []).find((g) => String(g.lid).toUpperCase() === pushManagePreselect);
      if (pre) {
        nearby = nearby.filter((x) => String(x.g.lid).toUpperCase() !== pushManagePreselect);
        nearby.unshift({ g: pre, dist: null });
        nearby = nearby.slice(0, 8);
      }
    }
    const row = ({ g, dist }) => {
      const lid = String(g.lid).toUpperCase();
      return `<div class="push-g-row push-nearby-row${pushManagePreselect === lid ? ' preselect' : ''}" data-lid="${esc(lid)}">` +
        `<span class="push-g-name">${esc(g.name)}${Number.isFinite(dist) ? ` <span class="push-g-dist">${dist.toFixed(1)} mi</span>` : ''}</span>` +
        `<span class="push-g-tiers" role="group">${tierBtns(lid, null, 'push-g-follow')}</span>` +
      '</div>';
    };
    // four is what fits beside the honesty text on a landscape phone; the rest stay one tap away
    pickerRows = nearby.slice(0, PUSH_NEARBY_SHOWN).map(row).join('');
    const rest = nearby.slice(PUSH_NEARBY_SHOWN);
    if (rest.length) {
      pickerRows += `<details class="push-more" id="push-nearby-more"${pushNearbyMore ? ' open' : ''}>` +
        `<summary>${esc(t('push.manage.more').replace('{n}', String(rest.length)))}</summary>` +
        rest.map(row).join('') +
      '</details>';
    }
  }
  return '<div class="push-manage">' +
    `<div class="push-m-title">${esc(t('push.manage.followed'))}</div>` +
    (followedRows || `<div class="push-m-note">${esc(t('push.manage.none'))}</div>`) +
    `<div class="push-m-note">${esc(t('push.manage.hint'))}</div>` +
    (atCap
      ? `<div class="push-m-note">${esc(t('push.manage.limit'))}</div>`
      : `<div class="push-m-title">${esc(t('push.manage.nearby'))}</div>${pickerRows || `<div class="push-m-note">${esc(t('push.manage.nogauges'))}</div>`}`) +
    `<div class="card-actions"><button type="button" class="act-btn push-unsub-all" id="push-unsub-all">${esc(t('push.manage.unsuball'))}</button></div>` +
  '</div>';
}

const PUSH_PLACE_MI = [5, 10, 25];   // display units, parallel to PUSH_PLACE_KM

function pushRadiusLabel(km) {
  const i = PUSH_PLACE_KM.indexOf(Number(km));
  return `${PUSH_PLACE_MI[i >= 0 ? i : 1]} ${t('risk.mi')}`;
}

// the row shows exactly what is stored: the rounded pair and the radius, no label
function pushPlaceLabel(p) {
  return `${p.lat.toFixed(PUSH_PLACE_DP)}, ${p.lon.toFixed(PUSH_PLACE_DP)}`;
}

// saved my-places that are not already an alert place, offered as an explicit copy: the label
// stays on the device and only the rounded coordinates travel
function pushSavedCandidates(places) {
  return loadPlaces()
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon)
      && !(places || []).some((p) => distMi(p.lat, p.lon, s.lat, s.lon) < 0.7))
    .slice(0, 5);
}

// the alert-area editor: the points this subscription is scoped to, their radius, and the two
// explicit ways to add one (a fresh position fix, or a copy of a saved place)
function pushPlacesHtml(prefs) {
  const places = prefs.places || [];
  const atCap = places.length >= PUSH_MAX_PLACES;
  const radiusBtns = (i, km) => PUSH_PLACE_KM.map((k) =>
    `<button type="button" class="push-chip push-p-radius${k === km ? ' active' : ''}" data-i="${i}" data-km="${k}" aria-pressed="${k === km}">${esc(pushRadiusLabel(k))}</button>`).join('');
  const rows = places.map((p, i) =>
    `<div class="push-g-row" data-i="${i}">` +
      `<span class="push-g-name">${esc(pushPlaceLabel(p))}</span>` +
      `<span class="push-g-tiers" role="group">${radiusBtns(i, p.km)}` +
        `<button type="button" class="push-chip push-p-remove" data-i="${i}" aria-label="${esc(t('push.places.removearia').replace('{n}', String(i + 1)))}">✕</button>` +
      '</span>' +
    '</div>').join('');
  const savedRow = atCap ? '' : pushSavedCandidates(places).map((s, i) =>
    `<button type="button" class="push-chip push-p-saved" data-i="${i}">+ ${esc(s.label || pushPlaceLabel(s))}</button>`).join('');
  return '<div class="push-places">' +
    `<div class="push-m-title">${esc(t('push.places.title'))}</div>` +
    (rows || `<div class="push-m-note">${esc(t('push.places.none'))}</div>`) +
    (atCap
      ? `<div class="push-m-note">${esc(t('push.places.limit'))}</div>`
      : `<div class="card-actions"><button type="button" class="act-btn" id="push-place-geo">${esc(t('push.places.add'))}</button></div>` +
        (savedRow ? `<div class="push-m-note">${esc(t('push.places.saved'))}</div><div class="push-p-saved-row">${savedRow}</div>` : '')) +
    (pushPlaceMsg ? `<div class="push-fix">${esc(pushPlaceMsg)}</div>` : '') +
    `<div class="push-m-note">${esc(t('push.places.store'))}</div>` +
  '</div>';
}

// the pending-follow explanation, or '' when the tap will really open the picker
function pushPendingHtml(cardState, preselect) {
  if (!pushFollowPending(cardState, preselect)) return '';
  return `<div class="push-m-note">${esc(t('push.manage.pending').replace('{g}', pushGaugeName(preselect)))}</div>`;
}

// the board could not reach its own status endpoint: say that, rather than rendering nothing and
// letting #push-body:empty read as "this board has no device alerts"
function pushRenderUnreachable(host) {
  host.innerHTML = `<div class="push-fix">${esc(t('push.unreachable'))}</div>`;
  pushSyncEntries('unreachable', false);
}

/* The gear row and the Alerts-tab row both publish the card's own state, so neither can claim
   coverage the card is refusing to claim. `silent` carries the v0.99.65 rule outward: a
   subscription that can deliver nothing never reads as ON anywhere on the board. */
function pushEntryStateKey(cardState, deliversAny) {
  if (cardState === 'unreachable') return 'push.unreachable';
  return cardState === 'on' && !deliversAny ? 'push.state.silent' : `push.state.${cardState}`;
}

// Only the two render paths call this, and both run behind initPushCard's backend check, so the
// Alerts-tab row appears only on a board that really has alert delivery wired.
function pushSyncEntries(cardState, deliversAny) {
  const txt = t(pushEntryStateKey(cardState, deliversAny));
  const chip = $('#notify-state');
  if (chip) chip.textContent = ` · ${txt}`;
  const sub = $('#alerts-notify-sub');
  if (sub) sub.textContent = txt;
  const row = $('#alerts-notify-row');
  if (row) row.hidden = false;
}

/* Collapsed-pane summaries. Each says what is really set, so a closed accordion never hides a
   degraded setting behind a reassuring label. */
function pushWhereSummary(prefs, scopeState) {
  if (prefs.scope === 'statewide') return t('push.scope.statewide');
  if (prefs.scope === 'places' && scopeState === 'ok') return t('push.scope.places');
  return t('push.sum.unset');
}

function pushWhatSummary(prefs) {
  const parts = [];
  if (prefs.ffe) parts.push(t('push.sum.ffe'));
  if (prefs.tier) parts.push(t('push.sum.gauges').replace('{t}', t(`push.tier.${prefs.tier}`)));
  return parts.length ? parts.join(' · ') : t('push.sum.nothing');
}

function pushGaugesSummary(prefs) {
  const n = prefs.gauges.length;
  return n ? t('push.sum.followed').replace('{n}', String(n)) : t('push.sum.none');
}

function renderPushCard() {
  const host = $('#push-body');
  if (!host) return;
  const facts = pushEnvFacts();
  const st = pushCardState(facts);
  const on = st === 'on';
  const toggleable = st === 'on' || st === 'off';
  // the header gear wears the alerts dot only where this device could actually subscribe and has
  // not; 'ios'/'blocked'/'unsupported' get no nudge toward a door that will not open for them
  if (window.setAlertsCta) setAlertsCta(st === 'off');
  const prefs = pushPrefs();
  const scopeState = pushScopeState(prefs);
  const delivers = pushDelivers(prefs, scopeState);
  const fresh = pushFreshState(state.pushLastEval, Date.now());
  const freshTxt = fresh === 'ok'
    ? t('push.fresh.ok').replace('{m}', String(Math.max(0, Math.round((Date.now() - state.pushLastEval) / 60000))))
    : t('push.fresh.stale');
  const fixKey = pushFixKey(st);
  const kept = prefs.gauges.length > 0 || prefs.places.length > 0 || prefs.scope !== 'none';
  // segmented option: one exclusive choice per row, .ls-base-btn so it clears 44px and wraps in
  // Spanish. .push-opt stays the behaviour hook every tap handler below binds on.
  const opt = (group, val, active, label) =>
    `<button type="button" class="ls-base-btn push-opt${active ? ' on' : ''}" data-pref="${group}:${val}" aria-pressed="${active}">${esc(label)}</button>`;
  const typeRow = (key, opts) =>
    `<div class="push-type-row"><span class="push-type-lbl" id="push-t-${key}">${esc(t(`push.type.${key}`))}</span>` +
      `<div class="ls-base push-type-opts" role="group" aria-labelledby="push-t-${key}">${opts}</div></div>`;
  // the pane header already names this one, so a visible label would read "Where / Where"
  const baseGroup = (label, opts) =>
    `<div class="ls-base push-type-opts" role="group" aria-label="${esc(label)}">${opts}</div>`;
  // a boolean deserves a switch, and push.type.ffe is the longest Spanish string here: a chip pair
  // would overflow the row where a full-width .ls-row does not
  const ffeRow = () =>
    `<button type="button" class="ls-row push-opt${prefs.ffe ? ' on' : ''}" data-pref="ffe:${prefs.ffe ? 'off' : 'on'}" role="switch" aria-checked="${prefs.ffe}">` +
      '<span class="ls-icon" aria-hidden="true">⚠️</span>' +
      `<span class="ls-txt"><span class="ls-name">${esc(t('push.type.ffe'))}</span></span>` +
      '<span class="ls-knob"></span>' +
    '</button>';
  const sec = (key, icon, label, summary, body) =>
    `<button type="button" class="ls-row push-sec" data-sec="${key}" aria-expanded="${pushSection === key}">` +
      `<span class="ls-icon" aria-hidden="true">${icon}</span>` +
      `<span class="ls-txt"><span class="ls-name">${esc(label)}</span><span class="ls-sub">${esc(summary)}</span></span>` +
      `<span class="ls-knob ls-go" aria-hidden="true">${pushSection === key ? '⌄' : '›'}</span>` +
    '</button>' +
    (pushSection === key ? `<div class="push-sec-body">${body()}</div>` : '');
  host.innerHTML =
    '<div class="push-card">' +
      // state and switch first: the glanceable truth and the one control, before any prose
      '<div class="push-head">' +
        `<div class="push-status push-${on && !delivers.any ? 'silent' : st}">${esc(t(on && !delivers.any ? 'push.state.silent' : `push.state.${st}`))}</div>` +
        (toggleable ? `<button type="button" class="act-btn push-toggle" id="push-toggle">${esc(t(on ? 'push.toggle.off' : 'push.toggle.on'))}</button>` : '') +
      '</div>' +
      (fixKey ? `<div class="push-fix">${esc(t(fixKey))}</div>` : '') +
      (st === 'ios' ? `<div class="push-fix">${esc(t('push.fix.ios.steps'))}</div>` : '') +
      pushPendingHtml(st, pushManagePreselect) +
      // never asked yet: the pitch and the switch, nothing else. Settings are meaningless without a
      // subscription and they were the bulk of the wall this rework exists to remove.
      (st === 'off' ? `<div class="push-pitch">${esc(t('push.pitch'))}</div>` : '') +
      // only where the browser has never been asked: after a grant the prompt does not return
      (st === 'off' && facts.permission === 'default' ? `<div class="push-fix">${esc(t('push.pitch.next'))}</div>` : '') +
      (st === 'off' && kept ? `<div class="push-fix">${esc(t('push.off.kept'))}</div>` : '') +
      // single-open accordion. Where before What, because where you want alerts decides whether
      // any of the types can fire at all.
      (on
        ? '<div class="push-types" role="group" aria-label="' + esc(t('push.types.label')) + '">' +
            sec('where', '📍', t('push.type.scope'), pushWhereSummary(prefs, scopeState), () =>
              baseGroup(t('push.type.scope'),
                opt('scope', 'none', prefs.scope !== 'statewide' && prefs.scope !== 'places', t('push.opt.off')) +
                opt('scope', 'statewide', prefs.scope === 'statewide', t('push.scope.statewide')) +
                opt('scope', 'places', prefs.scope === 'places', t('push.scope.places'))) +
              // an area that cannot cover anything says so where the choice is made: the card never
              // shows alert types as live when nothing they describe can reach this device
              (scopeState !== 'ok' ? `<div class="push-fix">${esc(t(`push.scope.${scopeState}`))}</div>` : '') +
              (prefs.scope === 'places' ? pushPlacesHtml(prefs) : '')) +
            sec('what', '⚠️', t('push.sec.what'), pushWhatSummary(prefs), () =>
              ffeRow() +
              typeRow('gauges', opt('tier', 'off', !prefs.tier, t('push.opt.off')) +
                opt('tier', 'moderate', prefs.tier === 'moderate', t('push.tier.moderate')) +
                opt('tier', 'major', prefs.tier === 'major', t('push.tier.major'))) +
              // a covering area with every type off is the one silent case the scope note misses
              (scopeState === 'ok' && !delivers.any ? `<div class="push-fix">${esc(t('push.silent.types'))}</div>` : '')) +
            sec('gauges', '🔔', t('push.manage.followed'), pushGaugesSummary(prefs), () => pushManageHtml(prefs)) +
          '</div>'
        : '') +
      (fresh ? `<div class="push-fresh push-fresh-${fresh}">${esc(freshTxt)}</div>` : '') +
      `<div class="push-note">${esc(t('push.note'))}</div>` +
      `<details class="push-about" id="push-about"${pushAboutOpen ? ' open' : ''}>` +
        `<summary>${esc(t('push.about'))}</summary>` +
        `<div class="push-sub">${esc(t('push.sub'))}</div>` +
        `<div class="push-disclaimer">${esc(t('push.disclaimer'))}</div>` +
      '</details>' +
    '</div>';
  pushSyncEntries(st, delivers.any);
  host.querySelectorAll('.push-sec[data-sec]').forEach((el) => {
    el.addEventListener('click', () => {
      const key = el.getAttribute('data-sec');
      pushSection = pushSection === key ? '' : key;
      if (pushSection !== 'gauges') pushManagePreselect = null;
      renderPushCard();
    });
  });
  const more = $('#push-nearby-more');
  if (more) {
    let seen = pushNearbyMore;
    more.addEventListener('toggle', () => {
      if (more.open === seen) return;
      seen = more.open;
      pushNearbyMore = more.open;
    });
  }
  const btn = $('#push-toggle');
  if (btn) btn.addEventListener('click', on ? pushDisable : pushEnable);
  const about = $('#push-about');
  if (about) {
    // inserting an already-open <details> fires toggle too, which would latch the flag on
    let shown = pushAboutOpen;
    about.addEventListener('toggle', () => {
      if (about.open === shown) return;
      shown = about.open;
      pushAboutOpen = about.open;
    });
  }
  host.querySelectorAll('.push-opt[data-pref]').forEach((el) => {
    const [group, val] = String(el.getAttribute('data-pref')).split(':');
    el.addEventListener('click', () => pushOptTap(group, val));
  });
  host.querySelectorAll('.push-g-tier, .push-g-follow').forEach((el) => {
    el.addEventListener('click', () => pushFollowGauge(el.getAttribute('data-lid'), el.getAttribute('data-tier')));
  });
  host.querySelectorAll('.push-g-remove').forEach((el) => {
    el.addEventListener('click', () => pushUnfollowGauge(el.getAttribute('data-lid')));
  });
  host.querySelectorAll('.push-p-radius').forEach((el) => {
    el.addEventListener('click', () => pushSetPlaceRadius(+el.getAttribute('data-i'), +el.getAttribute('data-km')));
  });
  host.querySelectorAll('.push-p-remove').forEach((el) => {
    el.addEventListener('click', () => pushRemovePlace(+el.getAttribute('data-i')));
  });
  host.querySelectorAll('.push-p-saved').forEach((el) => {
    el.addEventListener('click', () => pushAddSavedPlace(+el.getAttribute('data-i')));
  });
  const geo = $('#push-place-geo');
  if (geo) geo.addEventListener('click', pushAddMyLocation);
  const unsub = $('#push-unsub-all');
  if (unsub) unsub.addEventListener('click', pushDisable);
}

// alert places: added only by an explicit tap, stored rounded, removable one by one
function pushAddPlace(lat, lon) {
  const p = pushPrefs();
  if (p.places.length >= PUSH_MAX_PLACES) return;
  p.places = pushNormalizePlaces(p.places.concat([{ lat, lon, km: PUSH_PLACE_KM_DEFAULT }]));
  p.scope = 'places';
  pushPlaceMsg = '';
  pushSetPrefs(p);
}

// a fresh fix taken for this purpose only: maximumAge 0 refuses a position the browser cached
// for Drive Mode or team sharing, so nothing captured elsewhere is silently reused here
function pushAddMyLocation() {
  if (!navigator.geolocation) { pushPlaceMsg = t('push.places.geoerr'); renderPushCard(); return; }
  const btn = $('#push-place-geo');
  if (btn) btn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => pushAddPlace(pos.coords.latitude, pos.coords.longitude),
    () => { pushPlaceMsg = t('push.places.geoerr'); renderPushCard(); },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 0 },
  );
}

// an explicit copy of a saved my-place: the label stays local, only the rounded pair travels
function pushAddSavedPlace(i) {
  const s = pushSavedCandidates(pushPrefs().places)[i];
  if (s) pushAddPlace(s.lat, s.lon);
}

function pushSetPlaceRadius(i, km) {
  const p = pushPrefs();
  if (!p.places[i] || p.places[i].km === km) return;
  p.places[i].km = km;
  pushSetPrefs(p);
}

function pushRemovePlace(i) {
  const p = pushPrefs();
  if (!p.places[i]) return;
  p.places.splice(i, 1);
  pushPlaceMsg = '';
  pushSetPrefs(p);
}

// follow (or retier) a gauge; the worker enforces the cap and lid shape authoritatively
function pushFollowGauge(lid, tier) {
  const id = String(lid || '').toUpperCase();
  const p = pushPrefs();
  const hit = p.gauges.find((g) => g.lid === id);
  if (hit) {
    if (hit.tier === tier) return; // already at that tier
    hit.tier = tier;
  } else {
    if (p.gauges.length >= PUSH_MAX_GAUGES) return; // card shows the limit note
    p.gauges.push({ lid: id, tier });
  }
  pushSetPrefs(p);
}

function pushUnfollowGauge(lid) {
  const id = String(lid || '').toUpperCase();
  const p = pushPrefs();
  p.gauges = p.gauges.filter((g) => g.lid !== id);
  if (pushManagePreselect === id) pushManagePreselect = null;
  pushSetPrefs(p);
}

// "Notify me" entry point (gauge popup / hydrograph modal): open the notify sheet on the followed
// gauges pane with that gauge pinned atop the picker. Never auto-follows: the tier tap is the
// choice, and it is the one intent-based exception to the all-panes-closed default.
function pushManageAvailable() {
  return Boolean(state.pushVapidKey); // set only for a device that can really subscribe, with a configured backend
}

function pushOpenManageFor(lid) {
  pushManagePreselect = String(lid || '').toUpperCase();
  openNotifySheet('gauges');
  const row = document.querySelector(`#push-body .push-g-row[data-lid="${pushManagePreselect}"]`);
  if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
}

// segmented per-type rows: each option SETS its value rather than toggling, so the gauge row's
// three rungs stay one exclusive choice (moderate is a lower rung of major, not a second stream)
function pushOptTap(group, val) {
  const p = pushPrefs();
  if (group === 'ffe') p.ffe = val === 'on';
  else if (group === 'tier') p.tier = val === 'off' ? null : val;
  else if (group === 'scope') {
    p.scope = PUSH_SCOPES.indexOf(val) >= 0 ? val : 'none';
    if (p.scope !== 'places') p.places = []; // leaving the places area drops the points it stored
  }
  else return;
  pushSetPrefs(p);
}

// persist a prefs change server-side (subscribe upserts by endpoint); local cache only on success
async function pushSetPrefs(prefs) {
  const next = pushNormalizePrefs(prefs);
  try {
    const reg = state.swReg || await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    // prefs are the device's own record and survive every turn-off path, so re-enabling restores
    // them; a bare {on:false} here wiped followed gauges and alert places with no way back
    if (!sub) { pushLocalSet({ on: false, prefs: pushPrefs() }); renderPushCard(); return; }
    const r = await fetch('api/push/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), prefs: next, lang: getLang() }),
    });
    if (!r.ok) throw new Error(`subscribe HTTP ${r.status}`);
    pushLocalSet({ on: true, prefs: next });
    pushSwMirror(state.pushVapidKey, next);
  } catch (err) { /* server unreachable — chips fall back to the last stored prefs */ }
  renderPushCard();
}

async function pushEnable() {
  const btn = $('#push-toggle');
  if (btn) btn.disabled = true;
  try {
    // permission is requested ONLY here, inside the explicit tap, with the disclaimer on screen
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { renderPushCard(); return; }
    const reg = state.swReg || await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKeyBytes(state.pushVapidKey) });
    const prefs = pushPrefs(); // restore this device's last prefs; a first subscribe has no alert area yet
    const r = await fetch('api/push/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), prefs, lang: getLang() }),
    });
    if (!r.ok) throw new Error(`subscribe HTTP ${r.status}`);
    pushLocalSet({ on: true, prefs });
    // lang/key/prefs mirror for the SW's payload-free fallback + rotation self-heal; best-effort
    await pushSwMirror(state.pushVapidKey, prefs);
    renderPushCard();
  } catch (err) {
    renderPushCard();
    const status = document.querySelector('#push-body .push-status');
    if (status) status.textContent = t('push.err');
  }
}

async function pushDisable() {
  // both sides always attempted; either alone is safe (a dangling server row dies on 404/410 or TTL)
  try {
    const reg = state.swReg || await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      try {
        await fetch('api/push/unsubscribe', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
      } catch (err) { /* server delete failed — TTL/410 cleanup covers it */ }
      try { await sub.unsubscribe(); } catch (err) { /* browser refusal — server row already gone */ }
    }
  } catch (err) { /* no registration — nothing to tear down */ }
  // the server row is gone, but this device keeps its own settings so re-enabling restores them
  pushLocalSet({ on: false, prefs: pushPrefs() });
  renderPushCard();
}

// repaint an ALREADY rendered card after a background prefs sync, so a device whose stored
// settings differ from its local cache never keeps reading the stale claim. Never paints a card
// that the backend check has not admitted yet (an empty host means initPushCard has not passed).
function pushRerender() {
  const host = $('#push-body');
  if (host && host.firstChild) renderPushCard();
}

// silent boot-time keepalive + self-heal for subscribed devices (runs regardless of ?push=1):
// renew the TTL and sync prefs from the authoritative server row; transparently re-subscribe
// when the browser subscription vanished or the VAPID key rotated (spec §4.4); flip the card
// off honestly (prefs kept locally) when permission was revoked.
async function pushBootSync() {
  if (pushLocal().on !== true) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !window.isSecureContext) return;
  try {
    const reg = state.swReg || await navigator.serviceWorker.ready;
    const perm = 'Notification' in window ? Notification.permission : 'default';
    const sub = await reg.pushManager.getSubscription();
    let vapidKey = state.pushVapidKey || null;
    if (!vapidKey) {
      try {
        const r = await fetch('api/push/status');
        if (r.ok) {
          const d = await r.json();
          if (d && d.configured && d.vapidKey) vapidKey = d.vapidKey;
        }
      } catch (err) { /* status unreachable — fall through to the plain renew path */ }
    }
    const keyMatches = sub && vapidKey ? pushKeysMatch(sub.options.applicationServerKey, pushKeyBytes(vapidKey)) : null;
    const plan = pushBootPlan({ localOn: true, permission: perm, hasSub: Boolean(sub), keyMatches });
    if (plan === 'off') { pushLocalSet({ on: false, prefs: pushPrefs() }); return; }
    if (plan === 'resubscribe' || plan === 'rekey') {
      if (!vapidKey) return; // cannot mint a subscription without the served key; next boot retries
      if (plan === 'rekey' && sub) {
        try { await sub.unsubscribe(); } catch (err) { /* stale sub — the fresh subscribe replaces it */ }
      }
      const fresh = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKeyBytes(vapidKey) });
      const prefs = pushPrefs();
      const r = await fetch('api/push/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: fresh.toJSON(), prefs, lang: getLang() }),
      });
      if (r.ok) {
        pushLocalSet({ on: true, prefs });
        await pushSwMirror(vapidKey, prefs);
      }
      return;
    }
    if (plan === 'renew' && sub) {
      const r = await fetch('api/push/renew', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      if (r.ok) {
        const d = await r.json();
        // renew doubles as the endpoint-authenticated self-lookup: server prefs are authoritative
        if (d && d.prefs) {
          pushLocalSet({ on: true, prefs: pushNormalizePrefs(d.prefs) });
          pushRerender();
        }
      } else if (r.status === 404) {
        // server row gone (expiry / rotation cleanup) but the browser sub lives: re-upsert
        await fetch('api/push/subscribe', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub.toJSON(), prefs: pushPrefs(), lang: getLang() }),
        });
      }
      if (vapidKey) await pushSwMirror(vapidKey, pushPrefs());
    }
  } catch (err) { /* self-heal is best-effort; the 60-day TTL and the next boot repair it */ }
}

async function initPushCard() {
  pushBootSync();
  const host = $('#push-body');
  if (!host) return;
  const facts = pushEnvFacts();
  facts.flagged = new URLSearchParams(location.search).has('push');
  facts.subscribed = pushLocal().on === true;
  if (!pushCardVisible(facts)) return;
  // every state is gated on the backend really being there (503/absent hides the card): an
  // install hint or a blocked notice would otherwise advertise a channel that is not wired
  /* An absent backend and an unreachable one are different facts (E1). A 503 is how this board
     says "not wired", and hiding the card for it is deliberate. A transport failure or any other
     bad status means we do not know, and silence would publish "this board has no device alerts". */
  let d = null;
  try {
    const r = await fetch('api/push/status');
    if (r.ok) d = await r.json();
    else if (r.status !== 503) return pushRenderUnreachable(host);
  } catch { return pushRenderUnreachable(host); }
  if (!d || !d.configured || !d.vapidKey) return;
  const st = pushCardState(facts);
  if (st === 'on' || st === 'off') {
    state.pushVapidKey = d.vapidKey; // only a device that can really subscribe gets the gauge bells
    // the freshness chip describes a channel this device is on; on an install hint or a blocked
    // notice it would read as "you are getting these", so it stays with the toggleable states
    state.pushLastEval = typeof d.lastEval === 'number' ? d.lastEval : 0;
    // browser truth wins over the local cache: a revoked subscription flips the card OFF honestly
    try {
      const reg = state.swReg || await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub && pushLocal().on) pushLocalSet({ on: false, prefs: pushPrefs() });
      if (sub && !pushLocal().on) pushLocalSet({ on: true, prefs: pushPrefs() });
    } catch (err) { /* registration unavailable — local cache stands */ }
  }
  renderPushCard();
}
