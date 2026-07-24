// Shared guard + forwarder for the push-registry routes. No onRequest export → Pages does not
// route this file. Mirrors functions/api/team/: env.PUSH binding check, body size cap, 503 when
// unbound (the client hides the card entirely on 503).

export const BODY_MAX = 4096;

export function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

// forward(context, action, {method}): guard the PUSH binding, cap the body, resolve the single
// registry DO, and proxy. The client IP rides a header for the DO's transient rate bucket only.
export async function forward(context, action, { method = 'POST' } = {}) {
  const { request, env } = context;
  if (!env || !env.PUSH) return json({ error: 'push not configured' }, 503);
  const stub = env.PUSH.get(env.PUSH.idFromName('registry'));
  if (method === 'GET') {
    return stub.fetch(new Request(`https://do/${action}`, { method: 'GET' }));
  }
  let raw = '';
  try { raw = await request.text(); } catch { raw = ''; }
  if (raw.length > BODY_MAX) return json({ error: 'body too large' }, 413);
  let body = {};
  try { body = JSON.parse(raw) || {}; } catch { body = {}; }
  if (typeof body !== 'object' || Array.isArray(body)) body = {};
  return stub.fetch(new Request(`https://do/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-IP': request.headers.get('CF-Connecting-IP') || '' },
    body: JSON.stringify(body),
  }));
}
