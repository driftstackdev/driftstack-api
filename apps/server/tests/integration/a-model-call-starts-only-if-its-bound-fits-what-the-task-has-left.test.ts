// Every billable HTTP attempt asks the task first, and pays exactly once
// (§4.5, §4.6).
//
// A reservation is a ceiling on a whole task; a call is a ceiling on one request
// inside it. What this file proves is that the second never escapes the first:
//
//   · a call is admitted only while its task is OPEN, inside its CEILING, on the
//     MODEL it reserved (M10), and only while what it has already committed plus
//     this call's upper bound still fits what it reserved;
//   · admission is ONE statement, so the decision and the commitment happen at
//     the same instant on the same row lock, and two connections racing cannot
//     both be told there is room for one;
//   · `sent` is written in its own statement immediately before the request goes
//     out, and it is the only thing that later tells a request that was served
//     from one that never left the building;
//   · a call is settled exactly once, for what the one recorded fact about it
//     says it cost, and the task gets the rest of the bound back.
//
// ⛔ THE DATABASE IS ASKED DIRECTLY WHEREVER IT IS THE THING BEING PROVED. The
// CHECK that a charge cannot pass its bound, the CHECK that `never_sent` really
// means unsent, and the COMMIT-time balance between a task and its calls are all
// exercised with raw SQL against the tables, not through the service that would
// have stopped a bad row before Postgres saw it.
//
// ⛔ SHADOW ADMITS WHATEVER IT COSTS. A measurement that stopped at the
// reservation would measure the limit and not the load, so the two facts that
// would have refused it are RECORDED instead — on the call and on the task.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CREDIT_RATE_CARD_V1, type ModelCallTokens } from '@driftstack/api-types';
import type { Database } from '../../src/db/client.js';
import type { CreditCallBound } from '../../src/db/credit-reservations-repo.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import { refusal } from './_helpers/database-refusal.js';
import {
  MICRO,
  ON_CREDITS_MODEL,
  OWN_KEY_ONLY_MODEL,
  agedReservation,
  fundedTaskLot,
  modelCallRows,
  newTaskAccount,
  reservationCounters,
  reservationsHarness,
  type ReservationsHarness,
} from './_helpers/credit-reservation-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_admit';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);
const BOOT = 'boot-admit';
/** A second model the launch card prices, for the model predicate (M10). */
const OTHER_MODEL = 'claude-haiku-4-5';

// The launch card's Sonnet 5 row, spelt out so every number below is checkable
// by hand rather than by re-running the function under test.
const RATES = CREDIT_RATE_CARD_V1.models['claude-sonnet-5'];
/** 1,000 bytes cached for an hour, 500 uncached, plus the 2,048-token framing. */
const REGIONS = { oneHourRegionBytes: 1_000, fiveMinuteRegionBytes: 0, uncachedRegionBytes: 500 };
const INPUT_MICRO = 1_000 * 800 + 500 * 400 + 2_048 * 800; // 2,638,400
const BOUND_MICRO = INPUT_MICRO + 8_192 * 2_000; // 19,022,400
const BOUND: CreditCallBound = {
  inputBoundTokens: 1_000 + 500 + 2_048,
  inputBoundMicro: INPUT_MICRO,
  maxOutputTokens: 8_192,
  boundMicro: BOUND_MICRO,
  basis: 'region_bytes',
};

/** What the provider reported for a finished call: 3,880,000 µcr on that card. */
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

/** An account with `credits` of spendable credit and one open task on Sonnet 5. */
async function taskOn(
  h: ReservationsHarness,
  credits = 100,
): Promise<{ accountId: string; reservationId: string; lotId: string; reservedMicro: number }> {
  const accountId = await newTaskAccount(db());
  const lotId = await fundedTaskLot(db(), accountId, { credits });
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
  if (result.outcome !== 'reserved')
    throw new Error(`the fixture could not reserve: ${JSON.stringify(result)}`);
  return { accountId, reservationId, lotId, reservedMicro: result.reservedMicro };
}

/**
 * Wait until some backend OF THIS DATABASE is blocked on a lock.
 *
 * ⛔ POLLED, NOT SLEPT. The arm that uses it needs the settlement to be ALREADY
 * WAITING before the lock holder writes, and a fixed sleep either races on a
 * loaded machine or pads every run.
 *
 * ⛔ AND SCOPED TO THIS DATABASE, WHICH `pg_locks` ALONE IS NOT. `pg_locks` is
 * CLUSTER-WIDE: `SELECT count(*) FROM pg_locks WHERE NOT granted` counts every
 * backend queued on every lock in every database on this server, and a row lock
 * is waited on as a `transactionid` lock whose `database` column is NULL, so the
 * view cannot be narrowed by its own columns. Measured: with two connections
 * contending on one row of a THROWAWAY database, that predicate read 1 from a
 * session connected to a different database while `pg_stat_activity` scoped to
 * `current_database()` correctly read 0. A predicate another workflow's test run
 * can satisfy is not this settlement being queued, and the whole arm rests on
 * that ordering — so this asks the same question the sibling admission-slot file
 * asks (`at-most-three-enforced-tasks-hold-credit-at-once.test.ts`
 * `waitForLockWaiters`), of this database only.
 */
