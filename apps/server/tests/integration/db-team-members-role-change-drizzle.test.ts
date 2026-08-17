// Demoting a team member has to actually demote them.
//
// v8 coverage: `upsertMembership` executes zero statements in the suite. Its own
// comment records why that matters — a 2026-06-30 audit found this method using
// `ON CONFLICT DO NOTHING`, which meant:
//
//   re-inviting and re-accepting an existing member with a DIFFERENT role is the
//   only documented role-change mechanism, and with DO NOTHING the INSERT was
//   skipped on conflict and the pre-existing row (OLD role) was returned
//   unchanged. An owner demoting an 'admin' member to 'member' silently
//   no-op'd, and the member kept full admin write access.
//
// `effectiveAccountIdForWrite` in sessions.ts, profiles.ts and webhooks.ts all
// gate on that exact column, so the demotion failing is a privilege the owner
// believes they revoked. The fix was `DO UPDATE`. **Nothing exercised the fix.**
//
// Three more properties of the same statement, each a different way to get the
// upsert subtly wrong:
//
//   returned row     DO UPDATE returns the affected row, and the caller uses it.
//                    A stale return hands the API a role the database no longer
//                    holds — the demotion works but the response says otherwise.
//   acceptedAt       deliberately NOT in the SET clause: it stays the original
//                    accept time, the member's "member since". Adding it there
//                    would silently reset tenure on every role change.
//   conflict target  the pair (owner, member). Keyed on the member alone, one
//                    person belonging to two workspaces would have their second
//                    membership overwrite the first.
//
// Against a real Postgres because ON CONFLICT arbitration IS the behaviour under
// test — which index the conflict resolves against, and what a DO UPDATE
// returns, are the database's decisions, not the ORM's.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleTeamMembersRepo } from '../../src/db/team-members-repo.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

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
    await sql`SELECT role FROM team_members LIMIT 0`;
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

async function seedAccount(): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `team-${id}@test.local`;
  await sql!`INSERT INTO accounts (id, email, status) VALUES (${id}, ${email}, 'active')`;
  seeded.push(id);
  return { id, email };
}

async function upsert(
  owner: string,
  member: { id: string; email: string },
  role: 'member' | 'admin',
  at = new Date(),
): Promise<{ role: string }> {
  return repo!.upsertMembership({
    ownerAccountId: owner,
    memberAccountId: member.id,
    memberEmail: member.email,
    role,
    invitedAt: at,
    acceptedAt: at,
    invitedByAccountId: owner,
  });
}

async function storedRole(owner: string, member: string): Promise<string | undefined> {
  const [row] = await sql!<{ role: string }[]>`
    SELECT role FROM team_members WHERE owner_account_id = ${owner} AND member_account_id = ${member}`;
  return row?.role;
}

describe('team membership role changes', () => {
  it('CRITICAL the database was reachable, so a green here is not "no database"', () => {
    expect(dbReachable, `no Postgres at ${DB_URL} — these arms assert nothing without it`).toBe(
      true,
    );
  });

  it('CRITICAL a first upsert creates the membership at the given role', async () => {
    if (!dbReachable || !repo) return;
    const owner = await seedAccount();
    const member = await seedAccount();
    expect((await upsert(owner.id, member, 'admin')).role).toBe('admin');
    expect(await storedRole(owner.id, member.id)).toBe('admin');
  });

  it('CRITICAL demoting an admin to member actually writes the new role', async () => {
    if (!dbReachable || !repo) return;
    const owner = await seedAccount();
    const member = await seedAccount();
    await upsert(owner.id, member, 'admin');
    await upsert(owner.id, member, 'member');
    expect(
      await storedRole(owner.id, member.id),
      'the demotion silently no-op’d and the member kept admin. effectiveAccountIdForWrite in ' +
        'sessions/profiles/webhooks gates on this column, so this is write access the owner ' +
        'believes they revoked',
    ).toBe('member');
  });

  it('CRITICAL the row returned on conflict carries the NEW role, not the old one', async () => {
    if (!dbReachable || !repo) return;
    const owner = await seedAccount();
    const member = await seedAccount();
    await upsert(owner.id, member, 'admin');
    expect(
      (await upsert(owner.id, member, 'member')).role,
      'the upsert returned the pre-existing row — the database was updated but the API answered ' +
        'with a role that is no longer stored',
    ).toBe('member');
  });

  it('CRITICAL a role change does not reset the member-since timestamp', async () => {
    if (!dbReachable || !repo) return;
    const owner = await seedAccount();
    const member = await seedAccount();
    const joined = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await upsert(owner.id, member, 'member', joined);
    await upsert(owner.id, member, 'admin', new Date());
    // Compared in SQL rather than JS: timestamptz equality is the database's
    // decision, and it sidesteps how the driver happens to represent the value.
    const [row] = await sql!<{ unchanged: boolean }[]>`
      SELECT accepted_at = ${joined.toISOString()}::timestamptz AS unchanged
        FROM team_members
       WHERE owner_account_id = ${owner.id} AND member_account_id = ${member.id}`;
    expect(
      row?.unchanged,
      'promoting a member reset their tenure — acceptedAt is deliberately outside the SET clause ' +
        'so it stays the original "member since"',
    ).toBe(true);
  });

  it('CRITICAL the same person can belong to two workspaces independently', async () => {
    if (!dbReachable || !repo) return;
    const ownerA = await seedAccount();
    const ownerB = await seedAccount();
    const member = await seedAccount();
    await upsert(ownerA.id, member, 'admin');
    await upsert(ownerB.id, member, 'member');
    expect(
      await storedRole(ownerA.id, member.id),
      'joining a second workspace overwrote the first membership — the conflict target must be ' +
        'the (owner, member) pair, not the member alone',
    ).toBe('admin');
    expect(await storedRole(ownerB.id, member.id)).toBe('member');
  });
});
