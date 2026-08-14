// A problem's title names the same class its type URI does.
//
// Errors Fastify itself throws — a body that fails the route schema, a parser
// rejection, a plugin that sets `statusCode` — are not `ApiError`s, so they go
// through `normaliseError`'s third branch and get a problem envelope built from
// the numeric status.
//
// That branch used to choose `type` and `title` in two SEPARATE ternaries over
// the same status. The type had three arms (401 / 403 / else); the title had
// two. So a 403 shipped:
//
//     { type: ".../forbidden", title: "Bad Request", status: 403 }
//
// RFC 7807 §3.1: title is "a short, human-readable summary of the problem
// type". Naming a DIFFERENT problem class than the URI beside it is the one
// thing it must not do. A customer logging `title` records "Bad Request" for a
// permission failure; a dashboard showing `title` says the request was
// malformed when it was refused.
//
// This was not undiscovered. `error-handler-rfc7807-cross-source-invariant`
// described it exactly — "403 → 'forbidden' + title 'Bad Request' (note: the
// title is shared with the else branch — see source)" — and pinned it. The pin
// was accurate about what the code did and silent on whether it should. That is
// worth naming: an accurate pin over a defect turns "nobody noticed" into
// "somebody noticed and it shipped anyway", and makes the eventual FIX look
// like the drift. A pin records what the code SAID, never whether it was right.
//
// The fix pairs the two in one tuple instead of adding a third arm, because the
// bug was not a missing arm — it was two expressions free to disagree about the
// same input. This file asserts the property that makes that hold: for every
// status the branch handles, title and type name the same class.
//
// It drives the REAL handler through a real Fastify instance rather than
// matching source text, so it is about behaviour a customer can observe.

import Fastify from 'fastify';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import { describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';

/** The problem body produced for a Fastify-thrown error carrying `status`. */
async function problemForFastifyStatus(status: number): Promise<Record<string, unknown>> {
  const app = Fastify();
  registerErrorHandler(app);
  app.get('/boom', () => {
    const err = new Error(`fastify rejected this with ${String(status)}`) as Error & {
      statusCode?: number;
    };
    err.statusCode = status;
    throw err;
  });
  const res = await app.inject({ method: 'GET', url: '/boom' });
  expect(res.statusCode, `the handler answered ${String(status)}`).toBe(status);
  await app.close();
  return res.json<Record<string, unknown>>();
}

/** Which problem class a type URI names, e.g. ".../forbidden" -> "forbidden". */
const classOf = (type: unknown): string => String(type).split('/').pop() ?? '';

/** A title reduced to the same shape, e.g. "Bad Request" -> "bad-request". */
const titleSlug = (title: unknown): string => String(title).toLowerCase().replace(/\s+/g, '-');

describe('a problem title agrees with its problem type', () => {
  it('CRITICAL the handler is reachable and produces a real problem envelope. Every assertion below reads fields off this body — if the route threw before the handler ran, or the body came back empty, comparing two undefined values would report perfect agreement having compared nothing.', async () => {
    const body = await problemForFastifyStatus(400);
    expect(Object.keys(body).length, 'the problem body has fields').toBeGreaterThanOrEqual(3);
    expect(body['type'], 'it carries a type URI').toMatch(/^https:\/\/errors\.driftstack\.dev\//);
    expect(typeof body['title'], 'it carries a title').toBe('string');
    expect(body['status'], 'and the status is echoed into the body').toBe(400);
  });

  it('CRITICAL a 403 is titled Forbidden, not Bad Request. This is the defect: the type said forbidden while the title said the request was malformed, so a customer logging title recorded the wrong failure for a permission refusal.', async () => {
    const body = await problemForFastifyStatus(403);
    expect(body['type'], 'the type names the forbidden class').toBe(PROBLEM_TYPES.Forbidden);
    expect(body['title'], 'and so does the title').toBe('Forbidden');
  });

  it.each([
    { status: 401, type: PROBLEM_TYPES.Unauthorized, title: 'Unauthorized' },
    { status: 403, type: PROBLEM_TYPES.Forbidden, title: 'Forbidden' },
    { status: 400, type: PROBLEM_TYPES.BadRequest, title: 'Bad Request' },
    // Not 401/403, so it takes the fallback arm. The status is still echoed
    // truthfully; only the class is generic.
    { status: 415, type: PROBLEM_TYPES.BadRequest, title: 'Bad Request' },
  ])(
    'CRITICAL status $status maps to $type titled "$title". Pinning the whole mapping rather than the one broken case: the bug was two expressions free to disagree, so the property worth holding is that they agree for EVERY status this branch handles, not that one arm was patched.',
    async ({ status, type, title }) => {
      const body = await problemForFastifyStatus(status);
      expect(body['type'], `type for ${String(status)}`).toBe(type);
      expect(body['title'], `title for ${String(status)}`).toBe(title);
      expect(body['status'], `status echoed for ${String(status)}`).toBe(status);
    },
  );

  it('CRITICAL title and type name the same class, derived rather than restated. The cases above compare against expected values written here; this compares the two fields to EACH OTHER, so a future arm added with a mismatched pair fails even though no expectation in this file mentions it.', async () => {
    const disagreements: string[] = [];
    for (const status of [400, 401, 403, 415]) {
      const body = await problemForFastifyStatus(status);
      if (classOf(body['type']) !== titleSlug(body['title'])) {
        disagreements.push(
          `${String(status)}: type=${classOf(body['type'])} but title=${String(body['title'])}`,
        );
      }
    }
    expect(disagreements, 'status(es) whose title names a different class than its type:').toEqual(
      [],
    );
  });

  it('CRITICAL a route miss is still problem+json and still agrees. The 404 handler is a separate call site that builds its envelope by hand, and its type URI is NOT compile-checked — Problem.type is z.string().url(), not the closed ProblemType union — so a typo there would ship a class no client can switch on.', async () => {
    const app = Fastify();
    registerErrorHandler(app);
    const res = await app.inject({ method: 'GET', url: '/no-such-route' });
    await app.close();

    expect(res.statusCode, 'a miss answers 404').toBe(404);
    expect(res.headers['content-type'], 'as problem+json').toMatch(/application\/problem\+json/);
    const body = res.json<Record<string, unknown>>();
    expect(body['type'], 'with the not-found class').toBe(PROBLEM_TYPES.NotFound);
    expect(body['title'], 'titled to match').toBe('Not Found');
  });
});
