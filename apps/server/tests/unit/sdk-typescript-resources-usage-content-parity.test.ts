// W429.B — drift guard for packages/sdk-typescript/src/resources/usage.ts.
// UsageResource — current-period summary + V-452 daily series. Drift
// here either breaks the days bound (server-side O(N) scan unbounded)
// or strips the conditional query spread (sends an empty `days` key
// that confuses servers that treat empty-string as 0).
//
//   • Framing pinned: typed methods for /v1/usage.
//   • 2-verb surface: current (GET /v1/usage) + V-452 series (GET
//     /v1/usage/series).
//   • V-452 series: days 1-90 (default 30); per-record-type bucketed
//     totals; trend-chart use case.
//   • Conditional query passthrough: { days } only when defined; {}
//     otherwise.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/usage.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W429.B packages/sdk-typescript/src/resources/usage.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: typed methods for /v1/usage', () => {
    expect(body).toMatch(/\/\/ UsageResource — typed methods for \/v1\/usage\./);
  });

  it('imports: UsagePeriodSummary + UsageSeriesResponse from api-types + HttpClient', () => {
    expect(body).toMatch(
      /import type \{ UsagePeriodSummary, UsageSeriesResponse \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
  });

  it('current verb: GET /v1/usage → UsagePeriodSummary (current billing period totals + tier quotas)', () => {
    expect(body).toMatch(/\/\*\* Current billing period: usage totals \+ tier quotas\. \*\//);
    expect(body).toMatch(
      /current\(\): Promise<UsagePeriodSummary> \{\s*\n?\s*return this\.http\.request<UsagePeriodSummary>\(\{ method: 'GET', path: '\/v1\/usage' \}\);\s*\n?\s*\}/,
    );
  });

  it('V-452 series verb: GET /v1/usage/series; days 1-90 default 30; per-record-type bucketed totals for trend charts; conditional query spread when opts.days defined', () => {
    expect(body).toMatch(
      /\*\s*V-452 — daily-bucketed usage time series\. `days` is 1-90; default\s*\n?\s*\*\s*30\. Each bucket holds per-record-type totals for that day\. Useful\s*\n?\s*\*\s*for rendering trend charts in customer dashboards\./,
    );
    expect(body).toMatch(
      /series\(opts: \{ days\?: number \} = \{\}\): Promise<UsageSeriesResponse> \{\s*\n?\s*return this\.http\.request<UsageSeriesResponse>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/usage\/series',\s*\n?\s*query: opts\.days !== undefined \? \{ days: opts\.days \} : \{\},\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
