// Behavioral coverage for the owner secrets-management routes (secrets Phase A
// slice 2): GET /v1/admin/owner/secrets (metadata only) + PUT /:name (create/
// update) + POST /:name/reveal (the audited decrypt) + DELETE /:name. Proves
// the full glue: owner-gated -> PlatformSecretsService (encrypt-at-rest) ->
// D-025 audit rows for every lifecycle action — and that the plaintext value
// NEVER appears in the list response or any audit payload (the taint rule).
// Mirrors the admin-owner-pricing-edit harness (hit-cache token -> ctx).

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
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
const SECRET_VALUE = 'sk-live-SUPERSECRET-AAA';

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

async function buildApp(
  /** Pass `null` to build a DISABLED-secrets deployment (MFA_ENCRYPTION_KEY unset). */
  encryptionKeyBase64: string | null = randomBytes(32).toString('base64'),
  authRepo: AccountAuthRepo = makeRepo(),
): Promise<{ app: FastifyInstance; auditRepo: InMemoryAdminAuditLogRepo }> {
  const app = Fastify();
  registerErrorHandler(app);
  await app.register(authPlugin, {
    authRepo,
    authCache: makeCache(),
    authCoalescer: null,
    ownerEmail: OWNER_EMAIL,
  });
  app.decorate('rateLimit', () => async () => {});
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
    pricing: new PricingService(new InMemoryPricingRepo()),
    secrets: new PlatformSecretsService(new InMemoryPlatformSecretsRepo(), encryptionKeyBase64),
    audit: new AdminAuditService(auditRepo),
  });
  await app.ready();
  return { app, auditRepo };
}

