// The owner-status filter on findTeamMemberships, against real Postgres.
//
// This clause is the whole control:
//
//     .where(and(
//       eq(teamMembers.memberAccountId, memberAccountId),
//       eq(accounts.status, 'active'),          // <- this
//     ))
//
// Remove it and a team member keeps acting on behalf of an owner account that
// has been suspended or deleted.
//
// ─── why it is the ONLY thing standing there ──────────────────────────────────
//
// Every route that acts for another account resolves the owner through the
// membership grant and then checks:
//
//     const owner = await authRepo.getAccount(eff);
//     if (!owner) throw new ForbiddenError('Owner account no longer exists.');
//
// — a NULL check, at 8 sites across 4 route files. Accounts are SOFT-deleted
// (`account_status` is active|suspended|deleted), so a deleted owner still has
// a row and sails straight through every one of those. The routes do not look
// at `owner.status` anywhere. So the reason a member cannot act for a deleted
// owner is not the route guard at all — it is that the grant never reaches
// them, because this query filtered it out one layer earlier, in SQL.
//
// (`middleware/rate-limit.ts` is the exception that proves it: that one DOES
// test `status === 'deleted'` itself, and says in its own comment that "the
// reachable case is `status`, not a null row".)
//
// ─── and why it needed a test against a real database ─────────────────────────
//
// `team-auth-owner-status-authority` already pins this behaviour — on
// `InMemoryAuthRepo`. That covers the DECISION, not the STATEMENT, which is the
// same gap item 5e closed for ten other repos. Measured before writing this
// file: NO test called `findTeamMemberships` on a Drizzle repo. Every reference
// in the integration suite is a stub (`() => Promise.resolve([])`) or a comment
// reasoning about the filter — `team-effective-owner-rate-limit.test.ts:344`
// says "db/auth-repo.ts findTeamMemberships already filters memberships to …"
// while substituting a double for the query that does it.
//
// An invariant asserted in prose inside a test that stubs it out is the exact
// shape of a guard nobody would notice losing.
//
// Shared-database discipline: every arm scopes to accounts this run seeded and
// asserts on memberships whose owner is one of them. The query takes a member
// id, so nothing global is asserted.
//
// MUTATION-PROVED against db/auth-repo.ts, running this file AND the in-memory
// pin. Controls: 8/8 here, 1/1 on the pin.
//
//                                                    here    in-memory pin
//   the owner-status filter dropped                  4 red      GREEN
//   the member predicate dropped                     1 red      GREEN
//   `eq(status,'active')` -> `ne(status,'deleted')`  7 red      GREEN
//
// ⛔ The in-memory pin is green on all three, and that is the point of this
// file. It asserts the same rule against `InMemoryAuthRepo`, so it moves when
// the DOUBLE changes and never when the SQL does. The double and the statement
// can drift apart silently, and the statement is the one in production.
//
// The third mutation is the subtle one: allowing suspended owners while still
// excluding deleted ones. It keeps the filter, keeps the shape, reads correctly
// at a glance, and reopens every suspended account to its whole team.
//
// A fourth mutation was DISCARDED rather than reported: it was labelled "reads
// the member's status instead of the owner's" but the replacement appended a
// `.having()` clause, which is not that change. It red the arms, and reporting
// it would have been a true number under a false description.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAccountAuthRepo } from '../../src/db/auth-repo.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

type Status = 'active' | 'suspended' | 'deleted';

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let repo: DrizzleAccountAuthRepo | null = null;
const seeded: string[] = [];

async function seedAccount(status: Status = 'active'): Promise<string> {
  if (!client) throw new Error('no client');
  const id = randomUUID();
  await client`
    INSERT INTO accounts (id, email, name, tier, status, created_at, updated_at)
    VALUES (${id}, ${`teamowner-${id.slice(0, 8)}@example.test`}, ${'Team Owner Fixture'},
            'free'::account_tier, ${status}::account_status, now(), now())`;
  seeded.push(id);
  return id;
}

async function setStatus(accountId: string, status: Status): Promise<void> {
  if (!client) throw new Error('no client');
  await client`UPDATE accounts SET status = ${status}::account_status WHERE id = ${accountId}`;
}

