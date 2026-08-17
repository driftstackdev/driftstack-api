// W996 — db/audit-archive-repo V-163 + V-172 cross-source invariant.
// Three-hundred-twenty-second in the drift-guard series. Pins the
// apps/server/src/db/audit-archive-repo.ts archive-table + ledger
// repos:
//
//   V-172 anchor — 'V-172 — Drizzle-backed ArchiveTableRepo +
//   ArchiveLedgerRepo for the V-163 AuditArchiveService'.
//
//   4-table framing — 'The four audit-shaped tables
//   (admin_audit_log / processed_stripe_events / legal_acceptances /
//   webhook_deliveries) each have a different primary-timestamp
//   column (per AUDIT_TABLES); this repo dispatches to the right
//   table + column per tableName argument'.
//
//   Lifecycle 4-step framing — '1. selectArchivableRows() — SELECT
//   rows older than 90 days from this repo, sha256 + gzip + R2
//   upload happens in service code. 2. insertRun() — record in
//   audit_archive_runs ledger. 3. deleteRowsById() — DELETE archived
//   rows from Postgres. 4. markDeletedFromPostgres() — flip the
//   ledger row's flag'.
//
//   DrizzleArchiveTableRepo 2-method surface — selectArchivableRows
//     + deleteRowsById.
//
//   4-branch dispatch per ArchiveTableName:
//     - admin_audit_log: lt(timestamp) + orderBy(timestamp, id).
//     - processed_stripe_events: lt(receivedAt) + orderBy
//       (receivedAt, eventId) + project event_id → id.
//     - legal_acceptances: lt(acceptedAt) + orderBy(acceptedAt, id).
//     - webhook_deliveries: lt(createdAt) + orderBy(createdAt, id).
//
//   deleteRowsById early-return on empty ids array, and chunking below the
//   65534 bind-parameter ceiling.
//
//   DrizzleArchiveLedgerRepo 2-method surface — insertRun (8-field +
//     deletedFromPostgres:false) + markDeletedFromPostgres.
//
//   rowsAffected helper — 'postgres-js + drizzle return shape: {
//   rowCount: number } or { count: number } depending on the driver.
//   Defensive cast covers both'.
//
// stays in lockstep across apps/server/src/db/audit-archive-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W996 db/audit-archive-repo V-163 + V-172 cross-source invariant', () => {
  // ─── V-172 anchor + 4-table framing ──────────────────────────

  it("CRITICAL apps/server/src/db/audit-archive-repo.ts header pins V-172 anchor — 'V-172 — Drizzle-backed ArchiveTableRepo + ArchiveLedgerRepo for the V-163 AuditArchiveService'. The V-172 + V-163 anchor pair is the audit-archive provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/audit-archive-repo.ts'));
    expect(p).toMatch(/V-172 — Drizzle-backed ArchiveTableRepo \+ ArchiveLedgerRepo for the/);
    expect(p).toMatch(/V-163 AuditArchiveService\./);
  });

  it("CRITICAL 4-table framing — 'The four audit-shaped tables (admin_audit_log / processed_stripe_events / legal_acceptances / webhook_deliveries) each have a different primary-timestamp column (per AUDIT_TABLES); this repo dispatches to the right table + column per tableName argument'. The 4-table inventory is the ADR-006 archive scope.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/audit-archive-repo.ts'));
    expect(p).toMatch(/The four audit-shaped tables/);
    expect(p).toMatch(/\(admin_audit_log \/ processed_stripe_events \/ legal_acceptances \//);
    expect(p).toMatch(/webhook_deliveries\) each have a different primary-timestamp column/);
    expect(p).toMatch(/\(per AUDIT_TABLES\); this repo dispatches to the right table \+ column/);
    expect(p).toMatch(/per `tableName` argument\./);
  });

  // ─── Lifecycle 4-step framing ────────────────────────────────

  it("CRITICAL lifecycle 4-step framing — '1. selectArchivableRows() — SELECT rows older than 90 days from this repo, sha256 + gzip + R2 upload happens in service code. 2. insertRun() — record in audit_archive_runs ledger. 3. deleteRowsById() — DELETE archived rows from Postgres. 4. markDeletedFromPostgres() — flip the ledger row's flag'. The select→record-run→delete→flip-flag sequence is the V-163 + ADR-006 archive contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/audit-archive-repo.ts'));
    expect(p).toMatch(/1\. selectArchivableRows\(\) — SELECT rows older than 90 days from/);
    expect(p).toMatch(/this repo, sha256 \+ gzip \+ R2 upload happens in service code\./);
    expect(p).toMatch(/2\. insertRun\(\) — record in audit_archive_runs ledger\./);
    expect(p).toMatch(/3\. deleteRowsById\(\) — DELETE archived rows from Postgres\./);
    expect(p).toMatch(/4\. markDeletedFromPostgres\(\) — flip the ledger row's flag\./);
  });

  // ─── 2 repo classes ──────────────────────────────────────────

  it('CRITICAL 2 exported repos — DrizzleArchiveTableRepo + DrizzleArchiveLedgerRepo. The 2-repo split keeps the data-mutation (Table) and the audit-trail (Ledger) responsibilities separable.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/audit-archive-repo.ts'));
    expect(p).toMatch(/export class DrizzleArchiveTableRepo implements ArchiveTableRepo \{/);
    expect(p).toMatch(/export class DrizzleArchiveLedgerRepo implements ArchiveLedgerRepo \{/);
  });

  // ─── 4-branch select dispatch ────────────────────────────────

  it('CRITICAL selectArchivableRows 4-branch dispatch — admin_audit_log lt(timestamp) + processed_stripe_events lt(receivedAt) + legal_acceptances lt(acceptedAt) + webhook_deliveries lt(createdAt). The per-table timestamp-column is what makes the AUDIT_TABLES dispatch deterministic.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/audit-archive-repo.ts'));
    expect(p).toMatch(/case 'admin_audit_log': \{/);
    expect(p).toMatch(/\.where\(lt\(adminAuditLog\.timestamp, olderThan\)\)/);
    expect(p).toMatch(/case 'processed_stripe_events': \{/);
    expect(p).toMatch(/\.where\(lt\(processedStripeEvents\.receivedAt, olderThan\)\)/);
    expect(p).toMatch(/case 'legal_acceptances': \{/);
    expect(p).toMatch(/\.where\(lt\(legalAcceptances\.acceptedAt, olderThan\)\)/);
    expect(p).toMatch(/case 'webhook_deliveries': \{/);
    expect(p).toMatch(/\.where\(lt\(webhookDeliveries\.createdAt, olderThan\)\)/);
  });

  it('CRITICAL each select orderBy is (timestamp/receivedAt/acceptedAt/createdAt) ASC + id ASC. The (timestamp, id) compound order is deterministic across re-runs.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/audit-archive-repo.ts'));
    expect(p).toMatch(/\.orderBy\(asc\(adminAuditLog\.timestamp\), asc\(adminAuditLog\.id\)\)/);
    expect(p).toMatch(
      /\.orderBy\(asc\(processedStripeEvents\.receivedAt\), asc\(processedStripeEvents\.eventId\)\)/,
    );
    expect(p).toMatch(
      /\.orderBy\(asc\(legalAcceptances\.acceptedAt\), asc\(legalAcceptances\.id\)\)/,
    );
    expect(p).toMatch(
      /\.orderBy\(asc\(webhookDeliveries\.createdAt\), asc\(webhookDeliveries\.id\)\)/,
    );
  });

  // ─── processed_stripe_events event_id→id projection ──────────

  it("CRITICAL processed_stripe_events event_id → id projection framing — 'processed_stripe_events.PK is event_id (no separate id col). AuditArchiveService.extractId() reads row.id — project event_id → id so the row shape matches the other tables'. The projection keeps the uniform-id contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/audit-archive-repo.ts'));
    expect(p).toMatch(/\/\/ processed_stripe_events\.PK is event_id \(no separate id col\)\./);
    expect(p).toMatch(/\/\/ AuditArchiveService\.extractId\(\) reads row\.id — project/);
    expect(p).toMatch(/\/\/ event_id → id so the row shape matches the other tables\./);
    expect(p).toMatch(/return rows\.map\(\(r\) => \(\{ \.\.\.r, id: r\.eventId \}\)\);/);
  });

  // ─── deleteRowsById early-return + 4-branch ──────────────────

  it("CRITICAL deleteRowsById early-return on empty ids — 'if (ids.length === 0) return 0;'. The 0-on-empty avoids emitting 'DELETE WHERE id IN ()' which some Postgres drivers reject.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/audit-archive-repo.ts'));
    expect(p).toMatch(/if \(ids\.length === 0\) return 0;/);
  });

  it('CRITICAL deleteRowsById chunks below the bind-parameter ceiling', () => {
    // Replaces a pin on `const idArray = [...ids]` — the single-statement shape
    // that threw. `inArray` binds one parameter per id and postgres-js refuses
    // past 65534 (measured: 60000 ids succeed, 70000 raise
    // MAX_PARAMETERS_EXCEEDED). archiveTable uploads to R2 and writes the ledger
    // row BEFORE deleting, so a run over the ceiling left the rows in Postgres
    // with the archive already written, and every later run re-selected the same
    // set plus whatever had accrued.
    //
    // The behaviour is proved against real Postgres in
    // db-audit-archive-end-to-end-drizzle; this pins the constant it rests on,
    // because a chunk size raised past the ceiling reintroduces the fault and is
    // a one-token edit.
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/audit-archive-repo.ts'));
    const m = /const DELETE_ID_CHUNK = ([\d_]+);/.exec(p);
    expect(m, 'the chunk constant is gone — deleteRowsById may bind every id again').not.toBeNull();
    expect(Number((m?.[1] ?? '0').replaceAll('_', ''))).toBeLessThan(65_534);
    expect(p, 'deleteRowsById no longer iterates chunks').toMatch(
      /for \(const chunk of chunkIds\(ids\)\)/,
    );
  });

  it('CRITICAL processed_stripe_events deleteRowsById WHERE is eventId (PK is text event_id, not id). The 4-branch delete preserves the table-specific PK column.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/audit-archive-repo.ts'));
    expect(p).toMatch(/\.delete\(adminAuditLog\)/);
    expect(p).toMatch(/\.where\(inArray\(adminAuditLog\.id, idArray\)\)/);
    expect(p).toMatch(/\.delete\(processedStripeEvents\)/);
    expect(p).toMatch(/\.where\(inArray\(processedStripeEvents\.eventId, idArray\)\)/);
    expect(p).toMatch(/\.delete\(legalAcceptances\)/);
    expect(p).toMatch(/\.where\(inArray\(legalAcceptances\.id, idArray\)\)/);
    expect(p).toMatch(/\.delete\(webhookDeliveries\)/);
    expect(p).toMatch(/\.where\(inArray\(webhookDeliveries\.id, idArray\)\)/);
  });

  // ─── insertRun 8-field values + deletedFromPostgres:false ────

  it('CRITICAL insertRun 8-field values + deletedFromPostgres:false — tableName + windowStart + windowEnd + rowsArchived + r2ObjectKey + sha256Checksum + startedAt + completedAt + deletedFromPostgres:false. The 9th field is always-false at insert (markDeletedFromPostgres flips later).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/audit-archive-repo.ts'));
    expect(p).toMatch(/tableName: args\.tableName,/);
    expect(p).toMatch(/windowStart: args\.windowStart,/);
    expect(p).toMatch(/windowEnd: args\.windowEnd,/);
    expect(p).toMatch(/rowsArchived: args\.rowsArchived,/);
    expect(p).toMatch(/r2ObjectKey: args\.r2ObjectKey,/);
    expect(p).toMatch(/sha256Checksum: args\.sha256Checksum,/);
    expect(p).toMatch(/startedAt: args\.startedAt,/);
    expect(p).toMatch(/completedAt: args\.completedAt,/);
    expect(p).toMatch(/deletedFromPostgres: false,/);
  });

  it('CRITICAL insertRun returns auditArchiveRuns.id from returning({id}). The narrow returning() keeps the ledger surface minimal.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/audit-archive-repo.ts'));
    expect(p).toMatch(/\.returning\(\{ id: auditArchiveRuns\.id \}\);/);
    expect(p).toMatch(/if \(!row\) throw new Error\('insertRun returned no row'\);/);
    expect(p).toMatch(/return row\.id;/);
  });

  // ─── markDeletedFromPostgres flag flip ───────────────────────

  it("CRITICAL markDeletedFromPostgres flips the flag to true — 'update(auditArchiveRuns).set({deletedFromPostgres: true}).where(eq(id, runId))'. The 1-field update is the V-163 step-4 ledger transition.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/audit-archive-repo.ts'));
    expect(p).toMatch(/async markDeletedFromPostgres\(runId: string\): Promise<void> \{/);
    expect(p).toMatch(/\.update\(auditArchiveRuns\)/);
    expect(p).toMatch(/\.set\(\{ deletedFromPostgres: true \}\)/);
    expect(p).toMatch(/\.where\(eq\(auditArchiveRuns\.id, runId\)\)/);
  });

  // ─── rowsAffected dual-driver fallback ───────────────────────

  it("CRITICAL rowsAffected handles rowCount/count dual-driver shape — 'postgres-js + drizzle return shape: { rowCount: number } or { count: number } depending on the driver. Defensive cast covers both'. The r.rowCount ?? r.count ?? 0 design is what makes the helper postgres-js-vs-pg-native agnostic.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/audit-archive-repo.ts'));
    expect(p).toMatch(
      /\/\/ postgres-js \+ drizzle return shape: \{ rowCount: number \} or \{ count: number \}/,
    );
    expect(p).toMatch(/\/\/ depending on the driver\. Defensive cast covers both\./);
    expect(p).toMatch(/const r = result as \{ rowCount\?: number; count\?: number \};/);
    expect(p).toMatch(/return r\.rowCount \?\? r\.count \?\? 0;/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-audit-archive-repo-v163-v172-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
