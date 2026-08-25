// W696 — cross-SDK V-452 usage time-series parity. Twenty-third in
// the cross-SDK drift-guard series (W649 + W675 + W676 + W677 +
// W678 + W679 + W680 + W681 + W682 + W683 + W684 + W685 + W686 +
// W687 + W688 + W689 + W690 + W691 + W692 + W693 + W694 + W695 +
// W696).
//
// Asserts the V-452 daily-bucketed usage-time-series contract is
// consistent across all 3 SDKs:
//
//   - V-452 anchor pinned on the series verb in all 3 SDKs
//   - 2-verb surface (current / current_period + series) — language-
//     canonical naming
//   - 2 wire-paths: /v1/usage + /v1/usage/series
//   - `days` 1-90 with default 30 — server-side default kicks in
//     for omitted query param (drift to days=0 default-everything
//     would silently flatten the time series to a single bucket)
//   - GET-only verbs (time-series is read-only)
//   - UsageSeriesResponse 3-field shape in sdk-go: from_date +
//     to_date + buckets
//   - daily-bucketed framing pinned per-SDK (rendering trend charts
//     in customer dashboards depends on per-day buckets)
//
// CRITICAL invariant: days param BOUND to 1-90 — drift to letting
// >90 through would silently widen the server-side query window
// past the index-cache budget on usage_event rows.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_USAGE = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/usage.ts');
const GO_USAGE = resolve(REPO_ROOT, 'packages/sdk-go/usage.go');
const PY_USAGE = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/usage.py');

