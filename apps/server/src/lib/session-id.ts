// Session-id input parsing. The API RETURNS session ids in the canonical
// prefixed form `ses_<uuid>`, so a caller passes that back when referencing a
// session (e.g. agent-session create's `driftstack_session_id`). The DB keys on
// the BARE uuid. Accepts EITHER form (prefixed canonical OR bare uuid) and
// returns the bare uuid, throwing 400 on anything else. Mirrors parseProfileId.

import { BadRequestError } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID_PREFIX = 'ses_';

/** ses_<uuid> | <uuid> → <uuid>. Throws BadRequestError (400) otherwise. */
export function parseSessionId(input: string): string {
  const bare = input.startsWith(SESSION_ID_PREFIX) ? input.slice(SESSION_ID_PREFIX.length) : input;
  if (!UUID_RE.test(bare)) {
    throw new BadRequestError('Invalid driftstack_session_id. Expected "ses_<uuid>".');
  }
  return bare;
}
