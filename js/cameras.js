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
const CAM_ATTRIB_LAREDO = 'Bridge cameras: City of Laredo (international bridges)';
const CAM_ATTRIB_EAGLEPASS = 'Bridge cameras: City of Eagle Pass (Port of Eagle Pass)';
const CAM_ATTRIB_DELRIO = 'Bridge cameras: City of Del Rio (International Bridge)';
const CAM_ATTRIB_GALVESTON = 'Port cameras: Port of Galveston (hosted by EarthCam)';
const CAM_ATTRIB = { txdot: CAM_ATTRIB_TXDOT, river: CAM_ATTRIB_USGS, austin: CAM_ATTRIB_AUSTIN, atxfloods: CAM_ATTRIB_ATX, houston: CAM_ATTRIB_HOUSTON, arlington: CAM_ATTRIB_ARLINGTON, elpbridge: CAM_ATTRIB_ELP, hays: CAM_ATTRIB_HAYS, porthou: CAM_ATTRIB_PORTHOU, swrecon: CAM_ATTRIB_SWRECON, corpus: CAM_ATTRIB_CORPUS, lubbock: CAM_ATTRIB_LUBBOCK, weatherbug: CAM_ATTRIB_WBUG, nmdot: CAM_ATTRIB_NMDOT, nps: CAM_ATTRIB_NPS, laredo: CAM_ATTRIB_LAREDO, eaglepass: CAM_ATTRIB_EAGLEPASS, delrio: CAM_ATTRIB_DELRIO, galveston: CAM_ATTRIB_GALVESTON };
const CAM_STALE_MINS = 45; // aging invariant: a still older than this must never look live
const HIVIS_S3 = 'https://usgs-nims-images.s3.amazonaws.com';
const CAM_KEY_RE = /___\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.jpg$/;
// TxDOT signs each stream URL with a token that lapses within minutes, so it is resolved per view
const DTX_ML = CONFIG.dtxMapLarge;
const DTX_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DTX_TABLE_RE = /^appgeo\/cameraPoint\/\d{6,24}$/;
const DTX_STREAM_RE = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.skyvdn\.com\/[A-Za-z0-9_./-]+\.m3u8(\?token=[A-Za-z0-9._-]+)?$/;
const CAM_SIGN_MARGIN_S = 30;
const CAM_SIGN_RETRY_MS = 15000;

