// The ledger reads a page at a time, newest first, and its rows sum to the
// balances.
//
// Two properties of one table. First, `ledgerPage` walks an account's ledger by
// keyset — each page the entries older than the cursor, which is the id of the
// last entry seen — so pages never overlap, a movement committed during the
// walk (newer than every cursor) neither repeats nor shifts it, and another
// account's rows never appear. What this does NOT prove: two writers on one
// account that each hold only the shared lock a ledger row takes can commit
// their ids out of order, and a walk already past the later id never sees the
// earlier one (a fresh walk does). Writers that take `lockAccount` first
// run one after the other and commit in id order. Second, the rule the
// whole design rests on, checked from the outside after a mixed run of
// movements: every lot's remaining equals the sum of its ledger rows, and the
// account's debt equals the sum of its debt deltas. The triggers make that true
// by construction; this reads it back.

import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Database } from '../../src/db/client.js';
import { DrizzleCreditLedgerRepo } from '../../src/db/credit-ledger-repo.js';
import { MICRO, newAccount, openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_ledger_page';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;
let database: Database | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened === null) return;
  client = opened.sql;
  database = createDb(opened.url, { max: 2 });
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await database?.close().catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function repo(): DrizzleCreditLedgerRepo {
  if (database === null) throw new Error('isolated database unreachable');
  return new DrizzleCreditLedgerRepo(database);
}

const DAY = 86_400_000;

/**
 * Eight ledger rows through the repository: two lots granted, an expiry, a
 * goodwill correction both ways, then debt incurred and repaid from both lots
 * in one transaction. Returns the account and its lots.
 */
async function history(): Promise<{ accountId: string; lots: string[] }> {
  const r = repo();
  const accountId = await newAccount(db());
  await r.ensureAccount(accountId);
  const lots: string[] = [];
  for (const [kind, credits] of [
    ['adjustment', 30],
    ['top_up', 20],
  ] as const) {
    const { lot } = await r.insertLot({
      accountId,
      kind,
      grantKey: `page:${accountId}:${kind}`,
      grantedMicro: credits * MICRO,
      startsAt: new Date(Date.now() - DAY),
      expiresAt: new Date(Date.now() + 30 * DAY),
    });
    lots.push(lot.id);
    await r.append({
      accountId,
      kind: 'grant',
      lotId: lot.id,
      amountMicro: credits * MICRO,
      idempotencyKey: `grant:${lot.id}`,
    });
  }
  const [goodwill, topUp] = lots as [string, string];
  await r.append({
    accountId,
    kind: 'expiry',
    lotId: topUp,
    amountMicro: 5 * MICRO,
    idempotencyKey: 'h:expire',
  });
  await r.append({
    accountId,
    kind: 'adjustment',
    lotId: goodwill,
    lotDeltaMicro: -4 * MICRO,
    idempotencyKey: 'h:adjust-down',
    actor: 'admin',
    reason: 'correction',
  });
  await r.append({
    accountId,
    kind: 'adjustment',
    lotId: goodwill,
    lotDeltaMicro: 2 * MICRO,
    idempotencyKey: 'h:adjust-up',
    actor: 'admin',
    reason: 'correction',
  });
  // Debt beyond all free credit, repaid from both lots in one transaction.
  await r.transaction(async (tx) => {
    await r.lockAccount(tx, accountId);
    await r.append(
      {
        accountId,
        kind: 'debt_incurred',
        amountMicro: 50 * MICRO,
        reason: 'payment_reversed',
        idempotencyKey: 'h:debt',
      },
      tx,
    );
    await r.append(
      {
        accountId,
        kind: 'debt_repayment',
        lotId: goodwill,
        amountMicro: 28 * MICRO,
        idempotencyKey: 'h:repay-1',
      },
      tx,
    );
    await r.append(
      {
        accountId,
        kind: 'debt_repayment',
        lotId: topUp,
        amountMicro: 15 * MICRO,
        idempotencyKey: 'h:repay-2',
      },
      tx,
    );
  });
  return { accountId, lots };
}

