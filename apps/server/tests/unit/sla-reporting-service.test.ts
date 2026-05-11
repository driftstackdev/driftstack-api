// V-553.B-25 — unit tests for SlaReportingService (V-295e).
//
// Surface under test:
//   - report(): rolling-window uptime computation, 3-decimal rounding,
//     empty-data handling (100% when no probes), ISO timestamp shape
//   - lastFailureAt: surfaces the most recent fail within the window
//     when there's been one; null when none
//   - windowMs override is honoured (7d / 24h windows)

import { describe, expect, it } from 'vitest';
import { SlaReportingService } from '../../src/services/sla-reporting.js';
import type { ProbesRepo } from '../../src/services/health-probe.js';

function makeRepo(
  rows: Array<{
    target: string;
    okCount: number;
    failCount: number;
    lastProbeAt: Date;
    lastFailureAt: Date | null;
  }>,
): ProbesRepo {
  return {
    recordProbe: () => {
      throw new Error('not used in this test');
    },
    recentForTarget: () => Promise.resolve([]),
    pruneOlderThan: () => Promise.resolve(0),
    countByTargetSince: () => Promise.resolve(rows),
  };
}

const NOW = new Date('2026-05-11T12:00:00Z');

describe('V-553.B-25 SlaReportingService.report — uptime math', () => {
  it('computes uptime% to 3 decimals', async () => {
    const repo = makeRepo([
      {
        target: 'api.driftstack.dev',
        okCount: 9999,
        failCount: 1,
        lastProbeAt: NOW,
        lastFailureAt: new Date('2026-05-10T08:00:00Z'),
      },
    ]);
    const svc = new SlaReportingService(repo);
    const out = await svc.report(NOW);
    expect(out).toHaveLength(1);
    // 9999 / 10000 = 0.9999 → 99.99% → 99.99 (3-decimal rounding)
    expect(out[0]?.uptimePct).toBe(99.99);
    expect(out[0]?.okCount).toBe(9999);
    expect(out[0]?.failCount).toBe(1);
    expect(out[0]?.totalProbes).toBe(10_000);
  });

  it('returns 100 when there are no probes for the target (vacuous truth)', async () => {
    const repo = makeRepo([
      {
        target: 'unmonitored.driftstack.dev',
        okCount: 0,
        failCount: 0,
        lastProbeAt: NOW,
        lastFailureAt: null,
      },
    ]);
    const svc = new SlaReportingService(repo);
    const out = await svc.report(NOW);
    expect(out[0]?.uptimePct).toBe(100);
  });

  it('returns 0 uptime when every probe failed', async () => {
    const repo = makeRepo([
      {
        target: 'dead.driftstack.dev',
        okCount: 0,
        failCount: 100,
        lastProbeAt: NOW,
        lastFailureAt: NOW,
      },
    ]);
    const svc = new SlaReportingService(repo);
    const out = await svc.report(NOW);
    expect(out[0]?.uptimePct).toBe(0);
  });
});

describe('V-553.B-25 SlaReportingService.report — lastFailureAt', () => {
  it('surfaces lastFailureAt as ISO when there was a fail in the window', async () => {
    const fail = new Date('2026-05-10T03:14:00Z');
    const repo = makeRepo([
      {
        target: 'api.driftstack.dev',
        okCount: 500,
        failCount: 5,
        lastProbeAt: NOW,
        lastFailureAt: fail,
      },
    ]);
    const svc = new SlaReportingService(repo);
    const out = await svc.report(NOW);
    expect(out[0]?.lastFailureAt).toBe('2026-05-10T03:14:00.000Z');
  });

  it('returns null lastFailureAt when no failures in the window', async () => {
    const repo = makeRepo([
      {
        target: 'api.driftstack.dev',
        okCount: 500,
        failCount: 0,
        lastProbeAt: NOW,
        lastFailureAt: null,
      },
    ]);
    const svc = new SlaReportingService(repo);
    const out = await svc.report(NOW);
    expect(out[0]?.lastFailureAt).toBeNull();
  });
});

describe('V-553.B-25 SlaReportingService.report — window override', () => {
  it('honours custom windowMs (7-day report)', async () => {
    const repo = makeRepo([]);
    const svc = new SlaReportingService(repo);
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const out = await svc.report(NOW, sevenDays);
    expect(out).toEqual([]); // no rows from empty repo
    // Sanity: invoke once with default (30d), confirm code didn't blow up
    const out30 = await svc.report(NOW);
    expect(out30).toEqual([]);
  });

  it('reports window boundaries as ISO timestamps on the result rows', async () => {
    const repo = makeRepo([
      {
        target: 't',
        okCount: 1,
        failCount: 0,
        lastProbeAt: NOW,
        lastFailureAt: null,
      },
    ]);
    const svc = new SlaReportingService(repo);
    const oneDay = 24 * 60 * 60 * 1000;
    const out = await svc.report(NOW, oneDay);
    expect(out[0]?.windowStart).toBe('2026-05-10T12:00:00.000Z');
    expect(out[0]?.windowEnd).toBe('2026-05-11T12:00:00.000Z');
  });
});

describe('V-553.B-25 SlaReportingService.report — multi-target', () => {
  it('returns one row per target, preserving repo order', async () => {
    const repo = makeRepo([
      {
        target: 'api',
        okCount: 100,
        failCount: 0,
        lastProbeAt: NOW,
        lastFailureAt: null,
      },
      {
        target: 'dashboard',
        okCount: 80,
        failCount: 20,
        lastProbeAt: NOW,
        lastFailureAt: new Date('2026-05-10T00:00:00Z'),
      },
    ]);
    const svc = new SlaReportingService(repo);
    const out = await svc.report(NOW);
    expect(out.map((r) => r.target)).toEqual(['api', 'dashboard']);
    expect(out[0]?.uptimePct).toBe(100);
    expect(out[1]?.uptimePct).toBe(80);
  });
});
