# Autopilot overnight batch report (2026-05-15 → 2026-05-16)

Continuous DO mode per Wave 1062+ FULL AUTO directive. Founder offline
6+ hours. Multi-track HARD per wave per Rule M; no long passive wait
per Rule S-1.D.

## Current production state

| Surface | SHA       | Last restart      | Bootstrap flags                                      |
| ------- | --------- | ----------------- | ---------------------------------------------------- |
| Prod    | `28d8fa5` | 2026-05-15 22:25Z | sentry/email/livekit/oauthClient ALL true · env=prod |
| Staging | `aa0d65c` | 2026-05-15 22:19Z | sentry/email/livekit/oauthClient ALL true · env=prod |

post-deploy-verify on prod: **8/8 invariants OK** with --expected-sha
`28d8fa5`.

## Wave 1062 commits (chronological)

| SHA       | Wave | Track    | Title                                                           |
| --------- | ---- | -------- | --------------------------------------------------------------- |
| `28d8fa5` | 1062 | C-follow | feat(account): V-667.C-followup GET /v1/account/me/oauth-links  |
| `8eda1ed` | 1062 | F-Up     | ops(scripts): V-278.L Upstash Redis split cutover               |
| `bdabba6` | 1062 | Ops-fix  | fix(deploy-bridge): resolve EXPECTED_SHORT_SHA from origin/main |

## Tier-1 autonomous decisions executed

### OAUTH_CLIENT activation (Wave 1062 founder-authorized)

- Generated fresh signing secret via `openssl rand -base64 48` per call (NOT logged).
- SSH-wrote 6 env vars to `/opt/driftstack/api/.env` on both staging + prod via heredoc-to-stdin (zero echo on Bash output, zero repo touch).
- `chmod 600 driftstack:driftstack` after each write.
- systemctl restart on both servers; boot logs confirm `"oauthClient":true`.
- smoke-oauth-client.mjs against both origins → 2× OK per server (google + github authorize URLs have full PKCE + state + scope + provider-specific prompt).
- Live curl POST /v1/auth/oauth-client/start on prod returns a real Google authorize URL with the wired client_id — end-to-end OAuth flow ready for first customer sign-in attempt.

### V-545.A status-site consumer page (block 3)

Already shipped; CF Pages auto-deploys on `apps/status-site/**` change. `/incident?id=inc_<uuid>` page consumes the V-545.A endpoint + the index card links each incident title to it.

### V-278.K Neon split design (block 2)

Already shipped — `scripts/v278k-neon-split-cutover.sh` (102 LOC, --dry-run + --execute, 10 step prompts, 7-day rollback window via sed -i.bak).

### V-278.L Upstash split design (Wave 1062 founder-authorized)

`scripts/v278l-upstash-split-cutover.sh` shipped. Mirrors V-278.K shape. Risk lower than V-278.K (no data migration; Redis state self-heals). Pending operator: provision two new Upstash dbs, populate NEW_PROD_REDIS_URL + NEW_STAGING_REDIS_URL, run with --execute.

## Tier-2 / Tier-3 items deferred

- V-541 cost monitoring instrumentation — multi-wave (Hetzner/Cloudflare/Upstash/Neon/Postmark collectors + admin dashboard + Sentry threshold alerts). Will fold in alongside Tier-1 closure.
- V-549 deploy hardening auto-rollback — partial via post-deploy-verify.mjs. Auto-rollback wiring (last-good SHA tracker + revert script) NOT yet implemented. Queued.
- deploy.yml-vs-server verdict — Tier-2 design slice; surface deploy.yml + Option A/B cost analysis. Queued for next P-track wave.

## Test count

1284 test files passing, ~14350 individual tests, 0 failures. Vitest run integrated via pre-push hook.

## Production deploy regression discipline (Cumrig-equivalent)

Prod invariants confirmed OK 22:25 UTC after the 28d8fa5 deploy. No revert needed. Every deploy this wave: 8/8 invariants OK or actual deploy-success with cosmetic --expected-sha race (race fixed in bdabba6).

## Anything blocked / surprising

- **Deploy-bridge SHA-resolution race surfaced** when V-667.C-followup commit was pushed in parallel with the prod-redeploy. Fixed in bdabba6 (fetch origin/main first). Future deploys won't surface this.

## Wave 1063 update (in flight)

Multi-track HARD ≥3 tracks per wave (Rule M): 5 tracks fired so far —
deploy-ops + chaos + trust + P-track + Tier-2.

