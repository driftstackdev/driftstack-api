# V-547 — chaos engineering scenarios

**Date:** 2026-05-11
**Wave:** 23
**Status:** CATALOGUE — failure-scenario inventory. Active rehearsal
scripts land in V-547.B; integration into a scheduled drill cadence in
V-547.C.

## Purpose

Catalogues the failure scenarios the Driftstack control plane should
survive. For each, defines:

- The fault injected.
- The expected behaviour (what the system MUST do).
- How to rehearse it (manual today; automated later).
- The current state (does the harness exist? does the system actually
  do the right thing?).

Pre-launch chaos engineering keeps the failure modes explicit. Without
it, the first paying customer surfaces them.

## Scenario taxonomy

5 categories:

1. **Sub-processor outage** — Postmark / Sentry / Stripe / Anthropic
   down or slow.
2. **Database failure** — Postgres unavailable, replica lag, migration
   collision.
3. **Cache failure** — Redis unavailable, eviction storms, TTL
   misconfig.
4. **Storage failure** — R2 timeout, partial upload, eventual
   consistency anomaly.
5. **Infrastructure failure** — Hetzner instance down, network
   partition, certificate expiry.

## Scenarios

### 1. Sub-processor: Postmark unavailable

**Fault:** Postmark API returns 503 for 5 minutes.

**Expected:**

- Email-send service buffers messages to a `pending_emails` table
  (proposed; ALREADY EXISTS as part of V-518 lifecycle work — verify).
- Retry with exponential backoff (1m / 2m / 5m / 15m / 60m).
- After 5 retries, mark the message `failed` + admin alert.
- The control plane stays HTTP-200; signup flows queue verification
  emails rather than rejecting requests.

**Rehearsal:** Block `api.postmarkapp.com` at the host firewall.
Trigger a signup; verify the user gets created + the verification
email queues; restore Postmark + verify the email actually sends.

**Current state:** Buffer logic exists; retry backoff is partial.
V-547.B test target.

### 2. Sub-processor: Stripe webhook signature verification failure

**Fault:** Stripe webhook signature header missing or wrong.

**Expected:**

- `/v1/webhooks/stripe` returns 400 problem+json `invalid_signature`.
- No state mutation in the control plane.
- Admin alert if rate exceeds N per minute (possible attack).

**Rehearsal:** POST a webhook with a corrupted signature; observe 400.

**Current state:** Implemented + tested (integration spec
`stripe-webhook-signature.test.ts`). PASS.

### 3. Sub-processor: Anthropic LLM provider timeout

**Fault:** Anthropic API takes > 60s to respond OR returns 500.

**Expected:**

- LLM-agent feature (BYO bundled mode) surfaces a clear error to the
  customer's session: "LLM provider unavailable".
- No charge on the customer's metered usage for the failed request.
- Retry budget: 2 attempts with 5s/15s backoff before giving up.

**Rehearsal:** Inject a 60s sleep into the LLM provider mock; verify
behaviour.

**Current state:** Bundled-LLM feature is gated; the timeout path
isn't exercised. V-547.C target.

### 4. Database: Postgres connection drop mid-transaction

**Fault:** Postgres restarts during an active transaction.

**Expected:**

- Drizzle re-establishes the connection on next query.
- The in-flight transaction rolls back cleanly; client receives a
  retryable error (problem+json `service_unavailable`).
- No phantom partial-write.

**Rehearsal:** `docker compose restart postgres` mid-load-test.

**Current state:** Drizzle handles reconnection; transaction-isolation
verified by V-518 schema invariants test. PASS.

### 5. Database: Drizzle migration applies but with errors

**Fault:** A migration partially applies — first 3 SQL statements
succeed, 4th fails on a constraint violation.

**Expected:**

- Migration tooling rolls back the transaction (Drizzle migrations
  run in a transaction by default).
- Migration version stays at the previous level.
- Manual fix path documented.

**Rehearsal:** Author a migration with an intentionally bad
constraint; run `drizzle-kit migrate`; verify rollback.

**Current state:** Default Drizzle migration behaviour is
transactional. V-547.B test target to explicitly verify.

