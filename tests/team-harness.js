'use strict';

/*
 * Lightweight harness for the TeamRelay Durable Object (workers/team-relay/team-relay.js).
 *
 * The Worker ships as an ES module (`export class TeamRelay` / `export default`). We read it
 * verbatim (never edit it), strip only the two `export` keywords, and evaluate the source in a
 * Node `vm` sandbox stocked with the handful of globals the DO touches (crypto.randomUUID, URL,
 * the usual value types). An appended epilogue hands the class back. Tests then drive the DO by
 * calling its do* methods directly against a mock Durable Object storage — no network, no workerd.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');

const DO_FILE = path.join(__dirname, '..', 'workers', 'team-relay', 'team-relay.js');

function loadTeamRelay() {
  let src = fs.readFileSync(DO_FILE, 'utf8');
  src = src.replace(/^export class TeamRelay/m, 'class TeamRelay');
  src = src.replace(/^export default \{/m, 'const __workerDefault = {');
  const epilogue = '\n;globalThis.__TEAMRELAY = TeamRelay;\n';

  const sandbox = {
    console,
    Math, Date, JSON, RegExp, Array, Object, String, Number, Boolean, Map, Set,
    parseInt, parseFloat, isNaN, isFinite, Promise,
    URL, URLSearchParams,
    crypto: { randomUUID: () => nodeCrypto.randomUUID() },
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(src + epilogue, context, { filename: 'team-relay-bundle.js' });
  return sandbox.__TEAMRELAY;
}

// Mock Durable Object storage + state: an in-memory key/value store with the async surface the DO
// uses (get/put/delete/deleteAll/setAlarm). blockConcurrencyWhile just runs the callback inline.
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
    },
    blockConcurrencyWhile(fn) { return fn(); },
  };
}

const TeamRelay = loadTeamRelay();

// Build a DO instance with a freshly created team; returns { relay, teamId }.
async function newTeam(name = 'Test Team', defaults = null) {
  const relay = new TeamRelay(makeState(), {});
  await relay.ready;
  const teamId = nodeCrypto.randomUUID();
  const now = Date.now();
  const out = await relay.doCreate({ teamId, name, defaults }, now);
  if (out._status && out._status >= 400) throw new Error(`doCreate failed: ${JSON.stringify(out)}`);
  return { relay, teamId };
}

module.exports = { TeamRelay, makeState, newTeam };
