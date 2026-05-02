// Boots a real Fastify app for e2e tests, wired against real Postgres + Redis.
//
// Single shared database (DATABASE_URL); migrations applied idempotently on
// every server boot (no-op once applied). State isolation between tests is
// via TRUNCATE in resetState() before every test (FK-aware order).
//
// Workers serialise on this DB — playwright.config.ts sets workers=1.
// Multi-worker DB isolation would require per-worker DATABASEs (not just
// schemas), since Postgres enum types aren't schema-scoped — V-009 captures
// the empirical finding that drove this design choice.

import type { AddressInfo } from 'node:net';
import { Redis } from 'ioredis';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildApp } from '../../../src/lib/app.js';
import { createTestLogger } from '../../../src/lib/logger.js';
import { MockDriver } from '../../../src/drivers/mock.js';
import { SessionsService } from '../../../src/services/sessions.js';
import { ApiKeysService } from '../../../src/services/api-keys.js';
import { UsageService } from '../../../src/services/usage.js';
import { DrizzleAccountAuthRepo } from '../../../src/db/auth-repo.js';
import { DrizzleSessionRepo } from '../../../src/db/sessions-repo.js';
import { DrizzleApiKeysRepo } from '../../../src/db/api-keys-repo.js';
import { DrizzleUsageRepo } from '../../../src/db/usage-repo.js';
import { RedisRateLimitStore } from '../../../src/lib/redis-rate-limit-store.js';
import * as schema from '../../../src/db/schema.js';

export interface TestServer {
  baseUrl: string;
  client: ReturnType<typeof postgres>;
  redis: Redis;
  cleanup: () => Promise<void>;
  resetState: () => Promise<void>;
}

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DEFAULT_REDIS_URL = 'redis://localhost:6379';

const TRUNCATE_SQL = `
  TRUNCATE TABLE
    "session_events",
    "sessions",
    "usage_records",
    "rate_limit_buckets",
    "api_keys",
    "accounts"
  RESTART IDENTITY CASCADE
`;

export async function startTestServer(): Promise<TestServer> {
  const dbUrl = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
  const redisUrl = process.env.REDIS_URL ?? DEFAULT_REDIS_URL;

  const client = postgres(dbUrl, { max: 5 });
  const db = drizzle(client, { schema });

  // E2E owns the database. Drop everything (including drizzle's migration
  // log) and re-run migrations from scratch. This makes the suite hermetic:
  // no dependency on prior dev / seed state. Drizzle's migration log lives
  // under the `drizzle` schema (separate from `public` which holds the app
  // tables), so both must be dropped to force a full re-apply.
  await client.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
  await client.unsafe('DROP SCHEMA IF EXISTS "public" CASCADE');
  await client.unsafe('CREATE SCHEMA "public"');

  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, '..', '..', '..', 'src', 'db', 'migrations');
  await migrate(db, { migrationsFolder });

  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  await redis.flushdb();

  const database = { client, db, close: async () => client.end({ timeout: 5 }) };

  const authRepo = new DrizzleAccountAuthRepo(database);
  const sessionsRepo = new DrizzleSessionRepo(database);
  const apiKeysRepo = new DrizzleApiKeysRepo(database);
  const usageRepo = new DrizzleUsageRepo(database);
  const rateLimitStore = new RedisRateLimitStore(redis);

  const driver = new MockDriver({
    fastForwardLatency: false,
    navigateLatencyMs: 30,
    interactLatencyMs: 10,
  });

  const sessionsService = new SessionsService({ repo: sessionsRepo, driver });
  const apiKeysService = new ApiKeysService(apiKeysRepo);
  const usageService = new UsageService(usageRepo);

  const app = await buildApp({
    logger: createTestLogger(),
    authRepo,
    sessionsService,
    apiKeysService,
    usageService,
    rateLimitStore,
    permissiveCors: true,
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr: AddressInfo | string | null = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('listening on a unix socket?');
  const baseUrl = `http://127.0.0.1:${addr.port.toString()}`;

  const resetState = async (): Promise<void> => {
    await client.unsafe(TRUNCATE_SQL);
    await redis.flushdb();
  };

  const cleanup = async (): Promise<void> => {
    await app.close();
    await redis.quit();
    await client.end({ timeout: 5 });
  };

  return { baseUrl, client, redis, cleanup, resetState };
}