describe('owner secrets-management routes (secrets Phase A slice 2)', () => {
  it('full lifecycle: create(201) -> list(meta only) -> reveal(audited) -> update(200) -> delete(204) -> reveal 404; every action audited; plaintext NEVER in list or audit', async () => {
    const { app, auditRepo } = await buildApp();
    const h = { authorization: `Bearer ${OWNER_TOKEN}` };

    const create = await app.inject({
      method: 'PUT',
      url: '/v1/admin/owner/secrets/stripe_secret_key',
      headers: h,
      payload: { value: SECRET_VALUE, description: 'Stripe live key' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toEqual({ name: 'stripe_secret_key', status: 'created' });

    const list = await app.inject({ method: 'GET', url: '/v1/admin/owner/secrets', headers: h });
    expect(list.statusCode).toBe(200);
    const listBody = list.json<{ enabled: boolean; secrets: Array<{ name: string }> }>();
    expect(listBody.enabled).toBe(true);
    expect(listBody.secrets).toHaveLength(1);
    expect(list.body).not.toContain(SECRET_VALUE);

    const reveal = await app.inject({
      method: 'POST',
      url: '/v1/admin/owner/secrets/stripe_secret_key/reveal',
      headers: h,
    });
    expect(reveal.statusCode).toBe(200);
    expect(reveal.json()).toEqual({ name: 'stripe_secret_key', value: SECRET_VALUE });

    const update = await app.inject({
      method: 'PUT',
      url: '/v1/admin/owner/secrets/stripe_secret_key',
      headers: h,
      payload: { value: 'sk-live-ROTATED' },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toEqual({ name: 'stripe_secret_key', status: 'updated' });

    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/admin/owner/secrets/stripe_secret_key',
      headers: h,
    });
    expect(del.statusCode).toBe(204);

    const gone = await app.inject({
      method: 'POST',
      url: '/v1/admin/owner/secrets/stripe_secret_key/reveal',
      headers: h,
    });
    expect(gone.statusCode).toBe(404);

    // D-025: the four lifecycle actions are all audited, in order.
    const actions = auditRepo.getAll().map((r) => r.action);
    expect(actions).toEqual([
      'secret.created',
      'secret.revealed',
      'secret.updated',
      'secret.deleted',
    ]);
    // The taint rule: no audit payload ever contains a secret value.
    expect(JSON.stringify(auditRepo.getAll())).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(auditRepo.getAll())).not.toContain('sk-live-ROTATED');
  });

  it('staff-admin (non-owner) gets 403 on every secrets route; bad slug 400s; no audit rows from rejected calls', async () => {
    const { app, auditRepo } = await buildApp();
    const staff = { authorization: `Bearer ${STAFF_TOKEN}` };
    for (const [method, url] of [
      ['GET', '/v1/admin/owner/secrets'],
      ['PUT', '/v1/admin/owner/secrets/some_key'],
      ['POST', '/v1/admin/owner/secrets/some_key/reveal'],
      ['DELETE', '/v1/admin/owner/secrets/some_key'],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: staff,
        ...(method === 'PUT' ? { payload: { value: 'v' } } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    const owner = { authorization: `Bearer ${OWNER_TOKEN}` };
    const bad = await app.inject({
      method: 'PUT',
      url: '/v1/admin/owner/secrets/Not-A-Slug',
      headers: owner,
      payload: { value: 'v' },
    });
    expect(bad.statusCode).toBe(400);
    expect(auditRepo.getAll()).toHaveLength(0);
  });

  it('rejects a cached owner session after live authority retires it', async () => {
    const { app, auditRepo } = await buildApp(undefined, makeRepo(sha256Hex(OWNER_TOKEN)));
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/admin/owner/secrets/stripe_secret_key',
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
      payload: { value: SECRET_VALUE },
    });
    expect(response.statusCode).toBe(401);
    expect(auditRepo.getAll()).toHaveLength(0);
    await app.close();
  });

  it('accepts exactly 8192 UTF-8 bytes and rejects a shorter-code-unit oversized value', async () => {
    const { app } = await buildApp();
    const headers = { authorization: `Bearer ${OWNER_TOKEN}` };
    const exact = await app.inject({
      method: 'PUT',
      url: '/v1/admin/owner/secrets/multibyte_key',
      headers,
      payload: { value: 'é'.repeat(4096) },
    });
    expect(exact.statusCode).toBe(201);

    const oversized = await app.inject({
      method: 'PUT',
      url: '/v1/admin/owner/secrets/multibyte_key',
      headers,
      payload: { value: 'é'.repeat(4097) },
    });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.body).not.toContain('é'.repeat(100));
    await app.close();
  });
});

describe('disabled deployment (MFA_ENCRYPTION_KEY unset) — V-352b mapping', () => {
  it('list reports enabled:false; set + reveal return a clean 503 (not a 500), nothing audited', async () => {
    const { app, auditRepo } = await buildApp(null);
    const owner = { authorization: `Bearer ${OWNER_TOKEN}` };

    const list = await app.inject({
      method: 'GET',
      url: '/v1/admin/owner/secrets',
      headers: owner,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ enabled: boolean }>().enabled).toBe(false);

    const put = await app.inject({
      method: 'PUT',
      url: '/v1/admin/owner/secrets/stripe_secret_key',
      headers: owner,
      payload: { value: SECRET_VALUE },
    });
    expect(put.statusCode).toBe(503);

    const reveal = await app.inject({
      method: 'POST',
      url: '/v1/admin/owner/secrets/stripe_secret_key/reveal',
      headers: owner,
    });
    expect(reveal.statusCode).toBe(503);
    expect(reveal.body).not.toContain(SECRET_VALUE);

    // DELETE needs no key — keyless removal still works (404 when absent).
    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/admin/owner/secrets/stripe_secret_key',
      headers: owner,
    });
    expect(del.statusCode).toBe(404);

    // The disabled guard fires before any audited action.
    expect(auditRepo.getAll()).toHaveLength(0);
  });

  it('DELETE writes an error-audit row when the store remove() fails (D-025 audit-on-failure, like PUT/reveal)', async () => {
    const app = Fastify();
    registerErrorHandler(app);
    await app.register(authPlugin, {
      authRepo: makeRepo(),
      authCache: makeCache(),
      authCoalescer: null,
      ownerEmail: OWNER_EMAIL,
    });
    app.decorate('rateLimit', () => async () => {});
    const auditRepo = new InMemoryAdminAuditLogRepo();
    const secrets = new PlatformSecretsService(
      new InMemoryPlatformSecretsRepo(),
      randomBytes(32).toString('base64'),
    );
    // Simulate a store/decrypt failure on remove (NOT a benign not-found).
    (secrets as unknown as { remove: () => Promise<boolean> }).remove = () =>
      Promise.reject(Object.assign(new Error('boom'), { name: 'StoreError' }));
    registerAdminOwnerRoutes(app, {
      platformStatus: {
        billing: false,
        livekit: false,
        crypto: false,
        oauth_client: false,
        sentry: false,
        permissive_cors: false,
      },
      pricing: new PricingService(new InMemoryPricingRepo()),
      secrets,
      audit: new AdminAuditService(auditRepo),
    });
    await app.ready();

    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/admin/owner/secrets/stripe_secret_key',
      headers: { authorization: `Bearer ${OWNER_TOKEN}` },
    });
    expect(del.statusCode).toBeGreaterThanOrEqual(500);

    const deleted = auditRepo.getAll().filter((r) => r.action === 'secret.deleted');
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.result).toMatch(/^error:/);
    await app.close();
  });
});
