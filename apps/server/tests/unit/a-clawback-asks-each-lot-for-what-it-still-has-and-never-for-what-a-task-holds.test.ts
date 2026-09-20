// A clawback asks each lot for what it STILL HAS, and never for what a running
// task is holding.
//
// This is the part of a mid-month downgrade (and, later, of a refund) that
// decides whether a customer ends up in debt, so it is worth being able to
// state every case of it without a database. `planClawbackOfAmount` is pure:
// given the lots a clawback may take from, the amount, and how much credit the
// account's running tasks hold, it says what comes out of which lot and what is
// left over.
//
// Per lot, in the order it is offered (newest first for a plan change):
//
//   · it may be ASKED for at most what it EVER HELD — what it was granted, less
//     what expired out of it unspent. Credit that expired was never used, so
//     asking for it back would turn an untouched month into debt (finding H2).
//   · it may GIVE at most its FREE credit — what is left, less what a running
//     task holds. A task's credit is not taken out from under it.
//
// What was asked for and not given is the SHORTFALL. As much of it as the
// account's total held credit covers becomes a PENDING CLAIM, paid out of those
// credits when the tasks settle (S7); only the rest is debt (finding M5).
//
// ⛔ AND WHAT THE LOTS NEVER HELD IS NOT DEBT. If the lots cannot cover the
// amount, the remainder is simply not clawed: it is credit that was never
// granted, and billing the customer for it would be inventing a charge.
//
// The same arithmetic is exercised against Postgres, through a real downgrade,
// in `a-downgrade-takes-back-what-is-free-and-owes-only-what-was-spent`.

import { describe, expect, it } from 'vitest';
import { planClawbackOfAmount } from '../../src/services/credit-grants.js';
import type { ClawbackTargetLot } from '../../src/db/credit-windows-repo.js';

const MICRO = 1_000_000;

function lot(
  id: string,
  granted: number,
  over: Partial<ClawbackTargetLot> = {},
): ClawbackTargetLot {
  return {
    lotId: id,
    grantedMicro: granted * MICRO,
    expiredMicro: 0,
    remainingMicro: granted * MICRO,
    heldMicro: 0,
    ...over,
  };
}

