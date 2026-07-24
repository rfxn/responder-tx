// Pages Function: POST /api/push/resubscribe — pushsubscriptionchange migration. The service
// worker presents the old endpoint (possession is the credential) plus the browser's replacement
// subscription; the registry carries prefs/language/dedup state over so follows survive rotation.
import { forward } from './_util.js';

export const onRequestPost = (context) => forward(context, 'resubscribe');
