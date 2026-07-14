// V-553.B-13 — unit tests for TeamMembersService (V-298b + V-298f).
//
// Surface under test:
//   - invite(): rejects bad email, normalises to lowercase, generates
//     token + sends email + records audit, idempotent overwrite
//   - accept(): unknown token / expired / email mismatch error paths,
//     happy path inserts membership + marks invite + invalidates
//     auth cache + audits
//   - listMembers / listPendingInvites: repo pass-through with expiry
//     filter on pending
//   - removeMember(): returns false on not-found, true on success +
//     invalidates auth cache + audits

import { describe, expect, it, vi } from 'vitest';
import {
  TeamMembersService,
  type TeamInviteRow,
  type TeamMemberRow,
  type TeamMembersRepo,
} from '../../src/services/team-members.js';
import { tokenHash } from '../../src/lib/auth-tokens.js';
import type { AccountAuditService } from '../../src/services/account-audit.js';
import type { AuthCache } from '../../src/services/auth-cache.js';
import type { EmailService } from '../../src/services/email.js';

interface CapturedInvite {
  to: string;
  acceptLink: string;
  expiresAt: Date;
  role: 'member' | 'admin';
}

function makeRepo(): {
  repo: TeamMembersRepo;
  state: {
    invites: TeamInviteRow[];
    members: TeamMemberRow[];
    emailByAccount: Map<string, string>;
  };
} {
  const state = {
    invites: [] as TeamInviteRow[],
    members: [] as TeamMemberRow[],
    emailByAccount: new Map<string, string>(),
  };
  let inviteCounter = 0;
  let memberCounter = 0;
  const repo: TeamMembersRepo = {
    upsertInvite: (input) => {
      const existing = state.invites.find(
        (i) =>
          i.ownerAccountId === input.ownerAccountId &&
          i.inviteeEmail === input.inviteeEmail &&
          i.acceptedAt === null,
      );
      if (existing) {
        existing.inviteTokenHash = input.inviteTokenHash;
        existing.inviteExpiresAt = input.inviteExpiresAt;
        existing.role = input.role;
        return Promise.resolve(existing);
      }
      inviteCounter += 1;
      const row: TeamInviteRow = {
        id: `inv_${inviteCounter.toString()}`,
        ownerAccountId: input.ownerAccountId,
        inviteeEmail: input.inviteeEmail,
        role: input.role,
        inviteTokenHash: input.inviteTokenHash,
        inviteExpiresAt: input.inviteExpiresAt,
        invitedByAccountId: input.invitedByAccountId,
        acceptedAt: null,
        createdAt: new Date(),
      };
      state.invites.push(row);
      return Promise.resolve(row);
    },
    findInviteByTokenHash: (hash) =>
      Promise.resolve(
        state.invites.find((i) => i.inviteTokenHash === hash && i.acceptedAt === null) ?? null,
      ),
    findAccountEmail: (accountId) => Promise.resolve(state.emailByAccount.get(accountId) ?? null),
    upsertMembership: (input) => {
      const existing = state.members.find(
        (m) =>
          m.ownerAccountId === input.ownerAccountId && m.memberAccountId === input.memberAccountId,
      );
      if (existing) return Promise.resolve(existing);
      memberCounter += 1;
      const row: TeamMemberRow = {
        id: `mem_${memberCounter.toString()}`,
        ownerAccountId: input.ownerAccountId,
        memberAccountId: input.memberAccountId,
        memberEmail: input.memberEmail,
        role: input.role,
        invitedAt: input.invitedAt,
        acceptedAt: input.acceptedAt,
        invitedByAccountId: input.invitedByAccountId,
        createdAt: new Date(),
      };
      state.members.push(row);
      return Promise.resolve(row);
    },
    acceptInviteAtomic: (input) => {
      // Exact-credential CAS mirror. Authority comes from the consumed invite.
      const inv = state.invites.find((i) => i.id === input.inviteId);
      if (!inv || inv.inviteTokenHash !== input.inviteTokenHash || inv.acceptedAt !== null) {
        return Promise.resolve(null);
      }
      inv.acceptedAt = input.acceptedAt;
      const existing = state.members.find(
        (m) =>
          m.ownerAccountId === inv.ownerAccountId && m.memberAccountId === input.memberAccountId,
      );
      if (existing) {
        existing.role = inv.role;
        existing.invitedAt = inv.createdAt;
        existing.invitedByAccountId = inv.invitedByAccountId;
        return Promise.resolve(existing);
      }
      memberCounter += 1;
      const row: TeamMemberRow = {
        id: `mem_${memberCounter.toString()}`,
        ownerAccountId: inv.ownerAccountId,
        memberAccountId: input.memberAccountId,
        memberEmail: input.memberEmail,
        role: inv.role,
        invitedAt: inv.createdAt,
        acceptedAt: input.acceptedAt,
        invitedByAccountId: inv.invitedByAccountId,
        createdAt: new Date(),
      };
      state.members.push(row);
      return Promise.resolve(row);
    },
    markInviteAccepted: (inviteId, at) => {
      const inv = state.invites.find((i) => i.id === inviteId);
      if (inv) inv.acceptedAt = at;
      return Promise.resolve();
    },
    listMembers: (ownerAccountId) =>
      Promise.resolve(state.members.filter((m) => m.ownerAccountId === ownerAccountId)),
    listPendingInvites: (ownerAccountId) =>
      Promise.resolve(
        state.invites.filter((i) => i.ownerAccountId === ownerAccountId && i.acceptedAt === null),
      ),
    removeMember: (membershipId, ownerAccountId) => {
      const idx = state.members.findIndex(
        (m) => m.id === membershipId && m.ownerAccountId === ownerAccountId,
      );
      if (idx < 0) return Promise.resolve(null);
      const removed = state.members[idx];
      state.members.splice(idx, 1);
      return Promise.resolve(removed?.memberAccountId ?? null);
    },
    removeMemberWithInvites: (membershipId, ownerAccountId) => {
      // TOCTOU-fix mirror — delete the membership + that member's invites in one
      // logical step (removeMember + deleteInvitesForEmail). Returns the removed
      // member's account id, or null when not found / wrong-owner.
      const idx = state.members.findIndex(
        (m) => m.id === membershipId && m.ownerAccountId === ownerAccountId,
      );
      if (idx < 0) return Promise.resolve(null);
      const removed = state.members[idx];
      state.members.splice(idx, 1);
      const memberAccountId = removed?.memberAccountId ?? null;
      if (memberAccountId === null) return Promise.resolve(null);
      const memberEmail = state.emailByAccount.get(memberAccountId);
      if (memberEmail) {
        const norm = memberEmail.trim().toLowerCase();
        state.invites = state.invites.filter(
          (i) => !(i.ownerAccountId === ownerAccountId && i.inviteeEmail === norm),
        );
      }
      return Promise.resolve(memberAccountId);
    },
    deleteInvitesForEmail: (ownerAccountId, email) => {
      const norm = email.trim().toLowerCase();
      state.invites = state.invites.filter(
        (i) => !(i.ownerAccountId === ownerAccountId && i.inviteeEmail === norm),
      );
      return Promise.resolve();
    },
  };
  return { repo, state };
}

