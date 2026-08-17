// `findActiveRateLimitOverrides` decides a customer's effective rate limits.
//
// Found by coverage, not by reading: a full-suite v8 run put `db/auth-repo.ts`
// at 32.4% lines, and two of its ten methods are called by no test at all. This
// is one of them, and it is the one that matters — every authenticated request
// resolves an AccountContext through it, so whatever it returns is the bucket
// the customer is actually held to.
//
// Three ways it can be wrong, none of them previously exercised:
//
//   expiry     the `gt(expiresAt, now)` filter is what ends a temporary
//              override. Widen it and a customer keeps an elevated limit
//              forever; invert it and every live override vanishes, dropping
//              paying accounts onto the default bucket mid-request.
//   scoping    the `eq(accountId, …)` is the only thing keeping one account's
//              override off another account's context. Without it a generous
//              override leaks across the tenant boundary.
//   centi      rates are stored as a fixed-point centi-rate and divided by 100
//              on the way out. Drop the division and a 1.5/s refill becomes
//              150/s — a hundredfold limit increase that looks like a working
//              rate limiter right up until the bill.
//
// Against a real Postgres, because the predicate under test IS the SQL: an
// in-memory double would assert my re-implementation of `gt` rather than the
// query the server runs. Skips when no database is reachable, like its siblings.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAccountAuthRepo } from '../../src/db/auth-repo.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let repo: DrizzleAccountAuthRepo | null = null;
const seededAccounts: string[] = [];

const MINUTE = 60_000;

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 2 });
  try {
    await client`SELECT 1 FROM rate_limit_overrides LIMIT 0`;
    dbReachable = true;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
    return;
  }
  repo = new DrizzleAccountAuthRepo({ db: drizzle(client, { schema }) } as never);
});

afterAll(async () => {
  if (client && seededAccounts.length > 0) {
    // rate_limit_overrides cascades from accounts.
    await client`DELETE FROM accounts WHERE id = ANY(${client.array(seededAccounts)}::uuid[])`.catch(
      () => undefined,
    );
  }
  await client?.end({ timeout: 2 }).catch(() => undefined);
});

/** An account plus the api key that `set_by_key_id` requires (NOT NULL, FK). */
async function seedAccount(): Promise<{ accountId: string; keyId: string }> {
  const accountId = randomUUID();
  await client!`
    INSERT INTO accounts (id, email, tier, status)
    VALUES (${accountId}, ${`rlo-${accountId}@driftstack.test`}, 'api_builder', 'active')`;
  seededAccounts.push(accountId);
  const keyId = randomUUID();
  await client!`
    INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash, scopes)
    VALUES (${keyId}, ${accountId}, 'rlo-test', ${`rlo_${keyId.slice(0, 8)}`}, ${randomUUID()},
            ARRAY['read','write']::api_key_scope[])`;
  return { accountId, keyId };
}

async function seedOverride(
  seeded: { accountId: string; keyId: string },
  bucketKey: string,
  capacity: number,
  refillPerSecondCenti: number,
  expiresAt: Date,
): Promise<void> {
  await client!`
    INSERT INTO rate_limit_overrides
      (account_id, bucket_key, capacity, refill_per_second_centi, expires_at, set_by_key_id)
    VALUES (${seeded.accountId}, ${bucketKey}, ${capacity}, ${refillPerSecondCenti},
            ${expiresAt.toISOString()}::timestamptz, ${seeded.keyId})`;
}

// Reachability is decided in beforeAll, so each arm checks it rather than a
// collection-time skipIf — which would evaluate before the probe has run.
describe('DrizzleAccountAuthRepo.findActiveRateLimitOverrides', () => {
  it('CRITICAL an expired override is not returned, and a live one is', async () => {
    if (!dbReachable || !repo) return;
    const seeded = await seedAccount();
    const accountId = seeded.accountId;
    const now = new Date();
    await seedOverride(seeded, 'live', 500, 150, new Date(now.getTime() + 10 * MINUTE));
    await seedOverride(seeded, 'expired', 999, 999, new Date(now.getTime() - MINUTE));

    const active = await repo.findActiveRateLimitOverrides(accountId, now);

    expect(
      active.map((o) => o.bucketKey).sort(),
      'an override past its expiry is still being applied — a temporary limit increase that ' +
        'never ends',
    ).toEqual(['live']);
  });

  it('CRITICAL one account never sees another account’s override', async () => {
    if (!dbReachable || !repo) return;
    const mine = await seedAccount();
    const theirs = await seedAccount();
    const now = new Date();
    await seedOverride(theirs, 'generous', 10_000, 10_000, new Date(now.getTime() + 10 * MINUTE));

    const active = await repo.findActiveRateLimitOverrides(mine.accountId, now);

    expect(
      active,
      'an override belonging to another account reached this context — a limit granted to one ' +
        'customer applied to a different one',
    ).toEqual([]);
  });

  it('CRITICAL the stored centi-rate is divided back to a per-second rate', async () => {
    if (!dbReachable || !repo) return;
    const seeded = await seedAccount();
    const accountId = seeded.accountId;
    const now = new Date();
    // 150 centi = 1.5/s. Returned raw it would be a hundredfold increase.
    await seedOverride(seeded, 'centi', 200, 150, new Date(now.getTime() + 10 * MINUTE));

    const [override] = await repo.findActiveRateLimitOverrides(accountId, now);

    expect(override?.refillPerSecond, 'the centi-rate reached the bucket unconverted').toBe(1.5);
    expect(override?.capacity, 'capacity is stored plainly and must not be scaled').toBe(200);
  });

  it('CRITICAL an account with no overrides resolves to an empty set, not a default', async () => {
    if (!dbReachable || !repo) return;
    const seeded = await seedAccount();
    const accountId = seeded.accountId;
    expect(await repo.findActiveRateLimitOverrides(accountId, new Date())).toEqual([]);
  });
});
