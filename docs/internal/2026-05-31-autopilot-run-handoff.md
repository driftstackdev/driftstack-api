# 2026-05-31 — Autopilot run handoff (Agent 2, driftstack-api)

Single pickup point for the 2026-05-31 autopilot run (founder "do it all" →
cron-`/loop` waves). Indexes what shipped, what's surfaced (with designs), what's
verified-clean, and the prioritized open queue. Companion:
`2026-05-31-autopilot-findings-and-open-decisions.md` (the founder-decision log).

## Shipped — runtime fixes/features (deployed; prod = HEAD)

- `1cd681b5` profile DELETE: idempotent (204 on re-delete) + retracted the
  unimplemented `force`/409 contract (founder Q1/Q2).
- `c4405268` SDK profile export/import/transfer across TS/Go/Python (+ parity).
- `e43d25d3` `suspend()` reclaims an account's running browser sessions.
- `b16c76e3` atomic Stripe tier update (`FOR UPDATE`) → dedups concurrent
  webhook deliveries (no claim-first / lost-event risk).
- `938ebf3a` BYOK: clear cached plaintext key on budget-exhausted session close.
- `7fa9a860` recapture scheduler: failed/cancelled runs → HIGH retry before the
  health classification (were mis-scheduled LOW).
- `c26e3835` recapture atlas: deterministic snapshot on equal `completedAtMs`.
- cost-alert dispatcher: state cycle-scoped — no spurious `resolved` at billing-cycle
  rollover (`2026-05-31-cost-alert-cycle-rollover.md`). LOW (deploy-masked).
- webhook delivery: reclaim orphaned `in_flight` rows (worker-crash/deploy mid-batch
  no longer silently loses a webhook) — migration-free via `updated_at`; durable claim
  - in-memory `processTick` + real-PG drizzle test. See surfaced #6.
- Stripe-driven tier change now invalidates the auth cache (`StripeWebhooksService`
  gained an optional `authCache` dep + `invalidateAuthCache`, called after
  `setAccountTier` on a real change in the updated+deleted handlers). The admin
  `changeTier` path already invalidated; the primary (Stripe) channel did not, so the
  cached `AccountContext` tier — and its derived rate-limit capacity — lagged the 30s
  `CACHE_TTL_SEC` after upgrade/downgrade/cancel. Guarded on `previousTier !== tier`
  (same condition as the audit emit) to avoid evicting on no-op payment-method-swap
  updates. +3 integration assertions (created-upgrade/deleted-downgrade invalidate;
  same-tier update does not). LOW (≤30s, self-healing, rate-limit-only — no auth/
  privilege impact); shipped as it mirrors an established pattern and is contained.
  See `project_auth_cache_tier_invalidation`.
- crypto-orders `createIdempotent`: closed a TOCTOU concurrent-race — the in-memory
  cache check + set straddle `await this.create()`, so two simultaneous same-key
  POSTs (double-click) both missed the cache and both created an order (violating the
  documented "duplicate POSTs replay the original" contract). Fix = a single-flight
  `idempotencyInflight` map (concurrent callers await the first in-flight create +
  replay it); +concurrent test (the existing tests only covered sequential replay).
  Idempotency-Key parser + per-account scoping verified sound; agent-sessions race
  was already RESOLVED (4f0002a5). LOW (crypto pre-launch/low-traffic; recoverable
  double-order not double-charge). The in-memory dedup's cross-INSTANCE/restart gap is
  the founder-deferred DB-backed follow-up (V-666.C "real merchant traffic"), surfaced
  not auto-done. See `project_crypto_idempotency_concurrent_race`.

## Shipped — infra / tests / docs (non-runtime)

- `400ae39d` profiles operationIds · `4bddde5a` sdk-python openapi.json resync ·
  `aed6a0db` snapshot↔live-spec structural drift guard · `d845d47e` models.py
  codegen resync · `f5343158` suspend-reclaim integration wiring + full-chain test ·
  `02830641`/`b5fa7a98`/`79a5f0ab`/`a99866c6` internal docs.