function makeEmail(): { service: EmailService; captures: CapturedInvite[] } {
  const captures: CapturedInvite[] = [];
  const service = {
    sendTeamInvite: (args: CapturedInvite) => {
      captures.push(args);
      return Promise.resolve();
    },
  } as unknown as EmailService;
  return { service, captures };
}

function makeAudit(): { audit: AccountAuditService; calls: { action: string }[] } {
  const calls: { action: string }[] = [];
  const audit = {
    record: (args: { action: string }) => {
      calls.push(args);
      return Promise.resolve();
    },
  } as unknown as AccountAuditService;
  return { audit, calls };
}

function makeCache(): { cache: AuthCache; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(() => Promise.resolve());
  const cache = { invalidateAccount: spy } as unknown as AuthCache;
  return { cache, spy };
}

const CONFIG = { dashboardBaseUrl: 'https://app.driftstack.dev/' };

describe('V-553.B-13 TeamMembersService.invite', () => {
  it('rejects invalid email', async () => {
    const { repo, state } = makeRepo();
    const { service: email, captures } = makeEmail();
    const svc = new TeamMembersService(repo, email, CONFIG);
    await expect(
      svc.invite({
        ownerAccountId: 'acc_owner',
        invitedByAccountId: 'acc_owner',
        inviteeEmail: 'not-an-email',
      }),
    ).rejects.toThrow(/Invalid/);
    expect(state.invites).toHaveLength(0);
    expect(captures).toHaveLength(0);
  });

  it('lowercases + trims email, sends invite with dashboard URL', async () => {
    const { repo, state } = makeRepo();
    const { service: email, captures } = makeEmail();
    const svc = new TeamMembersService(repo, email, CONFIG);
    await svc.invite({
      ownerAccountId: 'acc_owner',
      invitedByAccountId: 'acc_owner',
      inviteeEmail: '  NEW@Example.COM ',
      role: 'admin',
    });
    expect(state.invites).toHaveLength(1);
    expect(state.invites[0]?.inviteeEmail).toBe('new@example.com');
    expect(state.invites[0]?.role).toBe('admin');
    expect(captures).toHaveLength(1);
    expect(captures[0]?.to).toBe('new@example.com');
    expect(captures[0]?.acceptLink).toMatch(
      /^https:\/\/app\.driftstack\.dev\/team\/accept\?token=/,
    );
    expect(captures[0]?.role).toBe('admin');
  });

  it('records an account-audit entry when configured', async () => {
    const { repo } = makeRepo();
    const { service: email } = makeEmail();
    const { audit, calls } = makeAudit();
    const svc = new TeamMembersService(repo, email, CONFIG, audit);
    await svc.invite({
      ownerAccountId: 'acc_owner',
      invitedByAccountId: 'acc_owner',
      inviteeEmail: 'new@e.test',
    });
    expect(calls.map((c) => c.action)).toEqual(['team.member_invited']);
  });

  it('re-inviting the same email replaces the existing invite token', async () => {
    const { repo, state } = makeRepo();
    const { service: email } = makeEmail();
    const svc = new TeamMembersService(repo, email, CONFIG);
    await svc.invite({
      ownerAccountId: 'acc_owner',
      invitedByAccountId: 'acc_owner',
      inviteeEmail: 'new@e.test',
    });
    const firstHash = state.invites[0]?.inviteTokenHash;
    await svc.invite({
      ownerAccountId: 'acc_owner',
      invitedByAccountId: 'acc_owner',
      inviteeEmail: 'new@e.test',
    });
    expect(state.invites).toHaveLength(1);
    expect(state.invites[0]?.inviteTokenHash).not.toBe(firstHash);
  });

  it('defaults role to "member" when not supplied', async () => {
    const { repo, state } = makeRepo();
    const { service: email } = makeEmail();
    const svc = new TeamMembersService(repo, email, CONFIG);
    await svc.invite({
      ownerAccountId: 'acc_owner',
      invitedByAccountId: 'acc_owner',
      inviteeEmail: 'new@e.test',
    });
    expect(state.invites[0]?.role).toBe('member');
  });
});

