// V-1913. The effective-owner limiter refuses two route-wiring mistakes, and
// until now nothing witnessed either: a deliberate, type-correct fail-open at
// each site left all 3228 vitest files and all 233 Playwright tests green.
//
// Both guards stand behind ~40 call sites of consumeEffectiveOwnerRateLimit,
// and the effective owner is chosen by a request header, so the refusal is the
// last thing between a mis-wired route and an unmetered cross-account request.
//
// Reaching them through a real route is not possible: the route's own
// authorization answers 403 first, and both it and the limiter read the same
// request.account.teams, so they cannot be made to disagree from the outside.
// The middleware is therefore driven directly, using the bare-Fastify harness
// rate-limit-double-failure.test.ts established (a one-line stub satisfies the
// plugin's `auth` dependency).
//
// Each test asserts the SITE-SPECIFIC log line, not merely a 429: a refusal
// alone would also be produced by the other guards, so without that assertion
// either test could pass while witnessing the wrong branch.

import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RateLimitStore } from '../../src/services/rate-limit.js';
import type { AccountAuthRepo } from '../../src/services/auth.js';
import rateLimitPlugin, {
  consumeEffectiveOwnerRateLimit,
} from '../../src/middleware/rate-limit.js';

const ACTOR_ID = '00000000-0000-4000-8000-0000000e0001';
const OWNER_ID = '00000000-0000-4000-8000-0000000e0002';
const STRANGER_ID = '00000000-0000-4000-8000-0000000e0003';

const allowingStore: RateLimitStore = {
  consume: () => Promise.resolve({ allowed: true, remaining: 9, retryAfterMs: 0 }),
};

const authRepo = {
  getAccount: (id: string) =>
    Promise.resolve({
      id,
      email: 'owner@wiring.test',
      name: null,
      tier: 'api_scale',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date('2026-08-27T00:00:00.000Z'),
      updatedAt: new Date('2026-08-27T00:00:00.000Z'),
    }),
  findActiveRateLimitOverrides: () => Promise.resolve([]),
} as unknown as AccountAuthRepo;

function fakeReply(): FastifyReply {
  return { header: vi.fn(), removeHeader: vi.fn() } as unknown as FastifyReply;
}

function fakeRequest(memberOf: readonly string[]): {
  request: FastifyRequest;
  warn: ReturnType<typeof vi.fn>;
} {
  const warn = vi.fn();
  return {
    request: {
      ip: '203.0.113.77',
      account: {
        account: { id: ACTOR_ID, tier: 'free', status: 'active' },
        apiKey: { id: 'key_wiring', scopes: ['account_owner'] },
        rateLimitOverrides: {},
        teams: memberOf.map((ownerAccountId, i) => ({
          membershipId: `mem_${String(i)}`,
          ownerAccountId,
          role: 'member' as const,
        })),
      },
      log: { warn, debug: vi.fn(), info: vi.fn() },
    } as unknown as FastifyRequest,
    warn,
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(fp((_a, _o, done) => done(), { name: 'auth' }));
  await app.register(rateLimitPlugin, { store: allowingStore, authRepo });
  await app.ready();
  return app;
}

/** The actor limiter must run first; it is what records the receipt the
 *  effective-owner limiter later requires for the same bucket and cost. */
async function chargeActorFirst(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await app.rateLimit('global', 1)(request, reply);
}

describe('the effective-owner limiter refuses a mis-wired route', () => {
  it('refuses when the actor limiter never ran for the same bucket and cost', async () => {
    const app = await buildApp();
    try {
      const { request, warn } = fakeRequest([OWNER_ID]);
      const reply = fakeReply();

      await expect(
        consumeEffectiveOwnerRateLimit(app, request, reply, OWNER_ID, 'global', 1),
      ).rejects.toMatchObject({ status: 429 });

      expect(warn.mock.calls.at(-1)?.[1]).toMatch(/no allowed actor receipt — failing CLOSED/);
    } finally {
      await app.close();
    }
  });

  it('refuses an owner the caller holds no membership in, even after the actor was charged', async () => {
    const app = await buildApp();
    try {
      // Member of OWNER_ID only — the route then asks to spend STRANGER_ID's budget.
      const { request, warn } = fakeRequest([OWNER_ID]);
      const reply = fakeReply();
      await chargeActorFirst(app, request, reply);

      await expect(
        consumeEffectiveOwnerRateLimit(app, request, reply, STRANGER_ID, 'global', 1),
      ).rejects.toMatchObject({ status: 429 });

      expect(warn.mock.calls.at(-1)?.[1]).toMatch(
        /received an unauthorized owner — failing CLOSED/,
      );
    } finally {
      await app.close();
    }
  });

  // Positive arm. Without it both refusals above would still pass if the
  // limiter refused unconditionally, which is the failure mode a pair of
  // refusal-only tests cannot detect.
  it('admits the request and returns the owner tier once the wiring is correct', async () => {
    const app = await buildApp();
    try {
      const { request, warn } = fakeRequest([OWNER_ID]);
      const reply = fakeReply();
      await chargeActorFirst(app, request, reply);

      await expect(
        consumeEffectiveOwnerRateLimit(app, request, reply, OWNER_ID, 'global', 1),
      ).resolves.toBe('api_scale');

      const failedClosed = warn.mock.calls.filter(([, msg]) =>
        typeof msg === 'string' ? /failing CLOSED/.test(msg) : false,
      );
      expect(failedClosed).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
