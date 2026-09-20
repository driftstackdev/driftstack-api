// A credit window changes only its level, one step at a time, and dies only
// with its account.
//
// A window is the record of WHAT a month of credits was granted for: which
// payment, which month, which part of it. Refunds map back to it, plan changes
// are prorated inside it, and a customer's history is read from it. If its dates
// or its payment could be edited, every one of those would be reading a record
// that no longer says what happened. So the database lets a window change
// exactly one thing — its monthly level — and only one counted step at a time,
// so that a level's history can never have a gap or a repeat. The history rows
// and the clawback records that hang off a window are held the same way.
//
// All of it is proved with raw SQL, against the triggers alone: they are what is
// left when a migration, an admin session or a new code path writes these tables
// without going through the repository.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { insertWindow, newAccountOn, windowsOf } from './_helpers/credit-grant-fixtures.js';
import { inRolledBackTransaction, refusal } from './_helpers/database-refusal.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_window_guard';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  if (opened !== null) client = opened.sql;
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

type Sql = postgres.Sql | postgres.TransactionSql;

async function monthlyLot(sql: Sql, windowId: string, key = `window:${windowId}`): Promise<string> {
  const [lot] = await sql<Array<{ id: string }>>`
    INSERT INTO credit_lots (account_id, kind, spend_rank, window_id, grant_key, granted_micro, starts_at, expires_at)
    SELECT account_id, 'monthly', 0, id, ${key}, level_micro, window_start, window_end
      FROM credit_windows WHERE id = ${windowId}::uuid
    RETURNING id`;
  if (lot === undefined) throw new Error('lot insert returned nothing');
  return lot.id;
}

async function levelChange(sql: Sql, windowId: string, seq: number): Promise<void> {
  await sql`
    INSERT INTO credit_window_level_changes
      (window_id, seq, reason, from_level_micro, to_level_micro, effective_at, delta_micro)
    VALUES (${windowId}::uuid, ${seq}, 'plan_change', 3000000000, 10000000000, now(), 4000000000)`;
}

