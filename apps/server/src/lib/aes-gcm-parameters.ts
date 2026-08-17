// AES-256-GCM wire parameters, in one place.
//
// Ten encryption modules each declared these three constants locally, with
// identical values and their own content-parity test pinning their own copy.
// Every copy was covered; nothing required the ten to AGREE. Change one file's
// IV length to 16 "for hardening", update that file's pin, and the suite stays
// green while that module writes envelopes the other nine cannot parse — and
// GCM's security argument rests on the 96-bit IV it no longer uses.
//
// These are not tunables. They are the shape of the algorithm: AES-256 takes a
// 256-bit key, GCM is specified for a 96-bit IV, and its tag is 128 bits. A
// value that differs per module is a bug in that module, never a local policy,
// which is why they belong in one imported place rather than ten agreeing ones.

/** AES-256 key length. 256 bits. */
export const AES_256_KEY_BYTES = 32;

/**
 * GCM initialisation vector. 96 bits — the length GCM is specified around, and
 * the only one for which the standard counter construction applies without an
 * extra GHASH step.
 */
export const GCM_IV_BYTES = 12;

/** GCM authentication tag. 128 bits, the full-strength tag length. */
export const GCM_TAG_BYTES = 16;
