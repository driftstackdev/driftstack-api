# Tuesday pickup queue

> **⚠ SUPERSEDED — this is a snapshot of 2026-05-09, not current state.**
> V-827 checked the "do NOT pick up" list below against the repo and found
> two of its entries describe work that has since SHIPPED. A stale gate is
> not harmless: it tells the next engineer to leave a subsystem alone that is
> already built, which is a tax paid every time somebody reads the list.
> Both are corrected inline. Treat every other line here as of its date.

**Last updated:** 2026-05-09 (paused per founder cost-discipline)
**Resume condition:** founder explicit reactivation Tuesday (weekly
token reset).

Per Rule M minimum 2 P-track parallel slices on resume; per Rule K
NEVER STOP once reactivated. Per memory #18 sustained throughput
target 15-25 slices / 8h.

## Priority queue

### 1. F-001 — Mobile UI bug

**Awaits:** founder repro details (device + URL + screenshot).

Frontend issue. Surface unclear (marketing / dashboard / docs?).
Once details land, reproduce locally via Astro dev server +
mobile-viewport browser devtools, fix, redeploy via wrangler. Likely
candidates: tailwind responsive breakpoints, fixed-width sidebars,
overflow-x on long URL strings, signup form layout.

### 2. F-003 — OAuth (Google + GitHub) signup + signin

**Awaits:** founder registers OAuth apps + supplies Client IDs +
Secrets. Callback URL pattern:
`https://api.driftstack.dev/v1/auth/oauth/<provider>/callback`.

**Engineering scope (~6h):**

- `apps/server/src/lib/config.ts` — `GOOGLE_OAUTH_CLIENT_ID` +
  `_SECRET`; `GITHUB_OAUTH_CLIENT_ID` + `_SECRET`.
- New routes:
  - `POST /v1/auth/oauth/<provider>/initiate` (returns redirect URL +
    state nonce stored in Redis with 5-min TTL).
  - `GET /v1/auth/oauth/<provider>/callback` (consumes code, exchanges
    with provider, mints account if new email / signs in if existing).
- Provider handlers via `arctic` (modern lightweight OAuth lib; no
  Passport bloat).
- Account-lifecycle integration — OAuth-signups skip the
  email-verification step (provider already verified the email).
- Customer-dashboard sign-in / sign-up pages — "Continue with Google"
  / "Continue with GitHub" buttons hitting the initiate endpoint.
- Audit-log entries: `account.oauth_linked`, `account.oauth_signed_in`.
- Sub-processor disclosure update: Google + GitHub for the OAuth
  handshake (auth identifier only; no customer-data flow). Add to
  DPA Annex 3 + sub-processors.ts.
- Tests: TS SDK unit + integration; cross-SDK regression for the new
  endpoints.
- Docs: `/api/auth.md` extended with OAuth flow walkthrough.

### 3. V-294 catalog continuation

Per the locked priority order in
`docs/architecture/v294-feature-catalog.md`. Tier-1 candidates not
yet touched:

- **V-312 finish** — restore-from-snapshot UX flow polish.
- **V-313 finish** — clone history visualization.
- **V-298b** — region selection deepening (pricing/billing surfaces).
- **V-353 polish** — MFA cycle UX; recovery-code-regenerate
  confirmation, post-disable banner.
- **Account deletion full flow** — GDPR Article 17.
  **SURFACE-AS-BLOCKING** — touches retention windows; founder verdict
  needed on hard-delete vs soft-delete + retention duration.
- **Profile import/export** — customer convenience; format design
  surface-as-draft.
- **Per-tier feature gating** — pricing-tied; surface-as-blocking.
- **Stripe portal deepening** — billing-tied; surface-as-blocking
  (live keys gated on KvK; landing post-2026-05-21).
- **Webhooks UI polish** — delivery filter UX; rotate-secret confirm
  modal.
- **Audit-log filter extensions** — V-381/V-398/V-399 follow-on.

### 4. V-278.J-2 — Per-service Sentry projects

**Scope:** create dedicated `driftstack-dashboard` +
`driftstack-marketing` Sentry projects via the org auth token API.
Wire DSNs into the Astro builds (`PUBLIC_SENTRY_DSN_DASHBOARD` /
`_MARKETING`); Astro's `@sentry/astro` integration captures errors at
the Pages-Worker layer.

