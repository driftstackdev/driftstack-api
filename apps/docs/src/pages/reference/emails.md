---
layout: ../../layouts/DocLayout.astro
title: Emails Driftstack sends
description: Catalog of every email Driftstack actually sends — what triggers each one, which are opt-outable, and what to check when an expected email doesn't arrive.
---

# Emails Driftstack sends

Driftstack sends transactional email through
[Postmark](https://postmarkapp.com), from
`noreply@driftstack.dev`. This page lists every email the platform
sends today, what triggers it, and whether you can opt out.
Anything claiming to be from Driftstack but sent from other
infrastructure isn't us — report it to
[security@driftstack.dev](mailto:security@driftstack.dev).

## Account + sign-in

Required for the account to work — not opt-outable.

| Email                                            | Trigger                                                                                                                                                                                                                                               |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Verify your Driftstack account**               | Signup, the **Resend verification email** button, and magic-link sign-in all send this single-use link. Signup-verification links expire after 30 minutes; magic-link tokens after 15. Re-triggering mints a fresh token and invalidates the old one. |
| **Reset your Driftstack password**               | `POST /v1/auth/password-reset/request` (the "Forgot password" flow). Single-use link, 60-minute expiry.                                                                                                                                               |
| **Confirm a new sign-in method on your account** | Signing in with Google or GitHub using an email that already has a Driftstack account but no OAuth link yet. The link confirms the merge of the new sign-in method.                                                                                   |

The send-triggering endpoints are IP-rate-limited (3 requests per
minute per IP for resend-verification, password-reset, and
magic-link requests), so a double-clicked button won't lock you out
— but a script hammering them will get `429`s.

## Getting started

Opt-outable lifecycle emails.

| Email                          | Trigger                                                                   |
| ------------------------------ | ------------------------------------------------------------------------- |
| **Welcome to Driftstack**      | Sent once, after email verification succeeds.                             |
| **Your first session is up**   | The account's first successful session — a one-time activation milestone. |
| **Your first session failure** | The account's first failed session, with pointers for debugging it.       |

## Billing

| Email                                  | Trigger                                                                                                                                                            | Opt-outable? |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| **Payment receipt**                    | A successful subscription charge (Stripe's `invoice.payment_succeeded`). Zero-amount invoices — trial starts, 100% discounts — don't produce one.                  | Yes          |
| **Payment failed**                     | A subscription charge fails (`invoice.payment_failed`). Tells you when the automatic retry happens — or, on the final attempt, that no further retry is scheduled. | No           |
| **Subscription tier changed**          | Your tier changes (upgrade or downgrade).                                                                                                                          | Yes          |
| **Your subscription renews in 7 days** | Stripe's upcoming-invoice notice, roughly 7 days before a renewal charges.                                                                                         | Yes          |

Stripe (the card processor) may send its own processor receipt in
addition to the Driftstack one, depending on your Stripe email
settings. Crypto orders don't email receipts — use the
[crypto receipt endpoints](/guides/paying-with-crypto/#step-4--receipts)
for those.

## Team

| Email                                        | Trigger                                                                                                  | Opt-outable? |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------ |
| **You're invited to join a Driftstack team** | The account owner invites a member. The link is single-use and required to accept, so this always sends. | No           |

## Security + credential rotation

Security advisories — never opt-outable.

| Email                                                 | Trigger                                                                                                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rotate your webhook signing secret**                | A webhook signing secret reaches the 60-day reminder threshold (the recommended rotation cadence is 90 days).                                         |
| **Your webhook secret was auto-rotated for security** | A signing secret crossed the 91-day hard cap and the server rotated it. Carries the 7-day dual-signing grace deadline for rolling out the new secret. |
| **Webhook secret grace window expires in 24h**        | Sent inside the final ~24 hours of a force-rotation grace window if your verifier hasn't picked up the new secret yet.                                |
| **Rotate your Anthropic API key**                     | A stored BYOK Anthropic key reaches the 60-day reminder threshold. The key itself never appears in the email.                                         |

## Status-page notifications

These go to [status.driftstack.dev](https://status.driftstack.dev)
subscribers — a separate opt-in list, not tied to your account's
email preferences. Every status email carries an unsubscribe link.

| Email                                      | Trigger                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **Confirm your Driftstack status updates** | Submitting the subscribe form on the status page — clicking the link is the opt-in confirmation (double opt-in). |
| **You're subscribed to Driftstack status** | Sent once after the confirmation click.                                                                          |
| **Incident posted**                        | A public incident is filed.                                                                                      |
| **Incident update**                        | An operator posts an update on an open incident. Throttled to at most one per subscriber per incident per hour.  |
| **Incident resolved**                      | The incident is resolved. One subscription covers posted + update + resolved.                                    |

## Managing your preferences

The opt-outable categories are controlled per event type via the
API or the dashboard's **Settings → Email** toggles:

```
GET /v1/account/email-preferences   # read the current toggles
PUT /v1/account/email-preferences   # { "event_type": "...", "opted_in": false }
```

The opt-outable set is the `OptOutableEmailEventSchema` enum:
`signup-welcome`, `session-success-first`, `session-failed-first`,
`tier-changed`, `billing-receipt`, `billing-renewal-reminder`.
Everything absent from that enum is operational by design and always
sends. Both endpoints are gated on the `account_owner` scope — a
bare `read`/`write` API key is not sufficient — and team members can
target the owner's preferences with `X-Driftstack-Account` (reads
allow `member` + `admin`; writes require `admin`). Full endpoint
semantics: [Email preferences](/api/email-preferences/).

## Didn't get an email?

Work through these in order before contacting support:

1. **Check the exact address you typed.** Aliases
   (`user+driftstack@…`), corporate filters, and dot-stripping rules
   are common reasons a legitimate send lands somewhere unexpected.
   Search for `from:noreply@driftstack.dev`.
2. **Check spam / junk / Promotions.** Mark Driftstack as "not
   spam" and add `noreply@driftstack.dev` to your contacts so future
   sends route to the inbox.
3. **Wait a minute, then re-trigger.** Postmark typically delivers
   in seconds, but recipient-side queues add latency. Sign-in and
   verification emails are safe to re-request — the old token is
   invalidated, and the 3/minute per-IP cap tolerates a retry.
4. **On a work address?** Some workspaces quarantine mail from new
   senders until an admin releases it. `driftstack.dev` is the
   domain to allowlist.
5. **Repeated silence on the same address** usually means a typo'd
   domain or a hard bounce: bounced addresses land on a suppression
   list that mutes every retry. Email
   [support@driftstack.dev](mailto:support@driftstack.dev) _from a
   different address_, mention the original one, and we'll check the
   delivery log, clear the suppression, and replay the send.

When you contact support, include the address the email was sent
to, the action that triggered it, and an approximate timestamp with
timezone — that's what we match against the delivery log.

## Related

- [Email preferences API](/api/email-preferences/) — the toggle endpoints in full
- [Account notifications (SSE)](/api/account-notifications/) — the in-dashboard notification stream
- [Privacy policy](https://driftstack.dev/legal/privacy/) — how long we keep what
