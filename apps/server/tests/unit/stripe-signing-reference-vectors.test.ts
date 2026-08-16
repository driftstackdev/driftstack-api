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