Current Sentry org token's scopes appear release-only; may need
re-issue with `project:write`. Verify on first call; surface scope
gap to founder if needed.

### 5. V-278.K — Neon prod + staging split

**Scope:** create a separate Neon project for staging (or branch the
current production project; Neon's branching is the cleanest path).
Update `staging.env` to point at the new connection string. Migrate
existing staging-prefix data forward (none yet; pre-launch).

### 6. V-278.L — Upstash prod + staging split

**Scope:** create separate Upstash database for staging. Update
`staging.env` UPSTASH_REDIS_REST_URL + REDIS_URL accordingly. Drop
the `stg:` key prefix in favour of physical isolation.

### 7. Apps/docs gaps

- **Marketing comparison page** — vs Browserless / Bright Data /
  ScrapingBee / Browserbase. Tone autonomous per memory marketing
  copy rule but content claims need careful framing.
- **Pricing detail expansions** — current `/pricing.astro` covers
  the locked tier table; could deepen with use-case examples + FAQ
  cross-links.
- **Public roadmap** — `/roadmap.astro` doesn't exist. Source from
  V-294 catalog selectively (don't expose internal V-NNN tags).
- **Status page indicator** — small badge on marketing showing
  current platform status (driftstack.dev fetches
  api.driftstack.dev/v1/status).
- **Onboarding flow polish** — welcome → trial-pack → first-key →
  first-session ergonomics review.
- **Trust center additions** — `/trust/security`, `/trust/compliance`,
  `/trust/incidents` carved from existing `/security.astro` content.
- **Security audit page** — already partially present at
  `/security.astro`; expand with details on encryption at rest, key
  rotation cadence, MFA enforcement.

### 8. Test coverage extension

- V-298b region preference roundtrip (server + 3-SDK).
- V-312 snapshot capture-then-restore happy path + tier-cap collision.
- V-313 clone naming auto-derivation.
- V-353 MFA enroll/verify/disable lifecycle.
- V-359 webhook secret rotation grace window (24h dual-sign).
- Cross-SDK regression for the V-455 closure additions (currently
  TS-only edge cases; mirror in Python + Go).

### 9. PLANNING-INDEX.md continuation

Per memory rule #12: when V-294 catalog saturates, consult
`/mnt/project/PLANNING-INDEX.md` (118 planning files). The catalog is
~50% saturated; expect this to land mid-Tuesday session.

## Items NOT to pick up without founder direction

- ~~**V-413** — Tier-3 IP/UA leak in account-audit payloads (security
  architecture; verdict pending).~~ **SHIPPED** — `routes/account-audit.ts`
  scrubs actor privacy fields (`issued_from_ip`, `source_ip`, `user_agent`,
  `issued_user_agent`) via `scrubActorPrivacy()` and nulls `user_agent` on
  the redacted read path. No verdict is pending (V-827).
- **Account deletion retention** (touches legal retention periods).
- **Per-tier feature gating** + **pricing details** (touches pricing).
- **Live Stripe keys** + **Stripe webhook secret** (touches commercial
  activation; gated on BV KvK closure ~2026-05-21).
- ~~**NowPayments / crypto rail** — ADR-002 deferred; provider not
  chosen.~~ **SHIPPED** — five `/v1/billing/crypto-*` routes are registered
  (checkout, quote, orders, order detail, cancel), with `crypto_orders` and
  `crypto_entitlements` tables behind them (V-827).
- **LiveKit** — Agent 1 territory.
- **Organic growth / paid acquisition / launch comms** — out of
  Agent 2 scope.

## Pre-resume sanity checks (Tuesday)

Run before picking up the queue:

```
git -C /Users/john/code/driftstack-api log -1 --oneline
git -C /Users/john/code/driftstack-api status --short
npm run typecheck && npm run lint && npm run format:check && npm test
ssh -o BatchMode=yes root@128.140.37.74 'systemctl is-active driftstack-api'
ssh -o BatchMode=yes root@116.203.22.197 'systemctl is-active driftstack-api'
curl -sS -o /dev/null -w "%{http_code}\n" https://api.driftstack.dev/health
curl -sS -o /dev/null -w "%{http_code}\n" https://app.driftstack.dev/
```

Expect: 1169+/1169+ tests pass, both systemd services `active`, both
URLs `200`. If anything regresses overnight, surface to founder before
picking up the queue.
