// V-197 — cross-implementation reference vector tests for
// verifyStripeSignature.
//
// The existing stripe-webhooks.test.ts covers sign-verify roundtrips
// using our own signStripePayload + verifyStripeSignature. That'd
// pass even if both functions had matching bugs. These tests use
// HMAC fixtures computed by `openssl dgst -sha256 -hmac` (independent
// of our implementation) and verify our verifier accepts them. If
// the Stripe-side algorithm ever changes or our impl drifts, these
// fixtures fail loud.
//
// Format reminder: HMAC-SHA256 of `<timestamp>.<raw body>` keyed by
// the webhook signing secret, hex-encoded. Stripe's signature header
// is `t=<seconds>,v1=<hex>[,v0=<legacy>]`.
//
// To regenerate a fixture:
//   echo -n "<timestamp>.<body>" | \
//     openssl dgst -sha256 -hmac "<secret>" -hex
//
// MUTATION-PROVED 2026-08-16 against lib/stripe-signing.ts, whole node project,
// tsc exit 0 on both (a mutation that fails to typecheck is contaminated, not a
// verdict):
//
//   the v1 comparison never refuses — any forged body verifies    11 red
//   the t= tolerance window removed — a replayed event verifies     3 red
//
// The first is the one this file was written for, and the split is worth
// knowing: of those 11, SEVEN are these reference vectors, one is
// `stripe-webhooks` integration asserting 401 on a wrong-secret signature, and
// the rest are the source-text pins. Drop this file and a forged-signature
// bypass still fails the build — but only through the integration arm and the
// pins, which is thin cover for the check that decides whether an unauthenticated
// caller can move a customer between price points.
//
// The replay row is thinner still at 3, and that asymmetry is real rather than
// an oversight: forging a signature needs the secret, while replaying a captured
// one needs only the wire. The tolerance window is the only thing standing
// against the second, so treat a change to `toleranceSec` as load-bearing.

import { describe, expect, it } from 'vitest';
import { verifyStripeSignature } from '../../src/lib/stripe-signing.js';

interface Vector {
  name: string;
  rawBody: string;
  secret: string;
  timestampSec: number;
  expectedHex: string;
}

// Each vector below was computed via `openssl dgst -sha256 -hmac` —
// fully independent of our signing code path.
const VECTORS: Vector[] = [
  {
    name: 'subscription.created event',
    rawBody: '{"id":"evt_test_ref_001","type":"customer.subscription.created"}',
    secret: 'whsec_reference_vector_secret_v197',
    timestampSec: 1700000000,
    expectedHex: 'aeab2630823c0ba805a791e4704b5f7910846f722f7be63c1c23475e9145c8ae',
  },
  {
    name: 'invoice.paid event with same secret',
    rawBody: '{"id":"evt_alt","type":"invoice.paid"}',
    secret: 'whsec_reference_vector_secret_v197',
    timestampSec: 1700000000,
    expectedHex: '18e3bddf4670001c825277446498ea3d911c90a44506491ca8e3489dc524b35f',
  },
  {
    name: 'simple body different secret',
    rawBody: 'simple body',
    secret: 'whsec_simple',
    timestampSec: 1234567890,
    expectedHex: '4fe857a06ff10c4311813c670d8984cee86e5a8591bfa52accc68e45ef59ee56',
  },
];

