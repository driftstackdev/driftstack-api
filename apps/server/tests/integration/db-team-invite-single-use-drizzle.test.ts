// An invite token stops working the moment it is used.
//
// `findInviteByTokenHash` carries a Fable auth re-audit (2026-07-02) fix in its
// WHERE clause — `isNull(acceptedAt)` — and records what it prevents:
//
//   an already-accepted invite token could be REPLAYED to re-join a team after
//   removal, or to re-escalate a role after a demote (accept() had no acceptedAt
//   guard, markInviteAccepted leaves the row + token valid until the original
//   7-day expiry, and removeMember didn't touch invites).
//
// So the token stays in the database, unexpired, after it has been redeemed, and
// this single predicate is what makes replaying it fail. The service-level twin
// of this behaviour IS covered — `team-members-service.test.ts` asserts it
// against `_helpers/in-memory-team-members-repo.ts`, whose `find` filters
// `acceptedAt === null` in JS. That double is faithful, but it can only prove
// the double. v8 coverage shows the Drizzle method executing zero statements:
// **the SQL predicate the fix actually consists of has never run in a test.**
//
// Two properties here are SQL's alone and no in-memory twin can stand in:
//
//   isNull(acceptedAt)   a JS `=== null` and a SQL `IS NULL` agree only as long
//                        as the column round-trips as null rather than as a
//                        string; the filter is also an `and()` composition that
//                        could be dropped without the double noticing.
//   email normalization  `deleteInvitesForEmail` lowercases and trims its ARGUMENT
//                        and compares with `eq` — a case-sensitive equality
//                        against whatever the row happens to hold. If a row were
//                        ever stored un-normalized the delete silently matches
//                        nothing, and the invite it was meant to cancel survives.
//                        That delete is how a removed member's outstanding
//                        invites are cancelled, so a miss means they can re-join.

import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleTeamMembersRepo } from '../../src/db/team-members-repo.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const DAY = 24 * 60 * 60 * 1000;

let sql: ReturnType<typeof postgres> | null = null;
let repo: DrizzleTeamMembersRepo | null = null;
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
    await sql`SELECT invite_token_hash FROM team_invites LIMIT 0`;
    dbReachable = true;
  } catch {
    await sql.end({ timeout: 1 }).catch(() => {});
    sql = null;
    return;
  }
  repo = new DrizzleTeamMembersRepo({ db: drizzle(sql) } as unknown as never);
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
    VALUES (${id}, ${`invite-${id}@test.local`}, 'active')`;
  seeded.push(id);
  return id;
}

/** Invites cascade from the owner account, so cleanup is by account. */
async function seedInvite(args: {
  ownerAccountId: string;
  email: string;
  expiresInMs?: number;
}): Promise<{ id: string; hash: string }> {
  const id = randomUUID();
  const hash = createHash('sha256').update(id).digest('hex');
  const expiresAt = new Date(Date.now() + (args.expiresInMs ?? 7 * DAY)).toISOString();
  await sql!`
    INSERT INTO team_invites
      (id, owner_account_id, invitee_email, role, invite_token_hash, invite_expires_at)
    VALUES (${id}, ${args.ownerAccountId}, ${args.email}, 'member', ${hash},
            ${expiresAt}::timestamptz)`;
  return { id, hash };
}

const inviteExists = async (id: string): Promise<boolean> =>
  (await sql!`SELECT 1 FROM team_invites WHERE id = ${id}`).length > 0;

describe('team invite single-use lookup', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL an unredeemed invite resolves by its token hash', async () => {
    if (!dbReachable || !repo) return;
    const owner = await seedAccount();
    const { id, hash } = await seedInvite({ ownerAccountId: owner, email: 'a@test.local' });
    const found = await repo.findInviteByTokenHash(hash);
    expect(found?.id, 'a live invite did not resolve — nobody could accept an invitation').toBe(id);
    expect(found?.inviteeEmail).toBe('a@test.local');
  });

  it('CRITICAL an unknown token hash resolves to nothing', async () => {
    if (!dbReachable || !repo) return;
    expect(
      await repo.findInviteByTokenHash(createHash('sha256').update('nope').digest('hex')),
    ).toBeNull();
  });

  it('CRITICAL a redeemed token stops resolving, so it cannot be replayed', async () => {
    if (!dbReachable || !repo) return;
    const owner = await seedAccount();
    const { id, hash } = await seedInvite({ ownerAccountId: owner, email: 'b@test.local' });
    await repo.markInviteAccepted(id, new Date());
    // The row is still there and still unexpired — only the filter stands between
    // the old link and a second redemption.
    expect(await inviteExists(id), 'precondition: the invite row survives acceptance').toBe(true);
    expect(
      await repo.findInviteByTokenHash(hash),
      'an already-accepted invite token still resolved — it could be replayed to re-join a team ' +
        'after removal, or to re-escalate a role after a demote',
    ).toBeNull();
  });

  it('CRITICAL cancelling invites matches the address however it was typed', async () => {
    if (!dbReachable || !repo) return;
    const owner = await seedAccount();
    const { id } = await seedInvite({ ownerAccountId: owner, email: 'mixed@test.local' });
    await repo.deleteInvitesForEmail(owner, '  MiXeD@Test.Local  ');
    expect(
      await inviteExists(id),
      'the cancel missed because the caller typed the address differently — this is how a removed ' +
        'member’s outstanding invites are revoked, so a miss lets them re-join',
    ).toBe(false);
  });

  it('CRITICAL cancelling invites cannot reach another owner’s invites', async () => {
    if (!dbReachable || !repo) return;
    const mine = await seedAccount();
    const theirs = await seedAccount();
    const shared = 'same-person@test.local';
    const { id: theirInvite } = await seedInvite({ ownerAccountId: theirs, email: shared });
    await repo.deleteInvitesForEmail(mine, shared);
    expect(
      await inviteExists(theirInvite),
      'cancelling one owner’s invite deleted another owner’s invite to the same person',
    ).toBe(true);
  });

  it('CRITICAL an account email resolves, and an unknown account does not', async () => {
    if (!dbReachable || !repo) return;
    const id = await seedAccount();
    expect(await repo.findAccountEmail(id)).toBe(`invite-${id}@test.local`);
    expect(
      await repo.findAccountEmail(randomUUID()),
      'an unknown account id produced an email — accept() gates on this being null',
    ).toBeNull();
  });
});
