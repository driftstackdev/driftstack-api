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
//   - oauth-pending-verification  (V-667.C; verdict-1 merge confirm)

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
  /** V-304b — fires ~7 days before subscription renewal (driven by
   *  Stripe `invoice.upcoming` webhook). Once-per-invoice via dedup
   *  on the calling side. */
  sendBillingRenewalReminder(args: {
    to: string;
    amountFormatted: string;
    renewalDate: Date;
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
  /** V-298b — team invite email. acceptLink contains the token. */
  sendTeamInvite(args: {
    to: string;
    acceptLink: string;
    expiresAt: Date;
    role: 'member' | 'admin';
  }): Promise<void>;
  /**
   * V-667.C — Verdict-1 verify-merge email. Sent to an existing
   * account's verified email when an IDP sign-in attempt resolves
   * to that account but no link exists yet. `confirmLink` carries
   * the plaintext single-use token; clicking it completes the merge.
   */
  sendOauthPendingLinkVerification(args: {
    to: string;
    provider: 'google' | 'github';
    confirmLink: string;
    expiresAt: Date;
  }): Promise<void>;
  /**
   * v2-#10.5 — webhook signing-secret rotation reminder. Fires when
   * an endpoint's active secret is older than the rotation threshold
   * (60d nag, 90d target). Body includes the endpoint URL + secret
   * prefix so the customer can identify which endpoint without
   * leaking the full secret.
   */
  sendWebhookSecretRotationReminder(args: {
    to: string;
    endpointUrl: string;
    secretPrefix: string;
    ageDays: number;
    rotateBy: Date;
    /**
     * v2-#36 — customer-facing dashboard origin (DASHBOARD_ORIGIN env).
     * Threaded from bootstrap so the rotation link in the email points
     * at the right host across dev / staging / prod. Pre-v2-#36 the
     * template hardcoded https://app.driftstack.dev — staging emails
     * mis-directed customers to prod.
     */
    dashboardUrl: string;
  }): Promise<void>;
  /**
   * Arc 3 sub-slice 28.4 (v2-#28) — server-initiated force-rotation
   * notification. Fires after the daily sweep (sub-slice 28.2) auto-
   * rotates a secret past the 91-day cap. Distinct from the 60-day
   * reminder: this one carries the new secret prefix + 7-day grace
   * deadline so the customer knows their old secret stops verifying
   * after that point.
   */
  sendWebhookSecretForceRotated(args: {
    to: string;
    endpointUrl: string;
    newSecretPrefix: string;
    graceWindowEndsAt: Date;
    dashboardUrl: string;
  }): Promise<void>;
  /**
   * Arc 3 sub-slice 28.5 (v2-#28) — 24h-before-grace-expiry nag.
   * Last chance for the customer to update their verifier before
   * the old secret stops working.
   */
  sendWebhookSecretGraceExpiring(args: {
    to: string;
    endpointUrl: string;
    secretPrefix: string;
    graceWindowEndsAt: Date;
    dashboardUrl: string;
  }): Promise<void>;
  /**
   * v2-#11.5 — BYOK Anthropic API key rotation reminder. Fires when
   * the customer's stored BYOK key was set more than the rotation
   * threshold ago (60d nag, 90d target). No prefix shown — Anthropic
   * keys are sensitive enough that we never echo any portion in mail.
   */
  sendByokAnthropicKeyRotationReminder(args: {
    to: string;
    ageDays: number;
    rotateBy: Date;
    /** v2-#36 — same dashboard-origin threading as the webhook reminder. */
    dashboardUrl: string;
  }): Promise<void>;
  /** V-295c3-followup + V-545.B — fires when a public incident is posted,
   *  updated, or resolved. The 'updated' kind is wired-but-deferred:
   *  the template is shipped so subscribers receive it once the V-545.B
   *  throttling-table follow-up lands. Until then, callers default to
   *  'created' / 'resolved'. */
  sendStatusIncidentNotification(args: {
    to: string;
    /** 'created' | 'updated' | 'resolved'. */
    kind: 'created' | 'updated' | 'resolved';
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

/**
 * V-665 — classifying email-send failure categories.
 *
 * Postmark surfaces structured `{ code, statusCode, message }` errors
 * via the `postmark` npm package. The most operationally-important
 * distinction is "account pending approval" (the expected pre-approval
 * state while Postmark reviews our account) vs genuine ops-attention
 * failures (recipient bounced, rate-limited, transport broke).
 *
 * Reference codes (from Postmark API docs):
 *   - 412 — Account pending approval / sender not yet verified.
 *   - 405 — Recipient inactive (hard-bounced / spam-complained).
 *   - 406 — Account inactive (paused / cancelled).
 *   - 422 — Invalid email request (malformed body).
 *   - 429 — Rate limit.
 */
export type EmailErrorCategory =
  | 'pending-approval'
  | 'inactive-recipient'
  | 'account-inactive'
  | 'invalid-request'
  | 'rate-limited'
  | 'transport'
  | 'unknown';

export function classifyEmailError(err: unknown): {
  category: EmailErrorCategory;
  postmarkCode: number | null;
} {
  if (err === null || typeof err !== 'object') {
    return { category: 'unknown', postmarkCode: null };
  }
  // Postmark errors carry a `code` (numeric) and a `message` field;
  // bypass the typed-error vs plain-object distinction by reading
  // `code` defensively. `name` matters for transport-level errors
  // (ECONNRESET, ETIMEDOUT, etc).
  const e = err as { code?: unknown; message?: unknown; name?: unknown };
  const code = typeof e.code === 'number' ? e.code : null;

  if (code === 412) return { category: 'pending-approval', postmarkCode: 412 };
  if (code === 405) return { category: 'inactive-recipient', postmarkCode: 405 };
  if (code === 406) return { category: 'account-inactive', postmarkCode: 406 };
  if (code === 422) return { category: 'invalid-request', postmarkCode: 422 };
  if (code === 429) return { category: 'rate-limited', postmarkCode: 429 };

  // Transport-level failures land here when Postmark itself can't be
  // reached — connection refused, DNS, timeout, etc. The `name`
  // discriminates the underlying socket / fetch error.
  const name = typeof e.name === 'string' ? e.name : '';
  const transportNames = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'EAI_AGAIN',
    'FetchError',
  ]);
  if (transportNames.has(name)) return { category: 'transport', postmarkCode: null };

  // Pattern-match the message as a last resort: Postmark's `Message`
  // field for pending-approval errors contains a recognizable phrase,
  // and some wrapper libraries set `code` as a string instead of a
  // number.
  const message = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  if (message.includes('pending approval') || message.includes('not yet approved')) {
    return { category: 'pending-approval', postmarkCode: code };
  }

  return { category: 'unknown', postmarkCode: code };
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
  // V-304b — DRAFT copy. Renewal reminder fires ~7 days before the
  // upcoming invoice. Tier-3 review-gated tone.
  'billing-renewal-reminder': {
    subject: 'Driftstack — your subscription renews in 7 days',
    text: (v) =>
      `Heads up — your Driftstack subscription renews on ${v.renewalDate} (UTC) for ${v.amountFormatted}.\n\nNothing to do if your payment method is up to date. To update payment details, change tier, or cancel before renewal, visit the billing portal:\n\n${v.portalUrl}\n\n— Driftstack`,
    html: (v) =>
      `<p>Heads up — your Driftstack subscription renews on <strong>${v.renewalDate}</strong> (UTC) for <strong>${v.amountFormatted}</strong>.</p><p>Nothing to do if your payment method is up to date. To update payment details, change tier, or cancel before renewal, visit the <a href="${v.portalUrl}">billing portal</a>.</p><p>— Driftstack</p>`,
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
  // V-298b — DRAFT copy. Team invite email.
  'team-invite': {
    subject: 'You’re invited to join a Driftstack team',
    text: (v) =>
      `You've been invited to join a Driftstack team as a ${v.role}.\n\nAccept the invite by clicking the link below. It expires at ${v.expiresAt} (UTC) and works once.\n\n${v.acceptLink}\n\nIf you don't have a Driftstack account yet, you'll be prompted to sign up first. The invite must be accepted by the same email address it was sent to.\n\n— Driftstack`,
    html: (v) =>
      `<p>You've been invited to join a Driftstack team as a <strong>${v.role}</strong>.</p><p>Accept the invite by clicking the link below. It expires at <strong>${v.expiresAt}</strong> (UTC) and works once.</p><p><a href="${v.acceptLink}">${v.acceptLink}</a></p><p>If you don't have a Driftstack account yet, you'll be prompted to sign up first. The invite must be accepted by the same email address it was sent to.</p><p>— Driftstack</p>`,
  },
  // V-667.C — Verdict-1 verify-merge. Sent when an IDP sign-in
  // resolves to an existing email but no link exists; the recipient
  // must click confirmLink within 60 minutes to complete the merge.
  // Provider name is rendered into the body so the user can tell
  // which IDP (Google vs GitHub) initiated the attempt — material
  // for the "this wasn't me" decision.
  'oauth-pending-verification': {
    subject: 'Driftstack — confirm a new sign-in method on your account',
    text: (v) =>
      `Someone — probably you — just tried to sign in to your Driftstack account using ${v.provider}.\n\nIf that was you, confirm the new sign-in method by clicking the link below. It expires at ${v.expiresAt} (UTC) and works once.\n\n${v.confirmLink}\n\nIf that wasn't you, ignore this email — no change is made until the link is clicked. Your password (if any) still works.\n\n— Driftstack`,
    html: (v) =>
      `<p>Someone — probably you — just tried to sign in to your Driftstack account using <strong>${v.provider}</strong>.</p><p>If that was you, confirm the new sign-in method by clicking the link below. It expires at <strong>${v.expiresAt}</strong> (UTC) and works once.</p><p><a href="${v.confirmLink}">${v.confirmLink}</a></p><p>If that wasn't you, ignore this email — no change is made until the link is clicked. Your password (if any) still works.</p><p>— Driftstack</p>`,
  },
  // v2-#11.5 — BYOK Anthropic key rotation nag. Subject explicit
  // about provider name (Anthropic) so the customer immediately
  // knows which credential they need to rotate. No partial-key
  // echo in the body — Anthropic keys are sensitive enough that
  // we never leak any portion of them in mail.
  'byok-anthropic-key-rotation-reminder': {
    subject: 'Driftstack — rotate your Anthropic API key',
    text: (v) =>
      `Your stored Anthropic API key on Driftstack is ${v.ageDays} days old. We recommend rotating every 90 days; we've reached the nag threshold.\n\nRotate by: ${v.rotateBy} (UTC)\n\nGenerate a fresh key in your Anthropic console (https://console.anthropic.com/) and update it on your Driftstack account at:\n${v.dashboardUrl}/account/byok-anthropic\n\n— Driftstack`,
    html: (v) =>
      `<p>Your stored Anthropic API key on Driftstack is <strong>${v.ageDays} days old</strong>. We recommend rotating every 90 days; we've reached the nag threshold.</p><table cellpadding="4" style="border-collapse:collapse"><tr><td><strong>Rotate by:</strong></td><td>${v.rotateBy} (UTC)</td></tr></table><p>Generate a fresh key in your <a href="https://console.anthropic.com/">Anthropic console</a> and update it on your Driftstack account at <a href="${v.dashboardUrl}/account/byok-anthropic">${v.dashboardUrl}/account/byok-anthropic</a>.</p><p>— Driftstack</p>`,
  },
  // v2-#10.5 — 90d rotation cadence nag. Endpoint URL + secret prefix
  // is enough for the customer to identify the endpoint without
  // re-exposing the full secret. Body explicitly notes that this is
  // a nag, not auto-rotation — the V-359 dual-sign machinery gives
  // the customer a zero-downtime path.
  'webhook-secret-rotation-reminder': {
    subject: 'Driftstack — rotate your webhook signing secret',
    text: (v) =>
      `Your Driftstack webhook signing secret is ${v.ageDays} days old. We recommend rotating every 90 days; we've reached the nag threshold.\n\nEndpoint: ${v.endpointUrl}\nSecret prefix: ${v.secretPrefix}\nRotate by: ${v.rotateBy} (UTC)\n\nRotation is zero-downtime: the previous secret stays valid for 24h after rotation so your verifier code can roll the new value at its own pace.\n\nRotate at: ${v.dashboardUrl}/webhooks\n\n— Driftstack`,
    html: (v) =>
      `<p>Your Driftstack webhook signing secret is <strong>${v.ageDays} days old</strong>. We recommend rotating every 90 days; we've reached the nag threshold.</p><table cellpadding="4" style="border-collapse:collapse"><tr><td><strong>Endpoint:</strong></td><td><code>${v.endpointUrl}</code></td></tr><tr><td><strong>Secret prefix:</strong></td><td><code>${v.secretPrefix}</code></td></tr><tr><td><strong>Rotate by:</strong></td><td>${v.rotateBy} (UTC)</td></tr></table><p>Rotation is zero-downtime: the previous secret stays valid for 24h after rotation so your verifier code can roll the new value at its own pace.</p><p><a href="${v.dashboardUrl}/webhooks">Rotate at ${v.dashboardUrl}/webhooks</a></p><p>— Driftstack</p>`,
  },
  // Arc 3 sub-slice 28.4 (v2-#28) — server-initiated force-rotation
  // notification. Fires once per cycle when the 91-day cap is crossed
  // (Q1=B). Body carries the new secret prefix + 7-day grace deadline
  // (Q2=B) so the customer knows when the old secret stops verifying.
  // Arc 3 sub-slice 28.5 (v2-#28) — 24h-before-grace-expiry nag (Q3=B).
  'webhook-secret-grace-expiring': {
    subject: 'Driftstack — webhook secret grace window expires in 24h',
    text: (v) =>
      `Heads up — the previous secret for one of your webhook endpoints is about to stop verifying.\n\nEndpoint: ${v.endpointUrl}\nNew secret prefix: ${v.secretPrefix}\nGrace window ends: ${v.graceWindowEndsAt} (UTC)\n\nIf your verifier code still has the OLD secret configured, update it to the new value before the grace window closes. After that point, HMAC signatures will only verify against the new secret and your endpoint will start rejecting Driftstack deliveries.\n\nFetch the current secret at:\n${v.dashboardUrl}/webhooks\n\n— Driftstack`,
    html: (v) =>
      `<p>Heads up — the previous secret for one of your webhook endpoints is about to stop verifying.</p><table cellpadding="4" style="border-collapse:collapse"><tr><td><strong>Endpoint:</strong></td><td><code>${v.endpointUrl}</code></td></tr><tr><td><strong>New secret prefix:</strong></td><td><code>${v.secretPrefix}</code></td></tr><tr><td><strong>Grace window ends:</strong></td><td>${v.graceWindowEndsAt} (UTC)</td></tr></table><p>If your verifier code still has the OLD secret configured, update it to the new value before the grace window closes. After that point, HMAC signatures will only verify against the new secret and your endpoint will start rejecting Driftstack deliveries.</p><p>Fetch the current secret at <a href="${v.dashboardUrl}/webhooks">${v.dashboardUrl}/webhooks</a>.</p><p>— Driftstack</p>`,
  },
  'webhook-secret-force-rotated': {
    subject: 'Driftstack — your webhook secret was auto-rotated for security',
    text: (v) =>
      `Your Driftstack webhook signing secret was past our 91-day security cap, so we auto-rotated it for you.\n\nEndpoint: ${v.endpointUrl}\nNew secret prefix: ${v.newSecretPrefix}\nGrace window ends: ${v.graceWindowEndsAt} (UTC)\n\nThe previous secret stays valid until the grace window ends so your verifier code has time to pick up the new value. After that point only the new secret will verify HMAC signatures.\n\nFetch the new secret + manage your endpoints at:\n${v.dashboardUrl}/webhooks\n\n— Driftstack`,
    html: (v) =>
      `<p>Your Driftstack webhook signing secret was past our 91-day security cap, so we auto-rotated it for you.</p><table cellpadding="4" style="border-collapse:collapse"><tr><td><strong>Endpoint:</strong></td><td><code>${v.endpointUrl}</code></td></tr><tr><td><strong>New secret prefix:</strong></td><td><code>${v.newSecretPrefix}</code></td></tr><tr><td><strong>Grace window ends:</strong></td><td>${v.graceWindowEndsAt} (UTC)</td></tr></table><p>The previous secret stays valid until the grace window ends so your verifier code has time to pick up the new value. After that point only the new secret will verify HMAC signatures.</p><p>Fetch the new secret + manage your endpoints at <a href="${v.dashboardUrl}/webhooks">${v.dashboardUrl}/webhooks</a>.</p><p>— Driftstack</p>`,
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
  // V-545.B — DRAFT copy. Per-update notification (Phase 2 wire-up
  // pending throttling table; the template is shipped so the bootstrap
  // wire can land in a single follow-up wave). Subject distinguishes
  // updates from the initial "incident posted" to avoid confusing
  // subscribers who'd otherwise read repeated "[posted]" subjects on
  // a long-running incident.
  'status-incident-updated': {
    subject: '[Driftstack status] Incident update',
    text: (v) =>
      `Driftstack posted an update on an open service-status incident.\n\nIncident: ${v.title}\nSeverity: ${v.severity}\nCurrent status: ${v.status}\nUpdate posted: ${v.incidentTime} (UTC)\n\nUpdate:\n${v.message}\n\nLive status: ${v.statusPageUrl}\nUnsubscribe: ${v.unsubscribeLink}\n\n— Driftstack`,
    html: (v) =>
      `<p>Driftstack posted an update on an open service-status incident.</p><table cellpadding="4" style="border-collapse:collapse"><tr><td><strong>Incident:</strong></td><td>${v.title}</td></tr><tr><td><strong>Severity:</strong></td><td>${v.severity}</td></tr><tr><td><strong>Current status:</strong></td><td>${v.status}</td></tr><tr><td><strong>Update posted:</strong></td><td>${v.incidentTime} (UTC)</td></tr></table><p><strong>Update:</strong><br />${v.message}</p><p>Live status: <a href="${v.statusPageUrl}">${v.statusPageUrl}</a><br />Unsubscribe: <a href="${v.unsubscribeLink}">${v.unsubscribeLink}</a></p><p>— Driftstack</p>`,
  },
  // V-486 — DRAFT copy. Quota-warning fires once per account per
  // billing period when concurrent-cap utilisation crosses 80%, OR
  // when trial-pack credit drops below 20% of the original 299¢.
  // Caller dedupes via `quotaWarnEmailSentAt` (concurrent variant)
  // / `trialPackLowCreditEmailSentAt` (credit variant). Templates
  // share one alias because the copy paths converge — they both
  // tell the customer "you're approaching the ceiling, here's the
  // upgrade path."
  'quota-warning': {
    subject: 'Driftstack — approaching your tier limit',
    text: (v) =>
      `You're at ${v.utilizationPct}% of your Driftstack ${v.quotaName} on the ${v.tier} tier.\n\nNothing's blocked yet — this is a heads-up. ${v.contextSentence}\n\nUpgrade path: ${v.upgradeUrl}\nUsage detail: ${v.usageUrl}\n\nThis is the only email you'll get for this period. The dashboard reflects live state.\n\n— Driftstack`,
    html: (v) =>
      `<p>You're at <strong>${v.utilizationPct}%</strong> of your Driftstack <strong>${v.quotaName}</strong> on the <strong>${v.tier}</strong> tier.</p><p>Nothing's blocked yet — this is a heads-up. ${v.contextSentence}</p><p><strong>Upgrade path:</strong> <a href="${v.upgradeUrl}">${v.upgradeUrl}</a><br /><strong>Usage detail:</strong> <a href="${v.usageUrl}">${v.usageUrl}</a></p><p>This is the only email you'll get for this period. The dashboard reflects live state.</p><p>— Driftstack</p>`,
  },
  // V-486 — DRAFT copy. Weekly session-event digest, opt-in. Lists
  // {sessions_run, success_rate, top_failure_reason} for the past
  // 7 days. Sent on Mondays at 09:00 in the account's timezone (or
  // UTC if region preference is unset). Customers who don't want
  // it unsubscribe via the link in the footer; preference stored
  // on `email_preferences.session_event_digest`.
  'session-event-digest': {
    subject: 'Driftstack — your weekly session summary',
    text: (v) =>
      `Last week on Driftstack:\n\n  Sessions run: ${v.sessionsRun}\n  Success rate: ${v.successRatePct}%\n  Top failure reason: ${v.topFailureReason}\n\nFull dashboard: ${v.dashboardUrl}\n\nNo failures in the past week? You'll still get this email — that's by design. To turn the digest off, manage email preferences:\n${v.preferencesUrl}\n\nUnsubscribe (one click): ${v.unsubscribeLink}\n\n— Driftstack`,
    html: (v) =>
      `<p>Last week on Driftstack:</p><table cellpadding="4" style="border-collapse:collapse"><tr><td><strong>Sessions run:</strong></td><td>${v.sessionsRun}</td></tr><tr><td><strong>Success rate:</strong></td><td>${v.successRatePct}%</td></tr><tr><td><strong>Top failure reason:</strong></td><td>${v.topFailureReason}</td></tr></table><p>Full dashboard: <a href="${v.dashboardUrl}">${v.dashboardUrl}</a></p><p>No failures in the past week? You'll still get this email — that's by design. To turn the digest off, <a href="${v.preferencesUrl}">manage email preferences</a>.</p><p>Unsubscribe (one click): <a href="${v.unsubscribeLink}">${v.unsubscribeLink}</a></p><p>— Driftstack</p>`,
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
      sendBillingRenewalReminder: async () => {},
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
      sendTeamInvite: async () => {},
      sendOauthPendingLinkVerification: async () => {},
      sendWebhookSecretRotationReminder: async () => {},
      sendWebhookSecretForceRotated: async () => {},
      sendWebhookSecretGraceExpiring: async () => {},
      sendByokAnthropicKeyRotationReminder: async () => {},
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
      // V-665 — categorise the failure so dashboards / alerts can
      // distinguish "Postmark account still pending approval" (the
      // expected pre-approval state — submitted 2026-05-09, see
      // status.md) from genuine transport / recipient / config
      // failures that need ops attention.
      const { category, postmarkCode } = classifyEmailError(err);
      logger.warn(
        {
          component: 'email',
          template: name,
          to,
          category,
          postmarkCode,
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
    sendBillingRenewalReminder: ({ to, amountFormatted, renewalDate, portalUrl }) =>
      send('billing-renewal-reminder', to, {
        amountFormatted,
        renewalDate: renewalDate.toISOString().slice(0, 10),
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
      send(
        kind === 'created'
          ? 'status-incident-created'
          : kind === 'updated'
            ? 'status-incident-updated'
            : 'status-incident-resolved',
        to,
        {
          title,
          severity,
          status,
          message,
          incidentTime: incidentTime.toISOString(),
          statusPageUrl,
          unsubscribeLink,
        },
      ),
    sendTeamInvite: ({ to, acceptLink, expiresAt, role }) =>
      send('team-invite', to, {
        acceptLink,
        expiresAt: expiresAt.toISOString(),
        role,
      }),
    sendOauthPendingLinkVerification: ({ to, provider, confirmLink, expiresAt }) =>
      send('oauth-pending-verification', to, {
        provider,
        confirmLink,
        expiresAt: expiresAt.toISOString(),
      }),
    sendWebhookSecretRotationReminder: ({
      to,
      endpointUrl,
      secretPrefix,
      ageDays,
      rotateBy,
      dashboardUrl,
    }) =>
      send('webhook-secret-rotation-reminder', to, {
        endpointUrl,
        secretPrefix,
        ageDays: ageDays.toString(),
        rotateBy: rotateBy.toISOString(),
        dashboardUrl,
      }),
    sendWebhookSecretForceRotated: ({
      to,
      endpointUrl,
      newSecretPrefix,
      graceWindowEndsAt,
      dashboardUrl,
    }) =>
      send('webhook-secret-force-rotated', to, {
        endpointUrl,
        newSecretPrefix,
        graceWindowEndsAt: graceWindowEndsAt.toISOString(),
        dashboardUrl,
      }),
    sendWebhookSecretGraceExpiring: ({
      to,
      endpointUrl,
      secretPrefix,
      graceWindowEndsAt,
      dashboardUrl,
    }) =>
      send('webhook-secret-grace-expiring', to, {
        endpointUrl,
        secretPrefix,
        graceWindowEndsAt: graceWindowEndsAt.toISOString(),
        dashboardUrl,
      }),
    sendByokAnthropicKeyRotationReminder: ({ to, ageDays, rotateBy, dashboardUrl }) =>
      send('byok-anthropic-key-rotation-reminder', to, {
        ageDays: ageDays.toString(),
        rotateBy: rotateBy.toISOString(),
        dashboardUrl,
      }),
  };
}
