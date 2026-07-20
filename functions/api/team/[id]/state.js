// Pages Function: GET /api/team/<id>/state?ephemeralId=... — read team state (members+viewers+
// positions+trails). Available to members and viewers. Polling refreshes the caller's presence.
import { json } from '../_json.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function onRequestGet(context) {
  const { request, env, params } = context;
  if (!env || !env.TEAM) return json({ error: 'team relay not configured' }, 503);
  const teamId = String(params.id || '');
  if (!UUID_RE.test(teamId)) return json({ error: 'bad team id' }, 400);
  const eid = new URL(request.url).searchParams.get('ephemeralId') || '';
  const stub = env.TEAM.get(env.TEAM.idFromName(teamId));
  const doUrl = new URL('https://do/state');
  if (UUID_RE.test(eid)) doUrl.searchParams.set('ephemeralId', eid);
  return stub.fetch(new Request(doUrl, { method: 'GET' }));
}
