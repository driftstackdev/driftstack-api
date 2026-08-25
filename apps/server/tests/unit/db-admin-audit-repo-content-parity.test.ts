// W443.A — drift guard for apps/server/src/db/admin-audit-repo.ts.
// Drizzle-backed AdminAuditLogRepo. Drift here either drops the
// D-025 append-only invariant (a misguided refactor adds update() /
// delete() and admin actions become editable / deniable) or breaks
// the V-521 targetResourceId filter (admin loses drill-down parity
// with V-484 customer-side).
//
//   • D-025 append-only framing pinned: insert + paginated list ONLY;
//     NO update, NO delete.
//   • insert(): 8-field values w/ null-coalesce on optional
//     (targetAccountId, targetResourceId, inputPayload, ipAddress).
//   • list(): same limit+1 hasMore pagination pattern as account-
//     audit-repo (V-216) — slice + nextCursor = last.timestamp ISO.
//   • orderBy desc(timestamp); cursor pushes lt(timestamp).
//   • V-521 targetResourceId filter rationale (parity with V-484
//     customer-side filter).
//   • Filter set: adminAccountId, targetAccountId, action, from gte,
//     to lt, targetResourceId, cursor lt.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/admin-audit-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W443.A apps/server/src/db/admin-audit-repo.ts content parity', () => {
  const body = read(LIB);

  it('D-025 append-only framing pinned: "Insert + paginated list only. No update, no delete — see D-025 for the append-only invariant."', () => {
    expect(body).toMatch(/\/\/ Drizzle-backed AdminAuditLogRepo\./);
    expect(body).toMatch(
      /\/\/ Insert \+ paginated list only\. No update, no delete — see D-025 for\s*\/\/ the append-only invariant\./,
    );
  });

  it('imports: and/desc/eq/gte/lt from drizzle-orm; 5 service types; Database; adminAuditLog schema', () => {
    expect(body).toMatch(/import \{ and, desc, eq, gte, lt, or \} from 'drizzle-orm';/);
    expect(body).toMatch(
      /import type \{\s*AdminAuditLogRepo,\s*AdminAuditLogRow,\s*ListAuditFilters,\s*ListAuditPage,\s*NewAdminAuditLogInput,\s*\} from '\.\.\/services\/admin-audit\.js';/,
    );
    expect(body).toMatch(/import \{ adminAuditLog \} from '\.\/schema\.js';/);
  });

  it("insert(): 8-field values (adminAccountId + adminKeyId + action + targetAccountId nullable + targetResourceId nullable + inputPayload nullable + result + ipAddress nullable); returning(); throws 'admin_audit_log insert returned no row' on empty", () => {
    expect(body).toMatch(
      /async insert\(input: NewAdminAuditLogInput\): Promise<AdminAuditLogRow> \{\s*const \[row\] = await this\.database\.db\s*\.insert\(adminAuditLog\)\s*\.values\(\{\s*adminAccountId: input\.adminAccountId,\s*adminKeyId: input\.adminKeyId,\s*action: input\.action,\s*targetAccountId: input\.targetAccountId \?\? null,\s*targetResourceId: input\.targetResourceId \?\? null,\s*inputPayload: input\.inputPayload \?\? null,\s*result: input\.result,\s*ipAddress: input\.ipAddress \?\? null,\s*\}\)\s*\.returning\(\);\s*if \(!row\) throw new Error\('admin_audit_log insert returned no row'\);\s*return toRow\(row\);\s*\}/,
    );
  });

  it('list() filters: adminAccountId eq + targetAccountId eq + action eq + from gte + to lt + V-521 targetResourceId eq + keyset cursor (timestamp,id)', () => {
    expect(body).toMatch(
      /if \(filters\.adminAccountId\) \{\s*conds\.push\(eq\(adminAuditLog\.adminAccountId, filters\.adminAccountId\)\);\s*\}\s*if \(filters\.targetAccountId\) \{\s*conds\.push\(eq\(adminAuditLog\.targetAccountId, filters\.targetAccountId\)\);\s*\}\s*if \(filters\.action\) conds\.push\(eq\(adminAuditLog\.action, filters\.action\)\);\s*if \(filters\.from\) conds\.push\(gte\(adminAuditLog\.timestamp, filters\.from\)\);\s*if \(filters\.to\) conds\.push\(lt\(adminAuditLog\.timestamp, filters\.to\)\);/,
    );
    // Keyset cursor: look up cursor row's (timestamp, id), compound filter.
    expect(body).toMatch(/const keyset = or\(/);
    expect(body).toMatch(/lt\(adminAuditLog\.timestamp, cursorRow\.timestamp\),/);
    expect(body).toMatch(/lt\(adminAuditLog\.id, cursorRow\.id\)/);
  });

  it("V-521 framing pinned: 'drill-down by resource id (parity with V-484 customer-side filter)' + targetResourceId eq filter", () => {
    expect(body).toMatch(
      /\/\/ V-521 — drill-down by resource id \(parity with V-484\s*\/\/ customer-side filter\)\./,
    );
    expect(body).toMatch(
      /if \(filters\.targetResourceId\) \{\s*conds\.push\(eq\(adminAuditLog\.targetResourceId, filters\.targetResourceId\)\);\s*\}/,
    );
  });

  it('Query: select * from adminAuditLog where (conds.length>0 ? and(...conds) : undefined) orderBy desc(timestamp) limit(filters.limit+1); same hasMore + slice + nextCursor=last.timestamp.toISOString() pattern as account-audit-repo', () => {
    expect(body).toMatch(
      /const rows = await this\.database\.db\s*\.select\(\)\s*\.from\(adminAuditLog\)\s*\.where\(conds\.length > 0 \? and\(\.\.\.conds\) : undefined\)\s*\.orderBy\(desc\(adminAuditLog\.timestamp\), desc\(adminAuditLog\.id\)\)\s*\.limit\(filters\.limit \+ 1\);/,
    );
    expect(body).toMatch(
      /const hasMore = rows\.length > filters\.limit;\s*const items = hasMore \? rows\.slice\(0, filters\.limit\) : rows;\s*const last = items\[items\.length - 1\];\s*return \{\s*items: items\.map\(toRow\),\s*nextCursor: hasMore && last \? last\.id : null,\s*\};/,
    );
  });

  it('toRow: 10-field (id + adminAccountId + adminKeyId + action + targetAccountId + targetResourceId + inputPayload + result + ipAddress + timestamp)', () => {
    expect(body).toMatch(
      /function toRow\(r: typeof adminAuditLog\.\$inferSelect\): AdminAuditLogRow \{\s*return \{\s*id: r\.id,\s*adminAccountId: r\.adminAccountId,\s*adminKeyId: r\.adminKeyId,\s*action: r\.action,\s*targetAccountId: r\.targetAccountId,\s*targetResourceId: r\.targetResourceId,\s*inputPayload: r\.inputPayload,\s*result: r\.result,\s*ipAddress: r\.ipAddress,\s*timestamp: r\.timestamp,\s*\};\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
