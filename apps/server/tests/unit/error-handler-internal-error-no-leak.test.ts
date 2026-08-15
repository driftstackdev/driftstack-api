// Behavioral info-disclosure guard for the global error handler.
//
// The catch-all 5xx path — normaliseError() wrapping anything that isn't a
// known ApiError/ZodError/framework-4xx as InternalError('An unexpected error
// occurred.', err) — is TEXTUALLY pinned in three places today
// (server-error-handler-middleware-parity, error-handler-rfc7807-cross-source,
// middleware-error-handler-content-parity). But nothing exercises the FULL
// chain end-to-end: that an unexpected error thrown from a route actually
// produces a 500 whose serialized body is the generic problem shape and does
// NOT leak the underlying error message or stack to the client.
//
// Those textual pins live in error-handler.ts; they would NOT catch a
// regression in lib/errors.ts — e.g. ApiError.toProblem() or InternalError
// starting to spread `cause` into `extensions`/`detail` — that re-exposed
// internals to customers. (toProblem() spreads `this.extensions`; the cause is
// deliberately stored only on the Error for logging, never in extensions.)
// This test closes that gap by injecting real requests against throwing routes
// and asserting on the serialized response body — and pins, by contrast, that
// KNOWN typed errors DO still surface their controlled detail, so the handler
// is proven to hide *unknown* errors specifically, not blanket-hide everything.

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { NotFoundError } from '../../src/lib/errors.js';

// A deliberately sensitive payload. If ANY of these markers reach a
// customer-facing 500 body, the handler is leaking internals.
const SECRET = 'postgres://svc:hunter2@10.0.0.5:5432/driftstack';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);

  app.get('/boom-error', () => {
    throw new Error(`db connect failed: ${SECRET}`);
  });
  app.get('/boom-type-error', () => {
    // Simulates an unexpected runtime fault (reading a property of undefined
    // deep in a service) — must be hidden identically to a raw Error.
    throw new TypeError(`cannot read properties of undefined — ${SECRET}`);
  });
  app.get('/known-not-found', () => {
    // A typed ApiError — its controlled detail MUST still surface.
    throw new NotFoundError('Recipe rec_abc not found.');
  });
  app.get('/fastify-4xx', () => {
    // A framework-style 4xx (numeric statusCode < 500): the request-format
    // message surfaces as detail (documented + safe — it describes the
    // client's input, not server internals).
    const e = new Error('body must have required property "label"') as Error & {
      statusCode?: number;
    };
    e.statusCode = 400;
    throw e;
  });

  await app.ready();
  return app;
}

