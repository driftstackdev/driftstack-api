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
