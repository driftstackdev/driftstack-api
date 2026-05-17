// W724 — GitHub Actions deploy.yml workflow parity. REWRITTEN
// 2026-05-17 to mirror Option B verdict (drop Docker, match prod
// systemd+node reality per
// docs/internal/2026-05-16-deploy-yml-verdict-design.md).
//
// Pins `.github/workflows/deploy.yml` as the authoritative deploy
// pipeline (Workstream A spec V-051 — REVISED 2026-05-17):
//
//   source-map-upload → deploy-staging → deploy-production
//
// CRITICAL invariants:
//   1. deploy-bridge.sh is the SOURCE OF TRUTH; both staging + prod
//      jobs invoke it (`bash scripts/deploy-bridge.sh <env>`). Drift
//      to inline-SSH-script would split the two execution paths
//      (operator-manual vs CI-triggered) and cause silent
//      divergence.
//   2. deploy-staging is automatic on main merge (no approval gate);
//      deploy-production requires the GitHub-environment "production"
//      approver-list ack.
//   3. Single Hetzner secret HETZNER_DEPLOY_SSH_KEY — narrower than
//      the old 4-secret docker-compose surface (no DOTENV_BASE64
//      shipped through GH; env stays SSH-write on the host).
//   4. Sentry source-map upload step is a no-op when SENTRY_AUTH_TOKEN
//      is unset (don't fail the deploy on missing secret).
//   5. concurrency: cancel-in-progress: false (deploys never cancel
//      in flight — partial deploys are worse than queued).

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

