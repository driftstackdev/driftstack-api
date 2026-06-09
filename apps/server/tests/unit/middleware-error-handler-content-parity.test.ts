// W394.A — drift guard for apps/server/src/middleware/error-handler.ts.
// RFC 7807 problem+json envelope is THE customer-facing error contract —
// SDK error-mapping logic and /docs/errors-reference both depend on the
// shape staying stable. Drift here either leaks internal error messages
// (ApiError-bypass branch lost) or breaks every customer's error
// branching code (Content-Type changes, problem fields renamed).
//
//   • RFC 7807 framing pinned ("every escaping error becomes a
//     problem+json response").
//   • 4 normalisation paths: ApiError → toProblem, ZodError →
//     ValidationError, FastifyError <500 → typed ApiError shim,
//     anything else → InternalError (with cause).
//   • setNotFoundHandler: per-route 404 also problem+json (driftstack
//     errors host).
//   • Content-Type: application/problem+json; charset=utf-8.
//   • Log levels: 5xx → request.log.error (with full err), 4xx →
//     request.log.warn (sanitised {name, message} only — no stack).
//   • FastifyError <500 type mapping: 401 → unauthorized, 403 →
//     forbidden, else → bad-request.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const MW = resolve(REPO_ROOT, 'apps/server/src/middleware/error-handler.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W394.A apps/server/src/middleware/error-handler.ts content parity', () => {
  const body = read(MW);

  it('RFC 7807 framing pinned ("every escaping error becomes a problem+json response")', () => {
    expect(body).toMatch(
      /Fastify error handler — every escaping error becomes an RFC 7807\s*\n?\s*\/\/\s*problem\+json response\. The handler:/,
    );
  });

  it('3-bullet handler contract: ApiError.toProblem / ZodError → ValidationError / wrap rest as InternalError with stack', () => {
    expect(body).toMatch(/- returns ApiError\.toProblem\(\) for known errors/);
    expect(body).toMatch(/- converts ZodError to a ValidationError shape/);
    expect(body).toMatch(/- wraps everything else as InternalError, logged with full stack/);
  });

  it('Content-Type framing pinned: application/problem+json on every response', () => {
    expect(body).toMatch(/Sets `Content-Type: application\/problem\+json` on every response\./);
  });

  it('registerErrorHandler: setErrorHandler + setNotFoundHandler (per-route 404 also problem+json)', () => {
    expect(body).toMatch(
      /export function registerErrorHandler\(app: FastifyInstance\): void \{\s*\n?\s*app\.setErrorHandler\(handleError\);/,
    );
    expect(body).toMatch(
      /\/\/ Replace the default 404 handler so every miss is also problem\+json\./,
    );
  });

  it('setNotFoundHandler: type=errors.driftstack.dev/not-found, status 404, detail="No route for METHOD URL"', () => {
    expect(body).toMatch(
      /app\.setNotFoundHandler\(\(request, reply\) => \{\s*\n?\s*void replyWithProblem\(reply, \{\s*\n?\s*type: 'https:\/\/errors\.driftstack\.dev\/not-found',\s*\n?\s*title: 'Not Found',\s*\n?\s*status: 404,[\s\S]*?detail: `No route for \$\{request\.method\} \$\{redactUrlQueryTokens\(request\.url\)\}\.`,\s*\n?\s*instance: request\.id,\s*\n?\s*\}\);/,
    );
  });

  it('handleError: 5xx → request.log.error(err+problem), 4xx → request.log.warn(err+problem) (post-2026-05-19 scheduled-jobs-poller wrapper-bug lesson: pass through full err for Pino stdSerializers.err extraction). 2026-05-21 — 503 FeatureUnavailableError split off to warn level (intentional / activation-gate; not a real failure that should page on-call).', () => {
    expect(body).toMatch(
      /if \(apiError\.status === 503\) \{\s*\n?\s*request\.log\.warn\(\{ err, problem: apiError\.toProblem\(\) \}, 'feature unavailable: 503'\);\s*\n?\s*\} else if \(apiError\.status >= 500\) \{\s*\n?\s*request\.log\.error\(\{ err, problem: apiError\.toProblem\(\) \}, 'request failed: 5xx'\);\s*\n?\s*\} else if \(apiError\.status >= 400\) \{/,
    );
    expect(body).toMatch(
      /request\.log\.warn\(\{ err, problem: apiError\.toProblem\(\) \}, 'request rejected: 4xx'\);/,
    );
  });

  it('handleError: passes request.id as instance to toProblem', () => {
    expect(body).toMatch(/return replyWithProblem\(reply, apiError\.toProblem\(request\.id\)\);/);
  });

  it('normaliseError: ApiError instance returned unchanged', () => {
    expect(body).toMatch(/if \(err instanceof ApiError\) return err;/);
  });

  it('normaliseError: ZodError → new ValidationError(err.flatten())', () => {
    expect(body).toMatch(
      /if \(err instanceof ZodError\) \{\s*\n?\s*return new ValidationError\(err\.flatten\(\)\);\s*\n?\s*\}/,
    );
  });

  it('normaliseError: FastifyError <500 with numeric statusCode → typed ApiError (401→unauthorized, 403→forbidden, else→bad-request)', () => {
    expect(body).toMatch(
      /Fastify's body-parser \/ validator throws errors with a numeric statusCode\s*\n?\s*\/\/\s*and a code like 'FST_ERR_VALIDATION'\. Treat those as 400s\./,
    );
    expect(body).toMatch(
      /if \(typeof fastifyErr\.statusCode === 'number' && fastifyErr\.statusCode < 500\) \{/,
    );
    expect(body).toMatch(
      /fastifyErr\.statusCode === 401\s*\n?\s*\?\s*'https:\/\/errors\.driftstack\.dev\/unauthorized'\s*\n?\s*:\s*fastifyErr\.statusCode === 403\s*\n?\s*\?\s*'https:\/\/errors\.driftstack\.dev\/forbidden'\s*\n?\s*:\s*'https:\/\/errors\.driftstack\.dev\/bad-request',/,
    );
    expect(body).toMatch(
      /title: fastifyErr\.statusCode === 401 \? 'Unauthorized' : 'Bad Request',/,
    );
  });

  it('normaliseError: catch-all → InternalError (with cause) — "hide internals" framing pinned', () => {
    expect(body).toMatch(/\/\/ Anything else: hide internals\./);
    expect(body).toMatch(/return new InternalError\('An unexpected error occurred\.', err\);/);
  });

  it('replyWithProblem: reply.code(problem.status).header("content-type", "application/problem+json; charset=utf-8").send(problem)', () => {
    expect(body).toMatch(
      /async function replyWithProblem\(reply: FastifyReply, problem: Problem\): Promise<FastifyReply> \{\s*\n?\s*return reply\s*\n?\s*\.code\(problem\.status\)\s*\n?\s*\.header\('content-type', 'application\/problem\+json; charset=utf-8'\)\s*\n?\s*\.send\(problem\);\s*\n?\s*\}/,
    );
  });

  it('imports: ZodError + Problem type + ApiError/InternalError/ValidationError', () => {
    expect(body).toMatch(/import \{ ZodError \} from 'zod';/);
    expect(body).toMatch(/import type \{ Problem \} from '@driftstack\/api-types';/);
    expect(body).toMatch(
      /import \{ ApiError, InternalError, ValidationError \} from '\.\.\/lib\/errors\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(MW)).toBe(true);
  });
});
