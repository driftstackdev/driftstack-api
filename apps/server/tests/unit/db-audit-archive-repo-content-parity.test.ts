// W448.A — drift guard for apps/server/src/db/audit-archive-repo.ts.
// V-172 DrizzleArchiveTableRepo + DrizzleArchiveLedgerRepo backing the
// V-163 AuditArchiveService. Drift here either drops the
// processed_stripe_events event_id→id projection on
// selectArchivableRows (service-layer extractId(row.id) goes
// undefined → ids never make it to deleteRowsById → archived rows
// never actually deleted from Postgres) or breaks the per-table
// primary-timestamp dispatcher (admin_audit_log.timestamp /
// processed_stripe_events.received_at / legal_acceptances.accepted_at /
// webhook_deliveries.created_at) — older-than-90-days filter applies
// to the wrong column, silently archives rows that don't match the
// retention contract.
//
//   • V-172 + V-163 framing pinned.
//   • Per-table primary-timestamp column dispatch in selectArchivableRows.
//   • processed_stripe_events PK is event_id (not id); select-time
//     map (...r, id: r.eventId) projection + delete-time WHERE switches
//     to event_id.
//   • Each table has orderBy(asc(primaryTimestamp), asc(idColumn)) for
//     stable archival ordering.
//   • deleteRowsById early-return on ids.length === 0.
//   • insertRun: 9-field values w/ deletedFromPostgres:false seed;
//     throws 'insertRun returned no row'.
//   • markDeletedFromPostgres: 1-field flag flip.
//   • rowsAffected: defensive cast for rowCount|count driver shape.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/audit-archive-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W448.A apps/server/src/db/audit-archive-repo.ts content parity', () => {
  const body = read(LIB);

  it("V-172 + V-163 framing pinned: 'Drizzle-backed ArchiveTableRepo + ArchiveLedgerRepo for the V-163 AuditArchiveService.' + 4-audit-table dispatch rationale", () => {
    expect(body).toMatch(
      /\/\/ V-172 — Drizzle-backed ArchiveTableRepo \+ ArchiveLedgerRepo for the\s*\n?\s*\/\/ V-163 AuditArchiveService\. The four audit-shaped tables\s*\n?\s*\/\/ \(admin_audit_log \/ processed_stripe_events \/ legal_acceptances \/\s*\n?\s*\/\/ webhook_deliveries\) each have a different primary-timestamp column\s*\n?\s*\/\/ \(per AUDIT_TABLES\); this repo dispatches to the right table \+ column\s*\n?\s*\/\/ per `tableName` argument\./,
    );
  });

  it('lifecycle framing pinned: 4-step archiveTable cycle (selectArchivableRows → insertRun → deleteRowsById → markDeletedFromPostgres)', () => {
    expect(body).toMatch(
      /\/\/\s*1\. selectArchivableRows\(\)[\s\S]*?\/\/\s*2\. insertRun\(\)[\s\S]*?\/\/\s*3\. deleteRowsById\(\)[\s\S]*?\/\/\s*4\. markDeletedFromPostgres\(\)/,
    );
  });

  it('imports: asc/eq/inArray/lt from drizzle-orm; 3 service types from audit-archive; Database; 5 schema tables (adminAuditLog + auditArchiveRuns + legalAcceptances + processedStripeEvents + webhookDeliveries)', () => {
    expect(body).toMatch(/import \{ asc, eq, inArray, lt \} from 'drizzle-orm';/);
    expect(body).toMatch(
      /import type \{\s*\n?\s*ArchiveLedgerRepo,\s*\n?\s*ArchiveTableName,\s*\n?\s*ArchiveTableRepo,\s*\n?\s*\} from '\.\.\/services\/audit-archive\.js';/,
    );
    expect(body).toMatch(
      /import \{\s*\n?\s*adminAuditLog,\s*\n?\s*auditArchiveRuns,\s*\n?\s*legalAcceptances,\s*\n?\s*processedStripeEvents,\s*\n?\s*webhookDeliveries,\s*\n?\s*\} from '\.\/schema\.js';/,
    );
  });

  it('selectArchivableRows: admin_audit_log → lt(timestamp) + orderBy(asc(timestamp), asc(id))', () => {
    expect(body).toMatch(
      /case 'admin_audit_log': \{\s*\n?\s*const rows = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(adminAuditLog\)\s*\n?\s*\.where\(lt\(adminAuditLog\.timestamp, olderThan\)\)\s*\n?\s*\.orderBy\(asc\(adminAuditLog\.timestamp\), asc\(adminAuditLog\.id\)\);\s*\n?\s*return rows;\s*\n?\s*\}/,
    );
  });

  it("processed_stripe_events framing pinned: 'AuditArchiveService.extractId() reads row.id — project event_id → id so the row shape matches the other tables.' + map((r) => ({ ...r, id: r.eventId }))", () => {
    expect(body).toMatch(
      /\/\/ processed_stripe_events\.PK is event_id \(no separate id col\)\.\s*\n?\s*\/\/ AuditArchiveService\.extractId\(\) reads row\.id — project\s*\n?\s*\/\/ event_id → id so the row shape matches the other tables\./,
    );
    expect(body).toMatch(/return rows\.map\(\(r\) => \(\{ \.\.\.r, id: r\.eventId \}\)\);/);
    expect(body).toMatch(
      /\.where\(lt\(processedStripeEvents\.receivedAt, olderThan\)\)\s*\n?\s*\.orderBy\(asc\(processedStripeEvents\.receivedAt\), asc\(processedStripeEvents\.eventId\)\);/,
    );
  });

  it('selectArchivableRows: legal_acceptances → lt(acceptedAt) + orderBy(asc(acceptedAt), asc(id)); webhook_deliveries → lt(createdAt) + orderBy(asc(createdAt), asc(id))', () => {
    expect(body).toMatch(
      /case 'legal_acceptances': \{[\s\S]*?\.where\(lt\(legalAcceptances\.acceptedAt, olderThan\)\)\s*\n?\s*\.orderBy\(asc\(legalAcceptances\.acceptedAt\), asc\(legalAcceptances\.id\)\);/,
    );
    expect(body).toMatch(
      /case 'webhook_deliveries': \{[\s\S]*?\.where\(lt\(webhookDeliveries\.createdAt, olderThan\)\)\s*\n?\s*\.orderBy\(asc\(webhookDeliveries\.createdAt\), asc\(webhookDeliveries\.id\)\);/,
    );
  });

  it('deleteRowsById: empty early-return; processed_stripe_events WHERE switches to event_id (PK); other tables WHERE on id', () => {
    expect(body).toMatch(/if \(ids\.length === 0\) return 0;/);
    expect(body).toMatch(
      /case 'processed_stripe_events': \{[\s\S]*?\.delete\(processedStripeEvents\)\s*\n?\s*\.where\(inArray\(processedStripeEvents\.eventId, idArray\)\);/,
    );
    expect(body).toMatch(
      /\.delete\(adminAuditLog\)\s*\n?\s*\.where\(inArray\(adminAuditLog\.id, idArray\)\);/,
    );
    expect(body).toMatch(
      /\.delete\(legalAcceptances\)\s*\n?\s*\.where\(inArray\(legalAcceptances\.id, idArray\)\);/,
    );
    expect(body).toMatch(
      /\.delete\(webhookDeliveries\)\s*\n?\s*\.where\(inArray\(webhookDeliveries\.id, idArray\)\);/,
    );
  });

  it("insertRun: 9-field values (8 args + deletedFromPostgres:false seed); .returning({id}); throws 'insertRun returned no row'", () => {
    expect(body).toMatch(
      /\.values\(\{\s*\n?\s*tableName: args\.tableName,\s*\n?\s*windowStart: args\.windowStart,\s*\n?\s*windowEnd: args\.windowEnd,\s*\n?\s*rowsArchived: args\.rowsArchived,\s*\n?\s*r2ObjectKey: args\.r2ObjectKey,\s*\n?\s*sha256Checksum: args\.sha256Checksum,\s*\n?\s*startedAt: args\.startedAt,\s*\n?\s*completedAt: args\.completedAt,\s*\n?\s*deletedFromPostgres: false,\s*\n?\s*\}\)\s*\n?\s*\.returning\(\{ id: auditArchiveRuns\.id \}\);/,
    );
    expect(body).toMatch(/if \(!row\) throw new Error\('insertRun returned no row'\);/);
  });

  it('markDeletedFromPostgres: 1-field set deletedFromPostgres:true where id=runId', () => {
    expect(body).toMatch(
      /async markDeletedFromPostgres\(runId: string\): Promise<void> \{\s*\n?\s*await this\.database\.db\s*\n?\s*\.update\(auditArchiveRuns\)\s*\n?\s*\.set\(\{ deletedFromPostgres: true \}\)\s*\n?\s*\.where\(eq\(auditArchiveRuns\.id, runId\)\);\s*\n?\s*\}/,
    );
  });

  it('rowsAffected: defensive cast for postgres-js driver shape ({rowCount?} or {count?}); return r.rowCount ?? r.count ?? 0', () => {
    expect(body).toMatch(
      /function rowsAffected\(result: unknown\): number \{[\s\S]*?const r = result as \{ rowCount\?: number; count\?: number \};\s*\n?\s*return r\.rowCount \?\? r\.count \?\? 0;\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
