// V-202c — unit tests for AccountLifecycleService.

import { describe, expect, it, vi } from 'vitest';
import {
  AccountLifecycleService,
  type AccountLifecycleRepo,
  type AccountLifecycleRow,
} from '../../src/services/account-lifecycle.js';
import { createTestLogger } from '../../src/lib/logger.js';
import type { EmailService } from '../../src/services/email.js';
import type { EmailPreferencesService } from '../../src/services/email-preferences.js';
import type { AccountAuditService } from '../../src/services/account-audit.js';

interface TestDeps {
  service: AccountLifecycleService;
  repo: TestRepo;
  email: {
    sendSessionFailedFirst: ReturnType<typeof vi.fn>;
    sendTierChanged: ReturnType<typeof vi.fn>;
  };
  prefs: { shouldSend: ReturnType<typeof vi.fn> };
  audit: { record: ReturnType<typeof vi.fn> };
}

class TestRepo implements AccountLifecycleRepo {
  private rows = new Map<string, AccountLifecycleRow>();
  markCallCount = 0;

  seed(row: AccountLifecycleRow): void {
    this.rows.set(row.id, { ...row });
  }

  read(id: string): AccountLifecycleRow | undefined {
    const r = this.rows.get(id);
    return r ? { ...r } : undefined;
  }

  findForLifecycle(accountId: string): Promise<AccountLifecycleRow | null> {
    const r = this.rows.get(accountId);
    return Promise.resolve(r ? { ...r } : null);
  }

  markFirstFailureEmailSent(accountId: string, at: Date): Promise<boolean> {
    this.markCallCount += 1;
    const r = this.rows.get(accountId);
    if (!r) return Promise.resolve(false);
    if (r.firstFailureEmailSentAt !== null) return Promise.resolve(false);
    this.rows.set(accountId, { ...r, firstFailureEmailSentAt: at });
    return Promise.resolve(true);
  }

  markFirstSuccessEmailSent(accountId: string, at: Date): Promise<boolean> {
    const r = this.rows.get(accountId);
    if (!r) return Promise.resolve(false);
    if (r.firstSuccessEmailSentAt !== null) return Promise.resolve(false);
    this.rows.set(accountId, { ...r, firstSuccessEmailSentAt: at });
    return Promise.resolve(true);
  }

  private billingClaims = new Set<string>();
  billingClaimCount = 0;

  claimBillingEmail(args: {
    stripeEventId: string;
    kind: 'billing-receipt' | 'billing-failure' | 'billing-renewal-reminder';
    accountId: string;
    at: Date;
  }): Promise<boolean> {
    this.billingClaimCount += 1;
    const key = `${args.stripeEventId}:${args.kind}`;
    if (this.billingClaims.has(key)) return Promise.resolve(false);
    this.billingClaims.add(key);
    return Promise.resolve(true);
  }
}

function build(opts: { firstFailureSent?: Date | null; shouldSend?: boolean } = {}): TestDeps {
  const repo = new TestRepo();
  repo.seed({
    id: 'acc_test',
    email: 'first-failure@driftstack.local',
    firstFailureEmailSentAt: opts.firstFailureSent ?? null,
    firstSuccessEmailSentAt: null,
  });

  const email = {
    sendSessionFailedFirst: vi.fn().mockResolvedValue(undefined),
    sendTierChanged: vi.fn().mockResolvedValue(undefined),
  };
  const prefs = {
    shouldSend: vi.fn().mockResolvedValue(opts.shouldSend ?? true),
  };
  const audit = {
    record: vi.fn().mockResolvedValue({}),
  };

  const service = new AccountLifecycleService(
    repo,
    email as unknown as EmailService,
    prefs as unknown as EmailPreferencesService,
    createTestLogger(),
    {
      docsBaseUrl: 'https://example.test/docs/',
      billingPortalUrl: 'https://example.test/billing',
      dashboardUrl: 'https://example.test',
    },
    audit as unknown as AccountAuditService,
  );
  return { service, repo, email, prefs, audit };
}

