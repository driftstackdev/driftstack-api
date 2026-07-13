// W830 — cross-SDK TeamResource methods parity. One-hundred-fifty-
// sixth in the drift-guard series. Pins the TeamResource method set
// (V-298c RBAC — Team membership + invites) across all 3 SDKs.
// Drift would break customer-dashboard /team page + the team-mgmt
// flows that admins rely on.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TS = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/team.ts');
const PY = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack/resources/team.py');
const GO = resolve(REPO_ROOT, 'packages/sdk-go/team.go');

// 6 shared method names cross-SDK.
const REQUIRED_METHODS: Array<[string, string, string]> = [
  ['invite', 'invite', 'Invite'],
  ['listMembers', 'list_members', 'ListMembers'],
  ['listInvites', 'list_invites', 'ListInvites'],
  ['listOwners', 'list_owners', 'ListOwners'],
  ['acceptInvite', 'accept_invite', 'AcceptInvite'],
  ['removeMember', 'remove_member', 'RemoveMember'],
];

describe('W830 cross-SDK TeamResource methods parity', () => {
  it('all 3 TeamResource files exist at canonical paths', () => {
    expect(existsSync(TS)).toBe(true);
    expect(existsSync(PY)).toBe(true);
    expect(existsSync(GO)).toBe(true);
  });

  // ─── 6-required-method set ────────────────────────────────────

  it('CRITICAL all 6 TeamResource methods exist in all 3 SDKs, including the inverse owner-workspace listing', () => {
    const ts = read(TS);
    const py = read(PY);
    const go = read(GO);

    for (const [tsName, pyName, goName] of REQUIRED_METHODS) {
      expect(ts, `TS missing '${tsName}('`).toMatch(new RegExp(`\\b${tsName}\\s*\\(`));
      expect(py, `Python missing 'def ${pyName}('`).toMatch(new RegExp(`def ${pyName}\\(`));
      expect(go, `Go missing 'func (r *TeamResource) ${goName}('`).toMatch(
        new RegExp(`func \\(r \\*TeamResource\\) ${goName}\\(`),
      );
    }
  });

  // ─── invite() takes email + optional role ─────────────────────

  it('CRITICAL invite() takes email + optional role cross-SDK. TS: invite(email, options: InviteOptions = {}); Python: invite(email, *, role: TeamRole | None = None) — kwarg-only; Go: Invite(ctx, body *TeamInviteRequest). Drift to required-role would break customer code that invites with the default-role (V-298c).', () => {
    expect(read(TS)).toMatch(
      /invite\(email: string, options: InviteOptions = \{\}\): Promise<\{ message: string \}>/,
    );
    expect(read(PY)).toMatch(
      /def invite\(self, email: str, \*, role: TeamRole \| None = None\) -> dict\[str, Any\]:/,
    );
    expect(read(GO)).toMatch(
      /Invite\(ctx context\.Context, body \*TeamInviteRequest\) \(\*TeamInviteResponse, error\)/,
    );
  });

  // ─── acceptInvite(token) returns AcceptInviteResponse ─────────

  it('CRITICAL acceptInvite(token) returns AcceptInviteResponse cross-SDK. TS: Promise<AcceptInviteResponse>; Python: -> AcceptInviteResponse (typed); Go: *TeamAcceptResponse + error. The response carries the new membership_id which is required for subsequent revoke flows.', () => {
    expect(read(TS)).toMatch(/acceptInvite\(token: string\): Promise<AcceptInviteResponse>/);
    expect(read(PY)).toMatch(/def accept_invite\(self, token: str\) -> AcceptInviteResponse:/);
    expect(read(GO)).toMatch(
      /AcceptInvite\(ctx context\.Context, token string\) \(\*TeamAcceptResponse, error\)/,
    );
  });

  // ─── removeMember(id) returns void ────────────────────────────

  it('CRITICAL removeMember(membershipId) returns void cross-SDK. TS Promise<void> / Python -> None / Go error-only. HTTP 204 per API.', () => {
    expect(read(TS)).toMatch(/removeMember\(membershipId: string\): Promise<void>/);
    expect(read(PY)).toMatch(/def remove_member\(self, membership_id: str\) -> None:/);
    expect(read(GO)).toMatch(/RemoveMember\(ctx context\.Context, membershipID string\) error/);
  });

  // ─── list methods return typed envelopes ─────────────────────

  it('CRITICAL members, invites, and owner workspaces return typed list responses cross-SDK', () => {
    expect(read(TS)).toMatch(/listMembers\(\): Promise<TeamMembersList>/);
    expect(read(TS)).toMatch(/listInvites\(\): Promise<TeamInvitesList>/);
    expect(read(TS)).toMatch(/listOwners\(\): Promise<TeamOwnersList>/);
    expect(read(PY)).toMatch(/def list_members\(self\) -> TeamMembersList:/);
    expect(read(PY)).toMatch(/def list_invites\(self\) -> TeamInvitesList:/);
    expect(read(PY)).toMatch(/def list_owners\(self\) -> TeamOwnersList:/);
    expect(read(GO)).toMatch(/ListMembers\(ctx context\.Context\) \(\*TeamMembersList, error\)/);
    expect(read(GO)).toMatch(/ListInvites\(ctx context\.Context\) \(\*TeamInvitesList, error\)/);
    expect(read(GO)).toMatch(/ListOwners\(ctx context\.Context\) \(\*TeamOwnersList, error\)/);
  });

  // ─── Python TeamRole typed enum import ────────────────────────

  it("CRITICAL Python imports TeamRole enum (typed) for the invite role param. The 'role: TeamRole | None = None' typing is what makes the role-restricted-to-enum contract enforceable at type-check time.", () => {
    const p = read(PY);
    expect(p).toMatch(/TeamRole/);
  });

  // ─── Python sync + async dual ─────────────────────────────────

  it('CRITICAL Python provides BOTH TeamResource (sync) AND AsyncTeamResource (async). Every method has an async counterpart.', () => {
    const p = read(PY);
    for (const [, pyName] of REQUIRED_METHODS) {
      expect(p, `Python AsyncTeamResource missing 'async def ${pyName}'`).toMatch(
        new RegExp(`async def ${pyName}\\(`),
      );
    }
  });

  // ─── Go ctx-first convention ──────────────────────────────────

  it('CRITICAL Go TeamResource methods all take ctx context.Context as first arg. Matches W822-W829 cross-SDK Go convention.', () => {
    const p = read(GO);
    for (const [, , goName] of REQUIRED_METHODS) {
      expect(p, `Go ${goName} must take ctx context.Context as first arg`).toMatch(
        new RegExp(`func \\(r \\*TeamResource\\) ${goName}\\(\\s*ctx context\\.Context`),
      );
    }
  });

  // ─── Python __init__ wiring ───────────────────────────────────

  it('CRITICAL Python TeamResource + AsyncTeamResource constructors take http client. Matches W822-W829 cross-SDK wiring.', () => {
    const p = read(PY);
    expect(p).toMatch(/def __init__\(self, http: HttpClient\) -> None:/);
    expect(p).toMatch(/def __init__\(self, http: AsyncHttpClient\) -> None:/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-team-resource-cross-sdk-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
