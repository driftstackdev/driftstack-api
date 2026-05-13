// W569.C — drift guard for /docs/proposals/td-002-drizzle-kit-reinstatement.md.
// TD-002 Tier-2-draft proposal. Drift here either re-weights the
// Option-A vs Option-B recommendation, drops the V-228 catch-three-
// migrations-missing context, or unsets the pre-push hook backstop
// against V-228-class regressions.
//
//   • TD-002. Tier 2 draft. V-228 follow-up.
//   • Decision: A (catch-up 0022) vs B (backfill 14 snapshots).
//   • Recommendation: A on cost/benefit grounds.
//   • Pre-push hook V-223 is the structural defense.
//   • Verify: npx drizzle-kit generate → "no changes"

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/proposals/td-002-drizzle-kit-reinstatement.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W569.C /docs/proposals/td-002-drizzle-kit-reinstatement.md content parity', () => {
  const body = read(LIB);

  it('Header + Tier-2-draft + V-228-follow-up + decision-needed + 0017/0018/0019-gap context framing pinned', () => {
    expect(body).toMatch(/^# TD-002 — Drizzle-kit reinstatement proposal$/m);
    expect(body).toMatch(
      /\*\*Status:\*\* Tier 2 draft — surfaces for founder ack on the snapshot\/journal cleanup approach\./,
    );
    expect(body).toMatch(/\*\*Source:\*\* TD-002 in `docs\/tech-debt\.md` \(V-228 follow-up\)\./);
    expect(body).toMatch(
      /\*\*Decision needed:\*\* Founder picks Option A vs Option B for the snapshot-recovery path before any code lands\./,
    );
    expect(body).toMatch(
      /V-228 caught that migrations 0017 \/ 0018 \/ 0019 were missing from `_journal\.json`\./,
    );
    expect(body).toMatch(/The fix appended their entries by hand\./);
    expect(body).toMatch(
      /V-202c added 0020 \+ journal entry; V-202d added 0021 \+ journal entry\./,
    );
    expect(body).toMatch(/The journal is now correct through idx 21\./);
    expect(body).toMatch(
      /The remaining gap is the \*\*snapshot directory\*\*: `meta\/0000_snapshot\.json` through `meta\/0006_snapshot\.json` exist;/,
    );
    expect(body).toMatch(
      /`meta\/0007_\*\.json` through `meta\/0021_\*\.json` do \*\*NOT\*\* exist\./,
    );
    expect(body).toMatch(
      /Snapshots are how `drizzle-kit generate` knows what each migration changed;/,
    );
    expect(body).toMatch(
      /Today, the codebase manages this gap by hand-editing the journal whenever a new migration lands\./,
    );
    expect(body).toMatch(
      /V-228 demonstrated this is fragile — three migrations slipped past unnoticed for multiple commits before the catch\./,
    );
  });

  it('Option A consolidated catch-up + Option B backfill framing pinned', () => {
    expect(body).toMatch(
      /### Option A — Accept the snapshot gap; one consolidated catch-up migration/,
    );
    expect(body).toMatch(/1\. Install `drizzle-kit` in `apps\/server\/package\.json` devDeps\./);
    expect(body).toMatch(
      /2\. Add `drizzle\.config\.ts` pointing at `src\/db\/schema\.ts` \+ `src\/db\/migrations\/`\./,
    );
    expect(body).toMatch(/3\. Run `drizzle-kit generate` against the current schema\./);
    expect(body).toMatch(
      /4\. Drizzle-kit produces ONE new migration \(call it `0022_consolidate_snapshot\.sql`\)/,
    );
    expect(body).toMatch(/representing the cumulative diff from snapshot 0006 to current schema\./);
    expect(body).toMatch(
      /The SQL inside will be a series of `CREATE TABLE IF NOT EXISTS` \/ `ALTER TABLE … ADD COLUMN` statements that are idempotent/,
    );
    expect(body).toMatch(
      /5\. Drizzle-kit ALSO produces `meta\/0022_snapshot\.json` representing current schema state\./,
    );
    expect(body).toMatch(/6\. The journal gets `idx 22` appended automatically by drizzle-kit\./);
    expect(body).toMatch(
      /\*\*Outcome:\*\* future `drizzle-kit generate` calls work cleanly because there's now a snapshot it can diff against\./,
    );
    expect(body).toMatch(
      /The 0022 migration is a no-op in production \(everything already exists with `IF NOT EXISTS` guards\)/,
    );
    expect(body).toMatch(/but a fresh deploy from migrations 0000 \+ 0022 alone wouldn't work/);
    expect(body).toMatch(
      /\*\*Risk:\*\* Someone reading the migrations directory might think 0022 is a meaningful schema change\./,
    );
    expect(body).toMatch(/Solved by clear comment in the SQL\./);
    expect(body).toMatch(
      /\*\*Effort:\*\* ~30min \(install \+ generate \+ verify the consolidated SQL is idempotent \+ commit\)\./,
    );
    expect(body).toMatch(/### Option B — Backfill all missing snapshots/);
    expect(body).toMatch(
      /3\. For each migration 0007–0021: hand-create a `meta\/<idx>_snapshot\.json` file representing the schema state AFTER that migration\./,
    );
    expect(body).toMatch(
      /Practical flow: drop and recreate snapshots by running `drizzle-kit generate` repeatedly/,
    );
    expect(body).toMatch(
      /The hard part is that drizzle-kit doesn't have a "snapshot at this point in history" mode/,
    );
    expect(body).toMatch(
      /4\. Validate by running `drizzle-kit generate` after backfill: it should produce a clean "no changes" output\./,
    );
    expect(body).toMatch(
      /\*\*Outcome:\*\* Snapshot directory is complete \+ accurate\. Future drizzle-kit usage is clean\. Historical record is honest\./,
    );
    expect(body).toMatch(
      /\*\*Risk:\*\* ~14 hand-written snapshots is a lot of fiddly JSON; mistakes silently accumulate\./,
    );
    expect(body).toMatch(/Drizzle-kit's snapshot format isn't documented for hand-editing\./);
    expect(body).toMatch(/\*\*Effort:\*\* ~3-4hr\./);
  });

  it('Recommendation A + what-lands + pre-push-hook-V-223 + verify + decision-request framing pinned', () => {
    expect(body).toMatch(/## Recommendation: Option A/);
    expect(body).toMatch(
      /- \*\*Cost\/benefit favors A\.\*\* The cost of the snapshot gap is "drizzle-kit generate produces a giant first-time diff\."/,
    );
    expect(body).toMatch(/That cost is paid ONCE, when reinstating drizzle-kit\./);
    expect(body).toMatch(
      /- \*\*Option B's cost is high \+ ongoing\.\*\* Hand-writing 14 snapshots is fragile\./,
    );
    expect(body).toMatch(/If any one is wrong, drizzle-kit generates spurious diffs forever\./);
    expect(body).toMatch(
      /- \*\*Production impact is identical\.\*\* Both options leave the production schema state unchanged\./,
    );
    expect(body).toMatch(
      /- \*\*The "honest history" argument for B is weak\.\*\* The journal already records what migrations applied;/,
    );
    expect(body).toMatch(/Snapshots are a drizzle-kit ergonomics asset, not a historical record\./);
    expect(body).toMatch(/## What lands in the recommended commit/);
    expect(body).toMatch(
      /1\. `apps\/server\/package\.json` — add `"drizzle-kit": "\^0\.x"` \(latest minor\) to `devDependencies`\./,
    );
    expect(body).toMatch(/2\. New `apps\/server\/drizzle\.config\.ts`:/);
    expect(body).toMatch(/import \{ defineConfig \} from 'drizzle-kit';/);
    expect(body).toMatch(/export default defineConfig\(\{/);
    expect(body).toMatch(/schema: '\.\/src\/db\/schema\.ts',/);
    expect(body).toMatch(/out: '\.\/src\/db\/migrations',/);
    expect(body).toMatch(/dialect: 'postgresql',/);
    expect(body).toMatch(
      /3\. New `apps\/server\/src\/db\/migrations\/0022_consolidate_snapshot\.sql` — auto-generated;/,
    );
    expect(body).toMatch(
      /manually inspect for safety \(every statement should be `IF NOT EXISTS` \/ `IF NOT EXISTS …`\);/,
    );
    expect(body).toMatch(/add header comment explaining the consolidation\./);
    expect(body).toMatch(
      /4\. New `apps\/server\/src\/db\/migrations\/meta\/0022_snapshot\.json` — auto-generated\./,
    );
    expect(body).toMatch(
      /5\. Updated `apps\/server\/src\/db\/migrations\/meta\/_journal\.json` — auto-updated by drizzle-kit with idx 22\./,
    );
    expect(body).toMatch(/6\. New `npm run drizzle:generate` script in workspace package\.json/);
    expect(body).toMatch(
      /7\. \*\*Pre-push hook update \(V-223\)\*\* — add a check that fails if a new `\*\.sql` in `migrations\/` lacks a journal entry\./,
    );
    expect(body).toMatch(
      /The pre-push backstop is the actual structural defense against V-228-class regressions;/,
    );
    expect(body).toMatch(
      /the drizzle-kit reinstatement is the ergonomics improvement that prevents the "did I update the journal\?" question from arising in the first place\./,
    );
    expect(body).toMatch(/## Verify/);
    expect(body).toMatch(
      /1\. `npx drizzle-kit generate` — should report "no changes" \(schema matches the just-generated 0022 snapshot\)\./,
    );
    expect(body).toMatch(
      /2\. `npm run test:e2e --workspace apps\/server` — should apply all 22 migrations cleanly against a fresh Postgres\./,
    );
    expect(body).toMatch(
      /3\. Pre-push hook should refuse a synthetic commit that adds a `\*\.sql` without a journal entry\./,
    );
    expect(body).toMatch(/## Decision request/);
    expect(body).toMatch(
      /Founder: A, B, or some other shape\? Recommend \(A\) per cost\/benefit above\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
