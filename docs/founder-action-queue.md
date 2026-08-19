# Founder action queue

**Status:** living document. Updated as items resolve / new items surface.

> **⚠ V-872 — this queue carries no roll-up date, and at least one item outlived
> its work by six weeks.** V-871 found the brand-asset entry asking for a
> 1200×630 PNG that had shipped on 2026-07-07 and was already wired into
> `BaseLayout.astro`. "Updated as items resolve" is an intention, not a record:
> there is no marker here to check an item's freshness against, which is exactly
> how a resolved item stays unmarked indefinitely. Verify an item against source
> before spending time on it.
> **Owner:** founder (action items themselves) + engineering (queue maintenance).

This is the **outside-engineering** action queue — things only the
founder can do because they require credentials, billing access, legal
authority, or asset creation that isn't engineering scope. Engineering
keeps this doc in sync as work surfaces blocking items.

Items are grouped by category. Each item says what's blocked + what
the founder needs to do.

---

## Infrastructure (Hetzner + Cloudflare + Neon + Upstash)

### Hetzner two-VM provisioning

- **Status:** PENDING
- **Blocks:** production deploy of `apps/server` (one VM staging, one
  VM production per ADR-001 control-plane-hosting decision).
- **Action:** Provision two CCX23 VMs in Falkenstein (FSN1). SSH key
  in Hetzner Cloud Console; document VM IDs in the operational
  register (kept outside this repo).
- **Reference:** ADR-001 `docs/adr/ADR-001-control-plane-hosting-hetzner.md`.

### Cloudflare Pages projects

- **Status:** PENDING
- **Blocks:** marketing site deploy + customer dashboard deploy +
  admin panel deploy (V-135) + doc site deploy (V-258).
- **Action:** Create 4 Cloudflare Pages projects in the Cloudflare
  dashboard:
  - `driftstack-marketing` → custom domains `driftstack.dev` + `www.driftstack.dev`
  - `driftstack-customer-dashboard` → custom domain `app.driftstack.dev`
  - `driftstack-admin-panel` → custom domain `admin.driftstack.dev` (Cloudflare Access SSO gate planned at the origin level)
  - `driftstack-docs` → custom domain `docs.driftstack.dev` (V-258)
- **Reference:** `apps/marketing-site/astro.config.mjs`,
  `apps/customer-dashboard/astro.config.mjs`,
  `apps/admin-panel/astro.config.mjs`,
  `apps/docs/astro.config.mjs`.
- **Runbook:** `docs/founder-actions/v259-cloudflare-pages-all-projects-setup.md`
  consolidates the per-project setup; per-project deep-dives in the
  per-V-NNN runbooks where they exist (e.g.
  `docs/founder-actions/v258-cloudflare-pages-docs-setup.md`).

### Neon EU database

- **Status:** PENDING
- **Blocks:** production deploy.
- **Action:** Create two separate Neon projects in EU region (or two
  branches of one project): `driftstack-staging` + `driftstack-production`.
  Capture connection strings into `DATABASE_URL` per
  `docs/deployment/env-vars.md`.

### Upstash EU Redis

- **Status:** PENDING
- **Blocks:** production deploy.
- **Action:** Create two Upstash databases (EU region, TLS enabled).
  Capture `rediss://...` URLs into `REDIS_URL` per env-vars doc.

---

## CI/CD secrets

### GitHub Environments

- **Status:** PENDING
- **Blocks:** the deploy pipeline (`.github/workflows/deploy.yml`).
- **Action:** Create `staging` + `production` environments under
  GitHub repository settings → Environments. Configure protected
  branches + reviewers if desired.

### Sentry secrets

- **Status:** PENDING
- **Blocks:** Sentry source-map upload at deploy + runtime exception
  capture (`apps/server/src/lib/sentry.ts`).
- **Action:** Add 3 secrets to `production` environment:
  - `SENTRY_AUTH_TOKEN` (Internal Integration token, project:read +
    project:write scopes)
  - `SENTRY_ORG` (the Sentry org slug)
  - `SENTRY_PROJECT` (the Sentry project slug for the API server)
- **Reference:** `docs/adr/ADR-005-observability-sentry-first.md`.

### DEPLOY_DOTENV_BASE64

- **Status:** PENDING
- **Blocks:** the deploy pipeline writing `/opt/driftstack/.env` on
  the Hetzner VM.
- **Action:** Create the local `.env` file with all values listed in
  `docs/deployment/env-vars.md`, base64-encode it, and add as the
  GitHub repo secret `DEPLOY_DOTENV_BASE64` (per environment).

### Allow auto-merge in repo settings (V-148)

- **Status:** PENDING
- **Blocks:** V-148 Dependabot patch-only auto-merge workflow taking
  effect. Workflow degrades gracefully if disabled (logs clear error,
  PR stays open for manual merge) but auto-merge is the whole point.
- **Action:** Repo settings → General → "Allow auto-merge" → enable.
  One-click.
- **Reference:** `.github/workflows/dependabot-auto-merge.yml` (V-148).

---

## Stripe (ADR-002)

### Stripe price IDs

- **Status:** PENDING
- **Blocks:** customer-facing checkout + Stripe webhook handler
  resolving plans (V-082, V-088, V-089).
- **Action:** Create the 12 recurring Stripe prices in the live-mode dashboard
  matching the current six paid-tier values:
  - 6 Manual ladder (Solo/Team/Agency × monthly + annual)
  - 6 API ladder (Starter/Builder/Scale × monthly + annual)
