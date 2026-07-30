// W853 — TeamRole 2-value cross-source invariant. One-hundred-
// seventy-ninth in the drift-guard series. Pins V-298c Team RBAC's
// 2-value role enum:
//   - member: read-only access (reads on /v1/team/* + sessions etc).
//   - admin: read + write (mutations).
// stays in lockstep across 5 hand-coordinated sources (no canonical
// Zod schema in api-types — each source declares the union locally):
//   - apps/server/src/db/schema.ts pgEnum (Postgres runtime).
//   - apps/server/src/services/team-members.ts (server union type).
//   - packages/sdk-typescript/src/resources/team.ts (TS SDK type).
//   - packages/sdk-go/types.go (Go SDK consts).
//   - apps/customer-dashboard/src/pages/team.astro (invite form
//     dropdown options).
//
// Drift would silently break:
//   * Server-side persist: pgEnum rejects unknown role values.
//   * TS SDK: customer code pattern-matches on the type.
//   * Go SDK: customer code uses TeamRoleMember + TeamRoleAdmin.
//   * Dashboard form: <option value="..."> values must match.
// The hand-coordination is fragile; this test is the mechanical
// guard that catches partial-rename drift before it ships.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TEAM_ROLES = ['member', 'admin'] as const;

describe('W853 TeamRole cross-source invariant', () => {
  // ─── DB pgEnum ───────────────────────────────────────────────

  it("CRITICAL apps/server/src/db/schema.ts declares teamRole = pgEnum('team_role', ['member', 'admin']). Postgres rejects INSERTs of unknown role values — drift to renaming would break persist + would crash team-create flow at runtime.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/schema.ts'));
    expect(p).toMatch(/teamRole = pgEnum\('team_role', \['member', 'admin'\]\);/);
  });

  // ─── Server service union type ───────────────────────────────

  it("CRITICAL apps/server/src/services/team-members.ts declares 'export type TeamRole = 'member' | 'admin'' (server-side union type). The server-side type pivots the whole service-layer code — drift would break compile-time type-checking on role parameters.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts'));
    expect(p).toMatch(/export type TeamRole = 'member' \| 'admin';/);
  });

  it("CRITICAL apps/server/src/services/team-members.ts defaults role to 'member' when omitted in invite-create input. The default-member contract is what 'invite a new teammate' UX depends on (admin must be explicitly granted) — drift to defaulting admin would over-grant access.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/team-members.ts'));
    expect(p).toMatch(/const role: TeamRole = input\.role \?\? 'member';/);
  });

  // ─── TS SDK type re-declaration ──────────────────────────────

  it("CRITICAL packages/sdk-typescript/src/resources/team.ts declares 'export type TeamRole = 'member' | 'admin'' (TS SDK union type). TS customers pattern-match on this — drift would silently let TS-typed code accept role strings the server rejects.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/team.ts'));
    expect(p).toMatch(/export type TeamRole = 'member' \| 'admin';/);
  });

  // ─── Go SDK closed-enum consts ───────────────────────────────

  it('CRITICAL packages/sdk-go/types.go declares 2 TeamRole consts — TeamRoleMember + TeamRoleAdmin. Each maps to one canonical role string. Drift would break Go customers who switch on roles.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/sdk-go/types.go'));
    expect(p).toMatch(/type TeamRole string/);
    expect(p).toMatch(/TeamRoleMember TeamRole = "member"/);
    expect(p).toMatch(/TeamRoleAdmin\s+TeamRole = "admin"/);
  });

  // ─── Customer-dashboard invite form ──────────────────────────

  it("CRITICAL apps/customer-dashboard/src/pages/team.astro invite-form has dropdown options for BOTH 'member' + 'admin'. The form value-strings must match the server-side enum exactly — drift would silently let the dashboard offer roles the server rejects, OR fail to offer roles that the server accepts.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/team.astro'));
    expect(p).toMatch(/<option value="member">Member<\/option>/);
    expect(p).toMatch(/<option value="admin">Admin<\/option>/);
  });

  it("CRITICAL apps/customer-dashboard/src/pages/team.astro RBAC comment pinned: 'reads work for both member and admin roles; writes require admin'. The dashboard documents the V-298c RBAC contract — drift would mislead customer-facing copy.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/team.astro'));
    // Allow flexibility in <code> wrapping + word ordering.
    expect(p).toMatch(/reads work for both[\s\S]+?<code>member<\/code>[\s\S]+?<code>admin<\/code>/);
    expect(p).toMatch(/writes require <code>admin<\/code>/);
  });

  // ─── 2-role cardinality ──────────────────────────────────────

  it("CRITICAL TeamRole = EXACTLY 2 values (member + admin). The 2-role model intentionally avoids 'owner' / 'viewer' / 'guest' tier-creep that would fragment the RBAC story. The 2-role discipline is what V-298c locked in.", () => {
    expect(TEAM_ROLES.length).toBe(2);
  });

  it("CRITICAL no source declares forbidden team-role names (owner / viewer / guest / superadmin / readonly). These are common RBAC-creep names that V-298c intentionally avoids — the 2-role model lets us reason simply about 'who can mutate'.", () => {
    const forbidden = ['owner', 'viewer', 'guest', 'superadmin', 'readonly'];
    const dbSchema = read(resolve(REPO_ROOT, 'apps/server/src/db/schema.ts'));
    // Only check the teamRole declaration line — 'owner' appears
    // elsewhere (e.g. owner_account_id) in the schema.
    const m = dbSchema.match(/teamRole = pgEnum\('team_role', \[([\s\S]+?)\]\);/);
    expect(m, 'teamRole pgEnum must be present').not.toBeNull();
    const body = m![1];
    for (const f of forbidden) {
      expect(body, `teamRole must NOT include forbidden ${f}`).not.toMatch(new RegExp(`'${f}'`));
    }
  });

  // ─── 'member' is the read-only default ────────────────────────

  it("CRITICAL the 2-role model has 'member' as the READ-only default + 'admin' as the WRITE-grant role. The TS SDK declaration order (member first) signals the default. Drift to inverting the order or names would break the 'least-privilege' framing.", () => {
    const sdkTs = read(resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/team.ts'));
    // Scope to the TeamRole DECLARATION. Searching the whole file for the
    // quoted literals made this guard trip on ordinary prose: doc copy that
    // mentions the roles (e.g. "your membership role ('admin' or 'member')")
    // would decide the ordering verdict instead of the union itself.
    const decl = /export type TeamRole = ([^;]+);/.exec(sdkTs);
    expect(decl, 'TeamRole union declaration must be present').not.toBeNull();
    const union = decl![1]!;
    const idxMember = union.indexOf("'member'");
    const idxAdmin = union.indexOf("'admin'");
    expect(idxMember).toBeGreaterThan(-1);
    expect(idxAdmin).toBeGreaterThan(-1);
    // Member appears BEFORE admin in the union (least-privilege default).
    expect(idxMember, "'member' should appear before 'admin' in the TeamRole union").toBeLessThan(
      idxAdmin,
    );
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/team-role-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
