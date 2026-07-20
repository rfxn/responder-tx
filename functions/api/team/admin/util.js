// Shared helpers for the token-gated master oversight endpoints. No onRequest export → Pages does
// not route this file; it is imported by list.js and overview.js. Holds no secret and no data.

// Authorize a master-oversight request. FAIL SAFE: if no secret is configured on the deploy, or the
// supplied token does not match, authorization is denied — the enumeration path is never open.
export function authorized(request, env) {
  const secret = (env && env.TEAM_ADMIN_TOKEN) || '';
  if (!secret) return false;
  const provided = request.headers.get('X-Admin-Token')
    || new URL(request.url).searchParams.get('token') || '';
  return timingSafeEqual(provided, secret);
}

function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}
