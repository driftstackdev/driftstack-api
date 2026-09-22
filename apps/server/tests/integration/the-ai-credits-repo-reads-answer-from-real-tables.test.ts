// S14 — the new no-lock reads `GET /v1/account/me/ai`, its ledger page and
// `GET /v1/ai/models` need, proved against real Postgres:
// `DrizzleCreditLedgerRepo.{monthlyLotForWindow,liveExtraLots,
// ledgerPageWithBalance,chargedForSessionMicro}`,
// `DrizzleCreditWindowsRepo.pendingClaimTotalMicroNoLock`,
// `DrizzleCreditReservationsRepo.openEnforceCountNoLock`, and
// `DrizzleCreditRateCardRepo.nextAnnouncedCard`.
//
// No HTTP here — the route wiring is proved against a fake runtime in
// the-ai-state-route-reports-when-credits-reset-from-the-billing-period.test.ts.
// This file is the repository layer underneath it, the same split S13's
// a-moved-accounts-old-status-numbers-are-read-correctly-from-real-tables.test.ts
// uses.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleCreditLedgerRepo } from '../../src/db/credit-ledger-repo.js';
import { DrizzleCreditWindowsRepo } from '../../src/db/credit-windows-repo.js';
import { DrizzleCreditReservationsRepo } from '../../src/db/credit-reservations-repo.js';
import { DrizzleCreditRateCardRepo } from '../../src/db/credit-rate-card-repo.js';
import {
  MICRO,
  fundedLot,
  grantAll,
  insertLot,
  openLedgerDatabase,
} from './_helpers/credit-ledger-fixtures.js';
import { agedReservation } from './_helpers/credit-reservation-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_s14_account_ai_reads';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;
let database: Database | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  database = createDb(opened.url, { max: 4 });
}, 60_000);

afterAll(async () => {
  await database?.close().catch(() => {});
  await client?.end({ timeout: 5 }).catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}
/** The drizzle-wrapped connection a `CreditLedgerExecutor` parameter needs —
 *  distinct from `db()`'s raw `postgres.Sql`, which is only for the raw-SQL
 *  seeding helpers below. */
function drizzleDb(): Database['db'] {
  if (database === null) throw new Error('isolated database unreachable');
  return database.db;
}
function ledger(): DrizzleCreditLedgerRepo {
  if (database === null) throw new Error('isolated database unreachable');
  return new DrizzleCreditLedgerRepo(database);
}
function windows(): DrizzleCreditWindowsRepo {
  if (database === null) throw new Error('isolated database unreachable');
  return new DrizzleCreditWindowsRepo(database);
}
function reservations(): DrizzleCreditReservationsRepo {
  return new DrizzleCreditReservationsRepo();
}
function rateCards(): DrizzleCreditRateCardRepo {
  if (database === null) throw new Error('isolated database unreachable');
  return new DrizzleCreditRateCardRepo(database);
}

async function movedAccount(sql: postgres.Sql, tier = 'team_manual'): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO accounts (id, email, tier) VALUES (${id}::uuid, ${`s14-${id}@example.test`}, ${tier}::account_tier)`;
  await sql`INSERT INTO credit_accounts (account_id, billing_mode) VALUES (${id}::uuid, 'credits')`;
  return id;
}

async function liveWindow(
  sql: postgres.Sql,
  accountId: string,
  levelCredits: number,
): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO credit_windows (account_id, source, source_ref, natural_start, natural_end,
                                window_start, window_end, tier, level_micro)
    VALUES (${accountId}::uuid, 'plan_override', ${`ref-${randomUUID()}`},
            now() - interval '10 days', now() + interval '20 days',
            now() - interval '10 days', now() + interval '20 days',
            'team_manual'::account_tier, ${levelCredits * MICRO})
    RETURNING id`;
  if (row === undefined) throw new Error('window insert returned nothing');
  return row.id;
}

