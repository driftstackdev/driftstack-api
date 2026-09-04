# Postmark account-approval request

**Submitted:** 2026-05-09
**Expected response:** by 2026-05-11 (Postmark typical: same-day to ~2 business days)
**Server:** driftstack-transactional (ID 19089808)
**Sender domain:** driftstack.io (DKIM + Return-Path verified)

> **⚠ V-1140 — these are the answers submitted on 2026-05-09, and they do not
> describe one category of mail the server sends.** Annotated rather than
> rewritten: this file records what went to a sub-processor, so the answers
> below are left as submitted.
>
> `services/incident-notifications.ts` fans status-incident mail to every
> confirmed status-page subscriber, each with a freshly rotated personal
> unsubscribe URL, on the default `outbound` transactional stream —
> `messageStream = 'outbound'` in `services/email.ts`, never overridden
> anywhere in `apps/server/src`. Q2 lists the status-page subscription
> CONFIRMATION but not the incident mail itself, and states that every message
> is triggered by a customer-initiated action or a per-account lifecycle event.
> An incident fan-out is neither. Q3 repeats the claim under Segmentation.
>
> This is not a case of the product changing afterwards:
> `incident-notifications.ts` and `status-subscribers.ts` both landed
> 2026-05-07, two days before this submission.
>
> Whether those templates should move to a broadcast stream, or whether written
> confirmation should be obtained that double-opt-in status notifications may
> ride `outbound`, is **D-8** — open, and owned by whoever holds the Postmark
> account. This note takes neither option. It exists so that question is not
> settled by reading a document that never mentions the mail.
>
> One further caveat: Q2's list is no longer verbatim-as-submitted. V-798
> removed three rows naming mail the product cannot send, with its reasoning
> recorded inline below; git history is the only exact record of the original.

## Why we requested approval

Postmark's pre-approval anti-abuse policy restricts new accounts to
recipients sharing the same domain as the From address. Until the
account is approved, sends to non-`@driftstack.dev` recipients fail
silently (the API call returns success but the message is not
delivered, with error: _"While your account is pending approval, all
recipient addresses must share the same domain as the 'From' address.
The domain of the 'From' address is 'driftstack.io', but you are
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

V-798 — this list is the `TEMPLATES` map in `apps/server/src/services/email.ts`,
which currently holds 20 entries. Three rows previously named here could not be
sent at all: MFA enrollment confirmation and trial-pack purchase confirmation
have no template, and the quota-warning template was deleted (that file's own
header records it as a draft that "never had send methods"). A submission to a
sub-processor should not enumerate mail the product cannot produce.

Transactional only — every message is triggered by a customer-initiated
action or a per-account lifecycle event. No newsletters, no broadcasts,
no purchased-list mailings. Specific templates in production today:

- Signup verification (single-use link, expires in 30 minutes per
  `AUTH_TOKEN_TTL_MS.signupVerification`; the resend button re-mints it,
  so it is not one-per-account)
- Password reset (on-demand, customer-initiated)
- Magic-link sign-in (on-demand, customer-initiated)
- Billing receipts (Stripe webhook → email, one per successful charge)
- Payment-failure notice (Stripe webhook → email, one per failed charge)
- Renewal reminder (Stripe upcoming-invoice notice, ahead of a renewal
  charge)
- Webhook signing-secret rotation reminder, grace-expiry notice, and
  force-rotation notice (per-endpoint, cadence-limited)
- BYOK Anthropic key rotation reminder (per-key, cadence-limited)
- Subscription tier change notifications (one per change,
  customer-initiated)
- First-failure activation nudge (one-shot per account, after first
  session failure)
- First-success activation email (one-shot per account, after first
  successful session)
- Status-page subscription confirmation (double opt-in)
- Team invitation (when an account admin invites a teammate; one-shot
  per invite)

All sent via the default `outbound` Message Stream. No
bulk/promotional/broadcast usage planned.

### Q3: How are new subscribers/recipients acquired? How do you segment, handle bounces, or suppress addresses?

**Acquisition:** 100% application sign-ups at
https://app.driftstack.io/signup. The customer enters their email +
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
email events at app.driftstack.io/settings → Email Preferences (six
per-event toggles: signup welcome, first session failure, first
session success, subscription tier changed, billing receipt, billing
renewal reminder). Critical emails (signup verification, password
reset, billing failure) are not opt-outable by design — they are
required for the customer to use their account. Support replies are
answered by a person at info@driftstack.dev and are likewise not
preference-gated.

**Domain verification status:** `driftstack.io` DKIM + Return-Path
DNS records are verified at the Postmark sender-signatures dashboard.
Sender addresses: `noreply@driftstack.dev` (transactional default) +
`info@driftstack.dev` (support/reply). DPA is in place per
https://driftstack.io/legal/dpa with Postmark listed as a
sub-processor in Annex 3.

### Optional addendum

Driftstack is a single-founder Dutch SaaS (BV registration in
progress) launching Q4-2026. Expected v1.0 volume: well under the
free-tier 100 emails/month for the first weeks; expected to upgrade
to Outbound Starter (~10k/month) before the first paying customer.

## Follow-up TODOs once Postmark approves

1. Smoke-test signup with a real external email (e.g. founder's
   personal mailbox) at app.driftstack.io/signup → verify the
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