- profile-transfer: added the missing source-ownership IDOR guard — caller transfers a
  profile owned by a DIFFERENT account → 404 + profile NOT moved (single-app/shared-repo
  so it exercises the `findById` accountId scope, not just row-absence). Transfer's other
  tests were all recipient-side; clone had the equivalent, transfer did not. Fresh audit
  of profiles export/import/transfer otherwise SOUND (export metadata-only/no browser-state
  leak; import importer-scoped + fresh id + per-cycle anti-churn cap; transfer
  source-scoped + recipient-verified + quota-bounded; unilateral push deliberate). See
  `project_profiles_portability_audit_clean`.
- status-subscribe: behavioral single-use guard for the confirm token (subscribe→
  confirm→re-confirm = 404, unsubscribe token NOT rotated, no second welcome). The
  existing "404 on unknown / used token" test only exercised an UNKNOWN token; the
  re-use-after-confirm invariant (repo `markConfirmed` nulls `confirm_token_hash`)
  was unguarded — renamed that test for accuracy. See surfaced #10 +
  `project_status_subscribers_audit_clean` (subsystem otherwise CLEAN: 256-bit
  hashed tokens, double-opt-in, per-subscriber unsub, GDPR 90d purge).

## Surfaced — real findings, fixes need a focused (non-deep-session) pass

0. **[MEDIUM — FULLY RESOLVED 2026-05-31] Open-redirect class** —
   `2026-05-31-open-redirect-next-param.md`. All FOUR dashboard nav sites
   (`login` / `signup` / `verify-email` / the OAuth-client `callback` page) sanitize
   through `src/lib/safe-next.ts` (`safeNextPath`), AND the API `/start` rejects
   off-origin `redirect_to` at the source (shipped 08d6108f / 33f1e907 / 2c352c09).
   Pinned across 9 content/integration tests; build- + CI-deploy-verified. **No
   remaining items.**
1. **[HIGH — SURFACED 2026-05-31] `req.ip` is `127.0.0.1` in prod (trustProxy gap)** —
   `2026-05-31-trustproxy-gap-ip-rate-limit-and-audit.md`. Prod is
   CF→nginx(localhost)→Fastify but Fastify never sets `trustProxy`, so `req.ip` =
   `127.0.0.1` for every real request. ⇒ (a) the IP brute-force gate keys ALL
   traffic on `prefix:127.0.0.1` = one global bucket (no per-attacker isolation +
   latent 429 outage at launch scale), and (b) `auth.ts` records `127.0.0.1` as the
   session audit IP (9+ sites). nginx already sets `X-Real-IP`/`XFF` correctly; the
   gap is the missing Fastify `trustProxy`. **SURFACE-only** (global `req.ip` change
   touches the LOCKED XFF-leftmost stance + audit semantics + needs the real prod XFF
   chain verified to pick `trustProxy` safely; `config.host`=`0.0.0.0`). Fix options
   in the doc. **Likely the highest-impact open finding** — promote for a focused
   pass. Rate-limit core is otherwise sound (atomic Redis Lua, correct refill).
2. **[MEDIUM, latent-CRITICAL — SURFACED 2026-05-31] `PERMISSIVE_CORS=true` live in
   prod** — `2026-05-31-permissive-cors-in-prod.md`. Prod `.env` left the dev/webview
   escape hatch `PERMISSIVE_CORS=true` on, so `@fastify/cors` echoes ANY Origin with
   `Access-Control-Allow-Credentials: true` (curl-confirmed against
   `https://attacker.test`). MEDIUM today (API auth is bearer, not cookie → no authed
   cross-origin data theft); becomes CRITICAL if a data route ever accepts the
   session cookie. A blind `PERMISSIVE_CORS=false` flip BREAKS prod: `status.` +
   `admin.driftstack.dev` browser-call the API but are missing from the allow-list
   (the flag masked the gap). **Fix is outward-facing** (complete the allow-list →
   disable the flag → restart → verify). Shipped a safe non-breaking boot-time warn
   guard (`lib/cors-posture.ts`) this wave so it can't silently recur.
