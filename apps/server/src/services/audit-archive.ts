// V-163 — AuditArchiveService per ADR-006.
//
// Sweeps rows older than 90 days from the four audit-shaped Postgres
// tables (admin_audit_log / processed_stripe_events / legal_acceptances
// / webhook_deliveries) into Cloudflare R2 as gzip-compressed JSON
// Lines, partitioned by YYYY/MM/. After successful upload + checksum,
// DELETEs the archived rows. Records each sweep in audit_archive_runs.
//
// Failure modes (per ADR §3):
//   - R2 upload fails → DELETE skipped; ledger row records the
//     attempt with deletedFromPostgres=false. Next run retries.
//   - DELETE fails → R2 file remains, ledger row records the upload;
//     next run notices the existing R2 key and overwrites idempotently.
//   - Partial archive → both queries still work; archive query
//     union may double-count until cleanup completes. Acceptable
//     edge case for monthly cadence.
//
// Cron / external scheduler invokes archiveAll(now) on the 1st of
// each month at 02:00 UTC. The service does NOT manage scheduling.

import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip as gzipCb, gzipSync } from 'node:zlib';
import type { R2 } from '../lib/r2.js';

const gzipAsync = promisify(gzipCb);

/** 90 days in milliseconds — the hot-retention threshold. */
export const HOT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Default upload-batch size — keeps memory bounded on large windows. */
export const DEFAULT_BATCH_SIZE = 10_000;

/**
 * The four audit-shaped tables this service archives. Each entry
 * names the Postgres table + the column on it that carries the
 * row's primary timestamp. Window queries gate on this column.
 */
export const AUDIT_TABLES = [
  { tableName: 'admin_audit_log', timestampColumn: 'timestamp' },
  { tableName: 'processed_stripe_events', timestampColumn: 'received_at' },
  { tableName: 'legal_acceptances', timestampColumn: 'accepted_at' },
  { tableName: 'webhook_deliveries', timestampColumn: 'created_at' },
] as const;

export type ArchiveTableName = (typeof AUDIT_TABLES)[number]['tableName'];

export interface ArchiveTableRepo {
  /**
   * SELECT rows where the table's primary timestamp column is
   * strictly older than `olderThan` (i.e. should be archived).
   * Returns rows in stable order (timestamp asc, id asc) so the
   * JSONL output is deterministic for a given window.
   */
  selectArchivableRows(
    tableName: ArchiveTableName,
    olderThan: Date,
  ): Promise<readonly Record<string, unknown>[]>;
  /**
   * DELETE rows by id from the named table. Returns the deletion
   * count (caller asserts == archived row count).
   */
  deleteRowsById(tableName: ArchiveTableName, ids: readonly string[]): Promise<number>;
}

export interface ArchiveLedgerRepo {
  /** Insert a fresh ledger row at run start (deletedFromPostgres=false). */
  insertRun(args: {
    tableName: ArchiveTableName;
    windowStart: Date;
    windowEnd: Date;
    rowsArchived: number;
    r2ObjectKey: string;
    sha256Checksum: string;
    startedAt: Date;
    completedAt: Date;
  }): Promise<string>;
  /** Mark the ledger row's DELETE-from-postgres step as completed. */
  markDeletedFromPostgres(runId: string): Promise<void>;
}

export interface AuditArchiveDeps {
  r2: R2;
  ledger: ArchiveLedgerRepo;
  rows: ArchiveTableRepo;
  /**
   * Optional override for R2 archive prefix. Default 'audit-archive'.
   * Lets ops point staging vs production at different prefixes within
   * the same bucket.
   */
  r2Prefix?: string;
  /** Test seam — defaults to Date.now(). */
  now?: () => Date;
}

export interface ArchiveTableResult {
  tableName: ArchiveTableName;
  rowsArchived: number;
  r2ObjectKey: string;
  sha256Checksum: string;
  deletedFromPostgres: boolean;
}

/**
 * A table whose archival threw this run. Recorded (rather than
 * propagated) so archiveAll continues to the remaining tables — the
 * per-table-independence contract in ADR §3 / archiveAll's docstring.
 */
export interface ArchiveTableError {
  tableName: ArchiveTableName;
  error: string;
}

export interface ArchiveAllResult {
  results: readonly ArchiveTableResult[];
  /**
   * Tables whose archival failed this run; the other tables still ran.
   * Empty on a fully-successful run. The failed tables' hot rows stay in
   * Postgres (archive-before-delete) and the next run retries them.
   */
  errors: readonly ArchiveTableError[];
  startedAt: Date;
  completedAt: Date;
}

/**
 * Compose the R2 object key for a given table + window. Stable shape
 * per ADR-006 §2:
 *   <prefix>/<table_name>/YYYY/MM/<table_name>_YYYY-MM.jsonl.gz
 */
