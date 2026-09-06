// W542.A — drift guard for /.github/workflows/deploy.yml.
// REWRITTEN 2026-05-17 for Option B verdict (docker dropped; see
// docs/internal/2026-05-16-deploy-yml-verdict-design.md).
//
// Pins the Option B deploy pipeline shape:
//
//   • Two-environment flow: staging auto on main merge, production
//     manual-approval via GitHub environment.
//   • V-051 anchor (REVISED 2026-05-17): Hetzner CCX13 + systemd +
//     bare-node at /opt/driftstack/api + scripts/deploy-bridge.sh as
//     the source-of-truth deploy invocation.
//   • Single per-env secret HETZNER_DEPLOY_SSH_KEY (narrower than the
//     old 4-secret docker-compose surface).
//   • 3 repo-wide secrets: SENTRY_AUTH_TOKEN + SENTRY_ORG +
//     SENTRY_PROJECT (source-map upload, no-op on missing).
//
// The complementary W724 test (deploy-workflow-parity.test.ts) covers
// the same invariants from a different angle; this file pins the
// PROSE framing of the comments + the structural shape of the YAML.

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

describe('W542.A /.github/workflows/deploy.yml content parity (Option B)', () => {
  const body = read(LIB);

  it('Header + Option B verdict + V-051 REVISED + two-env-flow framing pinned', () => {
    expect(body).toMatch(/# Driftstack API — deploy pipeline \(Option B verdict 2026-05-17:/);
    expect(body).toMatch(/drop Docker, match prod systemd\+node reality/);
    expect(body).toMatch(/scripts\/deploy-bridge\.sh/);
    expect(body).toMatch(/# Two-environment flow:/);
    expect(body).toMatch(/#\s+- Staging deploy auto-fires on main merge\. No approval gate\./);
    expect(body).toMatch(/#\s+- Production deploy is a manual job that requires the/);
    expect(body).toMatch(/#\s+"production" GitHub environment's approver list to ack\./);
    expect(body).toMatch(/# Per Workstream A spec \(V-051 — REVISED 2026-05-17\):/);
    expect(body).toMatch(/#\s+- Hetzner Cloud VMs \(CCX13 default — 4 vCPU, 16GB RAM, €25\/mo\)\./);
    expect(body).toMatch(/#\s+- systemd at \/opt\/driftstack\/api on the host\./);
    expect(body).toMatch(/#\s+- DB migrations applied BEFORE restart/);
    expect(body).toMatch(/#\s+- Smoke test against \/health post-restart/);
  });

  it('Single HETZNER_DEPLOY_SSH_KEY secret + 3 repo-wide Sentry secrets pinned', () => {
    expect(body).toMatch(/# Required GitHub secrets \(per environment\):/);
    expect(body).toMatch(/#\s+- HETZNER_DEPLOY_SSH_KEY — private key with deploy-scoped access/);
    expect(body).toMatch(/# Required repository-wide secrets:/);
    expect(body).toMatch(/#\s+- SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT/);
  });

  it('"What was removed" section documents the dropped Docker/compose surface', () => {
    expect(body).toMatch(/# What was removed:/);
    expect(body).toMatch(/#\s+- Docker buildx \/ build-push-action \/ ghcr\.io push/);
    expect(body).toMatch(/#\s+- docker-compose pull \/ up -d \(no docker-compose on the host\)/);
    expect(body).toMatch(/#\s+- DEPLOY_DOTENV_BASE64 secret/);
  });

  it('Trigger + concurrency framing pinned', () => {
    expect(body).toMatch(/^name: Deploy$/m);
    expect(body).toMatch(/on:\s*\n\s*push:\s*\n\s*branches: \[main\]\s*\n\s*workflow_dispatch:/);
    expect(body).toMatch(
      /concurrency:\s*\n\s*group: deploy-\$\{\{ github\.ref \}\}\s*\n\s*cancel-in-progress: false/,
    );
  });

  it('source-map-upload job (Sentry source-map build outside the deploy path)', () => {
    expect(body).toMatch(/source-map-upload:/);
    expect(body).toMatch(/name: Build \+ upload source maps to Sentry/);
    expect(body).toMatch(/permissions:\s*\n\s*contents: read/);
    expect(body).toMatch(/npm ci --no-audit --include=dev/);
    // 2026-05-XX deploy.yml replaced `npx tsc --build packages/api-types`
    // with `npm run build:packages` so any new workspace package builds
    // automatically.
    expect(body).toMatch(/npm run build:packages/);
    expect(body).toMatch(/npm run build --workspace=@driftstack\/server/);
  });

  it('Sentry source-map upload no-op on missing SENTRY_AUTH_TOKEN', () => {
    expect(body).toMatch(/echo "SENTRY_AUTH_TOKEN unset — skipping source-map upload\."/);
    expect(body).toMatch(/Runtime still works; stack traces will be minified/);
    expect(body).toMatch(/npx --yes @sentry\/cli@\^2 releases new "\$\{SENTRY_RELEASE\}"/);
    expect(body).toMatch(/npx --yes @sentry\/cli@\^2 sourcemaps upload/);
    expect(body).toMatch(/--url-prefix="app:\/\/\/apps\/server\/dist"/);
    expect(body).toMatch(/npx --yes @sentry\/cli@\^2 releases finalize "\$\{SENTRY_RELEASE\}"/);
    expect(body).toMatch(
      /npx --yes @sentry\/cli@\^2 releases set-commits "\$\{SENTRY_RELEASE\}" --auto \|\| true/,
    );
  });

  it('deploy-staging + deploy-production jobs both invoke deploy-bridge.sh', () => {
    expect(body).toMatch(/deploy-staging:/);
    expect(body).toMatch(/name: Deploy to staging \(via deploy-bridge\.sh\)/);
    expect(body).toMatch(/needs: source-map-upload/);
    expect(body).toMatch(/url: https:\/\/staging\.driftstack\.dev/);
    expect(body).toMatch(/bash scripts\/deploy-bridge\.sh staging/);

    expect(body).toMatch(/deploy-production:/);
    expect(body).toMatch(
      /name: Deploy to production \(CONTINUOUS — no approval gate; via deploy-bridge\.sh\)/,
    );
    expect(body).toMatch(/needs: \[source-map-upload, deploy-staging\]/);
    expect(body).toMatch(/url: https:\/\/api\.driftstack\.dev/);
    expect(body).toMatch(/bash scripts\/deploy-bridge\.sh prod/);
  });

  it('SSH key configuration step pinned for both envs', () => {
    const sshDirs = (body.match(/mkdir -p ~\/\.ssh/g) ?? []).length;
    expect(sshDirs).toBe(2);
    const chmod600 = (body.match(/chmod 600 ~\/\.ssh\/id_ed25519/g) ?? []).length;
    expect(chmod600).toBe(2);
    // Host IPs pinned as the var the robust keyscan loop reads. TWO forms are
    // legitimate: `host=<ip>` (prod job, one host) and `for host in <ip> <ip>`
    // (staging job, which must ALSO prime prod because the DB-isolation
    // pre-flight SSHes there). Pinning only the first froze a one-host staging
    // job — the shape that broke every deploy from 2026-07-12.
    for (const ip of ['116.203.22.197', '128.140.37.74']) {
      const escaped = ip.replace(/\./g, '\\.');
      const assigned = new RegExp(`host=${escaped}`).test(body);
      const looped = new RegExp(`for host in [^\n;]*${escaped}`).test(body);
      expect(assigned || looped, `${ip} is never fed to ssh-keyscan`).toBe(true);
    }
    // Robust TOFU keyscan (retry + fail-clear, replacing the `|| true` swallow that
    // caused the eadc737 transient "Host key verification failed"): the var-based
    // scan + the clear-error guard must each appear once per env (staging + prod).
    const keyscanCmd = (body.match(/ssh-keyscan -t ed25519 "\$host"/g) ?? []).length;
    expect(keyscanCmd).toBe(2);
    const failClear = (body.match(/could not obtain SSH host key for \$host/g) ?? []).length;
    expect(failClear).toBe(2);
  });

  it('the production job does NOT claim an approval gate repo settings do not have', () => {
    // ⛔⛔ INVERTED 2026-09-06. This is the SECOND file pinning the same false
    // safety claim — its twin is deploy-workflow-parity. Both required the file to
    // SAY production is gated on founder approval; measured, every GitHub
    // environment has `protection_rules: []`, `main` is not branch-protected, and
    // the last five runs went staging→production in 267-294 s with no pause.
    //
    // ⚠️ Two files pinning one claim is the same trap that bit twice today with
    // count censuses — fix the one the failure names and the other keeps the lie
    // alive. Grep the SYMBOL, not the file.
    //
    // Continuous deploy is the owner's explicit choice. Only the wording was wrong.
    expect(body).not.toMatch(/is configured in repo settings to/);
    // ⚠️ Whitespace-tolerant on purpose. The first version of this assertion
    // PASSED FOR THE WRONG REASON: the phrase was present in a comment and a
    // line wrap split it, so a literal regex missed it. An absence assertion that
    // formatting can satisfy is not an absence assertion.
    expect(body).not.toMatch(/require approval from the founder[\s#]+before this job runs/);
    expect(body).toMatch(/CONTINUOUS — no approval gate/);
  });

  it('docker / docker-compose / ghcr.io workflow STEPS MUST NOT return — Option B removed them (the comment block may still name them as removed-context)', () => {
    // Match against the active workflow grammar — `uses:`, `run:`, env
    // refs — NOT bare keyword mentions in documentation comments. The
    // comments in the header intentionally name what was removed.
    expect(body).not.toMatch(/^\s*-\s*run:.*docker compose/m);
    expect(body).not.toMatch(/^\s*uses: docker\/build-push-action/m);
    expect(body).not.toMatch(/^\s*uses: docker\/setup-buildx-action/m);
    expect(body).not.toMatch(/^\s*uses: docker\/login-action/m);
    expect(body).not.toMatch(/^\s*uses: appleboy\/ssh-action/m);
    // Active secret-ref to the removed DOTENV_BASE64 — comments may
    // still mention the name as removed-context.
    expect(body).not.toMatch(/secrets\.DEPLOY_DOTENV_BASE64/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
