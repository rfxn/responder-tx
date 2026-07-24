// Pages Function: POST /api/push/subscribe — store an anonymous push subscription (endpoint +
// browser keys + prefs + language, nothing else). Endpoint allowlist, caps, and rate limits are
// enforced authoritatively in the PushRegistry DO.
import { forward } from './_util.js';

export const onRequestPost = (context) => forward(context, 'subscribe');
