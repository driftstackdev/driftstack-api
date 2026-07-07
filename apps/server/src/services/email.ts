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
//   - billing-receipt             (S44 2026-07-07; Stripe
//     invoice.payment_succeeded via the lifecycle dispatcher)
//   - billing-failure             (S44 2026-07-07; Stripe
//     invoice.payment_failed — never opt-outable)
//   - session-failed-first        (V-202; first-failure-only, V-090)
//   - tier-changed                (V-202)
//   - oauth-pending-verification  (V-667.C; verdict-1 merge confirm)
//
// S44 2026-07-07 (founder-approved trim) — the subscription-
// cancellation + support-ack templates and send methods (zero
// callers since V-057 landed) and the quota-warning +
// session-event-digest draft templates (never had send methods) were
// DELETED. Resurrecting any of them requires a real caller plus a
// docs catalog entry (apps/docs/src/pages/reference/emails.md).
//
// 2026-07-01 security fix — the fire-and-forget posture above is a
// deliberate, correct tradeoff for MOST templates, but three of them
// (signup-verification — also backs the magic-link + resend-
// verification flows; password-reset; oauth-pending-verification)
// gate a customer OUT of their account entirely if the send silently
// fails: a Postmark permanent-suppression state (one prior hard
// bounce/spam complaint) or a transient outage otherwise leaves the
// customer stuck with no signal anything is wrong. For those three
// templates ONLY, `send()` now additionally: (a) bounds-retries
// transient failure categories (`rate-limited` / `transport`) with a
// short exponential backoff before giving up; (b) persists a per-
// account `accounts.email_delivery_failed_at` marker when Postmark
// reports its permanent `inactive-recipient` suppression state,
// cleared automatically the next time any of the 3 templates sends
// successfully to that account; (c) emits an error-level log + a
// dedicated Sentry capture (in ADDITION to the existing warn-level
// log + metric below, which fire for every template exactly as
// before) so ops can see "customer X's password-reset email failed"
// instead of it being buried in the aggregate warn-level counter.
// Every other template's behaviour is completely unchanged — still
// exactly one attempt, still warn-level only, still no per-account
// state.

import { eq } from 'drizzle-orm';
import { ServerClient as PostmarkClient } from 'postmark';
import type { Logger } from '../lib/logger.js';
import type { PostmarkConfig } from '../lib/config.js';
import type { SentryClient } from '../lib/sentry.js';
import type { Database } from '../db/client.js';
import { accounts } from '../db/schema.js';
import { METRIC_NAMES, type MetricsRegistry } from './metrics-registry.js';
import { maskEmail } from '../lib/redact-url.js';

