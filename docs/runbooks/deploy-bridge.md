# deploy-bridge + revert-bridge runbook

Operator-facing summary of the manual-SSH-deploy + auto-revert
toolchain that bridges the docker-compose-vs-systemd mismatch (see
`docs/internal/2026-05-15-deploy-pipeline-mismatch.md`).

## TL;DR — three commands

```sh
bash scripts/deploy-status.sh                # read-only snapshot of both servers
bash scripts/deploy-bridge.sh staging        # deploy origin/main to staging
bash scripts/revert-bridge.sh --dry-run prod # preview revert target + recent history
```

`deploy-status.sh` is read-only and always safe.

## When to use

- Shipping any code change that needs to be live on prod or staging,
  while the verdict on Option A / Option B from the deploy-pipeline-
  mismatch doc is outstanding.
- Validating staging changes before prod. Default is `--dry-run` for
  revert; deploy-bridge has no dry-run because the rollback safety
  net (V-549.B auto-revert + `.last-good-sha`) makes execute-mode
  safe.

## Deploy

```sh
# Deploy whatever's on origin/main to staging:
bash scripts/deploy-bridge.sh staging

# After V-507 60-min soak, roll to prod:
bash scripts/deploy-bridge.sh prod

# Deploy a specific SHA (must be on origin or remote-reachable):
bash scripts/deploy-bridge.sh prod abc1234
```

The script clones origin, builds with `npm ci`, applies pending DB
migrations, atomic-swaps the dist into `/opt/driftstack/api/`,
upserts `GIT_SHA` into `.env`, restarts the systemd unit, polls
`/health`, then fires `scripts/post-deploy-verify.mjs` against the
public origin. On post-deploy-verify FAIL, **auto-fires
`revert-bridge.sh`** to roll back to the last-known-good SHA.

End-state guarantee: prod is always at a SHA that passed all 8
post-deploy-verify invariants when it landed.

## Revert (manual; auto-revert handles regression cases)

```sh
# Preview what SHA revert would target:
bash scripts/revert-bridge.sh --dry-run prod

# Actually revert:
bash scripts/revert-bridge.sh prod
```

`revert-bridge.sh` reads `/opt/driftstack/api/.last-good-sha` from
the target host and delegates back to `deploy-bridge.sh` with that
SHA as the explicit argument. AUTO_REVERT=0 is set inside the
revert so a bad last-good-sha doesn't recurse infinitely.

## Deploy history

Every successful deploy appends one line to
`/opt/driftstack/api/.deploy-history.log` on the host:

```
<iso-utc> <SHA> <prev-SHA-or-fresh> <elapsed-s>
```

- "what was running at 04:32 UTC?" → `cat .deploy-history.log | grep 04:32`
- "are we thrashing on this SHA?" → same SHA appearing as both new
  - prev in adjacent rows = revert thrash.

File grows at ~80 bytes/deploy. No rotation needed.

## V-507 staging soak

Production rollouts are gated on staging being green for at least
60 minutes per V-507 founder posture. **The script does not
enforce this** — operator's responsibility. Run
`bash scripts/deploy-bridge.sh staging`, wait, check Sentry /
status, then `bash scripts/deploy-bridge.sh prod`.

## Common failures

- **`MODULE_NOT_FOUND require-in-the-middle`**: would have indicated
  npm install dropped transitive deps. Fixed at commit `5a67945` —
  the bridge now uses `npm ci` (lockfile-strict). Don't switch back.
- **`Refusing to boot: DASHBOARD_ORIGIN must be set`**: env var
  missing on the target. See `project_dashboard_origin_single_source`
  memory entry. SSH-write `DASHBOARD_ORIGIN=` to `.env`, chmod 600,
  restart.
- **`/version git_sha does not match expected`**: SHA-resolution
  race. Fixed at commit `bdabba6` — deploy-bridge now fetches
  origin/main before computing `EXPECTED_SHORT_SHA`. If you hit it
  in older script versions, retry once after `git fetch origin`.
- **Auto-revert fires after a deploy**: post-deploy-verify caught a
  regression. Don't try to redeploy the bad SHA — first look at
  `/opt/driftstack/api/.deploy-history.log` to confirm the revert
  succeeded, then investigate the verify failure (likely route
  registration / openapi drift / version mismatch).

## What's NOT this script

- DB migrations OUTSIDE the deploy path — the bridge runs
  `node apps/server/dist/db/migrate.js` automatically; never run
  migrations manually on prod.
- Env-var rotation — that's manual SSH to write `/opt/driftstack
/api/.env` then `systemctl restart driftstack-api`. No deploy needed.
- Status-site / customer-dashboard / docs — those auto-deploy on
  push via Cloudflare Pages workflows. The bridge is API-server only.
