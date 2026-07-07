---
layout: ../../layouts/DocLayout.astro
title: Email preferences
description: Manage which transactional emails Driftstack sends — opt out of welcome / activation / receipts / renewal reminders. Operational mail (auth, security, billing failures) is never opt-outable.
---

# Email preferences

Driftstack sends two categories of email:

1. **Operational** — non-optional. Required for the service to
   work (signup verification, password reset, billing-failure
   notice, security notices). You cannot opt out of these.
2. **Transactional / informational** — opt-outable. Welcome
   email, first-session activation milestone, tier-change
   confirmation, billing receipts, renewal reminders. Customers
   control these via the
   endpoints below.

The endpoint surface is intentionally narrow: list current
preferences, set one preference. Per-event opt-in is the unit;
there's no "opt out of everything optional" shorthand because
the legal posture (per the [DPA](https://driftstack.dev/legal/dpa)) requires that we
deliver each opt-out as an affirmative customer choice.

## List current preferences

`GET /v1/account/email-preferences`

Returns the current opt-in state for every opt-outable category.
Categories not yet explicitly set return their default state
(opt-in for everything, except where a specific email's footer
already provided a one-click unsubscribe).

Response (200):

```json
{
  "data": [
    { "event_type": "signup-welcome", "opted_in": true },
    { "event_type": "session-success-first", "opted_in": true },
    { "event_type": "session-failed-first", "opted_in": true },
    { "event_type": "tier-changed", "opted_in": true },
    { "event_type": "billing-receipt", "opted_in": true },
    { "event_type": "billing-renewal-reminder", "opted_in": true }
  ]
}
```

Required scope: `account_owner` (the service gates this read on
`account_owner` — a bare `read` key is not sufficient).

### Team RBAC

A team member with a valid membership can read the OWNER's
preferences by passing `X-Driftstack-Account: acc_<owner-uuid>`.
Both `member` and `admin` roles are allowed for the read.

## Set one preference

`PUT /v1/account/email-preferences`

Sets the opt-in state for a single category.

Request:

```json
{
  "event_type": "session-success-first",
  "opted_in": false
}
```

Response: `204 No Content`.

Errors:

- `400 bad-request` — `event_type` is not in the opt-outable enum
  (e.g. customer tried to opt out of `signup-verification`, which
  is operational).
- `403 forbidden` — set on an OWNER's preferences via
  `X-Driftstack-Account` requires `admin` role on that team;
  `member` is read-only on writes.

Required scope: `account_owner` (the service gates this write on
`account_owner` — a broad `write` key is not sufficient).

## Opt-outable categories

| `event_type`               | What it is                                  | Default |
| -------------------------- | ------------------------------------------- | ------- |
| `signup-welcome`           | First email after account creation          | opt-in  |
| `session-success-first`    | One-time activation milestone               | opt-in  |
| `session-failed-first`     | One-time first-failure notice               | opt-in  |
| `tier-changed`             | Confirmation when subscription tier changes | opt-in  |
| `billing-receipt`          | Receipt for each successful charge          | opt-in  |
| `billing-renewal-reminder` | 7-days-before-renewal heads-up              | opt-in  |

## What's NOT opt-outable

These ALWAYS send regardless of preferences:

- `signup-verification` — required to activate the account.
- `password-reset` — security-critical.
- `billing-failure` — fires on a failed subscription charge
  (Stripe `invoice.payment_failed`); tells you when the automatic
  retry happens, or that none is scheduled. Payment problems are
  customer-action-needed, so this one always sends.
- `status-incident-created` / `status-incident-resolved` — only
  to customers explicitly subscribed via `/status` (separate
  opt-in surface, not part of email preferences).
- Security notices under GDPR Art. 34 — see
  `docs/runbooks/incidents.md` §3.4.

The full list of email templates lives in
`apps/server/src/services/email.ts:TEMPLATES`. The
`OptOutableEmailEventSchema` enum is the canonical opt-outable
set — categories absent from that enum are operational by design.

## Customer-dashboard surface

The `/settings → Email` section on the customer dashboard
renders this endpoint visually with toggle switches per
category. Changes apply immediately on toggle (no save button).

## Source of truth

Routes: `apps/server/src/routes/email-preferences.ts`. Schema:
`packages/api-types/src/accounts.ts:OptOutableEmailEventSchema`.
Service: `apps/server/src/services/email-preferences.ts`. Repo:
`apps/server/src/db/email-preferences-repo.ts`.
