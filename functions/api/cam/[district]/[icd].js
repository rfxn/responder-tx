// Cloudflare Pages Function: edge-cached camera snapshot proxy (mirrors server.py /api/cam).
// Path is /api/cam/{source}/{id}: a 3-letter ITS district (base64-JSON upstream) or a named
// direct-JPEG source. The [district] folder segment matches any source key. NOT an open proxy —
// each source pins a fixed upstream host and validates its id.
const ITS_UPSTREAM = 'https://its.txdot.gov/its/DistrictIts/GetCctvSnapshotByIcdId';
const DIST_RE = /^[A-Z]{3}$/;
const ICD_SLASH = '~'; // stands in for '/' in the path segment; reversed before the upstream call
const ICD_RE = /^[A-Za-z0-9 @\-.'_()&,#+~]{1,64}$/; // matches gen-cameras.py ITS_ICD_RE
const UA = 'Mozilla/5.0 (compatible; responder-tx-board/1.0)'; // some CDNs 1010-block the default fetch UA
const ATX_LIST = 'https://api.atxfloods.com/api/cameras';
const ATX_IMG = 'https://api.atxfloods.com/uploads/';
const ATX_ID_RE = /^[0-9]{1,8}$/; // matches gen-cameras.py ATX_ID_RE
const ATX_NAME_RE = /^[A-Za-z0-9._-]{1,160}\.jpe?g$/i; // upstream-supplied filename: never let it steer the URL
// Strict per-source allowlist for direct-JPEG passthrough — fixed upstream host per key.
// hays uses a composite {pid}-{sid} id (DriveHQ takes two ids); its url fn splits it back apart.
const BYTES_SOURCES = {
  austin: { idRe: /^[0-9]{1,8}$/, url: (id) => `https://cctv.austinmobility.io/image/${id}.jpg` },
  houston: { idRe: /^[0-9]{1,8}$/, url: (id) => `https://www.houstontranstar.org/snapshots/cctv/${id}.jpg` },
  arlington: { idRe: /^[A-Za-z0-9 _-]{1,64}$/, url: (id) => `https://webapps.arlingtontx.gov/webcams/${encodeURIComponent(id)}.jpg` },
  porthou: { idRe: /^[A-Za-z0-9_]{1,32}$/, url: (id) => `https://info.porthouston.com/vtraffic/gateimages/${id}.jpg` },
  hays: { idRe: /^[0-9]{1,12}-[0-9]{1,12}$/, url: (id) => { const [pid, sid] = id.split('-'); return `https://cameraftpapi.drivehq.com/api/Camera/GetCameraThumbnail.ashx?parentID=${pid}&shareID=${sid}`; } },
  // Ozolio relay: the poster carries no Last-Modified, so the stamp stays empty and the viewer
  // renders these through its no-capture-time path rather than the aging badge
  swrecon: { idRe: /^[A-Z]{3}_[A-Za-z0-9]{4,24}$/, url: (id) => `https://relay.ozolio.com/pub.api?cmd=poster&oid=${id}` },
  corpus: { idRe: /^[A-Z]{3}_[A-Za-z0-9]{4,24}$/, url: (id) => `https://relay.ozolio.com/pub.api?cmd=poster&oid=${id}` },
};

export async function onRequestGet(context) {
  // params arrive percent-encoded, unlike server.py's unquote; without this every id holding a
  // space, '@' or '&' fails its own charset check. decodeURIComponent throws on a malformed escape.
  let source, id;
  try {
    source = decodeURIComponent(String(context.params.district || ''));
    id = decodeURIComponent(String(context.params.icd || ''));
  } catch {
    return new Response('bad request', { status: 400 });
  }
  if (DIST_RE.test(source)) return itsSnapshot(context, source, id);
  if (source === 'atxfloods') return ATX_ID_RE.test(id) ? atxSnapshot(context, id) : new Response('bad request', { status: 400 });
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
    const up = await fetch(`${ITS_UPSTREAM}?icdId=${encodeURIComponent(icd.split(ICD_SLASH).join('/'))}&districtCode=${district}`, { headers: { Accept: 'application/json', 'User-Agent': UA } });
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

// ATX Floods: the newest filename rotates every ~3 min, so the id is resolved against the live
// inventory here rather than baked into a URL the client builds. Two hops, one edge-cached result.
async function atxSnapshot(context, id) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(context.request.url).origin + `/api/cam/atxfloods/${id}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  let body, captured;
  try {
    const list = await fetch(ATX_LIST, { headers: { Accept: 'application/json', 'User-Agent': UA }, cf: { cacheTtl: 90, cacheEverything: true } });
    if (!list.ok) return new Response(`upstream ${list.status}`, { status: 502 });
    const d = await list.json();
    const cam = ((d && d.attributes) || []).find((c) => String(c.id) === id);
    const im = cam && (cam.images || [])[0];
    if (!im || !ATX_NAME_RE.test(String(im.image_name || ''))) return new Response('no snapshot', { status: 502 });
    const up = await fetch(ATX_IMG + encodeURIComponent(im.image_name), { headers: { Accept: 'image/jpeg', 'User-Agent': UA } });
    if (!up.ok) return new Response(`upstream ${up.status}`, { status: 502 });
    if (!/image/i.test(up.headers.get('content-type') || '')) return new Response('not an image', { status: 502 });
    body = await up.arrayBuffer();
    captured = String(im.created_at || '').replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 64);
  } catch {
    return new Response('upstream error', { status: 502 });
  }
  const res = jpegResponse(body, captured);
  context.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
