// Fastify error handler — every escaping error becomes an RFC 7807
// problem+json response. The handler:
//
//   - returns ApiError.toProblem() for known errors
//   - converts ZodError to a ValidationError shape
//   - wraps everything else as InternalError, logged with full stack
//
// Sets `Content-Type: application/problem+json` on every response.

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { PROBLEM_TYPES, type Problem } from '@driftstack/api-types';
import { ApiError, BadRequestError, InternalError, ValidationError } from '../lib/errors.js';
import { redactUrlQueryTokens } from '../lib/redact-url.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(handleError);

  // Replace the default 404 handler so every miss is also problem+json.
  app.setNotFoundHandler((request, reply) => {
    void replyWithProblem(reply, {
      // PROBLEM_TYPES rather than the literal: `Problem.type` is
      // `z.string().url()`, not the closed `ProblemType` union, so a typo in
      // this URI would compile and ship a problem class no client can switch on.
      type: PROBLEM_TYPES.NotFound,
      title: 'Not Found',
      status: 404,
      // Redact credential query tokens (the SSE `?ds_token=`, OAuth `?code=`)
      // from the echoed URL — a 404 on a token-bearing path must not reflect
      // the token back in the response body (V-494 posture; same as the log +
      // Sentry url redaction).
      detail: `No route for ${request.method} ${redactUrlQueryTokens(request.url)}.`,
      instance: request.id,
    });
  });
}

function handleError(
  err: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> | void {
  const apiError = normaliseError(err, request);

  // Log at appropriate level.
  // 2026-05-21 — 503 FeatureUnavailableError is intentional / expected
  // (activation-gate not wired; deploy-time env config). Don't log as
  // an error to avoid Sentry false-positives — log at warn so the
  // signal is still observable but doesn't page the on-call channel.
  // Genuine 5xx (DB exception, unexpected JS error, etc.) keep the
  // error level so they still trigger alerts.
  if (apiError.status === 503) {
    request.log.warn({ err, problem: apiError.toProblem() }, 'feature unavailable: 503');
  } else if (apiError.status >= 500) {
    request.log.error({ err, problem: apiError.toProblem() }, 'request failed: 5xx');
  } else if (apiError.status >= 400) {
    // Pass `err` directly so Pino's stdSerializers.err extracts
    // name+message+stack+cause. Earlier this wrapped to `{ name, message
    // }` only — drops the stack reference Pino needs (the wrapper is a
    // plain Object, Pino sees no .stack property). Same class of bug
    // as the 2026-05-19 scheduled-jobs-poller wrapper that hid the
    // 10-day prod TypeError stack (commit 5d7d7348). 4xx is usually
    // expected client error so the stack is less critical, but the
    // wrapper-shape consistency closes the loop.
    request.log.warn({ err, problem: apiError.toProblem() }, 'request rejected: 4xx');
  }

  // RFC 7231 §7.1.3: 429 + 503 responses SHOULD carry the Retry-After
  // header so client SDKs can implement standards-conformant backoff
  // without parsing the problem-body. Read from the source extensions
  // (toProblem() spreads extensions at top-level of the body but the
  // typed access is cleaner against the ApiError instance).
  if (apiError.status === 429 || apiError.status === 503) {
    const retryAfter = apiError.extensions['retry_after_seconds'];
    if (typeof retryAfter === 'number' && retryAfter >= 0) {
      reply.header('retry-after', Math.ceil(retryAfter).toString());
    }
  }

  return replyWithProblem(reply, apiError.toProblem(request.id));
}

function normaliseError(err: FastifyError | Error, _request: FastifyRequest): ApiError {
  if (err instanceof ApiError) return err;

  if (err instanceof ZodError) {
    return new ValidationError(err.flatten());
  }

  // Fastify's body-parser / validator throws errors with a numeric statusCode
  // and a code like 'FST_ERR_VALIDATION'. Treat those as 400s.
  const fastifyErr = err as FastifyError;
  if (typeof fastifyErr.statusCode === 'number' && fastifyErr.statusCode < 500) {
    // Type and title are chosen TOGETHER. They used to be two independent
    // ternaries over the same status: the type had three arms (401 / 403 /
    // else), the title had two. A 403 therefore shipped
    // `{type: .../forbidden, title: 'Bad Request', status: 403}` — a title
    // naming a different problem class than the URI beside it, which is the one
    // thing RFC 7807 §3.1 says a title must not be (it summarises the TYPE).
    // Pairing them removes the failure mode rather than adding the third arm:
    // one expression cannot disagree with itself.
    const [type, title] =
      fastifyErr.statusCode === 401
        ? ([PROBLEM_TYPES.Unauthorized, 'Unauthorized'] as const)
        : fastifyErr.statusCode === 403
          ? ([PROBLEM_TYPES.Forbidden, 'Forbidden'] as const)
          : ([PROBLEM_TYPES.BadRequest, 'Bad Request'] as const);
    return new ApiError({
      type,
      title,
      status: fastifyErr.statusCode,
      detail: fastifyErr.message,
    });
  }

  // V-780 — an upstream 4xx is the CALLER's problem, not ours.
  //
  // StripeApiError carries `status`, not Fastify's `statusCode`, so the numeric check above
  // never matched it and every Stripe rejection became a 500 logged at ERROR. The one that
  // actually reaches customers is `idempotency_error`: a reused Idempotency-Key with changed
  // parameters is a 400 from Stripe, and the customer saw "an unexpected error occurred" with
  // nothing to act on — while the operator got a paging-grade 500 for a client mistake.
  //
  // Only <500 is remapped. A Stripe 5xx really is our problem to page on, and stays a 500.
  const upstream = err as { name?: string; status?: number; message?: string };
  if (upstream.name === 'StripeApiError' && typeof upstream.status === 'number') {
    if (upstream.status < 500) {
      return new BadRequestError(upstream.message ?? 'The payment provider rejected this request.');
    }
  }

  // Anything else: hide internals.
  return new InternalError('An unexpected error occurred.', err);
}

async function replyWithProblem(reply: FastifyReply, problem: Problem): Promise<FastifyReply> {
  // RFC 7235 §3.1: a 401 MUST carry a WWW-Authenticate challenge. Exactly one
  // route was doing it — /metrics — while 218 paths declare a 401, so the
  // conformance was not a decision anyone had made, it was one route someone
  // happened to look at. Set here, in the single funnel every problem response
  // passes through, so it cannot be added to some 401s and forgotten on others.
  //
  // Only when absent. /metrics sets `Bearer realm="metrics"` and THEN throws, so
  // this sees the same reply with the header already on it; overwriting would
  // replace a specific challenge with a bare one and weaken it while looking
  // like added conformance. A route that says something more precise keeps
  // saying it.
  if (problem.status === 401 && !reply.hasHeader('www-authenticate')) {
    reply.header('www-authenticate', 'Bearer');
  }
  return reply
    .code(problem.status)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .send(problem);
}
