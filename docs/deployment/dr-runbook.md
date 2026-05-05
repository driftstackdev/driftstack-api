# Disaster recovery runbook

V-199 — standing procedures for recovering from the data-loss /
service-loss / dependency-loss scenarios that warrant more than the
quick-triage flow in `docs/deployment/runbook.md`. Pre-launch this
doc is forward-looking; every procedure is rehearsable on a Neon
branch + a throwaway Hetzner host before commercial activation.

## Scope + posture

DR is not the same as "the API returned a 500." Use the operational
runbook (`runbook.md`) for transient incidents. Reach for this doc
only when one of the scenarios below has materialised:

- Production data corrupted or partially deleted.
- A sub-processor (Neon, Upstash, Cloudflare, Stripe) had a
  regional or platform-wide outage long enough to require a
  contingency plan.
- A signing key, secret, or credential leaked.
- The Hetzner host was compromised, lost, or the deployment
  pipeline force-pushed broken code that's now in production.

> **Before commercial activation**: every scenario is recoverable
> with no customer impact (no customers exist). Use the pre-launch
> period to dry-run every procedure below.

## Recovery time + point objectives

These are aspirational targets, not contractual SLAs (we don't have
SLAs pre-launch and post-launch SLAs will be set per-tier).

| Class                             | RTO     | RPO     |
| --------------------------------- | ------- | ------- |
| Hetzner host loss                 | < 30min | 0       |
| Postgres logical corruption       | < 2hr   | < 5min  |
| Postgres / Neon platform outage   | < 4hr   | < 5min  |
| Redis loss                        | < 5min  | n/a     |
| R2 object loss                    | varies  | depends |
| Compromised signing key / secret  | < 30min | n/a     |
| Bad deploy of broken code to prod | < 15min | 0       |

RPO for Postgres is bounded by Neon's point-in-time history retention
(default 7d on Pro tier; verify post-launch). Redis is ephemeral —
RPO is not meaningful; we tolerate cache loss.

## Scenarios

### Scenario 1 — Hetzner host loss

The control-plane host is gone (hardware failure, accidental delete,
DNS hijack). Code + DB intact (Neon is separate; code is in git).

1. Provision a new Hetzner host from the Hetzner control panel.
2. Run the deploy automation (which lives in `[TODO]` — currently
   manual; document the scripted version once it exists).
3. SSH-write the prod .env (Stripe keys, signing secrets, Postmark
   token, etc.) per the locked stripe-credential-handling memory
   and the operational register.
4. Confirm `/health` returns 200 + `/ready` returns 200 with all
   readiness checks green.
5. Cut DNS (Cloudflare) to the new host.
6. Confirm `/v1/version` reports the expected git SHA on the new
   host.

### Scenario 2 — Postgres logical corruption

A bad migration, an admin SQL fat-finger, or an unintended
application write corrupted production data. Neon is healthy.

1. Identify the recovery target time (the latest timestamp where
   data is known good — usually pre-incident).
2. Neon dashboard → create branch from point-in-time at the target.
3. Spin up the server pointed at the branch (locally or on a
   throwaway host) and verify customer-facing invariants:
   - Every active subscription has a `stripe_customer_id`.
   - Every non-destroyed session has a valid `account_id`.
   - `processed_stripe_events` row count is sane (no missing
     audited events).
4. **Decide the recovery path** — there are two:
   - **Cut over to the branch** (fast; loses everything that
     happened post-incident-time). Update `DATABASE_URL` on the
     prod host, restart server.
   - **Surgical patch** (slow; preserves post-incident writes).
     Hand-craft SQL to reverse the corrupting writes against
     production directly. Risky; only for narrow corruption
     scopes.
5. Notify affected customers via Postmark with what happened, what
   we restored, and any data that was lost (post-incident writes
   if cut-over path was chosen).

### Scenario 3 — Postgres / Neon platform outage

Neon itself is unreachable region-wide. We have no Postgres-side
replica today (single-region Neon project).

1. Confirm scope on status.neon.tech.
2. Surface customer-facing comms: a static "We're tracking a
   provider incident" page on `status.driftstack.dev` (powered by
   `/v1/status`) — verify the status endpoint reports `degraded`
   (it will, if the postgres readiness check fails).
3. Wait for Neon recovery; we don't have a hot fallback.
4. Post-incident: open the question of multi-region Neon vs.
   self-hosted Postgres replica. **[TODO]** decision pre-launch
   if Neon platform stability becomes a concern; for now the
   single-region Neon is the operational baseline.

### Scenario 4 — Redis (Upstash) loss

Auth cache + rate-limit token buckets are in Redis. Loss is
disruptive but recoverable: auth path falls back to Postgres
(slow path), rate-limits start fresh from tier defaults.

1. Confirm scope on status.upstash.com.
2. If Upstash is up but our cluster is gone (deleted, region
   migrated, etc.): provision a new cluster, update `REDIS_URL`,
   restart server.
