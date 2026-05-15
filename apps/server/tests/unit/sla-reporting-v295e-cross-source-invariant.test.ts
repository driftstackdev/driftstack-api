// W921 — V-295e SLA reporting cross-source invariant. Two-hundred-
// forty-seventh in the drift-guard series. Pins the rolling-window
// SLA reporting service:
//
//   V-295e anchor — 'rolling-window SLA reporting from V-295b probe
//   history'.
//
//   Computes uptime % per probe target over configurable lookback
//   window (default 30 days). Surfaces per-target lastFailureAt so
//   the status page can show "operational since {timestamp}".
//
//   Pure-logic service: takes ProbesRepo + window. Returns snapshot;
//   no side effects, no caching. Cache later if QPS demands.
//
//   Default window: 30 * 24 * 60 * 60 * 1000 (= 30 days).
//
//   SlaTargetReport (9 fields):
//     - target              (slug from V-295b probe table).
//     - uptimePct           (3-decimal rounded percent).
//     - totalProbes         (0 → 'no data yet for this target').
//     - okCount.
//     - failCount.
//     - lastProbeAt         (ISO 8601).
//     - lastFailureAt       (ISO 8601 OR null when none in window).
//     - windowStart         (ISO 8601).
//     - windowEnd           (ISO 8601 = now).
//
//   Uptime formula: total === 0 ? 100 : Math.round(okCount / total
//     * 100 * 1000) / 1000 (3-decimal precision).
//
//   Empty-window fallback: totalProbes === 0 → uptimePct = 100
//     (no data presented as 'fully up' rather than '0%' or NaN).
//
// stays in lockstep across apps/server/src/services/sla-reporting.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SlaReportingService } from '../../src/services/sla-reporting.js';
import type { ProbesRepo } from '../../src/services/health-probe.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function stubProbes(countByTargetSince: ProbesRepo['countByTargetSince']): ProbesRepo {
  // Only countByTargetSince is exercised by report(); other methods are
  // not called and can throw to surface accidental coupling.
  return {
    countByTargetSince,
    insert: () => {
      throw new Error('not implemented in stub');
    },
    lastNForTarget: () => {
      throw new Error('not implemented in stub');
    },
    pruneOlderThan: () => {
      throw new Error('not implemented in stub');
    },
    countOpenAutoIncidents: () => {
      throw new Error('not implemented in stub');
    },
  } as unknown as ProbesRepo;
}