async function waitForALockWaiter(): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const waiting = await db()<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (waiting.length > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('no connection of this database ever queued on a lock');
}

function admit(
  h: ReservationsHarness,
  reservationId: string,
  over: Partial<{ model: string; bound: CreditCallBound; purpose: 'plan' | 'answer' }> = {},
) {
  return h.service.admitCall({
    reservationId,
    purpose: over.purpose ?? 'plan',
    model: over.model ?? ON_CREDITS_MODEL,
    bound: over.bound ?? BOUND,
    callId: randomUUID(),
  });
}

describe.skipIf(!RUN_DB_TESTS)(
  'a model call starts only if its bound fits what the task has left',
  () => {
    it('the isolated database was rebuilt from the migrations and is reachable — otherwise every arm below would fail on setup, not on what it proves', () => {
      expect(
        client,
        'Postgres is up but the isolated database could not be prepared',
      ).not.toBeNull();
    });

    it('CRITICAL the numbers this file is written against are the card the migration seeded, not figures retyped here — a rate that drifted would leave every arm agreeing with itself and with nothing else', async () => {
      const [row] = await db()<Array<Record<string, string>>>`
        SELECT input_micro_per_token::text AS input, output_micro_per_token::text AS output,
               cache_write_1h_micro_per_token::text AS w1h, max_reserve_micro::text AS max_reserve
          FROM credit_rate_card_models WHERE version = 1 AND model = ${ON_CREDITS_MODEL}`;
      expect(row).toEqual({
        input: '400',
        output: '2000',
        w1h: '800',
        max_reserve: String(60 * MICRO),
      });
      expect([RATES.inputMicroPerToken, RATES.outputMicroPerToken]).toEqual([400, 2_000]);
      expect(BOUND_MICRO).toBe(19_022_400);
    });

    it('CRITICAL a call that fits commits its whole UPPER BOUND before the request exists, and the task has that much less to give the next one', async () => {
      const h = harness();
      const { reservationId, reservedMicro } = await taskOn(h);
      expect(reservedMicro).toBe(60 * MICRO);

      const result = await admit(h, reservationId);
      expect(result.outcome).toBe('admitted');
      if (result.outcome !== 'admitted') throw new Error('unreachable');
      expect(result.seq).toBe(1);
      expect(result.mode).toBe('enforce');
      expect(result.leftMicro).toBe(60 * MICRO - BOUND_MICRO);

      const counters = await reservationCounters(db(), reservationId);
      expect(counters.committedMicro).toBe(BOUND_MICRO);
      const [call] = await modelCallRows(db(), reservationId);
      expect(call).toMatchObject({
        seq: 1,
        purpose: 'plan',
        model: ON_CREDITS_MODEL,
        state: 'started',
        sent: false,
        settleBasis: null,
        boundMicro: BOUND_MICRO,
        inputBoundMicro: INPUT_MICRO,
        maxOutputTokens: 8_192,
        chargedMicro: null,
        shadowOverReservation: false,
      });
    });

    it('⛔ CRITICAL the call that does NOT fit is the one refused, and it commits nothing at all: three calls of 19.02 credits fit inside a 60-credit task and the fourth does not', async () => {
      const h = harness();
      const { reservationId } = await taskOn(h);
      for (const seq of [1, 2, 3]) {
        const ok = await admit(h, reservationId);
        expect(ok.outcome, `call ${seq}`).toBe('admitted');
      }
      const committedBefore = (await reservationCounters(db(), reservationId)).committedMicro;
      expect(committedBefore).toBe(3 * BOUND_MICRO);

      const refused = await admit(h, reservationId);
      expect(refused).toEqual({
        outcome: 'refused',
        reason: 'did_not_fit',
        leftMicro: 60 * MICRO - 3 * BOUND_MICRO,
      });
      expect(
        (await reservationCounters(db(), reservationId)).committedMicro,
        'a refused call moved the task’s committed total',
      ).toBe(committedBefore);
      expect((await modelCallRows(db(), reservationId)).length, 'a refused call wrote a row').toBe(
        3,
      );
    });

    it('CRITICAL the fit is inclusive: a bound equal to the room left is admitted, and one microcredit more is not. An exclusive test here would refuse the last call of every task that spent its reservation exactly', async () => {
      const h = harness();
      const { reservationId } = await taskOn(h);
      const exact: CreditCallBound = { ...BOUND, boundMicro: 60 * MICRO };
      const over: CreditCallBound = { ...BOUND, boundMicro: 60 * MICRO + 1 };
      expect((await admit(h, reservationId, { bound: over })).outcome).toBe('refused');
      const ok = await admit(h, reservationId, { bound: exact });
      expect(ok.outcome).toBe('admitted');
      if (ok.outcome !== 'admitted') throw new Error('unreachable');
      expect(ok.leftMicro).toBe(0);
    });

    it('⛔ CRITICAL a call on a DIFFERENT MODEL from the one its task reserved is refused (M10). The task priced Sonnet and holds Sonnet’s credits; a Haiku — or an Opus — call slipped in under it would be paid for at a rate card nobody agreed to', async () => {
      const h = harness();
      const { reservationId } = await taskOn(h);
      const refused = await admit(h, reservationId, { model: OTHER_MODEL });
      expect(refused.outcome).toBe('refused');
      if (refused.outcome !== 'refused') throw new Error('unreachable');
      expect(refused.reason, 'refused, but not for being on the wrong model').toBe('model');
      expect((await reservationCounters(db(), reservationId)).committedMicro).toBe(0);
      expect(await modelCallRows(db(), reservationId)).toEqual([]);

      // The same call on the task's own model is admitted, so the arm above is
      // about the model and not about anything else in the request.
      expect((await admit(h, reservationId)).outcome).toBe('admitted');
    });

    it('⛔ CRITICAL a task past its hard ceiling admits nothing, however much room it has left (M1). A turn that never finished must stop costing money at a bound the database can see, not when someone notices', async () => {
      const h = harness();
      const accountId = await newTaskAccount(db());
      const lotId = await fundedTaskLot(db(), accountId, { credits: 100 });
      const reservationId = await agedReservation(db(), {
        accountId,
        lotId,
        reservedMicro: 60 * MICRO,
      });

      const refused = await admit(h, reservationId);
      expect(refused).toEqual({ outcome: 'refused', reason: 'max_age', leftMicro: 60 * MICRO });
      expect(await modelCallRows(db(), reservationId)).toEqual([]);
    });

    it('CRITICAL a SETTLED task admits nothing: the late attempt is answered as `settled`, not as "no room", so the runtime can end the turn rather than ask for a smaller call', async () => {
      const h = harness();
      const { reservationId } = await taskOn(h);
      expect((await h.service.settle(reservationId, 'completed')).outcome).toBe('settled');
      const refused = await admit(h, reservationId);
      expect(refused.outcome).toBe('refused');
      if (refused.outcome !== 'refused') throw new Error('unreachable');
      expect(refused.reason).toBe('settled');
    });

    it('CRITICAL a task that never existed is an answer and not an exception', async () => {
      const h = harness();
      const refused = await admit(h, randomUUID());
      expect(refused).toEqual({ outcome: 'refused', reason: 'gone', leftMicro: 0 });
    });

    it('CRITICAL admission RENEWS the lease and never shortens it: a task making calls is a task that is alive, and the keeper must not settle it out from under a request about to go out', async () => {
      const h = harness();
      const { reservationId } = await taskOn(h);
      await db()`
        UPDATE credit_reservations SET lease_expires_at = now() + interval '5 seconds'
         WHERE id = ${reservationId}::uuid`;
      expect((await reservationCounters(db(), reservationId)).leaseSecondsLeft).toBeLessThan(10);

      await admit(h, reservationId);
      expect(
        (await reservationCounters(db(), reservationId)).leaseSecondsLeft,
        'admission did not push the lease out to the full 90 seconds',
      ).toBeGreaterThan(80);

      // …and never pulls a longer lease back in.
      await db()`
        UPDATE credit_reservations SET lease_expires_at = now() + interval '10 minutes'
         WHERE id = ${reservationId}::uuid`;
      await admit(h, reservationId);
      expect((await reservationCounters(db(), reservationId)).leaseSecondsLeft).toBeGreaterThan(
        500,
      );
    });

    it('⛔ CRITICAL a SHADOW task admits a call that would never have fitted, and records BOTH facts that would have refused it — on the call and on the task. A measurement that stopped at the reservation would measure the limit and not the load', async () => {
      const h = harness();
      const accountId = await newTaskAccount(db());
      await fundedTaskLot(db(), accountId, { credits: 100 });
      const reservationId = randomUUID();
      const shadow = await h.service.reserve({
        accountId,
        reservationId,
        agentSessionId: `as_${reservationId}`,
        idempotencyKey: null,
        model: ON_CREDITS_MODEL,
        mode: 'shadow',
        bootId: BOOT,
      });
      expect(shadow.outcome).toBe('shadowed');

      const huge: CreditCallBound = { ...BOUND, boundMicro: 100 * MICRO };
      const admitted = await admit(h, reservationId, { bound: huge });
      expect(admitted.outcome).toBe('admitted');
      if (admitted.outcome !== 'admitted') throw new Error('unreachable');
      expect(admitted.mode).toBe('shadow');
      expect(admitted.overReservation).toBe(true);
      expect(admitted.leftMicro, 'a shadow task can commit past what it reserved').toBeLessThan(0);

      const counters = await reservationCounters(db(), reservationId);
      expect(counters.committedMicro).toBe(100 * MICRO);
      expect(
        counters.wouldRefuseReason,
        '`call_did_not_fit` is the one refusal only admission can see, and the shadow census reads it from here',
      ).toBe('call_did_not_fit');
      expect((await modelCallRows(db(), reservationId))[0]?.shadowOverReservation).toBe(true);
    });

    it('CRITICAL a shadow call that DOES fit records neither fact — otherwise every shadow task would read as one enforcement would have refused', async () => {
      const h = harness();
      const accountId = await newTaskAccount(db());
      await fundedTaskLot(db(), accountId, { credits: 100 });
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
      await admit(h, reservationId);
      const counters = await reservationCounters(db(), reservationId);
      expect(counters.wouldRefuseReason).toBeNull();
      expect((await modelCallRows(db(), reservationId))[0]?.shadowOverReservation).toBe(false);
    });

    it('⛔ CRITICAL `sent` is written before the request goes out and is ONE-WAY. It is the only fact a settlement running in another process can use to tell a request that was served from one that never left, and those are charged the full bound and nothing at all', async () => {
      const h = harness();
      const { reservationId } = await taskOn(h);
      const admitted = await admit(h, reservationId);
      if (admitted.outcome !== 'admitted') throw new Error('unreachable');

      expect((await modelCallRows(db(), reservationId))[0]?.sent).toBe(false);
      expect(await h.service.markSent(admitted.callId)).toBe(true);
      expect((await modelCallRows(db(), reservationId))[0]?.sent).toBe(true);

      const back = await refusal(
        () => db()`UPDATE credit_model_calls SET sent = false WHERE id = ${admitted.callId}::uuid`,
        'un-sending a call that went out',
      );
      expect(back.code).toBe('55000');
      expect(back.message).toMatch(/sent is one-way/);
    });

    it('CRITICAL marking a call sent AFTER its task was settled around it answers false, so the caller does not send a request nobody will pay for', async () => {
      const h = harness();
      const { reservationId } = await taskOn(h);
      const admitted = await admit(h, reservationId);
      if (admitted.outcome !== 'admitted') throw new Error('unreachable');
      await h.service.settle(reservationId, 'lease_expired');
      expect(await h.service.markSent(admitted.callId)).toBe(false);
    });

    it('CRITICAL a settled call gives the task back the difference between what it was allowed to cost and what it did cost, so the next call may use it', async () => {
      const h = harness();
      const { reservationId } = await taskOn(h);
      const admitted = await admit(h, reservationId);
      if (admitted.outcome !== 'admitted') throw new Error('unreachable');
      await h.service.markSent(admitted.callId);

      const settled = await h.service.settleCall({
        callId: admitted.callId,
        basis: 'provider_usage',
        usage: REPORTED,
      });
      expect(settled).toEqual({
        outcome: 'settled',
        chargedMicro: REPORTED_MICRO,
        boundMicro: BOUND_MICRO,
        overBound: false,
      });
      expect((await reservationCounters(db(), reservationId)).committedMicro).toBe(REPORTED_MICRO);
      const [call] = await modelCallRows(db(), reservationId);
      expect(call).toMatchObject({
        state: 'settled',
        settleBasis: 'provider_usage',
        chargedMicro: REPORTED_MICRO,
        actualMicro: REPORTED_MICRO,
        outputTokens: 500,
      });
      expect(h.boundExceeded).toEqual([]);
    });

    it('⛔ CRITICAL a Stop that lands AFTER the send and BEFORE the first usage block is charged its whole bound (L5), and the database requires exactly that of a `no_record` call — not the zero a Stop during admission would have cost', async () => {
      const h = harness();
      const { reservationId } = await taskOn(h);
      const admitted = await admit(h, reservationId);
      if (admitted.outcome !== 'admitted') throw new Error('unreachable');
      await h.service.markSent(admitted.callId);

      const settled = await h.service.settleCall({
        callId: admitted.callId,
        basis: 'no_record',
      });
      expect(settled.chargedMicro).toBe(BOUND_MICRO);
      const [call] = await modelCallRows(db(), reservationId);
      expect(call).toMatchObject({ settleBasis: 'no_record', chargedMicro: BOUND_MICRO });
      expect(
        call?.actualMicro,
        'a measured zero would read as "we looked and it was free"',
      ).toBeNull();
      expect((await reservationCounters(db(), reservationId)).committedMicro).toBe(BOUND_MICRO);
    });

    it('⛔ CRITICAL a call that was NEVER SENT is charged nothing, whichever settlement reaches it. `no_record` costs the full bound and `sent` is the only fact that tells the two apart, so the adapter naming it on a request that never left must not bill the ceiling the lease keeper would have billed zero for', async () => {
      const h = harness();

      // The adapter's leg: admitted, and the request never went out — a Stop
      // during admission, or `markSent` itself failing.
      const byTheAdapter = await taskOn(h);
      const admitted = await admit(h, byTheAdapter.reservationId);
      if (admitted.outcome !== 'admitted') throw new Error('unreachable');
      const settled = await h.service.settleCall({ callId: admitted.callId, basis: 'no_record' });
      expect(settled.chargedMicro, 'a request that never left the building was billed').toBe(0);
      expect((await modelCallRows(db(), byTheAdapter.reservationId))[0]).toMatchObject({
        sent: false,
        settleBasis: 'never_sent',
        chargedMicro: 0,
      });
      expect(
        (await reservationCounters(db(), byTheAdapter.reservationId)).committedMicro,
        'the whole bound goes back to the task, so its next call may use it',
      ).toBe(0);

      // The keeper's leg, on an identical row: the same call, settled by the
      // crash path instead. Both must reach the same number, or what a call
      // costs depends on which process happened to get there first.
      const byTheKeeper = await taskOn(h);
      const orphan = await admit(h, byTheKeeper.reservationId);
      if (orphan.outcome !== 'admitted') throw new Error('unreachable');
      await h.service.settle(byTheKeeper.reservationId, 'lease_expired');
      expect((await modelCallRows(db(), byTheKeeper.reservationId))[0]).toMatchObject({
        sent: false,
        settleBasis: 'never_sent',
        chargedMicro: 0,
      });
      expect((await reservationCounters(db(), byTheKeeper.reservationId)).chargedMicro).toBe(0);
    });

    it('⛔ CRITICAL the mirror: `never_sent` named on a request the row says DID go out is settled `no_record` at its bound, and NOT refused. `credit_model_calls_never_sent_really` rejects that basis on a sent row, so passing the caller’s word through raised a CHECK violation out of the adapter’s per-attempt `finally` — which leaves the call `started` and hands the lease keeper the same bound a lease later. Both legs here charge the same number, which is the whole claim', async () => {
      const h = harness();

      // The ADAPTER's leg: sent, then a Stop lands before the fetch and the
      // caller names the basis for a request that never left.
      const byTheAdapter = await taskOn(h);
      const admitted = await admit(h, byTheAdapter.reservationId);
      if (admitted.outcome !== 'admitted') throw new Error('unreachable');
      await h.service.markSent(admitted.callId);
      expect(
        await h.service.settleCall({ callId: admitted.callId, basis: 'never_sent' }),
        'the settlement of a sent call must not be refused by the CHECK that basis breaks',
      ).toEqual({
        outcome: 'settled',
        chargedMicro: BOUND_MICRO,
        boundMicro: BOUND_MICRO,
        overBound: false,
      });
      expect((await modelCallRows(db(), byTheAdapter.reservationId))[0]).toMatchObject({
        sent: true,
        settleBasis: 'no_record',
        chargedMicro: BOUND_MICRO,
      });

      // The KEEPER's leg on an identical row: §5.3 prices the same window the
      // same way, so the two processes must agree.
      const byTheKeeper = await taskOn(h);
      const orphan = await admit(h, byTheKeeper.reservationId);
      if (orphan.outcome !== 'admitted') throw new Error('unreachable');
      await h.service.markSent(orphan.callId);
      await h.service.settle(byTheKeeper.reservationId, 'lease_expired');
      expect((await modelCallRows(db(), byTheKeeper.reservationId))[0]).toMatchObject({
        sent: true,
        settleBasis: 'no_record',
        chargedMicro: BOUND_MICRO,
      });
    });

    it('⛔ CRITICAL a settlement that waited for the task’s lock reports what the call WAS charged, not zero. `FOR UPDATE OF r` re-reads only the row it locks, so the call columns beside it are the pre-wait snapshot — and a route finishing behind the keeper would otherwise record a call that cost its whole bound as having cost nothing', async () => {
      const h = harness();
      const { reservationId } = await taskOn(h);
      const admitted = await admit(h, reservationId);
      if (admitted.outcome !== 'admitted') throw new Error('unreachable');
      await h.service.markSent(admitted.callId);

      // The keeper holds the task's row and settles the call under it while the
      // adapter's settlement is already waiting on that lock.
      let waited: Promise<Awaited<ReturnType<typeof h.service.settleCall>>> | null = null;
      await db().begin(async (tx) => {
        await tx`SELECT id FROM credit_reservations WHERE id = ${reservationId}::uuid FOR UPDATE`;
        waited = h.service.settleCall({
          callId: admitted.callId,
          basis: 'provider_usage',
          usage: REPORTED,
        });
        await waitForALockWaiter();
        await tx`
          UPDATE credit_model_calls
             SET state = 'settled', settle_basis = 'no_record', charged_micro = bound_micro,
                 settled_at = now()
           WHERE id = ${admitted.callId}::uuid`;
      });
      if (waited === null) throw new Error('unreachable');
      const late = await (waited as Promise<Awaited<ReturnType<typeof h.service.settleCall>>>);

      expect(late).toEqual({
        outcome: 'already_settled',
        chargedMicro: BOUND_MICRO,
        boundMicro: BOUND_MICRO,
        overBound: false,
      });
      // And it moved nothing: the keeper's charge is the one that stands.
      expect((await modelCallRows(db(), reservationId))[0]).toMatchObject({
        settleBasis: 'no_record',
        chargedMicro: BOUND_MICRO,
      });
      expect((await reservationCounters(db(), reservationId)).committedMicro).toBe(BOUND_MICRO);
    });

    it('CRITICAL a call settled TWICE is charged once: the second settlement finds it settled, reports the charge that stands, and moves no number', async () => {
      const h = harness();
      const { reservationId } = await taskOn(h);
      const admitted = await admit(h, reservationId);
      if (admitted.outcome !== 'admitted') throw new Error('unreachable');
      await h.service.markSent(admitted.callId);
      await h.service.settleCall({
        callId: admitted.callId,
        basis: 'provider_usage',
        usage: REPORTED,
      });

      const again = await h.service.settleCall({ callId: admitted.callId, basis: 'no_record' });
      expect(again).toEqual({
        outcome: 'already_settled',
        chargedMicro: REPORTED_MICRO,
        boundMicro: BOUND_MICRO,
        overBound: false,
      });
      expect((await reservationCounters(db(), reservationId)).committedMicro).toBe(REPORTED_MICRO);
      expect((await modelCallRows(db(), reservationId))[0]?.settleBasis).toBe('provider_usage');
    });

    it('CRITICAL settling a call that does not exist is an answer and not an exception', async () => {
      const h = harness();
      expect(await h.service.settleCall({ callId: randomUUID(), basis: 'no_record' })).toEqual({
        outcome: 'unknown',
        chargedMicro: 0,
        boundMicro: 0,
        overBound: false,
      });
    });

    it('⛔ CRITICAL a provider that reported MORE than the bound is charged the bound and raises `ai_credits_bound_exceeded`: the customer pays the ceiling they were admitted under, and the excess is an alert about the bound rather than a bill', async () => {
      const h = harness();
      const { reservationId } = await taskOn(h);
      const small: CreditCallBound = {
        ...BOUND,
        inputBoundMicro: 1_000,
        boundMicro: 1_000_000,
      };
      const admitted = await admit(h, reservationId, { bound: small });
      if (admitted.outcome !== 'admitted') throw new Error('unreachable');
      await h.service.markSent(admitted.callId);

      const settled = await h.service.settleCall({
        callId: admitted.callId,
        basis: 'provider_usage',
        usage: REPORTED,
      });
      expect(settled.chargedMicro).toBe(1_000_000);
      expect(settled.overBound).toBe(true);
      expect(h.boundExceeded).toHaveLength(1);
      expect(h.boundExceeded[0]).toMatchObject({
        callId: admitted.callId,
        reservationId,
        model: ON_CREDITS_MODEL,
        basis: 'provider_usage',
        boundMicro: 1_000_000,
        actualMicro: REPORTED_MICRO,
      });
    });

    it('⛔ CRITICAL the DATABASE refuses a charge above its call’s bound, whatever wrote it. The cap in the service is the first line; this CHECK is the last, and it is the one that holds when a future writer forgets', async () => {
      const h = harness();
      const { reservationId } = await taskOn(h);
      const admitted = await admit(h, reservationId);
      if (admitted.outcome !== 'admitted') throw new Error('unreachable');

      const over = await refusal(
        () => db()`
          UPDATE credit_model_calls
             SET state = 'settled', settle_basis = 'provider_usage', settled_at = now(),
                 charged_micro = ${String(BOUND_MICRO + 1)}::bigint
           WHERE id = ${admitted.callId}::uuid`,
        'a charge above the bound',
      );
      expect(over.code).toBe('23514');
      expect(over.constraint).toBe('credit_model_calls_charge_le_bound');
    });

    it('⛔ CRITICAL the DATABASE refuses `never_sent` on a call that WAS sent. That basis is priced at zero, so accepting it on a request that went out would let a settlement write off a call the provider billed us for — by writing one word', async () => {
      const h = harness();
      const { reservationId } = await taskOn(h);
      const admitted = await admit(h, reservationId);
      if (admitted.outcome !== 'admitted') throw new Error('unreachable');
      await h.service.markSent(admitted.callId);

      const refused = await refusal(
        () => db()`
          UPDATE credit_model_calls
             SET state = 'settled', settle_basis = 'never_sent', charged_micro = 0,
                 settled_at = now()
           WHERE id = ${admitted.callId}::uuid`,
        '`never_sent` on a call that was sent',
      );
      expect(refused.code).toBe('23514');
      expect(refused.constraint).toBe('credit_model_calls_never_sent_really');

      // The positive control: the identical statement on a call that was NOT
      // sent is accepted, so the arm above is about `sent` and nothing else.
      // The task's committed total moves with it in the same transaction — a
      // settled call commits its charge where a started one committed its
      // bound, and the COMMIT-time check refuses the pair out of step.
      const unsent = await admit(h, reservationId);
      if (unsent.outcome !== 'admitted') throw new Error('unreachable');
      await db().begin(async (tx) => {
        await tx`
          UPDATE credit_model_calls
             SET state = 'settled', settle_basis = 'never_sent', charged_micro = 0,
                 settled_at = now()
           WHERE id = ${unsent.callId}::uuid`;
        await tx`
          UPDATE credit_reservations SET committed_micro = ${String(BOUND_MICRO)}::bigint
           WHERE id = ${reservationId}::uuid`;
      });
      const rows = await modelCallRows(db(), reservationId);
      expect(rows.map((c) => [c.sent, c.settleBasis, c.chargedMicro])).toEqual([
        [true, null, null],
        [false, 'never_sent', 0],
      ]);
    });

    it('⛔ CRITICAL a call’s `seq` is unique within its task and the DATABASE says so. Two admissions racing on one task are serialized by the row lock the admission takes, and if they ever were not, the second would be refused rather than reuse a number', async () => {
      const h = harness();
      const { reservationId } = await taskOn(h);
      const first = await admit(h, reservationId);
      if (first.outcome !== 'admitted') throw new Error('unreachable');

      const clash = await refusal(
        () => db()`
          INSERT INTO credit_model_calls (id, reservation_id, account_id, seq, purpose, model,
                                          input_bound_tokens, input_bound_basis, input_bound_micro,
                                          max_output_tokens, bound_micro)
          SELECT ${randomUUID()}::uuid, reservation_id, account_id, seq, 'plan', model,
                 100, 'region_bytes', 1000, 4096, 2000
            FROM credit_model_calls WHERE id = ${first.callId}::uuid`,
        'a second call with the same sequence number',
      );
      expect(clash.code).toBe('23505');
      expect(clash.constraint).toBe('credit_model_calls_seq_unique');
    });

    it('⛔ CRITICAL two connections admitting at once never both fit into room for one. Three calls fit in a 60-credit task; eight attempts racing on separate clients admit exactly three, and the task’s committed total never passes what it reserved', async () => {
      const h = harness(8);
      const { reservationId } = await taskOn(h);

      const results = await Promise.all(Array.from({ length: 8 }, () => admit(h, reservationId)));
      const admitted = results.filter((r) => r.outcome === 'admitted');
      expect(admitted).toHaveLength(3);
      expect(
        results.filter((r) => r.outcome === 'refused').every((r) => r.reason === 'did_not_fit'),
        'a refusal under contention was reported as something other than "it did not fit"',
      ).toBe(true);

      const counters = await reservationCounters(db(), reservationId);
      expect(counters.committedMicro).toBe(3 * BOUND_MICRO);
      expect(counters.committedMicro).toBeLessThanOrEqual(counters.reservedMicro);
      const seqs = (await modelCallRows(db(), reservationId)).map((c) => c.seq);
      expect(seqs, 'the sequence numbers were not 1, 2, 3').toEqual([1, 2, 3]);
    });

    it('CRITICAL the fit ladder runs against the task’s OWN room and its PINNED card: three calls in, the plan comes back on a lower ceiling, and after that it refuses', async () => {
      const h = harness();
      const { reservationId } = await taskOn(h);
      const first = await h.service.planCall({
        reservationId,
        purpose: 'plan',
        regions: REGIONS,
        historyBytes: 0,
      });
      expect(first.outcome).toBe('planned');
      if (first.outcome !== 'planned') throw new Error('unreachable');
      expect(first.model).toBe(ON_CREDITS_MODEL);
      expect(first.roomMicro).toBe(60 * MICRO);
      expect(first.decision.rung).toBe('ceiling');

      for (let i = 0; i < 3; i += 1) await admit(h, reservationId);
      const spent = await h.service.planCall({
        reservationId,
        purpose: 'plan',
        regions: REGIONS,
        historyBytes: 0,
      });
      if (spent.outcome !== 'planned') throw new Error('unreachable');
      expect(spent.roomMicro).toBe(60 * MICRO - 3 * BOUND_MICRO);
      expect(
        spent.decision.rung,
        'a task with 2.9 credits left cannot buy a 1,024-token reply',
      ).toBe('refuse');

      // A task whose whole reservation is 10 credits — the account had no more —
      // fits the same body only once the reply ceiling comes down.
      const small = await taskOn(h, 10);
      expect(small.reservedMicro).toBe(10 * MICRO);
      const tight = await h.service.planCall({
        reservationId: small.reservationId,
        purpose: 'plan',
        regions: REGIONS,
        historyBytes: 0,
      });
      if (tight.outcome !== 'planned') throw new Error('unreachable');
      expect(tight.roomMicro).toBe(10 * MICRO);
      expect(tight.decision.rung).toBe('lower_output');
      if (tight.decision.rung !== 'lower_output') throw new Error('unreachable');
      expect(tight.decision.maxOutputTokens).toBe(3_680);
      expect(tight.decision.bound.boundMicro).toBe(INPUT_MICRO + 3_680 * 2_000);
      expect(tight.decision.bound.boundMicro).toBeLessThanOrEqual(tight.roomMicro);

      // …and the bound it handed up is admitted, which is the whole contract
      // between the ladder and the statement that re-checks it.
      const fitted = await h.service.admitCall({
        reservationId: small.reservationId,
        purpose: 'plan',
        model: tight.model,
        bound: {
          inputBoundTokens: tight.decision.bound.inputBoundTokens,
          inputBoundMicro: tight.decision.bound.inputBoundMicro,
          maxOutputTokens: tight.decision.maxOutputTokens,
          boundMicro: tight.decision.bound.boundMicro,
          basis: 'region_bytes',
        },
        callId: randomUUID(),
      });
      expect(fitted.outcome).toBe('admitted');
    });

    it('CRITICAL planning against a task that is gone, settled or past its ceiling says so rather than pricing a call nobody can make', async () => {
      const h = harness();
      const { reservationId } = await taskOn(h);
      await h.service.settle(reservationId, 'completed');
      const plan = { purpose: 'plan' as const, regions: REGIONS, historyBytes: 0 };
      expect(await h.service.planCall({ reservationId, ...plan })).toEqual({
        outcome: 'unavailable',
        reason: 'settled',
      });
      expect(await h.service.planCall({ reservationId: randomUUID(), ...plan })).toEqual({
        outcome: 'unavailable',
        reason: 'gone',
      });
    });

    it('CRITICAL a SHADOW task is always planned at the full ceiling, whatever room it has left — the measurement is of the load, not of the limit', async () => {
      const h = harness();
      const accountId = await newTaskAccount(db());
      await fundedTaskLot(db(), accountId, { credits: 100 });
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
      await admit(h, reservationId, { bound: { ...BOUND, boundMicro: 100 * MICRO } });

      const plan = await h.service.planCall({
        reservationId,
        purpose: 'plan',
        regions: REGIONS,
        historyBytes: 0,
      });
      if (plan.outcome !== 'planned') throw new Error('unreachable');
      expect(plan.roomMicro, 'the shadow task is already over its reservation').toBeLessThan(0);
      expect(plan.decision.rung).toBe('ceiling');
      if (plan.decision.rung !== 'ceiling') throw new Error('unreachable');
      expect(plan.decision.maxOutputTokens).toBe(8_192);
    });

    it("⛔ CRITICAL a SHADOW task whose MODEL the pinned card does not price is UNAVAILABLE to plan, not a corruption to throw on — the measurement that records `would_refuse_reason = 'model'` reserves nothing, and every attempt of that turn asks this next", async () => {
      const h = harness();
      const accountId = await newTaskAccount(db());
      await fundedTaskLot(db(), accountId, { credits: 100 });
      const reservationId = randomUUID();
      const measured = await h.service.reserve({
        accountId,
        reservationId,
        agentSessionId: `as_${reservationId}`,
        idempotencyKey: null,
        model: OWN_KEY_ONLY_MODEL,
        mode: 'shadow',
        bootId: BOOT,
      });
      expect(measured.outcome).toBe('shadowed');
      if (measured.outcome !== 'shadowed') throw new Error('unreachable');
      expect(measured.wouldRefuseReason).toBe('model');
      expect(measured.reservedMicro).toBe(0);

      expect(
        await h.service.planCall({
          reservationId,
          purpose: 'plan',
          regions: REGIONS,
          historyBytes: 0,
        }),
      ).toEqual({ outcome: 'unavailable', reason: 'model' });

      // THE CONTROL, in the same breath: a shadow task on a model the card DOES
      // price is still planned at the ceiling, so "unavailable" above is about
      // the model and not about the mode.
      const priced = randomUUID();
      await h.service.reserve({
        accountId,
        reservationId: priced,
        agentSessionId: `as_${priced}`,
        idempotencyKey: null,
        model: ON_CREDITS_MODEL,
        mode: 'shadow',
        bootId: BOOT,
      });
      const ok = await h.service.planCall({
        reservationId: priced,
        purpose: 'plan',
        regions: REGIONS,
        historyBytes: 0,
      });
      expect(ok.outcome).toBe('planned');
    });
  },
);
