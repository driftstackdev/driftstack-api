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

  it("V-172 + V-163 framing pinned: 'Drizzle-backed ArchiveTableRepo + ArchiveLedgerRepo for the V-163 AuditArchiveService.' + the AUDIT_TABLES dispatch rationale", () => {
    // The table COUNT is deliberately not pinned here any more. This block used
    // to require the paragraph verbatim, including the words "The four
    // audit-shaped tables" — and session_events had been the fifth since W438.
    // A verbatim pin cannot tell a correction from a regression, so it kept the
    // stale number mandatory. The count now lives in an assertion that derives
    // it from AUDIT_TABLES; see the cross-source invariant file.
    expect(body).toMatch(
      /\/\/ V-172 — Drizzle-backed ArchiveTableRepo \+ ArchiveLedgerRepo for the\s*\/\/ V-163 AuditArchiveService\./,
    );
    expect(body).toMatch(/this repo dispatches to the right table \+/);
    expect(body).toMatch(/per `tableName` argument\./);
  });

  it('lifecycle framing pinned: 4-step archiveTable cycle (selectArchivableRows → insertRun → deleteRowsById → markDeletedFromPostgres)', () => {
    expect(body).toMatch(
      /\/\/\s*1\. selectArchivableRows\(\)[\s\S]*?\/\/\s*2\. insertRun\(\)[\s\S]*?\/\/\s*3\. deleteRowsById\(\)[\s\S]*?\/\/\s*4\. markDeletedFromPostgres\(\)/,
    );
  });

  it('imports: asc/eq/inArray/lt from drizzle-orm; 3 service types from audit-archive; Database; 6 schema tables (adminAuditLog + auditArchiveRuns + legalAcceptances + processedStripeEvents + sessionEvents + webhookDeliveries)', () => {
    expect(body).toMatch(/import \{ asc, eq, inArray, lt \} from 'drizzle-orm';/);
    expect(body).toMatch(
      /import type \{\s*ArchiveLedgerRepo,\s*ArchiveTableName,\s*ArchiveTableRepo,\s*\} from '\.\.\/services\/audit-archive\.js';/,
    );
    expect(body).toMatch(
      /import \{\s*adminAuditLog,\s*auditArchiveRuns,\s*legalAcceptances,\s*processedStripeEvents,\s*sessionEvents,\s*webhookDeliveries,\s*\} from '\.\/schema\.js';/,
    );
  });

  it('selectArchivableRows: admin_audit_log → lt(timestamp) + orderBy(asc(timestamp), asc(id))', () => {
    expect(body).toMatch(
      /case 'admin_audit_log': \{\s*const query = this\.database\.db\s*\.select\(\)\s*\.from\(adminAuditLog\)\s*\.where\(lt\(adminAuditLog\.timestamp, olderThan\)\)\s*\.orderBy\(asc\(adminAuditLog\.timestamp\), asc\(adminAuditLog\.id\)\);\s*const rows = await \(cap === null \? query : query\.limit\(cap\)\);\s*return rows;\s*\}/,
    );
  });

  it("processed_stripe_events framing pinned: 'AuditArchiveService.extractId() reads row.id — project event_id → id so the row shape matches the other tables.' + map((r) => ({ ...r, id: r.eventId }))", () => {
    expect(body).toMatch(
      /\/\/ processed_stripe_events\.PK is event_id \(no separate id col\)\.\s*\/\/ AuditArchiveService\.extractId\(\) reads row\.id — project\s*\/\/ event_id → id so the row shape matches the other tables\./,
    );
    expect(body).toMatch(/return rows\.map\(\(r\) => \(\{ \.\.\.r, id: r\.eventId \}\)\);/);
    expect(body).toMatch(
      /\.where\(lt\(processedStripeEvents\.receivedAt, olderThan\)\)\s*\.orderBy\(asc\(processedStripeEvents\.receivedAt\), asc\(processedStripeEvents\.eventId\)\);/,
    );
  });

  it('V-1591 CRITICAL every table branch applies the row cap — a branch that forgets it is an unbounded read on the scheduled path', () => {
    const fn = body.slice(
      body.indexOf('async selectArchivableRows('),
      body.indexOf('async deleteRowsById('),
    );
    const applied = fn.match(/cap === null \? query : query\.limit\(cap\)/g) ?? [];
    expect(
      applied.length,
      'one branch per archivable table must apply the cap; a missing one reads the whole window',
    ).toBe(5);
    expect(fn, 'the cap must be derived from the optional limit argument').toMatch(
      /const cap = limit !== undefined && limit > 0 \? limit : null;/,
    );
  });

  it('selectArchivableRows: legal_acceptances → lt(acceptedAt) + orderBy(asc(acceptedAt), asc(id)); webhook_deliveries → lt(createdAt) + orderBy(asc(createdAt), asc(id))', () => {
    expect(body).toMatch(
      /case 'legal_acceptances': \{[\s\S]*?\.where\(lt\(legalAcceptances\.acceptedAt, olderThan\)\)\s*\.orderBy\(asc\(legalAcceptances\.acceptedAt\), asc\(legalAcceptances\.id\)\);/,
    );
    expect(body).toMatch(
      /case 'webhook_deliveries': \{[\s\S]*?\.where\(lt\(webhookDeliveries\.createdAt, olderThan\)\)\s*\.orderBy\(asc\(webhookDeliveries\.createdAt\), asc\(webhookDeliveries\.id\)\);/,
    );
  });

  it('deleteRowsById: empty early-return; processed_stripe_events WHERE switches to event_id (PK); other tables WHERE on id', () => {
    expect(body).toMatch(/if \(ids\.length === 0\) return 0;/);
    expect(body).toMatch(
      /case 'processed_stripe_events': \{[\s\S]*?\.delete\(processedStripeEvents\)\s*\.where\(inArray\(processedStripeEvents\.eventId, idArray\)\);/,
    );
    expect(body).toMatch(
      /\.delete\(adminAuditLog\)\s*\.where\(inArray\(adminAuditLog\.id, idArray\)\);/,
    );
    expect(body).toMatch(
      /\.delete\(legalAcceptances\)\s*\.where\(inArray\(legalAcceptances\.id, idArray\)\);/,
    );
    expect(body).toMatch(
      /\.delete\(webhookDeliveries\)\s*\.where\(inArray\(webhookDeliveries\.id, idArray\)\);/,
    );
  });

  it("insertRun: 9-field values (8 args + deletedFromPostgres:false seed); .returning({id}); throws 'insertRun returned no row'", () => {
    expect(body).toMatch(
      /\.values\(\{\s*tableName: args\.tableName,\s*windowStart: args\.windowStart,\s*windowEnd: args\.windowEnd,\s*rowsArchived: args\.rowsArchived,\s*r2ObjectKey: args\.r2ObjectKey,\s*sha256Checksum: args\.sha256Checksum,\s*startedAt: args\.startedAt,\s*completedAt: args\.completedAt,\s*deletedFromPostgres: false,\s*\}\)\s*\.returning\(\{ id: auditArchiveRuns\.id \}\);/,
    );
    expect(body).toMatch(/if \(!row\) throw new Error\('insertRun returned no row'\);/);
  });

  it('markDeletedFromPostgres: 1-field set deletedFromPostgres:true where id=runId', () => {
    expect(body).toMatch(
      /async markDeletedFromPostgres\(runId: string\): Promise<void> \{\s*await this\.database\.db\s*\.update\(auditArchiveRuns\)\s*\.set\(\{ deletedFromPostgres: true \}\)\s*\.where\(eq\(auditArchiveRuns\.id, runId\)\);\s*\}/,
    );
  });

  it('rowsAffected: defensive cast for postgres-js driver shape ({rowCount?} or {count?}); return r.rowCount ?? r.count ?? 0', () => {
    expect(body).toMatch(
      /function rowsAffected\(result: unknown\): number \{[\s\S]*?const r = result as \{ rowCount\?: number; count\?: number \};\s*return r\.rowCount \?\? r\.count \?\? 0;\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
