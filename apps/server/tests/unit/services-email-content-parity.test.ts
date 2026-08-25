// W405.A — drift guard for apps/server/src/services/email.ts.
// V-057 transactional email service via Postmark. Fire-and-forget
// posture; templates owned inline (no Postmark "templates" feature).
// Drift here either breaks V-665 error classification (pending-
// approval state confused with genuine ops failure) or silently
// drops a template (customer-facing copy regression).
//
//   • V-057 framing pinned: fire-and-forget, errors logged warn-level,
//     never thrown — email never on a request critical path.
//   • Templates owned inline as plain TS objects (subject + text +
//     html) — no Postmark "templates" feature dependency.
//   • V-665 classifyEmailError: 7-category union (pending-approval /
//     inactive-recipient / account-inactive / invalid-request /
//     rate-limited / transport / unknown).
//   • V-665 Postmark code map: 412→pending-approval; 405→inactive-
//     recipient; 406→account-inactive; 422→invalid-request;
//     429→rate-limited.
//   • Transport names: ECONNRESET/ECONNREFUSED/ETIMEDOUT/ENOTFOUND/
//     EHOSTUNREACH/EAI_AGAIN/FetchError.
//   • Pending-approval message-pattern fallback (wrapper libs set
//     `code` as string).
//   • Null config → 18-method no-op stub (isConfigured: false).
//   • Default messageStream = 'outbound'.
//   • S44 2026-07-07 (founder-approved trim) — subscription-
//     cancellation + support-ack templates/send methods and the
//     quota-warning + session-event-digest draft templates are
//     DELETED; negative pins below keep them gone. billing-receipt +
//     billing-failure now really fire (Stripe invoice.payment_* via
//     the lifecycle dispatcher); billing-failure retryAt is nullable
//     (Stripe next_payment_attempt is null on the final attempt).
//   • sendStatusIncidentNotification: kind discriminates 'created' →
//     status-incident-created template vs 'resolved' → status-
//     incident-resolved template.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/email.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W405.A apps/server/src/services/email.ts content parity', () => {
  const body = read(LIB);

  it('V-057 Postmark + fire-and-forget framing + inline templates (no Postmark templates feature)', () => {
    expect(body).toMatch(
      /Wraps Postmark \(`postmark` npm package, V-057\)\. All sends are\s*\/\/\s*fire-and-forget: errors are logged at warn-level but never thrown\s*\/\/\s*to the caller, because email is never on a request critical path\./,
    );
    expect(body).toMatch(
      /Templates are owned in this file as plain TS objects \(subject \+\s*\/\/\s*text body \+ HTML body\)\. No Postmark "templates" feature dependency/,
    );
  });

  it('V-665 EmailErrorCategory: 7-literal union (pending-approval / inactive-recipient / account-inactive / invalid-request / rate-limited / transport / unknown)', () => {
    expect(body).toMatch(/V-665 — classifying email-send failure categories\./);
    expect(body).toMatch(
      /export type EmailErrorCategory =\s*\| 'pending-approval'\s*\| 'inactive-recipient'\s*\| 'account-inactive'\s*\| 'invalid-request'\s*\| 'rate-limited'\s*\| 'transport'\s*\| 'unknown';/,
    );
  });

  it('V-665 Postmark code map: 412→pending-approval / 405→inactive-recipient / 406→account-inactive / 422→invalid-request / 429→rate-limited', () => {
    expect(body).toMatch(
      /if \(code === 412\) return \{ category: 'pending-approval', postmarkCode: 412 \};/,
    );
    expect(body).toMatch(
      /if \(code === 405\) return \{ category: 'inactive-recipient', postmarkCode: 405 \};/,
    );
    expect(body).toMatch(
      /if \(code === 406\) return \{ category: 'account-inactive', postmarkCode: 406 \};/,
    );
    expect(body).toMatch(
      /if \(code === 422\) return \{ category: 'invalid-request', postmarkCode: 422 \};/,
    );
    expect(body).toMatch(
      /if \(code === 429\) return \{ category: 'rate-limited', postmarkCode: 429 \};/,
    );
  });

  it('V-665 transport-error names: 7-entry Set (ECONNRESET/ECONNREFUSED/ETIMEDOUT/ENOTFOUND/EHOSTUNREACH/EAI_AGAIN/FetchError)', () => {
    expect(body).toMatch(
      /const transportNames = new Set\(\[\s*'ECONNRESET',\s*'ECONNREFUSED',\s*'ETIMEDOUT',\s*'ENOTFOUND',\s*'EHOSTUNREACH',\s*'EAI_AGAIN',\s*'FetchError',\s*\]\);/,
    );
    expect(body).toMatch(
      /if \(transportNames\.has\(name\)\) return \{ category: 'transport', postmarkCode: null \};/,
    );
  });

  it('V-665 pending-approval message-pattern fallback for wrapper libs with string code', () => {
    expect(body).toMatch(
      /\/\/ Pattern-match the message as a last resort: Postmark's `Message`\s*\/\/ field for pending-approval errors contains a recognizable phrase,\s*\/\/ and some wrapper libraries set `code` as a string instead of a\s*\/\/ number\./,
    );
    expect(body).toMatch(
      /if \(message\.includes\('pending approval'\) \|\| message\.includes\('not yet approved'\)\) \{\s*return \{ category: 'pending-approval', postmarkCode: code \};/,
    );
  });

  it('EmailService: 18 sendX methods + isConfigured readonly boolean (S44 trim removed sendSubscriptionCancellation + sendSupportAck; billing-receipt/failure carry S44 trigger docs + nullable retryAt)', () => {
    expect(body).toMatch(/export interface EmailService \{/);
    expect(body).toMatch(
      /sendSignupVerification\(args: \{ to: string; link: string; expiresAt: Date \}\): Promise<void>;/,
    );
    expect(body).toMatch(
      /sendPasswordReset\(args: \{ to: string; link: string; expiresAt: Date \}\): Promise<void>;/,
    );
    expect(body).toMatch(
      /S44 2026-07-07 \(founder-approved\) — Driftstack-branded payment[\s\S]+?sendBillingReceipt\(args: \{/,
    );
    expect(body).toMatch(
      /S44 2026-07-07 \(founder-approved\) — payment-failure notice\.[\s\S]+?sendBillingFailure\(args: \{\s*to: string;\s*amountFormatted: string;\s*retryAt: Date \| null;\s*portalUrl: string;\s*\}\): Promise<void>;/,
    );
    expect(body).toMatch(
      /V-304b — fires ~7 days before subscription renewal[\s\S]+?sendBillingRenewalReminder\(args: \{/,
    );
    // S44 2026-07-07 (founder-approved trim) — zero-caller methods deleted.
    expect(body).not.toMatch(/sendSubscriptionCancellation\(/);
    expect(body).not.toMatch(/sendSupportAck\(/);
    expect(body).toMatch(
      /V-202 — onboarding follow-up after email verification succeeds[\s\S]+?sendSignupWelcome\(args: \{ to: string; dashboardUrl: string \}\): Promise<void>;/,
    );
    expect(body).toMatch(
      /V-202 — first-failure notice \(V-090\)\. Caller is responsible for deduplication[\s\S]+?sendSessionFailedFirst\(args: \{/,
    );
    expect(body).toMatch(
      /V-304a — first successful session notice\. Once-per-account; caller dedupes[\s\S]+?sendSessionSuccessFirst\(args: \{/,
    );
    expect(body).toMatch(/sendTierChanged\(args: \{/);
    // sendTrialPackPurchased + sendTrialPackExpired removed with the dead trial_pack lifecycle.
    expect(body).not.toMatch(/sendTrialPackPurchased\(/);
    expect(body).not.toMatch(/sendTrialPackExpired\(/);
    expect(body).toMatch(
      /V-295c3 — public-status-page subscriber double-opt-in confirmation[\s\S]+?sendStatusSubscriptionConfirmation\(args: \{/,
    );
    expect(body).toMatch(/sendStatusSubscriptionWelcome\(args: \{/);
    expect(body).toMatch(/V-298b — team invite email[\s\S]+?sendTeamInvite\(args: \{/);
    expect(body).toMatch(
      /V-295c3-followup \+ V-545\.B — fires when a public incident is posted,[\s\S]+?sendStatusIncidentNotification\(args: \{/,
    );
    expect(body).toMatch(/readonly isConfigured: boolean;/);
  });

  it('Templates: inline TEMPLATES object satisfies Record<string, Template> with signup-verification + password-reset + billing-receipt/failure/renewal-reminder + signup-welcome + session-failed-first/success-first + tier-changed + status-subscription-confirmation/welcome + team-invite + status-incident-created/resolved (trial-pack pair removed with the dead trial_pack lifecycle; S44 2026-07-07 founder-approved trim removed subscription-cancellation + support-ack + the quota-warning/session-event-digest drafts)', () => {
    expect(body).toMatch(/const TEMPLATES = \{/);
    expect(body).toMatch(/'signup-verification': \{/);
    expect(body).toMatch(/'password-reset': \{/);
    expect(body).toMatch(/'billing-receipt': \{/);
    expect(body).toMatch(/'billing-failure': \{/);
    expect(body).toMatch(/'billing-renewal-reminder': \{/);
    expect(body).toMatch(/'signup-welcome': \{/);
    expect(body).toMatch(/'session-failed-first': \{/);
    expect(body).toMatch(/'session-success-first': \{/);
    expect(body).toMatch(/'tier-changed': \{/);
    expect(body).not.toMatch(/'trial-pack-purchased': \{/);
    expect(body).not.toMatch(/'trial-pack-expired': \{/);
    // S44 2026-07-07 — founder-approved trim; these four stay deleted.
    expect(body).not.toMatch(/'subscription-cancellation': \{/);
    expect(body).not.toMatch(/'support-ack': \{/);
    expect(body).not.toMatch(/'quota-warning': \{/);
    expect(body).not.toMatch(/'session-event-digest': \{/);
    expect(body).toMatch(/'status-subscription-confirmation': \{/);
    expect(body).toMatch(/'status-subscription-welcome': \{/);
    expect(body).toMatch(/'team-invite': \{/);
    expect(body).toMatch(/'status-incident-created': \{/);
    expect(body).toMatch(/'status-incident-resolved': \{/);
    expect(body).toMatch(/\} satisfies Record<string, Template>;/);
  });

  it('S44 billing-failure template renders the pre-computed retryLine (nullable Stripe next_payment_attempt: timestamped retry sentence OR final-attempt sentence)', () => {
    expect(body).toMatch(/\$\{v\.retryLine\} To update payment details, visit the billing portal/);
    expect(body).toMatch(
      /retryAt !== null\s*\? `We'll retry automatically at \$\{retryAt\.toISOString\(\)\} \(UTC\)\.`\s*: `This was the final automatic attempt — no further retries are scheduled\.`,/,
    );
  });

  it('Null config → 18-method no-op stub with isConfigured:false; warn log mentions POSTMARK_API_TOKEN/FROM/REPLY_TO', () => {
    expect(body).toMatch(
      /'Postmark not configured — email sends will be no-ops\. Set POSTMARK_API_TOKEN\/FROM\/REPLY_TO to enable\.',/,
    );
    expect(body).toMatch(/isConfigured: false,/);
    expect(body).toMatch(/sendSignupVerification: async \(\) => \{\},/);
    expect(body).toMatch(/sendPasswordReset: async \(\) => \{\},/);
    expect(body).toMatch(/sendBillingReceipt: async \(\) => \{\},/);
  });

  it("Default messageStream = 'outbound'; PostmarkSendApi.sendEmail with From+To+Subject+TextBody+HtmlBody+ReplyTo+MessageStream", () => {
    expect(body).toMatch(/messageStream = 'outbound',/);
    expect(body).toMatch(/MessageStream: messageStream,/);
    expect(body).toMatch(
      /export interface PostmarkSendApi \{\s*sendEmail\(input: \{\s*From: string;\s*To: string;\s*Subject: string;\s*TextBody: string;\s*HtmlBody: string;\s*ReplyTo: string;\s*MessageStream: string;\s*\}\): Promise<unknown>;/,
    );
  });

  it("send(): try logs 'email sent' info; catch classifyEmailError + warn 'email send failed (fire-and-forget)' + bump emailSendTotal metric with category outcome + swallow", () => {
    expect(body).toMatch(
      /logger\.info\(\{ component: 'email', template: name, to: maskEmail\(to\) \}, 'email sent'\);/,
    );
    expect(body).toMatch(/const \{ category, postmarkCode \} = classifyEmailError\(err\);/);
    expect(body).toMatch(/'email send failed \(fire-and-forget\)',/);
    expect(body).toMatch(
      /metrics\?\.inc\(METRIC_NAMES\.emailSendTotal, \{ template: name, outcome: category \}\);/,
    );
    expect(body).toMatch(/\/\/ Deliberately swallow — email is never on a request critical path\./);
  });

  it("sendStatusIncidentNotification: kind 'created' → 'status-incident-created' template; 'updated' → 'status-incident-updated' (V-545.B); 'resolved' → 'status-incident-resolved' template", () => {
    expect(body).toMatch(
      /send\(\s*kind === 'created'\s*\? 'status-incident-created'\s*: kind === 'updated'\s*\? 'status-incident-updated'\s*: 'status-incident-resolved',/,
    );
  });

  it('imports: PostmarkClient (ServerClient alias) + Logger + PostmarkConfig', () => {
    expect(body).toMatch(/import \{ ServerClient as PostmarkClient \} from 'postmark';/);
    expect(body).toMatch(/import type \{ Logger \} from '\.\.\/lib\/logger\.js';/);
    expect(body).toMatch(/import type \{ PostmarkConfig \} from '\.\.\/lib\/config\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
