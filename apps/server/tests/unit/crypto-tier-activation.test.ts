// S41 2026-07-07 (founder-approved: wire crypto activation) — unit tests
// for the upgrade-only decision rule + CryptoTierActivationService.
//
// The integration suite (tests/integration/crypto-order-paid-tier-
// activation.test.ts) proves the end-to-end IPN flow; this file pins the
// MONEY-critical decision table (price-rank strict-greater; free lowest;
// enterprise/unpriced never overwritten; cross-ladder compares by price)
// and the service's fan-out/skip behaviour against a mock repo.

import { describe, expect, it, vi } from 'vitest';
import type { AccountTier } from '@driftstack/api-types';
import {
  CryptoTierActivationService,
  isCryptoTierUpgrade,
  tierActivationRank,
} from '../../src/services/crypto-tier-activation.js';
import type { Logger } from '../../src/lib/logger.js';
import type { AccountLifecycleService } from '../../src/services/account-lifecycle.js';
import type { AuthCache } from '../../src/services/auth-cache.js';

function makeLogger(): Logger & {
  errors: unknown[][];
  warns: unknown[][];
  infos: unknown[][];
} {
  const errors: unknown[][] = [];
  const warns: unknown[][] = [];
  const infos: unknown[][] = [];
  return {
    errors,
    warns,
    infos,
    error: (...args: unknown[]) => void errors.push(args),
    warn: (...args: unknown[]) => void warns.push(args),
    info: (...args: unknown[]) => void infos.push(args),
    debug: () => undefined,
    trace: () => undefined,
    fatal: () => undefined,
    child: function () {
      return this;
    },
  } as unknown as Logger & { errors: unknown[][]; warns: unknown[][]; infos: unknown[][] };
}

