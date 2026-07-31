// A framework 4xx must not echo the VALUE the client submitted.
//
// `error-handler-internal-error-no-leak.test.ts` proves the 5xx catch-all hides
// internals, and pins by contrast that a framework 4xx surfaces its message —
// justified there as "safe: it describes the client's input, not server
// internals". That reasoning has a gap, and the gap is the whole point of this
// file: when the client's input IS a credential, describing it is the leak.
//
// It also matters that the existing case FABRICATES the error — it throws a
// hand-made `Error` with `statusCode = 400` rather than driving Fastify's real
// body parser and AJV validator. So what actually happens when a malformed or
// invalid body carrying a password reaches the handler has never been
// exercised. The `detail` on that path is `fastifyErr.message` passed straight
// through, and the same string is what lands in the logs.
//
// Two shapes are checked because they come from different code inside Fastify:
// a body the JSON parser cannot parse at all, and a body that parses but fails
// schema validation.

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerErrorHandler } from '../../src/middleware/error-handler.js';

/** Distinctive enough that finding it in a response is unambiguous. */
const CREDENTIAL = 'zq7marker4password9value';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerErrorHandler(app);

  app.post(
    '/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          additionalProperties: false,
          properties: {
            username: { type: 'string' },
            // A length floor no marker value satisfies, so validation fails
            // ON the credential field rather than on a sibling.
            password: { type: 'string', minLength: 200 },
          },
        },
      },
    },
    () => ({ ok: true }),
  );

  await app.ready();
  return app;
}

describe('a framework 4xx never echoes the value the client submitted', () => {
  it('CRITICAL a body the JSON parser cannot parse does not put the submitted credential in the response. The parser message becomes `detail` verbatim, and the same string is logged.', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/login',
        headers: { 'content-type': 'application/json' },
        // Truncated on purpose — unparseable, with the credential inside.
        payload: `{"username":"u","password":"${CREDENTIAL}"`,
      });

      expect(res.statusCode, 'a malformed body must be rejected').toBe(400);
      expect(res.body, 'the response must not carry the submitted credential').not.toContain(
        CREDENTIAL,
      );
    } finally {
      await app.close();
    }
  });

  it('CRITICAL a body that parses but fails schema validation does not echo the offending value. AJV reports the failing instance path; a report that included the instance VALUE would put the password in the problem detail.', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/login',
        headers: { 'content-type': 'application/json' },
        payload: { username: 'u', password: CREDENTIAL },
      });

      expect(res.statusCode, 'a too-short password must be rejected').toBe(400);
      expect(res.body, 'the response must not carry the submitted credential').not.toContain(
        CREDENTIAL,
      );
    } finally {
      await app.close();
    }
  });

  it('CRITICAL an unexpected property carrying a credential is STRIPPED, not rejected and not echoed. Measured, not assumed: Fastify configures AJV with removeAdditional, so `additionalProperties: false` silently drops the key and the request succeeds — it does not 400. Pinned because flipping to strict rejection would start reporting the offending property, and that report must never grow to include its value.', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/login',
        headers: { 'content-type': 'application/json' },
        payload: { username: 'u', password: 'x'.repeat(200), secret_token: CREDENTIAL },
      });

      expect(res.statusCode, 'the unknown property is stripped, so the request succeeds').toBe(200);
      expect(res.body, 'the response must not carry the submitted credential').not.toContain(
        CREDENTIAL,
      );
    } finally {
      await app.close();
    }
  });

  it('CRITICAL the rejections above are real 4xx problem responses, not 404s. Without this the absence assertions would hold trivially for a route that was never reached — the vacuity that makes a security test worthless.', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/login',
        headers: { 'content-type': 'application/json' },
        payload: { username: 'u' },
      });

      expect(res.statusCode, 'the route exists and validates').toBe(400);
      expect(res.headers['content-type'], 'errors are RFC 9457 problem+json').toMatch(
        /application\/problem\+json/,
      );
      const body: { status?: number; detail?: string } = res.json();
      expect(body.status, 'the problem body is populated').toBe(400);
      expect(
        body.detail ?? '',
        'the detail names the missing field, so the handler IS reporting real validation output',
      ).toContain('password');
    } finally {
      await app.close();
    }
  });
});
