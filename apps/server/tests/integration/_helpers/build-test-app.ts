// Builds a Fastify app instance configured for integration tests:
//   - silent logger (no log spam in test output)
//   - in-memory auth repo seeded with one Pro-tier account + one API key
//   - in-memory rate limiter
//   - permissive CORS
//
// Returns the app, plain-text key, and helpers for direct repo manipulation.

import { buildApp } from '../../../src/lib/app.js';
import { createTestLogger } from '../../../src/lib/logger.js';
import { MemoryRateLimitStore } from '../../../src/lib/memory-rate-limit-store.js';
import { generateApiKey, hashApiKey, keyPrefixFromPlaintext } from '../../../src/lib/api-keys.js';
import { MockDriver } from '../../../src/drivers/mock.js';
import { SessionsService } from '../../../src/services/sessions.js';
import { ApiKeysService } from '../../../src/services/api-keys.js';
import { UsageService } from '../../../src/services/usage.js';
import { WebhooksService, WebhooksAdminService } from '../../../src/services/webhooks.js';
import { AdminAuditService } from '../../../src/services/admin-audit.js';
import { AccountsAdminService } from '../../../src/services/admin-accounts.js';
import { RateLimitOverridesService } from '../../../src/services/rate-limit-overrides.js';
import { LegalService } from '../../../src/services/legal.js';
import { buildLegalCatalogFromContent } from '../../../src/services/legal-catalog.js';
import { InMemoryAuthCache } from '../../../src/services/auth-cache.js';
import { AuthCoalescer } from '../../../src/services/auth-coalescer.js';
import { InMemoryAuthRepo } from './in-memory-auth-repo.js';
import { InMemorySessionsRepo } from './in-memory-sessions-repo.js';
import { InMemoryApiKeysRepo } from './in-memory-api-keys-repo.js';
import { InMemoryUsageRepo } from './in-memory-usage-repo.js';
import { InMemoryWebhooksRepo } from './in-memory-webhooks-repo.js';
import { InMemoryAdminAuditLogRepo } from './in-memory-admin-audit-repo.js';
import { InMemoryAccountsAdminRepo } from './in-memory-admin-accounts-repo.js';
import { InMemoryRateLimitOverridesRepo } from './in-memory-rate-limit-overrides-repo.js';
import { InMemoryLegalRepo } from './in-memory-legal-repo.js';
import type { AccountTier, ApiKeyScope } from '@driftstack/api-types';

export interface TestAppOptions {
  tier?: AccountTier;
  scopes?: ApiKeyScope[];
  accountStatus?: 'active' | 'suspended' | 'deleted';
  keyRevoked?: boolean;
  keyExpired?: boolean;
  /**
   * Optional override for the seeded account id. Default is the
   * historical hardcoded value. Tests that need two distinct accounts
   * pass this to keep the second fixture from clobbering the first.
   */
  accountId?: string;
  /** Optional override for the seeded api-key id. */
  apiKeyId?: string;
  /** Optional override for the seeded email (must be unique per fixture). */
  email?: string;
}

export interface SeedAdditionalOpts {
  accountId?: string;
  apiKeyId?: string;
  tier?: AccountTier;
  scopes?: ApiKeyScope[];
  accountStatus?: 'active' | 'suspended' | 'deleted';
  email?: string;
  name?: string;
}

export interface AdditionalAccount {
  accountId: string;
  apiKeyId: string;
  plaintext: string;
}

export interface TestAppFixture {
  app: Awaited<ReturnType<typeof buildApp>>;
  authRepo: InMemoryAuthRepo;
  authCache: InMemoryAuthCache;
  authCoalescer: AuthCoalescer;
  sessionsRepo: InMemorySessionsRepo;
  apiKeysRepo: InMemoryApiKeysRepo;
  usageRepo: InMemoryUsageRepo;
  webhooksRepo: InMemoryWebhooksRepo;
  adminAuditRepo: InMemoryAdminAuditLogRepo;
  rateLimitOverridesRepo: InMemoryRateLimitOverridesRepo;
  rateLimitStore: MemoryRateLimitStore;
  driver: MockDriver;
  /** Plaintext API key — pass as `Authorization: Bearer <plaintext>`. */
  plaintext: string;
  accountId: string;
  apiKeyId: string;
  cleanup: () => Promise<void>;
}

