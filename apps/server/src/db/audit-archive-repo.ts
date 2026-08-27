// V-172 — Drizzle-backed ArchiveTableRepo + ArchiveLedgerRepo for the
// V-163 AuditArchiveService. The FIVE tables named by AUDIT_TABLES
// (admin_audit_log / processed_stripe_events / legal_acceptances /
// webhook_deliveries / session_events) each have a different
// primary-timestamp column; this repo dispatches to the right table +
// column per `tableName` argument. This header said "four" until
// 2026-08-17 — session_events was added by W438 and the count was not.
//
// Lifecycle as DESIGNED (ADR-006 §3). The monthly archiveAll() cadence has
// still never run — nothing calls archiveAll() anywhere in src.
//
// ⛔ V-2021 — this header used to add a clause asserting the service had no
// constructor anywhere, and that clause is stale: V-1591 constructs it in bootstrap.ts and schedules
// archiveTable('session_events') on a recurring chain. ONE of the five tables,
// by a different method than the cadence below. The four legal/financial tables
// stay unscheduled deliberately. The design is unimplemented AS DESIGNED; the
// evidence this header offered for that had stopped being true.
//
// When the full cadence is wired, a monthly cron-driven service
// calls AuditArchiveService.archiveAll(), which
// iterates AUDIT_TABLES and calls archiveTable(tableName) per table.
// Each archiveTable() call:
//   1. selectArchivableRows() — SELECT rows older than 90 days from
//      this repo, sha256 + gzip + R2 upload happens in service code.
//      Takes an OPTIONAL row cap (V-1591). Omitted, the read is
//      unbounded and the caller holds the whole result set plus a
//      projected copy, a JSONL string and a gzip buffer — which is why
//      the scheduled path always passes one. See ARCHIVE_RUN_ROW_CAP in
//      services/audit-archive.ts.
//   2. insertRun() — record in audit_archive_runs ledger.
//   3. deleteRowsById() — DELETE archived rows from Postgres.
//   4. markDeletedFromPostgres() — flip the ledger row's flag.

import { asc, eq, inArray, lt } from 'drizzle-orm';
import type {
  ArchiveLedgerRepo,
  ArchiveTableName,
  ArchiveTableRepo,
} from '../services/audit-archive.js';
import { chunkIds } from './chunk-ids.js';
import type { Database } from './client.js';
import {
  adminAuditLog,
  auditArchiveRuns,
  legalAcceptances,
  processedStripeEvents,
  sessionEvents,
  webhookDeliveries,
} from './schema.js';

export class DrizzleArchiveTableRepo implements ArchiveTableRepo {
  constructor(private readonly database: Database) {}

  async selectArchivableRows(
    tableName: ArchiveTableName,
    olderThan: Date,
    limit?: number,
  ): Promise<readonly Record<string, unknown>[]> {
    // V-1591 — the read is bounded at the CALLER's request. Every branch below
    // already orders oldest-first on (timestamp, id), so a limit takes a
    // deterministic prefix of the window: the rows a capped run archives are
    // exactly the rows the next run would have started with. Passing no limit
    // preserves the previous unbounded behaviour for the manual/admin path.
    const cap = limit !== undefined && limit > 0 ? limit : null;
    switch (tableName) {
      case 'admin_audit_log': {
        const query = this.database.db
          .select()
          .from(adminAuditLog)
          .where(lt(adminAuditLog.timestamp, olderThan))
          .orderBy(asc(adminAuditLog.timestamp), asc(adminAuditLog.id));
        const rows = await (cap === null ? query : query.limit(cap));
        return rows;
      }
      case 'processed_stripe_events': {
        // processed_stripe_events.PK is event_id (no separate id col).
        // AuditArchiveService.extractId() reads row.id — project
        // event_id → id so the row shape matches the other tables.
        const query = this.database.db
          .select()
          .from(processedStripeEvents)
          .where(lt(processedStripeEvents.receivedAt, olderThan))
          .orderBy(asc(processedStripeEvents.receivedAt), asc(processedStripeEvents.eventId));
        const rows = await (cap === null ? query : query.limit(cap));
        return rows.map((r) => ({ ...r, id: r.eventId }));
      }
      case 'legal_acceptances': {
        const query = this.database.db
          .select()
          .from(legalAcceptances)
          .where(lt(legalAcceptances.acceptedAt, olderThan))
          .orderBy(asc(legalAcceptances.acceptedAt), asc(legalAcceptances.id));
        const rows = await (cap === null ? query : query.limit(cap));
        return rows;
      }
      case 'webhook_deliveries': {
        const query = this.database.db
          .select()
          .from(webhookDeliveries)
          .where(lt(webhookDeliveries.createdAt, olderThan))
          .orderBy(asc(webhookDeliveries.createdAt), asc(webhookDeliveries.id));
        const rows = await (cap === null ? query : query.limit(cap));
        return rows;
      }
      case 'session_events': {
        const query = this.database.db
          .select()
          .from(sessionEvents)
          .where(lt(sessionEvents.createdAt, olderThan))
          .orderBy(asc(sessionEvents.createdAt), asc(sessionEvents.id));
        const rows = await (cap === null ? query : query.limit(cap));
        return rows;
      }
    }
  }

