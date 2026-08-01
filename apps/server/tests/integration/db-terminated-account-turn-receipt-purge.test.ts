// Agent-turn receipts are erased after account termination.
//
// `agent_turn_receipts.response_ciphertext` is the response BODY of a
// customer's agent turn — content, not metadata — encrypted under the platform
// key, which persists, so the bytes stay readable rather than becoming inert.
// Nothing deleted these rows on any schedule: not at termination, not on a
// cutoff, not ever. The published retention table caps "Session metadata" at 90
// days operational and permits indefinite retention only for "aggregated
// counters (no PII)"; DPA §3.8 commits to deletion within 30 days of
// termination.
//
// Third instance of one root cause. `deleteAccount` is a SOFT delete, so the
// accounts row is never removed and the `ON DELETE CASCADE` on `account_id`
// never fires. That is exactly why proxy credentials (6671cde70) and profiles
// plus snapshots (1ef6d4229) were both retained past their windows.
//
// Against real Postgres, because the safety is entirely in two SQL predicates
// and the cases that matter most are the ones that must NOT be touched. This
// erasure is irreversible and its only licence is the account's terminated
// status plus the cutoff, so that is what gets hammered below.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

import { ensureIsolatedDatabase } from './_helpers/isolated-database.js';
import { purgeTurnReceiptsForTerminatedAccountsBefore } from '../../src/db/agent-turn-receipts-repo.js';
import type { Database } from '../../src/db/client.js';

