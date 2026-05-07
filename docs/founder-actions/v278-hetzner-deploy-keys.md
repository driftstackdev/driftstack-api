# V-278 — Hetzner deploy keys + secrets (founder ops action)

End-to-end runbook for going from "fresh repo with deploy workflows in place" to "first successful production deploy lands on the Hetzner VM and `https://api.driftstack.dev/health` returns 200."

The deploy pipelines (`.github/workflows/deploy.yml` push-on-main + `.github/workflows/server-deploy.yml` tag-triggered) build + push images to `ghcr.io` regardless of secret state. The deploy step is gated on Hetzner secrets — missing secrets cause it to skip cleanly with a "secrets not set" message. Until you complete the steps below, every push to main produces a usable image but does not deploy.

## What's already in place (no founder action needed)

- `apps/server/Dockerfile` — multi-stage build, Node 22 production runtime.
- `infra/hetzner/docker-compose.yml` — host-side compose file expected at `/opt/driftstack/docker-compose.yml` on the VM.
- `.github/workflows/deploy.yml` — push-on-main build + staging-auto-deploy + production-manual-approval pipeline.
- `.github/workflows/server-deploy.yml` — tag-triggered (`server-v*`) production-only pipeline for explicit-release semantics.
- `docs/deployment/env-vars.md` — canonical schema for every env var the server reads.
- `docs/operations/production-env-schema.md` — operations-focused summary (per-environment + provisioning order).

## What you (founder) need to do

### 1. Provision two Hetzner VMs

Per ADR-001 (`docs/adr/ADR-001-control-plane-hosting-hetzner.md`):

- **Staging**: 1× CCX13 in Falkenstein (FSN1). 4 vCPU / 16GB RAM / ~€25/mo.
- **Production**: 1× CCX23 in Falkenstein (FSN1). 8 vCPU / 32GB RAM / ~€50/mo.

Both running Ubuntu 24.04 LTS (or latest LTS at provisioning time). Add your SSH key during creation.

Record the public IPs.

### 2. Bootstrap each VM (run on the VM)

```sh
# Update + install docker + docker compose plugin
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y docker.io docker-compose-plugin curl

# Create the deploy user (matches HETZNER_USER convention)
sudo adduser --disabled-password --gecos '' driftstack
sudo usermod -aG docker driftstack

# Create the deploy directory
sudo mkdir -p /opt/driftstack
sudo chown driftstack:driftstack /opt/driftstack

# Copy the docker-compose.yml from the repo
sudo -u driftstack curl -fsS \
  https://raw.githubusercontent.com/driftstackdev/driftstack-api/main/infra/hetzner/docker-compose.yml \
  -o /opt/driftstack/docker-compose.yml
```

### 3. Generate a deploy SSH key (run on your local Mac)

A dedicated key per environment, NOT your personal SSH key. Reduces blast radius if either is compromised.

```sh
ssh-keygen -t ed25519 -f ~/.driftstack-keys/hetzner-staging -C "driftstack-deploy-staging" -N ""
ssh-keygen -t ed25519 -f ~/.driftstack-keys/hetzner-production -C "driftstack-deploy-production" -N ""
```

Add the public keys to each VM's `/home/driftstack/.ssh/authorized_keys`:

```sh
# From your Mac:
ssh-copy-id -i ~/.driftstack-keys/hetzner-staging.pub driftstack@<staging-ip>
ssh-copy-id -i ~/.driftstack-keys/hetzner-production.pub driftstack@<production-ip>
```

### 4. Configure GitHub Environments

GitHub repo → **Settings** → **Environments**.

**Create `staging` environment** (no approver gate; auto-deploys on main merge):

- Add secret: `HETZNER_HOST` = `<staging-ip>`.
- Add secret: `HETZNER_USER` = `driftstack`.
- Add secret: `HETZNER_SSH_KEY` = paste contents of `~/.driftstack-keys/hetzner-staging` (the PRIVATE key, not `.pub`). Use stdin for `gh secret set` to avoid shell-history exposure: `gh secret set HETZNER_SSH_KEY --env staging < ~/.driftstack-keys/hetzner-staging`.
- Add secret: `DEPLOY_DOTENV_BASE64` = `base64 < apps/server/.env.staging | tr -d '\n'`. The .env file you produce locally, run base64, store as the secret. See section 5 for the env schema.

**Create `production` environment** (with approver gate):

- Same four secrets, pointed at production VM.
- **Required reviewers**: add your founder GitHub account. The deploy-production job in `deploy.yml` blocks until approval.
- **Deployment protection rules**: optionally restrict to `main` branch + tags matching `server-v*`.

### 5. Build the production .env

Use `docs/operations/production-env-schema.md` (or the longer `docs/deployment/env-vars.md`) as the canonical list. The shape:

```
NODE_ENV=production
PORT=7780
LOG_LEVEL=info
HOST=0.0.0.0

DATABASE_URL=postgres://…@…neon.tech/driftstack-production
REDIS_URL=rediss://default:…@…upstash.io:…
AUTH_VERIFY_EMAIL_URL=https://app.driftstack.dev/auth/verify-email
AUTH_MAGIC_LINK_URL=https://app.driftstack.dev/auth/magic-link
AUTH_PASSWORD_RESET_URL=https://app.driftstack.dev/auth/password-reset
DASHBOARD_ORIGIN=https://app.driftstack.dev

POSTMARK_API_TOKEN=…
POSTMARK_FROM=Driftstack <noreply@driftstack.dev>
POSTMARK_REPLY_TO=support@driftstack.dev

R2_ACCOUNT_ID=…
R2_ACCESS_KEY_ID=…
R2_SECRET_ACCESS_KEY=…
R2_BUCKET_RECORDINGS=driftstack-recordings-prod
R2_ENDPOINT_URL=https://….r2.cloudflarestorage.com

SENTRY_DSN=https://…@…ingest.de.sentry.io/…
SENTRY_ENVIRONMENT=production

STRIPE_SECRET_KEY=sk_live_…
STRIPE_WEBHOOK_SECRET=whsec_…
DRIFTSTACK_TIER_PRICE_IDS=…  # 19 IDs per ADR-004
STRIPE_TRIAL_PACK_PRICE_ID=price_…
```

**Live-mode Stripe keys MUST go via SSH-write to Hetzner only** per the `stripe_credential_handling` rule — never paste live `sk_live_…` into a chat or PR. Test-mode keys (`sk_test_…`) are fine in `DEPLOY_DOTENV_BASE64` for staging.

Encode + set:

```sh
base64 < apps/server/.env.production | tr -d '\n' | gh secret set DEPLOY_DOTENV_BASE64 --env production
```

### 6. Trigger first deploy

**Option A — push-on-main (deploy.yml)**: any commit to main triggers build → staging → manual-approval → production. Simplest path.

**Option B — tag-triggered (server-deploy.yml)**:

```sh
git tag server-v0.1.0
git push origin server-v0.1.0
```

The workflow builds the image at the tagged commit + deploys to production (no staging hop). Manual-approval gate via the production environment still applies.

### 7. Verify

- `curl https://api.staging.driftstack.dev/health` → 200 with JSON body.
- `curl https://api.driftstack.dev/health` → 200 (after production approval lands).
- GitHub Actions tab → both jobs green.
- Sentry → `production` + `staging` environments populated; first events appear when traffic starts.
- Cloudflare Pages dashboard → DNS for `api.driftstack.dev` + `api.staging.driftstack.dev` points at the right Hetzner IPs (orange-cloud / proxied for TLS termination).

## Rollback

**Image-level rollback** (fastest):

```sh
ssh driftstack@<host>
cd /opt/driftstack
# Find previous good image tag in `docker images` or the deploy log:
IMAGE_TAG=ghcr.io/driftstackdev/driftstack-api:<previous-sha-or-tag> docker compose up -d
```

**Workflow-level rollback** (slower but tracked):

```sh
git revert <bad-sha>
git push origin main
# deploy.yml re-fires with the reverted state.
```

## Troubleshooting

- **"Hetzner secrets not all set — skipping deploy."** — one of `HETZNER_HOST`, `HETZNER_USER`, `HETZNER_SSH_KEY`, `DEPLOY_DOTENV_BASE64` is empty. Check the `staging` / `production` environment secrets, not repo-wide secrets.
- **SSH connection timeout** — check Hetzner Cloud Firewall allows port 22 from GitHub Actions runner IPs (or use a tunnel). Hetzner default firewall is permissive; verify in the Cloud Console.
- **`/health` never returns 200** — likely DB connection failure. Check `DATABASE_URL` in the .env is the production Neon URL, not staging. SSH in: `docker compose logs api --tail 100`.
- **Image pulled but container exits immediately** — usually env-var schema rejection (Zod parse fail at startup). `docker compose logs` shows the failed validation.
- **Manual approval never appears** — production environment's "Required reviewers" not configured. GitHub repo → Settings → Environments → production → add reviewer.

## Related docs

- `docs/adr/ADR-001-control-plane-hosting-hetzner.md` — why Hetzner, why Falkenstein.
- `docs/operations/release-policy.md` — V-283 deploy.yml=staging / server-deploy.yml=production split.
- `docs/deployment/env-vars.md` — full env-var schema (every variable, every default).
- `docs/operations/production-env-schema.md` — provisioning-order summary of the same data.
- `docs/deployment/runbook.md` — day-to-day operations (logs, restart, scale).
- `docs/deployment/dr-runbook.md` — disaster-recovery procedures.
- `docs/founder-actions/v258-cloudflare-pages-docs-setup.md` — sister runbook for Cloudflare Pages projects (DNS for `api.driftstack.dev` lives there).
- `docs/founder-actions/v259-cloudflare-pages-all-projects-setup.md` — consolidated CF Pages runbook for all four marketing/dashboard/admin/docs projects.
