// W1028 — routes/admin-rate-limit-overrides cross-source invariant.
// Three-hundred-fifty-fourth in the drift-guard series. Pins the apps/
// server/src/routes/admin-rate-limit-overrides.ts admin override list:
//
//   Header — 'Admin-only cross-account rate-limit override list —
//   GET /v1/admin/rate-limit-overrides. Read-only; no audit row
//   written for the read. Set / clear are per-account at
//   /v1/admin/accounts/:id/quota-override'.
//
//   ListAdminOverridesQuerySchema 4-filter — limit (int 1-100 default
//     50) + cursor + account_id + include_expired enum.
//
//   account_id 2-branch (uuid-as-is or uuidFromPrefixedId 'acc').
//
//   include_expired toggle — 'true' → true else false.
//
//   publicOverride 10-field — id (rlo_ prefix) + account_id (acc_
//     prefix) + bucket_key + capacity + refill_per_second + reason +
//     expires_at (ISO) + set_by_key_id (key_ prefix) + created_at +
//     updated_at.
//
// stays in lockstep across apps/server/src/routes/admin-rate-limit-overrides.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1028 routes/admin-rate-limit-overrides cross-source invariant', () => {
  it("CRITICAL header — 'Admin-only cross-account rate-limit override list — GET /v1/admin/rate-limit-overrides. Read-only; no audit row written for the read. Set / clear are per-account at /v1/admin/accounts/:id/quota-override'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-rate-limit-overrides.ts'));
    expect(p).toMatch(/\/\/ Admin-only cross-account rate-limit override list —/);
    expect(p).toMatch(
      /\/\/ GET \/v1\/admin\/rate-limit-overrides\. Read-only; no audit row written/,
    );
    expect(p).toMatch(/\/\/ for the read\. Set \/ clear are per-account at/);
    expect(p).toMatch(/\/\/ \/v1\/admin\/accounts\/:id\/quota-override\./);
  });

  it('CRITICAL ListAdminOverridesQuerySchema 4-filter — limit (int 1-100 default 50) + cursor + account_id + include_expired enum.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-rate-limit-overrides.ts'));
    expect(p).toMatch(
      /limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.default\(50\),/,
    );
    // Slice 149 added .min(1).max(512) cap to cursor (matches the
    // PaginationQuerySchema cap pattern across all list routes).
    expect(p).toMatch(/cursor: z\.string\(\)\.min\(1\)\.max\(512\)\.optional\(\),/);
    expect(p).toMatch(/account_id: z\.string\(\)\.min\(1\)\.max\(100\)\.optional\(\),/);
    expect(p).toMatch(/include_expired: z\.enum\(\['true', 'false'\]\)\.optional\(\),/);
  });

  it("CRITICAL account_id 2-branch (uuid-as-is OR uuidFromPrefixedId 'acc') + include_expired === 'true' boolean.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-rate-limit-overrides.ts'));
    expect(p).toMatch(/BARE_UUID_RE\.test\(parsed\.data\.account_id\)/);
    expect(p).toMatch(/: uuidFromPrefixedId\(parsed\.data\.account_id, 'acc'\)/);
    expect(p).toMatch(/const includeExpired = parsed\.data\.include_expired === 'true';/);
  });

  it('CRITICAL publicOverride 10-field — id (rlo_ prefix) + account_id (acc_ prefix) + bucket_key + capacity + refill_per_second + reason + expires_at (ISO) + set_by_key_id (key_ prefix) + created_at + updated_at.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-rate-limit-overrides.ts'));
    expect(p).toMatch(/id: `rlo_\$\{r\.id\}`,/);
    expect(p).toMatch(/account_id: `acc_\$\{r\.accountId\}`,/);
    expect(p).toMatch(/bucket_key: r\.bucketKey,/);
    expect(p).toMatch(/capacity: r\.capacity,/);
    expect(p).toMatch(/refill_per_second: r\.refillPerSecond,/);
    expect(p).toMatch(/reason: r\.reason,/);
    expect(p).toMatch(/expires_at: r\.expiresAt\.toISOString\(\),/);
    expect(p).toMatch(/set_by_key_id: `key_\$\{r\.setByKeyId\}`,/);
    expect(p).toMatch(/created_at: r\.createdAt\.toISOString\(\),/);
    expect(p).toMatch(/updated_at: r\.updatedAt\.toISOString\(\),/);
  });

  it("CRITICAL preHandler [requireScope('driftstack_internal_admin'), rateLimit('global')] + service.listAll(ctx, {...accountId?, includeExpired}) + response { data, next_cursor }.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/admin-rate-limit-overrides.ts'));
    expect(p).toMatch(
      /preHandler: \[app\.requireScope\('driftstack_internal_admin'\), app\.rateLimit\('global'\)\],/,
    );
    expect(p).toMatch(/await rateLimitOverrides\.listAll\(ctx, \{/);
    expect(p).toMatch(
      /\.\.\.\(accountUuid !== undefined \? \{ accountId: accountUuid \} : \{\}\),/,
    );
    expect(p).toMatch(/includeExpired,/);
    expect(p).toMatch(/data: page\.items\.map\(publicOverride\),/);
    expect(p).toMatch(/next_cursor: page\.nextCursor,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-admin-rate-limit-overrides-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
