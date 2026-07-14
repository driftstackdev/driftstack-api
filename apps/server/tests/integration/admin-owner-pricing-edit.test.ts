// Behavioral coverage for PATCH /v1/admin/owner/pricing/:tier — the owner
// price-edit route (pricing-as-data Phase A 2d-ii-b). Proves the full glue:
// owner-gated mutation -> PricingService.setPrice -> the edit is reflected by
// the GET pricing reader (same PricingService) -> a pricing.updated audit row
// is written (D-025). Mirrors the auth-require-owner-decorator harness: a
// hit-cache resolves a token straight to an AccountContext.
//
// Why this matters: this is the route that makes pricing editable. The
// cross-reader effect (an edit also moves the crypto-checkout charge) is
// proven at the service boundary in pricing-service.test.ts — both readers
// consume PricingService.listEffective(), and this test shows the GET reader
// reflecting an edit through the live route.

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import authPlugin from '../../src/middleware/auth.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { registerAdminOwnerRoutes } from '../../src/routes/admin-owner.js';
import { PlatformSecretsService } from '../../src/services/platform-secrets.js';
import { InMemoryPlatformSecretsRepo } from './_helpers/in-memory-platform-secrets-repo.js';
import { PricingService } from '../../src/services/pricing.js';
import { AdminAuditService } from '../../src/services/admin-audit.js';
import { InMemoryPricingRepo } from './_helpers/in-memory-pricing-repo.js';
import { InMemoryAdminAuditLogRepo } from './_helpers/in-memory-admin-audit-repo.js';
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

interface Harness {
  app: FastifyInstance;
  pricing: PricingService;
  auditRepo: InMemoryAdminAuditLogRepo;
}

async function buildApp(authRepo: AccountAuthRepo = makeRepo()): Promise<Harness> {
  const app = Fastify();
  registerErrorHandler(app);
  await app.register(authPlugin, {
    authRepo,
    authCache: makeCache(),
    authCoalescer: null,
    ownerEmail: OWNER_EMAIL,
  });
  // The real app provides the rateLimit decorator via its own plugin; the
  // admin-owner routes only need it to exist. Stub it as a no-op preHandler.
  app.decorate('rateLimit', () => async () => {});
  const pricing = new PricingService(new InMemoryPricingRepo());
  const auditRepo = new InMemoryAdminAuditLogRepo();
  registerAdminOwnerRoutes(app, {
    platformStatus: {
      billing: false,
      livekit: false,
      crypto: false,
      oauth_client: false,
      sentry: false,
      permissive_cors: false,
    },
    pricing,
    secrets: new PlatformSecretsService(new InMemoryPlatformSecretsRepo(), null),
    audit: new AdminAuditService(auditRepo),
  });
  await app.ready();
  return { app, pricing, auditRepo };
}

describe('PATCH /v1/admin/owner/pricing/:tier — owner price edit', () => {
  it('owner edits api_scale: 200 + new price, the GET reader reflects it, and a pricing.updated audit row is written (D-025)', async () => {
    const { app, auditRepo } = await buildApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/admin/owner/pricing/api_scale',
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
      payload: { monthly_cents: 199900 }, // $1,499 -> $1,999
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tier: 'api_scale', monthly_cents: 199900 });

    // The GET reader (same PricingService) now reflects the edit — proving an
    // edit moves what every listEffective() consumer sees (owner view + the
    // crypto-checkout charge).
    const view = await app.inject({
      method: 'GET',
      url: '/v1/admin/owner/pricing',
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    const viewBody = view.json<{ tiers: Array<{ tier: string; monthly_cents: number }> }>();
    expect(viewBody.tiers.find((t) => t.tier === 'api_scale')?.monthly_cents).toBe(199900);
    expect(viewBody.tiers.find((t) => t.tier === 'solo_manual')?.monthly_cents).toBe(7900); // untouched

    // D-025 audit row written with the editing key + the edit payload.
    const audit = await auditRepo.list({ limit: 10 });
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({
      action: 'pricing.updated',
      adminAccountId: 'acc-owner',
      adminKeyId: 'wsk_ws-owner',
      targetResourceId: 'api_scale',
      result: 'success',
      inputPayload: { tier: 'api_scale', monthly_cents: 199900 },
    });
    await app.close();
  });

  it('rejects a cached owner session after live authority retires it', async () => {
    const { app, pricing, auditRepo } = await buildApp(makeRepo(sha256Hex(OWNER_TOKEN)));
    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/admin/owner/pricing/api_scale',
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
      payload: { monthly_cents: 199900 },
    });
    expect(response.statusCode).toBe(401);
    const rows = await pricing.listEffective();
    expect(rows.find((row) => row.tier === 'api_scale')?.monthlyCents).toBe(149900);
    expect((await auditRepo.list({ limit: 10 })).items).toHaveLength(0);
    await app.close();
  });

  it('403 for a non-owner staff-admin (identity gate, not scope) — and NO edit/audit happens', async () => {
    const { app, pricing, auditRepo } = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/admin/owner/pricing/api_scale',
      headers: { authorization: `Bearer ${STAFF_TOKEN}` },
      payload: { monthly_cents: 199900 },
    });
    expect(res.statusCode).toBe(403);
    // Unchanged: still the seeded constant, no audit row.
    const rows = await pricing.listEffective();
    expect(rows.find((r) => r.tier === 'api_scale')?.monthlyCents).toBe(149900);
    expect((await auditRepo.list({ limit: 10 })).items).toHaveLength(0);
    await app.close();
  });

  it('400 for a non-priced tier (free is not editable)', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/admin/owner/pricing/free',
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
      payload: { monthly_cents: 100 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400 for an out-of-range monthly_cents (zero / over the ceiling)', async () => {
    const { app, auditRepo } = await buildApp();
    for (const bad of [0, 1_000_001]) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/admin/owner/pricing/team_manual',
        headers: { authorization: `Bearer ${OWNER_TOKEN}` },
        payload: { monthly_cents: bad },
      });
      expect(res.statusCode).toBe(400);
    }
    // Validation rejects before the audited mutation — no audit rows.
    expect((await auditRepo.list({ limit: 10 })).items).toHaveLength(0);
    await app.close();
  });
});
