// V-172 — Drizzle-backed ArchiveTableRepo + ArchiveLedgerRepo for the
// V-163 AuditArchiveService. The four audit-shaped tables
// (admin_audit_log / processed_stripe_events / legal_acceptances /
// webhook_deliveries) each have a different primary-timestamp column
// (per AUDIT_TABLES); this repo dispatches to the right table + column
// per `tableName` argument.
//
// Lifecycle: monthly cron-driven service (deployment-time scheduler;
// not in this commit) calls AuditArchiveService.archiveAll(), which
// iterates AUDIT_TABLES and calls archiveTable(tableName) per table.
// Each archiveTable() call:
//   1. selectArchivableRows() — SELECT rows older than 90 days from
//      this repo, sha256 + gzip + R2 upload happens in service code.
//   2. insertRun() — record in audit_archive_runs ledger.
//   3. deleteRowsById() — DELETE archived rows from Postgres.
//   4. markDeletedFromPostgres() — flip the ledger row's flag.

import { asc, eq, inArray, lt } from 'drizzle-orm';
import type {
  ArchiveLedgerRepo,
  ArchiveTableName,
  ArchiveTableRepo,
} from '../services/audit-archive.js';
import type { Database } from './client.js';
import {
  adminAuditLog,
  auditArchiveRuns,
  legalAcceptances,
  processedStripeEvents,
  sessionEvents,
  webhookDeliveries,
} from './schema.js';

/**
 * Ids per DELETE statement.
 *
 * `inArray` binds one parameter per id, and postgres-js refuses a statement
 * with more than 65534 of them — measured against the local server:
 * 60000 ids succeed, 70000 raise `MAX_PARAMETERS_EXCEEDED`. A single archive
 * run past that many rows therefore threw HERE, after the R2 upload and the
 * ledger insert had already succeeded, so the rows stayed in Postgres and the
 * next run re-selected the same set plus whatever had accrued: the sweep could
 * never make progress, and `session_events` — documented in AUDIT_TABLES as
 * growing without bound because sessions are marked-destroyed rather than
 * row-deleted — would grow forever with the retention promise silently unkept.
 *
 * 10_000 matches the batch size AuditArchiveService already declares, and
 * leaves a wide margin under the limit.
 */
const DELETE_ID_CHUNK = 10_000;

/** Split `ids` into chunks small enough to bind in one statement. */
function chunkIds(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += DELETE_ID_CHUNK) {
    out.push([...ids.slice(i, i + DELETE_ID_CHUNK)]);
  }
  return out;
}

export class DrizzleArchiveTableRepo implements ArchiveTableRepo {
  constructor(private readonly database: Database) {}

  async selectArchivableRows(
    tableName: ArchiveTableName,
    olderThan: Date,
  ): Promise<readonly Record<string, unknown>[]> {
    switch (tableName) {
      case 'admin_audit_log': {
        const rows = await this.database.db
          .select()
          .from(adminAuditLog)
          .where(lt(adminAuditLog.timestamp, olderThan))
          .orderBy(asc(adminAuditLog.timestamp), asc(adminAuditLog.id));
        return rows;
      }
      case 'processed_stripe_events': {
        // processed_stripe_events.PK is event_id (no separate id col).
        // AuditArchiveService.extractId() reads row.id — project
        // event_id → id so the row shape matches the other tables.
        const rows = await this.database.db
          .select()
          .from(processedStripeEvents)
          .where(lt(processedStripeEvents.receivedAt, olderThan))
          .orderBy(asc(processedStripeEvents.receivedAt), asc(processedStripeEvents.eventId));
        return rows.map((r) => ({ ...r, id: r.eventId }));
      }
      case 'legal_acceptances': {
        const rows = await this.database.db
          .select()
          .from(legalAcceptances)
          .where(lt(legalAcceptances.acceptedAt, olderThan))
          .orderBy(asc(legalAcceptances.acceptedAt), asc(legalAcceptances.id));
        return rows;
      }
      case 'webhook_deliveries': {
        const rows = await this.database.db
          .select()
          .from(webhookDeliveries)
          .where(lt(webhookDeliveries.createdAt, olderThan))
          .orderBy(asc(webhookDeliveries.createdAt), asc(webhookDeliveries.id));
        return rows;
      }
      case 'session_events': {
        const rows = await this.database.db
          .select()
          .from(sessionEvents)
          .where(lt(sessionEvents.createdAt, olderThan))
          .orderBy(asc(sessionEvents.createdAt), asc(sessionEvents.id));
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
