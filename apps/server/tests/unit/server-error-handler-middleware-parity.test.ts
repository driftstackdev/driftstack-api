// W711 — server-side error-handler middleware parity. Thirty-eighth
// in the cross-SDK drift-guard series (W649 + W675-W711).
//
// Pins apps/server/src/middleware/error-handler.ts as the wire-
// conversion layer that turns every escaping error into an RFC 7807
// problem+json response. The middleware:
//
//   - registers .setErrorHandler() + .setNotFoundHandler() on the
//     Fastify app
//   - converts ApiError -> toProblem() output
//   - converts ZodError -> ValidationError (via .flatten())
//   - converts Fastify validator/body-parser errors -> ApiError with
//     a status-derived problem type (401/403/400)
//   - wraps everything else as InternalError with full-stack logging
//   - sets `application/problem+json; charset=utf-8` content-type
//   - includes request.id as the `instance` field
//
// CRITICAL invariants:
//   1. Content-Type MUST be `application/problem+json; charset=utf-8`
//      on every error response — drift would let CORS pre-flight or
//      content-sniffing clients mis-handle the body.
//   2. 404 handler MUST also emit problem+json — drift to a JSON
//      fallback would let route misses bypass the standard error
//      shape.
//   3. Status-derived problem-type mapping for Fastify validator
//      errors (401 → unauthorized; 403 → forbidden; else → bad-request).
//   4. 5xx log at error level (with full err object); 4xx log at warn
//      level with NARROWED err object (just name + message — no
//      stack-leak in log volumes).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const ERROR_HANDLER = resolve(REPO_ROOT, 'apps/server/src/middleware/error-handler.ts');

