// V-488 — PKCE (RFC 7636) S256 + plain verifier matrix.

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  computeS256Challenge,
  verifyPlainChallenge,
  verifyS256Challenge,
} from '../../src/lib/oauth-pkce.js';

const SAMPLE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'; // RFC 7636 §A.1 — 43 chars.

describe('V-488 — computeS256Challenge', () => {
  it('matches the RFC 7636 §4.2 example', () => {
    // RFC 7636 §A.2 — given verifier above, challenge is fixed.
    expect(computeS256Challenge(SAMPLE_VERIFIER)).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('throws on an empty verifier', () => {
    expect(() => computeS256Challenge('')).toThrow();
  });

  it('throws on a verifier shorter than 43 chars', () => {
    expect(() => computeS256Challenge('short')).toThrow();
  });

  it('throws on a verifier longer than 128 chars', () => {
    expect(() => computeS256Challenge('A'.repeat(129))).toThrow();
  });

  it('throws on a verifier with disallowed characters', () => {
    const bad = '+'.repeat(43); // `+` is not in the RFC alphabet
    expect(() => computeS256Challenge(bad)).toThrow();
  });
});

describe('V-488 — verifyS256Challenge', () => {
  it('accepts a correctly computed challenge', () => {
    const challenge = computeS256Challenge(SAMPLE_VERIFIER);
    expect(verifyS256Challenge({ verifier: SAMPLE_VERIFIER, challenge })).toBe(true);
  });

  it('rejects a wrong verifier', () => {
    const challenge = computeS256Challenge(SAMPLE_VERIFIER);
    const otherVerifier = 'A'.repeat(43);
    expect(verifyS256Challenge({ verifier: otherVerifier, challenge })).toBe(false);
  });

  it('rejects an empty verifier or challenge', () => {
    const challenge = computeS256Challenge(SAMPLE_VERIFIER);
    expect(verifyS256Challenge({ verifier: '', challenge })).toBe(false);
    expect(verifyS256Challenge({ verifier: SAMPLE_VERIFIER, challenge: '' })).toBe(false);
  });

  it('rejects a malformed challenge (wrong length)', () => {
    expect(verifyS256Challenge({ verifier: SAMPLE_VERIFIER, challenge: 'abc' })).toBe(false);
  });

  it('rejects a verifier with disallowed characters', () => {
    const challenge = computeS256Challenge(SAMPLE_VERIFIER);
    expect(verifyS256Challenge({ verifier: '+'.repeat(43), challenge })).toBe(false);
  });

  it('rejects a challenge with disallowed characters', () => {
    expect(verifyS256Challenge({ verifier: SAMPLE_VERIFIER, challenge: '+'.repeat(43) })).toBe(
      false,
    );
  });

  it('does not throw on bad input — always returns false on malformed', () => {
    expect(() =>
      verifyS256Challenge({ verifier: '!!! not valid', challenge: 'also not valid' }),
    ).not.toThrow();
  });
});

describe('V-488 — verifyPlainChallenge', () => {
  it('accepts when verifier === challenge (plain method)', () => {
    expect(verifyPlainChallenge({ verifier: SAMPLE_VERIFIER, challenge: SAMPLE_VERIFIER })).toBe(
      true,
    );
  });

  it('rejects when verifier !== challenge', () => {
    expect(
      verifyPlainChallenge({
        verifier: SAMPLE_VERIFIER,
        challenge: 'A'.repeat(43),
      }),
    ).toBe(false);
  });

  it('rejects empty inputs', () => {
    expect(verifyPlainChallenge({ verifier: '', challenge: SAMPLE_VERIFIER })).toBe(false);
    expect(verifyPlainChallenge({ verifier: SAMPLE_VERIFIER, challenge: '' })).toBe(false);
  });

  it('rejects malformed inputs', () => {
    expect(verifyPlainChallenge({ verifier: '+'.repeat(43), challenge: '+'.repeat(43) })).toBe(
      false,
    );
  });
});

describe('V-488 — round-trip with caller-side encoding', () => {
  it('matches a manual base64url(sha256(verifier)) computation', () => {
    const buf = createHash('sha256').update(SAMPLE_VERIFIER).digest();
    const manual = buf
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(computeS256Challenge(SAMPLE_VERIFIER)).toBe(manual);
  });
});
