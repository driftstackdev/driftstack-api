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
      /import type \{\s*UpsertValidationScheduleInput,\s*ValidationScheduleRow,\s*ValidationSchedulesRepo,\s*\} from '\.\.\/services\/validation-harness\.js';/,
    );
    expect(body).toMatch(/import \{ validationSchedules \} from '\.\/schema\.js';/);
  });

  it('list: orderBy asc(archetypeId); rows.map(toRow)', () => {
    expect(body).toMatch(
      /async list\(\): Promise<ValidationScheduleRow\[\]> \{\s*const rows = await this\.database\.db\s*\.select\(\)\s*\.from\(validationSchedules\)\s*\.orderBy\(asc\(validationSchedules\.archetypeId\)\);\s*return rows\.map\(toRow\);\s*\}/,
    );
  });

  it('findByArchetype: where eq(archetypeId) + limit 1', () => {
    expect(body).toMatch(
      /async findByArchetype\(archetypeId: string\): Promise<ValidationScheduleRow \| null> \{\s*const \[row\] = await this\.database\.db\s*\.select\(\)\s*\.from\(validationSchedules\)\s*\.where\(eq\(validationSchedules\.archetypeId, archetypeId\)\)\s*\.limit\(1\);\s*return row \? toRow\(row\) : null;\s*\}/,
    );
  });

  it("upsert: first insert computes nextRunAt = now + cadenceSeconds*1000; values include archetypeId + cadenceSeconds + enabled + nextRunAt + reason nullable + updatedAt; throws 'validation_schedules upsert returned no row'", () => {
    expect(body).toMatch(
      /const now = new Date\(\);\s*const nextRunAt = new Date\(now\.getTime\(\) \+ input\.cadenceSeconds \* 1000\);/,
    );
    expect(body).toMatch(
      /\.values\(\{\s*archetypeId: input\.archetypeId,\s*cadenceSeconds: input\.cadenceSeconds,\s*enabled: input\.enabled,\s*nextRunAt,\s*reason: input\.reason \?\? null,\s*updatedAt: now,\s*\}\)/,
    );
    expect(body).toMatch(
      /if \(!row\) throw new Error\('validation_schedules upsert returned no row'\);/,
    );
  });

  it("upsert onConflictDoUpdate target=archetypeId; on conflict set cadenceSeconds + enabled + reason + updatedAt — DO NOT touch next_run_at (rationale: 'don't disrupt a running schedule unless brand-new row. Operators flip enabled if they want immediate re-tick')", () => {
    expect(body).toMatch(
      /\.onConflictDoUpdate\(\{\s*target: validationSchedules\.archetypeId,\s*set: \{\s*cadenceSeconds: input\.cadenceSeconds,\s*enabled: input\.enabled,\s*reason: input\.reason \?\? null,\s*updatedAt: now,\s*\/\/ next_run_at unchanged on update — don't disrupt a running schedule\s*\/\/ unless it's a brand-new row\. Operators flip enabled if they want\s*\/\/ an immediate re-tick\.\s*\},\s*\}\)/,
    );
  });

  it('remove: delete where archetypeId returning {id}; returns result.length > 0', () => {
    expect(body).toMatch(
      /async remove\(archetypeId: string\): Promise<boolean> \{\s*const result = await this\.database\.db\s*\.delete\(validationSchedules\)\s*\.where\(eq\(validationSchedules\.archetypeId, archetypeId\)\)\s*\.returning\(\{ id: validationSchedules\.id \}\);\s*return result\.length > 0;\s*\}/,
    );
  });

  it('findDue: where and(eq(enabled, true), lte(nextRunAt, now)); orderBy asc(nextRunAt); limit clamp', () => {
    expect(body).toMatch(
      /async findDue\(now: Date, limit: number\): Promise<ValidationScheduleRow\[\]> \{\s*const rows = await this\.database\.db\s*\.select\(\)\s*\.from\(validationSchedules\)\s*\.where\(and\(eq\(validationSchedules\.enabled, true\), lte\(validationSchedules\.nextRunAt, now\)\)\)\s*\.orderBy\(asc\(validationSchedules\.nextRunAt\)\)\s*\.limit\(limit\);\s*return rows\.map\(toRow\);\s*\}/,
    );
  });

  it('markRun: findByArchetype guard (no-op on missing); next = now + cadenceSeconds*1000; update lastRunAt + lastRunId + nextRunAt + updatedAt where archetypeId', () => {
    expect(body).toMatch(
      /async markRun\(archetypeId: string, runId: string, now: Date\): Promise<void> \{\s*const sched = await this\.findByArchetype\(archetypeId\);\s*if \(!sched\) return;\s*const nextRunAt = new Date\(now\.getTime\(\) \+ sched\.cadenceSeconds \* 1000\);/,
    );
    expect(body).toMatch(
      /\.update\(validationSchedules\)\s*\.set\(\{\s*lastRunAt: now,\s*lastRunId: runId,\s*nextRunAt,\s*updatedAt: now,\s*\}\)\s*\.where\(eq\(validationSchedules\.archetypeId, archetypeId\)\);/,
    );
  });

  it('toRow: 10-field ValidationScheduleRow (id + archetypeId + cadenceSeconds + enabled + lastRunAt + nextRunAt + lastRunId + reason + created/updated_at)', () => {
    expect(body).toMatch(
      /function toRow\(r: typeof validationSchedules\.\$inferSelect\): ValidationScheduleRow \{\s*return \{\s*id: r\.id,\s*archetypeId: r\.archetypeId,\s*cadenceSeconds: r\.cadenceSeconds,\s*enabled: r\.enabled,\s*lastRunAt: r\.lastRunAt,\s*nextRunAt: r\.nextRunAt,\s*lastRunId: r\.lastRunId,\s*reason: r\.reason,\s*createdAt: r\.createdAt,\s*updatedAt: r\.updatedAt,\s*\};\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
