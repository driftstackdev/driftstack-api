// Which auth-flow tokens the retention sweep is allowed to delete.
//
// v8 coverage: `auth-flows-repo.ts` sits at 49% of lines, and
// `deleteStaleAuthTokens` executes zero statements. It deletes rows matching
// EITHER of two conditions, and only one of them is about tokens that are
// finished with:
//
//   consumed AND consumedAt < consumedBefore     an already-used token, kept a
//                                                while for forensics and then
//                                                dropped. Safe by definition.
//   unconsumed AND expiresAt < expiredBefore     a link nobody clicked in time.
//
// The second predicate's comparison is the whole safety property. Without it
// every UNCONSUMED token is stale — which is precisely the set of live password
// reset and email verification links currently sitting in customer inboxes.
// They would all stop working, and the failure a customer sees is "invalid or
// expired link" on a link they were sent minutes ago.
//
// The other half is routing. `tableForKind` maps the kind onto one of three
// separate tables, so a sweep for `password_reset` must not touch
// `email_verify` rows. Getting that wrong deletes a different flow's tokens
// entirely, and the two sweeps run on different schedules so nothing would line
// up to make it obvious.
//
// Against a real Postgres: the predicate is `OR` over two `AND`s with NULL
// semantics deciding which branch a row can even reach, and the timestamps are
// passed as ISO strings with an explicit cast (a documented postgres-js bind
// requirement). None of that survives being re-expressed in a double.

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
const seededAccounts: string[] = [];

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
    await sql`SELECT consumed_at FROM password_reset_tokens LIMIT 0`;
    dbReachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  repo = new DrizzleAuthFlowsRepo({ db: drizzle(sql) } as unknown as never);
});

afterAll(async () => {
  if (sql && seededAccounts.length > 0) {
    await sql`DELETE FROM accounts WHERE id = ANY(${sql.array(seededAccounts)}::uuid[])`.catch(
      () => undefined,
    );
  }
  await sql?.end({ timeout: 2 }).catch(() => undefined);
});

async function seedAccount(): Promise<string> {
  const id = randomUUID();
  await sql!`
    INSERT INTO accounts (id, email, status)
    VALUES (${id}, ${`authflow-${id}@test.local`}, 'active')`;
  seededAccounts.push(id);
  return id;
}

/** Tokens cascade from accounts, so cleanup is by account. */
async function seedToken(args: {
  table: 'password_reset_tokens' | 'email_verify_tokens';
  accountId: string;
  expiresInMs: number;
  consumedAgoMs?: number | null;
}): Promise<string> {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + args.expiresInMs).toISOString();
  const consumedAt =
    args.consumedAgoMs === null || args.consumedAgoMs === undefined
      ? null
      : new Date(Date.now() - args.consumedAgoMs).toISOString();
  const rows =
    args.table === 'password_reset_tokens'
      ? sql!`INSERT INTO password_reset_tokens (id, account_id, token_hash, expires_at, consumed_at)
             VALUES (${id}, ${args.accountId}, ${`hash-${id}`}, ${expiresAt}::timestamptz,
                     ${consumedAt}::timestamptz)`
      : sql!`INSERT INTO email_verify_tokens (id, account_id, token_hash, expires_at, consumed_at)
             VALUES (${id}, ${args.accountId}, ${`hash-${id}`}, ${expiresAt}::timestamptz,
                     ${consumedAt}::timestamptz)`;
  await rows;
  return id;
}

async function exists(
  table: 'password_reset_tokens' | 'email_verify_tokens',
  id: string,
): Promise<boolean> {
  const rows =
    table === 'password_reset_tokens'
      ? await sql!`SELECT 1 FROM password_reset_tokens WHERE id = ${id}`
      : await sql!`SELECT 1 FROM email_verify_tokens WHERE id = ${id}`;
  return rows.length > 0;
}

/** Sweep with windows that make "old" unambiguous: consumed >1h ago, expired >1h ago. */
const sweep = (): Promise<number> =>
  repo!.deleteStaleAuthTokens({
    kind: 'password_reset',
    consumedBefore: new Date(Date.now() - HOUR),
    expiredBefore: new Date(Date.now() - HOUR),
  });

describe('stale auth-token sweep', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL a live unconsumed token survives the sweep', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const live = await seedToken({
      table: 'password_reset_tokens',
      accountId,
      expiresInMs: 6 * HOUR,
      consumedAgoMs: null,
    });
    await sweep();
    expect(
      await exists('password_reset_tokens', live),
      'the sweep deleted a token nobody has used and that has not expired — every password-reset ' +
        'link currently in a customer inbox would stop working',
    ).toBe(true);
  });

  it('CRITICAL an unconsumed token past its expiry is swept', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const expired = await seedToken({
      table: 'password_reset_tokens',
      accountId,
      expiresInMs: -6 * HOUR,
      consumedAgoMs: null,
    });
    await sweep();
    expect(
      await exists('password_reset_tokens', expired),
      'a long-expired token was retained — the sweep would never reclaim anything',
    ).toBe(false);
  });

  it('CRITICAL a long-consumed token is swept, a just-consumed one is kept', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    const old = await seedToken({
      table: 'password_reset_tokens',
      accountId,
      expiresInMs: 6 * HOUR,
      consumedAgoMs: 6 * HOUR,
    });
    const recent = await seedToken({
      table: 'password_reset_tokens',
      accountId,
      expiresInMs: 6 * HOUR,
      consumedAgoMs: 60_000,
    });
    await sweep();
    expect(await exists('password_reset_tokens', old), 'an old consumed token was retained').toBe(
      false,
    );
    expect(
      await exists('password_reset_tokens', recent),
      'a token consumed a minute ago was already swept — the forensic window is not being honoured',
    ).toBe(true);
  });

  it('CRITICAL sweeping one flow does not touch another flow’s tokens', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    // Same shape, different table: stale by every measure, but a different kind.
    const otherFlow = await seedToken({
      table: 'email_verify_tokens',
      accountId,
      expiresInMs: -6 * HOUR,
      consumedAgoMs: null,
    });
    await sweep();
    expect(
      await exists('email_verify_tokens', otherFlow),
      'a password-reset sweep deleted email-verification tokens — the two run on different ' +
        'schedules, so nothing would line up to make this obvious',
    ).toBe(true);
  });

  it('CRITICAL the sweep reports how many rows it removed', async () => {
    if (!dbReachable || !repo) return;
    const accountId = await seedAccount();
    await seedToken({
      table: 'password_reset_tokens',
      accountId,
      expiresInMs: -6 * HOUR,
      consumedAgoMs: null,
    });
    await seedToken({
      table: 'password_reset_tokens',
      accountId,
      expiresInMs: -6 * HOUR,
      consumedAgoMs: null,
    });
    expect(
      await sweep(),
      'the sweep under-reported its own deletions — the count is what operators read to know it ran',
    ).toBeGreaterThanOrEqual(2);
  });
});