describe('V-553.B-13 TeamMembersService.accept — error paths', () => {
  it('throws NotFound on unknown token', async () => {
    const { repo } = makeRepo();
    const { service: email } = makeEmail();
    const svc = new TeamMembersService(repo, email, CONFIG);
    await expect(
      svc.accept({ plaintextToken: 'nope', acceptingAccountId: 'acc_b' }),
    ).rejects.toThrow(/not found/i);
  });

  it('rejects expired invites with BadRequest', async () => {
    const { repo, state } = makeRepo();
    const { service: email } = makeEmail();
    const expired: TeamInviteRow = {
      id: 'inv_1',
      ownerAccountId: 'acc_owner',
      inviteeEmail: 'b@e.test',
      role: 'member',
      inviteTokenHash: tokenHash('old-tok'),
      inviteExpiresAt: new Date('2026-04-01Z'),
      invitedByAccountId: 'acc_owner',
      acceptedAt: null,
      createdAt: new Date('2026-03-25Z'),
    };
    state.invites.push(expired);
    state.emailByAccount.set('acc_b', 'b@e.test');
    const svc = new TeamMembersService(repo, email, CONFIG);
    await expect(
      svc.accept({ plaintextToken: 'old-tok', acceptingAccountId: 'acc_b' }),
    ).rejects.toThrow(/expired/);
  });

  it('rejects email mismatch with ConflictError', async () => {
    const { repo, state } = makeRepo();
    const { service: email } = makeEmail();
    state.invites.push({
      id: 'inv_1',
      ownerAccountId: 'acc_owner',
      inviteeEmail: 'b@e.test',
      role: 'member',
      inviteTokenHash: tokenHash('plain-tok'),
      inviteExpiresAt: new Date(Date.now() + 1000 * 60 * 60),
      invitedByAccountId: 'acc_owner',
      acceptedAt: null,
      createdAt: new Date(),
    });
    state.emailByAccount.set('acc_imposter', 'imposter@e.test');
    const svc = new TeamMembersService(repo, email, CONFIG);
    await expect(
      svc.accept({ plaintextToken: 'plain-tok', acceptingAccountId: 'acc_imposter' }),
    ).rejects.toThrow(/does not match the invitee email/);
  });
});