export interface EmailService {
  /**
   * Send a signup verification email containing a magic-link.
   * `link` should already include the 256-bit single-use token.
   * `expiresAt` is rendered into the template for the user.
   */
  sendSignupVerification(args: { to: string; link: string; expiresAt: Date }): Promise<void>;
  sendPasswordReset(args: { to: string; link: string; expiresAt: Date }): Promise<void>;
  /** S44 2026-07-07 (founder-approved) — Driftstack-branded payment
   *  receipt (TD-001 revival). Fires on Stripe
   *  `invoice.payment_succeeded` via the lifecycle dispatcher
   *  (`billing.payment_succeeded`); honors the V-204
   *  `billing-receipt` opt-out. Dedup rides the Stripe event ledger
   *  (`processed_stripe_events` — duplicate event.id short-circuits
   *  before dispatch). */
  sendBillingReceipt(args: {
    to: string;
    amountFormatted: string;
    period: string;
    invoiceUrl: string;
  }): Promise<void>;
  /** S44 2026-07-07 (founder-approved) — payment-failure notice.
   *  Fires on Stripe `invoice.payment_failed`; NEVER opt-outable
   *  (deliberately absent from OptOutableEmailEventSchema). `retryAt`
   *  is Stripe's `next_payment_attempt` — null when Stripe has no
   *  further automatic retry scheduled (final dunning attempt). */
  sendBillingFailure(args: {
    to: string;
    amountFormatted: string;
    retryAt: Date | null;
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

// Display-cased OAuth provider name for customer-facing strings. Internal
// representation is lowercase ('google'/'github') to match the IDP schema;
// emails address the customer in title case (Google/GitHub).
// Accepts unknown (the TEMPLATES record's value type widens to unknown)
// and narrows at runtime — defaults to the raw string if not one of the
// known providers (forward-compat for adding new IDPs without a code
// change on the email-template side).
function oauthProviderDisplay(provider: unknown): string {
  if (provider === 'google') return 'Google';
  if (provider === 'github') return 'GitHub';
  // Forward-compat fallback for IDPs added without a code change here.
  // Guarded against non-string inputs so an upstream type drift doesn't
  // crash the email template render.
  return typeof provider === 'string' ? provider : '';
}

// HTML-escape interpolated values before they reach an email HTML body.
// Templates interpolate plain-text data (URLs, dates, ids, session error
// messages, customer-registered webhook URLs) into HTML; escaping at the
// single render chokepoint in send() neutralises HTML injection without
// touching any template string. URLs escape correctly too (`&` → `&amp;`
// is proper href-attribute encoding). Text bodies are NOT escaped.
const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}
function escapeVarsForHtml(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(vars)) {
    out[key] = escapeHtml(vars[key]!);
  }
  return out;
}

// Each TEMPLATES entry produces a bare HTML fragment (`<p>…</p>`). Wrap that
// fragment in a minimal, email-safe HTML document before it reaches the
// transport. The two `<meta>` tags are the load-bearing part:
//   • charset=utf-8 — the copy uses non-ASCII characters (em-dashes "—" in
//     nearly every body, smart quotes in some subjects). Without an explicit
//     charset some mail clients fall back to latin-1 and render them as
//     mojibake ("â€"").
//   • viewport — keeps the body from being zoomed out to desktop width on
//     mobile clients that honour it.
// Inline body styling gives a readable sans-serif default instead of each
// client's serif fallback. Kept deliberately minimal — no external CSS, no
// images, no tables — so it stays robust across Gmail/Outlook/Apple Mail and
// doesn't trip spam heuristics. `title` is the email's subject (escaped) so
// screen readers and clients that surface <title> announce something specific
// rather than a generic "Driftstack".
function wrapHtmlDocument(inner: string, title: string): string {
  return (
    '<!DOCTYPE html><html lang="en"><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(title)}</title>` +
    '</head>' +
    '<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a;">' +
    inner +
    '</body></html>'
  );
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
  // S44 2026-07-07 — `retryLine` is a full pre-rendered sentence
  // (computed in sendBillingFailure below) because Stripe's
  // next_payment_attempt is nullable: with a retry scheduled the line
  // carries the timestamp; on the final dunning attempt it says no
  // further retry is coming. One template, both truths.
  'billing-failure': {
    subject: 'Driftstack — payment failed',
    text: (v) =>
      `We were unable to charge ${v.amountFormatted} on your Driftstack account.\n\n${v.retryLine} To update payment details, visit the billing portal:\n\n${v.portalUrl}\n\n— Driftstack`,
    html: (v) =>
      `<p>We were unable to charge <strong>${v.amountFormatted}</strong> on your Driftstack account.</p><p>${v.retryLine} To update payment details, visit the <a href="${v.portalUrl}">billing portal</a>.</p><p>— Driftstack</p>`,
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
  'signup-welcome': {
    subject: 'Welcome to Driftstack',
    text: (v) =>
      `Your Driftstack account is ready.\n\nNext steps:\n  1. Start free or pick a paid tier at ${v.dashboardUrl}\n  2. Mint your first API key from the dashboard\n  3. Run your first session via the SDK\n\nAny questions: reply to this email.\n\n— Driftstack`,
    html: (v) =>
      `<p>Your Driftstack account is ready.</p><p>Next steps:</p><ol><li>Start free or pick a paid tier at <a href="${v.dashboardUrl}">${v.dashboardUrl}</a></li><li>Mint your first API key from the dashboard</li><li>Run your first session via the SDK</li></ol><p>Any questions: reply to this email.</p><p>— Driftstack</p>`,
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
      `Someone — probably you — just tried to sign in to your Driftstack account using ${oauthProviderDisplay(v.provider)}.\n\nIf that was you, confirm the new sign-in method by clicking the link below. It expires at ${v.expiresAt} (UTC) and works once.\n\n${v.confirmLink}\n\nIf that wasn't you, ignore this email — no change is made until the link is clicked. Your password (if any) still works.\n\n— Driftstack`,
    html: (v) =>
      `<p>Someone — probably you — just tried to sign in to your Driftstack account using <strong>${oauthProviderDisplay(v.provider)}</strong>.</p><p>If that was you, confirm the new sign-in method by clicking the link below. It expires at <strong>${v.expiresAt}</strong> (UTC) and works once.</p><p><a href="${v.confirmLink}">${v.confirmLink}</a></p><p>If that wasn't you, ignore this email — no change is made until the link is clicked. Your password (if any) still works.</p><p>— Driftstack</p>`,
  },
  // v2-#11.5 — BYOK Anthropic key rotation nag. Subject explicit
  // about provider name (Anthropic) so the customer immediately
  // knows which credential they need to rotate. No partial-key
  // echo in the body — Anthropic keys are sensitive enough that
  // we never leak any portion of them in mail.
  'byok-anthropic-key-rotation-reminder': {
    subject: 'Driftstack — rotate your Anthropic API key',
    text: (v) =>
      `Your stored Anthropic API key on Driftstack is ${v.ageDays} days old. We recommend rotating every 90 days; we've reached the nag threshold.\n\nRotate by: ${v.rotateBy} (UTC)\n\nGenerate a fresh key in your Anthropic console (https://console.anthropic.com/), then rotate it via the Driftstack API — the PUT flow is documented at:\nhttps://docs.driftstack.dev/api/byok-anthropic\n\nCheck your key's age and status anytime on the dashboard: ${v.dashboardUrl}/settings\n\n— Driftstack`,
    html: (v) =>
      `<p>Your stored Anthropic API key on Driftstack is <strong>${v.ageDays} days old</strong>. We recommend rotating every 90 days; we've reached the nag threshold.</p><table cellpadding="4" style="border-collapse:collapse"><tr><td><strong>Rotate by:</strong></td><td>${v.rotateBy} (UTC)</td></tr></table><p>Generate a fresh key in your <a href="https://console.anthropic.com/">Anthropic console</a>, then rotate it via the Driftstack API — the <a href="https://docs.driftstack.dev/api/byok-anthropic">PUT flow is documented here</a>.</p><p>Check your key's age and status anytime on the <a href="${v.dashboardUrl}/settings">dashboard</a>.</p><p>— Driftstack</p>`,
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
} satisfies Record<string, Template>;

type TemplateName = keyof typeof TEMPLATES;

// ───────────────────────────────────────────────────────────────────────────
// 2026-07-01 security fix — security-critical template retry + tracking
// ───────────────────────────────────────────────────────────────────────────

/**
 * The 3 templates that block account access if undeliverable. Scoped
 * deliberately narrow — retry/tracking here multiplies Postmark API
 * calls, so it's reserved for templates where a silent failure is
 * actually security-critical. `signup-verification` also backs the
 * magic-link-request and resend-verification flows (both call
 * `sendSignupVerification` under the hood; see auth-flows.ts), so
 * this one entry covers all three of those call sites.
 */
const SECURITY_CRITICAL_TEMPLATES = new Set<TemplateName>([
  'signup-verification',
  'password-reset',
  'oauth-pending-verification',
]);

/**
 * `EmailErrorCategory` values worth an immediate bounded retry:
 * genuinely transient conditions where a few hundred ms might see the
 * transport recover or the rate-limit window roll over. The other 5
 * categories are effectively permanent for the lifetime of one logical
 * send, so retrying immediately would burn Postmark calls for nothing:
 *   - `pending-approval` / `account-inactive` — account-wide Postmark
 *     states that persist for hours-to-days; a 1s retry window can't
 *     resolve them.
 *   - `invalid-request` — a deterministic malformed-body rejection;
 *     retrying the identical payload fails identically.
 *   - `inactive-recipient` — Postmark's PERMANENT suppression-list
 *     state (prior hard bounce / spam complaint). Retrying is pointless
 *     by definition; this is the category that instead sets the
 *     per-account `email_delivery_failed_at` marker (see below).
 *   - `unknown` — unclassified; treated conservatively as non-
 *     retryable absent evidence it's transient.
 */
const TRANSIENT_RETRY_CATEGORIES = new Set<EmailErrorCategory>(['rate-limited', 'transport']);

/** Backoff delay (ms) BEFORE attempt 2 and attempt 3 respectively — 3
 *  attempts total (1 initial + 2 retries), security-critical templates
 *  + transient categories only. */
const RETRY_BACKOFF_MS: readonly number[] = [200, 800];

function defaultRetryDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Per-account email-delivery-failure tracking (security-critical
 * templates only). Backs `accounts.email_delivery_failed_at`: set when
 * Postmark reports permanent `inactive-recipient` suppression for a
 * KNOWN, active account; cleared the next time any of the 3 security-
 * critical templates sends successfully to that account.
 *
 * `send()` only ever has the raw `to` (recipient email) address — the
 * public `sendSignupVerification` / `sendPasswordReset` method
 * signatures are pinned character-for-character by the W914 /
 * W405.A content-parity guards (`{ to: string; link: string;
 * expiresAt: Date }`) and can't grow an `accountId` parameter without
 * breaking them — so `findAccountIdByEmail` re-resolves the account
 * from the address instead of a call site threading an id through.
 * Every current call site for these 3 templates only ever sends to a
 * KNOWN, active account (the anti-enumeration "unknown email" / "not
 * active" cases in AuthFlowsService return before ever calling
 * `EmailService`), so this lookup is expected to always resolve.
 */
export interface AccountEmailDeliveryTracker {
  /** Resolve a recipient email to its account id (case-insensitive
   *  match on the canonical lowercased address), or null if no
   *  account matches. */
  findAccountIdByEmail(email: string): Promise<string | null>;
  /** Persist that this account's email delivery is currently broken. */
  markDeliveryFailed(accountId: string, at: Date): Promise<void>;
  /** Clear the marker — called after ANY successful send of a
   *  security-critical template to this account. */
  clearDeliveryFailed(accountId: string): Promise<void>;
}

/**
 * Ready-to-use Drizzle-backed `AccountEmailDeliveryTracker`, reading
 * and writing `accounts.email_delivery_failed_at` (migration 0095).
 * Not wired by default — pass via `createEmailService`'s
 * `accountEmailDeliveryTracker` option, e.g.
 * `createDrizzleAccountEmailDeliveryTracker(dbHandle)` at bootstrap
 * time, alongside the existing Postmark config.
 */
export function createDrizzleAccountEmailDeliveryTracker(
  database: Database,
): AccountEmailDeliveryTracker {
  return {
    async findAccountIdByEmail(email) {
      const [row] = await database.db
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.email, email.trim().toLowerCase()))
        .limit(1);
      return row ? row.id : null;
    },
    async markDeliveryFailed(accountId, at) {
      await database.db
        .update(accounts)
        .set({ emailDeliveryFailedAt: at })
        .where(eq(accounts.id, accountId));
    },
    async clearDeliveryFailed(accountId) {
      await database.db
        .update(accounts)
        .set({ emailDeliveryFailedAt: null })
        .where(eq(accounts.id, accountId));
    },
  };
}

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
  /** Arc 7 obs.13 — optional metrics registry. When wired, each
   *  send() call emits `driftstack_email_send_total{template,outcome}`
   *  where outcome is one of: ok / postmark_pending_approval /
   *  recipient_inactive / transport_error / config_error. */
  metrics?: MetricsRegistry;
  /**
   * 2026-07-01 security fix — optional per-account email-delivery-
   * failure tracker (security-critical templates only; see
   * `AccountEmailDeliveryTracker`). Omitted in tests / local dev; a
   * ready Drizzle-backed implementation is exported as
   * `createDrizzleAccountEmailDeliveryTracker`.
   */
  accountEmailDeliveryTracker?: AccountEmailDeliveryTracker;
  /**
   * 2026-07-01 security fix — optional Sentry client, used ONLY for
   * elevated alerting on the 3 security-critical templates (point 3
   * of the fix). Every other template's failure stays warn-level +
   * metrics-only, exactly as before this change.
   */
  sentry?: SentryClient;
  /** Test seam — injectable retry-backoff delay. Defaults to a real
   *  setTimeout-based sleep. */
  retryDelayFn?: (ms: number) => Promise<void>;
}

