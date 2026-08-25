// W544.C — drift guard for /docs/founder-actions/v278-hetzner-deploy-keys.md.
//
// 2026-05-20 — doc rewrote from the original "fresh-setup runbook"
// (provision VMs + bootstrap + GitHub Environments + ADR-004) into a
// key-rotation runbook ("the HETZNER_DEPLOY_SSH_KEY repo secret is
// missing — generate fresh + repopulate so deploys stop no-opping").
// The single `HETZNER_DEPLOY_SSH_KEY` secret replaces the old 4-secret
// docker-compose surface; the hard-error gate (commit 81d65fef + the
// W724 deploy-workflow-parity flip) is what surfaces missing-state.
//
//   • Header + key-rotation framing (was first-successful-deploy).
//   • Current-state callout: secret missing, deploy.yml fails loudly,
//     prod alive (2026-05-19), last successful auto-deploy SHAs.
//   • 6-step founder action: confirm key state + generate ed25519
//     deploy key + add pubkey to both hosts + populate repo secret
//     via stdin + re-fire workflow + verify /version SHA.
//   • Rollback: auto-revert via revert-bridge.sh + manual revert
//     pointer to /opt/driftstack/api/.last-good-sha.
//   • Troubleshooting: 4 bullets (hard-gate error, ssh permission,
//     /health 200 but /version stale, awaiting approval).
//   • Related docs cross-refs.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/founder-actions/v278-hetzner-deploy-keys.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W544.C /docs/founder-actions/v278-hetzner-deploy-keys.md content parity', () => {
  const body = read(LIB);

  it("Header + key-rotation framing pinned: 'V-278 — Hetzner deploy keys + secrets (founder ops action)' + 'rotate the SSH key + repopulate the `HETZNER_DEPLOY_SSH_KEY` repo secret so the deploy workflow stops no-opping'", () => {
    expect(body).toMatch(/# V-278 — Hetzner deploy keys \+ secrets \(founder ops action\)/);
    expect(body).toMatch(
      /rotate the SSH key \+ repopulate the\s*`HETZNER_DEPLOY_SSH_KEY` repo secret so the deploy workflow stops\s*no-opping/,
    );
  });

  it('Current-state callout pinned: hard-fail gate via commit 81d65fef + prod-alive-since-2026-05-19 + last-successful-auto-deploy SHAs (prod e7571fa / staging 14971a7) — pinned so the gate-fix commit anchor stays load-bearing if the post-mortem ever needs to retrace why main went 10h without deploying', () => {
    expect(body).toMatch(
      /The deploy\.yml workflow's gate step now FAILS\s*LOUDLY \(commit `81d65fef`\) when the secret is unset/,
    );
    expect(body).toMatch(/Production \+ staging are alive \(services running since\s*2026-05-19\)/);
    expect(body).toMatch(
      /Last successful auto-deploy:\s*`e7571fa` \(prod\) \/ `14971a7` \(staging\)/,
    );
  });

  it("'What's already in place' inventory pinned: 4-piece (deploy.yml push-on-main pipeline + scripts/deploy-bridge.sh SSH-driven + scripts/post-deploy-verify.mjs 20-invariant + prod CPX32 staging CPX22 systemd units) — pinned so the inventory of pre-existing-infrastructure can't drift apart from the actual files", () => {
    expect(body).toMatch(/## What's already in place \(no founder action needed\)/);
    expect(body).toMatch(/`\.github\/workflows\/deploy\.yml` — push-on-main pipeline/);
    expect(body).toMatch(/`scripts\/deploy-bridge\.sh` — host-side SSH-driven deploy/);
    expect(body).toMatch(/`scripts\/post-deploy-verify\.mjs` — 20-invariant post-deploy/);
    expect(body).toMatch(/`root@128\.140\.37\.74` \(CPX32\)/);
    expect(body).toMatch(/`root@116\.203\.22\.197` \(CPX22\)/);
  });

  it('6-step founder action pinned: (1) confirm prior key state via `gh secret list` + (2) generate ed25519 in ~/.driftstack-keys/hetzner-deploy + (3) add pubkey to both hosts + smoke-test + (4) populate repo secret via stdin (no shell-history exposure) + (5) re-fire via `gh workflow run Deploy` + (6) verify via /version SHA — pinned so the runbook can be followed verbatim without doc-vs-tool drift', () => {
    expect(body).toMatch(/### 1\. Confirm the prior key state/);
    expect(body).toMatch(/### 2\. Generate a dedicated deploy key \(run on your local Mac\)/);
    expect(body).toMatch(
      /ssh-keygen -t ed25519 \\\s*-f ~\/\.driftstack-keys\/hetzner-deploy \\\s*-C "driftstack-deploy" \\\s*-N ""/,
    );
    expect(body).toMatch(/### 3\. Add the public key to both hosts/);
    expect(body).toMatch(/### 4\. Populate the GitHub repo secret/);
    expect(body).toMatch(/gh secret set HETZNER_DEPLOY_SSH_KEY \\/);
    expect(body).toMatch(/`gh` reads the private key from stdin \(no shell-history exposure\)\./);
    expect(body).toMatch(/### 5\. Re-fire the deploy workflow/);
    expect(body).toMatch(/gh workflow run Deploy --ref main --repo driftstackdev\/driftstack-api/);
    expect(body).toMatch(/### 6\. Verify the deploy landed/);
    expect(body).toMatch(/curl -s https:\/\/api\.driftstack\.dev\/version \| jq/);
  });

  it('Single-key-for-both-hosts framing pinned (NOT per-env keys today — same root SSH posture on both hosts; per-env keys deferred to later hardening) — pinned so a future split into 2 keys is a conscious decision, not silent drift', () => {
    expect(body).toMatch(
      /Single key works for both staging \+ production because both\s*hosts share the same `root` SSH posture today; per-environment\s*keys are a later hardening pass/,
    );
  });

  it('Rollback pointer pinned: auto-revert via revert-bridge.sh on /health-fail + manual revert reads .last-good-sha — pinned so the auto-revert + .last-good-sha rollback anchors stay aligned with the bridge script behavior', () => {
    expect(body).toMatch(/## Rollback/);
    expect(body).toMatch(
      /The deploy-bridge auto-reverts on `\/health`-fail post-restart\s*via `scripts\/revert-bridge\.sh`/,
    );
    expect(body).toMatch(/Reverts to `\/opt\/driftstack\/api\/\.last-good-sha`/);
  });

  it('Troubleshooting 4-bullet pinned: hard-gate-error (81d65fef anchor) + SSH-permission-denied + /health-200-but-/version-stale (drizzle migration-immutability) + deploy-production-Awaiting-approval — pinned so each failure mode the runbook covers stays present (drift to dropping any would leave operators stuck without a recovery path)', () => {
    expect(body).toMatch(/## Troubleshooting/);
    expect(body).toMatch(/`::error::HETZNER_DEPLOY_SSH_KEY repo secret is unset`/);
    expect(body).toMatch(/the loud-gate fix from commit `81d65fef` working as designed/);
    expect(body).toMatch(/SSH permission denied/);
    expect(body).toMatch(/`\/health` 200 but `\/version` SHA still old/);
    expect(body).toMatch(/usually a drizzle migration-immutability check failure/);
    expect(body).toMatch(/deploy-production stays in "Awaiting approval"/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
