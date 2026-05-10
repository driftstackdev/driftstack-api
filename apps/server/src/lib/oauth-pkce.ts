// V-488 — OAuth 2.0 PKCE (Proof Key for Code Exchange, RFC 7636)
// helpers. The third-party OAuth client flow (browser-based
// authorize → code → token-exchange) lands in V-488-followup; this
// module is the crypto primitive every variant of that flow needs.
//
// Customer story: a third-party app (e.g. a Slack workspace integration
// that wants to read the customer's session list) registers as an
// OAuth client, redirects the customer to the Driftstack dashboard,
// the customer approves, the app exchanges the resulting `code` for
// an opaque access token. PKCE binds the code to the calling client
// session so a leaked authorization code is unusable without the
// matching `code_verifier`.
//
// PKCE flow recap (S256 method):
//   1. Client generates a random `code_verifier` (43–128 chars per
//      RFC 7636 §4.1; URL-safe base64 alphabet).
//   2. Client computes `code_challenge` = base64url(sha256(verifier)).
//   3. Client redirects the user to /authorize with
//      `code_challenge=<challenge>&code_challenge_method=S256`.
//   4. Driftstack stores the challenge against the issued code.
//   5. Client exchanges code at /token with the original
//      `code_verifier`. Driftstack recomputes sha256 and compares.
//
// Constant-time comparison via timingSafeEqual avoids leaking the
// verifier through timing side channels.

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * RFC 7636 §4.1 verifier alphabet: unreserved URL-safe characters.
 * 43..128 char length range, picked for ~256 bits of entropy floor.
 */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * RFC 7636 §4.2 challenge alphabet: base64url-encoded sha256 digest
 * (43 chars after `=` stripping). We match the same character set as
 * the verifier so a typo'd challenge is rejected by shape, not by
 * compare result.
 */
const CHALLENGE_PATTERN = /^[A-Za-z0-9\-._~]{43}$/;

/**
 * Compute the S256 challenge for a given verifier:
 *   challenge = base64url(sha256(verifier))
 *
 * Throws on a verifier that does not match the RFC 7636 alphabet —
 * client-side libraries that hand us a malformed verifier deserve a
 * loud failure, not a silent reject at compare time.
 */
export function computeS256Challenge(verifier: string): string {
  if (!VERIFIER_PATTERN.test(verifier)) {
    throw new Error('Invalid PKCE code_verifier — must be 43–128 unreserved URL-safe chars.');
  }
  return base64UrlEncode(createHash('sha256').update(verifier).digest());
}

/**
 * Verify that the given verifier produces the stored challenge.
 *
 * Returns false (not throws) on:
 *   - empty / null verifier or challenge
 *   - challenge that doesn't match the S256 shape
 *   - verifier that doesn't match the RFC alphabet
 *   - hash mismatch
 *
 * Constant-time compare for the hash. This function is the only
 * branching path on attacker-controlled input in the OAuth flow.
 */
export function verifyS256Challenge(opts: { verifier: string; challenge: string }): boolean {
  if (!opts.verifier || !opts.challenge) return false;
  if (!VERIFIER_PATTERN.test(opts.verifier)) return false;
  if (!CHALLENGE_PATTERN.test(opts.challenge)) return false;

  const expected = createHash('sha256').update(opts.verifier).digest();
  let provided: Buffer;
  try {
    provided = base64UrlDecode(opts.challenge);
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Plain `plain` method per RFC 7636 §4.2 — supported for completeness
 * but the route layer (V-488-followup) refuses anything other than
 * S256 at registration time. Plain comparison is a constant-time
 * compare of the two strings (verifier === challenge).
 */
export function verifyPlainChallenge(opts: { verifier: string; challenge: string }): boolean {
  if (!opts.verifier || !opts.challenge) return false;
  if (!VERIFIER_PATTERN.test(opts.verifier)) return false;
  if (!VERIFIER_PATTERN.test(opts.challenge)) return false;
  if (opts.verifier.length !== opts.challenge.length) return false;
  return timingSafeEqual(Buffer.from(opts.verifier), Buffer.from(opts.challenge));
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): Buffer {
  const pad = s.length % 4;
  const padded = pad === 0 ? s : s + '='.repeat(4 - pad);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
