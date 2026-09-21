// A turn that is still running is not a task the keeper had to finish.
//
// §8 step 3 reads two of its exit criteria as ZEROES: nothing lost, and "100%
// of orphaned reservations settled within the lease". The shadow report's
// `tasksNotClosedByTheTurn` is where the second one is read from — its whole
// reason for existing is that a lost measurement leaves no row, so the two
// shapes that DO leave evidence have to carry it.
//
// ⛔ AND A TURN IN FLIGHT LEAVES THE SAME EVIDENCE AS AN ORPHAN, UNLESS THE
// QUERY SAYS OTHERWISE. A task is `state='open'` with `settle_reason IS NULL`
// from the moment it is reserved until the route's `finally` settles it, so a
// column that asks only "is the reason something other than completed" counts
// every turn that happens to be running when the operator opens the page. The
// report's default window ends at `now()`, so on a deployment serving traffic
// that criterion could never read zero — and a criterion that cannot be met is
// indistinguishable, on the page, from one that is being missed.
//
// So the subject here is the DIFFERENCE between the two open-ended endings:
//
//   · a task still running has not been closed by anybody yet, and is not
//     evidence of anything — it is counted among `tasks` and nowhere else;
//   · a task the KEEPER closed (`lease_expired`) is exactly what the criterion
//     is about, and must still be counted.
//
// The second arm is what stops the first from being satisfied by a column that
// is always zero.
//
// ⛔ ITS OWN ISOLATED DATABASE, for the reason the sibling report files give:
// the report groups by DAY and MODEL, `created_at` is immutable by trigger, and
// every arm in a file runs on the same day. Two arms sharing a model would
// assert each other's sums.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreditCallBound } from '../../src/db/credit-reservations-repo.js';
import { DrizzleAiCreditsReportRepo } from '../../src/db/ai-credits-report-repo.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  ON_CREDITS_MODEL,
  fundedTaskLot,
  newTaskAccount,
  reservationsHarness,
  type ReservationsHarness,
} from './_helpers/credit-reservation-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_open_tasks';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const BOOT = 'boot-open-tasks';

/** One arm per model — see the header. Both are priced by the launch card. */
const STILL_RUNNING_MODEL = ON_CREDITS_MODEL;
const KEEPER_CLOSED_MODEL = 'claude-haiku-4-5';

/** Generous: what is under test is which tasks are counted, not the fit ladder. */
const BOUND: CreditCallBound = {
  inputBoundTokens: 4_096,
  inputBoundMicro: 4_096 * 800,
  maxOutputTokens: 1_024,
  boundMicro: 4_096 * 800 + 1_024 * 2_000,
  basis: 'region_bytes',
};

let client: postgres.Sql | null = null;
let harness: ReservationsHarness | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const db = await openLedgerDatabase(ISOLATED_DB_NAME, 4);
  if (db === null) return;
  client = db.sql;
  harness = reservationsHarness(db.url, { max: 3 });
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await harness?.database.close().catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function h(): ReservationsHarness {
  if (harness === null) throw new Error('isolated database unreachable');
  return harness;
}

/** A window that holds everything this file writes, ending in the future. */
function window(): { since: Date; until: Date } {
  const until = new Date(Date.now() + 60 * 60 * 1000);
  return { since: new Date(until.getTime() - 3 * 24 * 60 * 60 * 1000), until };
}

/** One shadow task with one admitted, sent call on it — a turn mid-flight. */
async function turnInFlight(model: string): Promise<string> {
  const accountId = await newTaskAccount(db());
  await fundedTaskLot(db(), accountId, { credits: 100 });
  const reservationId = randomUUID();
  const reserved = await h().service.reserve({
    accountId,
    reservationId,
    agentSessionId: `as_${reservationId}`,
    idempotencyKey: null,
    model,
    mode: 'shadow',
    bootId: BOOT,
  });
  if (reserved.outcome !== 'shadowed') {
    throw new Error(`the fixture could not measure: ${JSON.stringify(reserved)}`);
  }
  const callId = randomUUID();
  const admitted = await h().service.admitCall({
    reservationId,
    purpose: 'plan',
    model,
    bound: BOUND,
    callId,
  });
  if (admitted.outcome !== 'admitted') {
    throw new Error(`the fixture could not admit: ${JSON.stringify(admitted)}`);
  }
  await h().service.markSent(callId);
  return reservationId;
}

async function rowFor(model: string) {
  const report = new DrizzleAiCreditsReportRepo(h().database);
  return (await report.shadowReport(window())).rows.find((r) => r.model === model);
}

describe.skipIf(!RUN_DB_TESTS)('a turn that is still running', () => {
  it('CRITICAL is NOT counted as a task the lease keeper had to finish. It is `state=open` with no settle reason, exactly like a task nobody ever came back for, and the report’s window ends at now() — so a column that reads only the reason counts every turn in flight when the page is opened, and the §8 criterion it feeds could never read zero on a deployment that is serving anybody.', async () => {
    const before = await rowFor(STILL_RUNNING_MODEL);
    await turnInFlight(STILL_RUNNING_MODEL);

    const after = await rowFor(STILL_RUNNING_MODEL);

    // It is a task, and it is in the report.
    expect((after?.tasks ?? 0) - (before?.tasks ?? 0)).toBe(1);
    // It is not yet evidence of anything: nobody has failed to close it.
    expect(after?.tasksNotClosedByTheTurn).toBe(0);
  });

  it('CRITICAL while a task the KEEPER closed still is. `lease_expired` is the ending the criterion is about — the route never settled and the sweep had to — and a fix that made the column read zero for an open task must not make it read zero for this one.', async () => {
    const reservationId = await turnInFlight(KEEPER_CLOSED_MODEL);
    // What the keeper does to a task whose process stopped renewing it.
    const settled = await h().service.settle(reservationId, 'lease_expired');
    expect(settled.outcome).toBe('settled');

    const row = await rowFor(KEEPER_CLOSED_MODEL);

    expect(row?.tasks).toBe(1);
    expect(row?.tasksNotClosedByTheTurn).toBe(1);
  });
});
