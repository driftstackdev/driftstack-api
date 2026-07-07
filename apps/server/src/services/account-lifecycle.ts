// V-202c / V-202b — central dispatcher for customer-facing lifecycle
// events that pair an audit-log emit and/or a transactional email send.
//
// Per founder verdict (2026-05-05 ack of V-228 follow-up + V-202c ack):
// the V-202b/c wires use a single `emit(accountId, event)` abstraction
// so call sites stay consistent as the set of lifecycle events grows.
// V-202c landed `session.failed.first`. V-202b adds:
//   - `subscription.tier_changed` (paired audit emit + tier-changed email)
//
// Contract notes:
//   - Best-effort by design. Errors during dispatch are caught + logged
//     warn and never propagate to the calling service. The caller's
//     primary responsibility (handling the underlying customer event —
//     a webhook delivery, a Stripe handler, a session failure) must
//     never be blocked on lifecycle-side work.
//   - Dedup is handled per-event-kind. `session.failed.first` uses the
//     `accounts.first_failure_email_sent_at` column with an atomic
//     check-and-set; `subscription.tier_changed` short-circuits when
//     fromTier === toTier (Stripe sends `subscription.updated` for
//     non-tier mutations like payment-method swap).
//   - Email-preference opt-outs are honored via `EmailPreferencesService.shouldSend`.

import type { AccountTier } from '@driftstack/api-types';
import type { Logger } from '../lib/logger.js';
import type { EmailService } from './email.js';
import type { EmailPreferencesService } from './email-preferences.js';
import type { AccountAuditService } from './account-audit.js';

export interface AccountLifecycleRow {
  id: string;
  email: string;
  firstFailureEmailSentAt: Date | null;
  firstSuccessEmailSentAt: Date | null;
}

export interface AccountLifecycleRepo {
  /** Look up the per-account lifecycle context (email + dedup flags). */
  findForLifecycle(accountId: string): Promise<AccountLifecycleRow | null>;
  /**
   * Atomic dedup gate for `session.failed.first`. Sets
   * `first_failure_email_sent_at = at` IF AND ONLY IF the column is
   * currently NULL. Returns true when the caller won the race (proceed
   * with the email send), false when another concurrent caller had
   * already set it (skip the email).
   */
  markFirstFailureEmailSent(accountId: string, at: Date): Promise<boolean>;
  /**
   * V-304a — same atomic-check-and-set pattern as
   * `markFirstFailureEmailSent`, but for the first successful session.
   */
  markFirstSuccessEmailSent(accountId: string, at: Date): Promise<boolean>;
}

export type LifecycleEvent =
  | {
      kind: 'session.failed.first';
      sessionId: string;
      errorMessage: string;
    }
  | {
      kind: 'session.success.first';
      sessionId: string;
    }
  | {
      kind: 'subscription.tier_changed';
      /** null when the previous tier could not be resolved (account row missing). */
      fromTier: AccountTier | null;
      toTier: AccountTier;
      effectiveAt: Date;
      /** Stripe event metadata for cross-reference; passed through to audit payload.
       *  Optional since S41 2026-07-07 (founder-approved: wire crypto activation):
       *  a tier change can also be driven by a paid crypto order, which carries
       *  the crypto* fields below instead — exactly one source's metadata is set. */
      stripeEventType?: string;
      stripeEventId?: string;
      /** S41 — crypto-order metadata for cross-reference when the change was
       *  driven by a paid NowPayments order; passed through to audit payload. */
      cryptoOrderId?: string;
      cryptoPaymentId?: string | null;
    }
  | {
      // V-327 — fires when Stripe's `invoice.upcoming` webhook arrives
      // (~7 days before renewal). Email-only; no audit row (the
      // upcoming-charge isn't a state change, just a heads-up). Per
      // privacy.md §3.5 we disclose this trigger to customers under
      // "Information about your subscription".
      kind: 'subscription.renewal_reminder';
      amountCents: number;
      currency: string;
      renewalDate: Date;
      stripeEventId: string;
      stripeInvoiceId: string;
    };

export interface AccountLifecycleServiceConfig {
  /**
   * Base URL for the customer-facing docs surface, used to template
   * deep-links into specific sections from outbound emails. Trailing
   * slashes are stripped at construction time. e.g. `https://driftstack.dev/docs`.
   */
  docsBaseUrl: string;
  /**
   * V-202b — Stripe billing portal URL surfaced in tier-changed +
   * billing-* emails so customers can self-serve subscription
   * management. Same value as the billing service's `portalReturnUrl`.
   */
  billingPortalUrl: string;
  /**
   * V-304a — Customer dashboard URL surfaced in the first-successful-
   * session email. Same root as the verify-email / login URLs.
   */
  dashboardUrl: string;
}

