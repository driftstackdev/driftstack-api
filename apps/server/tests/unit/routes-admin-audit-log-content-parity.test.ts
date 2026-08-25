// W415.B — drift guard for apps/server/src/routes/admin-audit-log.ts.
// Admin audit-log query. Read-only — auditing the read would recurse
// forever. V-521 drill-down by target_resource_id (parity with V-484
// customer-side filter). Drift here either drops the no-audit-on-read
// rule (every admin GUI page-view doubles the audit table) or breaks
// the public-id prefix mapping (admin/key/account drill-downs break).
//
//   • Framing pinned: GET /v1/admin/audit-log; read-only — no audit
//     row written for the read itself (audits would recurse forever).
//   • Auth: requireScope('driftstack_internal_admin') preHandler +
//     redundant throwIfMissingScope inside handler (defense-in-depth).
//   • Query schema from @driftstack/api-types
//     (ListAuditLogQuerySchema + ListAuditLogQueryInput types).
//   • maybeUuidFromInput: accept raw UUID OR prefixed id; case-
//     strict dashed-UUID check (V-1565); BadRequestError on neither.
//   • publicEntry: id pass-through + admin_account_id=acc_ +
//     admin_key_id=key_ + target_account_id nullable acc_ +
//     target_resource_id pass-through + ISO timestamp.
//   • V-521 framing pinned: drill-down by target_resource_id (parity
//     with V-484 customer-side filter).
//   • Service args: spread-conditional for adminAccountId +
//     targetAccountId + action + from/to (Date wrap) + cursor +
//     targetResourceId; limit always included.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/admin-audit-log.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W415.B apps/server/src/routes/admin-audit-log.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: GET /v1/admin/audit-log; read-only — audits-would-recurse-forever rationale', () => {
    expect(body).toMatch(/Admin audit-log query route\./);
    expect(body).toMatch(
      /Read-only — no audit row written for the read itself \(audits would\s*\/\/\s*recurse forever\)\. The route validates the admin scope, parses\s*\/\/\s*filters, paginates by timestamp DESC, and returns the page\./,
    );
  });

  it('Defense-in-depth: requireScope preHandler + throwIfMissingScope(ctx, "driftstack_internal_admin") inside handler', () => {
    expect(body).toMatch(
      /preHandler: \[app\.requireScope\('driftstack_internal_admin'\), app\.rateLimit\('global'\)\],/,
    );
    expect(body).toMatch(/throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);/);
  });

  it('Query schema sourced from @driftstack/api-types: ListAuditLogQuerySchema + ListAuditLogQueryInput type', () => {
    expect(body).toMatch(
      /import \{ ListAuditLogQuerySchema, type ListAuditLogQueryInput \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(
      /const rawQuery = \(request\.query \?\? \{\}\) as ListAuditLogQueryInput;\s*const query = ListAuditLogQuerySchema\.parse\(rawQuery\);/,
    );
  });

  it('maybeUuidFromInput: accept 36-char raw uuid (regex test) OR prefixed id via PUBLIC_ID_RE; BadRequestError with value-quoted hint', () => {
    expect(body).toMatch(
      // V-1565 — the raw-UUID branch was a hex-or-dash class of length 36, which
      // admitted 36 hex digits with no dashes and 36 dashes, then handed them to
      // a Postgres uuid column as an `admin_id` / `target_id` filter: a 500 where
      // the boundary owes a 400. It now reuses CURSOR_UUID_RE, the strict dashed
      // shape this file already declares for the cursor and for the same reason.
      // The doc comment moved to a block explaining that, so the pin anchors on
      // the branch rather than on the one-line comment above it.
      /function maybeUuidFromInput\(value: string \| undefined\): string \| undefined \{\s*if \(value === undefined\) return undefined;\s*if \(CURSOR_UUID_RE\.test\(value\)\) return value;\s*const match = PUBLIC_ID_RE\.exec\(value\);\s*if \(!match \|\| !match\[1\]\) \{\s*throw new BadRequestError\(`Invalid id "\$\{value\}"\. Expected a UUID or prefixed id\.`\);/,
    );
  });

  it('publicEntry: id pass-through + admin_account_id=acc_ + admin_key_id=key_ + target_account_id nullable acc_ + ISO timestamp', () => {
    expect(body).toMatch(
      /function publicEntry\(row: AdminAuditLogRow\): Record<string, unknown> \{/,
    );
    expect(body).toMatch(/id: row\.id,/);
    expect(body).toMatch(/admin_account_id: `acc_\$\{row\.adminAccountId\}`,/);
    expect(body).toMatch(/admin_key_id: `key_\$\{row\.adminKeyId\}`,/);
    expect(body).toMatch(
      /target_account_id: row\.targetAccountId \? `acc_\$\{row\.targetAccountId\}` : null,/,
    );
    expect(body).toMatch(/target_resource_id: row\.targetResourceId,/);
    expect(body).toMatch(/input_payload: row\.inputPayload,/);
    expect(body).toMatch(/result: row\.result,/);
    expect(body).toMatch(/ip_address: row\.ipAddress,/);
    expect(body).toMatch(/timestamp: row\.timestamp\.toISOString\(\),/);
  });

  it('V-521 framing pinned: drill-down by target_resource_id (parity with V-484 customer-side filter)', () => {
    expect(body).toMatch(
      /\/\/ V-521 — drill-down by resource id \(parity with V-484\s*\/\/ customer-side filter\)\./,
    );
    expect(body).toMatch(
      /\.\.\.\(query\.target_resource_id !== undefined\s*\? \{ targetResourceId: query\.target_resource_id \}\s*: \{\}\),/,
    );
  });

  it('Service args: spread-conditional for adminAccountId + targetAccountId + action + from/to (new Date wrap) + cursor', () => {
    expect(body).toMatch(/const adminUuid = maybeUuidFromInput\(query\.admin_id\);/);
    expect(body).toMatch(/const targetUuid = maybeUuidFromInput\(query\.target_id\);/);
    expect(body).toMatch(
      /\.\.\.\(adminUuid !== undefined \? \{ adminAccountId: adminUuid \} : \{\}\),/,
    );
    expect(body).toMatch(
      /\.\.\.\(targetUuid !== undefined \? \{ targetAccountId: targetUuid \} : \{\}\),/,
    );
    expect(body).toMatch(
      /\.\.\.\(query\.action !== undefined \? \{ action: query\.action \} : \{\}\),/,
    );
    expect(body).toMatch(
      /\.\.\.\(query\.from !== undefined \? \{ from: new Date\(query\.from\) \} : \{\}\),/,
    );
    expect(body).toMatch(
      /\.\.\.\(query\.to !== undefined \? \{ to: new Date\(query\.to\) \} : \{\}\),/,
    );
    expect(body).toMatch(/limit: query\.limit,/);
    expect(body).toMatch(
      /\.\.\.\(query\.cursor !== undefined \? \{ cursor: query\.cursor \} : \{\}\),/,
    );
  });

  it('Reply shape: { data: page.items.map(publicEntry), next_cursor: page.nextCursor }', () => {
    expect(body).toMatch(
      /return \{\s*data: page\.items\.map\(publicEntry\),\s*next_cursor: page\.nextCursor,\s*\};/,
    );
  });

  it('imports: FastifyInstance + AdminAuditLogRow/AdminAuditService + requireScope-aliased + BadRequestError', () => {
    expect(body).toMatch(/import type \{ FastifyInstance \} from 'fastify';/);
    expect(body).toMatch(
      /import type \{ AdminAuditLogRow, AdminAuditService \} from '\.\.\/services\/admin-audit\.js';/,
    );
    expect(body).toMatch(
      /import \{ requireScope as throwIfMissingScope \} from '\.\.\/lib\/errors-helpers\.js';/,
    );
    expect(body).toMatch(/import \{ BadRequestError \} from '\.\.\/lib\/errors\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
