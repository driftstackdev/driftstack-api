// Migration 0133: the fourth leg of the task balance, and a measurement that
// cannot be charged.
//
// Both rules were MEASURED as gaps against a database already at 0132, with raw
// SQL, before the migration was written. What follows is the same two statements
// asked again of a database at 0133, plus the legitimate paths they must not
// touch.
//
//   · THE FOURTH LEG. `credit_check_reservation` was queued from
//     `credit_model_calls` (0131), `credit_reservations` (0131) and
//     `credit_ledger` (0132) — and from nothing that touched only
//     `credit_reservation_holds`. So the one rule that is ABOUT the holds ("an
//     enforced task's holds sum to exactly what it reserved") was the one rule
//     no holds statement re-asked. At 0132 a second hold inserted BY ITSELF onto
//     an open enforced task committed, leaving `reserved_micro` 50,000,000
//     against holds of 60,000,000; an UPDATE of that same task's
//     `lease_expires_at` — touching only the reservation — then failed at COMMIT
//     with 0131's own message. The rule was there the whole time and no holds
//     statement could reach it.
//
//     The damage is the frozen-credit one: the extra hold raises the lot's
//     `held_micro`, and it makes the task UNSETTLEABLE, because every settlement
//     of it meets the same check. The slot is never freed and the credit is held
//     for ever.
//
//   · A MEASUREMENT IS NEVER CHARGED. `credit_check_reservation` returned as
//     soon as it saw `mode = 'shadow'` — a shadow task holds nothing, so there
//     is no holds leg to check — and that return happened before anything asked
//     whether the ledger had charged it anyway. At 0132 one `task_charge` row
//     naming a shadow reservation committed and took 7,000,000 µcr off a funded
//     lot, because `credit_ledger_apply` moves credit whichever task the row
//     names. Shadow is the mode every turn runs in for the whole measurement era
//     (S11), so this is one mis-set mode away from a customer paying for a
//     measurement that was supposed to cost them nothing.
//
// ⛔ WHAT THIS FILE DOES NOT RE-PROVE. "Every legitimate path still commits" is
// mostly other files' subject and re-implementing them here would be a second
// copy to keep in step: a clawback landing on a running task is
// `a-late-charge-is-refused-an-unsent-call-is-not-billed-and-a-clawback-records-its-debt`,
// a grant that pays off debt is `a-new-grant-pays-off-debt-first`, a refund is
// `a-downgrade-takes-back-what-is-free-and-owes-only-what-was-spent`, and the
// whole reserve/admit/settle ladder is
// `a-model-call-starts-only-if-its-bound-fits-what-the-task-has-left`. What IS
// here is every path that writes holds and ledger rows and a reservation in one
// transaction — the shape the new leg could refuse — walked through the real
// service and the real keeper, plus the two ledger rows that name no task at all
// and must therefore queue nothing.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import type { CreditCallBound } from '../../src/db/credit-reservations-repo.js';
import { AiCreditLeaseKeeper } from '../../src/services/ai-credit-lease-keeper.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { refusal } from './_helpers/database-refusal.js';
import {
  MICRO,
  ON_CREDITS_MODEL,
  agedReservation,
  fundedTaskLot,
  holdRows,
  ledgerOf,
  lotState,
  newTaskAccount,
  reservationCounters,
  reservationsHarness,
  type ReservationsHarness,
} from './_helpers/credit-reservation-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_fourth_leg';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const BOOT = 'boot-fourth-leg';

/** A Sonnet call's bound over a small body: input 800 µcr + 4,096 output tokens. */
const BOUND: CreditCallBound = {
  inputBoundTokens: 2,
  inputBoundMicro: 800,
  maxOutputTokens: 4_096,
  boundMicro: 800 + 4_096 * 2_000,
  basis: 'region_bytes',
};

let client: postgres.Sql | null = null;
let url: string | null = null;
const opened: Database[] = [];

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const db = await openLedgerDatabase(ISOLATED_DB_NAME, 6);
  if (db === null) return;
  client = db.sql;
  url = db.url;
}, 60_000);

afterAll(async () => {
  await client?.end({ timeout: 5 }).catch(() => {});
  await Promise.all(opened.map((d) => d.close().catch(() => {})));
});

function db(): postgres.Sql {
  if (client === null) throw new Error('isolated database unreachable');
  return client;
}

function harness(max = 3): ReservationsHarness {
  if (url === null) throw new Error('isolated database unreachable');
  const h = reservationsHarness(url, { max });
  opened.push(h.database);
  return h;
}

