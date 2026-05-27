# 2026-05-26 — doc/accuracy sweep: shipped fixes + open founder-gated findings

Autopilot (Agent 2) ran a long doc/parity/accuracy + light implementation
sweep across every customer-facing surface (api docs, marketing, all three
SDKs incl. examples + READMEs, runbooks, deployment docs, legal, reference
docs, badge/enum completeness, and a pass over the complex packages). This
note surfaces the items that need a **human decision** — they were
deliberately NOT auto-fixed because the correct resolution depends on
intent or touches untestable/external state.

## Priority triage (read this first)

Fast index over the 14 open findings, grouped by urgency. Full detail in
the numbered list below.

- **Do before launch / now (security + go-live gates):**
  - #4 — rotate the exposed staging Neon password + fix malformed staging `.env` (security).
  - #6 — trial-pack credit granted but never decremented; "~16h" email + "decrements at session_end" copy are unenforced (LAUNCH GATE before trial-pack goes LIVE).
  - #8 — profile-snapshot write ops (capture/restore/delete) don't enforce `write:profiles`; a read-scope key can mutate a profile via snapshot restore (security; pre-launch so no break yet).
- **Live customer-impact (wrong behavior today):**
  - #13 — RESOLVED 2026-05-27: webhook rotation-grace dual-`v1=` verification fixed across all 3 SDKs (collect-all-`v1`, accept any). Was a LIVE-path bug.
  - #14 — [RESOLVED 2026-05-27] BYOK rotation email + status-pill linked to 404 dashboard routes; repointed both to the API docs (BYOK stays API-only).
- **Latent, high-impact on a planned event:**
  - #12 — V-173 forward-path webhook delivery signs bare-hex; breaks ALL SDK verification on the durable-impl cutover. (Fix #12 + #13 together — one webhook-signature pass; both rooted in a missing server-sign→SDK-verify e2e test.)
  - #15 — LLM cost rate card models 4o-mini but the agent runs Opus 4.7 (~100× under-estimate); inert until LLM usage metering lands, then (a) under-reports bundled-LLM margin alerts AND (b) makes the customer-facing bundled-LLM budget soft-cap deplete ~100× too slowly (customers get ~100× more bundled Opus than the cap intends). Rate must be right in the writer BEFORE bundled-LLM goes LIVE. (Fix with #6 / V-541.J/K — same deferred metering subsystem.)
- **Contract / intent decisions (pick a direction, then align sources):**
  - #5 — webhook retry count: code does 4 retries, docs + rationale promise 5; the guard is toothless.
  - #10 — crypto checkout accepts `trial_pack` but crypto quote 400s it.
  - #1 — [RESOLVED 2026-05-27] idempotency reference doc described a TTL-sweep job that doesn't exist; rewritten to real per-subsystem behaviour.
  - #3 — TS SDK User-Agent frozen at 0.0.1 vs package.json 0.1.6 (contradictory pin vs W834).
- **UI / ops / completeness (lower urgency):**
  - #7 — `pointerToViewport` object-contain mis-mapping (multi-archetype blocker, latent).
  - #2 — runbook references a one-shot sweep script that was never built.
  - #9 — env-vars doc completeness — RESOLVED (6 vars documented; residual: confirm `NOWPAYMENTS_IPN_CALLBACK_URL` before crypto LIVE).
  - #11 — OpenAPI spec is a curated subset of the documented customer surface (decide complete vs curated).

## Open — need your call

