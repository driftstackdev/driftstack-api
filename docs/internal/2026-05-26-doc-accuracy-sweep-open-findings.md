# 2026-05-26 — doc/accuracy sweep: shipped fixes + open founder-gated findings

Autopilot (Agent 2) ran a long doc/parity/accuracy + light implementation
sweep across every customer-facing surface (api docs, marketing, all three
SDKs incl. examples + READMEs, runbooks, deployment docs, legal, reference
docs, badge/enum completeness, and a pass over the complex packages). This
note surfaces the items that need a **human decision** — they were
deliberately NOT auto-fixed because the correct resolution depends on
intent or touches untestable/external state.

## Open — need your call

1. **idempotency reference doc describes a TTL mechanism that doesn't
   exist.** `apps/docs/src/pages/reference/idempotency.md` (Edge-cases
   list) claims "The 24-hour TTL is enforced by a scheduled job that nulls
   out expired keys; the row itself remains." No such scheduled job exists
   (the scheduled-jobs registry has only `subscription.trial_pack_expired`
   - `cost.threshold_alert`). Actual behaviour differs by subsystem:
   * crypto-orders: in-memory `Map` lazily pruned (`CryptoOrdersService.
pruneIdempotency`, `IDEMPOTENCY_TTL_MS = 24h`, entries deleted, no row).
   * agent_sessions: partial-unique index on `(account_id, idempotency_key)`
     with **no TTL nulling at all** — `findByIdempotencyKey` has no cutoff,
     so the key persists with the row indefinitely.
     **Decide:** should agent_sessions keys have a 24h TTL (then wire a sweep
     — there's none), or is the persistent unique-index intended (then drop
     the "24h TTL / scheduled job" wording for that path)? Then rewrite the
     bullet to the real per-subsystem behaviour.

2. **Runbook references a one-shot script that was never built.**
   `docs/runbooks/auth-token-sweeper.md` §"Manual one-shot sweep" tells ops
   to run `npx tsx scripts/auth-token-sweep-once.mjs`; that file does not
   exist (the other 11 runbook-referenced scripts do). The sweeper runs
   fine as the scheduled job — only the manual one-shot is missing.
   **Decide:** build the script (instantiate `AuthTokensSweeperService` +
   `DrizzleAuthFlowsRepo` with prod `DATABASE_URL`, call `tickOnce(new
Date())`, log `deletedByKind` — mirror `scripts/smoke-livekit.mjs`,
   needs staging-PG testing) or rewrite the section to the real mechanism.

3. **TS SDK User-Agent version is frozen.** `packages/sdk-typescript/src/
http.ts` sends `driftstack-sdk-typescript/0.0.1` while `package.json` is
   `0.1.6`, so non-browser TS requests report `0.0.1` in server-side
   telemetry. ~5 tests pin `0.0.1` and describe it as the intentional
   metric-bucketing marker, yet `sdk-internal-version-consistency` (W834)
   prose says the two "MUST match" — contradictory. Python derives its UA
   from `_version.py` and Go from `version.go`; only TS hard-codes.
   **Decide:** sync the UA to `package.json` (add a `version.ts` const like
   the other SDKs; updates ~5 pins) or keep `0.0.1` frozen and make W834's
   prose stop claiming they must match.

4. **Rotate the staging Neon DB password.** It was printed to a prior
   session's terminal output (2026-05-26). Treat as exposed and rotate via
   the Neon console; also repair the malformed staging `.env` `DATABASE_URL`
   (doubled / missing `&` separators → it currently falls back to
   `driver:mock`). (No secret value reproduced here.)

## Shipped this sweep (all on `main`, gate-green)

~11 customer-facing doc/code fixes: TS error-handling class name
(`QuotaExceededError`→`TierLimitError`); Python-quickstart + session-guide
tier-limit class; TS retry example dropped a non-existent `backoffMultiplier`
field; recipes `503` named both gating repos; marketing `pip install
driftstack`→`driftstack-sdk` + `@driftstack/sdk-typescript`→`@driftstack/
sdk`; self-hosted runbook `docker-compose.dev.yml`→`docker-compose.yml` +
`driftstack_dev`→`driftstack` DB; observability `NEXT_PUBLIC_SENTRY_DSN`→
Astro `PUBLIC_SENTRY_DSN_<service>`; GUI default port `7780`→`3000`;
env-vars `DRIVER` enum gained `playwright`; wrong-org GitHub links
`driftstack`→`driftstackdev`; pagination "opaque opaque" typo.

Plus ~11 cross-source guards (webhook events-catalog ↔ enum, status-site
badge completeness, input-limit doc ↔ schema, package-name sweep extended
to bare-install + repo-URL forms, SDK method-call existence across docs +
marketing + Python examples + READMEs, runbook file-reference existence,
DRIVER doc ↔ config).

The remaining customer-facing accuracy surfaces verified clean; the complex
packages (behavioural-simulation gesture math, recapture scheduler,
cost-monitoring threshold wiring) spot-checked sound.