describe('W724 GitHub Actions deploy.yml workflow parity (Option B verdict)', () => {
  it('deploy.yml file exists', () => {
    expect(existsSync(DEPLOY), `missing ${DEPLOY}`).toBe(true);
  });

  it('CRITICAL Option B verdict anchor pinned in deploy.yml header — drop Docker, match systemd+node prod reality.', () => {
    const d = read(DEPLOY);
    expect(d).toMatch(/Option B verdict 2026-05-17/);
    expect(d).toMatch(/drop Docker, match prod systemd\+node reality/);
    expect(d).toMatch(/scripts\/deploy-bridge\.sh/);
  });

  it('CRITICAL V-051 Workstream A anchor pinned (revised 2026-05-17). The anchor threads the deploy-pipeline provenance.', () => {
    const d = read(DEPLOY);
    expect(d).toMatch(/Per Workstream A spec \(V-051 — REVISED 2026-05-17\)/);
    expect(d).toMatch(/Hetzner Cloud VMs \(CCX13 default — 4 vCPU, 16GB RAM, €25\/mo\)/);
    expect(d).toMatch(/systemd at \/opt\/driftstack\/api on the host/);
  });

  it('CRITICAL trigger surface pinned — push:[main] + workflow_dispatch. The dispatch trigger lets a deploy re-fire manually after secrets are populated.', () => {
    const d = read(DEPLOY);
    expect(d).toMatch(/on:\s*\n\s*push:\s*\n\s*branches: \[main\]\s*\n\s*workflow_dispatch:/);
  });

  it('CRITICAL deploy concurrency `cancel-in-progress: false` pinned. Unlike CI, deploy jobs MUST complete — drift to true would let a new commit kill an in-flight deploy mid-rollout (partial state).', () => {
    const d = read(DEPLOY);
    expect(d).toMatch(
      /concurrency:\s*\n\s*group: deploy-\$\{\{ github\.ref \}\}\s*\n\s*cancel-in-progress: false/,
    );
  });

  it('CRITICAL 3-job sequence pinned — source-map-upload → deploy-staging → deploy-production. Drift to running in parallel or skipping the staging gate would let production deploys bypass the staging-health validation.', () => {
    const d = read(DEPLOY);

    expect(d).toMatch(/^\s{2}source-map-upload:/m);
    expect(d).toMatch(
      /^\s{2}deploy-staging:\s*\n\s*name: Deploy to staging \(via deploy-bridge\.sh\)\s*\n\s*needs: source-map-upload/m,
    );
    expect(d).toMatch(
      /^\s{2}deploy-production:\s*\n\s*name: Deploy to production \(manual approval; via deploy-bridge\.sh\)\s*\n\s*needs: \[source-map-upload, deploy-staging\]/m,
    );
  });

  it('CRITICAL source-map-upload permissions pinned — `contents: read`. The narrow scope is what reads the repo for the build step.', () => {
    const d = read(DEPLOY);
    expect(d).toMatch(/permissions:\s*\n\s*contents: read/);
  });

  it('CRITICAL source-map-upload builds the server for Sentry upload only (prod build runs again on the Hetzner host via deploy-bridge.sh).', () => {
    const d = read(DEPLOY);
    expect(d).toMatch(/Build server \(for source-map upload only/);
    expect(d).toMatch(/npm ci --no-audit --include=dev/);
    expect(d).toMatch(/npx tsc --build packages\/api-types/);
    expect(d).toMatch(/npm run build --workspace=@driftstack\/server/);
  });

  it('CRITICAL Sentry source-map upload is NO-OP when SENTRY_AUTH_TOKEN is unset. Drift to failing the deploy on missing token would block initial repo setup.', () => {
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

  it('CRITICAL SENTRY_RELEASE = github.sha pinned. The full SHA (not short-SHA) is what Sentry uses to correlate source-maps with this exact release.', () => {
    const d = read(DEPLOY);
    expect(d).toMatch(/SENTRY_RELEASE: \$\{\{ github\.sha \}\}/);
  });

  it('CRITICAL Hetzner SSH-key secret-gate skip-clean framing pinned. Drift to failing the job would block all initial deploys.', () => {
    const d = read(DEPLOY);
    expect(d).toMatch(/HETZNER_DEPLOY_SSH_KEY not set — skipping deploy/);
    expect(d).toMatch(/See docs\/founder-actions\/v278-hetzner-deploy-keys\.md/);
  });

  it('CRITICAL single Hetzner secret HETZNER_DEPLOY_SSH_KEY pinned (replaces the old 4-secret docker-compose surface). One-secret narrower attack surface — no active DEPLOY_DOTENV_BASE64 secret ref through GH.', () => {
    const d = read(DEPLOY);

    // Appears in both deploy-staging + deploy-production (gate + use).
    const refs = (d.match(/HETZNER_DEPLOY_SSH_KEY/g) ?? []).length;
    expect(refs, 'HETZNER_DEPLOY_SSH_KEY references').toBeGreaterThanOrEqual(4);

    // Active secret refs to the removed names MUST NOT return — header
    // comments may still mention them as "what was removed" context.
    expect(d).not.toMatch(/secrets\.DEPLOY_DOTENV_BASE64/);
    expect(d).not.toMatch(/secrets\.HETZNER_HOST\b/);
    expect(d).not.toMatch(/secrets\.HETZNER_USER\b/);
    expect(d).not.toMatch(/secrets\.HETZNER_SSH_KEY\b/);
  });

  it('CRITICAL deploy-bridge.sh is the source-of-truth invocation for both envs — drift to inline SSH scripts would split execution paths (operator-manual vs CI-triggered).', () => {
    const d = read(DEPLOY);

    expect(d).toMatch(/bash scripts\/deploy-bridge\.sh staging/);
    expect(d).toMatch(/bash scripts\/deploy-bridge\.sh prod/);
  });

  it('CRITICAL SSH key configuration step pinned for both envs — `~/.ssh/id_ed25519` with 600 perms + `~/.ssh` 700 + `ssh-keyscan` prime of known_hosts.', () => {
    const d = read(DEPLOY);

    const sshDirs = (d.match(/mkdir -p ~\/\.ssh/g) ?? []).length;
    expect(sshDirs, 'SSH dir setup steps').toBe(2);

    const keyWrites = (d.match(/echo "\$SSH_KEY" > ~\/\.ssh\/id_ed25519/g) ?? []).length;
    expect(keyWrites, 'SSH key writes').toBe(2);

    const chmod600 = (d.match(/chmod 600 ~\/\.ssh\/id_ed25519/g) ?? []).length;
    expect(chmod600, 'chmod 600 on private key').toBe(2);

    const keyscan = (d.match(/ssh-keyscan -t ed25519/g) ?? []).length;
    expect(keyscan, 'known_hosts prime').toBe(2);
  });

  it('CRITICAL known_hosts prime targets the exact Hetzner IPs — drift would break key-pinning + cause MITM-vulnerable first-contact deploys.', () => {
    const d = read(DEPLOY);
    // Staging IP.
    expect(d).toMatch(/116\.203\.22\.197/);
    // Prod IP.
    expect(d).toMatch(/128\.140\.37\.74/);
  });

  it('CRITICAL deploy-staging environment URL `staging.driftstack.dev` + deploy-production environment URL `api.driftstack.dev` pinned. The URLs surface in the GitHub deploy dashboard.', () => {
    const d = read(DEPLOY);

    expect(d).toMatch(
      /environment:\s*\n\s*name: staging\s*\n\s*url: https:\/\/staging\.driftstack\.dev/,
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

  it('CRITICAL docker / docker-compose / ghcr.io / buildx ACTIVE workflow steps MUST NOT return — Option B verdict explicitly removed them. (Comments may still name them as removed-context.)', () => {
    const d = read(DEPLOY);
    // Match against active workflow grammar — `uses:`, `run:` commands —
    // not bare keyword mentions in documentation comments.
    expect(d).not.toMatch(/^\s*-\s*run:.*docker compose/m);
    expect(d).not.toMatch(/^\s*uses: docker\/build-push-action/m);
    expect(d).not.toMatch(/^\s*uses: docker\/setup-buildx-action/m);
    expect(d).not.toMatch(/^\s*uses: docker\/login-action/m);
    expect(d).not.toMatch(/^\s*uses: appleboy\/ssh-action/m);
    // Active push to GHCR (the build-push-action target) MUST be gone.
    // The header comment may still reference ghcr.io as removed-context.
    expect(d).not.toMatch(/tags:\s*\n[\s\S]{0,200}ghcr\.io/);
  });

  it('CRITICAL Sentry repo-wide secrets documented — SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_PROJECT. Drift to dropping a doc entry would let a future operator forget to populate.', () => {
    const d = read(DEPLOY);
    expect(d).toMatch(/SENTRY_AUTH_TOKEN/);
    expect(d).toMatch(/SENTRY_ORG/);
    expect(d).toMatch(/SENTRY_PROJECT/);
  });

  it('Deploy workflow 7-invariant cluster — V-051 Workstream A revised + 3-job sequence + secret-gate + Sentry-no-op + deploy-bridge.sh invocation + cancel-in-progress: false + Option B anchor.', () => {
    const d = read(DEPLOY);

    expect(d).toMatch(/V-051/);
    expect(d).toMatch(/source-map-upload:/);
    expect(d).toMatch(/deploy-staging:/);
    expect(d).toMatch(/deploy-production:/);
    expect(d).toMatch(/HETZNER_DEPLOY_SSH_KEY/);
    expect(d).toMatch(/SENTRY_AUTH_TOKEN unset/);
    expect(d).toMatch(/deploy-bridge\.sh/);
    expect(d).toMatch(/cancel-in-progress: false/);
    expect(d).toMatch(/Option B/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/server/tests/unit/deploy-workflow-parity.test.ts')),
    ).toBe(true);
  });
});
