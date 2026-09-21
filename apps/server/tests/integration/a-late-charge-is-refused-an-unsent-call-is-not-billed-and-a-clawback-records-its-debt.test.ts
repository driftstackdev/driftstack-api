// Three rules that were true in TypeScript and not true in Postgres, until
// migration 0132 put them in the database (§4.6, §5.1, §5.3, M6).
//
// This file asks Postgres directly, with raw SQL, past every check in the
// service — because each of these was already enforced by the code that writes
// the rows, and a rule that lives only in the process that writes a row is not a
// rule a second writer, a psql session or a restore has to obey:
//
//   · A CALL THAT NEVER WENT OUT IS NOT BILLED. `no_record` is the basis that
//     charges the FULL BOUND, and it may only be named on a row that says the
//     request really was sent. 0131 held the mirror — `never_sent` on a row that
//     says it WAS sent — and nothing held this half, so a writer that skipped
//     S8's `basisTheRowAgreesWith` could bill a customer the ceiling of a
//     request that never left the process.
//
//   · A SETTLED TASK TAKES NO MORE CREDIT. A settled task's charge is one number
//     written into three records — its calls, its holds, and its `task_charge`
//     ledger rows — and until 0132 only two of them ever re-checked it:
//     `credit_check_reservation` fired from `credit_model_calls` and
//     `credit_reservations` and from nowhere else. A lone ledger row written
//     after the task settled moved credit off a lot with nothing asking whether
//     the three still agreed.
//
//   · A CLAWBACK SAYS WHAT IT COST. When a pending claim can no longer be paid
//     it becomes debt — and the clawback's own `debt_micro` may now rise by
//     exactly what its `pending_micro` gives up, in the same statement. 0130
//     listed `debt_micro` among the immutable facts, so the ledger recorded the
//     debt and the clawback that caused it recorded nothing; M6's "forgive the
//     unrepaid debt it created", read off that row, would forgive too little.
//     Nothing else about a clawback moved then and nothing else moves now, which
//     is the half of this that needs proving hardest.
//
//   · A HOLD CANNOT LAND ON A TASK THAT IS SETTLING BESIDE IT. 0132 refuses a
//     hold whose task is not open and enforced — but a lookup answers from the
//     asking transaction's snapshot, and when that rule was written a statement
//     touching only `credit_reservation_holds` queued no COMMIT-time check to
//     ask again (0133 added one, and it catches the ENFORCED half of this race
//     a second time; a hold on a SHADOW task is still caught here alone). The
//     lookup therefore takes `FOR SHARE` on the task row, and the arm below runs
//     two connections at once to say so: without the lock the hold commits after
//     the settlement and freezes credit on a lot for ever, which is the state
//     the rule exists to make impossible.
//
//   · ONLY A MODEL REFUSAL MAY RESERVE NOTHING. The widening that lets a shadow
//     measurement of an unpriceable model carry `reserved_micro = 0` is written
//     `IS NOT DISTINCT FROM 'model'`, because `would_refuse_reason` is nullable
//     and a CHECK passes on NULL: written `= 'model'` it admitted a SECOND
//     shape, a shadow row reserving zero with no reason recorded, which S11's
//     census cannot tell from a reading of zero.
//
// Each refusal is required BY ITS OWN constraint name or its own message,
// because a different guard firing first is a different guarantee and reads
// identically from a bare "it threw".

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { refusal } from './_helpers/database-refusal.js';
import {
  MICRO,
  ON_CREDITS_MODEL,
  fundedTaskLot,
  heldOf,
  newTaskAccount,
} from './_helpers/credit-reservation-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_guard_gaps';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const BOOT = 'boot-gaps';

let client: postgres.Sql | null = null;

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const db = await openLedgerDatabase(ISOLATED_DB_NAME, 4);
  if (db === null) return;
  client = db.sql;
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

/**
 * An OPEN ENFORCED task holding exactly `micro` of `lotId`, reservation and hold
 * in ONE transaction — the only shape either row may have: an enforced
 * reservation's holds must sum to exactly what it reserved (checked at COMMIT),
 * and a hold must name an open enforced task (checked as it is inserted, 0132).
 */
