// W580.B (W642-deepened) — drift guard for packages/sdk-python/src/driftstack/resources/usage.py.
// V-452 UsageResource Python parity.
//
// W642 splits the 5 it() blocks (where the sync + async classes each
// bundled all verbs into one block) into 9 focused per-verb blocks +
// pins previously-implicit invariants:
//
//   • Mixed pydantic / dict return shapes: current_period returns a
//     pydantic-validated UsagePeriodSummary (rich typed shape via
//     model_validate), but series returns a bare dict[str, Any] (no
//     codegen yet for the time-series envelope). This split is
//     load-bearing — drift to either side would break customer
//     expectations: current_period customers rely on pydantic's
//     `.model_dump()` / attribute access, series customers rely on
//     dict-keyed access ["from_date"] etc.
//   • Kwarg-only days param (the `*, days: int | None = None`
//     signature) so callers must write series(days=30) not
//     series(30) — forward-compat against adding new optional
//     params before days in the future.
//   • Conditional ?days= query — only emitted when days is not None;
//     absent days defers to the server-side default 30.
//   • Sync/async parallel surface — UsagePeriodSummary.model_validate
//     stays SYNC even in the async path (it's pure CPU; only the
//     HTTP request is awaited).

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

  it('file exists at canonical path + module docstring scope (/v1/usage + /v1/usage/series single-line)', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^"""Usage resource — \/v1\/usage \+ \/v1\/usage\/series\."""/);
  });

  it('Imports — 5-line import surface: __future__ annotations + Any + urlencode + UsagePeriodSummary generated model + Async/Sync HttpClient. Drift to importing a hand-rolled UsagePeriodSummary (not from _generated.models) would mean the SDK and the OpenAPI spec have drifted.', () => {
    expect(body).toMatch(/^from __future__ import annotations$/m);
    expect(body).toMatch(/^from typing import Any$/m);
    expect(body).toMatch(/^from urllib\.parse import urlencode$/m);
    expect(body).toMatch(/^from driftstack\._generated\.models import UsagePeriodSummary$/m);
    expect(body).toMatch(
      /^from driftstack\.http import AsyncHttpClient, HttpClient, parse_model$/m,
    );
  });

  it('UsageResource sync class with HttpClient injection', () => {
    expect(body).toMatch(/^class UsageResource:$/m);
    expect(body).toMatch(/"""Synchronous usage resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: HttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
  });

  it('current_period (sync) — GET /v1/usage + pydantic-validates the response via UsagePeriodSummary.model_validate(data). Drift to returning bare dict (or to a different pydantic class) would break customers using attribute access (`summary.tier`) instead of dict-key access (`summary["tier"]`).', () => {
    expect(body).toMatch(
      /def current_period\(self\) -> UsagePeriodSummary:\s*\n\s*"""Current calendar-month UTC totals \+ tier quotas\."""\s*\n\s*data = self\._http\.request\("GET", "\/v1\/usage"\)\s*\n\s*return parse_model\(UsagePeriodSummary, data\)/,
    );
  });

  it('series (sync) — V-452 GET /v1/usage/series with kwarg-only days (`*, days: int | None = None`). Conditional ?days= query (urlencoded; only emitted when days is not None). Days clamps server-side to 1-90 + defaults to 30 (so omitting the kwarg defers to the server default). Returns a bare dict[str, Any] with shape `{"from_date", "to_date", "buckets"}` (no pydantic class yet for the time-series envelope).', () => {
    expect(body).toMatch(/def series\(self, \*, days: int \| None = None\) -> dict\[str, Any\]:/);
    expect(body).toMatch(/"""V-452 — daily-bucketed usage time series\. ``days`` is 1-90;/);
    expect(body).toMatch(/default 30\. Returns ``\{"from_date", "to_date", "buckets"\}``\./);
    expect(body).toMatch(
      /path = "\/v1\/usage\/series"\s*\n\s*if days is not None:\s*\n\s*path = f"\{path\}\?\{urlencode\(\{'days': days\}\)\}"\s*\n\s*return self\._http\.request\("GET", path\)/,
    );
  });

  it('AsyncUsageResource — class shell + AsyncHttpClient injection. Mirrors the sync class.', () => {
    expect(body).toMatch(/^class AsyncUsageResource:$/m);
    expect(body).toMatch(/"""Async usage resource\."""/);
    expect(body).toMatch(
      /def __init__\(self, http: AsyncHttpClient\) -> None:\s*\n\s*self\._http = http/,
    );
  });

  it('async current_period — awaited GET twin. CRITICAL: UsagePeriodSummary.model_validate stays SYNCHRONOUS even in the async path (pure CPU pydantic validation; only the HTTP request is awaited). Drift to `await UsagePeriodSummary.model_validate(...)` would not even compile, but a drift to a different validation order (validate-before-await) would break test fakes.', () => {
    expect(body).toMatch(
      /async def current_period\(self\) -> UsagePeriodSummary:\s*\n\s*data = await self\._http\.request\("GET", "\/v1\/usage"\)\s*\n\s*return parse_model\(UsagePeriodSummary, data\)/,
    );
  });

  it('async series — awaited GET twin with same conditional-query-string semantics + same kwarg-only days signature + same bare dict return shape.', () => {
    expect(body).toMatch(
      /async def series\(self, \*, days: int \| None = None\) -> dict\[str, Any\]:\s*\n\s*path = "\/v1\/usage\/series"\s*\n\s*if days is not None:\s*\n\s*path = f"\{path\}\?\{urlencode\(\{'days': days\}\)\}"\s*\n\s*return await self\._http\.request\("GET", path\)/,
    );
  });

  it('Mixed return-shape parity invariant: BOTH sync + async current_period return a pydantic UsagePeriodSummary; BOTH sync + async series return a bare dict[str, Any]. Drift to mixing return shapes between sync and async twins would silently diverge customer code paths.', () => {
    // Sync current_period: pydantic model return
    expect(body).toMatch(/def current_period\(self\) -> UsagePeriodSummary:/);
    // Async current_period: same pydantic model return
    expect(body).toMatch(/async def current_period\(self\) -> UsagePeriodSummary:/);
    // Sync series: dict[str, Any]
    expect(body).toMatch(/def series\(self, \*, days: int \| None = None\) -> dict\[str, Any\]:/);
    // Async series: same dict[str, Any]
    expect(body).toMatch(
      /async def series\(self, \*, days: int \| None = None\) -> dict\[str, Any\]:/,
    );
  });
});
