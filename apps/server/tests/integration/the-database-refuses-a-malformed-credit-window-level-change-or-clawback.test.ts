// The database refuses a malformed credit window, level change or clawback.
//
// The repository that writes these tables checks what it writes. That is the
// first line, and it is the one most likely to be bypassed: by a later
// migration, a one-off admin statement, a new writer that did not reuse it. So
// every rule the rows must obey is a constraint in Postgres too, and each is
// proved here with raw SQL — refused BY THE NAMED CONSTRAINT, because a row
// refused by some other check first is a different guarantee, and reads the same
// from a bare "it threw".
//
// Every arm changes exactly one thing about a row that is otherwise accepted,
// and the first arm of each table proves that row IS accepted: without it, a
// fixture that was malformed in some second way would pass every arm below it.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { insertWindow, newAccountOn } from './_helpers/credit-grant-fixtures.js';
import { inRolledBackTransaction, refusal } from './_helpers/database-refusal.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_window_checks';
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

/** A well-formed window, as column → SQL expression. Each arm overrides one entry. */
const GOOD_WINDOW: Readonly<Record<string, string>> = {
  source: "'stripe_invoice'",
  source_ref: "'in_checks'",
  natural_start: "now() - interval '10 days'",
  natural_end: "now() + interval '20 days'",
  window_start: "now() - interval '5 days'",
  window_end: "now() + interval '15 days'",
  tier: "'api_starter'",
  level_micro: '3000000000',
};

function windowInsert(sql: Sql, accountId: string, over: Record<string, string>): Promise<unknown> {
  const row = { ...GOOD_WINDOW, ...over };
  const cols = Object.keys(row);
  return sql.unsafe(
    `INSERT INTO credit_windows (account_id, ${cols.join(', ')})
     VALUES ('${accountId}', ${cols.map((c) => row[c]).join(', ')})`,
  );
}

const GOOD_CHANGE: Readonly<Record<string, string>> = {
  seq: '1',
  reason: "'plan_change'",
  from_level_micro: '3000000000',
  to_level_micro: '10000000000',
  effective_at: 'now()',
  delta_micro: '4000000000',
};

function changeInsert(windowId: string, over: Record<string, string>): Promise<unknown> {
  const row = { ...GOOD_CHANGE, ...over };
  const cols = Object.keys(row);
  return db().unsafe(
    `INSERT INTO credit_window_level_changes (window_id, ${cols.join(', ')})
     VALUES ('${windowId}', ${cols.map((c) => row[c]).join(', ')})`,
  );
}

const GOOD_CLAWBACK: Readonly<Record<string, string>> = {
  source: "'stripe_refund'",
  target_key: "'window:w1'",
  fraction_ppm: '250000',
  amount_micro: 'NULL',
  state: "'applied'",
  clawed_micro: '750000000',
  pending_micro: '0',
  debt_micro: '0',
};

function clawbackInsert(accountId: string, over: Record<string, string>): Promise<unknown> {
  const row = { ...GOOD_CLAWBACK, ...over };
  const cols = Object.keys(row);
  return db().unsafe(
    `INSERT INTO credit_clawbacks (account_id, source_ref, ${cols.join(', ')})
     VALUES ('${accountId}', 'ch_${randomUUID()}', ${cols.map((c) => row[c]).join(', ')})`,
  );
}