describe('S41 tierActivationRank', () => {
  it('free ranks 0 — below every purchasable tier', () => {
    expect(tierActivationRank('free')).toBe(0);
  });

  it('the six self-serve tiers rank by monthly price (pairwise distinct)', () => {
    const ranks = [
      'solo_manual',
      'api_starter',
      'team_manual',
      'api_builder',
      'agency_manual',
      'api_scale',
    ].map((t) => tierActivationRank(t as AccountTier));
    // $79 < $149 < $249 < $499 < $699 < $1,499 — strictly increasing.
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]!).toBeGreaterThan(ranks[i - 1]!);
    }
  });

  it('enterprise (no self-serve price) ranks +Infinity — never overwritable by a self-serve purchase', () => {
    expect(tierActivationRank('enterprise')).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('S41 isCryptoTierUpgrade decision table', () => {
  const cases: Array<[AccountTier, AccountTier, boolean]> = [
    // account on free → every paid tier applies
    ['free', 'solo_manual', true],
    ['free', 'api_scale', true],
    // real upgrades within + across ladders (price-ranked)
    ['solo_manual', 'api_builder', true],
    ['team_manual', 'agency_manual', true],
    ['api_starter', 'team_manual', true], // $149 → $249: cross-ladder upgrade
    // same tier — idempotent no-op, not an upgrade
    ['api_builder', 'api_builder', false],
    // downgrades never apply
    ['api_builder', 'solo_manual', false],
    ['api_scale', 'agency_manual', false], // $1,499 > $699 even cross-ladder
    ['team_manual', 'api_starter', false], // $249 > $149: cross-ladder downgrade
    // enterprise is never overwritten
    ['enterprise', 'api_scale', false],
    // purchasing "free" can never apply (rank 0 is never strictly greater)
    ['solo_manual', 'free', false],
    ['free', 'free', false],
  ];
  for (const [current, purchased, expected] of cases) {
    it(`${current} + purchased ${purchased} → ${expected ? 'apply' : 'skip'}`, () => {
      expect(isCryptoTierUpgrade(current, purchased)).toBe(expected);
    });
  }
});

describe('S41 CryptoTierActivationService', () => {
  const intent = {
    account_id: 'acc_1',
    order_id: 'ord_1',
    product: 'api_builder',
    payment_id: 'pay_1',
    paid_at: '2026-07-07T10:00:00.000Z',
  };

  function makeDeps(repoResult: { previousTier: AccountTier | null; applied: boolean }) {
    const repo = {
      setAccountTierIfUpgrade: vi.fn().mockResolvedValue(repoResult),
    };
    const emit = vi.fn().mockResolvedValue(undefined);
    const lifecycle = { emit } as unknown as AccountLifecycleService;
    const invalidateAccount = vi.fn().mockResolvedValue(undefined);
    const authCache = { invalidateAccount } as unknown as AuthCache;
    const logger = makeLogger();
    const service = new CryptoTierActivationService(repo, logger, lifecycle, authCache);
    return { repo, emit, invalidateAccount, logger, service };
  }

  it('applied → invalidates the auth cache + emits subscription.tier_changed with the crypto cross-reference', async () => {
    const d = makeDeps({ previousTier: 'free', applied: true });
    await d.service.activateTierForPaidOrder(intent);
    expect(d.repo.setAccountTierIfUpgrade).toHaveBeenCalledWith({
      accountId: 'acc_1',
      tier: 'api_builder',
      at: new Date('2026-07-07T10:00:00.000Z'),
    });
    expect(d.invalidateAccount).toHaveBeenCalledWith('acc_1');
    expect(d.emit).toHaveBeenCalledTimes(1);
    expect(d.emit).toHaveBeenCalledWith('acc_1', {
      kind: 'subscription.tier_changed',
      fromTier: 'free',
      toTier: 'api_builder',
      effectiveAt: new Date('2026-07-07T10:00:00.000Z'),
      cryptoOrderId: 'ord_1',
      cryptoPaymentId: 'pay_1',
    });
  });

  it('would-downgrade skip → no cache invalidation, no lifecycle emit, loud structured warn', async () => {
    const d = makeDeps({ previousTier: 'api_scale', applied: false });
    await d.service.activateTierForPaidOrder({ ...intent, product: 'solo_manual' });
    expect(d.invalidateAccount).not.toHaveBeenCalled();
    expect(d.emit).not.toHaveBeenCalled();
    expect(d.logger.warns.length).toBe(1);
    const [obj] = d.logger.warns[0] as [Record<string, unknown>];
    expect(obj.event).toBe('crypto_paid_tier_activation_skipped_no_downgrade');
    expect(obj.current_tier).toBe('api_scale');
    expect(obj.purchased_tier).toBe('solo_manual');
  });

  it('same-tier no-op → no emit, no warn (info only)', async () => {
    const d = makeDeps({ previousTier: 'api_builder', applied: false });
    await d.service.activateTierForPaidOrder(intent);
    expect(d.emit).not.toHaveBeenCalled();
    expect(d.logger.warns.length).toBe(0);
    expect(d.logger.errors.length).toBe(0);
  });

  it('account not found → integrity-alarm error log, no emit', async () => {
    const d = makeDeps({ previousTier: null, applied: false });
    await d.service.activateTierForPaidOrder(intent);
    expect(d.emit).not.toHaveBeenCalled();
    expect(d.logger.errors.length).toBe(1);
    const [obj] = d.logger.errors[0] as [Record<string, unknown>];
    expect(obj.event).toBe('crypto_paid_tier_activation_account_missing');
  });

  it('non-activatable product (legacy/ops-seeded) → repo NEVER called + integrity-alarm error log', async () => {
    for (const product of ['trial_pack', 'free', 'enterprise', 'not-a-tier']) {
      const d = makeDeps({ previousTier: 'free', applied: true });
      await d.service.activateTierForPaidOrder({ ...intent, product });
      expect(d.repo.setAccountTierIfUpgrade).not.toHaveBeenCalled();
      expect(d.emit).not.toHaveBeenCalled();
      expect(d.logger.errors.length).toBe(1);
      const [obj] = d.logger.errors[0] as [Record<string, unknown>];
      expect(obj.event).toBe('crypto_paid_tier_activation_unactivatable_product');
    }
  });

  it('malformed paid_at falls back to now() — the tier write never gets an Invalid Date', async () => {
    const d = makeDeps({ previousTier: 'free', applied: true });
    const before = Date.now();
    await d.service.activateTierForPaidOrder({ ...intent, paid_at: 'garbage' });
    const arg = d.repo.setAccountTierIfUpgrade.mock.calls[0]![0] as { at: Date };
    expect(Number.isNaN(arg.at.getTime())).toBe(false);
    expect(arg.at.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('auth-cache failure never blocks activation (lifecycle still emits)', async () => {
    const d = makeDeps({ previousTier: 'free', applied: true });
    d.invalidateAccount.mockRejectedValueOnce(new Error('redis down'));
    await d.service.activateTierForPaidOrder(intent);
    expect(d.emit).toHaveBeenCalledTimes(1);
  });
});