// lazy: inventory is a committed snapshot, fetched once on first layer enable / Drive Mode / gauge popup
function loadCameras() {
  if (state.camerasP) return state.camerasP;
  state.camerasP = fetch(`data/cameras.json?_=${Math.floor(Date.now() / 3600000)}`)
    .then((r) => okJson(r, 'cameras'))
    .then((d) => {
      // E1: a body carrying none of the networks is an unreadable inventory, not an empty one;
      // rejecting sends it to the camfail notice instead of drawing a camera-free map
      if (!CAM_NETS.some(([arr]) => Array.isArray(d[arr]))) throw new Error('cameras: no network arrays in body');
      state.camInvAt = d.generated || null;
      state.cameras = { txdot: d.txdot || [], river: d.river || [], austin: d.austin || [], atxfloods: d.atxfloods || [], houston: d.houston || [], arlington: d.arlington || [], elpbridge: d.elpbridge || [], hays: d.hays || [], porthou: d.porthou || [], swrecon: d.swrecon || [], corpus: d.corpus || [], lubbock: d.lubbock || [], weatherbug: d.weatherbug || [], nmdot: d.nmdot || [], nps: d.nps || [], laredo: d.laredo || [], eaglepass: d.eaglepass || [], delrio: d.delrio || [], galveston: d.galveston || [] };
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
  ['laredo', 'laredo'],
  ['eaglepass', 'eaglepass'],
  ['delrio', 'delrio'],
  ['galveston', 'galveston'],
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
  for (const [arr, net] of CAM_NETS) {
    for (const c of state.cameras[arr] || []) {
      const m = mark(c, net);
      if (!m) continue; // no usable coordinates, so no marker to place
      const rid = camRegionId(c.lat, c.lon, regions);
      buckets[rid].push(m);
      if (camIsLive(c)) liveN[rid]++;
    }
  }
  state.camCounts = {};
  state.camLive = {};
  for (const p of camRegionsAll()) {
    state.camCounts[p.id] = buckets[p.id].length;
    state.camLive[p.id] = liveN[p.id];
    put(state.layers[camRegionKey(p.id)], buckets[p.id]);
  }
  layerSheetSync(); // the sheet shows per-region counts, so repaint if it is open when the inventory lands
}

// river cams by camId, id-less networks (TxDOT, El Paso) by name, every other network by its own id
function camLinkToken(c) {
  return String(c.camId != null ? c.camId : c.id != null ? c.id : c.name);
}

// net-qualified because bare ids collide across networks (Austin and Houston both carry a "102")
function camLinkKey(c, kind) {
  return `${kind}.${camLinkToken(c)}`;
}

const CAM_LINK_RE = /^([a-z]+)\.(.+)$/;

/* Deep-link precedence is frozen: river ids resolve before TxDOT names, then every other network
   in CAM_NETS order, so a ?cam= link shared before a network existed still opens the same camera. */
const CAM_FIND_ORDER = ['river'].concat(CAM_NETS.map(([arr]) => arr).filter((a) => a !== 'river'));

// resolve a deep-link token: a net-qualified camLinkKey first, then the legacy camId / name / id
function findCamByKey(want) {
  const m = CAM_LINK_RE.exec(String(want));
  if (m && CAM_NETS.some(([arr]) => arr === m[1])) {
    const hit = (state.cameras[m[1]] || []).find((c) => camLinkToken(c) === m[2]);
    if (hit) return { c: hit, kind: m[1] };
  }
  for (const arr of CAM_FIND_ORDER) {
    const hit = (state.cameras[arr] || []).find((c) => c.name === want ||
      (c.camId !== undefined && c.camId === want) ||
      (c.id !== undefined && String(c.id) === want));
    if (hit) return { c: hit, kind: arr };
  }
  return null;
}

// the viewer stacks above #safety-modal, so a linked camera waits for the 911 ack instead of covering it
function afterSafetyGate(fn) {
  const gate = $('#safety-modal'), ack = $('#safety-ack');
  if (gate && !gate.hidden && ack) { ack.addEventListener('click', fn, { once: true }); return; }
  fn();
}

// ?cam= link: the inventory may land before or after the URL is read, so resolve off its promise
function openCamLink(q) {
  const want = q.get('cam');
  if (!want) return null;
  state.pendingCam = want;
  return loadCameras().then(openPendingCam, () => {
    state.pendingCam = null;
    opNotice(t('note.camfail'));
  });
}

function openPendingCam() {
  const want = state.pendingCam;
  if (!want) return;
  state.pendingCam = null;
  const hit = findCamByKey(want);
  afterSafetyGate(hit ? () => openCamViewer(hit.c, hit.kind) : () => opNotice(t('note.camgone')));
}

function copyCamLink() {
  return state.camOpen ? copyShareLink(buildShareUrl({ cam: state.camOpen }), $('#cam-link')) : null;
}

function camPopup(c, kind) {
  const el = document.createElement('div');
  let sub;
  if (kind === 'river') sub = `${esc(t('cam.river'))}${c.nwisId ? ` · USGS ${esc(c.nwisId)}` : ''}`;
  else if (kind === 'atxfloods' || kind === 'hays') sub = esc(t('cam.floodcam'));
  else if (kind === 'porthou' || kind === 'galveston') sub = esc(t('cam.channel'));
  else if (kind === 'swrecon' || kind === 'corpus') sub = esc(t('cam.coastal'));
  else if (kind === 'weatherbug') sub = esc(t('cam.weather'));
  else if (kind === 'nps') sub = esc(t('cam.park'));
  else if (kind === 'elpbridge' || kind === 'laredo' || kind === 'eaglepass' || kind === 'delrio') sub = esc(t('cam.bridge'));
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
  if (kind === 'laredo') return `City of Laredo · ${t('cam.bridge')}`;
  if (kind === 'eaglepass') return `City of Eagle Pass · ${t('cam.bridge')}`;
  if (kind === 'delrio') return `City of Del Rio · ${t('cam.bridge')}`;
  if (kind === 'galveston') return `Port of Galveston · ${t('cam.channel')}`;
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
  laredo: 'cam.laredo.note',
  eaglepass: 'cam.epbridge.note',
  delrio: 'cam.drbridge.note',
  galveston: 'cam.galv.note',
};
const camStillNote = (kind) => (Object.prototype.hasOwnProperty.call(CAM_STILL_NOTES, kind) ? CAM_STILL_NOTES[kind] : null);

/* The HLS player is the single heaviest asset the board ships and only a live stream needs it, so
   it loads on the first live camera open. Resolves false when the library loaded but this browser
   cannot use it, which is a different message from a fetch that failed. */
function ensureHls() {
  if (window.Hls) return Promise.resolve(Hls.isSupported());
  return loadAssetOnce(assetUrl('js/vendor/hls.light.min.js')).then(() => !!window.Hls && Hls.isSupported());
}

// newest signed playlist for one TxDOT camera: the same two calls drivetexas.org makes on open
async function dtxStreamUrl(name) {
  if (!DTX_NAME_RE.test(String(name || ''))) throw new Error('drivetexas: bad camera name');
  const a = await okJson(await fetch(`${DTX_ML}/Remote/GetActiveTableID?shortTableId=appgeo%2FcameraPoint`, { cache: 'no-store' }), 'drivetexas table');
  if (!DTX_TABLE_RE.test(String(a.table || ''))) throw new Error('drivetexas: no active camera table');
  const q = { action: 'table/query', query: { sqlselect: ['name', 'httpsurl'], start: 0, table: a.table, where: [{ col: 'name', test: 'EqualAny', value: [name] }] } };
  const d = await okJson(await fetch(`${DTX_ML}/Api/ProcessDirect?request=${encodeURIComponent(JSON.stringify(q))}`), 'drivetexas camera');
  if (!d.success) throw new Error('drivetexas: query refused');
  const cols = (d.data && d.data.data) || {};
  const i = (cols.name || []).indexOf(name);
  const url = i === -1 ? '' : String((cols.httpsurl || [])[i] || '');
  if (!DTX_STREAM_RE.test(url)) throw new Error(`drivetexas: no stream for ${name}`);
  return url;
}

// networks whose stream URL carries a short-lived token: a new one is a row here, never a player branch
const CAM_STREAM_SIGNERS = { txdot: (c) => dtxStreamUrl(c.name) };
const camStreamSigned = (kind) => Object.prototype.hasOwnProperty.call(CAM_STREAM_SIGNERS, kind);

// seconds until a signed URL's token lapses: Infinity when unsigned, 0 when unreadable
function camTokenLeft(url) {
  const tok = new URL(url).searchParams.get('token');
  if (!tok) return Infinity;
  try {
    const exp = JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp;
    return Number.isFinite(exp) ? exp - Date.now() / 1000 : 0;
  } catch {
    return 0;
  }
}

// the viewer's stream URL, re-resolved only once the token it holds is near its expiry
function camStreamSource(c, kind) {
  if (!camStreamSigned(kind)) {
    const url = safeUrl(c.httpsurl);
    return () => Promise.resolve(url);
  }
  let cur = null, at = 0, pending = null;
  return () => {
    if (cur && (camTokenLeft(cur) > CAM_SIGN_MARGIN_S || Date.now() - at < CAM_SIGN_RETRY_MS)) return Promise.resolve(cur);
    if (!pending) {
      pending = CAM_STREAM_SIGNERS[kind](c).then((u) => { cur = u; at = Date.now(); return u; })
        .finally(() => { pending = null; });
    }
    return pending;
  };
}

// hls.js reloads a live playlist with the token it started on, so every request takes the newest
const camResign = (src) => async (xhr, url) => {
  const u = new URL(url);
  if (u.searchParams.has('token')) u.searchParams.set('token', new URL(await src()).searchParams.get('token') || '');
  xhr.open('GET', u.href, true);
};

// a native player cannot re-sign its own requests, so a signed stream is re-pointed before it lapses
function camResignNative(video, src, gen, down) {
  const left = camTokenLeft(video.src);
  if (!Number.isFinite(left)) return;
  state.camResign = setTimeout(() => {
    if (gen !== state.camGen) return;
    src().then((u) => {
      if (gen !== state.camGen) return;
      video.src = u;
      video.play().catch(() => { /* autoplay refused; the controls stay */ });
      camResignNative(video, src, gen, down);
    }, down);
  }, Math.max(5, left - CAM_SIGN_MARGIN_S) * 1000);
}

const camOperator = (kind) => camNetLabel(kind).split(' · ')[0];

// a feed that will not load names who runs it, never a spinner or a black frame under a LIVE badge
function camFeedDown(stage, meta, kind) {
  if (state.camHls) {
    try { state.camHls.destroy(); } catch { /* already detached */ }
    state.camHls = null;
  }
  const v = stage.querySelector && stage.querySelector('video');
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
  stage.innerHTML = `<div class="cam-fallback">${esc(t('cam.feed.unavail').replace('{op}', camOperator(kind)))}</div>`;
  meta.innerHTML = '';
}

function openCamViewer(c, kind) {
  camViewerTeardown();
  state.camGen = (state.camGen || 0) + 1; // invalidates every in-flight load from the previous camera
  const gen = state.camGen;
  state.camOpen = { c, kind };
  $('#cam-viewer').hidden = false;
  $('#cam-title').textContent = `📷 ${camTitle(c, kind)}`;
  camNavRender(c, kind);
  const stage = $('#cam-stage'), meta = $('#cam-meta'), note = $('#cam-note');
  // the live test leads the chain, so what the marker calls live is exactly what reaches the
  // player and no per-source still branch below can take a stream camera
  if (camIsLive(c)) {
    // live HLS: TxDOT SkyVDN + City of El Paso bridge cams both play direct (CORS-open) in the shared player
    const src = camStreamSource(c, kind);
    const signed = camStreamSigned(kind);
    const isElp = kind === 'elpbridge';
    note.innerHTML = `${srcBadge('official')} ${esc(t(isElp ? 'cam.elp.note' : 'cam.txdot.note'))} · ${esc(CAM_ATTRIB[kind] || CAM_ATTRIB_TXDOT)}`;
    const video = document.createElement('video');
    video.muted = true; video.autoplay = true; video.playsInline = true; video.controls = true;
    const down = () => { if (gen === state.camGen) camFeedDown(stage, meta, kind); };
    video.addEventListener('error', down);
    const playLive = () => {
      stage.innerHTML = '';
      stage.appendChild(video);
      meta.innerHTML = `<span class="cam-badge live">● ${esc(t('cam.live'))}</span>`;
    };
    const canNative = !!video.canPlayType('application/vnd.apple.mpegurl');
    const playNative = () => src().then((url) => {
      if (gen !== state.camGen) return;
      playLive();
      video.src = url;
      if (signed) camResignNative(video, src, gen, down);
    }, down);
    stage.innerHTML = `<div class="cam-fallback">${esc(t('cam.loading'))}</div>`;
    // only hls.js can re-sign each request, so a signed stream plays natively only where it cannot run
    if (canNative && !(signed && (window.MediaSource || window.ManagedMediaSource))) {
      playNative(); // Safari/iOS play HLS natively and never fetch the player at all
    } else {
      ensureHls().then((ok) => {
        if (gen !== state.camGen) return; // viewer moved on — never paint into another camera's stage
        if (!ok) { if (canNative) return playNative(); stage.innerHTML = `<div class="cam-fallback">${esc(t('cam.nohls'))}</div>`; return; }
        return src().then((url) => {
          if (gen !== state.camGen) return;
          playLive();
          state.camHls = new Hls({ maxBufferLength: 15, xhrSetup: signed ? camResign(src) : undefined });
          state.camHls.on(Hls.Events.ERROR, (ev, data) => { if (data && data.fatal) down(); });
          state.camHls.loadSource(url);
          state.camHls.attachMedia(video);
        }, down);
      }).catch(() => {
        if (gen !== state.camGen) return;
        stage.innerHTML = `<div class="cam-fallback">${esc(t('cam.hlsfail'))}</div>`;
      });
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
      camFeedDown(stage, meta, kind);
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
// opts: { url(bust) -> string, parse(stamp) -> Date|null, alt, kind, direct?(bust) }, shared by every same-origin proxy still
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
    if (opts.direct) { loadDirectStill(stage, meta, bust, gen, opts); return; }
    camFeedDown(stage, meta, opts.kind);
  }
}

// the operator's own image, loaded by the browser where the edge proxy is refused; no stamp is readable cross-origin
function loadDirectStill(stage, meta, bust, gen, opts) {
  const img = document.createElement('img');
  img.alt = opts.alt;
  img.addEventListener('load', () => {
    if (gen !== state.camGen) return;
    stage.innerHTML = '';
    stage.appendChild(img);
    meta.innerHTML = `<span class="cam-badge nostamp">${esc(t('cam.direct'))}</span>` +
      `<span class="cam-stale-note">${esc(t('cam.direct.note').replace('{op}', camOperator(opts.kind)))}</span>` +
      `<button class="popup-expand cam-refresh">↻ ${esc(t('cam.refresh'))}</button>`;
    meta.querySelector('.cam-refresh').addEventListener('click', () => {
      stage.innerHTML = `<div class="cam-fallback">${esc(t('cam.loading'))}</div>`;
      loadDirectStill(stage, meta, true, gen, opts);
    });
  });
  img.addEventListener('error', () => {
    if (gen === state.camGen) camFeedDown(stage, meta, opts.kind);
  });
  img.src = opts.direct(bust);
}

function loadItsSnapshot(c, stage, meta, bust, gen) {
  loadProxyStill(stage, meta, bust, gen, {
    url: (b) => `api/cam/${encodeURIComponent(c.dist)}/${encodeURIComponent(c.icd)}${b ? `?_=${Date.now()}` : ''}`,
    parse: parseItsStamp,
    alt: camTitle(c, 'txdot'),
    kind: 'txdot',
  });
}

// networks whose own published image the browser may load when the edge proxy is refused
const CAM_DIRECT_STILLS = {
  austin: (id) => `https://cctv.austinmobility.io/image/${encodeURIComponent(id)}.jpg`, // the city's published screenshot_address
};

// every direct-JPEG still network in CAM_STILL_NOTES, proxied same-origin; net is both the
// /api/cam path segment and the camTitle kind
function loadCityStill(c, stage, meta, bust, gen, net) {
  const direct = Object.prototype.hasOwnProperty.call(CAM_DIRECT_STILLS, net) ? CAM_DIRECT_STILLS[net] : null;
  loadProxyStill(stage, meta, bust, gen, {
    url: (b) => `api/cam/${net}/${encodeURIComponent(c.id)}${b ? `?_=${Date.now()}` : ''}`,
    parse: (s) => { const d = new Date(s); return isNaN(d.getTime()) ? null : d; }, // X-Cam-Captured is an HTTP (Last-Modified) date
    alt: camTitle(c, net),
    kind: net,
    direct: direct && ((b) => `${direct(c.id)}${b ? `?_=${Date.now()}` : ''}`),
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
    camFeedDown(stage, meta, 'river');
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
  clearTimeout(state.camResign);
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
  state.camOpen = null;
  $('#cam-viewer').hidden = true;
}

// cameras near a hazard (gauge and road popups, Feed river cards); see INTERNAL-NOTES.md "Cameras near a hazard"
const CAMS_NEAR_MI = 5;
const CAMS_NEAR_MAX = 8;
const CAM_OFFLINE_H = 24;
const CAM_INV_FRESH_H = 48;
let camPoolMemo = { of: null, pool: [] };
const camsNearOpen = new Set();

function camPool() {
  if (!state.cameras) return [];
  if (camPoolMemo.of !== state.cameras) {
    const pool = [];
    for (const [arr, kind] of CAM_NETS) {
      for (const c of state.cameras[arr] || []) if (Number.isFinite(c.lat) && Number.isFinite(c.lon)) pool.push({ c, kind });
    }
    camPoolMemo = { of: state.cameras, pool };
  }
  return camPoolMemo.pool;
}

// the inventory's own say: a newest frame that far behind the inventory clock is a stopped camera
function camOffline(c) {
  const at = Date.parse(state.camInvAt), newest = Date.parse(c && c.newest);
  return Number.isFinite(at) && Number.isFinite(newest) && at - newest > CAM_OFFLINE_H * 3600000;
}

// the inventory is hand-run and can be weeks old, so its verdict carries its own date
function camOfflineText() {
  const day = new Date(Date.parse(state.camInvAt)).toLocaleDateString(getLang() === 'es' ? 'es-US' : 'en-US',
    { timeZone: 'America/Chicago', month: 'short', day: 'numeric' });
  return t('camnear.offline').replace('{d}', day);
}

const camInvFresh = () => Date.now() - Date.parse(state.camInvAt) <= CAM_INV_FRESH_H * 3600000;

function camMiText(d, from, to) {
  if (d < 0.05) return t('camnear.here');
  const mi = d < 0.1 ? '<0.1' : d < 10 ? d.toFixed(1) : String(Math.round(d));
  const dir = COMPASS[Math.round(bearingDeg(from[0], from[1], to[0], to[1]) / 45) % 8];
  return t('camnear.dist').replace('{d}', mi).replace('{dir}', dir);
}

// cameras within radiusMi of the nearest anchor point, nearest first; the nearest overall when none are
function camsNear(pts, radiusMi = CAMS_NEAR_MI, max = CAMS_NEAR_MAX) {
  const all = [];
  if (pts.length) {
    for (const x of camPool()) {
      let d = Infinity, from = null;
      for (const p of pts) {
        const di = distMi(p[0], p[1], x.c.lat, x.c.lon);
        if (di < d) { d = di; from = p; }
      }
      all.push({ c: x.c, kind: x.kind, d, from });
    }
  }
  all.sort((a, b) => a.d - b.d);
  const within = all.filter((r) => r.d <= radiusMi);
  const dress = (r) => Object.assign(r, { where: camMiText(r.d, r.from, [r.c.lat, r.c.lon]), offline: camOffline(r.c) });
  return { rows: within.slice(0, max).map(dress), total: within.length, radius: radiusMi,
    nearest: within.length || !all.length ? null : dress(all[0]) };
}

// up to n vertices spread along a closure, so a long one is near every camera along it
function camAnchorPts(geo, n = 12) {
  if (!geo || !Array.isArray(geo.coordinates)) return [];
  const verts = geo.type === 'Point' ? [geo.coordinates] : geo.type === 'MultiLineString' ? geo.coordinates.flat() : geo.coordinates;
  const ok = verts.filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]));
  const pick = ok.length <= n ? ok : Array.from({ length: n }, (_, i) => ok[Math.round((i * (ok.length - 1)) / (n - 1))]);
  return pick.map((c) => [c[1], c[0]]);
}

function camsNearPts(s) {
  return String(s || '').split(';').map((p) => p.split(',').map(Number))
    .filter((p) => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

// markup, so string-built popups and Feed cards can carry it; one document listener (boot.js) runs it
function camsNearBtnHtml(pts, of, compact) {
  const ok = pts.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!ok.length) return '';
  const enc = ok.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(';');
  const label = of ? t('camnear.of').replace('{of}', of) : t('camnear.btn');
  const btn = compact
    ? `<button type="button" class="cams-near-btn sit-cam-btn" aria-expanded="false" aria-label="${esc(label)}" title="${esc(label)}">📷</button>`
    : `<button type="button" class="popup-expand cams-near-btn" aria-expanded="false">📷 ${esc(t('camnear.btn'))}</button>`;
  return `<div class="cams-near${compact ? ' sit-cams' : ''}" data-pts="${enc}">${btn}<div class="cams-near-list" hidden></div></div>`;
}

function camsNearRowHtml(r, i) {
  const glyph = r.offline ? '⏱' : camIsLive(r.c) ? '▶' : '📷';
  const kindLbl = r.offline ? camOfflineText() : camKindLong(r.c);
  const sub = [r.where, camNetLabel(r.kind), r.offline ? camOfflineText() : ''].filter(Boolean).join(' · ');
  return `<button type="button" class="cams-near-row${r.offline ? ' off' : ''}" data-i="${i}">` +
    `<span class="cnr-glyph" role="img" aria-label="${esc(kindLbl)}">${glyph}</span>` +
    `<span class="cnr-text"><span class="cnr-name">${esc(camTitle(r.c, r.kind))}</span><span class="cnr-sub">${esc(sub)}</span></span></button>`;
}

function camsNearHtml(res) {
  const r = String(res.radius);
  if (res.rows.length) {
    const more = res.total - res.rows.length;
    return `<div class="cams-near-head">${esc(t('camnear.head').replace('{r}', r))}</div>` +
      res.rows.map(camsNearRowHtml).join('') +
      (more > 0 ? `<div class="cams-near-note">${esc(t('camnear.more').replace('{n}', String(more)).replace('{r}', r))}</div>` : '');
  }
  return `<div class="cams-near-note">${esc(t('camnear.none').replace('{r}', r))}</div>` +
    (res.nearest ? `<div class="cams-near-head">${esc(t('camnear.nearest'))}</div>${camsNearRowHtml(res.nearest, 0)}` : '');
}

// E1: an inventory that did not load says so, never "no cameras within 5 mi"
function camsNearToggle(box, open) {
  const list = box.querySelector('.cams-near-list');
  const btn = box.querySelector('.cams-near-btn');
  if (!list || !btn) return Promise.resolve();
  const want = open === undefined ? !!list.hidden : open;
  list.hidden = !want;
  btn.setAttribute('aria-expanded', want ? 'true' : 'false');
  const key = box.classList.contains('sit-cams') ? box.getAttribute('data-pts') : null;
  if (key) { if (want) camsNearOpen.add(key); else camsNearOpen.delete(key); }
  if (!want) return Promise.resolve();
  list.innerHTML = `<div class="cams-near-note">${esc(t('camnear.loading'))}</div>`;
  return loadCameras().then(() => {
    const res = camsNear(camsNearPts(box.getAttribute('data-pts')));
    box._camRows = res.rows.length ? res.rows : res.nearest ? [res.nearest] : [];
    list.innerHTML = camsNearHtml(res);
  }).catch(() => {
    box._camRows = [];
    list.innerHTML = `<div class="cams-near-note failed">${esc(t('camnear.fail'))}</div>`;
  });
}

function camsNearClick(e) {
  const el = e && e.target && typeof e.target.closest === 'function' ? e.target : null;
  const box = el && el.closest('.cams-near');
  if (!box) return;
  const row = el.closest('.cams-near-row');
  if (row) {
    const hit = (box._camRows || [])[Number(row.getAttribute('data-i'))];
    if (hit) openCamViewer(hit.c, hit.kind);
    return;
  }
  if (el.closest('.cams-near-btn')) camsNearToggle(box);
}

// the Feed repaints its cards wholesale, so a list the reader opened is opened again
function camsNearReopen(root) {
  if (!camsNearOpen.size || !root) return;
  root.querySelectorAll('.cams-near.sit-cams').forEach((box) => {
    if (camsNearOpen.has(box.getAttribute('data-pts'))) camsNearToggle(box, true);
  });
}

// the next camera along the same road (TxDOT) or river (USGS HIVIS)
const CAM_ROAD_RE = /^(IH|I|US|SH|SL|LP|LOOP|SP|SPUR|FM|RM|RR|BW)[\s-]*0*(\d+)([A-Z]{0,2})(?![A-Z\d])/i;
const CAM_ROAD_PREFIX = { IH: 'I-', I: 'I-', US: 'US ', SH: 'SH ', SL: 'Loop ', LP: 'Loop ', LOOP: 'Loop ', SP: 'Spur ', SPUR: 'Spur ', FM: 'FM ', RM: 'RM ', RR: 'RM ', BW: 'Beltway ' };
// I-35E/W and I-69E/C/W are separate roads; any other N/S/E/W suffix names one carriageway of the same road
const CAM_ROAD_LETTERED = /^I-(?:35|69)$/;
const CAM_ROAD_GAP_MI = 20;
const CAM_STRAY_MI = 2;
const CAM_DROP_MI = 5;
const CAM_RIVER_GAP_MI = 150;
const CAM_RIVER_RE = /^[A-Z]{2}_(.+?)_(?:at|nr|near|abv|above|blw|below|on|in)_/i;
const CAM_RIVER_WORD = { rv: 'River', rvr: 'River', ck: 'Creek', fk: 'Fork', e: 'East', w: 'West', n: 'North', s: 'South' };
// a USGS downstream-order station number: two-digit HUC part, then six digits that grow downstream
const USGS_SITE_RE = /^(?:0[1-9]|1\d|2[01])\d{6}$/;
const camSeqMemo = new Map();
let camSeqOf = null;

// the road a TxDOT camera stands on, from its route field or the text before "@" / " at "
function camRoad(c, kind) {
  if (kind !== 'txdot' || !c) return null;
  const route = String(c.route || '').trim();
  const raw = route && !/^unspecified$/i.test(route) ? route : String(c.description || c.name || '');
  const head = raw.replace(/^CCTV[_\s-]*/i, '').split(/\s*@\s*|\s+at\s+/i)[0].trim();
  if (!head || /^(?:HQ_)?PCMS\b|^TX_[A-Z]{3}_\d/i.test(head)) return null;
  if (/\bsam hou/i.test(head)) return { key: 'BELTWAY 8', label: 'Beltway 8' };
  const m = CAM_ROAD_RE.exec(head);
  if (!m) {
    const label = head.replace(/\s+/g, ' ');
    return { key: label.toUpperCase(), label };
  }
  const pre = m[1].toUpperCase();
  const base = `${CAM_ROAD_PREFIX[pre]}${m[2]}`;
  const s = m[3].toUpperCase();
  // two letters are a loop side or managed lanes (IH820NL, IH-10ML), never another road
  const suf = pre === 'BW' || s.length === 2 || (/^[NSEW]$/.test(s) && !CAM_ROAD_LETTERED.test(base)) ? '' : s;
  const label = `${base}${suf}`;
  return { key: label.toUpperCase(), label };
}

// the river a HIVIS camera watches, read off its camId, with the station number that orders it downstream
function camRiver(c, kind) {
  if (kind !== 'river' || !c) return null;
  const m = CAM_RIVER_RE.exec(String(c.camId || ''));
  if (!m || !USGS_SITE_RE.test(String(c.nwisId || ''))) return null;
  const label = m[1].split('_').filter(Boolean)
    .map((w) => CAM_RIVER_WORD[w.toLowerCase()] || w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  // the HUC part keeps a same-named stream in another region off this one
  return /\b(?:River|Creek|Bayou)\b|^Rio\b/.test(label)
    ? { key: `${label.toLowerCase()}|${String(c.nwisId).slice(0, 2)}`, label, site: Number(c.nwisId) } : null;
}

// one river's cameras in downstream order, split where the next is too far off to be the same stream
function camRiverChains(cams) {
  const out = [];
  for (const c of cams.slice().sort((a, b) => camRiver(a, 'river').site - camRiver(b, 'river').site)) {
    const cur = out[out.length - 1];
    const last = cur && cur.line[cur.line.length - 1];
    if (last && distMi(last.lat, last.lon, c.lat, c.lon) <= CAM_RIVER_GAP_MI) cur.line.push(c);
    else out.push({ line: [c], ring: false });
  }
  return out;
}

// single-linkage stretches: a gap longer than gapMi starts another stretch of the same road
function camStretches(cams, gapMi) {
  const n = cams.length, seen = new Array(n).fill(false), out = [];
  const dLat = gapMi / 69;
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    seen[s] = true;
    const group = [cams[s]], stack = [s];
    while (stack.length) {
      const a = cams[stack.pop()];
      for (let j = 0; j < n; j++) {
        if (seen[j] || Math.abs(cams[j].lat - a.lat) > dLat) continue;
        if (distMi(a.lat, a.lon, cams[j].lat, cams[j].lon) <= gapMi) { seen[j] = true; group.push(cams[j]); stack.push(j); }
      }
    }
    out.push(group);
  }
  return out;
}

// road order: along the main axis (east- or northward) or around the centre, whichever walks shorter
function camOrderStretch(group) {
  const n = group.length;
  const all = group.map((_, i) => i);
  const lat0 = group.reduce((s, c) => s + c.lat, 0) / n;
  const kx = 69.17 * Math.cos((lat0 * Math.PI) / 180), ky = 69.17;
  const xy = group.map((c) => [c.lon * kx, c.lat * ky]);
  const cx = xy.reduce((s, p) => s + p[0], 0) / n, cy = xy.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x0, y0] of xy) {
    const x = x0 - cx, y = y0 - cy;
    sxx += x * x; syy += y * y; sxy += x * y;
  }
  const l1 = (sxx + syy) / 2 + Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
  let ax = Math.abs(sxy) > 1e-9 ? sxy : sxx >= syy ? 1 : 0, ay = Math.abs(sxy) > 1e-9 ? l1 - sxx : sxx >= syy ? 0 : 1;
  if (Math.abs(ax) >= Math.abs(ay) ? ax < 0 : ay < 0) { ax = -ax; ay = -ay; }
  const proj = xy.map(([x, y]) => x * ax + y * ay);
  const along = camDropStrays(all.slice().sort((a, b) => proj[a] - proj[b]).map((i) => group[i]));
  if (n < 4) return { line: along, ring: false };
  const ang = xy.map(([x, y]) => Math.atan2(y - cy, x - cx));
  const round = all.slice().sort((a, b) => ang[a] - ang[b]);
  let cut = 0, widest = -1;
  for (let k = 0; k < n; k++) {
    const span = ang[round[(k + 1) % n]] - ang[round[k]] + (k + 1 === n ? 2 * Math.PI : 0);
    if (span > widest) { widest = span; cut = (k + 1) % n; }
  }
  const around = camDropStrays(round.slice(cut).concat(round.slice(0, cut)).map((i) => group[i]));
  const hops = (line) => line.slice(1).map((c, k) => distMi(line[k].lat, line[k].lon, c.lat, c.lon));
  const cost = (line) => hops(line).reduce((s, d) => s + d, 0) + (n - line.length) * CAM_DROP_MI;
  if (cost(around) >= 0.9 * cost(along)) return { line: along, ring: false };
  const steps = hops(around).sort((a, b) => a - b);
  const last = around[around.length - 1];
  // closed only where the loop really closes: no wide arc missing, and the jump back is a usual step
  return { line: around, ring: widest < Math.PI / 2
    && distMi(last.lat, last.lon, around[0].lat, around[0].lon) <= 3 * steps[Math.floor(steps.length / 2)] };
}

// a camera placed far off the line its neighbours draw is a misplaced position, not the next stop
function camDropStrays(line) {
  for (let k = 1; k < line.length - 1; k++) {
    const [a, b, c] = [line[k - 1], line[k], line[k + 1]];
    const ac = distMi(a.lat, a.lon, c.lat, c.lon);
    if (distMi(a.lat, a.lon, b.lat, b.lon) + distMi(b.lat, b.lon, c.lat, c.lon) - ac > Math.max(CAM_STRAY_MI, 2 * ac)) {
      line.splice(k, 1);
      k = Math.max(0, k - 2);
    }
  }
  return line;
}

function camLineOf(c, kind) {
  const id = kind === 'river' ? camRiver(c, kind) : camRoad(c, kind);
  if (!id || !state.cameras) return null;
  if (camSeqOf !== state.cameras) { camSeqMemo.clear(); camSeqOf = state.cameras; }
  const mk = `${kind}|${id.key}`;
  if (!camSeqMemo.has(mk)) {
    const pick = kind === 'river' ? camRiver : camRoad;
    const cams = (state.cameras[kind] || []).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon)
      && (pick(x, kind) || {}).key === id.key);
    camSeqMemo.set(mk, kind === 'river' ? camRiverChains(cams) : camStretches(cams, CAM_ROAD_GAP_MI).map(camOrderStretch));
  }
  for (const s of camSeqMemo.get(mk)) {
    const i = s.line.indexOf(c);
    if (i !== -1) return { line: s.line, ring: s.ring, i, label: id.label, river: kind === 'river' };
  }
  return null;
}

