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
   — the three registered scheduled jobs are `trial_pack.expired`
   (bootstrap.ts:458), `auth_tokens.sweep` (auth-flows-sweeper.ts), and
   `cost.recompute_nightly` (cost-nightly-job.ts), none of which sweeps
   idempotency keys. Actual behaviour differs by subsystem:
   - crypto-orders: in-memory `Map` lazily pruned (`CryptoOrdersService.
pruneIdempotency`, `IDEMPOTENCY_TTL_MS = 24h`, entries deleted, no row).
   - agent_sessions: partial-unique index on `(account_id, idempotency_key)`
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

6. **Trial-pack credit is granted but never consumed — the "~16 hours"
   promise + "decrements at session_end" comments are unenforced (launch
   gate).** `trial_pack_credit_cents` is granted at purchase
   (`stripe-webhooks-repo.ts:146` = `DEFAULT_TRIAL_PACK_CREDIT_CENTS`) and
   read for the `active` check + `creditCentsRemaining` display
   (`billing.ts:235,241`), but **nothing decrements it** — exhaustive grep
   finds no decrement in any service/repo/session-end hook. This is a known
   downstream consequence of the deferred usage-metering subsystem:
   `usage.ts:216` states "the buckets are all empty because usage_records
   writers aren't wired in production code", and `cost-aggregator.ts:14,17`
   mark the writers as **V-541.J/K follow-ups**. So the missing decrement is
   deferred-by-design, NOT a stray bug. BUT two surfaces overstate
   enforcement: (a) the trial email (`email.ts:422,424`) tells customers
   "Credit remaining: N cents (~16 hours of iPhone Safari sessions at
   $0.18/hr)" — an hours-cap that is not metered; (b) `usage.ts:46` and
   `migrations/0010_billing.sql:6` say the credit "decrements at session_end"
   in the **present tense**, which is false today. Trial-pack is pre-LIVE
   (Stripe test mode until post-BV/KvK), so no paying customer is misled yet.
   **Launch gate / decide:** before trial-pack goes LIVE, either (a) land the
   usage_records writers + session-end credit decrement (V-541.J/K) so the
   16h/$0.18-hr cap is actually enforced, or (b) soften the email copy +
   make the "decrements at session_end" comments future-tense if the real
   bound is the 14-day expiry, not the credit cap. NOT auto-fixed: which
   bound is the product intent is a founder call, and the email copy is
   parity-pinned.

7. **`pointerToViewport` assumes `object-fill` but the `<video>` is
   `object-contain` — latent click mis-mapping, a multi-archetype blocker.**
   `apps/gui-client/src/lib/livekit-input-capture.ts` `pointerToViewport`
   maps a click via the full element rect:
   `x = ((clientX - rect.left) / rect.width) * videoWidth`. But the `<video>`
   renders with `object-contain` (`AgentSessionPanel.tsx:108`,
   `h-full w-full object-contain`) inside a container whose `aspectRatio` is
   fixed (default `IPHONE_16_PRO_ASPECT_RATIO`, `AgentSessionPanel.tsx:101`).
   When the stream aspect == container aspect (iPhone-only v1.0) there is no
   letterbox and the mapping is exact — so this is **not a current bug**. But
   `object-contain` letterboxes the moment the stream aspect differs from the
   container `aspectRatio` (e.g. a non-iPhone archetype), and the mapping does
   NOT account for the letterbox bars / content-rect offset — so **every
   click would be mis-mapped (offset + wrong scale) on a mismatched-aspect
   stream**, making remote control unusable for that archetype. The pure test
   (`livekit-input-capture-pure.test.tsx`) only covers matched 4:3 cases, so
   it wouldn't catch this. **Multi-archetype pre-req (queued):** before any
   non-iPhone archetype ships, make `pointerToViewport` letterbox-aware —
   compute `scale = min(rect.w/nw, rect.h/nh)`, subtract the centered
   `offset = (rect.w - nw*scale)/2` (and y), divide by `scale`. This is
   backward-compatible (algebraically identical when aspects match) so the
   existing matched-aspect tests stay green. NOT auto-fixed: the fix forces a
   **UX decision** for clicks that land in the letterbox bar (clamp to the
   nearest content edge / return `null` to ignore / pass through
   out-of-bounds) — best made by the multi-archetype implementer with product
   context; and two content-parity tests pin the current `pointerToViewport`
   source, so the source + pins must change together.

