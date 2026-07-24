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
  let vapidSrc = fs.readFileSync(path.join(WORKER_DIR, 'vapid.js'), 'utf8');
  vapidSrc = vapidSrc.replace(/^export (async function|function)/gm, '$1');
  let src = fs.readFileSync(path.join(WORKER_DIR, 'push-alerts.js'), 'utf8');
  src = src.replace(/^import .*from '\.\/vapid\.js';$/m, '');
  src = src.replace(/^export class PushRegistry/m, 'class PushRegistry');
  src = src.replace(/^export default \{/m, 'const __workerDefault = {');
  const epilogue = '\n;globalThis.__PUSH = { PushRegistry, allowedEndpoint, isFfe, geomBbox, bboxOverlap, vapidJwk, signVapidJwt, b64u, b64uDecode };\n';

  const sandbox = {
    console,
    Math, Date, JSON, RegExp, Array, Object, String, Number, Boolean, Map, Set,
    parseInt, parseFloat, isNaN, isFinite, Promise, Infinity,
    URL, URLSearchParams, TextEncoder, TextDecoder,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    Uint8Array, ArrayBuffer, Error, Response, Request, Headers,
    crypto: nodeCrypto.webcrypto,
    fetch: (...args) => sandbox.__fetchMock(...args),
    __fetchMock: async () => { throw new Error('fetch not mocked'); },
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(vapidSrc + '\n;\n' + src + epilogue, context, { filename: 'push-alerts-bundle.js' });
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

module.exports = { ...loaded.api, sandbox: loaded.sandbox, makeState, newRegistry, mockRes, TEST_KEYS };
