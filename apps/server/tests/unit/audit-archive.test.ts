// V-163 — AuditArchiveService unit tests.
//
// Covers per-table archive happy path, R2 key shape, JSONL serialisation,
// gzip + checksum, ledger insertion + DELETE-from-postgres ordering, and
// the empty-window no-op case.

import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIT_TABLES,
  AuditArchiveService,
  HOT_RETENTION_MS,
  archiveObjectKey,
  rowsToJsonl,
  type ArchiveLedgerRepo,
  type ArchiveTableName,
  type ArchiveTableRepo,
} from '../../src/services/audit-archive.js';
import type { R2 } from '../../src/lib/r2.js';

interface UploadedObject {
  key: string;
  body: Buffer;
  contentType: string | undefined;
}

function fakeR2(uploads: UploadedObject[]): R2 {
  return {
    bucket: 'test-bucket',
    headObject: () => Promise.resolve({ exists: false }),
    putObject: ({ key, body, contentType }) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      uploads.push({ key, body: buf, contentType });
      return Promise.resolve();
    },
    deleteObject: () => Promise.resolve(),
    presignPut: () => Promise.resolve('https://presigned.test/put'),
    presignGet: () => Promise.resolve('https://presigned.test/get'),
    listObjects: () => Promise.resolve([]),
  };
}

interface LedgerInsert {
  id: string;
  args: Parameters<ArchiveLedgerRepo['insertRun']>[0];
  deleted: boolean;
}

function fakeLedger(inserts: LedgerInsert[]): ArchiveLedgerRepo {
  return {
    insertRun: (args) => {
      const id = `run_${(inserts.length + 1).toString().padStart(3, '0')}`;
      inserts.push({ id, args, deleted: false });
      return Promise.resolve(id);
    },
    markDeletedFromPostgres: (runId) => {
      const row = inserts.find((r) => r.id === runId);
      if (row) row.deleted = true;
      return Promise.resolve();
    },
  };
}

interface DeleteCall {
  tableName: ArchiveTableName;
  ids: readonly string[];
}

function fakeRows(opts: {
  rowsByTable: Partial<Record<ArchiveTableName, Record<string, unknown>[]>>;
  deletes: DeleteCall[];
}): ArchiveTableRepo {
  return {
    selectArchivableRows: (tableName) => Promise.resolve(opts.rowsByTable[tableName] ?? []),
    deleteRowsById: (tableName, ids) => {
      opts.deletes.push({ tableName, ids });
      return Promise.resolve(ids.length);
    },
  };
}

const FIXED_NOW = new Date('2026-08-01T02:00:00.000Z');
// 90 days before FIXED_NOW
const OLDER_THAN = new Date(FIXED_NOW.getTime() - HOT_RETENTION_MS);

function adminAuditRow(id: string, ts: string): Record<string, unknown> {
  return {
    id,
    admin_account_id: 'acc_admin',
    admin_key_id: 'key_admin',
    action: 'account.tier_changed',
    target_account_id: 'acc_target',
    target_resource_id: null,
    input_payload: { old_tier: 'solo_manual', new_tier: 'team_manual' },
    result: 'success',
    ip_address: '203.0.113.5',
    timestamp: ts,
  };
}

describe('AuditArchiveService — pure helpers', () => {
  it('rowsToJsonl serialises one JSON per line, no trailing newline', () => {
    const out = rowsToJsonl([{ a: 1 }, { b: 'x' }, { c: null }]);
    expect(out).toBe('{"a":1}\n{"b":"x"}\n{"c":null}');
  });

  it('rowsToJsonl returns empty string for empty input', () => {
    expect(rowsToJsonl([])).toBe('');
  });

  it('archiveObjectKey produces YYYY/MM partitioned key', () => {
    const ts = new Date('2026-05-15T12:34:56.000Z');
    expect(archiveObjectKey('audit-archive', 'admin_audit_log', ts)).toBe(
      'audit-archive/admin_audit_log/2026/05/admin_audit_log_2026-05.jsonl.gz',
    );
  });

  it('archiveObjectKey honours custom prefix', () => {
    const ts = new Date('2026-01-01T00:00:00.000Z');
    expect(archiveObjectKey('staging-archive', 'webhook_deliveries', ts)).toBe(
      'staging-archive/webhook_deliveries/2026/01/webhook_deliveries_2026-01.jsonl.gz',
    );
  });

  it('AUDIT_TABLES covers the four ADR-006 tables + session_events (W438)', () => {
    const names = AUDIT_TABLES.map((t) => t.tableName).sort();
    expect(names).toEqual([
      'admin_audit_log',
      'legal_acceptances',
      'processed_stripe_events',
      'session_events',
      'webhook_deliveries',
    ]);
  });
});