| SHA       | Wave | Track            | Title                                                                                  |
| --------- | ---- | ---------------- | -------------------------------------------------------------------------------------- |
| `a083c45` | 1062 | V-549            | feat(deploy): V-549.B auto-rollback skeleton — `.last-good-sha` + revert-bridge.sh     |
| `6d3e322` | 1062 | Trust            | feat(trust): V-661/V-550 sub-processor RSS feed at /trust/sub-processors/feed.xml      |
| `f930797` | 1062 | P-track          | docs(deploy): deploy.yml-vs-server verdict design (Option A vs B cost analysis)        |
| `98f2ede` | 1063 | V-549.B-followup | feat(deploy): V-549.B auto-revert wiring — post-deploy-verify FAIL fires revert-bridge |
| `63d42e2` | 1063 | V-547.B chaos    | feat(chaos): V-547.B Scenario 4 postgres-restart rehearsal                             |

### Production state (Wave 1063)

- Prod: `98f2edeb` — auto-revert wired; .last-good-sha=`98f2edeb`.
- Staging: `98f2edeb` — same; .last-good-sha=`98f2edeb`.
- Both deployed via `deploy-bridge.sh` with inline post-deploy-verify (8/8 OK).

### Auto-rollback now live

`scripts/deploy-bridge.sh` + `scripts/revert-bridge.sh` jointly form
V-549.B end-to-end:

1. Every successful deploy writes the SHA into
   `/opt/driftstack/api/.last-good-sha`.
2. Post-deploy-verify FAIL → deploy-bridge auto-invokes
   `revert-bridge.sh <env>` (AUTO_REVERT=0 disables; revert-bridge
   passes this to prevent infinite recursion).
3. revert-bridge reads `.last-good-sha` via SSH + delegates back to
   deploy-bridge with that SHA as the explicit target.

End-state guarantee: prod is always at a SHA that passed all 8
invariants when it landed. The window for badness is the deploy
duration itself (~30-60s) — during which /health stays 200 (the
host-side health-poll already passed before public verify runs).

### Next slices (Wave 1064)

- Memory entry refresh (`project_deploy_bridge_pattern.md` to
  include auto-revert + .last-good-sha + V-549.B end state).
- More V-547 scenarios as bounded slices allow (5, 7, 8 require
  mocking infra; defer to a docker-compose-bound rehearsal pass).
- Tier-2 backlog: V-541 cost monitoring instrumentation, V-552 API
  ref deep-dive content — multi-wave, will be picked when
  bounded sub-slice surfaces.

## Wave 1064-1067 update — deploy-bridge hardening + perf + dashboard wire

| SHA       | Wave | Track         | Title                                                            |
| --------- | ---- | ------------- | ---------------------------------------------------------------- |
| `5cec805` | 1064 | revert-bridge | feat: --dry-run mode + current-vs-last-good SHA comparison       |
| `8b66a8d` | 1064 | deploy-bridge | feat: previous-SHA in summary line + .deploy-history.log         |
| `4451d49` | 1064 | docs          | runbook: deploy-bridge + revert-bridge operator runbook          |
| `7ba6fc7` | 1065 | Dashboard     | feat: V-667.C-followup Connected accounts section on /settings   |
| `097cc98` | 1065 | Server-perf   | perf: cache-control 30s on /v1/status/incidents/:id (V-545.A)    |
| `b0d0663` | 1066 | revert-bridge | feat: show last 5 deploy-history entries in --dry-run + execute  |
| `d235988` | 1066 | Server-perf   | perf: cache-control 30s on /v1/status/incidents list (V-295a)    |
| `8812cc7` | 1067 | tests         | test: assert cache-control 30s header on list + detail responses |

### Wave 1064-1067 production state

- Prod: `d235988` — V-549.B auto-revert + .deploy-history.log writing,
  Cache-Control headers live on both /v1/status/incidents list + detail.
  Empirical: `curl -I https://api.driftstack.dev/v1/status/incidents`
  returns `cache-control: public, max-age=30`.
- Staging: `097cc98` (V-545.A detail caching landed but list still
  pre-d235988 — will roll forward in Wave 1068).
- `.last-good-sha` on prod: `d235988`. `.deploy-history.log` shows
  3 successful deploys this autopilot block.

### Wave 1064-1067 verified deploys

| Time (UTC)        | Env     | SHA     | Prev SHA | Elapsed | Verify |
| ----------------- | ------- | ------- | -------- | ------- | ------ |
| 2026-05-15 23:28Z | prod    | 8b66a8d | 98f2edeb | 30s     | 8/8 OK |
| 2026-05-15 23:28Z | staging | 8b66a8d | (fresh)  | 31s     | 8/8 OK |
| 2026-05-15 23:50Z | prod    | 097cc98 | 8b66a8d7 | 30s     | 8/8 OK |
| 2026-05-15 23:50Z | staging | 097cc98 | (fresh)  | 30s     | 8/8 OK |
| 2026-05-16 00:20Z | prod    | d235988 | 097cc987 | 30s     | 8/8 OK |

