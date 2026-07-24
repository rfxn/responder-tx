// Pages Function: POST /api/push/admin/fire — token-gated real test push to one stored
// subscription ({endpoint}) or all (body omitted, capped at one send batch). Returns the
// push-service status codes so the delivery chain is verifiable end to end.
import { authorized } from './util.js';
import { json, forward } from '../_util.js';

export async function onRequestPost(context) {
  if (!authorized(context.request, context.env)) return json({ error: 'forbidden' }, 403);
  return forward(context, 'testfire');
}
