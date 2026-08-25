// W398.C — drift guard for apps/server/src/services/sla-reporting.ts.
// V-295e rolling-window SLA reporting from V-295b probe history.
// Pure-logic service: ProbesRepo + window → SlaTargetReport[]. Surfaces
// "operational since {timestamp}" via lastFailureAt. Drift here either
// breaks the status-page uptime display or fabricates SLA % (rounding
// drift / division-by-zero leak).
//
//   • V-295e framing + V-295b probe history source.
//   • Default window: 30 days (30 * 24 * 60 * 60 * 1000 ms).
//   • Pure-logic posture: takes ProbesRepo + window, returns snapshot;
//     no side effects, no caching (cache later if QPS demands).
//   • SlaTargetReport: 8 fields (target / uptimePct / totalProbes /
//     okCount / failCount / lastProbeAt / lastFailureAt / windowStart
//     / windowEnd).
//   • Edge case: total=0 → uptimePct=100 (no data ≠ failure).
//   • Rounding: 3 decimals (Math.round(pct*1000)/1000).
//   • lastFailureAt: null when no failures in window.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/sla-reporting.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W398.C apps/server/src/services/sla-reporting.ts content parity', () => {
  const body = read(LIB);

  it('V-295e framing + V-295b probe history source pinned', () => {
    expect(body).toMatch(/V-295e — rolling-window SLA reporting from V-295b probe history\./);
    expect(body).toMatch(
      /Computes uptime % per probe target over a configurable lookback\s*\/\/\s*window \(default 30 days\)\./,
    );
  });

  it('"operational since {timestamp}" framing pinned via lastFailureAt', () => {
    expect(body).toMatch(
      /Surfaces per-target lastFailureAt so the\s*\/\/\s*status page can show "operational since \{timestamp\}" if there hasn't\s*\/\/\s*been a recent incident/,
    );
  });

  it('Pure-logic posture framing: no side effects, no caching, cache later if QPS demands', () => {
    expect(body).toMatch(
      /Pure-logic service: takes a ProbesRepo \+ a window\. Returns a snapshot;\s*\/\/\s*no side effects, no caching\. Cache later if QPS demands\./,
    );
  });

  it('SlaTargetReport: 8 fields (target / uptimePct / totalProbes / okCount / failCount / lastProbeAt / lastFailureAt / windowStart / windowEnd)', () => {
    expect(body).toMatch(/export interface SlaTargetReport \{/);
    expect(body).toMatch(/target: string;/);
    expect(body).toMatch(/uptimePct: number;/);
    expect(body).toMatch(/Total probes in the window\. 0 means "no data yet for this target\."/);
    expect(body).toMatch(/totalProbes: number;/);
    expect(body).toMatch(/okCount: number;/);
    expect(body).toMatch(/failCount: number;/);
    expect(body).toMatch(/Most recent probe \(ok or fail\)\./);
    expect(body).toMatch(/lastProbeAt: string;/);
    expect(body).toMatch(/Most recent failed probe within the window, or null if none\./);
    expect(body).toMatch(/lastFailureAt: string \| null;/);
    expect(body).toMatch(/Window start, ISO\./);
    expect(body).toMatch(/windowStart: string;/);
    expect(body).toMatch(/Window end, ISO\./);
    expect(body).toMatch(/windowEnd: string;/);
  });

  it('SlaReportingService: constructor takes ProbesRepo only', () => {
    expect(body).toMatch(/export class SlaReportingService \{/);
    expect(body).toMatch(/constructor\(private readonly probes: ProbesRepo\) \{\}/);
  });

  it('report: default windowMs = 30 days (30*24*60*60*1000)', () => {
    expect(body).toMatch(
      /\/\*\* Compute SLA report for the rolling window\. Default 30 days\. \*\//,
    );
    expect(body).toMatch(
      /async report\(now: Date, windowMs = 30 \* 24 \* 60 \* 60 \* 1000\): Promise<SlaTargetReport\[\]>/,
    );
  });

  it('report: windowStart = now - windowMs; countByTargetSince(windowStart) supplies rows', () => {
    expect(body).toMatch(/const windowStart = new Date\(now\.getTime\(\) - windowMs\);/);
    expect(body).toMatch(/const rows = await this\.probes\.countByTargetSince\(windowStart\);/);
  });

  it('uptimePct: total=0 → 100; else Math.round((ok/total)*100*1000)/1000 (3 decimals)', () => {
    expect(body).toMatch(/const total = row\.okCount \+ row\.failCount;/);
    expect(body).toMatch(
      /const uptimePct = total === 0 \? 100 : Math\.round\(\(row\.okCount \/ total\) \* 100 \* 1000\) \/ 1000; \/\/ 3 decimals/,
    );
  });

  it('Per-row mapping: 8 fields with ISO conversion for lastProbeAt / lastFailureAt-null / windowStart / windowEnd', () => {
    expect(body).toMatch(/target: row\.target,/);
    expect(body).toMatch(/uptimePct,/);
    expect(body).toMatch(/totalProbes: total,/);
    expect(body).toMatch(/okCount: row\.okCount,/);
    expect(body).toMatch(/failCount: row\.failCount,/);
    expect(body).toMatch(/lastProbeAt: row\.lastProbeAt\.toISOString\(\),/);
    expect(body).toMatch(
      /lastFailureAt: row\.lastFailureAt \? row\.lastFailureAt\.toISOString\(\) : null,/,
    );
    expect(body).toMatch(/windowStart: windowStart\.toISOString\(\),/);
    expect(body).toMatch(/windowEnd: now\.toISOString\(\),/);
  });

  it('imports: ProbesRepo type only (from ./health-probe.js)', () => {
    expect(body).toMatch(/import type \{ ProbesRepo \} from '\.\/health-probe\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