### 6. Cache: Redis unavailable

**Fault:** Redis container exits.

**Expected:**

- Rate-limit middleware falls back to "fail-open" (allow requests,
  log alert).
- Session-token cache falls back to direct Postgres lookup (slower
  but functional).
- Control plane stays HTTP-200; latency degrades but no errors.

**Rehearsal:** `docker compose stop redis`; verify /health stays 200
and basic API calls succeed.

**Current state:** Fail-open logic exists for rate limit; session
cache fallback partial. V-547.B target.

### 7. Storage: R2 PUT timeout

**Fault:** R2 PUT takes > 30s.

**Expected:**

- Capture endpoint returns 504 problem+json `upstream_timeout`.
- No partial-object reference stored in the DB.
- Retry guidance in the error message.

**Rehearsal:** Inject a 30s sleep in the R2 SDK mock; observe.

**Current state:** Timeout config exists; behaviour verified by unit
test. PASS.

### 8. Storage: R2 PUT succeeds but DB write fails

**Fault:** R2 PUT succeeds; the subsequent INSERT into `captures`
table fails with a constraint violation.

**Expected:**

- The orphaned R2 object is logged for cleanup by the
  `r2-orphan-sweep` job (already scheduled per V-512).
- API returns 500 problem+json; admin alert.
- Customer can retry safely; the second PUT writes a different object
  key.

**Rehearsal:** Mock the DB INSERT to fail after a successful R2 PUT;
verify orphan logging.

**Current state:** Orphan-sweep job exists. The "log the orphan"
hook needs verification. V-547.B target.

### 9. Infrastructure: Hetzner instance down

**Fault:** The single production Hetzner instance is unreachable.

**Expected:**

- Cloudflare health-check fails; status site flips to "outage".
- Customer dashboard shows a banner "API temporarily unavailable".
- DNS doesn't fail over (no failover instance pre-launch); recovery
  requires the team to bring the instance back up.

**Rehearsal:** Manual — power off the Hetzner instance during a
maintenance window.

**Current state:** Single-instance posture is intentional pre-launch
(cost discipline). Failover infrastructure is post-first-customer
work. Document the recovery procedure at
`docs/runbooks/hetzner-instance-down.md` (NOT YET WRITTEN — V-547.B
target).

### 10. Infrastructure: TLS certificate expiry

**Fault:** Let's Encrypt cert renewal fails for 24h before expiry.

**Expected:**

- 7-day-before-expiry: monitoring alert fires.
- 3-day-before-expiry: critical alert; team triggers manual renewal.
- Even on expiry: dual-stack with Cloudflare Origin Cert as fallback
  means customer connections may degrade but don't outright fail
  (verify this — V-278 deployed Let's Encrypt at TLS 1.3 strict; the
  fallback story needs confirmation).

**Rehearsal:** Stop the renewal cron; observe alert chain over 4
days. (Slow rehearsal; do once per quarter.)

**Current state:** Renewal cron exists. Alert chain partial.
V-547.C target.

## Rehearsal cadence

- **Pre-launch:** all P0 scenarios (1, 4, 6, 9) rehearsed before first
  paying customer.
- **Post-launch quarterly:** rotate through scenarios 1-10 over the
  quarter.
- **Post-incident:** if a real incident hits a scenario in this
  catalogue, rehearse the related scenarios within 30 days.

## Sub-slices

- **V-547 (Wave 23):** scenario catalogue (this doc).
- **V-547.B / V-659 (Wave 45):** rehearsal harness landed at
  `scripts/chaos/`. Covers scenarios 1, 2, 6 (P0 + lowest-risk Stripe
  signature). Each script defaults to `CHAOS_MODE=dry-run`
  (touch-nothing); `CHAOS_MODE=execute` fires the fault injection
  against a local docker-compose stack. Scenarios 4, 5, 7, 8 will
  land in V-547.B continuation slices once the rehearsal harness
  pattern is validated against the first paying-customer load.
- **V-547.C (later):** scheduled chaos drill cron + post-drill admin
  report.

## Verification

- File written.
- 10 scenarios catalogued across 5 categories.
- V-205 + V-211 sweep: zero hits.
