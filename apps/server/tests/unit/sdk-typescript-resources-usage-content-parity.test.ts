// W429.B (W646-deepened) — drift guard for packages/sdk-typescript/src/resources/usage.ts.
// UsageResource TS — current-period summary + V-452 daily series.
//
// W646 splits the 5 it() blocks into 8 focused per-concept blocks +
// pins previously-implicit invariants:
//
//   • V-452 series days 1-90 server-side clamp + default 30 +
//     conditional query passthrough (empty-string would confuse
//     servers treating empty as 0).
//   • TS-side per-record-type bucket structure pinned via the
//     UsageSeriesResponse api-types import (drift to a hand-rolled
//     local type would diverge from the Zod single-source-of-truth).
//   • Conditional query spread `opts.days !== undefined ? { days } : {}`
//     — drift to `opts.days ?? 30` would client-side-default and
//     defeat the server-side default-30 contract.
//   • Read-only http property + class shape pinned (only 1 SDK-level
//     dependency, drift to adding state would break the "resources
//     are stateless wrappers over HttpClient" architecture).

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

  it('file exists at canonical path + module-level framing pinned ("UsageResource — typed methods for /v1/usage.")', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^\/\/ UsageResource — typed methods for \/v1\/usage\./m);
  });

  it('Imports — 2-line surface: UsagePeriodSummary + UsageSeriesResponse from @driftstack/api-types (the Zod single-source-of-truth) + HttpClient from sibling ../http.js (.js extension for ESM resolution). Drift to a hand-rolled local UsageSeriesResponse would diverge from the cross-SDK wire shape.', () => {
    expect(body).toMatch(
      /import type \{ UsagePeriodSummary, UsageSeriesResponse \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
  });

  it('UsageResource class shape — single private-readonly http: HttpClient constructor field. Stateless wrapper architecture: every resource is a thin typed facade over the shared HttpClient, no per-resource state. Drift to adding mutable fields would break the "resources are interchangeable view objects over the same transport" pattern.', () => {
    expect(body).toMatch(/^export class UsageResource \{$/m);
    expect(body).toMatch(/constructor\(private readonly http: HttpClient\) \{\}/);
  });

  it('current() verb — GET /v1/usage returns UsagePeriodSummary (current billing period totals + tier quotas). Single-line implementation: this.http.request<UsagePeriodSummary>({ method: GET, path: /v1/usage }). Drift to splitting into a body-prep helper would break the "minimal facade" invariant.', () => {
    expect(body).toMatch(/\/\*\* Current billing period: usage totals \+ tier quotas\. \*\//);
    expect(body).toMatch(
      /current\(\): Promise<UsagePeriodSummary> \{\s*\n?\s*return this\.http\.request<UsagePeriodSummary>\(\{ method: 'GET', path: '\/v1\/usage' \}\);\s*\n?\s*\}/,
    );
  });

  it('V-452 series() doc-comment — "daily-bucketed usage time series" + "`days` is 1-90; default 30" server-side contract + "per-record-type totals for that day" structural shape + "rendering trend charts in customer dashboards" use-case framing. All four contract points pinned individually because dropping any silently shrinks the customer-facing contract.', () => {
    expect(body).toMatch(/V-452 — daily-bucketed usage time series\. `days` is 1-90; default/);
    expect(body).toMatch(/30\. Each bucket holds per-record-type totals for that day\. Useful/);
    expect(body).toMatch(/for rendering trend charts in customer dashboards\./);
  });

  it('series() signature — `opts: { days?: number } = {}` default-empty-options ergonomic so callers can write `usage.series()` without passing options at all. Return type Promise<UsageSeriesResponse>. Drift to making opts required would break the "I just want defaults" call site.', () => {
    expect(body).toMatch(
      /series\(opts: \{ days\?: number \} = \{\}\): Promise<UsageSeriesResponse>/,
    );
  });

  it('CRITICAL: series() conditional query spread — `query: opts.days !== undefined ? { days: opts.days } : {}`. The `!== undefined` check (not `?? 30` or `||`) is load-bearing: it lets the server apply its default-30 when the caller omits days, rather than client-side-defaulting which would race with future server-side default changes. Empty `{}` (not absent query key) also pinned because http.request needs the key to short-circuit query-string emission.', () => {
    expect(body).toMatch(
      /return this\.http\.request<UsageSeriesResponse>\(\{\s*\n?\s*method: 'GET',\s*\n?\s*path: '\/v1\/usage\/series',\s*\n?\s*query: opts\.days !== undefined \? \{ days: opts\.days \} : \{\},\s*\n?\s*\}\);/,
    );
  });

  it('Wire path symmetry between current + series: both GET /v1/usage with series adding /series suffix. Drift to e.g. /v1/usage-series (hyphenated sibling) would diverge from REST-canonical nested-resource pattern.', () => {
    expect(body).toMatch(/path: '\/v1\/usage'/);
    expect(body).toMatch(/path: '\/v1\/usage\/series'/);
  });

  it('CRITICAL exposes `currentPeriod` as a cross-SDK alias for `current`. Python names this `current_period` and Go names it `CurrentPeriod`; without the alias a customer porting between SDKs hits a silent rename on the same endpoint. Same pattern as `cryptoOrders.iterate` — the alias must delegate, never re-implement, so the two can never diverge.', () => {
    expect(body).toMatch(
      /currentPeriod\(\): Promise<UsagePeriodSummary> \{\s*\n\s*return this\.current\(\);\s*\n\s*\}/,
    );
    expect(body).toMatch(/Cross-SDK naming alias for \{@link current\}/);
  });
});
