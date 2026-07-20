// Pages Function: GET /api/team/admin/list — token-gated lightweight team enumeration (ids + name
// + created only, no positions). Same 403-fail-safe token gate as overview; see util.js.
import { authorized, json } from './util.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env || !env.TEAM) return json({ error: 'team relay not configured' }, 503);
  if (!authorized(request, env)) return json({ error: 'forbidden' }, 403);
  const stub = env.TEAM.get(env.TEAM.idFromName('registry'));
  return stub.fetch(new Request('https://do/reglist', { method: 'GET' }));
}
