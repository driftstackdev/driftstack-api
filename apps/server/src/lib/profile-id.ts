// Profile-id input parsing. The API RETURNS profile ids in the canonical
// prefixed form `prof_<uuid>` (ProfileIdSchema), so a caller naturally passes
// that back when referencing a profile. The DB + services key on the BARE uuid.
// This accepts EITHER form (prefixed canonical OR bare uuid — backward-compatible
// with the historical bare-uuid `profile_id` input contract) and returns the bare
// uuid, throwing a 400 on anything else.

import { BadRequestError } from './errors.js';

// Explicit `[0-9a-fA-F]` rather than the `/i` flag, and one shared body. The
// flag is not expressible in JSON Schema, so a pattern published from an
// `/i` regex would advertise a LOWERCASE-only contract while the server keeps
// accepting uppercase — over-narrowing the document, which is the worse
// direction of the same bug this is here to fix. Semantically identical: `i`
// affects only the hex letters, and `-` has no case.
const UUID_BODY = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const UUID_RE = new RegExp(`^${UUID_BODY}$`);
const PROFILE_ID_PREFIX = 'prof_';

/**
 * The full set of inputs `parseProfileId` accepts, as a single pattern, for
 * PUBLICATION.
 *
 * V-1476 — the accepted contract used to exist only as prose: a comment on the
 * agent-sessions request mirror reading "prof_<uuid>; a bare uuid is also
 * accepted", which ships to no one. The document published a bare `string`, so
 * the 400 was the only way to discover the format.
 *
 * Composed from `UUID_BODY` rather than written out again, so the pattern the
 * document advertises and the pattern the parser enforces cannot drift — the
 * whole failure class this was found in.
 */
export const PROFILE_ID_INPUT_RE = new RegExp(`^(?:${PROFILE_ID_PREFIX})?${UUID_BODY}$`);

/** prof_<uuid> | <uuid> → <uuid>. Throws BadRequestError (400) otherwise. */
export function parseProfileId(input: string): string {
  const bare = input.startsWith(PROFILE_ID_PREFIX) ? input.slice(PROFILE_ID_PREFIX.length) : input;
  if (!UUID_RE.test(bare)) {
    throw new BadRequestError('Invalid profile_id. Expected "prof_<uuid>".');
  }
  return bare;
}
