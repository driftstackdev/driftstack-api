// W544.C — drift guard for /docs/founder-actions/v278-hetzner-deploy-keys.md.
// Founder runbook for first Hetzner production deploy. Cross-
// referenced from W542.A deploy.yml + W542.B server-deploy.yml.
// Drift here either drops the live-mode-Stripe-SSH-only handling
// rule (would risk pasting sk_live_… into a chat or PR), changes
// the VM-sizing recommendations (would invalidate ADR-001 cost
// model), or weakens the dedicated-key-per-environment posture.
//
//   • Header + V-278 + push-on-main-vs-tag-triggered split.
//   • ADR-001 anchor: staging CCX13 4vCPU/16GB/€25mo, prod CCX23
//     8vCPU/32GB/€50mo, Falkenstein FSN1, Ubuntu 24.04 LTS.
//   • Bootstrap commands: adduser driftstack + usermod -aG docker
//     + mkdir /opt/driftstack + curl docker-compose.yml from main.
//   • Dedicated ed25519 deploy key per environment (NOT personal
//     SSH key).
//   • GitHub Environments: staging (no approver) + production
//     (approver-gate + branch+tag restriction).
//   • Live-mode Stripe keys SSH-write-to-Hetzner-only (never chat
//     or PR); test-mode keys fine in DEPLOY_DOTENV_BASE64.
//   • Image-level rollback (fastest) vs workflow-level rollback
//     (slower but tracked).
//   • 19-tier-price-IDs reference to ADR-004.

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

  it('Header + push-on-main-vs-tag-triggered + image-pushed-regardless-of-secret-state framing pinned: \'# V-278 — Hetzner deploy keys + secrets (founder ops action)\' + \'End-to-end runbook for going from "fresh repo with deploy workflows in place" to "first successful production deploy lands on the Hetzner VM and `https://api.driftstack.dev/health` returns 200."\' + \'The deploy pipelines (`.github/workflows/deploy.yml` push-on-main + `.github/workflows/server-deploy.yml` tag-triggered) build + push images to `ghcr.io` regardless of secret state. The deploy step is gated on Hetzner secrets — missing secrets cause it to skip cleanly with a "secrets not set" message.\' — pinned so the V-278 + push-on-main-vs-tag-triggered + image-pushed-regardless-of-secret-state + secrets-not-set-graceful-skip commitment survives', () => {
    expect(body).toMatch(/# V-278 — Hetzner deploy keys \+ secrets \(founder ops action\)/);
    expect(body).toMatch(
      /End-to-end runbook for going from "fresh repo with deploy workflows in place" to "first successful production deploy lands on the Hetzner VM and `https:\/\/api\.driftstack\.dev\/health` returns 200\."/,
    );
    expect(body).toMatch(
      /The deploy pipelines \(`\.github\/workflows\/deploy\.yml` push-on-main \+ `\.github\/workflows\/server-deploy\.yml` tag-triggered\) build \+ push images to `ghcr\.io` regardless of secret state\./,
    );
    expect(body).toMatch(
      /The deploy step is gated on Hetzner secrets — missing secrets cause it to skip cleanly with a "secrets not set" message\./,
    );
  });

  it("ADR-001 VM-sizing framing pinned: '### 1. Provision two Hetzner VMs' + 'Per ADR-001 (`docs/adr/ADR-001-control-plane-hosting-hetzner.md`):' + '**Staging**: 1× CCX13 in Falkenstein (FSN1). 4 vCPU / 16GB RAM / ~€25/mo.' + '**Production**: 1× CCX23 in Falkenstein (FSN1). 8 vCPU / 32GB RAM / ~€50/mo.' + 'Both running Ubuntu 24.04 LTS (or latest LTS at provisioning time). Add your SSH key during creation. Record the public IPs.' — pinned so the ADR-001 + CCX13-staging-4vCPU/16GB/€25mo + CCX23-prod-8vCPU/32GB/€50mo + Falkenstein-FSN1 + Ubuntu-24.04-LTS commitment survives (drift to a different VM size would invalidate the ADR-001 cost model)", () => {
    expect(body).toMatch(/### 1\. Provision two Hetzner VMs/);
    expect(body).toMatch(/Per ADR-001 \(`docs\/adr\/ADR-001-control-plane-hosting-hetzner\.md`\):/);
    expect(body).toMatch(
      /- \*\*Staging\*\*: 1× CCX13 in Falkenstein \(FSN1\)\. 4 vCPU \/ 16GB RAM \/ ~€25\/mo\./,
    );
    expect(body).toMatch(
      /- \*\*Production\*\*: 1× CCX23 in Falkenstein \(FSN1\)\. 8 vCPU \/ 32GB RAM \/ ~€50\/mo\./,
    );
    expect(body).toMatch(/Both running Ubuntu 24\.04 LTS \(or latest LTS at provisioning time\)\./);
  });

  it("Bootstrap commands + driftstack-user + /opt/driftstack framing pinned: '### 2. Bootstrap each VM (run on the VM)' + 'sudo apt-get update && sudo apt-get upgrade -y' + 'sudo apt-get install -y docker.io docker-compose-plugin curl' + '# Create the deploy user (matches HETZNER_USER convention)' + 'sudo adduser --disabled-password --gecos '' driftstack' + 'sudo usermod -aG docker driftstack' + '# Create the deploy directory' + 'sudo mkdir -p /opt/driftstack' + 'sudo chown driftstack:driftstack /opt/driftstack' + '# Copy the docker-compose.yml from the repo' + 'curl -fsS https://raw.githubusercontent.com/driftstackdev/driftstack-api/main/infra/hetzner/docker-compose.yml -o /opt/driftstack/docker-compose.yml' — pinned so the bootstrap-sequence (apt-update + docker.io + docker-compose-plugin + curl + driftstack-user-disabled-password + docker-group + /opt/driftstack-dir + remote-docker-compose-curl-from-main) commitment survives", () => {
    expect(body).toMatch(/### 2\. Bootstrap each VM \(run on the VM\)/);
    expect(body).toMatch(/sudo apt-get update && sudo apt-get upgrade -y/);
    expect(body).toMatch(/sudo apt-get install -y docker\.io docker-compose-plugin curl/);
    expect(body).toMatch(/# Create the deploy user \(matches HETZNER_USER convention\)/);
    expect(body).toMatch(/sudo adduser --disabled-password --gecos '' driftstack/);
    expect(body).toMatch(/sudo usermod -aG docker driftstack/);
    expect(body).toMatch(/# Create the deploy directory/);
    expect(body).toMatch(/sudo mkdir -p \/opt\/driftstack/);
    expect(body).toMatch(/sudo chown driftstack:driftstack \/opt\/driftstack/);
    expect(body).toMatch(/# Copy the docker-compose\.yml from the repo/);
    expect(body).toMatch(
      /https:\/\/raw\.githubusercontent\.com\/driftstackdev\/driftstack-api\/main\/infra\/hetzner\/docker-compose\.yml/,
    );
    expect(body).toMatch(/-o \/opt\/driftstack\/docker-compose\.yml/);
  });

  it("Dedicated-key-per-env + ed25519 + ssh-copy-id framing pinned: '### 3. Generate a deploy SSH key (run on your local Mac)' + 'A dedicated key per environment, NOT your personal SSH key. Reduces blast radius if either is compromised.' + 'ssh-keygen -t ed25519 -f ~/.driftstack-keys/hetzner-staging -C \"driftstack-deploy-staging\" -N \"\"' + 'ssh-keygen -t ed25519 -f ~/.driftstack-keys/hetzner-production -C \"driftstack-deploy-production\" -N \"\"' + 'ssh-copy-id -i ~/.driftstack-keys/hetzner-staging.pub driftstack@<staging-ip>' + 'ssh-copy-id -i ~/.driftstack-keys/hetzner-production.pub driftstack@<production-ip>' — pinned so the dedicated-key-per-env (blast-radius rationale) + ed25519 + 2-key-pair (staging + production) + ssh-copy-id-to-driftstack-user commitment survives", () => {
    expect(body).toMatch(/### 3\. Generate a deploy SSH key \(run on your local Mac\)/);
    expect(body).toMatch(
      /A dedicated key per environment, NOT your personal SSH key\. Reduces blast radius if either is compromised\./,
    );
    expect(body).toMatch(
      /ssh-keygen -t ed25519 -f ~\/\.driftstack-keys\/hetzner-staging -C "driftstack-deploy-staging" -N ""/,
    );
    expect(body).toMatch(
      /ssh-keygen -t ed25519 -f ~\/\.driftstack-keys\/hetzner-production -C "driftstack-deploy-production" -N ""/,
    );
    expect(body).toMatch(
      /ssh-copy-id -i ~\/\.driftstack-keys\/hetzner-staging\.pub driftstack@<staging-ip>/,
    );
    expect(body).toMatch(
      /ssh-copy-id -i ~\/\.driftstack-keys\/hetzner-production\.pub driftstack@<production-ip>/,
    );
  });

  it("GitHub-Environments + production-approver-gate + ADR-004 19-tier-price framing pinned: '### 4. Configure GitHub Environments' + '**Create `staging` environment** (no approver gate; auto-deploys on main merge):' + 'Add secret: `HETZNER_HOST`' + 'Add secret: `HETZNER_USER` = `driftstack`' + '`HETZNER_SSH_KEY` = paste contents of `~/.driftstack-keys/hetzner-staging` (the PRIVATE key, not `.pub`).' + 'Use stdin for `gh secret set`' + '**Create `production` environment** (with approver gate):' + '**Required reviewers**: add your founder GitHub account. The deploy-production job in `deploy.yml` blocks until approval.' + '**Deployment protection rules**: optionally restrict to `main` branch + tags matching `server-v*`.' + 'DRIFTSTACK_TIER_PRICE_IDS=…  # 19 IDs per ADR-004' — pinned so the GitHub-Environments + staging-no-approver-auto-deploy + production-with-approver-gate + branch+server-v*-restriction + ADR-004-19-tier-price-IDs commitment survives", () => {
    expect(body).toMatch(/### 4\. Configure GitHub Environments/);
    expect(body).toMatch(
      /\*\*Create `staging` environment\*\* \(no approver gate; auto-deploys on main merge\):/,
    );
    expect(body).toMatch(/- Add secret: `HETZNER_HOST` = `<staging-ip>`\./);
    expect(body).toMatch(/- Add secret: `HETZNER_USER` = `driftstack`\./);
    expect(body).toMatch(
      /- Add secret: `HETZNER_SSH_KEY` = paste contents of `~\/\.driftstack-keys\/hetzner-staging` \(the PRIVATE key, not `\.pub`\)\./,
    );
    expect(body).toMatch(/Use stdin for `gh secret set`/);
    expect(body).toMatch(/\*\*Create `production` environment\*\* \(with approver gate\):/);
    expect(body).toMatch(
      /- \*\*Required reviewers\*\*: add your founder GitHub account\. The deploy-production job in `deploy\.yml` blocks until approval\./,
    );
    expect(body).toMatch(
      /- \*\*Deployment protection rules\*\*: optionally restrict to `main` branch \+ tags matching `server-v\*`\./,
    );
    expect(body).toMatch(/DRIFTSTACK_TIER_PRICE_IDS=… {2}# 19 IDs per ADR-004/);
  });

  it("Live-mode-Stripe-SSH-only + test-mode-OK framing pinned: '**Live-mode Stripe keys MUST go via SSH-write to Hetzner only** per the `stripe_credential_handling` rule — never paste live `sk_live_…` into a chat or PR. Test-mode keys (`sk_test_…`) are fine in `DEPLOY_DOTENV_BASE64` for staging.' — pinned so the live-mode-Stripe-SSH-only + stripe_credential_handling-rule-anchor + sk_test_-OK-in-staging-base64 commitment survives (drift to dropping this rule would risk pasting sk_live into chat or PR; drift to blocking sk_test would unnecessarily friction staging setup)", () => {
    expect(body).toMatch(
      /\*\*Live-mode Stripe keys MUST go via SSH-write to Hetzner only\*\* per the `stripe_credential_handling` rule — never paste live `sk_live_…` into a chat or PR\./,
    );
    expect(body).toMatch(
      /Test-mode keys \(`sk_test_…`\) are fine in `DEPLOY_DOTENV_BASE64` for staging\./,
    );
  });

  it("Image-level + workflow-level rollback + Troubleshooting framing pinned: '## Rollback' + '**Image-level rollback** (fastest):' + 'IMAGE_TAG=ghcr.io/driftstackdev/driftstack-api:<previous-sha-or-tag> docker compose up -d' + '**Workflow-level rollback** (slower but tracked):' + 'git revert <bad-sha>' + 'git push origin main' + '## Troubleshooting' + '\"Hetzner secrets not all set — skipping deploy.\" — one of `HETZNER_HOST`, `HETZNER_USER`, `HETZNER_SSH_KEY`, `DEPLOY_DOTENV_BASE64` is empty.' + '**SSH connection timeout** — check Hetzner Cloud Firewall' + '**`/health` never returns 200** — likely DB connection failure.' + '**Image pulled but container exits immediately** — usually env-var schema rejection (Zod parse fail at startup).' + '**Manual approval never appears** — production environment's \"Required reviewers\" not configured.' — pinned so the 2-level rollback (image-IMAGE_TAG-export + workflow-git-revert) + 5-troubleshooting-bullet commitment survives", () => {
    expect(body).toMatch(/## Rollback/);
    expect(body).toMatch(/\*\*Image-level rollback\*\* \(fastest\):/);
    expect(body).toMatch(
      /IMAGE_TAG=ghcr\.io\/driftstackdev\/driftstack-api:<previous-sha-or-tag> docker compose up -d/,
    );
    expect(body).toMatch(/\*\*Workflow-level rollback\*\* \(slower but tracked\):/);
    expect(body).toMatch(/git revert <bad-sha>/);
    expect(body).toMatch(/git push origin main/);
    expect(body).toMatch(/## Troubleshooting/);
    expect(body).toMatch(
      /\*\*"Hetzner secrets not all set — skipping deploy\."\*\* — one of `HETZNER_HOST`, `HETZNER_USER`, `HETZNER_SSH_KEY`, `DEPLOY_DOTENV_BASE64` is empty\./,
    );
    expect(body).toMatch(/\*\*SSH connection timeout\*\* — check Hetzner Cloud Firewall/);
    expect(body).toMatch(/\*\*`\/health` never returns 200\*\* — likely DB connection failure\./);
    expect(body).toMatch(
      /\*\*Image pulled but container exits immediately\*\* — usually env-var schema rejection \(Zod parse fail at startup\)\./,
    );
    expect(body).toMatch(
      /\*\*Manual approval never appears\*\* — production environment's "Required reviewers" not configured\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
