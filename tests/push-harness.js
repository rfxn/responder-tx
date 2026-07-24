'use strict';

/*
 * Lightweight harness for the PushRegistry Durable Object (workers/push-alerts/push-alerts.js).
 * Same non-invasive pattern as team-harness.js: read the Worker sources verbatim, strip only the
 * ES-module keywords, evaluate in a Node vm sandbox, and drive the DO's do* methods directly
 * against a mock storage. fetch is injectable per test (alerts feed, event.json, push services).
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');

const WORKER_DIR = path.join(__dirname, '..', 'workers', 'push-alerts');

function loadPushRegistry() {
  const stripModuleKeywords = (s) => s
    .replace(/^import .*$/gm, '')
    .replace(/^export (async function|function|const|class)/gm, '$1');
  const vapidSrc = stripModuleKeywords(fs.readFileSync(path.join(WORKER_DIR, 'vapid.js'), 'utf8'));
  const encSrc = stripModuleKeywords(fs.readFileSync(path.join(WORKER_DIR, 'webpush-encrypt.js'), 'utf8'));
  let src = stripModuleKeywords(fs.readFileSync(path.join(WORKER_DIR, 'push-alerts.js'), 'utf8'));
  src = src.replace(/^export default \{/m, 'const __workerDefault = {');
  const epilogue = '\n;globalThis.__PUSH = { PushRegistry, allowedEndpoint, isFfe, geomBbox, bboxOverlap, '
    + 'vapidJwk, signVapidJwt, b64u, b64uDecode, encryptPayload, '
    + 'CAT_RANK, PUSH_STRINGS, fmt, gaugePayload, digestPayload, ffePayload, confirmPayload, '
    + 'sanitizePrefs, effectiveTierRank, gaugeRank, crossingStep, applyHourlyCap, verifyNudgeSig };\n';

  const sandbox = {
    console,
    Math, Date, JSON, RegExp, Array, Object, String, Number, Boolean, Map, Set,
    parseInt, parseFloat, isNaN, isFinite, Promise, Infinity,
    URL, URLSearchParams, TextEncoder, TextDecoder, DataView,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    Uint8Array, ArrayBuffer, Error, Response, Request, Headers,
    crypto: nodeCrypto.webcrypto,
    fetch: (...args) => sandbox.__fetchMock(...args),
    __fetchMock: async () => { throw new Error('fetch not mocked'); },
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(vapidSrc + '\n;\n' + encSrc + '\n;\n' + src + epilogue, context, { filename: 'push-alerts-bundle.js' });
  return { api: sandbox.__PUSH, sandbox };
}

// mock DO storage with the surface the registry uses: get/put/delete/deleteAll/setAlarm/list(prefix)
function makeState() {
  const store = new Map();
  let alarm = null;
  return {
    _store: store,
    storage: {
      async get(k) { return store.has(k) ? store.get(k) : undefined; },
      async put(k, v) { store.set(k, v); },
      async delete(k) { store.delete(k); },
      async deleteAll() { store.clear(); },
      async setAlarm(t) { alarm = t; },
      async getAlarm() { return alarm; },
      async list({ prefix = '' } = {}) {
        const out = new Map();
        for (const [k, v] of store) if (k.startsWith(prefix)) out.set(k, v);
        return out;
      },
    },
  };
}

// real (test-only) VAPID keypair so JWT signing paths run end to end in the harness
function makeVapidKeys() {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
  return { publicB64u: point.toString('base64url'), privateB64u: priv.d, publicKeyObj: publicKey };
}

const loaded = loadPushRegistry();
const TEST_KEYS = makeVapidKeys();

function newRegistry(envOverrides = {}) {
  const state = makeState();
  const env = {
    VAPID_PUBLIC_KEY: TEST_KEYS.publicB64u,
    VAPID_PRIVATE_KEY: TEST_KEYS.privateB64u,
    ...envOverrides,
  };
  const reg = new loaded.api.PushRegistry(state, env);
  return { reg, state, env };
}

// minimal Response stand-in for mocked fetch results
const mockRes = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  async json() { return body; },
  async text() { return JSON.stringify(body); },
});

// a browser-side subscription for encryption tests: P-256 keypair (p256dh) + 16-byte auth secret
function makeClientKeys() {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwkPub = publicKey.export({ format: 'jwk' });
  const jwkPriv = privateKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwkPub.x, 'base64url'), Buffer.from(jwkPub.y, 'base64url')]);
  const auth = nodeCrypto.randomBytes(16);
  return {
    p256dh: point.toString('base64url'),
    auth: auth.toString('base64url'),
    authBytes: auth,
    uaPub: point,
    privD: Buffer.from(jwkPriv.d, 'base64url'),
  };
}

// independent RFC 8291/8188 receiver (node:crypto, no shared code with the Worker encryptor):
// parse the aes128gcm header, ECDH + HKDF chain, AES-128-GCM decrypt, strip the 0x02 padding
function decryptPush(client, message) {
  const buf = Buffer.from(message);
  const salt = buf.subarray(0, 16);
  const rs = buf.readUInt32BE(16);
  const idlen = buf[20];
  const asPub = buf.subarray(21, 21 + idlen);
  const ciphertext = buf.subarray(21 + idlen);
  const ecdh = nodeCrypto.createECDH('prime256v1');
  ecdh.setPrivateKey(client.privD);
  const shared = ecdh.computeSecret(asPub);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), client.uaPub, asPub]);
  const ikm = Buffer.from(nodeCrypto.hkdfSync('sha256', shared, client.authBytes, keyInfo, 32));
  const cek = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const body = ciphertext.subarray(0, ciphertext.length - 16);
  const d = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(tag);
  const padded = Buffer.concat([d.update(body), d.final()]);
  let end = padded.length;
  while (end > 0 && padded[end - 1] === 0) end -= 1; // trailing zero pad
  if (padded[end - 1] !== 2) throw new Error('last-record delimiter 0x02 missing');
  return { plaintext: padded.subarray(0, end - 1), rs, salt, asPub };
}

module.exports = {
  ...loaded.api, sandbox: loaded.sandbox, makeState, newRegistry, mockRes, TEST_KEYS,
  makeClientKeys, decryptPush,
};
