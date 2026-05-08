// Transactional email service.
//
// Wraps Postmark (`postmark` npm package, V-057). All sends are
// fire-and-forget: errors are logged at warn-level but never thrown
// to the caller, because email is never on a request critical path.
// If Postmark is misconfigured or down, the API stays up; affected
// users get the email on the next attempt or out-of-band.
//
// Templates are owned in this file as plain TS objects (subject +
// text body + HTML body). No Postmark "templates" feature dependency
// — that ties us to the vendor harder than necessary, and the
// templates are simple enough to keep inline.
//
// Email types defined here (those that actually fire from the
// control plane):
//   - signup-verification (magic-link, 30min single-use)
//   - signup-welcome              (V-202; fires after email verify)
//   - password-reset
//   - billing-receipt
//   - billing-failure
//   - subscription-cancellation
//   - support-ack (auto-reply when support@ receives a message)
//   - session-failed-first        (V-202; first-failure-only, V-090)
//   - tier-changed                (V-202)
//   - trial-pack-purchased        (V-202)
//   - trial-pack-expired          (V-202)

import { ServerClient as PostmarkClient } from 'postmark';
import type { Logger } from '../lib/logger.js';
import type { PostmarkConfig } from '../lib/config.js';

export interface EmailService {
  /**
   * Send a signup verification email containing a magic-link.
   * `link` should already include the 256-bit single-use token.
   * `expiresAt` is rendered into the template for the user.
   */
  sendSignupVerification(args: { to: string; link: string; expiresAt: Date }): Promise<void>;
  sendPasswordReset(args: { to: string; link: string; expiresAt: Date }): Promise<void>;
  sendBillingReceipt(args: {
    to: string;
    amountFormatted: string;
    period: string;
    invoiceUrl: string;
  }): Promise<void>;
  sendBillingFailure(args: {
    to: string;
    amountFormatted: string;
    retryAt: Date;
    portalUrl: string;
  }): Promise<void>;
  sendSubscriptionCancellation(args: {
    to: string;
    effectiveAt: Date;
    portalUrl: string;
  }): Promise<void>;
  sendSupportAck(args: { to: string; ticketId: string }): Promise<void>;
  /** V-202 — onboarding follow-up after email verification succeeds. */
  sendSignupWelcome(args: { to: string; dashboardUrl: string }): Promise<void>;
  /** V-202 — first-failure notice (V-090). Caller is responsible for deduplication. */
  sendSessionFailedFirst(args: {
    to: string;
    sessionId: string;
    errorMessage: string;
    docsUrl: string;
  }): Promise<void>;
  /** V-304a — first successful session notice. Once-per-account; caller dedupes. */
  sendSessionSuccessFirst(args: {
    to: string;
    sessionId: string;
    dashboardUrl: string;
    docsUrl: string;
  }): Promise<void>;
  /** V-202 — tier change confirmation; fires on Stripe subscription.updated. */
  sendTierChanged(args: {
    to: string;
    fromTier: string;
    toTier: string;
    effectiveAt: Date;
    portalUrl: string;
  }): Promise<void>;
  /** V-202 — trial-pack purchase confirmation. */
  sendTrialPackPurchased(args: {
    to: string;
    creditCentsRemaining: number;
    expiresAt: Date;
    dashboardUrl: string;
  }): Promise<void>;
  /** V-202 — trial-pack expiry notice. Fires from the expiry job. */
  sendTrialPackExpired(args: { to: string; upgradeUrl: string }): Promise<void>;
  /**
   * V-295c3 — public-status-page subscriber double-opt-in confirmation.
   * `confirmLink` is the URL containing the plaintext confirm token.
   */
  sendStatusSubscriptionConfirmation(args: {
    to: string;
    confirmLink: string;
    expiresAt: Date;
  }): Promise<void>;
  /** V-295c3 — fires after successful confirmation. Includes unsub link. */
  sendStatusSubscriptionWelcome(args: {
    to: string;
    statusPageUrl: string;
    unsubscribeLink: string;
  }): Promise<void>;
  /** V-295c3-followup — fires when a public incident is posted or resolved. */
  sendStatusIncidentNotification(args: {
    to: string;
    /** 'created' or 'resolved'. */
    kind: 'created' | 'resolved';
    title: string;
    severity: string;
    status: string;
    message: string;
    incidentTime: Date;
    statusPageUrl: string;
    unsubscribeLink: string;
  }): Promise<void>;
  /** True if the underlying client is configured + initialized. */
  readonly isConfigured: boolean;
}

