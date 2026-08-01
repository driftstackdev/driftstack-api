// Only a live, matching web session can activate MFA.
//
// `completeEnrollmentIfPending` turns a PENDING TOTP secret into an active
// credential. Its own comment states the rule: "a cached/stale, expired,
// revoked, cross-account, or old-epoch bearer cannot turn a pending secret into
// an active credential." Five conditions encode that.
//
// Mutation sweep over the revocation predicate class found that THREE of them
// proved nothing. Deleting the two `isNull(webSessions.revokedAt)` checks, the
// `authEpoch` equality and the `accountId` equality — all with a clean
// typecheck — left the FULL suite green at 2,567 files / 26,606 tests. Only the
// expiry check red anything.
//
// What each one stops, when it works:
//
//   revokedAt   a session the customer already killed — the thing they do FIRST
//               after a compromise — could still activate MFA on their account,
//               which is persistence: the attacker's factor, their account.
//   authEpoch   a session minted before the last authority change (password
//               reset, log-out-everywhere) could still activate.
//   accountId   a session belonging to a DIFFERENT account could authorise this
//               account's enrolment.
//
// The account-id case is the narrowest in practice — a session id is a secret,
// so it is not reachable by guessing — and it is still the difference between
// "authorised by the customer's own live session" and "authorised by any
// session id that reaches this function". The check is cheap; being able to
// prove it holds is the point.
//
// Real Postgres because all five conditions are one SQL predicate inside a
// transaction that also takes an advisory lock and advances an epoch. A fake
// would assert the fake.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import { DrizzleMfaRepo } from '../../src/db/mfa-repo.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const NOW = new Date('2026-08-02T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let repo: DrizzleMfaRepo | null = null;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM account_mfa LIMIT 0`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 4 });
  repo = new DrizzleMfaRepo({ client, db: drizzle(client, { schema }), close: async () => {} });
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM account_mfa_recovery_codes WHERE account_id = ${accountId}`.catch(
        () => {},
      );
      await client`DELETE FROM account_mfa WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM web_sessions WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Pending {
  accountId: string;
  sessionId: string;
  updatedAt: Date;
}

/** An account with a PENDING mfa secret and one live web session. */
async function seedPendingEnrollment(
  status: 'active' | 'suspended' | 'deleted' = 'active',
): Promise<Pending> {
  if (!client) throw new Error('no client');
  const accountId = randomUUID();
  const sessionId = randomUUID();
  const updatedAt = new Date(NOW.getTime() - 60_000);
  seeded.push(accountId);

  await client`
    INSERT INTO accounts (id, email, status, auth_epoch)
    VALUES (${accountId}, ${`mfa-enroll-${accountId}@test.local`}, ${status}::account_status, 1)`;
  await client`
    INSERT INTO account_mfa (account_id, totp_secret_ciphertext, totp_secret_iv, totp_secret_tag, enrolled_at, created_at, updated_at)
    VALUES (${accountId}, 'ct', 'iv', 'tag', NULL, ${updatedAt.toISOString()}::timestamptz, ${updatedAt.toISOString()}::timestamptz)`;
  await client`
    INSERT INTO web_sessions (id, account_id, token_hash, expires_at, auth_epoch, revoked_at)
    VALUES (
      ${sessionId}, ${accountId}, ${`hash-${sessionId}`},
      ${new Date(NOW.getTime() + HOUR_MS).toISOString()}::timestamptz, 1, NULL)`;
  return { accountId, sessionId, updatedAt };
}

const complete = async (p: Pending, sessionId = p.sessionId): Promise<boolean> =>
  await repo!.completeEnrollmentIfPending({
    accountId: p.accountId,
    currentWebSessionId: sessionId,
    expectedUpdatedAt: p.updatedAt,
    hashes: [],
    now: NOW,
  });

