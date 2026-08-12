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

  it("Q1 first-provider + Q2 12-transactional-template framing pinned: 'Postmark is the first email provider for Driftstack.' + 'reputation for high deliverability' + 'clean separation of transactional vs broadcast streams' + 'DKIM/Return-Path verified domain setup is' + 'honest API pricing matched to our expected' + 'sub-1k/month launch volume.' + 'Transactional only — every message is triggered by a customer-initiated' + 'action or a per-account lifecycle event.' + 'Signup verification (one per account; expires in ~3h)' + 'Password reset (on-demand, customer-initiated)' + 'Magic-link sign-in (on-demand, customer-initiated)' + 'MFA enrollment confirmation (on-demand, customer-initiated)' + 'Billing receipts (Stripe webhook → email, one per successful charge)' + 'Trial-pack purchase confirmation (one per purchase)' + 'Subscription tier change notifications (one per change,' + 'First-failure activation nudge (one-shot per account, after first' + 'First-success activation email (one-shot per account, after first' + 'Webhook quota warnings (80% / 100% thresholds, only when subscribed)' + 'Status-page subscription confirmation (double opt-in)' + 'Team invitation (when an account admin invites a teammate; one-shot' + 'All sent via the default `outbound` Message Stream.' — pinned so the 4-Q1-reason (deliverability + transactional-broadcast-separation + DKIM-setup + honest-pricing) + sub-1k/month + 12-transactional-template + outbound-Message-Stream commitment survives", () => {
    expect(body).toMatch(/Postmark is the first email provider for Driftstack\./);
    expect(body).toMatch(/reputation for high deliverability/);
    expect(body).toMatch(/clean separation of transactional vs/);
    expect(body).toMatch(/broadcast streams/);
    expect(body).toMatch(/DKIM\/Return-Path verified domain setup is/);
    expect(body).toMatch(/honest API pricing matched to our expected/);
    expect(body).toMatch(/sub-1k\/month launch volume\./);
    expect(body).toMatch(/Transactional only — every message is triggered by a customer-initiated/);
    expect(body).toMatch(/action or a per-account lifecycle event\./);
    expect(body).toMatch(/- Signup verification \(one per account; expires in ~3h\)/);
    expect(body).toMatch(/- Password reset \(on-demand, customer-initiated\)/);
    expect(body).toMatch(/- Magic-link sign-in \(on-demand, customer-initiated\)/);
    expect(body).toMatch(/- MFA enrollment confirmation \(on-demand, customer-initiated\)/);
    expect(body).toMatch(
      /- Billing receipts \(Stripe webhook → email, one per successful charge\)/,
    );
    expect(body).toMatch(/- Trial-pack purchase confirmation \(one per purchase\)/);
    expect(body).toMatch(/- Subscription tier change notifications \(one per change,/);
    expect(body).toMatch(/- First-failure activation nudge \(one-shot per account, after first/);
    expect(body).toMatch(/- First-success activation email \(one-shot per account, after first/);
    expect(body).toMatch(
      /- Webhook quota warnings \(80% \/ 100% thresholds, only when subscribed\)/,
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
});
