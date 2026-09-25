// A sealed profile blob no profile owns is swept by the daily purge — against a
// real database, through the real scheduler.
//
// The unit arms (tests/unit/a-profile-blob-no-profile-owns-is-swept-by-the-daily-purge)
// prove the reaper's rules against a fake existence check. Two things only a
// database can prove:
//   • the existence query is soft-delete INCLUSIVE — a trashed profile still
//     owns its blob. That is one missing `WHERE deleted_at IS NULL` away from
//     deleting the encrypted browser state of every profile in the recycle bin;
//   • the sweep runs as part of the account-deletion purge the scheduler fires
//     from the scheduled_jobs table, so it survives restarts, and re-arms itself
//     for the next day. The in-process timer it replaces started over on every
//     deploy and may never have fired.
//
// The bucket is a fake: nothing here reaches R2.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import { DrizzleProfilesRepo } from '../../src/db/profiles-repo.js';
import { DrizzleScheduledJobsRepo } from '../../src/db/scheduled-jobs-repo.js';
import {
  ACCOUNT_DELETION_PURGE_JOB_TYPE,
  AccountDeletionPurgeSweeperService,
  enqueueNextAccountDeletionPurge,
  registerAccountDeletionPurgeJob,
} from '../../src/services/account-deletion-purge-sweeper.js';
import { ProfileBlobOrphanReaper } from '../../src/services/profile-blob-orphan-reaper.js';
import { ScheduledJobsService } from '../../src/services/scheduled-jobs.js';
import { profileSealedBlobKey, type R2 } from '../../src/lib/r2.js';
import type { Logger } from '../../src/lib/logger.js';
import type * as schema from '../../src/db/schema.js';

// Its own database: the purge job is a GLOBAL singleton chain (one pending row
// per job type), and this file deletes and re-enqueues it.
const ISOLATED_DB_NAME = 'driftstack_iso_profile_blob_orphans';
const HOUR_MS = 60 * 60 * 1000;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let accountId = '';
const LIVE = randomUUID();
const TRASHED = randomUUID();
const ORPHAN = randomUUID();
const YOUNG_ORPHAN = randomUUID();

