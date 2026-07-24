// Pages Function: POST /api/push/renew — silent boot-time keepalive; refreshes the row's 60-day
// TTL so any device that opens the board stays live and abandoned devices age out.
import { forward } from './_util.js';

export const onRequestPost = (context) => forward(context, 'renew');
