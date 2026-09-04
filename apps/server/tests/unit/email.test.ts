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
      link: 'https://app.driftstack.io/verify/abc',
      expiresAt: new Date('2026-05-03T12:30:00Z'),
    });
    expect(client.calls).toHaveLength(1);
    const c = client.calls[0] as Record<string, string>;
    expect(c.From).toBe('no-reply@driftstack.dev');
    expect(c.ReplyTo).toBe('support@driftstack.dev');
    expect(c.To).toBe('user@example.com');
    expect(c.Subject).toContain('Verify');
    expect(c.TextBody).toContain('https://app.driftstack.io/verify/abc');
    expect(c.TextBody).toContain('2026-05-03T12:30:00');
    expect(c.HtmlBody).toContain('<a href="https://app.driftstack.io/verify/abc"');
    expect(c.MessageStream).toBe('outbound');
  });

  it('wraps the HTML body in a full email-safe document (DOCTYPE + utf-8 charset + viewport)', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    // Renewal-reminder copy contains an em-dash ("Heads up —") — the exact
    // non-ASCII character that mojibakes without an explicit charset.
    await svc.sendBillingRenewalReminder({
      to: 'user@example.com',
      renewalDate: new Date('2026-06-18T00:00:00Z'),
      amountFormatted: '€199.00',
      portalUrl: 'https://billing.driftstack.dev/portal',
    });
    const c = client.calls[0] as Record<string, string>;
    const html = c.HtmlBody ?? '';
    // Document shell present...
    expect(html).toMatch(/^<!DOCTYPE html><html lang="en"><head>/);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport"');
    expect(html.trimEnd()).toMatch(/<\/body><\/html>$/);
    // <title> is the email subject, not a generic "Driftstack".
    expect(html).toContain(`<title>${c.Subject}</title>`);
    expect(c.Subject).toContain('renews in 7 days');
    // ...wrapping (not replacing) the template fragment, em-dash intact.
    expect(html).toContain('<p>Heads up — your Driftstack subscription renews');
  });

  it('HTML-escapes interpolated values (injection guard); leaves the text body raw', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendSessionFailedFirst({
      to: 'user@example.com',
      sessionId: 'ses_x',
      errorMessage: 'boom <img src=x onerror="alert(1)"> & done',
      docsUrl: 'https://docs.driftstack.io/errors',
    });
    const c = client.calls[0] as Record<string, string>;
    // HTML body: dangerous characters are entity-escaped, no live markup.
    expect(c.HtmlBody).toContain('boom &lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; done');
    expect(c.HtmlBody).not.toContain('<img src=x');
    // Text body: plain text, left exactly as supplied.
    expect(c.TextBody).toContain('boom <img src=x onerror="alert(1)"> & done');
  });

  it('password reset template', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendPasswordReset({
      to: 'user@example.com',
      link: 'https://app.driftstack.io/reset/xyz',
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

  it('billing failure template — retry scheduled (S44: retryLine carries the timestamp)', async () => {
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
    expect(c.TextBody).toContain("We'll retry automatically at 2026-05-04T00:00:00.000Z (UTC).");
    expect(c.TextBody).toContain('https://billing.driftstack.dev/portal');
  });

  it('billing failure template — final attempt (S44: null retryAt renders the no-further-retries sentence)', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendBillingFailure({
      to: 'user@example.com',
      amountFormatted: '€199.00',
      retryAt: null,
      portalUrl: 'https://billing.driftstack.dev/portal',
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('payment failed');
    expect(c.TextBody).toContain(
      'This was the final automatic attempt — no further retries are scheduled.',
    );
    expect(c.TextBody).not.toContain('retry automatically at');
    // HTML body renders the same sentence (entity-escaped apostrophes ok).
    expect(c.HtmlBody).toContain('no further retries are scheduled.');
  });

  // S44 2026-07-07 (founder-approved trim) — subscription-cancellation
  // and support-ack were deleted (zero callers). The compile-time
  // interface no longer declares them; assert the runtime object
  // doesn't secretly keep them either.
  it('S44 trim: sendSubscriptionCancellation + sendSupportAck are gone from the service object', () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client }) as unknown as Record<
      string,
      unknown
    >;
    expect(svc.sendSubscriptionCancellation).toBeUndefined();
    expect(svc.sendSupportAck).toBeUndefined();
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
    await svc.sendBillingReceipt({
      to: 'user@example.com',
      amountFormatted: '€1.00',
      period: '2026-05',
      invoiceUrl: 'https://billing.driftstack.dev/invoice/abc',
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'email',
        template: 'billing-receipt',
        // maskEmail() — the raw address must not sit in plaintext in logs.
        to: 'u***@example.com',
      }),
      'email sent',
    );
  });

  it('respects custom messageStream', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client, messageStream: 'broadcast' });
    await svc.sendBillingReceipt({
      to: 'a@b.com',
      amountFormatted: '€1.00',
      period: '2026-05',
      invoiceUrl: 'https://x',
    });
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
      dashboardUrl: 'https://app.driftstack.io/select-tier',
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('Welcome');
    expect(c.TextBody).toContain('https://app.driftstack.io/select-tier');
    expect(c.TextBody).toContain('Start free or pick a paid tier');
  });

  it('session-failed-first template', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendSessionFailedFirst({
      to: 'user@example.com',
      sessionId: 'ses_00000000-0000-4000-8000-000000000001',
      errorMessage: 'driver_timeout',
      docsUrl: 'https://docs.driftstack.io/troubleshooting',
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
      dashboardUrl: 'https://app.driftstack.io/dashboard',
      docsUrl: 'https://docs.driftstack.io/quickstart',
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('first session');
    expect(c.TextBody).toContain('sess_first_001');
    expect(c.TextBody).toContain('https://app.driftstack.io/dashboard');
    expect(c.TextBody).toContain('https://docs.driftstack.io/quickstart');
    expect(c.HtmlBody).toContain('<code>sess_first_001</code>');
  });

  it('status-subscription-confirmation template (V-295c3)', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendStatusSubscriptionConfirmation({
      to: 'subscriber@example.com',
      confirmLink: 'https://status.driftstack.io/confirm/tok_xyz',
      expiresAt: new Date('2026-05-13T00:00:00Z'),
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('Confirm');
    expect(c.TextBody).toContain('https://status.driftstack.io/confirm/tok_xyz');
    expect(c.TextBody).toContain('2026-05-13');
  });

  it('status-subscription-welcome template (V-295c3)', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendStatusSubscriptionWelcome({
      to: 'subscriber@example.com',
      statusPageUrl: 'https://status.driftstack.io/',
      unsubscribeLink: 'https://status.driftstack.io/unsubscribe/tok_unsub',
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('subscribed');
    expect(c.TextBody).toContain('https://status.driftstack.io/');
    expect(c.TextBody).toContain('https://status.driftstack.io/unsubscribe/tok_unsub');
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
      statusPageUrl: 'https://status.driftstack.io/',
      unsubscribeLink: 'https://status.driftstack.io/unsubscribe/tok_unsub',
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
      statusPageUrl: 'https://status.driftstack.io/',
      unsubscribeLink: 'https://status.driftstack.io/unsubscribe/tok_unsub',
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('Incident resolved');
    expect(c.TextBody).toContain('Resolved at: 2026-05-11T16:00:00');
    expect(c.TextBody).toContain('Root cause: upstream DNS resolver flap.');
    // Resolved variant must NOT use the active-incident "Current status:" line.
    expect(c.TextBody).not.toContain('Current status:');
  });

  // V-1431 — the third incident kind. `created` and `resolved` each have an arm
  // above; `updated` had none, and coverage agreed: the middle branch of the
  // template ternary in `services/email.ts` had never selected a template.
  //
  // It is not dormant. `incident-email-volume-claims-match-wired-kinds` already
  // establishes, from the bootstrap wiring, that this kind fans out in production —
  // the throttle repo is constructed unconditionally, so `notifyUpdated`'s
  // `if (!this.throttle) return;` no-op is not taken, and `onPublicUpdated` sends on
  // every operator update.
  //
  // What the untested branch costs is specific: falling through selects the RESOLVED
  // template, so subscribers to a live incident would be told it is over — during
  // the incident, which is exactly when the email is the thing they act on. The arm
  // asserts the resolved copy is ABSENT as well as the update copy present, because
  // "contains the right words" alone passes on a template carrying both.
  it('status-incident-updated template (V-545.B Phase 2, kind="updated") — the live third kind', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendStatusIncidentNotification({
      to: 'subscriber@example.com',
      kind: 'updated',
      title: 'Elevated 5xx on /v1/sessions',
      severity: 'major',
      status: 'identified',
      message: 'Cause identified; mitigation rolling out.',
      incidentTime: new Date('2026-05-11T15:45:00Z'),
      statusPageUrl: 'https://status.driftstack.io/',
      unsubscribeLink: 'https://status.driftstack.io/unsubscribe/tok_unsub',
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.TextBody).toContain('Cause identified; mitigation rolling out.');
    expect(c.TextBody).toContain('identified');
    expect(
      c.Subject,
      'an update must not be announced as a new incident — subscribers already had that email',
    ).not.toContain('Incident posted');
    expect(
      c.Subject,
      'and must not be announced as resolved while the incident is still running, which is what falling through to the resolved template would do',
    ).not.toContain('Incident resolved');
    expect(
      c.TextBody,
      'the resolved template stamps a resolution time; an ongoing update must not carry one',
    ).not.toContain('Resolved at:');
  });

  it('team-invite template (V-298b) — role + accept link round-trip', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendTeamInvite({
      to: 'invitee@example.com',
      acceptLink: 'https://app.driftstack.io/team/invite/tok_inv',
      expiresAt: new Date('2026-05-18T12:00:00Z'),
      role: 'admin',
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('Driftstack team');
    expect(c.TextBody).toContain('admin');
    expect(c.TextBody).toContain('https://app.driftstack.io/team/invite/tok_inv');
    expect(c.TextBody).toContain('2026-05-18');
  });

  // v2-#16 — close coverage gap: every other template in
  // EmailService had a unit test except this one. The oauth-pending
  // path is exercised by integration tests (build-test-app.ts) but
  // never had its template body asserted in isolation.
  it('oauth-pending-verification template (V-667.C) — provider + confirm link + UTC expiry round-trip', async () => {
    const logger = makeLogger();
    const client = makeStubClient();
    const svc = createEmailService({ config, logger, client });
    await svc.sendOauthPendingLinkVerification({
      to: 'user@example.com',
      provider: 'google',
      confirmLink: 'https://app.driftstack.io/oauth/confirm/tok_pending_abc',
      expiresAt: new Date('2026-05-18T12:00:00Z'),
    });
    const c = client.calls[0] as Record<string, string>;
    expect(c.Subject).toContain('confirm a new sign-in method');
    expect(c.TextBody).toContain('Google');
    expect(c.TextBody).toContain('https://app.driftstack.io/oauth/confirm/tok_pending_abc');
    expect(c.TextBody).toContain('2026-05-18');
    // "wasn't me" affordance is the whole reason this template exists
    // — the customer must be able to ignore a phishing-trigger attempt.
    expect(c.TextBody).toMatch(/wasn't you/i);
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
    const sendEmail = vi.fn().mockRejectedValue(err);
    const svc = createEmailService({
      config: {
        apiToken: 't',
        from: 'no-reply@driftstack.dev',
        replyTo: 'support@driftstack.dev',
      },
      logger,
      client: { sendEmail },
      // 'transport' is a retryable category for this security-critical
      // template (signup-verification) — inject a no-delay retry seam
      // so this test doesn't burn the real 200ms/800ms backoff.
      retryDelayFn: async () => {},
    });
    await svc.sendSignupVerification({
      to: 'user@example.com',
      link: 'https://x',
      expiresAt: new Date(),
    });
    // Every attempt fails, so sendEmail is called 3 times (1 initial +
    // 2 retries) before the final warn-level log fires.
    expect(sendEmail).toHaveBeenCalledTimes(3);
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

// 2026-07-01 security fix — retry + per-account failure tracking +
// elevated alerting, scoped to the 3 security-critical templates
// (signup-verification / password-reset / oauth-pending-verification).
describe('createEmailService — security-critical retry + per-account tracking (2026-07-01)', () => {
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

  /** In-memory fake AccountEmailDeliveryTracker keyed by lowercased email. */
  /** `reject` makes the named tracker calls fail AFTER recording the attempt,
   *  so an arm can assert both that the call happened and that its failure was
   *  swallowed. Recording first is the difference between proving a swallow and
   *  passing because the call never ran. */
  function makeFakeTracker(
    seed: Record<string, string>,
    opts: { reject?: Array<'find' | 'mark' | 'clear'> } = {},
  ) {
    const rejects = new Set(opts.reject ?? []);
    const emailToAccountId = new Map(
      Object.entries(seed).map(([email, accountId]) => [email.toLowerCase(), accountId]),
    );
    const failedAt = new Map<string, Date | null>();
    return {
      findAccountIdByEmail: vi.fn((email: string) => {
        if (rejects.has('find')) return Promise.reject(new Error('tracker down'));
        return Promise.resolve(emailToAccountId.get(email.toLowerCase()) ?? null);
      }),
      markDeliveryFailed: vi.fn((accountId: string, at: Date) => {
        failedAt.set(accountId, at);
        if (rejects.has('mark')) return Promise.reject(new Error('tracker down'));
        return Promise.resolve();
      }),
      clearDeliveryFailed: vi.fn((accountId: string) => {
        failedAt.set(accountId, null);
        if (rejects.has('clear')) return Promise.reject(new Error('tracker down'));
        return Promise.resolve();
      }),
      // test-only inspection helper, not part of the real interface
      _failedAt: failedAt,
    };
  }

  // No explicit `: SentryClient` return-type annotation — the interface
  // declares its methods with shorthand syntax (`captureException(...)`),
  // which trips @typescript-eslint/unbound-method the moment a caller
  // reads `sentry.captureException` as a value (e.g. inside `expect(...)`).
  // Letting TS infer this object's type instead (still structurally
  // assignable to SentryClient) sidesteps that without an `as` cast.
  function makeFakeSentry() {
    return {
      captureException: vi.fn(),
      addBreadcrumb: vi.fn(),
      flush: vi.fn(() => Promise.resolve(true)),
      close: vi.fn(() => Promise.resolve(true)),
      isInitialized: true,
    };
  }

  it('retries a transient failure (rate-limited) and eventually succeeds', async () => {
    const logger = makeLogger();
    const rateLimited = Object.assign(new Error('too many requests'), { code: 429 });
    const sendEmail = vi
      .fn()
      .mockRejectedValueOnce(rateLimited)
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce({});
    const svc = createEmailService({
      config,
      logger,
      client: { sendEmail },
      retryDelayFn: async () => {},
    });
    await svc.sendPasswordReset({
      to: 'user@example.com',
      link: 'https://x',
      expiresAt: new Date(),
    });
    expect(sendEmail).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'email', template: 'password-reset' }),
      'email sent',
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  // The delivery tracker is bookkeeping BESIDE the send, not part of it: the
  // source says a tracker outage must never turn email delivery into a hard
  // failure. Three independent swallows implement that — the account lookup,
  // the clear-on-success, and the mark-on-inactive-recipient.
  //
  // None was covered. Making any of the three rethrow reds nothing across 41
  // email files and 374 tests, because every fixture supplies a tracker whose
  // calls resolve. A rethrow would take out password-reset, verification and
  // MFA mail whenever the tracker's database blinked — the security-critical
  // templates are exactly the ones wired to it.
  it('CRITICAL a failing tracker LOOKUP does not fail the send', async () => {
    const logger = makeLogger();
    const sentry = makeFakeSentry();
    const tracker = makeFakeTracker({ 'user@example.com': 'acc_1' }, { reject: ['find'] });
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const svc = createEmailService({
      config,
      logger,
      client: { sendEmail },
      retryDelayFn: async () => {},
      accountEmailDeliveryTracker: tracker,
      sentry,
    });

    await expect(
      svc.sendSignupVerification({
        to: 'user@example.com',
        link: 'https://x',
        expiresAt: new Date(),
      }),
    ).resolves.not.toThrow();

    expect(sendEmail, 'the email itself still went out').toHaveBeenCalledTimes(1);
    expect(
      tracker.findAccountIdByEmail,
      'the lookup must be attempted, or this proves nothing about its swallow',
    ).toHaveBeenCalled();
  });

  it('CRITICAL a failing tracker CLEAR does not fail the send', async () => {
    // The lookup resolves here so the clear is actually reached — with a
    // failing lookup the clear is skipped entirely and this arm would pass
    // without ever touching the swallow it names.
    const logger = makeLogger();
    const sentry = makeFakeSentry();
    const tracker = makeFakeTracker({ 'user@example.com': 'acc_1' }, { reject: ['clear'] });
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const svc = createEmailService({
      config,
      logger,
      client: { sendEmail },
      retryDelayFn: async () => {},
      accountEmailDeliveryTracker: tracker,
      sentry,
    });

    await expect(
      svc.sendPasswordReset({ to: 'user@example.com', link: 'https://x', expiresAt: new Date() }),
    ).resolves.not.toThrow();

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(tracker.clearDeliveryFailed, 'the clear must be attempted').toHaveBeenCalledWith(
      'acc_1',
    );
    // The clear runs INSIDE the send's own try, so a rethrow there lands in the
    // send-failure handler: the mail goes out and is then reported as failed.
    // The tracker error classifies as non-retryable, so the attempt count alone
    // cannot see it — this is the assertion that can.
    expect(
      logger.warn,
      'a delivered email must not be reported as a send failure because bookkeeping failed',
    ).not.toHaveBeenCalledWith(
      expect.objectContaining({ component: 'email' }),
      expect.stringContaining('email send failed'),
    );
  });

  it('CRITICAL a failing tracker MARK does not fail the inactive-recipient path', async () => {
    // 405 is Postmark's permanent suppression state — the one case that marks
    // the account. If persisting that marker threw, the send-failure handler
    // would raise on top of a send that had already permanently failed.
    const logger = makeLogger();
    const sentry = makeFakeSentry();
    const tracker = makeFakeTracker({ 'bounced@example.com': 'acc_2' }, { reject: ['mark'] });
    const suppressedErr = Object.assign(new Error('inactive recipient'), { code: 405 });
    const sendEmail = vi.fn().mockRejectedValue(suppressedErr);
    const svc = createEmailService({
      config,
      logger,
      client: { sendEmail },
      retryDelayFn: async () => {},
      accountEmailDeliveryTracker: tracker,
      sentry,
    });

    await expect(
      svc.sendPasswordReset({
        to: 'bounced@example.com',
        link: 'https://x',
        expiresAt: new Date(),
      }),
    ).resolves.not.toThrow();

    expect(tracker.markDeliveryFailed, 'the marker persist must be attempted').toHaveBeenCalled();
  });

  it('a transient failure that exhausts all retries logs error + captures Sentry, but does NOT set email_delivery_failed_at (reserved for the permanent inactive-recipient case)', async () => {
    const logger = makeLogger();
    const sentry = makeFakeSentry();
    const tracker = makeFakeTracker({ 'user@example.com': 'acc_1' });
    const transportErr = Object.assign(new Error('timed out'), { name: 'ETIMEDOUT' });
    const sendEmail = vi.fn().mockRejectedValue(transportErr);
    const svc = createEmailService({
      config,
      logger,
      client: { sendEmail },
      retryDelayFn: async () => {},
      accountEmailDeliveryTracker: tracker,
      sentry,
    });
    await svc.sendSignupVerification({
      to: 'user@example.com',
      link: 'https://x',
      expiresAt: new Date(),
    });

    // 1 initial + 2 retries = 3 attempts, all fail.
    expect(sendEmail).toHaveBeenCalledTimes(3);
    // Existing warn-level log + metric path is unchanged...
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'transport' }),
      expect.stringContaining('email send failed'),
    );
    // ...PLUS the new elevated error-level log + Sentry capture.
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'email',
        template: 'signup-verification',
        accountId: 'acc_1',
        category: 'transport',
      }),
      expect.stringContaining('security-critical email send failed'),
    );
    expect(sentry.captureException).toHaveBeenCalledWith(
      transportErr,
      expect.objectContaining({ accountId: 'acc_1', category: 'transport' }),
    );
    // Transient failure — reserved for 'inactive-recipient' only.
    expect(tracker.markDeliveryFailed).not.toHaveBeenCalled();
  });

  it('an inactive-recipient failure on a known active account sets email_delivery_failed_at without retrying', async () => {
    const logger = makeLogger();
    const sentry = makeFakeSentry();
    const tracker = makeFakeTracker({ 'bounced@example.com': 'acc_2' });
    const suppressedErr = Object.assign(new Error('inactive recipient'), { code: 405 });
    const sendEmail = vi.fn().mockRejectedValue(suppressedErr);
    const svc = createEmailService({
      config,
      logger,
      client: { sendEmail },
      retryDelayFn: async () => {},
      accountEmailDeliveryTracker: tracker,
      sentry,
    });
    await svc.sendPasswordReset({
      to: 'bounced@example.com',
      link: 'https://x',
      expiresAt: new Date(),
    });

    // inactive-recipient is Postmark's PERMANENT suppression state —
    // retrying it is pointless, so exactly 1 attempt, not 3.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(tracker.markDeliveryFailed).toHaveBeenCalledWith('acc_2', expect.any(Date));
    expect(tracker._failedAt.get('acc_2')).toBeInstanceOf(Date);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acc_2', category: 'inactive-recipient' }),
      expect.stringContaining('security-critical email send failed'),
    );
    expect(sentry.captureException).toHaveBeenCalled();
  });

  it('a subsequent successful send to that same account clears the flag back to null', async () => {
    const logger = makeLogger();
    const tracker = makeFakeTracker({ 'recovered@example.com': 'acc_3' });
    // Pre-seed the account as already-failed, as if a prior send had
    // set the marker.
    tracker._failedAt.set('acc_3', new Date('2026-06-01T00:00:00Z'));

    const svc = createEmailService({
      config,
      logger,
      client: { sendEmail: vi.fn().mockResolvedValue({}) },
      accountEmailDeliveryTracker: tracker,
    });
    await svc.sendPasswordReset({
      to: 'recovered@example.com',
      link: 'https://x',
      expiresAt: new Date(),
    });

    expect(tracker.clearDeliveryFailed).toHaveBeenCalledWith('acc_3');
    expect(tracker._failedAt.get('acc_3')).toBeNull();
  });

  it('does NOT retry or track a non-security-critical template (billing-receipt) even on a transient/inactive-recipient category', async () => {
    const logger = makeLogger();
    const tracker = makeFakeTracker({ 'user@example.com': 'acc_4' });
    const rateLimited = Object.assign(new Error('too many requests'), { code: 429 });
    const sendEmail = vi.fn().mockRejectedValue(rateLimited);
    const svc = createEmailService({
      config,
      logger,
      client: { sendEmail },
      retryDelayFn: async () => {},
      accountEmailDeliveryTracker: tracker,
    });
    await svc.sendBillingReceipt({
      to: 'user@example.com',
      amountFormatted: '$1.00',
      period: '2026-06',
      invoiceUrl: 'https://x',
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(tracker.findAccountIdByEmail).not.toHaveBeenCalled();
  });
});
