// W402.A — drift guard for apps/server/src/services/audit-archive.ts.
// V-163 / ADR-006 audit archival sweep: 90-day hot-retention into R2
// gzip JSONL, monthly cadence. Drift here either breaks the failure-
// mode invariants (R2 upload fails → DELETE skipped; DELETE fails →
// R2 overwrite next run) or scrambles the YYYY/MM/ partition path.
//
//   • V-163 + ADR-006 framing + 5 tables (4 audit-shaped + session_events) + R2 gzip JSONL
//     + monthly cadence (1st of each month 02:00 UTC, scheduler
//     external).
//   • Failure modes: R2 upload fails → DELETE skipped + ledger row
//     deletedFromPostgres=false → next-run retry; DELETE fails → R2
//     remains, ledger records upload, next run overwrites idempotently.
//   • HOT_RETENTION_MS = 90 days; DEFAULT_BATCH_SIZE = 10_000.
//   • AUDIT_TABLES: 5 entries with per-table timestampColumn binding
//     (admin_audit_log/timestamp, processed_stripe_events/received_at,
//     legal_acceptances/accepted_at, webhook_deliveries/created_at,
//     session_events/created_at).
//   • archiveObjectKey: <prefix>/<table>/YYYY/MM/<table>_YYYY-MM.jsonl.gz
//     (ADR-006 §2).
//   • rowsToJsonl: empty input → empty string (no trailing newline).
//   • archiveTable: select → gzip → sha256-hex → R2.putObject (content-
//     type application/x-ndjson+gzip) → ledger.insertRun → conditional
//     DELETE + markDeletedFromPostgres only when deleted-count matches.
//   • Empty window: deletedFromPostgres=true (no-op accurately ledgered).
//   • archiveAll: sequential per-table; one failure does not abort
//     others.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/audit-archive.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W402.A apps/server/src/services/audit-archive.ts content parity', () => {
  const body = read(LIB);

  it('V-163 + ADR-006 framing pinned + 5 tables + R2 gzip JSONL + monthly cadence', () => {
    expect(body).toMatch(/V-163 — AuditArchiveService per ADR-006\./);
    expect(body).toMatch(/Sweeps rows older than 90 days from five Postgres tables — the four/);
    expect(body).toMatch(/audit-shaped \(admin_audit_log \/ processed_stripe_events \//);
    expect(body).toMatch(/\/ webhook_deliveries\) plus the high-volume/);
    expect(body).toMatch(/session_events action log/);
    expect(body).toMatch(/Lines, partitioned by YYYY\/MM\/\./);
    expect(body).toMatch(
      /Cron \/ external scheduler invokes archiveAll\(now\) on the 1st of\s*\n?\s*\/\/\s*each month at 02:00 UTC\. The service does NOT manage scheduling\./,
    );
  });

  it('Failure modes per ADR §3: R2-upload-fail → DELETE skipped + deletedFromPostgres=false + next-run retry; DELETE-fail → R2 overwrite idempotently', () => {
    expect(body).toMatch(
      /R2 upload fails → DELETE skipped; ledger row records the\s*\n?\s*\/\/\s*attempt with deletedFromPostgres=false\. Next run retries\./,
    );
    expect(body).toMatch(
      /DELETE fails → R2 file remains, ledger row records the upload;\s*\n?\s*\/\/\s*next run notices the existing R2 key and overwrites idempotently\./,
    );
  });

  it('HOT_RETENTION_MS = 90 days + DEFAULT_BATCH_SIZE = 10_000 + 64 KiB legacy body cap exports', () => {
    expect(body).toMatch(
      /\/\*\* 90 days in milliseconds — the hot-retention threshold\. \*\/\s*\n?\s*export const HOT_RETENTION_MS = 90 \* 24 \* 60 \* 60 \* 1000;/,
    );
    expect(body).toMatch(
      /\/\*\* Default upload-batch size — keeps memory bounded on large windows\. \*\/\s*\n?\s*export const DEFAULT_BATCH_SIZE = 10_000;/,
    );
    expect(body).toMatch(/export const MAX_ARCHIVED_WEBHOOK_BODY_BYTES = 64 \* 1024;/);
  });

  it('AUDIT_TABLES: 5 entries including session_events/created_at', () => {
    expect(body).toMatch(/export const AUDIT_TABLES = \[/);
    expect(body).toMatch(/\{ tableName: 'admin_audit_log', timestampColumn: 'timestamp' \},/);
    expect(body).toMatch(
      /\{ tableName: 'processed_stripe_events', timestampColumn: 'received_at' \},/,
    );
    expect(body).toMatch(/\{ tableName: 'legal_acceptances', timestampColumn: 'accepted_at' \},/);
    expect(body).toMatch(/\{ tableName: 'webhook_deliveries', timestampColumn: 'created_at' \},/);
    expect(body).toMatch(/\{ tableName: 'session_events', timestampColumn: 'created_at' \},/);
    expect(body).toMatch(/\] as const;/);
  });

  it('ArchiveTableRepo: 2 methods (selectArchivableRows stable-order + deleteRowsById returning count)', () => {
    expect(body).toMatch(/export interface ArchiveTableRepo \{/);
    expect(body).toMatch(
      /SELECT rows where the table's primary timestamp column is\s*\n?\s*\*\s*strictly older than `olderThan` \(i\.e\. should be archived\)\.\s*\n?\s*\*\s*Returns rows in stable order \(timestamp asc, id asc\) so the\s*\n?\s*\*\s*JSONL output is deterministic for a given window\./,
    );
    expect(body).toMatch(
      /selectArchivableRows\(\s*\n?\s*tableName: ArchiveTableName,\s*\n?\s*olderThan: Date,\s*\n?\s*\): Promise<readonly Record<string, unknown>\[\]>;/,
    );
    expect(body).toMatch(
      /deleteRowsById\(tableName: ArchiveTableName, ids: readonly string\[\]\): Promise<number>;/,
    );
  });

  it('ArchiveLedgerRepo: 2 methods (insertRun with 8-arg shape + markDeletedFromPostgres)', () => {
    expect(body).toMatch(/export interface ArchiveLedgerRepo \{/);
    expect(body).toMatch(
      /\/\*\* Insert a fresh ledger row at run start \(deletedFromPostgres=false\)\. \*\/\s*\n?\s*insertRun\(args: \{[\s\S]+?tableName: ArchiveTableName;\s*\n?\s*windowStart: Date;\s*\n?\s*windowEnd: Date;\s*\n?\s*rowsArchived: number;\s*\n?\s*r2ObjectKey: string;\s*\n?\s*sha256Checksum: string;\s*\n?\s*startedAt: Date;\s*\n?\s*completedAt: Date;\s*\n?\s*\}\): Promise<string>;/,
    );
    expect(body).toMatch(
      /\/\*\* Mark the ledger row's DELETE-from-postgres step as completed\. \*\/\s*\n?\s*markDeletedFromPostgres\(runId: string\): Promise<void>;/,
    );
  });

  it('archiveObjectKey: <prefix>/<table>/YYYY/MM/<table>_YYYY-MM.jsonl.gz partition path (ADR-006 §2)', () => {
    expect(body).toMatch(
      /Compose the R2 object key for a given table \+ window\. Stable shape\s*\n?\s*\*\s*per ADR-006 §2:\s*\n?\s*\*\s*<prefix>\/<table_name>\/YYYY\/MM\/<table_name>_YYYY-MM\.jsonl\.gz/,
    );
    expect(body).toMatch(
      /export function archiveObjectKey\(\s*\n?\s*prefix: string,\s*\n?\s*tableName: ArchiveTableName,\s*\n?\s*windowStart: Date,\s*\n?\s*\): string \{/,
    );
    expect(body).toMatch(/const yyyy = windowStart\.getUTCFullYear\(\)\.toString\(\);/);
    expect(body).toMatch(
      /const mm = \(windowStart\.getUTCMonth\(\) \+ 1\)\.toString\(\)\.padStart\(2, '0'\);/,
    );
    expect(body).toMatch(
      /return `\$\{prefix\}\/\$\{tableName\}\/\$\{yyyy\}\/\$\{mm\}\/\$\{tableName\}_\$\{yyyy\}-\$\{mm\}\.jsonl\.gz`;/,
    );
  });

  it('rowsToJsonl: newline-delimited JSON; empty input → empty string (no trailing newline)', () => {
    expect(body).toMatch(
      /Serialise a batch of rows to newline-delimited JSON\. Empty input\s*\n?\s*\*\s*returns an empty string \(no trailing newline\)\./,
    );
    expect(body).toMatch(
      /export function rowsToJsonl\(rows: readonly Record<string, unknown>\[\]\): string \{\s*\n?\s*return rows\.map\(\(r\) => JSON\.stringify\(r\)\)\.join\('\\n'\);\s*\n?\s*\}/,
    );
  });

  it('archiveTable: select → closed projection → gzip → sha256-hex → R2.putObject → ledger.insertRun', () => {
    expect(body).toMatch(
      /const olderThan = new Date\(startedAt\.getTime\(\) - HOT_RETENTION_MS\);/,
    );
    expect(body).toMatch(
      /const archivable = await this\.rows\.selectArchivableRows\(tableName, olderThan\);/,
    );
    expect(body).toMatch(/const uploadRows = projectRowsForArchive\(tableName, archivable\);/);
    expect(body).toMatch(/const jsonl = rowsToJsonl\(uploadRows\);/);
    expect(body).toMatch(/const compressed = await gzipAsync\(Buffer\.from\(jsonl, 'utf-8'\)\);/);
    expect(body).toMatch(
      /const sha256Checksum = createHash\('sha256'\)\.update\(compressed\)\.digest\('hex'\);/,
    );
    expect(body).toMatch(
      /await this\.r2\.putObject\(\{\s*\n?\s*key: r2ObjectKey,\s*\n?\s*body: compressed,\s*\n?\s*contentType: 'application\/x-ndjson\+gzip',\s*\n?\s*\}\);/,
    );
  });

  it('archive projection closes session events and session.failed rows while leaving unrelated tables/events unchanged', () => {
    expect(body).toMatch(
      /if \(tableName === 'session_events'\) return rows\.map\(projectSessionEventArchiveRow\);/,
    );
    expect(body).toMatch(
      /if \(tableName === 'webhook_deliveries'\) return rows\.map\(projectWebhookDeliveryArchiveRow\);/,
    );
    expect(body).toMatch(/if \(eventType !== 'session\.failed'\) return row;/);
    expect(body).toMatch(/Buffer\.byteLength\(value, 'utf8'\) > MAX_ARCHIVED_WEBHOOK_BODY_BYTES/);
    expect(body).toMatch(/data: projectSessionFailedData\(input\.data\)/);
    expect(body).toMatch(/lastResponseExcerpt: null,\s*lastError: null,/);
  });

  it('archiveTable: conditional DELETE — markDeletedFromPostgres only when deleted-count matches archived count; empty window marks deleted=true', () => {
    expect(body).toMatch(
      /if \(archivable\.length > 0\) \{\s*\n?\s*const ids = archivable\.map\(\(r\) => extractId\(r\)\);\s*\n?\s*const deleted = await this\.rows\.deleteRowsById\(tableName, ids\);\s*\n?\s*if \(deleted === archivable\.length\) \{\s*\n?\s*await this\.ledger\.markDeletedFromPostgres\(runId\);\s*\n?\s*deletedFromPostgres = true;/,
    );
    expect(body).toMatch(
      /\/\/ Empty window: mark deleted=true so the ledger reflects the\s*\n?\s*\/\/ no-op accurately \(no rows to delete = nothing pending\)\.\s*\n?\s*await this\.ledger\.markDeletedFromPostgres\(runId\);\s*\n?\s*deletedFromPostgres = true;/,
    );
  });

  it('archiveAll: sequential per-table; one failure does not abort others (try/catch isolates each table; failures recorded in the errors[] breakdown)', () => {
    expect(body).toMatch(
      /Archive all five tables in sequence\. Each table\s*\n?\s*\*\s*archives independently — a failure on one does not abort the\s*\n?\s*\*\s*others\. Returns a per-table breakdown\./,
    );
    // The independence is implemented: each table's archiveTable is wrapped
    // in try/catch; a thrown table is recorded in errors[] and the loop
    // continues. (Previously the loop had no try/catch — one failure
    // aborted all remaining tables, contradicting the docstring.)
    expect(body).toMatch(
      /for \(const \{ tableName \} of AUDIT_TABLES\) \{\s*\n?\s*try \{\s*\n?\s*const result = await this\.archiveTable\(tableName\);\s*\n?\s*results\.push\(result\);\s*\n?\s*\} catch \(err\) \{/,
    );
    expect(body).toMatch(
      /errors\.push\(\{ tableName, error: err instanceof Error \? err\.message : String\(err\) \}\);/,
    );
    expect(body).toMatch(/return \{ results, errors, startedAt, completedAt \};/);
  });

  it('ArchiveAllResult carries an errors[] breakdown (ArchiveTableError: tableName + error) alongside results', () => {
    expect(body).toMatch(
      /export interface ArchiveTableError \{\s*\n?\s*tableName: ArchiveTableName;\s*\n?\s*error: string;\s*\n?\s*\}/,
    );
    expect(body).toMatch(/errors: readonly ArchiveTableError\[\];/);
  });

  it('AuditArchiveDeps: r2 + ledger + rows + r2Prefix? (default audit-archive) + now? test seam', () => {
    expect(body).toMatch(/export interface AuditArchiveDeps \{/);
    expect(body).toMatch(/r2: R2;/);
    expect(body).toMatch(/ledger: ArchiveLedgerRepo;/);
    expect(body).toMatch(/rows: ArchiveTableRepo;/);
    expect(body).toMatch(
      /Optional override for R2 archive prefix\. Default 'audit-archive'\.\s*\n?\s*\*\s*Lets ops point staging vs production at different prefixes within\s*\n?\s*\*\s*the same bucket\./,
    );
    expect(body).toMatch(/r2Prefix\?: string;/);
    expect(body).toMatch(
      /\/\*\* Test seam — defaults to Date\.now\(\)\. \*\/\s*\n?\s*now\?: \(\) => Date;/,
    );
    expect(body).toMatch(/this\.r2Prefix = deps\.r2Prefix \?\? 'audit-archive';/);
  });

  it('extractTimestamp: per-table column lookup + Date|string accepted; extractId: requires string id', () => {
    expect(body).toMatch(
      /function extractTimestamp\(row: Record<string, unknown>, tableName: ArchiveTableName\): Date \{/,
    );
    expect(body).toMatch(
      /const col = AUDIT_TABLES\.find\(\(t\) => t\.tableName === tableName\)!\.timestampColumn;/,
    );
    expect(body).toMatch(/const v = row\[col\] \?\? row\[camelTimestampColumn\(tableName\)\];/);
    expect(body).toMatch(/if \(v instanceof Date\) return v;/);
    expect(body).toMatch(/if \(typeof v === 'string'\) return new Date\(v\);/);
    expect(body).toMatch(
      /\/\*\* Extract the row's primary key\. All audit tables use a uuid 'id' column\. \*\/\s*\n?\s*function extractId\(row: Record<string, unknown>\): string \{/,
    );
    expect(body).toMatch(/throw new Error\('audit-archive: row missing string id'\);/);
  });

  it('imports: crypto/zlib/R2 plus the closed session-event and failure projectors', () => {
    expect(body).toMatch(/import \{ createHash \} from 'node:crypto';/);
    expect(body).toMatch(/import \{ promisify \} from 'node:util';/);
    expect(body).toMatch(/import \{ gzip as gzipCb, gzipSync \} from 'node:zlib';/);
    expect(body).toMatch(/import type \{ R2 \} from '\.\.\/lib\/r2\.js';/);
    expect(body).toMatch(
      /import \{\s*projectSessionEventMetadata,\s*projectSessionFailedData,\s*\} from '\.\.\/lib\/session-event-metadata\.js';/,
    );
    expect(body).toMatch(/const gzipAsync = promisify\(gzipCb\);/);
    expect(body).toMatch(/export \{ gzipSync \};/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
