// V-295b — in-memory ProbesRepo for integration tests.

import { randomUUID } from 'node:crypto';
import type { ProbeRecordRow, ProbesRepo } from '../../../src/services/health-probe.js';

export class InMemoryProbesRepo implements ProbesRepo {
  private readonly rows: ProbeRecordRow[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async recordProbe(input: {
    target: string;
    ok: boolean;
    latencyMs: number | null;
    httpStatus: number | null;
    errorMessage: string | null;
    probedAt: Date;
  }): Promise<ProbeRecordRow> {
    const row: ProbeRecordRow = {
      id: randomUUID(),
      target: input.target,
      probedAt: input.probedAt,
      ok: input.ok,
      latencyMs: input.latencyMs,
      httpStatus: input.httpStatus,
      errorMessage: input.errorMessage,
    };
    this.rows.push(row);
    return { ...row };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async recentForTarget(target: string, n: number): Promise<ProbeRecordRow[]> {
    return this.rows
      .filter((r) => r.target === target)
      .sort((a, b) => b.probedAt.getTime() - a.probedAt.getTime())
      .slice(0, n);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async pruneOlderThan(before: Date): Promise<number> {
    const before_ms = before.getTime();
    let removed = 0;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const row = this.rows[i]!;
      if (row.probedAt.getTime() < before_ms) {
        this.rows.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async countByTargetSince(since: Date): Promise<
    {
      target: string;
      okCount: number;
      failCount: number;
      lastProbeAt: Date;
      lastFailureAt: Date | null;
    }[]
  > {
    const inWindow = this.rows.filter((r) => r.probedAt >= since);
    const byTarget = new Map<
      string,
      { okCount: number; failCount: number; lastProbeAt: Date; lastFailureAt: Date | null }
    >();
    for (const row of inWindow) {
      const cur = byTarget.get(row.target) ?? {
        okCount: 0,
        failCount: 0,
        lastProbeAt: row.probedAt,
        lastFailureAt: null,
      };
      if (row.ok) cur.okCount += 1;
      else cur.failCount += 1;
      if (row.probedAt > cur.lastProbeAt) cur.lastProbeAt = row.probedAt;
      if (!row.ok && (cur.lastFailureAt === null || row.probedAt > cur.lastFailureAt)) {
        cur.lastFailureAt = row.probedAt;
      }
      byTarget.set(row.target, cur);
    }
    return Array.from(byTarget.entries()).map(([target, agg]) => ({ target, ...agg }));
  }

  /** Test-only — exposes raw rows for assertions. */
  getAll(): readonly ProbeRecordRow[] {
    return this.rows;
  }
}
