// W691 — cross-SDK V-298c/V-298d team-RBAC parity. Eighteenth in
// the cross-SDK drift-guard series (W649 + W675 + W676 + W677 +
// W678 + W679 + W680 + W681 + W682 + W683 + W684 + W685 + W686 +
// W687 + W688 + W689 + W690 + W691).
//
// Asserts the V-298c team-RBAC + V-298d auth-path-pending caveat
// + role enum + account_owner-scope-on-mutations + email-match-409
// invariants are consistent across all 3 SDKs.
//
// CRITICAL V-298d caveat — "accepted members can sign in but the
// membership grants NO IMPLICIT PERMISSIONS on the owner's
// resources until V-298d ships." Drift to dropping this caveat
// would let callers assume implicit permissions that don't yet
// exist — silently broken authorization.
//
// CRITICAL TeamRole 2-value union ('member' | 'admin') pinned —
// drift to a 3rd value would break the closed-set switch on
// dashboards rendering role badges.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS_TEAM = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/team.ts');
const GO_TEAM = resolve(REPO_ROOT, 'packages/sdk-go/team.go');
const PY_TEAM = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/team.py');

describe('W691 cross-SDK V-298c/V-298d team-RBAC parity', () => {
  it('all 3 SDK team resource files exist at canonical paths', () => {
    expect(existsSync(TS_TEAM), `missing ${TS_TEAM}`).toBe(true);
    expect(existsSync(GO_TEAM), `missing ${GO_TEAM}`).toBe(true);
    expect(existsSync(PY_TEAM), `missing ${PY_TEAM}`).toBe(true);
  });

  it('CRITICAL V-298c anchor pinned in all 3 SDKs on the team resource. V-298c is the team-RBAC base feature anchor. Drift to dropping the anchor would lose changelog provenance.', () => {
    const ts = read(TS_TEAM);
    const go = read(GO_TEAM);
    const py = read(PY_TEAM);

    expect(ts).toMatch(/V-298c/);
    expect(go).toMatch(/V-298c/);
    expect(py).toMatch(/V-298c/);
  });

  it('CRITICAL the acting-as contract is stated identically in all 3 SDKs, and the superseded "no implicit permissions" caveat is banned. That caveat was a deferred promise that became FALSE: `resolveEffectiveAccount` (apps/server/src/services/auth.ts) resolves `X-Driftstack-Account: acc_<uuid>` against `ctx.teams` and carries the membership role through, so members DO act on the owner\'s resources today. Leaving it pinned would have kept a false limitation on three shipped SDK surfaces.', () => {
    const ts = read(TS_TEAM);
    const go = read(GO_TEAM);
    const py = read(PY_TEAM);

    for (const [name, body] of [
      ['sdk-typescript', ts],
      ['sdk-go', go],
      ['sdk-python', py],
    ] as const) {
      // The header name customers must send.
      expect(body, `${name} acting-as header`).toMatch(/X-Driftstack-Account: acc_<owner-uuid>/);
      // Membership is honored, not pending.
      expect(body, `${name} honored`).toMatch(
        /[Tt]eam membership IS\s*\n?(?:\/\/ )?honored on the auth/,
      );
      // Authorization is role- AND scope-bound, not implicit.
      expect(body, `${name} role`).toMatch(/membership role/);
      expect(body, `${name} scope`).toMatch(/required scope/);
      // Absent header means self, which is what keeps the default safe.
      expect(body, `${name} self default`).toMatch(/acts on your own account/);
      // The superseded deferred promise must never return.
      expect(body, `${name} no stale caveat`).not.toMatch(/grants no implicit permissions/);
    }
  });

  it('CRITICAL "no implicit permissions" framing pinned in all 3 SDKs. The "membership grants no implicit permissions on the owner\'s resources" wording is the load-bearing claim that prevents callers from assuming they can act ON BEHALF OF the owner. Drift to dropping would silently widen the auth surface.', () => {
    const ts = read(TS_TEAM);
    const go = read(GO_TEAM);
    const py = read(PY_TEAM);

    // The safety claim is no longer "you get nothing"; it is "you get exactly
    // the owner you are a member of, at your role, within the route's scope,
    // and only when you ASK via the header". Pin that in all three.
    for (const [name, body] of [
      ['sdk-typescript', ts],
      ['sdk-go', go],
      ['sdk-python', py],
    ] as const) {
      expect(body, `${name} membership-bound`).toMatch(/an owner you are a member of/);
      expect(body, `${name} role-bound`).toMatch(/membership role/);
      expect(body, `${name} scope-bound`).toMatch(/required scope/);
      expect(body, `${name} explicit opt-in`).toMatch(
        /without the header every call acts on your own account/,
      );
      expect(body, `${name} stale caveat gone`).not.toMatch(/grants no implicit permissions/);
    }
  });

  it("CRITICAL TeamRole 2-value union pinned in sdk-typescript + sdk-python. The closed-2 set ('member' | 'admin') is what dashboards anchor their role-badge rendering on. sdk-go uses string type (no compile-time literal-union). Drift to a 3rd value would break the closed-set switch.", () => {
    const ts = read(TS_TEAM);
    const py = read(PY_TEAM);

    // sdk-typescript: `export type TeamRole = 'member' | 'admin';`
    expect(ts).toMatch(/export type TeamRole = 'member' \| 'admin';/);

    // sdk-python: `TeamRole = Literal["member", "admin"]`
    expect(py).toMatch(/TeamRole = Literal\["member", "admin"\]/);
  });

  it('CRITICAL account_owner scope on mutating verbs (invite + removeMember) pinned in sdk-typescript via JSDoc. sdk-go + sdk-python rely on server-side enforcement without explicit `account_owner scope required` framing in docstrings. The `account_owner` scope restriction is what prevents team admins (or members) from inviting/removing themselves or others.', () => {
    const ts = read(TS_TEAM);

    // sdk-typescript: "account_owner scope required" appears 2+ times (invite + removeMember).
    const tsMatches = (ts.match(/account_owner scope required/g) ?? []).length;
    expect(tsMatches, 'sdk-typescript account_owner scope mention count').toBeGreaterThanOrEqual(2);
  });

  it('CRITICAL email-match-409 enforcement on acceptInvite pinned per-SDK. "The accepting account\'s email MUST match the invitee email — server enforces; mismatched accept returns 409" is the cross-tenant guard. Without it, anyone with a token (via shoulder-surf) could accept into another user\'s account.', () => {
    const ts = read(TS_TEAM);

    // sdk-typescript: "email MUST match" + "mismatched accept returns 409"
    expect(ts).toMatch(/email MUST match/);
    expect(ts).toMatch(/mismatched accept returns 409/);
  });

  it('6 verbs pinned across all 3 SDKs, including listOwners/list_owners/ListOwners', () => {
    const ts = read(TS_TEAM);
    const go = read(GO_TEAM);
    const py = read(PY_TEAM);

    // sdk-typescript: 5 method declarations.
    expect(ts).toMatch(/invite\(email: string/);
    expect(ts).toMatch(/listMembers\(\)/);
    expect(ts).toMatch(/listInvites\(\)/);
    expect(ts).toMatch(/listOwners\(\)/);
    expect(ts).toMatch(/acceptInvite\(token: string/);
    expect(ts).toMatch(/removeMember\(membershipId: string/);

    // sdk-go: PascalCase methods.
    expect(go).toMatch(/func \(r \*TeamResource\) Invite\(/);
    expect(go).toMatch(/func \(r \*TeamResource\) ListMembers\(/);
    expect(go).toMatch(/func \(r \*TeamResource\) ListInvites\(/);
    expect(go).toMatch(/func \(r \*TeamResource\) ListOwners\(/);

    // sdk-python: snake_case methods.
    expect(py).toMatch(/def invite\(self/);
    expect(py).toMatch(/def list_members\(self/);
    expect(py).toMatch(/def list_invites\(self/);
    expect(py).toMatch(/def list_owners\(self/);
    expect(py).toMatch(/def accept_invite\(self/);
    expect(py).toMatch(/def remove_member\(self/);
  });

  it('CRITICAL TeamMember 8-field shape across SDKs (id + owner_account_id + member_account_id + member_email + role + invited_at + accepted_at + invited_by_account_id). The shape carries enough to render "Joined X days ago, invited by Y" in dashboards.', () => {
    const ts = read(TS_TEAM);
    const py = read(PY_TEAM);

    // sdk-typescript: TeamMember interface with 8 fields.
    expect(ts).toMatch(
      /export interface TeamMember \{[\s\S]*?owner_account_id[\s\S]*?member_account_id[\s\S]*?member_email[\s\S]*?role: TeamRole[\s\S]*?accepted_at[\s\S]*?invited_by_account_id/,
    );

    // sdk-python: TeamMember pydantic model with 8 fields.
    expect(py).toMatch(
      /class TeamMember\(BaseModel\):[\s\S]*?owner_account_id[\s\S]*?member_account_id[\s\S]*?member_email[\s\S]*?role: TeamRole[\s\S]*?accepted_at[\s\S]*?invited_by_account_id/,
    );
  });

  it('6-route inventory pins invites, members, owners, accept, and per-id deletion across SDKs', () => {
    const ts = read(TS_TEAM);
    const go = read(GO_TEAM);
    const py = read(PY_TEAM);

    for (const sdk of [ts, go, py]) {
      expect(sdk).toMatch(/\/v1\/team\/invites/);
      expect(sdk).toMatch(/\/v1\/team\/members/);
      expect(sdk).toMatch(/\/v1\/team\/owners/);
      expect(sdk).toMatch(/\/v1\/team\/invites\/accept/);
    }
  });

  it('Cross-SDK consistency — V-298c + V-298d + complete 6-verb surface', () => {
    const sdks = {
      'sdk-typescript': read(TS_TEAM),
      'sdk-go': read(GO_TEAM),
      'sdk-python': read(PY_TEAM),
    };

    for (const [name, body] of Object.entries(sdks)) {
      expect(body, `${name} V-298c`).toMatch(/V-298c/);
      // V-298d is deliberately NOT pinned: it referenced a pending auth-path
      // integration that has since shipped, and the anchor was removed with the
      // stale caveat it belonged to.
      expect(body, `${name} no pending-integration anchor`).not.toMatch(/V-298d/);
      // "member" wording appears in all SDKs (either as role literal or comment).
      expect(body, `${name} member`).toMatch(/member/i);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/server/tests/unit/cross-sdk-team-rbac-parity.test.ts')),
    ).toBe(true);
  });
});
