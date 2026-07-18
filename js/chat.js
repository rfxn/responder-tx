'use strict';

// LAN-only ops chat. Loaded by app.js ONLY after /api/ping confirms the local
// backend (server.py). This file and all chat data are stripped from public
// deploys — the mirror has no chat route, API, or UI.
(function () {
  const CHAT_POLL_MS = 30000;
  const chat = {
    open: false,
    msgs: [],
    seen: +localStorage.getItem('respondertx.chatSeen') || 0,
  };

  const style = document.createElement('style');
  style.textContent = `
#chat-fab {
  position: fixed; right: 16px; bottom: 46px; z-index: 1300;
  width: 48px; height: 48px; border-radius: 50%;
  font-size: 21px; padding: 0;
  background: var(--accent); border: none; color: #fff;
  box-shadow: 0 3px 12px rgba(0,0,0,0.45);
}
#chat-unread {
  position: absolute; top: -4px; right: -4px;
  background: var(--sev-emergency); color: #fff;
  font-size: 11px; font-weight: 700; border-radius: 9px;
  min-width: 18px; height: 18px; line-height: 18px; padding: 0 3px;
}
#chat-panel {
  position: fixed; right: 16px; bottom: 102px; z-index: 1300;
  width: min(92vw, 380px); height: min(70vh, 520px);
  display: flex; flex-direction: column;
  background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px;
  box-shadow: 0 8px 30px rgba(0,0,0,0.5);
}
#chat-panel[hidden] { display: none; }
.chat-sub { font-size: 11px; color: var(--ink-muted); font-weight: 400; }
#chat-msgs { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.chat-msg.from-user { align-self: flex-end; max-width: 88%; text-align: right; }
.chat-msg.from-claude { align-self: flex-start; max-width: 88%; }
.chat-bubble {
  display: inline-block; text-align: left;
  background: var(--surface-2); border: 1px solid var(--border); border-radius: 10px;
  padding: 7px 10px; font-size: 13px; line-height: 1.4; white-space: pre-wrap;
}
.from-user .chat-bubble { background: var(--accent); color: #fff; border-color: transparent; }
.chat-ts { font-size: 10.5px; color: var(--ink-muted); margin-top: 2px; }
.chat-action {
  align-self: stretch; font-size: 11.5px; color: var(--ink-muted);
  border-left: 2px solid var(--hairline); padding: 2px 8px; line-height: 1.4;
}
.chat-compose { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--hairline); }
.chat-compose textarea { flex: 1; resize: none; font-size: 13px; }
#chat-note { font-size: 11px; color: var(--ink-muted); padding: 0 12px 8px; min-height: 14px; }
@media (max-width: 768px) {
  #chat-fab { bottom: 58px; }
  #chat-panel { right: 4vw; bottom: 114px; height: min(62vh, 480px); }
}
@media print { #chat-fab, #chat-panel { display: none !important; } }
`;
  document.head.appendChild(style);

  const fab = document.createElement('button');
  fab.id = 'chat-fab';
  fab.title = 'Ops chat: message the Claude session running this board (LAN only)';
  fab.innerHTML = '💬<span id="chat-unread" hidden>0</span>';
  const panel = document.createElement('div');
  panel.id = 'chat-panel';
  panel.hidden = true;
  panel.innerHTML =
    '<div class="modal-head"><div><strong>Ops session chat</strong>' +
    '<div class="chat-sub">feeds the live Claude session · replies &amp; recent actions land here</div></div>' +
    '<button id="chat-close" title="Close">✕</button></div>' +
    '<div id="chat-msgs"></div>' +
    '<div class="chat-compose">' +
    '<textarea id="chat-input" rows="2" placeholder="Question or redirect for the ops session…"></textarea>' +
    '<button id="chat-send" class="primary">Send</button></div>' +
    '<div id="chat-note"></div>';
  document.body.appendChild(fab);
  document.body.appendChild(panel);

  async function loadChat() {
    const bust = `?_=${Date.now()}`;
    const msgs = [];
    try {
      const out = await fetch(`data/chat-outbox.json${bust}`).then((r) => (r.ok ? r.json() : null));
      if (out) msgs.push(...(out.messages || []));
    } catch { /* outbox missing — session has not written yet */ }
    try {
      const res = await fetch(`data/chat-inbox.jsonl${bust}`);
      if (res.ok) {
        for (const line of (await res.text()).split('\n')) {
          if (!line.trim()) continue;
          try { msgs.push(JSON.parse(line)); } catch { /* skip malformed line */ }
        }
      }
    } catch { /* inbox unreadable — panel just shows outbox */ }
    msgs.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    chat.msgs = msgs;
    renderChat();
  }

  function renderChat() {
    const unseen = chat.msgs.filter((m) => m.role !== 'user' && new Date(m.ts).getTime() > chat.seen).length;
    const badge = document.getElementById('chat-unread');
    badge.hidden = !unseen || chat.open;
    badge.textContent = unseen;
    if (!chat.open) return;
    const el = document.getElementById('chat-msgs');
    const atBottom = !el.childElementCount || el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    el.innerHTML = chat.msgs.map((m) => (m.role === 'action'
      ? `<div class="chat-action">⚙ ${esc(m.text)} <span class="chat-ts">${esc(fmtWhen(m.ts).split(' · ')[0])}</span></div>`
      : `<div class="chat-msg ${m.role === 'user' ? 'from-user' : 'from-claude'}"><div class="chat-bubble">${esc(m.text)}</div>` +
        `<div class="chat-ts">${m.role === 'user' ? 'you' : 'claude'} · ${esc(fmtWhen(m.ts))}</div></div>`)).join('')
      || '<div class="chat-action">No messages yet. Ask a question or redirect the session; it checks the inbox every ~5 min.</div>';
    if (atBottom) el.scrollTop = el.scrollHeight;
    const latest = chat.msgs.filter((m) => m.role !== 'user').map((m) => new Date(m.ts).getTime());
    if (latest.length) {
      chat.seen = Math.max(chat.seen, ...latest);
      localStorage.setItem('respondertx.chatSeen', String(chat.seen));
    }
  }

  async function sendChat() {
    const inp = document.getElementById('chat-input');
    const text = inp.value.trim();
    if (!text) return;
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      inp.value = '';
      chat.msgs.push({ ts: new Date().toISOString(), role: 'user', text });
      renderChat();
      document.getElementById('chat-note').textContent = 'sent ✓ · the session polls every ~5 min';
    } catch (e) { document.getElementById('chat-note').textContent = `send failed (${e.message}); LAN server down?`; }
  }

  function toggleChat(open) {
    chat.open = open ?? !chat.open;
    panel.hidden = !chat.open;
    if (chat.open) loadChat();
    else renderChat();
  }

  fab.addEventListener('click', () => toggleChat());
  panel.querySelector('#chat-close').addEventListener('click', () => toggleChat(false));
  panel.querySelector('#chat-send').addEventListener('click', sendChat);
  panel.querySelector('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  loadChat();
  setInterval(() => { if (document.visibilityState === 'visible' && chat.open) loadChat(); }, CHAT_POLL_MS);
  setInterval(() => { if (document.visibilityState === 'visible' && !chat.open) loadChat(); }, CHAT_POLL_MS * 4);
  if (new URLSearchParams(location.search).get('chat') === '1') toggleChat(true);
})();
