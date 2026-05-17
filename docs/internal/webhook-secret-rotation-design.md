# Webhook signing-secret rotation policy (v2-#10)

**Status:** SHIPPING the documented Stripe-pattern defaults (90d TTL

- 5min replay window) plus a per-endpoint `secret_created_at` column
  that drives the rotation reminder. 2 open questions surfaced for
  founder verdict (TTL fixed-vs-configurable + replay-window
  fixed-vs-configurable); both default to fixed pending verdicts.

**Trigger:** v2-#10 queue item. Existing V-359 24h grace-period
rotation infrastructure (migration 0034) already supports the
dual-signature emission; this slice adds the policy + reminder
surfacing on top.

**Date staged:** 2026-05-18.

## What's already shipped (V-359 baseline)

- `webhook_endpoints.secret` + `secret_prev` + `secret_prev_expires_at`
  columns. Customer rotates → old secret moves to `secret_prev` with
  24h expiry; outbound deliveries sign with BOTH for 24h.
- POST /v1/webhooks/:id/rotate-secret returns the new plaintext once.
- SDK `verifyWebhookSignature` accepts the second header
  (`x-driftstack-signature-prev`) during grace.
- SDK enforces a 300s (5 min) replay window by default
  (`DEFAULT_TOLERANCE_SEC`); customers override via `toleranceSec` arg.

## What v2-#10 adds

Two policy surfaces:

1. **Active-secret TTL = 90 days** (Stripe pattern). When
   `secret_created_at` is more than 90d old, the dashboard shows a
   banner + we send an email. NOT auto-rotated (customer-controlled
   action; we just nag).
2. **Replay-window default DOCUMENTED at 300s** with rationale +
   override path. No code change here — the SDK already does it.

### Migration (0048)

```sql
ALTER TABLE webhook_endpoints
  ADD COLUMN secret_created_at timestamptz NOT NULL DEFAULT now();
```

Backfill: existing rows get `now()` at migration time. This means
existing endpoints "look fresh" at migration, which is the
conservative answer (don't fire a wave of "rotate now" emails the
moment we deploy).

POST /v1/webhooks (create) sets `secret_created_at = now()` on the
new row. POST /v1/webhooks/:id/rotate-secret resets it to `now()`
on rotation (the new secret is fresh; the prev is in `secret_prev`).

### Rotation reminder schedule

When `secret_created_at` is between 60d and 90d, the dashboard
endpoint banner shows "Your webhook secret is X days old; rotate
before <90d-date>" with a one-click rotate button.

When `secret_created_at` exceeds 90d, the banner becomes red, and
a reminder email fires (idempotent on `secret_created_at` + a
sent-at audit). No auto-rotate — that would surprise customers
mid-delivery; we wait for explicit customer action.

The reminder email + banner threshold pieces fit V-218 (scheduled
job runner) + existing email infrastructure (Postmark wired). The
scheduled job runs once daily, queries
`webhook_endpoints WHERE secret_created_at < now() - 60d AND
last_reminder_sent_at IS NULL OR last_reminder_sent_at < now() - 7d`,
and fans out reminder emails.

(Adding the `last_reminder_sent_at` column in the same migration so
the reminder service has a place to dedupe.)

## Founder verdicts needed

### Question 1: TTL fixed vs customer-configurable

- A. 90d hard default, NOT customer-configurable. Drives a uniform
  security posture across the customer base. Matches Stripe.
- B. 90d default; per-endpoint customer-configurable (30d-365d).
  Trades a small UI surface for letting enterprise customers
  align with their internal rotation policies.

**Recommendation + DEFAULT for this slice:** A (fixed 90d).
Configurable per-endpoint is a v1.1+ enterprise feature; for v1.0
we lock the policy.

### Question 2: Replay-window default fixed vs customer-configurable

- A. 300s (5 min) hard default in SDK; customer overrides via
  `toleranceSec` arg per-call. (CURRENT BEHAVIOR.)
- B. Account-level setting that propagates to the SDK via a config
  endpoint (`GET /v1/account/webhook-policy`). Customer can lower
  to 60s for higher-security postures or raise to 3600s if their
  infra has clock-skew issues.

**Recommendation + DEFAULT for this slice:** A (per-call override).
Customers who need lower tolerance can pass `toleranceSec: 60`;
customers who need higher tolerance pass `toleranceSec: 600`.
Account-level config is a v1.1+ enterprise feature.

## Implementation arc

1. **Migration 0048** — adds `secret_created_at` + `last_reminder_sent_at`
   columns to `webhook_endpoints`.
2. **Drizzle schema** — both columns.
3. **WebhooksService** — populate `secret_created_at` on create +
   rotate.
4. **Dashboard banner** — `apps/customer-dashboard/src/pages/webhooks/[id].astro`
   reads the value + renders the appropriate banner state.
5. **Daily reminder job** — `apps/server/src/jobs/webhook-rotation-reminder.ts`
   plus email template addition.
6. **Docs** — `apps/docs/src/content/docs/webhooks/security.mdx`
   documents the 90d recommendation + 5min replay window default.

This slice ships piece 1-3 + the schema scaffolding for 4-5. The
daily reminder job + banner UI ride as a v2-#10.5 follow-up since
those touch the scheduled-job + dashboard surfaces. Continuing per
the strategic directive ("CONTINUE to wiring after writing doc").

## References

- V-359 rotation grace-period: migration 0034
- V-218 scheduled-job runner: existing infrastructure pattern
- SDK verifier: `packages/sdk-typescript/src/webhook-signature.ts`
  (TS), `packages/sdk-python/src/driftstack/webhook_signature.py`
  (Python), `packages/sdk-go/webhook_signature.go` (Go)
- Postmark email transport: memory `project_postmark_approved`
