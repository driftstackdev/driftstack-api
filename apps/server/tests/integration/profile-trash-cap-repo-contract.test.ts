// V-1222 — one contract for the profile trash/cap boundary, against BOTH implementations of
// `ProfilesRepo`.
//
// The thirteenth of the twenty-nine, and the interesting thing about it is that it states the
// OPPOSITE rule to V-1219 in the same codebase:
//
//   session cap   counts a session whose STATUS is terminal but which was never destroyed
//                 -> an errored session still holds a slot
//   profile cap   excludes a profile that has been trashed
//                 -> a trashed profile frees a slot
//
// Both are correct and the difference is not an inconsistency: a session row may correspond to a
// driver session that still exists somewhere, so the platform cannot reclaim the slot on status
// alone, whereas a trashed profile is inert — its row, DEK and sealed blob survive only for
// restore and purge. But two caps with two meanings of "still counts", a few files apart, is
// exactly the pair someone harmonises in the wrong direction. Pinning both is what makes the
// asymmetry deliberate rather than accidental.
//
// V-1194 found real defects on this exact boundary — trashing freed no cap slot, and the bin leaked
// into the live grid — and fixed the Drizzle side. Whether the double reflected those fixes was
// never asserted; it does, and this file is what keeps that true.
//
// THE BIN ARM IS LOAD-BEARING. "Trashed profiles are hidden from findById and list" is satisfied by
// an implementation that simply deletes the row, which would silently turn a recoverable trash into
// a destructive delete. Asserting the profile is still in `listTrashed` — and that `restore` brings
// it back into both the count and the live list — is what separates hidden from gone.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { ProfilesRepo } from '../../src/services/profiles.js';
import { DrizzleProfilesRepo } from '../../src/db/profiles-repo.js';
import { InMemoryProfilesRepo } from './_helpers/in-memory-profiles-repo.js';
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
    await probe`SELECT 1 FROM profiles LIMIT 0`;
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
      await client`DELETE FROM profiles WHERE account_id = ${a}::uuid`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${a}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Subject {
  repo: ProfilesRepo;
  account: () => Promise<string>;
}

function inMemorySubject(): Subject {
  return {
    repo: new InMemoryProfilesRepo(),
    account: () => Promise.resolve(randomUUID()),
  };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleProfilesRepo({ client: c, db, close: async () => {} }),
    account: async () => {
      const id = randomUUID();
      seeded.push(id);
      await c`INSERT INTO accounts (id, email) VALUES (${id}, ${`prof-${id}@test.local`})`;
      return id;
    },
  };
}

async function addProfile(s: Subject, accountId: string, name: string): Promise<string> {
  const row = await s.repo.insert({
    accountId,
    name,
    archetype: ARCHETYPE,
    description: null,
  });
  return row.id;
}

const liveIds = async (s: Subject, accountId: string): Promise<string[]> =>
  (await s.repo.list({ accountId })).data.map((r) => r.id);