describe('error-handler — unexpected 5xx never leaks internals to the client (behavioral, end-to-end)', () => {
  it('a raw Error thrown from a route → 500 generic problem body; message + stack NOT in the response', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/boom-error' });
    try {
      expect(res.statusCode).toBe(500);
      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);

      const body = res.json<Record<string, unknown>>();
      expect(body.status).toBe(500);
      expect(body.title).toBe('Internal Server Error');
      expect(body.type).toBe(PROBLEM_TYPES.Internal);
      // The ONLY detail a client ever sees for an unexpected fault:
      expect(body.detail).toBe('An unexpected error occurred.');
      // A correlation id IS surfaced (lets support trace it in logs) — but it
      // is the request id, never the error contents.
      expect(typeof body.instance).toBe('string');
      // The cause/stack must never appear as response fields:
      expect(body).not.toHaveProperty('cause');
      expect(body).not.toHaveProperty('stack');

      // Nothing sensitive anywhere in the raw serialized payload:
      expect(res.payload).not.toContain('hunter2');
      expect(res.payload).not.toContain('10.0.0.5');
      expect(res.payload).not.toContain('db connect failed');
      // No JS stack-frame shape leaked into the body either:
      expect(res.payload).not.toMatch(/\bat\s+\S+\.[jt]s:\d+/);
    } finally {
      await app.close();
    }
  });

  it('an unexpected TypeError is hidden identically (catch-all covers any non-ApiError JS fault)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/boom-type-error' });
    try {
      expect(res.statusCode).toBe(500);
      const body = res.json<Record<string, unknown>>();
      expect(body.type).toBe(PROBLEM_TYPES.Internal);
      expect(body.detail).toBe('An unexpected error occurred.');
      expect(res.payload).not.toContain('hunter2');
      expect(res.payload).not.toContain('cannot read properties');
    } finally {
      await app.close();
    }
  });

  it('contrast — a KNOWN typed ApiError DOES surface its controlled detail (handler hides unknown errors, not all errors)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/known-not-found' });
    try {
      expect(res.statusCode).toBe(404);
      const body = res.json<Record<string, unknown>>();
      expect(body.type).toBe(PROBLEM_TYPES.NotFound);
      expect(body.detail).toBe('Recipe rec_abc not found.');
    } finally {
      await app.close();
    }
  });

  it('contrast — a framework 4xx surfaces its request-format message (safe: describes client input, not server internals)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/fastify-4xx' });
    try {
      expect(res.statusCode).toBe(400);
      const body = res.json<Record<string, unknown>>();
      expect(body.status).toBe(400);
      expect(body.type).toBe(PROBLEM_TYPES.BadRequest);
      expect(body.detail).toBe('body must have required property "label"');
    } finally {
      await app.close();
    }
  });

  it('404 on a token-bearing path REDACTS the credential in the echoed detail (V-494 — no token reflected to the client/proxies)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/no-such-route?ds_token=ds_live_SECRET&keep=1',
    });
    try {
      expect(res.statusCode).toBe(404);
      const detail = res.json<Record<string, unknown>>().detail as string;
      expect(detail).not.toContain('ds_live_SECRET');
      expect(detail).toContain('ds_token=%5Bredacted%5D'); // URL-encoded [redacted]
      expect(detail).toContain('keep=1'); // benign param preserved
    } finally {
      await app.close();
    }
  });
});

describe('an upstream 4xx is not our 500 (V-780)', () => {
  /** Shaped exactly like lib/stripe-api.ts builds it: `status`, not Fastify's `statusCode`. */
  function stripeError(status: number, message: string): Error {
    const err: Error & { status: number; stripeError: Record<string, unknown> } = Object.assign(
      new Error(message),
      { status, stripeError: { type: 'idempotency_error' } },
    );
    err.name = 'StripeApiError';
    return err;
  }

  async function statusFor(err: Error): Promise<{ code: number; body: string }> {
    const app: FastifyInstance = Fastify();
    registerErrorHandler(app);
    app.get('/x', () => {
      throw err;
    });
    const res = await app.inject({ method: 'GET', url: '/x' });
    await app.close();
    return { code: res.statusCode, body: res.body };
  }

  it('CRITICAL a Stripe 400 becomes a 4xx, not a 500 — StripeApiError carries `status` rather than Fastify\'s `statusCode`, so the numeric branch never matched it and a reused Idempotency-Key surfaced to the customer as "an unexpected error occurred"', async () => {
    const { code } = await statusFor(
      stripeError(400, 'Keys for idempotent requests can only be used with the same parameters.'),
    );
    expect(code).toBeGreaterThanOrEqual(400);
    expect(code, 'a client-side rejection must not page an operator').toBeLessThan(500);
  });

  it('CRITICAL a Stripe 5xx STAYS a 500 — the payment provider being down really is ours to page on, so the remap is deliberately <500 only', async () => {
    const { code } = await statusFor(stripeError(503, 'Stripe is temporarily unavailable'));
    expect(code).toBe(500);
  });

  it('the 4xx response does not leak the raw provider payload beyond its message', async () => {
    const { body } = await statusFor(stripeError(400, 'Keys for idempotent requests'));
    expect(body).not.toContain('sk_');
    expect(body).not.toContain('idempotency_error');
  });
});
