// W542.A — drift guard for /.github/workflows/deploy.yml.
// V-051 Hetzner deploy pipeline (CCX13 / Docker / systemd). Drift
// here either drops the staging-auto + production-manual-approval
// gating (would let unreviewed prod deploys land), drops the
// /health 10-attempt smoke loop (would let a broken container land
// as "deployed"), changes the GHCR image path (would break the
// docker-compose pull on the host), or drops the V-278 graceful
// no-op when secrets are unset (would fail every fresh-repo CI run
// during the pre-provisioning window).
//
//   • Two-environment flow: staging auto on main merge, production
//     manual-approval via GitHub environment.
//   • V-051 anchor: Hetzner CCX13 + systemd + docker-compose +
//     ghcr.io/driftstackdev/driftstack-api + /health post-deploy.
//   • 4 required per-env secrets: HETZNER_HOST + HETZNER_USER +
//     HETZNER_SSH_KEY + DEPLOY_DOTENV_BASE64.
//   • 3 repo-wide secrets: SENTRY_AUTH_TOKEN + SENTRY_ORG +
//     SENTRY_PROJECT.
//   • Sentry source-map upload step with graceful unset-token skip.
//   • 10-attempt /health curl loop with 3s sleep + exit 1 on
//     never-ready.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, '.github/workflows/deploy.yml');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W542.A /.github/workflows/deploy.yml content parity', () => {
  const body = read(LIB);

  it("Header + V-051 + two-env flow framing pinned: '# Driftstack API — deploy pipeline.' + '# Two-environment flow:' + '#   - Staging deploy auto-fires on main merge. No approval gate.' + '#   - Production deploy is a manual job that requires the' + '#     \"production\" GitHub environment's approver list to ack.' + '# Per Workstream A spec (V-051):' + '#   - Hetzner Cloud VMs (CCX13 default — 4 vCPU, 16GB RAM, €25/mo).' + '#   - systemd + docker-compose orchestration on the host.' + '#   - Image pushed to ghcr.io/driftstackdev/driftstack-api.' + '#   - Smoke test against /health post-deploy.' — pinned so the V-051 + CCX13 4vCPU/16GB/€25mo + systemd-docker-compose + GHCR-driftstackdev image-path + /health-post-deploy + staging-auto/prod-manual-approval-gate commitment survives (drift to dropping the prod-manual-gate would allow unreviewed prod deploys; drift to a different GHCR path would break docker-compose pull on host)", () => {
    expect(body).toMatch(/# Driftstack API — deploy pipeline\./);
    expect(body).toMatch(/# Two-environment flow:/);
    expect(body).toMatch(/#\s+- Staging deploy auto-fires on main merge\. No approval gate\./);
    expect(body).toMatch(/#\s+- Production deploy is a manual job that requires the/);
    expect(body).toMatch(/#\s+"production" GitHub environment's approver list to ack\./);
    expect(body).toMatch(/# Per Workstream A spec \(V-051\):/);
    expect(body).toMatch(/#\s+- Hetzner Cloud VMs \(CCX13 default — 4 vCPU, 16GB RAM, €25\/mo\)\./);
    expect(body).toMatch(/#\s+- systemd \+ docker-compose orchestration on the host\./);
    expect(body).toMatch(/#\s+- Image pushed to ghcr\.io\/driftstackdev\/driftstack-api\./);
    expect(body).toMatch(/#\s+- Smoke test against \/health post-deploy\./);
  });

  it("4 per-env Hetzner secret + 3 repo-wide Sentry secret framing pinned: '# Required GitHub secrets (per environment):' + '#   - HETZNER_HOST         — IP or hostname of the Hetzner VM.' + '#   - HETZNER_USER         — SSH user (typically `driftstack`).' + '#   - HETZNER_SSH_KEY      — private key, deploy-scoped.' + '#   - DEPLOY_DOTENV_BASE64 — base64-encoded .env file dropped at' + '/opt/driftstack/.env on the VM' + '# Required repository-wide secrets (not per-environment):' + '#   - SENTRY_AUTH_TOKEN' + '#   - SENTRY_ORG' + '#   - SENTRY_PROJECT' — pinned so the 4-per-env-Hetzner-secret + 3-repo-wide-Sentry-secret + /opt/driftstack/.env drop-path + Sentry-auth-token-source-map-upload commitment survives", () => {
    expect(body).toMatch(/# Required GitHub secrets \(per environment\):/);
    expect(body).toMatch(/#\s+- HETZNER_HOST\s+— IP or hostname of the Hetzner VM\./);
    expect(body).toMatch(/#\s+- HETZNER_USER\s+— SSH user \(typically `driftstack`\)\./);
    expect(body).toMatch(/#\s+- HETZNER_SSH_KEY\s+— private key, deploy-scoped\./);
    expect(body).toMatch(/#\s+- DEPLOY_DOTENV_BASE64 — base64-encoded \.env file dropped at/);
    expect(body).toMatch(/\/opt\/driftstack\/\.env on the VM/);
    expect(body).toMatch(/# Required repository-wide secrets \(not per-environment\):/);
    expect(body).toMatch(/#\s+- SENTRY_AUTH_TOKEN/);
    expect(body).toMatch(/#\s+- SENTRY_ORG\s+— Sentry organization slug\./);
    expect(body).toMatch(/#\s+- SENTRY_PROJECT\s+— Sentry project slug for driftstack-api\./);
  });

  it("Trigger + concurrency framing pinned: 'name: Deploy' + 'on: push: branches: [main] + workflow_dispatch' + 'concurrency: group: deploy-${{ github.ref }} + cancel-in-progress: false' — pinned so the main-push + manual-dispatch + per-ref-deploy-concurrency + cancel-in-progress: FALSE (let in-flight deploys finish — never cancel a deploy mid-flight) commitment survives (drift to cancel-in-progress: true on a deploy would corrupt /opt/driftstack state if a newer push arrives mid-deploy)", () => {
    expect(body).toMatch(/^name: Deploy$/m);
    expect(body).toMatch(/on:\s*\n\s*push:\s*\n\s*branches: \[main\]\s*\n\s*workflow_dispatch:/);
    expect(body).toMatch(
      /concurrency:\s*\n\s*group: deploy-\$\{\{ github\.ref \}\}\s*\n\s*cancel-in-progress: false/,
    );
  });

  it("build-image job + GHCR + docker/build-push framing pinned: 'build-image: Build + push Docker image' + 'permissions: contents: read + packages: write' + 'docker/setup-buildx-action@v3' + 'docker/login-action@v3 with registry: ghcr.io + username: ${{ github.actor }} + password: GITHUB_TOKEN' + 'docker/build-push-action@v6 with context: . + file: ./apps/server/Dockerfile + push: true + tags: image-tag + ghcr.io/${{ github.repository_owner }}/driftstack-api:latest + build-args: SENTRY_RELEASE=${{ github.sha }} + cache-from: type=gha + cache-to: type=gha,mode=max' — pinned so the contents:read+packages:write (minimal-blast-radius) + GHCR-login + Dockerfile-from-apps/server + 2-tag-push (sha + latest) + SENTRY_RELEASE-as-github.sha + GHA-cache commitment survives", () => {
    expect(body).toMatch(/build-image:/);
    expect(body).toMatch(/name: Build \+ push Docker image/);
    expect(body).toMatch(/permissions:\s*\n\s*contents: read\s*\n\s*packages: write/);
    expect(body).toMatch(/uses: docker\/setup-buildx-action@v3/);
    expect(body).toMatch(/uses: docker\/login-action@v3/);
    expect(body).toMatch(/registry: ghcr\.io/);
    expect(body).toMatch(/username: \$\{\{ github\.actor \}\}/);
    expect(body).toMatch(/password: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
    expect(body).toMatch(/uses: docker\/build-push-action@v6/);
    expect(body).toMatch(/context: \./);
    expect(body).toMatch(/file: \.\/apps\/server\/Dockerfile/);
    expect(body).toMatch(/push: true/);
    expect(body).toMatch(/ghcr\.io\/\$\{\{ github\.repository_owner \}\}\/driftstack-api:latest/);
    expect(body).toMatch(/SENTRY_RELEASE=\$\{\{ github\.sha \}\}/);
    expect(body).toMatch(/cache-from: type=gha/);
    expect(body).toMatch(/cache-to: type=gha,mode=max/);
  });

  it("Sentry source-map upload + graceful-skip framing pinned: '# Sentry source-map upload. Build the server outside Docker so the runner has local dist/*.js.map files to ship to Sentry. The build is deterministic; this dist/ matches what's already been baked into the image we just pushed. The whole step is a no-op if SENTRY_AUTH_TOKEN is unset (e.g. fresh repo without the secret populated yet) — runtime still works, stack traces will be minified until the secret lands.' + 'SENTRY_AUTH_TOKEN unset — skipping source-map upload.' + 'npx --yes @sentry/cli@^2 releases new \"${SENTRY_RELEASE}\"' + 'npx --yes @sentry/cli@^2 sourcemaps upload --release=${SENTRY_RELEASE} --url-prefix=\"app:///apps/server/dist\" apps/server/dist' + 'npx --yes @sentry/cli@^2 releases finalize \"${SENTRY_RELEASE}\"' + 'npx --yes @sentry/cli@^2 releases set-commits \"${SENTRY_RELEASE}\" --auto || true' — pinned so the deterministic-build-outside-docker + graceful-unset-token-skip + 4-step Sentry-CLI sequence (releases new + sourcemaps upload + releases finalize + set-commits --auto) + app:///apps/server/dist url-prefix commitment survives", () => {
    expect(body).toMatch(/# Sentry source-map upload\. Build the server outside Docker so/);
    expect(body).toMatch(/# the runner has local dist\/\*\.js\.map files to ship to Sentry\./);
    expect(body).toMatch(
      /The whole step is a\s*\n\s*#\s*no-op if SENTRY_AUTH_TOKEN is unset \(e\.g\. fresh repo without/,
    );
    expect(body).toMatch(/echo "SENTRY_AUTH_TOKEN unset — skipping source-map upload\."/);
    expect(body).toMatch(/npx --yes @sentry\/cli@\^2 releases new "\$\{SENTRY_RELEASE\}"/);
    expect(body).toMatch(/npx --yes @sentry\/cli@\^2 sourcemaps upload/);
    expect(body).toMatch(/--url-prefix="app:\/\/\/apps\/server\/dist"/);
    expect(body).toMatch(/apps\/server\/dist/);
    expect(body).toMatch(/npx --yes @sentry\/cli@\^2 releases finalize "\$\{SENTRY_RELEASE\}"/);
    expect(body).toMatch(
      /npx --yes @sentry\/cli@\^2 releases set-commits "\$\{SENTRY_RELEASE\}" --auto \|\| true/,
    );
  });

  it("V-278 graceful-no-op-secret-gate + SSH-deploy + 10-attempt /health framing pinned: '# V-278 — skip cleanly when Hetzner secrets aren't populated yet (fresh repo, pre-provisioning state).' + 'if [ -z \"$HETZNER_HOST\" ] || [ -z \"$HETZNER_USER\" ] || [ -z \"$HETZNER_SSH_KEY\" ] || [ -z \"$DEPLOY_DOTENV_BASE64\" ]; then' + 'See docs/founder-actions/v278-hetzner-deploy-keys.md to populate secrets.' + 'appleboy/ssh-action@v1' + 'set -euo pipefail' + 'cd /opt/driftstack' + 'echo \"${{ secrets.DEPLOY_DOTENV_BASE64 }}\" | base64 -d > .env' + 'export IMAGE_TAG=${{ needs.build-image.outputs.image-tag }}' + 'docker compose pull' + 'docker compose up -d --remove-orphans' + '# Wait for /health to come up before declaring success.' + 'for i in 1 2 3 4 5 6 7 8 9 10' + 'if curl -fsS http://127.0.0.1:7780/health > /dev/null; then echo \"staging healthy\"; exit 0; fi' + 'sleep 3' + 'echo \"staging /health never returned 200\" + exit 1' + production env name + url: https://api.driftstack.dev + 'environment: name: production' — pinned so the V-278 4-secret-gate + base64-decode-into-.env + set-euo-pipefail + 10-attempt 7780/health curl with 3s sleep + production-env-binding-to-api.driftstack.dev commitment survives", () => {
    expect(body).toMatch(/# V-278 — skip cleanly when Hetzner secrets aren't populated yet/);
    expect(body).toMatch(/# \(fresh repo, pre-provisioning state\)\./);
    expect(body).toMatch(
      /if \[ -z "\$HETZNER_HOST" \] \|\| \[ -z "\$HETZNER_USER" \] \|\| \[ -z "\$HETZNER_SSH_KEY" \] \|\| \[ -z "\$DEPLOY_DOTENV_BASE64" \]; then/,
    );
    expect(body).toMatch(
      /See docs\/founder-actions\/v278-hetzner-deploy-keys\.md to populate secrets\./,
    );
    expect(body).toMatch(/uses: appleboy\/ssh-action@v1/);
    expect(body).toMatch(/set -euo pipefail/);
    expect(body).toMatch(/cd \/opt\/driftstack/);
    expect(body).toMatch(/echo "\$\{\{ secrets\.DEPLOY_DOTENV_BASE64 \}\}" \| base64 -d > \.env/);
    expect(body).toMatch(/export IMAGE_TAG='\$\{\{ needs\.build-image\.outputs\.image-tag \}\}'/);
    expect(body).toMatch(/docker compose pull/);
    expect(body).toMatch(/docker compose up -d --remove-orphans/);
    expect(body).toMatch(/# Wait for \/health to come up before declaring success\./);
    expect(body).toMatch(/for i in 1 2 3 4 5 6 7 8 9 10; do/);
    expect(body).toMatch(/curl -fsS http:\/\/127\.0\.0\.1:7780\/health > \/dev\/null/);
    expect(body).toMatch(/echo "staging healthy"/);
    expect(body).toMatch(/sleep 3/);
    expect(body).toMatch(/echo "staging \/health never returned 200"/);
    expect(body).toMatch(/name: production/);
    expect(body).toMatch(/url: https:\/\/api\.driftstack\.dev/);
  });

  it("deploy-staging + deploy-production job-dependency framing pinned: 'deploy-staging: needs: build-image + environment: name: staging + url: https://api.staging.driftstack.dev' + 'deploy-production: needs: [build-image, deploy-staging]' + '# The \"production\" environment is configured in repo settings to require approval from the founder before this job runs.' — pinned so the staging-needs-build-image + prod-needs-both-build-image-and-deploy-staging + prod-environment-requires-founder-approval commitment survives (drift to dropping deploy-staging from prod's needs list would let prod deploy without first verifying staging)", () => {
    expect(body).toMatch(/deploy-staging:/);
    expect(body).toMatch(/needs: build-image/);
    expect(body).toMatch(/name: staging/);
    expect(body).toMatch(/url: https:\/\/api\.staging\.driftstack\.dev/);
    expect(body).toMatch(/deploy-production:/);
    expect(body).toMatch(/needs: \[build-image, deploy-staging\]/);
    expect(body).toMatch(/# The "production" environment is configured in repo settings to/);
    expect(body).toMatch(/# require approval from the founder before this job runs\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