describe('AuditArchiveService.archiveTable — happy path', () => {
  let uploads: UploadedObject[];
  let ledgerRows: LedgerInsert[];
  let deletes: DeleteCall[];
  let svc: AuditArchiveService;

  const oldRow1 = adminAuditRow('row_001', '2026-04-01T10:00:00.000Z');
  const oldRow2 = adminAuditRow('row_002', '2026-04-15T10:00:00.000Z');

  beforeEach(() => {
    uploads = [];
    ledgerRows = [];
    deletes = [];
    svc = new AuditArchiveService({
      r2: fakeR2(uploads),
      ledger: fakeLedger(ledgerRows),
      rows: fakeRows({
        rowsByTable: { admin_audit_log: [oldRow1, oldRow2] },
        deletes,
      }),
      now: () => FIXED_NOW,
    });
  });

  it('uploads gzip-compressed JSONL to R2 with stable key', async () => {
    const result = await svc.archiveTable('admin_audit_log');
    expect(result.tableName).toBe('admin_audit_log');
    expect(result.rowsArchived).toBe(2);
    expect(uploads).toHaveLength(1);

    const upload = uploads[0]!;
    expect(upload.contentType).toBe('application/x-ndjson+gzip');
    // R2 key partitions on the windowStart = the OLDEST archived row's
    // timestamp (not now()), so the partition reflects the data inside.
    expect(upload.key).toBe(
      'audit-archive/admin_audit_log/2026/04/admin_audit_log_2026-04.jsonl.gz',
    );
    expect(result.r2ObjectKey).toBe(upload.key);
  });

  it('uploaded body decompresses to the JSONL of selected rows', async () => {
    await svc.archiveTable('admin_audit_log');
    const decompressed = gunzipSync(uploads[0]!.body).toString('utf-8');
    expect(decompressed).toContain('"row_001"');
    expect(decompressed).toContain('"row_002"');
    // No trailing newline.
    expect(decompressed.endsWith('"}')).toBe(true);
  });

  it('checksum on the result matches sha256 of the uploaded gzip body', async () => {
    const result = await svc.archiveTable('admin_audit_log');
    const computed = createHash('sha256').update(uploads[0]!.body).digest('hex');
    expect(result.sha256Checksum).toBe(computed);
  });

  it('inserts a ledger row before deleting from postgres', async () => {
    await svc.archiveTable('admin_audit_log');
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]!.args.tableName).toBe('admin_audit_log');
    expect(ledgerRows[0]!.args.rowsArchived).toBe(2);
    expect(ledgerRows[0]!.deleted).toBe(true);
  });

  it('DELETEs the archived row ids from postgres after upload', async () => {
    await svc.archiveTable('admin_audit_log');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.tableName).toBe('admin_audit_log');
    expect(deletes[0]!.ids).toEqual(['row_001', 'row_002']);
  });

  it('windowEnd in the ledger row equals now - 90 days', async () => {
    await svc.archiveTable('admin_audit_log');
    expect(ledgerRows[0]!.args.windowEnd.toISOString()).toBe(OLDER_THAN.toISOString());
  });
});

describe('AuditArchiveService.archiveTable — empty window', () => {
  it('uploads an empty (gzip-of-empty-string) object and marks deleted=true', async () => {
    const uploads: UploadedObject[] = [];
    const ledgerRows: LedgerInsert[] = [];
    const deletes: DeleteCall[] = [];
    const svc = new AuditArchiveService({
      r2: fakeR2(uploads),
      ledger: fakeLedger(ledgerRows),
      rows: fakeRows({ rowsByTable: {}, deletes }),
      now: () => FIXED_NOW,
    });
    const result = await svc.archiveTable('legal_acceptances');
    expect(result.rowsArchived).toBe(0);
    expect(result.deletedFromPostgres).toBe(true);
    // Upload happens even on empty window — gzip of empty string is
    // small but non-zero; idempotent overwrite preserved.
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.body.length).toBeGreaterThan(0);
    expect(deletes).toHaveLength(0);
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]!.deleted).toBe(true);
  });
});

describe('AuditArchiveService.archiveTable — R2 upload failure is data-loss-safe', () => {
  it('does NOT insert a ledger run or DELETE from postgres when the R2 upload fails', async () => {
    // Integrity-critical: the archive-before-delete ordering means a failed
    // R2 upload must abort BEFORE any Postgres delete — otherwise audit rows
    // would be removed with no archived copy (permanent compliance-data loss,
    // the failure semantics documented in audit-archive.ts header). The upload
    // is awaited before insertRun/deleteRowsById, so a throw skips both. A
    // refactor that swallowed the upload error or reordered the delete would
    // slip past the happy-path tests — pin it here.
    const ledgerRows: LedgerInsert[] = [];
    const deletes: DeleteCall[] = [];
    const throwingR2: R2 = {
      bucket: 'test-bucket',
      headObject: () => Promise.resolve({ exists: false }),
      putObject: () => Promise.reject(new Error('R2 unavailable')),
      deleteObject: () => Promise.resolve(),
      presignPut: () => Promise.resolve('https://presigned.test/put'),
      presignGet: () => Promise.resolve('https://presigned.test/get'),
      listObjects: () => Promise.resolve([]),
    };
    const svc = new AuditArchiveService({
      r2: throwingR2,
      ledger: fakeLedger(ledgerRows),
      rows: fakeRows({
        rowsByTable: {
          admin_audit_log: [
            adminAuditRow('row_001', '2026-01-01T00:00:00.000Z'),
            adminAuditRow('row_002', '2026-01-02T00:00:00.000Z'),
          ],
        },
        deletes,
      }),
      now: () => FIXED_NOW,
    });

    await expect(svc.archiveTable('admin_audit_log')).rejects.toThrow('R2 unavailable');
    // No ledger run recorded, and crucially NO delete attempted → the audit
    // rows remain safely in Postgres for the next run.
    expect(ledgerRows).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });
});

