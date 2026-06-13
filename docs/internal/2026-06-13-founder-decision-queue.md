# Agent-2 status + founder decision queue — 2026-06-13

Supersedes `2026-06-10-autopilot-arc-briefing-and-decision-queue.md` (state moved).

## State (all verified against live prod this session)

- **Prod is fully current** (`api.driftstack.dev` git_sha `507b690b` = origin HEAD) and
  **operationally signed off**: `NRestarts=0`, 0 `level:error` / 500 / uncaught in the
  journal, 0 "column/relation does not exist" (the 5 migrations 0072-0076 applied
  cleanly + code matches schema). `driver:mock` is the expected pre-launch state.
- **Code surface exhaustively audited clean** this session: authz (route-scope +
  resource-ownership + SSE ds_token), crypto (platform-secrets + profile key-hierarchy),
  URL-credential redaction (query/bearer/userinfo), error info-disclosure, CORS (verified
  secure in prod), input-bounds, account-scoping, migration DDL/index coverage.
- **Shipped + live this session**: frontend-perfection punch-list (themes deployed across
  docs/status/marketing/dashboard), session concurrency-limit TOCTOU fix, userinfo
  log-redaction, fleet-control node-IP forward-guard, prod brought from 154-commits-behind
  to current. Real finds: userinfo redaction + session TOCTOU (both fixed + deployed).

**The non-gated substantive work is genuinely exhausted.** Everything below needs a
decision; none is autonomously safe to flip.

## Decisions needed (priority order)

1. **CF-Connecting-IP origin spoof — HIGH, the one real open prod security gap.**
   `set_real_ip_from 0.0.0.0/0` + ufw `:443 ALLOW Anywhere` → a direct origin connection
   with a forged `CF-Connecting-IP` controls `req.ip`, defeating every IP rate-limit gate
   (login/signup/echo) + forging geo. **Pick a remediation** (detail +
   verification steps: `2026-06-13-cf-connecting-ip-spoof-origin-exposure.md`):
   - **B (recommended, low-risk):** pin nginx `set_real_ip_from` to Cloudflare's published
     CIDRs — a missed range only coarsens rate-limiting, never an outage.
   - A (strongest): firewall `:443`/`:80` to Cloudflare ranges (also hides the origin;
     outage-risk if the list is stale — automate the refresh).
   - C: Cloudflare Authenticated Origin Pulls (mTLS). Best paired with A+B.
     Ops/infra change — I can prep the exact config on your go.

2. **agent_sessions strict-FK — design call (pre-launch).**
   `agent_sessions.driftstack_session_id` stores the PREFIXED public id (`ses_<uuid>`), so
   a uuid FK can't be added (cast fails; orphan-backfill would wipe links — I designed +
   reverted migration 0069). **Recommended: Option 2** — keep the loose `text` link +
   app-level validation (the column is usually null; FK value is modest pre-launch). Option
   1 (deprefix-on-write + raw-uuid + real FK) is more plumbing. Detail in
   `project_session_concurrency_limit_toctou_race` memory / backlog.

3. **Metrics/observability layer inert — LOW (ops).**
   Prod `METRICS_SCRAPE_TOKEN` unset + the metrics registry isn't instantiated → `/metrics`
   404s (no Prometheus scrape). To enable: wire the registry + set the token + stand up a
   scraper. Or accept inert pre-launch. Not a security/correctness bug.

## ~~Engineering-resolvable~~ — withdrawn (false positive)

4. ~~**Cross-SDK retry-policy divergence on 5xx.**~~ **WITHDRAWN 2026-06-13 — FALSE POSITIVE.**
   The TS-retries-5xx / Go+Python-treat-5xx-as-terminal difference is **intentional and
   test-locked** (W679 `cross-sdk-retry-policy-parity.test.ts:87` + W815
   `sdk-retry-policy-cross-sdk-parity.test.ts:79` both pin it as a CRITICAL invariant; W815
   explicitly warns that dropping TS's 5xx retry would "lose transient resilience"). The
   original audit missed those two dedicated parity tests. No decision needed, no change.
   Correction trail: `2026-06-13-cross-sdk-retry-policy-5xx-divergence.md`.

## Engineering-resolvable (deliberate dep-maintenance pass)

5. **`ws` moderate prod-runtime vuln — surfaced 2026-06-13.** `ws@8.18.0` (via
   `@fastify/websocket`, the fleet-events WS) has GHSA-58qx-3vcg-4xpx (uninitialized memory
   disclosure; patched 8.20.1+, semver-compatible). LOW active exposure (fleet-events WS is
   gated/unwired pre-launch) but exposed at go-live → fix before launch. A clean incremental
   fix is blocked by an npm-workspaces dedup quirk; needs a full lockfile regen in a
   sole-writer/low-load window (attempted + cleanly reverted this wave). Detail:
   `2026-06-13-dep-vuln-delta-ws-prod-runtime.md`.

## Product / founder decision

6. **Agent model registry refresh — `claude-opus-4-8` now available.** The per-session model
   picker (`api-types/agent-models.ts CLAUDE_MODELS`) offers Opus 4.7 / Sonnet 4.6 / Haiku 4.5,
   with `DEFAULT_AGENT_MODEL = claude-opus-4-7`. **Opus 4.8 (`claude-opus-4-8`) is now released**
   — a "model version bump" per the registry's own "verify quarterly + on model version bumps"
   guidance. Adding it (AgentModelSchema + CLAUDE_MODELS with its verified Anthropic list-price
   rate + whether it becomes the default) is a **product call** (which models to offer + any
   bundled-tier implications), so surfaced not flipped. Opus 4.7 still works — this is a
   freshness/curation decision, not a bug. The cost-accounting math + existing rates are verified
   correct (cost-to-serve, not customer pricing) — see `project_llm_cost_rate_accounting_clean`.

## Minor / awaiting a nod

- **`/Applications` has 11 stale `Driftstack.app.prev*` backups** (auto-created by the Tauri
  rebuild flow; ~1GB). Safe to clean (keep the latest for rollback) — say the word.
- Tauri app is current in `/Applications` (rebuilt 10:05, carries GUI fixes #4/#7/#9/#10).
- Already-resolved (don't re-surface): profile-count TOCTOU (fixed by `insertWithLimit`
  V-714); permissive-CORS (prod verified secure: `PERMISSIVE_CORS=false` + complete list).
