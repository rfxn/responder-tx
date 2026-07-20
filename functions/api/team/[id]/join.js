// Pages Function: POST /api/team/<id>/join — enter a team as member (shares location) or
// viewer (does not). Handle >= 4 chars and role are re-validated authoritatively in the DO.
import { forward } from './_forward.js';

export const onRequestPost = (context) => forward(context, 'join');
