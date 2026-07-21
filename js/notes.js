'use strict';

// Field Notes — community/responder annotation flyout + teal map pins.
// Data: data/notes.json (curated, ships with the mirror) merged with
// data/notes-inbox.jsonl (LAN posts via POST /api/notes). On the public
// mirror the POST path is absent — the board degrades to read-only.
(function () {
  const NOTE_CATS = { info: 'ℹ️', hazard: '⚠️', road: '🚧', water: '🌊', photo: '📷' };
  const NOTE_CAT_LABEL = { info: 'Info', hazard: 'Hazard', road: 'Road status', water: 'Water level', photo: 'Photo-worthy' };
  const POLL_OPEN_MS = 60000;
  const POLL_CLOSED_MS = 300000;
  const DISCLAIMER = '<strong>Life-threatening emergency → call 911.</strong> Notes are unverified community input.';

  const escFn = typeof esc === 'function' ? esc
    : (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const whenFn = typeof fmtWhen === 'function' ? fmtWhen : (iso) => new Date(iso).toLocaleString();
  const copyFn = typeof copyText === 'function' ? copyText : (t) => navigator.clipboard.writeText(t);
  const getMap = () => (typeof state !== 'undefined' && state && state.map) ? state.map : null;

  const N = {
    open: false,
    writable: false,
    notes: [],
    pinMode: false,
    pendingLL: null,
    composeKind: null,   // 'general' | 'marker' | reply parent id via replyTo
    replyTo: null,
    layer: null,
    markers: {},
    focusId: null,
    pendingDeep: null,
    mapDead: false,
  };

  const newId = () => `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const noteLink = (id) => `${location.origin}${location.pathname}?note=${encodeURIComponent(id)}`;

  // owner directive 7/17 1:10 PM: Notes hidden for now — ?notes=1 / ?note= deep links still work
  const q0 = new URLSearchParams(location.search);
  if (!q0.has('notes') && !q0.has('note')) return;

  /* ---------- DOM scaffold ---------- */

  const flyout = document.getElementById('notes-flyout') || (() => {
    const d = document.createElement('div');
    d.id = 'notes-flyout';
    d.hidden = true;
    document.body.appendChild(d);
    return d;
  })();
  flyout.innerHTML =
    '<div class="nf-head"><div><strong>📍 Field Notes</strong>' +
    '<div class="nf-sub">community + responder annotations · unverified</div></div>' +
    '<button id="nf-close" title="Close">✕</button></div>' +
    '<div class="nf-ro" id="nf-ro" hidden><strong>Read-only public mirror</strong>: notes viewable only. ' +
    'Posting works on the LAN ops board.</div>' +
    '<div class="nf-actions" id="nf-actions">' +
    '<button id="nf-new" class="primary">＋ General note</button>' +
    '<button id="nf-pin" title="Tap the map to place a pinned note">📍 Drop pin</button></div>' +
    '<div class="nf-compose" id="nf-compose" hidden>' +
    '<div class="nf-ctitle" id="nf-ctitle"></div>' +
    '<div class="row" id="nf-cat-row"><select id="nf-cat">' +
    Object.keys(NOTE_CATS).map((c) => `<option value="${c}">${NOTE_CATS[c]} ${NOTE_CAT_LABEL[c]}</option>`).join('') +
    '</select></div>' +
    '<textarea id="nf-text" rows="3" placeholder="What are you seeing? Conditions, water level, road status, hazards. No personal details."></textarea>' +
    '<div class="row"><input id="nf-name" maxlength="40" placeholder="Display name / handle (optional)"></div>' +
    `<div class="nf-disc">⚠ ${DISCLAIMER}</div>` +
    '<div class="row"><button id="nf-post" class="primary">Post</button><button id="nf-cancel">Cancel</button></div></div>' +
    '<div class="nf-note-status" id="nf-status"></div>' +
    '<div class="nf-list" id="nf-list"></div>';

  const fab = document.createElement('button');
  fab.id = 'notes-fab';
  fab.title = 'Field Notes: community + responder annotations';
  fab.innerHTML = '📍 Notes <span class="nf-badge" id="nf-badge"></span>';
  const mapEl = document.getElementById('map');

  // stacked as a Leaflet bottomleft control so it never overlaps the legend; fixed-position fallback without a map
  function placeFab(map) {
    if (map && window.L) {
      const Ctl = L.Control.extend({ onAdd: () => { L.DomEvent.disableClickPropagation(fab); return fab; } });
      map.addControl(new Ctl({ position: 'bottomleft' }));
    } else {
      document.body.appendChild(fab);
    }
  }

  const pinHint = document.createElement('div');
  pinHint.id = 'notes-pin-hint';
  pinHint.hidden = true;
  pinHint.innerHTML = '📍 Tap the map to place your note <button id="nf-pin-cancel">Cancel</button>';
  (mapEl || document.body).appendChild(pinHint);
  if (mapEl && window.L) L.DomEvent.disableClickPropagation(pinHint);

  const $n = (sel) => flyout.querySelector(sel);

  /* ---------- data ---------- */

  async function loadNotes() {
    const bust = `?_=${Date.now()}`;
    const seen = new Map();
    try {
      const pub = await fetch(`data/notes.json${bust}`).then((r) => (r.ok ? r.json() : null));
      if (pub) (pub.notes || []).forEach((x) => { if (x && x.id && x.text) seen.set(x.id, x); });
    } catch { /* curated file absent — fine, inbox may still exist */ }
    try {
      const res = await fetch(`data/notes-inbox.jsonl${bust}`);
      if (res.ok) {
        const txt = await res.text();
        if (!/^\s*</.test(txt)) { // static hosts answer missing files with an HTML 404 page
          for (const line of txt.split('\n')) {
            if (!line.trim()) continue;
            try { const x = JSON.parse(line); if (x && x.id && x.text) seen.set(x.id, x); } catch { /* skip malformed line */ }
          }
        }
      }
    } catch { /* inbox missing on the mirror — curated notes only */ }
    N.notes = [...seen.values()].sort((a, b) => new Date(b.ts) - new Date(a.ts));
    render();
    renderMarkers();
  }

  async function postNote(entry) {
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  /* ---------- rendering ---------- */

  const topNotes = () => N.notes.filter((x) => x.kind !== 'comment');
  const repliesFor = (id) => N.notes.filter((x) => x.kind === 'comment' && x.parent === id)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));

  function noteAuthor(x) { return x.name ? escFn(x.name) : 'anonymous'; }

  function replyHtml(r) {
    return `<div class="nf-reply">↳ <span class="nf-author">${noteAuthor(r)}</span> ` +
      `<span class="nf-when">${escFn(whenFn(r.ts).split(' · ')[0] || '')}</span><br>${escFn(r.text)}</div>`;
  }

  function render() {
    const badge = document.getElementById('nf-badge');
    if (badge) badge.textContent = topNotes().length || '';
    if (!N.open) return;
    const list = $n('#nf-list');
    const notes = topNotes();
    if (!notes.length) {
      list.innerHTML = '<div class="nf-empty">No field notes yet.<br>' +
        (N.writable ? 'Drop a pin on the map or post a general note.' : 'Published notes will appear here.') + '</div>';
      return;
    }
    list.innerHTML = notes.map((x) => {
      const isMarker = x.kind === 'marker' && Number.isFinite(+x.lat) && Number.isFinite(+x.lon);
      const replies = repliesFor(x.id);
      return `<div class="nf-note ${isMarker ? '' : 'nf-general'} ${x.id === N.focusId ? 'focused' : ''}" data-id="${escFn(x.id)}">` +
        `<div class="nf-note-head"><span class="nf-glyph">${isMarker ? (NOTE_CATS[x.cat] || '📍') : '💬'}</span>` +
        `<span class="nf-author">${noteAuthor(x)}</span>` +
        `<span class="nf-when">${escFn(whenFn(x.ts))}</span></div>` +
        `<div class="nf-text">${escFn(x.text)}</div>` +
        (isMarker ? `<span class="nf-loc" data-act="fly">📍 ${(+x.lat).toFixed(4)}, ${(+x.lon).toFixed(4)} · view on map</span>` : '') +
        (replies.length ? `<div class="nf-replies">${replies.map(replyHtml).join('')}</div>` : '') +
        `<div class="nf-note-acts">` +
        (N.writable ? `<button data-act="reply">💬 Reply${replies.length ? ` (${replies.length})` : ''}</button>` : '') +
        `<button data-act="link">🔗 Copy link</button></div></div>`;
    }).join('');
  }

  /* ---------- map pins ---------- */

  function popupNode(x) {
    const div = document.createElement('div');
    div.className = 'note-popup';
    const replies = repliesFor(x.id);
    div.innerHTML =
      `<div class="popup-title">${NOTE_CATS[x.cat] || '📍'} Field note · ${escFn(NOTE_CAT_LABEL[x.cat] || 'Info')}</div>` +
      `<div class="nf-text">${escFn(x.text)}</div>` +
      `<div class="popup-meta">${noteAuthor(x)} · ${escFn(whenFn(x.ts))}</div>` +
      (replies.length ? `<div class="nf-replies">${replies.map(replyHtml).join('')}</div>` : '') +
      `<div class="nf-pop-acts"><button data-act="open">💬 ${N.writable ? 'Reply' : 'Thread'}</button>` +
      `<button data-act="link">🔗 Copy link</button></div>` +
      `<div class="nf-disc">⚠ ${DISCLAIMER}</div>`;
    div.querySelector('[data-act="open"]').addEventListener('click', () => {
      openFlyout(true);
      focusNote(x.id, { fly: false });
      if (N.writable) startReply(x.id);
    });
    div.querySelector('[data-act="link"]').addEventListener('click', (ev) => {
      copyFn(noteLink(x.id)).then(() => { ev.target.textContent = '✓ Copied'; }).catch(() => { ev.target.textContent = 'copy failed'; });
    });
    return div;
  }

  function renderMarkers() {
    const map = getMap();
    if (!map || !window.L) return;
    if (!N.layer) N.layer = L.layerGroup().addTo(map);
    N.layer.clearLayers();
    N.markers = {};
    for (const x of topNotes()) {
      if (x.kind !== 'marker' || !Number.isFinite(+x.lat) || !Number.isFinite(+x.lon)) continue;
      const m = L.marker([+x.lat, +x.lon], {
        icon: L.divIcon({
          className: '',
          html: `<div class="note-pin"><span>${NOTE_CATS[x.cat] || '📍'}</span></div>`,
          iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28],
        }),
        title: `Field note: ${x.text.slice(0, 60)}`,
      }).bindPopup(() => popupNode(x), { maxWidth: 280 });
      m.addTo(N.layer);
      N.markers[x.id] = m;
    }
  }

  function focusNote(id, opts = {}) {
    const x = N.notes.find((n) => n.id === id);
    if (!x) return;
    N.focusId = id;
    render();
    const el = $n(`.nf-note[data-id="${CSS.escape(id)}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
    const map = getMap();
    const m = N.markers[id];
    if (opts.fly !== false && map && m) {
      map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 13), { duration: 0.8 });
      setTimeout(() => m.openPopup(), 850);
    }
  }

  /* ---------- compose ---------- */

  function openCompose(kind, title) {
    N.composeKind = kind;
    $n('#nf-ctitle').textContent = title;
    $n('#nf-cat-row').style.display = kind === 'marker' ? '' : 'none';
    $n('#nf-compose').hidden = false;
    $n('#nf-name').value = localStorage.getItem('respondertx.noteName') || '';
    $n('#nf-text').focus();
  }

  function closeCompose() {
    $n('#nf-compose').hidden = true;
    $n('#nf-text').value = '';
    N.composeKind = null;
    N.replyTo = null;
    N.pendingLL = null;
  }

  function startReply(id) {
    const x = N.notes.find((n) => n.id === id);
    if (!x) return;
    N.replyTo = id;
    openCompose('comment', `Reply to: "${x.text.slice(0, 60)}${x.text.length > 60 ? '…' : ''}"`);
  }

  function setPinMode(on) {
    N.pinMode = on;
    pinHint.hidden = !on;
    if (mapEl) mapEl.classList.toggle('note-pin-mode', on);
    if (on) flyout.hidden = true; // let the user see the map, esp. the mobile bottom sheet
    else if (N.open) flyout.hidden = false;
  }

  async function submit() {
    const text = $n('#nf-text').value.trim();
    if (!text) { $n('#nf-status').textContent = 'Write a short note first.'; return; }
    const name = $n('#nf-name').value.trim().slice(0, 40);
    localStorage.setItem('respondertx.noteName', name);
    const entry = { id: newId(), ts: new Date().toISOString(), kind: N.composeKind, text, name };
    if (N.composeKind === 'marker') {
      if (!N.pendingLL) { $n('#nf-status').textContent = 'Pin location missing. Use 📍 Drop pin.'; return; }
      entry.cat = $n('#nf-cat').value;
      entry.lat = +N.pendingLL.lat.toFixed(5);
      entry.lon = +N.pendingLL.lng.toFixed(5);
    } else if (N.composeKind === 'comment') {
      entry.kind = 'comment';
      entry.parent = N.replyTo;
    } else {
      entry.kind = 'general';
    }
    try {
      await postNote(entry);
      N.notes.unshift(entry);
      closeCompose();
      $n('#nf-status').textContent = 'Posted ✓';
      render();
      renderMarkers();
      if (entry.kind === 'marker') focusNote(entry.id);
    } catch (e) {
      $n('#nf-status').textContent = `Post failed (${e.message}); read-only mirror or LAN server down.`;
      setWritable(false);
    }
  }

  /* ---------- open/close + capability ---------- */

  function setWritable(w) {
    N.writable = w;
    $n('#nf-ro').hidden = w;
    $n('#nf-actions').hidden = !w;
    if (!w) { closeCompose(); setPinMode(false); }
    render();
  }

  function openFlyout(open) {
    N.open = open ?? !N.open;
    flyout.hidden = !N.open;
    if (N.open) { setPinMode(false); loadNotes(); }
  }

  /* ---------- events ---------- */

  fab.addEventListener('click', () => openFlyout());
  $n('#nf-close').addEventListener('click', () => openFlyout(false));
  $n('#nf-new').addEventListener('click', () => openCompose('general', 'General note (no location)'));
  $n('#nf-pin').addEventListener('click', () => {
    if (!getMap()) { $n('#nf-status').textContent = 'Map unavailable; general notes only.'; return; }
    setPinMode(true);
  });
  pinHint.querySelector('#nf-pin-cancel').addEventListener('click', () => { setPinMode(false); openFlyout(true); });
  $n('#nf-post').addEventListener('click', submit);
  $n('#nf-cancel').addEventListener('click', closeCompose);
  $n('#nf-list').addEventListener('click', (ev) => {
    const noteEl = ev.target.closest('.nf-note');
    if (!noteEl) return;
    const id = noteEl.dataset.id;
    const act = ev.target.dataset.act;
    if (act === 'link') {
      copyFn(noteLink(id)).then(() => { ev.target.textContent = '✓ Copied'; }).catch(() => { ev.target.textContent = 'copy failed'; });
    } else if (act === 'reply') {
      startReply(id);
    } else if (act === 'fly' || !act) {
      if (N.markers[id]) {
        focusNote(id);
        if (window.innerWidth <= 768) openFlyout(false); // bottom sheet covers the map it just flew
      } else {
        focusNote(id, { fly: false });
      }
    }
  });

  function tryDeepFocus() {
    if (!N.pendingDeep) return;
    const x = N.notes.find((n) => n.id === N.pendingDeep);
    if (!x) return; // notes not loaded yet
    if (x.kind === 'marker' && !N.markers[x.id] && !N.mapDead) return; // wait for the map to come up
    focusNote(N.pendingDeep);
    N.pendingDeep = null;
  }

  // boot.js boot() awaits config fetches before initMap() — poll briefly for the map
  let mapTries = 0;
  function wireMap() {
    const map = getMap();
    if (!map) {
      if (window.L && mapTries++ < 40) { setTimeout(wireMap, 250); return; }
      N.mapDead = true;
      placeFab(null);
      pinHint.remove();
      tryDeepFocus();
      return;
    }
    placeFab(map);
    map.on('click', (e) => {
      if (!N.pinMode) return;
      N.pendingLL = e.latlng;
      setPinMode(false);
      openFlyout(true);
      openCompose('marker', `Pinned note @ ${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`);
    });
    renderMarkers();
    tryDeepFocus();
  }

  function init() {
    wireMap();

    fetch('/api/ping').then((r) => (r.ok ? r.json() : null))
      .then((d) => setWritable(!!(d && d.notes)))
      .catch(() => setWritable(false));

    const params = new URLSearchParams(location.search);
    N.pendingDeep = params.get('note') || null;
    loadNotes().then(() => {
      if (N.pendingDeep) {
        openFlyout(true);
        tryDeepFocus();
      } else if (params.get('notes') === '1') {
        openFlyout(true);
      }
    });
    setInterval(() => { if (document.visibilityState === 'visible' && N.open) loadNotes(); }, POLL_OPEN_MS);
    setInterval(() => { if (document.visibilityState === 'visible' && !N.open) loadNotes(); }, POLL_CLOSED_MS);
  }

  // boot.js boot() (also DOMContentLoaded, registered first) has built the map by the time this runs
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
