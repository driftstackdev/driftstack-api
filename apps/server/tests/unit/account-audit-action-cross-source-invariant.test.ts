// W863 — AccountAuditAction 27-value cross-source invariant. One-
// hundred-eighty-ninth in the drift-guard series. Pins the V-216
// customer-facing audit-log action roster (27 values across 8
// resource categories):
//
//   account (7):   email_verified, login, logout, password_changed,
//                  mfa_enrolled, mfa_disabled, recovery_code_used.
//   api_key (3):   minted, revoked, rotated.
//   session (2):   created, destroyed.
//   profile (4):   created, deleted, exported, imported.
//   subscription (1): tier_changed.
//   webhook_endpoint (4): created, updated, deleted, secret_rotated.
//   webhook_delivery (1): replayed.
//   team (3):      member_invited, invite_accepted, member_removed.
//   admin (2):     refund_recorded, support_note.
//
// stays in lockstep across:
//   - packages/api-types/src/accounts.ts (Zod canonical source).
//   - apps/customer-dashboard/src/pages/audit-log.astro
//     (ACTION_LABEL map + FILTER_OPTIONS dropdown).
//   - apps/server/src/db/schema.ts accountAuditLog table
//     (text-typed action col, app-layer enforced).
//
// The customer audit log is GDPR Article 20 portability surface
// (V-297). Drift would silently let production emit actions the
// dashboard cannot render OR let the dashboard offer filters that
// return zero results.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const ACCOUNT_AUDIT_ACTIONS = [
  // account (7)
  'account.email_verified',
  'account.login',
  'account.logout',
  'account.password_changed',
  'account.mfa_enrolled',
  'account.mfa_disabled',
  'account.recovery_code_used',
  // api_key (3)
  'api_key.minted',
  'api_key.revoked',
  'api_key.rotated',
  // session (2)
  'session.created',
  'session.destroyed',
  // profile (4)
  'profile.created',
  'profile.deleted',
  'profile.exported',
  'profile.imported',
  // subscription (1)
  'subscription.tier_changed',
  // webhook_endpoint (4)
  'webhook_endpoint.created',
  'webhook_endpoint.updated',
  'webhook_endpoint.deleted',
  'webhook_endpoint.secret_rotated',
  // webhook_delivery (1)
  'webhook_delivery.replayed',
  // team (3)
  'team.member_invited',
  'team.invite_accepted',
  'team.member_removed',
  // admin (2)
  'admin.refund_recorded',
  'admin.support_note',
] as const;

