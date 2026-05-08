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
    sendTrialPackPurchased: ReturnType<typeof vi.fn>;
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
    sendTrialPackPurchased: vi.fn().mockResolvedValue(undefined),
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
      fromTier: 'trial_pack',
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
          from: 'trial_pack',
          to: 'api_builder',
          stripe_event_type: 'customer.subscription.created',
          stripe_event_id: 'evt_xyz',
        },
      }),
    );
    expect(email.sendTierChanged).toHaveBeenCalledTimes(1);
    expect(email.sendTierChanged).toHaveBeenCalledWith({
      to: 'first-failure@driftstack.local',
      fromTier: 'trial_pack',
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
      fromTier: 'trial_pack',
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
      fromTier: 'trial_pack',
      toTier: 'api_builder',
      effectiveAt: new Date(),
      stripeEventType: 'customer.subscription.created',
      stripeEventId: 'evt_audit_fail',
    });
    expect(email.sendTierChanged).toHaveBeenCalledTimes(1);
  });
});

describe('AccountLifecycleService — subscription.trial_pack_purchased (V-202b)', () => {
  it('sends the trial-pack email; no audit emit', async () => {
    const { service, email, audit } = build();
    await service.emit('acc_test', {
      kind: 'subscription.trial_pack_purchased',
      creditCents: 299,
      expiresAt: new Date('2026-05-19T00:00:00Z'),
    });
    expect(email.sendTrialPackPurchased).toHaveBeenCalledTimes(1);
    expect(email.sendTrialPackPurchased).toHaveBeenCalledWith({
      to: 'first-failure@driftstack.local',
      creditCentsRemaining: 299,
      expiresAt: new Date('2026-05-19T00:00:00Z'),
      dashboardUrl: 'https://example.test',
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('skips email when customer opted out', async () => {
    const { service, email } = build({ shouldSend: false });
    await service.emit('acc_test', {
      kind: 'subscription.trial_pack_purchased',
      creditCents: 299,
      expiresAt: new Date(),
    });
    expect(email.sendTrialPackPurchased).not.toHaveBeenCalled();
  });
});

describe('AccountLifecycleService — subscription.trial_pack_expired (V-202d)', () => {
  it('sends the expiry email; no audit emit', async () => {
    const { service, email, audit } = build();
    // The build() helper installs a sendTrialPackExpired vi.fn — extend it.
    const expired = vi.fn().mockResolvedValue(undefined);
    Object.assign(email, { sendTrialPackExpired: expired });
    await service.emit('acc_test', { kind: 'subscription.trial_pack_expired' });
    expect(expired).toHaveBeenCalledTimes(1);
    expect(expired).toHaveBeenCalledWith({
      to: 'first-failure@driftstack.local',
      upgradeUrl: 'https://example.test/billing',
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('skips email when customer opted out', async () => {
    const { service, email } = build({ shouldSend: false });
    const expired = vi.fn().mockResolvedValue(undefined);
    Object.assign(email, { sendTrialPackExpired: expired });
    await service.emit('acc_test', { kind: 'subscription.trial_pack_expired' });
    expect(expired).not.toHaveBeenCalled();
  });
});