describe('V-553.B-13 TeamMembersService.accept — happy path', () => {
  it('inserts membership, marks invite, invalidates cache, audits', async () => {
    const { repo, state } = makeRepo();
    const { service: email } = makeEmail();
    const { audit, calls } = makeAudit();
    const { cache, spy } = makeCache();
    state.invites.push({
      id: 'inv_1',
      ownerAccountId: 'acc_owner',
      inviteeEmail: 'b@e.test',
      role: 'admin',
      inviteTokenHash: tokenHash('plain-tok'),
      inviteExpiresAt: new Date(Date.now() + 1000 * 60 * 60),
      invitedByAccountId: 'acc_owner',
      acceptedAt: null,
      createdAt: new Date(),
    });
    state.emailByAccount.set('acc_b', 'b@e.test');
    const svc = new TeamMembersService(repo, email, CONFIG, audit, cache);
    const result = await svc.accept({
      plaintextToken: 'plain-tok',
      acceptingAccountId: 'acc_b',
    });
    expect(result.membership.role).toBe('admin');
    expect(state.members).toHaveLength(1);
    expect(state.invites[0]?.acceptedAt).not.toBeNull();
    expect(spy).toHaveBeenCalledWith('acc_b');
    expect(calls.map((c) => c.action)).toEqual(['team.invite_accepted']);
  });

  it('a used invite token is SINGLE-USE: replaying it after acceptance is rejected (Fable auth re-audit 2026-07-02)', async () => {
    const { repo, state } = makeRepo();
    const { service: email } = makeEmail();
    state.invites.push({
      id: 'inv_1',
      ownerAccountId: 'acc_owner',
      inviteeEmail: 'b@e.test',
      role: 'admin',
      inviteTokenHash: tokenHash('plain-tok'),
      inviteExpiresAt: new Date(Date.now() + 1000 * 60 * 60),
      invitedByAccountId: 'acc_owner',
      acceptedAt: null,
      createdAt: new Date(),
    });
    state.emailByAccount.set('acc_b', 'b@e.test');
    const svc = new TeamMembersService(repo, email, CONFIG);
    // First accept succeeds.
    await svc.accept({ plaintextToken: 'plain-tok', acceptingAccountId: 'acc_b' });
    // A REPLAY of the same (now-accepted) token must be rejected — otherwise a
    // removed member could re-join, or a demoted member re-escalate, by replaying
    // their original accept link within the 7-day window.
    await expect(
      svc.accept({ plaintextToken: 'plain-tok', acceptingAccountId: 'acc_b' }),
    ).rejects.toThrow(/not found or already used/i);
  });

  it('rejects a token replaced after lookup instead of accepting its stale role', async () => {
    const { repo, state } = makeRepo();
    const { service: email } = makeEmail();
    state.invites.push({
      id: 'inv_1',
      ownerAccountId: 'acc_owner',
      inviteeEmail: 'b@e.test',
      role: 'admin',
      inviteTokenHash: tokenHash('old-tok'),
      inviteExpiresAt: new Date(Date.now() + 1000 * 60 * 60),
      invitedByAccountId: 'acc_owner',
      acceptedAt: null,
      createdAt: new Date(),
    });
    state.emailByAccount.set('acc_b', 'b@e.test');
    const findAccountEmail = repo.findAccountEmail.bind(repo);
    repo.findAccountEmail = async (accountId) => {
      const emailAddress = await findAccountEmail(accountId);
      const invite = state.invites[0];
      if (invite) {
        invite.inviteTokenHash = tokenHash('replacement-tok');
        invite.role = 'member';
      }
      return emailAddress;
    };

    const svc = new TeamMembersService(repo, email, CONFIG);
    await expect(
      svc.accept({ plaintextToken: 'old-tok', acceptingAccountId: 'acc_b' }),
    ).rejects.toThrow(/not found or already used/i);
    expect(state.members).toHaveLength(0);
    expect(state.invites[0]?.acceptedAt).toBeNull();
    expect(state.invites[0]?.role).toBe('member');
  });
});

