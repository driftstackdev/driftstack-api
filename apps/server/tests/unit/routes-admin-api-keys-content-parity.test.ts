// W414.C — drift guard for apps/server/src/routes/admin-api-keys.ts.
// Admin-only cross-account API key list — read-only, no audit row.
// Revoke split into admin-force-actions.ts (POST .../revoke). Drift
// here either drops the scope-gate (cross-tenant leak) or drifts the
// public-id prefix mapping (key_/acc_) which the admin GUI relies on
// to deep-link to the owning account.
//
//   • Framing pinned: GET /v1/admin/api-keys; read-only; no audit
//     row written for the read; revoke action lives in
//     admin-force-actions.ts at POST /v1/admin/api-keys/:id/revoke.
//   • PUBLIC_ID_RE pinned: ^[a-z]{3}_(<uuid>)$; uuidFromPrefixedId
//     enforces expectedPrefix match; throws BadRequestError with
//     specific "<prefix>_<uuid>" hint.
//   • Account id accepted as either raw 36-char uuid OR acc_-prefixed.
//   • Revoked filter: zod enum 'true'|'false' → boolean coerce.
//   • Listing pagination: limit coerce 1..100 default 50; optional
//     cursor; spread-conditional pattern for cursor + accountId +
//     revoked args.
//   • Scope-gate: requireScope('driftstack_internal_admin') +
//     rateLimit('global').
//   • publicAdminApiKey: id=key_<uuid> + account_id=acc_<uuid> +
//     name + key_prefix + scopes + last_used_at/revoked_at/
//     expires_at nullable ISO + created_at ISO.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/admin-api-keys.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W414.C apps/server/src/routes/admin-api-keys.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: GET /v1/admin/api-keys read-only no-audit + revoke at POST /v1/admin/api-keys/:id/revoke in admin-force-actions', () => {
    expect(body).toMatch(
      /Admin-only cross-account API key list — GET \/v1\/admin\/api-keys\.\s*\/\/\s*Read-only; no audit row written for the read\. Revoke action lives\s*\/\/\s*in admin-force-actions\.ts \(POST \/v1\/admin\/api-keys\/:id\/revoke\)\./,
    );
  });

  it('PUBLIC_ID_RE: ^[a-z]{3}_(uuid)$ regex', () => {
    expect(body).toMatch(
      /const PUBLIC_ID_RE = \/\^\[a-z\]\{3\}_\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)\$\/;/,
    );
  });

  it('uuidFromPrefixedId: regex + expectedPrefix startsWith check; BadRequestError with "<prefix>_<uuid>" hint', () => {
    expect(body).toMatch(
      /function uuidFromPrefixedId\(value: string, expectedPrefix: string\): string \{\s*const match = PUBLIC_ID_RE\.exec\(value\);\s*if \(!match \|\| !match\[1\] \|\| !value\.startsWith\(`\$\{expectedPrefix\}_`\)\) \{\s*throw new BadRequestError\(`Invalid id format\. Expected "\$\{expectedPrefix\}_<uuid>"\.`\);\s*\}\s*return match\[1\];/,
    );
  });

  it('ListAdminApiKeysQuerySchema: limit coerce int 1..100 default 50 + cursor (string 1-512) + account_id (string 1-100) + revoked enum true|false (Slice 146 defensive caps across admin-cost/admin-usage/admin-crypto-orders/admin-api-keys).', () => {
    expect(body).toMatch(
      /const ListAdminApiKeysQuerySchema = z\.object\(\{\s*limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.default\(50\),[\s\S]*?cursor: z\.string\(\)\.min\(1\)\.max\(512\)\.optional\(\),\s*account_id: z\.string\(\)\.min\(1\)\.max\(100\)\.optional\(\),\s*revoked: z\.enum\(\['true', 'false'\]\)\.optional\(\),\s*\}\);/,
    );
  });

  it('publicAdminApiKey: id=key_<uuid> + account_id=acc_<uuid> + key_prefix + scopes + nullable timestamps', () => {
    expect(body).toMatch(
      /function publicAdminApiKey\(row: ApiKeyRow\): Record<string, unknown> \{/,
    );
    expect(body).toMatch(/id: `key_\$\{row\.id\}`,/);
    expect(body).toMatch(/account_id: `acc_\$\{row\.accountId\}`,/);
    expect(body).toMatch(/key_prefix: row\.keyPrefix,/);
    expect(body).toMatch(/scopes: row\.scopes,/);
    expect(body).toMatch(
      /last_used_at: row\.lastUsedAt \? row\.lastUsedAt\.toISOString\(\) : null,/,
    );
    expect(body).toMatch(/revoked_at: row\.revokedAt \? row\.revokedAt\.toISOString\(\) : null,/);
    expect(body).toMatch(/expires_at: row\.expiresAt \? row\.expiresAt\.toISOString\(\) : null,/);
    expect(body).toMatch(/created_at: row\.createdAt\.toISOString\(\),/);
  });

  it("Scope-gate: requireScope('driftstack_internal_admin') + rateLimit('global')", () => {
    expect(body).toMatch(
      /preHandler: \[app\.requireScope\('driftstack_internal_admin'\), app\.rateLimit\('global'\)\],/,
    );
  });

  it('account_id resolution: 36-char raw uuid pass-through OR uuidFromPrefixedId(value, "acc")', () => {
    expect(body).toMatch(
      /const accountUuid =\s*parsed\.data\.account_id !== undefined\s*\? BARE_UUID_RE\.test\(parsed\.data\.account_id\)\s*\? parsed\.data\.account_id\s*: uuidFromPrefixedId\(parsed\.data\.account_id, 'acc'\)\s*: undefined;/,
    );
  });

  it("Revoked filter coerce: 'true'|'false' string → boolean; undefined → undefined", () => {
    expect(body).toMatch(
      /const revoked =\s*parsed\.data\.revoked === undefined \? undefined : parsed\.data\.revoked === 'true';/,
    );
  });

  it('Service dispatch: apiKeysService.listAll with spread-conditional cursor + accountId + revoked args', () => {
    expect(body).toMatch(
      /const page = await apiKeysService\.listAll\(ctx, \{\s*limit: parsed\.data\.limit,\s*\.\.\.\(parsed\.data\.cursor !== undefined \? \{ cursor: parsed\.data\.cursor \} : \{\}\),\s*\.\.\.\(accountUuid !== undefined \? \{ accountId: accountUuid \} : \{\}\),\s*\.\.\.\(revoked !== undefined \? \{ revoked \} : \{\}\),\s*\}\);/,
    );
  });

  it('Reply shape: { data: page.items.map(publicAdminApiKey), next_cursor: page.nextCursor }', () => {
    expect(body).toMatch(
      /return \{\s*data: page\.items\.map\(publicAdminApiKey\),\s*next_cursor: page\.nextCursor,\s*\};/,
    );
  });

  it('BadRequestError on safeParse fail with "Invalid query parameters." copy', () => {
    expect(body).toMatch(
      /if \(!parsed\.success\) throw new BadRequestError\('Invalid query parameters\.'\);/,
    );
  });

  it('imports: FastifyInstance + zod + ApiKeyRow + ApiKeysService + BadRequestError', () => {
    expect(body).toMatch(/import type \{ FastifyInstance \} from 'fastify';/);
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(/import type \{ ApiKeyRow \} from '\.\.\/services\/auth\.js';/);
    expect(body).toMatch(/import type \{ ApiKeysService \} from '\.\.\/services\/api-keys\.js';/);
    expect(body).toMatch(/import \{ BadRequestError \} from '\.\.\/lib\/errors\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
