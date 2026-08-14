// W979 — error-handler RFC 7807 cross-source invariant. Three-
// hundred-fifth in the drift-guard series. Pins the apps/server/src/
// middleware/error-handler.ts global Fastify error-mapping primitive:
//
//   Header framing — 'Fastify error handler — every escaping error
//   becomes an RFC 7807 problem+json response. The handler: returns
//   ApiError.toProblem() for known errors + converts ZodError to a
//   ValidationError shape + wraps everything else as InternalError,
//   logged with full stack. Sets Content-Type: application/problem+
//   json on every response'.
//
//   registerErrorHandler 2-hook wire-up:
//     - app.setErrorHandler(handleError) for thrown errors.
//     - app.setNotFoundHandler for 404 (also problem+json).
//
//   404 NotFoundHandler problem shape:
//     - type: 'https://errors.driftstack.dev/not-found'.
//     - title: 'Not Found'.
//     - status: 404.
//     - detail: `No route for ${method} ${url}.`.
//     - instance: request.id.
//
//   handleError log-level routing:
//     - status >= 500 → request.log.error with full err + problem.
//     - status >= 400 → request.log.warn with {name, message} +
//       problem (no full stack to avoid log spam from validation
//       errors).
//
//   normaliseError 4-branch waterfall:
//     1. ApiError instance → return as-is.
//     2. ZodError → new ValidationError(err.flatten()).
//     3. Fastify validation/parser error (numeric statusCode <500) →
//        ApiError with status-code-derived type + title, chosen as ONE
//        pair so they cannot disagree:
//          - 401 → 'unauthorized' + title 'Unauthorized'.
//          - 403 → 'forbidden'    + title 'Forbidden'.
//          - else → 'bad-request' + title 'Bad Request'.
//
//        CORRECTED 2026-08-14. This said "403 → 'forbidden' + title 'Bad
//        Request' (note: the title is shared with the else branch — see
//        source)". That was accurate about the code and wrong about the
//        contract: RFC 7807 §3.1 makes `title` a summary of the TYPE, and
//        a forbidden problem titled "Bad Request" names a different class
//        than the URI beside it. The note recorded the defect and the pin
//        then protected it, which is worse than not noticing — it makes
//        the fix look like the drift. Fixed in the source; type and title
//        now come from one tuple, so a future arm cannot reintroduce it.
//     4. Anything else → InternalError (hides internals).
//
//   replyWithProblem sets:
//     - reply.code(problem.status).
//     - reply.header('content-type', 'application/problem+json;
//       charset=utf-8').
//     - reply.send(problem).
//
// stays in lockstep across apps/server/src/middleware/error-handler.ts.

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

