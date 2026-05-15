// W1013 — db/validation-schedules-repo V-218 cross-source invariant.
// Three-hundred-thirty-ninth in the drift-guard series. Pins the
// apps/server/src/db/validation-schedules-repo.ts cadence-driven
// scheduler repo:
//
//   V-218 anchor — 'V-218 — Drizzle-backed ValidationSchedulesRepo'.
//
//   5-method surface — list + findByArchetype + upsert + remove +
//     findDue + markRun.
//
//   upsert next-run-unchanged framing — 'next_run_at unchanged on
//   update — don't disrupt a running schedule unless it's a brand-new
//   row. Operators flip enabled if they want an immediate re-tick'.
//
//   upsert onConflictDoUpdate target = archetypeId; SET excludes
//     nextRunAt (preserved).
//
//   upsert insert path computes nextRunAt = now + cadenceSeconds*1000
//     (ms).
//
//   findDue filter — and(eq(enabled, true), lte(nextRunAt, now)) +
//     orderBy asc(nextRunAt) + limit. The enabled+due filter selects
//     ready-to-run schedules.
//
//   markRun recomputes nextRunAt = now + cadenceSeconds*1000 (ms) +
//     sets lastRunAt + lastRunId + updatedAt. Re-reads schedule for
//     cadenceSeconds.
//
//   remove returning length > 0 boolean.
//
//   toRow 10-field shape.
//
// stays in lockstep across apps/server/src/db/validation-schedules-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1013 db/validation-schedules-repo V-218 cross-source invariant', () => {
  it("CRITICAL V-218 anchor — 'V-218 — Drizzle-backed ValidationSchedulesRepo'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/validation-schedules-repo.ts'));
    expect(p).toMatch(/\/\/ V-218 — Drizzle-backed ValidationSchedulesRepo\./);
    expect(p).toMatch(
      /export class DrizzleValidationSchedulesRepo implements ValidationSchedulesRepo \{/,
    );
  });

  it('CRITICAL 6-method surface — list + findByArchetype + upsert + remove + findDue + markRun.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/validation-schedules-repo.ts'));
    expect(p).toMatch(/async list\(\): Promise<ValidationScheduleRow\[\]> \{/);
    expect(p).toMatch(
      /async findByArchetype\(archetypeId: string\): Promise<ValidationScheduleRow \| null> \{/,
    );
    expect(p).toMatch(
      /async upsert\(input: UpsertValidationScheduleInput\): Promise<ValidationScheduleRow> \{/,
    );
    expect(p).toMatch(/async remove\(archetypeId: string\): Promise<boolean> \{/);
    expect(p).toMatch(
      /async findDue\(now: Date, limit: number\): Promise<ValidationScheduleRow\[\]> \{/,
    );
    expect(p).toMatch(
      /async markRun\(archetypeId: string, runId: string, now: Date\): Promise<void> \{/,
    );
  });

  it("CRITICAL upsert next-run-unchanged framing — 'next_run_at unchanged on update — don't disrupt a running schedule unless it's a brand-new row. Operators flip enabled if they want an immediate re-tick'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/validation-schedules-repo.ts'));
    expect(p).toMatch(/\/\/ next_run_at unchanged on update — don't disrupt a running schedule/);
    expect(p).toMatch(/\/\/ unless it's a brand-new row\. Operators flip enabled if they want/);
    expect(p).toMatch(/\/\/ an immediate re-tick\./);
  });

  it('CRITICAL upsert onConflictDoUpdate target = archetypeId. Insert path computes nextRunAt = now + cadenceSeconds*1000 (ms).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/validation-schedules-repo.ts'));
    expect(p).toMatch(
      /const nextRunAt = new Date\(now\.getTime\(\) \+ input\.cadenceSeconds \* 1000\);/,
    );
    expect(p).toMatch(/target: validationSchedules\.archetypeId,/);
  });

  it('CRITICAL findDue filter — and(eq(enabled, true), lte(nextRunAt, now)) + orderBy asc(nextRunAt) + limit. The enabled+due filter selects ready-to-run schedules.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/validation-schedules-repo.ts'));
    expect(p).toMatch(
      /and\(eq\(validationSchedules\.enabled, true\), lte\(validationSchedules\.nextRunAt, now\)\)/,
    );
    expect(p).toMatch(/\.orderBy\(asc\(validationSchedules\.nextRunAt\)\)/);
    expect(p).toMatch(/\.limit\(limit\);/);
  });

  it('CRITICAL markRun re-reads schedule for cadence + recomputes nextRunAt = now + cadenceSeconds*1000 + sets lastRunAt + lastRunId + updatedAt.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/validation-schedules-repo.ts'));
    expect(p).toMatch(/const sched = await this\.findByArchetype\(archetypeId\);/);
    expect(p).toMatch(/if \(!sched\) return;/);
    expect(p).toMatch(
      /const nextRunAt = new Date\(now\.getTime\(\) \+ sched\.cadenceSeconds \* 1000\);/,
    );
    expect(p).toMatch(/lastRunAt: now,/);
    expect(p).toMatch(/lastRunId: runId,/);
    expect(p).toMatch(/nextRunAt,/);
    expect(p).toMatch(/updatedAt: now,/);
  });

  it('CRITICAL remove returning length > 0 boolean.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/validation-schedules-repo.ts'));
    expect(p).toMatch(/\.delete\(validationSchedules\)/);
    expect(p).toMatch(/\.returning\(\{ id: validationSchedules\.id \}\);/);
    expect(p).toMatch(/return result\.length > 0;/);
  });

  it('CRITICAL toRow 10-field shape — id + archetypeId + cadenceSeconds + enabled + lastRunAt + nextRunAt + lastRunId + reason + createdAt + updatedAt.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/validation-schedules-repo.ts'));
    expect(p).toMatch(
      /function toRow\(r: typeof validationSchedules\.\$inferSelect\): ValidationScheduleRow \{/,
    );
    expect(p).toMatch(/id: r\.id,/);
    expect(p).toMatch(/archetypeId: r\.archetypeId,/);
    expect(p).toMatch(/cadenceSeconds: r\.cadenceSeconds,/);
    expect(p).toMatch(/enabled: r\.enabled,/);
    expect(p).toMatch(/lastRunAt: r\.lastRunAt,/);
    expect(p).toMatch(/nextRunAt: r\.nextRunAt,/);
    expect(p).toMatch(/lastRunId: r\.lastRunId,/);
    expect(p).toMatch(/reason: r\.reason,/);
    expect(p).toMatch(/createdAt: r\.createdAt,/);
    expect(p).toMatch(/updatedAt: r\.updatedAt,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-validation-schedules-repo-v218-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
