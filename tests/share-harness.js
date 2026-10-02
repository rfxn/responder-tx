'use strict';

/*
 * Harness for the short-link backend: the ShareLinks Durable Object (workers/share-links/) and the
 * Pages Functions that front it (functions/api/share/, functions/s/). Same non-invasive pattern as
 * push-harness.js: read the sources verbatim, strip only the ES-module keywords, evaluate in a vm,
 * and drive the shipped handlers against a mock DO storage and a mock SHARE namespace.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');

const stripModule = (s) => s
  .replace(/^import .*$/gm, '')
  .replace(/^export default \{/m, 'const __workerDefault = {')
  .replace(/^export (async function|function|const|class|let)/gm, '$1');

function sandboxFor() {
  const sandbox = {
    console, Math, Date, JSON, RegExp, Array, Object, String, Number, Boolean, Map, Set, Promise, Error,
    parseInt, parseFloat, isNaN, isFinite,
    URL, URLSearchParams, TextEncoder, TextDecoder, Uint8Array,
    Request, Response, Headers,
    crypto: nodeCrypto.webcrypto,
  };
  sandbox.globalThis = sandbox;
  return vm.createContext(sandbox);
}

function loadWorker() {
  const src = stripModule(fs.readFileSync(path.join(ROOT, 'workers', 'share-links', 'share-links.js'), 'utf8'));
  const ctx = sandboxFor();
  vm.runInContext(`${src}\n;globalThis.__SHARE = { ShareLinks, normalizeQuery, codeFor, ipBucket, VIEW_KEYS, RECORD_KEYS, `
    + 'Q_MAX, CODE_RE, PROBE_MAX, MAX_ROWS, RATE_MAX, RATE_WINDOW_MS, HIT_WRITE_MS, workerDefault: __workerDefault };',
  ctx, { filename: 'share-links-bundle.js' });
  return ctx.__SHARE;
}

// a Pages Function file with its relative imports inlined ahead of it, as wrangler bundles it
function loadFunction(rel, deps) {
  const parts = deps.concat([rel]).map((f) => stripModule(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  const ctx = sandboxFor();
  vm.runInContext(`${parts.join('\n;\n')}\n;globalThis.__FN = { `
    + `onRequestGet: typeof onRequestGet === 'function' ? onRequestGet : undefined, `
    + `onRequestHead: typeof onRequestHead === 'function' ? onRequestHead : undefined, `
    + `onRequestPost: typeof onRequestPost === 'function' ? onRequestPost : undefined };`,
  ctx, { filename: rel });
  return ctx.__FN;
}

// DO storage with the surface the class uses: get, put(key, value) and put({k: v, ...}) atomically
function makeState() {
  const store = new Map();
  const writes = [];
  let gate = Promise.resolve();
  return {
    _store: store,
    _writes: writes,
    storage: {
      async get(k) { return store.has(k) ? structuredClone(store.get(k)) : undefined; },
      async put(k, v) {
        const entries = typeof k === 'object' ? Object.entries(k) : [[k, v]];
        for (const [key, val] of entries) { store.set(key, structuredClone(val)); writes.push(key); }
      },
      async delete(k) { store.delete(k); },
    },
    // serializes the callbacks the way the runtime holds other events until one settles
    blockConcurrencyWhile(fn) {
      const run = gate.then(() => fn());
      gate = run.catch(() => {});
      return run;
    },
  };
}

const api = loadWorker();

function newLinks() {
  const state = makeState();
  const links = new api.ShareLinks(state, {});
  return { links, state };
}

// env.SHARE stand-in that routes every stub to one in-process DO instance
function makeNamespace(links) {
  const names = [];
  const calls = [];
  return {
    names,
    calls,
    idFromName(n) { names.push(n); return `id:${n}`; },
    get() {
      return {
        fetch: async (req) => {
          calls.push({ url: req.url, method: req.method, ip: req.headers.get('X-Client-IP') });
          return links.fetch(req);
        },
      };
    },
  };
}

const shareFn = loadFunction('functions/api/share/index.js', ['functions/api/share/_util.js']);
const shortFn = loadFunction('functions/s/[code].js', ['functions/api/share/_util.js']);

/* The /share<digits> alias is a Cloudflare _redirects rule. This applies the file's rules with that
   engine's splat semantics (one greedy `*`, substituted as :splat); the real engine is exercised by
   the wrangler pages dev run recorded in workers/share-links/README.md. */
function redirectFor(pathname) {
  const lines = fs.readFileSync(path.join(ROOT, '_redirects'), 'utf8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [from, to, status] = t.split(/\s+/);
    const re = new RegExp(`^${from.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('(.*)')}$`);
    const m = pathname.match(re);
    if (m) return { to: to.replace(':splat', m[1] || ''), status: Number(status || 301) };
  }
  return null;
}

// the Worker as a real ES module, so its export surface is what the runtime will see
async function importWorkerModule() {
  const os = require('node:os');
  const { pathToFileURL } = require('node:url');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-links-'));
  const file = path.join(dir, 'share-links.mjs');
  try {
    fs.copyFileSync(path.join(ROOT, 'workers', 'share-links', 'share-links.js'), file);
    return await import(pathToFileURL(file).href);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = { ...api, makeState, newLinks, makeNamespace, shareFn, shortFn, redirectFor, importWorkerModule };