describe('AccountLifecycleService — session.failed.first', () => {
  it('sends the email + marks the dedup flag on first call', async () => {
    const { service, repo, email } = build();
    await service.emit('acc_test', {
      kind: 'session.failed.first',
      sessionId: 'ses_xxx',
      errorMessage: 'navigation timeout',
    });
    expect(email.sendSessionFailedFirst).toHaveBeenCalledTimes(1);
    expect(email.sendSessionFailedFirst).toHaveBeenCalledWith({
      to: 'first-failure@driftstack.local',
      sessionId: 'ses_xxx',
      errorMessage: 'navigation timeout',
      // trailing slash from input is stripped by the service.
      docsUrl: 'https://example.test/docs/sessions#failure-handling',
    });
    expect(repo.read('acc_test')?.firstFailureEmailSentAt).toBeInstanceOf(Date);
  });

  it('skips the email + does not mark when flag is already set', async () => {
    const { service, repo, email } = build({ firstFailureSent: new Date('2026-01-01T00:00:00Z') });
    await service.emit('acc_test', {
      kind: 'session.failed.first',
      sessionId: 'ses_yyy',
      errorMessage: 'driver crash',
    });
    expect(email.sendSessionFailedFirst).not.toHaveBeenCalled();
    expect(repo.markCallCount).toBe(0);
  });

  it('skips the email when customer has opted out of session-failed-first', async () => {
    const { service, repo, email, prefs } = build({ shouldSend: false });
    await service.emit('acc_test', {
      kind: 'session.failed.first',
      sessionId: 'ses_zzz',
      errorMessage: 'permission denied',
    });
    expect(email.sendSessionFailedFirst).not.toHaveBeenCalled();
    expect(prefs.shouldSend).toHaveBeenCalledWith('acc_test', 'session-failed-first');
    expect(repo.markCallCount).toBe(0); // didn't even attempt the mark
  });

  it('no-ops cleanly when account is unknown', async () => {
    const { service, email } = build();
    await service.emit('acc_unknown', {
      kind: 'session.failed.first',
      sessionId: 'ses_xxx',
      errorMessage: 'whatever',
    });
    expect(email.sendSessionFailedFirst).not.toHaveBeenCalled();
  });

  it('swallows email-service errors (best-effort contract)', async () => {
    const { service, repo, email } = build();
    email.sendSessionFailedFirst.mockRejectedValueOnce(new Error('postmark down'));
    await expect(
      service.emit('acc_test', {
        kind: 'session.failed.first',
        sessionId: 'ses_qqq',
        errorMessage: 'whatever',
      }),
    ).resolves.toBeUndefined();
    // Mark already happened before the email send — that's the design.
    expect(repo.read('acc_test')?.firstFailureEmailSentAt).toBeInstanceOf(Date);
  });

  it('two concurrent first-failures result in exactly one email (race)', async () => {
    const { service, repo, email } = build();
    await Promise.all([
      service.emit('acc_test', {
        kind: 'session.failed.first',
        sessionId: 'ses_a',
        errorMessage: 'a',
      }),
      service.emit('acc_test', {
        kind: 'session.failed.first',
        sessionId: 'ses_b',
        errorMessage: 'b',
      }),
    ]);
    // The second caller's findForLifecycle reads firstFailureEmailSentAt
    // BEFORE the first caller's mark commits in JS event-loop order; the
    // first caller wins markFirstFailureEmailSent (setting the column),
    // the second caller's mark returns false (column already set), and
    // the second caller skips the send. Net: exactly one email.
    expect(email.sendSessionFailedFirst).toHaveBeenCalledTimes(1);
    expect(repo.read('acc_test')?.firstFailureEmailSentAt).toBeInstanceOf(Date);
  });
});

