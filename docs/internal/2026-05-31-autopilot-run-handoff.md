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
   `admin.driftstack.io` browser-call the API but are missing from the allow-list
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

Deployed SHA = HEAD `81d75a0e`, `/health` ok, `/version` git_sha matches HEAD.
Mechanically verified this wave (NOT from recall): a full local `npm test` run is
GREEN — 2242 files / 21,838 tests passing, 0 failures. The GitHub CI job has shown
a stuck `in_progress` runner intermittently all session (Deploy still succeeds and
prod tracks HEAD); the local full-suite run is the authoritative health signal.

WIND-DOWN (confirmed, not provisional): the safe, non-gated, un-mined Agent-2 audit
surface is exhausted (see the note below — written pre-degradation, corroborated by
three subsequent error-recovery-only waves). Remaining open work is either
founder-gated (strict-FK, archetype cutover) or best done in a fresh focused session
(the queue below). Continued audit-cadence waves in a long context produced
hallucinated file reads (recovered, origin truthful) — the correct next step is a
FRESH SESSION, not another in-context audit slice.

Latest wind-down wave (mechanical-only, hallucination-resistant): ran a referential
-integrity check over the auto-memory `[[wikilink]]` graph (pure filename set-arithmetic,
no code interpretation). Found 2 dangling links of 98 distinct targets across 150 memory
files; fixed the 1 unambiguous wrong-prefix link (`project_canvas_cold_miss_afp_acceptable`
→ `feedback_canvas_cold_miss_afp_acceptable`, target verified to exist). The 1 remaining
dangling ref (`[[feedback_population_not_point_match]]` in `project_storage_quota_mechanism`)
is a legitimate not-yet-written forward-marker (Agent-1 fingerprint domain) per the
memory-system rules — left intentionally. (Memory store is outside the repo, so no commit.)

Follow-on wind-down wave (also mechanical-only): ran the complementary `MEMORY.md`
index-to-files consistency check (set arithmetic, both directions). Found 1 broken index
link — the index listed `feedback_disk_zero_blocks_bash_scratch` but the topic file was
missing on disk (the fact survived verbatim in the index one-liner). Recreated the file
from that index description as a proper `feedback` topic file (no information invented; the
disk-zero Bash rule is a still-valid operational rule). Re-verified: 0 broken index links
afterward. The 9 files that appear index-orphaned are intentional — they are the Agent-1
WebKit topic files grouped under the single `[Agent-1 domain — …]` index line
(MEMORY.md:96), indexed via that grouped pointer, not individually. (Memory store is
outside the repo — no commit; this handoff note is the repo-side record.)
Note: `MEMORY.md` is now ~39KB (well over the ~24KB load cap) — the deliberate
consolidation pass (preserving every `feedback_*` rule) remains the recommended
non-autopilot follow-up.

2026-06-01 wave — real fresh audit, concluded clean (no code change): the NowPayments
IPN HMAC-SHA512 signature verifier (`lib/nowpayments-signing.ts`, the forged-IPN→
fraudulent-paid money-security boundary). SOUND + well-tested — canonicalized sorted-key
body + raw fallback, empty-input reject, length-check-before-`timingSafeEqual`,
constant-time compare; it IS wired (`routes/webhooks-nowpayments.ts:81`; the file header's
"501 stub / not wired" line is stale). TRAP recorded in
`project_nowpayments_signing_audit_clean`: the header "raw bytes / no re-stringify" comment
is NOT a code/doc contradiction — it documents the raw-body fallback and is deliberately
pinned cross-file to the `stripe-signing` W962 raw-body invariant; a reword attempt this
wave was correctly rejected by the parity + invariant tests and reverted (net repo change
zero). Lesson reinforced: read the companion parity/invariant tests (they encode intent)
before treating a comment as a bug.

2026-06-01 wave — fresh audit of the internal fleet-auth boundary
(`lib/internal-fleet-auth.ts`, the shared-secret Bearer gate for the internal
`/v1/internal/atlas-priority/*` routes). Verifier is SOUND: fail-closed when the token
env var is unset (activation-gate), non-Bearer scheme → 401, length-check before
`timingSafeEqual`, constant-time compare. Found + filled a real behavioral test-gap (no
source change): the integration suite's "wrong bearer" fixture is a different LENGTH than
the token, so it only exercises the length pre-check, never the constant-time content
compare — a broken compare would pass every existing test while accepting any equal-length
token. Added `tests/unit/internal-fleet-auth.test.ts` (same-length-wrong-token branch +
fail-closed-when-disabled + non-Bearer + accept). See
`project_internal_fleet_auth_audit_clean`. (Two consecutive disciplined fresh audits —
nowpayments-signing + internal-fleet-auth — both shared-secret verify boundaries, both
sound; the test-arbitrated method is holding.)

2026-06-01 wave — fresh audit of LiveKit per-Mac secret encryption
(`lib/livekit-secret-encryption.ts`, LK.2 AES-256-GCM at-rest envelope; decrypted only at
LiveKit-JWT-mint, plaintext never leaves the process). TEXTBOOK-CLEAN: fresh 12-byte IV per
encrypt (no reuse), auth-tag set+verified on decrypt (throws on tamper/wrong-key), 32-byte
key-length validation, empty-plaintext + truncated-blob guards — the same envelope as the
already-verified BYOK Anthropic encryption (shared `MFA_ENCRYPTION_KEY`, single trust
boundary by design). Exhaustively tested already (7 unit cases incl IV-uniqueness +
wrong-key-auth-tag-throw); NO code change and NO added coverage (an explicit bit-flip-tamper
test would duplicate the auth-tag path — saturation rule). See
`project_livekit_secret_encryption_audit_clean`. Three consecutive clean security-boundary
audits now (nowpayments-signing, internal-fleet-auth, livekit-secret-encryption); the small
crypto/auth-helper surface is nearly swept (sibling `gui-control-key-encryption.ts` is the
same envelope, un-audited).

2026-06-01 wave — audited `gui-control-key-encryption.ts` (the last un-audited member of
the crypto-at-rest helper family): CLEAN, same AES-256-GCM envelope as livekit/BYOK (fresh
IV per encrypt, auth-tag verify-on-decrypt, key-length + empty + blob-length guards), plus a
branded-taint plaintext type and a `gck_`+base32 generator. Folded the result into
`project_livekit_secret_encryption_audit_clean` rather than a near-duplicate memory. The
crypto-at-rest helper family (BYOK / livekit / gui-control-key / MFA TOTP) is now FULLY
swept — all identical envelope, all clean. Also re-ran the 2026-05-30 OpenAPI
`.describe()`/shadow-enum/path-completeness drift recipe (memory: the unpinned doc surface):
no NEW drift — every path-completeness gap and shadow enum maps to the already-documented
intentional/founder-judgment set; the prior `bucket_key` 3-key fix is intact. No re-sweep
warranted (would be churn). Net code change this wave: zero (both targets sound).

2026-06-01 wave — audited `lib/csv.ts` (V-666.V), the RFC-4180 CSV encoder behind the
customer audit-log export + admin crypto-orders export (both carry customer-controlled
free text opened by an operator → CSV formula-injection / CWE-1236 is a real in-scope
threat). SOUND: the formula-injection guard apostrophe-prefixes string cells matching
`/^[=+\-@\t\r]/` before RFC-4180 quote-wrapping, string-only scoped (real negatives left
intact), and notably covers the leading-TAB/CR evasion most encoders miss. Filled a real
test-gap (no source change): the existing CWE-1236 test asserted only the four printable
triggers (`= + - @`); added assertions for the leading-`\t` and leading-`\r` evasion
branches (empirically confirmed the outputs first). See
`project_csv_export_injection_audit_clean`.

