// W625 — drift guard for 4 small but load-bearing meta files:
//  - apps/server/tests/e2e/helpers/seed.ts (programmatic account/key seed).
//  - apps/server/tests/e2e/helpers/server.ts (real Fastify + PG + Redis).
//  - docs/benchmarks/baseline.ci.json (V-165 perf-regression baseline).
//  - apps/gui-client/src-tauri/icons/README.md (placeholder marker).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('W625 e2e helpers + baseline.ci + icons README content parity', () => {
  it('apps/server/tests/e2e/helpers/seed.ts: V-049 legal-acceptance gate auto-pre-acceptance of 4 docs (ToS/Privacy/DPA/AUP) + skipLegalAcceptance opt-out + SeedAccountInput + SeededAccount types + seedAccount(client, input) + tier default api_builder + scopes default [read,write,admin] + key plaintext returned + clearRateLimits(redis) helper pinned', () => {
    const body = read('apps/server/tests/e2e/helpers/seed.ts');
    expect(body).toMatch(
      /^\/\/ Programmatic test data: insert an account \+ admin API key directly via$/m,
    );
    expect(body).toMatch(/V-049 legal-acceptance gate: POST \/v1\/api-keys requires the account/);
    expect(body).toMatch(/AUP\)\. seedAccount pre-acceptances all four against the canonical/);
    expect(body).toMatch(/catalog loaded from `docs\/legal\/\*\.md`/);
    expect(body).toMatch(/Tests/);
    expect(body).toMatch(
      /that exercise the gate explicitly can pass `skipLegalAcceptance: true`\./,
    );
    expect(body).toMatch(/^import \{ fileURLToPath \} from 'node:url';$/m);
    expect(body).toMatch(/^import \{ dirname, resolve \} from 'node:path';$/m);
    expect(body).toMatch(/^import type \{ Redis \} from 'ioredis';$/m);
    expect(body).toMatch(/^import type postgres from 'postgres';$/m);
    expect(body).toMatch(/^import \{ drizzle \} from 'drizzle-orm\/postgres-js';$/m);
    expect(body).toMatch(
      /import \{ generateApiKey, hashApiKey, keyPrefixFromPlaintext \} from '\.\.\/\.\.\/\.\.\/src\/lib\/api-keys\.js';/,
    );
    expect(body).toMatch(
      /import \{ accounts, apiKeys, legalAcceptances \} from '\.\.\/\.\.\/\.\.\/src\/db\/schema\.js';/,
    );
    expect(body).toMatch(
      /import type \{ AccountTier, ApiKeyScope \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/^export interface SeedAccountInput \{$/m);
    expect(body).toMatch(/email\?: string;/);
    expect(body).toMatch(/tier\?: AccountTier;/);
    expect(body).toMatch(/scopes\?: ApiKeyScope\[\];/);
    expect(body).toMatch(/status\?: 'active' \| 'suspended' \| 'deleted';/);
    expect(body).toMatch(
      /\/\*\* Skip seeding legal acceptances\. For tests that exercise the V-049 gate\. \*\//,
    );
    expect(body).toMatch(/skipLegalAcceptance\?: boolean;/);
    expect(body).toMatch(/^export interface SeededAccount \{$/m);
    expect(body).toMatch(/accountId: string;/);
    expect(body).toMatch(/apiKeyId: string;/);
    expect(body).toMatch(/plaintext: string;/);
    expect(body).toMatch(/tier: AccountTier;/);
    expect(body).toMatch(/^export async function seedAccount\($/m);
    expect(body).toMatch(/const tier: AccountTier = input\.tier \?\? 'api_builder';/);
    expect(body).toMatch(
      /email: input\.email \?\? `seed-\$\{Math\.random\(\)\.toString\(36\)\.slice\(2, 10\)\}@driftstack\.test`,/,
    );
    expect(body).toMatch(/const env = tier === 'free' \? 'test' : 'live';/);
    expect(body).toMatch(/const plaintext = generateApiKey\(env\);/);
    expect(body).toMatch(/scopes: input\.scopes \?\? \['read', 'write', 'admin'\],/);
    expect(body).toMatch(/\/\/ V-049 gate — pre-accept all legal docs unless the test opts out\./);
    expect(body).toMatch(/if \(input\.skipLegalAcceptance !== true\) \{/);
    expect(body).toMatch(
      /^export function authHeader\(plaintext: string\): \{ Authorization: string \} \{$/m,
    );
    expect(body).toMatch(/return \{ Authorization: `Bearer \$\{plaintext\}` \};/);
    expect(body).toMatch(
      /^export async function clearRateLimits\(redis: Redis\): Promise<void> \{$/m,
    );
    expect(body).toMatch(/await redis\.flushdb\(\);/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/server/tests/e2e/helpers/seed.ts'))).toBe(true);
  });

  it('apps/server/tests/e2e/helpers/server.ts: real Fastify + Postgres + Redis + workers=1 single-shared-DB + V-009 per-worker-DB rationale + TRUNCATE_SQL FK-aware 17-table list + DROP-SCHEMA-CASCADE both drizzle+public + migrate from src/db/migrations + V-225 webhooks accountAudit wire + V-202c lifecycle + V-540.B-15 InMemoryBillingProvider + V-541.B costUsageByAccount Map + 6-tier billingService.tierPrices monthly/annual + ScheduledJobsService + InMemoryOAuthStore + permissiveCors pinned', () => {
    const body = read('apps/server/tests/e2e/helpers/server.ts');
    expect(body).toMatch(
      /^\/\/ Boots a real Fastify app for e2e tests, wired against real Postgres \+ Redis\./m,
    );
    expect(body).toMatch(
      /Single shared database \(DATABASE_URL\); migrations applied idempotently on/,
    );
    expect(body).toMatch(/Workers serialise on this DB — playwright\.config\.ts sets workers=1\./);
    expect(body).toMatch(/Multi-worker DB isolation would require per-worker DATABASEs \(not just/);
    expect(body).toMatch(
      /schemas\), since Postgres enum types aren't schema-scoped — V-009 captures/,
    );
    expect(body).toMatch(/^import \{ buildApp \} from '\.\.\/\.\.\/\.\.\/src\/lib\/app\.js';$/m);
    expect(body).toMatch(
      /^import \{ MockDriver \} from '\.\.\/\.\.\/\.\.\/src\/drivers\/mock\.js';$/m,
    );
    expect(body).toMatch(/^export interface TestServer \{$/m);
    expect(body).toMatch(/baseUrl: string;/);
    expect(body).toMatch(/client: ReturnType<typeof postgres>;/);
    expect(body).toMatch(/redis: Redis;/);
    expect(body).toMatch(/webhookWorker: WebhookDeliveryWorker;/);
    expect(body).toMatch(
      /\/\*\* V-540\.B-15 — Stripe stub state for billing-write spec assertions\. \*\//,
    );
    expect(body).toMatch(/billingProvider: InMemoryBillingProvider;/);
    expect(body).toMatch(/V-541\.B \/ V-540\.B-3 — populate this map to drive the cost/);
    expect(body).toMatch(/costUsageByAccount: Map<string, UsageInputs>;/);
    expect(body).toMatch(/cleanup: \(\) => Promise<void>;/);
    expect(body).toMatch(/resetState: \(\) => Promise<void>;/);
    expect(body).toMatch(
      /const DEFAULT_DB_URL = 'postgres:\/\/driftstack:driftstack@localhost:5432\/driftstack';/,
    );
    expect(body).toMatch(/const DEFAULT_REDIS_URL = 'redis:\/\/localhost:6379';/);
    expect(body).toMatch(/^const TRUNCATE_SQL = `$/m);
    expect(body).toMatch(/"session_events",/);
    expect(body).toMatch(/"sessions",/);
    expect(body).toMatch(/"usage_records",/);
    expect(body).toMatch(/"rate_limit_buckets",/);
    expect(body).toMatch(/"rate_limit_overrides",/);
    expect(body).toMatch(/"webhook_deliveries",/);
    expect(body).toMatch(/"webhook_endpoints",/);
    expect(body).toMatch(/"admin_audit_log",/);
    expect(body).toMatch(/"email_verify_tokens",/);
    expect(body).toMatch(/"magic_link_tokens",/);
    expect(body).toMatch(/"password_reset_tokens",/);
    expect(body).toMatch(/"web_sessions",/);
    expect(body).toMatch(/"processed_stripe_events",/);
    expect(body).toMatch(/"subscriptions",/);
    expect(body).toMatch(/"profiles",/);
    expect(body).toMatch(/"api_keys",/);
    expect(body).toMatch(/"accounts"/);
    expect(body).toMatch(/RESTART IDENTITY CASCADE/);
    expect(body).toMatch(/^export async function startTestServer\(\): Promise<TestServer> \{$/m);
    expect(body).toMatch(/await client\.unsafe\('DROP SCHEMA IF EXISTS "drizzle" CASCADE'\);/);
    expect(body).toMatch(/await client\.unsafe\('DROP SCHEMA IF EXISTS "public" CASCADE'\);/);
    expect(body).toMatch(/await client\.unsafe\('CREATE SCHEMA "public"'\);/);
    expect(body).toMatch(
      /const migrationsFolder = resolve\(here, '\.\.', '\.\.', '\.\.', 'src', 'db', 'migrations'\);/,
    );
    expect(body).toMatch(/await migrate\(db, \{ migrationsFolder \}\);/);
    expect(body).toMatch(/const driver = new MockDriver\(\{/);
    expect(body).toMatch(/fastForwardLatency: false,/);
    expect(body).toMatch(/navigateLatencyMs: 30,/);
    expect(body).toMatch(/interactLatencyMs: 10,/);
    expect(body).toMatch(
      /\/\/ V-225 — accountAudit wired for webhook_endpoint\.\{created,deleted\}\./,
    );
    expect(body).toMatch(
      /const webhooksService = new WebhooksService\(webhooksRepo, accountAuditService\);/,
    );
    expect(body).toMatch(
      /solo_manual: \{ monthly: 'price_solo_monthly', annual: 'price_solo_annual' \},/,
    );
    expect(body).toMatch(
      /team_manual: \{ monthly: 'price_team_monthly', annual: 'price_team_annual' \},/,
    );
    expect(body).toMatch(
      /agency_manual: \{ monthly: 'price_agency_monthly', annual: 'price_agency_annual' \},/,
    );
    expect(body).toMatch(
      /api_starter: \{ monthly: 'price_api_starter_monthly', annual: 'price_api_starter_annual' \},/,
    );
    expect(body).toMatch(
      /api_builder: \{ monthly: 'price_api_builder_monthly', annual: 'price_api_builder_annual' \},/,
    );
    expect(body).toMatch(
      /api_scale: \{ monthly: 'price_api_scale_monthly', annual: 'price_api_scale_annual' \},/,
    );
    expect(body).toMatch(/permissiveCors: true,/);
    expect(body).toMatch(/await app\.listen\(\{ host: '127\.0\.0\.1', port: 0 \}\);/);
    expect(body).toMatch(/throw new Error\('listening on a unix socket\?'\);/);
    expect(body).toMatch(/const baseUrl = `http:\/\/127\.0\.0\.1:\$\{addr\.port\.toString\(\)\}`;/);
    expect(body).toMatch(/await client\.unsafe\(TRUNCATE_SQL\);/);
    expect(body).toMatch(/await app\.close\(\);/);
    expect(body).toMatch(/await redis\.quit\(\);/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/server/tests/e2e/helpers/server.ts'))).toBe(true);
  });

  it('docs/benchmarks/baseline.ci.json: V-165 starter baseline + Apple M-class dev workstation NOT CI runner + 50% PERF_REGRESSION_THRESHOLD + recordedAtIso + 5 bench keys (auth-cache.bench.ts × 3 + rate-limit.bench.ts × 2+) + hz + mean fields pinned', () => {
    const body = read('docs/benchmarks/baseline.ci.json');
    expect(body).toMatch(/"recordedAtIso": "2026-05-05T08:21:28\.628Z"/);
    expect(body).toMatch(
      /V-165 starter baseline — recorded on Apple M-class dev workstation, NOT a CI runner/,
    );
    expect(body).toMatch(/CI runners produce different numbers; the 50% slowdown threshold/);
    expect(body).toMatch(/\(PERF_REGRESSION_THRESHOLD env, default 0\.50\)/);
    expect(body).toMatch(/Recalibrate on first stable CI run by deleting this file/);
    expect(body).toMatch(
      /letting the bench-regression CI step \(advisory mode\) record a fresh baseline/,
    );
    expect(body).toMatch(/"benchmarks": \[/);
    expect(body).toMatch(
      /"apps\/server\/tests\/bench\/auth-cache\.bench\.ts > sha256\(plaintext\) — cache key derivation/,
    );
    expect(body).toMatch(
      /"apps\/server\/tests\/bench\/auth-cache\.bench\.ts > InMemoryAuthCache — hot path/,
    );
    expect(body).toMatch(
      /"apps\/server\/tests\/bench\/auth-cache\.bench\.ts > InMemoryAuthCache — cold path/,
    );
    expect(body).toMatch(
      /"apps\/server\/tests\/bench\/rate-limit\.bench\.ts > MemoryRateLimitStore\.consume — happy path/,
    );
    expect(body).toMatch(
      /"apps\/server\/tests\/bench\/rate-limit\.bench\.ts > MemoryRateLimitStore\.consume — refill \+ consume/,
    );
    expect(body).toMatch(/"hz":/);
    expect(body).toMatch(/"mean":/);
    expect(existsSync(resolve(REPO_ROOT, 'docs/benchmarks/baseline.ci.json'))).toBe(true);
  });

  it("apps/gui-client/src-tauri/icons/README.md: real icons regenerated 2026-05-20 (previously a placeholder waiting on GUI7 — now resolved); pin the regeneration framing + brand-mark source so a future regen can't silently drop the provenance trail", () => {
    const body = read('apps/gui-client/src-tauri/icons/README.md');
    expect(body).toMatch(/^# GUI icons$/m);
    expect(body).toMatch(/Regenerated 2026-05-20/);
    expect(body).toMatch(/apps\/marketing-site\/public\/driftstack-mark\.svg/);
    expect(existsSync(resolve(REPO_ROOT, 'apps/gui-client/src-tauri/icons/README.md'))).toBe(true);
  });
});
