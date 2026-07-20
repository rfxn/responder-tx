// Pages Function: POST /api/team/create — mint a new private team.
// Generates a crypto-strong UUID (unguessable, non-enumerable), initializes its Durable Object,
// and returns the UUID + share link. The DO holds all team state; nothing is written to the repo.
const NAME_MAX = 40;

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env || !env.TEAM) return json({ error: 'team relay not configured' }, 503);
  let body = {};
  try { body = (await request.json()) || {}; } catch { body = {}; }
  const teamId = crypto.randomUUID();
  const stub = env.TEAM.get(env.TEAM.idFromName(teamId));
  const res = await stub.fetch(new Request('https://do/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId, name: String(body.name || '').slice(0, NAME_MAX), defaults: body.defaults || null }),
  }));
  const data = await res.json();
  if (data && data.teamId) data.url = `${new URL(request.url).origin}/?team=${data.teamId}`;
  return json(data, res.status);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}