3. **[MEDIUM — two layers FIXED 2026-05-31; DNS-rebind SURFACED] Webhook delivery
   SSRF** — `2026-05-31-webhook-ssrf-outbound-target.md`. The server POSTs to a
   customer-controlled webhook URL. **FIXED:** (1) `redirect: 'error'` on all 3
   delivery fetch sites (no `30x → internal` bypass); (2) create + PATCH literal-IP
   block (`lib/webhook-target-guard.ts`, Node `net.BlockList` → `localhost` /
   private / loopback / link-local / reserved / `::ffff:` mapped → 400), exhaustive
   unit test (public-IP boundaries = no false-positive) + integration + content-parity
   pin. **REMAINING:** connection-time DNS-rebind resolve+pin in the delivery fetch
   (a create-time hostname check can't stop rebind) — undici custom connector /
   ssrf-safe-fetch. MEDIUM (blind/semi-blind: delivery log is a status/timing oracle,
   no body exfil).
4. **[MEDIUM — app-log + Sentry FIXED 2026-05-31; nginx + design SURFACED] SSE
   `?ds_token=` / OAuth `?code=` in logs** — `2026-05-31-sse-token-in-logs.md`.
   The SSE auth bearer rides in the URL query (EventSource can't set headers); it
   leaked plaintext into the Fastify request log (`req.url`), Sentry (auto
   `event.request.url` + 5 explicit `request.url` passes), and the nginx access log.
   **FIXED:** `lib/redact-url.ts` wired into a pino `req` serializer (verified Fastify
   5 honors the loggerInstance serializer) + `scrubSentryEvent` + all sentry
   `request.url` passes. **REMAINING:** nginx `log_format` (infra) + the proper design
   — a short-lived single-use SSE ticket instead of the real bearer in the URL.
5. **[MEDIUM — per-challenge cap FIXED 2026-05-31; per-account lockout SURFACED] MFA
   challenge brute-force bound** — `2026-05-31-mfa-challenge-not-attempt-bounded.md`.
   **FIXED:** `completeMfaChallenge` now bounds wrong codes per challenge token —
   `MfaChallengeStore.incrAttempts` (Redis atomic `INCR`+`EXPIRE` / in-memory counter)
   - at `MAX_MFA_CHALLENGE_ATTEMPTS = 5` the token is consumed → forces a fresh
     `/login`. Not a per-account lockout (no legit-user DoS). Unit + integration tests
     (after 5 wrong, even the correct code fails) + content-parity pins. TOTP / recovery
     codes / token entropy were already SOLID. **REMAINING (optional):** a dedicated
     tighter rate-limit gate for `/mfa/challenge` (meaningful once trustProxy is fixed →
     per-IP) + per-account lockout (founder policy).
6. **[MEDIUM — FIXED 2026-05-31, migration-free] Webhook orphaned-`in_flight`
   reclaim** — `2026-05-31-webhook-orphaned-inflight-reclaim-gap.md`. A worker crash /
   deploy mid-batch left deliveries stuck `in_flight` forever → silently lost.
   **FIXED:** the durable claim already sets `updated_at = NOW()`, so the claim SELECT
   now also reclaims `status='in_flight' AND updated_at <= now - 5min` (≫ the 10s
   timeout) — **no `claimed_at` column / migration needed** (that was the only reason
   this had been deferred). In-memory `processTick` reclaims a stuck in_flight row
   whose lease expired (parity). Real-PG drizzle test (CI-only) + content-parity pins.
7. **[LOW] Auth-flow consume race** — `2026-05-31-auth-flow-token-audit.md`.
   `consumeAuthToken` returns void → concurrent same-token submit lets both
   callers act (benign-to-minor). Needs a loser-behaviour decision.
8. **[LOW — DONE 2026-05-31] BYOK cache clear-on-close guard** — guards `938ebf3a`.
   Added `byok-clear-on-close-guard.test.ts` (source-pin drift-guard for the message
   route's `if (result.session.status === 'closed') byokKeyCache?.delete(...)` clear +
   its rationale comment) — the fix was previously unguarded (only the cache CLASS was
   unit-tested). A full behavioral test still needs `buildTestApp` to expose
   `byokKeyCache` + drive a budget-exhausted turn; the source-pin is the lightweight
   regression guard.
9. **[LOW — FORWARD, not live] recipe-library credential leak at Phase-3 wiring** —
   `2026-05-31-recipe-library-credential-leak-forward.md`. `packages/recipe-library`
   is unwired scaffolding (mock runner). `RecipeStep` type-steps inline plaintext
   (`buildLoginRecipe` password) and `RecipeStepResult` embeds the full step, so a
   real runner that logs/persists results (Phase 3) would leak creds — same class as
   the SSE-token log fix. At wiring: redact type-step `text` in results (reuse the
   V-494 / `lib/redact-url.ts` posture) + prefer runtime vault-injection. Builders +
   mock otherwise clean.
10. **[LOW-MEDIUM — SURFACED 2026-05-31; founder/legal] Status-subscription
    unsubscribe-token rotation breaks older email unsubscribe links** —
    `project_status_subscribers_audit_clean`. The incident-notification fan-out
    (`incident-notifications.ts:99` `rotateUnsubscribeToken`) rotates the unsubscribe
    token on every send, so each new incident invalidates ALL prior unsubscribe links
    (the welcome email's link breaks on the first incident). CAN-SPAM §316.5 wants the
    opt-out functional ≥30d post-send; GDPR Art. 7(3) wants withdrawal as easy as
    consent. Recipients can still unsub via the LATEST email or re-subscribe-then-unsub
    (LOW-MEDIUM + low frequency). Rotation is architecturally forced (only the token
    HASH is stored → the fan-out must mint a fresh plaintext to embed). Fix = an
    HMAC-derived stable per-subscriber token (recomputable, never stored plaintext,
    every email's link works) OR keep-N-recent-valid — a token-scheme redesign with
    compliance + List-Unsubscribe-One-Click implications → **founder/legal decision,
    don't auto-flip**. Rest of the subsystem is CLEAN (see Verified-clean + the shipped
    single-use guard above).
11. **[LOW — SURFACED 2026-05-31; defense-in-depth, founder call] GitHub OAuth
    `/user.email` trusted without explicit `verified` cross-check** —
    `project_oauth_client_flow_audit_clean`. `lib/oauth-client-exchange.ts:215` uses
    the GitHub `/user.email` field when non-empty and hardcodes `emailVerified: true`
    (line 265), skipping the `/user/emails` `verified === true` check that the
    email-private fallback DOES perform (line 240). Relies on GitHub's invariant that
    a _public profile email must be verified_. NOT a confirmed vuln (and the
    collision→merge-verification gate independently blocks takeover of existing
    accounts — only residual is create-new email squatting). The robust fix (always
    derive the email from the `/user/emails` primary+verified entry) adds a
    fail-open-vs-closed tradeoff on `/user/emails` fetch errors + an extra API call
    per login, guarding a case GitHub's invariant already prevents → founder/UX call,
    not a blind auto-ship to the auth path. The rest of the OAuth client flow is SOUND
    (see Verified-clean).

## Verified clean — do NOT re-audit (re-sweep = churn)

BYOK crypto + route, auth-flow tokens, webhook delivery worker, recapture
scheduler/atlas/matrix (`dedupKey` correctly NUL-joins), `suspend`/data-lifecycle
cascades, Stripe tier-update — plus the prior-session sweeps (IDOR/auth/
payment-sig/input-validation/error-handler, money-path, all 3 SDKs). 2026-05-31
correctness audits: SSE event-bus + all 3 consumer routes (proper close+error
cleanup, unsubscribe, `heartbeat.unref()` — no subscriber leak); pagination
`limit` caps (all `min(1).max(100)`, admin crypto-orders `max(500)`); and the crypto
(NOWPayments) IPN → order state machine (`2026-05-31-crypto-ipn-state-machine-clean.md`
— conservative status map: only `finished`→paid, `partially_paid`→non-granting
`partial`; idempotent paid-grant on transition only; `isTerminalForward` blocks
out-of-order downgrades — no underpayment/double-grant/revive). Stripe subscription →
tier lifecycle (`2026-05-31-stripe-subscription-lifecycle-clean.md` — tier set only on
active/trialing so `past_due` keeps access through dunning; `customer.subscription.deleted`
→ downgrade to free; unknown price never grants; re-delivery idempotent; deleted-driven
downgrade is correct, status-based would risk false-downgrade). Rate-limit OVERRIDE
subsystem (`project_rate_limit_overrides_clean`) — admin SET
(`POST /v1/admin/accounts/:id/quota-override`, `requireScope('driftstack_internal_admin')`)
is bounded (capacity 1..1M, refill 0.01..100k, duration 1s..30d → no 0/negative
div-by-zero); customers are GET-only (`/v1/account/rate-limits` view, no self-raise);
expiry lazily falls through to tier default. (Distinct from the rate-limit core /
trustProxy work.) Transactional-email SEND + bounce surface
(`project_email_send_bounce_clean`) — reset/magic-link/resend `findAccountByEmail` +
early-return WITHOUT sending when no account (magic-link also skips non-active), so no
relay/bomb to arbitrary addresses; anti-enumeration + per-IP rate-limited; and there
is NO inbound Postmark bounce webhook (suppression is Postmark-side → no fake-bounce
DoS surface). Status-site PUBLIC incident read (`project_status_incident_public_read_clean`)
— no-auth `GET /v1/status/incidents(+/:id)`: list route FORCES `scope:'public'` into the
parsed query (a client `?scope=all` can't escalate) + 30d default `since`; detail passes
`publicOnly:true` → repo adds `eq(public,true)` → non-public OR missing id both 404
(same-shape anti-enumeration, documented inline); the `publicIncident()`/
`publicIncidentUpdate()` mappers are explicit allow-lists that OMIT `createdByAdminId`/
`createdByAdminKeyId`/`autoProbeTarget` (last = internal infra monitoring target). The
_selection_ invariants were tested but _field-exclusion_ was unguarded → added a behavioral
guard (`ea8775f1`: exact public key-set + explicit `not.toHaveProperty` for the 3 sensitive
cols, both casings) in `tests/integration/admin-incidents.test.ts`. Public status-page
email-subscription (`project_status_subscribers_audit_clean`) — 256-bit `generateAuthToken`
tokens stored as sha256 hash, double-opt-in gates the notify list, confirm token SINGLE-USE
(`markConfirmed` nulls the hash — verified + now guarded), per-subscriber unsubscribe token,
GDPR 90d email purge (one LOW-MED surface, #10). OAuth client sign-in/link flow
(`project_oauth_client_flow_audit_clean`, V-667.C Google+GitHub) — `/start` `redirect_to`
origin-validated + PKCE S256 + HMAC state + HTTP-only signed cookie; `/callback` verifies
state (CSRF) + PKCE + email_verified; **collision→merge-verification blocks account
takeover** (an OAuth email matching an existing account issues a proof-of-control token to
that account's inbox, never auto-links); revoked-link no auto-signin (one LOW surface, #11).
Profiles export/import/transfer portability (`project_profiles_portability_audit_clean`,
V-480/V-666) — export metadata-only (no browser-state leak); import importer-scoped + fresh
id + per-cycle anti-churn cap; transfer source-ownership-scoped + recipient-verified +
recipient-quota-bounded (added the missing source-ownership IDOR guard, `1f13234b`).
Usage-metering + cost-aggregation (`project_usage_cost_aggregation_audit_clean`) — `usage.ts`
is a READ-ONLY summary; per ADR-004 ALL TIER_QUOTAS are `null` (unmetered — paid tiers
concurrent-only; trial_pack credit retired) and usage_records writers aren't wired in prod,
so there's NO quota enforcement/race to fix (don't "fix" the deliberate nulls).
`cost-aggregator.ts` (V-541.H `UsageAggregatorFromUsageRepo`) is the usage→cost-estimator
INPUTS bridge — fills `sessionMinutes` from real usage and returns zero placeholders for the
not-yet-built meters (storage/egress/email/llm tokens), with a safe `billingCycleWindow`
parse (null on malformed). `cost-estimator.ts` (V-658) is the pure cost math — verified
SOUND: integer CENTS with caller-injected `CostRates` (admin UI is the rate
source-of-truth, NOT hardcoded), all inputs clamped non-negative (NaN/Infinity/negative →
0, no negative-cost exploit), round-half-up per line, hard-then-soft `classifyThreshold`,
per-tier EUR `DEFAULT_TIER_THRESHOLDS`. `cost-monitoring.ts` (V-541.B) verified SOUND:
compute-on-demand admin read (no persistence — cost_snapshots is V-541.C), fail-closed
(`getAccountSummary` → null when usage OR tier is null), threshold fallback
`[tier] ?? api_starter ?? {0,0}`, `getOverview` sorts desc, `getConfig` read-only.
`routes/admin-cost.ts` verified SOUND: all three routes
(`/overview`, `/config`, `/:accountId`) gated `requireScope('driftstack_internal_admin')`
(operator-only); the `:accountId` param strips the `acc` prefix to a bare uuid. No code
change needed — the routes were already clean. (An earlier draft of the prior commit
wrongly claimed a dead-import removal here; there was no such import, so nothing was
changed.)
**COST LAYER FULLY AUDITED** (usage → aggregator → estimator → monitoring → admin route);
vein exhausted, pick a non-cost subsystem next. NB: the `usage-quota.ts` / `cost-rates.ts` /
`microsToUsdString`/`RATES_MICROS` do not exist (the estimator is cents + injected rates).
Team-RBAC multi-tenant authz (`project_team_rbac_audit_clean`, V-298/V-326) — invite
token 256-bit hashed + 7d + **email-bound accept** (accepting account's email must match
the invitee → no token-forward-to-wrong-account), owner-scoped removal (no cross-account
delete); members act on the owner via the `X-Driftstack-Account` header and the admin-role
write-gate is **consistent across all 7 honoring routes** (members read, admins write —
verified profile-snapshots capture/restore/delete all admin-gated, no privilege gap);
membership changes invalidate the member's auth cache. Well-tested (no gap):
`team-rbac-auth-path.test.ts` asserts member→403 on writes + reads-as-member.
Bundled-LLM settings (`project_bundled_llm_audit_clean`, Arc 1 sub-slice 6.3) — the
read/update layer for the optional shared Driftstack-Anthropic key. `BundledLlmSettings`
= `{ consent, monthlyCapUsdCents }` (migration 0050); `findSettings` (null → route
short-circuits 502 if no BYOK leg resolved), `sumMonthlySpendCents` (sums
`usage_records.cost_usd_cents` for `agent_decomposer_bundled` since UTC month-start),
`updateSettings` (PATCH). Q4=A LOCKED: BYOK ALWAYS wins; bundled resolves only when no
BYOK plaintext — that chain + the per-month **cents** soft-cap enforcement live in
`routes/agent-sessions.ts`, NOT this pure settings service. The route-side enforcement +
resolution chain is the remaining un-audited piece.

## Founder-gated — surface only, do NOT auto-do

- `agent_sessions` **strict FK** — breaking (rejects currently-valid creates;
  format change + backfill). Design decision: strict FK vs intentional loose ref?
- **iphone16pro → iphone17 archetype cutover** — canvas-close-gated (Agent-1);
  surface, don't flip.

## Prod state (Rule-L, latest wave)

Deployed SHA = HEAD (`ea8775f1` after the status-incident field-exclusion guard;
prior `/version` showed `0adedd6` healthy), service active, 0 restarts, ~0 real
errors/2h, self-re-arming scheduled jobs alive. Healthy.

## Recommended order when the loop is paused

1. ~~Open-redirect `?next=` fix~~ — **DONE** (33f1e907, all 3 auth pages; see #0).
   Optional tail: API `/start` `redirect_to` dashboardOrigin restriction
   (defense-in-depth, can ride a server wave).
2. Webhook reclaim — fully spec'd, just needs focused implementation.
3. A founder call on strict-FK and/or the archetype cutover.
4. BYOK cache test + auth-flow consume hardening (low priority).

> Autopilot note: by ~wave 8–9 the high-value, safe, un-mined Agent-2 audit
> surface was exhausted; value-per-wave declined and a deep-session misread
> occurred (recovered). Converting this queue into shipped work is best done in a
> fresh, focused session rather than continued audit-cadence waves. By ~wave 15 the
> remaining un-audited packages are unwired Phase-3 scaffolding (recipe-library /
> behavioural-simulation); live findings are mostly surfaced above awaiting
> founder/focused action.

> Continuity-hygiene TODO (deliberate pass, not a deep-autopilot edit): the
> auto-memory index `MEMORY.md` is ~31KB, over the ~24KB load cap, so it loads only
> partially at session start (recent entries at the tail may not surface). This
> handoff doc is the reliable working index meanwhile. A focused pass should
> consolidate the ~18 clearly-RESOLVED project one-liners into a single digest
> pointer (their detail lives in topic files + this doc's Shipped/Verified-clean
> sections), preserving every `feedback_*` rule + OPEN/SURFACED + active-arc entry.
> Not done in-wave: `MEMORY.md` isn't version-controlled, so a botched rewrite is
> irreversible — it deserves explicit care.
