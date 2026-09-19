// Monthly credits are spent before goodwill, and goodwill before top-ups.
//
// Included credits expire at the month's end, so spending them first wastes
// nothing; bought credits last twelve months, so they go last. Within a rank the
// soonest expiry goes first, then the oldest, then the id — one fixed order, so
// the same balance is always drawn down the same way. The rank is what the
// database stores beside each lot, so the values are pinned, not just the order.

import { describe, expect, it } from 'vitest';
import {
  CREDIT_LOT_EXTRA_KIND,
  CREDIT_LOT_KINDS,
  CREDIT_LOT_SPEND_RANK,
  compareLotsInSpendOrder,
  type LotSpendOrderKey,
} from '../src/ai-credits.js';
import { seededRandom } from './_helpers/seeded-random.js';

const at = (s: string): Date => new Date(s);

describe('monthly credits are spent before goodwill, and goodwill before top-ups', () => {
  it('ranks: included credits (monthly and plan-change share) 0, goodwill 1, bought 2', () => {
    expect(CREDIT_LOT_SPEND_RANK).toEqual({ monthly: 0, proration: 0, adjustment: 1, top_up: 2 });
    expect(Object.keys(CREDIT_LOT_SPEND_RANK).sort()).toEqual([...CREDIT_LOT_KINDS].sort());
    expect(Object.isFrozen(CREDIT_LOT_SPEND_RANK)).toBe(true);
  });

  it('the rank decides before expiry: a top-up that expires first is still spent last', () => {
    const lots: LotSpendOrderKey[] = [
      {
        kind: 'top_up',
        expiresAt: at('2027-02-01T00:00:00Z'),
        createdAt: at('2026-02-01T00:00:00Z'),
        id: 'a',
      },
      {
        kind: 'adjustment',
        expiresAt: at('2027-01-20T00:00:00Z'),
        createdAt: at('2027-01-02T00:00:00Z'),
        id: 'b',
      },
      {
        kind: 'monthly',
        expiresAt: at('2027-02-15T00:00:00Z'),
        createdAt: at('2027-01-15T00:00:00Z'),
        id: 'c',
      },
      {
        kind: 'proration',
        expiresAt: at('2027-02-15T00:00:00Z'),
        createdAt: at('2027-01-20T00:00:00Z'),
        id: 'd',
      },
    ];
    expect([...lots].sort(compareLotsInSpendOrder).map((l) => `${l.kind}:${l.id}`)).toEqual([
      'monthly:c',
      'proration:d',
      'adjustment:b',
      'top_up:a',
    ]);
  });

  it('within a rank: soonest expiry, then oldest, then id', () => {
    const exp = at('2027-03-01T00:00:00Z');
    const lots: LotSpendOrderKey[] = [
      {
        kind: 'top_up',
        expiresAt: at('2027-06-01T00:00:00Z'),
        createdAt: at('2026-06-01T00:00:00Z'),
        id: 'x',
      },
      { kind: 'top_up', expiresAt: exp, createdAt: at('2026-03-01T00:00:00Z'), id: 'z' },
      { kind: 'top_up', expiresAt: exp, createdAt: at('2026-03-01T00:00:00Z'), id: 'y' },
      { kind: 'top_up', expiresAt: exp, createdAt: at('2026-02-01T00:00:00Z'), id: 'w' },
    ];
    expect([...lots].sort(compareLotsInSpendOrder).map((l) => l.id)).toEqual(['w', 'y', 'z', 'x']);
  });

  it('for generated balances: every included lot precedes every goodwill lot, which precedes every bought lot, and the order is total', () => {
    const rnd = seededRandom(0x5be4_0001);
    for (let i = 0; i < 500; i += 1) {
      const lots: LotSpendOrderKey[] = Array.from({ length: rnd.int(1, 12) }, (_, n) => ({
        kind: rnd.pick(CREDIT_LOT_KINDS),
        expiresAt: new Date(Date.UTC(2027, rnd.int(0, 11), rnd.int(1, 28))),
        createdAt: new Date(Date.UTC(2026, rnd.int(0, 11), rnd.int(1, 28))),
        id: `lot-${String(n)}`,
      }));
      const sorted = [...lots].sort(compareLotsInSpendOrder);
      const ranks = sorted.map((l) => CREDIT_LOT_SPEND_RANK[l.kind]);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      // Total: no two distinct lots compare equal, and the order does not depend on the input order.
      for (let j = 1; j < sorted.length; j += 1) {
        expect(compareLotsInSpendOrder(sorted[j - 1]!, sorted[j]!)).toBeLessThan(0);
      }
      expect([...lots].reverse().sort(compareLotsInSpendOrder)).toEqual(sorted);
    }
  });

  it('each non-monthly lot has a name customers see: a plan change, goodwill, or a top-up', () => {
    expect(CREDIT_LOT_EXTRA_KIND).toEqual({
      proration: 'plan_change',
      adjustment: 'goodwill',
      top_up: 'top_up',
    });
  });
});
