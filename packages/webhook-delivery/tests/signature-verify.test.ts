// Finding #12 — the in-memory dispatcher's signPayload output MUST be
// the canonical Stripe-style `t=<sec>,v1=<hex>` header so the SDK's
// verifyWebhookSignature accepts it. Production cuts the durable +
// package paths over to this format; a bare-hex signature would break
// every customer verifier.
//
// This package cannot import @driftstack/sdk (it is an upstream package
// with no SDK dependency), so the verifier's parse + HMAC check is
// replicated inline below — mirroring
// packages/sdk-typescript/src/webhook-signature.ts.

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signPayload } from '../src/in-memory.js';
import type { DeliveryPayload } from '../src/types.js';

const SECRET = 'whsec_' + 'in_memory_secret_value';
const PAYLOAD: DeliveryPayload = {
  eventId: 'evt_test_001',
  eventType: 'session.completed',
  emittedAtSec: 1_700_000_000,
  body: '{"id":"ses_001","status":"completed"}',
};

/** Inline replica of the SDK verifier (parse t=/v1= from the single
 *  header, recompute HMAC over `<t>.<body>`, accept if ANY v1= matches). */
function verify(header: string, body: string, secret: string): boolean {
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') t = Number(v);
    else if (k === 'v1' && v.length > 0) sigs.push(v);
  }
  if (t === null || sigs.length === 0) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return sigs.includes(expected);
}

describe('finding #12 — in-memory signPayload emits canonical t=,v1= header', () => {
  it('returns the t=<emittedAtSec>,v1=<hex> format', () => {
    const header = signPayload(SECRET, PAYLOAD);
    expect(header).toBe(
      `t=${PAYLOAD.emittedAtSec},v1=${createHmac('sha256', SECRET).update(`${PAYLOAD.emittedAtSec}.${PAYLOAD.body}`).digest('hex')}`,
    );
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it('the verifier accepts the emitted header', () => {
    const header = signPayload(SECRET, PAYLOAD);
    expect(verify(header, PAYLOAD.body, SECRET)).toBe(true);
  });

  it('the verifier rejects a tampered body', () => {
    const header = signPayload(SECRET, PAYLOAD);
    expect(verify(header, PAYLOAD.body + 'x', SECRET)).toBe(false);
  });

  it('the verifier rejects a wrong secret', () => {
    const header = signPayload(SECRET, PAYLOAD);
    expect(verify(header, PAYLOAD.body, 'whsec_' + 'wrong')).toBe(false);
  });
});
