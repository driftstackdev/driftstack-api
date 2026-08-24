// Profile-id input parsing. The API RETURNS profile ids in the canonical
// prefixed form `prof_<uuid>` (ProfileIdSchema), so a caller naturally passes
// that back when referencing a profile. The DB + services key on the BARE uuid.
// This accepts EITHER form (prefixed canonical OR bare uuid — backward-compatible
// with the historical bare-uuid `profile_id` input contract) and returns the bare
// uuid, throwing a 400 on anything else.

import {
  PROFILE_ID_INPUT_RE as CANONICAL_PROFILE_ID_INPUT_RE,
  PROFILE_UUID_BODY,
} from '@driftstack/api-types';
import { BadRequestError } from './errors.js';

// Explicit `[0-9a-fA-F]` rather than the `/i` flag, and one shared body. The
// flag is not expressible in JSON Schema, so a pattern published from an
// `/i` regex would advertise a LOWERCASE-only contract while the server keeps
// accepting uppercase — over-narrowing the document, which is the worse
// direction of the same bug this is here to fix. Semantically identical: `i`
// affects only the hex letters, and `-` has no case.
// V-1489 — the accepted-input pattern now lives in `@driftstack/api-types`
// beside `ProfileIdSchema`, because `CreateSessionRequestSchema` needs it to
// publish `profile_id` and a shared package cannot import from the server. This
// module keeps its own name for it so call sites and `openapi.ts` are unchanged,
// but the pattern itself is imported rather than composed a second time — the
// V-1484 lesson, applied before the copy existed rather than after.
const UUID_RE = new RegExp(`^${PROFILE_UUID_BODY}$`);
const PROFILE_ID_PREFIX = 'prof_';

export const PROFILE_ID_INPUT_RE = CANONICAL_PROFILE_ID_INPUT_RE;

/** prof_<uuid> | <uuid> → <uuid>. Throws BadRequestError (400) otherwise. */
export function parseProfileId(input: string): string {
  const bare = input.startsWith(PROFILE_ID_PREFIX) ? input.slice(PROFILE_ID_PREFIX.length) : input;
  if (!UUID_RE.test(bare)) {
    throw new BadRequestError('Invalid profile_id. Expected "prof_<uuid>".');
  }
  return bare;
}
