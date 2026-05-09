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
