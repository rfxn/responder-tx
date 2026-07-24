// Pages Function: POST /api/push/nudge — HMAC-signed best-effort evaluator nudge from
// run-cycle.sh after each data deploy. The signature covers the raw body bytes, so this route
// forwards the body VERBATIM (no JSON re-serialization) plus the X-Push-Sig header; the
// PushRegistry DO verifies HMAC + timestamp window. The */5 Worker cron stays the guaranteed path.
import { json, BODY_MAX } from './_util.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env || !env.PUSH) return json({ error: 'push not configured' }, 503);
  let raw = '';
  try { raw = await request.text(); } catch { raw = ''; }
  if (raw.length > BODY_MAX) return json({ error: 'body too large' }, 413);
  const stub = env.PUSH.get(env.PUSH.idFromName('registry'));
  return stub.fetch(new Request('https://do/nudge', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Push-Sig': request.headers.get('X-Push-Sig') || '',
    },
    body: raw,
  }));
}
