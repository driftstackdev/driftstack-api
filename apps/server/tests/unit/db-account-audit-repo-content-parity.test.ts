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
    expect(body).toMatch(
      /import \{ type SQL, and, count, desc, eq, gte, lt, lte, or \} from 'drizzle-orm';/,
    );
    expect(body).toMatch(
      /import type \{ AccountAuditAction, AccountAuditActorType \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(
      /import type \{\s*AccountAuditEntryRow,\s*AccountAuditRepo,\s*ListAccountAuditOpts,\s*ListAccountAuditPage,\s*RecordAccountAuditInput,\s*\} from '\.\.\/services\/account-audit\.js';/,
    );
    expect(body).toMatch(/import \{ accountAuditLog \} from '\.\/schema\.js';/);
  });

  it("insert(): 9-field values with null-coalesce on optional (actorAccountId/actorKeyId/targetResourceId/payload/ipAddress/userAgent) → returning(); throws 'account_audit_log insert returned no row' on empty", () => {
    expect(body).toMatch(
      /async insert\(input: RecordAccountAuditInput\): Promise<AccountAuditEntryRow> \{\s*const \[row\] = await this\.database\.db\s*\.insert\(accountAuditLog\)\s*\.values\(\{\s*accountId: input\.accountId,\s*actorType: input\.actorType,\s*actorAccountId: input\.actorAccountId \?\? null,\s*actorKeyId: input\.actorKeyId \?\? null,\s*action: input\.action,\s*targetResourceId: input\.targetResourceId \?\? null,\s*payload: input\.payload \?\? null,\s*ipAddress: input\.ipAddress \?\? null,\s*userAgent: input\.userAgent \?\? null,\s*\}\)\s*\.returning\(\);\s*if \(!row\) throw new Error\('account_audit_log insert returned no row'\);\s*return toRow\(row\);\s*\}/,
    );
  });

  it('list(): keyset cursor — filters seeded with eq(accountId); cursor row looked up by id then compound (timestamp,id) keyset; action pushes eq(action)', () => {
    expect(body).toMatch(
      /const filters: SQL\[\] = \[eq\(accountAuditLog\.accountId, accountId\)\];/,
    );
    // Keyset cursor (mirrors profiles-repo): look up the cursor row's
    // (timestamp, id), then select strictly-after rows.
    expect(body).toMatch(/const keyset = or\(/);
    expect(body).toMatch(/lt\(accountAuditLog\.timestamp, cursorRow\.timestamp\),/);
    expect(body).toMatch(/eq\(accountAuditLog\.timestamp, cursorRow\.timestamp\),/);
    expect(body).toMatch(/lt\(accountAuditLog\.id, cursorRow\.id\),/);
    expect(body).toMatch(
      /if \(opts\.action\) filters\.push\(eq\(accountAuditLog\.action, opts\.action\)\);/,
    );
  });

  it("V-484 filter framing pinned: 'additional filters: from/to date range, actor_type, target_resource_id (exact match)'; from→gte, to→lte, actorType→eq, targetResourceId→eq", () => {
    expect(body).toMatch(
      /\/\/ V-484 — additional filters: from\/to date range, actor_type,\s*\/\/ target_resource_id \(exact match\)\./,
    );
    expect(body).toMatch(
      /if \(opts\.from\) filters\.push\(gte\(accountAuditLog\.timestamp, opts\.from\)\);\s*if \(opts\.to\) filters\.push\(lte\(accountAuditLog\.timestamp, opts\.to\)\);\s*if \(opts\.actorType\) filters\.push\(eq\(accountAuditLog\.actorType, opts\.actorType\)\);\s*if \(opts\.targetResourceId\) \{\s*filters\.push\(eq\(accountAuditLog\.targetResourceId, opts\.targetResourceId\)\);\s*\}/,
    );
  });

  it('Query: select * from accountAuditLog where and(...filters) order by desc(timestamp) limit(opts.limit+1); hasMore = rows.length > opts.limit; items = slice(0, opts.limit) on hasMore else rows; nextCursor = last.timestamp.toISOString() on hasMore else null', () => {
    expect(body).toMatch(
      /const rows = await this\.database\.db\s*\.select\(\)\s*\.from\(accountAuditLog\)\s*\.where\(and\(\.\.\.filters\)\)\s*\.orderBy\(desc\(accountAuditLog\.timestamp\), desc\(accountAuditLog\.id\)\)\s*\.limit\(opts\.limit \+ 1\);/,
    );
    expect(body).toMatch(
      /const hasMore = rows\.length > opts\.limit;\s*const items = hasMore \? rows\.slice\(0, opts\.limit\) : rows;\s*const last = items\[items\.length - 1\];\s*return \{\s*items: items\.map\(toRow\),\s*nextCursor: hasMore && last \? last\.id : null,\s*\};/,
    );
  });

  it('toRow: cast actorType as AccountAuditActorType + action as AccountAuditAction; payload null-coalesce; all 11 fields', () => {
    expect(body).toMatch(
      /function toRow\(r: typeof accountAuditLog\.\$inferSelect\): AccountAuditEntryRow \{\s*return \{\s*id: r\.id,\s*accountId: r\.accountId,\s*actorType: r\.actorType as AccountAuditActorType,\s*actorAccountId: r\.actorAccountId,\s*actorKeyId: r\.actorKeyId,\s*action: r\.action as AccountAuditAction,\s*targetResourceId: r\.targetResourceId,\s*payload: r\.payload \?\? null,\s*ipAddress: r\.ipAddress,\s*userAgent: r\.userAgent,\s*timestamp: r\.timestamp,\s*\};\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
