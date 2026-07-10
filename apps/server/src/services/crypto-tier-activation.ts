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
export type CryptoTierActivationRepo = Pick<
  StripeWebhooksRepo,
  | 'activateCryptoEntitlement'
  // C3 — refund/chargeback clawback path (revokeTierForRefundedOrder): expire the
  // refunded order's entitlement, then reconcile the account tier to its best
  // remaining valid access via the SAME helper the expiry sweeper uses.
  | 'revokeCryptoEntitlementByOrderId'
  | 'downgradeAccountTierToBestRemaining'
>;

/**
 * C1 — how long a one-time crypto payment of a monthly price entitles the tier.
 * A crypto payment covers exactly TIER_MONTHLY_PRICE_CENTS (one month); 31 days
 * is ≥ every calendar month, so a non-refundable payment is never customer-
 * hostile at a month boundary. Fixed-length (not calendar arithmetic) for
 * auditability. A same-tier re-purchase STACKS onto the running expiry.
 */
export const CRYPTO_ENTITLEMENT_TERM_DAYS = 31;

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

    // C1 — record the crypto entitlement (with its 31-day term) AND apply the
    // tier if it's an upgrade, in ONE FOR UPDATE transaction (see
    // DrizzleStripeWebhooksRepo.activateCryptoEntitlement). Idempotent on
    // order_id, so a replay never double-extends; a stale order can never
    // clobber a fresher upgrade (the tier write is compare-gated).
    const { previousTier, applied, entitlementInserted, startsAt, expiresAt } =
      await this.repo.activateCryptoEntitlement({
        accountId: intent.account_id,
        orderId: intent.order_id,
        tier,
        paidAt: effectiveAt,
        termDays: CRYPTO_ENTITLEMENT_TERM_DAYS,
      });

    if (previousTier === null) {
      // Order references an account we no longer track — should not happen
      // (the order bound account_id at checkout); loud alarm for ops. No
      // entitlement was recorded (can't FK a missing account).
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

    if (!entitlementInserted) {
      // Replay of an already-recorded order — idempotent no-op (no re-extend,
      // no re-apply, no email). The original activation did all of it.
      this.logger.info(
        {
          component: 'crypto-tier-activation',
          event: 'crypto_paid_tier_activation_replay',
          account_id: intent.account_id,
          order_id: intent.order_id,
          tier,
          expires_at: expiresAt.toISOString(),
        },
        'crypto order paid — entitlement already recorded for this order (replay); no change',
      );
      return;
    }

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
          expires_at: expiresAt.toISOString(),
        },
        'crypto order paid — account tier activated',
      );
      return;
    }

    // Entitlement was recorded but the account tier was NOT raised. Two cases,
    // both now a real (deferred) grant rather than the old "no-op" / "reconcile"
    // dead ends — the entitlement floors the tier until it expires.
    if (previousTier === tier) {
      // Same-tier re-purchase: the entitlement window was EXTENDED (stacked
      // onto the running expiry). The account keeps the tier it already holds.
      this.logger.info(
        {
          component: 'crypto-tier-activation',
          event: 'crypto_paid_tier_activation_extended',
          account_id: intent.account_id,
          order_id: intent.order_id,
          tier,
          starts_at: startsAt.toISOString(),
          expires_at: expiresAt.toISOString(),
        },
        'crypto order paid for the tier the account already holds — entitlement extended',
      );
      return;
    }

    // Lower-tier purchase while the account holds a higher tier (e.g. a Stripe
    // sub started after the order was minted): the entitlement is RECORDED as a
    // floor — if the higher rail later lapses, the reconcile drops to this tier
    // (not straight to free) until the entitlement expires. No tier change now.
    this.logger.info(
      {
        component: 'crypto-tier-activation',
        event: 'crypto_paid_tier_activation_recorded_below_current',
        account_id: intent.account_id,
        order_id: intent.order_id,
        payment_id: intent.payment_id,
        current_tier: previousTier,
        purchased_tier: tier,
        expires_at: expiresAt.toISOString(),
      },
      'crypto order paid for a LOWER tier than the account currently holds — entitlement recorded as the floor until it expires; account tier unchanged',
    );
  }

  /**
   * C3 — refund/chargeback clawback for an ALREADY-PAID crypto order. Reverses
   * the entitlement grant activateTierForPaidOrder minted: it EXPIRES only the
   * refunded order's entitlement (bringing expires_at forward to `at`), then
   * reconciles the account tier to its best REMAINING valid access via the SAME
   * downgradeAccountTierToBestRemaining path the expiry sweeper uses. This is NOT
   * a naive downgrade to free: the reconcile floors against any live Stripe
   * subscription AND any OTHER still-valid crypto entitlement, so a refund of one
   * grant can't strand a customer who still holds concurrent paid access. On a
   * real tier change it mirrors the sweeper's fan-out EXACTLY — auth-cache
   * invalidation (new tier on the next request, not after the 30s TTL) then the
   * `subscription.tier_changed` lifecycle event (audit row + tier-changed email).
   *
   * Idempotent on IPN replay: the repo revoke only affects a still-unexpired row,
   * so a replayed refund finds it already expired → revoked:false → this no-ops
   * (no second reconcile, no second emit). The best-remaining reconcile is itself
   * a pure function of committed DB state (previousTier === appliedTier ⇒ no
   * emit), so even a replay that somehow reached the reconcile would not
   * double-fire.
   */
  async revokeTierForRefundedOrder(args: {
    account_id: string;
    order_id: string;
    at: Date;
  }): Promise<{
    revoked: boolean;
    previousTier: AccountTier | null;
    appliedTier: AccountTier | null;
  }> {
    const { revoked } = await this.repo.revokeCryptoEntitlementByOrderId({
      orderId: args.order_id,
      at: args.at,
    });
    if (!revoked) {
      // Already expired / replayed refund — the grant is not (or no longer) a
      // floor, so there is nothing to claw back. No-op, no emit.
      this.logger.info(
        {
          component: 'crypto-tier-activation',
          event: 'crypto_refund_clawback_noop',
          account_id: args.account_id,
          order_id: args.order_id,
        },
        'crypto refund clawback: entitlement already expired (replay or no active grant) — no change',
      );
      return { revoked: false, previousTier: null, appliedTier: null };
    }

    // Reconcile to best remaining — the just-expired row is excluded by the
    // helper's gt(expires_at, at) union, so the account drops to its best
    // remaining Stripe sub / other valid crypto entitlement / free. Mirrors the
    // expiry sweeper's downgrade + fan-out order (cache invalidate, then emit).
    const { previousTier, appliedTier } = await this.repo.downgradeAccountTierToBestRemaining({
      accountId: args.account_id,
      fallbackTier: 'free',
      at: args.at,
    });
    if (previousTier !== appliedTier) {
      if (this.authCache !== null) {
        try {
          await this.authCache.invalidateAccount(args.account_id);
        } catch {
          // Best-effort — the tier write is committed; a stale cache entry TTLs
          // out within CACHE_TTL_SEC (mirrors the sweeper / StripeWebhooksService).
        }
      }
      if (this.accountLifecycle !== null) {
        await this.accountLifecycle.emit(args.account_id, {
          kind: 'subscription.tier_changed',
          fromTier: previousTier,
          toTier: appliedTier,
          effectiveAt: args.at,
          cryptoOrderId: args.order_id,
        });
      }
      this.logger.info(
        {
          component: 'crypto-tier-activation',
          event: 'crypto_refund_tier_clawed_back',
          account_id: args.account_id,
          order_id: args.order_id,
          from_tier: previousTier,
          to_tier: appliedTier,
        },
        'crypto order refunded — entitlement revoked and account tier reconciled to best remaining',
      );
    } else {
      // Entitlement was revoked but the account tier did not move (a higher
      // Stripe sub / another valid crypto grant still floors it). No emit.
      this.logger.info(
        {
          component: 'crypto-tier-activation',
          event: 'crypto_refund_entitlement_revoked_tier_unchanged',
          account_id: args.account_id,
          order_id: args.order_id,
          tier: appliedTier,
        },
        'crypto order refunded — entitlement revoked; account still floored by other valid access, tier unchanged',
      );
    }
    return { revoked: true, previousTier, appliedTier };
  }
}
