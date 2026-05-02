// In-memory UsageRepo for integration tests.

import type { UsageRecordType, UsageRepo, UsageTotals } from '../../../src/services/usage.js';

export interface UsageEvent {
  accountId: string;
  recordType: UsageRecordType;
  quantity: number;
  recordedAt: Date;
}

export class InMemoryUsageRepo implements UsageRepo {
  private readonly events: UsageEvent[] = [];

  record(event: UsageEvent): void {
    this.events.push(event);
  }

  totalsForPeriod(accountId: string, periodStart: Date, periodEnd: Date): Promise<UsageTotals> {
    const totals: Partial<Record<UsageRecordType, number>> = {};
    for (const e of this.events) {
      if (e.accountId !== accountId) continue;
      if (e.recordedAt < periodStart || e.recordedAt >= periodEnd) continue;
      totals[e.recordType] = (totals[e.recordType] ?? 0) + e.quantity;
    }
    return Promise.resolve({ totals });
  }
}
