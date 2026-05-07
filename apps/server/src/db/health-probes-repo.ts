// V-295b — Drizzle-backed ProbesRepo.

import { and, desc, eq, lt } from 'drizzle-orm';
import type { ProbeRecordRow, ProbesRepo } from '../services/health-probe.js';
import type { Database } from './client.js';
import { systemHealthProbes } from './schema.js';

type ProbeDbRow = typeof systemHealthProbes.$inferSelect;

function toRow(row: ProbeDbRow): ProbeRecordRow {
  return {
    id: row.id,
    target: row.target,
    probedAt: row.probedAt,
    ok: row.ok,
    latencyMs: row.latencyMs,
    httpStatus: row.httpStatus,
    errorMessage: row.errorMessage,
  };
}

export class DrizzleProbesRepo implements ProbesRepo {
  constructor(private readonly database: Database) {}

  async recordProbe(input: {
    target: string;
    ok: boolean;
    latencyMs: number | null;
    httpStatus: number | null;
    errorMessage: string | null;
    probedAt: Date;
  }): Promise<ProbeRecordRow> {
    const [row] = await this.database.db
      .insert(systemHealthProbes)
      .values({
        target: input.target,
        ok: input.ok,
        latencyMs: input.latencyMs,
        httpStatus: input.httpStatus,
        errorMessage: input.errorMessage,
        probedAt: input.probedAt,
      })
      .returning();
    if (!row) throw new Error('system_health_probes insert returned no row');
    return toRow(row);
  }

  async recentForTarget(target: string, n: number): Promise<ProbeRecordRow[]> {
    const rows = await this.database.db
      .select()
      .from(systemHealthProbes)
      .where(eq(systemHealthProbes.target, target))
      .orderBy(desc(systemHealthProbes.probedAt))
      .limit(n);
    return rows.map(toRow);
  }

  async pruneOlderThan(before: Date): Promise<number> {
    const rows = await this.database.db
      .delete(systemHealthProbes)
      .where(and(lt(systemHealthProbes.probedAt, before)))
      .returning({ id: systemHealthProbes.id });
    return rows.length;
  }
}
