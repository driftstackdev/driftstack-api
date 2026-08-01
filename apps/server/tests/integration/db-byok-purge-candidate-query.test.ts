// The query that decides whose BYOK credential gets erased.
//
// `findDeletedAccountIdsWithByokKeyBefore` is the candidate list for an
// irreversible erasure: every id it returns has its stored Anthropic API key
// ciphertext cleared. Until now the only coverage was in-memory doubles in the
// sweeper tests — those prove the sweeper's ORCHESTRATION (arms run
// independently, failures are isolated, counts are reported) and say nothing
// about the SQL. The three predicates that decide who is in the list had never
// executed against Postgres.
//
// That is the wrong thing to leave untested. The sweeper's fixtures return
// whatever list the test author typed; the real query is what runs in
// production, and a predicate error here erases a live customer's credential or
// silently retains a terminated one past the disclosed 30-day window. Both
// directions matter and both are checked below.
//
// Also pins the per-tick bound. This was the last unbounded erasure arm — the
// other five cap at 500 — and the sweeper consumes this list in a loop, one
// clearKey call per account, so an unbounded first run against a production
// backlog issues an unbounded number of sequential credential writes.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

import { DrizzleAccountDeletionPurgeRepo } from '../../src/db/account-deletion-purge-repo.js';
import * as schema from '../../src/db/schema.js';

const DEFAULT_DB_URL = 'postgres://driftstack:driftstack@localhost:5432/driftstack';
const DB_URL = process.env.DATABASE_URL ?? DEFAULT_DB_URL;
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-01T12:00:00.000Z');
const CUTOFF = new Date(NOW.getTime() - 30 * DAY_MS);

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
let repo: DrizzleAccountDeletionPurgeRepo | null = null;
const seeded: string[] = [];

beforeAll(async () => {
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM accounts LIMIT 0`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 4 });
  const db = drizzle(client, { schema });
  repo = new DrizzleAccountDeletionPurgeRepo({ client, db, close: async () => {} });
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

async function seedAccount(args: {
  status: 'active' | 'suspended' | 'deleted';
  deletedDaysAgo: number | null;
  hasKey: boolean;
}): Promise<string> {
  if (!client) throw new Error('no client');
  const accountId = randomUUID();
  seeded.push(accountId);
  const deletedAt =
    args.deletedDaysAgo === null
      ? null
      : new Date(NOW.getTime() - args.deletedDaysAgo * DAY_MS).toISOString();
  await client`
    INSERT INTO accounts (id, email, status, deleted_at, byok_anthropic_api_key_ciphertext)
    VALUES (
      ${accountId},
      ${`byok-candidate-${accountId}@test.local`},
      ${args.status}::account_status,
      ${deletedAt},
      ${args.hasKey ? Buffer.from('ciphertext') : null}
    )`;
  return accountId;
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'the BYOK purge candidate query selects exactly the erasable accounts',
  () => {
    it('CRITICAL the database is reachable. Every case is a SQL round-trip; if the connection failed they would skip and this file would report success while proving nothing about which credentials get erased.', () => {
      expect(dbReachable, `could not reach ${DB_URL} — these results would be meaningless`).toBe(
        true,
      );
    });

    it('CRITICAL a terminated account past the cutoff WITH a key is selected. The positive arm — without it every exclusion below is satisfied by a query that returns nothing at all, which would retain every credential forever and still look green.', async () => {
      const id = await seedAccount({ status: 'deleted', deletedDaysAgo: 45, hasKey: true });

      const ids = await repo!.findDeletedAccountIdsWithByokKeyBefore(CUTOFF);

      expect(ids, 'the erasable account is in the candidate list').toContain(id);
    });

    it('CRITICAL an ACTIVE account with a key is NEVER selected. This list drives an irreversible erasure of a paying customer’s stored Anthropic credential.', async () => {
      const id = await seedAccount({ status: 'active', deletedDaysAgo: null, hasKey: true });

      const ids = await repo!.findDeletedAccountIdsWithByokKeyBefore(CUTOFF);

      expect(ids).not.toContain(id);
    });

    it('CRITICAL a SUSPENDED account with a key is NEVER selected. Suspension is a billing state a customer returns from; only `deleted` licenses erasure.', async () => {
      const id = await seedAccount({ status: 'suspended', deletedDaysAgo: null, hasKey: true });

      const ids = await repo!.findDeletedAccountIdsWithByokKeyBefore(CUTOFF);

      expect(ids).not.toContain(id);
    });

    it('CRITICAL an ACTIVE account that still carries a deleted_at is not selected, which is what proves the status predicate is load-bearing rather than decorative.', async () => {
      // Found by mutation, for the third time in this sweeper's arms. Deleting
      // `status = 'deleted'` from the query left every other case here green,
      // because the ACTIVE fixtures above have a null deleted_at and the cutoff
      // predicate excludes them on its own. A status check that no test can
      // fail is a status check carrying no proof.
      //
      // The pair cannot come apart today — admin-accounts-repo notes there is
      // no undelete flow, so deleted_at is never cleared. That is an invariant
      // of the product rather than of this query, and it is the assumption that
      // stops holding the day account reinstatement ships. If that lands
      // without clearing deleted_at, this predicate is the only thing between
      // an irreversible credential erasure and a live customer.
      if (!client) throw new Error('no client');
      const id = await seedAccount({ status: 'deleted', deletedDaysAgo: 90, hasKey: true });
      await client`UPDATE accounts SET status = 'active' WHERE id = ${id}`;

      const ids = await repo!.findDeletedAccountIdsWithByokKeyBefore(CUTOFF);

      expect(ids, 'a reinstated account keeps its credential').not.toContain(id);
    });

    it('CRITICAL an account terminated INSIDE the 30-day window is not yet selected. The policy commits to erasure within 30 days, not on termination.', async () => {
      const id = await seedAccount({ status: 'deleted', deletedDaysAgo: 5, hasKey: true });

      const ids = await repo!.findDeletedAccountIdsWithByokKeyBefore(CUTOFF);

      expect(ids).not.toContain(id);
    });

    it('CRITICAL an account with NO key is not selected, so the sweep is self-limiting. Without this the candidate list never shrinks: every terminated account returns forever, the sweeper clears an already-null column each tick, and the arm reports work it did not do.', async () => {
      const id = await seedAccount({ status: 'deleted', deletedDaysAgo: 45, hasKey: false });

      const ids = await repo!.findDeletedAccountIdsWithByokKeyBefore(CUTOFF);

      expect(ids).not.toContain(id);
    });

    it('CRITICAL the per-tick bound is applied in SQL. The sweeper clears one key per returned id in a loop, so an unbounded list means an unbounded run of sequential credential writes on a first sweep against a production backlog.', async () => {
      for (let i = 0; i < 3; i += 1) {
        await seedAccount({ status: 'deleted', deletedDaysAgo: 60, hasKey: true });
      }

      const ids = await repo!.findDeletedAccountIdsWithByokKeyBefore(CUTOFF, 2);

      // Asserted against the BOUND, not against a global row count: other
      // terminated accounts seeded by this file — or by anything else running
      // against the same database — are equally eligible, so "exactly my three
      // minus one" would depend on owning every candidate row in the table.
      expect(ids.length, 'the query never returns more than the bound').toBe(2);
    });
  },
);
