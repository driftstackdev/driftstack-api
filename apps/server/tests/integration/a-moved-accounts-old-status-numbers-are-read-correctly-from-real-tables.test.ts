// S13 — the reads and the one write the old bundled-llm-settings/-status
// routes need for a MOVED account (§8.6): `DrizzleCreditLedgerRepo.setAiSource`,
// `.otherLiveGrantedMicro`, `.chargedInWindowMicro`, and
// `DrizzleCreditWindowsRepo.currentWindow`'s widened shape (`windowStart` +
// `levelMicro`). Proved against real Postgres because the pure arithmetic in
// services/bundled-llm.ts (tested without a database in
// moved-account-bundled-llm-numbers-are-computed-not-stored.test.ts) is only
// as honest as what these four queries actually return.
//
// No HTTP here — the ROUTE wiring (which account is "moved", the PATCH
// refusals, the audit row) is proved by the-old-bundled-llm-routes-keep-a-
// defined-meaning-for-a-moved-account.test.ts against a fake runtime, the same
// way S12's turn-funding route tests do. This file is the repository layer
// underneath it.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleCreditLedgerRepo } from '../../src/db/credit-ledger-repo.js';
import { DrizzleCreditWindowsRepo } from '../../src/db/credit-windows-repo.js';
import {
  MICRO,
  fundedLot,
  grantAll,
  insertLot,
  openLedgerDatabase,
} from './_helpers/credit-ledger-fixtures.js';
import { ledgerOf } from './_helpers/credit-grant-fixtures.js';
import { agedReservation } from './_helpers/credit-reservation-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_moved_account_bundled_llm';
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

function ledger(): DrizzleCreditLedgerRepo {
  if (database === null) throw new Error('isolated database unreachable');
  return new DrizzleCreditLedgerRepo(database);
}

function windows(): DrizzleCreditWindowsRepo {
  if (database === null) throw new Error('isolated database unreachable');
  return new DrizzleCreditWindowsRepo(database);
}

/** A moved account (`billing_mode = 'credits'`), on `tier`. */
async function movedAccount(sql: postgres.Sql, tier = 'team_manual'): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO accounts (id, email, tier) VALUES (${id}::uuid, ${`moved-${id}@example.test`}, ${tier}::account_tier)`;
  await sql`INSERT INTO credit_accounts (account_id, billing_mode) VALUES (${id}::uuid, 'credits')`;
  return id;
}

/** A window that contains now(), at a given monthly level (in whole credits). */
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

/**
 * A window that is live NOW but will have ended by the time the caller checks
 * again a moment later — so a hold can be taken on its monthly lot while it is
 * still live (a hold needs a "started, live, unrevoked lot"), and the SAME lot
 * is due for `expireDueLots` shortly after, with no UPDATE involved: a lot's
 * own term (`starts_at`/`expires_at`) is immutable once inserted
 * (`credit_lots terms are immutable`). This is exactly S7's "a task that
 * started before its lot expired and is still being charged after".
 */
async function soonToEndWindow(
  sql: postgres.Sql,
  accountId: string,
  levelCredits: number,
): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO credit_windows (account_id, source, source_ref, natural_start, natural_end,
                                window_start, window_end, tier, level_micro)
    VALUES (${accountId}::uuid, 'plan_override', ${`ref-${randomUUID()}`},
            now() - interval '1 minute', now() + interval '300 milliseconds',
            now() - interval '1 minute', now() + interval '300 milliseconds',
            'team_manual'::account_tier, ${levelCredits * MICRO})
    RETURNING id`;
  if (row === undefined) throw new Error('window insert returned nothing');
  return row.id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The window's own monthly lot, funded in full, with the window's own term. */
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

/** One task_charge ledger row against `lotId`, backed by a real reservation (the FK the CHECK needs). */
async function taskCharge(
  sql: postgres.Sql,
  accountId: string,
  lotId: string,
  chargedMicro: number,
  key: string,
): Promise<void> {
  const reservationId = await agedReservation(sql, {
    accountId,
    lotId,
    reservedMicro: chargedMicro,
  });
  await sql`
    INSERT INTO credit_ledger
      (account_id, kind, lot_id, lot_delta_micro, idempotency_key, reservation_id, rate_card_version, model)
    VALUES (${accountId}::uuid, 'task_charge', ${lotId}::uuid, ${-chargedMicro}::bigint, ${key},
            ${reservationId}::uuid, 1, 'claude-sonnet-5')`;
}

