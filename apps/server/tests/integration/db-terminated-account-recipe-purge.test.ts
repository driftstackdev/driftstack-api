// Recipes are purged 30 days after account termination — on real Postgres.
//
// The fourth arm of the account-deletion sweeper, and the only one that had no
// real-PG spec. Its three siblings each have one
// (`db-terminated-account-{profile,agent-session,turn-receipt}-purge`); this
// table's arm was wired, unit-tested against a FAKE, and never executed.
//
// Found from two instruments agreeing rather than from suspicion. The db layer
// is excluded from the coverage gate, so nothing reported which parts of it ran;
// measuring it directly flagged `recipes-repo.ts` lines 322-334 — the whole body
// of `purgeRecipesForTerminatedAccountsBefore` — as never executed. A separate
// census of call sites then found ZERO test files naming that function. The unit
// test `a-recipe-outlives-the-erasure-that-was-supposed-to-take-it` drives the
// sweeper's SEAM (`recipes.purgeForTerminatedAccountsBefore`) with a stub, which
// proves the arm is wired and nothing about the SQL behind it.
//
// What the SQL is licensed by, and therefore what these arms pin:
//
//   DELETE FROM recipes WHERE id IN (
//     SELECT r.id FROM recipes r JOIN accounts a ON a.id = r.account_id
//     WHERE a.status = 'deleted' AND a.deleted_at IS NOT NULL
//       AND a.deleted_at < $cutoff LIMIT $maxPerTick)
//
// `a.status = 'deleted'` is the entire licence for an irreversible delete of a
// live customer's saved automations. `a.deleted_at < cutoff` is the published
// 30-day window — erasing early destroys work a customer can still recover.
// Each is asserted on its own, because a single arm proves only the conjunct
// that fails first.
//
// Runs against its OWN database, for the same reason the sibling does: this
// purge is GLOBAL — it selects by cutoff across all accounts — so on a shared
// database it reaches other files' fixtures and they reach its.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

import { ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import { purgeRecipesForTerminatedAccountsBefore } from '../../src/db/recipes-repo.js';
import type { Database } from '../../src/db/client.js';

const ISOLATED_DB_NAME = 'driftstack_iso_purge_recipes';
let DB_URL = '';
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-31T12:00:00.000Z');
const CUTOFF = new Date(NOW.getTime() - 30 * DAY_MS);

let dbReachable = false;
let client: ReturnType<typeof postgres> | null = null;
const seeded: string[] = [];

beforeAll(async () => {
  const isolated = await ensureIsolatedDatabase(ISOLATED_DB_NAME);
  if (isolated === null) return;
  DB_URL = isolated;
  const probe = postgres(DB_URL, { max: 1, connect_timeout: 2, idle_timeout: 1 });
  try {
    await probe`SELECT 1 FROM recipes LIMIT 0`;
    dbReachable = true;
    await probe.end({ timeout: 1 });
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return;
  }
  client = postgres(DB_URL, { max: 4 });
});

afterAll(async () => {
  if (client) {
    for (const accountId of seeded) {
      await client`DELETE FROM recipes WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

const db = (): Database => ({ client, db: null, close: async () => {} }) as unknown as Database;

/**
 * An account in a lifecycle state, owning `count` recipes.
 *
 * `agent_session_id` is left NULL deliberately. It is ON DELETE SET NULL, so a
 * session purge cannot cascade into this table — but the sibling receipt spec
 * was silently emptied once by exactly that coupling through its own session
 * FK, and there is no reason to reintroduce the shape here.
 */
async function seedAccountWithRecipes(args: {
  status: 'active' | 'suspended' | 'deleted';
  deletedDaysAgo: number | null;
  count?: number;
}): Promise<string> {
  if (!client) throw new Error('no client');
  const accountId = randomUUID();
  seeded.push(accountId);
  const deletedAt =
    args.deletedDaysAgo === null
      ? null
      : new Date(NOW.getTime() - args.deletedDaysAgo * DAY_MS).toISOString();
  await client`
    INSERT INTO accounts (id, email, status, deleted_at)
    VALUES (${accountId}, ${`recipe-${accountId}@test.local`}, ${args.status}::account_status, ${deletedAt})`;
  for (let i = 0; i < (args.count ?? 1); i += 1) {
    await client`
      INSERT INTO recipes (id, account_id, label, intent_log)
      VALUES (${`rcp_${randomUUID()}`}, ${accountId}, ${`recipe ${i}`}, ${client.json([])})`;
  }
  return accountId;
}

async function recipeCount(accountId: string): Promise<number> {
  if (!client) throw new Error('no client');
  const rows = await client<
    Array<{ n: string }>
  >`SELECT count(*)::text AS n FROM recipes WHERE account_id = ${accountId}`;
  return Number(rows[0]?.n ?? '0');
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'recipes are purged 30 days after account termination',
  () => {
    it('CRITICAL the database is reachable. Every case here is a SQL round-trip; if the connection failed they would all skip and this file would report success while proving nothing about an irreversible erasure.', () => {
      expect(dbReachable, `could not reach ${DB_URL} — these results would be meaningless`).toBe(
        true,
      );
    });

    it('CRITICAL an account terminated past the cutoff has its recipes erased. The positive arm — without it every refusal below is satisfied by a purge that deletes nothing at all, which is precisely the state this table was in.', async () => {
      if (!dbReachable) return;
      const accountId = await seedAccountWithRecipes({ status: 'deleted', deletedDaysAgo: 45 });
      expect(await recipeCount(accountId), 'the fixture did not seed').toBe(1);

      const purged = await purgeRecipesForTerminatedAccountsBefore(db(), CUTOFF);

      expect(purged, 'the purge reported no rows for an account well past the window').toBe(1);
      expect(await recipeCount(accountId), 'a long-terminated account kept its recipes').toBe(0);
    });

    it('CRITICAL an ACTIVE account is never touched. This delete is irreversible and its only licence is the account being terminated, so a purge that reached a live customer would destroy saved automations no one asked to remove.', async () => {
      if (!dbReachable) return;
      const accountId = await seedAccountWithRecipes({ status: 'active', deletedDaysAgo: null });

      await purgeRecipesForTerminatedAccountsBefore(db(), CUTOFF);

      expect(await recipeCount(accountId), "a LIVE account's recipes were erased").toBe(1);
    });

    it('CRITICAL a SUSPENDED account is never touched. Suspension is a billing state a customer returns from; conflating it with termination would erase the automations of an account that gets reinstated.', async () => {
      if (!dbReachable) return;
      const accountId = await seedAccountWithRecipes({ status: 'suspended', deletedDaysAgo: 45 });

      await purgeRecipesForTerminatedAccountsBefore(db(), CUTOFF);

      expect(await recipeCount(accountId), "a SUSPENDED account's recipes were erased").toBe(1);
    });

    it('CRITICAL an account that is ACTIVE but still carries a deleted_at is not purged, which is what proves the status predicate is load-bearing rather than decorative — the date alone would already have selected this row.', async () => {
      if (!dbReachable) return;
      const accountId = await seedAccountWithRecipes({ status: 'active', deletedDaysAgo: 45 });

      await purgeRecipesForTerminatedAccountsBefore(db(), CUTOFF);

      expect(
        await recipeCount(accountId),
        'the date predicate selected a row the status predicate should have excluded',
      ).toBe(1);
    });

    it('CRITICAL an account terminated INSIDE the retention window is not yet purged. The commitment is erasure within 30 days of termination, not on termination; erasing early destroys work the customer can still recover.', async () => {
      if (!dbReachable) return;
      const accountId = await seedAccountWithRecipes({ status: 'deleted', deletedDaysAgo: 5 });

      await purgeRecipesForTerminatedAccountsBefore(db(), CUTOFF);

      expect(
        await recipeCount(accountId),
        'an account deleted 5 days ago lost its recipes inside the 30-day window',
      ).toBe(1);
    });

    it('CRITICAL the per-tick bound is honoured and successive ticks converge. One terminated account can own an unbounded number of recipes, and the bound is what keeps a first sweep against a production backlog something an operator can watch.', async () => {
      if (!dbReachable) return;
      const accountId = await seedAccountWithRecipes({
        status: 'deleted',
        deletedDaysAgo: 45,
        count: 5,
      });

      const first = await purgeRecipesForTerminatedAccountsBefore(db(), CUTOFF, 2);
      expect(first, 'the per-tick cap was not applied in SQL').toBe(2);
      expect(await recipeCount(accountId), 'the capped tick deleted more than its bound').toBe(3);

      const second = await purgeRecipesForTerminatedAccountsBefore(db(), CUTOFF, 2);
      expect(second, 'the second tick did not continue draining').toBe(2);

      const third = await purgeRecipesForTerminatedAccountsBefore(db(), CUTOFF, 2);
      expect(third, 'the final tick did not drain the remainder').toBe(1);
      expect(await recipeCount(accountId), 'successive ticks did not converge to empty').toBe(0);
    });
  },
);
