---
layout: ../../layouts/DocLayout.astro
title: Billing
description: Subscriptions, the $2.99 trial pack, the Stripe Customer Portal redirect, and reading your current billing state.
---

# Billing

All Driftstack billing is a thin layer over Stripe. The Driftstack
API mints checkout sessions + portal URLs; the customer interacts
with the Stripe-hosted UI directly. Driftstack receives webhook
events from Stripe (`invoice.paid`, `customer.subscription.updated`,
etc.) and reflects them into the account's `subscription` row +
audit-log + email notifications.

## Read billing state

`GET /v1/billing`

```ts
const state = await client.billing.getState();
```

Returns:

```json
{
  "subscription": {
    "tier": "api_builder",
    "status": "active",
    "stripe_subscription_id": "sub_<stripe-id>",
    "current_period_end": "2026-06-01T00:00:00Z",
    "cancel_at_period_end": false,
    "canceled_at": null,
    "created_at": "2026-05-01T00:00:00Z",
    "updated_at": "2026-05-01T00:00:00Z"
  },
  "trial_pack": {
    "active": false,
    "credit_cents_remaining": 0,
    "expires_at": null,
    "redeemed": false
  }
}
```

`subscription` is `null` when the account has never subscribed.
The id is `stripe_subscription_id` (the live Stripe-side id, prefix
`sub_`); Driftstack does not mint its own subscription id alongside.

`status` follows Stripe's subscription-status vocabulary
(`active`, `trialing`, `past_due`, `canceled`, `incomplete`,
`incomplete_expired`, `unpaid`, `paused`). `canceled_at` is the
Stripe cancellation timestamp — non-null only when the
subscription has been cancelled; `cancel_at_period_end=true` is
distinct (cancellation is scheduled but not yet effective).

`trial_pack.active` is `true` while the customer has unspent
credit and the 14-day window hasn't elapsed.

## Start a subscription

`POST /v1/billing/checkout-session`

```json
{
  "tier": "api_builder",
  "billing_period": "monthly",
  "success_url": "https://your.app/billing/success?session_id={CHECKOUT_SESSION_ID}",
  "cancel_url": "https://your.app/billing/cancel"
}
```

Returns `{ checkout_url, checkout_session_id }`. Redirect the
customer to `checkout_url`; Stripe handles card collection +
3DS + tax compliance and posts the result back to your
`success_url`.

`success_url` and `cancel_url` are validated against an allowlist
. Customers self-hosting Driftstack configure the allowlist
in their deployment env.

## Start the trial pack

`POST /v1/billing/trial-pack`

```json
{
  "success_url": "https://your.app/billing/success",
  "cancel_url": "https://your.app/billing/cancel"
}
```

Returns the same `{ checkout_url, checkout_session_id }` shape.
The trial pack is a one-time $2.99 charge that credits 299¢ of
session-time at the API Starter overage rate ($0.18 / concurrent-
hour); ~16 hours of use. Once-per-account.

## Open the Stripe Customer Portal

`POST /v1/billing/portal-session`

```ts
const { portal_url } = await client.billing.createPortalSession();
```

Returns a short-lived one-time URL into Stripe's hosted Customer
Portal. The customer manages their payment method, downloads
invoices, cancels, or upgrades / downgrades from the portal.
Driftstack receives the resulting Stripe events via webhook + the
account's `subscription` row updates.

The portal URL is single-use and short-lived. Mint a fresh one
each time the customer clicks "Manage subscription" — don't cache.

## Webhook events from Stripe → Driftstack → Customer

When Stripe fires `customer.subscription.updated` (or any of the
~10 lifecycle events Driftstack subscribes to), Driftstack
records the change in the account's audit log
(`subscription.tier_changed` with `payload.from` + `payload.to`)
and optionally fires a customer-facing webhook event.

See [Webhook events catalog](/webhooks/events/) for the planned
`subscription.changed` / `subscription.cancelled` events; today
the `subscription.tier_changed` audit row is the source of truth
for programmatic consumers.

## Auth + scoping

All `/v1/billing/*` endpoints are bearer-authenticated and scoped
to the calling account. They do NOT honor the team-RBAC
`X-Driftstack-Account` header — billing is always per-account, not
per-team-context. Team owners manage their own billing; team
members never see the owner's billing state.

Read endpoints (GET) accept a bearer with `read` scope; mutation
endpoints (start trial, checkout, manage-portal) require the
`admin:billing` scope (a broad `admin` or `account_owner` key also
satisfies it).
