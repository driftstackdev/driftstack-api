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

## 2. FOUNDER-DECISION QUEUE (gated — Agent-2 cannot safely self-do these)

1. **`DEPLOY_DOTENV_BASE64` GH Actions secret likely still holds the HEX `MFA_ENCRYPTION_KEY`.**
   Used only by the abandoned `server-deploy.yml` (the active path is `deploy.yml`, which
   leaves `.env` SSH-managed). If `server-deploy.yml` is ever run it would reintroduce the
   hex key. **Action:** update the secret to the base64 form, or retire `server-deploy.yml`.
   (Agent can't read/write a key-bearing secret safely.)
2. **Enable `DB_STATEMENT_TIMEOUT_MS` in prod** (suggest ~`30000`) after a glance at query
   profiles — the capability shipped (`7e63f6ff`) but is inert until set. It caps every app
   query, so enabling/value is an ops judgement.
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

**Net:** the safe, non-gated Agent-2 audit/hardening surface is comprehensively mined. Genuine
forward progress now needs a founder decision from §2 or a new track.