describe('a clawback asks each lot for what it still has and never for what a task holds', () => {
  it('CRITICAL an untouched lot gives up exactly what is asked, and the account owes nothing', () => {
    expect(planClawbackOfAmount([lot('a', 30_000)], 13_500 * MICRO, 0)).toEqual({
      takes: [{ lotId: 'a', micro: 13_500 * MICRO }],
      clawedMicro: 13_500 * MICRO,
      shortfallMicro: 0,
      pendingMicro: 0,
      debtMicro: 0,
    });
  });

  it('CRITICAL it takes from the lots in the ORDER GIVEN and stops the moment it is satisfied — newest first for a plan change, so the credits granted last are the ones taken back first', () => {
    const plan = planClawbackOfAmount(
      [lot('newest', 13_500), lot('older', 3_000), lot('oldest', 1_000)],
      14_000 * MICRO,
      0,
    );

    expect(plan.takes).toEqual([
      { lotId: 'newest', micro: 13_500 * MICRO },
      { lotId: 'older', micro: 500 * MICRO },
    ]);
    expect(plan.clawedMicro).toBe(14_000 * MICRO);
    expect(plan.shortfallMicro).toBe(0);
  });

  it('CRITICAL a lot that has been SPENT gives what is left and the rest becomes debt — and it is debt, not a claim, because no task is holding anything', () => {
    const plan = planClawbackOfAmount(
      [lot('a', 30_000, { remainingMicro: 5_000 * MICRO })],
      13_500 * MICRO,
      0,
    );

    expect(plan).toEqual({
      takes: [{ lotId: 'a', micro: 5_000 * MICRO }],
      clawedMicro: 5_000 * MICRO,
      shortfallMicro: 8_500 * MICRO,
      pendingMicro: 0,
      debtMicro: 8_500 * MICRO,
    });
  });

  it('CRITICAL credit a running task HOLDS is neither taken nor written off: the lot gives up only its free part, and the shortfall the held credit covers becomes a pending claim', () => {
    const plan = planClawbackOfAmount(
      [lot('a', 30_000, { remainingMicro: 12_000 * MICRO, heldMicro: 10_000 * MICRO })],
      13_500 * MICRO,
      10_000 * MICRO,
    );

    // Free is 12,000 − 10,000 = 2,000. The other 11,500 could not be taken;
    // 10,000 of it is credit the account still has, held by a task.
    expect(plan).toEqual({
      takes: [{ lotId: 'a', micro: 2_000 * MICRO }],
      clawedMicro: 2_000 * MICRO,
      shortfallMicro: 11_500 * MICRO,
      pendingMicro: 10_000 * MICRO,
      debtMicro: 1_500 * MICRO,
    });
  });

  it('CRITICAL a wholly held lot gives up NOTHING and owes nothing: the whole claim waits for the tasks to settle', () => {
    expect(
      planClawbackOfAmount(
        [lot('a', 30_000, { heldMicro: 30_000 * MICRO })],
        13_500 * MICRO,
        30_000 * MICRO,
      ),
    ).toEqual({
      takes: [],
      clawedMicro: 0,
      shortfallMicro: 13_500 * MICRO,
      pendingMicro: 13_500 * MICRO,
      debtMicro: 0,
    });
  });

  it('CRITICAL credit that EXPIRED UNSPENT is never asked for, so a clawback over an untouched month creates no debt (H2): the lot is empty because its term ended, not because anybody used it', () => {
    // Granted 30,000, spent nothing, and 30,000 expired at the end of the month.
    const plan = planClawbackOfAmount(
      [lot('a', 30_000, { expiredMicro: 30_000 * MICRO, remainingMicro: 0 })],
      13_500 * MICRO,
      0,
    );

    expect(plan).toEqual({
      takes: [],
      clawedMicro: 0,
      shortfallMicro: 0,
      pendingMicro: 0,
      debtMicro: 0,
    });
  });

  it('what expired limits what is asked, lot by lot: 8,000 of a 30,000 lot expired, so at most 22,000 may ever be asked of it however large the clawback', () => {
    const plan = planClawbackOfAmount(
      [lot('a', 30_000, { expiredMicro: 8_000 * MICRO, remainingMicro: 4_000 * MICRO })],
      30_000 * MICRO,
      0,
    );

    // Asked 22,000 (30,000 − 8,000 expired), gave its 4,000, so 18,000 was
    // spent and is owed. The 8,000 that expired is not part of either figure.
    expect(plan.clawedMicro).toBe(4_000 * MICRO);
    expect(plan.shortfallMicro).toBe(18_000 * MICRO);
    expect(plan.debtMicro).toBe(18_000 * MICRO);
  });

  it('CRITICAL what the lots never held is not clawed and NOT OWED: a clawback larger than the whole window leaves no debt behind for credit that was never granted', () => {
    const plan = planClawbackOfAmount([lot('a', 3_000), lot('b', 1_000)], 500_000 * MICRO, 0);

    expect(plan.clawedMicro).toBe(4_000 * MICRO);
    expect(plan.shortfallMicro).toBe(0);
    expect(plan.debtMicro).toBe(0);
  });

  it('CRITICAL a lot that can give nothing is STEPPED OVER, not charged: what it could not give is asked of the next lot, so no debt is written while an older lot still holds free credit. (Reachable because a clawback empties lots newest first while every other consumer spends them oldest first, so a second clawback starts on a lot the first one emptied.)', () => {
    const plan = planClawbackOfAmount(
      [lot('emptied-by-an-earlier-clawback', 30_000, { remainingMicro: 0 }), lot('older', 5_000)],
      2_000 * MICRO,
      0,
    );

    expect(plan.takes).toEqual([{ lotId: 'older', micro: 2_000 * MICRO }]);
    expect(plan.shortfallMicro, 'the spent lot absorbed the whole ask').toBe(0);
    expect(plan.debtMicro).toBe(0);
  });

  it('CRITICAL and it is stepped over even when a task is holding credit: the shortfall would otherwise become a pending claim while the account had free credit one lot further back', () => {
    const plan = planClawbackOfAmount(
      [lot('newest', 8_000, { heldMicro: 8_000 * MICRO }), lot('older', 5_000)],
      4_000 * MICRO,
      8_000 * MICRO,
    );

    expect(plan.takes).toEqual([{ lotId: 'older', micro: 4_000 * MICRO }]);
    expect(plan.pendingMicro).toBe(0);
    expect(plan.debtMicro).toBe(0);
  });

  // ⚠️ A STATE THE DATABASE REFUSES TODAY: `credit_lots_remaining_bounds`
  // (0128) keeps `remaining_micro` at or below `granted_micro`, so no
  // adjustment can actually refill a lot past its grant. The arm stays because
  // the per-lot ceiling is what says WHOSE credit a clawback may take, and
  // that rule should not rest on one CHECK in one migration.
  it('a lot REFILLED above its grant by a support adjustment is still asked only for what its grant ever held; the rest of the claw moves on to the next lot', () => {
    const plan = planClawbackOfAmount(
      // Granted 1,000, then given 9,000 more as goodwill on the same lot.
      [lot('refilled', 1_000, { remainingMicro: 10_000 * MICRO }), lot('older', 5_000)],
      4_000 * MICRO,
      0,
    );

    expect(plan.takes).toEqual([
      { lotId: 'refilled', micro: 1_000 * MICRO },
      { lotId: 'older', micro: 3_000 * MICRO },
    ]);
  });

  it('no lots at all is a clawback of nothing: no takes, no debt, and no throw', () => {
    expect(planClawbackOfAmount([], 13_500 * MICRO, 0)).toEqual({
      takes: [],
      clawedMicro: 0,
      shortfallMicro: 0,
      pendingMicro: 0,
      debtMicro: 0,
    });
  });

  it('an amount that is not a positive whole number of microcredits is refused, and so is negative held credit — a clawback of nothing, or of a fraction of a microcredit, is a caller bug, not a no-op', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => planClawbackOfAmount([lot('a', 10)], bad, 0), String(bad)).toThrow(RangeError);
    }
    for (const bad of [-1, 0.5, Number.NaN, 2 ** 53]) {
      expect(() => planClawbackOfAmount([lot('a', 10)], MICRO, bad), String(bad)).toThrow(
        RangeError,
      );
    }
    // Zero held is ordinary, not an error: most accounts have no task running.
    expect(() => planClawbackOfAmount([lot('a', 10)], MICRO, 0)).not.toThrow();
  });

  it('CRITICAL WHAT IS TAKEN, CLAIMED AND OWED DOES NOT DEPEND ON THE ORDER THE LOTS ARE OFFERED IN, over 3,000 generated cases: only WHICH lot is emptied does. Two lots of one window written in the same transaction share a `created_at` to the microsecond, so "newest first" falls through to a uuid tiebreak and the order really is arbitrary — the money must not be', () => {
    let seed = 0x0d_e12a;
    const next = (n: number): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return Math.abs(seed) % n;
    };

    let reordered = 0;
    let differentTakes = 0;
    for (let c = 0; c < 3_000; c += 1) {
      const lots: ClawbackTargetLot[] = [];
      for (let i = 0; i < next(4) + 2; i += 1) {
        const granted = (next(40) + 1) * 100 * MICRO;
        const expired = next(2) === 0 ? 0 : next(granted / MICRO + 1) * MICRO;
        const remaining = next(granted / MICRO - expired / MICRO + 1) * MICRO;
        const held = next(remaining / MICRO + 1) * MICRO;
        lots.push({
          lotId: `l${String(i)}`,
          grantedMicro: granted,
          expiredMicro: expired,
          remainingMicro: remaining,
          heldMicro: held,
        });
      }
      const heldTotal = lots.reduce((n, l) => n + l.heldMicro, 0);
      const amount = (next(6_000) + 1) * MICRO;

      // Fisher-Yates over the same lots: the same set, a different order.
      const shuffled = [...lots];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = next(i + 1);
        const a = shuffled[i];
        const b = shuffled[j];
        if (a !== undefined && b !== undefined) {
          shuffled[i] = b;
          shuffled[j] = a;
        }
      }
      if (shuffled.some((l, i) => l.lotId !== lots[i]?.lotId)) reordered += 1;

      const one = planClawbackOfAmount(lots, amount, heldTotal);
      const other = planClawbackOfAmount(shuffled, amount, heldTotal);

      const money = (p: ReturnType<typeof planClawbackOfAmount>) => ({
        clawedMicro: p.clawedMicro,
        shortfallMicro: p.shortfallMicro,
        pendingMicro: p.pendingMicro,
        debtMicro: p.debtMicro,
      });
      expect(money(other), `case ${String(c)}: the order changed the money`).toEqual(money(one));
      // The takes themselves may legitimately differ — a different lot is
      // emptied — but their total is the same number, and every lot in a
      // window expires with it, so the customer's balance is unchanged.
      const total = (p: ReturnType<typeof planClawbackOfAmount>) =>
        p.takes.reduce((n, t) => n + t.micro, 0);
      expect(total(other)).toBe(total(one));
      const key = (p: ReturnType<typeof planClawbackOfAmount>) =>
        [...p.takes]
          .sort((x, y) => (x.lotId < y.lotId ? -1 : 1))
          .map((t) => `${t.lotId}:${String(t.micro)}`)
          .join(',');
      if (key(other) !== key(one)) differentTakes += 1;
    }

    // POSITIVE CONTROL. If the shuffle never reordered anything, or every case
    // landed on one lot, the equality above would hold trivially.
    expect(reordered, 'the shuffle never reordered a case').toBeGreaterThan(2_000);
    expect(
      differentTakes,
      'no generated case took from different lots under a different order — the property was never actually exercised',
    ).toBeGreaterThan(100);
  });

  it('CRITICAL every invariant holds over 3,000 generated cases: no take exceeds a lot’s free credit or what it ever held, the takes sum to what was clawed, the claim plus the debt is exactly the shortfall, and the claim never exceeds the account’s held credit', () => {
    let seed = 0x5eed_1234;
    const next = (n: number): number => {
      // xorshift32: a fixed sequence, so a failure here is reproducible.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return Math.abs(seed) % n;
    };

    const seen = { debt: 0, pending: 0, freeCapped: 0, askableCapped: 0, satisfied: 0, skipped: 0 };
    for (let c = 0; c < 3_000; c += 1) {
      const lots: ClawbackTargetLot[] = [];
      for (let i = 0; i < next(4) + 1; i += 1) {
        const granted = (next(40) + 1) * 100 * MICRO;
        const expired = next(2) === 0 ? 0 : next(granted / MICRO + 1) * MICRO;
        const remaining = next(granted / MICRO - expired / MICRO + 1) * MICRO;
        const held = next(remaining / MICRO + 1) * MICRO;
        lots.push({
          lotId: `l${String(i)}`,
          grantedMicro: granted,
          expiredMicro: expired,
          remainingMicro: remaining,
          heldMicro: held,
        });
      }
      const heldTotal = lots.reduce((n, l) => n + l.heldMicro, 0);
      const amount = (next(6_000) + 1) * MICRO;
      const plan = planClawbackOfAmount(lots, amount, heldTotal);

      const byId = new Map(lots.map((l) => [l.lotId, l]));
      const askable = lots.reduce((n, l) => n + (l.grantedMicro - l.expiredMicro), 0);
      let summed = 0;
      for (const take of plan.takes) {
        const l = byId.get(take.lotId);
        expect(l, take.lotId).toBeDefined();
        expect(take.micro, 'a zero take was recorded').toBeGreaterThan(0);
        expect(take.micro).toBeLessThanOrEqual(l!.remainingMicro - l!.heldMicro);
        expect(take.micro).toBeLessThanOrEqual(l!.grantedMicro - l!.expiredMicro);
        summed += take.micro;
      }
      expect(summed).toBe(plan.clawedMicro);
      expect(plan.pendingMicro + plan.debtMicro).toBe(plan.shortfallMicro);
      expect(plan.pendingMicro).toBeLessThanOrEqual(heldTotal);
      // Everything that was asked for was either taken or is a shortfall, and
      // the ask itself is the amount capped by what the lots ever held.
      expect(plan.clawedMicro + plan.shortfallMicro).toBe(Math.min(amount, askable));
      expect(plan.debtMicro).toBeGreaterThanOrEqual(0);
      expect(plan.shortfallMicro).toBeGreaterThanOrEqual(0);
      // A shortfall means no lot had anything left to give, anywhere.
      if (plan.shortfallMicro > 0) {
        const freeLeft = lots.reduce(
          (n, l) =>
            n +
            Math.min(Math.max(0, l.remainingMicro - l.heldMicro), l.grantedMicro - l.expiredMicro),
          0,
        );
        expect(plan.clawedMicro, 'a shortfall was booked with free credit still untouched').toBe(
          freeLeft,
        );
      }

      if (plan.debtMicro > 0) seen.debt += 1;
      if (plan.pendingMicro > 0) seen.pending += 1;
      if (plan.clawedMicro + plan.shortfallMicro === amount) seen.satisfied += 1;
      if (askable < amount) seen.askableCapped += 1;
      let reachedAGiver = false;
      for (const l of lots) {
        const free = Math.min(
          Math.max(0, l.remainingMicro - l.heldMicro),
          l.grantedMicro - l.expiredMicro,
        );
        const take = plan.takes.find((t) => t.lotId === l.lotId)?.micro ?? 0;
        if (take > 0 && take === free && free > 0) seen.freeCapped += 1;
        if (take > 0) reachedAGiver = true;
        // A lot that gave nothing, before one that gave something: the shape
        // the earlier walk got wrong.
        if (take === 0 && free === 0 && !reachedAGiver) seen.skipped += 1;
      }
    }

    // POSITIVE CONTROL. An easy generator would make every case one lot with
    // plenty of free credit, where every invariant above holds trivially. Each
    // of the interesting shapes must actually occur.
    expect(seen.debt, 'no generated case produced debt').toBeGreaterThan(100);
    expect(seen.pending, 'no generated case produced a pending claim').toBeGreaterThan(100);
    expect(seen.satisfied, 'no generated case was fully asked for').toBeGreaterThan(100);
    expect(seen.freeCapped, 'no generated take emptied a lot').toBeGreaterThan(50);
    expect(
      seen.askableCapped,
      'no generated clawback asked for more than the lots ever held',
    ).toBeGreaterThan(50);
    expect(
      seen.skipped,
      'no generated case put a lot that could give nothing before one that could',
    ).toBeGreaterThan(50);
  });
});
