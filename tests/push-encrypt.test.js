'use strict';

/*
 * RFC 8291/8188 aes128gcm round-trip: the Worker's encryptPayload output is decrypted with the
 * harness's independent node:crypto receiver against a freshly generated client keypair.
 * A successful decrypt proves interop far better than fixture comparison would.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const { encryptPayload, makeClientKeys, decryptPush } = require('./push-harness.js');

const subtle = nodeCrypto.webcrypto.subtle;
const rand = (a) => nodeCrypto.webcrypto.getRandomValues(a);

test('aes128gcm payload round-trips through an independent node:crypto receiver', async () => {
  const client = makeClientKeys();
  const payload = JSON.stringify({
    t: 'gauge', lid: 'SRRT2', lang: 'en',
    title: 'Runge, San Antonio River reached MODERATE flood stage',
    body: '34.8 ft observed 14:56 UTC. Not a WEA/911 service.',
    url: '/?hydro=SRRT2', tag: 'g-SRRT2',
  });
  const msg = await encryptPayload(subtle, rand, client.p256dh, client.auth, new TextEncoder().encode(payload));
  const out = decryptPush(client, msg);
  assert.equal(out.plaintext.toString(), payload, 'plaintext survives the round trip');
  assert.equal(out.rs, 4096, 'record size header');
  assert.equal(out.salt.length, 16);
  assert.equal(out.asPub.length, 65, 'uncompressed server public key in keyid');
  assert.equal(out.asPub[0], 4);
});

test('every message uses a fresh ephemeral key and salt', async () => {
  const client = makeClientKeys();
  const pt = new TextEncoder().encode('{"t":"confirm"}');
  const a = await encryptPayload(subtle, rand, client.p256dh, client.auth, pt);
  const b = await encryptPayload(subtle, rand, client.p256dh, client.auth, pt);
  assert.notDeepEqual([...a.slice(0, 16)], [...b.slice(0, 16)], 'salt differs');
  assert.notDeepEqual([...a.slice(21, 86)], [...b.slice(21, 86)], 'ephemeral server key differs');
  assert.notDeepEqual([...a.slice(86)], [...b.slice(86)], 'ciphertext differs');
  // and each still decrypts
  assert.equal(decryptPush(client, a).plaintext.toString(), '{"t":"confirm"}');
  assert.equal(decryptPush(client, b).plaintext.toString(), '{"t":"confirm"}');
});

test('utf-8 Spanish payloads survive encryption intact', async () => {
  const client = makeClientKeys();
  const payload = JSON.stringify({ title: 'Alertas activadas', body: 'etapa de inundación MODERADA · No sustituye a WEA ni al 911.' });
  const msg = await encryptPayload(subtle, rand, client.p256dh, client.auth, new TextEncoder().encode(payload));
  assert.equal(decryptPush(client, msg).plaintext.toString('utf8'), payload);
});

test('malformed client keys are rejected, never silently mis-encrypted', async () => {
  const client = makeClientKeys();
  const pt = new TextEncoder().encode('x');
  await assert.rejects(() => encryptPayload(subtle, rand, 'AAAA', client.auth, pt), /p256dh/);
  await assert.rejects(() => encryptPayload(subtle, rand, client.p256dh, 'AAAA', pt), /auth/);
  const big = new TextEncoder().encode('y'.repeat(4200));
  await assert.rejects(() => encryptPayload(subtle, rand, client.p256dh, client.auth, big), /too large/);
});