async function taskHolding(accountId: string, lotId: string, micro: number): Promise<string> {
  const id = randomUUID();
  await db().begin(async (tx) => {
    await tx`
      INSERT INTO credit_reservations (id, account_id, agent_session_id, model, rate_card_version,
                                       mode, slot, reserved_micro, lease_owner, lease_expires_at,
                                       max_until)
      SELECT ${id}::uuid, ${accountId}::uuid, ${`as_${id}`}, ${ON_CREDITS_MODEL}, 1, 'enforce',
             (SELECT s FROM generate_series(1, 3) s
               WHERE NOT EXISTS (SELECT 1 FROM credit_reservations o
                                  WHERE o.account_id = ${accountId}::uuid
                                    AND o.state = 'open' AND o.mode = 'enforce' AND o.slot = s)
               ORDER BY s LIMIT 1),
             ${String(micro)}::bigint, ${BOOT},
             now() + interval '90 seconds', now() + interval '30 minutes'`;
    await tx`
      INSERT INTO credit_reservation_holds (reservation_id, lot_id, account_id, held_micro)
      VALUES (${id}::uuid, ${lotId}::uuid, ${accountId}::uuid, ${String(micro)}::bigint)`;
  });
  return id;
}

/** One call row, written with the reservation's `committed_micro`, in one transaction. */
function callInsert(
  tx: postgres.TransactionSql,
  input: {
    readonly reservationId: string;
    readonly accountId: string;
    readonly boundMicro: number;
    readonly sent: boolean;
    readonly settleBasis: string;
    readonly chargedMicro: number;
  },
): Promise<unknown> {
  return tx`
    INSERT INTO credit_model_calls (id, reservation_id, account_id, seq, purpose, model,
                                    input_bound_tokens, input_bound_basis, input_bound_micro,
                                    max_output_tokens, bound_micro, sent, state, settle_basis,
                                    charged_micro, settled_at)
    VALUES (${randomUUID()}::uuid, ${input.reservationId}::uuid, ${input.accountId}::uuid, 1,
            'plan', ${ON_CREDITS_MODEL}, 1000, 'region_bytes',
            ${String(Math.floor(input.boundMicro / 2))}::bigint, 4096,
            ${String(input.boundMicro)}::bigint, ${input.sent}, 'settled', ${input.settleBasis},
            ${String(input.chargedMicro)}::bigint, now())`;
}

/** An applied clawback with a pending claim and whatever debt it has recorded so far. */
async function clawback(input: {
  readonly accountId: string;
  readonly pendingMicro: number;
  readonly debtMicro: number;
}): Promise<string> {
  const [row] = await db()<Array<{ id: string }>>`
    INSERT INTO credit_clawbacks (account_id, source, source_ref, target_key, amount_micro,
                                  state, clawed_micro, debt_micro, pending_micro)
    VALUES (${input.accountId}::uuid, 'plan_change', ${`ref-${randomUUID()}`},
            ${`window:${randomUUID()}`}, ${String(10 * MICRO)}::bigint, 'applied',
            0::bigint, ${String(input.debtMicro)}::bigint, ${String(input.pendingMicro)}::bigint)
    RETURNING id`;
  if (row === undefined) throw new Error('clawback insert returned nothing');
  return row.id;
}

/**
 * A one-way gate for the two-connection arm: `passed` resolves when `open` is
 * called. Written as a helper because the obvious inline form — a `let` the
 * Promise executor assigns — is narrowed to `null` by the compiler, which does
 * not follow assignments made inside a callback.
 */
function gate(): { readonly open: () => void; readonly passed: Promise<void> } {
  let open: () => void = () => {};
  const passed = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open: () => open(), passed };
}

