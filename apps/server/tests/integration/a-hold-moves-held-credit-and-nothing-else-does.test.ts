// A hold is the only thing that moves held credit, and the database says so —
// not the code that writes it.
//
// This file asks Postgres directly, with raw SQL, past every check in
// TypeScript. Held credit is the difference between "the customer still has
// these credits" and "another task is already spending them", so each of these
// rules is the last line:
//
//   · a hold needs a lot that has STARTED, has not expired, is not revoked, and
//     belongs to the SAME account (the `starts_at` half is H4);
//   · a hold needs a TASK that is open and enforced (0132) — a hold behind a
//     settled task, a shadow measurement, or no task at all is credit frozen for
//     ever, because nothing will ever release it and, until 0133, no COMMIT-time
//     check fired on a statement that touches only holds;
//   · a statement that touches ONLY holds re-checks the task it names (0133,
//     `credit_holds_reservation_balance`), which is the fourth and last leg of
//     the balance and the one over the very table the rule is about;
//   · a hold never exceeds what its lot has left (`credit_lots_held_bounds`);
//   · `credit_lots.held_micro` moves ONLY through this table's trigger — a
//     session that writes it directly is refused even if it raises the flag the
//     guard looks for;
//   · a hold changes exactly once, by being released, and the release takes the
//     whole hold back off the lot;
//   · an enforced task's holds sum to exactly what it reserved, checked at
//     COMMIT — so a reservation cannot be written with credit behind only part
//     of it;
//   · a reservation's terms and a call's bound never change, a settled one is
//     final, and `sent` is one-way.
//
// Each refusal is required BY ITS OWN constraint name, because a different
// constraint firing first is a different guarantee and reads identically from a
// bare "it threw".

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

const ISOLATED_DB_NAME = 'driftstack_iso_credit_holds';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const BOOT = 'boot-holds';

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
 * A reservation with NO holds behind it, written with raw SQL — SHADOW, because
 * an ENFORCED one must be backed by holds that sum to exactly what it reserved,
 * checked at COMMIT, so an enforced task cannot exist on its own at all.
 *
 * ⛔ ONLY FOR ARMS THAT NEVER PUT A HOLD ON IT. From 0132 a hold needs an OPEN
 * ENFORCED task, so a hold named against one of these is refused; `taskHolding`
 * below is what the arms that place holds use.
 */
async function rawReservation(accountId: string, reservedMicro = 50 * MICRO): Promise<string> {
  const id = randomUUID();
  await db()`
    INSERT INTO credit_reservations (id, account_id, agent_session_id, model, rate_card_version,
                                     mode, reserved_micro, lease_owner, lease_expires_at, max_until)
    VALUES (${id}::uuid, ${accountId}::uuid, ${`as_${id}`}, ${ON_CREDITS_MODEL}, 1,
            'shadow', ${String(reservedMicro)}::bigint, ${BOOT},
            now() + interval '90 seconds', now() + interval '30 minutes')`;
  return id;
}

/**
 * An OPEN ENFORCED task holding exactly what it reserved: the reservation and
 * its holds in ONE transaction, taking the lowest free slot.
 *
 * ⛔ ONE TRANSACTION BECAUSE THE TWO ROWS ARE EACH OTHER'S PRECONDITION, and
 * that is the whole shape of the guarantee. An enforced reservation whose holds
 * do not sum to exactly what it reserved is refused at COMMIT (0131), and from
 * 0132 a hold whose task is not an open enforced one is refused as it is
 * inserted. Neither row can be written first on its own, which is what makes
 * "credit is held for a task that is really running" a fact about the database.
 */
