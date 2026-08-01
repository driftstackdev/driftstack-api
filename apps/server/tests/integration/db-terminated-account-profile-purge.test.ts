// Profiles and snapshots are erased 30 days after account termination.
//
// privacy-policy.md §9 commits to deleting "Profile metadata + Profile
// Snapshots ... within 30 days of Customer Account termination". Nothing did,
// for the same four reasons the proxy-credential gap had: `deleteAccount` is a
// SOFT delete that touches no profile row, the accounts row is never
// hard-deleted so the ON DELETE CASCADE never fires, the account-deletion purge
// sweeper handled only secrets, and the profile retention sweeper keys off a
// PROFILE's own deletedAt — which a profile the customer never trashed does not
// have. So a terminated account's live profiles and every snapshot it ever
// captured were retained indefinitely.
//
// Snapshots need their own delete and get their own cases here.
// `profile_snapshots.parent_profile_id` is ON DELETE SET NULL, so purging
// profiles leaves snapshots behind with a null parent, still holding the
// captured state inline in `state_blob`. Deleting profiles and assuming the
// snapshots followed is precisely the mistake this file exists to prevent.
//
// Against real Postgres, because the safety is two SQL predicates and the
// cases that matter most are the ones that must NOT be touched. This purge
// deletes profiles that are perfectly live; its only licence is the account's
// terminated status, so that is what gets hammered below.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

import { ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import { DrizzleProfilesRepo } from '../../src/db/profiles-repo.js';
import { DrizzleProfileSnapshotsRepo } from '../../src/db/profile-snapshots-repo.js';
import type { Database } from '../../src/db/client.js';

// Runs against its OWN database: every purge here is GLOBAL — it selects and
// DELETES by cutoff across all accounts, so on a shared database it reaches
// other test files' fixtures and they reach its. See
// _helpers/isolated-database.ts; the agent-session purge already destroyed the
// receipt test's rows once via ON DELETE CASCADE, and that was patched with a
// fixture workaround, which is the fix that does not hold.
const ISOLATED_DB_NAME = 'driftstack_iso_purge_profiles';
let DB_URL = '';
const DAY_MS = 24 * 60 * 60 * 1000;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seeded: string[] = [];

beforeAll(async () => {
  const isolated = await ensureIsolatedDatabase(ISOLATED_DB_NAME);
  if (isolated === null) return;
  DB_URL = isolated;
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM profile_snapshots LIMIT 0`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 4 });
});

/**
 * Delete everything seeded so far, and forget it.
 *
 * A comment further down already names why this matters: the purges are GLOBAL
 * — they select every terminated account, not one — so a fixture left behind is
 * picked up by the NEXT test's call and shows there as a phantom row. That was
 * handled by draining at the end of the one test known to precede the one it
 * broke, which fixes exactly that ordering and no other. Reordered, "a
 * SUSPENDED account keeps everything" counted 1 where it expected 0.
 *
 * Draining after every test makes each one independent of what ran before it,
 * rather than correct only in the order they happen to be written.
 */
async function cleanupSeeded(): Promise<void> {
  if (!client) return;
  for (const accountId of seeded.splice(0)) {
    await client`DELETE FROM profile_snapshots WHERE account_id = ${accountId}`.catch(() => {});
    await client`DELETE FROM profiles WHERE account_id = ${accountId}`.catch(() => {});
    await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
  }
}

afterEach(cleanupSeeded);

afterAll(async () => {
  await cleanupSeeded();
  if (client) await client.end({ timeout: 5 });
});

/** An account in a lifecycle state, owning one live profile and one snapshot. */
async function seedAccountWithProfile(args: {
  status: 'active' | 'suspended' | 'deleted';
  deletedDaysAgo: number | null;
}): Promise<{ accountId: string; profileId: string }> {
  if (!client) throw new Error('no client');
  const accountId = randomUUID();
  seeded.push(accountId);
  const deletedAt =
    args.deletedDaysAgo === null
      ? null
      : new Date(Date.now() - args.deletedDaysAgo * DAY_MS).toISOString();
  await client`
    INSERT INTO accounts (id, email, status, deleted_at)
    VALUES (${accountId}, ${`profile-retention-${accountId}@test.local`}, ${args.status}::account_status, ${deletedAt})`;
  const profileId = randomUUID();
  // deleted_at NULL on purpose: a LIVE profile the customer never trashed, so
  // the existing trash sweeper can never reach it.
  await client`
    INSERT INTO profiles (id, account_id, name, archetype)
    VALUES (${profileId}, ${accountId}, 'retention-test', 'iphone17_ios18_7_safari26_4')`;
  await client`
    INSERT INTO profile_snapshots
      (id, account_id, parent_profile_id, label, parent_archetype, parent_name, state_blob)
    VALUES (${randomUUID()}, ${accountId}, ${profileId}, 'snap',
            'iphone17_ios18_7_safari26_4', 'retention-test',
            ${JSON.stringify({ cookies: 'secret' })}::jsonb)`;
  return { accountId, profileId };
}

function reposOf(): { profiles: DrizzleProfilesRepo; snapshots: DrizzleProfileSnapshotsRepo } {
  if (!client) throw new Error('no client');
  const handle = { client, db: null, close: async () => {} } as unknown as Database;
  return {
    profiles: new DrizzleProfilesRepo(handle),
    snapshots: new DrizzleProfileSnapshotsRepo(handle),
  };
}

async function counts(accountId: string): Promise<{ profiles: number; snapshots: number }> {
  const p = await client!<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM profiles WHERE account_id = ${accountId}::uuid`;
  const s = await client!<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM profile_snapshots WHERE account_id = ${accountId}::uuid`;
  return { profiles: p[0]?.n ?? 0, snapshots: s[0]?.n ?? 0 };
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'profiles and snapshots are erased 30 days after account termination',
  () => {
    const cutoff = (): Date => new Date(Date.now() - 30 * DAY_MS);

    it('CRITICAL the database was actually reached. Every assertion below is DB-backed, so a connection failure would return early from all of them and this file would report green while proving nothing about a deletion path.', () => {
      expect(dbReachable, `could not reach ${DB_URL} — these results would be meaningless`).toBe(
        true,
      );
    });

    it('CRITICAL a LIVE profile of an account terminated past the window is purged. The existing trash sweeper can never reach it — that one keys off the profile’s own deletedAt, and a profile the customer never trashed has none.', async () => {
      const { accountId, profileId } = await seedAccountWithProfile({
        status: 'deleted',
        deletedDaysAgo: 45,
      });
      const { profiles } = reposOf();

      const purged = await profiles.purgeForTerminatedAccountsBefore(cutoff());

      expect(purged, 'the purged ids come back for R2 blob cleanup').toContain(profileId);
      expect((await counts(accountId)).profiles).toBe(0);
    });

    it('CRITICAL snapshots are purged too, and by their OWN delete. parent_profile_id is ON DELETE SET NULL, so purging profiles leaves them behind with a null parent still holding the captured state — assuming they followed the profile is the mistake this case exists to catch.', async () => {
      const { accountId } = await seedAccountWithProfile({
        status: 'deleted',
        deletedDaysAgo: 45,
      });
      const { profiles, snapshots } = reposOf();

      // Purge profiles FIRST, then assert the snapshot is still there — that is
      // the SET NULL behaviour, stated as a fact rather than assumed away.
      await profiles.purgeForTerminatedAccountsBefore(cutoff());
      expect(
        (await counts(accountId)).snapshots,
        'deleting profiles does NOT cascade to snapshots',
      ).toBe(1);

      expect(await snapshots.purgeForTerminatedAccountsBefore(cutoff())).toBeGreaterThanOrEqual(1);
      expect((await counts(accountId)).snapshots).toBe(0);
    });

    it('CRITICAL an ACTIVE account keeps everything. This is the case that matters most: the purge deletes profiles that are perfectly live, so its only licence is the terminated status — and it must be incapable of acting without one.', async () => {
      const { accountId, profileId } = await seedAccountWithProfile({
        status: 'active',
        deletedDaysAgo: null,
      });
      const { profiles, snapshots } = reposOf();

      expect(await profiles.purgeForTerminatedAccountsBefore(cutoff())).not.toContain(profileId);
      expect(await snapshots.purgeForTerminatedAccountsBefore(cutoff())).toBe(0);
      expect(await counts(accountId)).toEqual({ profiles: 1, snapshots: 1 });
    });

    it('CRITICAL an account terminated INSIDE the window keeps everything. Erasing early destroys data the customer can still recover within the window we disclosed.', async () => {
      const { accountId, profileId } = await seedAccountWithProfile({
        status: 'deleted',
        deletedDaysAgo: 5,
      });
      const { profiles, snapshots } = reposOf();

      expect(await profiles.purgeForTerminatedAccountsBefore(cutoff())).not.toContain(profileId);
      expect(await snapshots.purgeForTerminatedAccountsBefore(cutoff())).toBe(0);
      expect(await counts(accountId)).toEqual({ profiles: 1, snapshots: 1 });
    });

    it('CRITICAL a tick is BOUNDED and successive ticks converge. Without a cap the first sweep against a backlog of long-terminated accounts deletes every matching row in one statement and issues one serial R2 delete per profile in the same tick — correct, but not something an operator can watch. The sweep is self-limiting, so the remainder drains next tick.', async () => {
      const { accountId } = await seedAccountWithProfile({
        status: 'deleted',
        deletedDaysAgo: 45,
      });
      // Four more profiles on the same terminated account, so one tick cannot
      // take them all at a cap of 2.
      for (let i = 0; i < 4; i += 1) {
        await client!`
          INSERT INTO profiles (id, account_id, name, archetype)
          VALUES (${randomUUID()}, ${accountId}, ${`extra-${i}`}, 'iphone17_ios18_7_safari26_4')`;
      }
      const { profiles } = reposOf();

      const first = await profiles.purgeForTerminatedAccountsBefore(cutoff(), 2);
      expect(first.length, 'the tick takes exactly its cap').toBe(2);
      expect((await counts(accountId)).profiles, 'the rest are left queued').toBe(3);

      const second = await profiles.purgeForTerminatedAccountsBefore(cutoff(), 2);
      expect(second.length, 'the next tick makes progress rather than stalling').toBe(2);
      expect((await counts(accountId)).profiles).toBe(1);

      // Drain what this case seeded. The purges are GLOBAL — they select every
      // terminated account, not one — so a terminated fixture left half-purged
      // is picked up by the next test's call and shows there as a phantom row.
      // That is how this case first failed: the suspended-account test counted a
      // snapshot this one had left behind.
      await profiles.purgeForTerminatedAccountsBefore(cutoff());
      await reposOf().snapshots.purgeForTerminatedAccountsBefore(cutoff());
    });

    it('CRITICAL a SUSPENDED account keeps everything. Suspension is reversible and is not termination; conflating them would destroy the profiles of an account that gets reinstated.', async () => {
      const { accountId, profileId } = await seedAccountWithProfile({
        status: 'suspended',
        deletedDaysAgo: 45,
      });
      const { profiles, snapshots } = reposOf();

      expect(await profiles.purgeForTerminatedAccountsBefore(cutoff())).not.toContain(profileId);
      expect(await snapshots.purgeForTerminatedAccountsBefore(cutoff())).toBe(0);
      expect(await counts(accountId)).toEqual({ profiles: 1, snapshots: 1 });
    });
  },
);
