// Unit coverage for InternalFleetAuth.validate (lib/internal-fleet-auth.ts).
//
// The integration suite (atlas-priority-events-end-to-end.test.ts) covers
// missing-auth → 401, wrong-bearer → 401, and valid → 200 end-to-end. But its
// "wrong bearer" fixture ('Bearer wrong-token-xyz') is a DIFFERENT LENGTH than
// the test token, so it exits at the length pre-check (line 67) and never
// exercises the constant-time `timingSafeEqual` content compare (line 70) — a
// refactor that broke that compare (inverted boolean, removed the call) would
// pass every existing test while accepting any equal-length token. These unit
// cases pin the security-relevant branches directly: disabled deployment,
// malformed scheme, the length-mismatch branch, the EQUAL-LENGTH-wrong-content
// branch, and the happy path. Pure class + a minimal request stub — no app boot.

import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { InternalFleetAuth } from '../../src/lib/internal-fleet-auth.js';
import { UnauthorizedError } from '../../src/lib/errors.js';

const TOKEN = 'fleet-secret-0123456789';

/** Minimal FastifyRequest stub — validate() reads only headers.authorization. */
function reqWith(authorization: string | undefined): FastifyRequest {
  return { headers: { authorization } } as unknown as FastifyRequest;
}

describe('InternalFleetAuth.validate', () => {
  it('isEnabled() reflects whether the token env var is set', () => {
    expect(new InternalFleetAuth({ internalToken: TOKEN }).isEnabled()).toBe(true);
    expect(new InternalFleetAuth({ internalToken: null }).isEnabled()).toBe(false);
    // Empty string is treated as unset (not a usable secret).
    expect(new InternalFleetAuth({ internalToken: '' }).isEnabled()).toBe(false);
  });

  it('fail-closed: disabled deployment (no token) rejects EVERY request', () => {
    const auth = new InternalFleetAuth({ internalToken: null });
    // Even a request that "looks" authorized is rejected when the secret is unset.
    expect(() => auth.validate(reqWith(`Bearer ${TOKEN}`))).toThrow(UnauthorizedError);
  });

  it('rejects a missing Authorization header', () => {
    const auth = new InternalFleetAuth({ internalToken: TOKEN });
    expect(() => auth.validate(reqWith(undefined))).toThrow(UnauthorizedError);
  });

  it('rejects a non-Bearer scheme', () => {
    const auth = new InternalFleetAuth({ internalToken: TOKEN });
    expect(() => auth.validate(reqWith(`Basic ${TOKEN}`))).toThrow(/Bearer scheme/);
  });

  it('rejects a wrong token of DIFFERENT length (length pre-check branch)', () => {
    const auth = new InternalFleetAuth({ internalToken: TOKEN });
    expect(() => auth.validate(reqWith('Bearer short'))).toThrow(/token mismatch/);
  });

  it('rejects a wrong token of the SAME length (constant-time compare branch)', () => {
    // Same byte-length as TOKEN but different content — this is the branch the
    // integration "wrong bearer" test does NOT reach, so it guards the actual
    // timingSafeEqual content comparison rather than the length pre-check.
    const sameLenWrong = 'X'.repeat(TOKEN.length);
    expect(sameLenWrong.length).toBe(TOKEN.length);
    const auth = new InternalFleetAuth({ internalToken: TOKEN });
    expect(() => auth.validate(reqWith(`Bearer ${sameLenWrong}`))).toThrow(/token mismatch/);
  });

  it('accepts the correct token (does not throw)', () => {
    const auth = new InternalFleetAuth({ internalToken: TOKEN });
    expect(() => auth.validate(reqWith(`Bearer ${TOKEN}`))).not.toThrow();
  });
  // V-2023 — the one header value that reaches the rate limiter's early return.
  //
  // `routes/internal-atlas-priority.ts` opens its per-token limiter with
  // `if (token.length === 0) return;` — a bare return that skips the rate limit
  // entirely — and annotates it "validate() would have already thrown; defensive".
  // An audit traced that rather than assuming it, and it holds. This is the arm
  // that keeps it holding.
  //
  // The coupling is exact. That preHandler computes
  // `auth.replace(/^Bearer\s+/i, '').trim()`, so `Authorization: Bearer ` with
  // nothing after the space is precisely the input that yields `token === ''`
  // there. If validate() ever stopped throwing for it — an "allow when auth is
  // disabled" convenience, say — that route family would answer unauthenticated
  // AND unlimited.
  //
  // ⚠️ The length-mismatch arm above already covers the CODE BRANCH. This covers
  // the INPUT, which is a different thing: a refusal fixture has to be the value
  // the other side actually produces, or it reaches the branch by a route no
  // caller can take.
  it("CRITICAL an EMPTY bearer token is refused, on both deployment shapes — this is what makes the atlas-priority limiter's empty-token early return unreachable", () => {
    const auth = new InternalFleetAuth({ internalToken: TOKEN });
    expect(
      () => auth.validate(reqWith('Bearer ')),
      'the exact value the preHandler reduces to ""',
    ).toThrow(UnauthorizedError);
    expect(
      () => auth.validate(reqWith('Bearer    ')),
      'trailing whitespace trims to the same',
    ).toThrow(UnauthorizedError);
    // With the secret unset the same input is refused one branch earlier, so the
    // early return is unreachable whether or not the deployment configures a token.
    const disabled = new InternalFleetAuth({ internalToken: null });
    expect(
      () => disabled.validate(reqWith('Bearer ')),
      'disabled deployment refuses it too',
    ).toThrow(UnauthorizedError);
  });
});
