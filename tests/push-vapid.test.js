'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const { b64u, b64uDecode, vapidJwk, signVapidJwt, TEST_KEYS } = require('./push-harness.js');

test('b64u round-trips arbitrary bytes without padding characters', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 62, 63]);
  const s = b64u(bytes);
  assert.ok(!/[+/=]/.test(s), 'url-safe alphabet only');
  assert.deepEqual([...b64uDecode(s)], [...bytes]);
});

test('vapidJwk rebuilds a valid P-256 private JWK from the public point + scalar', () => {
  const jwk = vapidJwk(TEST_KEYS.publicB64u, TEST_KEYS.privateB64u);
  assert.equal(jwk.kty, 'EC');
  assert.equal(jwk.crv, 'P-256');
  assert.equal(jwk.d, TEST_KEYS.privateB64u);
  // importable by node webcrypto as a signing key
  return nodeCrypto.webcrypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
});

test('vapidJwk rejects a key that is not an uncompressed point', () => {
  assert.throws(() => vapidJwk(b64u(new Uint8Array(32)), TEST_KEYS.privateB64u));
});

test('signVapidJwt emits a verifiable ES256 JWT with aud/sub/exp claims', async () => {
  const now = 1753000000000;
  const jwk = vapidJwk(TEST_KEYS.publicB64u, TEST_KEYS.privateB64u);
  const jwt = await signVapidJwt('https://fcm.googleapis.com', 'mailto:proj@rfxn.com', jwk, nodeCrypto.webcrypto.subtle, now);
  const [h, c, s] = jwt.split('.');
  assert.ok(h && c && s, 'three JWT segments');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  assert.deepEqual(header, { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'mailto:proj@rfxn.com');
  assert.equal(claims.exp, Math.floor(now / 1000) + 12 * 3600, 'expires 12h out');
  // verify the raw r||s signature against the real public key (the check a push service performs)
  const ok = nodeCrypto.verify(
    'sha256',
    Buffer.from(`${h}.${c}`),
    { key: TEST_KEYS.publicKeyObj, dsaEncoding: 'ieee-p1363' },
    Buffer.from(s, 'base64url'),
  );
  assert.equal(ok, true, 'ES256 signature verifies');
});
