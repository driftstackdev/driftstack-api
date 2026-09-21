// A settled task and the calls it made are one number, told three ways (§5.1).
//
// The reservation's `charged_micro`, the sum of its calls' charges, and the sum
// of the `task_charge` ledger rows it wrote are three independent records of the
// same thing, kept by three different mechanisms. This file drives real
// reservations, real admitted calls and real settlements and then asks all three
// separately — because two records that are written by one statement agree by
// construction and prove nothing.
//
// The four claims that are not about arithmetic:
//
//   · A TASK THAT CROSSES A MONTH RESET IS PAID FOR BY WHAT IT HELD. The credit
//     set aside when it began pays for it even after that month has ended, and
//     the new month's credit is not touched.
//   · A DOWNGRADE MID-TASK IS PAID FROM WHAT THAT TASK RELEASES, AND ONLY THE
//     REMAINDER BECOMES DEBT (M5). S6 proved the claim is RECORDED; this proves
//     what happens when the task it was recorded against finishes — against real
//     reservations and real calls, which is the proof S6 deferred.
//   · SETTLING TWICE CHARGES ONCE, including two connections racing.
//   · THE DATABASE REFUSES THE TWO OVERDRAWS DIRECTLY. A charge above its hold
//     and a hold above its lot are refused by CHECKs, asked here with raw SQL
//     rather than through the code that would have stopped them first.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ModelCallTokens } from '@driftstack/api-types';
import type { Database } from '../../src/db/client.js';
import type { CreditCallBound } from '../../src/db/credit-reservations-repo.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { refusal } from './_helpers/database-refusal.js';
import {
  MICRO,
  ON_CREDITS_MODEL,
  debtMicroOf,
  fundedTaskLot,
  ledgerOf,
  lotState,
  modelCallRows,
  newTaskAccount,
  reservationsHarness,
  waitUntilExpired,
  type ReservationsHarness,
} from './_helpers/credit-reservation-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_call_settle';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const BOOT = 'boot-call-settle';
/** The launch card's smallest model: 30 credits at most per task, 1,000 µcr an output token. */
const SMALL_MODEL = 'claude-haiku-4-5';

/** A Sonnet call's bound at the full plan ceiling over a 1,500-byte body. */
const INPUT_MICRO = 1_000 * 800 + 500 * 400 + 2_048 * 800; // 2,638,400
const BOUND_MICRO = INPUT_MICRO + 8_192 * 2_000; // 19,022,400
const BOUND: CreditCallBound = {
  inputBoundTokens: 3_548,
  inputBoundMicro: INPUT_MICRO,
  maxOutputTokens: 8_192,
  boundMicro: BOUND_MICRO,
  basis: 'region_bytes',
};

/** What the provider reported for a finished Sonnet call: 3,880,000 µcr. */
const REPORTED: ModelCallTokens = {
  uncachedInput: 1_000,
  output: 500,
  cacheRead: 2_000,
  cacheWrite5m: 0,
  cacheWrite1h: 3_000,
};
const REPORTED_MICRO = 3_880_000;

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

function harness(max = 2): ReservationsHarness {
  if (url === null) throw new Error('isolated database unreachable');
  const h = reservationsHarness(url, { max });
  opened.push(h.database);
  return h;
}

async function reserve(
  h: ReservationsHarness,
  accountId: string,
  model = ON_CREDITS_MODEL,
): Promise<{ reservationId: string; reservedMicro: number }> {
  const reservationId = randomUUID();
  const result = await h.service.reserve({
    accountId,
    reservationId,
    agentSessionId: `as_${reservationId}`,
    idempotencyKey: null,
    model,
    mode: 'enforce',
    bootId: BOOT,
  });
  if (result.outcome !== 'reserved') {
    throw new Error(`the fixture could not reserve: ${JSON.stringify(result)}`);
  }
  return { reservationId, reservedMicro: result.reservedMicro };
}

