// Cloudflare Pages Function: edge-cached camera snapshot proxy (mirrors server.py /api/cam).
// Path is /api/cam/{source}/{id}: a 3-letter ITS district (base64-JSON upstream) or a named
// direct-JPEG source. The [district] folder segment matches any source key. NOT an open proxy —
// each source pins a fixed upstream host and validates its id.
const ITS_UPSTREAM = 'https://its.txdot.gov/its/DistrictIts/GetCctvSnapshotByIcdId';
const DIST_RE = /^[A-Z]{3}$/;
const ICD_RE = /^[A-Za-z0-9 @\-.'_()&,#+]{1,64}$/; // matches gen-cameras.py ITS_ICD_RE
const UA = 'Mozilla/5.0 (compatible; responder-tx-board/1.0)'; // some CDNs 1010-block the default fetch UA
// Strict per-source allowlist for direct-JPEG passthrough — fixed upstream host per key.
const BYTES_SOURCES = {
  austin: { idRe: /^[0-9]{1,8}$/, url: (id) => `https://cctv.austinmobility.io/image/${id}.jpg` },
  houston: { idRe: /^[0-9]{1,8}$/, url: (id) => `https://www.houstontranstar.org/snapshots/cctv/${id}.jpg` },
  arlington: { idRe: /^[A-Za-z0-9_-]{1,64}$/, url: (id) => `https://webapps.arlingtontx.gov/webcams/${id}.jpg` },
};

export async function onRequestGet(context) {
  const source = String(context.params.district || '');
  const id = String(context.params.icd || '');
  if (DIST_RE.test(source)) return itsSnapshot(context, source, id);
  const src = Object.prototype.hasOwnProperty.call(BYTES_SOURCES, source) ? BYTES_SOURCES[source] : null;
  if (src && src.idRe.test(id)) return bytesSnapshot(context, source, id, src.url(id));
  return new Response('bad request', { status: 400 });
}

function jpegResponse(body, captured) {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'image/jpeg',
      'X-Cam-Captured': captured,
      'Cache-Control': 'public, max-age=60, s-maxage=120',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'X-Cam-Captured',
    },
  });
}

// TxDOT ITS: upstream JSON carries a base64 JPEG + US-Central wall-time stamp
async function itsSnapshot(context, district, icd) {
  if (!ICD_RE.test(icd)) return new Response('bad request', { status: 400 });
  const cache = caches.default;
  const cacheKey = new Request(new URL(context.request.url).origin + `/api/cam/${district}/${encodeURIComponent(icd)}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  let jpeg, captured;
  try {
    const up = await fetch(`${ITS_UPSTREAM}?icdId=${encodeURIComponent(icd)}&districtCode=${district}`, { headers: { Accept: 'application/json', 'User-Agent': UA } });
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
  const res = jpegResponse(jpeg, captured);
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// Named direct-JPEG source (Austin ATD, …): stream upstream bytes, lift Last-Modified into the stamp
async function bytesSnapshot(context, source, id, upstream) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(context.request.url).origin + `/api/cam/${source}/${encodeURIComponent(id)}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  let body, captured;
  try {
    const up = await fetch(upstream, { headers: { Accept: 'image/jpeg', 'User-Agent': UA } });
    if (!up.ok) return new Response(`upstream ${up.status}`, { status: 502 });
    if (!/image/i.test(up.headers.get('content-type') || '')) return new Response('not an image', { status: 502 });
    body = await up.arrayBuffer();
    captured = String(up.headers.get('last-modified') || '').replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 64);
  } catch {
    return new Response('upstream error', { status: 502 });
  }
  const res = jpegResponse(body, captured);
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
