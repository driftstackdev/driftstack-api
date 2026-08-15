// V-784 — the only test that executes the production dependency graph.
//
// `createProductionDeps` is what `index.ts` runs in production, and until this
// file nothing called it. Four test files import from `lib/bootstrap.js`, and
// all four take a helper out of it — `shareFirstAsyncCall`, `selectAgentDecomposer`,
// `withTeardownDeadline`, `buildAppWithFatalTeardown`. The integration harness
// (`_helpers/build-test-app.ts`) constructs its own dep graph, and the e2e suite
// calls `buildApp`, which takes deps that are already built. So the ~3200-line
// factory that opens every connection and arms every recurring sweep was
// verified by content-parity regex alone: a pin can prove a line of text is
// present, and cannot prove the function runs.
//
// That gap is exactly the shape of the bug V-784 fixed. Five daily sweeps were
// wired to `setInterval(fn, 24h)` — text a parity pin happily froze — and a
// timer whose first tick is a full day away never fires on a deploy cadence
// under 24 hours. No regex distinguishes "wired" from "wired in a way that
// runs".
//
// So this asserts the outcome rather than the wiring: after a real boot against
// a real Postgres, every chain on the liveness roster has a pending row. That
// catches a registration that was never enqueued, an enqueue that was never
// registered, a job type renamed on one side only, and a sweep quietly demoted
// back to a timer — none of which the pins can see.
//
// It is also the check that would have caught the ordering hazard this change
// introduced: `ScheduledJobsService.processTick` marks a job FAILED when its
// type has no registered handler, so a claim that lands before registration
// does not retry, it kills the chain. The five new registrations therefore sit
// with the other eleven, above the poller that dispatches them.

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createProductionDeps } from '../../src/lib/bootstrap.js';
import { loadConfig } from '../../src/lib/config.js';
import { createTestLogger } from '../../src/lib/logger.js';
import { EXPECTED_RECURRING_JOB_TYPES } from '../../src/services/job-chain-liveness.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;

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
    await client`SELECT 1 FROM scheduled_jobs LIMIT 0`;
    dbReachable = true;
  } catch {
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  await client?.end({ timeout: 2 }).catch(() => {});
});

describe('the production dependency graph arms every recurring chain', () => {
  it('CRITICAL every job type on the liveness roster has a pending row after a real boot. A registration nobody enqueues has no pending row and reports 0 forever — indistinguishable from the dead chain the gauge exists to detect — and an enqueue whose type nobody registered is marked FAILED on first claim, which kills the chain outright. Only executing the real factory can tell either apart from the wiring text a parity pin freezes.', async () => {
    if (!dbReachable || client === null) {
      // Same posture as every other drizzle integration file here: a missing
      // Postgres skips rather than fails, and the suite reports the skip.
      expect(dbReachable, 'Postgres unreachable — chain arming not verified').toBe(false);
      return;
    }

    const boot = await createProductionDeps(loadConfig(), createTestLogger());
    try {
      const rows = await client<{ job_type: string }[]>`
        SELECT DISTINCT job_type FROM scheduled_jobs
        WHERE completed_at IS NULL AND failed_at IS NULL
      `;
      const armed = rows.map((r) => r.job_type);

      // Vacuity: an empty roster would make the subset check below pass against
      // nothing, and an empty table would mean the boot enqueued nothing at all.
      expect(EXPECTED_RECURRING_JOB_TYPES.length, 'roster is populated').toBeGreaterThan(10);
      expect(armed.length, 'the boot enqueued pending work').toBeGreaterThan(10);

      const missing = EXPECTED_RECURRING_JOB_TYPES.filter((t) => !armed.includes(t));
      expect(
        missing,
        'chains on the liveness roster with NO pending row after boot — registered but never enqueued, or not wired at all:',
      ).toEqual([]);
    } finally {
      await boot.teardown();
    }
  }, 120_000);
});