describe('V-553.B-13 TeamMembersService — list operations', () => {
  it('listMembers returns only the owner-scoped members', async () => {
    const { repo, state } = makeRepo();
    const { service: email } = makeEmail();
    state.members.push(
      {
        id: 'mem_1',
        ownerAccountId: 'acc_owner_a',
        memberAccountId: 'acc_b',
        memberEmail: 'b@e.test',
        role: 'member',
        invitedAt: new Date(),
        acceptedAt: new Date(),
        invitedByAccountId: 'acc_owner_a',
        createdAt: new Date(),
      },
      {
        id: 'mem_2',
        ownerAccountId: 'acc_owner_b',
        memberAccountId: 'acc_c',
        memberEmail: 'c@e.test',
        role: 'member',
        invitedAt: new Date(),
        acceptedAt: new Date(),
        invitedByAccountId: 'acc_owner_b',
        createdAt: new Date(),
      },
    );
    const svc = new TeamMembersService(repo, email, CONFIG);
    const result = await svc.listMembers('acc_owner_a');
    expect(result.map((m) => m.id)).toEqual(['mem_1']);
  });

  it('listPendingInvites filters out expired + accepted entries', async () => {
    const { repo, state } = makeRepo();
    const { service: email } = makeEmail();
    const future = new Date(Date.now() + 1000 * 60 * 60);
    const past = new Date(Date.now() - 1000 * 60 * 60);
    state.invites.push(
      {
        id: 'inv_1',
        ownerAccountId: 'acc_owner',
        inviteeEmail: 'pending@e.test',
        role: 'member',
        inviteTokenHash: 'h1',
        inviteExpiresAt: future,
        invitedByAccountId: 'acc_owner',
        acceptedAt: null,
        createdAt: new Date(),
      },
      {
        id: 'inv_2',
        ownerAccountId: 'acc_owner',
        inviteeEmail: 'expired@e.test',
        role: 'member',
        inviteTokenHash: 'h2',
        inviteExpiresAt: past,
        invitedByAccountId: 'acc_owner',
        acceptedAt: null,
        createdAt: new Date(),
      },
      {
        id: 'inv_3',
        ownerAccountId: 'acc_owner',
        inviteeEmail: 'accepted@e.test',
        role: 'member',
        inviteTokenHash: 'h3',
        inviteExpiresAt: future,
        invitedByAccountId: 'acc_owner',
        acceptedAt: new Date(),
        createdAt: new Date(),
      },
    );
    const svc = new TeamMembersService(repo, email, CONFIG);
    const result = await svc.listPendingInvites('acc_owner');
    expect(result.map((i) => i.inviteeEmail)).toEqual(['pending@e.test']);
  });
});

