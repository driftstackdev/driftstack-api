// Behavioral coverage for `app.requireOwner` (apps/server/src/middleware/
// auth.ts). The project-OWNER gate admits ONLY the configured ownerEmail
// account; everyone else (including staff-admins) gets 403; it fails CLOSED
// when no owner is configured. Mirrors the auth-event-source-decorator
// harness: a hit-cache resolves a token straight to an AccountContext, so
// the decorator's branches are exercised without key-generation machinery.

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import authPlugin from '../../src/middleware/auth.js';
import type { AccountAuthRepo, AccountContext } from '../../src/services/auth.js';
import { type AuthCache, sha256Hex } from '../../src/services/auth-cache.js';

const OWNER_EMAIL = 'owner@driftstack.test';
const OWNER_TOKEN = 'ds_live_oooooooooooooooooooooooooooooooo';
const STAFF_TOKEN = 'ds_live_ssssssssssssssssssssssssssssssss';

function ctxFor(id: string, email: string, sessionId: string): AccountContext {
  return {
    account: {
      id,
      email,
      name: null,
      tier: 'api_builder',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
    apiKey: {
      id: `wsk_${sessionId}`,
      accountId: id,
      name: 'web-session',
      keyPrefix: 'web_session',
      keyHash: '',
      // Both the owner and the comparison account are staff-admins; the gate
      // must still admit ONLY the owner — proving it's an identity check, not
      // a scope check.
      scopes: ['read', 'write', 'account_owner', 'driftstack_internal_admin'],
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
    rateLimitOverrides: {},
    teams: [],
    webSession: { id: sessionId, mfaSatisfiedAt: null },
  };
}

const OWNER_CTX = ctxFor('acc-owner', OWNER_EMAIL, 'ws-owner');
const STAFF_CTX = ctxFor('acc-staff', 'staff@driftstack.test', 'ws-staff');

function makeRepo(retiredTokenHash: string | null = null): AccountAuthRepo {
  const sessions = new Map([
    [sha256Hex(OWNER_TOKEN), { ctx: OWNER_CTX, id: 'ws-owner' }],
    [sha256Hex(STAFF_TOKEN), { ctx: STAFF_CTX, id: 'ws-staff' }],
  ]);
  return {
    findApiKeyByPrefix: () => Promise.resolve(null),
    findActiveWebSession: ({ tokenHash }: { tokenHash: string }) => {
      if (tokenHash === retiredTokenHash) return Promise.resolve(null);
      const entry = sessions.get(tokenHash);
      return Promise.resolve(
        entry
          ? {
              id: entry.id,
              accountId: entry.ctx.account.id,
              expiresAt: new Date('2027-01-01T00:00:00Z'),
              revokedAt: null,
              lastUsedAt: null,
              mfaSatisfiedAt: null,
              createdAt: new Date('2026-01-01T00:00:00Z'),
            }
          : null,
      );
    },
    getAccount: (id: string) =>
      Promise.resolve(
        id === OWNER_CTX.account.id
          ? OWNER_CTX.account
          : id === STAFF_CTX.account.id
            ? STAFF_CTX.account
            : null,
      ),
    findTeamMemberships: () => Promise.resolve([]),
    findActiveRateLimitOverrides: () => Promise.resolve([]),
  } as unknown as AccountAuthRepo;
}

function makeCache(): AuthCache {
  const ownerSha = sha256Hex(OWNER_TOKEN);
  const staffSha = sha256Hex(STAFF_TOKEN);
  return {
    get: (sha: string) =>
      Promise.resolve(sha === ownerSha ? OWNER_CTX : sha === staffSha ? STAFF_CTX : null),
    set: () => Promise.resolve(),
    invalidateKey: () => Promise.resolve(),
    invalidateAccount: () => Promise.resolve(),
  };
}

async function buildApp(
  ownerEmail: string | null,
  authRepo: AccountAuthRepo = makeRepo(),
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(authPlugin, {
    authRepo,
    authCache: makeCache(),
    authCoalescer: null,
    ...(ownerEmail !== null ? { ownerEmail } : {}),
  });
  app.get('/owner-only', { preHandler: [app.requireOwner] }, (req) => ({
    ok: true,
    email: req.account?.account.email ?? null,
  }));
  await app.ready();
  return app;
}

describe('requireOwner — project-owner gate', () => {
  it('200 for the configured owner account', async () => {
    const app = await buildApp(OWNER_EMAIL);
    const res = await app.inject({
      method: 'GET',
      url: '/owner-only',
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, email: OWNER_EMAIL });
    await app.close();
  });

  it('403 for a non-owner staff-admin account (identity check, not scope check)', async () => {
    const app = await buildApp(OWNER_EMAIL);
    const res = await app.inject({
      method: 'GET',
      url: '/owner-only',
      headers: { authorization: `Bearer ${STAFF_TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('401 when unauthenticated (lazy-auth runs requireAuth first)', async () => {
    const app = await buildApp(OWNER_EMAIL);
    const res = await app.inject({ method: 'GET', url: '/owner-only' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('fails CLOSED — 403 even for the owner token when no ownerEmail is configured', async () => {
    const app = await buildApp(null);
    const res = await app.inject({
      method: 'GET',
      url: '/owner-only',
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('owner match is case-insensitive (config + account email normalized)', async () => {
    const app = await buildApp(OWNER_EMAIL.toUpperCase());
    const res = await app.inject({
      method: 'GET',
      url: '/owner-only',
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('rejects a cached owner after live session authority retires it', async () => {
    const app = await buildApp(OWNER_EMAIL, makeRepo(sha256Hex(OWNER_TOKEN)));
    const res = await app.inject({
      method: 'GET',
      url: '/owner-only',
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
