// V-553.B-26 — unit tests for AuditArchiveService (V-163 / ADR-006).
//
// Surface under test:
//   - archiveObjectKey: YYYY/MM partitioning
//   - rowsToJsonl: empty input returns '' (no trailing newline)
//   - archiveTable: empty window — ledger row inserted with rowsArchived=0,
//     markDeletedFromPostgres still called (vacuous), no deleteRowsById call
//   - archiveTable: happy path — selectArchivableRows → r2.putObject →
//     ledger.insertRun → rows.deleteRowsById → markDeletedFromPostgres
//   - archiveTable: deletion count mismatch — markDeletedFromPostgres NOT
//     called when deleteRowsById returns fewer than archived
//   - archiveAll: iterates the 4 audit-shaped tables in order

import { describe, expect, it } from 'vitest';
import {
  archiveObjectKey,
  AUDIT_TABLES,
  AuditArchiveService,
  type ArchiveLedgerRepo,
  type ArchiveTableName,
  type ArchiveTableRepo,
  rowsToJsonl,
} from '../../src/services/audit-archive.js';
import type { R2 } from '../../src/lib/r2.js';

function makeR2(): {
  r2: R2;
  puts: Array<{ key: string; body: Buffer | Uint8Array | string; contentType?: string }>;
} {
  const puts: Array<{ key: string; body: Buffer | Uint8Array | string; contentType?: string }> = [];
  const r2: R2 = {
    headObject: () => Promise.resolve({ exists: false }),
    putObject: (args) => {
      puts.push(args);
      return Promise.resolve();
    },
    deleteObject: () => Promise.resolve(),
    presignPut: () => Promise.resolve('https://stub.example/put'),
    presignGet: () => Promise.resolve('https://stub.example/get'),
    listObjects: () => Promise.resolve([]),
    bucket: 'stub-bucket',
  };
  return { r2, puts };
}

function makeLedger(): {
  ledger: ArchiveLedgerRepo;
  inserts: Array<{
    tableName: ArchiveTableName;
    rowsArchived: number;
    r2ObjectKey: string;
    sha256Checksum: string;
  }>;
  markedDeleted: string[];
} {
  const inserts: Array<{
    tableName: ArchiveTableName;
    rowsArchived: number;
    r2ObjectKey: string;
    sha256Checksum: string;
  }> = [];
  const markedDeleted: string[] = [];
  let counter = 0;
  const ledger: ArchiveLedgerRepo = {
    insertRun: (args) => {
      counter += 1;
      inserts.push({
        tableName: args.tableName,
        rowsArchived: args.rowsArchived,
        r2ObjectKey: args.r2ObjectKey,
        sha256Checksum: args.sha256Checksum,
      });
      return Promise.resolve(`run_${counter.toString()}`);
    },
    markDeletedFromPostgres: (runId) => {
      markedDeleted.push(runId);
      return Promise.resolve();
    },
  };
  return { ledger, inserts, markedDeleted };
}

function makeRows(
  opts: {
    rowsByTable?: Partial<Record<ArchiveTableName, Record<string, unknown>[]>>;
    deletedCountOverride?: number;
  } = {},
): {
  rows: ArchiveTableRepo;
  deletes: Array<{ tableName: ArchiveTableName; ids: readonly string[] }>;
} {
  const deletes: Array<{ tableName: ArchiveTableName; ids: readonly string[] }> = [];
  const rows: ArchiveTableRepo = {
    selectArchivableRows: (tableName) => Promise.resolve(opts.rowsByTable?.[tableName] ?? []),
    deleteRowsById: (tableName, ids) => {
      deletes.push({ tableName, ids });
      return Promise.resolve(opts.deletedCountOverride ?? ids.length);
    },
  };
  return { rows, deletes };
}

describe('V-553.B-26 archiveObjectKey', () => {
  it('partitions by YYYY/MM and names the file with the window month', () => {
    const key = archiveObjectKey(
      'audit-archive',
      'admin_audit_log',
      new Date('2026-05-11T10:00:00Z'),
    );
    expect(key).toBe('audit-archive/admin_audit_log/2026/05/admin_audit_log_2026-05.jsonl.gz');
  });

  it('zero-pads the month', () => {
    const key = archiveObjectKey('audit-archive', 'webhook_deliveries', new Date('2026-01-15Z'));
    expect(key).toContain('/2026/01/');
    expect(key).toContain('webhook_deliveries_2026-01.jsonl.gz');
  });

  it('honours a custom prefix (staging/prod split)', () => {
    const key = archiveObjectKey('audit-stage', 'legal_acceptances', new Date('2026-05-11Z'));
    expect(key.startsWith('audit-stage/legal_acceptances/')).toBe(true);
  });
});

