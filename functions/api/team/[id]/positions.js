// Pages Function: POST /api/team/<id>/positions — a MEMBER backfills queued fixes in one batch.
// The DO enforces role/auth and validates every fix (timestamps, coordinates, batch cap).
import { forward } from './_forward.js';

export const onRequestPost = (context) => forward(context, 'positions');