// the adjacent camera each way; a stopped one is skipped only on a fresh inventory, else offered with its date
function camNeighbours(c, kind) {
  const s = camLineOf(c, kind);
  if (!s) return null;
  const n = s.line.length;
  const skipStopped = camInvFresh();
  const step = (dir) => {
    for (let k = 1; k < n; k++) {
      let j = s.i + dir * k;
      if (s.ring) j = ((j % n) + n) % n;
      else if (j < 0 || j >= n) return null;
      const o = s.line[j];
      if (o === c) return null;
      const offline = camOffline(o);
      if (offline && skipStopped) continue;
      const d = distMi(c.lat, c.lon, o.lat, o.lon);
      return { c: o, kind, d, offline, where: camMiText(d, [c.lat, c.lon], [o.lat, o.lon]) };
    }
    return null;
  };
  const next = step(1);
  let prev = step(-1);
  if (prev && next && prev.c === next.c) prev = null;
  return prev || next ? { label: s.label, river: s.river, prev, next } : null;
}

function camNavHtml(nb) {
  if (!nb) return '';
  const btn = (side, x, key) => `<button type="button" class="cam-nav-btn ${side}" data-nav="${side}" title="${esc(camTitle(x.c, x.kind))}">` +
    `${side === 'prev' ? '‹ ' : ''}${esc(t(key).replace('{road}', nb.label).replace('{d}', x.where))}` +
    `${x.offline ? ` · ⏱ ${esc(camOfflineText())}` : ''}${side === 'next' ? ' ›' : ''}</button>`;
  return (nb.prev ? btn('prev', nb.prev, nb.river ? 'camnav.up' : 'camnav.prev') : '') +
    (nb.next ? btn('next', nb.next, nb.river ? 'camnav.down' : 'camnav.next') : '');
}

function camNavRender(c, kind) {
  const nav = $('#cam-nav');
  if (!nav) return;
  const nb = camNeighbours(c, kind);
  nav.innerHTML = camNavHtml(nb);
  nav.hidden = !nb;
  if (!nb) return;
  nav.querySelectorAll('.cam-nav-btn').forEach((b) => b.addEventListener('click', () => {
    const side = b.getAttribute('data-nav');
    const x = nb[side];
    if (!x) return;
    openCamViewer(x.c, x.kind);
    // the step rebuilt the buttons: keep the keyboard on the same side, or the one left at a road's end
    const again = nav.querySelector(`.cam-nav-btn.${side}`) || nav.querySelector('.cam-nav-btn');
    if (again) again.focus();
  }));
}
