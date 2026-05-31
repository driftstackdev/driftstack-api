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

0. **[MEDIUM, LIVE — new #1] Open-redirect via `?next=` in dashboard sign-in** —
   `2026-05-31-open-redirect-next-param.md`. `login.astro` navigates a raw
   `?next=` (`window.location.href = next`, line 240) → `/login?next=https://evil.com`
   bounces a signed-in user off-site (phishing); `signup.astro` has the same
   pattern. Fix = a URL-parser same-origin sanitizer (NOT regex) at every raw
   `next`/`return_to` nav + jsdom bypass tests + parity-pin updates. The only LIVE
   customer-facing vuln from the run — promote above the webhook item.
1. **[MEDIUM] Webhook orphaned-`in_flight` reclaim** —
   `2026-05-31-webhook-orphaned-inflight-reclaim-gap.md`. A worker crash / deploy
   mid-batch leaves deliveries stuck `in_flight` forever → silently lost.
   **Fully designed:** add a `claimed_at` column (migration), reclaim on
   `claimed_at` staleness (threshold ≫ 10s timeout), leave `updated_at`/DLQ-keyset
   untouched, real-PG test. **Highest-value next item.**
2. **[LOW] Auth-flow consume race** — `2026-05-31-auth-flow-token-audit.md`.
   `consumeAuthToken` returns void → concurrent same-token submit lets both
   callers act (benign-to-minor). Needs a loser-behaviour decision.
3. **[LOW] BYOK cache dedicated test** — guards `938ebf3a`; needs `buildTestApp`
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

1. **Open-redirect `?next=` fix** (#0 above) — LIVE customer-facing vuln; small but
   bypass-sensitive (URL-parser sanitizer + tests). Do first.
2. Webhook reclaim — fully spec'd, just needs focused implementation.
3. A founder call on strict-FK and/or the archetype cutover.
4. BYOK cache test + auth-flow consume hardening (low priority).

> Autopilot note: by ~wave 8–9 the high-value, safe, un-mined Agent-2 audit
> surface was exhausted; value-per-wave declined and a deep-session misread
> occurred (recovered). Converting this queue into shipped work is best done in a
> fresh, focused session rather than continued audit-cadence waves.
