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

5. **Webhook retry count: docs + code rationale promise 5 retries, code
   delivers 4.** The DLQ-promotion threshold is `nextAttemptIndex >=
MAX_ATTEMPTS` with `MAX_ATTEMPTS = 5` (`apps/server/src/services/
   webhook-worker.ts:218`, mirrored in `packages/webhook-delivery/src/
   in-memory.ts:426` and `durable-webhook-delivery.ts`). Because
   `nextAttemptIndex` counts _total_ attempts (initial = 1), `>= 5` DLQs on
   the **5th attempt = initial + 4 retries**. The in-memory test pins this
   (`totalAttempts === 5`). BUT:
   - the worker's own pinned rationale comment claims 6 attempts: its exact
     wording is "0..5 inclusive (initial + 5 retries) -> 6 total tries";
   - the customer doc `apps/docs/src/pages/webhooks/replay.md` says
     "retries failed webhook deliveries **5 times**" — i.e. 5 retries = 6
     attempts;
   - `BACKOFF_MS_BY_ATTEMPT[5]` (60min) is **unreachable** at the current
     cap (retries only schedule for indices 1–4 = 1/5/15/30min); the 60min
     entry only makes sense if a 5th retry exists.
     So customer-facing copy + the code's own rationale promise one more retry
     than the code performs. The guard meant to catch exactly this —
     `webhook-5-retry-max-attempts-cross-source-invariant.test.ts`, whose
     header frets "give up too early (customer angry: 'you only tried 3
     times!')" — is **toothless**: it string-matches each contradictory claim
     independently and never computes the actual attempt count, so it stays
     green while pinning a self-contradictory contract.
     **Decide the intended contract, then make all four sources agree in one
     commit:** either (a) intent = 6 attempts / 5 retries → change the
     threshold to `> MAX_ATTEMPTS` (or `MAX_ATTEMPTS = 6` with `>=`), which
     adds a real 5th retry (the 60min one) hitting customer endpoints, update
     the in-memory test's `totalAttempts` expectation; or (b) intent = 5
     attempts / 4 retries → fix the worker rationale comment + the
     `replay.md` "5 times" copy (de-promises a retry) and drop/annotate the
     dead `backoff[5]`. Either way, **strengthen the invariant test** to
     actually drive a delivery to DLQ and assert the attempt count, not just
     grep the constants. NOT auto-fixed: picking (a) vs (b) is a
     customer-facing behavioural call, and a test currently pins the 5-attempt
     behaviour as if intentional.

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