beforeAll(async () => {
  const url = await ensureIsolatedDatabase(ISOLATED_DB_NAME);
  if (url === null) return;
  const probe = postgres(url, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM profiles LIMIT 0`;
    await probe`SELECT 1 FROM scheduled_jobs LIMIT 0`;
    dbReachable = true;
  } catch {
    return;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => {});
  }
  client = postgres(url, { max: 2 });
  // A previous run's chain would satisfy the dedup and keep its own run_at.
  await client`DELETE FROM scheduled_jobs WHERE job_type = ${ACCOUNT_DELETION_PURGE_JOB_TYPE}`;
  accountId = randomUUID();
  await client`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`blob-orphans-${accountId}@test.local`})`;
  await client`INSERT INTO profiles (id, account_id, name) VALUES (${LIVE}, ${accountId}, 'live')`;
  await client`
    INSERT INTO profiles (id, account_id, name, deleted_at)
    VALUES (${TRASHED}, ${accountId}, 'trashed', ${new Date(Date.now() - 10 * 24 * HOUR_MS).toISOString()})`;
});

afterAll(async () => {
  if (client) {
    await client`DELETE FROM scheduled_jobs WHERE job_type = ${ACCOUNT_DELETION_PURGE_JOB_TYPE}`.catch(
      () => {},
    );
    await client`DELETE FROM profiles WHERE account_id = ${accountId}`.catch(() => {});
    await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    await client.end({ timeout: 5 });
  }
});

function database() {
  const db = drizzle(client!) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return { client: client!, db, close: async () => {} };
}

/** The private bucket, holding one sealed blob per uuid, each written at `writtenAt`. */
function bucket(blobs: Record<string, Date>) {
  const objects = new Map(Object.entries(blobs).map(([id, at]) => [profileSealedBlobKey(id), at]));
  const deleted: string[] = [];
  const r2 = {
    bucket: 'private',
    listObjects: (prefix: string) =>
      Promise.resolve(
        [...objects.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, lastModified]) => ({ key, lastModified })),
      ),
    deleteObject: (key: string) => {
      deleted.push(key);
      objects.delete(key);
      return Promise.resolve();
    },
  } as unknown as R2;
  return { r2, deleted, keys: () => [...objects.keys()].sort() };
}

const quiet = { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'a profile blob no profile owns is swept by the daily purge (real Postgres, real scheduler)',
  () => {
    it('CRITICAL the database was reached and migrated. Every arm below returns early without it, and would otherwise report green having proved nothing.', () => {
      expect(dbReachable, `could not reach ${ISOLATED_DB_NAME}`).toBe(true);
    });

    it('CRITICAL the existence check counts a TRASHED profile as owning its blob, and an absent one as not', async () => {
      if (!dbReachable) return;
      const found = await new DrizzleProfilesRepo(database()).findExistingProfileIds([
        LIVE,
        TRASHED,
        ORPHAN,
      ]);
      expect([...found].sort()).toEqual([LIVE, TRASHED].sort());
    });

    it('CRITICAL the scheduled daily purge sweeps the orphan past its grace, keeps the live and trashed profiles’ blobs and the young orphan, re-arms for the next day, and a second pass changes nothing', async () => {
      if (!dbReachable) return;
      const firstRun = new Date('2026-07-10T05:00:00.000Z');
      let clock = firstRun.getTime() - 2 * HOUR_MS;
      const store = bucket({
        [LIVE]: new Date(firstRun.getTime() - 30 * HOUR_MS),
        [TRASHED]: new Date(firstRun.getTime() - 30 * HOUR_MS),
        [ORPHAN]: new Date(firstRun.getTime() - 30 * HOUR_MS),
        [YOUNG_ORPHAN]: new Date(firstRun.getTime() - 2 * HOUR_MS),
      });
      const sweeper = new AccountDeletionPurgeSweeperService({
        repo: { findDeletedAccountIdsWithByokKeyBefore: () => Promise.resolve([]) },
        profileBlobOrphans: new ProfileBlobOrphanReaper(
          store.r2,
          new DrizzleProfilesRepo(database()),
        ),
      });
      const scheduler = new ScheduledJobsService(new DrizzleScheduledJobsRepo(database()), quiet, {
        workerId: 'profile-blob-orphans-test',
      });
      registerAccountDeletionPurgeJob({
        scheduledJobs: scheduler,
        sweeper,
        logger: quiet,
        nowFn: () => clock,
      });
      await enqueueNextAccountDeletionPurge({ scheduledJobs: scheduler, nowFn: () => clock });

      const pending = async (): Promise<string[]> =>
        (
          await client!<Array<{ run_at: Date }>>`
            SELECT run_at FROM scheduled_jobs
             WHERE job_type = ${ACCOUNT_DELETION_PURGE_JOB_TYPE}
               AND completed_at IS NULL AND failed_at IS NULL
             ORDER BY run_at`
        ).map((r) => new Date(r.run_at).toISOString());
      expect(await pending()).toEqual([firstRun.toISOString()]);

      // Not due yet: nothing runs, nothing is deleted.
      expect((await scheduler.processTick(new Date(clock))).processed).toBe(0);
      expect(store.deleted).toEqual([]);

      clock = firstRun.getTime() + 30_000;
      expect((await scheduler.processTick(new Date(clock))).processed).toBe(1);
      expect(store.deleted).toEqual([profileSealedBlobKey(ORPHAN)]);
      expect(store.keys()).toEqual(
        [LIVE, TRASHED, YOUNG_ORPHAN].map((id) => profileSealedBlobKey(id)).sort(),
      );
      const nextDay = new Date(firstRun.getTime() + 24 * HOUR_MS);
      expect(await pending(), 'the chain re-armed for the next day').toEqual([
        nextDay.toISOString(),
      ]);

      // Idempotent: the same pass again finds nothing more to do.
      await expect(sweeper.tickOnce(new Date(clock))).resolves.toMatchObject({
        profileBlobOrphansReaped: 0,
      });
      expect(store.deleted).toEqual([profileSealedBlobKey(ORPHAN)]);

      // A day later the young orphan is past its grace and goes; the owned blobs stay.
      clock = nextDay.getTime() + 30_000;
      expect((await scheduler.processTick(new Date(clock))).processed).toBe(1);
      expect(store.deleted).toEqual([ORPHAN, YOUNG_ORPHAN].map((id) => profileSealedBlobKey(id)));
      expect(store.keys()).toEqual([LIVE, TRASHED].map((id) => profileSealedBlobKey(id)).sort());
    });
  },
);