describe('AccountLifecycleService — subscription.tier_changed (V-202b)', () => {
  it('emits audit + tier-changed email on a real tier flip', async () => {
    const { service, audit, email } = build();
    await service.emit('acc_test', {
      kind: 'subscription.tier_changed',
      fromTier: 'free',
      toTier: 'api_builder',
      effectiveAt: new Date('2026-05-05T12:00:00Z'),
      stripeEventType: 'customer.subscription.created',
      stripeEventId: 'evt_xyz',
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc_test',
        actorType: 'system',
        action: 'subscription.tier_changed',
        payload: {
          from: 'free',
          to: 'api_builder',
          stripe_event_type: 'customer.subscription.created',
          stripe_event_id: 'evt_xyz',
        },
      }),
    );
    expect(email.sendTierChanged).toHaveBeenCalledTimes(1);
    expect(email.sendTierChanged).toHaveBeenCalledWith({
      to: 'first-failure@driftstack.local',
      fromTier: 'free',
      toTier: 'api_builder',
      effectiveAt: new Date('2026-05-05T12:00:00Z'),
      portalUrl: 'https://example.test/billing',
    });
  });

  it('short-circuits BOTH audit and email when fromTier === toTier', async () => {
    const { service, audit, email } = build();
    await service.emit('acc_test', {
      kind: 'subscription.tier_changed',
      fromTier: 'api_builder',
      toTier: 'api_builder',
      effectiveAt: new Date(),
      stripeEventType: 'customer.subscription.updated',
      stripeEventId: 'evt_noop',
    });
    expect(audit.record).not.toHaveBeenCalled();
    expect(email.sendTierChanged).not.toHaveBeenCalled();
  });

  it('audit fires but email skipped when customer opted out of tier-changed', async () => {
    const { service, audit, email } = build({ shouldSend: false });
    await service.emit('acc_test', {
      kind: 'subscription.tier_changed',
      fromTier: 'free',
      toTier: 'api_starter',
      effectiveAt: new Date(),
      stripeEventType: 'customer.subscription.updated',
      stripeEventId: 'evt_optout',
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(email.sendTierChanged).not.toHaveBeenCalled();
  });

  it('email still fires when audit emit throws (audit failure swallowed)', async () => {
    const { service, audit, email } = build();
    audit.record.mockRejectedValueOnce(new Error('db down'));
    await service.emit('acc_test', {
      kind: 'subscription.tier_changed',
      fromTier: 'free',
      toTier: 'api_builder',
      effectiveAt: new Date(),
      stripeEventType: 'customer.subscription.created',
      stripeEventId: 'evt_audit_fail',
    });
    expect(email.sendTierChanged).toHaveBeenCalledTimes(1);
  });
});

describe('C6 — billing emails claim before send (dedup across concurrent delivery / retry)', () => {
  function billingService(): {
    service: AccountLifecycleService;
    repo: TestRepo;
    email: {
      sendBillingRenewalReminder: ReturnType<typeof vi.fn>;
      sendBillingReceipt: ReturnType<typeof vi.fn>;
      sendBillingFailure: ReturnType<typeof vi.fn>;
    };
  } {
    const repo = new TestRepo();
    repo.seed({
      id: 'acc_c6',
      email: 'c6@driftstack.local',
      firstFailureEmailSentAt: null,
      firstSuccessEmailSentAt: null,
    });
    const email = {
      sendBillingRenewalReminder: vi.fn().mockResolvedValue(undefined),
      sendBillingReceipt: vi.fn().mockResolvedValue(undefined),
      sendBillingFailure: vi.fn().mockResolvedValue(undefined),
    };
    const prefs = { shouldSend: vi.fn().mockResolvedValue(true) };
    const service = new AccountLifecycleService(
      repo,
      email as unknown as EmailService,
      prefs as unknown as EmailPreferencesService,
      createTestLogger(),
      {
        docsBaseUrl: 'https://example.test/docs/',
        billingPortalUrl: 'https://example.test/billing',
        dashboardUrl: 'https://example.test',
      },
    );
    return { service, repo, email };
  }

  const evt = (stripeEventId: string) =>
    ({
      kind: 'subscription.renewal_reminder',
      amountCents: 4999,
      currency: 'usd',
      renewalDate: new Date('2026-08-01T00:00:00Z'),
      stripeEventId,
      stripeInvoiceId: 'in_c6',
    }) as const;

  it('two deliveries of the SAME event send exactly one email (both attempt the claim)', async () => {
    const { service, repo, email } = billingService();
    await service.emit('acc_c6', evt('evt_c6_dupe'));
    await service.emit('acc_c6', evt('evt_c6_dupe')); // concurrent delivery / retry
    expect(email.sendBillingRenewalReminder).toHaveBeenCalledTimes(1);
    // Both deliveries reached the claim — the second was blocked BY the claim,
    // not merely by the outer stripe-event ledger (which this path bypasses).
    expect(repo.billingClaimCount).toBe(2);
  });

  // The renewal-reminder arm above proved the claim for ONE of the three billing
  // kinds. Coverage showed the other two guards had never once refused: the
  // `if (!won) return` under handlePaymentSucceeded and handlePaymentFailed each
  // evaluated on every delivery and fired ZERO times, because no test had ever
  // delivered the same billing event twice.
  //
  // Stripe re-delivers events as a matter of course, so the loser branch is not an
  // exotic path — it is what stands between a retried webhook and a customer
  // receiving two receipts, or two "payment failed" warnings for one charge.
  //
  // Both arms assert `billingClaimCount === 2` alongside the send count, for the
  // same reason the renewal arm does: it proves the SECOND delivery actually reached
  // the claim and was refused BY it, rather than being filtered earlier by something
  // else and leaving the guard still unexercised.
  it('two deliveries of the same payment_succeeded event send exactly one receipt', async () => {
    const { service, repo, email } = billingService();
    const paid = (stripeEventId: string) =>
      ({
        kind: 'billing.payment_succeeded',
        amountCents: 4999,
        currency: 'usd',
        periodStart: new Date('2026-08-01T00:00:00Z'),
        periodEnd: new Date('2026-09-01T00:00:00Z'),
        hostedInvoiceUrl: null,
        stripeEventId,
        stripeInvoiceId: 'in_paid',
      }) as const;

    await service.emit('acc_c6', paid('evt_paid_dupe'));
    await service.emit('acc_c6', paid('evt_paid_dupe'));

    expect(email.sendBillingReceipt).toHaveBeenCalledTimes(1);
    expect(repo.billingClaimCount, 'both deliveries must reach the claim').toBe(2);
  });

  it('two deliveries of the same payment_failed event send exactly one warning', async () => {
    const { service, repo, email } = billingService();
    const failed = (stripeEventId: string) =>
      ({
        kind: 'billing.payment_failed',
        amountCents: 4999,
        currency: 'usd',
        retryAt: new Date('2026-08-05T00:00:00Z'),
        stripeEventId,
        stripeInvoiceId: 'in_failed',
      }) as const;

    await service.emit('acc_c6', failed('evt_failed_dupe'));
    await service.emit('acc_c6', failed('evt_failed_dupe'));

    expect(email.sendBillingFailure).toHaveBeenCalledTimes(1);
    expect(repo.billingClaimCount, 'both deliveries must reach the claim').toBe(2);
  });

  it('different event ids for the same account each send (the claim is per event)', async () => {
    const { service, email } = billingService();
    await service.emit('acc_c6', evt('evt_c6_a'));
    await service.emit('acc_c6', evt('evt_c6_b'));
    expect(email.sendBillingRenewalReminder).toHaveBeenCalledTimes(2);
  });
});
