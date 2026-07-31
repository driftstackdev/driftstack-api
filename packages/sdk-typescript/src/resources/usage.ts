// UsageResource — typed methods for /v1/usage.

import type { UsagePeriodSummary, UsageSeriesResponse } from '@driftstack/api-types';
import type { HttpClient } from '../http.js';

export class UsageResource {
  constructor(private readonly http: HttpClient) {}

  /** Current billing period: usage totals + tier quotas. */
  current(): Promise<UsagePeriodSummary> {
    return this.http.request<UsagePeriodSummary>({ method: 'GET', path: '/v1/usage' });
  }

  /**
   * Cross-SDK naming alias for {@link current}. The Python (`current_period`)
   * and Go (`CurrentPeriod`) SDKs name this operation after the billing period
   * it reads; TS keeps the historical `current` name and exposes
   * `currentPeriod` as a thin synonym so the three SDKs share a vocabulary and
   * a customer porting between them does not hit a rename. Identical semantics
   * + signature — pick either. Same pattern as `cryptoOrders.iterate`.
   */
  currentPeriod(): Promise<UsagePeriodSummary> {
    return this.current();
  }

  /**
   * V-452 — daily-bucketed usage time series. `days` is 1-90; default
   * 30. Each bucket holds per-record-type totals for that day. Useful
   * for rendering trend charts in customer dashboards.
   */
  series(opts: { days?: number } = {}): Promise<UsageSeriesResponse> {
    return this.http.request<UsageSeriesResponse>({
      method: 'GET',
      path: '/v1/usage/series',
      query: opts.days !== undefined ? { days: opts.days } : {},
    });
  }
}
