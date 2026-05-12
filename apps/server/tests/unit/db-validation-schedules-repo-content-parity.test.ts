// W445.A — drift guard for apps/server/src/db/validation-schedules-repo.ts.
// V-218 Drizzle ValidationSchedulesRepo. Drift here either drops the
// "next_run_at unchanged on update" invariant (operator changes cadence
// and silently disrupts a running schedule) or the asc(nextRunAt)
// ordering in findDue (oldest-overdue stops firing first; queue
// starves).
//
//   • V-218 framing pinned.
//   • list: ORDER BY archetypeId ASC (deterministic admin-panel sort).
//   • findByArchetype: limit 1 lookup.
//   • upsert framing: target=archetypeId; computes nextRunAt =
//     now + cadenceSeconds*1000 on first insert; on conflict do NOT
//     touch next_run_at — operators flip enabled if they want
//     immediate re-tick; comment pinned.
//   • findDue: enabled=true AND nextRunAt <= now; orderBy asc
//     (nextRunAt); limit clamp.
//   • markRun: re-read sched (skip on miss); next = now +
//     cadenceSeconds*1000; updates lastRunAt + lastRunId + nextRunAt.
//   • toRow: 9-field ValidationScheduleRow.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/validation-schedules-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W445.A apps/server/src/db/validation-schedules-repo.ts content parity', () => {
  const body = read(LIB);

  it("V-218 framing pinned: 'Drizzle-backed ValidationSchedulesRepo.'", () => {
    expect(body).toMatch(/\/\/ V-218 — Drizzle-backed ValidationSchedulesRepo\./);
  });

  it('imports: and/asc/eq/lte from drizzle-orm; 3 service types; Database; validationSchedules schema', () => {
    expect(body).toMatch(/import \{ and, asc, eq, lte \} from 'drizzle-orm';/);
    expect(body).toMatch(
      /import type \{\s*\n?\s*UpsertValidationScheduleInput,\s*\n?\s*ValidationScheduleRow,\s*\n?\s*ValidationSchedulesRepo,\s*\n?\s*\} from '\.\.\/services\/validation-harness\.js';/,
    );
    expect(body).toMatch(/import \{ validationSchedules \} from '\.\/schema\.js';/);
  });

  it('list: orderBy asc(archetypeId); rows.map(toRow)', () => {
    expect(body).toMatch(
      /async list\(\): Promise<ValidationScheduleRow\[\]> \{\s*\n?\s*const rows = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(validationSchedules\)\s*\n?\s*\.orderBy\(asc\(validationSchedules\.archetypeId\)\);\s*\n?\s*return rows\.map\(toRow\);\s*\n?\s*\}/,
    );
  });

  it('findByArchetype: where eq(archetypeId) + limit 1', () => {
    expect(body).toMatch(
      /async findByArchetype\(archetypeId: string\): Promise<ValidationScheduleRow \| null> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(validationSchedules\)\s*\n?\s*\.where\(eq\(validationSchedules\.archetypeId, archetypeId\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*return row \? toRow\(row\) : null;\s*\n?\s*\}/,
    );
  });

  it("upsert: first insert computes nextRunAt = now + cadenceSeconds*1000; values include archetypeId + cadenceSeconds + enabled + nextRunAt + reason nullable + updatedAt; throws 'validation_schedules upsert returned no row'", () => {
    expect(body).toMatch(
      /const now = new Date\(\);\s*\n?\s*const nextRunAt = new Date\(now\.getTime\(\) \+ input\.cadenceSeconds \* 1000\);/,
    );
    expect(body).toMatch(
      /\.values\(\{\s*\n?\s*archetypeId: input\.archetypeId,\s*\n?\s*cadenceSeconds: input\.cadenceSeconds,\s*\n?\s*enabled: input\.enabled,\s*\n?\s*nextRunAt,\s*\n?\s*reason: input\.reason \?\? null,\s*\n?\s*updatedAt: now,\s*\n?\s*\}\)/,
    );
    expect(body).toMatch(
      /if \(!row\) throw new Error\('validation_schedules upsert returned no row'\);/,
    );
  });

  it("upsert onConflictDoUpdate target=archetypeId; on conflict set cadenceSeconds + enabled + reason + updatedAt — DO NOT touch next_run_at (rationale: 'don't disrupt a running schedule unless brand-new row. Operators flip enabled if they want immediate re-tick')", () => {
    expect(body).toMatch(
      /\.onConflictDoUpdate\(\{\s*\n?\s*target: validationSchedules\.archetypeId,\s*\n?\s*set: \{\s*\n?\s*cadenceSeconds: input\.cadenceSeconds,\s*\n?\s*enabled: input\.enabled,\s*\n?\s*reason: input\.reason \?\? null,\s*\n?\s*updatedAt: now,\s*\n?\s*\/\/ next_run_at unchanged on update — don't disrupt a running schedule\s*\n?\s*\/\/ unless it's a brand-new row\. Operators flip enabled if they want\s*\n?\s*\/\/ an immediate re-tick\.\s*\n?\s*\},\s*\n?\s*\}\)/,
    );
  });

  it('remove: delete where archetypeId returning {id}; returns result.length > 0', () => {
    expect(body).toMatch(
      /async remove\(archetypeId: string\): Promise<boolean> \{\s*\n?\s*const result = await this\.database\.db\s*\n?\s*\.delete\(validationSchedules\)\s*\n?\s*\.where\(eq\(validationSchedules\.archetypeId, archetypeId\)\)\s*\n?\s*\.returning\(\{ id: validationSchedules\.id \}\);\s*\n?\s*return result\.length > 0;\s*\n?\s*\}/,
    );
  });

  it('findDue: where and(eq(enabled, true), lte(nextRunAt, now)); orderBy asc(nextRunAt); limit clamp', () => {
    expect(body).toMatch(
      /async findDue\(now: Date, limit: number\): Promise<ValidationScheduleRow\[\]> \{\s*\n?\s*const rows = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(validationSchedules\)\s*\n?\s*\.where\(and\(eq\(validationSchedules\.enabled, true\), lte\(validationSchedules\.nextRunAt, now\)\)\)\s*\n?\s*\.orderBy\(asc\(validationSchedules\.nextRunAt\)\)\s*\n?\s*\.limit\(limit\);\s*\n?\s*return rows\.map\(toRow\);\s*\n?\s*\}/,
    );
  });

  it('markRun: findByArchetype guard (no-op on missing); next = now + cadenceSeconds*1000; update lastRunAt + lastRunId + nextRunAt + updatedAt where archetypeId', () => {
    expect(body).toMatch(
      /async markRun\(archetypeId: string, runId: string, now: Date\): Promise<void> \{\s*\n?\s*const sched = await this\.findByArchetype\(archetypeId\);\s*\n?\s*if \(!sched\) return;\s*\n?\s*const nextRunAt = new Date\(now\.getTime\(\) \+ sched\.cadenceSeconds \* 1000\);/,
    );
    expect(body).toMatch(
      /\.update\(validationSchedules\)\s*\n?\s*\.set\(\{\s*\n?\s*lastRunAt: now,\s*\n?\s*lastRunId: runId,\s*\n?\s*nextRunAt,\s*\n?\s*updatedAt: now,\s*\n?\s*\}\)\s*\n?\s*\.where\(eq\(validationSchedules\.archetypeId, archetypeId\)\);/,
    );
  });

  it('toRow: 10-field ValidationScheduleRow (id + archetypeId + cadenceSeconds + enabled + lastRunAt + nextRunAt + lastRunId + reason + created/updated_at)', () => {
    expect(body).toMatch(
      /function toRow\(r: typeof validationSchedules\.\$inferSelect\): ValidationScheduleRow \{\s*\n?\s*return \{\s*\n?\s*id: r\.id,\s*\n?\s*archetypeId: r\.archetypeId,\s*\n?\s*cadenceSeconds: r\.cadenceSeconds,\s*\n?\s*enabled: r\.enabled,\s*\n?\s*lastRunAt: r\.lastRunAt,\s*\n?\s*nextRunAt: r\.nextRunAt,\s*\n?\s*lastRunId: r\.lastRunId,\s*\n?\s*reason: r\.reason,\s*\n?\s*createdAt: r\.createdAt,\s*\n?\s*updatedAt: r\.updatedAt,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