export class AccountLifecycleService {
  private readonly docsBaseUrl: string;
  private readonly billingPortalUrl: string;
  private readonly dashboardUrl: string;

  constructor(
    private readonly repo: AccountLifecycleRepo,
    private readonly email: EmailService,
    private readonly emailPreferences: EmailPreferencesService,
    private readonly logger: Logger,
    config: AccountLifecycleServiceConfig,
    /**
     * V-202b — optional. When wired, `subscription.tier_changed`
     * dispatches both an audit-log entry AND the tier-changed email.
     * When null, the audit emit is skipped and only the email side
     * runs. Tests that don't exercise the audit path pass null.
     */
    private readonly accountAudit: AccountAuditService | null = null,
  ) {
    this.docsBaseUrl = config.docsBaseUrl.replace(/\/+$/, '');
    this.billingPortalUrl = config.billingPortalUrl;
    this.dashboardUrl = config.dashboardUrl;
  }

  async emit(accountId: string, event: LifecycleEvent): Promise<void> {
    try {
      switch (event.kind) {
        case 'session.failed.first':
          await this.handleSessionFailedFirst(accountId, event);
          return;
        case 'session.success.first':
          await this.handleSessionSuccessFirst(accountId, event);
          return;
        case 'subscription.tier_changed':
          await this.handleTierChanged(accountId, event);
          return;
        case 'subscription.renewal_reminder':
          await this.handleRenewalReminder(accountId, event);
          return;
      }
    } catch (err) {
      this.logger.warn(
        {
          component: 'account-lifecycle',
          accountId,
          eventKind: event.kind,
          err:
            err instanceof Error
              ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
              : { value: err },
        },
        'lifecycle event dispatch failed (best-effort, swallowed)',
      );
    }
  }

  private async handleSessionFailedFirst(
    accountId: string,
    event: { sessionId: string; errorMessage: string },
  ): Promise<void> {
    const account = await this.repo.findForLifecycle(accountId);
    if (account === null) return;
    if (account.firstFailureEmailSentAt !== null) return;

    const allowed = await this.emailPreferences.shouldSend(accountId, 'session-failed-first');
    if (!allowed) return;

    // Atomic mark BEFORE send. If two concurrent first-failures race, the
    // second one's UPDATE finds the column already set and returns false;
    // the second caller skips the email. The successful caller then
    // does the email send. Worst case on email-service failure: one
    // first-failure passes silently (column set, email never sent) —
    // acceptable given the email is informational, not critical.
    const won = await this.repo.markFirstFailureEmailSent(accountId, new Date());
    if (!won) return;

    await this.email.sendSessionFailedFirst({
      to: account.email,
      sessionId: event.sessionId,
      errorMessage: event.errorMessage,
      docsUrl: `${this.docsBaseUrl}/sessions#failure-handling`,
    });
  }

  /**
   * V-304a — fires once per account on the first successful session.
   * Same atomic-check-and-set pattern as handleSessionFailedFirst.
   * The email celebrates the activation milestone + nudges the user
   * toward the dashboard / docs / next features.
   */
  private async handleSessionSuccessFirst(
    accountId: string,
    event: { sessionId: string },
  ): Promise<void> {
    const account = await this.repo.findForLifecycle(accountId);
    if (account === null) return;
    if (account.firstSuccessEmailSentAt !== null) return;

    const allowed = await this.emailPreferences.shouldSend(accountId, 'session-success-first');
    if (!allowed) return;

    const won = await this.repo.markFirstSuccessEmailSent(accountId, new Date());
    if (!won) return;

    await this.email.sendSessionSuccessFirst({
      to: account.email,
      sessionId: event.sessionId,
      dashboardUrl: this.dashboardUrl,
      docsUrl: `${this.docsBaseUrl}/quickstart`,
    });
  }