describe('V-553.B-13 TeamMembersService.removeMember', () => {
  it('returns false when membership is not found', async () => {
    const { repo } = makeRepo();
    const { service: email } = makeEmail();
    const svc = new TeamMembersService(repo, email, CONFIG);
    const result = await svc.removeMember({
      membershipId: 'mem_missing',
      ownerAccountId: 'acc_owner',
    });
    expect(result).toBe(false);
  });

  it('returns false when owner does not match (cross-account guard)', async () => {
    const { repo, state } = makeRepo();
    const { service: email } = makeEmail();
    state.members.push({
      id: 'mem_1',
      ownerAccountId: 'acc_owner_a',
      memberAccountId: 'acc_b',
      memberEmail: 'b@e.test',
      role: 'member',
      invitedAt: new Date(),
      acceptedAt: new Date(),
      invitedByAccountId: 'acc_owner_a',
      createdAt: new Date(),
    });
    const svc = new TeamMembersService(repo, email, CONFIG);
    const result = await svc.removeMember({
      membershipId: 'mem_1',
      ownerAccountId: 'acc_owner_b',
    });
    expect(result).toBe(false);
    expect(state.members).toHaveLength(1);
  });

  it('returns true + invalidates cache + audits on success', async () => {
    const { repo, state } = makeRepo();
    const { service: email } = makeEmail();
    const { audit, calls } = makeAudit();
    const { cache, spy } = makeCache();
    state.members.push({
      id: 'mem_1',
      ownerAccountId: 'acc_owner',
      memberAccountId: 'acc_b',
      memberEmail: 'b@e.test',
      role: 'member',
      invitedAt: new Date(),
      acceptedAt: new Date(),
      invitedByAccountId: 'acc_owner',
      createdAt: new Date(),
    });
    const svc = new TeamMembersService(repo, email, CONFIG, audit, cache);
    const result = await svc.removeMember({
      membershipId: 'mem_1',
      ownerAccountId: 'acc_owner',
    });
    expect(result).toBe(true);
    expect(spy).toHaveBeenCalledWith('acc_b');
    expect(calls.map((c) => c.action)).toEqual(['team.member_removed']);
  });

  it('cancels the removed member OUTSTANDING invites so they cannot re-join via a pending invite (Fable auth re-audit 2026-07-02)', async () => {
    const { repo, state } = makeRepo();
    const { service: email } = makeEmail();
    state.emailByAccount.set('acc_b', 'b@e.test');
    state.members.push({
      id: 'mem_1',
      ownerAccountId: 'acc_owner',
      memberAccountId: 'acc_b',
      memberEmail: 'b@e.test',
      role: 'admin',
      invitedAt: new Date(),
      acceptedAt: new Date(),
      invitedByAccountId: 'acc_owner',
      createdAt: new Date(),
    });
    // A still-pending re-invite (e.g. from a role change) for the same member.
    state.invites.push({
      id: 'inv_pending',
      ownerAccountId: 'acc_owner',
      inviteeEmail: 'b@e.test',
      role: 'member',
      inviteTokenHash: tokenHash('pending-tok'),
      inviteExpiresAt: new Date(Date.now() + 1000 * 60 * 60),
      invitedByAccountId: 'acc_owner',
      acceptedAt: null,
      createdAt: new Date(),
    });
    const svc = new TeamMembersService(repo, email, CONFIG);
    await svc.removeMember({ membershipId: 'mem_1', ownerAccountId: 'acc_owner' });
    // The outstanding invite is gone → the removed member can't accept it to re-join.
    expect(state.invites).toHaveLength(0);
    await expect(
      svc.accept({ plaintextToken: 'pending-tok', acceptingAccountId: 'acc_b' }),
    ).rejects.toThrow(/not found or already used/i);
  });
});