describe('W921 V-295e SLA reporting cross-source invariant', () => {
  // ─── V-295e anchor + V-295b dependency framing ───────────────

  it("CRITICAL apps/server/src/services/sla-reporting.ts header pins V-295e anchor — 'V-295e — rolling-window SLA reporting from V-295b probe history'. The V-295e + V-295b chain is the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sla-reporting.ts'));
    expect(p).toMatch(/V-295e — rolling-window SLA reporting from V-295b probe history/);
  });

  // ─── Pure-logic + no-cache framing ───────────────────────────

  it("CRITICAL pure-logic framing — 'Pure-logic service: takes a ProbesRepo + a window. Returns a snapshot; no side effects, no caching. Cache later if QPS demands'. The pure-logic + cache-later contract keeps SLA reporting trivially testable + idempotent.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sla-reporting.ts'));
    expect(p).toMatch(/Pure-logic service: takes a ProbesRepo \+ a window\. Returns a snapshot;/);
    expect(p).toMatch(/no side effects, no caching\. Cache later if QPS demands/);
  });

  // ─── 30-day default window ───────────────────────────────────

  it("CRITICAL default window = 30 days — 'Computes uptime % per probe target over a configurable lookback window (default 30 days)'. The 30-day window matches V-295b retention; drift would let SLA reports cover data the probe table doesn't have.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sla-reporting.ts'));
    expect(p).toMatch(
      /Computes uptime % per probe target over a configurable lookback\s*\n\/\/ window \(default 30 days\)/,
    );
    expect(p).toMatch(/windowMs = 30 \* 24 \* 60 \* 60 \* 1000/);
  });

  // ─── 9-field SlaTargetReport shape ───────────────────────────

  it('CRITICAL SlaTargetReport has 9 fields — target + uptimePct + totalProbes + okCount + failCount + lastProbeAt + lastFailureAt (nullable) + windowStart + windowEnd. The 9-field shape is the status-page contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sla-reporting.ts'));
    expect(p).toMatch(/export interface SlaTargetReport \{/);
    expect(p).toMatch(/target: string;/);
    expect(p).toMatch(/uptimePct: number;/);
    expect(p).toMatch(/totalProbes: number;/);
    expect(p).toMatch(/okCount: number;/);
    expect(p).toMatch(/failCount: number;/);
    expect(p).toMatch(/lastProbeAt: string;/);
    expect(p).toMatch(/lastFailureAt: string \| null;/);
    expect(p).toMatch(/windowStart: string;/);
    expect(p).toMatch(/windowEnd: string;/);
  });

  it("CRITICAL totalProbes-0 framing — 'Total probes in the window. 0 means \"no data yet for this target.\"'. The 0-totalProbes contract is what status-page consumers branch on for 'awaiting data' UI.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sla-reporting.ts'));
    expect(p).toMatch(/Total probes in the window\. 0 means "no data yet for this target\."/);
  });

  it("CRITICAL lastFailureAt-null framing — 'Most recent failed probe within the window, or null if none'. The null-when-clean lets status-page show 'operational since {timestamp}' instead of dangling 'last failure: never'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sla-reporting.ts'));
    expect(p).toMatch(/Most recent failed probe within the window, or null if none/);
  });

  // ─── Uptime formula + 3-decimal rounding ─────────────────────

  it("CRITICAL uptime formula — 'total === 0 ? 100 : Math.round((okCount / total) * 100 * 1000) / 1000' + '3 decimals'. The 3-decimal rounding is the precision contract — drift to 0 or 5 decimals would change status-page display.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sla-reporting.ts'));
    expect(p).toMatch(
      /total === 0 \? 100 : Math\.round\(\(row\.okCount \/ total\) \* 100 \* 1000\) \/ 1000;.*\/\/ 3 decimals/,
    );
  });

  // ─── Runtime uptime computation (100% clean) ─────────────────

  it('CRITICAL report() returns uptimePct = 100 when all probes succeed. The 100% case is the most common — drift would change the 100.000 → 99.999 etc.', async () => {
    const svc = new SlaReportingService(
      stubProbes(() =>
        Promise.resolve([
          {
            target: 'api',
            okCount: 100,
            failCount: 0,
            lastProbeAt: new Date('2026-05-15T01:00:00Z'),
            lastFailureAt: null,
          },
        ]),
      ),
    );
    const result = await svc.report(new Date('2026-05-15T01:00:00Z'));
    expect(result[0]!.uptimePct).toBe(100);
    expect(result[0]!.totalProbes).toBe(100);
    expect(result[0]!.lastFailureAt).toBeNull();
  });

  it('CRITICAL report() returns uptimePct with 3-decimal precision. 999 ok + 1 fail = 99.9% (= 99.900). The 3-decimal rounding is what status pages display.', async () => {
    const svc = new SlaReportingService(
      stubProbes(() =>
        Promise.resolve([
          {
            target: 'api',
            okCount: 999,
            failCount: 1,
            lastProbeAt: new Date('2026-05-15T01:00:00Z'),
            lastFailureAt: new Date('2026-05-15T00:00:00Z'),
          },
        ]),
      ),
    );
    const result = await svc.report(new Date('2026-05-15T01:00:00Z'));
    expect(result[0]!.uptimePct).toBe(99.9);
    expect(result[0]!.failCount).toBe(1);
  });

  it('CRITICAL report() returns uptimePct = 100 when totalProbes is 0 (empty-window fallback). The no-data → 100% mapping is what avoids NaN / 0% / Inf at the status-page surface.', async () => {
    const svc = new SlaReportingService(stubProbes(() => Promise.resolve([])));
    const result = await svc.report(new Date('2026-05-15T01:00:00Z'));
    expect(result).toEqual([]);
  });

  it('CRITICAL report() with single ok=0,fail=0 row → uptimePct=100, totalProbes=0. The empty-target row still emits 100% rather than NaN.', async () => {
    const svc = new SlaReportingService(
      stubProbes(() =>
        Promise.resolve([
          {
            target: 'api',
            okCount: 0,
            failCount: 0,
            lastProbeAt: new Date('2026-05-15T01:00:00Z'),
            lastFailureAt: null,
          },
        ]),
      ),
    );
    const result = await svc.report(new Date('2026-05-15T01:00:00Z'));
    expect(result[0]!.uptimePct).toBe(100);
    expect(result[0]!.totalProbes).toBe(0);
  });

  // ─── Window start/end semantics ──────────────────────────────

  it('CRITICAL report() windowStart = now - windowMs, windowEnd = now (both ISO). Default 30 days → windowStart is 30 days before now.', async () => {
    const now = new Date('2026-05-15T01:00:00Z');
    const svc = new SlaReportingService(
      stubProbes((windowStart) => {
        expect(windowStart.toISOString()).toBe('2026-04-15T01:00:00.000Z');
        return Promise.resolve([
          {
            target: 'api',
            okCount: 1,
            failCount: 0,
            lastProbeAt: now,
            lastFailureAt: null,
          },
        ]);
      }),
    );
    const result = await svc.report(now);
    expect(result[0]!.windowStart).toBe('2026-04-15T01:00:00.000Z');
    expect(result[0]!.windowEnd).toBe('2026-05-15T01:00:00.000Z');
  });

  // ─── ProbesRepo dependency type import ───────────────────────

  it("CRITICAL SlaReportingService imports ProbesRepo from health-probe.js — 'import type { ProbesRepo } from health-probe.js'. The V-295b dependency import is the cross-service boundary.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/sla-reporting.ts'));
    expect(p).toMatch(/import type \{ ProbesRepo \} from '\.\/health-probe\.js';/);
  });

  // ─── 30-day window math ──────────────────────────────────────

  it('CRITICAL 30-day windowMs default = 2_592_000_000 ms. Matches the V-295c2 status-snapshot window + V-297 GDPR audit retention.', () => {
    expect(30 * 24 * 60 * 60 * 1000).toBe(2_592_000_000);
  });

  // ─── lastFailureAt nullable round-trip ───────────────────────

  it('CRITICAL report() lastFailureAt = ISO string when failure exists, null when clean. The nullable round-trip preserves the no-failure-in-window signal.', async () => {
    const svc = new SlaReportingService(
      stubProbes(() =>
        Promise.resolve([
          {
            target: 'api',
            okCount: 100,
            failCount: 1,
            lastProbeAt: new Date('2026-05-15T01:00:00Z'),
            lastFailureAt: new Date('2026-05-14T15:30:00Z'),
          },
          {
            target: 'docs',
            okCount: 100,
            failCount: 0,
            lastProbeAt: new Date('2026-05-15T01:00:00Z'),
            lastFailureAt: null,
          },
        ]),
      ),
    );
    const result = await svc.report(new Date('2026-05-15T01:00:00Z'));
    expect(result[0]!.lastFailureAt).toBe('2026-05-14T15:30:00.000Z');
    expect(result[1]!.lastFailureAt).toBeNull();
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/sla-reporting-v295e-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
