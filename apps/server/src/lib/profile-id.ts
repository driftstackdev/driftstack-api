// Profile-id input parsing. The API RETURNS profile ids in the canonical
// prefixed form `prof_<uuid>` (ProfileIdSchema), so a caller naturally passes
// that back when referencing a profile. The DB + services key on the BARE uuid.
// This accepts EITHER form (prefixed canonical OR bare uuid — backward-compatible
// with the historical bare-uuid `profile_id` input contract) and returns the bare
// uuid, throwing a 400 on anything else.

import { BadRequestError } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROFILE_ID_PREFIX = 'prof_';

/** prof_<uuid> | <uuid> → <uuid>. Throws BadRequestError (400) otherwise. */
export function parseProfileId(input: string): string {
  const bare = input.startsWith(PROFILE_ID_PREFIX) ? input.slice(PROFILE_ID_PREFIX.length) : input;
  if (!UUID_RE.test(bare)) {
    throw new BadRequestError('Invalid profile_id. Expected "prof_<uuid>".');
  }
  return bare;
}
