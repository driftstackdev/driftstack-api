# 2026-06-02 — Resilience arc + founder-decision queue (Agent-2 autopilot)

**Scope:** Agent-2 (`driftstack-api`). Consolidates the recent autopilot waves'
shipped work and — more importantly — gathers the scattered **founder-decision /
gated items** into one actionable queue. Per-item depth lives in auto-memory; this
is the index + decision queue. Earlier-session fixes are in
`2026-06-01-overnight-autopilot-batch-report.md`.

## 1. Shipped this arc (all deployed to prod, gate-green, V-205-clean)

| SHA        | Change                                                       | Notes                                                                                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `438329c2` | Eager `MFA_ENCRYPTION_KEY` length validation at config-parse | Was a bare `z.string().optional()`; a wrong-length key boot-passed then 500'd the first MFA/BYOK/LiveKit/gui-control customer. Now fails the boot config-parse.                                                                                                                |
| (incident) | **Prod + staging `MFA_ENCRYPTION_KEY` was hex, not base64**  | The validation above immediately caught it on the staging deploy. Fixed both hosts via SSH (re-encoded the SAME 32 key-bytes hex→base64; backups at `/opt/driftstack/api/.env.bak.preb64`). No data loss (nothing was encryptable under the broken key).                       |
| `73ceb91e` | Corrected the stale env-file path in docs/comments           | `/etc/driftstack/api.env` → **`/opt/driftstack/api/.env`** (the real SSH-managed path) across runbooks, CLAUDE.md, customer `metrics.md`, source comments, scripts. Historical reports left as-is.                                                                             |
| `7433b5a2` | Bounded graceful shutdown                                    | `app.close()` was awaited unbounded; an active SSE stream (status/notifications/transcript) never ends → shutdown hung until systemd SIGKILL, **skipping `teardown()`** (lost Sentry flush, leaked DB/Redis). Now races a 10s deadline then always runs teardown + clean exit. |
| `7e63f6ff` | Opt-in DB `statement_timeout`                                | `DB_STATEMENT_TIMEOUT_MS` → per-connection `statement_timeout`. A runaway query could hold a pool slot (of 10) forever → pool exhaustion. OFF by default (inert); app-path only (migrations exempt).                                                                           |
| `747d382e` | R2 client request timeouts                                   | S3Client had no `requestHandler` → AWS SDK default has no socket timeout; a stuck background R2 op (recording/snapshot) could hang. Added `connectionTimeout 3s` + `requestTimeout 15s`.                                                                                       |

**External-dependency timeout map is now complete:** Postgres (pool + opt-in
statement_timeout + 30s connect default), Redis (maxRetries 3 + auto-reconnect +
boot fail-fast), R2 (connect 3s / request 15s + readiness 2s). Graceful shutdown
bounded; readiness `/ready` returns 503-on-dep-fail (sound).

**Also shipped (`c907bcba`):** `npm audit` patched two high-severity CVEs in the
Fastify-server runtime dep tree — `fast-uri 3.1.0→3.1.2` (path-traversal +
host-confusion) and `fast-xml-builder 1.1.5→1.2.0` (attribute/comment bypass,
@aws-sdk/R2). Lockfile-only, scoped to the server dep tree (no Astro-app
resolution change), gate-green. The remaining (breaking) audit advisories are
item 10 below.

**Also shipped (`fb205608`):** fixed the GUI release workflow (`gui-release.yml`, tag `gui-v*`)
which would build the Tauri bundles but FAIL to publish the GitHub Release — the `tauri-action`
step lacked `GITHUB_TOKEN` in its env (tauri-action reads `process.env.GITHUB_TOKEN`, which Actions
does not auto-export) AND the job had no `permissions: contents: write` (inherited the repo's
read-only default). Added both (least-privilege — only this job, only `gui-v*` tags). Standard
tauri-action release setup; latent until the first GUI release (ships with the canvas-gated launch),
so runtime validation is a `gui-v*` tag push. CI/CD-config fix (no prod-runtime change).

**Also shipped (`42a0f7bf`):** full programmatic logger↔Sentry secret-redaction-list lockstep
guard. The V-494 redaction is a hardcoded denylist in `lib/logger.ts::redact.paths` (29 fields)
that MUST be mirrored in `lib/sentry.ts::SENTRY_SENSITIVE_KEYS` (31 keys), but the existing
cross-source-invariant test only SPOT-CHECKED specific keys + the doc comments — blind to growth
(a new sensitive field added to one list but not the other would pass silently and leak that
secret to whichever observability sink was missed). Added a programmatic assertion that extracts
both lists (line-based, prettier-reflow-robust), normalizes each logger path to its bare key, and
asserts the set ⊆ `SENTRY_SENSITIVE_KEYS`. Verified teeth (a planted logger-only field fails);
passes current code. Test-only (no prod-runtime change); the redaction-list sync is now
gate-enforced rather than human-discipline + spot-check.

**Also shipped (`e47f7e00`, deployed + live — prod `/version`=`e47f7e0`):** Stripe INBOUND
webhook signature verifier (`lib/stripe-signing.ts`) now accepts ANY `v1=` from the
`Stripe-Signature` header instead of only the last. Stripe dual-signs during a webhook-secret
roll (old+new secret → two `v1=` entries); the old last-only behavior rejected a legitimate
delivery mid-roll when the matching signature wasn't listed last (fail-closed, but dropped until
config caught up + Stripe retried). `parseHeader` now collects every non-empty `v1` (`string[]`);
verify accepts if ANY matches the HMAC over `<t>.<rawBody>`, constant-time per candidate.
Security-neutral (each candidate must independently match a real HMAC — bogus entries gain nothing
without the secret) and aligns inbound with Stripe's official SDK + our own outbound verifier.
+4 reference-vector tests (both orderings accept, none-match rejects, empty-v1 → missing_v1); BOTH
stripe-signing parity files updated same commit (the full pre-push gate caught the second one).

**Also shipped — 2026-06-03 waves (admin-panel statistics buildout + fresh-audit fixes; all deployed, gate-green, V-205-clean):**

