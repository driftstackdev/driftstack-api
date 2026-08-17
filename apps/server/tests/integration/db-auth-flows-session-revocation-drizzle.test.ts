// Signing out everywhere, and the MFA flag that must not travel with it.
//
// v8 coverage: three auth-critical methods on `auth-flows-repo.ts` execute zero
// statements, and in each case a close sibling IS exercised — which is exactly
// how they stayed invisible:
//
//   revokeAllWebSessionsForAccount   "sign out on all devices". The sibling
//                                    revokeAllWebSessionsExcept (keep this one)
//                                    is covered; the one that keeps NOTHING is
//                                    not. It is what runs after a password
//                                    change or a reported compromise, so a
//                                    session it misses is an attacker who stays
//                                    signed in through the event meant to evict
//                                    them.
//   markWebSessionMfaSatisfied       has no behavioural coverage anywhere — not
//                                    even against the in-memory double. Its only
//                                    mentions in the test tree are that double
//                                    and two source-text pins.
//   consumeAuthToken                 single-token claim. consumeAuthTokenFamily
//                                    beside it is covered; this one is not.
//
// The MFA arm is the one that would not occur to a reader of the diff. The
// UPDATE is scoped by session id ALONE, which is correct: satisfying MFA is a
// property of the browser session that just passed the challenge. Scope it by
// account instead — an entirely reasonable-looking "fix" — and passing MFA once
// silently satisfies it on every OTHER live session for that account, including
// one an attacker opened. Nothing in the suite would have noticed.
//
// Sessions are minted and read back through insertWebSession /
// findActiveWebSession, both already exercised, so revocation is observed on the
// same path authentication actually uses rather than by re-reading the column
// this code just wrote.
//
// Against a real Postgres: every method here is a conditional UPDATE whose
// `isNull(...)` clause decides both what changes and what the returned count
// claims, and the concurrency arm needs real row locking.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAuthFlowsRepo } from '../../src/db/auth-flows-repo.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const HOUR = 60 * 60 * 1000;

