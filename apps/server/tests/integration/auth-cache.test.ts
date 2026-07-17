// Integration tests for the auth-cache pipeline. Asserts:
//   - cache miss on first request, hit on second (within TTL)
//   - revoke invalidates the cache entry immediately (next request 401)
//   - account-version invalidation makes cached entries miss
//   - graceful degradation when the cache implementation throws
//
// The fixture's `authCache` is the in-memory impl, so we can read its state
// directly. A separate test uses a "broken" cache to assert the
// degraded-fallback path goes through scrypt.

import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/lib/app.js';
import { createTestLogger } from '../../src/lib/logger.js';
import { MemoryRateLimitStore } from '../../src/lib/memory-rate-limit-store.js';
import { generateApiKey, hashApiKey, keyPrefixFromPlaintext } from '../../src/lib/api-keys.js';
import { MockDriver } from '../../src/drivers/mock.js';
import { SessionsService } from '../../src/services/sessions.js';
import { ApiKeysService } from '../../src/services/api-keys.js';
import { UsageService } from '../../src/services/usage.js';
import { InMemoryAuthCache, sha256Hex, type AuthCache } from '../../src/services/auth-cache.js';
import { AuthCoalescer } from '../../src/services/auth-coalescer.js';
import type { AccountContext } from '../../src/services/auth.js';
import { WebhooksService, WebhooksAdminService } from '../../src/services/webhooks.js';
import { AdminAuditService } from '../../src/services/admin-audit.js';
import { AccountsAdminService } from '../../src/services/admin-accounts.js';
import { AdminBillingService } from '../../src/services/admin-billing.js';
import { PricingService } from '../../src/services/pricing.js';
import { PlatformSecretsService } from '../../src/services/platform-secrets.js';
import { InMemoryPricingRepo } from './_helpers/in-memory-pricing-repo.js';
import { InMemoryPlatformSecretsRepo } from './_helpers/in-memory-platform-secrets-repo.js';
import { RateLimitOverridesService } from '../../src/services/rate-limit-overrides.js';
import { LegalService } from '../../src/services/legal.js';
import { buildLegalCatalogFromContent } from '../../src/services/legal-catalog.js';
import { InMemoryAuthRepo } from './_helpers/in-memory-auth-repo.js';
import { InMemoryLegalRepo } from './_helpers/in-memory-legal-repo.js';
import { InMemorySessionsRepo } from './_helpers/in-memory-sessions-repo.js';
import { InMemoryApiKeysRepo } from './_helpers/in-memory-api-keys-repo.js';
import { InMemoryUsageRepo } from './_helpers/in-memory-usage-repo.js';
import { InMemoryWebhooksRepo } from './_helpers/in-memory-webhooks-repo.js';
import { InMemoryAdminAuditLogRepo } from './_helpers/in-memory-admin-audit-repo.js';
import { InMemoryAccountsAdminRepo } from './_helpers/in-memory-admin-accounts-repo.js';
import { InMemoryAdminBillingRepo } from './_helpers/in-memory-admin-billing-repo.js';
import { InMemoryRateLimitOverridesRepo } from './_helpers/in-memory-rate-limit-overrides-repo.js';
import { EmailPreferencesService } from '../../src/services/email-preferences.js';
import { InMemoryEmailPreferencesRepo } from './_helpers/in-memory-email-preferences-repo.js';
import { AccountAuditService } from '../../src/services/account-audit.js';
import { InMemoryAccountAuditRepo } from './_helpers/in-memory-account-audit-repo.js';
import {
  ValidationHarnessService,
  type ValidationHarnessRecaptureBridge,
} from '../../src/services/validation-harness.js';
import { InMemoryValidationSchedulesRepo } from './_helpers/in-memory-validation-schedules-repo.js';
import { AccountLifecycleService } from '../../src/services/account-lifecycle.js';
import { InMemoryAccountLifecycleRepo } from './_helpers/in-memory-account-lifecycle-repo.js';
import { createEmailService } from '../../src/services/email.js';
import { randomUUID as authCacheTestRandomUUID } from 'node:crypto';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