describe('V-553.B-26 rowsToJsonl', () => {
  it('returns empty string for empty input (no trailing newline)', () => {
    expect(rowsToJsonl([])).toBe('');
  });

  it('joins rows with single newlines (no trailing newline)', () => {
    expect(rowsToJsonl([{ a: 1 }, { b: 2 }])).toBe('{"a":1}\n{"b":2}');
  });
});

describe('V-553.B-26 AuditArchiveService.archiveTable', () => {
  it('empty window: rowsArchived=0, no deleteRowsById call, ledger still marks deleted', async () => {
    const { r2, puts } = makeR2();
    const { ledger, inserts, markedDeleted } = makeLedger();
    const { rows, deletes } = makeRows();
    const svc = new AuditArchiveService({
      r2,
      ledger,
      rows,
      now: () => new Date('2026-05-11T02:00:00Z'),
    });
    const result = await svc.archiveTable('admin_audit_log');
    expect(result.rowsArchived).toBe(0);
    expect(result.deletedFromPostgres).toBe(true);
    expect(puts).toHaveLength(1); // empty gzip still uploaded
    expect(inserts[0]?.rowsArchived).toBe(0);
    expect(deletes).toHaveLength(0); // no delete call
    expect(markedDeleted).toEqual(['run_1']);
  });

  it('happy path: selects, uploads, inserts ledger, deletes, marks deleted', async () => {
    const { r2, puts } = makeR2();
    const { ledger, inserts, markedDeleted } = makeLedger();
    const { rows, deletes } = makeRows({
      rowsByTable: {
        admin_audit_log: [
          { id: 'aud_1', timestamp: '2026-01-10T00:00:00Z', action: 'x' },
          { id: 'aud_2', timestamp: '2026-01-11T00:00:00Z', action: 'y' },
        ],
      },
    });
    const svc = new AuditArchiveService({
      r2,
      ledger,
      rows,
      now: () => new Date('2026-05-11T02:00:00Z'),
    });
    const result = await svc.archiveTable('admin_audit_log');
    expect(result.rowsArchived).toBe(2);
    expect(result.deletedFromPostgres).toBe(true);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.contentType).toBe('application/x-ndjson+gzip');
    expect(puts[0]?.key).toContain('/2026/01/');
    expect(inserts[0]?.rowsArchived).toBe(2);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.ids).toEqual(['aud_1', 'aud_2']);
    expect(markedDeleted).toEqual(['run_1']);
  });

  it('deletion count mismatch: ledger row inserted but markDeletedFromPostgres NOT called', async () => {
    const { r2 } = makeR2();
    const { ledger, inserts, markedDeleted } = makeLedger();
    const { rows } = makeRows({
      rowsByTable: {
        webhook_deliveries: [
          { id: 'whd_1', created_at: '2026-01-01Z' },
          { id: 'whd_2', created_at: '2026-01-02Z' },
        ],
      },
      deletedCountOverride: 1, // only 1 of 2 actually deleted
    });
    const svc = new AuditArchiveService({
      r2,
      ledger,
      rows,
      now: () => new Date('2026-05-11Z'),
    });
    const result = await svc.archiveTable('webhook_deliveries');
    expect(result.rowsArchived).toBe(2);
    expect(result.deletedFromPostgres).toBe(false);
    expect(inserts).toHaveLength(1);
    expect(markedDeleted).toEqual([]); // NOT marked — re-run next month
  });
});

describe('V-553.B-26 AuditArchiveService.archiveAll', () => {
  it('iterates the 5 tables (4 audit-shaped + session_events) in fixed order', async () => {
    const { r2 } = makeR2();
    const { ledger, inserts } = makeLedger();
    const { rows } = makeRows();
    const svc = new AuditArchiveService({
      r2,
      ledger,
      rows,
      now: () => new Date('2026-05-11Z'),
    });
    const out = await svc.archiveAll();
    expect(out.results.map((r) => r.tableName)).toEqual(AUDIT_TABLES.map((t) => t.tableName));
    expect(inserts).toHaveLength(5);
  });
});
