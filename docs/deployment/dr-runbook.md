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
| Origin TLS certificate failure    | < 1hr   | n/a     |

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
6. Confirm `/version` (NOT `/v1/version` — this endpoint is
   unversioned) reports the expected git SHA on the new
   host.

### Scenario 2 — Postgres logical corruption (Neon PITR)

A bad migration, an admin SQL fat-finger, or an unintended
application write corrupted production data. Neon is healthy.

**Concrete recovery commands** (V-496 expansion — copy/paste-ready):

1. Identify the recovery target time (UTC ISO-8601). Usually the
   minute before the corrupting commit landed:

   ```
   git -C /Users/john/code/driftstack-api log --oneline -20
   # Find the bad commit; subtract a minute from its committer time.
   ```

2. Create a Neon branch from the target time. The Neon dashboard
   path is `Project → Branches → Create branch → "From point in
time"`. Or via the Neon CLI:

   ```
   neon branches create \
     --project-id "$NEON_PROJECT_ID" \
     --name "pitr-$(date -u +%Y%m%dT%H%M)" \
     --parent-timestamp "2026-MM-DDTHH:MM:00Z"
   neon branches get-connection-uri \
     --branch-id <new-branch-id> \
     --role-name driftstack
   ```

3. Spin up the server pointed at the branch URI (locally or on a
   throwaway Hetzner host) and verify customer-facing invariants:
   - Every active subscription has a `stripe_customer_id`.
   - Every non-destroyed session has a valid `account_id`.
   - `processed_stripe_events` row count is sane (no missing
     audited events).
   - Sample customer accounts exist + auth still works against
     the branch.

   ```
   DATABASE_URL="<branch-uri>" npm --workspace apps/server run start
   curl -sS http://localhost:7780/ready
   curl -sS -H "Authorization: Bearer $TEST_KEY" http://localhost:7780/v1/account/me
   ```

4. **Decide the recovery path** — there are two:
   - **Cut over to the branch** (fast; loses everything that
     happened post-incident-time). SSH-write the new
     `DATABASE_URL` into `/opt/driftstack/.env` on prod;
     `systemctl restart driftstack-api`. Verify `/ready` returns
     `postgres: operational` against the branch.
   - **Surgical patch** (slow; preserves post-incident writes).
     Hand-craft SQL to reverse the corrupting writes against
     production directly. Risky; only for narrow corruption
     scopes. Always run inside `BEGIN; … ROLLBACK;` first to
     preview row counts before committing.

5. Notify affected customers via Postmark with what happened, what
   we restored, and any data that was lost (post-incident writes
   if cut-over path was chosen).

6. Promote the branch to the new primary if cut-over was chosen,
   so PITR history starts accumulating against the post-recovery
   state. Old primary can be retained read-only for forensic
   review then archived after 30 days.

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

**Concrete recovery commands** (V-496 expansion):

1. Confirm scope on `status.upstash.com`.
2. If Upstash is up but our cluster is gone (deleted, region
   migrated, etc.): provision a new cluster via the Upstash REST
   API or dashboard:

   ```
   # Upstash REST endpoint provisioning (UI is faster — link below).
   # Dashboard: console.upstash.com → New Database → Region: eu-west-1
   #   Type: Regional → Eviction: noeviction → TLS: Required
   ```

3. SSH-write the new `REDIS_URL` (rediss:// scheme, includes
   password):

   ```
   ssh root@128.140.37.74 'cat /opt/driftstack/.env' \
     | sed 's|^REDIS_URL=.*|REDIS_URL=rediss://default:<token>@<host>:6379|' \
     > /tmp/new.env
   scp /tmp/new.env root@128.140.37.74:/opt/driftstack/.env
   ssh root@128.140.37.74 'systemctl restart driftstack-api'
   ```

4. Verify `/ready` returns `redis: operational` and a sample
   authed request succeeds (which exercises the auth-cache write
   path).