interface Template {
  subject: string;
  text: (vars: Record<string, string>) => string;
  html: (vars: Record<string, string>) => string;
}

const TEMPLATES = {
  'signup-verification': {
    subject: 'Verify your Driftstack account',
    text: (v) =>
      `Welcome to Driftstack.\n\nVerify your account by clicking the link below. It expires at ${v.expiresAt} (UTC) and can only be used once.\n\n${v.link}\n\nIf you didn't request this, you can ignore this email.\n\n— Driftstack`,
    html: (v) =>
      `<p>Welcome to Driftstack.</p><p>Verify your account by clicking the link below. It expires at <strong>${v.expiresAt}</strong> (UTC) and can only be used once.</p><p><a href="${v.link}">${v.link}</a></p><p>If you didn't request this, you can ignore this email.</p><p>— Driftstack</p>`,
  },
  'password-reset': {
    subject: 'Reset your Driftstack password',
    text: (v) =>
      `A password reset was requested for your Driftstack account.\n\n${v.link}\n\nThis link expires at ${v.expiresAt} (UTC) and can only be used once. If you didn't request this, ignore this email — your password is unchanged.\n\n— Driftstack`,
    html: (v) =>
      `<p>A password reset was requested for your Driftstack account.</p><p><a href="${v.link}">${v.link}</a></p><p>This link expires at <strong>${v.expiresAt}</strong> (UTC) and can only be used once. If you didn't request this, ignore this email — your password is unchanged.</p><p>— Driftstack</p>`,
  },
  'billing-receipt': {
    subject: 'Driftstack — payment receipt',
    text: (v) =>
      `Your payment of ${v.amountFormatted} for the ${v.period} period was successful.\n\nInvoice: ${v.invoiceUrl}\n\n— Driftstack`,
    html: (v) =>
      `<p>Your payment of <strong>${v.amountFormatted}</strong> for the ${v.period} period was successful.</p><p><a href="${v.invoiceUrl}">View invoice</a></p><p>— Driftstack</p>`,
  },
  'billing-failure': {
    subject: 'Driftstack — payment failed',
    text: (v) =>
      `We were unable to charge ${v.amountFormatted} on your Driftstack account.\n\nWe'll retry automatically at ${v.retryAt} (UTC). To update payment details before then, visit the billing portal:\n\n${v.portalUrl}\n\n— Driftstack`,
    html: (v) =>
      `<p>We were unable to charge <strong>${v.amountFormatted}</strong> on your Driftstack account.</p><p>We'll retry automatically at <strong>${v.retryAt}</strong> (UTC). To update payment details before then, visit the <a href="${v.portalUrl}">billing portal</a>.</p><p>— Driftstack</p>`,
  },
  'subscription-cancellation': {
    subject: 'Driftstack — subscription cancelled',
    text: (v) =>
      `Your Driftstack subscription has been cancelled. Service continues through ${v.effectiveAt} (UTC), after which API access stops.\n\nIf this was unintended, you can resubscribe via the billing portal:\n\n${v.portalUrl}\n\n— Driftstack`,
    html: (v) =>
      `<p>Your Driftstack subscription has been cancelled. Service continues through <strong>${v.effectiveAt}</strong> (UTC), after which API access stops.</p><p>If this was unintended, you can resubscribe via the <a href="${v.portalUrl}">billing portal</a>.</p><p>— Driftstack</p>`,
  },
  'support-ack': {
    subject: 'Driftstack support — we got your message',
    text: (v) =>
      `Thanks — we've received your message and opened ticket ${v.ticketId}. A human will reply within one business day.\n\n— Driftstack support`,
    html: (v) =>
      `<p>Thanks — we've received your message and opened ticket <strong>${v.ticketId}</strong>. A human will reply within one business day.</p><p>— Driftstack support</p>`,
  },
  'signup-welcome': {
    subject: 'Welcome to Driftstack',
    text: (v) =>
      `Your Driftstack account is ready.\n\nNext steps:\n  1. Pick a tier or grab the $2.99 trial pack at ${v.dashboardUrl}\n  2. Mint your first API key from the dashboard\n  3. Run your first session via the SDK\n\nAny questions: reply to this email.\n\n— Driftstack`,
    html: (v) =>
      `<p>Your Driftstack account is ready.</p><p>Next steps:</p><ol><li>Pick a tier or grab the <strong>$2.99 trial pack</strong> at <a href="${v.dashboardUrl}">${v.dashboardUrl}</a></li><li>Mint your first API key from the dashboard</li><li>Run your first session via the SDK</li></ol><p>Any questions: reply to this email.</p><p>— Driftstack</p>`,
  },
  'session-failed-first': {
    subject: 'Driftstack — your first session failure',
    text: (v) =>
      `One of your Driftstack sessions failed: ${v.sessionId}\n\nError: ${v.errorMessage}\n\nThis is a one-time notice — we don't email on subsequent failures (the dashboard + webhooks track those). Common causes + fixes are documented at ${v.docsUrl}.\n\n— Driftstack`,
    html: (v) =>
      `<p>One of your Driftstack sessions failed: <code>${v.sessionId}</code></p><p><strong>Error:</strong> ${v.errorMessage}</p><p>This is a one-time notice — we don't email on subsequent failures (the dashboard + webhooks track those). Common causes + fixes are documented at <a href="${v.docsUrl}">${v.docsUrl}</a>.</p><p>— Driftstack</p>`,
  },
  // V-304a — DRAFT copy. First successful session = activation milestone.
  // Once-per-account; caller dedupes via firstSuccessEmailSentAt column.
  'session-success-first': {
    subject: 'Driftstack — your first session is up',
    text: (v) =>
      `Your first Driftstack session ran successfully (${v.sessionId}). The control plane is wired, the Mac mini fleet is running your archetype, and webhook deliveries are firing.\n\nNext steps:\n  1. Watch live activity in the dashboard: ${v.dashboardUrl}\n  2. Skim the quickstart for advanced patterns (recordings, profiles, webhook events): ${v.docsUrl}\n  3. Mint additional API keys for staging / CI / per-app environments via the dashboard.\n\nThis is a one-time email — subsequent sessions don't notify you. The dashboard + webhooks take over from here.\n\n— Driftstack`,
    html: (v) =>
      `<p>Your first Driftstack session ran successfully (<code>${v.sessionId}</code>). The control plane is wired, the Mac mini fleet is running your archetype, and webhook deliveries are firing.</p><p><strong>Next steps:</strong></p><ol><li>Watch live activity in the <a href="${v.dashboardUrl}">dashboard</a>.</li><li>Skim the <a href="${v.docsUrl}">quickstart</a> for advanced patterns (recordings, profiles, webhook events).</li><li>Mint additional API keys for staging / CI / per-app environments via the dashboard.</li></ol><p>This is a one-time email — subsequent sessions don't notify you. The dashboard + webhooks take over from here.</p><p>— Driftstack</p>`,
  },
  'tier-changed': {
    subject: 'Driftstack — subscription tier changed',
    text: (v) =>
      `Your Driftstack subscription has been changed from ${v.fromTier} to ${v.toTier}, effective ${v.effectiveAt} (UTC).\n\nManage subscription: ${v.portalUrl}\n\n— Driftstack`,
    html: (v) =>
      `<p>Your Driftstack subscription has been changed from <strong>${v.fromTier}</strong> to <strong>${v.toTier}</strong>, effective <strong>${v.effectiveAt}</strong> (UTC).</p><p><a href="${v.portalUrl}">Manage subscription</a></p><p>— Driftstack</p>`,
  },
  'trial-pack-purchased': {
    subject: 'Driftstack — $2.99 trial pack purchased',
    text: (v) =>
      `Your $2.99 trial pack is active.\n\nCredit remaining: ${v.creditCentsRemaining} cents (~16 hours of iPhone Safari sessions at $0.18/hr)\nExpires: ${v.expiresAt} (UTC, 14 days)\n\nReady when you are: ${v.dashboardUrl}\n\nAfter the trial pack expires, your account stays free — no auto-charge. Pick a paid tier any time.\n\n— Driftstack`,
    html: (v) =>
      `<p>Your <strong>$2.99 trial pack</strong> is active.</p><ul><li><strong>Credit remaining:</strong> ${v.creditCentsRemaining} cents (~16 hours of iPhone Safari sessions at $0.18/hr)</li><li><strong>Expires:</strong> ${v.expiresAt} (UTC, 14 days)</li></ul><p>Ready when you are: <a href="${v.dashboardUrl}">${v.dashboardUrl}</a></p><p>After the trial pack expires, your account stays free — no auto-charge. Pick a paid tier any time.</p><p>— Driftstack</p>`,
  },
  'trial-pack-expired': {
    subject: 'Driftstack — trial pack expired',
    text: (v) =>
      `Your Driftstack trial pack has expired (14-day window closed). Your account stays active but at $0/month — no charges.\n\nPick a paid tier when you're ready: ${v.upgradeUrl}\n\nThe trial pack is once per account; subsequent activity goes through a regular subscription.\n\n— Driftstack`,
    html: (v) =>
      `<p>Your Driftstack trial pack has expired (14-day window closed). Your account stays active but at <strong>$0/month</strong> — no charges.</p><p>Pick a paid tier when you're ready: <a href="${v.upgradeUrl}">${v.upgradeUrl}</a></p><p>The trial pack is once per account; subsequent activity goes through a regular subscription.</p><p>— Driftstack</p>`,
  },
  // V-295c3 — DRAFT copy. Tier-3 review-gated; founder may revise the
  // copy before launch. Engineering scaffolding ships unchanged.
  'status-subscription-confirmation': {
    subject: 'Confirm your Driftstack status updates',
    text: (v) =>
      `You asked to receive Driftstack service-status updates. Confirm with the link below — it expires at ${v.expiresAt} (UTC) and works once.\n\n${v.confirmLink}\n\nIf you didn't request this, ignore this email — no email address is added to the list until you confirm.\n\n— Driftstack`,
    html: (v) =>
      `<p>You asked to receive Driftstack service-status updates. Confirm with the link below — it expires at <strong>${v.expiresAt}</strong> (UTC) and works once.</p><p><a href="${v.confirmLink}">${v.confirmLink}</a></p><p>If you didn't request this, ignore this email — no email address is added to the list until you confirm.</p><p>— Driftstack</p>`,
  },
  'status-subscription-welcome': {
    subject: 'You’re subscribed to Driftstack status',
    text: (v) =>
      `You're now subscribed to Driftstack service-status updates. We'll email you when an incident is posted and again when it's resolved — nothing else.\n\nLive status: ${v.statusPageUrl}\nUnsubscribe (one click): ${v.unsubscribeLink}\n\n— Driftstack`,
    html: (v) =>
      `<p>You're now subscribed to Driftstack service-status updates. We'll email you when an incident is posted and again when it's resolved — nothing else.</p><p>Live status: <a href="${v.statusPageUrl}">${v.statusPageUrl}</a><br />Unsubscribe (one click): <a href="${v.unsubscribeLink}">${v.unsubscribeLink}</a></p><p>— Driftstack</p>`,
  },
  // V-295c3-followup — DRAFT copy. Two templates so the subject can vary
  // (a "resolved" email shouldn't read like a fresh outage).
  'status-incident-created': {
    subject: '[Driftstack status] Incident posted',
    text: (v) =>
      `Driftstack just posted a service-status incident.\n\nIncident: ${v.title}\nSeverity: ${v.severity}\nCurrent status: ${v.status}\nTimestamp: ${v.incidentTime} (UTC)\n\nDetails:\n${v.message}\n\nLive status: ${v.statusPageUrl}\nUnsubscribe: ${v.unsubscribeLink}\n\n— Driftstack`,
    html: (v) =>
      `<p>Driftstack just posted a service-status incident.</p><table cellpadding="4" style="border-collapse:collapse"><tr><td><strong>Incident:</strong></td><td>${v.title}</td></tr><tr><td><strong>Severity:</strong></td><td>${v.severity}</td></tr><tr><td><strong>Current status:</strong></td><td>${v.status}</td></tr><tr><td><strong>Timestamp:</strong></td><td>${v.incidentTime} (UTC)</td></tr></table><p><strong>Details:</strong><br />${v.message}</p><p>Live status: <a href="${v.statusPageUrl}">${v.statusPageUrl}</a><br />Unsubscribe: <a href="${v.unsubscribeLink}">${v.unsubscribeLink}</a></p><p>— Driftstack</p>`,
  },
  'status-incident-resolved': {
    subject: '[Driftstack status] Incident resolved',
    text: (v) =>
      `Driftstack has resolved the open service-status incident.\n\nIncident: ${v.title}\nResolved at: ${v.incidentTime} (UTC)\n\nResolution notes:\n${v.message}\n\nLive status: ${v.statusPageUrl}\nUnsubscribe: ${v.unsubscribeLink}\n\n— Driftstack`,
    html: (v) =>
      `<p>Driftstack has resolved the open service-status incident.</p><table cellpadding="4" style="border-collapse:collapse"><tr><td><strong>Incident:</strong></td><td>${v.title}</td></tr><tr><td><strong>Resolved at:</strong></td><td>${v.incidentTime} (UTC)</td></tr></table><p><strong>Resolution notes:</strong><br />${v.message}</p><p>Live status: <a href="${v.statusPageUrl}">${v.statusPageUrl}</a><br />Unsubscribe: <a href="${v.unsubscribeLink}">${v.unsubscribeLink}</a></p><p>— Driftstack</p>`,
  },
} satisfies Record<string, Template>;

