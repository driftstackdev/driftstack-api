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
//   • Null config → 17-method no-op stub (isConfigured: false).
//   • Default messageStream = 'outbound'.
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
      /Wraps Postmark \(`postmark` npm package, V-057\)\. All sends are\s*\n?\s*\/\/\s*fire-and-forget: errors are logged at warn-level but never thrown\s*\n?\s*\/\/\s*to the caller, because email is never on a request critical path\./,
    );
    expect(body).toMatch(
      /Templates are owned in this file as plain TS objects \(subject \+\s*\n?\s*\/\/\s*text body \+ HTML body\)\. No Postmark "templates" feature dependency/,
    );
  });

  it('V-665 EmailErrorCategory: 7-literal union (pending-approval / inactive-recipient / account-inactive / invalid-request / rate-limited / transport / unknown)', () => {
    expect(body).toMatch(/V-665 — classifying email-send failure categories\./);
    expect(body).toMatch(
      /export type EmailErrorCategory =\s*\n?\s*\| 'pending-approval'\s*\n?\s*\| 'inactive-recipient'\s*\n?\s*\| 'account-inactive'\s*\n?\s*\| 'invalid-request'\s*\n?\s*\| 'rate-limited'\s*\n?\s*\| 'transport'\s*\n?\s*\| 'unknown';/,
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
      /const transportNames = new Set\(\[\s*\n?\s*'ECONNRESET',\s*\n?\s*'ECONNREFUSED',\s*\n?\s*'ETIMEDOUT',\s*\n?\s*'ENOTFOUND',\s*\n?\s*'EHOSTUNREACH',\s*\n?\s*'EAI_AGAIN',\s*\n?\s*'FetchError',\s*\n?\s*\]\);/,
    );
    expect(body).toMatch(
      /if \(transportNames\.has\(name\)\) return \{ category: 'transport', postmarkCode: null \};/,
    );
  });

  it('V-665 pending-approval message-pattern fallback for wrapper libs with string code', () => {
    expect(body).toMatch(
      /\/\/ Pattern-match the message as a last resort: Postmark's `Message`\s*\n?\s*\/\/ field for pending-approval errors contains a recognizable phrase,\s*\n?\s*\/\/ and some wrapper libraries set `code` as a string instead of a\s*\n?\s*\/\/ number\./,
    );
    expect(body).toMatch(
      /if \(message\.includes\('pending approval'\) \|\| message\.includes\('not yet approved'\)\) \{\s*\n?\s*return \{ category: 'pending-approval', postmarkCode: code \};/,
    );
  });

  it('EmailService: 16 sendX methods + isConfigured readonly boolean', () => {
    expect(body).toMatch(/export interface EmailService \{/);
    expect(body).toMatch(
      /sendSignupVerification\(args: \{ to: string; link: string; expiresAt: Date \}\): Promise<void>;/,
    );
    expect(body).toMatch(
      /sendPasswordReset\(args: \{ to: string; link: string; expiresAt: Date \}\): Promise<void>;/,
    );
    expect(body).toMatch(/sendBillingReceipt\(args: \{/);
    expect(body).toMatch(/sendBillingFailure\(args: \{/);
    expect(body).toMatch(
      /V-304b — fires ~7 days before subscription renewal[\s\S]+?sendBillingRenewalReminder\(args: \{/,
    );
    expect(body).toMatch(/sendSubscriptionCancellation\(args: \{/);
    expect(body).toMatch(
      /sendSupportAck\(args: \{ to: string; ticketId: string \}\): Promise<void>;/,
    );
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
    expect(body).toMatch(/sendTrialPackPurchased\(args: \{/);
    expect(body).toMatch(
      /sendTrialPackExpired\(args: \{ to: string; upgradeUrl: string \}\): Promise<void>;/,
    );
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

  it('Templates: 17-entry inline TEMPLATES object satisfies Record<string, Template> with signup-verification + password-reset + billing-receipt/failure/renewal-reminder + subscription-cancellation + support-ack + signup-welcome + session-failed-first/success-first + tier-changed + trial-pack-purchased/expired + status-subscription-confirmation/welcome + team-invite + status-incident-created/resolved + quota-warning + session-event-digest', () => {
    expect(body).toMatch(/const TEMPLATES = \{/);
    expect(body).toMatch(/'signup-verification': \{/);
    expect(body).toMatch(/'password-reset': \{/);
    expect(body).toMatch(/'billing-receipt': \{/);
    expect(body).toMatch(/'billing-failure': \{/);
    expect(body).toMatch(/'billing-renewal-reminder': \{/);
    expect(body).toMatch(/'subscription-cancellation': \{/);
    expect(body).toMatch(/'support-ack': \{/);
    expect(body).toMatch(/'signup-welcome': \{/);
    expect(body).toMatch(/'session-failed-first': \{/);
    expect(body).toMatch(/'session-success-first': \{/);
    expect(body).toMatch(/'tier-changed': \{/);
    expect(body).toMatch(/'trial-pack-purchased': \{/);
    expect(body).toMatch(/'trial-pack-expired': \{/);
    expect(body).toMatch(/'status-subscription-confirmation': \{/);
    expect(body).toMatch(/'status-subscription-welcome': \{/);
    expect(body).toMatch(/'team-invite': \{/);
    expect(body).toMatch(/'status-incident-created': \{/);
    expect(body).toMatch(/'status-incident-resolved': \{/);
    expect(body).toMatch(/'quota-warning': \{/);
    expect(body).toMatch(/'session-event-digest': \{/);
    expect(body).toMatch(/\} satisfies Record<string, Template>;/);
  });

  it('Null config → 17-method no-op stub with isConfigured:false; warn log mentions POSTMARK_API_TOKEN/FROM/REPLY_TO', () => {
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
      /export interface PostmarkSendApi \{\s*\n?\s*sendEmail\(input: \{\s*\n?\s*From: string;\s*\n?\s*To: string;\s*\n?\s*Subject: string;\s*\n?\s*TextBody: string;\s*\n?\s*HtmlBody: string;\s*\n?\s*ReplyTo: string;\s*\n?\s*MessageStream: string;\s*\n?\s*\}\): Promise<unknown>;/,
    );
  });

  it("send(): try logs 'email sent' info; catch classifyEmailError + warn 'email send failed (fire-and-forget)' + bump emailSendTotal metric with category outcome + swallow", () => {
    expect(body).toMatch(
      /logger\.info\(\{ component: 'email', template: name, to \}, 'email sent'\);/,
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
      /send\(\s*\n?\s*kind === 'created'\s*\n?\s*\? 'status-incident-created'\s*\n?\s*: kind === 'updated'\s*\n?\s*\? 'status-incident-updated'\s*\n?\s*: 'status-incident-resolved',/,
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
