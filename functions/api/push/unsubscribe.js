// Pages Function: POST /api/push/unsubscribe — delete the row for this endpoint. Possession of
// the unguessable endpoint URL is the only credential (no identity exists to authenticate).
import { forward } from './_util.js';

export const onRequestPost = (context) => forward(context, 'unsubscribe');
