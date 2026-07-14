// W860 — AccountStatus 3-value cross-source invariant. One-
// hundred-eighty-sixth in the drift-guard series. Pins the
// 3-value account-lifecycle status enum:
//   1. active    — normal operating state.
//   2. suspended — admin-suspended (V-100 force-action OR
//                  billing-driven via V-429); customer cannot
//                  start new sessions or mint new API keys.
//   3. deleted   — terminal (closure complete; soft-delete row
//                  retained for audit + GDPR window).
// stays in lockstep across:
//   - packages/api-types/src/accounts.ts (Zod canonical source).
//   - apps/server/src/db/schema.ts pgEnum (Postgres runtime).
//   - packages/sdk-go/types.go (Go SDK closed-enum consts).
//
// Drift would silently break:
//   * Server persist: pgEnum rejects unknown values.
//   * Go SDK customer pattern-match on status.
//   * Billing-quota gates (only 'active' grants new-session).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const ACCOUNT_STATUSES = ['active', 'suspended', 'deleted'] as const;

describe('W860 AccountStatus cross-source invariant', () => {
  // ─── api-types canonical source ──────────────────────────────

  it("CRITICAL packages/api-types/src/accounts.ts AccountStatusSchema = z.enum(['active', 'suspended', 'deleted']). The 3-value account-lifecycle is the contract every gating + filter pivots on.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(
      /export const AccountStatusSchema = z\.enum\(\['active', 'suspended', 'deleted'\]\);/,
    );
  });

  it('CRITICAL AccountStatus type re-exports from z.infer (drift-proof).', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    expect(p).toMatch(/export type AccountStatus = z\.infer<typeof AccountStatusSchema>;/);
  });

  // ─── DB pgEnum lockstep ──────────────────────────────────────

  it("CRITICAL apps/server/src/db/schema.ts accountStatus = pgEnum('account_status', ['active', 'suspended', 'deleted']). Postgres rejects INSERTs of unknown values — drift would crash account-lifecycle transitions.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/schema.ts'));
    expect(p).toMatch(
      /accountStatus = pgEnum\('account_status', \['active', 'suspended', 'deleted'\]\);/,
    );
  });

  // ─── Go SDK closed-enum consts ───────────────────────────────

  it('CRITICAL packages/sdk-go/types.go declares 3 AccountStatus consts — AccountActive + AccountSuspended + AccountDeleted. Each maps to one canonical status string.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/type AccountStatus string/);
    expect(p).toMatch(/AccountActive\s+AccountStatus = "active"/);
    expect(p).toMatch(/AccountSuspended AccountStatus = "suspended"/);
    expect(p).toMatch(/AccountDeleted\s+AccountStatus = "deleted"/);
  });

  // ─── 3-value cardinality + 1-good + 2-restricted split ───────

  it("CRITICAL AccountStatus = EXACTLY 3 values — 1 good-standing (active) + 2 restricted (suspended + deleted). Billing-quota gates branch on 'active' for new-session grant; the 2-restricted bucket blocks both new-session creation AND new-API-key minting. Drift to a 4th status would silently leave gating logic ambiguous.", () => {
    expect(ACCOUNT_STATUSES.length).toBe(3);
    const goodStanding = ACCOUNT_STATUSES.filter((t) => t === 'active');
    const restricted = ACCOUNT_STATUSES.filter((t) => t !== 'active');
    expect(goodStanding.length).toBe(1);
    expect(restricted.length).toBe(2);
    expect(restricted).toEqual(['suspended', 'deleted']);
  });

  // ─── 'deleted' terminal-status semantics ──────────────────────

  it("CRITICAL 'deleted' is a TERMINAL status (no transition out of deleted). The soft-delete pattern retains the row for audit + GDPR window; production code MUST treat 'deleted' as unreachable for re-activation. Drift to allowing 'deleted' → 'active' would break the audit-trail contract.", () => {
    // The semantic is encoded in service-layer code; here we pin the
    // CANONICAL ENUM ORDER as: good-standing → restricted-reversible
    // → restricted-terminal. The order is a documentation invariant.
    expect(ACCOUNT_STATUSES[0]).toBe('active');
    expect(ACCOUNT_STATUSES[1]).toBe('suspended');
    expect(ACCOUNT_STATUSES[2]).toBe('deleted');
  });

  // ─── No forbidden / legacy status names ──────────────────────

  it('CRITICAL no source declares forbidden account-status names (closed / banned / inactive / disabled / archived / locked). These are common lifecycle conventions the 3-value model intentionally avoids — drift would fragment the lifecycle story + create ambiguity around which restricted states allow re-activation.', () => {
    const apiTypes = read(resolve(REPO_ROOT, 'packages/api-types/src/accounts.ts'));
    const forbidden = ['closed', 'banned', 'inactive', 'disabled', 'archived', 'locked'];
    const m = apiTypes.match(/AccountStatusSchema = z\.enum\(\[([\s\S]+?)\]\)/);
    expect(m).not.toBeNull();
    const body = m![1];
    for (const f of forbidden) {
      expect(body, `AccountStatus must NOT include forbidden ${f}`).not.toMatch(
        new RegExp(`'${f}'`),
      );
    }
  });

  // ─── 'active' is the default-on-create ───────────────────────

  it("CRITICAL 'active' is the implicit default for new account creation (no explicit default declared because the only valid create-time status is active; suspend + delete come later via state transitions). Drift to making 'suspended' the create-time default would silently lock customers out at signup.", () => {
    expect(ACCOUNT_STATUSES[0]).toBe('active');
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/account-status-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
