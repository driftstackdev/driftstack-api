# Observability runbook (V-513)

How Driftstack instruments, monitors, and alerts on its production
control plane. Pre-launch reference; fills in alongside V-469
(per-service Sentry projects), V-289 (synthetic checks), V-474
(StatusBadge → /v1/status), V-494 (log + Sentry redaction).

This is operational, not customer-facing. The customer-facing
posture lives at `/security` (defense-in-depth) and `/trust/incidents`
(incident protocol).

## Layers + tools

| Layer            | Tool / signal                                   | Purpose                                         |
| ---------------- | ----------------------------------------------- | ----------------------------------------------- |
| Logs             | pino → stdout → journalctl on Hetzner           | Structured per-request log; redacted per V-494  |
| Errors           | Sentry (EU region: `ingest.de.sentry.io`)       | Exception capture + breadcrumb trail per V-116  |
| Synthetics       | V-289 healthchecks (every 60s)                  | Public-URL liveness against `/health`, `/ready` |
| Status surface   | `/v1/status` + StatusBadge (V-474)              | Customer-visible health state                   |
| Status site      | `apps/status-site/` (Cloudflare Pages)          | Long-form incident posts (V-477)                |
| Synthetic events | `test.ping` webhook (V-475)                     | Customer-side webhook handler verification      |
| DLQ              | `/v1/admin/webhook-dlq` + V-512 endpoint filter | Stuck-delivery triage from admin panel          |
| Load test        | `scripts/load-test/run.mjs` (V-495)             | Pre-launch baseline + regression check          |
| Audit logs       | `account_audit_log` + `admin_audit_log` (D-025) | Append-only customer + staff event trail        |

## Sentry project layout (V-469)

Per-service projects, all under the same EU region (`ingest.de.sentry.io`):

| Project                  | Source                     | Customer-impacting?        | Status (2026-05-15) |
| ------------------------ | -------------------------- | -------------------------- | ------------------- |
| `driftstack-server`      | `apps/server/`             | Yes — every API request    | live                |
| `driftstack-gui`         | `apps/gui-client/`         | Yes — desktop GUI errors   | live                |
| `driftstack-dashboard`   | `apps/customer-dashboard/` | Yes — dashboard UI errors  | live                |
| `driftstack-marketing`   | `apps/marketing-site/`     | Lower priority             | live                |
| `driftstack-docs`        | `apps/docs/`               | Lower priority             | live                |
| `driftstack-status-site` | `apps/status-site/`        | Yes — outage-time critical | live                |
| `driftstack-admin-panel` | `apps/admin-panel/`        | Internal-only              | live                |

Each project has its own DSN. Server-side DSNs are read via
`SENTRY_DSN` (the server only reports its own errors) at boot;
browser-bundled DSNs are injected at build time via repo secrets:

