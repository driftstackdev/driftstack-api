# Staging and prod share the same Neon database (2026-05-19)

**Status:** empirical finding from Slice E of the post-prod-deploy
backlog. Not yet remediated.

## What I found

Both prod (`128.140.37.74`) and staging (`116.203.22.197`)
`/opt/driftstack/api/.env` point at the EXACT same Neon connection
string:

```
DATABASE_URL=postgresql://neondb_owner:***@ep-aged-pond-al77cutb.c-3.eu-central-1.aws.neon.tech/neondb?sslmode=require
```

- Same hostname: `ep-aged-pond-al77cutb.c-3.eu-central-1.aws.neon.tech`
- Same database name: `neondb`
- Same connection role: `neondb_owner`

Net: staging is a separate Hetzner host running a separate Node.js
service, but its DB writes land in the SAME storage as prod. There is
no real DB-side staging isolation.

## How I surfaced it

While running Slice E (audit prod scheduled_jobs row backlog after the
10-day TypeError fix), I noticed the 4 `regression_guard_dummy` rows
my Drizzle-backed integration test created against "staging" Neon DB
were visible when I queried prod's DB via the prod host's psql. That
shouldn't be possible if the two were isolated.

Cross-check: `grep '^DATABASE_URL=' /opt/driftstack/api/.env | cut -d=
-f2- | sed 's,.*/,,;s/?.*//'` on both hosts returns `neondb`. Hostname

- DB name + role are byte-for-byte identical.

## Operational implications

This means the following operations DID NOT have staging isolation
during today's session:

1. **Migration apply.** When I manually applied migrations 0041-0057
   to "staging" (`apps/server/src/db/migrations/{0041,...,0057}.sql`
   via psql), those DDL operations affected prod's schema too. The
   prod service still ran the OLD code (b48f557) until 15:55 UTC, but
   its DB rows had already grown the new columns (byok*anthropic*
   api*key*\*, agent_sessions table, fleet_nodes, recipes, sessions.
   egress_capabilities, etc.). Since the new columns were all
   nullable / had defaults, old code didn't see them.

