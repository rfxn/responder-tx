// Pages Function: GET /api/team/admin/overview — token-gated master oversight aggregation.
// Enumerates every registered team and returns each team's live makeup + a combined viewer roster.
// This is the ONLY team-enumeration path in the system; without a matching X-Admin-Token it fails
// safe (403, empty). The token is a Pages secret (env.TEAM_ADMIN_TOKEN), never in git; the LAN
// server injects it when proxying. The public mirror never carries the token, so it can never list.
import { authorized, json } from './util.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env || !env.TEAM) return json({ error: 'team relay not configured' }, 503);
  if (!authorized(request, env)) return json({ error: 'forbidden' }, 403);
  const stub = env.TEAM.get(env.TEAM.idFromName('registry'));
  return stub.fetch(new Request('https://do/overview', { method: 'GET' }));
}
