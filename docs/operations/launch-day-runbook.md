# Driftstack launch-day runbook

End-to-end choreography for "launch day" — the day you flip from pre-launch / staging-only to publicly accepting paying customers. Designed to be readable in one sitting and executable on the day.

**Pre-condition:** all V-279 pre-launch checklist items in the "Minimum-launchable surface (first-paying-customer-acceptable)" section are READY. If any item is still PENDING FOUNDER, stop and close it before starting this runbook.

**Roles:**

- **Operator** = the founder running the runbook.
- **Out-of-band escalation** = anyone with SSH access to the Hetzner production VM (today: founder only).

---

## T-24h: Pre-flight checks

### Backend / API

- [ ] `https://staging.driftstack.dev/health` returns 200 with JSON.
- [ ] `https://api.driftstack.dev/health` returns 200 with JSON.
- [ ] Sentry staging + production environments populated with at least one synthetic event.
- [ ] `curl https://api.driftstack.dev/v1/status` returns the public-status JSON (sub-processor health roll-up).

### Marketing site / dashboard / docs

- [ ] `https://driftstack.dev` loads with the brand identity (oxblood D-badge + lowercase mono wordmark).
- [ ] `https://app.driftstack.dev/signup` form posts; verification-email send works (check Postmark dashboard for the test send).
- [ ] `https://app.driftstack.dev/login` form posts; session token writes to localStorage; redirect lands.
- [ ] `https://app.driftstack.dev/forgot-password` flow lands a real email in your inbox; reset link works.
- [ ] `https://docs.driftstack.dev/quickstart/` loads; the code samples render with proper syntax highlighting.
- [ ] `https://driftstack.dev/legal/terms` loads; no `[BV LEGAL NAME]` / `[KvK NUMBER]` placeholders visible (post-V-264 + post-KvK closure).

### Stripe

- [ ] Stripe live-mode dashboard shows the canonical 12 recurring prices configured (Solo/Team/Agency Manual and Starter/Builder/Scale API, each monthly + annual). Enterprise is sales-assisted and the free tier has no Stripe price. If a tier-period combo is missing, it can't be checkout-targeted.
- [ ] Stripe webhook endpoint configured, pointing at `https://api.driftstack.dev/v1/webhooks/stripe`. Webhook signing secret matches the `STRIPE_WEBHOOK_SECRET` in production .env.
- [ ] `STRIPE_SECRET_KEY` in production .env is `sk_live_…` (NOT `sk_test_…`).
- [ ] Run a synthetic test-mode checkout via the Stripe dashboard's webhook tester to verify production receives the event + records a row.

### GUI client

- [ ] Latest signed `gui-vX.Y.Z` build downloadable from the Tauri Updater manifest URL (or GitHub Releases page).
- [ ] First-run wizard on a fresh test machine: Welcome → Cloud → Sign in with browser → opens `app.driftstack.dev/cli/authorize` → confirm → key minted, keychain populated, wizard advances.

### Smoke test (full happy path)

Run through this exact sequence on a fresh-but-real account against production:

1. Visit `app.driftstack.dev/signup` → create account with a real email you control.
2. Verify email via the link Postmark delivers.
3. Land on welcome / select-tier → choose Solo Manual monthly → Stripe Checkout opens.
4. Complete checkout with a real card (we'll refund or destroy the account after the test).
5. Verify `/billing` reflects the active Solo Manual subscription and correct renewal cadence.
6. Open the GUI client → "Sign in with browser" → confirm → key minted.
7. Spin up a session in the GUI → navigate to `https://example.com` → capture screenshot.
8. Destroy session → list shows zero active.
9. `/account/me` → reflects subscription + concurrent counters correctly.
10. `/api-keys` → "Desktop client" key visible; revoke it → 401 from the GUI on the next call (verify by attempting another action).

If any step fails, **abort launch** and triage in step 14 below.

---

## T-1h: Final preparation

- [ ] Pin the laptop on a wired connection (or known-stable WiFi); not on a flaky cell tether.
- [ ] Open these tabs in a single browser window for the duration:
  - GitHub Actions (recent runs)
  - Hetzner Cloud Console (VM list)
  - Cloudflare dashboard (DNS + Pages)
  - Stripe live dashboard
  - Sentry production environment (events + issues)
  - Neon dashboard (DB connections)
  - Upstash dashboard (Redis ops/sec)
  - Postmark dashboard (sending volume + bounces)
- [ ] Have `ssh root@<production-host>` ready in a terminal.
- [ ] Have a second terminal following the actual systemd service: `ssh root@<production-host> "journalctl -u driftstack-api -f --no-pager"`.
- [ ] From the repository root, run `bash scripts/deploy-status.sh --check prod`; resolve any activation or migration drift before cutover.
- [ ] Open the V-279 pre-launch checklist + this runbook in a third tab.

---

## T-0: Cutover sequence

The actual cutover is small — most work was front-loaded into the V-258/V-259/V-278 founder ops. Today:

### 1. Flip Stripe to live mode

- Stripe dashboard → toggle from Test → Live (top-right).
- Verify that the canonical 12 recurring prices are present in live mode (they're separate from test-mode prices). Use `node scripts/stripe-bootstrap-prices.mjs --dry-run` with the live key to validate exact names, intervals and amounts before changing runtime configuration.
- Stage the live values through the established SSH-only, root-owned mode-600 pending-file procedure. Never paste a live key into chat, a commit, or command-line arguments. Atomically merge the reviewed values into `/opt/driftstack/api/.env`, preserve owner `driftstack:driftstack` and mode `600`, remove the pending file, then use the current immutable release as the restart boundary:
  ```sh
  # Run from a clean repository checkout; use the reviewed full SHA.
  DEPLOY_VIA_BUNDLE=1 bash scripts/deploy-bridge.sh prod <exact-full-sha>
  node scripts/post-deploy-verify.mjs \
    --base-url https://api.driftstack.dev \
    --expected-sha <exact-full-sha>
  bash scripts/deploy-status.sh --check prod
  ```
- Verify `/v1/billing/checkout-session` is auth-gated (`401`, not disabled `503`), the missing-signature webhook boundary rejects, and the bootstrap log records `BillingService wired with StripeBillingProvider` without printing configuration values.

### 2. DNS go-live (if not already)

If `driftstack.dev` / `app.driftstack.dev` / `api.driftstack.dev` etc. were on staging-only DNS, flip to production. Per V-259 + V-278 these should already be production-pointed, but verify:

- `dig +short api.driftstack.dev` → production VM IP.
- `dig +short app.driftstack.dev` → CF Pages CNAME.
- `dig +short driftstack.dev` → CF Pages CNAME (apex).
- `dig +short docs.driftstack.dev` → CF Pages CNAME.

If any record is wrong, fix in Cloudflare DNS dashboard. TLS provisions in ~2-5 minutes for any newly-added record.

### 3. Marketing site goes public

- Cloudflare Pages → marketing project → confirm latest deploy is the production-cut commit.
- (If you've been gating with a "coming soon" landing page during the build, this is when you swap it.)

### 4. Watch the first hour

Eyeballs on:

- **Sentry production** — any new issue → triage immediately (step 14 below).
- **`journalctl -u driftstack-api -f`** — error patterns, scrypt latency, DB connection issues.
- **Stripe live dashboard** → events / payments / webhook deliveries.
- **Postmark** → email send volume + bounce rate.
- **GitHub Actions** → no failed deploys / no CI red.

---

## Day-1 monitoring thresholds

If any of these fire, treat as escalation:

| Metric                                       | Threshold                          | Action                                                                                                             |
| -------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Sentry error rate (production)               | > 5 events/min sustained for 2 min | Triage the top issue; if customer-facing (auth, billing, sessions), consider rollback (step 15).                   |
| Sentry "AccountAuthError" or "AuthFlowError" | > 10/min                           | Likely Redis or DB connection issue. Check Upstash + Neon dashboards.                                              |
| `/health` returning non-200                  | any                                | Run `deploy-status.sh`, inspect systemd, then immutably revert to the previous proven SHA (step 15).               |
| `journalctl -u driftstack-api` "fatal"       | any                                | Bootstrap failure; immutably revert to the previous proven SHA immediately (step 15).                              |
| Stripe webhook signature-verify failures     | > 0                                | Webhook secret mismatch. Verify Stripe dashboard's webhook signing secret matches `STRIPE_WEBHOOK_SECRET` in .env. |
| Postmark bounce rate                         | > 5%                               | Email deliverability issue. Check sender reputation, SPF/DKIM/DMARC records on `driftstack.dev`.                   |
| Customer support inbox                       | unread message > 1 hour            | Personal triage. Day-1 SLO is "respond within 1 hour to anything paying-customer-flagged."                         |

---

## Day-1 customer support

### Known-issue list (prepared answers)

- **"My GUI client says 'Couldn't reach the control plane'"** — verify they're on `https://api.driftstack.dev` (not staging). Check `/v1/status` for any sub-processor degradation.
- **"My API key isn't working"** — possible they revoked it via dashboard. Check `/v1/api-keys` list for their account; if revoked, ask them to mint a new one.
- **"I hit the free-tier session limit"** — confirm the account is still on `free`, inspect concurrent/duration-limit audit context, and point the customer to the appropriate recurring tier without changing their account manually.
- **"I can't sign up; verification email never arrived"** — check Postmark dashboard for the address. Bounce / hard-fail / rate-limit can all be reasons. Re-send via the dashboard if the customer had a typo or the inbox was temporarily unreachable.
- **"Stripe checkout shows the wrong price"** — verify ADR-004 price IDs in the live `DRIFTSTACK_TIER_PRICE_IDS` env match the prices actually configured in the Stripe live dashboard. Mismatch = customers see the WRONG product. Triage immediately.

### Escalation paths

1. **Customer reports paid feature failing** → triage to step 15 if widespread; per-customer manual session-state-restoration if isolated.
2. **Customer reports billing / refund need** → use Stripe live dashboard Refund button. Document in customer's audit log via the admin panel (V-281 will polish this; pre-V-281 it's "send admin API key + refund manually").
3. **Customer reports legal-page concern** → escalate to founder + counsel; do not commit to anything in real-time.
4. **Customer reports security vulnerability** → acknowledge within 1h; full disclosure timeline per the AUP / DPA TOM section F.

### Refund procedure (manual, pre-V-281)

```sh
# Find the customer and Stripe customer ID through the owner admin panel/API.
# Do not run ad-hoc database or container commands on the production host.

# Refund via Stripe dashboard
# Stripe → Customers → search by email → Charges → Refund

# Record the manual refund via the purpose-built admin endpoint. It is
# audit-only and does NOT call Stripe — the money movement above is the
# operator's action in the Stripe dashboard.
curl -X POST https://api.driftstack.dev/v1/admin/accounts/{acc_id}/refund-record \
  -H "Authorization: Bearer ${ADMIN_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"external_reference":"re_...","amount_cents":299,"currency":"eur","reason":"Day-1 test refund"}'
```

---

## Rollback procedures

### Immutable SHA rollback (about 1-2 minutes; safest)

If the first hour shows a clear bug introduced by the most-recent deploy:

```sh
# Inspect current SHA, migration parity and recent immutable deploy history.
bash scripts/deploy-status.sh prod

# Choose the previous independently verified full SHA from that history.
DEPLOY_VIA_BUNDLE=1 bash scripts/revert-bridge.sh \
  --to-sha <previous-known-good-full-sha> prod

node scripts/post-deploy-verify.mjs \
  --base-url https://api.driftstack.dev \
  --expected-sha <previous-known-good-full-sha>
bash scripts/deploy-status.sh --check prod
```

This rebuilds and atomically installs the reviewed Git object; `.env` is unchanged. Do not use bare `revert-bridge.sh prod` after a subtly bad deploy has already been recorded as last-good—select the prior known-good SHA explicitly from deploy history.

### Workflow-level rollback (5-10 minutes; tracked)

For a tracked correction that becomes the new forward state:

```sh
git revert <bad-sha>
# Review and merge the revert through the normal protected-main workflow.
# Then deploy and verify that exact merged full SHA with deploy-bridge.sh.
```

### Full rollback (worst case)

If both immutable-SHA + workflow-level rollback fail (for example, a DB schema migration is not down-revertable), put the marketing site into "we're temporarily down for maintenance" mode:

- Cloudflare Pages → swap to a static "we'll be back shortly" deploy.
- Cloudflare DNS → point `api.driftstack.dev` at a maintenance page (or 503 it via a Worker).
- Triage + fix + re-deploy.

This is the worst case; the goal is to never need it. The immutable-SHA rollback handles most plausible launch-day issues.

---

## Day 2-7: stabilisation

### Metrics to track

- **Daily signups** (via Postmark sender stats + dashboard Signups page).
- **Daily checkouts** (Stripe live dashboard).
- **Daily session creates** (`/v1/admin/overview` aggregate counter).
- **Sentry error rate trend** (production environment, week-over-week).
- **Customer support response time** (manual; aim for < 1h on paying-customer issues).

### Decisions on continuation

After day 3:

- If error rate trends up: pause new-customer signups (gate via tier-select page), triage, ship fixes.
- If error rate trends flat or down: continue accepting customers; resume the reviewed exact-SHA staging-then-production release cadence.
- If a critical bug surfaces post-launch: document in `docs/postmortems/YYYY-MM-DD-<slug>.md` (folder lands when first incident happens).

After day 7:

- Roll up first-week stats into a brief retro doc.
- Identify any V-NNN follow-ups (UX friction, performance hot spots, support pain points).
- Add to the parked queue + prioritize per founder direction.

---

## Pre-launch verification checklist

Before flipping the switch, confirm each:

- [ ] V-279 pre-launch checklist's "Minimum-launchable surface (first-paying-customer-acceptable)" section is fully READY.
- [ ] T-24h smoke test passed end-to-end.
- [ ] Stripe live mode prices verified.
- [ ] Sentry receives test events from production.
- [ ] All four customer-support email addresses functional (`support@`, `privacy@`, `legal@`, `abuse@`, `security@`).
- [ ] Founder available + in front of the launch dashboard for at least the first 4 hours.
- [ ] Immutable SHA rollback procedure rehearsed at least once on staging.

If all green: proceed with T-0 cutover.

If any red: stop, close the gap, re-verify.

---

## Related docs

- `docs/launch/pre-launch-checklist.md` — V-279 audit + priority queue.
- `docs/operations/release-policy.md` — V-283 deploy.yml=staging / server-deploy.yml=production split.
- `docs/founder-actions/v278-hetzner-deploy-keys.md` — Hetzner provisioning runbook.
- `docs/operations/production-env-schema.md` — env-var schema in provisioning order.
- `docs/deployment/runbook.md` — day-to-day operations (logs, restart, scale).
- `docs/deployment/dr-runbook.md` — disaster-recovery procedures (11 scenarios
  incl. V-497 Cloudflare Pages rollback, Stripe panic-rotate, Hetzner regional
  outage).
- `docs/runbooks/incidents.md` — V-499 incident classification + GDPR Art.
  33–34 timeline + sub-processor incident propagation + CSE escalation tree +
  post-incident review template.
- `docs/runbooks/observability.md` — V-513 Sentry per-service projects +
  alert rules + synthetic check thresholds + DLQ triage workflow + load-test
  cadence.
- `scripts/dr-rehearse.sh` — V-510 local-only DR rehearsal harness
  (Scenarios 2/4/6/7/8). Refuses to act on production hosts.
- `apps/marketing-site/src/data/pricing.ts` — current six-tier recurring catalog and free-entry truth.
- `scripts/stripe-bootstrap-prices.mjs` — canonical Stripe product/price bootstrap and dry-run validator.

---

## V-516 launch-day amendments (post-Wave-11 state)

The following items, shipped during Waves 1–11 of the autopilot
run, should be confirmed during T-24h or T-0 alongside the
checklist above.

### T-24h additions

- [ ] V-485 tier-features registry — sanity-check: `tierFeatures(tier)`
      returns the expected aiAgent + concurrentSessions values for
      the tier of the first-paying-customer's account.
- [ ] V-494 secret redaction — confirm pino logs produced during the
      T-24h staging smoke test do NOT contain any of the redacted
      keys (`password` / `new_password` / `recovery_code` /
      `stripe-signature` header).
- [ ] V-499 incident runbook — verify the customer-facing
      `/trust/incidents` page renders and the "open an incident"
      flow actually creates a visible entry.
- [ ] V-513 observability — open Sentry; confirm at least one
      breadcrumb-trail event arrives from a staging request.
      Confirm the alert rules listed in `observability.md` are
      configured in the Sentry dashboard.
- [ ] V-510 DR rehearsal — `scripts/dr-rehearse.sh all` exits 0.
      This exercises 5 local scenarios; the 6 production-touching
      scenarios (1 / 3 / 5 / 9 / 10 / 11) need explicit founder
      rehearsal pre-launch per `dr-runbook.md`.
- [ ] V-487 NowPayments scaffold — confirm the IPN secret + API
      key are provisioned in the production .env (or that the
      crypto rail is intentionally NOT live yet, in which case
      the absent env vars are correct).

### T-0 additions

- [ ] StatusBadge (V-474) on the marketing site shows green
      (`/v1/status` returns `operational`).
- [ ] DLQ depth at `/v1/admin/overview` is 0 within the first hour;
      any non-zero count pages founder per the V-513 alert rules.
- [ ] V-484 audit-log filters render correctly on the customer-
      dashboard `/audit-log` page (date pickers + actor-type select +
      target_resource_id input apply cleanly).
- [ ] V-512 admin DLQ drill-down filter works:
      `GET /v1/admin/webhook-dlq?endpoint_id=<known-endpoint>`
      returns the expected subset.
