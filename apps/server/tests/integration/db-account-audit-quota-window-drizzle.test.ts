// The count that decides whether a customer may import another profile.
//
// v8 coverage: `db/account-audit-repo.ts` has `insert` and `countActionsSince`
// at zero executed statements. `countActionsSince` is not a reporting helper —
// `services/profiles.ts` calls it on every profile import to enforce a monthly
// cap of 2× the tier ceiling, and throws TierLimitError when the count is at the
// cap. Its three filters are the whole of that decision, and each one fails into
// a different customer-visible lockout:
//
//   timestamp >= since   the billing-cycle window, computed as the 1st of the
//                        current month. Drop it and the count is every import
//                        the account has EVER made, so the quota never resets:
//                        a long-standing customer is permanently refused, and
//                        the error they read says they exceeded a limit "per
//                        billing cycle" while counting all time. Nothing about
//                        the message would point at the bug.
//   accountId            without it every account's imports are pooled, so one
//                        busy tenant locks out everybody else.
//   action               without it any audited activity at all — a login, a key
//                        rotation — consumes the import allowance.
//
// The boundary itself gets an arm because the comparison is `gte`, not `gt`: an
// import written exactly at the cycle boundary belongs to the new cycle. Off by
// one in that direction silently hands out an extra import each month, which is
// the harmless direction — but the same edit in reverse would drop a legitimate
// import from the count, and only an explicit boundary arm distinguishes them.
//
// Against a real Postgres because this is a COUNT under a composite predicate
// over a timestamptz, and because `insert` returns the row the audit trail is
// actually built from.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAccountAuditRepo } from '../../src/db/account-audit-repo.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const DAY = 24 * 60 * 60 * 1000;

let sql: ReturnType<typeof postgres> | null = null;
let repo: DrizzleAccountAuditRepo | null = null;
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
  sql = postgres(DB_URL, { max: 2 });
  try {
    await sql`SELECT action FROM account_audit_log LIMIT 0`;
    dbReachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  repo = new DrizzleAccountAuditRepo({ db: drizzle(sql) } as unknown as never);
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
    VALUES (${id}, ${`audit-${id}@test.local`}, 'active')`;
  seeded.push(id);
  return id;
}

/** Rows land via the repo; `timestamp` defaults to now, so age is set after. */
async function record(
  accountId: string,
  action: 'profile.imported' | 'profile.created',
  agoMs = 0,
): Promise<string> {
  const row = await repo!.insert({
    accountId,
    actorType: 'customer',
    actorAccountId: accountId,
    action,
    targetResourceId: `prof_${randomUUID()}`,
  });
  if (agoMs > 0) {
    await sql!`UPDATE account_audit_log
                  SET timestamp = ${new Date(Date.now() - agoMs).toISOString()}::timestamptz
                WHERE id = ${row.id}`;
  }
  return row.id;
}

describe('account audit quota counting', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL an inserted entry comes back as written', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const row = await repo.insert({
      accountId,
      actorType: 'customer',
      actorAccountId: accountId,
      action: 'profile.imported',
      targetResourceId: 'prof_abc',
      payload: { source: 'backup' },
      ipAddress: '203.0.113.7',
      userAgent: 'integration-test',
    });
    expect(row.accountId).toBe(accountId);
    expect(row.action).toBe('profile.imported');
    expect(row.targetResourceId).toBe('prof_abc');
    expect(row.payload, 'the audit payload did not survive the jsonb round-trip').toEqual({
      source: 'backup',
    });
    expect(row.timestamp, 'the entry was written without a timestamp').toBeInstanceOf(Date);
  });

  it('CRITICAL optional actor fields default to null rather than undefined', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const row = await repo.insert({
      accountId,
      actorType: 'system',
      action: 'profile.imported',
    });
    expect(row.actorAccountId).toBeNull();
    expect(row.actorKeyId).toBeNull();
    expect(row.payload).toBeNull();
  });

  it('CRITICAL only entries inside the window are counted', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    await record(accountId, 'profile.imported', 60 * DAY); // a previous cycle
    await record(accountId, 'profile.imported', 60 * DAY);
    await record(accountId, 'profile.imported'); // this cycle
    expect(
      await repo.countActionsSince(accountId, 'profile.imported', new Date(Date.now() - 30 * DAY)),
      'imports from earlier billing cycles were counted against this one. The cap would never ' +
        'reset, so a long-standing customer is permanently refused by a limit that says "per ' +
        'billing cycle"',
    ).toBe(1);
  });

  it('CRITICAL the window boundary itself counts as inside', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const id = await record(accountId, 'profile.imported');
    const [row] = await sql!<{ ts: string }[]>`
      SELECT timestamp::text AS ts FROM account_audit_log WHERE id = ${id}`;
    // `since` set to the row's own instant: gte counts it, gt would not.
    expect(
      await repo.countActionsSince(accountId, 'profile.imported', new Date(row!.ts)),
      'an entry written exactly at the cycle boundary was excluded — the comparison is gte, and ' +
        'flipping it drops a legitimate import from the count',
    ).toBe(1);
  });

  it('CRITICAL another account’s activity never counts against this one', async () => {
    if (!dbReachable || !repo) return;
    const mine = await seedAccount();
    const theirs = await seedAccount();
    await record(theirs, 'profile.imported');
    await record(theirs, 'profile.imported');
    expect(
      await repo.countActionsSince(mine, 'profile.imported', new Date(Date.now() - 30 * DAY)),
      'one account’s imports counted against another’s quota — a busy tenant would lock out ' +
        'everyone else',
    ).toBe(0);
  });

  it('CRITICAL a different action never consumes the import allowance', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    await record(accountId, 'profile.created');
    await record(accountId, 'profile.created');
    expect(
      await repo.countActionsSince(accountId, 'profile.imported', new Date(Date.now() - 30 * DAY)),
      'unrelated audited activity consumed the profile-import quota',
    ).toBe(0);
  });

  it('CRITICAL an account with no matching entries counts zero, not null', async () => {
    if (!dbReachable || !repo) return;
    expect(
      await repo.countActionsSince(randomUUID(), 'profile.imported', new Date(Date.now() - DAY)),
    ).toBe(0);
  });
});
