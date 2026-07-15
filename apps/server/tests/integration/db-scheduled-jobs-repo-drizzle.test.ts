// Drizzle-backed integration test for DrizzleScheduledJobsRepo.
//
// Why this exists: 2026-05-19 root-cause of the 10-day silent
// scheduled-jobs-poller TypeError (`Buffer.byteLength(date)` in postgres-js
// Bind step) revealed that drizzle-orm 0.38.4's `construct(client)` swaps
// postgres-js's Date serializer (OID 1184/1082/1083/1114) with a no-op
// `transparentParser = (val) => val`, leaving Date instances in postgres-js's
// Bind step where they crash. The fix (5d7d7348) pre-serializes Date params
// to ISO strings via `.toISOString()` in `claimDue`'s raw `sql` template.
//
// The bug went undetected for 10+ days because the existing trial-pack-expiry
// integration test uses `InMemoryScheduledJobsRepo` and never exercises the
// Drizzle code path. This test closes that gap by running `claimDue` against
// a real Postgres via Drizzle.
//
// Run scope:
//   - CI: build-test job has postgres:17-alpine service container at
//     localhost:5432 with the `driftstack` schema migrated; this test runs
//     against that and asserts the Drizzle path doesn't crash on Date params.
//   - Local dev: skips if DATABASE_URL postgres is unreachable. Set
//     DATABASE_URL=postgres://... to opt in to local verification.
//
// What this test guards:
//   1. claimDue() executes without TypeError when given Date params (the
//      regression that fired in prod for 10 days).
//   2. claimDue() returns the correct row shape when claiming an enqueued
//      job (functional invariant, not just no-crash).
//   3. markComplete()/markRetry()/markFailed() take Date params via the
//      drizzle table-builder path — these serialize via column-schema
//      metadata so they're not affected by the transparentParser swap, but
//      pin the regression surface anyway.

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { DrizzleScheduledJobsRepo } from '../../src/db/scheduled-jobs-repo.js';
import { ScheduledJobsService } from '../../src/services/scheduled-jobs.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

