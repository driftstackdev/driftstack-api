// V-487 — NowPayments IPN signature verifier.
//
// HMAC-SHA512 over the JSON-canonicalised body (sorted keys at every
// level), keyed on the IPN secret. Tests pin: happy path, wrong
// secret, wrong body, key-order independence, bad-hex graceful return,
// length mismatch, raw-body fallback for non-JSON.
//
// MUTATION-PROVED 2026-08-16 against lib/nowpayments-signing.ts, whole node
// project, tsc exit 0. Making the final `timingSafeEqual` always accept — so any
// forged IPN verifies — reds 8:
//
//   unit/nowpayments-signing (this file)                  2 red
//   unit/webhooks-nowpayments                             2 red
//   integration/webhooks-nowpayments (invalid sig -> 401) 1 red
//   unit/nowpayments-webhook-metrics                      1 red
//   the two source-text pins                              2 red
//
// This header is worth its space because of WHAT the signature is here: the
// route's own comment says "Public, no auth — `x-nowpayments-sig` header IS the
// auth". There is no second gate behind it. A forged IPN that verifies walks
// straight into the crypto order state machine, and the only thing then standing
// between it and a tier activation is the under-payment check in
// services/crypto-orders.ts — which is separately proved at 3 red, and is about
// the AMOUNT rather than about whether the message is genuine.

import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyNowpaymentsSignature } from '../../src/lib/nowpayments-signing.js';

const SECRET = 'ipn-secret-test-only';

function sign(body: string | object, secret = SECRET): { body: string; signature: string } {
  const raw = typeof body === 'string' ? body : JSON.stringify(sortKeys(body));
  const signature = createHmac('sha512', secret).update(raw).digest('hex');
  return { body: typeof body === 'string' ? body : JSON.stringify(body), signature };
}

function sortKeys(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sortKeys);
  const obj = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = sortKeys(obj[key]);
  return out;
}

describe('V-487 — verifyNowpaymentsSignature', () => {
  it('accepts a correctly-signed JSON body', () => {
    const payload = { payment_id: 'p_1', payment_status: 'finished', pay_amount: 0.01 };
    const { body, signature } = sign(payload);
    expect(verifyNowpaymentsSignature({ body, secret: SECRET, signature })).toBe(true);
  });

  it('rejects when the secret is wrong', () => {
    const payload = { payment_id: 'p_1' };
    const { body, signature } = sign(payload);
    expect(verifyNowpaymentsSignature({ body, secret: 'other-secret', signature })).toBe(false);
  });

  it('rejects when the body is mutated', () => {
    const payload = { payment_id: 'p_1', amount: 100 };
    const { signature } = sign(payload);
    const tamperedBody = JSON.stringify({ payment_id: 'p_1', amount: 999 });
    expect(verifyNowpaymentsSignature({ body: tamperedBody, secret: SECRET, signature })).toBe(
      false,
    );
  });

  it('is independent of JSON key order on the body (canonicalisation works)', () => {
    const a = JSON.stringify({ z: 1, a: 2, m: 3 });
    const b = JSON.stringify({ a: 2, m: 3, z: 1 });
    const sig = createHmac('sha512', SECRET)
      .update(JSON.stringify({ a: 2, m: 3, z: 1 }))
      .digest('hex');
    expect(verifyNowpaymentsSignature({ body: a, secret: SECRET, signature: sig })).toBe(true);
    expect(verifyNowpaymentsSignature({ body: b, secret: SECRET, signature: sig })).toBe(true);
  });

  it('canonicalises nested object keys', () => {
    const payload = { outer: { z: 1, a: 2 }, marker: 'x' };
    const sortedSig = createHmac('sha512', SECRET)
      .update(JSON.stringify({ marker: 'x', outer: { a: 2, z: 1 } }))
      .digest('hex');
    expect(
      verifyNowpaymentsSignature({
        body: JSON.stringify(payload),
        secret: SECRET,
        signature: sortedSig,
      }),
    ).toBe(true);
  });

  it('returns false on empty body / secret / signature', () => {
    expect(verifyNowpaymentsSignature({ body: '', secret: SECRET, signature: 'x' })).toBe(false);
    expect(verifyNowpaymentsSignature({ body: '{}', secret: '', signature: 'x' })).toBe(false);
    expect(verifyNowpaymentsSignature({ body: '{}', secret: SECRET, signature: '' })).toBe(false);
  });

  it('returns false on non-hex signature without throwing', () => {
    expect(() =>
      verifyNowpaymentsSignature({ body: '{}', secret: SECRET, signature: 'zzz-not-hex' }),
    ).not.toThrow();
    expect(
      verifyNowpaymentsSignature({ body: '{}', secret: SECRET, signature: 'zzz-not-hex' }),
    ).toBe(false);
  });

  it('returns false on length-mismatched hex signature', () => {
    expect(verifyNowpaymentsSignature({ body: '{}', secret: SECRET, signature: 'abcd' })).toBe(
      false,
    );
  });

  it('falls back to raw-body HMAC when body is non-JSON', () => {
    const raw = 'a=1&b=2&c=3';
    const sig = createHmac('sha512', SECRET).update(raw).digest('hex');
    expect(verifyNowpaymentsSignature({ body: raw, secret: SECRET, signature: sig })).toBe(true);
  });

  // V-1404 — two canonicalisation arms that had never run. Both expected signatures
  // below are written out BY HAND rather than built with this file's local `sortKeys`
  // mirror: that helper is a faithful copy of the source's, so signing through it would
  // make the arm agree with the implementation even if the implementation were wrong.
  it('CRITICAL sorts the keys of an object nested inside an ARRAY. The recursion into array elements is a separate branch from the object one already covered here, and NowPayments signs the fully-sorted form — so if array elements were left alone, a genuine IPN carrying a list would fail verification and a real payment notification would be dropped as forged.', () => {
    const payload = { items: [{ z: 1, a: 2 }], marker: 'x' };
    const canonical = '{"items":[{"a":2,"z":1}],"marker":"x"}';
    const signature = createHmac('sha512', SECRET).update(canonical).digest('hex');

    expect(
      verifyNowpaymentsSignature({
        body: JSON.stringify(payload),
        secret: SECRET,
        signature,
      }),
    ).toBe(true);
  });

  it('CRITICAL a body that parses as JSON but is NOT an object falls back to the RAW body, not a re-serialised one. The existing fallback arm sends something that does not parse at all, so it never reaches this decision — and re-serialising here would change the bytes (whitespace, and the ordering of keys inside array elements) and reject a correctly-signed notification.', () => {
    // Top-level array carrying an object with unsorted keys, plus whitespace: both
    // survive only if the verifier signs exactly what arrived.
    const raw = '[{"z":1,"a":2}, 7]';
    const signature = createHmac('sha512', SECRET).update(raw).digest('hex');

    expect(verifyNowpaymentsSignature({ body: raw, secret: SECRET, signature })).toBe(true);
  });

  it('accepts a Buffer body', () => {
    const payload = { payment_id: 'p_1' };
    const { signature } = sign(payload);
    const buf = Buffer.from(JSON.stringify(payload), 'utf8');
    expect(verifyNowpaymentsSignature({ body: buf, secret: SECRET, signature })).toBe(true);
  });
});