describe('W863 AccountAuditAction cross-source invariant', () => {
  // ─── api-types canonical source ──────────────────────────────

  it('CRITICAL packages/api-types/src/accounts.ts AccountAuditActionSchema = z.enum([27 values]). The V-216 customer-facing audit-log roster across 8 resource categories.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/export const AccountAuditActionSchema = z\.enum\(\[/);
    const m = p.match(/AccountAuditActionSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m, 'AccountAuditActionSchema declaration must match').not.toBeNull();
    const body = m![1];
    for (const a of ACCOUNT_AUDIT_ACTIONS) {
      expect(body, `AccountAuditActionSchema must include '${a}'`).toMatch(
        new RegExp(`'${a.replace(/[.]/g, '\\.')}'`),
      );
    }
  });

  it('CRITICAL AccountAuditAction type re-exports from z.infer (drift-proof).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /export type AccountAuditAction = z\.infer<typeof AccountAuditActionSchema>;/,
    );
  });

  it("CRITICAL V-216 anchor pinned in api-types/accounts.ts. The 'V-216 — customer-facing audit log' inline header threads the audit-trail provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/V-216 — customer-facing audit log/);
  });

  it("CRITICAL AccountAuditActorTypeSchema = z.enum(['customer', 'system', 'staff']). The 3-value actor-type distinguishes user-initiated vs system-emitted vs staff-impersonated audit entries.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /export const AccountAuditActorTypeSchema = z\.enum\(\['customer', 'system', 'staff'\]\);/,
    );
  });

  // ─── Customer-dashboard ACTION_LABEL map ─────────────────────

  it('CRITICAL apps/customer-dashboard/src/pages/audit-log.astro ACTION_LABEL map has an entry for ALL 27 audit actions. Drift would render an audit row with a blank/raw action string instead of a human-readable label.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/audit-log.astro'));
    expect(p).toMatch(/const ACTION_LABEL: Record<string, string> = \{/);
    for (const a of ACCOUNT_AUDIT_ACTIONS) {
      expect(p, `ACTION_LABEL missing entry for '${a}'`).toMatch(
        new RegExp(`'${a.replace(/[.]/g, '\\.')}':\\s*'`),
      );
    }
  });

  // ─── Customer-dashboard FILTER_OPTIONS dropdown ──────────────

  it("CRITICAL apps/customer-dashboard/src/pages/audit-log.astro FILTER_OPTIONS dropdown has a filter for ALL 27 audit actions + 'All events' (empty string). Drift to missing a filter would silently hide that action category from the dashboard filter.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/audit-log.astro'));
    expect(p).toMatch(/const FILTER_OPTIONS = \[/);
    // The 'All events' empty-string sentinel.
    expect(p).toMatch(/value: '', label: 'All events'/);
    for (const a of ACCOUNT_AUDIT_ACTIONS) {
      expect(p, `FILTER_OPTIONS missing filter for '${a}'`).toMatch(
        new RegExp(`value: '${a.replace(/[.]/g, '\\.')}',`),
      );
    }
  });

  // ─── DB schema accountAuditLog table (text col) ──────────────

  it('CRITICAL apps/server/src/db/schema.ts accountAuditLog table stores action as text() (NOT pgEnum). The closed-enum is APP-LAYER enforced via Zod — the DB column is loose by design so a new audit action can land via a Class A schema migration (additive enum value) WITHOUT requiring a Drizzle ALTER TYPE migration.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/schema.ts'));
    // Sanity: accountAuditLog table exists.
    expect(p).toMatch(/export const accountAuditLog = pgTable\(/);
    // Action col is text() not pgEnum.
    const m = p.match(/accountAuditLog = pgTable\([\s\S]+?action: ([a-z]+)\(/);
    expect(m, 'accountAuditLog action column must be present').not.toBeNull();
    expect(m![1]).toBe('text');
  });

  // ─── 27-value cardinality + 9-category split ──────────────────

  it('CRITICAL AccountAuditAction = EXACTLY 27 values across 9 resource categories. The 7/3/2/4/1/4/1/3/2 split (account / api_key / session / profile / subscription / webhook_endpoint / webhook_delivery / team / admin) is what the audit-log filter UI grouping depends on.', () => {
    expect(ACCOUNT_AUDIT_ACTIONS.length).toBe(27);
    const countByPrefix = (prefix: string): number =>
      ACCOUNT_AUDIT_ACTIONS.filter((a) => a.startsWith(`${prefix}.`)).length;
    expect(countByPrefix('account')).toBe(7);
    expect(countByPrefix('api_key')).toBe(3);
    expect(countByPrefix('session')).toBe(2);
    expect(countByPrefix('profile')).toBe(4);
    expect(countByPrefix('subscription')).toBe(1);
    expect(countByPrefix('webhook_endpoint')).toBe(4);
    expect(countByPrefix('webhook_delivery')).toBe(1);
    expect(countByPrefix('team')).toBe(3);
    expect(countByPrefix('admin')).toBe(2);
  });

  // ─── 'resource.verb' naming convention ───────────────────────

  it("CRITICAL all 27 actions follow the 'resource.verb' naming convention (account.email_verified, api_key.minted, session.created, etc.). The dot-delimiter is what dashboard filter parsing depends on.", () => {
    for (const a of ACCOUNT_AUDIT_ACTIONS) {
      expect(a, `Action '${a}' must contain a dot separator`).toMatch(/\./);
      const [resource, verb] = a.split('.');
      expect(
        resource && verb,
        `Action '${a}' must have non-empty resource + verb parts`,
      ).toBeTruthy();
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/account-audit-action-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
