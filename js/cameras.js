'use strict';

// Camera layer (split from js/sources.js); loads after sources.js: shared helpers (prettyRoute) resolve at runtime only.

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
  if (c.src === 'its') return c.name || prettyRoute(c.route) || t('cam.generic'); // ITS names carry the cross-street
  return c.description || prettyRoute(c.route) || c.name || t('cam.generic');
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
