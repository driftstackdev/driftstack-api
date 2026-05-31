# 2026-05-31 — autopilot session: shipped, verified, and open founder-decisions (Agent 2)

A consolidated record of what was fixed + **verified** during the 2026-05-31
autopilot run, and the open items that are **gated on a founder decision** (so
the scattered commit history + the agent's working memory don't have to be
re-derived). Companion to `2026-05-30-launch-readiness-verification.md`.

## Update 2026-05-31 PM — founder decisions executed

Founder re-engaged and ruled on the gated profile-DELETE items + the
archetype examples. Shipped (3 commits, full pre-push gate green —
21,769 tests):

- **Decision 1 (force/409) → RETRACT** (`1cd681b5`). Deleted the guide's
  `force=false → 409` paragraph + repointed its parity pin; the route never
  implemented it and prod runs the mock driver, so the contract can't be
  honored yet. Re-add when profile↔session binding is queryable.
- **Decision 2 (idempotency) → MAKE IDEMPOTENT** (`1cd681b5`, same commit).
  `DELETE /v1/profiles/:id` now returns `204` on an already-deleted/unknown
  id (was `404`), matching the OpenAPI summary, api/profiles.md, all 3 SDKs
  (cross-sdk pin), and the sibling destroy verbs. Audit emit skipped on no-op.
- **Decision 7 (archetype examples) → HELD.** No archetype-bearing examples
  added; the 29 value-safe examples stand. Cutover stays deferred (code +
  guide parity still pin `iphone16pro_ios18_7_safari26_4`).
- **Plus, found + fixed a drift while shipping the above:** the in-flight
  profiles `operationId`s landed (`400ae39d`), and that surfaced that the
  whole recent `openapi.ts` arc (38 operationIds, ~29 examples, the
  export/import/transfer paths) had **never been dumped into the committed
  `packages/sdk-python/openapi.json` snapshot** — it was at 0 operationIds /
  151 paths vs the live 38 / 154. No test or CI step regenerates-and-diffs
  it, so the drift was silent. Resynced in `4bddde5a` (generated artifact,
  0 path removals, BearerAuth + pinned version 0.0.1 untouched).
  - **Pending codegen disclosure:** the resync brought 5 schemas the stale
    snapshot lacked (`AgentSession`, `AgentIntent`, `IntentResult`, `Recipe`,
    `RecipeDetail`) into `openapi.json`. `models.py` is regenerated from it by
    `datamodel-codegen` (not in this env), so it now lags the spec by those 5
    classes — a **pending `scripts/generate.sh` run**, joining the already-known
    webhook-crypto `Literal` regen residual. Runtime SDK unaffected (Python CI
    job green; `models.py` untouched + still parity-pinned).
  - **Guard is a cadence call (your decision), not an obvious fix:** a strict
    "live spec == committed snapshot" CI check would have caught this, BUT it
    forces a snapshot regen on _every_ `openapi.ts` change — which widens the
    `openapi.json`→`models.py` codegen lag more often. Better may be to regen
    the snapshot **and** run `datamodel-codegen` together at SDK-release
    checkpoints. Pick the cadence; I'll wire whichever guard fits it.

Items 3–6 + 8 below remain open / your call.

## Shipped this session (11 commits, each full-gate-green + CI-confirmed)

- **Profiles name-uniqueness race class — CLOSED.** Every path that inserts/renames
  against `profiles_account_name_unique` (create / clone / import / transfer /
  snapshot-restore / update-rename) now catches the concurrent-race `23505` and
  returns the same clean `409` its pre-check returns, instead of an uncaught
  `500`. One shared `isProfileNameRaceViolation` detector + drift-guard pins.
  Same class also fixed earlier for agent-sessions idempotency + signup same-email.
  (`703f2d82`, `f05ff477`, `a8fc616e`)
- **API-key rotate hardening.** Rotating an already-**expired** key minted a
  born-dead key (auth rejects it immediately) — now rejected like a revoked key.
  Also corrected a security-misleading comment that claimed the grace expiry is
  "the LATEST of (existing, now+grace)" when the code takes the **EARLIER** (min);
  the wrong wording, if trusted, would _extend_ rotated-away key lifetimes.
  (`48ed18d5`)
