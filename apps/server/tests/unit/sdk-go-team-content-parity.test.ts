// W591.A — drift guard for packages/sdk-go/team.go.
// TeamResource Go parity. V-298c routes + V-298d auth-path gate.

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

  it('TeamResource framing + V-298c routes + V-298d auth-path-not-yet-permissioned + 5 verbs (Invite nil-body-default + ListMembers + ListInvites + AcceptInvite + RemoveMember idempotent DELETE quote-escaped membershipID) pinned', () => {
    expect(body).toMatch(/\/\/ TeamResource handles \/v1\/team\/\*\. V-298c routes; auth path/);
    expect(body).toMatch(/\/\/ integration is V-298d — accepted members can sign in but the/);
    expect(body).toMatch(/\/\/ membership grants no implicit permissions on the owner's resources/);
    expect(body).toMatch(/\/\/ until V-298d ships\./);
    expect(body).toMatch(/^type TeamResource struct \{\s*\n\s*client \*Client\s*\n\}/m);
    expect(body).toMatch(
      /func \(r \*TeamResource\) Invite\(ctx context\.Context, body \*TeamInviteRequest\) \(\*TeamInviteResponse, error\) \{\s*\n\s*if body == nil \{\s*\n\s*body = &TeamInviteRequest\{\}\s*\n\s*\}/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/team\/invites",/);
    expect(body).toMatch(/\/\/ ListMembers returns confirmed memberships for the calling owner\./);
    expect(body).toMatch(/path:\s+"\/v1\/team\/members",/);
    expect(body).toMatch(
      /\/\/ ListInvites returns pending \(unaccepted, unexpired\) invites for the/,
    );
    expect(body).toMatch(
      /func \(r \*TeamResource\) AcceptInvite\(ctx context\.Context, token string\) \(\*TeamAcceptResponse, error\) \{/,
    );
    expect(body).toMatch(/body:\s+&TeamAcceptRequest\{Token: token\},/);
    expect(body).toMatch(/path:\s+"\/v1\/team\/invites\/accept",/);
    expect(body).toMatch(
      /func \(r \*TeamResource\) RemoveMember\(ctx context\.Context, membershipID string\) error \{\s*\n\s*return r\.client\.do\(ctx, requestOptions\{\s*\n\s*method: "DELETE",\s*\n\s*path:\s+"\/v1\/team\/members\/" \+ url\.PathEscape\(membershipID\),\s*\n\s*\}\)\s*\n\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