/**
 * An OPEN ENFORCED task holding exactly what it reserved, written with raw SQL
 * in ONE transaction — the only shape the database accepts, because the two rows
 * are each other's precondition.
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

/** A SHADOW measurement: no slot, no holds, nothing of the customer's set aside. */
async function measurement(accountId: string, reservedMicro = 40 * MICRO): Promise<string> {
  const id = randomUUID();
  await db()`
    INSERT INTO credit_reservations (id, account_id, agent_session_id, model, rate_card_version,
                                     mode, reserved_micro, lease_owner, lease_expires_at, max_until)
    VALUES (${id}::uuid, ${accountId}::uuid, ${`as_${id}`}, ${ON_CREDITS_MODEL}, 1,
            'shadow', ${String(reservedMicro)}::bigint, ${BOOT},
            now() + interval '90 seconds', now() + interval '30 minutes')`;
  return id;
}

/** One `task_charge` ledger row naming `reservationId`, written with raw SQL. */
function chargeTo(
  accountId: string,
  lotId: string,
  reservationId: string,
  micro: number,
): Promise<unknown> {
  return db()`
    INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key,
                               reservation_id, agent_session_id, model, rate_card_version)
    VALUES (${accountId}::uuid, 'task_charge', ${lotId}::uuid, ${String(-micro)}::bigint,
            ${`charge:${randomUUID()}`}, ${reservationId}::uuid, 'as-raw', ${ON_CREDITS_MODEL}, 1)`;
}

/** Reserve one task the ordinary way, through the service. */
async function reserve(h: ReservationsHarness, accountId: string): Promise<string> {
  const reservationId = randomUUID();
  const result = await h.service.reserve({
    accountId,
    reservationId,
    agentSessionId: `as_${reservationId}`,
    idempotencyKey: null,
    model: ON_CREDITS_MODEL,
    mode: 'enforce',
    bootId: BOOT,
  });
  if (result.outcome !== 'reserved') {
    throw new Error(`the fixture could not reserve: ${JSON.stringify(result)}`);
  }
  return reservationId;
}

/** One admitted, sent call charged its whole bound — the richest settle path. */
async function oneChargedCall(h: ReservationsHarness, reservationId: string): Promise<number> {
  const admitted = await h.service.admitCall({
    reservationId,
    purpose: 'plan',
    model: ON_CREDITS_MODEL,
    bound: BOUND,
    callId: randomUUID(),
  });
  if (admitted.outcome !== 'admitted') {
    throw new Error(`the fixture could not admit a call: ${JSON.stringify(admitted)}`);
  }
  await h.service.markSent(admitted.callId);
  const settled = await h.service.settleCall({ callId: admitted.callId, basis: 'no_record' });
  return settled.chargedMicro;
}

function keeperOn(h: ReservationsHarness, leaseOwner: string): AiCreditLeaseKeeper {
  return new AiCreditLeaseKeeper({
    ledger: h.ledger,
    reservations: h.reservations,
    settler: h.service,
    executor: h.database.db,
    leaseOwner,
  });
}

