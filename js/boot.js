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
  $('#refresh-note').textContent = `offline — cached as of ${fmtWhen(new Date(c.ts).toISOString())}`;
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
      if (!hydrated && !snapped) $('#refresh-note').textContent = `degraded: ${failedNames}`;
      return;
    }
    if (!failed.length) saveCache();
    renderSourceHealth();
    checkAppVersion();
    $('#refresh-note').textContent = failed.length
      ? `degraded: ${failedNames}`
      : `updated ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })} CT`;
  } finally {
    state.refreshBusy = false;
    if (state.refreshQueued) { state.refreshQueued = false; refresh(); }
  }
}

function markHealthy(source) { state.sourceHealth[source] = Date.now(); }

function renderSourceHealth() {
  const el = $('#source-health');
  if (!el) return;
  const sources = [['alerts', 'NWS alerts'], ['gauges', 'NOAA gauges'], ['fcstMax', 'RFC forecast max'], ['usgs', 'USGS raw stage'], ['lsrs', 'Storm reports'], ['seeds', 'Board data'], ['roads', 'TxDOT roads']];
  el.innerHTML = '<div class="section-title">Data source health</div>' +
    '<div class="filters" style="margin-bottom:12px">' + sources.map(([k, label]) => {
      const t = state.sourceHealth[k];
      const age = t ? (Date.now() - t) / 60000 : Infinity;
      const cls = age < 10 ? 'fresh' : age < 30 ? 'aging' : 'stale';
      const when = t ? `${Math.round(age)}m ago` : 'never';
      return `<span class="badge"><span class="fresh-dot ${cls}"></span> ${esc(label)} · ${when}</span>`;
    }).join('') + '</div>';
}

// long-lived tabs run old code forever — tell them when a newer build shipped (never auto-reload mid-use)
async function checkAppVersion() {
  try {
    const d = await fetch(`data/changelog.json?_=${Date.now()}`).then((r) => (r.ok ? r.json() : null));
    const latest = d && d.versions && d.versions[0] && d.versions[0].v;
    if (latest && latest !== APP_VERSION) $('#update-chip').hidden = false;
  } catch { /* offline — no update signal */ }
}

