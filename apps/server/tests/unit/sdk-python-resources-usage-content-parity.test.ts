// W580.B — drift guard for packages/sdk-python/src/resources/usage.py.
// V-452 UsageResource Python parity. Drift here either strips the
// V-452 time-series surface or breaks the (1-90 day, default-30)
// query-string protocol used by the customer-dashboard usage chart.
//
//   • Two paired classes: UsageResource (sync) + AsyncUsageResource.
//   • current_period() → UsagePeriodSummary (pydantic-model-validated).
//   • series(days=…) → dict; days kwarg-only, 1-90 default 30.
//   • Query string built via urlencode; absent days = no `?days=`.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/usage.py');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W580.B packages/sdk-python/src/driftstack/resources/usage.py content parity', () => {
  const body = read(LIB);

  it('Module docstring + /v1/usage + /v1/usage/series single-line scope pinned', () => {
    expect(body).toMatch(/^"""Usage resource — \/v1\/usage \+ \/v1\/usage\/series\."""/);
  });

  it('Imports: __future__ + Any + urlencode + UsagePeriodSummary generated model + Async/Sync HttpClient pinned', () => {
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^from typing import Any$/m);
    expect(body).toMatch(/^from urllib\.parse import urlencode$/m);
    expect(body).toMatch(/^from driftstack\._generated\.models import UsagePeriodSummary$/m);
    expect(body).toMatch(/^from driftstack\.http import AsyncHttpClient, HttpClient$/m);
  });

  it('Sync UsageResource: current_period() pydantic-validates UsagePeriodSummary + series(days=) urlencode-builds query-string only when days set', () => {
    expect(body).toMatch(/^class UsageResource:$/m);
    expect(body).toMatch(/"""Synchronous usage resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: HttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
    expect(body).toMatch(
      /def current_period\(self\) -> UsagePeriodSummary:\s*\n\s*"""Current calendar-month UTC totals \+ tier quotas\."""\s*\n\s*data = self\._http\.request\("GET", "\/v1\/usage"\)\s*\n\s*return UsagePeriodSummary\.model_validate\(data\)/,
    );
    expect(body).toMatch(/def series\(self, \*, days: int \| None = None\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""V-452 — daily-bucketed usage time series\. ``days`` is 1-90;/);
    expect(body).toMatch(/default 30\. Returns ``\{"from_date", "to_date", "buckets"\}``\./);
    expect(body).toMatch(/path = "\/v1\/usage\/series"\s*\n\s*if days is not None:/);
    expect(body).toMatch(/path = f"\{path\}\?\{urlencode\(\{'days': days\}\)\}"/);
    expect(body).toMatch(/return self\._http\.request\("GET", path\)/);
  });

  it('Async AsyncUsageResource: mirrored awaited surface (UsagePeriodSummary.model_validate stays sync; only request is awaited)', () => {
    expect(body).toMatch(/^class AsyncUsageResource:$/m);
    expect(body).toMatch(/"""Async usage resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: AsyncHttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
    expect(body).toMatch(
      /async def current_period\(self\) -> UsagePeriodSummary:\s*\n\s*data = await self\._http\.request\("GET", "\/v1\/usage"\)\s*\n\s*return UsagePeriodSummary\.model_validate\(data\)/,
    );
    expect(body).toMatch(
      /async def series\(self, \*, days: int \| None = None\) -> dict\[str, Any\]:\s*\n\s*path = "\/v1\/usage\/series"\s*\n\s*if days is not None:\s*\n\s*path = f"\{path\}\?\{urlencode\(\{'days': days\}\)\}"\s*\n\s*return await self\._http\.request\("GET", path\)/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
