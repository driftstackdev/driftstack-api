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
import { PROBLEM_TYPES } from '@driftstack/api-types';

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

  // SPLIT + re-anchored. The single chain ran from setNotFoundHandler through
  // every field as consecutive lines, so a comment explaining why the type moved
  // behind PROBLEM_TYPES broke a pin about the 404 SHAPE. Each field is now its
  // own assertion inside a bounded slice of the handler.
  it('setNotFoundHandler: type=PROBLEM_TYPES.NotFound (errors.driftstack.dev/not-found), status 404, detail="No route for METHOD URL"', () => {
    const start = body.indexOf('app.setNotFoundHandler(');
    expect(start, 'the 404 handler was found').toBeGreaterThan(-1);
    const block = body.slice(start, start + 900);
    // MEASURED: the handler is ~640 chars. A floor catches a slice that stopped
    // matching; the window above catches one that ran into the next function.
    expect(block.length, 'the sliced handler is a plausible size').toBeGreaterThan(300);

    expect(block).toMatch(/void replyWithProblem\(reply, \{/);
    expect(block).toMatch(/type: PROBLEM_TYPES\.NotFound,/);
    expect(PROBLEM_TYPES.NotFound).toBe('https://errors.driftstack.dev/not-found');
    expect(block).toMatch(/title: 'Not Found',/);
    expect(block).toMatch(/status: 404,/);
    expect(block).toMatch(
      /detail: `No route for \$\{request\.method\} \$\{redactUrlQueryTokens\(request\.url\)\}\.`,/,
    );
    expect(block).toMatch(/instance: request\.id,/);
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

  // CORRECTED 2026-08-14. The title assertion below used to pin
  // `title: fastifyErr.statusCode === 401 ? 'Unauthorized' : 'Bad Request'` —
  // a two-arm title over a three-arm type, so a 403 shipped
  // `{type: .../forbidden, title: 'Bad Request'}`. RFC 7807 §3.1 makes title a
  // summary of the TYPE, so that named a different class than the URI beside
  // it. Source now picks both from one tuple; behaviour is covered by
  // `problem-title-agrees-with-problem-type`, which drives the real handler.
  it('normaliseError: FastifyError <500 with numeric statusCode → typed ApiError, type and title paired (401→unauthorized/Unauthorized, 403→forbidden/Forbidden, else→bad-request/Bad Request)', () => {
    expect(body).toMatch(
      /Fastify's body-parser \/ validator throws errors with a numeric statusCode\s*\n?\s*\/\/\s*and a code like 'FST_ERR_VALIDATION'\. Treat those as 400s\./,
    );
    expect(body).toMatch(
      /if \(typeof fastifyErr\.statusCode === 'number' && fastifyErr\.statusCode < 500\) \{/,
    );
    expect(body).toMatch(
      /fastifyErr\.statusCode === 401\s*\n?\s*\?\s*\(\[PROBLEM_TYPES\.Unauthorized, 'Unauthorized'\] as const\)\s*\n?\s*:\s*fastifyErr\.statusCode === 403\s*\n?\s*\?\s*\(\[PROBLEM_TYPES\.Forbidden, 'Forbidden'\] as const\)\s*\n?\s*:\s*\(\[PROBLEM_TYPES\.BadRequest, 'Bad Request'\] as const\);/,
    );
    expect(body).toMatch(/const \[type, title\] =/);
    expect(body).toMatch(/^\s*type,\s*$/m);
    expect(body).toMatch(/^\s*title,\s*$/m);
  });

  it('normaliseError: catch-all → InternalError (with cause) — "hide internals" framing pinned', () => {
    expect(body).toMatch(/\/\/ Anything else: hide internals\./);
    expect(body).toMatch(/return new InternalError\('An unexpected error occurred\.', err\);/);
  });

  // SPLIT. The single regex ran from the signature through to the closing brace
  // as consecutive lines, so adding the RFC 7235 challenge INSIDE the function
  // broke a pin about how the reply is SENT. The signature and the send chain
  // are pinned separately; the 401 challenge has its own assertion below, and
  // its behaviour is covered by `a-401-carries-the-challenge-rfc7235-requires`.
  it('replyWithProblem: reply.code(problem.status).header("content-type", "application/problem+json; charset=utf-8").send(problem)', () => {
    expect(body).toMatch(
      /async function replyWithProblem\(reply: FastifyReply, problem: Problem\): Promise<FastifyReply> \{/,
    );
    expect(body).toMatch(
      /return reply\s*\n?\s*\.code\(problem\.status\)\s*\n?\s*\.header\('content-type', 'application\/problem\+json; charset=utf-8'\)\s*\n?\s*\.send\(problem\);/,
    );
  });

  it('replyWithProblem: a 401 gets a WWW-Authenticate challenge (RFC 7235 §3.1), set only when absent so a route-specific challenge is not overwritten', () => {
    expect(body).toMatch(
      /if \(problem\.status === 401 && !reply\.hasHeader\('www-authenticate'\)\) \{\s*\n?\s*reply\.header\('www-authenticate', 'Bearer'\);\s*\n?\s*\}/,
    );
  });

  it('imports: ZodError + Problem type + ApiError/InternalError/ValidationError', () => {
    expect(body).toMatch(/import \{ ZodError \} from 'zod';/);
    // PROBLEM_TYPES is now a VALUE import alongside the type-only Problem: the
    // handler builds envelopes from the constants rather than URI literals.
    expect(body).toMatch(/import \{ PROBLEM_TYPES, type Problem \} from '@driftstack\/api-types';/);
    expect(body).toMatch(
      /import \{ ApiError, InternalError, ValidationError \} from '\.\.\/lib\/errors\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(MW)).toBe(true);
  });
});