8. **Profile-snapshot write ops don't enforce `write:profiles` — a
   read-scope key can mutate a profile via snapshot restore.** The
   `/v1/profiles/.../snapshots` routes (`apps/server/src/routes/
profile-snapshots.ts`) gate writes with only `app.requireAuth` + a
   team-targeting role check (line 38), and `ProfileSnapshotsService`
   (`capture` / `restore` / delete) has **zero** scope checks — the injected
   `profilesService` is `void`-ed (line 223-225, only to silence an
   unused-var warn), so there's no delegation to the scope-enforcing profiles
   service either. But `scopes.md` (line 44) defines `write:profiles` as
   gating profile create/delete, and **`restore` mutates the profile's state
   (applies the snapshot's cookies/storage)** — so a key with `read:profiles`
   (or bare `read`) can capture/restore/delete snapshots, mutating a profile
   without the write scope. This is the same gap class as the resolved
   read-write-scope finding, on a resource (profile-snapshots) that the
   `requireScope` rollout apparently missed (the enforced list named
   "profiles" but not its snapshots sub-resource). Pre-launch, so no real
   integration breaks. **Recommended fix:** add `throwIfMissingScope(ctx,
'write:profiles')` to `restore` + delete in `ProfileSnapshotsService`
   (service-layer, matching the webhooks/email-preferences pattern); decide
   whether `capture` is a write (creates a snapshot record) or read (doesn't
   mutate the live profile) and gate accordingly. NOT auto-fixed: it's a
   security-model decision (which snapshot ops are reads vs writes; whether
   snapshots share the parent `write:profiles` scope or get their own), and
   adding enforcement is a behavior change (a read key that can restore today
   would start getting 403) that the scope-enforcement parity tests should
   pin.

9. **`env-vars.md` omits several operator env vars the server actually
   reads.** An env-read audit (`process.env.X` dot-access in `apps/server/
src`) vs `docs/deployment/env-vars.md` + `docs/operations/
production-env-schema.md` found these read-but-undocumented-in-both:
   `CORS_ALLOWED_ORIGINS`, `NOWPAYMENTS_IPN_CALLBACK_URL`,
   `BROADCAST_SLACK_WEBHOOK_URL`, `BROADCAST_GENERIC_WEBHOOK_URL`,
   `PUBLIC_STATUS_PAGE_URL`, `DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS`
   (plus `PERMISSIVE_CORS` + `GIT_SHA`, which are reasonably omitted — dev
   flag + deploy-injected). Triage: `CORS_ALLOWED_ORIGINS` IS in
   `infra/env-templates/{staging.env,production.env.template}` so operators
   deploying from the templates set it (no breakage) — it's just missing
   from the human-readable doc. `NOWPAYMENTS_IPN_CALLBACK_URL` is in **no**
   deploy surface at all (template or doc) and gates crypto-billing IPN
   callbacks — the one worth confirming before crypto-billing goes LIVE. The
   broadcast webhooks + status URL + rotation-reminder toggle are
   optional/operational. **Recommended fix:** add the operator-relevant vars
   to `env-vars.md` with required/optional + default + purpose. CAVEAT: this
   audit caught only `process.env.X` _dot-access_ reads — a complete pass
   should also sweep destructured `const { X } = process.env` reads
   (bootstrap/config) before declaring the doc exhaustive. Low-risk doc fix
   (no intent decision); deferred only because the complete-list sweep +
   accurate per-var descriptions are worth doing in one pass.

## Minor hardening notes (NOT findings — surfaced by the security audits)

These came out of the systematic route-security sweep (scope / ownership /
rate-limit / input-validation / secret-exposure / CORS / PII-in-logs). They
are **not bugs** — the default postures are secure and the gaps require a
deliberate insecure config or a privacy-policy choice — but they're recorded
here so they aren't lost. No action unless the posture below is wrong.

- **CORS `PERMISSIVE_CORS` has no prod fail-fast.** `bootstrap.ts:1362`
  reads `PERMISSIVE_CORS` (default false → allowlist mode, secure). When
  `true` the app uses `origin: true` + `credentials: true` — fine for dev,
  dangerous in prod. The codebase already fails fast on insecure prod config
  (`DASHBOARD_ORIGIN` refuses localhost in prod), so a parallel guard
  refusing `PERMISSIVE_CORS=true` in prod would be consistent. NOT done here
  because "prod vs staging" detection is non-trivial — **staging may
  legitimately want permissive CORS with a prod-like `NODE_ENV`**, so the
  guard needs a prod-only signal the operator confirms.
- **V-494 log redaction covers secrets, not PII.** `logger.ts` redacts
  `authorization` / `*password` / `*secret` / `totp_secret` / `client_secret`
  but not `email`/`to`/`ip`, so operational logs (`email.ts:653` "email sent"
  with `to`; the IP rate-limiter) carry customer email + IP in plaintext.
  This is standard legitimate-interest operational logging and V-494's
  secret-only scope looks deliberate — but if the EU/GDPR posture wants log
  PII-minimization, add `to`/`email`/`ip` to the redact paths (or hash them).
  A privacy-policy call, not a bug.

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

### Continued (later in the session)

Additional shipped fixes (all on `main`, gate-green):

- `sdk-go` `CryptoOrders.Iterate` now treats an empty-string `next_cursor`
  as terminal (matched the 3 sibling Go iterators; was a latent
  loop-on-page-1 risk; parity pin updated same commit).
- `sdk-typescript` `buildUrl` switched from `new URL(path, baseUrl)` to
  `new URL(baseUrl + path)` so a self-hosted base-URL path prefix is
  preserved (the `new URL` form silently dropped it); identical output for
  every host-only base, fixes path-prefixed bases; +2 regression tests.
- `docs/reference/errors.md` `legal-acceptance-required` row corrected
  `403`→`409` + TS class `ForbiddenError`→`LegalAcceptanceRequiredError`
  (all code surfaces use 409 + LegalAcceptanceRequiredError).

Guard-strengthenings shipped:

- `docs/reference/rate-limits` parity guard extended to pin global-refill,
  agent_sessions:message capacity, and the input_event capacity/refill prose
  (was: only the two capacity columns).
- New `errors-md-status-vs-code-parity` guard pins the errors.md Status
  column against every ApiError subclass status (closes the gap that hid the
  legal-acceptance drift).

### Verification coverage (checked-and-clean, this session)

So findings + fixes above are the _exceptions_; the bulk of the session was
verification that came up sound, recorded here so the assurance scope is
known: all 3 SDKs (retry/webhook-sig/error-dispatch/headers/baseURL/
pagination/examples/READMEs); billing/rate-limit/crypto-orders/stripe-webhooks/
webhook-delivery services; all money paths (cost-estimator, agent-decomposer
LLM cost, crypto-orders, bundled-LLM budget gating); 7 route-security
properties (scope/ownership/rate-limit/input-validation/secret-exposure/
CORS/PII-logs); agent-decomposer (model-id current, cost math, AUP refusal
layer, prompt↔validator verb parity); the full behavioural-simulation +
recapture packages; LiveKit token authz; OpenAPI route+auth coverage;
metrics catalogue; and the Drizzle keyset/cursor/sweep paths
(crypto-sweep, webhook-durable list+DLQ, timestamp-cursor migration ≡
profiles-repo) structurally verified equivalent to their proven references
(residual: still no live-Postgres integration test for those Drizzle paths).
