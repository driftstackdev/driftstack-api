// Every AuthFlowError the login route can raise produces the right refusal.
//
// Item 5f: 31 of 108 security deny sites had never executed. These five are the
// login path's, and they had the same shape as the MFA gate closed earlier —
// referenced by tests, executed by none. `routes/auth.ts:109`'s
// `ForbiddenError('Account is suspended.')` is named in exactly two test files
// and BOTH are content-parity regexes over the source text:
//
//   services-auth-content-parity.test.ts:187
//   routes-auth-content-parity.test.ts:109
//
// A refusal nobody has watched refuse is a control nobody has shown works.
//
// ─── why the status code alone is not enough ──────────────────────────────────
//
// `mapAuthFlowError` maps five codes onto four distinct statuses:
//
//   email_already_registered  409  EmailAlreadyRegistered
//   invalid_credentials       401  InvalidCredentials
//   invalid_auth_token        400  InvalidAuthToken
//   email_not_verified        403  EmailNotVerified
//   account_suspended         403  Forbidden
//
// The last two share a status and differ only in the problem `type`. A test
// asserting status would pass with those two cases swapped — and swapping them
// is not cosmetic: a suspended customer would be told to verify an email they
// verified long ago, and an unverified one would be told their account is
// suspended. Every arm here asserts the problem type, and the two 403s are
// asserted against each other explicitly.
//
// The `detail` on the suspended case is asserted for a related reason:
// `ForbiddenError` has a DEFAULT detail ("Caller is not permitted to perform
// this action."). Drop the argument at the call site and the response still
// carries 403 and the Forbidden type — only the sentence telling the customer
// why they cannot log in disappears, which is the entire content of that
// refusal.
//
// ─── the re-throw is a deny path too ──────────────────────────────────────────
//
// `mapAuthFlowError` opens with `if (!(err instanceof AuthFlowError)) throw err`.
// That line is what keeps an internal fault — a database outage inside
// `login()` — from being mapped onto one of the five customer-facing answers.
// Without it a caller would be told their password is wrong while the service
// is down: a wrong answer, an unactionable one, and one that hides an incident.
// It gets its own arm.
//
// MUTATION-PROVED against routes/auth.ts, running this file and BOTH existing
// content-parity pins. Controls: 9/9 here, 17/17 and 19/19 on the pins.
//
//                                                    here   routes-pin  svc-pin
//   suspended loses its detail argument              1 red    1 red      green
//   suspended answers as EmailNotVerified            2 red    1 red      green
//   the two 403s collapse onto one answer            2 red    1 red      green
//   bad credentials answer 403 instead of 401        1 red    1 red      green
//   a dead token answers 401 instead of 400          1 red    1 red      green
//   a registration conflict answers as bad creds     2 red    1 red      green
//   an internal fault is mapped onto 401             1 red    1 red      green
//
// The services-auth pin is green throughout and correctly so — it pins
// `services/auth.ts`, and nothing here mutates that file. It is listed to show
// the ledger is reading the right instrument rather than a coincidence.
//
// `routes-auth-content-parity` catches all seven, because its regex pins the
// whole `mapAuthFlowError` body verbatim. Textually complete — and still unable
// to say WHICH refusal broke: every mutation reds it at exactly one arm, with
// the same message. Here the reds land on 1–2 different arms whose names state
// what the caller would now be told. That is the distinction that matters on a
// security surface: "the text moved" and "a suspended customer is now told to
// verify their email" are not the same finding, and only one of them can be
// triaged without opening the diff.

import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';
import authPlugin from '../../src/middleware/auth.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { registerAuthRoutes } from '../../src/routes/auth.js';
import { AuthFlowError, type AuthFlowErrorCode } from '../../src/services/auth-flows.js';

/** A store that allows everything, so a refusal can never come from the limiter. */
const permissiveStore = {
  consume: () =>
    Promise.resolve({ allowed: true, remaining: 100, limit: 100, resetAt: new Date() }),
};

const CREDENTIALS = { email: 'someone@example.test', password: 'correct-horse-battery' };

/**
 * An app whose `login` fails in a chosen way.
 *
 * Only `login` is implemented: it is the one route driven here, and a double
 * that answered every method would let an arm pass through a path it never
 * meant to exercise.
 */
async function appWhereLoginThrows(err: Error): Promise<FastifyInstance> {
  const app = Fastify();
  registerErrorHandler(app);
  // The auth plugin is registered for one reason: /v1/auth/mfa/step-up lists
  // `app.requireAuth` in its preHandler array, so without the decorator that
  // route registers with an undefined hook and Fastify rejects the ENTIRE
  // plugin — every arm then fails on registration rather than on the mapper.
  await app.register(authPlugin, {
    authRepo: {} as never,
    authCache: null,
    authCoalescer: null,
  });
  registerAuthRoutes(app, {
    service: {
      login: () => Promise.reject(err),
    } as never,
    rateLimitStore: permissiveStore as never,
  });
  await app.ready();
  return app;
}

async function loginProblem(err: Error): Promise<{
  status: number;
  type: unknown;
  detail: unknown;
  title: unknown;
}> {
  const app = await appWhereLoginThrows(err);
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: CREDENTIALS });
  const body = res.json<Record<string, unknown>>();
  await app.close();
  return { status: res.statusCode, type: body.type, detail: body.detail, title: body.title };
}

const flow = (code: AuthFlowErrorCode): AuthFlowError => new AuthFlowError(code);

