'use strict';

/* ---------- live team location sharing ----------
   Opt-in only. A team is private and reachable only via its unguessable UUID link. Members
   share their live location; viewers watch without sharing (but still appear in the roster and
   must set a handle). All live state lives in a Cloudflare Durable Object relay
   (functions/api/team/*), never in this repo. Secure-context (HTTPS/localhost) only — geolocation
   requires it and the LAN http board carries no relay route.

   First-class home is the "Team" tab (create/join when out; roster + status + controls when in).
   Team map markers render regardless of the active tab; the drop control is a member-only map FAB. */

(function () {
  const POLL_MS = 15000;   // GET team state cadence
  const POST_MS = 15000;   // publish own position cadence (breadcrumb ~every 15s)
  const HANDLE_MIN = 4;
  const STALE_MS = 90000;  // grey a member marker after this long with no update
  const SELF_TRAIL_MAX = 400;
  const eidKey = (id) => `respondertx.team.eid.${id}`;

  // SAR picklists — mirror the DO's authoritative allow-sets (workers/team-relay/team-relay.js)
  const MTYPES = ['ground', 'k9'];
  const STATUSES = ['infield', 'standby', 'unavailable'];
  const SPECIALTIES = ['searcher', 'medical', 'support', 'drone', 'comms', 'swiftwater', 'command', 'logistics'];
  const K9_SKILLS = ['live-find', 'trailing', 'cadaver', 'area', 'water', 'evidence', 'avalanche'];
  const MARKER_KINDS = ['waypoint', 'hazard', 'search-area'];
  const MARKER_GLYPH = { waypoint: '📍', hazard: '⚠️', 'search-area': '▧' };

  const T = {
    id: null, name: '', role: null, ephemeralId: null, pid: null, handle: '',
    mtype: null, specialty: null, k9Name: '', skills: [], status: null,
    watchId: null, pollTimer: null, postTimer: null,
    layer: null, markerLayer: null, markers: {}, teamMarkers: {},
    lastMembers: [], lastViewers: [], lastMarkers: [], defaults: null, appliedDefaults: false,
    facilities: null, mapWired: false,
    selfTrail: [], selfPos: null, active: false,
  };

  const api = (path, opts) => fetch(`/api/team/${path}`, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));

  function tt(key, fallback) { const s = window.t ? t(key) : key; return s === key ? fallback : s; }
  const typeLabel = (m) => tt(`team.type.${m}`, m === 'k9' ? 'K9 handler' : 'Ground member');
  const spLabel = (s) => tt(`team.sp.${s}`, s);
  const stLabel = (s) => tt(`team.st.${s}`, s);
  const kindLabel = (k) => tt(`team.kind.${k}`, k);

  /* ---------- map layer ---------- */

  function ensureLayer() {
    if (T.layer) return;
    if (!state.map.getPane('team')) {
      state.map.createPane('team');
      state.map.getPane('team').style.zIndex = 640; // above hazard markers (600), below popups
    }
    T.layer = L.layerGroup().addTo(state.map);       // member markers + trails
    T.markerLayer = L.layerGroup().addTo(state.map);  // shared team-dropped markers
  }

  function memberIcon(m, color, isSelf, stale) {
    const st = STATUSES.includes(m.status) ? m.status : 'infield';
    const cls = `team-marker team-st-${st}${isSelf ? ' team-self' : ''}${stale ? ' team-stale' : ''}`;
    const k9 = m.mtype === 'k9';
    const dot = k9 ? '<span class="tm-dot tm-dot-k9">🐕</span>' : '<span class="tm-dot"></span>';
    const dogName = k9 && m.k9Name ? ` ${esc(m.k9Name)}` : '';
    return L.divIcon({
      className: '',
      html: `<div class="${cls}" style="--tc:${color || '#40c4ff'}">${dot}<span class="tm-label">${esc(m.handle)}${dogName}${isSelf ? ' ·' + esc(tt('team.you', 'you')) : ''}</span></div>`,
      iconSize: [14, 14], iconAnchor: [7, 7],
    });
  }

  // renders the cached server roster with the local self-fix overlaid, so a poll that predates
  // the server echoing our own position never wipes our self-marker, and a self GPS tick never
  // wipes other members' markers
  function renderAll() {
    ensureLayer();
    const members = (T.lastMembers || []).slice();
    if (T.role === 'member' && T.selfPos && !members.some((m) => m.pid === T.pid)) {
      members.push({ pid: T.pid, handle: T.handle, color: selfColor(), lastPos: null, lastSeen: Date.now(), trail: [], mtype: T.mtype, k9Name: T.k9Name, status: T.status });
    }
    const seen = {};
    for (const m of members) {
      const isSelf = m.pid === T.pid;
      const pos = isSelf && T.selfPos ? { lat: T.selfPos.lat, lon: T.selfPos.lon } : m.lastPos;
      if (!pos) continue;
      seen[m.pid] = true;
      const color = isSelf ? selfColor() : m.color;
      const stale = !isSelf && Date.now() - (m.lastSeen || 0) > STALE_MS;
      // self-fix overlays the cached record so a fresh GPS tick shows the latest type/status
      const mm = isSelf ? Object.assign({}, m, { mtype: T.mtype || m.mtype, k9Name: T.k9Name || m.k9Name, status: T.status || m.status, handle: T.handle || m.handle }) : m;
      const ll = [pos.lat, pos.lon];
      let entry = T.markers[m.pid];
      if (!entry) {
        entry = {
          marker: L.marker(ll, { pane: 'team', icon: memberIcon(mm, color, isSelf, stale), zIndexOffset: isSelf ? 1000 : 0, interactive: false }),
          trail: L.polyline([], { pane: 'team', color: color || '#40c4ff', weight: 3, opacity: 0.65 }),
        };
        entry.trail.addTo(T.layer);
        entry.marker.addTo(T.layer);
        T.markers[m.pid] = entry;
      } else {
        entry.marker.setLatLng(ll);
        entry.marker.setIcon(memberIcon(mm, color, isSelf, stale));
      }
      // self draws its own responsive full-res trail; others render the server's capped copy
      const pts = isSelf && T.selfTrail.length ? T.selfTrail : (m.trail || []).map((p) => [p.lat, p.lon]);
      entry.trail.setLatLngs(pts);
    }
    for (const id of Object.keys(T.markers)) {
      if (!seen[id]) { T.layer.removeLayer(T.markers[id].marker); T.layer.removeLayer(T.markers[id].trail); delete T.markers[id]; }
    }
  }

  /* ---------- shared team markers (waypoint / hazard / search-area) ---------- */

  function teamMarkerIcon(mk) {
    const g = MARKER_GLYPH[mk.kind] || '📍';
    return L.divIcon({
      className: '',
      html: `<div class="team-tm team-tm-${mk.kind}"><span class="ttm-glyph">${g}</span>${mk.label ? `<span class="ttm-label">${esc(mk.label)}</span>` : ''}</div>`,
      iconSize: [18, 18], iconAnchor: [9, 18],
    });
  }

  function markerPopupHtml(mk) {
    const canRemove = T.role === 'member';
    return `<div class="ttm-pop"><strong>${esc(kindLabel(mk.kind))}</strong>${mk.label ? `: ${esc(mk.label)}` : ''}<br>` +
      `<span class="ttm-by">${esc(tt('team.marker.by', 'dropped by'))} ${esc(mk.by || '?')} · ${esc(ageStr(mk.ts))} ${esc(tt('team.ago', 'ago'))}</span>` +
      (canRemove ? `<br><button class="ttm-del" data-mid="${esc(mk.id)}">${esc(tt('team.marker.remove', 'Remove marker'))}</button>` : '') + '</div>';
  }

  function renderTeamMarkers() {
    ensureLayer();
    const seen = {};
    for (const mk of (T.lastMarkers || [])) {
      seen[mk.id] = true;
      let entry = T.teamMarkers[mk.id];
      const ll = [mk.lat, mk.lon];
      if (!entry) {
        const marker = L.marker(ll, { pane: 'team', icon: teamMarkerIcon(mk), zIndexOffset: 200 });
        marker.bindPopup(markerPopupHtml(mk));
        marker.on('popupopen', (e) => {
          const btn = e.popup.getElement() && e.popup.getElement().querySelector('.ttm-del');
          if (btn) btn.addEventListener('click', () => removeMarker(btn.dataset.mid));
        });
        marker.addTo(T.markerLayer);
        T.teamMarkers[mk.id] = { marker, kind: mk.kind, label: mk.label };
      } else if (entry.kind !== mk.kind || entry.label !== mk.label) {
        entry.marker.setIcon(teamMarkerIcon(mk));
        entry.marker.setPopupContent(markerPopupHtml(mk));
        entry.kind = mk.kind; entry.label = mk.label;
      }
    }
    for (const id of Object.keys(T.teamMarkers)) {
      if (!seen[id]) { T.markerLayer.removeLayer(T.teamMarkers[id].marker); delete T.teamMarkers[id]; }
    }
  }

  // Waze-style member-only map control (bottom-right): drops a shared marker at the map center
  function ensureDropFab() {
    if (document.getElementById('team-drop-fab')) return;
    const map = document.getElementById('map');
    if (!map) return;
    const btn = document.createElement('button');
    btn.id = 'team-drop-fab';
    btn.type = 'button';
    btn.hidden = true;
    btn.title = tt('team.drop.title', 'Drop a shared team marker at the map center');
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = '<span class="tdf-glyph">📍</span><span class="tdf-plus">＋</span>';
    btn.addEventListener('click', () => {
      if (!(T.active && T.role === 'member') || !state.map) return;
      openDropModal(state.map.getCenter());
    });
    map.appendChild(btn);
  }

  function updateDropFab() {
    const fab = document.getElementById('team-drop-fab');
    if (fab) fab.hidden = !(T.active && T.role === 'member');
  }

  function openDropModal(latlng) {
    buildDropModal();
    const m = document.getElementById('team-drop');
    m.dataset.lat = latlng.lat; m.dataset.lon = latlng.lng;
    m._kind = 'waypoint';
    m.querySelectorAll('.tp-seg[data-val]').forEach((b) => b.classList.toggle('on', b.dataset.val === 'waypoint'));
    document.getElementById('team-drop-label').value = '';
    document.getElementById('team-drop-err').hidden = true;
    m.hidden = false;
    setTimeout(() => document.getElementById('team-drop-label').focus(), 50);
  }

  async function submitDrop() {
    const m = document.getElementById('team-drop');
    const lat = Number(m.dataset.lat), lon = Number(m.dataset.lon);
    const kind = m._kind || 'waypoint';
    const label = document.getElementById('team-drop-label').value.trim();
    const err = document.getElementById('team-drop-err');
    const go = document.getElementById('team-drop-go');
    go.disabled = true;
    try {
      const r = await api(`${T.id}/marker`, { method: 'POST', body: JSON.stringify({ ephemeralId: T.ephemeralId, kind, label, lat, lon }) });
      const data = await r.json();
      if (!r.ok) { err.textContent = data.error || tt('team.drop.fail', 'Could not drop the marker.'); err.hidden = false; go.disabled = false; return; }
      if (data.marker) { T.lastMarkers = (T.lastMarkers || []).filter((x) => x.id !== data.marker.id).concat(data.marker); renderTeamMarkers(); }
      m.hidden = true;
      go.disabled = false;
    } catch {
      err.textContent = tt('team.drop.fail', 'Could not drop the marker.'); err.hidden = false; go.disabled = false;
    }
  }

  async function removeMarker(mid) {
    if (!mid) return;
    T.lastMarkers = (T.lastMarkers || []).filter((x) => x.id !== mid);
    renderTeamMarkers();
    try { await api(`${T.id}/unmark`, { method: 'POST', body: JSON.stringify({ ephemeralId: T.ephemeralId, markerId: mid }) }); } catch { /* next poll reconciles */ }
  }

  function buildDropModal() {
    if (document.getElementById('team-drop')) return;
    const el = document.createElement('div');
    el.id = 'team-drop';
    el.hidden = true;
    const segs = MARKER_KINDS.map((k) => `<button type="button" class="tp-seg" data-val="${k}">${esc(MARKER_GLYPH[k])} ${esc(kindLabel(k))}</button>`).join('');
    el.innerHTML =
      '<div class="modal-box team-box">' +
      `<div class="modal-head"><strong>${esc(tt('team.drop.head', 'Drop a team marker'))}</strong>` +
      `<button id="team-drop-close" title="${esc(tt('team.cancel', 'Cancel'))}">✕</button></div>` +
      '<div class="team-body">' +
      `<p class="tp-dropnote">${esc(tt('team.drop.center', 'Placing at the current map center. Pan the map first to reposition.'))}</p>` +
      `<div class="tp-field"><label>${esc(tt('team.drop.kind', 'Marker type'))}</label><div class="tp-seggroup" id="team-drop-kinds">${segs}</div></div>` +
      `<input id="team-drop-label" maxlength="60" autocomplete="off" placeholder="${esc(tt('team.drop.label.ph', 'Short label (optional)'))}">` +
      '<div id="team-drop-err" class="team-err" hidden></div>' +
      `<div class="team-btnrow"><button id="team-drop-go" class="primary">${esc(tt('team.drop.go', 'Place marker'))}</button></div>` +
      '</div></div>';
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target.id === 'team-drop') el.hidden = true; });
    document.getElementById('team-drop-close').addEventListener('click', () => { el.hidden = true; });
    document.getElementById('team-drop-kinds').addEventListener('click', (e) => {
      const b = e.target.closest('.tp-seg'); if (!b) return;
      el._kind = b.dataset.val;
      el.querySelectorAll('.tp-seg').forEach((x) => x.classList.toggle('on', x === b));
    });
    document.getElementById('team-drop-go').addEventListener('click', submitDrop);
  }

  function applyDefaults() {
    if (T.appliedDefaults || !T.defaults || !state.map) return;
    const d = T.defaults;
    if (Number.isFinite(d.lat) && Number.isFinite(d.lon)) {
      state.map.setView([d.lat, d.lon], Number.isFinite(d.zoom) ? d.zoom : state.map.getZoom());
      T.appliedDefaults = true;
    }
  }

  /* ---------- roster helpers ---------- */

  function ageStr(lastSeen) {
    const s = Math.max(0, Math.round((Date.now() - lastSeen) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${Math.round(s / 3600)}h`;
  }

  // profile chips shown under a member's name: type/specialty (+ K9 name) and skill tags
  function memberMeta(m) {
    if (m.mtype === 'k9') {
      const dog = m.k9Name ? ` · ${esc(m.k9Name)}` : '';
      const sk = (m.skills || []).length
        ? `<span class="tp-skills">${m.skills.map((s) => `<span class="tp-skill">${esc(s)}</span>`).join('')}</span>` : '';
      return `<span class="tp-type tp-k9">🐕 ${esc(tt('team.type.k9short', 'K9'))}${dog}</span>${sk}`;
    }
    if (m.specialty) return `<span class="tp-type">${esc(spLabel(m.specialty))}</span>`;
    return '';
  }

  function statusChip(m) {
    const st = STATUSES.includes(m.status) ? m.status : 'infield';
    return `<span class="tp-status tp-st-${st}">${esc(stLabel(st))}</span>`;
  }

  /* ---------- Team tab: landing / join / roster ---------- */

  function teamHost() { return document.getElementById('team-tab-body'); }

  function showTeamTab() {
    const btn = document.querySelector('.tabs button[data-tab="tab-team"]');
    if (btn) btn.click();
  }

  // active team → Team becomes the far-left tab (before Feed); restore to last on leave. idempotent.
  function updateTeamTabOrder() {
    const tabsEl = document.querySelector('.tabs');
    const btn = tabsEl && tabsEl.querySelector('button[data-tab="tab-team"]');
    if (!tabsEl || !btn) return;
    if (T.active) {
      if (tabsEl.firstElementChild !== btn) tabsEl.prepend(btn);
    } else if (tabsEl.lastElementChild !== btn) {
      tabsEl.appendChild(btn); // Team was originally the last tab
    }
  }

  function updateTeamCount(n) {
    const c = document.getElementById('team-count');
    if (c) {
      if (T.active && n > 0) { c.textContent = String(n); c.hidden = false; } else c.hidden = true;
    }
    updateTeamTabOrder();
  }

  function renderTeamTab() {
    const host = teamHost();
    if (!host) return;
    if (!window.isSecureContext) { renderInsecure(host); return; }
    if (T.active) renderRosterShell(host);
    else if (T.id) renderJoin(host);
    else renderLanding(host);
  }

  function renderInsecure(host) {
    host.innerHTML =
      '<div class="tt-hero"><div class="tt-hero-icon">🧭</div>' +
      `<h2 class="tt-title">${esc(tt('team.tab.title', 'Live team'))}</h2>` +
      `<p class="tt-lead">${esc(tt('team.needhttps', 'Live team sharing needs the secure site: https://responder.rfxn.com'))}</p></div>`;
  }

  function renderLanding(host) {
    host.innerHTML =
      '<div class="tt-hero"><div class="tt-hero-icon">🧭</div>' +
      `<h2 class="tt-title">${esc(tt('team.tab.title', 'Live team'))}</h2>` +
      `<p class="tt-lead">${esc(tt('team.tab.lead', 'Share live locations with your crew on a private, link-only team. No account, nothing saved.'))}</p></div>` +
      '<div class="tt-card">' +
      `<h3 class="tt-h3">${esc(tt('team.create.head', 'Create a team'))}</h3>` +
      `<p class="tt-note">${esc(tt('team.create.desc', 'Creates a private team with an unguessable link. Anyone you send the link to can join as a member (shares location) or a viewer (watch only). No account needed.'))}</p>` +
      `<input id="team-create-name" class="tt-input" maxlength="40" autocomplete="off" placeholder="${esc(tt('team.create.ph', 'Team name (optional)'))}">` +
      `<label class="tp-check"><input type="checkbox" id="team-create-ao"> ${esc(tt('team.create.ao', "Set the current map view as the team's default area (loads for members)"))}</label>` +
      '<div id="team-create-err" class="team-err" hidden></div>' +
      `<button id="team-create-go" class="tt-btn tt-btn-primary">${esc(tt('team.create.go', 'Create team'))}</button>` +
      '<div id="team-create-result" hidden></div>' +
      '</div>' +
      `<div class="team-or">${esc(tt('team.or', 'or'))}</div>` +
      '<div class="tt-card">' +
      `<h3 class="tt-h3">${esc(tt('team.join.link.lbl', 'Have a team link?'))}</h3>` +
      `<input id="team-join-link" class="tt-input" autocomplete="off" placeholder="${esc(tt('team.join.link.ph', 'Paste team link or code'))}">` +
      '<div id="team-join-err" class="team-err" hidden></div>' +
      `<button id="team-join-open" class="tt-btn">${esc(tt('team.join.link.go', 'Open team →'))}</button>` +
      '</div>';
    host.querySelector('#team-create-go').addEventListener('click', doCreate);
    host.querySelector('#team-join-open').addEventListener('click', doJoinLink);
    const jl = host.querySelector('#team-join-link');
    jl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoinLink(); });
  }

  function renderJoin(host) {
    const titled = T.name ? `${tt('team.join.head', 'Join team')}: ${T.name}` : tt('team.join.head', 'Join team');
    host.innerHTML =
      '<div class="tt-card tt-join">' +
      `<button class="tt-back" id="team-join-back">← ${esc(tt('team.back', 'Not now'))}</button>` +
      `<h2 class="tt-title">${esc(titled)}</h2>` +
      `<p class="tt-lead" id="team-consent">${tt('team.consent', 'You are about to share your <strong>live location</strong> with everyone who has this team\'s link. Only join a team you trust.')}</p>` +
      `<label class="tt-label" for="team-tab-handle">${esc(tt('team.handle.lbl', 'Your handle / call sign'))}</label>` +
      `<input id="team-tab-handle" class="tt-input" maxlength="24" autocomplete="off" placeholder="${esc(tt('team.handle.ph', 'Handle / call sign (min 4 characters)'))}">` +
      `<div class="tp-profile" id="team-join-profile"><div class="tp-profile-cap">${esc(tt('team.profile.cap', 'Your role (applies when you share location):'))}</div>` +
      profileFieldsHtml('tj') + '</div>' +
      '<div id="team-tab-err" class="team-err" hidden></div>' +
      '<div class="tt-joinbtns">' +
      `<button id="team-join-member" class="tt-btn tt-btn-primary" disabled>${esc(tt('team.join.member', '📍 Join & share my location'))}</button>` +
      `<button id="team-join-viewer" class="tt-btn tt-btn-ghost" disabled>${esc(tt('team.join.viewer', '👁 Join as viewer (watch only)'))}</button>` +
      '</div>' +
      `<p class="tt-foot">${esc(tt('team.foot', 'No account, no login. Your handle is not stored beyond this team and expires automatically. Foreground, screen-on only.'))}</p>` +
      '</div>';
    wireProfileFields(host, 'tj');
    const h = host.querySelector('#team-tab-handle');
    h.addEventListener('input', syncJoinButtons);
    h.addEventListener('keydown', (e) => { if (e.key === 'Enter' && h.value.trim().length >= HANDLE_MIN) join('member'); });
    host.querySelector('#team-join-member').addEventListener('click', () => join('member'));
    host.querySelector('#team-join-viewer').addEventListener('click', () => join('viewer'));
    host.querySelector('#team-join-back').addEventListener('click', backToLanding);
    syncJoinButtons();
  }

  function renderRosterShell(host) {
    host.innerHTML =
      '<div class="tt-roster">' +
      '<div class="tt-rhead">' +
      `<div class="tt-rtitle"><span class="tt-rteam">👥 ${esc(T.name || tt('team.panel.head', 'Team'))}</span>` +
      `<span class="tt-rcount" id="team-rcount"></span></div>` +
      `<button id="team-share" class="tt-btn tt-btn-ghost tt-btn-sm" title="${esc(tt('team.copylink', 'Copy the team link'))}">🔗 ${esc(tt('team.copy', 'Copy link'))}</button>` +
      '</div>' +
      '<div class="tt-youbar" id="team-youbar"></div>' +
      `<div class="tt-listcap">${esc(tt('team.panel.head', 'Team'))}</div>` +
      '<div class="tp-list"></div>' +
      '<div class="tt-controls">' +
      `<button id="team-fac-btn" class="tt-btn tt-btn-ghost">🏥 ${esc(tt('team.fac.btn', 'Nearby'))}</button>` +
      `<button id="team-leave" class="tt-btn tt-btn-danger">${esc(T.role === 'member' ? tt('team.stop', '⏻ Stop sharing & leave') : tt('team.leave', '⏻ Leave team'))}</button>` +
      '</div>' +
      '<div class="tp-facilities" hidden></div>' +
      `<div class="tt-foot">${esc(tt('team.panel.note', 'Positions are ephemeral, private to this link, and never saved.'))}</div>` +
      '</div>';
    host.querySelector('#team-leave').addEventListener('click', leave);
    host.querySelector('#team-share').addEventListener('click', () => {
      const url = `${location.origin}/?team=${T.id}`;
      const btn = document.getElementById('team-share');
      const orig = btn.innerHTML;
      copyText(url).then(() => { btn.textContent = '✓ ' + tt('team.copied', 'Copied ✓'); setTimeout(() => { btn.innerHTML = orig; }, 1500); }, () => prompt('Copy team link:', url));
    });
    host.querySelector('#team-fac-btn').addEventListener('click', toggleFacilities);
    ensureDropFab();
    renderRoster({ members: T.lastMembers || [], viewers: T.lastViewers || [] });
  }

  // prominent self-status control at the top of the roster (the owner's "your status control")
  function renderYouBar() {
    const host = teamHost();
    const bar = host && host.querySelector('#team-youbar');
    if (!bar) return;
    const isMember = T.role === 'member';
    const stSeg = isMember ? STATUSES.map((s) => `<button type="button" class="tt-stbtn tp-st-${s}${T.status === s ? ' on' : ''}" data-st="${s}">${esc(stLabel(s))}</button>`).join('') : '';
    bar.innerHTML =
      '<div class="tt-youline">' +
      `<span class="tt-swatch" style="background:${esc(isMember ? selfColor() : '#7a8899')}">${isMember ? '' : '👁'}</span>` +
      `<span class="tt-youname">${esc(T.handle || '')}</span><span class="tp-tag">${esc(tt('team.you', 'you'))}</span>` +
      `<button class="tt-edit" id="team-edit-btn" title="${esc(tt('team.edit', 'Edit my role, type & status'))}">✎ ${esc(tt('team.edit.short', 'Edit'))}</button>` +
      '</div>' +
      (isMember
        ? `<div class="tt-statusrow" id="team-statusrow">${stSeg}</div>`
        : `<div class="tt-viewnote">${esc(tt('team.viewer.note', 'Watching only. You are not sharing a location.'))}</div>`);
    const sr = bar.querySelector('#team-statusrow');
    if (sr) sr.addEventListener('click', (e) => { const b = e.target.closest('.tt-stbtn'); if (b && b.dataset.st !== T.status) doUpdateSelf({ status: b.dataset.st }); });
    bar.querySelector('#team-edit-btn').addEventListener('click', openEdit);
  }

  function renderRoster(data) {
    const host = teamHost();
    if (!host) return;
    const list = host.querySelector('.tp-list');
    if (!list) return;
    const members = data.members || [], viewers = data.viewers || [];
    const rows = [];
    for (const m of members) {
      if (m.pid === T.pid) continue; // self lives in the you-bar
      const hasFix = !!m.lastPos;
      const stale = Date.now() - (m.lastSeen || 0) > STALE_MS;
      const swColor = m.color || '#40c4ff';
      rows.push(`<div class="tp-row tp-mrow${stale ? ' tp-stale' : ''}">
        <span class="tp-sw" style="background:${esc(swColor)}"></span>
        <div class="tp-main">
          <div class="tp-line1"><span class="tp-name">${esc(m.handle)}</span>
          <span class="tp-age">${hasFix ? tt('team.seen', 'seen') + ' ' + ageStr(m.lastSeen || Date.now()) : tt('team.nofix', 'no fix')}</span></div>
          <div class="tp-line2">${statusChip(m)}${memberMeta(m)}</div>
        </div>
      </div>`);
    }
    for (const v of viewers) {
      if (v.pid === T.pid) continue;
      rows.push(`<div class="tp-row tp-viewer">
        <span class="tp-sw tp-sw-eye">👁</span>
        <span class="tp-name">${esc(v.handle)}</span>
        <span class="tp-age">${esc(tt('team.viewer', 'viewer'))}</span>
      </div>`);
    }
    list.innerHTML = rows.join('') || `<div class="tp-empty">${esc(tt('team.alone', 'No one else here yet. Share the link to bring your crew in.'))}</div>`;
    const c = host.querySelector('#team-rcount');
    if (c) c.textContent = `${members.length} ${tt('team.members', 'members')} · ${viewers.length} ${tt('team.viewers', 'viewers')}`;
    renderYouBar();
    updateDropFab();
    updateTeamCount(members.length + viewers.length);
  }

  function backToLanding() {
    T.id = null; T.name = '';
    try { history.replaceState(null, '', location.pathname); } catch { /* sandboxed — cosmetic */ }
    renderTeamTab();
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
      T.lastViewers = data.viewers || [];
      T.lastMarkers = data.markers || [];
      if (data.defaults && !T.defaults) T.defaults = data.defaults;
      applyDefaults();
      renderAll();
      renderTeamMarkers();
      renderRoster(data);
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

  function syncJoinButtons() {
    const host = teamHost();
    const h = host && host.querySelector('#team-tab-handle');
    if (!h) return;
    const ok = h.value.trim().length >= HANDLE_MIN;
    const m = host.querySelector('#team-join-member'), v = host.querySelector('#team-join-viewer');
    if (m) m.disabled = !ok;
    if (v) v.disabled = !ok;
  }

  function joinErr(msg) {
    const host = teamHost();
    const e = host && host.querySelector('#team-tab-err');
    if (e) { e.textContent = msg; e.hidden = !msg; }
  }

  function setJoinBusy(on) {
    const host = teamHost();
    if (!host) return;
    host.querySelectorAll('.tt-join button').forEach((b) => { b.disabled = on; });
    if (!on) syncJoinButtons();
  }

  async function join(role) {
    const host = teamHost();
    const handleEl = host && host.querySelector('#team-tab-handle');
    if (!handleEl) return;
    const handle = handleEl.value.trim();
    if (handle.length < HANDLE_MIN) { joinErr(tt('team.handleshort', `Handle must be at least ${HANDLE_MIN} characters.`)); return; }
    let ephemeralId = null;
    try { ephemeralId = localStorage.getItem(eidKey(T.id)); } catch { /* private mode */ }
    joinErr('');
    setJoinBusy(true);
    const profile = role === 'member' ? readProfileFields(host, 'tj') : {};
    try {
      const r = await api(`${T.id}/join`, { method: 'POST', body: JSON.stringify(Object.assign({ handle, role, ephemeralId }, profile)) });
      const data = await r.json();
      if (!r.ok) { joinErr(data.error || tt('team.joinfail', 'Could not join this team.')); setJoinBusy(false); return; }
      storeSelf(data.you);
      T.name = data.name || '';
      if (data.defaults && !T.defaults) T.defaults = data.defaults;
      try { localStorage.setItem(eidKey(T.id), T.ephemeralId); } catch { /* private mode — reload starts a fresh member */ }
      T.active = true;
      renderTeamTab();
      applyDefaults();
      if (T.role === 'member') startSharing();
      poll();
      T.pollTimer = setInterval(poll, POLL_MS);
    } catch {
      joinErr(tt('team.joinfail', 'Could not join this team.'));
      setJoinBusy(false);
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
    if (T.markerLayer) { T.markerLayer.clearLayers(); }
    T.markers = {}; T.teamMarkers = {}; T.lastMembers = []; T.lastViewers = []; T.lastMarkers = [];
    T.selfTrail = []; T.selfPos = null; T.facilities = null;
    T.mtype = null; T.specialty = null; T.k9Name = ''; T.skills = []; T.status = null;
    T.id = null; T.name = '';
    updateDropFab();
    updateTeamCount(0);
  }

  // cache the DO's authoritative view of our own record after join/update
  function storeSelf(you) {
    if (!you) return;
    T.role = you.role;
    T.handle = you.handle;
    T.ephemeralId = you.ephemeralId; // secret write credential — never rendered, only sent on writes
    T.pid = you.pid;                 // public id — used to self-detect in the roster/markers
    T.mtype = you.mtype || null;
    T.specialty = you.specialty || null;
    T.k9Name = you.k9Name || '';
    T.skills = you.skills || [];
    T.status = you.status || null;
    if (you.color) _selfColor = you.color;
  }

  // change my own record after joining (role / type / specialty / skills / status)
  async function doUpdateSelf(patch) {
    if (!T.active || !T.ephemeralId) return;
    const wasMember = T.role === 'member';
    try {
      const r = await api(`${T.id}/update`, { method: 'POST', body: JSON.stringify(Object.assign({ ephemeralId: T.ephemeralId }, patch)) });
      const data = await r.json();
      if (!r.ok) { note(data.error || tt('team.updatefail', 'Could not update your profile.')); return false; }
      storeSelf(data.you);
      if (T.role === 'member' && !wasMember) startSharing();
      if (T.role !== 'member' && wasMember) { stopWatch(); T.selfPos = null; T.selfTrail = []; }
      renderYouBar();
      updateDropFab();
      poll();
      return true;
    } catch { note(tt('team.updatefail', 'Could not update your profile.')); return false; }
  }

  async function leave() {
    const eid = T.ephemeralId;
    teardown();
    renderTeamTab();
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

  function note(msg) {
    const el = document.getElementById('refresh-note');
    if (el) el.textContent = msg;
  }

  /* ---------- reusable SAR profile fields (join + edit) ---------- */

  // p is an id-prefix ('tj' join, 'te' edit) so the two forms can coexist in the DOM
  function profileFieldsHtml(p) {
    const typeSeg = MTYPES.map((mt) => `<button type="button" class="tp-seg" data-val="${mt}">${esc(typeLabel(mt))}</button>`).join('');
    const spOpts = [`<option value="">${esc(tt('team.sp.none', 'Pick a specialty…'))}</option>`]
      .concat(SPECIALTIES.map((s) => `<option value="${s}">${esc(spLabel(s))}</option>`)).join('');
    const stSeg = STATUSES.map((s) => `<button type="button" class="tp-seg tp-st-${s}" data-val="${s}">${esc(stLabel(s))}</button>`).join('');
    const skillChips = K9_SKILLS.map((s) => `<button type="button" class="tp-skillchip" data-skill="${esc(s)}">${esc(s)}</button>`).join('');
    return (
      `<div class="tp-field"><label>${esc(tt('team.field.type', 'Member type'))}</label>` +
      `<div class="tp-seggroup" data-group="mtype">${typeSeg}</div></div>` +
      `<div class="tp-field ${p}-ground"><label>${esc(tt('team.field.specialty', 'Specialty'))}</label>` +
      `<select class="tp-select" id="${p}-specialty">${spOpts}</select></div>` +
      `<div class="tp-field ${p}-k9" hidden><label>${esc(tt('team.field.k9name', 'K9 name'))}</label>` +
      `<input class="tp-input" id="${p}-k9name" maxlength="24" autocomplete="off" placeholder="${esc(tt('team.field.k9name.ph', 'Dog\'s name'))}"></div>` +
      `<div class="tp-field ${p}-k9" hidden><label>${esc(tt('team.field.skills', 'K9 skills'))}</label>` +
      `<div class="tp-skillrow" data-group="skills">${skillChips}</div></div>` +
      `<div class="tp-field"><label>${esc(tt('team.field.status', 'Status'))}</label>` +
      `<div class="tp-seggroup" data-group="status">${stSeg}</div></div>`
    );
  }

  const segSet = (root, group, val) => root.querySelectorAll(`.tp-seggroup[data-group="${group}"] .tp-seg`).forEach((b) => b.classList.toggle('on', b.dataset.val === val));
  function segGet(root, group, fallback) {
    const b = root.querySelector(`.tp-seggroup[data-group="${group}"] .tp-seg.on`);
    return b ? b.dataset.val : fallback;
  }
  function applyTypeVis(root, p) {
    const mt = segGet(root, 'mtype', 'ground');
    root.querySelectorAll(`.${p}-ground`).forEach((e) => { e.hidden = mt !== 'ground'; });
    root.querySelectorAll(`.${p}-k9`).forEach((e) => { e.hidden = mt !== 'k9'; });
  }
  function wireProfileFields(root, p) {
    root.querySelectorAll('.tp-seggroup').forEach((g) => {
      g.addEventListener('click', (e) => {
        const b = e.target.closest('.tp-seg'); if (!b) return;
        segSet(root, g.dataset.group, b.dataset.val);
        if (g.dataset.group === 'mtype') applyTypeVis(root, p);
      });
    });
    root.querySelectorAll('.tp-skillchip').forEach((c) => c.addEventListener('click', () => c.classList.toggle('on')));
    segSet(root, 'mtype', 'ground'); segSet(root, 'status', 'infield'); applyTypeVis(root, p);
  }
  function readProfileFields(root, p) {
    const mtype = segGet(root, 'mtype', 'ground');
    const out = { mtype, status: segGet(root, 'status', 'infield') };
    if (mtype === 'k9') {
      out.k9Name = (root.querySelector(`#${p}-k9name`).value || '').trim();
      out.skills = Array.from(root.querySelectorAll('.tp-skillchip.on')).map((c) => c.dataset.skill);
    } else {
      out.specialty = root.querySelector(`#${p}-specialty`).value || '';
    }
    return out;
  }
  function setProfileFields(root, p, prof) {
    const mt = MTYPES.includes(prof.mtype) ? prof.mtype : 'ground';
    segSet(root, 'mtype', mt);
    segSet(root, 'status', STATUSES.includes(prof.status) ? prof.status : 'infield');
    applyTypeVis(root, p);
    if (mt === 'k9') {
      root.querySelector(`#${p}-k9name`).value = prof.k9Name || '';
      const sk = new Set(prof.skills || []);
      root.querySelectorAll('.tp-skillchip').forEach((c) => c.classList.toggle('on', sk.has(c.dataset.skill)));
    } else {
      root.querySelector(`#${p}-specialty`).value = prof.specialty || '';
    }
  }

  /* ---------- edit-my-profile modal (role / type / status after joining) ---------- */

  function buildEditModal() {
    if (document.getElementById('team-edit')) return;
    const el = document.createElement('div');
    el.id = 'team-edit';
    el.hidden = true;
    const roleSeg = [['member', tt('team.role.member', '📍 Member (shares)')], ['viewer', tt('team.role.viewer', '👁 Viewer')]]
      .map(([v, l]) => `<button type="button" class="tp-seg" data-val="${v}">${esc(l)}</button>`).join('');
    el.innerHTML =
      '<div class="modal-box team-box">' +
      `<div class="modal-head"><strong>${esc(tt('team.edit.head', 'Edit my role & status'))}</strong>` +
      `<button id="team-edit-close" title="${esc(tt('team.cancel', 'Cancel'))}">✕</button></div>` +
      '<div class="team-body">' +
      `<div class="tp-field"><label>${esc(tt('team.field.role', 'Role'))}</label><div class="tp-seggroup" data-group="erole">${roleSeg}</div></div>` +
      `<div class="tp-profile" id="team-edit-profile">${profileFieldsHtml('te')}</div>` +
      '<div id="team-edit-err" class="team-err" hidden></div>' +
      `<div class="team-btnrow"><button id="team-edit-save" class="primary">${esc(tt('team.edit.save', 'Save'))}</button></div>` +
      '</div></div>';
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target.id === 'team-edit') el.hidden = true; });
    document.getElementById('team-edit-close').addEventListener('click', () => { el.hidden = true; });
    wireProfileFields(el, 'te');
    el.querySelector('.tp-seggroup[data-group="erole"]').addEventListener('click', (e) => {
      const b = e.target.closest('.tp-seg'); if (!b) return;
      segSet(el, 'erole', b.dataset.val);
      document.getElementById('team-edit-profile').hidden = b.dataset.val !== 'member';
    });
    document.getElementById('team-edit-save').addEventListener('click', saveEdit);
  }

  function openEdit() {
    buildEditModal();
    const el = document.getElementById('team-edit');
    segSet(el, 'erole', T.role || 'member');
    setProfileFields(el, 'te', { mtype: T.mtype, specialty: T.specialty, k9Name: T.k9Name, skills: T.skills, status: T.status });
    document.getElementById('team-edit-profile').hidden = (T.role || 'member') !== 'member';
    document.getElementById('team-edit-err').hidden = true;
    el.hidden = false;
  }

  async function saveEdit() {
    const el = document.getElementById('team-edit');
    const role = segGet(el, 'erole', 'member');
    const patch = { role };
    if (role === 'member') Object.assign(patch, readProfileFields(el, 'te'));
    const ok = await doUpdateSelf(patch);
    if (ok) el.hidden = true;
  }

  /* ---------- nearest facilities (ask: vet ER for K9 + trauma ER) ---------- */

  // AO center: team default if set, else current map center. Facility designation (trauma level /
  // 24h emergency) is NOT in the free source — labelled honestly, never asserted. See report.
  function facilityCenter() {
    if (T.defaults && Number.isFinite(T.defaults.lat)) return { lat: T.defaults.lat, lon: T.defaults.lon };
    if (state.map) { const c = state.map.getCenter(); return { lat: c.lat, lon: c.lng }; }
    return null;
  }

  function facBox() { const host = teamHost(); return host && host.querySelector('.tp-facilities'); }

  function toggleFacilities() {
    const box = facBox();
    if (!box) return;
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    if (T.facilities) { renderFacilities(T.facilities); return; }
    box.innerHTML = `<div class="tp-fac-load">${esc(tt('team.fac.loading', 'Finding nearest hospital & vet…'))}</div>`;
    loadFacilities();
  }

  function elLatLon(e) {
    if (Number.isFinite(e.lat) && Number.isFinite(e.lon)) return { lat: e.lat, lon: e.lon };
    if (e.center && Number.isFinite(e.center.lat)) return { lat: e.center.lat, lon: e.center.lon };
    return null;
  }

  async function loadFacilities() {
    const c = facilityCenter();
    if (!c) return;
    const q = `[out:json][timeout:20];(nwr["amenity"="hospital"](around:50000,${c.lat},${c.lon});nwr["amenity"="veterinary"](around:50000,${c.lat},${c.lon}););out center 60;`;
    try {
      const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: `data=${encodeURIComponent(q)}` });
      const d = await r.json();
      const hosp = [], vet = [];
      for (const e of (d.elements || [])) {
        const ll = elLatLon(e); if (!ll) continue;
        const item = { name: (e.tags && e.tags.name) || tt('team.fac.unnamed', 'unnamed'), emergency: !!(e.tags && e.tags.emergency === 'yes'), dist: distMi(c.lat, c.lon, ll.lat, ll.lon), lat: ll.lat, lon: ll.lon };
        if (e.tags && e.tags.amenity === 'hospital') hosp.push(item); else vet.push(item);
      }
      hosp.sort((a, b) => a.dist - b.dist); vet.sort((a, b) => a.dist - b.dist);
      T.facilities = { hosp: hosp.slice(0, 3), vet: vet.slice(0, 3) };
      renderFacilities(T.facilities);
    } catch {
      const box = facBox();
      if (box) box.innerHTML = `<div class="tp-fac-err">${esc(tt('team.fac.err', 'Could not load facilities. Verify locally.'))}</div>`;
    }
  }

  function facRow(f) {
    const em = f.emergency ? ` <span class="tp-fac-em">${esc(tt('team.fac.eryes', 'ER'))}</span>` : '';
    const to = `https://www.openstreetmap.org/?mlat=${f.lat}&mlon=${f.lon}#map=16/${f.lat}/${f.lon}`;
    return `<div class="tp-fac-row"><a href="${safeUrl(to)}" target="_blank" rel="noopener">${esc(f.name)}</a>${em} <span class="tp-fac-d">${f.dist.toFixed(1)} mi</span></div>`;
  }

  function renderFacilities(fac) {
    const box = facBox();
    if (!box) return;
    const hasK9 = (T.lastMembers || []).some((m) => m.mtype === 'k9') || T.mtype === 'k9';
    const h = (fac.hosp || []).map(facRow).join('') || `<div class="tp-fac-none">${esc(tt('team.fac.nohosp', 'No hospital found within 50 km.'))}</div>`;
    const v = (fac.vet || []).map(facRow).join('') || `<div class="tp-fac-none">${esc(tt('team.fac.novet', 'No veterinary found within 50 km.'))}</div>`;
    box.innerHTML =
      `<div class="tp-fac-h">🏥 ${esc(tt('team.fac.hosp', 'Nearest hospital'))}</div>${h}` +
      `<div class="tp-fac-h${hasK9 ? ' tp-fac-k9' : ''}">🐕 ${esc(tt('team.fac.vet', 'Nearest veterinary'))}</div>${v}` +
      `<div class="tp-fac-cap">${esc(tt('team.fac.cap', 'Via OpenStreetMap (Overpass). NOT verified as a trauma center or 24h emergency vet. Call ahead to confirm ER hours.'))}</div>`;
  }

  /* ---------- create-team flow (landing card) ---------- */

  async function doCreate() {
    const host = teamHost();
    const name = host.querySelector('#team-create-name').value.trim();
    const err = host.querySelector('#team-create-err');
    const go = host.querySelector('#team-create-go');
    let defaults = null;
    if (host.querySelector('#team-create-ao').checked && state.map) {
      const c = state.map.getCenter();
      defaults = { lat: c.lat, lon: c.lng, zoom: state.map.getZoom() };
    }
    err.hidden = true; go.disabled = true;
    try {
      const r = await api('create', { method: 'POST', body: JSON.stringify({ name, defaults }) });
      const data = await r.json();
      if (!r.ok || !data.teamId) { err.textContent = data.error || tt('team.create.fail', 'Could not create the team.'); err.hidden = false; go.disabled = false; return; }
      const url = `${location.origin}/?team=${data.teamId}`;
      const res = host.querySelector('#team-create-result');
      res.hidden = false;
      res.innerHTML =
        `<div class="team-linkrow"><input readonly id="team-create-link" value="${esc(url)}"></div>` +
        '<div class="team-qr" id="team-create-qr"></div>' +
        `<div class="team-qrcap">${esc(tt('team.qr.cap', 'Scan to join on another device'))}</div>` +
        `<div class="tt-resrow"><button id="team-create-copy" class="tt-btn tt-btn-ghost">${esc(tt('team.copy', 'Copy link'))}</button>` +
        `<button id="team-create-enter" class="tt-btn tt-btn-primary">${esc(tt('team.enter', 'Enter team →'))}</button></div>`;
      renderQR(host.querySelector('#team-create-qr'), url);
      go.disabled = false;
      host.querySelector('#team-create-copy').addEventListener('click', () => {
        const b = host.querySelector('#team-create-copy');
        copyText(url).then(() => { b.textContent = tt('team.copied', 'Copied ✓'); }, () => prompt('Copy team link:', url));
      });
      host.querySelector('#team-create-enter').addEventListener('click', () => {
        T.id = data.teamId; T.name = data.name || '';
        try { history.replaceState(null, '', url); } catch { /* sandboxed — cosmetic */ }
        renderTeamTab();
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
    const host = teamHost();
    const id = parseTeamId(host.querySelector('#team-join-link').value);
    const err = host.querySelector('#team-join-err');
    if (!id) { err.textContent = tt('team.join.link.bad', 'That team link or code is not valid.'); err.hidden = false; return; }
    err.hidden = true;
    T.id = id; T.name = '';
    try { history.replaceState(null, '', `${location.origin}/?team=${id}`); } catch { /* sandboxed — cosmetic */ }
    renderTeamTab();
    api(`${id}/state`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) { T.name = d.name || ''; setJoinTitle(); } }).catch(() => {});
  }

  // update just the join heading once the async name lookup lands (avoid clobbering a typed handle)
  function setJoinTitle() {
    if (T.active || !T.id) return;
    const host = teamHost();
    const titleEl = host && host.querySelector('.tt-join .tt-title');
    if (titleEl && T.name) titleEl.textContent = `${tt('team.join.head', 'Join team')}: ${T.name}`;
  }

  let _lifecycleArmed = false;
  function armLifecycle() {
    if (_lifecycleArmed) return;
    _lifecycleArmed = true;
    window.addEventListener('pagehide', beaconLeave);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') beaconLeave(); });
  }

  // ⋮ More → Team shortcut and the tab are the same home — just surface the tab.
  window.openTeamEntry = function openTeamEntry() {
    showTeamTab();
    if (window.isSecureContext) armLifecycle();
    renderTeamTab();
  };

  function start() {
    const param = new URLSearchParams(location.search).get('team');
    if (!param) return; // no ?team= link — the tab still shows create/join
    if (!window.isSecureContext) {
      note(tt('team.needhttps', 'Live team sharing needs the secure site: https://responder.rfxn.com'));
      showTeamTab(); renderTeamTab();
      return;
    }
    ensureLayer();
    armLifecycle();
    if (param === 'new') { showTeamTab(); renderTeamTab(); return; } // landing (create)
    if (!UUID_RE.test(param)) { note(tt('team.badlink', 'That team link is not valid.')); return; }
    T.id = param;
    showTeamTab();
    renderTeamTab(); // join state; heading fills in once the name lookup lands
    api(`${param}/state`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (d) { T.name = d.name || ''; setJoinTitle(); } }).catch(() => {});
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

  // paint the Team tab body on boot so it is populated the first time it is opened
  window.initTeamTab = function initTeamTab() { renderTeamTab(); };
  window.renderTeamTab = renderTeamTab; // relocalizeDynamic() re-renders it on language switch

  // reused by the LAN-only master oversight view (js/master.js) to plot members with the exact
  // same marker style; inert on the public mirror where master.js never loads
  window.teamMemberIcon = memberIcon;
})();
