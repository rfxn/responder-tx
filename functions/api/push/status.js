// Pages Function: GET /api/push/status — {configured, lastEval, vapidKey}. The client fetches
// the public VAPID key from here (never hardcoded) so a key rotation needs no app release.
import { forward } from './_util.js';

export const onRequestGet = (context) => forward(context, 'status', { method: 'GET' });
