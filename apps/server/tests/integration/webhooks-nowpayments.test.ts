// V-666 / V-487 — integration tests for POST /v1/webhooks/nowpayments.
//
// Covers:
//   1. Route unregistered when nowpaymentsIpnSecret is absent → 404.
//   2. Missing x-nowpayments-sig header → 401.
//   3. Empty body → 400.
//   4. Invalid signature → 401.
//   5. Valid HMAC-SHA512 signature + valid payload → 200 with
//      { received: true, order_state }.
//   6. Missing payment_id / payment_status → 400.

import { afterEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const IPN_SECRET = 'ipn-test-secret-9001';
const ROUTE = '/v1/webhooks/nowpayments';

interface IpnPayload {
  payment_id: number | string;
  payment_status: string;
  order_id?: string;
  pay_address?: string;
  price_amount?: number;
  price_currency?: string;
  pay_amount?: number;
  pay_currency?: string;
  actually_paid?: number;
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return out;
}

function signIpn(payload: IpnPayload, secret: string): { body: string; sig: string } {
  // The route stashes the RAW body via fastify's raw-body parser. The
  // signature must be computed against the same byte sequence the
  // server will see — for JSON payloads that's the canonicalised
  // sorted-keys form.
  const body = JSON.stringify(payload);
  const canonical = JSON.stringify(canonicalize(payload));
  const sig = createHmac('sha512', secret).update(canonical).digest('hex');
  return { body, sig };
}

describe('POST /v1/webhooks/nowpayments (V-666 + V-487)', () => {
  it('route unregistered when nowpaymentsIpnSecret is absent → 404', async () => {
    fx = await buildTestApp();
    const payload: IpnPayload = { payment_id: 'pay_123', payment_status: 'confirmed' };
    const res = await fx.app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { 'content-type': 'application/json', 'x-nowpayments-sig': 'whatever' },
      payload,
    });
    expect(res.statusCode).toBe(404);
  });

  it('missing x-nowpayments-sig header → 401', async () => {
    fx = await buildTestApp({ nowpaymentsIpnSecret: IPN_SECRET });
    const res = await fx.app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { 'content-type': 'application/json' },
      payload: { payment_id: 'pay_123', payment_status: 'confirmed' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('empty body → 400', async () => {
    fx = await buildTestApp({ nowpaymentsIpnSecret: IPN_SECRET });
    const res = await fx.app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { 'content-type': 'application/json', 'x-nowpayments-sig': 'sig' },
      // Empty string body — fastify's raw-body parser preserves it as ''
      payload: '',
    });
    expect(res.statusCode).toBe(400);
  });

  it('malformed JSON body → 400 (client error), NOT 500', async () => {
    // Regression: the custom application/json parser used to pass the bare
    // SyntaxError to done(), which the error handler (no statusCode) mapped
    // to a 500 — a client error misreported as a server error (false 5xx).
    // invalidJsonBody() now sets statusCode 400.
    fx = await buildTestApp({ nowpaymentsIpnSecret: IPN_SECRET });
    const res = await fx.app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { 'content-type': 'application/json', 'x-nowpayments-sig': 'sig' },
      payload: '{ not valid json',
    });
    expect(res.statusCode).toBe(400);
    const problem = JSON.parse(res.body) as { status: number };
    expect(problem.status).toBe(400);
  });

  it('invalid signature → 401', async () => {
    fx = await buildTestApp({ nowpaymentsIpnSecret: IPN_SECRET });
    const payload: IpnPayload = { payment_id: 'pay_123', payment_status: 'confirmed' };
    const res = await fx.app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { 'content-type': 'application/json', 'x-nowpayments-sig': 'deadbeef'.repeat(16) },
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it('valid signature + missing payment_id → 400', async () => {
    fx = await buildTestApp({ nowpaymentsIpnSecret: IPN_SECRET });
    // Force-cast to IpnPayload-compatible shape minus payment_id.
    const bad = { payment_status: 'confirmed' } as unknown as IpnPayload;
    const { body, sig } = signIpn(bad, IPN_SECRET);
    const res = await fx.app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { 'content-type': 'application/json', 'x-nowpayments-sig': sig },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
  });

  it('valid signature + valid payload → 200 with { received: true, order_state }', async () => {
    fx = await buildTestApp({ nowpaymentsIpnSecret: IPN_SECRET });
    const payload: IpnPayload = {
      payment_id: 'pay_abc123',
      payment_status: 'confirmed',
      order_id: 'ord_test_001',
      price_amount: 9.99,
      price_currency: 'USD',
    };
    const { body, sig } = signIpn(payload, IPN_SECRET);
    const res = await fx.app.inject({
      method: 'POST',
      url: ROUTE,
      headers: { 'content-type': 'application/json', 'x-nowpayments-sig': sig },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const out = res.json<{ received: boolean; order_state: string | null }>();
    expect(out.received).toBe(true);
    // order_state is null because the order doesn't exist; the wire-
    // ready posture acks anyway so the merchant doesn't queue retries.
    expect(out.order_state).toBe(null);
  });
});
