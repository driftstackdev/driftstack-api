// Programmatic test data: insert an account + admin API key directly via
// Drizzle. Returns the plaintext key for use in Authorization headers.
//
// V-049 legal-acceptance gate: POST /v1/api-keys requires the account
// to have accepted all required legal documents (ToS / Privacy / DPA /
// AUP). seedAccount pre-acceptances all four against the canonical
// catalog loaded from `docs/legal/*.md`, mirroring the integration
// fixture at `tests/integration/_helpers/build-test-app.ts`. Tests
// that exercise the gate explicitly can pass `skipLegalAcceptance: true`.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Redis } from 'ioredis';
import type postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateApiKey, hashApiKey, keyPrefixFromPlaintext } from '../../../src/lib/api-keys.js';
import { accounts, apiKeys, legalAcceptances } from '../../../src/db/schema.js';
import * as schema from '../../../src/db/schema.js';
import { buildLegalCatalog } from '../../../src/services/legal-catalog.js';
import type { AccountTier, ApiKeyScope } from '@driftstack/api-types';

export interface SeedAccountInput {
  email?: string;
  tier?: AccountTier;
  scopes?: ApiKeyScope[];
  status?: 'active' | 'suspended' | 'deleted';
  /** Skip seeding legal acceptances. For tests that exercise the V-049 gate. */
  skipLegalAcceptance?: boolean;
  /**
   * Mint the key with device-code provenance.
   *
   * Required for any test that exercises `free`-tier behaviour. Free is a
   * DESKTOP tier: `requireProgrammaticApiAccess` refuses every ordinary API key
   * on a free account with 403 `apiAccess` at AUTH, before any route gate runs,
   * and only a `cli_device`-provenance credential reaches the free-desktop
   * allowlisted routes. A free-tier spec without this is not testing the route
   * it names — it is measuring the tier boundary and calling it something else.
   */
  provenance?: 'cli_device';
}

export interface SeededAccount {
  accountId: string;
  apiKeyId: string;
  plaintext: string;
  tier: AccountTier;
}

// Cache the catalog once per process — DEFAULT_SOURCES + readFileSync
// are deterministic across the e2e run.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
let cachedCatalog: ReturnType<typeof buildLegalCatalog> | null = null;
function getCatalog(): ReturnType<typeof buildLegalCatalog> {
  if (cachedCatalog === null) {
    cachedCatalog = buildLegalCatalog({ repoRoot });
  }
  return cachedCatalog;
}

export async function seedAccount(
  client: ReturnType<typeof postgres>,
  input: SeedAccountInput = {},
): Promise<SeededAccount> {
  const db = drizzle(client, { schema });
  const tier: AccountTier = input.tier ?? 'api_builder';

  const [account] = await db
    .insert(accounts)
    .values({
      email: input.email ?? `seed-${Math.random().toString(36).slice(2, 10)}@driftstack.test`,
      name: 'Seeded',
      tier,
      status: input.status ?? 'active',
    })
    .returning({ id: accounts.id });
  if (!account) throw new Error('failed to seed account');

  const env = tier === 'free' ? 'test' : 'live';
  const plaintext = generateApiKey(env);
  const keyHash = await hashApiKey(plaintext);
  const keyPrefix = keyPrefixFromPlaintext(plaintext);

  const [key] = await db
    .insert(apiKeys)
    .values({
      accountId: account.id,
      name: 'e2e-seed',
      keyPrefix,
      keyHash,
      scopes: input.scopes ?? ['read', 'write', 'admin'],
      ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
    })
    .returning({ id: apiKeys.id });
  if (!key) throw new Error('failed to seed api key');

  // V-049 gate — pre-accept all legal docs unless the test opts out.
  if (input.skipLegalAcceptance !== true) {
    const catalog = getCatalog();
    const rows = catalog.entries().map((entry) => ({
      accountId: account.id,
      documentKey: entry.documentKey,
      version: entry.version,
      contentHash: entry.contentHash,
    }));
    if (rows.length > 0) {
      await db.insert(legalAcceptances).values(rows);
    }
  }

  return { accountId: account.id, apiKeyId: key.id, plaintext, tier };
}

export function authHeader(plaintext: string): { Authorization: string } {
  return { Authorization: `Bearer ${plaintext}` };
}

// Helper to use redis directly in tests if a spec needs to manipulate
// rate-limit state (e.g. drain a bucket pre-emptively).
export async function clearRateLimits(redis: Redis): Promise<void> {
  await redis.flushdb();
}
