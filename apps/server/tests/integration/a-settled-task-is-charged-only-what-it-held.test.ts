// A task pays for what its calls cost, out of the credit it was holding, and
// what it did not use goes where it belongs.
//
// The settlement is the half that decides what a customer is actually billed, so
// every claim here is measured against the ledger rather than against the
// service's return value:
//
//   · a task that made no call is charged NOTHING, and every credit it held
//     comes back;
//   · a task settled with a call still IN FLIGHT pays that call's whole bound —
//     §5.3 calls the crash the main path, and this is what it costs — while a
//     call whose request never LEFT this process is charged nothing;
//   · settling twice charges once — the second settlement finds the task
//     already settled and writes nothing;
//   · credit held on a lot whose month has ENDED, or that was REVOKED while the
//     task ran, pays for that task and then leaves; it does not reappear as a
//     spendable balance the customer never earned;
//   · a clawback still owed credit that a running task was holding is paid
//     FIRST, oldest first, out of what the task releases (M5) — and each claim
//     is paid once, never twice over;
//   · a claim nothing is left to pay becomes debt, but only once the account has
//     no other task that might still release credit for it;
//   · an account never ends a transaction holding debt beside credit a release
//     just freed — the database refuses it, and the settlement repays instead.
//
// The COMMIT-time balance check is proved by forging the numbers with raw SQL:
// a settled enforced task whose charge does not equal its calls, its holds and
// its ledger rows is refused by the database itself.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { refusal } from './_helpers/database-refusal.js';
import {
  MICRO,
  ON_CREDITS_MODEL,
  debtMicroOf,
  fundedTaskLot,
  ledgerOf,
  lotState,
  modelCallRow,
  newTaskAccount,
  reservationsHarness,
  settledCall,
  startedCall,
  waitUntilExpired,
  type ReservationsHarness,
} from './_helpers/credit-reservation-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_settle';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const BOOT = 'boot-settle';
/** The launch card's smallest model: 30 credits at most per task. */
const SMALL_MODEL = 'claude-haiku-4-5';

let client: postgres.Sql | null = null;
let url: string | null = null;
const opened: Database[] = [];

