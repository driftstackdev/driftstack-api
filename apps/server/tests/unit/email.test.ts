// EmailService unit tests.
//
// Verifies fire-and-forget semantics, template selection, no-op
// behaviour when Postmark is unconfigured, and that send failures
// do NOT throw to the caller.

import { describe, expect, it, vi } from 'vitest';
import { classifyEmailError, createEmailService } from '../../src/services/email.js';
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

  // V-553.B-1 — coverage for the 7 templates that ship behind feature
  // flags but were missing direct send-path tests in the W43 audit.

  it('billing-renewal-reminder template (V-304b)', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendBillingRenewalReminder({
      to: 'user@example.com',
      amountFormatted: '€199.00',
      renewalDate: new Date('2026-06-01T12:00:00Z'),
      portalUrl: 'https://billing.driftstack.dev/portal',
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('renews in 7 days');
    expect(c.TextBody).toContain('€199.00');
    // renewalDate is sliced to YYYY-MM-DD in the service layer.
    expect(c.TextBody).toContain('2026-06-01');
    expect(c.TextBody).not.toContain('T12:00:00');
    expect(c.HtmlBody).toContain('https://billing.driftstack.dev/portal');
  });

  it('session-success-first template (V-304a)', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendSessionSuccessFirst({
      to: 'user@example.com',
      sessionId: 'sess_first_001',
      dashboardUrl: 'https://app.driftstack.dev/dashboard',
      docsUrl: 'https://docs.driftstack.dev/quickstart',
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('first session');
    expect(c.TextBody).toContain('sess_first_001');
    expect(c.TextBody).toContain('https://app.driftstack.dev/dashboard');
    expect(c.TextBody).toContain('https://docs.driftstack.dev/quickstart');
    expect(c.HtmlBody).toContain('<code>sess_first_001</code>');
  });

  it('status-subscription-confirmation template (V-295c3)', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendStatusSubscriptionConfirmation({
      to: 'subscriber@example.com',
      confirmLink: 'https://status.driftstack.dev/confirm/tok_xyz',
      expiresAt: new Date('2026-05-13T00:00:00Z'),
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('Confirm');
    expect(c.TextBody).toContain('https://status.driftstack.dev/confirm/tok_xyz');
    expect(c.TextBody).toContain('2026-05-13');
  });

  it('status-subscription-welcome template (V-295c3)', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendStatusSubscriptionWelcome({
      to: 'subscriber@example.com',
      statusPageUrl: 'https://status.driftstack.dev/',
      unsubscribeLink: 'https://status.driftstack.dev/unsubscribe/tok_unsub',
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('subscribed');
    expect(c.TextBody).toContain('https://status.driftstack.dev/');
    expect(c.TextBody).toContain('https://status.driftstack.dev/unsubscribe/tok_unsub');
    // No incident-specific copy in the welcome — keep it lean.
    expect(c.TextBody).not.toContain('Incident:');
  });

  it('status-incident-created template (V-295c3-followup, kind="created")', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendStatusIncidentNotification({
      to: 'subscriber@example.com',
      kind: 'created',
      title: 'Elevated 5xx on /v1/sessions',
      severity: 'major',
      status: 'investigating',
      message: 'We are investigating elevated errors.',
      incidentTime: new Date('2026-05-11T15:30:00Z'),
      statusPageUrl: 'https://status.driftstack.dev/',
      unsubscribeLink: 'https://status.driftstack.dev/unsubscribe/tok_unsub',
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('Incident posted');
    expect(c.TextBody).toContain('Elevated 5xx on /v1/sessions');
    expect(c.TextBody).toContain('major');
    expect(c.TextBody).toContain('investigating');
    expect(c.TextBody).toContain('2026-05-11T15:30:00');
  });

  it('status-incident-resolved template (V-295c3-followup, kind="resolved")', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendStatusIncidentNotification({
      to: 'subscriber@example.com',
      kind: 'resolved',
      title: 'Elevated 5xx on /v1/sessions',
      severity: 'major',
      status: 'resolved',
      message: 'Root cause: upstream DNS resolver flap.',
      incidentTime: new Date('2026-05-11T16:00:00Z'),
      statusPageUrl: 'https://status.driftstack.dev/',
      unsubscribeLink: 'https://status.driftstack.dev/unsubscribe/tok_unsub',
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('Incident resolved');
    expect(c.TextBody).toContain('Resolved at: 2026-05-11T16:00:00');
    expect(c.TextBody).toContain('Root cause: upstream DNS resolver flap.');
    // Resolved variant must NOT use the active-incident "Current status:" line.
    expect(c.TextBody).not.toContain('Current status:');
  });

  it('team-invite template (V-298b) — role + accept link round-trip', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendTeamInvite({
      to: 'invitee@example.com',
      acceptLink: 'https://app.driftstack.dev/team/invite/tok_inv',
      expiresAt: new Date('2026-05-18T12:00:00Z'),
      role: 'admin',
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('Driftstack team');
    expect(c.TextBody).toContain('admin');
    expect(c.TextBody).toContain('https://app.driftstack.dev/team/invite/tok_inv');
    expect(c.TextBody).toContain('2026-05-18');
  });
});

// V-665 — failure categorisation. Distinguishes Postmark pending-approval
// (expected pre-approval state) from genuine ops failures so dashboards
// can alert on the latter without flooding on the former.
describe('classifyEmailError', () => {
  it('categorises code 412 as pending-approval', () => {
    expect(classifyEmailError({ code: 412, message: 'Account pending approval' })).toEqual({
      category: 'pending-approval',
      postmarkCode: 412,
    });
  });

  it('categorises code 405 as inactive-recipient', () => {
    expect(classifyEmailError({ code: 405 })).toEqual({
      category: 'inactive-recipient',
      postmarkCode: 405,
    });
  });

  it('categorises code 406 as account-inactive', () => {
    expect(classifyEmailError({ code: 406 })).toEqual({
      category: 'account-inactive',
      postmarkCode: 406,
    });
  });

  it('categorises code 422 as invalid-request', () => {
    expect(classifyEmailError({ code: 422 })).toEqual({
      category: 'invalid-request',
      postmarkCode: 422,
    });
  });

  it('categorises code 429 as rate-limited', () => {
    expect(classifyEmailError({ code: 429 })).toEqual({
      category: 'rate-limited',
      postmarkCode: 429,
    });
  });

  it('categorises ECONNRESET as transport', () => {
    const err = new Error('econnreset');
    err.name = 'ECONNRESET';
    expect(classifyEmailError(err)).toEqual({
      category: 'transport',
      postmarkCode: null,
    });
  });

  it('categorises ETIMEDOUT as transport', () => {
    const err = new Error('timeout');
    err.name = 'ETIMEDOUT';
    expect(classifyEmailError(err)).toEqual({
      category: 'transport',
      postmarkCode: null,
    });
  });

  it('falls back to pending-approval when message contains "pending approval"', () => {
    expect(classifyEmailError({ message: 'Account is pending approval; cannot send.' })).toEqual({
      category: 'pending-approval',
      postmarkCode: null,
    });
  });

  it('categorises plain Error("postmark down") as unknown', () => {
    expect(classifyEmailError(new Error('postmark down'))).toEqual({
      category: 'unknown',
      postmarkCode: null,
    });
  });

  it('categorises null + non-object inputs as unknown', () => {
    expect(classifyEmailError(null)).toEqual({ category: 'unknown', postmarkCode: null });
    expect(classifyEmailError('a string')).toEqual({ category: 'unknown', postmarkCode: null });
    expect(classifyEmailError(123)).toEqual({ category: 'unknown', postmarkCode: null });
  });
});

describe('createEmailService — V-665 categorised failure logging', () => {
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

  it('logs category=pending-approval when Postmark returns code 412', async () => {
    const logger = makeLogger();
    const pendingErr = Object.assign(new Error('Account pending approval.'), { code: 412 });
    const failing: PostmarkSendApi = {
      sendEmail: vi.fn().mockRejectedValue(pendingErr),
    };
    const svc = createEmailService({
      config: {
        apiToken: 't',
        from: 'no-reply@driftstack.dev',
        replyTo: 'support@driftstack.dev',
      },
      logger,
      client: failing,
    });
    await svc.sendSignupVerification({
      to: 'user@example.com',
      link: 'https://x',
      expiresAt: new Date(),
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'email',
        category: 'pending-approval',
        postmarkCode: 412,
      }),
      expect.stringContaining('email send failed'),
    );
  });

  it('logs category=transport on ECONNRESET', async () => {
    const logger = makeLogger();
    const err = Object.assign(new Error('connection reset'), { name: 'ECONNRESET' });
    const failing: PostmarkSendApi = { sendEmail: vi.fn().mockRejectedValue(err) };
    const svc = createEmailService({
      config: {
        apiToken: 't',
        from: 'no-reply@driftstack.dev',
        replyTo: 'support@driftstack.dev',
      },
      logger,
      client: failing,
    });
    await svc.sendSignupVerification({
      to: 'user@example.com',
      link: 'https://x',
      expiresAt: new Date(),
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'transport' }),
      expect.anything(),
    );
  });

  it('logs category=unknown when error has no Postmark-style code', async () => {
    const logger = makeLogger();
    const failing: PostmarkSendApi = {
      sendEmail: vi.fn().mockRejectedValue(new Error('something else')),
    };
    const svc = createEmailService({
      config: {
        apiToken: 't',
        from: 'no-reply@driftstack.dev',
        replyTo: 'support@driftstack.dev',
      },
      logger,
      client: failing,
    });
    await svc.sendSignupVerification({
      to: 'user@example.com',
      link: 'https://x',
      expiresAt: new Date(),
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'unknown' }),
      expect.anything(),
    );
  });
});
