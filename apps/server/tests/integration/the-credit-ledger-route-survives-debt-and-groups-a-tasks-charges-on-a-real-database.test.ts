// S14 audit fixes, proved through the REAL routes over a REAL, freshly
// migrated Postgres database — real repos, a real `CreditReservationsService`,
// a real `CreditGrantsService` (`adminCreditsHarness`, the same wiring
// bootstrap.ts builds), and `buildTestApp` driving the full app.
//
//   #1  the audit's exact scenario: 10 granted, a refund claws the 10 back and
//       adds 5 of debt. The ledger route answered 500 for every page holding
//       the debt row. It now answers 200 with the row at −5, and a page of
//       OLDER entries, read after the debt is paid, still loads.
//   #7  a task that drew on two lots is ONE `task_charge` entry, and paging
//       by entry never splits it across two pages.
//   #8  an account that has not been moved has an empty ledger page, even
//       though shadow-mode grants have written rows for it.
//   #3  each extra lot's remaining excludes what a running task holds on it.
//   #5 + #6  `GET /v1/account/me/ai` refreshes a moved Enterprise account with
//       a contract before reading it: the contract's window and credits exist
//       by the time it answers, and the plan shows the contract's figure.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AccountAiStateSchema, AiLedgerPageSchema } from '@driftstack/api-types';
import type { AiCreditsRuntime } from '../../src/services/ai-credits-runtime.js';
import { MICRO, insertLot, openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { fundedTaskLot, settledCall } from './_helpers/credit-reservation-fixtures.js';
import {
  adminCreditsHarness,
  type AdminCreditsHarness,
} from './_helpers/admin-credits-route-fixtures.js';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

const ISOLATED_DB_NAME = 'driftstack_iso_s14_fixes';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;
let harness: AdminCreditsHarness | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  harness = adminCreditsHarness(opened.url);
}, 60_000);

afterAll(async () => {
  await harness?.base.database.close().catch(() => {});
  await client?.end({ timeout: 5 }).catch(() => {});
});

