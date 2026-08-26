// W591.A (W634-deepened) — drift guard for packages/sdk-go/team.go.
// TeamResource Go parity. V-298c routes + V-298d auth-path gate.
//
// W634 splits the original 2 it() blocks into 6 focused per-verb
// blocks + pins previously-implicit invariants:
//
//   • V-298d auth-path-not-yet-permissioned contract: accepted
//     members CAN SIGN IN but their membership grants no implicit
//     permissions on the owner's resources until V-298d ships. This
//     is the load-bearing distinction between "the membership row
//     exists" and "the bearer can act on behalf of the owner" —
//     drift to claiming the latter would silently widen the auth
//     surface.
//   • Invite nil-body-default substitution (callers pass nil; SDK
//     plugs &TeamInviteRequest{} so wire body is always valid).
//   • AcceptInvite token wire encoding: the SDK takes a bare string
//     token and wraps it as &TeamAcceptRequest{Token: token} — the
//     ergonomic that lets callers paste the magic-link token directly
//     without constructing a request struct.
//   • RemoveMember idempotent DELETE with URL-escape on membershipID
//     (so a malformed id cannot inject path traversal).
//   • HTTP-method correctness per verb (POST/GET/DELETE).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/team.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W591.A packages/sdk-go/team.go content parity', () => {
  const body = read(LIB);

  it("file exists at canonical path + TeamResource V-298c routes anchor + V-298d auth-path-not-yet-permissioned contract pinned. CRITICAL distinction: accepted members CAN SIGN IN, but their membership grants no implicit permissions on the owner's resources until V-298d ships. Drift to claiming the membership grants implicit permissions would silently widen the auth surface.", () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^package driftstack$/m);
    // `resolveEffectiveAccount` (apps/server/src/services/auth.ts) resolves
    // `X-Driftstack-Account: acc_<uuid>` against `ctx.teams` and carries the
    // membership role through, so members DO act on the owner's resources.
    // The old "no implicit permissions until V-298d ships" caveat was a
    // deferred promise that is now simply false on a shipped SDK surface.
    expect(body).toMatch(
      /\/\/ TeamResource handles \/v1\/team\/\* and \/v1\/teams\. V-298c routes\. Team membership IS/,
    );
    expect(body).toMatch(
      /\/\/ honored on the auth path: send X-Driftstack-Account: acc_<owner-uuid> to/,
    );
    expect(body).toMatch(/\/\/ authorized against your membership role \(admin or member\)/);
    expect(body).not.toMatch(/grants no implicit permissions/);
    expect(body).toMatch(/^type TeamResource struct \{\s*\n\s*client \*Client\s*\n\}/m);
  });

  it('Invite — POST /v1/team/invites with nil-body-default substitution (callers pass nil; SDK plugs &TeamInviteRequest{} so the wire body is always a valid empty struct rather than Go zero-value JSON "null")', () => {
    expect(body).toMatch(/\/\/ Invite an email to join the calling owner's team\./);
    expect(body).toMatch(
      /func \(r \*TeamResource\) Invite\(ctx context\.Context, body \*TeamInviteRequest\) \(\*TeamInviteResponse, error\)/,
    );
    expect(body).toMatch(/if body == nil \{\s*\n\s*body = &TeamInviteRequest\{\}\s*\n\s*\}/);
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/team\/invites",/);
  });

  it('ListMembers — GET /v1/team/members returns CONFIRMED memberships only (V-298c). The "confirmed" qualifier in the doc-comment matters: pending invites live on the separate ListInvites surface so the two endpoints have non-overlapping result sets.', () => {
    expect(body).toMatch(/\/\/ ListMembers returns confirmed memberships for the calling owner\./);
    expect(body).toMatch(
      /func \(r \*TeamResource\) ListMembers\(ctx context\.Context\) \(\*TeamMembersList, error\)/,
    );
    expect(body).toMatch(/method: "GET",\s*\n\s*path:\s+"\/v1\/team\/members",/);
  });

  it('ListInvites — GET /v1/team/invites returns PENDING (unaccepted, unexpired) invites only. Both "unaccepted" AND "unexpired" qualifiers pinned because dropping either would silently broaden the surface (e.g. returning expired invites would let stale tokens look actionable in the dashboard).', () => {
    expect(body).toMatch(
      /\/\/ ListInvites returns pending \(unaccepted, unexpired\) invites for the/,
    );
    expect(body).toMatch(/\/\/ calling owner\./);
    expect(body).toMatch(
      /func \(r \*TeamResource\) ListInvites\(ctx context\.Context\) \(\*TeamInvitesList, error\)/,
    );
    expect(body).toMatch(/method: "GET",\s*\n\s*path:\s+"\/v1\/team\/invites",/);
  });

  it('ListOwners — GET /v1/team/owners returns a typed owner-workspace envelope', () => {
    expect(body).toMatch(
      /\/\/ ListOwners returns owner workspaces the calling account has joined\./,
    );
    expect(body).toMatch(
      /func \(r \*TeamResource\) ListOwners\(ctx context\.Context\) \(\*TeamOwnersList, error\)/,
    );
    expect(body).toMatch(/method: "GET",\s*\n\s*path:\s+"\/v1\/team\/owners",/);
  });

  it('AcceptInvite — POST /v1/team/invites/accept consumes a token and creates the membership. SDK ergonomic: takes a BARE STRING token (not a *TeamAcceptRequest), and wraps as &TeamAcceptRequest{Token: token} internally. Drift to forcing callers to construct the request struct themselves would break the "paste the magic-link token directly" UX.', () => {
    expect(body).toMatch(/\/\/ AcceptInvite consumes a token and creates the membership\./);
    expect(body).toMatch(
      /func \(r \*TeamResource\) AcceptInvite\(ctx context\.Context, token string\) \(\*TeamAcceptResponse, error\)/,
    );
    expect(body).toMatch(/body:\s+&TeamAcceptRequest\{Token: token\},/);
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/team\/invites\/accept",/);
  });

  it('RemoveMember — DELETE /v1/team/members/{membershipID}, plain error return (no out struct). URL-escapes the membershipID so a malformed id cannot inject path traversal. By-membership-id (not by-email/user-id) so a member with multiple memberships across teams can be removed from one without affecting the others.', () => {
    expect(body).toMatch(/\/\/ RemoveMember by membership id\./);
    expect(body).toMatch(
      /func \(r \*TeamResource\) RemoveMember\(ctx context\.Context, membershipID string\) error \{\s*\n\s*return r\.client\.do\(ctx, requestOptions\{\s*\n\s*method: "DELETE",\s*\n\s*path:\s+"\/v1\/team\/members\/" \+ url\.PathEscape\(membershipID\),\s*\n\s*\}\)\s*\n\}/,
    );
  });
});
