// W415.C — drift guard for apps/server/src/routes/admin-rate-limit-overrides.ts.
// Admin cross-account override list. Read-only, no audit row. Set /
// clear are per-account at /v1/admin/accounts/:id/quota-override.
// Drift here either drops the include_expired discriminator (admin
// loses historical visibility into expired overrides) or breaks the
// rlo_ public id prefix (admin GUI deep-link breakage).
//
//   • Framing pinned: GET /v1/admin/rate-limit-overrides; read-only
//     no-audit; set/clear at /v1/admin/accounts/:id/quota-override.
//   • PUBLIC_ID_RE + uuidFromPrefixedId helpers (shared pattern).
//   • Query schema: limit coerce int 1..100 default 50 + optional
//     cursor + optional account_id + include_expired zod enum
//     'true'|'false' → boolean coerce.
//   • include_expired coerce: parsed.data.include_expired === 'true'
//     (undefined → false default).
//   • publicOverride: id=rlo_<uuid> + account_id=acc_<uuid> +
//     bucket_key + capacity + refill_per_second + reason + expires_at
//     ISO + set_by_key_id=key_<uuid> + created_at/updated_at ISO.
//   • Scope-gate: driftstack_internal_admin + global rate-limit.
//   • Service dispatch: rateLimitOverrides.listAll with includeExpired
//     always included; spread-conditional cursor + accountId.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/admin-rate-limit-overrides.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W415.C apps/server/src/routes/admin-rate-limit-overrides.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: GET /v1/admin/rate-limit-overrides read-only no-audit + set/clear at /v1/admin/accounts/:id/quota-override', () => {
    expect(body).toMatch(
      /Admin-only cross-account rate-limit override list —\s*\n?\s*\/\/\s*GET \/v1\/admin\/rate-limit-overrides\. Read-only; no audit row written\s*\n?\s*\/\/\s*for the read\. Set \/ clear are per-account at\s*\n?\s*\/\/\s*\/v1\/admin\/accounts\/:id\/quota-override\./,
    );
  });

  it('PUBLIC_ID_RE + uuidFromPrefixedId helpers (shared pattern)', () => {
    expect(body).toMatch(
      /const PUBLIC_ID_RE = \/\^\[a-z\]\{3\}_\(\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\)\$\/;/,
    );
    expect(body).toMatch(
      /function uuidFromPrefixedId\(value: string, expectedPrefix: string\): string \{\s*\n?\s*const match = PUBLIC_ID_RE\.exec\(value\);\s*\n?\s*if \(!match \|\| !match\[1\] \|\| !value\.startsWith\(`\$\{expectedPrefix\}_`\)\) \{\s*\n?\s*throw new BadRequestError\(`Invalid id format\. Expected "\$\{expectedPrefix\}_<uuid>"\.`\);/,
    );
  });

  it("ListAdminOverridesQuerySchema: limit coerce 1..100 default 50 + optional cursor + optional account_id + include_expired zod enum 'true'|'false'", () => {
    expect(body).toMatch(
      /const ListAdminOverridesQuerySchema = z\.object\(\{\s*\n?\s*limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.default\(50\),\s*\n?\s*cursor: z\.string\(\)\.optional\(\),\s*\n?\s*account_id: z\.string\(\)\.optional\(\),\s*\n?\s*include_expired: z\.enum\(\['true', 'false'\]\)\.optional\(\),\s*\n?\s*\}\);/,
    );
  });

  it('publicOverride: id=rlo_ + account_id=acc_ + bucket_key/capacity/refill_per_second/reason + expires_at ISO + set_by_key_id=key_ + created/updated ISO', () => {
    expect(body).toMatch(
      /function publicOverride\(r: RateLimitOverrideRecord\): Record<string, unknown> \{/,
    );
    expect(body).toMatch(/id: `rlo_\$\{r\.id\}`,/);
    expect(body).toMatch(/account_id: `acc_\$\{r\.accountId\}`,/);
    expect(body).toMatch(/bucket_key: r\.bucketKey,/);
    expect(body).toMatch(/capacity: r\.capacity,/);
    expect(body).toMatch(/refill_per_second: r\.refillPerSecond,/);
    expect(body).toMatch(/reason: r\.reason,/);
    expect(body).toMatch(/expires_at: r\.expiresAt\.toISOString\(\),/);
    expect(body).toMatch(/set_by_key_id: `key_\$\{r\.setByKeyId\}`,/);
    expect(body).toMatch(/created_at: r\.createdAt\.toISOString\(\),/);
    expect(body).toMatch(/updated_at: r\.updatedAt\.toISOString\(\),/);
  });

  it("Scope-gate: requireScope('driftstack_internal_admin') + rateLimit('global')", () => {
    expect(body).toMatch(
      /preHandler: \[app\.requireScope\('driftstack_internal_admin'\), app\.rateLimit\('global'\)\],/,
    );
  });

  it('account_id resolution: 36-char raw uuid OR uuidFromPrefixedId(value, "acc")', () => {
    expect(body).toMatch(
      /const accountUuid =\s*\n?\s*parsed\.data\.account_id !== undefined\s*\n?\s*\? parsed\.data\.account_id\.length === 36\s*\n?\s*\? parsed\.data\.account_id\s*\n?\s*: uuidFromPrefixedId\(parsed\.data\.account_id, 'acc'\)\s*\n?\s*: undefined;/,
    );
  });

  it("include_expired coerce: parsed.data.include_expired === 'true' (boolean; undefined → false default)", () => {
    expect(body).toMatch(/const includeExpired = parsed\.data\.include_expired === 'true';/);
  });

  it('Service dispatch: rateLimitOverrides.listAll with includeExpired always set + spread-conditional cursor + accountId', () => {
    expect(body).toMatch(
      /const page = await rateLimitOverrides\.listAll\(ctx, \{\s*\n?\s*limit: parsed\.data\.limit,\s*\n?\s*\.\.\.\(parsed\.data\.cursor !== undefined \? \{ cursor: parsed\.data\.cursor \} : \{\}\),\s*\n?\s*\.\.\.\(accountUuid !== undefined \? \{ accountId: accountUuid \} : \{\}\),\s*\n?\s*includeExpired,\s*\n?\s*\}\);/,
    );
  });

  it('Reply shape: { data: page.items.map(publicOverride), next_cursor: page.nextCursor }', () => {
    expect(body).toMatch(
      /return \{\s*\n?\s*data: page\.items\.map\(publicOverride\),\s*\n?\s*next_cursor: page\.nextCursor,\s*\n?\s*\};/,
    );
  });

  it('BadRequestError on safeParse fail with "Invalid query parameters."', () => {
    expect(body).toMatch(
      /if \(!parsed\.success\) throw new BadRequestError\('Invalid query parameters\.'\);/,
    );
  });

  it('imports: FastifyInstance + zod + RateLimitOverrideRecord/RateLimitOverridesService + BadRequestError', () => {
    expect(body).toMatch(/import type \{ FastifyInstance \} from 'fastify';/);
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(
      /import type \{\s*\n?\s*RateLimitOverrideRecord,\s*\n?\s*RateLimitOverridesService,\s*\n?\s*\} from '\.\.\/services\/rate-limit-overrides\.js';/,
    );
    expect(body).toMatch(/import \{ BadRequestError \} from '\.\.\/lib\/errors\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