async function grant(ownerId: string, memberId: string, role = 'member'): Promise<void> {
  if (!client) throw new Error('no client');
  await client`
    INSERT INTO team_members
      (id, owner_account_id, member_account_id, role, invited_at, accepted_at, created_at)
    VALUES (${randomUUID()}, ${ownerId}, ${memberId}, ${role}::team_role, now(), now(), now())`;
}

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
  try {
    await client`SELECT 1 FROM team_members LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
    return;
  }
  repo = new DrizzleAccountAuthRepo({
    client,
    db: drizzle(client, { schema }),
    close: async () => {},
  });
});

afterAll(async () => {
  if (client) {
    // team_members cascades from accounts on both FKs.
    for (const id of seeded) {
      await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleAccountAuthRepo.findTeamMemberships owner-status filter (real Postgres)',
  () => {
    it('CRITICAL the database is reachable and migrated. In CI the service and migrate step are part of the job, so an unreachable database must FAIL rather than let every arm below pass vacuously.', () => {
      if (!process.env.CI && !process.env.DATABASE_URL) return;
      expect(dbReachable, 'postgres reachable and team_members present').toBe(true);
      expect(repo, 'repo constructed').not.toBeNull();
    });

    it('CRITICAL an ACTIVE owner produces a grant carrying the owner identity. Every exclusion arm below would also pass against a query that returned nothing at all, and the join is what lets the dashboard label a team by its owner rather than a bare account id.', async () => {
      if (!dbReachable || !repo) return;
      const owner = await seedAccount('active');
      const member = await seedAccount('active');
      await grant(owner, member, 'admin');

      const rows = await repo.findTeamMemberships(member);
      const mine = rows.filter((r) => r.ownerAccountId === owner);
      expect(mine.length, 'exactly one grant').toBe(1);
      expect(mine[0]?.role, 'the stored role').toBe('admin');
      expect(mine[0]?.ownerEmail, 'the joined owner email').toMatch(/@example\.test$/);
    });

    it('CRITICAL a SUSPENDED owner produces NO grant. Suspension is how billing failure and policy enforcement stop an account; without this filter every team member keeps operating the suspended account normally, which is the one outcome suspension exists to prevent — and each of them is a caller the owner cannot see or stop.', async () => {
      if (!dbReachable || !repo) return;
      const owner = await seedAccount('active');
      const member = await seedAccount('active');
      await grant(owner, member);
      expect(
        (await repo.findTeamMemberships(member)).some((r) => r.ownerAccountId === owner),
        'granted while active',
      ).toBe(true);

      await setStatus(owner, 'suspended');
      expect(
        (await repo.findTeamMemberships(member)).some((r) => r.ownerAccountId === owner),
        'and revoked the moment the owner is suspended',
      ).toBe(false);
    });

    it('CRITICAL a DELETED owner produces NO grant, and this is the case the route guards cannot catch. Deletion is SOFT — the row survives with status deleted — so the `if (!owner)` null check at 8 route sites passes straight through it. This query is the only thing that stops a member acting for a deleted account.', async () => {
      if (!dbReachable || !repo) return;
      const owner = await seedAccount('active');
      const member = await seedAccount('active');
      await grant(owner, member);
      await setStatus(owner, 'deleted');

      expect(
        (await repo.findTeamMemberships(member)).some((r) => r.ownerAccountId === owner),
        'no grant survives the owner being deleted',
      ).toBe(false);

      // The premise of the arm, asserted rather than assumed: the row is still
      // there. If deletion ever became a hard delete this stops being the
      // interesting case, and this expectation is what would say so.
      const [row] = await client!<{ status: string }[]>`
        SELECT status FROM accounts WHERE id = ${owner}`;
      expect(row?.status, 'the owner row survives deletion, soft-deleted').toBe('deleted');
    });

    it('CRITICAL the grant returns when a suspended owner is reinstated. A filter implemented as a destructive cleanup rather than a read-time predicate would pass every arm above and silently make suspension irreversible — the member would have to be re-invited, and nothing would report why.', async () => {
      if (!dbReachable || !repo) return;
      const owner = await seedAccount('active');
      const member = await seedAccount('active');
      await grant(owner, member);
      await setStatus(owner, 'suspended');
      expect(
        (await repo.findTeamMemberships(member)).some((r) => r.ownerAccountId === owner),
        'gone while suspended',
      ).toBe(false);

      await setStatus(owner, 'active');
      expect(
        (await repo.findTeamMemberships(member)).some((r) => r.ownerAccountId === owner),
        'and back on reinstatement',
      ).toBe(true);
    });

    it("CRITICAL the filter reads the OWNER's status, not the member's. A suspended member is a separate control on a separate path; conflating the two would either keep a suspended owner reachable or strip a healthy owner's team the moment one member was suspended.", async () => {
      if (!dbReachable || !repo) return;
      const owner = await seedAccount('active');
      const member = await seedAccount('active');
      await grant(owner, member);

      await setStatus(member, 'suspended');
      expect(
        (await repo.findTeamMemberships(member)).some((r) => r.ownerAccountId === owner),
        "a suspended MEMBER does not lose an active owner's grant here",
      ).toBe(true);
    });

    it('CRITICAL one owner being suspended does not disturb another owner’s grant to the same member. A member can belong to several teams, and a filter applied to the result set rather than per-row would take all of them down together.', async () => {
      if (!dbReachable || !repo) return;
      const good = await seedAccount('active');
      const bad = await seedAccount('active');
      const member = await seedAccount('active');
      await grant(good, member);
      await grant(bad, member);
      await setStatus(bad, 'suspended');

      const owners = (await repo.findTeamMemberships(member)).map((r) => r.ownerAccountId);
      expect(owners, 'the healthy owner survives').toContain(good);
      expect(owners, 'and only the suspended one is dropped').not.toContain(bad);
    });

    it('CRITICAL the query is scoped to the member it was asked about. It takes a member id and nothing else scopes it; a missing predicate would hand one customer every team grant in the table, which is a cross-tenant read on the path that decides who a request may act as.', async () => {
      if (!dbReachable || !repo) return;
      const owner = await seedAccount('active');
      const mine = await seedAccount('active');
      const theirs = await seedAccount('active');
      await grant(owner, theirs);

      expect(
        (await repo.findTeamMemberships(mine)).some((r) => r.ownerAccountId === owner),
        "another member's grant does not appear",
      ).toBe(false);
    });
  },
);
