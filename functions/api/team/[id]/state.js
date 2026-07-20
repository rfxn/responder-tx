// Pages Function: GET /api/team/<id>/state?ephemeralId=... — read team state (members+viewers+
// positions+trails). Available to members and viewers. Polling refreshes the caller's presence.
import { forward } from './_forward.js';

export const onRequestGet = (context) => forward(context, 'state', { method: 'GET', query: ['ephemeralId'] });