describe('W979 error-handler RFC 7807 cross-source invariant', () => {
  // ─── Header framing ──────────────────────────────────────────

  it("CRITICAL apps/server/src/middleware/error-handler.ts header pins surface — 'Fastify error handler — every escaping error becomes an RFC 7807 problem+json response. The handler: returns ApiError.toProblem() for known errors + converts ZodError to a ValidationError shape + wraps everything else as InternalError, logged with full stack. Sets Content-Type: application/problem+json on every response'. The 3-branch + uniform-content-type design is the V-204 RFC 7807 contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/error-handler.ts'));
    expect(p).toMatch(/Fastify error handler — every escaping error becomes an RFC 7807/);
    expect(p).toMatch(/problem\+json response\. The handler:/);
    expect(p).toMatch(/- returns ApiError\.toProblem\(\) for known errors/);
    expect(p).toMatch(/- converts ZodError to a ValidationError shape/);
    expect(p).toMatch(/- wraps everything else as InternalError, logged with full stack/);
    expect(p).toMatch(/Sets `Content-Type: application\/problem\+json` on every response\./);
  });

  // ─── registerErrorHandler 2-hook wire-up ─────────────────────

  it('CRITICAL registerErrorHandler wires both setErrorHandler + setNotFoundHandler. The 2-hook set is what catches both thrown-during-handler + no-matching-route paths.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/error-handler.ts'));
    expect(p).toMatch(/export function registerErrorHandler\(app: FastifyInstance\): void \{/);
    expect(p).toMatch(/app\.setErrorHandler\(handleError\);/);
    expect(p).toMatch(/\/\/ Replace the default 404 handler so every miss is also problem\+json\./);
    expect(p).toMatch(/app\.setNotFoundHandler\(\(request, reply\) => \{/);
  });

  // ─── 404 problem shape ───────────────────────────────────────

  it("CRITICAL 404 NotFoundHandler emits problem with type:'https://errors.driftstack.dev/not-found' + title:'Not Found' + status:404 + detail:`No route for ${method} ${url}.` + instance:request.id. The 5-field problem matches the V-204 RFC 7807 envelope shape.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/error-handler.ts'));
    // The URI moved behind PROBLEM_TYPES, so the claim splits: the handler uses
    // the constant, and the constant still holds the pinned URI. Asserting the
    // literal alone would now fail on a change that made the code SAFER, and
    // asserting the constant alone would stop pinning the value.
    expect(p).toMatch(/type: PROBLEM_TYPES\.NotFound,/);
    expect(PROBLEM_TYPES.NotFound).toBe('https://errors.driftstack.dev/not-found');
    expect(p).toMatch(/title: 'Not Found',/);
    expect(p).toMatch(/status: 404,/);
    expect(p).toMatch(
      /detail: `No route for \$\{request\.method\} \$\{redactUrlQueryTokens\(request\.url\)\}\.`,/,
    );
    expect(p).toMatch(/instance: request\.id,/);
  });

  // ─── handleError log-level routing ───────────────────────────

  it("CRITICAL handleError log-routing — status >= 500 → request.log.error with {err, problem} + 'request failed: 5xx' message. The full-error + problem combo gives ops enough to triage server-side failures.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/error-handler.ts'));
    expect(p).toMatch(/if \(apiError\.status >= 500\) \{/);
    expect(p).toMatch(
      /request\.log\.error\(\{ err, problem: apiError\.toProblem\(\) \}, 'request failed: 5xx'\);/,
    );
  });

  it("CRITICAL handleError log-routing — status >= 400 → request.log.warn with FULL err + problem + 'request rejected: 4xx' message. Post-2026-05-19 scheduled-jobs-poller wrapper-bug lesson: passing the raw err lets Pino stdSerializers.err extract name+message+stack+cause; the prior {name,message} wrapper dropped the stack reference.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/error-handler.ts'));
    expect(p).toMatch(/\} else if \(apiError\.status >= 400\) \{/);
    expect(p).toMatch(
      /request\.log\.warn\(\{ err, problem: apiError\.toProblem\(\) \}, 'request rejected: 4xx'\);/,
    );
  });

  // ─── normaliseError 4-branch waterfall ───────────────────────

  it('CRITICAL normaliseError branch 1 — ApiError instance returns as-is. The instanceof check lets services-thrown ApiErrors propagate unchanged.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/error-handler.ts'));
    expect(p).toMatch(/if \(err instanceof ApiError\) return err;/);
  });

  it('CRITICAL normaliseError branch 2 — ZodError → new ValidationError(err.flatten()). The flatten() turns Zod issue tree into the V-204 flat-issues array.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/error-handler.ts'));
    expect(p).toMatch(/if \(err instanceof ZodError\) \{/);
    expect(p).toMatch(/return new ValidationError\(err\.flatten\(\)\);/);
  });

  it("CRITICAL normaliseError branch 3 framing — 'Fastify's body-parser / validator throws errors with a numeric statusCode and a code like FST_ERR_VALIDATION. Treat those as 400s'. The FST_ERR_VALIDATION + numeric-statusCode-<500 design is the Fastify-error coercion contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/error-handler.ts'));
    expect(p).toMatch(/Fastify's body-parser \/ validator throws errors with a numeric statusCode/);
    expect(p).toMatch(/and a code like 'FST_ERR_VALIDATION'\. Treat those as 400s\./);
    expect(p).toMatch(
      /if \(typeof fastifyErr\.statusCode === 'number' && fastifyErr\.statusCode < 500\) \{/,
    );
  });

  it("CRITICAL normaliseError branch 3 status-code → type ladder — 401 → 'unauthorized', 403 → 'forbidden', else → 'bad-request', each PAIRED with the matching title. The ladder picks the correct errors.driftstack.dev/* class from the status code.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/error-handler.ts'));
    expect(p).toMatch(/fastifyErr\.statusCode === 401/);
    expect(p).toMatch(/\[PROBLEM_TYPES\.Unauthorized, 'Unauthorized'\] as const/);
    expect(p).toMatch(/fastifyErr\.statusCode === 403/);
    expect(p).toMatch(/\[PROBLEM_TYPES\.Forbidden, 'Forbidden'\] as const/);
    expect(p).toMatch(/\[PROBLEM_TYPES\.BadRequest, 'Bad Request'\] as const/);
    // The pinned URIs, still pinned — now via the constants the source uses.
    expect(PROBLEM_TYPES.Unauthorized).toBe('https://errors.driftstack.dev/unauthorized');
    expect(PROBLEM_TYPES.Forbidden).toBe('https://errors.driftstack.dev/forbidden');
    expect(PROBLEM_TYPES.BadRequest).toBe('https://errors.driftstack.dev/bad-request');
  });

  it("CRITICAL normaliseError branch 4 framing — 'Anything else: hide internals'. The else → InternalError + original-err-as-cause design prevents leaking stack traces / module names to clients.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/error-handler.ts'));
    expect(p).toMatch(/\/\/ Anything else: hide internals\./);
    expect(p).toMatch(/return new InternalError\('An unexpected error occurred\.', err\);/);
  });

  // ─── replyWithProblem 3-step ─────────────────────────────────

  it("CRITICAL replyWithProblem 3-step — reply.code(problem.status) + reply.header('content-type', 'application/problem+json; charset=utf-8') + reply.send(problem). The status-from-problem + uniform-content-type + send-problem chain is the V-204 RFC 7807 wire-emission.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/error-handler.ts'));
    expect(p).toMatch(
      /async function replyWithProblem\(reply: FastifyReply, problem: Problem\): Promise<FastifyReply> \{/,
    );
    expect(p).toMatch(/return reply/);
    expect(p).toMatch(/\.code\(problem\.status\)/);
    expect(p).toMatch(/\.header\('content-type', 'application\/problem\+json; charset=utf-8'\)/);
    expect(p).toMatch(/\.send\(problem\);/);
  });

  // ─── handleError calls toProblem with request.id ─────────────

  it('CRITICAL handleError passes request.id to toProblem (for the problem.instance correlation field). The request.id-as-instance design is what makes errors traceable to requests.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/middleware/error-handler.ts'));
    expect(p).toMatch(/return replyWithProblem\(reply, apiError\.toProblem\(request\.id\)\);/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/error-handler-rfc7807-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
