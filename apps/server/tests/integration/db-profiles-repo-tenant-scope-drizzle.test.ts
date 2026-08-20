// Tenant isolation for SINGLE-ROW profile operations, against real Postgres.
//
// The service does not re-check ownership. `ProfilesService.get` is
// `const row = await this.repo.findById(args); if (row === null) throw NotFound`,
// so the `eq(profiles.accountId, …)` predicate in the repo's WHERE clause IS the
// isolation boundary — not a second line of defence behind one.
//
// What existed before this file:
//   - `cross-account-profile-isolation.test.ts` drives HTTP routes through
//     `buildTestApp`, which wires **InMemory** repos. It proves the RULE against a
//     double that re-implements the same filtering by hand, and never executes a
//     line of the shipped SQL.
//   - `db-profiles-repo-keyset-drizzle` seeds two accounts and does exercise the
//     LIST predicates on real Postgres.
//
// Measured, not assumed: neutralising the account predicate on `findById` leaves
// every one of those green — the route-level isolation test, the keyset test, the
// restore-quota, in-use-concurrency, terminated-account-purge and
// snapshot-restore-dek tests. The list path is covered on real SQL; the
// single-row paths were not covered by anything that runs the real SQL.
//
// So a refactor that rewrote one WHERE clause could hand account A account B's
// profile — the cookies and storage of somebody else's browser session — with a
// fully green suite. These arms run the shipped Drizzle repo against Postgres.
//
// `recordSave` is included deliberately even though it returns void: a
// wrong-account call is a SILENT no-op, so the only way to catch a leak there is
// to read the row back and prove it did not move.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleProfilesRepo } from '../../src/db/profiles-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seeded: string[] = [];

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
    await client`SELECT 1 FROM profiles LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
  }
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM profiles WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleProfilesRepo single-row tenant scoping (real Postgres)',
  () => {
    it('CRITICAL a profile is unreachable, unmodifiable and untouchable from another account — the repo WHERE clause is the isolation boundary, since the service throws NotFound purely on a null row and never re-checks ownership itself', async () => {
      if (!dbReachable || !client) {
        // Same contract as the sibling real-PG tests: quiet skip locally, hard
        // failure in CI. A vacuous pass on a tenant-isolation test is worse than
        // no test — it reports the boundary as proven when nothing ran.
        if (process.env.CI) {
          throw new Error(
            'real-PG tenant-scope test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });

      const owner = randomUUID();
      const stranger = randomUUID();
      seeded.push(owner, stranger);
      await client`INSERT INTO accounts (id, email) VALUES (${owner}, ${`tenant-owner-${owner}@test.local`})`;
      await client`INSERT INTO accounts (id, email) VALUES (${stranger}, ${`tenant-stranger-${stranger}@test.local`})`;
      const [created] = await client`
        INSERT INTO profiles (account_id, name) VALUES (${owner}, ${`tenant-scope-${owner}`})
        RETURNING id`;
      const profileId = created?.id as string;
      expect(profileId).toBeTruthy();

      // Positive control first: the owner CAN read it. Without this the arms
      // below could pass because the fixture was never visible to anyone.
      const mine = await repo.findById({ id: profileId, accountId: owner });
      expect(mine?.id).toBe(profileId);

      // READ — the IDOR case. A row that exists, asked for by the wrong account.
      const theirs = await repo.findById({ id: profileId, accountId: stranger });
      expect(theirs, "another account's profile must not be readable by id").toBeNull();

      // WRITE — update matches no row for a stranger, and the repo turns "no row
      // returned" into a throw rather than silently reporting success.
      await expect(
        repo.update({ id: profileId, accountId: stranger, updates: { note: 'stolen' } }),
      ).rejects.toThrow(/no row returned/);

      // The write must not have landed anyway. Asserted by reading the row back
      // as the OWNER: a test that only checked the rejection would still pass if
      // the UPDATE had touched the row before failing to return it.
      const afterUpdate = await repo.findById({ id: profileId, accountId: owner });
      expect(afterUpdate?.note ?? null).toBeNull();

      // SILENT PATH — recordSave returns void, so a wrong-account call cannot be
      // caught by its return value. Read the column back directly.
      await repo.recordSave({
        id: profileId,
        accountId: stranger,
        at: new Date(),
        sizeBytes: 4242,
      });
      const [row] = await client`
        SELECT last_saved_at, size_bytes FROM profiles WHERE id = ${profileId}`;
      expect(row?.last_saved_at ?? null, 'a stranger must not stamp a save').toBeNull();
      expect(row?.size_bytes ?? null).toBeNull();

      // And the owner CAN, so the arm above is a boundary and not a broken call.
      await repo.recordSave({ id: profileId, accountId: owner, at: new Date(), sizeBytes: 4242 });
      const [mineAfter] = await client`
        SELECT last_saved_at, size_bytes FROM profiles WHERE id = ${profileId}`;
      expect(mineAfter?.last_saved_at ?? null).not.toBeNull();
      expect(Number(mineAfter?.size_bytes)).toBe(4242);
    });

    // The three highest-consequence of the predicates left open when this file
    // was first written. Chosen over the rest of the sixteen because of what they
    // hand over, not because they were next in the list:
    //
    //   getWrappedDek — the profile's KEY ENVELOPE. Everything else here leaks a
    //     row; this one leaks the wrapping of the material that decrypts it.
    //   delete        — a soft-delete of somebody else's profile is data loss for
    //     another customer, caused by a caller who never owned the row.
    //   restore       — the inverse write, and the only one that also has to
    //     resolve a NAME against the account, so an unscoped restore could collide
    //     one account's profile with another's.
    it("CRITICAL a stranger cannot read another account's key envelope, trash their profile, or restore it — the destructive and key-material paths, none of which any test executed against real SQL", async () => {
      if (!dbReachable || !client) {
        if (process.env.CI) {
          throw new Error(
            'real-PG tenant-scope test: database unreachable/unmigrated in CI — vacuous pass is forbidden',
          );
        }
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });

      const owner = randomUUID();
      const stranger = randomUUID();
      seeded.push(owner, stranger);
      await client`INSERT INTO accounts (id, email) VALUES (${owner}, ${`dek-owner-${owner}@test.local`})`;
      await client`INSERT INTO accounts (id, email) VALUES (${stranger}, ${`dek-stranger-${stranger}@test.local`})`;
      const [made] = await client`
        INSERT INTO profiles (account_id, name, wrapped_dek)
        VALUES (${owner}, ${`dek-scope-${owner}`}, ${'v2:wrapped-dek-material'})
        RETURNING id`;
      const id = made?.id as string;

      // KEY MATERIAL — positive control first, so a null from a broken query
      // cannot masquerade as a boundary.
      expect(await repo.getWrappedDek({ id, accountId: owner })).toBe('v2:wrapped-dek-material');
      expect(
        await repo.getWrappedDek({ id, accountId: stranger }),
        "another account's key envelope must not be readable",
      ).toBeNull();

      // DESTRUCTIVE — a stranger's delete must report failure AND leave the row
      // alive. Checking only the boolean would miss a soft-delete that landed and
      // then reported nothing.
      expect(await repo.delete({ id, accountId: stranger })).toBe(false);
      const [afterStrangerDelete] = await client`
        SELECT deleted_at FROM profiles WHERE id = ${id}`;
      expect(
        afterStrangerDelete?.deleted_at ?? null,
        "a stranger must not trash another account's profile",
      ).toBeNull();

      // The owner CAN, so the arm above is a boundary and not a broken call.
      expect(await repo.delete({ id, accountId: owner })).toBe(true);
      const [afterOwnerDelete] = await client`
        SELECT deleted_at FROM profiles WHERE id = ${id}`;
      expect(afterOwnerDelete?.deleted_at ?? null).not.toBeNull();

      // RESTORE — now that the row is genuinely trashed, a stranger must not be
      // able to bring it back. `not_found` rather than a throw is this method's
      // way of saying the row is not theirs.
      expect(await repo.restore({ id, accountId: stranger })).toBe('not_found');
      const [afterStrangerRestore] = await client`
        SELECT deleted_at FROM profiles WHERE id = ${id}`;
      expect(
        afterStrangerRestore?.deleted_at ?? null,
        'a stranger must not restore it either',
      ).not.toBeNull();

      // …and the owner can, which also proves the fixture was restorable at all.
      expect(await repo.restore({ id, accountId: owner })).toBe('restored');
      const [afterOwnerRestore] = await client`
        SELECT deleted_at FROM profiles WHERE id = ${id}`;
      expect(afterOwnerRestore?.deleted_at ?? null).toBeNull();
    });

    // ── V-1190 — the same sweep, one method at a time. Neutralising ALL 22 account
    // predicates in this repo fired 11 assertions, which names most methods as covered.
    // Neutralising only the SIX they did not name left the integration suite green apart
    // from one assertion, and bisecting the six showed that assertion covers exactly ONE
    // of them (`recordSave`). These three were reachable, unguarded, and silent.

    it('CRITICAL countByAccount counts only the asking account. It is the input to the profile cap, so unscoped it sums the whole platform: a customer is refused a profile they are entitled to because OTHER customers have profiles, and the refusal is indistinguishable from their own cap being full.', async () => {
      if (!dbReachable || !client) {
        if (process.env.CI)
          throw new Error('real-PG tenant-scope test: database unreachable in CI');
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });
      const owner = randomUUID();
      const other = randomUUID();
      seeded.push(owner, other);
      await client`INSERT INTO accounts (id, email) VALUES (${owner}, ${`count-owner-${owner}@test.local`})`;
      await client`INSERT INTO accounts (id, email) VALUES (${other}, ${`count-other-${other}@test.local`})`;
      await client`INSERT INTO profiles (account_id, name) VALUES (${other}, ${`other-${other}`})`;

      expect(
        await repo.countByAccount(owner),
        "another account's profiles counted toward this one",
      ).toBe(0);
      await client`INSERT INTO profiles (account_id, name) VALUES (${owner}, ${`mine-${owner}`})`;
      expect(await repo.countByAccount(owner), 'the account cannot count its own profile').toBe(1);
    });

    it("CRITICAL findByAccountAndName does not reach across accounts. Names are customer-chosen and often obvious, so an unscoped lookup turns a guessed label into another account's profile row without needing its id at all.", async () => {
      if (!dbReachable || !client) {
        if (process.env.CI)
          throw new Error('real-PG tenant-scope test: database unreachable in CI');
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });
      const owner = randomUUID();
      const stranger = randomUUID();
      seeded.push(owner, stranger);
      await client`INSERT INTO accounts (id, email) VALUES (${owner}, ${`name-owner-${owner}@test.local`})`;
      await client`INSERT INTO accounts (id, email) VALUES (${stranger}, ${`name-stranger-${stranger}@test.local`})`;
      const shared = `shared-label-${owner}`;
      await client`INSERT INTO profiles (account_id, name) VALUES (${owner}, ${shared})`;

      expect((await repo.findByAccountAndName({ accountId: owner, name: shared }))?.name).toBe(
        shared,
      );
      expect(
        await repo.findByAccountAndName({ accountId: stranger, name: shared }),
        "a stranger resolved another account's profile by name",
      ).toBeNull();
    });

    it("CRITICAL transferAtomic cannot claim a source profile owned by someone else. The source claim is an UPDATE that retires the row before inserting the destination copy, so an unscoped claim does not merely read another account's profile — it MOVES it, retiring the original in the victim's account.", async () => {
      if (!dbReachable || !client) {
        if (process.env.CI)
          throw new Error('real-PG tenant-scope test: database unreachable in CI');
        return;
      }
      const db = drizzle(client) as unknown as ReturnType<typeof drizzle<typeof schema>>;
      const repo = new DrizzleProfilesRepo({ client, db, close: async () => {} });
      const victim = randomUUID();
      const attacker = randomUUID();
      seeded.push(victim, attacker);
      await client`INSERT INTO accounts (id, email) VALUES (${victim}, ${`xfer-victim-${victim}@test.local`})`;
      await client`INSERT INTO accounts (id, email) VALUES (${attacker}, ${`xfer-attacker-${attacker}@test.local`})`;
      const [row] = await client`
        INSERT INTO profiles (account_id, name) VALUES (${victim}, ${`victim-${victim}`}) RETURNING id`;
      const sourceId = row?.id as string;

      const result = await repo.transferAtomic({
        source: { id: sourceId, accountId: attacker },
        insert: {
          accountId: attacker,
          name: `stolen-${attacker}`,
          archetype: 'iphone17_ios18_7_safari26_4',
          description: null,
        },
        limit: null,
      });
      expect(result, 'the attacker transferred a profile they do not own').toEqual({
        sourceAlreadyRetired: true,
      });

      const [after] =
        await client`SELECT account_id, deleted_at FROM profiles WHERE id = ${sourceId}`;
      expect(
        after?.deleted_at ?? null,
        "the victim's profile was retired by the transfer",
      ).toBeNull();
      expect(after?.account_id, "the victim's profile changed hands").toBe(victim);
    });
  },
);
