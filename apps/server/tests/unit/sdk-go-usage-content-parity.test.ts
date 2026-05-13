// W592.B — drift guard for packages/sdk-go/usage.go.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/usage.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W592.B packages/sdk-go/usage.go content parity', () => {
  const body = read(LIB);

  it('UsageResource /v1/usage + /v1/usage/series + CurrentPeriod calendar-month-UTC + V-452 Series days=1-90 default-30 server-side (only emit ?days when >0) pinned', () => {
    expect(body).toMatch(/\/\/ UsageResource handles \/v1\/usage \+ \/v1\/usage\/series\./);
    expect(body).toMatch(/^type UsageResource struct \{\s*\n\s*client \*Client\s*\n\}/m);
    expect(body).toMatch(/\/\/ CurrentPeriod returns the calendar-month-UTC totals \+ tier quotas/);
    expect(body).toMatch(/path:\s+"\/v1\/usage",/);
    expect(body).toMatch(/\/\/ UsageDailyBucket — V-452 single-day bucket on the time series\./);
    expect(body).toMatch(/Date\s+string\s+`json:"date"` \/\/ YYYY-MM-DD/);
    expect(body).toMatch(/Totals map\[string\]int `json:"totals"`/);
    expect(body).toMatch(/\/\/ UsageSeriesResponse — V-452 daily-bucketed time series\./);
    expect(body).toMatch(/\/\/ Series — V-452 daily-bucketed usage time series\./);
    expect(body).toMatch(/\/\/ default 30 server-side when 0 \/ negative\./);
    expect(body).toMatch(/if days > 0 \{\s*\n\s*q\.Set\("days", strconv\.Itoa\(days\)\)\s*\n\s*\}/);
    expect(body).toMatch(/path:\s+"\/v1\/usage\/series",/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
