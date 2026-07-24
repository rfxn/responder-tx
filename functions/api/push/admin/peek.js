// Pages Function: POST /api/push/admin/peek — token-gated registry introspection for ops
// verification (subscription/queue counts only; endpoints are never disclosed).
import { authorized } from './util.js';
import { json, forward } from '../_util.js';

export async function onRequestPost(context) {
  if (!authorized(context.request, context.env)) return json({ error: 'forbidden' }, 403);
  return forward(context, 'peek');
}
