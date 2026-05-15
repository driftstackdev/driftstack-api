# Deploy pipeline mismatch (discovered 2026-05-15)

Wave 1057 surfaced an infrastructure mismatch the autopilot can't fix
without founder verdict.

## What's happening

- The Hetzner prod server (128.140.37.74) + staging (116.203.22.197)
  run `driftstack-api.service` via **systemd**, calling
  `/usr/bin/node apps/server/dist/index.js` from
  `/opt/driftstack/api/`. No Docker on either box.
- `.github/workflows/deploy.yml` deploy-to-production step expects
  **`docker compose pull` + `docker compose up -d`** at
  `/opt/driftstack/docker-compose.yml`.
- The deploy step is gated on `HETZNER_HOST` / `HETZNER_USER` /
  `HETZNER_SSH_KEY` / `DEPLOY_DOTENV_BASE64` all being set; if any
  are unset, it skips with `exit 0` and the CI run reports "success"
  — but **the binary never updates**.
- /opt/driftstack on prod has NO docker-compose.yml, NO docker, NO
  /opt/driftstack/.env. So even with secrets set, the prod deploy
  step would fail on `docker compose pull`.

## Evidence

- `gh run view 25923059907 --json jobs` reports
  `Deploy to production (manual approval): success` — but the
  running binary is from `Fri 2026-05-15 13:54:55 UTC` (my LIVEKIT
  env-wire restart), with on-disk file from `May 8 19:32`. Last
  effective binary update was the manual deploy that produced
  SHA `3f153e3` (see `/version` endpoint).
- Sentry release tag shown at boot is `85aee83`. That mismatches
  /version's `git_sha`, suggesting the SENTRY_RELEASE env var was
  set at a different point in time than the binary build.
- Local SSH into prod confirms: `docker: command not found`,
  `/opt/driftstack/docker-compose.yml: No such file`.

## Impact

- All Track A/B/D/E/H code commits since SHA `3f153e3` are LANDED
  on origin but NOT deployed to prod. This includes:
  - Track E V-531.B `/v1/sessions/:id/livekit-token` route (the
    LIVEKIT\_\* env vars are wired, but the consumer code isn't on
    the deployed binary — confirmed: route returns 404 in prod).
  - Track H magic-link IP rate-limit (affda641).
  - W1039-W1053 drift-guard tests (test-only, doesn't matter for
    runtime).
  - Track C V-667.C OAuth-client lib (waves 1054-1057).
- CI Deploy keeps reporting "success" while reality stays static.

## Recommended fixes (founder verdict needed)

The mismatch is between deploy.yml's expectations (Docker) and the
server's actual setup (systemd + node). Two paths:

**Option A — make the server match deploy.yml:**

- Install Docker on both Hetzner boxes.
- Install /opt/driftstack/docker-compose.yml that runs the new
  `ghcr.io/driftstackdev/driftstack-api:${IMAGE_TAG}` image.
- Migrate the LIVEKIT\_\* env vars I SSH-wrote into
  `DEPLOY_DOTENV_BASE64` GitHub secret so future deploys carry
  them.
- Disable the `driftstack-api.service` systemd unit; let
  docker compose run the container.

**Option B — make deploy.yml match the server:**

- Rewrite the `Deploy via SSH` step to:
  - `git fetch origin main && git checkout <SHA>` in
    `/opt/driftstack/api/`
  - `npm ci && npm run build --workspace=@driftstack/server`
  - `systemctl restart driftstack-api`
- Keep the env file at `/opt/driftstack/api/.env`.

**Option A is the right long-term posture** (immutable image deploys,
reproducible builds, no node toolchain on prod). But Option B is the
faster path to a working CI Deploy without infrastructure change. The
autopilot has prepared the Docker image side (Dockerfile fixed at
3a6dea01 + 4c737c2b) so Option A is unblocked from the code side.

## What's deployable today

- New `lib/livekit-token.ts` + `routes/sessions-livekit-token.ts` are
  built into the GHCR image as of run 25923059907 (success). They
  just aren't on the running binary because the Hetzner SSH-deploy
  step isn't functioning.
- Manual unblock: SSH-pull the latest commit + rebuild + restart on
  each server. ~5 min per server, low risk.

## Until founder verdicts

The autopilot continues Track C V-667.C OAuth-client implementation
on the code side. When the deploy gap is fixed, all the code lands
in one rollout.