describe.skipIf(!RUN_DB_TESTS)(
  'the database refuses a malformed credit window, level change or clawback',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    describe('credit_windows', () => {
      it('the well-formed window every arm below starts from IS accepted, for each source', async () => {
        for (const source of ['stripe_invoice', 'crypto_entitlement', 'plan_override']) {
          const accountId = await newAccountOn(db());
          await windowInsert(db(), accountId, { source: `'${source}'` });
        }
      });

      const cases: Array<[string, Record<string, string>, string]> = [
        ['an unknown source', { source: "'goodwill'" }, 'credit_windows_source'],
        ['an empty payment reference', { source_ref: "''" }, 'credit_windows_source_ref_length'],
        [
          'a payment reference of 201 characters',
          { source_ref: "repeat('x', 201)" },
          'credit_windows_source_ref_length',
        ],
        [
          'a window that starts before its month',
          { window_start: "now() - interval '11 days'" },
          'credit_windows_order',
        ],
        [
          'a window that ends after its month',
          { window_end: "now() + interval '21 days'" },
          'credit_windows_order',
        ],
        ['an empty window', { window_end: "now() - interval '5 days'" }, 'credit_windows_order'],
        [
          'a window that ends before it starts',
          { window_end: "now() - interval '6 days'" },
          'credit_windows_order',
        ],
        [
          'a window that starts in the future',
          { window_start: "now() + interval '1 day'" },
          'credit_windows_started',
        ],
        ['a negative level', { level_micro: '-1000000' }, 'credit_windows_level'],
        [
          'a level that is not whole credits',
          { level_micro: '3000000001' },
          'credit_windows_level',
        ],
      ];
      for (const [what, over, constraint] of cases) {
        it(`${what} is refused by ${constraint}`, async () => {
          const accountId = await newAccountOn(db());
          const r = await refusal(() => windowInsert(db(), accountId, over), what);
          expect(r.code).toBe('23514');
          expect(r.constraint).toBe(constraint);
        });
      }

      it('a level of zero is a window (that time is covered, at nothing), and a plan that is not a plan is refused by the column’s type', async () => {
        const accountId = await newAccountOn(db());
        await windowInsert(db(), accountId, { level_micro: '0' });
        const other = await newAccountOn(db());
        const r = await refusal(() => windowInsert(db(), other, { tier: "'platinum'" }));
        expect(r.code, 'invalid input value for enum account_tier').toBe('22P02');
      });

      it('a window for an account that does not exist is refused by the foreign key', async () => {
        const r = await refusal(() => windowInsert(db(), randomUUID(), {}));
        expect(r.code).toBe('23503');
      });

      it('the step counter is never negative: reachable only with the guard trigger out of the way, so it is proved with the trigger disabled, in a transaction that is rolled back', async () => {
        const code = await inRolledBackTransaction(db(), async (tx) => {
          const accountId = await newAccountOn(tx);
          await tx.unsafe(
            'ALTER TABLE credit_windows DISABLE TRIGGER credit_windows_guard_trigger',
          );
          await tx.unsafe('SAVEPOINT before_bad_row');
          try {
            await windowInsert(tx, accountId, { level_seq: '-1', created_at: 'now()' });
          } catch (err) {
            const e = err as { code?: string; constraint_name?: string };
            await tx.unsafe('ROLLBACK TO SAVEPOINT before_bad_row');
            return `${e.code ?? '?'} ${e.constraint_name ?? '?'}`;
          }
          return 'accepted';
        });
        expect(code).toBe('23514 credit_windows_level_seq');
      });
    });

    describe('credit_window_level_changes', () => {
      it('the well-formed change every arm below starts from IS accepted, for each reason, and a fall in level carries a negative delta', async () => {
        const accountId = await newAccountOn(db());
        const windowId = await insertWindow(db(), accountId);
        let seq = 1;
        for (const reason of ['plan_change', 'refund', 'dispute', 'dispute_reinstated']) {
          await changeInsert(windowId, { reason: `'${reason}'`, seq: String(seq) });
          seq += 1;
        }
        await changeInsert(windowId, {
          seq: String(seq),
          from_level_micro: '10000000000',
          to_level_micro: '3000000000',
          delta_micro: '-4000000000',
        });
      });

      const cases: Array<[string, Record<string, string>, string]> = [
        [
          'step 0 (a window is BORN at step 0; its first change is 1)',
          { seq: '0' },
          'credit_window_level_changes_seq',
        ],
        ['an unknown reason', { reason: "'goodwill'" }, 'credit_window_level_changes_reason'],
        [
          'a negative level',
          { from_level_micro: '-1000000' },
          'credit_window_level_changes_levels',
        ],
        [
          'a level that is not whole credits',
          { to_level_micro: '10000000001' },
          'credit_window_level_changes_levels',
        ],
        [
          'a change from a level to itself',
          { to_level_micro: '3000000000' },
          'credit_window_level_changes_real',
        ],
        [
          'a delta that is not whole credits',
          { delta_micro: '4000000001' },
          'credit_window_level_changes_whole',
        ],
      ];
      for (const [what, over, constraint] of cases) {
        it(`${what} is refused by ${constraint}`, async () => {
          const accountId = await newAccountOn(db());
          const windowId = await insertWindow(db(), accountId);
          const r = await refusal(() => changeInsert(windowId, over), what);
          expect(r.code).toBe('23514');
          expect(r.constraint).toBe(constraint);
        });
      }

      it('a step is recorded once per window, and only for a window that exists', async () => {
        const accountId = await newAccountOn(db());
        const windowId = await insertWindow(db(), accountId);
        await changeInsert(windowId, {});
        const twice = await refusal(() => changeInsert(windowId, {}));
        expect(twice.code).toBe('23505');
        const nowhere = await refusal(() => changeInsert(randomUUID(), {}));
        expect(nowhere.code).toBe('23503');
      });
    });

    describe('credit_clawbacks', () => {
      it('the well-formed clawback every arm below starts from IS accepted: by share, by amount, for each source, and as an unmatched record kept for review', async () => {
        const accountId = await newAccountOn(db());
        for (const source of [
          'plan_change',
          'stripe_refund',
          'stripe_dispute',
          'crypto_refund',
          'admin',
        ]) {
          await clawbackInsert(accountId, { source: `'${source}'` });
        }
        await clawbackInsert(accountId, { fraction_ppm: 'NULL', amount_micro: '5000000' });
        await clawbackInsert(accountId, { fraction_ppm: '1000000' });
        await clawbackInsert(accountId, {
          state: "'unmatched'",
          target_key: "'unmatched'",
          clawed_micro: 'NULL',
          debt_micro: 'NULL',
        });
      });

      const cases: Array<[string, Record<string, string>, string]> = [
        ['an unknown source', { source: "'goodwill'" }, 'credit_clawbacks_source'],
        // With no amounts, so that the two shape rules have nothing to say about it.
        [
          'an unknown state',
          { state: "'pending'", clawed_micro: 'NULL', debt_micro: 'NULL' },
          'credit_clawbacks_state',
        ],
        ['both a share and an amount', { amount_micro: '5000000' }, 'credit_clawbacks_one_measure'],
        ['neither a share nor an amount', { fraction_ppm: 'NULL' }, 'credit_clawbacks_one_measure'],
        ['a share of zero', { fraction_ppm: '0' }, 'credit_clawbacks_fraction'],
        ['a share above the whole', { fraction_ppm: '1000001' }, 'credit_clawbacks_fraction'],
        [
          'an amount of zero',
          { fraction_ppm: 'NULL', amount_micro: '0' },
          'credit_clawbacks_amount',
        ],
        ['a negative pending claim', { pending_micro: '-1' }, 'credit_clawbacks_pending'],
        [
          'applied, with nothing recorded as taken',
          { clawed_micro: 'NULL' },
          'credit_clawbacks_applied_shape',
        ],
        ['applied, with no debt figure', { debt_micro: 'NULL' }, 'credit_clawbacks_applied_shape'],
        [
          'applied, against the target that means "no target"',
          { target_key: "'unmatched'" },
          'credit_clawbacks_applied_shape',
        ],
        // The applied-shape rule alone ACCEPTS this row (its target says 'unmatched',
        // which is all that rule asks of a record that is not applied). Measured: it
        // was accepted until the rule below it was written.
        [
          'unmatched, yet with credits recorded as taken',
          { state: "'unmatched'", target_key: "'unmatched'" },
          'credit_clawbacks_unmatched_shape',
        ],
        [
          'unmatched, yet with a debt figure',
          { state: "'unmatched'", target_key: "'unmatched'", clawed_micro: 'NULL' },
          'credit_clawbacks_unmatched_shape',
        ],
        [
          'unmatched, yet with a pending claim',
          {
            state: "'unmatched'",
            target_key: "'unmatched'",
            clawed_micro: 'NULL',
            debt_micro: 'NULL',
            pending_micro: '1',
          },
          'credit_clawbacks_unmatched_shape',
        ],
      ];
      for (const [what, over, constraint] of cases) {
        it(`${what} is refused by ${constraint}`, async () => {
          const accountId = await newAccountOn(db());
          const r = await refusal(() => clawbackInsert(accountId, over), what);
          expect(r.code).toBe('23514');
          expect(r.constraint).toBe(constraint);
        });
      }
    });
  },
);
