// V-1400 — the PKCE length guard is reachable, and what it stands between.
//
// `verifyS256Challenge` is described by its own module header as "the only branching path
// on attacker-controlled input in the OAuth flow". Its last guard before the compare is
//
//     if (provided.length !== expected.length) return false;
//
// which reads as redundant: sha256 is always 32 bytes, and a challenge that passed
// CHALLENGE_PATTERN is 43 base64url characters, which decode to exactly 32. Branch coverage
// put it in the never-taken set, and the only thing referring to it anywhere is
// `lib-oauth-pkce-content-parity`, which pins the LINE as source text. Text is not effect.
//
// It is not redundant, because the two alphabets are not the same one:
//
//   VERIFIER_PATTERN   ^[A-Za-z0-9\-._~]{43,128}$   RFC 7636 §4.1 unreserved — includes . and ~
//   CHALLENGE_PATTERN  ^[A-Za-z0-9\-._~]{43}$       the SAME set, applied to a base64url value
//
// `.` and `~` are unreserved URL characters but are not in the base64url alphabet. The
// challenge pattern is the verifier's set with the length narrowed, so it admits them. Node's
// base64 decoder skips characters outside the alphabet rather than rejecting them, so a
// 43-character challenge holding one decodes to 31 bytes, not 32 — and `timingSafeEqual`
// throws `RangeError: Input buffers must have the same byte length` on a length mismatch.
//
// Nothing upstream narrows this: the authorize route validates the challenge as
// `z.string().min(43).max(128)` (routes/oauth.ts) with no character class at all, and the
// exchange calls the helper bare — `if (!verifyS256Challenge({...})) throw new OAuthError(...)`
// in services/oauth.ts, with no try/catch. So with that one line gone, a client that registers
// a 43-character challenge containing a dot turns its own token exchange from a clean
// `invalid_grant` into an unhandled RangeError. The header's promise for this function is
// "Returns false (not throws)"; the length guard is what keeps it.
//
// The same pairing appears in `verifyPlainChallenge`, where both sides are checked against
// VERIFIER_PATTERN's 43..128 range and so may legitimately differ in length.
//
// These arms assert the promise the header makes — refused, and refused by returning — rather
// than any single line. Attribution is by mutation and is recorded in the verification log.

import { describe, expect, it } from 'vitest';
import {
  computeS256Challenge,
  verifyS256Challenge,
  verifyPlainChallenge,
} from '../../src/lib/oauth-pkce.js';

/** 43 unreserved characters: the shortest verifier RFC 7636 §4.1 allows. */
const VERIFIER = 'wJ8qLp2ZvR7tXn4bYc6dGh1kMs3fQa5eTu9iOw0rNz2';

describe('a PKCE challenge that is shape-valid but not base64url is refused, not thrown on', () => {
  it('CONTROL a genuine verifier and its computed challenge still verify. Without this every arm below is satisfied by a function that refuses everything, which is not the property.', () => {
    expect(VERIFIER).toHaveLength(43);
    expect(
      verifyS256Challenge({ verifier: VERIFIER, challenge: computeS256Challenge(VERIFIER) }),
    ).toBe(true);
  });

  it('CONTROL a computed challenge never contains the two characters below, so nothing here is reachable through honest use — these are inputs only a malformed or hostile client sends.', () => {
    const challenge = computeS256Challenge(VERIFIER);
    expect(challenge).toHaveLength(43);
    expect(challenge, 'base64url encoding cannot emit . or ~').toMatch(/^[A-Za-z0-9\-_]{43}$/);
  });

  it.each([
    ['a leading dot', `.${'A'.repeat(42)}`],
    ['a dot in the middle', `${'A'.repeat(21)}.${'A'.repeat(21)}`],
    ['a trailing dot', `${'A'.repeat(42)}.`],
    ['a leading tilde', `~${'A'.repeat(42)}`],
    ['a tilde in the middle', `${'A'.repeat(21)}~${'A'.repeat(21)}`],
    ['a trailing tilde', `${'A'.repeat(42)}~`],
    ['both, adjacent', `${'A'.repeat(41)}.~`],
    ['three dots, decoding two bytes short', `${'A'.repeat(40)}...`],
  ])(
    'CRITICAL a 43-char challenge with %s is refused by RETURNING false. It clears the shape gate — the challenge pattern is the verifier alphabet, which holds . and ~ — and then decodes short, so without the length guard timingSafeEqual raises a RangeError that escapes the bare call in services/oauth.ts and turns the client own token exchange into a 500 instead of invalid_grant.',
    (_label, challenge) => {
      expect(challenge, 'the arm is only meaningful at the exact admitted length').toHaveLength(43);

      let threw: unknown = null;
      let result: boolean | null = null;
      try {
        result = verifyS256Challenge({ verifier: VERIFIER, challenge });
      } catch (err) {
        threw = err;
      }

      expect(
        threw,
        'the module header promises "Returns false (not throws)" for a malformed challenge; a raise here is that promise broken on attacker-controlled input',
      ).toBeNull();
      expect(result, 'and the refusal must be a refusal, not a pass').toBe(false);
    },
  );

  it('CRITICAL the plain method refuses two same-alphabet values of DIFFERENT length by returning. Both sides are checked against the 43..128 verifier range, so a legal pair can differ in length, and the compare underneath is the same length-intolerant one.', () => {
    let threw: unknown = null;
    let result: boolean | null = null;
    try {
      result = verifyPlainChallenge({ verifier: VERIFIER, challenge: `${VERIFIER}extra` });
    } catch (err) {
      threw = err;
    }

    expect(threw, 'a length-mismatched plain compare must not raise').toBeNull();
    expect(result).toBe(false);
  });

  it('CONTROL the plain method still agrees when the two sides are identical, so the arm above is not satisfied by a method that refuses everything.', () => {
    expect(verifyPlainChallenge({ verifier: VERIFIER, challenge: VERIFIER })).toBe(true);
  });
});
