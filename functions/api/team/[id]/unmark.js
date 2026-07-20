// Pages Function: POST /api/team/<id>/unmark — remove a shared team marker by id.
// Members only (viewers rejected in the DO). Any member may clear a marker in a trusted team.
import { forward } from './_forward.js';

export const onRequestPost = (context) => forward(context, 'unmark');
