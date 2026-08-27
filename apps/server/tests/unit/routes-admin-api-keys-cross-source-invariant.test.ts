// W1026 — routes/admin-api-keys cross-source invariant. Three-hundred-
// fifty-second in the drift-guard series. Pins the apps/server/src/
// routes/admin-api-keys.ts admin cross-account API-key list:
//
//   Header — 'Admin-only cross-account API key list — GET /v1/admin/
//   api-keys. Read-only; no audit row written for the read. Revoke
//   action lives in admin-force-actions.ts (POST /v1/admin/api-keys/
//   :id/revoke)'.
//
//   PUBLIC_ID_RE — /^[a-z]{3}_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-
//     [0-9a-f]{4}-[0-9a-f]{12})$/. Validates 'prefix_uuid' format.
//
//   uuidFromPrefixedId(value, expectedPrefix) — extracts uuid +
//     defensive prefix check; BadRequestError on mismatch.
//
//   ListAdminApiKeysQuerySchema 4 filters — limit (int 1-100, default
//     50) + cursor (optional) + account_id (optional, accepts uuid or
//     acc_ prefixed) + revoked (enum 'true'/'false').
//
//   account_id branch — when length===36 use as-is else
//     uuidFromPrefixedId(.., 'acc').
//
//   revoked branch — 'true' → true, 'false' → false, undefined →
//     undefined (no filter).
//
//   publicAdminApiKey mapper — prefixed ids (key_ + acc_) +
//     ISO-stringified nullable timestamps + 9-field shape.
//
//   preHandler [requireScope('driftstack_internal_admin'), rateLimit
//     ('global')].
//
//   Response — { data: items.map(publicAdminApiKey), next_cursor }.
//
// stays in lockstep across apps/server/src/routes/admin-api-keys.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1026 routes/admin-api-keys cross-source invariant', () => {
  it("CRITICAL header — 'Admin-only cross-account API key list — GET /v1/admin/api-keys. Read-only; no audit row written for the read. Revoke action lives in admin-force-actions.ts (POST /v1/admin/api-keys/:id/revoke)'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-api-keys.ts'));
    expect(p).toMatch(/\/\/ Admin-only cross-account API key list — GET \/v1\/admin\/api-keys\./);
    expect(p).toMatch(/\/\/ Read-only; no audit row written for the read\. Revoke action lives/);
    expect(p).toMatch(
      /\/\/ in admin-force-actions\.ts \(POST \/v1\/admin\/api-keys\/:id\/revoke\)\./,
    );
  });

  it("CRITICAL PUBLIC_ID_RE — '/^[a-z]{3}_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/' validates 'prefix_uuid' format.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-api-keys.ts'));
    expect(p).toMatch(
      /const PUBLIC_ID_RE = \/\^\[a-z\]\{3\}_\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)\$\/;/,
    );
  });

  it('CRITICAL uuidFromPrefixedId — extracts UUID + defensive prefix check + BadRequestError on mismatch.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-api-keys.ts'));
    expect(p).toMatch(
      /function uuidFromPrefixedId\(value: string, expectedPrefix: string\): string \{/,
    );
    expect(p).toMatch(
      /if \(!match \|\| !match\[1\] \|\| !value\.startsWith\(`\$\{expectedPrefix\}_`\)\) \{/,
    );
    expect(p).toMatch(
      /throw new BadRequestError\(`Invalid id format\. Expected "\$\{expectedPrefix\}_<uuid>"\.`\);/,
    );
  });

  it('CRITICAL ListAdminApiKeysQuerySchema 4 filters — limit (int 1-100 default 50) + cursor + account_id + revoked enum.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-api-keys.ts'));
    expect(p).toMatch(
      /limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.default\(50\),/,
    );
    expect(p).toMatch(/cursor: z\.string\(\)\.min\(1\)\.max\(512\)\.optional\(\),/);
    expect(p).toMatch(/account_id: z\.string\(\)\.min\(1\)\.max\(100\)\.optional\(\),/);
    expect(p).toMatch(/revoked: z\.enum\(\['true', 'false'\]\)\.optional\(\),/);
  });

  it("CRITICAL account_id 2-branch — length===36 use raw uuid else uuidFromPrefixedId(.., 'acc').", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-api-keys.ts'));
    expect(p).toMatch(/const accountUuid =/);
    expect(p).toMatch(/parsed\.data\.account_id !== undefined/);
    expect(p).toMatch(/\? BARE_UUID_RE\.test\(parsed\.data\.account_id\)/);
    expect(p).toMatch(/\? parsed\.data\.account_id/);
    expect(p).toMatch(/: uuidFromPrefixedId\(parsed\.data\.account_id, 'acc'\)/);
    expect(p).toMatch(/: undefined;/);
  });

  it("CRITICAL revoked 3-branch — 'true' → true, 'false' → false, undefined → undefined.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-api-keys.ts'));
    expect(p).toMatch(/const revoked =/);
    expect(p).toMatch(
      /parsed\.data\.revoked === undefined \? undefined : parsed\.data\.revoked === 'true';/,
    );
  });

  it('CRITICAL publicAdminApiKey 9-field mapper — id (key_ prefix) + account_id (acc_ prefix) + name + key_prefix + scopes + ISO-stringified nullable lastUsedAt + revokedAt + expiresAt + createdAt.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-api-keys.ts'));
    expect(p).toMatch(/id: `key_\$\{row\.id\}`,/);
    expect(p).toMatch(/account_id: `acc_\$\{row\.accountId\}`,/);
    expect(p).toMatch(/name: row\.name,/);
    expect(p).toMatch(/key_prefix: row\.keyPrefix,/);
    expect(p).toMatch(/scopes: row\.scopes,/);
    expect(p).toMatch(/last_used_at: row\.lastUsedAt \? row\.lastUsedAt\.toISOString\(\) : null,/);
    expect(p).toMatch(/revoked_at: row\.revokedAt \? row\.revokedAt\.toISOString\(\) : null,/);
    expect(p).toMatch(/expires_at: row\.expiresAt \? row\.expiresAt\.toISOString\(\) : null,/);
    expect(p).toMatch(/created_at: row\.createdAt\.toISOString\(\),/);
  });

  it("CRITICAL preHandler [requireScope('driftstack_internal_admin'), rateLimit('global')] + response { data: items.map(publicAdminApiKey), next_cursor }.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-api-keys.ts'));
    expect(p).toMatch(
      /preHandler: \[app\.requireScope\('driftstack_internal_admin'\), app\.rateLimit\('global'\)\],/,
    );
    expect(p).toMatch(/data: page\.items\.map\(publicAdminApiKey\),/);
    expect(p).toMatch(/next_cursor: page\.nextCursor,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-admin-api-keys-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