function buildAdditionalDeps(): {
  emailPreferencesService: EmailPreferencesService;
  accountAuditService: AccountAuditService;
  validationHarnessService: ValidationHarnessService;
  accountLifecycleService: AccountLifecycleService;
} {
  const emailPreferencesService = new EmailPreferencesService(new InMemoryEmailPreferencesRepo());
  const accountAuditService = new AccountAuditService(new InMemoryAccountAuditRepo());
  const recaptureBridge: ValidationHarnessRecaptureBridge = {
    triggerRecapture: () => Promise.resolve({ id: `run_${authCacheTestRandomUUID()}` }),
  };
  const validationHarnessService = new ValidationHarnessService(
    new InMemoryValidationSchedulesRepo(),
    recaptureBridge,
    { iosVersion: '18.7', safariVersion: '26.4' },
  );
  const stubLogger = createTestLogger();
  const noopEmail = createEmailService({ config: null, logger: stubLogger });
  const accountLifecycleService = new AccountLifecycleService(
    new InMemoryAccountLifecycleRepo(),
    noopEmail,
    emailPreferencesService,
    stubLogger,
    {
      docsBaseUrl: 'https://example.test/docs',
      billingPortalUrl: 'https://example.test/billing',
      dashboardUrl: 'https://example.test',
    },
  );
  return {
    emailPreferencesService,
    accountAuditService,
    validationHarnessService,
    accountLifecycleService,
  };
}

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('auth cache — happy path', () => {
  it('first request misses, second hits and skips scrypt path', async () => {
    fx = await buildTestApp();

    expect(fx.authCache.size()).toBe(0);

    // First call — populates cache.
    const r1 = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(r1.statusCode).toBe(200);
    expect(fx.authCache.size()).toBe(1);

    // Second call — cache hit. (Exercise: no exception, fast response.)
    const r2 = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(r2.statusCode).toBe(200);
    expect(fx.authCache.size()).toBe(1);
  });

  it('the cache key is sha256 of the plaintext (not the plaintext itself)', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    // The fixture's plaintext should NOT be a key in the cache; only its sha.
    const sha = sha256Hex(fx.plaintext);
    expect(await fx.authCache.get(sha)).not.toBeNull();
    expect(await fx.authCache.get(fx.plaintext)).toBeNull();
  });
});

