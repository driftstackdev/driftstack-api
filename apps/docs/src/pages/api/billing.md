---
layout: ../../layouts/DocLayout.astro
title: Billing
description: Subscriptions, the Stripe Customer Portal redirect, and reading your current billing state.
---

# Billing

Driftstack billing runs on Stripe. The API gives you checkout and
portal links; you pay for and manage your subscription in Stripe's
hosted pages. When Stripe reports a change, Driftstack updates your
subscription state, records it in your audit log, and sends you an
email notification.

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

**Both URL fields are optional, and omitting them is the path that works
for everyone.** When absent, the customer is returned to the Driftstack
dashboard after checkout. If you do send them, each URL's origin must be
on the allowlist (`https://app.driftstack.io`, plus local-development
origins); any other origin returns `400`. Contact support to have an
origin added.

## Open the Stripe Customer Portal

`POST /v1/billing/portal-session`

```ts
const { portal_url } = await client.billing.createPortalSession();
```

Returns a short-lived one-time URL into Stripe's hosted Customer
Portal. The customer manages their payment method, downloads
invoices, cancels, or upgrades / downgrades from the portal.
Driftstack picks up the resulting changes from Stripe and updates
the account's subscription state.

The portal URL is single-use and short-lived. Mint a fresh one
each time the customer clicks "Manage subscription" — don't cache.

### Redirect variant (no JavaScript required)

`GET /v1/account/me/billing-portal`

Mints the same single-use portal URL and answers `302` with it in the
`Location` header, so a plain `<a>` or form POST can send the customer
straight to the portal without any client-side code. A fetch client that
does not follow redirects can read `Location` itself.

Requires the same `admin:billing` scope as the POST above, and returns the
same `503` when billing is not enabled on the deployment. Unlike `GET
/v1/billing`, this route does **not** honour `X-Driftstack-Account` — only
the owner manages the owner's billing.

## Webhook events from Stripe → Driftstack → Customer

When Stripe reports a subscription change, Driftstack
records the change in the account's audit log
(`subscription.tier_changed` with `payload.from` + `payload.to`).
That audit row is the source of truth for programmatic subscription-change
consumers; it is available through the account audit-log API.

## Auth + scoping

All `/v1/billing/*` endpoints are bearer-authenticated and scoped
to the calling account, with one read exception: `GET /v1/billing`
honors the team-RBAC `X-Driftstack-Account` header, so a team
member acting as the owner reads the OWNER's subscription state
(tier, status, period end) — the same act-as behavior as
`GET /v1/usage`. The mutation endpoints (checkout-session,
portal-session, billing-portal) do NOT honor the header — only the
owner manages the owner's billing.

Reading billing state (`GET /v1/billing`) requires the
`read:billing` scope — a broad `read` or `account_owner` key
(the dashboard's web-session scope set) also satisfies it, but a
write-only key is refused with 403; mutation endpoints (checkout,
manage-portal) require the `admin:billing` scope (a broad `admin`
or `account_owner` key also satisfies it).

The `read:billing` floor also covers the rest of the billing read
family: the crypto-order reads (`GET /v1/billing/crypto-orders`, its
single-order lookup, and the `receipt`, `receipt.txt`, and `receipt.pdf`
variants) and the cost breakdown (`GET /v1/account/cost`). A broad
`read` or `account_owner` key satisfies all of them; a narrow
non-billing key is refused with a 403 that names the required
`read:billing` scope.
