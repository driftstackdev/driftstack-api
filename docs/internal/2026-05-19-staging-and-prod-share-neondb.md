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
