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

## Shipped — infra / tests / docs (non-runtime)

- `400ae39d` profiles operationIds · `4bddde5a` sdk-python openapi.json resync ·
  `aed6a0db` snapshot↔live-spec structural drift guard · `d845d47e` models.py
  codegen resync · `f5343158` suspend-reclaim integration wiring + full-chain test ·
  `02830641`/`b5fa7a98`/`79a5f0ab`/`a99866c6` internal docs.

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
3. **[MEDIUM — redirect bypass FIXED 2026-05-31; rest SURFACED] Webhook delivery
   SSRF** — `2026-05-31-webhook-ssrf-outbound-target.md`. The server POSTs to a
   customer-controlled webhook URL; create-time validation only enforces `https://`
   (allows `https://localhost`/`https://10.x`/`https://[::1]`) and delivery followed
   redirects, so `https://attacker → 30x → http://169.254.169.254` bypassed it.
   **FIXED:** `redirect: 'error'` on all 3 delivery fetch sites (in-memory + durable
   - worker), pinned. **REMAINING:** create-time literal-private-IP block (easy,
     zero false-positives) + connection-time DNS-rebind pinning (harder — needs careful
     impl). MEDIUM (blind/semi-blind: delivery log is a status/timing oracle, no body
     exfil).
4. **[MEDIUM — app-log + Sentry FIXED 2026-05-31; nginx + design SURFACED] SSE
   `?ds_token=` / OAuth `?code=` in logs** — `2026-05-31-sse-token-in-logs.md`.
   The SSE auth bearer rides in the URL query (EventSource can't set headers); it
   leaked plaintext into the Fastify request log (`req.url`), Sentry (auto
   `event.request.url` + 5 explicit `request.url` passes), and the nginx access log.
   **FIXED:** `lib/redact-url.ts` wired into a pino `req` serializer (verified Fastify
   5 honors the loggerInstance serializer) + `scrubSentryEvent` + all sentry
   `request.url` passes. **REMAINING:** nginx `log_format` (infra) + the proper design
   — a short-lived single-use SSE ticket instead of the real bearer in the URL.
5. **[MEDIUM] Webhook orphaned-`in_flight` reclaim** —
   `2026-05-31-webhook-orphaned-inflight-reclaim-gap.md`. A worker crash / deploy
   mid-batch leaves deliveries stuck `in_flight` forever → silently lost.
   **Fully designed:** add a `claimed_at` column (migration), reclaim on
   `claimed_at` staleness (threshold ≫ 10s timeout), leave `updated_at`/DLQ-keyset
   untouched, real-PG test. **Highest-value next item.**
6. **[LOW] Auth-flow consume race** — `2026-05-31-auth-flow-token-audit.md`.
   `consumeAuthToken` returns void → concurrent same-token submit lets both
   callers act (benign-to-minor). Needs a loser-behaviour decision.
7. **[LOW] BYOK cache dedicated test** — guards `938ebf3a`; needs `buildTestApp`
   to expose `byokKeyCache` + a byok-stored-then-budget-exhaust scenario.

## Verified clean — do NOT re-audit (re-sweep = churn)

BYOK crypto + route, auth-flow tokens, webhook delivery worker, recapture
scheduler/atlas/matrix (`dedupKey` correctly NUL-joins), `suspend`/data-lifecycle
cascades, Stripe tier-update — plus the prior-session sweeps (IDOR/auth/
payment-sig/input-validation/error-handler, money-path, all 3 SDKs).

## Founder-gated — surface only, do NOT auto-do

- `agent_sessions` **strict FK** — breaking (rejects currently-valid creates;
  format change + backfill). Design decision: strict FK vs intentional loose ref?
- **iphone16pro → iphone17 archetype cutover** — canvas-close-gated (Agent-1);
  surface, don't flip.

## Prod state (Rule-L, wave 9)

Deployed SHA = HEAD, service active, 0 restarts, ~0 real errors/2h, self-re-arming
scheduled jobs alive. Healthy.

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
> fresh, focused session rather than continued audit-cadence waves.
