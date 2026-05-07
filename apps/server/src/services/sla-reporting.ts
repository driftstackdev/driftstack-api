// V-295e — rolling-window SLA reporting from V-295b probe history.
//
// Computes uptime % per probe target over a configurable lookback
// window (default 30 days). Surfaces per-target lastFailureAt so the
// status page can show "operational since {timestamp}" if there hasn't
// been a recent incident.
//
// Pure-logic service: takes a ProbesRepo + a window. Returns a snapshot;
// no side effects, no caching. Cache later if QPS demands.

import type { ProbesRepo } from './health-probe.js';

export interface SlaTargetReport {
  target: string;
  uptimePct: number;
  /** Total probes in the window. 0 means "no data yet for this target." */
  totalProbes: number;
  okCount: number;
  failCount: number;
  /** Most recent probe (ok or fail). */
  lastProbeAt: string;
  /** Most recent failed probe within the window, or null if none. */
  lastFailureAt: string | null;
  /** Window start, ISO. */
  windowStart: string;
  /** Window end, ISO. */
  windowEnd: string;
}

export class SlaReportingService {
  constructor(private readonly probes: ProbesRepo) {}

  /** Compute SLA report for the rolling window. Default 30 days. */
  async report(now: Date, windowMs = 30 * 24 * 60 * 60 * 1000): Promise<SlaTargetReport[]> {
    const windowStart = new Date(now.getTime() - windowMs);
    const rows = await this.probes.countByTargetSince(windowStart);
    return rows.map((row) => {
      const total = row.okCount + row.failCount;
      const uptimePct = total === 0 ? 100 : Math.round((row.okCount / total) * 100 * 1000) / 1000; // 3 decimals
      return {
        target: row.target,
        uptimePct,
        totalProbes: total,
        okCount: row.okCount,
        failCount: row.failCount,
        lastProbeAt: row.lastProbeAt.toISOString(),
        lastFailureAt: row.lastFailureAt ? row.lastFailureAt.toISOString() : null,
        windowStart: windowStart.toISOString(),
        windowEnd: now.toISOString(),
      };
    });
  }
}
