// V-295e — rolling-window SLA reporting from V-295b probe history.
//
// Computes uptime % per probe target over a configurable lookback
// window (default 30 days). Surfaces per-target lastFailureAt so the
// status page can show "operational since {timestamp}" if there hasn't
// been a recent incident.
//
// Pure-logic service: takes a ProbesRepo + a window. Returns a snapshot;
// no side effects, no caching. Cache later if QPS demands.
//
// ⛔ WHY IT TAKES THE CONFIGURED TARGET LIST (2026-09-17).
//
// The report used to be built ONLY from `countByTargetSince`, a `GROUP BY target`
// over rows that exist. A target with no rows in the window is not a group, so it
// was not in the result — it was ABSENT, not reported as unmeasured. The endpoint
// could not distinguish "this target was healthy" from "we have no data for this
// target", because both render as the target not appearing.
//
// That is not hypothetical. Measured on production the same day: `PUBLIC_API_BASE_URL`
// is unset there, so the health prober is never constructed, no probe row has ever
// been written, and the public `GET /v1/status/sla` returns `{"data":[]}` — an empty
// list, which to any consumer reads as a clean bill of health. The one thing the
// endpoint exists to say, it cannot say: that nobody is looking.
//
// So the window's history is now merged ONTO the configured target list. A target
// that is configured but has no rows appears with `totalProbes: 0` and a NULL
// uptimePct — null meaning "not measured", which a consumer must handle, rather
// than a number that invents a verdict. (`uptimePct` was previously typed
// non-null with a `total === 0 ? 100` fallback that scored an unmeasured target as
// PERFECT. That branch was unreachable under a GROUP BY — every group has at least
// one row — but it was the honest shape of the mistake, and it would have become
// reachable the moment this merge was written without changing the type.)
//
// A target with history but no longer configured is still reported: the rows are
// real measurements, and dropping them would re-create the same silence from the
// other direction.

import type { ProbesRepo } from './health-probe.js';

export interface SlaTargetReport {
  target: string;
  /**
   * Uptime over the window, or NULL when nothing was measured for this target.
   *
   * ⛔ Null is not zero and not 100. A consumer that coerces it to either is
   * asserting a verdict nobody produced — the exact defect this field's previous
   * non-null type invited.
   */
  uptimePct: number | null;
  /** Total probes in the window. 0 means "no data yet for this target." */
  totalProbes: number;
  okCount: number;
  failCount: number;
  /** Most recent probe (ok or fail). Null when the target has no probes. */
  lastProbeAt: string | null;
  /** Most recent failed probe within the window, or null if none. */
  lastFailureAt: string | null;
  /** Window start, ISO. */
  windowStart: string;
  /** Window end, ISO. */
  windowEnd: string;
}

export class SlaReportingService {
  /**
   * @param configuredTargets ids of the targets the deployment is set up to
   *   probe. Every one appears in the report whether or not it has history, so an
   *   unprobed target is visible as unmeasured instead of missing. An empty list
   *   means this deployment probes nothing, and the report is then honestly empty
   *   rather than misleadingly so.
   */
  constructor(
    private readonly probes: ProbesRepo,
    private readonly configuredTargets: readonly string[] = [],
  ) {}

  /** Compute SLA report for the rolling window. Default 30 days. */
  async report(now: Date, windowMs = 30 * 24 * 60 * 60 * 1000): Promise<SlaTargetReport[]> {
    const windowStart = new Date(now.getTime() - windowMs);
    const rows = await this.probes.countByTargetSince(windowStart);
    const byTarget = new Map(rows.map((r) => [r.target, r]));

    // Configured first (stable, deployment-declared order), then any target that
    // has history but is no longer configured — never dropped, see the header.
    const targets = [
      ...this.configuredTargets,
      ...rows.map((r) => r.target).filter((t) => !this.configuredTargets.includes(t)),
    ];

    return targets.map((target) => {
      const row = byTarget.get(target);
      if (row === undefined) {
        return {
          target,
          uptimePct: null,
          totalProbes: 0,
          okCount: 0,
          failCount: 0,
          lastProbeAt: null,
          lastFailureAt: null,
          windowStart: windowStart.toISOString(),
          windowEnd: now.toISOString(),
        };
      }
      const total = row.okCount + row.failCount;
      // `total` is >= 1 for any row a GROUP BY produced, but the guard stays: it
      // now returns null rather than the 100 it used to, so if the query ever
      // becomes a left join this reports "unmeasured" instead of "perfect".
      const uptimePct = total === 0 ? null : Math.round((row.okCount / total) * 100 * 1000) / 1000; // 3 decimals
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