async function clawback(sql: Sql, accountId: string, pendingMicro = 0): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO credit_clawbacks
      (account_id, source, source_ref, target_key, fraction_ppm, state, clawed_micro, pending_micro, debt_micro)
    VALUES (${accountId}::uuid, 'stripe_refund', ${`ch_${randomUUID()}`}, 'window:w', 500000, 'applied',
            1000000000, ${pendingMicro}, 0)
    RETURNING id`;
  if (row === undefined) throw new Error('clawback insert returned nothing');
  return row.id;
}

describe.skipIf(!RUN_DB_TESTS)(
  'a credit window changes only its level and dies only with its account',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it('every trigger function this migration installs pins its search_path, so a temporary table named like a credit table cannot stand in for it inside a guard', async () => {
      const rows = await db()<Array<{ name: string; config: string[] | null }>>`
      SELECT proname AS name, proconfig AS config FROM pg_proc
       WHERE proname IN ('credit_windows_guard', 'credit_window_level_changes_guard', 'credit_clawbacks_guard')
       ORDER BY proname`;
      expect(rows.map((r) => r.name)).toEqual([
        'credit_clawbacks_guard',
        'credit_window_level_changes_guard',
        'credit_windows_guard',
      ]);
      for (const r of rows) expect(r.config, r.name).toEqual(['search_path=public, pg_temp']);
    });

    it('CRITICAL every column of a window but its level is immutable: the account, the payment, the month, the part of it covered, the plan, its id and when it was written', async () => {
      const accountId = await newAccountOn(db());
      const other = await newAccountOn(db());
      const windowId = await insertWindow(db(), accountId, {
        start: "date_trunc('second', now()) - interval '10 days'",
        end: "date_trunc('second', now()) + interval '20 days'",
        naturalStart: "date_trunc('second', now()) - interval '11 days'",
        naturalEnd: "date_trunc('second', now()) + interval '21 days'",
      });
      const edits: Array<[string, string]> = [
        ['its account', `account_id = '${other}'`],
        ['its source', "source = 'crypto_entitlement'"],
        ['its payment', "source_ref = 'in_other'"],
        ['its month’s start', "natural_start = natural_start - interval '1 hour'"],
        ['its month’s end', "natural_end = natural_end + interval '1 hour'"],
        ['its start', "window_start = window_start - interval '1 hour'"],
        ['its end', "window_end = window_end + interval '1 hour'"],
        ['its plan', "tier = 'api_scale'"],
        ['its id', `id = '${randomUUID()}'`],
        ['when it was written', "created_at = created_at - interval '1 day'"],
      ];
      for (const [what, set] of edits) {
        const r = await refusal(
          () => db().unsafe(`UPDATE credit_windows SET ${set} WHERE id = '${windowId}'`),
          what,
        );
        expect(r.code, what).toBe('55000');
        expect(r.message, what).toBe('a credit window changes only its level, one step at a time');
      }
      const [w] = await windowsOf(db(), accountId);
      expect(w?.level_seq).toBe(0);
    });

    it('CRITICAL a level change moves the step counter by exactly one — no level change without a step, no step without a level change, no skipped step, no step backwards', async () => {
      const accountId = await newAccountOn(db());
      const windowId = await insertWindow(db(), accountId, { credits: 3_000 });
      const refused: Array<[string, string]> = [
        ['a new level with no step', 'level_micro = 10000000000'],
        ['a step with no new level', 'level_seq = level_seq + 1'],
        ['a new level two steps on', 'level_micro = 10000000000, level_seq = level_seq + 2'],
        ['a new level a step back', 'level_micro = 10000000000, level_seq = level_seq - 1'],
      ];
      for (const [what, set] of refused) {
        const r = await refusal(
          () => db().unsafe(`UPDATE credit_windows SET ${set} WHERE id = '${windowId}'`),
          what,
        );
        expect(r.code, what).toBe('55000');
      }

      await db().unsafe(
        `UPDATE credit_windows SET level_micro = 10000000000, level_seq = level_seq + 1 WHERE id = '${windowId}'`,
      );
      await db().unsafe(
        `UPDATE credit_windows SET level_micro = 5000000000, level_seq = level_seq + 1 WHERE id = '${windowId}'`,
      );
      const [w] = await windowsOf(db(), accountId);
      expect([w?.level_micro, w?.level_seq]).toEqual(['5000000000', 2]);
      // An UPDATE that changes nothing is not a change.
      await db().unsafe(
        `UPDATE credit_windows SET level_micro = level_micro WHERE id = '${windowId}'`,
      );
    });

    it('a window cannot be deleted, a level-change row cannot be edited or deleted, and a clawback record cannot be deleted', async () => {
      const accountId = await newAccountOn(db());
      const windowId = await insertWindow(db(), accountId);
      await levelChange(db(), windowId, 1);
      const clawbackId = await clawback(db(), accountId);

      const cases: Array<[string, string, string]> = [
        [
          'deleting a window',
          `DELETE FROM credit_windows WHERE id = '${windowId}'`,
          'credit_windows rows are removed only with their account',
        ],
        [
          'deleting a level change',
          `DELETE FROM credit_window_level_changes WHERE window_id = '${windowId}'`,
          'credit_window_level_changes is append-only: DELETE refused',
        ],
        [
          'editing a level change',
          `UPDATE credit_window_level_changes SET to_level_micro = 1000000 WHERE window_id = '${windowId}'`,
          'credit_window_level_changes is append-only: UPDATE refused',
        ],
        [
          'deleting a clawback',
          `DELETE FROM credit_clawbacks WHERE id = '${clawbackId}'`,
          'credit_clawbacks rows are removed only with their account',
        ],
      ];
      for (const [what, statement, message] of cases) {
        const r = await refusal(() => db().unsafe(statement), what);
        expect(r.code, what).toBe('55000');
        expect(r.message, what).toBe(message);
      }
    });

    it('a clawback record may only pay down what it is still owed, or be reversed once: its facts never change, its pending claim never rises, and no other state move is allowed', async () => {
      const accountId = await newAccountOn(db());
      const id = await clawback(db(), accountId, 400_000_000);
      const refused: Array<[string, string]> = [
        ['its amount', 'clawed_micro = 1'],
        ['its debt', 'debt_micro = 5'],
        ['its reference', "source_ref = 'ch_other'"],
        ['its target', "target_key = 'window:other'"],
        ['its share', 'fraction_ppm = 1'],
        ['a pending claim that rises', 'pending_micro = pending_micro + 1'],
        ['applied → unmatched', "state = 'unmatched', clawed_micro = NULL, debt_micro = NULL"],
      ];
      for (const [what, set] of refused) {
        const r = await refusal(
          () => db().unsafe(`UPDATE credit_clawbacks SET ${set} WHERE id = '${id}'`),
          what,
        );
        expect(r.code, what).toBe('55000');
        expect(r.message, what).toBe(
          'a clawback only pays down its pending claim or is reversed once',
        );
      }
      await db().unsafe(`UPDATE credit_clawbacks SET pending_micro = 150000000 WHERE id = '${id}'`);
      await db().unsafe(`UPDATE credit_clawbacks SET pending_micro = 0 WHERE id = '${id}'`);
      await db().unsafe(`UPDATE credit_clawbacks SET state = 'reversed' WHERE id = '${id}'`);
      const back = await refusal(() =>
        db().unsafe(`UPDATE credit_clawbacks SET state = 'applied' WHERE id = '${id}'`),
      );
      expect(back.code, 'reversed → applied').toBe('55000');
    });

    it('the same refund is recorded once: a second clawback for the same source, reference and target is refused by the unique index', async () => {
      const accountId = await newAccountOn(db());
      const insert = (): Promise<unknown> =>
        db()`
        INSERT INTO credit_clawbacks
          (account_id, source, source_ref, target_key, amount_micro, state, clawed_micro, debt_micro)
        VALUES (${accountId}::uuid, 'stripe_refund', 'ch_once:5000', 'window:w1', 5000000, 'applied', 5000000, 0)`;
      await insert();
      const r = await refusal(insert);
      expect(r.code).toBe('23505');
      expect(r.constraint).toBe('credit_clawbacks_idempotency_unique');
    });

    it('CRITICAL an included lot must name a window that EXISTS — the foreign key this migration adds — and a window has at most ONE monthly lot, while plan-change lots may share it', async () => {
      const accountId = await newAccountOn(db());
      const orphan = await refusal(
        () =>
          db()`
        INSERT INTO credit_lots (account_id, kind, spend_rank, window_id, grant_key, granted_micro, starts_at, expires_at)
        VALUES (${accountId}::uuid, 'monthly', 0, ${randomUUID()}::uuid, 'window:nowhere', 1000000,
                now() - interval '1 day', now() + interval '1 day')`,
      );
      expect(orphan.code).toBe('23503');
      expect(orphan.constraint).toBe('credit_lots_window_fk');

      const windowId = await insertWindow(db(), accountId);
      await monthlyLot(db(), windowId);
      const second = await refusal(() => monthlyLot(db(), windowId, 'window:again'));
      expect(second.code).toBe('23505');
      expect(second.constraint).toBe('credit_lots_one_monthly_per_window');

      for (const key of ['proration:1', 'proration:2']) {
        await db()`
        INSERT INTO credit_lots (account_id, kind, spend_rank, window_id, grant_key, granted_micro, starts_at, expires_at)
        SELECT account_id, 'proration', 0, id, ${`${key}:${windowId}`}, 1000000, window_start, window_end
          FROM credit_windows WHERE id = ${windowId}::uuid`;
      }
    });

    it("CRITICAL an included lot must name a window of ITS OWN account, not merely a window that exists. The ledger already refuses a row naming another account's lot (0128, 'names a lot of another account'); the same rule one table up is this foreign key, over the window AND the account. Without it a lot draws a month of credits from a window nobody sold to that account — and, because a window dies only with ITS account, the cascade of deleting the OTHER account then raises inside an unrelated DELETE and that account can never be removed", async () => {
      const mine = await newAccountOn(db());
      const theirs = await newAccountOn(db());
      const theirWindow = await insertWindow(db(), theirs, { credits: 5_000 });

      const stolen = await refusal(
        () =>
          db()`
        INSERT INTO credit_lots (account_id, kind, spend_rank, window_id, grant_key, granted_micro, starts_at, expires_at)
        SELECT ${mine}::uuid, 'monthly', 0, id, 'window:borrowed', level_micro, window_start, window_end
          FROM credit_windows WHERE id = ${theirWindow}::uuid`,
      );
      expect(stolen.code, 'a lot naming another account’s window').toBe('23503');
      expect(stolen.constraint).toBe('credit_lots_window_fk');

      // A plan-change lot is held to the same rule: every lot that names a
      // window is one of that window's account's included credits.
      const alsoStolen = await refusal(
        () =>
          db()`
        INSERT INTO credit_lots (account_id, kind, spend_rank, window_id, grant_key, granted_micro, starts_at, expires_at)
        SELECT ${mine}::uuid, 'proration', 0, id, 'proration:borrowed', 1000000, window_start, window_end
          FROM credit_windows WHERE id = ${theirWindow}::uuid`,
      );
      expect(alsoStolen.code, 'a proration lot naming another account’s window').toBe('23503');

      // POSITIVE CONTROL, both halves: the same lot on the window's OWN account
      // is accepted, and the other account can still be deleted afterwards.
      const ownWindow = await insertWindow(db(), mine, { credits: 5_000 });
      await monthlyLot(db(), ownWindow);
      const left = await inRolledBackTransaction(db(), async (tx) => {
        await tx`DELETE FROM accounts WHERE id = ${theirs}::uuid`;
        const [row] = await tx<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM credit_windows WHERE account_id = ${theirs}::uuid`;
        return row?.n ?? -1;
      });
      expect(left, 'the other account could not be deleted').toBe(0);
    });

    it('CRITICAL deleting the ACCOUNT takes all of it: its windows, their level history, their lots and ledger rows, and its clawback records — the only way any of these rows is ever removed', async () => {
      // In a transaction that is rolled back: the arm proves the cascade is
      // ALLOWED, and leaves the database as it found it.
      const left = await inRolledBackTransaction(db(), async (tx) => {
        const accountId = await newAccountOn(tx);
        await tx`INSERT INTO credit_accounts (account_id) VALUES (${accountId}::uuid)`;
        const windowId = await insertWindow(tx, accountId);
        await tx.unsafe(
          `UPDATE credit_windows SET level_micro = 10000000000, level_seq = 1 WHERE id = '${windowId}'`,
        );
        await levelChange(tx, windowId, 1);
        const lotId = await monthlyLot(tx, windowId);
        await tx`
        INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
        SELECT account_id, 'grant', id, granted_micro, 'grant:' || id FROM credit_lots WHERE id = ${lotId}::uuid`;
        await clawback(tx, accountId);

        await tx`DELETE FROM accounts WHERE id = ${accountId}::uuid`;

        const [row] = await tx<Array<Record<string, number>>>`
        SELECT (SELECT count(*)::int FROM credit_windows WHERE account_id = ${accountId}::uuid) AS windows,
               (SELECT count(*)::int FROM credit_window_level_changes WHERE window_id = ${windowId}::uuid) AS changes,
               (SELECT count(*)::int FROM credit_lots WHERE account_id = ${accountId}::uuid) AS lots,
               (SELECT count(*)::int FROM credit_ledger WHERE account_id = ${accountId}::uuid) AS ledger,
               (SELECT count(*)::int FROM credit_clawbacks WHERE account_id = ${accountId}::uuid) AS clawbacks`;
        return row;
      });
      expect(left).toEqual({ windows: 0, changes: 0, lots: 0, ledger: 0, clawbacks: 0 });
    });
  },
);
