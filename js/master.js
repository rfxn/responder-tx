'use strict';

// LAN-only master oversight view. Loaded by boot.js ONLY when /api/ping advertises master:true
// (server.py, when the admin token is configured). Command-side, read-only: enumerates ALL teams
// via the token-gated Cloudflare registry (proxied by the LAN server), shows each team's makeup and
// plots its members on the map, plus a combined roster of every viewer. Stripped from public deploys
// — the mirror has no master route, API, token, or UI. Distinct from the field team panel (js/team.js).
(function () {
  const POLL_MS = 20000;
  const STALE_MS = 90000;   // grey a member last-seen this long ago
  const TOMB_MS = 1800000;  // keep a last-known tombstone up to 30 min after last contact, then drop it
  const MTYPES_K9 = 'k9';

  const L10N = {
    en: {
      title: 'Master oversight', sub: 'all teams · command view (LAN only)',
      fab: 'Master oversight: all teams & viewers (LAN only)',
      summary: (t, m, v) => `${t} team${t === 1 ? '' : 's'} · ${m} member${m === 1 ? '' : 's'} · ${v} viewer${v === 1 ? '' : 's'}`,
      onmap: 'Show members on map', close: 'Close', refresh: 'Refresh now',
      noteams: 'No active teams. Teams appear here as they are created.',
      members: 'Members', viewers: 'Viewers', novm: 'no members', focus: 'Focus map',
      allviewers: 'All viewers', noviewers: 'No viewers in any team right now.',
      k9: 'K9', ground: 'ground', markers: 'markers', idle: 'idle', created: 'created',
      seen: 'seen', nofix: 'no fix', on: 'team', unnamed: 'Unnamed team',
      lost: 'lost contact', lastknown: 'last known',
      st: { infield: 'in field', standby: 'standby', rehab: 'rehab', unavailable: 'unavailable' },
      err503: 'Master oversight is not configured on this LAN server (no admin token set).',
      err403: 'Admin token was rejected by the relay. Check the token matches the Cloudflare secret.',
      errnet: 'Could not reach the oversight relay. Retrying…',
    },
    es: {
      title: 'Vista de mando', sub: 'todos los equipos · vista de mando (solo LAN)',
      fab: 'Vista de mando: todos los equipos y observadores (solo LAN)',
      summary: (t, m, v) => `${t} equipo${t === 1 ? '' : 's'} · ${m} miembro${m === 1 ? '' : 's'} · ${v} observador${v === 1 ? '' : 'es'}`,
      onmap: 'Mostrar miembros en el mapa', close: 'Cerrar', refresh: 'Actualizar ahora',
      noteams: 'No hay equipos activos. Aparecerán aquí al crearse.',
      members: 'Miembros', viewers: 'Observadores', novm: 'sin miembros', focus: 'Centrar mapa',
      allviewers: 'Todos los observadores', noviewers: 'Ningún observador en ningún equipo ahora.',
      k9: 'K9', ground: 'terrestres', markers: 'marcadores', idle: 'inactivo', created: 'creado',
      seen: 'visto', nofix: 'sin ubicación', on: 'equipo', unnamed: 'Equipo sin nombre',
      lost: 'sin contacto', lastknown: 'última conocida',
      st: { infield: 'en campo', standby: 'en espera', rehab: 'descanso', unavailable: 'no disponible' },
      err503: 'La vista de mando no está configurada en este servidor LAN (sin token de administrador).',
      err403: 'El token de administrador fue rechazado por el relay. Verifique que coincida con el secreto de Cloudflare.',
      errnet: 'No se pudo contactar el relay de mando. Reintentando…',
    },
  };
  const lang = () => (window.getLang && L10N[window.getLang()] ? window.getLang() : 'en');
  const M = (k) => L10N[lang()][k];
  const stLabel = (s) => (L10N[lang()].st[s] || s);

  const mv = {
    open: false, overlay: false, data: null, timer: null,
    layer: null, markers: {}, lastKnown: {},
  };

  const style = document.createElement('style');
  style.textContent = `
#mv-fab {
  position: fixed; left: 16px; bottom: 46px; z-index: 1300;
  width: 48px; height: 48px; border-radius: 50%;
  font-size: 20px; padding: 0; cursor: pointer;
  background: #b8860b; border: 1px solid #ffcf6b; color: #fff;
  box-shadow: 0 3px 12px rgba(0,0,0,0.45);
}
#mv-panel {
  position: fixed; left: 16px; bottom: 102px; z-index: 1300;
  width: min(94vw, 420px); height: min(76vh, 560px);
  display: flex; flex-direction: column;
  background: var(--surface-1); border: 1px solid #b8860b; border-radius: 12px;
  box-shadow: 0 8px 30px rgba(0,0,0,0.55);
}
#mv-panel[hidden] { display: none; }
#mv-head { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px;
  border-bottom: 1px solid var(--hairline); }
#mv-head .mv-h-main { flex: 1 1 auto; }
#mv-head strong { color: #ffcf6b; }
.mv-sub { font-size: 11px; color: var(--ink-muted); font-weight: 400; }
#mv-head button { background: none; border: none; color: var(--ink-1); font-size: 16px; cursor: pointer; }
.mv-bar { display: flex; align-items: center; gap: 10px; padding: 6px 12px;
  border-bottom: 1px solid var(--hairline); font-size: 12px; color: var(--ink-muted); flex-wrap: wrap; }
.mv-bar label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; color: var(--ink-1); }
.mv-count { flex: 1 1 auto; }
#mv-body { flex: 1; overflow-y: auto; padding: 8px 12px; }
.mv-team { border: 1px solid var(--hairline); border-radius: 9px; padding: 8px 10px; margin-bottom: 8px; }
.mv-team-h { display: flex; align-items: baseline; gap: 6px; }
.mv-team-h .mv-name { font-weight: 700; flex: 1 1 auto; }
.mv-team-h .mv-id { font-size: 10.5px; color: var(--ink-muted); font-family: monospace; }
.mv-focus { background: none; border: 1px solid var(--hairline); border-radius: 6px;
  color: var(--ink-1); font-size: 10.5px; padding: 1px 6px; cursor: pointer; }
.mv-meta { font-size: 11px; color: var(--ink-muted); margin: 4px 0 2px; display: flex; gap: 8px; flex-wrap: wrap; }
.mv-chip { display: inline-block; padding: 0 6px; border-radius: 8px; background: var(--surface-2);
  border: 1px solid var(--hairline); font-size: 10.5px; }
.mv-chip-k9 { border-color: #ffab40; }
.mv-st-infield { color: #69f0ae; } .mv-st-standby { color: #ffab40; } .mv-st-rehab { color: #4fc3f7; } .mv-st-unavailable { color: #ff6e6e; }
.mv-mrow { display: flex; align-items: center; gap: 6px; font-size: 11.5px; padding: 2px 0; }
.mv-sw { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.mv-mrow .mv-mh { flex: 1 1 auto; }
.mv-age { font-size: 10.5px; color: var(--ink-muted); }
.mv-age.mv-lost { color: #ff8a80; font-weight: 700; }
.mv-chip-lost { border-color: #ff8a80; color: #ff8a80; }
.mv-stale { opacity: 0.55; }
.mv-vsec { margin-top: 4px; }
.mv-vhead { font-weight: 700; color: #ffcf6b; font-size: 12px; margin: 4px 0; }
.mv-vrow { display: flex; gap: 6px; font-size: 11.5px; padding: 2px 0; border-bottom: 1px solid var(--hairline); }
.mv-vrow .mv-vh { flex: 1 1 auto; }
.mv-vteam { color: var(--ink-muted); font-size: 10.5px; }
.mv-empty { color: var(--ink-muted); font-size: 12px; padding: 10px 2px; }
.mv-err { color: #ff8a80; font-size: 12px; padding: 8px 2px; }
@media (max-width: 500px) { #mv-fab { bottom: 58px; } #mv-panel { left: 3vw; width: 94vw; } }
@media print { #mv-fab, #mv-panel { display: none !important; } }
`;
  document.head.appendChild(style);

  const fab = document.createElement('button');
  fab.id = 'mv-fab';
  fab.title = M('fab');
  fab.textContent = '🛰';
  const panel = document.createElement('div');
  panel.id = 'mv-panel';
  panel.hidden = true;
  panel.innerHTML =
    '<div id="mv-head"><div class="mv-h-main"><strong>' + esc(M('title')) + '</strong>' +
    '<div class="mv-sub">' + esc(M('sub')) + '</div></div>' +
    '<button id="mv-refresh" title="' + esc(M('refresh')) + '">⟳</button>' +
    '<button id="mv-close" title="' + esc(M('close')) + '">✕</button></div>' +
    '<div class="mv-bar"><span class="mv-count"></span>' +
    '<label><input type="checkbox" id="mv-overlay"> ' + esc(M('onmap')) + '</label></div>' +
    '<div id="mv-body"></div>';
  document.body.appendChild(fab);
  document.body.appendChild(panel);

  /* ---------- map overlay (reuses the team member marker style) ---------- */

  function ensureLayer() {
    if (mv.layer || typeof state === 'undefined' || !state.map) return;
    if (!state.map.getPane('master')) {
      state.map.createPane('master');
      state.map.getPane('master').style.zIndex = 646; // just above the field team pane (640)
    }
    mv.layer = L.layerGroup().addTo(state.map);
  }

  function fallbackIcon(m, color, stale) {
    const k9 = m.mtype === MTYPES_K9;
    const dot = k9 ? '<span class="tm-dot tm-dot-k9">🐕</span>' : '<span class="tm-dot"></span>';
    const cls = 'team-marker team-st-' + (m.status || 'infield') + (stale ? ' team-stale' : '');
    return L.divIcon({ className: '', html: '<div class="' + cls + '" style="--tc:' + (color || '#40c4ff') +
      '">' + dot + '<span class="tm-label">' + esc(m.handle) + '</span></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
  }

  function iconFor(m, color, stale) {
    return window.teamMemberIcon ? window.teamMemberIcon(m, color, false, stale) : fallbackIcon(m, color, stale);
  }

  function hhmm(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; } // options unsupported on a deep-legacy engine; omit the stamp
  }

  // clearly-stale "last known position" marker for a dropped/reaped member (hollow, dashed, timestamped)
  function tombIcon(lk) {
    const k9 = lk.mtype === MTYPES_K9;
    const dot = k9 ? '<span class="tm-dot tm-dot-k9">🐕</span>' : '<span class="tm-dot"></span>';
    const when = hhmm(lk.lastSeen);
    return L.divIcon({ className: '', html: '<div class="team-marker team-tomb" style="--tc:' + (lk.color || '#7a8899') +
      '">' + dot + '<span class="tm-label">' + esc(lk.handle || '') + ' · ' + esc(M('lastknown')) + (when ? ' ' + esc(when) : '') + '</span></div>',
      iconSize: [14, 14], iconAnchor: [7, 7] });
  }

  function renderOverlay() {
    if (!mv.overlay) { clearOverlay(); return; }
    ensureLayer();
    if (!mv.layer) return;
    const now = mv.data ? mv.data.now : Date.now();
    const seen = {};
    for (const tm of (mv.data ? mv.data.teams : [])) {
      for (const m of (tm.members || [])) {
        if (!m.lastPos) continue;
        const key = tm.id + '/' + m.pid;
        seen[key] = true;
        const stale = now - (m.lastSeen || 0) > STALE_MS;
        const ll = [m.lastPos.lat, m.lastPos.lon];
        // esc() both values; Leaflet injects the tooltip as innerHTML (defense-in-depth; the DO strips <>)
        const label = esc(tm.name || M('unnamed')) + ' · ' + esc(m.handle);
        mv.lastKnown[key] = { ll, handle: m.handle, teamName: tm.name || M('unnamed'), color: m.color, mtype: m.mtype, lastSeen: m.lastSeen || now };
        let entry = mv.markers[key];
        if (!entry) {
          entry = L.marker(ll, { pane: 'master', icon: iconFor(m, m.color, stale), zIndexOffset: 0 });
          entry.bindTooltip(label, { direction: 'top', offset: [0, -8] });
          entry.addTo(mv.layer);
          mv.markers[key] = entry;
        } else {
          entry.setLatLng(ll);
          entry.setIcon(iconFor(m, m.color, stale));
          entry.setTooltipContent(label);
        }
        entry._tomb = false;
      }
    }
    for (const key of Object.keys(mv.markers)) {
      if (seen[key]) continue;
      const lk = mv.lastKnown[key];
      // reaped/dropped member: keep a bounded last-known tombstone instead of vanishing from command
      if (lk && now - (lk.lastSeen || 0) <= TOMB_MS) {
        const mk = mv.markers[key];
        if (!mk._tomb) {
          mk.setLatLng(lk.ll);
          mk.setIcon(tombIcon(lk));
          mk.setTooltipContent(esc(lk.teamName) + ' · ' + esc(lk.handle) + ' · ' + esc(M('lastknown')) + (hhmm(lk.lastSeen) ? ' ' + esc(hhmm(lk.lastSeen)) : ''));
          mk._tomb = true;
        }
        continue;
      }
      mv.layer.removeLayer(mv.markers[key]); delete mv.markers[key]; delete mv.lastKnown[key];
    }
  }

  function clearOverlay() {
    if (mv.layer) mv.layer.clearLayers();
    mv.markers = {};
    mv.lastKnown = {};
  }

  function focusTeam(teamId) {
    const tm = (mv.data ? mv.data.teams : []).find((t) => t.id === teamId);
    if (!tm || !state.map) return;
    const pts = (tm.members || []).filter((m) => m.lastPos).map((m) => [m.lastPos.lat, m.lastPos.lon]);
    if (pts.length) state.map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 15 });
    else if (tm.defaults && Number.isFinite(tm.defaults.lat)) state.map.setView([tm.defaults.lat, tm.defaults.lon], tm.defaults.zoom || 12);
  }

  /* ---------- roster rendering ---------- */

  function ageStr(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    return Math.round(s / 3600) + 'h';
  }

  function makeup(members) {
    const o = { k9: 0, ground: 0, st: { infield: 0, standby: 0, rehab: 0, unavailable: 0 }, sp: {} };
    for (const m of members) {
      if (m.mtype === MTYPES_K9) o.k9++; else o.ground++;
      const st = o.st[m.status] != null ? m.status : 'infield';
      o.st[st]++;
      if (m.specialty && m.mtype !== MTYPES_K9) o.sp[m.specialty] = (o.sp[m.specialty] || 0) + 1;
    }
    return o;
  }

  function teamCard(tm, now) {
    const mk = makeup(tm.members || []);
    const chips = [];
    if (mk.k9) chips.push('<span class="mv-chip mv-chip-k9">🐕 ' + mk.k9 + ' ' + esc(M('k9')) + '</span>');
    if (mk.ground) chips.push('<span class="mv-chip">' + mk.ground + ' ' + esc(M('ground')) + '</span>');
    for (const s of ['infield', 'standby', 'rehab', 'unavailable']) {
      if (mk.st[s]) chips.push('<span class="mv-chip mv-st-' + s + '">' + mk.st[s] + ' ' + esc(stLabel(s)) + '</span>');
    }
    for (const sp of Object.keys(mk.sp)) chips.push('<span class="mv-chip">' + esc(sp) + ' ×' + mk.sp[sp] + '</span>');
    if ((tm.markers || []).length) chips.push('<span class="mv-chip">📍 ' + tm.markers.length + ' ' + esc(M('markers')) + '</span>');
    const lostN = (tm.members || []).filter((m) => m.lastPos && now - (m.lastSeen || 0) > STALE_MS).length;
    if (lostN) chips.push('<span class="mv-chip mv-chip-lost">⚠ ' + lostN + ' ' + esc(M('lost')) + '</span>');

    const rows = (tm.members || []).map((m) => {
      const stale = now - (m.lastSeen || 0) > STALE_MS;
      // stale-with-a-fix reads as lost contact so command does not miss a dropped field member
      const age = !m.lastPos ? M('nofix')
        : stale ? (M('lost') + ' · ' + hhmm(m.lastSeen))
        : (M('seen') + ' ' + ageStr(m.lastSeen));
      const dog = (m.mtype === MTYPES_K9 && m.k9Name) ? ' · ' + esc(m.k9Name) : '';
      return '<div class="mv-mrow' + (stale ? ' mv-stale' : '') + '">' +
        '<span class="mv-sw" style="background:' + esc(m.color || '#40c4ff') + '"></span>' +
        '<span class="mv-mh">' + esc(m.handle) + dog + ' <span class="mv-st-' + (m.status || 'infield') + '">' + esc(stLabel(m.status || 'infield')) + '</span></span>' +
        '<span class="mv-age' + (stale && m.lastPos ? ' mv-lost' : '') + '">' + esc(age) + '</span></div>';
    }).join('') || '<div class="mv-age">' + esc(M('novm')) + '</div>';

    const idleTxt = tm.lastActive ? ' · ' + esc(M('idle')) + ' ' + ageStr(tm.lastActive) : '';
    return '<div class="mv-team">' +
      '<div class="mv-team-h"><span class="mv-name">' + esc(tm.name || M('unnamed')) + '</span>' +
      '<span class="mv-id">' + esc((tm.id || '').slice(0, 8)) + '</span>' +
      '<button class="mv-focus" data-focus="' + esc(tm.id) + '">' + esc(M('focus')) + '</button></div>' +
      '<div class="mv-meta">👥 ' + (tm.members || []).length + ' ' + esc(M('members')) +
      ' · 👁 ' + (tm.viewers || []).length + ' ' + esc(M('viewers')) + idleTxt + '</div>' +
      '<div class="mv-meta">' + chips.join(' ') + '</div>' + rows + '</div>';
  }

  function render() {
    const bar = panel.querySelector('.mv-count');
    const body = document.getElementById('mv-body');
    if (!mv.data) { bar.textContent = ''; return; }
    const d = mv.data;
    bar.textContent = M('summary')(d.teamCount || 0, d.memberCount || 0, d.viewerCount || 0);
    const teams = (d.teams || []).map((t) => teamCard(t, d.now || Date.now())).join('') ||
      '<div class="mv-empty">' + esc(M('noteams')) + '</div>';
    const viewers = (d.viewers || []).length
      ? '<div class="mv-vsec"><div class="mv-vhead">' + esc(M('allviewers')) + ' (' + d.viewers.length + ')</div>' +
        d.viewers.map((v) => '<div class="mv-vrow"><span class="mv-vh">👁 ' + esc(v.handle) + '</span>' +
          '<span class="mv-vteam">' + esc(M('on')) + ': ' + esc(v.teamName || (v.teamId || '').slice(0, 8)) + '</span>' +
          '<span class="mv-age">' + esc(ageStr(v.lastSeen)) + '</span></div>').join('') + '</div>'
      : '<div class="mv-vsec"><div class="mv-vhead">' + esc(M('allviewers')) + '</div><div class="mv-age">' + esc(M('noviewers')) + '</div></div>';
    body.innerHTML = teams + viewers;
    body.querySelectorAll('[data-focus]').forEach((b) => b.addEventListener('click', () => focusTeam(b.dataset.focus)));
  }

  function showErr(msg) {
    document.getElementById('mv-body').innerHTML = '<div class="mv-err">' + esc(msg) + '</div>';
    panel.querySelector('.mv-count').textContent = '';
  }

  /* ---------- polling ---------- */

  async function load() {
    try {
      const r = await fetch('/api/team/admin/overview', { headers: { Accept: 'application/json' } });
      if (r.status === 503) { showErr(M('err503')); return; }
      if (r.status === 403) { showErr(M('err403')); return; }
      if (!r.ok) { showErr(M('errnet')); return; }
      mv.data = await r.json();
      render();
      renderOverlay();
    } catch { showErr(M('errnet')); }
  }

  function startPolling() {
    if (mv.timer) return;
    load();
    mv.timer = setInterval(() => {
      if (document.visibilityState === 'visible' && (mv.open || mv.overlay)) load();
    }, POLL_MS);
  }

  function toggle(open) {
    mv.open = open != null ? open : !mv.open;
    panel.hidden = !mv.open;
    if (mv.open) { startPolling(); load(); }
  }

  fab.addEventListener('click', () => toggle());
  document.getElementById('mv-close').addEventListener('click', () => toggle(false));
  document.getElementById('mv-refresh').addEventListener('click', load);
  document.getElementById('mv-overlay').addEventListener('change', (e) => {
    mv.overlay = e.target.checked;
    if (mv.overlay) { startPolling(); renderOverlay(); } else clearOverlay();
  });
})();
