// Drizzle-backed integration test for DrizzleEmailPreferencesRepo.
//
// Third of the zero-coverage repos (item 5e). This one decides whether a
// customer who asked to stop receiving an email still receives it, so the
// interesting properties are not "does it store a boolean" but the three ways a
// preference can leak or evaporate: across event types, across accounts, and
// across the delete-to-restore-default path.
//
// The storage model is worth stating because it is not the obvious one. Default
// is opted IN, and that default is represented by the ABSENCE of a row:
//
//   set(optedIn: true)   DELETEs the row, reverting to the default
//   set(optedIn: false)  upserts a row with opted_in = false
//   isOptedOut()         no row → false
//
// So an opt-out is a row and an opt-in is the lack of one. A bug that failed to
// delete on re-opt-in would leave a customer silently unsubscribed after they
// asked to resubscribe, and no error would be raised at any layer.
//
// Shared-database discipline as in the other db-* files: every arm is scoped to
// accounts this file seeded, and nothing counts rows globally.
//
// MUTATION-PROVED against email-preferences-repo.ts — control 7/7 green:
//
//   opting back IN no longer deletes the row                    1 red
//   isOptedOut ignores the event type                           1 red
//   isOptedOut ignores the account                              2 red
//   list is no longer scoped to the account                     3 red
//
// Ledger written 2026-08-15, re-measured rather than transcribed — see the note
// in db-legal-repo-drizzle.test.ts. The first two mutations are the pair this
// file's header argues for separate arms: one silences every email because a
// customer declined one, the other silences a customer because a neighbour
// declined. A single combined arm would pass with either predicate missing.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleEmailPreferencesRepo } from '../../src/db/email-preferences-repo.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let repo: DrizzleEmailPreferencesRepo | null = null;
const seededAccountIds: string[] = [];

async function seedAccount(): Promise<string> {
  if (!client) throw new Error('no client');
  const id = randomUUID();
  await client`
    INSERT INTO accounts (id, email, name, tier, status, created_at, updated_at)
    VALUES (${id}, ${`emailprefs-${id.slice(0, 8)}@example.test`}, ${'Prefs Fixture'},
            'free'::account_tier, 'active'::account_status, now(), now())`;
  seededAccountIds.push(id);
  return id;
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
    await client`SELECT 1 FROM account_email_preferences LIMIT 0`;
  } catch {
    dbReachable = false;
    await client.end({ timeout: 1 }).catch(() => {});
    client = null;
    return;
  }
  repo = new DrizzleEmailPreferencesRepo({
    client,
    db: drizzle(client, { schema }),
    close: async () => {},
  });
});

afterAll(async () => {
  if (client) {
    // account_email_preferences.account_id cascades from accounts.
    for (const id of seededAccountIds) {
      await client`DELETE FROM accounts WHERE id = ${id}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'DrizzleEmailPreferencesRepo (Drizzle path against real Postgres)',
  () => {
    it('CRITICAL the database is reachable and migrated. In CI the service and migrate step are part of the job, so an unreachable database must FAIL rather than let every arm below pass vacuously.', () => {
      if (!process.env.CI && !process.env.DATABASE_URL) return;
      expect(dbReachable, 'postgres reachable and the table present').toBe(true);
      expect(repo, 'repo constructed').not.toBeNull();
    });

    it('CRITICAL an account with no stored preference is NOT opted out. The default is opted in and is represented by the absence of a row, so this is the answer for every customer who has never touched the setting — the overwhelming majority of them.', async () => {
      if (!dbReachable || !repo) return;
      const accountId = await seedAccount();
      expect(await repo.isOptedOut(accountId, 'billing-receipt'), 'default is opted in').toBe(
        false,
      );
      expect((await repo.list(accountId)).length, 'and no rows exist').toBe(0);
    });

    it('CRITICAL opting out is recorded and reported. This is the customer asking to stop receiving a specific email, and the only durable record of that request is the row this writes.', async () => {
      if (!dbReachable || !repo) return;
      const accountId = await seedAccount();
      await repo.set(accountId, 'billing-receipt', false);
      expect(await repo.isOptedOut(accountId, 'billing-receipt'), 'now opted out').toBe(true);

      const rows = await repo.list(accountId);
      expect(rows.length, 'one stored preference').toBe(1);
      expect(rows[0]?.optedIn, 'stored as opted out').toBe(false);
    });

    it('CRITICAL opting back IN removes the row rather than storing true. The default lives in the absence of a row, so a re-opt-in that merely flipped a column would work — but a re-opt-in that failed to delete would leave the customer silently unsubscribed after asking to resubscribe, with no error at any layer.', async () => {
      if (!dbReachable || !repo) return;
      const accountId = await seedAccount();
      await repo.set(accountId, 'tier-changed', false);
      expect(await repo.isOptedOut(accountId, 'tier-changed'), 'opted out first').toBe(true);

      await repo.set(accountId, 'tier-changed', true);
      expect(await repo.isOptedOut(accountId, 'tier-changed'), 'opted back in').toBe(false);
      expect((await repo.list(accountId)).length, 'and the row is gone, not flipped').toBe(0);
    });

    it('CRITICAL opting out twice is idempotent rather than a unique-violation. The upsert targets the (account, event) pair, and a customer clicking unsubscribe twice — or two tabs racing — must not surface a 500.', async () => {
      if (!dbReachable || !repo) return;
      const accountId = await seedAccount();
      await repo.set(accountId, 'signup-welcome', false);
      await expect(repo.set(accountId, 'signup-welcome', false)).resolves.toBeUndefined();
      expect((await repo.list(accountId)).length, 'still exactly one row').toBe(1);
    });

    it('CRITICAL opting out of one event does not silence the others. The preference is keyed by (account, event_type); a filter that dropped the event would unsubscribe a customer from everything because they declined one message.', async () => {
      if (!dbReachable || !repo) return;
      const accountId = await seedAccount();
      await repo.set(accountId, 'signup-welcome', false);

      expect(await repo.isOptedOut(accountId, 'signup-welcome'), 'the declined one').toBe(true);
      expect(await repo.isOptedOut(accountId, 'billing-receipt'), 'others unaffected').toBe(false);
      expect(await repo.isOptedOut(accountId, 'tier-changed'), 'and this one too').toBe(false);
    });

    it("CRITICAL one account's opt-out never applies to another. The account id is the only thing scoping these reads, and a missing predicate would either silence a customer who never asked or keep emailing one who did.", async () => {
      if (!dbReachable || !repo) return;
      const mine = await seedAccount();
      const theirs = await seedAccount();
      await repo.set(theirs, 'billing-receipt', false);

      expect(await repo.isOptedOut(mine, 'billing-receipt'), 'not opted out by a neighbour').toBe(
        false,
      );
      expect(await repo.isOptedOut(theirs, 'billing-receipt'), 'their own choice holds').toBe(true);
      expect((await repo.list(mine)).length, 'and list is scoped too').toBe(0);
    });
  },
);
