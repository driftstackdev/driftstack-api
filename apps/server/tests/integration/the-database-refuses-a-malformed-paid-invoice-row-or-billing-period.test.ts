// The database refuses a malformed paid-invoice row, and a malformed billing
// period on the subscription mirror — each by its own CHECK, proven with raw SQL.
//
// `billing_invoice_payments` (migration 0129) is what AI credits will be granted
// from, so its shape is held by the database and not only by the one writer that
// exists today. Every refusal below is asserted by SQLSTATE AND constraint name,
// beside an ACCEPTED neighbour that differs in one value: a row refused by a
// different rule than the one under test proves nothing about that rule.
//
// Where one bad value unavoidably breaks two rules, the name asserted is the one
// Postgres reports — it checks a table's constraints in name order — and the arm
// says so.
//
// Every arm runs in a rolled-back transaction, so no row outlives it.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inRolledBackTransaction, refusal } from './_helpers/database-refusal.js';
import { newAccount, openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_paid_invoice_checks';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

let client: postgres.Sql | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const opened = await openLedgerDatabase(ISOLATED_DB_NAME);
  client = opened?.sql ?? null;
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

type Tx = postgres.TransactionSql;
type Value = string | number | null;

function literal(v: Value): string {
  if (v === null) return 'NULL';
  return typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`;
}

function insertSql(table: string, row: Record<string, Value>): string {
  const names = Object.keys(row);
  return `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map((n) => literal(row[n] ?? null)).join(', ')})`;
}

/** A well-formed paid-invoice row for `accountId`: a monthly line, fully named. */
function payment(accountId: string, overrides: Record<string, Value> = {}): string {
  return insertSql('billing_invoice_payments', {
    stripe_invoice_id: `in_${randomUUID()}`,
    account_id: accountId,
    stripe_subscription_id: 'sub_1',
    billing_reason: 'subscription_cycle',
    amount_paid_minor: 14900,
    currency: 'usd',
    line_kind: 'period',
    line_stripe_price_id: 'price_starter_m',
    line_tier: 'api_starter',
    line_interval: 'month',
    line_period_start: '2026-03-01T00:00:00Z',
    line_period_end: '2026-04-01T00:00:00Z',
    paid_at: '2026-03-01T01:00:00Z',
    ...overrides,
  });
}

/** The columns that say "this invoice was tied to no line". */
const NO_LINE = {
  line_kind: null,
  line_stripe_price_id: null,
  line_tier: null,
  line_interval: null,
  line_period_start: null,
  line_period_end: null,
} as const;

function subscription(accountId: string, overrides: Record<string, Value> = {}): string {
  return insertSql('subscriptions', {
    account_id: accountId,
    stripe_subscription_id: `sub_${randomUUID()}`,
    stripe_price_id: 'price_starter_m',
    tier: 'api_starter',
    status: 'active',
    current_period_end: '2026-04-01T00:00:00Z',
    ...overrides,
  });
}

async function refusedBy(tx: Tx, statement: string, constraint: string): Promise<void> {
  const refused = await refusal(() => tx.savepoint((sp) => sp.unsafe(statement)), statement);
  expect(
    { code: refused.code, constraint: refused.constraint },
    `${statement}\n  → ${refused.message}`,
  ).toEqual({ code: '23514', constraint });
}

async function accepted(tx: Tx, statement: string): Promise<void> {
  await tx.savepoint((sp) => sp.unsafe(statement));
}

describe.skipIf(!RUN_DB_TESTS)(
  'the database refuses a malformed paid-invoice row or billing period',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it('CRITICAL amounts: what was paid is never negative, and refunded and disputed each stay between 0 and what was paid', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const a = await newAccount(tx);
        const amounts = 'billing_invoice_payments_amounts';
        await refusedBy(tx, payment(a, { amount_paid_minor: -1 }), amounts);
        await refusedBy(tx, payment(a, { refunded_minor: -1 }), amounts);
        await refusedBy(tx, payment(a, { refunded_minor: 14901 }), amounts);
        await refusedBy(tx, payment(a, { disputed_minor: -1 }), amounts);
        await refusedBy(tx, payment(a, { disputed_minor: 14901 }), amounts);
        // A $0 invoice cannot carry a refund: there is nothing to refund.
        await refusedBy(tx, payment(a, { amount_paid_minor: 0, refunded_minor: 1 }), amounts);
        // The neighbours: a $0 invoice, and one refunded AND disputed in full.
        await accepted(tx, payment(a, { amount_paid_minor: 0 }));
        await accepted(tx, payment(a, { refunded_minor: 14900, disputed_minor: 14900 }));
      });
    });

    it('CRITICAL an UPDATE is held to the same amounts: a refund written later cannot exceed what was paid', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const a = await newAccount(tx);
        await accepted(tx, payment(a, { stripe_invoice_id: 'in_refund_later' }));
        const set = (sql: string): string =>
          `UPDATE billing_invoice_payments SET ${sql} WHERE stripe_invoice_id = 'in_refund_later'`;
        await refusedBy(tx, set('refunded_minor = 14901'), 'billing_invoice_payments_amounts');
        await refusedBy(
          tx,
          set('amount_paid_minor = 100, refunded_minor = 101'),
          'billing_invoice_payments_amounts',
        );
        await accepted(tx, set('refunded_minor = 14900'));
        // And then what was paid cannot be lowered beneath the refund.
        await refusedBy(tx, set('amount_paid_minor = 14899'), 'billing_invoice_payments_amounts');
      });
    });

    it('the line kind is one of the two the code knows, or none', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const a = await newAccount(tx);
        await refusedBy(
          tx,
          payment(a, { line_kind: 'renewal' }),
          'billing_invoice_payments_line_kind',
        );
        await refusedBy(tx, payment(a, { line_kind: '' }), 'billing_invoice_payments_line_kind');
        await accepted(tx, payment(a, { line_kind: 'period' }));
        await accepted(tx, payment(a, { line_kind: 'proration_up' }));
      });
    });

    it('CRITICAL line shape: a row that names NO line names none of it — a plan or a period without a kind is refused', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const a = await newAccount(tx);
        const shape = 'billing_invoice_payments_line_shape';
        await refusedBy(tx, payment(a, { ...NO_LINE, line_tier: 'api_starter' }), shape);
        await refusedBy(
          tx,
          payment(a, {
            ...NO_LINE,
            line_period_start: '2026-03-01T00:00:00Z',
            line_period_end: '2026-04-01T00:00:00Z',
          }),
          shape,
        );
        await refusedBy(
          tx,
          payment(a, { ...NO_LINE, line_period_start: '2026-03-01T00:00:00Z' }),
          shape,
        );
        // The neighbour: the invoice that could not be tied to a line at all.
        await accepted(tx, payment(a, { ...NO_LINE }));
      });
    });

    it('CRITICAL a named line always has its whole period. A kind with half a period, or none, is refused — and it is THIS constraint that refuses it', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const a = await newAccount(tx);
        const known = 'billing_invoice_payments_line_period_known';
        const halves: Array<Record<string, Value>> = [
          { line_period_end: null },
          { line_period_start: null },
          { line_period_start: null, line_period_end: null },
        ];
        for (const half of halves) await refusedBy(tx, payment(a, half), known);
        // A kind with nothing else at all breaks the shape rule too; Postgres
        // checks constraints in name order and "line_period_known" sorts first.
        await refusedBy(tx, payment(a, { ...NO_LINE, line_kind: 'period' }), known);

        // SENSITIVITY. Without this constraint the first two halves are ACCEPTED:
        // the shape rule is satisfied by any one of the three being present, and
        // `end > start` is NULL — not false — when either side is NULL. So the
        // refusals above are this constraint's and nobody else's.
        await tx.unsafe(
          'ALTER TABLE billing_invoice_payments DROP CONSTRAINT billing_invoice_payments_line_period_known',
        );
        await accepted(tx, payment(a, { line_period_end: null }));
        await accepted(tx, payment(a, { line_period_start: null }));
      });
    });

    it('a line’s period ends after it starts', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const a = await newAccount(tx);
        const period = 'billing_invoice_payments_period';
        await refusedBy(tx, payment(a, { line_period_end: '2026-03-01T00:00:00Z' }), period);
        await refusedBy(tx, payment(a, { line_period_end: '2026-02-28T23:59:59Z' }), period);
        await accepted(tx, payment(a, { line_period_end: '2026-03-01T00:00:01Z' }));
      });
    });

    it('the interval is month, year or unknown — on the paid-invoice line and on the subscription mirror alike', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const a = await newAccount(tx);
        for (const bad of ['week', 'monthly', 'Month', '']) {
          await refusedBy(
            tx,
            payment(a, { line_interval: bad }),
            'billing_invoice_payments_line_interval',
          );
          await refusedBy(
            tx,
            subscription(a, { billing_interval: bad }),
            'subscriptions_billing_interval',
          );
        }
        for (const ok of ['month', 'year', null]) {
          await accepted(tx, payment(a, { line_interval: ok }));
          await accepted(tx, subscription(a, { billing_interval: ok }));
        }
      });
    });

    it('a price the configuration does not name is recorded with its line and period, and no plan', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const a = await newAccount(tx);
        await accepted(
          tx,
          payment(a, {
            line_stripe_price_id: 'price_custom_contract',
            line_tier: null,
            line_interval: null,
          }),
        );
        // The plan is the account_tier enum: a plan that does not exist is not text.
        const bad = await refusal(() =>
          tx.savepoint((sp) => sp.unsafe(payment(a, { line_tier: 'platinum' }))),
        );
        expect(bad.code).toBe('22P02');
      });
    });

    it('CRITICAL one row per invoice: the invoice id is the primary key, so a second row for the same invoice is refused whoever writes it', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const a = await newAccount(tx);
        const b = await newAccount(tx);
        await accepted(tx, payment(a, { stripe_invoice_id: 'in_once' }));
        for (const account of [a, b]) {
          const again = await refusal(() =>
            tx.savepoint((sp) => sp.unsafe(payment(account, { stripe_invoice_id: 'in_once' }))),
          );
          expect({ code: again.code, constraint: again.constraint }).toEqual({
            code: '23505',
            constraint: 'billing_invoice_payments_pkey',
          });
        }
      });
    });

    it('a payment belongs to an account that exists, needs its amount, currency and paid time, and leaves with its account', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const a = await newAccount(tx);
        const orphan = await refusal(() => tx.savepoint((sp) => sp.unsafe(payment(randomUUID()))));
        expect({ code: orphan.code, constraint: orphan.constraint }).toEqual({
          code: '23503',
          constraint: 'billing_invoice_payments_account_id_fkey',
        });
        for (const column of ['account_id', 'amount_paid_minor', 'currency', 'paid_at']) {
          const missing = await refusal(() =>
            tx.savepoint((sp) => sp.unsafe(payment(a, { [column]: null }))),
          );
          expect(missing.code, column).toBe('23502');
        }

        await accepted(tx, payment(a, { stripe_invoice_id: 'in_defaults' }));
        const [row] = await tx<
          Array<{ refunded: string; disputed: string; created: boolean }>
        >`SELECT refunded_minor::text AS refunded, disputed_minor::text AS disputed,
                 created_at IS NOT NULL AS created
            FROM billing_invoice_payments WHERE stripe_invoice_id = 'in_defaults'`;
        expect(row).toEqual({ refunded: '0', disputed: '0', created: true });

        await tx`DELETE FROM accounts WHERE id = ${a}::uuid`;
        const [left] = await tx<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM billing_invoice_payments WHERE account_id = ${a}::uuid`;
        expect(left?.n).toBe(0);
      });
    });

    it('CRITICAL the subscription mirror: a period starts before it ends when both are known, and the start’s source is stripe, derived or unknown', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const a = await newAccount(tx);
        const order = 'subscriptions_period_order';
        await refusedBy(
          tx,
          subscription(a, { current_period_start: '2026-04-01T00:00:00Z' }),
          order,
        );
        await refusedBy(
          tx,
          subscription(a, { current_period_start: '2026-04-02T00:00:00Z' }),
          order,
        );
        await accepted(tx, subscription(a, { current_period_start: '2026-03-01T00:00:00Z' }));
        // Either side unknown is not a contradiction.
        await accepted(tx, subscription(a, { current_period_start: null }));
        await accepted(
          tx,
          subscription(a, {
            current_period_start: '2030-01-01T00:00:00Z',
            current_period_end: null,
          }),
        );

        const source = 'subscriptions_period_start_source';
        await refusedBy(tx, subscription(a, { period_start_source: 'guess' }), source);
        await refusedBy(tx, subscription(a, { period_start_source: 'Stripe' }), source);
        for (const ok of ['stripe', 'derived', null]) {
          await accepted(tx, subscription(a, { period_start_source: ok }));
        }
      });
    });

    it('a mirror row written the way it was before this migration still inserts, with the four new columns unknown', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const a = await newAccount(tx);
        await accepted(tx, subscription(a, { stripe_subscription_id: 'sub_legacy_shape' }));
        const [row] = await tx<
          Array<{
            start: Date | null;
            interval: string | null;
            source: string | null;
            since: Date | null;
          }>
        >`SELECT current_period_start AS start, billing_interval AS interval,
                 period_start_source AS source, tier_since AS since
            FROM subscriptions WHERE stripe_subscription_id = 'sub_legacy_shape'`;
        expect(row).toEqual({ start: null, interval: null, source: null, since: null });
      });
    });

    it('CRITICAL each refusal is THAT constraint’s alone: with the one constraint dropped, the very same row is accepted. A refusal that survived its constraint being dropped would mean some other rule was doing the refusing, and the arms above would be naming the wrong guarantee.', async () => {
      const cases: Array<{
        table: 'billing_invoice_payments' | 'subscriptions';
        constraint: string;
        row: (accountId: string) => string;
      }> = [
        {
          table: 'billing_invoice_payments',
          constraint: 'billing_invoice_payments_amounts',
          row: (a) => payment(a, { refunded_minor: 14901 }),
        },
        {
          table: 'billing_invoice_payments',
          constraint: 'billing_invoice_payments_line_kind',
          row: (a) => payment(a, { line_kind: 'renewal' }),
        },
        {
          table: 'billing_invoice_payments',
          constraint: 'billing_invoice_payments_line_shape',
          row: (a) => payment(a, { ...NO_LINE, line_tier: 'api_starter' }),
        },
        {
          table: 'billing_invoice_payments',
          constraint: 'billing_invoice_payments_line_interval',
          row: (a) => payment(a, { line_interval: 'week' }),
        },
        {
          table: 'billing_invoice_payments',
          constraint: 'billing_invoice_payments_period',
          row: (a) => payment(a, { line_period_end: '2026-02-01T00:00:00Z' }),
        },
        {
          table: 'subscriptions',
          constraint: 'subscriptions_billing_interval',
          row: (a) => subscription(a, { billing_interval: 'week' }),
        },
        {
          table: 'subscriptions',
          constraint: 'subscriptions_period_start_source',
          row: (a) => subscription(a, { period_start_source: 'guess' }),
        },
        {
          table: 'subscriptions',
          constraint: 'subscriptions_period_order',
          row: (a) => subscription(a, { current_period_start: '2026-05-01T00:00:00Z' }),
        },
      ];
      for (const c of cases) {
        await inRolledBackTransaction(db(), async (tx) => {
          const a = await newAccount(tx);
          const statement = c.row(a);
          await refusedBy(tx, statement, c.constraint);
          await tx.unsafe(`ALTER TABLE ${c.table} DROP CONSTRAINT ${c.constraint}`);
          await accepted(tx, statement);
        });
      }
      // The rolled-back DROPs left every constraint in place.
      const [left] = await db()<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_constraint
         WHERE contype = 'c'
           AND conrelid IN ('billing_invoice_payments'::regclass, 'subscriptions'::regclass)`;
      expect(left?.n).toBe(9);
    });

    it('the three indexes exist with the predicates the readers will rely on', async () => {
      const rows = await db()<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef FROM pg_indexes
         WHERE tablename = 'billing_invoice_payments' ORDER BY indexname`;
      const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
      expect([...byName.keys()]).toEqual([
        'billing_invoice_payments_charge_idx',
        'billing_invoice_payments_coverage_idx',
        'billing_invoice_payments_pi_idx',
        'billing_invoice_payments_pkey',
      ]);
      expect(byName.get('billing_invoice_payments_coverage_idx')).toContain(
        '(account_id, line_period_start, line_period_end) WHERE (line_kind IS NOT NULL)',
      );
      expect(byName.get('billing_invoice_payments_pi_idx')).toContain(
        '(stripe_payment_intent_id) WHERE (stripe_payment_intent_id IS NOT NULL)',
      );
      expect(byName.get('billing_invoice_payments_charge_idx')).toContain(
        '(stripe_charge_id) WHERE (stripe_charge_id IS NOT NULL)',
      );
    });
  },
);
