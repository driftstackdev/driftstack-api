// V-1209 — one contract, executed against BOTH implementations of `TeamMembersRepo`.
//
// The fourth of the twenty-nine, and the third instance of the same class. After V-1207 and V-1208
// closed both halves of the drift V-1201 introduced, I swept every double/repo pair for it rather
// than waiting to trip over the next one: for each Drizzle method carrying an `ORDER BY`, does its
// double impose the same order? Eight candidates, of which three were false positives from my own
// heuristic — `in-memory-billing.ts` picks max-`createdAt` with a loop rather than `.sort(`, and
// documents that it mirrors the SQL. Four were real. These two are the customer-visible pair.
//
//   DrizzleTeamMembersRepo.listMembers        -> .orderBy(desc(teamMembers.createdAt))
//   DrizzleTeamMembersRepo.listPendingInvites -> .orderBy(desc(teamInvites.createdAt))
//   InMemoryTeamMembersRepo (both)            -> this.members.filter(...) / this.invites.filter(...)
//
// Not merely a different order — the REVERSE one. The real repo returns newest-first and the double
// returned insertion order, so the team list a unit test believed it was asserting was upside down
// relative to the one the customer is shown.
//
// WHY THE ORDERING ARMS BACKDATE THE **FIRST** ROW. Both sides stamp `createdAt` at write time, so
// write order and created-at order agree unless something forces them apart — and the DIRECTION
// matters. My first draft backdated the SECOND row, which makes write order [first, second] and
// newest-first [first, second] coincide: all nine arms passed against a double that does not order
// at all, and only the sweep that found this pair said otherwise. Backdating the FIRST row makes
// the two orders disagree on both positions, which is what the arm has to measure.
//
// The tenancy arms are here because `ownerAccountId` is the entire boundary on a team read: a
// membership list that leaked across owners would expose one customer's colleagues to another.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { TeamMembersRepo } from '../../src/services/team-members.js';
import { DrizzleTeamMembersRepo } from '../../src/db/team-members-repo.js';
import { InMemoryTeamMembersRepo } from './_helpers/in-memory-team-members-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

const OLD = new Date('2020-01-01T00:00:00.000Z');

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM team_members LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const id of seeded) {
      await client`DELETE FROM team_members WHERE owner_account_id = ${id} OR member_account_id = ${id}`.catch(
        () => {},
      );
      await client`DELETE FROM team_invites WHERE owner_account_id = ${id}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Subject {
  repo: TeamMembersRepo;
  account: () => Promise<string>;
  /** Force a membership's `createdAt`, so write order and created-at order can disagree. */
  backdateMember: (id: string, at: Date) => Promise<void>;
  /** Same, for an invite. */
  backdateInvite: (id: string, at: Date) => Promise<void>;
}

function inMemorySubject(): Subject {
  const repo = new InMemoryTeamMembersRepo();
  return {
    repo,
    account: () => Promise.resolve(randomUUID()),
    backdateMember: (id, at) => {
      const row = repo.getAllMembers().find((m) => m.id === id);
      if (row) (row as { createdAt: Date }).createdAt = at;
      return Promise.resolve();
    },
    backdateInvite: (id, at) => {
      const row = repo.getAllInvites().find((i) => i.id === id);
      if (row) (row as { createdAt: Date }).createdAt = at;
      return Promise.resolve();
    },
  };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleTeamMembersRepo({ client: c, db, close: async () => {} }),
    account: async () => {
      const id = randomUUID();
      seeded.push(id);
      await c`INSERT INTO accounts (id, email) VALUES (${id}, ${`team-contract-${id}@test.local`})`;
      return id;
    },
    backdateMember: async (id, at) => {
      await c`UPDATE team_members SET created_at = ${at.toISOString()}::timestamptz WHERE id = ${id}::uuid`;
    },
    backdateInvite: async (id, at) => {
      await c`UPDATE team_invites SET created_at = ${at.toISOString()}::timestamptz WHERE id = ${id}::uuid`;
    },
  };
}

async function addMember(s: Subject, owner: string, member: string): Promise<string> {
  const row = await s.repo.upsertMembership({
    ownerAccountId: owner,
    memberAccountId: member,
    memberEmail: `member-${member.slice(0, 8)}@test.local`,
    role: 'member',
    invitedAt: new Date(),
    acceptedAt: new Date(),
    invitedByAccountId: null,
  });
  return row.id;
}

async function addInvite(s: Subject, owner: string, email: string): Promise<string> {
  const row = await s.repo.upsertInvite({
    ownerAccountId: owner,
    inviteeEmail: email,
    role: 'member',
    inviteTokenHash: `hash-${randomUUID()}`,
    inviteExpiresAt: new Date(Date.now() + 86_400_000),
    invitedByAccountId: null,
  });
  return row.id;
}

function teamMembersRepoContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`TeamMembersRepo contract — ${label}`, () => {
    it("CRITICAL listMembers is owner-scoped, and returns the asking owner's own team. ownerAccountId is the entire boundary on this read — a list that leaked across owners would expose one customer's colleagues to another.", async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.account();
      const stranger = await s.account();
      const member = await s.account();
      const id = await addMember(s, owner, member);

      expect((await s.repo.listMembers(owner)).map((m) => m.id)).toEqual([id]);
      expect(await s.repo.listMembers(stranger), 'a foreign owner listed the team').toEqual([]);
    });

    it('CRITICAL listMembers returns newest-first, in both. The real repo orders by createdAt DESC and the double returned write order — not a different order but the REVERSE one, so the team list a unit test asserted was upside down relative to the one the customer sees.', async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.account();
      const first = await addMember(s, owner, await s.account());
      const second = await addMember(s, owner, await s.account());

      // Backdate the FIRST-written row, so write order [first, second] and newest-first
      // [second, first] genuinely disagree. Backdating the SECOND row instead makes the two
      // coincide and the arm passes against an implementation that never orders at all.
      await s.backdateMember(first, OLD);

      expect(
        (await s.repo.listMembers(owner)).map((m) => m.id),
        'the member list is in write order, not newest-first',
      ).toEqual([second, first]);
    });

    it('CRITICAL listPendingInvites is owner-scoped and excludes accepted invites, in both. An accepted invite reappearing as pending would offer a second join path against a token the customer has already spent.', async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.account();
      const stranger = await s.account();
      const pending = await addInvite(s, owner, `pending-${randomUUID().slice(0, 8)}@test.local`);
      const accepted = await addInvite(s, owner, `accepted-${randomUUID().slice(0, 8)}@test.local`);
      await s.repo.markInviteAccepted(accepted, new Date());

      expect((await s.repo.listPendingInvites(owner)).map((i) => i.id)).toEqual([pending]);
      expect(await s.repo.listPendingInvites(stranger), 'a foreign owner saw the invite').toEqual(
        [],
      );
    });

    it('CRITICAL listPendingInvites returns newest-first, in both. Same reversal as the member list, on the surface an owner uses to decide which outstanding invite to revoke.', async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.account();
      const first = await addInvite(s, owner, `a-${randomUUID().slice(0, 8)}@test.local`);
      const second = await addInvite(s, owner, `b-${randomUUID().slice(0, 8)}@test.local`);

      await s.backdateInvite(first, OLD);

      expect(
        (await s.repo.listPendingInvites(owner)).map((i) => i.id),
        'the invite list is in write order, not newest-first',
      ).toEqual([second, first]);
    });
  });
}

teamMembersRepoContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'TeamMembersRepo contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    teamMembersRepoContract('drizzle', drizzleSubject, () => dbReachable);
  },
);
