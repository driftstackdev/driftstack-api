// W724 — GitHub Actions deploy.yml workflow parity. Fifty-first in
// the cross-SDK drift-guard series (W649 + W675-W724).
//
// Pins .github/workflows/deploy.yml as the authoritative deploy
// pipeline (Workstream A spec V-051):
//
//   build-image → deploy-staging → deploy-production
//
// CRITICAL invariants:
//   1. build-image builds + pushes to ghcr.io/<owner>/driftstack-api
//      tagged with short-SHA + latest.
//   2. deploy-staging is automatic (no approval gate); deploy-
//      production requires the GitHub-environment "production"
//      approver-list ack.
//   3. V-278 secret-gate: skip cleanly when Hetzner secrets aren't
//      populated (fresh repo / pre-provisioning state).
//   4. Health-check loop after deploy: 10 attempts, 3s sleep, against
//      http://127.0.0.1:7780/health.
//   5. Sentry source-map upload step is a no-op when SENTRY_AUTH
//      _TOKEN is unset (don't fail the deploy on missing secret).
//   6. concurrency: cancel-in-progress: false (deploys never
//      cancel in flight — partial deploys are worse than queued).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const DEPLOY = resolve(REPO_ROOT, '.github/workflows/deploy.yml');

describe('W724 GitHub Actions deploy.yml workflow parity', () => {
  it('deploy.yml file exists', () => {
    expect(existsSync(DEPLOY), `missing ${DEPLOY}`).toBe(true);
  });

  it('CRITICAL V-051 Workstream A anchor pinned in deploy.yml header. The anchor threads the deploy-pipeline provenance.', () => {
    const d = read(DEPLOY);
    expect(d).toMatch(/Per Workstream A spec \(V-051\)/);
    expect(d).toMatch(/Hetzner Cloud VMs \(CCX13 default — 4 vCPU, 16GB RAM, €25\/mo\)/);
    expect(d).toMatch(/systemd \+ docker-compose orchestration on the host/);
    expect(d).toMatch(/Image pushed to ghcr\.io\/driftstackdev\/driftstack-api/);
  });

  it('CRITICAL trigger surface pinned — push:[main] + workflow_dispatch. The dispatch trigger lets a deploy re-fire manually after secrets are populated; drift to dropping would lock out the V-278 secret-gate recovery path.', () => {
    const d = read(DEPLOY);
    expect(d).toMatch(/on:\s*\n\s*push:\s*\n\s*branches: \[main\]\s*\n\s*workflow_dispatch:/);
  });

  it('CRITICAL deploy concurrency `cancel-in-progress: false` pinned. Unlike CI (where stale runs should be cancelled), deploy jobs MUST complete — drift to true would let a new commit kill an in-flight deploy mid-rollout (partial state).', () => {
    const d = read(DEPLOY);
    expect(d).toMatch(
      /concurrency:\s*\n\s*group: deploy-\$\{\{ github\.ref \}\}\s*\n\s*cancel-in-progress: false/,
    );
  });

  it('CRITICAL 3-job sequence pinned — build-image → deploy-staging → deploy-production. Drift to running in parallel or skipping the staging gate would let production deploys bypass the staging-health validation.', () => {
    const d = read(DEPLOY);

    expect(d).toMatch(/^\s{2}build-image:/m);
    expect(d).toMatch(
      /^\s{2}deploy-staging:\s*\n\s*name: Deploy to staging\s*\n\s*needs: build-image/m,
    );
    expect(d).toMatch(
      /^\s{2}deploy-production:\s*\n\s*name: Deploy to production \(manual approval\)\s*\n\s*needs: \[build-image, deploy-staging\]/m,
    );
  });

  it('CRITICAL build-image permissions pinned — `contents: read` + `packages: write`. The narrow scope is what lets the job push to ghcr.io without expanding the default token surface. Drift to wider permissions would over-scope the job.', () => {
    const d = read(DEPLOY);
    expect(d).toMatch(/permissions:\s*\n\s*contents: read\s*\n\s*packages: write/);
  });

  it('CRITICAL build-image tags 2 images: short-SHA + `:latest`. The short-SHA is what deploy-staging/production reference (immutable per-commit); the `:latest` tag is what hand-rolled docker-compose pulls on fresh provisioning.', () => {
    const d = read(DEPLOY);

    expect(d).toMatch(/SHORT_SHA="\$\{GITHUB_SHA::7\}"/);
    expect(d).toMatch(
      /IMAGE="ghcr\.io\/\$\{\{ github\.repository_owner \}\}\/driftstack-api:\$\{SHORT_SHA\}"/,
    );
    expect(d).toMatch(
      /\$\{\{ steps\.meta\.outputs\.image-tag \}\}\s*\n\s*ghcr\.io\/\$\{\{ github\.repository_owner \}\}\/driftstack-api:latest/,
    );
  });

  it('CRITICAL Docker buildx + GHCR login + build-push-action chain pinned. Drift to dropping buildx would lose cross-arch + cache support; drift to a different registry login action would break the credentials chain.', () => {
    const d = read(DEPLOY);

    expect(d).toMatch(/uses: docker\/setup-buildx-action@v3/);
    expect(d).toMatch(/uses: docker\/login-action@v3/);
    expect(d).toMatch(/registry: ghcr\.io/);
    expect(d).toMatch(/password: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    expect(d).toMatch(/uses: docker\/build-push-action@v6/);
  });

  it('CRITICAL build-push uses Dockerfile at apps/server/Dockerfile + push: true + cache type=gha. The cache-from/cache-to=gha is what makes cold builds < 1 min on Github-hosted runners.', () => {
    const d = read(DEPLOY);

    expect(d).toMatch(/file: \.\/apps\/server\/Dockerfile/);
    expect(d).toMatch(/push: true/);
    expect(d).toMatch(/cache-from: type=gha/);
    expect(d).toMatch(/cache-to: type=gha,mode=max/);
  });

  it('CRITICAL SENTRY_RELEASE = github.sha build-arg pinned. The full SHA (not short-SHA) is what Sentry uses to correlate source-maps with this exact release. Drift to a different identifier would break source-map matching.', () => {
    const d = read(DEPLOY);
    expect(d).toMatch(/SENTRY_RELEASE=\$\{\{ github\.sha \}\}/);
  });

  it('CRITICAL Sentry source-map upload is NO-OP when SENTRY_AUTH_TOKEN is unset. Drift to failing the deploy on missing token would block initial repo setup; the no-op + diagnostic message is what lets the build succeed pre-secret.', () => {
    const d = read(DEPLOY);

    expect(d).toMatch(
      /if \[ -z "\$\{SENTRY_AUTH_TOKEN\}" \]; then\s*\n\s*echo "SENTRY_AUTH_TOKEN unset — skipping source-map upload\."/,
    );
    expect(d).toMatch(
      /Runtime still works; stack traces will be minified until the secret is populated/,
    );
    expect(d).toMatch(/exit 0/);
  });

  it('CRITICAL Sentry-cli pinned to @sentry/cli@^2 + `releases new` + `sourcemaps upload` + `releases finalize` + `releases set-commits --auto` chain. Drift to skipping `finalize` would let the release stay in pending state on Sentry forever.', () => {
    const d = read(DEPLOY);

    expect(d).toMatch(/npx --yes @sentry\/cli@\^2 releases new "\$\{SENTRY_RELEASE\}"/);
    expect(d).toMatch(/npx --yes @sentry\/cli@\^2 sourcemaps upload/);
    expect(d).toMatch(/--url-prefix="app:\/\/\/apps\/server\/dist"/);
    expect(d).toMatch(/apps\/server\/dist/);
    expect(d).toMatch(/npx --yes @sentry\/cli@\^2 releases finalize "\$\{SENTRY_RELEASE\}"/);
    expect(d).toMatch(
      /npx --yes @sentry\/cli@\^2 releases set-commits "\$\{SENTRY_RELEASE\}" --auto \|\| true/,
    );
  });

  it('CRITICAL V-278 secret-gate skip-clean framing pinned. The skip-cleanly path is what lets fresh repos build images even before Hetzner secrets land — drift to failing the job would block all initial deploys.', () => {
    const d = read(DEPLOY);

    expect(d).toMatch(/V-278 — skip cleanly when Hetzner secrets aren't populated yet/);
    expect(d).toMatch(/fresh repo, pre-provisioning state/);
    expect(d).toMatch(
      /See docs\/founder-actions\/v278-hetzner-deploy-keys\.md to populate secrets/,
    );
  });

  it('CRITICAL Hetzner secret-gate 4-secret check pinned — HETZNER_HOST + HETZNER_USER + HETZNER_SSH_KEY + DEPLOY_DOTENV_BASE64. Drift to dropping any check would let the SSH-action fire with a missing arg (cryptic failure).', () => {
    const d = read(DEPLOY);

    // Check appears in both deploy-staging + deploy-production.
    const checks = (
      d.match(
        /if \[ -z "\$HETZNER_HOST" \] \|\| \[ -z "\$HETZNER_USER" \] \|\| \[ -z "\$HETZNER_SSH_KEY" \] \|\| \[ -z "\$DEPLOY_DOTENV_BASE64" \]; then/g,
      ) ?? []
    ).length;
    expect(checks, '4-secret gate checks').toBe(2);
  });

  it('CRITICAL appleboy/ssh-action@v1 pinned for both staging + production deploys. Drift to a different SSH action would change the authentication shape; the v1 major-version pin is what prevents floating-version drift.', () => {
    const d = read(DEPLOY);

    const sshActions = (d.match(/uses: appleboy\/ssh-action@v1/g) ?? []).length;
    expect(sshActions, 'appleboy/ssh-action@v1 references').toBe(2);
  });

  it('CRITICAL deploy SSH script uses `set -euo pipefail` + `cd /opt/driftstack` + base64-decode .env + docker compose pull + docker compose up -d --remove-orphans. The strict-mode + canonical deploy-dir + remove-orphans flag is what guarantees consistent state.', () => {
    const d = read(DEPLOY);

    // Pattern appears in both staging + production scripts.
    const strictModes = (d.match(/set -euo pipefail/g) ?? []).length;
    expect(strictModes, 'set -euo pipefail in SSH scripts').toBe(2);

    const cdDirs = (d.match(/cd \/opt\/driftstack/g) ?? []).length;
    expect(cdDirs, 'cd /opt/driftstack invocations').toBe(2);

    const base64Decodes = (
      d.match(/echo "\$\{\{ secrets\.DEPLOY_DOTENV_BASE64 \}\}" \| base64 -d > \.env/g) ?? []
    ).length;
    expect(base64Decodes, 'base64-decoded .env writes').toBe(2);

    expect(d).toMatch(/docker compose pull/);
    expect(d).toMatch(/docker compose up -d --remove-orphans/);
  });

  it('CRITICAL /health smoke-test loop pinned — 10 attempts × 3s sleep against http://127.0.0.1:7780/health. The 10-attempt × 3-second loop gives 30 seconds for container startup; drift to fewer attempts would flake on slow images.', () => {
    const d = read(DEPLOY);

    // Loop appears in both staging + production scripts.
    const loops = (d.match(/for i in 1 2 3 4 5 6 7 8 9 10; do/g) ?? []).length;
    expect(loops, '/health smoke-test loops').toBe(2);

    const healthCurls = (
      d.match(/curl -fsS http:\/\/127\.0\.0\.1:7780\/health > \/dev\/null/g) ?? []
    ).length;
    expect(healthCurls, 'curl /health invocations').toBe(2);

    const sleeps = (d.match(/sleep 3/g) ?? []).length;
    expect(sleeps, '3-second sleeps').toBe(2);
  });

  it('CRITICAL deploy-staging environment URL `api.staging.driftstack.dev` + deploy-production environment URL `api.driftstack.dev` pinned. The environment URLs surface in the GitHub deploy dashboard; drift would break the deploy-history breadcrumb trail.', () => {
    const d = read(DEPLOY);

    expect(d).toMatch(
      /environment:\s*\n\s*name: staging\s*\n\s*url: https:\/\/api\.staging\.driftstack\.dev/,
    );
    expect(d).toMatch(
      /environment:\s*\n\s*name: production\s*\n\s*url: https:\/\/api\.driftstack\.dev/,
    );
  });

  it('CRITICAL "production" GitHub-environment approval gate framing pinned. The "configured in repo settings to require approval from the founder" framing tells engineers the approval is enforced server-side by GitHub, NOT by a job-level check.', () => {
    const d = read(DEPLOY);
    expect(d).toMatch(/The "production" environment is configured in repo settings to/);
    expect(d).toMatch(/require approval from the founder before this job runs/);
  });

  it('CRITICAL 4 GitHub secrets documented per-environment + 3 repo-wide Sentry secrets. Drift to dropping a doc entry would let a future operator forget to populate a secret (and surface as a cryptic deploy failure).', () => {
    const d = read(DEPLOY);

    // 4 per-env secrets.
    expect(d).toMatch(/HETZNER_HOST/);
    expect(d).toMatch(/HETZNER_USER/);
    expect(d).toMatch(/HETZNER_SSH_KEY/);
    expect(d).toMatch(/DEPLOY_DOTENV_BASE64/);

    // 3 repo-wide.
    expect(d).toMatch(/SENTRY_AUTH_TOKEN/);
    expect(d).toMatch(/SENTRY_ORG/);
    expect(d).toMatch(/SENTRY_PROJECT/);
  });

  it('CRITICAL doc list of expected .env contents — DATABASE_URL + REDIS_URL + R2_* + POSTMARK_* + SENTRY_DSN + STRIPE_* . Drift to dropping the manifest would let an operator forget a credential at provisioning.', () => {
    const d = read(DEPLOY);
    expect(d).toMatch(/DATABASE_URL, REDIS_URL, R2_\*, POSTMARK_\*,/);
    expect(d).toMatch(/SENTRY_DSN, STRIPE_\*, etc/);
  });

  it('Deploy workflow 7-invariant cluster — V-051 Workstream A + 3-job sequence + V-278 secret-gate + Sentry-no-op-on-missing-token + /health smoke loop + cancel-in-progress: false + appleboy/ssh-action@v1.', () => {
    const d = read(DEPLOY);

    expect(d).toMatch(/V-051/);
    expect(d).toMatch(/build-image:/);
    expect(d).toMatch(/deploy-staging:/);
    expect(d).toMatch(/deploy-production:/);
    expect(d).toMatch(/V-278/);
    expect(d).toMatch(/SENTRY_AUTH_TOKEN unset/);
    expect(d).toMatch(/\/health/);
    expect(d).toMatch(/cancel-in-progress: false/);
    expect(d).toMatch(/appleboy\/ssh-action@v1/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/server/tests/unit/deploy-workflow-parity.test.ts')),
    ).toBe(true);
  });
});