- **Admin-panel stats (founder's "statistics" mandate):** `admin-client.ts` shared data layer (`43203bd4`);
  `/v1/admin/overview` enriched with `accounts.by_tier` (`be726888`) + `accounts.signups` today/7d/30d
  (`2da8b9d0`); new `/v1/admin/sessions/stats` count-by-status endpoint (`2fa03e86`). Dashboard now renders
  all of it: tier-distribution bars (`2f0a2812`), New-signups tile (`d31d75a4`), Live-sessions tile
  (`21947429`) — each real-data-wired with JSDOM no-blind-ship validation + content-parity.
- **Fresh-audit fixes:** crypto daily-breakdown UTC-window misalignment (`b70366ea`); incident-create
  audit row logged the real `inc_<uuid>` not `inc_pending` (`9a3eff6a`); audit-archive `archiveAll`
  per-table failure isolation (`ef552795`); validation-schedule trigger body now zod-validated, not an
  `as`-cast (`94ef5a89`); two stale/misleading security-code headers corrected (crypto-orders `5e315eb7`,
  nowpayments-signing `1f1425cd`).
- **Audit-saturation reached:** the last several waves yield increasingly LATENT findings (see §2-18/19) —
  the safe non-gated server surface is comprehensively mined. Highest-leverage remaining = the
  founder-collaborative admin-panel VISUAL REDESIGN (`2026-06-02-admin-panel-redesign-plan.md`).

**§2 FOUNDER-DECISION QUEUE — TOP-3 + DRIZZLE ROOT-CAUSE CLEARED (founder approved "do everything", 2026-06-02):**
the recommended priority queue is shipped + live. `8e4d810d` MFA regen step-up gate (§2-15);
`f93c509a`+`e6ac9f1c` profile-count TOCTOU atomic `insertWithLimit` across all 4 creation paths
(§2-14); `DB_STATEMENT_TIMEOUT_MS=30000` set on staging+prod (§2-2, ops); `3fbd2f97` version-agnostic
`err.cause` 23505-translation helper (§2-17 root-cause) → **#17 drizzle 0.38→0.45.2 MERGED `6eeb3fc4`**,
deployed + prod-smoke + full-CI-on-0.45 validated. Only the genuinely-gated items remain (agent_sessions
strict-FK = needs FK-behavior + orphan-row spec; iphone17 = needs Agent-1 canvas-readiness) + the
lower-priority dependabot PRs (founder cadence). See the §2 header below.

## 2. FOUNDER-DECISION QUEUE (gated — Agent-2 cannot safely self-do these)

> **STATUS 2026-06-02 — founder approved "do everything"; the recommended top-3 + the drizzle root-cause are ALL SHIPPED, LIVE, and CI/prod-validated:**
>
> 1. ✅ **Item 15 — MFA recovery-code regen step-up bypass** — SHIPPED `8e4d810d` (added `requireMfaFresh()` to the regen route, closing the mint-codes→satisfy-step-up→disable bypass; existing recovery codes still satisfy step-up; live).
> 2. ✅ **Item 14 — profile-count quota TOCTOU** — SHIPPED `f93c509a` + `e6ac9f1c` (atomic `insertWithLimit` FOR UPDATE account-row lock across ALL 4 creation paths — create/clone/import/transfer; real-PG concurrency-tested; live).
> 3. ✅ **Item 2 — `DB_STATEMENT_TIMEOUT_MS=30000`** — SET on staging + prod (ops; restart-verified; runaway-query pool-exhaustion gap closed; live).
>
> - ✅ **Item 10 / #17 — drizzle-0.45 bump** — the `err.cause` 23505-translation root-cause FIXED (`3fbd2f97`, version-agnostic `lib/pg-error.ts` helper across all 4 unique-violation sites) → #17 MERGED `6eeb3fc4`, deployed, prod-smoke + full-CI-on-0.45 validated (incl the slug-409 E2E that was the original break).
>
> **REMAINING — genuinely need founder input / a spec (NOT auto-doable):**
>
> - **agent_sessions strict-FK (item 7)** — need the FK behavior (cascade / restrict / set-null) + how to handle existing orphan rows. Breaking migration.
> - **iphone17 cutover (item 8)** — need Agent-1 to confirm canvas/atlas readiness (else rendering breaks).
> - Lower-priority/infra: deploy approval-gate/CI-gating (11-12), CORS/trustProxy (5-6, LOCKED), CF-skip (13), and the remaining dependabot PRs (#15/#16 dev-tooling, #14 cargo, #1/#2/#3 CI-actions, #6/#7 framework majors) — founder cadence. Full per-item detail below.

1. **`DEPLOY_DOTENV_BASE64` GH Actions secret likely still holds the HEX `MFA_ENCRYPTION_KEY`.**
   Used only by the abandoned `server-deploy.yml` (the active path is `deploy.yml`, which
   leaves `.env` SSH-managed). If `server-deploy.yml` is ever run it would reintroduce the
   hex key. **Action:** update the secret to the base64 form, or retire `server-deploy.yml`.
   (Agent can't read/write a key-bearing secret safely.)
2. **Enable `DB_STATEMENT_TIMEOUT_MS` in prod** (suggest ~`30000`) — the capability shipped
   (`7e63f6ff`) but is inert until set; it caps every app query, so enabling/value is an ops
   judgement. _Status 2026-06-02 (SSH-verified): still NOT set in prod_ → the pool (postgres-js
   `max: 10`/instance) has no runaway-query guard, so a stuck/slow query (lock wait, slow Neon)
   holds a connection until it completes; under load several such could exhaust the 10-conn pool.
   _Query-profile glance (the homework this item asked for): all app-path queries are bounded —
   keyset pagination, Zod-validated `limit` caps (≤100/200/1000), no unbounded scans — and
   migrations run via the separate `{ max: 1 }` client that is NOT subject to this timeout (long
   DDL stays safe). So a generous `~30000` (30s) would cap only pathological/stuck queries, never
   a legitimate one → low-risk to enable. Action = set the env var on prod + staging `.env` +
   restart (read at boot)._
3. **Rate-limit Redis-down posture.** `middleware/rate-limit.ts` propagates a store error →
   **500 on every authed request** during a sustained Redis outage (auth-cache degrades
   gracefully; rate-limit doesn't). Decide: fail-open (availability, but disables limiting →
   abuse/cost exposure on an LLM-backed API) vs clean fail-closed 503 vs status-quo. Not a
   security hole today (it fails closed-as-500), so left for a posture call.
4. **Fastify `requestTimeout`** — none set (Cloudflare's ~100s edge fronts the origin;
   `connect_timeout` already bounded). Decide if an origin-level request bound is wanted.
5. **trustProxy / `req.ip=127.0.0.1` in prod** → rate-limit keys collapse to one global
   bucket. LOCKED-XFF per planning 133; founder call. (See auto-memory `trustproxy_ip_resolution_gap`.)
6. **`PERMISSIVE_CORS=true` in prod** — echoes any Origin + credentials. Boot-warn shipped;
   full fix is a founder call.
7. **`agent_sessions` strict-FK** — a breaking (non-clean) migration; founder design decision.
8. **iphone17 archetype cutover** — canvas-gated launch (`LOCKED_ARCHETYPE_ID` flip + driver
   mock→real). Staged + one-green-commit-ready on the founder's go-signal (Agent-1 canvas).
9. **(LOW) webhook backoff 3-copy consolidation** — `BACKOFF_MS_BY_ATTEMPT` is defined 3×
   (byte-identical values; only a dead/unreachable fallback diverges). Pure-DRY cleanup; not
   a bug — left to avoid churn on the audited webhook subsystem.
10. **Breaking dependency-vuln bumps (`npm audit fix --force`)** — three advisories need
    breaking bumps that a root-lockfile edit can't safely gate-validate, so they're a separate
    founder-reviewed change: `drizzle-orm@0.45.2` (SQLi via `sql.identifier` — **NOT exploitable
    here**: the codebase has zero `sql.identifier`/`sql.raw` usage, drift-guarded → low urgency
    despite the HIGH rating; **BUT NOT a clean bump — see §17: 0.45's `DrizzleQueryError` wrapping
    moves the PG `code`/`constraint_name` to `err.cause`, breaking every top-level 23505-error
    translation [slug/profile-name-race/idempotency/signup] → needs a coordinated err.cause migration;
    PR #17 is this bump + fails the slug-409 E2E because of it**); `undici` (HTTP-client: decompression-DoS / WebSocket-overflow /
    request-smuggling / CRLF); `@astrojs/cloudflare` image-transform SSRF (Astro adapter). The
    two non-breaking server-runtime highs were already fixed (§1 `c907bcba`). Dev/build-tooling
    advisories (Astro `check`/`language-server`, incl. the full-tree "2 critical") never ship to
    prod; customer-shipped Astro deps (`astro`/`devalue`, in-range) are left to dependabot / their
    own astro-build-validated path rather than a root-lockfile edit the server gate can't validate.
11. **Production deploys have NO human approval gate** (found 2026-06-02). `deploy.yml` is Option B
    (LIVE): every push to `main` auto-runs `deploy-bridge.sh staging` → `deploy-bridge.sh prod`
    back-to-back. The `deploy-production` job comment claims the `production` GitHub environment
    "requires approval from the founder," but `gh api .../environments` shows `protection_rules=NONE`
    on every environment, and the `2c2375f` prod job ran in 53s with no approval wait. So any commit
    to main (including autopilot docs/chore commits) ships straight to prod; the only safety net is
    `deploy-bridge`'s post-deploy-verify (14 invariants) + auto-revert (robust). **Founder decisions
    (need repo-admin + policy — Agent-2 can't self-do):** (a) configure `required_reviewers` on the
    `production` environment if a human gate is wanted, OR amend the comment to reflect intentional
    auto-deploy; (b) optional `paths-ignore: [docs/**, '**/*.md']` on the `push` trigger so docs/chore
    commits don't gratuitously rebuild+restart prod — but a wrong filter UNDER-deploys (silent
    staleness, the exact failure the "gate FAILS loudly" guards were added to prevent), so it's a
    deliberate founder change, not an autopilot edit. Also note: staging→prod runs with ZERO soak
    (V-507 60-min staging soak is not enforced in CI).
12. **Prod deploy is NOT gated on CI passing** (found 2026-06-02, compounds item 11). `ci.yml`
    (test suite) and `deploy.yml` both trigger independently on `push: [main]`; deploy.yml's
    `needs:` only chain its own jobs (source-map-upload → staging → prod) — there is no
    `workflow_run` trigger or cross-workflow status gate, so the two run **in parallel**. Worse,
    deploy.yml's build job runs `npm ci` + build only (no test step), so **tests never gate the
    deploy**. What DOES protect prod: (1) the local pre-push hook (full vitest + tsc — the primary
    gate, strong, but bypassable via `git push --no-verify` and it cannot run the CI-only real-PG
    `*-drizzle` tests); (2) build/tsc failure blocks the deploy (source-map-upload fails →
    deploy-staging skipped); (3) post-deploy-verify's 14 HTTP invariants + auto-revert. The narrow
    exposure: a regression caught ONLY by CI-exclusive real-PG tests (not the local hook, not the
    HTTP invariants) ships to prod ungated. **Founder/ops decision (NOT an autopilot edit — a wrong
    `workflow_run` restructure could halt all deploys or create races):** gate `deploy.yml` on CI
    success via a `workflow_run: {workflows: [CI], types: [completed]}` trigger with a
    `conclusion == 'success'` job-condition, OR add a test job to deploy.yml's chain, OR rely on
    branch-protection required-checks (note: direct `HEAD:main` pushes bypass PR-merge checks). Today
    the local hook is the real gate; this is a defense-in-depth gap, not an active hole.
13. **CF-Pages site deploys silent-skip on a missing CF token** (found 2026-06-02; compounds 11-12).
    All 5 site-deploy workflows (`deploy-{customer-dashboard,marketing,docs,status-site,admin-panel}.yml`)
    gate their wrangler upload with `if [ -z "$CLOUDFLARE_API_TOKEN" ]; then echo …; exit 0; fi` — a
    SILENT-SKIP, the exact masking-pattern `deploy.yml`'s Hetzner gate was deliberately fixed away from
    (2026-05-20, after a silent-skip let main go ~10h un-deployed while CI reported success). So if
    `CLOUDFLARE_API_TOKEN` is unset/rotated-wrong/expired, all 5 customer-facing sites silently stop
    deploying — CI green, stale sites, no operator signal. **Founder/ops fix (low-risk consistency
    change): mirror deploy.yml — change the CF-token `exit 0` → `::error` + `exit 1` in all 5 (inert
    when the token is set; fail-loud only on token-loss; same fresh-repo-CI tradeoff deploy.yml took).
    OR confirm the CF-Pages silent-skip is intentionally different.** The PROJECT_NAME check in each
    already fails-loud; only the token check silent-skips. (A deploy-pipeline-hardening batch with 11-12.)
14. **Count-then-insert quota-bypass TOCTOU — two instances, same class** (profile-count found
    2026-06-02). A per-tier resource limit enforced as `count(account) >= limit ? throw : insert(…)`
    with the count and the insert as **separate awaits (no transaction / row lock)** lets N concurrent
    creates all read the same sub-limit count, all pass, and all insert → the cap is exceeded. - **Session-create concurrency limit** (`services/sessions.ts` create) — surfaced 2026-05-30.
    Lower impact: bounded, billed per session-minute, auto-destroyed (free 20-min cap) → the
    over-limit is transient. - **Profile-count quota** (`services/profiles.ts` create L134 + duplicate L273 + import L366 +
    transfer L493 + `profile-snapshots.ts` restore L157 — all 6 do `countByAccount >=
profileLimitFor(tier)` then a separate `insert`) — **found 2026-06-02. More monetization-relevant
    than the session case: profiles PERSIST** (not auto-destroyed), so a free-tier user (limit=1)
    firing concurrent distinct-name creates keeps the extra profiles indefinitely. (`countByAccount`
    is correctly account-scoped; the profiles **name-uniqueness** race is separately CLOSED — this is
    the **count** race, a distinct bug. The name-race unique-index does NOT bound count: two
    different-named concurrent creates both pass.)
    **Why founder-gated / not auto-fixed:** the correct fix is atomicity — wrap count+insert in
    `db.transaction()` + `SELECT … FOR UPDATE` on the account (the PROVEN pattern from the
    debitTokens/appendTranscript fix `e9c78962`), or an `insertIfUnderLimit` in the repo. That is a
    behavioural change to the core create path (contention/deadlock risk) across 6 call sites, and
    needs a CI-only real-PG concurrency test (the local gate can't exercise it) — a focused change,
    not an autopilot edit. **Decision:** (a) accept the over-limit as a cost-model trade-off (as the
    session case has been), or (b) prioritise the atomic guard — **recommended for the PROFILE case**
    given the persistent free-tier monetization leak. Low severity, deliberate-concurrency-abuse only;
    not a security hole (no data exposure / priv-esc).
15. **MFA recovery-code regeneration is NOT step-up gated — defeats the disable step-up gate**
    (found 2026-06-02; **MEDIUM-HIGH**). `DELETE /v1/account/mfa` + `POST /v1/account/mfa/disable` are
    `requireMfaFresh()`-gated (V-353a Q3: account-delete + MFA-disable are "the two step-up-gated ops").
    But `POST /v1/account/mfa/recovery-codes/regenerate` (account-mfa.ts:128) is just
    `[requireAuth, requireScope('account_owner'), rateLimit]` — **no `requireMfaFresh()`** — and it MINTS
    10 fresh recovery codes (returned in the response), which ARE a valid second factor: `stepUpReauth`
    (auth-flows.ts:893) accepts `via:'recovery'` and calls `markWebSessionMfaSatisfied`. **Confirmed
    bypass chain:** a STOLEN SESSION (past first factor, no TOTP device) → POST regenerate (ungated) →
    10 recovery codes → POST `/v1/auth/mfa/step-up` with a recovery code → session marked mfa-fresh →
    DELETE `/v1/account/mfa` (gate now satisfied) → MFA disabled / account takeover. So the V-353e
    step-up protection on disable — whose whole purpose is to contain a stolen session — is fully
    defeated by the ungated regen endpoint. **Founder decision (security vs recovery-UX; touches the
    V-353a "two ops" verdict, so not an autopilot edit):** (a) add `app.requireMfaFresh()` to the regen
    route (one line; makes regen consistent with disable; closes the chain) — but this removes the
    self-service "lost TOTP device but still logged in → mint new codes" recovery path, which must then
    route to support / identity-verification; OR (b) accept it as the intended self-service recovery
    path + the stolen-session risk. **Recommended: (a)** — an endpoint that mints a step-up-satisfying
    factor without itself requiring step-up is a strictly weaker posture than the disable gate it
    undermines; the "lost device AND codes but still logged in" recovery is better served by a support
    identity-check than by a control-bypassing self-service endpoint. (Requires session theft first, but
    nullifies a control built specifically for that threat → MEDIUM-HIGH, not low.)
16. **Retention-ENFORCEMENT sweepers to build before first paying customer** (LAUNCH/forward item, NOT
    a current bug — surfaced into this queue 2026-06-02; the underlying doc↔reality assessment was already
    done in auto-memory `project_data_lifecycle_findings`: the DPA §11 / Privacy §9 retention claims are
    **CONSISTENT + correctly caveated** [legal docs are "baseline drafts under counsel review; first paying
    customer onboards only after review"], so there is **no false-promise breach today**). The gap is purely
    that the _enforcing_ purge sweepers don't exist yet — the only purge jobs are `auth_tokens.sweep`, the
    status-subscriber 90d email-tombstone, and secret-prev/rotation-reminder jobs; `sessions.duration_sweep`
    marks a session `destroyed` but does NOT delete the record. So, to build alongside launch:
    - **Session metadata "90 days operational"** — no 90d session-record purge/aggregation exists; build it
      before real customer data ages past 90d (pre-launch there is no aged data yet → not urgent, but it's
      the one over data that's already produced).
    - **Session Recordings (1–365d, default 30)** — recordings are unwired today (no recordings table/
      write-call; `R2_BUCKET_RECORDINGS` + upload helper exist, mock driver produces none); ship the
      retention-purge WITH the real-driver recording capture (same fix-at-wiring note as recipe-library).
    - **Customer-Provided Secrets ≤30d post account-termination** — no customer account-termination/delete
      flow exists yet (accounts suspend); wire the 30d secret-purge WITH the roadmapped Art-17 self-service
      deletion (which also needs cross-store erasure: R2 + Stripe customer + Sentry PII, per the data-lifecycle
      forward-note). **Founder/data-lifecycle, NOT an autopilot build** (per-data-class sweepers + retention-
      config + migrations). Net: docs are sound + caveated; this is the enforcement-to-build-at-launch list,
      not a present compliance breach.
17. **Dependabot PR pipeline** — _[PARTIAL-RESOLVED 2026-06-03: #17 (drizzle-0.45 + the err.cause migration) + #15 MERGED, 3 stale closed → **6 PRs remain** (#16 concurrently, #14 cargo, #7 react MAJOR, #6 astro 5→6 MAJOR, #3+#1 docker-actions). The drizzle root-cause below is DONE (verified live, no 23505→500 regression) — see the §2 STATUS block. Remaining = the 2 framework majors (#6/#7, founder review) + the docker pair (close-with-item-1). Diagnosis history retained below.]_ Originally **STALLED — all 9 open PRs had failing CI** (found 2026-06-02; MEDIUM
    maintenance/security-hygiene). `gh pr list` showed 9 open dependabot PRs, EVERY one with a red check,
    several a month old (since 2026-05-04) → dependency updates aren't landing, so deps accumulate
    unpatched (the auto-merge is actor-gated + patch-ONLY, and these are minor/major groups → never
    auto-merge; red CI blocks manual merge too). **Agent-2 cannot safely self-do this** — merging a
    dep/lockfile bump can't be gate-validated by a root-lockfile edit (item 10's reasoning), it triggers
    a prod deploy, and the real E2E break below needs a focused fix. **Triage (diagnosed this wave):** - **#17 runtime-deps-minor (5 pkgs: drizzle-orm 0.38→0.45.2, @aws-sdk/client-s3 + s3-presigner
    3.1041→3.1058, @scalar/fastify-api-reference 1.55→1.58, ioredis 5.10→5.11)** — DIAGNOSED this wave:
    the gating E2E failure is `account-me.spec.ts:93 › PATCH /v1/account/me 409 on slug collision`
    (got 500, expected 409). **Root cause = the drizzle-orm 0.45 bump** (the other 4 are benign minors):
    0.45 wraps query errors in `DrizzleQueryError`, moving the Postgres `code`/`constraint_name` to
    `err.cause` — but the codebase's 23505-translation reads them TOP-LEVEL (`auth-repo.ts:150-152`
    slug→`SLUG_TAKEN`; `profiles.ts:86 isProfileNameRaceViolation`; + idempotency-replay + signup
    email-unique) → the catch misses → 23505 propagates → 500 instead of the clean 409/replay. So
    drizzle-0.45 breaks the ENTIRE 23505-error-translation family (slug caught it via E2E; the others —
    profile-name-race ×6, agent-session idempotency, signup — aren't all E2E-tested but break the same
    way). **This is ALSO item-10's drizzle-0.45 security bump** → item-10's "low urgency" is right on
    SECURITY but understates the UPGRADE EFFORT: it's a coupled dep+code change (update every 23505-catch
    to read `err.cause.{code,constraint_name}`), founder-reviewed, can't ship the err.cause migration
    alone (would break current 0.38). Founder option: split #17 to merge the 4 benign minors (aws-sdk×2 +
    scalar + ioredis) now, handle drizzle-0.45 + the err.cause migration as a coordinated change. - **#6 astro 5→6 / #7 react(+@types)** — customer-shipped MAJORs → founder/astro-build-validated path
    (same class as item 10's astro note); month-old + stale. **#6 DIAGNOSED 2026-06-03 (coupled major,
    like #17/drizzle):** red because it bumps `astro` alone while `@astrojs/cloudflare ^12.6.13` (the
    astro-**5** adapter major, used by admin-panel + customer-dashboard) is left mismatched → build WARNs
    `"default" not exported by @astrojs/cloudflare/.../server.js` + `entrypointResolution:"explicit"
deprecated` → build/check fail. To LAND: ONE PR bumping `astro ^6` + `@astrojs/cloudflare ^13`
    together + migrating `entrypointResolution:"explicit"→"auto"` in the 2 astro.config.mjs (docs/
    marketing/status are static → unaffected). #7 likely the same coupled-major shape. Detail:
    [[project_dependabot_astro6_react_coupled_majors]]. - **#16 concurrently 9→10 / #15 dev-deps-minor-patch (8) / #14 cargo-minor-patch (3, gui Rust)** —
    dev/build-tooling; lower risk; their lone failures may be the non-gating perf job or stale-base. - **#1 docker/build-push 6→7 / #3 docker/login 3→4** — CI-config; the docker-\* actions are used by the
    ABANDONED `server-deploy.yml` (item 1) → likely CLOSE-or-retire-with-that-workflow, not bump.
    **#2 setup-node 4→6** — active CI; its build-test failure is likely stale-base (month-old) → rebase.
    **Action:** founder triage — rebase the month-old stale ones, fix/assess the #17 E2E break, decide the
    customer MAJORs (astro/react), and either close the docker-action PRs with server-deploy.yml or merge
    after rebase. The non-gating perf-job red is benign noise (item 9 / advisory). Distinct from item 10
    (3 specific npm-audit advisories) — this is the broader stalled-PR-pipeline signal.
18. **LiveKit token-route divergence (found 2026-06-03; LATENT — both routes gated on `config.livekit`,
    unset in prod → NOT live).** Two access-token mint routes embody inconsistent designs. The newer
    canonical `routes/agent-sessions-livekit-token.ts` (LK.3) is **subscriber-only** (`canPublish:false`;
    the Mac-side capture is the publisher, provisioned out-of-band) with a **per-participant identity**
    (`customer-<account-id>`, "so the SFU can dedupe joins"). The older `routes/sessions-livekit-token.ts`
    (V-531.B) **diverges**: (a) it's customer-facing yet lets the body pick `role:'publisher'` →
    `canPublish:true` (over-grant — self-scoped to the caller's own room, no cross-account exposure, but
    unnecessary), and (b) it mints every participant with `identity:sessionId` → LiveKit disconnects
    duplicate identities, so the capture-publisher + customer-subscriber kick each other out (the
    documented live-preview wouldn't work under this scheme). Both routes are otherwise sound (auth +
    rate-limit + ownership 404 anti-enum). **Founder/LiveKit-wirer decision (NOT autopilot — realtime-infra
    route-canonicality + identity scheme):** before keying `config.livekit`, align V-531.B to the canonical
    pattern (subscriber-only + per-participant identity) OR deprecate it if `/v1/agent-sessions` supersedes
    `/v1/sessions` for LiveKit. Detail: `2026-06-03-livekit-token-route-divergence.md`. No current prod impact.
19. **Two LATENT findings from the 2026-06-03 sweep (documented; not auto-changed).** (a) **Duration-sweep
    `minCapFor`** records the smallest cap across capped tiers for every candidate's destroy-event payload —
    correct today (only `free` is capped → always 20), wrong once a 2nd tier gains a cap (needs the
    candidate's tier carried on the row). (b) **Self-re-arm fan-out under poller retry** — the self-re-arming
    jobs re-arm `dedup:false` inside the handler before `markComplete`; the "one run → one enqueue, can't
    fan out" reasoning omits retries (if `markComplete` throws after the re-arm, the retried handler
    re-arms a 2nd time → duplicate chains that never collapse). Rare trigger, low blast radius, but affects
    ALL self-re-arming jobs; the robust fix (dedup excluding the in-flight job id + `dedup:true`) touches
    the prior-incident dedup logic → deliberate review. Detail: `2026-06-03-duration-sweep-and-rearm-audit.md`.
    Also (c) **audit-archive R2 partitioning** keys by the oldest archivable row's month, so a multi-month
    window lands in one mislabelled file — recoverable via the `audit_archive_runs` ledger; true monthly
    partitioning is a separate change (`project_audit_archive_isolation_fix` memory). All latent / low-priority.
20. **CI coverage step duration exceeds the autopilot wave cadence (ops finding).** The CI "Test (unit +
    integration) with coverage thresholds" job runs the full ~22k-test suite single-threaded under coverage
    instrumentation — observed ~20-30 min wall — while the autopilot wave cadence is ~12 min. `ci.yml` has
    `concurrency: cancel-in-progress: true` with NO `paths` filter, so each new push to `main` cancels the
    prior commit's still-running CI → in back-to-back waves, commits chronically cancel each other's CI and
    few get a complete green run. NOT a correctness risk: the husky **pre-push gate runs the identical full
    suite green before every push** (authoritative validation) and `deploy.yml` is `cancel-in-progress:false`
    (deploys queue, prod stays correct — e.g. `743fb484` deployed clean while its CI was still running).
    **Founder/ops decision (NOT autopilot — CI quality-gate config):** options are (a) move coverage to a
    separate non-blocking workflow or nightly, (b) shard/parallelize the coverage run, (c) add a `paths`
    filter so docs-only commits skip CI, or (d) accept the pre-push gate as the gate and treat CI as
    best-effort. Surfaced for visibility; the pre-push gate keeps `main` safe regardless.
21. **`errors.driftstack.dev` is NXDOMAIN — provision it (founder/infra; like the status-site DNS).** The
    API emits RFC-7807 `type: https://errors.driftstack.dev/<slug>` in EVERY error response (hardcoded
    `middleware/error-handler.ts`: not-found/unauthorized/forbidden/bad-request; + egress-tunnel-unreachable),
    and that namespace is the documented error contract — referenced across 15 docs + 7 SDK + 30 test files.
    But `errors.driftstack.dev` doesn't resolve (`nslookup` → NXDOMAIN; curl 000), so every error's `type`
    is a dead link. NOT a code bug (the URIs are intentional + contract-pinned; RFC-7807 `type` is primarily
    an identifier so the API is functionally fine) — a DX gap (developers following the link get NXDOMAIN).
    **Founder/infra (NOT autopilot — DNS + outward-facing; agent wrangler is zone:read-only):** provision
    `errors.driftstack.dev` (DNS + a static error-docs site, one page per slug, OR a redirect to
    `docs.driftstack.dev/errors/<slug>`). Mirrors the [[project_status_site_cloudflare_setup]] "done except
    the DNS CNAME (founder)" pattern. Do NOT repoint the type URIs — that's a 52-file contract break + the
    namespace is the right one; just make it resolve. Detail: [[project_errors_domain_nxdomain]].
22. **Metrics/observability layer is INERT in prod — enable before launch (founder/ops).** Prod
    `GET /metrics` → app 404 "No route" (NOT nginx/401/503), which means `METRICS_SCRAPE_TOKEN` is UNSET:
    `app.ts:906` registers `/metrics` only `if (metricsRegistry !== undefined)`, and `bootstrap.ts:289`
    creates the registry only when `metricsScrapeToken` is set. So the registry is never created → EVERY
    `metrics?.inc(...)` across the obs.3-16 instrumentation (http_request/auth/rate_limit/email/webhook/
    stripe/nowpayments/audit-emit/livekit/agent-decompose/byok counters) is a silent no-op + no /metrics
    endpoint → Grafana/VictoriaMetrics collects nothing. Likely INTENTIONAL pre-launch (prod `/version`
    `driver:"mock"`, no real traffic; `routes/metrics.ts` says the deploy bridge sets the token at the real
    deploy). **Launch-prep (founder/ops decision; NOT autopilot — needs scraper coordination):** before
    launch, set `METRICS_SCRAPE_TOKEN` (≥16 chars) in prod `.env` AND wire the Prometheus/VictoriaMetrics
    scraper to `https://api.driftstack.dev/metrics` (Bearer token), else all the obs work + dashboards stay
    blind. (otel.ts is also unwired — same observability-deferred theme.) Detail: [[project_metrics_layer_inert_in_prod]].

## 3. Audit-saturation map (comprehensively swept — don't re-sweep without a concrete reason)

- **Resilience:** dependency timeouts (§1), bounded shutdown, readiness probe — done.
- **Webhooks:** delivery, durable cursor keyset, orphaned-in-flight reclaim, HMAC signing,
  SSRF, retry-backoff (consistent), endpoint auto-disable (consecutive, reset-on-success) — sound.
- **Security classes:** IDOR/ownership, injection (SQLi/CSV/PDF/ReDoS), sensitive-data-in-logs
  (CWE-532, V-494 redact + Sentry mirror drift-guarded), crypto-at-rest (AES-256-GCM family),
  OAuth/PKCE/MFA/auth-token, CI/GitHub-Actions, CF-Pages security headers, config/env validation — clean.
- **SDKs** (TS/Go/Python) swept; AI subsystem, status surface, billing (Stripe + crypto IPN) audited.
  _Customer Stripe checkout/portal routes (`routes/billing.ts`) verified clean 2026-06-03:_ V-248
  origin-allowlist open-redirect guard on customer `success_url`/`cancel_url` (hardcoded by design,
  malformed→reject), **server-side** tier→price (no client price = no tampering, like the crypto
  checkout), account-bound (`ctx.account.id`, no IDOR), `admin:billing` scope satisfied by
  `account_owner`, unauthed-503 stub when Stripe unconfigured. Don't re-audit.
- **Dormant / not Agent-2 deep-audit targets:** crypto rail (501 stubs), session-egress
  (`session-proxy`, EG-API-1.6 pending), behavioural-simulation (complete + unwired), customer
  dashboard (static SPA, client-side bearer — no SSR layer).
- **DB schema design (fresh dimensions, 2026-06-02) — all SOUND, don't re-check:** index
  coverage (88 indexes; composite on high-volume read paths — usage/session-events/sessions),
  FK / referential-integrity (48 `.references()` → `accounts.id` `onDelete: cascade` for owned
  children + `set null` for optional refs; no orphan-row risk), and timestamp column types
  (all 127 `timestamp()` columns are `withTimezone: true` → `timestamptz`; zero naive timestamps
  → no tz-ambiguity bug class). The only open schema item is the founder-gated `agent_sessions`
  strict-FK (§2 item 7).
- **Outbound-fetch timeouts (2026-06-02) — VERIFIED comprehensively bounded:** all outbound API
  clients wrap fetch with the AbortController-deadline pattern (armed `setTimeout(abort)` + `signal`
  - `clearTimeout` in `finally`). `oauth-client-exchange.ts` was the lone gap (login-path IDP calls
    via bare `globalThis.fetch`) — FIXED `8c818719` (live + post-deploy-verified). The other 7
    (stripe-api/nowpayments-api/agent-planning/webhooks/incident-broadcast/health-probe) were already
    correct (2 deep-read, 5 primitive-confirmed). Don't re-sweep.
- **Ingress request limits (2026-06-02) — SOUND, no body-DoS hole:** `bodyLimit` uses Fastify's
  1 MiB default globally + 2 _bounded_ overrides (avatar `/v1/account/me/avatar` 3.5 MiB with
  413-before-handler + MIME/size validation; `_webhook-raw-body` `MAX_BODY_BYTES`) — no unbounded
  override anywhere. `genReqId` caps inbound `x-request-id` at 128 chars. The only unset ingress
  knobs are `requestTimeout` (§2 item 4) and `trustProxy` (§2 item 5, LOCKED) — already queued;
  `keepAliveTimeout` uses the safe Fastify 72s default. Don't re-check.
- **Runtime / behavioral dimensions (fresh, 2026-06-02) — all SOUND, don't re-check:**
  - _Process error handling + crash observability:_ Sentry default integrations capture
    `uncaughtException` + `unhandledRejection` (never disabled), Fastify `onError`→Sentry with
    request context, `teardown()` flushes Sentry on every shutdown path — let-it-crash + fully observable.
  - _HTTP verb-safety:_ all mutations are POST/PUT/PATCH/DELETE; the only side-effecting GET is the
    deliberate billing-portal 302-redirect; zero destructive-GET handlers.
  - _SSE connection-lifecycle:_ all 3 SSE routes clear the heartbeat interval + unsubscribe on both
    `'close'` and `'error'` — no per-disconnect leak.
  - _Process background timers:_ 10 in-process pollers, 10/10 `setInterval`/`clearInterval` (all
    cleared on teardown), all `.unref()`'d, each tick try/catch-guarded, overlap-safe by claim
    semantics, teardown stops pollers first.
  - _Rate-limit policy:_ 4 buckets — `'global'` + 3 dedicated stricter buckets for the expensive
    LLM/session ops (`sessions:create`, `agent_sessions:message`/`input_event`); tier-based values.
  - _Money-precision:_ all money is integer cents in storage + arithmetic; floats only for display
    formatting + an immaterial alert-threshold heuristic; no charged-amount float math.
  - _Email-normalization:_ `createAccount` + `findAccountByEmail` lowercase (content-parity-pinned);
    OAuth collision lookup is case-insensitive → no anti-takeover bypass, no case-variant dup accounts.
  - _GDPR / erasure / retention doc-vs-reality:_ legal docs (privacy/DPA §9) are precise + consistent
    with the suspend→retention→archive lifecycle; Art-17 self-service deletion correctly roadmapped.
- **Security / supply-chain / SDK / desktop-app dimensions (fresh, 2026-06-02 batch 2) — all SOUND, don't re-check:**
  - _Token / cookie security:_ tokens are hand-rolled fixed-HMAC (NO JWT lib → structurally immune to
    alg-confusion/`none`-alg); OAuth state token + PKCE cookie verify-before-decode + timing-safe + TTL;
    the only cookie (PKCE) is `HttpOnly; Secure; SameSite=Lax`, Path-scoped; web-session is bearer (no cookie).
  - _Mass-assignment / field-level privesc:_ customer-write schemas whitelist non-privileged fields only
    (no tier/status/role/accountId); Zod strips unknown keys; routes use `parsed.data` not raw body; owner
    accountId from auth-context. No over-posting privesc.
  - _Webhook replay:_ Stripe 5-min timestamp tolerance (abs-window) + idempotency; NowPayments timestamp-less
    → idempotent state-machine; outbound webhooks timestamp-signed.
  - _Secret-leak vectors:_ zero committed secrets (repo content + filenames; `.env` gitignored; prod `.env`
    SSH-managed) AND zero secrets in the Astro client bundle (only `PUBLIC_*` URLs inlined).
  - _Supply-chain:_ dependency-confusion structurally prevented (all `@driftstack/*` workspace-local; lockfile
    resolves them as local links, zero registry-resolved → `npm ci` never fetches them publicly).
  - _SDK client-side:_ full-jitter exponential backoff (no retry-storm), bounded retries, correct eligibility,
    no insecure-TLS option; pagination yields-before-terminate (no drop-last / non-termination).
  - _Desktop-app (Tauri/macOS):_ capabilities least-privilege (no `shell:execute`; `shell:allow-open` + `fs`
    both scoped); updater ed25519 **signature-verified** (trusted GitHub endpoint, fail-closed); macOS
    entitlements minimal (WebKit-JIT pair only, none of the dangerous ones).
  - _Codebase hygiene:_ zero `FIXME`/`HACK`/`XXX` debt markers; no leaky response headers (`Server: cloudflare` only).
  - _Password policy (2026-06-02):_ signup + password-reset/confirm share one schema
    (`api-types/auth.ts`): `z.string().min(12).max(128)`, NIST 800-63B-aligned (length-based, NO
    composition rules — modern best practice), max-128 bounds the scrypt input. Sound. (The
    `egress.ts` `password.min(1)` is a customer-supplied PROXY credential passthrough — SOCKS5/
    OpenVPN — NOT an account-auth gate, so the looser bound is correct.)
  - _Auth token-type dispatch (2026-06-02):_ `authenticate()` routes by `ds_` prefix → API-key
    scrypt path, else → web-session sha256 path. Token-confusion impossible (both paths require the
    real secret; routing alone can't be exploited); the only edge — a web-session token randomly
    `ds_`-prefixed (~1/262k) — is a benign fail-closed false-negative (rejected + retry, never
    cross-validated). Cache keyed on full-plaintext sha (no cross-type collision); revocation
    invalidates the cache. Sound.
- **Operational / data-integrity dimensions (fresh, 2026-06-02 batch 3) — all SOUND, don't re-check:**
  - _DB migration expand-contract:_ across 67 migrations — mostly additive; the only constraint changes are
    RELAXING (`DROP NOT NULL`, in `0027`/`0059`); no NOT-NULL-add-without-default / `RENAME COLUMN` /
    type-narrowing. The lone destructive migration is `0065` (trial_pack dead-code): 4× `DROP COLUMN` on
    `accounts` **plus** an `ALTER TYPE account_tier RENAME VALUE 'trial_pack' → 'free'` — an in-place enum
    relabel (low-risk vs a query-breaking `RENAME COLUMN`; trial_pack was pre-LIVE/Stripe-test-mode so ~0 rows
    were relabelled and the dropped credit columns were never populated). `0066` (latest) is Class-A safe
    (`ADD COLUMN … NOT NULL DEFAULT … CHECK`). Deploy runs migrate-**before**-restart → a future
    `DROP`/`RENAME COLUMN` needs 2-phase sequencing (code-removal deploy first, schema-change later); the
    migration-rehearsal taxonomy (Class C destructive → rehearsal + founder approval) governs this.
  - _Audit-log coverage:_ security-relevant mutations emit audit entries at BOTH route-layer (BYOK / admin
    suspend·tier / oauth / crypto-billing / profile / email-prefs) AND service-layer (MFA enroll/disable/
    recovery via `mfa.ts` → `account.mfa_disabled`). No forensic blindspot.
  - _Transaction-atomicity:_ `db.transaction()` used where multi-write atomicity matters (11 usages —
    agent-sessions RMW, webhooks, stripe-event-dispatch, incidents). The lone non-transactional multi-write
    is the OAuth create-new path (cross-repo `accounts`+`links`; self-healing, low-severity — §4 item 6).
- **Concurrency / access-control primitives (fresh, 2026-06-02 batch 4) — all SOUND, don't re-check:**
  - _Pair-mode takeover lock:_ `agent-pair-mode-lock.ts` Redis variant = atomic `SET key clientId NX EX 30s`
    acquire (single winner per `pair_lock:${sessionId}`) + Lua owner-checked CAS-DEL release (canonical
    Redlock — A can't release B's lock, no GET→DEL race) + TTL auto-expiry (no deadlock-on-crash). No
    two-controller race.
  - _Scheduled-job claim/lease:_ `claimDue` = `FOR UPDATE SKIP LOCKED` CTE + `UPDATE…RETURNING` (no
    double-claim) + 5-min stale-lease reclaim (crashed worker) + bounded exponential-backoff retry →
    `markFailed`/`failed_at` terminal at `max_attempts` (no infinite retry / stuck job).
  - _Auth single-flight coalescer:_ `auth-coalescer.ts` collapses N concurrent same-token cache-misses to
    one scrypt; evicts the in-flight slot on settle (fulfil AND reject → no poisoning, next caller retries
    fresh); per-sha keyed; concurrency-dedup-only (the Redis cache memoizes). Cache fast-path short-circuits
    before coalesce.
  - _Transcript SSE replay:_ `Last-Event-ID` resume is strictly-`>` exclusive (`resumeFrom+1` — no dup/gap);
    garbage header → full replay; connect-then-publish race handled (`liveSent` dedupe + `index <
transcript.length` guard); account-scoped (cross-account → 404).
  - _LiveKit token grants:_ `sessions-livekit-token.ts` ownership-gated (`isSessionOwned` → cross-account
    404), `room == sessionId` (one room/session → no other-customer room), minimal grants (`roomJoin` +
    `canPublish`/`canSubscribe`, NO `roomAdmin`/`roomCreate`), 600s TTL → **no cross-account** stream /
    grant privesc. ⚠️ **UPDATE 2026-06-03:** the cross-account claim still holds, but a fresh audit found
    this V-531.B route **diverges from the canonical LK.3 route** (`agent-sessions-livekit-token.ts`) on
    two SELF-scoped/functional points — it lets a customer mint a `publisher` token (over-grant) and uses
    `identity:sessionId` (LiveKit duplicate-identity collision → the live-preview wouldn't work). Both
    not-live (config.livekit unset). See §2-18 + `2026-06-03-livekit-token-route-divergence.md`.
  - _Account email immutability:_ `UpdateAccountMeRequestSchema` whitelists only name/timezone/slug/region —
    NO `email` (nor tier/status/role) → no email-change endpoint exists → the email-change-then-reset
    takeover class has no surface; mass-assignment-safe.
  - _Account slug:_ `AccountSlugSchema` 3–32 lowercase-alphanumeric+hyphen (anchored, no-ReDoS, no
    leading/trailing/double-hyphen); the slug is a DISPLAY handle, NOT a routing/lookup key (no `/:slug`
    route) → a reserved-word slug can't shadow a route or impersonate; uniqueness 23505→409.
  - _API security headers (Fastify):_ `@fastify/helmet` emits nosniff / `X-Frame-Options: SAMEORIGIN` /
    `Referrer-Policy: no-referrer` / HSTS (2yr+preload) / `CORP: cross-origin`; CSP intentionally off
    (JSON-only). Pinned by the V-664 `security-headers.test.ts` regression suite (distinct from the
    CF-Pages headers above).
  - _Core AI-chat + lifecycle services (fresh-audited 2026-06-03, all sound):_ `agent-runtime.ts`
    (turn loop — budget-exhaustion close on both paths, best-effort usage/metrics, founder-verdict
    transient/fatal classification), `agent-pair-mode-state.ts` (pure takeover reducer — all
    queue/decline/cancel/heartbeat edges handled), `account-lifecycle.ts` (lifecycle email/audit
    dispatcher — atomic first-failure/first-success CAS dedup), `status-subscribers.ts`
    (admin-link bug FIXED `743fb484`), `health-probe.ts` (config-driven targets, no user SSRF; 2 LOW
    latent items in §4.8/§4.9). Detail in Agent-2 auto-memory.
  - _API-key management authorization (fresh-audited 2026-06-03 — tested a privilege-escalation
    hypothesis, REFUTED):_ the `routes/admin.ts` key routes (POST/DELETE/rotate `/v1/api-keys`) are
    `requireAuth + rateLimit` with NO `requireScope` in the preHandler, but scope is enforced
    SERVICE-side — `ApiKeysService.create`/`revoke` both `throwIfMissingScope(ctx,'account_owner')`,
    plus the V-174 de-escalation guard (`ELEVATED_SCOPES=['admin','driftstack_internal_admin']`;
    granting an unheld elevated scope → `ForbiddenError`). So a read-only key cannot mint a key, and
    even an `account_owner` key cannot escalate to a staff scope. FULLY tested behaviorally
    (`api-keys-service.test.ts`) + content-parity-pinned. **Meta-lesson:** scope is enforced in the
    service layer, not the preHandler → a naive preHandler-based scope-coverage drift-guard would
    FALSE-POSITIVE here (so none was built). Cache-Control (`lib/app.ts` global `no-store, private`
    hook, V-666) + the 28 timing-safe comparison sites were re-confirmed clean/saturated the same wave.
    Detail in Agent-2 auto-memory `project_api_key_management_authz_clean`.

## 4. Low-priority defense-in-depth backlog (NO decision required now — surfaced for visibility)

All belt-and-suspenders on already-sound surfaces; none is a current bug. Listed so they're
founder-visible (detail lives in Agent-2 auto-memory). Distinct from §2 (which needs decisions).

1. **DB-level email case-insensitivity** — a `LOWER(email)`/citext functional unique index would move
   the email-uniqueness guarantee from the app+test layer (createAccount lowercases + content-parity
   pin) to the DB. Can't autopilot (prod-applied migration; would fail on a pre-existing case-variant
   dup, which can't be checked offline).
2. **Webhook DNS-rebind connection-time pin** — create-time SSRF guard is comprehensive (literal
   v4/v6/::ffff/localhost/numeric-encodings/trailing-dot + 2 KiB URL cap); the lone residual is a
   hostname resolving public-at-create / private-at-delivery → needs undici custom-connector IP-pinning.
3. **Rate-limit coverage drift-guard** — _[SHIPPED 2026-06-03:
   `route-mutation-ratelimit-coverage-invariant.test.ts`. Statically classifies every
   POST/PUT/PATCH/DELETE in `apps/server/src/routes` into limiter / admin-scope / gated-stub /
   explicit-exempt; a wide-open new route now fails CI. The "false-positive risk" was de-risked by
   validating green against the current consistent tree (the scanner never descends into handler
   bodies — it bounds each decl to the text up to the next decl + stops the guard region at the
   handler boundary). **Building it SURFACED a real gap manual audits missed → see new §4.12.**]_
4. **Status-site unsub-token HMAC** — `rotateUnsubscribeToken` mints a fresh token per notification
   (only the latest email's unsub link verifies); a stable HMAC token needs a signing-key-source
   decision. Pre-launch (status site not live) → zero urgency.
5. **gui-client Tauri `csp: null`** — the desktop webview ships with no Content-Security-Policy.
   Low-severity (local bundled content + capability-gated IPC; capabilities + updater + entitlements
   all verified least-privilege/signature-verified), but Tauri recommends a CSP even for local content
   (mitigates XSS-via-API-data exfiltration). Not a blind fix — a wrong `connect-src` breaks the app's
   API/SSE/LiveKit/R2 calls and the Tauri runtime isn't in the server pre-push gate; needs a deliberate
   change enumerating all egress origins + gui-runtime validation.
6. **OAuth create-new transaction-atomicity** — `linkOrCreateAccount` Step 3 (no link, no email
   collision → create) does account-create (`createFromIdp`) + oauth-link-insert (`insertLink`) as two
   separate writes across two injected repos (`accounts` + `links`), no shared transaction. A crash
   between → an orphaned account (verified email, no link, no password). LOW-severity + SELF-HEALING:
   the customer's next OAuth sign-in hits the audited collision-merge flow (`findIdByEmail` → Verdict-1
   merge-verify → link created); narrow crash-window; no data-loss/cross-customer/security impact. NOT a
   discipline gap — `db.transaction()` IS used where atomicity matters (11 usages, §3); this is the lone
   cross-repo exception. A fix needs a transaction straddling two repos (architectural) → low priority.
7. **Agent-sessions idempotency body-mismatch observability (parity with crypto)** — the two
   idempotency implementations differ in mismatch-detection. `crypto-orders` is body-hash aware:
   `getIdempotencyMetrics()` returns a `bodyMismatches` count + a `crypto_checkout_idempotency_body_mismatch`
   warn log when a key is reused with a DIFFERENT request body (documented in `api/billing-crypto.md`).
   The v1.0 customer LLM path (`POST /v1/agent-sessions`) is key-ONLY: `findByIdempotencyKey(account_id,
key)` (schema has `idempotency_key` but NO request-hash column) silently replays the original session
   on a different-body reuse, with no metric/log. NOT a bug — it's replay-safe, account-scoped, and matches
   the documented "same key replays the original 201" contract (`api/agent-sessions.md`; `reference/idempotency.md`
   is silent on body-mismatch, consistent with both paths). The gap is purely OBSERVABILITY: an operator can
   detect accidental key reuse on crypto but not on the LLM endpoint. Closing it needs a request-hash column
   (prod-applied migration — can't autopilot) + a product call on whether agent-sessions should match
   crypto's detect-and-warn (vs the strict-Stripe 422-on-mismatch, which the platform deliberately does NOT
   do — it stays replay-safe). Low priority; surfaced for parity visibility.
8. **Health-probe auto-incident error-message info-leak** — `HealthProbeService.evaluateThresholds`
   auto-creates a `public:true` incident whose description interpolates the raw probe `errorMessage`
   (sliced to 500 chars) + `target.url`. HTTP failures are benign (`HTTP 503`), but a _network_
   failure's raw error (`FetchProber` catch branch) can embed an internal IP/host
   (e.g. `connect ECONNREFUSED 10.x.x.x:port`) → exposed on the public status page. LOW (all
   configured targets are currently public endpoints; status site not yet live). A fix would sanitize
   the public description to a generic message (keep the raw error in the private probe row + logs)
   — touches customer-facing incident copy, so deferred to a deliberate change, not a blind edit.
9. **Health-probe auto-create TOCTOU** — `findOpenAutoIncident(target) → create` has no DB-level
   uniqueness guard on open auto-incidents per `auto_probe_target`. A `processTick` exceeding the 60s
   bootstrap interval lets overlapping ticks both pass the `!open` check → duplicate auto-incidents for
   one target. LOW probability (a tick probes all targets in parallel with ~5s timeouts; should be
   well under 60s) + the bootstrap setInterval may not overlap in practice. Fully closing it needs a
   partial-unique index (prod migration — can't autopilot) or a per-target in-flight guard. Surfaced.
10. **cli-authorize/initiate (+exchange) unauth without an IP rate-limit gate** — `POST /v1/auth/
cli-authorize/initiate` is unauth and has NO `ipRateLimit` gate (creates a pending `cli_authorize`
    row per call → unauth table-bloat / minor DoS, bounded by the 5-min TTL + the code being inert
    without an authed `bind`/approve). It's the LONE unauth endpoint without a limiter — every other
    unauth family (auth signup/login/reset/magic-link, status-subscribe, oauth authorize/token,
    oauth-client start/callback) got an `ipRateLimit` gate in the 2026-05-19/20 unauth-gate sweep.
    AMBIGUOUS + pinned: `routes-auth-cli-content-parity.test.ts` explicitly pins initiate+exchange as
    "public (no preHandler)" (a deliberate V-266 decision), so this is EITHER an intentional exemption
    OR a gap the sweep missed. **Founder/maintainer call** (NOT autopilot — flipping it overrides the
    pinned V-266 "public, no preHandler" parity assertions): if a limiter is wanted, add
    `ipRateLimit(rateLimitStore, AUTH_IP_LIMITS.signup)` to initiate + update the parity pins in the same
    commit. LOW; flow code-security separately clean (V-266: 256-bit code/5-min TTL/one-shot/timing-safe).
11. **saved-proxies mutations lack a write-scope gate (latent; lands with EG-API-1.6).** `saved-proxies.ts`
    POST `/v1/proxies`, POST `/v1/proxies/:id/test`, and DELETE are `requireAuth + rateLimit` only — NO
    `requireScope`, unlike profiles/sessions (`write:profiles`/`write:sessions`) or recipes (`write`). So a
    read-only API key isn't blocked from mutating. MOOT today — every mutating saved-proxies route currently
    `throw`s `FeatureUnavailableError` (503) because the storage backend (EG-API-1.6) isn't wired. The gap
    goes LIVE when EG-API-1.6 replaces the 503 with a real insert/delete. **Egress-arc owner fix (NOT
    autopilot — egress is founder-gated/Tier-3-LOCKED per planning 133):** add `requireScope('write')` (or a
    new `write:proxies`) to the POST/DELETE preHandlers in the SAME commit that lands the storage layer. LOW
    (currently un-mutatable). Detail: [[project_scope_correctness_audit]].

12. **Unauth auth token-consume / session routes lack an IP rate-limit gate (LOW defense-in-depth;
    surfaced 2026-06-03 by the new §4.3 guard).** The 2026-05-15/19/20 unauth-gate sweep added
    `ipRateLimit` gates to the email-SENDING auth endpoints (signup / login / verify-email /
    resend-verification / magic-link-REQUEST / password-reset-REQUEST / mfa-challenge / oauth-client
    start+callback+confirm / status-subscribe) but NOT to these token-CONSUMING / session siblings,
    which register with an empty `{}` options object (no preHandler, no limiter):
    `POST /v1/auth/magic-link/consume`, `POST /v1/auth/password-reset/confirm`,
    `POST /v1/auth/refresh`, `POST /v1/auth/logout` (all unauth — the token is in the body, verified
    in-handler), plus `POST /v1/oauth/authorize/complete` (authed via `requireAuth` but omits
    `rateLimit('global')` — NOT a public vector, lowest severity). The
    `project_ratelimit_route_coverage_clean` audit memory had asserted "all 79 mutation routes
    protected" — that claim was INCOMPLETE for these 5; memory corrected.
    **Severity LOW (defense-in-depth, not a live vuln):** the consumed tokens are cryptographically
    sound — high-entropy, single-use, TTL'd (`project_auth_flow_token_audit_2026_05_31`) — so token
    brute-force is already infeasible; the residual is only unbounded-request DoS (cheap fast-fail,
    bounded by bodyLimit). **Founder/maintainer call (NOT autopilot):** adding an `ipRateLimit` gate is
    an outward-facing auth-flow behavior change that interacts with the founder-LOCKED `trustProxy`
    "one global bucket" behavior (prod `req.ip` resolves to the proxy → §2 item 5), most disruptive on
    the higher-frequency `/v1/auth/refresh`; and it would 429 legit users if mis-tuned. If gating is
    wanted: add `ipRateLimit(rateLimitStore, AUTH_IP_LIMITS.login)` (or a new bucket) to the 4 unauth
    preHandlers + `app.rateLimit('global')` to authorize/complete, and DELETE the matching entries from
    `SURFACED_PENDING_LIMITER` in the guard test in the SAME commit (else the guard goes red). Pinned
    meanwhile in that test's `SURFACED_PENDING_LIMITER` allowlist so the reality is explicit.
    Detail: auto-memory `project_unauth_token_route_ratelimit_gap`.
13. **`session.failed` webhook payload forwards the raw driver `error_message` verbatim (LATENT
    info-leak; surfaced 2026-06-03 by a fresh webhook-payload-disclosure audit).** A sweep of every
    `enqueueEvent` producer found all payloads clean EXCEPT this one: `api_key.revoked` carries only
    `{api_key_id, name, revoked_at}` (no hash/prefix/plaintext); `session.completed` /
    `egress_capability_changed` carry ids + duration + capability flags; `crypto.order.paid/failed`
    carry the customer's own order fields — all sound. But `session.failed`
    (`services/sessions.ts` `runWithFailureCapture`) sets `error_message = err.message` (the RAW driver
    error, unsanitized AND length-unbounded) and forwards it into the webhook payload + the stored
    session event. **Why it matters:** this is a SEPARATE disclosure channel that bypasses the
    deliberate 5xx-hides-cause posture the platform applies to the HTTP error response
    (`project_redos_and_error_response_infoleak_clean`, `d99b0a82`) — the HTTP response hides the
    internal cause, but the webhook leaks it. When the real WebKit driver lands (today `driver:"mock"`,
    so latent), a mid-operation infra failure (`connect ECONNREFUSED 10.x.x.x`, an internal
    node hostname, a driver-internal URL) could reach the customer's webhook endpoint. **Severity LOW**
    (customer-scoped — the customer's own session → the customer's own webhook, NOT cross-customer; and
    customers generally WANT driver-error detail). **Founder/maintainer call at real-driver-wiring time
    (NOT autopilot — outward-facing webhook-payload content + needs an error-disclosure taxonomy
    decision on which driver errors are customer-safe vs internal):** mirror the §4.8 health-probe
    approach — keep the raw error in the private session-event row + logs, forward a sanitized +
    length-capped message on the webhook. Same "fix when the surface goes live" shape as §4.8 / §4.11.
    Detail: auto-memory `project_webhook_session_failed_error_message_leak`.

**Net:** the safe, non-gated Agent-2 audit/hardening surface is comprehensively mined (§1 shipped, §3
verified-sound across ~15 dimensions). Genuine forward progress now needs a founder decision from §2,
an item from the §4 backlog, or a new track.
