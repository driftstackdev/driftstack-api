// W564.A — drift guard for /docs/internal/v549-deployment-pipeline-hardening.md.
// V-549 DESIGN doc 2026-05-11 Wave-24. Drift here either weakens the
// V-549.A pre-deploy smoke + V-549.B post-deploy auto-rollback +
// V-549.C canary-post-multi-instance hardening layers, drops the
// migration-mismatch rollback safety, or unsets the V-660-Wave-46
// implementation status.
//
//   • V-549. DESIGN. Pre-paid-traffic deploy hardening.
//   • V-549.A pre-deploy smoke (2 curls; abort if /health unhealthy).
//   • V-549.B post-deploy 30s-wait + auto-rollback to HEAD~1.
//   • V-549.C canary (gated on V-549.D multi-instance fleet).
//   • V-549.A+B landed via V-660 Wave-46 in server-deploy.yml.
//   • 3 rollback risks: migration-mismatch + config-drift + state-
//     write-before-rollback.
//   • deploy_log table (optional V-549.B).
//   • 3 open questions + 4 sub-slice V-549.A-D.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/internal/v549-deployment-pipeline-hardening.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W564.A /docs/internal/v549-deployment-pipeline-hardening.md content parity', () => {
  const body = read(LIB);

  it("Header + V-549-DESIGN-Wave-24 + V-278-current + 4-gap framing pinned: '# V-549 — deployment pipeline hardening' + '**Date:** 2026-05-11' + '**Wave:** 24' + '**Status:** DESIGN — current pipeline ships changes via GitHub Actions' + 'deploy.yml (V-278). V-549 designs the next-layer hardening before paid' + '`.github/workflows/server-deploy.yml` (V-278):' + 'On push to `main`: trigger build.' + 'typecheck + lint + tests.' + 'SSH to Hetzner instance + `git pull` + `npm ci` + `npm run build`' + 'restart server process via the existing systemd unit.' + 'No pre-deploy smoke test against the live target.' + 'No canary; full traffic cuts over immediately.' + 'No automated rollback on post-deploy health-check failure.' + 'Manual SSH access required for rollback.' + '**Implementation status:** V-549.A + V-549.B landed via V-660 (Wave 46)' — pinned so the V-549-DESIGN-Wave-24-2026-05-11 + V-278-server-deploy.yml + Hetzner-SSH-systemd-restart + 4-gap (no-pre-smoke + no-canary + no-auto-rollback + manual-SSH) + V-549.A+B-landed-V-660-Wave-46 + V-549.C-design-only commitment survives", () => {
    expect(body).toMatch(/^# V-549 — deployment pipeline hardening$/m);
    expect(body).toMatch(/\*\*Date:\*\* 2026-05-11/);
    expect(body).toMatch(/\*\*Wave:\*\* 24/);
    expect(body).toMatch(
      /\*\*Status:\*\* DESIGN — current pipeline ships changes via GitHub Actions/,
    );
    expect(body).toMatch(
      /deploy\.yml \(V-278\)\. V-549 designs the next-layer hardening before paid/,
    );
    expect(body).toMatch(/`\.github\/workflows\/server-deploy\.yml` \(V-278\):/);
    expect(body).toMatch(/1\. On push to `main`: trigger build\./);
    expect(body).toMatch(/2\. typecheck \+ lint \+ tests\./);
    expect(body).toMatch(
      /3\. SSH to Hetzner instance \+ `git pull` \+ `npm ci` \+ `npm run build`/,
    );
    expect(body).toMatch(/restart server process via the existing systemd unit\./);
    expect(body).toMatch(/- No pre-deploy smoke test against the live target\./);
    expect(body).toMatch(/- No canary; full traffic cuts over immediately\./);
    expect(body).toMatch(/- No automated rollback on post-deploy health-check failure\./);
    expect(body).toMatch(/- Manual SSH access required for rollback\./);
    expect(body).toMatch(
      /\*\*Implementation status:\*\* V-549\.A \+ V-549\.B landed via V-660 \(Wave 46\)/,
    );
  });

  it("V-549.A pre-deploy smoke + V-549.B post-deploy rollback + V-549.C canary framing pinned: '### V-549.A — pre-deploy smoke' + 'curl --fail --max-time 5 https://api.driftstack.dev/health' + 'curl --fail --max-time 5 https://api.driftstack.dev/openapi.json' + 'jq '.openapi' | grep -q '^\"3.1'' + 'If the production target is unhealthy _before_ deploy, abort' + '### V-549.B — post-deploy health-check + auto-rollback' + 'sleep 30' + 'if ! curl --fail --max-time 5 https://api.driftstack.dev/health; then' + 'echo \"post-deploy health check FAILED\"' + 'echo \"rolling back to previous SHA...\"' + 'ssh hetzner-prod \"cd /srv/driftstack-api && git checkout HEAD~1' + 'systemctl restart driftstack-api' + 'Rollback constraint: the rollback re-installs node_modules + rebuilds,' + 'which takes 30-90s. During that window, the broken version is live.' + '### V-549.C — canary deployment (post-multi-instance)' + 'Sketch: deploy to N-1 instances first; observe error rate for 5' + 'minutes' + 'Multi-instance fleet (not yet provisioned).' + 'Per-instance health-check + automated traffic routing' + '(Cloudflare load-balancer rules).' + 'Time-windowed error-rate signal from Sentry.' + 'Out of scope until V-549.D ships the fleet provisioning' — pinned so the V-549.A-2-curl-/health-openapi-3.1 + V-549.B-sleep-30-HEAD~1-checkout + 30-90s-broken-window + V-549.C-N-1-canary-5-min + 3-requires (multi-instance + Cloudflare-LB + Sentry-error-rate) + V-549.D-out-of-scope commitment survives", () => {
    expect(body).toMatch(/### V-549\.A — pre-deploy smoke/);
    expect(body).toMatch(/curl --fail --max-time 5 https:\/\/api\.driftstack\.dev\/health/);
    expect(body).toMatch(/curl --fail --max-time 5 https:\/\/api\.driftstack\.dev\/openapi\.json/);
    expect(body).toMatch(/jq '\.openapi' \| grep -q '\^"3\.1'/);
    expect(body).toMatch(/If the production target is unhealthy _before_ deploy, abort/);
    expect(body).toMatch(/### V-549\.B — post-deploy health-check \+ auto-rollback/);
    expect(body).toMatch(/sleep 30/);
    expect(body).toMatch(
      /if ! curl --fail --max-time 5 https:\/\/api\.driftstack\.dev\/health; then/,
    );
    expect(body).toMatch(/echo "post-deploy health check FAILED"/);
    expect(body).toMatch(/echo "rolling back to previous SHA\.\.\."/);
    expect(body).toMatch(/ssh hetzner-prod "cd \/srv\/driftstack-api && git checkout HEAD~1/);
    expect(body).toMatch(/systemctl restart driftstack-api/);
    expect(body).toMatch(/Rollback constraint: the rollback re-installs node_modules \+ rebuilds,/);
    expect(body).toMatch(/which takes 30-90s\. During that window, the broken version is live\./);
    expect(body).toMatch(/### V-549\.C — canary deployment \(post-multi-instance\)/);
    expect(body).toMatch(/Sketch: deploy to N-1 instances first; observe error rate for 5/);
    expect(body).toMatch(/minutes/);
    expect(body).toMatch(/- Multi-instance fleet \(not yet provisioned\)\./);
    expect(body).toMatch(/- Per-instance health-check \+ automated traffic routing/);
    expect(body).toMatch(/\(Cloudflare load-balancer rules\)\./);
    expect(body).toMatch(/- Time-windowed error-rate signal from Sentry\./);
    expect(body).toMatch(/Out of scope until V-549\.D ships the fleet provisioning/);
  });

  it("deploy_log + 3-rollback-risk + 3-open-question + 4-sub-slice framing pinned: '## Schema additions (V-549.B target)' + 'Optional: a `deploy_log` table to track each deploy + outcome' + 'CREATE TABLE deploy_log' + 'outcome         text NOT NULL,  -- 'success' | 'rolled_back' | 'manual_recovery'' + '## Rollback safety' + '**Migration mismatch.** If the deploy added a Drizzle migration,' + 'never automate rollback past a migration boundary.' + '`git diff HEAD HEAD~1 -- apps/server/src/db/migrations/`' + '**Config drift.** Env vars added in the new deploy may break the' + '`.github/workflows/env-update.yml`' + 'they never co-deploy with code.' + '**State write before rollback.** The broken version may have' + 'the 30s health-check window means at most 30s of' + '## Open questions for team review' + '**Auto-rollback default.** Always-auto-rollback on health failure' + '**Deploy frequency cap.** Cap N deploys/day to prevent thrashing' + 'add a 5-min debounce post-launch.' + '**Deploy notification.** Slack-style notification of each' + '## Sub-slices' + '**V-549.A** — pre-deploy smoke in the workflow YAML.' + '**V-549.B** — post-deploy health check + auto-rollback + deploy_log' + '**V-549.C** — canary deployment (gated on V-549.D fleet' + '**V-549.D** — multi-instance fleet provisioning + Cloudflare load' + 'V-205 + V-211 sweep: zero hits.' — pinned so the deploy_log-table + 3-outcome (success+rolled_back+manual_recovery) + 3-rollback-risk (migration-mismatch-detection + config-drift-env-update.yml + state-write-30s-tolerance) + 3-open-question (always-auto-rollback + no-cap-pre-launch-5-min-debounce + Slack-post-launch) + 4-sub-slice + V-205+V-211-zero-hits commitment survives", () => {
    expect(body).toMatch(/## Schema additions \(V-549\.B target\)/);
    expect(body).toMatch(/Optional: a `deploy_log` table to track each deploy \+ outcome/);
    expect(body).toMatch(/CREATE TABLE deploy_log/);
    expect(body).toMatch(
      /outcome\s+text NOT NULL,\s+-- 'success' \| 'rolled_back' \| 'manual_recovery'/,
    );
    expect(body).toMatch(/## Rollback safety/);
    expect(body).toMatch(
      /1\. \*\*Migration mismatch\.\*\* If the deploy added a Drizzle migration,/,
    );
    expect(body).toMatch(/never automate rollback past a migration boundary\./);
    expect(body).toMatch(/`git diff HEAD HEAD~1 --\s*apps\/server\/src\/db\/migrations\/`/);
    expect(body).toMatch(
      /2\. \*\*Config drift\.\*\* Env vars added in the new deploy may break the/,
    );
    expect(body).toMatch(/`\.github\/workflows\/env-update\.yml`/);
    expect(body).toMatch(/they\s*never co-deploy with code\./);
    expect(body).toMatch(/3\. \*\*State write before rollback\.\*\* The broken version may have/);
    expect(body).toMatch(/the 30s health-check window means at most 30s of/);
    expect(body).toMatch(/## Open questions for team review/);
    expect(body).toMatch(
      /1\. \*\*Auto-rollback default\.\*\* Always-auto-rollback on health failure/,
    );
    expect(body).toMatch(
      /2\. \*\*Deploy frequency cap\.\*\* Cap N deploys\/day to prevent thrashing/,
    );
    expect(body).toMatch(/add a 5-min\s*debounce post-launch\./);
    expect(body).toMatch(/3\. \*\*Deploy notification\.\*\* Slack-style notification of each/);
    expect(body).toMatch(/## Sub-slices/);
    expect(body).toMatch(/- \*\*V-549\.A\*\* — pre-deploy smoke in the workflow YAML\./);
    expect(body).toMatch(
      /- \*\*V-549\.B\*\* — post-deploy health check \+ auto-rollback \+ deploy_log/,
    );
    expect(body).toMatch(/- \*\*V-549\.C\*\* — canary deployment \(gated on V-549\.D fleet/);
    expect(body).toMatch(
      /- \*\*V-549\.D\*\* — multi-instance fleet provisioning \+ Cloudflare load/,
    );
    expect(body).toMatch(/- V-205 \+ V-211 sweep: zero hits\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
