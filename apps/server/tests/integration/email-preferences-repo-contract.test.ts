// V-1208 — one contract, executed against BOTH implementations of `EmailPreferencesRepo`.
//
// The third of the twenty-nine, and the SECOND half of a drift V-1201 introduced. That commit gave
// two repos an `ORDER BY` so customer-facing lists stop reordering between page loads, and updated
// neither of their in-memory doubles. V-1207 found and fixed the oauth-links half; this is the
// email-preferences half, which had gone unexamined because finding one instance felt like finding
// the instance. A commit that touches two implementations of two interfaces can drift both.
//
//   DrizzleEmailPreferencesRepo.list  ->  .orderBy(asc(accountEmailPreferences.eventType))
//   InMemoryEmailPreferencesRepo.list ->  for (const r of this.rows.values())   // Map order
//
// WHY THE ORDERING ARM USES THESE TWO EVENTS. `tier-changed` is written first and `billing-receipt`
// second, so insertion order and alphabetical order DISAGREE. Any pair chosen in alphabetical order
// would pass against a double that does not sort at all, which is the same vacuity trap as V-1207's
// backdate — a positive control that cannot fail is not a control.
//
// THE SEMANTIC ARM IS `set(optedIn = true)`. The interface documents a default-opted-in convention:
// opting IN deletes the row rather than storing `true`, so absence and consent are the same state.
// That is easy to reimplement as "store true", which would still satisfy `isOptedOut` while leaving
// a row behind in `list` — agreeing on the question customers ask and disagreeing on the one the
// preferences UI renders.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import type { EmailPreferencesRepo } from '../../src/services/email-preferences.js';
import { DrizzleEmailPreferencesRepo } from '../../src/db/email-preferences-repo.js';
import { InMemoryEmailPreferencesRepo } from './_helpers/in-memory-email-preferences-repo.js';
import type * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

/** Written in this order; sorted the other way. That disagreement is what the arm measures. */
const FIRST_WRITTEN = 'tier-changed' as const;
const SECOND_WRITTEN = 'billing-receipt' as const;

let client: ReturnType<typeof postgres> | null = null;
let dbReachable = false;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM account_email_preferences LIMIT 0`;
    dbReachable = true;
  } catch {
    /* the Drizzle half skips; the in-memory half still runs */
  }
  await probe.end({ timeout: 1 }).catch(() => {});
  if (dbReachable) client = postgres(DB_URL, { max: 2 });
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM account_email_preferences WHERE account_id = ${accountId}`.catch(
        () => {},
      );
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

interface Subject {
  repo: EmailPreferencesRepo;
  account: () => Promise<string>;
}

function inMemorySubject(): Subject {
  return {
    repo: new InMemoryEmailPreferencesRepo(),
    account: () => Promise.resolve(randomUUID()),
  };
}

function drizzleSubject(): Subject {
  const c = client;
  if (!c) throw new Error('no client');
  const db = drizzle(c) as unknown as ReturnType<typeof drizzle<typeof schema>>;
  return {
    repo: new DrizzleEmailPreferencesRepo({ client: c, db, close: async () => {} }),
    account: async () => {
      const id = randomUUID();
      seeded.push(id);
      await c`INSERT INTO accounts (id, email) VALUES (${id}, ${`prefs-contract-${id}@test.local`})`;
      return id;
    },
  };
}

function emailPreferencesRepoContract(
  label: string,
  make: () => Subject,
  enabled: () => boolean,
): void {
  describe(`EmailPreferencesRepo contract — ${label}`, () => {
    it("CRITICAL list is account-scoped, and returns the asking account's own opt-outs. Both halves matter: an implementation returning nothing at all would satisfy the exclusion on its own.", async () => {
      if (!enabled()) return;
      const { repo, account } = make();
      const owner = await account();
      const stranger = await account();
      await repo.set(owner, FIRST_WRITTEN, false);

      expect((await repo.list(owner)).map((r) => r.eventType)).toEqual([FIRST_WRITTEN]);
      expect(await repo.list(stranger), 'a foreign account read the opt-out').toEqual([]);
    });

    it('CRITICAL list orders by eventType, in both. The customer sees this order in the email-preferences UI, and the fixture writes tier-changed BEFORE billing-receipt so insertion order and alphabetical order disagree — otherwise an implementation that never sorts would pass.', async () => {
      if (!enabled()) return;
      const { repo, account } = make();
      const owner = await account();
      await repo.set(owner, FIRST_WRITTEN, false);
      await repo.set(owner, SECOND_WRITTEN, false);

      expect(
        (await repo.list(owner)).map((r) => r.eventType),
        'the list is in write order, not eventType order',
      ).toEqual([SECOND_WRITTEN, FIRST_WRITTEN]);
    });

    it('CRITICAL opting back IN removes the row rather than storing true, in both. The interface makes absence and consent the same state, so an implementation that stored `true` would answer isOptedOut correctly and still leave a row the preferences UI renders as an explicit choice the customer never made.', async () => {
      if (!enabled()) return;
      const { repo, account } = make();
      const owner = await account();
      await repo.set(owner, FIRST_WRITTEN, false);
      expect(await repo.isOptedOut(owner, FIRST_WRITTEN), 'the opt-out did not take').toBe(true);

      await repo.set(owner, FIRST_WRITTEN, true);

      expect(await repo.isOptedOut(owner, FIRST_WRITTEN), 'opting back in did not take').toBe(
        false,
      );
      expect(await repo.list(owner), 'a row survived opting back in').toEqual([]);
    });

    it('CRITICAL isOptedOut defaults to false for an event the customer never touched. Absence means consent here, so an implementation that treated a missing row as an opt-out would silently stop sending mail the customer expects.', async () => {
      if (!enabled()) return;
      const { repo, account } = make();
      const owner = await account();

      expect(
        await repo.isOptedOut(owner, SECOND_WRITTEN),
        'an untouched event reported as opted out',
      ).toBe(false);
    });

    it('CRITICAL set upserts on (accountId, eventType) rather than appending, in both. account_email_preferences is keyed on that pair, so a double that pushed a second row would let list report one event twice.', async () => {
      if (!enabled()) return;
      const { repo, account } = make();
      const owner = await account();
      await repo.set(owner, FIRST_WRITTEN, false);
      await repo.set(owner, FIRST_WRITTEN, false);

      expect(
        (await repo.list(owner)).map((r) => r.eventType),
        'the same event was recorded twice',
      ).toEqual([FIRST_WRITTEN]);
    });
  });
}

emailPreferencesRepoContract('in-memory double', inMemorySubject, () => true);

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'EmailPreferencesRepo contract — real',
  () => {
    it('CRITICAL the database is reachable, so the Drizzle half below is not silently empty', () => {
      if (!process.env.CI && !dbReachable) return;
      expect(dbReachable, `could not reach ${DB_URL} — the contract would not be exercised`).toBe(
        true,
      );
    });

    emailPreferencesRepoContract('drizzle', drizzleSubject, () => dbReachable);
  },
);
