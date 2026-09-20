// A task cut off by a crash, a deploy or a hang is settled from what it
// recorded — and nothing leaks (§4.7, §5.3, H6, M1).
//
// §5.3 calls the crash path the MAIN path. A deploy SIGTERMs the process while
// turns that run for minutes are still going, and the drain gives up after ten
// seconds. So the ordinary end of a task is "the process running it went away",
// and what happens then is this file's subject.
//
// Five claims, each against real Postgres, real reservations, real holds and
// real model calls:
//
//   · A SECOND BOOT NEVER SETTLES A LIVE TASK (H6). There is no single-process
//     flag, so a canary, a manual `node dist/index.js` during an incident and a
//     deploy that starts the new process while the old one still serves are all
//     ordinary — and none of them may charge a running turn its full bound.
//     Asked twice: once against a task whose lease is live, and once against a
//     STALE candidate whose lease was renewed after the keeper read it, which
//     is the only case the claim under the row lock exists for.
//   · TEARDOWN FREES A DYING PROCESS'S SLOTS AT THE NEXT BOOT. Expiring the
//     leases is not settling the tasks; it is what makes them due at once
//     instead of 90 seconds later.
//   · A FAILED SETTLE IS FINISHED BY THE KEEPER. A settle that rolls back leaves
//     the task exactly as it was, and the route's finally still removes it from
//     the live set (M1) — so the lease lapses and the keeper finishes it. While
//     it is still in the live set the keeper RENEWS it instead, which is the
//     other half of the same rule.
//   · A STUCK TURN IS SETTLED AT ITS CEILING and cannot admit another call. Both
//     halves matter: before the keeper reaches it the admission already refuses
//     with `max_age`, and after, with `settled`.
//   · TWO KEEPERS RACING SETTLE EACH TASK ONCE, on separate connections, and
//     each takes the account's credit lock first — proved by holding that lock
//     from a third connection and watching the sweep wait.
//
// ⛔ A LAPSED LEASE IS WRITTEN, NOT WAITED FOR. A lease runs 90 seconds and a
// ceiling 30 minutes; a test that waited would be a test nobody runs. Setting
// `lease_expires_at` into the past is exactly what `expireLeasesOfOwner` does at
// teardown and exactly what the clock does on its own, and the reservation
// guard permits it — the lease is the one thing about a task that moves.

import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import type {
  CreditCallBound,
  LapsedCreditReservation,
} from '../../src/db/credit-reservations-repo.js';
import { AiCreditLeaseKeeper } from '../../src/services/ai-credit-lease-keeper.js';
import { openLedgerDatabase } from './_helpers/credit-ledger-fixtures.js';
import {
  MICRO,
  ON_CREDITS_MODEL,
  agedReservation,
  fundedTaskLot,
  holdRows,
  ledgerOf,
  lotState,
  modelCallRows,
  newTaskAccount,
  reservationCounters,
  reservationsHarness,
  startedCall,
  type ReservationsHarness,
} from './_helpers/credit-reservation-fixtures.js';

const ISOLATED_DB_NAME = 'driftstack_iso_credit_lease_keeper';
const RUN_DB_TESTS = Boolean(process.env.CI || process.env.DATABASE_URL);

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
  const db = await openLedgerDatabase(ISOLATED_DB_NAME, 8);
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

/** The keeper as bootstrap builds it: the real repos, the real settlement, one boot id. */
function keeperOn(
  h: ReservationsHarness,
  leaseOwner: string,
  over?: Partial<{
    lapsedReservations: (on: unknown, limit: number) => Promise<LapsedCreditReservation[]>;
  }>,
): AiCreditLeaseKeeper {
  return new AiCreditLeaseKeeper({
    ledger: h.ledger,
    reservations:
      over?.lapsedReservations === undefined
        ? h.reservations
        : Object.assign(Object.create(h.reservations) as typeof h.reservations, {
            lapsedReservations: over.lapsedReservations,
          }),
    settler: h.service,
    executor: h.database.db,
    leaseOwner,
  });
}

/** Reserve one task the ordinary way, through the service, for `bootId`. */
async function reserve(
  h: ReservationsHarness,
  accountId: string,
  bootId: string,
): Promise<{ reservationId: string; reservedMicro: number }> {
  const reservationId = randomUUID();
  const result = await h.service.reserve({
    accountId,
    reservationId,
    agentSessionId: `as_${reservationId}`,
    idempotencyKey: null,
    model: ON_CREDITS_MODEL,
    mode: 'enforce',
    bootId,
  });
  if (result.outcome !== 'reserved') {
    throw new Error(`the fixture could not reserve: ${JSON.stringify(result)}`);
  }
  return { reservationId, reservedMicro: result.reservedMicro };
}

