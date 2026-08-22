// V-218 — in-memory ValidationSchedulesRepo for integration tests.

import { randomUUID } from 'node:crypto';
import type {
  UpsertValidationScheduleInput,
  ValidationScheduleRow,
  ValidationSchedulesRepo,
} from '../../../src/services/validation-harness.js';

export class InMemoryValidationSchedulesRepo implements ValidationSchedulesRepo {
  private readonly byArchetype = new Map<string, ValidationScheduleRow>();

  list(): Promise<ValidationScheduleRow[]> {
    const sorted = Array.from(this.byArchetype.values()).sort((a, b) =>
      a.archetypeId.localeCompare(b.archetypeId),
    );
    return Promise.resolve(sorted.map((r) => ({ ...r })));
  }

  findByArchetype(archetypeId: string): Promise<ValidationScheduleRow | null> {
    return Promise.resolve(this.byArchetype.get(archetypeId) ?? null);
  }

  upsert(input: UpsertValidationScheduleInput): Promise<ValidationScheduleRow> {
    const now = new Date();
    const existing = this.byArchetype.get(input.archetypeId);
    const next: ValidationScheduleRow = existing
      ? {
          ...existing,
          cadenceSeconds: input.cadenceSeconds,
          enabled: input.enabled,
          reason: input.reason ?? null,
          updatedAt: now,
        }
      : {
          id: randomUUID(),
          archetypeId: input.archetypeId,
          cadenceSeconds: input.cadenceSeconds,
          enabled: input.enabled,
          lastRunAt: null,
          nextRunAt: new Date(now.getTime() + input.cadenceSeconds * 1000),
          lastRunId: null,
          reason: input.reason ?? null,
          createdAt: now,
          updatedAt: now,
        };
    this.byArchetype.set(input.archetypeId, next);
    return Promise.resolve({ ...next });
  }

  remove(archetypeId: string): Promise<boolean> {
    return Promise.resolve(this.byArchetype.delete(archetypeId));
  }

  findDue(now: Date, limit: number): Promise<ValidationScheduleRow[]> {
    const due = Array.from(this.byArchetype.values())
      .filter((r) => r.enabled && r.nextRunAt <= now)
      .sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime())
      .slice(0, limit);
    return Promise.resolve(due.map((r) => ({ ...r })));
  }

  markRun(archetypeId: string, runId: string, now: Date): Promise<void> {
    const r = this.byArchetype.get(archetypeId);
    if (!r) return Promise.resolve();
    const updated: ValidationScheduleRow = {
      ...r,
      lastRunAt: now,
      lastRunId: runId,
      nextRunAt: new Date(now.getTime() + r.cadenceSeconds * 1000),
      updatedAt: now,
    };
    this.byArchetype.set(archetypeId, updated);
    return Promise.resolve();
  }
}