function profileTrashCapContract(label: string, make: () => Subject, enabled: () => boolean): void {
  describe(`ProfilesRepo trash/cap contract — ${label}`, () => {
    it('CRITICAL trashing a profile FREES a cap slot, in both. This is the opposite of the session cap, which keeps counting an errored session that was never destroyed — a trashed profile is inert, so the slot comes back. V-1194 found this exact boundary wrong once already.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const id = await addProfile(s, account, `keep-${randomUUID().slice(0, 8)}`);
      expect(await s.repo.countByAccount(account), 'the new profile did not count').toBe(1);

      expect(await s.repo.delete({ id, accountId: account }), 'the trash call failed').toBe(true);

      expect(
        await s.repo.countByAccount(account),
        'trashing the profile did not release its cap slot',
      ).toBe(0);
    });

    it('CRITICAL an account AT its cap is told it is at its cap, even when the same request is also malformed, in both. Production reaches the wrapped-DEK validation only while building the row — `preallocatedProfileId` is evaluated inside .values(), after the count — so Postgres answers limitExceeded and the double threw instead. Two different refusals for one request is the kind of divergence that makes a service test agree with a fixture and disagree with the database.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      await addProfile(s, account, `at-cap-${randomUUID().slice(0, 8)}`);

      const outcome = await s.repo.insertWithLimit(
        {
          accountId: account,
          name: `over-${randomUUID().slice(0, 8)}`,
          archetype: ARCHETYPE,
          description: null,
          // Malformed on purpose: a wrapped DEK with no preallocated id. The cap is reached
          // first, so this never gets looked at.
          wrappedDek: 'dek-without-a-preallocated-id',
        },
        1,
      );

      expect(outcome, 'the cap refusal did not come back as a value').toMatchObject({
        limitExceeded: true,
      });
    });

    it('CRITICAL a transfer whose insert fails leaves the SOURCE profile live, in both. The whole transfer is one transaction in production, so a failed insert rolls the retirement back; the double retired the source with a plain write and then delegated, leaving a profile retired with no successor. Postgres cannot reach that state, and a fixture that can teaches every test standing on it that a failed transfer is allowed to lose the original.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const sourceId = await addProfile(s, account, `src-${randomUUID().slice(0, 8)}`);

      await expect(
        s.repo.transferAtomic({
          source: { id: sourceId, accountId: account },
          insert: {
            accountId: account,
            name: `dst-${randomUUID().slice(0, 8)}`,
            archetype: ARCHETYPE,
            description: null,
            wrappedDek: 'dek-without-a-preallocated-id',
          },
          limit: null,
        }),
        'the malformed transfer was accepted — the arm below would prove nothing',
      ).rejects.toThrow();

      expect(
        await s.repo.findById({ id: sourceId, accountId: account }),
        'the source profile was retired by a transfer that failed',
      ).not.toBeNull();
      expect(
        await liveIds(s, account),
        'the source profile left the live list after a failed transfer',
      ).toContain(sourceId);
    });

    it('CRITICAL a profile key envelope comes back to the OWNER and to nobody else, and disappears when the profile is trashed, in both. `wrapped_dek` is the profile\u2019s key envelope, read only through this method so the secret never rides a customer-facing record. The double used to accept one on insert, validate it, then discard it and answer null forever — which made the unwrap path unreachable in every double-backed test AND made this very assertion vacuous, because a stub returning null is indistinguishable from a tenancy refusal.', async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.account();
      const stranger = await s.account();

      // A wrapped DEK requires a preallocated id — both implementations reject it otherwise.
      const id = randomUUID();
      await s.repo.insert({
        id,
        accountId: owner,
        name: `dek-${randomUUID().slice(0, 8)}`,
        archetype: ARCHETYPE,
        description: null,
        wrappedDek: 'v2:wrapped-dek-material',
      });

      expect(
        await s.repo.getWrappedDek({ id, accountId: owner }),
        'the owner could not read the key envelope it just stored',
      ).toBe('v2:wrapped-dek-material');
      expect(
        await s.repo.getWrappedDek({ id, accountId: stranger }),
        'another account read this profile\u2019s key envelope',
      ).toBeNull();
      expect(
        await s.repo.getWrappedDek({ id: randomUUID(), accountId: owner }),
        'an unknown profile id produced a key envelope',
      ).toBeNull();

      expect(await s.repo.delete({ id, accountId: owner }), 'the trash call failed').toBe(true);
      expect(
        await s.repo.getWrappedDek({ id, accountId: owner }),
        'a trashed profile still hands out its key envelope',
      ).toBeNull();
    });

    it('CRITICAL a profile stored WITHOUT a key envelope reports null rather than someone else\u2019s, in both. Paired with the arm above so neither passes by returning a constant: one requires a real value back, this one requires null, and a repo that always answered either way fails one of them.', async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.account();
      const plain = await addProfile(s, owner, `plain-${randomUUID().slice(0, 8)}`);

      expect(
        await s.repo.getWrappedDek({ id: plain, accountId: owner }),
        'a profile with no stored key envelope produced one',
      ).toBeNull();
    });

    it('CRITICAL a trashed profile is hidden from findById and list, in both. The bin must not leak into the live grid — V-1194 found it doing exactly that.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const kept = await addProfile(s, account, `kept-${randomUUID().slice(0, 8)}`);
      const binned = await addProfile(s, account, `binned-${randomUUID().slice(0, 8)}`);
      await s.repo.delete({ id: binned, accountId: account });

      expect(
        await s.repo.findById({ id: binned, accountId: account }),
        'a trashed profile resolved through the live read',
      ).toBeNull();
      expect(await liveIds(s, account), 'the bin leaked into the live list').toEqual([kept]);
    });

    it('CRITICAL a trashed profile is still IN the bin, in both. Without this arm the two above are satisfied by an implementation that hard-deletes the row, turning a recoverable trash into a destructive delete with the same observable surface.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const binned = await addProfile(s, account, `binned-${randomUUID().slice(0, 8)}`);
      await s.repo.delete({ id: binned, accountId: account });

      expect(
        (await s.repo.listTrashed({ accountId: account })).map((r) => r.id),
        'the trashed profile is not in the bin — it was destroyed, not trashed',
      ).toEqual([binned]);
    });

    it('CRITICAL restore returns the profile to the count AND the live list, in both. A restore that brought the row back without releasing it from the bin, or without restoring its cap slot, would leave the customer a profile they can see and cannot use.', async () => {
      if (!enabled()) return;
      const s = make();
      const account = await s.account();
      const id = await addProfile(s, account, `back-${randomUUID().slice(0, 8)}`);
      await s.repo.delete({ id, accountId: account });

      expect(
        await s.repo.restore({ id, accountId: account }),
        'restore did not report success',
      ).toBe('restored');

      expect(await s.repo.countByAccount(account), 'the restored profile does not count').toBe(1);
      expect(
        await liveIds(s, account),
        'the restored profile is missing from the live list',
      ).toEqual([id]);
      expect(
        await s.repo.listTrashed({ accountId: account }),
        'the restored profile is still in the bin',
      ).toEqual([]);
    });

    it("CRITICAL the cap and the bin are account-scoped, in both. A neighbour's profiles counting against this account's limit would refuse a customer a profile they are entitled to, and a neighbour's bin is somebody else's data.", async () => {
      if (!enabled()) return;
      const s = make();
      const owner = await s.account();
      const stranger = await s.account();
      const theirs = await addProfile(s, stranger, `theirs-${randomUUID().slice(0, 8)}`);
      await s.repo.delete({ id: theirs, accountId: stranger });
      await addProfile(s, stranger, `live-${randomUUID().slice(0, 8)}`);

      expect(
        await s.repo.countByAccount(owner),
        "another account's profile counted against this cap",
      ).toBe(0);
      expect(
        await s.repo.listTrashed({ accountId: owner }),
        "another account's bin was visible",
      ).toEqual([]);
    });
  });
}

profileTrashCapContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'ProfilesRepo trash/cap contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    profileTrashCapContract('drizzle', drizzleSubject, () => dbReachable);
  },
);
