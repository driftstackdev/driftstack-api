// W592.B (W635-deepened) — drift guard for packages/sdk-go/usage.go.
// V-452 usage telemetry resource (60 lines, 2 verbs).
//
// W635 splits the original 2 it() blocks into 5 focused per-concept
// blocks + pins previously-implicit invariants:
//
//   • CurrentPeriod calendar-month-UTC semantics — both "calendar"
//     (1st-of-month boundary, not rolling 30d) and "UTC" (timezone
//     boundary) qualifiers pinned. Drift to a rolling window would
//     break the period totals customers reconcile against invoices.
//   • UsageDailyBucket date format YYYY-MM-DD invariant (preserved
//     in a // YYYY-MM-DD inline-comment on the Date field).
//   • Totals map[string]int with UsageRecordType enum keys
//     (session_minute / navigate / interact / etc.) — server-side
//     enum membership pinned via the doc-comment.
//   • Series days=1-90 server-side clamp + server-side-default-30
//     when days≤0 (the SDK only emits ?days when days>0, so the URL
//     stays clean and the server applies its default).
//   • UsageSeriesResponse 3-field envelope shape (from_date / to_date
//     / buckets) so the date range bookends the bucket array and
//     paginators don't need to compute the window themselves.

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

  it('file exists at canonical path + UsageResource binds /v1/usage + /v1/usage/series (2-verb surface)', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^package driftstack$/m);
    expect(body).toMatch(/\/\/ UsageResource handles \/v1\/usage \+ \/v1\/usage\/series\./);
    expect(body).toMatch(/^type UsageResource struct \{\s*\n\s*client \*Client\s*\n\}/m);
  });

  it('CurrentPeriod — GET /v1/usage returns CALENDAR-MONTH-UTC totals + tier quotas for the current account. Both "calendar" (1st-of-month boundary, not rolling 30d window) and "UTC" (timezone boundary) qualifiers pinned. Drift to a rolling window would break the period totals customers reconcile against monthly invoices.', () => {
    expect(body).toMatch(/\/\/ CurrentPeriod returns the calendar-month-UTC totals \+ tier quotas/);
    expect(body).toMatch(/\/\/ for the current account\./);
    expect(body).toMatch(
      /func \(r \*UsageResource\) CurrentPeriod\(ctx context\.Context\) \(\*UsagePeriodSummary, error\)/,
    );
    expect(body).toMatch(/method: "GET",\s*\n\s*path:\s+"\/v1\/usage",/);
  });

  it('UsageDailyBucket — V-452 single-day bucket struct. Date is string with YYYY-MM-DD format invariant (inline-comment // YYYY-MM-DD pinned). Totals is map[string]int keyed by UsageRecordType enum values (session_minute / navigate / interact / etc.) so the buckets share the enum surface with other usage endpoints.', () => {
    expect(body).toMatch(/\/\/ UsageDailyBucket — V-452 single-day bucket on the time series\./);
    expect(body).toMatch(/\/\/ `Totals` keys are the UsageRecordType enum values \(e\.g\./);
    expect(body).toMatch(/\/\/ "session_minute", "navigate", "interact", etc\.\)\./);
    expect(body).toMatch(
      /^type UsageDailyBucket struct \{\s*\n\s*Date\s+string\s+`json:"date"` \/\/ YYYY-MM-DD\s*\n\s*Totals map\[string\]int `json:"totals"`\s*\n\}/m,
    );
  });

  it('UsageSeriesResponse — V-452 3-field envelope (from_date + to_date + buckets). Date range bookends pinned so customer charting code can render axis labels without computing the window from the bucket array.', () => {
    expect(body).toMatch(/\/\/ UsageSeriesResponse — V-452 daily-bucketed time series\./);
    expect(body).toMatch(
      /^type UsageSeriesResponse struct \{\s*\n\s*FromDate string\s+`json:"from_date"`\s*\n\s*ToDate\s+string\s+`json:"to_date"`\s*\n\s*Buckets\s+\[\]UsageDailyBucket `json:"buckets"`\s*\n\}/m,
    );
  });

  it('Series — V-452 GET /v1/usage/series daily-bucketed time series. days param server-side clamps to 1-90; defaults to 30 server-side when days≤0. The SDK only emits ?days when days>0 — so calling Series(ctx, 0) sends NO query param (server applies default) rather than a redundant ?days=0. Drift to always-emit would force every call to carry a redundant param.', () => {
    expect(body).toMatch(/\/\/ Series — V-452 daily-bucketed usage time series\. `days` is 1-90;/);
    expect(body).toMatch(/\/\/ default 30 server-side when 0 \/ negative\./);
    expect(body).toMatch(
      /func \(r \*UsageResource\) Series\(ctx context\.Context, days int\) \(\*UsageSeriesResponse, error\)/,
    );
    expect(body).toMatch(/if days > 0 \{\s*\n\s*q\.Set\("days", strconv\.Itoa\(days\)\)\s*\n\s*\}/);
    expect(body).toMatch(/method: "GET",\s*\n\s*path:\s+"\/v1\/usage\/series",\s*\n\s*query:\s+q,/);
  });
});
