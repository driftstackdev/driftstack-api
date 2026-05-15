// W1007 — db/account-audit-repo V-216 + V-484 cross-source invariant.
// Three-hundred-thirty-third in the drift-guard series. Pins the
// apps/server/src/db/account-audit-repo.ts customer-side account
// audit repo primitive:
//
//   V-216 anchor — 'V-216 — Drizzle-backed AccountAuditRepo'.
//
//   DrizzleAccountAuditRepo 2-method surface — insert + list.
//
//   insert 9-field values shape — accountId + actorType +
//     actorAccountId??null + actorKeyId??null + action +
//     targetResourceId??null + payload??null + ipAddress??null +
//     userAgent??null.
//
//   insert defensive 'account_audit_log insert returned no row'.
//
//   list always-anchors on accountId (tenant-scoped) + 5 optional
//     filters:
//     - cursor (lt timestamp).
//     - action (eq).
//     - V-484 from (gte timestamp).
//     - V-484 to (lte timestamp).
//     - V-484 actorType (eq).
//     - V-484 targetResourceId (eq).
//
//   V-484 framing — 'V-484 — additional filters: from/to date range,
//     actor_type, target_resource_id (exact match)'.
//
//   list orderBy desc(timestamp) + limit+1 hasMore + ISO cursor.
//
//   toRow 11-field shape — id + accountId + actorType (as
//     AccountAuditActorType) + actorAccountId + actorKeyId + action
//     (as AccountAuditAction) + targetResourceId + payload ?? null +
//     ipAddress + userAgent + timestamp.
//
// stays in lockstep across apps/server/src/db/account-audit-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1007 db/account-audit-repo V-216 + V-484 cross-source invariant', () => {
  it("CRITICAL V-216 anchor — 'V-216 — Drizzle-backed AccountAuditRepo'. The customer-side audit-log mirror of the D-025 admin append-only repo.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/account-audit-repo.ts'));
    expect(p).toMatch(/\/\/ V-216 — Drizzle-backed AccountAuditRepo\./);
    expect(p).toMatch(/export class DrizzleAccountAuditRepo implements AccountAuditRepo \{/);
  });

  it('CRITICAL 2-method surface — insert + list.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/account-audit-repo.ts'));
    expect(p).toMatch(
      /async insert\(input: RecordAccountAuditInput\): Promise<AccountAuditEntryRow> \{/,
    );
    expect(p).toMatch(
      /async list\(accountId: string, opts: ListAccountAuditOpts\): Promise<ListAccountAuditPage> \{/,
    );
  });

  it('CRITICAL insert 9-field values — accountId + actorType + actorAccountId??null + actorKeyId??null + action + targetResourceId??null + payload??null + ipAddress??null + userAgent??null. The ??null normalization keeps NULL semantics consistent with schema.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/account-audit-repo.ts'));
    expect(p).toMatch(/accountId: input\.accountId,/);
    expect(p).toMatch(/actorType: input\.actorType,/);
    expect(p).toMatch(/actorAccountId: input\.actorAccountId \?\? null,/);
    expect(p).toMatch(/actorKeyId: input\.actorKeyId \?\? null,/);
    expect(p).toMatch(/action: input\.action,/);
    expect(p).toMatch(/targetResourceId: input\.targetResourceId \?\? null,/);
    expect(p).toMatch(/payload: input\.payload \?\? null,/);
    expect(p).toMatch(/ipAddress: input\.ipAddress \?\? null,/);
    expect(p).toMatch(/userAgent: input\.userAgent \?\? null,/);
    expect(p).toMatch(/if \(!row\) throw new Error\('account_audit_log insert returned no row'\);/);
  });

  it('CRITICAL list anchor on accountId tenant scope + 5 V-484 optional filters (cursor + action + from + to + actorType + targetResourceId).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/account-audit-repo.ts'));
    expect(p).toMatch(/const filters: SQL\[\] = \[eq\(accountAuditLog\.accountId, accountId\)\];/);
    expect(p).toMatch(
      /if \(cursorDate\) filters\.push\(lt\(accountAuditLog\.timestamp, cursorDate\)\);/,
    );
    expect(p).toMatch(
      /if \(opts\.action\) filters\.push\(eq\(accountAuditLog\.action, opts\.action\)\);/,
    );
    expect(p).toMatch(
      /if \(opts\.from\) filters\.push\(gte\(accountAuditLog\.timestamp, opts\.from\)\);/,
    );
    expect(p).toMatch(
      /if \(opts\.to\) filters\.push\(lte\(accountAuditLog\.timestamp, opts\.to\)\);/,
    );
    expect(p).toMatch(
      /if \(opts\.actorType\) filters\.push\(eq\(accountAuditLog\.actorType, opts\.actorType\)\);/,
    );
    expect(p).toMatch(/if \(opts\.targetResourceId\) \{/);
    expect(p).toMatch(
      /filters\.push\(eq\(accountAuditLog\.targetResourceId, opts\.targetResourceId\)\);/,
    );
  });

  it("CRITICAL V-484 framing — 'V-484 — additional filters: from/to date range, actor_type, target_resource_id (exact match)'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/account-audit-repo.ts'));
    expect(p).toMatch(/\/\/ V-484 — additional filters: from\/to date range, actor_type,/);
    expect(p).toMatch(/\/\/ target_resource_id \(exact match\)\./);
  });

  it('CRITICAL list orderBy desc(timestamp) + limit+1 hasMore + ISO cursor.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/account-audit-repo.ts'));
    expect(p).toMatch(/\.orderBy\(desc\(accountAuditLog\.timestamp\)\)/);
    expect(p).toMatch(/\.limit\(opts\.limit \+ 1\);/);
    expect(p).toMatch(/const hasMore = rows\.length > opts\.limit;/);
    expect(p).toMatch(/nextCursor: hasMore && last \? last\.timestamp\.toISOString\(\) : null,/);
  });

  it('CRITICAL toRow 11-field shape with actorType + action enum casts. payload ?? null normalization.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/account-audit-repo.ts'));
    expect(p).toMatch(
      /function toRow\(r: typeof accountAuditLog\.\$inferSelect\): AccountAuditEntryRow \{/,
    );
    expect(p).toMatch(/id: r\.id,/);
    expect(p).toMatch(/accountId: r\.accountId,/);
    expect(p).toMatch(/actorType: r\.actorType as AccountAuditActorType,/);
    expect(p).toMatch(/actorAccountId: r\.actorAccountId,/);
    expect(p).toMatch(/actorKeyId: r\.actorKeyId,/);
    expect(p).toMatch(/action: r\.action as AccountAuditAction,/);
    expect(p).toMatch(/targetResourceId: r\.targetResourceId,/);
    expect(p).toMatch(/payload: r\.payload \?\? null,/);
    expect(p).toMatch(/ipAddress: r\.ipAddress,/);
    expect(p).toMatch(/userAgent: r\.userAgent,/);
    expect(p).toMatch(/timestamp: r\.timestamp,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-account-audit-repo-v216-v484-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