async function taskHolding(
  accountId: string,
  holds: readonly { readonly lotId: string; readonly micro: number }[],
): Promise<string> {
  const id = randomUUID();
  const reserved = holds.reduce((sum, h) => sum + h.micro, 0);
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
             ${String(reserved)}::bigint, ${BOOT},
             now() + interval '90 seconds', now() + interval '30 minutes'`;
    for (const hold of holds) {
      await tx`
        INSERT INTO credit_reservation_holds (reservation_id, lot_id, account_id, held_micro)
        VALUES (${id}::uuid, ${hold.lotId}::uuid, ${accountId}::uuid,
                ${String(hold.micro)}::bigint)`;
    }
  });
  return id;
}

function placeHold(
  reservationId: string,
  lotId: string,
  accountId: string,
  micro: number,
): Promise<unknown> {
  return db()`
    INSERT INTO credit_reservation_holds (reservation_id, lot_id, account_id, held_micro)
    VALUES (${reservationId}::uuid, ${lotId}::uuid, ${accountId}::uuid, ${String(micro)}::bigint)`;
}

describe.skipIf(!RUN_DB_TESTS)('a hold moves held credit, and nothing else does', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
  });

  it('CRITICAL a hold needs a STARTED, live, unrevoked lot of the SAME account — all four refused by the trigger, with the same lot accepted once it is none of those things', async () => {
    const accountId = await newTaskAccount(db());
    const stranger = await newTaskAccount(db());
    // A real running task to hang the refused holds off, so each refusal is
    // about the LOT and not about the task: from 0132 a hold whose task is not
    // an open enforced one is refused before the lot is looked at.
    const ballast = await fundedTaskLot(db(), accountId, { credits: 50 });
    const rid = await taskHolding(accountId, [{ lotId: ballast, micro: 10 * MICRO }]);

    const future = await fundedTaskLot(db(), accountId, {
      credits: 50,
      starts: "now() + interval '1 hour'",
      expires: "now() + interval '40 days'",
    });
    const expired = await fundedTaskLot(db(), accountId, {
      credits: 50,
      starts: "now() - interval '40 days'",
      expires: "now() - interval '1 minute'",
    });
    const revoked = await fundedTaskLot(db(), accountId, { credits: 50 });
    await db()`UPDATE credit_lots SET revoked_at = now() WHERE id = ${revoked}::uuid`;
    const theirs = await fundedTaskLot(db(), stranger, { credits: 50 });

    for (const [what, lotId] of [
      ['a lot whose month has not begun (H4)', future],
      ['a lot whose term has ended', expired],
      ['a revoked lot', revoked],
      ["another account's lot", theirs],
    ] as const) {
      const refused = await refusal(() => placeHold(rid, lotId, accountId, 10 * MICRO), what);
      expect(refused.code, what).toBe('23514');
      expect(refused.message, what).toMatch(
        /a hold needs a started, live, unrevoked lot of the same account/,
      );
      expect(await heldOf(db(), lotId), `${what} — and nothing was held`).toBe(0);
    }

    // The positive control: a lot that is started, live, unrevoked and this
    // account's takes the hold, so the four refusals are about those four facts
    // and not about the statement. It goes behind a task of its own — the
    // ballast task above already holds exactly what it reserved, and a second
    // hold on it would be a different thing to have proved.
    const good = await fundedTaskLot(db(), accountId, { credits: 50 });
    await taskHolding(accountId, [{ lotId: good, micro: 10 * MICRO }]);
    expect(await heldOf(db(), good)).toBe(10 * MICRO);
    expect(await heldOf(db(), ballast), 'and the ballast task kept exactly its own').toBe(
      10 * MICRO,
    );
  });

  it('⛔ CRITICAL a hold needs an OPEN ENFORCED task (0132). A hold against a SETTLED task, a SHADOW one, or a task that is not there freezes its credit for ever — spendable by nobody, expirable by nobody, released by nobody — and nothing anywhere would notice', async () => {
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { credits: 50 });

    // A task that reserved, made no call, and was settled for nothing. Every
    // COMMIT-time check is satisfied and it is FINAL: `credit_reservations_guard`
    // will not let it change again, so the settlement that would have walked a
    // hold has already run and no other ever will.
    const own = await fundedTaskLot(db(), accountId, { credits: 50 });
    const settled = await taskHolding(accountId, [{ lotId: own, micro: 5 * MICRO }]);
    await db().begin(async (tx) => {
      await tx`UPDATE credit_reservation_holds SET released_at = now(), charged_micro = 0
                WHERE reservation_id = ${settled}::uuid`;
      await tx`UPDATE credit_reservations
                  SET state = 'settled', charged_micro = 0, settled_at = now(),
                      settle_reason = 'completed'
                WHERE id = ${settled}::uuid`;
    });

    // A measurement. It holds nothing and releases nothing — `settleIn` returns
    // before the holds walk for a shadow task — so a hold behind one is credit
    // nothing will ever give back.
    const shadow = await rawReservation(accountId);

    for (const [what, taskId] of [
      ['a task that has already settled', settled],
      ['a shadow measurement', shadow],
    ] as const) {
      const refused = await refusal(() => placeHold(taskId, lot, accountId, 7 * MICRO), what);
      expect(refused.code, what).toBe('23514');
      expect(refused.message, what).toMatch(/a hold needs an open, enforced task/);
      expect(await heldOf(db(), lot), `${what} — and nothing was held`).toBe(0);
    }

    // ⛔ A TASK THAT IS NOT THERE AT ALL IS THE KEY'S ANSWER, NOT THIS TRIGGER'S,
    // and the difference is MEASURED rather than assumed: Postgres fires AFTER
    // ROW triggers in name order and a referential-integrity trigger is called
    // `RI_ConstraintTrigger_…`, which sorts before `credit_holds_apply_trigger`.
    // So the composite key reports first, with its own code and its own name.
    // Written down because the obvious reading of the trigger — "its predicate
    // is total, so it refuses this too" — would be the wrong explanation of a
    // green arm.
    const noTask = await refusal(
      () => placeHold(randomUUID(), lot, accountId, 7 * MICRO),
      'a task that does not exist',
    );
    expect(noTask).toMatchObject({
      code: '23503',
      constraint: 'credit_reservation_holds_reservation_fk',
    });
    expect(await heldOf(db(), lot), 'and nothing was held').toBe(0);

    // ⛔ THE REFUSAL COMES BEFORE THE LOT IS LOOKED AT, and it has to: the lot
    // here is this account's, started, live and unrevoked, so every test the
    // trigger made before 0132 passes. Nothing else in the database would have
    // refused this row — no COMMIT-time reservation check fires on a statement
    // touching only holds, and `credit_check_reservation` returns before the
    // holds check for a shadow task even when one does.
    //
    // The positive control: the SAME hold, on the SAME lot, behind an open
    // enforced task, is accepted.
    await taskHolding(accountId, [{ lotId: lot, micro: 7 * MICRO }]);
    expect(await heldOf(db(), lot)).toBe(7 * MICRO);
  });

  it('CRITICAL a hold can never exceed what its lot has left, and two holds on one lot cannot exceed it between them', async () => {
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { credits: 10 });

    // Each task is written with its hold, in one transaction, because neither
    // row may exist without the other; a refused hold takes its whole task down
    // with it, which is why the lot is untouched after each refusal.
    const tooBig = await refusal(
      () => taskHolding(accountId, [{ lotId: lot, micro: 11 * MICRO }]),
      'a hold larger than the lot',
    );
    expect(tooBig).toMatchObject({ code: '23514', constraint: 'credit_lots_held_bounds' });
    expect(await heldOf(db(), lot)).toBe(0);

    await taskHolding(accountId, [{ lotId: lot, micro: 6 * MICRO }]);
    const overTheTop = await refusal(
      () => taskHolding(accountId, [{ lotId: lot, micro: 5 * MICRO }]),
      'a second hold past what is left',
    );
    expect(overTheTop).toMatchObject({ code: '23514', constraint: 'credit_lots_held_bounds' });
    expect(await heldOf(db(), lot), 'the first hold stands and the second took nothing').toBe(
      6 * MICRO,
    );

    // The rest of the lot is still available to a second task.
    await taskHolding(accountId, [{ lotId: lot, micro: 4 * MICRO }]);
    expect(await heldOf(db(), lot)).toBe(10 * MICRO);
  });

  it('CRITICAL `held_micro` moves ONLY through the holds table — a direct write is refused, and so is one from a session that raises the trigger’s own flag', async () => {
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { credits: 10 });

    const direct = await refusal(
      () => db()`UPDATE credit_lots SET held_micro = ${String(5 * MICRO)}::bigint
                  WHERE id = ${lot}::uuid`,
      'a direct write to held_micro',
    );
    expect(direct.code).toBe('55000');
    expect(direct.message).toMatch(
      /credit_lots\.held_micro moves only through credit_reservation_holds/,
    );

    // Raising the flag by hand is not enough: the guard also requires the write
    // to come from INSIDE a trigger (pg_trigger_depth() >= 2).
    const forged = await refusal(
      () =>
        db().begin(async (tx) => {
          await tx`SELECT set_config('driftstack.credit_hold_apply', 'on', true)`;
          await tx`UPDATE credit_lots SET held_micro = ${String(5 * MICRO)}::bigint
                  WHERE id = ${lot}::uuid`;
        }),
      'a write with the flag forged by the session',
    );
    expect(forged.code).toBe('55000');
    expect(await heldOf(db(), lot)).toBe(0);
  });

  it('CRITICAL a hold changes exactly once, by being released: the release takes the whole hold back off the lot, and every other update is refused', async () => {
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { credits: 20 });
    const rid = await taskHolding(accountId, [{ lotId: lot, micro: 12 * MICRO }]);
    expect(await heldOf(db(), lot)).toBe(12 * MICRO);

    const grew = await refusal(
      () => db()`UPDATE credit_reservation_holds SET held_micro = ${String(15 * MICRO)}::bigint
                  WHERE reservation_id = ${rid}::uuid AND lot_id = ${lot}::uuid`,
      'a hold that grows',
    );
    expect(grew.code).toBe('55000');
    expect(grew.message).toMatch(/a hold changes only by being released once/);

    const halfShape = await refusal(
      () => db()`UPDATE credit_reservation_holds SET released_at = now()
                  WHERE reservation_id = ${rid}::uuid AND lot_id = ${lot}::uuid`,
      'a release with no charge recorded',
    );
    expect(halfShape).toMatchObject({
      code: '23514',
      constraint: 'credit_reservation_holds_release_shape',
    });

    const overCharged = await refusal(
      () => db()`UPDATE credit_reservation_holds
                    SET released_at = now(), charged_micro = ${String(13 * MICRO)}::bigint
                  WHERE reservation_id = ${rid}::uuid AND lot_id = ${lot}::uuid`,
      'a charge larger than the hold',
    );
    expect(overCharged).toMatchObject({
      code: '23514',
      constraint: 'credit_reservation_holds_release_shape',
    });

    await db()`UPDATE credit_reservation_holds
                  SET released_at = now(), charged_micro = ${String(4 * MICRO)}::bigint
                WHERE reservation_id = ${rid}::uuid AND lot_id = ${lot}::uuid`;
    expect(await heldOf(db(), lot), 'the WHOLE hold comes off, not just the charge').toBe(0);

    const again = await refusal(
      () => db()`UPDATE credit_reservation_holds SET released_at = now()
                  WHERE reservation_id = ${rid}::uuid AND lot_id = ${lot}::uuid`,
      'a second release',
    );
    expect(again.code).toBe('55000');
  });

  it('⛔ CRITICAL a hold is BORN UNRELEASED — a row inserted with its release already filled in is refused, because nothing could ever take that credit back off the lot', async () => {
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { credits: 20 });
    const other = await fundedTaskLot(db(), accountId, { credits: 20 });
    // The positive control first, because from 0132 the hold needs an open
    // enforced task and an enforced task needs its holds: the row that proves a
    // hold IS accepted when it is born unreleased is the same row that makes the
    // task below exist at all.
    const rid = await taskHolding(accountId, [{ lotId: lot, micro: 8 * MICRO }]);
    expect(await heldOf(db(), lot)).toBe(8 * MICRO);

    // The insert branch adds the hold to `held_micro`; the release branch is the
    // only thing that takes it off, and it needs `OLD."released_at" IS NULL`. A
    // row that arrives already released therefore raises the lot's held credit
    // with no path back: those credits are not spendable (every spendable
    // predicate is `remaining − held`), not expirable (`expireDueLots` expires
    // `remaining − held` too) and never charged. They are simply gone.
    const born = await refusal(
      () => db()`
        INSERT INTO credit_reservation_holds
          (reservation_id, lot_id, account_id, held_micro, charged_micro, released_at)
        VALUES (${rid}::uuid, ${other}::uuid, ${accountId}::uuid, ${String(8 * MICRO)}::bigint,
                0, now())`,
      'a hold inserted already released',
    );
    expect(born.code).toBe('23514');
    expect(born.message).toMatch(/a hold is born unreleased/);
    expect(await heldOf(db(), other), 'and nothing was held').toBe(0);

    // …and the one born unreleased can be given back, which is the whole
    // difference: the release branch is reachable for it and never would be for
    // the row above.
    await db()`UPDATE credit_reservation_holds SET released_at = now(), charged_micro = 0
                WHERE reservation_id = ${rid}::uuid AND lot_id = ${lot}::uuid`;
    expect(await heldOf(db(), lot)).toBe(0);
  });

  it('⛔ CRITICAL a release keeps the hold’s ACCOUNT and its TASK — otherwise the COMMIT-time debt check reads a stranger’s debt and credit escapes it', async () => {
    const indebted = await newTaskAccount(db());
    const clear = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), indebted, { credits: 20 });
    const rid = await taskHolding(indebted, [{ lotId: lot, micro: 20 * MICRO }]);
    // Debt is writable only because the whole lot is held: nothing is spendable.
    await db()`
      INSERT INTO credit_ledger (account_id, kind, debt_delta_micro, idempotency_key, reason)
      VALUES (${indebted}::uuid, 'debt_incurred', ${String(5 * MICRO)}::bigint, 'debt:swap',
              'plan_change')`;

    // The honest release frees 20 credits beside 5 of debt, and the deferred
    // check refuses it — this is the guarantee the swap below must not dodge.
    const honest = await refusal(
      () => db()`UPDATE credit_reservation_holds SET released_at = now(), charged_micro = 0
                  WHERE reservation_id = ${rid}::uuid AND lot_id = ${lot}::uuid`,
      'a release that frees credit beside debt',
    );
    expect(honest).toMatchObject({ code: '23514', constraint: 'credit_holds_debt_vs_free' });

    // The same release, with the hold's account re-pointed at an account that
    // owes nothing: `credit_check_debt_vs_free` reads NEW."account_id", so the
    // swap hands it the wrong account to ask about.
    //
    // TWO independent guards refuse it and the KEY gets there first: (this
    // task, that account) is not a task that exists. ⛔ MEASURED, so that the
    // next reader is not told a redundancy is a defence: with the key in place,
    // deleting the trigger's own `NEW."account_id" = OLD."account_id"` leaves
    // every arm in this file green. The clause stays — it is pinned by text in
    // `the-reservations-migration-…` and it is what refuses a change to the
    // account made any OTHER way — but the key is what enforces this.
    const swappedAccount = await refusal(
      () => db()`UPDATE credit_reservation_holds
                    SET released_at = now(), charged_micro = 0, account_id = ${clear}::uuid
                  WHERE reservation_id = ${rid}::uuid AND lot_id = ${lot}::uuid`,
      'a release that re-points the hold at another account',
    );
    expect(swappedAccount).toMatchObject({
      code: '23503',
      constraint: 'credit_reservation_holds_reservation_fk',
    });
    expect(await heldOf(db(), lot), 'and the credit is still held').toBe(20 * MICRO);
    expect(
      (
        await db()`SELECT account_id FROM credit_reservation_holds
                   WHERE reservation_id = ${rid}::uuid AND lot_id = ${lot}::uuid`
      )[0]?.account_id,
      'and the hold still belongs to the account whose lot it is on',
    ).toBe(indebted);

    // …and re-pointing BOTH, at a task that really is the other account's, is a
    // pair the key ACCEPTS. Only the hold trigger refuses this one — its
    // `reservation_id` pin — which is why the key does not replace the trigger.
    const theirTask = await rawReservation(clear);
    const swappedBoth = await refusal(
      () => db()`UPDATE credit_reservation_holds
                    SET released_at = now(), charged_micro = 0, account_id = ${clear}::uuid,
                        reservation_id = ${theirTask}::uuid
                  WHERE reservation_id = ${rid}::uuid AND lot_id = ${lot}::uuid`,
      "a release that re-points the hold at another account's task",
    );
    expect(swappedBoth.code).toBe('55000');
    expect(swappedBoth.message).toMatch(/a hold changes only by being released once/);
    expect(await heldOf(db(), lot)).toBe(20 * MICRO);

    // The same for the task alone: a hold that moves to another reservation as
    // it is released leaves both reservations' holds disagreeing with what they
    // reserved. 0133's fourth leg would now refuse that at COMMIT for the task
    // it moved TO; the trigger refuses it here, immediately, and names the rule.
    const other = await rawReservation(indebted);
    const swappedTask = await refusal(
      () => db()`UPDATE credit_reservation_holds
                    SET released_at = now(), charged_micro = 0, reservation_id = ${other}::uuid
                  WHERE reservation_id = ${rid}::uuid AND lot_id = ${lot}::uuid`,
      'a release that re-points the hold at another task',
    );
    expect(swappedTask.code).toBe('55000');
    expect(await heldOf(db(), lot)).toBe(20 * MICRO);

    // The positive control: an account that owes nothing releases the same
    // shape of hold, and the credit comes back.
    const clearLot = await fundedTaskLot(db(), clear, { credits: 20 });
    const clearRid = await taskHolding(clear, [{ lotId: clearLot, micro: 20 * MICRO }]);
    await db()`UPDATE credit_reservation_holds SET released_at = now(), charged_micro = 0
                WHERE reservation_id = ${clearRid}::uuid AND lot_id = ${clearLot}::uuid`;
    expect(await heldOf(db(), clearLot)).toBe(0);
  });

  it('⛔ CRITICAL a hold and a model call name a task of their OWN account. A task backed by a STRANGER’s credit freezes that credit — the stranger can neither spend nor expire it — and can never settle, because the ledger refuses a charge naming another account’s lot, so the hold is never released and the slot never freed', async () => {
    const mine = await newTaskAccount(db());
    const stranger = await newTaskAccount(db());
    const theirLot = await fundedTaskLot(db(), stranger, { credits: 50 });
    const ballast = await fundedTaskLot(db(), mine, { credits: 50 });
    // A real running task of MINE, so the refusals below are about the account
    // the row names and not about the task being finished or a measurement.
    const rid = await taskHolding(mine, [{ lotId: ballast, micro: 10 * MICRO }]);

    // The lot IS the stranger's and the hold says so, so the apply trigger's
    // own "same account" test is satisfied — it compares the hold with its LOT.
    // What refuses this is the key to the task, which carries the account.
    const crossHold = await refusal(
      () => placeHold(rid, theirLot, stranger, 10 * MICRO),
      "a hold that puts a stranger's credit behind this task",
    );
    expect(crossHold).toMatchObject({
      code: '23503',
      constraint: 'credit_reservation_holds_reservation_fk',
    });
    expect(await heldOf(db(), theirLot), 'and none of their credit was held').toBe(0);

    const crossCall = await refusal(
      () =>
        db()`
        INSERT INTO credit_model_calls (id, reservation_id, account_id, seq, purpose, model,
                                        input_bound_tokens, input_bound_basis, input_bound_micro,
                                        max_output_tokens, bound_micro)
        VALUES (${randomUUID()}::uuid, ${rid}::uuid, ${stranger}::uuid, 1, 'plan',
                ${ON_CREDITS_MODEL}, 1000, 'region_bytes', ${String(2 * MICRO)}::bigint, 4096,
                ${String(5 * MICRO)}::bigint)`,
      "a model call of a stranger's account on this task",
    );
    expect(crossCall).toMatchObject({
      code: '23503',
      constraint: 'credit_model_calls_reservation_fk',
    });

    // The positive control: the SAME hold and the SAME call, on this task's own
    // account, are accepted — so the two refusals are about the account and not
    // about the statements.
    const ours = await fundedTaskLot(db(), mine, { credits: 50 });
    await taskHolding(mine, [{ lotId: ours, micro: 10 * MICRO }]);
    expect(await heldOf(db(), ours)).toBe(10 * MICRO);
    await db().begin(async (tx) => {
      await tx`
        INSERT INTO credit_model_calls (id, reservation_id, account_id, seq, purpose, model,
                                        input_bound_tokens, input_bound_basis, input_bound_micro,
                                        max_output_tokens, bound_micro)
        VALUES (${randomUUID()}::uuid, ${rid}::uuid, ${mine}::uuid, 1, 'plan', ${ON_CREDITS_MODEL},
                1000, 'region_bytes', ${String(2 * MICRO)}::bigint, 4096,
                ${String(5 * MICRO)}::bigint)`;
      await tx`UPDATE credit_reservations SET committed_micro = ${String(5 * MICRO)}::bigint
                WHERE id = ${rid}::uuid`;
    });
  });

  it('CRITICAL a hold is removed only with its account — the append-only guard refuses a DELETE while the account is there', async () => {
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { credits: 20 });
    const rid = await taskHolding(accountId, [{ lotId: lot, micro: 5 * MICRO }]);

    for (const [what, run] of [
      [
        'a hold',
        () => db()`DELETE FROM credit_reservation_holds WHERE reservation_id = ${rid}::uuid`,
      ],
      ['a reservation', () => db()`DELETE FROM credit_reservations WHERE id = ${rid}::uuid`],
    ] as const) {
      const refused = await refusal(run, what);
      expect(refused.code, what).toBe('55000');
      expect(refused.message, what).toMatch(/append-only/);
    }
  });

  it('CRITICAL an enforced task’s holds must sum to EXACTLY what it reserved, checked at COMMIT — a reservation with credit behind only part of it is refused whole', async () => {
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { credits: 50 });

    const short = await refusal(
      () =>
        db().begin(async (tx) => {
          const rid = randomUUID();
          await tx`
          INSERT INTO credit_reservations (id, account_id, agent_session_id, model,
                                           rate_card_version, mode, slot, reserved_micro,
                                           lease_owner, lease_expires_at, max_until)
          VALUES (${rid}::uuid, ${accountId}::uuid, 'as_short', ${ON_CREDITS_MODEL}, 1,
                  'enforce', 1, ${String(10 * MICRO)}::bigint, ${BOOT},
                  now() + interval '90 seconds', now() + interval '30 minutes')`;
          await tx`
          INSERT INTO credit_reservation_holds (reservation_id, lot_id, account_id, held_micro)
          VALUES (${rid}::uuid, ${lot}::uuid, ${accountId}::uuid, ${String(4 * MICRO)}::bigint)`;
        }),
      'an enforced reservation backed by less than it reserved',
    );
    expect(short.code).toBe('23514');
    expect(short.message).toMatch(/reserves 10000000 but holds 4000000/);
    expect(
      await heldOf(db(), lot),
      'and the whole transaction rolled back, so nothing is held',
    ).toBe(0);

    // The positive control, same shape, holds that add up: accepted.
    await db().begin(async (tx) => {
      const rid = randomUUID();
      await tx`
        INSERT INTO credit_reservations (id, account_id, agent_session_id, model,
                                         rate_card_version, mode, slot, reserved_micro,
                                         lease_owner, lease_expires_at, max_until)
        VALUES (${rid}::uuid, ${accountId}::uuid, 'as_exact', ${ON_CREDITS_MODEL}, 1,
                'enforce', 1, ${String(10 * MICRO)}::bigint, ${BOOT},
                now() + interval '90 seconds', now() + interval '30 minutes')`;
      await tx`
        INSERT INTO credit_reservation_holds (reservation_id, lot_id, account_id, held_micro)
        VALUES (${rid}::uuid, ${lot}::uuid, ${accountId}::uuid, ${String(10 * MICRO)}::bigint)`;
    });
    expect(await heldOf(db(), lot)).toBe(10 * MICRO);
  });

  it('CRITICAL a reservation’s terms are immutable and a settled task is final', async () => {
    const accountId = await newTaskAccount(db());
    const rid = await rawReservation(accountId);

    for (const [what, run] of [
      [
        'its model',
        () => db()`UPDATE credit_reservations SET model = 'claude-haiku-4-5'
                    WHERE id = ${rid}::uuid`,
      ],
      [
        'what it reserved',
        () => db()`UPDATE credit_reservations SET reserved_micro = 1 WHERE id = ${rid}::uuid`,
      ],
      [
        'its ceiling',
        () => db()`UPDATE credit_reservations SET max_until = now() + interval '20 minutes'
                    WHERE id = ${rid}::uuid`,
      ],
      [
        'its lease owner',
        () => db()`UPDATE credit_reservations SET lease_owner = 'someone-else'
                    WHERE id = ${rid}::uuid`,
      ],
    ] as const) {
      const refused = await refusal(run, what);
      expect(refused.code, what).toBe('55000');
      expect(refused.message, what).toMatch(/a reservation's terms are immutable/);
    }

    // What MAY move: the lease and the settlement.
    await db()`UPDATE credit_reservations SET lease_expires_at = now() + interval '90 seconds'
                WHERE id = ${rid}::uuid`;
    await db()`UPDATE credit_reservations
                  SET state = 'settled', charged_micro = 0, settled_at = now(),
                      settle_reason = 'completed'
                WHERE id = ${rid}::uuid`;
    const final = await refusal(
      () => db()`UPDATE credit_reservations SET lease_expires_at = now() + interval '90 seconds'
                  WHERE id = ${rid}::uuid`,
      'a settled task',
    );
    expect(final.code).toBe('55000');
    expect(final.message).toMatch(/a settled task is final/);
  });

  it('CRITICAL a model call’s bound is immutable, `sent` is one-way, and a settled call is final', async () => {
    const accountId = await newTaskAccount(db());
    const rid = await rawReservation(accountId);
    const callId = randomUUID();
    // ⛔ ONE TRANSACTION. The COMMIT-time check refuses a reservation whose
    // `committed_micro` is not its calls' bounds, so a call written on its own
    // is refused at commit — which is the rule the admission path relies on and
    // is itself proved in the settlement file.
    await db().begin(async (tx) => {
      await tx`
        INSERT INTO credit_model_calls (id, reservation_id, account_id, seq, purpose, model,
                                        input_bound_tokens, input_bound_basis, input_bound_micro,
                                        max_output_tokens, bound_micro)
        VALUES (${callId}::uuid, ${rid}::uuid, ${accountId}::uuid, 1, 'plan', ${ON_CREDITS_MODEL},
                1000, 'region_bytes', ${String(2 * MICRO)}::bigint, 4096,
                ${String(5 * MICRO)}::bigint)`;
      await tx`UPDATE credit_reservations SET committed_micro = ${String(5 * MICRO)}::bigint
                WHERE id = ${rid}::uuid`;
    });

    const rebound = await refusal(
      () => db()`UPDATE credit_model_calls SET bound_micro = ${String(9 * MICRO)}::bigint
                  WHERE id = ${callId}::uuid`,
      'a call whose bound moves',
    );
    expect(rebound.code).toBe('55000');
    expect(rebound.message).toMatch(/a model call's bound is immutable/);

    await db()`UPDATE credit_model_calls SET sent = true WHERE id = ${callId}::uuid`;
    const unsent = await refusal(
      () => db()`UPDATE credit_model_calls SET sent = false WHERE id = ${callId}::uuid`,
      'a sent call that becomes unsent',
    );
    expect(unsent.code).toBe('55000');

    // A sent call cannot then be priced as one that never went out.
    const lie = await refusal(
      () => db()`UPDATE credit_model_calls
                    SET state = 'settled', settle_basis = 'never_sent', charged_micro = 0,
                        settled_at = now()
                  WHERE id = ${callId}::uuid`,
      'a sent call settled as never sent',
    );
    expect(lie).toMatchObject({
      code: '23514',
      constraint: 'credit_model_calls_never_sent_really',
    });

    await db().begin(async (tx) => {
      await tx`UPDATE credit_model_calls
                  SET state = 'settled', settle_basis = 'no_record',
                      charged_micro = bound_micro, settled_at = now()
                WHERE id = ${callId}::uuid`;
    });
    const done = await refusal(
      () => db()`UPDATE credit_model_calls SET sent = true WHERE id = ${callId}::uuid`,
      'a settled call',
    );
    expect(done.code).toBe('55000');
  });
});