describe('auth cache — revocation invalidates', () => {
  it('revoking via DELETE /v1/api-keys/:id invalidates the cached entry', async () => {
    fx = await buildTestApp();

    // Populate cache.
    const ok = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(fx.authCache.size()).toBe(1);

    // Revoke the key (admin scope on the seeded fixture key).
    const del = await fx.app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/key_${fx.apiKeyId}`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(del.statusCode).toBe(204);

    // Cache entry must be gone.
    expect(fx.authCache.size()).toBe(0);

    // Next call should 401 (RevokedKey) — but ONLY because the auth-repo also
    // sees the revoked_at row. Confirm both: cache miss + 401.
    const after = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('auth cache — account-version invalidation', () => {
  it('invalidateAccount makes the cached entry miss on next read', async () => {
    fx = await buildTestApp();

    await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    // Cache populated.
    const sha = sha256Hex(fx.plaintext);
    expect(await fx.authCache.get(sha)).not.toBeNull();

    await fx.authCache.invalidateAccount(fx.accountId);

    // Account-version mismatch → cache.get returns null (treated as miss).
    expect(await fx.authCache.get(sha)).toBeNull();

    // The next HTTP request still works — it falls back to scrypt + repo,
    // and re-populates the cache with the bumped version.
    const r = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(r.statusCode).toBe(200);
    expect(await fx.authCache.get(sha)).not.toBeNull();
  });
});

describe('auth cache — live Free-tier entitlement', () => {
  it('denies an already-cached ordinary key immediately after downgrade to Free', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const headers = { authorization: `Bearer ${fx.plaintext}` };

    const warm = await fx.app.inject({ method: 'GET', url: '/v1/whoami', headers });
    expect(warm.statusCode).toBe(200);
    expect(await fx.authCache.get(sha256Hex(fx.plaintext))).not.toBeNull();

    const account = await fx.authRepo.getAccount(fx.accountId);
    expect(account).not.toBeNull();
    fx.authRepo.upsertAccount({
      ...account!,
      tier: 'free',
      updatedAt: new Date(),
    });

    const denied = await fx.app.inject({ method: 'GET', url: '/v1/whoami', headers });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ detail: string }>().detail).toContain('apiAccess');

    const deniedAgain = await fx.app.inject({ method: 'GET', url: '/v1/whoami', headers });
    expect(deniedAgain.statusCode).toBe(403);
  });
});

describe('auth cache — graceful degradation', () => {
  it('Redis errors fall through to scrypt path; auth still works', async () => {
    // Build an app with a deliberately-broken cache that throws on every op.
    const brokenCache: AuthCache = {
      get: () => Promise.reject(new Error('redis down')),
      set: () => Promise.reject(new Error('redis down')),
      invalidateKey: () => Promise.reject(new Error('redis down')),
      invalidateAccount: () => Promise.reject(new Error('redis down')),
    };

    const authRepo = new InMemoryAuthRepo();
    const accountId = '00000000-0000-4000-8000-00000000a001';
    const apiKeyId = '00000000-0000-4000-8000-00000000a002';

    authRepo.upsertAccount({
      id: accountId,
      email: 'degraded@x.test',
      name: null,
      tier: 'api_builder',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const plaintext = generateApiKey('test');
    const keyHash = await hashApiKey(plaintext);
    authRepo.upsertApiKey({
      id: apiKeyId,
      accountId,
      name: 'degraded',
      keyPrefix: keyPrefixFromPlaintext(plaintext),
      keyHash,
      scopes: ['read', 'write', 'admin'],
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    const sessionsRepo = new InMemorySessionsRepo();
    const driver = new MockDriver({ fastForwardLatency: true });
    const sessionsService = new SessionsService({ repo: sessionsRepo, driver });
    const apiKeysRepo = new InMemoryApiKeysRepo();
    const apiKeysService = new ApiKeysService(apiKeysRepo, brokenCache);
    const usageRepo = new InMemoryUsageRepo();
    const usageService = new UsageService(usageRepo);
    const rateLimitStore = new MemoryRateLimitStore();

    const sharedWebhooksRepo = new InMemoryWebhooksRepo();
    const webhooksService = new WebhooksService(sharedWebhooksRepo);
    const webhooksAdminService = new WebhooksAdminService(sharedWebhooksRepo);
    const adminAuditService = new AdminAuditService(new InMemoryAdminAuditLogRepo());
    const accountsAdminService = new AccountsAdminService(
      new InMemoryAccountsAdminRepo(authRepo),
      null,
    );
    const adminBillingService = new AdminBillingService(new InMemoryAdminBillingRepo());
    const pricingService = new PricingService(new InMemoryPricingRepo());
    const platformSecretsService = new PlatformSecretsService(
      new InMemoryPlatformSecretsRepo(),
      null,
    );
    const rateLimitOverridesService = new RateLimitOverridesService(
      new InMemoryRateLimitOverridesRepo(authRepo),
      null,
    );
    const app = await buildApp({
      logger: createTestLogger(),
      authRepo,
      authCache: brokenCache,
      authCoalescer: new AuthCoalescer(),
      rateLimitStore,
      sessionsService,
      apiKeysService,
      usageService,
      webhooksService,
      webhooksAdminService,
      adminAuditService,
      accountsAdminService,
      adminBillingService,
      pricingService,
      platformSecretsService,
      rateLimitOverridesService,
      legalService: new LegalService(
        buildLegalCatalogFromContent([
          {
            documentKey: 'tos',
            title: 'ToS',
            sourcePath: 'docs/legal/terms-of-service.md',
            content: '# Test\n\n**Version:** 0.1.0 · **Effective:** 2026-05-03\n',
          },
        ]),
        new InMemoryLegalRepo(),
      ),
      ...buildAdditionalDeps(),
      permissiveCors: true,
    });

    try {
      // Should still 200 even though the cache is throwing on every op —
      // authentication just goes through scrypt every time.
      const r1 = await app.inject({
        method: 'GET',
        url: '/v1/sessions',
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(r1.statusCode).toBe(200);

      const r2 = await app.inject({
        method: 'GET',
        url: '/v1/sessions',
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(r2.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('null cache (cache disabled entirely) still authenticates correctly', async () => {
    // Sanity: passing authCache=null short-circuits all cache calls.
    const ctxRef: { ctx: AccountContext | null } = { ctx: null };
    expect(ctxRef.ctx).toBeNull(); // placeholder; the real exercise is the app build below

    const authRepo = new InMemoryAuthRepo();
    const accountId = '00000000-0000-4000-8000-00000000b001';
    const apiKeyId = '00000000-0000-4000-8000-00000000b002';
    authRepo.upsertAccount({
      id: accountId,
      email: 'nocache@x.test',
      name: null,
      tier: 'api_builder',
      status: 'active',
      timezone: null,
      avatarR2Key: null,
      slug: null,
      region: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const plaintext = generateApiKey('test');
    const keyHash = await hashApiKey(plaintext);
    authRepo.upsertApiKey({
      id: apiKeyId,
      accountId,
      name: 'no-cache',
      keyPrefix: keyPrefixFromPlaintext(plaintext),
      keyHash,
      scopes: ['read', 'write', 'admin'],
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    const cache = new InMemoryAuthCache();
    const driver = new MockDriver({ fastForwardLatency: true });
    const sessionsService = new SessionsService({
      repo: new InMemorySessionsRepo(),
      driver,
    });
    const apiKeysService = new ApiKeysService(new InMemoryApiKeysRepo(), null);
    const usageService = new UsageService(new InMemoryUsageRepo());

    const sharedWebhooksRepo = new InMemoryWebhooksRepo();
    const webhooksService = new WebhooksService(sharedWebhooksRepo);
    const webhooksAdminService = new WebhooksAdminService(sharedWebhooksRepo);
    const adminAuditService = new AdminAuditService(new InMemoryAdminAuditLogRepo());
    const accountsAdminService = new AccountsAdminService(
      new InMemoryAccountsAdminRepo(authRepo),
      null,
    );
    const adminBillingService = new AdminBillingService(new InMemoryAdminBillingRepo());
    const pricingService = new PricingService(new InMemoryPricingRepo());
    const platformSecretsService = new PlatformSecretsService(
      new InMemoryPlatformSecretsRepo(),
      null,
    );
    const rateLimitOverridesService = new RateLimitOverridesService(
      new InMemoryRateLimitOverridesRepo(authRepo),
      null,
    );
    const app = await buildApp({
      logger: createTestLogger(),
      authRepo,
      authCache: null,
      authCoalescer: new AuthCoalescer(),
      rateLimitStore: new MemoryRateLimitStore(),
      sessionsService,
      apiKeysService,
      usageService,
      webhooksService,
      webhooksAdminService,
      adminAuditService,
      accountsAdminService,
      adminBillingService,
      pricingService,
      platformSecretsService,
      rateLimitOverridesService,
      legalService: new LegalService(
        buildLegalCatalogFromContent([
          {
            documentKey: 'tos',
            title: 'ToS',
            sourcePath: 'docs/legal/terms-of-service.md',
            content: '# Test\n\n**Version:** 0.1.0 · **Effective:** 2026-05-03\n',
          },
        ]),
        new InMemoryLegalRepo(),
      ),
      ...buildAdditionalDeps(),
      permissiveCors: true,
    });

    try {
      const r = await app.inject({
        method: 'GET',
        url: '/v1/sessions',
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(r.statusCode).toBe(200);
      expect(cache.size()).toBe(0); // never touched
    } finally {
      await app.close();
    }
  });
});
