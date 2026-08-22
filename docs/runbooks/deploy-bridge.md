# deploy-bridge + revert-bridge runbook

Operator-facing summary of the manual-SSH-deploy + auto-revert
toolchain that bridges the docker-compose-vs-systemd mismatch (see
`docs/internal/2026-05-15-deploy-pipeline-mismatch.md`).

## TL;DR — three commands

```sh
bash scripts/deploy-status.sh                # read-only snapshot of both servers
bash scripts/deploy-status.sh --check        # exit non-zero on any of its 4 --check refusals
bash scripts/deploy-bridge.sh staging        # deploy origin/main to staging
bash scripts/revert-bridge.sh --dry-run prod # preview revert target + recent history
bash scripts/revert-bridge.sh --to-sha <sha> prod  # operator override: revert to an explicit SHA
```

`deploy-status.sh` is read-only and always safe. `--check` is the
shape to wire into cron / monitoring (`|| alert`). It emits **4
--check refusals**:

1. an activation flag (`sentry`/`email`/`livekit`/`oauthClient`) is
   not `true` on some target;
2. the on-disk `_journal.json` entry count does not match the
   `drizzle.__drizzle_migrations` row count (catches the drizzle
   silent-skip class — see "Migration drift" below);
3. the running build is more than `DEPLOY_MAX_BEHIND` commits behind
   this checkout (default 100, overridable so a release train can
   raise it deliberately rather than train operators to ignore a red);
4. the running SHA is unknown to this checkout, so build age cannot be
   judged at all — a shallow clone answering "0 commits behind" would
   be the healthiest-looking output in the file while knowing nothing.

Refusals 3 and 4 exist because the snapshot printed the running SHA
for months without judging it, and production sat 982 commits behind
HEAD unnoticed until a customer incident surfaced it.

`--json` is supported on both `deploy-status.sh` and
`scripts/post-deploy-verify.mjs` for structured tooling output. The
`deploy-status.sh --json` row includes `"migrations":"N/N OK"` or
`"DRIFT expected=N actual=M"`, plus `"commits_behind_head"` and
`"built_on"` (both `"?"` when the running SHA is unknown here).

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

`apps/server/src/db/migrate.ts` carries a post-condition assertion:
after `migrate()` returns, it compares `_journal.json` entries vs the
`drizzle.__drizzle_migrations` row count and exits 2 on mismatch.
Exit 2 from migrate triggers the auto-revert path. This catches the
drizzle-orm silent-skip class where `migrate()` returns success
without actually running every pending migration.

`deploy-bridge.sh` also passes the target's expected EXECUTION POSTURE
(`--expected-driver` / `--expected-agent-execution`), so a drift in how
customer sessions actually run fails the verify and auto-reverts:

| env     | `driver` | `agent_execution` |
| ------- | -------- | ----------------- |
| prod    | `mock`   | `live`            |
| staging | `mock`   | `simulated`       |

`DRIVER=mock` on production is DELIBERATE — the browser work happens on
the fleet, not in-process — which is why this is asserted here rather
than guarded at boot, where refusing mock would brick every prod deploy.
`agent_execution` reports whether the fleet control plane is wired
(`live`) or the stub executor is answering (`simulated`); a production
that quietly reported `simulated` would serve customers the stub's
synthetic per-intent successes while every other probe stayed green.
Both flags are opt-in, so a bare invocation behaves exactly as before.

Because staging reports `simulated`, a staging soak proves boot, routes
and migrations — it can NOT exercise the live agent path.

End-state guarantee: prod is always at a SHA that passed all 23
post-deploy-verify invariants when it landed AND whose migrations
matched the on-disk journal exactly.

## Revert (manual; auto-revert handles regression cases)

```sh
# Preview what SHA revert would target:
bash scripts/revert-bridge.sh --dry-run prod

# Actually revert to last-known-good:
bash scripts/revert-bridge.sh prod

# Operator override — revert to an explicit SHA (bypasses .last-good-sha):
bash scripts/revert-bridge.sh --to-sha abc1234 prod
```

`revert-bridge.sh` reads `/opt/driftstack/api/.last-good-sha` from
the target host and delegates back to `deploy-bridge.sh` with that
SHA as the explicit argument. AUTO_REVERT=0 is set inside the
revert so a bad last-good-sha doesn't recurse infinitely.

Use `--to-sha` when `.last-good-sha` itself points to a bad SHA
(e.g. a regression slipped past post-deploy-verify, became the new
last-good, and the next deploy must skip back two generations).
`--dry-run` exits 0 if no revert is needed (current SHA already
matches last-good) and 2 if a revert is pending.

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
- **`migrate exit 2 — migration post-condition FAIL`**: the drizzle
  silent-skip class bit (see "Migration drift" below). The
  deploy-bridge auto-reverts on exit 2. Investigate by SSHing to the
  host, running the failing migration manually with `psql -f`, then
  inserting the matching row into `drizzle.__drizzle_migrations` with
  the same hash. Re-run the deploy once the on-disk journal and the
  DB row count agree.

## Migration drift

The drizzle-orm migrate runtime occasionally returns success without
actually applying every pending migration on disk — leaving
`_journal.json` ahead of `drizzle.__drizzle_migrations`. Two layers
guard against this:

- **Pre-deploy (cron)**: `bash scripts/deploy-status.sh --quiet --check`
  reports `DRIFT expected=N actual=M` when journal vs DB disagree.
  Cron-wirable: `*/5 * * * * bash scripts/deploy-status.sh --quiet --check || curl …slack…`.
- **Deploy-time**: `apps/server/src/db/migrate.ts` post-condition
  exits 2 when its own migrate() call leaves the counts mismatched.
  `deploy-bridge.sh` auto-reverts on exit 2 via the V-549.B
  `.last-good-sha` path.

Manual recovery procedure if drift is detected:

```sh
ssh root@<host>
sudo -u driftstack bash
set -a; source /opt/driftstack/api/.env; set +a
# Find the missing migration:
psql $DATABASE_URL -c 'select hash from drizzle.__drizzle_migrations order by created_at'
# Compare against _journal.json + meta/0NNN_*.json hashes.
# Apply the missing migration:
psql $DATABASE_URL -f /opt/driftstack/api/apps/server/src/db/migrations/0NNN_<name>.sql
# Insert the row so future migrate() runs skip it correctly:
psql $DATABASE_URL -c "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('<hash>', $(date +%s%3N))"
```

## What's NOT this script

- DB migrations OUTSIDE the deploy path — the bridge runs
  `node apps/server/dist/db/migrate.js` automatically; never run
  migrations manually on prod.
- Env-var rotation — that's manual SSH to write `/opt/driftstack
/api/.env` then `systemctl restart driftstack-api`. No deploy needed.
- Status-site / customer-dashboard / docs — those auto-deploy on
  push via Cloudflare Pages workflows. The bridge is API-server only.