describe.skipIf(!RUN_DB_TESTS)(
  'the ledger page reads newest first and the ledger sums to the balances',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
      expect(database).not.toBeNull();
    });

    it('CRITICAL every lot balance is the sum of its ledger rows, and the debt the sum of the debt deltas, after a mixed run of movements', async () => {
      const { accountId, lots } = await history();
      const rows = await db()<Array<{ lot: string; remaining: string; summed: string }>>`
        SELECT l.id AS lot, l.remaining_micro::text AS remaining,
               COALESCE((SELECT sum(g.lot_delta_micro) FROM credit_ledger g WHERE g.lot_id = l.id), 0)::text AS summed
          FROM credit_lots l WHERE l.account_id = ${accountId}::uuid ORDER BY l.spend_rank`;
      expect(rows.map((r) => r.lot)).toEqual(lots);
      for (const row of rows) expect(row.remaining, `lot ${row.lot}`).toBe(row.summed);
      expect(rows.map((r) => Number(r.remaining))).toEqual([0, 0]);

      const [debt] = await db()<Array<{ debt: string; summed: string }>>`
        SELECT a.debt_micro::text AS debt,
               (SELECT sum(g.debt_delta_micro) FROM credit_ledger g WHERE g.account_id = a.account_id)::text AS summed
          FROM credit_accounts a WHERE a.account_id = ${accountId}::uuid`;
      expect(debt).toEqual({ debt: String(7 * MICRO), summed: String(7 * MICRO) });
    });

    it('CRITICAL pages walk newest first without overlap or gap, end with no cursor, and hold only this account', async () => {
      const { accountId } = await history();
      const other = await history();
      const r = repo();

      const [all] = await db()<Array<{ ids: string[] }>>`
        SELECT array_agg(id::text ORDER BY id DESC) AS ids FROM credit_ledger WHERE account_id = ${accountId}::uuid`;

      const seen: string[] = [];
      const sizes: number[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await r.ledgerPage(accountId, { limit: 3, ...(cursor ? { cursor } : {}) });
        sizes.push(page.entries.length);
        seen.push(...page.entries.map((e) => e.id));
        for (const e of page.entries) expect(e.accountId).toBe(accountId);
        if (guard === 0) {
          // A movement lands between pages. It is newer than every cursor from
          // here on, so the walk neither repeats nor skips because of it.
          await r.append({
            accountId,
            kind: 'adjustment',
            forgiveDebtMicro: MICRO,
            idempotencyKey: 'h:between',
          });
        }
        if (page.nextCursor === null) break;
        expect(page.nextCursor, 'the cursor is the last entry of the page').toBe(
          page.entries[page.entries.length - 1]?.id,
        );
        cursor = page.nextCursor;
      }
      expect(sizes, '8 entries in pages of 3; the last page says it is the last').toEqual([
        3, 3, 2,
      ]);
      expect(seen, 'every entry that existed when the walk began, once, newest first').toEqual(
        all?.ids,
      );
      const [newest, before] = await r.ledgerPage(accountId, { limit: 2 }).then((p) => p.entries);
      expect(newest?.idempotencyKey, 'a fresh first page starts at the new entry').toBe(
        'h:between',
      );
      expect(before?.idempotencyKey, 'then the last repayment').toBe('h:repay-2');

      const otherPage = await r.ledgerPage(other.accountId, { limit: 100 });
      expect(otherPage.entries).toHaveLength(8);
      expect(otherPage.nextCursor).toBeNull();
      expect(new Set(otherPage.entries.map((e) => e.id)).size).toBe(8);
      expect(otherPage.entries.some((e) => seen.includes(e.id))).toBe(false);
    });

    it('a page reports each entry as written: kind, signed deltas, actor and reason', async () => {
      const { accountId, lots } = await history();
      const page = await repo().ledgerPage(accountId, { limit: 100 });
      const byKey = new Map(page.entries.map((e) => [e.idempotencyKey, e]));
      expect(byKey.get('h:expire')).toMatchObject({
        kind: 'expiry',
        lotId: lots[1],
        lotDeltaMicro: -5 * MICRO,
        debtDeltaMicro: 0,
        actor: 'system',
        reason: null,
      });
      expect(byKey.get('h:adjust-down')).toMatchObject({
        kind: 'adjustment',
        lotDeltaMicro: -4 * MICRO,
        actor: 'admin',
        reason: 'correction',
      });
      expect(byKey.get('h:debt')).toMatchObject({
        kind: 'debt_incurred',
        lotId: null,
        lotDeltaMicro: 0,
        debtDeltaMicro: 50 * MICRO,
        reason: 'payment_reversed',
      });
      expect(byKey.get('h:repay-1')).toMatchObject({
        kind: 'debt_repayment',
        lotDeltaMicro: -28 * MICRO,
        debtDeltaMicro: -28 * MICRO,
      });
      for (const e of page.entries) expect(e.id).toMatch(/^[1-9][0-9]*$/);
    });

    it('a page refuses a limit outside 1 to 100 and a cursor that is not an entry id, before asking the database', async () => {
      const r = repo();
      const accountId = await newAccount(db());
      for (const limit of [0, 101, 2.5, Number.NaN]) {
        await expect(r.ledgerPage(accountId, { limit }), String(limit)).rejects.toThrow(RangeError);
      }
      for (const cursor of ['', '0', '-1', '01', 'abc', '1'.repeat(19), '1 OR 1=1']) {
        await expect(r.ledgerPage(accountId, { limit: 5, cursor }), cursor).rejects.toThrow(
          RangeError,
        );
      }
      expect((await r.ledgerPage(accountId, { limit: 5, cursor: '9'.repeat(18) })).entries).toEqual(
        [],
      );
    });
  },
);
