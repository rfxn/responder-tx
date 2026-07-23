'use strict';

const CACHE_KEY = 'respondertx.cache.v1';
function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      ts: Date.now(),
      gauges: state.gauges,
      alertsSlim: state.alerts.map((f) => ({ id: f.id, _sev: f._sev, properties: { event: f.properties.event, areaDesc: f.properties.areaDesc, expires: f.properties.expires }, geometry: null })),
    }));
  } catch { /* quota exceeded — cache is best-effort */ }
}
function hydrateFromCache() {
  let c;
  try { c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { c = null; }
  if (!c) return false;
  if (!state.gauges.length && c.gauges) { state.gauges = c.gauges; renderGauges(); renderGaugesTab(); }
  if (!state.alerts.length && c.alertsSlim) { state.alerts = c.alertsSlim; renderAlertList(); }
  renderTiles();
  $('#refresh-note').textContent = `offline · cached as of ${fmtWhen(new Date(c.ts).toISOString())}`;
  return true;
}

// cold-start fallback: ops cycles publish a ≤15-min NWPS snapshot — fresh public visitors survive rate-limit windows
async function hydrateGaugesSnapshot() {
  if (state.gauges.length) return false;
  try {
    const d = await fetch(`data/gauges-snapshot.json?_=${Date.now()}`).then((r) => (r.ok ? r.json() : null));
    if (state.gauges.length) return false; // a live NWPS refresh resolved during the fetch — never revert fresh gauges to snapshot
    if (!d || !d.gauges || !d.gauges.length) return false;
    state.gauges = d.gauges.filter((g) => {
      const c = g.status && g.status.observed && g.status.observed.floodCategory;
      return c && !['out_of_service', 'obs_not_current', 'not_defined'].includes(c);
    });
    state.snapshotAt = new Date(d.generated).getTime();
    recordTrends();
    renderGauges();
    renderGaugesTab();
    renderForecastList();
    renderTiles();
    $('#refresh-note').textContent = `gauges from snapshot · ${fmtWhen(d.generated)}`;
    return true;
  } catch { return false; } // snapshot absent (old deploy) — nothing to hydrate
}

async function refresh() {
  // in-flight guard: overlapping triggers (interval, #refresh-now, visibility catch-up) queue one trailing run instead of racing
  if (state.refreshBusy) { state.refreshQueued = true; return; }
  state.refreshBusy = true;
  try {
    $('#refresh-note').textContent = 'refreshing…';
    if (state.refreshRadar) state.refreshRadar();
    if (state.layers.tropical && state.map.hasLayer(state.layers.tropical)) fetchTropical().catch(() => { /* keep last cone/track on a transient failure */ });
    const gaugesP = fetchGauges();
    // fcstMax/usgs dedupe against state.gauges — run after the NWPS fetch settles either way
    const afterGauges = gaugesP.catch(() => { /* NWPS failure reported via gaugesP; dedupe uses last-known gauges */ });
    const results = await Promise.allSettled([fetchAlerts(), gaugesP, afterGauges.then(fetchFcstMax), afterGauges.then(fetchUsgsIv), fetchLsrs(), loadSeeds(), fetchRoadClosures()]);
    const SOURCE_NAMES = ['NWS alerts', 'NWPS gauges', 'RFC forecast', 'USGS stage', 'storm reports', 'board data', 'TxDOT roads'];
    const failed = results.filter((r) => r.status === 'rejected');
    const failedNames = results.map((r, i) => (r.status === 'rejected' ? SOURCE_NAMES[i] : null)).filter(Boolean).join(', ');
    state.refreshAt = Date.now() + CONFIG.refreshMs;
    if (failed.length && (!state.alerts.length || !state.gauges.length)) {
      const hydrated = hydrateFromCache();
      const snapped = await hydrateGaugesSnapshot();
      renderSourceHealth();
      checkAppVersion(); // degraded clients must still learn of updates
      if (!hydrated && !snapped) $('#refresh-note').textContent = `degraded: ${failedNames}`;
      return;
    }
    if (!failed.length) saveCache();
    renderSourceHealth();
    checkAppVersion();
    if (failed.length) $('#refresh-note').textContent = `degraded: ${failedNames}`;
    else $('#refresh-note').innerHTML = `<span class="fresh-dot fresh"></span> ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })} CT`;
  } finally {
    state.refreshBusy = false;
    if (state.refreshQueued) { state.refreshQueued = false; refresh(); }
  }
}

function markHealthy(source) { state.sourceHealth[source] = Date.now(); }

// "updated H:MM CT · next in M:SS"; same countdown math as tickCountdown, empty before the first refresh
function feedStatusText() {
  if (!state.refreshAt) return '';
  const updated = new Date(state.refreshAt - CONFIG.refreshMs)
    .toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
  const s = Math.max(0, Math.round((state.refreshAt - Date.now()) / 1000));
  const next = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return t('health.status').replace('{time}', updated).replace('{next}', next);
}

// compact colored chip row headlining Resources; life-safety sources first, then the rest
function renderSourceHealth() {
  const el = $('#source-health');
  if (!el) return; // called before seeds load
  const sources = [['alerts', t('health.alerts')], ['gauges', t('health.gauges')], ['roads', t('health.roads')],
    ['fcstMax', t('health.fcst')], ['usgs', t('health.usgs')], ['lsrs', t('health.reports')], ['seeds', t('health.board')]];
  const chips = sources.map(([k, label]) => {
    const ts = state.sourceHealth[k];
    const age = ts ? (Date.now() - ts) / 60000 : Infinity;
    const cls = age < 10 ? 'fresh' : age < 30 ? 'aging' : 'stale';
    const when = ts ? ` ${Math.round(age)}m` : '';
    return `<span class="feed-chip"><span class="fresh-dot ${cls}"></span>${esc(label)}${when}</span>`;
  }).join(' · ');
  el.innerHTML = `<div class="section-title">${esc(t('health.title'))}</div>` +
    `<div class="feed-chips">${chips}</div>` +
    `<div class="feed-status" id="feed-status">${esc(feedStatusText())}</div>`;
}

// long-lived tabs run old code forever — badge immediately, then roll to the new build once fully idle
async function checkAppVersion() {
  try {
    const d = await fetch(`data/changelog.json?_=${Date.now()}`).then((r) => (r.ok ? r.json() : null));
    const latest = d && d.versions && d.versions[0] && d.versions[0].v;
    if (!latest || latest === APP_VERSION) return;
    $('#update-chip').hidden = false;
    armRollover(latest);
  } catch { /* offline — no update signal */ }
}

/* ---------- graceful update rollover — capture view, wait for idle, reload, restore ---------- */

const ROLL_STATE_KEY = 'respondertx.rollView';
const ROLL_DONE_KEY = 'respondertx.rolledTo';
const ROLL_IDLE_MS = 20000;
const ROLL_POSTPONE_MS = 300000;
const ROLL_HOLD_MS = 600000;

function armRollover(latest) {
  let rolled = null;
  try { rolled = JSON.parse(sessionStorage.getItem(ROLL_DONE_KEY) || 'null'); } catch { rolled = null; }
  // already rolled to this version but still booted the old build (CDN lag) — hold 10 min, never reload-loop
  if (rolled && rolled.v === latest && Date.now() - rolled.t < ROLL_HOLD_MS) return;
  state.updateTarget = latest;
  if (!state.rollTimer) state.rollTimer = setInterval(tryRollover, 5000);
}

// truthy = the user is mid-something; the 5s poll retries until fully idle
function rolloverBusy() {
  if (document.visibilityState === 'hidden') return 'hidden';
  if (state.refreshBusy) return 'refresh';
  if (Date.now() - (state.lastInteract || 0) < ROLL_IDLE_MS) return 'input';
  if (Date.now() < (state.rollPostponedUntil || 0)) return 'postponed';
  for (const id of ['#safety-modal', '#onboard', '#hydro-modal', '#alert-modal', '#risk-modal', '#changelog-modal', '#glossary-modal', '#summary-view', '#drive-mode', '#cam-viewer', '#layer-sheet']) {
    const el = $(id);
    if (el && !el.hidden) return id;
  }
  if (!$('#playback-bar').hidden) return 'playback';
  if ($('#new-request-form').classList.contains('open')) return 'intake';
  if ($('#hsearch').classList.contains('open')) return 'search';
  const chatPanel = document.getElementById('chat-panel');
  if (chatPanel && !chatPanel.hidden) return 'chat';
  return '';
}

function tryRollover() {
  if (!state.updateTarget || state.rollToastTimer || rolloverBusy()) return;
  $('#update-toast-text').textContent = t('update.reloading').replace('{v}', state.updateTarget);
  $('#update-toast-later').hidden = false;
  $('#update-toast').classList.remove('confirm');
  $('#update-toast').hidden = false;
  state.rollToastTimer = setTimeout(performRollover, 4000);
}

function postponeRollover() {
  clearTimeout(state.rollToastTimer);
  state.rollToastTimer = null;
  state.rollPostponedUntil = Date.now() + ROLL_POSTPONE_MS;
  $('#update-toast').hidden = true;
}

function performRollover() {
  state.rollToastTimer = null;
  if (rolloverBusy()) { $('#update-toast').hidden = true; return; } // user re-engaged during the 4s notice — retry when idle again
  const now = Date.now();
  try { sessionStorage.setItem(ROLL_DONE_KEY, JSON.stringify({ v: state.updateTarget, t: now })); } catch { /* private mode — the header chip still offers a manual reload */ }
  try {
    const qs = buildShareUrl().split('?')[1] || '';
    sessionStorage.setItem(ROLL_STATE_KEY, JSON.stringify({ v: state.updateTarget, t: now, qs }));
    const draft = document.getElementById('chat-input');
    if (draft && draft.value.trim()) sessionStorage.setItem('respondertx.chatDraft', draft.value);
    location.replace(`${location.pathname}?${qs}`);
  } catch { location.reload(); } // serializer failed — a plain reload still fetches the new build
}

// boot-side: read+clear the blob; re-install its query string if the reload lost it
function consumeRolloverState() {
  let blob = null;
  try { blob = JSON.parse(sessionStorage.getItem(ROLL_STATE_KEY) || 'null'); } catch { blob = null; }
  try { sessionStorage.removeItem(ROLL_STATE_KEY); } catch { /* private mode */ }
  if (!blob || typeof blob !== 'object' || typeof blob.v !== 'string') return null;
  try {
    if (!location.search && blob.qs) history.replaceState(null, '', `${location.pathname}?${blob.qs}`);
  } catch { /* malformed qs — boot normally on defaults */ }
  return blob;
}

function showUpdatedConfirm() {
  $('#update-toast-text').textContent = t('update.done').replace('{v}', APP_VERSION);
  $('#update-toast-later').hidden = true;
  $('#update-toast').classList.add('confirm');
  $('#update-toast').hidden = false;
  setTimeout(() => { if ($('#update-toast').classList.contains('confirm')) $('#update-toast').hidden = true; }, 2000);
}

function tickCountdown() {
  updateDriveFreshness(); // "last fix Xs ago" ticks even before the first data refresh is scheduled
  if (!state.refreshAt) return;
  const s = Math.max(0, Math.round((state.refreshAt - Date.now()) / 1000));
  // countdown lives in the tooltip — the visible stamp stays slim; the data-age bar owns staleness
  $('#refresh-note').title = `next refresh in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const fs = $('#feed-status');
  if (fs) fs.textContent = feedStatusText(); // live-tick the Resources feed-status countdown when present
  renderDataAgeBar();
}

// when the live gauge feed dies, surface the fallback the board already holds — and stand it down on
// recovery. Offer ONCE per outage (on the stale transition), never re-add every tick, and honor a
// user dismissal (pill ✕ / sheet toggle) until the live feed recovers — else it fights the user.
function autoUsgsFallback(on) {
  const lyr = state.layers.usgs;
  if (!lyr) return false;
  if (state.pb && !state.pb.live) return false; // playback engaged — never add a live layer under a historical frame
  const was = state.usgsFeedStale || false;
  state.usgsFeedStale = on;
  if (on && !was && !state.usgsFallbackDismissed && (state.usgsSites || []).length && !state.map.hasLayer(lyr)) {
    lyr.addTo(state.map);
    state.usgsAutoOn = true;
  } else if (!on && was) {
    if (state.usgsAutoOn) {
      state.usgsAutoRemoving = true; // our own stand-down, not a user dismissal (see overlayremove)
      if (state.map.hasLayer(lyr)) state.map.removeLayer(lyr);
      state.usgsAutoRemoving = false;
      state.usgsAutoOn = false;
    }
    state.usgsFallbackDismissed = false; // feed recovered — re-arm the one-time offer for any future outage
  }
  return state.usgsAutoOn && state.map.hasLayer(lyr);
}

// stale data must never masquerade as live — full-width bar, not a muted corner note
function renderDataAgeBar() {
  const el = $('#data-age-bar');
  if (!state.alertsLoadedOnce && !state.gauges.length) { el.hidden = true; return; }
  const worst = ['gauges', 'alerts']
    .map((k) => ({ k, age: state.sourceHealth[k] ? (Date.now() - state.sourceHealth[k]) / 60000 : Infinity }))
    .sort((a, b) => b.age - a.age)[0];
  // boot grace: don't flash "NEVER LOADED" while the first fetch round is still in flight
  if (worst.age === Infinity && state.bootAt && Date.now() - state.bootAt < 25000) { el.hidden = true; return; }
  const gaugesAge = state.sourceHealth.gauges ? (Date.now() - state.sourceHealth.gauges) / 60000 : Infinity;
  const usgsOn = autoUsgsFallback(gaugesAge > 15);
  if (worst.age < 7.5) { el.hidden = true; return; }
  const label = worst.k === 'gauges' ? 'GAUGE' : 'ALERT';
  const usgsNote = usgsOn ? ' · USGS raw-stage fallback ON (no flood categories)' : '';
  let cls, text;
  if (worst.k === 'gauges' && state.snapshotAt) {
    const snapAge = Math.round((Date.now() - state.snapshotAt) / 60000);
    if (snapAge < 30) { el.hidden = true; return; } // owner: a fresh snapshot is a working state, not a warning
    cls = snapAge >= 60 ? 'red' : 'amber';
    text = `⚠ GAUGES FROM SNAPSHOT ${snapAge} MIN OLD: live NWPS feed failing${usgsNote}`;
  } else {
    cls = worst.age > 15 ? 'red' : 'amber';
    text = (worst.age === Infinity
      ? `⚠ ${label} DATA NEVER LOADED: numbers on this board exclude it`
      : `⚠ ${label} DATA ${Math.round(worst.age)} MIN OLD: refresh failing; treat as stale`) + (worst.k === 'gauges' ? usgsNote : '');
  }
  const key = `${worst.k}|${cls}`; // dismissal holds until the failing source or severity changes
  if (sessionStorage.getItem('respondertx.ageBarDismiss') === key) { el.hidden = true; return; }
  el.hidden = false;
  const sig = `${key}|${text}`; // ticks every second — only touch the DOM when the rendered content changes
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  el.className = cls;
  el.dataset.key = key;
  el.innerHTML = `<span>${esc(text)}</span><button class="age-bar-x" title="Dismiss until this changes">✕</button>`;
}

/* ---------- in-app changelog ---------- */

async function openChangelog() {
  $('#changelog-modal').hidden = false;
  localStorage.setItem('respondertx.lastVersion', APP_VERSION);
  $('#app-version').classList.remove('has-new');
  const body = $('#changelog-body');
  if (body.dataset.loaded) return;
  try {
    const data = await fetch(`data/changelog.json?_=${Date.now()}`).then((r) => r.json());
    body.innerHTML = (data.versions || []).map((v) =>
      `<div class="chg-row"><span class="chg-v">${esc(v.v)}</span><span class="chg-line">${esc(v.line)}</span></div>`).join('');
    body.dataset.loaded = '1';
  } catch { body.textContent = 'Changelog unavailable.'; }
}

/* ---------- header search — one box: place/address, "lat, lon", gauge LID/name, R-### card ID ---------- */

function searchSetOpen(open) {
  $('#hsearch').classList.toggle('open', open);
  $('#search-input').hidden = !open;
  if (open) { $('#search-input').focus(); $('#search-input').select(); }
  else { $('#search-results').hidden = true; }
}

function searchShowResults(items) {
  const el = $('#search-results');
  if (!items.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = items.map((it, i) =>
    `<button class="sr-row" data-i="${i}"><span class="sr-kind">${esc(it.kind)}</span><span class="sr-label">${esc(it.label)}</span></button>`).join('');
  el.querySelectorAll('.sr-row').forEach((b) => b.addEventListener('click', () => {
    searchSetOpen(false);
    items[+b.dataset.i].act();
  }));
}

function searchNote(text) {
  const el = $('#search-results');
  el.hidden = false;
  el.innerHTML = `<div class="sr-note">${esc(text)}</div>`;
}

// search is the typed long-press: fly there and drop the same point-inspector card
function searchGoPoint(lat, lon) {
  state.map.setView([lat, lon], 13);
  L.popup({ autoPan: false, closeButton: false, className: 'inspect-pop', maxWidth: 300 })
    .setLatLng([lat, lon])
    .setContent(inspectContent(lat, lon))
    .openOn(state.map);
  if (window.innerWidth <= 768) $('#map').scrollIntoView({ behavior: 'smooth' });
}

function searchGauges(q) {
  const ql = q.toLowerCase();
  const exact = state.gauges.filter((g) => (g.lid || '').toLowerCase() === ql);
  if (exact.length) return exact;
  return state.gauges.filter((g) => (g.name || '').toLowerCase().includes(ql)).slice(0, 5);
}

async function runHeaderSearch() {
  const raw = $('#search-input').value.trim();
  if (!raw) return;
  if (flyToRadioId(raw)) { searchSetOpen(false); return; }
  const m = raw.match(/^(-?\d{1,2}(?:\.\d+)?)[,\s]+(-?\d{1,3}(?:\.\d+)?)$/);
  if (m) {
    const lat = +m[1], lon = +m[2];
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      searchSetOpen(false);
      searchGoPoint(lat, lon);
      return;
    }
  }
  const gs = searchGauges(raw);
  if (gs.length === 1) { searchSetOpen(false); focusGauge(gs[0]); return; }
  if (gs.length > 1) {
    searchShowResults(gs.map((g) => ({ kind: t('search.gauge'), label: g.name, act: () => focusGauge(g) })));
    return;
  }
  searchNote(t('search.looking'));
  // bias to the board's AO when no state is named; the query is never stored or transmitted beyond this geocode
  const q = /\b(tx|texas)\b/i.test(raw) ? raw : `${raw}, Texas`;
  let hits = [];
  try { hits = await nominatimSearchN(q, 5); } catch { hits = []; }
  if (!hits.length) { searchNote(t('search.noresult')); return; }
  if (hits.length === 1) { searchSetOpen(false); searchGoPoint(hits[0].lat, hits[0].lon); return; }
  searchShowResults(hits.map((h) => ({ kind: t('search.place'), label: h.label, act: () => searchGoPoint(h.lat, h.lon) })));
}

function initHeaderSearch() {
  $('#search-btn').addEventListener('click', () => searchSetOpen($('#search-input').hidden));
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); runHeaderSearch(); }
  });
  $('#search-input').addEventListener('input', () => { if (!$('#search-input').value) $('#search-results').hidden = true; });
}

/* ---------- "?" glossary — every board symbol explained, built from i18n strings ---------- */

function glRow(sw, label, desc) {
  return `<div class="gl-row"><span class="gl-sw">${sw}</span><span class="gl-txt"><strong>${esc(label)}</strong>: ${esc(desc)}</span></div>`;
}

function renderGlossary() {
  const sec = (key) => `<div class="section-title">${esc(t(key))}</div>`;
  const dot = (cls) => `<span class="gauge-icon ${cls}" style="width:12px;height:12px"></span>`;
  let html = sec('glossary.sec.gauges');
  for (const cat of ['major', 'moderate', 'minor', 'action']) {
    html += glRow(dot(`cat-${cat}`), catLabel(cat), t(`glossary.cat.${cat}`));
  }
  html += glRow(dot('stale'), t('glossary.stale.label'), t('glossary.stale'));
  html += sec('glossary.sec.markers');
  html += glRow('<span style="color:var(--cat-major)">▲</span>', t('glossary.rising.label'), t('glossary.rising'));
  html += glRow('<span style="color:var(--good)">▼</span>', t('glossary.falling.label'), t('glossary.falling'));
  html += glRow(`<span class="fcst-ring cat-moderate" style="width:11px;height:11px"></span>`, t('glossary.ring.label'), t('glossary.ring'));
  html += glRow('💧', t('glossary.lsr.label'), t('glossary.lsr'));
  html += glRow('🌧', t('glossary.rain.label'), t('glossary.rain'));
  html += glRow('🌦', t('glossary.fcstradar.label'), t('glossary.fcstradar'));
  html += glRow('🌀', t('glossary.tropical.label'), t('glossary.tropical'));
  html += glRow('📷', t('glossary.cams.label'), t('glossary.cams'));
  html += glRow('<span class="cam-icon cam-snap" style="width:16px;height:16px;font-size:10px">📷</span>', t('glossary.camsnap.label'), t('glossary.camsnap'));
  html += glRow('<span style="color:var(--sev-emergency)">⛔</span>/🌊', t('glossary.roads.label'), t('glossary.roads'));
  html += glRow('<span style="color:var(--good)">✓</span>', t('glossary.reopen.label'), t('glossary.reopen'));
  html += glRow('⛔⚠✓', t('glossary.cross.label'), t('glossary.cross'));
  html += glRow('🆘', t('glossary.notice.label'), t('glossary.notice'));
  html += sec('glossary.sec.strip');
  html += `<div class="gl-note">${esc(t('glossary.strip'))}</div>`;
  for (const [glyph, key] of [['⚠', 'threat.ffemerg'], ['🆘', 'threat.life'], ['⛔', 'threat.cutoff'], ['●', 'threat.major'],
    ['▲', 'threat.tomajor'], ['⚑', 'threat.record'], ['🚧', 'threat.roads'], ['▼', 'threat.falling']]) {
    html += `<div class="gl-row gl-chip"><span class="gl-sw">${glyph}</span><span class="gl-txt">${esc(t(key))}</span></div>`;
  }
  html += sec('glossary.sec.badges');
  html += glRow(srcBadge('official'), t('src.official'), t('src.official.title'));
  html += glRow(srcBadge('curated'), t('src.curated'), t('src.curated.title'));
  html += sec('glossary.sec.aging');
  html += `<div class="gl-note">${esc(t('glossary.aging'))}</div>`;
  html += sec('glossary.sec.playback');
  html += `<div class="gl-note">${esc(t('glossary.playback'))}</div>`;
  html += sec('glossary.sec.usng');
  html += `<div class="gl-note">${esc(t('glossary.usng'))}</div>`;
  $('#glossary-body').innerHTML = html;
}

function openGlossary() {
  renderGlossary(); // rebuilt each open so a live language switch localizes it
  $('#glossary-modal').hidden = false;
}

/* ---------- first-run onboarding — 3 panels, once, chained AFTER the 911 safety ack ---------- */

const ONBOARD_KEY = 'respondertx.onboardSeen';
const OB_PANELS = 3;

// deep-link entries land somewhere specific — never interrupt them with onboarding
function onboardDeepLink() {
  const q = new URLSearchParams(location.search);
  return ['playback', 'hydro', 'view', 'fq', 'cams', 'cam', 'pbt', 'mlat', 'mlon', 'team'].some((k) => q.get(k));
}

function obGo(i) {
  state.obIdx = Math.max(0, Math.min(i, OB_PANELS - 1));
  $('#ob-panels').style.transform = `translateX(-${state.obIdx * 100}%)`;
  document.querySelectorAll('.ob-dot').forEach((d, n) => d.classList.toggle('on', n === state.obIdx));
  $('#ob-next').textContent = state.obIdx === OB_PANELS - 1 ? t('onboard.done') : t('onboard.next');
}

function obDismiss() {
  localStorage.setItem(ONBOARD_KEY, '1');
  $('#onboard').hidden = true;
}

function initOnboarding() {
  if (localStorage.getItem(ONBOARD_KEY)) return;
  if (onboardDeepLink()) { localStorage.setItem(ONBOARD_KEY, '1'); return; }
  // seen-guard: the footer strip can reopen the safety modal, whose ack click chains here
  const show = () => { if (localStorage.getItem(ONBOARD_KEY)) return; $('#onboard').hidden = false; obGo(0); };
  $('#ob-skip').addEventListener('click', obDismiss);
  $('#ob-next').addEventListener('click', () => { if (state.obIdx >= OB_PANELS - 1) obDismiss(); else obGo(state.obIdx + 1); });
  $('#ob-legend').addEventListener('click', () => { obDismiss(); openGlossary(); });
  let x0 = null;
  $('#ob-panels').addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  $('#ob-panels').addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 40) obGo(state.obIdx + (dx < 0 ? 1 : -1));
  }, { passive: true });
  // chain: the safety modal owns first contact; onboarding only ever follows its ack
  if (!localStorage.getItem('respondertx.safetyAck')) $('#safety-ack').addEventListener('click', show);
  else show();
}

/* ---------- boot ---------- */

async function loadEventConfig() {
  try {
    const ev = await fetch('data/event.json').then((r) => r.json());
    if (Array.isArray(ev.center)) CONFIG.center = ev.center;
    if (ev.zoom) CONFIG.zoom = ev.zoom;
    if (ev.gaugeBbox) CONFIG.gaugeBbox = ev.gaugeBbox;
    if (ev.name) { document.querySelector('.brand h1').textContent = ev.name; state.baseTitle = ev.name; }
    if (ev.subtitle) {
      const st = document.querySelector('.brand .sub-text');
      if (st) {
        // a curator subtitle that differs from the default is their own words — don't localize it
        if (ev.subtitle !== I18N.en['brand.sub']) st.removeAttribute('data-i18n');
        st.textContent = ev.subtitle;
      }
    }
  } catch { /* keep built-in CONFIG defaults */ }
}

// re-render the localized dynamic surfaces after a live language switch (setLang already
// re-applied the static strings and document.lang)
function relocalizeDynamic() {
  applyTheme(document.documentElement.getAttribute('data-theme'));
  renderTiles();
  renderAlertList();
  renderForecastList();
  renderGaugesTab();
  renderRequests();
  if (state.resources) { renderResources(); renderMonitors(); }
  renderCrossings();
  renderSourceHealth();
  renderLayerPills();
  if (window.renderTeamTab) renderTeamTab();
}

async function boot() {
  const rollBlob = consumeRolloverState(); // before any location.search read — may re-install the captured view params
  // whitelist both theme sources — an invalid value would wedge boot inside applyTheme's baseLayers lookup
  const themeOk = (v) => v === 'dark' || v === 'light';
  // light is the default; every prior visitor had 'dark' auto-persisted regardless of intent,
  // so clear it once — returning visitors adopt light, and an explicit re-toggle persists normally afterward
  if (!localStorage.getItem('respondertx.themeDefaultV2')) {
    localStorage.removeItem('respondertx.theme');
    localStorage.setItem('respondertx.themeDefaultV2', '1');
  }
  if (!themeOk(localStorage.getItem('respondertx.theme') || 'light')) localStorage.setItem('respondertx.theme', 'light'); // self-heal poisoned storage
  const themeParam = new URLSearchParams(location.search).get('theme');
  applyTheme(themeOk(themeParam) ? themeParam : localStorage.getItem('respondertx.theme') || 'light');
  await loadEventConfig();
  applyI18n(document);
  initMap();
  initPointInspector();
  initInViewSync();
  // modal a11y: focus-trap + inert background for every static overlay. Registered before any of
  // them can open below (safety gate, risk, onboarding). #safety-modal traps + pins focus on its ack
  // only and is deliberately never given an Escape path — the gate closes solely via #safety-ack.
  registerModal($('#safety-modal'), { initialFocus: '#safety-ack' });
  registerModal($('#onboard'));
  registerModal($('#glossary-modal'));
  registerModal($('#hydro-modal'));
  registerModal($('#alert-modal'));
  registerModal($('#cam-viewer'));
  registerModal($('#changelog-modal'));
  registerModal($('#risk-modal'), { initialFocus: '#risk-addr' });
  registerModal($('#sitrep-modal'), { initialFocus: '#sitrep-copy' });
  registerModal($('#drive-mode'));
  registerModal($('#summary-view'));
  applyTheme(document.documentElement.getAttribute('data-theme'));
  loadStore();
  loadHist();
  try { state.trendHist = JSON.parse(localStorage.getItem(TREND_KEY)) || {}; } catch { state.trendHist = {}; }

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab-body').forEach((t) => t.classList.toggle('active', t.id === b.dataset.tab));
    if (state.viewReady) saveViewState(); // skip during boot restore/URL apply — only real user taps
    if (window.innerWidth <= 768 && document.querySelector('main').classList.contains('sheet-peek')) setSheet('sheet-half');
  }));
  initSheet();
  // idle detection for the update rollover — any pointer/key/scroll marks the board busy for 20s
  state.lastInteract = Date.now();
  for (const ev of ['pointerdown', 'touchstart', 'keydown', 'wheel']) {
    window.addEventListener(ev, () => { state.lastInteract = Date.now(); }, { capture: true, passive: true });
  }
  $('#update-toast-later').addEventListener('click', postponeRollover);
  $('#update-toast').addEventListener('click', (e) => {
    if (e.target.id === 'update-toast-later') return;
    if ($('#update-toast').classList.contains('confirm')) { $('#update-toast').hidden = true; openChangelog(); }
  });
  // device rotation reflows the map container — Leaflet needs invalidateSize or tiles stay grey
  let resizeT;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (state.map) state.map.invalidateSize(); }, 200);
  });
  // header tiles mirror the threat-strip act() targets — passive numbers are dead UI
  const goTab = (tab) => document.querySelector(`.tabs button[data-tab="${tab}"]`).click();
  for (const [id, tab] of [['#tile-emergency', 'tab-alerts'], ['#tile-warnings', 'tab-alerts'], ['#tile-gauges', 'tab-gauges'], ['#tile-open', 'tab-requests']]) {
    $(id).addEventListener('click', () => goTab(tab));
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goTab(tab); } });
  }
  $('#theme-toggle').addEventListener('click', () =>
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
  const updateLangToggle = () => { $('#lang-lbl').textContent = getLang() === 'es' ? 'EN' : 'ES'; };
  updateLangToggle();
  $('#lang-toggle').addEventListener('click', () => {
    setLang(getLang() === 'es' ? 'en' : 'es');
    updateLangToggle();
    relocalizeDynamic();
  });
  $('#refresh-now').addEventListener('click', refresh);
  // ⋮ overflow menu (header declutter) — share/theme/lang/legend live here; same dismiss pattern as other menus
  const hmoreSetOpen = (open) => {
    $('#hmore-menu').hidden = !open;
    $('#hmore-btn').setAttribute('aria-expanded', open ? 'true' : 'false');
    $('#hmore-btn').classList.toggle('on', open);
  };
  $('#hmore-btn').addEventListener('click', () => hmoreSetOpen($('#hmore-menu').hidden));
  document.addEventListener('click', (e) => { if (!$('#hmore-menu').hidden && !e.target.closest('#hmore')) hmoreSetOpen(false); });
  $('#hmore-menu').addEventListener('click', (e) => { if (e.target.closest('button')) hmoreSetOpen(false); });
  $('#share-btn').addEventListener('click', (e) => shareView(e.currentTarget));
  const enterDrive = () => { $('#drive-mode').hidden = false; if (!state.myPos) { state.centerNextFix = true; gpsWait(true); state.map.locate({ enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 }); } else { startLocTrack(); } renderDriveMode(); };
  $('#drive-btn').addEventListener('click', enterDrive);
  // one-time discoverability nudge — Drive Mode is the field's best view but hides behind an icon.
  // Deferred while the safety/onboarding chain is up: one nudge at a time; it shows on the next visit.
  if (!localStorage.getItem('respondertx.driveHintSeen')) {
    const dismissHint = () => { $('#drive-hint').hidden = true; localStorage.setItem('respondertx.driveHintSeen', '1'); };
    setTimeout(() => {
      if (!localStorage.getItem('respondertx.driveHintSeen') && $('#safety-modal').hidden && $('#onboard').hidden) $('#drive-hint').hidden = false;
    }, 3500);
    $('#drive-hint-go').addEventListener('click', () => { dismissHint(); enterDrive(); });
    $('#drive-hint-x').addEventListener('click', dismissHint);
  }
  $('#drive-exit').addEventListener('click', () => { $('#drive-mode').hidden = true; updateDriveFreshness(); }); // tracking continues in the app
  // owner directive: "Am I at risk?" hidden by default — first-responder/public-info tool, not a
  // consumer address lookup. Code + modal stay intact; ?risk=1 reveals the button and opens the modal.
  const riskEnabled = new URLSearchParams(location.search).has('risk');
  if (!riskEnabled) $('#risk-btn').hidden = true;
  $('#risk-btn').addEventListener('click', openRiskCheck);
  $('#risk-close').addEventListener('click', () => { $('#risk-modal').hidden = true; });
  $('#risk-modal').addEventListener('click', (e) => { if (e.target.id === 'risk-modal') $('#risk-modal').hidden = true; });
  $('#risk-form').addEventListener('submit', (e) => { e.preventDefault(); runRiskFromInput(); });
  if (riskEnabled) { $('#risk-btn').hidden = false; openRiskCheck(); }
  $('#hydro-close').addEventListener('click', () => { $('#hydro-modal').hidden = true; });
  $('#hydro-modal').addEventListener('click', (e) => { if (e.target.id === 'hydro-modal') $('#hydro-modal').hidden = true; });
  $('#alert-close').addEventListener('click', () => { $('#alert-modal').hidden = true; });
  $('#alert-modal').addEventListener('click', (e) => { if (e.target.id === 'alert-modal') $('#alert-modal').hidden = true; });
  // map-popup "full alert text" links are detached DOM — delegate so one listener covers all
  document.addEventListener('click', (e) => {
    const link = e.target.closest && e.target.closest('.alert-popup-link');
    if (link) { e.preventDefault(); openAlertTextById(link.dataset.alertId); }
  });
  // camera viewer: ✕ / tap-outside / Escape all route through closeCamViewer so the stream is destroyed
  $('#cam-close').addEventListener('click', closeCamViewer);
  $('#cam-viewer').addEventListener('click', (e) => { if (e.target.id === 'cam-viewer') closeCamViewer(); });
  $('#drive-loc').addEventListener('click', () => { state.centerNextFix = true; gpsWait(true); state.map.locate({ enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 }); });
  $('#update-chip').addEventListener('click', () => location.reload());
  $('#data-age-bar').addEventListener('click', (e) => {
    if (!e.target.closest('.age-bar-x')) return;
    sessionStorage.setItem('respondertx.ageBarDismiss', $('#data-age-bar').dataset.key || '');
    $('#data-age-bar').hidden = true;
  });
  // one-time safety acknowledgment (persisted) — the footer 911 disclaimer stays regardless.
  // ack close binds unconditionally: the footer strip re-opens this modal as the full notice
  if (!localStorage.getItem('respondertx.safetyAck')) $('#safety-modal').hidden = false;
  $('#safety-ack').addEventListener('click', () => {
    localStorage.setItem('respondertx.safetyAck', '1');
    $('#safety-modal').hidden = true;
  });
  initOnboarding(); // after safety wiring — the ack click chains into first-run onboarding
  if (window.initTeamTab) initTeamTab(); // paint the first-class Team tab (create/join or roster)
  if (window.initTeam) initTeam(); // ?team= deep-link auto-opens the Team tab; chains behind the 911 ack
  initHeaderSearch();
  $('#help-btn').addEventListener('click', openGlossary);
  $('#team-btn').addEventListener('click', () => { if (window.openTeamEntry) openTeamEntry(); }); // create/join a live team without a ?team= link

  $('#glossary-close').addEventListener('click', () => { $('#glossary-modal').hidden = true; });
  $('#glossary-modal').addEventListener('click', (e) => { if (e.target.id === 'glossary-modal') $('#glossary-modal').hidden = true; });
  $('#toggle-form').addEventListener('click', () => {
    const open = $('#new-request-form').classList.toggle('open');
    // pin-drop needs the map on screen — phones scroll it into view when intake opens
    if (open && window.innerWidth <= 768) $('#map').scrollIntoView({ behavior: 'smooth' });
  });
  // owner: "New notice" intake suppressed by default; ?intake=1 reveals it (code + form kept intact)
  if (new URLSearchParams(location.search).has('intake')) $('#toggle-form').hidden = false;
  // radio-relayed coords arrive as text — typed "lat, lon" is a first-class pin source
  $('#f-latlon').addEventListener('change', () => {
    const raw = $('#f-latlon').value.trim();
    if (!raw) { state.pendingLatLng = null; return; }
    const m = raw.match(/(-?\d{1,2}(?:\.\d+)?)[,\s]+(-?\d{1,3}(?:\.\d+)?)/);
    const lat = m ? +m[1] : NaN, lng = m ? +m[2] : NaN;
    if (!m || !(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) {
      $('#f-latlon').value = 'unparsed; type decimal "lat, lon"';
      state.pendingLatLng = null;
      return;
    }
    state.pendingLatLng = L.latLng(lat, lng);
    $('#f-latlon').value = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    state.map.setView(state.pendingLatLng, Math.max(state.map.getZoom(), 11));
  });
  $('#f-geocode').addEventListener('click', geocodePlace);
  $('#new-request-form').addEventListener('submit', submitRequest);
  $('#export-btn').addEventListener('click', exportRequests);
  $('#export-geo-btn').addEventListener('click', exportGeoJSON);
  $('#sitrep-btn').addEventListener('click', (e) => copySitrep(e.target));
  $('#aar-btn').addEventListener('click', exportAAR);
  $('#summary-btn').addEventListener('click', openCrestSummary);
  $('#summary-exit').addEventListener('click', () => { $('#summary-view').hidden = true; });
  // ticker halves are duplicated markup — delegate clicks by item index instead of per-node listeners
  $('#ticker').addEventListener('click', (e) => {
    const it = e.target.closest('.ticker-item');
    if (!it || !state.tickerActs) return;
    const act = state.tickerActs[+it.dataset.ti];
    if (act) act();
  });
  $('#banner-dismiss').addEventListener('click', dismissEmergencyBanner);
  $('#banner-text').addEventListener('click', () => {
    dismissEmergencyBanner();
    document.querySelector('.tabs button[data-tab="tab-alerts"]').click();
  });
  $('#import-file').addEventListener('change', (e) => { if (e.target.files[0]) importRequests(e.target.files[0]); e.target.value = ''; });
  ['#flt-type', '#flt-county'].forEach((sel) => $(sel).addEventListener('change', () => {
    state.filters.type = $('#flt-type').value;
    state.filters.county = $('#flt-county').value;
    renderRequests();
    saveViewState();
  }));
  $('#flt-q').addEventListener('input', () => {
    state.filters.q = $('#flt-q').value;
    renderRequests();
    flyToRadioId(state.filters.q);
    saveViewState();
  });
  $('#flt-sort').addEventListener('change', () => { state.sort = $('#flt-sort').value; renderRequests(); saveViewState(); });
  $('#flt-alert-sev').addEventListener('change', () => { renderAlertList(); saveViewState(); });
  $('#flt-alert-q').addEventListener('input', () => { renderAlertList(); saveViewState(); });
  $('#flt-window').addEventListener('change', () => {
    state.filters.window = $('#flt-window').value;
    renderRequests();
    saveViewState();
    fetchLsrs().catch(() => { /* transient — next poll retries */ });
  });
  $('#flt-dist').addEventListener('change', () => {
    state.filters.dist = $('#flt-dist').value;
    if (state.filters.dist && !state.myPos) {
      state.centerNextFix = true;
      gpsWait(true);
      state.map.locate({ enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 });
    }
    renderRequests();
    saveViewState();
  });

  $('#flt-aged').addEventListener('click', () => { state.showAged = !state.showAged; renderRequests(); saveViewState(); });
  $('#flt-inview').addEventListener('click', () => setInView(!state.inView));
  $('#req-filters').hidden = localStorage.getItem('respondertx.filtersOpen') !== '1';
  $('#filters-toggle').addEventListener('click', () => {
    const open = $('#req-filters').hidden;
    $('#req-filters').hidden = !open;
    localStorage.setItem('respondertx.filtersOpen', open ? '1' : '0');
    updateFiltersBadge();
  });
  $('#more-toggle').addEventListener('click', () => {
    const menu = $('#more-menu');
    menu.hidden = !menu.hidden;
    $('#more-toggle').classList.toggle('on', !menu.hidden);
  });

  state.lastSeen = +localStorage.getItem('respondertx.lastSeen') || 0;
  localStorage.setItem('respondertx.lastSeen', String(Date.now()));
  $('#app-version').textContent = APP_VERSION;
  if (localStorage.getItem('respondertx.lastVersion') !== APP_VERSION) $('#app-version').classList.add('has-new');
  $('#app-version').addEventListener('click', openChangelog);
  $('#app-version').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChangelog(); } });
  $('#changelog-close').addEventListener('click', () => { $('#changelog-modal').hidden = true; });
  $('#changelog-modal').addEventListener('click', (e) => { if (e.target.id === 'changelog-modal') $('#changelog-modal').hidden = true; });
  $('#sitrep-close').addEventListener('click', closeSitrepModal);
  $('#sitrep-foot-close').addEventListener('click', closeSitrepModal);
  $('#sitrep-modal').addEventListener('click', (e) => { if (e.target.id === 'sitrep-modal') closeSitrepModal(); });
  $('#sitrep-copy').addEventListener('click', (e) => {
    const b = e.currentTarget;
    copyText(sitrepText).then(
      () => { b.textContent = t('sitrep.copied'); setTimeout(() => { b.textContent = t('sitrep.copy'); }, 1500); },
      () => downloadBlob(sitrepText, 'text/plain', `sitrep-${stamp()}.txt`));
  });
  $('#sitrep-share').addEventListener('click', () => {
    if (navigator.share) navigator.share({ title: 'ResponderTX SITREP', text: sitrepText }).catch(() => { /* user dismissed the OS share sheet */ });
  });
  $('#sitrep-download').addEventListener('click', () => downloadBlob(sitrepText, 'text/plain', `sitrep-${stamp()}.txt`));
  // Escape closes the top-most open overlay
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#safety-modal').hidden) return; // 911 gate up: Escape is a complete no-op until #safety-ack
    if (!$('#cam-viewer').hidden) { closeCamViewer(); return; } // must tear down the player, not just hide
    if (layerSheetIsOpen()) { closeLayerSheet(); return; }
    if (!$('#sitrep-modal').hidden) { closeSitrepModal(); return; } // routes through close() so focus is restored
    if (window.closeNotesFlyout && !$('#notes-flyout').hidden) { window.closeNotesFlyout(); return; } // keeps N.open in sync
    if (!$('#onboard').hidden) { obDismiss(); return; } // dismissal counts as seen — it never re-nags
    if (!$('#hmore-menu').hidden) { hmoreSetOpen(false); return; }
    if ($('#hsearch').classList.contains('open')) { searchSetOpen(false); return; }
    // #safety-modal is intentionally absent: the 911 self-deploy gate closes only via #safety-ack (which
    // records the acknowledgment), never on Escape or a backdrop click
    for (const id of ['#risk-modal', '#hydro-modal', '#alert-modal', '#changelog-modal', '#glossary-modal', '#summary-view', '#drive-mode', '#team-drop', '#team-edit']) {
      const m = $(id);
      if (m && !m.hidden) { m.hidden = true; if (id === '#drive-mode') updateDriveFreshness(); break; }
    }
  });

  $('#rs-play').addEventListener('click', rtlTogglePlay);
  $('#rs-slider').addEventListener('input', () => { rtlStopPlay(); rtlSet(+$('#rs-slider').value); });
  if (new URLSearchParams(location.search).get('radar') === '1') state.layers.radar.addTo(state.map);
  if (new URLSearchParams(location.search).get('fcst') === '1') state.layers.fcstRadar.addTo(state.map);

  initPlaybackControls();
  $('#playback-btn').addEventListener('click', openPlayback);
  if (new URLSearchParams(location.search).get('playback') === '1') openPlayback();

  // footer 911 strip stays one row at every width — tap opens the full safety notice
  $('#disclaimer').addEventListener('click', (e) => {
    if (e.target.id === 'app-version') return;
    $('#safety-modal').hidden = false;
  });

  // ops chat + master oversight are LAN-only constructs: their UI (js/chat.js, js/master.js) loads
  // only when the local backend advertises the capability — the public mirror ships neither file
  const markMirror = () => {
    $('#new-request-form .hint').textContent =
      'Read-only mirror: notices added here save to THIS DEVICE ONLY; they do not reach the ops session. Click the map to set the pin.';
  };
  const loadLanScript = (src) => { const s = document.createElement('script'); s.src = src; document.body.appendChild(s); };
  fetch('/api/ping').then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (d && d.chat) loadLanScript('js/chat.js');
    else markMirror();
    if (d && d.master) loadLanScript('js/master.js'); // command-side, all-teams oversight view
  }).catch(markMirror);
  restoreViewState(); // saved view first, so any URL param below overrides it for this load

  // migration: old separate-layer links (?rain=1h / ?rain=24h, both→24h) resolve to the unified Rainfall layer
  const rainVals = new URLSearchParams(location.search).getAll('rain');
  if (rainVals.length) {
    const win = rainVals.includes('24h') ? '24h' : CONFIG.mrmsWindows.includes(rainVals[0]) ? rainVals[0] : null;
    if (win) {
      setRainWindow(win);
      state.layers.mrms.addTo(state.map);
    }
  }

  let tabParam = new URLSearchParams(location.search).get('tab');
  if (tabParam === 'monitor') tabParam = 'resources'; // legacy: the Social tab merged into Resources
  // guard the selector interpolation — a crafted ?tab= (e.g. %22%5D) would throw a DOMException and abort boot()
  if (tabParam && /^[a-z-]+$/.test(tabParam)) {
    const btn = document.querySelector(`.tabs button[data-tab="tab-${tabParam}"]`);
    if (btn) btn.click();
  }
  applyShareParams(new URLSearchParams(location.search)); // URL share-params win for this load
  state.viewReady = true;
  const viewParam = new URLSearchParams(location.search).get('view');
  if (viewParam === 'drive') $('#drive-btn').click();
  else if (viewParam === 'summary') $('#summary-btn').click();
  const hydroParam = new URLSearchParams(location.search).get('hydro');
  if (hydroParam) state.pendingHydro = hydroParam.toUpperCase();
  // ?cam=<camId|name|id> deep-links straight into the viewer (handled below).
  // shared/rollover layer toggles (set only when ON) — radar handled above; ?cams=1 stays the TxDOT-cams shortcut
  for (const [qk, lk] of [['cams', 'camsTxdot'], ['camr', 'camsRiver'], ['cama', 'camsAustin'], ['camf', 'camsFlood'], ['camh', 'camsHouston'], ['caml', 'camsArlington'], ['came', 'camsElpBridge'], ['usgs', 'usgs'], ['lwc', 'lwc'], ['inun', 'inundation'], ['reopen', 'roadReopen']]) {
    if (new URLSearchParams(location.search).get(qk) === '1' && state.layers[lk]) state.layers[lk].addTo(state.map);
  }
  const camParam = new URLSearchParams(location.search).get('cam');
  if (camParam) {
    state.pendingCam = camParam;
    loadCameras().catch(() => { $('#refresh-note').textContent = 'camera inventory unavailable'; });
  }

  // paint snapshot gauges immediately — a slow/failing NWPS first-fetch must never leave a blank, scary board
  state.bootAt = Date.now();
  hydrateGaugesSnapshot();
  const ok = await loadSeeds();
  // a shared ?fq=R-031 link fires before seeds exist — re-fly once the cards are on the board
  if (ok) flyToRadioId(new URLSearchParams(location.search).get('fq'));
  if (rollBlob) {
    // drop the frozen restore params so a later manual reload uses the saved view, not this URL
    try { history.replaceState(null, '', location.pathname); } catch { /* sandboxed context — cosmetic only */ }
    if (rollBlob.v === APP_VERSION) showUpdatedConfirm(); // still on the old build (CDN lag) — no false "updated"
  }
  if (!ok) {
    $('#request-list').innerHTML = '<div class="card">Failed to load seed data. Serve over HTTP (see README), not file://.</div>';
    state.resources = state.resources || { shelters: [], hotlines: [], monitors: [], comms: [], dataLinks: [] };
    renderResources();
    renderMonitors();
  }
  await refresh();
  // battery/data saver: don't poll while backgrounded; catch up the moment we're visible again
  setInterval(() => {
    if (document.visibilityState === 'hidden') { state.pendingRefresh = true; return; }
    refresh();
  }, CONFIG.refreshMs);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') { stopLocTrack(); return; } // no background geolocation drain
    if (state.myPos) startLocTrack(); // resume the fix loop on return, in the app or Drive Mode
    if (state.pendingRefresh) {
      state.pendingRefresh = false;
      refresh();
    }
    tryRollover(); // a pending rollover deferred while hidden fires on return instead
  });
  setInterval(tickCountdown, 1000);
}

document.addEventListener('DOMContentLoaded', boot);
