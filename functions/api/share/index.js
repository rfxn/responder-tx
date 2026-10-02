// Pages Function: POST /api/share {q} -> {code, url}. The allowlist, caps and rate limit live in the DO.
import { json, shareStub, BODY_MAX, CODE_RE } from './_util.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const stub = shareStub(env);
  if (!stub) return json({ error: 'share links not configured' }, 503);
  let raw = '';
  try { raw = await request.text(); } catch { raw = ''; }
  if (raw.length > BODY_MAX) return json({ error: 'body too large' }, 413);
  let body = {};
  try { body = JSON.parse(raw) || {}; } catch { body = {}; }
  const q = body && typeof body === 'object' ? body.q : undefined;
  let res;
  let data = {};
  try {
    res = await stub.fetch(new Request('https://do/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-IP': request.headers.get('CF-Connecting-IP') || '' },
      body: JSON.stringify({ q }),
    }));
    data = (await res.json()) || {};
  } catch {
    return json({ error: 'share links unavailable' }, 503);
  }
  if (res.status !== 200) return json({ error: data.error || 'share link refused' }, res.status);
  if (!CODE_RE.test(String(data.code || ''))) return json({ error: 'share links unavailable' }, 502);
  return json({ code: data.code, url: `${new URL(request.url).origin}/s/${data.code}` }, 200);
}
