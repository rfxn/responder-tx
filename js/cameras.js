'use strict';

// Camera layer (split from js/sources.js); loads after sources.js: shared helpers (prettyRoute) resolve at runtime only.

/* ---------- road & river cameras (TxDOT HLS live + USGS HIVIS stills) ---------- */

const CAM_ATTRIB_TXDOT = 'Traffic cameras: TxDOT (Lonestar/DriveTexas)';
const CAM_ATTRIB_USGS = 'River cameras: USGS HIVIS (public domain, provisional)';
const CAM_ATTRIB_AUSTIN = 'Traffic cameras: City of Austin, Texas (public domain)';
const CAM_ATTRIB_ATX = 'Flood cameras: ATX Floods, a service of Beholder Technology, LLC · City of Austin low-water crossings';
const CAM_ATTRIB_PORTHOU = 'Ship Channel cameras: Port Houston';
const CAM_ATTRIB_HOUSTON = 'Traffic cameras: Houston TranStar (Houston region)';
const CAM_ATTRIB_ARLINGTON = 'Traffic cameras: City of Arlington, Texas';
const CAM_ATTRIB_ELP = 'Live cameras: City of El Paso (international bridges)';
const CAM_ATTRIB_HAYS = 'Flood cameras: Hays County Office of Emergency Services';
const CAM_ATTRIB_LUBBOCK = 'Traffic cameras: City of Lubbock, Texas';
const CAM_ATTRIB_WBUG = 'Weather cameras: WeatherBug (Earth Networks) and the hosting sites';
const CAM_ATTRIB_SWRECON = 'Coastal cameras: Saltwater Recon (Gulf Coast webcam network)';
const CAM_ATTRIB_CORPUS = 'City cameras: City of Corpus Christi';
const CAM_ATTRIB_NMDOT = 'Traffic cameras: New Mexico DOT (NM Roads)';
const CAM_ATTRIB_NPS = 'Park cameras: National Park Service (public domain)';
const CAM_ATTRIB = { txdot: CAM_ATTRIB_TXDOT, river: CAM_ATTRIB_USGS, austin: CAM_ATTRIB_AUSTIN, atxfloods: CAM_ATTRIB_ATX, houston: CAM_ATTRIB_HOUSTON, arlington: CAM_ATTRIB_ARLINGTON, elpbridge: CAM_ATTRIB_ELP, hays: CAM_ATTRIB_HAYS, porthou: CAM_ATTRIB_PORTHOU, swrecon: CAM_ATTRIB_SWRECON, corpus: CAM_ATTRIB_CORPUS, lubbock: CAM_ATTRIB_LUBBOCK, weatherbug: CAM_ATTRIB_WBUG, nmdot: CAM_ATTRIB_NMDOT, nps: CAM_ATTRIB_NPS };
const CAM_STALE_MINS = 45; // aging invariant: a still older than this must never look live
const HIVIS_S3 = 'https://usgs-nims-images.s3.amazonaws.com';
const CAM_KEY_RE = /___\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.jpg$/;

// lazy: inventory is a committed snapshot, fetched once on first layer enable / Drive Mode / gauge popup
function loadCameras() {
  if (state.camerasP) return state.camerasP;
  state.camerasP = fetch(`data/cameras.json?_=${Math.floor(Date.now() / 3600000)}`)
    .then((r) => { if (!r.ok) throw new Error(`cameras HTTP ${r.status}`); return r.json(); })
    .then((d) => {
      state.cameras = { txdot: d.txdot || [], river: d.river || [], austin: d.austin || [], atxfloods: d.atxfloods || [], houston: d.houston || [], arlington: d.arlington || [], elpbridge: d.elpbridge || [], hays: d.hays || [], porthou: d.porthou || [], swrecon: d.swrecon || [], corpus: d.corpus || [], lubbock: d.lubbock || [], weatherbug: d.weatherbug || [], nmdot: d.nmdot || [], nps: d.nps || [] };
      renderCameras();
      return state.cameras;
    });
  state.camerasP.catch(() => { state.camerasP = null; }); // failed fetch — allow retry on next trigger
  return state.camerasP;
}

