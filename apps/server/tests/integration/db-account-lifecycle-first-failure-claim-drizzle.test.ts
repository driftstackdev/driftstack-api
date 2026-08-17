// Claiming the right to send a lifecycle email, exactly once.
//
// v8 coverage: `db/account-lifecycle-repo.ts` is the lowest-covered repo at
// 33.3% of lines, and `findForLifecycle` and `markFirstFailureEmailSent`
// execute zero statements in the suite. `markFirstSuccessEmailSent` beside them
// is exercised; the failure twin never was.
//
// `markFirstFailureEmailSent` is not a setter, it is a CLAIM:
//
//   UPDATE accounts SET first_failure_email_sent_at = $at
//    WHERE id = $id AND first_failure_email_sent_at IS NULL
//   RETURNING id
//
// and the caller sends the email only when it returns true. The `IS NULL` is
// therefore the whole send-once guarantee. Drop it and the row updates every
// time, the claim always succeeds, and a customer whose first session failed
// receives that email again on every lifecycle evaluation — the kind of bug
// that reaches an inbox rather than a log.
//
// Two arms exist that a single-threaded reading would not suggest:
//
//   concurrency   two simultaneous claims must yield exactly ONE true. That is
//                 the property the conditional UPDATE buys over a
//                 read-then-write, and it only shows against a real database
//                 with real row locking.
//   independence  the failure and success markers are separate columns on the
//                 same row. Claiming one must not stamp the other, or a
//                 customer's first FAILURE would silently consume their first
//                 SUCCESS email — an onboarding message nobody ever gets.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAccountLifecycleRepo } from '../../src/db/account-lifecycle-repo.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let sql: ReturnType<typeof postgres> | null = null;
let repo: DrizzleAccountLifecycleRepo | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  // max > 1 so the concurrent-claim arm races two real backends rather than
  // queueing on one pooled connection.
  sql = postgres(DB_URL, { max: 4 });
  try {
    await sql`SELECT first_failure_email_sent_at FROM accounts LIMIT 0`;
    dbReachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  repo = new DrizzleAccountLifecycleRepo({ db: drizzle(sql) } as unknown as never);
});

afterAll(async () => {
  if (sql && seeded.length > 0) {
    await sql`DELETE FROM accounts WHERE id = ANY(${sql.array(seeded)}::uuid[])`.catch(
      () => undefined,
    );
  }
  await sql?.end({ timeout: 2 }).catch(() => undefined);
});

async function seedAccount(): Promise<string> {
  const id = randomUUID();
  await sql!`
    INSERT INTO accounts (id, email, status)
    VALUES (${id}, ${`lifecycle-${id}@test.local`}, 'active')`;
  seeded.push(id);
  return id;
}

async function readMarkers(
  id: string,
): Promise<{ first_failure_email_sent_at: Date | null; first_success_email_sent_at: Date | null }> {
  const [row] = await sql!<
    { first_failure_email_sent_at: Date | null; first_success_email_sent_at: Date | null }[]
  >`SELECT first_failure_email_sent_at, first_success_email_sent_at FROM accounts WHERE id = ${id}`;
  return row!;
}

describe('first-failure lifecycle email claim', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL a fresh account reads with both markers unset', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const row = await repo.findForLifecycle(accountId);
    expect(row?.id).toBe(accountId);
    expect(row?.firstFailureEmailSentAt).toBeNull();
    expect(row?.firstSuccessEmailSentAt).toBeNull();
  });

  it('CRITICAL an unknown account reads as null', async () => {
    if (!dbReachable || !repo) return;
    expect(await repo.findForLifecycle(randomUUID())).toBeNull();
  });

  it('CRITICAL the claim succeeds once and refuses every time after', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const at = new Date();
    expect(await repo.markFirstFailureEmailSent(accountId, at), 'the first claim was refused').toBe(
      true,
    );
    expect(
      await repo.markFirstFailureEmailSent(accountId, new Date(at.getTime() + 60_000)),
      'the claim succeeded twice — the caller sends on true, so this customer receives the same ' +
        'lifecycle email again on every evaluation',
    ).toBe(false);
    const row = await readMarkers(accountId);
    expect(row.first_failure_email_sent_at, 'a successful claim left no timestamp').not.toBeNull();
  });

  it('CRITICAL two simultaneous claims yield exactly one winner', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const at = new Date();
    const results = await Promise.all([
      repo.markFirstFailureEmailSent(accountId, at),
      repo.markFirstFailureEmailSent(accountId, at),
    ]);
    expect(
      results.filter(Boolean).length,
      'both racing claims won — two lifecycle emails for one event. The conditional UPDATE is ' +
        'what makes this safe; a read-then-write would not be',
    ).toBe(1);
  });

  it('CRITICAL claiming the failure email does not consume the success email', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    await repo.markFirstFailureEmailSent(accountId, new Date());
    const row = await readMarkers(accountId);
    expect(
      row.first_success_email_sent_at,
      'claiming the first-failure email stamped the first-success column too — the onboarding ' +
        'message for that customer would never be sent',
    ).toBeNull();
    // …and the success claim is still available.
    expect(await repo.markFirstSuccessEmailSent(accountId, new Date())).toBe(true);
  });
});
