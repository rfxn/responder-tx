// Pages Function: POST /api/team/<id>/update — change your own record after joining:
// role, SAR type/specialty/skills, and/or status. The DO re-validates against its allow-sets.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function onRequestPost(context) {
  const { request, env, params } = context;
  if (!env || !env.TEAM) return json({ error: 'team relay not configured' }, 503);
  const teamId = String(params.id || '');
  if (!UUID_RE.test(teamId)) return json({ error: 'bad team id' }, 400);
  let body = {};
  try { body = (await request.json()) || {}; } catch { body = {}; }
  const stub = env.TEAM.get(env.TEAM.idFromName(teamId));
  return stub.fetch(new Request('https://do/update', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}