describe('W711 server-side error-handler middleware parity', () => {
  it('error-handler.ts file exists', () => {
    expect(existsSync(ERROR_HANDLER), `missing ${ERROR_HANDLER}`).toBe(true);
  });

  it('CRITICAL "every escaping error becomes an RFC 7807 problem+json response" header framing pinned. The wording is what tells engineers the middleware is the SINGLE wire-conversion point; drift to dropping would let new routes bypass with hand-rolled error shapes.', () => {
    const src = read(ERROR_HANDLER);
    expect(src).toMatch(
      /every escaping error becomes an RFC 7807\s*\n?\s*\/\/\s*problem\+json response/,
    );
  });

  it('CRITICAL registerErrorHandler() pinned — sets BOTH .setErrorHandler() and .setNotFoundHandler(). Drift to only setting one would let either uncaught throws OR route-misses bypass the problem+json shape.', () => {
    const src = read(ERROR_HANDLER);
    expect(src).toMatch(/export function registerErrorHandler\(app: FastifyInstance\): void/);
    expect(src).toMatch(/app\.setErrorHandler\(handleError\)/);
    expect(src).toMatch(/app\.setNotFoundHandler\(\(request, reply\) => \{/);
  });

  it('CRITICAL 404 handler emits problem+json with /not-found problem-type. The 404 shape is what tells customers a route-miss; drift to a plain JSON 404 or a 500 would change customer error-handling.', () => {
    const src = read(ERROR_HANDLER);
    expect(src).toMatch(/type: PROBLEM_TYPES\.NotFound,/);
    expect(PROBLEM_TYPES.NotFound).toBe('https://errors.driftstack.dev/not-found');
    expect(src).toMatch(/title: 'Not Found'/);
    expect(src).toMatch(/status: 404/);
    expect(src).toMatch(
      /detail: `No route for \$\{request\.method\} \$\{redactUrlQueryTokens\(request\.url\)\}\.`/,
    );
    expect(src).toMatch(/instance: request\.id/);
  });

  it('CRITICAL `application/problem+json; charset=utf-8` content-type pinned on every error response. Drift to plain `application/json` would let clients with strict content-type checks mis-route the body; drift to dropping `charset=utf-8` would break legacy parsers.', () => {
    const src = read(ERROR_HANDLER);
    expect(src).toMatch(/'application\/problem\+json; charset=utf-8'/);
  });

  it('CRITICAL replyWithProblem() helper sets status via reply.code() + content-type via reply.header() + body via reply.send(). The 3-call pipeline is what produces the wire-correct problem+json response; drift to merging or dropping would mis-format.', () => {
    const src = read(ERROR_HANDLER);
    expect(src).toMatch(/return reply\s*\n?\s*\.code\(problem\.status\)\s*\n?\s*\.header\(/);
    expect(src).toMatch(/\.send\(problem\)/);
  });

  it('CRITICAL normaliseError() ApiError pass-through pinned — `if (err instanceof ApiError) return err`. Drift to wrapping would lose the canonical name + status on every typed throw.', () => {
    const src = read(ERROR_HANDLER);
    expect(src).toMatch(/if \(err instanceof ApiError\) return err;/);
  });

  it('CRITICAL ZodError → ValidationError conversion pinned with .flatten() call. The .flatten() output is what the ValidationError extension shape (issues field, W710) carries. Drift to passing raw err.issues would change the wire-format shape.', () => {
    const src = read(ERROR_HANDLER);
    expect(src).toMatch(
      /if \(err instanceof ZodError\) \{\s*\n?\s*return new ValidationError\(err\.flatten\(\)\)/,
    );
  });

  it('CRITICAL Fastify validator error mapping pinned — 401 → unauthorized, 403 → forbidden, else → bad-request. Drift to a different mapping would let body-parser/validator errors surface with the wrong problem-type to customers.', () => {
    const src = read(ERROR_HANDLER);

    // Status-derived problem-type mapping.
    expect(src).toMatch(
      /fastifyErr\.statusCode === 401\s*\n?\s*\?\s*\(\[PROBLEM_TYPES\.Unauthorized, 'Unauthorized'\] as const\)/,
    );
    expect(src).toMatch(
      /fastifyErr\.statusCode === 403\s*\n?\s*\?\s*\(\[PROBLEM_TYPES\.Forbidden, 'Forbidden'\] as const\)/,
    );
    expect(src).toMatch(/\(\[PROBLEM_TYPES\.BadRequest, 'Bad Request'\] as const\)/);
  });

  it('CRITICAL `fastifyErr.statusCode < 500` cap pinned. Only 1xx-4xx pass through as ApiError-with-status-derived-type; 5xx Fastify errors fall through to InternalError. Drift to allowing 5xx to pass would let internal Fastify errors leak their detail (e.g. crypto failure messages).', () => {
    const src = read(ERROR_HANDLER);
    expect(src).toMatch(
      /typeof fastifyErr\.statusCode === 'number' && fastifyErr\.statusCode < 500/,
    );
  });

  it('CRITICAL "Anything else: hide internals" framing + InternalError fallback pinned. The fallback shape is the catch-all safety net; drift to letting raw error.message through would leak server internals (DB errors, file paths, stack traces).', () => {
    const src = read(ERROR_HANDLER);
    expect(src).toMatch(/Anything else: hide internals/);
    expect(src).toMatch(/return new InternalError\('An unexpected error occurred\.', err\)/);
  });

  it('CRITICAL 5xx vs 4xx log-level pinned. Both pass `err` directly so Pino stdSerializers.err extracts name+message+stack+cause (the prior wrapped {name,message} dropped the stack — same class of bug as the 2026-05-19 scheduled-jobs-poller wrapper that hid a 10-day prod TypeError stack).', () => {
    const src = read(ERROR_HANDLER);

    // 5xx: log.error with full err.
    expect(src).toMatch(
      /if \(apiError\.status >= 500\) \{\s*\n?\s*request\.log\.error\(\{ err, problem: apiError\.toProblem\(\) \}/,
    );

    // 4xx: log.warn with FULL err (post-2026-05-19 scheduled-jobs-poller
    // wrapper-bug lesson — wrapped {name,message} drops the stack Pino
    // would otherwise expose).
    expect(src).toMatch(
      /request\.log\.warn\(\{ err, problem: apiError\.toProblem\(\) \}, 'request rejected: 4xx'\)/,
    );
  });

  it('CRITICAL instance field pinned to request.id on every problem. The request.id is what lets customers correlate their problem response with server-side logs. Drift to dropping would break the support-debug workflow.', () => {
    const src = read(ERROR_HANDLER);
    // 404 handler.
    expect(src).toMatch(/instance: request\.id/);
    // Error handler passes request.id into toProblem.
    expect(src).toMatch(/apiError\.toProblem\(request\.id\)/);
  });

  it('CRITICAL imports pinned — ApiError + InternalError + ValidationError from ../lib/errors.js. Drift to importing from anywhere else would let the middleware diverge from the canonical taxonomy (W710).', () => {
    const src = read(ERROR_HANDLER);
    expect(src).toMatch(
      /import \{ ApiError, InternalError, ValidationError \} from '\.\.\/lib\/errors\.js'/,
    );
  });

  it("CRITICAL handleError signature returns `Promise<FastifyReply> | void`. The union return type matches Fastify's error-handler contract (sync or async return); drift to a stricter `Promise<FastifyReply>` only would force unnecessary awaits.", () => {
    const src = read(ERROR_HANDLER);
    expect(src).toMatch(
      /function handleError\(\s*\n?\s*err: FastifyError \| Error,\s*\n?\s*request: FastifyRequest,\s*\n?\s*reply: FastifyReply,\s*\n?\s*\): Promise<FastifyReply> \| void/,
    );
  });

  it('CRITICAL replyWithProblem helper is `async` — returns Promise<FastifyReply>. The async modifier lets Fastify await the reply.send chain; drift to sync would let reply.send fire-and-forget.', () => {
    const src = read(ERROR_HANDLER);
    expect(src).toMatch(
      /async function replyWithProblem\(reply: FastifyReply, problem: Problem\): Promise<FastifyReply>/,
    );
  });

  it('Server middleware 5-invariant cluster — registerErrorHandler + setNotFoundHandler + problem+json content-type + ApiError pass-through + 5xx-vs-4xx log-shape differentiation. Drift on any would fragment the canonical wire-conversion layer.', () => {
    const src = read(ERROR_HANDLER);

    expect(src).toMatch(/registerErrorHandler/);
    expect(src).toMatch(/setNotFoundHandler/);
    expect(src).toMatch(/application\/problem\+json/);
    expect(src).toMatch(/if \(err instanceof ApiError\) return err;/);
    expect(src).toMatch(/request\.log\.error/);
    expect(src).toMatch(/request\.log\.warn/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/server-error-handler-middleware-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
