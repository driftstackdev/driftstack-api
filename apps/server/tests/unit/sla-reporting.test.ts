// V-553.B-5 — unit tests for V-295e SlaReportingService.
//
// Pure-logic service: probe counts → uptime%. These tests pin the
// math, the window-bound semantics, and the wire-shape of the
// returned report.

import { describe, expect, it } from 'vitest';
import { SlaReportingService } from '../../src/services/sla-reporting.js';
import type { ProbesRepo } from '../../src/services/health-probe.js';

type CountRow = Awaited<ReturnType<ProbesRepo['countByTargetSince']>>[number];

function makeRepo(rows: CountRow[]): ProbesRepo {
  return {
    recordProbe: () => {
      throw new Error('unused');
    },
    recentForTarget: () => Promise.resolve([]),
    pruneOlderThan: () => Promise.resolve(0),
    countByTargetSince: () => Promise.resolve(rows),
  };
}

const NOW = new Date('2026-05-11T12:00:00Z');

describe('V-553.B-5 SlaReportingService — uptime math', () => {
  it('100% uptime when all probes in window are ok', async () => {
    const repo = makeRepo([
      {
        target: 'api',
        okCount: 100,
        failCount: 0,
        lastProbeAt: new Date('2026-05-11T11:59:00Z'),
        lastFailureAt: null,
      },
    ]);
    const svc = new SlaReportingService(repo);
    const [r] = await svc.report(NOW);
    expect(r?.uptimePct).toBe(100);
    expect(r?.okCount).toBe(100);
    expect(r?.failCount).toBe(0);
    expect(r?.lastFailureAt).toBeNull();
  });

  it('uptime% computed to 3 decimal places', async () => {
    const repo = makeRepo([
      {
        target: 'api',
        okCount: 999,
        failCount: 1,
        lastProbeAt: new Date('2026-05-11T11:59:00Z'),
        lastFailureAt: new Date('2026-05-10T05:00:00Z'),
      },
    ]);
    const svc = new SlaReportingService(repo);
    const [r] = await svc.report(NOW);
    // 999/1000 = 99.9%; rounded to 3 decimals via the formula.
    expect(r?.uptimePct).toBe(99.9);
  });

  it('0 totalProbes → uptimePct 100 (no data, treat as ok)', async () => {
    const repo = makeRepo([
      {
        target: 'api',
        okCount: 0,
        failCount: 0,
        lastProbeAt: new Date('2026-05-11T11:00:00Z'),
        lastFailureAt: null,
      },
    ]);
    const svc = new SlaReportingService(repo);
    const [r] = await svc.report(NOW);
    expect(r?.uptimePct).toBe(100);
    expect(r?.totalProbes).toBe(0);
  });
});

describe('V-553.B-5 SlaReportingService — window bounds', () => {
  it('default 30-day window emits windowStart = now − 30d', async () => {
    const repo = makeRepo([]);
    const svc = new SlaReportingService(repo);
    const result = await svc.report(NOW);
    expect(result).toHaveLength(0);
    // Indirectly verified — when there's no data the result is empty;
    // re-run with one row to read the window fields.
    const repo2 = makeRepo([
      {
        target: 'api',
        okCount: 1,
        failCount: 0,
        lastProbeAt: new Date('2026-05-11T11:00:00Z'),
        lastFailureAt: null,
      },
    ]);
    const [r] = await new SlaReportingService(repo2).report(NOW);
    expect(r?.windowStart).toBe('2026-04-11T12:00:00.000Z');
    expect(r?.windowEnd).toBe('2026-05-11T12:00:00.000Z');
  });

  it('custom windowMs honoured (1 hour)', async () => {
    const repo = makeRepo([
      {
        target: 'api',
        okCount: 60,
        failCount: 0,
        lastProbeAt: new Date('2026-05-11T11:59:30Z'),
        lastFailureAt: null,
      },
    ]);
    const svc = new SlaReportingService(repo);
    const [r] = await svc.report(NOW, 60 * 60 * 1000);
    expect(r?.windowStart).toBe('2026-05-11T11:00:00.000Z');
    expect(r?.windowEnd).toBe('2026-05-11T12:00:00.000Z');
  });
});

describe('V-553.B-5 SlaReportingService — multi-target', () => {
  it('emits one report per target the repo returns', async () => {
    const repo = makeRepo([
      {
        target: 'api',
        okCount: 50,
        failCount: 0,
        lastProbeAt: new Date('2026-05-11T11:59:00Z'),
        lastFailureAt: null,
      },
      {
        target: 'dashboard',
        okCount: 48,
        failCount: 2,
        lastProbeAt: new Date('2026-05-11T11:58:00Z'),
        lastFailureAt: new Date('2026-05-11T08:00:00Z'),
      },
    ]);
    const svc = new SlaReportingService(repo);
    const rows = await svc.report(NOW);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.target).sort()).toEqual(['api', 'dashboard']);
  });

  it('serialises Dates as ISO 8601 strings on the wire', async () => {
    const repo = makeRepo([
      {
        target: 'api',
        okCount: 5,
        failCount: 1,
        lastProbeAt: new Date('2026-05-11T11:59:00Z'),
        lastFailureAt: new Date('2026-05-11T08:00:00Z'),
      },
    ]);
    const svc = new SlaReportingService(repo);
    const [r] = await svc.report(NOW);
    expect(r?.lastProbeAt).toBe('2026-05-11T11:59:00.000Z');
    expect(r?.lastFailureAt).toBe('2026-05-11T08:00:00.000Z');
  });
});
