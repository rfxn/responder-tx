// Cloudflare Pages Function: edge-cached NWPS hydrograph proxy (mirrors server.py /api/gauge)
const UPSTREAM = {
  detail: (lid) => `https://api.water.noaa.gov/nwps/v1/gauges/${lid}`,
  series: (lid) => `https://api.water.noaa.gov/nwps/v1/gauges/${lid}/stageflow/observed`,
};

export async function onRequestGet(context) {
  const lid = String(context.params.lid || '').toUpperCase();
  const kind = String(context.params.kind || '');
  if (!/^[A-Z0-9]{3,8}$/.test(lid) || !UPSTREAM[kind]) {
    return new Response('bad request', { status: 400 });
  }
  const cache = caches.default;
  const cacheKey = new Request(new URL(context.request.url).origin + `/api/gauge/${lid}/${kind}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const up = await fetch(UPSTREAM[kind](lid), { headers: { Accept: 'application/json' } });
  if (!up.ok) return new Response(`upstream ${up.status}`, { status: 502 });
  const res = new Response(up.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60, s-maxage=180',
      'Access-Control-Allow-Origin': '*',
    },
  });
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
