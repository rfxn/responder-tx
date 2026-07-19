// Cloudflare Pages Function: edge-cached TxDOT ITS snapshot proxy (mirrors server.py /api/cam)
// Upstream returns JSON { snippet: <base64 JPEG>, timestampFormatted: <US Central wall time> }
const UPSTREAM = 'https://its.txdot.gov/its/DistrictIts/GetCctvSnapshotByIcdId';
const DIST_RE = /^[A-Z]{3}$/;
const ICD_RE = /^[A-Za-z0-9 @\-.'_()&,#+]{1,64}$/; // matches gen-cameras.py ITS_ICD_RE — not an open proxy

export async function onRequestGet(context) {
  const district = String(context.params.district || '');
  const icd = String(context.params.icd || '');
  if (!DIST_RE.test(district) || !ICD_RE.test(icd)) {
    return new Response('bad request', { status: 400 });
  }
  const cache = caches.default;
  const cacheKey = new Request(new URL(context.request.url).origin + `/api/cam/${district}/${encodeURIComponent(icd)}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  let jpeg, captured;
  try {
    const up = await fetch(`${UPSTREAM}?icdId=${encodeURIComponent(icd)}&districtCode=${district}`, { headers: { Accept: 'application/json' } });
    if (!up.ok) return new Response(`upstream ${up.status}`, { status: 502 });
    const d = await up.json();
    if (!d || typeof d.snippet !== 'string' || !d.snippet) return new Response('no snapshot', { status: 502 });
    const bin = atob(d.snippet);
    jpeg = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) jpeg[i] = bin.charCodeAt(i);
    captured = String(d.timestampFormatted || '').replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 64);
  } catch {
    return new Response('upstream error', { status: 502 });
  }
  const res = new Response(jpeg, {
    status: 200,
    headers: {
      'Content-Type': 'image/jpeg',
      'X-Cam-Captured': captured,
      'Cache-Control': 'public, max-age=60, s-maxage=120',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'X-Cam-Captured',
    },
  });
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
