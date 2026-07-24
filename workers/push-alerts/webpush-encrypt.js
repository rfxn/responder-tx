// RFC 8291 Web Push message encryption (aes128gcm content coding, RFC 8188) via WebCrypto.
// Testable in Node 18+ (node:crypto.webcrypto implements the same subtle API).
'use strict';

import { b64uDecode } from './vapid.js';

const RECORD_SIZE = 4096; // single-record messages only; payloads stay well under the 4 KB Web Push cap

function concatBytes(...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

async function hkdf(subtle, salt, ikm, info, len) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

// encryptPayload(subtle, getRandomValues, p256dhB64u, authB64u, plaintextBytes) -> aes128gcm message
// (header salt|rs|idlen|as_public followed by one AES-128-GCM record with the 0x02 last-record pad)
export async function encryptPayload(subtle, getRandomValues, p256dhB64u, authB64u, plaintext) {
  const uaPub = b64uDecode(p256dhB64u);
  if (uaPub.length !== 65 || uaPub[0] !== 4) throw new Error('client p256dh is not an uncompressed P-256 point');
  const authSecret = b64uDecode(authB64u);
  if (authSecret.length !== 16) throw new Error('client auth secret must be 16 bytes');
  if (plaintext.length > RECORD_SIZE - 120) throw new Error('payload too large for one record');

  const asKeys = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  const enc = new TextEncoder();
  const ikm = await hkdf(subtle, authSecret, ecdhSecret, concatBytes(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = getRandomValues(new Uint8Array(16));
  const cek = await hkdf(subtle, salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(subtle, salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const gcmKey = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = concatBytes(plaintext, new Uint8Array([2])); // 0x02 delimiter marks the last record
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, gcmKey, record));

  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = 65;
  header.set(asPub, 21);
  return concatBytes(header, ciphertext);
}
