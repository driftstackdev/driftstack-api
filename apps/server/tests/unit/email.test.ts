// EmailService unit tests.
//
// Verifies fire-and-forget semantics, template selection, no-op
// behaviour when Postmark is unconfigured, and that send failures
// do NOT throw to the caller.

import { describe, expect, it, vi } from 'vitest';
import { createEmailService } from '../../src/services/email.js';
import type { PostmarkSendApi } from '../../src/services/email.js';
import type { Logger } from '../../src/lib/logger.js';

function makeLogger(): Logger {
  const fns = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };
  return {
    ...fns,
    level: 'info',
    silent: () => {},
    child: () => makeLogger(),
  } as unknown as Logger;
}

const config = {
  apiToken: 'token',
  from: 'no-reply@driftstack.dev',
  replyTo: 'support@driftstack.dev',
};

describe('createEmailService — unconfigured', () => {
  it('returns a no-op service when config is null', async () => {
    const logger = makeLogger();
    const svc = createEmailService({ config: null, logger });
    expect(svc.isConfigured).toBe(false);
    await expect(
      svc.sendSignupVerification({
        to: 'a@b.com',
        link: 'https://x',
        expiresAt: new Date('2026-05-03T12:00:00Z'),
      }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('createEmailService — configured', () => {
  function makeStubClient(): PostmarkSendApi & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      sendEmail(input) {
        calls.push(input);
        return Promise.resolve({});
      },
    };
  }

  it('signup verification template', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendSignupVerification({
      to: 'user@example.com',
      link: 'https://app.driftstack.dev/verify/abc',
      expiresAt: new Date('2026-05-03T12:30:00Z'),
    });
    expect(client.calls).toHaveLength(1);
    const c = client.calls[0] as Record<string, string>;
    expect(c.From).toBe('no-reply@driftstack.dev');
    expect(c.ReplyTo).toBe('support@driftstack.dev');
    expect(c.To).toBe('user@example.com');
    expect(c.Subject).toContain('Verify');
    expect(c.TextBody).toContain('https://app.driftstack.dev/verify/abc');
    expect(c.TextBody).toContain('2026-05-03T12:30:00');
    expect(c.HtmlBody).toContain('<a href="https://app.driftstack.dev/verify/abc"');
    expect(c.MessageStream).toBe('outbound');
  });

  it('password reset template', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendPasswordReset({
      to: 'user@example.com',
      link: 'https://app.driftstack.dev/reset/xyz',
      expiresAt: new Date('2026-05-03T12:30:00Z'),
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('Reset');
    expect(c.TextBody).toContain('reset');
  });

  it('billing receipt template', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendBillingReceipt({
      to: 'user@example.com',
      amountFormatted: '€199.00',
      period: '2026-05',
      invoiceUrl: 'https://billing.driftstack.dev/invoice/abc',
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.TextBody).toContain('€199.00');
    expect(c.TextBody).toContain('2026-05');
    expect(c.TextBody).toContain('https://billing.driftstack.dev/invoice/abc');
  });

  it('billing failure template', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendBillingFailure({
      to: 'user@example.com',
      amountFormatted: '€199.00',
      retryAt: new Date('2026-05-04T00:00:00Z'),
      portalUrl: 'https://billing.driftstack.dev/portal',
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('payment failed');
    expect(c.TextBody).toContain('https://billing.driftstack.dev/portal');
  });

  it('subscription cancellation template', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendSubscriptionCancellation({
      to: 'user@example.com',
      effectiveAt: new Date('2026-06-01T00:00:00Z'),
      portalUrl: 'https://billing.driftstack.dev/portal',
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('cancelled');
    expect(c.TextBody).toContain('2026-06-01');
  });

  it('support ack template', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendSupportAck({ to: 'user@example.com', ticketId: 'TKT-123' });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('support');
    expect(c.TextBody).toContain('TKT-123');
  });

  it('swallows send errors (fire-and-forget)', async () => {
    const logger = makeLogger();
    const failing: PostmarkSendApi = {
      sendEmail: vi.fn().mockRejectedValue(new Error('postmark down')),
    };
    const svc = createEmailService({ config, logger, client: failing });
    await expect(
      svc.sendSignupVerification({
        to: 'user@example.com',
        link: 'https://x',
        expiresAt: new Date(),
      }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'email', template: 'signup-verification' }),
      expect.stringContaining('email send failed'),
    );
  });

  it('logs success at info', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendSupportAck({ to: 'user@example.com', ticketId: 'TKT-123' });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'email',
        template: 'support-ack',
        to: 'user@example.com',
      }),
      'email sent',
    );
  });

  it('respects custom messageStream', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client, messageStream: 'broadcast' });
    await svc.sendSupportAck({ to: 'a@b.com', ticketId: 'X' });
    const c = client.calls[0] as Record<string, string>;
    expect(c.MessageStream).toBe('broadcast');
  });

  // V-202 — new templates added for the onboarding + lifecycle expansion.

  it('signup-welcome template', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendSignupWelcome({
      to: 'user@example.com',
      dashboardUrl: 'https://app.driftstack.dev/select-tier',
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('Welcome');
    expect(c.TextBody).toContain('https://app.driftstack.dev/select-tier');
    expect(c.TextBody).toContain('$2.99 trial pack');
  });

  it('session-failed-first template', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendSessionFailedFirst({
      to: 'user@example.com',
      sessionId: 'ses_00000000-0000-4000-8000-000000000001',
      errorMessage: 'driver_timeout',
      docsUrl: 'https://docs.driftstack.dev/troubleshooting',
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('first session failure');
    expect(c.TextBody).toContain('ses_00000000-0000-4000-8000-000000000001');
    expect(c.TextBody).toContain('driver_timeout');
    expect(c.TextBody).toContain('one-time notice');
  });

  it('tier-changed template', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendTierChanged({
      to: 'user@example.com',
      fromTier: 'api_starter',
      toTier: 'api_builder',
      effectiveAt: new Date('2026-06-01T00:00:00Z'),
      portalUrl: 'https://billing.driftstack.dev/portal',
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('tier changed');
    expect(c.TextBody).toContain('api_starter');
    expect(c.TextBody).toContain('api_builder');
    expect(c.TextBody).toContain('2026-06-01');
  });

  it('trial-pack-purchased template', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendTrialPackPurchased({
      to: 'user@example.com',
      creditCentsRemaining: 299,
      expiresAt: new Date('2026-05-19T00:00:00Z'),
      dashboardUrl: 'https://app.driftstack.dev/',
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('$2.99 trial pack');
    expect(c.TextBody).toContain('299 cents');
    expect(c.TextBody).toContain('2026-05-19');
  });

  it('trial-pack-expired template', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendTrialPackExpired({
      to: 'user@example.com',
      upgradeUrl: 'https://app.driftstack.dev/select-tier',
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('trial pack expired');
    expect(c.TextBody).toContain('https://app.driftstack.dev/select-tier');
    expect(c.TextBody).toContain('once per account');
  });
});
