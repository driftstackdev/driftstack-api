// W995 — db/admin-audit-repo D-025 + V-521 cross-source invariant.
// Three-hundred-twenty-first in the drift-guard series. Pins the
// apps/server/src/db/admin-audit-repo.ts append-only admin-audit
// repo:
//
//   D-025 append-only framing — 'Insert + paginated list only. No
//   update, no delete — see D-025 for the append-only invariant'.
//
//   DrizzleAdminAuditLogRepo 2-method surface — insert + list.
//
//   insert 8-field values — adminAccountId + adminKeyId + action +
//     targetAccountId (?? null) + targetResourceId (?? null) +
//     inputPayload (?? null) + result + ipAddress (?? null).
//
//   insert defensive 'admin_audit_log insert returned no row' check.
//
//   list 6-filter ladder:
//     - adminAccountId → eq.
//     - targetAccountId → eq.
//     - action → eq.
//     - from → gte(timestamp).
//     - to → lt(timestamp).
//     - V-521 targetResourceId → eq (drill-down parity with V-484
//       customer-side filter).
//     - cursor → lt(timestamp, new Date(cursor)).
//
//   limit+1 hasMore probe + nextCursor = last.timestamp.toISOString().
//
//   orderBy desc(timestamp) — newest first.
//
//   toRow 10-field mapper — id + adminAccountId + adminKeyId + action
//     + targetAccountId + targetResourceId + inputPayload + result +
//     ipAddress + timestamp.
//
// stays in lockstep across apps/server/src/db/admin-audit-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W995 db/admin-audit-repo D-025 + V-521 cross-source invariant', () => {
  // ─── D-025 append-only framing ───────────────────────────────

  it("CRITICAL apps/server/src/db/admin-audit-repo.ts header pins D-025 — 'Insert + paginated list only. No update, no delete — see D-025 for the append-only invariant'. The D-025 append-only design is the admin-audit immutability contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/admin-audit-repo.ts'));
    expect(p).toMatch(/\/\/ Drizzle-backed AdminAuditLogRepo\./);
    expect(p).toMatch(/\/\/ Insert \+ paginated list only\. No update, no delete — see D-025 for/);
    expect(p).toMatch(/\/\/ the append-only invariant\./);
  });

  // ─── 2-method surface ────────────────────────────────────────

  it('CRITICAL 2-method surface — insert + list. The 2-method shape enforces append-only (no update, no delete, no upsert).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/admin-audit-repo.ts'));
    expect(p).toMatch(/export class DrizzleAdminAuditLogRepo implements AdminAuditLogRepo \{/);
    expect(p).toMatch(/async insert\(input: NewAdminAuditLogInput\): Promise<AdminAuditLogRow> \{/);
    expect(p).toMatch(/async list\(filters: ListAuditFilters\): Promise<ListAuditPage> \{/);
  });

  // ─── insert 8-field values ───────────────────────────────────

  it('CRITICAL insert 8-field values shape — adminAccountId + adminKeyId + action + targetAccountId??null + targetResourceId??null + inputPayload??null + result + ipAddress??null. The ??null normalisation keeps NULL semantics consistent with the schema.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/admin-audit-repo.ts'));
    expect(p).toMatch(/adminAccountId: input\.adminAccountId,/);
    expect(p).toMatch(/adminKeyId: input\.adminKeyId,/);
    expect(p).toMatch(/action: input\.action,/);
    expect(p).toMatch(/targetAccountId: input\.targetAccountId \?\? null,/);
    expect(p).toMatch(/targetResourceId: input\.targetResourceId \?\? null,/);
    expect(p).toMatch(/inputPayload: input\.inputPayload \?\? null,/);
    expect(p).toMatch(/result: input\.result,/);
    expect(p).toMatch(/ipAddress: input\.ipAddress \?\? null,/);
  });

  it("CRITICAL insert defensive 'admin_audit_log insert returned no row' check. The named-error keeps the failure scenario diagnosable.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/admin-audit-repo.ts'));
    expect(p).toMatch(/if \(!row\) throw new Error\('admin_audit_log insert returned no row'\);/);
  });

  // ─── list 6-filter ladder ────────────────────────────────────

  it('CRITICAL list 6-filter ladder — adminAccountId + targetAccountId + action + from(gte timestamp) + to(lt timestamp) + V-521 targetResourceId + cursor(lt timestamp from Date). The 6+cursor filter covers admin-side audit drill-down.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/admin-audit-repo.ts'));
    expect(p).toMatch(/if \(filters\.adminAccountId\) \{/);
    expect(p).toMatch(
      /conds\.push\(eq\(adminAuditLog\.adminAccountId, filters\.adminAccountId\)\);/,
    );
    expect(p).toMatch(/if \(filters\.targetAccountId\) \{/);
    expect(p).toMatch(
      /conds\.push\(eq\(adminAuditLog\.targetAccountId, filters\.targetAccountId\)\);/,
    );
    expect(p).toMatch(
      /if \(filters\.action\) conds\.push\(eq\(adminAuditLog\.action, filters\.action\)\);/,
    );
    expect(p).toMatch(
      /if \(filters\.from\) conds\.push\(gte\(adminAuditLog\.timestamp, filters\.from\)\);/,
    );
    expect(p).toMatch(
      /if \(filters\.to\) conds\.push\(lt\(adminAuditLog\.timestamp, filters\.to\)\);/,
    );
    expect(p).toMatch(
      /if \(filters\.cursor\) conds\.push\(lt\(adminAuditLog\.timestamp, new Date\(filters\.cursor\)\)\);/,
    );
  });

  // ─── V-521 targetResourceId drill-down ───────────────────────

  it("CRITICAL V-521 targetResourceId framing — 'V-521 — drill-down by resource id (parity with V-484 customer-side filter)'. The V-484 customer-parity is what makes admin-side audit and customer-side audit interchangeable filters.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/admin-audit-repo.ts'));
    expect(p).toMatch(/\/\/ V-521 — drill-down by resource id \(parity with V-484/);
    expect(p).toMatch(/\/\/ customer-side filter\)\./);
    expect(p).toMatch(/if \(filters\.targetResourceId\) \{/);
    expect(p).toMatch(
      /conds\.push\(eq\(adminAuditLog\.targetResourceId, filters\.targetResourceId\)\);/,
    );
  });

  // ─── limit+1 hasMore probe ───────────────────────────────────

  it('CRITICAL list uses limit(filters.limit + 1) hasMore probe + nextCursor = last.timestamp.toISOString(). The +1 probe is the standard keyset-pagination pattern.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/admin-audit-repo.ts'));
    expect(p).toMatch(/\.limit\(filters\.limit \+ 1\);/);
    expect(p).toMatch(/const hasMore = rows\.length > filters\.limit;/);
    expect(p).toMatch(/const items = hasMore \? rows\.slice\(0, filters\.limit\) : rows;/);
    expect(p).toMatch(/nextCursor: hasMore && last \? last\.timestamp\.toISOString\(\) : null,/);
  });

  // ─── orderBy desc(timestamp) ─────────────────────────────────

  it('CRITICAL list orders by desc(timestamp) — newest first. The newest-first ordering matches admin-dashboard expectations.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/admin-audit-repo.ts'));
    expect(p).toMatch(/\.orderBy\(desc\(adminAuditLog\.timestamp\)\)/);
  });

  // ─── No-filter undefined whereClause ─────────────────────────

  it("CRITICAL list emits 'where(conds.length > 0 ? and(...conds) : undefined)'. The undefined-on-empty design lets drizzle skip emitting WHERE.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/admin-audit-repo.ts'));
    expect(p).toMatch(/\.where\(conds\.length > 0 \? and\(\.\.\.conds\) : undefined\)/);
  });

  // ─── toRow 10-field mapper ───────────────────────────────────

  it('CRITICAL toRow 10-field mapper — id + adminAccountId + adminKeyId + action + targetAccountId + targetResourceId + inputPayload + result + ipAddress + timestamp. The 10-field AdminAuditLogRow is the D-025 service-layer shape.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/admin-audit-repo.ts'));
    expect(p).toMatch(
      /function toRow\(r: typeof adminAuditLog\.\$inferSelect\): AdminAuditLogRow \{/,
    );
    expect(p).toMatch(/id: r\.id,/);
    expect(p).toMatch(/adminAccountId: r\.adminAccountId,/);
    expect(p).toMatch(/adminKeyId: r\.adminKeyId,/);
    expect(p).toMatch(/action: r\.action,/);
    expect(p).toMatch(/targetAccountId: r\.targetAccountId,/);
    expect(p).toMatch(/targetResourceId: r\.targetResourceId,/);
    expect(p).toMatch(/inputPayload: r\.inputPayload,/);
    expect(p).toMatch(/result: r\.result,/);
    expect(p).toMatch(/ipAddress: r\.ipAddress,/);
    expect(p).toMatch(/timestamp: r\.timestamp,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-admin-audit-repo-d025-v521-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