type TemplateName = keyof typeof TEMPLATES;

export interface PostmarkSendApi {
  sendEmail(input: {
    From: string;
    To: string;
    Subject: string;
    TextBody: string;
    HtmlBody: string;
    ReplyTo: string;
    MessageStream: string;
  }): Promise<unknown>;
}

export interface CreateEmailServiceArgs {
  config: PostmarkConfig | null;
  logger: Logger;
  /** Test seam: pass a stub client. Defaults to a real PostmarkClient. */
  client?: PostmarkSendApi;
  /** Postmark message stream. Default `outbound`. */
  messageStream?: string;
}

export function createEmailService({
  config,
  logger,
  client,
  messageStream = 'outbound',
}: CreateEmailServiceArgs): EmailService {
  if (config === null) {
    logger.warn(
      { component: 'email' },
      'Postmark not configured — email sends will be no-ops. Set POSTMARK_API_TOKEN/FROM/REPLY_TO to enable.',
    );
    return {
      isConfigured: false,
      sendSignupVerification: async () => {},
      sendPasswordReset: async () => {},
      sendBillingReceipt: async () => {},
      sendBillingFailure: async () => {},
      sendSubscriptionCancellation: async () => {},
      sendSupportAck: async () => {},
      sendSignupWelcome: async () => {},
      sendSessionFailedFirst: async () => {},
      sendSessionSuccessFirst: async () => {},
      sendTierChanged: async () => {},
      sendTrialPackPurchased: async () => {},
      sendTrialPackExpired: async () => {},
      sendStatusSubscriptionConfirmation: async () => {},
      sendStatusSubscriptionWelcome: async () => {},
      sendStatusIncidentNotification: async () => {},
    };
  }

  const postmark: PostmarkSendApi = client ?? new PostmarkClient(config.apiToken);

  async function send(name: TemplateName, to: string, vars: Record<string, string>): Promise<void> {
    const tpl = TEMPLATES[name];
    try {
      await postmark.sendEmail({
        From: config!.from,
        To: to,
        Subject: tpl.subject,
        TextBody: tpl.text(vars),
        HtmlBody: tpl.html(vars),
        ReplyTo: config!.replyTo,
        MessageStream: messageStream,
      });
      logger.info({ component: 'email', template: name, to }, 'email sent');
    } catch (err) {
      logger.warn(
        {
          component: 'email',
          template: name,
          to,
          err: err instanceof Error ? { name: err.name, message: err.message } : { value: err },
        },
        'email send failed (fire-and-forget)',
      );
      // Deliberately swallow — email is never on a request critical path.
    }
  }

  return {
    isConfigured: true,
    sendSignupVerification: ({ to, link, expiresAt }) =>
      send('signup-verification', to, { link, expiresAt: expiresAt.toISOString() }),
    sendPasswordReset: ({ to, link, expiresAt }) =>
      send('password-reset', to, { link, expiresAt: expiresAt.toISOString() }),
    sendBillingReceipt: ({ to, amountFormatted, period, invoiceUrl }) =>
      send('billing-receipt', to, { amountFormatted, period, invoiceUrl }),
    sendBillingFailure: ({ to, amountFormatted, retryAt, portalUrl }) =>
      send('billing-failure', to, {
        amountFormatted,
        retryAt: retryAt.toISOString(),
        portalUrl,
      }),
    sendSubscriptionCancellation: ({ to, effectiveAt, portalUrl }) =>
      send('subscription-cancellation', to, {
        effectiveAt: effectiveAt.toISOString(),
        portalUrl,
      }),
    sendSupportAck: ({ to, ticketId }) => send('support-ack', to, { ticketId }),
    sendSignupWelcome: ({ to, dashboardUrl }) => send('signup-welcome', to, { dashboardUrl }),
    sendSessionFailedFirst: ({ to, sessionId, errorMessage, docsUrl }) =>
      send('session-failed-first', to, { sessionId, errorMessage, docsUrl }),
    sendSessionSuccessFirst: ({ to, sessionId, dashboardUrl, docsUrl }) =>
      send('session-success-first', to, { sessionId, dashboardUrl, docsUrl }),
    sendTierChanged: ({ to, fromTier, toTier, effectiveAt, portalUrl }) =>
      send('tier-changed', to, {
        fromTier,
        toTier,
        effectiveAt: effectiveAt.toISOString(),
        portalUrl,
      }),
    sendTrialPackPurchased: ({ to, creditCentsRemaining, expiresAt, dashboardUrl }) =>
      send('trial-pack-purchased', to, {
        creditCentsRemaining: String(creditCentsRemaining),
        expiresAt: expiresAt.toISOString(),
        dashboardUrl,
      }),
    sendTrialPackExpired: ({ to, upgradeUrl }) => send('trial-pack-expired', to, { upgradeUrl }),
    sendStatusSubscriptionConfirmation: ({ to, confirmLink, expiresAt }) =>
      send('status-subscription-confirmation', to, {
        confirmLink,
        expiresAt: expiresAt.toISOString(),
      }),
    sendStatusSubscriptionWelcome: ({ to, statusPageUrl, unsubscribeLink }) =>
      send('status-subscription-welcome', to, { statusPageUrl, unsubscribeLink }),
    sendStatusIncidentNotification: ({
      to,
      kind,
      title,
      severity,
      status,
      message,
      incidentTime,
      statusPageUrl,
      unsubscribeLink,
    }) =>
      send(kind === 'created' ? 'status-incident-created' : 'status-incident-resolved', to, {
        title,
        severity,
        status,
        message,
        incidentTime: incidentTime.toISOString(),
        statusPageUrl,
        unsubscribeLink,
      }),
  };
}
