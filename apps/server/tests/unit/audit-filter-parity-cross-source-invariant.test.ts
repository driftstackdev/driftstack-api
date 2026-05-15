// W897 — V-484+V-521 audit-log filter parity cross-source
// invariant. Two-hundred-twenty-third in the drift-guard series.
// Pins the V-521 admin-side parity with V-484 customer audit-log
// filter set:
//
//   V-484 ListAccountAuditLogQuery (customer):
//     - limit: 1-100 (default 50).
//     - cursor: optional.
//     - action?: AccountAuditActionSchema.
//     - from?: z.coerce.date() (YYYY-MM-DD or ISO).
//     - to?: z.coerce.date().
//     - actor_type?: AccountAuditActorTypeSchema.
//     - target_resource_id?: 1-200 chars.
//
//   V-521 ListAuditLogQuery (admin):
//     - admin_id?: optional.
//     - target_id?: optional.
//     - action?: AdminAuditActionSchema.
//     - from?: Iso8601Schema.
//     - to?: Iso8601Schema.
//     - target_resource_id?: 1-200 chars (V-521 parity).
//     - limit: 1-100 (default 50).
//     - cursor: optional.
//
// Shared filter set: limit + cursor + action + from + to +
//   target_resource_id (6 common fields).
//   Customer-only: actor_type (3-value).
//   Admin-only: admin_id + target_id (admin perspective).
//
// stays in lockstep across api-types Zod canonical.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W897 audit-log filter parity cross-source invariant', () => {
  // ─── V-484 customer-side filters ─────────────────────────────

  it("CRITICAL packages/api-types/src/accounts.ts ListAccountAuditLogQuery has V-484 filters — from/to (z.coerce.date) + actor_type (AccountAuditActorTypeSchema) + target_resource_id (1-200). The V-484 anchor + 'additional filters' framing pins the customer filter set.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/V-484 — additional filters\. ISO 8601 dates for from\/to \(inclusive\)/);
    expect(p).toMatch(/from: z\.coerce\.date\(\)\.optional\(\)/);
    expect(p).toMatch(/to: z\.coerce\.date\(\)\.optional\(\)/);
    expect(p).toMatch(/actor_type: AccountAuditActorTypeSchema\.optional\(\)/);
    expect(p).toMatch(/target_resource_id: z\.string\(\)\.min\(1\)\.max\(200\)\.optional\(\)/);
  });

  it("CRITICAL ListAccountAuditLogQuery V-484 comment pins z.coerce.date() rationale — 'Coerced from query strings; Zod's coerce.date() handles YYYY-MM-DD and full ISO 8601 timestamps'. The coerce-pattern is what lets URL params (string) become date objects.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /Coerced from query strings; Zod's coerce\.date\(\) handles\s*\n\s*\/\/ YYYY-MM-DD and full ISO 8601 timestamps/,
    );
  });

  // ─── V-521 admin-side filters ────────────────────────────────

  it("CRITICAL packages/api-types/src/admin.ts ListAuditLogQuery has V-521 filters — admin_id + target_id + action + from/to (Iso8601Schema) + target_resource_id (1-200). The V-521 anchor + 'admin-side parity with V-484' framing.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(/V-521 — admin-side parity with the V-484 customer audit-log/);
    expect(p).toMatch(
      /ListAuditLogQuerySchema = z\.object\(\{[\s\S]+?admin_id: z\.string\(\)\.optional\(\)/,
    );
    expect(p).toMatch(/target_id: z\.string\(\)\.optional\(\)/);
    expect(p).toMatch(/action: AdminAuditActionSchema\.optional\(\)/);
    expect(p).toMatch(/from: Iso8601Schema\.optional\(\)/);
    expect(p).toMatch(/to: Iso8601Schema\.optional\(\)/);
    expect(p).toMatch(/target_resource_id: z\.string\(\)\.min\(1\)\.max\(200\)\.optional\(\)/);
  });

  it("CRITICAL V-521 framing pins 'Drill into a single resource (e.g. one webhook delivery) across every admin action that touched it'. The use-case framing teaches support reps how to use the filter.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(
      /Drill into a single resource \(e\.g\. one webhook\s*\n\s*\/\/ delivery\) across every admin action that touched it/,
    );
  });

  // ─── target_resource_id 1-200 bound parity ───────────────────

  it('CRITICAL BOTH V-484 + V-521 use target_resource_id: z.string().min(1).max(200).optional() — identical bounds. The 200-char bound is what lets either side filter on (e.g.) a webhook-delivery id without truncation.', () => {
    const customerP = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    const adminP = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(customerP).toMatch(
      /target_resource_id: z\.string\(\)\.min\(1\)\.max\(200\)\.optional\(\)/,
    );
    expect(adminP).toMatch(/target_resource_id: z\.string\(\)\.min\(1\)\.max\(200\)\.optional\(\)/);
  });

  // ─── Asymmetry: customer has actor_type; admin has admin_id+target_id ─

  it('CRITICAL customer-side ListAccountAuditLog has actor_type (3-value customer/system/staff) — admin-side does NOT (admin actions are always staff). Admin-side has admin_id + target_id (admin-perspective filter). The asymmetry matches the V-484 + V-521 use-case split.', () => {
    const customerP = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    const adminP = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    // Customer has actor_type.
    const customerM = customerP.match(
      /ListAccountAuditLogQuerySchema = z\.object\(\{([\s\S]+?)\}\);/,
    );
    expect(customerM).not.toBeNull();
    expect(customerM![1], 'customer must have actor_type').toMatch(/actor_type:/);
    // Admin does NOT have actor_type.
    const adminM = adminP.match(/ListAuditLogQuerySchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(adminM).not.toBeNull();
    expect(adminM![1], 'admin MUST NOT have actor_type').not.toMatch(/actor_type:/);
    // Admin has admin_id + target_id.
    expect(adminM![1], 'admin must have admin_id').toMatch(/admin_id:/);
    expect(adminM![1], 'admin must have target_id').toMatch(/target_id:/);
  });

  // ─── 6 common filter fields ──────────────────────────────────

  it('CRITICAL both queries share 6 filter fields — limit + cursor + action + from + to + target_resource_id. The 6 commons let support reps cross-reference customer + admin audit trails with the same filter UI.', () => {
    const customerP = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    const adminP = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    const customerM = customerP.match(
      /ListAccountAuditLogQuerySchema = z\.object\(\{([\s\S]+?)\}\);/,
    );
    const adminM = adminP.match(/ListAuditLogQuerySchema = z\.object\(\{([\s\S]+?)\}\);/);
    const commonFields = ['limit:', 'cursor:', 'action:', 'from:', 'to:', 'target_resource_id:'];
    for (const f of commonFields) {
      expect(customerM![1], `customer must have ${f}`).toMatch(new RegExp(f));
      expect(adminM![1], `admin must have ${f}`).toMatch(new RegExp(f));
    }
  });

  // ─── limit + cursor + default 50 parity ─────────────────────

  it('CRITICAL BOTH queries use limit: z.coerce.number().int().min(1).max(100) with default 50. The shared limit-bounds + default is what makes pagination behavior consistent across the audit-log filter UI.', () => {
    const customerP = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    const adminP = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(customerP).toMatch(
      /ListAccountAuditLogQuerySchema = z\.object\(\{[\s\S]+?limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.optional\(\)\.default\(50\)/,
    );
    expect(adminP).toMatch(
      /ListAuditLogQuerySchema = z\.object\(\{[\s\S]+?limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(100\)\.default\(50\)/,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/audit-filter-parity-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