async function isEnrolled(accountId: string): Promise<boolean> {
  if (!client) throw new Error('no client');
  const rows = await client<
    Array<{ enrolled_at: string | null }>
  >`SELECT enrolled_at FROM account_mfa WHERE account_id = ${accountId}`;
  return rows[0]?.enrolled_at !== null && rows[0]?.enrolled_at !== undefined;
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'MFA activation is authorised only by a live, matching web session',
  () => {
    it('CRITICAL the database is reachable. Every case is a SQL round-trip; if the connection failed they would skip and this file would report success while proving nothing about a credential activation.', () => {
      expect(dbReachable, `could not reach ${DB_URL} — these results would be meaningless`).toBe(
        true,
      );
    });

    it('CRITICAL a live matching session DOES activate. The positive arm — every other case is a refusal, and an implementation that refused everything would satisfy all of them while making MFA impossible to enable.', async () => {
      const p = await seedPendingEnrollment();

      expect(await complete(p), 'enrolment completes').toBe(true);
      expect(await isEnrolled(p.accountId), 'and the credential is active').toBe(true);
    });

    it('CRITICAL a REVOKED session cannot activate MFA. Killing sessions is the first thing a customer does after a compromise; if a revoked bearer can still enrol a factor, the attacker keeps a foothold the customer believes they closed.', async () => {
      const p = await seedPendingEnrollment();
      await client!`UPDATE web_sessions SET revoked_at = ${new Date(
        NOW.getTime() - 60_000,
      ).toISOString()}::timestamptz WHERE id = ${p.sessionId}`;

      expect(await complete(p), 'refused').toBe(false);
      expect(await isEnrolled(p.accountId), 'and nothing was activated').toBe(false);
    });

    it('CRITICAL an OLD-EPOCH session cannot activate MFA. The epoch advances on password reset and log-out-everywhere, so a bearer minted before that must not still carry authority.', async () => {
      const p = await seedPendingEnrollment();
      await client!`UPDATE accounts SET auth_epoch = auth_epoch + 1 WHERE id = ${p.accountId}`;

      expect(await complete(p), 'refused').toBe(false);
      expect(await isEnrolled(p.accountId), 'and nothing was activated').toBe(false);
    });

    it('CRITICAL a session belonging to ANOTHER account cannot activate this account’s MFA. Narrow in practice because a session id is a secret, but it is the difference between "the customer’s own live session authorised this" and "any session id that reaches this function did".', async () => {
      const victim = await seedPendingEnrollment();
      const other = await seedPendingEnrollment();

      expect(await complete(victim, other.sessionId), 'refused').toBe(false);
      expect(await isEnrolled(victim.accountId), 'the victim is not enrolled').toBe(false);
    });

    it('CRITICAL an EXPIRED session cannot activate MFA. Already covered elsewhere, kept here so the five conditions are asserted as one set rather than scattered.', async () => {
      const p = await seedPendingEnrollment();
      await client!`UPDATE web_sessions SET expires_at = ${new Date(
        NOW.getTime() - HOUR_MS,
      ).toISOString()}::timestamptz WHERE id = ${p.sessionId}`;

      expect(await complete(p), 'refused').toBe(false);
      expect(await isEnrolled(p.accountId), 'and nothing was activated').toBe(false);
    });

    it('CRITICAL a SUSPENDED account cannot activate MFA. Suspension is an enforcement state — billing lapse or abuse — and an account under enforcement must not still be reconfiguring its own authentication.', async () => {
      // Added after the FIRST version of this file shipped. The five session
      // conditions were guarded here, but the authority lock's own
      // `eq(accounts.status, 'active')` was not: deleting it left the full suite
      // green at 2,568 files / 26,613 tests. Guarding a method is not the same
      // as guarding every predicate in it, and only the mutation said which.
      const p = await seedPendingEnrollment('suspended');

      expect(await complete(p), 'refused').toBe(false);
      expect(await isEnrolled(p.accountId), 'and nothing was activated').toBe(false);
    });

    it('CRITICAL a DELETED account cannot activate MFA. The row survives a soft delete, so without the status check a terminated account keeps a live path to change its authentication configuration.', async () => {
      const p = await seedPendingEnrollment('deleted');

      expect(await complete(p), 'refused').toBe(false);
      expect(await isEnrolled(p.accountId), 'and nothing was activated').toBe(false);
    });

    it('CRITICAL a successful activation ADVANCES the account authority epoch, so every other outstanding session is retired by the enrolment rather than surviving it.', async () => {
      const p = await seedPendingEnrollment();
      const before = await client!<
        Array<{ auth_epoch: number }>
      >`SELECT auth_epoch FROM accounts WHERE id = ${p.accountId}`;

      expect(await complete(p)).toBe(true);

      const after = await client!<
        Array<{ auth_epoch: number }>
      >`SELECT auth_epoch FROM accounts WHERE id = ${p.accountId}`;
      expect(after[0]!.auth_epoch, 'the epoch moved').toBe(before[0]!.auth_epoch + 1);
    });
  },
);