export function createEmailService({
  config,
  logger,
  client,
  messageStream = 'outbound',
  metrics,
  accountEmailDeliveryTracker,
  sentry,
  retryDelayFn = defaultRetryDelay,
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
      sendSignupWelcome: async () => {},
      sendSessionFailedFirst: async () => {},
      sendSessionSuccessFirst: async () => {},
      sendTierChanged: async () => {},
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

  // 2026-07-01 security fix — best-effort account-lookup + tracker
  // read/write helpers for the 3 security-critical templates. Every
  // failure here is independently caught + logged at warn (never
  // thrown) so a tracker outage never turns email delivery into a hard
  // failure — same best-effort posture as the metrics blocks below.
  async function resolveAccountId(to: string): Promise<string | null> {
    if (!accountEmailDeliveryTracker) return null;
    try {
      return await accountEmailDeliveryTracker.findAccountIdByEmail(to);
    } catch (lookupErr) {
      logger.warn(
        { component: 'email', to: maskEmail(to), err: lookupErr },
        'email-delivery-failure account lookup failed (best-effort, swallowed)',
      );
      return null;
    }
  }

  async function clearAccountDeliveryFailure(to: string): Promise<void> {
    if (!accountEmailDeliveryTracker) return;
    const accountId = await resolveAccountId(to);
    if (accountId === null) return;
    try {
      await accountEmailDeliveryTracker.clearDeliveryFailed(accountId);
    } catch (trackerErr) {
      logger.warn(
        { component: 'email', accountId, err: trackerErr },
        'email-delivery-failed marker clear failed (best-effort, swallowed)',
      );
    }
  }

  // Point 3 — elevated, error-level alerting + a dedicated Sentry
  // capture for the 3 security-critical templates, IN ADDITION to the
  // warn-level log + metric that fire for every template below
  // (unchanged). Point 2 — persist the per-account marker ONLY for
  // Postmark's PERMANENT `inactive-recipient` suppression state; every
  // other category is either transient (already retried before this
  // runs) or an account-wide/config-level Postmark state that isn't
  // specific to this recipient, so persisting a per-ACCOUNT flag for
  // those would mislabel "Postmark itself is misconfigured/down" as
  // "this customer's mailbox is broken".
  async function reportSecurityCriticalFailure(args: {
    name: TemplateName;
    to: string;
    category: EmailErrorCategory;
    postmarkCode: number | null;
    err: unknown;
  }): Promise<void> {
    const { name, to, category, postmarkCode, err } = args;
    const accountId = await resolveAccountId(to);

    logger.error(
      {
        component: 'email',
        template: name,
        to: maskEmail(to),
        accountId,
        category,
        postmarkCode,
      },
      'security-critical email send failed after exhausting retries',
    );
    try {
      sentry?.captureException(err, {
        component: 'email',
        template: name,
        to: maskEmail(to),
        accountId,
        category,
        postmarkCode,
      });
    } catch (sentryErr) {
      logger.warn(
        { component: 'email', err: sentryErr },
        'Sentry captureException failed (fire-and-forget)',
      );
    }

    if (category === 'inactive-recipient' && accountId !== null && accountEmailDeliveryTracker) {
      try {
        await accountEmailDeliveryTracker.markDeliveryFailed(accountId, new Date());
      } catch (trackerErr) {
        logger.warn(
          { component: 'email', accountId, err: trackerErr },
          'email-delivery-failed marker persist failed (best-effort, swallowed)',
        );
      }
    }
  }

  async function send(name: TemplateName, to: string, vars: Record<string, string>): Promise<void> {
    const tpl = TEMPLATES[name];
    const securityCritical = SECURITY_CRITICAL_TEMPLATES.has(name);
    let err: unknown = null;

    // 2026-07-01 security fix — bounded retry for transient failure
    // categories, security-critical templates only. Every other
    // template — and every non-transient category even on a security-
    // critical template — sends exactly once, same as before this
    // change. `maxAttempts` is 1 (non-retry path) worth of headroom
    // plus RETRY_BACKOFF_MS.length retries = 3 attempts total.
    const maxAttempts = RETRY_BACKOFF_MS.length + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await postmark.sendEmail({
          From: config!.from,
          To: to,
          Subject: tpl.subject,
          TextBody: tpl.text(vars),
          HtmlBody: wrapHtmlDocument(tpl.html(escapeVarsForHtml(vars)), tpl.subject),
          ReplyTo: config!.replyTo,
          MessageStream: messageStream,
        });
        logger.info({ component: 'email', template: name, to: maskEmail(to) }, 'email sent');
        try {
          metrics?.inc(METRIC_NAMES.emailSendTotal, { template: name, outcome: 'ok' });
        } catch {
          // Swallow; metrics are best-effort.
        }
        if (securityCritical) {
          await clearAccountDeliveryFailure(to);
        }
        return;
      } catch (attemptErr) {
        err = attemptErr;
        const attemptCategory = classifyEmailError(attemptErr).category;
        const isLastAttempt = attempt === maxAttempts - 1;
        const canRetry =
          securityCritical && TRANSIENT_RETRY_CATEGORIES.has(attemptCategory) && !isLastAttempt;
        if (!canRetry) break;
        await retryDelayFn(RETRY_BACKOFF_MS[attempt]!);
      }
    }

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
        to: maskEmail(to),
        category,
        postmarkCode,
        err:
          err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack, cause: err.cause }
            : { value: err },
      },
      'email send failed (fire-and-forget)',
    );
    try {
      metrics?.inc(METRIC_NAMES.emailSendTotal, { template: name, outcome: category });
    } catch {
      // Swallow; metrics are best-effort.
    }
    // Deliberately swallow — email is never on a request critical path.

    if (securityCritical) {
      await reportSecurityCriticalFailure({ name, to, category, postmarkCode, err });
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
        // S44 — pre-rendered retry sentence; see the template comment.
        retryLine:
          retryAt !== null
            ? `We'll retry automatically at ${retryAt.toISOString()} (UTC).`
            : `This was the final automatic attempt — no further retries are scheduled.`,
        portalUrl,
      }),
    sendBillingRenewalReminder: ({ to, amountFormatted, renewalDate, portalUrl }) =>
      send('billing-renewal-reminder', to, {
        amountFormatted,
        renewalDate: renewalDate.toISOString().slice(0, 10),
        portalUrl,
      }),
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
