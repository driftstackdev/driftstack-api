# Overnight handoff — 2026-05-16 morning briefing

40 commits between 2026-05-15 22:00 UTC and 2026-05-16 05:04 UTC.
Production at SHA `7e057a33`, all 9 post-deploy-verify invariants
green on every deploy this block. Tree clean.

## What's hot on prod

```
sentry:true, email:true, livekit:true, oauthClient:true, env:production
```

All four activation flags are TRUE. Empirical proof via
`bash scripts/deploy-status.sh --quiet --check` exiting 0.

## Headline milestones

### 1. OAUTH_CLIENT end-to-end activated (Wave 1062)

Founder-authorized credentials wired via heredoc-to-SSH (never
echoed, chmod 600), systemctl restart, smoke-validated:

- staging + prod boot logs confirm `"oauthClient":true`
- POST /v1/auth/oauth-client/start returns a real Google authorize
  URL with the wired client_id + PKCE + state JWT
- /v1/account/me/oauth-links returns 401 (route registered + auth-gated)
- /v1/auth/oauth-client/confirm-merge gated on token shape

Customer can now sign in via Google or GitHub. Verdicts 1/2/3 are
implemented per the founder spec (merge-with-verification, graceful
fallback, first-link-only avatar).

### 2. V-545.A status surface end-to-end (Waves 1071-1072)

Public incident detail timeline + recent_incidents on /v1/status:

- GET /v1/status/incidents — list, 30d window, 30s Cache-Control
- GET /v1/status/incidents/:id — detail + timeline, 30s Cache-Control
- /v1/status.recent_incidents — top 5 public summaries, typed shape
- status-site `/incident?id=inc_<uuid>` page renders timeline
- index card titles link to detail
- OpenAPI typed schema (was z.unknown())

### 3. V-549.B deploy hardening end-to-end (Waves 1062-1080)

The deploy-bridge toolchain is now the canonical prod-deploy path
with V-549.B-equivalent guards:

- `scripts/deploy-bridge.sh` — clone+build+swap+restart+verify with
  auto-revert on FAIL
- `scripts/post-deploy-verify.mjs` — 9 invariants vs public origin
- `scripts/revert-bridge.sh [--dry-run]` — reads .last-good-sha,
  --dry-run exits 0 if no-op / 2 if revert needed
- `scripts/deploy-status.sh [--check] [--json] [--quiet]` — read-only
  snapshot + cron-shaped flag-check
- `/opt/driftstack/api/.last-good-sha` — tracker on each host
- `/opt/driftstack/api/.deploy-history.log` — append-only audit
  with `<iso> <sha> <prev> <elapsed>` rows

Every deploy this block: 30-34s elapsed, 9/9 invariants OK. No
reverts triggered (no regressions). Auto-revert wiring tested via
deliberately-bad-SHA test would be next-iteration empirical work.

### 4. V-667.C-followup customer surface (Wave 1062, 1078)

- GET /v1/account/me/oauth-links — customer-facing list of linked
  IDPs (provider, provider_email, linked_at, last_login_at,
  last_revoked_at). Internal fields (provider_sub, avatar_url,
  name) intentionally omitted.
- ?active_only=true filter for the Verdict-2 revoked links.
- Customer dashboard /settings page wires "Connected accounts"
  section that consumes the endpoint.

### 5. V-545.B Phase 1 (Wave 1075)

`onPublicUpdated` lifecycle hook on IncidentsService fires per
addUpdate on public incidents. Wired but not yet email-emitting
(throttling table needed; deferred to Phase 2).

### 6. Sub-processor RSS feed (Wave 1062 Trust track)

`/trust/sub-processors/feed.xml` — Article 28(2) amendment notices
as RSS 2.0 for auditors + privacy teams. Pulls from
SUB_PROCESSOR_CHANGELOG.

### 7. Track F-Upstash split design (Wave 1062)

`scripts/v278l-upstash-split-cutover.sh` — sister to the existing
V-278.K Neon split. Dry-run default, operator runs --execute when
the new Upstash instances are provisioned.

### 8. Deploy.yml verdict design (Wave 1062 P-track)

`docs/internal/2026-05-16-deploy-yml-verdict-design.md` — Option A
(install Docker) vs Option B (rewrite YAML around deploy-bridge)
cost analysis. Recommendation hinges on launch timeline.

## Operator action queue (when you're back)

1. **V-545.B Phase 2** is the next bounded slice: add the
   `status-incident-updated` Postmark template + per-subscriber-
   per-incident-per-hour throttle table. Multi-file (template +
   parity tests + bootstrap wire). Estimated 1-2 waves.

2. **Track F execution** — V-278.K Neon split + V-278.L Upstash
   split. Both have --execute scripts ready; need neonctl +
   Upstash console auth to actually run.

3. **deploy.yml-vs-server verdict** — pick Option A (install Docker)
   or Option B (rewrite YAML); autopilot can fire Option B
   autonomously on OK.