// Runs against its OWN database: every purge here is GLOBAL — it selects and
// DELETES by cutoff across all accounts, so on a shared database it reaches
// other test files' fixtures and they reach its. See
// _helpers/isolated-database.ts; the agent-session purge already destroyed the
// receipt test's rows once via ON DELETE CASCADE, and that was patched with a
// fixture workaround, which is the fix that does not hold.
const ISOLATED_DB_NAME = 'driftstack_iso_purge_receipts';
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
    await probe`SELECT 1 FROM agent_turn_receipts LIMIT 0`;
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
      await client`DELETE FROM agent_turn_receipts WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM agent_sessions WHERE account_id = ${accountId}`.catch(() => {});
      await client`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
    }
    await client.end({ timeout: 5 });
  }
});

const db = (): Database => ({ client, db: null, close: async () => {} }) as unknown as Database;

/** An account in a lifecycle state, owning one completed turn receipt. */
async function seedAccountWithReceipt(args: {
  status: 'active' | 'suspended' | 'deleted';
  deletedDaysAgo: number | null;
}): Promise<{ accountId: string; key: string; sessionId: string }> {
  if (!client) throw new Error('no client');
  const accountId = randomUUID();
  // The SESSION is hosted by a separate ACTIVE account, deliberately.
  //
  // agent_turn_receipts has two independent foreign keys — account_id and
  // agent_session_id — and nothing requires them to agree. Hanging the session
  // off the terminated account instead made these rows collateral of the
  // agent-session purge: that sweep deletes sessions for terminated accounts
  // and agent_session_id is ON DELETE CASCADE, so the sibling test silently
  // erased this test's receipts whenever the two overlapped. Demonstrated
  // directly in SQL, not inferred: seed both, run the session sweep, and the
  // receipt count goes 1 → 0.
  const sessionHostId = randomUUID();
  const sessionId = `agt_${randomUUID()}`;
  const key = `idem-${randomUUID()}`;
  seeded.push(accountId, sessionHostId);
  const deletedAt =
    args.deletedDaysAgo === null
      ? null
      : new Date(NOW.getTime() - args.deletedDaysAgo * DAY_MS).toISOString();
  await client`
    INSERT INTO accounts (id, email, status, deleted_at)
    VALUES (${accountId}, ${`turn-receipt-${accountId}@test.local`}, ${args.status}::account_status, ${deletedAt})`;
  await client`
    INSERT INTO accounts (id, email, status)
    VALUES (${sessionHostId}, ${`receipt-session-host-${sessionHostId}@test.local`}, 'active')`;
  await client`
    INSERT INTO agent_sessions (id, account_id, status, token_budget_total, token_budget_remaining)
    VALUES (${sessionId}, ${sessionHostId}, 'closed', 1000, 1000)`;
  await client`
    INSERT INTO agent_turn_receipts
      (account_id, idempotency_key, agent_session_id, request_hash, state, response_status, response_ciphertext, completed_at)
    VALUES (${accountId}, ${key}, ${sessionId}, ${'a'.repeat(64)}, 'completed', 200, ${Buffer.from('ciphertext')}, now())`;
  return { accountId, key, sessionId };
}

async function receiptCount(accountId: string): Promise<number> {
  if (!client) throw new Error('no client');
  const rows = await client<
    Array<{ n: string }>
  >`SELECT count(*)::text AS n FROM agent_turn_receipts WHERE account_id = ${accountId}`;
  return Number(rows[0]?.n ?? '0');
}

describe.skipIf(!process.env.CI && !process.env.DATABASE_URL)(
  'agent-turn receipts are purged 30 days after account termination',
  () => {
    it('CRITICAL the database is reachable. Every case here is a SQL round-trip; if the connection failed they would all skip and this file would report success while proving nothing about an irreversible erasure.', () => {
      expect(dbReachable, `could not reach ${DB_URL} — these results would be meaningless`).toBe(
        true,
      );
    });

    it('CRITICAL a terminated account past the cutoff has its receipts erased. Nothing purged this table at all before, so the response body of every agent turn a terminated customer ever ran was retained indefinitely.', async () => {
      const { accountId } = await seedAccountWithReceipt({
        status: 'deleted',
        deletedDaysAgo: 45,
      });
      expect(await receiptCount(accountId), 'seeded').toBe(1);

      const purged = await purgeTurnReceiptsForTerminatedAccountsBefore(db(), CUTOFF);

      expect(purged, 'reported at least this row').toBeGreaterThanOrEqual(1);
      expect(await receiptCount(accountId), 'the row is gone').toBe(0);
    });

    it('CRITICAL an ACTIVE account is never touched. This erasure is irreversible and its only licence is the account being terminated — a predicate that matched live accounts would silently destroy paying customers’ idempotency receipts, breaking at-most-once for turns in flight.', async () => {
      const { accountId } = await seedAccountWithReceipt({
        status: 'active',
        deletedDaysAgo: null,
      });

      await purgeTurnReceiptsForTerminatedAccountsBefore(db(), CUTOFF);

      expect(await receiptCount(accountId), 'an active account keeps its receipts').toBe(1);
    });

    it('CRITICAL a SUSPENDED account is never touched. Suspension is a billing state a customer can return from; only `deleted` licenses erasure.', async () => {
      const { accountId } = await seedAccountWithReceipt({
        status: 'suspended',
        deletedDaysAgo: null,
      });

      await purgeTurnReceiptsForTerminatedAccountsBefore(db(), CUTOFF);

      expect(await receiptCount(accountId), 'a suspended account keeps its receipts').toBe(1);
    });

    it('CRITICAL an account that is ACTIVE but still carries a deleted_at is not purged, so the status predicate is proved load-bearing rather than assumed.', async () => {
      // Found by mutation. Dropping `a.status = 'deleted'` from the query left
      // every other case in this file green, because `deleted_at IS NOT NULL`
      // happens to exclude the active fixtures above — they have a null
      // deleted_at. So the status predicate was carrying no proof at all.
      //
      // Today the pair cannot come apart: admin-accounts-repo notes there is no
      // undelete flow, so deleted_at is never cleared and a non-null deleted_at
      // implies status='deleted'. That is an invariant of the product, not of
      // this query, and it is exactly the kind of assumption that stops holding
      // when someone adds account reinstatement. If that lands and does not
      // clear deleted_at, the status check is the only thing standing between
      // this irreversible DELETE and a live customer's receipts.
      //
      // Seeded directly, because the state is unreachable through the API.
      if (!client) throw new Error('no client');
      const { accountId } = await seedAccountWithReceipt({ status: 'deleted', deletedDaysAgo: 90 });
      await client`UPDATE accounts SET status = 'active' WHERE id = ${accountId}`;

      await purgeTurnReceiptsForTerminatedAccountsBefore(db(), CUTOFF);

      expect(
        await receiptCount(accountId),
        'a reinstated account keeps its receipts even with deleted_at set',
      ).toBe(1);
    });

    it('CRITICAL an account deleted INSIDE the retention window is not yet purged. The commitment is deletion within 30 days, not immediately; erasing early would destroy the receipts of a customer still inside their reinstatement window.', async () => {
      const { accountId } = await seedAccountWithReceipt({ status: 'deleted', deletedDaysAgo: 5 });

      await purgeTurnReceiptsForTerminatedAccountsBefore(db(), CUTOFF);

      expect(await receiptCount(accountId), 'still inside the 30-day window').toBe(1);
    });

    it('CRITICAL the per-tick bound is honoured and the sweep is self-limiting. One terminated account can own an unbounded number of receipts, so an unbounded DELETE would take the whole backlog in a single statement; the remainder must still drain on the next tick.', async () => {
      if (!client) throw new Error('no client');
      // sessionId comes back from the seeder: the session belongs to a separate
      // active host account now, so looking it up by this account finds nothing.
      const { accountId, sessionId } = await seedAccountWithReceipt({
        status: 'deleted',
        deletedDaysAgo: 60,
      });
      for (let i = 0; i < 4; i += 1) {
        await client`
          INSERT INTO agent_turn_receipts
            (account_id, idempotency_key, agent_session_id, request_hash, state)
          VALUES (${accountId}, ${`bulk-${String(i)}-${accountId}`}, ${sessionId}, ${'b'.repeat(64)}, 'in_progress')`;
      }
      expect(await receiptCount(accountId), 'five receipts seeded').toBe(5);

      // Asserted against the BOUND, not a global row count: the LIMIT applies to
      // every eligible receipt in the table, so any other terminated account's
      // rows consume part of the budget. "Exactly three of mine remain" quietly
      // assumes this account owns all of them.
      const first = await purgeTurnReceiptsForTerminatedAccountsBefore(db(), CUTOFF, 2);
      expect(first, 'the DELETE never exceeds the per-tick bound').toBe(2);
      expect(
        5 - (await receiptCount(accountId)),
        'so at most two of this account rows can have gone',
      ).toBeLessThanOrEqual(2);

      await purgeTurnReceiptsForTerminatedAccountsBefore(db(), CUTOFF, 500);
      expect(await receiptCount(accountId), 'the remainder drains on the next tick').toBe(0);
    });
  },
);