/** Admit one call, send it, and settle it — the whole per-attempt cycle. */
async function madeCall(
  h: ReservationsHarness,
  input: {
    readonly reservationId: string;
    readonly model?: string;
    readonly bound?: CreditCallBound;
    readonly basis: 'provider_usage' | 'provider_rejected' | 'no_record' | 'partial_usage';
    readonly usage?: ModelCallTokens;
    readonly send?: boolean;
  },
): Promise<number> {
  const admitted = await h.service.admitCall({
    reservationId: input.reservationId,
    purpose: 'plan',
    model: input.model ?? ON_CREDITS_MODEL,
    bound: input.bound ?? BOUND,
    callId: randomUUID(),
  });
  if (admitted.outcome !== 'admitted') {
    throw new Error(`the fixture could not admit a call: ${JSON.stringify(admitted)}`);
  }
  if (input.send !== false) await h.service.markSent(admitted.callId);
  const settled = await h.service.settleCall({
    callId: admitted.callId,
    basis: input.basis,
    ...(input.usage === undefined ? {} : { usage: input.usage }),
  });
  if (settled.outcome !== 'settled') {
    throw new Error(`the fixture could not settle a call: ${JSON.stringify(settled)}`);
  }
  return settled.chargedMicro;
}

/** A clawback of `credits` against the account's only window — a downgrade landing. */
async function clawBack(
  h: ReservationsHarness,
  accountId: string,
  credits: number,
  ref: string,
): Promise<{ id: string; pendingMicro: number; debtMicro: number; clawedMicro: number }> {
  const [window] = await db()<Array<{ id: string }>>`
    SELECT id FROM credit_windows WHERE account_id = ${accountId}::uuid LIMIT 1`;
  if (window === undefined) throw new Error('the account has no window to claw from');
  const { CreditGrantsService } = await import('../../src/services/credit-grants.js');
  const grants = new CreditGrantsService({ ledger: h.ledger, windows: h.windows });
  const record = await h.ledger.transaction((tx) =>
    grants.clawBack(tx, accountId, {
      source: 'plan_change',
      sourceRef: ref,
      targetKey: `window:${window.id}`,
      windowId: window.id,
      amountMicro: credits * MICRO,
      ledgerKind: 'proration_clawback',
      debtReason: 'plan_change',
    }),
  );
  return {
    id: record.id,
    pendingMicro: record.pendingMicro,
    debtMicro: record.debtMicro,
    clawedMicro: record.clawedMicro,
  };
}

/** Every ledger row of an account with its idempotency key, oldest first. */
async function keyedLedgerOf(
  accountId: string,
): Promise<{ kind: string; key: string; lotDelta: number; debtDelta: number }[]> {
  const rows = await db()<Array<Record<string, string>>>`
    SELECT kind, idempotency_key, lot_delta_micro::text AS lot, debt_delta_micro::text AS debt
      FROM credit_ledger WHERE account_id = ${accountId}::uuid ORDER BY id`;
  return rows.map((r) => ({
    kind: String(r.kind),
    key: String(r.idempotency_key),
    lotDelta: Number(r.lot),
    debtDelta: Number(r.debt),
  }));
}

/** The three records of one task's charge, each read on its own. */
async function threeRecordsOf(
  reservationId: string,
): Promise<{ onTheTask: number; overItsCalls: number; inTheLedger: number; rows: number }> {
  const [task] = await db()<Array<{ n: string | null }>>`
    SELECT charged_micro::text AS n FROM credit_reservations WHERE id = ${reservationId}::uuid`;
  const [calls] = await db()<Array<{ n: string }>>`
    SELECT COALESCE(SUM(charged_micro), 0)::text AS n FROM credit_model_calls
     WHERE reservation_id = ${reservationId}::uuid`;
  const [ledger] = await db()<Array<{ n: string; c: string }>>`
    SELECT COALESCE(-SUM(lot_delta_micro), 0)::text AS n, count(*)::text AS c
      FROM credit_ledger
     WHERE reservation_id = ${reservationId}::uuid AND kind = 'task_charge'`;
  return {
    onTheTask: Number(task?.n ?? -1),
    overItsCalls: Number(calls?.n ?? -1),
    inTheLedger: Number(ledger?.n ?? -1),
    rows: Number(ledger?.c ?? -1),
  };
}