let sql: ReturnType<typeof postgres> | null = null;
let repo: DrizzleAuthFlowsRepo | null = null;
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
    await sql`SELECT mfa_satisfied_at FROM web_sessions LIMIT 0`;
    dbReachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  repo = new DrizzleAuthFlowsRepo({ db: drizzle(sql) } as unknown as never);
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
    VALUES (${id}, ${`authsess-${id}@test.local`}, 'active')`;
  seeded.push(id);
  return id;
}

/** Minted through the real path so the account/epoch authority holds. */
async function openSession(accountId: string): Promise<{ id: string; tokenHash: string }> {
  const tokenHash = `sess-${randomUUID()}`;
  const row = await repo!.insertWebSession({
    accountId,
    tokenHash,
    authEpoch: 0,
    expiresAt: new Date(Date.now() + 24 * HOUR),
    issuedFromIp: null,
    userAgent: 'integration-test',
  });
  expect(row, 'fixture precondition: the session mint returned nothing').not.toBeNull();
  return { id: row!.id, tokenHash };
}

const stillSignedIn = async (tokenHash: string): Promise<boolean> =>
  (await repo!.findActiveWebSession({ tokenHash, now: new Date() })) !== null;

async function mfaSatisfiedAt(id: string): Promise<Date | null> {
  const [row] = await sql!<{ mfa_satisfied_at: Date | null }[]>`
    SELECT mfa_satisfied_at FROM web_sessions WHERE id = ${id}`;
  return row?.mfa_satisfied_at ?? null;
}

describe('web session revocation and MFA marking', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL signing out everywhere ends every live session for the account', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const a = await openSession(accountId);
    const b = await openSession(accountId);
    expect(await stillSignedIn(a.tokenHash), 'precondition: session A is live').toBe(true);
    expect(await repo.revokeAllWebSessionsForAccount(accountId, new Date())).toBe(2);
    expect(
      await stillSignedIn(a.tokenHash),
      'a session survived "sign out everywhere" — this runs after a password change or a reported ' +
        'compromise, so a missed session is an attacker still signed in through the event meant ' +
        'to evict them',
    ).toBe(false);
    expect(await stillSignedIn(b.tokenHash)).toBe(false);
  });

  it('CRITICAL signing out one account never touches another account', async () => {
    if (!dbReachable || !repo) return;
    const mine = await seedAccount();
    const theirs = await seedAccount();
    await openSession(mine);
    const theirSession = await openSession(theirs);
    await repo.revokeAllWebSessionsForAccount(mine, new Date());
    expect(
      await stillSignedIn(theirSession.tokenHash),
      'one account signing out everywhere signed out a different account',
    ).toBe(true);
  });

  it('CRITICAL a second sign-out reports nothing and preserves the first timestamp', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const { id } = await openSession(accountId);
    const first = new Date(Date.now() - HOUR);
    expect(await repo.revokeAllWebSessionsForAccount(accountId, first)).toBe(1);
    expect(
      await repo.revokeAllWebSessionsForAccount(accountId, new Date()),
      'already-revoked sessions were counted again — the number reported back as "signed out N ' +
        'devices" would be work that did not happen',
    ).toBe(0);
    // Compared in SQL: timestamptz equality is the database's decision, and it
    // sidesteps how the driver happens to represent the value.
    const [row] = await sql!<{ unchanged: boolean }[]>`
      SELECT revoked_at = ${first.toISOString()}::timestamptz AS unchanged
        FROM web_sessions WHERE id = ${id}`;
    expect(
      row?.unchanged,
      'the second sweep moved the original revocation time — when a session actually ended is ' +
        'exactly what an incident review needs',
    ).toBe(true);
  });

  it('CRITICAL passing MFA satisfies the one session, not the account', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const challenged = await openSession(accountId);
    const other = await openSession(accountId);
    await repo.markWebSessionMfaSatisfied(challenged.id, new Date());
    expect(
      await mfaSatisfiedAt(challenged.id),
      'the session that passed the challenge was not marked',
    ).not.toBeNull();
    expect(
      await mfaSatisfiedAt(other.id),
      'passing MFA in one browser satisfied it on every other live session for the account — ' +
        'including one an attacker already had open',
    ).toBeNull();
  });

  it('CRITICAL an auth token can be claimed exactly once', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const token = await repo.insertAuthToken({
      kind: 'password_reset',
      accountId,
      tokenHash: `reset-${randomUUID()}`,
      expiresAt: new Date(Date.now() + HOUR),
      requestedFromIp: null,
    });
    const at = new Date();
    expect(
      await repo.consumeAuthToken({ kind: 'password_reset', id: token.id, at }),
      'the first claim on a fresh token was refused',
    ).toBe(true);
    expect(
      await repo.consumeAuthToken({ kind: 'password_reset', id: token.id, at }),
      'the same reset token was claimed twice — the caller acts on true, so the link works again ' +
        'after it has already been used',
    ).toBe(false);
  });

  it('CRITICAL two simultaneous claims on one token yield exactly one winner', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const token = await repo.insertAuthToken({
      kind: 'password_reset',
      accountId,
      tokenHash: `reset-${randomUUID()}`,
      expiresAt: new Date(Date.now() + HOUR),
      requestedFromIp: null,
    });
    const at = new Date();
    const results = await Promise.all([
      repo.consumeAuthToken({ kind: 'password_reset', id: token.id, at }),
      repo.consumeAuthToken({ kind: 'password_reset', id: token.id, at }),
    ]);
    expect(
      results.filter(Boolean).length,
      'both racing claims won — the conditional UPDATE is what makes this safe; a read-then-write ' +
        'would not be',
    ).toBe(1);
  });

  it('CRITICAL claiming a token of one kind does not consume another kind', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const verify = await repo.insertAuthToken({
      kind: 'email_verify',
      accountId,
      tokenHash: `verify-${randomUUID()}`,
      expiresAt: new Date(Date.now() + HOUR),
      requestedFromIp: null,
    });
    // Same id space, different table — tableForKind is the only thing routing this.
    await repo.consumeAuthToken({ kind: 'password_reset', id: verify.id, at: new Date() });
    expect(
      await repo.consumeAuthToken({ kind: 'email_verify', id: verify.id, at: new Date() }),
      'a password-reset claim consumed an email-verification token',
    ).toBe(true);
  });
});