function tickCountdown() {
  if (!state.refreshAt) return;
  const s = Math.max(0, Math.round((state.refreshAt - Date.now()) / 1000));
  $('#refresh-count').textContent = `next in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  renderDataAgeBar();
}

// when the live gauge feed dies, surface the fallback the board already holds — and stand it down on recovery
function autoUsgsFallback(on) {
  const lyr = state.layers.usgs;
  if (!lyr) return false;
  if (on && (state.usgsSites || []).length && !state.map.hasLayer(lyr)) {
    lyr.addTo(state.map);
    state.usgsAutoOn = true;
  } else if (!on && state.usgsAutoOn) {
    if (state.map.hasLayer(lyr)) state.map.removeLayer(lyr);
    state.usgsAutoOn = false;
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
    text = `⚠ GAUGES FROM SNAPSHOT ${snapAge} MIN OLD — live NWPS feed failing${usgsNote}`;
  } else {
    cls = worst.age > 15 ? 'red' : 'amber';
    text = (worst.age === Infinity
      ? `⚠ ${label} DATA NEVER LOADED — numbers on this board exclude it`
      : `⚠ ${label} DATA ${Math.round(worst.age)} MIN OLD — refresh failing; treat as stale`) + (worst.k === 'gauges' ? usgsNote : '');
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
}

async function boot() {
  const themeParam = new URLSearchParams(location.search).get('theme');
  applyTheme(themeParam || localStorage.getItem('respondertx.theme') || 'dark');
  await loadEventConfig();
  applyI18n(document);
  initMap();
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
  $('#share-btn').addEventListener('click', (e) => shareView(e.target));
  const enterDrive = () => { $('#drive-mode').hidden = false; if (!state.myPos) { gpsWait(true); state.map.locate({ enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 }); } renderDriveMode(); };
  $('#drive-btn').addEventListener('click', enterDrive);
  // one-time discoverability nudge — Drive Mode is the field's best view but hides behind an icon
  if (!localStorage.getItem('respondertx.driveHintSeen')) {
    const dismissHint = () => { $('#drive-hint').hidden = true; localStorage.setItem('respondertx.driveHintSeen', '1'); };
    setTimeout(() => { if (!localStorage.getItem('respondertx.driveHintSeen')) $('#drive-hint').hidden = false; }, 3500);
    $('#drive-hint-go').addEventListener('click', () => { dismissHint(); enterDrive(); });
    $('#drive-hint-x').addEventListener('click', dismissHint);
  }
  $('#drive-exit').addEventListener('click', () => { $('#drive-mode').hidden = true; });
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
  $('#drive-loc').addEventListener('click', () => { gpsWait(true); state.map.locate({ enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 }); });
  $('#update-chip').addEventListener('click', () => location.reload());
  $('#data-age-bar').addEventListener('click', (e) => {
    if (!e.target.closest('.age-bar-x')) return;
    sessionStorage.setItem('respondertx.ageBarDismiss', $('#data-age-bar').dataset.key || '');
    $('#data-age-bar').hidden = true;
  });
  // one-time safety acknowledgment (persisted) — the footer 911 disclaimer stays regardless
  if (!localStorage.getItem('respondertx.safetyAck')) {
    $('#safety-modal').hidden = false;
    $('#safety-ack').addEventListener('click', () => {
      localStorage.setItem('respondertx.safetyAck', '1');
      $('#safety-modal').hidden = true;
    });
  }
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
      $('#f-latlon').value = 'unparsed — type decimal "lat, lon"';
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
      gpsWait(true);
      state.map.locate({ enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 });
    }
    renderRequests();
    saveViewState();
  });

  $('#flt-aged').addEventListener('click', () => { state.showAged = !state.showAged; renderRequests(); saveViewState(); });
  $('#req-filters').hidden = localStorage.getItem('respondertx.filtersOpen') !== '1';
  $('#find-id').addEventListener('click', () => {
    $('#req-filters').hidden = false;
    const q = $('#flt-q');
    q.placeholder = 'Type a radio ID — R-031';
    q.focus();
    q.select();
  });
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
  // Escape closes the top-most open overlay
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const id of ['#risk-modal', '#hydro-modal', '#changelog-modal', '#summary-view', '#drive-mode', '#safety-modal']) {
      const m = $(id);
      if (m && !m.hidden) { m.hidden = true; break; }
    }
  });

  $('#rs-play').addEventListener('click', toggleRadarPlay);
  $('#rs-slider').addEventListener('input', () => { stopRadarPlay(); setRadarFrame(+$('#rs-slider').value); });
  if (new URLSearchParams(location.search).get('radar') === '1') state.layers.radar.addTo(state.map);

  $('#disclaimer').addEventListener('click', (e) => {
    if (e.target.id === 'app-version') return;
    if (window.innerWidth <= 768) $('#disclaimer').classList.toggle('open');
  });

  // ops chat is a LAN-only construct: UI code (js/chat.js) loads only when the
  // local backend answers — the public mirror ships neither the file nor a route
  const markMirror = () => {
    $('#new-request-form .hint').textContent =
      'Read-only mirror: notices added here save to THIS DEVICE ONLY — they do not reach the ops session. Click the map to set the pin.';
  };
  fetch('/api/ping').then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (d && d.chat) {
      const s = document.createElement('script');
      s.src = 'js/chat.js';
      document.body.appendChild(s);
    } else markMirror();
  }).catch(markMirror);
  restoreViewState(); // saved view first, so any URL param below overrides it for this load

  const rainParam = new URLSearchParams(location.search).get('rain');
  if (rainParam === '1h') state.layers.mrms1h.addTo(state.map);
  else if (rainParam === '24h') state.layers.mrms24h.addTo(state.map);

  const tabParam = new URLSearchParams(location.search).get('tab');
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

  // paint snapshot gauges immediately — a slow/failing NWPS first-fetch must never leave a blank, scary board
  state.bootAt = Date.now();
  hydrateGaugesSnapshot();
  const ok = await loadSeeds();
  // a shared ?fq=R-031 link fires before seeds exist — re-fly once the cards are on the board
  if (ok) flyToRadioId(new URLSearchParams(location.search).get('fq'));
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
    if (document.visibilityState === 'visible' && state.pendingRefresh) {
      state.pendingRefresh = false;
      refresh();
    }
  });
  setInterval(tickCountdown, 1000);
}

document.addEventListener('DOMContentLoaded', boot);
