// W563.B — drift guard for /docs/internal/postmark-approval-request.md.
// Postmark account-approval request 2026-05-09. Drift here either
// weakens the F-002-pre-approval-anti-abuse-policy framing, drops
// the 12-transactional-template scope, or unsets the bounce-webhook
// /v1/internal/postmark-webhook follow-up commitment.
//
//   • Submitted 2026-05-09. Server driftstack-transactional ID 19089808.
//   • Sender domain driftstack.dev (DKIM + Return-Path verified).
//   • F-002 customer-signup-verification-email blocked pre-approval.
//   • 12 transactional templates production today.
//   • 100% application sign-ups; no lists / scraping / co-reg.
//   • Critical emails (verify + password + billing-fail + sub-cancel
//     NOT opt-outable by design. (The subscription-cancellation and
//     support-ack templates were DELETED in the S44 2026-07-07 trim, so
//     naming them here claimed transactional mail the product cannot send.)
//   • 4 follow-up TODOs (smoke-test + bounce-webhook + DPA-Annex-3 +
//     Outbound-Starter upgrade).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/internal/postmark-approval-request.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W563.B /docs/internal/postmark-approval-request.md content parity', () => {
  const body = read(LIB);

  it("Header + Submitted + Server-ID + F-002 framing pinned: '# Postmark account-approval request' + '**Submitted:** 2026-05-09' + '**Expected response:** by 2026-05-11 (Postmark typical: same-day to ~2 business days)' + '**Server:** driftstack-transactional (ID 19089808)' + '**Sender domain:** driftstack.dev (DKIM + Return-Path verified)' + 'Postmark's pre-approval anti-abuse policy restricts new accounts to' + 'recipients sharing the same domain as the From address. Until the' + 'account is approved, sends to non-`@driftstack.dev` recipients fail' + 'silently' + 'captured as F-002 in' + '[`docs/verification-log.md`](../verification-log.md).' — pinned so the Submitted-2026-05-09 + Server-ID-19089808 + DKIM+Return-Path-verified + pre-approval-anti-abuse-same-domain + fail-silently-API-returns-success + F-002-verification-log commitment survives", () => {
    expect(body).toMatch(/^# Postmark account-approval request$/m);
    expect(body).toMatch(/\*\*Submitted:\*\* 2026-05-09/);
    expect(body).toMatch(
      /\*\*Expected response:\*\* by 2026-05-11 \(Postmark typical: same-day to ~2 business days\)/,
    );
    expect(body).toMatch(/\*\*Server:\*\* driftstack-transactional \(ID 19089808\)/);
    expect(body).toMatch(/\*\*Sender domain:\*\* driftstack\.dev \(DKIM \+ Return-Path verified\)/);
    expect(body).toMatch(/Postmark's pre-approval anti-abuse policy restricts new accounts to/);
    expect(body).toMatch(/recipients sharing the same domain as the From address\. Until the/);
    expect(body).toMatch(/account is approved, sends to non-`@driftstack\.dev` recipients fail/);
    expect(body).toMatch(/silently/);
    expect(body).toMatch(/captured as F-002 in/);
    expect(body).toMatch(/\[`docs\/verification-log\.md`\]\(\.\.\/verification-log\.md\)\./);
  });

  it("Q1 first-provider + Q2 12-transactional-template framing pinned: 'Postmark is the first email provider for Driftstack.' + 'reputation for high deliverability' + 'clean separation of transactional vs broadcast streams' + 'DKIM/Return-Path verified domain setup is' + 'honest API pricing matched to our expected' + 'sub-1k/month launch volume.' + 'Transactional only — every message is triggered by a customer-initiated' + 'action or a per-account lifecycle event.' + 'Signup verification (single-use link, expires in 30 minutes…)' + 'Password reset (on-demand, customer-initiated)' + 'Magic-link sign-in (on-demand, customer-initiated)' + 'Billing receipts (Stripe webhook → email, one per successful charge)' + 'Subscription tier change notifications (one per change,' + 'First-failure activation nudge (one-shot per account, after first' + 'First-success activation email (one-shot per account, after first' + 'Status-page subscription confirmation (double opt-in)' + 'Team invitation (when an account admin invites a teammate; one-shot' + 'All sent via the default `outbound` Message Stream.' — V-798 RETRACTED four rows: the ~3h TTL was really 30 minutes and the link re-mints on resend; MFA-enrollment and trial-pack confirmations have no template; the quota-warning template was deleted as a draft that never had send methods. This is a sub-processor compliance submission, so it must not enumerate mail the product cannot produce. Pinned so the 4-Q1-reason (deliverability + transactional-broadcast-separation + DKIM-setup + honest-pricing) + sub-1k/month + 12-transactional-template + outbound-Message-Stream commitment survives", () => {
    expect(body).toMatch(/Postmark is the first email provider for Driftstack\./);
    expect(body).toMatch(/reputation for high deliverability/);
    expect(body).toMatch(/clean separation of transactional vs/);
    expect(body).toMatch(/broadcast streams/);
    expect(body).toMatch(/DKIM\/Return-Path verified domain setup is/);
    expect(body).toMatch(/honest API pricing matched to our expected/);
    expect(body).toMatch(/sub-1k\/month launch volume\./);
    expect(body).toMatch(/Transactional only — every message is triggered by a customer-initiated/);
    expect(body).toMatch(/action or a per-account lifecycle event\./);
    expect(body).toMatch(
      /- Signup verification \(single-use link, expires in 30 minutes per\s*\n?\s*`AUTH_TOKEN_TTL_MS\.signupVerification`/,
    );
    expect(body, 'the ~3h TTL was wrong by an order of magnitude').not.toMatch(/expires in ~3h/);
    expect(body).toMatch(/- Password reset \(on-demand, customer-initiated\)/);
    expect(body).toMatch(/- Magic-link sign-in \(on-demand, customer-initiated\)/);
    // V-798 — no MFA template exists in the TEMPLATES map.
    expect(body, 'a template the product cannot send must not be submitted').not.toMatch(
      /- MFA enrollment confirmation/,
    );
    expect(body).toMatch(
      /- Billing receipts \(Stripe webhook → email, one per successful charge\)/,
    );
    // V-798 — trial_pack was retired by migration 0065; no template exists.
    expect(body).not.toMatch(/- Trial-pack purchase confirmation/);
    expect(body).toMatch(/- Subscription tier change notifications \(one per change,/);
    expect(body).toMatch(/- First-failure activation nudge \(one-shot per account, after first/);
    expect(body).toMatch(/- First-success activation email \(one-shot per account, after first/);
    // V-798 — email.ts's own header records the quota-warning template as a
    // draft that "never had send methods" and was DELETED.
    expect(body).not.toMatch(/- Webhook quota warnings/);
    // The rows that ARE real and were missing from the submission.
    expect(body).toMatch(/- Payment-failure notice \(Stripe webhook → email/);
    expect(body).toMatch(/- Renewal reminder \(Stripe upcoming-invoice notice/);
    expect(body).toMatch(/- BYOK Anthropic key rotation reminder/);
    expect(body, 'the list must name its source of truth').toMatch(
      /this list is the `TEMPLATES` map in `apps\/server\/src\/services\/email\.ts`/,
    );
    expect(body).toMatch(/- Status-page subscription confirmation \(double opt-in\)/);
    expect(body).toMatch(/- Team invitation \(when an account admin invites a teammate; one-shot/);
    expect(body).toMatch(/All sent via the default `outbound` Message Stream\./);
  });

  it("Q3 acquisition + bounce + suppression + DKIM-verified + 4-follow-up framing pinned: '**Acquisition:** 100% application sign-ups at' + 'https://app.driftstack.dev/signup' + 'No lead-generation' + 'services, no list purchases, no scraped contacts, no co-registration.' + '**Bounce handling:** Postmark's hard-bounce + spam-complaint' + 'suppression list is automatically honored by Postmark' + 'wire Postmark's bounce webhook' + '(POST to `https://api.driftstack.dev/v1/internal/postmark-webhook`)' + 'hard bounces immediately mark the account's email as `invalid`' + '**Suppression / opt-out:** customers can opt out of non-critical' + 'app.driftstack.dev/settings → Email Preferences' + 'Critical emails (signup verification, password' + 'reset, billing failure) are not opt-outable by design' + '**Domain verification status:** `driftstack.dev` DKIM + Return-Path' + 'DNS records are verified at the Postmark sender-signatures dashboard.' + '`noreply@driftstack.dev` (transactional default) +' + '`info@driftstack.dev` (support/reply).' + 'DPA is in place per' + 'https://driftstack.dev/legal/dpa with Postmark listed as a' + 'sub-processor in Annex 3.' + '## Follow-up TODOs once Postmark approves' + 'Smoke-test signup with a real external email' + 'Wire the Postmark bounce webhook' + 'Confirm DPA Annex 3 lists Postmark accurately' + 'scripts/check-subprocessor-mirror.mjs' + 'Consider upgrading to Outbound Starter ($15/mo, 10k emails)' + 'Free tier (100/mo) hits the cap quickly' — pinned so the 100%-app-signup + no-list/scrape/co-reg + auto-honored-suppression-list + /v1/internal/postmark-webhook + email-invalid-flag + 3-critical-non-opt-outable + noreply+info-driftstack.dev + DPA-Annex-3 + 4-follow-up-TODO commitment survives", () => {
    expect(body).toMatch(/\*\*Acquisition:\*\* 100% application sign-ups at/);
    expect(body).toMatch(/https:\/\/app\.driftstack\.dev\/signup/);
    expect(body).toMatch(/No lead-generation/);
    expect(body).toMatch(/services, no list purchases, no scraped contacts, no co-registration\./);
    expect(body).toMatch(/\*\*Bounce handling:\*\* Postmark's hard-bounce \+ spam-complaint/);
    expect(body).toMatch(/suppression list is automatically honored by Postmark/);
    expect(body).toMatch(/wire Postmark's bounce webhook/);
    expect(body).toMatch(
      /\(POST to `https:\/\/api\.driftstack\.dev\/v1\/internal\/postmark-webhook`\)/,
    );
    expect(body).toMatch(/hard bounces immediately mark the account's email as `invalid`/);
    expect(body).toMatch(/\*\*Suppression \/ opt-out:\*\* customers can opt out of non-critical/);
    expect(body).toMatch(/app\.driftstack\.dev\/settings → Email Preferences/);
    expect(body).toMatch(/Critical emails \(signup verification, password/);
    // Was /reset, billing failure, subscription cancellation,/. The subscription-cancellation
    // and support-acknowledgement templates were deleted as unused, and the quota-warning
    // drafts never had send methods — so this vendor-facing deliverability request named three
    // transactional emails the product cannot send. The list now matches the six real toggles
    // and the three real critical templates.
    expect(body).toMatch(/reset, billing failure\) are not opt-outable by design/);
    // The companion half of the same removal: support-acknowledgement was deleted in the S44
    // trim too, so the vendor list named it as a critical transactional email the product
    // cannot send. Human support replies from info@driftstack.dev are what actually happens.
    expect(body).toMatch(
      /Support replies are\s*\n?\s*answered by a person at info@driftstack\.dev/,
    );
    expect(body).toMatch(
      /\*\*Domain verification status:\*\* `driftstack\.dev` DKIM \+ Return-Path/,
    );
    expect(body).toMatch(/DNS records are verified at the Postmark sender-signatures dashboard\./);
    expect(body).toMatch(/`noreply@driftstack\.dev` \(transactional default\) \+/);
    expect(body).toMatch(/`info@driftstack\.dev` \(support\/reply\)\./);
    expect(body).toMatch(/DPA is in place per/);
    expect(body).toMatch(/https:\/\/driftstack\.dev\/legal\/dpa with Postmark listed as a/);
    expect(body).toMatch(/sub-processor in Annex 3\./);
    expect(body).toMatch(/## Follow-up TODOs once Postmark approves/);
    expect(body).toMatch(/1\. Smoke-test signup with a real external email/);
    expect(body).toMatch(/2\. Wire the Postmark bounce webhook/);
    expect(body).toMatch(/3\. Confirm DPA Annex 3 lists Postmark accurately/);
    expect(body).toMatch(/scripts\/check-subprocessor-mirror\.mjs/);
    expect(body).toMatch(/4\. Consider upgrading to Outbound Starter \(\$15\/mo, 10k emails\)/);
    expect(body).toMatch(/Free tier \(100\/mo\) hits the cap quickly/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  // V-1140 — this file records answers submitted to a sub-processor on 2026-05-09.
  // They say every message is triggered by a customer-initiated action or a
  // per-account lifecycle event, and that there are no broadcasts. The server also
  // fans status-incident mail to every confirmed subscriber, each with a rotated
  // personal unsubscribe URL, on the transactional `outbound` stream. Q2 lists the
  // subscription CONFIRMATION and not that mail.
  //
  // The answers are deliberately left as submitted — rewriting them would falsify
  // the record of what a vendor was told. The banner is what carries the
  // correction, so the banner is what has to be held.
  it('CRITICAL the correction banner is present. Without it this document reads as an accurate description of every message the server sends, and D-8 — whether the status templates belong on a broadcast stream — would be decided against a list that never mentions the mail in question.', () => {
    const body = read(LIB);
    expect(body, 'the V-1140 correction banner was removed').toMatch(/V-1140/);
    expect(body, 'the banner no longer names the uncovered category').toMatch(
      /incident-notifications\.ts/,
    );
    expect(body, 'the banner no longer records that the fan-out predates the submission').toMatch(
      /2026-05-07, two days before this submission/,
    );
  });

  it('CRITICAL the transactional stream is still the only one used. The banner asserts `outbound` is never overridden; if a broadcast stream is ever wired the banner becomes the stale half of this document and should be revisited rather than left asserting a resolved question is open.', () => {
    const email = read(resolve(REPO_ROOT, 'apps/server/src/services/email.ts'));
    expect(email, 'the outbound default moved out of email.ts').toMatch(
      /messageStream = 'outbound'/,
    );
    const overrides = [...email.matchAll(/messageStream:\s*'(\w+)'/g)].map((m) => m[1] ?? '');
    expect(
      overrides,
      'a message stream is now set explicitly — the banner needs revisiting',
    ).toEqual([]);
  });

  it('CRITICAL the subscriber fan-out the banner describes still exists. If incident mail stops going to a subscriber list, the whole basis of the correction is gone and this note should be retired deliberately, not left standing over behaviour that no longer happens.', () => {
    const fan = read(resolve(REPO_ROOT, 'apps/server/src/services/incident-notifications.ts'));
    expect(fan, 'the confirmed-subscriber snapshot is gone').toMatch(/confirmed-subscriber list/);
    expect(fan, 'the per-subscriber unsubscribe rotation is gone').toMatch(/unsubscribe/i);
  });
});
