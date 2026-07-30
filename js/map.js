'use strict';

/* ---------- theme ---------- */

// boost variant tracks the surface under it: dark CARTO base gets light-on-dark labels, light/streets get dark-on-light
function labelBoostVariant() {
  return (state.activeBase || document.documentElement.getAttribute('data-theme')) === 'dark' ? 'dark' : 'light';
}
function labelBoostUrl() {
  return `https://{s}.basemaps.cartocdn.com/${labelBoostVariant()}_only_labels/{z}/{x}/{y}{r}.png`;
}
function syncLabelBoost() {
  state.layers.labelBoost.setUrl(labelBoostUrl());
  state.map.getPane('labels').classList.toggle('boost-dark', labelBoostVariant() === 'dark');
}

function applyTheme(theme) {
  if (theme !== 'dark' && theme !== 'light') theme = 'light'; // invalid ?theme=/storage must never crash boot or persist
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('respondertx.theme', theme);
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', theme === 'dark' ? '#0D1B2A' : '#ffffff'); // browser chrome tracks --surface-1
  $('#theme-toggle').innerHTML = theme === 'dark'
    ? `☀️ <span class="ctl-lbl">${esc(t('ctl.theme.light'))}</span>`
    : `🌙 <span class="ctl-lbl">${esc(t('ctl.theme.dark'))}</span>`;
  if (state.map) {
    // Streets base is theme-neutral: keep it in place, theme then only affects UI chrome
    if (state.activeBase !== 'streets' && state.activeBase !== theme && state.baseLayers[theme]) {
      Object.values(state.baseLayers).forEach((l) => state.map.removeLayer(l));
      state.baseLayers[theme].addTo(state.map);
      state.activeBase = theme;
    }
    syncLabelBoost();
  }
}

/* ---------- offline tiles (IndexedDB — works on plain LAN http, no Service Worker) ---------- */

// Basemap tiles only. Data (gauges/alerts) is never cached — staleness stays governed by the data-age bar.
const OFFLINE_TILE_CAP = 1500; // per-save ceiling — respects CARTO/OSM usage; over cap → user zooms in

const OfflineTiles = (() => {
  const DB = 'respondertx-offline', STORE = 'tiles';
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      let rq;
      try { rq = indexedDB.open(DB, 1); } catch (e) { reject(e); return; }
      rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(STORE)) rq.result.createObjectStore(STORE); };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
    return dbp;
  }
  const run = (mode, fn) => db().then((d) => new Promise((resolve, reject) => {
    const store = d.transaction(STORE, mode).objectStore(STORE);
    const rq = fn(store);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  }));
  return {
    available: () => typeof indexedDB !== 'undefined',
    get: (key) => run('readonly', (s) => s.get(key)).then((v) => v || null),
    has: (key) => run('readonly', (s) => s.count(key)).then((n) => n > 0),
    put: (key, blob) => run('readwrite', (s) => s.put(blob, key)),
    count: () => run('readonly', (s) => s.count()),
    clear: () => run('readwrite', (s) => s.clear()),
  };
})();

// Cache-first tile layer: serves a stored blob when present, else the network; the template
// string namespaces keys so each base (and each label variant via setUrl) has its own tiles.
const OfflineTileLayer = L.TileLayer.extend({
  initialize(url, options) {
    L.TileLayer.prototype.initialize.call(this, url, options);
    this.on('tileunload', (e) => {
      if (e.tile && e.tile._objurl) { URL.revokeObjectURL(e.tile._objurl); e.tile._objurl = null; }
    });
  },
  offlineKey(coords) { return `${this._url}|${coords.z}/${coords.x}/${coords.y}`; },
  createTile(coords, done) {
    const tile = document.createElement('img');
    tile.setAttribute('role', 'presentation');
    tile.alt = '';
    L.DomEvent.on(tile, 'load', L.Util.bind(this._tileOnLoad, this, done, tile));
    L.DomEvent.on(tile, 'error', L.Util.bind(this._tileOnError, this, done, tile));
    const netUrl = this.getTileUrl(coords);
    OfflineTiles.get(this.offlineKey(coords)).then((blob) => {
      if (blob) { tile._objurl = URL.createObjectURL(blob); tile.src = tile._objurl; }
      else { tile.src = netUrl; }
    }).catch(() => { tile.src = netUrl; });
    return tile;
  },
});

function offlineTile(url, opts) { return new OfflineTileLayer(url, opts); }

// getTileUrl() locks z to the layer's live zoom, so build save URLs directly to reach z+1
function offlineTileUrl(layer, c) {
  const subs = layer.options.subdomains || 'abc';
  return L.Util.template(layer._url, { s: subs[Math.abs(c.x + c.y) % subs.length], x: c.x, y: c.y, z: c.z, r: '' });
}

function activeOfflineLayers() {
  const out = [];
  state.map.eachLayer((l) => { if (l instanceof OfflineTileLayer) out.push(l); });
  return out;
}

function viewportTileCoords(z) {
  const b = state.map.getBounds();
  const nw = state.map.project(b.getNorthWest(), z).divideBy(256).floor();
  const se = state.map.project(b.getSouthEast(), z).divideBy(256).floor();
  const out = [];
  for (let x = nw.x; x <= se.x; x++) for (let y = nw.y; y <= se.y; y++) out.push({ x, y, z });
  return out;
}

/* Depth is the user's, not the app's. Each extra level roughly quadruples the download, and the
   only person who knows whether this is a metered phone in the field is the one holding it. The
   shipped default is unchanged, so nobody's save silently grows; the choice is a way to make it
   smaller. */
const OFFLINE_DEPTHS = [0, 1, 2];
const OFFLINE_DEPTH_DEFAULT = 2;
const OFFLINE_DEPTH_KEY = 'respondertx.offdepth';
const OFFLINE_LEDGER_KEY = 'respondertx.offline';

function offlineDepth() {
  if (!OFFLINE_DEPTHS.includes(state.offDepth)) {
    let d = NaN;
    try { d = parseInt(localStorage.getItem(OFFLINE_DEPTH_KEY), 10); } catch { d = NaN; }
    state.offDepth = OFFLINE_DEPTHS.includes(d) ? d : OFFLINE_DEPTH_DEFAULT;
  }
  return state.offDepth;
}

function setOfflineDepth(d) {
  if (!OFFLINE_DEPTHS.includes(d)) return;
  state.offDepth = d;
  try { localStorage.setItem(OFFLINE_DEPTH_KEY, String(d)); } catch { /* private mode — the choice still holds for this load */ }
  renderLayerSheet();
}

// the zoom levels a save at this depth would cover, capped by what the active layers actually serve
function offlineZooms(depth) {
  const layers = activeOfflineLayers();
  if (!layers.length || !state.map) return [];
  const z0 = state.map.getZoom();
  const maxZ = Math.min(...layers.map((l) => l.options.maxZoom || 19));
  const out = [];
  for (let i = 0; i <= depth; i++) { if (z0 + i <= maxZ) out.push(z0 + i); }
  return out;
}

function offlineJobs(depth) {
  const layers = activeOfflineLayers();
  const jobs = [];
  for (const z of offlineZooms(depth)) for (const c of viewportTileCoords(z)) for (const l of layers) jobs.push({ l, c });
  return jobs;
}

/* What the last save left in the store. Browsers evict origin storage without telling the page, so
   a count that has fallen since the save is the only evidence the tiles are gone, and a responder
   who believes an area is cached and finds grey squares in the field is the failure this whole
   feature exists to prevent. */
function offlineLedger() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(OFFLINE_LEDGER_KEY) || 'null'); } catch { v = null; }
  return v && Number.isFinite(v.n) ? v : null;
}

function setOfflineLedger(n) {
  try { localStorage.setItem(OFFLINE_LEDGER_KEY, JSON.stringify({ n, t: Date.now() })); } catch { /* private mode — eviction simply goes unreported */ }
}

function refreshOfflineStatus() {
  return OfflineTiles.count().then((n) => {
    const s = $('#off-status');
    const led = offlineLedger();
    if (s) {
      s.classList.remove('over', 'warn');
      if (led && n < led.n) {
        s.textContent = t('off.evicted').replace('{n}', fmtNum(n)).replace('{m}', fmtNum(led.n));
        s.classList.add('warn');
      } else s.textContent = n > 0 ? t('off.saved').replace('{n}', fmtNum(n)) : t('off.none');
    }
    const clr = $('#off-clear');
    if (clr) clr.hidden = n === 0;
    return n;
  }).catch(() => {
    // the count is the only claim this panel makes; unreadable means say so, not leave a stale one
    const s = $('#off-status');
    if (s) { s.textContent = t('off.unavail'); s.classList.add('warn'); }
    return null;
  });
}

// the cost of the pending save, stated before the user commits to it
function refreshOfflineEstimate() {
  const el = $('#off-est');
  if (!el) return;
  const zooms = offlineZooms(offlineDepth());
  const n = zooms.length ? offlineJobs(offlineDepth()).length : 0;
  el.textContent = zooms.length ? t('off.est').replace('{n}', fmtNum(n)).replace('{m}', fmtNum(zooms.length)) : '';
  el.classList.toggle('over', n > OFFLINE_TILE_CAP);
}

/* Closing line for a finished save. The honest cases are tested first so none of them can fall
   through to the clean one: a partial save, a quota stop, or a save that fetched nothing at all
   must never read as "available offline". */
function offlineResultText(r) {
  if (r.quota) return t('off.quota').replace('{n}', fmtNum(r.saved)).replace('{m}', fmtNum(r.jobs));
  if (!r.saved) return t('off.failed').replace('{f}', fmtNum(r.failed || r.jobs));
  if (r.failed) return t('off.partial').replace('{n}', fmtNum(r.saved)).replace('{m}', fmtNum(r.jobs)).replace('{f}', fmtNum(r.failed));
  return t('off.savedfull').replace('{n}', fmtNum(Number.isFinite(r.total) ? r.total : r.saved)).replace('{m}', fmtNum(r.zooms));
}

const offlineSaveClean = (r) => !r.quota && !r.failed && r.saved > 0;

