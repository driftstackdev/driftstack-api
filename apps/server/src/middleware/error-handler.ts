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
import type { Problem } from '@driftstack/api-types';
import { ApiError, InternalError, ValidationError } from '../lib/errors.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(handleError);

  // Replace the default 404 handler so every miss is also problem+json.
  app.setNotFoundHandler((request, reply) => {
    void replyWithProblem(reply, {
      type: 'https://errors.driftstack.dev/not-found',
      title: 'Not Found',
      status: 404,
      detail: `No route for ${request.method} ${request.url}.`,
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
  if (apiError.status >= 500) {
    request.log.error({ err, problem: apiError.toProblem() }, 'request failed: 5xx');
  } else if (apiError.status >= 400) {
    request.log.warn(
      { err: { name: err.name, message: err.message }, problem: apiError.toProblem() },
      'request rejected: 4xx',
    );
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
    return new ApiError({
      type:
        fastifyErr.statusCode === 401
          ? 'https://errors.driftstack.dev/unauthorized'
          : fastifyErr.statusCode === 403
            ? 'https://errors.driftstack.dev/forbidden'
            : 'https://errors.driftstack.dev/bad-request',
      title: fastifyErr.statusCode === 401 ? 'Unauthorized' : 'Bad Request',
      status: fastifyErr.statusCode,
      detail: fastifyErr.message,
    });
  }

  // Anything else: hide internals.
  return new InternalError('An unexpected error occurred.', err);
}

async function replyWithProblem(reply: FastifyReply, problem: Problem): Promise<FastifyReply> {
  return reply
    .code(problem.status)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .send(problem);
}
