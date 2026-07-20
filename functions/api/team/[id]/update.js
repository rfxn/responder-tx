// Pages Function: POST /api/team/<id>/update — change your own record after joining:
// role, SAR type/specialty/skills, and/or status. The DO re-validates against its allow-sets.
import { forward } from './_forward.js';

export const onRequestPost = (context) => forward(context, 'update');
