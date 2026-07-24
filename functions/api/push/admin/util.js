// Shared token gate for the push ops endpoints. No onRequest export → Pages does not route this
// file. FAIL SAFE: with no PUSH_ADMIN_TOKEN secret configured, or a mismatched token, the request
// is denied — the ops surface is never open. Same convention as functions/api/team/admin/util.js.

export function authorized(request, env) {
  const secret = (env && env.PUSH_ADMIN_TOKEN) || '';
  if (!secret) return false;
  const provided = request.headers.get('X-Admin-Token') || '';
  return timingSafeEqual(provided, secret);
}

function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