  async deleteRowsById(tableName: ArchiveTableName, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    // Chunked: see DELETE_ID_CHUNK. Deleting by id in several statements
    // removes exactly the same rows as one statement would, and the caller's
    // `deleted === archived` assertion still holds because the counts are summed.
    let deleted = 0;
    for (const chunk of chunkIds(ids)) {
      deleted += await this.deleteChunkById(tableName, chunk);
    }
    return deleted;
  }

  private async deleteChunkById(tableName: ArchiveTableName, idArray: string[]): Promise<number> {
    switch (tableName) {
      case 'admin_audit_log': {
        const result = await this.database.db
          .delete(adminAuditLog)
          .where(inArray(adminAuditLog.id, idArray));
        return rowsAffected(result);
      }
      case 'processed_stripe_events': {
        // processed_stripe_events PK is event_id (text), not id.
        // selectArchivableRows projects event_id → id so the service-layer
        // contract (extractId reads row.id) stays uniform across tables.
        const result = await this.database.db
          .delete(processedStripeEvents)
          .where(inArray(processedStripeEvents.eventId, idArray));
        return rowsAffected(result);
      }
      case 'legal_acceptances': {
        const result = await this.database.db
          .delete(legalAcceptances)
          .where(inArray(legalAcceptances.id, idArray));
        return rowsAffected(result);
      }
      case 'session_events': {
        const result = await this.database.db
          .delete(sessionEvents)
          .where(inArray(sessionEvents.id, idArray));
        return rowsAffected(result);
      }
      case 'webhook_deliveries': {
        const result = await this.database.db
          .delete(webhookDeliveries)
          .where(inArray(webhookDeliveries.id, idArray));
        return rowsAffected(result);
      }
    }
  }
}

export class DrizzleArchiveLedgerRepo implements ArchiveLedgerRepo {
  constructor(private readonly database: Database) {}

  async insertRun(args: {
    tableName: ArchiveTableName;
    windowStart: Date;
    windowEnd: Date;
    rowsArchived: number;
    r2ObjectKey: string;
    sha256Checksum: string;
    startedAt: Date;
    completedAt: Date;
  }): Promise<string> {
    const [row] = await this.database.db
      .insert(auditArchiveRuns)
      .values({
        tableName: args.tableName,
        windowStart: args.windowStart,
        windowEnd: args.windowEnd,
        rowsArchived: args.rowsArchived,
        r2ObjectKey: args.r2ObjectKey,
        sha256Checksum: args.sha256Checksum,
        startedAt: args.startedAt,
        completedAt: args.completedAt,
        deletedFromPostgres: false,
      })
      .returning({ id: auditArchiveRuns.id });
    if (!row) throw new Error('insertRun returned no row');
    return row.id;
  }

  async markDeletedFromPostgres(runId: string): Promise<void> {
    await this.database.db
      .update(auditArchiveRuns)
      .set({ deletedFromPostgres: true })
      .where(eq(auditArchiveRuns.id, runId));
  }
}

/**
 * processed_stripe_events lacks a uniform `id` column — its PK is
 * `event_id`. The AuditArchiveService projection layer (extractId)
 * reads `row.id`. This helper SELECTs with `id` aliased to `event_id`
 * so the contract holds.
 *
 * NOT exported / NOT used yet — folding into selectArchivableRows()
 * directly is cleaner. Documenting here for the future maintainer who
 * wonders why processed_stripe_events feels asymmetric: the service
 * extracts row.id; the actual PK is event_id; deleteRowsById() bridges
 * the gap by switching the WHERE clause to event_id for that table.
 *
 * Note: this asymmetry is also why selectArchivableRows() returns
 * `Record<string, unknown>[]` — each table's row shape differs and
 * the ergonomics-vs-typesafety trade leans on JSONL serialisation
 * being shape-agnostic at the boundary.
 */
function _processedStripeEventsAliasNote(): void {}
void _processedStripeEventsAliasNote;

function rowsAffected(result: unknown): number {
  // postgres-js + drizzle return shape: { rowCount: number } or { count: number }
  // depending on the driver. Defensive cast covers both.
  const r = result as { rowCount?: number; count?: number };
  return r.rowCount ?? r.count ?? 0;
}
