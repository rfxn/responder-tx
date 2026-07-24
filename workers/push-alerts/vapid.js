// VAPID (RFC 8292) ES256 JWT signing via WebCrypto — no Node web-push lib in Workers.
// Testable in Node 18+ (node:crypto.webcrypto implements the same subtle API).
'use strict';

export function b64u(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(s) {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// build an EC P-256 private JWK from the base64url public point (0x04||x||y, 65 bytes)
// and the base64url raw private scalar d (32 bytes)
export function vapidJwk(publicKeyB64u, privateKeyB64u) {
  const point = b64uDecode(publicKeyB64u);
  if (point.length !== 65 || point[0] !== 4) throw new Error('VAPID public key is not an uncompressed P-256 point');
  return {
    kty: 'EC', crv: 'P-256',
    x: b64u(point.slice(1, 33)),
    y: b64u(point.slice(33, 65)),
    d: String(privateKeyB64u),
  };
}

// signed JWT for one push-service origin; WebCrypto ECDSA emits raw r||s, which is the JWS ES256 wire format
export async function signVapidJwt(aud, subject, jwk, subtle, nowMs) {
  const enc = new TextEncoder();
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({
    aud, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject,
  })));
  const input = `${header}.${claims}`;
  const key = await subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(input)));
  return `${input}.${b64u(sig)}`;
}
