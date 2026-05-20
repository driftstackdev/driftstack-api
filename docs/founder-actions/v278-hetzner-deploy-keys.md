# V-278 — Hetzner deploy keys + secrets (founder ops action)

End-to-end runbook for "rotate the SSH key + repopulate the
`HETZNER_DEPLOY_SSH_KEY` repo secret so the deploy workflow stops
no-opping."

**Current state (2026-05-20):** `HETZNER_DEPLOY_SSH_KEY` is missing
from the repo secret list (`gh secret list -R driftstackdev/
driftstack-api`). The deploy.yml workflow's gate step now FAILS
LOUDLY (commit `81d65fef`) when the secret is unset, surfacing
the gap on every push instead of silently exit-0-ing. Prior
behavior let main go ~10h without an actual deploy while every
workflow report said "success."

Production + staging are alive (services running since
2026-05-19); the missing-secret state means new commits don't
propagate, NOT that prod is down. Last successful auto-deploy:
`e7571fa` (prod) / `14971a7` (staging). Origin/main is at
`a4b20190` as of this writing — 12+ commits ahead of prod.

## What's already in place (no founder action needed)

- `.github/workflows/deploy.yml` — push-on-main pipeline:
  source-map-upload → deploy-staging → deploy-production
  (manual-approval gate via the `production` GH Environment).
- `scripts/deploy-bridge.sh` — host-side SSH-driven deploy:
  clones GitHub at the target SHA, builds in `/tmp`, atomic
  swaps artefacts into `/opt/driftstack/api`, applies pending
  drizzle migrations, restarts `driftstack-api.service`,
  smoke-tests `/health`, auto-reverts on failure via
  `scripts/revert-bridge.sh`.
- `scripts/post-deploy-verify.mjs` — 20-invariant post-deploy
  smoke (mirrors the `docs/runbooks/deploy-bridge.md` runbook
  invariant count).
- Prod systemd service: `/etc/systemd/system/driftstack-api.service`
  on `root@128.140.37.74` (CPX32). Staging same shape on
  `root@116.203.22.197` (CPX22).

## What you (founder) need to do

### 1. Confirm the prior key state

The prior `HETZNER_DEPLOY_SSH_KEY` was deleted (or never
existed). Either way the fix is identical: generate fresh + set.

```sh
gh secret list -R driftstackdev/driftstack-api | grep HETZNER || echo "no HETZNER_* secrets currently set"
```

### 2. Generate a dedicated deploy key (run on your local Mac)

```sh
mkdir -p ~/.driftstack-keys
ssh-keygen -t ed25519 \
  -f ~/.driftstack-keys/hetzner-deploy \
  -C "driftstack-deploy" \
  -N ""
```

Single key works for both staging + production because both
hosts share the same `root` SSH posture today; per-environment
keys are a later hardening pass.

### 3. Add the public key to both hosts

```sh
# From your Mac (uses your existing root-authorized key path).
PUB=$(cat ~/.driftstack-keys/hetzner-deploy.pub)
ssh root@128.140.37.74 "echo '$PUB' >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys"
ssh root@116.203.22.197 "echo '$PUB' >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys"
```

Smoke test the new key actually works:

```sh
ssh -i ~/.driftstack-keys/hetzner-deploy root@128.140.37.74 "echo prod connectivity ok; whoami; hostname"
ssh -i ~/.driftstack-keys/hetzner-deploy root@116.203.22.197 "echo staging connectivity ok; whoami; hostname"
```

Expect: `prod connectivity ok / root / <hostname>` (and same
for staging).

### 4. Populate the GitHub repo secret

```sh
gh secret set HETZNER_DEPLOY_SSH_KEY \
  --repo driftstackdev/driftstack-api \
  < ~/.driftstack-keys/hetzner-deploy
```

`gh` reads the private key from stdin (no shell-history exposure).

Verify:

```sh
gh secret list -R driftstackdev/driftstack-api | grep HETZNER_DEPLOY_SSH_KEY
```

### 5. Re-fire the deploy workflow

The next push to `main` auto-triggers the workflow. To deploy
the current HEAD without an additional commit:

```sh
gh workflow run Deploy --ref main --repo driftstackdev/driftstack-api
```

Monitor:

```sh
gh run watch --repo driftstackdev/driftstack-api
```

Expected: source-map-upload + deploy-staging both succeed
(staging deploys auto); deploy-production stays in
"Awaiting approval" — approve via the GH Actions UI on the
workflow page (or `gh run approve <run-id>`).

### 6. Verify the deploy landed

```sh
# Should report the latest origin/main SHA (e.g. a4b20190 short).
curl -s https://api.driftstack.dev/version | jq
curl -s https://staging.driftstack.dev/version | jq

# Service uptime — should reset to ~minutes after the deploy.
ssh root@128.140.37.74 "systemctl status driftstack-api --no-pager | head -3"
```

## Rollback

The deploy-bridge auto-reverts on `/health`-fail post-restart
via `scripts/revert-bridge.sh`. Manual revert:

```sh
ssh root@128.140.37.74 "bash /opt/driftstack/api/scripts/revert-bridge.sh"
```

Reverts to `/opt/driftstack/api/.last-good-sha`.

## Troubleshooting

- **`::error::HETZNER_DEPLOY_SSH_KEY repo secret is unset`** —
  the loud-gate fix from commit `81d65fef` working as designed.
  Re-run section 4.
- **SSH permission denied** — the pubkey didn't land on the host.
  Re-run section 3 + smoke-test section 3's `ssh -i ...` command
  directly.
- **`/health` 200 but `/version` SHA still old** — deploy-bridge
  reverted post-restart. Check the GH Actions log for the bridge
  output; usually a drizzle migration-immutability check failure.
- **deploy-production stays in "Awaiting approval"** —
  production GH Environment's "Required reviewers" expects your
  account. Approve via GH UI or `gh run approve <run-id>`.

## Related docs

- `docs/runbooks/deploy-bridge.md` — operational deploy-bridge
  walk-through (20 post-deploy-verify invariants).
- `docs/deployment/env-vars.md` — full env-var schema (env is
  host-resident at `/opt/driftstack/api/.env`; not in the
  GH Actions deploy payload).
- `docs/adr/ADR-001-control-plane-hosting-hetzner.md` — why
  Hetzner, why Falkenstein.