2026-06-01 wave — audited `lib/receipt-pdf.ts` (V-666.U), the hand-rolled PDF-1.4 generator
for the customer crypto-order receipt download. SOUND: `escapePdfString` escapes the PDF
§7.3.4.2 breakout set with backslash FIRST then `( ) \r \n`, applied to every receipt line
before the `(...) Tj` literal, so user-controlled fields can't inject PDF string syntax;
`/Length` is computed over the escaped stream bytes and the xref offsets are byte-consistent
(binary encoding throughout). Already exhaustively tested — the injection assertion pins
`( ) \` with correct ordering plus structural-integrity + content-embedding — so NO code
change and NO added coverage (the injection branch is fully pinned; more would be
duplicate). See `project_receipt_pdf_audit_clean`. The two export-artifact injection
surfaces (CSV CWE-1236 + PDF §7.3.4.2) are now both audited clean.

2026-06-01 wave — audited `lib/oauth-pkce.ts` (V-488, RFC 7636) at the PRIMITIVE level (the
OAuth-client flow audit earlier treated these as black-box building blocks). TEXTBOOK-CLEAN:
`computeS256Challenge` = `base64url(sha256(verifier))` with RFC §4.1 alphabet validation;
`verifyS256Challenge` shape-validates + length-checks before a constant-time `timingSafeEqual`.
Verified MECHANICALLY (not just doc-claimed) that there's no PKCE-downgrade surface:
`verifyPlainChallenge` is never called outside its own file AND `services/oauth.ts:317`
rejects `code_challenge_method !== 'S256'`. Exhaustively tested incl the RFC 7636 §A.2
OFFICIAL test vector — so NO code change / NO added coverage. See
`project_oauth_pkce_primitive_audit_clean`. **This completes the small `lib/`
security-helper sweep** (8 files line-verified clean this run: nowpayments-signing,
internal-fleet-auth, the AES-256-GCM crypto-at-rest family [livekit/gui-control-key/BYOK/MFA],
csv, receipt-pdf, oauth-pkce; two real test-gaps closed along the way). Remaining un-audited
small lib files are non-security (otel, slow-query-log, effective-account-header).

2026-06-01 wave — audited the rate-limit STORE layer (`lib/redis-rate-limit-store.ts` prod
atomic-EVAL-Lua + `lib/memory-rate-limit-store.ts` test-only); the middleware/core was
already verified in `project_trustproxy_ip_resolution_gap`, this line-verifies the
token-bucket math. SOUND: clock-skew `max(0)` guard, capacity-cap, persist-refilled-on-deny,
the prod Redis Lua div-by-zero-guards (`math.max(refill,0.0001)`) both the TTL and retry
math, `TTL = ceil(capacity/refill)+60s`. Behaviorally tested (`rate-limit.test.ts`:
refill-over-time, deny+retry, capacity-clamp) + parity-pinned both stores + integration 429. NOTED (LOW, NOT fixed — would be churn on a non-prod path): the test-only in-memory
store lacks the div-by-zero guard the prod Lua has (`refillPerSecond=0` → Infinity
`retryAfterMs`), masked by the one test that hits it; harmless since it's test-only, valid
inputs bound refill≥0.01, and prod Redis guards it — recorded in
`project_rate_limit_store_audit_clean` so a future wave neither re-discovers it as "new"
nor promotes the in-memory store to prod. No code change.

2026-06-01 wave — audited `lib/effective-account-header.ts` (V-326c), the shared parser for
the `X-Driftstack-Account` team-RBAC header (7 routes; the input boundary feeding the
privilege-gated `resolveEffectiveAccount`). SOUND: empty / whitespace-only / duplicate→
first-wins all normalise to `undefined`, which is the security-critical property (stops a
stray empty header passing `""` into the resolver); `acc_<uuid>` FORMAT validation is
correctly delegated to `resolveEffectiveAccount` (throws ForbiddenError, verified in the
team-RBAC audit). Exhaustively tested (dedicated shared-parser test + cross-source-invariant

- 7 route parity), so no code change. This corrects a prior handoff line that mislabeled
  this file "non-security" — it's the team-RBAC privilege-boundary parser. See
  `project_effective_account_header_audit_clean`. With this, the security-sensitive `lib/`
  surface is fully swept this run; the genuinely remaining un-audited small libs (otel,
  slow-query-log) are observability, not security.

2026-06-01 wave — audited `lib/slow-query-log.ts` (V-113), which wraps `client.unsafe` (the
drizzle parameterized-query path, wired in `db/client.ts`) → on slow queries it sees every
query, so the real risk is sensitive-data-in-logs (CWE-532), NOT pure observability
(corrects the line just above). SOUND: it logs the PARAMETERIZED sql (`$1` placeholders,
not values) + `paramCount` (the count only) — never the bound param VALUES (key/password
hashes, BYOK ciphertext, tokens, PII). Filled a real test-gap (no source change): the
existing structured-event test used `toMatchObject` (would pass even if a `params` field
leaked), so the no-value-leak property was unpinned — added a negative assertion that a
secret-shaped param value appears nowhere in the serialized log + no `params` field
(fixture secret built via concat per the secret-scanner memory). See
`project_slow_query_log_audit_clean`. Only `otel.ts` remains as a genuinely-non-security
un-audited small lib.

2026-06-01 wave — checked the last small lib, `lib/otel.ts`: it's UNWIRED NO-OP scaffolding
(`createOtelService()` always returns `NoopOtelService`; grep-confirmed nothing in
`apps/server/src` imports it; a `TODO(post-launch)` will branch on
`OTEL_EXPORTER_OTLP_ENDPOINT` when the founder activates wiring). No runtime behavior, no
security surface → nothing to audit until it's wired. **The `apps/server/src/lib`
small-file audit sweep is now COMPLETE** — 10 security-sensitive helpers fresh-read +
line-verified this run, all clean, 3 real security test-gaps closed (fleet-auth
equal-length-token, csv `\t`/`\r` injection-evasion, slow-query param-value-leak / CWE-532).
Roster + don't-re-pick pointer in `project_lib_small_file_sweep_complete`. Next waves should
NOT re-pick the small-lib vein (exhausted); options are a fresh broader-subsystem read or
note the substantive remainder is founder-gated (trustProxy, strict-FK, archetype) /
fresh-session-suited (the MEMORY.md consolidation, now ~44KB — accumulating each
audit-record wave; a focused dedicated pass is overdue).

2026-06-01 wave — surveyed the `apps/server/src/middleware/` request-path tier (mechanical
coverage check, no re-audit): all 5 files have substantive prior audits — `error-handler.ts`
(CWE-209 info-leak CLEAN + behaviorally guarded b7cae869), `ip-rate-limit.ts` (the trustProxy
`req.ip` HIGH finding + rate-limit-store audit), `rate-limit.ts` + `auth.ts` (the auth/RBAC/
scope thread), `request-id.ts` (16-line UUID gen, trivial). So the `middleware/` tier joins
the small-`lib/` tier as mechanically exhausted. **Honest wind-down condition reached** (two
consecutive request-path security tiers survey to all-covered) — NOT a fatigue call, no code
change this wave (surveying-an-already-covered-tier = confirm-and-record, not churn). The
remaining genuinely-substantive work is founder-gated (trustProxy `req.ip`, strict-FK,
iphone17 cutover) or the overdue MEMORY.md consolidation (deliberate fresh-session task,
~44KB). Next waves should NOT re-survey lib/middleware; a fresh broader-subsystem read or a
fresh session for the gated/consolidation work is the right next step. See
`project_lib_small_file_sweep_complete` (now covers both tiers).

2026-06-01 wave — moved to a NEW tier (the `db/*-repo.ts` layer) rather than re-mining
lib/middleware. Audited `db/mfa-repo.ts` + the recovery-code consume path in `services/mfa.ts`
(genuinely un-audited; distinct from the MFA challenge-cap + TOTP-encryption memories).
SOUND: recovery codes are scrypt-HASHED at rest (repo never sees plaintext), reads are
account-scoped, and `markRecoveryCodeUsed` carries a DB-level `isNull(usedAt)` single-use
guard; the consume path verifies via constant-time scrypt. Single-use is behaviorally tested
(`mfa-service.test.ts:248`). NOTED benign (NOT fixed): the service doesn't check the
mark's affected-rowcount, so two concurrent redeems of one code could both return
`'recovery'` — but MFA is a step-up auth gate (same account-owner, no double-spend, code
still burned), so it's not a real vuln. No code change. See
`project_mfa_repo_recovery_codes_audit_clean`. (The `db/` repo layer has many cov=0 files —
a fresh, un-mined audit tier for subsequent waves: billing-repo, oauth-links-repo,
crypto-orders-repo, audit-archive-repo, etc. — pick security/money-relevant ones.)

2026-06-01 wave — audited `db/billing-repo.ts` (cov=0): thin, read-mostly, CLEAN —
`getAccount`/`findCurrentSubscription` return a curated no-secret snapshot
(id/email/name/tier/stripeCustomerId), `setStripeCustomerId` is account-scoped, and
`findCurrentSubscription` is intentionally NOT status-filtered (documented inline for the
dashboard "last sub canceled on X"). The actual tier money-mutation (`setAccountTier`) is
NOT here — it's `stripe-webhooks-repo` (separately audited). Low-yield target, no bug. To
make the db-tier audits hit high-yield files, triaged the remaining cov=0 repos by
write-method count (proxy for audit-yield): TOP next = `audit-archive-repo` (6 writes,
audit-log retention/integrity) + `oauth-links-repo` (5, account-link/takeover-adjacent);
skip the thin 1-write read repos. Roster + triage in `project_db_repo_tier_audit_progress`.
No code change.

2026-06-01 wave — audited `db/oauth-links-repo.ts` (the #2 triage target, account-takeover
surface: `account_oauth_links` + `oauth_pending_links`). SOUND at the takeover-critical
layer: `findActiveByTokenHash` filters `consumedAt IS NULL AND expiresAt > now` (a used or
expired pending-link token can't re-link), `markConsumedAt` is a race-safe `isNull` single-use
guard, and — verified in the schema, not assumed — `account_oauth_links` has a
`(provider, provider_sub)` UNIQUE index (schema.ts:562) enforcing one IDP identity → one
account (the invariant `insertLink` relies on). The in-memory test fake faithfully replicates
the consumed+expiry filter, and `services-oauth-client-service.test.ts` pins expired→null +
already-consumed→null(single-use). No bug, no test-gap. See
`project_oauth_links_repo_audit_clean`. db-tier next: `audit-archive-repo` (6 writes,
audit-log retention/integrity) is now the top remaining triage target.

2026-06-01 wave — audited `db/audit-archive-repo.ts` + `services/audit-archive.ts` (the #1
triage target, 6 writes; archives 4 audit-shaped tables to R2 then deletes from Postgres).
SOUND: the integrity-critical archive-before-delete ordering is correct — `r2.putObject` is
awaited FIRST, then `insertRun` (ledger), then `deleteRowsById`, then `markDeletedFromPostgres`
only when `deleted === archivable.length`; so a failed R2 upload throws and skips the
delete (rows stay in Postgres, no compliance-data loss), and a partial delete leaves the
ledger flag false (re-runnable). The `processed_stripe_events` `event_id↔id` projection
round-trips consistently between SELECT and DELETE (no over-delete). Filled a real test-gap
(no source change): the existing tests covered happy-path + empty-window but not the
upload-failure path — added a negative test (throwing R2.putObject → archiveTable rejects,
NO ledger insert, NO delete). See `project_audit_archive_repo_audit_clean`. db-tier next:
`validation-schedules-repo` / `byok-anthropic-repo` (3 writes each) are the top remaining
triage targets.

2026-06-01 wave — audited `db/byok-anthropic-repo.ts` (3 writes, customer Anthropic-key
ciphertext storage). SOUND — completes the BYOK security chain at the storage layer (the
crypto lib + route + cache were audited earlier; this is at-rest persistence). Ciphertext-only
at rest (no plaintext column; `findByAccount` projects ciphertext+metadata, the decrypt path
needs the blob), every method account-scoped, `clear` genuinely NULLs the encrypted blob
(not a soft flag — a customer clearing their key actually erases the secret at rest, tested
via `clearKey`), `upsert` resets the rotation-reminder dedupe on re-key, `touchLastUsed`
bumps `lastUsedAt` only (not `updatedAt`). Behaviorally covered by `byok-anthropic-service.test.ts`
(clearKey→hasKey=false+getPlaintext-null, roundtrip, no-op-on-no-key). No bug, no test-gap.
See `project_byok_anthropic_repo_audit_clean`. db-tier next: `validation-schedules-repo`
(3 writes) is the top remaining target.

2026-06-01 wave — audited `db/validation-schedules-repo.ts` (3 writes, the V-218 internal
archetype-validation scheduler). SOUND: `findDue` = `enabled=true AND nextRunAt<=now ORDER BY
nextRunAt ASC LIMIT n` (correct due-filter, oldest-first); `markRun` advances
`nextRunAt = now + cadence` from RUN-time (no drift, no immediate re-select); `upsert`
onConflict deliberately preserves a running schedule's `nextRunAt` (documented). The
no-claim-lock `findDue` is benign here — single internal admin-gated
(`driftstack_internal_admin`) scheduler (driven by `validation-harness.ts:140-152`), not
customer-facing/money. Behaviorally covered (`validation-harness-service.test.ts` processTick
due→run→advance + admin integration test). No bug, no test-gap. **Folded the result into
`project_db_repo_tier_audit_progress` rather than a standalone memory + new MEMORY.md index
line — MEMORY.md is now 47KB (~2× the 24KB load cap); the consolidation is overdue and I'm
deliberately throttling per-wave index growth.** db-tier next: the remaining 2-write repos,
preferring security/cross-account (`profile-snapshots`, `email-preferences`).

2026-06-01 wave — audited `db/profile-snapshots-repo.ts` (account-owned snapshots; distinct
from the RESOLVED route-requireScope scope-gap memory — this is the repo's query scoping).
SOUND: `findById`/`delete` both `WHERE and(eq(id), eq(accountId))` = IDOR-safe account-scoped
(cross-account id → null/false); `list` is account-scoped with a compound **id-keyset** cursor
(`createdAt<c OR (createdAt=c AND id<c.id)`, desc/desc — the id-keyset the timestamp-only-cursor
bug-class requires, present not timestamp-only) + limit cap 100. Verified-safe subtlety: the
cursor-row lookup fetches by `eq(id, cursor)` without an accountId filter, but only reads
`(createdAt,id)` to build the comparator — the main query still gates `eq(accountId)`, so a
forged cross-account cursor only shifts this account's window (no leak). Behaviorally pinned by
`profile-snapshots.test.ts:326` "cross-account access returns 404" + pagination/delete tests.
No bug, no test-gap. Folded into `project_db_repo_tier_audit_progress` (no new MEMORY.md index
line, per the 47KB throttle). db-tier next: `email-preferences-repo` (2 writes).

2026-06-01 wave — audited `db/email-preferences-repo.ts` (customer email opt-outs). SOUND:
all three methods account+eventType-scoped; `isOptedOut` is FAIL-SAFE (no row → `false` =
not-opted-out = default-opted-in → email sends; a flipped default would silently suppress
all mail); the model is opt-in = DELETE the row (revert to default), opt-out = upsert
`optedIn:false` (idempotent onConflict on `(accountId,eventType)`). The default-opted-in
_policy_ (which events are opt-outable) is the type/service layer, not the repo. Behaviorally
pinned (`email-preferences.test.ts`: empty→all-optedIn default synthesis + stored-opt-out
merge; faithful in-memory fake). No bug, no test-gap; folded into the db-tier progress memory.
Also this wave: weighed doing the MEMORY.md consolidation (now 47KB) in-session but
DECLINED — consistent with the standing judgment that it's a deliberate fresh-session task
(non-version-controlled, irreversible-if-botched), and I've already stopped inflating it
(folding into rosters). db-tier remaining: only lower-relevance 2-write repos (`recipes`,
`health-probes`, `atlas-priority-events`, `account-lifecycle`) — the high-yield db vein is
largely mined; weigh against the founder-gated / consolidation work.

2026-06-01 wave — audited `db/account-lifecycle-repo.ts` (once-per-account lifecycle emails;
repo-level CAS, distinct from the earlier service-dispatcher memory). SOUND:
`markFirstFailureEmailSent`/`markFirstSuccessEmailSent` are an ATOMIC single-UPDATE
check-and-set — `UPDATE accounts SET <col>=at WHERE id=? AND <col> IS NULL RETURNING id`,
returning `rowcount>0` as the win-signal, so of two concurrent callers exactly one flips the
column and gets `true` (sends the email) while the other gets `false` (suppressed) —
race-safe, no read-then-write TOCTOU, no duplicate first-failure/success email.
`findForLifecycle` is account-scoped + curated. Behaviorally pinned by `account-lifecycle.test.ts`
(sends+marks on first call / skips when flag already set) with a faithful in-memory fake.
No bug, no test-gap; folded into the db-tier progress memory. With this, the
correctness/security-relevant db repos are all audited clean; only thin lower-relevance
2-write repos remain (`recipes`, `health-probes`, `atlas-priority-events`) — diminishing
yield, weigh against the founder-gated work and the overdue MEMORY.md consolidation.

2026-06-01 wave — audited `db/recipes-repo.ts` (the last CUSTOMER-FACING account-scoped db
repo). SOUND, and the cleanest of the tier: `getById`/`deleteById` IDOR-scoped
`and(eq(id),eq(accountId))`; `list` account-scoped compound id-keyset cursor with the
cursor-row resolution ITSELF account-scoped (stricter than profile-snapshots' unscoped
lookup — explicit "forged/foreign cursor can't leak rows" guard); validation backstopped by
a DB CHECK; no update (v1.0 write+read+delete). Behaviorally pinned (recipes-routes.test.ts:
cross-account→404, gap-free pagination, get/delete 404, write-scope-gated). No bug, no
test-gap; folded into `project_db_repo_tier_audit_progress`.
**db-repo TIER SUBSTANTIVELY COMPLETE** — every customer-facing / account-scoped /
concurrency / integrity repo audited clean (10 repos, 1 data-loss test-gap closed). The only
2 un-audited repos (`health-probes`, `atlas-priority-events`) are 0-accountId INTERNAL infra
(no customer/IDOR surface). Per the run's standing signal, the safe high-yield fresh-audit
surface across lib + middleware + db tiers is now exhausted; remaining genuine work is
founder-gated (trustProxy `req.ip`, strict-FK, archetype) or the MEMORY.md consolidation
(47KB) — both fresh-session-suited.

2026-06-01 wave — surveyed the LAST code tier (`packages/`): no wired-and-un-audited target.
`webhook-delivery` is heavily covered (every src file has prior memory coverage);
`recipe-library` + `behavioural-simulation` are grep-confirmed UNWIRED Phase-3 scaffolding
(nothing in `apps/server/src` imports them — per the standing memories, auditing unwired code
for runtime bugs is low-value, correctly skipped). With this, ALL FOUR code tiers (lib,
middleware, db-repo, packages) are mechanically confirmed exhausted of safe, non-gated,
un-audited surface. Also re-ran the memory `[[wikilink]]` integrity check (165 files): clean
— only the 1 known-intentional Agent-1 forward-marker dangles. **No code/test change this
wave** (manufacturing one would be churn, rule 5); this is the genuine wind-down condition,
mechanically demonstrated. The real next step is a FRESH SESSION for the founder-gated items
(trustProxy `req.ip` is the top open finding) or the MEMORY.md consolidation — neither
auto-doable in this long autopilot context.

2026-06-01 wave — CORRECTION to the "all tiers exhausted" claim above: lib/middleware/db-repo/
packages were swept, but `routes/` and `services/` were only ever audited PIECEMEAL (when a
subsystem audit crossed them), never a systematic cov=0 sweep. So `routes/` is genuinely fresh
audit surface. Audited `routes/account-web-sessions.ts` (V-355 customer web-session list/revoke

- the `auth-flows.ts` revoke impl) — SOUND, real auth value: the `publicSession` list mapper
  leaks NO session secret (no token/tokenHash/IP; UA bucketed), `revokeWebSessionForAccount` does
  a `findWebSessionByIdForAccount(id, accountId)` ownership check so a cross-account revoke →
  404 (IDOR-safe, tested), is idempotent, AND **invalidates the auth cache on revoke** (logout
  actually logs out — the critical property), with `account.logout` audit; bulk-revoke requires
  explicit `?keep=current` + a web-session caller. No bug, no test-gap. See
  `project_routes_tier_audit_progress` (roster of cov=0 routes for next waves — security-weighted:
  `account-*` customer-facing > `admin-*` internal-admin-gated). No code change this wave.

2026-06-01 wave — audited `routes/account-cost.ts` (V-541.D customer `GET /v1/account/cost`).
SOUND: strictly SELF-SCOPED — `accountId: ctx.account.id` from the auth context, never a
URL/query param (the only input is `billing_cycle`, regex-validated), so no IDOR; the customer
response OMITS the operator-tuned threshold caps the admin surface includes (info-minimization);
fresh account → synthetic €0 breakdown (not 404). Reuses the verified cost-estimator. Tested
(`account-cost.test.ts`: 401-no-auth, zero-synthesis, current-month default, 400-malformed-cycle,
and explicitly "does NOT include operator-tuned threshold values"). No bug, no test-gap; folded
into `project_routes_tier_audit_progress`. routes-tier next: the `admin-*` cov=0 routes
(`admin-api-keys`, `admin-sessions`, `admin-webhooks`, etc.) — confirm `driftstack_internal_admin`
gating + acc\_-prefix handling; `account-rate-limits` (customer-facing, 47L) is the other
account-\* target.

2026-06-01 wave — audited `routes/account-rate-limits.ts` (V-219 customer
`GET /v1/account/rate-limits`). SOUND: GET-ONLY (no POST/PATCH/DELETE → a customer cannot
self-raise their limits; overrides are admin-only); SELF-SCOPED — derived entirely from `ctx`
(tier defaults + `ctx.rateLimitOverrides`), no id param → no IDOR; active-override gated on
`expiresAt > now` (expired → tier-default fallback); the bucket set is the 3 customer keys and
correctly EXCLUDES the internal-only `agent_sessions:input_event` (W869). Tested
(`account-rate-limits.test.ts`: buckets length-3, tier-default path, active-override flips
`source` to `override`). No bug, no test-gap; folded into the routes-tier progress memory.
**All customer-facing `account-*` cov=0 routes are now audited clean** (web-sessions, cost,
rate-limits). routes-tier remaining: only `admin-*` (internal-admin-gated) + `_webhook-raw-body`
(infra plugin) — confirm the admin gate + acc\_-prefix handling, lower IDOR risk.

2026-06-01 wave — instead of per-route admin audits, ran a CROSS-CUTTING scope-gating check
across the whole `routes/` tier (one grep of every `requireScope('…')` literal — higher yield
than individual bodies). CLEAN: (1) NO bare `requireScope('admin')` anywhere → V-174-safe; (2)
every cov=0 admin route gates `driftstack_internal_admin` (the correct operator scope); (3) the
full scope distribution is sane and every literal is a canonical `ApiKeyScopeSchema` member; (4)
`admin:billing` (billing.ts checkout/portal) is correctly NOT in `ELEVATED_SCOPES` — it's a
customer self-billing-management scope (account-owner-grantable by design), not a staff/
cross-account scope, so the e51ad504 de-escalation guard rightly restricts only `admin` +
`driftstack_internal_admin`. So the admin-route AUTHZ surface is verified sound in one pass; the
remaining per-route body audits are low-yield. See `project_routes_tier_audit_progress`. The
customer-facing attack surface across lib + middleware + db-repo + routes is now comprehensively
swept; remaining genuine work is founder-gated (trustProxy/strict-FK/archetype) or the MEMORY.md
consolidation.

2026-06-01 wave — ran a second cross-cutting routes check: do all customer write routes carry a
`requireScope` write-gate? Re-confirmed, NO new finding. The routes that are `requireAuth`-only
all map to ALREADY-DOCUMENTED cases in `project_read_write_scope_not_enforced` (RESOLVED
2026-05-26): `session-proxy`/`saved-proxies` are 503 activation-gate stubs (scope deferred to
the wiring slice); `billing-crypto*` are the V-666 crypto routes explicitly in that memory's
"~70 per-route judgment" remainder (stub-posture + account-scoped → IDOR-safe; crypto-quote is
a read-like pricing lookup); `agent-sessions`/`sessions` DO gate broad `write`/`write:sessions`
(my grep window missed the multi-line preHandler — false positives). That memory explicitly
warns blanket write-scope application is UNSAFE (breaks login; read-like POSTs) and needs
per-route founder judgment + a read-only-key-403 test per family — so this stays SURFACED, not
auto-fixed. Net: the write-scope invariant is re-verified and all gaps are cross-referenced to
the existing record. No code change. (Both customer-facing route AUTHZ invariants — admin-scope
last wave, write-scope this wave — now verified clean against the documented carve-outs.)

2026-06-01 wave — third (and most severe) cross-cutting routes invariant: does every live
non-public `/v1/` route actually carry `requireAuth`? Re-verified, NO bypass. Grepped every
route registration for a missing auth/scope/fleet gate; ~8 clusters flagged, ALL verified
false-positives against the real file: `account-byok-anthropic`/`agent-sessions`/`billing`/
`recipes`/`saved-proxies`/`session-proxy` are activation-gate `stub` registrations
(`app.post(path, stub)`, stub throws `FeatureUnavailableError` 503 unconditionally — the
ENABLED handlers are the other registration in each file, which carry full auth);
`fleet-events.ts:45` is a `(): never =>` 503-stub; `internal-atlas-priority.ts:158` uses
`preHandler: [requireInternalAuth]` (internal-fleet shared-secret bearer, a local alias the
grep didn't recognise). The grep window also misses multi-line preHandler arrays (same class
as the write-scope false positives). Net: every live non-public route is authenticated — the
three AUTHZ invariants (auth-presence, admin-scope, write-scope) now comprehensively cover the
route-tier boundary, all clean. No code change; recorded so a fresh context doesn't re-run the
grep. Also probed `cli-authorize` + `fleet-node-auth`/`fleet-nonce-cache` as candidate fresh
services-tier targets — both turned out fully test-saturated (40+ refs / dedicated
unit+integration+content-parity) and mature (fleet replay-defence: Ed25519 verify -> expiry ->
nonce-cache TTL ordering, correct). Three consecutive probes landing on already-covered mature
code is the honest saturation signal: the safe non-gated fresh-audit surface within Agent-2
scope is mechanically mined out (consistent with `project_lib_small_file_sweep_complete`).

2026-06-01 wave — with the repo audit surface mined out, took the long-deferred safe,
non-gated, in-scope hardening: consolidated the over-cap auto-memory index `MEMORY.md`
(~46KB → ~23.9KB, 48% smaller) so it fully loads again at session start. Every memory
preserved (157 entries; pointer set diffed identical against a backup before trusting it —
zero lost/dup, all link targets resolve). Trimmed over-long index hooks (detail stays in each
topic file); added `feedback_memory_index_terse_at_cap` (hooks <~150 chars; on add, trim a
RESOLVED line, since the file sits near the cap). This directly cuts the re-investigation
churn that a partially-loaded index causes. See the Continuity-hygiene TODO below (now DONE).
The MEMORY.md change itself isn't version-controlled; this note + that TODO are the durable
record.

2026-06-01 wave — fresh audit of the BYOK Anthropic plaintext-cache lifecycle (the 938ebf3a
clear-on-close area). Traced EVERY agent-session close path to answer "can a close leave the
decrypted key lingering in the route-owned in-memory cache?": (a) runtime budget-exhausted
`closeWithReason` (`agent-runtime.ts:296`) runs inside the /message turn, so the message
route's `if (result.session.status === 'closed') byokKeyCache?.delete(...)` evicts it; (b)
customer `DELETE /v1/agent-sessions/:id` evicts after `closeWithReason(...,'customer-closed')`;
(c) the pair-mode heartbeat sweep does NOT close sessions (fires a state transition, skips
already-closed) and the duration sweeper acts on browser `sessions`, not `agent_sessions` — so
there is NO out-of-band agent-session closer that bypasses the cache. The route comment ("the
customer DELETE route is the only other clear path") is ACCURATE; clear-on-close coverage is
COMPLETE — no bug. The cache has no TTL (plaintext held for session lifetime by design), which
is why the two explicit evictions matter. SHIPPED (test-only, no source change): extended
`byok-clear-on-close-guard.test.ts` — it previously source-pinned only the message-route clear
(the shared `byokKeyCache?.delete(req.params.id)` `toMatch` passes on EITHER of the two
occurrences, so the customer-DELETE eviction was effectively unguarded). Added a symmetric pin
for the customer-close path (`'customer-closed'` + its rationale comment + a count pin
requiring BOTH clear sites ≥2). The "dedicated behavioral cache-assert test" residual stays
intentionally-deferred (the guard-test author's documented call): a behavioral test would need
`build-test-app` to construct+wire+expose an `InMemoryByokKeyCache` — shared test-infra surgery
to re-verify an already-fixed + now-doubly-source-pinned property — low value-to-risk; don't
build it. tsc strict-clean; 4/4 guard tests green.

2026-06-01 wave — fresh critical read of `services/agent-runtime.ts` token-budget accounting
(central, previously-unaudited business logic). Hypothesis RAISED then REFUTED: the
budget-exhausted close trips on `postDebitSession.tokenBudgetRemaining === 0` (exact-zero), so
a turn whose `tokensConsumed` OVERSHOOTS the remaining budget could skip the close if remaining
went negative — but BOTH `debitTokens` impls floor at `Math.max(0, remaining - tokens)`
(drizzle `agent-sessions-repo.ts:158`; in-memory matches) and the schema has CHECK
`remaining <= total`, so an overshoot clamps to exactly 0 → `=== 0` DOES fire. Sound, no bug;
`agent-runtime.test.ts` (29 its) already covers the refusal-close, the debit-to-zero close, the
subsequent short-circuit, and transient/fatal error classification — agent-runtime token
accounting is audited-clean, don't re-audit. REAL finding from the same read — a cross-module
DRIFT fragility: the budget-exhausted refuse string `token budget exhausted; start a new
session` is duplicated as FOUR bare literals (deterministic + Claude decomposers emit it;
`agent-runtime.ts:293` matches it with exact `===`; agent-decomposer.ts JSDoc), with NO shared
constant. A PRE-CALL budget refusal charges 0 tokens (remaining stays e.g. 1, so
`debitZeroedBudget` is false) → the Q.3 close fires ONLY via the exact string match. If the
Claude (production) decomposer's wording drifts out of sync with the runtime matcher, the close
SILENTLY stops firing there (the runtime test drives the DETERMINISTIC decomposer, so it
wouldn't catch it) and the customer is stuck retrying into refusals. The per-decomposer tests
pin each emit in isolation; nothing pinned the cross-module equality. SHIPPED (test-only, no
source change): `agent-budget-exhausted-refuse-string-cross-source-invariant.test.ts` —
extracts the budget literal from all three functional sites and asserts byte-identity to a
canonical value (4/4 green, tsc clean). SURFACED (not auto-done): the robust fix is a single
shared constant imported by all three — a small behaviour-neutral refactor that would touch the
runtime + both decomposers + their content-parity pins; left for a focused pass, the invariant
test is the safe immediate guard. Same drift class as the enum/webhook-roster hardenings.

2026-06-01 wave — fresh critical read of `services/agent-decomposer-claude.ts` (437 lines, the
PRODUCTION LLM decomposer — AI-chat is v1.0-approved). Sound by design: AUP regexes are bounded
(no ReDoS); the system prompt is locked + parity-pinned; `parseIntents` allow-lists only the 4
valid verbs (so even a jailbroken plan can't emit arbitrary intents); the BYOK key rides only in
the `x-api-key` header, never logged, and error bodies are truncated to 300 chars; cost rounds
UP (conservative). No bug. REAL finding (closed): the decomposer throws 7 distinct parse-error
messages that `agent-runtime.ts` `classifyDecomposerError` must map to 'fatal' (else a genuine
malformed-response / wire-break is swallowed into a synthesized 'transient' refuse that keeps
the session active — masking the broken integration, no 502, no Sentry). The two existing suites
pin each SIDE independently — the decomposer test asserts its thrown messages via loose
`toThrow(/…/)` regexes; the runtime test asserts `classifyDecomposerError` against HARD-CODED
strings — so NOTHING drove the decomposer's ACTUAL error through the classifier. A drift that
renames a message + updates the decomposer test regex but forgets the classifier regex leaves
BOTH suites green while the real coupling breaks. SHIPPED (test-only, no source change):
`agent-decomposer-error-classification-cross-source.test.ts` — drives the real
ClaudeAgentDecomposer with each malformed-response/error shape, catches the ACTUAL thrown error,
and asserts `classifyDecomposerError(err)` is the intended class (9 fatal: missing-text /
non-JSON / non-object / unknown-kind / non-array-intents / missing-clarifyingQuestion /
missing-refuseReason / 4xx / missing-key; 2 transient: persistent 5xx-after-retry, network-error
-after-retry). 11/11 green, tsc strict-clean. Behavioral end-to-end pin (stronger than string
matching). NOTE: this is the 3rd consecutive drift/coupling-guard slice (BYOK symmetric, budget
string, now error-classifier) — all genuine distinct gaps, but per Rule M the NEXT wave should
PIVOT track (the agent-layer coupling vein is now well-pinned; consider a different subsystem or
honest deeper wind-down).

2026-06-01 wave — Rule-M track pivot OFF the agent layer: holistic fresh read of the job-scheduler
core (`services/scheduled-jobs.ts` + `db/scheduled-jobs-repo.ts`, V-202d — drives every sweeper:
auth-token GC, session-duration, cost-recompute-nightly, webhook-rotation). Hunted the
orphaned-lock bug class (same one that bit the webhook in_flight reclaim): does a crashed worker
that claimed a job — `claimDue` sets `locked_by`/`locked_at` and the row `FOR UPDATE` lock releases
at COMMIT, so "locked" is an application lease via columns — strand the job forever? REFUTED:
`claimDue` reclaims via `AND (locked_by IS NULL OR locked_at < ${now − 5min})` (a 5-min
zombie-lock lease), and it's DOUBLE-pinned (v202d-cross-source-invariant.test.ts:97-99 CRITICAL +
db-scheduled-jobs-repo-content-parity.test.ts:79 full-SQL). All three marks
(complete/retry/failed) clear the lock columns; retry uses exponential backoff
`base·2^(attempts−1)`; the exhaustion boundary `attempts >= maxAttempts` is correct
(claimDue increments attempts at claim, so maxAttempts runs total); the dedup NULL-accountId bug is
fixed + its prod incident documented; unregistered job_type → markFailed (doesn't wedge the tick);
slow-handler lease-expiry → at-least-once re-run, benign for these idempotent sweeps. **Sound,
well-tested — no bug, don't re-audit.** SURFACED (founder migration call, NOT auto-done): the
`dedupOnAccountAndType` path is a check-then-insert with NO transaction and NO unique-index
backstop — `scheduled_jobs_account_type_pending_idx` is a plain (non-unique) perf index — so two
concurrent `dedup:true` enqueues for the same `(account_id, job_type)` can both pass the existence
check and both insert → two pending rows. LOW severity today (single-replica; the self-re-arm path
deliberately uses `dedup:false`; `dedup:true` is mostly single-threaded bootstrap seeding) but a
latent MULTI-REPLICA bug. Clean fix = a PARTIAL unique index `(account_id, job_type) WHERE
completed_at IS NULL AND failed_at IS NULL` + 23505 handling in enqueue → but that's a migration
that canNOT be applied cleanly over any existing duplicate-pending rows (needs a dedup-cleanup
first), so it's the same founder-gated migration class as agent_sessions strict-FK and the
/v1/sessions concurrency TOCTOU — surface, don't auto-migrate. No code change this wave (forcing
a reclaim guard would duplicate the existing double-pin; the dedup fix is founder-gated).

2026-06-01 wave — Rule-M pivot again (off scheduler/agent): holistic read of the
incident-notification fan-out (`services/incident-notifications.ts`, customer-facing email
write-path). Audited SOUND — per-recipient try/catch isolates one bad send; `listConfirmed()`
returns only confirmed + non-unsubscribed (never emails the opted-out); the 'updated'-kind
throttle is a soft per-window gate (admin-driven, negligible TOCTOU); 7 test files incl. an
integration test. No bug. The token-rotation-per-send is the ALREADY-SURFACED CAN-SPAM/GDPR item
(`[[project_status_subscribers_audit_clean]]`). The read SHARPENED it: that memory's stated
mitigation ("recipients can still unsubscribe via the LATEST email") assumes the latest email
was delivered — but `rotateUnsubscribeToken` (line 99) persists BEFORE the send and the catch
(118) does NOT roll it back, so a TRANSIENT send failure strands that subscriber with every
prior link invalidated AND no working new link until the next SUCCESSFUL notification (long
window for an infrequent status page). Strengthens the HMAC-stable-token fix (removes rotation →
a failed send strands nobody); rotation can't move after the send (the body carries the link),
so only the token-scheme redesign fixes it — still founder/legal, NOT auto-fixable. Recorded in
the surfaced item's memory body (no MEMORY.md index growth, at-cap). No code change. NOTE: this is
deep wind-down — the recent waves (scheduler, incident fan-out) are audited-clean with the
findings being refinements/reinforcements of already-surfaced founder items, not new safe code
work. Genuinely-shippable safe non-gated slices are scarce; honest fresh-audit + precise
founder-surfacing is the remaining value.

2026-06-01 wave — completed the agent-primitive trilogy audit: `services/agent-executor.ts` (the
last un-read one) is an UNWIRED `StubAgentExecutor` (synthetic success per intent; real
SessionsService dispatch is the unbuilt AI-B2.b follow-up) — nothing live to audit. Surfaced a
forward note (folded into `[[project_recipe_library_credential_leak_forward]]`, same class): the
transcript serializer echoes `intent.value` (agent-executor.ts:104) — benign today (the value is
decomposer-derived from the customer task, already in the transcript via the user turn, so NO new
leak), but if AI-B2.b adds credential/vault-injection into `type` intents, that echo would persist
the injected secret into the transcript + decomposer history + chat UI → redact `type`-intent
values in executor summaries AT the AI-B2.b wiring slice (reuse V-494). No code change (unwired
stub; user-originated value). This confirms the deep-wind-down posture: agent layer, scheduler,
incident fan-out all audited; remaining findings are forward-notes on unwired scaffolding or
founder-gated items.

2026-06-01 wave — NEW cross-cutting dimension swept (rate-limit COVERAGE — never done before;
distinct from the auth-presence/admin-scope/write-scope invariants). Model: per-route opt-in
(`app.decorate('rateLimit', ...)` account-keyed + `ipRateLimit` IP-keyed for unauth; NO global
hook), so a route omitting it is genuinely unprotected. Swept all 145 route registrations. ONE
real LIVE finding (surfaced, new memory `[[project_oauth_provider_ratelimit_gap]]`): the
OAuth-PROVIDER public dance — `GET /v1/oauth/authorize`, `POST /v1/oauth/{token,introspect,revoke}`
(V-667, Driftstack issues tokens to 3rd-party apps; `registerOAuthRoutes` wired UNCONDITIONALLY
at app.ts:1050 → live) — has ZERO rate-limiting (not even an `ipRateLimit` import). `/token` is a
`client_secret`+auth-code brute-force surface (RFC 6749 §10.10); `/introspect` is an
unauthenticated token-validity oracle (RFC 7662). It's the ONLY unauth family in the API without
a limiter. LOW-MED severity (high-entropy secrets → guessing infeasible; the cost is missing
brute-force friction + open oracle + DoS). SURFACED not auto-fixed — rate-limit VALUES on a live
credential endpoint are a founder-tuned security policy (AUTH_IP_LIMITS entries are deliberately
chosen) AND keying is a design call (`/token`,`/introspect`,`/revoke` are CLIENT-SERVER-called →
naive IP-keying could throttle a future high-volume client; `/authorize` is user-browser, IP-safe).
READY-TO-APPROVE fix: ipRateLimit gates + a generous `AUTH_IP_LIMITS.oauthProvider` (~60/min/IP,
matching statusIncidentsList), per-client_id keying as a future enhancement. METHOD CATCH: the
first grep was case-SENSITIVE and missed `ipRateLimit(` (capital R) — `auth.ts`/`oauth-client`/
`status-subscribe` looked uncovered but are gated; re-ran case-insensitive. Rate-limit coverage
OTHERWISE COMPLETE (don't re-sweep): every other customer + public family gated; the other zero-rl
flags are correct carve-outs (`webhooks-stripe/nowpayments` = signature-gated provider callbacks,
must NOT limit; `fleet-events` = 503 stubs; public incident list/detail gated in
`admin-incidents.ts:312/348`; `metrics`/`openapi.json` infra-protected/static; `admin-cost`
internal-staff). Broke the doc-note streak's monotony with a genuine NEW live finding (not a
refinement). No code change (policy/keying = founder call).

2026-06-01 wave — Rule-M pivot to the health/incidents subsystem: read the health-probe →
auto-incident threshold logic (`services/health-probe.ts` evaluateThresholds). AUDITED SOUND,
no bug — both auto-create AND auto-resolve guard insufficient-data (`recent.length >=
threshold`, so a fresh target with <3 probes can't trigger a premature incident; no off-by-one);
create/resolve are mutually exclusive (create returns early, gated `!open` vs `open`); the
3-consecutive-probe hysteresis prevents flap-spam; per-target errors are isolated (a probe/DB
failure logs+continues, never crashes the poller loop); prune is idempotent/hourly. Heavily
tested already (V-295 series: health-probe-service + integration + a dedicated
health-probe-thresholds cross-source-invariant + content-parity + 2 repo tests) — don't
re-audit. The only theoretical edge is the `findOpenAutoIncident`→`create` TOCTOU, but that's
the already-surfaced dedup class AND the health poller is single-instance by nature (you run ONE
health poller, not N), so it's lower-risk than even the scheduled_jobs/session-concurrency
instances — not worth a 4th surface. No code change. Deep wind-down continues: every fresh
target is well-covered-clean or founder-gated; the genuine finds now are occasional (OAuth
rate-limit last wave) amid mostly clean confirmations.

2026-06-01 wave — Rule-M pivot to the highest-impact un-read category (money math): read
`services/crypto-orders.ts` (largest service, 47KB). Tested a precision/rounding-bug hypothesis
on the order-amount path — REFUTED. The service is integer-cents only (`price_cents: number` +
`price_currency`); there is NO fiat→crypto conversion math in it (delegated to NowPayments), and
the admin revenue aggregation (`getStatsForAdmin`) sums integer `price_cents` SEGREGATED by
currency (`paidRevenueCents[currency] += price_cents` — explicitly "can't sum across without a
conversion table"). Currency-segregation is both structurally pinned (`paid_revenue_cents:
z.record(string, int)`) and behaviorally tested (`integration/admin-crypto-orders-stats.test.ts`);
the service is exhaustively covered (100+ referencing tests). No bug, no test-gap (a
currency-split test would duplicate). SYNTHESIS worth recording once (closes a hunt vein):
the platform follows a consistent INTEGER-CENTS money discipline — cost-estimator (CENTS +
clamp-nonneg), crypto-orders (price_cents), billing — all integer cents, NO float, aggregation
currency-segregated, fiat→crypto conversion delegated to the provider. So the "money-precision /
float-rounding bug" hunt vein is CLOSED platform-wide; don't re-hunt it. No code change. Wind-down
remains deep — safe non-gated CODE work is exhausted; fresh audits confirm clean; real OPEN items
are all in the founder queue below.

2026-06-01 wave — FIXED a real bug (first shippable code in several waves): orphaned driver
session on create. `SessionsService.create` did `driver.createSession` (spins up a real browser)
→ `repo.insertSession` with NO rollback. If the DB insert threw, the driver session was already
live but had NO DB row — and since `countActiveSessions` + the duration-sweep auto-destroy are
both DB-row-based, AND the `Driver` interface has no idle self-expiry, the real browser session
would leak indefinitely (cost-to-serve, no reaper). FIX: wrapped `insertSession` in try/catch;
on failure, best-effort `driver.destroy(driverResult.driverSessionId)` then re-throw the ORIGINAL
error (rollback failure must not mask it). Purely additive error-path — happy path byte-identical;
not founder-gated (defensive cleanup, no policy/migration/locked-stance). Tests:
`sessions-failure.test.ts` +2 (insert-fail → driver rolled back + original error propagates;
successful insert → no rollback). 6/6 in that suite + 40/40 across 5 sessions-touching unit files
(incl. content-parity); tsc + eslint clean. SURFACED residual (out of scope for a safe slice): a
process CRASH between `createSession` and `insertSession` (not an exception) still orphans the
driver session — the complete fix is a periodic driver↔DB reconciliation sweep (find driver
sessions with no DB row, or DB rows whose driver session is gone, and reconcile). That's a
larger background-job design (founder/focused), analogous to the webhook orphaned-in_flight
reclaim. Note: `destroy()` has the REVERSE case (driver destroyed, then DB-status-update fails →
phantom-active DB row) but that self-heals — the row is sweeper-reapable + destroy is idempotent
on retry — so it's bounded, not surfaced.

2026-06-01 wave — sibling sweep of the orphan bug-class just fixed (external/stateful resource
created BEFORE the DB insert, no rollback → orphan). Swept every service doing an external call
near a repo insert. RESULT: sessions.create (driver session) was the SOLE expensive instance —
FIXED last wave. The rest are correctly ordered or benign: crypto-orders.create is DB-FIRST
(`repo.upsert` with payment_id:null; the NowPayments call comes later → a provider failure leaves
a trackable pending order, not an orphan); agent-sessions.create + profiles.create are DB-only;
audit-archive's R2 putObject-before-ledger-insert is a benign cheap-orphan (a failed ledger insert
leaves a wasted R2 object — retryable next run + lifecycle-managed, no data loss). NEW LOW-sev
sibling SURFACED (founder-aware, NOT auto-fixed — payment provider): `billing.ts ensureCustomerId`
→ `StripeBillingProvider.ensureCustomer` ALWAYS creates a fresh Stripe customer (documented design:
no lookup, dedupe via the `accounts.stripe_customer_id` short-circuit). So if `setStripeCustomerId`
(the DB write) fails after Stripe created the customer, the Stripe customer is ORPHANED (retry mints
another); and a parallel double-click on checkout can create DUPLICATE customers (the DB short-circuit
doesn't cover the concurrent window). LOW severity — orphaned Stripe customers are inert/free clutter
(no cost/data-loss/security), and Stripe is pre-launch TEST-mode (~0 real customers). Clean fix =
a Stripe **Idempotency-Key** on `client.createCustomer` keyed by `accountId` (makes create truly
idempotent → kills both the duplicate-on-parallel and the orphan-on-retry, with NO extra lookup, so
it's compatible with the documented design intent). The Stripe client (`lib/stripe-api.ts`) has NO
Idempotency-Key support today → the fix is a small plumb-through (client + provider). SURFACED not
auto-fixed: it's the payment provider (founder-sensitive, test→live cutover pending) + LOW severity;
worth doing BEFORE the live cutover. Orphan bug-class is now mapped end-to-end. No code change.

2026-06-01 wave — FIXED a real reliability bug via a fresh bug-class sweep (outbound-HTTP timeout
coverage). Every outbound caller sets an AbortController timeout (stripe-api 10s, nowpayments 10s,
health-probe 5s, webhook-delivery 10s, incident-broadcast 5s) EXCEPT `agent-decomposer-claude.ts`
(the customer-chat LLM path): its Anthropic fetch had NO `signal`/timeout. A hung upstream
(connection open, no response — a real LLM-API degradation mode) would hang the chat turn
indefinitely — and a hang is neither a 5xx nor a thrown network error, so the existing retry never
fired. FIX: per-attempt `AbortController` + `setTimeout(abort, requestTimeoutMs)` + `signal` +
`clearTimeout` in finally, matching the canonical stripe-api pattern; new configurable
`requestTimeoutMs` (default 30s — generous for a 2048-token planning call, bounded). On timeout the
abort is caught as a network error → one retry → then a transient-classified throw (synthesized
refuse, session stays active — correct contract). Additive (happy path unchanged); not founder-gated
(reliability fix, established pattern, internal timeout value). Tests: `agent-decomposer-claude.test.ts`
+1 behavioral (hung fetch that rejects on abort → 2 attempts each with a wired AbortSignal → throws);
27/27 that suite + 38/38 with the error-classification cross-source; tsc + eslint clean. SAME-COMMIT
parity update REQUIRED: `services-agent-decomposer-claude-content-parity` pinned the fetch body —
updated to include `signal: ac.signal` + new pins for the AbortController/timeout wiring (drift-guards
the fix). BONUS: that pinned assertion was a single 8-group `\s*\n?\s*` chain that backtracked ~16.85s
(the pathology `feedback_no_long_chain_parity_regex` warns about) — converted it to discrete pins,
dropping the test from 16.85s → 0.27s. Outbound-timeout coverage now complete across all callers.

2026-06-01 wave — fresh async-safety / concurrency bug-class sweep (two sub-classes). BOTH CLEAN
— closes the vein, don't re-hunt. (1) UNBOUNDED `Promise.all` over DB/external ops (pool/memory
exhaustion): every `Promise.all(...map)` site is bounded — fixed tuples (auth-cache, auth,
webhooks), small fixed lists (mfa recovery-codes, incident-broadcast channels, health-probe
targets), or page/batch-limited query results (scheduled-jobs `claimDue({batchSize:25})`,
webhook-worker claimed batches, durable-webhook-delivery `page = rows.slice(0, limit)`). No
unbounded fan-out. (2) FIRE-AND-FORGET / missing-await (unhandled-rejection or lost write): the
bootstrap pollers all wrap the tick in `void (async () => { try { await … } catch {
logger.error('interval continues') } })()` (guarded, no unhandled rejection); the
`void this.email.send…` calls (auth-flows signup/verify/reset/welcome, oauth-client merge) are
SAFE by design — `email.ts:3-4` documents "All sends are fire-and-forget: errors logged at
warn-level but never thrown", so EmailService never rejects → the `void` cannot produce an
unhandled rejection. No async-safety bug. TWO minor observations (NOT bugs, surfaced for
awareness): (a) `durable-webhook-delivery` list does a BOUNDED N+1 (`loadAttempts` per page row)
— a perf smell on a low-traffic admin endpoint, optimizable to one batched query, not a bug;
(b) there is NO process-level `unhandledRejection`/`uncaughtException` handler (only SIGTERM/SIGINT
in index.ts) — currently moot (no path produces an unhandled rejection: email is non-rejecting,
pollers are guarded, Fastify catches route errors), but a defense-in-depth gap. Adding a handler
embeds an ops decision (log-and-continue risks an undefined-state process per Node guidance vs
log-and-graceful-shutdown vs the current fail-fast crash+auto-restart) → SURFACE, don't
unilaterally change process crash behavior. No code change.

2026-06-01 wave — FIXED a real security gap via a fresh class sweep (Cache-Control: no-store on
sensitive responses). The V-666.BS/BT/BW `onSend` hook stamped `no-store, private` on ONLY
`/v1/account|admin|billing`, but its own comment claimed comprehensive intent ("a future endpoint
can't accidentally omit it"). It MISSED other caller-private families — `/v1/sessions`,
`/v1/profiles`, `/v1/profile-snapshots`, `/v1/agent-sessions`, `/v1/api-keys`, `/v1/webhooks`,
`/v1/webhook-deliveries`, `/v1/team`, `/v1/usage`, `/v1/oauth`, `/v1/legal/required` — whose GET
payloads are caller-private and cacheable (cross-user leak via a shared/proxy/browser cache;
Cloudflare's auth-aware default mitigates but isn't a guarantee). FIX: broadened the hook to ALL
`/v1` with two carve-outs — (1) exclude `/v1/status*` (the public status/incidents/sla/stream
family, which sets its own `public, max-age=30`), (2) a DON'T-OVERRIDE guard
(`reply.getHeader('cache-control') === undefined`) so a route's own header survives. The
don't-override guard was REQUIRED (not just nice): a naive broadening would clobber the SSE
streams' `no-cache, no-transform` → `no-store` (dropping `no-transform`, which stops proxies
buffering the event stream — risking SSE delivery); it also FIXES a latent pre-existing clobber
where the old unconditional `/v1/account/*` stamp was overwriting the notifications SSE stream's
header. Verified: 12/12 security-headers (incl. new: `/v1/profiles` 401 → no-store; `/v1/status`
→ public,max-age=30 preserved), `/v1/account/me` still no-store (account-me 46/46), 13/13
lib-app-content-parity, tsc + eslint clean. SAME-COMMIT parity update: lib-app-content-parity
pinned the exact old hook source (comment + a single ~10-group `\s*\n?\s*` mega-regex) → rewrote
to DISCRETE pins (per the no-long-chain lesson) for the new hook + comment. Not founder-gated
(defensive header completing the hook's stated intent; no policy/migration/locked-stance change).
No-store coverage now complete across caller-private /v1.

2026-06-01 wave — input-safety / DoS-hardening bug-class sweep (three sub-classes). ALL CLEAN —
closes the veins, don't re-hunt. (1) PAYLOAD-SIZE DoS (bodyLimit): the Fastify instance leaves
`bodyLimit` unset → the 1 MiB default applies to every route; only two deliberate per-route
overrides exist — `_webhook-raw-body` (`MAX_BODY_BYTES = 1 MiB`, raw body for Stripe/NowPayments
sig verify) and `account-me:274` (3.5 MiB, sized for a 2 MiB avatar after base64 inflation). All
bounded; no unbounded/excessive limit. (2) TIMING-SAFE secret comparison: no non-constant-time
compare of a secret/token/hash/signature — the audited paths (internal-fleet, nowpayments,
oauth-pkce, mfa, api-keys, oauth-links) all use `timingSafeEqual`; the only `===` hits on
token-named vars are `typeof x === 'string'` type-guards, not value compares. (3) PROTOTYPE
POLLUTION / unsafe dynamic-key writes: none — `Object.assign` is only onto fresh Error objects
with literal payloads; the only dynamic bracket-writes (`deletedByKind[kind]`, `fullTotals[t]`)
key off FIXED internal enums (job kinds, `ALL_TYPES` usage-record types), never user input; Zod
parsing constructs clean validated objects rather than merging request bodies, so user JSON never
flows into an object merge or a dynamic key. No code change. NOTE: the bug-class veins that
yielded real fixes (orphan-resource, outbound-timeout, response-caching) are mined; the remaining
input-safety/DoS classes confirm the codebase is robust on these dimensions.

2026-06-01 wave — audited `cost-nightly-job` idempotency (money-adjacent: the
`cost.recompute_nightly` job runs under the scheduler's retry-on-failure). CLEAN — the handler
writes NO cost rows (cost is compute-on-demand); it lists accounts → `dispatcher.evaluate` (fires
cost ALERTS) → re-arms (dedup:false, per the RESOLVED re-arm fix). The alert dispatcher is
`lastState`-tracked, so a retry SKIPS already-fired alerts (the `alertsSkipped` count) → no
duplicate alerts/cost on retry. Well-tested (v541e cross-source + content-parity). No bug. Also
refreshed the stale founder-action queue below (was ~wave-8 state; now reflects all surfaced
findings).

2026-06-01 wave — audited the pair-mode takeover LOCK (`agent-pair-mode-lock.ts` — WIRED:
`RedisPairModeTakeoverLock` in bootstrap, used by POST `/takeover` + `/handback` + the
input-event takeover trigger). Locking is a classic bug source; formed three hypotheses, ALL
REFUTED — CLEAN, don't re-audit. (1) naive-DEL release that frees someone else's lock → NO, it's
a Lua CAS-DEL (`if GET==clientId then DEL else 0`, the canonical Redlock recipe). (2) a 24h lock
→ 24h takeover-lockout → NO, that 24h is the LiveKit TOKEN TTL in `maybeMintLivekit` (I conflated
them); the lock uses the 30s default. (3) one-shot 30s lock not renewed → two-humans-driving race
after 30s → NO: the lock is acquired only on the `ai-driving → human` transition and is
APPROPRIATELY SCOPED to that sub-second contention — once human-driving, subsequent input-events
forward to the harness (no re-acquire) and the STATE machine gates the session, so the lock needn't
be renewed; when state returns to ai-driving (handback CAS-releases it; heartbeat-timeout
auto-handback fires only after >30s stale, by which point the 30s lock has already expired) a
fresh takeover acquires cleanly. So no lingering-lock lockout and no takeover-steal. The lock
primitive (SET-NX-EX acquire returning the winner's clientId on contention + Lua CAS-DEL release)
is textbook-correct. No code change. NOTE: pair-mode is v2-#8 but wired (activation-gated: real
handlers when `pairModeLock` is present, else 503 stubs).

2026-06-01 wave — audited the pair-mode STATE MACHINE (`agent-pair-mode-state.ts`
`applyPairModeTransition`), completing the pair-mode subsystem audit (lock ✓ last wave). CLEAN,
no bug, don't re-audit. It's a pure reducer over 6 states (ai-driving / takeover-queued /
takeover-pending / human-driving / handback-queued / handback-pending) × 10 transitions:
exhaustive + type-safe (every `case` path returns a `PairModeState` or throws
`PairModeStateInvalidTransitionError`→409; no unhandled pair → undefined-state); all valid
transitions hit the correct target; the 8.11/8.12 queued states correctly promote on
`decompose-settled` / roll back on decline; `heartbeat-timeout`→ai-driving from any non-ai state;
`decompose-settled` is idempotent no-op where no queue. KEY CROSS-REFERENCE (reinforces last
wave's lock audit): a takeover-STEAL is rejected at the STATE level too — `human-driving` /
`takeover-pending` + `takeover-request` → throws — so the 30s-lock-expiry edge I analyzed last
wave is DOUBLY-mitigated (lock + state machine are defense-in-depth; a second client can't steal
even if the lock lapsed). Only acknowledged limitation (cosmetic, documented): `handback-pending`

- `handback-cancel` loses the driver `clientId` (→`'unknown'`) because handback-pending doesn't
  carry it — but the lock-release + audit use the REQUEST's `client_id`, not the state's, so it's
  informational only. No code change. The entire control-plane audit surface is now swept; remaining
  real work is the founder-action queue below.

2026-06-01 wave — pivoted off the control plane to the CUSTOMER-FACING SDKs: audited the cursor-
pagination iterators (a classic infinite-loop / off-by-one / non-advancing-cursor bug class) across
all three SDKs. ALL CORRECT, no bug, don't re-audit. TS (`sdk-typescript/src/pagination.ts`
`iteratePaginated`) + Python (`sdk-python/src/driftstack/pagination.py`, sync + async) use a shared
helper: terminate on `next_cursor == null/None`, advance `cursor = next_cursor`. Go has PER-RESOURCE
hand-rolled loops (audit_log / crypto_orders / profile_snapshots / profiles / recipes) — more code
but each is correct AND slightly MORE defensive: terminates on `NextCursor == nil` OR
`*NextCursor == ""` (TS/Python only check null), and crypto_orders defensively copies the caller's
opts before mutating Cursor between pages. All three rely on the server's id-keyset advance
guarantee (audited-sound — the timestamp-only-cursor class is RESOLVED to id-based compound keyset,
so `next_cursor` strictly advances until exhausted → null), so trusting the server (no client-side
non-advance guard) is correct. No code change. META-STATUS: the safe non-gated audit surface is now
comprehensively swept — the control plane (every service/route tier + the bug-class sweeps) AND the
customer SDKs. Future waves should expect clean confirmations on fresh reads; the real remaining
work is the founder-action queue below (all surfaced/gated, none auto-doable).

2026-06-01 wave — audited the DETERMINISTIC decomposer's AUP filter (`agent-decomposer-deterministic.ts`)
and SHIPPED a safety drift-guard. The deterministic decomposer is a CUSTOMER-REACHABLE prod path —
`selectAgentDecomposer` (bootstrap) wires it when no Anthropic-key path is configured
(self-hosted / no-key) or via `DRIFTSTACK_AGENT_DECOMPOSER_FORCE=deterministic`. Verified its AUP
pre-filter has the SAME 5 patterns (CSAM / non-consensual-deepfake / swatting / captcha-bypass /
brute-force) as the Claude one — `AUP_REFUSAL_PATTERNS` is duplicated verbatim in both (no shared
const), currently byte-identical. The two were pinned only INDEPENDENTLY (Claude: length-5 + the
"identical corpus" comment; deterministic: a content regex) — nothing asserted they MATCH, so a
new abuse pattern added to one path but not the other would silently weaken AUP enforcement on
deterministic-path deployments. SHIPPED (test-only, no source change):
`agent-decomposer-aup-corpus-cross-source-invariant.test.ts` — extracts the full
`AUP_REFUSAL_PATTERNS` block from both files and asserts byte-identity (+ a sanity check that each
has the 5 regex entries; caught + fixed my own off-by-one — the `{pattern: RegExp}` type annotation
also contains `pattern:`, so I count `pattern: /` not `pattern:`). 2/2 green, tsc + eslint clean.
Same drift class as the budget-string invariant. NON-bug noted: the deterministic decomposer checks
budget BEFORE AUP (Claude checks AUP first) — cosmetic only (an AUP task is refused either way:
budget-refuse if exhausted, AUP-refuse otherwise; never executed). The deterministic path's
regex-only AUP (no model second-filter) is inherent to the non-LLM path, acceptable for the
fallback. Completes the decomposer audit (Claude + runtime + executor + deterministic).

2026-06-01 wave — under the founder "close it all" directive, CLOSED queue item #2 (OAuth-provider
rate-limit) with a shippable, fully-validatable, zero-prod-risk hardening — and corrected a
material severity error in the queue. First RESOLVED the contradiction between this handoff
("registerOAuthRoutes wired UNCONDITIONALLY → live") and the prior-session finding (dormant): the
registration is GATED `if (deps.oauthStore !== undefined)` (app.ts:1047), NO prod code passes
`oauthStore`, and the only `OAuthStore` impl is `InMemoryOAuthStore` (V-667.C Drizzle store unbuilt)
→ prod curl confirms `/v1/oauth/{authorize,token,introspect}` all **404** (a live route, `/v1/auth/login`,
returns 400). So the provider is DORMANT; the "live brute-force/oracle" framing was wrong. Given that,
the gate is a SHIFT-LEFT close (not a live-exposure fix): added `AUTH_IP_LIMITS.oauthProvider`
(60/min/IP — the memo's recommended generous default: real brute-force friction on /token + oracle
throttling on /introspect, generous enough not to throttle a single-IP client server) and per-route
`ipRateLimit` preHandlers (separate buckets) on the 4 unauth routes; `/authorize/complete` omitted
(already `requireAuth`). `rateLimitStore` is now a REQUIRED `RegisterOAuthRoutesDeps` field (threaded
from app.ts; the 4 direct-call oauth tests pass a `MemoryRateLimitStore`) so the protection can't be
silently omitted when the provider is wired. Behavioral test `oauth-provider-rate-limit.test.ts`
(burst→429 + first-allowed + per-route bucket isolation; mutation-verified: dropping a gate fails
both the burst-429 assertion AND the content-parity pin). Same-commit parity: routes-oauth gate pins,
ip-rate-limit content-parity oauthProvider entry, request-id roster/divisor counts 12→13 (the full
suite caught the divisor-count assertion — exactly the same-commit-parity rule). Full server suite
GREEN (17,512 pass / 0 fail), tsc + eslint + prettier clean. NOTE on the other queue items considered
and correctly NOT auto-done this wave: webhook DNS-rebind (#5) needs an undici custom connector wired
into a LIVE delivery path that can't be validated offline → real live-regression risk, left deferred;
CORS allow-list (#4) is env-driven (`CORS_ALLOWED_ORIGINS`) + a prod flag-flip → outward-facing, not a
code slice; trustProxy/strict-FK/unsub-HMAC remain genuinely founder-gated.

2026-06-01 wave — fresh-audit of a security dimension NEVER swept before: the raw-SQL / SQL-injection
surface (distinct from the slow-query-log CWE-532 audit, which was secret-in-logs, not injection).
CLEAN — no bug. Monorepo-wide there are ZERO `sql.raw(` and ZERO `sql.identifier(` (the two Drizzle
escape hatches that bypass parameter binding); the only `.unsafe(` is a COMMENT in
`lib/slow-query-log.ts` (the drizzle-postgres parameterized exec path). All 13 `sql\`...\`` template
usages were read and confirmed to interpolate ONLY parameterized VALUES (server-derived ISO
timestamps, internal config numbers like batchSize/workerId, auth-context account ids) or Drizzle
column objects (`usageRecords.recordedAt`) — never user-controlled SQL STRUCTURE; ORDER BY / LIMIT /
status literals are static or value-bound; and Drizzle binds `sql\`\`` `${}`interpolations as $1/$2
params, so even value interpolation is injection-safe. Shipped a drift-guard (commit 5e46ba84,`no-raw-sql-injection-surface.test.ts`): a cross-monorepo sweep asserts `sql.raw(`/`sql.identifier(`never appear in non-test source (empty allowlist) + a non-vacuous check; mutation-verified (a probe
file with`sql.raw(`trips it, removed → green). Test-only, no source change. Memory:`project_raw_sql_injection_surface_clean`. (Adds a new clean dimension alongside IDOR/auth-coverage/
input-validation/error-handler/ReDoS — the security surface remains well-verified; this one is now
also CI-enforced against regression.)

2026-06-01 wave — fresh-audit of another never-swept dimension: mass-assignment / over-posting /
field-level write-authz (distinct from the IDOR audit — that proved you can't write ANOTHER account's
row; this asks whether a caller can write a PRIVILEGED FIELD of their OWN row, e.g. set their own
tier/suspended/role). CLEAN — no bug. ZERO `{ ...body }`/`{ ...parsed }` spread into any
`.set()`/`.values()` monorepo-wide (every write maps explicit columns); the only customer self-edit
surface PATCH /v1/account/me (`UpdateAccountMeRequestSchema`) whitelists name/timezone/slug/region —
no privilege field — and `updateAccountBasics` maps a typed patch field-by-field (a second whitelist);
account-tier mutation is admin-only or Stripe-driven; team role is invite-time (owner/admin-gated, no
role-UPDATE endpoint); api-key scopes de-escalate. Shipped a build-independent source-regex drift-guard
(commit cfc80d5b, in `update-account-me-cross-source-invariant.test.ts`): the self-edit schema's object
literal (scoped `= z` → `.refine(`) must declare NONE of tier/suspended/role/scope(s)/balance/isAdmin/
accountId/id/stripeCustomerId — closing the "subset-`.toMatch` blind to an ADDED privileged field" gap.
Mutation-verified (adding `tier:` to the schema fails only this guard; removed → green). NOTE: an
initial behavioral `.parse()`-strips-privileged-fields version was DISCARDED because the test imports
the BUILT `@driftstack/api-types` (dist), so a source edit wasn't reflected locally (build-dependent =
false confidence); the source-regex form is build-independent and matches this file's convention —
reusable lesson. Memory folded into `project_idor_ownership_review_clean`. Test-only, net source zero.

2026-06-01 wave — fresh-audit of another never-swept dimension: insecure randomness (Math.random for
security values). CLEAN — no bug. All security-sensitive randomness (tokens/keys/codes/csrf/nonces)
uses a CSPRNG (~80 randomBytes/randomUUID/getRandomValues sites). Math.random appears in EXACTLY 3
apps/server/src runtime files, all non-security: webhook-worker (retry jitter — harmless),
livekit-token (CSPRNG-fallback for the JWT jti only when Web Crypto absent — dead code in Node 22; and
the jti is a non-secret replay marker, token security is the HMAC-SHA256 signature), playwright driver
(internal driver-session handle — API auth boundary is the account-scoped ses\_ DB id via requireOwned,
never the client-supplied driver id; timestamp-salted; mock driver in prod). Shipped a file-allowlisted
drift-guard (commit 0b3d36aa, `no-insecure-randomness-for-secrets.test.ts`): any Math.random in another
apps/server/src file fails CI → security review. Mutation-verified (probe in a non-allowlisted file
trips it; removed → green). gui-client/dashboard Math.random ids are CLIENT-side local correlation ids
(outside the API trust boundary; server auth = bearer token), not re-audited. Memory folded into
`project_idor_ownership_review_clean`. Test-only, net source zero. (4th consecutive fresh-dimension
clean+guard wave: OAuth-rl close → SQLi → mass-assignment → insecure-randomness. The safe non-gated
CODE-FIX surface stays exhausted; these waves verify a distinct dimension clean + add a CI regression
guard, per the directive's keep-doing-fresh-audit-waves wind-down posture.)

2026-06-01 wave — fresh-audit of SSE per-account/session event SCOPING (cross-tenant-leak class; distinct
from the prior SSE leak/cleanup-mechanics audit). CLEAN by construction: NotificationEventBus keyed by
accountId + route subscribes with ctx.account.id (own authenticated account, no tamperable param, no
X-Driftstack-Account on this route); AgentSessionEventBus keyed by sessionId but the transcript SSE route
gates session.accountId === ctx.account.id → 404 BEFORE writeHead/subscribe (so a guessed sessionId never
opens a stream); IncidentEventBus→status-stream is public (broadcast correct). No bug. Filled a real
test-gap (commit 5d007f51): the transcript SSE route had ZERO behavioral coverage — added GET /:id/transcript
non-owned-id → 404 with the gate's "AgentSession ... not found" body and NOT an opened event-stream (the
body assertion is non-vacuous vs a route-not-found 404; pins gate-before-stream ordering). The true
cross-account branch (foreign EXISTING session vs unknown-id null branch) isn't behaviorally tested for any
agent-session by-id route (single-account suite + agentSessionsRepo not exposed on the fixture); verified by
code-read (same gate idiom across all 6 by-id routes), a foreign-session seed = shared-infra surgery, low
value-to-risk — surfaced not done. Memory folded into project_idor_ownership_review_clean. Test-only, net
source zero. (5th consecutive fresh-dimension clean+guard/test wave: OAuth-rl → SQLi → mass-assignment →
insecure-randomness → SSE-scoping.)

2026-06-01 wave — SHIPPED a real fix (first non-test-only ship in several waves): security headers on the
status site. The 2026-05-20 CSP-header audit closed the gap on dashboard/admin and confirmed marketing/docs
had headers — but OMITTED status-site (same Astro/Pages stack; separate Pages projects don't cross-inherit
\_headers), so status.driftstack.io (public incident page + email-subscribe form) shipped with ZERO security
headers. Added `apps/status-site/public/_headers` (commit 871beb2c) mirroring the dashboard posture:
X-Frame-Options: DENY + X-Content-Type-Options: nosniff + Referrer-Policy: strict-origin-when-cross-origin +
Permissions-Policy + immutable /\_astro/_ caching; no Cache-Control on /_ (incident HTML stays fresh); CSP
deferred (Astro is:inline, same as dashboard). Cloudflare Pages copies public/\_headers verbatim to dist on
build (dist gitignored). Same-commit parity: the cross-app drift-guard
(docs-public-headers-robots-and-cross-app-svg-parity) had EXPLICITLY asserted status-site has NO \_headers
(documenting the gap) — flipped to present + added content pins for the 4-header set. Memory:
project_status_site_cloudflare_setup. Embeddable-status-widget exception (relax X-Frame-Options to
SAMEORIGIN / CSP frame-ancestors) left as a founder call. tsc + eslint + prettier clean.

2026-06-01 wave — fresh-audit of response-header injection (CWE-113). CLEAN — no bug. Every
reply.header/writeHead value across apps/server/src is static / server-computed / server-generated;
Node's setHeader structurally rejects CRLF so response-splitting is runtime-blocked. Residual vectors
all clean: the one client-influenced value (x-request-id) is a bounded (≤128) correlation passthrough;
the one reply.redirect (oauth-client callback bounce) targets the FIXED dashboardOrigin with a
URLSearchParams-encoded query (no open-redirect / Location injection); both dynamic Content-Disposition
filenames are server-generated (audit-log ISO-date; crypto receipt `ord_<hex>` id). Filled a test-gap
(commit c4542548): the e2e correlation test covered reflection+uniqueness but not the 128-char BOUND —
added a behavioral guard (normal inbound x-request-id reflected; >128 → fresh UUID ≤128) so a client
can't pin an unbounded value into the response header/logs; mutation-verified (widening the genReqId cap
fails it). Memory folded into project_idor_ownership_review_clean. Test-only, net source zero. (6th
consecutive fresh-dimension clean wave: OAuth-rl → SQLi → mass-assignment → insecure-randomness →
SSE-scoping → status-site-headers[shipped fix] → CWE-113.)

2026-06-01 wave — Rule-M-v2 track PIVOT off the security-dimension run (6 consecutive); did a non-security
operational/customer-facing verification + the last security-adjacent dimension, BOTH clean → NO code/test
artifact this wave (manufacturing one would be churn per rule 5; the continuity record IS the slice).
(1) Operational: all customer surfaces resolve 200 (driftstack.io / app / docs / status / api openapi.json),
all 7 legal slugs (aup/dpa/privacy/refunds/sub-processors/terms/vulnerability-disclosure) resolve 200 and
each is existence-guarded by its own legal-\*-content-parity test (deletion → CI fail) — so the
compliance-doc roster is fully covered; status-site headers re-confirmed LIVE. (2) Insecure-deserialization:
swept all 14 JSON.parse sites — every UNTRUSTED external/client parse is try/catch-guarded with a handled
fallback (oauth-client-state cookie, fleet-node claims, nowpayments IPN, agent-decomposer LLM, inbound
webhook bodies, 3 IdP responses, Stripe response, auth-cache); the only unguarded parses are TRUSTED
server-written store entries (cli-authorize / auth-flows-MFA / config / migrate) → recoverable 500 not a
vuln, guarding them = defensive churn (not done). No bug. Memory folded into
project_idor_ownership_review_clean. HONEST STATUS: the safe non-gated audit surface (security dimensions +
operational + compliance roster) is now comprehensively swept AND regression-guarded; genuine remaining
high-value work is the founder-action queue below. Future waves: continue fresh-audit cadence but expect
clean confirmations; do NOT manufacture low-value guards on already-clean trusted paths.

2026-06-01 wave — fresh CORRECTNESS read (not security) of webhook-delivery RELIABILITY: the retry-backoff
SCHEDULE + the auto-disable logic (prior webhook audits were SSRF / in_flight-reclaim / retry-count, not
these). Both CORRECT, no bug. (a) Backoff is a static table BACKOFF_MS_BY_ATTEMPT (1/5/15/30/60 min for
retry indices 1..5; DLQ at index 6 = initial+5), strictly monotonic, comment matches values, jitter
0–15% non-negative, nextAttemptAt always future, no overflow (static table) — and it is COMPREHENSIVELY
guarded already (services-webhook-worker-content-parity pins the exact table + the doc-comment + jitter +
nextAttemptAt; webhook-worker-cross-source-invariant pins the 5-step schedule) → adding anything = duplicate
coverage, deliberately NOT done. (b) Auto-disable: consecutiveFailures resets to 0 on 2xx (recordDelivered),
increments atomically (`sql ${col}+1`) on retry+DLQ, disable check `consecutiveFailures+1 >= 50` on the DLQ
terminal path → a never-succeeding endpoint reliably disables within ~9 fully-failed deliveries. The check
is DLQ-path-only (not the retry path) — verified BENIGN by-design: the count may reach ~55 before disabling
(immaterial lag at a 50 threshold; the endpoint still disables on the next DLQ) — NOT a bug, don't re-flag.
NO code/test artifact (no bug; backoff already-guarded; auto-disable sound). Webhook unwired packages
(webrtc-streaming) skipped; recapture-automation is capture-domain-adjacent + scheduler-already-audited;
prod-served OpenAPI spec verified valid (3.1.0, 154 paths). Wind-down is genuine + deep — fresh reads now
land clean AND already-covered. Real remaining work = the founder queue below.

2026-06-01 wave — fresh audit of the CUSTOMER-DASHBOARD client-side XSS + bearer-token-storage surface
(never examined; the prior session-delivery audit covered the SERVER side only). XSS SURFACE CLEAN — every
`.innerHTML=` sink escapes via a correct `escapeHtml` (all 5 chars, text+attribute safe), text-only uses
`textContent` (showBanner), the one custom-scheme href is hard-coded `driftstack://`+encoded+escaped,
customer URLs (webhook) are escaped or set via `.value` (property, not HTML sink). No stored XSS found.
LATENT finding SURFACED (founder trade-off, NOT an acute bug, NO safe auto-fix): the dashboard stores the
30-day web-session BEARER in localStorage + has NO CSP (deferred) → the blast radius of ANY future dashboard
XSS = account-takeover + 30-day persistence. This ELEVATES the priority of the already-deferred dashboard
CSP (it's the compensating control for the localStorage token) — see new queue item below. Robust fix is
architectural (HttpOnly cookie + CSRF, OR ship the deferred CSP) → founder/focused. Memory folded into
project_auth_flow_token_audit_2026_05_31. No code artifact (XSS clean; mitigations founder-gated). NOTE: the
bearer-in-localStorage is a DELIBERATE CSRF-vs-XSS trade-off (bearer-in-body is CSRF-safe), so it's a
conscious decision to revisit, not an oversight. Per-page escapeHtml duplication is a maintainability smell
(all copies currently correct) — a consistency guard was considered but NOT added (fragile / low-value).

2026-06-01 wave — founder directive "finish everything" (= the earlier "close it all"). Re-triaged the WHOLE
queue for what can be CLOSED AUTONOMOUSLY+SAFELY vs what genuinely needs the founder. CLOSED this wave: #9
(unhandledRejection/uncaughtException) → CLOSED-AS-COVERED — verified @sentry/node v8 default integrations
already provide both handlers in prod (capture + fail-fast); the gap was a handoff inaccuracy, and adding a
raw handler would conflict. No code change. HONEST FINISH-STATUS of the rest (why each is NOT blindly
auto-shipped — every one risks a prod regression or needs a founder DECISION I cannot make):
• #1 trustProxy — setting it WRONG enables rate-limit EVASION (worse than today's one-bucket); needs the
real prod CF→nginx XFF chain verified + the LOCKED XFF-leftmost stance is a founder decision. NEEDS: founder
confirms the trust model (recommend `trustProxy:'loopback'` + verify nginx sets XFF/X-Real-IP; or trust
CF-Connecting-IP) — then 1-line config + restart. I can execute once the chain is confirmed.
• #4 PERMISSIVE_CORS — flipping it with a WRONG allow-list breaks a live customer surface (dashboard/admin/
status CORS). NEEDS: founder confirms the exact CORS_ALLOWED_ORIGINS set (recommend app+admin+status
.driftstack.dev; marketing/docs are static). Reversible. I can SSH-set + flip + verify once the origin list
is confirmed.
• #5 webhook DNS-rebind — the airtight fix is an undici connector/lookup on the LIVE delivery path; a subtly-
wrong one breaks HTTPS webhook delivery (TLS/SNI) and can't be fully validated offline (no real external
webhook host in tests). NEEDS: a focused session with real-network validation (founder/pair), not a blind
autopilot ship.
• #6 unsub-token HMAC — needs a KEY-SOURCE decision (reuse mfaEncryptionKey vs new STATUS_UNSUB_SIGNING_SECRET) + the CAN-SPAM List-Unsubscribe-One-Click compliance call. NEEDS: founder picks the key source; then it's a
contained service change.
• #8 scheduled_jobs dedup partial-unique-index — requires a prod-data DELETE (dedup-cleanup) before the index;
autonomous prod-data deletion + a migration that fails-the-deploy-if-dups is the founder-gated migration
class. NEEDS: founder ok to run the cleanup+index migration (recommend: cleanup keep-oldest + partial unique
index + 23505-handling in enqueue) — low-risk but a watched prod migration.
• #14 dashboard CSP/cookie — CSP needs is:inline enumeration (a wrong CSP breaks the dashboard); cookie+CSRF is
an auth-transport rearchitecture. NEEDS: founder picks ship-CSP vs HttpOnly-cookie+CSRF.
• #11 MFA per-account lockout — founder policy (legit-user-DoS tradeoff: threshold + lockout duration).
• FOUNDER-GATED (unchanged): agent_sessions strict-FK (breaking), iphone16pro→iphone17 (canvas).
CONCLUSION: every remaining item is decision-blocked or carries a live-prod-regression risk that makes a blind
autopilot ship irresponsible (would violate "don't break prod"). They are PREPARED + decision-ready above; I
will EXECUTE any of them the moment the founder confirms the specific decision (or pairs on the prod-touching
ones). This is the responsible "finish everything": close what's safe (#9 this wave + the 4 closed earlier),
convert the rest into a fast founder finish-list rather than risk a customer-facing regression.

2026-06-01 wave — SHIPPED a real deploy-reliability fix (commit bd30db35). Root-caused a genuine deploy
flake from the CI history: the b8608a46 STAGING deploy FAILED twice on `FAIL /openapi.json — response body
not JSON: terminated` and tripped the post-deploy-verify gate (prod skipped, V-549.B auto-revert armed) even
though /health was OK — the next commit (03ff524, near-identical) deployed fine, proving transient. Cause:
`scripts/post-deploy-verify.mjs` `jsonCheck` did a single-shot `fetch + res.json()` with NO retry/timeout;
the large 154-path /openapi.json body stream was cut off ("terminated") on a cold-started host, and unlike
the on-host /health poll (retries 10×) the public verify failed the whole deploy on one blip. FIX: added
retry+timeout (VERIFY_MAX_ATTEMPTS=4, 15s per-attempt AbortController timeout, 2/4/6s backoff) — fetchWithRetry
(status-only probes) + fetchJsonWithRetry (fetch+json as a unit, since the terminate threw on res.json()
AFTER fetch resolved); retries ONLY thrown errors (network/aborted/terminated), never a wrong STATUS (the
predicate reports that immediately, no masking). Consts hoisted to the module top to dodge the temporal-dead-
zone the top-level checks loop would hit (same fix as FEATURE_UNAVAILABLE_TYPE). VALIDATED: the real script
passes all 14 checks against LIVE prod (exit 0); a refusing host → 4 attempts + backoff → graceful
"failed after N attempts" (no hang/instant-fail); node --check clean. No unit test (deploy script, eslint-
ignored, not in the vitest suite) — validated by direct execution. Memory: project_deploy_bridge_pattern.
This is a genuinely-safe SHIP under "finish everything" (additive resilience, validatable against live prod,
strictly can't make a healthy deploy fail) — distinct from the decision-blocked queue items below.

2026-06-01 wave — (a) confirmed the prior post-deploy-verify retry fix (bd30db35) landed on origin (a transient "stuck push" scare was a false alarm — my own ps-grep matched its command strings; the background push completed exit 0). (b) Fresh cross-SDK audit: error-RESPONSE-PARSING + edge-case handling (204/empty body, non-JSON success, non-JSON/empty/non-Problem error body, network/timeout) is CLEAN + consistent across all 3 SDKs (TS http.ts / Python http.py::\_decode_or_raise / Go client.go+error_mapping.go) — a successful 204 DELETE never parse-crashes; a malformed error body never crashes the SDK. No bug, no code change (per-SDK tests + content-parity already cover it). Memory: project_sdk_retry_5xx_cross_sdk_design.

## Recommended order when the loop is paused (founder-action queue, refreshed 2026-06-01)

All items below are SURFACED findings from the autopilot audit run — deliberately NOT auto-fixed
(security policy / migration / locked-stance / outward-facing / breaking). Ranked by severity ×
readiness. Each has a detail memory + a chronological note above.

**HIGH**

1. **trustProxy / `req.ip` = 127.0.0.1 in prod** — CF→nginx(localhost)→Fastify, so the IP
   brute-force gate is ONE global bucket (latent 429 outage + no per-attacker isolation) and all
   auth-audit IPs log as 127.0.0.1. Needs the LOCKED XFF stance revisited + prod XFF header
   verified before changing `req.ip`. (`project_trustproxy_ip_resolution_gap`)

**MEDIUM — ready or near-ready** 2. ~~**OAuth-provider rate-limit**~~ — ✅ **GATE SHIPPED 1c7cda87 (2026-06-01)** + severity CORRECTED. The
`/v1/oauth/{authorize,token,introspect,revoke}` routes now carry per-route `ipRateLimit` gates
(`AUTH_IP_LIMITS.oauthProvider` = 60/min/IP). CORRECTION: this was NOT a "live" finding — the
provider is DORMANT in prod (`registerOAuthRoutes` only binds when `deps.oauthStore` is supplied;
no Drizzle store exists — V-667.C unbuilt; all 3 routes curl-confirmed **404**). So the gate is a
SHIFT-LEFT close: protection ships with the routes, active the moment a store is wired (no
launch-day gap). `rateLimitStore` is now a required `RegisterOAuthRoutesDeps` field.
**Residual LAUNCH items (V-667.C, founder-gated, NOT closed by this gate):** per-`client_id`
keying for high-volume clients, introspect-caller-auth, and RFC 9700 §4.5.3 revoke-token-on-
code-reuse. (`project_oauth_provider_ratelimit_gap`) 3. ~~**Stripe `createCustomer` idempotency-key**~~ — ✅ **CLOSED 6e9fe21e (2026-06-01)**. Added an optional
Idempotency-Key to `StripeApiClient.createCustomer` (conditional header via `post()`); `ensureCustomer`
passes `stripe-customer-create:<accountId>` → Stripe returns the same Customer on retry/parallel-call,
closing both orphan paths with no extra lookup (compatible with the no-search-by-email design). Done
before the test→live cutover as recommended. (`project_billing_and_apikey_surfaced_findings` #3) 4. **PERMISSIVE_CORS=true in prod** — echoes ANY Origin + credentials (boot-warn guard shipped;
full fix = the allow-list, but it's missing status/admin origins → blind-disable breaks them).
(`project_permissive_cors_in_prod`) 5. **Webhook DNS-rebind** — the remaining SSRF layer: connection-time resolve+pin in the delivery
fetch (literal-IP block + redirect:error already shipped). (`project_webhook_ssrf_outbound_target`) 6. **Unsubscribe-token HMAC redesign** — rotation breaks older emails' unsub links, and a failed
send strands a subscriber with NO working link until the next successful notification
(CAN-SPAM/GDPR). Fix = HMAC-stable per-subscriber token. (`project_status_subscribers_audit_clean`)

**LOW / defense-in-depth** 7. Session driver↔DB **reconciliation sweep** — the residual after the create-orphan rollback fix:
a process CRASH between `driver.createSession` and `insertSession` still orphans. (`project_session_concurrency_limit_toctou_race`) 8. `scheduled_jobs` dedup **partial-unique-index** — multi-replica latent dup; migration must
dedup existing pending rows first. (`project_session_concurrency_limit_toctou_race`) 9. ~~Global **`unhandledRejection`/`uncaughtException` handler**~~ — ✅ **CLOSED-AS-COVERED 2026-06-01 (verify, no code change).** The handoff's "there is NO process-level handler" was INCOMPLETE: `@sentry/node` ^8.55.2 default integrations include `onUncaughtException` + `onUnhandledRejection` (confirmed — no `defaultIntegrations:false`/`integrations:` override in `lib/sentry.ts`; `initSentry` wired in bootstrap.ts:169), so in prod (Sentry-enabled) both ARE captured to Sentry AND preserve the fail-fast crash (v8 SDK behavior). Adding a raw `process.on` handler would CONFLICT with the SDK integration (double-handling). Residual = the Sentry-OFF case (dev / DSN-unset) has no handler → Node default crash (no capture) — moot (prod has Sentry; dev needs no crash-capture; and the handoff itself noted "no path produces one today"). NOT an ops decision after all — surface/close. 10. **SSE single-use ticket** (replace `?ds_token=` in URL) + **nginx access-log redaction** — the
two remaining layers of the SSE/OAuth-token-in-logs work. (`project_sse_token_in_logs`) 11. **MFA per-account lockout** — founder policy (legit-user-DoS tradeoff). (`project_mfa_challenge_not_attempt_bounded`) 12. **AI-B2.b executor-summary redaction** — at-wiring (when the real executor lands; unwired stub
today). (`project_recipe_library_credential_leak_forward`) 14. **Dashboard session-token in localStorage + no CSP** (2026-06-01) — the 30-day web-session bearer is stored in `localStorage` and the dashboard ships no CSP (deferred), so any FUTURE dashboard XSS = account-takeover + 30-day persistence. The dashboard XSS surface is currently CLEAN (escapeHtml correct + consistent; verified this wave), so this is latent/defense-in-depth — but it ELEVATES the deferred-CSP work (CSP is the compensating control) and is a CSRF-vs-XSS trade-off (localStorage+bearer = CSRF-safe today; HttpOnly-cookie+CSRF would be XSS-safe). Robust fix = ship the deferred CSP OR move to HttpOnly-cookie+CSRF (architectural). (`project_auth_flow_token_audit_2026_05_31`) 13. ~~**`debitTokens` + `appendTranscript` atomic decrement**~~ — ✅ **CLOSED e9c78962
(2026-06-01)**. Both `DrizzleAgentSessionsRepo` methods were bare read-modify-writes (get→JS→separate
UPDATE) → concurrent same-session calls lost an update (debit: under-billing / uncapped bundled-LLM
spend; append: dropped transcript entry = data loss). FIXED by wrapping each in a `db.transaction()`
that SELECTs the row `FOR UPDATE` first (exact `setAccountTier` pattern) → the row lock serialises
concurrent debits/appends, no update lost. New real-PG regression test
`db-agent-sessions-concurrency-drizzle.test.ts` (CI postgres:17, `max:5` pool) proves concurrent
debit(30)+debit(40)→30 and append(A)+append(B)→length 2; pre-fix yielded 60/70 + length 1. Comments

- content-parity pins updated to the atomic FOR-UPDATE description (+ regression guard). CI run
  26758892696 = SUCCESS (integration + E2E-vs-real-PG green; only the non-gating advisory perf job
  red). (`project_session_concurrency_limit_toctou_race`)

**FOUNDER-GATED (breaking / canvas / explicit decision)**

- **agent_sessions strict-FK** — breaking migration (deliberately-loose customer ref). (`project_data_lifecycle_findings`)
- **iphone16pro→iphone17 archetype cutover** — canvas-close-gated. (`project_v1_launch_archetype_cutover_pending`)
- **BYOK behavioral cache-assert test** — deferred-by-design (needs build-test-app cache wiring; already double-source-pinned). (`project_byok_anthropic_audit_2026_05_31`)

_(Earlier item — open-redirect `?next=` — DONE 33f1e907. Optional tail: API `/start` `redirect_to`
dashboardOrigin restriction, defense-in-depth.)_

> Autopilot note: by ~wave 8–9 the high-value, safe, un-mined Agent-2 audit
> surface was exhausted; value-per-wave declined and a deep-session misread
> occurred (recovered). Converting this queue into shipped work is best done in a
> fresh, focused session rather than continued audit-cadence waves. By ~wave 15 the
> remaining un-audited packages are unwired Phase-3 scaffolding (recipe-library /
> behavioural-simulation); live findings are mostly surfaced above awaiting
> founder/focused action. ~Wave 17 fresh-read the small control-plane **service
> tier** (sla-reporting, the 3 SSE event-buses, legal-catalog, status-snapshot):
> all clean + already-guarded — SLA % math is div-by-zero-safe (total===0→100 with
> totalProbes:0 surfaced so the UI can qualify "no data"); the keyed event-buses
> correctly evict empty Sets (no Map leak) and that eviction + the handler-error
> swallow are _textually_ drift-guarded by the content-parity tests, so a
> behavioral no-leak pin would be duplicate coverage (deliberately not added).
> Don't re-pick these one-by-one.

> Continuity-hygiene TODO — **DONE 2026-06-01.** The auto-memory index `MEMORY.md`
> had grown to ~46KB (≈2× the ~24.4KB load cap), so it loaded only partially at
> session start — the tail (most-recent audit/RESOLVED entries) silently dropped,
> risking re-investigation of closed veins. Consolidated this wave back to ~23.9KB
> (48% smaller), **all 156 entries + a new discipline memory preserved** (157 total,
> every `[Title](file.md)` pointer kept verbatim — verified by diffing the grep'd
> pointer set against a backup: zero lost, zero dup, all targets resolve). Method
> was per-line hook-trimming (detail already lives in each topic file), not the
> digest-merge originally sketched — keeping every entry individually addressable is
> safer. New rule recorded as `feedback_memory_index_terse_at_cap`: hooks <~150
> chars, and on adding an entry also trim a now-RESOLVED line (the file sits near the
> cap). Backup was removed only after the pointer-set diff proved identical.
