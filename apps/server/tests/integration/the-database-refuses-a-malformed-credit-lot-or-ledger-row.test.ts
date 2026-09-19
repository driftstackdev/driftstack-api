// The database refuses a malformed credit lot, ledger row, credit account or
// plan override — each by its own CHECK, proven with raw SQL.
//
// Every refusal is asserted by SQLSTATE (23514) AND constraint name, and every
// invalid row breaks exactly one rule, beside an accepted neighbour: a row
// refused by a different rule than the one under test proves nothing about that
// rule. Where a bad value unavoidably breaks two rules (an unknown kind is also
// in no branch of the shape CHECK), the name asserted is the one Postgres
// reports first; it checks a table's constraints in name order.
//
// Among them: a grant must add credit, an expiry or a charge must remove it,
// debt is incurred only with a reason, a task charge must name its reservation,
// rate card and model (the reservations table does not exist yet, so a charge
// cannot be written without them), and bought credits last at most 12 months
// and a day — counted in UTC, so the verdict does not depend on the session's
// time zone. The last is proven by a case where the time zones DISAGREE, and
// that the case discriminates is shown first.
//
// Every arm runs in a rolled-back transaction, so no row outlives it.

import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inRolledBackTransaction, refusal } from './_helpers/database-refusal.js';
import {
  MICRO,
  insertLot,
  newAccount,
  newCreditAccount,
  openLedgerDatabase,
} from './_helpers/credit-ledger-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_ledger_shapes';
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

/** `statement` is refused by `constraint` alone, as a CHECK violation. */
async function refusedBy(tx: Tx, statement: string, constraint: string): Promise<void> {
  const refused = await refusal(() => tx.savepoint((sp) => sp.unsafe(statement)), statement);
  expect(
    { code: refused.code, constraint: refused.constraint },
    `${statement}\n  → ${refused.message}`,
  ).toEqual({ code: '23514', constraint });
}

/** `statement` is accepted: the neighbour that makes a refusal mean something. */
async function accepted(tx: Tx, statement: string): Promise<void> {
  await tx.savepoint((sp) => sp.unsafe(statement));
}

/** An account with a credit row and a goodwill lot granted 100, holding 50. */
async function ledgerFixture(tx: Tx): Promise<{ a: string; lot: string }> {
  const a = await newCreditAccount(tx);
  const lot = await insertLot(tx, a, { credits: 100 });
  await tx`
    INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
    VALUES (${a}::uuid, 'grant', ${lot}::uuid, ${50 * MICRO}, 'half')`;
  return { a, lot };
}

/**
 * An empty lot of one credit for `a`. A lot is funded once, so an ACCEPTED
 * grant neighbour needs a lot of its own; the refused rows can keep naming the
 * funded one, since a CHECK refuses them before the apply trigger runs.
 */
async function unfundedLot(tx: Tx, a: string): Promise<string> {
  return insertLot(tx, a, { credits: 1 });
}