3. **No data loss procedure required** — both auth cache and
   rate-limit buckets are inherently regenerable. Customer impact
   is increased latency on cold auth + rate-limit window resets.

### Scenario 5 — R2 object loss

Audit archives + recording mirrors live on R2. Cloudflare R2 is
durable per their published spec; corruption / deletion at the
infrastructure layer is extraordinarily rare. Application-level
delete is the realistic risk.

1. Determine what's lost (single object, prefix, bucket).
2. **Recoverability depends on the data class**:
   - **Audit archives**: Postgres has the source-of-truth audit
     row; the R2 archive is an immutability mirror. If the R2
     copy is lost, re-archive from Postgres via the `archive_runs`
     workflow (V-172).
   - **Session recordings**: R2 is the source of truth (per
     ADR-006). A lost recording is gone unless it was within the
     90-day hot retention in Postgres-shaped session_events table
     and can be re-rendered. Treat as best-effort recovery.
3. Customer comms: only required if recordings are lost. Audit
   archives are internal.

### Scenario 6 — Compromised signing key / secret

A `STRIPE_WEBHOOK_SIGNING_SECRET`, scrypt secret, JWT key, or
similar leaked (committed to a public repo, found in a screenshot,
suspected via abuse signals).

1. **Rotate at the upstream first** to invalidate the old credential.
   For Stripe webhook secret: Dashboard → Webhooks → endpoint →
   "Roll signing secret". For Anthropic key: console.anthropic.com →
   API keys → revoke. For Postmark: server token → rotate.
2. SSH-write the new secret to the prod .env per the operational
   register.
3. Restart server.
4. Audit the period the old secret was live for any unauthorized
   activity (in Stripe dashboard for webhook signing; in our
   `processed_stripe_events` for replays under the old secret;
   etc.).
5. If the leak might've enabled customer impersonation (API key
   leak): force-revoke + reissue affected keys via admin /api-keys
   page (V-193).
6. Document the incident + post-mortem in a new file at
   `docs/incidents/YYYYMMDD-<short-name>.md`. **[TODO]** — incidents/
   directory will exist once needed; pre-launch we have no incidents.

### Scenario 7 — Bad deploy of broken code to prod

A push to main shipped broken code that's now serving 5xx to
customers.

1. **Confirm the bad deploy** via `/v1/version` — git SHA matches
   the suspected-bad commit.
2. **Roll back via git revert + redeploy**, NOT via destructive
   `git reset --hard`. Push the revert commit; the deploy
   automation runs.
3. Confirm `/v1/version` reports the revert SHA.
4. Confirm `/ready` returns 200 + all checks green.
5. Customer-facing comms: only if the broken deploy lasted long
   enough to be customer-noticeable (>5min of sustained 5xx) or
   if customer data was visibly affected.
6. Open a fix branch + land the underlying issue properly. Don't
   hot-fix in prod by hand-editing files on the Hetzner host —
   that drift will burn the next deploy.

## Cross-cutting principles

- **Never reach for `git reset --hard` or `git push --force` to
  resolve a deploy incident**. Always revert + push forward. The
  cost of a bad force-push compounds (downstream consumers,
  caches, the next engineer trying to debug).
- **Every credential rotation goes through the operational
  register** — never paste a secret in chat or commit messages.
- **Every customer-facing recovery action requires a customer
  comms step**. Engineering recovery without customer
  notification is incomplete.
- **Document every DR action** — append to a new file under
  `docs/incidents/YYYYMMDD-<name>.md` with: timestamps, what was
  observed, what was decided, what was done, what we'd do
  differently next time.

## Pre-launch dry-run checklist

Before commercial activation:

- [ ] Scenario 1 (Hetzner loss) — provision a fresh host; deploy
      from clean state; confirm `/health` + `/ready`. Tear down.
- [ ] Scenario 2 (PG corruption) — create a Neon branch from a
      point-in-time; spin up the server against it; verify it
      serves traffic.
- [ ] Scenario 4 (Redis loss) — kill the Upstash connection
      mid-request; confirm graceful degradation (no crashes, auth
      still works via slow path).
- [ ] Scenario 5 (R2 loss for audit archive) — delete a test
      archive object; re-run the archive workflow; confirm
      reconstruction from Postgres source.
- [ ] Scenario 6 (key rotation) — rotate the Stripe webhook
      signing secret in test mode; confirm verifier rejects the
      old secret + accepts the new.
- [ ] Scenario 7 (bad deploy) — push a deliberate breaking change
      to a deploy-target branch (NOT main); revert; confirm the
      rollback returned the prod-shape host to known good.

Each dry-run gets a V-log entry confirming "rehearsed YYYY-MM-DD,
RTO observed, gaps surfaced".

## Related

- Operational runbook (incident triage): `docs/deployment/runbook.md`
- Migration rehearsal: `docs/deployment/migration-rehearsal.md`
- Stripe webhook procedures: `docs/deployment/stripe-webhook-testing.md`
- Env-var schema: `docs/deployment/env-vars.md`
