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

## 2. FOUNDER-DECISION QUEUE (gated — Agent-2 cannot safely self-do these)

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
    despite the HIGH rating); `undici` (HTTP-client: decompression-DoS / WebSocket-overflow /
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

## 3. Audit-saturation map (comprehensively swept — don't re-sweep without a concrete reason)

- **Resilience:** dependency timeouts (§1), bounded shutdown, readiness probe — done.
- **Webhooks:** delivery, durable cursor keyset, orphaned-in-flight reclaim, HMAC signing,
  SSRF, retry-backoff (consistent), endpoint auto-disable (consecutive, reset-on-success) — sound.
- **Security classes:** IDOR/ownership, injection (SQLi/CSV/PDF/ReDoS), sensitive-data-in-logs
  (CWE-532, V-494 redact + Sentry mirror drift-guarded), crypto-at-rest (AES-256-GCM family),
  OAuth/PKCE/MFA/auth-token, CI/GitHub-Actions, CF-Pages security headers, config/env validation — clean.
- **SDKs** (TS/Go/Python) swept; AI subsystem, status surface, billing (Stripe + crypto IPN) audited.
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
3. **Rate-limit coverage drift-guard** — no test asserts every customer-facing route carries
   `rateLimit()` (application is currently consistent); a guard needs a careful legitimate-exception
   allowlist (admin / webhook-receiver / public routes) → moderate complexity + false-positive risk.
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

**Net:** the safe, non-gated Agent-2 audit/hardening surface is comprehensively mined (§1 shipped, §3
verified-sound across ~15 dimensions). Genuine forward progress now needs a founder decision from §2,
an item from the §4 backlog, or a new track.
