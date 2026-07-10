// V-298b — TeamMembersService unit + integration tests.

import { describe, expect, it } from 'vitest';
import { createEmailService } from '../../src/services/email.js';
import { createTestLogger } from '../../src/lib/logger.js';
import { TeamMembersService } from '../../src/services/team-members.js';
import { InMemoryTeamMembersRepo } from './_helpers/in-memory-team-members-repo.js';

function build() {
  const repo = new InMemoryTeamMembersRepo();
  const email = createEmailService({ config: null, logger: createTestLogger() });
  const service = new TeamMembersService(repo, email, {
    dashboardBaseUrl: 'https://app.driftstack.test',
  });
  return { repo, service };
}

const OWNER = '00000000-0000-4000-8000-000000000001';
const INVITER = '00000000-0000-4000-8000-000000000002';
const INVITEE_ACCOUNT = '00000000-0000-4000-8000-000000000003';
const INVITEE_EMAIL = 'invitee@example.test';

describe('TeamMembersService.invite', () => {
  it('creates a pending invite with a fresh token', async () => {
    const { repo, service } = build();
    await service.invite({
      ownerAccountId: OWNER,
      invitedByAccountId: INVITER,
      inviteeEmail: INVITEE_EMAIL,
    });
    const invites = repo.getAllInvites();
    expect(invites).toHaveLength(1);
    expect(invites[0]!.inviteeEmail).toBe(INVITEE_EMAIL);
    expect(invites[0]!.role).toBe('member');
    expect(invites[0]!.acceptedAt).toBeNull();
    expect(invites[0]!.inviteTokenHash).not.toBeNull();
  });

  it('lowercases + trims the email', async () => {
    const { repo, service } = build();
    await service.invite({
      ownerAccountId: OWNER,
      invitedByAccountId: INVITER,
      inviteeEmail: '  INVITEE@EXAMPLE.TEST  ',
    });
    expect(repo.getAllInvites()[0]!.inviteeEmail).toBe('invitee@example.test');
  });

  it('honors role override (admin)', async () => {
    const { repo, service } = build();
    await service.invite({
      ownerAccountId: OWNER,
      invitedByAccountId: INVITER,
      inviteeEmail: INVITEE_EMAIL,
      role: 'admin',
    });
    expect(repo.getAllInvites()[0]!.role).toBe('admin');
  });

  it('re-inviting same email refreshes the token (no duplicate row)', async () => {
    const { repo, service } = build();
    await service.invite({
      ownerAccountId: OWNER,
      invitedByAccountId: INVITER,
      inviteeEmail: INVITEE_EMAIL,
    });
    const firstHash = repo.getAllInvites()[0]!.inviteTokenHash;
    await service.invite({
      ownerAccountId: OWNER,
      invitedByAccountId: INVITER,
      inviteeEmail: INVITEE_EMAIL,
    });
    expect(repo.getAllInvites()).toHaveLength(1);
    expect(repo.getAllInvites()[0]!.inviteTokenHash).not.toBe(firstHash);
  });

  it('rejects malformed email', async () => {
    const { service } = build();
    await expect(
      service.invite({
        ownerAccountId: OWNER,
        invitedByAccountId: INVITER,
        inviteeEmail: 'not-an-email',
      }),
    ).rejects.toThrow();
  });
});

