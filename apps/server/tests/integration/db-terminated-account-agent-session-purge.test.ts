// Agent sessions are erased after account termination.
//
// `agent_sessions.transcript` is the customer's agent conversation and
// `gui_control_key_ciphertext` is a session credential. Nothing deleted this
// table on any schedule, so both were retained indefinitely — the fourth arm of
// one root cause: `deleteAccount` is a SOFT delete, so the accounts row is
// never removed and the `ON DELETE CASCADE` on `account_id` never fires.
//
// The cascade behaviour is the reason this needs real Postgres rather than a
// unit test with a fake. Two tables point at `agent_sessions` with DIFFERENT
// delete rules, and the difference decides whether this erasure destroys data
// it has no licence to touch:
//
//   agent_turn_receipts.agent_session_id  ON DELETE CASCADE   -> goes with it
//   recipes.agent_session_id              ON DELETE SET NULL  -> survives
//
// A customer's saved recipes are their own artefact, not session content. If
// that rule were ever CASCADE, purging a terminated account's sessions would
// silently delete recipes too — and no assertion about the sessions table would
// notice. So the recipe case below is the one that matters most.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

import { ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import { purgeAgentSessionsForTerminatedAccountsBefore } from '../../src/db/agent-sessions-repo.js';
import type { Database } from '../../src/db/client.js';

// Runs against its OWN database: every purge here is GLOBAL — it selects and
// DELETES by cutoff across all accounts, so on a shared database it reaches
// other test files' fixtures and they reach its. See
// _helpers/isolated-database.ts; the agent-session purge already destroyed the
// receipt test's rows once via ON DELETE CASCADE, and that was patched with a
// fixture workaround, which is the fix that does not hold.
const ISOLATED_DB_NAME = 'driftstack_iso_purge_sessions';
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
    await probe`SELECT 1 FROM agent_sessions LIMIT 0`;
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
      await client`DELETE FROM agent_turn_receipts WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM agent_sessions WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

const db = (): Database => ({ client, db: null, close: async () => {} }) as unknown as Database;

async function seedAccountWithSession(args: {
  status: 'active' | 'suspended' | 'deleted';
  deletedDaysAgo: number | null;
}): Promise<{ accountId: string; sessionId: string }> {
  if (!client) throw new Error('no client');
  const accountId = randomUUID();
  const sessionId = `agt_${randomUUID()}`;
  seeded.push(accountId);
  const deletedAt =
    args.deletedDaysAgo === null
      ? null
      : new Date(NOW.getTime() - args.deletedDaysAgo * DAY_MS).toISOString();
  await client`
    INSERT INTO accounts (id, email, status, deleted_at)
    VALUES (${accountId}, ${`agent-session-${accountId}@test.local`}, ${args.status}::account_status, ${deletedAt})`;
  await client`
    INSERT INTO agent_sessions (id, account_id, status, token_budget_total, token_budget_remaining)
    VALUES (${sessionId}, ${accountId}, 'closed', 1000, 1000)`;
  return { accountId, sessionId };
}

async function countIn(table: 'agent_sessions' | 'recipes', accountId: string): Promise<number> {
  if (!client) throw new Error('no client');
  const rows =
    table === 'agent_sessions'
      ? await client<
          Array<{ n: string }>
        >`SELECT count(*)::text AS n FROM agent_sessions WHERE account_id = ${accountId}`
      : await client<
          Array<{ n: string }>
        >`SELECT count(*)::text AS n FROM recipes WHERE account_id = ${accountId}`;
  return Number(rows[0]?.n ?? '0');
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'agent sessions are purged 30 days after account termination',
  () => {
    it('CRITICAL the database is reachable. Every case is a SQL round-trip; if the connection failed they would skip and this file would report success while proving nothing about an irreversible erasure.', () => {
      expect(dbReachable, `could not reach ${DB_URL} — these results would be meaningless`).toBe(
        true,
      );
    });

    it('CRITICAL a terminated account past the cutoff has its sessions erased, transcript included.', async () => {
      const { accountId } = await seedAccountWithSession({ status: 'deleted', deletedDaysAgo: 45 });
      expect(await countIn('agent_sessions', accountId), 'seeded').toBe(1);

      const purged = await purgeAgentSessionsForTerminatedAccountsBefore(db(), CUTOFF);

      expect(purged).toBeGreaterThanOrEqual(1);
      expect(await countIn('agent_sessions', accountId), 'the row is gone').toBe(0);
    });

    it('CRITICAL an ACTIVE account is never touched. The erasure is irreversible and its only licence is the terminated status; a predicate matching live accounts would destroy a paying customer’s conversations.', async () => {
      const { accountId } = await seedAccountWithSession({
        status: 'active',
        deletedDaysAgo: null,
      });

      await purgeAgentSessionsForTerminatedAccountsBefore(db(), CUTOFF);

      expect(await countIn('agent_sessions', accountId)).toBe(1);
    });

    it('CRITICAL an ACTIVE account carrying a deleted_at is not purged, proving the status predicate is load-bearing. Unreachable today — there is no undelete flow — but the status check is the only protection if reinstatement is ever added without clearing deleted_at.', async () => {
      if (!client) throw new Error('no client');
      const { accountId } = await seedAccountWithSession({ status: 'deleted', deletedDaysAgo: 90 });
      await client`UPDATE accounts SET status = 'active' WHERE id = ${accountId}`;

      await purgeAgentSessionsForTerminatedAccountsBefore(db(), CUTOFF);

      expect(await countIn('agent_sessions', accountId)).toBe(1);
    });

    it('CRITICAL an account deleted INSIDE the retention window is not yet purged. The commitment is deletion within 30 days, not immediately.', async () => {
      const { accountId } = await seedAccountWithSession({ status: 'deleted', deletedDaysAgo: 5 });

      await purgeAgentSessionsForTerminatedAccountsBefore(db(), CUTOFF);

      expect(await countIn('agent_sessions', accountId)).toBe(1);
    });

    it('CRITICAL a purged session takes its turn receipts with it. ON DELETE CASCADE is what makes that true; if it were ever loosened the receipts would be stranded holding response bodies for an account whose sessions are gone.', async () => {
      if (!client) throw new Error('no client');
      const { accountId, sessionId } = await seedAccountWithSession({
        status: 'deleted',
        deletedDaysAgo: 45,
      });
      await client`
        INSERT INTO agent_turn_receipts
          (account_id, idempotency_key, agent_session_id, request_hash, state)
        VALUES (${accountId}, ${`cascade-${accountId}`}, ${sessionId}, ${'c'.repeat(64)}, 'in_progress')`;

      await purgeAgentSessionsForTerminatedAccountsBefore(db(), CUTOFF);

      const rows = await client<
        Array<{ n: string }>
      >`SELECT count(*)::text AS n FROM agent_turn_receipts WHERE account_id = ${accountId}`;
      expect(Number(rows[0]?.n ?? '0'), 'receipts cascaded away with the session').toBe(0);
    });

    it('CRITICAL a purged session does NOT delete the customer’s saved recipes — the link is nulled instead. Recipes are the customer’s own artefact, not session content; if that foreign key were ever changed to CASCADE this erasure would quietly destroy them and no assertion about agent_sessions would notice.', async () => {
      if (!client) throw new Error('no client');
      const { accountId, sessionId } = await seedAccountWithSession({
        status: 'deleted',
        deletedDaysAgo: 45,
      });
      const recipeId = randomUUID();
      await client`
        INSERT INTO recipes (id, account_id, label, agent_session_id, intent_log, transcript_snapshot, created_at, updated_at)
        VALUES (${recipeId}, ${accountId}, ${`recipe-${recipeId}`}, ${sessionId}, '[]'::jsonb, '[]'::jsonb, now(), now())`;

      await purgeAgentSessionsForTerminatedAccountsBefore(db(), CUTOFF);

      expect(await countIn('recipes', accountId), 'the recipe survives').toBe(1);
      const rows = await client<
        Array<{ agent_session_id: string | null }>
      >`SELECT agent_session_id FROM recipes WHERE id = ${recipeId}`;
      expect(rows[0]?.agent_session_id, 'with its session link cleared').toBeNull();
    });

    it('CRITICAL the per-tick bound is honoured and the sweep is self-limiting, so a first run against a production backlog cannot delete everything in one statement.', async () => {
      if (!client) throw new Error('no client');
      const { accountId } = await seedAccountWithSession({ status: 'deleted', deletedDaysAgo: 60 });
      for (let i = 0; i < 4; i += 1) {
        await client`
          INSERT INTO agent_sessions (id, account_id, status, token_budget_total, token_budget_remaining)
          VALUES (${`agt_${randomUUID()}`}, ${accountId}, 'closed', 10, 10)`;
      }
      expect(await countIn('agent_sessions', accountId), 'five sessions seeded').toBe(5);

      // Scoped to the BOUND, not to a global row count. The LIMIT applies to
      // the whole candidate set, so any other terminated account with eligible
      // sessions — including one left behind by an earlier case in this file —
      // consumes part of the budget. Asserting "exactly three of mine remain"
      // silently depends on this account owning every eligible row in the
      // table, which is the same trap that made the webhook concurrency file
      // flaky under parallel load.
      expect(
        await purgeAgentSessionsForTerminatedAccountsBefore(db(), CUTOFF, 2),
        'the DELETE never exceeds the per-tick bound',
      ).toBe(2);
      expect(
        5 - (await countIn('agent_sessions', accountId)),
        'so at most two of this account rows can have gone',
      ).toBeLessThanOrEqual(2);

      await purgeAgentSessionsForTerminatedAccountsBefore(db(), CUTOFF, 500);
      expect(await countIn('agent_sessions', accountId), 'the remainder drains next tick').toBe(0);
    });
  },
);
