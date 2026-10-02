// Pages Function: GET /s/<8 digits> -> 302 to the stored board view (/share<digits> arrives via _redirects).
import { shareStub, CODE_RE } from '../api/share/_util.js';

// the mapping never changes; a day bounds how long a hand-removed (abusive) row keeps resolving
const HIT_CACHE = 'public, max-age=86400';

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function page(status, title, en, es) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title} · ResponderTX</title>
<meta name="robots" content="noindex, nofollow">
<style>:root{color-scheme:light dark}body{font-family:system-ui,sans-serif;background:#fff;color:#1b365d;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:0 16px;box-sizing:border-box;text-align:center}a{color:#3f7ac4}p{margin:.5em 0;max-width:34em}@media(prefers-color-scheme:dark){body{background:#0d1b2a;color:#d9dee3}a{color:#8fb8ee}}</style></head>
<body><div>
<p>${en} <a href="/">Open the ResponderTX flood board</a></p>
<p lang="es">${es} <a href="/?lang=es">Abrir el tablero de inundaciones ResponderTX</a></p>
</div></body>
</html>
`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': PAGE_CSP,
    },
  });
}

const notFound = () => page(404, 'Short link not found',
  'This short link was not found. Check the code, or ask the sender for the full link.',
  'No se encontró este enlace corto. Revise el código o pida el enlace completo a quien lo envió.');

const unavailable = () => page(503, 'Short links unavailable',
  'Short links are unavailable right now. Ask the sender for the full link.',
  'Los enlaces cortos no están disponibles en este momento. Pida el enlace completo a quien lo envió.');

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const code = String((params && params.code) || '');
  if (!CODE_RE.test(code)) return notFound();
  const stub = shareStub(env);
  if (!stub) return unavailable();
  let res;
  let data = null;
  try {
    res = await stub.fetch(new Request(`https://do/resolve?code=${code}`, { method: 'GET' }));
    if (res.status === 404) return notFound();
    data = res.status === 200 ? await res.json() : null;
  } catch {
    return unavailable();
  }
  if (!data || typeof data.q !== 'string' || !data.q) return unavailable();
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${new URL(request.url).origin}/?${data.q}`,
      'Cache-Control': HIT_CACHE,
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  });
}

export const onRequestHead = onRequestGet;
