// The MFA step-up gate is made to DENY, not just described as denying.
//
// `requireMfaFresh` protects the operations that need a recent human factor —
// account deletion and disabling MFA itself. Both of its refusal paths had never
// executed under any test:
//
//     src/middleware/auth.ts:266   throw new MfaStepUpRequiredError('never_satisfied')
//     src/middleware/auth.ts:270   throw new MfaStepUpRequiredError('expired')
//
// Found by intersecting per-line coverage with the deny-throw sites across
// `apps/server/src`: 108 such sites, 31 of which no test reaches.
//
// `MfaStepUpRequiredError` is mentioned in SEVENTEEN test files. Every one of
// them reads source text or an SDK export list — content-parity,
// cross-source-invariant, taxonomy. The gate was extensively pinned and never
// run, which is the same shape as item 26's "four fail-closed branches nothing
// could see". A gate nobody has watched refuse is a gate nobody knows refuses.
//
// The bypasses are covered too, and deliberately. A fix that made the gate throw
// unconditionally would satisfy the two refusal arms on its own; the four
// pass-through arms are what stop that, because each is a documented reason this
// gate must NOT fire (machine callers, MFA not deployed, user not enrolled, and
// a satisfied session inside the window).

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import authPlugin, { DEFAULT_MFA_FRESHNESS_SECONDS } from '../../src/middleware/auth.js';
import { MfaStepUpRequiredError } from '../../src/lib/errors.js';

type Gate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** A Fastify instance with the auth plugin registered and nothing else. */
async function appWith(enrolled: boolean | null): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(authPlugin, {
    authRepo: {} as never,
    authCache: null,
    authCoalescer: null,
    // null models a deploy with MFA switched off entirely.
    mfaService:
      enrolled === null
        ? null
        : ({
            getStatus: () =>
              Promise.resolve({
                enrolled,
                enrolledAt: enrolled ? new Date() : null,
                lastUsedAt: null,
                unusedRecoveryCodes: enrolled ? 10 : 0,
              }),
          } as never),
  });
  await app.ready();
  return app;
}

/** A request already carrying an account context, so requireAuth is not involved. */
function requestWith(webSession: { mfaSatisfiedAt: Date | null } | null): FastifyRequest {
  return {
    account: {
      account: { id: 'acc_1' },
      webSession,
    },
  } as unknown as FastifyRequest;
}

const reply = {} as FastifyReply;

async function runGate(app: FastifyInstance, request: FastifyRequest): Promise<void> {
  const gate = (app as unknown as { requireMfaFresh: (o?: unknown) => Gate }).requireMfaFresh();
  await gate(request, reply);
}

describe('the MFA step-up gate actually denies', () => {
  it('CRITICAL the gate exists and is reachable from a registered plugin. Every arm below drives this decorator, and a plugin that failed to decorate would make the refusal arms fail for the wrong reason and the bypass arms pass for no reason.', async () => {
    const app = await appWith(true);
    expect(
      typeof (app as unknown as { requireMfaFresh?: unknown }).requireMfaFresh,
      'requireMfaFresh decorated onto the instance',
    ).toBe('function');
    await app.close();
  });

  it('CRITICAL an enrolled user who has NEVER satisfied MFA on this session is refused. This is the never_satisfied branch — a web session that has not carried a second factor at all, reaching an operation that requires one.', async () => {
    const app = await appWith(true);
    await expect(runGate(app, requestWith({ mfaSatisfiedAt: null }))).rejects.toBeInstanceOf(
      MfaStepUpRequiredError,
    );
    await app.close();
  });

  it('CRITICAL a session whose MFA is older than the freshness window is refused. This is the expired branch — the whole point of a step-up gate, which a session that authenticated hours ago must not pass.', async () => {
    const app = await appWith(true);
    const stale = new Date(Date.now() - (DEFAULT_MFA_FRESHNESS_SECONDS + 60) * 1000);
    await expect(runGate(app, requestWith({ mfaSatisfiedAt: stale }))).rejects.toBeInstanceOf(
      MfaStepUpRequiredError,
    );
    await app.close();
  });

  it('CRITICAL a session satisfied INSIDE the window passes. Without this the two refusals above are satisfied by a gate that throws unconditionally, which would lock every enrolled user out of the operations it protects.', async () => {
    const app = await appWith(true);
    const fresh = new Date(Date.now() - 5_000);
    await expect(runGate(app, requestWith({ mfaSatisfiedAt: fresh }))).resolves.toBeUndefined();
    await app.close();
  });

  it('CRITICAL an API-key caller with no web session passes untouched. MFA is a human-factor gate and machine-to-machine callers have no second factor to present; denying them would break every programmatic client on these routes.', async () => {
    const app = await appWith(true);
    await expect(runGate(app, requestWith(null))).resolves.toBeUndefined();
    await app.close();
  });

  it('CRITICAL a user who is not enrolled passes. Enrollment is opt-in, so the gate must not refuse someone who has no factor to step up with.', async () => {
    const app = await appWith(false);
    await expect(runGate(app, requestWith({ mfaSatisfiedAt: null }))).resolves.toBeUndefined();
    await app.close();
  });

  it('CRITICAL a deploy with no MfaService wired passes. The gate is a no-op where MFA is not deployed at all — asserted because the refusal arms would otherwise be satisfied by a build that always throws when the service is absent.', async () => {
    const app = await appWith(null);
    await expect(runGate(app, requestWith({ mfaSatisfiedAt: null }))).resolves.toBeUndefined();
    await app.close();
  });
});
