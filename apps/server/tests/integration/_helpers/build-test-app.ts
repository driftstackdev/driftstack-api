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
import { WebhooksService } from '../../../src/services/webhooks.js';
import { InMemoryAuthCache } from '../../../src/services/auth-cache.js';
import { AuthCoalescer } from '../../../src/services/auth-coalescer.js';
import { InMemoryAuthRepo } from './in-memory-auth-repo.js';
import { InMemorySessionsRepo } from './in-memory-sessions-repo.js';
import { InMemoryApiKeysRepo } from './in-memory-api-keys-repo.js';
import { InMemoryUsageRepo } from './in-memory-usage-repo.js';
import { InMemoryWebhooksRepo } from './in-memory-webhooks-repo.js';
import type { AccountTier, ApiKeyScope } from '@driftstack/api-types';

export interface TestAppOptions {
  tier?: AccountTier;
  scopes?: ApiKeyScope[];
  accountStatus?: 'active' | 'suspended' | 'deleted';
  keyRevoked?: boolean;
  keyExpired?: boolean;
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

  const accountId = '00000000-0000-4000-8000-000000000001';
  const apiKeyId = '00000000-0000-4000-8000-000000000a01';

  authRepo.upsertAccount({
    id: accountId,
    email: 'tester@driftstack.local',
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
  // Wire webhooks INTO sessions + api-keys services for event emission.
  const sessionsService = new SessionsService({
    repo: sessionsRepo,
    driver,
    webhooks: webhooksService,
  });
  const apiKeysService = new ApiKeysService(apiKeysRepo, authCache, webhooksService);

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
    permissiveCors: true,
  });

  return {
    app,
    authRepo,
    authCache,
    authCoalescer,
    webhooksRepo,
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
