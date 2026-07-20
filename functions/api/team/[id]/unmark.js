// Pages Function: POST /api/team/<id>/unmark — remove a shared team marker by id.
// Members only (viewers rejected in the DO). Any member may clear a marker in a trusted team.
import { json } from '../_json.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function onRequestPost(context) {
  const { request, env, params } = context;
  if (!env || !env.TEAM) return json({ error: 'team relay not configured' }, 503);
  const teamId = String(params.id || '');
  if (!UUID_RE.test(teamId)) return json({ error: 'bad team id' }, 400);
  let body = {};
  try { body = (await request.json()) || {}; } catch { body = {}; }
  const stub = env.TEAM.get(env.TEAM.idFromName(teamId));
  return stub.fetch(new Request('https://do/unmark', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}