async function saveViewportOffline() {
  const statusEl = $('#off-status');
  if (!statusEl) return;
  const depth = offlineDepth();
  const zooms = offlineZooms(depth);
  const jobs = offlineJobs(depth);
  statusEl.classList.remove('over', 'warn');
  if (!jobs.length) { statusEl.textContent = t('off.nolayer'); statusEl.classList.add('warn'); return; }
  if (jobs.length > OFFLINE_TILE_CAP) {
    statusEl.textContent = t('off.cap').replace('{n}', fmtNum(jobs.length)).replace('{m}', fmtNum(OFFLINE_TILE_CAP));
    statusEl.classList.add('over');
    return;
  }
  const saveBtn = document.querySelector('.off-save');
  if (saveBtn) saveBtn.disabled = true;
  let done = 0, saved = 0, failed = 0, idx = 0, quota = false;
  const worker = async () => {
    while (idx < jobs.length && !quota) { // a full store will not empty mid-run; stop rather than fail every remaining tile
      const { l, c } = jobs[idx++];
      const key = l.offlineKey(c);
      try {
        if (await OfflineTiles.has(key)) saved++; // already held from an earlier save of this area
        else {
          const r = await fetch(offlineTileUrl(l, c), { mode: 'cors' });
          if (!r.ok) failed++;
          else { await OfflineTiles.put(key, await r.blob()); saved++; }
        }
      } catch (e) {
        if (e && /quota/i.test(String(e.name || e))) quota = true;
        else failed++;
      }
      statusEl.textContent = t('off.saving').replace('{n}', fmtNum(++done)).replace('{m}', fmtNum(jobs.length));
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (saveBtn) saveBtn.disabled = false;
  let total = null;
  try { total = await OfflineTiles.count(); } catch { total = null; } // count is a nicety; the run's own tally is the claim
  if (Number.isFinite(total)) setOfflineLedger(total);
  const result = { saved, failed, quota, jobs: jobs.length, zooms: zooms.length, total };
  const text = offlineResultText(result);
  statusEl.textContent = text;
  const clean = offlineSaveClean(result);
  statusEl.classList.toggle('warn', !clean);
  const clr = $('#off-clear');
  if (clr && Number.isFinite(total)) clr.hidden = total === 0;
  // the sheet scrolls and the panel sits well down it; a failed save must reach the user anyway
  if (!clean && typeof opNotice === 'function') opNotice(text);
}

async function clearOfflineCache() {
  try { await OfflineTiles.clear(); } catch (e) { /* ignore — nothing to clear */ }
  setOfflineLedger(0); // an empty store is not an eviction, so the warning must not fire on it
  await refreshOfflineStatus();
  const s = $('#off-status');
  if (s) { s.textContent = t('off.cleared'); s.classList.remove('warn', 'over'); }
}

// caching the basemap is a choice about what the map shows with no signal, so it belongs in the
// layer sheet, not in a fifth box along the map edge
function offlineSheetHtml() {
  if (!OfflineTiles.available()) return '';
  const d = offlineDepth();
  const seg = `<div class="off-depth" role="group" aria-label="${esc(t('off.depth'))}" title="${esc(t('off.depth.title'))}">` +
    OFFLINE_DEPTHS.map((z) =>
      `<button class="off-depth-btn${z === d ? ' on' : ''}" data-offz="${z}">${esc(t(`off.depth.${z}`))}</button>`).join('') +
    '</div>';
  return `<div class="ls-group">${esc(t('sheet.g.offline'))}</div>` +
    '<div class="ls-off">' + seg +
    '<div class="off-est" id="off-est"></div>' +
    `<button class="off-save" data-act="off-save" title="${esc(t('off.save.title'))}" data-i18n="off.save" data-i18n-title="off.save.title">${esc(t('off.save'))}</button>` +
    '<div class="off-status" id="off-status" role="status" aria-live="polite">…</div>' +
    `<div class="off-note" data-i18n="off.note">${esc(t('off.note'))}</div>` +
    `<button class="off-clear" id="off-clear" data-act="off-clear" hidden data-i18n="off.clear">${esc(t('off.clear'))}</button>` +
    '</div>';
}

/* ---------- ArcGIS dynamic-export overlay (per-tile bbox) ---------- */

// Consumes an ArcGIS MapServer `export` endpoint as XYZ tiles: each tile's Web-Mercator
// bbox is appended per request. Used for the NWM inundation overlay (no esri-leaflet dep).
// Kept off the OfflineTileLayer path on purpose — this is live model DATA, never cached.
const ArcGISExportLayer = L.TileLayer.extend({
  getTileUrl(coords) {
    const b = this._tileCoordsToBounds(coords);
    const sw = L.CRS.EPSG3857.project(b.getSouthWest());
    const ne = L.CRS.EPSG3857.project(b.getNorthEast());
    const bbox = [sw.x, sw.y, ne.x, ne.y].join(',');
    return `${this._url}&bbox=${bbox}&_t=${Math.floor(Date.now() / 3600000)}`; // hourly cache-bust
  },
});

/* ---------- unified Rainfall overlay (v0.90) — one MRMS layer, window picked via legend chips ---------- */

const RAIN_WIN_KEY = 'respondertx.rainwin';
const bustSrc = (url) => url + '?_=' + Math.floor(Date.now() / 300000);

function updateMrmsLegend() {
  const on = state.map.hasLayer(state.layers.mrms);
  $('#mrms-legend').hidden = !on;
  if (!on) return;
  $('#mrms-legend-title').textContent = t('leg.rain.acc').replace('{w}', state.rainWindow);
  $('#mrms-legend-chips').innerHTML = CONFIG.mrmsWindows.map((w) =>
    `<button class="mrms-chip${w === state.rainWindow ? ' on' : ''}" data-win="${w}" aria-pressed="${w === state.rainWindow}">${w}</button>`).join('');
}

function setRainWindow(w) {
  if (!CONFIG.mrmsWindows.includes(w) || w === state.rainWindow) return;
  if (pbBlocksLive(state)) return; // playback: same read-only regime as the layer sheet
  state.rainWindow = w;
  try { sessionStorage.setItem(RAIN_WIN_KEY, w); } catch { /* private mode — window choice is session-only anyway */ }
  state.layers.mrms.setUrl(bustSrc(CONFIG.mrmsUrl(w))); // same layer object — tiles swap in place, no re-add flicker
  updateMrmsLegend();
}

/* ---------- tropical-cyclone legend: a compact bottom-left key toggled with the NHC tracker layer ---------- */

function tropicalLegendHtml() {
  const wwRow = (k) => `<div><span class="sw sw-line" style="background:${TCWW_WW[k].color}"></span>${esc(t(TCWW_WW[k].key))}</div>`;
  return `<div class="lg-title">${esc(t('trop.leg.title'))}</div>` +
    `<div><span class="sw" style="width:12px;height:10px;background:${TROPICAL_CONE_FILL};opacity:.5;border-radius:2px"></span>${esc(t('trop.leg.cone'))}</div>` +
    `<div><span class="sw sw-line" style="background:${TROPICAL_TRACK}"></span>${esc(t('trop.leg.otrack'))}</div>` +
    `<div><span class="sw sw-line" style="background:${TROPICAL_TRACK}"></span>${esc(t('trop.leg.ftrack'))}</div>` +
    `<div class="lg-title" style="margin-top:6px">${esc(t('trop.leg.ww'))}</div>` +
    ['HWR', 'TWR', 'SSW', 'HWA', 'TWA', 'SSA'].map(wwRow).join('');
}

function showTropicalLegend() {
  if (!state.tropicalLegend) {
    const c = L.control({ position: 'bottomleft' });
    c.onAdd = () => {
      const div = L.DomUtil.create('div', 'map-legend trop-legend');
      div.innerHTML = tropicalLegendHtml(); // rebuilt on each add so a live language switch localizes it
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      L.DomEvent.on(div, 'click', () => div.classList.toggle('open'));
      return div;
    };
    state.tropicalLegend = c;
  }
  state.tropicalLegend.addTo(state.map);
}

function hideTropicalLegend() {
  if (state.tropicalLegend) state.tropicalLegend.remove();
}

/* ---------- map ---------- */

// flyOpenPopup latlng zoom marker — setView, then open once the flight fully settles;
// opening mid-flight breaks popup autoPan (the flight's later animation phases re-center over it)
function flyOpenPopup(latlng, zoom, marker) {
  state.map.setView(latlng, zoom);
  if (!marker) return;
  const busy = () => (state.map._panAnim && state.map._panAnim._inProgress) || state.map._animatingZoom;
  let idle = 0, tries = 0;
  (function tick() {
    idle = busy() ? 0 : idle + 1;
    if (idle >= 2 || ++tries > 50) { marker.openPopup(); return; }
    setTimeout(tick, 80);
  })();
}

// our own recenters/follow glides: flag the move so a zoom-changing recenter never self-exits follow.
// smooth=true glides to the newest fix at near-constant speed; a fresh fix retargets the in-flight pan,
// so consecutive ~1s fixes chain into continuous motion instead of jump-then-sit.
function progSetView(latlng, zoom, smooth) {
  // arm the zoomstart guard ONLY for a zoom-changing move — that is the only case that fires zoomstart.
  // a pure pan/glide leaves _progMove false so a user pinch/scroll-zoom mid-glide still exits follow.
  const zoomChanges = zoom != null && zoom !== state.map.getZoom();
  if (zoomChanges) {
    state._progMove = true;
    clearTimeout(state._progMoveT);
    state._progMoveT = setTimeout(() => { state._progMove = false; }, smooth ? 1600 : 700); // net if the move is a no-op and no moveend fires
  }
  if (smooth && !zoomChanges) {
    state.map.panTo(latlng, { animate: true, duration: 1.1, easeLinearity: 0.92 }); // glide slightly longer than the ~1s fix gap, near-linear so speed stays steady
  } else {
    state.map.setView(latlng, zoom == null ? state.map.getZoom() : zoom);
  }
}

/* One list, severity and degraded together: chromatic where the board can read the river, greyscale
   where it cannot. Every row carries its own live count and its own checkbox, so the legend is also
   the filter and no state is describable but unfindable. */
function gaugeLegendRows() {
  const n = (typeof gaugeStateCounts === 'function') ? gaugeStateCounts() : {};
  return GAUGE_STATES.map((s) => {
    const deg = GAUGE_DEGRADED.includes(s);
    const px = deg ? 9 : Math.max(9, CAT_SIZE[s] - 3);
    const on = gaugeStateShown(s);
    return `<label class="lg-row${deg ? ' lg-deg' : ''}" title="${esc(t('gstate.' + s + '.note'))}">` +
      `<input type="checkbox" class="lg-ck" data-gs="${esc(s)}"${on ? ' checked' : ''}>` +
      `<span class="sw gauge-icon ${deg ? `deg-${s}` : `cat-${s}`}" style="width:${px}px;height:${px}px"></span>` +
      `<span class="lg-lbl">${esc(gaugeStateLabel(s))}</span>` +
      `<span class="lg-n">${esc(String(n[s] || 0))}</span></label>`;
  }).join('');
}

/* Counts refresh in place rather than through innerHTML: renderGauges() runs from the row's own
   change handler, and replacing the markup there would tear out the checkbox under the pointer. */
function renderMapLegend() {
  const el = state.legendEl;
  if (!el) return;
  const n = gaugeStateCounts();
  el.querySelectorAll('.lg-row').forEach((row) => {
    const ck = row.querySelector('.lg-ck');
    const num = row.querySelector('.lg-n');
    if (!ck || !num) return;
    num.textContent = String(n[ck.dataset.gs] || 0);
    ck.checked = gaugeStateShown(ck.dataset.gs);
  });
}

function mapLegendHtml() {
  return `<div class="lg-title">${esc(t('legend.gauges'))}</div>` +
    gaugeLegendRows() +
    `<div><span class="sw" style="width:10px">▲</span>${esc(t('legend.rise'))}</div>` +
    `<div><span class="sw" style="width:10px;color:var(--good)">▼</span>${esc(t('legend.fall'))}</div>` +
    `<div><span class="sw fcst-ring cat-moderate" style="width:10px;height:10px"></span>${esc(t('legend.fcrest'))}</div>` +
    `<div class="lg-title" style="margin-top:6px">${esc(t('legend.roads'))}</div>` +
    ['Closure', 'Flooding', 'Damage'].map((k) => {
      const rc = ROAD_COND[k];
      return `<div><span class="sw sw-line" style="background:${rc.color}"></span>${esc(roadLabel(rc))}</div>`;
    }).join('') +
    `<div><span class="reopen-icon">✓</span>${esc(t('legend.reopen'))}</div>` +
    `<div><span class="rsentry-icon">📢</span>${esc(t('legend.rsentry'))}</div>` +
    `<div><span class="wildfire-icon">🔥</span>${esc(t('legend.wildfire'))}</div>` +
    `<div><span class="wildfire-perim-key"></span>${esc(t('legend.wildfire.perim'))}</div>` +
    `<div><span class="wildfire-area-key"></span>${esc(t('legend.wildfire.area'))}</div>` +
    `<div class="lg-title" style="margin-top:6px">${esc(t('legend.cams'))}</div>` +
    `<div><span class="cam-icon cam-live">▶</span>${esc(t('cam.kind.live.long'))}</div>` +
    `<div><span class="cam-icon cam-still">📷</span>${esc(t('cam.kind.still.long'))}</div>` +
    `<div class="lg-title" style="margin-top:6px">${esc(t('legend.reports'))}</div>` +
    `<div><span style="margin-right:6px">💧</span>${esc(t('legend.lsr'))}</div>` +
    `<div><span style="margin-right:6px">🆘</span>${esc(t('legend.glyph'))}</div>`;
}

function initMap() {
  // autoPan clear of the AO chip / layer-pill band at the map top — popups otherwise clip against the container edge
  L.Popup.mergeOptions({ autoPanPaddingTopLeft: L.point(8, 120) });
  state.map = L.map('map', { zoomControl: false }).setView(CONFIG.center, CONFIG.zoom);
  // collapse the attribution bar to a tap-to-open ⓘ — it otherwise crowds the legend on short screens; OSM/CARTO/TxDOT credits stay one tap away (ToS + source-citation intact)
  state.map.attributionControl.setPrefix(`<span class="attr-i" title="${esc(t('attr.title'))}">ⓘ</span>`);
  const attrEl = state.map.attributionControl.getContainer();
  L.DomEvent.on(attrEl, 'click', (e) => { if (e.target.tagName === 'A') return; L.DomEvent.stop(e); attrEl.classList.toggle('attr-open'); });
  const attrib = '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
  state.baseLayers.dark = offlineTile('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: attrib, maxZoom: 19 });
  state.baseLayers.light = offlineTile('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: attrib, maxZoom: 19 });
  state.baseLayers.streets = offlineTile('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19 });

  // label boost pane: above radar (350) and alert polygons (400), below markers (600)
  state.map.createPane('labels');
  state.map.getPane('labels').style.zIndex = 450;
  state.map.getPane('labels').style.pointerEvents = 'none';
  // radar pane: control autoZIndex raises base layers above tilePane radar, so radar needs its own pane
  state.map.createPane('radar');
  state.map.getPane('radar').style.zIndex = 350;
  state.map.getPane('radar').style.pointerEvents = 'none';
  // tropical pane: above alert polygons (400) and radar, below labels (450) and markers (600); interactive for popups
  state.map.createPane('tropical');
  state.map.getPane('tropical').style.zIndex = 440;
  // storm-surge risk pane: a raster hazard below radar (350), labels (450), and markers (600)
  state.map.createPane('surge');
  state.map.getPane('surge').style.zIndex = 340;
  state.map.getPane('surge').style.pointerEvents = 'none';
  state.layers.labelBoost = offlineTile(labelBoostUrl(), { pane: 'labels', attribution: attrib, maxZoom: 19 }).addTo(state.map);

  // all radar/rainfall layers are OFF by default (owner directive) — explicit enable via layer control
  // group of pre-loaded per-frame tile layers; playback crossfades opacity (no per-step tile reload)
  state.layers.radar = L.layerGroup();
  const savedWin = sessionStorage.getItem(RAIN_WIN_KEY);
  state.rainWindow = CONFIG.mrmsWindows.includes(savedWin) ? savedWin : '1h';
  state.layers.mrms = L.tileLayer(bustSrc(CONFIG.mrmsUrl(state.rainWindow)), { opacity: 0.55, attribution: 'Rainfall: MRMS via IEM' });
  // MODELED flood extent (not observed) — off by default (hazard layers explicit-enable, owner directive)
  state.layers.inundation = new ArcGISExportLayer(CONFIG.inunExportUrl, {
    opacity: 0.72, maxZoom: 19,
    attribution: 'Flood inundation: NWM analysis (experimental) &copy; NOAA/NWPS',
  });
  // NOAA/NHC storm-surge risk (SLOSH MOM near worst-case): off by default (hazard layers
  // explicit-enable); cached national raster, maxNativeZoom pins the top LOD, Leaflet upsamples past it
  state.layers.surge = L.tileLayer(CONFIG.surgeUrl(CONFIG.surgeCat), {
    pane: 'surge', opacity: 0.55, maxNativeZoom: 14, maxZoom: 19,
    attribution: 'Storm surge risk: NOAA/NHC National Storm Surge Hazard Maps (SLOSH MOM)',
  });
  state.layers.surge.on('tileerror', () => { if (!state.surgeErr) { state.surgeErr = true; opNotice(t('surge.unavailable')); } });
  state.layers.surge.on('load', () => { state.surgeErr = false; });
  // HRRR model future-cast — MODEL data (never observed); per-hour WMS layers mounted at opacity 0
  // like the observed-radar frames, so stepping is opacity-only (never a per-step fetch-gated fade)
  state.rtl = { idx: 0, fut: false, hour: 1, playing: false, timer: null, wantNow: false };
  state.fcst = { runIso: null, hourLayers: [], metaFail: false, tileOk: false, tileFail: false };
  state.layers.fcstRadar = L.layerGroup();
  state.inunBucket = Math.floor(Date.now() / 3600000);
  state.refreshRadar = () => {
    state.layers.mrms.setUrl(bustSrc(CONFIG.mrmsUrl(state.rainWindow)));
    if (state.map.hasLayer(state.layers.radar)) fetchRadarFrames().catch(() => { /* keep last frames */ });
    if (state.map.hasLayer(state.layers.fcstRadar)) fcstFetchRun();
    const bucket = Math.floor(Date.now() / 3600000); // inundation updates hourly — redraw only on the hour
    if (bucket !== state.inunBucket) {
      state.inunBucket = bucket;
      if (state.map.hasLayer(state.layers.inundation)) state.layers.inundation.redraw();
    }
  };
  state.map.on('overlayadd', (e) => {
    if (e.layer === state.layers.mrms) updateMrmsLegend();
    if (e.layer === state.layers.inundation) $('#inun-legend').hidden = false;
    if (e.layer === state.layers.lwc) fetchLwc();
    if (e.layer === state.layers.riverSentry) fetchRiverSentry();
    if (e.layer === state.layers.wildfire) fetchWildfire();
    if (e.layer === state.layers.tropical) { showTropicalLegend(); fetchTropical().catch(() => { opNotice(t('note.tropfail')); }); }
    if (e.layer === state.layers.surge) $('#surge-legend').hidden = false;
    if ((state.camLayerList || []).includes(e.layer)) loadCameras().catch(() => { opNotice(t('note.camfail')); });
    if (e.layer === state.layers.fcstRadar) fcstEnable();
    if (e.layer !== state.layers.radar) return;
    rtlSync();
    fetchRadarFrames().catch(() => { $('#rs-label').textContent = t('note.radarfail'); });
  });
  state.map.on('overlayremove', (e) => {
    if (e.layer === state.layers.mrms) updateMrmsLegend();
    if (e.layer === state.layers.inundation) $('#inun-legend').hidden = true;
    if (e.layer === state.layers.tropical) { hideTropicalLegend(); state.tropicalAutoDone = true; } // manual toggle-off stops auto-enable
    if (e.layer === state.layers.crossStatus) state.xstatusAutoDone = true; // same: a deliberate toggle-off is not re-opened
    if (e.layer === state.layers.surge) $('#surge-legend').hidden = true;
    if (e.layer === state.layers.fcstRadar) fcstDisable();
    if (e.layer === state.layers.usgs) {
      if (state.usgsAutoOn && !state.usgsAutoRemoving) state.usgsFallbackDismissed = true; // user closed the auto fallback — don't re-offer until the feed recovers
      state.usgsAutoOn = false;
    }
    if (e.layer !== state.layers.radar) return;
    rtlSync();
    if (rtlDomain().total) rtlSet(state.rtl.idx); // forecast-only bar repaints in the shrunk domain
  });

  state.map.on('baselayerchange', (e) => {
    state.activeBase = e.layer === state.baseLayers.streets ? 'streets'
      : e.layer === state.baseLayers.light ? 'light' : 'dark';
    localStorage.setItem('respondertx.base', state.activeBase);
    // picking a CARTO base re-syncs the UI theme; Streets leaves the theme untouched
    if (state.activeBase !== 'streets' && state.activeBase !== document.documentElement.getAttribute('data-theme')) applyTheme(state.activeBase);
    else syncLabelBoost();
  });
  // default base is Streets (owner directive); saved choice or ?base= overrides — layer control not built yet, set directly
  const baseParam = new URLSearchParams(location.search).get('base');
  // hasOwnProperty guard (theme-fix pattern): ?base=toString must not resolve via the prototype chain
  const knownBase = (b) => !!b && Object.prototype.hasOwnProperty.call(state.baseLayers, b);
  const wantBase = baseParam === 'osm' ? 'streets'
    : (knownBase(baseParam) ? baseParam : null) || localStorage.getItem('respondertx.base') || 'streets';
  state.activeBase = knownBase(wantBase) ? wantBase : 'streets';
  state.baseLayers[state.activeBase].addTo(state.map);

  state.layers.alerts = L.layerGroup().addTo(state.map);
  state.layers.gauges = L.layerGroup().addTo(state.map);
  state.layers.fcstMax = L.layerGroup().addTo(state.map);
  // clustered — off by default; degrade to a plain group if the vendored plugin failed to load
  state.layers.usgs = L.markerClusterGroup
    ? L.markerClusterGroup({ disableClusteringAtZoom: 10, maxClusterRadius: 40 })
    : L.layerGroup();
  state.layers.lsrs = L.layerGroup().addTo(state.map);
  state.layers.lsrsAged = L.layerGroup(); // history layer — off by default, toggle in layer control
  state.layers.requests = L.layerGroup().addTo(state.map);
  state.layers.shelters = L.layerGroup().addTo(state.map);
  state.layers.crossings = L.layerGroup().addTo(state.map);
  // TDEM DriveTexas live road conditions — flood-relevant subset only, first-class toggle (owner request), on by default
  state.layers.roadClosures = L.layerGroup().addTo(state.map);
  // recently-reopened roads (recovery ✓) — OFF by default, explicit opt-in nested under road closures; flood-scoped
  state.layers.roadReopen = L.layerGroup();
  // NOAA NHC active tropical cyclones (Esri Living Atlas): cone/track/positions/watches; OFF by default, lazy-loaded on first enable
  state.layers.tropical = L.layerGroup();
  // TxGIO low-water-crossing location inventory — OFF by default, lazy-loaded, canvas-rendered; LOCATIONS, not live status
  state.layers.lwc = L.layerGroup();
  // crossing status reported by Central Texas jurisdictions (ATX Floods) — OFF by default; the feed
  // times a record's last change, never a confirmation, so these are never counted as live hazards
  state.layers.crossStatus = L.layerGroup();
  // River Sentry siren tower sites — OFF by default, lazy-loaded; REPORTED LOCATIONS from a public
  // My Maps export, never a claim that a tower is powered, working, or still standing
  state.layers.riverSentry = L.layerGroup();
  // wildfire incidents an agency has opened a record for — OFF by default, lazy-loaded; REPORTED
  // ORIGIN POINTS, never a fire perimeter, and acreage/containment are reported figures
  state.layers.wildfire = L.layerGroup();
  // cameras: one group per AO region (every source pooled into the region it sits in), all OFF by
  // default, lazy-loaded, clustered; plain group if the markercluster plugin failed to load
  const camGroup = () => (L.markerClusterGroup
    ? L.markerClusterGroup({ disableClusteringAtZoom: 12, maxClusterRadius: 46 })
    : L.layerGroup());
  const camOverlays = {};
  state.camLayerList = [];
  for (const p of camRegionsAll()) {
    const lyr = camGroup();
    state.layers[camRegionKey(p.id)] = lyr;
    state.camLayerList.push(lyr);
    camOverlays[`Cameras: ${regionLabel(p, getLang())}`] = lyr; // code-side buckets name themselves via i18n, never by bare id
  }
  initCamRegionRows(); // sheet rows + pills share the same region list as the layers just built
  L.control.layers({
    'Dark (CARTO)': state.baseLayers.dark,
    'Light (CARTO)': state.baseLayers.light,
    'Streets (OSM)': state.baseLayers.streets,
  }, {
    'Place labels (boost)': state.layers.labelBoost,
    'Radar & forecast': state.layers.radar,
    'Radar & forecast (HRRR)': state.layers.fcstRadar,
    'Rainfall (MRMS)': state.layers.mrms,
    'Flood inundation: NWM model (est.)': state.layers.inundation,
    'Tropical cyclone tracker (NHC)': state.layers.tropical,
    'Storm surge risk (NHC SLOSH)': state.layers.surge,
    'Hazard alerts (NWS)': state.layers.alerts,
    'River gauges (NOAA)': state.layers.gauges,
    'Forecast crests (RFC max)': state.layers.fcstMax,
    'USGS gauges (raw stage)': state.layers.usgs,
    'Storm reports (LSR)': state.layers.lsrs,
    'Aged storm reports (history)': state.layers.lsrsAged,
    'Notices (curated + field)': state.layers.requests,
    'Shelters': state.layers.shelters,
    'Low-water crossings': state.layers.crossings,
    'Road closures / high water (TxDOT)': state.layers.roadClosures,
    'Road reopenings (recovering)': state.layers.roadReopen,
    'Low-water crossings (locations · not live status)': state.layers.lwc,
    'Crossings reported closed (Central Texas jurisdictions)': state.layers.crossStatus,
    'River Sentry siren sites (reported locations · not live status)': state.layers.riverSentry,
    'Wildfire incidents (reported points · not perimeters)': state.layers.wildfire,
    ...camOverlays,
  }, { collapsed: true }).addTo(state.map);

  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'map-legend');
    state.legendEl = div; // relocalizeDynamic re-renders this on a live language switch
    div.innerHTML = mapLegendHtml();
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div); // scrolling the (now scrollable) expanded legend must not zoom the map
    L.DomEvent.on(div, 'click', (e) => {
      if (e.target.closest('.lg-row')) return; // a filter row is a control, not the expand/collapse target
      div.classList.toggle('open'); // mobile: collapsed to title pill by default
    });
    L.DomEvent.on(div, 'change', (e) => {
      const ck = e.target.closest('.lg-ck');
      if (!ck) return;
      state.gaugeFilter[ck.dataset.gs] = ck.checked;
      saveGaugeFilter();
      renderGauges();
    });
    return div;
  };
  legend.addTo(state.map);

  // overlay legends: collapsed to their title pill by default at every size; tap toggles pill/expanded
  document.querySelectorAll('.ov-legend').forEach((lg) => {
    L.DomEvent.disableClickPropagation(lg);
    L.DomEvent.disableScrollPropagation(lg);
    lg.classList.remove('open');
    L.DomEvent.on(lg, 'click', (e) => {
      if (e.target.closest('#mrms-legend-chips')) return; // chips pick a window, not toggle
      lg.classList.toggle('open');
    });
  });
  $('#mrms-legend-chips').addEventListener('click', (e) => {
    const b = e.target.closest('.mrms-chip');
    if (b) setRainWindow(b.dataset.win);
  });

  state.map.on('click', (e) => {
    const form = $('#new-request-form'); // absent on the public mirror: deploy.sh strips the markup
    if (!form || !form.classList.contains('open')) return;
    state.pendingLatLng = e.latlng;
    $('#f-latlon').value = `${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`;
  });

  // one bar for + / − / ⌖ — two stacked boxes read as clutter over the NW warning polygons
  const gpsWait = window.gpsWait = (on) => {
    const btn = document.querySelector('.locate-btn');
    if (btn) btn.classList.toggle('locating', on);
    const chip = $('#gps-wait');
    if (chip) chip.hidden = !on;
  };
  const NavControl = L.Control.Zoom.extend({
    onAdd(map) {
      const bar = L.Control.Zoom.prototype.onAdd.call(this, map);
      const a = L.DomUtil.create('a', 'locate-btn', bar);
      a.href = '#'; a.title = t('map.mylocation'); a.textContent = '⌖';
      a.setAttribute('data-i18n-title', 'map.mylocation'); // built once; applyI18n retitles it on a language switch
      a.setAttribute('data-i18n-aria', 'map.mylocation');
      a.setAttribute('aria-label', t('map.mylocation'));
      // transient re-center hint drawer, anchored to the right of ⌖; tapping it re-centers like ⌖ itself
      const drawer = L.DomUtil.create('span', 'recenter-drawer', a);
      drawer.setAttribute('role', 'button');
      drawer.setAttribute('data-i18n', 'map.recenter');
      drawer.textContent = t('map.recenter');
      drawer.hidden = true;
      L.DomEvent.on(drawer, 'click', (e) => { L.DomEvent.stop(e); recenterAndFollow(); });
      state.recenterDrawer = drawer;
      L.DomEvent.on(a, 'click', (e) => { L.DomEvent.stop(e); recenterAndFollow(); });
      // orientation is navigation: the rose joins + / − / ⌖ instead of holding its own box on the far edge
      const c = L.DomUtil.create('a', 'compass-btn', bar);
      c.href = '#';
      c.setAttribute('role', 'button');
      c.innerHTML = CTL_ICON_COMPASS;
      setCompassLabel(c, 'ctl.compass.title', 'ctl.compass.aria');
      state.compassEl = c;
      state.compassRose = c.querySelector('svg');
      L.DomEvent.on(c, 'click', (e) => { L.DomEvent.stop(e); toggleCompassHeading(c); });
      return bar;
    },
    onRemove() { stopCompassHeading(); },
  });
  state.map.addControl(new NavControl({ position: 'topleft' }));
  // the stock checkbox control is hidden (CSS) but stays on the map as the
  // overlay-event registry; this button in its old anchor spot opens the grouped sheet
  const sheetBtn = L.control({ position: 'topright' });
  sheetBtn.onAdd = () => {
    const div = L.DomUtil.create('div', 'leaflet-bar ls-trigger');
    // inline SVG, not emoji — desktop emoji fonts render 🗂 as a flat black box that clashes with the zoom bar
    div.innerHTML = `<a href="#" role="button" title="${esc(t('sheet.open'))}" aria-label="${esc(t('sheet.open'))}" data-i18n-title="sheet.open" data-i18n-aria="sheet.open">${CTL_ICON_LAYERS}</a>`;
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.on(div.firstChild, 'click', (e) => {
      L.DomEvent.stop(e);
      if (layerSheetIsOpen()) closeLayerSheet(); else openLayerSheet();
    });
    return div;
  };
  sheetBtn.addTo(state.map);
  // views trigger sits with the layers trigger: what the map SHOWS and how you LOOK at it, together.
  // It names the lens that owns the board and grows an exit segment while one is up (see syncViewsTrigger)
  const viewsBtn = L.control({ position: 'topright' });
  viewsBtn.onAdd = () => {
    const div = L.DomUtil.create('div', 'leaflet-bar ls-trigger views-trigger');
    div.innerHTML = `<a href="#" role="button" class="views-open">${CTL_ICON_VIEWS}<span class="views-tag"></span></a>` +
      '<a href="#" role="button" class="views-back" hidden>✕</a>';
    L.DomEvent.disableClickPropagation(div);
    state.viewsEl = div;
    L.DomEvent.on(div.querySelector('.views-open'), 'click', (e) => {
      L.DomEvent.stop(e);
      if (viewsSheetIsOpen()) closeViewsSheet(); else openViewsSheet();
    });
    L.DomEvent.on(div.querySelector('.views-back'), 'click', (e) => { L.DomEvent.stop(e); openView('live'); });
    syncViewsTrigger();
    return div;
  };
  viewsBtn.addTo(state.map);
  // Share stays first-class: the map control opens the Share surface that also owns export and subscribe
  const shareCtl = L.control({ position: 'topright' });
  shareCtl.onAdd = () => {
    const div = L.DomUtil.create('div', 'leaflet-bar ls-trigger share-trigger');
    div.innerHTML = `<a href="#" role="button" title="${esc(t('ctl.share.title'))}" aria-label="${esc(t('ctl.share.aria'))}" data-i18n-title="ctl.share.title" data-i18n-aria="ctl.share.aria">${CTL_ICON_LINK}</a>`;
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.on(div.firstChild, 'click', (e) => {
      L.DomEvent.stop(e);
      openShareSheet();
    });
    return div;
  };
  shareCtl.addTo(state.map);
  initAoJump();
  initLayerPills();
  initLayerSheet();
  initViewsSheet();
  state.map.on('locationfound', (e) => {
    gpsWait(false);
    const deliberate = state.centerNextFix; // an explicit locate/recenter; watch ticks never set this
    state.myPos = e.latlng;
    state.driveFixAt = Date.now();
    if (!state.posLayer) {
      state.posAccuracy = L.circle(e.latlng, { radius: e.accuracy, weight: 1, color: cssVar('--accent') || '#3987e5', fillOpacity: 0.08 });
      state.posMarker = L.marker(e.latlng, { icon: youIcon(), title: t('you.title'), zIndexOffset: 2000, interactive: false });
      state.posLayer = L.layerGroup([state.posAccuracy, state.posMarker]).addTo(state.map);
    } else {
      state.posAccuracy.setLatLng(e.latlng); state.posAccuracy.setRadius(e.accuracy);
      state.posMarker.setLatLng(e.latlng); // watch fixes move the marker in place without restarting its pulse
      if (deliberate) state.posMarker.setIcon(youIcon()); // fresh icon element restarts the finite pulse
    }
    // deliberate locate snaps to locateZoom once; while following we track the fix at the current zoom; otherwise the marker updates in place
    if (state.centerNextFix) { state.centerNextFix = false; progSetView(e.latlng, Math.max(state.map.getZoom(), CONFIG.locateZoom)); }
    else if (state.followMe) { progSetView(e.latlng, null, true); } // glide to the fix instead of snapping
    // marker + accuracy circle + glide update on every fix; the heavy re-rank throttles so ~1s fixes stay cheap
    const nowMs = Date.now();
    if (nowMs - state.driveRankAt >= CONFIG.driveLocateMs) {
      state.driveRankAt = nowMs;
      renderRequests();
      renderDriveMode(); // re-rank the glance list by the new fix
      renderRoadsTab(); // and the Roads list, which sorts nearest-first once a fix exists
      renderAlertList(); // the alerts scope becomes the fix, so the list and its header re-lead on it
      renderThreatStrip(); // and the all-clear line now speaks for that radius instead of the state
    }
    startLocTrack(); // opt-in tracker begins once the first fix lands; runs in the app and Drive Mode alike
  });
  state.map.on('locationerror', () => {
    gpsWait(false);
    opNotice(t('note.locfail'));
  });
  // dragstart fires ONLY on a genuine pointer drag (programmatic panTo never fires it), so exit follow
  // unconditionally; this is what lets the user grab the map mid-glide now that a glide is almost always in flight
  state.map.on('dragstart', () => { if (state.followMe) { state.followMe = false; flashRecenterHint(); } });
  // zoom (user pinch/scroll/dblclick) also exits, but our own setView-with-zoom fires zoomstart, hence the _progMove guard
  state.map.on('zoomstart', () => { if (state._progMove || !state.followMe) return; state.followMe = false; flashRecenterHint(); });
  state.map.on('moveend', () => { state._progMove = false; }); // clear the guard once our move settles

  const declutter = () => state.map.getContainer().classList.toggle('z-low', state.map.getZoom() < 9);
  state.map.on('zoomend', declutter);
  declutter();
}

// YOU marker: rings run a finite pulse (CSS iteration-count) then settle static; rebuilding the icon restarts it
function youIcon() {
  return L.divIcon({
    className: '',
    html: `<div class="my-pos-wrap"><div class="my-pos-ring"></div><div class="my-pos-ring d2"></div><div class="my-pos-core"></div><div class="my-pos-label">${esc(t('you.label'))}</div></div>`,
    iconSize: [48, 48], iconAnchor: [24, 24],
  });
}

// deliberate re-center: recenter on the freshest fix and re-engage nav-app follow (shared by ⌖ and the hint drawer)
function recenterAndFollow() {
  state.centerNextFix = true;
  state.followMe = true;
  if (window.gpsWait) window.gpsWait(true);
  if (state.myPos) progSetView(state.myPos, Math.max(state.map.getZoom(), CONFIG.locateZoom)); // instant feedback from the last fix
  state.map.locate({ enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 });
  retractRecenterHint(); // following again → hide any showing hint
}

// transient hint: slide the drawer out beside ⌖, flash a few times, then retract; one shot per manual exit-from-follow
function flashRecenterHint() {
  const d = state.recenterDrawer;
  if (!d || !state.myPos || state.followMe || state.recenterHintOn) return;
  state.recenterHintOn = true;
  d.hidden = false;
  void d.offsetWidth; // reflow in the collapsed state so the slide-out transition runs
  d.classList.add('open');
  clearTimeout(state.recenterHintT);
  state.recenterHintT = setTimeout(retractRecenterHint, 2600); // slide-out + 3 flashes, then retract
}

function retractRecenterHint() {
  const d = state.recenterDrawer;
  if (!d) return;
  clearTimeout(state.recenterHintT);
  state.recenterHintOn = false;
  if (!d.classList.contains('open')) { d.hidden = true; return; }
  d.classList.remove('open');
  const hide = () => { d.hidden = true; d.removeEventListener('transitionend', hide); };
  d.addEventListener('transitionend', hide);
  setTimeout(() => { if (!d.classList.contains('open')) d.hidden = true; }, 400); // fallback if transitionend never fires
}

/* ---------- live compass heading: tap the rose to rotate it to the device heading; static north-up otherwise ---------- */

function toggleCompassHeading(anchor) {
  if (state.compassLive) { stopCompassHeading(); return; }
  const DOE = window.DeviceOrientationEvent;
  if (typeof DOE === 'undefined') { compassNotice('ctl.compass.unavailable'); return; }
  if (typeof DOE.requestPermission === 'function') { // iOS 13+ requires a per-gesture permission grant
    DOE.requestPermission()
      .then((resp) => { if (resp === 'granted') startCompassHeading(anchor); else compassNotice('ctl.compass.denied'); })
      .catch(() => compassNotice('ctl.compass.denied'));
    return;
  }
  startCompassHeading(anchor);
}

function startCompassHeading(anchor) {
  const evName = ('ondeviceorientationabsolute' in window) ? 'deviceorientationabsolute' : 'deviceorientation';
  state.compassEvName = evName;
  state.compassAnchor = anchor;
  state.compassHandler = onCompassOrientation;
  state.compassLive = true;
  state.compassGotFix = false;
  state.compassHeading = 0;
  state.compassApplied = null;
  window.addEventListener(evName, onCompassOrientation, true);
  if (state.compassEl) L.DomUtil.addClass(state.compassEl, 'live');
  setCompassLabel(anchor, 'ctl.compass.live', 'ctl.compass.live');
  // desktop or no-signal: if no valid heading lands shortly, fall back to the static rose so the control never sits blank
  clearTimeout(state.compassProbeT);
  state.compassProbeT = setTimeout(() => { if (state.compassLive && !state.compassGotFix) { stopCompassHeading(); compassNotice('ctl.compass.unavailable'); } }, 1500);
}

function stopCompassHeading() {
  if (state.compassHandler && state.compassEvName) window.removeEventListener(state.compassEvName, state.compassHandler, true);
  clearTimeout(state.compassProbeT);
  if (state.compassRaf) { cancelAnimationFrame(state.compassRaf); state.compassRaf = 0; }
  state.compassLive = false;
  state.compassHandler = null;
  if (state.compassRose) state.compassRose.style.transform = ''; // back to the static north-up rose
  if (state.compassEl) L.DomUtil.removeClass(state.compassEl, 'live');
  if (state.compassAnchor) setCompassLabel(state.compassAnchor, 'ctl.compass.title', 'ctl.compass.aria');
}

function onCompassOrientation(e) {
  let heading;
  if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) heading = e.webkitCompassHeading; // iOS: degrees clockwise from magnetic north
  else if (e.alpha != null) heading = 360 - e.alpha; // alpha runs counter-clockwise, so a north-up rose needs 360 - alpha
  else return; // no usable reading (typical on desktop), leave the rose static
  heading = ((heading % 360) + 360) % 360;
  state.compassGotFix = true;
  if (state.compassApplied != null && angleGap(heading, state.compassApplied) < 1) return; // sub-degree jitter, skip the repaint
  state.compassHeading = heading;
  if (!state.compassRaf) state.compassRaf = requestAnimationFrame(applyCompassRotation);
}

function applyCompassRotation() {
  state.compassRaf = 0;
  if (!state.compassRose) return;
  state.compassApplied = state.compassHeading;
  state.compassRose.style.transform = `rotate(${-state.compassHeading}deg)`; // negate heading so the rose's N needle points to true north
}

function angleGap(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

function setCompassLabel(anchor, titleKey, ariaKey) {
  if (!anchor) return;
  anchor.setAttribute('data-i18n-title', titleKey);
  anchor.setAttribute('data-i18n-aria', ariaKey);
  anchor.title = t(titleKey);
  anchor.setAttribute('aria-label', t(ariaKey));
}

function compassNotice(key) { opNotice(t(key)); }

/* ---------- map-control icons — stroke SVGs inherit the themed .leaflet-bar color ---------- */

const CTL_ICON_LAYERS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 12 12 17 22 12"/><polyline points="2 17 12 22 22 17"/></svg>';
const CTL_ICON_VIEWS = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.6 12S5.2 5.6 12 5.6 22.4 12 22.4 12 18.8 18.4 12 18.4 1.6 12 1.6 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
const CTL_ICON_LINK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
// north-up compass rose: red north needle, muted south needle, "N" tick; the map is always north up
const CTL_ICON_COMPASS = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="13" r="7.4" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.65"/><polygon points="12 6.5 8.7 15.2 12 13.2 15.3 15.2" fill="#e5484d" stroke="#e5484d" stroke-width="0.5" stroke-linejoin="round"/><polygon points="12 19.9 8.7 15.2 12 17.2 15.3 15.2" fill="currentColor" opacity="0.7"/><text x="12" y="5.2" text-anchor="middle" font-size="7" font-weight="800" fill="currentColor">N</text></svg>';

/* ---------- AO quick-jump — pills along the map top edge, never another stacked box ---------- */

/* The picked AO is part of the view the board restores, so it lives beside the control rather than
   inside its closure: initAoJump() publishes the handle, and aoSelectById() is how a saved or
   shared view names a pill without synthesizing a click on it. */
let aoCtl = null;

function aoPickedId() { return aoCtl && aoCtl.picked ? aoCtl.picked[2] : null; }

// select an AO pill by its event-config id; fit only when the caller has no framing of its own
function aoSelectById(id, fit) {
  if (!aoCtl || !id) return false;
  const p = aoCtl.presets.find((x) => x[2] === id);
  if (!p) return false; // a region dropped from the event config since the view was saved
  aoCtl.picked = p;
  aoCtl.label(p[0]);
  if (fit) state.map.fitBounds(p[1]);
  return true;
}

function initAoJump() {
  const AO_PRESETS = resolveAoPresets(getLang()); // event-config pills (data/event.json) or built-in fallback
  const jump = L.DomUtil.create('div', 'ao-jump', state.map.getContainer());
  const cur = L.DomUtil.create('button', 'ao-current', jump);
  cur.setAttribute('aria-haspopup', 'true');
  cur.setAttribute('aria-expanded', 'false');
  cur.title = t('ao.current.title');
  cur.setAttribute('data-i18n-title', 'ao.current.title');
  const row = L.DomUtil.create('div', 'ao-row', jump);
  let idleT = 0;
  const label = (txt) => { cur.innerHTML = `◎ ${esc(txt)} <span class="ao-caret">▾</span>`; };
  aoCtl = { presets: AO_PRESETS, picked: AO_PRESETS[0], label };
  const collapse = () => { jump.classList.remove('open'); cur.setAttribute('aria-expanded', 'false'); clearTimeout(idleT); };
  const armIdle = () => { clearTimeout(idleT); idleT = setTimeout(collapse, 6000); };
  const expand = () => { jump.classList.add('open'); cur.setAttribute('aria-expanded', 'true'); armIdle(); };
  label(aoCtl.picked[0]);
  L.DomEvent.on(cur, 'click', () => (jump.classList.contains('open') ? collapse() : expand()));
  for (const preset of AO_PRESETS) {
    const b = L.DomUtil.create('button', 'ao-chip', row);
    b.textContent = preset[0];
    b.title = t('ao.chip.title');
    b.setAttribute('data-i18n-title', 'ao.chip.title');
    L.DomEvent.on(b, 'click', () => {
      aoCtl.picked = preset;
      state.map.fitBounds(preset[1]);
      label(preset[0]);
      collapse(); // the map jump is the feedback — a lingering open row competes with it
      if (typeof scheduleViewSave === 'function') scheduleViewSave();
    });
  }
  jump.addEventListener('pointermove', () => { if (jump.classList.contains('open')) armIdle(); });
  document.addEventListener('pointerdown', (e) => {
    if (jump.classList.contains('open') && !jump.contains(e.target)) collapse();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && jump.classList.contains('open')) collapse();
  });
  state.map.on('moveend', () => {
    const p = aoCtl.picked;
    label(L.latLngBounds(p[1]).contains(state.map.getCenter()) ? p[0] : t('ao.custom'));
  });
  L.DomEvent.disableClickPropagation(jump);
  L.DomEvent.disableScrollPropagation(jump);
}

/* ---------- active-layer pills — name each non-default overlay that is ON; hidden at rest ---------- */

const PILL_LAYERS = (CONFIG.wxUnified
  ? [['wx', 'layers.wx']]
  : [['radar', 'layers.radar'], ['fcstRadar', 'layers.fcstradar']]
).concat([
  ['tropical', 'layers.tropical'],
  ['surge', 'layers.surge'],
  ['mrms', 'layers.rain'],
  ['inundation', 'layers.inun'],
  ['usgs', 'layers.usgs'],
  ['lsrsAged', 'layers.lsrhist'],
  ['lwc', 'layers.lwc'],
  ['roadReopen', 'layers.reopen'],
  ['riverSentry', 'layers.rsentry'],
  ['wildfire', 'layers.wildfire'],
]); // region camera pills are appended by initCamRegionRows()

// a static row carries an i18n key; a region camera row takes its name from the event config
function pillLabel(k, key) {
  if (key) return t(key);
  const p = camRegions().find((r) => camRegionKey(r.id) === k);
  return p ? `📷 ${regionLabel(p, getLang())}` : k;
}

// membership test that understands the virtual merged 'wx' row (radar OR forecast); null = no such layer
function layerRowOn(k) {
  if (k === 'wx') return state.map.hasLayer(state.layers.radar) || state.map.hasLayer(state.layers.fcstRadar);
  const lyr = state.layers[k];
  return lyr ? state.map.hasLayer(lyr) : null;
}
function wxRemove() {
  [state.layers.radar, state.layers.fcstRadar].forEach((l) => { if (state.map.hasLayer(l)) state.map.removeLayer(l); });
}
// toggle the merged pair together; add radar first so forecast-enable sees it and holds the playhead at NOW
function wxToggle() {
  if (layerRowOn('wx')) { wxRemove(); return; }
  state.layers.radar.addTo(state.map);
  state.layers.fcstRadar.addTo(state.map);
}

// beyond this the camera regions are named as a count, not one pill each: thirteen pills wrap
// into three rows over the map, which is what a statewide toggle would produce in one tap
const CAM_PILL_MAX = 2;

function renderLayerPills() {
  const el = document.getElementById('layer-pills');
  if (state.lsBulk || !el) return; // mid parent toggle: the caller repaints once the layers settle
  const on = PILL_LAYERS.filter(([k]) => layerRowOn(k) === true);
  if (!on.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const cams = on.filter(([k]) => k.startsWith(CAM_REGION_PREFIX));
  const rows = cams.length > CAM_PILL_MAX ? on.filter(([k]) => !k.startsWith(CAM_REGION_PREFIX)) : on;
  const pill = (k, label, attr) =>
    `<button class="layer-pill" ${attr}="${k}" title="${esc(t('layers.off'))}">${esc(label)} <span class="lp-x">✕</span></button>`;
  el.innerHTML = rows.map(([k, key]) => pill(k, pillLabel(k, key), 'data-layer')).join('') +
    (cams.length > CAM_PILL_MAX
      ? pill('1', `📷 ${t('pill.cams.n').replace('{n}', fmtNum(cams.length))}`, 'data-camoff')
      : '') +
    `<button class="layer-pill lp-add" title="${esc(t('layers.more'))}">＋</button>`;
  el.querySelectorAll('.layer-pill[data-layer], .layer-pill[data-camoff]').forEach((b) =>
    b.addEventListener('click', () => {
      if (pbBlocksLive(state)) { pbLayersLockedNote(); return; } // playback owns layer state — same lock as the sheet
      if (b.dataset.camoff) { camRegionsOff(); return; } // the collapsed pill drops every camera region
      if (b.dataset.layer === 'wx') { wxRemove(); return; } // merged pill drops both underlying layers
      state.map.removeLayer(state.layers[b.dataset.layer]);
    }));
  el.querySelector('.lp-add').addEventListener('click', openLayerSheet);
}

// every camera region off in one action, repainting once (the collapsed pill's ✕)
function camRegionsOff() {
  state.lsBulk = true;
  try {
    for (const p of camRegionsAll()) {
      const lyr = state.layers[camRegionKey(p.id)];
      if (lyr && state.map.hasLayer(lyr)) state.map.removeLayer(lyr);
    }
  } finally { state.lsBulk = false; }
  renderLayerPills();
  layerSheetSync();
}

function initLayerPills() {
  const el = L.DomUtil.create('div', 'layer-pills', state.map.getContainer());
  el.id = 'layer-pills';
  el.hidden = true;
  L.DomEvent.disableClickPropagation(el);
  L.DomEvent.disableScrollPropagation(el);
  // the layers control fires these for programmatic adds too (?radar=1, auto-USGS fallback, deep links)
  state.map.on('overlayadd overlayremove', renderLayerPills);
}

/* ---------- grouped layer sheet — the user-facing picker; groups, plain names, subtext ----------
   Rows toggle via map.addLayer/removeLayer on control-registered layers, so the map still fires
   overlayadd/overlayremove — pills, MRMS legend, radar scrub, and camera/LWC lazy-loads keep working. */

// merged (wxUnified) collapses radar + forecast into one virtual 'wx' row; legacy keeps the two separate rows
const WX_RAIN_ROWS = CONFIG.wxUnified
  ? [['wx', '📡', 'layers.wx', 'sheet.s.wx', null, false]]
  : [
    ['radar', '📡', 'layers.radar', 'sheet.s.radar', null, false],
    ['fcstRadar', '🌦', 'layers.fcstradar', 'sheet.s.fcstradar', null, false],
  ];

// one camera row per AO region, filled from the event config by initCamRegionRows()
const CAM_ROWS = [];

// [layerKey, iconHtml, nameKey, subKey, provenanceBadge|null, onByDefault, child?, camSub?, region?]
const SHEET_GROUPS = [
  ['sheet.g.base', [
    ['labelBoost', '🔤', 'layers.labels', 'sheet.s.labels', null, true],
  ]],
  ['sheet.g.water', [
    ['gauges', '<span class="gauge-icon cat-moderate"></span>', 'layers.gauges', 'sheet.s.gauges', null, true],
    ['usgs', '📈', 'layers.usgs', 'sheet.s.usgs', null, false],
    ['fcstMax', '<span class="fcst-ring cat-moderate"></span>', 'layers.fcst', 'sheet.s.fcst', null, true],
    ['inundation', '🌊', 'layers.inun', 'sheet.s.inun', null, false],
    ['crossings', '⛔', 'layers.crossings', 'sheet.s.crossings', 'curated', true],
    // off until the feed carries a confirmable change, then maybeAutoXstatus() enables it
    ['crossStatus', '🚨', 'layers.xstatus', 'sheet.s.xstatus', 'official', false],
    ['lwc', '📍', 'layers.crossall', 'sheet.s.crossall', 'official', false],
    ['riverSentry', '<span class="rsentry-icon">📢</span>', 'layers.rsentry', 'sheet.s.rsentry', null, false],
  ]],
  ['sheet.g.rain', WX_RAIN_ROWS.concat([
    ['mrms', '🌧', 'layers.rain', 'sheet.s.rain', null, false],
  ])],
  ['sheet.g.tropical', [
    ['tropical', '🌀', 'layers.tropical', 'sheet.s.tropical', 'official', false],
    ['surge', '🌊', 'layers.surge', 'sheet.s.surge', 'official', false],
  ]],
  // fire is a hazard domain, so it sits with the other hazard domains rather than in the reports
  // grab-bag it shipped in. Groups here are read top-down under time pressure.
  ['sheet.g.fire', [
    ['wildfire', '<span class="wildfire-icon">🔥</span>', 'layers.wildfire', 'sheet.s.wildfire', 'official', false],
  ]],
  ['sheet.g.roads', [
    ['roadClosures', '🚧', 'layers.roads', 'sheet.s.roads', 'official', true],
    ['roadReopen', '<span class="reopen-icon">✓</span>', 'layers.reopen', 'sheet.s.reopen', 'official', false, true],
  ]],
  ['sheet.g.cameras', CAM_ROWS],
  ['sheet.g.reports', [
    ['alerts', '⚠️', 'layers.alerts', 'sheet.s.alerts', 'official', true],
    ['lsrs', '💧', 'layers.lsr', 'sheet.s.lsr', 'official', true],
    ['lsrsAged', '🕓', 'layers.lsrhist', 'sheet.s.lsrhist', null, false],
    ['requests', '🆘', 'layers.notices', 'sheet.s.notices', 'curated', true],
    ['shelters', '🏠', 'layers.shelters', 'sheet.s.shelters', 'curated', true],
  ]],
];

// camera sub-groups are the region bands (coast first); each region row carries its band in tuple[7]
const CAM_SUBGROUPS = [
  ['coast', 'sheet.g.cams.coast'],
  ['central', 'sheet.g.cams.central'],
  ['north', 'sheet.g.cams.north'],
  ['west', 'sheet.g.cams.west'],
  ['outstate', 'sheet.g.cams.outstate'],
];

// region camera rows + pills, built from data/event.json once the event config is applied
function initCamRegionRows() {
  CAM_ROWS.length = 0;
  for (const p of camRegionsAll()) {
    const k = camRegionKey(p.id);
    CAM_ROWS.push([k, '\u{1F4F7}', null, null, 'official', false, true, p.band || CAM_SUBGROUPS[0][0], p]);
    PILL_LAYERS.push([k, null]);
  }
}

/* Links shared before the by-region split carry one param per source. Each maps onto the regions
   that source actually covered, measured from data/cameras.json, so an old link still shows the
   same cameras. '*' is a statewide source. These params are frozen: never renamed, never dropped. */
const CAM_LEGACY_PARAMS = {
  cams: '*',                        // TxDOT road cams, statewide
  camr: '*',                        // USGS river/flood cams, statewide
  cama: ['austin'],                 // City of Austin
  camf: ['austin'],                 // ATX Floods low-water crossings
  camh: ['houston', 'centraltx'],   // Houston TranStar
  caml: ['dfw'],                    // City of Arlington
  came: ['elpaso'],                 // El Paso international bridges
  camm: ['austin'],                 // Hays County
};

// a region with no cameras is not a row worth offering; before the inventory lands, count is
// undefined and every row shows, which is what lets the user turn one on and trigger the load
function camRegionHasCams(p) {
  const n = state.camCounts && state.camCounts[p.id];
  return !Number.isFinite(n) || n > 0;
}

/* ---------- camera parent toggles: one statewide, one per band ----------
   A parent holds no state of its own. It reports what its children are doing, so turning three
   regions on individually leaves the statewide parent reading partial rather than off. */

const camTriState = (on, total) => (total > 0 && on === total ? 'on' : on > 0 ? 'mixed' : 'off');

// the rows a parent owns: every camera region, or one band. A region with no cameras is not
// offered as a row, so the parent that would claim to cover it does not count it either.
function camParentRows(band) {
  return CAM_ROWS.filter((r) => (band ? r[7] === band : true) && camRegionHasCams(r[8]));
}

const camParentOn = (rows) => rows.filter((r) => layerRowOn(r[0]) === true).length;

// off or partial turns every child on; only a fully-on parent turns them back off
function camParentToggle(band) {
  const rows = camParentRows(band);
  const turnOff = camTriState(camParentOn(rows), rows.length) === 'on';
  state.lsBulk = true; // 13 layers, one repaint: the sheet and the pill row redraw after the loop
  try {
    for (const [k] of rows) {
      const lyr = state.layers[k];
      if (!lyr) continue;
      if (turnOff) { if (state.map.hasLayer(lyr)) state.map.removeLayer(lyr); }
      else if (!state.map.hasLayer(lyr)) lyr.addTo(state.map); // registered overlay — fires overlayadd (lazy inventory load)
    }
  } finally { state.lsBulk = false; }
  renderLayerPills();
  layerSheetSync();
}

// role=checkbox, not switch: aria-checked="mixed" is the state a partial parent has to announce,
// and the switch role does not support it
function camParentAttrs(st, label, dis) {
  const checked = st === 'on' ? 'true' : st === 'mixed' ? 'mixed' : 'false';
  return ` role="checkbox" aria-checked="${checked}" title="${esc(label)}" aria-label="${esc(label)}"${dis}`;
}

const camParentCls = (st) => (st === 'on' ? ' on' : st === 'mixed' ? ' part' : '');

// statewide parent. The subtitle states the count in words, so the three states never rest on the
// knob's colour alone; before the inventory lands there is no count to state.
function camAllRowHtml(dis) {
  const rows = camParentRows(null);
  if (!rows.length) return '';
  const on = camParentOn(rows);
  const st = camTriState(on, rows.length);
  const counted = !!state.camCounts;
  const tally = (m) => rows.reduce((a, r) => a + ((m && m[r[8].id]) || 0), 0);
  const sub = counted
    ? t('sheet.cams.all.sub').replace('{k}', fmtNum(on)).replace('{m}', fmtNum(rows.length))
      .replace('{n}', fmtNum(tally(state.camCounts))).replace('{l}', fmtNum(tally(state.camLive)))
    : t('sheet.cams.all.pre');
  return `<button class="ls-row ls-camall${camParentCls(st)}" data-camall="1"${camParentAttrs(st, t('sheet.cams.all.title'), dis)}>` +
    '<span class="ls-icon">\u{1F4F7}</span>' +
    `<span class="ls-txt"><span class="ls-name">${esc(t('sheet.cams.all'))}</span>` +
    `<span class="ls-sub">${esc(sub)}</span></span>` +
    '<span class="ls-knob" aria-hidden="true"></span></button>';
}

// region row subtitle: how many cameras and how many of them stream, a generic line before the
// inventory is in. The split is what decides whether the region is worth opening for a moving picture.
function camRegionSub(p) {
  const n = state.camCounts && state.camCounts[p.id];
  if (!Number.isFinite(n)) return t('sheet.s.cams.region');
  if (!n) return t('sheet.s.cams.none');
  const live = (state.camLive && state.camLive[p.id]) || 0;
  return t('sheet.s.cams.count').replace('{n}', fmtNum(n)).replace('{l}', fmtNum(live));
}

function layerSheetIsOpen() {
  const el = document.getElementById('layer-sheet');
  return !!el && !el.hidden;
}

// one toggle row; identical markup for flat groups and the indented camera children (child flag adds .ls-child)
function lsRowHtml(row, dis) {
  const [k, icon, nameKey, subKey, badge, , child, , region] = row;
  const on = layerRowOn(k); // understands the virtual merged 'wx' row; null = no such layer
  if (on === null) return '';
  const name = region ? regionLabel(region, getLang()) : t(nameKey);
  const sub = region ? camRegionSub(region) : t(subKey);
  return `<button class="ls-row${on ? ' on' : ''}${child ? ' ls-child' : ''}" data-layer="${k}" role="switch" aria-checked="${on}"${dis}>` +
    `<span class="ls-icon">${icon}</span>` +
    `<span class="ls-txt"><span class="ls-name">${esc(name)}${badge ? ' ' + srcBadge(badge, 'src-mini') : ''}</span>` +
    `<span class="ls-sub">${esc(sub)}</span></span>` +
    '<span class="ls-knob" aria-hidden="true"></span></button>';
}

/* cameras region: disclosure sub-headers per CAM_SUBGROUPS; a group renders open if opened OR any
   child is ON. Each header carries its own parent toggle beside the disclosure, as a sibling
   button rather than a nested one, so the two controls stay separately reachable. */
function camSubgroupsHtml(rows, dis) {
  let out = '';
  for (const [sub, nameKey] of CAM_SUBGROUPS) {
    const kids = rows.filter((r) => r[7] === sub && camRegionHasCams(r[8]));
    if (!kids.length) continue;
    const onCount = camParentOn(kids);
    const st = camTriState(onCount, kids.length);
    const open = state.lsCamOpen.has(sub) || onCount > 0;
    const name = t(nameKey);
    out += '<div class="ls-subrow">' +
      `<button class="ls-subhead" data-sub="${sub}" aria-expanded="${open}">` +
      '<span class="ls-sub-caret" aria-hidden="true">▸</span>' +
      `<span class="ls-sub-name">${esc(name)}</span>` +
      (onCount ? `<span class="ls-sub-count">${esc(t('sheet.cams.nofm').replace('{n}', onCount).replace('{m}', kids.length))}</span>` : '') +
      '</button>' +
      `<button class="ls-camband${camParentCls(st)}" data-camband="${sub}"` +
      camParentAttrs(st, t('sheet.cams.band.title').replace('{g}', name), dis) +
      '><span class="ls-knob" aria-hidden="true"></span></button>' +
      '</div>' +
      `<div class="ls-subrows" data-sub="${sub}"${open ? '' : ' hidden'}>` +
      kids.map((r) => lsRowHtml(r, dis)).join('') +
      '</div>';
  }
  return out;
}

function renderLayerSheet() {
  const el = document.getElementById('layer-sheet');
  if (!el) return;
  el.querySelector('.ls-head strong').textContent = t('sheet.title');
  el.querySelector('.ls-close').title = t('risk.close');
  const locked = pbBlocksLive(state); // playback swaps its own layers — sheet goes read-only
  const note = el.querySelector('.ls-note');
  note.hidden = !locked;
  if (locked) note.textContent = t('sheet.locked');
  const dis = locked ? ' disabled' : '';
  const seg = '<div class="ls-base" role="group">' + ['dark', 'light', 'streets'].map((b) =>
    `<button class="ls-base-btn${state.activeBase === b ? ' on' : ''}" data-base="${b}"${dis}>${esc(t(`sheet.base.${b}`))}</button>`).join('') + '</div>';
  let html = '';
  for (const [gKey, rows] of SHEET_GROUPS) {
    html += `<div class="ls-group">${esc(t(gKey))}</div>`;
    if (gKey === 'sheet.g.base') html += seg;
    if (gKey === 'sheet.g.cameras') { html += camAllRowHtml(dis) + camSubgroupsHtml(rows, dis); continue; }
    for (const row of rows) html += lsRowHtml(row, dis);
  }
  html += offlineSheetHtml() +
    `<button class="ls-reset"${dis} title="${esc(t('sheet.reset.title'))}">↺ ${esc(t('sheet.reset'))}</button>`;
  const body = el.querySelector('.ls-body');
  const keepScroll = body.scrollTop; // an innerHTML swap resets it, and the camera group sits far down
  body.innerHTML = html;
  body.scrollTop = keepScroll;
  refreshOfflineStatus(); // the tile count is async and the body was just rewritten
  refreshOfflineEstimate();
}

function layerSheetSync() { if (!state.lsBulk && layerSheetIsOpen()) renderLayerSheet(); }

function openLayerSheet() {
  const el = document.getElementById('layer-sheet');
  if (!el) return;
  if (typeof closeViewsSheet === 'function') closeViewsSheet(); // shared anchor: never stack the two map sheets
  renderLayerSheet();
  const panel = el.querySelector('.ls-panel');
  if (window.innerWidth > 768) {
    // desktop: compact panel anchored where the stock control sat (map top-right)
    const r = document.getElementById('map').getBoundingClientRect();
    panel.style.top = `${Math.max(10, r.top + 10)}px`;
    panel.style.right = `${Math.max(10, window.innerWidth - r.right + 10)}px`;
  } else { panel.style.top = ''; panel.style.right = ''; }
  el.hidden = false;
}

function closeLayerSheet() {
  const el = document.getElementById('layer-sheet');
  if (el) el.hidden = true;
}

function onLayerSheetClick(e) {
  if (pbBlocksLive(state)) return; // read-only while playback is engaged
  const baseBtn = e.target.closest('.ls-base-btn');
  if (baseBtn) {
    if (state.activeBase !== baseBtn.dataset.base) {
      Object.values(state.baseLayers).forEach((l) => state.map.removeLayer(l));
      state.baseLayers[baseBtn.dataset.base].addTo(state.map); // registered base — fires baselayerchange (theme/persist/sync)
    }
    return;
  }
  if (e.target.closest('.ls-reset')) { layerSheetReset(); return; }
  const offz = e.target.closest('[data-offz]');
  if (offz) { setOfflineDepth(parseInt(offz.dataset.offz, 10)); return; }
  if (e.target.closest('[data-act="off-save"]')) { saveViewportOffline(); return; }
  if (e.target.closest('[data-act="off-clear"]')) { clearOfflineCache(); return; }
  // parents first: the statewide row is also an .ls-row, and it carries no data-layer of its own
  if (e.target.closest('[data-camall]')) { camParentToggle(null); return; }
  const band = e.target.closest('[data-camband]');
  if (band) { camParentToggle(band.dataset.camband); return; }
  const sub = e.target.closest('.ls-subhead');
  if (sub) {
    const key = sub.dataset.sub;
    if (state.lsCamOpen.has(key)) state.lsCamOpen.delete(key);
    else state.lsCamOpen.add(key);
    renderLayerSheet();
    return;
  }
  const row = e.target.closest('.ls-row');
  if (!row) return;
  if (row.dataset.layer === 'wx') { wxToggle(); return; } // merged row toggles both underlying layers together
  const lyr = state.layers[row.dataset.layer];
  if (!lyr) return;
  if (state.map.hasLayer(lyr)) state.map.removeLayer(lyr);
  else lyr.addTo(state.map); // registered overlay — map fires overlayadd (lazy loads, legends, pills, sheet sync)
}

// default view: default overlays on, extras off, Streets base, Full AO framing (same bounds as the AO chip)
function layerSheetReset() {
  for (const [, rows] of SHEET_GROUPS) {
    for (const r of rows) {
      if (r[0] === 'wx') { if (!r[5] && layerRowOn('wx')) wxRemove(); continue; } // virtual merged row: off by default
      const lyr = state.layers[r[0]];
      if (!lyr) continue;
      const on = state.map.hasLayer(lyr);
      if (r[5] && !on) lyr.addTo(state.map);
      else if (!r[5] && on) state.map.removeLayer(lyr);
    }
  }
  if (state.activeBase !== 'streets') {
    Object.values(state.baseLayers).forEach((l) => state.map.removeLayer(l));
    state.baseLayers.streets.addTo(state.map);
  }
  state.lsCamOpen.clear(); // reset returns the camera sub-groups to all-collapsed
  aoSelectById(AO_FULL_ID, false); // framing is set below; the pill must not still name a sub-AO
  state.map.fitBounds(aoFullBounds());
  renderLayerSheet();
}

/* ---------- saved layer set: the overlays the user chose, carried across a refresh ---------- */

// every user-facing row key, in sheet order: the virtual merged 'wx' row and the camera regions included
function layerRowKeys() {
  const out = [];
  for (const [, rows] of SHEET_GROUPS) for (const r of rows) out.push(r[0]);
  return out;
}

/* What the user has on right now, plus the full set of keys this build offers. Storing the known
   set is what lets a later boot tell "the user turned this off" apart from "this layer did not
   exist yet", so a layer added in a release still ships on by default. Null while playback owns
   the layer set: its swap is the archive's picture, not the user's. */
function collectLayerState() {
  if (pbBlocksLive(state)) return null;
  const known = layerRowKeys();
  return { on: known.filter((k) => layerRowOn(k) === true), known };
}

function applyLayerState(on, known) {
  if (!Array.isArray(on) || pbBlocksLive(state)) return false;
  const wasKnown = new Set(Array.isArray(known) && known.length ? known : on);
  const want = new Set(on);
  state.lsBulk = true; // a whole layer set at once: the sheet and the pill row repaint after the loop
  try {
    for (const k of layerRowKeys()) {
      if (!wasKnown.has(k)) continue; // shipped after this view was saved — leave it at its default
      const cur = layerRowOn(k);
      if (cur === null || want.has(k) === cur) continue; // retired layer, or already where it belongs
      if (k === 'wx') { wxToggle(); continue; }
      if (want.has(k)) state.layers[k].addTo(state.map);
      else state.map.removeLayer(state.layers[k]);
    }
  } finally { state.lsBulk = false; }
  // a restored OFF is the user's decision, exactly as a manual toggle-off is; auto-enable must not undo it
  if (wasKnown.has('tropical') && !want.has('tropical')) state.tropicalAutoDone = true;
  if (wasKnown.has('crossStatus') && !want.has('crossStatus')) state.xstatusAutoDone = true;
  renderLayerPills();
  layerSheetSync();
  return true;
}

function initLayerSheet() {
  const el = document.createElement('div');
  el.id = 'layer-sheet';
  el.hidden = true;
  el.innerHTML = '<div class="ls-backdrop"></div>' +
    '<div class="ls-panel" role="dialog" aria-modal="true"><div class="ls-grab"></div>' +
    '<div class="ls-head"><strong></strong><button class="ls-close">✕</button></div>' +
    '<div class="ls-note" hidden></div><div class="ls-body"></div></div>';
  document.body.appendChild(el);
  el.querySelector('.ls-backdrop').addEventListener('click', closeLayerSheet);
  el.querySelector('.ls-close').addEventListener('click', closeLayerSheet);
  el.querySelector('.ls-body').addEventListener('click', onLayerSheetClick);
  // phone: a downward swipe from the grab bar / header dismisses the bottom sheet
  const panel = el.querySelector('.ls-panel');
  let y0 = null;
  panel.addEventListener('touchstart', (e) => {
    y0 = e.target.closest('.ls-grab, .ls-head') ? e.touches[0].clientY : null;
  }, { passive: true });
  panel.addEventListener('touchend', (e) => {
    if (y0 !== null && e.changedTouches[0].clientY - y0 > 55) closeLayerSheet();
    y0 = null;
  }, { passive: true });
  state.map.on('overlayadd overlayremove baselayerchange', layerSheetSync);
  // the layer set and the framing are part of the view the board restores on the next load
  state.map.on('overlayadd overlayremove moveend', () => {
    if (typeof scheduleViewSave === 'function') scheduleViewSave();
  });
  registerModal(el, { focusEl: '.ls-panel' }); // trap within the panel; #layer-sheet toggles hidden
}

/* ---------- views sheet (v0.97.90) — the lens picker, on the map where the lenses act ----------
   Same .ls-* markup and CSS as the layer sheet, so the 48px rows and the ≤768px bottom sheet
   come for free. Radio semantics: exactly one lens at a time, and every row routes through
   openView() rather than clicking a button id. */

// [viewName, iconHtml, labelKey, subKey] — labels reuse the shipped menu keys, no key churn
const VIEW_ROWS = [
  ['live', '🗺', 'views.live', 'views.live.sub'],
  ['drive', '🚗', 'ctl.drive', 'views.drive.sub'],
  ['basin', '🏞', 'basin.menu', 'views.basin.sub'],
  ['playback', '⏮', 'playback.menu', 'views.playback.sub'],
  ['recovery', '📉', 'recovery.menu', 'views.recovery.sub'],
  ['summary', '📊', 'summary.menu', 'views.summary.sub'],
];

// the reused menu keys carry their own leading glyph in both languages; .ls-icon renders it instead
const viewRowLabel = (key) => t(key).replace(/^[^\p{L}\p{N}]+\s*/u, '');

// which lens owns the board right now; read from the panes themselves so no separate state can drift
function activeViewName() {
  const shown = (id) => { const el = document.getElementById(id); return !!el && !el.hidden; };
  if (shown('drive-mode')) return 'drive';
  if (shown('basin-view')) return 'basin';
  if (shown('recovery-view')) return 'recovery';
  if (shown('summary-view')) return 'summary';
  if (state.pb && shown('playback-bar')) return 'playback';
  return 'live';
}

function viewsSheetIsOpen() {
  const el = document.getElementById('views-sheet');
  return !!el && !el.hidden;
}

/* The trigger names the lens that owns the board rather than hiding behind an unlabelled glyph:
   ATAK draws state onto the control, CalTopo swaps the 3D button for a 2D one so the exit is the
   entry. Live is the resting state; any other lens tints the control and reveals the ✕ back to Live. */
function syncViewsTrigger() {
  const div = state.viewsEl;
  if (!div) return;
  const name = activeViewName();
  const live = name === 'live';
  const tag = div.querySelector('.views-tag');
  const open = div.querySelector('.views-open');
  const back = div.querySelector('.views-back');
  const label = t(`views.tag.${name}`);
  if (tag) tag.textContent = label;
  if (open) {
    open.title = live ? t('views.open') : t('views.open.on').replace('{v}', label);
    open.setAttribute('aria-label', open.title);
  }
  if (back) {
    back.hidden = live;
    back.title = t('views.exit');
    back.setAttribute('aria-label', t('views.exit'));
  }
  L.DomUtil[live ? 'removeClass' : 'addClass'](div, 'on');
}

function renderViewsSheet() {
  const el = document.getElementById('views-sheet');
  if (!el) return;
  el.querySelector('.ls-head strong').textContent = t('views.title');
  el.querySelector('.ls-close').title = t('risk.close');
  const active = activeViewName();
  el.querySelector('.ls-body').innerHTML = VIEW_ROWS.map(([name, icon, labelKey, subKey]) => {
    const on = name === active;
    return `<button class="ls-row${on ? ' on' : ''}" data-view="${name}" role="radio" aria-checked="${on}">` +
      `<span class="ls-icon">${icon}</span>` +
      `<span class="ls-txt"><span class="ls-name">${esc(viewRowLabel(labelKey))}</span>` +
      `<span class="ls-sub">${esc(t(subKey))}</span></span>` +
      `<span class="ls-knob ls-go" aria-hidden="true">${on ? '✓' : '›'}</span></button>`;
  }).join('');
}

function openViewsSheet() {
  const el = document.getElementById('views-sheet');
  if (!el) return;
  closeLayerSheet(); // the two map sheets share the same anchor; never stack them
  renderViewsSheet();
  const panel = el.querySelector('.ls-panel');
  if (window.innerWidth > 768) {
    const r = document.getElementById('map').getBoundingClientRect();
    panel.style.top = `${Math.max(10, r.top + 10)}px`;
    panel.style.right = `${Math.max(10, window.innerWidth - r.right + 10)}px`;
  } else { panel.style.top = ''; panel.style.right = ''; }
  el.hidden = false;
}

function closeViewsSheet() {
  const el = document.getElementById('views-sheet');
  if (el) el.hidden = true;
}

function onViewsSheetClick(e) {
  const row = e.target.closest('.ls-row');
  if (!row) return;
  closeViewsSheet(); // the lens needs the map and the sidebar, not a panel over them
  openView(row.dataset.view);
}

function initViewsSheet() {
  const el = document.createElement('div');
  el.id = 'views-sheet';
  el.hidden = true;
  el.innerHTML = '<div class="ls-backdrop"></div>' +
    '<div class="ls-panel" role="dialog" aria-modal="true"><div class="ls-grab"></div>' +
    '<div class="ls-head"><strong></strong><button class="ls-close">✕</button></div>' +
    '<div class="ls-body" role="radiogroup"></div></div>';
  document.body.appendChild(el);
  el.querySelector('.ls-backdrop').addEventListener('click', closeViewsSheet);
  el.querySelector('.ls-close').addEventListener('click', closeViewsSheet);
  el.querySelector('.ls-body').addEventListener('click', onViewsSheetClick);
  const panel = el.querySelector('.ls-panel');
  let y0 = null;
  panel.addEventListener('touchstart', (e) => {
    y0 = e.target.closest('.ls-grab, .ls-head') ? e.touches[0].clientY : null;
  }, { passive: true });
  panel.addEventListener('touchend', (e) => {
    if (y0 !== null && e.changedTouches[0].clientY - y0 > 55) closeViewsSheet();
    y0 = null;
  }, { passive: true });
  registerModal(el, { focusEl: '.ls-panel' });
}

/* ---------- unified radar timeline (v0.96) — observed RainViewer past | NOW | HRRR model future ----------
   One bar owns radar time: the past segment replays preloaded observed frames (opacity crossfade),
   the future segment steps preloaded per-hour HRRR layers by opacity (no per-step tile reload).
   Honesty contract: the future zone flips the bar to amber dashed + FORECAST MODEL badge; the +12h
   run-mixing cap stays; the whole bar hides during playback (the playback bar owns time there). */

const RTL_PAST_STEP_MS = 700;
const RTL_FCST_STEP_MS = 900; // model hours get a beat longer — an hour of weather per step
const RTL_RADAR_OPACITY = 0.75; // 0.6 washed out over the bright Streets base
const FCST_OPACITY = 0.7;
const FCST_WMS_PX = 256; // native 256px render; the .fcst-tiles blur already softens HRRR's ~3km cell edges

const fcstLayerName = (h) => `refd_${String(h * 60).padStart(4, '0')}`;

// past segment on = radar group with fetched frames; future segment on = HRRR layer enabled
function rtlDomain() {
  const pastN = state.map.hasLayer(state.layers.radar) && state.radar ? state.radar.frames.length : 0;
  const fN = state.map.hasLayer(state.layers.fcstRadar) ? CONFIG.hrrrMaxHours : 0;
  return { pastN, fN, nowIdx: pastN - 1, total: pastN + fN };
}

// re-derive the bar from layer state: visibility, slider domain, NOW divider + future-segment geometry
function rtlSync() {
  const bar = $('#radar-scrub'), rtl = state.rtl;
  const R = rtlDomain();
  const on = state.map.hasLayer(state.layers.radar) || state.map.hasLayer(state.layers.fcstRadar);
  bar.hidden = !on || pbBlocksLive(state);
  $('#wx-legend').hidden = bar.hidden; // combined legend rides with the scrubber
  if (bar.hidden) { rtlStopPlay(); return; }
  $('#rs-slider').max = Math.max(R.total - 1, 0);
  if (!R.pastN && R.fN) { rtl.fut = true; rtl.hour = Math.min(rtl.hour || 1, R.fN); rtl.idx = R.nowIdx + rtl.hour; }
  else if (rtl.fut && R.fN) { rtl.hour = Math.min(rtl.hour || 1, R.fN); rtl.idx = R.nowIdx + rtl.hour; }
  else if (rtl.fut) { rtl.fut = false; rtl.idx = Math.max(R.nowIdx, 0); }
  else rtl.idx = Math.max(0, Math.min(rtl.idx, Math.max(R.total - 1, 0)));
  const divider = $('#rs-now'), futSeg = $('#rs-future');
  const frac = R.total > 1 ? (Math.max(R.nowIdx, 0) / (R.total - 1)) * 100 : 0;
  divider.hidden = !(R.pastN > 0 && R.fN > 0);
  if (!divider.hidden) divider.style.left = `${frac}%`;
  futSeg.hidden = !R.fN;
  if (R.fN) futSeg.style.left = R.pastN ? `${frac}%` : '0';
}

function rtlSet(i) {
  if (pbBlocksLive(state)) return; // playback replays IEM archive radar — live frames must stay dark
  const R = rtlDomain();
  if (!R.total) return;
  const rtl = state.rtl, r = state.radar;
  rtl.idx = Math.max(0, Math.min(i, R.total - 1));
  rtl.fut = rtl.idx > R.nowIdx;
  if (rtl.fut) rtl.hour = rtl.idx - R.nowIdx;
  $('#rs-slider').value = rtl.idx;
  if (rtl.fut) {
    if (r) { r.idx = R.nowIdx; r.frameLayers.forEach((l) => l.setOpacity(0)); }
    fcstShow(rtl.hour);
  } else {
    fcstHide();
    if (r) {
      r.idx = rtl.idx;
      r.frameLayers.forEach((l, j) => l.setOpacity(j === rtl.idx ? RTL_RADAR_OPACITY : 0));
    }
  }
  rtlUpdateLabel(R);
}

function rtlUpdateLabel(R) {
  const rtl = state.rtl, label = $('#rs-label');
  // combined-legend source: observed until the RainViewer nowcast seam, forecast beyond (nowcast + HRRR)
  const wxFcst = !R.pastN || (state.radar && rtl.idx >= state.radar.castStart);
  const obsKey = state.radar && state.radar.src === 'iem'
    ? (wxObsUnverified(state.radar) ? 'leg.wx.obs.iem.blank' : 'leg.wx.obs.iem')
    : 'leg.wx.obs';
  $('#wx-legend-src').textContent = t(wxFcst ? (wxFcstDegraded(state.fcst) ? 'leg.wx.fcst.down' : 'leg.wx.fcst') : obsKey);
  $('#radar-scrub').classList.toggle('rs-future', rtl.fut);
  $('#rs-badge').hidden = !rtl.fut;
  if (rtl.fut) {
    const f = state.fcst;
    let txt = `+${rtl.hour}h`;
    if (f.runIso) {
      const valid = new Date(new Date(f.runIso).getTime() + rtl.hour * 3600000).toISOString();
      txt += ` · ${fmtCT(valid)}`;
      label.title = t('fcst.run').replace('{t}', fmtCT(f.runIso));
    } else label.title = '';
    label.textContent = txt;
    label.classList.add('projected');
    return;
  }
  const r = state.radar;
  // a frame time we computed and cannot back with a tile carries the reason on the stamp itself
  label.title = wxObsUnverified(r) ? t('leg.wx.obs.iem.blank') : '';
  if (!R.pastN || !r) { label.textContent = '…'; label.classList.remove('projected'); return; }
  const dMin = Math.round((r.frames[rtl.idx].time - r.frames[r.nowIdx].time) / 60);
  label.textContent = dMin === 0 ? 'now' : dMin < 0 ? `${dMin >= -110 ? dMin + 'm' : Math.round(dMin / 6) / 10 + 'h'}` : `+${dMin}m PROJECTED`;
  label.classList.toggle('projected', rtl.idx >= r.castStart);
}

function rtlStopPlay() {
  const rtl = state.rtl;
  if (rtl.timer) { clearTimeout(rtl.timer); rtl.timer = null; }
  rtl.playing = false;
  $('#rs-play').textContent = '▶';
}

// loops observed → NOW → forecast, then restarts; observed-only (or forecast-only) when one segment is off
function rtlTogglePlay() {
  const rtl = state.rtl;
  if (rtl.playing) { rtlStopPlay(); return; }
  if (!rtlDomain().total) return;
  rtl.playing = true;
  $('#rs-play').textContent = '⏸';
  const step = () => {
    const R = rtlDomain();
    if (!R.total) { rtlStopPlay(); return; }
    rtlSet((rtl.idx + 1) % R.total);
    rtl.timer = setTimeout(step, rtl.fut ? RTL_FCST_STEP_MS : RTL_PAST_STEP_MS);
  };
  rtl.timer = setTimeout(step, rtl.fut ? RTL_FCST_STEP_MS : RTL_PAST_STEP_MS);
}

// bounded per-tile reload so a tile dropped under the enable-time burst recovers instead of staying
// permanently blank; capped so genuinely-missing tiles never loop (RainViewer 200s no-data, 404s rare)
const TILE_RETRY_MAX = 3;
const tileRetries = new WeakMap();
function attachTileRetry(layer) {
  layer.on('tileerror', (e) => {
    const img = e.tile;
    if (!img || !img.src) return;
    const n = tileRetries.get(img) || 0;
    if (n >= TILE_RETRY_MAX) return;
    tileRetries.set(img, n + 1);
    const base = img.src.replace(/[?&]_rtry=\d+/, '').replace(/[?&]$/, '');
    const sep = base.includes('?') ? '&' : '?';
    setTimeout(() => { if (!img.isConnected) return; img.src = `${base}${sep}_rtry=${n + 1}`; }, 400 + n * 300);
  });
}

// mount the visible frame first (loads with uncontended bandwidth), then add the rest deferred once
// it paints (or a short fallback); end state is all-frames-mounted so stepping stays opacity-only
function radarMountFramesDeferred(r, primaryIdx) {
  const group = state.layers.radar, layers = r.frameLayers;
  const primary = layers[primaryIdx];
  if (primary) group.addLayer(primary);
  let mounted = false;
  const mountRest = () => {
    if (mounted) return;
    mounted = true;
    if (state.radar !== r) return; // a newer refresh superseded this frame set
    layers.forEach((l, j) => { if (j !== primaryIdx && !group.hasLayer(l)) group.addLayer(l); });
  };
  if (!primary) { mountRest(); return; }
  primary.once('load', mountRest);
  setTimeout(mountRest, 1200); // fallback when the visible frame paints no tiles (offscreen)
}

// RainViewer-down fallback: synthesize a past-only frame set from the IEM NEXRAD composite archive
// (the same tiles playback replays). 10-min steps over ~2h, floored to 5-min buckets with a 10-min
// ingest lag so the newest stamp already serves tiles. No nowcast segment — honesty over projection.
const IEM_RADAR_STEP_MS = 600000;
const IEM_RADAR_FRAMES = 13;
function iemRadarFrames(nowMs) {
  const newest = Math.floor((nowMs - 600000) / 300000) * 300000;
  const frames = [];
  for (let i = IEM_RADAR_FRAMES - 1; i >= 0; i--) frames.push({ time: (newest - i * IEM_RADAR_STEP_MS) / 1000 });
  return frames;
}

/* Those stamps come from our clock, not from an upstream index, so a time IEM has not ingested
   paints nothing at all. Until one fallback tile loads, an empty map under that timeline is an
   unanswered request and not an observation of clear sky, and the legend has to say which.
   Same shape as wxFcstDegraded: a failure signal AND nothing painted, so the load itself is quiet. */
const wxObsUnverified = (r) => !!(r && r.src === 'iem' && r.tileFail && !r.tileOk);

function watchRadarTiles(r, layer) {
  const mark = (key) => () => {
    if (r[key] || state.radar !== r) return;
    r[key] = true;
    rtlUpdateLabel(rtlDomain()); // the verdict flips asynchronously; the legend must follow it
  };
  layer.on('tileload', mark('tileOk'));
  layer.on('tileerror', mark('tileFail'));
}

async function fetchRadarFrames() {
  let d = null;
  try {
    const res = await fetch(CONFIG.rainviewerApi);
    if (!res.ok) throw new Error(`RainViewer HTTP ${res.status}`);
    d = await res.json();
    if (!((d.radar && d.radar.past) || []).length) throw new Error('no radar frames');
  } catch { d = null; } // primary down — fall back to the IEM archive frame set below
  const past = d ? d.radar.past : iemRadarFrames(Date.now());
  const cast = d ? (d.radar.nowcast || []) : [];
  const keepIdx = state.radar ? state.radar.idx : -1;
  const wasPlaying = state.rtl.playing;
  rtlStopPlay();
  state.radar = { src: d ? 'rainviewer' : 'iem', host: d ? d.host : '', frames: past.concat(cast), castStart: past.length, nowIdx: past.length - 1, idx: past.length - 1, frameLayers: [], tileOk: false, tileFail: false };
  const r = state.radar;
  state.layers.radar.clearLayers();
  r.frameLayers = r.frames.map((f) => L.tileLayer(
    d ? `${r.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png` : PB_RADAR_URL(pbRadarStampAt(f.time * 1000)), {
      pane: 'radar', opacity: 0, maxNativeZoom: 7, maxZoom: 19, updateWhenIdle: false, className: 'rtl-xfade',
      attribution: d ? 'Radar: RainViewer' : 'Radar: NEXRAD via IEM',
    }));
  r.frameLayers.forEach(attachTileRetry);
  if (!d) r.frameLayers.forEach((l) => watchRadarTiles(r, l)); // fallback frames only: RainViewer indexes its own
  const rf = parseInt(new URLSearchParams(location.search).get('rf'), 10); // debug/deep-link: initial frame index
  const primaryIdx = (state.rtl.wantNow || state.rtl.fut) ? r.nowIdx
    : keepIdx >= 0 && keepIdx < r.frames.length ? keepIdx
      : rf >= 0 && rf < r.frames.length ? rf : r.nowIdx;
  radarMountFramesDeferred(r, primaryIdx); // visible frame loads first; rest mount deferred (opacity-only after)
  rtlSync();
  if (state.rtl.wantNow) { state.rtl.wantNow = false; rtlSet(r.nowIdx); } // merged enable: land on NOW once observed frames arrive
  else if (state.rtl.fut) rtlSet(state.rtl.idx); // playhead in the model future; new frames only reshape the past segment
  else rtlSet(primaryIdx);
  if (wasPlaying) rtlTogglePlay();
}

/* per-hour HRRR layers — one WMS layer per forecast hour, mounted at opacity 0 like a radar frame;
   stepping is a pure opacity swap (never a per-step fetch-gated fade), so play never stalls */

const FCST_WIN_BEHIND = 1; // sliding preload window around the playhead; bounds the concurrent WMS load on mobile
const FCST_WIN_AHEAD = 3;  // lead enough at the play cadence that an hour paints before it is shown

/* HRRR has no secondary source, so degraded is the only honest answer when it fails. The run stamp is a
   static file and the tiles come from a CGI, so IEM can serve a healthy run while the WMS answers nothing;
   either signal counts. Same shape as wxObsUnverified: a failure AND nothing painted, so a stray
   out-of-bounds tile error never flips a working forecast. */
const wxFcstDegraded = (f) => !!(f && (f.metaFail || f.tileFail) && !f.tileOk);

// the verdict flips asynchronously once tiles answer; the legend has to follow it
function watchFcstTiles(layer) {
  const mark = (key) => () => {
    const f = state.fcst;
    if (!f || f[key]) return;
    f[key] = true;
    rtlUpdateLabel(rtlDomain());
  };
  layer.on('tileload', mark('tileOk'));
  layer.on('tileerror', mark('tileFail'));
}

// one supersampled, mobile-tuned HRRR hour layer (mirrors the observed-radar frame tuning), mounted at opacity 0
function fcstMakeHourLayer(h) {
  const l = L.tileLayer.wms(CONFIG.hrrrWmsUrl, {
    layers: fcstLayerName(h), format: 'image/png', transparent: true, version: '1.1.1',
    opacity: 0, pane: 'radar', maxNativeZoom: 7, maxZoom: 19, updateWhenIdle: false,
    className: 'fcst-tiles rtl-xfade',
    attribution: 'Forecast radar: NOAA HRRR model via <a href="https://mesonet.agron.iastate.edu/">IEM</a>',
  });
  l.wmsParams.width = l.wmsParams.height = FCST_WMS_PX; // render size (initialize() pins these to tileSize)
  if (state.fcst.runIso) l.wmsParams._run = state.fcst.runIso; // stay on the same run as its already-mounted siblings
  watchFcstTiles(l);
  attachTileRetry(l);
  return l;
}

// mount the hours around the playhead (created once, then persist like radar frames); bounds the enable burst
function fcstEnsureWindow(h) {
  const lo = Math.max(1, h - FCST_WIN_BEHIND), hi = Math.min(CONFIG.hrrrMaxHours, h + FCST_WIN_AHEAD);
  for (let hr = lo; hr <= hi; hr++) {
    if (state.fcst.hourLayers[hr - 1]) continue;
    const l = fcstMakeHourLayer(hr);
    state.fcst.hourLayers[hr - 1] = l;
    state.layers.fcstRadar.addLayer(l);
  }
}

// show forecast hour h by opacity only (window-mounts nearby hours); never reloads the visible frame
function fcstShow(h) {
  h = Math.max(1, Math.min(h, CONFIG.hrrrMaxHours));
  fcstEnsureWindow(h);
  state.fcst.hourLayers.forEach((l, j) => { if (l) l.setOpacity(j === h - 1 ? FCST_OPACITY : 0); });
}

function fcstHide() {
  state.fcst.hourLayers.forEach((l) => { if (l) l.setOpacity(0); });
}

// merged enable: with observed radar present hold the playhead at NOW; forecast-only lands on +1h so the model shows at once
function fcstEnable() {
  fcstFetchRun();
  rtlSync();
  const R = rtlDomain();
  if (R.pastN) { state.rtl.fut = false; state.rtl.hour = 1; rtlSet(R.nowIdx); }
  else { state.rtl.wantNow = state.map.hasLayer(state.layers.radar); rtlSet(R.nowIdx + 1); }
}

function fcstDisable() {
  fcstHide();
  const wasFut = state.rtl.fut;
  state.rtl.fut = false;
  state.rtl.hour = 1; // contract: every re-enable starts at +1h (or NOW when radar is present)
  state.rtl.wantNow = false;
  rtlSync();
  const R = rtlDomain();
  if (!R.total) { rtlStopPlay(); return; }
  if (wasFut) rtlSet(R.nowIdx); // playhead falls back to NOW
}

// run stamp from IEM's per-layer metadata JSON; a new model run cache-busts every mounted hour's WMS tiles
function fcstFetchRun() {
  fetch(CONFIG.hrrrMetaUrl(60)).then((r) => (r.ok ? r.json() : null)).then((d) => {
    const f = state.fcst;
    if (f) f.metaFail = !d || !d.model_init_utc;
    if (!f || !d || !d.model_init_utc || f.runIso === d.model_init_utc) return;
    const stale = f.runIso !== null;
    f.runIso = d.model_init_utc;
    if (stale) {
      f.hourLayers.forEach((l) => { if (l) l.setParams({ _run: f.runIso }); }); // vendor param busts each mounted hour's cache
      if (state.rtl.fut) fcstShow(state.rtl.hour); // repaint the visible hour onto the new run
    }
    if (state.rtl.fut) rtlUpdateLabel(rtlDomain());
  }).catch(() => {
    if (state.fcst) state.fcst.metaFail = true; // with no tile ever painted this flips the legend to "unavailable"
    if (state.rtl.fut) rtlUpdateLabel(rtlDomain());
  });
}