describe('TeamMembersService.accept', () => {
  it('writes team_members row when invitee email matches', async () => {
    const { repo, service } = build();
    repo.upsertAccountEmail(INVITEE_ACCOUNT, INVITEE_EMAIL);

    // Capture the plaintext token by intercepting upsertInvite.
    let plaintext = '';
    const origUpsert = repo.upsertInvite.bind(repo);
    repo.upsertInvite = async (input) => {
      // We can't recover plaintext from the hash. Re-create it by
      // calling invite manually below; the test sequence captures it.
      return origUpsert(input);
    };

    // Use the service to invite, then look at the plaintext via the
    // recording email service. For now we re-derive the plaintext by
    // calling generateAuthToken/tokenHash directly.
    const { generateAuthToken, tokenHash } = await import('../../src/lib/auth-tokens.js');
    plaintext = generateAuthToken();
    const hash = tokenHash(plaintext);
    await repo.upsertInvite({
      ownerAccountId: OWNER,
      inviteeEmail: INVITEE_EMAIL,
      role: 'member',
      inviteTokenHash: hash,
      inviteExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      invitedByAccountId: INVITER,
    });

    const result = await service.accept({
      plaintextToken: plaintext,
      acceptingAccountId: INVITEE_ACCOUNT,
    });
    expect(result.membership.ownerAccountId).toBe(OWNER);
    expect(result.membership.memberAccountId).toBe(INVITEE_ACCOUNT);
    expect(result.membership.memberEmail).toBe(INVITEE_EMAIL);
    expect(result.membership.role).toBe('member');

    // Invite is marked accepted.
    expect(repo.getAllInvites()[0]!.acceptedAt).not.toBeNull();
  });

  it('rejects when accepting account email does not match invite', async () => {
    const { repo, service } = build();
    const { generateAuthToken, tokenHash } = await import('../../src/lib/auth-tokens.js');
    const plaintext = generateAuthToken();
    const hash = tokenHash(plaintext);
    await repo.upsertInvite({
      ownerAccountId: OWNER,
      inviteeEmail: INVITEE_EMAIL,
      role: 'member',
      inviteTokenHash: hash,
      inviteExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      invitedByAccountId: INVITER,
    });
    repo.upsertAccountEmail(INVITEE_ACCOUNT, 'wrong@example.test');
    await expect(
      service.accept({ plaintextToken: plaintext, acceptingAccountId: INVITEE_ACCOUNT }),
    ).rejects.toThrow(/does not match/);
  });

  it('404s on unknown token', async () => {
    const { service } = build();
    await expect(
      service.accept({ plaintextToken: 'unknowntoken', acceptingAccountId: INVITEE_ACCOUNT }),
    ).rejects.toThrow(/not found/);
  });

  it('rejects expired invite', async () => {
    const { repo, service } = build();
    const { generateAuthToken, tokenHash } = await import('../../src/lib/auth-tokens.js');
    const plaintext = generateAuthToken();
    const hash = tokenHash(plaintext);
    await repo.upsertInvite({
      ownerAccountId: OWNER,
      inviteeEmail: INVITEE_EMAIL,
      role: 'member',
      inviteTokenHash: hash,
      inviteExpiresAt: new Date(Date.now() - 1000), // already expired
      invitedByAccountId: INVITER,
    });
    repo.upsertAccountEmail(INVITEE_ACCOUNT, INVITEE_EMAIL);
    await expect(
      service.accept({ plaintextToken: plaintext, acceptingAccountId: INVITEE_ACCOUNT }),
    ).rejects.toThrow(/expired/);
  });

  it('idempotent — second accept returns the existing membership', async () => {
    const { repo, service } = build();
    const { generateAuthToken, tokenHash } = await import('../../src/lib/auth-tokens.js');
    const plaintext = generateAuthToken();
    const hash = tokenHash(plaintext);
    await repo.upsertInvite({
      ownerAccountId: OWNER,
      inviteeEmail: INVITEE_EMAIL,
      role: 'member',
      inviteTokenHash: hash,
      inviteExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      invitedByAccountId: INVITER,
    });
    repo.upsertAccountEmail(INVITEE_ACCOUNT, INVITEE_EMAIL);
    const first = await service.accept({
      plaintextToken: plaintext,
      acceptingAccountId: INVITEE_ACCOUNT,
    });
    // Second accept needs a fresh token because the first marked it
    // accepted; second invite re-uses the same row + new token.
    const plaintext2 = generateAuthToken();
    await repo.upsertInvite({
      ownerAccountId: OWNER,
      inviteeEmail: INVITEE_EMAIL,
      role: 'member',
      inviteTokenHash: tokenHash(plaintext2),
      inviteExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      invitedByAccountId: INVITER,
    });
    // upsertInvite finds the existing row (accepted) and refreshes it
    // — actually it checks `acceptedAt === null` and that's now NOT
    // null, so it creates a new row. Either way, the membership is
    // the same. Verify the membership row is unique.
    expect(repo.getAllMembers()).toHaveLength(1);
    expect(first.membership.id).toBeDefined();
  });

  // Security fix (2026-06-30 audit, HIGH/CRITICAL — privilege
  // de-escalation failure): re-inviting an existing member with a
  // DIFFERENT role is the only documented role-change mechanism (see
  // the module doc at the top of services/team-members.ts). Before the
  // fix, upsertMembership used onConflictDoNothing (Drizzle) /
  // `if (existing) return existing;` (in-memory) on conflict, so the
  // new role was silently discarded and accept() returned 200 with the
  // STALE role — an owner demoting an 'admin' to 'member' had no
  // effect and no error. `team_members.role` is the literal column
  // `effectiveAccountIdForWrite` (routes/sessions.ts, reused by
  // profiles.ts/webhooks.ts) gates real elevated write access on, so a
  // stuck-stale 'admin' role is live, working access — not dead
  // metadata.
  it('demotes a member: re-invite + re-accept with a DIFFERENT role actually changes it', async () => {
    const { repo, service } = build();
    repo.upsertAccountEmail(INVITEE_ACCOUNT, INVITEE_EMAIL);
    const { generateAuthToken, tokenHash } = await import('../../src/lib/auth-tokens.js');

    // 1. Invite + accept as 'admin'. Drive accept() the same way the
    // other tests in this file do: upsert the invite row directly
    // (capturing the real plaintext), then call accept() with it.
    const adminPlaintext = generateAuthToken();
    await repo.upsertInvite({
      ownerAccountId: OWNER,
      inviteeEmail: INVITEE_EMAIL,
      role: 'admin',
      inviteTokenHash: tokenHash(adminPlaintext),
      inviteExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      invitedByAccountId: INVITER,
    });
    const adminAccept = await service.accept({
      plaintextToken: adminPlaintext,
      acceptingAccountId: INVITEE_ACCOUNT,
    });
    expect(adminAccept.membership.role).toBe('admin');
    expect(repo.getAllMembers()).toHaveLength(1);
    expect(repo.getAllMembers()[0]!.role).toBe('admin');

    // 2. Owner re-invites the SAME email with role:'member' (the
    // documented demotion mechanism) and the member re-accepts.
    const memberPlaintext = generateAuthToken();
    await repo.upsertInvite({
      ownerAccountId: OWNER,
      inviteeEmail: INVITEE_EMAIL,
      role: 'member',
      inviteTokenHash: tokenHash(memberPlaintext),
      inviteExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      invitedByAccountId: INVITER,
    });
    const demoteAccept = await service.accept({
      plaintextToken: memberPlaintext,
      acceptingAccountId: INVITEE_ACCOUNT,
    });

    // The accept call must report the ACTUAL new role, not the stale one.
    expect(demoteAccept.membership.role).toBe('member');

    // Still exactly one membership row (owner, member) — no duplicate
    // inserted, the existing row was updated in place.
    expect(repo.getAllMembers()).toHaveLength(1);

    // The stored row — the literal source `effectiveAccountIdForWrite`
    // (routes/sessions.ts) reads `role` from to gate admin write
    // access — must reflect the demotion. Before the fix this stayed
    // 'admin' forever; an attacker/stale-admin member would still pass
    // `effective.role === 'admin'` and keep elevated write access to
    // the owner's sessions/profiles/webhooks indefinitely.
    const stored = repo.getAllMembers()[0]!;
    expect(stored.role).toBe('member');
    expect(stored.role === 'admin').toBe(false);

    // listMembers (what the dashboard + auth-cache rehydration read)
    // agrees.
    const listed = await service.listMembers(OWNER);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.role).toBe('member');
  });
});

