// Drizzle-backed implementation of LegalRepo.

import { sql } from 'drizzle-orm';
import type { LegalAcceptanceRecord, LegalRepo, RecordAcceptanceInput } from '../services/legal.js';
import type { Database } from './client.js';
import { legalAcceptances } from './schema.js';

export class DrizzleLegalRepo implements LegalRepo {
  constructor(private readonly database: Database) {}

  async recordAcceptance(input: RecordAcceptanceInput): Promise<LegalAcceptanceRecord> {
    const [row] = await this.database.db
      .insert(legalAcceptances)
      .values({
        accountId: input.accountId,
        documentKey: input.documentKey,
        version: input.version,
        contentHash: input.contentHash,
        acceptedFromIp: input.acceptedFromIp,
        acceptedUserAgent: input.acceptedUserAgent,
      })
      .returning();
    if (row === undefined) {
      throw new Error('legal_acceptances insert returned no row');
    }
    return mapRow(row);
  }

  async latestAcceptancesForAccount(
    accountId: string,
  ): Promise<Map<string, LegalAcceptanceRecord>> {
    // For each (account, document_key), keep the row with the latest
    // accepted_at. Postgres DISTINCT ON is the cleanest way; Drizzle
    // doesn't expose it natively but raw SQL is fine.
    const rows = await this.database.db.execute<{
      id: string;
      account_id: string;
      document_key: string;
      version: string;
      content_hash: string;
      accepted_from_ip: string | null;
      accepted_user_agent: string | null;
      accepted_at: string | Date;
    }>(sql`
      SELECT DISTINCT ON (document_key)
        id, account_id, document_key, version, content_hash,
        accepted_from_ip, accepted_user_agent, accepted_at
      FROM legal_acceptances
      WHERE account_id = ${accountId}
      ORDER BY document_key, accepted_at DESC
    `);
    const out = new Map<string, LegalAcceptanceRecord>();
    // Drizzle's execute() returns RowList iterable but TS sometimes
    // narrows differently per driver. Iterate `for-of` so both
    // pg-style { rows } and array-shaped results are covered.
    const iter = (rows as unknown as { rows?: unknown[] }).rows ?? rows;
    for (const raw of iter as Iterable<{
      id: string;
      account_id: string;
      document_key: string;
      version: string;
      content_hash: string;
      accepted_from_ip: string | null;
      accepted_user_agent: string | null;
      accepted_at: string | Date;
    }>) {
      const mapped: LegalAcceptanceRecord = {
        id: raw.id,
        accountId: raw.account_id,
        documentKey: raw.document_key,
        version: raw.version,
        contentHash: raw.content_hash,
        acceptedFromIp: raw.accepted_from_ip,
        acceptedUserAgent: raw.accepted_user_agent,
        acceptedAt: new Date(raw.accepted_at),
      };
      out.set(mapped.documentKey, mapped);
    }
    return out;
  }
}

function mapRow(row: typeof legalAcceptances.$inferSelect): LegalAcceptanceRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    documentKey: row.documentKey,
    version: row.version,
    contentHash: row.contentHash,
    acceptedFromIp: row.acceptedFromIp,
    acceptedUserAgent: row.acceptedUserAgent,
    acceptedAt: row.acceptedAt,
  };
}