describe('AuditArchiveService.archiveAll — orchestrates five tables', () => {
  it('runs all five AUDIT_TABLES in sequence', async () => {
    const uploads: UploadedObject[] = [];
    const ledgerRows: LedgerInsert[] = [];
    const deletes: DeleteCall[] = [];
    const svc = new AuditArchiveService({
      r2: fakeR2(uploads),
      ledger: fakeLedger(ledgerRows),
      rows: fakeRows({
        rowsByTable: {
          admin_audit_log: [adminAuditRow('a1', '2026-04-01T00:00:00.000Z')],
          processed_stripe_events: [],
          legal_acceptances: [],
          webhook_deliveries: [],
          session_events: [],
        },
        deletes,
      }),
      now: () => FIXED_NOW,
    });
    const result = await svc.archiveAll();
    expect(result.results).toHaveLength(5);
    expect(result.results.map((r) => r.tableName).sort()).toEqual([
      'admin_audit_log',
      'legal_acceptances',
      'processed_stripe_events',
      'session_events',
      'webhook_deliveries',
    ]);
    expect(uploads).toHaveLength(5);
    expect(ledgerRows).toHaveLength(5);
    // Only admin_audit_log had a row to delete; the other 3 windows
    // are empty so deletes list stays empty for them.
    expect(deletes).toEqual([{ tableName: 'admin_audit_log', ids: ['a1'] }]);
  });

  it('isolates a per-table failure — one table throwing does not abort the others; errors[] records it', async () => {
    // Per the docstring + ADR §3: a failure on one table must not abort the
    // rest. Make R2 fail only for the admin_audit_log object key; the other
    // three tables must still archive, and the failure is surfaced in errors[].
    const uploads: UploadedObject[] = [];
    const ledgerRows: LedgerInsert[] = [];
    const deletes: DeleteCall[] = [];
    const flakyR2: R2 = {
      bucket: 'test-bucket',
      headObject: () => Promise.resolve({ exists: false }),
      putObject: ({ key, body, contentType }) => {
        if (key.includes('admin_audit_log')) {
          return Promise.reject(new Error('R2 unavailable for admin_audit_log'));
        }
        uploads.push({ key, body: Buffer.isBuffer(body) ? body : Buffer.from(body), contentType });
        return Promise.resolve();
      },
      deleteObject: () => Promise.resolve(),
      presignPut: () => Promise.resolve('https://presigned.test/put'),
      presignGet: () => Promise.resolve('https://presigned.test/get'),
      listObjects: () => Promise.resolve([]),
    };
    const svc = new AuditArchiveService({
      r2: flakyR2,
      ledger: fakeLedger(ledgerRows),
      rows: fakeRows({
        rowsByTable: {
          admin_audit_log: [adminAuditRow('a1', '2026-04-01T00:00:00.000Z')],
          processed_stripe_events: [],
          legal_acceptances: [],
          webhook_deliveries: [],
          session_events: [],
        },
        deletes,
      }),
      now: () => FIXED_NOW,
    });
    const result = await svc.archiveAll();
    // admin_audit_log failed but the other four still ran.
    expect(result.errors.map((e) => e.tableName)).toEqual(['admin_audit_log']);
    expect(result.errors[0]?.error).toContain('R2 unavailable');
    expect(result.results.map((r) => r.tableName).sort()).toEqual([
      'legal_acceptances',
      'processed_stripe_events',
      'session_events',
      'webhook_deliveries',
    ]);
    expect(uploads).toHaveLength(4);
    expect(ledgerRows).toHaveLength(4);
    // admin_audit_log's row was never deleted (no archived copy) — stays in PG.
    expect(deletes).toHaveLength(0);
  });
});

describe('Re-export — gzipSync available for callers', () => {
  it('gzipSync from the service module round-trips', () => {
    const compressed = gzipSync(Buffer.from('hello'));
    expect(gunzipSync(compressed).toString('utf-8')).toBe('hello');
  });
});
