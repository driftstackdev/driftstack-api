// Programmatic test data: insert an account + admin API key directly via
// Drizzle. Returns the plaintext key for use in Authorization headers.

import type { Redis } from 'ioredis';
import type postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { generateApiKey, hashApiKey, keyPrefixFromPlaintext } from '../../../src/lib/api-keys.js';
import { accounts, apiKeys } from '../../../src/db/schema.js';
import * as schema from '../../../src/db/schema.js';
import type { AccountTier, ApiKeyScope } from '@driftstack/api-types';

export interface SeedAccountInput {
  email?: string;
  tier?: AccountTier;
  scopes?: ApiKeyScope[];
  status?: 'active' | 'suspended' | 'deleted';
}

export interface SeededAccount {
  accountId: string;
  apiKeyId: string;
  plaintext: string;
  tier: AccountTier;
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

  const env = tier === 'trial_pack' ? 'test' : 'live';
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
    })
    .returning({ id: apiKeys.id });
  if (!key) throw new Error('failed to seed api key');

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
