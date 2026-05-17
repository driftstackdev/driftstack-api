# deploy.yml-vs-server verdict — Option A vs Option B cost analysis

**Outcome 2026-05-17 (orchestrator handoff post-AUTO #1):** Option B
LOCKED. Rationale: matches prod systemd+node reality, deploy-bridge.sh
proven across 10+ Wave 1062 prod deploys, 1h autopilot vs 3-4h
operator-paired. Founder's personal-Mac Docker is dev-only (and was
just stopped), unrelated to prod path. Future Docker migration stays
an option per "What's next" below.

Implementation landed this wave — `.github/workflows/deploy.yml`
rewritten to call `scripts/deploy-bridge.sh staging` / `prod` directly
from the GH Actions runner. Source maps still upload from a clean CI
build (Sentry path unchanged).

**Date:** 2026-05-16 (Wave 1062+ P-track design slice)
**Status:** DESIGN — surfaces the trade-off for founder verdict. No
implementation in this slice; design only so founder can pick and the
autopilot can execute the choice in a follow-up wave.

## Mismatch (recap)

- `.github/workflows/deploy.yml` (auto-deploy on main merge) +
  `.github/workflows/server-deploy.yml` (tag-trigger production) both
  build a Docker image to `ghcr.io/driftstackdev/driftstack-api:<sha>`
  and SSH to the Hetzner host expecting `docker compose pull` +
  `docker compose up -d` at `/opt/driftstack/docker-compose.yml`.
- Prod (128.140.37.74) + staging (116.203.22.197) actually run
  **systemd + bare node** from `/opt/driftstack/api/apps/server/dist/
index.js`. No Docker daemon, no docker-compose.yml, no
  `/opt/driftstack/.env`.
- CI Deploy reports success while reality stays static. Bridged today
  by `scripts/deploy-bridge.sh` (manual SSH-build-swap-restart with
  inline post-deploy-verify).

## Option A — install Docker on Hetzner; deploy.yml works as-is

### Steps (operator)

1. `apt install docker-ce docker-compose-plugin` on both hosts.
2. Add `driftstack` user to the `docker` group.
3. Write `/opt/driftstack/docker-compose.yml` referencing the
   `ghcr.io/...:<sha>` image with the env file at
   `/opt/driftstack/.env`.
4. Migrate `/opt/driftstack/api/.env` contents to
   `DEPLOY_DOTENV_BASE64` GitHub secret (so deploy.yml writes the
   right env at deploy time).
5. Stop + disable `driftstack-api.service` systemd unit.
6. First `docker compose up -d` to take over the listener.
7. Update both DNS A records if needed (no change — same hosts).

### Costs

- **One-time setup:** ~3-4h operator-pair work (most of it
  staging-soak watching for regressions on first cutover). Founder
  can probably autopilot-authorise.
- **Recurring per-deploy:** zero — automatic on main merge.
- **Recurring infrastructure:** ~50–100 MB image-cache disk on each
  host (acceptable on the CCX13 16GB / 80GB SSD).
- **Toolchain on prod:** Docker daemon (privileged, attack surface);
  no node toolchain (good).
- **Rollback story:** swap image tag in compose file + `up -d`.
  Fast. Image stays in ghcr.io retention window so revert always has
  a target.

### Wins

- Immutable image deploys; reproducible builds; no host node version drift.
- Long-term industry standard; matches every Sentry release + CD tutorial.
- CI Deploy actually deploys; manual `deploy-bridge.sh` retires.
- Pairs naturally with future multi-region (just run the same image
  in more places).

### Risks

- First cutover is bare-metal-to-docker — non-trivial. ~30 min
  downtime window or careful blue-green (run compose-side on port
  7781 + cutover via systemd switch + DNS/proxy).
- Docker daemon owns its own attack surface; adds an init-system
  layer to the trust boundary.

## Option B — rewrite deploy.yml + server-deploy.yml without Docker

### Steps (autopilot, autonomous)

1. Replace the docker-compose-pull-and-up SSH step in
   `deploy.yml` with the deploy-bridge.sh sequence verbatim
   (clone + npm ci + tsc build + atomic swap +
   migrate.js + systemctl restart + post-deploy-verify).
2. Same for `server-deploy.yml`.
3. Image-build job retained — still useful for offline analysis,
   but not the production deploy path.
4. Drop the `docker compose pull` step + the `/opt/driftstack/
docker-compose.yml` reference.

### Costs

- **One-time:** ~1h autopilot work to rewrite the two YAML files +
  validate they pass the github-actions schema + first
  end-to-end deploy of a tiny commit.
- **Recurring per-deploy:** automatic on main merge (deploy.yml)
  or git tag (server-deploy.yml).
- **Recurring infrastructure:** node 22+ + npm + git on the
  Hetzner host (already there since deploy-bridge.sh relies on it).
- **Toolchain on prod:** node + npm in the build path. ~80 MB dev
  deps shipped per deploy (same as deploy-bridge.sh today).
- **Rollback story:** same as deploy-bridge — `revert-bridge.sh
prod` reads `.last-good-sha` and re-runs deploy-bridge with that
  SHA. Already implemented today (V-549.B in commit a083c45).

### Wins

- Zero operator action — autopilot fires the rewrite without SSH
  privileges.
- Matches the deploy-bridge.sh pattern that already proved out
  (~10+ successful prod deploys in Wave 1062). The 8-invariant
  post-deploy-verify catches the same regression class CI would.
- No bare-metal-to-docker cutover risk.

### Risks

- Long-term: keeps node + npm + git on prod (Option A removes
  these). The accidental-rebuild + drifted-toolchain attack surface
  is non-zero — a malicious npm post-install hook on a transitive
  dep gains code-exec on prod during every deploy.
- Doesn't solve the "what if the node version on prod drifts from
  CI's node version" class of bug (Option A pins via Docker base
  image).

## Recommendation

**Option A** is the right long-term posture. **Option B** is the
fast path that the autopilot can execute today autonomously.

If launch ≤ 30 days, recommend **Option B now → Option A as a
Q3 2026 hardening project** once paid customer traffic is online
and the bare-metal-to-docker cutover risk justifies an operator-
pair scheduled window. If launch ≥ 60 days, do Option A now while
risk is cheap (no customers to disrupt).

**The autopilot can fire Option B autonomously per Tier-1 directive
on operator OK.** Option A needs operator-driven steps 1-3 + 5-6.

## What's deployable today regardless

- `scripts/deploy-bridge.sh` works against both servers, 30-60s
  per deploy, post-deploy-verify catches regressions.
- `scripts/revert-bridge.sh` reverts to `.last-good-sha`.
- All prod commits this session shipped via deploy-bridge.sh.
- No deploy is BLOCKED by this verdict — only the "git push auto-
  deploys" affordance is missing.