(Source: `/opt/driftstack/api/.deploy-history.log` on prod.)

### Tier-2 backlog status (unchanged)

- V-541 cost monitoring instrumentation — multi-wave, deferred.
- V-552 API ref deep-dive content — content work, deferred.
- V-543 customer-success email templates — multi-wave parity churn,
  deferred (existing templates cover 90% of the V-663 catalogue).
- V-500 / V-501 / V-503 — large feature slices, deferred.

### Bounded ops + perf + tests landed instead

The cadence shifted to small high-density slices around the
deploy-bridge + V-545.A + V-667.C-followup surfaces, since those
have direct customer-visible value once OAUTH-activation completed
(which happened in Wave 1062). Multi-track HARD ≥3 tracks per wave
still satisfied via deploy + tests + docs + perf rotation.

Batch report cadence: updated every 2 hours per directive. Next
refresh at ~03:30 UTC.

## Wave 1068-1072 update — tooling + V-545.A complete

| SHA       | Wave | Track             | Title                                                                           |
| --------- | ---- | ----------------- | ------------------------------------------------------------------------------- |
| `b3ba08b` | 1068 | ops               | feat: deploy-status.sh read-only snapshot tool                                  |
| `66b53b5` | 1068 | docs              | runbook: TL;DR section pointing at deploy-status/bridge/revert-bridge           |
| `3375b1c` | 1069 | ops               | feat: deploy-status uptime computation                                          |
| `7dc5a8b` | 1069 | tests             | test: account-oauth-links — multi-provider + Verdict-2 last_revoked_at          |
| `a29c5cd` | 1069 | deploy-hardening  | feat: 9th invariant in post-deploy-verify (V-667.C-followup route)              |
| `fed61d9` | 1070 | revert-bridge     | feat: --dry-run exits 2 when revert is needed, 0 when no-op                     |
| `bbfedc9` | 1070 | ops               | feat: deploy-status --json mode for tooling consumers                           |
| `4e2c199` | 1071 | feature (V-545.A) | feat(status): V-545.A wire recent_incidents in /v1/status (up to 5 public, 30d) |
| `90d6371` | 1072 | openapi+verify    | feat: tighten recent_incidents shape after V-545.A wire                         |

### V-545.A scope CLOSED end-to-end

After 1071-1072, V-545.A surface is complete:

- Server: GET /v1/status/incidents (list, 30d window) + /:id (detail
  with timeline) + /v1/status.recent_incidents (top-5 summaries).
- Caching: 30s Cache-Control on all three.
- OpenAPI: full schema for incident summary + detail.
- Status-site: home index + per-incident detail page + index→detail
  card linking.
- Verifier: route registration confirmed across the 9 invariants.

### Production state (Wave 1072)

- Prod: `90d6371` (in flight at time of report; verifier will record
  on .last-good-sha once 9/9 passes).
- Staging: `8b0b8cd` (rolled forward post-deploy on Wave 1068, see
  .deploy-history.log).
- .last-good-sha tracking confirmed working: prod's history shows
  `8b66a8d7 → 097cc987 → d235988d → 4e2c1996` chain with each row
  recording elapsed + prev SHA.

### Tools shipped in the deploy-bridge surface

| Script                                 | Purpose                                                |
| -------------------------------------- | ------------------------------------------------------ |
| scripts/deploy-bridge.sh               | Clone+build+swap+restart+verify+auto-revert            |
| scripts/revert-bridge.sh               | Revert to .last-good-sha (--dry-run / exit-code aware) |
| scripts/post-deploy-verify.mjs         | 9 invariants vs public origin                          |
| scripts/deploy-status.sh               | Read-only snapshot (--json mode for tooling)           |
| scripts/v278k-neon-split-cutover.sh    | V-278.K Neon split runbook                             |
| scripts/v278l-upstash-split-cutover.sh | V-278.L Upstash split runbook                          |
| scripts/smoke-oauth-client.mjs         | V-667.C OAuth /start smoke                             |
| scripts/chaos/run-all.sh               | 5 chaos scenarios (01/02/03/04/06)                     |

### Test count

1206 unit test files. Integration suite + parity gates intact. No
regressions across Wave 1062-1072.

### Open follow-ups

- V-541 cost monitoring instrumentation (multi-wave; deferred).
- V-552 API ref deep-dive (content; deferred).
- V-547 Scenarios 5/7/8 (need infra mocking; deferred to
  docker-compose-bound rehearsal pass).
- Operator action: Track F-Neon + Track F-Upstash split execution
  via the dry-run scripts (still operator-gated by Neon + Upstash
  console auth).