- **Action:** Capture all 12 price IDs in the six-tier
  `DRIFTSTACK_TIER_PRICE_IDS` JSON map per `docs/deployment/env-vars.md`.
  Enterprise remains sales-assisted and the perpetual free tier has no Stripe
  price. The retired one-time trial pack must not be recreated.

### Stripe webhook secret

- **Status:** PENDING
- **Blocks:** `apps/server/src/routes/webhooks-stripe.ts` signature
  verification (V-080).
- **Action:** In Stripe dashboard → Developers → Webhooks, create
  an endpoint pointing at `https://api.driftstack.dev/v1/webhooks/stripe`.
  Copy the signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.

### Stripe Tax + EU VAT

- **Status:** PENDING
- **Blocks:** invoice tax computation (per V-082 + ADR-002).
- **Action:** Enable Stripe Tax in dashboard. Verify Dutch BV tax
  registration is captured. Confirm reverse-charge handling for
  EU B2B customers — Stripe Tax computes automatically once enabled.

---

## Pricing values (locked but TBD on launch)

### BYOK markup multiplier

- **Status:** TBD
- **Blocks:** Tier 3 customer-facing copy on /pricing for "BYOK
  markup" — currently rendered as "Bundled per-token rate announced
  at launch."
- **Action:** Confirm BYOK markup multiplier (e.g. `1.0` = pass-through,
  `1.2` = 20% markup, etc.). Used by the bundled-LLM billing path
  for API Builder / API Scale / Enterprise tiers.

### Bundled LLM per-token rate

- **Status:** TBD
- **Blocks:** Same Tier 3 surface; same launch announcement.
- **Action:** Decide the customer-facing per-1M-input-tokens +
  per-1M-output-tokens rate for the bundled LLM offering (Anthropic
  Claude pass-through plus markup).

---

## Brand assets

### og-default.png

- **Status:** DONE (V-871 check). `apps/marketing-site/public/og-default.png`
  is a 1200×630 PNG dated 2026-07-07, generated from `og-default.svg` by
  `scripts/gen-og-image.mjs`, and `BaseLayout.astro` resolves every page's
  `ogImage` to `/og-default.png` by default — so it is wired, not a placeholder
  URL. This entry asked for it for six weeks after it landed.
- **Blocks:** nothing. Open Graph + Twitter card previews render (V-132).
- **Original ask, kept verbatim as the record of what was specified:** Drop a
  1200×630 PNG into
  `apps/marketing-site/public/og-default.png`. Brand-on-image
  treatment with the oxblood D logo + "Driftstack" wordmark + a
  one-line tagline.

### Per-page custom OG images (optional)

- **Status:** OPTIONAL
- **Blocks:** Nothing. Per-page OG images are an enhancement —
  /pricing + /self-hosted in particular benefit from page-specific
  cards.
- **Action:** Founder + designer call. BaseLayout already accepts a
  per-page `ogImage` prop (V-132); pages just need to pass an asset
  path.

---

## Legal + compliance (separate workstream)

### Sub-processor list

- **Status:** LOCKED 2026-05-03 (V-052)
- **Reference:** Hetzner / Neon / Upstash / Cloudflare / Postmark /
  Sentry / Stripe / Anthropic / Moneybird / MacStadium per
  `AGENTS.md`. Adding a new sub-processor = directional question
  first, never silent.

### Legal documents

- **Status:** DRAFT (counsel review pending)
- **Reference:** `docs/legal/*.md` per the V-052 exception extension.
  All baseline legal text is revisable; counsel review carries
  final authority.

---

## How to use this queue

When engineering needs founder to act on something blocking, an entry
lands here with category + status + blocks + action. Founder
resolves; entry status moves to RESOLVED with the resolution date.
Resolved entries stay in the doc for 30 days for audit trail then
archive into `docs/archive/founder-action-queue-resolved.md`.

When engineering wants the founder's attention on something but it's
NOT blocking, those go in pbcopy / chat status updates rather than
this queue.

---

## Engineering-side action queue (not founder's)

For completeness — these items are engineering's to resolve,
listed here so founder has visibility into the in-flight work:

- Live wire-up of `/v1/team/*` endpoints once multi-seat schema migration lands (V-142 forward-looking design).
- Server-side enforcement of `PROFILES_PER_TIER` at `/v1/profiles` creation gate (V-136 added the constant; V-073 was scaffolding for the gate; production wiring TBD).
- Real implementation of `@driftstack/webhook-delivery` (V-144 stubbed). Likely lands as part of a webhook-system v2 workstream when production volume justifies the more sophisticated queue/replication design.
- Real implementation of `@driftstack/webrtc-streaming` (V-149 stubbed). Phase 3+ work. Bundled into the GUI client live-view workstream OR exposed as a customer-facing live-preview surface in the dashboard once the WebKit driver supports the WebRTC offer/answer pipe end-to-end.
- Wire-up of multi-seat `account_users` + `account_invites` schema (V-142 designed; not implemented). Blocks the live `/v1/team/*` endpoints. Can land independent of webhook-delivery / webrtc-streaming work.
- Long-form ADRs for D-035 (admin scope at preHandler) + D-036 (team roles taxonomy). V-log + decisions.md cover the empirical detail; ADRs would be longer-form context for new contributors. Low priority — most ADRs in `docs/adr/` were written for architectural deviations from the original spec, and these two are extensions, not deviations.
