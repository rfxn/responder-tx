// Pages Function: POST /api/team/<id>/position — a MEMBER publishes its live position.
// The DO enforces role (viewers are rejected) and validates coordinates authoritatively.
import { forward } from './_forward.js';

export const onRequestPost = (context) => forward(context, 'position');
