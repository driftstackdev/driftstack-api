# TD-002 — Drizzle-kit reinstatement proposal

**Status:** Tier 2 draft — surfaces for founder ack on the snapshot/journal cleanup approach.
**Source:** TD-002 in `docs/tech-debt.md` (V-228 follow-up).
**Decision needed:** Founder picks Option A vs Option B for the snapshot-recovery path before any code lands.

## Context

V-228 caught that migrations 0017 / 0018 / 0019 were missing from `_journal.json`. The fix appended their entries by hand. V-202c added 0020 + journal entry; V-202d added 0021 + journal entry. The journal is now correct through idx 21.

The remaining gap is the **snapshot directory**: `meta/0000_snapshot.json` through `meta/0006_snapshot.json` exist; `meta/0007_*.json` through `meta/0021_*.json` do **NOT** exist. Snapshots are how `drizzle-kit generate` knows what each migration changed; without them, `drizzle-kit generate` can only diff against `0006_snapshot.json` (the last one present), producing one giant catch-all migration that "brings the schema up to current state from 0006."

Today, the codebase manages this gap by hand-editing the journal whenever a new migration lands. V-228 demonstrated this is fragile — three migrations slipped past unnoticed for multiple commits before the catch.

## Two options

### Option A — Accept the snapshot gap; one consolidated catch-up migration

1. Install `drizzle-kit` in `apps/server/package.json` devDeps.
2. Add `drizzle.config.ts` pointing at `src/db/schema.ts` + `src/db/migrations/`.
3. Run `drizzle-kit generate` against the current schema.
4. Drizzle-kit produces ONE new migration (call it `0022_consolidate_snapshot.sql`) representing the cumulative diff from snapshot 0006 to current schema. The SQL inside will be a series of `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN` statements that are idempotent against a database that's already had migrations 0007–0021 applied.
5. Drizzle-kit ALSO produces `meta/0022_snapshot.json` representing current schema state.
6. The journal gets `idx 22` appended automatically by drizzle-kit.

**Outcome:** future `drizzle-kit generate` calls work cleanly because there's now a snapshot it can diff against. The historical 0007-0021 snapshots are permanently absent from `meta/`, but the journal idx + tag entries reference the actual SQL files which are still applicable. The 0022 migration is a no-op in production (everything already exists with `IF NOT EXISTS` guards) but a fresh deploy from migrations 0000 + 0022 alone wouldn't work — fresh deploys need 0000–0021 applied in sequence first, then 0022 as a no-op trailer.

**Risk:** Someone reading the migrations directory might think 0022 is a meaningful schema change. Solved by clear comment in the SQL.

**Effort:** ~30min (install + generate + verify the consolidated SQL is idempotent + commit).

### Option B — Backfill all missing snapshots

1. Install `drizzle-kit` per Option A.
2. Add `drizzle.config.ts`.
3. For each migration 0007–0021: hand-create a `meta/<idx>_snapshot.json` file representing the schema state AFTER that migration.

   Practical flow: drop and recreate snapshots by running `drizzle-kit generate` repeatedly with each migration's schema state. The hard part is that drizzle-kit doesn't have a "snapshot at this point in history" mode — it always generates the diff from the latest snapshot. So this requires either checking out historical commits (ugly because schema.ts has been incrementally extended) or hand-writing each snapshot JSON by inspection.

4. Validate by running `drizzle-kit generate` after backfill: it should produce a clean "no changes" output.

**Outcome:** Snapshot directory is complete + accurate. Future drizzle-kit usage is clean. Historical record is honest.

**Risk:** ~14 hand-written snapshots is a lot of fiddly JSON; mistakes silently accumulate. Drizzle-kit's snapshot format isn't documented for hand-editing.

**Effort:** ~3-4hr.

## Recommendation: Option A

Reasoning:

- **Cost/benefit favors A.** The cost of the snapshot gap is "drizzle-kit generate produces a giant first-time diff." That cost is paid ONCE, when reinstating drizzle-kit. After that, every future migration produces clean diffs because the gap is filled.
- **Option B's cost is high + ongoing.** Hand-writing 14 snapshots is fragile. If any one is wrong, drizzle-kit generates spurious diffs forever.
- **Production impact is identical.** Both options leave the production schema state unchanged. Both produce the same go-forward auto-update behavior.
- **The "honest history" argument for B is weak.** The journal already records what migrations applied; that's the operational source of truth. Snapshots are a drizzle-kit ergonomics asset, not a historical record.

## What lands in the recommended commit

1. `apps/server/package.json` — add `"drizzle-kit": "^0.x"` (latest minor) to `devDependencies`.
2. New `apps/server/drizzle.config.ts`:

   ```ts
   import { defineConfig } from 'drizzle-kit';
   export default defineConfig({
     schema: './src/db/schema.ts',
     out: './src/db/migrations',
     dialect: 'postgresql',
   });
   ```

3. New `apps/server/src/db/migrations/0022_consolidate_snapshot.sql` — auto-generated; manually inspect for safety (every statement should be `IF NOT EXISTS` / `IF NOT EXISTS …`); add header comment explaining the consolidation.
4. New `apps/server/src/db/migrations/meta/0022_snapshot.json` — auto-generated.
5. Updated `apps/server/src/db/migrations/meta/_journal.json` — auto-updated by drizzle-kit with idx 22.
6. New `npm run drizzle:generate` script in workspace package.json so future schema changes get a one-command path.
7. **Pre-push hook update (V-223)** — add a check that fails if a new `*.sql` in `migrations/` lacks a journal entry. Code: `git diff --name-only origin/main HEAD -- 'apps/server/src/db/migrations/*.sql' | while read f; do tag=$(basename "$f" .sql); grep -q "\"tag\": \"$tag\"" apps/server/src/db/migrations/meta/_journal.json || (echo "missing journal entry for $f"; exit 1); done`.

The pre-push backstop is the actual structural defense against V-228-class regressions; the drizzle-kit reinstatement is the ergonomics improvement that prevents the "did I update the journal?" question from arising in the first place.

## Verify

After the commit lands, the verification step is:

1. `npx drizzle-kit generate` — should report "no changes" (schema matches the just-generated 0022 snapshot).
2. `npm run test:e2e --workspace apps/server` — should apply all 22 migrations cleanly against a fresh Postgres. (Same flag as V-228 — needs Docker.)
3. Pre-push hook should refuse a synthetic commit that adds a `*.sql` without a journal entry. Test with a throwaway branch.

## Decision request

Founder: A, B, or some other shape? Recommend (A) per cost/benefit above.