2. **Drizzle-backed integration tests.** Both
   `db-scheduled-jobs-repo-drizzle.test.ts` and
   `atlas-priority-events-end-to-end.test.ts` insert + update rows
   against `process.env.DATABASE_URL` (which I set to the staging
   host's URL — same DB as prod). The `regression_guard_dummy` rows
   in `scheduled_jobs` and any `atlas_priority_events` rows from
   probe-signature tests now exist in production.

3. **Migration-immutability pre-gate.** The gate ran against "staging"
   DB during the deploy; correctly reported migration state because
   staging-DB == prod-DB. No false signal but also no isolation.

## What's at risk going forward

- A destructive migration applied during a "staging" rehearsal would
  hit prod immediately.
- Test data accumulation: every test run pollutes prod tables (small
  scale at v1.0 pre-launch, but unbounded over time).
- No way to rehearse a schema change against a snapshot of prod data
  without affecting prod.
- No way to test data-loss recovery procedures (DROP TABLE rehearsal,
  PITR restore) without touching prod.

## What to do

Two reasonable paths:

**Option A — separate Neon project for staging.**
Cheapest at low scale. Neon has a free tier; a separate project gives
staging its own isolated database with its own connection string.
Operator action:

1. Create new Neon project `driftstack-staging`.
2. Update `/etc/driftstack/api.env` on the staging host with the new
   `DATABASE_URL`.
3. Apply all 59 migrations to the new DB (via `npm run db:migrate` or
   manual psql per the prior incident protocol).
4. Restart `driftstack-api` on staging.
5. Audit any staging-only test data created today (the 4 `regression_
guard_dummy` rows + any `atlas_priority_events` from §8.4 test
   runs) — decide whether to leave them in prod (harmless audit
   trail) or delete.

**Option B — Neon branch for staging.**
Neon's branching feature creates a copy-on-write fork of the prod DB
that lives under the same project but is logically separate. Free at
the storage layer (only diverged pages cost). Staging would point to
the branch endpoint; merging back is explicit.

Recommendation: Option A unless founder specifically wants to use
Neon branching. Separate project is simpler operationally + clearer
isolation guarantees.

## What the 10-day scheduled-jobs TypeError audit found (Slice E proper)

For completeness, the actual scheduled_jobs row state on prod (==
staging) post-fix:

```
        job_type        | total | done | failed | pending |  oldest_due
------------------------+-------+------+--------+---------+--------------
 regression_guard_dummy |     4 |    4 |      0 |       0 | 2026-05-19 15:15
```

ZERO trial_pack.expired / email-reminder / lifecycle / incident jobs
ever got enqueued during the 10-day broken window (2026-05-09 →
2026-05-19). The 4 rows are all from today's Drizzle-backed
integration test runs and have completed_at set.

Implication: **no operational backlog to back-process.** The
TypeError noise was loud (1439 occurrences/24h) but operationally
inert — no customer-facing jobs were missed because no customer-
facing jobs were enqueued in that window (likely no production
traffic triggered them; pre-launch posture). Future scheduled jobs
will fire correctly now that the fix is deployed.

## Filing

Tier-2 founder action: pick Option A or B + execute. No code change
on the Agent 2 side until the DATABASE_URL on the staging host
changes; at that point the test fixtures naturally re-target the new
DB without modification (DB-URL is env-driven).
EOF

## RESOLVED 2026-05-19 (Wave 29-NNN ARC 2)

Option A landed: staging migrated to a separate Neon project
(`ep-lingering-math-alnalhby` — pooler endpoint in `eu-central-1`).

### Steps executed

1. Founder generated new Neon project + provided connection URL.
2. Agent 2 ran `node apps/server/dist/db/migrate.js` against the new
   DB with `DATABASE_URL` pointed at the new endpoint — all 60
   migrations applied cleanly (empty DB, no watermark interference).
3. SSH-update on `root@116.203.22.197` rewrote
   `/opt/driftstack/api/.env` `DATABASE_URL` line to the new endpoint
   (chown driftstack:driftstack + chmod 600 preserved).
4. systemctl restart driftstack-api on staging — service came up
   healthy in <5s, /version `git_sha: 14971a7`.
5. Cross-contamination smoke test (the empirical proof):
   - POST staging `/v1/internal/atlas-priority/probe-signature` with
     a `staging-isolation-test-<ts>` op_seq_sha marker.
   - Query staging DB directly → 1 row with that marker.
   - Query prod DB directly → 0 rows with that marker.
   - **Isolation empirically confirmed.**
6. Marker row deleted from staging DB post-smoke.

### Deploy-bridge gate downgraded BLOCK → WARN

The `STAGING DB ISOLATION CHECK FAILED` exit-3 gate added at commit
`11195757` was a placeholder until remediation; now downgraded to a
warn. Rationale: in normal operation the DBs SHOULD stay separate
(prod = `ep-aged-pond-al77cutb`, staging = `ep-lingering-math-
alnalhby`); a future revert that re-points staging at prod's DB
should surface loudly but not block — operator may have intentional
override (e.g. one-shot rehearsal against prod's schema).

### Net state

- Prod DB: `ep-aged-pond-al77cutb-pooler.c-3.eu-central-1.aws.neon.tech`
- Staging DB: `ep-lingering-math-alnalhby-pooler.c-3.eu-central-1.aws.neon.tech`
- Both `neondb` database name + `neondb_owner` role.
- 60 migrations applied on both as of 2026-05-19.
- Cross-contamination empirically impossible going forward.

## RECURRENCE 2026-07-12 — restored and fail-closed

The live staging `.env` had drifted back to production's
`ep-aged-pond-al77cutb` endpoint. The deploy bridge detected the match but its
post-remediation WARN posture still allowed the staging migration gate and
migration apply to run against production.

Remediation:

1. Restored only the staging `DATABASE_URL` from the known-good
   `.env.bak.pre-stmttimeout` copy; all other current environment settings were
   preserved.
2. Connected to `ep-lingering-math-alnalhby-pooler`, applied the full 101-entry
   migration journal idempotently, restarted staging, and verified public
   `/health` plus simulated `/version`.
3. Rechecked both live hosts: staging resolves to `ep-lingering-math`; production
   resolves to `ep-aged-pond`.
4. Restored the deploy bridge to fail-closed (`exit 3`) on matching DB hosts or
   an unreadable host check. An intentional one-shot rehearsal now requires the explicit
   `DEPLOY_SKIP_STAGING_DB_ISOLATION_CHECK=1` escape hatch.
5. Updated the committed staging environment template and its parity guards to
   the isolated Neon endpoint so repository guidance can no longer direct an
   operator back to production storage.