  private async handleTierChanged(
    accountId: string,
    event: {
      fromTier: AccountTier | null;
      toTier: AccountTier;
      effectiveAt: Date;
      stripeEventType?: string;
      stripeEventId?: string;
      cryptoOrderId?: string;
      cryptoPaymentId?: string | null;
    },
  ): Promise<void> {
    // Short-circuit no-op transitions — Stripe sends customer.subscription.updated
    // for non-tier mutations (payment-method swap, cancel-at-period-end toggle).
    // Spamming the audit log + email on those would defeat the point.
    if (event.fromTier === event.toTier) return;

    // Audit emit first (always wanted when wired). System actor because
    // the trigger is Stripe's webhook, not a customer action.
    // (S41: same rationale when the trigger is a paid crypto order's IPN.)
    if (this.accountAudit !== null) {
      try {
        await this.accountAudit.record({
          accountId,
          actorType: 'system',
          actorAccountId: null,
          actorKeyId: null,
          action: 'subscription.tier_changed',
          targetResourceId: null,
          payload: {
            from: event.fromTier,
            to: event.toTier,
            // Exactly one source's cross-reference metadata is present:
            // the Stripe webhook fields, or (S41) the paid crypto order's ids.
            ...(event.stripeEventType !== undefined
              ? {
                  stripe_event_type: event.stripeEventType,
                  stripe_event_id: event.stripeEventId,
                }
              : {}),
            ...(event.cryptoOrderId !== undefined
              ? {
                  crypto_order_id: event.cryptoOrderId,
                  crypto_payment_id: event.cryptoPaymentId ?? null,
                }
              : {}),
          },
        });
      } catch (err) {
        // Audit emit failures don't block the email path. The Stripe
        // event ledger still has the entry; loss of an audit row is
        // operationally noticeable but not customer-facing.
        this.logger.warn(
          {
            component: 'account-lifecycle',
            accountId,
            eventKind: 'subscription.tier_changed',
            err:
              err instanceof Error
                ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
                : { value: err },
          },
          'tier_changed audit emit failed (best-effort, swallowed)',
        );
      }
    }

    // Email send — opt-out aware.
    const allowed = await this.emailPreferences.shouldSend(accountId, 'tier-changed');
    if (!allowed) return;

    const account = await this.repo.findForLifecycle(accountId);
    if (account === null) return;

    await this.email.sendTierChanged({
      to: account.email,
      fromTier: event.fromTier ?? 'unknown',
      toTier: event.toTier,
      effectiveAt: event.effectiveAt,
      portalUrl: this.billingPortalUrl,
    });
  }

  /**
   * V-327 — fires on Stripe `invoice.upcoming` webhook (~7 days before
   * renewal). Email-only — no audit row (the upcoming-charge isn't a
   * state change, just a heads-up). Honors the
   * `billing-renewal-reminder` opt-out. The dispatcher does NOT dedupe
   * by stripeEventId; Stripe redelivers events only on handler failure
   * (non-2xx response), and our handler returns 'handled' synchronously
   * after the email enqueue. A duplicate email costs less than the
   * dedup-table machinery, so we accept the worst-case noise.
   */
  private async handleRenewalReminder(
    accountId: string,
    event: {
      amountCents: number;
      currency: string;
      renewalDate: Date;
      stripeEventId: string;
      stripeInvoiceId: string;
    },
  ): Promise<void> {
    const allowed = await this.emailPreferences.shouldSend(accountId, 'billing-renewal-reminder');
    if (!allowed) return;

    const account = await this.repo.findForLifecycle(accountId);
    if (account === null) return;

    const amountFormatted = formatCents(event.amountCents, event.currency);

    await this.email.sendBillingRenewalReminder({
      to: account.email,
      amountFormatted,
      renewalDate: event.renewalDate,
      portalUrl: this.billingPortalUrl,
    });
  }
}

/**
 * V-327 helper — format Stripe-style cents + currency into a
 * customer-facing string. Stripe currencies are ISO 4217 lowercase
 * codes; cents are integers in the smallest unit (USD: cents,
 * JPY: yen — JPY uses the same integer count but no fractional digit
 * scaling). Handles the common cases; falls back to "X.XX <CODE>" for
 * unknown currencies so the email always renders something useful.
 */
function formatCents(cents: number, currency: string): string {
  const code = currency.toUpperCase();
  // Zero-decimal currencies per Stripe's docs:
  // https://stripe.com/docs/currencies#zero-decimal
  const ZERO_DEC = new Set([
    'BIF',
    'CLP',
    'DJF',
    'GNF',
    'JPY',
    'KMF',
    'KRW',
    'MGA',
    'PYG',
    'RWF',
    'UGX',
    'VND',
    'VUV',
    'XAF',
    'XOF',
    'XPF',
  ]);
  if (ZERO_DEC.has(code)) {
    return `${cents.toLocaleString('en-US')} ${code}`;
  }
  const dollars = (cents / 100).toFixed(2);
  if (code === 'USD') return `$${dollars}`;
  if (code === 'EUR') return `€${dollars}`;
  if (code === 'GBP') return `£${dollars}`;
  return `${dollars} ${code}`;
}
