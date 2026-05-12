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
      /\/\/ Insert \+ paginated list only\. No update, no delete — see D-025 for\s*\n?\s*\/\/ the append-only invariant\./,
    );
  });

  it('imports: and/desc/eq/gte/lt from drizzle-orm; 5 service types; Database; adminAuditLog schema', () => {
    expect(body).toMatch(/import \{ and, desc, eq, gte, lt \} from 'drizzle-orm';/);
    expect(body).toMatch(
      /import type \{\s*\n?\s*AdminAuditLogRepo,\s*\n?\s*AdminAuditLogRow,\s*\n?\s*ListAuditFilters,\s*\n?\s*ListAuditPage,\s*\n?\s*NewAdminAuditLogInput,\s*\n?\s*\} from '\.\.\/services\/admin-audit\.js';/,
    );
    expect(body).toMatch(/import \{ adminAuditLog \} from '\.\/schema\.js';/);
  });

  it("insert(): 8-field values (adminAccountId + adminKeyId + action + targetAccountId nullable + targetResourceId nullable + inputPayload nullable + result + ipAddress nullable); returning(); throws 'admin_audit_log insert returned no row' on empty", () => {
    expect(body).toMatch(
      /async insert\(input: NewAdminAuditLogInput\): Promise<AdminAuditLogRow> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.insert\(adminAuditLog\)\s*\n?\s*\.values\(\{\s*\n?\s*adminAccountId: input\.adminAccountId,\s*\n?\s*adminKeyId: input\.adminKeyId,\s*\n?\s*action: input\.action,\s*\n?\s*targetAccountId: input\.targetAccountId \?\? null,\s*\n?\s*targetResourceId: input\.targetResourceId \?\? null,\s*\n?\s*inputPayload: input\.inputPayload \?\? null,\s*\n?\s*result: input\.result,\s*\n?\s*ipAddress: input\.ipAddress \?\? null,\s*\n?\s*\}\)\s*\n?\s*\.returning\(\);\s*\n?\s*if \(!row\) throw new Error\('admin_audit_log insert returned no row'\);\s*\n?\s*return toRow\(row\);\s*\n?\s*\}/,
    );
  });

  it('list() filters: adminAccountId eq + targetAccountId eq + action eq + from gte + to lt + V-521 targetResourceId eq + cursor lt new Date(cursor)', () => {
    expect(body).toMatch(
      /if \(filters\.adminAccountId\) \{\s*\n?\s*conds\.push\(eq\(adminAuditLog\.adminAccountId, filters\.adminAccountId\)\);\s*\n?\s*\}\s*\n?\s*if \(filters\.targetAccountId\) \{\s*\n?\s*conds\.push\(eq\(adminAuditLog\.targetAccountId, filters\.targetAccountId\)\);\s*\n?\s*\}\s*\n?\s*if \(filters\.action\) conds\.push\(eq\(adminAuditLog\.action, filters\.action\)\);\s*\n?\s*if \(filters\.from\) conds\.push\(gte\(adminAuditLog\.timestamp, filters\.from\)\);\s*\n?\s*if \(filters\.to\) conds\.push\(lt\(adminAuditLog\.timestamp, filters\.to\)\);/,
    );
    expect(body).toMatch(
      /if \(filters\.cursor\) conds\.push\(lt\(adminAuditLog\.timestamp, new Date\(filters\.cursor\)\)\);/,
    );
  });

  it("V-521 framing pinned: 'drill-down by resource id (parity with V-484 customer-side filter)' + targetResourceId eq filter", () => {
    expect(body).toMatch(
      /\/\/ V-521 — drill-down by resource id \(parity with V-484\s*\n?\s*\/\/ customer-side filter\)\./,
    );
    expect(body).toMatch(
      /if \(filters\.targetResourceId\) \{\s*\n?\s*conds\.push\(eq\(adminAuditLog\.targetResourceId, filters\.targetResourceId\)\);\s*\n?\s*\}/,
    );
  });

  it('Query: select * from adminAuditLog where (conds.length>0 ? and(...conds) : undefined) orderBy desc(timestamp) limit(filters.limit+1); same hasMore + slice + nextCursor=last.timestamp.toISOString() pattern as account-audit-repo', () => {
    expect(body).toMatch(
      /const rows = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(adminAuditLog\)\s*\n?\s*\.where\(conds\.length > 0 \? and\(\.\.\.conds\) : undefined\)\s*\n?\s*\.orderBy\(desc\(adminAuditLog\.timestamp\)\)\s*\n?\s*\.limit\(filters\.limit \+ 1\);/,
    );
    expect(body).toMatch(
      /const hasMore = rows\.length > filters\.limit;\s*\n?\s*const items = hasMore \? rows\.slice\(0, filters\.limit\) : rows;\s*\n?\s*const last = items\[items\.length - 1\];\s*\n?\s*return \{\s*\n?\s*items: items\.map\(toRow\),\s*\n?\s*nextCursor: hasMore && last \? last\.timestamp\.toISOString\(\) : null,\s*\n?\s*\};/,
    );
  });

  it('toRow: 10-field (id + adminAccountId + adminKeyId + action + targetAccountId + targetResourceId + inputPayload + result + ipAddress + timestamp)', () => {
    expect(body).toMatch(
      /function toRow\(r: typeof adminAuditLog\.\$inferSelect\): AdminAuditLogRow \{\s*\n?\s*return \{\s*\n?\s*id: r\.id,\s*\n?\s*adminAccountId: r\.adminAccountId,\s*\n?\s*adminKeyId: r\.adminKeyId,\s*\n?\s*action: r\.action,\s*\n?\s*targetAccountId: r\.targetAccountId,\s*\n?\s*targetResourceId: r\.targetResourceId,\s*\n?\s*inputPayload: r\.inputPayload,\s*\n?\s*result: r\.result,\s*\n?\s*ipAddress: r\.ipAddress,\s*\n?\s*timestamp: r\.timestamp,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
