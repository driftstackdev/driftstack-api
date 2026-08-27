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
  /**
   * V-1843 — seed a team and return its id. No repo method creates teams (they
   * arrive via the account/backfill path), and the two owner-scoped team reads
   * below need one to act on.
   */
  seedTeam: (ownerAccountId: string, name: string) => Promise<string>;
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
    seedTeam: (ownerAccountId, name) => {
      const id = randomUUID();
      const now = new Date();
      repo.seedTeam({ id, name, slug: null, ownerAccountId, createdAt: now, updatedAt: now });
      return Promise.resolve(id);
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
    seedTeam: async (ownerAccountId, name) => {
      const [row] = await c<Array<{ id: string }>>`
        INSERT INTO teams (owner_account_id, name) VALUES (${ownerAccountId}, ${name})
        RETURNING id`;
      if (!row) throw new Error('teams insert returned no row');
      return row.id;
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

/** As `addInvite`, but hands back the token hash — the credential the accept path compares. */
async function addInviteReturningHash(
  s: Subject,
  owner: string,
  email: string,
): Promise<{ id: string; tokenHash: string }> {
  const tokenHash = `hash-${randomUUID()}`;
  const row = await s.repo.upsertInvite({
    ownerAccountId: owner,
    inviteeEmail: email,
    role: 'member',
    inviteTokenHash: tokenHash,
    inviteExpiresAt: new Date(Date.now() + 86_400_000),
    invitedByAccountId: null,
  });
  return { id: row.id, tokenHash };
}

function teamMembersRepoContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`TeamMembersRepo contract — ${label}`, () => {
    it('CRITICAL accepting an invite as an EXISTING member refreshes the role and reports the email the caller presented, in both. `member_email` is not a `team_members` column — the Drizzle path attaches whatever the caller passed to the row it returns — so a fixture that stores the address at creation hands back a stale one on the single path where the caller has just supplied the current address. Re-inviting an existing member to change their role is the normal way roles are changed, so this is the ordinary case, not an edge.', async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.account();
      const member = await s.account();

      await addMember(s, owner, member);
      const invite = await addInviteReturningHash(s, owner, 'renamed@test.local');

      const accepted = await s.repo.acceptInviteAtomic({
        inviteId: invite.id,
        inviteTokenHash: invite.tokenHash,
        memberAccountId: member,
        memberEmail: 'renamed@test.local',
        acceptedAt: new Date(),
      });

      expect(accepted, 'accepting a valid invite returned no membership').not.toBeNull();
      expect(
        accepted?.memberEmail,
        'the returned membership carried an address the caller did not present',
      ).toBe('renamed@test.local');
      expect(accepted?.memberAccountId, 'the membership was attributed to another account').toBe(
        member,
      );
    });

    it('CRITICAL an invite whose token hash does not match is NOT accepted, in both. The compare-and-swap is on the exact presented credential, so a stale link — one whose invite was re-issued with a fresh token — must miss rather than accept on the strength of the id alone.', async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.account();
      const member = await s.account();
      const inviteId = await addInvite(s, owner, 'invitee@test.local');

      const accepted = await s.repo.acceptInviteAtomic({
        inviteId,
        inviteTokenHash: 'hash-that-was-never-issued',
        memberAccountId: member,
        memberEmail: 'invitee@test.local',
        acceptedAt: new Date(),
      });

      expect(accepted, 'an invite was accepted against the wrong token hash').toBeNull();
    });

    it('CRITICAL an invite handed to the caller is a SNAPSHOT — a later write does not reach into it, in both. Postgres cannot mutate a row the caller already holds. A fixture that can makes every before/after comparison against it read "nothing changed", because `before` and `after` are the same object, and the arm then passes forever asserting nothing.', async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.account();
      const email = `snap-${randomUUID().slice(0, 8)}@team.test`;
      const inviteId = await addInvite(s, owner, email);

      const held = (await s.repo.listPendingInvites(owner)).find((i) => i.id === inviteId);
      expect(held?.acceptedAt ?? null, 'precondition: the invite is still pending').toBeNull();

      await s.repo.markInviteAccepted(inviteId, new Date('2026-08-21T00:00:00.000Z'));

      expect(
        held?.acceptedAt ?? null,
        'the invite handed to the caller mutated underneath it — reads are aliasing the store',
      ).toBeNull();
      expect(
        (await s.repo.listPendingInvites(owner)).some((i) => i.id === inviteId),
        'and the accept did not land, so the arm above proves nothing',
      ).toBe(false);
    });

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

    // ── owner-scoped team reads ───────────────────────────────────────
    //
    // V-1843. `eq(teams.ownerAccountId, …)` is a THIRD tenancy axis: the earlier
    // sweep enumerated `eq(.accountId)` and a later gap was `eq(.nodeId)`. Both
    // reads below are LIVE — `routes/team.ts` behind `requireScope('account_owner')`,
    // a scope every account owner holds, straight through the service to these two
    // repo methods — and coverage reported neither Drizzle implementation as ever
    // executed. Their only drivers were a fake in the service test and the
    // in-memory double.
    //
    // Checked first, because a sibling taught it: `removeMember` is a superseded
    // orphan whose scoping mutation SURVIVES by design, and `team-routes` carries a
    // ledger saying so. There is no such ledger for these two, and unlike that one
    // the service reaches them directly.

    it('CRITICAL renameTeam refuses a team owned by ANOTHER account, in both. The owner predicate is the whole cross-tenant guard on this write: the route only checks that the caller is SOME account owner, so without it any owner could rename any other owner’s team by id.', async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.account();
      const stranger = await s.account();
      const teamId = await s.seedTeam(owner, 'owner-team');

      // Positive control: the owner CAN rename, so the refusal below is a
      // boundary rather than a method that renames nothing.
      expect(
        (await s.repo.renameTeam(teamId, owner, 'renamed-by-owner'))?.name,
        'the owner could not rename their own team',
      ).toBe('renamed-by-owner');

      expect(
        await s.repo.renameTeam(teamId, stranger, 'renamed-by-stranger'),
        'ANOTHER account renamed a team it does not own',
      ).toBeNull();

      // Refusing to return the row is not the property; not WRITING is.
      expect(
        (await s.repo.listTeamsOwnedBy(owner)).find((t) => t.id === teamId)?.name,
        'the stranger’s rename was refused but still landed on the row',
      ).toBe('renamed-by-owner');
    });

    it('CRITICAL listTeamsOwnedBy returns only the asking owner’s teams, in both. This list is what `GET /v1/team` answers with, so a dropped predicate discloses every other account’s team names and ids.', async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.account();
      const stranger = await s.account();
      const mine = await s.seedTeam(owner, 'mine');
      const theirs = await s.seedTeam(stranger, 'theirs');

      const ids = (await s.repo.listTeamsOwnedBy(owner)).map((t) => t.id);

      // Positive control first: an empty list satisfies the exclusion below.
      expect(ids, 'the owner’s own team is missing, so the exclusion proves nothing').toContain(
        mine,
      );
      expect(ids, 'another account’s team appeared in this owner’s listing').not.toContain(theirs);

      // And the stranger sees exactly their own, so this is a boundary rather
      // than a query that happens to return one row for everyone.
      const theirIds = (await s.repo.listTeamsOwnedBy(stranger)).map((t) => t.id);
      expect(theirIds).toContain(theirs);
      expect(theirIds, 'the boundary only holds in one direction').not.toContain(mine);
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
