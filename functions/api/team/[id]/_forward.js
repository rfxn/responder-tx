// Shared forwarder for the team-scoped relay proxies. No onRequest export → Pages does not route it.
import { json } from '../_json.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// forward(context, action, opts): guard the TEAM binding, validate the team id, resolve the DO stub,
// and proxy. POST routes forward the JSON body; GET routes pass UUID-valid `query` params through.
export async function forward(context, action, { method = 'POST', query = [] } = {}) {
  const { request, env, params } = context;
  if (!env || !env.TEAM) return json({ error: 'team relay not configured' }, 503);
  const teamId = String(params.id || '');
  if (!UUID_RE.test(teamId)) return json({ error: 'bad team id' }, 400);
  const stub = env.TEAM.get(env.TEAM.idFromName(teamId));
  if (method === 'GET') {
    const src = new URL(request.url).searchParams;
    const doUrl = new URL(`https://do/${action}`);
    for (const name of query) {
      const val = src.get(name) || '';
      if (UUID_RE.test(val)) doUrl.searchParams.set(name, val);
    }
    return stub.fetch(new Request(doUrl, { method: 'GET' }));
  }
  let body = {};
  try { body = (await request.json()) || {}; } catch { body = {}; }
  return stub.fetch(new Request(`https://do/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}
