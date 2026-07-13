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

- [ ] Stripe live-mode dashboard shows the 19 ADR-004 prices configured. (1 trial pack + 8 paid tiers × 2 periods = 17, plus 2 enterprise = 19. If a tier-period combo is missing, it can't be checkout-targeted.)
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
3. Land on welcome / select-tier → pick `trial_pack` → Stripe Checkout opens.
4. Complete checkout with a real card (we'll refund or destroy the account after the test).
5. Verify `/billing` reflects the trial-pack purchase.
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
- [ ] Have `ssh driftstack@<production-host>` ready in a terminal.
- [ ] Have a second terminal with `tail -F` on the deploy log: `ssh driftstack@<host> "cd /opt/driftstack && docker compose logs -f api"`.
- [ ] Open the V-279 pre-launch checklist + this runbook in a third tab.

---

## T-0: Cutover sequence

The actual cutover is small — most work was front-loaded into the V-258/V-259/V-278 founder ops. Today:

### 1. Flip Stripe to live mode

- Stripe dashboard → toggle from Test → Live (top-right).
- Verify that the 19 ADR-004 prices are present in live mode (they're separate from test-mode prices). If not, create them now using `docs/operations/stripe-price-ids.md` (TODO: this doc lands when V-281 ships, or refer to ADR-004 directly).
- Update production .env on the Hetzner VM via SSH (NEVER via `gh secret set` from a chat-readable terminal):
  ```sh
  ssh driftstack@<production-host>
  cd /opt/driftstack
  sed -i 's/^STRIPE_SECRET_KEY=.*$/STRIPE_SECRET_KEY=sk_live_…/' .env
  sed -i 's/^DRIFTSTACK_TIER_PRICE_IDS=.*$/DRIFTSTACK_TIER_PRICE_IDS=…/' .env
  sed -i 's/^STRIPE_TRIAL_PACK_PRICE_ID=.*$/STRIPE_TRIAL_PACK_PRICE_ID=price_…/' .env
  sed -i 's/^STRIPE_WEBHOOK_SECRET=.*$/STRIPE_WEBHOOK_SECRET=whsec_…/' .env
  docker compose up -d --force-recreate
  curl -fsS http://127.0.0.1:7780/health  # confirms restart succeeded
  ```
- Verify in the bootstrap log: `BillingService NOT wired` warning is gone (replaced by silent success).

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
- **`docker compose logs -f api`** — error patterns, scrypt latency, DB connection issues.
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
| `/health` returning non-200                  | any                                | Restart container (`docker compose restart api`); if persistent, full rollback (step 15).                          |
| `docker compose logs` "fatal"                | any                                | Bootstrap failure; rollback to last-known-good image immediately (step 15).                                        |
| Stripe webhook signature-verify failures     | > 0                                | Webhook secret mismatch. Verify Stripe dashboard's webhook signing secret matches `STRIPE_WEBHOOK_SECRET` in .env. |
| Postmark bounce rate                         | > 5%                               | Email deliverability issue. Check sender reputation, SPF/DKIM/DMARC records on `driftstack.dev`.                   |
| Customer support inbox                       | unread message > 1 hour            | Personal triage. Day-1 SLO is "respond within 1 hour to anything paying-customer-flagged."                         |

---

## Day-1 customer support

### Known-issue list (prepared answers)

- **"My GUI client says 'Couldn't reach the control plane'"** — verify they're on `https://api.driftstack.dev` (not staging). Check `/v1/status` for any sub-processor degradation.
- **"My API key isn't working"** — possible they revoked it via dashboard. Check `/v1/api-keys` list for their account; if revoked, ask them to mint a new one.
- **"My trial pack ran out faster than expected"** — $0.18/hr decrement vs $2.99 cap = 16.6 hours. If they exhausted faster, check `account.audit-log` for the actual consumption.
- **"I can't sign up; verification email never arrived"** — check Postmark dashboard for the address. Bounce / hard-fail / rate-limit can all be reasons. Re-send via the dashboard if the customer had a typo or the inbox was temporarily unreachable.
- **"Stripe checkout shows the wrong price"** — verify ADR-004 price IDs in the live `DRIFTSTACK_TIER_PRICE_IDS` env match the prices actually configured in the Stripe live dashboard. Mismatch = customers see the WRONG product. Triage immediately.

### Escalation paths

1. **Customer reports paid feature failing** → triage to step 15 if widespread; per-customer manual session-state-restoration if isolated.
2. **Customer reports billing / refund need** → use Stripe live dashboard Refund button. Document in customer's audit log via the admin panel (V-281 will polish this; pre-V-281 it's "send admin API key + refund manually").
3. **Customer reports legal-page concern** → escalate to founder + counsel; do not commit to anything in real-time.
4. **Customer reports security vulnerability** → acknowledge within 1h; full disclosure timeline per the AUP / DPA TOM section F.

### Refund procedure (manual, pre-V-281)

```sh
# Find the customer + their Stripe customer ID
ssh driftstack@<host>
docker compose exec api node -e "
  // (or use a real query — admin panel V-281 ships this UI)
"

# Refund via Stripe dashboard
# Stripe → Customers → search by email → Charges → Refund

# Document in audit log via the admin endpoint:
curl -X POST https://api.driftstack.dev/v1/admin/accounts/{acc_id}/audit \
  -H "Authorization: Bearer ${ADMIN_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"action":"manual_refund","payload":{"amount_cents":299,"reason":"Day-1 test refund"}}'
```

---

## Rollback procedures

### Image-level rollback (1-2 minutes; safest)

If the first hour shows a clear bug introduced by the most-recent deploy:

```sh
ssh driftstack@<production-host>
cd /opt/driftstack

# Find the previous good image:
docker images | grep driftstack-api | head -5

# Or check the last green deploy in GitHub Actions:
# Actions → Deploy → previous successful run → output → image-tag

# Set IMAGE_TAG to the previous good one:
export IMAGE_TAG=ghcr.io/driftstackdev/driftstack-api:<previous-sha>
docker compose up -d --force-recreate
curl -fsS http://127.0.0.1:7780/health  # verify
```

This restores the binary; .env file is unchanged.

### Workflow-level rollback (5-10 minutes; tracked)

For tracked rollback that gets reflected in main:

```sh
git revert <bad-sha>
git push origin main
# deploy.yml re-fires; image rebuilds at the reverted state.
```

### Full rollback (worst case)

If both image-level + workflow-level rollback fail (e.g. DB schema migration that's not down-revertable), put the marketing site into "we're temporarily down for maintenance" mode:

- Cloudflare Pages → swap to a static "we'll be back shortly" deploy.
- Cloudflare DNS → point `api.driftstack.dev` at a maintenance page (or 503 it via a Worker).
- Triage + fix + re-deploy.

This is the worst case; the goal is to never need it. The image-level rollback handles 95% of plausible launch-day issues.

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
- If error rate trends flat or down: continue accepting customers; resume normal release cadence (deploy.yml push-on-main).
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
- [ ] Image-level rollback procedure rehearsed at least once on staging.

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
- `docs/adr/ADR-004-pricing-restructure-two-ladder.md` — pricing values + 19 SKUs.
- `docs/adr/ADR-003-paid-trial-pack-replaces-free-tier.md` — trial-pack mechanics.

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