async function monthlyLotOf(
  sql: postgres.Sql,
  accountId: string,
  windowId: string,
  credits: number,
): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO credit_lots (account_id, kind, spend_rank, window_id, grant_key, granted_micro, starts_at, expires_at)
    SELECT account_id, 'monthly', 0, id, ${`window:${windowId}`}, ${credits * MICRO}, window_start, window_end
      FROM credit_windows WHERE id = ${windowId}::uuid
    RETURNING id`;
  if (row === undefined) throw new Error('lot insert returned nothing');
  await grantAll(sql, accountId, row.id);
  return row.id;
}

/** One task_charge ledger row against `lotId`, with a chosen agent_session_id. */
async function taskCharge(
  sql: postgres.Sql,
  accountId: string,
  lotId: string,
  chargedMicro: number,
  agentSessionId: string,
  key: string,
): Promise<void> {
  const reservationId = await agedReservation(sql, {
    accountId,
    lotId,
    reservedMicro: chargedMicro,
  });
  await sql`
    INSERT INTO credit_ledger
      (account_id, kind, lot_id, lot_delta_micro, idempotency_key, reservation_id, rate_card_version, model, agent_session_id)
    VALUES (${accountId}::uuid, 'task_charge', ${lotId}::uuid, ${-chargedMicro}::bigint, ${key},
            ${reservationId}::uuid, 1, 'claude-sonnet-5', ${agentSessionId})`;
}

describe.skipIf(!RUN_DB_TESTS)('S14 — the new AI-credits read methods, against real tables', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
  });

  describe('monthlyLotForWindow', () => {
    it('CRITICAL finds the window’s own monthly lot', async () => {
      const accountId = await movedAccount(db());
      const windowId = await liveWindow(db(), accountId, 3_000);
      const lotId = await monthlyLotOf(db(), accountId, windowId, 3_000);
      const lot = await ledger().monthlyLotForWindow(accountId, windowId);
      expect(lot?.id).toBe(lotId);
      expect(lot?.grantedMicro).toBe(3_000 * MICRO);
      expect(lot?.remainingMicro).toBe(3_000 * MICRO);
    });

    it('null when the window has no monthly lot yet', async () => {
      const accountId = await movedAccount(db());
      const windowId = await liveWindow(db(), accountId, 3_000);
      expect(await ledger().monthlyLotForWindow(accountId, windowId)).toBeNull();
    });
  });

  describe('liveExtraLots', () => {
    it('CRITICAL lists a live goodwill lot and excludes the monthly one', async () => {
      const accountId = await movedAccount(db());
      const windowId = await liveWindow(db(), accountId, 3_000);
      await monthlyLotOf(db(), accountId, windowId, 3_000);
      const goodwillId = await fundedLot(db(), accountId, { kind: 'adjustment', credits: 50 });
      const extras = await ledger().liveExtraLots(accountId);
      expect(extras.map((l) => l.id)).toEqual([goodwillId]);
      expect(extras[0]?.kind).toBe('adjustment');
    });

    it('excludes a lot with nothing left (fully spent, remaining_micro = 0)', async () => {
      const accountId = await movedAccount(db());
      const lotId = await fundedLot(db(), accountId, { kind: 'adjustment', credits: 10 });
      // A negative adjustment needs no reservation/hold machinery, unlike a
      // task_charge — the simplest way to drive a lot's remaining to zero.
      await db()`
        INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
        VALUES (${accountId}::uuid, 'adjustment', ${lotId}::uuid, ${-10 * MICRO}::bigint, 'spend-it-all')`;
      expect(await ledger().liveExtraLots(accountId)).toEqual([]);
    });

    it('excludes an expired lot', async () => {
      const accountId = await movedAccount(db());
      await fundedLot(db(), accountId, {
        kind: 'adjustment',
        credits: 10,
        starts: "now() - interval '2 days'",
        expires: "now() - interval '1 day'",
      });
      expect(await ledger().liveExtraLots(accountId)).toEqual([]);
    });
  });

  describe('ledgerPageWithBalance — newest first, never skips an entry, correct running balance', () => {
    it('CRITICAL five entries walked two pages of three never skip or repeat one, and land in strict descending id order', async () => {
      const accountId = await movedAccount(db());
      const lotId = await fundedLot(db(), accountId, { kind: 'adjustment', credits: 100 });
      // Four MORE ledger rows beyond the grant already written by fundedLot —
      // negative adjustments, which need no reservation/hold machinery, unlike
      // a task_charge (irrelevant to what this test proves: pagination and the
      // running balance, not the kind mapping, which is unit-tested elsewhere).
      for (let i = 0; i < 4; i += 1) {
        await db()`
          INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
          VALUES (${accountId}::uuid, 'adjustment', ${lotId}::uuid, ${-1 * MICRO}::bigint, ${`page:${i}`})`;
      }
      const firstPage = await ledger().ledgerPageWithBalance(accountId, { limit: 3 });
      expect(firstPage.entries).toHaveLength(3);
      expect(firstPage.nextCursor).not.toBeNull();
      const secondPage = await ledger().ledgerPageWithBalance(accountId, {
        limit: 3,
        cursor: firstPage.nextCursor ?? undefined,
      });
      expect(secondPage.nextCursor).toBeNull();
      const allIds = [...firstPage.entries, ...secondPage.entries].map((e) => e.id);
      // Exactly 5 rows total (1 grant + 4 charges); no id repeats across the boundary.
      expect(allIds).toHaveLength(5);
      expect(new Set(allIds).size).toBe(5);
      // Strictly descending — newest first, across the page boundary too.
      const numeric = allIds.map((id) => BigInt(id));
      for (let i = 1; i < numeric.length; i += 1) {
        expect(numeric[i]! < numeric[i - 1]!).toBe(true);
      }
      // The final (oldest, last-returned) entry is the grant that funded the
      // lot, and its running balance is exactly what it granted.
      const oldest = secondPage.entries[secondPage.entries.length - 1];
      expect(oldest?.kind).toBe('grant');
      expect(oldest?.balanceAfterMicro).toBe(100 * MICRO);
      // The newest entry's running balance is the grant minus all 4 charges.
      const newest = firstPage.entries[0];
      expect(newest?.balanceAfterMicro).toBe(96 * MICRO);
    });

    it('a debt_repayment row nets to zero balance movement: lot_delta and debt_delta cancel', async () => {
      const accountId = await movedAccount(db());
      const lotId = await fundedLot(db(), accountId, { kind: 'adjustment', credits: 20 });
      // debt_micro moves only through credit_ledger (a trigger refuses any
      // other write to it), and the database refuses to COMMIT an account that
      // holds debt beside spendable credit — so incur AND repay in the SAME
      // transaction; only the state at commit (debt back to zero) is checked.
      await db().begin(async (tx) => {
        await tx`
          INSERT INTO credit_ledger (account_id, kind, debt_delta_micro, idempotency_key, reason)
          VALUES (${accountId}::uuid, 'debt_incurred', ${5 * MICRO}::bigint, 'incur-1', 'payment_reversed')`;
        await tx`
          INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, debt_delta_micro, idempotency_key)
          VALUES (${accountId}::uuid, 'debt_repayment', ${lotId}::uuid, ${-5 * MICRO}::bigint, ${-5 * MICRO}::bigint, 'repay-1')`;
      });
      const page = await ledger().ledgerPageWithBalance(accountId, { limit: 10 });
      const incurred = page.entries.find((e) => e.kind === 'debt_incurred');
      const repayment = page.entries.find((e) => e.kind === 'debt_repayment');
      expect(incurred).toBeDefined();
      expect(repayment).toBeDefined();
      // Incurring the debt already dropped the net position from the 20-credit
      // grant to 15 (lot_delta 0 − debt_delta +5). The repayment itself moves
      // NOTHING net — lot_delta −5 and debt_delta −5 cancel — so the balance
      // stays at 15: repaying debt does not hand back what incurring it took.
      expect(incurred?.balanceAfterMicro).toBe(15 * MICRO);
      expect(repayment?.balanceAfterMicro).toBe(15 * MICRO);
    });

    it('lotExpiresAt is populated on a grant row and null on a row with no lot', async () => {
      const accountId = await movedAccount(db());
      const lotId = await insertLot(db(), accountId, {
        kind: 'adjustment',
        credits: 10,
        expires: "now() + interval '15 days'",
      });
      await grantAll(db(), accountId, lotId);
      // Same commit-time invariant as the test above: incur and immediately
      // repay in one transaction, so a 'debt_incurred' row is on the ledger
      // (what this test inspects) without leaving debt outstanding at commit.
      await db().begin(async (tx) => {
        await tx`
          INSERT INTO credit_ledger (account_id, kind, debt_delta_micro, idempotency_key, reason)
          VALUES (${accountId}::uuid, 'debt_incurred', ${1 * MICRO}::bigint, 'debt-1', 'plan_change')`;
        await tx`
          INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, debt_delta_micro, idempotency_key)
          VALUES (${accountId}::uuid, 'debt_repayment', ${lotId}::uuid, ${-1 * MICRO}::bigint, ${-1 * MICRO}::bigint, 'debt-1-repay')`;
      });
      const page = await ledger().ledgerPageWithBalance(accountId, { limit: 10 });
      const grant = page.entries.find((e) => e.kind === 'grant');
      const debt = page.entries.find((e) => e.kind === 'debt_incurred');
      expect(grant?.lotExpiresAt).not.toBeNull();
      expect(debt?.lotExpiresAt).toBeNull();
    });
  });

  describe('chargedForSessionMicro', () => {
    it('CRITICAL sums only this agent session’s task_charge rows', async () => {
      const accountId = await movedAccount(db());
      const lotId = await fundedLot(db(), accountId, { kind: 'adjustment', credits: 100 });
      const sessionA = `agt_${randomUUID()}`;
      const sessionB = `agt_${randomUUID()}`;
      await taskCharge(db(), accountId, lotId, 3 * MICRO, sessionA, 'a-1');
      await taskCharge(db(), accountId, lotId, 4 * MICRO, sessionA, 'a-2');
      await taskCharge(db(), accountId, lotId, 9 * MICRO, sessionB, 'b-1');
      expect(await ledger().chargedForSessionMicro(sessionA)).toBe(7 * MICRO);
      expect(await ledger().chargedForSessionMicro(sessionB)).toBe(9 * MICRO);
    });

    it('zero for a session with no charges', async () => {
      expect(await ledger().chargedForSessionMicro(`agt_${randomUUID()}`)).toBe(0);
    });
  });

  describe('pendingClaimTotalMicroNoLock', () => {
    it('CRITICAL sums standing pending claims across clawbacks, with no lock held', async () => {
      const accountId = await movedAccount(db());
      await db()`
        INSERT INTO credit_clawbacks (account_id, source, source_ref, target_key, amount_micro, state,
                                       clawed_micro, pending_micro, debt_micro)
        VALUES (${accountId}::uuid, 'plan_change', ${`ref-${randomUUID()}`}, ${`target-${randomUUID()}`},
                ${10 * MICRO}::bigint, 'applied', ${3 * MICRO}::bigint, ${7 * MICRO}::bigint, 0)`;
      expect(await windows().pendingClaimTotalMicroNoLock(accountId)).toBe(7 * MICRO);
    });

    it('zero when no clawback stands against the account', async () => {
      const accountId = await movedAccount(db());
      expect(await windows().pendingClaimTotalMicroNoLock(accountId)).toBe(0);
    });
  });

  describe('openEnforceCountNoLock', () => {
    it('CRITICAL counts only OPEN enforce reservations for the account', async () => {
      const accountId = await movedAccount(db());
      const lotId = await fundedLot(db(), accountId, { kind: 'adjustment', credits: 100 });
      await agedReservation(db(), { accountId, lotId, reservedMicro: 1 * MICRO });
      await agedReservation(db(), { accountId, lotId, reservedMicro: 1 * MICRO });
      expect(await reservations().openEnforceCountNoLock(accountId, drizzleDb())).toBe(2);
    });

    it('zero for an account with none open', async () => {
      const accountId = await movedAccount(db());
      expect(await reservations().openEnforceCountNoLock(accountId, drizzleDb())).toBe(0);
    });
  });

  describe('nextAnnouncedCard', () => {
    it('CRITICAL finds the soonest not-withdrawn card whose effective_at is after "at"', async () => {
      await db()`
        INSERT INTO credit_rate_cards (version, markup_bp, announced_at, effective_at, note)
        VALUES (101, 20000, now(), now() + interval '40 days', 'future card A')`;
      await db()`
        INSERT INTO credit_rate_cards (version, markup_bp, announced_at, effective_at, note)
        VALUES (102, 20000, now(), now() + interval '80 days', 'future card B, later')`;
      const next = await rateCards().nextAnnouncedCard(new Date());
      expect(next?.version).toBe(101);
    });

    it('a withdrawn card is never returned as the next one', async () => {
      await db()`
        INSERT INTO credit_rate_cards (version, markup_bp, announced_at, effective_at, withdrawn_at, note)
        VALUES (201, 20000, now(), now() + interval '40 days', now(), 'withdrawn before it took effect')`;
      const next = await rateCards().nextAnnouncedCard(new Date());
      expect(next?.version).not.toBe(201);
    });
  });
});
