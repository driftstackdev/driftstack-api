# V-549 — deployment pipeline hardening

**Date:** 2026-05-11
**Wave:** 24
**Status:** DESIGN — current pipeline ships changes via GitHub Actions
deploy.yml (V-278). V-549 designs the next-layer hardening before paid
traffic.

## Current state

`.github/workflows/server-deploy.yml` (V-278):

1. On push to `main`: trigger build.
2. typecheck + lint + tests.
3. SSH to Hetzner instance + `git pull` + `npm ci` + `npm run build`
   - restart server process via the existing systemd unit.

Strengths:

- Tests run before deploy.
- Single-instance posture is consistent with cost-discipline pre-
  launch.

Gaps:

- No pre-deploy smoke test against the live target.
- No canary; full traffic cuts over immediately.
- No automated rollback on post-deploy health-check failure.
- Manual SSH access required for rollback.

V-549 closes these gaps with minimal infra change.

**Implementation status:** V-549.A + V-549.B landed via V-660 (Wave 46)
in `.github/workflows/server-deploy.yml`. V-549.C remains design-only
until multi-instance landing.

## Three hardening layers

### V-549.A — pre-deploy smoke

Before SSH-deploy step, run a smoke test against the existing
production target:

```yaml
- name: Pre-deploy production smoke
  run: |
    curl --fail --max-time 5 https://api.driftstack.dev/health
    curl --fail --max-time 5 https://api.driftstack.dev/openapi.json \
      | jq '.openapi' | grep -q '^"3.1'
```

If the production target is unhealthy _before_ deploy, abort — don't
make it worse by deploying on top of a broken state. The smoke is 2
HTTP calls; cost is sub-second.

### V-549.B — post-deploy health-check + auto-rollback

After SSH-deploy step, wait 30s then run the smoke against the now-
deployed version:

```bash
sleep 30
if ! curl --fail --max-time 5 https://api.driftstack.dev/health; then
  echo "post-deploy health check FAILED"
  echo "rolling back to previous SHA..."
  ssh hetzner-prod "cd /srv/driftstack-api && git checkout HEAD~1 && npm ci && npm run build && systemctl restart driftstack-api"
  exit 1
fi
```

Rollback constraint: the rollback re-installs node_modules + rebuilds,
which takes 30-90s. During that window, the broken version is live.
Acceptable for pre-launch + early post-launch; revisit when traffic
warrants zero-downtime.

### V-549.C — canary deployment (post-multi-instance)

When the team scales beyond a single instance, canary becomes
meaningful. Until then, V-549.C is design-only.

Sketch: deploy to N-1 instances first; observe error rate for 5
minutes; if error rate stable, deploy to the Nth. If rate spikes,
rollback only the N-1 and leave the Nth on the prior version.

Requires:

- Multi-instance fleet (not yet provisioned).
- Per-instance health-check + automated traffic routing
  (Cloudflare load-balancer rules).
- Time-windowed error-rate signal from Sentry.

Out of scope until V-549.D ships the fleet provisioning + per-
instance routing.

## Schema additions (V-549.B target)

Optional: a `deploy_log` table to track each deploy + outcome:

```sql
CREATE TABLE deploy_log (
  id              uuid PRIMARY KEY,
  deployed_at     timestamptz NOT NULL DEFAULT now(),
  deployed_sha    text NOT NULL,
  rolled_back_to  text,
  outcome         text NOT NULL,  -- 'success' | 'rolled_back' | 'manual_recovery'
  failure_reason  text,

  INDEX deploy_log_deployed_at_idx (deployed_at DESC)
);
```

Populated by the deploy workflow via a one-shot admin API call after
each deploy. Surfaces to the admin overview page.

## Rollback safety

Automated rollback runs `git checkout HEAD~1` from the deploy
workflow. Risks:

1. **Migration mismatch.** If the deploy added a Drizzle migration,
   rolling back the code while leaving the schema migrated may
   surface "column not found" errors against the old code. Mitigation:
   never automate rollback past a migration boundary. The deploy
   workflow detects this case (`git diff HEAD HEAD~1 --
apps/server/src/db/migrations/`) and refuses auto-rollback;
   triggers a manual-rollback alert instead.
2. **Config drift.** Env vars added in the new deploy may break the
   rolled-back version. Mitigation: env-var changes go through a
   separate workflow (`.github/workflows/env-update.yml`) — they
   never co-deploy with code.
3. **State write before rollback.** The broken version may have
   written DB state that the rolled-back version doesn't understand.
   Mitigation: the 30s health-check window means at most 30s of
   traffic hits the broken version. State writes during that window
   are small but possible; the rolled-back version should be
   tolerant of any state shape from N-1 OR N.

## Open questions for team review

1. **Auto-rollback default.** Always-auto-rollback on health failure
   (current proposal) OR alert-only and require manual confirmation?
   Recommendation: always-auto for first 6 months; revisit if
   auto-rollback ever rolls back a transient blip incorrectly.
2. **Deploy frequency cap.** Cap N deploys/day to prevent thrashing
   if multiple changes ship within minutes of each other?
   Recommendation: no cap pre-launch (low volume); add a 5-min
   debounce post-launch.
3. **Deploy notification.** Slack-style notification of each
   deploy + outcome? Recommendation: yes, but post-launch only;
   pre-launch the team is small enough to read git push events.

## Sub-slices

- **V-549.A** — pre-deploy smoke in the workflow YAML.
- **V-549.B** — post-deploy health check + auto-rollback + deploy_log
  schema + migration-boundary detection.
- **V-549.C** — canary deployment (gated on V-549.D fleet
  provisioning).
- **V-549.D** — multi-instance fleet provisioning + Cloudflare load
  balancer rules. Major infra slice; out of scope for any single
  wave.

## Verification

- File written.
- Cross-references V-278 deploy workflow + V-510 DR rehearse.
- V-205 + V-211 sweep: zero hits.
