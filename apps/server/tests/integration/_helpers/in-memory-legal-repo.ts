// In-memory implementation of LegalRepo for integration tests.
// Mirrors the behaviour of DrizzleLegalRepo (latest acceptance per
// (account, document_key)) without touching Postgres.

import { randomUUID } from 'node:crypto';
import type {
  LegalAcceptanceRecord,
  LegalRepo,
  RecordAcceptanceInput,
} from '../../../src/services/legal.js';

export class InMemoryLegalRepo implements LegalRepo {
  private rows: LegalAcceptanceRecord[] = [];

  async recordAcceptance(input: RecordAcceptanceInput): Promise<LegalAcceptanceRecord> {
    await Promise.resolve();
    const row: LegalAcceptanceRecord = {
      id: randomUUID(),
      accountId: input.accountId,
      documentKey: input.documentKey,
      version: input.version,
      contentHash: input.contentHash,
      acceptedFromIp: input.acceptedFromIp,
      acceptedUserAgent: input.acceptedUserAgent,
      acceptedAt: new Date(),
    };
    this.rows.push(row);
    return { ...row };
  }

  async latestAcceptancesForAccount(
    accountId: string,
  ): Promise<Map<string, LegalAcceptanceRecord>> {
    await Promise.resolve();
    const out = new Map<string, LegalAcceptanceRecord>();
    // Iterate newest-first; first hit per documentKey wins. The `id`
    // tiebreaker mirrors the Drizzle repo's `accepted_at DESC, id DESC`
    // so a same-millisecond tie (Date is ms-resolution) resolves
    // deterministically AND identically to the production query.
    const sorted = [...this.rows].sort(
      (a, b) =>
        b.acceptedAt.getTime() - a.acceptedAt.getTime() || (a.id > b.id ? -1 : a.id < b.id ? 1 : 0),
    );
    for (const row of sorted) {
      if (row.accountId !== accountId) continue;
      if (!out.has(row.documentKey)) out.set(row.documentKey, row);
    }
    return out;
  }
}