describe('every login refusal reaches the caller as the right refusal', () => {
  it('CRITICAL the harness reaches the mapper at all. Every arm below asserts a 4xx, and a route that rejected the request BEFORE calling login — a validation error on the fixture credentials, or the rate-limit gate — would produce a 4xx too and make all of them pass without executing a single deny path.', async () => {
    // A code that maps to a status no other arm uses, so this cannot be
    // satisfied by an incidental 400 from validation.
    const got = await loginProblem(flow('email_already_registered'));
    expect(got.status, 'the mapper ran and produced its own status').toBe(409);
    expect(got.type, 'and its own problem type').toBe(PROBLEM_TYPES.EmailAlreadyRegistered);
  });

  it('CRITICAL a suspended account is refused with 403 Forbidden and told WHY. This is the never-executed site at routes/auth.ts:109. ForbiddenError carries a default detail, so dropping the argument leaves the status and type intact and silently removes the only sentence explaining to the customer that their account is suspended rather than their password wrong.', async () => {
    const got = await loginProblem(flow('account_suspended'));
    expect(got.status, 'refused, not accepted').toBe(403);
    expect(got.type, 'as a plain Forbidden').toBe(PROBLEM_TYPES.Forbidden);
    expect(got.detail, 'and the reason survives to the caller').toBe('Account is suspended.');
  });

  it('CRITICAL an unverified email is refused as EmailNotVerified, NOT as the suspended-account Forbidden. Both are 403, so status cannot tell them apart; swapped, a customer who never verified is told their account is suspended, and a suspended one is told to verify an email they confirmed long ago. Neither can act on the answer they get.', async () => {
    const got = await loginProblem(flow('email_not_verified'));
    expect(got.status, 'also a 403').toBe(403);
    expect(got.type, 'but a DIFFERENT problem type').toBe(PROBLEM_TYPES.EmailNotVerified);
    expect(got.type, 'and specifically not the suspended one').not.toBe(PROBLEM_TYPES.Forbidden);
    expect(got.detail, 'with its own actionable sentence').toBe(
      'Verify your email address before logging in.',
    );
  });

  it('CRITICAL the two 403s are distinguishable from each other. Asserted as a pair rather than trusting the two arms above: they would both still pass if the mapper returned one shared 403 for both codes, which is exactly the collapse worth guarding.', async () => {
    const suspended = await loginProblem(flow('account_suspended'));
    const unverified = await loginProblem(flow('email_not_verified'));
    expect(suspended.status, 'same status').toBe(unverified.status);
    expect(suspended.type, 'different problem type').not.toBe(unverified.type);
    expect(suspended.detail, 'and different guidance').not.toBe(unverified.detail);
  });

  it('CRITICAL bad credentials are refused with 401, not 403. The distinction is what a client switches on to decide between "try again" and "contact support", and a 403 here would send someone who mistyped a password into a support queue.', async () => {
    const got = await loginProblem(flow('invalid_credentials'));
    expect(got.status, 'unauthenticated, not forbidden').toBe(401);
    expect(got.type, 'the credentials problem type').toBe(PROBLEM_TYPES.InvalidCredentials);
  });

  it('CRITICAL an invalid or already-used auth token is refused with 400. It is a malformed request rather than a rejected identity, and reporting it as 401 would make a client retry the same dead token with fresh credentials.', async () => {
    const got = await loginProblem(flow('invalid_auth_token'));
    expect(got.status, 'a bad request').toBe(400);
    expect(got.type, 'the token problem type').toBe(PROBLEM_TYPES.InvalidAuthToken);
  });

  it('CRITICAL a registration conflict is refused with 409. Distinct from every other code here, so a mapper that collapsed the switch onto one arm fails this one first.', async () => {
    const got = await loginProblem(flow('email_already_registered'));
    expect(got.status, 'a conflict').toBe(409);
    expect(got.type, 'the already-registered problem type').toBe(
      PROBLEM_TYPES.EmailAlreadyRegistered,
    );
  });

  it('CRITICAL a NON-AuthFlowError is re-thrown rather than mapped onto a customer-facing answer. This is the guard clause at the top of mapAuthFlowError. A database outage inside login() must surface as a 500, not as "email or password is incorrect" — that answer is wrong, unactionable, and hides an incident behind a message the customer will blame themselves for.', async () => {
    const got = await loginProblem(new Error('connection terminated unexpectedly'));
    expect(got.status, 'an internal fault stays internal').toBe(500);
    expect(got.type, 'reported as such').toBe(PROBLEM_TYPES.Internal);
    expect(got.detail, 'and the raw cause is not echoed to the caller').not.toContain(
      'connection terminated',
    );
  });

  it('CRITICAL every AuthFlowErrorCode is handled — none falls through the switch. mapAuthFlowError is typed `: never` and has no default branch, so a code the switch does not cover would return undefined instead of throwing and the route would answer 200 with no body. TypeScript enforces that today; this asserts it at runtime, where a widened union or a cast would not be caught.', async () => {
    const codes: AuthFlowErrorCode[] = [
      'email_already_registered',
      'invalid_credentials',
      'invalid_auth_token',
      'email_not_verified',
      'account_suspended',
    ];
    for (const code of codes) {
      const got = await loginProblem(flow(code));
      expect(got.status, `${code} produced a refusal rather than falling through`).toBeGreaterThan(
        399,
      );
      expect(got.status, `${code} did not become an internal error`).toBeLessThan(500);
    }
  });
});
