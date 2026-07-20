// Pages Function: POST /api/team/<id>/leave — one-tap stop: drop the caller from the team now.
// Server-side TTL is the backstop when a device can't send this (force-closed, lost signal).
import { forward } from './_forward.js';

export const onRequestPost = (context) => forward(context, 'leave');