describe('W696 cross-SDK V-452 usage time-series parity', () => {
  it('all 3 SDK usage files exist at canonical paths', () => {
    expect(existsSync(TS_USAGE), `missing ${TS_USAGE}`).toBe(true);
    expect(existsSync(GO_USAGE), `missing ${GO_USAGE}`).toBe(true);
    expect(existsSync(PY_USAGE), `missing ${PY_USAGE}`).toBe(true);
  });

  it('CRITICAL V-452 anchor pinned on the series verb in all 3 SDKs. V-452 is the daily-bucketed time-series feature anchor; drift to dropping would lose changelog provenance.', () => {
    const ts = read(TS_USAGE);
    const go = read(GO_USAGE);
    const py = read(PY_USAGE);

    expect(ts).toMatch(/V-452/);
    expect(go).toMatch(/V-452/);
    expect(py).toMatch(/V-452/);
  });

  it('CRITICAL 2-verb surface pinned across all 3 SDKs — current (TS) / current_period (Python) / CurrentPeriod (Go) + series. Drift to dropping either verb would break dashboards (current() for billing-period summary, series() for trend charts).', () => {
    const ts = read(TS_USAGE);
    const go = read(GO_USAGE);
    const py = read(PY_USAGE);

    // sdk-typescript: current + series.
    expect(ts).toMatch(/current\(\)/);
    expect(ts).toMatch(/series\(opts:/);

    // sdk-go: CurrentPeriod + Series.
    expect(go).toMatch(/func \(r \*UsageResource\) CurrentPeriod\(/);
    expect(go).toMatch(/func \(r \*UsageResource\) Series\(/);

    // sdk-python: current_period + series.
    expect(py).toMatch(/def current_period\(self/);
    expect(py).toMatch(/def series\(self/);
  });

  it('CRITICAL 2 wire-paths pinned per-SDK: /v1/usage + /v1/usage/series. Drift to renaming either path would break server-side routing.', () => {
    const ts = read(TS_USAGE);
    const go = read(GO_USAGE);
    const py = read(PY_USAGE);

    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/\/v1\/usage/);
      expect(sdk).toMatch(/\/v1\/usage\/series/);
    }
  });

  it('CRITICAL "daily-bucketed" framing pinned in all 3 SDKs. The "daily-bucketed" wording is what tells customers the granularity (NOT minute/hour/week) — it shapes their chart-rendering. Drift to a different granularity would silently break dashboards expecting 1-bucket-per-day.', () => {
    const ts = read(TS_USAGE);
    const go = read(GO_USAGE);
    const py = read(PY_USAGE);

    expect(ts).toMatch(/daily-bucketed/);
    expect(go).toMatch(/daily-bucketed/);
    expect(py).toMatch(/daily-bucketed/);
  });

  it('CRITICAL `days` 1-90 + default 30 framing pinned in all 3 SDKs. The `1-90` bound is the SERVER-SIDE cap (drift to >90 would silently widen the query window past the index-cache budget on usage_event rows — server returns 400). The default-30 is the SERVER-SIDE default when the client omits days. Drift to dropping either would let dashboards request unbounded windows.', () => {
    const ts = read(TS_USAGE);
    const go = read(GO_USAGE);
    const py = read(PY_USAGE);

    // sdk-typescript: "`days` is 1-90; default 30."
    expect(ts).toMatch(/`days` is 1-90/);
    expect(ts).toMatch(/default\s*\*?\s*30/);

    // sdk-go: "`days` is 1-90; default 30 server-side when 0 / negative."
    expect(go).toMatch(/`days` is 1-90/);
    expect(go).toMatch(/default 30 server-side/);

    // sdk-python: "``days`` is 1-90; default 30."
    expect(py).toMatch(/``days`` is 1-90/);
    expect(py).toMatch(/default 30/);
  });

  it('CRITICAL GET-only verb invariant — both current/current_period and series are GET. Drift to POST/PUT on read endpoints would silently turn cacheable read into mutation (CDN + browser cache invalidation).', () => {
    const ts = read(TS_USAGE);
    const go = read(GO_USAGE);

    // sdk-typescript: 2 GET method declarations.
    const tsGetCount = (ts.match(/method: 'GET'/g) ?? []).length;
    expect(tsGetCount, 'sdk-typescript GET method count').toBe(2);

    // sdk-go: 2 GET method declarations.
    const goGetCount = (go.match(/method: "GET"/g) ?? []).length;
    expect(goGetCount, 'sdk-go GET method count').toBe(2);

    // sdk-python: 2 "GET" string references on http.request calls.
    const py = read(PY_USAGE);
    const pyGetCount = (py.match(/request\("GET"/g) ?? []).length;
    expect(pyGetCount, 'sdk-python GET request count').toBeGreaterThanOrEqual(2);
  });

  it('CRITICAL UsageSeriesResponse 3-field shape pinned in sdk-go — from_date + to_date + buckets. The 3-field envelope is what carries the bucketed time-series + the window the server picked (so clients know what range they got back, including the default-30 case). Drift to dropping from_date/to_date would force clients to compute the range themselves.', () => {
    const go = read(GO_USAGE);
    expect(go).toMatch(
      /type UsageSeriesResponse struct \{[\s\S]*?FromDate[\s\S]*?ToDate[\s\S]*?Buckets/,
    );
    // Wire-name pinning.
    expect(go).toMatch(/`json:"from_date"`/);
    expect(go).toMatch(/`json:"to_date"`/);
    expect(go).toMatch(/`json:"buckets"`/);
  });

  it('CRITICAL UsageDailyBucket shape pinned in sdk-go — date (YYYY-MM-DD) + totals (UsageRecordType → int). The bucket holds per-record-type totals; drift to dropping totals would render trend charts useless.', () => {
    const go = read(GO_USAGE);
    expect(go).toMatch(/type UsageDailyBucket struct/);
    expect(go).toMatch(/Date\s+string\s+`json:"date"`/);
    expect(go).toMatch(/Totals\s+map\[string\]int\s+`json:"totals"`/);
    // YYYY-MM-DD format comment.
    expect(go).toMatch(/YYYY-MM-DD/);
  });

  it('CRITICAL "Useful for rendering trend charts in customer dashboards" customer-facing claim pinned in sdk-typescript. The claim tells customers WHY the series endpoint exists; drift to dropping would lose product framing.', () => {
    const ts = read(TS_USAGE);
    expect(ts).toMatch(/rendering trend charts in customer dashboards/);
  });

  it('CRITICAL UsageRecordType enum reference pinned in sdk-go — `Totals` keys are the closed-set enum values. Drift to dropping the closed-set framing would let server emit unknown record types and silently break dashboard switch statements.', () => {
    const go = read(GO_USAGE);
    expect(go).toMatch(/UsageRecordType enum values/);
    // 2 examples pinned.
    expect(go).toMatch(/session_minute/);
    expect(go).toMatch(/navigate/);
  });

  it('CRITICAL calendar-month-UTC framing on current/current_period in sdk-go + sdk-python. The "calendar-month-UTC" wording is what pins billing-period semantic — drift to "rolling 30-day" would change billing-period boundary and silently change customer invoices.', () => {
    const go = read(GO_USAGE);
    const py = read(PY_USAGE);

    expect(go).toMatch(/calendar-month-UTC/);
    expect(py).toMatch(/calendar-month UTC/);
  });

  it('Cross-SDK V-452 5-invariant cluster — V-452 anchor + 2-verb surface (current/current_period + series) + 2 wire-paths (/v1/usage + /v1/usage/series) + daily-bucketed framing + days-1-90-default-30 framing. Drift on any would fragment the cross-language usage-series contract.', () => {
    const sdks = {
      'sdk-typescript': read(TS_USAGE),
      'sdk-go': read(GO_USAGE),
      'sdk-python': read(PY_USAGE),
    };

    for (const [name, body] of Object.entries(sdks)) {
      expect(body, `${name} V-452`).toMatch(/V-452/);
      expect(body, `${name} /v1/usage`).toMatch(/\/v1\/usage/);
      expect(body, `${name} /v1/usage/series`).toMatch(/\/v1\/usage\/series/);
      expect(body, `${name} daily-bucketed`).toMatch(/daily-bucketed/);
      expect(body, `${name} 1-90`).toMatch(/1-90/);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-usage-series-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