export async function buildTestApp(opts: TestAppOptions = {}): Promise<TestAppFixture> {
  const authRepo = new InMemoryAuthRepo();
  const rateLimitStore = new MemoryRateLimitStore();

  const accountId = opts.accountId ?? '00000000-0000-4000-8000-000000000001';
  const apiKeyId = opts.apiKeyId ?? '00000000-0000-4000-8000-000000000a01';

  authRepo.upsertAccount({
    id: accountId,
    email: opts.email ?? 'tester@driftstack.local',
    name: 'Tester',
    tier: opts.tier ?? 'builder',
    status: opts.accountStatus ?? 'active',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });

  const plaintext = generateApiKey('test');
  const keyHash = await hashApiKey(plaintext);
  const keyPrefix = keyPrefixFromPlaintext(plaintext);

  authRepo.upsertApiKey({
    id: apiKeyId,
    accountId,
    name: 'test-key',
    keyPrefix,
    keyHash,
    scopes: opts.scopes ?? ['read', 'write', 'admin'],
    lastUsedAt: null,
    revokedAt: opts.keyRevoked === true ? new Date('2026-01-15T00:00:00Z') : null,
    expiresAt: opts.keyExpired === true ? new Date('2026-01-15T00:00:00Z') : null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });

  const sessionsRepo = new InMemorySessionsRepo();
  const driver = new MockDriver({
    fastForwardLatency: true,
    navigateLatencyMs: 0,
    interactLatencyMs: 0,
  });

  // Pass authRepo so revocations / inserts propagate to both repos in the
  // same way they would share a single DB row in production.
  const apiKeysRepo = new InMemoryApiKeysRepo(authRepo);
  apiKeysRepo.upsert({
    id: apiKeyId,
    accountId,
    name: 'test-key',
    keyPrefix,
    keyHash,
    scopes: opts.scopes ?? ['read', 'write', 'admin'],
    lastUsedAt: null,
    revokedAt: opts.keyRevoked === true ? new Date('2026-01-15T00:00:00Z') : null,
    expiresAt: opts.keyExpired === true ? new Date('2026-01-15T00:00:00Z') : null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  const authCache = new InMemoryAuthCache();
  const authCoalescer = new AuthCoalescer();

  const usageRepo = new InMemoryUsageRepo();
  const usageService = new UsageService(usageRepo);

  const webhooksRepo = new InMemoryWebhooksRepo();
  const webhooksService = new WebhooksService(webhooksRepo);
  const webhooksAdminService = new WebhooksAdminService(webhooksRepo);

  const adminAuditRepo = new InMemoryAdminAuditLogRepo();
  const adminAuditService = new AdminAuditService(adminAuditRepo);

  const accountsAdminRepo = new InMemoryAccountsAdminRepo(authRepo);
  const accountsAdminService = new AccountsAdminService(accountsAdminRepo, authCache);

  const rateLimitOverridesRepo = new InMemoryRateLimitOverridesRepo(authRepo);
  const rateLimitOverridesService = new RateLimitOverridesService(
    rateLimitOverridesRepo,
    authCache,
  );
  // Wire webhooks INTO sessions + api-keys services for event emission.
  const sessionsService = new SessionsService({
    repo: sessionsRepo,
    driver,
    webhooks: webhooksService,
  });
  const apiKeysService = new ApiKeysService(apiKeysRepo, authCache, webhooksService);

  // Legal-acceptance plumbing — uses an in-memory catalog with a fixed
  // canned document set (one per documentKey) so tests don't depend on
  // file-system reads.
  const legalRepo = new InMemoryLegalRepo();
  const legalCatalog = buildLegalCatalogFromContent([
    {
      documentKey: 'tos',
      title: 'Terms of Service',
      sourcePath: 'docs/legal/terms-of-service.md',
      content:
        '# Test ToS\n\n**Version:** 0.1.0-draft · **Effective:** 2026-05-03\n\nFixture content.',
    },
    {
      documentKey: 'privacy',
      title: 'Privacy Policy',
      sourcePath: 'docs/legal/privacy-policy.md',
      content:
        '# Test Privacy\n\n**Version:** 0.1.0-draft · **Effective:** 2026-05-03\n\nFixture content.',
    },
    {
      documentKey: 'dpa',
      title: 'DPA',
      sourcePath: 'docs/legal/dpa.md',
      content:
        '# Test DPA\n\n**Version:** 0.1.0-draft · **Effective:** 2026-05-03\n\nFixture content.',
    },
    {
      documentKey: 'aup',
      title: 'AUP',
      sourcePath: 'docs/legal/acceptable-use-policy.md',
      content:
        '# Test AUP\n\n**Version:** 0.1.0-draft · **Effective:** 2026-05-03\n\nFixture content.',
    },
  ]);
  const legalService = new LegalService(legalCatalog, legalRepo);

  const app = await buildApp({
    logger: createTestLogger(),
    authRepo,
    authCache,
    authCoalescer,
    rateLimitStore,
    sessionsService,
    apiKeysService,
    usageService,
    webhooksService,
    webhooksAdminService,
    adminAuditService,
    accountsAdminService,
    rateLimitOverridesService,
    legalService,
    permissiveCors: true,
  });

  return {
    app,
    authRepo,
    authCache,
    authCoalescer,
    webhooksRepo,
    adminAuditRepo,
    rateLimitOverridesRepo,
    sessionsRepo,
    apiKeysRepo,
    usageRepo,
    rateLimitStore,
    driver,
    plaintext,
    accountId,
    apiKeyId,
    cleanup: async () => {
      await app.close();
    },
  };
}

/**
 * Seed a second (or third, etc.) account on an existing test fixture.
 * Used by tests that need cross-account interaction — e.g. admin A
 * suspending account B then verifying B's keys 403 while A's keys
 * still work.
 *
 * The new account/key are written to BOTH `authRepo` and `apiKeysRepo`
 * (via the constructor-paired propagation set up in V-012). Returns
 * the new ids and plaintext key.
 */
export async function seedAdditionalAccount(
  fx: TestAppFixture,
  opts: SeedAdditionalOpts = {},
): Promise<AdditionalAccount> {
  const accountId = opts.accountId ?? '00000000-0000-4000-8000-0000000000a2';
  const apiKeyId = opts.apiKeyId ?? '00000000-0000-4000-8000-000000000a02';

  fx.authRepo.upsertAccount({
    id: accountId,
    email: opts.email ?? `tester-${accountId.slice(-4)}@driftstack.local`,
    name: opts.name ?? 'Tester-2',
    tier: opts.tier ?? 'builder',
    status: opts.accountStatus ?? 'active',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });

  const plaintext = generateApiKey('test');
  const keyHash = await hashApiKey(plaintext);
  const keyPrefix = keyPrefixFromPlaintext(plaintext);

  const keyRow = {
    id: apiKeyId,
    accountId,
    name: 'second-account-key',
    keyPrefix,
    keyHash,
    scopes: opts.scopes ?? (['read', 'write', 'admin'] as ApiKeyScope[]),
    lastUsedAt: null,
    revokedAt: null,
    expiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  fx.authRepo.upsertApiKey(keyRow);
  fx.apiKeysRepo.upsert(keyRow);

  return { accountId, apiKeyId, plaintext };
}
