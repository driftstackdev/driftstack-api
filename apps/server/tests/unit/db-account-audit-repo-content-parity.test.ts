// W442.C — drift guard for apps/server/src/db/account-audit-repo.ts.
// V-216 customer-facing audit log + V-484 filter set. Drift here
// either drops the limit+1 fetch convention (cursor pagination loses
// the has-more signal; "Load more" disappears at the boundary) or
// breaks the desc(timestamp) order (audit list scrolls backwards
// through history in the wrong direction).
//
//   • V-216 framing pinned.
//   • insert(): 9-field values write (null-coalesce optional fields);
//     returning() destructure; throw on no-row.
//   • list(): limit+1 fetch → hasMore = rows.length > limit; slice
//     to opts.limit on hit; nextCursor = last.timestamp.toISOString().
//   • orderBy desc(timestamp) — newest first.
//   • Cursor decoded as Date from ISO string; pushes lt(timestamp,
//     cursor) into filters.
//   • V-484 filter set: from (gte) + to (lte) + actorType (eq) +
//     targetResourceId (eq).
//   • toRow cast actorType + action to V-216 union types.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/account-audit-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W442.C apps/server/src/db/account-audit-repo.ts content parity', () => {
  const body = read(LIB);

  it("V-216 framing pinned: 'Drizzle-backed AccountAuditRepo.'", () => {
    expect(body).toMatch(/\/\/ V-216 — Drizzle-backed AccountAuditRepo\./);
  });

  it('imports: SQL type + and/desc/eq/gte/lt/lte from drizzle-orm; AccountAuditAction + AccountAuditActorType from api-types; 5 service types; Database; accountAuditLog schema', () => {
    expect(body).toMatch(/import \{ type SQL, and, desc, eq, gte, lt, lte \} from 'drizzle-orm';/);
    expect(body).toMatch(
      /import type \{ AccountAuditAction, AccountAuditActorType \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(
      /import type \{\s*\n?\s*AccountAuditEntryRow,\s*\n?\s*AccountAuditRepo,\s*\n?\s*ListAccountAuditOpts,\s*\n?\s*ListAccountAuditPage,\s*\n?\s*RecordAccountAuditInput,\s*\n?\s*\} from '\.\.\/services\/account-audit\.js';/,
    );
    expect(body).toMatch(/import \{ accountAuditLog \} from '\.\/schema\.js';/);
  });

  it("insert(): 9-field values with null-coalesce on optional (actorAccountId/actorKeyId/targetResourceId/payload/ipAddress/userAgent) → returning(); throws 'account_audit_log insert returned no row' on empty", () => {
    expect(body).toMatch(
      /async insert\(input: RecordAccountAuditInput\): Promise<AccountAuditEntryRow> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.insert\(accountAuditLog\)\s*\n?\s*\.values\(\{\s*\n?\s*accountId: input\.accountId,\s*\n?\s*actorType: input\.actorType,\s*\n?\s*actorAccountId: input\.actorAccountId \?\? null,\s*\n?\s*actorKeyId: input\.actorKeyId \?\? null,\s*\n?\s*action: input\.action,\s*\n?\s*targetResourceId: input\.targetResourceId \?\? null,\s*\n?\s*payload: input\.payload \?\? null,\s*\n?\s*ipAddress: input\.ipAddress \?\? null,\s*\n?\s*userAgent: input\.userAgent \?\? null,\s*\n?\s*\}\)\s*\n?\s*\.returning\(\);\s*\n?\s*if \(!row\) throw new Error\('account_audit_log insert returned no row'\);\s*\n?\s*return toRow\(row\);\s*\n?\s*\}/,
    );
  });

  it('list(): cursor decoded as Date from ISO string; filters seeded with eq(accountId); cursor pushes lt(timestamp); action pushes eq(action)', () => {
    expect(body).toMatch(
      /const cursorDate = opts\.cursor \? new Date\(opts\.cursor\) : null;\s*\n?\s*const filters: SQL\[\] = \[eq\(accountAuditLog\.accountId, accountId\)\];\s*\n?\s*if \(cursorDate\) filters\.push\(lt\(accountAuditLog\.timestamp, cursorDate\)\);\s*\n?\s*if \(opts\.action\) filters\.push\(eq\(accountAuditLog\.action, opts\.action\)\);/,
    );
  });

  it("V-484 filter framing pinned: 'additional filters: from/to date range, actor_type, target_resource_id (exact match)'; from→gte, to→lte, actorType→eq, targetResourceId→eq", () => {
    expect(body).toMatch(
      /\/\/ V-484 — additional filters: from\/to date range, actor_type,\s*\n?\s*\/\/ target_resource_id \(exact match\)\./,
    );
    expect(body).toMatch(
      /if \(opts\.from\) filters\.push\(gte\(accountAuditLog\.timestamp, opts\.from\)\);\s*\n?\s*if \(opts\.to\) filters\.push\(lte\(accountAuditLog\.timestamp, opts\.to\)\);\s*\n?\s*if \(opts\.actorType\) filters\.push\(eq\(accountAuditLog\.actorType, opts\.actorType\)\);\s*\n?\s*if \(opts\.targetResourceId\) \{\s*\n?\s*filters\.push\(eq\(accountAuditLog\.targetResourceId, opts\.targetResourceId\)\);\s*\n?\s*\}/,
    );
  });

  it('Query: select * from accountAuditLog where and(...filters) order by desc(timestamp) limit(opts.limit+1); hasMore = rows.length > opts.limit; items = slice(0, opts.limit) on hasMore else rows; nextCursor = last.timestamp.toISOString() on hasMore else null', () => {
    expect(body).toMatch(
      /const rows = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(accountAuditLog\)\s*\n?\s*\.where\(and\(\.\.\.filters\)\)\s*\n?\s*\.orderBy\(desc\(accountAuditLog\.timestamp\)\)\s*\n?\s*\.limit\(opts\.limit \+ 1\);/,
    );
    expect(body).toMatch(
      /const hasMore = rows\.length > opts\.limit;\s*\n?\s*const items = hasMore \? rows\.slice\(0, opts\.limit\) : rows;\s*\n?\s*const last = items\[items\.length - 1\];\s*\n?\s*return \{\s*\n?\s*items: items\.map\(toRow\),\s*\n?\s*nextCursor: hasMore && last \? last\.timestamp\.toISOString\(\) : null,\s*\n?\s*\};/,
    );
  });

  it('toRow: cast actorType as AccountAuditActorType + action as AccountAuditAction; payload null-coalesce; all 11 fields', () => {
    expect(body).toMatch(
      /function toRow\(r: typeof accountAuditLog\.\$inferSelect\): AccountAuditEntryRow \{\s*\n?\s*return \{\s*\n?\s*id: r\.id,\s*\n?\s*accountId: r\.accountId,\s*\n?\s*actorType: r\.actorType as AccountAuditActorType,\s*\n?\s*actorAccountId: r\.actorAccountId,\s*\n?\s*actorKeyId: r\.actorKeyId,\s*\n?\s*action: r\.action as AccountAuditAction,\s*\n?\s*targetResourceId: r\.targetResourceId,\s*\n?\s*payload: r\.payload \?\? null,\s*\n?\s*ipAddress: r\.ipAddress,\s*\n?\s*userAgent: r\.userAgent,\s*\n?\s*timestamp: r\.timestamp,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
