// V-218 — Drizzle-backed ValidationSchedulesRepo.

import { and, asc, eq, lte } from 'drizzle-orm';
import type {
  UpsertValidationScheduleInput,
  ValidationScheduleRow,
  ValidationSchedulesRepo,
} from '../services/validation-harness.js';
import type { Database } from './client.js';
import { validationSchedules } from './schema.js';

export class DrizzleValidationSchedulesRepo implements ValidationSchedulesRepo {
  constructor(private readonly database: Database) {}

  async list(): Promise<ValidationScheduleRow[]> {
    const rows = await this.database.db
      .select()
      .from(validationSchedules)
      .orderBy(asc(validationSchedules.archetypeId));
    return rows.map(toRow);
  }

  async findByArchetype(archetypeId: string): Promise<ValidationScheduleRow | null> {
    const [row] = await this.database.db
      .select()
      .from(validationSchedules)
      .where(eq(validationSchedules.archetypeId, archetypeId))
      .limit(1);
    return row ? toRow(row) : null;
  }

  async upsert(input: UpsertValidationScheduleInput): Promise<ValidationScheduleRow> {
    const now = new Date();
    const nextRunAt = new Date(now.getTime() + input.cadenceSeconds * 1000);
    const [row] = await this.database.db
      .insert(validationSchedules)
      .values({
        archetypeId: input.archetypeId,
        cadenceSeconds: input.cadenceSeconds,
        enabled: input.enabled,
        nextRunAt,
        reason: input.reason ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: validationSchedules.archetypeId,
        set: {
          cadenceSeconds: input.cadenceSeconds,
          enabled: input.enabled,
          reason: input.reason ?? null,
          updatedAt: now,
          // next_run_at unchanged on update — don't disrupt a running schedule
          // unless it's a brand-new row. Operators flip enabled if they want
          // an immediate re-tick.
        },
      })
      .returning();
    if (!row) throw new Error('validation_schedules upsert returned no row');
    return toRow(row);
  }

  async remove(archetypeId: string): Promise<boolean> {
    const result = await this.database.db
      .delete(validationSchedules)
      .where(eq(validationSchedules.archetypeId, archetypeId))
      .returning({ id: validationSchedules.id });
    return result.length > 0;
  }

  async findDue(now: Date, limit: number): Promise<ValidationScheduleRow[]> {
    const rows = await this.database.db
      .select()
      .from(validationSchedules)
      .where(and(eq(validationSchedules.enabled, true), lte(validationSchedules.nextRunAt, now)))
      .orderBy(asc(validationSchedules.nextRunAt))
      .limit(limit);
    return rows.map(toRow);
  }

  async markRun(archetypeId: string, runId: string, now: Date): Promise<void> {
    const sched = await this.findByArchetype(archetypeId);
    if (!sched) return;
    const nextRunAt = new Date(now.getTime() + sched.cadenceSeconds * 1000);
    await this.database.db
      .update(validationSchedules)
      .set({
        lastRunAt: now,
        lastRunId: runId,
        nextRunAt,
        updatedAt: now,
      })
      .where(eq(validationSchedules.archetypeId, archetypeId));
  }
}

function toRow(r: typeof validationSchedules.$inferSelect): ValidationScheduleRow {
  return {
    id: r.id,
    archetypeId: r.archetypeId,
    cadenceSeconds: r.cadenceSeconds,
    enabled: r.enabled,
    lastRunAt: r.lastRunAt,
    nextRunAt: r.nextRunAt,
    lastRunId: r.lastRunId,
    reason: r.reason,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
