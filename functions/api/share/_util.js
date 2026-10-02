// Shared guard + DO stub for the short-link routes. No onRequest export, so Pages does not route it.

export const BODY_MAX = 4096;
export const CODE_RE = /^[1-9]\d{7}$/;

export function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
  });
}

// null when the SHARE binding is absent, so a Pages deploy ahead of the Worker degrades to long links
export function shareStub(env) {
  if (!env || !env.SHARE) return null;
  return env.SHARE.get(env.SHARE.idFromName('links'));
}
