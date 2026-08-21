// V-1228 — one contract for profile-snapshot listing, against BOTH implementations of
// `ProfileSnapshotsRepo` — plus one arm that CANNOT be a contract arm, and the reason why.
//
// The eighteenth of the twenty-nine. Snapshots are immutable point-in-time copies of a profile, and
// the point of them is surviving the profile: a customer restores from one after deleting the thing
// it came from.
//
// THE GUARANTEE THAT MAKES THAT WORK LIVES IN THE SCHEMA, NOT IN ANY CODE:
//
//   profile_snapshots_parent_profile_id_fkey   ON DELETE SET NULL
//   profile_snapshots_account_id_fkey          ON DELETE CASCADE
//
// Purging the parent profile NULLs `parent_profile_id` and leaves the snapshot standing — which is
// why `ProfileSnapshotRecord.parentProfileId` is nullable and why restore falls back to
// `parentArchetype` / `parentName`. Deleting the ACCOUNT takes the snapshots with it.
//
// No in-memory double can hold that. It has no `profiles` table for a foreign key to point at, so
// there is nothing to cascade FROM — the behaviour is not "unimplemented in the double", it is
// unimplementable there. Writing it as a contract arm would produce an assertion that only ever
// runs against one implementation while looking like it runs against two, which is the failure mode
// these contracts exist to prevent. So it sits in the Drizzle-only block below, labelled, rather
// than being quietly skipped inside a shared arm.
//
// That distinction is the useful part of this file. Everything a contract CAN cover — account
// scoping, the parent filter, newest-first ordering, scoped deletion — is covered in both. The one
// property neither TypeScript nor a double can express is covered once, against the only thing that
// implements it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { ProfileSnapshotsRepo } from '../../src/services/profile-snapshots.js';
import { DrizzleProfileSnapshotsRepo } from '../../src/db/profile-snapshots-repo.js';
import { InMemoryProfileSnapshotsRepo } from './_helpers/in-memory-profile-snapshots-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const ARCHETYPE = 'iphone17_ios18_7_safari26_4';

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM profile_snapshots LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const a of seeded) {
      await client`DELETE FROM profile_snapshots WHERE account_id = ${a}::uuid`.catch(() => {});
      await client`DELETE FROM profiles WHERE account_id = ${a}::uuid`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${a}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Subject {
  repo: ProfileSnapshotsRepo;
  /** An account plus a parent profile id the snapshots can hang from. */
  tenant: () => Promise<{ accountId: string; profileId: string }>;
}

function inMemorySubject(): Subject {
  return {
    repo: new InMemoryProfileSnapshotsRepo(),
    tenant: () => Promise.resolve({ accountId: randomUUID(), profileId: randomUUID() }),
  };
}

async function seedTenant(c: ReturnType<typeof postgres>) {
  const accountId = randomUUID();
  const profileId = randomUUID();
  seeded.push(accountId);
  await c`INSERT INTO accounts (id, email) VALUES (${accountId}, ${`snap-${accountId}@test.local`})`;
  await c`INSERT INTO profiles (id, account_id, name, archetype, tags)
          VALUES (${profileId}::uuid, ${accountId}::uuid, ${`p-${profileId.slice(0, 8)}`},
                  ${ARCHETYPE}, '{}')`;
  return { accountId, profileId };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleProfileSnapshotsRepo({ client: c, db, close: async () => {} }),
    tenant: () => seedTenant(c),
  };
}

async function snap(s: Subject, t: { accountId: string; profileId: string }, label: string) {
  const row = await s.repo.insert({
    accountId: t.accountId,
    parentProfileId: t.profileId,
    label,
    description: null,
    parentArchetype: ARCHETYPE,
    parentName: 'parent',
    stateBlob: {},
  });
  return row.id;
}

function snapshotContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`ProfileSnapshotsRepo contract — ${label}`, () => {
    it("CRITICAL list is account-scoped, in both. A snapshot carries a full profile state blob, so another account's appearing here is a disclosure of exactly the thing the product exists to keep separate.", async () => {
      if (!enabled()) return;
      const s = make();
      const mine = await s.tenant();
      const theirs = await s.tenant();
      const own = await snap(s, mine, 'mine');
      await snap(s, theirs, 'theirs');

      expect((await s.repo.list({ accountId: mine.accountId })).data.map((r) => r.id)).toEqual([
        own,
      ]);
    });

    it("CRITICAL list filters by parentProfileId when asked, in both. The profile detail view asks for one profile's snapshots, so a filter that leaked siblings would show a customer restore points belonging to a different profile of theirs.", async () => {
      if (!enabled()) return;
      const s = make();
      const t = await s.tenant();
      const other = await s.tenant();
      // Same account, different parent profile.
      const mineForThisParent = await snap(s, t, 'this-parent');
      await snap(s, { accountId: t.accountId, profileId: other.profileId }, 'other-parent');

      const page = await s.repo.list({
        accountId: t.accountId,
        parentProfileId: t.profileId,
      });
      expect(
        page.data.map((r) => r.id),
        "a sibling profile's snapshot leaked into the filter",
      ).toEqual([mineForThisParent]);
    });

    it('CRITICAL list returns newest-first, in both — and the fixture waits between inserts because the two implementations do not tie at the same resolution. Postgres timestamps carry microseconds and a JavaScript Date carries milliseconds, so back-to-back inserts TIE in the double and do NOT tie in Drizzle: the id tiebreak decides on one side and createdAt on the other, and any arm written without a real gap is a coin flip that passes until it does not.', async () => {
      if (!enabled()) return;
      const s = make();
      const t = await s.tenant();
      const first = await snap(s, t, 'first');
      await new Promise((r) => setTimeout(r, 5));
      const second = await snap(s, t, 'second');

      expect(
        (await s.repo.list({ accountId: t.accountId })).data.map((r) => r.id),
        'the snapshot list is oldest-first — a restore picker putting the oldest state on top',
      ).toEqual([second, first]);
    });

    it("CRITICAL delete is account-scoped, in both. Otherwise a known snapshot id is enough to destroy another customer's restore point.", async () => {
      if (!enabled()) return;
      const s = make();
      const mine = await s.tenant();
      const theirs = await s.tenant();
      const target = await snap(s, theirs, 'theirs');

      expect(
        await s.repo.delete({ id: target, accountId: mine.accountId }),
        'a snapshot was deleted by an account that does not own it',
      ).toBe(false);
      expect(
        await s.repo.findById({ id: target, accountId: theirs.accountId }),
        'the snapshot was destroyed despite the call reporting failure',
      ).not.toBeNull();
    });
  });
}

snapshotContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'ProfileSnapshotsRepo contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    snapshotContract('drizzle', drizzleSubject, () => dbReachable);

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // DRIZZLE-ONLY, and deliberately not a contract arm. The guarantee is a foreign key, and the
    // in-memory double has no `profiles` table for one to point at — there is nothing to cascade
    // FROM. Asserting it in the shared block would run against one implementation while reading as
    // though it ran against two.
    // ─────────────────────────────────────────────────────────────────────────────────────────
    it('CRITICAL purging the parent profile leaves the snapshot standing with a NULL parent (ON DELETE SET NULL). This is what makes restore-after-delete possible: the snapshot outlives the profile it came from, and restore falls back to parentArchetype/parentName. A cascade here would destroy every restore point the moment a customer tidied up.', async () => {
      if (!process.env.CI && !dbReachable) return;
      const c = client;
      if (!c) return;
      const s = drizzleSubject();
      const t = await seedTenant(c);
      const id = await snap(s, t, 'survives-its-parent');

      await c`DELETE FROM profiles WHERE id = ${t.profileId}::uuid`;

      const after = await s.repo.findById({ id, accountId: t.accountId });
      expect(after, 'the snapshot was destroyed with its parent profile').not.toBeNull();
      expect(
        after?.parentProfileId ?? null,
        'the parent id was left dangling rather than nulled',
      ).toBeNull();
    });

    it('CRITICAL deleting the ACCOUNT does take its snapshots (ON DELETE CASCADE). The two foreign keys on this table deliberately differ, and without this arm the one above reads as "snapshots survive everything" rather than "snapshots survive their profile".', async () => {
      if (!process.env.CI && !dbReachable) return;
      const c = client;
      if (!c) return;
      const s = drizzleSubject();
      const t = await seedTenant(c);
      const id = await snap(s, t, 'dies-with-its-account');

      await c`DELETE FROM profiles WHERE account_id = ${t.accountId}::uuid`;
      await c`DELETE FROM accounts WHERE id = ${t.accountId}`;

      const rows = await c`SELECT id FROM profile_snapshots WHERE id = ${id}::uuid`;
      expect(rows.length, 'the snapshot outlived the account it belonged to').toBe(0);
    });
  },
);