describe('verifyStripeSignature — cross-implementation reference vectors', () => {
  for (const v of VECTORS) {
    it(`accepts an externally-signed payload (${v.name})`, () => {
      const header = `t=${String(v.timestampSec)},v1=${v.expectedHex}`;
      const result = verifyStripeSignature({
        rawBody: v.rawBody,
        header,
        secret: v.secret,
        // Pin nowSec so the tolerance check passes regardless of when
        // this test runs.
        nowSec: v.timestampSec,
      });
      expect(result.ok).toBe(true);
    });

    it(`rejects when v1 hex is altered by 1 char (${v.name})`, () => {
      // Flip the last hex char to confirm the timing-safe equality
      // catches single-char mutations.
      const altered = v.expectedHex.slice(0, -1) + (v.expectedHex.endsWith('0') ? '1' : '0');
      const header = `t=${String(v.timestampSec)},v1=${altered}`;
      const result = verifyStripeSignature({
        rawBody: v.rawBody,
        header,
        secret: v.secret,
        nowSec: v.timestampSec,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid_signature');
    });

    it(`rejects with wrong secret (${v.name})`, () => {
      const header = `t=${String(v.timestampSec)},v1=${v.expectedHex}`;
      const result = verifyStripeSignature({
        rawBody: v.rawBody,
        header,
        secret: 'whsec_intentionally_wrong',
        nowSec: v.timestampSec,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid_signature');
    });
  }

  it('rejects timestamp outside default 5-minute tolerance', () => {
    const v = VECTORS[0]!;
    const header = `t=${String(v.timestampSec)},v1=${v.expectedHex}`;
    const result = verifyStripeSignature({
      rawBody: v.rawBody,
      header,
      secret: v.secret,
      // 6 minutes after the signing timestamp
      nowSec: v.timestampSec + 360,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('timestamp_outside_tolerance');
  });

  it('accepts at the edge of tolerance window (300s)', () => {
    const v = VECTORS[0]!;
    const header = `t=${String(v.timestampSec)},v1=${v.expectedHex}`;
    const result = verifyStripeSignature({
      rawBody: v.rawBody,
      header,
      secret: v.secret,
      nowSec: v.timestampSec + 300,
    });
    expect(result.ok).toBe(true);
  });

  it('tolerates additional unknown signature scheme keys (e.g. v2)', () => {
    const v = VECTORS[0]!;
    const header = `t=${String(v.timestampSec)},v1=${v.expectedHex},v2=futurescheme`;
    const result = verifyStripeSignature({
      rawBody: v.rawBody,
      header,
      secret: v.secret,
      nowSec: v.timestampSec,
    });
    expect(result.ok).toBe(true);
  });

  // ─── Secret-roll: Stripe dual-signs with old+new secret → MULTIPLE v1 ───────
  // We must accept the event if ANY v1 verifies, regardless of position, so a
  // webhook-secret rotation is zero-downtime (matches Stripe's official SDK +
  // our own outbound verifier). Each candidate still requires a real HMAC, so
  // two non-matching v1 reject (accepting-any is not a bypass).
  const wrong = 'f'.repeat(64);

  it('accepts when the matching v1 is NOT first (correct listed last — on new secret during roll)', () => {
    const v = VECTORS[0]!;
    const header = `t=${String(v.timestampSec)},v1=${wrong},v1=${v.expectedHex}`;
    const result = verifyStripeSignature({
      rawBody: v.rawBody,
      header,
      secret: v.secret,
      nowSec: v.timestampSec,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts when the matching v1 is NOT last (correct listed first — on old secret during roll)', () => {
    const v = VECTORS[0]!;
    const header = `t=${String(v.timestampSec)},v1=${v.expectedHex},v1=${wrong}`;
    const result = verifyStripeSignature({
      rawBody: v.rawBody,
      header,
      secret: v.secret,
      nowSec: v.timestampSec,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects when NONE of multiple v1 match (accept-any is not a bypass)', () => {
    const v = VECTORS[0]!;
    const header = `t=${String(v.timestampSec)},v1=${wrong},v1=${'e'.repeat(64)}`;
    const result = verifyStripeSignature({
      rawBody: v.rawBody,
      header,
      secret: v.secret,
      nowSec: v.timestampSec,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_signature');
  });

  it('reports missing_v1 when the only v1 is empty (t=...,v1=)', () => {
    const v = VECTORS[0]!;
    const header = `t=${String(v.timestampSec)},v1=`;
    const result = verifyStripeSignature({
      rawBody: v.rawBody,
      header,
      secret: v.secret,
      nowSec: v.timestampSec,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_v1');
  });
});

// V-1394 — the malformed-header guards. Branch coverage put three arms in the never-taken
// set, all of them on input a forger controls:
//
//   parseHeader   `if (!Number.isFinite(n)) return null`      — a non-numeric `t=`
//   constantTimeHexEq  `if (a.length !== b.length) return false`
//   constantTimeHexEq  `if (!/^[0-9a-f]+$/i.test(…)) return false`
//
// The arms above this block are thorough about WELL-FORMED headers — altered hex, wrong
// secret, tolerance edges, multiple v1, an empty v1 — and every one of them supplies a
// syntactically valid signature. Nothing had ever handed the verifier a header it could not
// parse.
//
// The hex guard carries its own reason in the source: `Buffer.from(hex, 'hex')` silently
// truncates at the first invalid pair. Without it a 64-character non-hex `v1` decodes to a
// shorter buffer and `timingSafeEqual` THROWS on the length mismatch — an unhandled throw on
// the Stripe webhook route, which is a 500 where a refusal belongs. Fail-closed either way;
// the difference is whether the money path answers or falls over.
describe('a Stripe signature header that does not parse is refused, not thrown on', () => {
  const V = VECTORS[0]!;
  const verify = (header: string): ReturnType<typeof verifyStripeSignature> =>
    verifyStripeSignature({
      rawBody: V.rawBody,
      header,
      secret: V.secret,
      nowSec: V.timestampSec,
    });

  it.each([
    ['a non-numeric timestamp', `t=abc,v1=${VECTORS[0]!.expectedHex}`],
    ['a timestamp of Infinity', `t=Infinity,v1=${VECTORS[0]!.expectedHex}`],
  ])(
    'CRITICAL %s is malformed_header rather than a parse that silently yields NaN. The tolerance check compares against `t`; a NaN there makes `Math.abs(now - t) > tolerance` false, so an unparseable timestamp would sail past the replay window instead of being refused by it.',
    (_label, header) => {
      const res = verify(header);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('malformed_header');
    },
  );

  it.each([
    ['the right length but not hex', 'z'.repeat(64)],
    ['hex with one non-hex character', `${'a'.repeat(63)}z`],
    ['shorter than the digest', 'abcdef'],
    ['longer than the digest', 'a'.repeat(65)],
  ])(
    'CRITICAL a v1 that is %s is refused as invalid_signature and does not throw. Buffer.from(hex) truncates at the first bad pair, so without the shape guard timingSafeEqual sees mismatched lengths and throws — a 500 on the webhook route instead of a refusal.',
    (_label, v1) => {
      const header = `t=${String(V.timestampSec)},v1=${v1}`;
      expect(
        () => verify(header),
        'the verifier must not throw on attacker-shaped input',
      ).not.toThrow();
      const res = verify(header);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('invalid_signature');
    },
  );

  it('CRITICAL an EMPTY timestamp is still refused, by the tolerance check rather than the parse. `Number("")` is 0, not NaN, so `t=` parses as the epoch and is finite — the isFinite guard never sees it. Worth pinning separately: the refusal is real but it comes from a different line than the shape of the input suggests.', () => {
    const res = verify(`t=,v1=${V.expectedHex}`);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('timestamp_outside_tolerance');
  });

  it('CRITICAL the same payload with its real signature still verifies, so the refusals above are not satisfied by a verifier that rejects everything', () => {
    const res = verify(`t=${String(V.timestampSec)},v1=${V.expectedHex}`);
    expect(res.ok).toBe(true);
  });
});