async function clawbackRow(id: string): Promise<{ pending: number; debt: number; state: string }> {
  const [row] = await db()<Array<{ pending: string; debt: string; state: string }>>`
    SELECT pending_micro::text AS pending, debt_micro::text AS debt, state
      FROM credit_clawbacks WHERE id = ${id}::uuid`;
  if (row === undefined) throw new Error(`clawback ${id} not found`);
  return { pending: Number(row.pending), debt: Number(row.debt), state: row.state };
}

describe.skipIf(!RUN_DB_TESTS)(
  'a late charge is refused, an unsent call is not billed, and a clawback records its debt',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it('⛔ CRITICAL A CALL THE ROW SAYS NEVER WENT OUT CANNOT BE CHARGED ITS BOUND (0132). `no_record` prices the window after `sent` and before any record at the full ceiling, so on a row where `sent` is false it bills the customer for a request that never left the process. The mirror — `never_sent` on a row that WAS sent — has been refused since 0131; this is the half nothing held.', async () => {
      const accountId = await newTaskAccount(db());
      const lot = await fundedTaskLot(db(), accountId, { credits: 50 });
      const rid = await taskHolding(accountId, lot, 10 * MICRO);

      const lie = await refusal(
        () =>
          db().begin(async (tx) => {
            await callInsert(tx, {
              reservationId: rid,
              accountId,
              boundMicro: 5 * MICRO,
              sent: false,
              settleBasis: 'no_record',
              chargedMicro: 5 * MICRO,
            });
            await tx`UPDATE credit_reservations SET committed_micro = ${String(5 * MICRO)}::bigint
                    WHERE id = ${rid}::uuid`;
          }),
        'a call charged the bound on a row that says it never went out',
      );
      expect(lie).toMatchObject({
        code: '23514',
        constraint: 'credit_model_calls_no_record_really',
      });

      // The two positive controls, so the refusal is about `sent` and not about
      // the statement or the basis. Same row with `sent` true: accepted at the
      // bound. Same row, still unsent, settled as `never_sent`: accepted at zero,
      // which is what §4.6 prices that window at.
      await db().begin(async (tx) => {
        await callInsert(tx, {
          reservationId: rid,
          accountId,
          boundMicro: 5 * MICRO,
          sent: true,
          settleBasis: 'no_record',
          chargedMicro: 5 * MICRO,
        });
        await tx`UPDATE credit_reservations SET committed_micro = ${String(5 * MICRO)}::bigint
                WHERE id = ${rid}::uuid`;
      });

      const unsentTask = await taskHolding(accountId, lot, 4 * MICRO);
      await db().begin(async (tx) => {
        await callInsert(tx, {
          reservationId: unsentTask,
          accountId,
          boundMicro: 5 * MICRO,
          sent: false,
          settleBasis: 'never_sent',
          chargedMicro: 0,
        });
        await tx`UPDATE credit_reservations SET committed_micro = 0 WHERE id = ${unsentTask}::uuid`;
      });
      expect(
        (
          await db()`SELECT count(*)::text AS n FROM credit_model_calls
                    WHERE state = 'settled' AND settle_basis IN ('no_record', 'never_sent')`
        )[0]?.n,
        'both accepted rows landed',
      ).toBe('2');
    });

    it('⛔ CRITICAL A SETTLED TASK TAKES NO MORE CREDIT (0132). A `task_charge` row written after the task settled moves credit off a lot, and until this migration nothing re-checked the task from the ledger side at all: both COMMIT-time reservation checks hang off `credit_model_calls` and `credit_reservations`, so a statement touching only `credit_ledger` committed whatever it said.', async () => {
      const accountId = await newTaskAccount(db());
      const lot = await fundedTaskLot(db(), accountId, { credits: 50 });
      const rid = await taskHolding(accountId, lot, 6 * MICRO);

      // The task runs one call, is charged for it, releases its hold and settles:
      // calls, holds and ledger all say 2 credits, and every check passes.
      await db().begin(async (tx) => {
        await callInsert(tx, {
          reservationId: rid,
          accountId,
          boundMicro: 4 * MICRO,
          sent: true,
          settleBasis: 'provider_usage',
          chargedMicro: 2 * MICRO,
        });
        await tx`UPDATE credit_reservations SET committed_micro = ${String(2 * MICRO)}::bigint
                WHERE id = ${rid}::uuid`;
      });
      await db().begin(async (tx) => {
        await tx`
        INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key,
                                   reservation_id, model, rate_card_version)
        VALUES (${accountId}::uuid, 'task_charge', ${lot}::uuid, ${String(-2 * MICRO)}::bigint,
                ${`task_charge:${rid}`}, ${rid}::uuid, ${ON_CREDITS_MODEL}, 1)`;
        await tx`UPDATE credit_reservation_holds
                  SET released_at = now(), charged_micro = ${String(2 * MICRO)}::bigint
                WHERE reservation_id = ${rid}::uuid`;
        await tx`UPDATE credit_reservations
                  SET state = 'settled', charged_micro = ${String(2 * MICRO)}::bigint,
                      settled_at = now(), settle_reason = 'completed'
                WHERE id = ${rid}::uuid`;
      });
      expect(await heldOf(db(), lot), 'the hold came off when the task settled').toBe(0);

      // One more charge against the same finished task. It names a real lot of a
      // real account and every column rule accepts it; what refuses it is the
      // third leg of the balance.
      const late = await refusal(
        () =>
          db()`
        INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key,
                                   reservation_id, model, rate_card_version)
        VALUES (${accountId}::uuid, 'task_charge', ${lot}::uuid, ${String(-1 * MICRO)}::bigint,
                ${`late:${randomUUID()}`}, ${rid}::uuid, ${ON_CREDITS_MODEL}, 1)`,
        'a task charge written after the task settled',
      );
      expect(late.code).toBe('23514');
      expect(late.message).toMatch(/settled reservation .* does not balance/);
      expect(
        (await db()`SELECT remaining_micro::text AS n FROM credit_lots WHERE id = ${lot}::uuid`)[0]
          ?.n,
        'and not one microcredit left the lot',
      ).toBe(String(48 * MICRO));

      // The control, in the same breath: a ledger row that moves the SAME lot by
      // the same amount and names no task still commits. So the trigger is
      // refusing the charge's claim about a finished task, not the table, the lot
      // or the sign.
      await db()`
      INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
      VALUES (${accountId}::uuid, 'expiry', ${lot}::uuid, ${String(-1 * MICRO)}::bigint,
              ${`plain:${randomUUID()}`})`;
      expect(
        (await db()`SELECT remaining_micro::text AS n FROM credit_lots WHERE id = ${lot}::uuid`)[0]
          ?.n,
      ).toBe(String(47 * MICRO));
    });

    it('⛔ CRITICAL A CLAWBACK RECORDS THE DEBT IT CAUSED (0132): `debt_micro` may rise by exactly what `pending_micro` gives up, in the same statement — a TRANSFER, credit the account still owed becoming debt it owes — and by nothing else. Until this migration the guard listed `debt_micro` among the immutable facts, so the ledger recorded the debt and the clawback that caused it recorded none.', async () => {
      const accountId = await newTaskAccount(db());
      const id = await clawback({ accountId, pendingMicro: 4 * MICRO, debtMicro: 0 });

      await db()`
      UPDATE credit_clawbacks
         SET pending_micro = pending_micro - ${String(4 * MICRO)}::bigint,
             debt_micro = debt_micro + ${String(4 * MICRO)}::bigint
       WHERE id = ${id}::uuid`;
      expect(await clawbackRow(id)).toEqual({ pending: 0, debt: 4 * MICRO, state: 'applied' });

      // Part of a claim, twice, reaching the same place: the movement is by the
      // amount given up each time and not by the whole claim.
      const part = await clawback({ accountId, pendingMicro: 6 * MICRO, debtMicro: MICRO });
      for (const micro of [2 * MICRO, 3 * MICRO]) {
        await db()`
        UPDATE credit_clawbacks
           SET pending_micro = pending_micro - ${String(micro)}::bigint,
               debt_micro = debt_micro + ${String(micro)}::bigint
         WHERE id = ${part}::uuid`;
      }
      expect(await clawbackRow(part)).toEqual({
        pending: MICRO,
        debt: 6 * MICRO,
        state: 'applied',
      });

      // …and paying a claim from released credit still lowers it with no debt at
      // all, which is the ordinary case and must not have been widened.
      await db()`UPDATE credit_clawbacks SET pending_micro = 0 WHERE id = ${part}::uuid`;
      expect(await clawbackRow(part)).toEqual({ pending: 0, debt: 6 * MICRO, state: 'applied' });
    });

    it('⛔ CRITICAL and EVERY OTHER MUTATION OF A CLAWBACK IS STILL REFUSED. The guard was widened by exactly one movement, so this is the arm that says what "exactly one" means: debt that rises on its own, debt that rises by more or less than the claim gave up, debt that rises while the claim rises too, debt erased, a claim that grows, a fact rewritten, and a state that moves anywhere but applied → reversed.', async () => {
      const accountId = await newTaskAccount(db());
      const id = await clawback({ accountId, pendingMicro: 5 * MICRO, debtMicro: 2 * MICRO });

      for (const [what, set] of [
        ['debt that rises with no claim given up', `debt_micro = debt_micro + ${MICRO}`],
        [
          'debt that rises by MORE than the claim gave up',
          `pending_micro = pending_micro - ${MICRO}, debt_micro = debt_micro + ${2 * MICRO}`,
        ],
        [
          'debt that rises by LESS than the claim gave up',
          `pending_micro = pending_micro - ${2 * MICRO}, debt_micro = debt_micro + ${MICRO}`,
        ],
        ['debt that falls', `debt_micro = debt_micro - ${MICRO}`],
        ['debt erased altogether', 'debt_micro = NULL'],
        ['a claim that grows', `pending_micro = pending_micro + ${MICRO}`],
        ['what was clawed back', `clawed_micro = ${MICRO}`],
        ['what the clawback was for', "target_key = 'somewhere-else'"],
        ['a state that goes back to applied from nowhere', "state = 'unmatched'"],
      ] as const) {
        const refused = await refusal(
          () => db().unsafe(`UPDATE credit_clawbacks SET ${set} WHERE id = $1::uuid`, [id]),
          what,
        );
        expect(refused.code, what).toBe('55000');
        expect(refused.message, what).toMatch(
          /a clawback only pays down its pending claim, takes that claim as debt, or is reversed once/,
        );
        expect(await clawbackRow(id), `${what} — and the row is untouched`).toEqual({
          pending: 5 * MICRO,
          debt: 2 * MICRO,
          state: 'applied',
        });
      }

      // The one state move that IS allowed, in the same breath, so "refused"
      // above cannot mean "every update is refused".
      await db()`UPDATE credit_clawbacks SET state = 'reversed' WHERE id = ${id}::uuid`;
      expect((await clawbackRow(id)).state).toBe('reversed');
    });

    it('⛔ CRITICAL A HOLD CANNOT LAND ON A TASK THAT IS SETTLING BESIDE IT (0132). The rule is enforced by a lookup inside `credit_holds_apply`, and a lookup answers from the asking transaction’s snapshot: with no row lock a second connection reads “open”, the settlement commits, and the hold commits after it — onto a SETTLED task, with `held_micro` raised and no path back, which is exactly the frozen credit the rule exists to make impossible. When the rule was written nothing caught it afterwards, because a statement touching only `credit_reservation_holds` queued no COMMIT-time check; 0133’s fourth leg now catches the enforced half a second time, and a hold on a SHADOW task still has only this. `FOR SHARE` makes the two order themselves.', async () => {
      const accountId = await newTaskAccount(db());
      const held = await fundedTaskLot(db(), accountId, { credits: 50 });
      // A SECOND lot, so the racing hold and the settlement's release touch
      // different `credit_lots` rows: on one lot they would queue behind each
      // other's row lock and the race could not be run at all.
      const other = await fundedTaskLot(db(), accountId, { credits: 50 });
      const rid = await taskHolding(accountId, held, 3 * MICRO);

      const hasSettled = gate();
      const mayCommit = gate();

      // Connection 1: the settlement, held open after it has written every row.
      const settlement = db().begin(async (tx) => {
        await tx`UPDATE credit_reservation_holds SET released_at = now(), charged_micro = 0
                  WHERE reservation_id = ${rid}::uuid`;
        await tx`UPDATE credit_reservations
                    SET state = 'settled', charged_micro = 0, settled_at = now(),
                        settle_reason = 'completed'
                  WHERE id = ${rid}::uuid`;
        hasSettled.open();
        await mayCommit.passed;
      });
      await hasSettled.passed;

      // Connection 2, issued while that transaction is still open: a hold on the
      // other lot of the same task. Unlocked it commits in single-digit
      // milliseconds; locked it waits for connection 1 and is then refused.
      const racing = refusal(
        () =>
          db()`INSERT INTO credit_reservation_holds (reservation_id, lot_id, account_id, held_micro)
               VALUES (${rid}::uuid, ${other}::uuid, ${accountId}::uuid, ${String(MICRO)}::bigint)`,
        'a hold placed on a task that was settling on another connection',
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      mayCommit.open();
      await settlement;

      const refused = await racing;
      expect(refused.code).toBe('23514');
      expect(refused.message).toMatch(/a hold needs an open, enforced task/);
      expect(
        (
          await db()`SELECT count(*)::text AS n FROM credit_reservation_holds
                      WHERE reservation_id = ${rid}::uuid AND released_at IS NULL`
        )[0]?.n,
        'the settled task carries no open hold',
      ).toBe('0');
      expect(await heldOf(db(), other), 'and not one microcredit is frozen on the other lot').toBe(
        0,
      );
    });

    it("⛔ CRITICAL ONLY A MODEL REFUSAL MAY RESERVE NOTHING (0132). `credit_reservations_amounts` was widened to let a shadow measurement of an unpriceable model carry `reserved_micro = 0`; the reason column is NULLABLE and a CHECK passes on NULL, so written as `= 'model'` the widening also admitted a shadow row reserving zero with NO reason at all — a row S11’s census cannot tell from a reading of zero. It is written `IS NOT DISTINCT FROM`, which is FALSE for NULL.", async () => {
      const accountId = await newTaskAccount(db());
      const shadow = (reservedMicro: number, reason: string | null): Promise<unknown> =>
        db()`
          INSERT INTO credit_reservations (id, account_id, agent_session_id, model,
                                           rate_card_version, mode, reserved_micro,
                                           would_refuse_reason, lease_owner, lease_expires_at,
                                           max_until)
          VALUES (${randomUUID()}::uuid, ${accountId}::uuid, ${`as_${randomUUID()}`},
                  ${ON_CREDITS_MODEL}, 1, 'shadow', ${String(reservedMicro)}::bigint, ${reason},
                  ${BOOT}, now() + interval '90 seconds', now() + interval '30 minutes')`;

      // The one shape the widening is for.
      await shadow(0, 'model');

      // …and nothing else that reserves nothing. Every one of these is a row
      // 0131 refused, and each must still be refused now.
      for (const [what, reason] of [
        ['a shadow measurement of nothing, with no reason recorded', null],
        ['a shadow measurement that says the BALANCE would have refused', 'balance'],
        ['a shadow measurement that says the task count would have refused', 'tasks_in_flight'],
      ] as const) {
        const refused = await refusal(() => shadow(0, reason), what);
        expect(refused.code, what).toBe('23514');
        expect(refused.constraint, what).toBe('credit_reservations_amounts');
      }

      // The positive controls: an ordinary shadow measurement, with a reason and
      // without one, is untouched by the widening.
      await shadow(60 * MICRO, null);
      await shadow(60 * MICRO, 'balance');
      expect(
        (
          await db()`SELECT count(*)::text AS n FROM credit_reservations
                      WHERE account_id = ${accountId}::uuid AND mode = 'shadow'`
        )[0]?.n,
        'three shadow rows landed and three were refused',
      ).toBe('3');
    });
  },
);