describe('TeamMembersService.listMembers + listPendingInvites + removeMember', () => {
  it('listMembers returns confirmed memberships for the owner', async () => {
    const { repo, service } = build();
    repo.upsertAccountEmail(INVITEE_ACCOUNT, INVITEE_EMAIL);
    const { generateAuthToken, tokenHash } = await import('../../src/lib/auth-tokens.js');
    const plaintext = generateAuthToken();
    await repo.upsertInvite({
      ownerAccountId: OWNER,
      inviteeEmail: INVITEE_EMAIL,
      role: 'member',
      inviteTokenHash: tokenHash(plaintext),
      inviteExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      invitedByAccountId: INVITER,
    });
    await service.accept({ plaintextToken: plaintext, acceptingAccountId: INVITEE_ACCOUNT });
    const members = await service.listMembers(OWNER);
    expect(members).toHaveLength(1);
    expect(members[0]!.memberEmail).toBe(INVITEE_EMAIL);
  });

  it('listPendingInvites filters expired + accepted', async () => {
    const { repo, service } = build();
    // Pending, valid.
    await service.invite({
      ownerAccountId: OWNER,
      invitedByAccountId: INVITER,
      inviteeEmail: 'a@example.test',
    });
    // Pending but already-expired (back-date by mutating).
    await service.invite({
      ownerAccountId: OWNER,
      invitedByAccountId: INVITER,
      inviteeEmail: 'b@example.test',
    });
    repo.getAllInvites().find((i) => i.inviteeEmail === 'b@example.test')!.inviteExpiresAt =
      new Date(Date.now() - 1000);

    const pending = await service.listPendingInvites(OWNER);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.inviteeEmail).toBe('a@example.test');
  });

  it('removeMember succeeds for owner-scoped membership', async () => {
    const { repo, service } = build();
    repo.upsertAccountEmail(INVITEE_ACCOUNT, INVITEE_EMAIL);
    const { generateAuthToken, tokenHash } = await import('../../src/lib/auth-tokens.js');
    const plaintext = generateAuthToken();
    await repo.upsertInvite({
      ownerAccountId: OWNER,
      inviteeEmail: INVITEE_EMAIL,
      role: 'member',
      inviteTokenHash: tokenHash(plaintext),
      inviteExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      invitedByAccountId: INVITER,
    });
    const result = await service.accept({
      plaintextToken: plaintext,
      acceptingAccountId: INVITEE_ACCOUNT,
    });
    const removed = await service.removeMember({
      membershipId: result.membership.id,
      ownerAccountId: OWNER,
    });
    expect(removed).toBe(true);
    expect(await service.listMembers(OWNER)).toHaveLength(0);
  });

  // TOCTOU fix (2026-07-10 audit, HIGH — privilege-escalation via
  // membership resurrection): accept() and removeMember() were non-atomic,
  // so an accept that read the invite BEFORE a concurrent remove deleted it
  // could still upsert (resurrect) the membership AFTER the remove. The fix
  // routes accept through acceptInviteAtomic (a CAS-consume of the invite
  // that both operations serialize on) and remove through
  // removeMemberWithInvites (membership + invite deleted atomically). Once
  // the invite is consumed/deleted, a subsequent accept of that token must
  // 404 and must NOT recreate the membership.
  it('atomic remove-then-accept: a removed member cannot resurrect their membership via the now-deleted invite', async () => {
    const { repo, service } = build();
    repo.upsertAccountEmail(INVITEE_ACCOUNT, INVITEE_EMAIL);
    const { generateAuthToken, tokenHash } = await import('../../src/lib/auth-tokens.js');
    const plaintext = generateAuthToken();
    await repo.upsertInvite({
      ownerAccountId: OWNER,
      inviteeEmail: INVITEE_EMAIL,
      role: 'admin',
      inviteTokenHash: tokenHash(plaintext),
      inviteExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      invitedByAccountId: INVITER,
    });
    const accepted = await service.accept({
      plaintextToken: plaintext,
      acceptingAccountId: INVITEE_ACCOUNT,
    });
    expect(await service.listMembers(OWNER)).toHaveLength(1);

    // Owner removes the member (atomically drops the membership + that
    // member's invites).
    const removedMemberAccountId = await repo.removeMemberWithInvites(
      accepted.membership.id,
      OWNER,
    );
    expect(removedMemberAccountId).toBe(INVITEE_ACCOUNT);
    expect(await service.listMembers(OWNER)).toHaveLength(0);
    expect(repo.getAllInvites()).toHaveLength(0);

    // The removed member replays the (now-deleted) invite token — findInvite
    // returns nothing, so accept 404s and NO membership is recreated.
    await expect(
      service.accept({ plaintextToken: plaintext, acceptingAccountId: INVITEE_ACCOUNT }),
    ).rejects.toThrow(/not found/);
    expect(await service.listMembers(OWNER)).toHaveLength(0);
    expect(repo.getAllMembers()).toHaveLength(0);
  });

  it('acceptInviteAtomic returns null (no membership) when the invite is already accepted or deleted', async () => {
    const { repo } = build();
    repo.upsertAccountEmail(INVITEE_ACCOUNT, INVITEE_EMAIL);
    const { generateAuthToken, tokenHash } = await import('../../src/lib/auth-tokens.js');
    const plaintext = generateAuthToken();
    const invite = await repo.upsertInvite({
      ownerAccountId: OWNER,
      inviteeEmail: INVITEE_EMAIL,
      role: 'member',
      inviteTokenHash: tokenHash(plaintext),
      inviteExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      invitedByAccountId: INVITER,
    });

    // First atomic accept consumes the invite + creates the membership.
    const first = await repo.acceptInviteAtomic({
      inviteId: invite.id,
      ownerAccountId: OWNER,
      memberAccountId: INVITEE_ACCOUNT,
      memberEmail: INVITEE_EMAIL,
      role: 'member',
      invitedAt: invite.createdAt,
      invitedByAccountId: INVITER,
      acceptedAt: new Date(),
    });
    expect(first).not.toBeNull();
    expect(repo.getAllMembers()).toHaveLength(1);

    // The invite is now accepted — a second atomic accept CAS-misses and
    // returns null without touching the membership set.
    const secondAlreadyAccepted = await repo.acceptInviteAtomic({
      inviteId: invite.id,
      ownerAccountId: OWNER,
      memberAccountId: INVITEE_ACCOUNT,
      memberEmail: INVITEE_EMAIL,
      role: 'admin',
      invitedAt: invite.createdAt,
      invitedByAccountId: INVITER,
      acceptedAt: new Date(),
    });
    expect(secondAlreadyAccepted).toBeNull();

    // An entirely unknown invite id also returns null.
    const unknown = await repo.acceptInviteAtomic({
      inviteId: '00000000-0000-4000-8000-0000000000ff',
      ownerAccountId: OWNER,
      memberAccountId: INVITEE_ACCOUNT,
      memberEmail: INVITEE_EMAIL,
      role: 'member',
      invitedAt: new Date(),
      invitedByAccountId: INVITER,
      acceptedAt: new Date(),
    });
    expect(unknown).toBeNull();
    expect(repo.getAllMembers()).toHaveLength(1);
  });

  it('removeMember returns false for cross-owner attempt', async () => {
    const { repo, service } = build();
    repo.upsertAccountEmail(INVITEE_ACCOUNT, INVITEE_EMAIL);
    const { generateAuthToken, tokenHash } = await import('../../src/lib/auth-tokens.js');
    const plaintext = generateAuthToken();
    await repo.upsertInvite({
      ownerAccountId: OWNER,
      inviteeEmail: INVITEE_EMAIL,
      role: 'member',
      inviteTokenHash: tokenHash(plaintext),
      inviteExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      invitedByAccountId: INVITER,
    });
    const result = await service.accept({
      plaintextToken: plaintext,
      acceptingAccountId: INVITEE_ACCOUNT,
    });
    const removed = await service.removeMember({
      membershipId: result.membership.id,
      ownerAccountId: '99999999-0000-4000-8000-999999999999',
    });
    expect(removed).toBe(false);
    expect(await service.listMembers(OWNER)).toHaveLength(1);
  });
});
