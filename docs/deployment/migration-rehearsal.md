# Database migration rehearsal

V-198 — standing procedure for rehearsing Drizzle migrations against
production-shape data before they land in prod. Pre-launch most
migrations have been free (empty tables, no users), but every
migration that runs against a non-empty production table from
commercial activation onwards must follow this checklist.

> **Effective date**: every migration after the first paying customer.
> Before commercial activation, migrations land directly per the
> standard push-to-main pattern (no rehearsal — production is empty).

## Why rehearsal matters here

We use Neon as the Postgres host. Neon supports point-in-time branch
creation, which gives us a "production-shape data, isolated DB" target
for free — no separate staging-data-refresh procedure required. The
cost of skipping rehearsal at our scale is mostly DDL-lock-table
surprise: a `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT <expr>`
that holds an exclusive lock for minutes on a 50M-row table is the
class of incident this rehearsal is designed to catch.

## Pre-flight: classify the migration

Before doing anything else, classify what's about to land:

- **Class A — safe (additive, nullable columns; new tables; new
  indexes with `CREATE INDEX CONCURRENTLY`)**: minimal lock impact;
  rehearsal optional but a good habit.
- **Class B — locking (NOT NULL columns with a default backfill;
  type changes; renames; FK additions to non-empty tables)**:
  rehearsal required. Time the migration on a Neon branch first.
- **Class C — destructive (DROP COLUMN; DROP TABLE; data
  transformations that can't be reversed without restoring a
  backup)**: rehearsal required + explicit founder approval before
  running in production. Double-confirm rollback plan.

Drizzle generates the migration SQL for us, but Drizzle does **not**
classify migrations. Read every generated `.sql` file before
labelling. When unsure, treat as one class higher.

## Standard rehearsal sequence

### 1. Snapshot production via Neon branching

In the Neon dashboard:

1. Navigate to the production project.
2. Branches → Create branch → "from current state of `main`" (or
   from a specific point-in-time if you want to isolate from
   in-flight writes).
3. Name the branch `mig-<NNNN>-rehearsal-YYYYMMDD` (e.g.
   `mig-0017-rehearsal-20260601`).
4. Copy the connection string for the branch.

### 2. Run the migration against the branch

```bash
# Point Drizzle at the branch DB
export DATABASE_URL='<neon-branch-connection-string>'

# Run the migration
npx drizzle-kit migrate

# Note the wall time. For Class B / C migrations, this is the
# expected production-side downtime window for the locked tables.
```

If the migration takes >30 seconds against the branch with
production-shape data, treat it as a maintenance-window deploy —
don't drop it during peak customer traffic.

### 3. Verify post-migration invariants

For Class B / C migrations, manually check that the post-state
matches expectations. Examples:

- New NOT NULL column: every existing row got the backfill default.
  `SELECT count(*) FROM table WHERE col IS NULL` should be 0.
- Renamed column: code paths using the new name return the same
  data they did with the old name.
- Type changes: representative SELECT samples render correctly.
- FK addition: `SELECT count(*) FROM child LEFT JOIN parent ON ...
WHERE parent.id IS NULL` should be 0 (no orphans).

### 4. Run the test suite against the branch

```bash
DATABASE_URL='<neon-branch-connection-string>' npm test
```

Vitest exercises the Drizzle code paths against the migrated schema.
A pass here doesn't prove production correctness, but a fail catches
any obvious schema/code mismatch before the prod deploy.

### 5. Document the rehearsal

Append a note to the V-log entry that's landing the migration:

```markdown
### Rehearsal

- Branch: `mig-0017-rehearsal-20260601`
- Wall time on production-shape data: 8.4s (Class B).
- Post-state invariants verified: <list>.
- Test suite against branch: 652/652 passing.
```

### 6. Land the migration in production

For Class A: standard push-to-main; the migration runs on next
deploy.

For Class B / C: schedule a maintenance window. Notify customers if
the wall time exceeds the latency they'd notice (>1s of
read-blocking on a hot path is a notice-worthy event).

Keep the rehearsal Neon branch alive for ~24 hours after the prod
migration lands as a fallback target.

### 7. Drop the rehearsal branch

After the prod migration is confirmed stable (no rollback signals,
test suite passing in prod, no customer reports), delete the
rehearsal branch via the Neon dashboard. Branches cost storage; don't
accumulate them.

## Rollback strategy by class

- **Class A**: rollback = run a reverse migration that drops the
  added column / table / index. Drizzle doesn't auto-generate
  reverse migrations; write the SQL manually if needed.
- **Class B**: rollback is more painful. NOT NULL → nullable is
  always reversible via `ALTER TABLE ... ALTER COLUMN ... DROP NOT
NULL`. Type widening is reversible via narrowing only if no rows
  exceed the narrower bounds. Type narrowing is generally not
  reversible.
- **Class C**: there is no in-place rollback. The recovery path is
  point-in-time restore from Neon to before the migration ran. This
  is why Class C requires explicit founder approval AND a confirmed
  point-in-time target before running.

## Lock-contention monitoring during deploy

On the Hetzner host while the migration runs:

```sql
-- In a separate psql session against the prod DB
SELECT pid, locktype, mode, granted, query_start, state, query
FROM pg_locks
JOIN pg_stat_activity USING (pid)
WHERE NOT granted;
```

Sustained `granted=false` rows for more than a few seconds indicate
the migration is blocking foreground queries. If this happens during
a Class B migration that was supposed to be sub-second, abort the
deploy and re-rehearse — production data has clearly grown faster
than the rehearsal branch reflected.

## What this doc does NOT cover

- **Schema drift detection** — Drizzle's introspection diff catches
  schema drift between the migration files and the live DB; not a
  rehearsal concern.
- **Application-level migrations** (data backfills via service code,
  not SQL). Those follow a separate pattern: feature-flag, dual-
  write, backfill, dual-read, single-read — out of scope for this
  doc.
- **DR scenarios** — see `docs/deployment/runbook.md`.

## Related

- Drizzle migrations: `apps/server/src/db/migrations/*.sql`
- Drizzle config: `drizzle.config.ts` (repo root; `npm run db:generate` /
  `db:studio` run from there, and `npm run db:migrate` in `apps/server`
  applies them via `apps/server/src/db/migrate.ts`)
- Operational runbook: `docs/deployment/runbook.md` (incident plays,
  not migration rehearsal)
- Env-var schema: `docs/deployment/env-vars.md` (DATABASE_URL is
  authoritative)
