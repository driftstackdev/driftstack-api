// S41 2026-07-07 (founder-approved: wire crypto activation) — account-tier
// activation for PAID crypto orders.
//
// Closes the S37-audit gap: when a NowPayments IPN drove an order to
// `paid`, applyIpnStatus fired the `crypto.order.paid` webhook (+ the
// receipt-email intent) but NO code path upgraded the account's tier —
// while the /api/billing-crypto docs and the dashboard select-tier
// modal both promise automatic activation. A paying crypto customer
// stayed on their old tier.
//
// This service is the production implementation of the
// CryptoOrderTierActivator seam on CryptoOrdersService. It REUSES the
// Stripe account-tier mechanism rather than inventing one:
//   - the tier write goes through StripeWebhooksRepo.setAccountTierIfUpgrade
//     (same `accounts.tier` column + the same FOR UPDATE row-lock
//     serialization as setAccountTier, with the upgrade decision made
//     INSIDE the transaction so a concurrent Stripe event can't be
//     clobbered by a stale crypto order);
//   - on a real change it mirrors StripeWebhooksService's fan-out:
//     auth-cache invalidation (tier takes effect on the next request,
//     not after the 30s cache TTL) + the `subscription.tier_changed`
//     lifecycle event, which pairs the audit-log emit (existing action
//     enum value — the same one Stripe uses) with the tier-changed
//     email at one call site (V-202b).
//
// Precedence / no-downgrade rule (the Stripe parallel): Stripe's
// handlers never let a STALE event downgrade an entitlement a fresher
// event granted — upsertSubscription's event-recency guard skips
// out-of-order events, and downgradeAccountTierToBestRemaining
// recomputes from the best remaining active subscription so a
// superseded subscription's cancel can't strand a paying customer.
// A crypto order has no subscription mirror row / event-recency
// signal to reuse directly, so the founder-approved equivalent is:
// APPLY the order's tier only when it is a strict upgrade over the
// account's current tier (the free tier ranks lowest, so "account on
// free" is always an upgrade); otherwise SKIP the write and log the
// skip loudly for ops reconciliation. Consequences:
//   - same tier already held (duplicate activation / re-purchase of
//     the current tier) → no-op: no flip-flop, no duplicate audit row
//     or email (mirrors Stripe's previousTier !== tier emit gate);
//   - account moved to a HIGHER tier after the order was minted (e.g.
//     a Stripe subscription started) → the stale order never
//     downgrades it (mirrors downgradeAccountTierToBestRemaining's
//     "best remaining entitlement wins" posture);
//   - enterprise (custom contract, no self-serve price) ranks highest
//     and is never overwritten by a self-serve crypto order.

import type { AccountTier } from '@driftstack/api-types';
import { AccountTierSchema } from '@driftstack/api-types';
import { TIER_MONTHLY_PRICE_CENTS } from '../lib/cost-defaults.js';
import type { Logger } from '../lib/logger.js';
import type { AccountLifecycleService } from './account-lifecycle.js';
import type { AuthCache } from './auth-cache.js';
import type { CryptoOrderTierActivationIntent, CryptoOrderTierActivator } from './crypto-orders.js';
import type { StripeWebhooksRepo } from './stripe-webhooks.js';

/**
 * S41 — narrow repo dependency: only the shared account-tier
 * conditional write (defined on StripeWebhooksRepo so the Drizzle repo
 * and the in-memory test twin stay compile-time-parity). Pick (not a
 * re-declared interface) so the two can never drift.
 */
export type CryptoTierActivationRepo = Pick<StripeWebhooksRepo, 'setAccountTierIfUpgrade'>;

/**
 * S41 — total order over tiers used by the upgrade-only rule. Ranks by
 * the canonical monthly selling price (lib/cost-defaults.ts
 * TIER_MONTHLY_PRICE_CENTS, which mirrors billing-crypto's
 * TIER_PRICE_CENTS + the customer-facing tier matrix):
 *   - `free` ranks 0 (below every purchasable tier);
 *   - the six self-serve paid tiers rank by their monthly price
 *     (prices are pairwise distinct, so equal rank ⇔ same tier);
 *   - any tier WITHOUT a self-serve price (`enterprise` today, plus
 *     any future unpriced tier) ranks +Infinity — conservative on
 *     purpose: a tier we can't price-rank must never be overwritten
 *     by a self-serve purchase.
 */
export function tierActivationRank(tier: AccountTier): number {
  if (tier === 'free') return 0;
  return TIER_MONTHLY_PRICE_CENTS[tier] ?? Number.POSITIVE_INFINITY;
}

/**
 * S41 — the single source of the upgrade-only decision, shared by BOTH
 * setAccountTierIfUpgrade implementations (DrizzleStripeWebhooksRepo +
 * the in-memory test twin) so the rule can't fork. Strict-greater:
 * the same tier is NOT an upgrade (idempotent no-op), and a
 * lower-or-unrankable purchase never downgrades.
 */
export function isCryptoTierUpgrade(currentTier: AccountTier, purchasedTier: AccountTier): boolean {
  return tierActivationRank(purchasedTier) > tierActivationRank(currentTier);
}