| Project                | Env var consumed                                     | GitHub secret                   |
| ---------------------- | ---------------------------------------------------- | ------------------------------- |
| driftstack-server      | `SENTRY_DSN` (on the api server's /etc env file)     | `SENTRY_DSN_SERVER`             |
| driftstack-dashboard   | `PUBLIC_SENTRY_DSN_<service>` (Astro build-time env) | `PUBLIC_SENTRY_DSN_DASHBOARD`   |
| driftstack-marketing   | `PUBLIC_SENTRY_DSN_<service>` (Astro build-time env) | `PUBLIC_SENTRY_DSN_MARKETING`   |
| driftstack-docs        | `PUBLIC_SENTRY_DSN_<service>` (Astro build-time env) | `PUBLIC_SENTRY_DSN_DOCS`        |
| driftstack-status-site | `PUBLIC_SENTRY_DSN_<service>` (Astro build-time env) | `PUBLIC_SENTRY_DSN_STATUS_SITE` |
| driftstack-admin-panel | `PUBLIC_SENTRY_DSN_<service>` (Astro build-time env) | `PUBLIC_SENTRY_DSN_ADMIN_PANEL` |

> Naming note: the api server reads `SENTRY_DSN`, but the GitHub
> secret is `SENTRY_DSN_SERVER` (disambiguated so a future
> `SENTRY_DSN_DASHBOARD` secret can't collide). The deploy workflow
> renames it as it pushes to the prod env file. `PUBLIC_*` DSNs are
> non-secret (browser-shipped), kept as `gh secret` for log-mask
> hygiene rather than confidentiality.

The validator in `apps/server/src/lib/config.ts:63` enforces
the EU region — DSNs without `.de.` or `.ingest.de.sentry.io`
are rejected at boot.

### Creating additional per-service projects

`scripts/sentry-create-per-service-projects.mjs` is the idempotent
wire-up — runs against the org's Sentry API, creates missing projects,
captures DSNs, prints JSON. Edit the `PROJECTS` array, then:

```sh
SENTRY_AUTH_TOKEN=<1Password / Sentry CI token> \
  node scripts/sentry-create-per-service-projects.mjs
```

DSNs are PUBLIC (safe to expose in browser bundles + commit log); the
auth token is the secret that must stay out of repo / commit message /
shell history file.

## Alert rules (per-project recommended)

Set via Sentry Alerts → Issue Alerts. Configurations recommended
pre-launch (founder reviews and adjusts post-first-customer
based on noise vs signal):

### `driftstack-server` (highest signal-to-noise)

| Rule                       | Trigger                                                          | Action                                    |
| -------------------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| `*.fatal` events           | Any new event tagged `level:fatal`                               | Page founder phone immediately (P-0 §5.2) |
| Error spike — auth path    | >10 `level:error` events in 5min on `/v1/auth/*`                 | Slack #alerts (P-1 within 30min)          |
| Error spike — billing path | >5 `level:error` events in 5min on `/v1/billing/*`               | Slack #alerts                             |
| Stripe webhook failures    | >3 `level:error` events in 1min from `routes/webhooks-stripe.ts` | Slack #alerts                             |
| New issue type             | Any new issue (regression detection)                             | Slack #alerts daily digest                |

### `driftstack-customer-dashboard`

| Rule                  | Trigger            | Action        |
| --------------------- | ------------------ | ------------- |
| Hydration error spike | >10 events in 5min | Slack #alerts |
| New issue type        | Any new issue      | Daily digest  |

### `driftstack-status-site`

Higher sensitivity because if the status site itself is broken
during an incident, customers can't see what's happening:

| Rule      | Trigger           | Action       |
| --------- | ----------------- | ------------ |
| Any error | >0 events in 5min | Page founder |

## Synthetic checks (V-289)

**Not wired yet (V-289 open).** No synthetic-check module exists in the
repo — the in-process health probe (`apps/server/src/services/health-probe.ts`)
covers the API targets below, and nothing polls the static sites. The table is
the intended configuration for whichever external uptime provider V-289
selects, not a description of something running today:

| Target                                 | Interval | Timeout | Failure threshold    |
| -------------------------------------- | -------- | ------- | -------------------- |
| `https://api.driftstack.dev/health`    | 60s      | 5s      | 2 consecutive → page |
| `https://api.driftstack.dev/ready`     | 60s      | 10s     | 2 consecutive → page |
| `https://api.driftstack.dev/v1/status` | 60s      | 5s      | 2 consecutive → page |
| `https://app.driftstack.dev`           | 5min     | 10s     | 1 failure → Slack    |
| `https://docs.driftstack.dev`          | 5min     | 10s     | 1 failure → Slack    |
| `https://driftstack.dev`               | 5min     | 10s     | 1 failure → Slack    |
| `https://status.driftstack.dev`        | 60s      | 5s      | 2 consecutive → page |

Synthetic check fails route through the same P-0 channels as
Sentry fatals (per `docs/runbooks/incidents.md` §5.2).

## Load-test cadence (V-495)

The `scripts/load-test/run.mjs` harness runs against any of the
named targets. Cadence post-launch:

| When                          | Target                   | Retain baseline?        |
| ----------------------------- | ------------------------ | ----------------------- |
| Pre-deploy of new version     | staging — `/v1/status`   | Compare to last         |
| Weekly                        | production — read-only   | Append to baselines     |
| Quarterly                     | production — write paths | Append + compare to Q-1 |
| After any architecture change | both                     | Mandatory               |

The harness refuses to mutate production without explicit
`--i-know-what-im-doing=true` per V-495's safety rails. Append
baselines under `docs/load-test/baselines/<date>-<target>.json`.

## DLQ triage workflow

Webhook deliveries that exhaust their retry budget land in the
DLQ. Two admin paths:

1. **Per-customer triage** — V-512 `endpoint_id` filter:

   ```
   GET /v1/admin/webhook-dlq?endpoint_id=webhook_endpoint_<uuid>
   ```

   Pulls just that endpoint's stuck deliveries — useful when a
   customer reports "endpoint X is missing events."

2. **Cross-account triage** — no filter:
   ```
   GET /v1/admin/webhook-dlq
   ```
   Shows everything stuck. Useful when investigating a systemic
   issue (e.g. a target host that lots of customers point at went
   down).

Replay vs requeue:

- `POST /v1/admin/webhook-deliveries/:id/replay` — works on
  delivered + dlq + failed states. Records as
  `webhook_delivery.replayed` in the admin audit log.
- `POST /v1/admin/webhook-dlq/:id/requeue` — works on DLQ only;
  409 if not in DLQ. Records as `webhook_delivery.requeued`. The
  distinction makes the audit log readable: replay = "we asked
  for this to be re-sent on purpose"; requeue = "this got stuck
  because something temporary."

## Audit-log retention

Pre-launch posture (per V-498 audit closure):

- `account_audit_log` — append-only; no deletion mechanism;
  customer-export via `GET /v1/account/audit-log/export`
  (V-297). Retention policy not yet locked; archive cadence
  V-163-pattern queued for post-launch.
- `admin_audit_log` — same shape; staff-only read.

Both tables are RPO-zero from the DR runbook's Scenario 2 PITR
recovery posture.

## Per-service Sentry env vars

Required at boot (per `apps/server/src/lib/config.ts`):

- `SENTRY_DSN_SERVER` — server project DSN
- `SENTRY_ENVIRONMENT` — `production` / `staging` / `development`
- `SENTRY_TRACES_SAMPLE_RATE` — 0..1 (default 0)
- `SENTRY_RELEASE` — git SHA, set by deploy pipeline

Customer-dashboard / marketing-site / docs / status-site each
load their own DSN at build time via Astro's `import.meta.env`.

## Deploy-state cron (V-549.B follow-up)

Wire `deploy-status --quiet --check` into cron for an out-of-band
alert if a server restart loses an activation flag (rare but the
exact class of regression the 4-flag check exists to catch), or if
the running build drifts far behind HEAD (not rare — prod sat 982
commits behind for a month before anyone noticed, because nothing
judged the SHA the snapshot had been printing all along):

```cron
# Every 5 minutes, exit non-zero on any of the 4 --check refusals:
# an activation flag off, migration drift, the running build more
# than DEPLOY_MAX_BEHIND commits behind HEAD, or a running SHA this
# checkout cannot resolve. Pipe to your alert channel of choice.
# NOTE: this is a RECOMMENDATION, not a wiring — nothing in the repo
# invokes --check on a schedule today.
*/5 * * * * cd /opt/driftstack-api && bash scripts/deploy-status.sh --quiet --check || curl -s -X POST $SLACK_WEBHOOK -d '{"text":"deploy-status --check FAILED"}'
```

For dashboards: `bash scripts/deploy-status.sh --json | jq …`
emits stable JSON shape per env (git_sha + started_at + uptime

- last_good_sha + recent_deploys[]). Runbook:
  `docs/runbooks/deploy-bridge.md`.

## Cross-references

- DR procedures: `docs/deployment/dr-runbook.md`
- Incident triage: `docs/runbooks/incidents.md`
- Launch-day playbook: `docs/operations/launch-day-runbook.md`
- Customer-facing security: `apps/marketing-site/src/pages/security.astro`
- Deploy + revert + status tooling: `docs/runbooks/deploy-bridge.md`