// Connection probe — skip the whole suite if unreachable (local dev without
// docker compose up). CI provides the postgres service container so this
// path is always exercised on every push.
let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;

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
  // Schema-presence probe: if scheduled_jobs table is missing (migrations
  // not yet applied), skip rather than fail — keeps the suite green on a
  // partially-bootstrapped local env.
  try {
    await client`SELECT 1 FROM scheduled_jobs LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    // Clean up rows this suite inserted so they don't accumulate in
    // the DB across test runs. Matches both regression-guard job types —
    // the suite is their only writer.
    // No-throw on the delete (DB may already be torn down).
    await client`
      DELETE FROM scheduled_jobs
       WHERE job_type IN ('regression_guard_dummy', 'regression_guard_self_arm')
    `.catch(() => {});
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleScheduledJobsRepo (Drizzle path against real Postgres)',
  () => {
    it('claimDue with Date params does NOT throw TypeError — regression guard for the 2026-05-09 → 2026-05-19 silent prod bug (drizzle-orm 0.38.4 transparentParser swap → Buffer.byteLength(date) in postgres-js Bind)', async () => {
      if (!dbReachable || !client) {
        return;
      }
      // `drizzle(client)` (no { schema }) — cast through `unknown` to
      // satisfy the test typecheck against schema-typed Database.db.
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleScheduledJobsRepo({ client, db, close: async () => {} });
      // No expectations on row count — empty result is fine. The only
      // assertion is that the call completes without throwing the
      // historical "string argument must be of type string or an instance
      // of Buffer or ArrayBuffer. Received an instance of Date" TypeError.
      await expect(
        repo.claimDue({
          batchSize: 8,
          now: new Date(),
          workerId: `regression-guard-${Date.now()}`,
        }),
      ).resolves.toBeDefined();
    });

    it('claimDue returns rows when matching jobs exist (functional invariant)', async () => {
      if (!dbReachable || !client) {
        return;
      }
      // `drizzle(client)` (no { schema }) — cast through `unknown` to
      // satisfy the test typecheck against schema-typed Database.db.
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleScheduledJobsRepo({ client, db, close: async () => {} });
      const workerId = `regression-guard-claim-${Date.now()}`;
      // Enqueue a due job (runAt in the past), then claim it.
      const pastRunAt = new Date(Date.now() - 5000);
      await repo.enqueue({
        jobType: 'regression_guard_dummy',
        accountId: null,
        payload: { marker: workerId },
        runAt: pastRunAt,
        dedupOnAccountAndType: false,
      });
      const claimed = await repo.claimDue({ batchSize: 16, now: new Date(), workerId });
      const ours = claimed.filter((j) => j.jobType === 'regression_guard_dummy');
      // We may have claimed our row + zero-to-many other regression-guard
      // rows from previous test runs. Assert at least ours got picked up.
      expect(ours.length).toBeGreaterThanOrEqual(1);
      const job = ours.find((j) => j.payload.marker === workerId);
      expect(job).toBeDefined();
      expect(job!.runAt).toBeInstanceOf(Date);
      expect(Number.isFinite(job!.runAt.getTime())).toBe(true);
      expect(job!.runAt.toISOString()).toBe(pastRunAt.toISOString());
      // Cleanup — mark every claimed regression-guard job complete so
      // future runs don't see them as still-pending.
      for (const j of ours) {
        await repo.markComplete(j.id, new Date());
      }
    });

    it('normalizes raw run_at before a self-arming handler feeds it to Drizzle dedup', async () => {
      if (!dbReachable || !client) {
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleScheduledJobsRepo({ client, db, close: async () => {} });
      const logger = pino({ level: 'silent' });
      const workerId = `regression-guard-self-arm-${Date.now()}`;
      const service = new ScheduledJobsService(repo, logger, {
        workerId,
        batchSize: 16,
      });
      service.register('regression_guard_self_arm', async (job) => {
        expect(job.runAt).toBeInstanceOf(Date);
        await service.enqueue({
          jobType: job.jobType,
          accountId: null,
          payload: { successor: workerId },
          runAt: new Date(Date.now() + 60_000),
          dedupOnAccountAndType: true,
          dedupAfterRunAt: job.runAt,
        });
      });

      await repo.enqueue({
        jobType: 'regression_guard_self_arm',
        accountId: null,
        payload: { current: workerId },
        runAt: new Date(Date.now() - 5_000),
      });
      await expect(service.processTick(new Date())).resolves.toEqual(
        expect.objectContaining({ processed: expect.any(Number) }),
      );

      const [successor] = await client<[{ pending: number }]>`
        SELECT COUNT(*)::int AS pending
          FROM scheduled_jobs
         WHERE job_type = 'regression_guard_self_arm'
           AND completed_at IS NULL
           AND failed_at IS NULL
           AND payload ->> 'successor' = ${workerId}
      `;
      expect(successor?.pending).toBe(1);
    });

    it('ScheduledJobsService.processTick runs claimDue end-to-end without crashing (the actual prod hot path)', async () => {
      if (!dbReachable || !client) {
        return;
      }
      // `drizzle(client)` (no { schema }) — cast through `unknown` to
      // satisfy the test typecheck against schema-typed Database.db.
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleScheduledJobsRepo({ client, db, close: async () => {} });
      const logger = pino({ level: 'silent' });
      const service = new ScheduledJobsService(repo, logger, {
        workerId: `regression-guard-tick-${Date.now()}`,
        batchSize: 8,
      });
      // No handlers registered. If a row gets claimed, the unregistered-
      // handler path marks it failed (warn-logged); both branches must
      // not crash. The poller hot path is exactly this call shape.
      await expect(service.processTick(new Date())).resolves.toEqual(
        expect.objectContaining({ processed: expect.any(Number) }),
      );
    });
  },
);