export class CryptoTierActivationService implements CryptoOrderTierActivator {
  constructor(
    private readonly repo: CryptoTierActivationRepo,
    private readonly logger: Logger,
    /**
     * When wired, a real tier change emits `subscription.tier_changed`
     * (audit row + tier-changed email at one call site — the same
     * dispatcher Stripe's handlers use). Optional + best-effort:
     * AccountLifecycleService.emit swallows its own failures.
     */
    private readonly accountLifecycle: AccountLifecycleService | null = null,
    /**
     * Invalidate the account's cached AccountContext on a real tier
     * change so the new tier (and its derived limits) takes effect on
     * the next authenticated request — mirrors StripeWebhooksService.
     * Optional + best-effort: a cache failure never fails activation.
     */
    private readonly authCache: AuthCache | null = null,
  ) {}

  async activateTierForPaidOrder(intent: CryptoOrderTierActivationIntent): Promise<void> {
    // The checkout route Zod-locks `product` to the six priced tiers, but
    // orders can predate that rule (legacy trial_pack rows) or be seeded by
    // ops tooling — validate defensively and NEVER write an unknown value
    // into accounts.tier. `free` and `enterprise` are not self-serve
    // purchasable (no TIER_MONTHLY_PRICE_CENTS entry), so they are rejected
    // here too rather than relying on rank arithmetic.
    const parsed = AccountTierSchema.safeParse(intent.product);
    if (!parsed.success || TIER_MONTHLY_PRICE_CENTS[parsed.data] === undefined) {
      this.logger.error(
        {
          component: 'crypto-tier-activation',
          event: 'crypto_paid_tier_activation_unactivatable_product',
          account_id: intent.account_id,
          order_id: intent.order_id,
          product: intent.product,
        },
        'crypto order paid with a product that is not an activatable tier — tier NOT applied; reconcile manually (integrity alarm)',
      );
      return;
    }
    const tier = parsed.data;
    // effectiveAt = the paid transition moment (mirrors Stripe's use of the
    // EVENT time, not the processing time). Falls back to now() if the ISO
    // string is malformed so the accounts.updated_at write never gets NaN.
    const parsedAt = new Date(intent.paid_at);
    const effectiveAt = Number.isNaN(parsedAt.getTime()) ? new Date() : parsedAt;

    // Atomic decide-and-write: the upgrade-only compare runs INSIDE the same
    // FOR UPDATE transaction as the tier write (see
    // DrizzleStripeWebhooksRepo.setAccountTierIfUpgrade), so a concurrent
    // Stripe-driven tier change and this activation serialize — no TOCTOU
    // window in which a stale crypto order could clobber a fresher upgrade.
    const { previousTier, applied } = await this.repo.setAccountTierIfUpgrade({
      accountId: intent.account_id,
      tier,
      at: effectiveAt,
    });

    if (applied) {
      // Real change — mirror StripeWebhooksService's fan-out order:
      // cache invalidation first, then the lifecycle emit.
      if (this.authCache !== null) {
        try {
          await this.authCache.invalidateAccount(intent.account_id);
        } catch {
          // Best-effort — the tier mutation is committed; a stale cache
          // entry TTLs out within CACHE_TTL_SEC (mirrors StripeWebhooksService).
        }
      }
      if (this.accountLifecycle !== null) {
        await this.accountLifecycle.emit(intent.account_id, {
          kind: 'subscription.tier_changed',
          fromTier: previousTier,
          toTier: tier,
          effectiveAt,
          cryptoOrderId: intent.order_id,
          cryptoPaymentId: intent.payment_id,
        });
      }
      this.logger.info(
        {
          component: 'crypto-tier-activation',
          event: 'crypto_paid_tier_activated',
          account_id: intent.account_id,
          order_id: intent.order_id,
          from_tier: previousTier,
          to_tier: tier,
        },
        'crypto order paid — account tier activated',
      );
      return;
    }

    if (previousTier === null) {
      // Order references an account we no longer track — should not happen
      // (the order bound account_id at checkout); loud alarm for ops.
      this.logger.error(
        {
          component: 'crypto-tier-activation',
          event: 'crypto_paid_tier_activation_account_missing',
          account_id: intent.account_id,
          order_id: intent.order_id,
          product: tier,
        },
        'crypto order paid but the account was not found — tier NOT applied (integrity alarm)',
      );
      return;
    }

    if (previousTier === tier) {
      // Idempotent no-op: the account already holds the purchased tier
      // (duplicate activation attempt, or a re-purchase of the current
      // tier). No write, no audit row, no email — mirrors Stripe's
      // previousTier !== tier emit gate.
      this.logger.info(
        {
          component: 'crypto-tier-activation',
          event: 'crypto_paid_tier_activation_noop',
          account_id: intent.account_id,
          order_id: intent.order_id,
          tier,
        },
        'crypto order paid for the tier the account already holds — no-op',
      );
      return;
    }

    // No-downgrade skip: the account's current tier out-ranks the order's
    // product (the tier changed after the order was minted — e.g. a Stripe
    // subscription started — or the account is enterprise). Loud + audited
    // in the ops sense (structured warn with every id needed to reconcile);
    // no customer-audit row is written because no account state changed and
    // no audit action exists for a skipped change (never invent enum values).
    this.logger.warn(
      {
        component: 'crypto-tier-activation',
        event: 'crypto_paid_tier_activation_skipped_no_downgrade',
        account_id: intent.account_id,
        order_id: intent.order_id,
        payment_id: intent.payment_id,
        current_tier: previousTier,
        purchased_tier: tier,
      },
      'crypto order paid for a LOWER tier than the account currently holds — skipped by the no-downgrade rule; reconcile with the customer (paid order recorded, tier unchanged)',
    );
  }
}
