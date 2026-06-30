// #2 (2026-06-30) — real-Postgres integration test for the restore() storage-
// quota re-check.
//
// Bug: sumSizeBytesByAccount (the enforced storage-quota numerator) only ever
// sums LIVE (notDeleted) profiles' size_bytes — trashed profiles are excluded
// by design. assertWithinStorageQuotaForLaunch (the HARD launch-time gate)
// reads only that sum. Pre-fix, restore() cleared deletedAt with zero re-check
// against the cap: a customer at their hard storage cap could soft-delete a
// large profile (the real R2 bytes stay untouched — a soft delete never
// touches R2) to instantly free reported quota, do whatever the cap was
// blocking, then bring the exact same bytes back later via restore — a
// trash+restore round-trip silently bypassed the hard cap for the entire
// 30-day trash retention window.
//
// Fix: restore() now re-validates (current LIVE usage + the trashed profile's
// own size_bytes) against the account's tier cap, atomically under a `FOR
// UPDATE` lock on the owning account row (mirrors insertWithLimit's pattern),
// and THROWS StorageQuotaExceededError instead of clearing deletedAt when the
// projected total would be 'hard'.
//
// Run scope: same as the sibling db-profiles-repo-keyset-drizzle.test.ts —
// CI always runs this (postgres:17-alpine + migrated schema); local dev skips
// quietly unless DATABASE_URL/CI is set (vacuous-pass is forbidden in CI).

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TIER_STORAGE_BYTES_CAP } from '@driftstack/api-types';
import { DrizzleProfilesRepo } from '../../src/db/profiles-repo.js';
import { StorageQuotaExceededError } from '../../src/lib/errors.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

const FREE_CAP_BYTES = TIER_STORAGE_BYTES_CAP.free; // 1 GiB

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
// accountIds seeded — cleaned in FK order: profiles → accounts.
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 1 });
  try {
    await client`SELECT 1 FROM profiles LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM profiles WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleProfilesRepo.restore storage-quota re-check (FIX #2, against real Postgres)',
  () => {
    function skipOrFail(label: string): boolean {
      if (dbReachable && client) return false;
      if (process.env.CI) {
        throw new Error(
          `${label}: database unreachable/unmigrated in CI — vacuous pass is forbidden`,
        );
      }
      return true;
    }

    function makeRepo(): DrizzleProfilesRepo {
      const sql = client;
      if (!sql) throw new Error('unreachable — guarded by skipOrFail');
      const db = drizzle(sql) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      return new DrizzleProfilesRepo({ client: sql, db, close: async () => {} });
    }

    async function seedAccount(tier = 'free'): Promise<string> {
      const sql = client;
      if (!sql) throw new Error('unreachable — guarded by skipOrFail');
      const accountId = randomUUID();
      seeded.push(accountId);
      await sql`INSERT INTO accounts (id, email, tier) VALUES (${accountId}, ${`restore-quota-${accountId}@test.local`}, ${tier})`;
      return accountId;
    }

    async function seedTrashedProfile(accountId: string, sizeBytes: number): Promise<string> {
      const sql = client;
      if (!sql) throw new Error('unreachable — guarded by skipOrFail');
      const [row] = await sql`
        INSERT INTO profiles (account_id, name, size_bytes, deleted_at)
        VALUES (${accountId}, ${`trashed-${randomUUID()}`}, ${sizeBytes}, now())
        RETURNING id`;
      return row?.id as string;
    }

    async function seedLiveProfile(accountId: string, sizeBytes: number): Promise<string> {
      const sql = client;
      if (!sql) throw new Error('unreachable — guarded by skipOrFail');
      const [row] = await sql`
        INSERT INTO profiles (account_id, name, size_bytes)
        VALUES (${accountId}, ${`live-${randomUUID()}`}, ${sizeBytes})
        RETURNING id`;
      return row?.id as string;
    }

    async function deletedAtOf(profileId: string): Promise<Date | null> {
      const sql = client;
      if (!sql) throw new Error('unreachable — guarded by skipOrFail');
      const [row] = await sql`SELECT deleted_at FROM profiles WHERE id = ${profileId}`;
      return (row?.deleted_at as Date | null) ?? null;
    }

    it('refuses to restore a trashed profile whose OWN size already exceeds the free-tier hard cap, leaving it trashed', async () => {
      if (skipOrFail('restore-quota over-cap (own size)')) return;
      const repo = makeRepo();
      const accountId = await seedAccount('free');
      const profileId = await seedTrashedProfile(accountId, FREE_CAP_BYTES + 1024);

      await expect(repo.restore({ id: profileId, accountId })).rejects.toThrow(
        StorageQuotaExceededError,
      );
      expect(await deletedAtOf(profileId)).not.toBeNull();
    });

    it('refuses to restore when the trashed profile combined with EXISTING live usage exceeds the cap (the trash+restore bypass)', async () => {
      if (skipOrFail('restore-quota over-cap (combined)')) return;
      const repo = makeRepo();
      const accountId = await seedAccount('free');
      // Live usage already at 90% of the 1 GiB free cap.
      await seedLiveProfile(accountId, Math.floor(FREE_CAP_BYTES * 0.9));
      // The trashed profile alone is well under the cap, but combined with the
      // existing live usage it pushes the account over 100% — this is exactly
      // the trash+restore bypass the fix closes: soft-deleting this profile
      // would have freed headroom for OTHER profiles to grow into, then
      // restoring it must not be allowed to silently re-exceed the cap.
      const trashedId = await seedTrashedProfile(accountId, Math.floor(FREE_CAP_BYTES * 0.2));

      await expect(repo.restore({ id: trashedId, accountId })).rejects.toThrow(
        StorageQuotaExceededError,
      );
      expect(await deletedAtOf(trashedId)).not.toBeNull();
    });

    it('restores normally when the projected total stays within the cap', async () => {
      if (skipOrFail('restore-quota within-cap')) return;
      const repo = makeRepo();
      const accountId = await seedAccount('free');
      const profileId = await seedTrashedProfile(accountId, 1024);

      await expect(repo.restore({ id: profileId, accountId })).resolves.toBe('restored');
      expect(await deletedAtOf(profileId)).toBeNull();
    });

    it('restores normally on enterprise even far over the (soft-only) cap — enterprise never hard-blocks', async () => {
      if (skipOrFail('restore-quota enterprise soft-only')) return;
      const repo = makeRepo();
      const accountId = await seedAccount('enterprise');
      const profileId = await seedTrashedProfile(accountId, TIER_STORAGE_BYTES_CAP.enterprise * 2);

      await expect(repo.restore({ id: profileId, accountId })).resolves.toBe('restored');
      expect(await deletedAtOf(profileId)).toBeNull();
    });
  },
);
