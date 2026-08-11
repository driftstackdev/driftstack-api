# Driftstack API — operational runbook

Drafted V-195 as the standing baseline for incident response and ops
plays. Pre-launch — most procedures are forward-looking until real
production traffic exists; the structure is in place so an incident
in the first weeks of paid traffic doesn't catch us flat-footed.

> **Status**: pre-launch. Everything in `[TODO]` is a known gap and
> should be filled before the first paying customer (see AGENTS.md
> "publish vs commercial activation" — commercial activation is gated
> on entity registration, but ops infra needs to be ready when that
> gate opens).

## Quick triage

When something looks broken:

1. **Hit `/version` on the prod host** — confirm which build is running.
2. **Hit `/ready`** — every readiness check (postgres, redis, r2 if
   configured) reports `ok` + latency. A `503` means at least one
   dependency is unreachable; the response body names the failing
   dep.
3. **Check Sentry** — error rate spike + most-frequent message.
4. **Check Pino logs** (Hetzner journalctl or wherever the server
   stdout is captured) — last 200 lines around the spike timestamp.
5. **Check Stripe dashboard** — webhook deliveries and subscription
   state if billing-related.

## Known endpoints for ops

| Path                | Auth | Purpose                                                     |
| ------------------- | ---- | ----------------------------------------------------------- |
| `GET /health`       | none | liveness — returns `{ ok: true }` always                    |
| `GET /healthz`      | none | alias of `/health`                                          |
| `GET /ready`        | none | readiness — 200 if every check passes, 503 otherwise        |
| `GET /version`      | none | build version + git sha + started_at + node version         |
| `GET /v1/status`    | none | aggregate readiness — operational / degraded / major_outage |
| `GET /openapi.json` | none | spec                                                        |
| `GET /docs/`        | none | Scalar UI                                                   |

## Standard incidents

### Postgres unreachable

Symptoms: `/ready` returns 503 with `postgres` failing.

1. Confirm Neon is up (status.neon.tech).
2. Check `DATABASE_URL` env didn't get rotated without restart.
3. If transient, restart the server (Hetzner systemd restart).
4. If persistent, switch read traffic to a Neon branch if available;
   surface customer impact.

### Redis unreachable

Symptoms: `/ready` returns 503 with `redis` failing. Auth still works
because the in-process auth cache mirrors a 30s TTL window — but
rate-limit consume may degrade.

1. Confirm Upstash is up (status.upstash.com).
2. Validate `REDIS_URL` connectivity from Hetzner host.
3. Restart if transient.
4. **[TODO]** Document graceful-degradation posture for rate limiting
   when Redis is down (open: do we open the buckets, close them, or
   revert to memory-store?).

### Stripe webhook delivery failures

Symptoms: customers paying but subscription state not updating.

1. Stripe Dashboard → Webhooks → look at recent delivery attempts.
2. Check audited Stripe webhook table: `processed_stripe_events`
   row should exist with the event_id.
3. Replay the failed delivery from Stripe Dashboard.
4. If signature verification is failing, the webhook signing secret
   in `STRIPE_WEBHOOK_SECRET` is out of sync with the
   Dashboard endpoint config — rotate via Hetzner SSH-write per
   the locked stripe-credential-handling memory.

### DLQ growth (webhook deliveries to customer endpoints)

Symptoms: admin /webhook-dlq page shows growing queue, customer
reports missing notifications.

1. Open admin /webhook-dlq (admin.driftstack.dev/webhook-dlq).
2. Inspect last_error column — usually `connect ECONNREFUSED` or
   `HTTP 5xx`.
3. If transient (5xx burst from a customer's endpoint that's now
   recovered), use Requeue.
4. If persistent (DNS gone, customer endpoint is dead), reach out
   to customer; do not silently retry forever.

### Account abuse / leaked key

1. Admin /api-keys page — find the key by prefix or account id.
2. Click Revoke — reason field is required and is logged + surfaced
   to the customer.
3. If broader sweep needed (multiple keys across an account), use
   the per-account detail page Suspend button.

## Restore + DR

For full disaster-recovery scenarios (Hetzner host loss, Postgres
corruption, R2 loss, compromised key, bad deploy) see the dedicated
DR runbook: `docs/deployment/dr-runbook.md`. The DR doc covers seven
scenarios with RTO/RPO targets, recovery sequences, and a pre-launch
dry-run checklist.

This document focuses on the routine triage flow — ops scenarios that
are recoverable without invoking the DR procedures.

## Migration rehearsal

Every Drizzle migration that runs against a non-empty production
table follows the standing rehearsal sequence in
`docs/deployment/migration-rehearsal.md`. Pre-launch (empty prod) the
checklist is skipped and migrations land directly per push-to-main.

## Standing observability

- **Pino structured logs** — JSON to stdout; Hetzner journalctl ships
  to whatever observability sink is configured (`[TODO]` configure
  Sentry breadcrumbs for severe errors).
- **Sentry** — server errors auto-reported; trace IDs included in the
  Pino log line via `request.id`.
- **Stripe Dashboard** — payment + subscription events; webhook
  delivery failures surface here first.
- **Cloudflare** — origin-shield + DNS; status.cloudflare.com.

## What to do if you can't reach the founder

This is a solo operation pre-launch. If a decision needs to be made
that exceeds routine triage (customer-facing communication, rolling
back a migration, suspending an account suspected of abuse, ANY
financial action), wait for the founder to authorize. Document the
issue, take read-only diagnostic steps, and surface for explicit
approval per the locked decision-authority policy in AGENTS.md.

## Log-handling — PII posture

V-249 / V-246-P1-002 — operationally Pino logs may contain customer
PII (email addresses) for the following intentional cases:

- `magic-link requested for unknown email` — `auth-flows.ts` line ~406. Logged at `info` so abuse patterns (enumeration attempts, password-spray scout traffic) are visible.
- `magic-link suppressed — account not active` — `auth-flows.ts` line ~412. Logged at `info` for the same reason.
- `password-reset requested for unknown email` — same shape, same posture.

**Posture for log sharing:**

- Raw Pino logs from production are Driftstack-internal-only. Don't share with non-Driftstack-staff (customers, support contractors) without scrubbing.
- If a customer asks for "the logs related to my account," the audit-log surface (`/v1/account/audit-log`, V-216) is the customer-facing equivalent. Send that, not raw Pino output.
- Sentry breadcrumbs are scrubbed at emit time (V-242 `beforeSend` for the GUI client; existing apps/server Sentry config strips request bodies). Sentry is safe to share with customer support if needed for a specific incident, with founder approval.

**Long-term mitigation:** IP-based rate limiting on auth endpoints (V-246-P1-004, post-launch) reduces the operational need for email-level PII logging. When that lands, the email can be replaced with a hash + IP.
