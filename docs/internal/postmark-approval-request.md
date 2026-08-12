# Postmark account-approval request

**Submitted:** 2026-05-09
**Expected response:** by 2026-05-11 (Postmark typical: same-day to ~2 business days)
**Server:** driftstack-transactional (ID 19089808)
**Sender domain:** driftstack.dev (DKIM + Return-Path verified)

## Why we requested approval

Postmark's pre-approval anti-abuse policy restricts new accounts to
recipients sharing the same domain as the From address. Until the
account is approved, sends to non-`@driftstack.dev` recipients fail
silently (the API call returns success but the message is not
delivered, with error: _"While your account is pending approval, all
recipient addresses must share the same domain as the 'From' address.
The domain of the 'From' address is 'driftstack.dev', but you are
attempting to send email to the following domain(s): '<other>'."_).

This blocks the customer signup-verification email for any external
recipient — captured as F-002 in
[`docs/verification-log.md`](../verification-log.md).

## Form answers submitted

### Q1: Problems with your current email provider? Or is Postmark your first email provider?

Postmark is the first email provider for Driftstack. This is a
greenfield SaaS launch — no prior provider to migrate from. Selected
Postmark specifically because: (1) reputation for high deliverability
of transactional mail, (2) clean separation of transactional vs
broadcast streams, (3) DKIM/Return-Path verified domain setup is
straightforward, (4) honest API pricing matched to our expected
sub-1k/month launch volume.

### Q2: What types of messages do you intend to send with Postmark?

Transactional only — every message is triggered by a customer-initiated
action or a per-account lifecycle event. No newsletters, no broadcasts,
no purchased-list mailings. Specific templates in production today:

- Signup verification (one per account; expires in ~3h)
- Password reset (on-demand, customer-initiated)
- Magic-link sign-in (on-demand, customer-initiated)
- MFA enrollment confirmation (on-demand, customer-initiated)
- Billing receipts (Stripe webhook → email, one per successful charge)
- Trial-pack purchase confirmation (one per purchase)
- Subscription tier change notifications (one per change,
  customer-initiated)
- First-failure activation nudge (one-shot per account, after first
  session failure)
- First-success activation email (one-shot per account, after first
  successful session)
- Webhook quota warnings (80% / 100% thresholds, only when subscribed)
- Status-page subscription confirmation (double opt-in)
- Team invitation (when an account admin invites a teammate; one-shot
  per invite)

All sent via the default `outbound` Message Stream. No
bulk/promotional/broadcast usage planned.

### Q3: How are new subscribers/recipients acquired? How do you segment, handle bounces, or suppress addresses?

**Acquisition:** 100% application sign-ups at
https://app.driftstack.dev/signup. The customer enters their email +
password; we email them a verification link. No lead-generation
services, no list purchases, no scraped contacts, no co-registration.

**Segmentation:** not applicable — every send is a per-account
lifecycle event tied to an explicit customer action (signup, login,
billing transition, session result). No marketing-list segmentation.

**Bounce handling:** Postmark's hard-bounce + spam-complaint
suppression list is automatically honored by Postmark — we don't
override it. Going forward we will wire Postmark's bounce webhook
(POST to `https://api.driftstack.dev/v1/internal/postmark-webhook`)
so that hard bounces immediately mark the account's email as `invalid`
in our database, halting further sends to that address until the
customer corrects it through their account settings.

**Suppression / opt-out:** customers can opt out of non-critical
email events at app.driftstack.dev/settings → Email Preferences (six
per-event toggles: signup welcome, first session failure, first
session success, subscription tier changed, billing receipt, billing
renewal reminder). Critical emails (signup verification, password
reset, billing failure) are not opt-outable by design — they are
required for the customer to use their account. Support replies are
answered by a person at info@driftstack.dev and are likewise not
preference-gated.

**Domain verification status:** `driftstack.dev` DKIM + Return-Path
DNS records are verified at the Postmark sender-signatures dashboard.
Sender addresses: `noreply@driftstack.dev` (transactional default) +
`info@driftstack.dev` (support/reply). DPA is in place per
https://driftstack.dev/legal/dpa with Postmark listed as a
sub-processor in Annex 3.

### Optional addendum

Driftstack is a single-founder Dutch SaaS (BV registration in
progress) launching Q4-2026. Expected v1.0 volume: well under the
free-tier 100 emails/month for the first weeks; expected to upgrade
to Outbound Starter (~10k/month) before the first paying customer.

## Follow-up TODOs once Postmark approves

1. Smoke-test signup with a real external email (e.g. founder's
   personal mailbox) at app.driftstack.dev/signup → verify the
   verification email arrives.
2. Wire the Postmark bounce webhook
   (`POST /v1/internal/postmark-webhook`) so hard-bounces auto-mark
   invalid email in our DB. (V-NNN follow-up slice; not in production
   today; current behavior just silently retries via Postmark's own
   suppression list.)
3. Confirm DPA Annex 3 lists Postmark accurately + matches the
   sub-processors mirror enforcement (`scripts/check-subprocessor-mirror.mjs`).
4. Consider upgrading to Outbound Starter ($15/mo, 10k emails) before
   the first paying customer. Free tier (100/mo) hits the cap quickly
   under real signup load.