function sql(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function h(): AdminCreditsHarness {
  if (harness === null) throw new Error('isolated database unreachable');
  return harness;
}

/** The harness's runtime plus the two S14 reads bootstrap.ts wires beside it. */
function runtime(mode: 'shadow' | 'enforce' = 'enforce'): AiCreditsRuntime {
  const base = h().aiCredits;
  if (base.stateReads === undefined) throw new Error('the harness wires stateReads');
  return {
    ...base,
    mode,
    stateReads: {
      ...base.stateReads,
      planOverride: h().overrides.get.bind(h().overrides),
      refreshCredits: h().grants.refreshCredits.bind(h().grants),
    },
  };
}

/** An account on `tier` with its credit row, moved onto credits unless `legacy`. */
async function account(tier: string, billing: 'credits' | 'legacy' = 'credits'): Promise<string> {
  const id = randomUUID();
  await sql()`INSERT INTO accounts (id, email, tier) VALUES (${id}::uuid, ${`s14-fix-${id}@example.test`}, ${tier}::account_tier)`;
  await sql()`INSERT INTO credit_accounts (account_id, billing_mode) VALUES (${id}::uuid, ${billing})`;
  return id;
}

let fx: TestAppFixture | null = null;
afterEach(async () => {
  if (fx) await fx.cleanup();
  fx = null;
});

async function appFor(
  accountId: string,
  tier: 'team_manual' | 'enterprise',
  mode: 'shadow' | 'enforce' = 'enforce',
): Promise<TestAppFixture> {
  fx = await buildTestApp({ accountId, tier, aiCredits: runtime(mode) });
  return fx;
}

interface LedgerEntryBody {
  id: string;
  kind: string;
  credits: number;
  balance_after_credits: number;
  task: { agent_session_id: string; model: string | null; rate_card_version: number } | null;
}
interface LedgerPageBody {
  data: LedgerEntryBody[];
  has_more: boolean;
  next_cursor: string | null;
}

async function ledgerPage(
  app: TestAppFixture,
  query = '',
): Promise<{ status: number; body: LedgerPageBody; raw: string }> {
  const res = await app.app.inject({
    method: 'GET',
    url: `/v1/account/me/ai/ledger${query}`,
    headers: { authorization: `Bearer ${app.plaintext}` },
  });
  return { status: res.statusCode, body: res.json<LedgerPageBody>(), raw: res.body };
}

describe.skipIf(!RUN_DB_TESTS)('the S14 customer routes on a real database', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    expect(harness).not.toBeNull();
  });

  describe('#1 — a running balance below zero', () => {
    it('CRITICAL the audit scenario answers 200 with the debt row at −5, and a page of older entries still loads after the debt is paid', async () => {
      const id = await account('team_manual');
      const ledger = h().base.ledger;
      const lotId = await fundedTaskLot(sql(), id, { kind: 'adjustment', credits: 10 });
      await ledger.transaction(async (tx) => {
        await ledger.lockAccount(tx, id);
        await ledger.append(
          {
            accountId: id,
            kind: 'refund_clawback',
            lotId,
            amountMicro: 10 * MICRO,
            idempotencyKey: `refund:${lotId}`,
          },
          tx,
        );
        await ledger.append(
          {
            accountId: id,
            kind: 'debt_incurred',
            amountMicro: 5 * MICRO,
            reason: 'payment_reversed',
            idempotencyKey: `debt:${id}`,
          },
          tx,
        );
      });

      const app = await appFor(id, 'team_manual');
      const first = await ledgerPage(app);
      expect(first.status, first.raw).toBe(200);
      expect(first.body.data.map((e) => [e.kind, e.credits, e.balance_after_credits])).toEqual([
        ['debt', -5, -5],
        ['refund', -10, 0],
        ['grant', 10, 10],
      ]);
      expect(AiLedgerPageSchema.safeParse(first.body).success).toBe(true);

      // The debt is paid: 20 credits arrive and repay the 5 in the same
      // transaction (the database refuses debt beside free credit at COMMIT).
      await ledger.transaction(async (tx) => {
        await ledger.lockAccount(tx, id);
        const { lot } = await ledger.insertLot(
          {
            accountId: id,
            kind: 'adjustment',
            grantKey: `goodwill:${randomUUID()}`,
            grantedMicro: 20 * MICRO,
            startsAt: new Date(Date.now() - 3_600_000),
            expiresAt: new Date(Date.now() + 30 * 86_400_000),
          },
          tx,
        );
        await ledger.append(
          {
            accountId: id,
            kind: 'grant',
            lotId: lot.id,
            amountMicro: 20 * MICRO,
            idempotencyKey: `grant:${lot.id}`,
          },
          tx,
        );
        await ledger.settleDebtFromFree(tx, id);
      });

      const newest = await ledgerPage(app, '?limit=2');
      expect(newest.status, newest.raw).toBe(200);
      expect(newest.body.has_more).toBe(true);
      expect(newest.body.data.map((e) => e.balance_after_credits)).toEqual([15, 15]);

      const older = await ledgerPage(app, `?limit=2&cursor=${newest.body.next_cursor ?? ''}`);
      expect(older.status, older.raw).toBe(200);
      expect(older.body.data.map((e) => [e.kind, e.balance_after_credits])).toEqual([
        ['debt', -5],
        ['refund', 0],
      ]);
    });
  });

  describe('#7 — one task, one entry', () => {
    /** A moved account whose one task drew 5 credits from its monthly lot and
     *  3 from a goodwill lot: two `task_charge` rows, one reservation. */
    async function accountWithATwoLotTask(): Promise<{ id: string; sessionId: string }> {
      const id = await account('team_manual');
      await fundedTaskLot(sql(), id, { kind: 'monthly', credits: 5 });
      await fundedTaskLot(sql(), id, { kind: 'adjustment', credits: 100 });
      const reservationId = randomUUID();
      const sessionId = `as_${randomUUID()}`;
      const reserved = await h().base.service.reserve({
        accountId: id,
        reservationId,
        agentSessionId: sessionId,
        idempotencyKey: null,
        model: 'claude-sonnet-5',
        mode: 'enforce',
        bootId: 'boot-s14-fixes',
      });
      expect(reserved.outcome, 'test setup: the task must reserve').toBe('reserved');
      await settledCall(sql(), { reservationId, accountId: id, chargedMicro: 8 * MICRO });
      const settled = await h().base.service.settle(reservationId, 'completed');
      expect(settled.outcome).toBe('settled');
      if (settled.outcome !== 'settled') throw new Error('unreachable');
      // Precondition, measured rather than assumed: the charge really did
      // span two lots, so there really are two rows to group.
      expect(settled.charges).toHaveLength(2);
      return { id, sessionId };
    }

    it('CRITICAL a task charged across two lots is one task_charge entry for the whole charge, with its task block', async () => {
      const { id, sessionId } = await accountWithATwoLotTask();
      const page = await ledgerPage(await appFor(id, 'team_manual'));
      expect(page.status, page.raw).toBe(200);
      expect(page.body.data.map((e) => [e.kind, e.credits, e.balance_after_credits])).toEqual([
        ['task_charge', -8, 97],
        ['grant', 100, 105],
        ['grant', 5, 5],
      ]);
      expect(page.body.data[0]?.task).toEqual({
        agent_session_id: sessionId,
        model: 'claude-sonnet-5',
        rate_card_version: 1,
      });
    });

    it('CRITICAL paging one entry at a time never splits the task across pages and never repeats or skips an entry', async () => {
      const { id } = await accountWithATwoLotTask();
      const app = await appFor(id, 'team_manual');
      const seen: string[] = [];
      const kinds: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i += 1) {
        const page = await ledgerPage(app, `?limit=1${cursor === null ? '' : `&cursor=${cursor}`}`);
        expect(page.status, page.raw).toBe(200);
        for (const e of page.body.data) {
          seen.push(e.id);
          kinds.push(`${e.kind}:${String(e.credits)}`);
        }
        cursor = page.body.next_cursor;
        if (cursor === null) break;
      }
      expect(kinds).toEqual(['task_charge:-8', 'grant:100', 'grant:5']);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it('CRITICAL entries are ordered by their NUMERIC id across a power of ten, never as text (where "9999999" sorts after "10000000")', async () => {
      // The grouped query prints each entry id as text; a first version sorted
      // on that text alias. Ids of a fresh database are small and rarely
      // cross a digit boundary inside one account, so they are forced here.
      const id = await account('team_manual');
      const lotId = await insertLot(sql(), id, { kind: 'adjustment', credits: 10 });
      await sql()`
        INSERT INTO credit_ledger (id, account_id, kind, lot_id, lot_delta_micro, idempotency_key)
        OVERRIDING SYSTEM VALUE
        VALUES (9999998, ${id}::uuid, 'grant', ${lotId}::uuid, ${10 * MICRO}, ${`grant:${lotId}`})`;
      for (const [rowId, key] of [
        [9_999_999, 'spend-a'],
        [10_000_000, 'spend-b'],
      ] as const) {
        await sql()`
          INSERT INTO credit_ledger (id, account_id, kind, lot_id, lot_delta_micro, idempotency_key)
          OVERRIDING SYSTEM VALUE
          VALUES (${rowId}, ${id}::uuid, 'adjustment', ${lotId}::uuid, ${-1 * MICRO}, ${key})`;
      }
      const app = await appFor(id, 'team_manual');
      const first = await ledgerPage(app, '?limit=2');
      expect(first.status, first.raw).toBe(200);
      expect(first.body.data.map((e) => [e.id, e.balance_after_credits])).toEqual([
        ['10000000', 8],
        ['9999999', 9],
      ]);
      const second = await ledgerPage(app, `?limit=2&cursor=${first.body.next_cursor ?? ''}`);
      expect(second.body.data.map((e) => [e.id, e.balance_after_credits])).toEqual([
        ['9999998', 10],
      ]);
      expect(second.body.has_more).toBe(false);
    });
  });

  describe('#8 — a ledger for an account that has not been moved', () => {
    it('CRITICAL a LEGACY account with shadow-mode grant rows reads an empty page', async () => {
      const id = await account('team_manual', 'legacy');
      await fundedTaskLot(sql(), id, { kind: 'adjustment', credits: 5_000 });
      const page = await ledgerPage(await appFor(id, 'team_manual'));
      expect(page.status, page.raw).toBe(200);
      expect(page.body).toEqual({ data: [], has_more: false, next_cursor: null });
    });

    it('a MOVED account read while the mode is shadow is legacy for every customer purpose, so its page is empty too', async () => {
      const id = await account('team_manual');
      await fundedTaskLot(sql(), id, { kind: 'adjustment', credits: 5_000 });
      const page = await ledgerPage(await appFor(id, 'team_manual', 'shadow'));
      expect(page.status, page.raw).toBe(200);
      expect(page.body.data).toEqual([]);
    });

    it('the same moved account under enforce does see its rows (positive control)', async () => {
      const id = await account('team_manual');
      await fundedTaskLot(sql(), id, { kind: 'adjustment', credits: 5_000 });
      const page = await ledgerPage(await appFor(id, 'team_manual', 'enforce'));
      expect(page.body.data.map((e) => e.kind)).toEqual(['grant']);
    });
  });

  interface AiStateBody {
    plan: { monthly_included_credits: number | null };
    balance: {
      available_credits: number;
      monthly: { granted_credits: number; remaining_credits: number } | null;
      extras: { kind: string; remaining_credits: number }[];
    };
    blocked_reason: string | null;
  }

  async function aiState(
    app: TestAppFixture,
  ): Promise<{ status: number; body: AiStateBody; raw: string }> {
    const res = await app.app.inject({
      method: 'GET',
      url: '/v1/account/me/ai',
      headers: { authorization: `Bearer ${app.plaintext}` },
    });
    return { status: res.statusCode, body: res.json<AiStateBody>(), raw: res.body };
  }

  describe('#3 — an extra lot excludes what a running task holds on it', () => {
    it('CRITICAL while a task holds part of a goodwill lot, extras read what is left unheld and add up to available', async () => {
      const id = await account('team_manual');
      await fundedTaskLot(sql(), id, { kind: 'adjustment', credits: 100 });
      const reserved = await h().base.service.reserve({
        accountId: id,
        reservationId: randomUUID(),
        agentSessionId: `as_${randomUUID()}`,
        idempotencyKey: null,
        model: 'claude-sonnet-5',
        mode: 'enforce',
        bootId: 'boot-s14-fixes',
      });
      expect(reserved.outcome, 'test setup: the task must reserve').toBe('reserved');
      const state = await aiState(await appFor(id, 'team_manual'));
      expect(state.status, state.raw).toBe(200);
      // Sonnet reserves its 60-credit maximum out of the 100.
      expect(state.body.balance.available_credits).toBe(40);
      expect(state.body.balance.extras).toEqual([
        expect.objectContaining({ kind: 'goodwill', remaining_credits: 40 }),
      ]);
    });
  });

  describe('#5 + #6 — the state route refreshes first and reads the contract', () => {
    it('CRITICAL a moved Enterprise account with a contract and no window yet reads its new window and the contract figure', async () => {
      const id = await account('enterprise');
      await h().overrides.upsert({ accountId: id, monthlyCredits: 40_000, reason: 'contract' });
      const state = await aiState(await appFor(id, 'enterprise'));
      expect(state.status, state.raw).toBe(200);
      expect(AccountAiStateSchema.safeParse(state.body).success).toBe(true);
      expect(state.body.plan.monthly_included_credits).toBe(40_000);
      expect(
        state.body.balance.monthly,
        'the refresh created the window before the read',
      ).not.toBeNull();
      expect(state.body.balance.available_credits).toBeGreaterThan(0);
      expect(state.body.blocked_reason).toBeNull();
    });
  });
});
