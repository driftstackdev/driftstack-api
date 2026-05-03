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
//   - password-reset
//   - billing-receipt
//   - billing-failure
//   - subscription-cancellation
//   - support-ack (auto-reply when support@ receives a message)

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
  };
}