5. **No data loss procedure required** — both auth cache and
   rate-limit buckets are inherently regenerable. Customer impact
   is increased latency on cold auth + rate-limit window resets.

   Note: the `REDIS_URL` rotation is one of the rare credentials
   safe to handle by SSH-write only (it's already in the .env on
   the host; we're swapping host ↔ host). Stripe live keys go via
   the same SSH-write path per the credential-handling rule.

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

A `STRIPE_WEBHOOK_SECRET`, scrypt secret, JWT key, or
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

**Concrete rollback commands** (V-496 expansion):

1. **Confirm the bad deploy** via `/version`:

   ```
   curl -sS https://api.driftstack.dev/version | jq .
   # { "git_sha": "abc1234", ... }
   ```

   Compare to `git log --oneline -5 origin/main`. If the SHA on
   prod matches the suspected-bad commit, proceed.

2. **Roll back via git revert + redeploy**, NOT via destructive
   `git reset --hard`. The revert is itself a forward commit:

   ```
   git revert --no-edit <bad-sha>
   git push origin main
   ```

   The `Deploy server` workflow at
   `.github/workflows/server-deploy.yml` runs on the push and
   redeploys the revert SHA to Hetzner.

3. **Watch the deploy land** via gh CLI:

   ```
   gh run list --workflow server-deploy.yml --limit 3
   gh run watch <run-id>
   ```

4. Confirm `/version` reports the revert SHA + `/ready`
   returns 200 + all readiness checks green:

   ```
   curl -sS https://api.driftstack.dev/version | jq .git_sha
   curl -sS https://api.driftstack.dev/ready | jq .
   ```

5. **Express rollback when the deploy pipeline itself is broken**
   (rare — the revert push didn't trigger CI for some reason): SSH
   into the prod host and re-run the deploy script manually:

   ```
   ssh root@128.140.37.74
   cd /opt/driftstack
   git fetch origin && git checkout <revert-sha>
   # apply migrations only if necessary; usually a revert doesn't
   # touch schema
   systemctl restart driftstack-api
   exit
   curl -sS https://api.driftstack.dev/version | jq .git_sha
   ```

6. Customer-facing comms: only if the broken deploy lasted long
   enough to be customer-noticeable (>5min of sustained 5xx) or
   if customer data was visibly affected.

7. Open a fix branch + land the underlying issue properly. Don't
   hot-fix in prod by hand-editing files on the Hetzner host —
   that drift will burn the next deploy.

### Scenario 8 — Origin TLS certificate failure (V-496 NEW)

V-278.M wired Let's Encrypt DNS-01 origin certs via `certbot` +
`python3-certbot-dns-cloudflare`. Certs auto-renew every ~60 days
via certbot's systemd timer. The failure modes are:

- **Renewal failed silently** — certbot timer ran, the Cloudflare
  DNS API rejected the auth attempt (wrong token, revoked token,
  rate limit), and nginx is still serving the old cert that's
  now within days of expiring.
- **Cert already expired** — same as above but past the
  expiration date; Cloudflare's strict-mode TLS validation fails
  upstream and customers see 525 / 526 errors.

**Pre-failure detection** (run weekly via cron or manually):

```
ssh root@128.140.37.74 'certbot certificates'
# Look for "VALID: <N days>" — alert at <14 days.
ssh root@128.140.37.74 \
  'systemctl list-timers --all | grep certbot'
# Should show "next" running within ~24h.
```

**Recovery — renewal failed, cert still valid**:

1. Read certbot's last log:

   ```
   ssh root@128.140.37.74 'tail -100 /var/log/letsencrypt/letsencrypt.log'
   ```

   Common causes: `Cloudflare DNS challenge: Error finalizing
order :: An unexpected error occurred.` (transient — retry).
   `Invalid Cloudflare API token` (token rotated; update creds
   file).

2. If the Cloudflare token rotated, refresh
   `/etc/letsencrypt/cf-dns-creds.ini` with the new token (must
   carry `Zone:DNS:Edit` scope on the `driftstack.dev` zone):

   ```
   ssh root@128.140.37.74
   chmod 600 /etc/letsencrypt/cf-dns-creds.ini
   echo 'dns_cloudflare_api_token = <new-token>' \
     > /etc/letsencrypt/cf-dns-creds.ini
   ```

3. Force a renewal attempt:

   ```
   ssh root@128.140.37.74 \
     'certbot renew --dns-cloudflare \
        --dns-cloudflare-credentials /etc/letsencrypt/cf-dns-creds.ini \
        --force-renewal'
   ```

4. Reload nginx so it picks up the new cert:

   ```
   ssh root@128.140.37.74 'nginx -t && systemctl reload nginx'
   ```

5. Verify the new expiry from the customer edge:

   ```
   echo | openssl s_client -servername api.driftstack.dev \
     -connect api.driftstack.dev:443 2>/dev/null \
     | openssl x509 -noout -dates
   ```

**Recovery — cert already expired (worst case)**:

1. Cloudflare strict-mode is rejecting the upstream. Customers see
   525 / 526. Buy time by **temporarily switching Cloudflare SSL
   mode to Full (not strict)** via the Cloudflare API:

   ```
   curl -X PATCH \
     "https://api.cloudflare.com/client/v4/zones/<zone-id>/settings/ssl" \
     -H "Authorization: Bearer $CF_API_TOKEN" \
     -H "Content-Type: application/json" \
     --data '{"value":"full"}'
   ```

   Full (not strict) accepts the expired cert. Customer impact: a
   degraded TLS posture (not bit-rotted but no chain verification).
   This is a stop-gap measure; switch back to `strict` once the
   new cert lands.

2. Run the certbot renewal flow above (step 1-4 of the
   "renewal failed" path).

3. **Switch Cloudflare SSL back to `strict`**:

   ```
   curl -X PATCH \
     "https://api.cloudflare.com/client/v4/zones/<zone-id>/settings/ssl" \
     -H "Authorization: Bearer $CF_API_TOKEN" \
     -H "Content-Type: application/json" \
     --data '{"value":"strict"}'
   ```

4. Verify TLS 1.3 + valid cert chain end-to-end (V-278.M empirical
   proof pattern):

   ```
   curl -v --resolve api.driftstack.dev:443:<origin-ip> \
     https://api.driftstack.dev/health 2>&1 | grep "TLS"
   curl -v https://api.driftstack.dev/health 2>&1 | grep "TLS"
   ```

5. Set a calendar reminder for the next expiry date (cert + 60d).
   Open a ticket to triage why the auto-renew failed; if the
   certbot timer is intermittently failing, add a Sentry-fed
   monitor that runs `certbot certificates` weekly and alerts on
   `< 14 days remaining`.

**Long-term hardening**:

- Add a daily smoke-test cron that runs `certbot certificates` and
  emits a Sentry breadcrumb with the cert expiry. Alert if
  `< 21 days`.
- Stage staging.driftstack.dev cert renewal one week ahead of
  production cert renewal so we get advance failure signal on the
  same Cloudflare token + DNS-01 path.
- Document the Cloudflare zone id + Origin CA Key location in the
  founder credentials register; if the founder ever wants to swap
  to Cloudflare Origin CA (per V-278.M deviation note), the
  decision record is one git-blame away.

### Scenario 9 — Cloudflare Pages deploy regression (V-497 NEW)

**Trigger**: a marketing-site / customer-dashboard / docs / status-site
deploy to Cloudflare Pages succeeds at the build step but produces a
broken page in production (404, hydration error, blank content,
unstyled output, broken auth wire). Customer-visible within minutes
because Cloudflare Pages doesn't gate deploys behind a manual approval
once Git integration is wired.

**Detection signals**

- `StatusBadge` (V-474) shows `down` or `degraded` (the badge
  fetches `/v1/status`, so a marketing-site break alone keeps the
  badge healthy).
- Customer report on a specific URL (`/pricing` / `/dashboard` /
  `/sdk/typescript-quickstart`).
- Sentry frontend errors spiking on `*.driftstack.dev` projects
  (per-service init from V-469).

**Recovery path (Cloudflare Pages instant rollback)**

1. **Cloudflare dashboard → Pages → \<project\> → Deployments**.
   Find the most recent green deploy that _predates_ the
   regression. The "Production" badge tracks the live deploy.
2. Click the prior deploy → **Rollback to this deployment**.
   Cloudflare promotes the older bundle to the production alias
   immediately; CDN POPs flip within ~30 seconds globally. No
   Git operation required.
3. **Verify** by visiting the affected URL from a clean browser
   session (cmd-shift-N / private window — incognito bypasses CDN
   caching at the browser layer; Cloudflare's edge cache flips on
   the rollback).
4. **Code-side fix** lands as a forward commit on `main` — never
   force-push to fix Pages. The rollback bought time; the next
   deploy ships the actual fix.

**RTO**: 2 minutes (single click in the dashboard). **RPO**: zero —
no customer state lives in Pages, only static HTML/JS/CSS.

**Stop-gap**: if the Cloudflare dashboard is itself unavailable,
push a `revert` commit on `main` of the offending deploy. Pages
auto-deploys forward — equivalent latency to the dashboard rollback
once the build completes (~2 min on top of git push).

### Scenario 10 — Stripe webhook secret rotation under attack (V-497 NEW)

**Trigger**: the `STRIPE_WEBHOOK_SECRET` is suspected leaked or
compromised mid-incident. Distinct from Scenario 6 (planned
rotation): here we don't have time to coordinate a swap window with
Stripe. Customer-billing webhooks may be silently dropped or
forged.

**Recovery path**

1. **Generate the new secret in Stripe Dashboard → Developers →
   Webhooks → \<endpoint\> → Signing secret → Roll**. Stripe lets
   the OLD secret continue signing for a configurable overlap
   window (default 24h) — DO take the overlap.
2. **SSH-write the new secret** to Hetzner production (per
   `docs/deployment/stripe-webhook-testing.md`); reload the
   server (`systemctl reload driftstack-server` — pino logs
   confirm new secret loaded).
3. **The verifier code** at `apps/server/src/lib/webhook-signing.ts`
   already accepts an array of secrets. Drop the old secret from
   the env file as soon as the overlap window passes.
4. **Audit** the events in the overlap window — Stripe Dashboard →
   Developers → Webhooks → \<endpoint\> → Events list. Any 401/403
   responses on the endpoint during the overlap are forgery
   attempts; document in the incident timeline.
5. **Customer comms**: not required if no events were forged. If
   forged events are confirmed (rare; Stripe signature verification
   is robust), this becomes a security incident under
   `docs/runbooks/incidents.md` §3 — including the GDPR Art. 33–34
   clock if any customer billing data was disclosed.

**RTO**: 30 minutes (longer than Scenario 6's planned rotation
because the overlap window has to be analysed for forgery).
**RPO**: zero — Stripe retains the canonical event ledger; we can
always reconstruct from the Stripe events API.

### Scenario 11 — Multi-day Hetzner regional outage (V-497 NEW)

**Trigger**: Hetzner Falkenstein region is unreachable for >12h.
Both production and staging hosts are in Falkenstein today (per
ADR-001 control-plane hosting); a regional outage takes both down
simultaneously. Distinct from Scenario 1 (single-host loss):
single-host has Hetzner's other hosts as the recovery target;
regional outage requires cross-region failover.

**Detection signals**

- Hetzner status page (https://status.hetzner.com) reports
  Falkenstein affected.
- Synthetic checks fire on production AND staging — the dual-host
  failure pattern distinguishes regional from per-host.
- Customer reports concentrate around the same window.

**Recovery path**

1. **Status page**: post a "regional infrastructure outage at our
   primary provider" incident within 30 min — admin panel
   `/incidents`, or `POST /v1/admin/incidents` with
   `severity: 'outage'` and `public: true`. StatusBadge flips red
   because `/v1/status` derives `overall_status` from open public
   incidents. Customers see a real cause, not a vague
   "we're having issues."
2. **Stand up replacement compute** in Hetzner Nuremberg or Helsinki
   (both EU; both in the Hetzner DPA scope). Process is the same
   as Scenario 1 — provision via the Hetzner CLI, deploy from
   clean state — but doubled because we need both prod and staging.
3. **Update DNS** at Cloudflare to point `api.driftstack.dev` and
   `staging-api.driftstack.dev` at the new IPs. TTL is 60s on
   these records (per `docs/deployment/dns.md`); propagation is
   under 2 min.
4. **Verify TLS** with the Cloudflare Full (strict) posture from
   V-278.M — the Let's Encrypt cert lives on the host filesystem,
   so a fresh provisioning re-runs the cert acquisition step. If
   the new region's IP isn't yet in the rate-limit allowance,
   fall back to Cloudflare's strict-with-known-CA mode for the
   first hour.
5. **Database / Redis**: Neon and Upstash are both EU-region but
   independent of Hetzner — they remain available. The new
   compute connects to the existing data plane via env vars; no
   data migration required.
6. **Customer comms**: hourly updates on the trust center until
   resolved. SLA credits per `apps/marketing-site/src/pages/legal/sla.astro`
   apply automatically against the next invoice.

**RTO**: 4–6 hours including TLS re-acquisition. **RPO**: zero —
data plane is regionally independent.

**Pre-launch posture**: this scenario is rehearseable but not
fully solveable until staging lives in a DIFFERENT Hetzner region
from production (queued as a post-launch infrastructure ask). For
now the runbook documents the recovery path; the rehearsal is
one-shot rather than periodic.

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

> **Local-only rehearsal harness**: `scripts/dr-rehearse.sh` (V-510)
> walks the scenarios that don't need production touchpoints
> (Scenarios 2 / 4 / 6 / 7 / 8). The harness refuses to act on
> production hosts. For Scenarios 1 / 3 / 5 / 9 / 10 / 11 the
> rehearsal is manual against staging with founder SSH +
> Cloudflare + Stripe access.

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
- [ ] Scenario 8 (cert renewal) — force-renew the staging cert via
      `certbot renew --force-renewal` against the staging host
      ahead of its scheduled timer; reload nginx; verify TLS 1.3
      handshake from the customer edge with the fresh cert. Catches
      Cloudflare token / DNS-01 misconfigurations early.
- [ ] Scenario 8 (cert expiry stop-gap) — flip Cloudflare SSL to
      `full` (not strict) in test mode against staging; verify
      curl still works; flip back to `strict`. Confirms the
      stop-gap procedure is one API call away.
- [ ] Scenario 9 (Pages rollback) — push a deliberate hydration-
      breaking change to a marketing-site preview branch; deploy
      to a Pages preview env; rollback via the Cloudflare
      dashboard; confirm the preview returns to known good in
      under 2 min. Practiced quarterly because the Pages UI evolves.
- [ ] Scenario 10 (Stripe secret panic-rotate) — rehearse the
      Stripe overlap-window rotation in test mode end-to-end;
      time the drop-old-secret step against the audit window;
      confirm the verifier accepts both the new + old secrets
      during overlap.
- [ ] Scenario 11 (Hetzner regional failover) — full provision-
      from-clean rehearsal in a non-Falkenstein region, including
      DNS swap + Let's Encrypt re-acquisition. One-shot pre-launch;
      after staging is regionally split this becomes routine.

Each dry-run gets a V-log entry confirming "rehearsed YYYY-MM-DD,
RTO observed, gaps surfaced".

## Related

- Operational runbook (incident triage): `docs/deployment/runbook.md`
- Migration rehearsal: `docs/deployment/migration-rehearsal.md`
- Stripe webhook procedures: `docs/deployment/stripe-webhook-testing.md`
- Env-var schema: `docs/deployment/env-vars.md`