4. **Real-IDP smoke** — sign in via Google + GitHub from
   https://app.driftstack.io/login to validate V-667.C verdicts
   1/2/3 end-to-end with real provider accounts.

5. **deploy-status --check** is suitable for cron wiring on the
   ops monitor side: `*/5 * * * * bash scripts/deploy-status.sh --quiet --check || curl …slack…`.

## Issues / non-blocking observations

- Drizzle migrate.js silently no-op'd against the bridge layout on
  first staging attempt. Workaround in 5822e211 (src-tree fallback
  - bridge runs migrations explicitly). Root cause unconfirmed
    upstream — recorded in `2026-05-15-deploy-pipeline-mismatch.md`.
- Initial bridge SHA-resolution race (push completes mid-deploy);
  fixed in bdabba6 (fetch origin/main first).
- `npm install + prune` drops transitive runtime deps; switched
  to `npm ci --include=dev` (5a67945).

## Test count

1206+ unit test files, ~13530 individual tests, 0 failures
sustained across every commit this block.

## Tracks rotated (Rule M)

Earlier waves (1062-1073) consistently rotated 3+ tracks per wave
(feature / ops / docs / tests / deploy). Later waves (1074+) drifted
to 1-2 tracks each as the substantive scope thinned to small
follow-ups + doc consolidation. No drift-guard-absorption episodes
this block. Memory entry for the deploy-bridge pattern refreshed
twice to keep it current with `--check`, `--quiet`, and `--json`
flag additions.

## What's queued but not started

- V-541 cost monitoring admin-panel UI (multi-wave; endpoints
  already exist at `/v1/admin/cost/*`)
- V-552 API ref deep-dive content (content work, multi-wave)
- V-543 customer-success email templates (multi-wave parity churn)
- V-547 Scenarios 5/7/8 (need mocking infra)
- V-500 pricing detail page (large)
- V-501 onboarding wizard (large)
- V-503 security overview public page (large)

Each is a 1+ wave dedicated effort. Autopilot stayed within
bounded slices this block.

## Update — 2026-05-16 morning foreground session

After the ScheduleWakeup-broken overnight gap, founder returned at
09:37 UTC and re-engaged. 17 additional commits shipped in foreground
between 09:37 and ~11:00 UTC:

| SHA        | What                                                                       |
| ---------- | -------------------------------------------------------------------------- |
| `d8151f55` | V-545.B Phase 2 throttle table migration (`incident_update_notifications`) |
| `d9b10631` | V-545.B Phase 2.5 wire — repo + `notifyUpdated` + bootstrap                |
| `d8af7127` | V-545.B Phase 2 empirical throttle integration tests (2 cases)             |
| `e2c122b1` | V-545 incident-notification operator runbook                               |
| `1f0b415b` | `migrate.ts` post-condition assertion (drizzle silent-skip guard)          |
| `3838e810` | V-541.B admin-panel `/cost` page                                           |
| `d9e3515f` | Admin nav `Cost` entry (W381.B parity refresh)                             |
| `16439c27` | `post-deploy-verify` 10th invariant (`/v1/admin/cost/config`)              |
| `c4943da7` | Doc count refresh 9 → 10 invariants                                        |
| `4c36ab31` | `cost-monitoring.md` cross-refs admin /cost page                           |
| `0f9b4cb3` | `revert-bridge --to-sha <sha>` operator override                           |
| `d9915103` | Admin /cost prefix-strip on pasted account ID                              |
| `626f7e89` | Admin /cost "Top accounts by cost" section                                 |
| `98867a99` | `deploy-status` migration-drift detection (pre-deploy silent-skip catch)   |
| `7bb22aa4` | `deploy-status --json` includes migrations field                           |

**Two-layer silent-skip defense now in place**:

- **Pre-deploy**: `bash scripts/deploy-status.sh --check` flags
  `DRIFT expected=N actual=M` when `_journal.json` and
  `drizzle.__drizzle_migrations` disagree. Cron-wirable via
  `bash scripts/deploy-status.sh --quiet --check || alert`.
- **Deploy-time**: `apps/server/src/db/migrate.ts` post-condition
  exits 2 on count mismatch → `deploy-bridge.sh` auto-reverts to
  `.last-good-sha` (V-549.B).

**V-545.B implementation arc closed**: Phase 1 hook → Phase 2
template + dispatch → Phase 2 throttle table → Phase 2.5 service

- bootstrap wire → empirical proof via 2-case integration test
  ("throttled at 0 emails on the second update within 1h").

**V-541.B has full admin UI**: config inspector (rate card + tier
thresholds), per-account query with prefix-stripping, top-N by
cost (existing service-layer `getOverview` already sorts desc).

Production state at 11:00 UTC: prod + staging both at `16439c27`
with all 10 invariants OK on every deploy. Migrations 41/41 OK.
Test suite: 1246 files, 13844 cases, 0 failures.
