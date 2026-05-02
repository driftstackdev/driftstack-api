// UsageResource — typed methods for /v1/usage.

import type { UsagePeriodSummary } from '@driftstack/api-types';
import type { HttpClient } from '../http.js';

export class UsageResource {
  constructor(private readonly http: HttpClient) {}

  /** Current billing period: usage totals + tier quotas. */
  current(): Promise<UsagePeriodSummary> {
    return this.http.request<UsagePeriodSummary>({ method: 'GET', path: '/v1/usage' });
  }
}