function camTitle(c, kind) {
  if (kind !== 'txdot') return c.name; // every non-TxDOT network publishes a usable name of its own
  if (c.src === 'its') return c.name || prettyRoute(c.route) || t('cam.generic'); // ITS names carry the cross-street
  return c.description || prettyRoute(c.route) || c.name || t('cam.generic');
}

/* A camera is live iff it carries a stream URL the player can load; every other camera is a
   still. Read off the camera's own row rather than a list of source names, so a network added
   to CAM_NETS inherits its marker, its label and its player from the data it publishes. The
   predicate is safeUrl, so the marker can only claim live where the viewer gets a real URL. */
const camIsLive = (c) => !!c && safeUrl(c.httpsurl) !== '#';
const camKindLabel = (c) => t(camIsLive(c) ? 'cam.kind.live' : 'cam.kind.still');
const camKindLong = (c) => t(camIsLive(c) ? 'cam.kind.live.long' : 'cam.kind.still.long');

// [cameras array key, net]; the net names the operator, the row's own data names the kind
const CAM_NETS = [
  ['txdot', 'txdot'],
  ['river', 'river'],
  ['austin', 'austin'],
  ['atxfloods', 'atxfloods'],
  ['houston', 'houston'],
  ['arlington', 'arlington'],
  ['elpbridge', 'elpbridge'],
  ['hays', 'hays'],
  ['porthou', 'porthou'],
  ['swrecon', 'swrecon'],
  ['corpus', 'corpus'],
  ['lubbock', 'lubbock'],
  ['weatherbug', 'weatherbug'],
  ['nmdot', 'nmdot'],
  ['nps', 'nps'],
];

// every source is pooled into the AO region it sits in, so one toggle covers an area rather than an operator
function renderCameras() {
  if (!state.cameras || !state.camLayerList || !state.camLayerList.length) return;
  const put = (layer, marks) => {
    if (!layer) return;
    layer.clearLayers();
    if (layer.addLayers) layer.addLayers(marks); // markercluster bulk add
    else marks.forEach((m) => layer.addLayer(m));
  };
  // filled disc + ▶ for a stream, dashed outline + 📷 for a snapshot: the pair reads apart in
  // greyscale and in glare, and leaves colour on this map meaning severity and nothing else
  const mark = (c, kind) => {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) return null;
    const live = camIsLive(c);
    const lbl = esc(camKindLong(c));
    const icon = L.divIcon({
      className: '',
      html: `<div class="cam-icon ${live ? 'cam-live' : 'cam-still'}" role="img" aria-label="${lbl}" title="${lbl}">${live ? '▶' : '📷'}</div>`,
      iconSize: [22, 22], iconAnchor: [11, 11],
    });
    const m = L.marker([c.lat, c.lon], { icon, attribution: CAM_ATTRIB[kind] });
    m.bindPopup(() => camPopup(c, kind), { minWidth: 230 });
    return m;
  };
  const regions = camRegions();
  const buckets = {}, liveN = {};
  for (const p of camRegionsAll()) { buckets[p.id] = []; liveN[p.id] = 0; }
  let unplaceable = 0;
  for (const [arr, net] of CAM_NETS) {
    for (const c of state.cameras[arr] || []) {
      const m = mark(c, net);
      if (!m) { unplaceable++; continue; } // no usable coordinates: counted, not quietly skipped
      const rid = camRegionId(c.lat, c.lon, regions);
      buckets[rid].push(m);
      if (camIsLive(c)) liveN[rid]++;
    }
  }
  state.camCounts = {};
  state.camLive = {};
  state.camNoCoords = unplaceable;
  for (const p of camRegionsAll()) {
    state.camCounts[p.id] = buckets[p.id].length;
    state.camLive[p.id] = liveN[p.id];
    put(state.layers[camRegionKey(p.id)], buckets[p.id]);
  }
  layerSheetSync(); // the sheet shows per-region counts, so repaint if it is open when the inventory lands
  // ?cam=<name|camId|id> deep link — open the viewer once the inventory is in (once)
  if (state.pendingCam) {
    const want = state.pendingCam;
    state.pendingCam = null;
    const hit = findCamByKey(want);
    if (hit) openCamViewer(hit.c, hit.kind);
  }
}

