// Pages Function: POST /api/team/<id>/marker — a MEMBER drops a shared team-scoped map marker
// (waypoint / hazard / search-area). The DO enforces role (viewers rejected), coordinate range,
// and the per-team marker cap. Team-scoped write surface for private teams only.
import { forward } from './_forward.js';

export const onRequestPost = (context) => forward(context, 'marker');