let seq = 0;
/** A ledger INSERT with a fresh idempotency key. */
function ledgerRow(columns: Record<string, string | number | null>): string {
  seq += 1;
  const all = { idempotency_key: `k${String(seq)}`, ...columns };
  const names = Object.keys(all);
  const values = Object.values(all).map((v) =>
    v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`,
  );
  return `INSERT INTO credit_ledger (${names.join(', ')}) VALUES (${values.join(', ')})`;
}

describe.skipIf(!RUN_DB_TESTS)(
  'the database refuses a malformed credit lot, ledger row, credit account or plan override',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it('CRITICAL a grant must add credit to a lot, and an expiry must take it away', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const { a, lot } = await ledgerFixture(tx);
        const shape = 'credit_ledger_shape';
        await refusedBy(
          tx,
          ledgerRow({ account_id: a, kind: 'grant', lot_id: lot, lot_delta_micro: -MICRO }),
          shape,
        );
        await refusedBy(
          tx,
          ledgerRow({ account_id: a, kind: 'grant', lot_id: null, lot_delta_micro: 0 }),
          shape,
        );
        await accepted(
          tx,
          ledgerRow({
            account_id: a,
            kind: 'grant',
            lot_id: await unfundedLot(tx, a),
            lot_delta_micro: MICRO,
          }),
        );
        await refusedBy(
          tx,
          ledgerRow({ account_id: a, kind: 'expiry', lot_id: lot, lot_delta_micro: MICRO }),
          shape,
        );
        await accepted(
          tx,
          ledgerRow({ account_id: a, kind: 'expiry', lot_id: lot, lot_delta_micro: -MICRO }),
        );
        // A lot delta needs a lot, and a lot needs a delta.
        await refusedBy(
          tx,
          ledgerRow({ account_id: a, kind: 'grant', lot_id: null, lot_delta_micro: MICRO }),
          'credit_ledger_lot_presence',
        );
      });
    });

    it('CRITICAL debt is incurred only upward, only with a reason, and repaid only from a lot by the same amount', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const { a, lot } = await ledgerFixture(tx);
        await refusedBy(
          tx,
          ledgerRow({ account_id: a, kind: 'debt_incurred', debt_delta_micro: -MICRO }),
          'credit_ledger_shape',
        );
        await refusedBy(
          tx,
          ledgerRow({ account_id: a, kind: 'debt_incurred', debt_delta_micro: MICRO }),
          'credit_ledger_debt_reason',
        );
        await refusedBy(
          tx,
          ledgerRow({
            account_id: a,
            kind: 'debt_incurred',
            debt_delta_micro: MICRO,
            reason: 'fraud',
          }),
          'credit_ledger_debt_reason',
        );
        // Accepted as a statement; the rolled-back transaction never reaches
        // the COMMIT-time check that debt cannot sit beside free credit.
        await accepted(
          tx,
          ledgerRow({
            account_id: a,
            kind: 'debt_incurred',
            debt_delta_micro: 5 * MICRO,
            reason: 'payment_reversed',
          }),
        );
        await refusedBy(
          tx,
          ledgerRow({
            account_id: a,
            kind: 'debt_repayment',
            lot_id: lot,
            lot_delta_micro: -2 * MICRO,
            debt_delta_micro: -MICRO,
          }),
          'credit_ledger_shape',
        );
        await accepted(
          tx,
          ledgerRow({
            account_id: a,
            kind: 'debt_repayment',
            lot_id: lot,
            lot_delta_micro: -MICRO,
            debt_delta_micro: -MICRO,
          }),
        );
      });
    });

    it('CRITICAL an adjustment moves a lot or forgives debt — exactly one of the two, and never raises debt', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const { a, lot } = await ledgerFixture(tx);
        await accepted(
          tx,
          ledgerRow({
            account_id: a,
            kind: 'debt_incurred',
            debt_delta_micro: 5 * MICRO,
            reason: 'plan_change',
          }),
        );
        const shape = 'credit_ledger_shape';
        await refusedBy(
          tx,
          ledgerRow({
            account_id: a,
            kind: 'adjustment',
            lot_id: lot,
            lot_delta_micro: -MICRO,
            debt_delta_micro: -MICRO,
          }),
          shape,
        );
        await refusedBy(
          tx,
          ledgerRow({ account_id: a, kind: 'adjustment', lot_id: null, lot_delta_micro: 0 }),
          shape,
        );
        await refusedBy(
          tx,
          ledgerRow({
            account_id: a,
            kind: 'adjustment',
            debt_delta_micro: MICRO,
            reason: 'plan_change',
          }),
          shape,
        );
        await accepted(
          tx,
          ledgerRow({ account_id: a, kind: 'adjustment', lot_id: lot, lot_delta_micro: MICRO }),
        );
        await accepted(
          tx,
          ledgerRow({ account_id: a, kind: 'adjustment', lot_id: lot, lot_delta_micro: -MICRO }),
        );
        await accepted(
          tx,
          ledgerRow({ account_id: a, kind: 'adjustment', debt_delta_micro: -MICRO }),
        );
      });
    });

    it('CRITICAL a task charge must name its reservation, rate card and model — without all three it cannot be written, whichever is missing', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const { a, lot } = await ledgerFixture(tx);
        const full = {
          account_id: a,
          kind: 'task_charge',
          lot_id: lot,
          lot_delta_micro: -MICRO,
          reservation_id: '00000000-0000-4000-8000-000000000001',
          rate_card_version: 1,
          model: 'claude-sonnet-5',
        };
        for (const missing of ['reservation_id', 'rate_card_version', 'model'] as const) {
          await refusedBy(
            tx,
            ledgerRow({ ...full, [missing]: null }),
            'credit_ledger_task_charge_context',
          );
        }
        // With all three present this CHECK is satisfied. Once the reservations
        // table exists, its foreign key refuses a reservation that does not —
        // a different rule, which is all this arm allows.
        const withAll = await tx
          .savepoint((sp) => sp.unsafe(ledgerRow(full)))
          .then(
            () => 'accepted',
            (err: unknown) => {
              const e = err as { code?: string; constraint_name?: string };
              return `${String(e.code)} ${String(e.constraint_name)}`;
            },
          );
        expect(
          withAll === 'accepted' ||
            /^23503 credit_ledger_\w+_fkey$|^23503 credit_ledger_reservation_fk$/.test(withAll),
          `the complete task charge: ${withAll} — only a foreign key may refuse it`,
        ).toBe(true);
      });
    });

    it('CRITICAL an unknown ledger kind or actor is refused, and an idempotency key is 1 to 200 characters — counted as characters, not bytes', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const { a, lot } = await ledgerFixture(tx);
        const grant = { account_id: a, kind: 'grant', lot_id: lot, lot_delta_micro: MICRO };
        await refusedBy(tx, ledgerRow({ ...grant, kind: 'bonus' }), 'credit_ledger_kind');
        await refusedBy(tx, ledgerRow({ ...grant, actor: 'robot' }), 'credit_ledger_actor');
        for (const actor of ['system', 'customer', 'admin', 'stripe', 'crypto']) {
          await accepted(tx, ledgerRow({ ...grant, lot_id: await unfundedLot(tx, a), actor }));
        }
        const key = 'credit_ledger_idempotency_key_length';
        await refusedBy(tx, ledgerRow({ ...grant, idempotency_key: '' }), key);
        await refusedBy(tx, ledgerRow({ ...grant, idempotency_key: 'k'.repeat(201) }), key);
        await accepted(
          tx,
          ledgerRow({
            ...grant,
            lot_id: await unfundedLot(tx, a),
            idempotency_key: 'k'.repeat(200),
          }),
        );
        // 200 three-byte characters: 600 bytes, and still 200 characters.
        await accepted(
          tx,
          ledgerRow({
            ...grant,
            lot_id: await unfundedLot(tx, a),
            idempotency_key: '€'.repeat(200),
          }),
        );
      });
    });

    it('CRITICAL a lot has a known kind, the spend rank of its kind, and a month window exactly when it holds included credits', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const a = await newAccount(tx);
        const lot = (kind: string, rank: number, windowId: string | null): string =>
          `INSERT INTO credit_lots (account_id, kind, spend_rank, window_id, grant_key, granted_micro, starts_at, expires_at)
           VALUES ('${a}', '${kind}', ${String(rank)}, ${windowId === null ? 'NULL' : `'${windowId}'`},
                   'lot:${String((seq += 1))}', ${String(MICRO)}, now(), now() + interval '1 day')`;
        const someWindow = '00000000-0000-4000-8000-0000000000aa';
        await refusedBy(tx, lot('bonus', 1, null), 'credit_lots_kind');
        await refusedBy(tx, lot('adjustment', 2, null), 'credit_lots_rank_matches_kind');
        await refusedBy(tx, lot('top_up', 1, null), 'credit_lots_rank_matches_kind');
        await refusedBy(tx, lot('monthly', 0, null), 'credit_lots_window_iff_included');
        await refusedBy(tx, lot('proration', 0, null), 'credit_lots_window_iff_included');
        await refusedBy(tx, lot('adjustment', 1, someWindow), 'credit_lots_window_iff_included');
        await refusedBy(tx, lot('top_up', 2, someWindow), 'credit_lots_window_iff_included');
        await accepted(tx, lot('adjustment', 1, null));
        await accepted(tx, lot('top_up', 2, null));
      });
    });

    it('CRITICAL a lot grants whole credits, more than none, over a term that ends after it starts', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const a = await newAccount(tx);
        const lot = (granted: number, starts: string, expires: string): string =>
          `INSERT INTO credit_lots (account_id, kind, spend_rank, grant_key, granted_micro, starts_at, expires_at)
           VALUES ('${a}', 'adjustment', 1, 'term:${String((seq += 1))}', ${String(granted)}, ${starts}, ${expires})`;
        const day = "now() + interval '1 day'";
        for (const granted of [0, -MICRO, 1_500_000, 1]) {
          await refusedBy(tx, lot(granted, 'now()', day), 'credit_lots_granted_whole_credits');
        }
        await accepted(tx, lot(MICRO, 'now()', day));
        await accepted(tx, lot(10_000_000 * MICRO, 'now()', day));
        await refusedBy(tx, lot(MICRO, 'now()', 'now()'), 'credit_lots_term');
        await refusedBy(tx, lot(MICRO, day, 'now()'), 'credit_lots_term');
      });
    });

    it('CRITICAL bought credits last at most 12 months and a day: the bound is accepted, one microsecond past it is not, and the rule is for top-ups only', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const a = await newAccount(tx);
        const lot = (kind: string, rank: number, starts: string, expires: string): string =>
          `INSERT INTO credit_lots (account_id, kind, spend_rank, grant_key, granted_micro, starts_at, expires_at)
           VALUES ('${a}', '${kind}', ${String(rank)}, 'twelve:${String((seq += 1))}', ${String(MICRO)},
                   '${starts}', '${expires}')`;
        await accepted(tx, lot('top_up', 2, '2026-01-15T10:00:00Z', '2027-01-16T10:00:00Z'));
        await refusedBy(
          tx,
          lot('top_up', 2, '2026-01-15T10:00:00Z', '2027-01-16T10:00:00.000001Z'),
          'credit_lots_top_up_twelve_months',
        );
        await accepted(tx, lot('adjustment', 1, '2026-01-15T10:00:00Z', '2028-01-15T10:00:00Z'));
      });
    });

    it("CRITICAL the 12-month bound does not depend on the session's time zone — proven on a start where local and UTC calendars disagree", async () => {
      // 2027-03-01 03:00 UTC is 2027-02-28 in New York, and 2028 is a leap
      // year: counted in New York, "12 months and a day" ends on 2028-02-29
      // local (2028-03-01 03:00 UTC); counted in UTC it ends on 2028-03-02.
      const starts = '2027-03-01T03:00:00Z';
      const utcBound = '2028-03-02T03:00:00Z';
      const naive = async (zone: string): Promise<string> =>
        inRolledBackTransaction(db(), async (tx) => {
          await tx.unsafe(`SET LOCAL TIME ZONE '${zone}'`);
          const [row] = await tx<Array<{ bound: Date }>>`
            SELECT ${starts}::timestamptz + interval '12 months 1 day' AS bound`;
          return (row?.bound ?? new Date(0)).toISOString();
        });
      // The instrument discriminates: the naive sum really does differ by zone.
      expect(await naive('UTC')).toBe('2028-03-02T03:00:00.000Z');
      expect(await naive('America/New_York')).toBe('2028-03-01T03:00:00.000Z');

      for (const zone of ['UTC', 'America/New_York', 'Pacific/Kiritimati', 'America/Adak']) {
        await inRolledBackTransaction(db(), async (tx) => {
          await tx.unsafe(`SET LOCAL TIME ZONE '${zone}'`);
          const a = await newAccount(tx);
          const lot = (expires: string): string =>
            `INSERT INTO credit_lots (account_id, kind, spend_rank, grant_key, granted_micro, starts_at, expires_at)
             VALUES ('${a}', 'top_up', 2, 'zone:${String((seq += 1))}', ${String(MICRO)}, '${starts}', '${expires}')`;
          await accepted(tx, lot(utcBound));
          await refusedBy(
            tx,
            lot('2028-03-02T03:00:00.000001Z'),
            'credit_lots_top_up_twelve_months',
          );
        });
      }
    });

    it('CRITICAL a credit account has a known billing mode and AI source, records who chose the source together with when, and snapshots the legacy settings when it moves', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const row = async (columns: string, values: string): Promise<string> => {
          const a = await newAccount(tx);
          return `INSERT INTO credit_accounts (account_id${columns}) VALUES ('${a}'${values})`;
        };
        await refusedBy(
          tx,
          await row(', billing_mode', ", 'trial'"),
          'credit_accounts_billing_mode',
        );
        await accepted(tx, await row(', billing_mode', ", 'credits'"));
        await refusedBy(tx, await row(', ai_source', ", 'automatic'"), 'credit_accounts_ai_source');
        await accepted(tx, await row(', ai_source', ', NULL'));
        await accepted(tx, await row(', ai_source', ", 'own_key'"));
        const setBy = 'credit_accounts_ai_source_set_by';
        await refusedBy(tx, await row(', ai_source_set_by', ", 'customer'"), setBy);
        await refusedBy(tx, await row(', ai_source_set_at', ', now()'), setBy);
        await refusedBy(
          tx,
          await row(', ai_source_set_by, ai_source_set_at', ", 'robot', now()"),
          setBy,
        );
        await accepted(tx, await row(', ai_source_set_by, ai_source_set_at', ", 'cutover', now()"));
        await refusedBy(
          tx,
          await row(', moved_to_credits_at, legacy_consent_at_move', ', now(), true'),
          'credit_accounts_move_snapshot',
        );
        await accepted(
          tx,
          await row(
            ', moved_to_credits_at, legacy_consent_at_move, legacy_cap_cents_at_move, had_stored_key_at_move',
            ', now(), true, 1000, false',
          ),
        );
      });
    });

    it('CRITICAL a plan override grants 0 to 10,000,000 credits a month, for a contract or an admin-set tier only, ending after it starts', async () => {
      await inRolledBackTransaction(db(), async (tx) => {
        const row = async (credits: number, reason: string, ends = 'NULL'): Promise<string> => {
          const a = await newAccount(tx);
          return `INSERT INTO credit_plan_overrides (account_id, monthly_credits, anchor_at, ends_at, reason)
                  VALUES ('${a}', ${String(credits)}, '2026-09-01T00:00:00Z', ${ends}, '${reason}')`;
        };
        const range = 'credit_plan_overrides_credits_range';
        await refusedBy(tx, await row(-1, 'contract'), range);
        await refusedBy(tx, await row(10_000_001, 'contract'), range);
        await accepted(tx, await row(0, 'contract'));
        await accepted(tx, await row(10_000_000, 'admin_tier'));
        await refusedBy(tx, await row(30_000, 'no_paid_period'), 'credit_plan_overrides_reason');
        const ends = 'credit_plan_overrides_ends_after_anchor';
        await refusedBy(tx, await row(30_000, 'contract', "'2026-09-01T00:00:00Z'"), ends);
        await accepted(tx, await row(30_000, 'contract', "'2026-10-01T00:00:00Z'"));
      });
    });
  },
);
