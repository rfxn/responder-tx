'use strict';

/* ---------- live team location sharing (flag-gated ?team=) ----------
   Opt-in only. A team is private and reachable only via its unguessable UUID link. Members
   share their live location; viewers watch without sharing (but still appear in the roster and
   must set a handle). All live state lives in a Cloudflare Durable Object relay
   (functions/api/team/*), never in this repo. Secure-context (HTTPS/localhost) only — geolocation
   requires it and the LAN http board carries no relay route. Inert when ?team= is absent. */

(function () {
  const POLL_MS = 15000;   // GET team state cadence
  const POST_MS = 15000;   // publish own position cadence (breadcrumb ~every 15s)
  const HANDLE_MIN = 4;
  const STALE_MS = 90000;  // grey a member marker after this long with no update
  const SELF_TRAIL_MAX = 400;
  const eidKey = (id) => `respondertx.team.eid.${id}`;

  const T = {
    id: null, name: '', role: null, ephemeralId: null, handle: '',
    watchId: null, pollTimer: null, postTimer: null,
    layer: null, markers: {}, lastMembers: [], selfTrail: [], selfPos: null, active: false,
  };

  const api = (path, opts) => fetch(`/api/team/${path}`, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));

  function tt(key, fallback) { const s = window.t ? t(key) : key; return s === key ? fallback : s; }

  /* ---------- map layer ---------- */

  function ensureLayer() {
    if (T.layer) return;
    if (!state.map.getPane('team')) {
      state.map.createPane('team');
      state.map.getPane('team').style.zIndex = 640; // above hazard markers (600), below popups
    }
    T.layer = L.layerGroup().addTo(state.map);
  }

  function memberIcon(handle, color, isSelf, stale) {
    const cls = `team-marker${isSelf ? ' team-self' : ''}${stale ? ' team-stale' : ''}`;
    return L.divIcon({
      className: '',
      html: `<div class="${cls}" style="--tc:${color || '#40c4ff'}"><span class="tm-dot"></span><span class="tm-label">${esc(handle)}${isSelf ? ' ·' + esc(tt('team.you', 'you')) : ''}</span></div>`,
      iconSize: [14, 14], iconAnchor: [7, 7],
    });
  }

  // renders the cached server roster with the local self-fix overlaid, so a poll that predates
  // the server echoing our own position never wipes our self-marker, and a self GPS tick never
  // wipes other members' markers
  function renderAll() {
    ensureLayer();
    const members = (T.lastMembers || []).slice();
    if (T.role === 'member' && T.selfPos && !members.some((m) => m.ephemeralId === T.ephemeralId)) {
      members.push({ ephemeralId: T.ephemeralId, handle: T.handle, color: selfColor(), lastPos: null, lastSeen: Date.now(), trail: [] });
    }
    const seen = {};
    for (const m of members) {
      const isSelf = m.ephemeralId === T.ephemeralId;
      const pos = isSelf && T.selfPos ? { lat: T.selfPos.lat, lon: T.selfPos.lon } : m.lastPos;
      if (!pos) continue;
      seen[m.ephemeralId] = true;
      const color = isSelf ? selfColor() : m.color;
      const stale = !isSelf && Date.now() - (m.lastSeen || 0) > STALE_MS;
      const ll = [pos.lat, pos.lon];
      let entry = T.markers[m.ephemeralId];
      if (!entry) {
        entry = {
          marker: L.marker(ll, { pane: 'team', icon: memberIcon(m.handle, color, isSelf, stale), zIndexOffset: isSelf ? 1000 : 0, interactive: false }),
          trail: L.polyline([], { pane: 'team', color: color || '#40c4ff', weight: 3, opacity: 0.65 }),
        };
        entry.trail.addTo(T.layer);
        entry.marker.addTo(T.layer);
        T.markers[m.ephemeralId] = entry;
      } else {
        entry.marker.setLatLng(ll);
        entry.marker.setIcon(memberIcon(m.handle, color, isSelf, stale));
      }
      // self draws its own responsive full-res trail; others render the server's capped copy
      const pts = isSelf && T.selfTrail.length ? T.selfTrail : (m.trail || []).map((p) => [p.lat, p.lon]);
      entry.trail.setLatLngs(pts);
    }
    for (const id of Object.keys(T.markers)) {
      if (!seen[id]) { T.layer.removeLayer(T.markers[id].marker); T.layer.removeLayer(T.markers[id].trail); delete T.markers[id]; }
    }
  }

  /* ---------- roster panel ---------- */

  function ageStr(lastSeen) {
    const s = Math.max(0, Math.round((Date.now() - lastSeen) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${Math.round(s / 3600)}h`;
  }

  function renderPanel(data) {
    const panel = document.getElementById('team-panel');
    if (!panel) return;
    const members = data.members || [], viewers = data.viewers || [];
    const rows = [];
    for (const m of members) {
      const isSelf = m.ephemeralId === T.ephemeralId;
      const hasFix = !!m.lastPos || (isSelf && !!T.selfPos); // self shows its local fix before the server echoes it
      const stale = !isSelf && Date.now() - (m.lastSeen || 0) > STALE_MS;
      const swColor = isSelf ? selfColor() : (m.color || '#40c4ff');
      rows.push(`<div class="tp-row${stale ? ' tp-stale' : ''}">
        <span class="tp-sw" style="background:${esc(swColor)}"></span>
        <span class="tp-name">${esc(m.handle)}${isSelf ? ` <span class="tp-tag">${esc(tt('team.you', 'you'))}</span>` : ''}</span>
        <span class="tp-age">${hasFix ? tt('team.seen', 'seen') + ' ' + ageStr(m.lastSeen || Date.now()) : tt('team.nofix', 'no fix')}</span>
      </div>`);
    }
    for (const v of viewers) {
      const isSelf = v.ephemeralId === T.ephemeralId;
      rows.push(`<div class="tp-row tp-viewer">
        <span class="tp-sw tp-sw-eye">👁</span>
        <span class="tp-name">${esc(v.handle)}${isSelf ? ` <span class="tp-tag">${esc(tt('team.you', 'you'))}</span>` : ''}</span>
        <span class="tp-age">${esc(tt('team.viewer', 'viewer'))}</span>
      </div>`);
    }
    panel.querySelector('.tp-list').innerHTML = rows.join('') ||
      `<div class="tp-empty">${esc(tt('team.empty', 'No one here yet.'))}</div>`;
    panel.querySelector('.tp-count').textContent = `${members.length} · ${viewers.length}`;
  }

  /* ---------- polling ---------- */

  async function poll() {
    if (!T.active) return;
    try {
      const r = await api(`${T.id}/state?ephemeralId=${encodeURIComponent(T.ephemeralId || '')}`);
      if (r.status === 404) { note(tt('team.expired', 'This team has expired or was not found.')); teardown(); return; }
      if (!r.ok) return;
      const data = await r.json();
      T.name = data.name || T.name;
      T.lastMembers = data.members || [];
      renderAll();
      renderPanel(data);
    } catch { /* transient network — next tick retries */ }
  }

  /* ---------- member sharing (geolocation) ---------- */

  function onPos(p) {
    const { latitude: lat, longitude: lon, accuracy: acc, heading: hdg, speed: spd } = p.coords;
    T.selfPos = { lat, lon, acc, hdg, spd };
    const last = T.selfTrail[T.selfTrail.length - 1];
    if (!last || Math.abs(last[0] - lat) > 1e-5 || Math.abs(last[1] - lon) > 1e-5) {
      T.selfTrail.push([lat, lon]);
      if (T.selfTrail.length > SELF_TRAIL_MAX) T.selfTrail.shift();
    }
    renderAll(); // responsive self render — don't wait for the next poll
    if (window.gpsWait) gpsWait(false);
  }

  function onPosErr() {
    if (window.gpsWait) gpsWait(false);
    note(tt('team.geoerr', 'Location unavailable (permission denied or no GPS). You are listed but not on the map.'));
  }

  let _selfColor = '#40c4ff';
  const selfColor = () => _selfColor;

  async function postPosition() {
    if (!T.active || T.role !== 'member' || !T.selfPos) return;
    try {
      await api(`${T.id}/position`, {
        method: 'POST',
        body: JSON.stringify({ ephemeralId: T.ephemeralId, lat: T.selfPos.lat, lon: T.selfPos.lon, acc: T.selfPos.acc, hdg: T.selfPos.hdg, spd: T.selfPos.spd }),
      });
    } catch { /* transient — next tick retries */ }
  }

  function startSharing() {
    if (!('geolocation' in navigator)) { onPosErr(); return; }
    if (window.gpsWait) gpsWait(true);
    T.watchId = navigator.geolocation.watchPosition(onPos, onPosErr, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
    T.postTimer = setInterval(postPosition, POST_MS);
  }

  /* ---------- join / leave lifecycle ---------- */

  async function join(role) {
    const handle = document.getElementById('team-handle').value.trim();
    if (handle.length < HANDLE_MIN) { modalErr(tt('team.handleshort', `Handle must be at least ${HANDLE_MIN} characters.`)); return; }
    let ephemeralId = null;
    try { ephemeralId = localStorage.getItem(eidKey(T.id)); } catch { /* private mode */ }
    modalErr('');
    setModalBusy(true);
    try {
      const r = await api(`${T.id}/join`, { method: 'POST', body: JSON.stringify({ handle, role, ephemeralId }) });
      const data = await r.json();
      if (!r.ok) { modalErr(data.error || tt('team.joinfail', 'Could not join this team.')); setModalBusy(false); return; }
      T.role = data.you.role;
      T.handle = data.you.handle;
      T.ephemeralId = data.you.ephemeralId;
      T.name = data.name || '';
      if (data.you.color) _selfColor = data.you.color;
      try { localStorage.setItem(eidKey(T.id), T.ephemeralId); } catch { /* private mode — reload starts a fresh member */ }
      T.active = true;
      closeModal();
      openPanel();
      if (T.role === 'member') startSharing();
      poll();
      T.pollTimer = setInterval(poll, POLL_MS);
    } catch {
      modalErr(tt('team.joinfail', 'Could not join this team.'));
      setModalBusy(false);
    }
  }

  function stopWatch() {
    if (T.watchId != null) { try { navigator.geolocation.clearWatch(T.watchId); } catch { /* already cleared */ } T.watchId = null; }
    if (T.postTimer) { clearInterval(T.postTimer); T.postTimer = null; }
  }

  function teardown() {
    T.active = false;
    stopWatch();
    if (T.pollTimer) { clearInterval(T.pollTimer); T.pollTimer = null; }
    if (T.layer) { T.layer.clearLayers(); }
    T.markers = {}; T.lastMembers = []; T.selfTrail = []; T.selfPos = null;
    const panel = document.getElementById('team-panel');
    if (panel) panel.hidden = true;
  }

  async function leave() {
    const eid = T.ephemeralId;
    teardown();
    if (eid) {
      try { await api(`${T.id}/leave`, { method: 'POST', body: JSON.stringify({ ephemeralId: eid }) }); } catch { /* server TTL is the backstop */ }
    }
    note(tt('team.left', 'You left the team and stopped sharing.'));
  }

  // best-effort drop when the tab is closed/hidden; server TTL still reaps if this never lands
  function beaconLeave() {
    if (!T.active || !T.ephemeralId) return;
    try {
      const blob = new Blob([JSON.stringify({ ephemeralId: T.ephemeralId })], { type: 'application/json' });
      navigator.sendBeacon(`/api/team/${T.id}/leave`, blob);
    } catch { /* sendBeacon unsupported — TTL backstop */ }
  }

  /* ---------- UI: consent/join modal, create modal, roster panel ---------- */

  function note(msg) {
    const el = document.getElementById('refresh-note');
    if (el) el.textContent = msg;
  }

  function modalErr(msg) {
    const e = document.getElementById('team-modal-err');
    if (e) { e.textContent = msg; e.hidden = !msg; }
  }

  function setModalBusy(on) {
    document.querySelectorAll('#team-modal button').forEach((b) => { b.disabled = on; });
    if (!on) syncJoinButtons();
  }

  function syncJoinButtons() {
    const ok = (document.getElementById('team-handle').value.trim().length >= HANDLE_MIN);
    document.getElementById('team-join-member').disabled = !ok;
    document.getElementById('team-join-viewer').disabled = !ok;
  }

  function buildModal() {
    if (document.getElementById('team-modal')) return;
    const el = document.createElement('div');
    el.id = 'team-modal';
    el.hidden = true;
    el.innerHTML =
      '<div class="modal-box team-box">' +
      `<div class="modal-head"><strong id="team-modal-title">${esc(tt('team.join.head', 'Join team'))}</strong>` +
      `<button id="team-modal-close" title="${esc(tt('team.cancel', 'Cancel'))}">✕</button></div>` +
      '<div class="team-body">' +
      `<p class="team-consent" id="team-consent">${tt('team.consent', 'You are about to share your <strong>live location</strong> with everyone who has this team\'s link. Only join a team you trust. Use a call sign or role — not your legal name.')}</p>` +
      `<p class="team-safety">${esc(tt('team.safety', '⚠ Life-threatening emergency → call 911. This is situational awareness, not a dispatch system.'))}</p>` +
      `<input id="team-handle" maxlength="24" autocomplete="off" placeholder="${esc(tt('team.handle.ph', 'Handle / call sign (min 4 characters)'))}">` +
      '<div id="team-modal-err" class="team-err" hidden></div>' +
      '<div class="team-btnrow">' +
      `<button id="team-join-member" class="primary" disabled>${esc(tt('team.share', '📍 Share my location'))}</button>` +
      `<button id="team-join-viewer" disabled>${esc(tt('team.watch', '👁 Just watch'))}</button>` +
      '</div>' +
      `<p class="team-foot">${esc(tt('team.foot', 'No account, no login. Your handle is not stored beyond this team and expires automatically. Foreground, screen-on only.'))}</p>` +
      '</div></div>';
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target.id === 'team-modal') closeModal(); });
    document.getElementById('team-modal-close').addEventListener('click', closeModal);
    const h = document.getElementById('team-handle');
    h.addEventListener('input', syncJoinButtons);
    h.addEventListener('keydown', (e) => { if (e.key === 'Enter' && h.value.trim().length >= HANDLE_MIN) join('member'); });
    document.getElementById('team-join-member').addEventListener('click', () => join('member'));
    document.getElementById('team-join-viewer').addEventListener('click', () => join('viewer'));
  }

  function openModal() {
    buildModal();
    const title = document.getElementById('team-modal-title');
    title.textContent = T.name ? `${tt('team.join.head', 'Join team')}: ${T.name}` : tt('team.join.head', 'Join team');
    document.getElementById('team-modal').hidden = false;
    setTimeout(() => document.getElementById('team-handle').focus(), 50);
  }

  function closeModal() { const m = document.getElementById('team-modal'); if (m) m.hidden = true; }

  function buildPanel() {
    if (document.getElementById('team-panel')) return;
    const el = document.createElement('div');
    el.id = 'team-panel';
    el.hidden = true;
    el.innerHTML =
      '<div class="tp-head">' +
      `<strong>👥 ${esc(tt('team.panel.head', 'Team'))}</strong>` +
      '<span class="tp-count"></span>' +
      `<button id="team-share" title="${esc(tt('team.copylink', 'Copy the team link'))}">🔗</button>` +
      `<button id="team-min" title="${esc(tt('team.min', 'Minimize'))}">–</button>` +
      '</div>' +
      '<div class="tp-list"></div>' +
      `<button id="team-leave" class="tp-leave">${esc(tt('team.stop', '⏻ Stop sharing & leave'))}</button>` +
      `<div class="tp-note">${esc(tt('team.panel.note', 'Positions are ephemeral, private to this link, and never saved.'))}</div>`;
    document.body.appendChild(el);
    document.getElementById('team-leave').addEventListener('click', leave);
    document.getElementById('team-share').addEventListener('click', () => {
      const url = `${location.origin}/?team=${T.id}`;
      const btn = document.getElementById('team-share');
      copyText(url).then(() => { btn.textContent = '✓'; setTimeout(() => { btn.textContent = '🔗'; }, 1500); }, () => prompt('Copy team link:', url));
    });
    document.getElementById('team-min').addEventListener('click', () => el.classList.toggle('tp-collapsed'));
  }

  function openPanel() {
    buildPanel();
    const leaveBtn = document.getElementById('team-leave');
    if (leaveBtn) leaveBtn.textContent = T.role === 'member' ? tt('team.stop', '⏻ Stop sharing & leave') : tt('team.leave', '⏻ Leave team');
    document.getElementById('team-panel').hidden = false;
  }

  /* ---------- create-team flow ---------- */

  function buildCreateModal() {
    if (document.getElementById('team-create')) return;
    const el = document.createElement('div');
    el.id = 'team-create';
    el.hidden = true;
    el.innerHTML =
      '<div class="modal-box team-box">' +
      `<div class="modal-head"><strong>${esc(tt('team.create.head', 'Create a team'))}</strong>` +
      `<button id="team-create-close" title="${esc(tt('team.cancel', 'Cancel'))}">✕</button></div>` +
      '<div class="team-body">' +
      `<p>${esc(tt('team.create.desc', 'Creates a private team with an unguessable link. Anyone you send the link to can join as a member (shares location) or a viewer (watch only). No account needed.'))}</p>` +
      `<input id="team-create-name" maxlength="40" autocomplete="off" placeholder="${esc(tt('team.create.ph', 'Team name (optional)'))}">` +
      '<div id="team-create-err" class="team-err" hidden></div>' +
      '<div id="team-create-result" hidden></div>' +
      `<div class="team-btnrow"><button id="team-create-go" class="primary">${esc(tt('team.create.go', 'Create team'))}</button></div>` +
      `<div class="team-or">${esc(tt('team.or', 'or'))}</div>` +
      `<label class="team-joinlbl" for="team-join-link">${esc(tt('team.join.link.lbl', 'Have a team link?'))}</label>` +
      `<input id="team-join-link" autocomplete="off" placeholder="${esc(tt('team.join.link.ph', 'Paste team link or code'))}">` +
      '<div id="team-join-err" class="team-err" hidden></div>' +
      `<div class="team-btnrow"><button id="team-join-open">${esc(tt('team.join.link.go', 'Open team →'))}</button></div>` +
      '</div></div>';
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target.id === 'team-create') closeCreate(); });
    document.getElementById('team-create-close').addEventListener('click', closeCreate);
    document.getElementById('team-create-go').addEventListener('click', doCreate);
    document.getElementById('team-join-open').addEventListener('click', doJoinLink);
    const jl = document.getElementById('team-join-link');
    jl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoinLink(); });
  }

  function closeCreate() { const m = document.getElementById('team-create'); if (m) m.hidden = true; }

  async function doCreate() {
    const name = document.getElementById('team-create-name').value.trim();
    const err = document.getElementById('team-create-err');
    const go = document.getElementById('team-create-go');
    err.hidden = true; go.disabled = true;
    try {
      const r = await api('create', { method: 'POST', body: JSON.stringify({ name }) });
      const data = await r.json();
      if (!r.ok || !data.teamId) { err.textContent = data.error || tt('team.create.fail', 'Could not create the team.'); err.hidden = false; go.disabled = false; return; }
      const url = `${location.origin}/?team=${data.teamId}`;
      const res = document.getElementById('team-create-result');
      res.hidden = false;
      res.innerHTML =
        `<div class="team-linkrow"><input readonly id="team-create-link" value="${esc(url)}"></div>` +
        '<div class="team-qr" id="team-create-qr"></div>' +
        `<div class="team-qrcap">${esc(tt('team.qr.cap', 'Scan to join on another device'))}</div>` +
        `<div class="team-btnrow"><button id="team-create-copy">${esc(tt('team.copy', 'Copy link'))}</button>` +
        `<button id="team-create-enter" class="primary">${esc(tt('team.enter', 'Enter team →'))}</button></div>`;
      renderQR(document.getElementById('team-create-qr'), url);
      go.disabled = false;
      document.getElementById('team-create-copy').addEventListener('click', () => {
        const b = document.getElementById('team-create-copy');
        copyText(url).then(() => { b.textContent = tt('team.copied', 'Copied ✓'); }, () => prompt('Copy team link:', url));
      });
      document.getElementById('team-create-enter').addEventListener('click', () => {
        T.id = data.teamId; T.name = data.name || '';
        try { history.replaceState(null, '', url); } catch { /* sandboxed — cosmetic */ }
        closeCreate();
        openModal();
      });
    } catch {
      err.textContent = tt('team.create.fail', 'Could not create the team.'); err.hidden = false; go.disabled = false;
    }
  }

  // client-side QR of the team link — dark-on-light so it scans in either theme; silent if the lib is absent
  function renderQR(container, url) {
    if (!container) return;
    try {
      if (typeof qrcode !== 'function') { container.hidden = true; return; }
      const qr = qrcode(0, 'M'); // typeNumber 0 = auto-size for the URL length
      qr.addData(url);
      qr.make();
      container.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
    } catch { container.hidden = true; }
  }

  /* ---------- entry ---------- */

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // accept a full ?team= link or a bare UUID pasted into the join field
  function parseTeamId(raw) {
    if (!raw) return null;
    const m = raw.match(/team=([0-9a-f-]+)/i);
    const cand = (m ? m[1] : raw).trim();
    return UUID_RE.test(cand) ? cand : null;
  }

  function doJoinLink() {
    const id = parseTeamId(document.getElementById('team-join-link').value);
    const err = document.getElementById('team-join-err');
    if (!id) { err.textContent = tt('team.join.link.bad', 'That team link or code is not valid.'); err.hidden = false; return; }
    err.hidden = true;
    T.id = id; T.name = '';
    try { history.replaceState(null, '', `${location.origin}/?team=${id}`); } catch { /* sandboxed — cosmetic */ }
    closeCreate();
    api(`${id}/state`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) T.name = d.name || ''; }).catch(() => {}).finally(openModal);
  }

  let _lifecycleArmed = false;
  function armLifecycle() {
    if (_lifecycleArmed) return;
    _lifecycleArmed = true;
    window.addEventListener('pagehide', beaconLeave);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') beaconLeave(); });
  }

  // ⋮ More → Team: reach create/join without a ?team= link. Already in a team → reopen the roster.
  window.openTeamEntry = function openTeamEntry() {
    if (!window.isSecureContext) { note(tt('team.needhttps', 'Live team sharing needs the secure site: https://responder.rfxn.com')); return; }
    if (T.active) { openPanel(); return; }
    armLifecycle();
    buildCreateModal();
    const res = document.getElementById('team-create-result');
    if (res) { res.hidden = true; res.innerHTML = ''; }
    for (const eid of ['team-create-err', 'team-join-err']) { const e = document.getElementById(eid); if (e) e.hidden = true; }
    document.getElementById('team-create').hidden = false;
  };

  function start() {
    const param = new URLSearchParams(location.search).get('team');
    if (!param) return; // inert unless explicitly opened
    if (!window.isSecureContext) {
      note(tt('team.needhttps', 'Live team sharing needs the secure site: https://responder.rfxn.com'));
      return;
    }
    ensureLayer();
    armLifecycle();
    if (param === 'new') { buildCreateModal(); document.getElementById('team-create').hidden = false; return; }
    if (!UUID_RE.test(param)) { note(tt('team.badlink', 'That team link is not valid.')); return; }
    T.id = param;
    // fetch name / existence first so the consent modal can name the team; 404 = expired
    api(`${param}/state`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) T.name = d.name || ''; }).catch(() => {}).finally(openModal);
  }

  // run after boot() has built the map; chain behind the 911 safety ack if it is still open
  window.initTeam = function initTeam() {
    if (!new URLSearchParams(location.search).get('team')) return;
    const safety = document.getElementById('safety-modal');
    if (safety && !safety.hidden) {
      const ack = document.getElementById('safety-ack');
      if (ack) { ack.addEventListener('click', start, { once: true }); return; }
    }
    start();
  };
})();
