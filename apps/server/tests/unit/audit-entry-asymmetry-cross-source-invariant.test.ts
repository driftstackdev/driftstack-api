// W888 — Audit Entry shape asymmetry cross-source invariant. Two-
// hundred-fourteenth in the drift-guard series. Pins the
// intentional asymmetry between customer + admin audit-entry
// schemas:
//
//   AccountAuditEntry (V-216, 11 fields):
//     id + account_id + actor_type (customer|system|staff) +
//     actor_account_id + actor_key_id + action + target_resource_id
//     + payload + ip_address + user_agent + timestamp.
//
//   AdminAuditLogEntry (V-100, 10 fields):
//     id + admin_account_id (required) + admin_key_id (required) +
//     action + target_account_id + target_resource_id +
//     input_payload + result + ip_address + timestamp.
//
// Asymmetries:
//   - Customer entry has actor_type discriminator (cust/sys/staff);
//     admin entry has admin_account_id + admin_key_id (always set).
//   - Customer has user_agent; admin does NOT.
//   - Admin has result (string outcome); customer does NOT.
//   - Payload column is 'payload' (customer) vs 'input_payload' (admin).
//
// stays in lockstep across:
//   - packages/api-types/src/accounts.ts AccountAuditEntrySchema.
//   - packages/api-types/src/admin.ts AdminAuditLogEntrySchema.
//
// Drift would silently break:
//   * Customer-dashboard rendering an audit entry missing user-
//     agent context.
//   * Admin audit log losing the result field (compliance gap).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W888 Audit entry asymmetry cross-source invariant', () => {
  // ─── AccountAuditEntry: customer audit shape ─────────────────

  it('CRITICAL packages/api-types/src/accounts.ts AccountAuditEntrySchema has 11 fields — id + account_id + actor_type + actor_account_id + actor_key_id + action + target_resource_id + payload + ip_address + user_agent + timestamp.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    const m = p.match(/AccountAuditEntrySchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(m, 'AccountAuditEntrySchema must be present').not.toBeNull();
    const body = m![1];
    const requiredFields = [
      'id:',
      'account_id:',
      'actor_type:',
      'actor_account_id:',
      'actor_key_id:',
      'action:',
      'target_resource_id:',
      'payload:',
      'ip_address:',
      'user_agent:',
      'timestamp:',
    ];
    for (const f of requiredFields) {
      expect(body, `AccountAuditEntrySchema must have field ${f}`).toMatch(new RegExp(f));
    }
  });

  it('CRITICAL AccountAuditEntry uses actor_type: AccountAuditActorTypeSchema (3-value enum: customer/system/staff). The discriminator distinguishes user-initiated vs system-emitted vs staff-impersonated entries.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/actor_type: AccountAuditActorTypeSchema,/);
  });

  it('CRITICAL AccountAuditEntry uses payload: z.record(z.unknown()).nullable() — the JSON payload is loose-typed (no fixed shape per action). Customer audit-log is read-only display so loose payload is acceptable.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /AccountAuditEntrySchema = z\.object\(\{[\s\S]+?payload: z\.record\(z\.unknown\(\)\)\.nullable\(\)/,
    );
  });

  // ─── AdminAuditLogEntry: admin audit shape ───────────────────

  it('CRITICAL packages/api-types/src/admin.ts AdminAuditLogEntrySchema has 10 fields — id + admin_account_id + admin_key_id + action + target_account_id + target_resource_id + input_payload + result + ip_address + timestamp.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    const m = p.match(/AdminAuditLogEntrySchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(m, 'AdminAuditLogEntrySchema must be present').not.toBeNull();
    const body = m![1];
    const requiredFields = [
      'id:',
      'admin_account_id:',
      'admin_key_id:',
      'action:',
      'target_account_id:',
      'target_resource_id:',
      'input_payload:',
      'result:',
      'ip_address:',
      'timestamp:',
    ];
    for (const f of requiredFields) {
      expect(body, `AdminAuditLogEntrySchema must have field ${f}`).toMatch(new RegExp(f));
    }
  });

  it('CRITICAL AdminAuditLogEntry uses admin_account_id + admin_key_id (BOTH REQUIRED — admin actions ALWAYS performed by a staff account holding an admin key). No actor_type discriminator needed — admin entries are always staff-initiated.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(
      /AdminAuditLogEntrySchema = z\.object\(\{[\s\S]+?admin_account_id: z\.string\(\),\s*\n\s*admin_key_id: z\.string\(\),/,
    );
  });

  it("CRITICAL AdminAuditLogEntry uses input_payload (NOT payload) + result fields. 'input_payload' captures what the admin sent; 'result' captures the operation outcome. The dual capture is what compliance auditors need (input + result).", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    expect(p).toMatch(/input_payload: z\.record\(z\.unknown\(\)\)\.nullable\(\)/);
    expect(p).toMatch(/result: z\.string\(\),/);
  });

  // ─── Asymmetries ─────────────────────────────────────────────

  it("CRITICAL AccountAuditEntry has user_agent field; AdminAuditLogEntry does NOT. The user-agent is for customer-facing audit (lets customers spot suspicious browser activity); admin audit doesn't surface UA because staff use rotating dev machines.", () => {
    const customerP = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    const adminP = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    // Customer has user_agent.
    const customerM = customerP.match(/AccountAuditEntrySchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(customerM).not.toBeNull();
    expect(customerM![1], 'AccountAuditEntry must have user_agent').toMatch(/user_agent:/);
    // Admin does NOT have user_agent.
    const adminM = adminP.match(/AdminAuditLogEntrySchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(adminM).not.toBeNull();
    expect(adminM![1], 'AdminAuditLogEntry must NOT have user_agent').not.toMatch(/user_agent:/);
  });

  it("CRITICAL AdminAuditLogEntry has result field; AccountAuditEntry does NOT. The result captures the admin-operation outcome (e.g. 'tier_changed_from_team_manual_to_agency_manual'); customer audit is event-only.", () => {
    const customerP = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    const adminP = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    // Admin has result.
    const adminM = adminP.match(/AdminAuditLogEntrySchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(adminM).not.toBeNull();
    expect(adminM![1], 'AdminAuditLogEntry must have result').toMatch(/result:/);
    // Customer does NOT have result.
    const customerM = customerP.match(/AccountAuditEntrySchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(customerM).not.toBeNull();
    expect(customerM![1], 'AccountAuditEntry must NOT have result').not.toMatch(/^\s*result:/m);
  });

  it("CRITICAL AccountAuditEntry uses 'payload'; AdminAuditLogEntry uses 'input_payload'. The naming asymmetry distinguishes 'event payload' (customer side) from 'input payload to admin operation' (admin side).", () => {
    const customerP = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    const adminP = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    const customerM = customerP.match(/AccountAuditEntrySchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(customerM).not.toBeNull();
    expect(customerM![1], "customer must use 'payload'").toMatch(/^\s*payload:/m);
    const adminM = adminP.match(/AdminAuditLogEntrySchema = z\.object\(\{([\s\S]+?)\}\);/);
    expect(adminM).not.toBeNull();
    expect(adminM![1], "admin must use 'input_payload'").toMatch(/input_payload:/);
  });

  // ─── Common fields ──────────────────────────────────────────

  it('CRITICAL both schemas share 5 common fields — id + action + target_resource_id + ip_address + timestamp. The 5 commons let a unified audit-log search across both tables match by action / IP / target.', () => {
    const customerP = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    const adminP = read(resolve(REPO_ROOT, 'packages/api-types/src/admin.ts'));
    const commonFields = ['id:', 'action:', 'target_resource_id:', 'ip_address:', 'timestamp:'];
    const customerM = customerP.match(/AccountAuditEntrySchema = z\.object\(\{([\s\S]+?)\}\);/);
    const adminM = adminP.match(/AdminAuditLogEntrySchema = z\.object\(\{([\s\S]+?)\}\);/);
    for (const f of commonFields) {
      expect(customerM![1], `customer must have ${f}`).toMatch(new RegExp(f));
      expect(adminM![1], `admin must have ${f}`).toMatch(new RegExp(f));
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/audit-entry-asymmetry-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
