// V-666 — Unit tests for the NowPayments IPN webhook route.
//
// Builds a minimal Fastify instance with only the parts the route
// needs (the shared raw-body parser + error handler), then injects
// requests. Avoids the full integration-test fixture because the
// route's state surface is empty — no DB, no service deps yet.

import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { registerNowpaymentsWebhookRoutes } from '../../src/routes/webhooks-nowpayments.js';
import { registerWebhookRawBodyParser } from '../../src/routes/_webhook-raw-body.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import type { Logger } from '../../src/lib/logger.js';

const IPN_SECRET = 'test_ipn_secret_v666';

function noopLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

async function buildHarness(): Promise<{ app: FastifyInstance; logger: Logger }> {
  const app: FastifyInstance = Fastify({ logger: false });
  registerErrorHandler(app);
  const logger = noopLogger();
  registerNowpaymentsWebhookRoutes(app, { ipnSecret: IPN_SECRET, logger });
  await app.ready();
  return { app, logger };
}

function canonicalize(obj: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = obj[key];
  return JSON.stringify(sorted);
}

function signBody(body: string): string {
  return createHmac('sha512', IPN_SECRET).update(body).digest('hex');
}

describe('V-666 POST /v1/webhooks/nowpayments — signature verification', () => {
  it('200 on valid signature + well-formed payload', async () => {
    const { app } = await buildHarness();
    const payload = {
      payment_id: 1234567890,
      payment_status: 'finished',
      order_id: 'ord_test_001',
      pay_amount: 0.001,
      pay_currency: 'btc',
    };
    const raw = canonicalize(payload);
    const signature = signBody(raw);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/nowpayments',
      headers: {
        'content-type': 'application/json',
        'x-nowpayments-sig': signature,
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    await app.close();
  });

  it('401 on missing x-nowpayments-sig header', async () => {
    const { app } = await buildHarness();
    const raw = canonicalize({ payment_id: 1, payment_status: 'waiting' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/nowpayments',
      headers: { 'content-type': 'application/json' },
      payload: raw,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('401 on invalid signature', async () => {
    const { app } = await buildHarness();
    const raw = canonicalize({ payment_id: 1, payment_status: 'finished' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/nowpayments',
      headers: {
        'content-type': 'application/json',
        'x-nowpayments-sig': 'deadbeef'.repeat(16), // wrong-length hex
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('401 on signature signed with a different secret', async () => {
    const { app } = await buildHarness();
    const raw = canonicalize({ payment_id: 1, payment_status: 'finished' });
    const wrong = createHmac('sha512', 'WRONG_SECRET').update(raw).digest('hex');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/nowpayments',
      headers: {
        'content-type': 'application/json',
        'x-nowpayments-sig': wrong,
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('400 on empty body (even with a signature)', async () => {
    const { app } = await buildHarness();
    // Empty body — Fastify content-type-parser parses '' → {}, raw stash is ''.
    const sig = signBody('');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/nowpayments',
      headers: {
        'content-type': 'application/json',
        'x-nowpayments-sig': sig,
      },
      payload: '',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400 on valid signature but malformed payload (missing payment_status)', async () => {
    const { app } = await buildHarness();
    const payload = { payment_id: 7777 }; // no payment_status
    const raw = canonicalize(payload);
    const signature = signBody(raw);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/nowpayments',
      headers: {
        'content-type': 'application/json',
        'x-nowpayments-sig': signature,
      },
      payload: raw,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('V-666 raw-body parser sharing', () => {
  it('registerWebhookRawBodyParser twice on the same app is idempotent', async () => {
    // Emulates Stripe + NowPayments routes both calling the shared
    // parser registration on a single FastifyInstance. Without the
    // WeakSet guard, the second call would throw
    // FST_ERR_CTP_ALREADY_PRESENT.
    const app: FastifyInstance = Fastify({ logger: false });
    registerWebhookRawBodyParser(app);
    expect(() => registerWebhookRawBodyParser(app)).not.toThrow();
    await app.ready();
    await app.close();
  });
});
