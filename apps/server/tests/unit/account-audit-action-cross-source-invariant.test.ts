// W863 — AccountAuditAction cross-source invariant. One-hundred-
// eighty-ninth in the drift-guard series. Pins the V-216 customer-
// facing audit-log action roster — derived from AccountAuditActionSchema
// (the Zod source-of-truth) rather than a hardcoded copy, so every
// action (including the agent_session.* / byok / proxy / bundled_llm /
// email_preferences additions made after launch) is automatically
// covered across every surface below.
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
import { AccountAuditActionSchema } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

// Derived from the Zod source-of-truth so the cross-source checks below
// automatically cover EVERY audit action — including ones added after
// this guard was written. The prior hardcoded 27-value list silently
// under-covered the 15 actions added 2026-05-17..20 (agent.decompose.*,
// agent_session.*, account.byok_anthropic_key_*, proxy.*,
// account.bundled_llm_consent_changed, account.email_preferences_changed),
// meaning the dashboard ACTION_LABEL / FILTER_OPTIONS completeness for
// those was unguarded.
const ACCOUNT_AUDIT_ACTIONS = AccountAuditActionSchema.options;

describe('W863 AccountAuditAction cross-source invariant', () => {
  // ─── api-types canonical source ──────────────────────────────

  it('CRITICAL packages/api-types/src/accounts.ts AccountAuditActionSchema = z.enum([...]). Every enum value is the V-216 customer-facing audit-log roster (checked enum-derived, not against a hardcoded copy).', () => {
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

  it('CRITICAL apps/customer-dashboard/src/pages/audit-log.astro ACTION_LABEL map has an entry for every AccountAuditAction enum value. Drift would render an audit row with a blank/raw action string instead of a human-readable label.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/audit-log.astro'));
    expect(p).toMatch(/const ACTION_LABEL: Record<string, string> = \{/);
    for (const a of ACCOUNT_AUDIT_ACTIONS) {
      expect(p, `ACTION_LABEL missing entry for '${a}'`).toMatch(
        new RegExp(`'${a.replace(/[.]/g, '\\.')}':\\s*'`),
      );
    }
  });

  // ─── Public API-reference event table (V-893) ────────────────

  it('V-893 CRITICAL apps/docs/src/pages/api/audit-log.md documents every AccountAuditAction, and invents none. The dashboard label map and filter dropdown were already tied to the enum; the PUBLIC reference table was not, so a new action could ship with a dashboard label and no customer documentation — or the table could outlive an action that was removed. Verified by hand at 46/46 in V-891; this arm is what keeps it there.', () => {
    const doc = read(resolve(REPO_ROOT, 'apps/docs/src/pages/api/audit-log.md'));
    const documented = new Set(
      [...doc.matchAll(/^\| `([a-z_]+\.[a-z_.]+)`/gm)].map((m) => m[1] as string),
    );
    // Both directions. A one-way subset check would pass a table that had
    // quietly grown a row for an action the server never emits, which is the
    // shape V-824 found in the OpenAPI spec.
    const undocumented = ACCOUNT_AUDIT_ACTIONS.filter((a) => !documented.has(a));
    expect(undocumented, 'enum actions with no row in the public reference table:').toEqual([]);

    const invented = [...documented].filter(
      (d) => !(ACCOUNT_AUDIT_ACTIONS as readonly string[]).includes(d),
    );
    expect(invented, 'rows in the reference table for actions the enum does not define:').toEqual(
      [],
    );

    // Guards the guard: an empty parse would satisfy both arms above.
    expect(documented.size, 'documented action rows parsed').toBeGreaterThan(40);
  });

  // ─── Customer-dashboard FILTER_OPTIONS dropdown ──────────────

  it("CRITICAL apps/customer-dashboard/src/pages/audit-log.astro FILTER_OPTIONS dropdown has a filter for every AccountAuditAction enum value + 'All events' (empty string). Drift to missing a filter would silently hide that action category from the dashboard filter.", () => {
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

  it('CRITICAL AccountAuditAction roster stays >= the 27-value V-216 launch baseline and keeps every launch category represented (no accidental truncation; new categories like agent_session / proxy only add).', () => {
    expect(ACCOUNT_AUDIT_ACTIONS.length).toBeGreaterThanOrEqual(27);
    const hasPrefix = (prefix: string): boolean =>
      ACCOUNT_AUDIT_ACTIONS.some((a) => a.startsWith(`${prefix}.`));
    for (const prefix of [
      'account',
      'api_key',
      'session',
      'profile',
      'subscription',
      'webhook_endpoint',
      'webhook_delivery',
      'team',
      'admin',
    ]) {
      expect(hasPrefix(prefix), `launch category '${prefix}' must remain represented`).toBe(true);
    }
  });

  // ─── 'resource.verb' naming convention ───────────────────────

  it("CRITICAL every action follows the 'resource.verb' naming convention (account.email_verified, api_key.minted, session.created, etc.). The dot-delimiter is what dashboard filter parsing depends on.", () => {
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