- **Security drift-guard (IDOR).** Pins the two `*Unscoped` by-id finders
  (`findSessionUnscoped` / `findApiKeyUnscoped`) as callable **only** from
  `routes/admin-force-actions.ts`; any new caller anywhere in `apps/server/src`
  now fails the gate (prevents a future customer-reachable IDOR). (`0768567e`)
- **OpenAPI 404-doc accuracy.** The customer-facing `{id}` routes now document the
  `404`/`409` their handlers actually return — profiles, webhooks (×6), sessions
  (×5), snapshots (×4, + restore's 409), agent-session message, web-session
  revoke, and the internal admin routes that 404. Each verified to genuinely
  throw before documenting. (`dd38814e`, `caa0b931`, `3e52e2d4`, `9503cbbf`,
  `94291438`)
- **gui-client SSE cleanup.** The notification `subscribeNotifications` close
  handle now removes the per-kind EventSource listeners too (was relying on GC of
  the closed source) — complete teardown per its documented contract. (`81f9da4d`)

## Verified clean this session — do NOT re-investigate without a new vector

A deliberate, verify-before-build sweep across every surface Agent 2 can safely
touch. All came back sound (or the one real gap is listed under decisions below):

- **Security**: IDOR/ownership, auth-cache invalidation (~11 mutation paths all
  invalidate), admin-route authz (all `driftstack_internal_admin`-gated),
  error-handler info-disclosure (CWE-209-safe), input-validation, payment-webhook
  signatures, suspended/deleted-account auth-blocking (`auth.ts:303`, tested).
- **Money-path**: usage/cost/token-budget accounting, billing transitions, crypto
  amounts — rounding is conservative (`Math.ceil` for charges) + caps use the
  right operator; the estimator-`round` vs billing-`ceil` difference is by design.
- **All three SDKs** (TS/Go/Python): retry/backoff, constant-time webhook
  verification, pagination, idempotency-key, auth-header construction.
- **Data-lifecycle**: cascade-on-account-delete, snapshot ON-DELETE-SET-NULL
  (founder pg_dump model), webhook-delete cascade + worker DLQ, recipe SET NULL —
  all safe-by-design (two exceptions under decisions below).
- **gui-client** (Tauri) + the wired packages (webrtc-streaming encoding pipeline,
  recipe-library) — thin/tested/clean.
- **Customer docs**: the high-drift numbers (rate limits, tier caps, concurrent
  limits, 20-min free session, default model, 100k token budget, backoff
  schedule, pagination 50) are all parity-pinned + correct.

`verify-before-build` caught **7 overstated/false "bugs"** from the hunts
(rate-limit header float/floor, money round/ceil, admin-session-destroy cache,
suspend-sessions "security" angle, SettingsView "key leak", lifecycle Finding-1
severity, billing-crypto "redelivered 5 times") — none were real.

## Gated on a founder decision (the next tier of value)

Ordered by launch-risk. Each is real, but the resolution is a product/policy call
or a non-trivial feature/migration that the agent should not make unilaterally.

1. **[LAUNCH RISK] Profile DELETE documents a `force`/bound-session-blocking/`409`
   contract that the code does not implement.** `guides/profile-management.md:137`
   ("the deletion blocks until the session ends, or returns `409 Conflict` if you
   set `force=false`, the default") is parity-**pinned** at
   `docs-pages-guides-profile-management-content-parity.test.ts:149` as "the W763
   DELETE contract" — but `routes/profiles.ts` delete is just `service.delete →
204` (no `force` param, no session check, no `409`). The parity test passes
   because it pins the doc _text_, not the code _behavior_, so doc+test agree with
   each other while diverging from the code. A customer who follows the guide and
   sets `force=false` gets a silent `204`. **Decide: implement the W763 feature
   (bound-session detection + `force` query param + `409`), or retract it from the
   doc AND the parity test.** Not referenced as planned anywhere in `src/` or
   `docs/planning/`.

2. **Profile DELETE "idempotent" wording vs hard-delete `404`.** Both the OpenAPI
   summary and `api/profiles.md:304` say the delete is "idempotent," but the code
   hard-deletes, so a re-delete returns `404` (non-idempotent — unlike session
   destroy + webhook soft-delete, which are genuinely idempotent). Two doc sources
   saying "idempotent" suggests the _intended_ contract is idempotent and the
   _code_ is the gap. **Decide: make the code idempotent (return `204` even when
   already gone — matches REST + the docs), or change all the wording to
   non-idempotent.** (Left the OpenAPI 404 off `DELETE /v1/profiles/{id}` pending
   this.)

3. **Account suspend() doesn't reclaim the account's running sessions.** Security
   is already covered (`auth.ts:303` blocks every suspended request; the cache is
   invalidated on suspend), so the only residual is **compute** — a browser
   session keeps running on the driver until its auto-destroy timeout. It's a
   future concern (prod runs the mock driver today) + bounded, and whether suspend
   should proactively destroy sessions vs. rely on auth-block + timeout is a policy
   choice (suspend is reversible via unsuspend). If wanted, the fix needs a new
   `findActiveSessionsByAccount` repo finder + a `destroyAllForAccount` service
   method, and note it fires `session.completed` webhooks on forced destroy.

4. **`agent_sessions.driftstack_session_id` has no FK** (schema.ts ~1758): a `text`
   column pointing at `sessions.id` with no `.references()`, so destroying a
   session leaves dangling values. Impact is a data-cleanliness smell only (the
   consumer falls back to `'unattached'`). Fix needs a **migration** + a text→uuid
   type reconciliation — bundle into a future schema-cleanup pass with review.

5. **Stripe webhook concurrent double-DISPATCH.** On a true concurrent same-event
   race both deliveries run `dispatch()` (duplicate emails/audit) before the
   ledger resolves — a _deliberate_ at-least-once trade-off (the code comments
   it). The obvious "claim-first" fix trades this for a worse failure (events lost
   if the process dies mid-dispatch). Decide only if rare duplicate emails matter
   more than the lost-event risk; needs idempotent handlers or a claim-row +
   crash-recovery sweep.

6. **TS + Go SDKs lack profile export/import/transfer methods** (they have
   clone/launch). The endpoints exist + are now OpenAPI-documented; this is an
   SDK-surface coverage decision + multi-SDK feature work.

7. **OpenAPI has ZERO examples (launch-DX).** Verified: 0 examples in `openapi.ts`
   AND in the live 369 KB `/openapi.json` (Scalar does not auto-generate them). So
   the interactive API explorer at `api.driftstack.dev/docs` shows bare
   field-name/type schemas with no concrete request/response examples — a real
   developer-onboarding gap for a launching API. Adding them is safe + additive
   (use the OpenAPI MediaType `example` at the route `content` level — do NOT
   mutate the api-types zod schemas), but the values are a presentation judgment
   and some touch gated decisions (a profile/session example must pick an
   archetype → the pending iphone16pro-vs-iphone17 call; an api-key example picks
   scopes). **DONE (value-safe scope) — ~29 examples across all core flows, 11
   commits.** Every non-archetype flow now has copy-ready request+response examples
   in the Scalar explorer: auth (signup/login/verify/magic-link/password-reset),
   api-keys (create/list/rotate), webhooks (create/get/update/rotate-secret),
   agent-chat message, profile transfer, snapshots capture/restore, and the full
   browser-automation loop (navigate/interact/wait/capture request→response). All
   verified against the schemas; one-time secrets are clearly-fake low-entropy
   placeholders; MediaType `example` on route content only (api-types zod schemas
   untouched), type-safe + no parity break. **Still your call (held):** the
   archetype-bearing examples (profile/session/snapshot create requests +
   responses, which must pick an archetype → the iphone16pro-vs-iphone17 launch
   decision) and the MFA-branching login response. Say the word on the archetype
   and I'll add those too.

8. **Remaining doc stragglers** (intentionally left): `/v1/sessions/{id}/proxy`
   egress routes (founder-managed egress surface). The internal `/v1/admin/*`
   `404`s were completed (`94291438`); the validation-schedules `trigger` route
   verifiably does not 404 (fires a recapture for any archetype).

---

_All findings above are also captured in the agent's working memory; this file is
the founder-facing consolidation. Nothing here was auto-changed — each is a
decision, a feature, or a migration that belongs to the founder._