1. **[RESOLVED 2026-05-27]** idempotency reference doc described a TTL
   mechanism that doesn't exist. **Resolution:** rewrote the TTL-enforcement
   bullet (`apps/docs/src/pages/reference/idempotency.md`) to the real
   per-subsystem behaviour — crypto-orders = in-memory 24h lazy prune
   (entries deleted), resource-backed keys (agent_sessions) = persistent
   partial-unique index with no TTL. The persistent index is intended (it
   is the direct consequence of the "the resource row IS the cache"
   storage model documented in the same section), so no sweep job was
   added. Whether agent_sessions keys should additionally gain a 24h TTL
   stays an optional future product call — not a doc bug. Original finding
   below for reference.

   `apps/docs/src/pages/reference/idempotency.md` (Edge-cases
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

9. **`env-vars.md` omitted operator env vars — RESOLVED 2026-05-27 (mostly;
   one operator action remains).** The 6 read-but-undocumented operator vars
   (`CORS_ALLOWED_ORIGINS`, `NOWPAYMENTS_IPN_CALLBACK_URL`,
   `BROADCAST_SLACK_WEBHOOK_URL`, `BROADCAST_GENERIC_WEBHOOK_URL`,
   `PUBLIC_STATUS_PAGE_URL`, `DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS`) are
   now documented in `docs/deployment/env-vars.md` (new "Operational /
   optional" section, with required/optional + default + purpose; all 5
   env-vars parity tests stay green). Re-audit corrections: the original
   draft also listed `DRIFTSTACK_STAFF_EMAILS` + `PUBLIC_API_BASE_URL` as
   undocumented, but both were ALREADY documented (a broken multi-path grep
   false-flagged them); `PERMISSIVE_CORS` + `GIT_SHA` remain reasonably
   omitted (dev flag + deploy-injected). **Residual operator action (NOT a
   doc gap):** `NOWPAYMENTS_IPN_CALLBACK_URL` is still in no deploy surface
   (template or `.env`); it defaults to `https://api.driftstack.dev/v1/webhooks/nowpayments`,
   so confirm that resolves to the live API origin before crypto-billing
   goes LIVE. CAVEAT: this audit covered `process.env.X` dot/bracket reads +
   single-line destructuring; vars read only via multi-line destructuring or
   the central config Zod schema (DATABASE_URL etc., already documented) were
   not re-swept — the 6 above were the known operator-facing gap.

10. **Crypto quote vs checkout product lists disagree on `trial_pack`
    (minor).** Crypto **checkout** derives its accepted-product enum from
    `TIER_PRICE_CENTS` keys (`billing-crypto.ts:96` —
    `Object.keys(TIER_PRICE_CENTS)`), which includes 7 products **incl.
    `trial_pack`**. But the crypto **quote** route hardcodes a 6-product list
    (`billing-crypto-quote.ts:26`) — the recurring tiers only, **omitting
    `trial_pack`** (and enterprise). So `POST /v1/billing/crypto-checkout`
    accepts `product: 'trial_pack'`, but `POST
/v1/billing/crypto-checkout/quote` 400s for it. Both routes price from
    the same `TIER_PRICE_CENTS` (no price divergence), and the quote 400 is
    graceful (not a crash), so impact is low — a customer can crypto-checkout
    the $2.99 trial but can't get a crypto _quote_ for it first. **Decide:**
    either `trial_pack` should be crypto-quotable (derive the quote list from
    `TIER_PRICE_CENTS` too, matching checkout), or the $2.99 one-time trial
    should NOT be crypto-checkout-able (Stripe-only) and should be excluded
    from `TIER_PRICE_CENTS` / the checkout enum. NOT auto-fixed: which is the
    product intent (is the trial crypto-purchasable?) is a founder call, and
    deriving the quote list vs trimming checkout are opposite resolutions.

11. **OpenAPI spec is a subset of the documented customer surface (low).**
    Several customer endpoints that have a Markdown doc page on
    docs.driftstack.dev are absent from the hand-written OpenAPI spec
    (`apps/server/src/lib/openapi.ts`), so they don't appear in the
    Scalar reference UI at api.driftstack.dev/docs. Confirmed concrete
    cases (route registered + Markdown-documented + NOT in spec):
    `/v1/account/cost` (api/cost-monitoring.md), `/v1/account/me/notifications`
    (api/account-notifications.md), `/v1/agent-sessions/:id/transcript`
    (api/agent-sessions.md), `/v1/profiles/:id/launch` (api/profiles.md).
    Of 21 registered customer routes absent from the spec, ~8 are
    _correctly_ excluded — `/v1/internal/atlas-priority/*` (internal),
    `/v1/webhooks/{nowpayments,stripe}` (inbound provider webhooks),
    `/v1/proxies/:id/test` (503 stub, egress unwired), `/v1/status/stream`
    (SSE, doesn't fit OpenAPI). Impact is low: the SDKs are hand-written
    (no codegen miss), the Markdown docs are the primary reference, and
    every spec path IS backed by a real route (no phantom endpoints —
    `openapi-route-coverage` pins that direction). **Decide:** is the
    OpenAPI spec meant to be the _complete_ customer surface (then add the
    ~4 confirmed-missing endpoints' request/response schemas) or a curated
    core subset (then it's fine as-is)? NOT auto-fixed: which endpoints
    belong in the public spec is a product/surface decision, and writing
    full OpenAPI schemas per endpoint is substantial. `openapi-route-coverage`
    only pins a hardcoded CORE allowlist into the spec + the no-phantom
    direction; it does not assert spec-completeness, so this is uncaught.

12. **Forward-path webhook delivery signs with an incompatible header
    scheme — breaks SDK verification on cutover (latent, high-impact).**
    The published contract is a Stripe-style compound header:
    `X-Driftstack-Signature: t=<unix-seconds>,v1=<hex>`, HMAC-SHA256 over
    `<t>.<body>` — documented in `webhooks/events.md:64`, verified by all
    three SDK helpers (`verifyWebhookSignature` parses `t=`/`v1=` from the
    single header), and emitted by the **production-today** path
    (`webhook-worker.ts` → `signWebhookPayload` in `lib/webhook-signing.ts`,
    which formats `t=…,v1=…`). BUT the **V-173 FORWARD path** —
    `DurableWebhookDeliveryService` (`durable-webhook-delivery.ts:558`
    `signPayload`) and the `@driftstack/webhook-delivery` package's
    `InMemoryWebhookDelivery` (`packages/webhook-delivery/src/in-memory.ts:515`)
    — emit a **bare hex** digest in `x-driftstack-signature` and put the
    timestamp in a SEPARATE `x-driftstack-emitted-at` header. Feeding that
    bare-hex header to the SDK verifier fails `parseSignatureHeader` (no
    `t=`/`v1=`) → returns `false` for every delivery. So when the planned
    migration ("replace webhooks.ts is a separate future V-NNN", per the
    durable service's coexistence note) cuts deliveries over to the durable
    / package implementation, **every SDK customer's webhook verification
    silently breaks.** Latent today (durable path is not wired in bootstrap;
    `webhook-worker.ts` owns production). Root cause: there is **no
    end-to-end test** bridging an emitted signature header to the SDK
    verifier — each side is unit-tested against its OWN format, so the
    divergence is invisible (the classic cross-layer-plumbing gap). **Fix
    (with the cutover, not piecemeal):** route the durable + package signing
    through the canonical `signWebhookPayload` (`t=,v1=` formatter), drop the
    separate `x-driftstack-emitted-at` reliance, update the bare-hex tests in
    `packages/webhook-delivery`, and add a server-sign → SDK-verify e2e test
    FIRST so the contract is locked. NOT auto-fixed: cross-package change
    tied to an in-flight migration whose cutover sequencing is a coordination
    call; a partial fix would re-create the same broken-chain footgun.

13. **Rotation-grace dual-`v1=` signing breaks SDK verification for
    new-secret adopters — RESOLVED 2026-05-27 (8351d21b).** Fixed across all
    3 SDKs: the verifiers now collect EVERY `v1=` from the header and accept
    if the computed HMAC matches ANY (constant-time per candidate), so a
    customer holding either the new or old secret passes the dual-`v1=`
    single-header form mid-rotation (TS `signatureHexes[]`/`.some()`, Python
    `signature_hexes`/`any(compare_digest)`, Go `signatureHexes`/loop).
    Backward-compatible (single-`v1` = one-element; `headerPrev` path
    unaffected). Added dual-`v1` rotation tests in all 3 SDKs, updated the
    per-SDK + cross-SDK content-parity pins, and rewrote the
    `webhook-signing.test.ts` block that had documented the last-wins
    "limitation" (it now asserts BOTH secrets verify) + corrected its stale
    "webhook-worker only single-signs" comment. Full gate green. Original
    finding below for reference:

    During a webhook-secret
    rotation's 24h grace window, the production worker
    (`webhook-worker.ts:163`) dual-signs Stripe-style into ONE header:
    `x-driftstack-signature: t=<ts>,v1=<HMAC-new>,v1=<HMAC-old>` (via
    `signWebhookPayload` with `secretPrev`), and emits NO separate
    `x-driftstack-signature-prev` header. But every SDK verifier parses
    `v1=` **last-wins** — TS `parseSignatureHeader` (`signature = v`,
    webhook-signature.ts) and Python `_parse_signature_header`
    (`signature = value`, line 58); Go by cross-SDK parity — so it keeps
    only the LAST `v1=` (`HMAC-old`) and its rotation model expects the old
    sig in a SEPARATE `headerPrev` (`x-driftstack-signature-prev`) the prod
    worker never sends. Net effect during grace:
    - customer still on the OLD secret → matches `HMAC-old` (last v1) → OK;
    - customer who already rolled their verifier to the NEW secret →
      computes `HMAC-new` = the FIRST v1, which the SDK discarded → silent
      verification **failure** until grace expires.
      So the diligent customer who updates promptly (exactly what rotation
      grace is for) gets failures. Uncaught: the SDK rotation test only
      exercises the separate-`headerPrev` model (webhook-signature.test.ts
      "rotation grace (headerPrev)"), never the worker's actual dual-`v1`
      single-header output; `cross-sdk-webhook-signature-parity` pins the
      single-`v1` format string but not multi-`v1` verification. **Fix
      (one coherent webhook-signature pass with #12):** make the SDK parsers
      collect ALL `v1=` entries and accept if ANY matches (the real Stripe
      model) across TS/Python/Go, OR have the worker emit the old signature
      in a separate `x-driftstack-signature-prev` header (matching the SDK's
      existing `headerPrev` path + the durable impl). Add a worker-output →
      SDK-verify rotation e2e test. NOT auto-fixed: 3-SDK change to security-
      critical verification logic + a rotation-model decision (multi-`v1` vs
      separate header) that should be settled together with #12.

14. **[RESOLVED 2026-05-27]** BYOK-key rotation email + status-pill linked
    to dashboard routes that don't exist. **Resolution:** took option (b) —
    BYOK management stays API-only (no dashboard UI built). Repointed the
    `byok-anthropic-key-rotation-reminder` email's rotation instructions to
    the working API docs (`https://docs.driftstack.dev/api/byok-anthropic`,
    HEAD 200) and kept its `dashboardUrl` meaningful by pointing the status
    link at the real `/agent-sessions` page (which carries the BYOK status
    pill). Repointed the `agent-sessions.astro` status-pill "Manage key"
    link from the BYOK-less `/settings#byok-anthropic` to the same API docs
    URL. Building a dashboard BYOK UI (option a) stays a future product
    option — not foreclosed. Original finding below for reference.

    BYOK-key rotation email links to a dashboard route that doesn't
    exist; there is no dashboard BYOK-management UI at all (moderate).
    The `byok-anthropic-key-rotation-reminder` email (`email.ts:480`) tells
    customers to "update it on your Driftstack account at
    `${dashboardUrl}/account/byok-anthropic`". The customer-dashboard has
    **no `/account/` route** (pages are flat — no `account/` dir, no
    `_redirects`, no catch-all), so the link 404s. Worse, there is **no BYOK
    management UI anywhere** in the dashboard or the gui-client — exhaustive
    grep finds only a status-pill GET on `agent-sessions.astro`
    (`/v1/account/me/byok-anthropic-key`, read-only) and no set/rotate form.
    BYOK management is **API-only** (`api/byok-anthropic.md` documents
    `PUT`/`DELETE`/`POST …/test`). Compounding: the dashboard's own
    status-pill "manage" link (`agent-sessions.astro:202`) points to
    `/settings#byok-anthropic`, but `settings.astro` (1945 lines) has **zero**
    BYOK content — so that target is also broken. So a customer who gets the
    rotation nag has no working link from either the email or the dashboard to
    actually rotate the key (they must hit the API directly). **Decide:**
    either (a) build the BYOK-management section the email + status-pill
    already reference (then pick ONE canonical path and make email +
    `agent-sessions.astro:202` agree on it), or (b) keep BYOK API-only and
    repoint the email + the status-pill link to the docs
    (`docs.driftstack.dev/api/byok-anthropic`, which documents the
    `PUT` rotate flow). NOT auto-fixed: whether a dashboard BYOK UI is
    intended-but-unbuilt vs. deliberately API-only is a product call, and the
    email body is parity-pinned.

15. **LLM cost-to-serve rate card models OpenAI 4o-mini but the agent uses
    Claude Opus 4.7 — ~100× under-estimate (latent, gated with #6).**
    `cost-defaults.ts` sets `llmCentsPer1kInputTokens: 0.015` /
    `llmCentsPer1kOutputTokens: 0.06` with comments "OpenAI 4o-mini input/
    output list price". But `agent-decomposer-claude.ts:37` runs
    `claude-opus-4-7`, whose list price is **$15 / $75 per Mtok** = `1.5` /
    `7.5` cents per 1k — ~100× higher than the configured rate (and Opus's
    5× output/input ratio vs the rate card's 4×). The cost engine math is
    correct (`(tokens/1000) * ratePer1k`); the inputs are mis-calibrated for
    the actual model. Prod wires `DEFAULT_COST_RATES` directly
    (`bootstrap.ts:1011`); `/v1/admin/cost/config` is a **read-only**
    inspector (no runtime override), so a rate change is a code edit + deploy.
    **Latent today:** the LLM usage dimension is hard-zero until the
    `usage_records` writers land (`bootstrap.ts:1020` "llm dimensions zero
    until V-541.I/J/K") — the SAME deferred metering subsystem as #6 — so
    `llmCents` computes to 0 regardless of the rate right now. It does not
    drive fiat customer billing (the `cost-defaults-v541f` invariant confirms
    that). **When V-541.J/K wires LLM metering**, the 100×-low rate has TWO
    downstream effects: (a) bundled-LLM cost-MONITORING under-reports LLM
    cost-to-serve ~100×, defeating the soft/hard margin alerts
    (`deriveThresholdsFromMonthlyPrice` = 60% / 90% of selling price); AND
    (b) — newly traced — the **customer-facing bundled-LLM budget soft-cap**
    sums `usage_records.cost_usd_cents` (`bundled-llm.ts:30`), so if the
    deferred writer prices Opus tokens at the 4o-mini rate, each bundled-LLM
    customer's monthly cap depletes ~100× too slowly → they get ~100× more
    bundled Opus usage than the cap intends before the soft-cap fires. So the
    rate must be correct in the writer BEFORE bundled-LLM goes LIVE, not just
    for internal alerting. **Decide + fix with #6/V-541.K:** set the rate to
    the actual model's cost-to-serve (Opus 4.7 list, a negotiated rate, or
    whatever the bundled-LLM model ends up being) and correct the 4o-mini
    comments. NOT auto-fixed: the true cost-to-serve number is a finance/
    model-choice decision, and it's inert until the deferred metering lands.

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
- OpenAPI spec for `GET /v1/admin/accounts` advertised `limit` max `200`
  but the route (`ListAdminAccountsQuerySchema`) enforces `100` — spec
  aligned to the enforced value (an integrator trusting the spec who sent
  `limit=150` would have hit an unexpected `400`). Same commit corrected
  `reference/pagination.md` "Limit bounds": no endpoint defaults to `20`
  (all default `50`), and the `200` max applies only to a few admin
  endpoints (status-subscribers), not admin endpoints broadly.

Guard-strengthenings shipped:

- `docs/reference/rate-limits` parity guard extended to pin global-refill,
  agent_sessions:message capacity, and the input_event capacity/refill prose
  (was: only the two capacity columns).
- New `errors-md-status-vs-code-parity` guard pins the errors.md Status
  column against every ApiError subclass status (closes the gap that hid the
  legal-acceptance drift).

### Wave 2 (2026-05-27) — additional shipped fixes + guards

Fixes (all on `main`, gate-green):

- `reference/cost-monitoring.md` `thresholdState` value corrected `between`
  → `between-soft-and-hard` (example + state table); the cost engine emits
  `between-soft-and-hard` (`cost-estimator.ts:111`), so a customer branching
  on `=== 'between'` never matched.
- Admin UI cost-badge key corrected `between` → `between-soft-and-hard` in
  `cost.astro` + `accounts/[id].astro` — the soft-warn account state was
  rendering the gray default badge instead of amber (same drift class as the
  doc fix; the stale value had propagated to two admin pages).
- `docs/deployment/env-vars.md` — documented the 6 operator env vars the
  server reads but the canonical schema omitted (resolves finding #9; see #9
  for the residual `NOWPAYMENTS_IPN_CALLBACK_URL` operator action).

Guard-strengthenings:

- `openapi-admin-list-limit-bounds-parity` — pins the spec's `limit` max to
  the route schema's for every admin list endpoint (the class behind the
  /v1/admin/accounts 200-vs-100 fix).
- `scope-enforcement-literals-valid` — scans all ~135 `requireScope` /
  `throwIfMissingScope` call sites; asserts each scope literal ∈
  ApiKeyScopeSchema + bans the bare legacy `'admin'` (V-174 defense).
- `rate-limit-bucket-literals-valid` — scans `rateLimit('…')` call-site
  buckets against the TIER_RATE_LIMIT_DEFAULTS roster.
- `docs-cost-monitoring-threshold-parity` + `admin-cost-threshold-badge-keys-parity`
  — pin the thresholdState value across the doc + both admin badge maps
  (regression protection for the two fixes above).
- `docs-sdk-install-package-names-parity` — pins sdk/installation.md install
  commands to the real npm/PyPI/Go package identities (rename → install break).

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