beforeAll(async () => {
  if (!RUN_DB_TESTS) return;
  const db = await openLedgerDatabase(ISOLATED_DB_NAME, 4);
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

function harness(): ReservationsHarness {
  if (url === null) throw new Error('isolated database unreachable');
  const h = reservationsHarness(url, { max: 2 });
  opened.push(h.database);
  return h;
}

function reserveInput(accountId: string, over: Record<string, unknown> = {}) {
  return {
    accountId,
    reservationId: randomUUID(),
    agentSessionId: `as_${randomUUID()}`,
    idempotencyKey: null,
    model: ON_CREDITS_MODEL,
    mode: 'enforce' as const,
    bootId: BOOT,
    ...over,
  };
}

/** A clawback of `credits`, recorded against the account's only window. */
async function clawBack(
  h: ReservationsHarness,
  accountId: string,
  credits: number,
  ref: string,
): Promise<{ pendingMicro: number; debtMicro: number; clawedMicro: number }> {
  const [row] = await db()<Array<{ id: string }>>`
    SELECT id FROM credit_windows WHERE account_id = ${accountId}::uuid LIMIT 1`;
  if (row === undefined) throw new Error('the account has no window to claw from');
  const grants = new (await import('../../src/services/credit-grants.js')).CreditGrantsService({
    ledger: h.ledger,
    windows: h.windows,
  });
  const record = await h.ledger.transaction((tx) =>
    grants.clawBack(tx, accountId, {
      source: 'plan_change',
      sourceRef: ref,
      targetKey: `window:${row.id}`,
      windowId: row.id,
      amountMicro: credits * MICRO,
      ledgerKind: 'proration_clawback',
      debtReason: 'plan_change',
    }),
  );
  return {
    pendingMicro: record.pendingMicro,
    debtMicro: record.debtMicro ?? 0,
    clawedMicro: record.clawedMicro ?? 0,
  };
}

describe.skipIf(!RUN_DB_TESTS)('a settled task is charged only what it held', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(client, 'isolated Postgres database could not be created or reached').not.toBeNull();
    expect(url).not.toBeNull();
  });

  it('CRITICAL a task that made no call is charged NOTHING: every hold is released for zero, the lot is whole again, and the ledger records no charge at all', async () => {
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { credits: 20 });
    const h = harness();
    const input = reserveInput(accountId);
    expect((await h.service.reserve(input)).outcome).toBe('reserved');
    expect(await lotState(db(), lot)).toEqual({ remaining: 20 * MICRO, held: 20 * MICRO });

    const settled = await h.service.settle(input.reservationId, 'completed');
    expect(settled).toMatchObject({ outcome: 'settled', chargedMicro: 0, charges: [] });
    expect(await lotState(db(), lot), 'the whole hold comes back').toEqual({
      remaining: 20 * MICRO,
      held: 0,
    });
    expect(
      (await ledgerOf(db(), accountId)).filter((r) => r.kind !== 'grant'),
      'no movement beyond the original grant',
    ).toEqual([]);
    expect(await h.ledger.spendableMicro(accountId)).toBe(20 * MICRO);
  });

  it('⛔ CRITICAL a task settled while a call is STILL IN FLIGHT pays that call its whole bound, recorded as `no_record` — §5.3 makes the crash the main path, and without this step the settlement cannot commit at all', async () => {
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { credits: 50 });
    const h = harness();
    const input = reserveInput(accountId);
    expect((await h.service.reserve(input)).outcome).toBe('reserved');

    // The shape a crash leaves behind: the request went out and the process
    // that would have recorded what it cost is gone. Nothing will ever fill in
    // `charged_micro`, and the keeper settles the task around it.
    const inFlight = await startedCall(db(), {
      reservationId: input.reservationId,
      accountId,
      boundMicro: 9 * MICRO,
      sent: true,
    });

    const settled = await h.service.settle(input.reservationId, 'lease_expired');
    expect(settled).toMatchObject({ outcome: 'settled', chargedMicro: 9 * MICRO });
    expect(settled.charges, 'the bound comes out of the lot the task held').toEqual([
      { lotId: lot, micro: 9 * MICRO },
    ]);
    expect(
      await modelCallRow(db(), inFlight),
      'the call itself is settled as no_record at EXACTLY its bound, which is what the ' +
        'database requires of that basis',
    ).toEqual({
      state: 'settled',
      settleBasis: 'no_record',
      chargedMicro: 9 * MICRO,
      boundMicro: 9 * MICRO,
    });
    expect(await lotState(db(), lot)).toEqual({ remaining: 41 * MICRO, held: 0 });
    expect(
      (await ledgerOf(db(), accountId)).filter((r) => r.kind === 'task_charge'),
      'and the ledger carries the same number',
    ).toEqual([{ kind: 'task_charge', lotId: lot, lotDelta: -9 * MICRO, debtDelta: 0 }]);

    // The positive control, and what makes this arm about IN-FLIGHT calls
    // rather than about always charging the bound: a call that DID record what
    // it cost is charged that, not its ceiling.
    const second = reserveInput(accountId);
    expect((await h.service.reserve(second)).outcome).toBe('reserved');
    await settledCall(db(), {
      reservationId: second.reservationId,
      accountId,
      chargedMicro: 3 * MICRO,
      boundMicro: 9 * MICRO,
    });
    expect(await h.service.settle(second.reservationId, 'completed')).toMatchObject({
      outcome: 'settled',
      chargedMicro: 3 * MICRO,
    });
  });

  it('⛔ CRITICAL a call whose request NEVER LEFT this process is charged NOTHING when the task is settled around it (§5.3) — the ceiling of a request nobody made is not the customer’s to pay, and `sent` is the recorded fact that says so', async () => {
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { credits: 50 });
    const h = harness();
    const input = reserveInput(accountId);
    expect((await h.service.reserve(input)).outcome).toBe('reserved');

    // Two calls, one of each kind, on ONE task — so the arm compares them
    // against each other rather than against a remembered number.
    const wentOut = await startedCall(db(), {
      reservationId: input.reservationId,
      accountId,
      seq: 1,
      boundMicro: 9 * MICRO,
      sent: true,
    });
    const neverLeft = await startedCall(db(), {
      reservationId: input.reservationId,
      accountId,
      seq: 2,
      boundMicro: 12 * MICRO,
      sent: false,
    });

    const settled = await h.service.settle(input.reservationId, 'max_age');
    expect(
      settled,
      'the task pays for the one that went out and nothing for the one that did not',
    ).toMatchObject({ outcome: 'settled', chargedMicro: 9 * MICRO });
    expect(await modelCallRow(db(), wentOut)).toEqual({
      state: 'settled',
      settleBasis: 'no_record',
      chargedMicro: 9 * MICRO,
      boundMicro: 9 * MICRO,
    });
    expect(await modelCallRow(db(), neverLeft)).toEqual({
      state: 'settled',
      settleBasis: 'never_sent',
      chargedMicro: 0,
      boundMicro: 12 * MICRO,
    });
    // And the reservation's own counter followed the calls down, which is what
    // lets the settlement commit at all: a started call commits its bound, a
    // settled one its charge, and the COMMIT-time check compares the two.
    const [row] = await db()<Array<{ committed: string; charged: string }>>`
      SELECT committed_micro::text AS committed, charged_micro::text AS charged
        FROM credit_reservations WHERE id = ${input.reservationId}::uuid`;
    expect(row).toEqual({ committed: String(9 * MICRO), charged: String(9 * MICRO) });
    expect(await lotState(db(), lot), 'only the 9 credits that went out are gone').toEqual({
      remaining: 41 * MICRO,
      held: 0,
    });
    expect((await ledgerOf(db(), accountId)).filter((r) => r.kind === 'task_charge')).toEqual([
      { kind: 'task_charge', lotId: lot, lotDelta: -9 * MICRO, debtDelta: 0 },
    ]);
  });

  it('CRITICAL a task is charged exactly what its calls cost, out of the lots it held, and settling it AGAIN charges once', async () => {
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { credits: 50 });
    const h = harness();
    const input = reserveInput(accountId);
    const reserved = await h.service.reserve(input);
    expect(reserved.outcome).toBe('reserved');
    await settledCall(db(), {
      reservationId: input.reservationId,
      accountId,
      chargedMicro: 7 * MICRO,
    });

    const first = await h.service.settle(input.reservationId, 'completed');
    expect(first).toMatchObject({ outcome: 'settled', chargedMicro: 7 * MICRO });
    expect(first.charges).toEqual([{ lotId: lot, micro: 7 * MICRO }]);
    expect(await lotState(db(), lot)).toEqual({ remaining: 43 * MICRO, held: 0 });

    const charges = (await ledgerOf(db(), accountId)).filter((r) => r.kind === 'task_charge');
    expect(charges).toEqual([
      { kind: 'task_charge', lotId: lot, lotDelta: -7 * MICRO, debtDelta: 0 },
    ]);
    const [context] = await db()<Array<{ reservation_id: string; model: string; v: number }>>`
      SELECT reservation_id, model, rate_card_version AS v FROM credit_ledger
       WHERE account_id = ${accountId}::uuid AND kind = 'task_charge'`;
    expect(context, 'the charge names the task, the model and the card it was priced at').toEqual({
      reservation_id: input.reservationId,
      model: ON_CREDITS_MODEL,
      v: 1,
    });

    const second = await h.service.settle(input.reservationId, 'lease_expired');
    expect(
      second,
      'a late settle after a keeper settle is a no-op, and says what it cost',
    ).toMatchObject({ outcome: 'already_settled', chargedMicro: 7 * MICRO, charges: [] });
    expect(await lotState(db(), lot), 'and nothing moved').toEqual({
      remaining: 43 * MICRO,
      held: 0,
    });
    expect(
      (await ledgerOf(db(), accountId)).filter((r) => r.kind === 'task_charge'),
      'exactly one charge',
    ).toHaveLength(1);
  });

  it('⛔ CRITICAL a task is charged in SPEND ORDER, so what it pays with is the credit that would have expired first — credit released back to the customer is the credit that lasts longest', async () => {
    const accountId = await newTaskAccount(db());
    // Same rank, different terms: the reserve holds the soonest-expiring first,
    // and the settlement must SPEND that same one first. Charging the other way
    // round would hand the customer back credit that expires in two days and
    // spend the credit that would have lasted a month — a silent loss at every
    // month boundary, and nothing about the totals would look wrong.
    const soon = await fundedTaskLot(db(), accountId, {
      credits: 30,
      expires: "now() + interval '2 days'",
    });
    const later = await fundedTaskLot(db(), accountId, {
      credits: 30,
      expires: "now() + interval '30 days'",
    });
    const h = harness();
    const input = reserveInput(accountId);
    const reserved = await h.service.reserve(input);
    expect(reserved).toMatchObject({ outcome: 'reserved', reservedMicro: 60 * MICRO });
    expect(await lotState(db(), soon)).toEqual({ remaining: 30 * MICRO, held: 30 * MICRO });
    expect(await lotState(db(), later)).toEqual({ remaining: 30 * MICRO, held: 30 * MICRO });

    await settledCall(db(), {
      reservationId: input.reservationId,
      accountId,
      chargedMicro: 10 * MICRO,
    });
    const settled = await h.service.settle(input.reservationId, 'completed');
    expect(settled).toMatchObject({ outcome: 'settled', chargedMicro: 10 * MICRO });
    expect(settled.charges, 'the whole charge comes out of the lot that expires first').toEqual([
      { lotId: soon, micro: 10 * MICRO },
    ]);
    expect(await lotState(db(), soon)).toEqual({ remaining: 20 * MICRO, held: 0 });
    expect(await lotState(db(), later), 'the durable credit is untouched').toEqual({
      remaining: 30 * MICRO,
      held: 0,
    });
    expect(
      (await ledgerOf(db(), accountId)).filter((r) => r.kind === 'task_charge'),
      'one charge, on the soonest-expiring lot',
    ).toEqual([{ kind: 'task_charge', lotId: soon, lotDelta: -10 * MICRO, debtDelta: 0 }]);
  });

  it('CRITICAL credit held on a lot that was REVOKED while the task ran pays for the task and then leaves — it does not come back as a balance the customer never earned', async () => {
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { credits: 30 });
    const h = harness();
    const input = reserveInput(accountId);
    expect((await h.service.reserve(input)).outcome).toBe('reserved');
    await settledCall(db(), {
      reservationId: input.reservationId,
      accountId,
      chargedMicro: 4 * MICRO,
    });
    await db()`UPDATE credit_lots SET revoked_at = now() WHERE id = ${lot}::uuid`;

    const settled = await h.service.settle(input.reservationId, 'completed');
    expect(settled.chargedMicro).toBe(4 * MICRO);
    expect(await lotState(db(), lot), 'charged 4, and the other 26 expired out').toEqual({
      remaining: 0,
      held: 0,
    });
    const kinds = (await ledgerOf(db(), accountId)).map((r) => `${r.kind}:${String(r.lotDelta)}`);
    expect(kinds).toEqual([
      `grant:${String(30 * MICRO)}`,
      `task_charge:${String(-4 * MICRO)}`,
      `expiry:${String(-26 * MICRO)}`,
    ]);
    expect(await h.ledger.spendableMicro(accountId)).toBe(0);
  });

  it('CRITICAL credit held on a lot whose MONTH ENDED while the task ran does the same — the task crossing a reset is paid for by what it held, and the rest expires', async () => {
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, {
      credits: 30,
      expires: "now() + interval '3 seconds'",
    });
    const h = harness();
    const input = reserveInput(accountId);
    expect(
      (await h.service.reserve(input)).outcome,
      'the lot must still be live when the task reserves — if this fails the machine was too slow, not the rule',
    ).toBe('reserved');
    await settledCall(db(), {
      reservationId: input.reservationId,
      accountId,
      chargedMicro: 11 * MICRO,
    });
    // No timing margin: wait until the DATABASE says the term has ended.
    await waitUntilExpired(db(), lot);

    const settled = await h.service.settle(input.reservationId, 'max_age');
    expect(settled.chargedMicro).toBe(11 * MICRO);
    expect(await lotState(db(), lot)).toEqual({ remaining: 0, held: 0 });
    expect((await ledgerOf(db(), accountId)).map((r) => r.kind)).toEqual([
      'grant',
      'task_charge',
      'expiry',
    ]);
  }, 20_000);

  it('CRITICAL a clawback still owed credit a running task holds is paid FIRST out of what that task releases (M5), and the claim is then settled to zero', async () => {
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { kind: 'monthly', credits: 30 });
    const h = harness();
    const input = reserveInput(accountId);
    expect((await h.service.reserve(input)).outcome).toBe('reserved');

    // Everything is held, so the clawback can take nothing now and records a
    // claim against the credit the task is holding.
    const claw = await clawBack(h, accountId, 20, 'ref-1');
    expect(claw).toMatchObject({ clawedMicro: 0, pendingMicro: 20 * MICRO, debtMicro: 0 });

    const settled = await h.service.settle(input.reservationId, 'completed');
    expect(settled).toMatchObject({
      outcome: 'settled',
      chargedMicro: 0,
      claimsPaidMicro: 20 * MICRO,
      claimsToDebtMicro: 0,
    });
    expect(await lotState(db(), lot), 'the claim took its 20 out of the released 30').toEqual({
      remaining: 10 * MICRO,
      held: 0,
    });
    expect(
      await db()`SELECT pending_micro::text AS n FROM credit_clawbacks
                  WHERE account_id = ${accountId}::uuid`,
    ).toEqual([{ n: '0' }]);
    expect(await debtMicroOf(db(), accountId), 'and none of it became debt').toBe(0);
  });

  it('⛔ CRITICAL TWO clawbacks landing while ONE task runs are never both backed by the same held credit: the second asks only for what the first has not already claimed', async () => {
    const accountId = await newTaskAccount(db());
    await fundedTaskLot(db(), accountId, { kind: 'monthly', credits: 30 });
    const h = harness();
    const input = reserveInput(accountId);
    expect((await h.service.reserve(input)).outcome).toBe('reserved');

    const first = await clawBack(h, accountId, 20, 'ref-a');
    expect(first).toMatchObject({ pendingMicro: 20 * MICRO, debtMicro: 0 });

    // 30 credits are held and 20 of them are already claimed, so only 10 are
    // left to claim. The other 10 of this clawback is debt NOW, not a second
    // claim over credit the first clawback is already counting on.
    const second = await clawBack(h, accountId, 20, 'ref-b');
    expect(second).toMatchObject({ pendingMicro: 10 * MICRO, debtMicro: 10 * MICRO });

    const [claims] = await db()<Array<{ n: string }>>`
      SELECT COALESCE(SUM(pending_micro), 0)::text AS n FROM credit_clawbacks
       WHERE account_id = ${accountId}::uuid`;
    expect(Number(claims?.n), 'the claims standing never exceed the credit that can pay them').toBe(
      30 * MICRO,
    );

    // And the settlement pays both, once each, out of the 30 it releases.
    const settled = await h.service.settle(input.reservationId, 'completed');
    expect(settled.claimsPaidMicro).toBe(30 * MICRO);
    expect(
      await db()`SELECT DISTINCT pending_micro::text AS n FROM credit_clawbacks
                  WHERE account_id = ${accountId}::uuid`,
    ).toEqual([{ n: '0' }]);
    expect(await debtMicroOf(db(), accountId), 'the 10 recorded as debt stands').toBe(10 * MICRO);
  });

  it('CRITICAL a claim the released credit cannot cover becomes DEBT — but only once the account has no other task that might still release credit for it', async () => {
    const accountId = await newTaskAccount(db());
    await fundedTaskLot(db(), accountId, { kind: 'monthly', credits: 30 });
    await fundedTaskLot(db(), accountId, { kind: 'top_up', credits: 30 });
    const h = harness();
    // Haiku, whose maximum is 30 credits, so the two tasks take a lot each.
    const one = reserveInput(accountId, { model: SMALL_MODEL });
    const two = reserveInput(accountId, { model: SMALL_MODEL });
    expect((await h.service.reserve(one)).outcome).toBe('reserved');
    expect((await h.service.reserve(two)).outcome).toBe('reserved');

    const claw = await clawBack(h, accountId, 25, 'ref-c');
    expect(claw.pendingMicro).toBe(25 * MICRO);

    // The first task spends everything it held, so it can pay nothing — and the
    // claim does NOT become debt, because the second task is still running.
    await settledCall(db(), {
      reservationId: one.reservationId,
      accountId,
      chargedMicro: 30 * MICRO,
    });
    const firstSettle = await h.service.settle(one.reservationId, 'completed');
    expect(firstSettle).toMatchObject({ claimsPaidMicro: 0, claimsToDebtMicro: 0 });
    expect(await debtMicroOf(db(), accountId), 'nothing is owed yet').toBe(0);

    // The second spends everything too. Now nothing is left to release, and the
    // claim is recorded as debt with the reason of the clawback that made it.
    await settledCall(db(), {
      reservationId: two.reservationId,
      accountId,
      chargedMicro: 30 * MICRO,
    });
    const secondSettle = await h.service.settle(two.reservationId, 'completed');
    expect(secondSettle).toMatchObject({ claimsPaidMicro: 0, claimsToDebtMicro: 25 * MICRO });
    expect(await debtMicroOf(db(), accountId)).toBe(25 * MICRO);
    const debtRow = (await ledgerOf(db(), accountId)).find((r) => r.kind === 'debt_incurred');
    expect(debtRow).toMatchObject({ debtDelta: 25 * MICRO });
    const [reason] = await db()<Array<{ reason: string }>>`
      SELECT reason FROM credit_ledger
       WHERE account_id = ${accountId}::uuid AND kind = 'debt_incurred'`;
    expect(reason).toEqual({ reason: 'plan_change' });
  });

  it('CRITICAL an account never ends a transaction holding debt beside credit a release just freed: the settlement repays it, and a raw release that does not is refused at COMMIT', async () => {
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { credits: 30 });
    const h = harness();
    const input = reserveInput(accountId);
    expect((await h.service.reserve(input)).outcome).toBe('reserved');
    // Debt is legal here only because every credit is held: nothing is spendable.
    await db()`
      INSERT INTO credit_ledger (account_id, kind, lot_delta_micro, debt_delta_micro,
                                 idempotency_key, reason)
      VALUES (${accountId}::uuid, 'debt_incurred', 0, ${String(4 * MICRO)}::bigint,
              'debt:held', 'payment_reversed')`;
    expect(await debtMicroOf(db(), accountId)).toBe(4 * MICRO);

    // A raw release, with nothing repaid, is refused BY THE DEFERRED CHECK.
    const refused = await refusal(
      () =>
        db().begin(async (tx) => {
          await tx`UPDATE credit_reservation_holds SET released_at = now(), charged_micro = 0
                  WHERE reservation_id = ${input.reservationId}::uuid`;
        }),
      'a release that frees credit beside debt',
    );
    expect(refused).toMatchObject({ code: '23514', constraint: 'credit_holds_debt_vs_free' });
    expect(await lotState(db(), lot), 'the transaction rolled back whole').toEqual({
      remaining: 30 * MICRO,
      held: 30 * MICRO,
    });

    // The settlement does the same release and repays in the same transaction,
    // so it commits.
    const settled = await h.service.settle(input.reservationId, 'completed');
    expect(settled.outcome).toBe('settled');
    expect(await debtMicroOf(db(), accountId), 'the debt is paid from what was freed').toBe(0);
    expect(await lotState(db(), lot)).toEqual({ remaining: 26 * MICRO, held: 0 });
  });

  it('CRITICAL a settled enforced task must BALANCE across its calls, its holds and its ledger rows — forged numbers are refused by the database at COMMIT', async () => {
    const accountId = await newTaskAccount(db());
    await fundedTaskLot(db(), accountId, { credits: 30 });
    const h = harness();
    const input = reserveInput(accountId);
    expect((await h.service.reserve(input)).outcome).toBe('reserved');

    await settledCall(db(), {
      reservationId: input.reservationId,
      accountId,
      chargedMicro: 5 * MICRO,
    });

    // ⛔ EVERY STATEMENT ON THE TRANSACTION'S OWN HANDLE. Written against the
    // pool instead, each would autocommit on a different connection: the first
    // "refused" transaction would leave its release committed, and the arms
    // after it would be measuring a hold that had already been released once.
    // (Measured, the first time this arm was written that way.)
    const settleTo = (tx: postgres.TransactionSql, charged: number) => tx`
      UPDATE credit_reservations
         SET state = 'settled', charged_micro = ${String(charged)}::bigint,
             settled_at = now(), settle_reason = 'admin'
       WHERE id = ${input.reservationId}::uuid`;
    const releaseFor = (tx: postgres.TransactionSql, charged: number) => tx`
      UPDATE credit_reservation_holds
         SET released_at = now(), charged_micro = ${String(charged)}::bigint
       WHERE reservation_id = ${input.reservationId}::uuid`;
    const chargeRow = (tx: postgres.TransactionSql) => tx`
      INSERT INTO credit_ledger (account_id, kind, lot_id, lot_delta_micro, idempotency_key,
                                 reservation_id, rate_card_version, model)
      SELECT ${accountId}::uuid, 'task_charge', h.lot_id, ${String(-5 * MICRO)}::bigint,
             'forged-charge', ${input.reservationId}::uuid, 1, ${ON_CREDITS_MODEL}
        FROM credit_reservation_holds h WHERE h.reservation_id = ${input.reservationId}::uuid`;

    // Each leg on its own. The calls agree in all three, so the refusals below
    // are the HOLDS and the LEDGER, one at a time.
    const holdsDisagree = await refusal(
      () =>
        db().begin(async (tx) => {
          await releaseFor(tx, 0);
          await settleTo(tx, 5 * MICRO);
        }),
      'a settled task whose holds gave up less than it charged',
    );
    expect(holdsDisagree.code).toBe('23514');
    expect(holdsDisagree.message).toMatch(/does not balance/);

    const ledgerDisagrees = await refusal(
      () =>
        db().begin(async (tx) => {
          await releaseFor(tx, 5 * MICRO);
          await settleTo(tx, 5 * MICRO);
        }),
      'a settled task with no task_charge row behind its charge',
    );
    expect(ledgerDisagrees.code).toBe('23514');
    expect(ledgerDisagrees.message).toMatch(/does not balance/);

    // The control: all three legs agreeing is accepted, so the refusals above
    // are the arithmetic and not the shape of the statements.
    await db().begin(async (tx) => {
      await releaseFor(tx, 5 * MICRO);
      await chargeRow(tx);
      await settleTo(tx, 5 * MICRO);
    });
    const [row] = await db()<Array<{ state: string }>>`
      SELECT state FROM credit_reservations WHERE id = ${input.reservationId}::uuid`;
    expect(row).toEqual({ state: 'settled' });
  });

  it('CRITICAL settling a task that does not exist, or one of an account that does not, is an answer and not an exception', async () => {
    const h = harness();
    expect(await h.service.settle(randomUUID(), 'completed')).toMatchObject({
      outcome: 'unknown',
      chargedMicro: 0,
    });
  });

  it('CRITICAL a SHADOW task settles its calls and touches no balance at all', async () => {
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { credits: 30 });
    const h = harness();
    const input = reserveInput(accountId, { mode: 'shadow' });
    expect((await h.service.reserve(input)).outcome).toBe('shadowed');
    await settledCall(db(), {
      reservationId: input.reservationId,
      accountId,
      chargedMicro: 9 * MICRO,
    });

    const settled = await h.service.settle(input.reservationId, 'completed');
    expect(settled).toMatchObject({ outcome: 'settled', chargedMicro: 9 * MICRO, charges: [] });
    expect(await lotState(db(), lot), 'the balance is exactly as it was').toEqual({
      remaining: 30 * MICRO,
      held: 0,
    });
    expect(
      (await ledgerOf(db(), accountId)).filter((r) => r.kind !== 'grant'),
      'and no movement was written',
    ).toEqual([]);
  });
});
