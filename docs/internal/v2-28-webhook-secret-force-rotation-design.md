# v2-#28 — server-initiated webhook signing-secret force-rotation policy

**Status:** design doc; founder verdict pending  
**Authors:** Agent 2  
**Date:** 2026-05-18  
**Scope:** `apps/server` webhook delivery + outbound signing path  
**Related:** v2-#10 (secret_created_at column), v2-#10.5 (60-day reminder
service), v2-#17 (daily reminder cron), v2-#20 (dual-sign grace honoured by
the worker)

## Background

Today's lifecycle:

1. Customer creates a webhook endpoint → `secret_created_at` stamped.
2. Day 60+ → daily cron sends a rotation-reminder email (per v2-#17),
   with a 7-day per-account cooldown so a stalled customer gets nagged
   once a week, not once a day.
3. Customer-initiated `POST /v1/webhooks/:id/rotate-secret` flips
   `secretPrev` + `secretPrevExpiresAt = now + 24h`, the worker
   dual-signs during the window (v2-#20), then drops the previous
   signature.

What the lifecycle does _not_ do today: there is no upper bound on
how long a customer can ignore the nag email. A secret minted in
January can still sign deliveries in December, well past any reasonable
key-hygiene window.

## Goal

Cap stored secret age at 91 days. After that point, the server takes
one of three actions; this doc picks one for founder verdict.

## Open questions

### Q1. What happens at day 91 if the customer hasn't rotated?

| Option                                        | Behaviour                                                                                                                                                                                 | Customer impact                                                                                                                                                                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — Block delivery**                        | Worker stops dispatching to endpoints whose secret is > 91d. Deliveries pile up in `pending`; existing 50-consecutive-failures auto-disable fires after the retry budget.                 | Hard-stop — customer's webhook subscription effectively breaks until they rotate. Highest signal; some customers will be caught off-guard.                                                                                                               |
| **B — Auto-rotate server-side**               | At day 91 the cron mints a new secret + dual-signs for an extended grace window (e.g. 7 days). Customer fetches the new secret from `GET /v1/webhooks/:id`; the dashboard shows a banner. | Customer can keep receiving deliveries with the OLD secret during grace, but their HMAC stops verifying once grace expires (they need to update their verifier config before then). Same UX pressure as a manual rotation, just initiated by the server. |
| **C — Continue delivering, audit-log loudly** | Worker delivers as normal. Every delivery on an expired secret emits an audit-log row + a Sentry breadcrumb.                                                                              | No customer impact at the wire; relies on ops to escalate. Easiest to roll out, weakest enforcement.                                                                                                                                                     |

**Recommendation:** B — auto-rotate with a 7-day grace. Mirrors the
customer-initiated rotation UX (dual-sign window honoured by v2-#20)
but takes the rotation decision out of the customer's hands once the
hygiene cap is crossed. Pairs with an additional "rotation auto-fired,
fetch the new secret" email template.

### Q2. Grace window length for the auto-rotation

| Option | Grace                            |
| ------ | -------------------------------- |
| A      | 24h (same as customer-initiated) |
| B      | 7 days                           |
| C      | 30 days                          |

**Recommendation:** B — 7 days. Customer-initiated rotations are
typically followed by a same-day verifier-config update; server-initiated
auto-rotations need a buffer because the customer didn't pick the
timing. 7 days gives a weekly Ops review cycle on either side enough
runway. 30 days starts to undercut the hygiene value.

### Q3. Notification cadence post auto-rotation

| Option | Cadence                                              |
| ------ | ---------------------------------------------------- |
| A      | 1 email at rotation; no further nags                 |
| B      | 1 email at rotation; 1 email 24h before grace expiry |
| C      | Email at rotation + at grace expiry + 1d post-expiry |

**Recommendation:** B. Single rotation email is too easy to miss; the
24h-before-expiry nag is the last chance for the customer to update
their verifier without dropped deliveries. The post-expiry email
double-counts the failed-delivery alerts (50-consecutive-failures
already auto-disables + sends a separate notification).

### Q4. Opt-out for customers who explicitly want long-lived secrets

| Option | Mechanism                                              |
| ------ | ------------------------------------------------------ |
| A      | No opt-out — TTL is a hard floor                       |
| B      | Per-endpoint `disable_auto_rotation` flag (admin only) |
| C      | Per-account env-var-style override (deploy-side)       |

**Recommendation:** A. Opt-out paths get ignored in audit reviews and
become silent footguns; better to make the rotation universal + leave
the customer escape hatch as "manually rotate before day 91 to set a
fresh clock." Customers with HSM-managed secrets that can't be
rotated server-side should not have stored those secrets in the
Driftstack account in the first place; that's a separate enterprise-tier
conversation.

## Out of scope (until founder verdict lands)

- Implementation. Today's webhook-worker dual-sign fix (v2-#20) is the
  _infrastructure_ this policy would lean on; the policy is a separate
  configuration question.
- Migration for a new `disable_auto_rotation` column (gated on Q4=B).
- Email template `webhook-secret-auto-rotated` (gated on Q1=B).

## What ships today (independent of verdict)

The infrastructure is already in place — v2-#10.5 (reminder service),
v2-#17 (cron wire), v2-#20 (dual-sign worker fix). The missing piece
is purely the policy decision + a small auto-rotate timer.

## Append to `/tmp/orchestrator-pending-tier3.md`

```
## v2-#28 webhook secret server-initiated force-rotation (2026-05-18)

Doc: `docs/internal/v2-28-webhook-secret-force-rotation-design.md`

4 founder verdicts needed:

1. **Day 91 behaviour.** Block / auto-rotate / audit-log only.
   Recommendation: auto-rotate with grace (option B).
2. **Auto-rotation grace window length.** 24h / 7d / 30d.
   Recommendation: 7 days (option B).
3. **Post-rotation notification cadence.** Single / single+24h-before-
   expiry / triple. Recommendation: single+24h-before-expiry (option B).
4. **Per-endpoint opt-out flag.** None / per-endpoint / per-account.
   Recommendation: no opt-out (option A).
```
