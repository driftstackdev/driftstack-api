// W1027 — routes/admin-audit-log V-484 + V-521 cross-source invariant.
// Three-hundred-fifty-third in the drift-guard series. Pins the apps/
// server/src/routes/admin-audit-log.ts admin audit-log query route:
//
//   Header — 'Admin audit-log query route. Read-only — no audit row
//   written for the read itself (audits would recurse forever). The
//   route validates the admin scope, parses filters, paginates by
//   timestamp DESC, and returns the page'.
//
//   PUBLIC_ID_RE — same regex as admin-api-keys (prefix_uuid format).
//
//   maybeUuidFromInput — 'Accept either a raw UUID or a prefixed id;
//   return the UUID'. Branch: strict dashed-UUID shape → raw (V-1565);
//   else PUBLIC_ID_RE match else BadRequestError.
//
//   throwIfMissingScope(ctx, 'driftstack_internal_admin') belt-and-
//   braces (preHandler also covers).
//
//   ListAuditLogQuerySchema (api-types) wraps query.
//
//   8 service.list filters — adminAccountId + targetAccountId +
//     action + from (new Date()) + to (new Date()) + V-521
//     targetResourceId + limit + cursor.
//
//   V-521 framing — 'V-521 — drill-down by resource id (parity with
//   V-484 customer-side filter)'.
//
//   publicEntry 10-field response — id + admin_account_id (acc_
//     prefix) + admin_key_id (key_ prefix) + action + nullable
//     target_account_id (acc_ prefix) + target_resource_id +
//     input_payload + result + ip_address + timestamp (ISO).
//
// stays in lockstep across apps/server/src/routes/admin-audit-log.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1027 routes/admin-audit-log V-484 + V-521 cross-source invariant', () => {
  it("CRITICAL header — 'Admin audit-log query route. Read-only — no audit row written for the read itself (audits would recurse forever)'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-audit-log.ts'));
    expect(p).toMatch(/\/\/ Admin audit-log query route\./);
    expect(p).toMatch(/\/\/ Read-only — no audit row written for the read itself \(audits would/);
    expect(p).toMatch(/\/\/ recurse forever\)\. The route validates the admin scope, parses/);
    expect(p).toMatch(/\/\/ filters, paginates by timestamp DESC, and returns the page\./);
  });

  it("CRITICAL maybeUuidFromInput — 'Accept either a raw UUID or a prefixed id; return the UUID'. 2-branch (36-char hex-uuid regex OR prefix-extract).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-audit-log.ts'));
    expect(p).toMatch(/\/\*\* Accept either a raw UUID or a prefixed id; return the UUID\. \*\//);
    expect(p).toMatch(
      /function maybeUuidFromInput\(value: string \| undefined\): string \| undefined \{/,
    );
    expect(p).toMatch(/if \(value === undefined\) return undefined;/);
    expect(p).toMatch(
      // V-1565 — was a hex-or-dash class of length 36, which is not a UUID shape:
      // it admitted dash-less hex and an all-dash string, and both reached a
      // Postgres uuid column as a query filter, answering 500 instead of 400.
      // Now the strict dashed shape already declared in this route for the cursor.
      /if \(CURSOR_UUID_RE\.test\(value\)\) return value;/,
    );
    expect(p).toMatch(
      /throw new BadRequestError\(`Invalid id "\$\{value\}"\. Expected a UUID or prefixed id\.`\);/,
    );
  });

  it("CRITICAL throwIfMissingScope(ctx, 'driftstack_internal_admin') belt-and-braces inside handler.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-audit-log.ts'));
    expect(p).toMatch(
      /import \{ requireScope as throwIfMissingScope \} from '\.\.\/lib\/errors-helpers\.js';/,
    );
    expect(p).toMatch(/throwIfMissingScope\(ctx, 'driftstack_internal_admin'\);/);
  });

  it('CRITICAL service.list 7 filter fields — adminAccountId + targetAccountId + action + from (new Date()) + to (new Date()) + V-521 targetResourceId + limit + cursor.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-audit-log.ts'));
    expect(p).toMatch(
      /\.\.\.\(adminUuid !== undefined \? \{ adminAccountId: adminUuid \} : \{\}\),/,
    );
    expect(p).toMatch(
      /\.\.\.\(targetUuid !== undefined \? \{ targetAccountId: targetUuid \} : \{\}\),/,
    );
    expect(p).toMatch(
      /\.\.\.\(query\.action !== undefined \? \{ action: query\.action \} : \{\}\),/,
    );
    expect(p).toMatch(
      /\.\.\.\(query\.from !== undefined \? \{ from: new Date\(query\.from\) \} : \{\}\),/,
    );
    expect(p).toMatch(
      /\.\.\.\(query\.to !== undefined \? \{ to: new Date\(query\.to\) \} : \{\}\),/,
    );
    expect(p).toMatch(/\.\.\.\(query\.target_resource_id !== undefined/);
    expect(p).toMatch(/\? \{ targetResourceId: query\.target_resource_id \}/);
    expect(p).toMatch(/limit: query\.limit,/);
    expect(p).toMatch(
      /\.\.\.\(query\.cursor !== undefined \? \{ cursor: query\.cursor \} : \{\}\),/,
    );
  });

  it("CRITICAL V-521 framing — 'V-521 — drill-down by resource id (parity with V-484 customer-side filter)'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-audit-log.ts'));
    expect(p).toMatch(/\/\/ V-521 — drill-down by resource id \(parity with V-484/);
    expect(p).toMatch(/\/\/ customer-side filter\)\./);
  });

  it('CRITICAL publicEntry 10-field shape — id + admin_account_id (acc_ prefix) + admin_key_id (key_ prefix) + action + nullable target_account_id (acc_ prefix) + target_resource_id + input_payload + result + ip_address + timestamp ISO.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-audit-log.ts'));
    expect(p).toMatch(/id: row\.id,/);
    expect(p).toMatch(/admin_account_id: `acc_\$\{row\.adminAccountId\}`,/);
    expect(p).toMatch(/admin_key_id: `key_\$\{row\.adminKeyId\}`,/);
    expect(p).toMatch(/action: row\.action,/);
    expect(p).toMatch(
      /target_account_id: row\.targetAccountId \? `acc_\$\{row\.targetAccountId\}` : null,/,
    );
    expect(p).toMatch(/target_resource_id: row\.targetResourceId,/);
    expect(p).toMatch(/input_payload: row\.inputPayload,/);
    expect(p).toMatch(/result: row\.result,/);
    expect(p).toMatch(/ip_address: row\.ipAddress,/);
    expect(p).toMatch(/timestamp: row\.timestamp\.toISOString\(\),/);
  });

  it("CRITICAL preHandler [requireScope('driftstack_internal_admin'), rateLimit('global')] + response { data, next_cursor }.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-audit-log.ts'));
    expect(p).toMatch(
      /preHandler: \[app\.requireScope\('driftstack_internal_admin'\), app\.rateLimit\('global'\)\],/,
    );
    expect(p).toMatch(/data: page\.items\.map\(publicEntry\),/);
    expect(p).toMatch(/next_cursor: page\.nextCursor,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-admin-audit-log-v484-v521-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
