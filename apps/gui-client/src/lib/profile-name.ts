// Client-side profile-name validation — a pre-flight that mirrors the server's
// ProfileNameSchema (packages/api-types/src/profiles.ts) so a bad name surfaces
// a SPECIFIC, actionable message ("name must start and end with alphanumeric…")
// instead of the opaque "Validation Failed" the server's 422 maps to.
//
// The gui-client doesn't depend on @driftstack/api-types (only @driftstack/sdk),
// so the rule is replicated here rather than imported. The
// gui-client-profile-name-schema-parity test pins this regex + bounds to the
// server schema so the two can't drift.

// Server rule (ProfileNameSchema): trimmed, 1–120 chars, starts AND ends with an
// alphanumeric; inner chars may be letters, digits, space, underscore, hyphen,
// dot. A single alphanumeric char is also valid.
const PROFILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,118}[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;
const PROFILE_NAME_MAX = 120;

export const PROFILE_NAME_MESSAGE =
  'Name must start and end with a letter or digit. Allowed inside: letters, digits, space, underscore, hyphen, dot (max 120 characters).';

/** Returns null when `raw` (after trim) is a valid profile name, else a
 *  user-facing message. Empty is reported separately by the caller's
 *  "Name is required" check, but is also caught here for completeness. */
export function validateProfileName(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'Name is required.';
  if (trimmed.length > PROFILE_NAME_MAX) return PROFILE_NAME_MESSAGE;
  if (!PROFILE_NAME_RE.test(trimmed)) return PROFILE_NAME_MESSAGE;
  return null;
}