/** The process stopped saying it was there: what 90 seconds of silence does, written. */
async function leaseLapses(reservationId: string): Promise<void> {
  await db()`
    UPDATE credit_reservations SET lease_expires_at = now() - interval '1 second'
     WHERE id = ${reservationId}::uuid`;
}

async function stateOf(reservationId: string): Promise<{ state: string; reason: string | null }> {
  const [row] = await db()<Array<{ state: string; settle_reason: string | null }>>`
    SELECT state, settle_reason FROM credit_reservations WHERE id = ${reservationId}::uuid`;
  if (row === undefined) throw new Error('reservation vanished');
  return { state: row.state, reason: row.settle_reason };
}

async function openEnforceCount(accountId: string): Promise<number> {
  const [row] = await db()<Array<{ n: string }>>`
    SELECT count(*)::text AS n FROM credit_reservations
     WHERE account_id = ${accountId}::uuid AND state = 'open' AND mode = 'enforce'`;
  return Number(row?.n ?? '-1');
}

async function leaseSecondsLeft(reservationId: string): Promise<number> {
  return (await reservationCounters(db(), reservationId)).leaseSecondsLeft;
}

describe.skipIf(!RUN_DB_TESTS)(
  'a task nobody came back for is settled from what it recorded',
  () => {
    it('CRITICAL H6 a second boot does NOT settle a live task, and every count it reports says so. The old design settled every task owned by another boot id, so the first canary, incident shell or overlapping deploy would have charged every running turn its full bound and ended it with “used all the AI credits set aside”.', async () => {
      const h = harness();
      const accountId = await newTaskAccount(db());
      const lotId = await fundedTaskLot(db(), accountId, { credits: 100 });
      const { reservationId } = await reserve(h, accountId, 'boot-the-one-still-running');
      const callId = await startedCall(db(), {
        reservationId,
        accountId,
        boundMicro: BOUND.boundMicro,
      });

      // A SECOND process boots against the same database and runs its boot pass.
      const second = keeperOn(harness(2), 'boot-the-second-process');
      expect(await second.bootPass()).toEqual({ settled: 0, skipped: 0, failed: 0 });

      expect(await stateOf(reservationId), 'the live task').toEqual({
        state: 'open',
        reason: null,
      });
      const [call] = await modelCallRows(db(), reservationId);
      expect(call?.state, 'its in-flight call must not have been charged its bound').toBe(
        'started',
      );
      expect(call?.id).toBe(callId);
      expect((await lotState(db(), lotId)).held, 'its credit is still held for it').toBeGreaterThan(
        0,
      );
    });

    it('CRITICAL H6 a candidate whose lease was renewed AFTER the keeper read it is skipped, not settled. The candidate read takes no lock, so between it and the settlement the process running the task can say “still here” — and only the re-check under the row lock can see that. This is the arm the claim exists for; the predicate on the candidate read alone cannot reach it.', async () => {
      const h = harness();
      const accountId = await newTaskAccount(db());
      await fundedTaskLot(db(), accountId, { credits: 100 });
      const { reservationId } = await reserve(h, accountId, 'boot-alive-after-all');

      // The stale read: a candidate list naming a task whose lease is LIVE.
      const stale: LapsedCreditReservation = {
        reservationId,
        accountId,
        reason: 'lease_expired',
      };
      const keeper = keeperOn(h, 'boot-the-sweeper', {
        lapsedReservations: () => Promise.resolve([stale]),
      });

      expect(await keeper.settleLapsed()).toEqual({ settled: 0, skipped: 1, failed: 0 });
      expect(await stateOf(reservationId)).toEqual({ state: 'open', reason: null });
    });

    it('CRITICAL teardown frees a dying process’s slots at the next boot: the leases are handed back, nothing is settled by that alone, and the next boot’s pass finishes every one of them — slots, held credit and charge. Without it a deploy leaves its customers three slots short for a further 90 seconds each.', async () => {
      const h = harness();
      const accountId = await newTaskAccount(db());
      const lotId = await fundedTaskLot(db(), accountId, { credits: 100 });
      const dying = keeperOn(h, 'boot-about-to-be-replaced');
      const first = await reserve(h, accountId, 'boot-about-to-be-replaced');
      const second = await reserve(h, accountId, 'boot-about-to-be-replaced');
      dying.add(first.reservationId);
      dying.add(second.reservationId);
      const heldWhileRunning = (await lotState(db(), lotId)).held;
      expect(heldWhileRunning, 'both tasks hold credit').toBe(
        first.reservedMicro + second.reservedMicro,
      );
      expect(await leaseSecondsLeft(first.reservationId)).toBeGreaterThan(60);

      // SIGTERM: the process hands its leases back on the way out.
      expect(await dying.releaseOwnLeases()).toBe(2);
      expect(await leaseSecondsLeft(first.reservationId)).toBeLessThanOrEqual(0);
      expect(
        await stateOf(first.reservationId),
        'handing a lease back settles nothing by itself',
      ).toEqual({ state: 'open', reason: null });

      // The replacement boots and runs its pass.
      const replacement = keeperOn(harness(2), 'boot-the-replacement');
      expect(await replacement.bootPass()).toEqual({ settled: 2, skipped: 0, failed: 0 });
      expect(await stateOf(first.reservationId)).toEqual({
        state: 'settled',
        reason: 'lease_expired',
      });
      expect(await stateOf(second.reservationId)).toEqual({
        state: 'settled',
        reason: 'lease_expired',
      });
      expect(await openEnforceCount(accountId), 'all three slots are free again').toBe(0);
      expect((await lotState(db(), lotId)).held, 'and nothing is held any more').toBe(0);
      expect(
        (await ledgerOf(db(), accountId)).filter((r) => r.kind === 'task_charge'),
        'neither task made a call, so neither is charged anything',
      ).toEqual([]);
    });

    it('CRITICAL M1 a failed settle is finished by the keeper, and only once its owner has let go. While the task is in the live set the keeper RENEWS its lease and settles nothing; after the route’s finally removes it — which it does whatever the settle returned — the lease lapses and the keeper charges exactly what the task’s one call cost.', async () => {
      const h = harness();
      const accountId = await newTaskAccount(db());
      const lotId = await fundedTaskLot(db(), accountId, { credits: 100 });
      const keeper = keeperOn(h, 'boot-the-owner');
      const { reservationId, reservedMicro } = await reserve(h, accountId, 'boot-the-owner');
      keeper.add(reservationId);

      const admitted = await h.service.admitCall({
        reservationId,
        purpose: 'plan',
        model: ON_CREDITS_MODEL,
        bound: BOUND,
        callId: randomUUID(),
      });
      if (admitted.outcome !== 'admitted') throw new Error('the fixture could not admit a call');
      expect(await h.service.markSent(admitted.callId)).toBe(true);
      const settledCall = await h.service.settleCall({
        callId: admitted.callId,
        basis: 'provider_usage',
        usage: {
          uncachedInput: 1_000,
          output: 500,
          cacheRead: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
        },
      });
      expect(settledCall.outcome).toBe('settled');
      const owed = settledCall.chargedMicro;
      expect(owed, 'the call really cost something').toBeGreaterThan(0);

      // THE SETTLE FAILS: the transaction it ran in rolls back.
      await expect(
        h.ledger.transaction(async (tx) => {
          await h.service.settleIn(tx, reservationId, 'completed');
          throw new Error('the process died between the settlement and its COMMIT');
        }),
      ).rejects.toThrow('died between');
      expect(await stateOf(reservationId), 'the rollback left the task exactly as it was').toEqual({
        state: 'open',
        reason: null,
      });

      // The lease lapses while the owner still lists it: the keeper RENEWS it.
      await leaseLapses(reservationId);
      const renewing = await keeper.tickOnce();
      expect(renewing, 'the owner still says it is running this task').toEqual({
        live: 1,
        renewed: 1,
        settled: 0,
        skipped: 0,
        failed: 0,
      });
      expect(await leaseSecondsLeft(reservationId)).toBeGreaterThan(60);

      // The route's finally runs — whatever settle returned (M1).
      keeper.remove(reservationId);
      expect(keeper.liveCount()).toBe(0);
      await leaseLapses(reservationId);
      expect(await keeper.tickOnce()).toEqual({
        live: 0,
        renewed: 0,
        settled: 1,
        skipped: 0,
        failed: 0,
      });

      const after = await reservationCounters(db(), reservationId);
      expect(after.state).toBe('settled');
      expect(after.chargedMicro, 'charged what its one call actually cost, not its bound').toBe(
        owed,
      );
      expect(owed, 'and that is well under what it reserved').toBeLessThan(reservedMicro);
      const charges = (await ledgerOf(db(), accountId)).filter((r) => r.kind === 'task_charge');
      expect(charges).toEqual([{ kind: 'task_charge', lotId, lotDelta: -owed, debtDelta: 0 }]);
      expect((await lotState(db(), lotId)).held).toBe(0);
      expect((await holdRows(db(), reservationId))[0]?.chargedMicro).toBe(owed);
    });

    it('CRITICAL M1 a stuck turn is settled at its ceiling and cannot admit another call. The ceiling is the backstop for every way a lease could be renewed for ever, so it must not depend on the lease: the keeper settles at `max_age`, the call the task left in flight is charged its bound, and the admission refuses both before (max_age) and after (settled).', async () => {
      const h = harness();
      const accountId = await newTaskAccount(db());
      const lotId = await fundedTaskLot(db(), accountId, { credits: 100 });
      const reservedMicro = 40 * MICRO;
      const reservationId = await agedReservation(db(), {
        accountId,
        lotId,
        reservedMicro,
        leaseOwner: 'boot-that-hung',
      });
      await startedCall(db(), { reservationId, accountId, boundMicro: 9 * MICRO, sent: true });

      const beforeSettling = await h.service.admitCall({
        reservationId,
        purpose: 'answer',
        model: ON_CREDITS_MODEL,
        bound: BOUND,
        callId: randomUUID(),
      });
      expect(beforeSettling, 'past its ceiling, no further call is admitted').toEqual({
        outcome: 'refused',
        reason: 'max_age',
        leftMicro: reservedMicro - 9 * MICRO,
      });

      const keeper = keeperOn(h, 'boot-the-sweeper');
      expect(await keeper.tickOnce()).toEqual({
        live: 0,
        renewed: 0,
        settled: 1,
        skipped: 0,
        failed: 0,
      });
      expect(await stateOf(reservationId)).toEqual({ state: 'settled', reason: 'max_age' });
      const [call] = await modelCallRows(db(), reservationId);
      expect(
        { basis: call?.settleBasis, charged: call?.chargedMicro },
        'a call that was sent and left no record is charged its whole bound',
      ).toEqual({ basis: 'no_record', charged: 9 * MICRO });
      expect((await reservationCounters(db(), reservationId)).chargedMicro).toBe(9 * MICRO);
      expect((await lotState(db(), lotId)).held).toBe(0);

      const afterSettling = await h.service.admitCall({
        reservationId,
        purpose: 'answer',
        model: ON_CREDITS_MODEL,
        bound: BOUND,
        callId: randomUUID(),
      });
      // ⛔ `leftMicro` IS ARITHMETIC ABOUT THE RECORD, NOT CREDIT ANYBODY MAY
      // SPEND. It is `reserved_micro - committed_micro` on the row, and a
      // settlement moves neither of those: the task's unused reservation went
      // back to the lot through the holds (`held` is 0 two lines above), and
      // this number is what it USED to have set aside. MEASURED — an earlier
      // draft of this arm asserted 0 and the database answered 31 credits. The
      // claim this arm makes is the `reason`; the amount is pinned beside it so
      // that a later slice changing what a refusal reports is a red test here
      // rather than a silent change of meaning under S10's copy.
      expect(afterSettling).toEqual({
        outcome: 'refused',
        reason: 'settled',
        leftMicro: reservedMicro - 9 * MICRO,
      });
    });

    it('CRITICAL two keepers on separate connections settle each abandoned task exactly once — the second finds every one of them already gone. Two settlements of one task would write two sets of task_charge rows and charge the customer twice; the account lock and the re-check under it are what make that impossible rather than unlikely.', async () => {
      const first = harness(4);
      const second = harness(4);
      const accountId = await newTaskAccount(db());
      const lotId = await fundedTaskLot(db(), accountId, { credits: 300 });
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const r = await agedReservation(db(), {
          accountId,
          lotId,
          reservedMicro: 10 * MICRO,
          leaseOwner: `boot-gone-${String(i)}`,
        });
        await startedCall(db(), {
          reservationId: r,
          accountId,
          boundMicro: 4 * MICRO,
          seq: 1,
          sent: true,
        });
        ids.push(r);
      }

      const [a, b] = await Promise.all([
        keeperOn(first, 'boot-keeper-a').settleLapsed(),
        keeperOn(second, 'boot-keeper-b').settleLapsed(),
      ]);
      expect(a.failed + b.failed, 'neither keeper failed').toBe(0);
      expect(a.settled + b.settled, 'each task settled exactly once across both keepers').toBe(3);
      expect(a.settled + a.skipped + b.settled + b.skipped, 'and both saw all three').toBe(6);

      for (const id of ids) {
        expect(await stateOf(id)).toEqual({ state: 'settled', reason: 'max_age' });
        expect((await reservationCounters(db(), id)).chargedMicro).toBe(4 * MICRO);
      }
      const charges = (await ledgerOf(db(), accountId)).filter((r) => r.kind === 'task_charge');
      expect(charges, 'three tasks, three charges — not six').toHaveLength(3);
      expect(charges.every((c) => c.lotDelta === -4 * MICRO)).toBe(true);
      expect((await lotState(db(), lotId)).held).toBe(0);
    });

    it('CRITICAL the sweep takes the account’s credit lock first and settles ONE ACCOUNT AT A TIME. Proved against a real second connection holding that lock: while it is held the sweep cannot settle the task on that account — nor the one behind it, because it works through them in order rather than in parallel — and the moment the lock is released both go through.', async () => {
      const h = harness(4);
      const held = await newTaskAccount(db());
      const behind = await newTaskAccount(db());
      const heldLot = await fundedTaskLot(db(), held, { credits: 100 });
      const behindLot = await fundedTaskLot(db(), behind, { credits: 100 });
      // `lapsedReservations` orders by lease, so the blocked account is first.
      const blocked = await agedReservation(db(), {
        accountId: held,
        lotId: heldLot,
        reservedMicro: 10 * MICRO,
      });
      await db()`
        UPDATE credit_reservations SET lease_expires_at = now() - interval '10 minutes'
         WHERE id = ${blocked}::uuid`;
      const following = await agedReservation(db(), {
        accountId: behind,
        lotId: behindLot,
        reservedMicro: 10 * MICRO,
      });
      await db()`
        UPDATE credit_reservations SET lease_expires_at = now() - interval '1 minute'
         WHERE id = ${following}::uuid`;

      let releaseLock = (): void => undefined;
      const lockReleased = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const lockHeld = db().begin(async (tx) => {
        await tx`SELECT 1 FROM credit_accounts WHERE account_id = ${held}::uuid FOR UPDATE`;
        await lockReleased;
      });

      const sweeping = keeperOn(h, 'boot-the-sweeper').settleLapsed();
      await new Promise((r) => setTimeout(r, 400));
      expect(await stateOf(blocked), 'the sweep is waiting on the account lock').toEqual({
        state: 'open',
        reason: null,
      });
      expect(
        await stateOf(following),
        'and the next account waits behind it — one account at a time, not in parallel',
      ).toEqual({ state: 'open', reason: null });

      releaseLock();
      await lockHeld;
      expect(await sweeping).toEqual({ settled: 2, skipped: 0, failed: 0 });
      expect((await stateOf(blocked)).state).toBe('settled');
      expect((await stateOf(following)).state).toBe('settled');
    });

    it('CRITICAL one task whose settlement throws is counted and the sweep carries on — the other tasks in the batch are still finished, and the tick itself never throws. A keeper that died on the first bad row would leave every task behind it holding a slot and its credit, which is the leak it exists to prevent.', async () => {
      const h = harness();
      const accountId = await newTaskAccount(db());
      const lotId = await fundedTaskLot(db(), accountId, { credits: 100 });
      const doomed = await agedReservation(db(), {
        accountId,
        lotId,
        reservedMicro: 10 * MICRO,
      });
      const healthy = await agedReservation(db(), {
        accountId,
        lotId,
        reservedMicro: 10 * MICRO,
      });
      const logged: Record<string, unknown>[] = [];
      const keeper = new AiCreditLeaseKeeper({
        ledger: h.ledger,
        reservations: h.reservations,
        settler: {
          settleIn: async (tx, reservationId, reason) => {
            if (reservationId === doomed) throw new Error('a lot this task held has vanished');
            return h.service.settleIn(tx, reservationId, reason);
          },
        },
        executor: h.database.db,
        leaseOwner: 'boot-the-sweeper',
        logger: {
          error: (obj: unknown) => logged.push(obj as Record<string, unknown>),
        } as never,
      });

      const swept = await keeper.settleLapsed();
      expect(swept).toEqual({ settled: 1, skipped: 0, failed: 1 });
      expect((await stateOf(healthy)).state, 'the task behind the bad one is finished').toBe(
        'settled',
      );
      expect((await stateOf(doomed)).state, 'and the bad one is left for the next tick').toBe(
        'open',
      );
      expect(logged.map((l) => l.event)).toEqual(['ai_credits_lease_settle_failed']);
      expect(
        JSON.stringify(logged),
        'the failure log names no account and no reservation',
      ).not.toContain(accountId);
    });
  },
);