/* Deep-link precedence is frozen: river ids resolve before TxDOT names, then every other network
   in CAM_NETS order, so a ?cam= link shared before a network existed still opens the same camera. */
const CAM_FIND_ORDER = ['river'].concat(CAM_NETS.map(([arr]) => arr).filter((a) => a !== 'river'));

// resolve a deep-link token across every network (camId / name / id)
function findCamByKey(want) {
  for (const arr of CAM_FIND_ORDER) {
    const hit = (state.cameras[arr] || []).find((c) => c.name === want ||
      (c.camId !== undefined && c.camId === want) ||
      (c.id !== undefined && String(c.id) === want));
    if (hit) return { c: hit, kind: arr };
  }
  return null;
}

function camPopup(c, kind) {
  const el = document.createElement('div');
  let sub;
  if (kind === 'river') sub = `${esc(t('cam.river'))}${c.nwisId ? ` · USGS ${esc(c.nwisId)}` : ''}`;
  else if (kind === 'atxfloods' || kind === 'hays') sub = esc(t('cam.floodcam'));
  else if (kind === 'porthou') sub = esc(t('cam.channel'));
  else if (kind === 'swrecon' || kind === 'corpus') sub = esc(t('cam.coastal'));
  else if (kind === 'weatherbug') sub = esc(t('cam.weather'));
  else if (kind === 'nps') sub = esc(t('cam.park'));
  else if (kind === 'elpbridge') sub = esc(t('cam.bridge'));
  else if (kind === 'austin' || kind === 'houston' || kind === 'arlington' || kind === 'lubbock' || kind === 'nmdot') sub = esc(t('cam.traffic'));
  else sub = `${esc(prettyRoute(c.route) || '')}${c.route ? ' · ' : ''}${esc(t(c.src === 'its' ? 'cam.snapcam' : 'cam.traffic'))}`;
  const live = camIsLive(c);
  // same chip vocabulary the viewer uses, so the popup's claim and the player's badge match
  const chip = `<span class="cam-badge ${live ? 'live' : 'still'}">${live ? '▶' : '📷'} ${esc(camKindLabel(c))}</span>`;
  el.innerHTML = `<div class="popup-title">📷 ${esc(camTitle(c, kind))}</div>` +
    `<div class="popup-meta">${chip}${sub}</div>` +
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
  if (kind === 'porthou') return `Port Houston · ${t('cam.channel')}`;
  if (kind === 'swrecon') return `Saltwater Recon · ${t('cam.coastal')}`;
  if (kind === 'corpus') return `Corpus Christi · ${t('cam.coastal')}`;
  if (kind === 'lubbock') return `Lubbock · ${t('cam.traffic')}`;
  if (kind === 'weatherbug') return `WeatherBug · ${t('cam.weather')}`;
  if (kind === 'nmdot') return `NMDOT · ${t('cam.traffic')}`;
  if (kind === 'nps') return `National Park Service · ${t('cam.park')}`;
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

/* Networks whose viewer is the shared proxied-still player; the value is the note that names the
   operator's own cadence. A new still network is a row here, never another branch in the viewer. */
const CAM_STILL_NOTES = {
  austin: 'cam.austin.note',
  houston: 'cam.houston.note',
  arlington: 'cam.arlington.note',
  hays: 'cam.hays.note',
  atxfloods: 'cam.atx.note',
  porthou: 'cam.porthou.note',
  swrecon: 'cam.swrecon.note',
  corpus: 'cam.corpus.note',
  lubbock: 'cam.lubbock.note',
  weatherbug: 'cam.wbug.note',
  nmdot: 'cam.nmdot.note',
  nps: 'cam.nps.note',
};
const camStillNote = (kind) => (Object.prototype.hasOwnProperty.call(CAM_STILL_NOTES, kind) ? CAM_STILL_NOTES[kind] : null);

function openCamViewer(c, kind) {
  camViewerTeardown();
  state.camGen = (state.camGen || 0) + 1; // invalidates every in-flight load from the previous camera
  const gen = state.camGen;
  $('#cam-viewer').hidden = false;
  $('#cam-title').textContent = `📷 ${camTitle(c, kind)}`;
  const stage = $('#cam-stage'), meta = $('#cam-meta'), note = $('#cam-note');
  // the live test leads the chain, so what the marker calls live is exactly what reaches the
  // player and no per-source still branch below can take a stream camera
  if (camIsLive(c)) {
    // live HLS: TxDOT SkyVDN + City of El Paso bridge cams both play direct (CORS-open) in the shared player
    const url = safeUrl(c.httpsurl);
    const isElp = kind === 'elpbridge';
    note.innerHTML = `${srcBadge('official')} ${esc(t(isElp ? 'cam.elp.note' : 'cam.txdot.note'))} · ${esc(CAM_ATTRIB[kind] || CAM_ATTRIB_TXDOT)}`;
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
  } else if (camStillNote(kind)) {
    // proxied still: one same-origin /api/cam/{net} fetch, the same player for every network
    note.innerHTML = `${srcBadge('official')} ${esc(t(camStillNote(kind)))} · ${esc(CAM_ATTRIB[kind])}`;
    stage.innerHTML = `<div class="cam-fallback">${esc(t('cam.loading'))}</div>`;
    loadCityStill(c, stage, meta, false, gen, kind);
  } else if (kind === 'txdot') {
    // snapshot-only ITS cam: fresh JPEG via the same-origin /api/cam proxy, never a "LIVE" player
    note.innerHTML = `${srcBadge('official')} ${esc(t('cam.its.note'))} · ${esc(CAM_ATTRIB_TXDOT)}`;
    stage.innerHTML = `<div class="cam-fallback">${esc(t('cam.loading'))}</div>`;
    loadItsSnapshot(c, stage, meta, false, gen);
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
    /* A feed that publishes no capture time cannot be aged, so it must not wear the plain
       snapshot chip either: without this the frame reads as current and the aging gate can
       never fire on it. Say the time is missing instead of printing an empty one. */
    meta.innerHTML = (when
      ? (stale
        ? `<span class="cam-badge stale">⏱ ${esc(t('cam.stale'))}</span>`
        : `<span class="cam-badge still">${esc(t('cam.snapshot'))}</span>`) +
        `<span class="cam-time">${esc(t('cam.captured'))} ${esc(fmtWhen(when.toISOString()))}</span>` +
        (stale ? `<span class="cam-stale-note">${esc(t('cam.stale.note'))}</span>` : '')
      : `<span class="cam-badge nostamp">${esc(t('cam.nostamp'))}</span>` +
        `<span class="cam-stale-note">${esc(t('cam.nostamp.note'))}</span>`) +
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

// direct-JPEG city stills (austin/houston/arlington/atxfloods) proxied same-origin; net is both the
// /api/cam path segment and the camTitle kind
function loadCityStill(c, stage, meta, bust, gen, net) {
  loadProxyStill(stage, meta, bust, gen, {
    url: (b) => `api/cam/${net}/${encodeURIComponent(c.id)}${b ? `?_=${Date.now()}` : ''}`,
    parse: (s) => { const d = new Date(s); return isNaN(d.getTime()) ? null : d; }, // X-Cam-Captured is an HTTP (Last-Modified) date
    alt: camTitle(c, net),
  });
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