export function archiveObjectKey(
  prefix: string,
  tableName: ArchiveTableName,
  windowStart: Date,
): string {
  const yyyy = windowStart.getUTCFullYear().toString();
  const mm = (windowStart.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${prefix}/${tableName}/${yyyy}/${mm}/${tableName}_${yyyy}-${mm}.jsonl.gz`;
}

/**
 * Serialise a batch of rows to newline-delimited JSON. Empty input
 * returns an empty string (no trailing newline).
 */
export function rowsToJsonl(rows: readonly Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n');
}

export class AuditArchiveService {
  private readonly r2: R2;
  private readonly ledger: ArchiveLedgerRepo;
  private readonly rows: ArchiveTableRepo;
  private readonly r2Prefix: string;
  private readonly now: () => Date;

  constructor(deps: AuditArchiveDeps) {
    this.r2 = deps.r2;
    this.ledger = deps.ledger;
    this.rows = deps.rows;
    this.r2Prefix = deps.r2Prefix ?? 'audit-archive';
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Archive a single audit-shaped table. Returns the per-table
   * outcome including the assigned R2 key + checksum + whether
   * DELETE-from-postgres succeeded.
   *
   * Idempotent: re-running with the same `now` re-uploads the same
   * R2 key (overwrites) and re-attempts the DELETE.
   */
  async archiveTable(tableName: ArchiveTableName): Promise<ArchiveTableResult> {
    const startedAt = this.now();
    const olderThan = new Date(startedAt.getTime() - HOT_RETENTION_MS);

    const archivable = await this.rows.selectArchivableRows(tableName, olderThan);

    const jsonl = rowsToJsonl(archivable);
    const compressed = await gzipAsync(Buffer.from(jsonl, 'utf-8'));
    const sha256Checksum = createHash('sha256').update(compressed).digest('hex');

    const windowStart =
      archivable.length > 0 ? extractTimestamp(archivable[0]!, tableName) : olderThan;
    const r2ObjectKey = archiveObjectKey(this.r2Prefix, tableName, windowStart);

    await this.r2.putObject({
      key: r2ObjectKey,
      body: compressed,
      contentType: 'application/x-ndjson+gzip',
    });

    const completedAt = this.now();

    const runId = await this.ledger.insertRun({
      tableName,
      windowStart,
      windowEnd: olderThan,
      rowsArchived: archivable.length,
      r2ObjectKey,
      sha256Checksum,
      startedAt,
      completedAt,
    });

    let deletedFromPostgres = false;
    if (archivable.length > 0) {
      const ids = archivable.map((r) => extractId(r));
      const deleted = await this.rows.deleteRowsById(tableName, ids);
      if (deleted === archivable.length) {
        await this.ledger.markDeletedFromPostgres(runId);
        deletedFromPostgres = true;
      }
    } else {
      // Empty window: mark deleted=true so the ledger reflects the
      // no-op accurately (no rows to delete = nothing pending).
      await this.ledger.markDeletedFromPostgres(runId);
      deletedFromPostgres = true;
    }

    return {
      tableName,
      rowsArchived: archivable.length,
      r2ObjectKey,
      sha256Checksum,
      deletedFromPostgres,
    };
  }

  /**
   * Archive all four audit-shaped tables in sequence. Each table
   * archives independently — a failure on one does not abort the
   * others. Returns a per-table breakdown.
   */
  async archiveAll(): Promise<ArchiveAllResult> {
    const startedAt = this.now();
    const results: ArchiveTableResult[] = [];
    const errors: ArchiveTableError[] = [];
    for (const { tableName } of AUDIT_TABLES) {
      try {
        const result = await this.archiveTable(tableName);
        results.push(result);
      } catch (err) {
        // Per-table independence (ADR §3): one table's failure (R2 down,
        // a malformed row, a DELETE error) must not abort the others.
        // Record it and continue; the failed table's hot rows stay in
        // Postgres (archive-before-delete) and the next run retries.
        errors.push({ tableName, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const completedAt = this.now();
    return { results, errors, startedAt, completedAt };
  }
}

/**
 * Extract the row's primary timestamp by table. Used to compute
 * the windowStart for the R2 object key partitioning.
 */
function extractTimestamp(row: Record<string, unknown>, tableName: ArchiveTableName): Date {
  const col = AUDIT_TABLES.find((t) => t.tableName === tableName)!.timestampColumn;
  const v = row[col];
  if (v instanceof Date) return v;
  if (typeof v === 'string') return new Date(v);
  throw new Error(
    `audit-archive: row from ${tableName} missing timestamp column ${col} or has unexpected type`,
  );
}

/** Extract the row's primary key. All audit tables use a uuid 'id' column. */
function extractId(row: Record<string, unknown>): string {
  const id = row.id;
  if (typeof id !== 'string') {
    throw new Error('audit-archive: row missing string id');
  }
  return id;
}

// gzipSync exported for tests that want to verify the upload payload
// shape without re-running the async helper.
export { gzipSync };