describe.skipIf(!RUN_DB_TESTS)(
  "a moved account's old status numbers are read correctly from real tables",
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    describe('setAiSource — the one new write', () => {
      it('CRITICAL writes ai_source, ai_source_set_by and ai_source_set_at, and returns the updated record', async () => {
        const accountId = await movedAccount(db());
        const before = Date.now();
        const record = await ledger().setAiSource(accountId, {
          aiSource: 'own_key',
          setBy: 'customer',
        });
        expect(record.accountId).toBe(accountId);
        expect(record.aiSource).toBe('own_key');
        expect(record.aiSourceSetBy).toBe('customer');
        expect(record.aiSourceSetAt).not.toBeNull();
        expect(record.aiSourceSetAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
        // billing_mode is untouched by this write — it is not this method's job.
        expect(record.billingMode).toBe('credits');
      });

      it('writing null (automatic) clears a previously-chosen source back to automatic, attributed to whoever set it', async () => {
        const accountId = await movedAccount(db());
        await ledger().setAiSource(accountId, { aiSource: 'own_key', setBy: 'customer' });
        const record = await ledger().setAiSource(accountId, { aiSource: null, setBy: 'customer' });
        expect(record.aiSource).toBeNull();
        expect(record.aiSourceSetBy).toBe('customer');
      });

      it('creates the credit_accounts row if the account had none yet — the same upsert ensureAccount/lockAccount already do', async () => {
        const id = randomUUID();
        await db()`INSERT INTO accounts (id, email, tier) VALUES (${id}::uuid, ${`bare-${id}@example.test`}, 'team_manual'::account_tier)`;
        // No credit_accounts row inserted for this account.
        const record = await ledger().setAiSource(id, { aiSource: 'credits', setBy: 'cutover' });
        expect(record.aiSource).toBe('credits');
        expect(record.aiSourceSetBy).toBe('cutover');
        // And it persists: a plain read agrees with what the write returned.
        expect((await ledger().ensureAccount(id)).aiSource).toBe('credits');
      });

      it('persists across a separate read — the write is committed, not just echoed back', async () => {
        const accountId = await movedAccount(db());
        await ledger().setAiSource(accountId, { aiSource: 'own_key', setBy: 'admin' });
        const reread = await ledger().ensureAccount(accountId);
        expect(reread.aiSource).toBe('own_key');
        expect(reread.aiSourceSetBy).toBe('admin');
      });
    });

    describe('otherLiveGrantedMicro — every currently live lot except the monthly one', () => {
      it('CRITICAL sums a live adjustment lot and a live top-up lot together', async () => {
        const accountId = await movedAccount(db());
        await fundedLot(db(), accountId, { kind: 'adjustment', credits: 40 });
        await fundedLot(db(), accountId, { kind: 'top_up', credits: 10 });
        expect(await ledger().otherLiveGrantedMicro(accountId)).toBe(50 * MICRO);
      });

      it('CRITICAL a monthly lot is EXCLUDED — its amount belongs to "the window level", read separately', async () => {
        const accountId = await movedAccount(db());
        const windowId = await liveWindow(db(), accountId, 300);
        await monthlyLotOf(db(), accountId, windowId, 300);
        await fundedLot(db(), accountId, { kind: 'adjustment', credits: 20 });
        expect(await ledger().otherLiveGrantedMicro(accountId)).toBe(20 * MICRO);
      });

      it('an EXPIRED lot is excluded, even though it was granted the same as a live one', async () => {
        const accountId = await movedAccount(db());
        await fundedLot(db(), accountId, {
          kind: 'adjustment',
          credits: 999,
          expires: "now() - interval '1 minute'",
        });
        expect(await ledger().otherLiveGrantedMicro(accountId)).toBe(0);
      });

      it('a NOT-YET-STARTED lot is excluded', async () => {
        const accountId = await movedAccount(db());
        await fundedLot(db(), accountId, {
          kind: 'adjustment',
          credits: 999,
          starts: "now() + interval '1 hour'",
        });
        expect(await ledger().otherLiveGrantedMicro(accountId)).toBe(0);
      });

      it('a REVOKED lot is excluded, even though it is inside its term', async () => {
        const accountId = await movedAccount(db());
        const lotId = await fundedLot(db(), accountId, { kind: 'adjustment', credits: 999 });
        await db()`UPDATE credit_lots SET revoked_at = now() WHERE id = ${lotId}::uuid`;
        expect(await ledger().otherLiveGrantedMicro(accountId)).toBe(0);
      });

      it('sums what a lot was GRANTED, not what is left of it — spending it down leaves the figure unchanged', async () => {
        const accountId = await movedAccount(db());
        const lotId = await insertLot(db(), accountId, { kind: 'adjustment', credits: 100 });
        await grantAll(db(), accountId, lotId);
        await taskCharge(db(), accountId, lotId, 30 * MICRO, 'spend-does-not-shrink-the-grant');
        expect(await ledger().otherLiveGrantedMicro(accountId)).toBe(100 * MICRO);
      });

      it('0 for an account with only a monthly lot', async () => {
        const accountId = await movedAccount(db());
        const windowId = await liveWindow(db(), accountId, 300);
        await monthlyLotOf(db(), accountId, windowId, 300);
        expect(await ledger().otherLiveGrantedMicro(accountId)).toBe(0);
      });
    });

    describe("chargedInWindowMicro — what a window's OWN lots have been charged", () => {
      it("CRITICAL sums task_charge rows against the window's monthly lot", async () => {
        const accountId = await movedAccount(db());
        const windowId = await liveWindow(db(), accountId, 300);
        const lotId = await monthlyLotOf(db(), accountId, windowId, 300);
        await taskCharge(db(), accountId, lotId, 45 * MICRO, 'charge-1');
        await taskCharge(db(), accountId, lotId, 5 * MICRO, 'charge-2');
        expect(await ledger().chargedInWindowMicro(accountId, windowId)).toBe(50 * MICRO);
      });

      it("CRITICAL a charge against a DIFFERENT window's lot is not counted", async () => {
        const accountId = await movedAccount(db());
        const windowA = await liveWindow(db(), accountId, 300);
        const lotA = await monthlyLotOf(db(), accountId, windowA, 300);
        await taskCharge(db(), accountId, lotA, 10 * MICRO, 'window-a-charge');
        // A second account's window/lot, charged too — proves the sum is
        // scoped by WINDOW, not just "any task_charge with this account".
        expect(await ledger().chargedInWindowMicro(accountId, randomUUID())).toBe(0);
      });

      it('a charge against a window-less lot (adjustment/top-up) is not counted', async () => {
        const accountId = await movedAccount(db());
        const windowId = await liveWindow(db(), accountId, 300);
        await monthlyLotOf(db(), accountId, windowId, 300);
        const goodwillLotId = await insertLot(db(), accountId, {
          kind: 'adjustment',
          credits: 200,
        });
        await grantAll(db(), accountId, goodwillLotId);
        await taskCharge(db(), accountId, goodwillLotId, 20 * MICRO, 'goodwill-charge');
        expect(await ledger().chargedInWindowMicro(accountId, windowId)).toBe(0);
      });

      it('a non-task_charge row against the same lot (an expiry) is not counted', async () => {
        const accountId = await movedAccount(db());
        // Live long enough to take a hold and a charge on it, then ends on its
        // own a moment later — S7's "a task started before its lot expired and
        // is still being charged after", so expireDueLots has something to
        // expire without an UPDATE (a lot's own term is immutable once
        // inserted).
        const windowId = await soonToEndWindow(db(), accountId, 300);
        const lotId = await monthlyLotOf(db(), accountId, windowId, 300);
        await taskCharge(db(), accountId, lotId, 10 * MICRO, 'real-charge');
        await sleep(500);
        const repo = ledger();
        await repo.transaction(async (tx) => {
          await repo.lockAccount(tx, accountId);
          await repo.expireDueLots(tx, accountId);
        });
        // The expiry really happened — proof this test exercises what it says,
        // not a vacuous "there was never anything to miscount".
        const rows = await ledgerOf(db(), accountId);
        expect(rows.map((r) => r.kind).sort()).toEqual(['expiry', 'grant', 'task_charge']);
        expect(await repo.chargedInWindowMicro(accountId, windowId)).toBe(10 * MICRO);
      });

      it('0 for a window with no charges yet', async () => {
        const accountId = await movedAccount(db());
        const windowId = await liveWindow(db(), accountId, 300);
        await monthlyLotOf(db(), accountId, windowId, 300);
        expect(await ledger().chargedInWindowMicro(accountId, windowId)).toBe(0);
      });
    });

    describe('currentWindow — widened with windowStart and levelMicro (S13)', () => {
      it('CRITICAL returns id, windowStart and levelMicro for a window that contains now()', async () => {
        const accountId = await movedAccount(db());
        const windowId = await liveWindow(db(), accountId, 3_000);
        const current = await windows().currentWindow(accountId);
        expect(current).not.toBeNull();
        expect(current?.id).toBe(windowId);
        expect(current?.levelMicro).toBe(3_000 * MICRO);
        // windowStart is a real microsecond-precision UTC instant string —
        // proves this is the NEW field, not a copy of windowEnd.
        expect(current?.windowStart).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      });

      it('null when the account has no window covering now()', async () => {
        const accountId = await movedAccount(db());
        expect(await windows().currentWindow(accountId)).toBeNull();
      });
    });
  },
);