describe.skipIf(!RUN_DB_TESTS)(
  'a holds-only statement re-checks its task, and a measurement is never charged',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    });

    it('⛔ CRITICAL 0133 a hold inserted BY ITSELF onto an open enforced task is refused at COMMIT, because a holds-only statement now re-checks the task it names. At 0132 this committed, leaving the task reserving 50 credits behind holds of 60 — credit raised on a lot with no path back, and a task no settlement could ever close, because every settlement of it meets this same check', async () => {
      const accountId = await newTaskAccount(db());
      const first = await fundedTaskLot(db(), accountId, { credits: 100 });
      const second = await fundedTaskLot(db(), accountId, { credits: 100 });
      const rid = await taskHolding(accountId, [{ lotId: first, micro: 50 * MICRO }]);

      const refused = await refusal(
        () => db()`
          INSERT INTO credit_reservation_holds (reservation_id, lot_id, account_id, held_micro)
          VALUES (${rid}::uuid, ${second}::uuid, ${accountId}::uuid, ${String(10 * MICRO)}::bigint)`,
        'a second hold inserted on its own',
      );
      // 0131's own message, raised by 0131's own function: the rule is not new,
      // only the leg that reaches it is.
      expect(refused.code).toBe('23514');
      expect(refused.message).toMatch(
        new RegExp(`reservation ${rid} reserves ${50 * MICRO} but holds ${60 * MICRO}`),
      );

      expect(await lotState(db(), second), 'the second lot never held anything').toMatchObject({
        held: 0,
      });
      expect((await lotState(db(), first)).held, 'and the first still holds exactly the task').toBe(
        50 * MICRO,
      );
      expect(await holdRows(db(), rid), 'and the task still has the one hold').toHaveLength(1);
    });

    it('⛔ CRITICAL 0133 the refusal is the RESERVATION’s rule reached from the holds, not a new rule about holds: the very same hold, written in one transaction with a task that reserves it, commits — which is the shape every reserve really uses', async () => {
      const accountId = await newTaskAccount(db());
      const lot = await fundedTaskLot(db(), accountId, { credits: 100 });

      // The same 10 credits the arm above refused, on a task that reserves them.
      const rid = await taskHolding(accountId, [{ lotId: lot, micro: 10 * MICRO }]);
      expect((await reservationCounters(db(), rid)).reservedMicro).toBe(10 * MICRO);
      expect(await lotState(db(), lot)).toMatchObject({ held: 10 * MICRO });

      // And two holds across two lots for one task, also one transaction.
      const other = await fundedTaskLot(db(), accountId, { credits: 100 });
      const split = await taskHolding(accountId, [
        { lotId: lot, micro: 5 * MICRO },
        { lotId: other, micro: 7 * MICRO },
      ]);
      expect(await holdRows(db(), split)).toHaveLength(2);
      expect((await reservationCounters(db(), split)).reservedMicro).toBe(12 * MICRO);
    });

    it('CRITICAL 0133 a holds-only UPDATE that is an honest release still commits, and gives the whole hold back to its lot — the new leg reads the amounts, and a release moves neither of them', async () => {
      const accountId = await newTaskAccount(db());
      const lot = await fundedTaskLot(db(), accountId, { credits: 100 });
      const rid = await taskHolding(accountId, [{ lotId: lot, micro: 20 * MICRO }]);
      expect((await lotState(db(), lot)).held).toBe(20 * MICRO);

      await db()`UPDATE credit_reservation_holds SET released_at = now(), charged_micro = 0
                  WHERE reservation_id = ${rid}::uuid AND lot_id = ${lot}::uuid`;

      expect((await lotState(db(), lot)).held, 'the credit came back').toBe(0);
      expect((await reservationCounters(db(), rid)).state, 'and the task is untouched').toBe(
        'open',
      );
    });

    it('⛔ CRITICAL 0133 a `task_charge` naming a SHADOW task is refused at COMMIT and the lot does not move. At 0132 it committed and took 7 credits off a funded lot: `credit_ledger_apply` moves credit whichever task the row names, and the balance check returned early for a measurement before anything asked whether the ledger had charged it', async () => {
      const accountId = await newTaskAccount(db());
      const lot = await fundedTaskLot(db(), accountId, { credits: 100 });
      const shadow = await measurement(accountId);
      const before = await lotState(db(), lot);

      const refused = await refusal(
        () => chargeTo(accountId, lot, shadow, 7 * MICRO),
        'a task charge naming a measurement',
      );
      expect(refused.code).toBe('23514');
      expect(refused.message).toMatch(
        new RegExp(`shadow reservation ${shadow} is measured, not charged`),
      );

      expect(await lotState(db(), lot), 'the customer paid nothing for being measured').toEqual(
        before,
      );
      expect(await ledgerOf(db(), accountId), 'and only the grant is on the ledger').toEqual([
        { kind: 'grant', lotId: lot, lotDelta: 100 * MICRO, debtDelta: 0 },
      ]);
    });

    it('⛔ CRITICAL 0133 the rule is about the MODE, not about the row being late: a measurement that has already settled still cannot be charged, and an ENFORCED task of the same account still can — the arm that would catch a rule written as “no ledger row after settle”', async () => {
      const accountId = await newTaskAccount(db());
      const lot = await fundedTaskLot(db(), accountId, { credits: 100 });

      const shadow = await measurement(accountId);
      await db()`
        UPDATE credit_reservations
           SET state = 'settled', charged_micro = 0, settled_at = now(), settle_reason = 'completed'
         WHERE id = ${shadow}::uuid`;
      const refused = await refusal(
        () => chargeTo(accountId, lot, shadow, 3 * MICRO),
        'a task charge naming a settled measurement',
      );
      expect(refused.message).toMatch(/is measured, not charged/);

      // The positive control, through the service: an enforced task really is
      // charged this way, and that is the path the rule must not touch.
      const h = harness();
      const enforced = await reserve(h, accountId);
      const charged = await oneChargedCall(h, enforced);
      expect(charged).toBeGreaterThan(0);
      expect((await h.service.settle(enforced, 'completed')).outcome).toBe('settled');
      expect(
        (await ledgerOf(db(), accountId)).filter((r) => r.kind === 'task_charge'),
        'the enforced task paid, out of the lot, by a row naming it',
      ).toEqual([{ kind: 'task_charge', lotId: lot, lotDelta: -charged, debtDelta: 0 }]);
    });

    it('CRITICAL 0133 the ordinary settle still commits and settling twice is still a no-op — a settlement releases its holds, writes its `task_charge` rows and marks its task in one transaction, which is the shape the new leg had to be deferred not to refuse', async () => {
      const h = harness();
      const accountId = await newTaskAccount(db());
      const lot = await fundedTaskLot(db(), accountId, { credits: 100 });
      const rid = await reserve(h, accountId);
      const charged = await oneChargedCall(h, rid);

      const settled = await h.service.settle(rid, 'completed');
      expect(settled.outcome).toBe('settled');
      expect(settled.chargedMicro).toBe(charged);

      const again = await h.service.settle(rid, 'completed');
      expect(again.outcome).toBe('already_settled');
      expect(again.chargedMicro, 'and it reports what the task cost, not zero').toBe(charged);

      expect((await lotState(db(), lot)).held, 'nothing is left held').toBe(0);
      expect((await lotState(db(), lot)).remaining).toBe(100 * MICRO - charged);
      expect((await holdRows(db(), rid))[0]?.chargedMicro).toBe(charged);
    });

    it('CRITICAL 0133 the lease keeper still settles a task nobody came back for — at a lapsed lease and at the hard ceiling — and both write holds, ledger rows and the reservation in one transaction', async () => {
      const h = harness();
      const keeper = keeperOn(h, BOOT);

      // A lapsed lease: what ninety seconds of silence does, written.
      const lapsed = await newTaskAccount(db());
      const lapsedLot = await fundedTaskLot(db(), lapsed, { credits: 100 });
      const lapsedRid = await reserve(h, lapsed);
      const lapsedCharge = await oneChargedCall(h, lapsedRid);
      await db()`UPDATE credit_reservations SET lease_expires_at = now() - interval '1 second'
                  WHERE id = ${lapsedRid}::uuid`;

      // The hard ceiling (M1): a task created 31 minutes ago whose `max_until`
      // has passed, written as a fresh row because both instants are immutable.
      const stuck = await newTaskAccount(db());
      const stuckLot = await fundedTaskLot(db(), stuck, { credits: 100 });
      const stuckRid = await agedReservation(db(), {
        accountId: stuck,
        lotId: stuckLot,
        reservedMicro: 30 * MICRO,
        leaseOwner: BOOT,
      });

      const tick = await keeper.tickOnce();
      expect(tick.settled, 'both tasks were finished').toBeGreaterThanOrEqual(2);

      expect(await reservationCounters(db(), lapsedRid)).toMatchObject({
        state: 'settled',
        chargedMicro: lapsedCharge,
      });
      expect((await lotState(db(), lapsedLot)).held).toBe(0);
      expect((await lotState(db(), lapsedLot)).remaining).toBe(100 * MICRO - lapsedCharge);

      expect(await reservationCounters(db(), stuckRid)).toMatchObject({
        state: 'settled',
        chargedMicro: 0,
      });
      expect(await lotState(db(), stuckLot), 'it made no call, so it cost nothing').toMatchObject({
        held: 0,
        remaining: 100 * MICRO,
      });
    });

    it('CRITICAL 0133 a grant and a refund clawback beside a RUNNING task still commit — neither names a task, so neither queues the check at all, and the task’s holds are exactly where they were', async () => {
      const accountId = await newTaskAccount(db());
      const lot = await fundedTaskLot(db(), accountId, { credits: 100 });
      const rid = await taskHolding(accountId, [{ lotId: lot, micro: 20 * MICRO }]);

      const fresh = await fundedTaskLot(db(), accountId, { credits: 40 });
      await db()`
        INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key)
        VALUES (${accountId}::uuid, 'refund_clawback', ${lot}::uuid,
                ${String(-5 * MICRO)}::bigint, ${`refund:${randomUUID()}`})`;

      expect((await lotState(db(), lot)).remaining, 'the refund took five credits back').toBe(
        95 * MICRO,
      );
      expect((await lotState(db(), lot)).held, 'and the running task still holds its twenty').toBe(
        20 * MICRO,
      );
      expect((await lotState(db(), fresh)).remaining, 'and the new grant landed').toBe(40 * MICRO);
      expect((await reservationCounters(db(), rid)).state).toBe('open');
    });
  },
);