describe.skipIf(!RUN_DB_TESTS)('a task pays for every call it made out of what it held', () => {
  it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
    expect(client, 'Postgres is up but the isolated database could not be prepared').not.toBeNull();
  });

  it('⛔ CRITICAL the sum of a task’s `task_charge` rows equals the sum of its calls’ charges and the charge on the task itself — three records kept by three mechanisms, read three separate times, across two lots and three different settlement bases', async () => {
    const h = harness();
    const accountId = await newTaskAccount(db());
    const monthly = await fundedTaskLot(db(), accountId, { kind: 'monthly', credits: 20 });
    const topUp = await fundedTaskLot(db(), accountId, { kind: 'top_up', credits: 20 });
    const { reservationId, reservedMicro } = await reserve(h, accountId);
    expect(reservedMicro, 'the task is backed by both lots').toBe(40 * MICRO);

    const one = await madeCall(h, { reservationId, basis: 'provider_usage', usage: REPORTED });
    const two = await madeCall(h, { reservationId, basis: 'provider_rejected' });
    const three = await madeCall(h, { reservationId, basis: 'no_record' });
    expect([one, two, three]).toEqual([REPORTED_MICRO, 0, BOUND_MICRO]);

    const settled = await h.service.settle(reservationId, 'completed');
    expect(settled.chargedMicro).toBe(REPORTED_MICRO + BOUND_MICRO);

    const records = await threeRecordsOf(reservationId);
    expect(records.onTheTask).toBe(REPORTED_MICRO + BOUND_MICRO);
    expect(records.overItsCalls, 'the calls disagree with the task').toBe(records.onTheTask);
    expect(records.inTheLedger, 'the ledger disagrees with the task').toBe(records.onTheTask);
    expect(records.rows, 'the charge crossed two lots, so it is two rows').toBe(2);

    // …and in SPEND ORDER: the included month pays first, the bought credits
    // cover what is left.
    expect(settled.charges).toEqual([
      { lotId: monthly, micro: 20 * MICRO },
      { lotId: topUp, micro: REPORTED_MICRO + BOUND_MICRO - 20 * MICRO },
    ]);
  });

  it('CRITICAL a task that made calls and settled them all still has every unused credit released: what it committed came back call by call, so the hold releases the rest', async () => {
    const h = harness();
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { credits: 100 });
    const { reservationId } = await reserve(h, accountId);
    await madeCall(h, { reservationId, basis: 'provider_usage', usage: REPORTED });

    await h.service.settle(reservationId, 'completed');
    expect(await lotState(db(), lot)).toEqual({
      remaining: 100 * MICRO - REPORTED_MICRO,
      held: 0,
    });
    expect(await h.ledger.spendableMicro(accountId)).toBe(100 * MICRO - REPORTED_MICRO);
  });

  it('⛔ CRITICAL a task that crosses a MONTH RESET is paid for by what it HELD: the charge comes off the month that has ended, the rest of that month expires, and the new month’s credit is not touched at all', async () => {
    const h = harness();
    const accountId = await newTaskAccount(db());
    const ending = await fundedTaskLot(db(), accountId, {
      kind: 'monthly',
      credits: 100,
      expires: "now() + interval '1500 milliseconds'",
    });
    const { reservationId, reservedMicro } = await reserve(h, accountId);
    expect(reservedMicro).toBe(60 * MICRO);
    await madeCall(h, { reservationId, basis: 'provider_usage', usage: REPORTED });

    // The month ends while the task is still running, and the next month's
    // credit arrives before it settles.
    await waitUntilExpired(db(), ending);
    const nextMonth = await fundedTaskLot(db(), accountId, { kind: 'monthly', credits: 100 });

    const settled = await h.service.settle(reservationId, 'completed');
    expect(settled.charges, 'the new month paid for a task that began before it').toEqual([
      { lotId: ending, micro: REPORTED_MICRO },
    ]);
    expect(await lotState(db(), nextMonth)).toEqual({ remaining: 100 * MICRO, held: 0 });
    expect(
      await lotState(db(), ending),
      'the credit the task held and did not use stayed spendable past its month',
    ).toEqual({ remaining: 100 * MICRO - REPORTED_MICRO - (60 * MICRO - REPORTED_MICRO), held: 0 });

    const rows = await ledgerOf(db(), accountId);
    expect(rows.filter((r) => r.kind === 'task_charge')).toEqual([
      { kind: 'task_charge', lotId: ending, lotDelta: -REPORTED_MICRO, debtDelta: 0 },
    ]);
    expect(rows.filter((r) => r.kind === 'expiry')).toEqual([
      {
        kind: 'expiry',
        lotId: ending,
        lotDelta: -(60 * MICRO - REPORTED_MICRO),
        debtDelta: 0,
      },
    ]);
    expect(await h.ledger.spendableMicro(accountId), 'only the new month is spendable').toBe(
      100 * MICRO,
    );
  });

  it('⛔ CRITICAL a DOWNGRADE while a task is running is paid from the credit THAT TASK RELEASES, and only the remainder becomes debt (M5) — with a real reservation, real calls and a real clawback, which is the database-level proof the plan-change slice deferred', async () => {
    const h = harness();
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { kind: 'monthly', credits: 30 });
    // Haiku: 30 credits at most per task, so the task holds the whole month.
    const { reservationId, reservedMicro } = await reserve(h, accountId, SMALL_MODEL);
    expect(reservedMicro).toBe(30 * MICRO);

    // The task spends 12 of the 30 it is holding, on a real call.
    const spent = await madeCall(h, {
      reservationId,
      model: SMALL_MODEL,
      bound: {
        inputBoundTokens: 1_000,
        inputBoundMicro: 1_000_000,
        maxOutputTokens: 20_000,
        boundMicro: 21_000_000,
        basis: 'region_bytes',
      },
      basis: 'provider_usage',
      usage: {
        uncachedInput: 0,
        output: 12_000,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      },
    });
    expect(spent).toBe(12 * MICRO);

    // The downgrade lands mid-task. Every credit is held, so the clawback can
    // take nothing now: it records a claim against what the task is holding.
    const claw = await clawBack(h, accountId, 25, 'downgrade-1');
    expect(claw).toMatchObject({ clawedMicro: 0, pendingMicro: 25 * MICRO, debtMicro: 0 });
    expect(
      await debtMicroOf(db(), accountId),
      'the downgrade wrote debt while credit was held',
    ).toBe(0);

    // The task ends. It took 12 and releases 18; the claim takes all 18, and
    // only the 7 it could not reach becomes debt.
    const settled = await h.service.settle(reservationId, 'completed');
    expect(settled).toMatchObject({
      outcome: 'settled',
      chargedMicro: 12 * MICRO,
      claimsPaidMicro: 18 * MICRO,
      claimsToDebtMicro: 7 * MICRO,
    });
    expect(await debtMicroOf(db(), accountId)).toBe(7 * MICRO);
    expect(await lotState(db(), lot)).toEqual({ remaining: 0, held: 0 });
    expect(
      await h.ledger.spendableMicro(accountId),
      'debt may only stand beside a balance of nothing',
    ).toBe(0);

    const rows = await ledgerOf(db(), accountId).then((all) =>
      all.filter((r) => r.kind !== 'grant'),
    );
    expect(rows).toEqual([
      { kind: 'task_charge', lotId: lot, lotDelta: -12 * MICRO, debtDelta: 0 },
      { kind: 'proration_clawback', lotId: lot, lotDelta: -18 * MICRO, debtDelta: 0 },
      { kind: 'debt_incurred', lotId: null, lotDelta: 0, debtDelta: 7 * MICRO },
    ]);
    expect(
      await db()`SELECT pending_micro::text AS n FROM credit_clawbacks
                  WHERE account_id = ${accountId}::uuid`,
    ).toEqual([{ n: '0' }]);
  });

  it('⛔ CRITICAL the claim is paid BEFORE anything else the release could go to: the task charge and the claim together empty the lot, and nothing is left over for the customer to spend on a plan they have left', async () => {
    const h = harness();
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { kind: 'monthly', credits: 30 });
    const { reservationId } = await reserve(h, accountId, SMALL_MODEL);
    await clawBack(h, accountId, 10, 'downgrade-2');

    const settled = await h.service.settle(reservationId, 'completed');
    expect(settled).toMatchObject({ chargedMicro: 0, claimsPaidMicro: 10 * MICRO });
    expect(await lotState(db(), lot)).toEqual({ remaining: 20 * MICRO, held: 0 });
    expect(await debtMicroOf(db(), accountId)).toBe(0);
  });

  it('⛔ CRITICAL when a task releases less than the claims standing against it, the OLDEST claim is paid first and the rest becomes debt — not whichever claim the database happened to return first. Two downgrades against one task are settled in the order they landed', async () => {
    const h = harness();
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { kind: 'monthly', credits: 30 });
    const { reservationId } = await reserve(h, accountId, SMALL_MODEL);

    const older = await clawBack(h, accountId, 10, 'downgrade-early');
    const newer = await clawBack(h, accountId, 10, 'downgrade-late');
    expect([older.pendingMicro, newer.pendingMicro]).toEqual([10 * MICRO, 10 * MICRO]);

    // The task spends 25 of the 30 it holds, so it releases 5 — half of one
    // claim and none of the other.
    await madeCall(h, {
      reservationId,
      model: SMALL_MODEL,
      bound: {
        inputBoundTokens: 1_000,
        inputBoundMicro: 1_000_000,
        maxOutputTokens: 30_000,
        boundMicro: 28_000_000,
        basis: 'region_bytes',
      },
      basis: 'provider_usage',
      usage: { uncachedInput: 0, output: 25_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    });

    const settled = await h.service.settle(reservationId, 'completed');
    expect(settled).toMatchObject({
      chargedMicro: 25 * MICRO,
      claimsPaidMicro: 5 * MICRO,
      claimsToDebtMicro: 15 * MICRO,
    });

    const rows = await keyedLedgerOf(accountId);
    expect(
      rows.filter((r) => r.key.startsWith('claim:')),
      'the credit this task released paid a claim other than the oldest',
    ).toEqual([
      {
        kind: 'proration_clawback',
        key: `claim:${older.id}:${reservationId}:${lot}`,
        lotDelta: -5 * MICRO,
        debtDelta: 0,
      },
    ]);
    expect(
      rows.filter((r) => r.key.startsWith('claim_debt:')).map((r) => [r.key, r.debtDelta]),
      'the debt was split between the two downgrades the wrong way round',
    ).toEqual([
      [`claim_debt:${older.id}:${reservationId}`, 5 * MICRO],
      [`claim_debt:${newer.id}:${reservationId}`, 10 * MICRO],
    ]);
    expect(await debtMicroOf(db(), accountId)).toBe(15 * MICRO);
    expect(await lotState(db(), lot)).toEqual({ remaining: 0, held: 0 });
  });

  it('⛔ CRITICAL two connections racing to settle one task charge it ONCE: one settles, the other finds it settled and reports the charge that stands, and the ledger holds a single set of rows', async () => {
    const one = harness();
    const two = harness();
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { credits: 100 });
    const { reservationId } = await reserve(one, accountId);
    await madeCall(one, { reservationId, basis: 'provider_usage', usage: REPORTED });

    const [a, b] = await Promise.all([
      one.service.settle(reservationId, 'completed'),
      two.service.settle(reservationId, 'lease_expired'),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes, 'both connections believed they settled the task').toEqual([
      'already_settled',
      'settled',
    ]);
    expect(a.chargedMicro, 'the two callers were told different charges').toBe(b.chargedMicro);
    expect(a.chargedMicro).toBe(REPORTED_MICRO);

    const records = await threeRecordsOf(reservationId);
    expect(records).toEqual({
      onTheTask: REPORTED_MICRO,
      overItsCalls: REPORTED_MICRO,
      inTheLedger: REPORTED_MICRO,
      rows: 1,
    });
    expect(await lotState(db(), lot)).toEqual({
      remaining: 100 * MICRO - REPORTED_MICRO,
      held: 0,
    });
  });

  it('CRITICAL a settle AFTER a settle is a no-op that still answers what the task cost, so a route finishing behind the keeper reports the same number to the customer', async () => {
    const h = harness();
    const accountId = await newTaskAccount(db());
    await fundedTaskLot(db(), accountId, { credits: 100 });
    const { reservationId } = await reserve(h, accountId);
    await madeCall(h, { reservationId, basis: 'no_record' });

    const first = await h.service.settle(reservationId, 'lease_expired');
    const second = await h.service.settle(reservationId, 'completed');
    expect(first).toMatchObject({ outcome: 'settled', chargedMicro: BOUND_MICRO });
    expect(second).toMatchObject({ outcome: 'already_settled', chargedMicro: BOUND_MICRO });
    const [reason] = await db()<Array<{ settle_reason: string }>>`
      SELECT settle_reason FROM credit_reservations WHERE id = ${reservationId}::uuid`;
    expect(reason, 'the second settlement overwrote why the task ended').toEqual({
      settle_reason: 'lease_expired',
    });
    expect((await threeRecordsOf(reservationId)).rows).toBe(1);
  });

  it('⛔ CRITICAL the DATABASE refuses a hold charged for more than it held. A settlement takes `LEAST(left, held)` from each hold, and this CHECK is what holds when a future writer computes that wrong', async () => {
    const h = harness();
    const accountId = await newTaskAccount(db());
    await fundedTaskLot(db(), accountId, { credits: 100 });
    const { reservationId } = await reserve(h, accountId);

    const over = await refusal(
      () => db()`
        UPDATE credit_reservation_holds
           SET charged_micro = held_micro + 1, released_at = now()
         WHERE reservation_id = ${reservationId}::uuid`,
      'a hold charged for more than it held',
    );
    expect(over.code).toBe('23514');
    expect(over.constraint).toBe('credit_reservation_holds_release_shape');

    // The positive control: charged for exactly what it held is accepted, so
    // the arm above is about the excess and not about the shape of the update.
    await db()`
      UPDATE credit_reservation_holds SET charged_micro = held_micro, released_at = now()
       WHERE reservation_id = ${reservationId}::uuid`;
    expect((await modelCallRows(db(), reservationId)).length).toBe(0);
  });

  it('⛔ CRITICAL the DATABASE refuses a hold larger than what its lot has left. Held credit is credit nothing else may spend, so a lot holding more than it has would let two tasks be told the same credit was theirs', async () => {
    const h = harness();
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { credits: 100 });
    const { reservationId } = await reserve(h, accountId);
    expect(await lotState(db(), lot)).toEqual({ remaining: 100 * MICRO, held: 60 * MICRO });

    // A second task of the same account asks for 41 of the 40 credits the lot
    // has left. Written in one transaction, because neither row may exist
    // without the other: an enforced task must be backed by holds summing to
    // exactly what it reserved (checked at COMMIT), and from 0132 a hold must
    // name a task that is open and enforced (checked as it is inserted). It
    // reserves exactly the 41 the hold is for, so the only thing wrong with this
    // transaction is the one thing under test.
    const over = await refusal(
      () =>
        db().begin(async (tx) => {
          const other = randomUUID();
          await tx`
            INSERT INTO credit_reservations (id, account_id, agent_session_id, model,
                                             rate_card_version, mode, slot, reserved_micro,
                                             lease_owner, lease_expires_at, max_until)
            VALUES (${other}::uuid, ${accountId}::uuid, ${`as_${other}`}, ${ON_CREDITS_MODEL}, 1,
                    'enforce', 2, ${String(41 * MICRO)}::bigint, ${BOOT},
                    now() + interval '90 seconds', now() + interval '30 minutes')`;
          await tx`
            INSERT INTO credit_reservation_holds (reservation_id, lot_id, account_id, held_micro)
            VALUES (${other}::uuid, ${lot}::uuid, ${accountId}::uuid,
                    ${String(41 * MICRO)}::bigint)`;
        }),
      'a hold beyond what the lot has left',
    );
    // The hold's own trigger raises the lot's `held_micro`, and the lot's CHECK
    // is what refuses it — the guarantee lives on the lot, not on the hold.
    expect(over.code).toBe('23514');
    expect(over.constraint).toBe('credit_lots_held_bounds');
    expect(await lotState(db(), lot), 'the refused hold moved the lot anyway').toEqual({
      remaining: 100 * MICRO,
      held: 60 * MICRO,
    });
    await h.service.settle(reservationId, 'completed');
  });

  it('CRITICAL a SHADOW task settles its calls and touches no balance: its calls are charged, and not one lot, hold or ledger row moves', async () => {
    const h = harness();
    const accountId = await newTaskAccount(db());
    const lot = await fundedTaskLot(db(), accountId, { credits: 100 });
    const reservationId = randomUUID();
    await h.service.reserve({
      accountId,
      reservationId,
      agentSessionId: `as_${reservationId}`,
      idempotencyKey: null,
      model: ON_CREDITS_MODEL,
      mode: 'shadow',
      bootId: BOOT,
    });
    await madeCall(h, { reservationId, basis: 'provider_usage', usage: REPORTED });

    const settled = await h.service.settle(reservationId, 'completed');
    expect(settled).toMatchObject({
      outcome: 'settled',
      chargedMicro: REPORTED_MICRO,
      charges: [],
      claimsPaidMicro: 0,
    });
    expect(await lotState(db(), lot)).toEqual({ remaining: 100 * MICRO, held: 0 });
    expect(
      (await ledgerOf(db(), accountId)).filter((r) => r.kind !== 'grant'),
      'a shadow measurement moved a real balance',
    ).toEqual([]);
  });
});
